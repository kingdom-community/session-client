"""A client for an HTTP identity service that issues bearer tokens.

Every method distinguishes three outcomes, and the distinction is the point
rather than tidiness:

  * SUCCESS -- the service did the thing.
  * REFUSAL -- the service answered, and the answer is no (wrong password,
    name taken, password too weak). The user did something; tell them. A
    refusal is a returned value, because it is an ordinary outcome of a sign-in
    form rather than an exceptional one.
  * UNAVAILABLE -- the service could not be reached, or answered something that
    is not an answer. Nobody did anything wrong and NOTHING IS KNOWN. This
    raises ``ServiceUnavailableError``, and the caller renders "sign-in is
    temporarily unavailable" rather than "your password is wrong" -- and, in
    the case of logout, clears local session state regardless.

No password is ever logged, stored, or included in an error. Nothing here
writes a token to a log line either: a token is a credential, and a log line
carrying one is a credential in every backup of that log. This library contains
no logging calls at all, so the only way a credential reaches a log is if a
caller puts it there.

The client does not duplicate the service's account rules. Username length,
password complexity and email format are the service's to enforce and its
messages are written for users; restating them here would create a second place
for the policy to be described, and get it wrong.

Standard library only: ``urllib.request``, no third-party HTTP dependency.
"""

import json
import urllib.error
import urllib.request
from dataclasses import replace
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

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
    RegisterResult,
    RegisterSuccess,
    RouteMap,
    ValidateResult,
    ValidateSuccess,
)

__all__ = ["SessionClient"]


def _as_mapping(value: Any) -> Optional[Dict[str, Any]]:
    return value if isinstance(value, dict) else None


def _non_empty_string(value: Any) -> Optional[str]:
    return value if isinstance(value, str) and value.strip() != "" else None


def _overlay(base: Any, overrides: Any, name: str) -> Any:
    """Apply a partial mapping (or a fully-built dataclass) over a default."""
    if overrides is None:
        return base
    if isinstance(overrides, type(base)):
        return overrides
    if isinstance(overrides, Mapping):
        unknown = set(overrides) - set(vars(base))
        if unknown:
            raise ValueError(
                "unknown %s key(s): %s" % (name, ", ".join(sorted(unknown)))
            )
        return replace(base, **dict(overrides))
    raise TypeError("%s must be a mapping or a %s" % (name, type(base).__name__))


