"""Scope adapters: how each Settings section presents itself to the sync engine.

An adapter answers two questions and nothing else — "what do you hold right
now" and "write this in" — so the engine stays ignorant of what a prompt or an
MCP server is, and a new section is a new adapter rather than a new branch
inside the engine.

**Sync is opt-in, per scope, per machine.** ``enabled_scopes`` starts empty:
nothing leaves a device until someone turns a section on. That is why the
default here is ``False`` rather than ``True`` — a sync feature that switched
itself on would upload a user's MCP secrets because they installed an update.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import secrets
import threading
import time
from datetime import datetime, timezone
from typing import Any, Callable

from . import sync_engine, sync_keyring

log = logging.getLogger("agent_team_backend.sync_scopes")

#: Which sections this machine syncs, as ``{scope: bool}``.
SCOPES_SETTING = "sync-scopes"

#: The renderer's own keys, mirrored here because the backend now writes them
#: too. Kept as literals on purpose: the renderer is the owner and a shared
#: constant would invert that.
PROMPT_SKILLS_KEY = "prompt-skills"
LOOP_PROMPT_KEY = "loop-prompt-text"


def _settings():
    from . import app

    return app.ui_settings_store


def enabled_scopes() -> dict[str, bool]:
    raw = _settings().get().get(SCOPES_SETTING)
    stored = raw if isinstance(raw, dict) else {}
    return {scope: bool(stored.get(scope, False)) for scope in sync_engine.SCOPES}


def scope_enabled(scope: str) -> bool:
    return enabled_scopes().get(scope, False)


def set_scope_enabled(scope: str, enabled: bool) -> dict[str, bool]:
    if scope not in sync_engine.SCOPES:
        raise sync_engine.SyncError(f"{scope!r} is not a protocol scope")
    if enabled and scope == "credentials":
        blocker = credentials_enable_blocker()
        if blocker:
            raise sync_engine.SyncError(blocker)
    current = enabled_scopes()
    current[scope] = bool(enabled)
    _settings().set({SCOPES_SETTING: current})
    return current


def credentials_enable_blocker() -> str:
    """Why the credentials section may not be switched on right now, or "".

    Credentials are the one scope where the account key's provenance is the
    whole security argument: the key is handed to a new device sealed to an
    X25519 public key, and a device paired before that key was pinned in the
    trust store took it on the server's word. Such a *legacy* pin has to be
    re-paired before a credential goes up — otherwise a compromised server
    could have named itself as that device. A trust store that cannot be
    read is refused too: not knowing is not the same as knowing it is fine.
    """
    from . import trust_store

    legacy = getattr(trust_store, "legacy_pinned_devices", None)
    if legacy is None:
        return ""
    try:
        devices = [str(d) for d in legacy() if d]
    except Exception as err:  # noqa: BLE001 - fail closed, see docstring
        return f"the trust store could not be read: {err}"
    if not devices:
        return ""
    return (
        "these paired devices predate encryption-key pinning and must be unpaired "
        "and paired again before credentials can sync: " + ", ".join(sorted(devices))
    )


class PromptsScope:
    """Prompt skills — the Settings → Prompts list.

    The list lives in one settings value, so the adapter explodes it into one
    item per skill id and puts it back together on the way in. Syncing the
    whole array as a single item would make any two devices that both touched
    prompts collide on everything at once.
    """

    scope = "prompts"

    def __init__(self, broadcast: Callable[[dict[str, Any]], None] | None = None) -> None:
        #: Called with the settings delta after a write, so other windows
        #: converge instead of waiting for a reload.
        self._broadcast = broadcast

    # ── reading ─────────────────────────────────────────────────────────
    def _list(self) -> list[dict[str, Any]]:
        raw = _settings().get().get(PROMPT_SKILLS_KEY)
        if not isinstance(raw, list):
            return []
        return [s for s in raw if isinstance(s, dict) and isinstance(s.get("id"), str) and s["id"]]

    def snapshot(self) -> dict[str, Any]:
        return {str(skill["id"]): skill for skill in self._list()}

    # ── writing ─────────────────────────────────────────────────────────
    def apply(self, item_id: str, payload: Any | None) -> None:
        skills = self._list()
        index = next((i for i, s in enumerate(skills) if s.get("id") == item_id), -1)
        if payload is None:
            if index < 0:
                return
            skills.pop(index)
        else:
            if not isinstance(payload, dict):
                log.warning("prompt %s arrived as %s, not an object", item_id, type(payload).__name__)
                return
            incoming = dict(payload)
            incoming["id"] = item_id
            if index < 0:
                skills.append(incoming)
            else:
                skills[index] = incoming
        self._write(_single_default(skills))

    def _write(self, skills: list[dict[str, Any]]) -> None:
        updates: dict[str, Any] = {PROMPT_SKILLS_KEY: skills}
        default = next((s for s in skills if s.get("isDefault")), None)
        if default is not None and isinstance(default.get("prompt"), str):
            # The renderer mirrors this on every save; a write that skipped it
            # would leave the loop running yesterday's prompt.
            updates[LOOP_PROMPT_KEY] = default["prompt"]
        delta = _settings().set(updates)
        if delta and self._broadcast is not None:
            self._broadcast(delta)


def _single_default(skills: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Exactly one skill carries ``isDefault`` — the renderer's invariant.

    Sync can break it in both directions: two devices each promoting a
    different skill produces two, and deleting the default produces none. The
    renderer would then cast an arbitrary one, so it is settled here instead,
    where the rule can be stated once.
    """
    if not skills:
        return skills
    claimed = [i for i, s in enumerate(skills) if s.get("isDefault")]
    winner = claimed[0] if claimed else 0
    return [{**s, "isDefault": i == winner} for i, s in enumerate(skills)]


