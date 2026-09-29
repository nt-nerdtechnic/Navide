"""plans.list must answer for front matter that YAML parses into non-JSON types.

`created: 2026-01-01` loads as a ``datetime.date``. If that value reaches the
response frame the child cannot serialise it, the request thread dies, and the
Host waits out its 30 s call timeout and withdraws Plans for the session.
"""

from __future__ import annotations

import base64
import json
import queue
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any

import pytest

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ENTRY = REPOSITORY_ROOT / "plugins" / "navide-plans" / "backend" / "plans_backend.py"
PROTOCOL_REVISION = "2026-07-28"
SERVER_INFO_KEY = "io.modelcontextprotocol/serverInfo"

CLIENT_META = {
    "io.modelcontextprotocol/protocolVersion": PROTOCOL_REVISION,
    "io.modelcontextprotocol/clientCapabilities": {},
    "io.modelcontextprotocol/clientInfo": {"name": "navide-plans-test", "version": "1"},
}
RUNTIME = {
    "pluginId": "navide.plans",
    "packageVersion": "0.1.0",
    "workspaceId": "workspace-hash",
    "instanceId": "instance-1",
    "contributionKey": "navide.plans.mcp",
    "hostWindowId": None,
    "initiator": {"kind": "agent", "source": "mcp", "id": "agent-1"},
}

DOCUMENT_DIR = ".cursor/plans"
DOCUMENT_PATH = f"{DOCUMENT_DIR}/dated.plan.md"
DOCUMENT = (
    "---\n"
    "name: Dated plan\n"
    "created: 2026-01-01\n"
    "updated: 2026-01-02 03:04:05\n"
    "stage: draft\n"
    "todos:\n"
    "  - id: first\n"
    "    content: First\n"
    "    status: pending\n"
    "    due: 2026-02-03\n"
    "---\n"
    "\n# Dated plan\n"
)


@pytest.fixture
def child() -> Any:
    process = subprocess.Popen(
        [sys.executable, "-B", str(BACKEND_ENTRY)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    frames: queue.Queue[bytes] = queue.Queue()

    def pump() -> None:
        assert process.stdout is not None
        for line in iter(process.stdout.readline, b""):
            frames.put(line)
        frames.put(b"")

    threading.Thread(target=pump, daemon=True).start()
    process.frames = frames  # type: ignore[attr-defined]
    try:
        yield process
    finally:
        process.kill()
        process.wait(timeout=5)
        for stream in (process.stdin, process.stdout, process.stderr):
            if stream is not None:
                stream.close()


def _send(process: Any, frame: dict[str, Any]) -> None:
    process.stdin.write(json.dumps(frame, separators=(",", ":")).encode() + b"\n")
    process.stdin.flush()


def _reply(process: Any, request: dict[str, Any], value: Any) -> None:
    _send(
        process,
        {
            "jsonrpc": "2.0",
            "id": request["id"],
            "result": {
                "resultType": "complete",
                "value": value,
                "_meta": {SERVER_INFO_KEY: {"name": "host-test", "version": "1"}},
            },
        },
    )


def _fail(process: Any, request: dict[str, Any], code: str) -> None:
    _send(
        process,
        {
            "jsonrpc": "2.0",
            "id": request["id"],
            "error": {"code": 1000, "message": "test", "data": {"code": code}},
        },
    )


def _serve_host(process: Any, request_id: str, timeout: float = 4.0) -> dict[str, Any]:
    """Play the Host filesystem bridge until the call `request_id` is answered."""
    raw = DOCUMENT.encode("utf-8")
    while True:
        try:
            line = process.frames.get(timeout=timeout)
        except queue.Empty:
            raise AssertionError(
                f"no answer to {request_id} within {timeout}s (the Host would time out and withdraw Plans)"
            ) from None
        assert line, "child exited"
        frame = json.loads(line)
        if frame.get("id") == request_id:
            return frame
        assert frame.get("method") == "navide/host/call"
        operation = frame["params"]["operation"]
        arguments = frame["params"]["arguments"]
        rel_path = arguments.get("rel_path")
        if operation == "stat_path":
            _reply(process, frame, {"exists": rel_path == DOCUMENT_DIR, "isDirectory": rel_path == DOCUMENT_DIR})
        elif operation == "list_dir":
            _reply(process, frame, {"entries": ["dated.plan.md"] if rel_path == DOCUMENT_DIR else []})
        elif operation == "read_range" and rel_path == DOCUMENT_PATH:
            offset, length = arguments["offset"], arguments["length"]
            piece = raw[offset : offset + length]
            _reply(
                process,
                frame,
                {
                    "data_base64": base64.b64encode(piece).decode("ascii"),
                    "size": len(raw),
                    "mtime": 100.0,
                    "eof": offset + len(piece) >= len(raw),
                },
            )
        elif operation == "read_file" and rel_path == DOCUMENT_PATH:
            _reply(process, frame, {"content": DOCUMENT, "mtime": 100.0})
        else:
            _fail(process, frame, "BACKEND_UNAVAILABLE")


def _call(process: Any, request_id: str, name: str, arguments: dict[str, Any]) -> None:
    _send(
        process,
        {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": "navide/call",
            "params": {"_meta": CLIENT_META, "name": name, "arguments": arguments, "runtime": RUNTIME},
        },
    )


def test_list_answers_for_front_matter_with_dates(child: Any) -> None:
    _call(child, "list-1", "plans.list", {})
    response = _serve_host(child, "list-1")

    assert "result" in response, response
    entries = response["result"]["value"]
    entry = next(item for item in entries if item["rel_path"] == DOCUMENT_PATH)
    assert entry["name"] == "Dated plan"
    # Whatever a date becomes, it must have crossed the wire as JSON.
    json.dumps(entry)


def test_read_answers_for_front_matter_with_dates(child: Any) -> None:
    _call(child, "read-1", "plans.read", {"rel_path": DOCUMENT_PATH})
    response = _serve_host(child, "read-1")

    assert "result" in response, response
    value = response["result"]["value"]
    assert value["meta"]["name"] == "Dated plan"
    assert "# Dated plan" in value["html"]


def test_child_survives_an_unserialisable_request(child: Any) -> None:
    _call(child, "list-2", "plans.list", {})
    first = _serve_host(child, "list-2")
    assert "result" in first or "error" in first

    _call(child, "list-3", "plans.list", {})
    second = _serve_host(child, "list-3")
    assert "result" in second or "error" in second
    assert child.poll() is None
