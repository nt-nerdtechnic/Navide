#!/usr/bin/env python3
"""Give every project back its own run-group ids.

A window that holds several workspaces used to hand the entered one the groups
of the one it was leaving: currentWorkspace changed first and the entered
workspace's groups arrived several awaits later, and a pane spawned in between
was stamped with the LEFT workspace's active tab id — then persisted under the
entered workspace. `ensureSavedGroup` later rebuilt that foreign id there as a
group named `Run N`, which is where the empty tabs came from.

App.vue no longer leaves that window open, but nothing undoes what was already
written: ids are minted as `rg-<epoch ms>`, so an id appearing in two projects
is proof of the leak rather than a collision. This walks every workspace the
app knows about and repairs them:

  * an id used by more than one project stays with the project that minted it
    (its group record's createdAt matches the timestamp inside the id; failing
    that, the project whose earliest pane under it is oldest);
  * every other project gets a freshly minted id for it — rewritten across all
    four places that name a group: ui_run_groups[].id, tab_order,
    ui_active_tab and panes[].run_group_id. Missing one of the four is how you
    turn a shared id into an orphan;
  * unless the group there is an `ensureSavedGroup` artifact — auto-named
    `Run N`, with no live pane left — in which case the record is dropped
    instead of renumbered. A group the user renamed is never dropped, and
    neither is one that still holds panes.

Legitimately empty groups (a tab whose panes have all been closed) are left
alone: an empty tab is not by itself a fault.

Python rather than the repo's usual .mjs because this reads SQLite and needs no
dependency to do it.

Usage:
    python3 scripts/repair-run-group-ids.py                 # dry run, prints the plan
    python3 scripts/repair-run-group-ids.py --apply         # backs up, then writes
    python3 scripts/repair-run-group-ids.py --workspace P   # add a path the app has forgotten

Navide must be closed before --apply: a running window holds these records in
memory and writes them back on its next save.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import time
from dataclasses import dataclass, field

APP_DB = os.path.expanduser(
    "~/Library/Application Support/agent-team/navide.db"
)
AUTO_NAME = re.compile(r"^Run \d+$")


def run_group_created_at(gid: str) -> int | None:
    """The minting time inside an `rg-<epoch ms>` id, or None for other shapes."""
    if not gid.startswith("rg-"):
        return None
    try:
        stamp = int(gid[3:])
    except ValueError:
        return None
    return stamp if stamp > 0 else None


@dataclass
class Project:
    path: str
    db: str
    data: dict
    groups: list[dict] = field(default_factory=list)
    changed: bool = False

    @property
    def live_panes(self) -> list[dict]:
        return [
            p
            for p in self.data.get("panes") or []
            if p.get("spawn_status") == "spawned" and not p.get("removed_at")
        ]

    def live_count(self, gid: str) -> int:
        return sum(1 for p in self.live_panes if p.get("run_group_id") == gid)

    def earliest_pane_at(self, gid: str) -> str:
        stamps = [
            p.get("spawned_at") or ""
            for p in self.data.get("panes") or []
            if p.get("run_group_id") == gid
        ]
        stamps = [s for s in stamps if s]
        return min(stamps) if stamps else "9999"


def read_project(path: str) -> Project | None:
    db = os.path.join(path, ".agent-team", "navide.db")
    if not os.path.exists(db):
        return None
    try:
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        row = con.execute("select value from kv where key='project'").fetchone()
        con.close()
    except sqlite3.Error as err:
        print(f"  ! {path}: cannot read ({err})")
        return None
    if not row:
        return None
    try:
        data = json.loads(row[0])
    except json.JSONDecodeError as err:
        print(f"  ! {path}: project row is not JSON ({err})")
        return None
    proj = Project(path=path, db=db, data=data)
    proj.groups = [g for g in (data.get("ui_run_groups") or []) if isinstance(g, dict)]
    return proj


def known_workspaces() -> list[str]:
    if not os.path.exists(APP_DB):
        return []
    con = sqlite3.connect(f"file:{APP_DB}?mode=ro", uri=True)
    row = con.execute("select value from kv where key='recent_workspaces'").fetchone()
    con.close()
    if not row:
        return []
    try:
        payload = json.loads(row[0])
    except json.JSONDecodeError:
        return []
    return [
        entry["path"]
        for entry in payload.get("recent") or []
        if isinstance(entry, dict) and entry.get("path")
    ]


def navide_is_running() -> bool:
    try:
        out = subprocess.run(
            ["pgrep", "-f", "Navide.app/Contents/MacOS"],
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError:
        return False
    return bool(out.stdout.strip())


def mint_free_id(seed: int | None, taken: set[str]) -> str:
    """A new id close to the original, so ordering by id time survives."""
    stamp = seed if seed is not None else int(time.time() * 1000)
    while f"rg-{stamp}" in taken:
        stamp += 1
    gid = f"rg-{stamp}"
    taken.add(gid)
    return gid


def reassign(proj: Project, old: str, new: str) -> None:
    for group in proj.groups:
        if group.get("id") == old:
            group["id"] = new
    proj.data["tab_order"] = [
        new if t == old else t for t in (proj.data.get("tab_order") or [])
    ]
    if proj.data.get("ui_active_tab") == old:
        proj.data["ui_active_tab"] = new
    for pane in proj.data.get("panes") or []:
        if pane.get("run_group_id") == old:
            pane["run_group_id"] = new
    proj.changed = True


def drop_group(proj: Project, gid: str) -> None:
    proj.groups = [g for g in proj.groups if g.get("id") != gid]
    proj.data["ui_run_groups"] = proj.groups
    proj.data["tab_order"] = [
        t for t in (proj.data.get("tab_order") or []) if t != gid
    ]
    if proj.data.get("ui_active_tab") == gid:
        proj.data["ui_active_tab"] = proj.groups[-1]["id"] if proj.groups else ""
    proj.changed = True


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--apply", action="store_true", help="write the changes (default: dry run)")
    ap.add_argument("--workspace", action="append", default=[], help="extra workspace path")
    ap.add_argument("--force", action="store_true", help="write even if Navide seems to be running")
    args = ap.parse_args()

    paths: list[str] = []
    for path in known_workspaces() + args.workspace:
        path = os.path.expanduser(path.rstrip("/"))
        if path not in paths:
            paths.append(path)
    if not paths:
        print("No workspaces found. Pass --workspace <path>.")
        return 1

    projects: list[Project] = []
    for path in paths:
        proj = read_project(path)
        if proj:
            projects.append(proj)
    print(f"Read {len(projects)} project(s) of {len(paths)} known workspace(s).\n")

    # Which projects still SHOW each id — a group record, or a live pane that
    # would have one rebuilt for it. Dead pane rows naming an id are history:
    # restore only ever brings back panes whose spawn_status is 'spawned', so
    # they resurrect nothing and rewriting them would be churn for no change.
    owners: dict[str, list[Project]] = {}
    taken: set[str] = set()
    for proj in projects:
        taken |= {g.get("id") for g in proj.groups if g.get("id")}
        taken |= {
            p.get("run_group_id")
            for p in proj.data.get("panes") or []
            if p.get("run_group_id")
        }
        shown = {g.get("id") for g in proj.groups if g.get("id")}
        shown |= {p.get("run_group_id") for p in proj.live_panes if p.get("run_group_id")}
        for gid in shown:
            # An id with no epoch inside it proves nothing: `rg-default` is the
            # fixed id every workspace opens with, and every project having one
            # is the design, not a leak.
            if run_group_created_at(gid) is None:
                continue
            owners.setdefault(gid, []).append(proj)

    shared = {gid: ps for gid, ps in owners.items() if len(ps) > 1}
    if not shared:
        print("No id is used by more than one project — nothing to repair.")
        return 0

    print(f"{len(shared)} id(s) used by more than one project:\n")
    for gid, holders in sorted(shared.items()):
        minted = run_group_created_at(gid)

        def name_of(proj: Project, gid: str = gid) -> str:
            return next(
                (str(g.get("name", "")) for g in proj.groups if g.get("id") == gid),
                "(no record)",
            )

        # Who keeps the id is arbitrary — ids are opaque and every reference is
        # rewritten together — so the rule only has to be deterministic and to
        # disturb the least. A name the user chose is the strongest evidence of
        # real use; createdAt cannot decide it, since adoptOrphanRunGroups
        # rebuilds a leaked record with the timestamp read back out of the id.
        def rank(proj: Project, gid: str = gid) -> tuple[int, int, str]:
            name = name_of(proj)
            named = 0 if (name != "(no record)" and not AUTO_NAME.match(name)) else 1
            return (named, -proj.live_count(gid), proj.path)

        keeper = min(holders, key=rank)
        print(f"  {gid}")
        print(f"    keep in : {keeper.path}  [{name_of(keeper)}]")
        for proj in holders:
            if proj is keeper:
                continue
            name = name_of(proj)
            live = proj.live_count(gid)
            record = next((g for g in proj.groups if g.get("id") == gid), None)
            if record is not None and live == 0 and AUTO_NAME.match(str(name)):
                print(f"    drop in : {proj.path}  [{name}] — auto-named, no live pane")
                drop_group(proj, gid)
            else:
                new = mint_free_id(minted, taken)
                where = "no record" if record is None else f"[{name}]"
                print(f"    re-id in: {proj.path}  {where} → {new}  ({live} live pane(s))")
                reassign(proj, gid, new)
        print()

    changed = [p for p in projects if p.changed]
    if not changed:
        print("Nothing to write.")
        return 0

    if not args.apply:
        print(f"Dry run. {len(changed)} project(s) would be rewritten. Re-run with --apply.")
        return 0

    if navide_is_running() and not args.force:
        print(
            "Navide looks like it is running. Close it first — an open window holds\n"
            "these records in memory and writes them back on its next save.\n"
            "(--force overrides.)"
        )
        return 1

    stamp = time.strftime("%Y%m%d-%H%M%S")
    for proj in changed:
        backup = f"{proj.db}.bak-{stamp}"
        shutil.copy2(proj.db, backup)
        proj.data["ui_run_groups"] = proj.groups
        con = sqlite3.connect(proj.db)
        con.execute(
            "update kv set value=?, updated_at=? where key='project'",
            (json.dumps(proj.data, ensure_ascii=False), int(time.time())),
        )
        con.commit()
        con.close()
        print(f"  wrote {proj.path}  (backup: {os.path.basename(backup)})")
    print(f"\nRewrote {len(changed)} project(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
