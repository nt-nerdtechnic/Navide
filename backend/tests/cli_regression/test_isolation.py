"""Isolation policy tests execute guards in disposable interpreters."""
import asyncio
import json
import importlib.util
from pathlib import Path
import subprocess
import sys
import uuid

import pytest

from agent_team_backend import osplat, pty_registry
from agent_team_backend.applog import in_data_dir

from .support.isolation import isolated_environment, real_cli_in
from .support.backend_process import BackendProcess
from .support.cli_shim import base_python_executable


pytestmark = [pytest.mark.cli_regression, pytest.mark.cli_shared]


def test_environment_discards_provider_and_shell_configuration(tmp_path, monkeypatch):
    for key in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR", "CODEX_HOME",
                "BASH_ENV", "ENV", "NODE_OPTIONS", "PYTHONPATH", "HTTP_PROXY"):
        monkeypatch.setenv(key, "must-not-propagate")
    env = isolated_environment(tmp_path)
    assert "must-not-propagate" not in env.values()
    assert Path(env["HOME"]).is_relative_to(tmp_path)
    assert Path(env["USERPROFILE"]).is_relative_to(tmp_path)


def test_environment_excludes_user_cli_path(tmp_path, monkeypatch):
    monkeypatch.setenv("PATH", str(tmp_path / "user-global-bin"))
    assert str(tmp_path / "user-global-bin") not in isolated_environment(tmp_path)["PATH"]


def test_main_suite_scrubs_vendor_paths_before_app_import(tmp_path):
    from agent_team_backend.cli_vendors.registry import VENDORS

    keys = {key for spec in VENDORS.values() for key in (
        *spec.home_env_vars, *spec.data_dir_env_vars, *spec.credential_path_env_vars,
        *spec.network_override_env_vars,
    )} - {"HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"}
    env = isolated_environment(tmp_path)
    env.update({key: "inherited-provider-location" for key in keys})
    env["PYTHONPATH"] = str(Path(__file__).resolve().parents[2])
    script = """
import json, os, sys
from pathlib import Path
import tests.conftest
assert all(key not in os.environ for key in json.loads(sys.argv[1]))
assert 'navide-test-home-' in str(Path.home())
"""
    subprocess.run([sys.executable, "-c", script, json.dumps(sorted(keys))], env=env, check=True)


@pytest.mark.parametrize("argv", [
    ["sh", "-c", "VAR=value echo safe; claude --version"],
    ["cmd.exe", "/d", "/s", "/c", '"claude" --version'],
    ["wrapper", "one", "two", "three", "claude"],
    ["sh", "-c", "echo safe;claude --version"],
])
def test_guard_recognizes_cli_after_shell_wrappers(tmp_path, monkeypatch, argv):
    executable = tmp_path / "installed" / "claude"
    executable.parent.mkdir()
    executable.write_text("unused")
    monkeypatch.setattr("shutil.which", lambda *args, **kwargs: str(executable))
    assert real_cli_in(argv, {}, (tmp_path / "allowed",)) == str(executable)
    assert real_cli_in(argv, {}, (tmp_path,)) is None


def test_hook_url_is_not_mistaken_for_a_cli_executable(tmp_path):
    assert real_cli_in(["curl", "-X", "POST", "http://127.0.0.1:1234/hooks/claude"], {}, (tmp_path,)) is None


def test_caught_network_refusal_still_leaves_failure_evidence(tmp_path):
    script = """
from pathlib import Path
import socket, sys
from tests.cli_regression.support.isolation import install_external_guards
install_external_guards(Path(sys.argv[1]))
try:
    socket.create_connection(('203.0.113.1', 443), timeout=0.1)
except PermissionError:
    pass
"""
    env = isolated_environment(tmp_path)
    env["PYTHONPATH"] = str(Path(__file__).resolve().parents[2])
    subprocess.run([sys.executable, "-c", script, str(tmp_path)], env=env, check=True)
    refusals = [json.loads(line) for line in (tmp_path / "refusals.jsonl").read_text().splitlines()]
    assert refusals == [{"boundary": "non-loopback network"}]


