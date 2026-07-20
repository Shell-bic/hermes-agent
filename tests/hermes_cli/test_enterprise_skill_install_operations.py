from __future__ import annotations

import base64
from datetime import datetime, timedelta, timezone
import hashlib
from io import BytesIO
import json
import os
from pathlib import Path
from types import SimpleNamespace
import zipfile

import pytest
from fastapi.testclient import TestClient

from tools import enterprise_skills as enterprise


OPERATION_ID = "8bd3e8fb-8f0d-4f1c-8850-f79e48a8aac5"
DESKTOP_USER_ID = "67f4d4f5-2164-45b4-9d62-3809e211b2f4"
CLIENT_OPERATION_ID = "desktop-operation-1"
AUTHORIZATION_HASH = "b" * 64
KID = "p256-sha256-0123456789abcdef0123456789abcdef"
MATERIALIZED_CONTENT_HASH_FIXTURE = (
    Path(__file__).parents[2]
    / "contracts"
    / "enterprise-skill-hub"
    / "v1"
    / "fixtures"
    / "materialized-content-hash-v1.json"
)


def _b64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _artifact() -> bytes:
    output = BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(
            "SKILL.md",
            "---\nname: expense-review\ndescription: Review expenses.\n---\n\n# Expense review\n",
        )
        archive.writestr("references/checklist.md", "- Verify claimant\n")
    return output.getvalue()


def _content_hash_from_artifact(artifact: bytes) -> str:
    with zipfile.ZipFile(BytesIO(artifact), "r") as archive:
        files = {
            info.filename.replace("\\", "/"): archive.read(info)
            for info in archive.infolist()
            if not info.is_dir()
        }
    digest_input = bytearray()
    for relative, content in sorted(files.items()):
        digest_input.extend(relative.encode("utf-8"))
        digest_input.extend(b"\0")
        digest_input.extend(hashlib.sha256(content).hexdigest().encode("ascii"))
        digest_input.extend(b"\0")
        digest_input.extend(str(len(content)).encode("ascii"))
        digest_input.extend(b"\n")
    return hashlib.sha256(digest_input).hexdigest()


def _content_hash() -> str:
    return _content_hash_from_artifact(_artifact())


def test_tree_manifest_matches_gateway_materialized_content_hash_fixture(tmp_path):
    fixture = json.loads(MATERIALIZED_CONTENT_HASH_FIXTURE.read_text(encoding="utf-8"))
    assert fixture["schemaVersion"] == 1
    assert fixture["algorithm"] == "sha256-tree-manifest-v1"

    skill_root = tmp_path / "fixture-skill"
    for item in fixture["files"]:
        target = skill_root.joinpath(*item["path"].split("/"))
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(base64.b64decode(item["contentBase64"], validate=True))

    manifest, content_hash = enterprise._tree_manifest(skill_root)
    assert [item["path"] for item in manifest] == sorted(
        item["path"] for item in fixture["files"]
    )
    assert content_hash == fixture["expectedMaterializedContentHash"]


@pytest.fixture(autouse=True)
def _isolated_operation_home(tmp_path, monkeypatch):
    monkeypatch.setattr(enterprise, "get_hermes_home", lambda: tmp_path)
    manager = SimpleNamespace(list_plugins=lambda: [], list_plugin_skills=lambda _name: [])
    monkeypatch.setattr("hermes_cli.plugins.discover_plugins", lambda: None)
    monkeypatch.setattr("hermes_cli.plugins.get_plugin_manager", lambda: manager)


@pytest.fixture
def signing_material(monkeypatch):
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec

    private_key = ec.generate_private_key(ec.SECP256R1())
    public_pem = private_key.public_key().public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode("ascii")
    trust = {
        "schemaVersion": 2,
        "issuer": "https://gateway.example.test",
        "audience": "hermes-enterprise-skill-runtime",
        "purpose": "hermes-enterprise-skill-materialize",
        "signerMode": "gateway-service",
        "algorithm": "ES256",
        "publicKeys": [
            {
                "kid": KID,
                "algorithm": "ES256",
                "publicKeyPem": public_pem,
                "rotationState": "current",
            }
        ],
    }
    monkeypatch.setenv(
        "HERMES_ENTERPRISE_TOOL_POLICY_JSON",
        json.dumps({"enterpriseUserId": DESKTOP_USER_ID, "skillInstallReceiptTrust": trust}),
    )
    return private_key, trust


