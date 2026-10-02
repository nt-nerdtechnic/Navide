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


def test_callback_releases_the_reference_the_extension_leaks(tmp_path: Path) -> None:
    import ctypes
    from watchdog.observers.api import ObservedWatch

    from agent_team_backend.fs_observer import _Emitter

    emitter = _Emitter(queue.Queue(), ObservedWatch(str(tmp_path), recursive=True))
    lists = [[str(tmp_path / "x")], [1], [0x100 | 0x10000], [1]]
    baseline = [sys.getrefcount(lst) for lst in lists]
    # What `watchdog_FSEventStreamCallback` does: it owns one reference to
    # each list and never drops it, so every callback left four lists behind.
    for lst in lists:
        ctypes.pythonapi.Py_IncRef(ctypes.py_object(lst))
    del lst

    emitter._extension_callback(*lists)

    assert [sys.getrefcount(lst) for lst in lists] == baseline


def _churn(watched: Path, seen: list[str], ops: int, tag: str) -> None:
    deleted = seen.count("deleted")
    for i in range(ops):
        p = watched / f"{tag}{i}.json"
        p.write_text("{}")
        os.remove(p)
        if i % 20 == 0:
            time.sleep(0.02)
    # Settled means nothing new for a whole second — events still queued for
    # dispatch at snapshot time would read as retained memory.
    deadline = time.monotonic() + 60
    last = -1
    while time.monotonic() < deadline and len(seen) != last:
        last = len(seen)
        time.sleep(1.0)
    assert seen.count("deleted") - deleted >= ops // 2, "the observer stopped delivering events"


def _watchdog_bytes(snapshot: tracemalloc.Snapshot) -> int:
    """Bytes allocated by watchdog or fs_observer code — exact paths, since a
    loose pattern also takes in this file, whose own lists grow meanwhile."""
    import watchdog

    from agent_team_backend import fs_observer

    only = [
        tracemalloc.Filter(True, os.path.join(os.path.dirname(watchdog.__file__), "*")),
        tracemalloc.Filter(True, fs_observer.__file__),
    ]
    return sum(stat.size for stat in snapshot.filter_traces(only).statistics("filename"))


def test_observed_events_do_not_accumulate(tmp_path: Path) -> None:
    """Retention is measured between two windows after a warm-up, so a fixed
    residue (first batches, allocator caches) cancels out whatever the batch
    sizes, which shrink on a loaded machine — while anything retained per
    event or per callback still shows up in full."""
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
    ops = 2000
    try:
        time.sleep(1.0)
        _churn(watched, seen, 1000, "warm")
        _churn(watched, seen, ops, "a")
        gc.collect()
        start = _watchdog_bytes(tracemalloc.take_snapshot())
        _churn(watched, seen, ops, "b")
        gc.collect()
        end = _watchdog_bytes(tracemalloc.take_snapshot())
    finally:
        tracemalloc.stop()
        observer.stop()
        observer.join()

    # Unpatched: ~390 bytes per create+delete; leaking only the four list
    # shells per callback: tens of bytes, more the smaller the batches.
    assert (end - start) / ops < 10, f"{(end - start) / ops:.0f} bytes retained per operation"


def test_a_missing_py_decref_degrades_instead_of_breaking_import(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """The frozen backend's interpreter may not expose Py_DecRef through
    ctypes.pythonapi; the backend must still start and still watch files."""
    import ctypes
    import importlib.util

    from watchdog.events import FileSystemEventHandler

    from agent_team_backend import fs_observer

    class _NoSymbols:
        def __getattr__(self, name: str) -> object:
            raise AttributeError(f"dlsym(RTLD_DEFAULT, {name}): symbol not found")

    monkeypatch.setattr(ctypes, "pythonapi", _NoSymbols())
    # A separate copy, so the module every watcher already imported is left alone.
    spec = importlib.util.spec_from_file_location("fs_observer_without_pythonapi", fs_observer.__file__)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    with caplog.at_level("WARNING", logger="agent_team_backend.fs_observer"):
        spec.loader.exec_module(module)

    assert module._LEAKS_CALLBACK_LISTS is False
    assert "will not be released" in caplog.text

    seen: list[str] = []

    class _Handler(FileSystemEventHandler):
        def on_any_event(self, event) -> None:  # noqa: ANN001
            seen.append(event.src_path)

    observer = module.Observer()
    observer.schedule(_Handler(), str(tmp_path), recursive=True)
    observer.start()
    try:
        time.sleep(0.5)
        (tmp_path / "after.txt").write_text("x")
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and not any(p.endswith("after.txt") for p in seen):
            time.sleep(0.05)
    finally:
        observer.stop()
        observer.join()
    assert any(p.endswith("after.txt") for p in seen)
