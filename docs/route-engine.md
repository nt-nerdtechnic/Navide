# Agent-Team Route Engine Spec

Status: v1 draft  
Date: 2026-05-26

## 1. Purpose

The route engine coordinates Claude Code, Codex, and Gemini CLI by converting recent output into fixed handoff prompts and sending them to the next agent.

## 2. Default Route

1. Claude Code -> Codex
2. Codex -> Gemini CLI
3. Gemini CLI -> Claude Code
4. Any -> User for blocker/high-risk/unclear next step

## 3. Round Model

A round is one full route cycle from Claude to Codex to Gemini and back to Claude, or until stopped by completion/blocker/user action.

Defaults:

- `max_rounds`: 3
- no-output timeout: 10 minutes per agent
- no-progress threshold: 2 consecutive rounds

## 4. Handoff Generation

Route engine creates fixed handoff prompt:

- source agent
- target agent
- task title/id
- round number
- route type
- context summary
- findings/changes
- request
- evidence
- constraints
- expected output

Raw terminal output is summarized. Excerpts are included only as evidence.

## 5. Progress Detection

Progress signals:

- Git changed files changed since last checkpoint
- tests newly passed or newly failed
- route status changed
- blocker resolved
- new artifact or summary produced

No progress:

- no changed diff
- no new test result
- repeated same blocker
- repeated same route summary

## 6. Stop Conditions

Stop route engine when:

- max rounds reached
- no-output timeout reached
- no-progress threshold reached
- tests pass and Claude reports no blocker
- any agent reports blocker
- severe secret detected
- Stop Orchestration clicked
- Kill Task clicked

## 7. Redaction

Before route send:

1. scan generated handoff
2. redact secrets
3. if severe secret found, Stop Orchestration
4. persist redacted route message
5. send redacted route message

## 8. Persistence

Persist every route message with:

- source
- target
- route type
- round
- status
- redacted content
- timestamps

## 9. Manual Intervention

User may:

- pause route engine
- resume route engine
- inject message to one agent
- inject message to all agents
- edit next handoff before sending in manual mode later
- Stop Orchestration
- Kill Task

V1 defaults to automatic send after redaction unless stopped by high-risk rule.

