#!/usr/bin/env python3
"""Unit tests for session_client. ``urllib.request.urlopen`` is mocked
throughout, so these need neither a running identity service nor network
access.

The three-outcome behaviour has its own test case class at the bottom, and it
is the part worth reading: SUCCESS, REFUSAL and UNAVAILABLE must never be
collapsed into each other.

Run:  python3 -m unittest discover -s tests -v   (from python/)
"""
import json
import unittest
import urllib.error
from unittest import mock

from session_client import (
    Refusal,
    ServiceUnavailableError,
    SessionClient,
)

BASE_URL = "https://accounts.example.test"

TOKENS = {
    "token": "header.payload.signature",
    "tokenType": "Bearer",
    "expiresAt": "2099-01-01T00:00:00Z",
    "refreshToken": "the-refresh-token",
}


def _mock_response(payload, status=200, text=None):
    body = text.encode() if text is not None else json.dumps(payload).encode()
    resp = mock.MagicMock()
    resp.read.return_value = body
    resp.status = status
    resp.__enter__.return_value = resp
    resp.__exit__.return_value = False
    return resp


def _http_error(status, payload, text=None):
    body = text.encode() if text is not None else json.dumps(payload).encode()
    err = urllib.error.HTTPError(
        url=BASE_URL + "/x", code=status, msg="err", hdrs=None, fp=None
    )
    err.read = mock.MagicMock(return_value=body)
    return err


def client(**kwargs):
    return SessionClient(BASE_URL, **kwargs)


def sent_body(mocked):
    return json.loads(mocked.call_args[0][0].data)


def sent_headers(mocked):
    return mocked.call_args[0][0].headers


def sent_url(mocked):
    return mocked.call_args[0][0].full_url


class TestConstruction(unittest.TestCase):
    def test_base_url_is_required_rather_than_guessed(self):
        for bad in ("", "   ", None):
            with self.assertRaises(ValueError):
                SessionClient(bad)

    def test_trailing_slash_is_trimmed(self):
        with mock.patch(
            "urllib.request.urlopen", return_value=_mock_response(TOKENS)
        ) as m:
            SessionClient(BASE_URL + "/").login("alice", "correct-horse")
        self.assertEqual(sent_url(m), BASE_URL + "/login")

    def test_default_routes(self):
        with mock.patch(
            "urllib.request.urlopen", return_value=_mock_response(TOKENS)
        ) as m:
            client().refresh_session("r1")
        self.assertEqual(sent_url(m), BASE_URL + "/token/refresh")

    def test_routes_are_configuration_not_constants(self):
        with mock.patch(
            "urllib.request.urlopen", return_value=_mock_response(TOKENS)
        ) as m:
            client(routes={"login": "/api/v2/sessions"}).login("alice", "correct-horse")
        self.assertEqual(sent_url(m), BASE_URL + "/api/v2/sessions")

    def test_an_unknown_route_key_is_rejected_loudly(self):
        with self.assertRaises(ValueError):
            client(routes={"signin": "/signin"})

    def test_field_map_adapts_to_a_differently_named_service(self):
        payload = {"access_token": "abc", "expires_at": "later", "refresh_token": "r2"}
        with mock.patch("urllib.request.urlopen", return_value=_mock_response(payload)):
            result = client(
                fields={
                    "token": "access_token",
                    "expires_at": "expires_at",
                    "refresh_token": "refresh_token",
                }
            ).login("alice", "correct-horse")
        self.assertTrue(result.ok)
        self.assertEqual(result.token, "abc")
        self.assertEqual(result.expires_at, "later")
        self.assertEqual(result.refresh_token, "r2")

    def test_extra_headers_are_sent(self):
        with mock.patch(
            "urllib.request.urlopen", return_value=_mock_response(TOKENS)
        ) as m:
            client(headers={"X-Api-Key": "k"}).login("alice", "correct-horse")
        self.assertEqual(sent_headers(m).get("X-api-key"), "k")


