"""search_service — ripgrep find-in-files + regex-aware replace round-trips."""

from __future__ import annotations

import threading
from pathlib import Path

import pytest

from agent_team_backend import search_service


def _ws(tmp_path: Path) -> str:
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "a.ts").write_text(
        "const Foo = 1\nfunction foo() {}\n// foobar\n", encoding="utf-8"
    )
    (tmp_path / "src" / "b.js").write_text("const foo = 2\n", encoding="utf-8")
    (tmp_path / "README.md").write_text("Foo here\n", encoding="utf-8")
    return str(tmp_path)


# ── find ─────────────────────────────────────────────────────────────────────
def test_empty_query_returns_empty(tmp_path: Path) -> None:
    res = search_service.find_in_files(_ws(tmp_path), "")
    assert res == {"ok": True, "results": [], "total": 0, "truncated": False}


def test_missing_workspace(tmp_path: Path) -> None:
    res = search_service.find_in_files(str(tmp_path / "nope"), "foo")
    assert res["ok"] is False



def test_find_case_insensitive_groups_by_file(tmp_path: Path) -> None:
    res = search_service.find_in_files(_ws(tmp_path), "foo")
    assert res["ok"] is True
    # foo/Foo across a.ts (3), b.js (1), README.md (1)
    by_file = {r["name"]: len(r["matches"]) for r in res["results"]}
    assert by_file["a.ts"] == 3
    assert by_file["b.js"] == 1
    assert by_file["README.md"] == 1
    assert res["total"] == 5



def test_find_case_sensitive(tmp_path: Path) -> None:
    res = search_service.find_in_files(_ws(tmp_path), "Foo", case_sensitive=True)
    names = {r["name"] for r in res["results"]}
    assert names == {"a.ts", "README.md"}  # capital Foo only
    assert res["total"] == 2



def test_find_whole_word(tmp_path: Path) -> None:
    res = search_service.find_in_files(_ws(tmp_path), "foo", whole_word=True)
    # excludes "foobar" and "Foo" inside identifiers handled by word boundary
    flat = [(r["name"], m["line"]) for r in res["results"] for m in r["matches"]]
    assert ("a.ts", 3) not in flat  # `// foobar` line is excluded by \b...\b? foobar has foo at boundary
    assert res["total"] >= 1



def test_find_regex(tmp_path: Path) -> None:
    res = search_service.find_in_files(_ws(tmp_path), r"f\w+o", is_regex=True)
    assert res["ok"] is True
    assert res["total"] >= 1



def test_find_regex_literal_when_disabled(tmp_path: Path) -> None:
    # "f.o" as a literal should NOT match "foo" when regex is off
    res = search_service.find_in_files(_ws(tmp_path), "f.o", is_regex=False)
    assert res["total"] == 0



def test_find_include_glob(tmp_path: Path) -> None:
    res = search_service.find_in_files(_ws(tmp_path), "foo", includes="*.ts")
    names = {r["name"] for r in res["results"]}
    assert names == {"a.ts"}



def test_find_exclude_glob(tmp_path: Path) -> None:
    res = search_service.find_in_files(_ws(tmp_path), "foo", excludes="*.md")
    names = {r["name"] for r in res["results"]}
    assert "README.md" not in names



def test_find_truncates(tmp_path: Path) -> None:
    res = search_service.find_in_files(_ws(tmp_path), "foo", max_results=2)
    assert res["truncated"] is True
    assert res["total"] == 2



def test_find_excludes_noise_dirs(tmp_path: Path) -> None:
    # Non-git workspace: no .gitignore, so only the explicit noise-dir globs
    # keep rg out of node_modules/dist/etc. (fallback prunes via os.walk).
    ws = _ws(tmp_path)
    for noise in ("node_modules/pkg", "dist", ".venv/lib"):
        d = tmp_path / noise
        d.mkdir(parents=True)
        (d / "hit.js").write_text("foo\n", encoding="utf-8")

    res = search_service.find_in_files(ws, "foo")

    assert res["ok"] is True
    paths = {r["rel_path"] for r in res["results"]}
    assert not any(
        p.startswith(("node_modules", "dist", ".venv")) for p in paths
    ), paths
    assert "src/a.ts" in paths  # real sources still found


