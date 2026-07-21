import asyncio
from types import SimpleNamespace

import pytest

from hermes_cli import web_server


def _app():
    return SimpleNamespace(state=SimpleNamespace())


def test_desktop_gateway_runner_consumes_secret_env_then_stops(monkeypatch):
    from gateway.config import Platform, PlatformConfig

    app = _app()
    observed = {}

    class FakeRunner:
        def __init__(self, config):
            observed["config"] = config
            self.started = False
            self.stopped = False
            self.session_changed_callback = None
            self.session_event_callback = None
            self.startup_auto_resume_enabled = True

        def set_startup_auto_resume_enabled(self, enabled):
            self.startup_auto_resume_enabled = bool(enabled)

        def set_desktop_session_changed_callback(self, callback):
            self.session_changed_callback = callback

        def set_desktop_session_event_callback(self, callback):
            self.session_event_callback = callback

        async def start(self):
            self.started = True
            return True

        async def stop(self):
            self.stopped = True

    def load_config():
        observed["bot_id_during_load"] = web_server.os.environ.get("WECOM_BOT_ID")
        observed["secret_during_load"] = web_server.os.environ.get("WECOM_SECRET")
        return SimpleNamespace(
            platforms={
                Platform.TELEGRAM: PlatformConfig(enabled=True, extra={"token": "must-not-start"}),
                Platform.WECOM: PlatformConfig(
                    extra={
                        "bot_id": "runtime-bot-id",
                        "secret": "runtime-secret-value",
                        "websocket_url": "wss://operator-override.invalid",
                    }
                ),
            }
        )

    monkeypatch.setenv("HERMES_DESKTOP", "1")
    monkeypatch.setenv("HERMES_DESKTOP_WECOM_GATEWAY_RUNNER", "1")
    monkeypatch.setenv("WECOM_BOT_ID", "runtime-bot-id")
    monkeypatch.setenv("WECOM_SECRET", "runtime-secret-value")
    monkeypatch.setenv("WECOM_DM_POLICY", "allowlist")
    monkeypatch.setenv("WECOM_ALLOWED_USERS", "owner-user-id")
    monkeypatch.setenv("WECOM_GROUP_POLICY", "open")
    monkeypatch.setenv("WECOM_WEBSOCKET_URL", "wss://operator-override.invalid")

    async def scenario():
        runner = await web_server._start_desktop_wecom_gateway_runner(
            app,
            config_loader=load_config,
            runner_factory=FakeRunner,
        )
        assert runner.started is True
        assert app.state.desktop_wecom_gateway_runner is runner
        assert "WECOM_BOT_ID" not in web_server.os.environ
        assert "WECOM_SECRET" not in web_server.os.environ
        assert "WECOM_WEBSOCKET_URL" not in web_server.os.environ
        assert list(observed["config"].platforms) == [Platform.WECOM]
        assert observed["config"].platforms[Platform.WECOM].extra["allow_from"] == ["owner-user-id"]
        assert observed["config"].platforms[Platform.WECOM].extra["dm_policy"] == "allowlist"
        assert observed["config"].platforms[Platform.WECOM].extra["group_policy"] == "open"
        assert set(observed["config"].platforms[Platform.WECOM].extra) == {
            "allow_from",
            "bot_id",
            "dm_policy",
            "group_policy",
            "secret",
        }
        assert runner.session_changed_callback is not None
        assert runner.session_event_callback is not None
        assert runner.startup_auto_resume_enabled is False
        await web_server._stop_desktop_wecom_gateway_runner(app)
        assert runner.stopped is True
        assert runner.session_changed_callback is None
        assert runner.session_event_callback is None
        assert app.state.desktop_wecom_gateway_runner is None

    asyncio.run(scenario())
    assert observed["bot_id_during_load"] == "runtime-bot-id"
    assert observed["secret_during_load"] == "runtime-secret-value"


