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


#: Internal scopes and the switch each one rides with.
_RIDES_WITH = {"skill-files": "skills"}


def scope_enabled(scope: str) -> bool:
    return enabled_scopes().get(_RIDES_WITH.get(scope, scope), False)


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


def skill_entry(store: Any, skill: dict[str, Any]) -> tuple[dict[str, Any], bool]:
    """One skill's sync item, and whether its files were too large to carry.

    A record over the engine's body limit is skipped whole, which would take
    the enabled/targets decision down with the files. So the size is checked
    here, on the sealed body the engine will build, and an entry that would
    not fit goes without its content instead.
    """
    name = skill["name"]
    entry: dict[str, Any] = {
        "enabled": bool(skill.get("enabled", True)),
        "targets": skill.get("targets"),
    }
    try:
        content = store.export_content(name)
    except Exception as err:  # noqa: BLE001 - an unreadable skill still routes
        log.warning("the files of %s could not be read: %s", name, err)
        return entry, False
    if content is None:
        # export_content also answers None for a skill that is not ours.
        return entry, bool(skill.get("managed")) and skill.get("valid", True) is not False
    body = sync_keyring.sealed_length(sync_engine.canonical({**entry, "content": content}))
    if body > sync_engine.MAX_BODY_BYTES:
        log.warning("skill %s is too large to sync whole; sending only its settings", name)
        return entry, True
    entry["content"] = content
    return entry, False


def annotate_content_sync(listing: dict[str, Any], store: Any) -> dict[str, Any]:
    """Mark each managed skill whose files stay on this device (``sync_too_large``).

    When the server can hold blobs, those skills' files do travel — as blobs —
    so they are marked ``sync_via_blobs`` instead, with any transfer in flight
    under ``sync_transfer``.
    """
    blobs = skill_files_scope()
    via_blobs = blobs.available()
    for skill in listing.get("skills", []):
        name = skill.get("name")
        if skill.get("managed") and isinstance(name, str) and name:
            too_large = skill_entry(store, skill)[1]
            skill["sync_too_large"] = too_large and not via_blobs
            if too_large and via_blobs:
                skill["sync_via_blobs"] = True
                transfer = blobs.transfer(name)
                if transfer is not None:
                    skill["sync_transfer"] = transfer
    return listing


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
            out[name] = skill_entry(store, skill)[0]
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


#: Manifest format of a ``skill-files`` record.
_MANIFEST_VERSION = 1
#: How often a running transfer tells the windows how far it got.
_PROGRESS_INTERVAL_S = 0.5


