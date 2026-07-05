"""File-system watcher that polls registered LogReaders for new token events.

Uses `watchdog` for change notifications, with a periodic full-rescan
fallback (default 30s) to recover from missed events (network mounts,
edge-case file ops). On each change, the watcher calls the matching
reader's parse_session_file(), passing in the per-file `seen_keys` so
streaming chunks aren't double-counted.

Architecture:

    LogWatcher.start()
        ├─ observer (watchdog Observer) — async file events → enqueue(path)
        ├─ rescan loop (asyncio) — every N s → enqueue all session files
        └─ drain loop (asyncio) — pop queue → reader.parse_session_file()
                                            → emit each TokenUsage to sink

The sink callback runs on the asyncio loop. It MUST be fast (just enqueue
to tokens_store + broadcast); long work blocks the drain.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from collections.abc import Awaitable, Callable
from pathlib import Path

from watchdog.events import FileSystemEvent, FileSystemEventHandler
from watchdog.observers import Observer

from ..applog import app_data_dir
from .base import ActivityEvent, LogReader, TokenUsage

log = logging.getLogger("agent_team_backend.log_readers.watcher")

TokenSink = Callable[[TokenUsage], Awaitable[None]]
ActivitySink = Callable[[ActivityEvent], Awaitable[None]]
SessionSink = Callable[[str, Path], Awaitable[None]]  # (vendor, file_path)


class _Handler(FileSystemEventHandler):
    """watchdog event handler → push affected paths onto an asyncio queue."""

    def __init__(self, on_path: Callable[[Path], None]) -> None:
        super().__init__()
        self._on_path = on_path

    def on_modified(self, event: FileSystemEvent) -> None:
        if event.is_directory:
            return
        s = str(event.src_path)
        # Antigravity conversations are SQLite: live writes land in the -wal
        # journal first, so accept it but enqueue the canonical .db path.
        if s.endswith(".db-wal"):
            self._on_path(Path(s[: -len("-wal")]))
            return
        # .db = Antigravity.
        if not s.endswith((".jsonl", ".json", ".db")):
            return
        self._on_path(Path(s))

    def on_created(self, event: FileSystemEvent) -> None:
        self.on_modified(event)


class LogWatcher:
    """Orchestrates one Observer + multiple LogReaders.

    Lifecycle: `start()` spawns the watchdog observer + an asyncio drain
    task. `stop()` shuts both down cleanly. Safe to call start() twice
    (subsequent calls are no-ops).
    """

    def __init__(
        self,
        sink: TokenSink,
        *,
        activity_sink: ActivitySink | None = None,
        session_sink: SessionSink | None = None,
        rescan_interval_s: float = 30.0,
        seen_path: Path | None = None,
        save_interval_s: float = 10.0,
        workspace_provider: Callable[[], list[str]] | None = None,
    ) -> None:
        self._sink = sink
        # Returns the workspaces the user has actually opened. Periodic/startup
        # backfill is scoped to these so we never re-stat the entire multi-GB
        # CLI history every cycle. None → legacy full scan.
        self._workspace_provider = workspace_provider
        self._activity_sink = activity_sink
        self._session_sink = session_sink
        self._rescan_interval_s = rescan_interval_s
        self._save_interval_s = save_interval_s
        # Persistent dedup state: file path -> set of dedup keys we've already
        # emitted to tokens_store. Survives backend restarts so we don't
        # re-credit historic events every time `pnpm dev` runs.
        self._seen_path = seen_path or (app_data_dir() / "log-readers-seen.json")
        self._readers: list[LogReader] = []
        self._seen_keys: dict[str, set[str]] = {}
        # Activity dedup is in-memory only (lifetime-bound). On restart, we
        # only emit *new* activity since the last seen line, but we don't try
        # to "replay" history — old events have no semantic value to a
        # newly-started watcher anyway.
        self._activity_seen: dict[str, set[str]] = {}
        self._scan_mtimes: dict[str, float] = {}
        self._save_pending = False
        self._queue: asyncio.Queue[Path] = asyncio.Queue()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._observer: Observer | None = None
        self._drain_task: asyncio.Task[None] | None = None
        self._rescan_task: asyncio.Task[None] | None = None
        self._save_task: asyncio.Task[None] | None = None
        self._watched_dirs: set[Path] = set()
        self._started = False

    def add_reader(self, reader: LogReader) -> None:
        self._readers.append(reader)

    # ───────────────────────── lifecycle ──────────────────────────────────

    # ───────────────────────── seen-keys persistence ───────────────────────

    def _load_seen(self) -> None:
        try:
            data = json.loads(self._seen_path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return
        except (OSError, json.JSONDecodeError) as err:
            log.warning("seen-keys file unreadable (%s); starting empty", err)
            return
        if not isinstance(data, dict):
            return
        for path_str, keys in data.items():
            if isinstance(keys, list):
                self._seen_keys[path_str] = set(str(k) for k in keys)
        total = sum(len(v) for v in self._seen_keys.values())
        log.info(
            "loaded seen_keys: %d files, %d total keys", len(self._seen_keys), total
        )

    def _save_seen(self) -> None:
        try:
            self._seen_path.parent.mkdir(parents=True, exist_ok=True)
            data = {p: sorted(keys) for p, keys in self._seen_keys.items()}
            tmp = self._seen_path.with_suffix(self._seen_path.suffix + ".tmp")
            tmp.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
            os.replace(tmp, self._seen_path)
        except OSError as err:
            log.warning("seen-keys save failed: %s", err)

    def start(self) -> None:
        if self._started:
            return
        self._started = True
        self._load_seen()
        self._loop = asyncio.get_event_loop()
        self._observer = Observer()

        # Bridge watchdog (synchronous) thread → asyncio queue (main thread).
        def on_path(p: Path) -> None:
            loop = self._loop
            if loop is None or loop.is_closed():
                return
            try:
                loop.call_soon_threadsafe(self._queue.put_nowait, p)
            except RuntimeError:
                # loop closed mid-flight
                pass

        handler = _Handler(on_path)

        # Watch every existing watch root from every reader. Skip duplicates.
        # Most readers watch the same dirs they scan; Codex also watches the
        # stable ~/.codex-panes parent because per-pane session dirs appear
        # after the backend has already started.
        for reader in self._readers:
            for d in reader.watch_dirs():
                if d in self._watched_dirs or not d.exists():
                    continue
                try:
                    self._observer.schedule(handler, str(d), recursive=True)
                    self._watched_dirs.add(d)
                    log.info("watching %s for %s logs", d, reader.vendor)
                except Exception as err:  # noqa: BLE001
                    log.warning("schedule watch on %s failed: %s", d, err)

        self._observer.start()
        self._drain_task = asyncio.create_task(self._drain_loop(), name="logwatcher.drain")
        self._rescan_task = asyncio.create_task(self._rescan_loop(), name="logwatcher.rescan")
        self._save_task = asyncio.create_task(self._save_loop(), name="logwatcher.save")
        log.info(
            "LogWatcher started · %d reader(s) · %d dir(s) · rescan %.0fs",
            len(self._readers), len(self._watched_dirs), self._rescan_interval_s,
        )

    def stop(self) -> None:
        if not self._started:
            return
        self._started = False
        for t in (self._drain_task, self._rescan_task, self._save_task):
            if t:
                t.cancel()
        if self._observer:
            self._observer.stop()
            try:
                self._observer.join(timeout=2.0)
            except Exception:  # noqa: BLE001
                pass
        # Final flush so newest seen_keys make it to disk before exit.
        self._save_seen()
        log.info("LogWatcher stopped")

    # ───────────────────────── workers ────────────────────────────────────

    async def _drain_loop(self) -> None:
        """Pop file paths, route to the right reader, emit events."""
        while True:
            try:
                path = await self._queue.get()
            except asyncio.CancelledError:
                return
            try:
                await self._process_path(path)
            except Exception as err:  # noqa: BLE001
                log.warning("processing %s failed: %s", path, err)

    async def _save_loop(self) -> None:
        """Persist seen_keys to disk whenever a parse marked the state dirty."""
        while True:
            try:
                await asyncio.sleep(self._save_interval_s)
            except asyncio.CancelledError:
                return
            if self._save_pending:
                # Take a snapshot on the event loop thread (no concurrent
                # mutation here — asyncio is single-threaded at this point)
                # before handing off to a worker thread for the actual I/O.
                snapshot = {p: sorted(keys) for p, keys in self._seen_keys.items()}
                self._save_pending = False
                await asyncio.to_thread(self._write_snapshot, snapshot)

    def _write_snapshot(self, snapshot: dict[str, list[str]]) -> None:
        try:
            self._seen_path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self._seen_path.with_suffix(self._seen_path.suffix + ".tmp")
            tmp.write_text(json.dumps(snapshot, separators=(",", ":")), encoding="utf-8")
            os.replace(tmp, self._seen_path)
        except OSError as err:
            log.warning("seen-keys save failed: %s", err)

    def force_rescan(self, workspace_path: str | None = None) -> None:
        """Re-enqueue session files for re-parse, ignoring in-memory dedup.

        Used when a new workspace registration means previously-parsed
        session files may now belong to that workspace and need re-counting.
        Event-level dedup at tokens_store level prevents double-counting of
        already-recorded events.

        When `workspace_path` is given, only that workspace's files are
        re-enqueued: readers that map a workspace to a specific folder (Claude)
        return just that subset; readers that can't (Codex by-date) fall back
        to all their files — those vendors keep far fewer files so the cost
        stays bounded. This avoids re-parsing the entire
        (multi-GB) Claude history on every new workspace registration, which
        would saturate the event loop and stall the whole backend.

        Without `workspace_path`, every file from every reader is re-enqueued
        (legacy full rescan).
        """
        if self._loop is None or self._loop.is_closed():
            return
        files: list[Path] = []
        for reader in self._readers:
            scoped = (
                reader.session_files_for_workspace(workspace_path)
                if workspace_path
                else None
            )
            files.extend(scoped if scoped is not None else reader.session_files())
        # Clear in-memory dedup only for the files we're about to re-parse, so
        # other workspaces' caches survive (avoids needlessly re-emitting them
        # later). Persisted seen.json is left alone (it's a perf cache; the
        # tokens_store dedup is the correctness gate).
        for f in files:
            self._seen_keys.pop(str(f.resolve()), None)
        for p in files:
            try:
                self._loop.call_soon_threadsafe(self._queue.put_nowait, p)
            except RuntimeError:
                return
        log.info(
            "force_rescan: queued %d file(s) for re-parse%s",
            len(files),
            f" (workspace={workspace_path})" if workspace_path else " (all readers)",
        )

    def _candidate_files(self) -> list[Path]:
        """Backfill candidates scoped to opened workspaces (no mtime filter).

        When a workspace_provider is set we only enumerate files belonging to
        the workspaces the user has actually opened (readers that can't map a
        workspace to a subset fall back to their full list — those vendors keep
        far fewer files). No provider / nothing registered yet → full scan
        (legacy).
        """
        provider = self._workspace_provider
        workspaces = list(provider()) if provider else []
        if not workspaces:
            files: list[Path] = []
            for reader in self._readers:
                files.extend(reader.session_files())
            return files
        files = []
        seen: set[str] = set()
        for reader in self._readers:
            for ws in workspaces:
                scoped = reader.session_files_for_workspace(ws)
                cand = scoped if scoped is not None else reader.session_files()
                for p in cand:
                    k = str(p)
                    if k not in seen:
                        seen.add(k)
                        files.append(p)
        return files

    def _files_to_scan(self) -> list[Path]:
        """Backfill candidates whose mtime changed since the last sweep.

        Workspace scoping (_candidate_files) bounds which files we look at;
        this mtime gate stops us from re-enqueueing unchanged files. Without
        it every 30-second cycle re-reads every workspace session file —
        including 100 MB+ Claude histories — saturating the drain task.
        """
        out: list[Path] = []
        for p in self._candidate_files():
            try:
                mtime = p.stat().st_mtime
            except OSError:
                continue
            k = str(p)
            if self._scan_mtimes.get(k) == mtime:
                continue
            self._scan_mtimes[k] = mtime
            out.append(p)
        return out

    async def _rescan_loop(self) -> None:
        """Periodically re-enqueue session files for opened workspaces.

        Catches watchdog misses (e.g. on network FS where INotify isn't
        delivered) and brand-new files since startup. Scope comes from
        _files_to_scan() so this never walks the whole CLI history.
        """
        # First scan happens immediately (initial backfill).
        delay = 0.5
        while True:
            try:
                await asyncio.sleep(delay)
            except asyncio.CancelledError:
                return
            for p in self._files_to_scan():
                self._queue.put_nowait(p)
            delay = self._rescan_interval_s

    async def _process_path(self, path: Path) -> None:
        reader = self._reader_for(path)
        if reader is None:
            return
        # Session-id capture for resume (Codex/Antigravity). Runs
        # independent of token parsing so it works even for session-file formats
        # the token reader doesn't (yet) understand — it only needs the file to
        # exist + contain the pane marker.
        if self._session_sink is not None and reader.vendor in ("codex", "antigravity"):
            try:
                await self._session_sink(reader.vendor, path)
            except Exception as err:  # noqa: BLE001
                log.warning("session sink raised: %s", err)
        key = str(path.resolve())
        seen = self._seen_keys.setdefault(key, set())
        # parse_session_file is sync; run it in a thread to avoid blocking
        # the event loop on large files.
        try:
            events = await asyncio.to_thread(reader.parse_session_file, path, seen)
        except FileNotFoundError:
            return
        except Exception as err:  # noqa: BLE001
            log.warning("parse %s (%s) failed: %s", path, reader.vendor, err)
            return
        for ev in events:
            try:
                await self._sink(ev)
            except Exception as err:  # noqa: BLE001
                log.warning("token sink raised: %s", err)
        if events:
            # Mark for next periodic save; immediate save would thrash on
            # startup backfill where 200+ files emit events back-to-back.
            self._save_pending = True

        # Activity parsing runs on the same file but with its own dedup set.
        if self._activity_sink is not None:
            act_seen = self._activity_seen.setdefault(key, set())
            try:
                activity_events = await asyncio.to_thread(
                    reader.parse_activity, path, act_seen
                )
            except FileNotFoundError:
                return
            except Exception as err:  # noqa: BLE001
                log.warning("parse_activity %s (%s) failed: %s", path, reader.vendor, err)
                return
            for aev in activity_events:
                try:
                    await self._activity_sink(aev)
                except Exception as err:  # noqa: BLE001
                    log.warning("activity sink raised: %s", err)

    def _reader_for(self, path: Path) -> LogReader | None:
        s = str(path.resolve())
        for reader in self._readers:
            for d in reader.project_dirs():
                try:
                    if s.startswith(str(d.resolve()) + "/"):
                        return reader
                except OSError:
                    continue
        return None
