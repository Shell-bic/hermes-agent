from __future__ import annotations

import importlib
import os
import sys
from unittest.mock import MagicMock, patch

import pytest


def _make_real_cli(**kwargs):
    clean_config = {
        "model": {
            "default": "anthropic/claude-opus-4.6",
            "base_url": "https://openrouter.ai/api/v1",
            "provider": "auto",
        },
        "display": {"compact": False, "tool_progress": "all"},
        "agent": {},
        "terminal": {"env_type": "local"},
    }
    clean_env = {"LLM_MODEL": "", "HERMES_MAX_ITERATIONS": ""}
    prompt_toolkit_stubs = {
        "prompt_toolkit": MagicMock(),
        "prompt_toolkit.history": MagicMock(),
        "prompt_toolkit.styles": MagicMock(),
        "prompt_toolkit.patch_stdout": MagicMock(),
        "prompt_toolkit.application": MagicMock(),
        "prompt_toolkit.layout": MagicMock(),
        "prompt_toolkit.layout.processors": MagicMock(),
        "prompt_toolkit.filters": MagicMock(),
        "prompt_toolkit.layout.dimension": MagicMock(),
        "prompt_toolkit.layout.menus": MagicMock(),
        "prompt_toolkit.widgets": MagicMock(),
        "prompt_toolkit.key_binding": MagicMock(),
        "prompt_toolkit.completion": MagicMock(),
        "prompt_toolkit.formatted_text": MagicMock(),
    }
    with patch.dict(sys.modules, prompt_toolkit_stubs), patch.dict(
        "os.environ", clean_env, clear=False
    ):
        import cli as cli_mod

        cli_mod = importlib.reload(cli_mod)
        with patch.object(cli_mod, "get_tool_definitions", return_value=[]), patch.dict(
            cli_mod.__dict__, {"CLI_CONFIG": clean_config}
        ):
            return cli_mod.HermesCLI(**kwargs)


class _DummyCLI:
    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.session_id = "session-123"
        self.system_prompt = "base prompt"
        self.preloaded_skills = []

    def show_banner(self):
        return None

    def show_tools(self):
        return None

    def show_toolsets(self):
        return None

    def run(self):
        return None


def test_main_applies_preloaded_skills_to_system_prompt(monkeypatch):
    import cli as cli_mod
    from agent import skill_commands

    created = {}
    snapshot = {"policyVersion": "frozen-v1"}
    events = []

    def fake_preflight(skills):
        events.append(("preflight", list(skills)))
        return snapshot

    def fake_cli(**kwargs):
        events.append(("cli", None))
        created["cli"] = _DummyCLI(**kwargs)
        return created["cli"]

    def fake_build(skills, task_id=None, *, policy=None):
        events.append(("body", policy))
        assert policy is snapshot
        assert task_id == "session-123"
        return "skill prompt", ["hermes-agent-dev", "github-auth"], []

    monkeypatch.setattr(skill_commands, "preflight_skill_identifiers", fake_preflight)
    monkeypatch.setattr(cli_mod, "HermesCLI", fake_cli)
    monkeypatch.setattr(cli_mod, "build_preloaded_skills_prompt", fake_build)

    with pytest.raises(SystemExit):
        cli_mod.main(skills="hermes-agent-dev,github-auth", list_tools=True)

    cli_obj = created["cli"]
    assert events == [
        ("preflight", ["hermes-agent-dev", "github-auth"]),
        ("cli", None),
        ("body", snapshot),
    ]
    assert cli_obj.system_prompt == "base prompt\n\nskill prompt"
    assert cli_obj.preloaded_skills == ["hermes-agent-dev", "github-auth"]


def test_main_raises_for_unknown_preloaded_skill(monkeypatch):
    import cli as cli_mod
    from agent import skill_commands

    monkeypatch.setattr(skill_commands, "preflight_skill_identifiers", lambda skills: {})
    monkeypatch.setattr(cli_mod, "HermesCLI", lambda **kwargs: _DummyCLI(**kwargs))
    monkeypatch.setattr(
        cli_mod,
        "build_preloaded_skills_prompt",
        lambda skills, task_id=None, *, policy=None: ("", [], ["missing-skill"]),
    )

    with pytest.raises(ValueError, match=r"Unknown skill\(s\): missing-skill"):
        cli_mod.main(skills="missing-skill", list_tools=True)


def test_main_preload_denial_precedes_cli_and_state_side_effects(monkeypatch):
    import cli as cli_mod
    import hermes_state
    from agent import skill_commands
    from hermes_cli.enterprise_policy import EnterpriseSkillPolicyDenied
    from tools import skill_usage

    denied = EnterpriseSkillPolicyDenied(
        {
            "policyKey": "expense-review",
            "reason": "enterprise_skill_policy_denied",
        }
    )

    def fail(label):
        def _unexpected(*args, **kwargs):
            pytest.fail(f"{label} ran before preload denial")

        return _unexpected

    monkeypatch.setattr(
        skill_commands,
        "preflight_skill_identifiers",
        lambda skills: (_ for _ in ()).throw(denied),
    )
    monkeypatch.setattr(cli_mod, "HermesCLI", fail("HermesCLI constructor"))
    monkeypatch.setattr(hermes_state, "SessionDB", fail("SessionDB constructor"))
    monkeypatch.setattr(
        cli_mod, "_run_state_db_auto_maintenance", fail("state DB maintenance")
    )
    monkeypatch.setattr(
        cli_mod, "_run_checkpoint_auto_maintenance", fail("checkpoint maintenance")
    )
    monkeypatch.setattr(
        cli_mod, "build_preloaded_skills_prompt", fail("Skill body load")
    )
    monkeypatch.setattr(skill_usage, "bump_use", fail("Skill usage update"))

    with pytest.raises(EnterpriseSkillPolicyDenied) as raised:
        cli_mod.main(skills="expense-review", list_tools=True)

    assert raised.value is denied


def test_show_banner_does_not_print_skills():
    """show_banner() no longer prints the activated skills line — it moved to run()."""
    cli_obj = _make_real_cli(compact=False)
    cli_obj.preloaded_skills = ["hermes-agent-dev", "github-auth"]
    cli_obj.console = MagicMock()

    with patch("cli.build_welcome_banner") as mock_banner, patch(
        "shutil.get_terminal_size", return_value=os.terminal_size((120, 40))
    ):
        cli_obj.show_banner()

    print_calls = [
        call.args[0]
        for call in cli_obj.console.print.call_args_list
        if call.args and isinstance(call.args[0], str)
    ]
    startup_lines = [line for line in print_calls if "Activated skills:" in line]
    assert len(startup_lines) == 0
    assert mock_banner.call_count == 1
