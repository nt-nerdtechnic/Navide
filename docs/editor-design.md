# AI Native Editor — Design Notes

A minimalist code editor built from scratch (no Monaco / CodeMirror), tuned for
AI-native workflows: agent-proposed edits as inline diffs, ghost-text
completions, and Cmd+K selection rewriting. Strictly isolated under
`src/renderer/src/editor/`.

## Core concepts (borrowed from Monaco, simplified)

- **TextModel** — the document is a `lines[]` array. Edits are expressed as
  `EditOperation { range, text }` (replace a range with text). `applyEdit`
  returns the *inverse* edit so undo is just "apply the inverse".
- **UndoStack** — push inverse edits; group rapid edits (typing) into one undo
  unit by time/coalescing. Redo replays the forward edits.
- **Rendering** — DOM-based with **virtual scrolling**: only the visible line
  window is in the DOM. A monospace metric gives constant line height.
- **Input** — a single hidden `<textarea>` positioned at the caret captures
  keyboard, IME composition, and clipboard. We never rely on `contenteditable`.
- **Tokenizer** — a stateful, regex-based "Monarch-lite" tokenizer. Each line is
  tokenized given the previous line's end state (so block comments / template
  strings survive line breaks). Tokens map to `--syntax-*` CSS variables from
  the theme system.
- **Decorations** — overlay ranges (AI diff add/del, ghost text, highlights)
  rendered on top of the text layer without mutating the model.

## AI integration

- **Propose edits** (`AiHunk[]`): rendered as inline red/green diff with per-hunk
  accept/reject. Accept applies the hunk via `applyEdit`.
- **Ghost text**: a `ghost` decoration after the caret; Tab accepts.
- **Cmd+K**: rewrite the current selection via an instruction; the result comes
  back as an `AiHunk` over the selection.
- Transport reuses the existing `useBackend` WebSocket (`editor.*` messages),
  which proxy to the configured local LLM (analyzer Ollama / llama.cpp).

## Isolation & limits

- All new code under `editor/`; host touches are additive (an `EditorPane`
  window + a GitPane entry point + an `fs.write_file` save path).
- `lines[]` is O(n) for some ops — fine for typical source files; very large
  files are out of scope (documented limit).
