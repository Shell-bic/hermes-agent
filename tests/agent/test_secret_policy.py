"""P0 Secret Boundary characterization and contract tests."""

from __future__ import annotations

import pytest

from agent.secret_policy import PathSensitivity, SecretPolicy
from tests.fixtures.secret_boundary import (
    FAKE_ENV_TEXT,
    FAKE_SECRET_VALUES,
    assert_fake_secrets_redacted,
    fake_encoded_representations,
)


@pytest.fixture()
def managed_policy(monkeypatch) -> SecretPolicy:
    monkeypatch.setenv("HERMES_ENTERPRISE_MANAGED", "1")
    return SecretPolicy()


@pytest.fixture()
def fake_env(tmp_path):
    path = tmp_path / ".env"
    path.write_text(FAKE_ENV_TEXT, encoding="utf-8")
    return path


def test_same_fake_env_is_classified_as_credential_store(managed_policy, fake_env):
    classification = managed_policy.classify_path(fake_env)

    assert classification.sensitivity is PathSensitivity.CREDENTIAL_STORE
    assert classification.assistant_read_allowed is False


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
    ],
)
def test_required_sensitive_read_commands_are_denied(
    managed_policy,
    fake_env,
    command,
):
    decision = managed_policy.classify_command(command, cwd=fake_env.parent)

    assert decision.allowed is False
    assert decision.sensitive_paths
    assert ".env" in decision.sensitive_paths[0]


@pytest.mark.parametrize(
    "command",
    [
        "env",
        "printenv",
        "set",
        "Get-ChildItem Env:",
        "echo $COMPANY_GATEWAY_TOKEN",
        "Write-Output $env:HERMES_DASHBOARD_SESSION_TOKEN",
        "echo %DESKTOP_TOKEN%",
        "set | findstr TOKEN",
        "env | base64",
        "printenv OPENAI_API_KEY",
        "Get-ChildItem Env: | Out-String",
    ],
)
def test_managed_environment_secret_dump_commands_are_denied(managed_policy, command):
    decision = managed_policy.classify_command(command)

    assert decision.allowed is False
    assert decision.reason


@pytest.mark.parametrize(
    "command",
    [
        "Test-Path .env",
        "stat .env",
        "Get-Item .env | Select-Object Length,LastWriteTime",
        "sha256sum .env",
    ],
)
def test_safe_metadata_commands_remain_allowed(managed_policy, fake_env, command):
    assert managed_policy.classify_command(command, cwd=fake_env.parent).allowed is True


def test_redaction_covers_all_fake_token_shapes(managed_policy):
    redacted = managed_policy.redact_text(
        "standalone: " + " ".join(FAKE_SECRET_VALUES),
    )

    assert_fake_secrets_redacted(redacted)
    assert "standalone:" in redacted


@pytest.mark.parametrize(
    "encoding,encoded",
    fake_encoded_representations(FAKE_ENV_TEXT).items(),
)
def test_redaction_covers_one_layer_encoded_fake_env(
    managed_policy,
    encoding,
    encoded,
):
    redacted = managed_policy.redact_text(f"{encoding}={encoded}")

    assert encoded not in redacted
    assert "REDACTED" in redacted


@pytest.mark.parametrize(
    "encoding,encoded",
    fake_encoded_representations(FAKE_SECRET_VALUES[0]).items(),
)
def test_redaction_covers_one_layer_encoded_fake_token(
    managed_policy,
    encoding,
    encoded,
):
    redacted = managed_policy.redact_text(f"{encoding}={encoded}")

    assert encoded not in redacted
    assert "REDACTED ENCODED SECRET" in redacted


def test_urlsafe_fixture_exercises_urlsafe_alphabet():
    encoded = fake_encoded_representations(FAKE_SECRET_VALUES[0])["urlsafe_base64"]

    assert "-" in encoded or "_" in encoded


@pytest.mark.parametrize(
    "encoded",
    fake_encoded_representations(FAKE_SECRET_VALUES[1]).values(),
)
def test_redaction_covers_dynamically_joined_final_output(managed_policy, encoded):
    fragments = [encoded[index:index + 5] for index in range(0, len(encoded), 5)]
    final_output = "".join(fragments)

    redacted = managed_policy.redact_text(f"joined={final_output}")

    assert final_output not in redacted
    assert "REDACTED ENCODED SECRET" in redacted


@pytest.mark.parametrize(
    "encoded",
    fake_encoded_representations(FAKE_SECRET_VALUES[2]).values(),
)
def test_one_layer_encoded_token_is_removed_from_export_and_persistence(
    managed_policy,
    encoded,
):
    payload = {"content": f"result={encoded}", "nested": [encoded]}

    exported = managed_policy.redact_export_value(payload)
    persisted = managed_policy.redact_persisted_value(payload)

    assert encoded not in str(exported)
    assert encoded not in str(persisted)
    assert exported["content"] == "result=[REDACTED ENCODED SECRET]"
    assert persisted["nested"] == ["[REDACTED ENCODED SECRET]"]


@pytest.mark.parametrize(
    "plain_text",
    [
        "this is ordinary encoded output",
        "0123456789abcdef0123456789abcdef",
        "call +8613800138000 for ordinary support",
    ],
)
def test_non_secret_one_layer_encodings_are_not_redacted(managed_policy, plain_text):
    for encoded in fake_encoded_representations(plain_text).values():
        assert managed_policy.redact_text(encoded) == encoded


def test_managed_redaction_cannot_be_disabled(monkeypatch):
    monkeypatch.setenv("HERMES_ENTERPRISE_MANAGED", "1")
    monkeypatch.setattr("agent.redact._REDACT_ENABLED", False)

    redacted = SecretPolicy().redact_text(FAKE_ENV_TEXT)

    assert_fake_secrets_redacted(redacted)


def test_export_sensitive_keys_mask_non_string_leaves_without_changing_shape():
    exported = SecretPolicy().redact_export_value(
        {
            "password": 1234,
            "token": True,
            "apiKey": "raw-api-key",
            "gatewayToken": "raw-gateway-token",
            "credential": {
                "enabled": False,
                "retries": 3,
                "optional": None,
            },
            "token_count": 42,
        }
    )

    assert exported["password"] == "[REDACTED]"
    assert exported["token"] == "[REDACTED]"
    assert exported["apiKey"] == "[REDACTED]"
    assert exported["gatewayToken"] == "[REDACTED]"
    assert exported["credential"] == {
        "enabled": "[REDACTED]",
        "retries": "[REDACTED]",
        "optional": None,
    }
    assert exported["token_count"] == 42
