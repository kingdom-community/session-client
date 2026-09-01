// A client for an HTTP identity service that issues bearer tokens.
//
// Every method distinguishes three outcomes, and the distinction is the point
// rather than tidiness:
//
//   * SUCCESS — the service did the thing.
//   * REFUSAL — the service answered, and the answer is no (wrong password,
//     name taken, password too weak). The user did something; tell them.
//     A refusal is a returned value, because it is an ordinary outcome of a
//     sign-in form rather than an exceptional one.
//   * UNAVAILABLE — the service could not be reached, or answered something
//     that is not an answer. Nobody did anything wrong and NOTHING IS KNOWN.
//     This throws `ServiceUnavailableError`, and the caller renders "sign-in
//     is temporarily unavailable" rather than "your password is wrong" — and,
//     in the case of logout, clears local session state regardless.
//
// No password is ever logged, stored, or included in an error. Nothing here
// writes a token to a log line either: a token is a credential, and a log line
// carrying one is a credential in every backup of that log. This library
// contains no logging calls at all, so the only way a credential reaches a log
// is if a caller puts it there.
//
// The client does not duplicate the service's account rules. Username length,
// password complexity and email format are the service's to enforce and its
// messages are written for users; restating them here would create a second
// place for the policy to be described, and get it wrong.

import {ServiceUnavailableError} from './errors';
import {
    DEFAULT_FIELDS,
    DEFAULT_MESSAGE_FIELDS,
    DEFAULT_PROBE_TIMEOUT_MS,
    DEFAULT_ROUTES,
    DEFAULT_TIMEOUT_MS,
    type FieldMap,
    type IssuedTokens,
    type LoginResult,
    type LogoutResult,
    type Refusal,
    type RefreshResult,
    type RegisterResult,
    type RouteMap,
    type SessionClientOptions,
    type ValidateResult
} from './types';

interface RawResponse {
    status: number;
    body: unknown;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;

const nonEmptyString = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() !== '' ? value : null;

export class SessionClient {
    private readonly baseUrl: string;
    private readonly routes: RouteMap;
    private readonly fields: FieldMap;
    private readonly timeoutMs: number;
    private readonly probeTimeoutMs: number;
    private readonly messageFields: string[];
    private readonly headers: Record<string, string>;
    private readonly fetchImpl: typeof globalThis.fetch;

    constructor(options: SessionClientOptions) {
        const baseUrl = (options.baseUrl ?? '').trim().replace(/\/+$/, '');
        if (baseUrl === '') {
            // Failing here, loudly, at construction. A client that invents a
            // default hostname for somebody else's identity service fails much
            // later and much more confusingly.
            throw new Error('SessionClient requires a baseUrl, e.g. https://accounts.example.com');
        }
        this.baseUrl = baseUrl;
        this.routes = {...DEFAULT_ROUTES, ...(options.routes ?? {})};
        this.fields = {...DEFAULT_FIELDS, ...(options.fields ?? {})};
        this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        this.probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
        this.messageFields = options.messageFields ?? DEFAULT_MESSAGE_FIELDS;
        this.headers = options.headers ?? {};
        const fetchImpl = options.fetch ?? globalThis.fetch;
        if (typeof fetchImpl !== 'function') {
            throw new Error('No fetch implementation available; pass one as options.fetch');
        }
        this.fetchImpl = fetchImpl;
    }

    // ---- the calls -------------------------------------------------------

    /**
     * Create an account.
     *
     * The service validates the username, password and email; this client does
     * not duplicate those rules. Expect refusals with the status the service
     * uses for each — commonly 400 for a value the policy rejects, 409 for a
     * username or email already taken, and 429 for rate limiting — carrying
     * the service's own message.
     */
    async register(username: string, password: string, email?: string | null): Promise<RegisterResult> {
        const response = await this.request(this.routes.register, {
            method: 'POST',
            body: {username, password, ...(email ? {email} : {})}
        });
        if (response.status === 200 || response.status === 201) {
            // Prefer the name the service echoes back: identity services
            // commonly canonicalise it (trimmed, lower-cased), and the caller
            // needs the canonical form, not the one that was typed.
            const echoed = nonEmptyString(asRecord(response.body)?.[this.fields.username]);
            return {ok: true, username: echoed ?? username, raw: response.body};
        }
        // A taken username is not concealed. The service already answers that
        // question to anyone who asks it directly, so hiding it here buys
        // nothing; what matters is that the CALLER's own tables do not become
        // an enumeration oracle on top of it.
        return this.refuseOrThrow(response, 'That account could not be created.');
    }

