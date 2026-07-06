#!/usr/bin/env python3
"""GIT_ASKPASS helper invoked directly by git (no shell) to relay credential
prompts to the Agent-Team backend over a one-shot loopback TCP connection.

git execs the path pointed to by GIT_ASKPASS with the prompt string as the
sole argv[1] -- it does not go through a shell -- so this file must be
directly executable (shebang + chmod +x) rather than a multi-word command.

Any failure (missing env, connection refused, timeout, bad response) must
fall back to printing an empty string and exiting 0 so git proceeds with its
normal credential-failure path instead of hanging or crashing.
"""
from __future__ import annotations

import json
import os
import socket
import sys


def main() -> None:
    prompt = sys.argv[1] if len(sys.argv) > 1 else ""
    value = ""
    try:
        port = int(os.environ["NAVIDE_ASKPASS_PORT"])
        token = os.environ["NAVIDE_ASKPASS_TOKEN"]

        with socket.create_connection(("127.0.0.1", port), timeout=65.0) as sock:
            sock.sendall((json.dumps({"token": token, "prompt": prompt}) + "\n").encode("utf-8"))

            buf = b""
            with sock.makefile("rb") as reader:
                buf = reader.readline()

            response = json.loads(buf.decode("utf-8"))
            resolved = response.get("value")
            if resolved is not None:
                value = str(resolved)
    except Exception:
        value = ""

    print(value)
    sys.exit(0)


if __name__ == "__main__":
    main()
