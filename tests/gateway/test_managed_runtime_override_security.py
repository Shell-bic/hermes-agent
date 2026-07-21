import json

import pytest
import yaml

import gateway.run as gateway_run


def _managed_home(tmp_path, monkeypatch, *, token=True):
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("HERMES_ENTERPRISE_MANAGED", "1")
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
    else:
        monkeypatch.delenv("COMPANY_GATEWAY_TOKEN", raising=False)
    monkeypatch.setenv("OPENAI_API_KEY", "valid-local-key")
    (home / "config.yaml").write_text(
        yaml.safe_dump(
            {
                "model": {
                    "provider": "company-gateway",
                    "default": "allowed/model",
                },
                "providers": {
                    "company-gateway": {
                        "base_url": "https://gateway.example/v1",
                        "key_env": "COMPANY_GATEWAY_TOKEN",
                    }
                },
                "fallback_providers": [
                    {
                        "provider": "custom",
                        "model": "local/model",
                        "base_url": "http://127.0.0.1:1234/v1",
                        "api_key": "valid-local-key",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(gateway_run, "_hermes_home", home)


def test_complete_local_session_override_cannot_bypass_managed_resolver(
    tmp_path, monkeypatch
):
    _managed_home(tmp_path, monkeypatch)
    runner = object.__new__(gateway_run.GatewayRunner)
    session_key = "agent:main:wecom:dm:user-1"
    runner._session_model_overrides = {
        session_key: {
            "model": "allowed/model",
            "provider": "custom",
            "api_key": "valid-local-key",
            "base_url": "http://127.0.0.1:1234/v1",
            "api_mode": "chat_completions",
        }
    }
    calls = []

    def managed_runtime():
        calls.append(True)
        return {
            "provider": "company-gateway",
            "api_key": "company-token",
            "base_url": "https://gateway.example/v1",
            "api_mode": "chat_completions",
        }

    monkeypatch.setattr(gateway_run, "_resolve_runtime_agent_kwargs", managed_runtime)

    model, runtime = runner._resolve_session_agent_runtime(
        session_key=session_key,
        user_config={"model": {"default": "allowed/model"}},
    )
    assert calls == [True]
    assert model == "allowed/model"
    assert runtime["provider"] == "company-gateway"
    assert runtime["api_key"] == "company-token"
    assert runtime["base_url"] == "https://gateway.example/v1"


def test_missing_managed_token_never_uses_local_fallback(tmp_path, monkeypatch):
    _managed_home(tmp_path, monkeypatch, token=False)
    monkeypatch.setattr(
        gateway_run,
        "_try_resolve_fallback_provider",
        lambda: pytest.fail("local fallback resolution was attempted"),
    )

    with pytest.raises(RuntimeError, match="COMPANY_GATEWAY_TOKEN is missing"):
        gateway_run._resolve_runtime_agent_kwargs()
