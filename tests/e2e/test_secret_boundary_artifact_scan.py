"""P0-D1 artifact scan for the managed Secret Boundary.

The test deliberately persists synthetic credentials in several reversible
representations, then scans every resulting on-disk artifact.  It never reads
credentials from the host environment or the user's real Hermes profile.
"""

from __future__ import annotations

import base64
import binascii
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

from hermes_state import SessionDB
from run_agent import AIAgent
from tests.fixtures.secret_boundary import (
    FAKE_SECRET_VALUES,
    fake_encoded_representations,
)


_PERCENT_CANDIDATE_RE = re.compile(r"(?:%[0-9A-Fa-f]{2}){12,}")
_HEX_CANDIDATE_RE = re.compile(
    r"(?<![0-9A-Fa-f])(?:[0-9A-Fa-f]{2}){12,}(?![0-9A-Fa-f])"
)
_BASE64_CANDIDATE_RE = re.compile(
    r"(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{24,}(?:={0,2})"
    r"(?![A-Za-z0-9+/_=-])"
)


def _safe_encoded_representations() -> dict[str, str]:
    """Return long, reversible non-secret values used as false-positive controls."""
    value = "release-artifact-reference-2026"
    raw = value.encode("utf-8")
    urlsafe_raw = ("🔐" + value).encode("utf-8")
    return {
        "percent": "".join(f"%{byte:02X}" for byte in raw),
        "hex": raw.hex(),
        "base64": base64.b64encode(raw).decode("ascii"),
        "urlsafe_base64": base64.urlsafe_b64encode(urlsafe_raw).decode("ascii"),
    }


def _decode_percent(candidate: str) -> str | None:
    try:
        raw = bytes(
            int(candidate[index + 1:index + 3], 16)
            for index in range(0, len(candidate), 3)
        )
        return raw.decode("utf-8")
    except (ValueError, UnicodeDecodeError):
        return None


def _decode_hex(candidate: str) -> str | None:
    try:
        return bytes.fromhex(candidate).decode("utf-8")
    except (ValueError, UnicodeDecodeError):
        return None


def _decode_base64(candidate: str) -> str | None:
    padding = (-len(candidate)) % 4
    if padding == 3:
        return None
    try:
        return base64.b64decode(
            candidate + ("=" * padding),
            altchars=b"-_",
            validate=True,
        ).decode("utf-8")
    except (binascii.Error, UnicodeDecodeError, ValueError):
        return None


def _recoverable_secret_hits(data: bytes) -> list[str]:
    """Find raw secrets or text that recovers one after exactly one decode."""
    text = data.decode("utf-8", errors="ignore")
    hits: list[str] = []

    for secret in FAKE_SECRET_VALUES:
        if secret in text:
            hits.append(f"raw:{secret}")

    decoder_candidates = (
        ("percent", _PERCENT_CANDIDATE_RE, _decode_percent),
        ("hex", _HEX_CANDIDATE_RE, _decode_hex),
        ("base64", _BASE64_CANDIDATE_RE, _decode_base64),
    )
    for encoding, pattern, decoder in decoder_candidates:
        for candidate in pattern.findall(text):
            decoded = decoder(candidate)
            if decoded and any(secret in decoded for secret in FAKE_SECRET_VALUES):
                hits.append(f"{encoding}:{candidate}")

    return hits


def _assert_artifacts_clean(paths: Iterable[Path]) -> None:
    for path in paths:
        data = path.read_bytes() if path.exists() else b""
        hits = _recoverable_secret_hits(data)
        assert hits == [], f"recoverable synthetic secret in {path}: {hits}"


def _write_opt_in_snapshot(
    sessions_dir: Path,
    message: dict,
    system_prompt: str,
) -> Path:
    """Exercise the optional session JSON writer without constructing a client."""
    agent = object.__new__(AIAgent)
    agent._session_json_enabled = True
    agent.logs_dir = sessions_dir
    agent.session_id = "p0-d1-artifact-scan"
    agent._session_messages = [message]
    agent.model = "synthetic-test-model"
    agent.base_url = "https://example.invalid/v1"
    agent.platform = "test"
    agent.session_start = datetime.now(timezone.utc)
    agent._cached_system_prompt = system_prompt
    agent.tools = []
    agent.verbose_logging = False

    agent._save_session_log([message])
    return sessions_dir / f"session_{agent.session_id}.json"


