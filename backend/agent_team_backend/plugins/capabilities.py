"""Capability API: the controlled façade a plugin uses to reach core services.

A capability is how the host grants a plugin *scoped* access to a core service.
Each capability class wraps one core service (``fs_service``, ``git_service``,
the terminal service) and exposes a small, deliberate surface -- never the raw
module. The host builds only the capabilities a plugin declares in
``manifest.requires`` (see :func:`build_capabilities`) and injects them into
``PluginContext.capabilities``; a plugin that did not declare ``"git"`` simply
has no git capability to reach for.

Interface-shell status
----------------------
This is the Phase 1 skeleton. Each capability exposes only a few representative
methods -- enough to prove the "authorize + delegate to service" path works end
to end, not the full contract. Method **signatures are provisional**: Phase 2
(the real WS-handler migration) will settle them and route more calls through
here. Every method below is marked accordingly.

Delegation uses a function-level ``from .. import app`` so importing this module
stays cheap and free of import cycles; the core service singletons live on
``app`` (``app.fs_service``, ``app.git_service``, ``app.get_terminals()``).
"""

from __future__ import annotations

from typing import Any


class CapabilityError(Exception):
    """Raised when a capability cannot be built or used."""


class FsCapability:
    """Scoped filesystem access, delegating to ``app.fs_service``.

    Interface shell: exposes a representative read/write/list subset; Phase 2
    settles signatures and adds the rest.
    """

    def read_file(
        self,
        workspace_path: str,
        rel_path: str,
        encoding_override: str | None = None,
    ) -> dict[str, Any]:
        # Signature provisional -- interface shell, filled in during Phase 2.
        from .. import app

        return app.fs_service.read_file(workspace_path, rel_path, encoding_override)

    def write_file(
        self,
        workspace_path: str,
        rel_path: str,
        content: str,
    ) -> dict[str, Any]:
        # Signature provisional -- interface shell, filled in during Phase 2.
        from .. import app

        return app.fs_service.write_file(workspace_path, rel_path, content)

    def list_dir(
        self,
        workspace_path: str,
        rel_path: str = "",
        show_hidden: bool = False,
    ) -> dict[str, Any]:
        # Signature provisional -- interface shell, filled in during Phase 2.
        from .. import app

        return app.fs_service.list_dir(workspace_path, rel_path, show_hidden)

    def list_files_flat(
        self,
        workspace_path: str,
        query: str = "",
        max_results: int = 200,
    ) -> dict[str, Any]:
        # Signature provisional -- interface shell, filled in during Phase 2.
        from .. import app

        return app.fs_service.list_files_flat(
            workspace_path, query=query, max_results=max_results
        )

    def glob_files(self, workspace_path: str, pattern: str) -> dict[str, Any]:
        # Signature provisional -- interface shell, filled in during Phase 2.
        from .. import app

        return app.fs_service.glob_files(workspace_path, pattern=pattern)

    def create_file(
        self,
        workspace_path: str,
        rel_path: str,
        content: str = "",
    ) -> dict[str, Any]:
        # Signature provisional -- interface shell, filled in during Phase 2.
        from .. import app

        return app.fs_service.create_file(workspace_path, rel_path, content)

    def delete(self, workspace_path: str, rel_path: str) -> dict[str, Any]:
        # Signature provisional -- interface shell, filled in during Phase 2.
        from .. import app

        return app.fs_service.delete(workspace_path, rel_path)

    def mkdir(self, workspace_path: str, rel_path: str) -> dict[str, Any]:
        # Signature provisional -- interface shell, filled in during Phase 2.
        from .. import app

        return app.fs_service.mkdir(workspace_path, rel_path)

    def rename(
        self,
        workspace_path: str,
        src_path: str,
        dst_path: str,
    ) -> dict[str, Any]:
        # Signature provisional -- interface shell, filled in during Phase 2.
        from .. import app

        return app.fs_service.rename(workspace_path, src_path, dst_path)

    def convert_office(self, workspace_path: str, rel_path: str) -> dict[str, Any]:
        # Signature provisional -- interface shell, filled in during Phase 2.
        from .. import app

        return app.fs_service.convert_office(workspace_path, rel_path)

    def list_archive(self, workspace_path: str, rel_path: str) -> dict[str, Any]:
        # Signature provisional -- interface shell, filled in during Phase 2.
        from .. import app

        return app.fs_service.list_archive(workspace_path, rel_path)


