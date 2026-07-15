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

## Backend boundary

File reads and writes, workspace checks, AI editing requests, and related operations cross Navide's backend or preload boundaries. The renderer must not gain unrestricted filesystem access merely because Monaco runs in the renderer.

## Product role

The editor is Navide's precision Intervention surface. It exists for navigation, inspection, direct modification, refactoring, diagnostics, debugging context, diff review, plan execution, and acceptance when human judgment or exact control adds value.

Navide intends to replace the traditional IDE as the engineer's primary environment. That requires complete professional editing and code-intelligence capability, but not an uncritical copy of every inherited IDE interaction. New editor work should strengthen the loop between coordinated agent execution, shared engineering evidence, and precise human intervention.

## Known limits

- Very large files and very large diffs require explicit performance testing.
- Language intelligence depends on Monaco's available services and project configuration.
- Agent-proposed edits remain untrusted until reviewed and verified.
- Moving editor panes across windows must preserve file identity, unsaved-state behavior, and routing ownership.
