"""MiniMax Code (``mcode``) — MiniMax's terminal coding agent.

Verified against mcode 0.4.12 (npm ``@minimax-ai/code``) on macOS.

What this spec deliberately leaves unset, and why — every one of these was
probed against the real binary rather than read off the docs, because the
published reference mixes the interactive command's flags with those of the
``exec`` subcommand, and Navide only ever spawns the interactive one:

* **No model or effort capability.** ``mcode --help`` lists exactly five
  options for the interactive command: ``--lane``, ``--session``,
  ``-c/--continue``, ``--tui-mode`` and ``--version``. ``--model`` and
  ``--effort`` exist only under ``mcode exec``. This matters more here than
  for the vendors that silently drop an unknown flag: mcode is strict, so
  passing one is not merely ignored —

      $ mcode --bogus-flag-xyz
      error: unknown option '--bogus-flag-xyz'

  — the process exits and the pane never starts. A guessed flag here is a
  dead pane, not a degraded one.

* **No permission-bypass flag.** The interactive command has none. mcode's
  unattended mode is a *setting*, not an argument: ``permissionMode`` in
  ``<data-dir>/config.yaml`` (``default``/``auto``/``bypassPermissions``/
  ``off``), or Alt+M inside the TUI. ``--permission <policy>`` belongs to
  ``mcode exec`` and is rejected by the interactive command, so YOLO mode
  cannot be expressed as argv for this vendor.

* **No session resume.** ``--session <id>`` does exist on the interactive
  command, but Navide can only use it if something can name the id of a
  session it just started, and that means a log reader. mcode stores its
  conversations in SQLite — ``<data-dir>/v2/sqlite/runtime-state.sqlite``
  (WAL), with ``local_runtime_sessions`` (session_id, workspace_dir, title)
  and ``local_runtime_message_rows`` (role, turn_id, data_json) — which is a
  shape no existing reader covers, and the row payloads cannot be honestly
  modelled without an authenticated session to read. Left unset until one
  exists; the schema is recorded here so that work starts from a fact.

* **No credential fields, no usage.** Signing in writes under
  ``<data-dir>/auth/<env>/<region>/mcode-public/``; without a login the
  directory holds only ``auth.lock``, so the file the vault would park is
  not known yet. Usage needs the same login.

What is verified and set: ``MINIMAX_DATA_DIR`` really does relocate the whole
data root. Pointing it at an empty directory and running the CLI creates the
entire tree there (``config.yaml``, ``auth/``, ``v2/sqlite/``, ``agents/``,
``plugins/``) and leaves ``~/.minimax`` untouched — checked explicitly.

That is what makes it a ``home_env_vars`` entry, and the field is a guard
rather than an injection: the backend strips these names from its own
inherited environment and from probe spawns, and ``spawn_env_deny_list``
refuses a spawn request that tries to set one. Verified over the real socket —
a ``terminal.create`` carrying ``MINIMAX_DATA_DIR=/tmp/attacker-controlled``
reached the process with no MINIMAX var at all, and the window was told why
via ``cli.env_ignored`` (``denied: ["MINIMAX_DATA_DIR"]``).
"""

from .base import Dep, VendorSpec

SPEC = VendorSpec(
    key="mcode",
    # Region/environment auth routing is known; service hosts are not verified.
    expected_hosts=(),
    # Relocation and legacy fallback verified against mcode 0.4.12 above.
    data_dirs=lambda ctx: (ctx.path(ctx.env.get("MINIMAX_DATA_DIR") or ctx.env.get("MAVIS_DATA_DIR") or ctx.home / ".minimax"),),
    data_dir_env_vars=("MINIMAX_DATA_DIR", "MAVIS_DATA_DIR"),
    label="MiniMax Code",
    # `--session <id>` exists on the interactive command, but resume also
    # needs something able to NAME the id of a session Navide started, and
    # that is the log reader mcode does not have yet (see the module
    # docstring for the SQLite schema it would read). Declared False so the
    # default True does not advertise a resume that would find no id —
    # unlike aider, this is a missing reader, not a missing concept.
    supports_session_resume=False,
    # Relocates the entire data root — config, auth, session SQLite. The CLI
    # also honours MAVIS_DATA_DIR as a legacy fallback. Navide strips rather
    # than injects these variables, so both names must be guarded or the
    # fallback can redirect a pane to a different account and session store.
    home_env_vars=("MINIMAX_DATA_DIR", "MAVIS_DATA_DIR"),
    # `mcode login` (add `--region global` for a non-mainland account, which
    # is a choice the user makes in the CLI's own flow, not something Navide
    # can pick for them).
    login_command_args="login",
    install_dep=Dep("mcode", "MiniMax Code", "MiniMax terminal coding agent", "agent_cli",
        ["mcode", "--version"], r"(\d+\.\d+\.\d+)",
        install_cmd="npm install -g @minimax-ai/code", needs_terminal=True,
        requires_binaries=("npm",), optional=True,
        docs_url="https://agent.minimaxi.com/docs/cli/quick-start",
        # `mcode update` is the CLI's own updater (listed by `mcode --help`).
        # No doctor command exists.
        update_cmd="mcode update",
        npm_package="@minimax-ai/code",
        config_home_env="MINIMAX_DATA_DIR", config_home_default=".minimax"),
)