def _binding_kwargs(artifact: bytes) -> dict:
    return {
        "operation_id": OPERATION_ID,
        "client_operation_id": CLIENT_OPERATION_ID,
        "key": "expense-review",
        "revision": 1,
        "artifact_sha256": hashlib.sha256(artifact).hexdigest(),
        "install_authorization_hash": AUTHORIZATION_HASH,
        "desktop_user_id": DESKTOP_USER_ID,
        "tenant_id": "tenant-1",
        "materialization_binding_schema_version": 2,
        "materialized_content_hash": _content_hash_from_artifact(artifact),
        # Deliberately mirrors Gateway FormatTime("O") rather than using Z.
        "materialization_recovery_expires_at": (
            datetime.now(timezone.utc) + timedelta(hours=2)
        ).isoformat(),
    }


def _claims(binding: dict, **overrides) -> dict:
    now = datetime.now(timezone.utc)
    claims = {
        "schemaVersion": 2,
        "kid": KID,
        "issuer": "https://gateway.example.test",
        "audience": "hermes-enterprise-skill-runtime",
        "purpose": "hermes-enterprise-skill-materialize",
        "bindingSchemaVersion": binding["materialization_binding_schema_version"],
        "operationId": binding["operation_id"],
        "clientOperationId": binding["client_operation_id"],
        "desktopUserId": binding["desktop_user_id"],
        "tenantId": binding["tenant_id"],
        "skillKey": binding["key"],
        "packageRevision": binding["revision"],
        "artifactSha256": binding["artifact_sha256"],
        "materializedContentHash": binding["materialized_content_hash"],
        "installAuthorizationHash": binding["install_authorization_hash"],
        "materializationRecoveryExpiresAt": binding["materialization_recovery_expires_at"],
        "commitAuthorizedAt": (now - timedelta(seconds=5)).isoformat(),
        "receiptExpiresAt": (now + timedelta(minutes=30)).isoformat(),
    }
    claims.update(overrides)
    return claims


def _sign(private_key, claims: dict, *, header: dict | None = None, payload_bytes: bytes | None = None) -> str:
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

    protected = header or {"alg": "ES256", "kid": KID, "typ": "hermes-skill-install-receipt+jws"}
    encoded_header = _b64url(json.dumps(protected, separators=(",", ":")).encode())
    raw_payload = payload_bytes or json.dumps(claims, separators=(",", ":")).encode()
    encoded_payload = _b64url(raw_payload)
    der = private_key.sign(
        f"{encoded_header}.{encoded_payload}".encode("ascii"),
        ec.ECDSA(hashes.SHA256()),
    )
    r, s = decode_dss_signature(der)
    signature = r.to_bytes(32, "big") + s.to_bytes(32, "big")
    return f"{encoded_header}.{encoded_payload}.{_b64url(signature)}"


def _stage(artifact: bytes, binding: dict) -> dict:
    return enterprise.stage_enterprise_skill_operation(
        artifact,
        **binding,
        expires_at=(datetime.now(timezone.utc) + timedelta(minutes=30)).isoformat(),
    )


def test_stage_receipt_materialize_is_bound_durable_and_idempotent(signing_material):
    private_key, _trust = signing_material
    artifact = _artifact()
    binding = _binding_kwargs(artifact)

    staged = _stage(artifact, binding)
    assert staged["state"] == "staged"
    target = enterprise.get_hermes_home() / "skills" / "enterprise" / "expense-review"
    assert not target.exists()
    assert enterprise.get_enterprise_skill_operation(**binding)["state"] == "staged"

    receipt = _sign(private_key, _claims(binding))
    installed = enterprise.materialize_enterprise_skill_operation(**binding, receipt=receipt)
    assert installed["state"] == "installed"
    assert target.joinpath("SKILL.md").is_file()

    lock = json.loads(
        (enterprise.get_hermes_home() / "skills" / ".hub" / "lock.json").read_text(encoding="utf-8")
    )
    metadata = lock["installed"]["expense-review"]["metadata"]
    assert metadata["enterprise_install_operation_id"] == OPERATION_ID
    assert metadata["enterprise_client_operation_id"] == CLIENT_OPERATION_ID
    assert metadata["install_authorization_hash"] == AUTHORIZATION_HASH
    assert metadata["materialization_binding_schema_version"] == 2
    assert metadata["materialization_receipt_validated"] is True
    assert metadata["materialization_receipt_digest"] == hashlib.sha256(receipt.encode("ascii")).hexdigest()
    assert metadata["materialization_receipt_jws"] == receipt
    assert enterprise.get_enterprise_skill_operation(**binding)["state"] == "materialized"
    assert enterprise.materialize_enterprise_skill_operation(**binding, receipt=receipt) == installed