class SessionClient:
    """Talks to one identity service.

    :param base_url: e.g. ``https://accounts.example.com``. REQUIRED, and
        deliberately so: there is no sensible default hostname for somebody
        else's identity service, and a client that guesses one fails by quietly
        talking to the wrong place. A trailing slash is trimmed.
    :param routes: a :class:`RouteMap`, or a partial mapping of the fields to
        override. Endpoint paths are configuration, not constants.
    :param fields: a :class:`FieldMap`, or a partial mapping. The hook for a
        service that names its response fields differently.
    :param timeout: per-request timeout in seconds. Default 8.
    :param probe_timeout: timeout for :meth:`is_reachable`. Default 2.
    :param message_fields: body keys searched, in order, for a human-readable
        refusal message.
    :param headers: extra headers on every request -- an API key or a tracing
        header, say. ``Authorization`` is set per call and cannot be overridden
        here.
    """

    def __init__(
        self,
        base_url: str,
        routes: Any = None,
        fields: Any = None,
        timeout: float = DEFAULT_TIMEOUT,
        probe_timeout: float = DEFAULT_PROBE_TIMEOUT,
        message_fields: Sequence[str] = DEFAULT_MESSAGE_FIELDS,
        headers: Optional[Mapping[str, str]] = None,
    ) -> None:
        cleaned = (base_url or "").strip().rstrip("/")
        if not cleaned:
            # Failing here, loudly, at construction. A client that invents a
            # default hostname for somebody else's identity service fails much
            # later and much more confusingly.
            raise ValueError(
                "SessionClient requires a base_url, e.g. https://accounts.example.com"
            )
        self.base_url: str = cleaned
        self.routes: RouteMap = _overlay(DEFAULT_ROUTES, routes, "routes")
        self.fields: FieldMap = _overlay(DEFAULT_FIELDS, fields, "fields")
        self.timeout: float = timeout
        self.probe_timeout: float = probe_timeout
        self.message_fields: Tuple[str, ...] = tuple(message_fields)
        self.headers: Dict[str, str] = dict(headers or {})

    # -- the calls ---------------------------------------------------------

    def register(
        self, username: str, password: str, email: Optional[str] = None
    ) -> RegisterResult:
        """Create an account.

        The service validates the username, password and email; this client
        does not duplicate those rules. Expect refusals with the status the
        service uses for each -- commonly 400 for a value the policy rejects,
        409 for a username or email already taken, and 429 for rate limiting --
        carrying the service's own message.
        """
        body: Dict[str, Any] = {"username": username, "password": password}
        if email:
            body["email"] = email
        status, parsed = self._request("POST", self.routes.register, body=body)
        if status in (200, 201):
            # Prefer the name the service echoes back: identity services
            # commonly canonicalise it (trimmed, lower-cased), and the caller
            # needs the canonical form, not the one that was typed.
            record = _as_mapping(parsed) or {}
            echoed = _non_empty_string(record.get(self.fields.username))
            return RegisterSuccess(username=echoed or username, raw=parsed)
        # A taken username is not concealed. The service already answers that
        # question to anyone who asks it directly, so hiding it here buys
        # nothing; what matters is that the CALLER's own tables do not become
        # an enumeration oracle on top of it.
        return self._refuse_or_raise(status, parsed, "That account could not be created.")

    def login(self, username: str, password: str) -> LoginResult:
        """Exchange a username and password for a bearer token."""
        status, parsed = self._request(
            "POST", self.routes.login, body={"username": username, "password": password}
        )
        if status in (200, 201):
            tokens = self._tokens_from(parsed)
            if tokens is None:
                # A 200 with no token is not a login. Treating it as one would
                # store an empty session and present as "logged in, but
                # nothing works".
                raise ServiceUnavailableError(
                    "the identity service answered HTTP %d without a token" % status,
                    status=status,
                )
            return tokens
        return self._refuse_or_raise(status, parsed, "Those credentials were not accepted.")

    def validate_session(self, token: str) -> ValidateResult:
        """Ask whether a bearer token is still a session.

        Fails closed. A 200 whose body cannot be read as an answer is
        UNAVAILABLE, not a valid session: not knowing whether somebody is
        signed in must never be mistaken for knowing that they are.

        A body that explicitly reports ``valid: false`` is a REFUSAL -- the
        service answered, and the answer is no -- so check ``ok`` rather than
        ``status``, which in that case is the 200 the service actually sent.
        """
        if not token:
            # No network call: an absent token cannot be a session, and asking
            # is a round trip whose answer is already known.
            return Refusal(status=401, message="No bearer token was supplied.", raw=None)
        status, parsed = self._request("GET", self.routes.validate, token=token)
        if status != 200:
            return self._refuse_or_raise(status, parsed, "That session is not valid.")
        record = _as_mapping(parsed)
        if record is None:
            raise ServiceUnavailableError(
                "the identity service answered 200 without a session", status=200
            )
        valid = record.get(self.fields.valid)
        if valid is False:
            return Refusal(status=200, message="That session is not valid.", raw=parsed)
        username = _non_empty_string(record.get(self.fields.username))
        if valid is not True and username is None:
            # Neither an explicit `valid` nor a name: nothing here says this is
            # a session, so it is not treated as one.
            raise ServiceUnavailableError(
                "the identity service answered 200 without a session", status=200
            )
        raw_roles = record.get(self.fields.roles)
        roles: List[str] = (
            [role for role in raw_roles if isinstance(role, str)]
            if isinstance(raw_roles, list)
            else []
        )
        return ValidateSuccess(username=username, roles=roles, raw=parsed)

    def refresh_session(self, refresh_token: str) -> RefreshResult:
        """Exchange a refresh token for a new pair.

        Where the service issues rotating, single-use refresh tokens, the one
        presented here is invalid afterwards and the reply carries its
        replacement. Store both new values together or neither: a rotated
        refresh token kept beside a stale access token is a session that
        half-works and then dies confusingly.
        """
        status, parsed = self._request(
            "POST", self.routes.refresh, body={"refreshToken": refresh_token}
        )
        if status in (200, 201):
            tokens = self._tokens_from(parsed)
            if tokens is None:
                raise ServiceUnavailableError(
                    "the identity service answered HTTP %d without a token" % status,
                    status=status,
                )
            return tokens
        return self._refuse_or_raise(status, parsed, "That session could not be renewed.")

    def logout(self, token: str) -> LogoutResult:
        """Revoke a bearer token.

        Best-effort BY CONTRACT, and the only method here that never raises
        ``ServiceUnavailableError``. Clear the local session whatever this
        returns: refusing to sign somebody out of their own browser because the
        identity service is restarting is worse than a token that outlives its
        cookie by its remaining lifetime. The returned flags are there to be
        reported, not to be acted on.
        """
        try:
            status, parsed = self._request("POST", self.routes.logout, token=token)
        except ServiceUnavailableError as error:
            return LogoutResult(
                revoked=False,
                unavailable=True,
                status=error.status,
                message="the identity service could not be reached",
            )
        if 200 <= status < 300:
            return LogoutResult(revoked=True, unavailable=False, status=status, message=None)
        if status >= 500:
            return LogoutResult(
                revoked=False,
                unavailable=True,
                status=status,
                message="the identity service could not confirm the sign-out",
            )
        return LogoutResult(
            revoked=False,
            unavailable=False,
            status=status,
            message=self._message_from(parsed, "That token could not be revoked."),
        )

    def is_reachable(self) -> bool:
        """Is the service answering at all?

        Asked with no credential against the validate route: ANY HTTP response
        -- including the 401 this is expected to produce -- proves the service
        is up, while a transport failure proves it is not.

        Use it to show a "sign-in is temporarily unavailable" panel BEFORE
        somebody types their password, rather than after.
        """
        try:
            self._request("GET", self.routes.validate, timeout=self.probe_timeout)
            return True
        except ServiceUnavailableError:
            return False

    # -- plumbing ----------------------------------------------------------

    def _request(
        self,
        method: str,
        path: str,
        body: Optional[Mapping[str, Any]] = None,
        token: Optional[str] = None,
        timeout: Optional[float] = None,
    ) -> Tuple[int, Any]:
        url = "%s%s" % (self.base_url, path)
        data = json.dumps(body).encode() if body is not None else None
        headers = {"Accept": "application/json"}
        headers.update(self.headers)
        if data is not None:
            headers["Content-Type"] = "application/json"
        if token:
            headers["Authorization"] = "Bearer %s" % token
        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(
                request, timeout=self.timeout if timeout is None else timeout
            ) as response:
                status = getattr(response, "status", None) or response.getcode()
                return int(status), self._parse(response.read())
        except urllib.error.HTTPError as error:
            # A non-2xx is still an ANSWER. Whether it is a refusal or an
            # outage is decided by the caller, not here.
            return int(error.code), self._parse(error.read())
        except (urllib.error.URLError, TimeoutError, OSError):
            # Connection refused, DNS failure, TLS failure, timeout. The
            # underlying message is deliberately not carried: it names hosts
            # and network topology, and this error is shown to users.
            raise ServiceUnavailableError()

    @staticmethod
    def _parse(raw: Optional[bytes]) -> Any:
        if not raw:
            return None
        try:
            return json.loads(raw)
        except (ValueError, UnicodeDecodeError):
            # An error page from a proxy in front of the service is HTML. A
            # body that cannot be read is not an answer.
            return None

    # A 5xx is "we do not know", not "no". Treating it as a refusal would tell
    # a user their password is wrong during an outage.
    def _refuse_or_raise(self, status: int, parsed: Any, fallback: str) -> Refusal:
        if status >= 500:
            raise ServiceUnavailableError(
                "the identity service answered HTTP %d" % status, status=status
            )
        return Refusal(
            status=status, message=self._message_from(parsed, fallback), raw=parsed
        )

    def _message_from(self, parsed: Any, fallback: str) -> str:
        record = _as_mapping(parsed)
        if record is not None:
            for key in self.message_fields:
                value = record.get(key)
                if isinstance(value, str) and value.strip() != "":
                    return value.strip()
        return fallback

    def _tokens_from(self, parsed: Any) -> Optional[LoginSuccess]:
        record = _as_mapping(parsed)
        if record is None:
            return None
        token = record.get(self.fields.token)
        if not isinstance(token, str) or token == "":
            return None
        expires_at = record.get(self.fields.expires_at)
        refresh_token = record.get(self.fields.refresh_token)
        return LoginSuccess(
            token=token,
            expires_at=expires_at if isinstance(expires_at, str) else None,
            refresh_token=(
                refresh_token
                if isinstance(refresh_token, str) and refresh_token != ""
                else None
            ),
            raw=parsed,
        )
