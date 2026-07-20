# Navide Marketplace Registry

Self-hosted plugin marketplace registry for the Navide / Agent-Team project.
Standalone FastAPI service, managed with [uv]. It does **not** touch the
Electron app or `backend/agent_team_backend/` — it is purely additive under
`marketplace/`.

See [`FORMAT.md`](./FORMAT.md) for the `.vsix`-style package format.

## Run locally

```bash
# From the repo root; creates marketplace/registry/.venv on first run.
uv --project marketplace/registry run \
  uvicorn registry.app:app --reload --port 8787
```

Data (SQLite DB + package blobs) lands in `./.registry-data` by default;
override with `REGISTRY_DATA_DIR=/some/path`.

Health check: `curl http://localhost:8787/api/health` → `{"status":"ok"}`.

## Run tests

```bash
uv --project marketplace/registry run pytest marketplace/registry/tests
```

## HTTP API

| Method | Path | Behavior |
|---|---|---|
| GET | `/api/health` | Liveness probe. |
| POST | `/api/publish` | Upload a `.vsix` package (multipart field `package`); validate manifest, store blob + assets, append a version. 409 on duplicate version. |
| GET | `/api/extensions` | Search (`q`) over name/description/categories, newest first, paginated (`offset`, `limit`). |
| GET | `/api/extensions/{namespace}/{name}` | Extension detail + full version list + publisher. |
| GET | `/api/extensions/{namespace}/{name}/{version}/download` | Stream the package blob. |
| POST | `/api/extensions/{namespace}/{name}/{version}/yank` | Soft-yank a version (excluded from latest resolution, still downloadable by exact version). |

## Seams left for later Phase 3 todos

- **Publisher auth** (`p3-publish`): `registry/auth.py` — `get_publisher_identity`
  is an injectable stub reading `X-Publisher`. Replace with real tokens/OAuth.
- **Signature verification** (`p3-security`): `registry/signing.py` —
  `SignatureVerifier` protocol; `AcceptingSignatureVerifier` accepts all. The
  signature is stored on `ExtensionVersion.signature`.
- **CDN storage** (real storage): `registry/storage.py` — `StorageBackend`
  protocol; only `LocalStorageBackend` is implemented. Drop in S3/CDN behind
  the same protocol.

[uv]: https://docs.astral.sh/uv/
