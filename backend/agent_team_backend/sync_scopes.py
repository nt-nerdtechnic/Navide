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

import logging
from typing import Any, Callable

from . import sync_engine

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
    current = enabled_scopes()
    current[scope] = bool(enabled)
    _settings().set({SCOPES_SETTING: current})
    return current


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