def test_managed_artifacts_contain_no_raw_or_once_decodable_fake_secret(
    tmp_path,
    monkeypatch,
):
    """Scan SQLite, WAL/SHM, export, and opt-in snapshot after checkpoint/close."""
    monkeypatch.setenv("HERMES_ENTERPRISE_MANAGED", "1")
    # Managed mode must enforce the boundary independently of the legacy
    # display/log redaction toggle.
    monkeypatch.setattr("agent.redact._REDACT_ENABLED", False)

    secret_matrix = [
        {"plain": secret, **fake_encoded_representations(secret)}
        for secret in FAKE_SECRET_VALUES
    ]
    safe_encodings = _safe_encoded_representations()
    persisted_payload = {
        "kind": "p0-d1-synthetic-matrix",
        "secrets": secret_matrix,
        "harmless_encodings": safe_encodings,
    }
    content = json.dumps(persisted_payload, ensure_ascii=False)
    system_prompt = json.dumps(
        {
            "purpose": "synthetic artifact scan",
            "payload": persisted_payload,
        },
        ensure_ascii=False,
    )
    tool_calls = [
        {
            "id": "call-p0-d1",
            "type": "function",
            "function": {
                "name": "synthetic_artifact_probe",
                "arguments": content,
            },
            "result": persisted_payload,
        }
    ]
    message = {
        "role": "assistant",
        "content": content,
        "reasoning": content,
        "reasoning_details": [{"summary": content}],
        "tool_calls": tool_calls,
    }

    db_path = tmp_path / "state.db"
    export_path = tmp_path / "export.json"
    sessions_dir = tmp_path / "sessions"
    sessions_dir.mkdir()
    db = SessionDB(db_path=db_path)

    try:
        session_id = "p0-d1-artifact-scan"
        db.create_session(
            session_id=session_id,
            source="test",
            model="synthetic-test-model",
            model_config={
                "provider": "synthetic",
                "payload": persisted_payload,
            },
            system_prompt=system_prompt,
        )
        message_id = db.append_message(
            session_id,
            role=message["role"],
            content=message["content"],
            reasoning=message["reasoning"],
            reasoning_details=message["reasoning_details"],
            tool_calls=message["tool_calls"],
        )

        # Inspect the logical SQLite surfaces as well as the eventual files.
        message_row = dict(
            db._conn.execute(
                "SELECT content, reasoning, reasoning_details, tool_calls "
                "FROM messages WHERE id = ?",
                (message_id,),
            ).fetchone()
        )
        session_row = dict(
            db._conn.execute(
                "SELECT model_config, system_prompt FROM sessions WHERE id = ?",
                (session_id,),
            ).fetchone()
        )
        _assert_artifacts_clean(
            [
                _write_json_probe(tmp_path / "message-row.json", message_row),
                _write_json_probe(tmp_path / "session-row.json", session_row),
            ]
        )

        assert db._fts_enabled is True
        for table_name in ("messages_fts", "messages_fts_trigram"):
            fts_row = db._conn.execute(
                f"SELECT content FROM {table_name} WHERE rowid = ?",
                (message_id,),
            ).fetchone()
            assert fts_row is not None
            assert _recoverable_secret_hits(fts_row["content"].encode("utf-8")) == []
            for safe_value in safe_encodings.values():
                assert safe_value in fts_row["content"]

        exported = db.export_session(session_id)
        assert exported is not None
        export_path.write_text(
            json.dumps(exported, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        parsed_export = json.loads(export_path.read_text(encoding="utf-8"))
        assert parsed_export["id"] == session_id
        assert parsed_export["messages"][0]["role"] == "assistant"
        assert (
            parsed_export["messages"][0]["tool_calls"][0]["function"]["name"]
            == "synthetic_artifact_probe"
        )
        assert json.loads(parsed_export["model_config"])["provider"] == "synthetic"

        snapshot_path = _write_opt_in_snapshot(
            sessions_dir,
            message,
            system_prompt,
        )
        parsed_snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
        assert parsed_snapshot["session_id"] == session_id
        assert parsed_snapshot["messages"][0]["role"] == "assistant"
        assert (
            parsed_snapshot["messages"][0]["tool_calls"][0]["function"]["name"]
            == "synthetic_artifact_probe"
        )

        # Long but harmless encodings must survive every persistence/export
        # pass; otherwise the scanner could go green by masking all encodings.
        for safe_value in safe_encodings.values():
            assert safe_value in message_row["content"]
            assert safe_value in session_row["model_config"]
            assert safe_value in export_path.read_text(encoding="utf-8")
            assert safe_value in snapshot_path.read_text(encoding="utf-8")
    finally:
        db.close()  # includes a TRUNCATE WAL checkpoint

    artifact_paths = [
        db_path,
        Path(f"{db_path}-wal"),
        Path(f"{db_path}-shm"),
        export_path,
        *sessions_dir.glob("session_*.json"),
    ]
    _assert_artifacts_clean(artifact_paths)


def _write_json_probe(path: Path, value: object) -> Path:
    """Materialize a logical SQLite row so it uses the same artifact scanner."""
    path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
    return path
