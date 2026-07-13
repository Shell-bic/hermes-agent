"""Enterprise terminal Secret Boundary preflight tests."""

from __future__ import annotations

import json
from unittest.mock import MagicMock

import pytest

from tests.fixtures.secret_boundary import FAKE_ENV_TEXT, assert_fake_secrets_redacted
from tools import terminal_tool as terminal_tool_module


@pytest.mark.parametrize(
    "command",
    [
        "Get-Content .env",
        "type .env",
        "python -c \"print(open('.env').read())\"",
        "node -e \"console.log(require('fs').readFileSync('.env','utf8'))\"",
        "certutil -encode .env encoded.txt",
        "cat .env",
        "sed -n '1,20p' .env",
        "base64 .env",
        "python -c \"from pathlib import Path; print(Path('.env').read_text())\"",
        "cp .env copied.env",
        "copy .env copied.env",
        "mv .env copied.env",
        "Move-Item .env copied.env",
        "Compress-Archive .env secrets.zip",
        "tar -czf secrets.tgz .env",
        "python -c \"import sys; print(sys.stdin.read())\" < .env",
        "set | findstr TOKEN",
        "env | base64",
        "printenv OPENAI_API_KEY",
        "Get-ChildItem Env: | Out-String",
    ],
)
@pytest.mark.parametrize("force", [False, True], ids=["approval-yolo-path", "force-path"])
def test_managed_preflight_blocks_required_reads_before_force_or_approval(
    monkeypatch,
    tmp_path,
    command,
    force,
):
    monkeypatch.setenv("HERMES_ENTERPRISE_MANAGED", "1")
    monkeypatch.setenv("TERMINAL_CWD", str(tmp_path))
    (tmp_path / ".env").write_text(FAKE_ENV_TEXT, encoding="utf-8")
    approval_calls = []
    monkeypatch.setattr(
        terminal_tool_module,
        "_check_all_guards",
        lambda *_args, **_kwargs: approval_calls.append(True) or {"approved": True},
    )

    result = json.loads(terminal_tool_module.terminal_tool(command, force=force))

    assert result["status"] == "blocked"
    assert "Enterprise Secret Boundary" in result["error"]
    assert approval_calls == []


def test_non_managed_preflight_does_not_change_terminal_policy(monkeypatch):
    monkeypatch.delenv("HERMES_ENTERPRISE_MANAGED", raising=False)

    assert terminal_tool_module._check_secret_boundary("cat .env")["approved"] is True


def test_foreground_output_redaction_is_forced(monkeypatch):
    monkeypatch.setenv("HERMES_ENTERPRISE_MANAGED", "1")
    monkeypatch.setattr("agent.redact._REDACT_ENABLED", False)
    mock_env = MagicMock()
    mock_env.execute.return_value = {"output": FAKE_ENV_TEXT, "returncode": 0}
    monkeypatch.setattr(
        terminal_tool_module,
        "_get_env_config",
        lambda: {
            "env_type": "local",
            "timeout": 30,
            "cwd": ".",
            "host_cwd": None,
            "docker_image": "",
            "singularity_image": "",
            "modal_image": "",
            "daytona_image": "",
        },
    )
    monkeypatch.setattr(terminal_tool_module, "_start_cleanup_thread", lambda: None)
    monkeypatch.setattr(
        terminal_tool_module,
        "_check_all_guards",
        lambda *_args, **_kwargs: {"approved": True},
    )
    monkeypatch.setitem(terminal_tool_module._active_environments, "default", mock_env)
    monkeypatch.setitem(terminal_tool_module._last_activity, "default", 0.0)

    result = json.loads(terminal_tool_module.terminal_tool("echo safe"))

    assert_fake_secrets_redacted(result["output"])
