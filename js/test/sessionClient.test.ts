// Unit tests for SessionClient. `fetch` is stubbed throughout, so these need
// neither a running identity service nor network access.
//
// The three-outcome behaviour has its own describe block at the bottom, and it
// is the part worth reading: SUCCESS, REFUSAL and UNAVAILABLE must never be
// collapsed into each other.

import {describe, expect, it} from 'vitest';

import {ServiceUnavailableError, SessionClient} from '../src/index';

const BASE_URL = 'https://accounts.example.test';

interface StubbedCall {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: unknown;
}

type StubReply = {status: number; body?: unknown; text?: string} | Error;

/**
 * A fetch stub that answers each call from `replies` in order, repeating the
 * last one once they run out. An `Error` reply is thrown, standing in for a
 * refused connection.
 */
const stubFetch = (replies: StubReply[]) => {
    const calls: StubbedCall[] = [];
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
        const headers = (init.headers ?? {}) as Record<string, string>;
        calls.push({
            url,
            method: init.method ?? 'GET',
            headers,
            body: typeof init.body === 'string' ? JSON.parse(init.body) : null
        });
        const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
        if (reply === undefined || reply instanceof Error) {
            throw reply ?? new Error('fetch failed');
        }
        const text = reply.text ?? (reply.body === undefined ? '' : JSON.stringify(reply.body));
        return {status: reply.status, text: async () => text};
    }) as unknown as typeof globalThis.fetch;
    return {fetchImpl, calls};
};

const clientWith = (replies: StubReply[], options: Record<string, unknown> = {}) => {
    const {fetchImpl, calls} = stubFetch(replies);
    return {
        client: new SessionClient({baseUrl: BASE_URL, fetch: fetchImpl, ...options}),
        calls
    };
};

const TOKENS = {
    token: 'header.payload.signature',
    tokenType: 'Bearer',
    expiresAt: '2099-01-01T00:00:00Z',
    refreshToken: 'the-refresh-token'
};

// ---------------------------------------------------------------------------

describe('construction', () => {
    it('requires a base URL rather than guessing one', () => {
        expect(() => new SessionClient({baseUrl: ''})).toThrow(/baseUrl/);
    });

    it('trims a trailing slash off the base URL', async () => {
        const {fetchImpl, calls} = stubFetch([{status: 200, body: TOKENS}]);
        const client = new SessionClient({baseUrl: `${BASE_URL}/`, fetch: fetchImpl});
        await client.login('alice', 'correct-horse');
        expect(calls[0]!.url).toBe(`${BASE_URL}/login`);
    });

    it('uses the documented default routes', async () => {
        const {client, calls} = clientWith([{status: 200, body: TOKENS}, {status: 200, body: TOKENS}]);
        await client.login('alice', 'correct-horse');
        await client.refreshSession('r1');
        expect(calls.map((call) => call.url)).toEqual([
            `${BASE_URL}/login`,
            `${BASE_URL}/token/refresh`
        ]);
    });

    it('takes a route map, because endpoint paths are configuration', async () => {
        const {client, calls} = clientWith([{status: 200, body: TOKENS}], {
            routes: {login: '/api/v2/sessions'}
        });
        await client.login('alice', 'correct-horse');
        expect(calls[0]!.url).toBe(`${BASE_URL}/api/v2/sessions`);
    });

    it('takes a field map, for a service that names its fields differently', async () => {
        const {client} = clientWith(
            [{status: 200, body: {access_token: 'abc', expires_at: 'later', refresh_token: 'r2'}}],
            {fields: {token: 'access_token', expiresAt: 'expires_at', refreshToken: 'refresh_token'}}
        );
        const result = await client.login('alice', 'correct-horse');
        expect(result).toMatchObject({ok: true, token: 'abc', expiresAt: 'later', refreshToken: 'r2'});
    });

    it('sends any configured extra headers', async () => {
        const {client, calls} = clientWith([{status: 200, body: TOKENS}], {
            headers: {'X-Api-Key': 'k'}
        });
        await client.login('alice', 'correct-horse');
        expect(calls[0]!.headers['X-Api-Key']).toBe('k');
    });
});

