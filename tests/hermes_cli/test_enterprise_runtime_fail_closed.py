import json

import pytest
import yaml


def _configure_runtime(
    tmp_path,
    monkeypatch,
    *,
    marker=True,
    policy=True,
    company_provider=True,
    token=True,
    auxiliary=None,
    gateway_base_url="https://gateway.example/v1",
):
    home = tmp_path / ".hermes"
    home.mkdir(exist_ok=True)
    monkeypatch.setenv("HERMES_HOME", str(home))
    for name in (
        "HERMES_ENTERPRISE_MANAGED",
        "HERMES_ENTERPRISE_TOOL_POLICY_FILE",
        "HERMES_ENTERPRISE_TOOL_POLICY_JSON",
        "COMPANY_GATEWAY_TOKEN",
        "OPENAI_API_KEY",
        "OPENAI_BASE_URL",
    ):
        monkeypatch.delenv(name, raising=False)

    if marker:
        monkeypatch.setenv("HERMES_ENTERPRISE_MANAGED", "1")
    if policy:
        monkeypatch.setenv(
            "HERMES_ENTERPRISE_TOOL_POLICY_JSON",
            json.dumps(
                {
                    "allowedModels": ["allowed/model"],
                    "currentModel": "allowed/model",
                    "defaultModel": "allowed/model",
                }
            ),
        )
    if token:
        monkeypatch.setenv("COMPANY_GATEWAY_TOKEN", "company-token")

    config = {
        "model": {"provider": "company-gateway", "default": "allowed/model"},
        "fallback_providers": [
            {
                "provider": "custom",
                "model": "local/model",
                "base_url": "http://127.0.0.1:1234/v1",
                "api_key": "valid-local-key",
            }
        ],
    }
    if company_provider:
        config["providers"] = {
            "company-gateway": {
                "base_url": gateway_base_url,
                "key_env": "COMPANY_GATEWAY_TOKEN",
                "transport": "chat_completions",
            }
        }
    if auxiliary is not None:
        config["auxiliary"] = auxiliary
    (home / "config.yaml").write_text(yaml.safe_dump(config), encoding="utf-8")
    return home


@pytest.mark.parametrize(
    ("missing", "expected"),
    [
        ("marker", "HERMES_ENTERPRISE_MANAGED marker is missing"),
        ("policy", "enterprise policy snapshot is missing or invalid"),
        ("company_provider", "providers.company-gateway is missing"),
        ("token", "COMPANY_GATEWAY_TOKEN is missing"),
    ],
)
def test_partial_enterprise_runtime_fails_closed(
    tmp_path, monkeypatch, missing, expected
):
    options = {
        "marker": True,
        "policy": True,
        "company_provider": True,
        "token": True,
    }
    options[missing] = False
    _configure_runtime(tmp_path, monkeypatch, **options)
    monkeypatch.setenv("OPENAI_API_KEY", "valid-local-key")
    monkeypatch.setenv("OPENAI_BASE_URL", "http://127.0.0.1:1234/v1")

    from hermes_cli.auth import AuthError
    from hermes_cli.runtime_provider import resolve_runtime_provider

    with pytest.raises(AuthError, match=expected):
        resolve_runtime_provider(requested="company-gateway")


def test_unmanaged_explicit_local_runtime_is_unchanged(tmp_path, monkeypatch):
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    for name in (
        "HERMES_ENTERPRISE_MANAGED",
        "HERMES_ENTERPRISE_TOOL_POLICY_FILE",
        "HERMES_ENTERPRISE_TOOL_POLICY_JSON",
        "COMPANY_GATEWAY_TOKEN",
    ):
        monkeypatch.delenv(name, raising=False)
    (home / "config.yaml").write_text("model: {}\n", encoding="utf-8")

    from hermes_cli.runtime_provider import resolve_runtime_provider

    runtime = resolve_runtime_provider(
        requested="custom",
        explicit_base_url="http://127.0.0.1:1234/v1",
        explicit_api_key="valid-local-key",
    )
    assert runtime["provider"] == "custom"
    assert runtime["base_url"] == "http://127.0.0.1:1234/v1"
    assert runtime["api_key"] == "valid-local-key"


def test_complete_managed_bundle_allows_loopback_company_gateway_without_local_fallback(
    tmp_path, monkeypatch
):
    _configure_runtime(
        tmp_path,
        monkeypatch,
        gateway_base_url="http://127.0.0.1:5092",
    )
    monkeypatch.setenv("OPENAI_API_KEY", "valid-local-key")
    monkeypatch.setenv("OPENAI_BASE_URL", "http://127.0.0.1:1234/v1")

    from hermes_cli.runtime_provider import resolve_runtime_provider

    runtime = resolve_runtime_provider()
    assert runtime["provider"] == "company-gateway"
    assert runtime["base_url"] == "http://127.0.0.1:5092"
    assert runtime["api_key"] == "company-token"
    assert runtime["base_url"] != "http://127.0.0.1:1234/v1"
    assert runtime["api_key"] != "valid-local-key"


def test_managed_model_switch_rejects_local_provider_before_probe(
    tmp_path, monkeypatch
):
    _configure_runtime(tmp_path, monkeypatch)
    import hermes_cli.model_switch as model_switch

    monkeypatch.setattr(
        model_switch,
        "resolve_provider_full",
        lambda *_args, **_kwargs: pytest.fail("local provider resolution was probed"),
    )
    result = model_switch.switch_model(
        raw_input="local/model",
        current_provider="company-gateway",
        current_model="allowed/model",
        explicit_provider="custom",
    )
    assert result.success is False
    assert "not the enterprise gateway provider" in result.error_message


def test_managed_model_switch_replaces_local_session_runtime(
    tmp_path, monkeypatch
):
    _configure_runtime(tmp_path, monkeypatch)
    from hermes_cli.model_switch import switch_model

    result = switch_model(
        raw_input="allowed/model",
        current_provider="custom",
        current_model="local/model",
        current_base_url="http://127.0.0.1:1234/v1",
        current_api_key="valid-local-key",
    )
    assert result.success is True
    assert result.target_provider == "company-gateway"
    assert result.base_url == "https://gateway.example/v1"
    assert result.api_key == "company-token"
