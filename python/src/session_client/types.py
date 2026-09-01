"""Configuration and result types.

Every path and every response field name is configuration with a documented
default, because this client is written against the SHAPE of an identity
service -- register / login / validate / refresh / logout over HTTP, with a
bearer token in the reply -- rather than against one particular server. The
defaults describe the shape most such services already have; anything that
disagrees is a few lines of config away rather than a fork.
"""

from dataclasses import dataclass, field
from typing import Any, ClassVar, Dict, List, Optional, Union

__all__ = [
    "DEFAULT_FIELDS",
    "DEFAULT_MESSAGE_FIELDS",
    "DEFAULT_PROBE_TIMEOUT",
    "DEFAULT_ROUTES",
    "DEFAULT_TIMEOUT",
    "FieldMap",
    "LoginResult",
    "LoginSuccess",
    "LogoutResult",
    "Refusal",
    "RefreshResult",
    "RefreshSuccess",
    "RegisterResult",
    "RegisterSuccess",
    "RouteMap",
    "ValidateResult",
    "ValidateSuccess",
]


@dataclass(frozen=True)
class RouteMap:
    """Endpoint paths, relative to the base URL. All have defaults."""

    #: Create an account.
    register: str = "/register"
    #: Exchange credentials for a token.
    login: str = "/login"
    #: Check whether a bearer token is still a session.
    validate: str = "/session/validate"
    #: Revoke a bearer token.
    logout: str = "/logout"
    #: Exchange a refresh token for a new pair.
    refresh: str = "/token/refresh"


@dataclass(frozen=True)
class FieldMap:
    """Wire names for the fields this client reads out of a response body.

    This is the mapping hook. A service that calls its token ``access_token``
    and its expiry ``expires_at`` needs
    ``FieldMap(token="access_token", expires_at="expires_at")`` and nothing
    else. Anything not listed here is still handed back untouched on the
    result's ``raw`` attribute, so a caller that needs a field this library
    does not model can read it directly.
    """

    #: The bearer token itself.
    token: str = "token"
    #: Token expiry, a string as the service formats it.
    expires_at: str = "expiresAt"
    #: The rotating refresh token, when the service issues one.
    refresh_token: str = "refreshToken"
    #: Boolean "this token is still a session" on the validate response.
    valid: str = "valid"
    #: The account name on a validate response.
    username: str = "username"
    #: Roles on a validate response, expected to be a list of strings.
    roles: str = "roles"


DEFAULT_ROUTES = RouteMap()
DEFAULT_FIELDS = FieldMap()

#: Bounded because a caller must not hang because a service is wedged. Login is
#: the slowest of these by design -- a password hash is deliberately expensive
#: to check -- so the bound is generous rather than tight.
DEFAULT_TIMEOUT = 8.0

#: Shorter, because nothing is waiting on a reachability probe except a panel
#: saying whether the form is worth filling in.
DEFAULT_PROBE_TIMEOUT = 2.0

#: Body keys searched, in order, for a human-readable refusal message. The
#: service's own wording is preferred over anything invented here: its
#: validation messages are written for users ("password must contain a
#: lowercase letter..."), and restating them in the client would create a
#: second place for the account policy to be described, and get it wrong.
DEFAULT_MESSAGE_FIELDS = ("message", "error")


@dataclass(frozen=True)
class Refusal:
    """The service answered, and the answer is no.

    Wrong password, name already taken, password too weak. The user did
    something; tell them.
    """

    ok: ClassVar[bool] = False

    #: The HTTP status the service answered with. Always < 500.
    status: int
    #: Safe to show a person. The service's own wording where it gave one.
    message: str
    #: The parsed response body, or None when there was none.
    raw: Any = None


@dataclass(frozen=True)
class LoginSuccess:
    """A token and its companions, as issued."""

    ok: ClassVar[bool] = True

    token: str
    expires_at: Optional[str] = None
    refresh_token: Optional[str] = None
    raw: Any = None


#: A refresh returns the same shape as a login: a new token and, where the
#: service rotates them, its replacement refresh token.
RefreshSuccess = LoginSuccess


@dataclass(frozen=True)
class RegisterSuccess:
    ok: ClassVar[bool] = True

    username: str
    raw: Any = None


@dataclass(frozen=True)
class ValidateSuccess:
    ok: ClassVar[bool] = True

    username: Optional[str] = None
    roles: List[str] = field(default_factory=list)
    raw: Any = None


@dataclass(frozen=True)
class LogoutResult:
    """The outcome of a logout.

    Alone among the calls, logout NEVER raises ``ServiceUnavailableError``: a
    caller must clear its local session whatever happened, and a method that
    raises is a method somebody forgets to wrap. ``unavailable`` is reported as
    a field so it can be logged, not so it can be acted on.
    """

    #: The service confirmed the token is revoked.
    revoked: bool
    #: The service could not be reached, so the token may still be live
    #: server-side.
    unavailable: bool
    #: Set when the service answered -- an already-expired token, typically.
    status: Optional[int] = None
    #: The refusal or unavailability message, when there is one worth showing.
    message: Optional[str] = None


LoginResult = Union[LoginSuccess, Refusal]
RefreshResult = Union[LoginSuccess, Refusal]
RegisterResult = Union[RegisterSuccess, Refusal]
ValidateResult = Union[ValidateSuccess, Refusal]

#: Type of the optional per-request extra headers.
Headers = Dict[str, str]