describe('login', () => {
    it('returns the issued tokens on success', async () => {
        const {client, calls} = clientWith([{status: 200, body: TOKENS}]);
        const result = await client.login('alice', 'correct-horse');
        expect(result).toMatchObject({
            ok: true,
            token: TOKENS.token,
            expiresAt: TOKENS.expiresAt,
            refreshToken: TOKENS.refreshToken
        });
        expect(calls[0]!.body).toEqual({username: 'alice', password: 'correct-horse'});
    });

    it('reports bad credentials as a refusal carrying the service message', async () => {
        const {client} = clientWith([{status: 401, body: {message: 'bad creds'}}]);
        const result = await client.login('alice', 'wrong');
        expect(result).toEqual({
            ok: false,
            status: 401,
            message: 'bad creds',
            raw: {message: 'bad creds'}
        });
    });

    it('falls back to its own wording when the service supplies none', async () => {
        const {client} = clientWith([{status: 401, body: {}}]);
        const result = await client.login('alice', 'wrong');
        expect(result).toMatchObject({ok: false, message: 'Those credentials were not accepted.'});
    });

    it('reads a message out of an `error` key too', async () => {
        const {client} = clientWith([{status: 400, body: {error: 'username is required'}}]);
        const result = await client.login('', 'wrong');
        expect(result).toMatchObject({ok: false, message: 'username is required'});
    });

    it('never puts the password in the result', async () => {
        const {client} = clientWith([{status: 401, body: {message: 'bad creds'}}]);
        const result = await client.login('alice', 'hunter2');
        expect(JSON.stringify(result)).not.toContain('hunter2');
    });
});

describe('register', () => {
    it('returns the created account name on 201', async () => {
        const {client, calls} = clientWith([{status: 201, body: {id: 7, username: 'alice'}}]);
        const result = await client.register('alice', 'Str0ng-Pass!');
        expect(result).toMatchObject({ok: true, username: 'alice'});
        expect(calls[0]!.body).toEqual({username: 'alice', password: 'Str0ng-Pass!'});
    });

    it('accepts a 200 as well, since services differ on which they use', async () => {
        const {client} = clientWith([{status: 200, body: {}}]);
        await expect(client.register('alice', 'Str0ng-Pass!')).resolves.toMatchObject({ok: true});
    });

    it('prefers the name the service echoes back, which may be canonicalised', async () => {
        const {client} = clientWith([{status: 201, body: {username: 'alice'}}]);
        const result = await client.register('  Alice  ', 'Str0ng-Pass!');
        expect(result).toMatchObject({ok: true, username: 'alice'});
    });

    it('sends an email only when one was given', async () => {
        const {client, calls} = clientWith([{status: 201, body: {}}, {status: 201, body: {}}]);
        await client.register('alice', 'Str0ng-Pass!');
        await client.register('bob', 'Str0ng-Pass!', 'b@example.test');
        expect(calls[0]!.body).toEqual({username: 'alice', password: 'Str0ng-Pass!'});
        expect(calls[1]!.body).toEqual({
            username: 'bob',
            password: 'Str0ng-Pass!',
            email: 'b@example.test'
        });
    });

    it('reports a taken username as a refusal', async () => {
        const {client} = clientWith([{status: 409, body: {message: 'username already in use'}}]);
        const result = await client.register('alice', 'Str0ng-Pass!');
        expect(result).toMatchObject({ok: false, status: 409, message: 'username already in use'});
    });

    it('passes the service password policy through rather than restating it', async () => {
        const {client} = clientWith([{status: 400, body: {message: 'password must contain a digit'}}]);
        // A weak password is sent, not rejected locally: the service owns the
        // policy, and there is exactly one place it is described.
        const result = await client.register('alice', 'weak');
        expect(result).toMatchObject({ok: false, status: 400});
        expect((result as {message: string}).message).toContain('digit');
    });

    it('reports rate limiting as a refusal, not an outage', async () => {
        const {client} = clientWith([{status: 429, body: {message: 'slow down'}}]);
        await expect(client.register('alice', 'Str0ng-Pass!')).resolves.toMatchObject({
            ok: false,
            status: 429
        });
    });
});