def test_desktop_gateway_runner_broadcasts_live_session_events(monkeypatch):
    from gateway.config import Platform, PlatformConfig
    from tui_gateway import ws

    app = _app()
    frames = []

    class FakeRunner:
        def __init__(self, config):
            self.session_event_callback = None

        def set_desktop_session_event_callback(self, callback):
            self.session_event_callback = callback

        async def start(self):
            return True

        async def stop(self):
            return None

    async def broadcast_event(event_type, *, payload=None, session_id=""):
        frames.append((event_type, session_id, payload))
        return 1

    monkeypatch.setattr(ws, "broadcast_event", broadcast_event)
    monkeypatch.setenv("HERMES_DESKTOP", "1")
    monkeypatch.setenv("HERMES_DESKTOP_WECOM_GATEWAY_RUNNER", "1")
    monkeypatch.setenv("WECOM_BOT_ID", "runtime-bot-id")
    monkeypatch.setenv("WECOM_SECRET", "runtime-secret-value")
    monkeypatch.setenv("WECOM_ALLOWED_USERS", "owner-user-id")
    monkeypatch.setenv("WECOM_DM_POLICY", "allowlist")
    monkeypatch.setenv("WECOM_GROUP_POLICY", "open")

    def load_config():
        return SimpleNamespace(
            platforms={
                Platform.WECOM: PlatformConfig(
                    extra={
                        "bot_id": "runtime-bot-id",
                        "secret": "runtime-secret-value",
                    }
                )
            }
        )

    async def scenario():
        runner = await web_server._start_desktop_wecom_gateway_runner(
            app,
            config_loader=load_config,
            runner_factory=FakeRunner,
        )
        await runner.session_event_callback(
            "message.delta",
            "stored-session",
            {"channel": "wecom", "text": "partial"},
        )

    asyncio.run(scenario())

    assert frames == [
        (
            "message.delta",
            "",
            {
                "channel": "wecom",
                "text": "partial",
                "stored_session_id": "stored-session",
            },
        )
    ]


def test_desktop_gateway_runner_uses_real_gateway_config_resolution(monkeypatch):
    from gateway.config import Platform, load_gateway_config

    app = _app()
    captured = {}

    class FakeRunner:
        def __init__(self, config):
            captured["config"] = config

        async def start(self):
            return True

        async def stop(self):
            return None

    monkeypatch.setenv("HERMES_DESKTOP", "1")
    monkeypatch.setenv("HERMES_DESKTOP_WECOM_GATEWAY_RUNNER", "1")
    monkeypatch.setenv("WECOM_BOT_ID", "runtime-bot-id")
    monkeypatch.setenv("WECOM_SECRET", "runtime-secret-value")
    monkeypatch.setenv("WECOM_DM_POLICY", "allowlist")
    monkeypatch.setenv("WECOM_ALLOWED_USERS", "owner-user-id")
    monkeypatch.setenv("WECOM_GROUP_POLICY", "open")

    asyncio.run(
        web_server._start_desktop_wecom_gateway_runner(
            app,
            config_loader=load_gateway_config,
            runner_factory=FakeRunner,
        )
    )

    wecom = captured["config"].platforms[Platform.WECOM]
    assert list(captured["config"].platforms) == [Platform.WECOM]
    assert wecom.enabled is True
    assert wecom.extra["bot_id"] == "runtime-bot-id"
    assert wecom.extra["secret"] == "runtime-secret-value"
    assert wecom.extra["allow_from"] == ["owner-user-id"]
    assert wecom.extra["dm_policy"] == "allowlist"
    assert wecom.extra["group_policy"] == "open"
    assert set(wecom.extra) == {"allow_from", "bot_id", "dm_policy", "group_policy", "secret"}
    assert "WECOM_BOT_ID" not in web_server.os.environ
    assert "WECOM_SECRET" not in web_server.os.environ


def test_desktop_gateway_runner_requires_complete_ephemeral_credentials(monkeypatch):
    app = _app()
    monkeypatch.setenv("HERMES_DESKTOP", "1")
    monkeypatch.setenv("HERMES_DESKTOP_WECOM_GATEWAY_RUNNER", "1")
    monkeypatch.setenv("WECOM_BOT_ID", "runtime-bot-id")
    monkeypatch.delenv("WECOM_SECRET", raising=False)

    with pytest.raises(RuntimeError, match="in-memory runtime credential and policy set"):
        asyncio.run(web_server._start_desktop_wecom_gateway_runner(app))


def test_desktop_gateway_runner_starts_detached_without_legacy_credentials(monkeypatch):
    from gateway.config import Platform, PlatformConfig

    app = _app()
    observed = {}

    class FakeRunner:
        def __init__(self, config):
            observed["platforms"] = dict(config.platforms)

        async def start(self):
            return True

        async def stop(self):
            return None

    monkeypatch.setenv("HERMES_DESKTOP", "1")
    monkeypatch.setenv("HERMES_DESKTOP_WECOM_GATEWAY_RUNNER", "1")
    monkeypatch.delenv("WECOM_BOT_ID", raising=False)
    monkeypatch.delenv("WECOM_SECRET", raising=False)
    monkeypatch.delenv("WECOM_ALLOWED_USERS", raising=False)

    config = SimpleNamespace(
        platforms={
            Platform.WECOM: PlatformConfig(
                enabled=True,
                extra={"bot_id": "persisted-user-config-must-not-start"},
            )
        }
    )
    runner = asyncio.run(
        web_server._start_desktop_wecom_gateway_runner(
            app,
            config_loader=lambda: config,
            runner_factory=FakeRunner,
        )
    )

    assert runner is app.state.desktop_wecom_gateway_runner
    assert observed["platforms"] == {}


