from __future__ import annotations


def has_required_fields(payload: dict[str, object]) -> bool:
    return "decision" in payload and "exceptions" in payload