class TestLogin(unittest.TestCase):
    def test_success_returns_the_issued_tokens(self):
        with mock.patch(
            "urllib.request.urlopen", return_value=_mock_response(TOKENS)
        ) as m:
            result = client().login("alice", "correct-horse")
        self.assertTrue(result.ok)
        self.assertEqual(result.token, TOKENS["token"])
        self.assertEqual(result.expires_at, TOKENS["expiresAt"])
        self.assertEqual(result.refresh_token, TOKENS["refreshToken"])
        self.assertEqual(
            sent_body(m), {"username": "alice", "password": "correct-horse"}
        )

    def test_bad_credentials_is_a_refusal_carrying_the_service_message(self):
        with mock.patch(
            "urllib.request.urlopen", side_effect=_http_error(401, {"message": "bad creds"})
        ):
            result = client().login("alice", "wrong")
        self.assertIsInstance(result, Refusal)
        self.assertFalse(result.ok)
        self.assertEqual(result.status, 401)
        self.assertEqual(result.message, "bad creds")

    def test_falls_back_to_its_own_wording_when_the_service_gives_none(self):
        with mock.patch("urllib.request.urlopen", side_effect=_http_error(401, {})):
            result = client().login("alice", "wrong")
        self.assertEqual(result.message, "Those credentials were not accepted.")

    def test_reads_a_message_out_of_an_error_key_too(self):
        with mock.patch(
            "urllib.request.urlopen",
            side_effect=_http_error(400, {"error": "username is required"}),
        ):
            result = client().login("", "wrong")
        self.assertEqual(result.message, "username is required")

    def test_the_password_never_appears_in_the_result(self):
        with mock.patch(
            "urllib.request.urlopen", side_effect=_http_error(401, {"message": "bad creds"})
        ):
            result = client().login("alice", "hunter2")
        self.assertNotIn("hunter2", repr(result))


class TestRegister(unittest.TestCase):
    def test_success_returns_the_created_account(self):
        payload = {"id": 7, "username": "alice", "email": None, "createdAt": "now"}
        with mock.patch(
            "urllib.request.urlopen", return_value=_mock_response(payload, status=201)
        ) as m:
            result = client().register("alice", "Str0ng-Pass!")
        self.assertTrue(result.ok)
        self.assertEqual(result.username, "alice")
        self.assertEqual(
            sent_body(m), {"username": "alice", "password": "Str0ng-Pass!"}
        )

    def test_a_200_is_accepted_as_well_since_services_differ(self):
        with mock.patch("urllib.request.urlopen", return_value=_mock_response({})):
            self.assertTrue(client().register("alice", "Str0ng-Pass!").ok)

    def test_prefers_the_canonical_name_the_service_echoes_back(self):
        with mock.patch(
            "urllib.request.urlopen",
            return_value=_mock_response({"username": "alice"}, status=201),
        ):
            result = client().register("  Alice  ", "Str0ng-Pass!")
        self.assertEqual(result.username, "alice")

    def test_email_is_sent_only_when_given(self):
        with mock.patch("urllib.request.urlopen", return_value=_mock_response({})) as m:
            client().register("alice", "Str0ng-Pass!")
            self.assertNotIn("email", sent_body(m))
            client().register("bob", "Str0ng-Pass!", "b@example.test")
            self.assertEqual(sent_body(m)["email"], "b@example.test")

    def test_duplicate_username_is_a_refusal_with_409(self):
        with mock.patch(
            "urllib.request.urlopen",
            side_effect=_http_error(409, {"message": "username already in use"}),
        ):
            result = client().register("alice", "Str0ng-Pass!")
        self.assertFalse(result.ok)
        self.assertEqual(result.status, 409)
        self.assertIn("already in use", result.message)

    def test_the_service_owns_the_password_policy(self):
        # A weak password is sent, not rejected locally: the service owns the
        # policy, and there is exactly one place it is described.
        with mock.patch(
            "urllib.request.urlopen",
            side_effect=_http_error(400, {"message": "password must contain a digit"}),
        ) as m:
            result = client().register("alice", "weak")
        self.assertEqual(sent_body(m)["password"], "weak")
        self.assertFalse(result.ok)
        self.assertEqual(result.status, 400)
        self.assertIn("digit", result.message)

    def test_rate_limiting_is_a_refusal_not_an_outage(self):
        with mock.patch(
            "urllib.request.urlopen", side_effect=_http_error(429, {"message": "slow down"})
        ):
            result = client().register("alice", "Str0ng-Pass!")
        self.assertFalse(result.ok)
        self.assertEqual(result.status, 429)


