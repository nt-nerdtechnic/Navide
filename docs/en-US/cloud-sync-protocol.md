# Cloud sync protocol (v1)

The wire contract between the Navide desktop backend (client) and
Navide-Server (server) for syncing the four Settings → INTEGRATIONS sections
across a user's devices. Both sides implement this file; neither invents
fields on its own.

Approved plan: `.agent-team/plans/cloud-sync-integrations_4d8e63.html`.

## Shape

Sync rides the existing control-plane link (`server_link.py` →
`wss://server.navide.dev/ws`). It adds message types, not a connection, so it
opens no new inbound surface. The envelope is the one already in use:

```
request   {id, type, payload}
response  {id, type: "<type>.result", ok, payload|error}
event     {type, payload, timestamp}      server push, no id
```

## Model

One **item** is one logical row in one **scope**. Scopes are exactly:

| scope | carries |
|---|---|
| `prompts` | prompt-skill records |
| `mcp` | Navide-owned MCP server records (never the native reflection) |
| `skills` | skill enable/route state (content is Phase 4, not v1) |
| `memory` | user-scope instruction-file records (never project scope) |
| `credentials` | portable CLI credentials the user pasted in Settings → Accounts (see below) |

The `credentials` scope is, to the server, indistinguishable from the other
four: same tables, same handlers, same ciphertext-only `body`. What differs is
on the client (`sync_scopes.CredentialsScope`, flagged `sensitive`):

- `itemId` is `c-` plus 32 random hex characters, minted when a credential is
  first pasted and carried unchanged by every device that imports it. It is
  never derived from the vendor or slot — the server's rows say nothing about
  which CLIs an account uses — and it does not change when the account key is
  rotated.
- The body is `{"v": 1, "agentKey", "slotId", "value"}` and nothing else, so
  two devices that pasted the same token agree it is the same item.
- **A client never pushes a tombstone by absence** for this scope. A credential
  missing from a device's snapshot means "not set up here" or "removed here";
  neither is a reason to sign every other device out. There is no cloud-delete
  action in v1; removal is local. A device that removed a credential keeps a
  secret-free *disabled* mark so a later pull does not quietly bring it back —
  an explicit `pull_items` naming the item is what does.
- A record that will not open fails the round rather than being skipped, so
  the cursor never steps past a secret this device did not receive. A body
  sealed under a key the device does not hold yet (`UnknownKeyId`) holds the
  cursor at that row until a paired device hands over the newer ring.
- Conflict rows are stored sealed and listed as `{agentKey, slotId}` only; the
  inventory carries the same two fields as `meta` on each side.

An item is `{itemId, rev, updatedAt, deviceId, deleted, body, sig}`:

- `itemId` — stable within the scope, `^[A-Za-z0-9._:@+-]{1,200}$`.
- `rev` — assigned by the server, monotonic per `(account, scope)`. It doubles
  as the pull cursor. Clients never invent one.
- `updatedAt` — the writing device's ISO-8601 clock. Informational only:
  ordering is `rev`, never a wall clock, because device clocks disagree.
- `deviceId` — origin device. The server rejects a push whose `deviceId` is not
  the connection's own device, so origin cannot be forged.
- `deleted` — `0|1`. Deletes are tombstones so they propagate; `body` is null.
  (The `credentials` client never emits one by absence — see the scope notes
  above.)
- `body` — base64 of the **ciphertext**. The server stores it opaquely and has
  no key. Everything readable lives inside it.
- `sig` — the origin device's signature over the item, checked by receiving
  devices, not by the server.

## Requests

### `sync.pull`

```
payload   {scope, since?: number = 0, limit?: number = 200}   limit ≤ 500
result    {scope, cursor, items: [...], more: boolean}
```

Returns items with `rev > since`, ascending, tombstones included. `cursor` is
the account's current max `rev` for the scope; `more` says another page waits.

### `sync.push`

