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
from datetime import datetime, timedelta, timezone
from io import BytesIO
import hashlib
import hmac
import base64
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
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
MAX_NORMALIZED_PATH_BYTES = 768
MAX_OPERATION_JOURNAL_BYTES = 1024 * 1024
MAX_MATERIALIZATION_RECEIPT_BYTES = 32 * 1024
LOCAL_DEVELOPMENT_RECEIPT_ENV = "HERMES_ENTERPRISE_ALLOW_LOCAL_DEVELOPMENT_SKILL_RECEIPTS"

ENTERPRISE_INSTALL_PREFIX = "enterprise"
ENTERPRISE_SOURCE = "enterprise"
ENTERPRISE_TRUST_LEVEL = "community"
ENTERPRISE_OPERATION_DIR = "enterprise-install-operations"
MAX_STAGED_INSTALL_OPERATIONS = 100
MAX_INSTALL_OPERATION_CANDIDATES = 8
MAX_INSTALL_OPERATION_STORAGE_BYTES = 500 * 1024 * 1024
MATERIALIZED_JOURNAL_RETENTION = timedelta(days=7)
CANDIDATE_RETENTION = timedelta(hours=1)

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_CLIENT_OPERATION_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_BASE64URL_RE = re.compile(r"^[A-Za-z0-9_-]+$")
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


@dataclass(frozen=True)
class EnterpriseInstallOperationBinding:
    operation_id: str
    client_operation_id: str
    metadata: EnterpriseArtifactMetadata
    install_authorization_hash: str
    desktop_user_id: str
    tenant_id: Optional[str]
    materialization_binding_schema_version: int
    materialized_content_hash: str
    materialization_recovery_expires_at: str


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


def validate_install_operation_binding(
    operation_id: str,
    *,
    client_operation_id: str,
    key: str,
    revision: Any,
    artifact_sha256: str,
    install_authorization_hash: str,
    desktop_user_id: str,
    tenant_id: Optional[str],
    materialization_binding_schema_version: Any,
    materialized_content_hash: str,
    materialization_recovery_expires_at: str,
) -> EnterpriseInstallOperationBinding:
    """Validate the immutable Gateway/local install-operation binding."""

    if type(revision) is not int or revision < 1:
        _fail("invalid_install_operation", "packageRevision must be a positive integer")

    try:
        parsed_id = uuid.UUID(str(operation_id))
    except (AttributeError, TypeError, ValueError):
        _fail("invalid_install_operation", "operationId must be a canonical GUID")
    canonical_id = str(parsed_id)
    if str(operation_id) != canonical_id:
        _fail("invalid_install_operation", "operationId must be a canonical GUID")
    client_id = str(client_operation_id or "").strip()
    if not _CLIENT_OPERATION_ID_RE.fullmatch(client_id):
        _fail("invalid_install_operation", "clientOperationId is invalid")
    authorization_hash = str(install_authorization_hash or "").strip().lower()
    if not _SHA256_RE.fullmatch(authorization_hash):
        _fail("invalid_install_operation", "installAuthorizationHash is invalid")
    normalized_user_id = str(desktop_user_id or "").strip().lower()
    try:
        if str(uuid.UUID(normalized_user_id)) != normalized_user_id:
            raise ValueError
    except ValueError:
        _fail("invalid_install_operation", "desktopUserId must be a canonical GUID")
    normalized_tenant_id = None if tenant_id is None else str(tenant_id).strip()
    if normalized_tenant_id == "":
        normalized_tenant_id = None
    if normalized_tenant_id is not None and len(normalized_tenant_id) > 256:
        _fail("invalid_install_operation", "tenantId is invalid")
    if type(materialization_binding_schema_version) is not int or materialization_binding_schema_version != 2:
        _fail("invalid_install_operation", "materializationBindingSchemaVersion is invalid")
    normalized_content_hash = str(materialized_content_hash or "").strip().lower()
    if not _SHA256_RE.fullmatch(normalized_content_hash):
        _fail("invalid_install_operation", "materializedContentHash is invalid")
    recovery_expiry = _parse_expiry(materialization_recovery_expires_at, require_future=False)
    canonical_recovery_expiry = recovery_expiry.isoformat().replace("+00:00", "Z")
    return EnterpriseInstallOperationBinding(
        canonical_id,
        client_id,
        validate_metadata(key, revision, artifact_sha256),
        authorization_hash,
        normalized_user_id,
        normalized_tenant_id,
        2,
        normalized_content_hash,
        canonical_recovery_expiry,
    )


def _parse_expiry(value: str, *, require_future: bool) -> datetime:
    raw = str(value or "").strip()
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        _fail("invalid_install_operation", "expiresAt must be an ISO-8601 timestamp")
    if parsed.tzinfo is None:
        _fail("invalid_install_operation", "expiresAt must include a timezone")
    normalized = parsed.astimezone(timezone.utc)
    if require_future and normalized <= datetime.now(timezone.utc):
        _fail("install_operation_expired", "install operation expired before staging", 409)
    return normalized


def _operation_payload(binding: EnterpriseInstallOperationBinding) -> Dict[str, Any]:
    return {
        "operationId": binding.operation_id,
        "clientOperationId": binding.client_operation_id,
        "key": binding.metadata.key,
        "revision": binding.metadata.revision,
        "artifactSha256": binding.metadata.artifact_sha256,
        "installAuthorizationHash": binding.install_authorization_hash,
        "desktopUserId": binding.desktop_user_id,
        "tenantId": binding.tenant_id,
        "materializationBindingSchemaVersion": binding.materialization_binding_schema_version,
        "materializedContentHash": binding.materialized_content_hash,
        "materializationRecoveryExpiresAt": binding.materialization_recovery_expires_at,
    }


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
    normalized = "/".join(parts)
    if len(normalized.encode("utf-8")) > MAX_NORMALIZED_PATH_BYTES:
        _fail("invalid_package", f"ZIP entry path is too long: {raw_name!r}")
    return normalized


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


def _require_safe_operation_root(skills_root: Path) -> Path:
    _require_safe_install_directories(skills_root)
    operation_root = skills_root / ".hub" / "quarantine" / ENTERPRISE_OPERATION_DIR
    if _is_path_redirect(operation_root):
        _fail("install_operation_storage_invalid", "install operation storage contains a path redirect", 500)
    operation_root.mkdir(parents=False, exist_ok=True)
    if _is_path_redirect(operation_root):
        _fail("install_operation_storage_invalid", "install operation storage contains a path redirect", 500)
    return operation_root