@pytest.mark.parametrize("loop_kind", ["asyncio"] + (["uvloop"] if importlib.util.find_spec("uvloop") else []))
@pytest.mark.parametrize("operation", ["connect", "dns"])
def test_async_network_refusal_cannot_bypass_socket_guard(tmp_path, loop_kind, operation):
    script = """
from pathlib import Path
import asyncio, sys
from tests.cli_regression.support.isolation import install_external_guards
install_external_guards(Path(sys.argv[1]))
factory = asyncio.new_event_loop
if sys.argv[2] == 'uvloop':
    import uvloop
    factory = uvloop.new_event_loop
async def attempt():
    loop = asyncio.get_running_loop()
    try:
        if sys.argv[3] == 'connect':
            await loop.create_connection(asyncio.Protocol, '203.0.113.1', 443)
        else:
            await loop.getaddrinfo('provider.invalid', 443)
    except PermissionError:
        pass
    else:
        raise AssertionError('external network was not refused')
with asyncio.Runner(loop_factory=factory) as runner:
    runner.run(attempt())
"""
    env = isolated_environment(tmp_path)
    env["PYTHONPATH"] = str(Path(__file__).resolve().parents[2])
    subprocess.run([sys.executable, "-c", script, str(tmp_path), loop_kind, operation],
                   env=env, check=True, timeout=10)
    assert json.loads((tmp_path / "refusals.jsonl").read_text()) == {"boundary": "non-loopback network"}


def test_spawn_path_remains_isolated_after_product_refresh(tmp_path):
    script = """
from pathlib import Path
import os, subprocess, sys
from tests.cli_regression.support.isolation import install_external_guards
install_external_guards(Path(sys.argv[1]))
os.environ['PATH'] = sys.argv[2] + os.pathsep + os.environ['PATH']
print(subprocess.check_output([sys.executable, '-c', 'import os;print(os.environ["PATH"])'], text=True))
"""
    env = isolated_environment(tmp_path)
    env["PYTHONPATH"] = str(Path(__file__).resolve().parents[2])
    exposed_path = str(tmp_path.parent / "user-global-bin")
    result = subprocess.run([sys.executable, "-c", script, str(tmp_path), exposed_path],
                            env=env, capture_output=True, text=True, check=True)
    assert exposed_path not in result.stdout


@pytest.mark.parametrize("boundary", ["popen", "native"])
def test_caught_real_cli_refusal_covers_native_spawn(tmp_path, boundary):
    # An executable outside this scenario's allowlisted fake root models an
    # installed CLI without ever invoking one from the developer's machine.
    executable = tmp_path / "outside" / "claude"
    executable.parent.mkdir()
    executable.write_text("must never execute")
    root = tmp_path / "scenario"
    env = isolated_environment(root)
    env["PYTHONPATH"] = str(Path(__file__).resolve().parents[2])
    script = """
from pathlib import Path
import subprocess, sys
from tests.cli_regression.support.isolation import install_external_guards
install_external_guards(Path(sys.argv[1]))
try:
    if sys.argv[3] == 'popen':
        subprocess.Popen([sys.argv[2]])
    else:
        from agent_team_backend import osplat
        osplat.terminal_backend.spawn([sys.argv[2]], cwd=sys.argv[1], env={}, rows=30, cols=100)
except PermissionError:
    pass
else:
    raise AssertionError('external CLI reached the OS')
"""
    subprocess.run([sys.executable, "-c", script, str(root), str(executable), boundary], env=env, check=True)
    refusal = json.loads((root / "refusals.jsonl").read_text())
    assert refusal["boundary"] == ("real CLI" if boundary == "popen" else "real native CLI")


def test_shards_partition_real_collection_without_omission(tmp_path):
    backend_root = Path(__file__).resolve().parents[2]
    reports = []
    for shard in ("1/2", "2/2"):
        report = tmp_path / f"collection-{shard[0]}.json"
        env = isolated_environment(tmp_path / f"collector-{shard[0]}")
        subprocess.run(
            [sys.executable, "-m", "pytest", "tests/cli_regression/test_shared.py",
             "--collect-only", "-q", "--shard", shard, "--collection-report", str(report)],
            cwd=backend_root, env=env, capture_output=True, text=True, check=True,
        )
        reports.append(json.loads(report.read_text()))
    assert reports[0]["collected"] == reports[1]["collected"]
    first, second = (set(report["selected"]) for report in reports)
    assert first and second
    assert first.isdisjoint(second)
    assert first | second == set(reports[0]["collected"])


def test_failure_cleanup_reaps_a_tracked_orphan(tmp_path):
    backend = BackendProcess(tmp_path)
    child = subprocess.Popen([sys.executable, "-c", "import sys; sys.stdin.read()"], stdin=subprocess.PIPE)
    try:
        backend.track_child(child.pid)
        # Model a backend that has exited without reaping this known child.
        # It is no longer reachable through the backend's process tree.
        assert backend.process is None
        assert backend._reap_surviving_children() == [child.pid]
        child.wait(timeout=5)
        assert child.poll() is not None
    finally:
        if child.poll() is None:
            child.kill()
        child.wait(timeout=5)
        child.stdin.close()


