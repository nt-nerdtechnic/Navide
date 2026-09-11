"""The `Paths` members Darwin and Linux answer identically.

Both are POSIX from the point of view of a child process — `HOME`, `TMPDIR`,
a shebang the kernel honours — so the two implementation modules delegate
here rather than carrying the same three functions twice. What they do *not*
share (the config and state roots) stays in each module.
"""

from __future__ import annotations

import stat
from pathlib import Path


def home_env_var() -> str:
    return "HOME"


def roaming_app_data() -> Path | None:
    return None


def isolated_home_env(home_dir: Path) -> dict[str, str]:
    home = str(home_dir)
    return {"HOME": home, "TMPDIR": home}


def askpass_launcher(helper_py: Path, python_exe: str | None) -> Path:
    """The `.py` itself: git execs it and the kernel runs the shebang.

    `python_exe` is unused on purpose — the shebang's `/usr/bin/env python3`
    decides the interpreter, which is also why a frozen build works here
    without carrying one. Best effort on the chmod: a helper on a read-only
    volume is still worth pointing git at, and git reports the exec failure
    itself.
    """
    try:
        helper_py.chmod(helper_py.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    except OSError:
        pass
    return helper_py



# ---- appended: the members added for the Windows port ------------------------

import os  # noqa: E402
import shlex  # noqa: E402


def executable_candidates(name: str) -> list[str]:
    return [name]


def is_executable(path: Path) -> bool:
    return os.access(path, os.X_OK)


def login_path_probe() -> list[str]:
    """The shell invocation used to read the user's real PATH.

    Uses $SHELL, not bash: installers write PATH exports into the user's own
    shell config. For zsh that file is ~/.zshrc, which zsh only reads in
    INTERACTIVE mode — a plain login shell (-lc) misses it (real case: grok's
    installer writes to ~/.zshrc; `zsh -lc` couldn't see it, so both detection
    and spawn kept failing with command-not-found after install).
    """
    shell = os.environ.get("SHELL") or "/bin/bash"
    if os.path.basename(shell) == "zsh":
        return [shell, "-ilc", "echo $PATH"]
    return [shell, "-lc", "echo $PATH"]


def backend_entry_on_disk(entry: str) -> str:
    return entry


def enforces_posix_modes() -> bool:
    return True


def symlinks_available() -> bool:
    return True


def shell_command(command: str) -> list[str]:
    return ["/bin/sh", "-c", command]


def quote_arg(arg: str) -> str:
    return shlex.quote(arg)