def test_abort_is_idempotent_for_staged_content_and_refuses_materialized(signing_material):
    private_key, _trust = signing_material
    artifact = _artifact()
    binding = _binding_kwargs(artifact)
    _stage(artifact, binding)
    assert enterprise.abort_enterprise_skill_operation(**binding)["state"] == "aborted"
    assert enterprise.abort_enterprise_skill_operation(**binding)["state"] == "aborted"

    _stage(artifact, binding)
    enterprise.materialize_enterprise_skill_operation(
        **binding,
        receipt=_sign(private_key, _claims(binding)),
    )
    with pytest.raises(enterprise.EnterpriseSkillInstallError) as raised:
        enterprise.abort_enterprise_skill_operation(**binding)
    assert raised.value.code == "install_operation_target_present"


@pytest.mark.parametrize(
    ("override", "expected_code"),
    [
        ({"operationId": "2d92ffba-4fcb-4d70-928d-02bb44e49447"}, "install_operation_receipt_invalid"),
        ({"clientOperationId": "desktop-operation-2"}, "install_operation_receipt_invalid"),
        ({"desktopUserId": "2d92ffba-4fcb-4d70-928d-02bb44e49447"}, "install_operation_receipt_invalid"),
        ({"tenantId": "tenant-2"}, "install_operation_receipt_invalid"),
        ({"skillKey": "other-skill"}, "install_operation_receipt_invalid"),
        ({"artifactSha256": "c" * 64}, "install_operation_receipt_invalid"),
        ({"materializedContentHash": "c" * 64}, "install_operation_receipt_invalid"),
        ({"installAuthorizationHash": "d" * 64}, "install_operation_receipt_invalid"),
        ({"materializationRecoveryExpiresAt": "2026-07-22T10:30:00+00:00"}, "install_operation_receipt_invalid"),
        ({"packageRevision": True}, "install_operation_receipt_invalid"),
        ({"packageRevision": 1.0}, "install_operation_receipt_invalid"),
        ({"bindingSchemaVersion": True}, "install_operation_receipt_invalid"),
        ({"bindingSchemaVersion": 1.0}, "install_operation_receipt_invalid"),
        ({"receiptExpiresAt": "2000-01-01T00:00:00+00:00"}, "install_operation_receipt_expired"),
    ],
)
def test_signed_receipt_rejects_tampered_binding_types_and_expiry(signing_material, override, expected_code):
    private_key, _trust = signing_material
    artifact = _artifact()
    binding = _binding_kwargs(artifact)
    receipt = _sign(private_key, _claims(binding, **override))
    with pytest.raises(enterprise.EnterpriseSkillInstallError) as raised:
        enterprise._verify_materialization_receipt(
            receipt,
            enterprise.validate_install_operation_binding(**binding),
            expected_content_hash=_content_hash(),
        )
    assert raised.value.code == expected_code


def test_receipt_verifies_signature_before_untrusted_expiry(signing_material):
    private_key, _trust = signing_material
    artifact = _artifact()
    binding = _binding_kwargs(artifact)
    receipt = _sign(private_key, _claims(binding))
    header, payload, signature = receipt.split(".")
    forged_payload = _b64url(
        json.dumps(_claims(binding, receiptExpiresAt="2000-01-01T00:00:00+00:00"), separators=(",", ":")).encode()
    )
    forged = f"{header}.{forged_payload}.{signature}"
    with pytest.raises(enterprise.EnterpriseSkillInstallError) as raised:
        enterprise._verify_materialization_receipt(
            forged,
            enterprise.validate_install_operation_binding(**binding),
            expected_content_hash=_content_hash(),
        )
    assert raised.value.code == "install_operation_receipt_invalid"


