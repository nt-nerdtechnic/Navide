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
| POST | `/api/publishers` | Register/update a publisher's Ed25519 public key + bearer token. Admin-gated by `X-Admin-Token` when `REGISTRY_ADMIN_TOKEN` is set (open in dev). |
| POST | `/api/publish` | Upload a `.vsix` package (multipart field `package`); requires a `Bearer` publisher token and (in strict mode) a valid `signature`. Validates manifest, verifies signature, stores blob + assets, appends a version with a trust tier. 409 on duplicate, 403 on cross-namespace/bad-signature, 401 on bad/missing token. |
| GET | `/api/extensions` | Search (`q`) over name/description/categories, newest first, paginated (`offset`, `limit`). |
| GET | `/api/extensions/{namespace}/{name}` | Extension detail + full version list + publisher. |
| GET | `/api/extensions/{namespace}/{name}/{version}/download` | Stream the package blob. |
| POST | `/api/extensions/{namespace}/{name}/{version}/yank` | Soft-yank a version (excluded from latest resolution, still downloadable by exact version). |

## Security model (p3-security + p3-publish)

**Signing.** The registry runs its own plugin-signing chain (independent of
Apple DevID / macOS notarization). A publisher registers an **Ed25519** public
key; a package carries a detached **base64 signature over the package's sha256
digest**. At publish time the signature is verified against the publisher's key
(`registry/signing.py :: Ed25519SignatureVerifier`). The permissive
`AcceptingSignatureVerifier` is retained for dev/tests and selected via
`REGISTRY_VERIFIER=accepting`.

**Publisher auth + namespace entitlement.** Publish/yank require an
`Authorization: Bearer <token>` header; the token is matched (sha256) against
`Publisher.token_hash`. A publisher may only publish/yank under **its own
namespace** — the `namespace` half of the manifest `id` must equal the
authenticated publisher (else `403`).

**Trust tier (`registry/trust.py`).** Each version is tagged:

- `signed-verified` — a signature verified against the publisher's key.
- `unsigned` — no signature (only allowed when `REGISTRY_REQUIRE_SIGNATURE=false`).

`manifest.requires` is the declared capability allowlist; `fs` and `terminal`
are flagged as **sensitive** (filesystem/shell reach). Trust tier + capabilities
+ sensitive-capabilities are exposed per version in the extension API for the
Extensions view to warn users. This is metadata/gating only — no runtime sandbox.

### Policy config (env)

| Var | Default | Effect |
|---|---|---|
| `REGISTRY_VERIFIER` | `ed25519` | `ed25519` (real) or `accepting` (dev). |
| `REGISTRY_REQUIRE_SIGNATURE` | `true` | Reject unsigned publishes. |
| `REGISTRY_REQUIRE_AUTH` | `true` | Reject anonymous publish/yank. |
| `REGISTRY_ADMIN_TOKEN` | _(unset)_ | Gates `POST /api/publishers` when set. |

## Packaging CLI (`navide-plugin`)

Console entry point (see `registry/cli.py`):

```bash
navide-plugin keygen  --out-dir . --name acme        # Ed25519 keypair -> acme.key/acme.pub
navide-plugin pack    ./plugin-src --out my.vsix      # build + validate a .vsix
navide-plugin sign    my.vsix --key acme.key --out my.sig
navide-plugin publish my.vsix --registry http://localhost:8787 \
  --token <bearer> --signature my.sig
```

`pack` reuses the format builder in `registry/package.py`; `sign` reuses the
Ed25519 primitives in `registry/signing.py`.

## Seams left for later Phase 3 todos

- **Discovery frontend** (`p3-discovery`): consumes `GET /api/extensions`
  (search) and `GET /api/extensions/{ns}/{name}` — each version now carries
  `trust_tier`, `capabilities`, `sensitive_capabilities` for badges/warnings.
- **Extensions view** (`p3-lifecycle`): install/update/remove drives off the
  version list + `download` endpoint; `latest_version` resolves updates.
- **CDN storage** (real storage): `registry/storage.py` — `StorageBackend`
  protocol; only `LocalStorageBackend` is implemented. Drop in S3/CDN behind
  the same protocol.

[uv]: https://docs.astral.sh/uv/
