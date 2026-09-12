"""The `Paths` members Darwin and Linux answer identically.

Both are POSIX from the point of view of a child process — `HOME`, `TMPDIR`,
a shebang the kernel honours — so the two implementation modules delegate
here rather than carrying the same three functions twice. What they do *not*
share (the config and state roots) stays in each module.
"""

from __future__ import annotations

import logging
import shlex
import stat
import sys
from pathlib import Path

from . import spec

log = logging.getLogger(__name__)


def home_env_var() -> str:
    return "HOME"


def roaming_app_data() -> Path | None:
    return None


def isolated_home_env(home_dir: Path) -> dict[str, str]:
    home = str(home_dir)
    return {"HOME": home, "TMPDIR": home}


def askpass_launcher(helper_py: Path, launch_argv: list[str]) -> Path:
    """The `.py` itself, or a `.sh` around `launch_argv` in a frozen build.

    From a source checkout the answer stays what it has always been: git execs
    the script and the kernel runs its `/usr/bin/env python3` shebang. A
    frozen build has no `python3` to promise — it ships one inside itself —
    so it gets a sibling `.sh` that runs its own askpass entry mode and passes
    git's prompt through.

    Best effort on both writes: a helper on a read-only volume is still worth
    pointing git at, and git reports the exec failure itself.
    """
    if getattr(sys, "frozen", False):
        launcher = helper_py.with_suffix(".sh")
        argv = " ".join(shlex.quote(part) for part in launch_argv)
        content = f'#!/bin/sh\nexec {argv} "$@"\n'.encode("utf-8")
        try:
            existing = launcher.read_bytes()
        except OSError:
            existing = b""
        try:
            # Rewritten only when its content differs, so a launcher that is
            # already right keeps its mtime and no other process sees it flicker.
            if existing != content:
                launcher.write_bytes(content)
            launcher.chmod(0o755)
        except OSError as err:
            log.warning("cannot write git askpass launcher %s: %s", launcher, err)
        return launcher

    try:
        helper_py.chmod(helper_py.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    except OSError:
        pass
    return helper_py



# ---- appended: the members added for the Windows port ------------------------

import os  # noqa: E402
import shutil  # noqa: E402
from collections.abc import Sequence  # noqa: E402


def executable_candidates(name: str) -> list[str]:
    return [name]


def is_executable(path: Path) -> bool:
    return os.access(path, os.X_OK)


#: What the probe runs: `printf` rather than `echo` so the marker and the
#: value land on one line whatever the rc files printed before it.
LOGIN_PATH_PROBE_SCRIPT = f'printf "{spec.LOGIN_PATH_MARKER}%s\\n" "$PATH"'


def login_path_probe(*, interactive_bash: bool = False) -> list[str]:
    """The shell invocation used to read the user's real PATH.

    Uses $SHELL, not bash: installers write PATH exports into the user's own
    shell config. For zsh that file is ~/.zshrc, which zsh only reads in
    INTERACTIVE mode — a plain login shell (-lc) misses it (real case: grok's
    installer writes to ~/.zshrc; `zsh -lc` couldn't see it, so both detection
    and spawn kept failing with command-not-found after install).

    `interactive_bash` asks the same of bash. Linux wants it: the nvm, bun and
    `npm config set prefix` instructions all append to ~/.bashrc, and the
    Debian/Ubuntu stock ~/.bashrc returns at its first line unless the shell
    is interactive, so `bash -lc` sees ~/.profile and nothing else. macOS
    keeps `-lc` for bash — the shipped bash 3.2 rc files are not written with
    an interactive-but-headless shell in mind, and that is what shipped there.
    Same split as `loginShellFlags` in src/shared/osplat.ts.
    """
    shell = os.environ.get("SHELL") or "/bin/bash"
    name = os.path.basename(shell)
    interactive = name == "zsh" or (interactive_bash and name == "bash")
    return [shell, "-ilc" if interactive else "-lc", LOGIN_PATH_PROBE_SCRIPT]


def git_subprocess_env(askpass: str) -> dict[str, str]:
    return {
        "GIT_ASKPASS": askpass,
        "SSH_ASKPASS": askpass,
        "SSH_ASKPASS_REQUIRE": "force",
        "GIT_TERMINAL_PROMPT": "0",
    }


def nvm_node_bins(home: Path) -> list[str]:
    """Every `bin` nvm has installed under `home`, newest version first.

    nvm exports exactly one of these (the `default` alias) and only from the
    rc file the probe just failed to read, so which one the shell would have
    chosen is unknowable here. A CLI installed with `npm install -g` lives
    under the node version that installed it, so all of them go on `PATH`.
    """
    versions = home / ".nvm" / "versions" / "node"
    try:
        entries = [d for d in versions.iterdir() if (d / "bin").is_dir()]
    except OSError:
        return []

    def key(d: Path) -> tuple[int, ...]:
        digits = d.name.lstrip("v").split(".")
        return tuple(int(part) if part.isdigit() else 0 for part in digits)

    return [str(d / "bin") for d in sorted(entries, key=key, reverse=True)]


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


# ---- appended: finding a program and starting it ----------------------------


def resolve_program(name_or_path: str, *, path: str | None = None) -> str | None:
    return shutil.which(name_or_path, path=path)


def launch_kind(program: str) -> str:
    # Nothing to interpret: the kernel reads the shebang, so every runnable
    # file starts the same way.
    return "direct"


def launch_argv(program: str, args: Sequence[str] = ()) -> list[str]:
    return [program, *args]


def pty_launch_parts(
    program: str, args: Sequence[str] = (), *, path: str | None = None
) -> tuple[str, list[str]]:
    return program, list(args)


# ---- appended: the sh renderings of the scripts the backend writes -----------


class PosixScripts:
    """sh, for every shell a POSIX box opens and for Claude Code's default.

    Also the `bash` half of Copilot's hook file on *every* platform: that file
    declares both spellings and picks at fire time, so it is written once and
    read wherever Copilot runs.
    """

    def hook_entry(self, command: str) -> dict:
        # No `shell` key: sh is what Claude Code runs a hook with here, and
        # adding one would rewrite every existing settings.json for nothing.
        return {"type": "command", "command": command}

    def hook_post_json(
        self,
        *,
        port_file: str,
        header_file: str,
        url_path: str,
        event: str,
        timeout_s: int,
        keep_body: bool = False,
        exit_zero: bool = False,
    ) -> str:
        sink = "" if keep_body else "-o /dev/null "
        tail = ' >/dev/null 2>&1; exit 0' if exit_zero else " || true"
        return (
            f"PORT=$(cat {shlex.quote(port_file)} 2>/dev/null); "
            f'[ -n "$PORT" ] && curl -fsS -m {timeout_s} {sink}-X POST '
            f"-H 'Content-Type: application/json' "
            f"-H 'X-Agent-Team-Event: {event}' "
            f"-H @{shlex.quote(header_file)} "
            f"--data-binary @- "
            f'"http://127.0.0.1:$PORT{url_path}"{tail}'
        )

    def hook_rewake(
        self, *, port_file: str, header_file: str, url_path: str, timeout_s: int
    ) -> str:
        return (
            f"PORT=$(cat {shlex.quote(port_file)} 2>/dev/null); "
            f'[ -n "$PORT" ] || exit 0\n'
            f"BODY=$(curl -fsS -m {timeout_s} -X POST "
            f"-H 'Content-Type: application/json' "
            f"-H 'X-Agent-Team-Event: rewake' "
            f"-H @{shlex.quote(header_file)} "
            f"--data-binary @- "
            f'"http://127.0.0.1:$PORT{url_path}" || true)\n'
            f'[ -n "$BODY" ] || exit 0\n'
            f"printf '%s\\n' \"$BODY\" >&2\n"
            f"exit 2"
        )

    def confirm_then_run(self, description: str, command: str) -> str:
        return (
            f"printf '%s\\n' {shlex.quote(description)}; "
            "printf 'Continue? [y/N] '; read -r answer; "
            f"case \"$answer\" in [Yy]*) {command} ;; *) echo 'Cancelled.' ;; esac"
        )


scripts = PosixScripts()