class SkillFilesScope:
    """The files of skills too large for one ``skills`` record, as blobs.

    ``skills`` still carries every skill's settings; for the skills whose
    content it has to leave out (``skill_entry`` says too large), this scope
    carries a manifest — each file's path, blob id, key id, size — and the
    files themselves travel as blobs (``skill_blobs``) straight between this
    machine and object storage.

    A scope of its own, never a field on ``skills``: a build that predates
    blobs would store such an entry without the field and push it back, and
    the manifest would be silently erased. Old builds never pull this scope.

    Transfers never run inside a sync round. ``ready`` answers whether every
    blob of an item is already on the server, and starts an upload when not;
    ``apply`` lands a manifest only once every file is here, and otherwise
    starts the download and defers (the engine holds the cursor on it). Either
    transfer kicks one more round when it finishes. A round therefore stays
    short however large the files are, and the other scopes do not wait.

    Removal is not propagated: a tombstone drops the record, never files, the
    same rule ``skills`` follows.
    """

    scope = "skill-files"

    def __init__(self, notify: Callable[[dict[str, Any]], None] | None = None) -> None:
        self._notify = notify
        self._layout: Any = None
        self._request: Any = None
        self._kick: Callable[[], None] | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._tasks: dict[str, asyncio.Task[Any]] = {}
        self._transfers: dict[str, dict[str, Any]] = {}
        self._last_note: dict[str, float] = {}
        self._digests: Any = None

    # ── wiring ──────────────────────────────────────────────────────────

    def set_notify(self, notify: Callable[[dict[str, Any]], None] | None) -> None:
        self._notify = notify

    def available(self) -> bool:
        """Whether the server this machine last spoke to can hold blobs."""
        return self._layout is not None

    def transfer(self, name: str) -> dict[str, Any] | None:
        entry = self._transfers.get(name)
        return dict(entry) if entry else None

    async def prepare(self, request: Any, kick: Callable[[], None]) -> bool:
        """Called by the engine at the start of each round, on the loop."""
        from . import skill_blobs

        self._request, self._kick, self._loop = request, kick, asyncio.get_running_loop()
        try:
            self._layout = await skill_blobs.server_layout(request)
        except skill_blobs.BlobError as err:
            log.warning("the server's blob storage could not be asked about: %s", err)
            self._layout = None
        return self._layout is not None

    def _store(self):
        from . import app

        return app.skills_store

    def _digest_cache(self):
        if self._digests is None:
            from . import app, skill_blobs

            self._digests = skill_blobs.DigestCache(app.database)
        return self._digests

    def _staging(self):
        from . import app

        path = app.app_data_dir() / "skill-blobs"
        path.mkdir(parents=True, exist_ok=True)
        return path

    # ── what is here ────────────────────────────────────────────────────

    def _large_skills(self) -> dict[str, dict[str, Any]]:
        """Managed skills whose files ``skills`` leaves out, by name → files."""
        store = self._store()
        try:
            listing = store.list_skills()
        except Exception as err:  # noqa: BLE001 - an unreadable library syncs nothing
            log.warning("the skills library could not be read: %s", err)
            return {}
        out: dict[str, dict[str, Any]] = {}
        for skill in listing.get("skills", []):
            name = skill.get("name")
            if not (isinstance(name, str) and name and skill.get("managed")):
                continue
            if not skill_entry(store, skill)[1]:
                continue
            try:
                files = store.list_files(name)
            except Exception as err:  # noqa: BLE001 - one unreadable skill is skipped
                log.warning("the files of %s could not be listed: %s", name, err)
                continue
            if files:
                out[name] = files
        return out

    def _manifest(self, files: dict[str, Any]) -> dict[str, Any]:
        cache = self._digest_cache()
        entries: dict[str, Any] = {}
        for relative, path in sorted(files.items()):
            entry = cache.ref_for(path).to_manifest()
            if path.stat().st_mode & 0o111:
                entry["x"] = True
            entries[relative] = entry
        return {"v": _MANIFEST_VERSION, "files": entries}

    def snapshot(self) -> dict[str, Any]:
        if self._layout is None:
            return {}
        out: dict[str, Any] = {}
        for name, files in self._large_skills().items():
            try:
                out[name] = self._manifest(files)
            except (OSError, sync_keyring.KeyringError) as err:
                log.warning("skill %s could not be named for sync: %s", name, err)
        return out

    @staticmethod
    def _refs_of(payload: Any) -> dict[str, Any]:
        """``relative path → BlobRef`` of a manifest; raises BlobError when malformed."""
        from . import skill_blobs

        if not isinstance(payload, dict) or payload.get("v") != _MANIFEST_VERSION:
            raise skill_blobs.BlobError("not a skill-files manifest this build reads")
        files = payload.get("files")
        if not isinstance(files, dict) or not files:
            raise skill_blobs.BlobError("the manifest lists no files")
        return {str(rel): skill_blobs.BlobRef.from_manifest(entry) for rel, entry in files.items()}

    def refs(self, payload: Any) -> list[str]:
        return sorted({ref.blob_id for ref in self._refs_of(payload).values()})

    # ── transfers ───────────────────────────────────────────────────────

    def _progress(self, name: str, direction: str) -> Callable[[int, int], None]:
        def report(done: int, total: int) -> None:
            self._transfers[name] = {"direction": direction, "done": done, "total": total}
            now = time.monotonic()
            if done < total and now - self._last_note.get(name, 0.0) < _PROGRESS_INTERVAL_S:
                return
            self._last_note[name] = now
            self._announce(name)

        return report

    def _announce(self, name: str) -> None:
        if self._notify is None or self._loop is None:
            return
        payload = {"name": name, "transfer": self.transfer(name)}
        self._loop.call_soon_threadsafe(self._notify, payload)

    def _finish(self, name: str) -> None:
        self._transfers.pop(name, None)
        self._tasks.pop(name, None)
        self._announce(name)

    def _start(self, name: str, work: Callable[[], Any]) -> None:
        """Run *work* (a coroutine factory) for *name* unless one already runs. Loop only."""
        if name in self._tasks and not self._tasks[name].done():
            return

        async def run() -> None:
            try:
                await work()
            except Exception as err:  # noqa: BLE001 - retried by the next round
                log.warning("the files of skill %s did not transfer: %s", name, err)
                self._finish(name)
                return
            self._finish(name)
            if self._kick is not None:
                self._kick()

        self._tasks[name] = asyncio.get_running_loop().create_task(run())

    async def ready(self, item_id: str, payload: Any) -> bool:
        """Whether every blob *payload* names is on the server; starts the upload when not."""
        from . import skill_blobs

        if self._layout is None:
            return False
        refs = self._refs_of(payload)
        try:
            reply = skill_blobs._payload(
                await self._request("blobs.stat", {"blobIds": sorted({r.blob_id for r in refs.values()})})
            )
        except skill_blobs.BlobError as err:
            # This item waits; the rest of the round goes ahead.
            log.warning("could not ask which files of %s are uploaded: %s", item_id, err)
            return False
        missing = {b["blobId"] for b in reply.get("blobs") or [] if b.get("state") != "complete"}
        if not missing:
            return True
        files = self._store().list_files(item_id) or {}
        layout, request = self._layout, self._request
        todo = [(files[rel], ref) for rel, ref in refs.items() if ref.blob_id in missing and rel in files]
        total = sum(layout.sealed_size(ref.size) for _, ref in todo)

        async def upload() -> None:
            done = 0
            seen: set[str] = set()
            report = self._progress(item_id, "upload")
            for path, ref in todo:
                if ref.blob_id in seen:
                    continue
                seen.add(ref.blob_id)
                base = done
                await skill_blobs.upload(request, path, ref, layout, progress=lambda d, _t: report(base + d, total))
                done = base + layout.sealed_size(ref.size)

        self._start(item_id, upload)
        return False

    def apply(self, item_id: str, payload: Any | None) -> Any:
        """Land a manifest's files, or defer until they are downloaded. Worker thread."""
        from . import skill_blobs

        if payload is None:
            return None  # a removal elsewhere never deletes files here
        try:
            refs = self._refs_of(payload)
        except skill_blobs.BlobError as err:
            log.warning("skill-files record %s was not applied: %s", item_id, err)
            return False
        store = self._store()
        if not store.can_import(item_id):
            log.warning("skill %s exists here and is not Navide's; its synced files are not fetched", item_id)
            return False
        staging = self._staging()
        current = {}
        try:
            current = store.list_files(item_id) or {}
        except Exception:  # noqa: BLE001 - not ours, or absent: nothing to reuse
            current = {}
        sources: dict[str, Any] = {}
        wanted: dict[str, Any] = {}
        for rel, ref in refs.items():
            here = current.get(rel)
            if here is not None:
                try:
                    if self._digest_cache().ref_for(here).blob_id == ref.blob_id:
                        sources[rel] = here
                        continue
                except (OSError, sync_keyring.KeyringError):
                    pass
            cached = staging / ref.blob_id
            if cached.is_file():
                sources[rel] = cached
            else:
                wanted[ref.blob_id] = ref
        if wanted:
            if self._layout is None or self._loop is None:
                raise sync_engine.DeferItem(item_id)
            layout, request = self._layout, self._request
            refs_todo = list(wanted.values())
            total = sum(layout.sealed_size(ref.size) for ref in refs_todo)

            async def download() -> None:
                done = 0
                report = self._progress(item_id, "download")
                for ref in refs_todo:
                    base = done
                    await skill_blobs.download(
                        request, ref, staging / ref.blob_id, layout,
                        progress=lambda d, _t: report(base + d, total),
                    )
                    done = base + layout.sealed_size(ref.size)

            self._loop.call_soon_threadsafe(self._start, item_id, download)
            raise sync_engine.DeferItem(item_id)

        executable = {rel for rel, entry in payload["files"].items() if isinstance(entry, dict) and entry.get("x")}
        landed = store.import_files(item_id, sources, executable=executable)
        for source in sources.values():
            if source.parent == staging:
                source.unlink(missing_ok=True)
        if not landed:
            return False
        # The settings arrived through ``skills`` and may have been waiting in
        # the intent map for these files; without applying them now, the next
        # ``skills`` snapshot would read the defaults off the fresh copy.
        decision = SkillsStateScope()._intent().get(item_id)
        if isinstance(decision, dict):
            try:
                store.set_enabled(item_id, bool(decision.get("enabled", True)))
                store.set_targets(item_id, decision.get("targets"))
            except Exception as err:  # noqa: BLE001 - a decision that will not apply is not fatal
                log.warning("the synced decision for %s could not be applied: %s", item_id, err)
        return True


_skill_files: SkillFilesScope | None = None


def skill_files_scope() -> SkillFilesScope:
    """The one ``skill-files`` adapter: the engine registers it and the skills
    listing reads its transfer state, so both must see the same instance."""
    global _skill_files
    if _skill_files is None:
        _skill_files = SkillFilesScope()
    return _skill_files


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
