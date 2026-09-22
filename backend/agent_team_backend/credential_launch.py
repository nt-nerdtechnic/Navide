"""One-launch credential path handoff, owned by terminal.create's lock holder."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
import secrets
import shlex
import shutil
import sys
from typing import Any

from . import osplat
from .cli_vendors.base import VendorSpec, simple_command_args
from .credential_path_helper import HELPER_FLAG, PORT_ENV, TOKEN_ENV


def wrap_command(command: Any, spec: VendorSpec, helper: list[str], *, env: dict[str, str] | None = None) -> list[str] | None:
    """Wrap a literal bash/zsh CLI invocation, preserving shell function behavior.

    Other command forms remain unchanged and cannot attest to a live store.
    Keep the original command separately for resume discovery and history.
    """
    words = simple_command_args(command)
    if isinstance(command, str) and words:
        # Native ConPTY commands have no shell rc phase. Reuse the existing
        # platform parser and recognized npm-shim unwrapping before the helper.
        native = osplat.terminal_backend.parse_command(command)
        if not native or Path(native[0]).stem != spec.key:
            return None
        program = shutil.which(native[0], path=(env or {}).get("PATH"))
        if program is None:
            return None
        head, tail = osplat.paths.pty_launch_parts(program, native[1:], path=(env or {}).get("PATH"))
        if Path(head).stem.lower() in ("cmd", "powershell", "pwsh"):
            return None
        entrypoint = tail[0] if head != program and tail else program
        return [*helper, "--entrypoint", entrypoint, "--", head, *tail]
    if not words or not isinstance(command, list):
        return None
    executable = Path(words[0]).name
    if executable != spec.key or any(c in str(command[-1]) for c in "~*?[]{}!"):
        return None
    shell = Path(str(command[0])).name
    if shell not in ("bash", "zsh"):
        return None
    name = shlex.quote(words[0])
    prefix = shlex.join(helper)
    args = shlex.join(words[1:])
    if shell == "zsh":
        kind = f'[[ $(builtin whence -w -- {name}) == {shlex.quote(words[0] + ": command")} ]]'
        resolved = f'$(builtin whence -- {name})'
    else:
        kind = f'[ "$(type -t -- {name})" = file ]'
        resolved = f'$(command -v -- {name})'
    cleanup = f"unset {PORT_ENV} {TOKEN_ENV}"
    text = (
        f'if {kind}; then '
        f'if {prefix} --shell-check -- "{resolved}" {args}; then {cleanup}; exec {command[-1]}; '
        f'else _navide_credential_status=$?; {cleanup}; '
        f'if [ "$_navide_credential_status" -eq 76 ]; then {command[-1]}; '
        f'else exit "$_navide_credential_status"; fi; fi; '
        f'else {prefix} --probe && {{ {cleanup}; {command[-1]}; }}; fi'
    )
    return [*command[:-1], text]


class CredentialLaunch:
    def __init__(self, path_inputs: tuple[str, ...], timeout: float) -> None:
        loop = asyncio.get_running_loop()
        self._report: asyncio.Future[dict] = loop.create_future()
        self._release: asyncio.Future[bool] = loop.create_future()
        self._received: asyncio.Future[bool] = loop.create_future()
        self._server: asyncio.Server | None = None
        self._connections: set[asyncio.Task] = set()
        self._token = secrets.token_urlsafe(32)
        self._path_inputs = path_inputs
        self._timeout = timeout
        self._credential_env: tuple[str, ...] = ()
        self.env: dict[str, str] = {}

    @classmethod
    async def start(cls, path_inputs: tuple[str, ...], *, timeout: float = 10) -> CredentialLaunch:
        launch = cls(path_inputs, timeout)
        launch._server = await asyncio.start_server(launch._connected, "127.0.0.1", 0, limit=8192)
        launch.env = {PORT_ENV: str(launch._server.sockets[0].getsockname()[1]), TOKEN_ENV: launch._token}
        return launch

    def helper_argv(self, *, login: bool = False, vendor: str = "", credential_env: tuple[str, ...] = ()) -> list[str]:
        argv = ([sys.executable, HELPER_FLAG] if getattr(sys, "frozen", False) else
                [sys.executable, str(Path(__file__).with_name("credential_path_helper.py"))])
        argv += ["--timeout", str(self._timeout), "--home-env", osplat.paths.home_env_var()]
        for name in self._path_inputs:
            argv += ["--path-env", name]
        if osplat.terminal_backend.helper_waits_for_child:
            argv.append("--wait-child")
        self._credential_env = credential_env
        if vendor:
            argv += ["--vendor", vendor]
        for name in credential_env:
            argv += ["--credential-env", name]
        if login:
            argv.append("--login")
        return argv

    async def _connected(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        task = asyncio.current_task()
        self._connections.add(task)
        accepted = False
        try:
            request = json.loads(await asyncio.wait_for(reader.readline(), self._timeout))
            valid = (
                isinstance(request, dict) and isinstance(request.get("token"), str)
                and secrets.compare_digest(request["token"], self._token)
                and not self._report.done()
                and isinstance(request.get("home"), str) and Path(request["home"]).is_absolute()
                and isinstance(request.get("cwd"), str) and Path(request["cwd"]).is_absolute()
                and isinstance(request.get("verified"), bool)
                and isinstance(request.get("credentialEnv"), list)
                and all(isinstance(name, str) and name in self._credential_env for name in request.get("credentialEnv"))
                and isinstance(request.get("env"), dict)
                and all(k in self._path_inputs and isinstance(v, str) for k, v in request["env"].items())
            )
            if not valid:
                writer.write(b'{"go":false}\n')
                await writer.drain()
                return
            accepted = True
            self._report.set_result({key: request[key] for key in ("home", "cwd", "env", "verified", "credentialEnv")})
            allowed = await asyncio.wait_for(asyncio.shield(self._release), self._timeout)
            writer.write((json.dumps({"go": allowed}) + "\n").encode("utf-8"))
            await writer.drain()
            receipt = json.loads(await asyncio.wait_for(reader.readline(), self._timeout))
            self._received.set_result(allowed and receipt == {"received": True})
        except (OSError, ValueError, asyncio.TimeoutError):
            pass
        finally:
            if accepted and not self._received.done():
                self._received.set_result(False)
            writer.close()
            try:
                await writer.wait_closed()
            except OSError:
                pass
            self._connections.discard(task)

    async def wait_report(self) -> dict:
        return await asyncio.wait_for(asyncio.shield(self._report), self._timeout)

    def release(self, allowed: bool) -> None:
        if not self._release.done():
            self._release.set_result(allowed)

    async def wait_received(self) -> bool:
        try:
            return await asyncio.wait_for(asyncio.shield(self._received), self._timeout)
        except asyncio.TimeoutError:
            return False

    async def close(self) -> None:
        self.release(False)
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()
        if self._connections:
            await asyncio.gather(*list(self._connections), return_exceptions=True)
