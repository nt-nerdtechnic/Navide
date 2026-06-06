"""Filesystem service — safe, workspace-rooted directory listing + CRUD.

Backs the Explorer pane. Every operation is resolved relative to
``workspace_path`` and must stay inside it; the internal ``.agent-team`` dir is
protected, and high-noise dirs (node_modules / .git / …) are flagged so the UI
can avoid auto-expanding them. This is NOT a gitignore filter — real on-disk
contents are listed; git status is only an overlay decided elsewhere.
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path
from typing import Any

from .projects import PROJECT_DIR_NAME

# High-noise dirs the UI should not auto-expand (performance, NOT gitignore).
# Mirrors git_watcher._IGNORE_SEGMENTS, plus `.git`.
_NOISE_SEGMENTS = frozenset({
    "node_modules", ".venv", "venv", "__pycache__", "dist", "build", "out",
    "target", ".next", ".nuxt", ".turbo", ".cache", ".mypy_cache",
    ".pytest_cache", ".ruff_cache", ".idea", ".gradle", ".git",
})

_MAX_DIR_ENTRIES = 2_000  # cap to avoid hanging on huge dirs (e.g. node_modules)


class FsError(Exception):
    """Raised on invalid or unsafe filesystem operations."""


def _resolve_safe(workspace_path: str, rel_path: str) -> Path:
    """Resolve ``rel_path`` under the workspace root, rejecting any escape.

    Guards against ``..`` traversal, absolute-path escapes, symlink escapes
    (via ``resolve()``), and operations touching the internal ``.agent-team``
    directory.
    """
    if not workspace_path:
        raise FsError("no workspace selected")
    root = Path(workspace_path).resolve()
    if not root.is_dir():
        raise FsError("workspace not found")

    rel = (rel_path or "").strip().replace("\\", "/").lstrip("/")
    target = (root / rel).resolve()

    if target != root and root not in target.parents:
        raise FsError("path escapes workspace")

    parts = target.relative_to(root).parts
    if parts and parts[0] == PROJECT_DIR_NAME:
        raise FsError("the internal directory is protected")
    return target


def _entry(root: Path, parent: Path, name: str, is_dir: bool) -> dict[str, Any]:
    child = parent / name
    return {
        "name": name,
        "rel_path": str(child.relative_to(root)),
        "is_dir": is_dir,
        "is_hidden": name.startswith("."),
        # Noise dirs are shown as nodes but the UI should not auto-expand them.
        "is_noise": is_dir and name in _NOISE_SEGMENTS,
    }


def list_dir(workspace_path: str, rel_path: str = "", show_hidden: bool = False) -> dict[str, Any]:
    """List a single directory level (lazy; never recurses).

    Dirs first, then files, each alphabetical. ``.agent-team`` is always
    excluded. Dotfiles are excluded unless ``show_hidden`` is True.
    """
    try:
        target = _resolve_safe(workspace_path, rel_path)
    except FsError as exc:
        return {"ok": False, "error": str(exc)}
    if not target.is_dir():
        return {"ok": False, "error": "not a directory"}

    root = Path(workspace_path).resolve()
    entries: list[dict[str, Any]] = []
    truncated = False
    try:
        # os.scandir() caches is_dir() from the readdir result — no extra stat() per entry.
        with os.scandir(target) as it:
            scan = sorted(it, key=lambda e: (not e.is_dir(), e.name.lower()))
        if len(scan) > _MAX_DIR_ENTRIES:
            scan = scan[:_MAX_DIR_ENTRIES]
            truncated = True
        for de in scan:
            name = de.name
            if name == PROJECT_DIR_NAME and target == root:
                continue  # internal dir — never surfaced
            if name.startswith(".") and not show_hidden:
                continue
            entries.append(_entry(root, target, name, de.is_dir()))
    except OSError as exc:
        return {"ok": False, "error": str(exc)}
    result: dict[str, Any] = {
        "ok": True,
        "entries": entries,
        "rel_path": str(target.relative_to(root)) if target != root else "",
    }
    if truncated:
        result["truncated"] = True
    return result


def list_files_flat(
    workspace_path: str,
    query: str = "",
    max_results: int = 100,
) -> dict[str, Any]:
    """Return a flat list of file rel_paths matching *query* (case-insensitive substring).

    Skips noise directories, hidden files, and binary-ish extensions.
    Used by the AI chat @file autocomplete.
    """
    root = Path(workspace_path).resolve()
    if not root.is_dir():
        return {"ok": False, "error": "workspace not found"}
    lower_q = query.lower()
    results: list[str] = []
    _BINARY_EXT = {".png", ".jpg", ".jpeg", ".gif", ".ico", ".svg", ".woff", ".woff2",
                   ".ttf", ".eot", ".mp4", ".mp3", ".zip", ".gz", ".tar", ".pdf", ".bin",
                   ".lock", ".pyc"}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in _NOISE_SEGMENTS and not d.startswith(".")]
        for fn in sorted(filenames):
            if fn.startswith("."):
                continue
            if Path(fn).suffix.lower() in _BINARY_EXT:
                continue
            if lower_q and lower_q not in fn.lower():
                continue
            fp = Path(dirpath) / fn
            try:
                rel = str(fp.relative_to(root))
            except ValueError:
                continue
            results.append(rel)
            if len(results) >= max_results:
                return {"ok": True, "files": results, "truncated": True}
    return {"ok": True, "files": results, "truncated": False}


def glob_files(
    workspace_path: str,
    pattern: str,
    max_results: int = 50,
) -> dict[str, Any]:
    """Return rel_paths matching *pattern* (glob) under the workspace root.

    Noise directories are excluded. At most *max_results* files are returned.
    """
    root = Path(workspace_path).resolve()
    if not root.is_dir():
        return {"ok": False, "error": "workspace not found"}
    if not pattern:
        return {"ok": False, "error": "pattern required"}
    # Reject patterns with .. components or absolute paths to prevent traversal.
    pattern_parts = pattern.replace("\\", "/").split("/")
    if ".." in pattern_parts or pattern.startswith("/") or pattern.startswith("\\"):
        return {"ok": False, "error": "invalid pattern"}

    _BINARY_EXT = {".png", ".jpg", ".jpeg", ".gif", ".ico", ".woff", ".woff2",
                   ".ttf", ".eot", ".mp4", ".mp3", ".zip", ".gz", ".tar", ".pdf",
                   ".bin", ".lock", ".pyc"}
    root_str = str(root) + os.sep
    try:
        matches: list[str] = []
        for fp in sorted(root.glob(pattern)):
            if not fp.is_file():
                continue
            # Verify the resolved path stays inside the workspace (guards symlinks).
            try:
                real = fp.resolve(strict=True)
            except OSError:
                continue
            if not (str(real) == str(root) or str(real).startswith(root_str)):
                continue
            # skip noise dirs inside the match
            parts = fp.relative_to(root).parts
            if any(p in _NOISE_SEGMENTS or p.startswith(".") for p in parts[:-1]):
                continue
            if fp.suffix.lower() in _BINARY_EXT:
                continue
            matches.append(str(fp.relative_to(root)))
            if len(matches) >= max_results:
                return {"ok": True, "files": matches, "truncated": True}
        return {"ok": True, "files": matches, "truncated": False}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def mkdir(workspace_path: str, rel_path: str) -> dict[str, Any]:
    try:
        target = _resolve_safe(workspace_path, rel_path)
        if target == Path(workspace_path).resolve():
            raise FsError("invalid name")
        if target.exists():
            raise FsError("already exists")
        target.mkdir(parents=True, exist_ok=False)
    except (FsError, OSError) as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True}


def create_file(workspace_path: str, rel_path: str, content: str = "") -> dict[str, Any]:
    try:
        target = _resolve_safe(workspace_path, rel_path)
        if target == Path(workspace_path).resolve():
            raise FsError("invalid name")
        if target.exists():
            raise FsError("already exists")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
    except (FsError, OSError) as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True}


def rename(workspace_path: str, src_rel: str, dst_rel: str) -> dict[str, Any]:
    try:
        src = _resolve_safe(workspace_path, src_rel)
        dst = _resolve_safe(workspace_path, dst_rel)
        if src == Path(workspace_path).resolve():
            raise FsError("cannot rename the workspace root")
        if src == dst:
            raise FsError("source and destination are the same path")
        if not src.exists():
            raise FsError("source not found")
        if dst.exists():
            raise FsError("destination already exists")
        dst.parent.mkdir(parents=True, exist_ok=True)
        src.rename(dst)
    except (FsError, OSError) as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True}


_READ_SIZE_LIMIT = 10 * 1024 * 1024  # 10 MB


def read_file(workspace_path: str, rel_path: str) -> dict[str, Any]:
    """Read a UTF-8 text file. Binary / undecodable files return an error."""
    try:
        target = _resolve_safe(workspace_path, rel_path)
        if not target.is_file():
            raise FsError("not a file")
        if target.stat().st_size > _READ_SIZE_LIMIT:
            return {"ok": False, "error": "file too large (> 10 MB)"}
        content = target.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return {"ok": False, "error": "binary or non-UTF-8 file"}
    except (FsError, OSError) as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True, "content": content}


_WRITE_SIZE_LIMIT = 50 * 1024 * 1024  # 50 MB — prevent disk-fill via AI tool


def write_file(workspace_path: str, rel_path: str, content: str) -> dict[str, Any]:
    """Overwrite (or create) a text file with `content`."""
    try:
        target = _resolve_safe(workspace_path, rel_path)
        if target == Path(workspace_path).resolve():
            raise FsError("invalid path")
        if target.exists() and target.is_dir():
            raise FsError("path is a directory")
        encoded = content.encode("utf-8")
        if len(encoded) > _WRITE_SIZE_LIMIT:
            raise FsError(f"content too large ({len(encoded) // 1024} KB; limit 50 MB)")
        target.parent.mkdir(parents=True, exist_ok=True)
        # Atomic write: write to a temp file then rename so a crash can't
        # leave the target half-written/truncated.
        tmp = target.with_suffix(target.suffix + ".tmp")
        try:
            tmp.write_bytes(encoded)
            os.replace(tmp, target)
        except Exception:
            tmp.unlink(missing_ok=True)
            raise
    except (FsError, OSError) as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True}


def delete(workspace_path: str, rel_path: str) -> dict[str, Any]:
    """Delete a file or directory (including non-empty directories)."""
    try:
        target = _resolve_safe(workspace_path, rel_path)
        if target == Path(workspace_path).resolve():
            raise FsError("cannot delete the workspace root")
        if not target.exists():
            raise FsError("not found")
        if target.is_dir():
            shutil.rmtree(target)
        else:
            target.unlink()
    except (FsError, OSError) as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True}
