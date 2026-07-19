"""Plan version history: snapshot plan documents on stage transitions.

Snapshots live in ``<workspace>/.agent-team/plans/.history/<plan-stem>/`` and
are named ``<YYYYMMDDTHHMMSS>_<stage>.html``. The stage recorded in the newest
snapshot filename is the last-seen stage for that plan; a new snapshot is
taken whenever the stage currently on disk differs (or when the plan has no
history yet — the baseline). Detection is filesystem-driven (see the plans
sink wired to GitWatcher in app.py), so it works for every writer: App-side
``fs.write_file`` calls and agent CLIs editing the file directly.

The ``.history`` directory starts with a dot, so ``fs_service.list_dir``
hides it from default listings and the PlansPane never shows it as a plan.
"""

from __future__ import annotations

import json
import logging
import re
import shutil
from datetime import datetime
from pathlib import Path

from .projects import PROJECT_DIR_NAME

log = logging.getLogger("agent_team_backend.plan_history")

_PLANS_DIR_NAME = "plans"
HISTORY_DIR_NAME = ".history"
MAX_SNAPSHOTS_PER_PLAN = 20

# Python port of the frontend PLAN_META_RE (usePlanHtml.ts): the single
# machine-readable island. Attribute-order tolerant; the `\s` before `id`
# keeps `data-id="plan-meta"` from matching.
_PLAN_META_RE = re.compile(
    r"<script\b[^>]*\s(?:id=\"plan-meta\"|id='plan-meta')[^>]*>([\s\S]*?)</script>",
    re.IGNORECASE,
)

# Stage enum from `.agent-team/plans/_spec.md` (schema v1).
_STAGES = frozenset({"draft", "in-review", "approved", "in-progress", "done", "abandoned"})

_TS_FORMAT = "%Y%m%dT%H%M%S"
_SNAPSHOT_SUFFIX = ".html"


def parse_plan_stage(content: str) -> str | None:
    """Extract the ``stage`` from a plan document's plan-meta JSON island.

    Returns ``None`` when the island is missing, the JSON is malformed, or
    the stage is not one of the spec's values — callers treat such files as
    plain docs and never snapshot them.
    """
    match = _PLAN_META_RE.search(content)
    if match is None:
        return None
    try:
        raw = json.loads(match.group(1))
    except ValueError:
        return None
    if not isinstance(raw, dict):
        return None
    stage = raw.get("stage")
    if isinstance(stage, str) and stage in _STAGES:
        return stage
    return None


def _snapshot_stage(name: str) -> str | None:
    """Stage encoded in a snapshot filename ``<ts>_<stage>.html``."""
    if not name.endswith(_SNAPSHOT_SUFFIX) or "_" not in name:
        return None
    return name[: -len(_SNAPSHOT_SUFFIX)].split("_", 1)[1]


def snapshot_plans(workspace_path: str) -> list[str]:
    """Scan the workspace's plans dir; snapshot every plan whose current stage
    differs from its newest recorded snapshot (or that has no history yet).

    Returns workspace-relative POSIX paths of the snapshots created. Never
    raises: unreadable or meta-less files are skipped.
    """
    plans_dir = Path(workspace_path) / PROJECT_DIR_NAME / _PLANS_DIR_NAME
    if not plans_dir.is_dir():
        return []
    created: list[str] = []
    for plan in sorted(plans_dir.glob("*.html")):
        name = plan.name
        if name.startswith(("_", ".")) or not plan.is_file():
            continue
        try:
            content = plan.read_bytes().decode("utf-8", errors="replace")
        except OSError:
            continue
        stage = parse_plan_stage(content)
        if stage is None:
            continue
        history_dir = plans_dir / HISTORY_DIR_NAME / plan.stem
        snapshots = sorted(p.name for p in history_dir.glob(f"*{_SNAPSHOT_SUFFIX}")) if history_dir.is_dir() else []
        if snapshots and _snapshot_stage(snapshots[-1]) == stage:
            continue
        ts = datetime.now().astimezone().strftime(_TS_FORMAT)
        target = history_dir / f"{ts}_{stage}{_SNAPSHOT_SUFFIX}"
        try:
            history_dir.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(plan, target)
        except OSError as err:
            log.warning("plan snapshot failed for %s: %s", plan, err)
            continue
        created.append(target.relative_to(Path(workspace_path)).as_posix())
        _prune(history_dir)
    return created


def _prune(history_dir: Path) -> None:
    """Keep at most MAX_SNAPSHOTS_PER_PLAN snapshots, dropping the oldest."""
    snapshots = sorted(history_dir.glob(f"*{_SNAPSHOT_SUFFIX}"))
    for stale in snapshots[: max(0, len(snapshots) - MAX_SNAPSHOTS_PER_PLAN)]:
        try:
            stale.unlink()
        except OSError:
            pass