class TestValidateSession(unittest.TestCase):
    def test_a_valid_session_returns_the_account(self):
        payload = {"valid": True, "username": "alice", "roles": ["ROLE_USER"]}
        with mock.patch(
            "urllib.request.urlopen", return_value=_mock_response(payload)
        ) as m:
            result = client().validate_session("sometoken")
        self.assertTrue(result.ok)
        self.assertEqual(result.username, "alice")
        self.assertEqual(result.roles, ["ROLE_USER"])
        self.assertEqual(sent_headers(m).get("Authorization"), "Bearer sometoken")
        self.assertEqual(sent_url(m), BASE_URL + "/session/validate")

    def test_a_body_naming_the_account_without_a_valid_flag_is_accepted(self):
        with mock.patch(
            "urllib.request.urlopen", return_value=_mock_response({"username": "alice"})
        ):
            self.assertTrue(client().validate_session("t").ok)

    def test_an_explicit_valid_false_is_a_refusal(self):
        with mock.patch(
            "urllib.request.urlopen", return_value=_mock_response({"valid": False})
        ):
            result = client().validate_session("expiredtoken")
        self.assertFalse(result.ok)

    def test_missing_token_is_refused_without_a_network_call(self):
        with mock.patch("urllib.request.urlopen") as mocked:
            result = client().validate_session("")
        mocked.assert_not_called()
        self.assertFalse(result.ok)
        self.assertEqual(result.status, 401)

    def test_a_401_is_a_refusal(self):
        with mock.patch(
            "urllib.request.urlopen",
            side_effect=_http_error(401, {"message": "token expired"}),
        ):
            result = client().validate_session("t")
        self.assertFalse(result.ok)
        self.assertEqual(result.status, 401)

    def test_non_string_roles_are_dropped_rather_than_handed_back(self):
        payload = {"valid": True, "username": "alice", "roles": ["ROLE_USER", 3, None]}
        with mock.patch("urllib.request.urlopen", return_value=_mock_response(payload)):
            result = client().validate_session("t")
        self.assertEqual(result.roles, ["ROLE_USER"])


class TestRefreshSession(unittest.TestCase):
    def test_returns_the_rotated_pair(self):
        payload = {"token": "new-access", "expiresAt": "later", "refreshToken": "new-refresh"}
        with mock.patch(
            "urllib.request.urlopen", return_value=_mock_response(payload)
        ) as m:
            result = client().refresh_session("old-refresh")
        self.assertTrue(result.ok)
        self.assertEqual(result.token, "new-access")
        self.assertEqual(result.refresh_token, "new-refresh")
        self.assertEqual(sent_body(m), {"refreshToken": "old-refresh"})

    def test_a_spent_refresh_token_is_a_refusal(self):
        with mock.patch(
            "urllib.request.urlopen",
            side_effect=_http_error(401, {"message": "refresh token not recognised"}),
        ):
            result = client().refresh_session("spent")
        self.assertFalse(result.ok)
        self.assertEqual(result.status, 401)


class TestLogout(unittest.TestCase):
    def test_success_reports_the_token_as_revoked(self):
        with mock.patch(
            "urllib.request.urlopen", return_value=_mock_response({}, status=204)
        ) as m:
            result = client().logout("sometoken")
        self.assertTrue(result.revoked)
        self.assertFalse(result.unavailable)
        self.assertEqual(sent_headers(m).get("Authorization"), "Bearer sometoken")

    def test_a_refusal_is_reported_without_raising(self):
        with mock.patch(
            "urllib.request.urlopen",
            side_effect=_http_error(401, {"message": "token already expired"}),
        ):
            result = client().logout("stale")
        self.assertFalse(result.revoked)
        self.assertFalse(result.unavailable)
        self.assertEqual(result.status, 401)


class TestIsReachable(unittest.TestCase):
    def test_true_when_the_service_answers_at_all_including_a_401(self):
        with mock.patch(
            "urllib.request.urlopen", side_effect=_http_error(401, {"message": "no token"})
        ):
            self.assertTrue(client().is_reachable())

    def test_false_when_the_connection_fails(self):
        with mock.patch(
            "urllib.request.urlopen",
            side_effect=urllib.error.URLError("connection refused"),
        ):
            self.assertFalse(client().is_reachable())

    def test_uses_the_shorter_probe_timeout(self):
        with mock.patch(
            "urllib.request.urlopen", return_value=_mock_response({"valid": False})
        ) as m:
            client(probe_timeout=1.5).is_reachable()
        self.assertEqual(m.call_args.kwargs["timeout"], 1.5)


