"""fs_service — path safety + list_dir(show_hidden) + CRUD round-trips."""

from __future__ import annotations

import base64
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


def test_delete_nonempty_dir_ok(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    res = fs_service.delete(ws, "src")  # contains main.ts
    assert res["ok"] is True
    assert not (Path(ws) / "src").exists()


def test_delete_empty_dir_ok(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    fs_service.mkdir(ws, "emptydir")
    assert fs_service.delete(ws, "emptydir")["ok"] is True


# ── read / write (editor) ────────────────────────────────────────────────────
def test_read_file(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    res = fs_service.read_file(ws, "README.md")
    assert res["ok"] is True and res["content"] == "hi"


def test_read_file_has_no_size_limit(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    content = "x" * (10 * 1024 * 1024 + 1)
    (Path(ws) / "large.txt").write_text(content)

    res = fs_service.read_file(ws, "large.txt")

    assert res["ok"] is True
    assert res["content"] == content


def test_read_large_pdf_is_classified_as_binary(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    size = 10 * 1024 * 1024 + 1
    pdf = Path(ws) / "large.pdf"
    with pdf.open("wb") as fh:
        fh.truncate(size)

    res = fs_service.read_file(ws, "large.pdf")

    assert res["ok"] is False
    assert res["error"] == "binary file"
    assert res["is_binary"] is True
    assert res["size"] == size


def test_read_file_rejects_escape(tmp_path: Path) -> None:
    assert fs_service.read_file(_ws(tmp_path), "../../etc/hosts")["ok"] is False


def test_write_file_roundtrip(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    assert fs_service.write_file(ws, "src/main.ts", "// edited")["ok"] is True
    assert (Path(ws) / "src" / "main.ts").read_text() == "// edited"
    assert fs_service.read_file(ws, "src/main.ts")["content"] == "// edited"


def test_write_file_blocks_internal_dir(tmp_path: Path) -> None:
    assert fs_service.write_file(_ws(tmp_path), ".agent-team/x", "y")["ok"] is False


# ── read_image ────────────────────────────────────────────────────────────────

# Smallest valid PNG: a 1x1 transparent pixel.
_PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)


def test_read_image_returns_data_url(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    (Path(ws) / "pic.png").write_bytes(_PNG_1X1)
    res = fs_service.read_image(ws, "pic.png")
    assert res["ok"] is True
    assert res["mime"] == "image/png"
    assert res["data_url"].startswith("data:image/png;base64,")
    assert res["size"] == len(_PNG_1X1)


def test_read_image_has_no_size_limit(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    image = _PNG_1X1 + b"\0" * (10 * 1024 * 1024)
    (Path(ws) / "large.png").write_bytes(image)

    res = fs_service.read_image(ws, "large.png")

    assert res["ok"] is True
    assert res["size"] == len(image)
    assert res["data_url"].startswith("data:image/png;base64,")


def test_read_image_rejects_non_image(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    res = fs_service.read_image(ws, "README.md")
    assert res["ok"] is False
    assert "not an image" in res["error"]


def test_read_image_missing_file(tmp_path: Path) -> None:
    res = fs_service.read_image(_ws(tmp_path), "nope.png")
    assert res["ok"] is False


def test_read_image_rejects_escape(tmp_path: Path) -> None:
    assert fs_service.read_image(_ws(tmp_path), "../../etc/secret.png")["ok"] is False


def test_stat_path_expands_home(tmp_path: Path, monkeypatch) -> None:
    """Terminal output prints '~/...' paths verbatim; stat must expand them."""
    monkeypatch.setenv("HOME", str(tmp_path))
    (tmp_path / "cert.pem").write_text("x", encoding="utf-8")
    assert fs_service.stat_path("~/cert.pem") == {"ok": True, "exists": True}
    assert fs_service.stat_path("~/missing.pem") == {"ok": True, "exists": False}
