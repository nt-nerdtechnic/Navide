"""Tests for ai_chat_tools — list_directory tool."""

from __future__ import annotations

import pytest
from pathlib import Path

from agent_team_backend.ai_chat_tools import _tool_list_directory


@pytest.mark.asyncio
async def test_list_directory_root(tmp_path: Path) -> None:
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "main.py").write_text("# main")
    (tmp_path / "README.md").write_text("readme")

    result = await _tool_list_directory({}, str(tmp_path))
    assert "README.md" in result
    assert "src/" in result
    assert "main.py" in result


@pytest.mark.asyncio
async def test_list_directory_subpath(tmp_path: Path) -> None:
    sub = tmp_path / "pkg"
    sub.mkdir()
    (sub / "a.py").write_text("")
    (sub / "b.py").write_text("")

    result = await _tool_list_directory({"path": "pkg"}, str(tmp_path))
    assert "a.py" in result
    assert "b.py" in result


@pytest.mark.asyncio
async def test_list_directory_skips_node_modules(tmp_path: Path) -> None:
    (tmp_path / "node_modules").mkdir()
    (tmp_path / "node_modules" / "lodash").mkdir()
    (tmp_path / "index.js").write_text("")

    result = await _tool_list_directory({}, str(tmp_path))
    assert "node_modules" not in result
    assert "index.js" in result


@pytest.mark.asyncio
async def test_list_directory_depth_limit(tmp_path: Path) -> None:
    deep = tmp_path / "a" / "b" / "c"
    deep.mkdir(parents=True)
    (deep / "deep.txt").write_text("")

    result = await _tool_list_directory({"depth": 2}, str(tmp_path))
    assert "a/" in result
    assert "b/" in result
    # depth=2 means we see a/ and b/ but not c/ contents
    assert "deep.txt" not in result


@pytest.mark.asyncio
async def test_list_directory_path_escape(tmp_path: Path) -> None:
    result = await _tool_list_directory({"path": "../../etc"}, str(tmp_path))
    assert result.startswith("Error:")


@pytest.mark.asyncio
async def test_list_directory_nonexistent_path(tmp_path: Path) -> None:
    result = await _tool_list_directory({"path": "nonexistent"}, str(tmp_path))
    assert result.startswith("Error:")


@pytest.mark.asyncio
async def test_list_directory_not_a_dir(tmp_path: Path) -> None:
    (tmp_path / "file.txt").write_text("hello")
    result = await _tool_list_directory({"path": "file.txt"}, str(tmp_path))
    assert result.startswith("Error:")
