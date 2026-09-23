"""Numeric OS fixtures, bounded DNS and temporary-root content observations."""

import asyncio
import os
import socket
import threading

import pytest

from agent_team_backend import cli_risk_observers as obs
from agent_team_backend.osplat import cli_network as net


@pytest.mark.parametrize("address,expected", [
    ("198.51.100.4:443", ("198.51.100.4", 443)),
    ("[2001:db8::1]:8443", ("2001:db8::1", 8443)),
    ("[::ffff:192.0.2.3]:80", ("192.0.2.3", 80)),
])
def test_numeric_endpoint(address, expected):
    assert net.endpoint(address) == expected


@pytest.mark.parametrize("value", ["evil.example:443", "*:443", "127.0.0.1:0", "::1:99999"])
def test_endpoint_refuses_non_numeric_or_invalid(value):
    with pytest.raises(ValueError):
        net.endpoint(value)


def test_mac_fixture_preserves_socket_count_and_filters_pid():
    output = "p20\nf7\nn127.0.0.1:123->198.51.100.2:443\nf8\nn127.0.0.1:124->198.51.100.2:443\np90\nf4\nn127.0.0.1:125->198.51.100.3:443\n"
    assert net.parse_lsof(output, {20}) == (net.Connection(20, "198.51.100.2", 443),) * 2


@pytest.mark.parametrize("prefix", ["", "ESTAB "])
def test_linux_fixture_accepts_both_state_column_forms(prefix):
    output = 'Recv-Q Send-Q Local Address:Port Peer Address:Port Process\n'
    output += prefix + '0 0 [::1]:2345 [2001:db8::2]:443 users:(("tool",pid=11,fd=4),("cli",pid=12,fd=5))\n'
    assert net.parse_ss(output, {11}) == (net.Connection(11, "2001:db8::2", 443),)


def test_linux_missing_attribution_is_unknown_not_absence():
    with pytest.raises(ValueError):
        net.parse_ss("0 0 127.0.0.1:44 198.51.100.2:443", {10})


@pytest.mark.parametrize("code,stdout,stderr,status", [
    (1, "", "", "successful"), (1, "", "permission denied", "unknown"),
    (2, "", "", "unknown"), (0, "garbled", "", "unknown"),
])
async def test_mac_exit_and_parse_failures(monkeypatch, code, stdout, stderr, status):
    async def command(argv):
        assert argv[1:5] == ["-nP", "-iTCP", "-sTCP:ESTABLISHED", "-a"]
        assert argv[6] == "10,11"
        return code, stdout, stderr
    monkeypatch.setattr(net, "command", command)
    assert (await net.collect_lsof([11, 10, 10])).status == status


async def test_linux_and_windows_collectors(monkeypatch):
    async def command(argv):
        assert argv == ["ss", "-tnpe", "state", "established"]
        return 0, '0 0 127.0.0.1:22 192.0.2.4:443 users:(("cli",pid=4,fd=1))', ""
    monkeypatch.setattr(net, "command", command)
    monkeypatch.setattr(net, "owned_socket_inodes", lambda pids: {})
    assert (await net.collect_ss([4])).connections == (net.Connection(4, "192.0.2.4", 443),)
    assert (await net.unsupported([4])).status == "unsupported"


async def test_dns_complete_normalized_cache_and_expiry():
    now = [100.0]
    calls = []
    def lookup(name, *_args):
        calls.append(name)
        return [(None, None, None, None, ("2001:db8::1", 0))]
    resolver = obs.ExpectedResolver(clock=lambda: now[0], lookup=lookup)
    first = await resolver.resolve(("api.example.test", "::ffff:192.0.2.1"))
    assert first.addresses == {"2001:db8::1", "192.0.2.1"}
    assert await resolver.resolve(("api.example.test", "::ffff:192.0.2.1")) == first
    assert calls == ["api.example.test"]
    now[0] += 300
    def failure(*args):
        raise socket.gaierror("fixture unavailable")
    resolver.lookup = failure
    assert (await resolver.resolve(("api.example.test", "::ffff:192.0.2.1"))).status == "unknown"


async def test_dns_partial_wildcard_empty_and_limits():
    def lookup(name, *_args):
        if name == "bad.example":
            raise socket.gaierror("fixture")
        return [(None, None, None, None, ("192.0.2.1", 0))]
    resolver = obs.ExpectedResolver(lookup=lookup)
    for declarations in [("good.example", "bad.example"), ("*.example",), tuple(f"192.0.2.{n}" for n in range(65))]:
        assert (await resolver.resolve(declarations)).status == "unknown"
    assert (await resolver.resolve(())).status == "unsupported"
    resolver.lookup = lambda *_: [(None, None, None, None, (f"2001:db8::{n:x}", 0)) for n in range(257)]
    assert (await resolver.resolve(("huge.example",))).status == "unknown"


