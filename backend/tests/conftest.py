from __future__ import annotations

import os
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import time

import pytest

# Importing `app` below instantiates the module-level stores; since the SQLite
# migration that import moves real JSON stores into navide.db (renaming the
# sources). Point app-data at a throwaway dir BEFORE the import so collecting
# tests can never migrate the developer's real app data.
# Overwritten, not setdefault: the sentence above says these tests can *never*
# touch the developer's real app data, and setdefault cannot deliver that — it
# steps aside for whatever the environment already says, which is exactly the
# case where the promise matters. This is not hypothetical: on 2026-08-30 the
# server-link verification script had the same setdefault and wrote a
# cross-device trust marker into a real install, whose only symptom was that
# every cross-device message stopped, indistinguishable from someone having
# deleted the trust state on purpose.
os.environ["AGENT_TEAM_DATA_DIR"] = os.environ.get(
    "AGENT_TEAM_TESTS_DATA_DIR"
) or tempfile.mkdtemp(prefix="agent-team-tests-"
)

from agent_team_backend import app, ws_handlers
from agent_team_backend.credential_vault import CredentialVault


# Executables of the agent CLIs this app drives. A test may start a fake one it
# wrote under the temp dir; one found anywhere else is the developer's real
# install, signed in to their real account.
_REAL_CLI_NAMES = frozenset({
    "claude", "codex", "gemini", "kimi", "grok", "qwen", "opencode", "kilo",
    "kilocode", "cursor-agent", "copilot", "pi", "droid", "aider", "agy",
    "antigravity", "muse", "mcode",
})
_TEMP_ROOTS = tuple({
    os.path.realpath(tempfile.gettempdir()) + os.sep,
    os.path.realpath("/tmp") + os.sep,
})


def _real_cli_in(args, env) -> str | None:
    """The real agent CLI `args` would start, or None.

    Looks at the first few words, so `cmd /c claude` or `node claude` count."""
    if isinstance(args, (str, bytes, os.PathLike)):
        words = os.fsdecode(args).split()
    else:
        words = [os.fsdecode(a) for a in args]
    for word in words[:3]:
        stem = os.path.splitext(os.path.basename(word))[0].lower()
        if stem not in _REAL_CLI_NAMES:
            continue
        found = word if os.path.dirname(word) else shutil.which(word, path=(env or os.environ).get("PATH"))
        if found and not os.path.realpath(found).startswith(_TEMP_ROOTS):
            return os.path.realpath(found)
    return None


@pytest.fixture(autouse=True)
def _no_real_claude_cli(monkeypatch):
    """Never let a test start the developer's Claude Code — or any real CLI.

    Claude quota is read by driving the CLI's own ``/usage`` panel, so an
    unstubbed poll would spawn a real Claude Code — seconds per test, the
    user's MCP servers, and their live account read for no reason. Tests that
    care about the numbers stub ``usage_service.fetch_claude``; this makes the
    accident impossible, and loud: the poll swallows a failed read, so every
    refusal is recorded and fails the test at teardown even when the code under
    test caught the exception.

    Two layers. The /usage read is stubbed where ``fetch_claude`` looks it up
    (``cli_vendors.claude``; ``claude_cli_usage`` is only a re-export shim, and
    patching the shim changed nothing), so it never reaches the Keychain
    either. And ``subprocess.Popen`` — which ``asyncio`` subprocesses go through
    as well — refuses any real agent CLI outside the temp dir."""
    from agent_team_backend.cli_vendors import claude as claude_vendor

    refused: list[str] = []

    async def _refuse(*_args, **_kwargs):
        refused.append("the Claude /usage read (cli_vendors.claude.fetch_claude_usage_via_cli)")
        raise AssertionError(
            "a test tried to read Claude usage through the real CLI; "
            "stub usage_service.fetch_claude instead"
        )

    monkeypatch.setattr(claude_vendor, "fetch_claude_usage_via_cli", _refuse)

    class _GuardedPopen(subprocess.Popen):
        def __init__(self, args, *rest, **kwargs):
            real = _real_cli_in(args, kwargs.get("env"))
            if real:
                refused.append(f"a real CLI spawn: {real}")
                raise PermissionError(f"a test tried to start the real CLI {real}; use a fake under tmp_path")
            super().__init__(args, *rest, **kwargs)

    monkeypatch.setattr(subprocess, "Popen", _GuardedPopen)
    yield refused
    if refused:
        pytest.fail("test reached a real agent CLI: " + "; ".join(refused), pytrace=False)


