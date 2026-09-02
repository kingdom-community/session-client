# session-client

Client libraries — **TypeScript** and **Python** — for an HTTP identity service
that issues bearer tokens. One repository, two packages, the same model in
both:

| Package | Registry | Directory |
|---|---|---|
| `@kingdom-community/session-client` | npm | [`js/`](js/) |
| `session-client` | PyPI | [`python/`](python/) |

```
register  ->  create an account
login     ->  exchange credentials for a bearer token
validate  ->  is this token still a session, and whose?
refresh   ->  exchange a refresh token for a new pair
logout    ->  revoke a token
```

It is deliberately not a client for one particular server. Every endpoint path
and every response field name is configuration with a documented default, so
the library fits any service of this **shape** rather than one vendor's
implementation of it.

## The three outcomes

Every call resolves to exactly one of three things, and keeping them apart is
the entire point of the library:

| Outcome | What it means | How you get it |
|---|---|---|
| **SUCCESS** | The service did the thing. | A result with `ok === true` / `.ok is True`. |
| **REFUSAL** | The service answered, and the answer is **no** — wrong password, name taken, password too weak. The user did something; tell them. | A result with `ok === false` / `.ok is False`, carrying the service's own status and message. |
| **UNAVAILABLE** | The service could not be reached, or answered something that is not an answer. **Nobody did anything wrong and nothing is known.** | A thrown / raised `ServiceUnavailableError`. |

The third row is the one most clients get wrong. A sign-in form that treats an
outage as a rejection tells people their password is wrong while the identity
service is simply restarting — so they change a password that was never the
problem, and support gets a ticket about it. With this library, that case
arrives as a distinct error type you cannot mistake for a refusal:

```ts
try {
    const result = await client.login(username, password);
    if (!result.ok) {
        return show(result.message);          // REFUSAL: their problem, and fixable
    }
    return startSession(result.token);        // SUCCESS
} catch (error) {
    if (error instanceof ServiceUnavailableError) {
        return show('Sign-in is temporarily unavailable. Please try again shortly.');
    }
    throw error;                              // UNAVAILABLE: nobody's problem
}
```

Three consequences of that model, all deliberate:

- **A 5xx is not a refusal.** "We do not know" and "no" are different answers,
  and only one of them should be shown to a user as a rejection.
- **A 200 that is not an answer is not a success.** A login reply with no token,
  or a body that is an HTML error page from a proxy in front of the service, is
  UNAVAILABLE. Treating it as a login would store an empty session and present
  as "signed in, but nothing works".
- **Logout never reports UNAVAILABLE by throwing.** It returns a result. A
  caller must be able to clear its own local session whatever happened, and a
  method that throws is a method somebody forgets to wrap.

Session validation **fails closed** for the same reason, from the other
direction: a 200 whose body says nothing about a session is UNAVAILABLE, never
a valid session. Not knowing whether somebody is signed in must never be
mistaken for knowing that they are.

## Credentials

- **No password is ever logged, stored, or included in an error.** Passwords go
  into one request body and are never read back out.
- **No token is ever written to a log line**, because a token in a log line is a
  credential in every backup of that log. There are no logging calls anywhere in
  either package; the only way a credential reaches a log is if a caller puts it
  there.
- **The unavailability error carries no transport detail.** Underlying socket
  and DNS messages name hosts and network topology, and this error is shown to
  users, so it is replaced rather than wrapped.

## The client does not enforce the account policy

Username length, password complexity and email format are the **service's**
rules to enforce, and this client does not restate them. A weak password is
sent, refused, and the service's own message — written for users — is handed
back to you.

The alternative is two places where the policy is described, which drift, and
then a form that rejects a password the service would have accepted. Expect the
service to answer with something like:

| Status | Typical meaning |
|---|---|
| `400` | A value the account policy rejects — password too weak, malformed email. |
| `401` | Credentials not accepted, or a token that is expired, revoked or unknown. |
| `409` | Username or email already taken. |
| `429` | Rate limited. |
| `5xx` | Not an answer. Surfaces as UNAVAILABLE, not as a refusal. |

Those are conventions, not requirements: the client passes through whatever
status the service sends and only ever treats `>= 500` specially.

## Configuration

Both packages take the same options. Only the base URL is required.

| Option | Default | Notes |
|---|---|---|
| base URL | **required** | No default hostname. A client that guesses one fails by quietly talking to the wrong place. |
| routes | `/register`, `/login`, `/session/validate`, `/logout`, `/token/refresh` | Endpoint paths are configuration, not constants. Override any subset. |
| fields | `token`, `expiresAt`, `refreshToken`, `valid`, `username`, `roles` | Wire names of the response fields the client reads. The mapping hook for a service that calls its token `access_token`. |
| timeout | 8s | A caller must not hang because a service is wedged. Generous rather than tight, because checking a password hash is deliberately expensive. |
| probe timeout | 2s | For the reachability probe: nothing waits on it except a panel saying whether the form is worth filling in. |
| message fields | `message`, `error` | Body keys searched, in order, for a human-readable refusal message. |
| headers | none | Extra headers on every request. `Authorization` is set per call. |

Anything the client does not model is still on the `raw` property of every
result except the logout one, which reports flags rather than a body, so a
field this library has no opinion about is one attribute access away.

## Per-package documentation

- [`js/README.md`](js/README.md) — install, full API, TypeScript types.
- [`python/README.md`](python/README.md) — install, full API, type hints.

## Development

```bash
(cd js && npm install && npm test)                                       # vitest
(cd python && PYTHONPATH=src python3 -m unittest discover -s tests)      # stdlib unittest, no deps
```

CI runs both suites on every push and pull request.

## License

MIT. See [LICENSE](LICENSE).

## Origins

Extracted from the website and infrastructure stack behind a Minecraft
community server, generalised and released under MIT. The originals were two
independently written clients — one TypeScript, one Python — for a single
internal identity service; this is the shape they had in common, with the
service-specific parts turned into configuration.
