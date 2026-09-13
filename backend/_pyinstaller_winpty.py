"""Freeze winpty's ConPTY host into the bundle, robustly.

Imported by both `agent_team_backend.spec` (at build time) and the spec test,
so they agree on exactly what gets collected.

pywinpty 3.x does not open the pseudoconsole itself: `conpty.dll` launches
winpty's `OpenConsole.exe` as the pty host. PyInstaller's graph walk collects
the extension module and the DLLs it links, but `OpenConsole.exe` is a loose
`.exe` inside the package that nothing imports. `collect_data_files` might or
might not return it — whether a bare `.exe` counts as a "data file" varies by
PyInstaller version (it does on some, not on the CI runner) — so this does not
depend on that classification: it walks the package directory and adds every
`.exe` explicitly. When `OpenConsole.exe` is missing the spawn still succeeds
but the pseudoconsole is torn down at once and every pane exits with
STATUS_CONTROL_C_EXIT (0xC000013A).
"""

from __future__ import annotations

import os


def collect_winpty() -> tuple[list, list]:
    """Return `(binaries, datas)` for winpty, keeping its `winpty/` layout.

    `binaries` are the linked libraries (`conpty.dll`, `winpty.dll`) via
    PyInstaller's own helper; `datas` are the loose `.exe` helpers
    (`OpenConsole.exe`, `winpty-agent.exe`) that conpty.dll launches. Both are
    empty off Windows / without pywinpty, so a non-Windows build is unaffected.
    """
    binaries: list = []
    datas: list = []

    try:
        from PyInstaller.utils.hooks import collect_dynamic_libs

        binaries = collect_dynamic_libs("winpty")
    except Exception:  # pragma: no cover - PyInstaller absent or no winpty
        binaries = []

    try:
        import winpty

        winpty_dir = os.path.dirname(winpty.__file__)
        for name in os.listdir(winpty_dir):
            full = os.path.join(winpty_dir, name)
            if os.path.isfile(full) and name.lower().endswith(".exe"):
                datas.append((full, "winpty"))
    except Exception:  # pragma: no cover - winpty absent (non-Windows)
        pass

    return binaries, datas
