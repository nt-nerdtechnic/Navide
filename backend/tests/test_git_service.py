"""Tests for git_service.py — all operations run in tmp_path git repos."""
from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from agent_team_backend import git_service


# ── helpers ────────────────────────────────────────────────────────────────────

def init_repo(path: Path) -> None:
    """Create a minimal git repo with one initial commit."""
    subprocess.run(["git", "init"], cwd=path, check=True, capture_output=True)
    subprocess.run(["git", "config", "user.email", "test@test.com"], cwd=path, check=True, capture_output=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=path, check=True, capture_output=True)
    (path / "README.md").write_text("# test")
    subprocess.run(["git", "add", "-A"], cwd=path, check=True, capture_output=True)
    subprocess.run(["git", "commit", "-m", "init"], cwd=path, check=True, capture_output=True)


# ── get_status ─────────────────────────────────────────────────────────────────

class TestGetStatus:
    @pytest.mark.asyncio
    async def test_non_git_dir(self, tmp_path):
        result = await git_service.get_status(str(tmp_path))
        assert result["is_git_repo"] is False

    @pytest.mark.asyncio
    async def test_empty_path(self):
        result = await git_service.get_status("")
        assert result["is_git_repo"] is False

    @pytest.mark.asyncio
    async def test_clean_repo(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.get_status(str(tmp_path))
        assert result["is_git_repo"] is True
        assert result["branch"] != ""
        assert result["staged"] == []
        assert result["unstaged"] == []
        assert result["untracked"] == []

    @pytest.mark.asyncio
    async def test_detects_untracked(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / "new_file.txt").write_text("hello")
        result = await git_service.get_status(str(tmp_path))
        assert any(f["path"] == "new_file.txt" for f in result["untracked"])

    @pytest.mark.asyncio
    async def test_detects_staged(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / "staged.txt").write_text("staged")
        subprocess.run(["git", "add", "staged.txt"], cwd=tmp_path, check=True, capture_output=True)
        result = await git_service.get_status(str(tmp_path))
        assert any(f["path"] == "staged.txt" for f in result["staged"])

    @pytest.mark.asyncio
    async def test_detects_modified_unstaged(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / "README.md").write_text("changed")
        result = await git_service.get_status(str(tmp_path))
        assert any(f["path"] == "README.md" for f in result["unstaged"])


# ── get_log ────────────────────────────────────────────────────────────────────

class TestGetLog:
    @pytest.mark.asyncio
    async def test_returns_commits(self, tmp_path):
        init_repo(tmp_path)
        commits = await git_service.get_log(str(tmp_path), n=5)
        assert len(commits) == 1
        assert commits[0]["message"] == "init"
        assert commits[0]["short_hash"] != ""
        assert len(commits[0]["hash"]) == 40

    @pytest.mark.asyncio
    async def test_empty_for_non_git(self, tmp_path):
        commits = await git_service.get_log(str(tmp_path))
        assert commits == []

    @pytest.mark.asyncio
    async def test_multiple_commits(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / "a.txt").write_text("a")
        subprocess.run(["git", "add", "-A"], cwd=tmp_path, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-m", "second"], cwd=tmp_path, check=True, capture_output=True)
        commits = await git_service.get_log(str(tmp_path), n=10)
        assert len(commits) == 2
        assert commits[0]["message"] == "second"


# ── stage / unstage ────────────────────────────────────────────────────────────

class TestStageUnstage:
    @pytest.mark.asyncio
    async def test_stage_file(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / "new.txt").write_text("new")
        result = await git_service.stage_files(str(tmp_path), ["new.txt"])
        assert result["ok"] is True
        status = await git_service.get_status(str(tmp_path))
        assert any(f["path"] == "new.txt" for f in status["staged"])

    @pytest.mark.asyncio
    async def test_unstage_file(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / "new.txt").write_text("new")
        subprocess.run(["git", "add", "new.txt"], cwd=tmp_path, check=True, capture_output=True)
        result = await git_service.unstage_files(str(tmp_path), ["new.txt"])
        assert result["ok"] is True
        status = await git_service.get_status(str(tmp_path))
        assert not any(f["path"] == "new.txt" for f in status["staged"])

    @pytest.mark.asyncio
    async def test_unstage_before_first_commit(self, tmp_path):
        # No HEAD yet: `git restore --staged` would fail, so unstage must fall
        # back to removing entries from the index.
        subprocess.run(["git", "init"], cwd=tmp_path, check=True, capture_output=True)
        (tmp_path / "new.txt").write_text("new")
        subprocess.run(["git", "add", "new.txt"], cwd=tmp_path, check=True, capture_output=True)
        result = await git_service.unstage_files(str(tmp_path), ["new.txt"])
        assert result["ok"] is True
        status = await git_service.get_status(str(tmp_path))
        assert not any(f["path"] == "new.txt" for f in status["staged"])
        assert any(f["path"] == "new.txt" for f in status["untracked"])

    @pytest.mark.asyncio
    async def test_unstage_before_first_commit_modified_after_staging(self, tmp_path):
        # No HEAD AND the staged file was changed on disk after staging (like a
        # log file the app keeps writing). `git rm --cached` without -f refuses
        # this, so unstage must force it while keeping the working-tree file.
        subprocess.run(["git", "init"], cwd=tmp_path, check=True, capture_output=True)
        f = tmp_path / "history.jsonl"
        f.write_text("v1")
        subprocess.run(["git", "add", "history.jsonl"], cwd=tmp_path, check=True, capture_output=True)
        f.write_text("v2-modified-after-staging")  # staged content != working tree
        result = await git_service.unstage_files(str(tmp_path), ["history.jsonl"])
        assert result["ok"] is True, result
        status = await git_service.get_status(str(tmp_path))
        assert not any(x["path"] == "history.jsonl" for x in status["staged"])
        assert f.read_text() == "v2-modified-after-staging"  # working file preserved

    @pytest.mark.asyncio
    async def test_status_rename_uses_new_path(self, tmp_path):
        # A staged rename renders as "old -> new"; status must expose the new
        # path (a real file) rather than the literal "old -> new" string.
        init_repo(tmp_path)
        (tmp_path / "old.txt").write_text("x\n" * 5)
        subprocess.run(["git", "add", "-A"], cwd=tmp_path, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-m", "add"], cwd=tmp_path, check=True, capture_output=True)
        subprocess.run(["git", "mv", "old.txt", "new.txt"], cwd=tmp_path, check=True, capture_output=True)
        status = await git_service.get_status(str(tmp_path))
        staged_paths = [f["path"] for f in status["staged"]]
        assert "new.txt" in staged_paths
        assert all("->" not in p for p in staged_paths)
        # And the resolved path can actually be unstaged.
        result = await git_service.unstage_files(str(tmp_path), ["new.txt"])
        assert result["ok"] is True, result

    @pytest.mark.asyncio
    async def test_status_non_ascii_path_unquoted(self, tmp_path):
        # Non-ASCII paths must be returned as raw UTF-8, not git's quoted/octal form.
        init_repo(tmp_path)
        (tmp_path / "中文檔案.txt").write_text("hi")
        subprocess.run(["git", "add", "-A"], cwd=tmp_path, check=True, capture_output=True)
        status = await git_service.get_status(str(tmp_path))
        paths = [f["path"] for f in status["staged"]]
        assert "中文檔案.txt" in paths
        assert all('"' not in p and "\\" not in p for p in paths)

    @pytest.mark.asyncio
    async def test_stage_all(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / "a.txt").write_text("a")
        (tmp_path / "b.txt").write_text("b")
        result = await git_service.stage_all(str(tmp_path))
        assert result["ok"] is True
        status = await git_service.get_status(str(tmp_path))
        paths = {f["path"] for f in status["staged"]}
        assert "a.txt" in paths and "b.txt" in paths

    @pytest.mark.asyncio
    async def test_stage_empty_list(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.stage_files(str(tmp_path), [])
        assert result["ok"] is True


# ── commit ─────────────────────────────────────────────────────────────────────

class TestCommit:
    @pytest.mark.asyncio
    async def test_commit_success(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / "change.txt").write_text("change")
        await git_service.stage_all(str(tmp_path))
        result = await git_service.commit(str(tmp_path), "feat: add change")
        assert result["ok"] is True
        assert result["hash"] != ""

    @pytest.mark.asyncio
    async def test_commit_nothing_staged(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.commit(str(tmp_path), "should fail")
        assert result["ok"] is False

    @pytest.mark.asyncio
    async def test_commit_empty_message(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.commit(str(tmp_path), "")
        assert result["ok"] is False


# ── init_repo ─────────────────────────────────────────────────────────────────

class TestInitRepo:
    @pytest.mark.asyncio
    async def test_init_creates_git_dir(self, tmp_path):
        result = await git_service.init_repo(str(tmp_path))
        assert result["ok"] is True
        assert (tmp_path / ".git").is_dir()

    @pytest.mark.asyncio
    async def test_init_creates_gitignore_by_default(self, tmp_path):
        result = await git_service.init_repo(str(tmp_path))
        assert result["ok"] is True
        assert result["gitignore_created"] is True
        assert (tmp_path / ".gitignore").exists()

    @pytest.mark.asyncio
    async def test_init_no_gitignore_when_disabled(self, tmp_path):
        result = await git_service.init_repo(str(tmp_path), create_gitignore=False)
        assert result["ok"] is True
        assert not (tmp_path / ".gitignore").exists()

    @pytest.mark.asyncio
    async def test_init_skips_existing_gitignore(self, tmp_path):
        existing = "# custom rules\n"
        (tmp_path / ".gitignore").write_text(existing)
        result = await git_service.init_repo(str(tmp_path))
        assert result["ok"] is True
        assert result["gitignore_created"] is False
        assert (tmp_path / ".gitignore").read_text() == existing

    @pytest.mark.asyncio
    async def test_init_detects_node_project(self, tmp_path):
        (tmp_path / "package.json").write_text("{}")
        await git_service.init_repo(str(tmp_path))
        content = (tmp_path / ".gitignore").read_text()
        assert "node_modules/" in content

    @pytest.mark.asyncio
    async def test_init_detects_python_project(self, tmp_path):
        (tmp_path / "requirements.txt").write_text("fastapi\n")
        await git_service.init_repo(str(tmp_path))
        content = (tmp_path / ".gitignore").read_text()
        assert "__pycache__/" in content

    @pytest.mark.asyncio
    async def test_init_fullstack_includes_both_node_and_python(self, tmp_path):
        (tmp_path / "package.json").write_text("{}")
        (tmp_path / "requirements.txt").write_text("django\n")
        await git_service.init_repo(str(tmp_path))
        content = (tmp_path / ".gitignore").read_text()
        assert "node_modules/" in content
        assert "__pycache__/" in content

    @pytest.mark.asyncio
    async def test_init_invalid_path(self):
        result = await git_service.init_repo("/nonexistent/path/xyz")
        assert result["ok"] is False

    @pytest.mark.asyncio
    async def test_status_is_git_repo_after_init(self, tmp_path):
        await git_service.init_repo(str(tmp_path))
        status = await git_service.get_status(str(tmp_path))
        assert status["is_git_repo"] is True


# ── discard_changes ───────────────────────────────────────────────────────────

class TestDiscardChanges:
    @pytest.mark.asyncio
    async def test_discard_tracked_file(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / "README.md").write_text("modified")
        result = await git_service.discard_changes(str(tmp_path), ["README.md"])
        assert result["ok"] is True
        # File should be back to its committed content
        assert (tmp_path / "README.md").read_text() == "# test"

    @pytest.mark.asyncio
    async def test_discard_untracked_file(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / "junk.txt").write_text("junk")
        result = await git_service.discard_changes(str(tmp_path), ["junk.txt"])
        assert result["ok"] is True
        assert not (tmp_path / "junk.txt").exists()

    @pytest.mark.asyncio
    async def test_discard_empty_list(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.discard_changes(str(tmp_path), [])
        assert result["ok"] is True


# ── branches ──────────────────────────────────────────────────────────────────

class TestBranches:
    @pytest.mark.asyncio
    async def test_list_branches_returns_current(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.list_branches(str(tmp_path))
        assert result["ok"] is True
        assert result["current"] != ""
        assert any(b["is_current"] for b in result["branches"])

    @pytest.mark.asyncio
    async def test_create_and_switch_branch(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.create_branch(str(tmp_path), "feature/test", switch_to=True)
        assert result["ok"] is True
        status = await git_service.get_status(str(tmp_path))
        assert status["branch"] == "feature/test"

    @pytest.mark.asyncio
    async def test_switch_branch(self, tmp_path):
        init_repo(tmp_path)
        orig = (await git_service.get_status(str(tmp_path)))["branch"]
        await git_service.create_branch(str(tmp_path), "other", switch_to=True)
        result = await git_service.switch_branch(str(tmp_path), orig)
        assert result["ok"] is True
        status = await git_service.get_status(str(tmp_path))
        assert status["branch"] == orig

    @pytest.mark.asyncio
    async def test_delete_branch(self, tmp_path):
        init_repo(tmp_path)
        orig = (await git_service.get_status(str(tmp_path)))["branch"]
        await git_service.create_branch(str(tmp_path), "to-delete", switch_to=True)
        await git_service.switch_branch(str(tmp_path), orig)
        result = await git_service.delete_branch(str(tmp_path), "to-delete")
        assert result["ok"] is True
        branches_result = await git_service.list_branches(str(tmp_path))
        assert not any(b["name"] == "to-delete" for b in branches_result["branches"])

    @pytest.mark.asyncio
    @pytest.mark.parametrize("bad_name", [
        "-bad",          # leading dash → flag injection
        "--bad",         # double-dash flag injection
        "-D",            # direct flag
        "a..b",          # double-dot (invalid ref)
        "a b",           # space
        "a~b",           # tilde
        "a^b",           # caret
        "a:b",           # colon
        "a?b",           # question mark
        "a[b",           # bracket
        "a\\b",          # backslash
        "refs/heads/",   # trailing slash
        "branch.lock",   # .lock suffix
        "",              # empty
    ])
    async def test_create_branch_rejects_invalid_name(self, tmp_path, bad_name):
        init_repo(tmp_path)
        result = await git_service.create_branch(str(tmp_path), bad_name)
        assert result["ok"] is False

    @pytest.mark.asyncio
    async def test_switch_branch_rejects_leading_dash(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.switch_branch(str(tmp_path), "-f")
        assert result["ok"] is False

    @pytest.mark.asyncio
    async def test_delete_branch_rejects_leading_dash(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.delete_branch(str(tmp_path), "--force")
        assert result["ok"] is False


# ── stash ──────────────────────────────────────────────────────────────────────

class TestStash:
    @pytest.mark.asyncio
    async def test_stash_push_and_list(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / "README.md").write_text("modified")
        result = await git_service.stash_push(str(tmp_path), "wip changes")
        assert result["ok"] is True
        stashes = await git_service.stash_list(str(tmp_path))
        assert len(stashes) == 1
        assert "wip changes" in stashes[0]["message"]

    @pytest.mark.asyncio
    async def test_stash_push_single_path(self, tmp_path):
        # Stashing one pathspec must leave other changed files untouched.
        init_repo(tmp_path)
        (tmp_path / "a.txt").write_text("a-change")
        (tmp_path / "b.txt").write_text("b-change")
        result = await git_service.stash_push(str(tmp_path), "", ["a.txt"])
        assert result["ok"] is True
        assert not (tmp_path / "a.txt").exists()  # a.txt was stashed away
        assert (tmp_path / "b.txt").read_text() == "b-change"  # b.txt untouched
        status = await git_service.get_status(str(tmp_path))
        assert any(f["path"] == "b.txt" for f in status["untracked"])

    @pytest.mark.asyncio
    async def test_stash_pop(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / "README.md").write_text("stashed content")
        await git_service.stash_push(str(tmp_path))
        # File should be back to committed state after stash
        assert (tmp_path / "README.md").read_text() == "# test"
        result = await git_service.stash_pop(str(tmp_path), 0)
        assert result["ok"] is True
        assert (tmp_path / "README.md").read_text() == "stashed content"

    @pytest.mark.asyncio
    async def test_stash_drop(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / "README.md").write_text("modified")
        await git_service.stash_push(str(tmp_path))
        result = await git_service.stash_drop(str(tmp_path), 0)
        assert result["ok"] is True
        stashes = await git_service.stash_list(str(tmp_path))
        assert len(stashes) == 0


# ── amend / undo ───────────────────────────────────────────────────────────────

class TestAmendUndo:
    @pytest.mark.asyncio
    async def test_amend_with_new_message(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.amend_commit(str(tmp_path), "amended: new message")
        assert result["ok"] is True
        commits = await git_service.get_log(str(tmp_path))
        assert commits[0]["message"] == "amended: new message"

    @pytest.mark.asyncio
    async def test_amend_no_edit_keeps_message(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.amend_commit(str(tmp_path), "")
        assert result["ok"] is True
        commits = await git_service.get_log(str(tmp_path))
        assert commits[0]["message"] == "init"

    @pytest.mark.asyncio
    async def test_undo_last_commit_restores_staged(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / "a.txt").write_text("a")
        subprocess.run(["git", "add", "-A"], cwd=tmp_path, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-m", "second"], cwd=tmp_path, check=True, capture_output=True)
        result = await git_service.undo_last_commit(str(tmp_path))
        assert result["ok"] is True
        # After soft reset, only one commit remains
        commits = await git_service.get_log(str(tmp_path))
        assert len(commits) == 1
        # a.txt should be staged again
        status = await git_service.get_status(str(tmp_path))
        assert any(f["path"] == "a.txt" for f in status["staged"])


# ── diff_file ─────────────────────────────────────────────────────────────────

class TestDiffFile:
    @pytest.mark.asyncio
    async def test_diff_unstaged(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / "README.md").write_text("modified content")
        result = await git_service.diff_file(str(tmp_path), "README.md", staged=False)
        assert result["ok"] is True
        assert "modified content" in result["diff"]

    @pytest.mark.asyncio
    async def test_diff_staged(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / "README.md").write_text("staged content")
        subprocess.run(["git", "add", "README.md"], cwd=tmp_path, check=True, capture_output=True)
        result = await git_service.diff_file(str(tmp_path), "README.md", staged=True)
        assert result["ok"] is True
        assert "staged content" in result["diff"]

    @pytest.mark.asyncio
    async def test_diff_no_changes(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.diff_file(str(tmp_path), "README.md", staged=False)
        assert result["ok"] is True
        assert result["diff"] == ""

    @pytest.mark.asyncio
    async def test_diff_untracked_shows_additions(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / "new_file.txt").write_text("brand new line\n")
        result = await git_service.diff_file(str(tmp_path), "new_file.txt", staged=False)
        assert result["ok"] is True
        assert "brand new line" in result["diff"]
        assert "+brand new line" in result["diff"]


# ── merge_branch ───────────────────────────────────────────────────────────────

class TestMergeBranch:
    @pytest.mark.asyncio
    async def test_merge_branch(self, tmp_path):
        init_repo(tmp_path)
        orig = (await git_service.get_status(str(tmp_path)))["branch"]
        await git_service.create_branch(str(tmp_path), "feature", switch_to=True)
        (tmp_path / "feature.txt").write_text("feature")
        subprocess.run(["git", "add", "-A"], cwd=tmp_path, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-m", "feature commit"], cwd=tmp_path, check=True, capture_output=True)
        await git_service.switch_branch(str(tmp_path), orig)
        result = await git_service.merge_branch(str(tmp_path), "feature")
        assert result["ok"] is True
        assert (tmp_path / "feature.txt").exists()


# ── revert_commit ─────────────────────────────────────────────────────────────

class TestRevertCommit:
    @pytest.mark.asyncio
    async def test_revert_creates_revert_commit(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / "a.txt").write_text("a")
        subprocess.run(["git", "add", "-A"], cwd=tmp_path, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-m", "add a"], cwd=tmp_path, check=True, capture_output=True)
        commits_before = await git_service.get_log(str(tmp_path))
        result = await git_service.revert_commit(str(tmp_path), commits_before[0]["hash"])
        assert result["ok"] is True
        commits_after = await git_service.get_log(str(tmp_path))
        assert len(commits_after) == len(commits_before) + 1


# ── remotes ───────────────────────────────────────────────────────────────────

class TestRemotes:
    @pytest.mark.asyncio
    async def test_list_empty_remotes(self, tmp_path):
        init_repo(tmp_path)
        remotes = await git_service.list_remotes(str(tmp_path))
        assert remotes == []

    @pytest.mark.asyncio
    async def test_add_and_list_remote(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.add_remote(str(tmp_path), "origin", "https://github.com/test/repo.git")
        assert result["ok"] is True
        remotes = await git_service.list_remotes(str(tmp_path))
        assert any(r["name"] == "origin" for r in remotes)

    @pytest.mark.asyncio
    async def test_remove_remote(self, tmp_path):
        init_repo(tmp_path)
        await git_service.add_remote(str(tmp_path), "origin", "https://github.com/test/repo.git")
        result = await git_service.remove_remote(str(tmp_path), "origin")
        assert result["ok"] is True
        remotes = await git_service.list_remotes(str(tmp_path))
        assert not any(r["name"] == "origin" for r in remotes)

    @pytest.mark.asyncio
    async def test_add_remote_empty_name(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.add_remote(str(tmp_path), "", "https://github.com/test/repo.git")
        assert result["ok"] is False


# ── cherry_pick ───────────────────────────────────────────────────────────────

class TestCherryPick:
    @pytest.mark.asyncio
    async def test_cherry_pick_applies_commit(self, tmp_path):
        init_repo(tmp_path)
        orig = (await git_service.get_status(str(tmp_path)))["branch"]
        await git_service.create_branch(str(tmp_path), "feature", switch_to=True)
        (tmp_path / "cherry.txt").write_text("cherry")
        subprocess.run(["git", "add", "-A"], cwd=tmp_path, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-m", "cherry commit"], cwd=tmp_path, check=True, capture_output=True)
        cherry_hash = (await git_service.get_log(str(tmp_path), 1))[0]["hash"]

        await git_service.switch_branch(str(tmp_path), orig)
        assert not (tmp_path / "cherry.txt").exists()
        result = await git_service.cherry_pick(str(tmp_path), cherry_hash)
        assert result["ok"] is True
        assert (tmp_path / "cherry.txt").exists()


# ── tags ──────────────────────────────────────────────────────────────────────

class TestTags:
    @pytest.mark.asyncio
    async def test_list_empty_tags(self, tmp_path):
        init_repo(tmp_path)
        tags = await git_service.list_tags(str(tmp_path))
        assert tags == []

    @pytest.mark.asyncio
    async def test_create_lightweight_tag(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.create_tag(str(tmp_path), "v1.0.0")
        assert result["ok"] is True
        tags = await git_service.list_tags(str(tmp_path))
        assert any(t["name"] == "v1.0.0" for t in tags)

    @pytest.mark.asyncio
    async def test_create_annotated_tag(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.create_tag(str(tmp_path), "v2.0.0", message="Release 2")
        assert result["ok"] is True
        tags = await git_service.list_tags(str(tmp_path))
        assert any(t["name"] == "v2.0.0" for t in tags)

    @pytest.mark.asyncio
    async def test_delete_tag(self, tmp_path):
        init_repo(tmp_path)
        await git_service.create_tag(str(tmp_path), "v1.0.0")
        result = await git_service.delete_tag(str(tmp_path), "v1.0.0")
        assert result["ok"] is True
        tags = await git_service.list_tags(str(tmp_path))
        assert not any(t["name"] == "v1.0.0" for t in tags)

    @pytest.mark.asyncio
    async def test_create_tag_empty_name(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.create_tag(str(tmp_path), "")
        assert result["ok"] is False


# ── file_log ──────────────────────────────────────────────────────────────────

class TestFileLog:
    @pytest.mark.asyncio
    async def test_file_log_returns_commits(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / "README.md").write_text("updated")
        subprocess.run(["git", "add", "-A"], cwd=tmp_path, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-m", "update readme"], cwd=tmp_path, check=True, capture_output=True)
        commits = await git_service.file_log(str(tmp_path), "README.md")
        assert len(commits) >= 2
        assert any(c["message"] == "update readme" for c in commits)
        assert any(c["message"] == "init" for c in commits)

    @pytest.mark.asyncio
    async def test_file_log_empty_for_unknown_file(self, tmp_path):
        init_repo(tmp_path)
        commits = await git_service.file_log(str(tmp_path), "nonexistent.txt")
        assert commits == []


# ── show_file ──────────────────────────────────────────────────────────────────

class TestShowFile:
    @pytest.mark.asyncio
    async def test_show_file_returns_head_content(self, tmp_path):
        init_repo(tmp_path)
        # Working tree differs from HEAD; show_file must return the committed version.
        (tmp_path / "README.md").write_text("# changed in working tree")
        result = await git_service.show_file(str(tmp_path), "README.md")
        assert result["ok"] is True
        assert result["content"].rstrip("\n") == "# test"

    @pytest.mark.asyncio
    async def test_show_file_missing_at_rev(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.show_file(str(tmp_path), "nonexistent.txt")
        assert result["ok"] is False
        assert result["error"]


# ── resolve_conflict ──────────────────────────────────────────────────────────

class TestResolveConflict:
    def _make_conflict(self, path: Path) -> None:
        """Create a merge conflict in README.md."""
        init_repo(path)
        orig = subprocess.run(
            ["git", "branch", "--show-current"], cwd=path, capture_output=True, text=True
        ).stdout.strip()
        subprocess.run(["git", "checkout", "-b", "branch-a"], cwd=path, check=True, capture_output=True)
        (path / "README.md").write_text("branch-a content")
        subprocess.run(["git", "add", "-A"], cwd=path, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-m", "branch-a"], cwd=path, check=True, capture_output=True)
        subprocess.run(["git", "checkout", orig], cwd=path, check=True, capture_output=True)
        (path / "README.md").write_text("main content")
        subprocess.run(["git", "add", "-A"], cwd=path, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-m", "main-update"], cwd=path, check=True, capture_output=True)
        subprocess.run(["git", "merge", "branch-a"], cwd=path, capture_output=True)

    @pytest.mark.asyncio
    async def test_resolve_ours(self, tmp_path):
        self._make_conflict(tmp_path)
        result = await git_service.resolve_conflict_ours(str(tmp_path), "README.md")
        assert result["ok"] is True
        content = (tmp_path / "README.md").read_text()
        assert "<<<<<<" not in content

    @pytest.mark.asyncio
    async def test_resolve_theirs(self, tmp_path):
        self._make_conflict(tmp_path)
        result = await git_service.resolve_conflict_theirs(str(tmp_path), "README.md")
        assert result["ok"] is True
        content = (tmp_path / "README.md").read_text()
        assert "<<<<<<" not in content


# ── argument injection / input validation ─────────────────────────────────────

class TestInputValidation:
    """Security: verify flag-injection inputs are rejected before reaching git."""

    @pytest.mark.asyncio
    async def test_cherry_pick_rejects_flag_input(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.cherry_pick(str(tmp_path), "--exec=evil")
        assert result["ok"] is False
        assert "invalid commit hash" in result["error"]

    @pytest.mark.asyncio
    async def test_cherry_pick_rejects_dash_input(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.cherry_pick(str(tmp_path), "-x")
        assert result["ok"] is False

    @pytest.mark.asyncio
    async def test_cherry_pick_rejects_empty(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.cherry_pick(str(tmp_path), "")
        assert result["ok"] is False

    @pytest.mark.asyncio
    async def test_create_tag_rejects_dash_name(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.create_tag(str(tmp_path), "-delete-all")
        assert result["ok"] is False
        assert "invalid tag name" in result["error"]

    @pytest.mark.asyncio
    async def test_create_tag_rejects_bad_hash(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.create_tag(str(tmp_path), "v1.0.0", commit_hash="--exec=evil")
        assert result["ok"] is False
        assert "invalid commit hash" in result["error"]

    @pytest.mark.asyncio
    async def test_delete_tag_rejects_dash_name(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.delete_tag(str(tmp_path), "--flag")
        assert result["ok"] is False

    @pytest.mark.asyncio
    async def test_merge_branch_rejects_dash_name(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.merge_branch(str(tmp_path), "--strategy=evil")
        assert result["ok"] is False

    @pytest.mark.asyncio
    async def test_revert_commit_rejects_flag(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.revert_commit(str(tmp_path), "--abort")
        assert result["ok"] is False
        assert "invalid commit hash" in result["error"]

    @pytest.mark.asyncio
    async def test_add_remote_rejects_dash_name(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.add_remote(str(tmp_path), "--mirror", "https://example.com")
        assert result["ok"] is False

    @pytest.mark.asyncio
    async def test_valid_hex_hash_passes(self, tmp_path):
        """Confirm legitimate short hashes are accepted by validation."""
        err = git_service._validate_commit_hash("abc1234")
        assert err is None

    @pytest.mark.asyncio
    async def test_valid_ref_name_passes(self, tmp_path):
        err = git_service._validate_ref_name("feature/my-branch", "branch")
        assert err is None


# ── clean_untracked ───────────────────────────────────────────────────────────

class TestCleanUntracked:
    @pytest.mark.asyncio
    async def test_dry_run_returns_files(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / "junk.txt").write_text("junk")
        result = await git_service.clean_untracked(str(tmp_path), dry_run=True)
        assert result["ok"] is True
        assert "junk.txt" in " ".join(result["files"])
        assert (tmp_path / "junk.txt").exists()  # not deleted

    @pytest.mark.asyncio
    async def test_actual_clean_removes_files(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / "junk.txt").write_text("junk")
        result = await git_service.clean_untracked(str(tmp_path), dry_run=False)
        assert result["ok"] is True
        assert not (tmp_path / "junk.txt").exists()

    @pytest.mark.asyncio
    async def test_dry_run_empty_returns_no_files(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.clean_untracked(str(tmp_path), dry_run=True)
        assert result["ok"] is True
        assert result["files"] == []


# ── show_commit ────────────────────────────────────────────────────────────────

class TestShowCommit:
    @pytest.mark.asyncio
    async def test_returns_commit_detail(self, tmp_path):
        init_repo(tmp_path)
        commits = await git_service.get_log(str(tmp_path), 1)
        hash_val = commits[0]["hash"]
        result = await git_service.show_commit(str(tmp_path), hash_val)
        assert result["ok"] is True
        assert result["message"] == "init"
        assert result["author_name"] == "Test"
        assert result["author_email"] == "test@test.com"
        assert "README.md" in result["files"]

    @pytest.mark.asyncio
    async def test_rejects_invalid_hash(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.show_commit(str(tmp_path), "--evil")
        assert result["ok"] is False

    @pytest.mark.asyncio
    async def test_rejects_nonexistent_hash(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.show_commit(str(tmp_path), "deadbeef")
        assert result["ok"] is False


# ── push_set_upstream ──────────────────────────────────────────────────────────

class TestPushSetUpstream:
    @pytest.mark.asyncio
    async def test_rejects_invalid_branch(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.push_set_upstream(str(tmp_path), "--flag")
        assert result["ok"] is False

    @pytest.mark.asyncio
    async def test_rejects_invalid_remote(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.push_set_upstream(str(tmp_path), "main", "--flag")
        assert result["ok"] is False


# ── compare_branches ──────────────────────────────────────────────────────────

class TestCompareBranches:
    @pytest.mark.asyncio
    async def test_compare_same_branch(self, tmp_path):
        init_repo(tmp_path)
        orig = (await git_service.get_status(str(tmp_path)))["branch"]
        result = await git_service.compare_branches(str(tmp_path), orig, orig)
        assert result["ok"] is True

    @pytest.mark.asyncio
    async def test_compare_diverged_branches(self, tmp_path):
        init_repo(tmp_path)
        orig = (await git_service.get_status(str(tmp_path)))["branch"]
        await git_service.create_branch(str(tmp_path), "feature", switch_to=True)
        (tmp_path / "new.txt").write_text("feature content")
        subprocess.run(["git", "add", "-A"], cwd=tmp_path, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-m", "feature"], cwd=tmp_path, check=True, capture_output=True)
        result = await git_service.compare_branches(str(tmp_path), orig, "feature")
        assert result["ok"] is True
        assert "new.txt" in " ".join(result["files"])

    @pytest.mark.asyncio
    async def test_compare_rejects_flag_input(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.compare_branches(str(tmp_path), "--flag", "main")
        assert result["ok"] is False


# ── rebase_on ─────────────────────────────────────────────────────────────────

class TestRebaseOn:
    @pytest.mark.asyncio
    async def test_rebase_onto_branch(self, tmp_path):
        init_repo(tmp_path)
        orig = (await git_service.get_status(str(tmp_path)))["branch"]
        await git_service.create_branch(str(tmp_path), "base", switch_to=True)
        (tmp_path / "base.txt").write_text("base")
        subprocess.run(["git", "add", "-A"], cwd=tmp_path, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-m", "base commit"], cwd=tmp_path, check=True, capture_output=True)
        await git_service.switch_branch(str(tmp_path), orig)
        (tmp_path / "main.txt").write_text("main")
        subprocess.run(["git", "add", "-A"], cwd=tmp_path, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-m", "main commit"], cwd=tmp_path, check=True, capture_output=True)
        result = await git_service.rebase_on(str(tmp_path), "base")
        assert result["ok"] is True

    @pytest.mark.asyncio
    async def test_rebase_rejects_flag_input(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.rebase_on(str(tmp_path), "--abort")
        assert result["ok"] is False


# ── restore_file_from_branch ──────────────────────────────────────────────────

class TestRestoreFileFromBranch:
    @pytest.mark.asyncio
    async def test_restores_file(self, tmp_path):
        init_repo(tmp_path)
        orig = (await git_service.get_status(str(tmp_path)))["branch"]
        await git_service.create_branch(str(tmp_path), "feature", switch_to=True)
        (tmp_path / "feature_only.txt").write_text("from feature")
        subprocess.run(["git", "add", "-A"], cwd=tmp_path, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-m", "add feature file"], cwd=tmp_path, check=True, capture_output=True)
        await git_service.switch_branch(str(tmp_path), orig)
        assert not (tmp_path / "feature_only.txt").exists()
        result = await git_service.restore_file_from_branch(str(tmp_path), "feature", "feature_only.txt")
        assert result["ok"] is True
        assert (tmp_path / "feature_only.txt").exists()

    @pytest.mark.asyncio
    async def test_rejects_flag_branch(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.restore_file_from_branch(str(tmp_path), "--flag", "file.txt")
        assert result["ok"] is False

    @pytest.mark.asyncio
    async def test_rejects_dash_filepath(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.restore_file_from_branch(str(tmp_path), "main", "-flag")
        assert result["ok"] is False


# ── worktrees ─────────────────────────────────────────────────────────────────

class TestWorktrees:
    @pytest.mark.asyncio
    async def test_list_includes_main(self, tmp_path):
        init_repo(tmp_path)
        wts = await git_service.list_worktrees(str(tmp_path))
        assert len(wts) >= 1
        assert any(w["is_main"] for w in wts)

    @pytest.mark.asyncio
    async def test_add_and_list_worktree(self, tmp_path):
        init_repo(tmp_path)
        wt_path = str(tmp_path / "wt-branch")
        orig = (await git_service.get_status(str(tmp_path)))["branch"]
        result = await git_service.add_worktree(str(tmp_path), wt_path, orig + "-wt", new_branch=True)
        assert result["ok"] is True
        wts = await git_service.list_worktrees(str(tmp_path))
        assert any(w["path"] == wt_path for w in wts)

    @pytest.mark.asyncio
    async def test_add_worktree_rejects_flag_branch(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.add_worktree(str(tmp_path), "/tmp/wt", "--flag")
        assert result["ok"] is False

    @pytest.mark.asyncio
    async def test_remove_worktree(self, tmp_path):
        init_repo(tmp_path)
        wt_path = str(tmp_path / "wt-remove")
        orig = (await git_service.get_status(str(tmp_path)))["branch"]
        await git_service.add_worktree(str(tmp_path), wt_path, orig + "-rm", new_branch=True)
        result = await git_service.remove_worktree(str(tmp_path), wt_path)
        assert result["ok"] is True
        wts = await git_service.list_worktrees(str(tmp_path))
        assert not any(w["path"] == wt_path for w in wts)


# ── git_config ─────────────────────────────────────────────────────────────────

class TestGitConfig:
    @pytest.mark.asyncio
    async def test_get_config_returns_dict(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.get_config(str(tmp_path))
        assert result["ok"] is True
        assert isinstance(result["config"], dict)
        assert "user.email" in " ".join(result["config"].keys()) or \
               any("user" in k for k in result["config"])

    @pytest.mark.asyncio
    async def test_set_config(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.set_config(str(tmp_path), "user.name", "Test User")
        assert result["ok"] is True
        cfg = (await git_service.get_config(str(tmp_path)))["config"]
        assert cfg.get("user.name") == "Test User"

    @pytest.mark.asyncio
    async def test_set_config_rejects_unsafe_key(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.set_config(str(tmp_path), "../../etc/malicious", "val")
        assert result["ok"] is False

    @pytest.mark.asyncio
    async def test_set_config_rejects_rce_key(self, tmp_path):
        """core.sshCommand and diff.external are NOT in the allowlist."""
        init_repo(tmp_path)
        for dangerous_key in ("core.sshCommand", "diff.external", "core.gitProxy"):
            result = await git_service.set_config(str(tmp_path), dangerous_key, "evil")
            assert result["ok"] is False, f"{dangerous_key} should be rejected"

    @pytest.mark.asyncio
    async def test_set_config_rejects_dash_value(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.set_config(str(tmp_path), "user.name", "--evil-flag")
        assert result["ok"] is False

    @pytest.mark.asyncio
    async def test_set_config_only_allows_listed_keys(self, tmp_path):
        init_repo(tmp_path)
        # Every key in the allowlist should succeed
        for key in git_service._ALLOWED_CONFIG_KEYS:
            result = await git_service.set_config(str(tmp_path), key, "testvalue")
            assert result["ok"] is True, f"allowed key {key!r} was rejected"


# ── blame_file ─────────────────────────────────────────────────────────────────

class TestBlameFile:
    @pytest.mark.asyncio
    async def test_blame_returns_entries(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.blame_file(str(tmp_path), "README.md")
        assert result["ok"] is True
        assert len(result["lines"]) >= 1
        assert result["lines"][0]["author"] == "Test"

    @pytest.mark.asyncio
    async def test_blame_rejects_dash_filepath(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.blame_file(str(tmp_path), "-flag")
        assert result["ok"] is False

    @pytest.mark.asyncio
    async def test_blame_nonexistent_file(self, tmp_path):
        init_repo(tmp_path)
        result = await git_service.blame_file(str(tmp_path), "nonexistent.txt")
        assert result["ok"] is False


# ── get_staged_diff ────────────────────────────────────────────────────────────

class TestStagedDiff:
    @pytest.mark.asyncio
    async def test_returns_diff(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / "new.txt").write_text("hello world")
        await git_service.stage_files(str(tmp_path), ["new.txt"])
        diff = await git_service.get_staged_diff(str(tmp_path))
        assert "hello world" in diff

    @pytest.mark.asyncio
    async def test_empty_when_nothing_staged(self, tmp_path):
        init_repo(tmp_path)
        diff = await git_service.get_staged_diff(str(tmp_path))
        assert diff == ""


# ── get_working_diff ─────────────────────────────────────────────────────────────

class TestWorkingDiff:
    @pytest.mark.asyncio
    async def test_includes_untracked_file(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / "new.txt").write_text("brand new content")
        diff = await git_service.get_working_diff(str(tmp_path))
        assert "brand new content" in diff
        assert "new.txt" in diff

    @pytest.mark.asyncio
    async def test_includes_unstaged_tracked_change(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / "README.md").write_text("# test\nmodified line")
        diff = await git_service.get_working_diff(str(tmp_path))
        assert "modified line" in diff

    @pytest.mark.asyncio
    async def test_empty_when_clean(self, tmp_path):
        init_repo(tmp_path)
        diff = await git_service.get_working_diff(str(tmp_path))
        assert diff == ""


# ── helpers for the parity features ──────────────────────────────────────────────

def _current_branch(path: Path) -> str:
    return subprocess.run(
        ["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=path, check=True, capture_output=True, text=True
    ).stdout.strip()


def _working_diff(path: Path, filepath: str) -> str:
    return subprocess.run(
        ["git", "diff", "--", filepath], cwd=path, check=True, capture_output=True, text=True
    ).stdout


# ── apply_patch (hunk / line staging) ────────────────────────────────────────────

class TestApplyPatch:
    @pytest.mark.asyncio
    async def test_stage_then_unstage_hunk(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / "f.txt").write_text("a\nb\nc\n")
        subprocess.run(["git", "add", "f.txt"], cwd=tmp_path, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-m", "add f"], cwd=tmp_path, check=True, capture_output=True)

        (tmp_path / "f.txt").write_text("a\nCHANGED\nc\n")
        patch = _working_diff(tmp_path, "f.txt")

        # Stage the change via patch.
        r = await git_service.apply_patch(str(tmp_path), patch, reverse=False, cached=True)
        assert r["ok"] is True
        status = await git_service.get_status(str(tmp_path))
        assert any(f["path"] == "f.txt" for f in status["staged"])

        # Reverse it -> unstaged again.
        r2 = await git_service.apply_patch(str(tmp_path), patch, reverse=True, cached=True)
        assert r2["ok"] is True
        status2 = await git_service.get_status(str(tmp_path))
        assert not any(f["path"] == "f.txt" for f in status2["staged"])

    @pytest.mark.asyncio
    async def test_empty_patch_rejected(self, tmp_path):
        init_repo(tmp_path)
        r = await git_service.apply_patch(str(tmp_path), "   ")
        assert r["ok"] is False

    @pytest.mark.asyncio
    async def test_invalid_patch_returns_error(self, tmp_path):
        init_repo(tmp_path)
        r = await git_service.apply_patch(str(tmp_path), "not a real diff\n")
        assert r["ok"] is False
        assert r["error"]


# ── clone_repo ────────────────────────────────────────────────────────────────────

class TestCloneRepo:
    @pytest.mark.asyncio
    async def test_clone_success(self, tmp_path):
        source = tmp_path / "source"
        source.mkdir()
        init_repo(source)
        dest = tmp_path / "dest"
        r = await git_service.clone_repo(str(source), str(dest))
        assert r["ok"] is True
        assert (Path(r["path"]) / ".git").exists()

    @pytest.mark.asyncio
    async def test_rejects_flag_url(self, tmp_path):
        r = await git_service.clone_repo("--upload-pack=evil", str(tmp_path / "x"))
        assert r["ok"] is False

    @pytest.mark.asyncio
    async def test_rejects_nonempty_target(self, tmp_path):
        source = tmp_path / "source"
        source.mkdir()
        init_repo(source)
        dest = tmp_path / "dest"
        dest.mkdir()
        (dest / "existing.txt").write_text("x")
        r = await git_service.clone_repo(str(source), str(dest))
        assert r["ok"] is False


# ── add_to_gitignore ──────────────────────────────────────────────────────────────

class TestAddToGitignore:
    @pytest.mark.asyncio
    async def test_appends_pattern(self, tmp_path):
        init_repo(tmp_path)
        r = await git_service.add_to_gitignore(str(tmp_path), "node_modules/")
        assert r["ok"] is True
        content = (tmp_path / ".gitignore").read_text()
        assert "node_modules/" in content

    @pytest.mark.asyncio
    async def test_no_duplicate(self, tmp_path):
        init_repo(tmp_path)
        await git_service.add_to_gitignore(str(tmp_path), "dist")
        await git_service.add_to_gitignore(str(tmp_path), "dist")
        lines = [ln for ln in (tmp_path / ".gitignore").read_text().splitlines() if ln.strip() == "dist"]
        assert len(lines) == 1

    @pytest.mark.asyncio
    async def test_empty_pattern_rejected(self, tmp_path):
        init_repo(tmp_path)
        r = await git_service.add_to_gitignore(str(tmp_path), "  ")
        assert r["ok"] is False

    @pytest.mark.asyncio
    async def test_untracks_already_tracked_file(self, tmp_path):
        """The core fix: adding an ignore for a tracked file untracks it
        (git rm --cached) so the rule actually takes effect; file stays on disk."""
        init_repo(tmp_path)
        secret = tmp_path / "secret.env"
        secret.write_text("KEY=1")
        subprocess.run(["git", "add", "secret.env"], cwd=tmp_path, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-m", "add secret"], cwd=tmp_path, check=True, capture_output=True)

        r = await git_service.add_to_gitignore(str(tmp_path), "secret.env")
        assert r["ok"] is True
        assert r["untracked"] == ["secret.env"]
        assert secret.exists()  # file untouched on disk
        ls = subprocess.run(["git", "ls-files", "secret.env"], cwd=tmp_path, capture_output=True, text=True)
        assert ls.stdout.strip() == ""  # no longer tracked

    @pytest.mark.asyncio
    async def test_untrack_disabled(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / "keep.log").write_text("x")
        subprocess.run(["git", "add", "keep.log"], cwd=tmp_path, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-m", "add"], cwd=tmp_path, check=True, capture_output=True)
        r = await git_service.add_to_gitignore(str(tmp_path), "keep.log", untrack=False)
        assert r["untracked"] == []
        ls = subprocess.run(["git", "ls-files", "keep.log"], cwd=tmp_path, capture_output=True, text=True)
        assert ls.stdout.strip() == "keep.log"  # still tracked

    @pytest.mark.asyncio
    async def test_target_local_writes_info_exclude(self, tmp_path):
        init_repo(tmp_path)
        r = await git_service.add_to_gitignore(str(tmp_path), "scratch/", target="local")
        assert r["ok"] is True
        exclude = tmp_path / ".git" / "info" / "exclude"
        assert "scratch/" in exclude.read_text()
        assert not (tmp_path / ".gitignore").exists()  # project .gitignore untouched

    @pytest.mark.asyncio
    async def test_target_nested_writes_into_subdir(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / "backend").mkdir()
        r = await git_service.add_to_gitignore(str(tmp_path), "backend/cache.db", target="nested")
        assert r["ok"] is True
        nested = tmp_path / "backend" / ".gitignore"
        assert nested.read_text().strip() == "cache.db"

    @pytest.mark.asyncio
    async def test_target_unknown_rejected(self, tmp_path):
        init_repo(tmp_path)
        r = await git_service.add_to_gitignore(str(tmp_path), "x", target="bogus")
        assert r["ok"] is False

    @pytest.mark.asyncio
    async def test_nested_rejects_parent_traversal(self, tmp_path):
        init_repo(tmp_path)
        r = await git_service.add_to_gitignore(
            str(tmp_path), "../escape/cache.db", target="nested"
        )
        assert r["ok"] is False
        assert not (tmp_path.parent / "escape" / ".gitignore").exists()

    @pytest.mark.asyncio
    async def test_nested_rejects_absolute_path(self, tmp_path):
        init_repo(tmp_path)
        r = await git_service.add_to_gitignore(
            str(tmp_path), "/etc/cache.db", target="nested"
        )
        assert r["ok"] is False


# ── check_ignore ──────────────────────────────────────────────────────────────────

class TestCheckIgnore:
    @pytest.mark.asyncio
    async def test_reports_matching_rule(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / ".gitignore").write_text("*.log\n")
        r = await git_service.check_ignore(str(tmp_path), "debug.log")
        assert r["ok"] is True
        assert r["ignored"] is True
        assert r["pattern"] == "*.log"
        assert ".gitignore" in r["source"]

    @pytest.mark.asyncio
    async def test_not_ignored(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / ".gitignore").write_text("*.log\n")
        r = await git_service.check_ignore(str(tmp_path), "main.py")
        assert r["ok"] is True
        assert r["ignored"] is False

    @pytest.mark.asyncio
    async def test_reports_tracked_despite_rule(self, tmp_path):
        """A tracked file matching a rule: ignored=True (rule matches) but
        tracked=True — explains why it still shows up."""
        init_repo(tmp_path)
        (tmp_path / "app.log").write_text("x")
        subprocess.run(["git", "add", "-f", "app.log"], cwd=tmp_path, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-m", "log"], cwd=tmp_path, check=True, capture_output=True)
        (tmp_path / ".gitignore").write_text("*.log\n")
        r = await git_service.check_ignore(str(tmp_path), "app.log")
        assert r["ignored"] is True
        assert r["tracked"] is True

    @pytest.mark.asyncio
    async def test_empty_filepath_rejected(self, tmp_path):
        init_repo(tmp_path)
        r = await git_service.check_ignore(str(tmp_path), "")
        assert r["ok"] is False


# ── get_status include_ignored ─────────────────────────────────────────────────────

class TestStatusIncludeIgnored:
    @pytest.mark.asyncio
    async def test_ignored_hidden_by_default(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / ".gitignore").write_text("*.log\n")
        (tmp_path / "a.log").write_text("x")
        result = await git_service.get_status(str(tmp_path))
        assert result["ignored"] == []

    @pytest.mark.asyncio
    async def test_ignored_surfaced_when_requested(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / ".gitignore").write_text("*.log\n")
        (tmp_path / "a.log").write_text("x")
        result = await git_service.get_status(str(tmp_path), include_ignored=True)
        paths = {f["path"] for f in result["ignored"]}
        assert "a.log" in paths


# ── abort_operation + status detection ────────────────────────────────────────────

class TestAbortOperation:
    def _make_merge_conflict(self, path: Path) -> None:
        init_repo(path)
        base = _current_branch(path)
        (path / "c.txt").write_text("base\n")
        subprocess.run(["git", "add", "c.txt"], cwd=path, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-m", "base"], cwd=path, check=True, capture_output=True)
        subprocess.run(["git", "checkout", "-b", "feature"], cwd=path, check=True, capture_output=True)
        (path / "c.txt").write_text("feature\n")
        subprocess.run(["git", "commit", "-am", "feature"], cwd=path, check=True, capture_output=True)
        subprocess.run(["git", "checkout", base], cwd=path, check=True, capture_output=True)
        (path / "c.txt").write_text("main\n")
        subprocess.run(["git", "commit", "-am", "main"], cwd=path, check=True, capture_output=True)
        # Conflicting merge (expected to fail) leaves MERGE_HEAD behind.
        subprocess.run(["git", "merge", "feature"], cwd=path, capture_output=True)

    @pytest.mark.asyncio
    async def test_status_detects_merge(self, tmp_path):
        self._make_merge_conflict(tmp_path)
        status = await git_service.get_status(str(tmp_path))
        assert status["operation_in_progress"] == "merge"

    @pytest.mark.asyncio
    async def test_abort_merge_cleans_state(self, tmp_path):
        self._make_merge_conflict(tmp_path)
        r = await git_service.abort_operation(str(tmp_path), "merge")
        assert r["ok"] is True
        status = await git_service.get_status(str(tmp_path))
        assert status["operation_in_progress"] == ""

    @pytest.mark.asyncio
    async def test_invalid_op_rejected(self, tmp_path):
        init_repo(tmp_path)
        r = await git_service.abort_operation(str(tmp_path), "bogus")
        assert r["ok"] is False


# ── stash_apply ────────────────────────────────────────────────────────────────────

class TestStashApply:
    @pytest.mark.asyncio
    async def test_apply_keeps_stash(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / "README.md").write_text("modified content")
        push = await git_service.stash_push(str(tmp_path), "wip")
        assert push["ok"] is True

        r = await git_service.stash_apply(str(tmp_path), 0)
        assert r["ok"] is True
        # Change is back in the working tree...
        assert (tmp_path / "README.md").read_text() == "modified content"
        # ...and the stash entry still exists (unlike pop).
        entries = await git_service.stash_list(str(tmp_path))
        assert len(entries) == 1


# ── pull_rebase / push_force (no remote -> graceful failure) ──────────────────────

class TestRemoteVariants:
    @pytest.mark.asyncio
    async def test_pull_rebase_returns_shape(self, tmp_path):
        init_repo(tmp_path)
        r = await git_service.pull_rebase(str(tmp_path))
        assert set(["ok", "output", "error"]).issubset(r.keys())
        assert r["ok"] is False  # no upstream configured

    @pytest.mark.asyncio
    async def test_push_force_returns_shape(self, tmp_path):
        init_repo(tmp_path)
        r = await git_service.push_force(str(tmp_path))
        assert set(["ok", "output", "error"]).issubset(r.keys())
        assert r["ok"] is False  # no remote configured


# ── get_log parents (graph data) ──────────────────────────────────────────────────

class TestLogParents:
    @pytest.mark.asyncio
    async def test_parents_populated(self, tmp_path):
        init_repo(tmp_path)
        (tmp_path / "x.txt").write_text("x")
        subprocess.run(["git", "add", "x.txt"], cwd=tmp_path, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-m", "second"], cwd=tmp_path, check=True, capture_output=True)
        commits = await git_service.get_log(str(tmp_path), 10)
        # newest commit has exactly one parent; the root has none.
        assert len(commits[0]["parents"]) == 1
        assert commits[-1]["parents"] == []
