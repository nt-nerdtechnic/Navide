<!-- provisioned by Navide, spec-version: 1 -->
# Plan Document Spec (v1)

Rules for agent-authored plan documents. Navide is the browser; this file is
the contract. Read once, then copy `_template.html` to start a plan.

## Directory & naming

- Location: `.agent-team/plans/`
- Filename: `<kebab-slug>_<6-hex>.html` (e.g. `cli-health-removal_a1b2c3.html`)
- Files starting with `_` are infrastructure (spec, template) — viewers must
  not list them as plans.
- Legacy `.cursor/plans/*.plan.md` remain readable but frozen: never create
  new ones.

## The one hard rule: the `plan-meta` block

Every plan HTML must contain exactly one machine-readable JSON island:

```html
<script type="application/json" id="plan-meta">
{
  "schemaVersion": 1,
  "name": "Human Readable Title",
  "overview": "One-sentence purpose.",
  "stage": "in-review",
  "approvedAt": null,
  "todos": [
    { "id": "phase-a", "content": "What this phase delivers", "status": "pending" }
  ],
  "reviewNotes": [
    { "id": "n1", "author": "user", "text": "…", "resolved": false, "reply": "" }
  ]
}
</script>
```

Field rules:

- `schemaVersion`: literal `1`.
- `stage`: `draft | in-review | approved | in-progress | done | abandoned`.
- `approvedAt`: ISO-8601 string, set when stage becomes `approved`; else `null`.
- `todos[].status`: `pending | in-progress | done | skipped`. No other values.
- `todos[].id`: stable kebab-case; never renumber existing ids.
- `reviewNotes[].author`: `user` or `ai`. `resolved` flips to `true` only after
  the note is addressed; put the response in `reply`.
- A file without a valid `plan-meta` block still opens in preview but is
  listed as a plain doc (no progress tracking).

## Lifecycle & approval gate

`draft → in-review → approved → in-progress → done` (or `abandoned`).

- Agents implement code **only when stage is `approved`** (or later). A spoken
  "開始" from the user means: set stage to `approved` + `approvedAt`, then start.
- Approve only when every review note is `resolved: true`.
- On completion set stage to `done`.

## Update discipline (token + safety)

- To change status, stage, or notes: **edit the `plan-meta` block and the
  matching visible markup only.** Never rewrite the whole file. Locate the
  block with a text search instead of reading the whole file.
- Keep visible markup in sync with meta: the stage badge (`class="pill <stage>"`)
  and each todo's `data-status` / pill must mirror the JSON.
- The `plan-meta` block is authoritative. App-side writes (approve, review
  notes) touch only the block, so in-document markup may briefly lag; agents
  re-sync the visible markup on their next edit.

## Document rules

- Self-contained: no external scripts, styles, fonts, or images (preview runs
  in a CSP sandbox). No executable JavaScript — presentation only; the JSON
  island is data, not code.
- Theme-aware: keep the template's CSS token structure
  (`prefers-color-scheme` + `:root[data-theme=…]` overrides).
- Wide content (tables, code, diagrams) sits in its own `overflow-x: auto`
  container.
- Standard sections, in order: header (name / overview / stage badge), Goals,
  Phases (with todos), Risks, Validation, Review Notes.
- Content language follows the user's working language (currently 繁體中文);
  code identifiers, paths, and commands stay in their original form.

## External snapshots (e.g. claude.ai artifacts)

The in-repo file is always the single source of truth. Never publish plans
to an external sharing surface by default. Exception — explicit share request
from the user: publish the same file unchanged as a snapshot (the `plan-meta`
JSON island is invisible in any browser), and note in the snapshot that the
canonical copy lives in `.agent-team/plans/`. Never edit the external copy
directly.

## Size guidance

Aim for 300–600 lines. If a plan outgrows that, split it into multiple plans
rather than growing one file.
