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

