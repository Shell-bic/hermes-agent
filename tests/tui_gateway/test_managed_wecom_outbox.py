import json

import pytest

from hermes_state import SessionDB
from tui_gateway import server


def test_managed_source_context_requires_main_process_authorization(monkeypatch):
    monkeypatch.setenv("COMPANY_GATEWAY_TOKEN", "gw_runtime_only")
    context = {
        "source_context": {
            "binding_id": "11234567-89ab-4def-8abc-0123456789ab",
            "conversation_id": "conversation-1",
            "source": "wecom",
        }
    }

    with pytest.raises(ValueError, match="authorization required"):
        server._managed_wecom_source_context(context)

    context["source_authorization"] = "gw_runtime_only"
    assert server._managed_wecom_source_context(context) == context["source_context"]


def test_managed_wecom_source_metadata_persists_in_session_db(tmp_path):
    db = SessionDB(db_path=tmp_path / "state.db")
    try:
        db.create_session(
            "session-1",
            source="wecom",
            source_instance_id="11234567-89ab-4def-8abc-0123456789ab",
            conversation_id="conversation-1",
        )

        row = db.get_session("session-1")

        assert row["source"] == "wecom"
        assert row["source_instance_id"] == "11234567-89ab-4def-8abc-0123456789ab"
        assert row["conversation_id"] == "conversation-1"
    finally:
        db.close()


def test_history_mismatch_never_queues_unpersisted_manual_final():
    session = {"wecom_manual_outbox_pending": True}

    assert not server._consume_wecom_manual_outbox_pending(
        session, status="complete", history_persisted=False
    )
    assert "wecom_manual_outbox_pending" not in session

    session["wecom_manual_outbox_pending"] = True
    assert server._consume_wecom_manual_outbox_pending(
        session, status="complete", history_persisted=True
    )


def test_manual_final_is_atomically_queued_without_credentials(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "get_hermes_home", lambda: tmp_path)
    session = {
        "session_key": "agent:main:wecom:instance:binding:conversation:one:dm:one",
        "source": "wecom",
        "source_context": {
            "binding_id": "11234567-89ab-4def-8abc-0123456789ab",
            "conversation_id": "conversation-1",
            "source": "wecom",
        },
    }

    server._queue_wecom_manual_final(session, "最终回复")

    files = list((tmp_path / "wecom-composer-outbox").glob("*.json"))
    assert len(files) == 1
    payload = json.loads(files[0].read_text(encoding="utf-8"))
    assert payload["conversationId"] == "conversation-1"
    assert payload["text"] == "最终回复"
    assert "secret" not in json.dumps(payload).lower()
    assert "token" not in json.dumps(payload).lower()


def test_experiment_manual_final_uses_stored_session_not_remote_target(monkeypatch):
    calls = []
    monkeypatch.setattr(
        "gateway.run.deliver_desktop_wecom_reply_from_worker",
        lambda session_id, text, idempotency_key: calls.append(
            (session_id, text, idempotency_key)
        ) or True,
    )
    session = {
        "history_version": 8,
        "session_key": "stored-session",
        "source": "wecom",
        "source_context": {
            "binding_id": "renderer-cannot-route-with-this",
            "conversation_id": "renderer-cannot-route-with-this",
            "source": "wecom",
        },
    }

    assert server._deliver_wecom_manual_final(session, "最终回复")
    assert calls == [
        ("stored-session", "最终回复", "desktop-final:stored-session:8")
    ]
