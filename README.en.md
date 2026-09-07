# RemoteDesk Codex plugin

Version **0.3.0** uses native host tools and requires no Docker. It provides authenticated project access, sessions/history, model and reasoning selection, streaming native tool output, approvals/questions, steering/cancellation, forks, compaction and owned background-job controls.

Requires Node **22.16+**, OpenSSL 3 and Codex **0.153.4**. Model authentication stays in the configured native host. Unknown engine versions fail closed.

Read [native permission boundaries](SECURITY.md), then follow [installation and operations](docs/operations.md). Verify the release archive against SHA256SUMS before extracting to a persistent version directory. The listener defaults to loopback port 9443; installing the plugin alone does not start it.

The core workflow follows native engine behavior. Read access, approved escalation, networking and detached processes are not container-isolated. Host extensions and delegated agents are unavailable in this release. HarmonyOS UI, device pairing and RustDesk transport remain separate client integration gates.
