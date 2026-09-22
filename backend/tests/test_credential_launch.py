"""Credential path handoff: synthetic homes, programs and local sockets only."""
import asyncio
import json
import os
from pathlib import Path
import shlex
import shutil

import pytest
import sys

from agent_team_backend.credential_launch import CredentialLaunch, wrap_command
from agent_team_backend.cli_vendors.registry import VENDORS


@pytest.mark.parametrize("wait_child", [False, True])
def test_callback_does_not_release_login_before_owner_snapshot(tmp_path, wait_child):
    async def run():
        launch = await CredentialLaunch.start(("XDG_DATA_HOME",), timeout=2)
        marker = tmp_path / "ran"
        cli = tmp_path / "cli.py"
        cli.write_text("from pathlib import Path\nimport sys\nPath(sys.argv[1]).write_text('ran')\n")
        env = {"HOME": str(tmp_path), "PATH": os.defpath,
               "XDG_DATA_HOME": str(tmp_path / "chosen"), **launch.env}
        process = await asyncio.create_subprocess_exec(
            *launch.helper_argv(login=True), *(["--wait-child"] if wait_child else []), "--", sys.executable, str(cli), str(marker),
            env=env, cwd=tmp_path,
        )
        try:
            report = await launch.wait_report()
            assert report["home"] == str(tmp_path)
            assert report["env"] == {"XDG_DATA_HOME": str(tmp_path / "chosen")}
            assert not marker.exists()
            launch.release(True)
            assert await asyncio.wait_for(process.wait(), 3) == 0
            assert marker.read_text() == "ran"
        finally:
            await launch.close()
            if process.returncode is None:
                process.kill()
                await process.wait()
    asyncio.run(run())


def test_denied_login_never_executes(tmp_path):
    async def run():
        launch = await CredentialLaunch.start(("XDG_DATA_HOME",), timeout=2)
        marker = tmp_path / "ran"
        process = await asyncio.create_subprocess_exec(
            *launch.helper_argv(login=True), "--", sys.executable, "-c",
            "from pathlib import Path; Path('ran').touch()",
            cwd=tmp_path, env={"HOME": str(tmp_path), "PATH": os.defpath, **launch.env},
        )
        try:
            await launch.wait_report()
            launch.release(False)
            assert await asyncio.wait_for(process.wait(), 3) != 0
            assert not marker.exists()
        finally:
            await launch.close()
    asyncio.run(run())


def test_wrapper_preserves_rc_environment_and_arguments(tmp_path):
    if shutil.which("bash") is None:
        pytest.skip("bash is unavailable")
    async def run():
        launch = await CredentialLaunch.start(("XDG_DATA_HOME",), timeout=3)
        bin_dir = tmp_path / "bin"
        bin_dir.mkdir()
        cli = bin_dir / "kilo"
        output = tmp_path / "observed.json"
        cli.write_text(f"#!{sys.executable}\nimport json, os, sys\nfrom pathlib import Path\n"
                       f"Path({str(output)!r}).write_text(json.dumps([os.environ['HOME'], os.environ['XDG_DATA_HOME'], sys.argv[1:]]))\n")
        cli.chmod(0o700)
        chosen = str(tmp_path / "chosen store")
        command = [shutil.which("bash"), "-c", "kilo --session 'two words'"]
        wrapped = wrap_command(command, VENDORS["kilo"], launch.helper_argv())
        assert wrapped is not None
        wrapped[-1] = "export XDG_DATA_HOME=" + shlex.quote(chosen) + "; " + wrapped[-1]
        process = await asyncio.create_subprocess_exec(
            *wrapped, env={"HOME": str(tmp_path), "PATH": str(bin_dir) + os.pathsep + os.defpath, **launch.env},
            cwd=tmp_path,
        )
        try:
            report = await launch.wait_report()
            assert report["verified"] is True
            assert report["env"]["XDG_DATA_HOME"] == chosen
            launch.release(True)
            assert await asyncio.wait_for(process.wait(), 3) == 0
            assert json.loads(output.read_text()) == [str(tmp_path), chosen, ["--session", "two words"]]
        finally:
            await launch.close()
    asyncio.run(run())