class McpScope:
    """Navide's own MCP server records.

    The native reflection — what each CLI keeps in its own config file — is
    deliberately absent. Those are the user's files in the user's directories,
    and syncing them would mean this feature rewriting ``~/.codex`` and
    ``~/.cursor`` on a machine nobody was looking at.

    Secrets ride along inside the encrypted body, which is the decision the
    plan records: url, args and env go up sealed, and the server has no key.
    """

    scope = "mcp"

    def _store(self):
        from . import app

        return app.mcp_settings_store

    def snapshot(self) -> dict[str, Any]:
        servers = self._store().list_servers()
        return {str(s["name"]): s for s in servers if isinstance(s.get("name"), str) and s["name"]}

    def apply(self, item_id: str, payload: Any | None) -> None:
        store = self._store()
        servers = [s for s in store.list_servers() if isinstance(s, dict)]
        index = next((i for i, s in enumerate(servers) if s.get("name") == item_id), -1)
        if payload is None:
            if index < 0:
                return
            servers.pop(index)
        else:
            if not isinstance(payload, dict):
                log.warning("MCP record %s arrived as %s", item_id, type(payload).__name__)
                return
            incoming = dict(payload)
            incoming["name"] = item_id
            if index < 0:
                servers.append(incoming)
            else:
                servers[index] = incoming
        try:
            store.replace_servers(servers)
        except Exception as err:  # noqa: BLE001 - a rejected document is not fatal
            log.warning("the synced MCP document was refused: %s", err)


#: Where a synced skill decision waits when the skill itself is not here yet.
SKILLS_INTENT_KEY = "sync-skills-intent"


