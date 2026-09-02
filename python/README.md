# session-client

Python client for an HTTP identity service that issues bearer tokens: register,
login, validate a session, refresh it, log out.

Every call resolves to one of **three distinct outcomes** — success, refusal, or
unavailable — and keeping them apart is the point of the library. See the
[repository README](https://github.com/kingdom-community/session-client#the-three-outcomes)
for the reasoning; this file is the API.

## Install

```bash
pip install session-client
```

Python 3.8+. **No dependencies** — the standard library's `urllib.request` is
enough for five JSON endpoints, and a client sitting in an authentication path
is a poor place to add a supply chain.

## Usage

```python
import os

from session_client import ServiceUnavailableError, SessionClient

accounts = SessionClient(
    os.environ.get("IDENTITY_SERVICE_URL", "https://accounts.example.com")
)


def sign_in(username, password):
    try:
        result = accounts.login(username, password)
    except ServiceUnavailableError:
        # UNAVAILABLE -- nobody did anything wrong and nothing is known.
        return {"error": "Sign-in is temporarily unavailable."}
    if not result.ok:
        # REFUSAL -- the service answered, and the answer is no.
        return {"error": result.message, "status": result.status}
    # SUCCESS -- store result.token somewhere that is not a log line.
    return {"token": result.token, "expires_at": result.expires_at}


def sign_out(token):
    # Never raises for unavailability: clear the local session either way.
    result = accounts.logout(token)
    clear_session_cookie()
    return result.revoked
```

## API

### `SessionClient(base_url, ...)`

| Argument | Type | Default |
|---|---|---|
| `base_url` | `str` | **required** — raises `ValueError` if empty |
| `routes` | `RouteMap` or a partial `dict` | `/register`, `/login`, `/session/validate`, `/logout`, `/token/refresh` |
| `fields` | `FieldMap` or a partial `dict` | `token`, `expiresAt`, `refreshToken`, `valid`, `username`, `roles` |
| `timeout` | `float` (seconds) | `8.0` |
| `probe_timeout` | `float` (seconds) | `2.0` |
| `message_fields` | `Sequence[str]` | `("message", "error")` |
| `headers` | `Mapping[str, str]` | `{}` |

A trailing slash on `base_url` is trimmed. `Authorization` is set per call and
cannot be overridden through `headers`. An unknown key in `routes` or `fields`
raises `ValueError` rather than being silently ignored.

### Methods

| Method | Returns | Raises `ServiceUnavailableError`? |
|---|---|---|
| `register(username, password, email=None)` | `RegisterSuccess \| Refusal` | yes |
| `login(username, password)` | `LoginSuccess \| Refusal` | yes |
| `validate_session(token)` | `ValidateSuccess \| Refusal` | yes |
| `refresh_session(refresh_token)` | `LoginSuccess \| Refusal` | yes |
| `logout(token)` | `LogoutResult` | **no, by contract** |
| `is_reachable()` | `bool` | no — that is what it reports |

Results are frozen dataclasses. Every one except `LogoutResult` carries `ok` (a
class attribute, so `result.ok` works without unpacking) and `raw`, the parsed
response body:

```python
LoginSuccess(ok=True,  token=..., expires_at=..., refresh_token=..., raw=...)
Refusal(     ok=False, status=..., message=..., raw=...)
```

`Refusal.status` is always below 500 — a 5xx is UNAVAILABLE, not a refusal.

`LogoutResult(revoked, unavailable, status, message)` is returned, never raised,
so a caller cannot forget to clear its local session during an outage.

`validate_session` returns `ValidateSuccess(username, roles, raw)`. It **fails
closed**: a 200 whose body says nothing about a session raises
`ServiceUnavailableError`, and an explicit `valid: false` is a `Refusal` whose
`status` is the 200 the service actually sent — branch on `ok`, not on `status`.

### Adapting to a differently-named service

```python
accounts = SessionClient(
    "https://id.example.com",
    routes={"login": "/oauth/token", "validate": "/userinfo"},
    fields={"token": "access_token", "expires_at": "expires_at",
            "refresh_token": "refresh_token"},
)
```

Anything not modelled is still on `result.raw`.

### Showing the panel before the password

```python
if not accounts.is_reachable():
    # Any HTTP response, including the expected 401, proves the service is up.
    # Only a transport failure gets here.
    render_temporarily_unavailable_panel()
```

## Credentials

No password is ever logged, stored or included in an error; no token is ever
written to a log line, because a token in a log line is a credential in every
backup of that log. This package contains no logging calls at all. The
unavailability error deliberately carries no transport detail, because socket
and DNS messages name hosts and are shown to users.

## Development

```bash
python3 -m unittest discover -s tests -v   # with src/ on PYTHONPATH, or after `pip install -e .`
```

## License

MIT.

## Origins

Extracted from the website and infrastructure stack behind a Minecraft
community server, generalised and released under MIT.