def test_find_excludes_noise_dirs_python_fallback(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(search_service, "_rg_bin", lambda: None)
    ws = _ws(tmp_path)
    nm = tmp_path / "node_modules" / "pkg"
    nm.mkdir(parents=True)
    (nm / "hit.js").write_text("foo\n", encoding="utf-8")

    res = search_service.find_in_files(ws, "foo")

    paths = {r["rel_path"] for r in res["results"]}
    assert not any(p.startswith("node_modules") for p in paths)


def test_find_cap_terminates_early_across_files(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    for i in range(10):
        (tmp_path / f"many{i}.txt").write_text("foo\n" * 50, encoding="utf-8")

    res = search_service.find_in_files(ws, "foo", max_results=7)

    assert res["ok"] is True
    assert res["truncated"] is True
    assert res["total"] == 7
    assert sum(len(r["matches"]) for r in res["results"]) == 7


def test_find_cancelled_event_aborts(tmp_path: Path) -> None:
    ev = threading.Event()
    ev.set()  # superseded before it starts
    res = search_service.find_in_files(_ws(tmp_path), "foo", cancel_event=ev)
    assert res["ok"] is False
    assert res["error"] == "cancelled"


def test_find_cancelled_event_aborts_python_fallback(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(search_service, "_rg_bin", lambda: None)
    ev = threading.Event()
    ev.set()
    res = search_service.find_in_files(_ws(tmp_path), "foo", cancel_event=ev)
    assert res["ok"] is False
    assert res["error"] == "cancelled"


def test_match_shape(tmp_path: Path) -> None:
    res = search_service.find_in_files(_ws(tmp_path), "Foo", case_sensitive=True)
    m = res["results"][0]["matches"][0]
    assert set(m) == {"line", "col", "end", "text"}
    assert isinstance(m["line"], int) and m["line"] >= 1


# ── replace ──────────────────────────────────────────────────────────────────
def test_replace_empty_query(tmp_path: Path) -> None:
    assert search_service.replace_in_files(_ws(tmp_path), "", "x", ["src/a.ts"])["ok"] is False


def test_replace_literal_counts_and_rewrites(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    res = search_service.replace_in_files(ws, "foo", "bar", ["src/a.ts"])
    assert res["ok"] is True
    assert res["changed"] == [{"rel_path": "src/a.ts", "count": 3}]  # Foo, foo, foobar
    text = (Path(ws) / "src" / "a.ts").read_text(encoding="utf-8")
    assert "barbar" in text  # foobar → barbar


def test_replace_case_insensitive_by_default(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    res = search_service.replace_in_files(ws, "foo", "X", ["src/a.ts"])
    # Foo, foo, foobar's foo → 3 matches case-insensitive
    assert res["total"] == 3


def test_replace_case_sensitive(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    res = search_service.replace_in_files(ws, "Foo", "X", ["src/a.ts"], case_sensitive=True)
    assert res["total"] == 1


def test_replace_whole_word(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    res = search_service.replace_in_files(ws, "foo", "X", ["src/a.ts"], whole_word=True)
    text = (Path(ws) / "src" / "a.ts").read_text(encoding="utf-8")
    assert "foobar" in text  # foobar not touched (word boundary)


def test_replace_regex_backreference(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    (Path(ws) / "src" / "a.ts").write_text("const Foo = 1\n", encoding="utf-8")
    res = search_service.replace_in_files(
        ws, r"const (\w+)", r"let \1", ["src/a.ts"], is_regex=True, case_sensitive=True
    )
    assert res["ok"] is True
    text = (Path(ws) / "src" / "a.ts").read_text(encoding="utf-8")
    assert text == "let Foo = 1\n"


def test_replace_literal_backslash_not_interpreted(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    (Path(ws) / "src" / "a.ts").write_text("foo\n", encoding="utf-8")
    res = search_service.replace_in_files(ws, "foo", r"a\1b", ["src/a.ts"])
    text = (Path(ws) / "src" / "a.ts").read_text(encoding="utf-8")
    assert text == r"a\1b" + "\n"  # literal, no backref


def test_replace_skips_unsafe_path(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    res = search_service.replace_in_files(ws, "foo", "x", ["../escape.ts"])
    assert res["ok"] is True
    assert res["total"] == 0


def test_replace_skips_binary(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    (Path(ws) / "bin.dat").write_bytes(b"\x00\x01foo\xff")
    res = search_service.replace_in_files(ws, "foo", "x", ["bin.dat"])
    assert res["total"] == 0
