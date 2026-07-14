"""Profile-safe installer for Enterprise Skill Hub artifacts.

The enterprise gateway is responsible for authentication and artifact
download.  This module accepts the already-downloaded ZIP plus immutable
metadata, re-verifies the complete artifact, extracts it defensively, runs the
Hermes Skills Guard over every file, and installs it below the standard
Hermes skills root.  It deliberately does not add a second skill loader or a
second lock file.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from io import BytesIO
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import unicodedata
import uuid
import zipfile
from typing import Any, Dict, Iterable, List, Mapping, Optional, Tuple

from hermes_constants import get_hermes_home


# These values are mirrored by contracts/enterprise-skill-hub/v1/contract.json.
# The contract tests assert the relationship so either side cannot drift.
MAX_ARTIFACT_BYTES = 50 * 1024 * 1024
MAX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024
MAX_FILE_COUNT = 1000
MAX_SINGLE_FILE_BYTES = 50 * 1024 * 1024
MAX_SKILL_NAME_LENGTH = 64

ENTERPRISE_INSTALL_PREFIX = "enterprise"
ENTERPRISE_SOURCE = "enterprise"
ENTERPRISE_TRUST_LEVEL = "community"

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_WINDOWS_RESERVED = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}


@dataclass(frozen=True)
class EnterpriseArtifactMetadata:
    key: str
    revision: int
    artifact_sha256: str


class EnterpriseSkillInstallError(Exception):
    """Expected, structured failure at the local enterprise install boundary."""

    def __init__(self, code: str, message: str, status_code: int = 400):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code

    def as_detail(self) -> Dict[str, str]:
        return {"code": self.code, "message": self.message}


def _fail(code: str, message: str, status_code: int = 400) -> None:
    raise EnterpriseSkillInstallError(code, message, status_code)


def _ordinal_ignore_case_key(value: str) -> str:
    """Approximate Unicode simple folding without multi-character expansion.

    The shared contract calls for ordinal-ignore-case path comparison, not
    locale-aware matching and not full casefold (where ``ß`` would collide
    with the two-character string ``ss``). Python exposes full casefold, so we
    retain a code point when folding would expand it.
    """

    folded = []
    for char in value:
        candidate = char.casefold()
        folded.append(candidate if len(candidate) == 1 else char)
    return "".join(folded)


def validate_skill_name(value: str) -> str:
    """Validate the shared enterprise skill-key / SKILL.md name grammar."""

    if not isinstance(value, str):
        _fail("invalid_skill_key", "skill key must be a string")
    name = value.strip()
    if not name or name != value or len(name) > MAX_SKILL_NAME_LENGTH:
        _fail("invalid_skill_key", "skill key is empty, padded, or too long")
    if name in {".", ".."} or name.endswith((".", " ")):
        _fail("invalid_skill_key", "skill key is not a safe directory name")
    if name.split(".", 1)[0].upper() in _WINDOWS_RESERVED:
        _fail("invalid_skill_key", "skill key is a reserved Windows name")
    for char in name:
        category = unicodedata.category(char)
        if char not in "._-" and not category.startswith(("L", "N")):
            _fail(
                "invalid_skill_key",
                "skill key may contain only Unicode letters, numbers, '.', '_' and '-'",
            )
    return name


def validate_metadata(key: str, revision: Any, artifact_sha256: str) -> EnterpriseArtifactMetadata:
    safe_key = validate_skill_name(key)
    if isinstance(revision, bool):
        _fail("invalid_package", "revision must be a positive integer")
    try:
        parsed_revision = int(revision)
    except (TypeError, ValueError):
        _fail("invalid_package", "revision must be a positive integer")
    if str(parsed_revision) != str(revision).strip() or parsed_revision < 1:
        _fail("invalid_package", "revision must be a positive integer")
    digest = str(artifact_sha256 or "").strip().lower()
    if not _SHA256_RE.fullmatch(digest):
        _fail("artifact_hash_mismatch", "artifact SHA-256 must be 64 lowercase hex characters")
    return EnterpriseArtifactMetadata(safe_key, parsed_revision, digest)


def _normalize_zip_path(raw_name: str) -> str:
    if not raw_name or "\x00" in raw_name:
        _fail("invalid_package", "ZIP entry has an empty or NUL-containing path")
    raw = raw_name.replace("\\", "/")
    if raw.startswith(("/", "//")) or re.match(r"^[A-Za-z]:", raw):
        _fail("invalid_package", f"ZIP entry uses an absolute path: {raw_name!r}")
    path = PurePosixPath(raw)
    if path.is_absolute() or any(part == ".." for part in path.parts):
        _fail("invalid_package", f"ZIP entry escapes the skill root: {raw_name!r}")
    parts = [part for part in path.parts if part not in {"", "."}]
    if not parts:
        _fail("invalid_package", f"ZIP entry has no usable path: {raw_name!r}")
    for part in parts:
        if part.endswith((".", " ")) or ":" in part:
            _fail("invalid_package", f"ZIP entry is not portable: {raw_name!r}")
        if part.split(".", 1)[0].upper() in _WINDOWS_RESERVED:
            _fail("invalid_package", f"ZIP entry uses a reserved name: {raw_name!r}")
    return "/".join(parts)


def _zip_entry_kind(info: zipfile.ZipInfo) -> str:
    """Return file/dir while rejecting links, devices, and reparse entries."""

    # The lower DOS attribute word carries FILE_ATTRIBUTE_REPARSE_POINT.
    if (info.external_attr & 0xFFFF) & 0x0400:
        _fail("invalid_package", f"ZIP entry is a reparse point: {info.filename!r}")

    unix_mode = (info.external_attr >> 16) & 0xFFFF
    if unix_mode:
        kind = stat.S_IFMT(unix_mode)
        if kind == stat.S_IFLNK:
            _fail("invalid_package", f"ZIP entry is a symlink: {info.filename!r}")
        if kind not in {0, stat.S_IFREG, stat.S_IFDIR}:
            _fail("invalid_package", f"ZIP entry is not a regular file: {info.filename!r}")
    return "dir" if info.is_dir() else "file"


def _validated_inventory(zf: zipfile.ZipFile) -> List[Tuple[zipfile.ZipInfo, str, str]]:
    inventory: List[Tuple[zipfile.ZipInfo, str, str]] = []
    exact: set[str] = set()
    folded: Dict[str, str] = {}
    file_paths: set[str] = set()
    file_count = 0
    declared_total = 0

    for info in zf.infolist():
        rel = _normalize_zip_path(info.filename)
        kind = _zip_entry_kind(info)
        if rel in exact:
            _fail("invalid_package", f"ZIP contains duplicate path: {rel}")
        exact.add(rel)

        folded_rel = _ordinal_ignore_case_key(rel)
        previous = folded.get(folded_rel)
        if previous is not None and previous != rel:
            _fail("invalid_package", f"ZIP paths collide by case: {previous!r}, {rel!r}")
        folded[folded_rel] = rel

        ancestors = list(PurePosixPath(rel).parents)[:-1]
        if any(parent.as_posix() in file_paths for parent in ancestors):
            _fail("invalid_package", f"ZIP file is also used as a directory: {rel}")
        if kind == "file":
            prefix = rel + "/"
            if any(existing.startswith(prefix) for existing in exact):
                _fail("invalid_package", f"ZIP directory is also used as a file: {rel}")
            file_paths.add(rel)
            file_count += 1
            if file_count > MAX_FILE_COUNT:
                _fail("too_many_files", f"ZIP exceeds the {MAX_FILE_COUNT} file limit", 413)
            if info.file_size > MAX_SINGLE_FILE_BYTES:
                _fail("file_too_large", f"ZIP entry exceeds the single-file limit: {rel}", 413)
            declared_total += info.file_size
            if declared_total > MAX_UNCOMPRESSED_BYTES:
                _fail("extracted_content_too_large", "ZIP exceeds the uncompressed-size limit", 413)
        inventory.append((info, rel, kind))
    return inventory


def _verify_extracted_tree(root: Path) -> None:
    """Reject redirects created or substituted during extraction."""

    root_resolved = root.resolve()
    for path in root.rglob("*"):
        try:
            mode = path.lstat().st_mode
        except OSError as exc:
            _fail("invalid_package", f"could not inspect extracted path: {exc}")
        if stat.S_ISLNK(mode) or (hasattr(path, "is_junction") and path.is_junction()):
            _fail("invalid_package", f"extracted path is a link: {path.name}")
        attrs = getattr(path.stat(follow_symlinks=False), "st_file_attributes", 0)
        if attrs & 0x0400:
            _fail("invalid_package", f"extracted path is a reparse point: {path.name}")
        try:
            if not path.resolve().is_relative_to(root_resolved):
                _fail("invalid_package", f"extracted path escapes quarantine: {path.name}")
        except OSError as exc:
            _fail("invalid_package", f"could not resolve extracted path: {exc}")


def _is_path_redirect(path: Path) -> bool:
    if path.is_symlink() or (hasattr(path, "is_junction") and path.is_junction()):
        return True
    try:
        attrs = getattr(path.stat(follow_symlinks=False), "st_file_attributes", 0)
    except OSError:
        return False
    return bool(attrs & 0x0400)


def _require_safe_install_directories(skills_root: Path) -> None:
    """Create standard parents while refusing symlink/junction redirects."""

    if _is_path_redirect(skills_root):
        _fail("skill_name_conflict", "enterprise skill storage contains a path redirect", 409)
    skills_root.mkdir(parents=True, exist_ok=True)
    if _is_path_redirect(skills_root):
        _fail("skill_name_conflict", "enterprise skill storage contains a path redirect", 409)
    for path in (
        skills_root / ".hub",
        skills_root / ".hub" / "quarantine",
        skills_root / ENTERPRISE_INSTALL_PREFIX,
    ):
        if _is_path_redirect(path):
            _fail("skill_name_conflict", "enterprise skill storage contains a path redirect", 409)
        path.mkdir(parents=False, exist_ok=True)
        if _is_path_redirect(path):
            _fail("skill_name_conflict", "enterprise skill storage contains a path redirect", 409)


def _extract_zip(artifact: bytes, destination: Path) -> List[str]:
    files: List[str] = []
    actual_total = 0
    try:
        with zipfile.ZipFile(BytesIO(artifact), "r") as zf:
            inventory = _validated_inventory(zf)
            for info, rel, kind in inventory:
                target = destination.joinpath(*PurePosixPath(rel).parts)
                if kind == "dir":
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                written = 0
                with zf.open(info, "r") as src, target.open("xb") as dst:
                    while True:
                        chunk = src.read(1024 * 1024)
                        if not chunk:
                            break
                        written += len(chunk)
                        actual_total += len(chunk)
                        if written > MAX_SINGLE_FILE_BYTES:
                            _fail("file_too_large", f"ZIP entry exceeds the single-file limit: {rel}", 413)
                        if actual_total > MAX_UNCOMPRESSED_BYTES:
                            _fail("extracted_content_too_large", "ZIP exceeds the uncompressed-size limit", 413)
                        dst.write(chunk)
                if written != info.file_size:
                    _fail("invalid_package", f"ZIP entry size does not match its header: {rel}")
                files.append(rel)
    except EnterpriseSkillInstallError:
        raise
    except (zipfile.BadZipFile, RuntimeError, EOFError, OSError) as exc:
        _fail("invalid_package", f"artifact is not a valid readable ZIP: {exc}")
    _verify_extracted_tree(destination)
    return sorted(files)


def _strict_frontmatter_name(skill_md: Path) -> str:
    try:
        content = skill_md.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        _fail("invalid_package", f"SKILL.md must be readable UTF-8: {exc}")
    if not content.startswith("---"):
        _fail("invalid_package", "SKILL.md must start with YAML frontmatter")
    match = re.search(r"\A---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|\Z)", content, re.DOTALL)
    if not match:
        _fail("invalid_package", "SKILL.md has unterminated YAML frontmatter")
    try:
        import yaml
        parsed = yaml.safe_load(match.group(1))
    except Exception as exc:
        _fail("invalid_package", f"SKILL.md frontmatter is invalid YAML: {exc}")
    if not isinstance(parsed, dict) or not isinstance(parsed.get("name"), str):
        _fail("invalid_package", "SKILL.md frontmatter must contain a string name")
    return validate_skill_name(parsed["name"])


def _enterprise_metadata(entry: Mapping[str, Any]) -> Tuple[Optional[str], Optional[int], Optional[str]]:
    metadata = entry.get("metadata")
    if not isinstance(metadata, dict):
        return None, None, None
    key = metadata.get("enterprise_key")
    revision = metadata.get("enterprise_revision")
    digest = metadata.get("artifact_sha256")
    try:
        revision = int(revision) if revision is not None else None
    except (TypeError, ValueError):
        revision = None
    return (
        str(key) if key is not None else None,
        revision,
        str(digest).lower() if digest is not None else None,
    )


def _existing_enterprise_entry(
    lock_data: Mapping[str, Any], metadata: EnterpriseArtifactMetadata
) -> Tuple[Optional[str], Optional[Mapping[str, Any]]]:
    installed = lock_data.get("installed", {})
    for name, entry in installed.items():
        if not isinstance(entry, dict) or entry.get("source") != ENTERPRISE_SOURCE:
            continue
        key, _revision, _digest = _enterprise_metadata(entry)
        if key == metadata.key:
            return str(name), entry
    return None, None


def _iter_skill_names(root: Path) -> Iterable[Tuple[str, Path]]:
    if not root.is_dir():
        return
    from agent.skill_utils import iter_skill_index_files
    for skill_md in iter_skill_index_files(root, "SKILL.md"):
        try:
            from tools.skills_tool import _parse_frontmatter
            frontmatter, _ = _parse_frontmatter(skill_md.read_text(encoding="utf-8")[:65536])
            name = frontmatter.get("name", skill_md.parent.name)
            if isinstance(name, str) and name:
                yield name, skill_md.parent
        except (OSError, UnicodeDecodeError):
            continue


def _find_name_conflict(name: str, skills_root: Path, target: Path) -> Optional[Path]:
    wanted = _ordinal_ignore_case_key(name)
    from agent.skill_utils import get_external_skills_dirs

    for root in [skills_root, *get_external_skills_dirs()]:
        for existing_name, path in _iter_skill_names(root):
            if path == target:
                continue
            if _ordinal_ignore_case_key(existing_name) == wanted:
                return path

    # Plugin skills are namespaced for explicit loading, but their bare name
    # still participates in the enterprise no-shadowing boundary.
    try:
        from hermes_cli.plugins import discover_plugins, get_plugin_manager
        discover_plugins()
        manager = get_plugin_manager()
        for plugin in manager.list_plugins():
            for bare_name in manager.list_plugin_skills(plugin["name"]):
                if _ordinal_ignore_case_key(bare_name) == wanted:
                    return Path(f"plugin:{plugin['name']}:{bare_name}")
    except Exception:
        # The enterprise no-shadowing rule covers plugin skills too. If plugin
        # discovery cannot produce a complete inventory, installation must not
        # continue on an unproven collision boundary.
        _fail(
            "skill_name_conflict",
            "could not verify plugin skill-name conflicts",
            409,
        )
    return None


def _lock_entry(
    metadata: EnterpriseArtifactMetadata,
    files: List[str],
    install_path: str,
) -> Dict[str, Any]:
    now = datetime.now(timezone.utc).isoformat()
    return {
        "source": ENTERPRISE_SOURCE,
        "key": metadata.key,
        "revision": metadata.revision,
        "artifactSha256": metadata.artifact_sha256,
        "path": install_path,
        "identifier": metadata.key,
        "trust_level": ENTERPRISE_TRUST_LEVEL,
        "scan_verdict": "safe",
        "content_hash": metadata.artifact_sha256,
        "install_path": install_path,
        "files": files,
        "metadata": {
            "enterprise_key": metadata.key,
            "enterprise_revision": metadata.revision,
            "artifact_sha256": metadata.artifact_sha256,
        },
        "installed_at": now,
        "updated_at": now,
    }


def _result_payload(metadata: EnterpriseArtifactMetadata, name: str) -> Dict[str, Any]:
    return {
        "key": metadata.key,
        "name": name,
        "revision": metadata.revision,
        "artifactSha256": metadata.artifact_sha256,
        "state": "installed",
    }


def install_enterprise_skill(
    artifact: bytes,
    *,
    key: str,
    revision: Any,
    artifact_sha256: str,
) -> Dict[str, Any]:
    """Validate and atomically install one enterprise skill artifact."""

    metadata = validate_metadata(key, revision, artifact_sha256)
    if not isinstance(artifact, (bytes, bytearray, memoryview)) or not artifact:
        _fail("invalid_package", "artifact body must be a non-empty ZIP")
    artifact_bytes = bytes(artifact)
    if len(artifact_bytes) > MAX_ARTIFACT_BYTES:
        _fail("artifact_too_large", f"artifact exceeds the {MAX_ARTIFACT_BYTES} byte limit", 413)
    actual_sha = hashlib.sha256(artifact_bytes).hexdigest()
    if actual_sha != metadata.artifact_sha256:
        _fail("artifact_hash_mismatch", "artifact SHA-256 does not match metadata")

    home = get_hermes_home()
    skills_root = home / "skills"
    enterprise_root = skills_root / ENTERPRISE_INSTALL_PREFIX
    target = enterprise_root / metadata.key
    lock_path = skills_root / ".hub" / "lock.json"
    quarantine_parent = skills_root / ".hub" / "quarantine"

    _require_safe_install_directories(skills_root)
    quarantine = quarantine_parent / f"enterprise-{uuid.uuid4().hex}"
    skill_root = quarantine / metadata.key
    skill_root.mkdir(parents=True, exist_ok=False)
    moved = False
    committed = False
    try:
        files = _extract_zip(artifact_bytes, skill_root)
        skill_md = skill_root / "SKILL.md"
        if not skill_md.is_file():
            _fail("invalid_package", "ZIP root must contain SKILL.md")
        declared_name = _strict_frontmatter_name(skill_md)
        if declared_name != metadata.key:
            _fail("skill_name_mismatch", "SKILL.md name must exactly match the enterprise skill key")

        from tools.skills_guard import scan_skill, should_allow_install
        scan = scan_skill(
            skill_root,
            source=ENTERPRISE_SOURCE,
            honor_ignore_files=False,
        )
        allowed, reason = should_allow_install(scan, force=False)
        if allowed is not True:
            _fail("skill_scan_rejected", reason, 422)

        from tools.skills_hub import HubLockFile, HubLockFileError
        lock = HubLockFile(lock_path)
        try:
            with lock.exclusive():
                try:
                    lock_data = lock.load_locked(strict=True)
                except HubLockFileError as exc:
                    _fail("skill_lock_invalid", str(exc), 500)

                existing_name, existing_entry = _existing_enterprise_entry(lock_data, metadata)
                if existing_entry is not None:
                    _key, old_revision, old_sha = _enterprise_metadata(existing_entry)
                    installed_skill_md = target / "SKILL.md"
                    if (
                        existing_name == metadata.key
                        and old_revision == metadata.revision
                        and old_sha == metadata.artifact_sha256
                        and not _is_path_redirect(target)
                        and not _is_path_redirect(installed_skill_md)
                        and target.is_dir()
                        and installed_skill_md.is_file()
                    ):
                        return _result_payload(metadata, metadata.key)
                    if old_revision != metadata.revision:
                        _fail("update_not_supported", "enterprise skill updates are not supported in P1", 409)
                    _fail("skill_name_conflict", "enterprise skill provenance conflicts with the requested artifact", 409)

                conflict = _find_name_conflict(metadata.key, skills_root, target)
                if conflict is not None or target.exists() or _is_path_redirect(target):
                    _fail("skill_name_conflict", f"a skill named {metadata.key!r} already exists", 409)

                os.replace(skill_root, target)
                moved = True
                lock_data["installed"][metadata.key] = _lock_entry(
                    metadata,
                    files,
                    f"{ENTERPRISE_INSTALL_PREFIX}/{metadata.key}",
                )
                try:
                    lock.save_locked(lock_data)
                    committed = True
                except OSError as exc:
                    shutil.rmtree(target, ignore_errors=True)
                    moved = False
                    _fail("skill_lock_write_failed", f"could not persist skill lock: {exc}", 500)
        except HubLockFileError as exc:
            _fail("skill_lock_write_failed", str(exc), 500)

        try:
            from agent.prompt_builder import clear_skills_system_prompt_cache
            clear_skills_system_prompt_cache(clear_snapshot=True)
        except Exception:
            pass
        return _result_payload(metadata, metadata.key)
    finally:
        if moved and not committed and target.exists():
            shutil.rmtree(target, ignore_errors=True)
        shutil.rmtree(quarantine, ignore_errors=True)


def list_installed_enterprise_skills() -> Dict[str, Any]:
    """Return enterprise-provenance entries from the standard Hub lock."""

    skills_root = get_hermes_home() / "skills"
    from tools.skills_hub import HubLockFile, HubLockFileError
    lock = HubLockFile(skills_root / ".hub" / "lock.json")
    try:
        with lock.exclusive():
            lock_data = lock.load_locked(strict=True)
    except HubLockFileError as exc:
        _fail("skill_lock_invalid", str(exc), 500)
    installed: List[Dict[str, Any]] = []
    for name, entry in lock_data["installed"].items():
        if not isinstance(entry, dict) or entry.get("source") != ENTERPRISE_SOURCE:
            continue
        try:
            safe_name = validate_skill_name(str(name))
        except EnterpriseSkillInstallError:
            continue
        key = entry.get("key")
        revision = entry.get("revision")
        digest = entry.get("artifactSha256")
        if key is None or revision is None or digest is None:
            key, revision, digest = _enterprise_metadata(entry)
        if key is None or revision is None or digest is None:
            continue
        try:
            safe_key = validate_skill_name(str(key))
            parsed_revision = int(revision)
        except (EnterpriseSkillInstallError, TypeError, ValueError):
            continue
        if parsed_revision < 1 or not _SHA256_RE.fullmatch(str(digest)):
            continue
        if safe_key != safe_name or entry.get("path", entry.get("install_path")) != (
            f"{ENTERPRISE_INSTALL_PREFIX}/{safe_name}"
        ):
            continue
        target = skills_root / ENTERPRISE_INSTALL_PREFIX / safe_name
        skill_md = target / "SKILL.md"
        if (
            _is_path_redirect(skills_root / ENTERPRISE_INSTALL_PREFIX)
            or _is_path_redirect(target)
            or _is_path_redirect(skill_md)
            or not target.is_dir()
            or not skill_md.is_file()
        ):
            continue
        try:
            if not stat.S_ISREG(skill_md.lstat().st_mode):
                continue
            if _strict_frontmatter_name(skill_md) != safe_name:
                continue
        except OSError:
            continue
        except EnterpriseSkillInstallError:
            continue
        installed.append({
            "key": safe_key,
            "name": name,
            "revision": parsed_revision,
            "artifactSha256": str(digest),
            "state": "installed",
        })
    installed.sort(key=lambda item: _ordinal_ignore_case_key(item["name"]))
    return {"items": installed}
