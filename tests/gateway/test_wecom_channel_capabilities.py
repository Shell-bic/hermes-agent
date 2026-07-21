"""Narrow capability contract for the original WeCom WebSocket adapter.

These tests intentionally exercise the existing Hermes channel adapter rather
than the enterprise relay.  They document the branch experiment's reuse
boundary: normalize inbound DM/group media, upload native outbound media, and
self-heal transient text/connection failures without duplicating the protocol.
"""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from gateway.config import PlatformConfig
from gateway.platforms.base import MessageType, SendResult


class TestInboundChannelCapabilities:
    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        ("body", "cached", "expected_chat_type", "expected_type", "expected_text"),
        [
            (
                {
                    "msgid": "dm-image-1",
                    "chattype": "single",
                    "from": {"userid": "owner-1"},
                    "msgtype": "image",
                    "image": {"url": "https://example.invalid/photo.png"},
                },
                ("C:/cache/photo.png", "image/png"),
                "dm",
                MessageType.PHOTO,
                "",
            ),
            (
                {
                    "msgid": "group-file-1",
                    "chatid": "group-1",
                    "chattype": "group",
                    "from": {"userid": "member-1"},
                    "msgtype": "file",
                    "file": {"url": "https://example.invalid/report.pdf"},
                },
                ("C:/cache/report.pdf", "application/pdf"),
                "group",
                MessageType.DOCUMENT,
                "",
            ),
        ],
    )
    async def test_dm_image_and_group_file_are_normalized_for_gateway(
        self,
        body,
        cached,
        expected_chat_type,
        expected_type,
        expected_text,
    ):
        from gateway.platforms.wecom import WeComAdapter

        adapter = WeComAdapter(PlatformConfig(enabled=True))
        adapter._text_batch_delay_seconds = 0
        adapter._cache_media = AsyncMock(return_value=cached)
        adapter.handle_message = AsyncMock()

        await adapter._on_message(
            {
                "cmd": "aibot_msg_callback",
                "headers": {"req_id": f"req-{body['msgid']}"},
                "body": body,
            }
        )

        adapter.handle_message.assert_awaited_once()
        event = adapter.handle_message.await_args.args[0]
        assert event.source.chat_type == expected_chat_type
        assert event.message_type == expected_type
        assert event.text == expected_text
        assert event.media_urls == [cached[0]]
        assert event.media_types == [cached[1]]


class TestOutboundChannelCapabilities:
    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        ("method_name", "source", "final_type"),
        [
            ("send_image_file", "C:/output/photo.png", "image"),
            ("send_document", "C:/output/report.pdf", "file"),
        ],
    )
    async def test_image_and_document_use_native_upload_pipeline(
        self,
        method_name,
        source,
        final_type,
    ):
        from gateway.platforms.wecom import WeComAdapter

        adapter = WeComAdapter(PlatformConfig(enabled=True))
        adapter._prepare_outbound_media = AsyncMock(
            return_value={
                "data": b"payload",
                "content_type": "image/png" if final_type == "image" else "application/pdf",
                "file_name": source.rsplit("/", 1)[-1],
                "detected_type": final_type,
                "final_type": final_type,
                "rejected": False,
                "reject_reason": None,
                "downgraded": False,
                "downgrade_note": None,
            }
        )
        adapter._upload_media_bytes = AsyncMock(
            return_value={"media_id": f"media-{final_type}", "type": final_type}
        )
        adapter._send_media_message = AsyncMock(
            return_value={"headers": {"req_id": f"sent-{final_type}"}, "errcode": 0}
        )

        result = await getattr(adapter, method_name)("chat-1", source)

        assert result.success is True
        adapter._upload_media_bytes.assert_awaited_once_with(
            b"payload",
            final_type,
            source.rsplit("/", 1)[-1],
        )
        adapter._send_media_message.assert_awaited_once_with(
            "chat-1",
            final_type,
            f"media-{final_type}",
        )


class TestFailureRecoveryCapabilities:
    @pytest.mark.asyncio
    async def test_transient_text_delivery_uses_base_retry_contract(self):
        from gateway.platforms.wecom import WeComAdapter

        adapter = WeComAdapter(PlatformConfig(enabled=True))
        adapter.send = AsyncMock(
            side_effect=[
                SendResult(success=False, error="connection reset", retryable=True),
                SendResult(success=True, message_id="sent-on-retry"),
            ]
        )

        with patch("gateway.platforms.base.asyncio.sleep", new=AsyncMock()):
            result = await adapter._send_with_retry(
                "chat-1",
                "hello",
                max_retries=1,
                base_delay=0,
            )

        assert result.success is True
        assert result.message_id == "sent-on-retry"
        assert adapter.send.await_count == 2

    @pytest.mark.asyncio
    async def test_live_websocket_loop_reconnects_after_transient_failure(self):
        from gateway.platforms.wecom import WeComAdapter

        adapter = WeComAdapter(PlatformConfig(enabled=True))
        adapter._running = True
        reads = 0

        async def read_events():
            nonlocal reads
            reads += 1
            if reads == 1:
                raise RuntimeError("temporary websocket loss")
            adapter._running = False

        adapter._read_events = read_events
        adapter._open_connection = AsyncMock()
        adapter._mark_connected = MagicMock()

        with patch("gateway.platforms.wecom.asyncio.sleep", new=AsyncMock()):
            await adapter._listen_loop()

        adapter._open_connection.assert_awaited_once()
        adapter._mark_connected.assert_called_once()
        assert reads == 2

    @pytest.mark.asyncio
    async def test_native_media_failure_is_reported_without_implicit_reupload(self):
        """Document the current boundary: media upload is not auto-retried."""
        from gateway.platforms.wecom import WeComAdapter

        adapter = WeComAdapter(PlatformConfig(enabled=True))
        adapter._prepare_outbound_media = AsyncMock(
            return_value={
                "data": b"payload",
                "content_type": "application/pdf",
                "file_name": "report.pdf",
                "detected_type": "file",
                "final_type": "file",
                "rejected": False,
                "reject_reason": None,
                "downgraded": False,
                "downgrade_note": None,
            }
        )
        adapter._upload_media_bytes = AsyncMock(side_effect=ConnectionError("socket closed"))

        result = await adapter.send_document("chat-1", "C:/output/report.pdf")

        assert result.success is False
        assert "socket closed" in (result.error or "")
        adapter._upload_media_bytes.assert_awaited_once()