def test_unknown_function_keeps_regular_command_behavior(tmp_path):
    if shutil.which("bash") is None:
        pytest.skip("bash is unavailable")
    async def run():
        launch = await CredentialLaunch.start(("XDG_DATA_HOME",), timeout=2)
        command = [shutil.which("bash"), "-c", "kilo"]
        wrapped = wrap_command(command, VENDORS["kilo"], launch.helper_argv())
        wrapped[-1] = "kilo() { printf original; }; " + wrapped[-1]
        process = await asyncio.create_subprocess_exec(
            *wrapped, env={"HOME": str(tmp_path), "PATH": os.defpath, **launch.env},
            stdout=asyncio.subprocess.PIPE,
        )
        try:
            report = await launch.wait_report()
            assert report["verified"] is False
            launch.release(True)
            output, _ = await asyncio.wait_for(process.communicate(), 3)
            assert output == b"original"
        finally:
            await launch.close()
    asyncio.run(run())


def test_complex_command_is_not_rewritten():
    assert wrap_command(["/bin/bash", "-lc", "XDG_DATA_HOME=/elsewhere kilo"], VENDORS["kilo"], ["helper"]) is None
    assert wrap_command(["/bin/bash", "-lc", "kilo && echo done"], VENDORS["kilo"], ["helper"]) is None


async def test_fake_token_and_extra_env_cannot_consume_launch_report(tmp_path):
    from agent_team_backend.credential_path_helper import PORT_ENV, TOKEN_ENV

    launch = await CredentialLaunch.start(("XDG_DATA_HOME",), timeout=1)
    try:
        request = {"token": "FAKE-TOKEN", "home": str(tmp_path), "cwd": str(tmp_path),
                   "env": {"XDG_DATA_HOME": str(tmp_path)}, "verified": True, "credentialEnv": []}
        for bad in (request, {**request, "token": launch.env[TOKEN_ENV],
                             "env": {"UNRELATED_SECRET": "FAKE-PRIVATE"}}):
            reader, writer = await asyncio.open_connection("127.0.0.1", int(launch.env[PORT_ENV]))
            writer.write((json.dumps(bad) + "\n").encode())
            await writer.drain()
            assert json.loads(await reader.readline()) == {"go": False}
            writer.close()
            await writer.wait_closed()
        assert not launch._report.done()
        process = await asyncio.create_subprocess_exec(
            *launch.helper_argv(), "--probe", cwd=tmp_path,
            env={"HOME": str(tmp_path), "USERPROFILE": str(tmp_path), **launch.env,
                 "UNRELATED_SECRET": "FAKE-PRIVATE"},
        )
        report = await launch.wait_report()
        assert report["env"] == {}
        assert "FAKE-PRIVATE" not in json.dumps(report)
        assert "token" not in report
        launch.release(True)
        assert await process.wait() == 0
    finally:
        await launch.close()


async def test_source_and_frozen_helper_entrypoints(monkeypatch):
    from agent_team_backend.credential_path_helper import HELPER_FLAG

    launch = await CredentialLaunch.start(("XDG_DATA_HOME",), timeout=1)
    try:
        assert launch.helper_argv()[1].endswith("credential_path_helper.py")
        monkeypatch.setattr(sys, "frozen", True, raising=False)
        assert launch.helper_argv()[:2] == [sys.executable, HELPER_FLAG]
    finally:
        await launch.close()


def test_arbitrary_script_is_not_a_standard_executable(tmp_path):
    from agent_team_backend.credential_path_helper import standard_executable

    executable = tmp_path / "kilo"
    executable.write_text("#!/bin/sh\nexport XDG_DATA_HOME=/other\nexec kilo-real\n")
    assert not standard_executable([str(executable)], "kilo")
    (tmp_path / "package.json").write_text(json.dumps({"name": "unrelated-wrapper", "bin": {"kilo": "kilo"}}))
    assert not standard_executable([str(executable)], "kilo")


