# Product Roadmap

Navide's long-term direction is a **local-first multi-agent development control plane**: a place to configure, run, observe, govern, and review teams of coding agents without locking the workflow to one model vendor.

This roadmap is directional. It does not promise dates or guarantee that every item will ship. Released behavior belongs in [CHANGELOG.md](../CHANGELOG.md); current behavior belongs in the [User Guide](user-guide.md).

## Product principles

1. **Orchestration before imitation** — prioritize coordination, observability, control, and review over reproducing every general-purpose IDE feature.
2. **User-owned state** — keep workspace state, run artifacts, and configuration inspectable and portable where practical.
3. **Provider-neutral contracts** — model agent capabilities explicitly instead of assuming one CLI's syntax or storage layout.
4. **Safe automation** — automation level, data flow, and tool authority must be visible and controllable.
5. **Reviewable delivery** — an agent run is not complete until its artifacts, changes, checks, and unresolved risks can be reviewed.
6. **Graceful degradation** — optional analyzers, documentation services, and provider integrations must not prevent basic terminal work.

## North-star workflow

```text
Issue or local task
  → policy and repository preflight
  → dependency graph and team proposal
  → user approves scope, agents, cost, and authority
  → agents execute in parallel with durable events and artifacts
  → manager resolves dependencies and exceptions
  → tests, security checks, and review gates run
  → user reviews diff, evidence, cost, and open risks
  → branch, commit, and draft pull request are prepared intentionally
```

The user remains the authority for destructive operations, credentials, publication, and final acceptance.

## Horizon 0 — Documentation and release foundation

**Outcome:** a new user can understand, install, evaluate, and safely operate Navide.

Scope:

- Canonical product naming and capability descriptions
- Getting-started, user, privacy, troubleshooting, architecture, and roadmap documentation
- Accurate supported-agent matrix and source-install commands
- Versioned changelog and repeatable signed macOS release process
- Screenshots or a short workflow demonstration when stable release UI is ready

Exit criteria:

- Documentation has no material contradictions with the agent registry or default pipeline
- A clean macOS machine can follow the documented installation path
- The first signed GitHub Release contains DMG, ZIP, blockmaps, and updater metadata
- Privacy documentation identifies every optional external-service category

## Horizon 1 — Orchestration reliability and observability

**Outcome:** users can trust that a run's state is durable, understandable, and recoverable.

Scope:

- Unified run, pane, stage, question, handoff, command, and artifact event schema
- Crash-safe persistence and deterministic restoration
- Clear state transitions for starting, waiting, blocked, failed, completed, aborted, and resumed work
- Explicit timeout and retry policies
- Run summary containing changes, tests, token usage, elapsed time, warnings, and unresolved questions
- Exportable diagnostics with automatic credential redaction

Exit criteria:

- Restarting Navide during representative runs does not silently lose accepted work or corrupt state
- Every automatic stage transition is attributable to a visible event or policy
- Failed session binding offers a diagnosable recovery path
- Run summaries reconcile with the underlying history and Git diff

Non-goal:

- Autonomous publication or merge without an explicit user-controlled policy

## Horizon 2 — Capability-based agent adapters

**Outcome:** adding an agent no longer requires scattered knowledge of frontend, backend, session storage, and token parsing.

Scope:

- Declarative adapter manifest for identity, executable, install help, capabilities, and permission modes
- Standard launch, readiness, resume, interrupt, and termination hooks
- Optional session-discovery and usage-reader interface
- Capability flags such as session pinning, resume, structured output, image input, MCP, sandbox, and token reporting
- Compatibility test kit with fixtures for logs and session binding
- Adapter health and version diagnostics in onboarding

Exit criteria:

- A simple CLI integration can be added without editing the pipeline UI core
- Adapter validation reports missing or incompatible capabilities before a run starts
- Built-in agents pass the same contract tests
- Unknown capabilities degrade safely instead of receiving guessed flags

Non-goal:

- Normalizing every provider-specific feature into a lowest-common-denominator chat API

## Horizon 3 — Policy, isolation, and secret handling

**Outcome:** users can reason about what each agent may read, write, execute, and transmit.

Scope:

- Preflight showing workspace, repositories, dirty state, agent commands, external services, and effective authority
- Policy profiles for read-only analysis, workspace write, test execution, network access, and unrestricted mode
- Secret detection and redaction before handoff, export, diagnostics, and cloud requests
- Workspace boundary enforcement using platform-appropriate sandbox primitives where feasible
- Protected-path rules and explicit escalation events
- Credential references through operating-system facilities or provider-owned stores rather than copying secrets into prompts
- Audit trail for policy changes and bypasses

Exit criteria:

