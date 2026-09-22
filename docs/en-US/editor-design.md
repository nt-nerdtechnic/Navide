# Editor Architecture

Navide's editor is a Monaco-based workspace surface for inspecting and accepting agent work. Earlier versions used a custom DOM editor; those notes are historical and no longer describe the current implementation.

## Responsibilities

- Open workspace files in the main application or a dedicated editor window
- Provide Monaco text editing, language services, diagnostics, and worker setup
- Render Markdown and plan files with plan-aware presentation
- Show working-tree, branch, and proposed diffs
- Surface merge conflicts and support review-oriented resolution
- Integrate AI rewrite, completion, and chat workflows through backend services
- Preserve window and pane routing when editor views move between application windows

## Major components

| Component | Responsibility |
|---|---|
| `EditorPane.vue` | File lifecycle, editor state, saves, and editor-level actions |
| `EditorViewMonaco.vue` | Monaco instance, model binding, language setup, and view behavior |
| `monacoWorkers.ts` | Monaco worker configuration |
| `diagnostics.ts` | Problem and diagnostic normalization |
| `PlanFileView.vue` | Plan-oriented Markdown rendering |
| `DiffPane.vue` | Working-tree and file diff presentation |
| `BranchDiffPane.vue` | Branch-level comparison |
| `ConflictPane.vue` | Merge-conflict inspection and resolution workflow |
| `PlansPane.vue` | Plan discovery and navigation |
| `EditorWindowApp.vue` | Standalone editor-window shell and routing |

## Shared editor composition

`@navide/plugin-ui/editor` exports `EditorPane`, `EditorPort`, its request/result
types, and `createPreflightEditorPort`. The public UI package owns the Monaco
view, language detection, text transforms, and editor commands. Consumers supply
file reads/writes (including encoding and optimistic save-conflict metadata),
image reads, AI operations, connection state, file-change subscriptions, and
diagnostic lookup through `EditorPort`. Coordinates passed to that port are
data, not authority; adapters must use their authenticated Host boundary.

The Host editor window constructs `createHostEditorPort`. Host diagnostics
stores, tabs, workspace identity, and session state stay outside the public UI
package. The legacy miniIDE recovery build uses that same composition through
its retained capability adapter until the v2 package cutover. Restricted
preflight uses `createPreflightEditorPort`, which denies all file and AI effects
without constructing a production transport.

The `monaco-editor` peer is required by the editor subpath. Import
`@navide/plugin-ui/styles.css` and install the existing foundation i18n instance
in a packaged consumer. Rich previews, Explorer/Search and window composition
remain separate consumer-owned migration surfaces; extracting the core editor
does not remove their recovery behavior.

## Backend boundary

File reads and writes, workspace checks, AI editing requests, and related operations cross Navide's backend or preload boundaries. The renderer must not gain unrestricted filesystem access merely because Monaco runs in the renderer.

Place standalone interface prototypes in `.agent-team/mockups/`. The Explorer can list this directory, and the editor can read its files and preview HTML with relative CSS and images stored in the same directory tree. These files remain protected from backend filesystem mutations, including writes, creation, renames, and deletion; agents can author them through their normal workspace tools. The existing access rules for `.agent-team/plans/` and `.agent-team/reports/` remain unchanged.

HTML previews retain the existing sandbox with scripts disabled. Reading a prototype in the editor does not enable its JavaScript interactions; use **Open externally** to review those in a browser. Relative resources remain subject to workspace and protected-directory checks.

## Product role

The editor is Navide's precision Intervention surface. It exists for navigation, inspection, direct modification, refactoring, diagnostics, debugging context, diff review, plan execution, and acceptance when human judgment or exact control adds value.

Navide intends to replace the traditional IDE as the engineer's primary environment. That requires complete professional editing and code-intelligence capability, but not an uncritical copy of every inherited IDE interaction. New editor work should strengthen the loop between coordinated agent execution, shared engineering evidence, and precise human intervention.

## Known limits

- Very large files and very large diffs require explicit performance testing.
- Language intelligence depends on Monaco's available services and project configuration.
- Agent-proposed edits remain untrusted until reviewed and verified.
- Moving editor panes across windows must preserve file identity, unsaved-state behavior, and routing ownership.