class GitCapability:
    """Scoped git access, delegating to ``app.git_service``.

    Interface shell: exposes status/log; Phase 2 settles signatures and adds
    the rest. The underlying service functions are async, so these façade
    methods return the awaitable the caller then awaits.
    """

    def status(self, workspace_path: str, include_ignored: bool = False) -> Any:
        # Signature provisional -- interface shell, filled in during Phase 2.
        from .. import app

        return app.git_service.get_status(workspace_path, include_ignored)

    def log(self, workspace_path: str, **kwargs: Any) -> Any:
        # Signature provisional -- interface shell, filled in during Phase 2.
        from .. import app

        return app.git_service.get_log(workspace_path, **kwargs)

    def commit(self, workspace_path: str, message: str, commit_all: bool = False) -> Any:
        # Signature provisional -- interface shell, filled in during Phase 2.
        from .. import app

        return app.git_service.commit(workspace_path, message, commit_all)

    def diff_all(self, workspace_path: str, staged: bool = False) -> Any:
        # Signature provisional -- interface shell, filled in during Phase 2.
        from .. import app

        return app.git_service.diff_all(workspace_path, staged=staged)

    def diff_file(self, workspace_path: str, filepath: str, staged: bool = False) -> Any:
        # Signature provisional -- interface shell, filled in during Phase 2.
        from .. import app

        return app.git_service.diff_file(workspace_path, filepath, staged=staged)

    def diff_branches(self, workspace_path: str, base: str, compare: str) -> Any:
        # Signature provisional -- interface shell, filled in during Phase 2.
        from .. import app

        return app.git_service.diff_branches(workspace_path, base, compare)

    def show_commit(self, workspace_path: str, commit_hash: str) -> Any:
        # Signature provisional -- interface shell, filled in during Phase 2.
        from .. import app

        return app.git_service.show_commit(workspace_path, commit_hash)

    def stash_list(self, workspace_path: str) -> Any:
        # Signature provisional -- interface shell, filled in during Phase 2.
        from .. import app

        return app.git_service.stash_list(workspace_path)

    def apply_patch(
        self,
        workspace_path: str,
        patch: str,
        reverse: bool = False,
        cached: bool = False,
    ) -> Any:
        # Signature provisional -- interface shell, filled in during Phase 2.
        from .. import app

        return app.git_service.apply_patch(
            workspace_path, patch, reverse=reverse, cached=cached
        )


class TerminalCapability:
    """Scoped terminal access, delegating to the app terminal service.

    Interface shell: terminal creation is tightly coupled to a PTY and the
    running event loop (``TerminalService.create`` needs a pane id, cwd, PTY
    wiring), so this façade exposes only a query-type method -- ``list`` of live
    session ids -- to prove the delegation path. It reads the service's private
    ``_sessions`` because no public accessor exists yet; Phase 2 should add a
    public listing API and a properly scoped ``create`` façade.
    """

    def list(self) -> list[str]:
        # Signature provisional -- interface shell, filled in during Phase 2.
        from .. import app

        return list(app.get_terminals()._sessions.keys())

    async def run(self, command: str, cwd: str | None = None) -> dict[str, Any]:
        # Signature provisional -- interface shell, filled in during Phase 2.
        #
        # The ``shell.run`` WS handler has no backing service: it inlines
        # ``asyncio.create_subprocess_exec('/bin/sh', '-c', cmd)`` after
        # validating that ``cwd`` is a registered workspace. This façade wraps
        # the same restricted subprocess call. Workspace-path validation is the
        # host's responsibility and is intentionally NOT duplicated here; Phase
        # 2 should extract a proper ShellService and route both through it.
        import asyncio

        proc = await asyncio.create_subprocess_exec(
            "/bin/sh",
            "-c",
            command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            cwd=cwd,
        )
        stdout, _ = await proc.communicate()
        return {
            "ok": True,
            "output": stdout.decode("utf-8", errors="replace"),
            "exit_code": proc.returncode,
        }


