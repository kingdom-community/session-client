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
        const {client, calls} = clientWith([{status: 200, body: {...TOKENS, valid: true, username: 'alice'}}]);
        await client.register('alice', 'correct-horse');
        await client.login('alice', 'correct-horse');
        await client.validateSession('t');
        await client.logout('t');
        await client.refreshSession('r1');
        expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
            `POST ${BASE_URL}/register`,
            `POST ${BASE_URL}/login`,
            `GET ${BASE_URL}/session/validate`,
            `POST ${BASE_URL}/logout`,
            `POST ${BASE_URL}/token/refresh`
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

    it('lets no differently-cased extra header combine with the bearer token', async () => {
        const {client, calls} = clientWith(
            [{status: 200, body: {valid: true, username: 'alice'}}, {status: 200, body: TOKENS}],
            {headers: {authorization: 'Basic abc', 'content-type': 'text/plain'}}
        );
        await client.validateSession('sometoken');
        await client.login('alice', 'correct-horse');
        const named = (headers: Record<string, string>, name: string) =>
            Object.entries(headers)
                .filter(([key]) => key.toLowerCase() === name)
                .map(([, value]) => value);
        expect(named(calls[0]!.headers, 'authorization')).toEqual(['Bearer sometoken']);
        expect(named(calls[1]!.headers, 'content-type')).toEqual(['application/json']);
    });

    it('asks for JSON every time, and labels only a request with a body as JSON', async () => {
        const {client, calls} = clientWith([{status: 200, body: {...TOKENS, valid: true, username: 'alice'}}]);
        await client.login('alice', 'correct-horse');
        await client.validateSession('t');
        await client.logout('t');
        expect(calls.map((call) => call.headers['Accept'])).toEqual([
            'application/json',
            'application/json',
            'application/json'
        ]);
        expect(calls.map((call) => call.headers['Content-Type'])).toEqual(['application/json', undefined, undefined]);
        expect(calls.map((call) => call.body)).toEqual([{username: 'alice', password: 'correct-horse'}, null, null]);
    });

    it('copies the headers and message fields it is given', async () => {
        const headers: Record<string, string> = {'X-Api-Key': 'k'};
        const messageFields = ['detail'];
        const {client, calls} = clientWith(
            [{status: 401, body: {detail: 'first', title: 'second'}}],
            {headers, messageFields}
        );
        headers['X-Api-Key'] = 'changed';
        headers['X-Added'] = 'added';
        messageFields[0] = 'title';
        const result = await client.login('alice', 'wrong');
        expect(calls[0]!.headers['X-Api-Key']).toBe('k');
        expect(calls[0]!.headers['X-Added']).toBeUndefined();
        expect(result).toMatchObject({ok: false, message: 'first'});
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

    it('accepts a 201 as well, since services differ on which they use', async () => {
        const {client} = clientWith([{status: 201, body: TOKENS}]);
        await expect(client.login('alice', 'correct-horse')).resolves.toMatchObject({ok: true, token: TOKENS.token});
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

    it('skips a blank message and trims the one it uses', async () => {
        const {client} = clientWith([{status: 400, body: {message: '   ', error: '  username is required  '}}]);
        const result = await client.login('', 'wrong');
        expect(result).toMatchObject({ok: false, message: 'username is required'});
    });

    it('skips a message field that is not a string', async () => {
        const {client} = clientWith([{status: 400, body: {message: {code: 7}, error: 'username is required'}}]);
        const result = await client.login('', 'wrong');
        expect(result).toMatchObject({ok: false, message: 'username is required'});
    });

    it('searches configured message fields in the order given', async () => {
        const {client} = clientWith([{status: 401, body: {title: 'second', detail: 'first'}}], {
            messageFields: ['detail', 'title']
        });
        const result = await client.login('alice', 'wrong');
        expect(result).toMatchObject({ok: false, message: 'first'});
    });

    it('reads no default key once message fields are configured', async () => {
        const {client} = clientWith([{status: 401, body: {message: 'not read'}}], {messageFields: ['detail']});
        const result = await client.login('alice', 'wrong');
        expect(result).toMatchObject({ok: false, message: 'Those credentials were not accepted.'});
    });

    it('never puts the password in the result', async () => {
        const {client} = clientWith([{status: 401, body: {message: 'bad creds'}}]);
        const result = await client.login('alice', 'hunter2');
        expect(JSON.stringify(result)).not.toContain('hunter2');
    });

    it('reads a token issued alone as one with no expiry and no refresh token', async () => {
        const {client} = clientWith([{status: 200, body: {token: 'abc'}}]);
        await expect(client.login('alice', 'correct-horse')).resolves.toMatchObject({
            ok: true,
            token: 'abc',
            expiresAt: null,
            refreshToken: null
        });
    });

    it('reads a non-string expiry and a blank refresh token as absent', async () => {
        const {client} = clientWith([
            {status: 200, body: {token: 'abc', expiresAt: 1700000000, refreshToken: ''}}
        ]);
        await expect(client.login('alice', 'correct-horse')).resolves.toMatchObject({
            ok: true,
            expiresAt: null,
            refreshToken: null
        });
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

    it('accepts an explicit `valid: true` that names no account and lists no roles', async () => {
        const {client} = clientWith([{status: 200, body: {valid: true, roles: 'ROLE_USER'}}]);
        await expect(client.validateSession('t')).resolves.toMatchObject({ok: true, username: null, roles: []});
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

    it('accepts a 201 as well, since services differ on which they use', async () => {
        const {client} = clientWith([{status: 201, body: {token: 'new-access'}}]);
        await expect(client.refreshSession('old-refresh')).resolves.toMatchObject({ok: true, token: 'new-access'});
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
        await expect(client.logout('stale')).resolves.toEqual({
            revoked: false,
            unavailable: false,
            status: 401,
            message: 'token already expired'
        });
    });

    it('falls back to its own wording when a refusal supplies no message', async () => {
        const {client} = clientWith([{status: 403, text: '<html>Forbidden</html>'}]);
        await expect(client.logout('stale')).resolves.toMatchObject({
            status: 403,
            message: 'That token could not be revoked.'
        });
    });
});

describe('isReachable', () => {
    it('is true when the service answers at all, including with a 401', async () => {
        const {client} = clientWith([{status: 401, body: {message: 'no token'}}]);
        await expect(client.isReachable()).resolves.toBe(true);
    });

    it('asks the configured validate route, carrying no credential', async () => {
        const {client, calls} = clientWith([{status: 401, body: {message: 'no token'}}], {
            routes: {validate: '/api/v2/whoami'}
        });
        await client.isReachable();
        expect(calls).toHaveLength(1);
        expect(calls[0]!.method).toBe('GET');
        expect(calls[0]!.url).toBe(`${BASE_URL}/api/v2/whoami`);
        expect(calls[0]!.headers['Authorization']).toBeUndefined();
        expect(calls[0]!.body).toBeNull();
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
        const error = await client.login('alice', 'correct-horse').catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(ServiceUnavailableError);
        expect((error as ServiceUnavailableError).status).toBeNull();
        expect((error as Error).message).toBe('the identity service is unreachable');
    });

    // A timeout is told apart from a bare transport failure in the message,
    // and in nothing else: still UNAVAILABLE, still no status. The wording is
    // asserted, not merely the type, because it must match the Python
    // package's exactly.
    it('UNAVAILABLE: a timeout is not a wrong password', async () => {
        const hang = (async (_url: string, init: RequestInit = {}) =>
            new Promise((_resolve, reject) => {
                init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
            })) as unknown as typeof globalThis.fetch;
        const client = new SessionClient({baseUrl: BASE_URL, fetch: hang, timeoutMs: 5});
        const error = await client.login('alice', 'correct-horse').catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(ServiceUnavailableError);
        expect((error as ServiceUnavailableError).status).toBeNull();
        expect((error as Error).message).toBe('the identity service did not answer in time');
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

    // Only 200 and 201 are read as success. Any other 2xx is not a refusal
    // either — the service did not say no — so nothing is known.
    it('UNAVAILABLE: another 2xx on login is not "those credentials were not accepted"', async () => {
        for (const status of [202, 204]) {
            const {client} = clientWith([{status, text: ''}]);
            const error = await client.login('alice', 'correct-horse').catch((caught: unknown) => caught);
            expect(error).toBeInstanceOf(ServiceUnavailableError);
            expect((error as ServiceUnavailableError).status).toBe(status);
            expect((error as Error).message).toBe(`the identity service answered HTTP ${status}`);
        }
    });

    it('UNAVAILABLE: another 2xx on register does not become "that name is taken"', async () => {
        const {client} = clientWith([{status: 204, text: ''}]);
        const error = await client.register('alice', 'Str0ng-Pass!').catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(ServiceUnavailableError);
        expect((error as ServiceUnavailableError).status).toBe(204);
    });

    it('UNAVAILABLE: another 2xx on refresh does not become "that session could not be renewed"', async () => {
        const {client} = clientWith([{status: 202, body: {message: 'queued'}}]);
        const error = await client.refreshSession('the-refresh-token').catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(ServiceUnavailableError);
        expect((error as ServiceUnavailableError).status).toBe(202);
    });

    // A redirect the transport did not follow — `fetch` leaves a 300 or a
    // Location-less 3xx alone, and urllib will not re-send a POST for a 307 —
    // is not "no" either. The service said nothing about the credentials.
    it('UNAVAILABLE: a 3xx on login is not "those credentials were not accepted"', async () => {
        for (const status of [300, 307, 308]) {
            const {client} = clientWith([{status, body: {message: 'moved'}}]);
            const error = await client.login('alice', 'correct-horse').catch((caught: unknown) => caught);
            expect(error).toBeInstanceOf(ServiceUnavailableError);
            expect((error as ServiceUnavailableError).status).toBe(status);
            expect((error as Error).message).toBe(`the identity service answered HTTP ${status}`);
        }
    });

    it('UNAVAILABLE: a 3xx on register does not become "that name is taken"', async () => {
        const {client} = clientWith([{status: 307, text: ''}]);
        const error = await client.register('alice', 'Str0ng-Pass!').catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(ServiceUnavailableError);
        expect((error as ServiceUnavailableError).status).toBe(307);
    });

    it('UNAVAILABLE: a 3xx on refresh does not become "that session could not be renewed"', async () => {
        const {client} = clientWith([{status: 308, text: ''}]);
        const error = await client.refreshSession('the-refresh-token').catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(ServiceUnavailableError);
        expect((error as ServiceUnavailableError).status).toBe(308);
    });

    it('UNAVAILABLE: a 3xx on validate does not sign anybody out', async () => {
        const {client} = clientWith([{status: 302, text: ''}]);
        const error = await client.validateSession('t').catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(ServiceUnavailableError);
        expect((error as ServiceUnavailableError).status).toBe(302);
    });

    it('logout reports a 3xx as unavailable rather than throwing or refusing', async () => {
        const {client} = clientWith([{status: 307, body: {message: 'moved'}}]);
        await expect(client.logout('sometoken')).resolves.toEqual({
            revoked: false,
            unavailable: true,
            status: 307,
            message: 'the identity service could not confirm the sign-out'
        });
    });

    it('UNAVAILABLE: a 5xx on validate does not sign anybody out', async () => {
        const {client} = clientWith([{status: 503, body: {}}]);
        await expect(client.validateSession('t')).rejects.toBeInstanceOf(ServiceUnavailableError);
    });

    // Valid JSON is not the same as an answer: an object with neither a
    // `valid` flag nor a name says nothing about a session, so validate fails
    // closed on it exactly as on a body that will not parse.
    it('UNAVAILABLE: a 200 that names no session is not a valid session', async () => {
        const {client} = clientWith([{status: 200, body: {roles: ['admin']}}]);
        const error = await client.validateSession('t').catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(ServiceUnavailableError);
        expect((error as ServiceUnavailableError).status).toBe(200);
        expect((error as Error).message).toBe('the identity service answered 200 without a session');
    });

    // A `valid` that is neither true nor false is not an answer, and a name
    // beside it must not make it one — "false" and 0 may well mean no.
    it('UNAVAILABLE: a non-boolean `valid` beside a name is not a valid session', async () => {
        for (const valid of ['false', 0, 'true', 1]) {
            const {client} = clientWith([{status: 200, body: {valid, username: 'alice'}}]);
            const error = await client.validateSession('t').catch((caught: unknown) => caught);
            expect(error).toBeInstanceOf(ServiceUnavailableError);
            expect((error as ServiceUnavailableError).status).toBe(200);
            expect((error as Error).message).toBe('the identity service answered 200 without a session');
        }
    });

    it('reads a null `valid` as absent, so a name beside it is still a session', async () => {
        const {client} = clientWith([{status: 200, body: {valid: null, username: 'alice'}}]);
        const result = await client.validateSession('t');
        expect(result.ok).toBe(true);
        expect(result.ok && result.username).toBe('alice');
    });

    it('UNAVAILABLE: a 200 with no token is not a renewed session', async () => {
        const {client} = clientWith([{status: 200, body: {tokenType: 'Bearer'}}]);
        const error = await client.refreshSession('the-refresh-token').catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(ServiceUnavailableError);
        expect((error as ServiceUnavailableError).status).toBe(200);
        expect((error as Error).message).toBe('the identity service answered HTTP 200 without a token');
    });

    it('UNAVAILABLE: a 5xx on refresh does not become "that session could not be renewed"', async () => {
        const {client} = clientWith([{status: 503, body: {message: 'upstream exploded'}}]);
        const error = await client.refreshSession('the-refresh-token').catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(ServiceUnavailableError);
        expect((error as ServiceUnavailableError).status).toBe(503);
    });

    it('logout reports a 5xx as unavailable rather than throwing or refusing', async () => {
        const {client} = clientWith([{status: 503, body: {message: 'upstream exploded'}}]);
        await expect(client.logout('sometoken')).resolves.toEqual({
            revoked: false,
            unavailable: true,
            status: 503,
            message: 'the identity service could not confirm the sign-out'
        });
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

    it('the unavailable error does not carry the transport error as its cause', async () => {
        // Mirrors the Python package, where a raise inside an except block
        // chains the original unless told not to; here nothing is attached.
        const {client} = clientWith([new Error(`connect ECONNREFUSED ${BASE_URL} while sending hunter2`)]);
        const error = await client.login('alice', 'hunter2').catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(ServiceUnavailableError);
        expect('cause' in (error as object)).toBe(false);
    });

    // A base URL with no scheme is a plausible typo, and the real `fetch`
    // cannot parse it — it rejects before any socket is opened, so these three
    // need no stub and reach no network. They pin behaviour this package
    // already has, because the Python package did not have it: there, urllib
    // raised a bare ValueError that escaped every method.
    const UNPARSEABLE = 'accounts.example.test';

    it('UNAVAILABLE: a base URL with no scheme is not a refusal', async () => {
        const client = new SessionClient({baseUrl: UNPARSEABLE});
        const error = await client.login('alice', 'correct-horse').catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(ServiceUnavailableError);
        expect((error as ServiceUnavailableError).status).toBeNull();
        expect((error as Error).message).not.toContain('example.test');
    });

    it('logout still never throws when the base URL cannot be used', async () => {
        const client = new SessionClient({baseUrl: UNPARSEABLE});
        await expect(client.logout('sometoken')).resolves.toMatchObject({
            revoked: false,
            unavailable: true
        });
    });

    it('isReachable answers false when the base URL cannot be used', async () => {
        const client = new SessionClient({baseUrl: UNPARSEABLE});
        await expect(client.isReachable()).resolves.toBe(false);
    });

    // A body cut off part-way makes `text()` reject after the status arrived.
    // These pin behaviour this package already has, because the Python
    // package did not: there, urllib's IncompleteRead escaped every method.
    const cutOff = (status: number) =>
        (async () => ({
            status,
            text: async () => {
                throw new TypeError('terminated');
            }
        })) as unknown as typeof globalThis.fetch;

    it('UNAVAILABLE: a 200 whose body is cut off is not a login', async () => {
        const client = new SessionClient({baseUrl: BASE_URL, fetch: cutOff(200)});
        const error = await client.login('alice', 'correct-horse').catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(ServiceUnavailableError);
        expect((error as ServiceUnavailableError).status).toBe(200);
    });

    it('REFUSAL: a 401 whose body is cut off is still a refusal', async () => {
        const client = new SessionClient({baseUrl: BASE_URL, fetch: cutOff(401)});
        await expect(client.login('alice', 'wrong')).resolves.toEqual({
            ok: false,
            status: 401,
            message: 'Those credentials were not accepted.',
            raw: null
        });
    });

    // A timeout that expires after the status arrived, while the body is still
    // being read, is not a cut-off answer: the service did not answer in time.
    // The status is not kept, and the wording matches the Python package.
    const stallsMidBody = (status: number) =>
        (async (_url: string, init: RequestInit = {}) => ({
            status,
            text: () =>
                new Promise((_resolve, reject) => {
                    init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
                })
        })) as unknown as typeof globalThis.fetch;

    it('UNAVAILABLE: a 200 whose body times out is not a login', async () => {
        const client = new SessionClient({baseUrl: BASE_URL, fetch: stallsMidBody(200), timeoutMs: 5});
        const error = await client.login('alice', 'correct-horse').catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(ServiceUnavailableError);
        expect((error as ServiceUnavailableError).status).toBeNull();
        expect((error as Error).message).toBe('the identity service did not answer in time');
    });

    it('UNAVAILABLE: a 401 whose body times out is not a refusal', async () => {
        const client = new SessionClient({baseUrl: BASE_URL, fetch: stallsMidBody(401), timeoutMs: 5});
        const error = await client.login('alice', 'wrong').catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(ServiceUnavailableError);
        expect((error as ServiceUnavailableError).status).toBeNull();
        expect((error as Error).message).toBe('the identity service did not answer in time');
    });

    it('logout never throws when a 401 body times out', async () => {
        const client = new SessionClient({baseUrl: BASE_URL, fetch: stallsMidBody(401), timeoutMs: 5});
        await expect(client.logout('sometoken')).resolves.toMatchObject({
            revoked: false,
            unavailable: true,
            status: null
        });
    });
});