    /** Exchange a username and password for a bearer token. */
    async login(username: string, password: string): Promise<LoginResult> {
        const response = await this.request(this.routes.login, {
            method: 'POST',
            body: {username, password}
        });
        if (response.status === 200 || response.status === 201) {
            const tokens = this.tokensFrom(response.body);
            if (!tokens) {
                // A 200 with no token is not a login. Treating it as one would
                // store an empty session and present as "logged in, but
                // nothing works".
                throw new ServiceUnavailableError(
                    `the identity service answered HTTP ${response.status} without a token`,
                    response.status
                );
            }
            return {ok: true, ...tokens, raw: response.body};
        }
        return this.refuseOrThrow(response, 'Those credentials were not accepted.');
    }

    /**
     * Ask whether a bearer token is still a session.
     *
     * Fails closed. A 200 whose body cannot be read as an answer is
     * UNAVAILABLE, not a valid session: not knowing whether somebody is signed
     * in must never be mistaken for knowing that they are.
     *
     * A body that explicitly reports `valid: false` is a REFUSAL — the service
     * answered, and the answer is no — so check `ok` rather than `status`,
     * which in that case is the 200 the service actually sent.
     */
    async validateSession(token: string): Promise<ValidateResult> {
        if (!token) {
            // No network call: an absent token cannot be a session, and asking
            // is a round trip whose answer is already known.
            return {ok: false, status: 401, message: 'No bearer token was supplied.', raw: null};
        }
        const response = await this.request(this.routes.validate, {token});
        if (response.status !== 200) {
            return this.refuseOrThrow(response, 'That session is not valid.');
        }
        const record = asRecord(response.body);
        if (!record) {
            throw new ServiceUnavailableError('the identity service answered 200 without a session', 200);
        }
        const valid = record[this.fields.valid];
        if (valid === false) {
            return {ok: false, status: 200, message: 'That session is not valid.', raw: response.body};
        }
        const username = nonEmptyString(record[this.fields.username]);
        if (valid !== true && username === null) {
            // Neither an explicit `valid` nor a name: nothing here says this is
            // a session, so it is not treated as one.
            throw new ServiceUnavailableError('the identity service answered 200 without a session', 200);
        }
        const roles = record[this.fields.roles];
        return {
            ok: true,
            username,
            roles: Array.isArray(roles) ? roles.filter((role): role is string => typeof role === 'string') : [],
            raw: response.body
        };
    }

    /**
     * Exchange a refresh token for a new pair.
     *
     * Where the service issues rotating, single-use refresh tokens, the one
     * presented here is invalid afterwards and the reply carries its
     * replacement. Store both new values together or neither: a rotated
     * refresh token kept beside a stale access token is a session that
     * half-works and then dies confusingly.
     */
    async refreshSession(refreshToken: string): Promise<RefreshResult> {
        const response = await this.request(this.routes.refresh, {
            method: 'POST',
            body: {refreshToken}
        });
        if (response.status === 200 || response.status === 201) {
            const tokens = this.tokensFrom(response.body);
            if (!tokens) {
                throw new ServiceUnavailableError(
                    `the identity service answered HTTP ${response.status} without a token`,
                    response.status
                );
            }
            return {ok: true, ...tokens, raw: response.body};
        }
        return this.refuseOrThrow(response, 'That session could not be renewed.');
    }

