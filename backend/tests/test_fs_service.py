"""fs_service — path safety + list_dir(show_hidden) + CRUD round-trips."""

from __future__ import annotations

from pathlib import Path

from agent_team_backend import fs_service


def _ws(tmp_path: Path) -> str:
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "main.ts").write_text("x", encoding="utf-8")
    (tmp_path / "README.md").write_text("hi", encoding="utf-8")
    (tmp_path / ".env").write_text("SECRET=1", encoding="utf-8")
    (tmp_path / ".agent-team").mkdir()
    (tmp_path / ".agent-team" / "project.json").write_text("{}", encoding="utf-8")
    return str(tmp_path)


# ── Path safety ─────────────────────────────────────────────────────────────
def test_list_rejects_parent_escape(tmp_path: Path) -> None:
    res = fs_service.list_dir(_ws(tmp_path), "../..")
    assert res["ok"] is False
    assert "escape" in res["error"].lower()


def test_list_rejects_absolute_escape(tmp_path: Path) -> None:
    res = fs_service.list_dir(_ws(tmp_path), "/etc")
    # leading slash is stripped → resolves to <ws>/etc which does not exist
    assert res["ok"] is False


def test_internal_dir_is_protected(tmp_path: Path) -> None:
    res = fs_service.list_dir(_ws(tmp_path), ".agent-team")
    assert res["ok"] is False
    assert "protected" in res["error"].lower()


def test_no_workspace(tmp_path: Path) -> None:
    assert fs_service.list_dir("", "")["ok"] is False


# ── list_dir + show_hidden ──────────────────────────────────────────────────
def test_list_hides_dotfiles_by_default(tmp_path: Path) -> None:
    res = fs_service.list_dir(_ws(tmp_path), "")
    assert res["ok"] is True
    names = [e["name"] for e in res["entries"]]
    assert "src" in names and "README.md" in names
    assert ".env" not in names           # hidden by default
    assert ".agent-team" not in names     # always excluded


def test_list_show_hidden_includes_dotfiles_but_not_internal(tmp_path: Path) -> None:
    res = fs_service.list_dir(_ws(tmp_path), "", show_hidden=True)
    names = [e["name"] for e in res["entries"]]
    assert ".env" in names
    assert ".agent-team" not in names     # internal dir still hidden
    env = next(e for e in res["entries"] if e["name"] == ".env")
    assert env["is_hidden"] is True


def test_list_dirs_before_files(tmp_path: Path) -> None:
    res = fs_service.list_dir(_ws(tmp_path), "")
    kinds = [e["is_dir"] for e in res["entries"]]
    # all dirs come before all files
    assert kinds == sorted(kinds, reverse=True)


def test_noise_segment_flagged(tmp_path: Path) -> None:
    (tmp_path / "node_modules").mkdir()
    res = fs_service.list_dir(_ws(tmp_path), "")
    nm = next(e for e in res["entries"] if e["name"] == "node_modules")
    assert nm["is_noise"] is True


# ── CRUD ────────────────────────────────────────────────────────────────────
def test_create_file_and_list(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    assert fs_service.create_file(ws, "src/new.ts", "// hi")["ok"] is True
    assert (Path(ws) / "src" / "new.ts").read_text() == "// hi"
    # duplicate fails
    assert fs_service.create_file(ws, "src/new.ts")["ok"] is False


def test_mkdir(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    assert fs_service.mkdir(ws, "src/sub")["ok"] is True
    assert (Path(ws) / "src" / "sub").is_dir()


def test_rename(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    assert fs_service.rename(ws, "README.md", "README2.md")["ok"] is True
    assert not (Path(ws) / "README.md").exists()
    assert (Path(ws) / "README2.md").exists()


def test_rename_into_internal_is_blocked(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    res = fs_service.rename(ws, "README.md", ".agent-team/x.md")
    assert res["ok"] is False


def test_delete_file(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    assert fs_service.delete(ws, "README.md")["ok"] is True
    assert not (Path(ws) / "README.md").exists()


def test_delete_nonempty_dir_rejected(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    res = fs_service.delete(ws, "src")  # contains main.ts
    assert res["ok"] is False
    assert "not empty" in res["error"].lower()
    assert (Path(ws) / "src").is_dir()  # untouched


def test_delete_empty_dir_ok(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    fs_service.mkdir(ws, "emptydir")
    assert fs_service.delete(ws, "emptydir")["ok"] is True
