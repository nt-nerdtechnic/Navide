"""Security review CR-1..CR-10 of the credentials scan, as regression tests.

Ported from the review's repros (read as data, re-written here): every
interpolated value in a copyable step is quoted or the step is withheld,
helper names never carry an assignment, the URL redactor finds userinfo the
way git does, the walk is bounded, nothing blocks on a FIFO, roots are
resolved before they are judged, links and keychain filters trust only known
hosts, and MCP returns action names rather than shell commands.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest

from agent_team_backend import credentials_scan as cs
from agent_team_backend.db import Database

GIT = shutil.which("git")
needs_git = pytest.mark.skipif(GIT is None, reason="git is required")
has_mkfifo = pytest.mark.skipif(not hasattr(os, "mkfifo"), reason="needs FIFOs")

TOKEN = "ghp_" + "a" * 36


def _env(home: Path) -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env.update({"HOME": str(home), "USERPROFILE": str(home), "GIT_CONFIG_NOSYSTEM": "1",
                "GIT_CONFIG_GLOBAL": str(home / ".gitconfig")})
    env.pop("XDG_CONFIG_HOME", None)
    return env


def _git(home: Path, *args: str) -> None:
    subprocess.run([GIT, *args], check=True, env=_env(home), capture_output=True)


@pytest.fixture
def home(tmp_path: Path) -> Path:
    h = tmp_path / "home"
    (h / ".ssh").mkdir(parents=True)
    (h / ".config").mkdir()
    (h / ".gitconfig").write_text("")
    return h


def _run_git(home: Path):
    def run(argv, *, timeout: float = 15.0, capture: bool = True) -> cs.RunResult:
        if Path(argv[0]).name != Path(GIT or "git").name and argv[0] != GIT:
            return cs.RunResult(cs.CODE_SPAWN_FAILED)
        proc = subprocess.run(list(argv), capture_output=True, env=_env(home), timeout=timeout,
                              stdin=subprocess.DEVNULL)
        return cs.RunResult(proc.returncode, proc.stdout.decode(), proc.stderr.decode())
    return run


def _ctx(home: Path, roots: list[Path], *, which=None, run=None, system_dirs=None) -> cs.ScanContext:
    return cs.ScanContext(
        home=home, env={"HOME": str(home)}, roots=[(str(r), "user") for r in roots],
        run=run or _run_git(home), which=which or (lambda n: GIT if n == "git" else None),
        platform="darwin", system_dirs=list(system_dirs if system_dirs is not None else [home / ".ssh"]),
        config_home=home / ".config", repo_workers=2,
    )


def _repo(home: Path, path: Path) -> Path:
    path.mkdir(parents=True)
    _git(home, "-C", str(path), "-c", "init.defaultBranch=main", "init", "-q")
    return path


def _paste_every_step(result: dict, cwd: Path, home: Path) -> None:
    """What a user who copies each suggested step into a shell gets."""
    for finding in result["findings"]:
        for step in finding["steps"]:
            subprocess.run(cs.osplat.paths.shell_command(step), cwd=cwd, env=_env(home), capture_output=True,
                           timeout=10)


# ── CR-1: copyable steps cannot be injected ────────────────────────────────


@needs_git
@pytest.mark.parametrize("payload", [
    ";touch${IFS}{pwn};#",
    "$(touch${IFS}{pwn})",
    "`touch${IFS}{pwn}`",
    "|touch${IFS}{pwn}",
    "&touch${IFS}{pwn}",
])
def test_cr1_remote_url_payload_never_reaches_a_runnable_step(home, tmp_path, payload):
    pwn = tmp_path / "PWNED"
    root = tmp_path / "ws"
    repo = _repo(home, root / "evil")
    _git(home, "-C", str(repo), "config", "remote.origin.url",
         f"https://{TOKEN}@github.com/a/b" + payload.replace("{pwn}", str(pwn)))
    result = cs.run_scan(_ctx(home, [root]))
    finding = next(f for f in result["findings"] if f["code"] == "url-token")
    assert finding["manual_fix"] is True
    assert finding["steps"] == []
    assert "manual-fix" in finding["actions"]
    _paste_every_step(result, tmp_path, home)
    assert not pwn.exists()
    assert TOKEN not in json.dumps(result)


@needs_git
def test_cr1_helper_duplicate_context_payload_is_withheld(home, tmp_path):
    pwn = tmp_path / "PWNED3"
    root = tmp_path / "ws"
    repo = _repo(home, root / "evil")
    key = f"credential.https://github.com/$(touch${{IFS}}{pwn}).helper"
    _git(home, "-C", str(repo), "config", "--add", key, "store")
    _git(home, "-C", str(repo), "config", "--add", key, "store")
    result = cs.run_scan(_ctx(home, [root]))
    dup = [f for f in result["findings"] if f["code"] == "helper-duplicate"]
    assert dup and all(f["manual_fix"] and not f["steps"] for f in dup)
    _paste_every_step(result, tmp_path, home)
    assert not pwn.exists()


@needs_git
def test_cr1_helper_shadowed_context_payload_is_withheld(home, tmp_path):
    pwn = tmp_path / "PWNED2"
    _git(home, "config", "--global", "credential.https://github.com;touch " + str(pwn) + ";#.helper", "osxkeychain")
    root = tmp_path / "ws"
    repo = _repo(home, root / "evil")
    _git(home, "-C", str(repo), "config", f"credential.https://github.com;touch {pwn};#.helper", "store")
    result = cs.run_scan(_ctx(home, [root]))
    shadowed = [f for f in result["findings"] if f["code"] == "helper-shadowed"]
    assert shadowed and all(f["manual_fix"] and not f["steps"] for f in shadowed)
    _paste_every_step(result, tmp_path, home)
    assert not pwn.exists()


@needs_git
def test_cr1_safe_values_are_quoted(home, tmp_path):
    root = tmp_path / "ws"
    repo = _repo(home, root / "with space")
    _git(home, "-C", str(repo), "config", "remote.origin.url", f"https://{TOKEN}@github.com/a/b.git")
    result = cs.run_scan(_ctx(home, [root]))
    finding = next(f for f in result["findings"] if f["code"] == "url-token")
    assert finding["manual_fix"] is False
    assert finding["actions"] == ["remote-set-url"]
    assert finding["steps"] == [
        f"git -C {cs.osplat.paths.quote_arg(str(repo))} remote set-url origin https://github.com/a/b.git"]


def test_cr1_step_builder_refuses_metacharacters():
    for bad in ("a$(b)", "a`b`", "a;b", "a|b", "a&b", "a\nb", "a\rb"):
        assert cs.safe_command("git", "-C", bad) is None
    assert cs.safe_command("chmod", "600", "/x y/z") == "chmod 600 " + cs.osplat.paths.quote_arg("/x y/z")


# ── CR-2: helper names never carry an assignment or a body ─────────────────


@pytest.mark.parametrize("value", [
    "!GH_TOKEN=ghp_FAKEFAKEFAKE1234567890 gh auth git-credential",
    "!TOKEN=abc123secret git-credential-foo",
    "!password=SECRETY",
    "!echo password=SECRETX",
    "!f() { echo password=X; }; f",
    "!'/opt/x y/gh' auth git-credential",
    "FOO=bar",
])
def test_cr2_helper_name_is_a_plain_basename_or_inline_shell(value):
    name = cs.helper_name(value)
    assert "=" not in name and "SECRET" not in name and "FAKE" not in name and "abc123" not in name
    assert name == "inline-shell" or __import__("re").fullmatch(r"[\w.+-]+", name)


@needs_git
def test_cr2_env_prefixed_inline_helper_does_not_leak(home):
    _git(home, "config", "--global", "credential.helper", "!GH_TOKEN=ghp_FAKEFAKEFAKE1234567890 gh auth git-credential")
    result = cs.run_scan(_ctx(home, []))
    assert "FAKEFAKE" not in json.dumps(result)


# ── CR-5 / CR-6: redaction ─────────────────────────────────────────────────


@pytest.mark.parametrize("raw, secret", [
    ("https://user:ab/cdSECRETPW@host.example/r", "SECRETPW"),
    ("https://user:ab?cdSECRETPW@host.example/r", "SECRETPW"),
    ("https://user:ab#cdSECRETPW@h/r", "SECRETPW"),
    ("user:hunter2SECRETPW@host.example:path", "SECRETPW"),
    ("https://eyJhbGciOi.eyJzdWIiOi.c2lnSECRETPW@github.com/a/b", "SECRETPW"),
    ("https://AbCdEfGhIjKlMnOpSECRETPW@gitlab.com/a/b", "SECRETPW"),
    ("https://abcdEFGHijklMNOP@github.com/a/b", "abcdEFGHijklMNOP"),
    ("https://dXNlcjpwYXNz+SECRETPW==@github.com/a", "SECRETPW"),
    ("git+https://u:SECRETPW@h.example/x", "SECRETPW"),
    ("https://h.example/a/b?private_token=SECRETPW#frag", "SECRETPW"),
])
def test_cr5_cr6_redaction_finds_and_drops_the_secret(raw, secret):
    redacted = cs.redact_url(raw)
    assert secret not in repr(redacted)
    if "@" in raw:
        assert redacted.token_present is True


@pytest.mark.parametrize("raw, shown", [
    ("https://nt-nerdtechnic@github.com/a/b.git", "https://nt-nerdtechnic@github.com/a/b.git"),
    ("https://nt.fitbody@gitlab.com/a/b.git", "https://nt.fitbody@gitlab.com/a/b.git"),
    ("https://host.example/path@v1/x", "https://host.example/path@v1/x"),
    ("https://host.example:8443/p@x", "https://host.example:8443/p@x"),
    ("git@github.com:o/r.git", "git@github.com:o/r.git"),
])
def test_cr6_plain_logins_and_path_ats_are_kept(raw, shown):
    redacted = cs.redact_url(raw)
    assert redacted.url == shown
    assert redacted.token_present is False


@needs_git
def test_cr5_helper_context_with_slash_in_password_is_redacted(home):
    _git(home, "config", "--global", "credential.https://me:pa/SECRETPW@host.example.helper", "store")
    result = cs.run_scan(_ctx(home, []))
    assert "SECRETPW" not in json.dumps(result)


@needs_git
def test_cr6_git_plus_https_remote_is_reported(home, tmp_path):
    root = tmp_path / "ws"
    repo = _repo(home, root / "r")
    _git(home, "-C", str(repo), "config", "remote.origin.url", "git+https://u:SECRETPW@h.example/x")
    result = cs.run_scan(_ctx(home, [root]))
    assert [f["code"] for f in result["findings"] if f["code"] == "url-token"] == ["url-token"]
    assert "SECRETPW" not in json.dumps(result)


# ── CR-7: no read can block or balloon ─────────────────────────────────────


@has_mkfifo
def test_cr7_ssh_include_fifo_does_not_hang(home, tmp_path):
    os.mkfifo(tmp_path / "pipe")
    (home / ".ssh" / "config").write_text(f"Include {tmp_path}/pipe\n")
    (home / ".zshrc").unlink(missing_ok=True)
    os.mkfifo(home / ".zshrc")
    thread = threading.Thread(target=cs.run_scan, args=(_ctx(home, []),), daemon=True)
    thread.start()
    thread.join(5)
    hung = thread.is_alive()
    if hung:  # unblock the stuck reader so the test process can exit
        for pipe in (tmp_path / "pipe", home / ".zshrc"):
            try:
                os.close(os.open(pipe, os.O_WRONLY | os.O_NONBLOCK))
            except OSError:
                pass
    assert not hung


def test_cr7_reads_are_capped(home):
    big = home / ".zshrc"
    big.write_text("x" * (cs.MAX_READ_BYTES + 10) + "\nexport GH_TOKEN=late\n")
    result = cs.run_scan(_ctx(home, [], which=lambda n: None))
    assert not [f for f in result["findings"] if f["code"] == "env-token-in-shell-rc"]


# ── CR-3: bounded, fast walk; readers are not blocked ──────────────────────


def test_cr3_walk_is_fast_against_many_system_dirs(tmp_path):
    wide = tmp_path / "wide"
    for i in range(60):
        for j in range(60):
            (wide / f"d{i}" / f"e{j}").mkdir(parents=True)
    system = [Path(f"/nonexistent/sys{i}") for i in range(80)]
    started = time.monotonic()
    cs.find_repos(wide, system)
    assert time.monotonic() - started < 2.0


def test_cr3_directory_budget_is_shared_across_roots(tmp_path, monkeypatch):
    monkeypatch.setattr(cs, "MAX_WALK_DIRS", 50)
    roots = []
    for r in range(3):
        root = tmp_path / f"root{r}"
        for i in range(40):
            (root / f"repo{i}" / ".git").mkdir(parents=True)
        roots.append(root)
    ctx = _ctx(tmp_path, roots, which=lambda n: None, system_dirs=[])
    result = cs.run_scan(ctx)
    assert sum(r["repo_count"] for r in result["roots"]) <= 50


def test_cr3_walk_stops_at_the_deadline(tmp_path, monkeypatch):
    monkeypatch.setattr(cs, "WALK_SECONDS", 0.0)
    (tmp_path / "root" / "repo" / ".git").mkdir(parents=True)
    result = cs.run_scan(_ctx(tmp_path, [tmp_path / "root"], which=lambda n: None, system_dirs=[]))
    assert result["roots"][0]["repo_count"] == 0


@pytest.mark.asyncio
async def test_cr3_a_running_scan_does_not_block_readers_of_the_last_result(tmp_path):
    gate = threading.Event()
    calls = []

    def factory(roots):
        calls.append(1)
        if len(calls) > 1:
            gate.wait(10)
        return _ctx(tmp_path, [], which=lambda n: None, system_dirs=[])

    db = Database(tmp_path / "navide.db")
    svc = cs.CredentialsService(db_getter=lambda: db, workspace_roots=lambda: [], context_factory=factory,
                                system_dirs=lambda: [],
                                clock=lambda: datetime(2026, 10, 9, tzinfo=timezone.utc))
    first = await svc.scan()
    refresh = asyncio_task(svc.scan(force=True))
    try:
        for _ in range(100):
            if len(calls) > 1:
                break
            await _sleep(0.01)
        started = time.monotonic()
        second = await svc.scan()
        assert time.monotonic() - started < 1.0
        assert second["scanned_at"] == first["scanned_at"]
    finally:
        gate.set()
        await refresh


def asyncio_task(coro):
    import asyncio

    return asyncio.ensure_future(coro)


async def _sleep(seconds: float) -> None:
    import asyncio

    await asyncio.sleep(seconds)


# ── CR-8: roots are resolved before they are judged ────────────────────────


def test_cr8_symlinked_roots_are_resolved(tmp_path):
    secret = tmp_path / "secret"
    secret.mkdir()
    real = tmp_path / "real"
    real.mkdir()
    (tmp_path / "to_secret").symlink_to(secret)
    (tmp_path / "to_real").symlink_to(real)
    (tmp_path / "to_fsroot").symlink_to(Path(os.path.abspath(os.sep)))
    for bad in ("to_secret", "to_fsroot"):
        with pytest.raises(cs.RequestError):
            cs.validate_roots([str(tmp_path / bad)], [secret])
    assert cs.validate_roots([str(tmp_path / "to_real")], [secret]) == [os.path.realpath(real)]


def test_cr8_workspace_roots_go_through_the_same_validation(tmp_path):
    secret = tmp_path / "secret"
    secret.mkdir()
    good = tmp_path / "good"
    good.mkdir()
    (tmp_path / "ws_link").symlink_to(secret)
    db = Database(tmp_path / "navide.db")
    svc = cs.CredentialsService(
        db_getter=lambda: db,
        workspace_roots=lambda: [str(tmp_path / "ws_link"), str(good), "relative", str(tmp_path / "gone")],
        context_factory=lambda roots: _ctx(tmp_path, [], which=lambda n: None),
        system_dirs=lambda: [secret])
    assert svc._roots() == [(os.path.realpath(good), "workspace")]


# ── CR-9: only trusted hosts get links and widen the keychain filter ───────


def test_cr9_links_only_for_trusted_hosts():
    assert cs._host_links("gitlab.attacker.example", frozenset()) == []
    assert cs._host_links("gitlab.com", frozenset())[0]["url"].startswith("https://gitlab.com/")
    assert cs._host_links("github.com", frozenset())[0]["url"] == "https://github.com/settings/tokens"
    assert cs._host_links("git.corp.example", frozenset({"git.corp.example"}))[0]["url"].startswith(
        "https://git.corp.example/")


@needs_git
def test_cr9_untrusted_remote_host_gets_no_link_and_no_keychain_widening(home, tmp_path):
    root = tmp_path / "ws"
    repo = _repo(home, root / "r")
    _git(home, "-C", str(repo), "config", "remote.origin.url", f"https://{TOKEN}@gitlab.attacker.example/a/b")
    dump = ('class: "inet"\nattributes:\n    "acct"<blob>="victim"\n    "srvr"<blob>="gitlab.attacker.example"\n'
            'class: "inet"\nattributes:\n    "acct"<blob>="nt"\n    "srvr"<blob>="github.com"\n')
    base_run = _run_git(home)

    def run(argv, **kw):
        if Path(argv[0]).name == "security":
            return cs.RunResult(0, dump)
        return base_run(argv, **kw)

    which = {"git": GIT, "security": "/fake/security"}
    result = cs.run_scan(_ctx(home, [root], which=which.get, run=run))
    finding = next(f for f in result["findings"] if f["code"] == "url-token")
    assert finding["links"] == []
    keychain = [i["detail"]["server"] for i in result["items"] if i["kind"] == "keychain-item"]
    assert keychain == ["github.com"]


# ── CR-4: MCP returns names and action codes, not locators or commands ─────


@pytest.mark.asyncio
async def test_cr4_mcp_tools_strip_locators_and_commands(tmp_path):
    from agent_team_backend.mcp_server import auth as plan_mcp_auth
    from agent_team_backend.mcp_server import server as plan_mcp

    raw = {
        "ok": True, "scanned_at": "2026-10-09T00:00:00Z", "duration_ms": 1, "platform": "darwin",
        "keyring": {"available": True, "backend": "macos-keychain"}, "roots": [],
        "summary": {"high": 1, "medium": 0, "low": 0, "active_reminders": 1},
        "items": [{"id": "i1", "kind": "keychain-item", "label": "gh:github.com",
                   "detail": {"class": "generic-password", "service": "gh:github.com", "server": "github.com",
                              "account": "nt-neil", "protocol": "", "modified": ""}},
                  {"id": "i2", "kind": "ssh-key", "label": "id_ed25519", "detail": {"path": "~/.ssh/id_ed25519"}}],
        "findings": [{"id": "f1", "code": "ssh-no-passphrase", "severity": "medium", "kind": "ssh-key",
                      "location": "~/.ssh/id_ed25519", "params": {}, "links": [], "manual_fix": False,
                      "actions": ["ssh-add-passphrase"], "steps": ["ssh-keygen -p -f /x"],
                      "reminder": {"state": "active"}}],
    }

    class FakeService:
        async def scan(self, *, force=False):
            return json.loads(json.dumps(raw))

    cs.set_service(FakeService())
    try:
        ctx = SimpleNamespace(request_context=SimpleNamespace(request=SimpleNamespace(
            query_params={"client": "host", "t": plan_mcp_auth.internal_token()})))
        listed = await plan_mcp.credentials_list(ctx)
        found = await plan_mcp.credentials_findings(ctx)
    finally:
        cs.set_service(None)
    keychain = next(i for i in listed["items"] if i["kind"] == "keychain-item")
    assert not {"service", "account", "server"} & set(keychain["detail"])
    assert "gh:github.com" not in json.dumps(keychain) and "nt-neil" not in json.dumps(keychain)
    assert all("steps" not in f for f in found["findings"])
    assert found["findings"][0]["actions"] == ["ssh-add-passphrase"]
    assert "ssh-keygen" not in json.dumps(found)


# ── CR-10: coverage gaps that are cheap to close ───────────────────────────


@needs_git
def test_cr10_pushurl_and_insteadof_tokens_are_reported(home, tmp_path):
    root = tmp_path / "ws"
    repo = _repo(home, root / "r")
    _git(home, "-C", str(repo), "config", "remote.origin.url", "https://github.com/a/b.git")
    _git(home, "-C", str(repo), "config", "remote.origin.pushurl", "https://ghp_" + "b" * 36 + "@github.com/a/b.git")
    _git(home, "-C", str(repo), "config", "url.https://ghp_" + "c" * 36 + "@github.com/.insteadOf",
         "https://github.com/")
    result = cs.run_scan(_ctx(home, [root]))
    tokens = [f for f in result["findings"] if f["code"] == "url-token"]
    assert len(tokens) == 2
    blob = json.dumps(result)
    assert "b" * 36 not in blob and "c" * 36 not in blob


def test_cr10_clean_url_keeps_port_and_ipv6():
    for raw, clean in [
        (f"https://{TOKEN}@git.example:8443/a/b.git", "https://git.example:8443/a/b.git"),
        (f"https://u:{TOKEN}@[::1]:8080/r", "https://u@[::1]:8080/r"),
    ]:
        assert cs._clean_url(cs.redact_url(raw)) == clean


def test_cr10_putty_key_passphrase_is_unknown(home):
    (home / ".ssh" / "work.ppk").write_text("PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\n")

    def run(argv, **kw):
        return cs.RunResult(1)

    result = cs.run_scan(_ctx(home, [], which=lambda n: "/x/ssh-keygen" if n == "ssh-keygen" else None, run=run))
    item = next(i for i in result["items"] if i["kind"] == "ssh-key")
    assert item["detail"]["passphrase_checked"] is False and "has_passphrase" not in item["detail"]
