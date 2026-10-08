"""The built-in rules a workspace's self-evolution run is given.

Versioned with the app: a run records which version it was given, and the
user reads the full text in the workspace's Self-evolution panel. What varies
per workspace (budget, scope, repository, ledger, extra instructions) is filled
in from that workspace's settings; nothing here names a particular project.

The rules come from the evolve-scout task that ran as a pane-owned schedule
(plan navide-self-evolution-loop_b96498) and the user's standing rules for it:
fix bugs directly, incrementally, in a worktree, back onto the main branch,
never push or release.
"""

from __future__ import annotations

from string import Template
from typing import Any

VERSION = 1

_HEADER = Template("""\
[Navide self-evolution run $run_id — rules v$version]
Opened by Navide's self-evolution for the workspace $workspace. Every run is
independent: do not rely on memory of earlier runs. Work in the user's language
when you write for them (plans, notes, the final report).

BUDGET: at most $token_budget tokens this run, and at most $max_minutes minutes.
Read data in slices (grep / tail / limits), never whole large files. When you
near the budget, stop gathering and produce from what you have.
""")

_FIX = Template("""\
BUGS MAY BE FIXED DIRECTLY (scope: fix)
- A bug is existing behaviour that does not match what is expected: an error,
  a regression, a silent failure. Fix it without asking first.
- Not yours to do — write a proposal instead: new features, trade-offs that
  change a design or product behaviour, deleting data, migrations. When unsure
  whether it is a bug or a trade-off, treat it as a trade-off.
- Fix incrementally: add checks, branches and handling to the existing code.
  Do not rewrite, and do not change an existing interface (function signature,
  parameters, return shape, event or message format).
- Never delete a feature, function or method, not even an unused-looking one.
  A bug that can only be fixed by deleting something or changing a signature
  is a proposal. Before each commit, read `git diff` for removed
  def / function / export / method lines; if there are any, stop and write a
  proposal instead.
- At most $max_fixes bug fixes this run; the rest become proposals.
- How (every fix must end up on $branch, not left on a side branch):
  1. Open a worktree from the latest local $branch:
     git -C $repo_root worktree add -b fix/<slug> <a path outside the repository> $branch
     Work only inside that worktree; never edit files in $repo_root directly.
  2. Write a failing test that reproduces the bug, run it bare and see it fail,
     then fix until it passes.
  3. One commit per bug, through a private index:
     export GIT_INDEX_FILE=$$(mktemp) && git read-tree HEAD && git add <files> && git commit
     Then `git show --stat HEAD` must list only your files.
  4. Run the related tests, then the project's full suites; all must pass.
     If the project's tests cannot run in the worktree, turn that bug into a
     proposal instead of forcing it.
  5. Rebase onto the latest local $branch inside the worktree. On a conflict:
     `git rebase --abort`, stop, and report it.
  6. Bring it back in $repo_root: confirm the branch is $branch; confirm with
     `git status --porcelain -- <each file of your commit>` that nobody has
     uncommitted changes in those files (if anyone does, stop and report);
     cherry-pick with a private index (export GIT_INDEX_FILE=$$(mktemp) &&
     git read-tree HEAD && git cherry-pick <hash>; on a conflict
     `git cherry-pick --abort` and report); then `git reset -- <your files>` so
     the shared index matches HEAD for your paths only.
  7. Verify: `git log $branch --oneline` shows your commit and the related tests
     pass in $repo_root.
- Do not delete the fix branch or the worktree; list them in your report.
""")

_PROPOSE = Template("""\
PROPOSALS ONLY (scope: propose)
- Do not change any file of the project, do not commit, do not open worktrees.
  Every finding — bug or trade-off — becomes a proposal.
$why
""")

_NOT_GIT = "- This workspace is not a git repository, so there is no worktree or main branch to fix on."

