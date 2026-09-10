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


def _keyword(name: str) -> list:
    for keyword in _analysis_call().keywords:
        if keyword.arg == name:
            return ast.literal_eval(keyword.value)
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
