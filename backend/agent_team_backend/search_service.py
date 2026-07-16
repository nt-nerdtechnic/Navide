"""Search service — find-in-files + regex-aware replace.

Backs the Search window (VS Code "Find in Files"). Searching prefers
``ripgrep`` when available (fast, .gitignore-aware, binary detection) and
otherwise falls back to a pure-Python ``os.walk`` scan so the feature works
with zero external dependency. Replacing re-creates the same match semantics
with Python ``re`` and rewrites each selected file in place, every path guarded
by ``fs_service._resolve_safe``.
"""

from __future__ import annotations

import fnmatch
import json
import os
import re
import shutil
import subprocess
import threading
from pathlib import Path
from typing import Any

from .fs_service import _NOISE_SEGMENTS, FsError, _resolve_safe

_MAX_RESULTS = 2000
_TIMEOUT_S = 30
_REPLACE_SIZE_LIMIT = 10 * 1024 * 1024  # 10 MB — skip files larger than this
_SCAN_SIZE_LIMIT = 5 * 1024 * 1024  # 5 MB — skip files in Python fallback scan


def _rg_bin() -> str | None:
    """Locate the ripgrep binary; GUI-launched backends may lack a full PATH."""
    found = shutil.which("rg")
    if found:
        return found
    for cand in ("/opt/homebrew/bin/rg", "/usr/local/bin/rg", "/usr/bin/rg"):
        if Path(cand).is_file():
            return cand
    return None


def _split_globs(raw: str) -> list[str]:
    return [g.strip() for g in (raw or "").split(",") if g.strip()]


def _build_pattern(
    query: str, is_regex: bool, whole_word: bool, case_sensitive: bool
) -> re.Pattern[str]:
    pat = query if is_regex else re.escape(query)
    if whole_word:
        pat = rf"\b{pat}\b"
    flags = 0 if case_sensitive else re.IGNORECASE
    return re.compile(pat, flags)


def _glob_ok(rel: str, name: str, includes: list[str], excludes: list[str]) -> bool:
    if includes and not any(
        fnmatch.fnmatch(rel, g) or fnmatch.fnmatch(name, g) for g in includes
    ):
        return False
    if any(fnmatch.fnmatch(rel, g) or fnmatch.fnmatch(name, g) for g in excludes):
        return False
    return True


# ── find ─────────────────────────────────────────────────────────────────────
def find_in_files(
    workspace_path: str,
    query: str,
    *,
    is_regex: bool = False,
    case_sensitive: bool = False,
    whole_word: bool = False,
    includes: str = "",
    excludes: str = "",
    max_results: int = _MAX_RESULTS,
    cancel_event: threading.Event | None = None,
) -> dict[str, Any]:
    """Search files under ``workspace_path``, grouped by file.

    ``cancel_event`` (if given) aborts the scan early — set by the caller when
    a newer search supersedes this one.
    """
    if not query:
        return {"ok": True, "results": [], "total": 0, "truncated": False}
    root = Path(workspace_path).resolve()
    if not root.is_dir():
        return {"ok": False, "error": "workspace not found"}
    try:
        pattern = _build_pattern(query, is_regex, whole_word, case_sensitive)
    except re.error as e:
        return {"ok": False, "error": f"Regex error: {e}"}

    rg = _rg_bin()
    if rg:
        return _find_rg(
            rg, root, query, is_regex, case_sensitive, whole_word,
            _split_globs(includes), _split_globs(excludes), max_results,
            cancel_event=cancel_event,
        )
    return _find_python(
        root, pattern, _split_globs(includes), _split_globs(excludes), max_results,
        cancel_event=cancel_event,
    )


def _grouped_append(
    grouped: dict[str, dict[str, Any]], order: list[str], rel: str, match: dict[str, Any]
) -> None:
    if rel not in grouped:
        grouped[rel] = {"rel_path": rel, "name": Path(rel).name, "matches": []}
        order.append(rel)
    grouped[rel]["matches"].append(match)


