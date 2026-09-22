"""The one-file build recipe must keep naming things that still exist.

PyInstaller only warns about a hiddenimport it cannot resolve and about a
datas entry it cannot find, so a rename on this side of the tree breaks the
packaged app silently: the module never reaches the PYZ, and the shipped
plugin directory is left as a namespace package whose submodules cannot be
imported ("cannot import name 'plan_tools' ... (unknown location)"). That is
invisible until someone launches an installed build.
"""

from __future__ import annotations

import ast
import importlib.util
import sys
from pathlib import Path

SPEC_PATH = Path(__file__).resolve().parents[1] / "agent_team_backend.spec"
BACKEND_ROOT = SPEC_PATH.parent


def _analysis_call() -> ast.Call:
    tree = ast.parse(SPEC_PATH.read_text(encoding="utf-8"), filename=str(SPEC_PATH))
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id == "Analysis"
        ):
            return node
    raise AssertionError("no Analysis(...) call in agent_team_backend.spec")


def _literal_parts(node: ast.expr) -> list:
    # `datas` is `_winpty_datas + [ ...literals... ]` and `binaries` is the
    # bare name `_winpty_binaries`: both mix a runtime-collected value (a Name,
    # only known when the spec runs on Windows with pywinpty installed) with an
    # optional literal list. Return just the literal elements; the winpty
    # collection is covered by test_spec_collects_winpty_on_windows instead.
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        return _literal_parts(node.left) + _literal_parts(node.right)
    if isinstance(node, (ast.List, ast.Tuple)):
        return list(ast.literal_eval(node))
    return []


def _keyword(name: str) -> list:
    for keyword in _analysis_call().keywords:
        if keyword.arg == name:
            return _literal_parts(keyword.value)
    raise AssertionError(f"Analysis(...) has no {name}= argument")


def test_own_hidden_imports_resolve():
    own = [name for name in _keyword("hiddenimports") if name.startswith("agent_team_backend")]
    assert own, "spec no longer lists any first-party hiddenimports"

    missing = [name for name in own if importlib.util.find_spec(name) is None]
    assert not missing, f"hiddenimports name modules that no longer exist: {missing}"


def _builtin_plugin_dirs() -> list[Path]:
    # The same rule plugins/wiring.py discovers with: a direct child dir
    # holding both files. A dir the spec does not ship is simply not there in
    # a packaged build, and the plugin silently does not exist.
    root = BACKEND_ROOT / "agent_team_backend" / "plugins" / "builtin"
    return sorted(
        child
        for child in root.iterdir()
        if (child / "plugin.json").is_file() and (child / "backend.py").is_file()
    )


def test_every_builtin_plugin_ships_its_entry_files():
    shipped = {src for src, _dest in _keyword("datas")}
    missing = [
        f"{plugin.name}/{name}"
        for plugin in _builtin_plugin_dirs()
        for name in ("plugin.json", "backend.py")
        if f"agent_team_backend/plugins/builtin/{plugin.name}/{name}" not in shipped
    ]
    assert not missing, f"builtin plugin files missing from datas: {missing}"


def test_every_builtin_plugin_entry_pins_its_sibling_imports():
    # backend.py is imported by file path, so the graph walk never sees what it
    # imports. Whatever it pulls in from its own package has to be pinned here.
    own = set(_keyword("hiddenimports"))
    missing: list[str] = []
    for plugin in _builtin_plugin_dirs():
        package = f"agent_team_backend.plugins.builtin.{plugin.name}"
        tree = ast.parse((plugin / "backend.py").read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if not isinstance(node, ast.ImportFrom) or node.module != package:
                continue
            for alias in node.names:
                name = f"{package}.{alias.name}"
                if name not in own:
                    missing.append(name)
    assert not missing, f"builtin plugin imports not pinned in hiddenimports: {missing}"


def test_datas_sources_exist():
    missing = [src for src, _dest in _keyword("datas") if not (BACKEND_ROOT / src).is_file()]
    assert not missing, f"datas entries point at files that are not there: {missing}"


def test_spec_wires_winpty_collection():
    """The spec must feed the shared winpty collector into Analysis.

    Structural, so it runs on every platform's CI (not just Windows): the
    `binaries=` argument must be the collected `_winpty_binaries` and `datas=`
    must add `_winpty_datas`, both produced by `collect_winpty()`. Doing the
    collection through the shared helper (rather than inline) is what lets
    test_helper_collects_openconsole_on_windows below exercise the exact logic.
    """
    src = SPEC_PATH.read_text(encoding="utf-8")
    assert "from _pyinstaller_winpty import collect_winpty" in src, (
        "spec no longer imports the shared winpty collector"
    )
    assert "collect_winpty()" in src, "spec no longer calls collect_winpty()"

    call = _analysis_call()
    binaries = next((kw.value for kw in call.keywords if kw.arg == "binaries"), None)
    assert isinstance(binaries, ast.Name) and binaries.id == "_winpty_binaries", (
        "Analysis(binaries=...) must be the collected _winpty_binaries"
    )

    datas = next((kw.value for kw in call.keywords if kw.arg == "datas"), None)
    names = {
        node.id
        for node in ast.walk(datas)
        if isinstance(node, ast.Name)
    } if datas is not None else set()
    assert "_winpty_datas" in names, "Analysis(datas=...) must include _winpty_datas"


def test_helper_collects_openconsole_on_windows():
    """On Windows `collect_winpty()` must actually yield winpty/OpenConsole.exe.

    This is the file whose absence makes every ConPTY pane die with
    STATUS_CONTROL_C_EXIT, and the whole reason the collection walks the package
    for `.exe` instead of trusting `collect_data_files`' type classification
    (which does not return the bare `.exe` on every PyInstaller version).
    Windows-only because pywinpty exists only there; the frozen build
    additionally proves usability through `--self-check conpty` in CI.
    """
    if sys.platform != "win32":
        import pytest

        pytest.skip("winpty and its OpenConsole.exe exist only on Windows")

    sys.path.insert(0, str(BACKEND_ROOT))
    try:
        from _pyinstaller_winpty import collect_winpty
    finally:
        sys.path.pop(0)

    binaries, datas = collect_winpty()
    # A datas/binaries entry is (source_path, dest_dir); the filename lives in
    # the source, and dest is the `winpty/` target directory.
    names = {Path(src).name.lower() for src, _dest in [*binaries, *datas]}
    assert "openconsole.exe" in names, (
        "collect_winpty() is missing OpenConsole.exe — ConPTY panes would die "
        f"with STATUS_CONTROL_C_EXIT; collected: {sorted(names)}"
    )
