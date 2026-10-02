"""watchdog ``Observer`` whose macOS FSEvents path does not leak.

watchdog 6.0.0's FSEvents extension (``_watchdog_fsevents``) leaks on every
callback: ``watchdog_FSEventStreamCallback`` never releases the four lists it
passes to Python, so every path / inode / flags / id in them stays alive, and
``NativeEvent``'s ``tp_dealloc`` never calls ``tp_free``, so every event object
built from them stays allocated too — about 370 bytes per raw filesystem event.
An FSEvents stream sees every event under its root even for a non-recursive
watch, and the credential watch on ``~/.claude.json`` roots one at $HOME, so
the backend's heap grew with all filesystem activity in the home directory
(#144).

The emitter below builds a pure-Python stand-in for ``NativeEvent`` and empties
the lists once it is done with them, which frees what they hold; only the four
empty list shells per callback remain. Upstream master (checked 2026-10-02)
added just ``Py_XDECREF(callback_result)`` — drop this module once a watchdog
release frees the lists and the event objects.

Wherever watchdog picks another observer, this is that default ``Observer``.
"""

from __future__ import annotations

import logging

from watchdog.observers import Observer

__all__ = ["Observer"]

log = logging.getLogger("agent_team_backend.fs_observer")

# Keyed on the observer watchdog chose, not the platform: only the FSEvents
# one goes through the leaking extension.
if Observer.__module__ == "watchdog.observers.fsevents":
    from watchdog.observers.api import DEFAULT_OBSERVER_TIMEOUT, BaseObserver
    from watchdog.observers.fsevents import FSEventsEmitter, FSEventsObserver

    # kFSEventStreamEventFlag* (CoreServices FSEvents.h), the bits
    # NativeEvent exposes as properties.
    _MUST_SCAN_SUBDIRS = 0x1
    _USER_DROPPED = 0x2
    _KERNEL_DROPPED = 0x4
    _EVENT_IDS_WRAPPED = 0x8
    _HISTORY_DONE = 0x10
    _ROOT_CHANGED = 0x20
    _MOUNT = 0x40
    _UNMOUNT = 0x80
    _CREATED = 0x100
    _REMOVED = 0x200
    _INODE_META_MOD = 0x400
    _RENAMED = 0x800
    _MODIFIED = 0x1000
    _FINDER_INFO_MOD = 0x2000
    _CHANGE_OWNER = 0x4000
    _XATTR_MOD = 0x8000
    _IS_FILE = 0x10000
    _IS_DIR = 0x20000
    _IS_SYMLINK = 0x40000
    _OWN_EVENT = 0x80000
    _IS_HARDLINK = 0x100000
    _IS_LAST_HARDLINK = 0x200000
    _CLONED = 0x400000

    _COALESCED_MASKS = (
        _CREATED | _REMOVED,
        _CREATED | _RENAMED,
        _REMOVED | _RENAMED,
    )

    def _flag(bit: int) -> property:
        return property(lambda self: bool(self.flags & bit))

    class _Event:
        """Same read surface as ``_watchdog_fsevents.NativeEvent``, but an
        ordinary Python object, so it is actually freed."""

        __slots__ = ("path", "inode", "flags", "event_id")

        def __init__(self, path: str, inode: object, flags: int, event_id: int) -> None:
            self.path = path
            self.inode = inode
            self.flags = flags
            self.event_id = event_id

        @property
        def is_coalesced(self) -> bool:
            return any(self.flags & mask == mask for mask in _COALESCED_MASKS)

        must_scan_subdirs = _flag(_MUST_SCAN_SUBDIRS)
        is_user_dropped = _flag(_USER_DROPPED)
        is_kernel_dropped = _flag(_KERNEL_DROPPED)
        is_event_ids_wrapped = _flag(_EVENT_IDS_WRAPPED)
        is_history_done = _flag(_HISTORY_DONE)
        is_root_changed = _flag(_ROOT_CHANGED)
        is_mount = _flag(_MOUNT)
        is_unmount = _flag(_UNMOUNT)
        is_created = _flag(_CREATED)
        is_removed = _flag(_REMOVED)
        is_inode_meta_mod = _flag(_INODE_META_MOD)
        is_renamed = _flag(_RENAMED)
        is_modified = _flag(_MODIFIED)
        is_item_finder_info_modified = _flag(_FINDER_INFO_MOD)
        is_owner_change = _flag(_CHANGE_OWNER)
        is_xattr_mod = _flag(_XATTR_MOD)
        is_file = _flag(_IS_FILE)
        is_directory = _flag(_IS_DIR)
        is_symlink = _flag(_IS_SYMLINK)
        is_own_event = _flag(_OWN_EVENT)
        is_hardlink = _flag(_IS_HARDLINK)
        is_last_hardlink = _flag(_IS_LAST_HARDLINK)
        is_cloned = _flag(_CLONED)

        def __repr__(self) -> str:
            return (
                f'NativeEvent(path="{self.path}", inode={self.inode}, '
                f"flags={self.flags:x}, id={self.event_id})"
            )

    class _Emitter(FSEventsEmitter):
        def events_callback(
            self, paths: list, inodes: list, flags: list, ids: list
        ) -> None:
            try:
                events = [
                    _Event(path, inode, event_flags, event_id)
                    for path, inode, event_flags, event_id in zip(paths, inodes, flags, ids)
                ]
                with self._lock:
                    self.queue_events(self.timeout, events)
            except Exception:
                log.exception("Unhandled exception in fsevents callback")
            finally:
                # The extension owns these lists and never releases them.
                paths.clear()
                inodes.clear()
                flags.clear()
                ids.clear()

    class Observer(FSEventsObserver):  # type: ignore[no-redef]
        def __init__(self, *, timeout: float = DEFAULT_OBSERVER_TIMEOUT) -> None:
            BaseObserver.__init__(self, _Emitter, timeout=timeout)
