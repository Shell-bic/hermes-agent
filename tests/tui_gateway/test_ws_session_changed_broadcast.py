import asyncio

from tui_gateway import ws


class _Transport:
    def __init__(self):
        self._closed = False
        self.frames = []

    async def write_async(self, frame):
        self.frames.append(frame)
        return True


def test_session_changed_broadcast_is_an_invalidation_not_a_message_dto(monkeypatch):
    transport = _Transport()
    monkeypatch.setattr(ws, "_active_transports", {transport})

    delivered = asyncio.run(
        ws.broadcast_event(
            "session.changed",
            payload={
                "reason": "channel-turn-persisted",
                "stored_session_id": "stored-session",
            },
        )
    )

    assert delivered == 1
    assert transport.frames == [
        {
            "jsonrpc": "2.0",
            "method": "event",
            "params": {
                "type": "session.changed",
                "session_id": "",
                "payload": {
                    "reason": "channel-turn-persisted",
                    "stored_session_id": "stored-session",
                },
            },
        }
    ]
    serialized = str(transport.frames[0]).lower()
    assert "chat_id" not in serialized
    assert "text" not in serialized
    assert "secret" not in serialized
