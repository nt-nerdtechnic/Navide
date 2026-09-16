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
SCOPES: tuple[str, ...] = ("prompts", "mcp", "skills", "memory", "credentials")

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
    """One Settings section's view of itself as syncable items.

    An adapter may also carry ``sensitive = True`` and a ``describe(payload)``
    method. ``sensitive`` is one flag for the four things a scope holding
    secrets needs and nothing else does: its conflict rows are sealed at rest
    and listed as ``describe()`` metadata only, an item missing from its
    snapshot never becomes a cloud tombstone, an unreadable record fails the
    round instead of being skipped, and the inventory carries ``describe()``
    of each side so a pane can name an item without seeing it.
    """

    scope: str

    def snapshot(self) -> dict[str, Any]:
        """Every item this machine holds right now, by stable item id."""

    def apply(self, item_id: str, payload: Any | None) -> None:
        """Write one incoming item in, or remove it when payload is None."""


def _sensitive(adapter: Any) -> bool:
    return bool(getattr(adapter, "sensitive", False))


def _describe(adapter: Any, payload: Any) -> dict[str, Any] | None:
    """``adapter.describe(payload)`` when the adapter offers one, else None.

    Never raises: a description is decoration on a listing, and a payload the
    adapter cannot describe must not take the listing down with it.
    """
    fn = getattr(adapter, "describe", None)
    if fn is None or payload is None:
        return None
    try:
        out = fn(payload)
    except Exception as err:  # noqa: BLE001 - see docstring
        log.warning("%s could not describe an item: %s", getattr(adapter, "scope", "?"), err)
        return None
    return out if isinstance(out, dict) else None


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
    """What this machine and the server last agreed on for one item.

    ``sealed_kid`` names the account key the agreed body was sealed under
    (empty for a v1 body or when unknown). A rotation makes it differ from the
    active key, which is the only reason an unchanged item is pushed again.
    """

    rev: int
    synced_hash: str
    deleted: bool
    sealed_kid: str = ""


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


def _schema_v2(cur: Any) -> None:
    # ``sealed``: the two payload columns hold ciphertext, not canonical JSON.
    # ``remote_kid``: the key the remote copy came sealed under, so keeping it
    # records the truth and a rotation still finds it. ``sealed_kid``: see
    # ItemState.
    cur.execute("ALTER TABLE sync_conflicts ADD COLUMN sealed INTEGER NOT NULL DEFAULT 0")
    cur.execute("ALTER TABLE sync_conflicts ADD COLUMN remote_kid TEXT NOT NULL DEFAULT ''")
    cur.execute("ALTER TABLE sync_state ADD COLUMN sealed_kid TEXT NOT NULL DEFAULT ''")


#: Stands in for the two payloads of a sealed conflict row when the account
#: key that would open them is not here. A row the user can neither read nor
#: resolve still has to be listed, or the item stays silently blocked.
SEALED_PLACEHOLDER: dict[str, Any] = {"sealed": True}