@pytest.mark.parametrize("kind", ["extra", "duplicate", "alg", "kid", "signature"])
def test_receipt_rejects_noncanonical_or_untrusted_contract(signing_material, kind):
    private_key, _trust = signing_material
    artifact = _artifact()
    binding = _binding_kwargs(artifact)
    claims = _claims(binding)
    header = None
    payload_bytes = None
    if kind == "extra":
        claims["unexpected"] = "value"
    elif kind == "duplicate":
        encoded = json.dumps(claims, separators=(",", ":"))
        payload_bytes = encoded[:-1].encode() + b',"operationId":"' + OPERATION_ID.encode() + b'"}'
    elif kind == "alg":
        header = {"alg": "ES384", "kid": KID, "typ": "hermes-skill-install-receipt+jws"}
    elif kind == "kid":
        header = {"alg": "ES256", "kid": "unknown-key", "typ": "hermes-skill-install-receipt+jws"}
    receipt = _sign(private_key, claims, header=header, payload_bytes=payload_bytes)
    if kind == "signature":
        head, body, _signature = receipt.split(".")
        receipt = f"{head}.{body}.{_b64url(bytes(64))}"
    with pytest.raises(enterprise.EnterpriseSkillInstallError) as raised:
        enterprise._verify_materialization_receipt(
            receipt,
            enterprise.validate_install_operation_binding(**binding),
            expected_content_hash=_content_hash(),
        )
    assert raised.value.code == "install_operation_receipt_invalid"


def test_local_development_signer_requires_explicit_non_request_configuration(signing_material, monkeypatch):
    private_key, trust = signing_material
    trust["signerMode"] = "local-development"
    monkeypatch.setenv(
        "HERMES_ENTERPRISE_TOOL_POLICY_JSON",
        json.dumps({"skillInstallReceiptTrust": trust}),
    )
    artifact = _artifact()
    binding = _binding_kwargs(artifact)
    receipt = _sign(private_key, _claims(binding))
    validated_binding = enterprise.validate_install_operation_binding(**binding)
    with pytest.raises(enterprise.EnterpriseSkillInstallError) as raised:
        enterprise._verify_materialization_receipt(
            receipt, validated_binding, expected_content_hash=_content_hash()
        )
    assert raised.value.code == "install_operation_receipt_invalid"

    monkeypatch.setenv(enterprise.LOCAL_DEVELOPMENT_RECEIPT_ENV, "1")
    assert enterprise._verify_materialization_receipt(
        receipt, validated_binding, expected_content_hash=_content_hash()
    )["kid"] == KID

    trust["signerMode"] = "testing"
    monkeypatch.setenv(
        "HERMES_ENTERPRISE_TOOL_POLICY_JSON",
        json.dumps({"skillInstallReceiptTrust": trust}),
    )
    with pytest.raises(enterprise.EnterpriseSkillInstallError) as testing_rejected:
        enterprise._verify_materialization_receipt(
            receipt, validated_binding, expected_content_hash=_content_hash()
        )
    assert testing_rejected.value.code == "install_operation_receipt_invalid"


@pytest.mark.parametrize(
    "kind",
    ["count", "duplicate", "oversized", "total", "private", "no-current", "two-current", "two-previous"],
)
def test_receipt_trust_bundle_limits_fail_closed(signing_material, monkeypatch, tmp_path, kind):
    from cryptography.hazmat.primitives import serialization

    private_key, trust = signing_material
    trust = json.loads(json.dumps(trust))
    key = trust["publicKeys"][0]
    if kind == "count":
        trust["publicKeys"] = [{**key, "kid": f"key-{index}"} for index in range(17)]
    elif kind == "duplicate":
        trust["publicKeys"] = [key, dict(key)]
    elif kind == "oversized":
        trust["publicKeys"] = [{**key, "publicKeyPem": "A" * (8 * 1024 + 1)}]
    elif kind == "total":
        padded = f'{key["publicKeyPem"]}{" " * 4000}'
        trust["publicKeys"] = [
            {**key, "kid": f"key-{index}", "publicKeyPem": padded} for index in range(16)
        ]
    elif kind == "private":
        trust["publicKeys"] = [{
            **key,
            "publicKeyPem": private_key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            ).decode("ascii"),
        }]
    elif kind == "no-current":
        trust["publicKeys"] = [{**key, "rotationState": "retired"}]
    elif kind == "two-current":
        trust["publicKeys"] = [key, {**key, "kid": "second-current"}]
    else:
        trust["publicKeys"] = [
            key,
            {**key, "kid": "previous-1", "rotationState": "previous"},
            {**key, "kid": "previous-2", "rotationState": "previous"},
        ]
    policy_json = json.dumps({"enterpriseUserId": DESKTOP_USER_ID, "skillInstallReceiptTrust": trust})
    if kind == "total":
        policy_path = tmp_path / "oversized-trust.json"
        policy_path.write_text(policy_json, encoding="utf-8")
        monkeypatch.delenv("HERMES_ENTERPRISE_TOOL_POLICY_JSON", raising=False)
        monkeypatch.setenv("HERMES_ENTERPRISE_TOOL_POLICY_FILE", str(policy_path))
    else:
        monkeypatch.setenv("HERMES_ENTERPRISE_TOOL_POLICY_JSON", policy_json)
    artifact = _artifact()
    binding = _binding_kwargs(artifact)
    with pytest.raises(enterprise.EnterpriseSkillInstallError) as raised:
        enterprise._verify_materialization_receipt(
            _sign(private_key, _claims(binding)),
            enterprise.validate_install_operation_binding(**binding),
            expected_content_hash=_content_hash(),
        )
    assert raised.value.code == "install_operation_receipt_invalid"


