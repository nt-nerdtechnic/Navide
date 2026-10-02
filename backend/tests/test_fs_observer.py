"""fs_observer: a watchdog Observer whose macOS FSEvents path does not leak.

watchdog 6.0.0's `_watchdog_fsevents` never releases the lists it hands to the
Python callback, nor the `NativeEvent` objects built from them — about 370
bytes for every raw filesystem event under any watched root (#144).
"""

from __future__ import annotations

import gc
import os
import queue
import sys
import time
import tracemalloc
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(sys.platform != "darwin", reason="FSEvents is macOS-only")


def _flag_names() -> list[str]:
    import _watchdog_fsevents as _fsevents

    return sorted(
        name for name in dir(_fsevents.NativeEvent)
        if name.startswith("is_") or name == "must_scan_subdirs"
    )


def test_event_stand_in_matches_native_event_for_every_flag() -> None:
    import _watchdog_fsevents as _fsevents

    from agent_team_backend.fs_observer import _Event

    for bit in range(32):
        flags = 1 << bit
        native = _fsevents.NativeEvent("/a/b", 7, flags, 9)
        ours = _Event("/a/b", 7, flags, 9)
        for name in _flag_names():
            assert getattr(ours, name) == getattr(native, name), (name, hex(flags))
        assert (ours.path, ours.inode, ours.flags, ours.event_id) == (
            native.path, native.inode, native.flags, native.event_id
        )
    # The coalesced masks combine bits, so check those pairs too.
    created, removed, renamed = 0x100, 0x200, 0x800
    for flags in (created | removed, created | renamed, removed | renamed, created | 0x1000):
        native = _fsevents.NativeEvent("/a", 1, flags, 1)
        assert _Event("/a", 1, flags, 1).is_coalesced == native.is_coalesced


def test_callback_empties_the_lists_the_extension_leaks(tmp_path: Path) -> None:
    from watchdog.events import FileCreatedEvent
    from watchdog.observers.api import ObservedWatch

    from agent_team_backend.fs_observer import _Emitter

    target = tmp_path / "new.txt"
    target.write_text("x")
    events: queue.Queue = queue.Queue()
    emitter = _Emitter(events, ObservedWatch(str(tmp_path), recursive=True))
    paths = [str(target)]
    inodes = [target.stat().st_ino]
    flags = [0x100 | 0x10000]  # ItemCreated | ItemIsFile
    ids = [1]

    emitter.events_callback(paths, inodes, flags, ids)

    # The extension holds these lists forever; emptying them is what frees
    # every path / inode / flags / id they carried.
    assert (paths, inodes, flags, ids) == ([], [], [], [])
    queued = [events.get_nowait()[0] for _ in range(events.qsize())]
    assert any(isinstance(e, FileCreatedEvent) and e.src_path == str(target) for e in queued)


def test_observed_events_do_not_accumulate(tmp_path: Path) -> None:
    from watchdog.events import FileSystemEventHandler

    from agent_team_backend.fs_observer import Observer

    seen: list[str] = []

    class _Handler(FileSystemEventHandler):
        def on_any_event(self, event) -> None:  # noqa: ANN001
            seen.append(event.event_type)

    watched = tmp_path / "w"
    watched.mkdir()
    observer = Observer()
    observer.schedule(_Handler(), str(watched), recursive=True)
    observer.start()
    tracemalloc.start(1)
    try:
        time.sleep(1.0)
        gc.collect()
        before = tracemalloc.take_snapshot()
        ops = 3000
        for i in range(ops):
            p = watched / f"t{i}.json"
            p.write_text("{}")
            os.remove(p)
            if i % 20 == 0:
                time.sleep(0.02)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and seen.count("deleted") < ops // 2:
            time.sleep(0.2)
        time.sleep(1.0)
        gc.collect()
        after = tracemalloc.take_snapshot()
    finally:
        tracemalloc.stop()
        observer.stop()
        observer.join()

    assert seen.count("deleted") >= ops // 2, "the observer stopped delivering events"
    watchdog_only = [tracemalloc.Filter(True, "*watchdog*"), tracemalloc.Filter(True, "*fs_observer*")]
    retained = sum(
        stat.size_diff
        for stat in after.filter_traces(watchdog_only).compare_to(
            before.filter_traces(watchdog_only), "filename"
        )
    )
    # Unpatched: ~390 bytes retained per create+delete. What is left is the
    # four emptied list shells per callback the extension never frees.
    assert retained / ops < 100, f"{retained / ops:.0f} bytes retained per operation"