class SkillsStateScope:
    """Which skills are on, which CLIs each one goes to, and — for the ones
    Navide created — the files themselves.

    Content rides in the same item rather than a scope of its own, because a
    skill's files and the decision about that skill are one thing to the person
    looking at it: turning Skills sync on should not leave them with a list of
    names they cannot open.

    Only skills carrying the ``.navide`` marker send content. A shared-root
    entry the user put there themselves is listed and routed like any other,
    but its files stay where they are — see ``SkillsStore.export_content``.

    A decision can still arrive for a skill this machine does not have (its
    sender did not own the files either), which is why it is kept twice: once
    applied to the store, and once in ``SKILLS_INTENT_KEY`` for the rest.

    Without the second copy the snapshot would simply lack that item on the
    next round, the engine would read the absence as a delete, and one machine
    missing a skill would switch it off for every machine that has it.

    Routes are the user's intent, not this machine's result: a device with no
    codex installed keeps "send it to codex" on file, inert, and honours it the
    day codex arrives.
    """

    scope = "skills"

    def _store(self):
        from . import app

        return app.skills_store

    def _intent(self) -> dict[str, Any]:
        raw = _settings().get().get(SKILLS_INTENT_KEY)
        return dict(raw) if isinstance(raw, dict) else {}

    def _set_intent(self, intent: dict[str, Any]) -> None:
        _settings().set({SKILLS_INTENT_KEY: intent})

    def _present(self) -> dict[str, Any]:
        store = self._store()
        try:
            listing = store.list_skills()
        except Exception as err:  # noqa: BLE001 - an unreadable library syncs nothing
            log.warning("the skills library could not be read: %s", err)
            return {}
        out: dict[str, Any] = {}
        for skill in listing.get("skills", []):
            name = skill.get("name")
            if not (isinstance(name, str) and name):
                continue
            entry: dict[str, Any] = {
                "enabled": bool(skill.get("enabled", True)),
                "targets": skill.get("targets"),
            }
            try:
                content = store.export_content(name)
            except Exception as err:  # noqa: BLE001 - an unreadable skill still routes
                log.warning("the files of %s could not be read: %s", name, err)
                content = None
            if content is not None:
                entry["content"] = content
            out[name] = entry
        return out

    def snapshot(self) -> dict[str, Any]:
        # What is here wins over what was remembered for it; the remembered
        # entries survive for the skills this machine does not hold.
        return {**self._intent(), **self._present()}

    def apply(self, item_id: str, payload: Any | None) -> None:
        intent = self._intent()
        if payload is None:
            intent.pop(item_id, None)
            self._set_intent(intent)
            return
        if not isinstance(payload, dict):
            log.warning("skill decision %s arrived as %s", item_id, type(payload).__name__)
            return
        decision = {
            "enabled": bool(payload.get("enabled", True)),
            "targets": payload.get("targets"),
        }
        intent[item_id] = decision
        self._set_intent(intent)
        store = self._store()
        content = payload.get("content")
        if isinstance(content, dict):
            try:
                store.import_content(item_id, content)
            except Exception as err:  # noqa: BLE001 - a refused write is not fatal
                log.warning("the files of %s were not written: %s", item_id, err)
        if item_id not in self._present():
            return  # the skill is not here; the decision waits in the intent map
        try:
            store.set_enabled(item_id, decision["enabled"])
            store.set_targets(item_id, decision["targets"])
        except Exception as err:  # noqa: BLE001 - a skill that moved is not fatal
            log.warning("the synced decision for %s could not be applied: %s", item_id, err)


class MemoryScope:
    """User-scope instruction files — ``~/.claude/CLAUDE.md`` and its siblings.

    Project scope is excluded by construction, not by a flag: those files are
    inside the user's repository and git is already their source of truth. Two
    systems writing one file is how both of them end up wrong.

    The item id is the path *relative to the home directory*, so the same file
    is the same item on a machine whose home is somewhere else entirely.
    """

    scope = "memory"

    def _files(self) -> dict[str, Any]:
        from . import native_memory

        return {
            f.relative: f
            for f in native_memory.scan()
            if f.scope == native_memory.USER_SCOPE and f.exists and not f.error
        }

    def snapshot(self) -> dict[str, Any]:
        from . import native_memory

        out: dict[str, Any] = {}
        for relative, entry in self._files().items():
            try:
                doc = native_memory.read(entry.path)
            except Exception as err:  # noqa: BLE001 - skip what cannot be read
                log.warning("instruction file %s could not be read: %s", relative, err)
                continue
            text = doc.get("text")
            if isinstance(text, str):
                out[relative] = {"text": text}
        return out

    def apply(self, item_id: str, payload: Any | None) -> None:
        from . import native_memory

        # A delete is never carried through to the user's disk. Removing an
        # instruction file is not the kind of thing one machine should do to
        # another unprompted, and the file is the user's, not ours.
        if payload is None:
            log.info("ignoring a delete for instruction file %s", item_id)
            return
        if not isinstance(payload, dict) or not isinstance(payload.get("text"), str):
            log.warning("instruction file %s arrived without text", item_id)
            return
        target = self._resolve(item_id)
        if target is None:
            log.warning("no known instruction file matches %s on this machine", item_id)
            return
        try:
            native_memory.save(target, payload["text"])
        except Exception as err:  # noqa: BLE001 - a refused write is not fatal
            log.warning("the synced instruction file %s was not written: %s", item_id, err)

    @staticmethod
    def _resolve(relative: str) -> str | None:
        """The absolute path this machine keeps ``relative`` at, if it knows one."""
        from . import native_memory

        for path, (scope, rel, _readers, _canonical) in native_memory.candidates().items():
            if scope == native_memory.USER_SCOPE and rel == relative:
                return str(path)
        return None


