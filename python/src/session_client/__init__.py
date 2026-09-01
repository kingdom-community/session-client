"""Client for a bearer-token identity service.

Success, refusal and unavailable are three distinct outcomes, and keeping them
apart is the point of the library: it is what lets an application say "sign-in
is temporarily unavailable" instead of "your password is wrong" while the
identity service is simply down.
"""

from .client import SessionClient
from .errors import ServiceUnavailableError
from .types import (
    DEFAULT_FIELDS,
    DEFAULT_MESSAGE_FIELDS,
    DEFAULT_PROBE_TIMEOUT,
    DEFAULT_ROUTES,
    DEFAULT_TIMEOUT,
    FieldMap,
    LoginResult,
    LoginSuccess,
    LogoutResult,
    Refusal,
    RefreshResult,
    RefreshSuccess,
    RegisterResult,
    RegisterSuccess,
    RouteMap,
    ValidateResult,
    ValidateSuccess,
)

__version__ = "0.1.0"

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
    "ServiceUnavailableError",
    "SessionClient",
    "ValidateResult",
    "ValidateSuccess",
    "__version__",
]
