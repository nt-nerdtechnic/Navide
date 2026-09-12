"""Pure helpers over a process-table snapshot, shared by every platform.

`ProcessTree.snapshot()` gives `pid -> ProcInfo`; these two turn that into a
parent-to-children index and walk it. They are platform-independent, which is
why they live here rather than in `_posix`: `terminals` walks the same table
the implementations do, and duplicating the walk per platform would be the
first thing to drift.
"""

from __future__ import annotations

from .spec import ProcInfo


def children_map(snap: dict[int, ProcInfo]) -> dict[int, list[int]]:
    """`ppid -> [child pids]` for one snapshot."""
    children: dict[int, list[int]] = {}
    for pid, entry in snap.items():
        children.setdefault(entry[0], []).append(pid)
    return children


def walk_descendants(children: dict[int, list[int]], root_pid: int) -> list[int]:
    """Every pid below `root_pid` in the index, root itself excluded.

    Defends against a recycled-pid cycle in the table: a pid is visited once
    and the root is never re-listed even if a stale row points back at it.
    """
    found: list[int] = []
    seen: set[int] = {root_pid}  # never re-list root itself if a cycle points back
    stack = list(children.get(root_pid, []))
    while stack:
        pid = stack.pop()
        if pid in seen:
            continue  # defends against a recycled-pid cycle in the ps table
        seen.add(pid)
        found.append(pid)
        stack.extend(children.get(pid, []))
    return found
