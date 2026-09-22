"""Report the invocation's path inputs after shell startup, before CLI login.

Stdlib only: the packaged backend enters here before importing the application.
Regular commands retain their behavior if observation fails. A login must wait
for the backend to snapshot the agreed store before it is allowed to execute.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import sys

HELPER_FLAG = "--credential-path-helper"
PORT_ENV = "NAVIDE_CREDENTIAL_LAUNCH_PORT"
TOKEN_ENV = "NAVIDE_CREDENTIAL_LAUNCH_TOKEN"
PATH_INPUTS = frozenset({"XDG_DATA_HOME"})


def standard_executable(command: list[str], vendor: str) -> bool:
    if not command:
        return False
    path = Path(command[0]).resolve()
    try:
        with path.open("rb") as stream:
            magic = stream.read(4)
        if magic in (b"\x7fELF", b"\xcf\xfa\xed\xfe", b"\xce\xfa\xed\xfe", b"\xca\xfe\xba\xbe") or magic[:2] == b"MZ":
            return path.name in (vendor, vendor + ".exe")
        package = {"kilo": "@kilocode/cli", "opencode": "opencode-ai"}.get(vendor)
        # Accept a package's declared entrypoint, not an arbitrary script on
        # PATH. Package metadata is installation data, never credential data.
        for parent in list(path.parents)[:5]:
            manifest = parent / "package.json"
            if not manifest.is_file():
                continue
            data = json.loads(manifest.read_text(encoding="utf-8"))
            entries = data.get("bin", {})
            entry = entries.get(vendor) if isinstance(entries, dict) else entries
            return bool(data.get("name") == package and isinstance(entry, str)
                        and (parent / entry).resolve() == path)
    except (OSError, ValueError):
        pass
    return False


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--wait-child", action="store_true")
    parser.add_argument("--home-env", choices=("HOME", "USERPROFILE"), default="HOME")
    parser.add_argument("--entrypoint")
    parser.add_argument("--vendor", choices=("kilo", "opencode"))
    parser.add_argument("--credential-env", action="append", default=[])
    parser.add_argument("--login", action="store_true")
    parser.add_argument("--shell-check", action="store_true")
    parser.add_argument("--probe", action="store_true")
    parser.add_argument("--timeout", type=float, default=10)
    parser.add_argument("--path-env", action="append", choices=sorted(PATH_INPUTS), default=[])
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    verified = not args.probe and (not args.vendor or standard_executable([args.entrypoint] if args.entrypoint else command, args.vendor))
    allowed = False
    try:
        request = {
            "token": os.environ[TOKEN_ENV],
            "home": os.environ.get(args.home_env, ""),
            "cwd": os.getcwd(),
            "env": {name: os.environ[name] for name in args.path_env if name in os.environ},
            "verified": verified,
            "credentialEnv": [name for name in args.credential_env if os.environ.get(name)],
        }
        with socket.create_connection(("127.0.0.1", int(os.environ[PORT_ENV])), timeout=args.timeout) as sock:
            sock.sendall((json.dumps(request) + "\n").encode("utf-8"))
            with sock.makefile("rb") as stream:
                allowed = json.loads(stream.readline(8192)) == {"go": True}
                sock.sendall(b'{"received":true}\n')
    except (OSError, ValueError, KeyError):
        pass
    if args.login and not allowed:
        print("Navide: credential store was not admitted; login was not started.", file=sys.stderr)
        return 75
    if not allowed and not args.probe:
        print("Navide: credential store is unverified; account changes are unavailable for this pane.", file=sys.stderr)
    os.environ.pop(PORT_ENV, None)
    os.environ.pop(TOKEN_ENV, None)
    if args.probe:
        return 0
    if args.shell_check:
        return 0 if verified else 76
    if not command:
        return 64
    if args.wait_child:
        # Windows has no in-place exec. Keep the tracked ConPTY process alive
        # until the CLI exits; the existing kill-on-close job owns both.
        child = subprocess.Popen(command)
        while True:
            try:
                return child.wait()
            except KeyboardInterrupt:
                continue  # The console also delivered Ctrl+C to the CLI.
    os.execv(command[0], command)
    return 0  # pragma: no cover - exec does not return


if __name__ == "__main__":
    raise SystemExit(main())