async def test_failure_cleanup_reaps_registry_child_before_create_ack(tmp_path):
    backend = BackendProcess(tmp_path / "backend")
    child_pids = []
    child_start_times = {}
    alive_before_cleanup = []
    with pytest.raises(AssertionError, match="backend exited before requested shutdown"):
        async with backend:
            async with backend.connect() as ws:
                await ws.send(json.dumps({
                    "id": str(uuid.uuid4()),
                    "type": "terminal.create",
                    "payload": {
                        "pane_id": "regression-pane",
                        "agent_key": "terminal",
                        "cwd": str(backend.root),
                        "command": [
                            base_python_executable(),
                            "-c",
                            "import signal, time; s = getattr(signal, 'SIGHUP', None); "
                            "s is not None and signal.signal(s, signal.SIG_IGN); "
                            "from pathlib import Path; Path('child.ready').write_text('ready'); "
                            "time.sleep(60)",
                        ],
                        "cols": 100,
                        "rows": 30,
                        "create_generation": str(uuid.uuid4()),
                    },
                }))
                # Read the real backend's durable spawn record without reading
                # the terminal.create response that would teach the harness
                # which PID to track.
                async with asyncio.timeout(15):
                    while not child_pids:
                        entries = await asyncio.to_thread(
                            in_data_dir(backend.root / "data", pty_registry._load)
                        )
                        child_start_times = {
                            int(pid): entry.get("lstart", "")
                            for pid, entry in entries.items()
                        }
                        child_pids = list(child_start_times)
                        if not child_pids:
                            await asyncio.sleep(0.02)
                async with asyncio.timeout(15):
                    while not (backend.root / "child.ready").exists():
                        await asyncio.sleep(0.02)
                assert backend.children == set()
                backend.process.kill()
                await asyncio.to_thread(backend.process.wait, timeout=5)
                alive_before_cleanup = [
                    pid for pid in child_pids if osplat.process_tree.is_alive(pid)
                ]

    scenario = json.loads((backend.root / "scenario.json").read_text(encoding="utf-8"))
    assert set(alive_before_cleanup).issubset(scenario["registry_reaped"])
    assert scenario["children"] == []
    assert all(child_start_times.values())
    async with asyncio.timeout(5):
        while any(
            osplat.process_tree.start_time(pid) == start_time
            for pid, start_time in child_start_times.items()
        ):
            await asyncio.sleep(0.02)


def test_readiness_waits_for_discovery_file_contents(tmp_path):
    backend = BackendProcess(tmp_path)
    port = tmp_path / "data" / "backend-port"
    token = tmp_path / "data" / "backend-ws-token"
    assert backend._discovery_url() is None
    port.touch()
    token.touch()
    assert backend._discovery_url() is None
    port.write_text("12345")
    assert backend._discovery_url() is None
    token.write_text("fixture-token")
    assert backend._discovery_url() == "ws://127.0.0.1:12345/ws?t=fixture-token"


@pytest.mark.parametrize("exit_kind", ["clean", "crash"])
async def test_harness_rejects_backend_exit_before_requested_shutdown(tmp_path, exit_kind):
    with pytest.raises(AssertionError, match=r"backend exited before requested shutdown.*exit code"):
        async with BackendProcess(tmp_path) as backend:
            # Even a clean exit is unexpected while the scenario still owns
            # a live backend. Reap it before leaving to make this deterministic.
            if exit_kind == "clean":
                backend.process.stdin.write("shutdown\n")
                backend.process.stdin.flush()
            else:
                backend.process.kill()
            code = await asyncio.to_thread(backend.process.wait, timeout=15)
            assert (code == 0) == (exit_kind == "clean")
    diagnostic = json.loads((tmp_path / "scenario.json").read_text(encoding="utf-8"))
    assert diagnostic["backend_exit_code"] == code
    assert "before requested shutdown" in diagnostic["backend_exit_error"]


async def test_harness_rejects_nonzero_backend_shutdown(tmp_path, monkeypatch):
    original_popen = subprocess.Popen
    entry = "tests.cli_regression.support.backend_entry"
    # Run the real backend through normal startup and cooperative shutdown,
    # then model a process-level failure after its children have been reaped.
    driver = f"""
import runpy
try:
    runpy.run_module({entry!r}, run_name='__main__')
except SystemExit as result:
    if result.code:
        raise
    raise SystemExit(23)
"""

    def failed_shutdown_process(args, *rest, **kwargs):
        if args[1:3] == ["-m", entry]:
            args = [args[0], "-c", driver, *args[3:]]
        return original_popen(args, *rest, **kwargs)

    monkeypatch.setattr(subprocess, "Popen", failed_shutdown_process)
    with pytest.raises(AssertionError, match=r"backend shutdown failed.*exit code 23"):
        async with BackendProcess(tmp_path) as backend:
            assert backend.process.poll() is None
    diagnostic = json.loads((tmp_path / "scenario.json").read_text(encoding="utf-8"))
    assert diagnostic["backend_exit_code"] == 23
    assert "shutdown failed" in diagnostic["backend_exit_error"]
