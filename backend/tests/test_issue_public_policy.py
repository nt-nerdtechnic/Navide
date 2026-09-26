"""Policy boundary tests for the fixed public Issue adapter."""

from __future__ import annotations

import asyncio

import pytest

from agent_team_backend import issue_service


def _runner(calls: list[list[str]], remote: str):
    async def run(args, cwd, *, timeout):
        calls.append(list(args))
        if args[:3] == ["git", "config", "--get"]:
            return 0, remote, ""
        return 0, "[]", ""

    return run


@pytest.mark.asyncio
async def test_github_public_request_allows_git_and_gh(monkeypatch):
    calls: list[list[str]] = []
    monkeypatch.setattr(issue_service, "run_allowlisted_text", _runner(calls, "https://github.com/o/r.git"))
    result = await issue_service.public_request("list", "/ws", {"limit": 5}, {"mode": "allowlist", "shell": ["git", "gh"]})
    assert result["ok"] is True
    assert [call[0] for call in calls] == ["git", "gh"]


@pytest.mark.asyncio
async def test_github_provider_denied_after_git_detection_without_gh_call(monkeypatch):
    calls: list[list[str]] = []
    monkeypatch.setattr(issue_service, "run_allowlisted_text", _runner(calls, "https://github.com/o/r.git"))
    with pytest.raises(PermissionError, match="denied"):
        await issue_service.public_request("provider", "/ws", {}, {"mode": "allowlist", "shell": ["git"]})
    assert [call[0] for call in calls] == ["git"]


@pytest.mark.asyncio
async def test_git_denied_prevents_any_subprocess(monkeypatch):
    calls: list[list[str]] = []
    monkeypatch.setattr(issue_service, "run_allowlisted_text", _runner(calls, "https://github.com/o/r.git"))
    with pytest.raises(PermissionError, match="denied"):
        await issue_service.public_request("provider", "/ws", {}, {"mode": "allowlist", "shell": ["gh"]})
    assert calls == []


@pytest.mark.asyncio
async def test_gitlab_public_request_uses_glab_policy(monkeypatch):
    calls: list[list[str]] = []
    monkeypatch.setattr(issue_service, "run_allowlisted_text", _runner(calls, "https://gitlab.com/o/r.git"))
    result = await issue_service.public_request("list", "/ws", {}, {"mode": "allowlist", "shell": ["git", "glab"]})
    assert result["ok"] is True
    assert [call[0] for call in calls] == ["git", "glab"]


@pytest.mark.asyncio
async def test_public_request_resets_policy_after_exception_and_legacy_is_unaffected(monkeypatch):
    calls: list[list[str]] = []
    monkeypatch.setattr(issue_service, "run_allowlisted_text", _runner(calls, "https://github.com/o/r.git"))
    with pytest.raises(PermissionError):
        await issue_service.public_request("provider", "/ws", {}, {"mode": "allowlist", "shell": []})
    assert await issue_service._run(["git", "config", "--get", "remote.origin.url"], "/ws") == (0, "https://github.com/o/r.git", "")


@pytest.mark.asyncio
async def test_concurrent_policy_contexts_do_not_leak(monkeypatch):
    calls: list[list[str]] = []
    entered = asyncio.Event()
    release = asyncio.Event()

    async def run(args, cwd, *, timeout):
        calls.append(list(args))
        if args[:3] == ["git", "config", "--get"]:
            entered.set()
            await release.wait()
            return 0, "https://github.com/o/r.git", ""
        return 0, "[]", ""

    monkeypatch.setattr(issue_service, "run_allowlisted_text", run)
    allowed = asyncio.create_task(issue_service.public_request("list", "/ws", {}, {"mode": "allowlist", "shell": ["git", "gh"]}))
    denied = asyncio.create_task(issue_service.public_request("list", "/ws", {}, {"mode": "allowlist", "shell": ["git"]}))
    await entered.wait()
    release.set()
    assert (await allowed)["ok"] is True
    with pytest.raises(PermissionError):
        await denied


@pytest.mark.asyncio
async def test_invalid_policy_is_rejected_without_subprocess(monkeypatch):
    calls: list[list[str]] = []
    monkeypatch.setattr(issue_service, "run_allowlisted_text", _runner(calls, "https://github.com/o/r.git"))
    with pytest.raises(ValueError, match="Invalid Host Issue execution policy"):
        await issue_service.public_request("provider", "/ws", {}, {"mode": "allowlist", "shell": "gh"})
    assert calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("operation", "arguments", "policy", "message"),
    [
        ("list", {"limit": True}, {"mode": "allowlist", "shell": ["git"]}, "numeric"),
        ("get", {"number": False}, {"mode": "allowlist", "shell": ["git"]}, "numeric"),
        ("create", {"title": 42}, {"mode": "allowlist", "shell": ["git", "gh"]}, "text"),
        ("comment", {"number": 1, "body": 42}, {"mode": "allowlist", "shell": ["git", "gh"]}, "text"),
        ("set_state", {"number": 1, "state": "pending"}, {"mode": "allowlist", "shell": ["git", "gh"]}, "state"),
        ("provider", {}, {"mode": "allowlist", "shell": ["git"], "extra": True}, "policy"),
    ],
)
async def test_malformed_public_arguments_fail_before_provider_runner(
    monkeypatch, operation, arguments, policy, message
):
    calls: list[list[str]] = []
    monkeypatch.setattr(issue_service, "run_allowlisted_text", _runner(calls, "https://github.com/o/r.git"))
    with pytest.raises(ValueError, match=message):
        await issue_service.public_request(operation, "/ws", arguments, policy)
    assert calls == []