@pytest.mark.parametrize("revision", [True, "1", 1.0])
def test_operation_binding_requires_exact_integer_revision(revision):
    artifact = _artifact()
    binding = {**_binding_kwargs(artifact), "revision": revision}
    with pytest.raises(enterprise.EnterpriseSkillInstallError) as raised:
        enterprise.validate_install_operation_binding(**binding)
    assert raised.value.code == "invalid_install_operation"


@pytest.mark.parametrize(
    "override",
    [
        {"materialization_binding_schema_version": 1},
        {"materialized_content_hash": ""},
    ],
)
def test_operation_binding_rejects_legacy_schema_or_invalid_materialized_hash(override):
    binding = {**_binding_kwargs(_artifact()), **override}
    with pytest.raises(enterprise.EnterpriseSkillInstallError) as raised:
        enterprise.validate_install_operation_binding(**binding)
    assert raised.value.code == "invalid_install_operation"


def test_stage_rejects_gateway_materialized_content_hash_mismatch_before_durable_stage():
    artifact = _artifact()
    binding = {**_binding_kwargs(artifact), "materialized_content_hash": "d" * 64}
    with pytest.raises(enterprise.EnterpriseSkillInstallError) as raised:
        _stage(artifact, binding)
    assert raised.value.code == "install_operation_content_mismatch"
    operation_root = enterprise.get_hermes_home() / "enterprise-install-operations"
    assert not operation_root.joinpath(OPERATION_ID).exists()


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("revision", True),
        ("revision", "1"),
        ("revision", 1.0),
        ("materializationBindingSchemaVersion", True),
        ("materializationBindingSchemaVersion", "1"),
        ("materializationBindingSchemaVersion", 1.0),
    ],
)
def test_operation_json_endpoint_rejects_coerced_integer_fields(field, value):
    from hermes_cli import web_server

    client = TestClient(web_server.app)
    client.headers[web_server._SESSION_HEADER_NAME] = web_server._SESSION_TOKEN
    artifact = _artifact()
    binding = _binding_kwargs(artifact)
    body = {
        "clientOperationId": binding["client_operation_id"],
        "key": binding["key"],
        "revision": binding["revision"],
        "artifactSha256": binding["artifact_sha256"],
        "installAuthorizationHash": binding["install_authorization_hash"],
        "desktopUserId": binding["desktop_user_id"],
        "tenantId": binding["tenant_id"],
        "materializationBindingSchemaVersion": binding["materialization_binding_schema_version"],
        "materializedContentHash": binding["materialized_content_hash"],
        "materializationRecoveryExpiresAt": binding["materialization_recovery_expires_at"],
        "receipt": "header.payload.signature",
        field: value,
    }
    response = client.post(
        f"/api/skills/enterprise/install-operations/{OPERATION_ID}/materialize",
        json=body,
    )
    assert response.status_code == 422


def _operation_route_headers(web_server, binding: dict) -> dict:
    return {
        web_server._SESSION_HEADER_NAME: web_server._SESSION_TOKEN,
        web_server._ENTERPRISE_CLIENT_OPERATION_HEADER: binding["client_operation_id"],
        web_server._ENTERPRISE_INSTALL_AUTHORIZATION_HEADER: binding["install_authorization_hash"],
        web_server._ENTERPRISE_DESKTOP_USER_HEADER: binding["desktop_user_id"],
        web_server._ENTERPRISE_TENANT_HEADER: binding["tenant_id"],
        web_server._ENTERPRISE_MATERIALIZATION_BINDING_SCHEMA_HEADER: str(
            binding["materialization_binding_schema_version"]
        ),
        web_server._ENTERPRISE_MATERIALIZED_CONTENT_HASH_HEADER: binding["materialized_content_hash"],
        web_server._ENTERPRISE_MATERIALIZATION_RECOVERY_EXPIRY_HEADER: binding[
            "materialization_recovery_expires_at"
        ],
    }


