"""Tests for tui_gateway JSON-RPC protocol plumbing."""

import io
import json
import sys
import threading
import time
import types
from unittest.mock import MagicMock, patch

import pytest

_original_stdout = sys.stdout


@pytest.fixture(autouse=True)
def _restore_stdout():
    yield
    sys.stdout = _original_stdout


@pytest.fixture()
def server():
    with patch.dict("sys.modules", {
        "hermes_constants": MagicMock(get_hermes_home=MagicMock(return_value="/tmp/hermes_test")),
        "hermes_cli.env_loader": MagicMock(),
        "hermes_cli.banner": MagicMock(),
        "hermes_state": MagicMock(),
    }):
        import importlib
        mod = importlib.import_module("tui_gateway.server")
        yield mod
        # Reset module-level session state without re-importing. importlib.reload
        # would re-register the module's atexit hooks (ThreadPoolExecutor
        # shutdown, _shutdown_sessions); the duplicates race the stderr
        # buffer at interpreter shutdown and surface as Fatal Python error:
        # _enter_buffered_busy. Clearing the per-session dicts gives the
        # next test a clean slate; _methods is NOT cleared because it's
        # populated at module import time and re-registration only happens
        # via reload (which we don't do).
        mod._sessions.clear()
        mod._pending.clear()
        mod._answers.clear()


@pytest.fixture()
def capture(server):
    """Redirect server's real stdout to a StringIO and return (server, buf)."""
    buf = io.StringIO()
    server._real_stdout = buf
    return server, buf


# ── JSON-RPC envelope ────────────────────────────────────────────────


def test_unknown_method(server):
    resp = server.handle_request({"id": "1", "method": "bogus"})
    assert resp["error"]["code"] == -32601


def test_ok_envelope(server):
    assert server._ok("r1", {"x": 1}) == {
        "jsonrpc": "2.0", "id": "r1", "result": {"x": 1},
    }


def test_err_envelope(server):
    assert server._err("r2", 4001, "nope") == {
        "jsonrpc": "2.0", "id": "r2", "error": {"code": 4001, "message": "nope"},
    }


# ── write_json ───────────────────────────────────────────────────────


def test_write_json(capture):
    server, buf = capture
    assert server.write_json({"test": True})
    assert json.loads(buf.getvalue()) == {"test": True}


def test_write_json_broken_pipe(server):
    class _Broken:
        def write(self, _): raise BrokenPipeError
        def flush(self): raise BrokenPipeError

    server._real_stdout = _Broken()
    assert server.write_json({"x": 1}) is False


def test_write_json_closed_stream_returns_false(server):
    """ValueError ('I/O on closed file') used to bubble up; treat as gone."""

    class _Closed:
        def write(self, _): raise ValueError("I/O operation on closed file")
        def flush(self): raise ValueError("I/O operation on closed file")

    server._real_stdout = _Closed()
    assert server.write_json({"x": 1}) is False


def test_write_json_unicode_encode_error_re_raises(server):
    """A non-UTF-8 stdout encoding raises UnicodeEncodeError (a ValueError
    subclass).  It must NOT be swallowed as 'peer gone' — that would let
    `entry.py` exit cleanly via the False path and hide the real config
    bug.  We re-raise so the existing crash-log infrastructure records it."""

    class _AsciiOnly:
        def write(self, line):
            line.encode("ascii")  # raises UnicodeEncodeError on non-ascii
        def flush(self): pass

    server._real_stdout = _AsciiOnly()
    with pytest.raises(UnicodeEncodeError):
        server.write_json({"msg": "héllo"})


def test_write_json_unrelated_value_error_re_raises(server):
    """Only ValueError('...closed file...') means peer gone.  Other
    ValueErrors are programming errors and must surface."""

    class _BadValue:
        def write(self, _): raise ValueError("something else entirely")
        def flush(self): pass

    server._real_stdout = _BadValue()
    with pytest.raises(ValueError, match="something else entirely"):
        server.write_json({"x": 1})


def test_write_json_non_serializable_payload_re_raises(server):
    """Non-JSON-safe payloads are programming errors — they must NOT be
    silently dropped via the False path (which would trigger a clean exit
    in entry.py and mask the real bug)."""
    import io

    server._real_stdout = io.StringIO()
    with pytest.raises(TypeError):
        server.write_json({"obj": object()})


def test_write_json_peer_gone_oserror_on_flush_returns_false(server):
    """A flush that raises a peer-gone OSError (EPIPE) must not strand
    the lock or crash; it returns False so the dispatcher exits cleanly."""
    import errno

    written = []

    class _FlushPeerGone:
        def write(self, line): written.append(line)
        def flush(self): raise OSError(errno.EPIPE, "broken pipe")

    server._real_stdout = _FlushPeerGone()
    assert server.write_json({"x": 1}) is False
    assert written and json.loads(written[0]) == {"x": 1}


def test_write_json_non_peer_gone_oserror_re_raises(server):
    """Host I/O failures (ENOSPC, EACCES, EIO …) are NOT peer-gone — they
    must re-raise so the crash log records them instead of looking like
    a clean disconnect via the False path."""
    import errno

    class _DiskFull:
        def write(self, _): raise OSError(errno.ENOSPC, "no space left")
        def flush(self): pass

    server._real_stdout = _DiskFull()
    with pytest.raises(OSError, match="no space"):
        server.write_json({"x": 1})


def test_write_json_skips_flush_when_disable_flush_true(monkeypatch):
    """`StdioTransport` skips flush when `_DISABLE_FLUSH` is true.

    Tests the runtime *behaviour* via direct module-attr patch.  The env
    var → module constant wiring is covered by the dedicated env test
    below; reloading server.py here would re-register atexit hooks and
    recreate the worker pool.
    """
    import importlib

    transport_mod = importlib.import_module("tui_gateway.transport")
    monkeypatch.setattr(transport_mod, "_DISABLE_FLUSH", True)

    flushed = {"count": 0}
    written = []

    class _Stream:
        def write(self, line): written.append(line)
        def flush(self): flushed["count"] += 1

    stream = _Stream()
    transport = transport_mod.StdioTransport(lambda: stream, threading.Lock())

    assert transport.write({"x": 1}) is True
    assert flushed["count"] == 0


def test_disable_flush_env_var_actually_wires_to_module_constant(monkeypatch):
    """End-to-end: setting `HERMES_TUI_GATEWAY_NO_FLUSH=1` and importing
    `tui_gateway.transport` fresh actually flips `_DISABLE_FLUSH` true.

    Reloads only the transport module — server.py is untouched so its
    atexit hooks/worker pool stay intact."""
    import importlib

    monkeypatch.setenv("HERMES_TUI_GATEWAY_NO_FLUSH", "1")
    transport_mod = importlib.reload(importlib.import_module("tui_gateway.transport"))

    try:
        assert transport_mod._DISABLE_FLUSH is True
    finally:
        # Restore the env-disabled state so other tests see the default.
        monkeypatch.delenv("HERMES_TUI_GATEWAY_NO_FLUSH", raising=False)
        importlib.reload(transport_mod)


# ── _emit ────────────────────────────────────────────────────────────


def test_emit_with_payload(capture):
    server, buf = capture
    server._emit("test.event", "s1", {"key": "val"})
    msg = json.loads(buf.getvalue())

    assert msg["method"] == "event"
    assert msg["params"]["type"] == "test.event"
    assert msg["params"]["session_id"] == "s1"
    assert msg["params"]["payload"]["key"] == "val"


def test_emit_without_payload(capture):
    server, buf = capture
    server._emit("ping", "s2")

    assert "payload" not in json.loads(buf.getvalue())["params"]


# ── Blocking prompt round-trip ───────────────────────────────────────


def test_block_and_respond(capture):
    server, _ = capture
    result = [None]

    threading.Thread(
        target=lambda: result.__setitem__(0, server._block("test.prompt", "s1", {"q": "?"}, timeout=5)),
    ).start()

    for _ in range(100):
        if server._pending:
            break
        threading.Event().wait(0.01)

    rid = next(iter(server._pending))
    server._answers[rid] = "my_answer"
    # _pending values are (sid, Event) tuples — unpack to set the Event
    _, ev = server._pending[rid]
    ev.set()

    threading.Event().wait(0.1)
    assert result[0] == "my_answer"


def test_clear_pending(server):
    ev = threading.Event()
    # _pending values are (sid, Event) tuples
    server._pending["r1"] = ("sid-x", ev)
    server._clear_pending()

    assert ev.is_set()
    assert server._answers["r1"] == ""


# ── Session lookup ───────────────────────────────────────────────────


def test_sess_missing(server):
    _, err = server._sess({"session_id": "nope"}, "r1")
    assert err["error"]["code"] == 4001


def test_sess_found(server):
    server._sessions["abc"] = {"agent": MagicMock()}
    s, err = server._sess({"session_id": "abc"}, "r1")

    assert s is not None
    assert err is None


# ── session.resume payload ────────────────────────────────────────────


def test_session_resume_returns_hydrated_messages(server, monkeypatch):
    class _DB:
        def get_session(self, _sid):
            return {"id": "20260409_010101_abc123"}

        def get_session_by_title(self, _title):
            return None

        def reopen_session(self, _sid):
            return None

        def get_messages_as_conversation(self, _sid, include_ancestors=False):
            return [
                {"role": "user", "content": "hello"},
                {"role": "assistant", "content": "yo", "reasoning": "thoughts"},
                {"role": "tool", "content": "searched"},
                {"role": "assistant", "content": "   "},
                {"role": "assistant", "content": None},
                {"role": "narrator", "content": "skip"},
            ]

    monkeypatch.setattr(server, "_get_db", lambda: _DB())
    monkeypatch.setattr(server, "_make_agent", lambda sid, key, session_id=None, session_db=None: object())
    monkeypatch.setattr(server, "_init_session", lambda sid, key, agent, history, cols=80, **_kwargs: None)
    monkeypatch.setattr(server, "_session_info", lambda _agent, _session=None: {"model": "test/model"})

    resp = server.handle_request(
        {
            "id": "r1",
            "method": "session.resume",
            "params": {"session_id": "20260409_010101_abc123", "cols": 100},
        }
    )

    assert "error" not in resp
    assert resp["result"]["message_count"] == 3
    assert resp["result"]["messages"] == [
        {"role": "user", "text": "hello"},
        {"role": "assistant", "text": "yo", "reasoning": "thoughts"},
        {"role": "tool", "name": "tool", "context": ""},
    ]


