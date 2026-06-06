"""Per-workspace project metadata + per-run pipeline event logs.

Each workspace gets a `.agent-team/` directory containing:
  - project.json                                 current pipeline state, atomic-write
  - pipeline-YYYYMMDD-HHMMSS-<task-slug>.log    one log file per pipeline run
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

log = logging.getLogger("agent_team_backend.projects")

PROJECT_DIR_NAME = ".agent-team"
PROJECT_FILE = "project.json"
RUNS_SUBDIR = "runs"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _make_run_name(task_description: str) -> str:
    """Generate YYYYMMDD-HHMMSS-<slug> — used as the run sub-folder name."""
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    # Keep only CJK / alphanumeric chars, replace the rest with hyphens, max 30 chars
    slug = re.sub(r"[^\w一-鿿぀-ヿ]", "-", task_description.strip())
    slug = re.sub(r"-+", "-", slug).strip("-")[:30]
    return f"{ts}-{slug}" if slug else ts


def _make_log_filename(task_description: str) -> str:
    """Return relative path 'runs/{run_name}/pipeline.log' for a new pipeline run."""
    run_name = _make_run_name(task_description)
    return f"{RUNS_SUBDIR}/{run_name}/pipeline.log"


def _project_id_for(workspace_path: str) -> str:
    h = hashlib.sha1(workspace_path.encode("utf-8")).hexdigest()[:10]
    return f"proj_{h}"


@dataclass
class SlotRecord:
    label: str
    agent: str = ""
    role: str = ""
    pane_id: str | None = None
    spawn_status: str = "pending"   # pending / spawned / removed
    kickoff_status: str = "none"    # none / sent / failed
    # CLI session id used to resume this slot's conversation on App restart.
    # Claude: the --session-id we pinned at spawn (known immediately).
    # Codex/Gemini: the CLI-generated id, detected after spawn. "" = no resume.
    session_id: str = ""
    run_group_id: str = ""  # which frontend tab this pane belongs to


@dataclass
class ManualPaneRecord:
    pane_id: str
    agent: str = ""
    role: str = ""
    command: str = ""
    spawn_status: str = "spawned"  # spawned / removed
    session_id: str = ""
    run_group_id: str = ""  # which frontend tab this pane belongs to


@dataclass
class PaneRecord:
    """Unified restore record for both pipeline slots and manual panes."""
    pane_id: str
    agent: str = ""
    role: str = ""
    command: str = ""
    session_id: str = ""
    spawn_status: str = "pending"   # pending / spawned / removed
    run_group_id: str = ""
    origin: str = "manual"          # "pipeline" | "manual"
    stage_id: str = ""
    stage_index: int = -1
    slot_label: str = ""
    kickoff_status: str = "none"    # none / sent / failed


@dataclass
class StageRecord:
    stage_id: str
    title: str = ""
    agent: str = ""
    role: str = ""
    pane_id: str | None = None
    status: str = "pending"  # pending / running / completed / aborted
    started_at: str | None = None
    ended_at: str | None = None
    slots: list[SlotRecord] = field(default_factory=list)


@dataclass
class Project:
    id: str
    name: str
    workspace_path: str
    created_at: str
    updated_at: str
    task_description: str = ""
    state: str = "idle"  # idle / running / completed / aborted
    current_stage_index: int = -1
    total_stages: int = 5
    stages: list[StageRecord] = field(default_factory=list)
    panes: list[PaneRecord] = field(default_factory=list)   # unified: pipeline slots + manual panes
    manual_panes: list[ManualPaneRecord] = field(default_factory=list)  # legacy — kept for backward compat
    agents_spawned: int = 0
    backend_version: str = ""
    log_file_name: str = ""  # set by start_pipeline(); e.g. "pipeline-20260527-183000-建立登入頁面.log"
    layout_mode: str = "grid"
    pipeline_id: str = ""  # which pipeline template was used for this run
    run_count: int = 0     # incremented on each successful pipeline completion
    theme: str = "dark-github"  # backup of the user-level theme (source of truth is the renderer's localStorage)
    theme_custom: dict[str, Any] = field(default_factory=dict)  # backup of custom CSS var overrides (key -> value)

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        return d

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Project":
        def _stage(s: dict[str, Any]) -> StageRecord:
            # exclude "slots" — pipeline panes now live in panes[]; old slots are
            # migrated below and should not be set on StageRecord directly.
            known = {f for f in StageRecord.__dataclass_fields__} - {"slots"}
            return StageRecord(**{k: v for k, v in s.items() if k in known})

        stages = [_stage(s) for s in d.get("stages", [])]

        # Unified panes[]: if present use it directly; otherwise migrate from old format.
        pane_known = {f for f in PaneRecord.__dataclass_fields__}
        if "panes" in d:
            panes: list[PaneRecord] = [
                PaneRecord(**{k: v for k, v in p.items() if k in pane_known})
                for p in d["panes"] if isinstance(p, dict)
            ]
        else:
            panes = []
            for i, raw_stage in enumerate(d.get("stages", [])):
                for slot in raw_stage.get("slots", []):
                    pid = slot.get("pane_id") or ""
                    if not pid:
                        continue
                    panes.append(PaneRecord(
                        pane_id=pid,
                        agent=slot.get("agent", ""),
                        role=slot.get("role", ""),
                        session_id=slot.get("session_id", ""),
                        spawn_status=slot.get("spawn_status", "pending"),
                        run_group_id=slot.get("run_group_id", ""),
                        kickoff_status=slot.get("kickoff_status", "none"),
                        origin="pipeline",
                        stage_id=raw_stage.get("stage_id", ""),
                        stage_index=i,
                        slot_label=slot.get("label", ""),
                    ))
            for mp in d.get("manual_panes", []):
                if not isinstance(mp, dict) or not mp.get("pane_id"):
                    continue
                panes.append(PaneRecord(
                    pane_id=mp["pane_id"],
                    agent=mp.get("agent", ""),
                    role=mp.get("role", ""),
                    command=mp.get("command", ""),
                    session_id=mp.get("session_id", ""),
                    spawn_status=mp.get("spawn_status", "spawned"),
                    run_group_id=mp.get("run_group_id", ""),
                    origin="manual",
                ))

        d2 = {**d, "stages": stages, "panes": panes}
        known = {f for f in cls.__dataclass_fields__}
        d2 = {k: v for k, v in d2.items() if k in known}
        return cls(**d2)


class ProjectStore:
    """Manages project.json + pipeline.log under each workspace."""

    def project_dir(self, workspace_path: str) -> Path:
        return Path(workspace_path) / PROJECT_DIR_NAME

    def project_file(self, workspace_path: str) -> Path:
        return self.project_dir(workspace_path) / PROJECT_FILE

    def log_file(self, workspace_path: str, log_file_name: str = "") -> Path:
        """Return the log file path for this workspace.

        If log_file_name is given (from project.log_file_name), use that.
        Falls back to a generic 'pipeline.log' for events outside a run.
        """
        name = log_file_name or "pipeline.log"
        return self.project_dir(workspace_path) / name

    def _ensure_dir(self, workspace_path: str) -> Path:
        d = self.project_dir(workspace_path)
        d.mkdir(parents=True, exist_ok=True)
        # Make the runtime dir self-ignoring so git never tracks it, regardless
        # of the workspace's own .gitignore or staging order. `.gitignore` with
        # `*` ignores the whole directory (including itself) — same pattern as
        # pytest's .pytest_cache/.gitignore.
        gi = d / ".gitignore"
        if not gi.exists():
            gi.write_text("*\n", encoding="utf-8")
        return d

    def peek(self, workspace_path: str) -> Project | None:
        """Return the existing project for this workspace WITHOUT creating one.

        Returns None when:
          - the workspace path is empty / does not exist
          - no .agent-team/project.json is present
          - the JSON file is corrupt (we don't auto-recreate during peek so
            the user isn't surprised by hidden file writes from typing in
            the workspace input)
        """
        if not workspace_path:
            return None
        ws = os.path.abspath(workspace_path)
        if not os.path.isdir(ws):
            return None
        pf = self.project_file(ws)
        if not pf.exists():
            return None
        try:
            if pf.stat().st_size > 524_288:  # 512 KB sanity cap
                raise ValueError("project.json exceeds size limit")
            data = json.loads(pf.read_text(encoding="utf-8"))
            project = Project.from_dict(data)
            project.workspace_path = ws
            return project
        except Exception as err:  # noqa: BLE001
            log.warning("project.json at %s is corrupt during peek (%s)", pf, err)
            return None

    def load_or_create(
        self, workspace_path: str, *, name: str = "", backend_version: str = ""
    ) -> Project:
        ws = os.path.abspath(workspace_path)
        if not os.path.isdir(ws):
            raise FileNotFoundError(f"workspace does not exist: {ws}")
        pf = self.project_file(ws)
        if pf.exists():
            try:
                if pf.stat().st_size > 524_288:
                    raise ValueError("project.json exceeds size limit")
                data = json.loads(pf.read_text(encoding="utf-8"))
                project = Project.from_dict(data)
                # Keep workspace_path canonical in case the user moved the folder.
                project.workspace_path = ws
                return project
            except Exception as err:  # noqa: BLE001
                log.warning("project.json at %s is corrupt (%s); recreating", pf, err)

        now = _now_iso()
        project = Project(
            id=_project_id_for(ws),
            name=name or Path(ws).name,
            workspace_path=ws,
            created_at=now,
            updated_at=now,
            backend_version=backend_version,
        )
        self.save(project)
        self.append_event(
            ws,
            {
                "event": "project_created",
                "project_id": project.id,
                "name": project.name,
            },
        )
        return project

    def save(self, project: Project) -> Path:
        project.updated_at = _now_iso()
        self._ensure_dir(project.workspace_path)
        pf = self.project_file(project.workspace_path)
        tmp = pf.with_suffix(pf.suffix + ".tmp")
        payload = json.dumps(project.to_dict(), indent=2, ensure_ascii=False)
        tmp.write_text(payload, encoding="utf-8")
        os.replace(tmp, pf)
        return pf

    def append_event(
        self, workspace_path: str, event: dict[str, Any], log_file_name: str = ""
    ) -> Path:
        ws = os.path.abspath(workspace_path)
        self._ensure_dir(ws)
        lf = self.log_file(ws, log_file_name)
        # Auto-create the run sub-folder (e.g. runs/20260528-020041-task/)
        lf.parent.mkdir(parents=True, exist_ok=True)
        line = f"[{_now_iso()}] {json.dumps(event, ensure_ascii=False)}\n"
        with open(lf, "a", encoding="utf-8") as f:
            f.write(line)
        return lf

    # -------- Pipeline-specific high-level ops --------

    def start_pipeline(
        self,
        workspace_path: str,
        *,
        task_description: str,
        total_stages: int,
        stage_blueprint: list[dict[str, Any]],
        backend_version: str = "",
        pipeline_id: str = "",
    ) -> Project:
        project = self.load_or_create(workspace_path, backend_version=backend_version)
        project.task_description = task_description
        project.total_stages = total_stages
        if pipeline_id:
            project.pipeline_id = pipeline_id
        project.state = "running"
        project.current_stage_index = -1  # spawn_stage will bump to 0
        project.stages = [
            StageRecord(
                stage_id=s["stage_id"],
                title=s.get("title", ""),
                slots=[
                    SlotRecord(
                        label=sl.get("label", ""),
                        agent=sl.get("agent", ""),
                        role=sl.get("role", ""),
                    )
                    for sl in s.get("slots", [])
                ],
            )
            for s in stage_blueprint
        ]
        # Clear stale pipeline panes from previous runs; preserve manual panes.
        project.panes = [p for p in project.panes if p.origin == "manual"]
        # Each pipeline run gets its own log file.
        project.log_file_name = _make_log_filename(task_description)
        self.save(project)
        self.append_event(
            workspace_path,
            {
                "event": "pipeline_start",
                "project_id": project.id,
                "task": task_description,
                "total_stages": total_stages,
                "log_file": project.log_file_name,
            },
            log_file_name=project.log_file_name,
        )
        return project

    def record_stage_spawn(
        self,
        workspace_path: str,
        *,
        stage_index: int,
        pane_id: str,
        agent: str,
        role: str,
    ) -> Project:
        project = self.load_or_create(workspace_path)
        if stage_index < 0 or stage_index >= len(project.stages):
            raise IndexError(f"stage_index {stage_index} out of range")
        # mark previous stage completed (if any) before bumping pointer
        if 0 <= project.current_stage_index < len(project.stages):
            prev = project.stages[project.current_stage_index]
            if prev.status == "running":
                prev.status = "completed"
                prev.ended_at = _now_iso()
        stage = project.stages[stage_index]
        stage.status = "running"
        stage.started_at = _now_iso()
        stage.pane_id = pane_id
        if agent:
            stage.agent = agent
        if role:
            stage.role = role
        project.current_stage_index = stage_index
        project.agents_spawned += 1
        self.save(project)
        self.append_event(
            workspace_path,
            {
                "event": "stage_spawn",
                "stage_index": stage_index,
                "stage_id": stage.stage_id,
                "agent": stage.agent,
                "role": stage.role,
                "pane_id": pane_id,
            },
            log_file_name=project.log_file_name,
        )
        return project

    def _find_slot_pane(self, project: "Project", stage_index: int, slot_label: str) -> "PaneRecord | None":
        return next(
            (p for p in project.panes
             if p.origin == "pipeline" and p.stage_index == stage_index and p.slot_label == slot_label),
            None,
        )

    def record_slot_spawn(
        self,
        workspace_path: str,
        *,
        stage_index: int,
        slot_label: str,
        pane_id: str,
        agent: str = "",
        role: str = "",
        session_id: str = "",
        run_group_id: str = "",
    ) -> Project:
        project = self.load_or_create(workspace_path)
        if stage_index < 0 or stage_index >= len(project.stages):
            raise IndexError(f"stage_index {stage_index} out of range")
        stage = project.stages[stage_index]
        pane = self._find_slot_pane(project, stage_index, slot_label)
        if pane is None:
            pane = PaneRecord(pane_id=pane_id, origin="pipeline",
                              stage_id=stage.stage_id, stage_index=stage_index, slot_label=slot_label)
            project.panes.append(pane)
        pane.pane_id = pane_id
        pane.spawn_status = "spawned"
        if agent: pane.agent = agent
        if role: pane.role = role
        # Claude pins its session id at spawn; Codex/Gemini use record_slot_session() later.
        if session_id: pane.session_id = session_id
        if run_group_id: pane.run_group_id = run_group_id
        self.save(project)
        return project

    def record_slot_session(
        self,
        workspace_path: str,
        *,
        stage_index: int,
        slot_label: str,
        session_id: str,
    ) -> Project:
        """Persist the CLI session id for a slot so it can be resumed on restart."""
        project = self.load_or_create(workspace_path)
        pane = self._find_slot_pane(project, stage_index, slot_label)
        if pane:
            pane.session_id = session_id
            self.save(project)
        return project

    def record_slot_unspawn(
        self,
        workspace_path: str,
        *,
        stage_index: int,
        slot_label: str,
    ) -> Project:
        """Mark a pipeline slot as manually removed so it is not auto-restored."""
        project = self.load_or_create(workspace_path)
        if stage_index < 0 or stage_index >= len(project.stages):
            raise IndexError(f"stage_index {stage_index} out of range")
        stage = project.stages[stage_index]
        pane = self._find_slot_pane(project, stage_index, slot_label)
        if pane is None:
            return project
        pane.spawn_status = "removed"
        pane.kickoff_status = "none"
        self.save(project)
        self.append_event(
            workspace_path,
            {"event": "slot_unspawn", "stage_index": stage_index,
             "stage_id": stage.stage_id, "slot_label": slot_label},
            log_file_name=project.log_file_name,
        )
        return project

    def _find_manual_pane(self, project: "Project", pane_id: str, previous_pane_id: str = "") -> "PaneRecord | None":
        return next(
            (p for p in project.panes
             if p.origin == "manual" and (p.pane_id == pane_id or (previous_pane_id and p.pane_id == previous_pane_id))),
            None,
        )

    def record_manual_pane_spawn(
        self,
        workspace_path: str,
        *,
        pane_id: str,
        previous_pane_id: str = "",
        agent: str = "",
        role: str = "",
        command: str = "",
        session_id: str = "",
        run_group_id: str = "",
    ) -> Project:
        project = self.load_or_create(workspace_path)
        pane = self._find_manual_pane(project, pane_id, previous_pane_id)
        if pane is None:
            pane = PaneRecord(pane_id=pane_id, origin="manual")
            project.panes.append(pane)
        pane.pane_id = pane_id
        pane.agent = agent
        pane.role = role
        pane.command = command
        pane.spawn_status = "spawned"
        if session_id: pane.session_id = session_id
        if run_group_id: pane.run_group_id = run_group_id
        self.save(project)
        self.append_event(
            workspace_path,
            {"event": "manual_pane_spawn", "pane_id": pane_id, "agent": agent, "role": role},
            log_file_name=project.log_file_name,
        )
        return project

    def record_manual_pane_unspawn(
        self,
        workspace_path: str,
        *,
        pane_id: str,
    ) -> Project:
        project = self.load_or_create(workspace_path)
        pane = self._find_manual_pane(project, pane_id)
        if pane is None:
            return project
        pane.spawn_status = "removed"
        self.save(project)
        self.append_event(
            workspace_path,
            {"event": "manual_pane_unspawn", "pane_id": pane_id},
            log_file_name=project.log_file_name,
        )
        return project

    def record_manual_pane_session(
        self,
        workspace_path: str,
        *,
        pane_id: str,
        session_id: str,
    ) -> Project:
        project = self.load_or_create(workspace_path)
        pane = self._find_manual_pane(project, pane_id)
        if pane is None:
            return project
        pane.session_id = session_id
        self.save(project)
        return project

    def set_pane_run_group(
        self,
        workspace_path: str,
        *,
        pane_id: str,
        run_group_id: str,
    ) -> Project:
        """Reassign a pane (pipeline or manual) to a run group / tab.

        Looks up by pane_id across all panes regardless of origin. An empty
        run_group_id is allowed (moves the pane to the ungrouped/手動 tab).
        No-op if the pane isn't found.
        """
        project = self.load_or_create(workspace_path)
        pane = next((p for p in project.panes if p.pane_id == pane_id), None)
        if pane is None:
            return project
        pane.run_group_id = run_group_id
        self.save(project)
        return project

    def update_slot_kickoff(
        self,
        workspace_path: str,
        *,
        stage_index: int,
        slot_label: str,
        kickoff_status: str,
    ) -> Project:
        project = self.load_or_create(workspace_path)
        pane = self._find_slot_pane(project, stage_index, slot_label)
        if pane:
            pane.kickoff_status = kickoff_status
            self.save(project)
        return project

    def resume_pipeline(self, workspace_path: str) -> tuple[Project, int]:
        """Mark an existing pipeline as running again. Returns (project, next_stage_index).

        next_stage_index = -1 means "all stages already completed".
        Picks the first stage whose status is not 'completed'.
        """
        project = self.load_or_create(workspace_path)
        if not project.stages:
            raise ValueError("no pipeline to resume — start one first")

        next_idx = -1
        for i, s in enumerate(project.stages):
            if s.status != "completed":
                next_idx = i
                break

        if next_idx == -1:
            project.state = "completed"
        else:
            project.state = "running"
            project.current_stage_index = next_idx
            # Reset that stage's bookkeeping so a fresh pane records cleanly.
            stage = project.stages[next_idx]
            stage.status = "running"
            stage.started_at = _now_iso()
            stage.ended_at = None
            stage.pane_id = None

        self.save(project)
        self.append_event(
            workspace_path,
            {
                "event": "pipeline_resume",
                "project_id": project.id,
                "resume_index": next_idx,
                "total_stages": project.total_stages,
            },
            log_file_name=project.log_file_name,
        )
        return project, next_idx

    def complete_pipeline(self, workspace_path: str) -> Project:
        project = self.load_or_create(workspace_path)
        # Close any still-running stage
        if 0 <= project.current_stage_index < len(project.stages):
            cur = project.stages[project.current_stage_index]
            if cur.status == "running":
                cur.status = "completed"
                cur.ended_at = _now_iso()
        project.state = "completed"
        project.run_count += 1
        self.save(project)
        self.append_event(
            workspace_path,
            {"event": "pipeline_complete", "project_id": project.id, "run_count": project.run_count},
            log_file_name=project.log_file_name,
        )
        return project

    def abort_pipeline(self, workspace_path: str, *, reason: str = "user") -> Project:
        project = self.load_or_create(workspace_path)
        if 0 <= project.current_stage_index < len(project.stages):
            cur = project.stages[project.current_stage_index]
            if cur.status == "running":
                cur.status = "aborted"
                cur.ended_at = _now_iso()
        project.state = "aborted"
        self.save(project)
        self.append_event(
            workspace_path,
            {"event": "pipeline_abort", "reason": reason, "project_id": project.id},
            log_file_name=project.log_file_name,
        )
        return project

    def record_pane_event(
        self,
        workspace_path: str,
        *,
        event_type: str,
        pane_id: str,
        agent: str = "",
        role: str = "",
        origin: str = "manual",
        details: dict[str, Any] | None = None,
        log_file_name: str = "",
    ) -> None:
        """Lightweight event-only log entry (no project.json update)."""
        body: dict[str, Any] = {
            "event": event_type,
            "pane_id": pane_id,
            "agent": agent,
            "role": role,
            "origin": origin,
        }
        if details:
            body["details"] = details
        self.append_event(workspace_path, body, log_file_name=log_file_name)
