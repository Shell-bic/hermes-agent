"""Synthetic credentials used by Secret Boundary tests.

These values are intentionally non-production and must never be replaced with
real credentials.  Keeping one fixture shared across file, terminal, process,
and export tests proves that every surface applies the same policy.
"""

import base64

FAKE_SECRET_ENV = {
    "COMPANY_GATEWAY_TOKEN": "gw_test_secret_boundary_1234567890",
    "HERMES_DASHBOARD_SESSION_TOKEN": "adm_test_secret_boundary_1234567890",
    "DESKTOP_TOKEN": "dsk_test_secret_boundary_1234567890",
    "OPENAI_API_KEY": "sk-test-secret-boundary-1234567890",
}

FAKE_SECRET_VALUES = tuple(FAKE_SECRET_ENV.values())

FAKE_ENV_TEXT = "\n".join(
    f"{name}={value}" for name, value in FAKE_SECRET_ENV.items()
) + "\n"


def fake_encoded_representations(value: str) -> dict[str, str]:
    """Return one-layer encodings of synthetic data used by D1 tests."""
    raw = value.encode("utf-8")
    # The synthetic lock prefix makes the URL-safe representation exercise
    # its ``-`` alphabet rather than accidentally matching standard Base64.
    urlsafe_raw = ("🔐" + value).encode("utf-8")
    urlsafe = base64.urlsafe_b64encode(urlsafe_raw).decode("ascii")
    return {
        "percent": "".join(f"%{byte:02X}" for byte in raw),
        "hex": raw.hex(),
        "base64": base64.b64encode(raw).decode("ascii"),
        "urlsafe_base64": urlsafe,
        "urlsafe_base64_unpadded": urlsafe.rstrip("="),
    }


def assert_fake_secrets_redacted(text: str) -> None:
    """Assert that no complete synthetic credential survives in *text*."""
    for secret in FAKE_SECRET_VALUES:
        assert secret not in text
