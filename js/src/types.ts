// Configuration and result types.
//
// Every path and every response field name is configuration with a documented
// default, because this client is written against the SHAPE of an identity
// service — register / login / validate / refresh / logout over HTTP, with a
// bearer token in the reply — rather than against one particular server. The
// defaults describe the shape most such services already have; anything that
// disagrees is a few lines of config away rather than a fork.

/** Endpoint paths, relative to the base URL. All have defaults. */
export interface RouteMap {
    /** Create an account. Default `/register`. */
    register: string;
    /** Exchange credentials for a token. Default `/login`. */
    login: string;
    /** Check whether a bearer token is still a session. Default `/session/validate`. */
    validate: string;
    /** Revoke a bearer token. Default `/logout`. */
    logout: string;
    /** Exchange a refresh token for a new pair. Default `/token/refresh`. */
    refresh: string;
}

/**
 * Wire names for the fields this client reads out of a response body.
 *
 * These are the mapping hook. A service that calls its token `access_token`
 * and its expiry `expires_at` needs `{token: 'access_token', expiresAt:
 * 'expires_at'}` and nothing else. Anything not listed here is still handed
 * back untouched on the result's `raw` property, so a caller that needs a
 * field this library does not model can read it directly.
 */
export interface FieldMap {
    /** The bearer token itself. Default `token`. */
    token: string;
    /** Token expiry, a string as the service formats it. Default `expiresAt`. */
    expiresAt: string;
    /** The rotating refresh token, when the service issues one. Default `refreshToken`. */
    refreshToken: string;
    /** Boolean "this token is still a session" on the validate response. Default `valid`. */
    valid: string;
    /** The account name on a validate response. Default `username`. */
    username: string;
    /** Roles on a validate response, expected to be an array of strings. Default `roles`. */
    roles: string;
}

export interface SessionClientOptions {
    /**
     * Base URL of the identity service, e.g. `https://accounts.example.com`.
     * REQUIRED, and deliberately so: there is no sensible default hostname for
     * somebody else's identity service, and a client that guesses one fails by
     * quietly talking to the wrong place.
     *
     * A trailing slash is trimmed.
     */
    baseUrl: string;

    /** Endpoint paths. Partial: anything omitted keeps its default. */
    routes?: Partial<RouteMap>;

    /** Response field names. Partial: anything omitted keeps its default. */
    fields?: Partial<FieldMap>;

    /**
     * Per-request timeout in milliseconds. Default 8000.
     *
     * Bounded because a page must not hang because a service is wedged. Login
     * is the slowest of these by design — a password hash is deliberately
     * expensive to check — so the bound is generous rather than tight.
     */
    timeoutMs?: number;

    /**
     * Timeout for `isReachable()` in milliseconds. Default 2000.
     *
     * Shorter, because nothing is waiting on the answer except a panel saying
     * whether the form is worth filling in.
     */
    probeTimeoutMs?: number;

    /**
     * Body keys to look in for a human-readable refusal message, in order.
     * Default `['message', 'error']`.
     *
     * The service's own wording is preferred over anything invented here: its
     * validation messages are written for users ("password must contain a
     * lowercase letter..."), and restating them in the client would create a
     * second place for the account policy to be described, and get it wrong.
     */
    messageFields?: string[];

    /**
     * Extra headers on every request — an API key or a tracing header, say.
     * `Authorization` is set per-call and cannot be overridden here.
     */
    headers?: Record<string, string>;

    /**
     * `fetch` implementation. Defaults to the global one (Node 18+, browsers,
     * Deno, workers). Injectable mostly so tests need no network.
     */
    fetch?: typeof globalThis.fetch;
}

export const DEFAULT_ROUTES: RouteMap = {
    register: '/register',
    login: '/login',
    validate: '/session/validate',
    logout: '/logout',
    refresh: '/token/refresh'
};

export const DEFAULT_FIELDS: FieldMap = {
    token: 'token',
    expiresAt: 'expiresAt',
    refreshToken: 'refreshToken',
    valid: 'valid',
    username: 'username',
    roles: 'roles'
};

export const DEFAULT_TIMEOUT_MS = 8000;
export const DEFAULT_PROBE_TIMEOUT_MS = 2000;
export const DEFAULT_MESSAGE_FIELDS = ['message', 'error'];

/**
 * The service answered, and the answer is no: wrong password, name already
 * taken, password too weak. The user did something; tell them.
 */
export interface Refusal {
    ok: false;
    /** The HTTP status the service answered with. Always < 500. */
    status: number;
    /** Safe to show a person. The service's own wording where it gave one. */
    message: string;
    /** The parsed response body, or null when there was none. */
    raw: unknown;
}

/** A token and its companions, as issued. */
export interface IssuedTokens {
    token: string;
    expiresAt: string | null;
    refreshToken: string | null;
}

export type LoginSuccess = {ok: true; raw: unknown} & IssuedTokens;
export type RefreshSuccess = LoginSuccess;

export interface RegisterSuccess {
    ok: true;
    username: string;
    raw: unknown;
}

export interface ValidateSuccess {
    ok: true;
    username: string | null;
    roles: string[];
    raw: unknown;
}

export type LoginResult = LoginSuccess | Refusal;
export type RefreshResult = RefreshSuccess | Refusal;
export type RegisterResult = RegisterSuccess | Refusal;
export type ValidateResult = ValidateSuccess | Refusal;

/**
 * The outcome of a logout.
 *
 * Alone among the calls, this NEVER throws `ServiceUnavailableError`: a caller
 * must clear its local session whatever happened, and a method that throws is
 * a method somebody forgets to wrap. `unavailable` is reported as a field so
 * it can be logged, not so it can be acted on.
 */
export interface LogoutResult {
    /** The service confirmed the token is revoked. */
    revoked: boolean;
    /** The service could not be reached, so the token may still be live server-side. */
    unavailable: boolean;
    /** Set when the service refused — an already-expired token, typically. */
    status: number | null;
    /** The refusal or unavailability message, when there is one worth showing. */
    message: string | null;
}