def _fsync_directory(path: Path) -> None:
    if os.name == "nt":
        return
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _atomic_write_bytes(path: Path, content: bytes) -> None:
    if _is_path_redirect(path) or _is_path_redirect(path.parent):
        _fail("install_operation_storage_invalid", "install operation storage contains a path redirect", 500)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("xb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        _fsync_directory(path.parent)
    finally:
        temporary.unlink(missing_ok=True)


def _journal_key(skills_root: Path) -> bytes:
    """Read/create the journal key while the caller holds HubLockFile.exclusive."""

    key_path = skills_root / ".hub" / "enterprise-install-journal.key"
    if _is_path_redirect(key_path):
        _fail("install_operation_storage_invalid", "install operation journal key is redirected", 500)
    if not key_path.exists():
        try:
            with key_path.open("xb") as stream:
                stream.write(secrets.token_hex(32).encode("ascii"))
                stream.flush()
                os.fsync(stream.fileno())
            _fsync_directory(key_path.parent)
            try:
                key_path.chmod(0o600)
            except OSError:
                pass
        except FileExistsError:
            # A defensive re-read for callers that violate the documented
            # HubLock requirement; never replace an already-selected key.
            pass
    try:
        raw = key_path.read_bytes()
    except OSError as exc:
        _fail("install_operation_storage_invalid", f"install operation journal key is unreadable: {exc}", 500)
    if len(raw) != 64 or not re.fullmatch(rb"[0-9a-f]{64}", raw):
        _fail("install_operation_storage_invalid", "install operation journal key is invalid", 500)
    return bytes.fromhex(raw.decode("ascii"))


def _journal_mac(payload: Mapping[str, Any], key: bytes) -> str:
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return hmac.new(key, canonical, hashlib.sha256).hexdigest()


def _write_operation_journal(path: Path, payload: Mapping[str, Any], key: bytes) -> None:
    document = dict(payload)
    document["integrity"] = _journal_mac(document, key)
    encoded = (json.dumps(document, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
    if len(encoded) > MAX_OPERATION_JOURNAL_BYTES:
        _fail("install_operation_journal_invalid", "install operation journal exceeds its size limit", 409)
    _atomic_write_bytes(path, encoded)


def _read_operation_journal(path: Path, key: bytes) -> Dict[str, Any]:
    if _is_path_redirect(path) or _is_path_redirect(path.parent):
        _fail("install_operation_journal_invalid", "install operation journal is redirected", 409)
    try:
        if path.stat(follow_symlinks=False).st_size > MAX_OPERATION_JOURNAL_BYTES:
            _fail("install_operation_journal_invalid", "install operation journal is too large", 409)
        document = json.loads(path.read_text(encoding="utf-8"))
    except EnterpriseSkillInstallError:
        raise
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        _fail("install_operation_journal_invalid", f"install operation journal is unreadable: {exc}", 409)
    if not isinstance(document, dict):
        _fail("install_operation_journal_invalid", "install operation journal has an invalid schema", 409)
    integrity = document.pop("integrity", None)
    if not isinstance(integrity, str) or not hmac.compare_digest(integrity, _journal_mac(document, key)):
        _fail("install_operation_journal_invalid", "install operation journal integrity check failed", 409)
    if document.get("schemaVersion") != 1 or document.get("state") not in {"staged", "materialized"}:
        _fail("install_operation_journal_invalid", "install operation journal has an invalid schema", 409)
    expiry = _parse_expiry(document.get("expiresAt", ""), require_future=False)
    canonical_expiry = expiry.isoformat().replace("+00:00", "Z")
    if document.get("expiresAt") != canonical_expiry:
        _fail("install_operation_journal_invalid", "install operation expiry is not canonical UTC", 409)
    manifest = document.get("fileManifest")
    if (
        not isinstance(manifest, list)
        or len(manifest) > MAX_FILE_COUNT
        or not _SHA256_RE.fullmatch(str(document.get("contentHash", "")))
    ):
        _fail("install_operation_journal_invalid", "install operation content manifest is invalid", 409)
    receipt_proof = document.get("materializationReceiptProof")
    if document["state"] == "materialized":
        if not _valid_receipt_proof(receipt_proof):
            _fail("install_operation_journal_invalid", "materialized receipt proof is invalid", 409)
    elif receipt_proof is not None:
        _fail("install_operation_journal_invalid", "staged operation contains materialization proof", 409)
    normalized_paths: List[str] = []
    total_size = 0
    for item in manifest:
        if (
            not isinstance(item, dict)
            or not isinstance(item.get("path"), str)
            or not isinstance(item.get("sizeBytes"), int)
            or item["sizeBytes"] < 0
            or not _SHA256_RE.fullmatch(str(item.get("sha256", "")))
        ):
            _fail("install_operation_journal_invalid", "install operation content manifest is invalid", 409)
        try:
            normalized_path = _normalize_zip_path(item["path"])
        except EnterpriseSkillInstallError:
            _fail("install_operation_journal_invalid", "install operation manifest path is invalid", 409)
        if normalized_path != item["path"]:
            _fail("install_operation_journal_invalid", "install operation manifest path is not normalized", 409)
        normalized_paths.append(normalized_path)
        total_size += item["sizeBytes"]
    if (
        normalized_paths != sorted(normalized_paths)
        or len(set(normalized_paths)) != len(normalized_paths)
        or total_size > MAX_UNCOMPRESSED_BYTES
    ):
        _fail("install_operation_journal_invalid", "install operation content manifest is invalid", 409)
    return document


def _assert_journal_binding(
    document: Mapping[str, Any], binding: EnterpriseInstallOperationBinding
) -> None:
    expected = _operation_payload(binding)
    if any(document.get(name) != value for name, value in expected.items()):
        _fail("install_operation_binding_mismatch", "install operation binding does not match staged content", 409)


def _binding_from_journal(document: Mapping[str, Any]) -> EnterpriseInstallOperationBinding:
    return validate_install_operation_binding(
        str(document.get("operationId", "")),
        client_operation_id=str(document.get("clientOperationId", "")),
        key=str(document.get("key", "")),
        revision=document.get("revision"),
        artifact_sha256=str(document.get("artifactSha256", "")),
        install_authorization_hash=str(document.get("installAuthorizationHash", "")),
        desktop_user_id=str(document.get("desktopUserId", "")),
        tenant_id=document.get("tenantId"),
        materialization_binding_schema_version=document.get("materializationBindingSchemaVersion"),
        materialized_content_hash=str(document.get("materializedContentHash", "")),
        materialization_recovery_expires_at=str(document.get("materializationRecoveryExpiresAt", "")),
    )


def _operation_paths(binding: EnterpriseInstallOperationBinding) -> Tuple[Path, Path, Path, Path]:
    skills_root = get_hermes_home() / "skills"
    operation_root = _require_safe_operation_root(skills_root)
    operation_dir = operation_root / binding.operation_id
    journal_path = operation_dir / "operation.json"
    skill_root = operation_dir / "skill" / binding.metadata.key
    for path in (operation_dir, operation_dir / "skill", skill_root, journal_path):
        if _is_path_redirect(path):
            _fail("install_operation_storage_invalid", "install operation storage contains a path redirect", 500)
    return skills_root, operation_dir, journal_path, skill_root


def _operation_result(document: Mapping[str, Any]) -> Dict[str, Any]:
    return {
        "operationId": document["operationId"],
        "clientOperationId": document["clientOperationId"],
        "key": document["key"],
        "revision": document["revision"],
        "artifactSha256": document["artifactSha256"],
        "installAuthorizationHash": document["installAuthorizationHash"],
        "desktopUserId": document["desktopUserId"],
        "tenantId": document["tenantId"],
        "materializationBindingSchemaVersion": document["materializationBindingSchemaVersion"],
        "materializationRecoveryExpiresAt": document["materializationRecoveryExpiresAt"],
        "expiresAt": document["expiresAt"],
        "state": document["state"],
    }


def _tree_manifest(root: Path) -> Tuple[List[Dict[str, Any]], str]:
    _verify_extracted_tree(root)
    manifest: List[Dict[str, Any]] = []
    digest_input = bytearray()
    for file_path in sorted(
        (path for path in root.rglob("*") if path.is_file()),
        key=lambda path: path.relative_to(root).as_posix(),
    ):
        if _is_path_redirect(file_path) or not stat.S_ISREG(file_path.lstat().st_mode):
            _fail("install_operation_content_changed", "install operation content contains a redirect", 409)
        relative = file_path.relative_to(root).as_posix()
        content = file_path.read_bytes()
        file_sha = hashlib.sha256(content).hexdigest()
        manifest.append({"path": relative, "sizeBytes": len(content), "sha256": file_sha})
        digest_input.extend(relative.encode("utf-8"))
        digest_input.extend(b"\0")
        digest_input.extend(file_sha.encode("ascii"))
        digest_input.extend(b"\0")
        digest_input.extend(str(len(content)).encode("ascii"))
        digest_input.extend(b"\n")
    return manifest, hashlib.sha256(digest_input).hexdigest()


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
    operation: Optional[EnterpriseInstallOperationBinding] = None,
    content_hash: Optional[str] = None,
    receipt_proof: Optional[Mapping[str, Any]] = None,
) -> Dict[str, Any]:
    if operation is not None and not _valid_receipt_proof(receipt_proof):
        _fail("install_operation_receipt_invalid", "materialization receipt proof is invalid", 409)
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
        "content_hash": content_hash or metadata.artifact_sha256,
        "install_path": install_path,
        "files": files,
        "metadata": {
            "enterprise_key": metadata.key,
            "enterprise_revision": metadata.revision,
            "artifact_sha256": metadata.artifact_sha256,
            **({
                "enterprise_install_operation_id": operation.operation_id,
                "enterprise_client_operation_id": operation.client_operation_id,
                "install_authorization_hash": operation.install_authorization_hash,
                "enterprise_desktop_user_id": operation.desktop_user_id,
                "enterprise_tenant_id": operation.tenant_id,
                "materialization_binding_schema_version": operation.materialization_binding_schema_version,
                "materialization_recovery_expires_at": operation.materialization_recovery_expires_at,
                "materialization_receipt_digest": receipt_proof.get("digest"),
                "materialization_receipt_kid": receipt_proof.get("kid"),
                "materialization_receipt_jws": receipt_proof.get("compactJws"),
                "materialization_receipt_validated": True,
            } if operation is not None else {}),
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


def _validate_operation_artifact(
    artifact: bytes,
    metadata: EnterpriseArtifactMetadata,
    skill_root: Path,
) -> List[str]:
    if not isinstance(artifact, (bytes, bytearray, memoryview)) or not artifact:
        _fail("invalid_package", "artifact body must be a non-empty ZIP")
    artifact_bytes = bytes(artifact)
    if len(artifact_bytes) > MAX_ARTIFACT_BYTES:
        _fail("artifact_too_large", f"artifact exceeds the {MAX_ARTIFACT_BYTES} byte limit", 413)
    if hashlib.sha256(artifact_bytes).hexdigest() != metadata.artifact_sha256:
        _fail("artifact_hash_mismatch", "artifact SHA-256 does not match metadata")
    files = _extract_zip(artifact_bytes, skill_root)
    skill_md = skill_root / "SKILL.md"
    if not skill_md.is_file():
        _fail("invalid_package", "ZIP root must contain SKILL.md")
    if _strict_frontmatter_name(skill_md) != metadata.key:
        _fail("skill_name_mismatch", "SKILL.md name must exactly match the enterprise skill key")
    from tools.skills_guard import scan_skill, should_allow_install
    scan = scan_skill(skill_root, source=ENTERPRISE_SOURCE, honor_ignore_files=False)
    allowed, reason = should_allow_install(scan, force=False)
    if allowed is not True:
        _fail("skill_scan_rejected", reason, 422)
    return files


def _lock_matches_operation(
    entry: Any,
    binding: EnterpriseInstallOperationBinding,
) -> bool:
    if not isinstance(entry, dict) or entry.get("source") != ENTERPRISE_SOURCE:
        return False
    metadata = entry.get("metadata")
    return (
        entry.get("key") == binding.metadata.key
        and entry.get("revision") == binding.metadata.revision
        and entry.get("artifactSha256") == binding.metadata.artifact_sha256
        and entry.get("path", entry.get("install_path")) == f"enterprise/{binding.metadata.key}"
        and isinstance(metadata, dict)
        and metadata.get("enterprise_install_operation_id") == binding.operation_id
        and metadata.get("enterprise_client_operation_id") == binding.client_operation_id
        and metadata.get("install_authorization_hash") == binding.install_authorization_hash
        and metadata.get("enterprise_desktop_user_id") == binding.desktop_user_id
        and metadata.get("enterprise_tenant_id") == binding.tenant_id
        and metadata.get("materialization_binding_schema_version") == binding.materialization_binding_schema_version
        and entry.get("content_hash") == binding.materialized_content_hash
        and metadata.get("materialization_recovery_expires_at") == binding.materialization_recovery_expires_at
        and _SHA256_RE.fullmatch(str(metadata.get("materialization_receipt_digest", ""))) is not None
        and isinstance(metadata.get("materialization_receipt_kid"), str)
        and bool(metadata.get("materialization_receipt_kid"))
        and isinstance(metadata.get("materialization_receipt_jws"), str)
        and 0 < len(metadata.get("materialization_receipt_jws")) <= MAX_MATERIALIZATION_RECEIPT_BYTES
        and metadata.get("materialization_receipt_validated") is True
    )


def _valid_receipt_proof(value: Any) -> bool:
    return (
        isinstance(value, dict)
        and _SHA256_RE.fullmatch(str(value.get("digest", ""))) is not None
        and isinstance(value.get("kid"), str)
        and bool(value.get("kid"))
        and isinstance(value.get("validatedAt"), str)
        and isinstance(value.get("commitAuthorizedAt"), str)
        and isinstance(value.get("receiptExpiresAt"), str)
        and isinstance(value.get("materializedContentHash"), str)
        and _SHA256_RE.fullmatch(value.get("materializedContentHash")) is not None
        and isinstance(value.get("compactJws"), str)
        and 0 < len(value.get("compactJws")) <= MAX_MATERIALIZATION_RECEIPT_BYTES
    )


def _lock_matches_receipt_proof(entry: Any, proof: Mapping[str, Any]) -> bool:
    metadata = entry.get("metadata") if isinstance(entry, dict) else None
    return (
        isinstance(metadata, dict)
        and metadata.get("materialization_receipt_digest") == proof.get("digest")
        and metadata.get("materialization_receipt_kid") == proof.get("kid")
        and metadata.get("materialization_receipt_jws") == proof.get("compactJws")
        and entry.get("content_hash") == proof.get("materializedContentHash")
        and metadata.get("materialization_receipt_validated") is True
    )


def _verify_materialized_target(
    target: Path,
    binding: EnterpriseInstallOperationBinding,
    manifest: Iterable[Mapping[str, Any]],
    content_hash: str,
) -> None:
    if _is_path_redirect(target) or not target.is_dir():
        _fail("install_operation_target_invalid", "materialized target is missing or redirected", 409)
    _verify_extracted_tree(target)
    skill_md = target / "SKILL.md"
    if _is_path_redirect(skill_md) or not skill_md.is_file() or _strict_frontmatter_name(skill_md) != binding.metadata.key:
        _fail("install_operation_target_invalid", "materialized target does not match the operation", 409)
    actual_manifest, actual_content_hash = _tree_manifest(target)
    if actual_manifest != list(manifest) or actual_content_hash != content_hash:
        _fail("install_operation_content_changed", "install operation content changed after staging", 409)


def _cleanup_install_operations_locked(
    operation_root: Path,
    key: bytes,
    skills_root: Path,
    lock_data: Mapping[str, Any],
) -> int:
    now = datetime.now(timezone.utc)
    staged = 0
    for operation_dir in operation_root.iterdir():
        if not operation_dir.is_dir() or _is_path_redirect(operation_dir):
            continue
        journal_path = operation_dir / "operation.json"
        try:
            document = _read_operation_journal(journal_path, key)
            expires_at = _parse_expiry(document.get("expiresAt", ""), require_future=False)
            binding = _binding_from_journal(document)
        except EnterpriseSkillInstallError:
            continue
        target = skills_root / ENTERPRISE_INSTALL_PREFIX / binding.metadata.key
        entry = lock_data.get("installed", {}).get(binding.metadata.key)
        manifest = document["fileManifest"]
        content_hash = document["contentHash"]
        if document["state"] == "staged":
            stage_root = operation_dir / "skill" / binding.metadata.key
            try:
                _verify_materialized_target(stage_root, binding, manifest, content_hash)
            except EnterpriseSkillInstallError:
                continue
            # Expiry is Gateway state, not local deletion authority. A staged
            # operation is removed only by the explicit abort recovery path.
            staged += 1
        elif expires_at + MATERIALIZED_JOURNAL_RETENTION <= now:
            try:
                if not _lock_matches_operation(entry, binding):
                    continue
                _verify_materialized_target(target, binding, manifest, content_hash)
            except EnterpriseSkillInstallError:
                continue
            shutil.rmtree(operation_dir, ignore_errors=True)
    return staged


def _tree_size(root: Path) -> int:
    total = 0
    if not root.exists() or _is_path_redirect(root):
        return total
    for path in root.rglob("*"):
        if _is_path_redirect(path):
            continue
        try:
            if path.is_file():
                total += path.stat(follow_symlinks=False).st_size
        except OSError:
            continue
    return total


def _cleanup_stage_candidates_locked(quarantine_root: Path, *, keep: Path) -> None:
    cutoff = datetime.now(timezone.utc) - CANDIDATE_RETENTION
    for candidate in quarantine_root.glob(".enterprise-op-stage-*"):
        if candidate == keep or not candidate.is_dir() or _is_path_redirect(candidate):
            continue
        try:
            modified = datetime.fromtimestamp(candidate.stat().st_mtime, timezone.utc)
        except OSError:
            continue
        if modified <= cutoff:
            shutil.rmtree(candidate, ignore_errors=True)


def stage_enterprise_skill_operation(
    artifact: bytes,
    *,
    operation_id: str,
    client_operation_id: str,
    key: str,
    revision: Any,
    artifact_sha256: str,
    install_authorization_hash: str,
    desktop_user_id: str,
    tenant_id: Optional[str],
    materialization_binding_schema_version: Any,
    materialized_content_hash: str,
    materialization_recovery_expires_at: str,
    expires_at: str,
) -> Dict[str, Any]:
    """Validate and durably stage an artifact without making it loadable."""

    binding = validate_install_operation_binding(
        operation_id,
        client_operation_id=client_operation_id,
        key=key,
        revision=revision,
        artifact_sha256=artifact_sha256,
        install_authorization_hash=install_authorization_hash,
        desktop_user_id=desktop_user_id,
        tenant_id=tenant_id,
        materialization_binding_schema_version=materialization_binding_schema_version,
        materialized_content_hash=materialized_content_hash,
        materialization_recovery_expires_at=materialization_recovery_expires_at,
    )
    expiry = _parse_expiry(expires_at, require_future=True)
    skills_root, operation_dir, journal_path, _skill_root = _operation_paths(binding)
    operation_root = operation_dir.parent
    quarantine_root = skills_root / ".hub" / "quarantine"
    candidate = quarantine_root / f".enterprise-op-stage-{uuid.uuid4().hex}"
    candidate_skill_root = candidate / "skill" / binding.metadata.key
    candidate_skill_root.mkdir(parents=True, exist_ok=False)
    moved = False
    try:
        files = _validate_operation_artifact(artifact, binding.metadata, candidate_skill_root)
        from tools.skills_hub import HubLockFile, HubLockFileError
        lock = HubLockFile(skills_root / ".hub" / "lock.json")
        try:
            with lock.exclusive():
                journal_key = _journal_key(skills_root)
                lock_data = lock.load_locked(strict=True)
                _cleanup_stage_candidates_locked(quarantine_root, keep=candidate)
                candidates = [
                    path for path in quarantine_root.glob(".enterprise-op-stage-*")
                    if path.is_dir() and not _is_path_redirect(path)
                ]
                if len(candidates) > MAX_INSTALL_OPERATION_CANDIDATES:
                    _fail("install_operation_stage_limit", "too many concurrent stage candidates", 429)
                staged_count = _cleanup_install_operations_locked(
                    operation_root, journal_key, skills_root, lock_data
                )
                if operation_dir.exists():
                    existing = _read_operation_journal(journal_path, journal_key)
                    _assert_journal_binding(existing, binding)
                    if existing["state"] == "staged":
                        _verify_materialized_target(
                            operation_dir / "skill" / binding.metadata.key,
                            binding,
                            existing["fileManifest"],
                            existing["contentHash"],
                        )
                    else:
                        entry = lock_data["installed"].get(binding.metadata.key)
                        if not _lock_matches_operation(entry, binding):
                            _fail("install_operation_target_invalid", "materialized lock binding is missing", 409)
                        _verify_materialized_target(
                            skills_root / ENTERPRISE_INSTALL_PREFIX / binding.metadata.key,
                            binding,
                            existing["fileManifest"],
                            existing["contentHash"],
                        )
                    return _operation_result(existing)
                if staged_count >= MAX_STAGED_INSTALL_OPERATIONS:
                    _fail("install_operation_stage_limit", "too many staged install operations", 429)
                if _tree_size(operation_root) + sum(_tree_size(path) for path in candidates) > MAX_INSTALL_OPERATION_STORAGE_BYTES:
                    _fail("install_operation_storage_limit", "staged install operations exceed the storage limit", 429)
                manifest, content_hash = _tree_manifest(candidate_skill_root)
                if content_hash != binding.materialized_content_hash:
                    _fail(
                        "install_operation_content_mismatch",
                        "staged content does not match the Gateway materialized content hash",
                        409,
                    )
                document = {
                    "schemaVersion": 1,
                    **_operation_payload(binding),
                    "expiresAt": expiry.isoformat().replace("+00:00", "Z"),
                    "files": files,
                    "fileManifest": manifest,
                    "contentHash": content_hash,
                    "state": "staged",
                    "updatedAt": datetime.now(timezone.utc).isoformat(),
                }
                _write_operation_journal(candidate / "operation.json", document, journal_key)
                os.replace(candidate, operation_dir)
                _fsync_directory(operation_root)
                moved = True
                return _operation_result(document)
        except HubLockFileError as exc:
            _fail("skill_lock_write_failed", str(exc), 500)
    finally:
        if not moved:
            shutil.rmtree(candidate, ignore_errors=True)


def get_enterprise_skill_operation(
    *,
    operation_id: str,
    client_operation_id: str,
    key: str,
    revision: Any,
    artifact_sha256: str,
    install_authorization_hash: str,
    desktop_user_id: str,
    tenant_id: Optional[str],
    materialization_binding_schema_version: Any,
    materialized_content_hash: str,
    materialization_recovery_expires_at: str,
) -> Dict[str, Any]:
    binding = validate_install_operation_binding(
        operation_id,
        client_operation_id=client_operation_id,
        key=key,
        revision=revision,
        artifact_sha256=artifact_sha256,
        install_authorization_hash=install_authorization_hash,
        desktop_user_id=desktop_user_id,
        tenant_id=tenant_id,
        materialization_binding_schema_version=materialization_binding_schema_version,
        materialized_content_hash=materialized_content_hash,
        materialization_recovery_expires_at=materialization_recovery_expires_at,
    )
    skills_root, operation_dir, journal_path, _skill_root = _operation_paths(binding)
    from tools.skills_hub import HubLockFile, HubLockFileError
    lock = HubLockFile(skills_root / ".hub" / "lock.json")
    try:
        with lock.exclusive():
            journal_key = _journal_key(skills_root)
            lock_data = lock.load_locked(strict=True)
            if journal_path.exists():
                document = _read_operation_journal(journal_path, journal_key)
                _assert_journal_binding(document, binding)
                entry = lock_data["installed"].get(binding.metadata.key)
                target = skills_root / ENTERPRISE_INSTALL_PREFIX / binding.metadata.key
                manifest = document["fileManifest"]
                content_hash = document["contentHash"]
                if document["state"] == "materialized":
                    if not _lock_matches_operation(entry, binding):
                        _fail("install_operation_target_invalid", "materialized lock binding is missing", 409)
                    if not _lock_matches_receipt_proof(entry, document["materializationReceiptProof"]):
                        _fail("install_operation_target_invalid", "materialized receipt proof does not match the lock", 409)
                    _verify_materialized_target(target, binding, manifest, content_hash)
                elif target.exists() or _is_path_redirect(target):
                    _verify_materialized_target(target, binding, manifest, content_hash)
                    if entry is None:
                        return {**_operation_result(document), "state": "materialize-pending"}
                    if not _lock_matches_operation(entry, binding):
                        _fail("skill_name_conflict", "skill lock conflicts with the staged operation", 409)
                    return {**_operation_result(document), "state": "materialize-pending"}
                else:
                    if entry is not None:
                        _fail("skill_name_conflict", "skill lock conflicts with the staged operation", 409)
                    _verify_materialized_target(
                        operation_dir / "skill" / binding.metadata.key,
                        binding,
                        manifest,
                        content_hash,
                    )
                return _operation_result(document)
            entry = lock_data["installed"].get(binding.metadata.key)
            target = skills_root / ENTERPRISE_INSTALL_PREFIX / binding.metadata.key
            if _lock_matches_operation(entry, binding) and target.is_dir() and not _is_path_redirect(target):
                content_hash = str(entry.get("content_hash", ""))
                if not _SHA256_RE.fullmatch(content_hash):
                    _fail("install_operation_target_invalid", "materialized content hash is missing", 409)
                _manifest, actual_hash = _tree_manifest(target)
                if actual_hash != content_hash:
                    _fail("install_operation_content_changed", "materialized target content changed", 409)
                return {**_operation_payload(binding), "expiresAt": None, "state": "materialized"}
            _fail("install_operation_not_found", "install operation was not found", 404)
    except HubLockFileError as exc:
        _fail("skill_lock_invalid", str(exc), 500)


def _decode_receipt_segment(value: str) -> bytes:
    if not value or "=" in value or not _BASE64URL_RE.fullmatch(value):
        _fail("install_operation_receipt_invalid", "materialization receipt is malformed", 409)
    try:
        decoded = base64.urlsafe_b64decode(value + ("=" * (-len(value) % 4)))
    except Exception:
        _fail("install_operation_receipt_invalid", "materialization receipt is malformed", 409)
    canonical = base64.urlsafe_b64encode(decoded).rstrip(b"=").decode("ascii")
    if not hmac.compare_digest(canonical, value):
        _fail("install_operation_receipt_invalid", "materialization receipt is not canonical", 409)
    return decoded


def _receipt_json(value: bytes) -> Dict[str, Any]:
    def reject_duplicates(items: List[Tuple[str, Any]]) -> Dict[str, Any]:
        result: Dict[str, Any] = {}
        for key, item in items:
            if key in result:
                _fail("install_operation_receipt_invalid", "materialization receipt contains duplicate claims", 409)
            result[key] = item
        return result

    try:
        document = json.loads(value.decode("utf-8"), object_pairs_hook=reject_duplicates)
    except EnterpriseSkillInstallError:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError):
        _fail("install_operation_receipt_invalid", "materialization receipt contains invalid JSON", 409)
    if not isinstance(document, dict):
        _fail("install_operation_receipt_invalid", "materialization receipt has an invalid schema", 409)
    return document


def _receipt_timestamp(value: Any, claim: str) -> datetime:
    raw = value if isinstance(value, str) else ""
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        _fail("install_operation_receipt_invalid", f"materialization receipt {claim} is invalid", 409)
    if parsed.tzinfo is None:
        _fail("install_operation_receipt_invalid", f"materialization receipt {claim} is invalid", 409)
    return parsed.astimezone(timezone.utc)


def _verify_materialization_receipt(
    receipt: str,
    binding: EnterpriseInstallOperationBinding,
    *,
    expected_content_hash: Optional[str] = None,
    historical: bool = False,
) -> Dict[str, Any]:
    """Verify the Gateway compact JWS using only managed-policy trust."""

    compact = receipt.strip() if isinstance(receipt, str) else ""
    if not compact:
        _fail("install_operation_receipt_required", "a signed Gateway materialization receipt is required", 409)
    if len(compact.encode("utf-8")) > MAX_MATERIALIZATION_RECEIPT_BYTES:
        _fail("install_operation_receipt_invalid", "materialization receipt exceeds its size limit", 409)
    parts = compact.split(".")
    if len(parts) != 3:
        _fail("install_operation_receipt_invalid", "materialization receipt is malformed", 409)
    encoded_header, encoded_payload, encoded_signature = parts
    header = _receipt_json(_decode_receipt_segment(encoded_header))
    payload = _receipt_json(_decode_receipt_segment(encoded_payload))
    signature = _decode_receipt_segment(encoded_signature)

    header_keys = {"alg", "kid", "typ"}
    payload_keys = {
        "schemaVersion", "bindingSchemaVersion", "kid", "issuer", "audience", "purpose",
        "operationId", "clientOperationId", "desktopUserId", "tenantId",
        "skillKey", "packageRevision", "artifactSha256",
        "materializedContentHash",
        "installAuthorizationHash", "commitAuthorizedAt", "receiptExpiresAt",
        "materializationRecoveryExpiresAt",
    }
    if set(header) != header_keys or set(payload) != payload_keys:
        _fail("install_operation_receipt_invalid", "materialization receipt has an invalid schema", 409)
    kid = header.get("kid")
    if (
        header.get("alg") != "ES256"
        or header.get("typ") != "hermes-skill-install-receipt+jws"
        or not isinstance(kid, str)
        or not _CLIENT_OPERATION_ID_RE.fullmatch(kid)
    ):
        _fail("install_operation_receipt_invalid", "materialization receipt header is invalid", 409)

    from hermes_cli.enterprise_policy import load_enterprise_policy

    trust = load_enterprise_policy().get("skillInstallReceiptTrust")
    if not isinstance(trust, dict):
        _fail("install_operation_receipt_invalid", "materialization receipt trust is unavailable", 409)
    if set(trust) != {"schemaVersion", "issuer", "audience", "purpose", "signerMode", "algorithm", "publicKeys"}:
        _fail("install_operation_receipt_invalid", "materialization receipt trust is invalid", 409)
    if (
        trust.get("schemaVersion") != 2
        or trust.get("algorithm") != "ES256"
        or trust.get("audience") != "hermes-enterprise-skill-runtime"
        or trust.get("purpose") != "hermes-enterprise-skill-materialize"
        or not isinstance(trust.get("issuer"), str)
        or not trust["issuer"].strip()
    ):
        _fail("install_operation_receipt_invalid", "materialization receipt trust is invalid", 409)
    signer_mode = trust.get("signerMode")
    if signer_mode not in {"gateway-service", "local-development", "testing"}:
        _fail("install_operation_receipt_invalid", "materialization receipt signer mode is invalid", 409)
    allow_local_development = str(os.getenv(LOCAL_DEVELOPMENT_RECEIPT_ENV, "")).strip().lower() in {
        "1", "true", "yes", "on"
    }
    if signer_mode == "local-development" and allow_local_development:
        pass
    elif signer_mode != "gateway-service":
        _fail("install_operation_receipt_invalid", "local development receipt trust is not allowed", 409)
    keys = trust.get("publicKeys")
    if not isinstance(keys, list) or not (1 <= len(keys) <= 16):
        _fail("install_operation_receipt_invalid", "materialization receipt trust is unavailable", 409)
    if (
        any(
            not isinstance(item, dict)
            or set(item) != {"kid", "algorithm", "publicKeyPem", "rotationState"}
            or not isinstance(item.get("kid"), str)
            or not _CLIENT_OPERATION_ID_RE.fullmatch(item["kid"])
            or item.get("algorithm") != "ES256"
            or item.get("rotationState") not in {"current", "previous", "retired", "revoked"}
            or not isinstance(item.get("publicKeyPem"), str)
            or len(item.get("publicKeyPem", "").encode("utf-8")) > 8 * 1024
            or "PRIVATE KEY" in item.get("publicKeyPem", "")
            for item in keys
        )
        or len({item["kid"] for item in keys}) != len(keys)
        or sum(item["rotationState"] == "current" for item in keys) != 1
        or sum(item["rotationState"] == "previous" for item in keys) > 1
        or sum(len(item["publicKeyPem"].encode("utf-8")) for item in keys) > 64 * 1024
    ):
        _fail("install_operation_receipt_invalid", "materialization receipt trust is invalid", 409)
    matches = [item for item in keys if isinstance(item, dict) and item.get("kid") == kid]
    if len(matches) != 1:
        _fail("install_operation_receipt_invalid", "materialization receipt signing key is not trusted", 409)
    trusted_key = matches[0]
    if (
        trusted_key.get("rotationState")
        not in ({"current", "previous", "retired"} if historical else {"current", "previous"})
    ):
        _fail("install_operation_receipt_invalid", "materialization receipt signing key is invalid", 409)

    if len(signature) != 64:
        _fail("install_operation_receipt_invalid", "materialization receipt signature is invalid", 409)
    try:
        from cryptography.exceptions import InvalidSignature
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import ec
        from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature
    except Exception:
        _fail("install_operation_receipt_invalid", "materialization receipt verifier is unavailable", 409)
    try:
        parsed_keys = {}
        for item in keys:
            parsed_key = serialization.load_pem_public_key(item["publicKeyPem"].encode("ascii"))
            if not isinstance(parsed_key, ec.EllipticCurvePublicKey) or not isinstance(parsed_key.curve, ec.SECP256R1):
                _fail("install_operation_receipt_invalid", "materialization receipt signing key is invalid", 409)
            parsed_keys[item["kid"]] = parsed_key
        public_key = parsed_keys[kid]
        if not isinstance(public_key, ec.EllipticCurvePublicKey) or not isinstance(public_key.curve, ec.SECP256R1):
            _fail("install_operation_receipt_invalid", "materialization receipt signing key is invalid", 409)
        raw_r = int.from_bytes(signature[:32], "big")
        raw_s = int.from_bytes(signature[32:], "big")
        public_key.verify(
            encode_dss_signature(raw_r, raw_s),
            f"{encoded_header}.{encoded_payload}".encode("ascii"),
            ec.ECDSA(hashes.SHA256()),
        )
    except EnterpriseSkillInstallError:
        raise
    except (InvalidSignature, ValueError, TypeError, UnicodeEncodeError):
        _fail("install_operation_receipt_invalid", "materialization receipt signature is invalid", 409)

    string_claims = (
        "kid", "issuer", "audience", "purpose", "operationId", "clientOperationId",
        "desktopUserId", "skillKey", "artifactSha256", "installAuthorizationHash",
        "materializedContentHash",
        "commitAuthorizedAt", "receiptExpiresAt", "materializationRecoveryExpiresAt",
    )
    if (
        type(payload.get("schemaVersion")) is not int
        or payload.get("schemaVersion") != 2
        or type(payload.get("bindingSchemaVersion")) is not int
        or payload.get("bindingSchemaVersion") != 2
        or type(payload.get("packageRevision")) is not int
        or payload.get("packageRevision") < 1
        or any(not isinstance(payload.get(name), str) or not payload[name] or len(payload[name]) > 512 for name in string_claims)
        or (payload.get("tenantId") is not None and (not isinstance(payload.get("tenantId"), str) or not payload["tenantId"] or len(payload["tenantId"]) > 256))
        or payload.get("kid") != kid
        or payload.get("issuer") != trust["issuer"].strip()
        or payload.get("audience") != trust["audience"]
        or payload.get("purpose") != trust["purpose"]
        or not _SHA256_RE.fullmatch(payload.get("artifactSha256", ""))
        or not _SHA256_RE.fullmatch(payload.get("materializedContentHash", ""))
        or not _SHA256_RE.fullmatch(payload.get("installAuthorizationHash", ""))
    ):
        _fail("install_operation_receipt_invalid", "materialization receipt claims are invalid", 409)

    expected_claims = {
        "operationId": binding.operation_id,
        "clientOperationId": binding.client_operation_id,
        "desktopUserId": binding.desktop_user_id,
        "tenantId": binding.tenant_id,
        "skillKey": binding.metadata.key,
        "packageRevision": binding.metadata.revision,
        "artifactSha256": binding.metadata.artifact_sha256,
        "installAuthorizationHash": binding.install_authorization_hash,
        "bindingSchemaVersion": binding.materialization_binding_schema_version,
        "materializedContentHash": binding.materialized_content_hash,
    }
    if any(payload.get(name) != value for name, value in expected_claims.items()):
        _fail("install_operation_receipt_invalid", "materialization receipt binding does not match", 409)
    if expected_content_hash is not None and payload.get("materializedContentHash") != expected_content_hash:
        _fail("install_operation_receipt_invalid", "materialization receipt content does not match", 409)

    commit_authorized_at = _receipt_timestamp(payload.get("commitAuthorizedAt"), "commitAuthorizedAt")
    receipt_expires_at = _receipt_timestamp(payload.get("receiptExpiresAt"), "receiptExpiresAt")
    recovery_expires_at = _receipt_timestamp(
        payload.get("materializationRecoveryExpiresAt"), "materializationRecoveryExpiresAt"
    )
    binding_recovery_expires_at = _parse_expiry(
        binding.materialization_recovery_expires_at, require_future=False
    )
    if recovery_expires_at != binding_recovery_expires_at:
        _fail("install_operation_receipt_invalid", "materialization receipt binding does not match", 409)
    now = datetime.now(timezone.utc)
    if not historical and receipt_expires_at <= now:
        _fail("install_operation_receipt_expired", "materialization receipt has expired", 409)
    if (
        commit_authorized_at > now + timedelta(minutes=5)
        or commit_authorized_at >= receipt_expires_at
        or receipt_expires_at > recovery_expires_at
    ):
        _fail("install_operation_receipt_invalid", "materialization receipt timestamps are invalid", 409)

    return {
        "digest": hashlib.sha256(compact.encode("ascii")).hexdigest(),
        "kid": kid,
        "validatedAt": now.isoformat().replace("+00:00", "Z"),
        "commitAuthorizedAt": payload["commitAuthorizedAt"],
        "receiptExpiresAt": payload["receiptExpiresAt"],
        "materializedContentHash": payload["materializedContentHash"],
        "compactJws": compact,
    }


def materialize_enterprise_skill_operation(
    *,
    operation_id: str,
    client_operation_id: str,
    key: str,
    revision: Any,
    artifact_sha256: str,
    install_authorization_hash: str,
    desktop_user_id: str,
    tenant_id: Optional[str],
    materialization_binding_schema_version: Any,
    materialized_content_hash: str,
    materialization_recovery_expires_at: str,
    receipt: str,
) -> Dict[str, Any]:
    """Idempotently make a staged, commit-authorized operation loadable."""
    binding = validate_install_operation_binding(
        operation_id,
        client_operation_id=client_operation_id,
        key=key,
        revision=revision,
        artifact_sha256=artifact_sha256,
        install_authorization_hash=install_authorization_hash,
        desktop_user_id=desktop_user_id,
        tenant_id=tenant_id,
        materialization_binding_schema_version=materialization_binding_schema_version,
        materialized_content_hash=materialized_content_hash,
        materialization_recovery_expires_at=materialization_recovery_expires_at,
    )
    receipt_proof = _verify_materialization_receipt(receipt, binding)
    skills_root, operation_dir, journal_path, skill_root = _operation_paths(binding)
    target = skills_root / ENTERPRISE_INSTALL_PREFIX / binding.metadata.key
    from tools.skills_hub import HubLockFile, HubLockFileError
    lock = HubLockFile(skills_root / ".hub" / "lock.json")
    try:
        with lock.exclusive():
            journal_key = _journal_key(skills_root)
            lock_data = lock.load_locked(strict=True)
            if not journal_path.exists():
                entry = lock_data["installed"].get(binding.metadata.key)
                if _lock_matches_operation(entry, binding) and target.is_dir() and not _is_path_redirect(target):
                    expected_content_hash = str(entry.get("content_hash", ""))
                    _manifest, actual_content_hash = _tree_manifest(target)
                    if not _SHA256_RE.fullmatch(expected_content_hash) or actual_content_hash != expected_content_hash:
                        _fail("install_operation_content_changed", "materialized target content changed", 409)
                    if receipt_proof.get("materializedContentHash") != actual_content_hash:
                        _fail("install_operation_receipt_invalid", "materialization receipt content does not match", 409)
                    if not _lock_matches_receipt_proof(entry, receipt_proof):
                        entry["metadata"]["materialization_receipt_digest"] = receipt_proof["digest"]
                        entry["metadata"]["materialization_receipt_kid"] = receipt_proof["kid"]
                        entry["metadata"]["materialization_receipt_jws"] = receipt_proof["compactJws"]
                        entry["metadata"]["materialization_receipt_validated"] = True
                        lock.save_locked(lock_data)
                    return {**_result_payload(binding.metadata, binding.metadata.key), "operationId": binding.operation_id}
                _fail("install_operation_not_found", "staged install operation was not found", 404)
            document = _read_operation_journal(journal_path, journal_key)
            _assert_journal_binding(document, binding)
            files = document.get("files")
            manifest = document["fileManifest"]
            content_hash = document["contentHash"]
            if receipt_proof.get("materializedContentHash") != content_hash:
                _fail("install_operation_receipt_invalid", "materialization receipt content does not match", 409)
            if not isinstance(files, list) or not all(isinstance(item, str) for item in files):
                _fail("install_operation_journal_invalid", "install operation file inventory is invalid", 409)

            entry = lock_data["installed"].get(binding.metadata.key)
            if target.exists() or _is_path_redirect(target):
                _verify_materialized_target(target, binding, manifest, content_hash)
                if entry is not None and not _lock_matches_operation(entry, binding):
                    _fail("skill_name_conflict", "installed skill provenance conflicts with the operation", 409)
            else:
                if entry is not None:
                    _fail("skill_name_conflict", "skill lock conflicts with the staged operation", 409)
                conflict = _find_name_conflict(binding.metadata.key, skills_root, target)
                if conflict is not None:
                    _fail("skill_name_conflict", f"a skill named {binding.metadata.key!r} already exists", 409)
                if not skill_root.is_dir() or _is_path_redirect(skill_root):
                    _fail("install_operation_stage_missing", "staged skill content is missing", 409)
                _verify_materialized_target(skill_root, binding, manifest, content_hash)
                os.replace(skill_root, target)
                _fsync_directory(target.parent)

            if not _lock_matches_operation(entry, binding):
                lock_data["installed"][binding.metadata.key] = _lock_entry(
                    binding.metadata,
                    list(files),
                    f"{ENTERPRISE_INSTALL_PREFIX}/{binding.metadata.key}",
                    operation=binding,
                    content_hash=content_hash,
                    receipt_proof=receipt_proof,
                )
                try:
                    lock.save_locked(lock_data)
                except OSError as exc:
                    # Keep target+journal so a retry can close the replace-before-lock crash window.
                    _fail("skill_lock_write_failed", f"could not persist skill lock: {exc}", 500)
            elif not _lock_matches_receipt_proof(entry, receipt_proof):
                entry["metadata"]["materialization_receipt_digest"] = receipt_proof["digest"]
                entry["metadata"]["materialization_receipt_kid"] = receipt_proof["kid"]
                entry["metadata"]["materialization_receipt_jws"] = receipt_proof["compactJws"]
                entry["metadata"]["materialization_receipt_validated"] = True
                try:
                    lock.save_locked(lock_data)
                except OSError as exc:
                    _fail("skill_lock_write_failed", f"could not persist skill lock: {exc}", 500)

            document["state"] = "materialized"
            document["materializationReceiptProof"] = receipt_proof
            document["updatedAt"] = datetime.now(timezone.utc).isoformat()
            _write_operation_journal(journal_path, document, journal_key)
    except HubLockFileError as exc:
        _fail("skill_lock_write_failed", str(exc), 500)

    try:
        from agent.prompt_builder import clear_skills_system_prompt_cache
        clear_skills_system_prompt_cache(clear_snapshot=True)
    except Exception:
        pass
    return {**_result_payload(binding.metadata, binding.metadata.key), "operationId": binding.operation_id}


def abort_enterprise_skill_operation(
    *,
    operation_id: str,
    client_operation_id: str,
    key: str,
    revision: Any,
    artifact_sha256: str,
    install_authorization_hash: str,
    desktop_user_id: str,
    tenant_id: Optional[str],
    materialization_binding_schema_version: Any,
    materialized_content_hash: str,
    materialization_recovery_expires_at: str,
) -> Dict[str, Any]:
    """Remove a staged operation only after proving no target was materialized."""

    binding = validate_install_operation_binding(
        operation_id,
        client_operation_id=client_operation_id,
        key=key,
        revision=revision,
        artifact_sha256=artifact_sha256,
        install_authorization_hash=install_authorization_hash,
        desktop_user_id=desktop_user_id,
        tenant_id=tenant_id,
        materialization_binding_schema_version=materialization_binding_schema_version,
        materialized_content_hash=materialized_content_hash,
        materialization_recovery_expires_at=materialization_recovery_expires_at,
    )
    skills_root, operation_dir, journal_path, _skill_root = _operation_paths(binding)
    target = skills_root / ENTERPRISE_INSTALL_PREFIX / binding.metadata.key
    from tools.skills_hub import HubLockFile, HubLockFileError
    lock = HubLockFile(skills_root / ".hub" / "lock.json")
    try:
        with lock.exclusive():
            journal_key = _journal_key(skills_root)
            lock_data = lock.load_locked(strict=True)
            if journal_path.exists():
                document = _read_operation_journal(journal_path, journal_key)
                _assert_journal_binding(document, binding)
                if document["state"] == "materialized":
                    _fail("install_operation_target_present", "materialized operation cannot be aborted", 409)
            entry = lock_data["installed"].get(binding.metadata.key)
            if target.exists() or _is_path_redirect(target) or _lock_matches_operation(entry, binding):
                _fail("install_operation_target_present", "materialized target is present; abort refused", 409)
            if entry is not None:
                _fail("skill_name_conflict", "skill lock conflicts with the operation", 409)
            if operation_dir.exists():
                shutil.rmtree(operation_dir)
                _fsync_directory(operation_dir.parent)
            return {**_operation_payload(binding), "state": "aborted", "targetAbsent": True}
    except HubLockFileError as exc:
        _fail("skill_lock_write_failed", str(exc), 500)


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
        metadata = entry.get("metadata") if isinstance(entry.get("metadata"), dict) else {}
        is_d4_operation = "enterprise_install_operation_id" in metadata
        if is_d4_operation:
            from hermes_cli.enterprise_policy import _enterprise_lock_entry_matches
            if not _enterprise_lock_entry_matches(
                entry,
                policy_key=safe_key,
                install_path=f"{ENTERPRISE_INSTALL_PREFIX}/{safe_name}",
                skill_root=target,
            ):
                continue
        else:
            from hermes_cli.enterprise_policy import is_enterprise_managed
            if is_enterprise_managed():
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
