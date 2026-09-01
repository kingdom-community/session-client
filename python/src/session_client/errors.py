"""The one thing this library raises.

A refusal is a returned value, not an exception: "wrong password" is an
ordinary outcome of a sign-in form and belongs in the return type where the
caller cannot skip it. An exception is reserved for the case where NOTHING IS
KNOWN -- the service was unreachable, timed out, or answered something that is
not an answer.
"""

from typing import Optional

__all__ = ["ServiceUnavailableError"]


class ServiceUnavailableError(Exception):
    """The identity service could not be reached, or answered something that
    is not an answer.

    Nobody did anything wrong and nothing is known. Callers render "sign-in is
    temporarily unavailable" rather than "your password is wrong", and -- for
    logout -- clear local session state anyway.

    ``status`` is the HTTP status when the service answered with one that is
    not an answer (a 5xx, say), and ``None`` for a transport failure or
    timeout, where there was no response at all.
    """

    def __init__(
        self,
        message: str = "the identity service is unreachable",
        status: Optional[int] = None,
    ) -> None:
        super().__init__(message)
        self.status = status