```
payload   {scope, items: [{itemId, baseRev, updatedAt, deleted?, body?, sig}]}
result    {scope, cursor, accepted: [{itemId, rev}], conflicts: [<item>]}
```

A pushed item carries no `deviceId`: the server stamps the connection's own
device on every row it writes. One may be sent, and then it must equal the
connection's device — a client may state its origin but never claim another's.

`baseRev` is the `rev` the pushing device last saw for that item, `0` for one
it believes is new. Per item:

- `baseRev === current rev` → write, assign the next `rev`, list in `accepted`.
- otherwise → **write nothing**, return the server's current row in
  `conflicts`.

Conflicts are per item, so one conflict never blocks the rest of the batch.
The server does not merge and does not pick a winner — that is decision ① of
the approved plan: both sides are kept and the user chooses in the UI.

A **malformed** batch is refused whole (`BAD_REQUEST`), because that is a
caller bug rather than a race; a duplicate `itemId` inside one batch counts as
malformed, since the second copy would be compared against the `rev` the first
one just created and conflict with itself.

`baseRev > 0` for a row the server does not have means the item was deleted
elsewhere while this device thought it held it. The conflict entry is then
`{itemId, rev: 0, updatedAt: null, deviceId: null, deleted: 1, body: null,
sig: null}` — `rev: 0` says "never existed here", since server revs start at 1.
A client keeping its local copy pushes from `baseRev: 0` and re-creates it.

## Event

```
sync.changed   {scope, cursor}
```

Pushed to every **other** device of the account after an accepted write. The
pusher is not notified of its own write.

## Limits

| limit | value |
|---|---|
| items per push | 64 |
| `body` per item | 512 KiB |
| push payload total | 768 KiB |
| pull page | 500 items |

These are **frame** limits wearing item clothing. A push is one WebSocket
message and the server's `maxPayload` is 1 MiB, so anything larger never
reaches a handler at all: the socket closes with 1009 and the request never
resolves. The first version of this table said 1 MiB per body and 4 MiB per
push, neither of which could ever arrive — the checks for them were dead code
on both ends. The numbers above sit under the frame cap with room for the
envelope, and both are measured on the base64 `body` **as stored**, never on
its decoded length, because invariant 2 forbids decoding it.

Over-limit is `BAD_REQUEST`. Error codes reuse the existing set:
`BAD_REQUEST`, `AUTH_REQUIRED`, `FORBIDDEN`.

## Invariants the server must keep

1. Every statement carries the account from `accountOf(ctx)`. There is no other
   source of the scope key, so a forgotten condition is a missing parameter at
   compile time rather than a silent cross-account read.
2. `body` is never parsed, logged, or indexed. The server has no key and must
   not grow one.
3. A pushed item's `deviceId` must equal `ctx.deviceId`.
4. `account-isolation.mjs` covers cross-account isolation *and* invariant 3: a
   push naming another device's id is refused.
5. `rev` is strictly increasing per `(account, scope)`. It must come from a
   locked counter row, not from `MAX(rev) + 1`: under Postgres' default READ
   COMMITTED two concurrent pushes can read the same maximum, and a cursor that
   has passed one of two rows sharing a rev can never return the other.
6. Reading an item's current `rev` and writing over it is **one atomic step**.
   Two devices pushing the same `itemId` from the same `baseRev` must end as
   one `accepted` and one `conflicts` — never two `accepted`. Comparing first
   and writing afterwards leaves a window where both pass the comparison and
   the later write silently replaces the earlier one, which is the exact
   outcome decision ① of the plan exists to prevent: the client shows no
   conflict, because the server said both were fine. Taking the scope's
   counter-row lock at the start of the push is what closes it.

## Not in v1

Skill **content** (`SKILL.md` trees and attachments) needs a blob layer —
`sync.blob.put` / `sync.blob.get`, content-addressed. That is Phase 4 of the
plan and is specified when it is built. v1 carries records only.