@pytest.fixture(autouse=True)
def _isolated_data_dir(tmp_path, monkeypatch):
    """Keep app-data side effects (e.g. pty-registry.json written on every
    TerminalService.create) out of the real app-data dir during tests."""
    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(tmp_path))


@pytest.fixture(autouse=True)
def _isolated_skills_home(tmp_path, monkeypatch):
    """The skills library and native-skills scan read the user's real home
    (``~/.agents/skills``, ``~/.copilot/skills``, ...). A test that spawns a
    pane through the plugin host would otherwise pick up whatever skills the
    developer happens to have installed. Point both at an empty home."""
    from agent_team_backend import native_mcp, native_memory, native_skills, skills_store

    # A sibling of tmp_path, not inside it: several tests enumerate tmp_path
    # as the app-data dir and would see the fake home as a stray entry.
    home = tmp_path.parent / f"{tmp_path.name}-skills-home"
    home.mkdir(exist_ok=True)
    monkeypatch.setattr(skills_store, "_real_home", lambda: home)
    monkeypatch.setattr(native_skills, "_home", lambda: home)
    # The native MCP scan reads the same real home (~/.claude.json,
    # ~/.codex/config.toml, ...); keep it off the developer's own configs.
    monkeypatch.setattr(native_mcp, "_home", lambda: home)
    # The instruction-file scan reads the real home too (~/.claude/CLAUDE.md,
    # ~/.codex/AGENTS.md, ...) and its handlers can write; never let a test
    # near the developer's own instructions.
    monkeypatch.setattr(native_memory, "_home", lambda: home)


@pytest.fixture(autouse=True)
def _isolated_credential_vault(tmp_path, monkeypatch):
    """Tests must NEVER touch the real home or the real Keychain: swap the
    app-wide vault for one rooted in tmp, backed by an in-process stand-in for
    ``security``.

    It used to answer 44 ("could not be found") to everything, which reads as a
    signed-out Keychain and is right for reads — but it also made every *write*
    fail, which no test noticed until something started storing state there. So
    it now behaves like the item store it is imitating: reads of an item nobody
    wrote still answer 44 (the state strict capture reads must be able to tell
    apart from a transient failure), and a write is a write."""
    items: dict[str, str] = {}

    def runner(args: list[str], input_text: str | None = None) -> tuple[int, str]:
        argv = list(args)
        if argv[:1] == ["-i"]:
            argv = shlex.split(input_text or "")
        if not argv:
            return 44, ""
        command = argv[0]
        service = argv[argv.index("-s") + 1] if "-s" in argv else ""
        if command == "add-generic-password":
            items[service] = argv[argv.index("-w") + 1] if "-w" in argv else ""
            return 0, ""
        if command == "find-generic-password":
            if service not in items:
                return 44, "The specified item could not be found in the keychain."
            return 0, items[service] + "\n"
        if command == "delete-generic-password":
            return (0, "") if items.pop(service, None) is not None else (44, "")
        return 44, ""

    vault = CredentialVault(
        root=tmp_path / "vault-root",
        real_home=tmp_path / "vault-home",
        security_runner=runner,
    )
    monkeypatch.setattr(app, "credential_vault", vault)


@pytest.fixture(autouse=True)
def _isolated_trust_store():
    """The cross-device trust record spans two stores on purpose (see
    trust_store): the state in the vault, which the fixture above replaces per
    test, and the "initialised" marker in navide.db, which is a process-wide
    singleton opened at import. Without clearing the marker the second test to
    ask for it would find a marker with no state — which is exactly the locked
    state the module exists to enforce — and every later test would be refused
    for a reason belonging to an earlier one."""
    from agent_team_backend import device_signing, sync_keyring, trust_store

    # Reset on the way in only. On the way out a test's own monkeypatching may
    # still be in force (one of them swaps pathlib.Path for the Windows flavour
    # to exercise a non-POSIX branch), and a teardown that touched the data dir
    # would fail there for reasons belonging to this fixture. Resetting first is
    # what provides the isolation; resetting again afterwards adds nothing.
    trust_store._reset_for_test()
    device_signing._reset_for_test()
    # The sync key is cached in-process for the same reason the others are
    # singletons, and it outlives the per-test vault above.
    sync_keyring._reset_for_test()


