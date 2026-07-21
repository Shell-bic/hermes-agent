from __future__ import annotations

import hashlib
import hmac
import os
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from agent.enterprise_channel_audit import (
    HEADER_ACTOR,
    HEADER_BOT_ID,
    HEADER_NONCE,
    HEADER_SIGNATURE,
    HEADER_SOURCE,
    HEADER_TIMESTAMP,
    RESERVED_HEADERS,
    apply_channel_actor_headers,
    canonical_payload,
    channel_actor_audit_scope,
)


class _Request:
    def __init__(self, headers=None):
        self.headers = dict(headers or {})


class EnterpriseChannelAuditTests(unittest.TestCase):
    @patch.dict(os.environ, {"WECOM_BOT_ID": "bot-7", "WECOM_SECRET": "bot-secret-only-in-runtime"}, clear=False)
    def test_wecom_actor_headers_are_signed_from_internal_source_and_not_user_headers(self):
        http_client = SimpleNamespace(event_hooks={})
        agent = SimpleNamespace(
            provider="company-gateway",
            client=SimpleNamespace(_client=http_client),
            _anthropic_client=None,
        )
        source = SimpleNamespace(platform=SimpleNamespace(value="wecom"), user_id="member-42")
        request = _Request({HEADER_ACTOR: "forged-admin", HEADER_SIGNATURE: "forged-signature"})

        with channel_actor_audit_scope(agent, source):
            self.assertEqual(1, len(http_client.event_hooks["request"]))
            http_client.event_hooks["request"][0](request)

        self.assertEqual("wecom", request.headers[HEADER_SOURCE])
        self.assertEqual("bot-7", request.headers[HEADER_BOT_ID])
        self.assertEqual("member-42", request.headers[HEADER_ACTOR])
        payload = canonical_payload(
            "wecom",
            "bot-7",
            "member-42",
            request.headers[HEADER_TIMESTAMP],
            request.headers[HEADER_NONCE],
        )
        expected = hmac.new(
            b"bot-secret-only-in-runtime",
            payload.encode("utf-8"),
            hashlib.sha256,
        ).digest()
        import base64

        self.assertEqual(
            base64.urlsafe_b64encode(expected).decode("ascii").rstrip("="),
            request.headers[HEADER_SIGNATURE],
        )

    @patch.dict(os.environ, {"WECOM_BOT_ID": "bot-7", "WECOM_SECRET": "bot-secret-only-in-runtime"}, clear=False)
    def test_non_wecom_or_unbound_requests_strip_reserved_actor_headers(self):
        agent = SimpleNamespace(provider="company-gateway", client=None, _anthropic_client=None)
        source = SimpleNamespace(platform=SimpleNamespace(value="local"), user_id="forged-admin")
        request = _Request({name: "attacker-controlled" for name in RESERVED_HEADERS})

        with channel_actor_audit_scope(agent, source):
            apply_channel_actor_headers(agent, request)

        self.assertTrue(all(name not in request.headers for name in RESERVED_HEADERS))

    @patch.dict(os.environ, {}, clear=True)
    def test_managed_source_signs_after_wecom_environment_is_scrubbed(self):
        agent = SimpleNamespace(provider="company-gateway", client=None, _anthropic_client=None)
        source = SimpleNamespace(
            platform=SimpleNamespace(value="wecom"),
            user_id="member-42",
            _enterprise_channel_signing_context={
                "bot_id": "bot-7",
                "secret": "in-memory-secret",
            },
        )
        request = _Request()

        with channel_actor_audit_scope(agent, source):
            apply_channel_actor_headers(agent, request)

        self.assertEqual("bot-7", request.headers[HEADER_BOT_ID])
        self.assertEqual("member-42", request.headers[HEADER_ACTOR])
        self.assertIn(HEADER_SIGNATURE, request.headers)


if __name__ == "__main__":
    unittest.main()
