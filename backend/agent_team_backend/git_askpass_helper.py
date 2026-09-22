#!/usr/bin/env python3
"""GIT_ASKPASS helper invoked directly by git (no shell) to relay credential
prompts to the Agent-Team backend over a one-shot loopback TCP connection.

git execs the path pointed to by GIT_ASKPASS with the prompt string as the
sole argv[1] -- it does not go through a shell -- so what GIT_ASKPASS names
is either this file run through its shebang (a source checkout) or a small
launcher the platform can exec, which re-enters the backend executable in the
`--askpass-helper` entry mode and lands back in `main()` below. Nothing here
may depend on an interpreter being on PATH: a frozen build ships none, and
`python` on a stock Windows is the Store's alias stub.

Any failure (missing env, connection refused, timeout, bad response) must
fall back to printing an empty string and exiting 0 so git proceeds with its
normal credential-failure path instead of hanging or crashing.
"""
from __future__ import annotations

import json
import os
import socket
import sys


#: The argv[1] that puts `__main__` into this entry mode. Defined here, where
#: nothing heavy is imported, so both the dispatcher and git_service (which
#: writes it into the launcher) can name it without importing the other.
ASKPASS_FLAG = "--askpass-helper"


def main(prompt: str | None = None) -> None:
    """Answer one credential prompt. `prompt` defaults to argv[1], which is
    where git puts it when it execs this file directly."""
    if prompt is None:
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