async def test_dns_timeout_retains_single_worker(monkeypatch):
    release = threading.Event()
    calls = []
    def lookup(*args):
        calls.append(args)
        release.wait(2)
        return []
    monkeypatch.setattr(obs, "DNS_TIMEOUT", 0.02)
    resolver = obs.ExpectedResolver(lookup=lookup)
    try:
        assert (await resolver.resolve(("slow.example",))).status == "unknown"
        for _ in range(10):
            assert (await resolver.resolve(("slow.example",))).status == "unknown"
        assert len(calls) == 1
    finally:
        release.set()
        await asyncio.to_thread(resolver._pending.result, 1)


def sparse(path, prefix=b"\xff\x00opaque", size=150 * 1024 * 1024):
    with path.open("wb") as stream:
        stream.write(prefix)
        stream.truncate(size)


def test_disk_large_opaque_real_content_and_sniff_bound(tmp_path, monkeypatch):
    opaque = tmp_path / "blob.enc"
    sparse(opaque)
    sparse(tmp_path / "actual.sqlite", b"SQLite format 3\x00")
    sparse(tmp_path / "fake.sqlite")
    reads = []
    original = os.read
    def read(fd, length):
        reads.append(length)
        return original(fd, length)
    monkeypatch.setattr(obs.os, "read", read)
    sample = obs.scan_disk(str(tmp_path.resolve()))
    assert sample.status == "successful"
    assert sample.files[str(opaque.resolve())].opaque
    assert not sample.files[str((tmp_path / "actual.sqlite").resolve())].opaque
    assert sample.files[str((tmp_path / "fake.sqlite").resolve())].opaque
    assert reads == [65536] * 3


@pytest.mark.parametrize(
    ("name", "prefix"),
    [
        ("claude", b"\xcf\xfa\xed\xfe"),
        ("tool", b"\xfe\xed\xfa\xcf"),
        ("legacy", b"\xce\xfa\xed\xfe"),
        ("universal", b"\xca\xfe\xba\xbe"),
        ("universal64", b"\xca\xfe\xba\xbf"),
        ("libfoo.dylib", b"\xcf\xfa\xed\xfe"),
        ("addon.node", b"\xcf\xfa\xed\xfe"),
        ("Main.class", b"\xca\xfe\xba\xbe"),
        ("claude.exe", b"MZ\x90\x00"),
        ("helper.dll", b"MZ\x90\x00"),
        ("addon.node", b"\x7fELF"),
    ],
)
def test_native_executables_are_recognized(tmp_path, name, prefix):
    assert obs.recognized_content(tmp_path / name, prefix + b"\x00" * 508)


@pytest.mark.parametrize(
    ("name", "prefix"),
    [("image.png", b"\xcf\xfa\xed\xfe"), ("image.png", b"\xca\xfe\xba\xbe"), ("notes.txt", b"MZ\x90\x00")],
)
def test_native_signature_with_incompatible_suffix_stays_opaque(tmp_path, name, prefix):
    assert not obs.recognized_content(tmp_path / name, prefix + b"\x00" * 508)


def test_disk_read_or_traversal_failure_is_unknown(tmp_path, monkeypatch):
    sparse(tmp_path / "blob")
    def denied(*_args, **_kwargs):
        raise PermissionError("fixture")
    monkeypatch.setattr(obs.os, "open", denied)
    assert obs.scan_disk(str(tmp_path.resolve())).status == "unknown"
    monkeypatch.setattr(obs.os, "scandir", denied)
    assert obs.scan_disk(str(tmp_path.resolve())).status == "unknown"


def test_disk_does_not_follow_symlinks(tmp_path):
    root = tmp_path / "data"
    root.mkdir()
    outside = tmp_path / "outside"
    sparse(outside)
    try:
        (root / "link").symlink_to(outside)
        (root / "parent").symlink_to(tmp_path, target_is_directory=True)
    except OSError as err:
        pytest.skip(f"symlinks unavailable: {err}")
    assert obs.scan_disk(str(root.resolve())).files == {}


