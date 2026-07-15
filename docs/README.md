# Navide Documentation

Navide is the engineering instrument for the Agent era: an AI-native software engineering environment in which one person directs multiple coding agents through creation, continuous evolution, and precise human intervention.

## Start here

| Audience | Document | Purpose |
|---|---|---|
| Everyone | [Manifesto](manifesto.md) | Understand the historical shift Navide is responding to and the beliefs guiding the product |
| Everyone | [Product vision](vision.md) | Understand the target user, operating philosophy, product model, and definition of success |
| New users | [Getting started](getting-started.md) | Install Navide from source, satisfy prerequisites, and complete the first launch |
| Users | [User guide](user-guide.md) | Learn workspaces, panes, pipelines, manager coordination, Git, history, and editor workflows |
| Users | [Troubleshooting](troubleshooting.md) | Resolve startup, permissions, agent-session, analyzer, and token-tracking problems |
| Everyone | [Privacy and data flows](privacy.md) | Understand what stays local, what can connect to third parties, and where credentials are stored |
| Contributors | [Contributing](../CONTRIBUTING.md) | Set up a development environment and submit changes |
| Contributors | [Architecture](architecture.md) | Understand process boundaries, state ownership, and major services |
| Agent integrators | [CLI extension guide](cli-extension-guide.md) | Add or maintain an AI coding CLI integration |
| Maintainers | [Release guide](releases.md) | Version, sign, notarize, publish, and recover a macOS release |
| Maintainers | [Product roadmap](roadmap.md) | Track the directional path toward a complete AI-native engineering environment |

## Reference documents

- [Keyboard shortcuts](keybindings.md)
- [Editor design](editor-design.md)
- [Historical milestone record](spec.md)
- [Security policy](../SECURITY.md)
- [Changelog](../CHANGELOG.md)

## Documentation principles

- **Navide** is the public product name. `agent-team` is retained only where it is an internal package, directory, or compatibility identifier.
- **Local-first** means Navide's orchestration process and workspace state run on the user's machine. Optional agents, AI providers, documentation services, search, Git hosting, and updates may communicate with third parties.
- **Private project intelligence** under `.agent-team/` belongs to each user, stays local by default, and is excluded from Git; it is not a human-team synchronization layer.
- Agent support and pipeline stages are described as configurable capabilities. Avoid fixed counts when users can change the registry.
- Vision and roadmap documents may describe the intended future, while README capability lists and the user guide must describe shipped behavior accurately.
- `roadmap.md` describes direction, not a delivery promise. Released behavior belongs in the changelog and current capabilities belong in the user guide.
