import asyncio
import os
import unittest
from types import SimpleNamespace
from unittest import mock


FAKE_SECRET = "gw_test_secret_boundary_1234567890"


class _FakeWebSocket:
    def __init__(self):
        self.accepted = False
        self.close_calls = []
        self.query_params = {}
        self.client = SimpleNamespace(host="127.0.0.1")
        self.raw_data_calls = 0

    async def accept(self):
        self.accepted = True

    async def close(self, *, code, reason=""):
        self.close_calls.append((code, reason))

    async def send_bytes(self, _chunk):
        self.raw_data_calls += 1

    async def receive(self):
        self.raw_data_calls += 1
        raise AssertionError("managed PTY must not enter the raw data channel")


class TestEnterpriseManagedDashboardPty(unittest.TestCase):
    def test_rejects_before_accept_env_copy_or_spawn(self):
        import hermes_cli.web_server as web_server

        env_copy_calls = 0
        spawn_calls = 0

        def fail_resolve(*_args, **_kwargs):
            nonlocal env_copy_calls
            env_copy_calls += 1
            raise AssertionError("managed PTY must not resolve argv or copy process env")

        class SpawnGuard:
            @classmethod
            def spawn(cls, *_args, **_kwargs):
                nonlocal spawn_calls
                spawn_calls += 1
                raise AssertionError("managed PTY must not spawn")

        with (
            mock.patch.dict(
                os.environ,
                {
                    "HERMES_ENTERPRISE_MANAGED": "1",
                    "COMPANY_GATEWAY_TOKEN": FAKE_SECRET,
                },
            ),
            mock.patch.object(
                web_server, "_ws_auth_reason", return_value=(None, "session")
            ),
            mock.patch.object(web_server, "_ws_host_origin_reason", return_value=None),
            mock.patch.object(web_server, "_ws_client_reason", return_value=None),
            mock.patch.object(web_server, "_resolve_chat_argv", side_effect=fail_resolve),
            mock.patch.object(web_server, "PtyBridge", SpawnGuard),
        ):
            ws = _FakeWebSocket()
            asyncio.run(web_server.pty_ws(ws))

        self.assertFalse(ws.accepted)
        self.assertEqual(
            ws.close_calls, [(4403, "PTY disabled by enterprise managed policy")]
        )
        self.assertNotIn(FAKE_SECRET, ws.close_calls[0][1])
        self.assertEqual(env_copy_calls, 0)
        self.assertEqual(spawn_calls, 0)
        self.assertEqual(ws.raw_data_calls, 0)

    def test_non_managed_mode_keeps_existing_gate_order(self):
        import hermes_cli.web_server as web_server

        with (
            mock.patch.dict(os.environ, {"HERMES_ENTERPRISE_MANAGED": "0"}),
            mock.patch.object(web_server, "_DASHBOARD_EMBEDDED_CHAT_ENABLED", False),
        ):
            ws = _FakeWebSocket()
            asyncio.run(web_server.pty_ws(ws))

        self.assertFalse(ws.accepted)
        self.assertEqual(ws.close_calls, [(4404, "embedded chat disabled")])

    def test_does_not_disclose_managed_policy_before_auth(self):
        import hermes_cli.web_server as web_server

        with (
            mock.patch.dict(os.environ, {"HERMES_ENTERPRISE_MANAGED": "1"}),
            mock.patch.object(web_server, "_DASHBOARD_EMBEDDED_CHAT_ENABLED", True),
            mock.patch.object(
                web_server,
                "_ws_auth_reason",
                return_value=("missing dashboard credential", "none"),
            ),
        ):
            ws = _FakeWebSocket()
            asyncio.run(web_server.pty_ws(ws))

        self.assertFalse(ws.accepted)
        self.assertEqual(
            ws.close_calls, [(4401, "auth: missing dashboard credential")]
        )
        self.assertNotIn("managed", ws.close_calls[0][1].lower())
