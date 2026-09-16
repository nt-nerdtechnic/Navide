"""Cross-device sync for the Settings → INTEGRATIONS sections.

The wire contract is ``docs/en-US/cloud-sync-protocol.md``; this module is the
client half of it. It knows nothing about prompts, MCP servers or skills — a
*scope adapter* supplies "what does this machine currently hold" and "write
this in", and everything below treats both as opaque JSON.

**The engine never merges and never picks a winner.** That is the decision the
approved plan records: two devices editing the same item produce a conflict
row and a question for the user, not a silent overwrite. Three places enforce
it and all three are needed — a push carries the ``rev`` it is editing from so
the server can refuse a stale write, a pull refuses to apply over local edits
it has not seen pushed, and an item with an unresolved conflict is skipped by
both directions until the user answers.

**A missing key is not a reason to sync in the clear.** Bodies go through
``sync_keyring``, which has no plaintext path; a machine that has not yet been
handed the account key syncs nothing rather than uploading readable records.

**Nothing here can break the app.** Every entry point is called from the link's
own task and every failure is logged and swallowed by the caller: sync is a
convenience laid over state that is already correct on disk.

**The blocking half runs off the loop.** A round reads every skill's file tree
and every instruction file, encrypts each record, and touches SQLite — none of
which is async, and all of which happens inside the backend's own event loop
task. ``loop_watchdog`` calls a 2-second stall a fault and says so in the log,
and a user with a few large instruction files would reach that on an ordinary
sync. So the per-item work is handed to a worker thread in whole batches: one
hop per pull page and one per push, rather than one per item, because the hop
is only worth making if it carries real work.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Protocol

from . import device_signing, sync_keyring
from .db import Database

log = logging.getLogger("agent_team_backend.sync_engine")

_COMPONENT = "sync"

#: The scopes the protocol defines. Anything else is refused before it reaches
#: the wire, so a typo in an adapter cannot create a private fifth scope that
#: only one build knows about.
SCOPES: tuple[str, ...] = ("prompts", "mcp", "skills", "memory")

#: Matches the server's cap. Larger batches are split, not rejected.
PUSH_BATCH = 64
PULL_PAGE = 200
#: A push is one WebSocket frame and the server's ``maxPayload`` is 1 MiB, so
#: the frame — not the item — is the real limit. Both numbers sit under it with
#: room for the envelope, and they are measured on the base64 body as stored,
#: because the server is forbidden to decode it to find out how big it is.
MAX_BODY_BYTES = 512 * 1024
MAX_PUSH_BYTES = 768 * 1024

KEEP_LOCAL = "local"
KEEP_REMOTE = "remote"

#: How one item's two halves stand in an inventory listing.
STATE_IN_SYNC = "in-sync"
STATE_LOCAL_ONLY = "local-only"
STATE_REMOTE_ONLY = "remote-only"
STATE_DIVERGED = "diverged"
STATE_CONFLICT = "conflict"

#: Whether a scope's cloud half could be listed at all. Kept apart from the
#: items because "nothing is up there" and "this machine could not look" are
#: different answers, and a pane that shows an empty list for both asks people
#: to re-upload what is already synced.
INVENTORY_OK = "ok"
INVENTORY_NO_KEY = "no-key"
INVENTORY_NOT_CONNECTED = "not-connected"
INVENTORY_ERROR = "error"
INVENTORY_UNKNOWN_SCOPE = "unknown-scope"


class SyncError(Exception):
    """A sync round could not be completed. Always recoverable by retrying."""


class ScopeAdapter(Protocol):
    """One Settings section's view of itself as syncable items."""

    scope: str

    def snapshot(self) -> dict[str, Any]:
        """Every item this machine holds right now, by stable item id."""

    def apply(self, item_id: str, payload: Any | None) -> None:
        """Write one incoming item in, or remove it when payload is None."""


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def canonical(payload: Any) -> str:
    """The exact bytes a body hashes and encrypts as.

    Sorted keys and no whitespace, so two devices that built the same value in
    a different order agree that it is the same value — otherwise every sync
    would rediscover a difference that is not there and push forever.
    """
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def digest(payload: Any) -> str:
    return hashlib.sha256(canonical(payload).encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class ItemState:
    """What this machine and the server last agreed on for one item."""

    rev: int
    synced_hash: str
    deleted: bool


def _create_schema(cur: Any) -> None:
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS sync_state (
            scope       TEXT    NOT NULL,
            item_id     TEXT    NOT NULL,
            rev         INTEGER NOT NULL,
            synced_hash TEXT    NOT NULL,
            deleted     INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (scope, item_id)
        )
        """
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS sync_cursor (
            scope  TEXT    PRIMARY KEY,
            cursor INTEGER NOT NULL
        )
        """
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS sync_conflicts (
            scope         TEXT    NOT NULL,
            item_id       TEXT    NOT NULL,
            local_json    TEXT    NOT NULL,
            remote_json   TEXT    NOT NULL,
            remote_rev    INTEGER NOT NULL,
            remote_device TEXT    NOT NULL,
            seen_at       INTEGER NOT NULL,
            PRIMARY KEY (scope, item_id)
        )
        """
    )


class SyncStore:
    """The bookkeeping half: what was agreed, how far we have read, what clashed."""

    def __init__(self, db: Database) -> None:
        self._db = db
        self._db.migrate(_COMPONENT, 1, _create_schema)

    # ── agreed state ────────────────────────────────────────────────────
    def state(self, scope: str, item_id: str) -> ItemState | None:
        with self._db.transaction() as cur:
            row = cur.execute(
                "SELECT rev, synced_hash, deleted FROM sync_state WHERE scope = ? AND item_id = ?",
                (scope, item_id),
            ).fetchone()
        return ItemState(int(row[0]), str(row[1]), bool(row[2])) if row else None

    def states(self, scope: str) -> dict[str, ItemState]:
        with self._db.transaction() as cur:
            rows = cur.execute(
                "SELECT item_id, rev, synced_hash, deleted FROM sync_state WHERE scope = ?",
                (scope,),
            ).fetchall()
        return {
            str(r[0]): ItemState(int(r[1]), str(r[2]), bool(r[3])) for r in rows
        }

    def set_state(
        self, scope: str, item_id: str, *, rev: int, synced_hash: str, deleted: bool
    ) -> None:
        with self._db.transaction() as cur:
            cur.execute(
                """
                INSERT INTO sync_state (scope, item_id, rev, synced_hash, deleted)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(scope, item_id) DO UPDATE SET
                    rev = excluded.rev,
                    synced_hash = excluded.synced_hash,
                    deleted = excluded.deleted
                """,
                (scope, item_id, int(rev), synced_hash, 1 if deleted else 0),
            )

    # ── cursor ──────────────────────────────────────────────────────────
    def cursor(self, scope: str) -> int:
        with self._db.transaction() as cur:
            row = cur.execute(
                "SELECT cursor FROM sync_cursor WHERE scope = ?", (scope,)
            ).fetchone()
        return int(row[0]) if row else 0

    def set_cursor(self, scope: str, value: int) -> None:
        with self._db.transaction() as cur:
            cur.execute(
                """
                INSERT INTO sync_cursor (scope, cursor) VALUES (?, ?)
                ON CONFLICT(scope) DO UPDATE SET cursor = excluded.cursor
                """,
                (scope, int(value)),
            )

    # ── conflicts ───────────────────────────────────────────────────────
    def record_conflict(
        self,
        scope: str,
        item_id: str,
        *,
        local: Any,
        remote: Any,
        remote_rev: int,
        remote_device: str,
    ) -> None:
        with self._db.transaction() as cur:
            cur.execute(
                """
                INSERT INTO sync_conflicts
                    (scope, item_id, local_json, remote_json, remote_rev, remote_device, seen_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(scope, item_id) DO UPDATE SET
                    local_json = excluded.local_json,
                    remote_json = excluded.remote_json,
                    remote_rev = excluded.remote_rev,
                    remote_device = excluded.remote_device,
                    seen_at = excluded.seen_at
                """,
                (
                    scope,
                    item_id,
                    canonical(local),
                    canonical(remote),
                    int(remote_rev),
                    remote_device,
                    int(time.time()),
                ),
            )
        log.info("sync conflict on %s/%s — waiting for the user", scope, item_id)

    def conflicts(self, scope: str | None = None) -> list[dict[str, Any]]:
        sql = (
            "SELECT scope, item_id, local_json, remote_json, remote_rev, remote_device, seen_at "
            "FROM sync_conflicts"
        )
        args: tuple[Any, ...] = ()
        if scope:
            sql += " WHERE scope = ?"
            args = (scope,)
        sql += " ORDER BY seen_at DESC"
        with self._db.transaction() as cur:
            rows = cur.execute(sql, args).fetchall()
        out: list[dict[str, Any]] = []
        for r in rows:
            out.append(
                {
                    "scope": str(r[0]),
                    "itemId": str(r[1]),
                    "local": json.loads(r[2]),
                    "remote": json.loads(r[3]),
                    "remoteRev": int(r[4]),
                    "remoteDevice": str(r[5]),
                    "seenAt": int(r[6]),
                }
            )
        return out

    def conflict_ids(self, scope: str) -> set[str]:
        with self._db.transaction() as cur:
            rows = cur.execute(
                "SELECT item_id FROM sync_conflicts WHERE scope = ?", (scope,)
            ).fetchall()
        return {str(r[0]) for r in rows}

    def clear_conflict(self, scope: str, item_id: str) -> None:
        with self._db.transaction() as cur:
            cur.execute(
                "DELETE FROM sync_conflicts WHERE scope = ? AND item_id = ?", (scope, item_id)
            )

    def forget(self, scope: str) -> None:
        """Drop everything known about a scope — used when it is switched off."""
        with self._db.transaction() as cur:
            cur.execute("DELETE FROM sync_state WHERE scope = ?", (scope,))
            cur.execute("DELETE FROM sync_cursor WHERE scope = ?", (scope,))
            cur.execute("DELETE FROM sync_conflicts WHERE scope = ?", (scope,))


RequestFn = Callable[[str, dict[str, Any]], Awaitable[dict[str, Any]]]


class SyncEngine:
    """Drives one round of pull-then-push per scope."""

    def __init__(
        self,
        store: SyncStore,
        request: RequestFn,
        *,
        device_id: Callable[[], str],
        enabled: Callable[[str], bool],
        signing_key_for: Callable[[str], str] | None = None,
    ) -> None:
        self._store = store
        self._request = request
        self._device_id = device_id
        self._enabled = enabled
        self._signing_key_for = signing_key_for or _pinned_signing_key
        self._adapters: dict[str, ScopeAdapter] = {}

    def register(self, adapter: ScopeAdapter) -> None:
        if adapter.scope not in SCOPES:
            raise SyncError(f"{adapter.scope!r} is not a protocol scope")
        self._adapters[adapter.scope] = adapter

    @property
    def scopes(self) -> list[str]:
        return [s for s in SCOPES if s in self._adapters]

    # ── one round ───────────────────────────────────────────────────────
    async def sync(self, scope: str) -> dict[str, Any]:
        adapter = self._adapters.get(scope)
        if adapter is None:
            raise SyncError(f"no adapter registered for {scope!r}")
        if not self._enabled(scope):
            return {"scope": scope, "skipped": "disabled"}
        if not await asyncio.to_thread(sync_keyring.has_account_key):
            return {"scope": scope, "skipped": "no-key"}
        pulled = await self._pull(adapter)
        pushed = await self._push(adapter)
        return {
            "scope": scope,
            "pulled": pulled,
            "pushed": pushed,
            "conflicts": len(self._store.conflict_ids(scope)),
        }

    async def sync_all(self) -> list[dict[str, Any]]:
        results = []
        for scope in self.scopes:
            try:
                results.append(await self.sync(scope))
            except Exception as err:  # noqa: BLE001 - one bad scope must not stop the rest
                log.warning("sync of %s failed: %s", scope, err)
                results.append({"scope": scope, "error": str(err)})
        return results

    # ── pull ────────────────────────────────────────────────────────────
    async def _pull(self, adapter: ScopeAdapter) -> int:
        scope = adapter.scope
        applied = 0
        while True:
            since = self._store.cursor(scope)
            reply = _payload(
                await self._request("sync.pull", {"scope": scope, "since": since, "limit": PULL_PAGE})
            )
            items = reply.get("items")
            items = items if isinstance(items, list) else []
            applied += await asyncio.to_thread(self._apply_page, adapter, items)
            cursor = int(reply.get("cursor") or since)
            if cursor > since:
                self._store.set_cursor(scope, cursor)
            if not reply.get("more"):
                break
            if cursor <= since:
                # No progress and the server still says "more": stop rather
                # than loop forever on a server that disagrees with itself.
                log.warning("sync.pull on %s made no progress; stopping this round", scope)
                break
        return applied

    def _apply_page(self, adapter: ScopeAdapter, items: list[Any]) -> int:
        """Apply one pull page. Runs in a worker thread; touches disk freely."""
        snapshot = adapter.snapshot()
        blocked = self._store.conflict_ids(adapter.scope)
        return sum(1 for raw in items if self._apply_one(adapter, raw, snapshot, blocked))

    def _apply_one(
        self,
        adapter: ScopeAdapter,
        raw: Any,
        snapshot: dict[str, Any],
        blocked: set[str],
    ) -> bool:
        scope = adapter.scope
        if not isinstance(raw, dict):
            return False
        item_id = str(raw.get("itemId") or "")
        if not item_id or item_id in blocked:
            return False
        rev = int(raw.get("rev") or 0)
        device = str(raw.get("deviceId") or "")
        updated_at = str(raw.get("updatedAt") or "")
        deleted = bool(raw.get("deleted"))
        body = str(raw.get("body") or "")
        if device == self._device_id():
            # Our own write coming back. Record the rev so the next push edits
            # from the right base, but there is nothing to apply.
            state = self._store.state(scope, item_id)
            if state is not None:
                self._store.set_state(
                    scope, item_id, rev=rev, synced_hash=state.synced_hash, deleted=deleted
                )
            return False
        if not self._origin_ok(raw, scope=scope, item_id=item_id):
            log.warning("dropping %s/%s: its signature does not match the pinned key", scope, item_id)
            return False
        try:
            remote = None if deleted else json.loads(
                sync_keyring.decrypt(body, scope=scope, item_id=item_id)
            )
        except Exception as err:  # noqa: BLE001 - an unreadable record is not fatal
            log.warning("dropping %s/%s: %s", scope, item_id, err)
            return False

        state = self._store.state(scope, item_id)
        local = snapshot.get(item_id)
        local_hash = digest(local) if item_id in snapshot else ""
        agreed_hash = state.synced_hash if state else ""
        # Applying over an edit this machine has not pushed yet would lose it.
        # That is the one thing this engine must never do, so it becomes a
        # conflict even though the server was happy to hand the record over.
        if local_hash != agreed_hash:
            self._store.record_conflict(
                scope, item_id, local=local, remote=remote, remote_rev=rev, remote_device=device
            )
            return False
        adapter.apply(item_id, remote)
        self._store.set_state(
            scope,
            item_id,
            rev=rev,
            synced_hash="" if remote is None else digest(remote),
            deleted=remote is None,
        )
        return True

    def _origin_ok(self, raw: dict[str, Any], *, scope: str, item_id: str) -> bool:
        """Whether the record really came from the device it names.

        Trust on first use, the same rule the message path already follows: a
        peer whose signing key has never been pinned is accepted, and one whose
        key no longer matches what was pinned is refused rather than re-pinned.
        """
        device = str(raw.get("deviceId") or "")
        key = self._signing_key_for(device)
        if not key:
            return True
        return device_signing.verify_sync(
            str(raw.get("sig") or ""),
            public_key_b64=key,
            scope=scope,
            item_id=item_id,
            updated_at=str(raw.get("updatedAt") or ""),
            deleted=bool(raw.get("deleted")),
            body=str(raw.get("body") or ""),
        )

    # ── push ────────────────────────────────────────────────────────────
    async def _push(self, adapter: ScopeAdapter) -> int:
        # One hop for everything that reads disk or encrypts; what comes back is
        # ready to put on the wire.
        pending, built = await asyncio.to_thread(self._prepare_push, adapter)
        return await self._send_all(adapter.scope, pending, built)

    async def _send_all(
        self,
        scope: str,
        pending: list[tuple[str, Any, str]],
        built: list[tuple[dict[str, Any], int]],
    ) -> int:
        """Put prepared items on the wire, respecting both frame budgets."""
        # Two budgets, because either one alone is wrong: sixty-four tiny items
        # is a fine batch and two large ones is not, and the frame is what the
        # server actually refuses.
        sent = 0
        batch: list[dict[str, Any]] = []
        budget = 0
        for item, size in built:
            if batch and (len(batch) >= PUSH_BATCH or budget + size > MAX_PUSH_BYTES):
                sent += await self._send_batch(scope, batch, pending)
                batch, budget = [], 0
            batch.append(item)
            budget += size
        if batch:
            sent += await self._send_batch(scope, batch, pending)
        return sent

    def _prepare_push(
        self, adapter: ScopeAdapter
    ) -> tuple[list[tuple[str, Any, str]], list[tuple[dict[str, Any], int]]]:
        """Everything a push needs, computed off the loop."""
        scope = adapter.scope
        snapshot = adapter.snapshot()
        states = self._store.states(scope)
        blocked = self._store.conflict_ids(scope)
        pending: list[tuple[str, Any, str]] = []  # (item_id, payload|None, hash)

        for item_id, payload in snapshot.items():
            if item_id in blocked:
                continue
            item_hash = digest(payload)
            state = states.get(item_id)
            if state is not None and not state.deleted and state.synced_hash == item_hash:
                continue
            pending.append((item_id, payload, item_hash))

        for item_id, state in states.items():
            if item_id in snapshot or item_id in blocked or state.deleted:
                continue
            pending.append((item_id, None, ""))

        updated_at = now_iso()
        built = [
            entry
            for entry in (self._build(scope, i, p, h, states, updated_at) for i, p, h in pending)
            if entry is not None
        ]
        return pending, built

    def _build(
        self,
        scope: str,
        item_id: str,
        payload: Any,
        item_hash: str,
        states: dict[str, ItemState],
        updated_at: str,
    ) -> tuple[dict[str, Any], int] | None:
        """One wire item and the bytes it costs, or None when it cannot go.

        ``deviceId`` is deliberately absent: the server stamps the connection's
        own device on every row, and a client that named itself would be
        claiming an origin rather than stating one.
        """
        deleted = payload is None
        body = ""
        if not deleted:
            body = sync_keyring.encrypt(canonical(payload), scope=scope, item_id=item_id)
            if len(body.encode("utf-8")) > MAX_BODY_BYTES:
                log.warning(
                    "skipping %s/%s: %d bytes is over the %d byte record limit",
                    scope, item_id, len(body.encode("utf-8")), MAX_BODY_BYTES,
                )
                return None
        state = states.get(item_id)
        item = {
            "itemId": item_id,
            "baseRev": state.rev if state else 0,
            "updatedAt": updated_at,
            "deleted": 1 if deleted else 0,
            "body": body,
            "sig": device_signing.sign_sync(
                scope=scope,
                item_id=item_id,
                updated_at=updated_at,
                deleted=deleted,
                body=body,
            ),
        }
        return item, len(canonical(item).encode("utf-8"))

    async def _send_batch(
        self, scope: str, wire: list[dict[str, Any]], pending: list[tuple[str, Any, str]]
    ) -> int:
        by_id = {item_id: (payload, item_hash) for item_id, payload, item_hash in pending}
        reply = _payload(await self._request("sync.push", {"scope": scope, "items": wire}))
        return await asyncio.to_thread(self._record_reply, scope, reply, by_id)

    def _record_reply(
        self, scope: str, reply: dict[str, Any], by_id: dict[str, tuple[Any, str]]
    ) -> int:
        """Write what the server said into the local record. Off the loop."""
        accepted = reply.get("accepted")
        for entry in accepted if isinstance(accepted, list) else []:
            if not isinstance(entry, dict):
                continue
            item_id = str(entry.get("itemId") or "")
            if item_id not in by_id:
                continue
            payload, item_hash = by_id[item_id]
            self._store.set_state(
                scope,
                item_id,
                rev=int(entry.get("rev") or 0),
                synced_hash=item_hash,
                deleted=payload is None,
            )
        conflicts = reply.get("conflicts")
        for entry in conflicts if isinstance(conflicts, list) else []:
            self._record_push_conflict(scope, entry, by_id)
        cursor = int(reply.get("cursor") or 0)
        if cursor > self._store.cursor(scope):
            # Our own accepted writes moved the cursor; recording it here keeps
            # the next pull from re-reading them.
            self._store.set_cursor(scope, cursor)
        return len(accepted) if isinstance(accepted, list) else 0

    def _record_push_conflict(
        self, scope: str, entry: Any, by_id: dict[str, tuple[Any, str]]
    ) -> None:
        if not isinstance(entry, dict):
            return
        item_id = str(entry.get("itemId") or "")
        if item_id not in by_id:
            return
        # A conflict can also mean "the row you were editing is gone": the
        # server answers rev 0 with every field null, which reads here as a
        # remote delete. Keeping the local copy then re-creates it, because
        # rev 0 is exactly the base a new item pushes from.
        local = by_id[item_id][0]
        remote: Any = None
        if not entry.get("deleted"):
            try:
                remote = json.loads(
                    sync_keyring.decrypt(
                        str(entry.get("body") or ""), scope=scope, item_id=item_id
                    )
                )
            except Exception as err:  # noqa: BLE001 - show the clash even unreadable
                log.warning("the conflicting copy of %s/%s did not open: %s", scope, item_id, err)
        self._store.record_conflict(
            scope,
            item_id,
            local=local,
            remote=remote,
            remote_rev=int(entry.get("rev") or 0),
            remote_device=str(entry.get("deviceId") or ""),
        )

    # ── conflict resolution ─────────────────────────────────────────────
    def resolve(self, scope: str, item_id: str, keep: str) -> None:
        """Answer one conflict. The next round carries the answer to the server.

        Keeping the remote copy writes it in and marks it agreed, so nothing is
        pushed back. Keeping the local copy only clears the block — the item is
        already different from what the server holds, so the next push sends it
        with the rev the conflict reported, which is what makes it win.
        """
        adapter = self._adapters.get(scope)
        if adapter is None:
            raise SyncError(f"no adapter registered for {scope!r}")
        rows = [c for c in self._store.conflicts(scope) if c["itemId"] == item_id]
        if not rows:
            raise SyncError(f"no unresolved conflict for {scope}/{item_id}")
        row = rows[0]
        if keep == KEEP_REMOTE:
            remote = row["remote"]
            adapter.apply(item_id, remote)
            self._store.set_state(
                scope,
                item_id,
                rev=int(row["remoteRev"]),
                synced_hash="" if remote is None else digest(remote),
                deleted=remote is None,
            )
        elif keep == KEEP_LOCAL:
            state = self._store.state(scope, item_id)
            self._store.set_state(
                scope,
                item_id,
                rev=int(row["remoteRev"]),
                synced_hash=state.synced_hash if state else "",
                deleted=False,
            )
        else:
            raise SyncError(f"{keep!r} is neither {KEEP_LOCAL!r} nor {KEEP_REMOTE!r}")
        self._store.clear_conflict(scope, item_id)

    # ── inventory ───────────────────────────────────────────────────────
    async def inventory(self, scope: str) -> dict[str, Any]:
        """Line this machine's items up against the account's, item by item.

        **Writes nothing.** No cursor, no agreed state, no conflict row, and the
        adapter is only ever asked to describe itself — a person looking at the
        two sides before deciding what to move must be able to look at a scope
        they have not switched on and have no intention of switching on.

        That also rules out ``ensure_sync_key``, which mints a key or asks a
        paired device for one. Reading is all this does, so a machine without
        the key says so and lists nothing rather than acquiring one to answer.

        Bodies never leave: an item is reported by its fingerprint, because a
        prompt or an MCP record is exactly the kind of thing that holds a
        secret, and the question being asked is only "are these two the same".
        """
        adapter = self._adapters.get(scope)
        if adapter is None:
            raise SyncError(f"no adapter registered for {scope!r}")
        if not await asyncio.to_thread(sync_keyring.has_account_key):
            return {"scope": scope, "status": INVENTORY_NO_KEY, "items": []}
        rows = await self._list_remote(scope)
        items = await asyncio.to_thread(self._compare, adapter, rows)
        return {"scope": scope, "status": INVENTORY_OK, "items": items}

    async def _list_remote(self, scope: str) -> list[dict[str, Any]]:
        """Every row the account holds for *scope*, tombstones included.

        Reads from rev 0 and keeps the paging position in a local variable. The
        stored cursor belongs to the sync round: moving it here would tell the
        next round that rows it has never applied were already read.

        Paging steps on the highest ``rev`` in the page rather than on the
        reply's ``cursor``, which the protocol describes as the scope's current
        maximum. Either reading pages correctly for a server that returns the
        page's last rev; only this one also pages correctly for one that
        returns the maximum, where stepping on the cursor would skip the rest.
        """
        rows: list[dict[str, Any]] = []
        since = 0
        while True:
            reply = _payload(
                await self._request(
                    "sync.pull", {"scope": scope, "since": since, "limit": PULL_PAGE}
                )
            )
            page = reply.get("items")
            page = [r for r in page if isinstance(r, dict)] if isinstance(page, list) else []
            rows.extend(page)
            if not reply.get("more"):
                break
            highest = max((int(r.get("rev") or 0) for r in page), default=since)
            if highest <= since:
                # No progress and the server still says "more": stop rather than
                # loop forever on a server that disagrees with itself.
                log.warning("sync.pull on %s made no progress; stopping the listing", scope)
                break
            since = highest
        return rows

    def _compare(
        self, adapter: ScopeAdapter, rows: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        """Pair the two halves up. Runs in a worker thread; reads disk freely.

        An item neither side holds is left out: a tombstone whose local copy is
        also gone is a row about nothing, and there is no answer a person could
        give it. A tombstone the local copy outlived is kept — it reads as
        ``local-only`` with ``deleted`` set, which is the whole story.
        """
        scope = adapter.scope
        snapshot = adapter.snapshot()
        blocked = self._store.conflict_ids(scope)
        remote_rows = {
            str(row.get("itemId") or ""): row for row in rows if row.get("itemId")
        }
        out: list[dict[str, Any]] = []
        for item_id in sorted(set(snapshot) | set(remote_rows)):
            local = (
                {"present": True, "fingerprint": digest(snapshot[item_id])}
                if item_id in snapshot
                else None
            )
            remote = self._describe_remote(scope, item_id, remote_rows.get(item_id))
            state = _item_state(item_id, local, remote, blocked)
            if state is None:
                continue
            out.append({"itemId": item_id, "local": local, "remote": remote, "state": state})
        return out

    def _describe_remote(
        self, scope: str, item_id: str, row: dict[str, Any] | None
    ) -> dict[str, Any] | None:
        """One cloud row as the inventory reports it, or None when there is none.

        ``readable`` is false for a record this machine's key will not open —
        another device's key, or a body that was damaged in transit. Said out
        loud rather than folded into "different", because the two call for
        different answers and a fingerprint that could not be computed must not
        read as one that did not match.
        """
        if row is None:
            return None
        deleted = bool(row.get("deleted"))
        fingerprint: str | None = None
        readable = True
        if not deleted:
            try:
                fingerprint = digest(
                    json.loads(
                        sync_keyring.decrypt(
                            str(row.get("body") or ""), scope=scope, item_id=item_id
                        )
                    )
                )
            except Exception as err:  # noqa: BLE001 - an unreadable record still lists
                log.warning("the cloud copy of %s/%s did not open: %s", scope, item_id, err)
                readable = False
        return {
            "present": not deleted,
            "rev": int(row.get("rev") or 0),
            "updatedAt": str(row.get("updatedAt") or ""),
            "deviceId": str(row.get("deviceId") or ""),
            "deleted": deleted,
            "fingerprint": fingerprint,
            "readable": readable,
        }

    # ── moving one item at a time ───────────────────────────────────────
    async def push_items(self, scope: str, item_ids: Any) -> list[dict[str, Any]]:
        """Send just these items, under every rule a whole push follows.

        Selective, not privileged: an item the user has an unresolved conflict
        on is still skipped, a body over the record limit is still refused, and
        the batches still respect both frame budgets. Choosing what to send
        changes which items go, never what the engine is willing to do.
        """
        adapter = self._require_adapter(scope)
        await self._require_key()
        wanted = _unique(item_ids)
        blocked_before = self._store.conflict_ids(scope)
        pending, built = await asyncio.to_thread(self._prepare_push, adapter)
        chosen_pending = [entry for entry in pending if entry[0] in wanted]
        chosen_built = [
            entry for entry in built if str(entry[0].get("itemId") or "") in wanted
        ]
        if chosen_built:
            await self._send_all(scope, chosen_pending, chosen_built)
        return await asyncio.to_thread(
            self._push_outcomes, scope, wanted, chosen_pending, chosen_built, blocked_before
        )

    def _push_outcomes(
        self,
        scope: str,
        wanted: list[str],
        pending: list[tuple[str, Any, str]],
        built: list[tuple[dict[str, Any], int]],
        blocked_before: set[str],
    ) -> list[dict[str, Any]]:
        """What became of each requested item, read back off the local record.

        Read back rather than collected on the way out, because the record is
        what the next round acts on: an item the server accepted and an item
        whose acceptance was not written down are the same to the user and very
        different to the engine, and only this direction can tell them apart.
        """
        hashes = {item_id: item_hash for item_id, _payload, item_hash in pending}
        buildable = {str(item.get("itemId") or "") for item, _size in built}
        states = self._store.states(scope)
        blocked_now = self._store.conflict_ids(scope)
        out: list[dict[str, Any]] = []
        for item_id in wanted:
            state = states.get(item_id)
            if item_id in blocked_before or item_id in blocked_now:
                result = "conflict"
            elif item_id not in hashes:
                result = "up-to-date" if state is not None else "unknown"
            elif item_id not in buildable:
                result = "too-large"
            elif state is not None and state.synced_hash == hashes[item_id]:
                result = "pushed"
            else:
                result = "failed"
            row: dict[str, Any] = {"itemId": item_id, "result": result}
            if result == "pushed" and state is not None:
                row["rev"] = state.rev
            out.append(row)
        return out

    async def pull_items(self, scope: str, item_ids: Any) -> list[dict[str, Any]]:
        """Take just these items from the account, under a whole pull's rules.

        The cursor stays where it was. This applies a few rows out of order, and
        a cursor moved past them would tell the next round that everything below
        it had been read — which is how one deliberate pull loses every change
        that happened to sit beside it.
        """
        adapter = self._require_adapter(scope)
        await self._require_key()
        wanted = _unique(item_ids)
        rows = await self._list_remote(scope)
        by_id = {str(row.get("itemId") or ""): row for row in rows if row.get("itemId")}
        return await asyncio.to_thread(self._apply_chosen, adapter, wanted, by_id)

    def _apply_chosen(
        self, adapter: ScopeAdapter, wanted: list[str], by_id: dict[str, dict[str, Any]]
    ) -> list[dict[str, Any]]:
        """Apply the chosen rows. Worker thread; one snapshot for the batch.

        One snapshot, like ``_apply_page``: each row is a different item, so a
        write does not change what the next comparison reads.
        """
        scope = adapter.scope
        snapshot = adapter.snapshot()
        blocked = self._store.conflict_ids(scope)
        out: list[dict[str, Any]] = []
        for item_id in wanted:
            row = by_id.get(item_id)
            if item_id in blocked:
                out.append({"itemId": item_id, "result": "conflict"})
            elif row is None:
                out.append({"itemId": item_id, "result": "not-on-server"})
            elif self._apply_one(adapter, row, snapshot, blocked):
                out.append(
                    {"itemId": item_id, "result": "pulled", "rev": int(row.get("rev") or 0)}
                )
            elif item_id in self._store.conflict_ids(scope):
                out.append({"itemId": item_id, "result": "conflict"})
            elif str(row.get("deviceId") or "") == self._device_id():
                out.append({"itemId": item_id, "result": "own-write"})
            else:
                out.append({"itemId": item_id, "result": "skipped"})
        return out

    def _require_adapter(self, scope: str) -> ScopeAdapter:
        adapter = self._adapters.get(scope)
        if adapter is None:
            raise SyncError(f"no adapter registered for {scope!r}")
        return adapter

    async def _require_key(self) -> None:
        if not await asyncio.to_thread(sync_keyring.has_account_key):
            raise SyncError("this machine does not hold the account sync key")


def _item_state(
    item_id: str,
    local: dict[str, Any] | None,
    remote: dict[str, Any] | None,
    blocked: set[str],
) -> str | None:
    """How the two halves stand, or None for an item neither side holds.

    An unreadable cloud copy counts as different rather than the same: the
    fingerprints could not be compared, and claiming agreement on that is the
    one answer that would let a real difference pass unnoticed.
    """
    if item_id in blocked:
        return STATE_CONFLICT
    if remote is None or not remote["present"]:
        return STATE_LOCAL_ONLY if local else None
    if local is None:
        return STATE_REMOTE_ONLY
    return (
        STATE_IN_SYNC
        if remote["fingerprint"] is not None and remote["fingerprint"] == local["fingerprint"]
        else STATE_DIVERGED
    )


def _unique(item_ids: Any) -> list[str]:
    """The requested ids, in the order asked for, without blanks or repeats."""
    out: list[str] = []
    for raw in item_ids if isinstance(item_ids, list) else []:
        item_id = str(raw or "")
        if item_id and item_id not in out:
            out.append(item_id)
    return out


def _pinned_signing_key(device_id: str) -> str:
    from . import trust_store

    try:
        pin = trust_store.pin_for(device_id)
    except Exception:  # noqa: BLE001 - an unreadable pin is "not pinned yet"
        return ""
    if not isinstance(pin, dict):
        return ""
    key = pin.get("signPublicKey") or pin.get("signingKey") or ""
    return key if isinstance(key, str) else ""


def _payload(reply: Any) -> dict[str, Any]:
    """The payload of a server reply, or a SyncError naming its refusal."""
    if not isinstance(reply, dict):
        raise SyncError("the server sent a reply that is not an object")
    if not reply.get("ok"):
        error = reply.get("error") if isinstance(reply.get("error"), dict) else {}
        code = str(error.get("code") or "UNKNOWN")
        raise SyncError(f"{code}: {error.get('message') or 'the server refused the request'}")
    payload = reply.get("payload")
    return payload if isinstance(payload, dict) else {}