def test_operation_status_http_route_returns_staged_operation():
    from hermes_cli import web_server

    artifact = _artifact()
    binding = _binding_kwargs(artifact)
    _stage(artifact, binding)
    response = TestClient(web_server.app).get(
        f"/api/skills/enterprise/install-operations/{OPERATION_ID}",
        params={
            "key": binding["key"],
            "revision": str(binding["revision"]),
            "artifactSha256": binding["artifact_sha256"],
        },
        headers=_operation_route_headers(web_server, binding),
    )

    assert response.status_code == 200
    assert response.json()["state"] == "staged"
    assert response.json()["revision"] == 1


@pytest.mark.parametrize("revision", ["", "0", "01", "+1", "1.0", "true"])
def test_operation_status_http_route_rejects_noncanonical_revision(revision):
    from hermes_cli import web_server

    artifact = _artifact()
    binding = _binding_kwargs(artifact)
    response = TestClient(web_server.app).get(
        f"/api/skills/enterprise/install-operations/{OPERATION_ID}",
        params={
            "key": binding["key"],
            "revision": revision,
            "artifactSha256": binding["artifact_sha256"],
        },
        headers=_operation_route_headers(web_server, binding),
    )

    assert response.status_code == 400
    assert response.json()["code"] == "invalid_install_operation"


def test_managed_loader_reverifies_receipt_current_user_and_current_content(signing_material, monkeypatch):
    from hermes_cli.enterprise_policy import _enterprise_lock_entry_matches

    private_key, trust = signing_material
    artifact = _artifact()
    binding = _binding_kwargs(artifact)
    _stage(artifact, binding)
    receipt = _sign(private_key, _claims(binding))
    enterprise.materialize_enterprise_skill_operation(**binding, receipt=receipt)
    skills_root = enterprise.get_hermes_home() / "skills"
    skill_root = skills_root / "enterprise" / "expense-review"
    lock_path = skills_root / ".hub" / "lock.json"
    base = json.loads(lock_path.read_text(encoding="utf-8"))["installed"]["expense-review"]

    assert _enterprise_lock_entry_matches(
        base,
        policy_key="expense-review",
        install_path="enterprise/expense-review",
        skill_root=skill_root,
    )
    assert [item["key"] for item in enterprise.list_installed_enterprise_skills()["items"]] == [
        "expense-review"
    ]
    for metadata_override in [
        {"enterprise_install_operation_id": "not-a-guid"},
        {"enterprise_client_operation_id": ""},
        {"install_authorization_hash": "B" * 64},
        {"enterprise_desktop_user_id": "not-a-guid"},
        {"enterprise_tenant_id": ""},
        {"materialization_binding_schema_version": True},
        {"materialization_receipt_digest": "C" * 64},
        {"materialization_receipt_kid": ""},
        {"materialization_receipt_jws": "header.payload.signature"},
        {"materialization_receipt_validated": False},
    ]:
        forged = json.loads(json.dumps(base))
        forged["metadata"].update(metadata_override)
        assert not _enterprise_lock_entry_matches(
            forged,
            policy_key="expense-review",
            install_path="enterprise/expense-review",
            skill_root=skill_root,
        )
    legacy = json.loads(json.dumps(base))
    del legacy["metadata"]["materialization_receipt_jws"]
    assert not _enterprise_lock_entry_matches(
        legacy,
        policy_key="expense-review",
        install_path="enterprise/expense-review",
        skill_root=skill_root,
    )
    forged_lock = {"installed": {"expense-review": json.loads(json.dumps(base))}}
    forged_lock["installed"]["expense-review"]["metadata"]["materialization_receipt_jws"] = (
        "header.payload.signature"
    )
    lock_path.write_text(json.dumps(forged_lock), encoding="utf-8")
    assert enterprise.list_installed_enterprise_skills()["items"] == []
    lock_path.write_text(json.dumps({"installed": {"expense-review": base}}), encoding="utf-8")

    monkeypatch.setenv(
        "HERMES_ENTERPRISE_TOOL_POLICY_JSON",
        json.dumps({
            "enterpriseUserId": "2d92ffba-4fcb-4d70-928d-02bb44e49447",
            "skillInstallReceiptTrust": trust,
        }),
    )
    assert not _enterprise_lock_entry_matches(
        base,
        policy_key="expense-review",
        install_path="enterprise/expense-review",
        skill_root=skill_root,
    )
    assert enterprise.list_installed_enterprise_skills()["items"] == []
    monkeypatch.setenv(
        "HERMES_ENTERPRISE_TOOL_POLICY_JSON",
        json.dumps({"enterpriseUserId": DESKTOP_USER_ID, "skillInstallReceiptTrust": trust}),
    )

    skill_root.joinpath("references/checklist.md").write_text("tampered\n", encoding="utf-8")
    assert not _enterprise_lock_entry_matches(
        base,
        policy_key="expense-review",
        install_path="enterprise/expense-review",
        skill_root=skill_root,
    )
    assert enterprise.list_installed_enterprise_skills()["items"] == []