- Users can inspect effective permissions before launch
- Protected paths and detected secrets are blocked or require explicit escalation according to policy
- Handoff and diagnostic exports pass redaction tests
- Unsupported sandbox guarantees are stated clearly per platform and agent

Non-goal:

- Claiming a security boundary that the operating system or external CLI cannot enforce

## Horizon 4 — Reproducible runs and artifact provenance

**Outcome:** a completed run is a reviewable package of intent, actions, evidence, and outputs.

Scope:

- Immutable run manifest with task, repositories, base revisions, configuration, adapters, and policy
- Content-addressed artifacts for plans, handoffs, patches, logs, test results, screenshots, and reports
- Relationship between agent output, applied edits, commits, and review decisions
- Re-run and fork-from-checkpoint workflows
- Retention, export, import, and deletion controls
- Schema versioning and migrations for durable artifacts

Exit criteria:

- Exported runs can be inspected without the original live processes
- Every applied change identifies its originating run and available evidence
- Replaying from a checkpoint does not mutate the original run record
- Retention settings make storage growth visible and controllable

## Horizon 5 — Dependency-graph orchestration

**Outcome:** teams can execute complex work according to dependencies rather than a fixed sequence of stages.

Scope:

- Task graph with typed inputs, outputs, dependencies, owners, and acceptance gates
- Parallel scheduling constrained by repository, file ownership, policy, and resource limits
- Conditional branches, retries, cancellation, and human approval nodes
- Manager proposals that users can edit before execution
- Conflict detection for overlapping file or repository scopes
- Cost, token, and concurrency budgets

Exit criteria:

- Independent nodes run in parallel while dependent nodes wait deterministically
- Graph state survives restart and supports partial retry
- Conflicting writes are prevented, isolated, or surfaced before integration
- Budget exhaustion pauses work with a clear decision point

Non-goal:

- Allowing a manager model to silently rewrite user-approved policy or budgets

## Horizon 6 — Delivery integrations and reusable team templates

**Outcome:** Navide connects local agent work to existing engineering systems without hiding publication decisions.

Scope:

- GitHub Issue and pull-request intake with repository and permission checks
- Intentional branch, commit, push, and draft-PR workflow
- Check, review, and unresolved-comment ingestion
- Reusable pipeline, role, adapter, policy, and team templates
- Signed template packages with version and compatibility metadata
- Import/export before any hosted marketplace dependency

Exit criteria:

- A work item can produce a draft PR with linked run evidence and explicit user approval
- Failed checks and review feedback can become scoped follow-up graph nodes
- Templates declare required adapters, permissions, and schema versions
- Installing a template does not execute code or grant authority implicitly

## Horizon 7 — Cross-platform and ecosystem maturity

**Outcome:** the control-plane model works consistently beyond one developer machine and one operating system.

Scope:

- Linux support with PTY, paths, permissions, packaging, and update parity
- Windows support with ConPTY, path/line-ending behavior, packaging, and installer policy
- Platform capability matrix and adapter compatibility reporting
- Stable extension documentation and example adapters
- Accessibility, internationalization, performance, and large-workspace hardening
- Optional collaboration design only after local artifact and policy boundaries are mature

Exit criteria:

- Platform CI exercises unit, integration, packaging, and representative terminal flows
- Unsupported capabilities are visible before execution
- Core run artifacts remain portable across supported platforms
- Accessibility and keyboard workflows cover the primary orchestration path

## Cross-cutting quality gates

Every horizon must consider:

- Backward-compatible state or an explicit migration path
- Threat model and privacy-data-flow changes
- Unit, integration, and end-to-end coverage proportional to risk
- Failure recovery and diagnostics
- Documentation and changelog updates
- Performance and storage impact
- Manual authority boundaries for external writes and publication

## Measures of progress

Prefer operational measures over feature counts:

- Successful first-run rate
- Time from workspace open to first healthy agent pane
- Session-binding and resume success rate
- Runs recovered after restart without data loss
- Automatic transitions with explainable evidence
- Handoffs requiring manual repair
- Agent-adapter integration effort
- Runs ending with reviewable diff and test evidence
- Secrets prevented from entering handoffs or exports
- Draft PRs accepted versus abandoned after agent execution

Navide does not currently collect product telemetry. Measures should come from opt-in diagnostics, local reports, tests, or explicitly shared issue data unless a future privacy-reviewed telemetry design is adopted.

## Scope guard

The roadmap should be re-evaluated whenever adjacent IDE functionality competes with control-plane reliability. Editor, chat, Git, and review features are in scope when they materially improve agent configuration, observation, intervention, or acceptance. General-purpose feature parity with established IDEs is not a primary goal.