def test_native_launch_reuses_platform_shim_and_refuses_unknown_batch(monkeypatch):
    from types import SimpleNamespace
    from agent_team_backend import credential_launch

    monkeypatch.setattr(credential_launch.osplat, "terminal_backend", SimpleNamespace(
        parse_command=lambda _: ["kilo.cmd", "--session", "two words"]))
    monkeypatch.setattr(credential_launch.shutil, "which", lambda *_args, **_kw: "fixtures/kilo.cmd")
    monkeypatch.setattr(credential_launch.osplat, "paths", SimpleNamespace(
        pty_launch_parts=lambda *_args, **_kw: ("fixtures/node.exe", ["fixtures/cli.js", "--session", "two words"])))
    result = wrap_command("kilo.cmd --session 'two words'", VENDORS["kilo"], ["helper"], env={"PATH": "fixtures"})
    assert result == ["helper", "--entrypoint", "fixtures/cli.js", "--", "fixtures/node.exe", "fixtures/cli.js", "--session", "two words"]
    monkeypatch.setattr(credential_launch.osplat.paths, "pty_launch_parts", lambda *_args, **_kw: ("cmd.exe", ["/c", "custom.cmd"]))
    assert wrap_command("kilo.cmd", VENDORS["kilo"], ["helper"], env={"PATH": "fixtures"}) is None


async def test_unknown_wrapper_preserves_shell_fallback_and_exit_status(tmp_path):
    bash = shutil.which("bash")
    if bash is None:
        pytest.skip("bash is unavailable")
    wrapper = tmp_path / "kilo"
    wrapper.write_text("printf '%s' \"$UNRELATED_SECRET\"; exit 37\n")
    wrapper.chmod(0o700)  # Deliberately no shebang: the original shell handles ENOEXEC.
    launch = await CredentialLaunch.start(("XDG_DATA_HOME",), timeout=1)
    try:
        command = wrap_command([bash, "-c", "kilo"], VENDORS["kilo"], launch.helper_argv(vendor="kilo"))
        process = await asyncio.create_subprocess_exec(*command, cwd=tmp_path,
            env={"HOME": str(tmp_path), "PATH": str(tmp_path) + os.pathsep + os.defpath,
                 "UNRELATED_SECRET": "FAKE-WRAPPER-ENV", **launch.env},
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        report = await launch.wait_report()
        assert report["verified"] is False
        launch.release(False)
        output, _ = await process.communicate()
        assert process.returncode == 37
        assert output == b"FAKE-WRAPPER-ENV"
    finally:
        await launch.close()


async def test_login_timeout_cannot_run_cli_and_socket_closes(tmp_path):
    from agent_team_backend.credential_path_helper import PORT_ENV

    launch = await CredentialLaunch.start(("XDG_DATA_HOME",), timeout=1)
    marker = tmp_path / "must-not-run"
    process = await asyncio.create_subprocess_exec(*launch.helper_argv(login=True), "--",
        sys.executable, "-c", "from pathlib import Path; Path('must-not-run').touch()",
        cwd=tmp_path, env={"HOME": str(tmp_path), "USERPROFILE": str(tmp_path), **launch.env},
        stderr=asyncio.subprocess.PIPE)
    try:
        # Process startup is separate from the connected helper's GO timeout.
        await asyncio.wait_for(asyncio.shield(launch._report), 10)
        await asyncio.wait_for(process.communicate(), 15)
        assert process.returncode == 75
        assert not marker.exists()
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()
        await launch.close()
    assert not launch._connections
    with pytest.raises(OSError):
        await asyncio.open_connection("127.0.0.1", int(launch.env[PORT_ENV]))