def test_session_resume_handles_multimodal_list_content(server, monkeypatch):
    """A user message persisted with list-shaped multimodal content used to
    crash session resume with ``'list' object has no attribute 'strip'``."""

    multimodal_user = {
        "role": "user",
        "content": [
            {"type": "text", "text": "describe this"},
            {
                "type": "image_url",
                "image_url": {"url": "data:image/png;base64,AAAA"},
            },
        ],
    }
    text_only_assistant = {"role": "assistant", "content": "ok"}

    class _DB:
        def get_session(self, _sid):
            return {"id": "20260502_000000_listcontent"}

        def get_session_by_title(self, _title):
            return None

        def reopen_session(self, _sid):
            return None

        def get_messages_as_conversation(self, _sid, include_ancestors=False):
            return [multimodal_user, text_only_assistant]

    monkeypatch.setattr(server, "_get_db", lambda: _DB())
    monkeypatch.setattr(server, "_make_agent", lambda sid, key, session_id=None, session_db=None: object())
    monkeypatch.setattr(server, "_init_session", lambda sid, key, agent, history, cols=80, **_kwargs: None)
    monkeypatch.setattr(server, "_session_info", lambda _agent, _session=None: {"model": "test/model"})

    resp = server.handle_request(
        {
            "id": "r1",
            "method": "session.resume",
            "params": {"session_id": "20260502_000000_listcontent", "cols": 100},
        }
    )

    assert "error" not in resp
    assert resp["result"]["message_count"] == 2
    # The image_url part is preserved as a raw data URL inside the text so
    # the desktop renderer (which extracts embedded images) sees the same
    # content the optimistic local cache returns. Otherwise the inline
    # image flashes during initial cache hydration and then vanishes when
    # the resume payload overwrites it with cleaned text.
    assert resp["result"]["messages"] == [
        {
            "role": "user",
            "text": "describe this\ndata:image/png;base64,AAAA",
        },
        {"role": "assistant", "text": "ok"},
    ]


def test_session_resume_lazy_registers_watch_session_without_agent(server, monkeypatch):
    """``lazy: true`` (subagent watch windows) must register the live session
    — keyed for the child mirror, on this transport — WITHOUT building an
    agent. The eager build is what made opening a subagent window contend
    with the already-running parent turn."""

    target = "20260612_000000_child99"

    class _DB:
        def get_session(self, _sid):
            return {"id": target}

        def get_session_by_title(self, _title):
            return None

        def reopen_session(self, _sid):
            return None

        def get_messages_as_conversation(self, _sid, include_ancestors=False):
            return [
                {"role": "user", "content": "delegated goal"},
            ]

    def _boom(*_args, **_kwargs):
        raise AssertionError("lazy resume must not build an agent")

    monkeypatch.setattr(server, "_get_db", lambda: _DB())
    monkeypatch.setattr(server, "_make_agent", _boom)

    resp = server.handle_request(
        {
            "id": "r1",
            "method": "session.resume",
            "params": {"session_id": target, "cols": 100, "lazy": True},
        }
    )

    assert "error" not in resp
    result = resp["result"]
    assert result["resumed"] == target
    assert result["session_key"] == target
    assert result["info"]["lazy"] is True
    assert result["info"]["desktop_contract"] == server.DESKTOP_BACKEND_CONTRACT
    assert result["messages"] == [{"role": "user", "text": "delegated goal"}]

    sid = result["session_id"]
    session = server._sessions[sid]
    assert session["agent"] is None
    # The child mirror finds the watch window by stored key.
    assert server._find_live_session_by_key(target) == (sid, session)
    # A later prompt.submit upgrade must continue THIS stored conversation.
    assert session["resume_session_id"] == target
    # No build started: the idle reaper must still be able to evict it, and
    # the live status must not report a never-ending "starting".
    assert not session["agent_ready"].is_set()
    assert server._session_live_status(sid, session) != "starting"
    session["transport"] = server._detached_ws_transport
    far_future = time.time() + 999999
    assert server._session_is_evictable(sid, session, far_future)

    # Resuming again (window refresh) reuses the same live session.
    resp2 = server.handle_request(
        {
            "id": "r2",
            "method": "session.resume",
            "params": {"session_id": target, "cols": 100, "lazy": True},
        }
    )
    assert "error" not in resp2
    assert resp2["result"]["session_id"] == sid
    assert len(server._sessions) == 1


def test_session_resume_lazy_reports_running_for_inflight_child(server, monkeypatch):
    """A watch window attaching to a child mid-delegation must learn the run is
    live from the resume response itself — the child can sit silent inside a
    long tool call, so waiting for the next stream event leaves the window
    looking dead."""

    target = "20260612_000000_child42"

    class _DB:
        def get_session(self, _sid):
            return {"id": target}

        def get_session_by_title(self, _title):
            return None

        def reopen_session(self, _sid):
            return None

        def get_messages_as_conversation(self, _sid, include_ancestors=False):
            return [{"role": "user", "content": "delegated goal"}]

    monkeypatch.setattr(server, "_get_db", lambda: _DB())
    monkeypatch.setattr(
        server, "_make_agent", lambda *a, **k: (_ for _ in ()).throw(AssertionError("no build"))
    )
    server._active_child_runs[target] = time.time()
    try:
        resp = server.handle_request(
            {
                "id": "r1",
                "method": "session.resume",
                "params": {"session_id": target, "cols": 100, "lazy": True},
            }
        )
    finally:
        server._active_child_runs.pop(target, None)

    assert "error" not in resp
    assert resp["result"]["running"] is True
    assert resp["result"]["status"] == "streaming"


def test_session_resume_lazy_tolerates_missing_row_for_active_child(server, monkeypatch):
    """Race regression: a watch window opens on a freshly-spawned subagent and
    resumes BEFORE the child's first run_conversation() flushes its DB row.

    The child relays ``subagent.start`` (carrying child_session_id, which opens
    the window) before ``_ensure_db_session`` writes the row, so
    ``db.get_session(target)`` is momentarily empty. On slower hosts (WSL2) the
    window's lazy resume consistently lands in this gap. It used to hard-fail
    "session not found"; the frontend then 404'd on its REST messages fallback
    and the watch window spun forever. Since the child is provably live
    (``_child_run_active``), the lazy resume must instead register the live
    session with empty history so the mirror can stream the turn.
    """

    target = "20260616_131212_racey"

    class _DB:
        def get_session(self, _sid):
            # Row not flushed yet — the whole point of the race.
            return None

        def get_session_by_title(self, _title):
            return None

        def reopen_session(self, _sid):
            return None

        def get_messages_as_conversation(self, _sid, include_ancestors=False):
            # No rows for an unwritten session.
            return []

    monkeypatch.setattr(server, "_get_db", lambda: _DB())
    monkeypatch.setattr(
        server, "_make_agent", lambda *a, **k: (_ for _ in ()).throw(AssertionError("no build"))
    )
    # Child is live in the relay registry even though its row isn't written.
    server._active_child_runs[target] = time.time()
    try:
        resp = server.handle_request(
            {
                "id": "r1",
                "method": "session.resume",
                "params": {"session_id": target, "cols": 100, "lazy": True},
            }
        )
    finally:
        server._active_child_runs.pop(target, None)

    # The resume must succeed (no "session not found") and register a live,
    # agent-less watch session the mirror can find by stored key.
    assert "error" not in resp
    result = resp["result"]
    assert result["resumed"] == target
    assert result["session_key"] == target
    assert result["info"]["lazy"] is True
    assert result["messages"] == []
    # Live for the mirror; reported running so the window shows a busy state.
    assert result["running"] is True
    assert result["status"] == "streaming"
    sid = result["session_id"]
    assert server._find_live_session_by_key(target) == (sid, server._sessions[sid])
    assert server._sessions[sid]["agent"] is None


def test_session_resume_missing_row_non_lazy_still_errors(server, monkeypatch):
    """The missing-row tolerance is scoped to lazy resumes of an ACTIVE child.
    A normal (non-lazy) resume of a genuinely unknown id must still fail fast
    with "session not found" rather than silently registering an empty session.
    """

    target = "20260616_000000_ghost"

    class _DB:
        def get_session(self, _sid):
            return None

        def get_session_by_title(self, _title):
            return None

    monkeypatch.setattr(server, "_get_db", lambda: _DB())

    # Non-lazy resume, no active child → hard error.
    resp = server.handle_request(
        {
            "id": "r1",
            "method": "session.resume",
            "params": {"session_id": target, "cols": 100},
        }
    )
    assert "error" in resp
    assert "session not found" in resp["error"]["message"].lower()

    # Lazy resume but the child is NOT live → still an error (no live mirror to
    # justify an empty session; this would just be a dead, sessionless window).
    resp2 = server.handle_request(
        {
            "id": "r2",
            "method": "session.resume",
            "params": {"session_id": target, "cols": 100, "lazy": True},
        }
    )
    assert "error" in resp2
    assert "session not found" in resp2["error"]["message"].lower()


