"""Helpers for launching standard-library fake CLIs through platform shims."""
from __future__ import annotations

from collections.abc import Sequence
import os
from pathlib import Path
import shlex
import subprocess
import sys


def base_python_executable() -> str:
    """Use the real interpreter rather than the Windows venv launcher."""
    return getattr(sys, "_base_executable", None) or sys.executable


def install_cli_shim(directory: Path, name: str, arguments: Sequence[str]) -> Path:
    """Write an executable that forwards its arguments to a fake CLI."""
    executable = directory / (f"{name}.cmd" if os.name == "nt" else name)
    if os.name == "nt":
        body = subprocess.list2cmdline(list(arguments))
        executable.write_text(
            f"@echo off\r\n{body} %*\r\nexit /b %ERRORLEVEL%\r\n",
            encoding="utf-8",
        )
    else:
        executable.write_text(
            "#!/bin/sh\nexec " + shlex.join(arguments) + ' "$@"\n',
            encoding="utf-8",
        )
        executable.chmod(0o700)
    return executable
