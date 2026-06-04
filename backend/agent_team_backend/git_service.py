"""Git operations for the Agent-Team backend.

All I/O is performed via asyncio subprocesses so the FastAPI event loop is
never blocked.  No gitpython or other heavy dependency is required.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any

import httpx

log = logging.getLogger("agent_team_backend.git_service")

_MAX_DIFF_CHARS = 8_000  # truncate staged diff before sending to Ollama


# ─── Data classes ─────────────────────────────────────────────────────────────

@dataclass
class GitFileEntry:
    path: str
    status: str  # 'M', 'A', 'D', 'R', '?', etc.


@dataclass
class GitStatus:
    is_git_repo: bool
    branch: str = ""
    remote_branch: str = ""
    ahead: int = 0
    behind: int = 0
    staged: list[GitFileEntry] = field(default_factory=list)
    unstaged: list[GitFileEntry] = field(default_factory=list)
    untracked: list[GitFileEntry] = field(default_factory=list)
    ignored: list[GitFileEntry] = field(default_factory=list)
    operation_in_progress: str = ""  # "", "merge", "rebase", "cherry-pick"


@dataclass
class GitCommit:
    hash: str
    short_hash: str
    message: str
    branches: list[str] = field(default_factory=list)
    parents: list[str] = field(default_factory=list)


@dataclass
class GitSyncResult:
    ok: bool
    pull_output: str = ""
    push_output: str = ""
    error: str = ""


# ─── Input validation helpers ─────────────────────────────────────────────────

_HASH_RE = re.compile(r"^[0-9a-fA-F]{4,40}$")
_REF_RE = re.compile(r"^[A-Za-z0-9._/\-]+$")  # conservative safe ref pattern


def _validate_commit_hash(value: str) -> str | None:
    """Return None if valid, else an error string."""
    if not value or not _HASH_RE.match(value.strip()):
        return "invalid commit hash (expected 4–40 hex chars)"
    return None


def _validate_ref_name(value: str, label: str = "name") -> str | None:
    """Return None if valid, else an error string.

    Rejects values starting with '-' (argv flag smuggling) and chars that
    git itself disallows in ref names.
    """
    v = value.strip()
    if not v:
        return f"{label} is required"
    if v.startswith("-"):
        return f"invalid {label}: must not start with '-'"
    if not _REF_RE.match(v):
        return f"invalid {label}: contains disallowed characters"
    return None


# ─── subprocess helper ────────────────────────────────────────────────────────

async def _run(args: list[str], cwd: str) -> tuple[int, str, str]:
    """Run a git command; return (returncode, stdout, stderr)."""
    try:
        proc = await asyncio.create_subprocess_exec(
            *args,
            cwd=cwd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await proc.communicate()
        return proc.returncode or 0, stdout.decode("utf-8", errors="replace"), stderr.decode("utf-8", errors="replace")
    except FileNotFoundError:
        return 128, "", "git executable not found"
    except Exception as exc:
        return 128, "", str(exc)


async def _run_with_input(args: list[str], cwd: str, stdin_text: str) -> tuple[int, str, str]:
    """Run a git command feeding *stdin_text* to stdin; return (rc, stdout, stderr)."""
    try:
        proc = await asyncio.create_subprocess_exec(
            *args,
            cwd=cwd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await proc.communicate(stdin_text.encode("utf-8"))
        return proc.returncode or 0, stdout.decode("utf-8", errors="replace"), stderr.decode("utf-8", errors="replace")
    except FileNotFoundError:
        return 128, "", "git executable not found"
    except Exception as exc:
        return 128, "", str(exc)


# ─── Public API ───────────────────────────────────────────────────────────────

async def get_status(workspace_path: str, include_ignored: bool = False) -> dict[str, Any]:
    """Return serialisable GitStatus dict for the given workspace.

    When *include_ignored* is True, also surface git-ignored paths (``!!`` in
    porcelain) so the UI can optionally show them — mirrors VS Code's
    "show ignored files" toggle.
    """
    if not workspace_path or not Path(workspace_path).is_dir():
        return asdict(GitStatus(is_git_repo=False))

    # Verify it's a git repo
    rc, _, _ = await _run(["git", "rev-parse", "--is-inside-work-tree"], workspace_path)
    if rc != 0:
        return asdict(GitStatus(is_git_repo=False))

    status = GitStatus(is_git_repo=True)

    # Branch + ahead/behind
    args = ["git", "-c", "core.quotePath=false", "status", "--porcelain=v1", "--branch", "-u"]
    if include_ignored:
        args.append("--ignored")
    rc, out, _ = await _run(args, workspace_path)
    lines = out.splitlines()
    if lines:
        header = lines[0]  # ## main...origin/main [ahead 2, behind 1]
        branch_match = re.match(r"^## (.+?)(?:\.\.\.(.+?))?(?:\s+\[(.+)\])?$", header)
        if branch_match:
            status.branch = branch_match.group(1) or ""
            status.remote_branch = branch_match.group(2) or ""
            tracking_info = branch_match.group(3) or ""
            if m := re.search(r"ahead (\d+)", tracking_info):
                status.ahead = int(m.group(1))
            if m := re.search(r"behind (\d+)", tracking_info):
                status.behind = int(m.group(1))
        for line in lines[1:]:
            if len(line) < 3:
                continue
            xy = line[:2]
            path = line[3:]
            x, y = xy[0], xy[1]
            # Renames/copies render as "orig -> new"; use the new path so that
            # later stage/unstage/discard/diff operations resolve a real file.
            if (x in ("R", "C") or y in ("R", "C")) and " -> " in path:
                path = path.split(" -> ", 1)[1]
            if x == "!" and y == "!":
                status.ignored.append(GitFileEntry(path=path, status="!"))
            elif x == "?" and y == "?":
                status.untracked.append(GitFileEntry(path=path, status="?"))
            else:
                if x != " " and x != "?":
                    status.staged.append(GitFileEntry(path=path, status=x))
                if y != " " and y != "?":
                    status.unstaged.append(GitFileEntry(path=path, status=y))

    # Detect an in-progress operation so the UI can offer an Abort action.
    rc, git_dir_out, _ = await _run(["git", "rev-parse", "--git-dir"], workspace_path)
    if rc == 0 and git_dir_out.strip():
        git_dir = Path(workspace_path) / git_dir_out.strip()
        if (git_dir / "rebase-merge").is_dir() or (git_dir / "rebase-apply").is_dir():
            status.operation_in_progress = "rebase"
        elif (git_dir / "CHERRY_PICK_HEAD").exists():
            status.operation_in_progress = "cherry-pick"
        elif (git_dir / "MERGE_HEAD").exists():
            status.operation_in_progress = "merge"

    return asdict(status)


async def get_log(
    workspace_path: str, n: int = 20, all_branches: bool = False
) -> list[dict[str, Any]]:
    """Return the last *n* commits as serialisable dicts.

    *all_branches* mirrors SourceTree's default view: ``--all`` includes commits
    from every branch/remote/tag (not just HEAD's ancestry) so the frontend can
    render a true multi-lane DAG. ``--topo-order`` keeps children above their
    parents in both modes, which is what the lane layout assumes.
    """
    if not workspace_path or not Path(workspace_path).is_dir():
        return []

    # %H=full hash, %h=short, %s=subject, %D=ref names, %P=parent hashes
    fmt = "%H%x00%h%x00%s%x00%D%x00%P"
    args = ["git", "log", "--topo-order", f"--pretty=format:{fmt}", f"-n{n}"]
    if all_branches:
        args.append("--all")
    rc, out, _ = await _run(args, workspace_path)
    if rc != 0:
        return []

    commits: list[dict[str, Any]] = []
    for line in out.splitlines():
        parts = line.split("\x00")
        if len(parts) < 4:
            continue
        full_hash, short_hash, message, refs = parts[0], parts[1], parts[2], parts[3]
        parent_str = parts[4] if len(parts) > 4 else ""
        branches = [r.strip() for r in refs.split(",") if r.strip()] if refs.strip() else []
        parents = [p for p in parent_str.split() if p]
        commits.append(asdict(GitCommit(
            hash=full_hash,
            short_hash=short_hash,
            message=message,
            branches=branches,
            parents=parents,
        )))
    return commits


async def cherry_pick(workspace_path: str, commit_hash: str) -> dict[str, Any]:
    """Apply *commit_hash* onto the current branch (`git cherry-pick --no-edit`)."""
    if err := _validate_commit_hash(commit_hash):
        return {"ok": False, "error": err}
    rc, out, stderr = await _run(
        ["git", "cherry-pick", "--no-edit", "--", commit_hash.strip()], workspace_path
    )
    if rc != 0:
        return {"ok": False, "error": stderr.strip() or out.strip()}
    hash_match = re.search(r"\[.+ ([0-9a-f]{7,})\]", out)
    return {"ok": True, "hash": hash_match.group(1) if hash_match else ""}


@dataclass
class GitTag:
    name: str
    commit_hash: str
    message: str = ""


async def list_tags(workspace_path: str) -> list[dict[str, Any]]:
    """Return all tags sorted newest-first."""
    rc, out, _ = await _run(
        ["git", "tag", "-l", "--sort=-creatordate", "--format=%(refname:short)\t%(objectname:short)\t%(subject)"],
        workspace_path,
    )
    if rc != 0 or not out.strip():
        return []
    tags: list[dict] = []
    for line in out.splitlines():
        parts = line.split("\t")
        name = parts[0].strip()
        commit_hash = parts[1].strip() if len(parts) > 1 else ""
        message = parts[2].strip() if len(parts) > 2 else ""
        tags.append(asdict(GitTag(name=name, commit_hash=commit_hash, message=message)))
    return tags


async def create_tag(workspace_path: str, name: str, message: str = "", commit_hash: str = "") -> dict[str, Any]:
    """Create an annotated tag (if message given) or lightweight tag."""
    if err := _validate_ref_name(name, "tag name"):
        return {"ok": False, "error": err}
    if commit_hash.strip():
        if err := _validate_commit_hash(commit_hash):
            return {"ok": False, "error": err}
    args = ["git", "tag"]
    if message.strip():
        args += ["-a", "-m", message.strip(), "--", name.strip()]
    else:
        args += ["--", name.strip()]
    if commit_hash.strip():
        args.append(commit_hash.strip())
    rc, _, stderr = await _run(args, workspace_path)
    return {"ok": rc == 0, "error": stderr.strip() if rc != 0 else ""}


async def delete_tag(workspace_path: str, name: str) -> dict[str, Any]:
    """Delete a local tag."""
    if err := _validate_ref_name(name, "tag name"):
        return {"ok": False, "error": err}
    rc, _, stderr = await _run(["git", "tag", "-d", "--", name.strip()], workspace_path)
    return {"ok": rc == 0, "error": stderr.strip() if rc != 0 else ""}


async def file_log(workspace_path: str, filepath: str, n: int = 15) -> list[dict[str, Any]]:
    """Return commits that modified *filepath* (follows renames)."""
    fmt = "%H%x00%h%x00%s%x00%D"
    rc, out, _ = await _run(
        ["git", "log", "--follow", f"--pretty=format:{fmt}", f"-n{n}", "--", filepath],
        workspace_path,
    )
    if rc != 0 or not out.strip():
        return []
    commits: list[dict[str, Any]] = []
    for line in out.splitlines():
        parts = line.split("\x00")
        if len(parts) < 4:
            continue
        full_hash, short_hash, message, refs = parts[0], parts[1], parts[2], parts[3]
        branches = [r.strip() for r in refs.split(",") if r.strip()] if refs.strip() else []
        commits.append(asdict(GitCommit(hash=full_hash, short_hash=short_hash, message=message, branches=branches)))
    return commits


async def resolve_conflict_ours(workspace_path: str, filepath: str) -> dict[str, Any]:
    """Accept 'ours' side in a merge conflict for *filepath*."""
    rc, _, stderr = await _run(["git", "checkout", "--ours", "--", filepath], workspace_path)
    if rc != 0:
        return {"ok": False, "error": stderr.strip()}
    rc2, _, stderr2 = await _run(["git", "add", "--", filepath], workspace_path)
    return {"ok": rc2 == 0, "error": stderr2.strip() if rc2 != 0 else ""}


async def resolve_conflict_theirs(workspace_path: str, filepath: str) -> dict[str, Any]:
    """Accept 'theirs' side in a merge conflict for *filepath*."""
    rc, _, stderr = await _run(["git", "checkout", "--theirs", "--", filepath], workspace_path)
    if rc != 0:
        return {"ok": False, "error": stderr.strip()}
    rc2, _, stderr2 = await _run(["git", "add", "--", filepath], workspace_path)
    return {"ok": rc2 == 0, "error": stderr2.strip() if rc2 != 0 else ""}


async def discard_changes(workspace_path: str, files: list[str]) -> dict[str, Any]:
    """Discard unstaged changes in *files* (git restore -- <files>).
    Untracked files are deleted from disk; tracked files revert to HEAD.
    """
    if not files:
        return {"ok": True}
    # Separate untracked vs tracked: untracked can't use git restore
    status = await get_status(workspace_path)
    untracked_paths = {f["path"] for f in status.get("untracked", [])}
    to_restore = [f for f in files if f not in untracked_paths]
    to_delete = [f for f in files if f in untracked_paths]

    errors: list[str] = []
    if to_restore:
        rc, _, stderr = await _run(["git", "restore", "--"] + to_restore, workspace_path)
        if rc != 0:
            errors.append(stderr.strip())
    if to_delete:
        for fp in to_delete:
            try:
                (Path(workspace_path) / fp).unlink(missing_ok=True)
            except Exception as exc:
                errors.append(str(exc))

    return {"ok": not errors, "error": "; ".join(errors) if errors else ""}


# ─── Worktree management ──────────────────────────────────────────────────────

@dataclass
class GitWorktree:
    path: str
    head: str       # commit hash
    branch: str     # branch name (empty = detached HEAD)
    is_main: bool   # True for the main (linked-from) worktree


async def list_worktrees(workspace_path: str) -> list[dict[str, Any]]:
    """Return all worktrees (including the main working tree)."""
    rc, out, _ = await _run(["git", "worktree", "list", "--porcelain"], workspace_path)
    if rc != 0 or not out.strip():
        return []
    worktrees: list[dict] = []
    current: dict = {}
    first = True
    for line in out.splitlines():
        if line.startswith("worktree "):
            if current:
                worktrees.append(current)
            current = {"path": line[len("worktree "):].strip(), "head": "", "branch": "", "is_main": first}
            first = False
        elif line.startswith("HEAD "):
            current["head"] = line[5:].strip()[:8]  # short hash
        elif line.startswith("branch "):
            current["branch"] = line[7:].strip().removeprefix("refs/heads/")
        elif line.strip() == "":
            if current:
                worktrees.append(current)
                current = {}
                first = False
    if current:
        worktrees.append(current)
    return worktrees


async def add_worktree(
    workspace_path: str, worktree_path: str, branch: str, new_branch: bool = False
) -> dict[str, Any]:
    """Create a new worktree at *worktree_path* checked out at *branch*.

    If *new_branch* is True, creates the branch with ``-b``.
    """
    if not worktree_path.strip():
        return {"ok": False, "error": "worktree path is required"}
    if err := _validate_ref_name(branch, "branch name"):
        return {"ok": False, "error": err}
    args = ["git", "worktree", "add"]
    if new_branch:
        args += ["-b", branch.strip()]
    args.append(worktree_path.strip())
    if not new_branch:
        args.append(branch.strip())
    rc, out, stderr = await _run(args, workspace_path)
    return {"ok": rc == 0, "output": (out + stderr).strip(), "error": stderr.strip() if rc != 0 else ""}


async def remove_worktree(workspace_path: str, worktree_path: str, force: bool = False) -> dict[str, Any]:
    """Remove an existing worktree directory."""
    if not worktree_path.strip():
        return {"ok": False, "error": "worktree path is required"}
    args = ["git", "worktree", "remove"]
    if force:
        args.append("--force")
    args.append(worktree_path.strip())
    rc, _, stderr = await _run(args, workspace_path)
    return {"ok": rc == 0, "error": stderr.strip() if rc != 0 else ""}


# ─── Git config ───────────────────────────────────────────────────────────────

# Explicit allowlist — only keys the UI exposes are permitted.
# A regex is NOT used because it could admit dangerous keys like
# core.sshCommand, diff.external, etc. that git uses to execute arbitrary commands.
_ALLOWED_CONFIG_KEYS: frozenset[str] = frozenset({
    "user.name",
    "user.email",
    "core.autocrlf",
    "core.filemode",
    "pull.rebase",
})


async def get_config(workspace_path: str) -> dict[str, Any]:
    """Return local git config as key→value dict (includes global fallback for user.*)."""
    rc, out, _ = await _run(["git", "config", "--local", "--list"], workspace_path)
    result: dict[str, str] = {}
    if rc == 0:
        for line in out.splitlines():
            if "=" in line:
                k, _, v = line.partition("=")
                result[k.strip()] = v.strip()
    # Merge user.name / user.email from global if not set locally
    for key in ("user.name", "user.email"):
        if key not in result:
            rc2, out2, _ = await _run(["git", "config", "--global", key], workspace_path)
            if rc2 == 0 and out2.strip():
                result[key] = out2.strip() + " (global)"
    return {"ok": True, "config": result}


async def set_config(workspace_path: str, key: str, value: str) -> dict[str, Any]:
    """Set a local git config key to *value*.

    Only keys in *_ALLOWED_CONFIG_KEYS* are accepted to prevent RCE via
    dangerous git config options such as core.sshCommand or diff.external.
    Values starting with ``-`` are also rejected to prevent flag injection.
    """
    if key not in _ALLOWED_CONFIG_KEYS:
        return {"ok": False, "error": f"config key {key!r} is not in the allowed list"}
    if not value:
        return {"ok": False, "error": "config value must not be empty"}
    if value.startswith("-"):
        return {"ok": False, "error": "config value must not start with '-'"}
    rc, _, stderr = await _run(["git", "config", "--local", key, value], workspace_path)
    return {"ok": rc == 0, "error": stderr.strip() if rc != 0 else ""}


# ─── Blame ────────────────────────────────────────────────────────────────────

@dataclass
class BlameEntry:
    short_hash: str
    author: str
    date: str        # YYYY-MM-DD
    line_no: int
    content: str


async def blame_file(workspace_path: str, filepath: str) -> dict[str, Any]:
    """Return per-line blame for *filepath*.

    Uses ``git blame -s`` (short format) for compact output.
    Returns a list of {short_hash, author, date, line_no, content} entries,
    deduplicated by hash so the caller can group by commit.
    """
    if not filepath.strip() or filepath.strip().startswith("-"):
        return {"ok": False, "lines": [], "error": "invalid filepath"}
    rc, out, stderr = await _run(
        ["git", "-c", "core.quotePath=false", "blame", "--porcelain", "--", filepath.strip()],
        workspace_path,
    )
    if rc != 0:
        return {"ok": False, "lines": [], "error": stderr.strip()}

    entries: list[dict] = []
    commit_cache: dict[str, dict] = {}
    current_hash = ""
    current_line_no = 0
    for line in out.splitlines():
        if re.match(r"^[0-9a-f]{40} ", line):
            parts = line.split()
            current_hash = parts[0][:8]
            current_line_no = int(parts[2]) if len(parts) > 2 else 0
            if current_hash not in commit_cache:
                commit_cache[current_hash] = {"author": "", "date": ""}
        elif line.startswith("author "):
            commit_cache.setdefault(current_hash, {})["author"] = line[7:].strip()
        elif line.startswith("author-time "):
            ts = int(line[12:].strip())
            from datetime import datetime, timezone
            commit_cache.setdefault(current_hash, {})["date"] = (
                datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d")
            )
        elif line.startswith("\t"):
            meta = commit_cache.get(current_hash, {})
            entries.append(asdict(BlameEntry(
                short_hash=current_hash,
                author=meta.get("author", ""),
                date=meta.get("date", ""),
                line_no=current_line_no,
                content=line[1:],
            )))
    return {"ok": True, "lines": entries}


async def compare_branches(workspace_path: str, base: str, compare: str) -> dict[str, Any]:
    """Return diff stat summary between *base* and *compare* branches.

    Uses `git diff --stat <base>...<compare>` (three-dot, merge-base diff).
    Returns line counts and a per-file summary.
    """
    if err := _validate_ref_name(base, "base branch"):
        return {"ok": False, "error": err, "stat": "", "files": []}
    if err := _validate_ref_name(compare, "compare branch"):
        return {"ok": False, "error": err, "stat": "", "files": []}
    rc, out, stderr = await _run(
        ["git", "-c", "core.quotePath=false", "diff", "--stat", f"{base.strip()}...{compare.strip()}"],
        workspace_path,
    )
    if rc != 0:
        return {"ok": False, "error": stderr.strip(), "stat": "", "files": []}
    lines = out.strip().splitlines()
    summary = lines[-1] if lines else ""
    files = [ln.strip() for ln in lines[:-1] if ln.strip()]
    return {"ok": True, "stat": summary, "files": files}


async def rebase_on(workspace_path: str, branch: str) -> dict[str, Any]:
    """Rebase current branch onto *branch*.  Returns output or error."""
    if err := _validate_ref_name(branch, "branch name"):
        return {"ok": False, "output": "", "error": err}
    rc, out, stderr = await _run(["git", "rebase", branch.strip()], workspace_path)
    output = (out + stderr).strip()
    if rc != 0:
        # Abort the rebase to leave the repo in a clean state
        await _run(["git", "rebase", "--abort"], workspace_path)
        return {"ok": False, "output": output, "error": "rebase failed — automatically aborted"}
    return {"ok": True, "output": output, "error": ""}


async def restore_file_from_branch(workspace_path: str, branch: str, filepath: str) -> dict[str, Any]:
    """Restore a single file from *branch* into the working tree."""
    if err := _validate_ref_name(branch, "branch name"):
        return {"ok": False, "error": err}
    if not filepath.strip() or filepath.strip().startswith("-"):
        return {"ok": False, "error": "invalid filepath"}
    rc, _, stderr = await _run(
        ["git", "checkout", branch.strip(), "--", filepath.strip()],
        workspace_path,
    )
    return {"ok": rc == 0, "error": stderr.strip() if rc != 0 else ""}


async def clean_untracked(workspace_path: str, dry_run: bool = True) -> dict[str, Any]:
    """Remove untracked files and directories.

    When *dry_run* is True (default) runs `git clean -nfd` and returns the
    list of files that *would* be removed without touching anything.
    When False runs `git clean -fd` to actually delete them.
    """
    flag = "-nfd" if dry_run else "-fd"
    rc, out, stderr = await _run(["git", "clean", flag], workspace_path)
    if rc != 0:
        return {"ok": False, "files": [], "error": stderr.strip()}
    lines = [ln.removeprefix("Would remove ").removeprefix("Removing ").strip()
             for ln in out.splitlines() if ln.strip()]
    return {"ok": True, "files": lines, "dry_run": dry_run}


@dataclass
class GitCommitDetail:
    hash: str
    short_hash: str
    author_name: str
    author_email: str
    date: str          # ISO-8601
    message: str
    body: str
    files: list[str]


async def show_commit(workspace_path: str, commit_hash: str) -> dict[str, Any]:
    """Return full detail for a single commit (author, date, message, files)."""
    if err := _validate_commit_hash(commit_hash):
        return {"ok": False, "error": err}
    h = commit_hash.strip()

    # Step 1: commit metadata
    fmt = "%H%x00%h%x00%an%x00%ae%x00%aI%x00%s%x00%b"
    rc, out, _ = await _run(
        ["git", "log", "-1", f"--pretty=format:{fmt}", h],
        workspace_path,
    )
    if rc != 0:
        return {"ok": False, "error": f"commit {h!r} not found"}
    parts = out.split("\x00", 6)
    if len(parts) < 6:
        return {"ok": False, "error": "unexpected git log output"}
    full_hash = parts[0]; short_hash = parts[1]; author_name = parts[2]
    author_email = parts[3]; date = parts[4]; message = parts[5]
    body = parts[6].strip() if len(parts) > 6 else ""

    # Step 2: changed files (--root handles the initial commit which has no parent)
    rc2, out2, _ = await _run(
        ["git", "-c", "core.quotePath=false", "diff-tree", "--root", "--no-commit-id", "-r", "--name-only", h],
        workspace_path,
    )
    files = [ln.strip() for ln in out2.splitlines() if ln.strip()] if rc2 == 0 else []

    return {"ok": True, **asdict(GitCommitDetail(
        hash=full_hash, short_hash=short_hash,
        author_name=author_name, author_email=author_email,
        date=date, message=message, body=body,
        files=files,
    ))}


async def push_set_upstream(workspace_path: str, branch: str, remote: str = "origin") -> dict[str, Any]:
    """Push branch and set upstream tracking (`git push --set-upstream <remote> <branch>`)."""
    if err := _validate_ref_name(branch, "branch name"):
        return {"ok": False, "output": "", "error": err}
    if err := _validate_ref_name(remote, "remote name"):
        return {"ok": False, "output": "", "error": err}
    rc, out, stderr = await _run(
        ["git", "push", "--set-upstream", remote.strip(), branch.strip()],
        workspace_path,
    )
    return {"ok": rc == 0, "output": (out + stderr).strip(), "error": stderr.strip() if rc != 0 else ""}


async def fetch(workspace_path: str) -> dict[str, Any]:
    """Run `git fetch --prune` to update remote-tracking refs."""
    rc, out, stderr = await _run(["git", "fetch", "--prune"], workspace_path)
    return {"ok": rc == 0, "output": (out + stderr).strip(), "error": stderr.strip() if rc != 0 else ""}


async def pull_only(workspace_path: str) -> dict[str, Any]:
    """Run `git pull` (fast-forward preferred)."""
    rc, out, stderr = await _run(["git", "pull"], workspace_path)
    return {"ok": rc == 0, "output": (out + stderr).strip(), "error": stderr.strip() if rc != 0 else ""}


async def push_only(workspace_path: str) -> dict[str, Any]:
    """Run `git push`."""
    rc, out, stderr = await _run(["git", "push"], workspace_path)
    return {"ok": rc == 0, "output": (out + stderr).strip(), "error": stderr.strip() if rc != 0 else ""}


async def pull_rebase(workspace_path: str) -> dict[str, Any]:
    """Run `git pull --rebase` (replay local commits on top of upstream)."""
    rc, out, stderr = await _run(["git", "pull", "--rebase"], workspace_path)
    return {"ok": rc == 0, "output": (out + stderr).strip(), "error": stderr.strip() if rc != 0 else ""}


async def push_force(workspace_path: str) -> dict[str, Any]:
    """Run `git push --force-with-lease` (safe force: aborts if remote moved)."""
    rc, out, stderr = await _run(["git", "push", "--force-with-lease"], workspace_path)
    return {"ok": rc == 0, "output": (out + stderr).strip(), "error": stderr.strip() if rc != 0 else ""}


async def show_file(workspace_path: str, filepath: str, rev: str = "HEAD") -> dict[str, Any]:
    """Return the content of *filepath* at *rev* (default HEAD), like ``git show rev:path``."""
    rc, out, stderr = await _run(["git", "show", f"{rev}:{filepath}"], workspace_path)
    if rc != 0:
        return {"ok": False, "content": "", "error": stderr.strip() or f"{filepath} not found at {rev}"}
    return {"ok": True, "content": out, "error": ""}


async def diff_file(workspace_path: str, filepath: str, staged: bool = False) -> dict[str, Any]:
    """Return the diff for a single file (staged or working-tree).

    Untracked files are invisible to plain ``git diff``, so for the working-tree
    view we diff them against /dev/null to render the whole file as additions
    (matching how VS Code's "Open Changes" presents a new file).
    """
    if not staged:
        tracked_rc, _, _ = await _run(
            ["git", "ls-files", "--error-unmatch", "--", filepath], workspace_path
        )
        if tracked_rc != 0:
            # Untracked: --no-index exits 1 when the files differ, which is the
            # normal case here, so only treat rc >= 2 as a real failure.
            rc, out, stderr = await _run(
                ["git", "-c", "core.quotePath=false", "diff", "--no-index", "--", os.devnull, filepath], workspace_path
            )
            if rc >= 2:
                return {"ok": False, "diff": "", "error": stderr.strip()}
            return {"ok": True, "diff": out}

    args = ["git", "-c", "core.quotePath=false", "diff"]
    if staged:
        args.append("--staged")
    args += ["--", filepath]
    rc, out, stderr = await _run(args, workspace_path)
    if rc != 0:
        return {"ok": False, "diff": "", "error": stderr.strip()}
    return {"ok": True, "diff": out}


async def apply_patch(
    workspace_path: str, patch: str, reverse: bool = False, cached: bool = True
) -> dict[str, Any]:
    """Apply *patch* to the index via ``git apply``.

    Used for hunk / line-level staging: the frontend builds a single-hunk (or
    selected-lines) unified diff and we apply it to the staging area.
    ``reverse=True`` unstages (applies the patch with -R). ``cached=False``
    applies to the working tree (used for discarding a hunk via reverse).
    """
    if not patch.strip():
        return {"ok": False, "error": "empty patch"}
    args = ["git", "apply", "--recount", "--unidiff-zero", "--whitespace=nowarn"]
    if cached:
        args.append("--cached")
    if reverse:
        args.append("-R")
    args.append("-")
    # git apply requires a trailing newline on the final line.
    payload = patch if patch.endswith("\n") else patch + "\n"
    rc, out, stderr = await _run_with_input(args, workspace_path, payload)
    if rc != 0:
        return {"ok": False, "error": stderr.strip() or out.strip()}
    return {"ok": True}


async def merge_branch(workspace_path: str, branch: str) -> dict[str, Any]:
    """Merge *branch* into the current branch (--no-ff to always create a merge commit)."""
    if err := _validate_ref_name(branch, "branch name"):
        return {"ok": False, "output": "", "error": err}
    rc, out, stderr = await _run(["git", "merge", "--no-ff", "--", branch.strip()], workspace_path)
    output = (out + stderr).strip()
    return {"ok": rc == 0, "output": output, "error": stderr.strip() if rc != 0 else ""}


async def abort_operation(workspace_path: str, op: str) -> dict[str, Any]:
    """Abort an in-progress merge / rebase / cherry-pick."""
    op = (op or "").strip()
    cmd = {
        "merge": ["git", "merge", "--abort"],
        "rebase": ["git", "rebase", "--abort"],
        "cherry-pick": ["git", "cherry-pick", "--abort"],
    }.get(op)
    if cmd is None:
        return {"ok": False, "error": f"invalid operation: {op}"}
    rc, out, stderr = await _run(cmd, workspace_path)
    return {"ok": rc == 0, "error": stderr.strip() if rc != 0 else ""}


async def revert_commit(workspace_path: str, commit_hash: str) -> dict[str, Any]:
    """Create a revert commit for *commit_hash* without interactive editor."""
    if err := _validate_commit_hash(commit_hash):
        return {"ok": False, "error": err}
    rc, out, stderr = await _run(
        ["git", "revert", "--no-edit", commit_hash.strip()], workspace_path
    )
    if rc != 0:
        return {"ok": False, "error": stderr.strip() or out.strip()}
    hash_match = re.search(r"\[.+ ([0-9a-f]{7,})\]", out)
    return {"ok": True, "hash": hash_match.group(1) if hash_match else ""}


@dataclass
class GitRemote:
    name: str
    fetch_url: str
    push_url: str


async def list_remotes(workspace_path: str) -> list[dict[str, Any]]:
    """Return all configured remotes with fetch and push URLs."""
    rc, out, _ = await _run(["git", "remote", "-v"], workspace_path)
    if rc != 0 or not out.strip():
        return []
    seen: dict[str, dict] = {}
    for line in out.splitlines():
        parts = line.split()
        if len(parts) < 3:
            continue
        name, url, kind = parts[0], parts[1], parts[2].strip("()")
        if name not in seen:
            seen[name] = {"name": name, "fetch_url": "", "push_url": ""}
        if kind == "fetch":
            seen[name]["fetch_url"] = url
        elif kind == "push":
            seen[name]["push_url"] = url
    return list(seen.values())


async def add_remote(workspace_path: str, name: str, url: str) -> dict[str, Any]:
    """Add a new remote."""
    if err := _validate_ref_name(name, "remote name"):
        return {"ok": False, "error": err}
    if not url.strip():
        return {"ok": False, "error": "url is required"}
    rc, _, stderr = await _run(["git", "remote", "add", name.strip(), url.strip()], workspace_path)
    return {"ok": rc == 0, "error": stderr.strip() if rc != 0 else ""}


async def remove_remote(workspace_path: str, name: str) -> dict[str, Any]:
    """Remove a remote by name."""
    if err := _validate_ref_name(name, "remote name"):
        return {"ok": False, "error": err}
    rc, _, stderr = await _run(["git", "remote", "remove", name.strip()], workspace_path)
    return {"ok": rc == 0, "error": stderr.strip() if rc != 0 else ""}


@dataclass
class GitBranch:
    name: str
    is_current: bool
    is_remote: bool
    tracking: str = ""


async def list_branches(workspace_path: str) -> dict[str, Any]:
    """Return local branches + current branch; also list remotes."""
    rc, out, _ = await _run(
        ["git", "branch", "-vv", "--format=%(refname:short)\t%(HEAD)\t%(upstream:short)"],
        workspace_path,
    )
    if rc != 0:
        return {"ok": False, "branches": [], "current": ""}

    branches: list[dict] = []
    current = ""
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) < 2:
            continue
        name, head = parts[0].strip(), parts[1].strip()
        tracking = parts[2].strip() if len(parts) > 2 else ""
        is_cur = head == "*"
        if is_cur:
            current = name
        branches.append(asdict(GitBranch(name=name, is_current=is_cur, is_remote=False, tracking=tracking)))
    return {"ok": True, "branches": branches, "current": current}


_INVALID_REF_RE = re.compile(
    r"(^-|\.\.|\x00|@\{|\\|[ ~^:?*\[\]]|/$|\.lock$|\.lock/)"
)


def _validate_branch_name(name: str) -> str | None:
    """Return an error string if *name* is not a safe git ref, else None."""
    if not name or not name.strip():
        return "empty branch name"
    if _INVALID_REF_RE.search(name):
        return f"invalid branch name: {name!r}"
    return None


async def create_branch(workspace_path: str, name: str, switch_to: bool = True) -> dict[str, Any]:
    """Create (and optionally switch to) a new branch."""
    if err := _validate_branch_name(name):
        return {"ok": False, "error": err}
    if switch_to:
        # git checkout -b does not accept -- before <new_branch>; rely on the leading-dash check above.
        rc, _, stderr = await _run(["git", "checkout", "-b", name], workspace_path)
    else:
        rc, _, stderr = await _run(["git", "branch", "--", name], workspace_path)
    return {"ok": rc == 0, "error": stderr.strip() if rc != 0 else ""}


async def switch_branch(workspace_path: str, name: str) -> dict[str, Any]:
    """Switch to an existing local branch."""
    if err := _validate_branch_name(name):
        return {"ok": False, "error": err}
    rc, _, stderr = await _run(["git", "switch", "--", name], workspace_path)
    return {"ok": rc == 0, "error": stderr.strip() if rc != 0 else ""}


async def delete_branch(workspace_path: str, name: str, force: bool = False) -> dict[str, Any]:
    """Delete a local branch (-d or -D)."""
    if err := _validate_branch_name(name):
        return {"ok": False, "error": err}
    flag = "-D" if force else "-d"
    rc, _, stderr = await _run(["git", "branch", flag, "--", name], workspace_path)
    return {"ok": rc == 0, "error": stderr.strip() if rc != 0 else ""}


@dataclass
class GitStashEntry:
    index: int
    ref: str      # e.g. stash@{0}
    message: str


async def stash_list(workspace_path: str) -> list[dict[str, Any]]:
    """Return all stash entries."""
    rc, out, _ = await _run(["git", "stash", "list", "--format=%gd\t%s"], workspace_path)
    if rc != 0 or not out.strip():
        return []
    entries: list[dict] = []
    for i, line in enumerate(out.splitlines()):
        parts = line.split("\t", 1)
        ref = parts[0].strip()
        message = parts[1].strip() if len(parts) > 1 else ""
        entries.append(asdict(GitStashEntry(index=i, ref=ref, message=message)))
    return entries


async def stash_push(
    workspace_path: str, message: str = "", paths: list[str] | None = None
) -> dict[str, Any]:
    """Stash local changes (tracked + untracked).

    With no *paths* the whole working tree is stashed; pass *paths* to stash
    only those pathspecs (``git stash push -- <paths>``).
    """
    args = ["git", "stash", "push", "--include-untracked"]
    if message.strip():
        args += ["-m", message.strip()]
    if paths:
        args += ["--", *paths]
    rc, out, stderr = await _run(args, workspace_path)
    return {"ok": rc == 0, "output": (out + stderr).strip(), "error": stderr.strip() if rc != 0 else ""}


async def stash_pop(workspace_path: str, index: int = 0) -> dict[str, Any]:
    """Apply and remove stash@{index}."""
    rc, out, stderr = await _run(["git", "stash", "pop", f"stash@{{{index}}}"], workspace_path)
    return {"ok": rc == 0, "output": (out + stderr).strip(), "error": stderr.strip() if rc != 0 else ""}


async def stash_apply(workspace_path: str, index: int = 0) -> dict[str, Any]:
    """Apply stash@{index} but keep it in the stash list (unlike pop)."""
    rc, out, stderr = await _run(["git", "stash", "apply", f"stash@{{{index}}}"], workspace_path)
    return {"ok": rc == 0, "output": (out + stderr).strip(), "error": stderr.strip() if rc != 0 else ""}


async def stash_drop(workspace_path: str, index: int) -> dict[str, Any]:
    """Drop stash@{index} without applying."""
    rc, _, stderr = await _run(["git", "stash", "drop", f"stash@{{{index}}}"], workspace_path)
    return {"ok": rc == 0, "error": stderr.strip() if rc != 0 else ""}


async def amend_commit(workspace_path: str, message: str = "") -> dict[str, Any]:
    """Amend the last commit. If *message* is empty, keep the original message."""
    if message.strip():
        args = ["git", "commit", "--amend", "-m", message.strip()]
    else:
        args = ["git", "commit", "--amend", "--no-edit"]
    rc, out, stderr = await _run(args, workspace_path)
    if rc != 0:
        return {"ok": False, "error": stderr.strip() or out.strip()}
    hash_match = re.search(r"\[.+ ([0-9a-f]{7,})\]", out)
    return {"ok": True, "hash": hash_match.group(1) if hash_match else ""}


async def undo_last_commit(workspace_path: str) -> dict[str, Any]:
    """Soft-reset HEAD~1 — files go back to staged, commit is removed."""
    rc, _, stderr = await _run(["git", "reset", "--soft", "HEAD~1"], workspace_path)
    return {"ok": rc == 0, "error": stderr.strip() if rc != 0 else ""}


async def stage_files(workspace_path: str, files: list[str]) -> dict[str, Any]:
    if not files:
        return {"ok": True}
    rc, _, stderr = await _run(["git", "add", "--"] + files, workspace_path)
    return {"ok": rc == 0, "error": stderr.strip() if rc != 0 else ""}


async def unstage_files(workspace_path: str, files: list[str]) -> dict[str, Any]:
    if not files:
        return {"ok": True}
    # Before the first commit there is no HEAD, so `git restore --staged` fails
    # with "could not resolve HEAD". In that case unstage by removing the entries
    # from the index (the working-tree files are kept).
    head_rc, _, _ = await _run(["git", "rev-parse", "--verify", "HEAD"], workspace_path)
    if head_rc == 0:
        rc, _, stderr = await _run(["git", "restore", "--staged", "--"] + files, workspace_path)
    else:
        # -f is required: `git rm --cached` otherwise refuses files whose staged
        # content differs from the working tree (e.g. a log file the app keeps
        # writing to). --cached keeps the working-tree file; we only drop the
        # index entry, so forcing is safe here.
        rc, _, stderr = await _run(["git", "rm", "--cached", "-f", "--quiet", "--"] + files, workspace_path)
    return {"ok": rc == 0, "error": stderr.strip() if rc != 0 else ""}


async def stage_all(workspace_path: str) -> dict[str, Any]:
    rc, _, stderr = await _run(["git", "add", "-A"], workspace_path)
    return {"ok": rc == 0, "error": stderr.strip() if rc != 0 else ""}


async def commit(workspace_path: str, message: str) -> dict[str, Any]:
    if not message.strip():
        return {"ok": False, "error": "empty commit message"}
    rc, out, stderr = await _run(["git", "commit", "-m", message], workspace_path)
    if rc != 0:
        return {"ok": False, "error": stderr.strip() or out.strip()}
    # Extract new commit hash from "git commit" output
    hash_match = re.search(r"\[.+ ([0-9a-f]{7,})\]", out)
    return {"ok": True, "hash": hash_match.group(1) if hash_match else ""}


async def sync(workspace_path: str) -> dict[str, Any]:
    """Pull (rebase) then push.  Returns stdout/stderr for both steps."""
    pull_rc, pull_out, pull_err = await _run(
        ["git", "pull", "--rebase"], workspace_path
    )
    pull_output = (pull_out + pull_err).strip()
    if pull_rc != 0:
        return asdict(GitSyncResult(ok=False, pull_output=pull_output, error="pull failed"))

    push_rc, push_out, push_err = await _run(["git", "push"], workspace_path)
    push_output = (push_out + push_err).strip()
    if push_rc != 0:
        return asdict(GitSyncResult(ok=False, pull_output=pull_output, push_output=push_output, error="push failed"))

    return asdict(GitSyncResult(ok=True, pull_output=pull_output, push_output=push_output))


async def get_staged_diff(workspace_path: str) -> str:
    """Return the staged diff, truncated to _MAX_DIFF_CHARS."""
    rc, out, _ = await _run(["git", "diff", "--staged"], workspace_path)
    if rc != 0 or not out.strip():
        return ""
    return out[:_MAX_DIFF_CHARS]


async def get_working_diff(workspace_path: str) -> str:
    """Return the working-tree diff (unstaged tracked changes + untracked files).

    Untracked files are invisible to plain ``git diff``, so each is diffed against
    /dev/null to render the whole file as additions (matching ``diff_file``). Used
    as a fallback for commit-message generation when nothing is staged.
    """
    parts: list[str] = []
    rc, out, _ = await _run(["git", "-c", "core.quotePath=false", "diff"], workspace_path)
    if rc == 0 and out.strip():
        parts.append(out)

    rc, out, _ = await _run(["git", "ls-files", "--others", "--exclude-standard"], workspace_path)
    if rc == 0:
        for filepath in out.splitlines():
            filepath = filepath.strip()
            if not filepath:
                continue
            # --no-index exits 1 when the files differ (the normal case here), so
            # only treat rc >= 2 as a real failure.
            drc, dout, _ = await _run(
                ["git", "-c", "core.quotePath=false", "diff", "--no-index", "--", os.devnull, filepath],
                workspace_path,
            )
            if drc < 2 and dout.strip():
                parts.append(dout)
            if sum(len(p) for p in parts) >= _MAX_DIFF_CHARS:
                break

    return "\n".join(parts)[:_MAX_DIFF_CHARS]


_NODE_GITIGNORE = """\
node_modules/
dist/
.env
.env.local
*.log
.DS_Store
"""

_PYTHON_GITIGNORE = """\
__pycache__/
*.pyc
*.pyo
.venv/
venv/
dist/
build/
*.egg-info/
.env
.DS_Store
"""

_GENERIC_GITIGNORE = """\
.DS_Store
*.log
.env
.env.local
"""


def _detect_gitignore_template(workspace_path: str) -> str:
    """Return an appropriate .gitignore based on project files present.

    Full-stack projects (e.g. a Node frontend + Python backend) match more than
    one stack, so the templates are composed rather than picked exclusively —
    otherwise the second stack's artifacts (e.g. __pycache__/) leak into git.
    """
    root = Path(workspace_path)
    parts: list[str] = []
    if (root / "package.json").exists():
        parts.append(_NODE_GITIGNORE)
    if any(root.glob("*.py")) or (root / "pyproject.toml").exists() or (root / "requirements.txt").exists():
        parts.append(_PYTHON_GITIGNORE)
    return "\n".join(parts) if parts else _GENERIC_GITIGNORE


async def init_repo(workspace_path: str, create_gitignore: bool = True) -> dict[str, Any]:
    """Run `git init` in *workspace_path*.

    Optionally writes a starter .gitignore (auto-detected from project type)
    unless one already exists.  Returns ``{"ok": bool, "error": str}``.
    """
    if not workspace_path or not Path(workspace_path).is_dir():
        return {"ok": False, "error": "invalid workspace path"}

    rc, out, stderr = await _run(["git", "init"], workspace_path)
    if rc != 0:
        return {"ok": False, "error": stderr.strip() or out.strip()}

    gitignore_created = False
    if create_gitignore:
        gi_path = Path(workspace_path) / ".gitignore"
        if not gi_path.exists():
            gi_path.write_text(_detect_gitignore_template(workspace_path), encoding="utf-8")
            gitignore_created = True

    return {"ok": True, "gitignore_created": gitignore_created}


async def clone_repo(url: str, target_dir: str) -> dict[str, Any]:
    """Clone *url* into *target_dir*.

    Returns ``{"ok": bool, "path": str, "error": str}`` where ``path`` is the
    cloned working directory on success (so the UI can open it as a workspace).
    """
    url = (url or "").strip()
    target = (target_dir or "").strip()
    if not url or url.startswith("-"):
        return {"ok": False, "path": "", "error": "invalid repository URL"}
    if not target:
        return {"ok": False, "path": "", "error": "target directory is required"}
    dest = Path(target)
    if dest.exists() and any(dest.iterdir()):
        return {"ok": False, "path": "", "error": "target directory is not empty"}
    dest.parent.mkdir(parents=True, exist_ok=True)
    # Run from the parent dir so a relative/new target works; pass paths via `--`.
    rc, out, stderr = await _run(
        ["git", "clone", "--", url, str(dest)], str(dest.parent)
    )
    if rc != 0:
        return {"ok": False, "path": "", "error": stderr.strip() or out.strip()}
    return {"ok": True, "path": str(dest)}


async def _resolve_git_dir(workspace_path: str) -> Path | None:
    """Absolute path to the repo's .git dir, or None if not a repo."""
    rc, out, _ = await _run(["git", "rev-parse", "--git-dir"], workspace_path)
    if rc != 0 or not out.strip():
        return None
    p = Path(out.strip())
    return p if p.is_absolute() else Path(workspace_path) / p


async def _resolve_global_excludes(workspace_path: str) -> Path:
    """Path to git's global excludes file (core.excludesFile), or its default.

    Default per git: $XDG_CONFIG_HOME/git/ignore, falling back to
    ~/.config/git/ignore.
    """
    rc, out, _ = await _run(["git", "config", "--global", "core.excludesFile"], workspace_path)
    if rc == 0 and out.strip():
        return Path(os.path.expanduser(out.strip()))
    xdg = os.environ.get("XDG_CONFIG_HOME")
    base = Path(xdg) if xdg else Path.home() / ".config"
    return base / "git" / "ignore"


def _append_ignore_pattern(file_path: Path, pattern: str) -> bool:
    """Append *pattern* to *file_path* (creating it + parents) unless already
    present. Returns True when a line was actually written."""
    existing = file_path.read_text(encoding="utf-8") if file_path.exists() else ""
    if pattern in {ln.strip() for ln in existing.splitlines()}:
        return False
    file_path.parent.mkdir(parents=True, exist_ok=True)
    prefix = "" if (not existing or existing.endswith("\n")) else "\n"
    file_path.write_text(existing + prefix + pattern + "\n", encoding="utf-8")
    return True


async def add_to_gitignore(
    workspace_path: str,
    pattern: str,
    target: str = "project",
    untrack: bool = True,
) -> dict[str, Any]:
    """Add *pattern* to an ignore file and (by default) untrack matching files.

    *target* selects which of git's four ignore sources to write:
      - ``project`` → ``<workspace>/.gitignore`` (committed, repo-wide)
      - ``nested``  → ``.gitignore`` inside the pattern's own directory
      - ``local``   → ``.git/info/exclude`` (repo-local, not committed)
      - ``global``  → ``core.excludesFile`` (all repos for this user)

    A freshly-added rule has no effect on files already in the index, so unless
    *untrack* is False any tracked path matching *pattern* is removed from the
    index with ``git rm --cached`` (the file stays on disk). This is what makes
    "Add to .gitignore" actually hide an already-committed file.

    Returns ``{"ok", "target_file", "written", "untracked": [paths]}``.
    """
    pattern = (pattern or "").strip()
    if not pattern:
        return {"ok": False, "error": "pattern is required"}
    if not workspace_path or not Path(workspace_path).is_dir():
        return {"ok": False, "error": "invalid workspace path"}

    write_pattern = pattern
    if target == "project":
        dest = Path(workspace_path) / ".gitignore"
    elif target == "nested":
        rel = pattern.rstrip("/")
        if Path(rel).is_absolute() or ".." in Path(rel).parts:
            return {"ok": False, "error": "pattern escapes workspace"}
        ws_real = Path(workspace_path).resolve()
        dest = ((Path(workspace_path) / rel).parent / ".gitignore").resolve()
        try:
            dest.relative_to(ws_real)
        except ValueError:
            return {"ok": False, "error": "pattern escapes workspace"}
        write_pattern = Path(rel).name + ("/" if pattern.endswith("/") else "")
    elif target == "local":
        git_dir = await _resolve_git_dir(workspace_path)
        if git_dir is None:
            return {"ok": False, "error": "not a git repository"}
        dest = git_dir / "info" / "exclude"
    elif target == "global":
        dest = await _resolve_global_excludes(workspace_path)
    else:
        return {"ok": False, "error": f"unknown target: {target}"}

    written = _append_ignore_pattern(dest, write_pattern)

    untracked: list[str] = []
    if untrack:
        path = pattern.rstrip("/")
        rc, out, _ = await _run(["git", "ls-files", "-z", "--", path], workspace_path)
        if rc == 0 and out:
            tracked = [p for p in out.split("\0") if p]
            if tracked:
                # -f: tracked files whose staged content differs from disk/HEAD
                # otherwise make `git rm --cached` refuse.
                await _run(
                    ["git", "rm", "--cached", "-r", "-f", "--quiet", "--", path],
                    workspace_path,
                )
                untracked = tracked

    return {"ok": True, "target_file": str(dest), "written": written, "untracked": untracked}


async def check_ignore(workspace_path: str, filepath: str) -> dict[str, Any]:
    """Explain why *filepath* is (or isn't) ignored — git's own debug tool.

    Runs ``git check-ignore -v --no-index`` so the matching rule is reported
    even for a path that is currently tracked (``--no-index`` evaluates rules
    irrespective of the index). Also reports whether the path is tracked, since
    a tracked file keeps showing up despite a matching rule.

    Returns ``{"ok", "ignored", "tracked", "source", "line", "pattern"}``.
    """
    filepath = (filepath or "").strip()
    if not filepath:
        return {"ok": False, "error": "filepath is required"}
    if not workspace_path or not Path(workspace_path).is_dir():
        return {"ok": False, "error": "invalid workspace path"}

    ls_rc, ls_out, _ = await _run(["git", "ls-files", "--", filepath], workspace_path)
    tracked = ls_rc == 0 and bool(ls_out.strip())

    rc, out, _ = await _run(
        ["git", "check-ignore", "-v", "--no-index", "--", filepath], workspace_path
    )
    if rc == 0 and out.strip():
        first = out.strip().splitlines()[0]
        # "<source>:<line>:<pattern>\t<path>"
        m = re.match(r"^(.*?):(\d+):(.*?)\t", first)
        if m:
            return {
                "ok": True, "ignored": True, "tracked": tracked,
                "source": m.group(1), "line": int(m.group(2)), "pattern": m.group(3),
            }
        return {"ok": True, "ignored": True, "tracked": tracked, "source": "", "line": 0, "pattern": ""}
    # rc == 1: not ignored. rc == 128: error (treat as not ignored).
    return {"ok": True, "ignored": False, "tracked": tracked, "source": "", "line": 0, "pattern": ""}


async def generate_commit_message(workspace_path: str, ollama_url: str, model: str = "llama3.2") -> dict[str, Any]:
    """Generate a commit message from the staged diff using Ollama.

    Mirrors VS Code/Cursor: if anything is staged, the message targets just the
    staged diff; otherwise it falls back to the whole working tree (unstaged
    tracked changes + untracked files).
    """
    diff = await get_staged_diff(workspace_path)
    if not diff:
        diff = await get_working_diff(workspace_path)
    if not diff:
        return {"ok": False, "error": "no changes", "message": ""}

    system = (
        "You are a git commit message writer. "
        "Given a git diff, output ONLY a single commit message line (no explanation, no quotes). "
        "Rules: imperative mood, ≤72 chars, Conventional Commits prefix "
        "(feat/fix/refactor/docs/test/chore/style/perf), e.g. 'feat: add user avatar upload'."
    )
    prompt = f"Write a commit message for this diff:\n\n{diff}"

    try:
        async with httpx.AsyncClient(base_url=ollama_url.rstrip("/"), timeout=30.0) as client:
            resp = await client.post("/api/generate", json={
                "model": model,
                "system": system,
                "prompt": prompt,
                "stream": False,
                "options": {"temperature": 0.2, "num_predict": 80},
            })
            resp.raise_for_status()
            data = resp.json()
            message = (data.get("response") or "").strip().strip('"').strip("'")
            if not message:
                return {"ok": False, "error": "empty response from Ollama", "message": ""}
            return {"ok": True, "message": message}
    except Exception as exc:
        log.warning("generate_commit_message failed: %s", exc)
        return {"ok": False, "error": str(exc), "message": ""}
