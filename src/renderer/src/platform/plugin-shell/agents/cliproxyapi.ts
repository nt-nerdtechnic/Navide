/**
 * CLIProxyAPI (router-for-me/CLIProxyAPI) — per-vendor agent spec.
 *
 * Not a coding agent: it's a background proxy that multiplexes several
 * providers' OAuth accounts (Claude, Codex, Antigravity, Kimi, xAI, Devin,
 * Meta) behind one OpenAI/Gemini/Claude-compatible endpoint, round-robining
 * across whichever accounts are loaded in its own auths directory
 * (`~/.cli-proxy-api` by default). That's one server holding many accounts
 * at once, not one identity to switch between — the shape the other vendors'
 * account-slot fields (resumeArgs, model selection, session markers) assume.
 * None of those apply here, so they're left unset; see cli_vendors/cliproxyapi.py
 * for the same reasoning on the backend side.
 *
 * `--tui` is its own interactive terminal management console (verified in
 * cmd/server/main.go: it starts an embedded standalone server and connects a
 * TUI client to it), the closest thing this binary has to an interactive
 * session — so that's the default command rather than the bare binary, which
 * instead runs the server as a plain foreground process with no interaction.
 */

import type { AgentSpec } from './types'

export const SPEC = {
  agentKey: 'cliproxyapi',
  label: 'CLIProxyAPI',
  defaultCommand: 'CLIProxyAPI --tui',
  hint: 'multi-provider proxy — not a coding agent',
} as const satisfies AgentSpec
