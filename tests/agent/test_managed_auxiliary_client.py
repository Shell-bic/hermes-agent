import json
from types import SimpleNamespace

import pytest
import yaml


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
    monkeypatch.setenv("OPENAI_BASE_URL", "http://127.0.0.1:1234/v1")
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
                "auxiliary": {
                    "compression": {
                        "provider": "custom",
                        "model": "local/model",
                        "base_url": "http://127.0.0.1:1234/v1",
                        "api_key": "valid-local-key",
                    }
                },
                "fallback_providers": [
                    {
                        "provider": "custom",
                        "base_url": "http://127.0.0.1:1234/v1",
                        "api_key": "valid-local-key",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )


def _forbid_local_probes(monkeypatch, auxiliary):
    def forbidden(*_args, **_kwargs):
        pytest.fail("a local provider or fallback was probed")

    monkeypatch.setattr(auxiliary, "_peek_pool_entry", forbidden)
    monkeypatch.setattr(auxiliary, "_get_provider_chain", forbidden)
    monkeypatch.setattr(auxiliary, "_try_configured_fallback_chain", forbidden)
    monkeypatch.setattr(auxiliary, "_try_main_fallback_chain", forbidden)


def test_managed_auxiliary_ignores_valid_local_runtime_and_uses_company_gateway(
    tmp_path, monkeypatch
):
    _managed_home(tmp_path, monkeypatch)
    import agent.auxiliary_client as auxiliary

    auxiliary._client_cache.clear()
    _forbid_local_probes(monkeypatch, auxiliary)
    constructed = []

    def fake_openai(**kwargs):
        constructed.append(kwargs)
        return SimpleNamespace(
            api_key=kwargs["api_key"],
            base_url=kwargs["base_url"],
            chat=SimpleNamespace(completions=SimpleNamespace()),
        )

    monkeypatch.setattr(auxiliary, "OpenAI", fake_openai)

    provider, model, base_url, api_key, _ = auxiliary._resolve_task_provider_model(
        "compression"
    )
    assert provider == "company-gateway"
    assert model == "allowed/model"
    assert base_url == "https://gateway.example/v1"
    assert api_key == "company-token"

    client, resolved_model = auxiliary._get_cached_client(
        "auto",
        main_runtime={
            "provider": "custom",
            "model": "local/model",
            "base_url": "http://127.0.0.1:1234/v1",
            "api_key": "valid-local-key",
        },
        task="compression",
    )
    assert resolved_model == "allowed/model"
    assert client.base_url == "https://gateway.example/v1"
    assert client.api_key == "company-token"
    assert constructed == [
        {
            "api_key": "company-token",
            "base_url": "https://gateway.example/v1",
        }
    ]


def test_managed_auxiliary_missing_token_fails_before_local_probe(
    tmp_path, monkeypatch
):
    _managed_home(tmp_path, monkeypatch, token=False)
    import agent.auxiliary_client as auxiliary

    auxiliary._client_cache.clear()
    _forbid_local_probes(monkeypatch, auxiliary)

    from hermes_cli.auth import AuthError

    with pytest.raises(AuthError, match="COMPANY_GATEWAY_TOKEN is missing"):
        auxiliary._get_cached_client("auto", task="compression")
