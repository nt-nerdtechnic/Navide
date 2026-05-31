from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from uuid import uuid4


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def make_response(request_id: str, type_: str, payload: dict[str, Any] | None) -> dict[str, Any]:
    return {
        "id": request_id,
        "type": f"{type_}.result",
        "ok": True,
        "payload": payload or {},
        "error": None,
        "timestamp": _now_iso(),
    }


def make_error(
    request_id: str,
    type_: str,
    code: str,
    message: str,
    details: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "id": request_id,
        "type": f"{type_}.result",
        "ok": False,
        "payload": None,
        "error": {"code": code, "message": message, "details": details or {}},
        "timestamp": _now_iso(),
    }


def make_event(type_: str, payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(uuid4()),
        "type": type_,
        "payload": payload,
        "timestamp": _now_iso(),
    }
