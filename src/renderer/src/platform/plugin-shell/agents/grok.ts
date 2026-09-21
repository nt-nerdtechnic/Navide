/** Grok CLI — per-vendor agent spec (see types.ts; assembled by index.ts). */

import type { AgentSpec } from './types'

export const SPEC = {
  agentKey: 'grok',
  label: 'Grok Build (SpaceXAI)',
  defaultCommand: 'grok',
  // `reasoning_effort` exists only in grok's API payload, not as a flag.
  modelArgs: (m) => `--model ${m}`,
  // no skipPermissionFlag: this CLI does have `--always-approve` and
  // `--permission-mode` (verified in `grok --help`, 1.0.30), but wiring either
  // one in is a change to how panes run, not part of reading its logs — so the
  // permission surface stays unwired until that is decided on its own.
  // `--sandbox` / `--no-sandbox` pre-answer the per-workspace host-vs-sandbox
  // question (stored in ~/.grok/workspace-trust.json); a sandbox choice, not a
  // permission bypass.
  // `-r` resumes; `-s`/`--session-id` NAMES A NEW session and errors on an
  // existing id, so the two are not interchangeable. Ids are UUIDv7.
  resumeArgs: (id) => `-r ${id}`,
  // No turnEndInferredFromSilence: the official CLI writes an explicit
  // `turn_completed` record into updates.jsonl and the reader emits its
  // turn_complete straight off it. The community grok-cli this replaced wrote
  // no such record, which is why the flag used to be set here.
  needsSessionMarker: true,
  bracketedPaste: true,
  resumeCommandPattern: /^grok\s+-r\s+\S+/,
  supportsRebuild: true,
  hint: 'generalist',
  // Quota failover: grok.py reports one "Monthly credits" window.
  quotaSemantics: { hard: ['monthly'], required: ['monthly'] },
} as const satisfies AgentSpec
