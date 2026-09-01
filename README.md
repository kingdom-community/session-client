# session-client

Client libraries — TypeScript and Python — for an HTTP identity service that
issues bearer tokens: register an account, log in, validate a session, refresh
it, and log out. Every call resolves to one of three distinct outcomes:
**success**, **refusal** (the service answered, and the answer is no) or
**unavailable** (the service could not be reached, or answered something that
is not an answer). Keeping those three apart is the point of the library — it
is what lets an application say "sign-in is temporarily unavailable" instead of
"your password is wrong" while the identity service is simply down.
