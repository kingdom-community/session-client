# @kingdom-community/session-client

TypeScript client for an HTTP identity service that issues bearer tokens:
register, login, validate a session, refresh it, log out.

Every call resolves to one of **three distinct outcomes** — success, refusal, or
unavailable — and keeping them apart is the point of the library. See the
[repository README](https://github.com/kingdom-community/session-client#the-three-outcomes)
for the reasoning; this file is the API.

## Install

```bash
npm install @kingdom-community/session-client
```

Node 18+ (or any runtime with a global `fetch`: browsers, Deno, workers). No
runtime dependencies.

## Usage

```ts
import {
    SessionClient,
    ServiceUnavailableError
} from '@kingdom-community/session-client';

const accounts = new SessionClient({
    baseUrl: process.env.IDENTITY_SERVICE_URL ?? 'https://accounts.example.com'
});

async function signIn(username: string, password: string) {
    try {
        const result = await accounts.login(username, password);
        if (!result.ok) {
            // REFUSAL — the service answered, and the answer is no.
            return {error: result.message, status: result.status};
        }
        // SUCCESS — put result.token straight into an httpOnly cookie. Do not
        // log it and do not hand it to page scripts.
        return {token: result.token, expiresAt: result.expiresAt};
    } catch (error) {
        if (error instanceof ServiceUnavailableError) {
            // UNAVAILABLE — nobody did anything wrong and nothing is known.
            return {error: 'Sign-in is temporarily unavailable.'};
        }
        throw error;
    }
}

async function signOut(token: string) {
    // Never throws for unavailability: clear the local session either way.
    const result = await accounts.logout(token);
    clearCookies();
    return result.revoked;
}
```

## API

### `new SessionClient(options)`

| Option | Type | Default |
|---|---|---|
| `baseUrl` | `string` | **required** — throws if empty |
| `routes` | `Partial<RouteMap>` | `{register: '/register', login: '/login', validate: '/session/validate', logout: '/logout', refresh: '/token/refresh'}` |
| `fields` | `Partial<FieldMap>` | `{token: 'token', expiresAt: 'expiresAt', refreshToken: 'refreshToken', valid: 'valid', username: 'username', roles: 'roles'}` |
| `timeoutMs` | `number` | `8000` |
| `probeTimeoutMs` | `number` | `2000` |
| `messageFields` | `string[]` | `['message', 'error']` |
| `headers` | `Record<string, string>` | `{}` |
| `fetch` | `typeof fetch` | the global one |

A trailing slash on `baseUrl` is trimmed. `Authorization` is set per call and
cannot be overridden through `headers`.

### Methods

| Method | Returns | Throws `ServiceUnavailableError`? |
|---|---|---|
| `register(username, password, email?)` | `RegisterResult` | yes |
| `login(username, password)` | `LoginResult` | yes |
| `validateSession(token)` | `ValidateResult` | yes |
| `refreshSession(refreshToken)` | `RefreshResult` | yes |
| `logout(token)` | `LogoutResult` | **no, by contract** |
| `isReachable()` | `boolean` | no — that is what it reports |

Every result is a discriminated union on `ok`:

```ts
type LoginResult =
    | {ok: true; token: string; expiresAt: string | null; refreshToken: string | null; raw: unknown}
    | {ok: false; status: number; message: string; raw: unknown};
```

`Refusal.status` is always below 500 — a 5xx is UNAVAILABLE, not a refusal.

`LogoutResult` is `{revoked, unavailable, status, message}` and never a thrown
error, so a caller cannot forget to clear its local session during an outage.

`validateSession` returns `{ok: true, username, roles, raw}`. It **fails
closed**: a 200 whose body says nothing about a session is UNAVAILABLE, and an
explicit `valid: false` is a refusal whose `status` is the 200 the service
actually sent — branch on `ok`, not on `status`.

### Adapting to a differently-named service

```ts
const accounts = new SessionClient({
    baseUrl: 'https://id.example.com',
    routes: {login: '/oauth/token', validate: '/userinfo'},
    fields: {token: 'access_token', expiresAt: 'expires_at', refreshToken: 'refresh_token'}
});
```

Anything not modelled is still on `result.raw`.

### Showing the panel before the password

```ts
if (!(await accounts.isReachable())) {
    // Any HTTP response, including the expected 401, proves the service is up.
    // Only a transport failure gets here.
    renderTemporarilyUnavailablePanel();
}
```

## Credentials

No password is ever logged, stored or included in an error; no token is ever
written to a log line, because a token in a log line is a credential in every
backup of that log. This package contains no logging calls at all. The
unavailability error deliberately carries no transport detail, because socket
and DNS messages name hosts and are shown to users.

## Development

```bash
npm install
npm test        # vitest
npm run build   # tsc -> dist/
```

## License

MIT.

## Origins

Extracted from the website and infrastructure stack behind a Minecraft
community server, generalised and released under MIT.