class SearchCapability:
    """Scoped workspace search, delegating to ``app.search_service``.

    Interface shell: exposes find/replace-in-files; Phase 2 settles signatures.
    Both underlying service functions are synchronous (they run in a worker
    thread in the WS handler), so these façade methods return their results
    directly.
    """

    def find_in_files(
        self,
        workspace_path: str,
        query: str,
        **kwargs: Any,
    ) -> dict[str, Any]:
        # Signature provisional -- interface shell, filled in during Phase 2.
        from .. import app

        return app.search_service.find_in_files(workspace_path, query, **kwargs)

    def replace_in_files(
        self,
        workspace_path: str,
        query: str,
        replacement: str,
        files: list[str],
        **kwargs: Any,
    ) -> dict[str, Any]:
        # Signature provisional -- interface shell, filled in during Phase 2.
        from .. import app

        return app.search_service.replace_in_files(
            workspace_path, query, replacement, files, **kwargs
        )


class ChatCapability:
    """Scoped AI-chat access, delegating to the chat/editor core services.

    Interface shell: the chat surface is heterogeneous -- some calls map to a
    single core singleton (``ai_chat_settings_store``, ``chat_store``,
    ``editor_service``, ``fs_service``, ``ai_chat_tools``), others are
    session/broadcast/HTTP-coupled inside their WS handler with no extractable
    service yet. Methods in the first group delegate; methods in the second are
    provisional placeholders that raise until Phase 2 extracts a service.
    Signatures are provisional throughout.
    """

    # -- delegating: backed by a single core singleton --------------------

    def settings_get(self) -> dict[str, Any]:
        # Signature provisional -- interface shell, filled in during Phase 2.
        from .. import app

        return app.ai_chat_settings_store.get()

    def settings_set(self, settings: dict[str, Any]) -> dict[str, Any]:
        # Signature provisional -- interface shell, filled in during Phase 2.
        from .. import app

        return app.ai_chat_settings_store.set(settings)

    def notes_set(
        self,
        workspace_path: str,
        notes: str = "",
        notepads: list | None = None,
    ) -> Any:
        # Signature provisional -- interface shell, filled in during Phase 2.
        from .. import app

        return app.chat_store.set_notes(
            workspace_path, notes=notes, notepads=notepads or []
        )

    def threads_set(self, workspace_path: str, threads: list) -> Any:
        # Signature provisional -- interface shell, filled in during Phase 2.
        from .. import app

        return app.chat_store.set_threads(workspace_path, threads)

    def accept_edit(
        self,
        workspace_path: str,
        file_path: str,
        new_content: str,
    ) -> dict[str, Any]:
        # Signature provisional -- interface shell, filled in during Phase 2.
        # Delegates the file write; the handler's git.changed broadcast is
        # host-side and intentionally not mirrored here.
        from .. import app

        return app.fs_service.write_file(workspace_path, file_path, new_content)

    def approve_command(self, session_id: str, tool_id: str) -> None:
        # Signature provisional -- interface shell, filled in during Phase 2.
        from ..ai_chat_tools import approve_command

        approve_command(session_id, tool_id, approved=True)

    def reject_command(self, session_id: str, tool_id: str) -> None:
        # Signature provisional -- interface shell, filled in during Phase 2.
        from ..ai_chat_tools import approve_command

        approve_command(session_id, tool_id, approved=False)

    def editor_complete(
        self,
        base_url: str,
        model: str,
        prefix: str,
        suffix: str = "",
        language: str = "",
    ) -> Any:
        # Signature provisional -- interface shell, filled in during Phase 2.
        from .. import app

        return app.editor_service.complete(base_url, model, prefix, suffix, language)

    def editor_rewrite(
        self,
        base_url: str,
        model: str,
        code: str,
        instruction: str,
        language: str = "",
    ) -> Any:
        # Signature provisional -- interface shell, filled in during Phase 2.
        from .. import app

        return app.editor_service.rewrite(base_url, model, code, instruction, language)

    # -- provisional: no extractable service yet --------------------------
    # ``start``/``stop`` are session-task + agent-loop coupled;
    # ``test_connection``/``enhance_prompt``/``web_search`` inline per-provider
    # HTTP inside their WS handler. They raise until Phase 2 extracts a service.

    def start(self, *args: Any, **kwargs: Any) -> Any:
        raise CapabilityError(
            "chat.start is provisional: session/agent-loop coupled, "
            "no core service to delegate to yet (Phase 2)"
        )

    def stop(self, *args: Any, **kwargs: Any) -> Any:
        raise CapabilityError(
            "chat.stop is provisional: session-task coupled, "
            "no core service to delegate to yet (Phase 2)"
        )

    def test_connection(self, *args: Any, **kwargs: Any) -> Any:
        raise CapabilityError(
            "chat.test_connection is provisional: per-provider HTTP inlined in "
            "the WS handler, no core service to delegate to yet (Phase 2)"
        )

    def enhance_prompt(self, *args: Any, **kwargs: Any) -> Any:
        raise CapabilityError(
            "chat.enhance_prompt is provisional: streaming inlined in the WS "
            "handler, no core service to delegate to yet (Phase 2)"
        )

    def web_search(self, *args: Any, **kwargs: Any) -> Any:
        raise CapabilityError(
            "chat.web_search is provisional: HTTP inlined in the WS handler, "
            "no core service to delegate to yet (Phase 2)"
        )


