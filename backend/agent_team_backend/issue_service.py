"""Cloud issue operations for the Agent-Team backend.

Lists and manages repository issues on the host detected from the `origin`
remote: GitHub via the `gh` CLI, GitLab via the `glab` CLI. Both CLIs infer the
repo from the working directory, so every call runs in ``cwd=workspace_path``
exactly like :mod:`git_service`.

The `gh` and `glab` JSON shapes differ; this module normalizes both into one
provider-agnostic schema so the frontend never branches on provider:

    Issue       { number, title, state, author, labels[], assignees[], updated_at, url }
    IssueDetail = Issue + { body, created_at, comments[] }
    IssueComment{ author, body, created_at }

All I/O is via asyncio subprocesses so the FastAPI event loop is never blocked.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from contextvars import ContextVar
from time import monotonic
from typing import Any

from agent_team_backend.host_shell import run_allowlisted_text

log = logging.getLogger("agent_team_backend.issue_service")

# Issue calls hit the network — allow more headroom than git_service's 15s.
_TIMEOUT = 30.0

_NUM_RE = re.compile(r"^\d+$")

# Only the authenticated Host's fixed public entry installs this policy.
# Context-local state prevents concurrent requests borrowing another caller's
# permissions; legacy Host operations retain their existing behavior.
_public_shell_policy: ContextVar[tuple[str, frozenset[str]] | None] = ContextVar(
    "issue_public_shell_policy", default=None
)
_public_deadline: ContextVar[float | None] = ContextVar("issue_public_deadline", default=None)


# ─── input validation ─────────────────────────────────────────────────────────

def _validate_number(value: Any) -> str | None:
    """Return None if *value* is a valid issue number, else an error string."""
    if not _NUM_RE.match(str(value).strip()):
        return "invalid issue number (expected digits)"
    return None


def _validate_state(value: str) -> str | None:
    if value not in ("open", "closed"):
        return "invalid state (expected 'open' or 'closed')"
    return None


# ─── subprocess helper ────────────────────────────────────────────────────────

async def _run(args: list[str], cwd: str) -> tuple[int, str, str]:
    """Run a CLI command; return (returncode, stdout, stderr).

    A missing executable maps to rc 127 so callers can distinguish
    "CLI not installed" from a normal non-zero exit.
    """
    policy = _public_shell_policy.get()
    if policy is not None:
        mode, commands = policy
        executable = args[0] if args else ""
        allowed = mode == "full" or (mode == "allowlist" and executable in commands) or (
            mode == "denylist" and executable not in commands
        )
        if not allowed:
            raise PermissionError("Issue provider command denied by Execution Policy")
    deadline = _public_deadline.get()
    remaining = deadline - monotonic() if deadline is not None else _TIMEOUT
    if remaining <= 0:
        return 128, "", "Issue request timed out"
    return await run_allowlisted_text(args, cwd, timeout=min(_TIMEOUT, remaining))


async def public_request(
    operation: str, workspace_path: str, arguments: dict[str, Any], policy: dict[str, Any]
) -> dict[str, Any]:
    """Execute one fixed Issue operation with Host-derived executable policy."""
    fields = {
        "provider": (), "list": ("limit",), "get": ("number",),
        "create": ("title", "body"), "comment": ("number", "body"),
        "set_state": ("number", "state"),
    }
    if operation not in fields or set(arguments) - set(fields[operation]):
        raise ValueError("Invalid public Issue operation")
    required = {
        "provider": (), "list": (), "get": ("number",),
        "create": ("title",), "comment": ("number", "body"),
        "set_state": ("number", "state"),
    }
    if any(key not in arguments for key in required[operation]):
        raise ValueError("Missing public Issue argument")
    for key, value in arguments.items():
        if key in ("number", "limit"):
            if type(value) is not int or (key == "number" and value < 0):
                raise ValueError("Invalid public Issue numeric argument")
        elif not isinstance(value, str):
            raise ValueError("Invalid public Issue text argument")
    if operation == "set_state" and arguments["state"] not in ("open", "closed"):
        raise ValueError("Invalid public Issue state")
    if set(policy) != {"mode", "shell"}:
        raise ValueError("Invalid Host Issue execution policy")
    mode, commands = policy.get("mode"), policy.get("shell")
    if mode not in ("full", "allowlist", "denylist") or not isinstance(commands, list) or not all(
        isinstance(command, str) for command in commands
    ):
        raise ValueError("Invalid Host Issue execution policy")
    token = _public_shell_policy.set((mode, frozenset(commands)))
    deadline_token = _public_deadline.set(monotonic() + _TIMEOUT)
    try:
        if operation == "provider":
            return await detect_provider(workspace_path)
        if operation == "list":
            return await list_issues(workspace_path, arguments.get("limit", 30))
        if operation == "get":
            return await get_issue(workspace_path, arguments.get("number"))
        if operation == "create":
            return await create_issue(workspace_path, arguments.get("title", ""), arguments.get("body", ""))
        if operation == "comment":
            return await comment_issue(workspace_path, arguments.get("number"), arguments.get("body", ""))
        return await set_issue_state(workspace_path, arguments.get("number"), arguments.get("state", ""))
    finally:
        _public_deadline.reset(deadline_token)
        _public_shell_policy.reset(token)


# ─── provider detection ───────────────────────────────────────────────────────

def _detect_host(remote_url: str) -> str:
    """Map an origin remote URL to 'github' | 'gitlab' | 'unknown'.

    Handles https, ssh:// and scp-style (git@host:owner/repo) forms. A host
    containing 'gitlab' covers gitlab.com and self-hosted GitLab; GitHub is
    matched on github.com only (custom enterprise domains aren't detectable).
    """
    m = re.search(r"(?:https?://|ssh://)?(?:[^@/]*@)?([^/:]+)", remote_url.strip())
    host = (m.group(1).lower() if m else "")
    if "github.com" in host:
        return "github"
    if "gitlab" in host:
        return "gitlab"
    return "unknown"


async def _host_of(workspace_path: str) -> tuple[str, str]:
    """Return (host, origin_url) for the workspace's origin remote."""
    rc, out, _ = await _run(
        ["git", "config", "--get", "remote.origin.url"], workspace_path
    )
    url = out.strip() if rc == 0 else ""
    return _detect_host(url), url


def _cli_for(host: str) -> str:
    return "gh" if host == "github" else "glab"


async def detect_provider(workspace_path: str) -> dict[str, Any]:
    """Report which issue host this repo uses and whether its CLI is ready.

    Returns: {ok, provider, host, cli_available, authenticated, error}
    where provider ∈ {'github','gitlab','unknown'}.
    """
    if not workspace_path:
        return {"ok": False, "provider": "unknown", "host": "", "cli_available": False, "authenticated": False, "error": "no workspace"}
    host, url = await _host_of(workspace_path)
    if host == "unknown":
        return {"ok": True, "provider": "unknown", "host": "", "cli_available": False, "authenticated": False, "error": ""}
    cli = _cli_for(host)
    rc, _out, err = await _run([cli, "auth", "status"], workspace_path)
    cli_available = rc != 127
    authenticated = rc == 0
    return {
        "ok": True,
        "provider": host,
        "host": url,
        "cli_available": cli_available,
        "authenticated": authenticated,
        "error": "" if authenticated else (err.strip() or f"{cli} not available"),
    }


# ─── normalization ────────────────────────────────────────────────────────────

def _norm_state(value: str) -> str:
    s = (value or "").lower()
    if s in ("open", "opened", "reopened"):
        return "open"
    if s in ("closed", "close"):
        return "closed"
    return s


def _norm_gh_issue(d: dict, detail: bool = False) -> dict[str, Any]:
    author = d.get("author") or {}
    issue = {
        "number": d.get("number"),
        "title": d.get("title") or "",
        "state": _norm_state(d.get("state") or ""),
        "author": author.get("login") or author.get("name") or "",
        "labels": [(l.get("name") or "") for l in (d.get("labels") or [])],
        "assignees": [(a.get("login") or "") for a in (d.get("assignees") or [])],
        "updated_at": d.get("updatedAt") or "",
        "url": d.get("url") or "",
    }
    if detail:
        issue["body"] = d.get("body") or ""
        issue["created_at"] = d.get("createdAt") or ""
        issue["comments"] = [
            {
                "author": ((c.get("author") or {}).get("login") or ""),
                "body": c.get("body") or "",
                "created_at": c.get("createdAt") or "",
            }
            for c in (d.get("comments") or [])
        ]
    return issue


def _norm_glab_issue(d: dict, detail: bool = False) -> dict[str, Any]:
    author = d.get("author") or {}
    issue = {
        # iid is the per-project number used by every glab subcommand (id is global).
        "number": d.get("iid"),
        "title": d.get("title") or "",
        "state": _norm_state(d.get("state") or ""),
        "author": author.get("username") or author.get("name") or "",
        "labels": list(d.get("labels") or []),  # already a flat list of strings
        "assignees": [(a.get("username") or "") for a in (d.get("assignees") or [])],
        "updated_at": d.get("updated_at") or "",
        "url": d.get("web_url") or "",
    }
    if detail:
        issue["body"] = d.get("description") or ""
        issue["created_at"] = d.get("created_at") or ""
        # Comments live under "Notes" (capitalized); drop system activity entries
        # (e.g. "set status to New") which carry system=true.
        notes = d.get("Notes") or d.get("notes") or []
        issue["comments"] = [
            {
                "author": ((n.get("author") or {}).get("username") or ""),
                "body": n.get("body") or "",
                "created_at": n.get("created_at") or "",
            }
            for n in notes
            if not n.get("system")
        ]
    return issue


# ─── public API ───────────────────────────────────────────────────────────────

async def list_issues(workspace_path: str, limit: int = 30) -> dict[str, Any]:
    host, _ = await _host_of(workspace_path)
    if host == "unknown":
        return {"ok": False, "provider": "unknown", "issues": [], "error": "no supported issue host for this repo"}
    n = max(1, min(int(limit or 30), 100))
    if host == "github":
        rc, out, err = await _run(
            ["gh", "issue", "list", "--state", "all", "--limit", str(n),
             "--json", "number,title,state,labels,assignees,updatedAt,author,url"],
            workspace_path,
        )
        norm = _norm_gh_issue
    else:
        rc, out, err = await _run(
            ["glab", "issue", "list", "--all", "--output", "json", "--per-page", str(n)],
            workspace_path,
        )
        norm = _norm_glab_issue
    if rc != 0:
        return {"ok": False, "provider": host, "issues": [], "error": err.strip() or "issue list failed"}
    try:
        raw = json.loads(out or "[]") or []
    except json.JSONDecodeError:
        return {"ok": False, "provider": host, "issues": [], "error": "could not parse issue list output"}
    return {"ok": True, "provider": host, "issues": [norm(d) for d in raw], "error": ""}


async def get_issue(workspace_path: str, number: Any) -> dict[str, Any]:
    err = _validate_number(number)
    if err:
        return {"ok": False, "error": err}
    host, _ = await _host_of(workspace_path)
    if host == "unknown":
        return {"ok": False, "error": "no supported issue host for this repo"}
    num = str(number).strip()
    if host == "github":
        rc, out, e = await _run(
            ["gh", "issue", "view", num,
             "--json", "number,title,body,state,labels,assignees,author,createdAt,url,comments"],
            workspace_path,
        )
        norm = _norm_gh_issue
    else:
        rc, out, e = await _run(
            ["glab", "issue", "view", num, "--output", "json", "--comments"],
            workspace_path,
        )
        norm = _norm_glab_issue
    if rc != 0:
        return {"ok": False, "error": e.strip() or "issue view failed"}
    try:
        raw = json.loads(out or "{}") or {}
    except json.JSONDecodeError:
        return {"ok": False, "error": "could not parse issue view output"}
    return {"ok": True, "provider": host, "issue": norm(raw, detail=True), "error": ""}


async def create_issue(workspace_path: str, title: str, body: str = "") -> dict[str, Any]:
    if not (title or "").strip():
        return {"ok": False, "error": "title is required"}
    host, _ = await _host_of(workspace_path)
    if host == "unknown":
        return {"ok": False, "error": "no supported issue host for this repo"}
    if host == "github":
        args = ["gh", "issue", "create", "--title", title, "--body", body or ""]
    else:
        args = ["glab", "issue", "create", "--title", title, "--description", body or "", "--yes"]
    rc, out, err = await _run(args, workspace_path)
    if rc != 0:
        return {"ok": False, "error": err.strip() or "issue create failed"}
    # Both CLIs print the new issue URL on stdout; surface it best-effort.
    url = ""
    for line in (out or "").splitlines():
        line = line.strip()
        if line.startswith("http"):
            url = line
    return {"ok": True, "url": url, "error": ""}


async def comment_issue(workspace_path: str, number: Any, body: str) -> dict[str, Any]:
    err = _validate_number(number)
    if err:
        return {"ok": False, "error": err}
    if not (body or "").strip():
        return {"ok": False, "error": "comment body is required"}
    host, _ = await _host_of(workspace_path)
    if host == "unknown":
        return {"ok": False, "error": "no supported issue host for this repo"}
    num = str(number).strip()
    if host == "github":
        args = ["gh", "issue", "comment", num, "--body", body]
    else:
        args = ["glab", "issue", "note", num, "--message", body]
    rc, _out, e = await _run(args, workspace_path)
    if rc != 0:
        return {"ok": False, "error": e.strip() or "comment failed"}
    return {"ok": True, "error": ""}


async def set_issue_state(workspace_path: str, number: Any, state: str) -> dict[str, Any]:
    err = _validate_number(number) or _validate_state(state)
    if err:
        return {"ok": False, "error": err}
    host, _ = await _host_of(workspace_path)
    if host == "unknown":
        return {"ok": False, "error": "no supported issue host for this repo"}
    num = str(number).strip()
    sub = "close" if state == "closed" else "reopen"
    cli = _cli_for(host)
    rc, _out, e = await _run([cli, "issue", sub, num], workspace_path)
    if rc != 0:
        return {"ok": False, "error": e.strip() or f"issue {sub} failed"}
    return {"ok": True, "error": ""}
