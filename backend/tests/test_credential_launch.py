"""Credential path handoff: synthetic homes, programs and local sockets only."""
import asyncio
import json
import os
from pathlib import Path
import shlex
import shutil

import pytest
import sys

from agent_team_backend import osplat
from agent_team_backend.credential_launch import CredentialLaunch, wrap_command
from agent_team_backend.cli_vendors.registry import VENDORS


@pytest.fixture
def posix_bash():
    if osplat.paths.executable_candidates("bash") != ["bash"]:
        pytest.skip("requires POSIX shell/shebang execution, not Git Bash on Windows")
    bash = osplat.paths.resolve_program("bash")
    if bash is None:
        pytest.skip("bash is unavailable")
    return bash


@pytest.fixture
def helper_env(tmp_path):
    # A replacement Windows process environment needs SystemRoot for runtime
    # DLLs. Inherit that OS path only; all home and credential inputs are fake.
    return {**{key: value for key, value in os.environ.items() if key.upper() == "SYSTEMROOT"},
            "HOME": str(tmp_path), "USERPROFILE": str(tmp_path),
            osplat.paths.home_env_var(): str(tmp_path), "PATH": os.defpath}


async def _helper_report(launch, process):
    try:
        # Startup time is separate from the connected helper's GO deadline.
        return await asyncio.wait_for(asyncio.shield(launch._report), 10)
    except asyncio.TimeoutError:
        if process.returncode is None:
            process.kill()
        _, stderr = await process.communicate()
        pytest.fail(f"helper report timed out: returncode={process.returncode}; "
                    f"synthetic child stderr={stderr.decode(errors='replace')}", pytrace=False)


@pytest.mark.parametrize("wait_child", [False, True])
def test_callback_does_not_release_login_before_owner_snapshot(tmp_path, wait_child, helper_env):
    async def run():
        launch = await CredentialLaunch.start(("XDG_DATA_HOME",), timeout=2)
        marker = tmp_path / "ran"
        cli = tmp_path / "cli.py"
        cli.write_text("from pathlib import Path\nimport sys\nPath(sys.argv[1]).write_text('ran')\n")
        env = {**helper_env,
               "XDG_DATA_HOME": str(tmp_path / "chosen"), **launch.env}
        process = await asyncio.create_subprocess_exec(
            *launch.helper_argv(login=True), *(["--wait-child"] if wait_child else []), "--", sys.executable, str(cli), str(marker),
            env=env, cwd=tmp_path, stderr=asyncio.subprocess.PIPE,
        )
        try:
            report = await _helper_report(launch, process)
            assert report["home"] == str(tmp_path)
            assert report["env"] == {"XDG_DATA_HOME": str(tmp_path / "chosen")}
            assert not marker.exists()
            launch.release(True)
            assert await asyncio.wait_for(process.wait(), 3) == 0, (process.returncode, await process.stderr.read())
            assert marker.read_text() == "ran"
        finally:
            await launch.close()
            if process.returncode is None:
                process.kill()
                await process.wait()
    asyncio.run(run())


def test_denied_login_never_executes(tmp_path, helper_env):
    async def run():
        launch = await CredentialLaunch.start(("XDG_DATA_HOME",), timeout=2)
        marker = tmp_path / "ran"
        process = await asyncio.create_subprocess_exec(
            *launch.helper_argv(login=True), "--", sys.executable, "-c",
            "from pathlib import Path; Path('ran').touch()",
            cwd=tmp_path, env={**helper_env, **launch.env},
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            await _helper_report(launch, process)
            launch.release(False)
            assert await asyncio.wait_for(process.wait(), 3) == 75, (process.returncode, await process.stderr.read())
            assert not marker.exists()
        finally:
            await launch.close()
    asyncio.run(run())


def test_wrapper_preserves_rc_environment_and_arguments(tmp_path, posix_bash):
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
        command = [posix_bash, "-c", "kilo --session 'two words'"]
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


def test_unknown_function_keeps_regular_command_behavior(tmp_path, posix_bash):
    async def run():
        launch = await CredentialLaunch.start(("XDG_DATA_HOME",), timeout=2)
        command = [posix_bash, "-c", "kilo"]
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


async def test_fake_token_and_extra_env_cannot_consume_launch_report(tmp_path, helper_env):
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
            env={**helper_env, **launch.env,
                 "UNRELATED_SECRET": "FAKE-PRIVATE"},
            stderr=asyncio.subprocess.PIPE,
        )
        report = await _helper_report(launch, process)
        assert report["env"] == {}
        assert "FAKE-PRIVATE" not in json.dumps(report)
        assert "token" not in report
        launch.release(True)
        assert await process.wait() == 0, (process.returncode, await process.stderr.read())
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