# ── credentials ─────────────────────────────────────────────────────────────

#: Schema component for the adapter's own table, versioned apart from the
#: engine's bookkeeping so either can move without the other.
_CREDENTIALS_COMPONENT = "sync-credentials"
CREDENTIAL_ORIGIN_LOCAL = "local"
CREDENTIAL_ORIGIN_IMPORTED = "imported"
_CREDENTIAL_PAYLOAD_VERSION = 1
_ITEM_ID_RE = re.compile(r"^c-[0-9a-f]{32}$")
_SLOT_RE = re.compile(r"^(__default__|[A-Za-z0-9][A-Za-z0-9._-]{0,63})$")
_MAX_CREDENTIAL_LEN = 8192


def _credentials_schema(cur: Any) -> None:
    # One row per credential this machine knows about, by the opaque id it
    # travels under. ``sealed`` holds the payload ciphertext for an imported
    # row and NULL for a local one (whose value lives in the vault, under the
    # portable-credentials module). Plaintext never reaches this table.
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS sync_credential_items (
            item_id    TEXT    PRIMARY KEY,
            agent_key  TEXT    NOT NULL,
            slot_id    TEXT    NOT NULL,
            origin     TEXT    NOT NULL,
            sealed     TEXT,
            disabled   INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL
        )
        """
    )
    cur.execute(
        "CREATE INDEX IF NOT EXISTS sync_credential_items_slot"
        " ON sync_credential_items (agent_key, slot_id)"
    )


def _new_item_id() -> str:
    # Random, not derived: a name computed from ``<vendor>/<slot>`` would let
    # anyone holding the server's rows guess which CLIs an account uses, and a
    # name computed from the account key would change when that key rotates.
    return "c-" + secrets.token_hex(16)


class CredentialsScope:
    """Portable CLI credentials — the values Settings → Accounts lets a user
    paste so a pane can be handed them in its environment.

    The payload of one item is ``{"v": 1, "agentKey", "slotId", "value"}`` and
    nothing else, so two devices that pasted the same token agree it is the
    same item; the time it was pasted stays local, and the cloud side's
    ``updatedAt`` says when it last changed up there.

    Two origins. A *local* item is one this machine's user pasted: its value
    is in the vault under ``portable_credentials`` and only its id is kept
    here. An *imported* item arrived through a pull: its payload is kept
    sealed under the account key (the same associated data as on the wire),
    opened into memory on first use, and never written anywhere in the clear
    — not the vault, not a CLI's login file. ``imported_value`` is the one
    reader, for the spawn path.

    The ``sensitive`` flag asks the engine for what the rest of this design
    needs: no tombstone for an item that is merely not here, sealed conflict
    rows, and a failed round rather than a skipped record when a body will
    not open.

    Removal is local. A local item whose vault value is gone, or an imported
    one the user turned off here, is marked *disabled* — a secret-free row
    that survives restarts and re-enabling the scope, so a later pull cannot
    quietly put the credential back. A disabled item leaves the snapshot and,
    because of ``sensitive``, is not deleted from the cloud: other devices
    keep working, and this one is one explicit pull away from rejoining.
    """

    scope = "credentials"
    sensitive = True

    def __init__(
        self,
        db: Any,
        *,
        entries: Callable[[], list[tuple[str, str]]] | None = None,
        read_secret: Callable[[str, str], str | None] | None = None,
        forget_local: Callable[[str, str], None] | None = None,
        accepts: Callable[[str, str], bool] | None = None,
    ) -> None:
        self._db = db
        self._db.migrate(_CREDENTIALS_COMPONENT, 1, _credentials_schema)
        self._entries = entries or _portable_entries
        self._read_secret = read_secret or _portable_read_secret
        self._forget_local = forget_local or _portable_forget
        self._accepts = accepts or _portable_accepts
        #: Opened imported payloads, by item id. Memory only.
        self._values: dict[str, dict[str, Any]] = {}
        self._lock = threading.Lock()

    # ── rows ────────────────────────────────────────────────────────────
    def _rows(self, where: str = "", args: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
        sql = (
            "SELECT item_id, agent_key, slot_id, origin, sealed, disabled, updated_at"
            " FROM sync_credential_items"
        )
        if where:
            sql += " WHERE " + where
        with self._db.transaction() as cur:
            rows = cur.execute(sql, args).fetchall()
        return [
            {
                "itemId": str(r[0]),
                "agentKey": str(r[1]),
                "slotId": str(r[2]),
                "origin": str(r[3]),
                "sealed": r[4],
                "disabled": bool(r[5]),
                "updatedAt": int(r[6]),
            }
            for r in rows
        ]

    def _row(self, item_id: str) -> dict[str, Any] | None:
        rows = self._rows("item_id = ?", (item_id,))
        return rows[0] if rows else None

    def _write(
        self,
        item_id: str,
        *,
        agent_key: str,
        slot_id: str,
        origin: str,
        sealed: str | None,
        disabled: bool,
    ) -> None:
        with self._db.transaction() as cur:
            cur.execute(
                """
                INSERT INTO sync_credential_items
                    (item_id, agent_key, slot_id, origin, sealed, disabled, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(item_id) DO UPDATE SET
                    agent_key = excluded.agent_key,
                    slot_id = excluded.slot_id,
                    origin = excluded.origin,
                    sealed = excluded.sealed,
                    disabled = excluded.disabled,
                    updated_at = excluded.updated_at
                """,
                (item_id, agent_key, slot_id, origin, sealed, 1 if disabled else 0, int(time.time())),
            )

    def _delete(self, item_id: str) -> None:
        with self._db.transaction() as cur:
            cur.execute("DELETE FROM sync_credential_items WHERE item_id = ?", (item_id,))
        with self._lock:
            self._values.pop(item_id, None)

    def _row_for_local(self, agent_key: str, slot_id: str) -> dict[str, Any]:
        """The row a locally pasted value travels under, minting one if needed.

        A local row wins. Failing that, the newest imported row for the same
        slot is taken over: pasting a value where an imported one was in use
        is the user replacing that credential, and the replacement should
        reach the other devices as an update of the same item rather than as
        a second one beside it.
        """
        rows = self._rows("agent_key = ? AND slot_id = ?", (agent_key, slot_id))
        local = [r for r in rows if r["origin"] == CREDENTIAL_ORIGIN_LOCAL]
        if local:
            return local[0]
        imported = sorted(
            (r for r in rows if r["origin"] == CREDENTIAL_ORIGIN_IMPORTED),
            key=lambda r: r["updatedAt"],
            reverse=True,
        )
        if imported:
            return imported[0]
        item_id = _new_item_id()
        self._write(
            item_id,
            agent_key=agent_key,
            slot_id=slot_id,
            origin=CREDENTIAL_ORIGIN_LOCAL,
            sealed=None,
            disabled=False,
        )
        return self._row(item_id) or {
            "itemId": item_id,
            "agentKey": agent_key,
            "slotId": slot_id,
            "origin": CREDENTIAL_ORIGIN_LOCAL,
            "sealed": None,
            "disabled": False,
            "updatedAt": int(time.time()),
        }

    # ── payloads ────────────────────────────────────────────────────────
    @staticmethod
    def _payload(agent_key: str, slot_id: str, value: str) -> dict[str, Any]:
        return {
            "v": _CREDENTIAL_PAYLOAD_VERSION,
            "agentKey": agent_key,
            "slotId": slot_id,
            "value": value,
        }

    @staticmethod
    def _valid(payload: Any) -> dict[str, Any] | None:
        """The payload if it has exactly the expected shape, else None.

        Whitelisted field by field: what arrives here came out of a body
        another device sealed, and a body is trusted to be *from the account*,
        not to be well-formed.
        """
        if not isinstance(payload, dict) or payload.get("v") != _CREDENTIAL_PAYLOAD_VERSION:
            return None
        agent_key = payload.get("agentKey")
        slot_id = payload.get("slotId")
        value = payload.get("value")
        if not (isinstance(agent_key, str) and _SLOT_RE.match(agent_key)):
            return None
        if not (isinstance(slot_id, str) and _SLOT_RE.match(slot_id)):
            return None
        if not (isinstance(value, str) and value and len(value) <= _MAX_CREDENTIAL_LEN):
            return None
        if any(ord(ch) < 0x20 or ch == "\x7f" for ch in value):
            return None
        return {"v": _CREDENTIAL_PAYLOAD_VERSION, "agentKey": agent_key, "slotId": slot_id, "value": value}

    @staticmethod
    def describe(payload: Any) -> dict[str, Any] | None:
        """What may be said about a payload to anyone: which slot, never what."""
        valid = CredentialsScope._valid(payload)
        if valid is None:
            return None
        return {"agentKey": valid["agentKey"], "slotId": valid["slotId"]}

    def _open(self, row: dict[str, Any]) -> dict[str, Any]:
        """The payload of an imported row, from memory or the sealed column.

        The payload is returned as it was sealed — its own ``agentKey`` and
        ``slotId`` — rather than rebuilt from the row, so what this machine
        holds is byte-for-byte what syncs.

        Raises ``SyncError`` when it will not open: a snapshot with a hole in
        it is how a credential gets tombstoned, so the round fails instead.
        """
        item_id = row["itemId"]
        with self._lock:
            cached = self._values.get(item_id)
        if cached is not None:
            return dict(cached)
        try:
            opened = self._valid(
                json.loads(
                    sync_keyring.decrypt(str(row["sealed"] or ""), scope=self.scope, item_id=item_id)
                )
            )
        except Exception as err:  # noqa: BLE001 - see docstring
            raise sync_engine.SyncError(
                f"the imported credential {item_id} could not be opened: {err}"
            ) from err
        if opened is None:
            raise sync_engine.SyncError(f"the imported credential {item_id} is malformed")
        with self._lock:
            self._values[item_id] = opened
        return dict(opened)

    # ── ScopeAdapter ────────────────────────────────────────────────────
    def snapshot(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        seen_local: set[str] = set()
        for agent_key, slot_id in self._entries():
            value = self._read_secret(agent_key, slot_id)
            if not (isinstance(value, str) and value):
                continue
            if not self._accepts(agent_key, value):
                log.info("credential for %s/%s is not eligible for sync", agent_key, slot_id)
                continue
            row = self._row_for_local(agent_key, slot_id)
            if row["origin"] != CREDENTIAL_ORIGIN_LOCAL or row["disabled"]:
                # Pasting is explicit: it takes the item over and switches it
                # back on. The imported copy, if any, is superseded.
                self._write(
                    row["itemId"],
                    agent_key=agent_key,
                    slot_id=slot_id,
                    origin=CREDENTIAL_ORIGIN_LOCAL,
                    sealed=None,
                    disabled=False,
                )
                with self._lock:
                    self._values.pop(row["itemId"], None)
            out[row["itemId"]] = self._payload(agent_key, slot_id, value)
            seen_local.add(row["itemId"])
        for row in self._rows():
            item_id = row["itemId"]
            if item_id in seen_local or row["disabled"]:
                continue
            if row["origin"] == CREDENTIAL_ORIGIN_IMPORTED and not row["sealed"]:
                continue  # switched back on, waiting for the pull that fills it
            if row["origin"] == CREDENTIAL_ORIGIN_LOCAL:
                # The vault no longer has it: the user removed it here. Say so
                # durably, so a pull cannot bring it back unasked.
                self._write(
                    item_id,
                    agent_key=row["agentKey"],
                    slot_id=row["slotId"],
                    origin=CREDENTIAL_ORIGIN_LOCAL,
                    sealed=None,
                    disabled=True,
                )
                continue
            out[item_id] = self._open(row)
        return out

    def apply(self, item_id: str, payload: Any | None) -> bool:
        """Take one record in. False means it was declined and is not held
        here, which the engine records as "nothing agreed for this item"."""
        row = self._row(item_id)
        if payload is None:
            # A tombstone. Never carried through to a local value — that is
            # the user's own paste on this machine — and an imported copy is
            # simply let go of.
            if row is not None and row["origin"] == CREDENTIAL_ORIGIN_IMPORTED:
                self._delete(item_id)
            return True
        valid = self._valid(payload)
        if valid is None:
            log.warning("credential %s arrived malformed and was not imported", item_id)
            return False
        if row is not None and row["disabled"]:
            return False  # turned off on this device; the cloud copy stays where it is
        if row is not None and row["origin"] == CREDENTIAL_ORIGIN_LOCAL:
            # Another device replaced the value this machine's user pasted.
            # The item is the same item, so the local copy gives way: the
            # vault entry goes, and the new value is held like any import.
            try:
                self._forget_local(row["agentKey"], row["slotId"])
            except Exception as err:  # noqa: BLE001 - a stuck vault must not block the import
                log.warning("the local copy of %s could not be cleared: %s", item_id, err)
        sealed = sync_keyring.encrypt(
            sync_engine.canonical(valid), scope=self.scope, item_id=item_id
        )
        self._write(
            item_id,
            agent_key=valid["agentKey"],
            slot_id=valid["slotId"],
            origin=CREDENTIAL_ORIGIN_IMPORTED,
            sealed=sealed,
            disabled=False,
        )
        with self._lock:
            self._values[item_id] = valid
        return True

    def request_items(self, item_ids: list[str]) -> None:
        """An explicit pull of these items is the user asking to have them
        here: a disabled row is switched back on so ``apply`` will take it.

        The row becomes an *imported* one waiting for its payload, whatever
        it was before. A removed local paste has no vault value to come back
        to, and a local row without one reads as "removed here" on the very
        next snapshot — which would switch it off again before the pull
        could fill it.
        """
        for item_id in item_ids:
            row = self._row(item_id)
            if row is not None and row["disabled"]:
                self._write(
                    item_id,
                    agent_key=row["agentKey"],
                    slot_id=row["slotId"],
                    origin=CREDENTIAL_ORIGIN_IMPORTED,
                    sealed=None,
                    disabled=False,
                )

    # ── what the rest of the backend may ask ────────────────────────────
    def imported_value(self, agent_key: str, slot_id: str) -> str | None:
        """The imported value in use for a slot, for the spawn path only.

        The newest enabled imported row wins when there are several. None
        when nothing is imported, or when it cannot be opened here — a spawn
        must never fail because the sync key is away; it just goes without.
        """
        rows = [
            r
            for r in self._rows("agent_key = ? AND slot_id = ?", (agent_key, slot_id))
            if r["origin"] == CREDENTIAL_ORIGIN_IMPORTED and not r["disabled"] and r["sealed"]
        ]
        for row in sorted(rows, key=lambda r: r["updatedAt"], reverse=True):
            try:
                return str(self._open(row)["value"])
            except sync_engine.SyncError as err:
                log.warning("%s", err)
        return None

    def disable(self, agent_key: str, slot_id: str) -> int:
        """Stop using every imported copy of a slot on this machine.

        The value is dropped from memory and the sealed column; the row stays
        as a disabled marker. The cloud is not told. Returns how many rows
        were switched off.
        """
        count = 0
        for row in self._rows("agent_key = ? AND slot_id = ?", (agent_key, slot_id)):
            if row["disabled"]:
                continue
            self._write(
                row["itemId"],
                agent_key=agent_key,
                slot_id=slot_id,
                origin=row["origin"],
                sealed=None,
                disabled=True,
            )
            with self._lock:
                self._values.pop(row["itemId"], None)
            count += 1
        return count

    def imported_listing(self) -> list[dict[str, Any]]:
        """Every imported credential in use here, for the accounts listing.

        ``available`` says whether ``imported_value`` would answer right now:
        a sealed row this machine's key will not open lists as unavailable
        rather than vanishing, so the pane can say why a slot does not work.
        Metadata only.
        """
        out: list[dict[str, Any]] = []
        for row in self._rows("origin = ?", (CREDENTIAL_ORIGIN_IMPORTED,)):
            if row["disabled"] or not row["sealed"]:
                continue
            try:
                self._open(row)
                available = True
            except sync_engine.SyncError:
                available = False
            out.append(
                {
                    "agentKey": row["agentKey"],
                    "slotId": row["slotId"],
                    "available": available,
                    "updatedAt": datetime.fromtimestamp(row["updatedAt"], tz=timezone.utc).isoformat(
                        timespec="seconds"
                    ),
                }
            )
        return out

    def listing(self) -> list[dict[str, Any]]:
        """Every row as metadata: id, slot, origin, disabled, when. No values."""
        return [
            {k: v for k, v in row.items() if k != "sealed"}
            for row in self._rows()
        ]

    def clear_imported(self) -> None:
        """Forget everything that came from the cloud — on signing out or
        switching accounts. Local rows keep their ids; their disabled marks
        stay too, so a removal survives the switch."""
        with self._db.transaction() as cur:
            cur.execute(
                "DELETE FROM sync_credential_items WHERE origin = ?",
                (CREDENTIAL_ORIGIN_IMPORTED,),
            )
        with self._lock:
            self._values.clear()


# Default seams onto the portable-credentials module. Kept as functions so a
# test can hand the adapter synthetic ones and never touch a vault.

def _portable_entries() -> list[tuple[str, str]]:
    from . import portable_credentials

    lister = getattr(portable_credentials, "list_stored", None)
    if lister is None:
        return []
    try:
        return [(str(a), str(s)) for a, s in lister()]
    except Exception as err:  # noqa: BLE001 - an unreadable vault syncs nothing
        log.warning("the portable credentials could not be listed: %s", err)
        return []


def _portable_read_secret(agent_key: str, slot_id: str) -> str | None:
    from . import portable_credentials

    reader = getattr(portable_credentials, "read_secret", None)
    return reader(agent_key, slot_id) if reader is not None else None


def _portable_forget(agent_key: str, slot_id: str) -> None:
    from . import portable_credentials

    # ``notify_sync=False``: the default would call ``forget_credential`` and
    # retire the imported copy that is about to be served in its place.
    portable_credentials.forget(agent_key, slot_id, notify_sync=False)


def _portable_accepts(agent_key: str, value: str) -> bool:
    """Only a value the vendor declares portable and still validates goes up."""
    from . import portable_credentials

    if portable_credentials.portable_spec(agent_key) is None:
        return False
    try:
        portable_credentials.validate_value(agent_key, value)
    except Exception:  # noqa: BLE001 - whatever the reason, it does not travel
        return False
    return True


_credentials_scope: CredentialsScope | None = None
_credentials_lock = threading.Lock()


def credentials_scope() -> CredentialsScope:
    """The one adapter instance — registered with the engine and consulted by
    the spawn and account-lifecycle paths, which must see the same rows."""
    global _credentials_scope
    with _credentials_lock:
        if _credentials_scope is None:
            from . import app

            _credentials_scope = CredentialsScope(app.database)
        return _credentials_scope


def imported_credential(agent_key: str, slot_id: str) -> str | None:
    """For the spawn path: the value pulled from the cloud for this slot, if
    any. Blocking (may open the vault for the account key); call off the
    event loop."""
    return credentials_scope().imported_value(agent_key, slot_id)


def imported_credentials() -> list[dict[str, Any]]:
    """For the accounts listing: the imported credentials this machine can
    use, as ``{agentKey, slotId, available, updatedAt}``. Blocking; call off
    the event loop. Never a value."""
    return credentials_scope().imported_listing()


def forget_credential(agent_key: str, slot_id: str) -> int:
    """For the remove path: stop using this slot's imported copies here."""
    return credentials_scope().disable(agent_key, slot_id)


def credential_saved(agent_key: str, slot_id: str) -> None:
    """For the save path: a paste is an edit worth carrying up now, not on
    the next round that happens by. Nothing happens unless the scope is on
    and the link is up; ``sync_now`` says so itself.

    Must be called on the event loop (the WS handler, after its blocking
    store returns) — a worker thread has no loop to schedule on, and that is
    said out loud rather than dropped. Rounds on one scope are serialised by
    the engine, so a save landing mid-round simply runs after it.
    """
    from . import server_link

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        log.warning(
            "credential_saved for %s/%s was called off the event loop; no sync scheduled",
            agent_key, slot_id,
        )
        return
    log.info("portable credential for %s/%s changed; scheduling a sync", agent_key, slot_id)
    loop.create_task(server_link.sync_now(scope="credentials"))


def on_account_changed() -> None:
    """Signing out or switching the cloud account.

    Everything imported is let go of and the engine's record of the scope is
    dropped, then the scope itself is switched off: what this machine's user
    pasted stays here, and goes up to the new account only once they turn
    the section on again. Sync is opt-in per account, not per install.
    """
    from . import app

    credentials_scope().clear_imported()
    app.sync_store.forget("credentials")
    try:
        set_scope_enabled("credentials", False)
    except Exception as err:  # noqa: BLE001 - settings that will not write do not stop a sign-out
        log.warning("the credentials scope could not be switched off: %s", err)


def _reset_credentials_for_test() -> None:
    global _credentials_scope
    with _credentials_lock:
        _credentials_scope = None