class SyncStore:
    """The bookkeeping half: what was agreed, how far we have read, what clashed.

    Conflict rows of a sensitive scope are stored sealed under the account key
    and come back out of ``conflicts()`` as whatever the scope's ``describe``
    makes of them — never the payload. The redactor is handed over by the
    engine at registration, so this class stays ignorant of what a credential
    is while still refusing to hand one to a caller.
    """

    def __init__(self, db: Database) -> None:
        self._db = db
        self._db.migrate(_COMPONENT, 1, _create_schema)
        self._db.migrate(_COMPONENT, 2, _schema_v2)
        self._redactors: dict[str, Callable[[Any], dict[str, Any] | None]] = {}

    def set_redactor(self, scope: str, fn: Callable[[Any], dict[str, Any] | None]) -> None:
        self._redactors[scope] = fn

    # ── agreed state ────────────────────────────────────────────────────
    def state(self, scope: str, item_id: str) -> ItemState | None:
        with self._db.transaction() as cur:
            row = cur.execute(
                "SELECT rev, synced_hash, deleted, sealed_kid FROM sync_state"
                " WHERE scope = ? AND item_id = ?",
                (scope, item_id),
            ).fetchone()
        return ItemState(int(row[0]), str(row[1]), bool(row[2]), str(row[3] or "")) if row else None

    def states(self, scope: str) -> dict[str, ItemState]:
        with self._db.transaction() as cur:
            rows = cur.execute(
                "SELECT item_id, rev, synced_hash, deleted, sealed_kid FROM sync_state"
                " WHERE scope = ?",
                (scope,),
            ).fetchall()
        return {
            str(r[0]): ItemState(int(r[1]), str(r[2]), bool(r[3]), str(r[4] or ""))
            for r in rows
        }

    def set_state(
        self,
        scope: str,
        item_id: str,
        *,
        rev: int,
        synced_hash: str,
        deleted: bool,
        sealed_kid: str = "",
    ) -> None:
        with self._db.transaction() as cur:
            cur.execute(
                """
                INSERT INTO sync_state (scope, item_id, rev, synced_hash, deleted, sealed_kid)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(scope, item_id) DO UPDATE SET
                    rev = excluded.rev,
                    synced_hash = excluded.synced_hash,
                    deleted = excluded.deleted,
                    sealed_kid = excluded.sealed_kid
                """,
                (scope, item_id, int(rev), synced_hash, 1 if deleted else 0, sealed_kid or ""),
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
        sealed: bool = False,
        remote_kid: str = "",
    ) -> None:
        """Remember a clash. ``sealed`` stores both payloads as ciphertext.

        The sealing happens before the row is written, so SQLite — its journal
        and WAL included — never receives the plaintext. Both halves are sealed
        under the same associated data as the record itself; a conflict row is
        the same item, at rest, in a second place.
        """
        if sealed:
            local_text = sync_keyring.encrypt(canonical(local), scope=scope, item_id=item_id)
            remote_text = sync_keyring.encrypt(canonical(remote), scope=scope, item_id=item_id)
        else:
            local_text = canonical(local)
            remote_text = canonical(remote)
        with self._db.transaction() as cur:
            cur.execute(
                """
                INSERT INTO sync_conflicts
                    (scope, item_id, local_json, remote_json, remote_rev, remote_device,
                     seen_at, sealed, remote_kid)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(scope, item_id) DO UPDATE SET
                    local_json = excluded.local_json,
                    remote_json = excluded.remote_json,
                    remote_rev = excluded.remote_rev,
                    remote_device = excluded.remote_device,
                    seen_at = excluded.seen_at,
                    sealed = excluded.sealed,
                    remote_kid = excluded.remote_kid
                """,
                (
                    scope,
                    item_id,
                    local_text,
                    remote_text,
                    int(remote_rev),
                    remote_device,
                    int(time.time()),
                    1 if sealed else 0,
                    remote_kid or "",
                ),
            )
        log.info("sync conflict on %s/%s — waiting for the user", scope, item_id)

    def _conflict_rows(self, scope: str | None) -> list[tuple[Any, ...]]:
        sql = (
            "SELECT scope, item_id, local_json, remote_json, remote_rev, remote_device, "
            "seen_at, sealed, remote_kid FROM sync_conflicts"
        )
        args: tuple[Any, ...] = ()
        if scope:
            sql += " WHERE scope = ?"
            args = (scope,)
        sql += " ORDER BY seen_at DESC"
        with self._db.transaction() as cur:
            return cur.execute(sql, args).fetchall()

    def _open_sealed(self, scope: str, item_id: str, text: str) -> Any:
        return json.loads(sync_keyring.decrypt(text, scope=scope, item_id=item_id))

    def conflicts(self, scope: str | None = None) -> list[dict[str, Any]]:
        """Every unresolved clash, as a caller outside the engine may see it.

        A sealed row's ``local``/``remote`` are the scope's ``describe()`` of
        each half, or ``SEALED_PLACEHOLDER`` when it cannot be opened here.
        The payloads themselves leave this class only through
        ``conflict_payloads``, which ``resolve`` uses and nothing else should.
        """
        out: list[dict[str, Any]] = []
        for r in self._conflict_rows(scope):
            row_scope, item_id, sealed = str(r[0]), str(r[1]), bool(r[7])
            if sealed:
                redact = self._redactors.get(row_scope)
                local, remote = self._redacted(row_scope, item_id, r[2], r[3], redact)
            else:
                local, remote = json.loads(r[2]), json.loads(r[3])
            out.append(
                {
                    "scope": row_scope,
                    "itemId": item_id,
                    "local": local,
                    "remote": remote,
                    "remoteRev": int(r[4]),
                    "remoteDevice": str(r[5]),
                    "seenAt": int(r[6]),
                    "sealed": sealed,
                }
            )
        return out

    def _redacted(
        self,
        scope: str,
        item_id: str,
        local_text: str,
        remote_text: str,
        redact: Callable[[Any], dict[str, Any] | None] | None,
    ) -> tuple[Any, Any]:
        if redact is None:
            # No registered describer means no way to say anything safe about
            # the payload, so nothing is said.
            return dict(SEALED_PLACEHOLDER), dict(SEALED_PLACEHOLDER)
        out: list[Any] = []
        for text in (local_text, remote_text):
            try:
                payload = self._open_sealed(scope, item_id, text)
            except Exception:  # noqa: BLE001 - "cannot open here" is an answer
                out.append(dict(SEALED_PLACEHOLDER))
                continue
            described = None
            try:
                described = redact(payload)
            except Exception as err:  # noqa: BLE001 - never leak by failing open
                log.warning("%s could not describe a conflict half: %s", scope, err)
            out.append(described if isinstance(described, dict) else dict(SEALED_PLACEHOLDER))
        return out[0], out[1]

    def conflict_payloads(self, scope: str, item_id: str) -> dict[str, Any] | None:
        """One clash with its real payloads — for the engine's own resolve.

        Raises ``KeyringError`` when a sealed row cannot be opened; the caller
        turns that into "resolve is not possible on this machine right now".
        """
        for r in self._conflict_rows(scope):
            if str(r[1]) != item_id:
                continue
            sealed = bool(r[7])
            local = self._open_sealed(scope, item_id, r[2]) if sealed else json.loads(r[2])
            remote = self._open_sealed(scope, item_id, r[3]) if sealed else json.loads(r[3])
            return {
                "scope": str(r[0]),
                "itemId": item_id,
                "local": local,
                "remote": remote,
                "remoteRev": int(r[4]),
                "remoteDevice": str(r[5]),
                "seenAt": int(r[6]),
                "sealed": sealed,
                "remoteKid": str(r[8] or ""),
            }
        return None

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
        #: Per scope, the highest cursor a push reply may move to while a
        #: pulled row is waiting for its key. Set by ``_pull``, honoured by
        #: ``_record_reply``: the push's own accepted revs sit above the held
        #: row, and recording them as read would step the cursor past it.
        self._cursor_barrier: dict[str, int] = {}
        #: One round per scope at a time. A save that asks for a push while
        #: the connect-time round is still running must queue behind it, not
        #: interleave with it: both would read one snapshot and push the
        #: same items from the same base rev, and one of them would come
        #: back as a conflict with itself.
        self._locks: dict[str, asyncio.Lock] = {}

    def register(self, adapter: ScopeAdapter) -> None:
        if adapter.scope not in SCOPES:
            raise SyncError(f"{adapter.scope!r} is not a protocol scope")
        self._adapters[adapter.scope] = adapter
        if _sensitive(adapter):
            self._store.set_redactor(adapter.scope, lambda payload: _describe(adapter, payload))

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
        async with self._locks.setdefault(scope, asyncio.Lock()):
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
        self._cursor_barrier.pop(scope, None)
        while True:
            since = self._store.cursor(scope)
            reply = _payload(
                await self._request("sync.pull", {"scope": scope, "since": since, "limit": PULL_PAGE})
            )
            items = reply.get("items")
            items = items if isinstance(items, list) else []
            count, held_rev = await asyncio.to_thread(self._apply_page, adapter, items)
            applied += count
            cursor = int(reply.get("cursor") or since)
            if held_rev is not None:
                # A record sealed under a key this machine has not been handed
                # yet. The cursor stops just short of it, so the next round —
                # after a paired device sends the ring — reads it again; the
                # rows behind it in this page were not applied either, so
                # nothing is skipped past. Once per round, not a retry loop.
                cursor = max(since, held_rev - 1)
                if cursor > since:
                    self._store.set_cursor(scope, cursor)
                self._cursor_barrier[scope] = cursor
                log.info("sync.pull on %s is waiting for a newer key at rev %d", scope, held_rev)
                break
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

    def _apply_page(
        self, adapter: ScopeAdapter, items: list[Any]
    ) -> tuple[int, int | None]:
        """Apply one pull page. Runs in a worker thread; touches disk freely.

        Returns how many rows were applied and, when a row named a key this
        machine does not hold, that row's rev — the page stops there.
        """
        snapshot = adapter.snapshot()
        blocked = self._store.conflict_ids(adapter.scope)
        applied = 0
        for raw in sorted(items, key=_rev_of):
            try:
                if self._apply_one(adapter, raw, snapshot, blocked):
                    applied += 1
            except _HoldPull as hold:
                return applied, hold.rev
        return applied, None

    def _apply_one(
        self,
        adapter: ScopeAdapter,
        raw: Any,
        snapshot: dict[str, Any],
        blocked: set[str],
        *,
        explicit: bool = False,
    ) -> bool:
        """Apply one pulled row. ``explicit`` marks a row the user asked for by
        name (``pull_items``): then even this device's own write is applied,
        because asking for it means this machine no longer holds it."""
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
        if device == self._device_id() and not explicit:
            # Our own write coming back. Record the rev so the next push edits
            # from the right base, but there is nothing to apply. The key it
            # is under is read off the body: it is what we sent, and an empty
            # record here would have the next push send it all over again.
            state = self._store.state(scope, item_id)
            if state is not None:
                self._store.set_state(
                    scope,
                    item_id,
                    rev=rev,
                    synced_hash=state.synced_hash,
                    deleted=deleted,
                    sealed_kid="" if deleted else (_kid_of(body) or state.sealed_kid),
                )
            return False
        if not self._origin_ok(raw, scope=scope, item_id=item_id):
            log.warning("dropping %s/%s: its signature does not match the pinned key", scope, item_id)
            return False
        try:
            remote = None if deleted else json.loads(
                sync_keyring.decrypt(body, scope=scope, item_id=item_id)
            )
        except sync_keyring.UnknownKeyId:
            raise _HoldPull(rev)
        except Exception as err:  # noqa: BLE001 - an unreadable record is not fatal
            if _sensitive(adapter):
                # A credential that will not open is not a row to step over:
                # skipping it would move the cursor past a secret this machine
                # never received. The round fails and is retried whole.
                raise SyncError(f"{scope}/{item_id} could not be opened: {err}") from err
            log.warning("dropping %s/%s: %s", scope, item_id, err)
            return False

        state = self._store.state(scope, item_id)
        local = snapshot.get(item_id)
        local_hash = digest(local) if item_id in snapshot else ""
        agreed_hash = state.synced_hash if state else ""
        remote_hash = "" if remote is None else digest(remote)
        # Applying over an edit this machine has not pushed yet would lose it.
        # That is the one thing this engine must never do, so it becomes a
        # conflict even though the server was happy to hand the record over —
        # unless the two edits are the same bytes, in which case there is
        # nothing to lose and nothing to ask: two devices that pasted the same
        # token, or two that both resealed one after a rotation, just agree.
        #
        # For a sensitive scope an *absent* local item is never an edit: it
        # means "removed here" or "never set up here", the same absence that
        # sends no tombstone, so an incoming record is offered to the adapter
        # rather than parked as a clash.
        absent_ok = _sensitive(adapter) and item_id not in snapshot
        if local_hash != agreed_hash and local_hash != remote_hash and not absent_ok:
            self._store.record_conflict(
                scope,
                item_id,
                local=local,
                remote=remote,
                remote_rev=rev,
                remote_device=device,
                sealed=_sensitive(adapter),
                remote_kid="" if deleted else _kid_of(body),
            )
            return False
        held = True
        if local_hash != remote_hash:
            # An adapter may answer False to say it declined the record and
            # does not hold it — a credential switched off on this device.
            # The rev is still recorded so the row is not re-read, but the
            # agreed hash stays empty: this machine holds nothing for it.
            held = adapter.apply(item_id, remote) is not False
        self._store.set_state(
            scope,
            item_id,
            rev=rev,
            synced_hash=remote_hash if held else "",
            deleted=remote is None,
            sealed_kid=_kid_of(body) if (held and not deleted) else "",
        )
        return held

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

        active_kid = sync_keyring.active_key_id() or ""
        for item_id, payload in snapshot.items():
            if item_id in blocked:
                continue
            item_hash = digest(payload)
            state = states.get(item_id)
            if state is not None and not state.deleted and state.synced_hash == item_hash:
                # Unchanged — unless the key it went up under has since been
                # retired, in which case the same bytes go up again under the
                # active one. That is the whole of what a rotation asks of the
                # engine: every device re-seals what it holds, and whichever
                # gets there first wins without a conflict (same content).
                if state.sealed_kid == active_kid:
                    continue
            pending.append((item_id, payload, item_hash))

        if not _sensitive(adapter):
            # An item the snapshot no longer lists is a delete to carry up —
            # except for a sensitive scope, where "not here" is as often "not
            # set up on this machine" or "removed from this machine only", and
            # a tombstone would sign every other device out. Those scopes
            # never delete by absence; the cloud copy outlives the local one.
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
                sealed_kid=(sync_keyring.active_key_id() or "") if payload is not None else "",
            )
        conflicts = reply.get("conflicts")
        adapter = self._adapters.get(scope)
        for entry in conflicts if isinstance(conflicts, list) else []:
            self._record_push_conflict(scope, entry, by_id, sealed=_sensitive(adapter))
        cursor = int(reply.get("cursor") or 0)
        barrier = self._cursor_barrier.get(scope)
        if barrier is not None:
            # A row below is still waiting for its key. Re-reading our own
            # writes next round is cheap; losing that row is not.
            cursor = min(cursor, barrier)
        if cursor > self._store.cursor(scope):
            # Our own accepted writes moved the cursor; recording it here keeps
            # the next pull from re-reading them.
            self._store.set_cursor(scope, cursor)
        return len(accepted) if isinstance(accepted, list) else 0

    def _record_push_conflict(
        self,
        scope: str,
        entry: Any,
        by_id: dict[str, tuple[Any, str]],
        *,
        sealed: bool = False,
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
        local, local_hash = by_id[item_id]
        remote: Any = None
        body = str(entry.get("body") or "")
        opened = True
        if not entry.get("deleted"):
            try:
                remote = json.loads(sync_keyring.decrypt(body, scope=scope, item_id=item_id))
            except Exception as err:  # noqa: BLE001 - show the clash even unreadable
                if sealed:
                    # An unreadable remote half must not be written down as
                    # "deleted": keeping it would then erase the credential.
                    # Nothing is recorded; the item is pushed again next round
                    # and clashes again, readable or held by then.
                    raise SyncError(
                        f"the conflicting copy of {scope}/{item_id} could not be opened: {err}"
                    ) from err
                opened = False
                log.warning("the conflicting copy of %s/%s did not open: %s", scope, item_id, err)
        remote_rev = int(entry.get("rev") or 0)
        if opened and remote is not None and digest(remote) == local_hash:
            # The server refused our write because another device got there
            # first — with the same bytes. Adopt its rev; there is no question.
            self._store.set_state(
                scope,
                item_id,
                rev=remote_rev,
                synced_hash=local_hash,
                deleted=False,
                sealed_kid=_kid_of(body),
            )
            return
        self._store.record_conflict(
            scope,
            item_id,
            local=local,
            remote=remote,
            remote_rev=remote_rev,
            remote_device=str(entry.get("deviceId") or ""),
            sealed=sealed,
            remote_kid="" if remote is None else _kid_of(body),
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
        try:
            row = self._store.conflict_payloads(scope, item_id)
        except sync_keyring.KeyringError as err:
            raise SyncError(f"the conflict on {scope}/{item_id} cannot be opened here: {err}") from err
        if row is None:
            raise SyncError(f"no unresolved conflict for {scope}/{item_id}")
        if keep == KEEP_REMOTE:
            remote = row["remote"]
            adapter.apply(item_id, remote)
            # Recorded under the key the winning body actually came sealed
            # with (empty when unknown), so a copy under a retired key is
            # still re-sealed by the next push rather than taken as current.
            self._store.set_state(
                scope,
                item_id,
                rev=int(row["remoteRev"]),
                synced_hash="" if remote is None else digest(remote),
                deleted=remote is None,
                sealed_kid="" if remote is None else str(row.get("remoteKid") or ""),
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
            if local is not None:
                meta = _describe(adapter, snapshot[item_id])
                if meta is not None:
                    local["meta"] = meta
            remote = self._describe_remote(adapter, item_id, remote_rows.get(item_id))
            state = _item_state(item_id, local, remote, blocked)
            if state is None:
                continue
            out.append({"itemId": item_id, "local": local, "remote": remote, "state": state})
        return out

    def _describe_remote(
        self, adapter: ScopeAdapter, item_id: str, row: dict[str, Any] | None
    ) -> dict[str, Any] | None:
        """One cloud row as the inventory reports it, or None when there is none.

        ``readable`` is false for a record this machine's key will not open —
        another device's key, or a body that was damaged in transit. Said out
        loud rather than folded into "different", because the two call for
        different answers and a fingerprint that could not be computed must not
        read as one that did not match.

        ``meta`` is the adapter's ``describe()`` of the opened body, when it
        has one: what a pane needs to name the item, never the item itself.
        """
        if row is None:
            return None
        scope = adapter.scope
        deleted = bool(row.get("deleted"))
        fingerprint: str | None = None
        meta: dict[str, Any] | None = None
        readable = True
        if not deleted:
            try:
                payload = json.loads(
                    sync_keyring.decrypt(str(row.get("body") or ""), scope=scope, item_id=item_id)
                )
                fingerprint = digest(payload)
                meta = _describe(adapter, payload)
            except Exception as err:  # noqa: BLE001 - an unreadable record still lists
                log.warning("the cloud copy of %s/%s did not open: %s", scope, item_id, err)
                readable = False
        out = {
            "present": not deleted,
            "rev": int(row.get("rev") or 0),
            "updatedAt": str(row.get("updatedAt") or ""),
            "deviceId": str(row.get("deviceId") or ""),
            "deleted": deleted,
            "fingerprint": fingerprint,
            "readable": readable,
        }
        if meta is not None:
            out["meta"] = meta
        return out

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
        requested = getattr(adapter, "request_items", None)
        if requested is not None:
            # Naming an item is asking for it: an adapter that keeps a "not on
            # this machine" mark for some items lifts it here, before the
            # rows are read, so the pull below can take them.
            await asyncio.to_thread(requested, wanted)
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
            elif self._applied_chosen(adapter, row, snapshot, blocked):
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

    def _applied_chosen(
        self,
        adapter: ScopeAdapter,
        row: dict[str, Any],
        snapshot: dict[str, Any],
        blocked: set[str],
    ) -> bool:
        try:
            return self._apply_one(adapter, row, snapshot, blocked, explicit=True)
        except _HoldPull:
            # A selective pull has no cursor to hold; the row simply did not
            # come in, and the listing says so.
            return False

    def _require_adapter(self, scope: str) -> ScopeAdapter:
        adapter = self._adapters.get(scope)
        if adapter is None:
            raise SyncError(f"no adapter registered for {scope!r}")
        return adapter

    async def _require_key(self) -> None:
        if not await asyncio.to_thread(sync_keyring.has_account_key):
            raise SyncError("this machine does not hold the account sync key")


class _HoldPull(Exception):
    """A pulled record is sealed under a key this machine does not hold yet."""

    def __init__(self, rev: int) -> None:
        super().__init__(f"waiting for the key of rev {rev}")
        self.rev = rev


def _rev_of(raw: Any) -> int:
    return int(raw.get("rev") or 0) if isinstance(raw, dict) else 0


def _kid_of(body: str) -> str:
    """The active key id when *body* is sealed under it, else "" (re-push later)."""
    if not body:
        return ""
    try:
        if sync_keyring.needs_reseal(body):
            return ""
    except Exception:  # noqa: BLE001 - an undecidable body is treated as stale
        return ""
    return sync_keyring.active_key_id() or ""


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