def _find_rg(
    rg: str,
    root: Path,
    query: str,
    is_regex: bool,
    case_sensitive: bool,
    whole_word: bool,
    includes: list[str],
    excludes: list[str],
    max_results: int,
    cancel_event: threading.Event | None = None,
) -> dict[str, Any]:
    args = [rg, "--json", "-s" if case_sensitive else "-i"]
    if whole_word:
        args.append("-w")
    if not is_regex:
        args.append("-F")
    for g in includes:
        args += ["-g", g]
    for g in excludes:
        args += ["-g", f"!{g}"]
    # Always exclude noise dirs (node_modules / dist / .venv / …): rg only
    # skips them via .gitignore, which non-git workspaces lack. Mirrors the
    # Python fallback's os.walk pruning; .gitignore is still respected.
    for seg in sorted(_NOISE_SEGMENTS):
        args += ["-g", f"!{seg}/"]
    args += ["--", query, str(root)]

    try:
        proc = subprocess.Popen(
            args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
        )
    except OSError as exc:
        return {"ok": False, "error": str(exc)}

    grouped: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    total = 0
    truncated = False
    cancelled = False
    timed_out = threading.Event()

    def _kill_on_timeout() -> None:
        timed_out.set()
        proc.kill()

    # Stream stdout line-by-line so hitting max_results terminates the rg
    # process early instead of buffering its entire output; the timer
    # replaces subprocess.run's timeout.
    timer = threading.Timer(_TIMEOUT_S, _kill_on_timeout)
    timer.start()
    stderr_text = ""
    try:
        assert proc.stdout is not None
        for raw_line in proc.stdout:
            if cancel_event is not None and cancel_event.is_set():
                cancelled = True
                break
            if total >= max_results:
                truncated = True
                break
            line = raw_line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if obj.get("type") != "match":
                continue
            data = obj.get("data", {})
            abs_path = (data.get("path") or {}).get("text")
            if not abs_path:
                continue
            try:
                rel = str(Path(abs_path).resolve().relative_to(root))
            except ValueError:
                rel = abs_path
            line_no = data.get("line_number", 0)
            text = ((data.get("lines") or {}).get("text") or "").rstrip("\n")
            # rg submatches report byte offsets in the UTF-8-encoded line.
            # The frontend (JS) uses character-index `.slice()`, so convert here.
            text_bytes = text.encode("utf-8")
            for sm in data.get("submatches", []):
                if total >= max_results:
                    truncated = True
                    break
                byte_start = sm.get("start", 0)
                byte_end = sm.get("end", 0)
                col_char = len(text_bytes[:byte_start].decode("utf-8", errors="ignore"))
                end_char = col_char + len(
                    text_bytes[byte_start:byte_end].decode("utf-8", errors="ignore")
                )
                _grouped_append(grouped, order, rel, {
                    "line": line_no, "col": col_char, "end": end_char, "text": text,
                })
                total += 1
    finally:
        timer.cancel()
        proc.kill()  # no-op if rg already exited
        try:
            _, stderr_text = proc.communicate()
        except Exception:
            stderr_text = ""

    if cancelled:
        return {"ok": False, "error": "cancelled"}
    if timed_out.is_set():
        if total == 0:
            return {"ok": False, "error": "Search timed out"}
        truncated = True  # partial results beat a timeout with nothing
    elif not truncated and proc.returncode not in (0, 1):  # 0 = matches, 1 = none, 2 = error
        return {"ok": False, "error": (stderr_text or "Search failed").strip()[:500]}

    results = [grouped[r] for r in order if grouped[r]["matches"]]
    return {"ok": True, "results": results, "total": total, "truncated": truncated}


def _find_python(
    root: Path,
    pattern: re.Pattern[str],
    includes: list[str],
    excludes: list[str],
    max_results: int,
    cancel_event: threading.Event | None = None,
) -> dict[str, Any]:
    grouped: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    total = 0
    truncated = False

    for dirpath, dirnames, filenames in os.walk(root):
        # Prune noise dirs (node_modules / .git / …) — matches Explorer behaviour.
        dirnames[:] = [d for d in dirnames if d not in _NOISE_SEGMENTS]
        for fn in sorted(filenames):
            if cancel_event is not None and cancel_event.is_set():
                return {"ok": False, "error": "cancelled"}
            if total >= max_results:
                truncated = True
                break
            fp = Path(dirpath) / fn
            rel = str(fp.relative_to(root))
            if not _glob_ok(rel, fn, includes, excludes):
                continue
            try:
                if fp.stat().st_size > _SCAN_SIZE_LIMIT:
                    continue
                content = fp.read_text(encoding="utf-8")
            except (UnicodeDecodeError, OSError):
                continue
            for i, text in enumerate(content.splitlines(), start=1):
                for m in pattern.finditer(text):
                    if total >= max_results:
                        truncated = True
                        break
                    _grouped_append(grouped, order, rel, {
                        "line": i, "col": m.start(), "end": m.end(), "text": text,
                    })
                    total += 1
                if truncated:
                    break
            if truncated:
                break
        if truncated:
            break

    results = [grouped[r] for r in order if grouped[r]["matches"]]
    return {"ok": True, "results": results, "total": total, "truncated": truncated}


# ── replace ──────────────────────────────────────────────────────────────────
def replace_in_files(
    workspace_path: str,
    query: str,
    replacement: str,
    files: list[str],
    *,
    is_regex: bool = False,
    case_sensitive: bool = False,
    whole_word: bool = False,
) -> dict[str, Any]:
    """Replace matches of ``query`` with ``replacement`` across ``files``.

    Only the explicitly-listed files are touched; each is path-checked, skipped
    if binary/unreadable. In regex mode ``replacement`` supports backreferences
    (``\\1``); otherwise it is inserted literally.
    """
    if not query:
        return {"ok": False, "error": "Query is empty"}
    try:
        pattern = _build_pattern(query, is_regex, whole_word, case_sensitive)
    except re.error as e:
        return {"ok": False, "error": f"Regex error: {e}"}

    repl: Any = replacement if is_regex else (lambda _m: replacement)
    changed: list[dict[str, Any]] = []
    total = 0

    for rel in files:
        try:
            target = _resolve_safe(workspace_path, rel)
        except FsError:
            continue
        if not target.is_file():
            continue
        if target.stat().st_size > _REPLACE_SIZE_LIMIT:
            continue
        try:
            content = target.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        new_content, n = pattern.subn(repl, content)
        if n <= 0:
            continue
        try:
            encoded = new_content.encode("utf-8")
            tmp = target.with_suffix(target.suffix + ".tmp")
            try:
                tmp.write_bytes(encoded)
                os.replace(tmp, target)
            except Exception:
                tmp.unlink(missing_ok=True)
                raise
        except OSError as e:
            return {"ok": False, "error": f"Write failed {rel}: {e}"}
        changed.append({"rel_path": rel, "count": n})
        total += n

    return {"ok": True, "changed": changed, "total": total}