_COMMON = Template("""\
DIVISION OF WORK
- Do not use sub-agents (Agent / Task tools). Do the work yourself; when you
  must split it, open at most 2 CLI panes with Navide's cli_open_agent, tell
  them in the task that run $run_id opened them, give them these rules, and
  have them report back to you with cli_send. Do not close them.

NEVER
- push, release or tag; stash; delete branches or worktrees; touch other
  people's uncommitted work; damage databases or the machine; install
  anything; send data off this machine (gh is read-only queries only).
- New proposals stay at stage in-review.

MASKING
- Before quoting any log, prompt excerpt or message, replace anything that
  looks like a secret with [REDACTED]: sk-…, ghp_/gho_/github_pat_…, xox?-…,
  AKIA…, the value after Bearer, JWTs starting eyJ, hex or base64 runs of 32+
  characters, and the value after password= / token= / secret=.

STEPS
1. Gather the last 24 hours of signals, as summaries and counts only:
   - Navide: ui_diagnostics, cli_token_stats, cli_usage, cli_list_sessions
     (abnormal exits, short-lived sessions), cli_message_log (failed,
     undelivered, resent).
   - The project in $workspace: recent commits, failing or flaky tests, TODO /
     FIXME hot spots, and `gh issue list --state open --limit 30` when it has a
     GitHub remote (skip and note why when that fails).
2. Judge: keep pain points that recur, affect the user, and can be verified;
   one-off noise and work already in progress do not count. For each, record
   frequency, who it affects, and evidence (path:line, log pattern + count,
   tool output) with a grade: measured this run / read in code / inferred.
3. De-duplicate with plan_list: a topic that already has a plan gets a
   plan_add_note with the new evidence instead of a new plan.
4. Produce at most 3 new proposals with plan_create(name="Evolution proposal:
   <topic>", stage="in-review"): pain point, evidence table with grades,
   suggested change (where and how, not implemented), expected metric, risks.
   End each with "Produced by Navide self-evolution run $run_id".
$ledger
6. FINISH by calling the Navide MCP tool evolve_report exactly once:
   evolve_report(run_id="$run_id", status="ok" or "error", summary=<3–8 lines>,
   commits=[{hash, title}], proposals=[{rel_path, name}], panes=[names you
   opened], tokens=<your best estimate of tokens used>).
   Navide reclaims this pane after it. Without it the run is reported as timed
   out after $max_minutes minutes.
""")

_LEDGER = Template("""\
5. Ledger: plan_add_note on $ledger_plan with the date, which signals you read
   (and which failed), the number of candidates, new proposal files, notes
   added, fixes made, panes opened, and an estimate of tokens used.
""")

_NO_LEDGER = "5. (No ledger plan is set for this workspace; evolve_report is the record.)\n"

_EXTRA = Template("""\

EXTRA INSTRUCTIONS FROM THE USER FOR THIS WORKSPACE
(They add to the rules above; where they conflict, the rules above win.)
$extra
""")


def render(params: dict[str, Any]) -> str:
    """The task text for one run.

    ``params``: run_id, workspace, repo_root, branch, is_repo, scope ("fix" |
    "propose"), token_budget, max_minutes, max_fixes, ledger_plan, extra.
    """
    values = {
        "version": VERSION,
        "run_id": params["run_id"],
        "workspace": params["workspace"],
        "repo_root": params.get("repo_root") or params["workspace"],
        "branch": params.get("branch") or "main",
        "token_budget": params["token_budget"],
        "max_minutes": params["max_minutes"],
        "max_fixes": params["max_fixes"],
    }
    parts = [_HEADER.substitute(values)]
    if params.get("scope") == "fix" and params.get("is_repo"):
        parts.append(_FIX.substitute(values))
    else:
        parts.append(_PROPOSE.substitute(why="" if params.get("is_repo") else _NOT_GIT))
    ledger_plan = str(params.get("ledger_plan") or "").strip()
    ledger = _LEDGER.substitute(ledger_plan=ledger_plan) if ledger_plan else _NO_LEDGER
    parts.append(_COMMON.substitute(values, ledger=ledger))
    extra = str(params.get("extra") or "").strip()
    if extra:
        parts.append(_EXTRA.substitute(extra=extra))
    return "\n".join(parts)


def preview() -> str:
    """The full built-in text with placeholders, for the panel's read-only view."""
    return render({
        "run_id": "<run id>",
        "workspace": "<workspace>",
        "repo_root": "<repository root>",
        "branch": "<main branch>",
        "is_repo": True,
        "scope": "fix",
        "token_budget": "<token budget>",
        "max_minutes": "<minutes>",
        "max_fixes": "<bug fixes>",
        "ledger_plan": "<ledger plan, when set>",
        "extra": "",
    })