def test_enterprise_runtime_token_is_independent_and_constant_time_checked():
    request = SimpleNamespace(
        app=SimpleNamespace(
            state=SimpleNamespace(enterprise_runtime_control_token="child-only-token")
        ),
        headers={"X-Hermes-Enterprise-Runtime-Token": "child-only-token"},
    )
    assert web_server._has_valid_enterprise_runtime_token(request) is True

    request.headers["X-Hermes-Enterprise-Runtime-Token"] = "dashboard-token"
    assert web_server._has_valid_enterprise_runtime_token(request) is False


def test_enterprise_runtime_route_never_falls_through_oauth_bypass(monkeypatch):
    monkeypatch.setenv("HERMES_DESKTOP", "1")
    request = SimpleNamespace(
        url=SimpleNamespace(path="/api/enterprise/wecom/status"),
        app=SimpleNamespace(
            state=SimpleNamespace(
                auth_required=True,
                enterprise_runtime_control_token="child-only-token",
            )
        ),
        headers={},
    )
    call_next = SimpleNamespace()

    response = asyncio.run(web_server.auth_middleware(request, call_next))

    assert response.status_code == 401


def test_enterprise_runtime_attach_returns_credential_free_status():
    class FakeRunner:
        def __init__(self):
            self.runtime = None

        async def attach_enterprise_wecom(self, runtime):
            self.runtime = runtime

        def enterprise_wecom_status(self):
            return {
                "state": "connected",
                "bindingId": "11111111-1111-4111-8111-111111111111",
                "connected": True,
                "errorCode": None,
                "errorMessage": None,
            }

    runner = FakeRunner()

    class Request:
        app = SimpleNamespace(
            state=SimpleNamespace(desktop_wecom_gateway_runner=runner)
        )

        async def json(self):
            return {
                "contractVersion": "enterprise-wecom-runtime-control.v1",
                "bindingId": "11111111-1111-4111-8111-111111111111",
                "corpId": "corp",
                "botId": "bot-7",
                "secret": "bot-secret",
                "gatewayBaseUrl": "https://gateway.example.test",
                "gatewayServiceToken": "service-token",
                "identityContractVersion": "wecom-channel-identity.v1",
                "identityProofVersion": "hermes-channel-identity-v2",
            }

    result = asyncio.run(web_server.enterprise_wecom_attach(Request()))

    assert runner.runtime["secret"] == "bot-secret"
    assert runner.runtime["gateway_service_token"] == "service-token"
    assert result == {
        "contractVersion": "enterprise-wecom-runtime-control.v1",
        "state": "connected",
        "bindingId": "11111111-1111-4111-8111-111111111111",
        "connected": True,
        "errorCode": None,
        "errorMessage": None,
    }
    assert "secret" not in result
    assert "gatewayServiceToken" not in result


def test_session_api_does_not_expose_raw_wecom_channel_user_id(monkeypatch):
    class FakeDB:
        def list_sessions_rich(self, **kwargs):
            return [
                {
                    "id": "wecom-session",
                    "source": "wecom",
                    "user_id": "opaque-channel-user",
                    "channel_identity_label": "贝佳豪",
                    "started_at": 1.0,
                    "ended_at": None,
                    "archived": 0,
                },
                {
                    "id": "cli-session",
                    "source": "cli",
                    "user_id": "local-user",
                    "started_at": 1.0,
                    "ended_at": None,
                    "archived": 0,
                },
            ]

        def session_count(self, **kwargs):
            return 2

        def close(self):
            return None

    monkeypatch.setattr(web_server, "_open_session_db_for_profile", lambda profile: FakeDB())

    response = asyncio.run(web_server.get_sessions())

    wecom, cli = response["sessions"]
    assert "user_id" not in wecom
    assert wecom["channel_identity_label"] == "贝佳豪"
    assert cli["user_id"] == "local-user"


def test_web_lifespan_brackets_gateway_runner_lifecycle(monkeypatch):
    app = _app()
    calls = []

    async def start(target):
        calls.append(("start", target))

    async def stop(target):
        calls.append(("stop", target))

    monkeypatch.delenv("HERMES_DESKTOP", raising=False)
    monkeypatch.setattr(web_server, "_start_desktop_wecom_gateway_runner", start)
    monkeypatch.setattr(web_server, "_stop_desktop_wecom_gateway_runner", stop)

    async def scenario():
        async with web_server._lifespan(app):
            calls.append(("inside", app))

    asyncio.run(scenario())
    assert calls == [("start", app), ("inside", app), ("stop", app)]