def test_session_resume_reuses_existing_live_session(server, monkeypatch):
    """Repeated resume must not allocate duplicate live agents."""

    target = "20260409_010101_abc123"
    created_sids: list[str] = []
    closed_sids: list[str] = []
    first_agent_started = threading.Event()
    agent_can_finish = threading.Event()

    class _DB:
        def get_session(self, _sid):
            return {"id": target}

        def get_session_by_title(self, _title):
            return None

        def reopen_session(self, _sid):
            return None

        def get_messages_as_conversation(self, _sid, include_ancestors=False):
            return [
                {"role": "user", "content": "hello"},
                {"role": "assistant", "content": "yo"},
            ]

    class _Worker:
        def close(self):
            pass

    class _Agent:
        def __init__(self, sid, session_id):
            self.sid = sid
            self.model = "test/model"
            self.session_id = session_id

        def close(self):
            closed_sids.append(self.sid)

    def make_agent(sid, key, session_id=None, session_db=None):
        created_sids.append(sid)
        first_agent_started.set()
        assert agent_can_finish.wait(timeout=1)
        return _Agent(sid, session_id or key)

    monkeypatch.setattr(server, "_get_db", lambda: _DB())
    monkeypatch.setattr(server, "_make_agent", make_agent)
    monkeypatch.setattr(server, "_SlashWorker", lambda _key, _model: _Worker())
    monkeypatch.setattr(
        server,
        "_start_notification_poller",
        lambda _sid, _session: threading.Event(),
    )
    monkeypatch.setattr(server, "_notify_session_boundary", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(server, "_wire_callbacks", lambda _sid: None)
    monkeypatch.setattr(server, "_emit", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(
        server,
        "_session_info",
        lambda _agent, _session=None: {"model": "test/model"},
    )

    fake_approval = types.SimpleNamespace(
        load_permanent_allowlist=lambda: None,
        register_gateway_notify=lambda *_args, **_kwargs: None,
    )

    with patch.dict(sys.modules, {"tools.approval": fake_approval}):
        first_holder = {}

        def resume_first():
            first_holder["resp"] = server.handle_request(
                {
                    "id": "first",
                    "method": "session.resume",
                    "params": {"session_id": target, "cols": 100},
                }
            )

        first_thread = threading.Thread(target=resume_first)
        first_thread.start()
        assert first_agent_started.wait(timeout=1)

        second_holder = {}

        def resume_second():
            second_holder["resp"] = server.handle_request(
                {
                    "id": "second",
                    "method": "session.resume",
                    "params": {"session_id": target, "cols": 120},
                }
            )

        second_thread = threading.Thread(target=resume_second)
        second_thread.start()
        agent_can_finish.set()

        first_thread.join(timeout=1)
        second_thread.join(timeout=1)
        assert not first_thread.is_alive()
        assert not second_thread.is_alive()
        first = first_holder["resp"]
        second = second_holder["resp"]

    assert "error" not in first
    assert "error" not in second
    # Both resumes resolve to the SAME single live session — the core invariant.
    assert second["result"]["session_id"] == first["result"]["session_id"]
    assert len(server._sessions) == 1
    assert [s.get("session_key") for s in server._sessions.values()].count(target) == 1
    winner = first["result"]["session_id"]
    # The agent build happens outside the resume lock, so a racing resume may
    # build a redundant agent; double-checked locking keeps only one live
    # session and closes any loser's agent (no worker/poller is wired for it).
    assert winner in created_sids
    survivors = [sid for sid in created_sids if sid not in closed_sids]
    assert survivors == [winner]
    assert all(sid == winner for sid in server._sessions)


def test_session_resume_live_payload_uses_current_history_with_ancestors(server, monkeypatch):
    """Live resume should not reuse a stale ancestor-inclusive snapshot."""

    target = "20260409_010101_child"
    ancestor_history = [{"role": "user", "content": "ancestor"}]
    current_history = [
        {"role": "user", "content": "current"},
        {"role": "assistant", "content": "current reply"},
    ]

    class _DB:
        def get_session(self, _sid):
            return {"id": target}

        def get_session_by_title(self, _title):
            return None

        def reopen_session(self, _sid):
            return None

        def get_messages_as_conversation(self, _sid, include_ancestors=False):
            if include_ancestors:
                return ancestor_history + current_history
            return list(current_history)

    class _Worker:
        def close(self):
            pass

    monkeypatch.setattr(server, "_get_db", lambda: _DB())
    monkeypatch.setattr(
        server,
        "_make_agent",
        lambda _sid, key, session_id=None, session_db=None: types.SimpleNamespace(
            model="test/model", session_id=session_id or key
        ),
    )
    monkeypatch.setattr(server, "_SlashWorker", lambda _key, _model: _Worker())
    monkeypatch.setattr(
        server,
        "_start_notification_poller",
        lambda _sid, _session: threading.Event(),
    )
    monkeypatch.setattr(server, "_notify_session_boundary", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(server, "_wire_callbacks", lambda _sid: None)
    monkeypatch.setattr(server, "_emit", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(
        server,
        "_session_info",
        lambda _agent, _session=None: {"model": "test/model"},
    )

    fake_approval = types.SimpleNamespace(
        load_permanent_allowlist=lambda: None,
        register_gateway_notify=lambda *_args, **_kwargs: None,
    )

    with patch.dict(sys.modules, {"tools.approval": fake_approval}):
        first = server.handle_request(
            {
                "id": "first",
                "method": "session.resume",
                "params": {"session_id": target, "cols": 100},
            }
        )

        assert "error" not in first
        sid = first["result"]["session_id"]
        assert first["result"]["messages"] == [
            {"role": "user", "text": "ancestor"},
            {"role": "user", "text": "current"},
            {"role": "assistant", "text": "current reply"},
        ]

        with server._sessions[sid]["history_lock"]:
            server._sessions[sid]["history"] = current_history + [
                {"role": "user", "content": "new live turn"},
                {"role": "assistant", "content": "new live reply"},
            ]

        second = server.handle_request(
            {
                "id": "second",
                "method": "session.resume",
                "params": {"session_id": target, "cols": 120},
            }
        )

    assert "error" not in second
    assert second["result"]["session_id"] == sid
    assert second["result"]["messages"] == [
        {"role": "user", "text": "ancestor"},
        {"role": "user", "text": "current"},
        {"role": "assistant", "text": "current reply"},
        {"role": "user", "text": "new live turn"},
        {"role": "assistant", "text": "new live reply"},
    ]


def test_session_activate_rebinds_orphaned_ws_session_to_current_transport(server, monkeypatch):
    """Reconnect + activate must reattach a parked live session before orphan reap."""

    class _Transport:
        def write(self, _obj):
            return True

    sid = "runtime01"
    old_transport = server._stdio_transport
    new_transport = _Transport()
    server._sessions[sid] = {
        "agent": types.SimpleNamespace(model="test/model"),
        "created_at": 123.0,
        "history": [],
        "history_lock": threading.RLock(),
        "last_active": 123.0,
        "running": False,
        "session_key": "20260409_010101_abc123",
        "transport": old_transport,
    }
    monkeypatch.setattr(server, "current_transport", lambda: new_transport)
    monkeypatch.setattr(server, "_get_db", lambda: None)
    monkeypatch.setattr(
        server,
        "_session_info",
        lambda _agent, _session=None: {"model": "test/model"},
    )

    resp = server.handle_request(
        {"id": "activate", "method": "session.activate", "params": {"session_id": sid}}
    )

    assert "error" not in resp
    assert resp["result"]["session_id"] == sid
    assert server._sessions[sid]["transport"] is new_transport
    assert not server._ws_session_is_orphaned(server._sessions[sid])


def test_session_branch_persists_branched_from_marker(server, monkeypatch):
    """TUI /branch must persist a _branched_from marker so the branch stays
    visible in /resume and /sessions.

    Regression for issue #20856: the TUI branch leaves the parent live (it
    never ends it with end_reason='branched'), so list_sessions_rich's legacy
    heuristic never surfaces it — the stable model_config marker is the only
    thing that keeps a TUI branch visible.
    """
    create_calls = []

    class _DB:
        def get_session_title(self, _key):
            return "parent-title"

        def get_next_title_in_lineage(self, base):
            return f"{base} 2"

        def create_session(self, new_key, **kwargs):
            create_calls.append((new_key, kwargs))
            return new_key

        def append_message(self, **_kwargs):
            return None

        def set_session_title(self, _key, _title):
            return None

    monkeypatch.setattr(server, "_get_db", lambda: _DB())
    monkeypatch.setattr(server, "_resolve_model", lambda: "test/model")
    monkeypatch.setattr(server, "_new_session_key", lambda: "20260101_000001_child0")
    monkeypatch.setattr(
        server,
        "_make_agent",
        lambda _sid, key, session_id=None, session_db=None: types.SimpleNamespace(
            model="test/model", session_id=session_id or key
        ),
    )
    monkeypatch.setattr(server, "_init_session", lambda *_a, **_k: None)
    monkeypatch.setattr(server, "_set_session_context", lambda *_a, **_k: [])
    monkeypatch.setattr(server, "_clear_session_context", lambda *_a, **_k: None)
    monkeypatch.setattr(server, "_session_cwd", lambda _s: "/tmp/branch-cwd")

    parent_sid = "parent01"
    parent_key = "20260101_000000_parent"
    server._sessions[parent_sid] = {
        "session_key": parent_key,
        "history": [{"role": "user", "content": "hello"}],
        "history_lock": threading.Lock(),
        "cols": 80,
    }

    resp = server.handle_request(
        {"id": "b1", "method": "session.branch", "params": {"session_id": parent_sid}}
    )

    assert "error" not in resp, resp
    assert len(create_calls) == 1
    new_key, kwargs = create_calls[0]
    assert new_key == "20260101_000001_child0"
    assert kwargs["parent_session_id"] == parent_key
    # The marker — without it the branch is invisible in /resume and /sessions.
    assert kwargs["model_config"] == {"_branched_from": parent_key}


def test_make_agent_accepts_list_system_prompt(server, monkeypatch):
    captured = {}

    class _Agent:
        def __init__(self, **kwargs):
            captured.update(kwargs)
            self.model = kwargs.get("model", "")

    monkeypatch.setitem(sys.modules, "run_agent", types.SimpleNamespace(AIAgent=_Agent))
    monkeypatch.setitem(
        sys.modules,
        "hermes_cli.runtime_provider",
        types.SimpleNamespace(
            resolve_runtime_provider=lambda **_kwargs: {
                "provider": "test",
                "base_url": None,
                "api_key": None,
                "api_mode": None,
            }
        ),
    )
    monkeypatch.setattr(server, "_load_cfg", lambda: {"agent": {"system_prompt": ["one", "two"]}})
    monkeypatch.setattr(server, "_resolve_startup_runtime", lambda: ("test/model", "test"))
    monkeypatch.setattr(server, "_get_db", lambda: None)

    server._make_agent("sid", "session-key", session_id="session-key")

    assert captured["ephemeral_system_prompt"] == "one\ntwo"


# ── Config I/O ───────────────────────────────────────────────────────


def test_config_load_missing(server, tmp_path):
    server._hermes_home = tmp_path
    assert server._load_cfg() == {}


def test_config_roundtrip(server, tmp_path):
    server._hermes_home = tmp_path
    server._save_cfg({"model": "test/model"})
    assert server._load_cfg()["model"] == "test/model"


# ── _cli_exec_blocked ────────────────────────────────────────────────


@pytest.mark.parametrize("argv", [
    [],
    ["setup"],
    ["gateway"],
    ["sessions", "browse"],
    ["config", "edit"],
])
def test_cli_exec_blocked(server, argv):
    assert server._cli_exec_blocked(argv) is not None


@pytest.mark.parametrize("argv", [
    ["version"],
    ["sessions", "list"],
])
def test_cli_exec_allowed(server, argv):
    assert server._cli_exec_blocked(argv) is None


def test_commands_catalog_discovers_bundles_with_bundle_over_skill_precedence(server):
    """Initial slash discovery and /help expose each Bundle slug exactly once."""
    fake_bundles = {
        "/bundle-only": {"name": "Bundle Only", "description": "Bundle workflow"},
        "/collision": {"name": "Collision Bundle", "description": "Bundle wins"},
    }
    fake_skills = {
        "/collision": {"name": "collision", "description": "Skill loses"},
        "/skill-only": {"name": "skill-only", "description": "Skill workflow"},
    }

    with patch(
        "agent.skill_bundles.get_skill_bundles", return_value=fake_bundles
    ), patch(
        "agent.skill_commands.get_skill_commands", return_value=fake_skills
    ):
        resp = server.handle_request({
            "id": "catalog-bundles",
            "method": "commands.catalog",
            "params": {},
        })

    assert "error" not in resp
    result = resp["result"]
    pairs = result["pairs"]
    assert sum(1 for command, _ in pairs if command == "/collision") == 1
    pair_map = dict(pairs)
    assert pair_map["/collision"] == "Bundle wins"
    assert pair_map["/bundle-only"] == "Bundle workflow"
    assert pair_map["/skill-only"] == "Skill workflow"
    assert result["bundle_count"] == 2
    assert result["skill_count"] == 1

    tools_and_skills = next(
        section
        for section in result["categories"]
        if section["name"] == "Tools & Skills"
    )
    category_pairs = dict(tools_and_skills["pairs"])
    assert category_pairs["/collision"] == "Bundle wins"
    assert category_pairs["/bundle-only"] == "Bundle workflow"


def test_dynamic_slash_catalog_and_completion_share_ownership_and_precedence(server):
    """Quick/plugin/bundle/skill discovery is complete, stable, and deduplicated."""
    plugin_handler = MagicMock(return_value="plugin result")
    quick_commands = {
        "dyn-all": {
            "type": "alias",
            "target": "/status",
            "description": "Quick wins all",
        },
        "dyn-quick": {"type": "exec", "command": "echo quick"},
    }
    plugin_commands = {
        "dyn-all": {"handler": plugin_handler, "description": "Plugin loses all"},
        "dyn-plugin": {"handler": plugin_handler, "description": "Plugin workflow"},
    }
    bundle_commands = {
        "/dyn-all": {"name": "All Bundle", "description": "Bundle loses all", "skills": ["a"]},
        "/dyn-bundle": {"name": "Bundle", "description": "Bundle workflow", "skills": ["a", "b"]},
    }
    skill_commands = {
        "/dyn-all": {"name": "dyn-all", "description": "Skill loses all"},
        "/dyn-skill": {"name": "dyn-skill", "description": "Skill workflow"},
    }

    with patch.object(
        server,
        "_load_cfg",
        return_value={"quick_commands": quick_commands},
    ), patch(
        "hermes_cli.plugins.get_plugin_commands", return_value=plugin_commands
    ), patch(
        "agent.skill_bundles.get_skill_bundles", return_value=bundle_commands
    ), patch(
        "agent.skill_commands.get_skill_commands", return_value=skill_commands
    ):
        catalog = server.handle_request({
            "id": "dynamic-catalog",
            "method": "commands.catalog",
            "params": {},
        })["result"]
        completion = server.handle_request({
            "id": "dynamic-complete",
            "method": "complete.slash",
            "params": {"text": "/dyn-"},
        })["result"]

    # Discovery reads plugin registry metadata only; it must never execute a
    # handler merely to render catalog/completion rows.
    plugin_handler.assert_not_called()

    catalog_rows = [pair for pair in catalog["pairs"] if pair[0].startswith("/dyn-")]
    completion_rows = [
        item for item in completion["items"] if item["display"].startswith("/dyn-")
    ]
    expected = {"/dyn-all", "/dyn-quick", "/dyn-plugin", "/dyn-bundle", "/dyn-skill"}
    assert {pair[0] for pair in catalog_rows} == expected
    assert {item["display"] for item in completion_rows} == expected
    assert len([pair for pair in catalog_rows if pair[0] == "/dyn-all"]) == 1
    assert len([item for item in completion_rows if item["display"] == "/dyn-all"]) == 1
    assert dict(catalog_rows)["/dyn-all"] == "Quick wins all"
    assert next(
        item["meta"] for item in completion_rows if item["display"] == "/dyn-all"
    ) == "Quick wins all"


def test_dynamic_slash_collision_winner_matches_command_dispatch(server):
    """The quick winner shown for a four-source collision is the executed owner."""
    sid = "four-source-collision-session"
    worker = MagicMock()
    server._sessions[sid] = {
        "session_key": sid,
        "agent": None,
        "slash_worker": worker,
    }
    plugin_handler = MagicMock(return_value="wrong plugin")
    skill_builder = MagicMock(return_value="wrong skill")
    quick = {
        "collision": {
            "type": "alias",
            "target": "/status",
            "description": "Quick collision winner",
        }
    }

    with patch.object(
        server,
        "_load_cfg",
        return_value={"quick_commands": quick},
    ), patch(
        "hermes_cli.plugins.get_plugin_commands",
        return_value={
            "collision": {"handler": plugin_handler, "description": "Plugin loser"}
        },
    ), patch(
        "agent.skill_bundles.get_skill_bundles",
        return_value={
            "/collision": {"name": "Bundle loser", "description": "Bundle loser", "skills": ["a"]}
        },
    ), patch(
        "agent.skill_commands.get_skill_commands",
        return_value={
            "/collision": {"name": "Skill loser", "description": "Skill loser"}
        },
    ), patch(
        "agent.skill_commands.build_skill_invocation_message",
        skill_builder,
    ):
        catalog = server.handle_request({
            "id": "collision-catalog",
            "method": "commands.catalog",
            "params": {},
        })["result"]
        completion = server.handle_request({
            "id": "collision-complete",
            "method": "complete.slash",
            "params": {"text": "/coll"},
        })["result"]
        first_hop = server.handle_request({
            "id": "collision-exec",
            "method": "slash.exec",
            "params": {"command": "COLLISION KeepCase", "session_id": sid},
        })
        dispatch = server.handle_request({
            "id": "collision-dispatch",
            "method": "command.dispatch",
            "params": {"name": "COLLISION", "arg": "KeepCase", "session_id": sid},
        })

    assert [pair for pair in catalog["pairs"] if pair[0] == "/collision"] == [
        ["/collision", "Quick collision winner"]
    ]
    assert [item["display"] for item in completion["items"]].count("/collision") == 1
    assert first_hop["error"]["code"] == 4018
    assert dispatch["result"] == {"type": "alias", "target": "/status"}
    plugin_handler.assert_not_called()
    skill_builder.assert_not_called()
    worker.run.assert_not_called()


def test_pending_builtin_remains_reserved_through_desktop_fallback(server):
    """Pending built-ins fall back for execution without yielding ownership."""
    sid = "pending-discovery-session"

    class Worker:
        def __init__(self):
            self.calls = []

        def command(self, command):
            self.calls.append(command)
            return f"worker:{command}"

    worker = Worker()
    server._sessions[sid] = {
        "session_key": sid,
        "agent": None,
        "slash_worker": worker,
        "history": [{"role": "user", "content": "Retry ThisCase"}],
        "history_lock": threading.Lock(),
    }
    quick = {
        "retry": {
            "type": "alias",
            "target": "/status",
            "description": "Quick retry owner",
        }
    }

    with patch.object(
        server,
        "_load_cfg",
        return_value={"quick_commands": quick},
    ), patch(
        "hermes_cli.plugins.get_plugin_commands", return_value={}
    ), patch(
        "agent.skill_bundles.get_skill_bundles", return_value={}
    ), patch(
        "agent.skill_commands.get_skill_commands", return_value={}
    ):
        catalog = server.handle_request({
            "id": "pending-catalog",
            "method": "commands.catalog",
            "params": {},
        })["result"]
        completion = server.handle_request({
            "id": "pending-complete",
            "method": "complete.slash",
            "params": {"text": "/retr"},
        })["result"]
        first_hop = server.handle_request({
            "id": "pending-exec",
            "method": "slash.exec",
            "params": {"command": "retry", "session_id": sid},
        })
        fallback = server.handle_request({
            "id": "pending-dispatch",
            "method": "command.dispatch",
            "params": {"name": "retry", "session_id": sid},
        })

    retry_pairs = [pair for pair in catalog["pairs"] if pair[0] == "/retry"]
    assert len(retry_pairs) == 1
    assert retry_pairs[0][1] != "Quick retry owner"
    retry_items = [
        item for item in completion["items"] if item["display"] == "/retry"
    ]
    assert len(retry_items) == 1
    assert retry_items[0]["meta"] != "Quick retry owner"
    assert first_hop["error"]["code"] == 4018
    assert fallback["result"] == {"type": "send", "message": "Retry ThisCase"}
    assert worker.calls == []


@pytest.mark.parametrize("command", ["status", "snapshot", "compact"])
def test_quick_collision_keeps_non_fallback_static_root(server, command):
    """Ordinary, bare worker-blocked, and TUI-only roots stay static."""
    quick_description = f"Quick {command} must lose"
    with patch.object(
        server,
        "_load_cfg",
        return_value={
            "quick_commands": {
                command: {
                    "type": "alias",
                    "target": "/help",
                    "description": quick_description,
                }
            }
        },
    ), patch(
        "hermes_cli.plugins.get_plugin_commands", return_value={}
    ), patch(
        "agent.skill_bundles.get_skill_bundles", return_value={}
    ), patch(
        "agent.skill_commands.get_skill_commands", return_value={}
    ):
        catalog = server.handle_request({
            "id": f"static-{command}-catalog",
            "method": "commands.catalog",
            "params": {},
        })["result"]
        completion = server.handle_request({
            "id": f"static-{command}-complete",
            "method": "complete.slash",
            "params": {"text": f"/{command}"},
        })["result"]

    assert quick_description not in [description for _, description in catalog["pairs"]]
    assert quick_description not in [item["meta"] for item in completion["items"]]


def test_every_registry_alias_and_tui_extra_root_is_reserved(server):
    """The reserved set derives from registries, not a drifting copied list."""
    from hermes_cli.commands import COMMAND_REGISTRY

    roots = {
        root
        for command in COMMAND_REGISTRY
        for root in (command.name, *command.aliases)
    }
    roots.update(
        root
        for command in server._TUI_NATIVE_COMMANDS
        for root in (command["name"], *command["aliases"])
    )

    assert "switch" in roots
    assert "details" in roots
    assert "detail" in roots
    assert "fortune" in roots
    assert "terminal-setup" in roots
    assert "heapdump" in roots
    assert "mem" in roots
    assert "replay" in roots
    assert "replay-diff" in roots
    assert "setup" in roots
    assert all(
        server._resolve_slash_ownership(root)["owner"] == "reserved"
        for root in roots
    )


@pytest.mark.parametrize(
    ("filename", "contents"),
    [
        ("missing.json", None),
        ("malformed.json", "{not-json"),
        ("wrong-shape.json", '{"commands": {}}'),
        ("invalid-name.json", '{"commands": [{"name": null}]}'),
        (
            "invalid-aliases.json",
            '{"commands": [{"name": "setup", "aliases": "alias"}]}',
        ),
        (
            "duplicate-root.json",
            '{"commands": [{"name": "setup"}, {"name": "setup"}]}',
        ),
    ],
)
def test_tui_native_contract_load_failure_is_fail_closed(
    server, tmp_path, filename, contents
):
    contract_path = tmp_path / filename
    if contents is not None:
        contract_path.write_text(contents, encoding="utf-8")

    with pytest.raises(
        RuntimeError, match="^TUI native slash command contract unavailable$"
    ) as raised:
        server._load_tui_native_commands(contract_path)

    assert str(contract_path) not in str(raised.value)


def test_hidden_builtin_remains_reserved_and_suppresses_quick_owner(server):
    """A hidden gateway-only registry row still reserves its exact root."""
    sid = "reserved-approve-session"
    worker = MagicMock()
    worker.run.return_value = "reserved approve"
    server._sessions[sid] = {
        "session_key": sid,
        "agent": None,
        "slash_worker": worker,
    }
    quick = {
        "approve": {
            "type": "alias",
            "target": "/status",
            "description": "Quick approve owner",
        }
    }
    with patch.object(
        server,
        "_load_cfg",
        return_value={"quick_commands": quick},
    ), patch(
        "hermes_cli.plugins.get_plugin_commands", return_value={}
    ), patch(
        "agent.skill_bundles.get_skill_bundles", return_value={}
    ), patch(
        "agent.skill_commands.get_skill_commands", return_value={}
    ):
        catalog = server.handle_request({
            "id": "hidden-quick-catalog",
            "method": "commands.catalog",
            "params": {},
        })["result"]
        completion = server.handle_request({
            "id": "hidden-quick-complete",
            "method": "complete.slash",
            "params": {"text": "/appr"},
        })["result"]
        direct = server.handle_request({
            "id": "hidden-quick-exec",
            "method": "slash.exec",
            "params": {"command": "APPROVE", "session_id": sid},
        })
        dispatch = server.handle_request({
            "id": "hidden-quick-dispatch",
            "method": "command.dispatch",
            "params": {"name": "APPROVE", "session_id": sid},
        })

    assert all(pair[0] != "/approve" for pair in catalog["pairs"])
    assert all(item["display"] != "/approve" for item in completion["items"])
    assert server._resolve_slash_ownership("APPROVE")["owner"] == "reserved"
    assert direct["result"] == {"output": "reserved approve"}
    assert dispatch["error"]["code"] == 4018
    worker.run.assert_called_once_with("APPROVE")


def test_uppercase_bundle_collision_cannot_replace_reserved_builtin(server):
    """Reserved built-ins beat colliding Bundle/Skill roots case-insensitively."""
    sid = "uppercase-bundle-session"
    worker = MagicMock()
    worker.run.return_value = "built-in status"
    server._sessions[sid] = {
        "session_key": sid,
        "agent": None,
        "slash_worker": worker,
    }
    bundles = {
        "/status": {
            "name": "Status Bundle",
            "description": "Bundle owns status",
            "skills": ["one"],
        }
    }
    skills = {
        "/status": {"name": "status-skill", "description": "Skill loses status"}
    }
    bundle_builder = MagicMock(return_value=("bundle-message", ["one"], []))

    with patch.object(
        server,
        "_load_cfg",
        return_value={"quick_commands": {}},
    ), patch(
        "hermes_cli.plugins.get_plugin_commands", return_value={}
    ), patch(
        "agent.skill_bundles.get_skill_bundles", return_value=bundles
    ), patch(
        "agent.skill_bundles.build_bundle_invocation_message", bundle_builder
    ), patch(
        "agent.skill_commands.get_skill_commands", return_value=skills
    ):
        catalog = server.handle_request({
            "id": "uppercase-bundle-catalog",
            "method": "commands.catalog",
            "params": {},
        })["result"]
        completion = server.handle_request({
            "id": "uppercase-bundle-complete",
            "method": "complete.slash",
            "params": {"text": "/stat"},
        })["result"]
        first_hop = server.handle_request({
            "id": "uppercase-bundle-exec",
            "method": "slash.exec",
            "params": {"command": "STATUS KeepCase ARG", "session_id": sid},
        })

    status_pairs = [pair for pair in catalog["pairs"] if pair[0] == "/status"]
    assert len(status_pairs) == 1
    assert status_pairs[0][1] != "Bundle owns status"
    status_items = [
        item for item in completion["items"] if item["display"] == "/status"
    ]
    assert len(status_items) == 1
    assert not status_items[0]["meta"].startswith("▣ Bundle owns status")
    assert "error" not in first_hop
    assert first_hop["result"] == {"output": "built-in status"}
    worker.run.assert_called_once_with("STATUS KeepCase ARG")
    bundle_builder.assert_not_called()


def test_reserved_alias_equivalence_beats_bundle_and_skill(server):
    """A dynamic /set_home cannot bypass the reserved /set-home alias."""
    sid = "reserved-set-home-equivalence"
    worker = MagicMock()
    worker.run.return_value = "reserved sethome"
    server._sessions[sid] = {
        "session_key": sid,
        "agent": None,
        "slash_worker": worker,
    }
    bundles = {
        "/set_home": {
            "name": "Set Home Bundle",
            "description": "Bundle loser",
            "skills": ["one"],
        }
    }
    skills = {
        "/set_home": {"name": "set-home-skill", "description": "Skill loser"}
    }

    with patch.object(
        server, "_load_cfg", return_value={"quick_commands": {}}
    ), patch(
        "hermes_cli.plugins.get_plugin_commands", return_value={}
    ), patch(
        "agent.skill_bundles.get_skill_bundles", return_value=bundles
    ), patch(
        "agent.skill_commands.get_skill_commands", return_value=skills
    ):
        catalog = server.handle_request({
            "id": "set-home-equivalence-catalog",
            "method": "commands.catalog",
            "params": {},
        })["result"]
        completion = server.handle_request({
            "id": "set-home-equivalence-completion",
            "method": "complete.slash",
            "params": {"text": "/set_"},
        })["result"]
        direct = server.handle_request({
            "id": "set-home-equivalence-exec",
            "method": "slash.exec",
            "params": {"command": "SET_HOME KeepCase ARG", "session_id": sid},
        })

    assert server._resolve_slash_ownership("set_home")["owner"] == "reserved"
    assert server._resolve_slash_ownership("set_home")["canonical"] == "/sethome"
    assert all(pair[0] != "/set_home" for pair in catalog["pairs"])
    assert all(item["display"] != "/set_home" for item in completion["items"])
    assert direct["result"] == {"output": "reserved sethome"}
    worker.run.assert_called_once_with("SET_HOME KeepCase ARG")


def test_uppercase_skill_execution_preserves_case_sensitive_arg(server):
    """Uppercase typed skill roots canonicalize without lowercasing the argument."""
    sid = "uppercase-skill-session"
    server._sessions[sid] = {"session_key": sid, "agent": None}
    skills = {
        "/case-skill": {"name": "case-skill", "description": "Case skill"}
    }
    skill_builder = MagicMock(return_value="skill-message")

    with patch(
        "agent.skill_bundles.get_skill_bundles", return_value={}
    ), patch(
        "agent.skill_commands.get_skill_commands", return_value=skills
    ), patch(
        "agent.skill_commands.scan_skill_commands", return_value=skills
    ), patch(
        "agent.skill_commands.build_skill_invocation_message", skill_builder
    ):
        first_hop = server.handle_request({
            "id": "uppercase-skill-exec",
            "method": "slash.exec",
            "params": {"command": "CASE-SKILL KeepCase ARG", "session_id": sid},
        })
        fallback = server.handle_request({
            "id": "uppercase-skill-dispatch",
            "method": "command.dispatch",
            "params": {
                "name": "CASE-SKILL",
                "arg": "KeepCase ARG",
                "session_id": sid,
            },
        })

    assert first_hop["error"]["code"] == 4018
    assert fallback["result"] == {
        "type": "skill",
        "message": "skill-message",
        "name": "case-skill",
    }
    skill_builder.assert_called_once_with(
        "/case-skill", "KeepCase ARG", task_id=sid
    )


def test_uppercase_bundle_two_hop_preserves_arg_and_beats_skill(server):
    """Non-reserved Bundle roots keep underscore equivalence and beat Skill."""
    sid = "uppercase-bundle-dynamic-session"
    worker = MagicMock()
    server._sessions[sid] = {
        "session_key": sid,
        "agent": None,
        "slash_worker": worker,
    }
    bundles = {
        "/review-pack": {
            "name": "Review Pack",
            "description": "Review bundle",
            "skills": ["one"],
        }
    }
    skills = {
        "/review-pack": {"name": "review-pack", "description": "Skill loser"}
    }
    bundle_builder = MagicMock(return_value=("bundle-message", ["one"], []))
    skill_builder = MagicMock(return_value="skill-message")

    with patch.object(
        server, "_load_cfg", return_value={"quick_commands": {}}
    ), patch(
        "hermes_cli.plugins.get_plugin_commands", return_value={}
    ), patch(
        "agent.skill_bundles.get_skill_bundles", return_value=bundles
    ), patch(
        "agent.skill_bundles.build_bundle_invocation_message", bundle_builder
    ), patch(
        "agent.skill_commands.get_skill_commands", return_value=skills
    ), patch(
        "agent.skill_commands.build_skill_invocation_message", skill_builder
    ):
        first_hop = server.handle_request({
            "id": "uppercase-dynamic-bundle-exec",
            "method": "slash.exec",
            "params": {"command": "REVIEW_PACK KeepCase ARG", "session_id": sid},
        })
        fallback = server.handle_request({
            "id": "uppercase-dynamic-bundle-dispatch",
            "method": "command.dispatch",
            "params": {
                "name": "REVIEW_PACK",
                "arg": "KeepCase ARG",
                "session_id": sid,
            },
        })

    assert first_hop["error"]["code"] == 4018
    assert fallback["result"]["type"] == "bundle"
    bundle_builder.assert_called_once_with(
        "/review-pack", "KeepCase ARG", task_id=sid
    )
    skill_builder.assert_not_called()
    worker.run.assert_not_called()


@pytest.mark.parametrize(
    ("owner", "stored_root", "typed_root"),
    [
        ("bundle", "/review-pack", "REVIEW_PACK"),
        ("bundle", "/review_pack", "REVIEW-PACK"),
        ("skill", "/review-pack", "REVIEW_PACK"),
        ("skill", "/review_pack", "REVIEW-PACK"),
    ],
)
def test_bundle_and_skill_underscore_hyphen_equivalence_is_symmetric(
    server, owner, stored_root, typed_root
):
    sid = f"symmetric-{owner}-{stored_root}"
    server._sessions[sid] = {"session_key": sid, "agent": None}
    bundles = (
        {
            stored_root: {
                "name": "Review Bundle",
                "description": "Review bundle",
                "skills": ["one"],
            }
        }
        if owner == "bundle"
        else {}
    )
    skills = (
        {stored_root: {"name": "review-skill", "description": "Review skill"}}
        if owner == "skill"
        else {}
    )
    bundle_builder = MagicMock(return_value=("bundle-message", ["one"], []))
    skill_builder = MagicMock(return_value="skill-message")

    with patch.object(
        server, "_load_cfg", return_value={"quick_commands": {}}
    ), patch(
        "hermes_cli.plugins.get_plugin_commands", return_value={}
    ), patch(
        "agent.skill_bundles.get_skill_bundles", return_value=bundles
    ), patch(
        "agent.skill_bundles.build_bundle_invocation_message", bundle_builder
    ), patch(
        "agent.skill_commands.get_skill_commands", return_value=skills
    ), patch(
        "agent.skill_commands.build_skill_invocation_message", skill_builder
    ):
        first_hop = server.handle_request({
            "id": f"symmetric-{owner}-exec",
            "method": "slash.exec",
            "params": {"command": f"{typed_root} KeepCase ARG", "session_id": sid},
        })
        fallback = server.handle_request({
            "id": f"symmetric-{owner}-dispatch",
            "method": "command.dispatch",
            "params": {
                "name": typed_root,
                "arg": "KeepCase ARG",
                "session_id": sid,
            },
        })

    assert first_hop["error"]["code"] == 4018
    assert fallback["result"]["type"] == owner
    if owner == "bundle":
        bundle_builder.assert_called_once_with(
            stored_root, "KeepCase ARG", task_id=sid
        )
        skill_builder.assert_not_called()
    else:
        skill_builder.assert_called_once_with(
            stored_root, "KeepCase ARG", task_id=sid
        )
        bundle_builder.assert_not_called()


def test_quick_and_plugin_roots_do_not_use_underscore_hyphen_equivalence(server):
    quick = {
        "quick-root": {
            "type": "alias",
            "target": "/help",
            "description": "Quick root",
        }
    }
    plugins = {
        "plugin-root": {
            "handler": lambda _arg: "plugin",
            "description": "Plugin root",
        }
    }

    with patch.object(
        server, "_load_cfg", return_value={"quick_commands": quick}
    ), patch(
        "hermes_cli.plugins.get_plugin_commands", return_value=plugins
    ), patch(
        "agent.skill_bundles.get_skill_bundles", return_value={}
    ), patch(
        "agent.skill_commands.get_skill_commands", return_value={}
    ):
        directory, _warnings = server._slash_ownership_directory()

    assert server._resolve_slash_ownership("quick-root", directory)["owner"] == "quick"
    assert server._resolve_slash_ownership("plugin-root", directory)["owner"] == "plugin"
    assert server._resolve_slash_ownership("quick_root", directory)["owner"] == "unknown"
    assert server._resolve_slash_ownership("plugin_root", directory)["owner"] == "unknown"


def test_mixed_case_quick_command_has_one_case_insensitive_owner(server):
    """Mixed-case config keys discover and dispatch under the same lower root."""
    sid = "mixed-case-quick-session"
    worker = MagicMock()
    server._sessions[sid] = {
        "session_key": sid,
        "agent": None,
        "slash_worker": worker,
    }
    quick = {
        "MyCmd": {
            "type": "alias",
            "target": "/Status KeepCASE",
            "description": "Mixed case quick",
        }
    }
    with patch.object(
        server,
        "_load_cfg",
        return_value={"quick_commands": quick},
    ), patch(
        "hermes_cli.plugins.get_plugin_commands", return_value={}
    ), patch(
        "agent.skill_bundles.get_skill_bundles", return_value={}
    ), patch(
        "agent.skill_commands.get_skill_commands", return_value={}
    ):
        catalog = server.handle_request({
            "id": "mixed-quick-catalog",
            "method": "commands.catalog",
            "params": {},
        })["result"]
        completion = server.handle_request({
            "id": "mixed-quick-complete",
            "method": "complete.slash",
            "params": {"text": "/MY"},
        })["result"]
        first_hop = server.handle_request({
            "id": "mixed-quick-exec",
            "method": "slash.exec",
            "params": {"command": "MYCMD KeepCase ARG", "session_id": sid},
        })
        dispatch = server.handle_request({
            "id": "mixed-quick-dispatch",
            "method": "command.dispatch",
            "params": {"name": "MYCMD", "arg": "KeepCase ARG", "session_id": sid},
        })

    assert [pair for pair in catalog["pairs"] if pair[0] == "/mycmd"] == [
        ["/mycmd", "Mixed case quick"]
    ]
    assert [
        item["display"] for item in completion["items"] if item["display"] == "/mycmd"
    ] == ["/mycmd"]
    assert first_hop["error"]["code"] == 4018
    worker.run.assert_not_called()
    assert dispatch["result"] == {
        "type": "alias",
        "target": "/Status KeepCASE",
    }


@pytest.mark.parametrize(
    ("successor", "description", "expected_type"),
    [
        ("plugin", "Callable plugin owner", "plugin"),
        ("bundle", "Bundle owner", "bundle"),
        ("skill", "Skill owner", "skill"),
        (None, None, None),
    ],
)
def test_invalid_quick_never_owns_gateway_discovery_or_dispatch(
    server, successor, description, expected_type
):
    """Unsupported quick types yield to the next valid owner or disappear."""
    root = "invalid-quick-collision"
    plugin_handler = MagicMock(return_value="plugin-output")
    bundle_builder = MagicMock(return_value=("bundle-message", ["one"], []))
    skill_builder = MagicMock(return_value="skill-message")
    plugins = (
        {root: {"handler": plugin_handler, "description": description}}
        if successor == "plugin"
        else {}
    )
    bundles = (
        {
            f"/{root}": {
                "name": "Bundle owner",
                "description": description,
                "skills": ["one"],
            }
        }
        if successor == "bundle"
        else {}
    )
    skills = (
        {f"/{root}": {"name": "Skill owner", "description": description}}
        if successor == "skill"
        else {}
    )

    with patch.object(
        server,
        "_load_cfg",
        return_value={
            "quick_commands": {
                root: {
                    "type": "prompt",
                    "command": "must-not-own",
                    "description": "Invalid quick must lose",
                }
            }
        },
    ), patch(
        "hermes_cli.plugins.get_plugin_commands", return_value=plugins
    ), patch(
        "agent.skill_bundles.get_skill_bundles", return_value=bundles
    ), patch(
        "agent.skill_bundles.build_bundle_invocation_message", bundle_builder
    ), patch(
        "agent.skill_commands.get_skill_commands", return_value=skills
    ), patch(
        "agent.skill_commands.build_skill_invocation_message", skill_builder
    ):
        catalog = server.handle_request({
            "id": f"invalid-quick-{successor}-catalog",
            "method": "commands.catalog",
            "params": {},
        })["result"]
        completion = server.handle_request({
            "id": f"invalid-quick-{successor}-complete",
            "method": "complete.slash",
            "params": {"text": "/INVALID-QUICK"},
        })["result"]
        dispatch = server.handle_request({
            "id": f"invalid-quick-{successor}-dispatch",
            "method": "command.dispatch",
            "params": {"name": root, "arg": "KeepCase ARG"},
        })

    rows = [pair for pair in catalog["pairs"] if pair[0] == f"/{root}"]
    completion_rows = [
        item for item in completion["items"] if item["display"] == f"/{root}"
    ]
    if successor is None:
        assert rows == []
        assert completion_rows == []
        assert dispatch["error"]["code"] == 4018
    else:
        assert rows == [[f"/{root}", description]]
        assert len(completion_rows) == 1
        assert description in completion_rows[0]["meta"]
        assert dispatch["result"]["type"] == expected_type

    if successor == "plugin":
        plugin_handler.assert_called_once_with("KeepCase ARG")
    else:
        plugin_handler.assert_not_called()
    if successor == "bundle":
        bundle_builder.assert_called_once()
    else:
        bundle_builder.assert_not_called()
    if successor == "skill":
        skill_builder.assert_called_once()
    else:
        skill_builder.assert_not_called()


# ── slash.exec skill command interception ────────────────────────────


def test_slash_exec_rejects_skill_commands(server):
    """slash.exec must reject skill commands so the TUI falls through to command.dispatch."""
    # Register a mock session
    sid = "test-session"
    server._sessions[sid] = {"session_key": sid, "agent": None}

    # Mock scan_skill_commands to return a known skill
    fake_skills = {"/hermes-agent-dev": {"name": "hermes-agent-dev", "description": "Dev workflow"}}

    with patch("agent.skill_commands.get_skill_commands", return_value=fake_skills):
        resp = server.handle_request({
            "id": "r1",
            "method": "slash.exec",
            "params": {"command": "hermes-agent-dev", "session_id": sid},
        })

    # Should return an error so the TUI's .catch() fires command.dispatch
    assert "error" in resp
    assert resp["error"]["code"] == 4018
    assert "skill command" in resp["error"]["message"]


def test_slash_exec_rejects_bundle_commands(server):
    """Bundle commands must fall through to command.dispatch, never the worker."""
    sid = "test-session"
    server._sessions[sid] = {"session_key": sid, "agent": None}

    with patch(
        "agent.skill_bundles.get_skill_bundles",
        return_value={"/review-pack": {"name": "Review Pack", "skills": []}},
    ), patch("agent.skill_commands.get_skill_commands", return_value={}):
        resp = server.handle_request({
            "id": "r-bundle-slash",
            "method": "slash.exec",
            "params": {"command": "review-pack inspect this", "session_id": sid},
        })

    assert resp["error"] == {
        "code": 4018,
        "message": "bundle command: use command.dispatch for /review-pack",
    }


def test_slash_exec_handles_plugin_commands_in_live_gateway(server):
    """Plugin slash commands return normal slash.exec output without using the worker."""
    sid = "test-session"

    class Worker:
        def __init__(self):
            self.calls = []

        def run(self, cmd):
            self.calls.append(cmd)
            return f"worker:{cmd}"

    worker = Worker()
    server._sessions[sid] = {"session_key": sid, "agent": None, "slash_worker": worker}

    handler = lambda arg: f"plugin:{arg}"
    with patch(
        "hermes_cli.plugins.get_plugin_commands",
        return_value={"plugin-cmd": {"handler": handler, "description": "Plugin"}},
    ), patch("agent.skill_bundles.get_skill_bundles", return_value={}), patch(
        "agent.skill_commands.get_skill_commands", return_value={}
    ):
        resp = server.handle_request({
            "id": "r-plugin-slash",
            "method": "slash.exec",
            "params": {"command": "plugin-cmd hello", "session_id": sid},
        })

    assert "error" not in resp
    assert resp["result"] == {"output": "plugin:hello"}
    assert worker.calls == []


def test_slash_exec_plugin_lookup_failure_falls_back_to_worker(server):
    """Plugin discovery failures must not break ordinary slash-worker commands."""
    sid = "test-session"

    class Worker:
        def __init__(self):
            self.calls = []

        def run(self, cmd):
            self.calls.append(cmd)
            return f"worker:{cmd}"

    worker = Worker()
    server._sessions[sid] = {"session_key": sid, "agent": None, "slash_worker": worker}

    with patch(
        "hermes_cli.plugins.get_plugin_command_handler",
        side_effect=RuntimeError("discovery boom"),
    ):
        resp = server.handle_request({
            "id": "r-plugin-lookup-failure",
            "method": "slash.exec",
            "params": {"command": "help", "session_id": sid},
        })

    assert "error" not in resp
    assert resp["result"] == {"output": "worker:help"}
    assert worker.calls == ["help"]


def test_slash_exec_plugin_handler_error_returns_output(server):
    """Plugin handler failures return slash output so the TUI does not redispatch."""
    sid = "test-session"

    class Worker:
        def __init__(self):
            self.calls = []

        def run(self, cmd):
            self.calls.append(cmd)
            return f"worker:{cmd}"

    def handler(arg):
        raise RuntimeError(f"handler boom: {arg}")

    worker = Worker()
    server._sessions[sid] = {"session_key": sid, "agent": None, "slash_worker": worker}

    with patch(
        "hermes_cli.plugins.get_plugin_commands",
        return_value={"plugin-cmd": {"handler": handler, "description": "Plugin"}},
    ), patch("agent.skill_bundles.get_skill_bundles", return_value={}), patch(
        "agent.skill_commands.get_skill_commands", return_value={}
    ):
        resp = server.handle_request({
            "id": "r-plugin-handler-error",
            "method": "slash.exec",
            "params": {"command": "plugin-cmd hello", "session_id": sid},
        })

    assert "error" not in resp
    assert resp["result"] == {"output": "Plugin command error: handler boom: hello"}
    assert worker.calls == []


class _FalseyCallablePlugin:
    def __init__(self):
        self.calls = []

    def __bool__(self):
        return False

    def __call__(self, arg):
        self.calls.append(arg)
        return f"falsey-callable:{arg}"


def test_falsey_callable_plugin_is_discovered_and_executed(server):
    """Callable validation must not accidentally use handler truthiness."""
    sid = "falsey-callable-plugin-session"
    worker = MagicMock()
    handler = _FalseyCallablePlugin()
    server._sessions[sid] = {
        "session_key": sid,
        "agent": None,
        "slash_worker": worker,
    }
    plugins = {
        "falsey-plugin": {"handler": handler, "description": "Falsey callable"}
    }
    with patch.object(
        server, "_load_cfg", return_value={"quick_commands": {}}
    ), patch(
        "hermes_cli.plugins.get_plugin_commands", return_value=plugins
    ), patch(
        "agent.skill_bundles.get_skill_bundles", return_value={}
    ), patch(
        "agent.skill_commands.get_skill_commands", return_value={}
    ):
        catalog = server.handle_request({
            "id": "falsey-plugin-catalog",
            "method": "commands.catalog",
            "params": {},
        })["result"]
        completion = server.handle_request({
            "id": "falsey-plugin-complete",
            "method": "complete.slash",
            "params": {"text": "/FALSEY"},
        })["result"]
        direct = server.handle_request({
            "id": "falsey-plugin-exec",
            "method": "slash.exec",
            "params": {
                "command": "FALSEY-PLUGIN KeepCase ARG",
                "session_id": sid,
            },
        })

    assert [pair for pair in catalog["pairs"] if pair[0] == "/falsey-plugin"] == [
        ["/falsey-plugin", "Falsey callable"]
    ]
    assert [
        item["display"]
        for item in completion["items"]
        if item["display"] == "/falsey-plugin"
    ] == ["/falsey-plugin"]
    assert direct["result"] == {"output": "falsey-callable:KeepCase ARG"}
    assert handler.calls == ["KeepCase ARG"]
    worker.run.assert_not_called()


@pytest.mark.parametrize("invalid_handler", [None, 0, "not-callable", object()])
def test_invalid_plugin_handlers_are_not_discovered_or_dispatched(
    server, invalid_handler
):
    """Defensive discovery ignores corrupt plugin registry handler entries."""
    sid = "invalid-plugin-session"
    worker = MagicMock()
    worker.run.return_value = "worker unknown"
    server._sessions[sid] = {
        "session_key": sid,
        "agent": None,
        "slash_worker": worker,
    }
    plugins = {
        "broken-plugin": {
            "handler": invalid_handler,
            "description": "Must stay hidden",
        }
    }
    with patch.object(
        server, "_load_cfg", return_value={"quick_commands": {}}
    ), patch(
        "hermes_cli.plugins.get_plugin_commands", return_value=plugins
    ), patch(
        "agent.skill_bundles.get_skill_bundles", return_value={}
    ), patch(
        "agent.skill_commands.get_skill_commands", return_value={}
    ):
        catalog = server.handle_request({
            "id": "invalid-plugin-catalog",
            "method": "commands.catalog",
            "params": {},
        })["result"]
        completion = server.handle_request({
            "id": "invalid-plugin-complete",
            "method": "complete.slash",
            "params": {"text": "/broken"},
        })["result"]
        direct = server.handle_request({
            "id": "invalid-plugin-exec",
            "method": "slash.exec",
            "params": {"command": "broken-plugin ARG", "session_id": sid},
        })

    assert all(pair[0] != "/broken-plugin" for pair in catalog["pairs"])
    assert all(
        item["display"] != "/broken-plugin" for item in completion["items"]
    )
    assert direct["result"] == {"output": "worker unknown"}
    worker.run.assert_called_once_with("broken-plugin ARG")


@pytest.mark.parametrize("cmd", ["retry", "queue hello", "q hello", "steer fix the test"])
def test_slash_exec_rejects_pending_input_commands(server, cmd):
    """slash.exec must reject commands that use _pending_input in the CLI."""
    sid = "test-session"
    server._sessions[sid] = {"session_key": sid, "agent": None}

    resp = server.handle_request({
        "id": "r1",
        "method": "slash.exec",
        "params": {"command": cmd, "session_id": sid},
    })

    assert "error" in resp
    assert resp["error"]["code"] == 4018
    assert "pending-input command" in resp["error"]["message"]


def test_command_dispatch_queue_sends_message(server):
    """command.dispatch /queue returns {type: 'send', message: ...} for the TUI."""
    sid = "test-session"
    server._sessions[sid] = {"session_key": sid}

    resp = server.handle_request({
        "id": "r1",
        "method": "command.dispatch",
        "params": {"name": "queue", "arg": "tell me about quantum computing", "session_id": sid},
    })

    assert "error" not in resp
    result = resp["result"]
    assert result["type"] == "send"
    assert result["message"] == "tell me about quantum computing"


def test_command_dispatch_queue_requires_arg(server):
    """command.dispatch /queue without an argument returns an error."""
    sid = "test-session"
    server._sessions[sid] = {"session_key": sid}

    resp = server.handle_request({
        "id": "r2",
        "method": "command.dispatch",
        "params": {"name": "queue", "arg": "", "session_id": sid},
    })

    assert "error" in resp
    assert resp["error"]["code"] == 4004


def test_skills_manage_search_uses_tools_hub_sources(server):
    result = type("Result", (), {
        "description": "Build better terminal demos",
        "name": "showroom",
    })()
    auth = MagicMock(return_value="auth")
    router = MagicMock(return_value=["source"])
    search = MagicMock(return_value=[result])
    fake_hub = types.SimpleNamespace(
        GitHubAuth=auth,
        create_source_router=router,
        unified_search=search,
    )

    with patch.dict(sys.modules, {"tools.skills_hub": fake_hub}):
        resp = server.handle_request({
            "id": "skills-search",
            "method": "skills.manage",
            "params": {"action": "search", "query": "showroom"},
        })

    assert "error" not in resp
    assert resp["result"] == {
        "results": [{"description": "Build better terminal demos", "name": "showroom"}]
    }
    auth.assert_called_once_with()
    router.assert_called_once_with("auth")
    search.assert_called_once_with("showroom", ["source"], source_filter="all", limit=20)


def test_command_dispatch_steer_fallback_sends_message(server):
    """command.dispatch /steer with no active agent falls back to send."""
    sid = "test-session"
    server._sessions[sid] = {"session_key": sid, "agent": None}

    resp = server.handle_request({
        "id": "r3",
        "method": "command.dispatch",
        "params": {"name": "steer", "arg": "focus on testing", "session_id": sid},
    })

    assert "error" not in resp
    result = resp["result"]
    assert result["type"] == "send"
    assert result["message"] == "focus on testing"


def test_command_dispatch_retry_finds_last_user_message(server):
    """command.dispatch /retry walks session['history'] to find the last user message."""
    sid = "test-session"
    history = [
        {"role": "user", "content": "first question"},
        {"role": "assistant", "content": "first answer"},
        {"role": "user", "content": "second question"},
        {"role": "assistant", "content": "second answer"},
    ]
    server._sessions[sid] = {
        "session_key": sid,
        "agent": None,
        "history": history,
        "history_lock": threading.Lock(),
        "history_version": 0,
    }

    resp = server.handle_request({
        "id": "r4",
        "method": "command.dispatch",
        "params": {"name": "retry", "session_id": sid},
    })

    assert "error" not in resp
    result = resp["result"]
    assert result["type"] == "send"
    assert result["message"] == "second question"
    # Verify history was truncated: everything from last user message onward removed
    assert len(server._sessions[sid]["history"]) == 2
    assert server._sessions[sid]["history"][-1]["role"] == "assistant"
    assert server._sessions[sid]["history_version"] == 1


def test_command_dispatch_retry_empty_history(server):
    """command.dispatch /retry with empty history returns error."""
    sid = "test-session"
    server._sessions[sid] = {
        "session_key": sid,
        "agent": None,
        "history": [],
        "history_lock": threading.Lock(),
        "history_version": 0,
    }

    resp = server.handle_request({
        "id": "r5",
        "method": "command.dispatch",
        "params": {"name": "retry", "session_id": sid},
    })

    assert "error" in resp
    assert resp["error"]["code"] == 4018


def test_command_dispatch_retry_handles_multipart_content(server):
    """command.dispatch /retry extracts text from multipart content lists."""
    sid = "test-session"
    history = [
        {"role": "user", "content": [
            {"type": "text", "text": "analyze this"},
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,..."}}
        ]},
        {"role": "assistant", "content": "I see the image."},
    ]
    server._sessions[sid] = {
        "session_key": sid,
        "agent": None,
        "history": history,
        "history_lock": threading.Lock(),
        "history_version": 0,
    }

    resp = server.handle_request({
        "id": "r6",
        "method": "command.dispatch",
        "params": {"name": "retry", "session_id": sid},
    })

    assert "error" not in resp
    result = resp["result"]
    assert result["type"] == "send"
    assert result["message"] == "analyze this"


def test_command_dispatch_returns_skill_payload(server):
    """command.dispatch returns structured skill payload for the TUI to send()."""
    sid = "test-session"
    server._sessions[sid] = {"session_key": sid}

    fake_skills = {"/hermes-agent-dev": {"name": "hermes-agent-dev", "description": "Dev workflow"}}
    fake_msg = "Loaded skill content here"

    with patch("agent.skill_commands.get_skill_commands", return_value=fake_skills), \
         patch("agent.skill_commands.build_skill_invocation_message", return_value=fake_msg):
        resp = server.handle_request({
            "id": "r2",
            "method": "command.dispatch",
            "params": {"name": "hermes-agent-dev", "session_id": sid},
        })

    assert "error" not in resp
    result = resp["result"]
    assert result["type"] == "skill"
    assert result["message"] == fake_msg
    assert result["name"] == "hermes-agent-dev"


def test_command_dispatch_returns_bundle_payload(server):
    """A bundle stays a bundle while its expanded message is sent to the session."""
    sid = "test-session"
    server._sessions[sid] = {"session_key": sid}
    fake_bundles = {
        "/review-pack": {"name": "Review Pack", "skills": ["review", "tests"]}
    }

    with patch(
        "agent.skill_bundles.resolve_bundle_command_key",
        return_value="/review-pack",
    ), patch(
        "agent.skill_bundles.get_skill_bundles",
        return_value=fake_bundles,
    ), patch(
        "agent.skill_bundles.build_bundle_invocation_message",
        return_value=("expanded bundle message", ["review", "tests"], ["optional"]),
    ) as builder:
        resp = server.handle_request({
            "id": "r-bundle",
            "method": "command.dispatch",
            "params": {
                "name": "review-pack",
                "arg": "inspect this change",
                "session_id": sid,
            },
        })

    assert "error" not in resp
    assert resp["result"] == {
        "type": "bundle",
        "message": "expanded bundle message",
        "name": "Review Pack",
        "skills": ["review", "tests"],
        "missing": ["optional"],
    }
    builder.assert_called_once_with(
        "/review-pack", "inspect this change", task_id=sid
    )


def test_command_dispatch_bundle_precedes_individual_skill(server):
    """A colliding bundle slug wins before individual skill resolution."""
    sid = "test-session"
    server._sessions[sid] = {"session_key": sid}

    with patch(
        "agent.skill_bundles.get_skill_bundles",
        return_value={"/collision": {"name": "Collision Bundle"}},
    ), patch(
        "agent.skill_bundles.build_bundle_invocation_message",
        return_value=("bundle wins", ["first", "second"], []),
    ), patch(
        "agent.skill_commands.get_skill_commands",
        return_value={"/collision": {"name": "collision"}},
    ), patch(
        "agent.skill_commands.build_skill_invocation_message",
        return_value="individual skill",
    ) as skill_builder:
        resp = server.handle_request({
            "id": "r-collision",
            "method": "command.dispatch",
            "params": {"name": "collision", "arg": "do work", "session_id": sid},
        })

    assert resp["result"]["type"] == "bundle"
    assert resp["result"]["message"] == "bundle wins"
    skill_builder.assert_not_called()


def test_command_dispatch_failed_bundle_does_not_fall_through_to_skill(server):
    """Bundle ownership of a colliding slug remains authoritative on failure."""
    with patch(
        "agent.skill_bundles.get_skill_bundles",
        return_value={"/collision": {"name": "Collision Bundle"}},
    ), patch(
        "agent.skill_bundles.build_bundle_invocation_message",
        return_value=None,
    ), patch(
        "agent.skill_commands.get_skill_commands",
        return_value={"/collision": {"name": "collision"}},
    ), patch(
        "agent.skill_commands.build_skill_invocation_message"
    ) as skill_builder:
        resp = server.handle_request({
            "id": "r-collision-failed",
            "method": "command.dispatch",
            "params": {"name": "collision", "arg": "do work"},
        })

    assert resp["error"] == {"code": 5018, "message": "bundle_load_failed"}
    skill_builder.assert_not_called()


def test_command_dispatch_bundle_runtime_failure_is_redacted_and_never_falls_through(server):
    """A confirmed Bundle remains authoritative after an unexpected builder error."""
    secret = "BUNDLE_RUNTIME_FAILURE_SENTINEL"
    skill_builder = MagicMock(return_value="wrong individual skill")

    with patch(
        "agent.skill_bundles.get_skill_bundles",
        return_value={"/collision": {"name": "Collision Bundle"}},
    ), patch(
        "agent.skill_bundles.build_bundle_invocation_message",
        side_effect=RuntimeError(
            f"{secret} C:/private/company/skill.md dsk_do_not_serialize"
        ),
    ), patch(
        "agent.skill_commands.get_skill_commands",
        return_value={"/collision": {"name": "collision"}},
    ), patch(
        "agent.skill_commands.build_skill_invocation_message",
        skill_builder,
    ):
        resp = server.handle_request({
            "id": "r-bundle-runtime-failure",
            "method": "command.dispatch",
            "params": {"name": "collision", "arg": secret},
        })

    assert resp["error"] == {"code": 5018, "message": "bundle_load_failed"}
    serialized = json.dumps(resp)
    assert secret not in serialized
    assert "C:/private" not in serialized
    assert "dsk_do_not_serialize" not in serialized
    skill_builder.assert_not_called()


def test_command_dispatch_bundle_policy_denial_is_stable_and_redacted(server):
    """A mixed bundle denial is a stable 403 without decision-data leakage."""
    from hermes_cli.enterprise_policy import EnterpriseSkillPolicyDenied

    sid = "test-session"
    server._sessions[sid] = {"session_key": sid}
    secret = "SENSITIVE_BUNDLE_SENTINEL"
    denied = EnterpriseSkillPolicyDenied({
        "policyKey": "blocked-skill-at-C:/private/company/skill.md",
        "reason": secret,
        "credential": "dsk_do_not_serialize",
    })

    with patch(
        "agent.skill_bundles.get_skill_bundles",
        return_value={"/mixed": {"name": "Mixed Bundle"}},
    ), patch(
        "agent.skill_bundles.build_bundle_invocation_message",
        side_effect=denied,
    ):
        resp = server.handle_request({
            "id": "r-bundle-denied",
            "method": "command.dispatch",
            "params": {"name": "mixed", "arg": secret, "session_id": sid},
        })

    assert resp["error"] == {
        "code": 403,
        "message": "enterprise_skill_policy_denied",
    }
    serialized = json.dumps(resp)
    assert secret not in serialized
    assert "C:/private" not in serialized
    assert "dsk_do_not_serialize" not in serialized


def test_command_dispatch_awaits_async_plugin_handler(server):
    async def _handler(arg):
        return f"async:{arg}"

    with patch(
        "hermes_cli.plugins.get_plugin_commands",
        return_value={"async-cmd": {"handler": _handler, "description": "Async"}},
    ), patch("agent.skill_bundles.get_skill_bundles", return_value={}), patch(
        "agent.skill_commands.get_skill_commands", return_value={}
    ):
        resp = server.handle_request({
            "id": "r-plugin",
            "method": "command.dispatch",
            "params": {"name": "async-cmd", "arg": "hello"},
        })

    assert "error" not in resp
    assert resp["result"] == {"type": "plugin", "output": "async:hello"}


# ── dispatch(): pool routing for long handlers (#12546) ──────────────


def test_dispatch_runs_short_handlers_inline(server):
    """Non-long handlers return their response synchronously from dispatch()."""
    server._methods["fast.ping"] = lambda rid, params: server._ok(rid, {"pong": True})

    resp = server.dispatch({"id": "r1", "method": "fast.ping", "params": {}})

    assert resp == {"jsonrpc": "2.0", "id": "r1", "result": {"pong": True}}


def test_dispatch_offloads_long_handlers_and_emits_via_stdout(capture):
    """Long handlers run on the pool and write their response via write_json."""
    server, buf = capture
    server._methods["slash.exec"] = lambda rid, params: server._ok(rid, {"output": "hi"})

    resp = server.dispatch({"id": "r2", "method": "slash.exec", "params": {}})
    assert resp is None

    for _ in range(50):
        if buf.getvalue():
            break
        time.sleep(0.01)

    written = json.loads(buf.getvalue())
    assert written == {"jsonrpc": "2.0", "id": "r2", "result": {"output": "hi"}}


def test_dispatch_long_handler_does_not_block_fast_handler(server):
    """A slow long handler must not prevent a concurrent fast handler from completing."""
    released = threading.Event()
    server._methods["slash.exec"] = lambda rid, params: (released.wait(timeout=5), server._ok(rid, {"done": True}))[1]
    server._methods["fast.ping"] = lambda rid, params: server._ok(rid, {"pong": True})

    t0 = time.monotonic()
    assert server.dispatch({"id": "slow", "method": "slash.exec", "params": {}}) is None

    fast_resp = server.dispatch({"id": "fast", "method": "fast.ping", "params": {}})
    fast_elapsed = time.monotonic() - t0

    assert fast_resp["result"] == {"pong": True}
    assert fast_elapsed < 0.5, f"fast handler blocked for {fast_elapsed:.2f}s behind slow handler"

    released.set()


def test_dispatch_session_compress_does_not_block_fast_handler(server):
    """Manual TUI compaction can take minutes, so it must not block the RPC loop."""
    released = threading.Event()

    def slow_compress(rid, params):
        released.wait(timeout=5)
        return server._ok(rid, {"done": True})

    server._methods["session.compress"] = slow_compress
    server._methods["fast.ping"] = lambda rid, params: server._ok(rid, {"pong": True})

    t0 = time.monotonic()
    assert server.dispatch({"id": "slow", "method": "session.compress", "params": {}}) is None

    fast_resp = server.dispatch({"id": "fast", "method": "fast.ping", "params": {}})
    fast_elapsed = time.monotonic() - t0

    assert fast_resp["result"] == {"pong": True}
    assert fast_elapsed < 0.5, f"fast handler blocked for {fast_elapsed:.2f}s behind session.compress"

    released.set()


def test_dispatch_long_handler_exception_produces_error_response(capture):
    """An exception inside a pool-dispatched handler still yields a JSON-RPC error."""
    server, buf = capture

    def boom(rid, params):
        raise RuntimeError("kaboom")

    server._methods["slash.exec"] = boom

    server.dispatch({"id": "r3", "method": "slash.exec", "params": {}})

    for _ in range(50):
        if buf.getvalue():
            break
        time.sleep(0.01)

    written = json.loads(buf.getvalue())
    assert written["id"] == "r3"
    assert written["error"]["code"] == -32000
    assert "kaboom" in written["error"]["message"]


def test_dispatch_unknown_long_method_still_goes_inline(server):
    """Method name not in _LONG_HANDLERS takes the sync path even if handler is slow."""
    server._methods["some.method"] = lambda rid, params: server._ok(rid, {"ok": True})

    resp = server.dispatch({"id": "r4", "method": "some.method", "params": {}})

    assert resp["result"] == {"ok": True}