class UiCapability:
    """Host-side UI capability -- registered for authorization only.

    Every method here is served by the Electron host (main-process broker),
    not the Python backend: ``get_cli_pane_buffer`` reads a renderer terminal
    buffer, ``open_external`` shells out to the OS, and the JSON/file dialogs
    are native. The backend has no counterpart, so this class exists purely so
    that ``manifest.requires`` may legally declare ``"ui"`` and be validated
    against KNOWN_CAPABILITIES. Calling any method backend-side is a
    programming error and raises.
    """

    def _host_side(self, name: str) -> "CapabilityError":
        return CapabilityError(
            f"ui.{name} is host-side, brokered in the Electron main process; "
            "the backend has no implementation"
        )

    def get_cli_pane_buffer(self, *args: Any, **kwargs: Any) -> Any:
        raise self._host_side("get_cli_pane_buffer")

    def open_external(self, *args: Any, **kwargs: Any) -> Any:
        raise self._host_side("open_external")

    def open_json(self, *args: Any, **kwargs: Any) -> Any:
        raise self._host_side("open_json")

    def save_json(self, *args: Any, **kwargs: Any) -> Any:
        raise self._host_side("save_json")

    def get_path_for_file(self, *args: Any, **kwargs: Any) -> Any:
        raise self._host_side("get_path_for_file")


# Maps a capability namespace (as declared in ``manifest.requires``) to its
# capability class. Manifest validation already restricts ``requires`` to
# KNOWN_CAPABILITIES, so this stays in lock-step with that set.
_CAPABILITY_CLASSES: dict[str, type] = {
    "fs": FsCapability,
    "git": GitCapability,
    "terminal": TerminalCapability,
    "search": SearchCapability,
    "chat": ChatCapability,
    "ui": UiCapability,
}


def build_capabilities(requires: list[str]) -> dict[str, Any]:
    """Build the capability objects a plugin is authorized to use.

    Returns ``{name: capability}`` containing only the namespaces listed in
    ``requires`` -- authorization is exactly "what you declared, and nothing
    more". A namespace not in ``requires`` yields no entry, so the plugin has
    no object to reach for.

    ``requires`` is expected to be pre-validated by the manifest layer; an
    unknown name here is defensive-only and raises :class:`CapabilityError`.
    """
    capabilities: dict[str, Any] = {}
    for name in requires:
        cls = _CAPABILITY_CLASSES.get(name)
        if cls is None:
            raise CapabilityError(f"unknown capability {name!r}")
        capabilities[name] = cls()
    return capabilities