def test_disk_size_and_inventory_budget(tmp_path, monkeypatch):
    sparse(tmp_path / "exact", size=obs.MIB100)
    sample = obs.scan_disk(str(tmp_path.resolve()))
    assert not next(iter(sample.files.values())).opaque
    monkeypatch.setattr(obs, "MAX_FILES", 0)
    assert obs.scan_disk(str(tmp_path.resolve())).status == "unknown"


@pytest.mark.skipif(os.environ.get("NAVIDE_CLI_RISK_LOCAL_SMOKE") != "1", reason="opt-in local TCP smoke")
async def test_owned_local_tcp_smoke():
    """Own process only, no app startup, external traffic, real CLI or user files."""
    from agent_team_backend import osplat
    if osplat.platform_id != "darwin":
        pytest.skip("lsof smoke requires macOS")
    with socket.socket() as server, socket.socket() as client:
        server.bind(("127.0.0.1", 0))
        server.listen(1)
        client.connect(server.getsockname())
        accepted, _ = server.accept()
        try:
            sample = await net.collect_lsof([os.getpid()])
            assert sample.status == "successful"
            assert any(c.ip == "127.0.0.1" and c.port == server.getsockname()[1] for c in sample.connections)
        finally:
            accepted.close()


def test_linux_inode_attribution_distinguishes_owned_and_unrelated_hidden_rows():
    output = ('0 0 127.0.0.1:1 192.0.2.1:443 users:(("cli",pid=10,fd=5)) ino:100\n'
              '0 0 127.0.0.1:2 192.0.2.2:443 uid:0 ino:200\n'
              '0 0 127.0.0.1:3 192.0.2.3:443 ino:300\n')
    assert net.parse_ss(output, {10}, {100: {10}, 300: {10}}) == (
        net.Connection(10, "192.0.2.1", 443), net.Connection(10, "192.0.2.3", 443))
    with pytest.raises(ValueError):
        net.parse_ss("0 0 127.0.0.1:2 192.0.2.2:443", {10}, {})


async def test_linux_failed_owned_inventory_is_unknown(monkeypatch):
    def denied(pids):
        raise PermissionError("requested process inaccessible")
    monkeypatch.setattr(net, "owned_socket_inodes", denied)
    assert (await net.collect_ss([10])).status == "unknown"


async def test_subprocess_never_finishing_reap_is_bounded(monkeypatch):
    from types import SimpleNamespace
    class Reader:
        async def read(self, _n):
            await asyncio.Event().wait()
    closed = []
    class Process:
        returncode = None
        stdout, stderr = Reader(), Reader()
        _transport = SimpleNamespace(close=lambda: closed.append(True))
        def kill(self):
            self.returncode = -9
        async def wait(self):
            await asyncio.Event().wait()
    async def spawn(*args, **kwargs):
        return Process()
    monkeypatch.setattr(net.asyncio, "create_subprocess_exec", spawn)
    monkeypatch.setattr(net, "COMMAND_TIMEOUT", 0.01)
    monkeypatch.setattr(net, "CLEANUP_TIMEOUT", 0.01)
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(net.command(["fixture"]), 0.5)
    assert closed == [True]


async def test_real_subprocess_output_overflow_settles_and_reaps(monkeypatch):
    import sys
    spawned = []
    original = asyncio.create_subprocess_exec
    async def spawn(*args, **kwargs):
        proc = await original(*args, **kwargs)
        spawned.append(proc)
        return proc
    monkeypatch.setattr(net.asyncio, "create_subprocess_exec", spawn)
    monkeypatch.setattr(net, "MAX_OUTPUT", 1024)
    monkeypatch.setattr(net, "COMMAND_TIMEOUT", 0.1)
    monkeypatch.setattr(net, "CLEANUP_TIMEOUT", 0.1)
    task = asyncio.create_task(net.command([
        sys.executable, "-c", "import os\nwhile True: os.write(1, b'x' * 65536)"
    ]))
    try:
        done, _ = await asyncio.wait({task}, timeout=2)
        assert task in done, "output overflow must not leave command pending"
        with pytest.raises((ValueError, TimeoutError)):
            task.result()
        assert spawned[0].returncode is not None
    finally:
        for proc in spawned:
            if proc.returncode is None:
                proc.kill()
            proc._transport.close()
            await asyncio.wait_for(proc.wait(), 1)
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


def test_linux_shared_socket_unions_partial_process_and_inode_ownership():
    row = '0 0 127.0.0.1:1 192.0.2.1:443 users:(("other",pid=90,fd=5)) ino:42'
    assert net.parse_ss(row, {10}, {42: {10}}) == (net.Connection(10, "192.0.2.1", 443),)