describe('validateSession', () => {
    it('returns the account on a valid session', async () => {
        const {client, calls} = clientWith([
            {status: 200, body: {valid: true, username: 'alice', roles: ['ROLE_USER']}}
        ]);
        const result = await client.validateSession('sometoken');
        expect(result).toMatchObject({ok: true, username: 'alice', roles: ['ROLE_USER']});
        expect(calls[0]!.headers['Authorization']).toBe('Bearer sometoken');
        expect(calls[0]!.url).toBe(`${BASE_URL}/session/validate`);
    });

    it('accepts a body that names the account without a `valid` flag', async () => {
        const {client} = clientWith([{status: 200, body: {username: 'alice'}}]);
        await expect(client.validateSession('t')).resolves.toMatchObject({ok: true, username: 'alice'});
    });

    it('treats an explicit `valid: false` as a refusal', async () => {
        const {client} = clientWith([{status: 200, body: {valid: false}}]);
        const result = await client.validateSession('expiredtoken');
        expect(result.ok).toBe(false);
    });

    it('refuses a missing token without making a network call', async () => {
        const {client, calls} = clientWith([{status: 200, body: {valid: true}}]);
        const result = await client.validateSession('');
        expect(result).toMatchObject({ok: false, status: 401});
        expect(calls).toHaveLength(0);
    });

    it('treats a 401 as a refusal', async () => {
        const {client} = clientWith([{status: 401, body: {message: 'token expired'}}]);
        await expect(client.validateSession('t')).resolves.toMatchObject({ok: false, status: 401});
    });

    it('drops non-string entries out of roles rather than handing back junk', async () => {
        const {client} = clientWith([
            {status: 200, body: {valid: true, username: 'alice', roles: ['ROLE_USER', 3, null]}}
        ]);
        await expect(client.validateSession('t')).resolves.toMatchObject({roles: ['ROLE_USER']});
    });
});

describe('refreshSession', () => {
    it('returns the rotated pair', async () => {
        const {client, calls} = clientWith([
            {status: 200, body: {token: 'new-access', expiresAt: 'later', refreshToken: 'new-refresh'}}
        ]);
        const result = await client.refreshSession('old-refresh');
        expect(result).toMatchObject({ok: true, token: 'new-access', refreshToken: 'new-refresh'});
        expect(calls[0]!.body).toEqual({refreshToken: 'old-refresh'});
    });

    it('reports a spent or unknown refresh token as a refusal', async () => {
        const {client} = clientWith([{status: 401, body: {message: 'refresh token not recognised'}}]);
        await expect(client.refreshSession('spent')).resolves.toMatchObject({ok: false, status: 401});
    });
});

describe('logout', () => {
    it('reports the token as revoked on success', async () => {
        const {client, calls} = clientWith([{status: 204}]);
        await expect(client.logout('sometoken')).resolves.toEqual({
            revoked: true,
            unavailable: false,
            status: 204,
            message: null
        });
        expect(calls[0]!.headers['Authorization']).toBe('Bearer sometoken');
    });

    it('reports a refusal without throwing', async () => {
        const {client} = clientWith([{status: 401, body: {message: 'token already expired'}}]);
        await expect(client.logout('stale')).resolves.toMatchObject({
            revoked: false,
            unavailable: false,
            status: 401
        });
    });
});

describe('isReachable', () => {
    it('is true when the service answers at all, including with a 401', async () => {
        const {client} = clientWith([{status: 401, body: {message: 'no token'}}]);
        await expect(client.isReachable()).resolves.toBe(true);
    });

    it('is false when the connection fails', async () => {
        const {client} = clientWith([new Error('ECONNREFUSED')]);
        await expect(client.isReachable()).resolves.toBe(false);
    });

    it('uses the shorter probe timeout', async () => {
        const hang = (async (_url: string, init: RequestInit = {}) =>
            new Promise((_resolve, reject) => {
                init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
            })) as unknown as typeof globalThis.fetch;
        const client = new SessionClient({baseUrl: BASE_URL, fetch: hang, probeTimeoutMs: 5});
        await expect(client.isReachable()).resolves.toBe(false);
    });
});