    /**
     * Revoke a bearer token.
     *
     * Best-effort BY CONTRACT, and the only method here that never throws
     * `ServiceUnavailableError`. Clear the local session whatever this
     * returns: refusing to sign somebody out of their own browser because the
     * identity service is restarting is worse than a token that outlives its
     * cookie by its remaining lifetime. The returned flags are there to be
     * reported, not to be acted on.
     */
    async logout(token: string): Promise<LogoutResult> {
        try {
            const response = await this.request(this.routes.logout, {method: 'POST', token});
            if (response.status >= 200 && response.status < 300) {
                return {revoked: true, unavailable: false, status: response.status, message: null};
            }
            if (response.status >= 500) {
                return {
                    revoked: false,
                    unavailable: true,
                    status: response.status,
                    message: 'the identity service could not confirm the sign-out'
                };
            }
            return {
                revoked: false,
                unavailable: false,
                status: response.status,
                message: this.messageFrom(response.body, 'That token could not be revoked.')
            };
        } catch (error) {
            return {
                revoked: false,
                unavailable: true,
                status: error instanceof ServiceUnavailableError ? error.status : null,
                message: 'the identity service could not be reached'
            };
        }
    }

    /**
     * Is the service answering at all?
     *
     * Asked with no credential against the validate route: ANY HTTP response —
     * including the 401 this is expected to produce — proves the service is
     * up, while a transport failure proves it is not.
     *
     * Use it to show a "sign-in is temporarily unavailable" panel BEFORE
     * somebody types their password, rather than after.
     */
    async isReachable(): Promise<boolean> {
        try {
            await this.request(this.routes.validate, {timeoutMs: this.probeTimeoutMs});
            return true;
        } catch {
            return false;
        }
    }

    // ---- plumbing --------------------------------------------------------

    private async request(
        path: string,
        init: {method?: string; body?: unknown; token?: string; timeoutMs?: number} = {}
    ): Promise<RawResponse> {
        const controller = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, init.timeoutMs ?? this.timeoutMs);
        try {
            const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
                method: init.method ?? 'GET',
                headers: {
                    Accept: 'application/json',
                    ...this.headers,
                    ...(init.body === undefined ? {} : {'Content-Type': 'application/json'}),
                    ...(init.token ? {Authorization: `Bearer ${init.token}`} : {})
                },
                body: init.body === undefined ? undefined : JSON.stringify(init.body),
                signal: controller.signal
            });
            let body: unknown = null;
            try {
                const text = await response.text();
                body = text === '' ? null : JSON.parse(text);
            } catch {
                // An error page from a proxy in front of the service is HTML.
                // A body that cannot be read is not an answer.
                body = null;
            }
            return {status: response.status, body};
        } catch {
            // Connection refused, DNS failure, TLS failure, timeout. The
            // underlying message is deliberately not carried: it names hosts
            // and network topology, and this error is shown to users.
            throw new ServiceUnavailableError(
                timedOut
                    ? 'the identity service did not answer in time'
                    : 'the identity service is unreachable'
            );
        } finally {
            clearTimeout(timer);
        }
    }

    // A 5xx is "we do not know", not "no". Treating it as a refusal would tell
    // a user their password is wrong during an outage.
    private refuseOrThrow(response: RawResponse, fallback: string): Refusal {
        if (response.status >= 500) {
            throw new ServiceUnavailableError(
                `the identity service answered HTTP ${response.status}`,
                response.status
            );
        }
        return {
            ok: false,
            status: response.status,
            message: this.messageFrom(response.body, fallback),
            raw: response.body
        };
    }

    private messageFrom(body: unknown, fallback: string): string {
        const record = asRecord(body);
        if (record) {
            for (const key of this.messageFields) {
                const value = record[key];
                if (typeof value === 'string' && value.trim() !== '') {
                    return value.trim();
                }
            }
        }
        return fallback;
    }

    private tokensFrom(body: unknown): IssuedTokens | null {
        const record = asRecord(body);
        if (!record) {
            return null;
        }
        const token = record[this.fields.token];
        if (typeof token !== 'string' || token === '') {
            return null;
        }
        const expiresAt = record[this.fields.expiresAt];
        const refreshToken = record[this.fields.refreshToken];
        return {
            token,
            expiresAt: typeof expiresAt === 'string' ? expiresAt : null,
            refreshToken: typeof refreshToken === 'string' && refreshToken !== '' ? refreshToken : null
        };
    }
}