@pytest.fixture(autouse=True)
def _reset_terminal_singleton():
    """The TerminalService is an app-level singleton (terminals outlive a single
    ws connection) bound to the running event loop. pytest-asyncio uses a fresh
    loop per test, so reset the singleton and the active-session pointer before
    and after each test to keep them isolated and bound to the current loop.
    _PTY_OWNERS is likewise process-global (cli_profiles.set_default consults it
    for the running-pane guard) and must not leak between tests. So is
    ws_handlers._switch_history: a test suite switches accounts far faster than
    a person does, so without a reset the account-switch rate limit would start
    refusing switches partway through the run."""
    app._TERMINALS = None
    app._active_session = None
    app._PTY_OWNERS.clear()
    app._pane_activity.clear()
    ws_handlers._switch_history.clear()
    yield
    app._TERMINALS = None
    app._active_session = None
    app._PTY_OWNERS.clear()
    app._pane_activity.clear()
    ws_handlers._switch_history.clear()


# ---- shared helpers for the PTY kill/reap tests ----
# (test_terminals_breakaway_kill.py and test_terminals_exit_orphan_reap.py
# exercise the same ps/kill machinery; the timing-sensitive harness lives here
# once so flake fixes land in one place.)


@pytest.fixture
def fake_ps():
    """Factory for a subprocess.run stub that yields `table` as ps stdout."""
    def make(table: str):
        def run(cmd, **kwargs):
            return subprocess.CompletedProcess(cmd, 0, stdout=table, stderr="")
        return run
    return make


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


@pytest.fixture
def set_home(monkeypatch):
    """Point the product's home at a directory on every platform.

    `Path.home()` reads HOME on POSIX and USERPROFILE on Windows, so a bare
    `monkeypatch.setenv("HOME", ...)` moves nothing on the Windows runner.
    """
    from pathlib import Path

    from agent_team_backend import osplat

    def _set(path) -> Path:
        monkeypatch.setenv("HOME", str(path))
        monkeypatch.setenv(osplat.paths.home_env_var(), str(path))
        return Path(path)

    return _set


@pytest.fixture
def pid_alive():
    """Signal-0 liveness probe."""
    return _pid_alive


@pytest.fixture
def wait_pid_dead():
    """Poll until pid is gone (or timeout); returns True when it died."""
    def wait(pid: int, timeout: float = 2.0) -> bool:
        deadline = time.time() + timeout
        while _pid_alive(pid) and time.time() < deadline:
            time.sleep(0.02)
        return not _pid_alive(pid)
    return wait


@pytest.fixture
def setsid_grandchild():
    """Spawn a `sh` parent (own session) that backgrounds a python grandchild
    which setsid()s into its OWN session/group, wait until the breakaway is
    visible, and yield (parent, grand_pid). Teardown SIGKILLs both. This is
    the escape shape that killpg(parent group) cannot reach — the orphan class
    both kill-path and exit-path reap tests target."""
    grand_script = "import os, time; os.setsid(); print('ready', flush=True); time.sleep(30)"
    parent = subprocess.Popen(
        ["sh", "-c", f'{sys.executable} -c "{grand_script}" & echo $!; wait'],
        stdout=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    grand_pid = None
    try:
        grand_pid = int(parent.stdout.readline().strip())
        deadline = time.time() + 5
        while time.time() < deadline:
            try:
                if os.getpgid(grand_pid) == grand_pid != os.getpgid(parent.pid):
                    break
            except ProcessLookupError:
                pass
            time.sleep(0.02)
        assert os.getpgid(grand_pid) == grand_pid, "grandchild never broke away"
        yield parent, grand_pid
    finally:
        for pid in filter(None, [grand_pid, parent.pid]):
            try:
                os.kill(pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
        try:
            parent.wait(timeout=2)
        except Exception:
            pass


def pytest_addoption(parser):
    parser.addoption(
        "--shard", default=None, metavar="K/N",
        help="run only every Nth collected test, starting at the Kth (1-based); CI splits the Windows suite this way",
    )


@pytest.hookimpl(trylast=True)
def pytest_collection_modifyitems(config, items):
    # Round-robin over the collected order, not whole files: the slow files
    # (real git, PTY and subprocess spawns) then land on every shard evenly
    # instead of on whichever shard drew them.
    shard = config.getoption("--shard")
    if not shard:
        return
    k, n = (int(part) for part in shard.split("/"))
    if not 1 <= k <= n:
        raise pytest.UsageError(f"--shard {shard}: want K/N with 1 <= K <= N")
    config.hook.pytest_deselected(items=[item for i, item in enumerate(items) if i % n != k - 1])
    items[:] = items[k - 1 :: n]
