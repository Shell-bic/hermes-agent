import asyncio
from collections import OrderedDict
from types import SimpleNamespace

from gateway.config import Platform
from gateway.run import GatewayRunner
from gateway.session import SessionSource
from gateway.platforms.base import SendResult


class _SessionStore:
    def __init__(self, entry):
        self.entry = entry

    def lookup_by_session_id(self, session_id):
        return self.entry if session_id == "stored-session" else None


class _Adapter:
    def __init__(self):
        self.calls = []

    async def send(self, chat_id, text, metadata=None):
        self.calls.append((chat_id, text, metadata))
        return SendResult(success=True, message_id="reply-1")


def _runner(source):
    runner = GatewayRunner.__new__(GatewayRunner)
    runner.session_store = _SessionStore(SimpleNamespace(origin=source))
    runner._desktop_session_changed_callback = None
    runner._desktop_session_event_callback = None
    runner._desktop_wecom_delivery_keys = OrderedDict()
    runner._startup_auto_resume_enabled = True
    adapter = _Adapter()
    runner.adapters = {Platform.WECOM: adapter}
    runner._thread_metadata_for_source = lambda resolved: {"source": resolved.platform.value}
    return runner, adapter


def test_desktop_hosted_runtime_can_disable_synthetic_auto_resume():
    source = SessionSource(platform=Platform.WECOM, chat_id="wecom-chat")
    runner, _ = _runner(source)

    runner.set_startup_auto_resume_enabled(False)

    assert runner._schedule_resume_pending_sessions() == 0


def test_desktop_live_events_are_wecom_only_and_payloads_are_copied():
    wecom_source = SessionSource(platform=Platform.WECOM, chat_id="wecom-chat")
    telegram_source = SessionSource(platform=Platform.TELEGRAM, chat_id="telegram-chat")
    runner, _ = _runner(wecom_source)
    received = []

    async def notify(event_type, session_id, payload):
        payload["mutated_by_sink"] = True
        received.append((event_type, session_id, payload))

    runner.set_desktop_session_event_callback(notify)
    original = {"channel": "wecom", "text": "partial"}

    async def scenario():
        await runner._notify_desktop_session_event(
            "message.delta",
            "stored-session",
            original,
            source=wecom_source,
        )
        await runner._notify_desktop_session_event(
            "message.delta",
            "stored-session",
            {"text": "must-not-leak"},
            source=telegram_source,
        )

    asyncio.run(scenario())

    assert received == [
        (
            "message.delta",
            "stored-session",
            {"channel": "wecom", "text": "partial", "mutated_by_sink": True},
        )
    ]
    assert original == {"channel": "wecom", "text": "partial"}


def test_desktop_final_uses_stored_source_and_is_idempotent():
    source = SessionSource(
        platform=Platform.WECOM,
        chat_id="stored-chat-target",
        user_id="owner",
    )
    runner, adapter = _runner(source)
    changed = []

    async def notify(session_id, reason):
        changed.append((session_id, reason))

    runner.set_desktop_session_changed_callback(notify)

    async def scenario():
        assert await runner.deliver_desktop_wecom_reply(
            session_id="stored-session",
            text="final only",
            idempotency_key="turn-7",
        )
        assert await runner.deliver_desktop_wecom_reply(
            session_id="stored-session",
            text="must not send twice",
            idempotency_key="turn-7",
        )

    asyncio.run(scenario())

    assert adapter.calls == [
        ("stored-chat-target", "final only", {"source": "wecom"})
    ]
    assert changed == [("stored-session", "desktop-final-delivered")]


def test_desktop_final_rejects_non_wecom_and_unknown_sessions():
    source = SessionSource(platform=Platform.TELEGRAM, chat_id="not-wecom")
    runner, adapter = _runner(source)

    async def scenario():
        assert not await runner.deliver_desktop_wecom_reply(
            session_id="stored-session",
            text="no",
            idempotency_key="turn-1",
        )
        assert not await runner.deliver_desktop_wecom_reply(
            session_id="renderer-selected-chat",
            text="no",
            idempotency_key="turn-2",
        )

    asyncio.run(scenario())
    assert adapter.calls == []
