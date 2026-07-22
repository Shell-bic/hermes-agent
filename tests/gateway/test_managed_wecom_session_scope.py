from gateway.config import Platform
from gateway.session import (
    SessionSource,
    build_session_context,
    build_session_context_prompt,
    build_session_key,
)
from gateway.config import GatewayConfig
from hermes_state import SessionDB


def test_managed_wecom_binding_and_conversation_isolate_session_key():
    first = SessionSource(
        platform=Platform.WECOM,
        chat_id="same-user",
        user_id="same-user",
        binding_id="binding-a",
        source_instance_id="binding-a",
        conversation_id="conversation/one",
    )
    second = SessionSource(
        platform=Platform.WECOM,
        chat_id="same-user",
        user_id="same-user",
        binding_id="binding-b",
        source_instance_id="binding-b",
        conversation_id="conversation/one",
    )

    assert build_session_key(first) != build_session_key(second)
    assert "conversation%2Fone" in build_session_key(first)


def test_managed_scope_round_trips_with_session_source_metadata():
    source = SessionSource(
        platform=Platform.WECOM,
        chat_id="owner",
        binding_id="binding-a",
        source_instance_id="binding-a",
        conversation_id="conversation-a",
    )

    restored = SessionSource.from_dict(source.to_dict())

    assert restored.binding_id == "binding-a"
    assert restored.source_instance_id == "binding-a"
    assert restored.conversation_id == "conversation-a"


def test_unmanaged_wecom_session_key_is_backward_compatible():
    source = SessionSource(platform=Platform.WECOM, chat_id="owner", user_id="owner")

    assert build_session_key(source) == "agent:main:wecom:dm:owner"


def test_managed_group_forces_per_user_isolation_over_global_shared_setting():
    first = SessionSource(
        platform=Platform.WECOM,
        chat_type="group",
        chat_id="group-a",
        user_id="member-a",
        source_instance_id="binding-a",
        conversation_id="group-a",
        force_group_sessions_per_user=True,
    )
    second = SessionSource.from_dict({**first.to_dict(), "user_id": "member-b"})

    assert build_session_key(first, group_sessions_per_user=False) != build_session_key(
        second, group_sessions_per_user=False
    )


def test_managed_group_identity_prompt_is_safe_because_session_is_per_user():
    source = SessionSource(
        platform=Platform.WECOM,
        chat_type="group",
        chat_id="group-a",
        user_id="member-a",
        user_name="member-a",
        source_instance_id="binding-a",
        conversation_id="group-a",
        channel_identity_status="mapped",
        channel_identity_label="贝佳豪",
        channel_identity_match_scope="exact",
        force_group_sessions_per_user=True,
    )

    context = build_session_context(
        source,
        GatewayConfig(group_sessions_per_user=False),
    )
    prompt = build_session_context_prompt(context)

    assert context.shared_multi_user_session is False
    assert 'Display name: "贝佳豪"' in prompt


def test_channel_identity_labels_persist_in_rich_session_rows(tmp_path):
    db = SessionDB(db_path=tmp_path / "state.db")
    try:
        db.create_session(
            "managed-session",
            "wecom",
            user_id="opaque-channel-user",
            source_instance_id="binding-a",
            conversation_id="group-a",
            channel_identity_status="mapped",
            channel_identity_label="贝佳豪",
            channel_identity_match_scope="exact",
        )

        row = db.list_sessions_rich()[0]

        assert row["user_id"] == "opaque-channel-user"
        assert row["source_instance_id"] == "binding-a"
        assert row["conversation_id"] == "group-a"
        assert row["channel_identity_status"] == "mapped"
        assert row["channel_identity_label"] == "贝佳豪"
        assert row["channel_identity_match_scope"] == "exact"
    finally:
        db.close()


def test_compression_projection_uses_tip_channel_identity_metadata(tmp_path):
    db = SessionDB(db_path=tmp_path / "state.db")
    try:
        db.create_session(
            "root",
            "wecom",
            source_instance_id="binding-a",
            conversation_id="group-a",
            channel_identity_status="unknown",
        )
        db._conn.execute(
            "UPDATE sessions SET ended_at=100, end_reason='compression', started_at=10 WHERE id='root'"
        )
        db.create_session(
            "tip",
            "wecom",
            parent_session_id="root",
            source_instance_id="binding-a",
            conversation_id="group-a",
            channel_identity_status="mapped",
            channel_identity_label="贝佳豪",
            channel_identity_match_scope="exact",
        )
        db._conn.execute("UPDATE sessions SET started_at=101 WHERE id='tip'")
        db._conn.commit()

        row = db.list_sessions_rich(source="wecom")[0]

        assert row["id"] == "tip"
        assert row["channel_identity_status"] == "mapped"
        assert row["channel_identity_label"] == "贝佳豪"
        assert row["channel_identity_match_scope"] == "exact"
    finally:
        db.close()
