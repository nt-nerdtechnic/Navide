# -*- mode: python ; coding: utf-8 -*-
#
# Build from the backend/ directory:
#   cd backend && uv run pyinstaller agent_team_backend.spec
#
# Output: backend/dist/agent_team_backend  (single executable, plus the
# platform's executable suffix -- .exe on Windows)
# Electron copies it to resources/bin/ via package.json extraResources.
#
# PyInstaller cannot cross-compile, so this spec runs once per target platform
# on that platform's own CI runner.

import sys

# On Windows the ConPTY terminal backend is pywinpty (winpty.PTY). pywinpty 3.x
# does not create the pseudoconsole itself: conpty.dll launches winpty's own
# `OpenConsole.exe` as the pty host. PyInstaller's graph walk collects the
# extension module and the DLLs it links, but `OpenConsole.exe` is a loose data
# file inside the `winpty` package that nothing imports, so a onefile build
# omits it. When it is missing the spawn still "succeeds" but the pseudoconsole
# is torn down immediately, the child receives CTRL_CLOSE_EVENT, and every
# terminal / CLI pane exits within ~1 s with STATUS_CONTROL_C_EXIT (0xC000013A)
# — the Windows app cannot run any pane. So collect the WHOLE winpty package
# (data files + dynamic libs) into its `winpty/` subdir, keeping the layout
# conpty.dll expects; collecting the package rather than naming OpenConsole.exe
# by hand means a future pywinpty that adds another helper file is covered too.
# `--self-check conpty` (see __main__.py) and test_pyinstaller_spec.py both
# assert this file survives into the build so the omission can never ship
# silently again.
_winpty_binaries = []
_winpty_datas = []
if sys.platform == 'win32':
    from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs

    _winpty_binaries = collect_dynamic_libs('winpty')
    _winpty_datas = collect_data_files('winpty', include_py_files=False)

a = Analysis(
    ['run.py'],
    pathex=['.'],
    binaries=_winpty_binaries,
    datas=_winpty_datas + [
        # git execs GIT_ASKPASS by path (no shell), so this must exist as a
        # real file on disk in the onefile extraction dir -- PyInstaller only
        # extracts modules bundled in the PYZ archive on demand as .pyc, never
        # as the loose .py file git_service.py's GIT_ASKPASS path points to.
        ('agent_team_backend/git_askpass_helper.py', 'agent_team_backend'),
        # Plan-document infrastructure provisioned into every opened workspace
        # (<ws>/.agent-team/plans/). Read at runtime via Path(__file__).parent,
        # so onefile builds must ship the real files.
        ('agent_team_backend/plan_assets/_spec.md', 'agent_team_backend/plan_assets'),
        ('agent_team_backend/plan_assets/_template.html', 'agent_team_backend/plan_assets'),
        # Builtin backend plugins: the host discovers plugin dirs on disk
        # (plugin.json + backend.py) and imports backend.py by file path, so
        # both must exist as real files next to the extracted package.
        # A plugin dir left out here is simply not discovered in a packaged
        # build -- no error, the plugin is just gone. Every dir under
        # plugins/builtin/ needs its own pair; test_pyinstaller_spec.py fails
        # when a new one is added without them.
        ('agent_team_backend/plugins/builtin/navide_plans/plugin.json',
         'agent_team_backend/plugins/builtin/navide_plans'),
        ('agent_team_backend/plugins/builtin/navide_plans/backend.py',
         'agent_team_backend/plugins/builtin/navide_plans'),
        ('agent_team_backend/plugins/builtin/navide_skills/plugin.json',
         'agent_team_backend/plugins/builtin/navide_skills'),
        ('agent_team_backend/plugins/builtin/navide_skills/backend.py',
         'agent_team_backend/plugins/builtin/navide_skills'),
    ],
    hiddenimports=[
        # The top-level app object (imported by name in __main__.py, but listed
        # here as belt-and-suspenders for PyInstaller's graph walk).
        'agent_team_backend.app',
        # Builtin plugin modules: each backend.py is loaded by file path at
        # runtime (never a static import), so PyInstaller's graph walk cannot
        # see what it imports — list those here (their own imports, e.g.
        # plan_meta and the MCP server modules, are then traced normally).
        # A stale name here fails silently: PyInstaller only warns, the plugin
        # package then never reaches the PYZ, and the datas copy below is left
        # as a namespace package whose submodules cannot be imported at all
        # ("cannot import name 'plan_tools' ... (unknown location)").
        # test_pyinstaller_spec.py holds these names to what exists on disk.
        'agent_team_backend.plugins.builtin.navide_plans.plan_tools',
        'agent_team_backend.plugins.builtin.navide_skills.skills_wiring',
        # uvicorn internals that are resolved at runtime, not import-time.
        'uvicorn.main',
        'uvicorn.lifespan.on',
        'uvicorn.protocols.websockets.websockets_impl',
        'uvicorn.protocols.websockets.wsproto_impl',
        'uvicorn.protocols.http.h11_impl',
        'uvicorn.protocols.http.httptools_impl',
        'uvicorn.logging',
        'uvicorn.loops.asyncio',
        'uvicorn.loops.uvloop',
        # uvicorn[standard] optional extras.
        'websockets',
        'websockets.legacy',
        'websockets.legacy.server',
        'httptools',
        'watchfiles',
        # watchdog picks its observer at import time from a platform-specific
        # module that static analysis cannot see, so every platform's is named.
        # Listed as literals rather than selected per platform on purpose:
        # tests/test_pyinstaller_spec.py reads this list with ast.literal_eval,
        # which cannot evaluate a starred expression. PyInstaller only warns
        # about a hidden import that does not exist on the build machine (the
        # macOS build has always warned about nothing — fsevents is simply
        # absent on Linux and the Linux build had never been run), so naming
        # all of them costs a warning line per platform and nothing else.
        'watchdog.observers.fsevents',              # macOS
        'watchdog.observers.inotify',               # Linux
        'watchdog.observers.inotify_buffer',
        'watchdog.observers.inotify_c',
        'watchdog.observers.read_directory_changes',  # Windows
        'watchdog.observers.winapi',
        'watchdog.observers.polling',               # fallback, every platform
        # anthropic SDK uses lazy internal imports.
        'anthropic',
        'anthropic._streaming',
        # httpx (used by anthropic and fastapi test clients).
        'httpx',
        # MCP SDK.
        'mcp',
        'mcp.server',
        'mcp.server.stdio',
        'mcp.client',
        'mcp.client.stdio',
        # pydantic v2 validators loaded via plugin mechanism.
        'pydantic.deprecated.class_validators',
        'pydantic.deprecated.config',
        'pydantic.deprecated.tools',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # Dev-only; never needed at runtime.
        'pytest',
        'pytest_asyncio',
    ],
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='agent_team_backend',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    # argv_emulation=True causes PTY issues on macOS; keep it off.
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
