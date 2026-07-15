# Navide Launch Kit

## Narrative 1 — Category thesis

### Title

The IDE organized code. Navide organizes engineering work.

### Short post

AI changed the amount of execution one engineer can initiate. It did not automatically solve coordination, context, exceptions, or evidence.

Navide is an AI-native engineering environment for one engineer directing multiple coding agents. It is being built around goals, sessions, private project intelligence, human intervention, and verified outcomes—not another chat panel inside the traditional IDE.

Explore the source: https://github.com/nt-nerdtechnic/Navide

## Narrative 2 — Founder workflow

### Title

Navide builds Navide.

### Short post

I no longer use a traditional IDE as the center of daily development.

New projects begin with requirements and a configurable Pipeline. Daily work happens through multiple coordinated agent sessions. I return to the mini IDE only when inspection or precise editing adds value.

That workflow became the product thesis behind Navide: one engineer directing an AI engineering force while retaining control of purpose, risk, judgment, and final acceptance.

## Narrative 3 — Technical tour

### Title

One workspace for agents, sessions, project context, and engineering evidence.

### Short post

Navide currently brings together:

- Claude Code, Codex, Antigravity CLI, Grok CLI, and terminal sessions
- Session persistence, rebuild, and resume
- Configurable multi-stage Pipelines
- Private per-user project history under `.agent-team/`
- Editor, Diff, terminal, Git, tests, and review surfaces

It is local-first, macOS-first, open source, and currently installed from source. The long-term direction is to become the primary engineering environment for the Agent era.

## Repository announcement

### Heading

Navide: the engineering instrument for the Agent era

### Body

Navide is an open-source, AI-native software engineering environment for one person directing multiple coding agents.

The traditional IDE assumes the engineer personally drives most implementation work. Navide starts from a different premise: agents can research, plan, build, test, and review in parallel, while the engineer owns intent, architecture, risk, judgment, and final acceptance.

Current capabilities include multi-agent workspaces, persistent sessions, configurable Pipelines, local workspace history, automation controls, Diff and editing, terminals, Git, tests, and review surfaces.

Navide currently supports macOS 13+ and is installed from source. A signed public download is not yet available.

## FAQ

### Is Navide another AI IDE?

Navide includes editing and engineering surfaces, but its center is different. It organizes goals, agents, sessions, context, exceptions, and evidence rather than treating AI as a chat panel beside manual code entry.

### Does Navide already replace every IDE workflow?

No. It is already the founder's primary development environment and provides a working foundation. Complete professional replacement is the product direction, with remaining work documented in the roadmap.

### Which coding agents are supported?

The current registry supports Claude Code, Codex, Antigravity CLI, Grok CLI, and plain terminal panes.

### What is `.agent-team/`?

It is a local, per-user intelligence layer for a workspace. It can contain session information, run events, task context, handoffs, and history. It is excluded from Git and is not intended for human-team synchronization.

### Is Navide offline?

Navide is local-first, not universally offline. Its orchestration and workspace state run locally. External agent CLIs, model providers, Git hosts, search, MCP servers, and update checks may communicate with third parties when used.

### Does Navide sandbox agents?

Navide does not yet provide a complete workspace sandbox. Agents normally inherit the current user's operating-system permissions unless their CLI provides and enables its own sandbox.

### How do I install it?

Navide currently supports macOS 13+ and is installed from source. Follow the repository README for Node.js, pnpm, Python, uv, and agent CLI prerequisites.

### Is there a signed public download?

Not yet. Public messaging must direct people to GitHub and source installation until the signed release process is complete.

## Build Notes format

Use this recurring structure for small, evidence-led product updates.

```markdown
# Build Notes — YYYY-MM-DD

## Outcome
One sentence describing the user-visible engineering outcome.

## Why it matters
The coordination, context, intervention, or evidence problem it improves.

## What changed
- Three to five concrete changes

## Evidence
- Test, recording, screenshot, Diff, or measurable behavior

## Current boundary
What remains incomplete or intentionally out of scope.

## Next
The next product question being explored, without promising a fixed date.
```

## Asset checklist

- Social preview SVG at `assets/social-preview.svg`
- 45-60 second product workflow demo
- 2-3 minute narrated product tour
- Three reviewed screenshots
- Founder case-study page
- README hero visual
- English and Traditional Chinese announcement copy
- Verified links and source-install instructions

