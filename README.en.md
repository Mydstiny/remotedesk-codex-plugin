# RemoteDesk Codex host plugin

Version **0.2.0** provides an authenticated remote AI bridge for Windows, macOS and Linux: project-scoped pairing, session history and SSE, turns/steering/cancellation, one-command approvals, questions, diffs and attachments. HarmonyOS UI and RustDesk tunnel integration are separate future application work. A working reference CLI client is included.

Requirements: Node **22.16+**, OpenSSL 3, Codex **0.153.4**, a local Docker daemon running Linux containers, and an existing host model-provider configuration. Docker and the upstream engine are external installations. Unknown upstream versions fail closed.

All remote filesystem/command tools execute as a non-root user inside a fixed Docker image with only the selected project mounted, no network and a read-only root filesystem. Each command requires controller approval; bounded file reads use a read-only mount. The complete selected project, including .git and any secrets in it, is in scope. Provider credentials stay with the native host engine; model requests may contain authorized project data.

Get the versioned package and SHA256SUMS from this repository's Releases; verify and extract into a persistent version directory. Run `node bin/remotedesk-codex.mjs doctor --json`, then follow the [installation and operation guide](docs/operations.md) and [agent deployment checklist](docs/agent-deploy.md). The default listener is loopback and plugin installation alone opens no listener. DSH uses a native profile bundle; Codex uses a setup skill plus a separately managed bridge service.

LAN transport connects directly to the host and does not require an OpenAI relay. Model inference still uses the host's chosen provider; a cloud provider needs its cloud service, while a supported local provider may run locally. The bridge does not bundle a model or sell a separate entitlement. The future HarmonyOS client will use `pro.lifetime`.

[Protocol](docs/protocol.md) · [Compatibility and test boundaries](docs/compatibility.md) · [Security](SECURITY.md) · [中文](README.md)
