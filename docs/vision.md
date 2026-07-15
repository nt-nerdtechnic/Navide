# Product Vision

English | [繁體中文](zh-TW/vision.md) | [Documentation](README.md)

## Vision

Navide will become the primary engineering environment for the Agent era: a system in which one engineer can direct, synchronize, and verify an AI engineering force across the complete software lifecycle.

## Mission

Give one engineer the execution capacity of an entire software team while preserving human intent, judgment, ownership, and final responsibility.

## Category

Navide is an AI-native software engineering environment: the engineering instrument for the Agent era.

The category is broader than an AI editor, terminal multiplexer, or collection of chat sessions. Navide organizes engineering work around outcomes, agents, sessions, coordination, private project intelligence, human exceptions, and acceptance evidence. Files, editing, terminals, and Git remain first-class instruments inside that environment.

## Target user

Navide is built first for a solo engineer who manages both the product and multiple AI agents. This includes independent developers, technical founders, and engineers who own an end-to-end product area.

The product is not intended to become a generic operating system for all knowledge work. Software engineering is its domain.

## Product thesis

The traditional IDE organizes work around files and direct code entry. An AI-native engineering environment must organize work around:

- Goals and acceptance criteria
- Agents, roles, capabilities, and sessions
- Tasks, dependencies, ownership, and progress
- Shared context, decisions, and handoffs
- Changes, tests, reviews, and evidence
- Human exceptions and final acceptance
- Private project intelligence that survives individual sessions

The editor remains a first-class engineering tool, but it becomes one mode of intervention inside a larger system rather than the sole center of development.

AI increases execution capacity. Coordination becomes the new bottleneck. Navide exists to make concurrent agent work owned, contextual, visible, interruptible, recoverable, and verifiable.

## The three engineering loops

### Genesis

Turn an idea into the first working form of a product. A configurable pipeline moves from requirements through planning, design, implementation, review, and testing. The outcome is a validated prototype and a durable body of project context—not the end of development.

### Evolution

Continuously develop an existing project. The engineer sets a feature, fix, experiment, or quality goal; Navide coordinates one or more sessions through implementation, testing, correction, and verification. This is the everyday center of the product.

### Intervention

Let the engineer inspect and directly change the result when judgment or precision is required. Diff, editor, terminal, diagnostics, Git, tests, and review are not fallback failures; they are deliberate instruments of human control.

## Operating philosophy

Navide uses management by exception.

### The engineer owns

- Product intent and priorities
- Meaningful constraints and quality standards
- Architecture or product choices with lasting consequences
- Credentials, payments, publication, deployment, and destructive actions
- Final acceptance of the delivered result

### Agents own within approved boundaries

- Research and local codebase exploration
- Planning and task decomposition
- Reversible workspace edits
- Routine commands, tests, diagnostics, and repairs
- Progress updates, structured handoffs, and evidence collection
- Iteration until acceptance criteria pass or an exception is reached

### Navide owns

- Agent and session lifecycle
- Task routing and parallel coordination
- Context synchronization and private project memory
- Conflict, risk, idle, and failure detection
- Visibility, interruption, recovery, and auditability
- Returning the right exception to the engineer at the right time

## Project Intelligence Layer

`.agent-team/` is the local, per-user intelligence layer for a workspace. Its future model may include project state, sessions, runs, tasks, decisions, handoffs, evidence, and coordination metadata.

This layer is:

- Private to each user
- Stored locally by default
- Excluded from Git
- Separate from source files and team-shared project documentation
- Portable only through an explicit, controlled export/import flow
- Subject to retention, redaction, and deletion controls

It must never become an implicit cloud account, hidden team synchronization mechanism, or excuse to place credentials in agent context.

## North-star experience

An engineer should be able to:

1. Open a project and immediately recover its private engineering context.
2. Describe the next outcome instead of manually preparing every implementation step.
3. See Navide propose or activate the right agents and sessions.
4. Let independent work proceed in parallel without silent overlap or context loss.
5. Receive attention only for meaningful exceptions.
6. Inspect the reasoning trail, changes, tests, risks, and unresolved decisions.
7. Intervene through editor, terminal, Diff, or direct instruction at any time.
8. Accept a result backed by evidence and continue the next evolution loop.

## What replacement means

Replacing the traditional IDE does not mean copying its interface feature by feature. It means that an engineer can complete the full professional workflow—understand, create, navigate, edit, run, debug, test, review, version, and deliver software—without another IDE being the primary environment.

Navide must eventually provide complete engineering capability, but each capability should be reinterpreted around agent coordination and human judgment rather than inherited uncritically from the code-entry era.

## Success

Navide succeeds when:

- Users choose it as their primary daily engineering environment.
- A solo engineer can sustain multiple productive agent sessions without losing control or context.
- Project evolution becomes faster without making quality, security, or causality opaque.
- The private Project Intelligence Layer makes each new session more effective than an isolated conversation.
- Engineers spend more attention on direction, architecture, judgment, and acceptance than on repetitive execution.
- A complete product can move from idea to continuous delivery without requiring a return to the traditional IDE workflow.

## Evidence discipline

Navide's ambition must remain larger than its current implementation without allowing the two to be confused.

- README capability lists and the User Guide describe behavior available today.
- The Roadmap describes directional outcomes and exit criteria, not delivery promises.
- Founder use of Navide to develop Navide is valid dogfooding evidence, not customer validation.
- Replacement, autonomy, productivity, safety, adoption, and performance claims require product or independent evidence appropriate to the claim.
- Known security, privacy, distribution, and platform boundaries must remain visible in public communication.

See [Product Positioning and Public Claims](product-positioning.md) for the canonical communication hierarchy and claim boundaries.
