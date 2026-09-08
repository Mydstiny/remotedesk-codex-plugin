# RemoteDesk bridge-core

Shared authenticated transport and lifecycle library for the native Codex and DSH adapters. Node.js 22.16+ provides TLS/HTTP and SQLite; OpenSSL 3 supplies local certificates. No npm runtime dependencies and no container runtime are required. Native tools, sandbox rules and managed process semantics belong to each pinned upstream engine.

Includes private state, pairing, mTLS grants, leases, receipts, event replay, project locks, native answer validation, reference client and current-user service management. Recovery keeps uncertain native work locked until the host operator explicitly confirms its exact cleanup digest.