def test_managed_loader_accepts_retired_history_but_rejects_revoked_or_removed_key(
    signing_material, monkeypatch
):
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from hermes_cli.enterprise_policy import _enterprise_lock_entry_matches

    private_key, trust = signing_material
    artifact = _artifact()
    binding = _binding_kwargs(artifact)
    _stage(artifact, binding)
    receipt = _sign(private_key, _claims(binding))
    enterprise.materialize_enterprise_skill_operation(**binding, receipt=receipt)
    skills_root = enterprise.get_hermes_home() / "skills"
    skill_root = skills_root / "enterprise" / "expense-review"
    entry = json.loads((skills_root / ".hub" / "lock.json").read_text(encoding="utf-8"))[
        "installed"
    ]["expense-review"]

    historical_key = trust["publicKeys"][0]
    historical_key["rotationState"] = "retired"
    current_private_key = ec.generate_private_key(ec.SECP256R1())
    trust["publicKeys"].append({
        "kid": "new-current-key",
        "algorithm": "ES256",
        "publicKeyPem": current_private_key.public_key().public_bytes(
            serialization.Encoding.PEM,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        ).decode("ascii"),
        "rotationState": "current",
    })
    monkeypatch.setenv(
        "HERMES_ENTERPRISE_TOOL_POLICY_JSON",
        json.dumps({"enterpriseUserId": DESKTOP_USER_ID, "skillInstallReceiptTrust": trust}),
    )
    assert _enterprise_lock_entry_matches(
        entry,
        policy_key="expense-review",
        install_path="enterprise/expense-review",
        skill_root=skill_root,
    )
    assert len(enterprise.list_installed_enterprise_skills()["items"]) == 1
    with pytest.raises(enterprise.EnterpriseSkillInstallError):
        enterprise._verify_materialization_receipt(
            receipt,
            enterprise.validate_install_operation_binding(**binding),
            expected_content_hash=_content_hash(),
        )

    historical_key["rotationState"] = "revoked"
    monkeypatch.setenv(
        "HERMES_ENTERPRISE_TOOL_POLICY_JSON",
        json.dumps({"enterpriseUserId": DESKTOP_USER_ID, "skillInstallReceiptTrust": trust}),
    )
    assert not _enterprise_lock_entry_matches(
        entry,
        policy_key="expense-review",
        install_path="enterprise/expense-review",
        skill_root=skill_root,
    )
    assert enterprise.list_installed_enterprise_skills()["items"] == []

    trust["publicKeys"] = [trust["publicKeys"][1]]
    monkeypatch.setenv(
        "HERMES_ENTERPRISE_TOOL_POLICY_JSON",
        json.dumps({"enterpriseUserId": DESKTOP_USER_ID, "skillInstallReceiptTrust": trust}),
    )
    assert not _enterprise_lock_entry_matches(
        entry,
        policy_key="expense-review",
        install_path="enterprise/expense-review",
        skill_root=skill_root,
    )
    assert enterprise.list_installed_enterprise_skills()["items"] == []


def test_replace_before_lock_failure_is_recovered_by_receipt_retry(signing_material, monkeypatch):
    from tools.skills_hub import HubLockFile

    private_key, _trust = signing_material
    artifact = _artifact()
    binding = _binding_kwargs(artifact)
    _stage(artifact, binding)
    receipt = _sign(private_key, _claims(binding))
    original_save = HubLockFile.save_locked
    failures = 0

    def fail_first_save(self, data):
        nonlocal failures
        failures += 1
        if failures == 1:
            raise OSError("simulated lock persistence failure")
        return original_save(self, data)

    monkeypatch.setattr(HubLockFile, "save_locked", fail_first_save)
    with pytest.raises(enterprise.EnterpriseSkillInstallError) as raised:
        enterprise.materialize_enterprise_skill_operation(**binding, receipt=receipt)
    assert raised.value.code == "skill_lock_write_failed"
    target = enterprise.get_hermes_home() / "skills" / "enterprise" / "expense-review"
    assert target.is_dir()
    assert enterprise.get_enterprise_skill_operation(**binding)["state"] == "materialize-pending"
    assert enterprise.materialize_enterprise_skill_operation(**binding, receipt=receipt)["state"] == "installed"


