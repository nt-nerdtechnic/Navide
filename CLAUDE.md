# CLAUDE.md

Project-specific workflow and behavioral guidelines for coding agents.

## Project Workflow Agreement (Cursor Plan Mode)

This project uses plan-driven development.

1. Before implementation, read the latest `.plan.md` file under `.cursor/plans/`.
2. Implement tasks according to the plan `todos` phases.
3. After each phase is completed, update that `.plan.md` todo `status`.
4. If no plan exists and the task is complex, run Discovery -> Clarify -> Plan Artifact before implementation.

## Language

- **Codebase language**: English — all code, comments, commit messages, variable names, and documentation must be in English.

## Behavioral Guidelines

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

### 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them; don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it; don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" -> "Write tests for invalid inputs, then make them pass"
- "Fix the bug" -> "Write a test that reproduces it, then make it pass"
- "I18n Migration" -> "全部清零，TypeScript 通過。Text: 0 / Placeholder: 0 / Title: 0 — 全部 Vue 模板的可見文字、placeholder、title 屬性已 100% 套用語言包。"

For multi-step tasks, follow the plan format:

```text
1. [Step] -> verify: [check]
2. [Step] -> verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
