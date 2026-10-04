"""The packaged Plans backend reads its own plan files.

The Host hands the child only one thing: the Host-authorized plan root, through
the authenticated ``filesystem.resolve_root`` bridge call. Every other read is
the child's own ``open()``, so the path checks the Host's filesystem service
used to apply (root containment, symlink escape, ``..``) must hold in the child
itself. The fake Host here answers ``resolve_root`` and fails the test on any
other filesystem bridge read.
"""

from __future__ import annotations

import hashlib
import os
import subprocess
import threading
from pathlib import Path
from typing import Any

import pytest

from tests.test_navide_plans_backend_wire import (  # noqa: F401 - backend_process is a fixture
    CLIENT_META,
    RUNTIME,
    _assert_same_text,
    _error_bridge,
    _plan_html,
    _read,
    _reply_bridge,
    _send,
    backend_process,
)

BRIDGE_READS = {"read_file", "read_range", "list_dir", "stat_path"}


class _RootOnlyHost:
    """Answers resolve_root with a fixed root per instance; refuses reads."""

    def __init__(self, roots: dict[str | None, Path], *, fail_root: str | None = None) -> None:
        self.roots = roots
        self.fail_root = fail_root
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.pending_roots: list[dict[str, Any]] = []

    def __call__(self, process: subprocess.Popen[bytes], frame: dict[str, Any], instance: str | None) -> None:
        params = frame["params"]
        assert params["port"] == "filesystem"
        operation = params["operation"]
        self.calls.append((operation, dict(params["arguments"])))
        if operation in BRIDGE_READS:
            raise AssertionError(f"the child read through the Host bridge: {operation} {params['arguments']}")
        if operation != "resolve_root":
            raise AssertionError(f"unexpected filesystem operation: {operation}")
        if self.fail_root is not None:
            _error_bridge(process, frame, self.fail_root)
            return
        _reply_bridge(process, frame, {"root": str(self.roots[instance].resolve())})

    def root_calls(self) -> int:
        return sum(1 for operation, _ in self.calls if operation == "resolve_root")


_counter = 0


def _runtime(instance: str | None) -> dict[str, Any]:
    return {**RUNTIME, "instanceId": instance}


def _request(process: subprocess.Popen[bytes], name: str, arguments: dict[str, Any], instance: str | None) -> str:
    global _counter
    _counter += 1
    request_id = f"direct-{_counter}"
    _send(
        process,
        {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": "navide/call",
            "params": {"_meta": CLIENT_META, "name": name, "arguments": arguments, "runtime": _runtime(instance)},
        },
    )
    return request_id


def _call(
    process: subprocess.Popen[bytes],
    host: _RootOnlyHost,
    name: str,
    arguments: dict[str, Any],
    instance: str | None = "instance-1",
) -> dict[str, Any]:
    request_id = _request(process, name, arguments, instance)
    while True:
        frame = _read(process, timeout=30)
        if frame.get("id") == request_id:
            return frame
        assert frame.get("method") == "navide/host/call", frame
        host(process, frame, instance)


def _value(frame: dict[str, Any]) -> Any:
    assert "result" in frame, frame
    return frame["result"]["value"]


def _error_code(frame: dict[str, Any]) -> str:
    assert "error" in frame, frame
    return frame["error"]["data"]["code"]


def _workspace(base: Path, name: str) -> Path:
    root = base / name
    (root / ".agent-team" / "plans").mkdir(parents=True)
    return root


# ── G1–G3: reads stay inside the Host-authorized root ────────────────────────


def test_path_outside_plans_root_is_refused(backend_process: subprocess.Popen[bytes], tmp_path: Path) -> None:
    mine = _workspace(tmp_path, "mine")
    other = _workspace(tmp_path, "other")
    (mine / ".agent-team" / "plans" / "own_aaaaaa.html").write_text(_plan_html("Own plan"), encoding="utf-8")
    (other / "docs" / "plans").mkdir(parents=True)
    secret = _plan_html("Other workspace secret")
    (other / "docs" / "plans" / "secret_bbbbbb.html").write_text(secret, encoding="utf-8")
    # A plan directory of this workspace that is really the other workspace's.
    (mine / "docs").mkdir()
    os.symlink(other / "docs" / "plans", mine / "docs" / "plans")
    host = _RootOnlyHost({"instance-1": mine})

    listed = _value(_call(backend_process, host, "plans.list", {}))
    assert [entry["rel_path"] for entry in listed] == [".agent-team/plans/own_aaaaaa.html"]
    for rel_path in ("docs/plans/secret_bbbbbb.html", str(other / "docs" / "plans" / "secret_bbbbbb.html")):
        response = _call(backend_process, host, "plans.read", {"rel_path": rel_path})
        assert "error" in response, response
        assert "Other workspace secret" not in repr(response)
    response = _call(backend_process, host, "plans.read_document", {"rel_path": "docs/plans/secret_bbbbbb.html"})
    assert "error" in response and "Other workspace secret" not in repr(response)


