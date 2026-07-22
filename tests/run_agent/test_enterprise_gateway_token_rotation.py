import logging
import threading
from unittest.mock import MagicMock

import pytest


STALE_TOKEN = "gw_stale_runtime_token_1234567890"
FRESH_TOKEN = "gw_fresh_runtime_token_1234567890"


def _bare_agent(*, api_mode: str):
    from run_agent import AIAgent

    agent = object.__new__(AIAgent)
    agent.provider = "company-gateway"
    agent.api_mode = api_mode
    agent.model = "allowed/model"
    agent.base_url = "https://gateway.example/v1"
    agent.api_key = STALE_TOKEN
    agent._client_lock = threading.RLock()
    agent._oauth_1m_beta_disabled = False
    return agent


def test_openai_wire_request_adopts_rotated_gateway_token(
    monkeypatch, caplog
):
    agent = _bare_agent(api_mode="chat_completions")
    old_client = MagicMock(name="old_client")
    new_client = MagicMock(name="new_client")
    agent.client = old_client
    agent._client_kwargs = {
        "api_key": STALE_TOKEN,
        "base_url": agent.base_url,
        "timeout": 60,
    }
    agent._primary_runtime = {
        "provider": "company-gateway",
        "api_key": STALE_TOKEN,
        "client_kwargs": dict(agent._client_kwargs),
    }
    create_client = MagicMock(return_value=new_client)
    close_client = MagicMock()
    install_hooks = MagicMock()
    monkeypatch.setattr(
        "hermes_cli.enterprise_policy.current_enterprise_gateway_token",
        lambda: FRESH_TOKEN,
    )
    monkeypatch.setattr(agent, "_create_openai_client", create_client)
    monkeypatch.setattr(agent, "_close_openai_client", close_client)
    monkeypatch.setattr(
        "agent.enterprise_channel_audit._install_request_hooks",
        install_hooks,
    )
    caplog.set_level(logging.INFO, logger="run_agent")

    assert agent._refresh_enterprise_gateway_credentials() is True

    assert agent.client is new_client
    assert agent.api_key == FRESH_TOKEN
    assert agent._client_kwargs["api_key"] == FRESH_TOKEN
    assert agent._primary_runtime["api_key"] == FRESH_TOKEN
    assert agent._primary_runtime["client_kwargs"]["api_key"] == FRESH_TOKEN
    assert create_client.call_args.args[0]["api_key"] == FRESH_TOKEN
    assert close_client.call_args.args[0] is old_client
    install_hooks.assert_called_once_with(agent)
    assert STALE_TOKEN not in caplog.text
    assert FRESH_TOKEN not in caplog.text

    # The next request reuses the already-refreshed transport instead of
    # rebuilding once per turn.
    assert agent._ensure_primary_openai_client(reason="test") is new_client
    assert create_client.call_count == 1


def test_anthropic_non_streaming_request_adopts_rotated_gateway_token(
    monkeypatch, caplog
):
    agent = _bare_agent(api_mode="anthropic_messages")
    agent._anthropic_api_key = STALE_TOKEN
    agent._anthropic_base_url = agent.base_url
    old_client = MagicMock(name="old_anthropic_client")
    new_client = MagicMock(name="new_anthropic_client")
    response = object()
    new_client.messages.create.return_value = response
    agent._anthropic_client = old_client
    agent._primary_runtime = {
        "provider": "company-gateway",
        "api_key": STALE_TOKEN,
        "anthropic_api_key": STALE_TOKEN,
    }
    build_client = MagicMock(return_value=new_client)
    install_hooks = MagicMock()
    monkeypatch.setattr(
        "hermes_cli.enterprise_policy.current_enterprise_gateway_token",
        lambda: FRESH_TOKEN,
    )
    monkeypatch.setattr(
        "agent.anthropic_adapter.build_anthropic_client",
        build_client,
    )
    monkeypatch.setattr(
        "agent.enterprise_channel_audit._install_request_hooks",
        install_hooks,
    )
    caplog.set_level(logging.INFO, logger="run_agent")

    assert agent._anthropic_messages_create({"model": agent.model}) is response

    assert agent._anthropic_client is new_client
    assert agent._anthropic_api_key == FRESH_TOKEN
    assert agent.api_key == FRESH_TOKEN
    assert agent._is_anthropic_oauth is False
    assert agent._primary_runtime["api_key"] == FRESH_TOKEN
    assert agent._primary_runtime["anthropic_api_key"] == FRESH_TOKEN
    assert build_client.call_args.args[:2] == (FRESH_TOKEN, agent.base_url)
    old_client.close.assert_called_once_with()
    install_hooks.assert_called_once_with(agent)
    assert STALE_TOKEN not in caplog.text
    assert FRESH_TOKEN not in caplog.text


def test_gateway_client_rebuild_failure_keeps_old_transport_and_fails_closed(
    monkeypatch,
):
    agent = _bare_agent(api_mode="chat_completions")
    old_client = MagicMock(name="old_client")
    agent.client = old_client
    agent._client_kwargs = {
        "api_key": STALE_TOKEN,
        "base_url": agent.base_url,
    }
    monkeypatch.setattr(
        "hermes_cli.enterprise_policy.current_enterprise_gateway_token",
        lambda: FRESH_TOKEN,
    )
    monkeypatch.setattr(
        agent,
        "_create_openai_client",
        MagicMock(side_effect=OSError("transport unavailable")),
    )

    with pytest.raises(
        RuntimeError,
        match="Failed to refresh Enterprise Gateway credentials",
    ):
        agent._ensure_primary_openai_client(reason="test")

    assert agent.client is old_client
    assert agent.api_key == STALE_TOKEN
    assert agent._client_kwargs["api_key"] == STALE_TOKEN


def test_non_enterprise_provider_keeps_existing_credentials(monkeypatch):
    agent = _bare_agent(api_mode="chat_completions")
    agent.provider = "custom"
    agent.client = MagicMock()
    agent._client_kwargs = {"api_key": STALE_TOKEN}
    read_token = MagicMock(return_value=FRESH_TOKEN)
    monkeypatch.setattr(
        "hermes_cli.enterprise_policy.current_enterprise_gateway_token",
        read_token,
    )

    assert agent._refresh_enterprise_gateway_credentials() is False
    assert agent.api_key == STALE_TOKEN
    read_token.assert_not_called()
