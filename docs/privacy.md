# Privacy and Data Flows

Navide is **local-first**, not universally offline. Its Electron application, Python backend, terminal sessions, workspace state, and orchestration logic run on your Mac. Data can leave the machine when you enable or use an external service.

## Data kept locally by Navide

Depending on enabled features, Navide stores:

- Workspace state and run artifacts under `<workspace>/.agent-team/`
- Roles, pipelines, recent workspaces, UI settings, analyzer settings, and AI Chat settings in the application data directory
- Token-attribution and deduplication metadata derived from local CLI logs
- Optional AI provider API keys in a local settings file protected with restrictive file permissions (`0600` on supported systems)

Navide does not operate a project telemetry service and does not require a Navide account.

## Features that may communicate externally

| Feature | Possible recipient | Data involved |
|---|---|---|
| Coding-agent CLI | The CLI vendor or configured model provider | Prompts, selected context, tool results, and provider-defined telemetry |
| Cloud AI Chat | Anthropic, OpenAI, Google, Groq, DeepSeek, Mistral, xAI, or a custom endpoint | Chat messages, attached context, and model parameters |
| Context7 injection | Context7 and its MCP distribution/runtime dependencies | Detected library names and documentation queries |
| Web search | Search provider | Search query text |
| Git operations | Configured Git host | Repository data and credentials handled by Git or the host flow |
| Update checks | GitHub Releases | Application version and normal network metadata |
| MCP servers | The configured MCP server and any service it uses | Depends entirely on that server's tools and configuration |

Read each provider's policy before sending private code or regulated data.

## Credentials

Agent CLI credentials remain in each CLI's own configuration. If you enter cloud AI keys in Navide, Navide stores them locally so AI Chat can use them. Settings export redacts API keys and tokens.

Local file permissions reduce accidental access by other users on the same machine but do not protect against malware, a compromised user account, unrestricted agents, backups, or processes with equivalent permissions.

## Agent permissions

Agents run with the current user's operating-system permissions unless the external CLI provides and enables its own sandbox. Navide does not currently provide a complete workspace sandbox.

YOLO mode may bypass CLI confirmation or sandbox protections. Use it only in trusted, version-controlled workspaces and review commands and diffs afterward.

## Context handoffs

Cross-agent handoffs can include task context and prior-stage output. Automatic secret scrubbing is not yet a complete security boundary. Do not place credentials in prompts, generated plans, logs, or files that may be handed to another agent.

## Removing local data

Project run data can be removed from the workspace's `.agent-team/` directory after active sessions are stopped. Application-wide settings and histories live in the Navide application data directory. Back up any configuration you intend to preserve before deletion.

For vulnerability reporting, see the [Security Policy](../SECURITY.md).