def test_symlink_escaping_plans_is_refused(backend_process: subprocess.Popen[bytes], tmp_path: Path) -> None:
    mine = _workspace(tmp_path, "mine")
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.html").write_text(_plan_html("Outside secret"), encoding="utf-8")
    plans = mine / ".agent-team" / "plans"
    os.symlink(outside / "secret.html", plans / "leak_cccccc.html")
    # A link that stays inside the workspace is an ordinary document, as before.
    (mine / "docs").mkdir()
    (mine / "docs" / "kept.html").write_text(_plan_html("Inside target"), encoding="utf-8")
    os.symlink(mine / "docs" / "kept.html", plans / "inside_dddddd.html")
    host = _RootOnlyHost({"instance-1": mine})

    listed = {entry["rel_path"]: entry for entry in _value(_call(backend_process, host, "plans.list", {}))}
    assert listed[".agent-team/plans/leak_cccccc.html"]["kind"] == "unreadable"
    assert listed[".agent-team/plans/inside_dddddd.html"]["name"] == "Inside target"
    assert "Outside secret" not in repr(listed)
    response = _call(backend_process, host, "plans.read", {"rel_path": ".agent-team/plans/leak_cccccc.html"})
    assert "error" in response and "Outside secret" not in repr(response)
    inside = _value(_call(backend_process, host, "plans.read", {"rel_path": ".agent-team/plans/inside_dddddd.html"}))
    assert inside["meta"]["name"] == "Inside target"
    # A history entry that links out of the workspace does not exist for us.
    history = plans / ".history" / "own_eeeeee"
    history.mkdir(parents=True)
    (history / "v1.html").write_text(_plan_html("Version one"), encoding="utf-8")
    os.symlink(outside / "secret.html", history / "v2.html")
    listing = _value(_call(backend_process, host, "plans.list_directory", {"rel_path": ".agent-team/plans/.history/own_eeeeee"}))
    assert listing == {"ok": True, "entries": [{"name": "v1.html", "is_dir": False}]}


@pytest.mark.parametrize(
    ("name", "rel_path"),
    [
        ("plans.read", ".agent-team/plans/../../outside/secret.html"),
        ("plans.read", "docs/plans/../../../outside/secret.html"),
        ("plans.read_document", ".agent-team/plans/../../outside/secret.html"),
        ("plans.read_document", ".agent-team/plans/x/.history/../../../../outside/secret.html"),
        # Ends in a plan directory, so only the ".." rule stands between it and
        # a document outside the root.
        ("plans.read", "../outside/docs/plans/secret.html"),
    ],
)
def test_dotdot_traversal_is_refused(
    backend_process: subprocess.Popen[bytes], tmp_path: Path, name: str, rel_path: str
) -> None:
    mine = _workspace(tmp_path, "mine")
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.html").write_text(_plan_html("Outside secret"), encoding="utf-8")
    (outside / "docs" / "plans").mkdir(parents=True)
    (outside / "docs" / "plans" / "secret.html").write_text(_plan_html("Outside secret"), encoding="utf-8")
    host = _RootOnlyHost({"instance-1": mine})

    response = _call(backend_process, host, name, {"rel_path": rel_path})
    assert _error_code(response) == "WORKSPACE_SCOPE_VIOLATION"
    assert "Outside secret" not in repr(response)


# ── the Host-authorized root: per instance, single flight, never the payload ─


def test_plan_root_is_resolved_once_per_instance_and_never_shared(
    backend_process: subprocess.Popen[bytes], tmp_path: Path
) -> None:
    first = _workspace(tmp_path, "first")
    second = _workspace(tmp_path, "second")
    (first / ".agent-team" / "plans" / "first_aaaaaa.html").write_text(_plan_html("First"), encoding="utf-8")
    (second / ".agent-team" / "plans" / "second_bbbbbb.html").write_text(_plan_html("Second"), encoding="utf-8")
    host = _RootOnlyHost({"instance-1": first, "instance-2": second})

    for _ in range(2):
        one = _value(_call(backend_process, host, "plans.list", {}, "instance-1"))
        two = _value(_call(backend_process, host, "plans.list", {}, "instance-2"))
        assert [entry["name"] for entry in one] == ["First"]
        assert [entry["name"] for entry in two] == ["Second"]
    assert host.root_calls() == 2


def test_plan_root_failure_fails_the_request_and_never_uses_the_payload(
    backend_process: subprocess.Popen[bytes], tmp_path: Path
) -> None:
    mine = _workspace(tmp_path, "mine")
    hostile = _workspace(tmp_path, "hostile")
    (hostile / ".agent-team" / "plans" / "bait_eeeeee.html").write_text(_plan_html("Hostile bait"), encoding="utf-8")
    host = _RootOnlyHost({"instance-1": mine}, fail_root="BACKEND_UNAVAILABLE")

    for name, arguments in (
        ("plans.list", {}),
        ("plans.read", {"rel_path": ".agent-team/plans/bait_eeeeee.html"}),
        ("plans.read_document", {"rel_path": ".agent-team/plans/bait_eeeeee.html"}),
        ("plans.resolve_root", {"workspace_path": str(hostile)}),
    ):
        response = _call(backend_process, host, name, arguments)
        assert _error_code(response) == "BACKEND_UNAVAILABLE", (name, response)
        assert "Hostile bait" not in repr(response) and str(hostile) not in repr(response)
    # A failure is not remembered: the next request asks the Host again.
    calls_before = host.root_calls()
    host.fail_root = None
    host.roots["instance-1"] = mine
    assert _value(_call(backend_process, host, "plans.list", {})) == []
    assert host.root_calls() == calls_before + 1


