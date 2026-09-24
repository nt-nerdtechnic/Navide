# Navide Marketplace Registry

Self-hosted plugin marketplace registry for the Navide / Agent-Team project.
Standalone FastAPI service, managed with [uv]. It does **not** touch the
Electron app or `backend/agent_team_backend/` — it is purely additive under
`marketplace/`.

See [`FORMAT.md`](./FORMAT.md) for the `.vsix`-style package format.

> **Deployment status.** The Official Registry is planned at
> `https://server.navide.dev/registry` (a path prefix on the Navide server
> host); packaged App builds point there by default. See
> [Deployment](#deployment-official-registry-at-servernavidedevregistry) for
> the container, secrets and operational requirements. Known limits before
> wider use: no schema migration mechanism (`db.py` only calls
> `SQLModel.metadata.create_all`, which will not add columns to existing
> tables), package blobs live on the local data volume
> (`LocalStorageBackend`), and one version of a package can carry only one
> target (see [Publishing first-party plugins](#publishing-first-party-plugins)).
> Third-party publishing is not open — see
> [the plugin development guide](../../docs/en-US/plugin-development.md).

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
| GET | `/api/extensions/{namespace}/{name}` | Extension detail + full version list, registry envelopes/signatures, and root-signed trust metadata. |
| GET | `/api/extensions/{namespace}/{name}/{version}/download` | Stream the package blob **and increment** the per-version + aggregate download counters. |
| POST | `/api/extensions/{namespace}/{name}/{version}/yank` | Soft-yank a version (excluded from latest resolution, still downloadable by exact version). |
| POST | `/api/extensions/{namespace}/{name}/rating` | Add a `{ "score": 1..5 }` rating; returns the new average + count. Per-user auth/dedup is deferred (see below). |
| POST | `/api/extensions/{namespace}/{name}/featured` | Set the curation flag `{ "featured": bool }`. Admin-gated by `X-Admin-Token` (same gate as `/api/publishers`). |

`GET /api/extensions` also accepts `category` (exact category filter) and
`sort` (`updated` default, `downloads`, `rating`). Each summary now carries
`download_count`, `rating_average`, `rating_count`, `featured`; each version
carries `download_count`.

## Discovery website (p3-discovery)

A dependency-light, server-rendered marketplace site is mounted on the **same**
FastAPI app (Jinja2 templates + self-hosted CSS in `registry/web_templates/`
and `registry/web_static/`; no JS build, no CDN assets). The `/api/*` JSON API
is untouched.

| Method | Path | Renders |
|---|---|---|
| GET | `/` | Home: Featured section, browse grid, keyword search, category filter, sort (downloads/rating/updated). Cards show displayName, publisher, description, categories, downloads, rating, trust badge, sensitive-capability warning. |
| GET | `/extensions/{namespace}/{name}` | Detail: rendered README, screenshots, rating, downloads, per-version trust tier + declared capabilities, install hint, publisher. |
| GET | `/extensions/{namespace}/{name}/{version}/assets/{path}` | Serve an image/asset extracted from the package blob (allow-listed against the version's recorded assets). |
| — | `/static/*` | Self-hosted CSS. |

**README rendering + sanitization.** READMEs are extracted from the stored
`.vsix` blob and rendered with `markdown-it-py` configured with raw HTML
**disabled** (`MarkdownIt("commonmark", {"html": False})`). Any `<script>` /
`<img onerror=…>` in a README is escaped to inert text, and dangerous link
schemes (`javascript:` etc.) are dropped by the built-in link validator, so no
user-authored active markup is ever emitted (`tests/test_web.py`).

**Ratings limitation.** Ratings are stored as `rating_sum` + `rating_count`
(average is derived); the submit endpoint has **no per-user auth or dedup** —
this is a deliberate p3-discovery simplification. Real per-user rating auth is
deferred.

## Security model (p3-security + p3-publish)

**Signing.** Publisher Ed25519 signatures authenticate strict-mode submissions,
but publisher keys are not part of the Client trust contract. After validating
the publisher, namespace, manifest, and complete archive, the registry signs a
canonical JSON envelope binding the archive digest, package/version/target,
publisher, signer `keyId`, and signing time. Extension detail responses include
that envelope/signature and current signer/blocklist metadata signed by the
registry root. A Client accepts this metadata only after verifying it with an
App- or user-pinned root; `rootFingerprint` in a response is informational and
MUST NOT establish trust.

The default `self-hosted-dev` profile creates persistent owner-only keys and a
persistent signer lifecycle under `REGISTRY_DATA_DIR/trust/`. Its signed metadata
is explicitly labelled `self-hosted-dev` and carries the generated root
fingerprint so an operator can approve that root out of band. It never claims
Official Registry provenance. The `official` profile never generates trust
material: startup requires an explicit deployment config whose expected root
fingerprint must match the configured root key and the root pinned into the App
build. Registry root and signer private-key files must be regular, non-symlink
files with owner-only permissions; generated files are created as `0600`.

**Publisher auth + namespace entitlement.** Publish/yank require an
`Authorization: Bearer <token>` header; the token is matched (sha256) against
`Publisher.token_hash`. A publisher may only publish/yank under **its own
namespace** — the `namespace` half of the manifest `id` must equal the
authenticated publisher (else `403`).

**Trust tier (`registry/trust.py`).** Accepted versions are `signed-verified`
after the registry signature is created. Permissive dev mode may accept a
submission without a publisher signature, but it still centrally signs the
accepted artifact before exposing it to clients.

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
| `REGISTRY_ADMIN_TOKEN` | _(unset)_ | Gates `POST /api/publishers` when set; required and non-empty for the `official` profile. |
| `REGISTRY_TRUST_PROFILE` | `self-hosted-dev` | `self-hosted-dev` for persistent locally generated trust material, or `official` for explicitly provisioned production material. |
| `REGISTRY_TRUST_CONFIG_FILE` | _(unset)_ | Required with `official`; path to the complete signer, root, rotation, validity, and blocklist policy below. Rejected for the default profile. |
| `REGISTRY_ROOT_PATH` | _(unset)_ | Public path prefix when served behind a reverse proxy, e.g. `/registry`. Requests are accepted with the prefix forwarded unchanged (AWS ALB) or stripped by the proxy, and every link the website emits carries it. `/registry-evil/...` is not served. Do not combine with `uvicorn --root-path`. |

### Official Registry trust deployment

Set `REGISTRY_TRUST_PROFILE=official` and point
`REGISTRY_TRUST_CONFIG_FILE` at a deployment-owned JSON file:

```json
{
  "schemaVersion": 1,
  "profile": "official",
  "expectedRootFingerprint": "sha256:<App-build-pinned-SPKI-digest>",
  "rootPrivateKeyFile": "/run/navide-keys/navide-registry-root.pem",
  "signer": {
    "keyId": "registry-2026-02",
    "privateKeyFile": "/run/navide-keys/navide-registry-signer.pem",
    "status": "active",
    "notBefore": "2026-08-01T00:00:00Z",
    "notAfter": "2027-08-01T00:00:00Z"
  },
  "trustedSigners": [
    {
      "keyId": "registry-2026-01",
      "publicKeyFile": "/etc/navide/trust/registry-2026-01.pub",
      "status": "rotating",
      "notBefore": "2025-08-01T00:00:00Z",
      "notAfter": "2026-09-01T00:00:00Z"
    }
  ],
  "blockedPublishers": ["compromised-publisher"],
  "blockedPackages": ["compromised.package", "acme.demo@1.2.3"]
}
```

All fields are required and unknown or duplicate JSON keys fail startup. The
current signer signs newly accepted artifacts. `trustedSigners` publishes prior
or staged public keys for rotation without granting them access to current
private signing material. Status is root-signed policy: `active` and
time-bounded `rotating` signers can validate artifacts, `expired` signers cannot
create new envelopes, and `revoked` signers fail closed. Package and publisher
blocklists are part of the same root-signed metadata. Changing the official
root requires a matching App build pin (or an authorization chain rooted in the
previous key); a Registry response cannot introduce its own replacement root.

The official profile also rejects verifier, signature, or publisher-auth
downgrades at startup and requires `REGISTRY_ADMIN_TOKEN`; those controls remain
configurable for `self-hosted-dev`.

`rootPrivateKeyFile` is needed by this current implementation to refresh trust
metadata. Production deployment must provide it as protected secret material;
moving root signing to an offline/HSM-backed publisher can replace this file
seam later without changing the Client wire contract.

## Packaging CLI (`navide-plugin`)

Console entry point (see `registry/cli.py`):

```bash
navide-plugin keygen  --out-dir . --name acme        # Ed25519 keypair -> acme.key/acme.pub
navide-plugin pack    ./plugin-src --out my.vsix      # build + validate a .vsix
navide-plugin sign    my.vsix --key acme.key --out my.sig
navide-plugin publish my.vsix --registry http://localhost:8787 \
  --token <bearer> --signature my.sig [--target darwin-arm64]
```

`keygen` writes the private key owner-only (`0600`). `publish` reads the token
from `NAVIDE_PLUGIN_TOKEN` when `--token` is omitted, and `--target` (default
`universal`) selects the Registry target bound into the signed envelope; a
package with a native backend must be published for its exact
`<platform>-<arch>` target.

`pack` reuses the format builder in `registry/package.py`; `sign` reuses the
Ed25519 primitives in `registry/signing.py`.

## Deployment (Official Registry at server.navide.dev/registry)

The Registry runs as one container behind the load balancer that already
serves `wss://server.navide.dev/ws`, routed by the path rule `/registry/*`.
Deployment files live in `deploy/`:

| File | Purpose |
|---|---|
| `Dockerfile` | uv-built image, non-root user (uid 10001), data volume `/data`, health check on `/api/health`. Build context: `marketplace/registry`. |
| `deploy/entrypoint.sh` | Copies the key secrets into an owner-only directory, reads the admin token from a file, starts uvicorn. |
| `deploy/compose.example.yml` | Example Compose service: env, secrets, tmpfs key directory, data volume. |
| `deploy/official-trust.example.json` | Official trust config template (paths and the pinned root fingerprint; no secrets). |

**Path prefix.** Set `REGISTRY_ROOT_PATH=/registry`. An AWS ALB forwards the
path unchanged, which the app accepts; a proxy that strips the prefix works
too. The load balancer health check is `GET /registry/api/health`.

**Secrets.** The root and signer private keys must reach the process as
regular, non-symlink, owner-only (`0600`) files; the Registry refuses to start
otherwise. Docker/Swarm secrets are mounted `0444` (Compose file secrets keep
the host file's owner and mode), so `deploy/entrypoint.sh` copies
`/run/secrets/navide-registry-root.pem` and
`/run/secrets/navide-registry-signer.pem` into `/run/navide-keys/` (a tmpfs
owned by the container user) as `0600`, and the trust config points at those
copies. With Compose file secrets, make the host files readable by uid 10001
(`chown 10001:10001 <file>; chmod 0400 <file>`). Never bake keys into the
image. The container needs:

- `REGISTRY_TRUST_PROFILE=official`
- `REGISTRY_TRUST_CONFIG_FILE` pointing at the trust config (non-secret; mount
  it read-only). Its `expectedRootFingerprint` must equal the root pinned in
  the App build, `resources/official-registry-root.pem`
  (`sha256:89dd424a…a35367`); startup fails on a mismatch.
- `REGISTRY_ADMIN_TOKEN`, or `REGISTRY_ADMIN_TOKEN_FILE` naming a secret file
  (read by the entrypoint). It gates `POST /api/publishers` and
  `/featured`; generate it randomly and keep it out of shell history.

**Data volume and backup.** `/data` holds the SQLite index (`registry.db`) and
every package blob (`packages/`). Use a named volume or host directory, back
it up (stop-the-world copy or `sqlite3 registry.db ".backup …"` plus the
`packages/` tree), and run a single worker: SQLite is the only index.

**Availability.** Root-signed trust metadata expires 24 hours after it is
generated (a fresh copy per request). Each App revalidates installed Registry
plugins against the copy from its last successful refresh; once that copy is
older than 24 hours, for example during a Registry outage longer than a day,
installed Registry plugins are quarantined until the Registry answers again. Put
uptime monitoring and alerting on `https://server.navide.dev/registry/api/health`.

### Publishing first-party plugins

One-off admin step: register the `navide` publisher with its public key and a
bearer token (the token is stored hashed; keep the plaintext for publishing):

```bash
python3 - <<'PY'
import json, os, pathlib, urllib.request
body = {
    "name": "navide",
    "display_name": "Navide",
    "public_key": pathlib.Path(os.path.expanduser(
        "~/navide-signing/plugin_publisher.pub.pem")).read_text(),
    "token": os.environ["NAVIDE_PLUGIN_TOKEN"],
}
req = urllib.request.Request(
    "https://server.navide.dev/registry/api/publishers",
    data=json.dumps(body).encode(), method="POST",
    headers={"Content-Type": "application/json",
             "X-Admin-Token": os.environ["REGISTRY_ADMIN_TOKEN"]})
print(urllib.request.urlopen(req).read().decode())
PY
```

Then, from the repository root:

```bash
NAVIDE_REGISTRY_URL=https://server.navide.dev/registry \
NAVIDE_PUBLISHER_KEY=~/navide-signing/plugin_publisher.key \
NAVIDE_PLUGIN_TOKEN=<navide publisher token> \
scripts/publish-first-party-plugins.sh
```

The script builds, packs, signs and publishes `navide.git` as `universal` and
`navide.plans` for the host target (for example `darwin-arm64`), reusing the
`navide-plugin` CLI. `--skip-build` reuses `dist-plugins/`, `--only git|plans`
publishes one. Plans carries a PyInstaller backend, so each other target must
be built on a machine of that platform and architecture.

**Limitation:** a Registry version row is unique per package and version, and
blobs are stored per version, so a second target of the same version is
rejected with `409`. Publishing `navide.plans` for more than one target needs
the Registry to key versions and blobs by target (and the Client to select the
row matching its host target) first.

## Seams left for later Phase 3 todos

- **Discovery frontend** (`p3-discovery`): ✅ built — the server-rendered
  website above. Consumes the same repository layer as `GET /api/extensions`
  (search/category/sort) and `GET /api/extensions/{ns}/{name}`.
- **Extensions view** (`p3-lifecycle`): the in-app view install/update/remove
  drives off the version list + `download` endpoint. It needs, per version:
  `download` URL (streams the blob) and the `X-Package-Digest` response header
  for integrity verification; `latest_version` (summary/detail) resolves
  updates; and the trust fields already exposed — `trust_tier`, `capabilities`,
  `sensitive_capabilities`, `signed` — to gate/warn on install. Download counts
  and ratings are now also available for in-app display.
- **CDN storage** (real storage): `registry/storage.py` — `StorageBackend`
  protocol; only `LocalStorageBackend` is implemented. Drop in S3/CDN behind
  the same protocol.

[uv]: https://docs.astral.sh/uv/