@pytest.mark.parametrize("entrypoint", ["native-exe", "npm-cmd"])
@pytest.mark.skipif(
    not osplat.terminal_backend.helper_waits_for_child,
    reason="requires the Windows native process/shim backend; POSIX shell coverage is separate",
)
async def test_native_launch_reuses_platform_shim_and_refuses_unknown_batch(tmp_path, monkeypatch, helper_env, entrypoint):
    import subprocess
    from agent_team_backend.osplat import _windows
    from agent_team_backend.credential_path_helper import PORT_ENV, TOKEN_ENV

    node = shutil.which("node")
    if node is None:
        pytest.skip("node is required to run the synthetic native CLI")
    # On Windows these are the real parser, path layout and child processes.
    monkeypatch.setattr(osplat, "paths", _windows.paths)
    program = tmp_path / ("kilo.exe" if entrypoint == "native-exe" else "node.exe")
    shutil.copy2(node, program)
    cli = tmp_path / "cli.js"
    output = tmp_path / "observed.json"
    cli.write_text("const fs = require('fs');\n"
                   "fs.writeFileSync(process.argv[2], JSON.stringify({argv: process.argv.slice(3),\n"
                   "cwd: process.cwd(), home: process.env.USERPROFILE, xdg: process.env.XDG_DATA_HOME,\n"
                   "unrelated: process.env.UNRELATED_SECRET,\n"
                   f"channel: [{json.dumps(PORT_ENV)}, {json.dumps(TOKEN_ENV)}].filter(k => k in process.env)}}));\n"
                   "process.exit(37);\n")
    shim = tmp_path / "kilo.cmd"
    shim.write_text('@ECHO off\n@"%~dp0\\node.exe" "%~dp0\\cli.js" %*\n')
    shim.chmod(0o700)
    (tmp_path / "package.json").write_text(json.dumps({"name": "@kilocode/cli", "bin": {"kilo": "cli.js"}}))
    argv = ([program.name, str(cli)] if entrypoint == "native-exe" else [shim.name])
    argv += [str(output), "--session", "two words"]
    env = {**helper_env, "PATH": str(tmp_path) + os.pathsep + os.defpath,
           "XDG_DATA_HOME": str(tmp_path / "chosen store"), "UNRELATED_SECRET": "FAKE-PRIVATE"}
    launch = await CredentialLaunch.start(("XDG_DATA_HOME",), timeout=5)
    process = None
    try:
        helper = launch.helper_argv(login=True, vendor="kilo")
        if "--wait-child" not in helper:
            helper.append("--wait-child")
        wrapped = wrap_command(subprocess.list2cmdline(argv), VENDORS["kilo"], helper, env=env)
        assert wrapped is not None
        assert wrapped[wrapped.index("--") + 1:] == [str(program), str(cli), *argv[-3:]]
        process = await asyncio.create_subprocess_exec(*wrapped, env={**env, **launch.env}, cwd=tmp_path,
                                                      stderr=asyncio.subprocess.PIPE)
        report = await _helper_report(launch, process)
        assert report["verified"] is True
        assert report["home"] == str(tmp_path)
        assert report["env"] == {"XDG_DATA_HOME": env["XDG_DATA_HOME"]}
        assert not output.exists()
        launch.release(True)
        assert await launch.wait_received()
        assert await asyncio.wait_for(process.wait(), 10) == 37, (process.returncode, await process.stderr.read())
        assert json.loads(output.read_text()) == {
            "argv": ["--session", "two words"], "cwd": str(tmp_path), "home": str(tmp_path),
            "xdg": env["XDG_DATA_HOME"], "unrelated": "FAKE-PRIVATE", "channel": []}
        shim.write_text('set XDG_DATA_HOME=elsewhere\n@"%~dp0\\node.exe" "%~dp0\\cli.js" %*\n')
        assert wrap_command("kilo.cmd", VENDORS["kilo"], helper, env=env) is None
        assert osplat.paths.pty_launch_parts(str(shim))[0] == "cmd.exe"
    finally:
        if process is not None and process.returncode is None:
            process.kill()
            await process.wait()
        await launch.close()


async def test_unknown_wrapper_preserves_shell_fallback_and_exit_status(tmp_path, posix_bash):
    bash = posix_bash
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


async def test_login_timeout_cannot_run_cli_and_socket_closes(tmp_path, helper_env):
    from agent_team_backend.credential_path_helper import PORT_ENV

    launch = await CredentialLaunch.start(("XDG_DATA_HOME",), timeout=1)
    marker = tmp_path / "must-not-run"
    process = await asyncio.create_subprocess_exec(*launch.helper_argv(login=True), "--",
        sys.executable, "-c", "from pathlib import Path; Path('must-not-run').touch()",
        cwd=tmp_path, env={**helper_env, **launch.env},
        stderr=asyncio.subprocess.PIPE)
    try:
        await _helper_report(launch, process)
        _, stderr = await asyncio.wait_for(process.communicate(), 15)
        assert process.returncode == 75, (process.returncode, stderr)
        assert not marker.exists()
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()
        await launch.close()
    assert not launch._connections
    with pytest.raises(OSError):
        await asyncio.open_connection("127.0.0.1", int(launch.env[PORT_ENV]))
