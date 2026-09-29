# Adding a chat platform

A chat platform (Telegram, Slack, …) is one adapter file on the backend and one
spec file on the renderer, plus one registry line on each side. No shared
component or composable may contain `platform === '<name>'` or a hard-coded
platform list — everything platform-specific lives in the two per-platform files.

## Backend (`backend/agent_team_backend/channels/`)

1. Copy `_template.py` to `<id>.py` (short lowercase id). Implement the
   `base.ChannelAdapter` protocol: `start/stop`, `send_text`, `edit_text`,
   `send_typing`, `create_location`, `token_fingerprint`, and a module-level
   `create_adapter(config, secret, *, store)` factory. Optional hooks the
   manager probes with `getattr`: `link_url(code, target)` (pairing deep link),
   `known_locations()` (the "existing chat" picker), `account` (attribute).
2. Add `"<id>"` to `Platform` in `base.py` and a limit to `text.TEXT_LIMITS`.
3. Register it: one line in `PLATFORMS` in `channels/registry.py` (display order).
   `manager.PLATFORMS` is an alias of it.
4. Add `agent_team_backend.channels.<id>` to `hiddenimports` in
   `backend/agent_team_backend.spec` (adapters are loaded with
   `importlib`, which PyInstaller cannot see). `test_pyinstaller_spec.py` fails
   if a registered platform is missing.
5. Tests: `backend/tests/test_channels_<id>.py` with a fake transport or a local
   server on `127.0.0.1` — never the real platform. `test_channels_registry.py`
   checks the id imports and exposes a complete adapter.

Verify: `uv --project backend run pytest backend/tests -k "channels or pyinstaller"`.

## Renderer (`src/renderer/src/platform/channels/`)

1. Copy `_template.ts` to `<id>.ts`. The id must match the file name and the
   backend registry id. Fill in `badge`, `fields` (credential inputs) and `link`
   (pairing guide targets and i18n keys).
2. Add one import in `index.ts` and put the spec in `ORDERED` (same order as the
   backend registry).
3. Add the id to `BACKEND_IDS` in `__tests__/registry.test.ts`.
4. Add i18n keys `channels.platform.<id>`, `channels.desc.<id>`, and
   `channels.field.<key>` for each new field, in `en-US`, `zh-TW` and `ja-JP`.

Verify: `pnpm typecheck` and `pnpm test:run`.