def test_lock_before_journal_failure_is_closed_by_receipt_retry(signing_material, monkeypatch):
    private_key, _trust = signing_material
    artifact = _artifact()
    binding = _binding_kwargs(artifact)
    _stage(artifact, binding)
    receipt = _sign(private_key, _claims(binding))
    original_write = enterprise._write_operation_journal
    failed = False

    def fail_materialized_journal(path, payload, key):
        nonlocal failed
        if payload.get("state") == "materialized" and not failed:
            failed = True
            raise OSError("simulated journal persistence failure")
        return original_write(path, payload, key)

    monkeypatch.setattr(enterprise, "_write_operation_journal", fail_materialized_journal)
    with pytest.raises(OSError, match="simulated journal"):
        enterprise.materialize_enterprise_skill_operation(**binding, receipt=receipt)
    assert enterprise.get_enterprise_skill_operation(**binding)["state"] == "materialize-pending"
    assert enterprise.materialize_enterprise_skill_operation(**binding, receipt=receipt)["state"] == "installed"
    assert enterprise.get_enterprise_skill_operation(**binding)["state"] == "materialized"


def test_cleanup_never_deletes_expired_staged_operation_without_explicit_abort():
    from tools.skills_hub import HubLockFile

    artifact = _artifact()
    binding = _binding_kwargs(artifact)
    _stage(artifact, binding)
    skills_root = enterprise.get_hermes_home() / "skills"
    operation_root = skills_root / ".hub" / "quarantine" / enterprise.ENTERPRISE_OPERATION_DIR
    journal_path = operation_root / OPERATION_ID / "operation.json"
    lock = HubLockFile(skills_root / ".hub" / "lock.json")
    with lock.exclusive():
        journal_key = enterprise._journal_key(skills_root)
        document = enterprise._read_operation_journal(journal_path, journal_key)
        document["expiresAt"] = "2000-01-01T00:00:00Z"
        enterprise._write_operation_journal(journal_path, document, journal_key)
        count = enterprise._cleanup_install_operations_locked(
            operation_root,
            journal_key,
            skills_root,
            lock.load_locked(strict=True),
        )
    assert count == 1
    assert journal_path.is_file()


def test_stage_quota_and_thousand_file_journal_remain_bounded(monkeypatch):
    output = BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(
            "SKILL.md",
            "---\nname: expense-review\ndescription: Review expenses.\n---\n",
        )
        for index in range(999):
            archive.writestr(f"references/{index:04}.txt", "x")
    artifact = output.getvalue()
    first = _binding_kwargs(artifact)
    assert _stage(artifact, first)["state"] == "staged"
    assert enterprise.get_enterprise_skill_operation(**first)["state"] == "staged"
    journal = (
        enterprise.get_hermes_home()
        / "skills"
        / ".hub"
        / "quarantine"
        / enterprise.ENTERPRISE_OPERATION_DIR
        / OPERATION_ID
        / "operation.json"
    )
    assert journal.stat().st_size < enterprise.MAX_OPERATION_JOURNAL_BYTES

    monkeypatch.setattr(enterprise, "MAX_STAGED_INSTALL_OPERATIONS", 1)
    second = {
        **first,
        "operation_id": "2d92ffba-4fcb-4d70-928d-02bb44e49447",
        "client_operation_id": "desktop-operation-2",
    }
    with pytest.raises(enterprise.EnterpriseSkillInstallError) as raised:
        _stage(artifact, second)
    assert raised.value.code == "install_operation_stage_limit"
    assert raised.value.status_code == 429


def test_candidate_with_written_journal_is_collected_after_crash_ttl():
    from tools.skills_hub import HubLockFile

    skills_root = enterprise.get_hermes_home() / "skills"
    quarantine = skills_root / ".hub" / "quarantine"
    candidate = quarantine / ".enterprise-op-stage-crashed"
    candidate.mkdir(parents=True)
    (candidate / "operation.json").write_text('{"partial":"journal-written"}', encoding="utf-8")
    old = (datetime.now(timezone.utc) - enterprise.CANDIDATE_RETENTION - timedelta(minutes=1)).timestamp()
    os.utime(candidate / "operation.json", (old, old))
    os.utime(candidate, (old, old))

    lock = HubLockFile(skills_root / ".hub" / "lock.json")
    with lock.exclusive():
        enterprise._cleanup_stage_candidates_locked(quarantine, keep=quarantine / ".enterprise-op-stage-active")
    assert not candidate.exists()
