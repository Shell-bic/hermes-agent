import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[2]
RUNTIME_CASES = (
    REPO_ROOT
    / "contracts"
    / "enterprise-skill-hub"
    / "v1"
    / "fixtures"
    / "runtime-policy-cases.json"
)


def _write_policy(home: Path, monkeypatch, skills: list[dict], *, manage: bool = False) -> Path:
    policy_path = home / "enterprise-policy.json"
    policy_path.write_text(
        json.dumps(
            {
                "role": [
                    {
                        "name": "skill-admin",
                        "capabilities": ["skills.manage"] if manage else [],
                    }
                ],
                "toolPolicySnapshot": {
                    "policyHash": "runtime-policy-test",
                    "skills": skills,
                }
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("HERMES_ENTERPRISE_MANAGED", "1")
    monkeypatch.setenv("HERMES_ENTERPRISE_TOOL_POLICY_FILE", str(policy_path))
    return policy_path


def _write_skill(skills_root: Path, rel: str, name: str) -> Path:
    skill_dir = skills_root / rel
    skill_dir.mkdir(parents=True, exist_ok=True)
    skill_md = skill_dir / "SKILL.md"
    skill_md.write_text(
        f"---\nname: {name}\ndescription: Runtime policy test.\n---\n\n# Secret body\n",
        encoding="utf-8",
    )
    (skill_dir / "references").mkdir()
    (skill_dir / "references" / "checklist.md").write_text("linked secret", encoding="utf-8")
    return skill_md


def _write_enterprise_lock(skills_root: Path, name: str) -> None:
    lock_dir = skills_root / ".hub"
    lock_dir.mkdir(parents=True, exist_ok=True)
    (lock_dir / "lock.json").write_text(
        json.dumps(
            {
                "version": 1,
                "installed": {
                    name: {
                        "source": "enterprise",
                        "key": name,
                        "identifier": name,
                        "path": f"enterprise/{name}",
                        "install_path": f"enterprise/{name}",
                        "metadata": {"enterprise_key": name},
                    }
                },
            }
        ),
        encoding="utf-8",
    )


def _write_enterprise_locks(skills_root: Path, names: list[str]) -> None:
    _write_enterprise_lock(skills_root, names[0])
    lock_path = skills_root / ".hub" / "lock.json"
    lock = json.loads(lock_path.read_text(encoding="utf-8"))
    for name in names[1:]:
        lock["installed"][name] = {
            "source": "enterprise",
            "key": name,
            "identifier": name,
            "path": f"enterprise/{name}",
            "install_path": f"enterprise/{name}",
            "metadata": {"enterprise_key": name},
        }
    lock_path.write_text(json.dumps(lock), encoding="utf-8")


def _link_directory(link: Path, target: Path) -> None:
    """Create the platform's real directory indirection; never skip coverage."""
    if os.name == "nt":
        result = subprocess.run(
            ["cmd.exe", "/d", "/c", "mklink", "/J", str(link), str(target)],
            capture_output=True,
            text=True,
            check=False,
        )
        assert result.returncode == 0, result.stderr or result.stdout
    else:
        link.symlink_to(target, target_is_directory=True)


def test_runtime_policy_fixture_is_table_driven(_isolate_hermes_home, monkeypatch):
    from hermes_constants import get_hermes_home
    from hermes_cli.enterprise_policy import skill_runtime_decision

    fixture = json.loads(RUNTIME_CASES.read_text(encoding="utf-8"))
    skills = [
        {"key": case["identity"]["policyKey"], "status": case["status"]}
        for case in fixture["cases"]
        if case.get("status")
    ]
    _write_policy(get_hermes_home(), monkeypatch, skills, manage=False)

    for case in fixture["cases"]:
        decision = skill_runtime_decision(case["identity"])
        assert decision["allowed"] is case["expectedAllowed"], case["name"]
        if not case["expectedAllowed"]:
            assert decision["errorCode"] == fixture["errorCode"], case["name"]


def test_enterprise_provenance_requires_standard_path_and_lock(
    _isolate_hermes_home, monkeypatch
):
    from hermes_constants import get_hermes_home
    from hermes_cli.enterprise_policy import skill_runtime_decision, skill_runtime_identity

    skills_root = get_hermes_home() / "skills"
    skill_md = _write_skill(skills_root, "enterprise/expense-review", "expense-review")
    _write_enterprise_lock(skills_root, "expense-review")
    _write_policy(
        get_hermes_home(),
        monkeypatch,
        [{"key": "expense-review", "status": "available"}],
        manage=False,
    )

    identity = skill_runtime_identity("expense-review", skill_path=skill_md)
    assert identity["provenance"] == "enterprise"
    assert skill_runtime_decision(identity)["allowed"] is True

    (skills_root / ".hub" / "lock.json").write_text("{}", encoding="utf-8")
    damaged = skill_runtime_identity("expense-review", skill_path=skill_md)
    assert damaged["provenance"] == "enterprise-invalid"
    assert skill_runtime_decision(damaged)["allowed"] is False


def test_unicode_p1_skill_name_is_preserved_for_lookup_and_safe_errors(
    _isolate_hermes_home, monkeypatch
):
    from hermes_constants import get_hermes_home
    from hermes_cli.enterprise_policy import skill_runtime_decision, skill_runtime_identity
    import tools.skills_tool as skills_tool

    name = "购物省钱宝"
    home = get_hermes_home()
    skills_root = home / "skills"
    skill_md = _write_skill(skills_root, f"enterprise/{name}", name)
    _write_enterprise_lock(skills_root, name)
    policy_path = _write_policy(
        home,
        monkeypatch,
        [{"key": name, "status": "available"}],
        manage=False,
    )
    monkeypatch.setattr(skills_tool, "SKILLS_DIR", skills_root)

    identity = skill_runtime_identity(name, skill_path=skill_md)
    available = json.loads(skills_tool.skill_view(name, preprocess=False))

    assert identity == {"policyKey": name, "provenance": "enterprise"}
    assert skill_runtime_decision(identity)["allowed"] is True
    assert available["success"] is True
    assert available["name"] == name

    policy = json.loads(policy_path.read_text(encoding="utf-8"))
    policy["toolPolicySnapshot"]["skills"][0]["status"] = "blocked"
    policy_path.write_text(json.dumps(policy), encoding="utf-8")
    blocked = json.loads(skills_tool.skill_view(name, preprocess=False))
    serialized = json.dumps(blocked, ensure_ascii=False)

    assert blocked["errorCode"] == "enterprise_skill_policy_denied"
    assert blocked["policyKey"] == name
    assert str(skills_root) not in serialized
    assert "Secret body" not in serialized
    assert "linked secret" not in serialized

    ordinary = skill_runtime_decision(
        skill_runtime_identity(name, provenance="local")
    )
    assert ordinary["policyKey"] == name
    assert ordinary["allowed"] is False


@pytest.mark.parametrize(
    ("mutation", "path_kind"),
    [
        ("malformed-lock", "enterprise"),
        ("path-mismatch", "enterprise"),
        ("missing-lock-entry", "enterprise"),
        ("same-name-external", "external"),
        ("redirected-enterprise", "symlink"),
    ],
)
def test_invalid_enterprise_provenance_fails_closed(
    _isolate_hermes_home, monkeypatch, tmp_path, mutation, path_kind
):
    from hermes_constants import get_hermes_home
    from hermes_cli.enterprise_policy import skill_runtime_decision, skill_runtime_identity

    skills_root = get_hermes_home() / "skills"
    enterprise_md = _write_skill(
        skills_root, "enterprise/expense-review", "expense-review"
    )
    _write_enterprise_lock(skills_root, "expense-review")
    candidate = enterprise_md

    lock_path = skills_root / ".hub" / "lock.json"
    if mutation == "malformed-lock":
        lock_path.write_text("not json", encoding="utf-8")
    elif mutation == "path-mismatch":
        lock = json.loads(lock_path.read_text(encoding="utf-8"))
        lock["installed"]["expense-review"]["install_path"] = "enterprise/other"
        lock["installed"]["expense-review"]["path"] = "enterprise/other"
        lock_path.write_text(json.dumps(lock), encoding="utf-8")
    elif mutation == "missing-lock-entry":
        lock_path.write_text(json.dumps({"installed": {}}), encoding="utf-8")
    elif mutation == "same-name-external":
        candidate = _write_skill(tmp_path, "outside/expense-review", "expense-review")
    elif mutation == "redirected-enterprise":
        enterprise_md.unlink()
        outside_md = _write_skill(tmp_path, "redirect-target", "expense-review")
        try:
            enterprise_md.symlink_to(outside_md)
        except (OSError, NotImplementedError) as exc:
            pytest.skip(f"symlinks unavailable: {exc}")

    _write_policy(
        get_hermes_home(),
        monkeypatch,
        [{"key": "expense-review", "status": "available"}],
        manage=False,
    )
    identity = skill_runtime_identity("expense-review", skill_path=candidate)
    decision = skill_runtime_decision(identity)

    assert identity["provenance"] == "enterprise-invalid", (mutation, path_kind)
    assert decision["allowed"] is False
    assert decision["errorCode"] == "enterprise_skill_policy_denied"


def test_enterprise_directory_link_escape_is_denied_without_body_read(
    _isolate_hermes_home, monkeypatch, tmp_path
):
    from hermes_constants import get_hermes_home
    import tools.skills_tool as skills_tool

    home = get_hermes_home()
    skills_root = home / "skills"
    link = skills_root / "enterprise" / "expense-review"
    link.parent.mkdir(parents=True, exist_ok=True)
    outside_md = _write_skill(tmp_path, "outside", "expense-review")
    _link_directory(link, outside_md.parent)
    _write_enterprise_lock(skills_root, "expense-review")
    _write_policy(
        home,
        monkeypatch,
        [{"key": "expense-review", "status": "available"}],
    )
    monkeypatch.setattr(skills_tool, "SKILLS_DIR", skills_root)
    original_read_text = Path.read_text
    body_reads: list[Path] = []

    def _track(path, *args, **kwargs):
        if path.resolve(strict=False) == outside_md.resolve(strict=False):
            body_reads.append(path)
        return original_read_text(path, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", _track)
    payload = json.loads(skills_tool.skill_view("expense-review", preprocess=False))

    assert payload["errorCode"] == "enterprise_skill_policy_denied"
    assert payload["status"] == "invalid-provenance"
    assert "Secret body" not in json.dumps(payload)
    assert body_reads == []


def test_enterprise_linked_directory_escape_never_reads_external_content(
    _isolate_hermes_home, monkeypatch, tmp_path
):
    from hermes_constants import get_hermes_home
    import tools.skills_tool as skills_tool

    home = get_hermes_home()
    skills_root = home / "skills"
    skill_md = _write_skill(
        skills_root, "enterprise/expense-review", "expense-review"
    )
    references = skill_md.parent / "references"
    shutil.rmtree(references)
    outside = tmp_path / "outside-references"
    outside.mkdir()
    secret = outside / "secret.md"
    secret.write_text("EXTERNAL-LINKED-SENTINEL", encoding="utf-8")
    _link_directory(references, outside)
    _write_enterprise_lock(skills_root, "expense-review")
    _write_policy(
        home,
        monkeypatch,
        [{"key": "expense-review", "status": "available"}],
    )
    monkeypatch.setattr(skills_tool, "SKILLS_DIR", skills_root)
    original_read_text = Path.read_text
    linked_reads: list[Path] = []

    def _track(path, *args, **kwargs):
        if path.resolve(strict=False) == secret.resolve(strict=False):
            linked_reads.append(path)
        return original_read_text(path, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", _track)
    payload = json.loads(
        skills_tool.skill_view(
            "expense-review",
            file_path="references/secret.md",
            preprocess=False,
        )
    )

    assert payload["success"] is False
    assert "outside" in payload["error"].lower()
    assert "EXTERNAL-LINKED-SENTINEL" not in json.dumps(payload)
    assert linked_reads == []


@pytest.mark.parametrize(
    ("mutation", "content"),
    [
        ("missing-frontmatter", "# BODY-SENTINEL\n"),
        (
            "oversized-frontmatter",
            "---\nname: expense-review\ndescription: " + ("x" * (17 * 1024)) + "\n---\nBODY-SENTINEL\n",
        ),
        (
            "unterminated-frontmatter",
            "---\nname: expense-review\ndescription: never closed\nBODY-SENTINEL\n",
        ),
        (
            "invalid-yaml",
            "---\nname: [unterminated\n---\nBODY-SENTINEL\n",
        ),
        (
            "canonical-name-mismatch",
            "---\nname: other-skill\ndescription: tampered\n---\nBODY-SENTINEL\n",
        ),
    ],
)
def test_enterprise_frontmatter_tamper_fails_closed_before_body_read(
    _isolate_hermes_home, monkeypatch, mutation, content
):
    from hermes_constants import get_hermes_home
    from hermes_cli.enterprise_policy import skill_runtime_decision, skill_runtime_identity
    import tools.skills_tool as skills_tool

    home = get_hermes_home()
    skills_root = home / "skills"
    skill_md = _write_skill(
        skills_root, "enterprise/expense-review", "expense-review"
    )
    skill_md.write_text(content, encoding="utf-8")
    _write_enterprise_lock(skills_root, "expense-review")
    _write_policy(
        home,
        monkeypatch,
        [{"key": "expense-review", "status": "available"}],
        manage=False,
    )
    monkeypatch.setattr(skills_tool, "SKILLS_DIR", skills_root)

    identity = skill_runtime_identity("expense-review", skill_path=skill_md)
    decision = skill_runtime_decision(identity)
    payload = json.loads(skills_tool.skill_view("expense-review", preprocess=False))
    listed = json.loads(skills_tool.skills_list())

    assert identity["provenance"] == "enterprise-invalid", mutation
    assert decision["allowed"] is False, mutation
    assert payload["success"] is False, mutation
    assert payload["errorCode"] == "enterprise_skill_policy_denied", mutation
    assert "BODY-SENTINEL" not in json.dumps(payload), mutation
    assert listed["skills"] == [], mutation


def test_enterprise_invalid_error_uses_trusted_directory_key_and_leaks_no_name(
    _isolate_hermes_home, monkeypatch
):
    from hermes_constants import get_hermes_home
    import tools.skills_tool as skills_tool

    home = get_hermes_home()
    skills_root = home / "skills"
    skill_md = _write_skill(
        skills_root, "enterprise/expense-review", "expense-review"
    )
    untrusted_name = r"C:\private\secret-token-value"
    skill_md.write_text(
        f"---\nname: '{untrusted_name}'\ndescription: tampered\n---\nBODY-SENTINEL\n",
        encoding="utf-8",
    )
    _write_enterprise_lock(skills_root, "expense-review")
    _write_policy(
        home,
        monkeypatch,
        [{"key": "expense-review", "status": "available"}],
        manage=False,
    )
    monkeypatch.setattr(skills_tool, "SKILLS_DIR", skills_root)

    payload = json.loads(skills_tool.skill_view("expense-review", preprocess=False))
    serialized = json.dumps(payload)

    assert payload["success"] is False
    assert payload["policyKey"] == "expense-review"
    assert "private" not in serialized
    assert "secret-token-value" not in serialized
    assert "C:" not in serialized


@pytest.mark.parametrize("stale", [False, True])
def test_blocked_plugin_guard_precedes_disabled_and_stale_registry_checks(
    _isolate_hermes_home, monkeypatch, tmp_path, stale
):
    from hermes_constants import get_hermes_home
    import hermes_cli.plugins as plugins
    import tools.skills_tool as skills_tool

    plugin_md = tmp_path / "private" / "plugin-secret" / "SKILL.md"
    if not stale:
        plugin_md.parent.mkdir(parents=True)
        plugin_md.write_text("---\nname: danger\n---\nPLUGIN-BODY\n", encoding="utf-8")

    class _PluginManager:
        def find_plugin_skill(self, name):
            return plugin_md

        def remove_plugin_skill(self, name):
            pytest.fail("stale registry cleanup ran before enterprise guard")

        def list_plugin_skills(self, namespace):
            return ["danger"]

    manager = _PluginManager()
    _write_policy(
        get_hermes_home(),
        monkeypatch,
        [{"key": "acme:danger", "status": "blocked"}],
        manage=False,
    )
    monkeypatch.setattr(plugins, "discover_plugins", lambda: None)
    monkeypatch.setattr(plugins, "get_plugin_manager", lambda: manager)
    monkeypatch.setattr(plugins, "_get_disabled_plugins", lambda: {"acme"})

    payload = json.loads(skills_tool.skill_view("acme:danger", preprocess=False))
    linked = json.loads(
        skills_tool.skill_view(
            "acme:danger",
            file_path="references/secret.md",
            preprocess=False,
        )
    )
    serialized = json.dumps(payload)

    assert payload["errorCode"] == "enterprise_skill_policy_denied"
    assert payload["policyKey"] == "acme:danger"
    assert "PLUGIN-BODY" not in serialized
    assert str(tmp_path) not in serialized
    assert linked["errorCode"] == "enterprise_skill_policy_denied"


def test_plugin_linked_directory_escape_never_reads_external_content(
    _isolate_hermes_home, monkeypatch, tmp_path
):
    from hermes_constants import get_hermes_home
    import hermes_cli.plugins as plugins
    import tools.skills_tool as skills_tool

    plugin_dir = tmp_path / "plugins" / "acme" / "skills" / "safe"
    plugin_dir.mkdir(parents=True)
    plugin_md = plugin_dir / "SKILL.md"
    plugin_md.write_text(
        "---\nname: safe\ndescription: safe\n---\nPLUGIN-BODY\n",
        encoding="utf-8",
    )
    outside = tmp_path / "plugin-outside"
    outside.mkdir()
    secret = outside / "secret.md"
    secret.write_text("PLUGIN-EXTERNAL-SENTINEL", encoding="utf-8")
    _link_directory(plugin_dir / "references", outside)

    class _PluginManager:
        def find_plugin_skill(self, name):
            return plugin_md if name == "acme:safe" else None

        def list_plugin_skills(self, namespace):
            return ["safe"] if namespace == "acme" else []

    _write_policy(
        get_hermes_home(),
        monkeypatch,
        [{"key": "acme:safe", "status": "available"}],
    )
    monkeypatch.setattr(plugins, "discover_plugins", lambda: None)
    monkeypatch.setattr(plugins, "get_plugin_manager", lambda: _PluginManager())
    monkeypatch.setattr(plugins, "_get_disabled_plugins", lambda: set())
    original_read_text = Path.read_text
    linked_reads = []

    def _track(path, *args, **kwargs):
        if path.resolve(strict=False) == secret.resolve(strict=False):
            linked_reads.append(path)
        return original_read_text(path, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", _track)
    payload = json.loads(
        skills_tool.skill_view(
            "acme:safe",
            file_path="references/secret.md",
            preprocess=False,
        )
    )

    assert payload["success"] is False
    assert "PLUGIN-EXTERNAL-SENTINEL" not in json.dumps(payload)
    assert linked_reads == []


def test_skill_view_denies_main_and_linked_reads_before_runtime_setup(
    _isolate_hermes_home, monkeypatch
):
    from hermes_constants import get_hermes_home
    import tools.skills_tool as skills_tool

    skills_root = get_hermes_home() / "skills"
    _write_skill(skills_root, "enterprise/expense-review", "expense-review")
    _write_enterprise_lock(skills_root, "expense-review")
    _write_policy(
        get_hermes_home(),
        monkeypatch,
        [{"key": "expense-review", "status": "blocked"}],
        manage=True,
    )
    monkeypatch.setattr(skills_tool, "SKILLS_DIR", skills_root)
    import agent.skill_preprocessing as skill_preprocessing
    import tools.credential_files as credential_files
    import tools.skill_usage as skill_usage

    monkeypatch.setattr(
        skills_tool,
        "_capture_required_environment_variables",
        lambda *args, **kwargs: pytest.fail("runtime setup ran before policy guard"),
    )
    monkeypatch.setattr(
        skill_preprocessing,
        "preprocess_skill_content",
        lambda *args, **kwargs: pytest.fail("preprocess ran before policy guard"),
    )
    monkeypatch.setattr(
        credential_files,
        "register_credential_files",
        lambda *args, **kwargs: pytest.fail("credential capture ran before policy guard"),
    )
    monkeypatch.setattr(
        skill_usage,
        "bump_use",
        lambda *args, **kwargs: pytest.fail("usage bump ran before policy guard"),
    )
    monkeypatch.setattr(
        skill_usage,
        "bump_view",
        lambda *args, **kwargs: pytest.fail("view bump ran before policy guard"),
    )

    original_read_text = Path.read_text
    body_reads: list[Path] = []

    def _track_read_text(path, *args, **kwargs):
        if path in {
            skills_root / "enterprise" / "expense-review" / "SKILL.md",
            skills_root
            / "enterprise"
            / "expense-review"
            / "references"
            / "checklist.md",
        }:
            body_reads.append(path)
        return original_read_text(path, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", _track_read_text)

    main = json.loads(skills_tool.skill_view("expense-review"))
    linked = json.loads(
        skills_tool.skill_view("expense-review", file_path="references/checklist.md")
    )
    bumped = json.loads(skills_tool._skill_view_with_bump({"name": "expense-review"}))

    for payload in (main, linked, bumped):
        assert payload["success"] is False
        assert payload["errorCode"] == "enterprise_skill_policy_denied"
        assert payload["policyKey"] == "expense-review"
        assert "Secret body" not in json.dumps(payload)
        assert "linked secret" not in json.dumps(payload)
        assert "skills.manage" not in payload["error"]
    assert body_reads == []


def test_frontmatter_identity_reader_stops_before_body(tmp_path):
    from tools.skills_tool import _read_frontmatter_only

    skill_md = tmp_path / "SKILL.md"
    body = "BODY-SENTINEL" * 20000
    skill_md.write_text(
        "---\nname: bounded\ndescription: Bounded metadata.\n---\n" + body,
        encoding="utf-8",
    )

    frontmatter = _read_frontmatter_only(skill_md, max_bytes=256, max_lines=8)

    assert frontmatter["name"] == "bounded"


def test_blocked_enterprise_discovery_does_not_read_body(
    _isolate_hermes_home, monkeypatch
):
    from hermes_constants import get_hermes_home
    from agent.prompt_builder import build_skills_system_prompt, clear_skills_system_prompt_cache
    import tools.skills_tool as skills_tool

    skills_root = get_hermes_home() / "skills"
    skill_md = _write_skill(
        skills_root, "enterprise/expense-review", "expense-review"
    )
    _write_enterprise_lock(skills_root, "expense-review")
    _write_policy(
        get_hermes_home(),
        monkeypatch,
        [{"key": "expense-review", "status": "blocked"}],
        manage=True,
    )
    monkeypatch.setattr(skills_tool, "SKILLS_DIR", skills_root)
    original_read_text = Path.read_text
    body_reads: list[Path] = []

    def _track_read_text(path, *args, **kwargs):
        if path == skill_md:
            body_reads.append(path)
        return original_read_text(path, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", _track_read_text)
    clear_skills_system_prompt_cache(clear_snapshot=True)

    listed = json.loads(skills_tool.skills_list())
    prompt = build_skills_system_prompt()

    assert listed["skills"] == []
    assert "expense-review" not in prompt
    assert body_reads == []


def test_prompt_index_authorization_error_fails_closed_only_in_managed_mode(
    _isolate_hermes_home, monkeypatch
):
    from hermes_constants import get_hermes_home
    from agent.prompt_builder import _parse_skill_file
    import hermes_cli.enterprise_policy as enterprise_policy

    skill_md = _write_skill(
        get_hermes_home() / "skills", "custom/local-helper", "local-helper"
    )
    original_read_text = Path.read_text
    body_reads = []

    def _track(path, *args, **kwargs):
        if path == skill_md:
            body_reads.append(path)
        return original_read_text(path, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", _track)
    monkeypatch.setattr(
        enterprise_policy,
        "skill_runtime_identity",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("auth down")),
    )
    monkeypatch.setenv("HERMES_ENTERPRISE_MANAGED", "1")

    assert _parse_skill_file(skill_md)[0] is False
    assert body_reads == []

    monkeypatch.delenv("HERMES_ENTERPRISE_MANAGED")
    assert _parse_skill_file(skill_md)[0] is True


def test_slash_cache_tracks_policy_fingerprint_and_preload_denies(
    _isolate_hermes_home, monkeypatch
):
    from hermes_constants import get_hermes_home
    import agent.skill_commands as skill_commands
    import tools.skills_tool as skills_tool
    from hermes_cli.enterprise_policy import EnterpriseSkillPolicyDenied

    skills_root = get_hermes_home() / "skills"
    _write_skill(skills_root, "enterprise/expense-review", "expense-review")
    _write_enterprise_lock(skills_root, "expense-review")
    policy_path = _write_policy(
        get_hermes_home(),
        monkeypatch,
        [{"key": "expense-review", "status": "available"}],
        manage=False,
    )
    monkeypatch.setattr(skills_tool, "SKILLS_DIR", skills_root)
    skill_commands._skill_commands = {}
    skill_commands._skill_commands_platform = None
    skill_commands._skill_commands_policy_fingerprint = None

    assert "/expense-review" in skill_commands.get_skill_commands()

    policy = json.loads(policy_path.read_text(encoding="utf-8"))
    policy["toolPolicySnapshot"]["skills"][0]["status"] = "blocked"
    policy_path.write_text(json.dumps(policy), encoding="utf-8")

    assert "/expense-review" not in skill_commands.get_skill_commands()
    with pytest.raises(EnterpriseSkillPolicyDenied) as raised:
        skill_commands.build_preloaded_skills_prompt(["expense-review"])
    assert raised.value.error_code == "enterprise_skill_policy_denied"


def test_prompt_snapshot_keeps_denied_skill_metadata_for_policy_only_allow(
    _isolate_hermes_home, monkeypatch
):
    from hermes_constants import get_hermes_home
    from agent.prompt_builder import (
        build_skills_system_prompt,
        clear_skills_system_prompt_cache,
    )

    home = get_hermes_home()
    skills_root = home / "skills"
    _write_skill(skills_root, "enterprise/expense-review", "expense-review")
    _write_enterprise_lock(skills_root, "expense-review")
    policy_path = _write_policy(
        home,
        monkeypatch,
        [{"key": "expense-review", "status": "blocked"}],
        manage=False,
    )
    clear_skills_system_prompt_cache(clear_snapshot=True)

    blocked_prompt = build_skills_system_prompt()
    snapshot = json.loads((home / ".skills_prompt_snapshot.json").read_text(encoding="utf-8"))
    expense_entry = next(
        entry for entry in snapshot["skills"] if entry["frontmatter_name"] == "expense-review"
    )
    assert "expense-review" not in blocked_prompt
    assert expense_entry["description"] == "Runtime policy test."

    policy = json.loads(policy_path.read_text(encoding="utf-8"))
    policy["toolPolicySnapshot"]["skills"][0]["status"] = "available"
    policy_path.write_text(json.dumps(policy), encoding="utf-8")
    clear_skills_system_prompt_cache(clear_snapshot=False)

    allowed_prompt = build_skills_system_prompt()
    assert "expense-review: Runtime policy test." in allowed_prompt


def test_existing_session_prompt_bytes_do_not_change_after_policy_refresh(
    _isolate_hermes_home, monkeypatch
):
    from types import SimpleNamespace
    from hermes_constants import get_hermes_home
    from agent.prompt_builder import (
        build_skills_system_prompt,
        clear_skills_system_prompt_cache,
    )
    import tools.skills_tool as skills_tool

    home = get_hermes_home()
    skills_root = home / "skills"
    _write_skill(skills_root, "enterprise/expense-review", "expense-review")
    _write_enterprise_lock(skills_root, "expense-review")
    policy_path = _write_policy(
        home,
        monkeypatch,
        [{"key": "expense-review", "status": "available"}],
    )
    monkeypatch.setattr(skills_tool, "SKILLS_DIR", skills_root)
    clear_skills_system_prompt_cache(clear_snapshot=True)
    agent = SimpleNamespace(_cached_system_prompt=build_skills_system_prompt())
    before = agent._cached_system_prompt.encode("utf-8")

    policy = json.loads(policy_path.read_text(encoding="utf-8"))
    policy["toolPolicySnapshot"]["skills"][0]["status"] = "blocked"
    policy_path.write_text(json.dumps(policy), encoding="utf-8")
    denied = json.loads(skills_tool.skill_view("expense-review", preprocess=False))

    assert denied["errorCode"] == "enterprise_skill_policy_denied"
    assert agent._cached_system_prompt.encode("utf-8") == before


def test_bundle_and_cron_abort_whole_operation_on_policy_denial(
    _isolate_hermes_home, monkeypatch
):
    from hermes_constants import get_hermes_home
    import agent.skill_bundles as skill_bundles
    import agent.skill_commands as skill_commands
    import tools.skills_tool as skills_tool
    import tools.skill_usage as skill_usage
    from cron.scheduler import _build_job_prompt
    from hermes_cli.enterprise_policy import EnterpriseSkillPolicyDenied

    home = get_hermes_home()
    skills_root = home / "skills"
    local_md = _write_skill(skills_root, "custom/local-helper", "local-helper")
    _write_skill(skills_root, "enterprise/expense-review", "expense-review")
    _write_enterprise_lock(skills_root, "expense-review")
    _write_policy(
        home,
        monkeypatch,
        [{"key": "expense-review", "status": "blocked"}],
        manage=True,
    )
    monkeypatch.setattr(skills_tool, "SKILLS_DIR", skills_root)
    bundles_dir = home / "skill-bundles"
    bundles_dir.mkdir(parents=True)
    (bundles_dir / "mixed.yaml").write_text(
        "name: mixed\nskills:\n  - local-helper\n  - expense-review\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("HERMES_BUNDLES_DIR", str(bundles_dir))
    skill_bundles._bundles_cache = {}
    skill_bundles._bundles_cache_mtime = None
    usage: list[str] = []
    monkeypatch.setattr(skill_usage, "bump_use", lambda name: usage.append(name))
    import agent.skill_preprocessing as skill_preprocessing
    import tools.credential_files as credential_files

    monkeypatch.setattr(
        skills_tool,
        "_capture_required_environment_variables",
        lambda *args, **kwargs: pytest.fail("environment capture ran during preflight"),
    )
    monkeypatch.setattr(
        skill_preprocessing,
        "preprocess_skill_content",
        lambda *args, **kwargs: pytest.fail("preprocess ran during preflight"),
    )
    monkeypatch.setattr(
        credential_files,
        "register_credential_files",
        lambda *args, **kwargs: pytest.fail("credential registration ran during preflight"),
    )
    original_read_text = Path.read_text

    def _deny_allowed_body_read(path, *args, **kwargs):
        if path == local_md:
            pytest.fail("allowed-first Skill body was read before whole-operation authorization")
        return original_read_text(path, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", _deny_allowed_body_read)

    with pytest.raises(EnterpriseSkillPolicyDenied):
        skill_bundles.build_bundle_invocation_message("/mixed")
    assert usage == []

    with pytest.raises(EnterpriseSkillPolicyDenied):
        skill_commands.build_auto_loaded_skills_message(
            ["local-helper", "expense-review"],
            "user text",
        )
    assert usage == []

    with pytest.raises(EnterpriseSkillPolicyDenied):
        _build_job_prompt({"id": "job-1", "prompt": "run", "skills": ["local-helper", "expense-review"]})
    assert usage == []

    with pytest.raises(EnterpriseSkillPolicyDenied):
        _build_job_prompt({"id": "job-2", "prompt": "run", "skills": ["mixed"]})
    assert usage == []


def test_cron_run_denial_precedes_script_session_agent_and_usage(
    _isolate_hermes_home, monkeypatch
):
    from hermes_constants import get_hermes_home
    import cron.scheduler as scheduler
    import hermes_state
    import tools.skill_usage as skill_usage
    import tools.skills_tool as skills_tool

    home = get_hermes_home()
    skills_root = home / "skills"
    _write_skill(skills_root, "enterprise/expense-review", "expense-review")
    _write_enterprise_lock(skills_root, "expense-review")
    _write_policy(
        home,
        monkeypatch,
        [{"key": "expense-review", "status": "blocked"}],
    )
    monkeypatch.setattr(skills_tool, "SKILLS_DIR", skills_root)
    monkeypatch.setattr(
        scheduler,
        "_run_job_script",
        lambda *_args, **_kwargs: pytest.fail("pre-run script executed before denial"),
    )
    monkeypatch.setattr(
        hermes_state,
        "SessionDB",
        lambda *_args, **_kwargs: pytest.fail("SessionDB created before denial"),
    )
    monkeypatch.setattr(
        skill_usage,
        "bump_use",
        lambda *_args, **_kwargs: pytest.fail("usage bumped before denial"),
    )

    success, document, response, error = scheduler.run_job(
        {
            "id": "job-blocked",
            "name": "Blocked Job",
            "prompt": "run",
            "script": "must-not-run.sh",
            "skills": ["expense-review"],
        }
    )

    assert success is False
    assert response == ""
    assert error == "enterprise_skill_policy_denied"
    assert "enterprise_skill_policy_denied" in document
    assert "expense-review" not in document
    assert "Secret body" not in document


def test_cron_run_reuses_initial_policy_snapshot_after_file_refresh(
    _isolate_hermes_home, monkeypatch
):
    from hermes_constants import get_hermes_home
    from hermes_cli.enterprise_policy import skill_runtime_decision
    import cron.scheduler as scheduler
    import hermes_state
    import tools.skills_tool as skills_tool

    home = get_hermes_home()
    skills_root = home / "skills"
    skill_md = _write_skill(
        skills_root, "enterprise/expense-review", "expense-review"
    )
    _write_enterprise_lock(skills_root, "expense-review")
    policy_path = _write_policy(
        home,
        monkeypatch,
        [{"key": "expense-review", "status": "available"}],
    )
    monkeypatch.setattr(skills_tool, "SKILLS_DIR", skills_root)

    def _flip_policy_on_session_start():
        policy = json.loads(policy_path.read_text(encoding="utf-8"))
        policy["toolPolicySnapshot"]["skills"][0]["status"] = "blocked"
        policy_path.write_text(json.dumps(policy), encoding="utf-8")
        return object()

    def _assert_frozen_policy(_job, prerun_script=None):
        identity = {
            "policyKey": "expense-review",
            "provenance": "enterprise",
        }
        assert skill_runtime_decision(identity)["allowed"] is True
        return None

    monkeypatch.setattr(hermes_state, "SessionDB", _flip_policy_on_session_start)
    monkeypatch.setattr(
        scheduler,
        "_build_job_prompt_with_policy",
        _assert_frozen_policy,
    )

    success, document, response, error = scheduler.run_job(
        {
            "id": "job-frozen",
            "name": "Frozen Job",
            "prompt": "run",
            "skills": ["expense-review"],
        }
    )

    assert success is True
    assert document == ""
    assert response == scheduler.SILENT_MARKER
    assert error is None
    assert json.loads(policy_path.read_text(encoding="utf-8"))[
        "toolPolicySnapshot"
    ]["skills"][0]["status"] == "blocked"

def test_bundle_uses_one_policy_snapshot_when_file_changes_between_members(
    _isolate_hermes_home, monkeypatch
):
    from hermes_constants import get_hermes_home
    import agent.skill_bundles as skill_bundles
    import tools.skills_tool as skills_tool

    home = get_hermes_home()
    skills_root = home / "skills"
    first_md = _write_skill(skills_root, "enterprise/first-skill", "first-skill")
    _write_skill(skills_root, "enterprise/second-skill", "second-skill")
    _write_enterprise_locks(skills_root, ["first-skill", "second-skill"])
    policy_path = _write_policy(
        home,
        monkeypatch,
        [
            {"key": "first-skill", "status": "available"},
            {"key": "second-skill", "status": "available"},
        ],
        manage=False,
    )
    monkeypatch.setattr(skills_tool, "SKILLS_DIR", skills_root)
    bundles_dir = home / "skill-bundles"
    bundles_dir.mkdir(parents=True)
    (bundles_dir / "atomic.yaml").write_text(
        "name: atomic\nskills:\n  - first-skill\n  - second-skill\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("HERMES_BUNDLES_DIR", str(bundles_dir))
    skill_bundles._bundles_cache = {}
    skill_bundles._bundles_cache_mtime = None
    original_read_text = Path.read_text
    flipped = False

    def _flip_policy_after_first_body(path, *args, **kwargs):
        nonlocal flipped
        content = original_read_text(path, *args, **kwargs)
        if path == first_md and not flipped:
            flipped = True
            policy = json.loads(original_read_text(policy_path, encoding="utf-8"))
            policy["toolPolicySnapshot"]["skills"][1]["status"] = "blocked"
            policy_path.write_text(json.dumps(policy), encoding="utf-8")
        return content

    monkeypatch.setattr(Path, "read_text", _flip_policy_after_first_body)

    result = skill_bundles.build_bundle_invocation_message("/atomic")

    assert flipped is True
    assert result is not None
    message, loaded, missing = result
    assert loaded == ["first-skill", "second-skill"]
    assert missing == []
    assert message.count("# Secret body") == 2


def test_blueprint_guard_runs_before_body_read(_isolate_hermes_home, monkeypatch):
    from hermes_constants import get_hermes_home
    from hermes_cli.enterprise_policy import EnterpriseSkillPolicyDenied
    import tools.blueprints as blueprints
    import tools.skills_hub as skills_hub

    skills_root = get_hermes_home() / "skills"
    skill_md = _write_skill(
        skills_root, "enterprise/expense-review", "expense-review"
    )
    skill_md.write_text(
        "---\nname: expense-review\ndescription: Blueprint.\nmetadata:\n"
        "  hermes:\n    blueprint:\n      schedule: '0 9 * * *'\n---\n\nBODY-SENTINEL\n",
        encoding="utf-8",
    )
    _write_enterprise_lock(skills_root, "expense-review")
    _write_policy(
        get_hermes_home(),
        monkeypatch,
        [{"key": "expense-review", "status": "blocked"}],
        manage=True,
    )
    monkeypatch.setattr(skills_hub, "SKILLS_DIR", skills_root)
    original_read_text = Path.read_text
    body_reads: list[Path] = []

    def _track_read_text(path, *args, **kwargs):
        if path == skill_md:
            body_reads.append(path)
        return original_read_text(path, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", _track_read_text)

    with pytest.raises(EnterpriseSkillPolicyDenied):
        blueprints.blueprint_spec_for_installed("expense-review")
    assert body_reads == []


def test_ordinary_unknown_skill_remains_loadable_in_managed_mode(
    _isolate_hermes_home, monkeypatch
):
    from hermes_constants import get_hermes_home
    import tools.skills_tool as skills_tool

    skills_root = get_hermes_home() / "skills"
    _write_skill(skills_root, "custom/local-helper", "local-helper")
    _write_policy(get_hermes_home(), monkeypatch, [], manage=False)
    monkeypatch.setattr(skills_tool, "SKILLS_DIR", skills_root)

    payload = json.loads(skills_tool.skill_view("local-helper", preprocess=False))

    assert payload["success"] is True
    assert payload["name"] == "local-helper"
    assert "Secret body" in payload["content"]


def test_ordinary_malformed_local_frontmatter_remains_loadable_in_managed_mode(
    _isolate_hermes_home, monkeypatch
):
    from hermes_constants import get_hermes_home
    import tools.skills_tool as skills_tool

    home = get_hermes_home()
    skills_root = home / "skills"
    skill_md = _write_skill(skills_root, "custom/local-helper", "local-helper")
    skill_md.write_text(
        "---\nname: [unterminated\n---\nLOCAL-BODY-SENTINEL\n",
        encoding="utf-8",
    )
    _write_policy(home, monkeypatch, [], manage=False)
    monkeypatch.setattr(skills_tool, "SKILLS_DIR", skills_root)

    payload = json.loads(skills_tool.skill_view("local-helper", preprocess=False))

    assert payload["success"] is True
    assert "LOCAL-BODY-SENTINEL" in payload["content"]


def test_cmd_chat_maps_preload_policy_denial_to_stable_user_error(
    monkeypatch, capsys
):
    import sys
    import types

    import hermes_cli.main as main_mod
    from hermes_cli._parser import build_top_level_parser
    from hermes_cli.enterprise_policy import EnterpriseSkillPolicyDenied

    parser, _subparsers, chat_parser = build_top_level_parser()
    chat_parser.set_defaults(func=main_mod.cmd_chat)
    args = parser.parse_args(["chat", "--skills", "expense-review"])
    fake_cli = types.ModuleType("cli")

    def _deny_preload(**kwargs):
        raise EnterpriseSkillPolicyDenied(
            {
                "policyKey": "expense-review",
                "status": "blocked",
                "reason": "enterprise_skill_policy_denied",
                "provenance": "enterprise",
                "policyHash": "safe-hash",
            }
        )

    fake_cli.main = _deny_preload
    fake_banner = types.ModuleType("hermes_cli.banner")
    fake_banner.prefetch_update_check = lambda: None
    fake_skills_sync = types.ModuleType("tools.skills_sync")
    fake_skills_sync.sync_skills = lambda quiet=True: None
    monkeypatch.setitem(sys.modules, "cli", fake_cli)
    monkeypatch.setitem(sys.modules, "hermes_cli.banner", fake_banner)
    monkeypatch.setitem(sys.modules, "tools.skills_sync", fake_skills_sync)
    monkeypatch.setattr(main_mod, "_has_any_provider_configured", lambda: True)
    monkeypatch.setattr(main_mod, "_pin_kanban_board_env", lambda: None)

    with pytest.raises(SystemExit) as raised:
        main_mod.cmd_chat(args)

    output = capsys.readouterr().out
    assert raised.value.code == 1
    assert "enterprise_skill_policy_denied" in output
    assert "expense-review" in output
    assert "Traceback" not in output