class TestTheThreeOutcomesAreKeptApart(unittest.TestCase):
    """The reason this library exists."""

    def test_success_a_200_with_a_token_is_a_login(self):
        with mock.patch("urllib.request.urlopen", return_value=_mock_response(TOKENS)):
            self.assertTrue(client().login("alice", "correct-horse").ok)

    def test_refusal_a_401_is_an_answer_and_the_answer_is_no(self):
        with mock.patch(
            "urllib.request.urlopen", side_effect=_http_error(401, {"message": "bad creds"})
        ):
            result = client().login("alice", "wrong")
        self.assertFalse(result.ok)
        self.assertEqual(result.status, 401)

    def test_unavailable_a_connection_failure_is_not_a_wrong_password(self):
        with mock.patch(
            "urllib.request.urlopen",
            side_effect=urllib.error.URLError("connection refused"),
        ):
            with self.assertRaises(ServiceUnavailableError) as ctx:
                client().login("alice", "correct-horse")
        self.assertIsNone(ctx.exception.status)

    def test_unavailable_a_timeout_is_not_a_wrong_password(self):
        with mock.patch("urllib.request.urlopen", side_effect=TimeoutError("timed out")):
            with self.assertRaises(ServiceUnavailableError):
                client().login("alice", "correct-horse")

    def test_unavailable_a_200_with_a_garbage_body_is_not_a_success(self):
        with mock.patch(
            "urllib.request.urlopen",
            return_value=_mock_response(None, text="<html>502 Bad Gateway</html>"),
        ):
            with self.assertRaises(ServiceUnavailableError):
                client().login("alice", "correct-horse")

    def test_unavailable_a_200_without_a_token_is_not_a_login(self):
        with mock.patch(
            "urllib.request.urlopen", return_value=_mock_response({"tokenType": "Bearer"})
        ):
            with self.assertRaises(ServiceUnavailableError):
                client().login("alice", "correct-horse")

    def test_unavailable_a_200_with_a_garbage_body_is_not_a_valid_session(self):
        with mock.patch(
            "urllib.request.urlopen", return_value=_mock_response(None, text="not json")
        ):
            with self.assertRaises(ServiceUnavailableError):
                client().validate_session("t")

    def test_unavailable_a_5xx_is_we_do_not_know_not_no(self):
        for status in (500, 502, 503):
            with self.subTest(status=status):
                with mock.patch(
                    "urllib.request.urlopen",
                    side_effect=_http_error(status, {"message": "upstream exploded"}),
                ):
                    with self.assertRaises(ServiceUnavailableError) as ctx:
                        client().login("alice", "correct-horse")
                self.assertEqual(ctx.exception.status, status)

    def test_unavailable_a_5xx_on_register_does_not_become_that_name_is_taken(self):
        with mock.patch("urllib.request.urlopen", side_effect=_http_error(503, {})):
            with self.assertRaises(ServiceUnavailableError):
                client().register("alice", "Str0ng-Pass!")

    def test_unavailable_a_5xx_on_validate_does_not_sign_anybody_out(self):
        with mock.patch("urllib.request.urlopen", side_effect=_http_error(503, {})):
            with self.assertRaises(ServiceUnavailableError):
                client().validate_session("t")

    def test_logout_still_lets_the_caller_clear_local_state_during_an_outage(self):
        # Note what this does NOT do: raise. A caller must be able to sign
        # somebody out of their own browser during an outage without wrapping
        # the call in a try block it might forget.
        with mock.patch(
            "urllib.request.urlopen",
            side_effect=urllib.error.URLError("connection refused"),
        ):
            result = client().logout("sometoken")
        self.assertFalse(result.revoked)
        self.assertTrue(result.unavailable)

    def test_the_unavailable_error_leaks_neither_credential_nor_hostname(self):
        with mock.patch(
            "urllib.request.urlopen",
            side_effect=urllib.error.URLError(
                "connection refused to %s while sending hunter2" % BASE_URL
            ),
        ):
            with self.assertRaises(ServiceUnavailableError) as ctx:
                client().login("alice", "hunter2")
        rendered = str(ctx.exception)
        self.assertNotIn("hunter2", rendered)
        self.assertNotIn("example.test", rendered)


if __name__ == "__main__":
    unittest.main()