def test_concurrent_first_requests_resolve_the_root_once(
    backend_process: subprocess.Popen[bytes], tmp_path: Path
) -> None:
    mine = _workspace(tmp_path, "mine")
    (mine / ".agent-team" / "plans" / "only_ffffff.html").write_text(_plan_html("Only"), encoding="utf-8")
    host = _RootOnlyHost({"instance-1": mine})
    ids = {
        _request(backend_process, "plans.read", {"rel_path": ".agent-team/plans/only_ffffff.html"}, "instance-1")
        for _ in range(2)
    }
    root_request = _read(backend_process, timeout=10)
    assert root_request["params"]["operation"] == "resolve_root"
    # Give the second request every chance to ask too before answering.
    with pytest.raises(AssertionError, match="no frame"):
        _read(backend_process, timeout=0.5)
    host(backend_process, root_request, "instance-1")
    answered: dict[str, dict[str, Any]] = {}
    while len(answered) < 2:
        frame = _read(backend_process, timeout=10)
        assert frame.get("method") != "navide/host/call", frame
        answered[frame["id"]] = frame
    assert set(answered) == ids
    assert all(_value(frame)["meta"]["name"] == "Only" for frame in answered.values())
    assert host.root_calls() == 1


# ── t6: large documents list and page back byte for byte ─────────────────────


def test_large_plans_are_listed_and_paged_back_byte_identical(
    backend_process: subprocess.Popen[bytes], tmp_path: Path
) -> None:
    mine = _workspace(tmp_path, "mine")
    plans = mine / ".agent-team" / "plans"
    documents = {
        "medium_aaaaaa.html": _plan_html("About 197 KB", padding=197 * 1000, extra="<p>é ✓ 計畫</p>"),
        "huge_bbbbbb.html": _plan_html("About 5.8 MB", padding=5_800_000, extra="<p>tail ✓ 😀</p>"),
    }
    for name, text in documents.items():
        (plans / name).write_text(text, encoding="utf-8", newline="")
    host = _RootOnlyHost({"instance-1": mine})

    listed = {entry["rel_path"]: entry for entry in _value(_call(backend_process, host, "plans.list", {}))}
    assert listed[".agent-team/plans/medium_aaaaaa.html"]["name"] == "About 197 KB"
    assert listed[".agent-team/plans/huge_bbbbbb.html"]["name"] == "About 5.8 MB"
    for name, text in documents.items():
        rel_path = f".agent-team/plans/{name}"
        pages: list[str] = []
        offset = 0
        while True:
            arguments: dict[str, Any] = {"rel_path": rel_path}
            if offset:
                arguments["offset"] = offset
            value = _value(_call(backend_process, host, "plans.read", arguments))
            pages.append(value["html"])
            if value.get("eof") is not False:
                break
            assert value["next_offset"] > offset
            offset = value["next_offset"]
        joined = "".join(pages).encode("utf-8")
        source = (plans / name).read_bytes()
        assert hashlib.sha256(joined).hexdigest() == hashlib.sha256(source).hexdigest()
        _assert_same_text("".join(pages), text)
    assert {operation for operation, _ in host.calls} == {"resolve_root"}


def test_list_scans_of_different_views_never_share_a_result(tmp_path: Path) -> None:
    """A view's plans.list never waits on, or takes, another view's scan."""
    from tests.test_navide_plans_backend_wire import _load_backend

    backend = _load_backend("plans_backend_view_isolation")
    first = _workspace(tmp_path, "first")
    second = _workspace(tmp_path, "second")
    backend._plan_roots.update({"instance-1": str(first), "instance-2": str(second)})
    release_first = threading.Event()
    first_started = threading.Event()

    def scan(origin: dict[str, Any]) -> list[dict[str, Any]]:
        if origin["instance"] == "instance-1":
            first_started.set()
            release_first.wait(timeout=3)
        return [{"root": backend._plan_root(origin)}]

    backend._list_plans = scan
    results: dict[str, Any] = {}
    leader = threading.Thread(
        target=lambda: results.setdefault("first", backend._list_plans_single_flight(
            {"kind": "call", "requestId": "a", "instance": "instance-1"})),
    )
    leader.start()
    assert first_started.wait(timeout=5)
    try:
        other = backend._list_plans_single_flight({"kind": "call", "requestId": "b", "instance": "instance-2"})
        # Answered while the first view's scan is still held: it never waited.
        assert leader.is_alive()
        assert other == [{"root": str(second)}]
    finally:
        release_first.set()
        leader.join(timeout=10)
    assert results["first"] == [{"root": str(first)}]
