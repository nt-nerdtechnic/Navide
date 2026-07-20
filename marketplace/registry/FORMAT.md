# Navide plugin package format (`.vsix`-style)

A publishable plugin is a single **ZIP archive** (conventionally `*.vsix`) that
contains a `manifest.json` at its root plus optional asset files. The layout is
intentionally close to the VS Code `.vsix` idea (a ZIP with a manifest and
assets) but uses Navide's own trimmed manifest vocabulary — the same fields the
in-app plugin host already validates
(`backend/agent_team_backend/plugins/manifest.py`).

## Archive layout

```
my-plugin-0.1.0.vsix   (a ZIP archive)
├── manifest.json      (required, at archive root)
├── README.md          (optional)
├── icon.png           (optional; path is whatever manifest.icon points to)
└── screenshots/       (optional)
    └── main.png
```

Rules enforced by the reader (`registry/package.py`):

- The archive MUST be a valid ZIP.
- `manifest.json` MUST exist at the archive root and be valid JSON.
- The manifest MUST validate against the manifest schema below.
- If `manifest.icon` is set, the referenced path MUST exist inside the archive.
- Any other file is treated as an asset and recorded as an asset reference
  (path, size, guessed content-type).

A malformed archive is rejected with a clear `PackageError`.

## `manifest.json` fields

The **core fields are identical** to the in-app plugin manifest, so a package
that the registry accepts is also loadable by the app's plugin host. The
registry adds a few **optional presentation fields** (marked *marketplace*)
needed for discovery — these are an additive superset, not a divergent schema.

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | `<namespace>.<name>`, lowercase; regex `^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$`. This is the registry identity. |
| `name` | string | yes | Non-empty. Human name (as in the app manifest). |
| `version` | string | yes | Strict semver `MAJOR.MINOR.PATCH` (no pre-release/build). |
| `publisher` | string | yes | Non-empty publisher id. |
| `engines` | object | yes | Non-empty `{host: range}`; host-API compat lives here, e.g. `{"navide": "^0.1.0"}`. |
| `entry` | string | no | Plugin entry file. |
| `contributes` | object | no | `{ "views": [{id,title}], "commands": [{id,title}] }`. |
| `requires` | string[] | no | Capabilities; each must be one of `fs, git, terminal, search, chat, ui`. |
| `activationEvents` | string[] | no | Each matches `onStartup` \| `onView:<id>` \| `onCommand:<id>`. |
| `displayName` | string | no | *marketplace* — falls back to `name` when absent. |
| `description` | string | no | *marketplace* — used by search. |
| `categories` | string[] | no | *marketplace* — used by search/filter. |
| `icon` | string | no | *marketplace* — archive-relative path to an icon asset. |

## Signing

A package MAY carry a detached `signature` (see the registry data model's
`ExtensionVersion.signature` and the `SignatureVerifier` seam in
`registry/signing.py`). Full verification is deferred to the `p3-security`
todo; the current slice records the field and always accepts.