// ---------------------------------------------------------------------------
// The reason this library exists.

describe('the three outcomes are kept apart', () => {
    it('SUCCESS: a 200 with a token is a login', async () => {
        const {client} = clientWith([{status: 200, body: TOKENS}]);
        await expect(client.login('alice', 'correct-horse')).resolves.toMatchObject({ok: true});
    });

    it('REFUSAL: a 401 is an answer, and the answer is no', async () => {
        const {client} = clientWith([{status: 401, body: {message: 'bad creds'}}]);
        const result = await client.login('alice', 'wrong');
        expect(result.ok).toBe(false);
        expect((result as {status: number}).status).toBe(401);
    });

    it('UNAVAILABLE: a connection failure is not a wrong password', async () => {
        const {client} = clientWith([new Error('ECONNREFUSED')]);
        await expect(client.login('alice', 'correct-horse')).rejects.toBeInstanceOf(
            ServiceUnavailableError
        );
    });

    it('UNAVAILABLE: a timeout is not a wrong password', async () => {
        const hang = (async (_url: string, init: RequestInit = {}) =>
            new Promise((_resolve, reject) => {
                init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
            })) as unknown as typeof globalThis.fetch;
        const client = new SessionClient({baseUrl: BASE_URL, fetch: hang, timeoutMs: 5});
        await expect(client.login('alice', 'correct-horse')).rejects.toBeInstanceOf(
            ServiceUnavailableError
        );
    });

    it('UNAVAILABLE: a 200 with a garbage body is not a success', async () => {
        const {client} = clientWith([{status: 200, text: '<html>502 Bad Gateway</html>'}]);
        await expect(client.login('alice', 'correct-horse')).rejects.toBeInstanceOf(
            ServiceUnavailableError
        );
    });

    it('UNAVAILABLE: a 200 with no token is not a login', async () => {
        const {client} = clientWith([{status: 200, body: {tokenType: 'Bearer'}}]);
        await expect(client.login('alice', 'correct-horse')).rejects.toBeInstanceOf(
            ServiceUnavailableError
        );
    });

    it('UNAVAILABLE: a 200 with a garbage body is not a valid session either', async () => {
        const {client} = clientWith([{status: 200, text: 'not json'}]);
        await expect(client.validateSession('t')).rejects.toBeInstanceOf(ServiceUnavailableError);
    });

    it('UNAVAILABLE: a 5xx is "we do not know", not "no"', async () => {
        for (const status of [500, 502, 503]) {
            const {client} = clientWith([{status, body: {message: 'upstream exploded'}}]);
            await expect(client.login('alice', 'correct-horse')).rejects.toBeInstanceOf(
                ServiceUnavailableError
            );
        }
    });

    it('UNAVAILABLE: a 5xx on register does not become "that name is taken"', async () => {
        const {client} = clientWith([{status: 503, body: {}}]);
        await expect(client.register('alice', 'Str0ng-Pass!')).rejects.toBeInstanceOf(
            ServiceUnavailableError
        );
    });

    it('UNAVAILABLE: a 5xx on validate does not sign anybody out', async () => {
        const {client} = clientWith([{status: 503, body: {}}]);
        await expect(client.validateSession('t')).rejects.toBeInstanceOf(ServiceUnavailableError);
    });

    it('logout still lets the caller clear local state when the service is down', async () => {
        const {client} = clientWith([new Error('ECONNREFUSED')]);
        // Note what this does NOT do: throw. A caller must be able to sign
        // somebody out of their own browser during an outage without wrapping
        // the call in a try block it might forget.
        await expect(client.logout('sometoken')).resolves.toMatchObject({
            revoked: false,
            unavailable: true
        });
    });

    it('the unavailable error leaks neither the credential nor the hostname', async () => {
        const {client} = clientWith([new Error(`connect ECONNREFUSED ${BASE_URL} while sending hunter2`)]);
        const error = await client.login('alice', 'hunter2').catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(ServiceUnavailableError);
        const rendered = `${(error as Error).name}: ${(error as Error).message}`;
        expect(rendered).not.toContain('hunter2');
        expect(rendered).not.toContain('example.test');
    });
});
