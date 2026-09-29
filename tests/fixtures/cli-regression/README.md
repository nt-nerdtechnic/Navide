# CLI regression fixtures

These fixtures describe Navide's supported integration contracts. They are
hand-authored synthetic data, not recordings from a live provider. Each JSON
file names the source test schema and repository revision used to construct
it. No provider credentials, account state, or generated private conversation
is required.

`catalog.json` is shared by the frontend and backend. Its `vendors` keys must
equal the production vendor registry. Backend capabilities are derived from
`VendorSpec`; every capability names an actual collected test. A skipped,
expected-failing, or unexecuted selected case cannot satisfy the backend gate.
Only Claude's POSIX shutdown case has a platform exemption. Core vendor
contracts run on all three supported operating systems.

## Fixture phases

`initial`, `response`, and `complete` contain literal external store writes.
`VendorData` materializes them in an isolated home and workspace. JSONL,
Markdown, sidecar JSON, protobuf bytes, and SQLite rows retain each vendor's
real reader format. SQLite connections remain open in WAL mode. Expected
reply text and token totals are independent literal assertions.

The reader contract runs the real registered reader through `LogWatcher`,
attribution, application sinks, token persistence, and project session
persistence. Between response and completion it reconstructs the reader and
token store from durable checkpoints. A second reconstruction must not replay
delivered activity or usage. Examples intentionally include a late Copilot
turn marker, an OpenCode/Kilo pending-message update followed by a step-finish
part, Cursor blob/protobuf records, and Antigravity status updates.

The launch contract executes an inert local program named for each CLI through
the real backend WebSocket and process path. It checks environment handling
and dispatch without contacting a provider. Separate transport cases exercise
Claude's authenticated hook rewake, Qwen's input file, OpenCode/Kilo HTTP
delivery, vendor interrupt bytes, and login handling. Existing focused parser
and historical tests retain more detailed malformed, partial, rewrite, and
recovery scenarios without duplicating shared PTY machinery for every CLI.

## Boundaries

These tests establish compatibility with the documented fixture formats and
Navide's current integration logic. They do not establish that an installed
vendor's latest version still emits those formats, that account login works,
or that a real provider is available. Live CLI/provider smoke tests remain
manual. MCode has a launch contract and an explicit unsupported-resume
contract; it does not acquire a transcript reader or resumability by being in
this inventory.
