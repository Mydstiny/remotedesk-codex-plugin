# Canonical RemoteDesk Bridge Protocol v1

The schemas in this directory and ../../docs/protocol.md define the shared protocol used by both host adapters. The DSH release embeds the same bridge-core version and records its source commit and tarball checksum in provenance. Adapter transcript/event payloads remain engine-specific; clients dispatch on the handshake engine and ignore unknown additive event types. Major breaking changes require protocol v2.

These schemas document JSON shapes; the implementation also enforces UTF-8 byte limits, TLS identity, persistent epochs, leases, project authorization, attachment expiry and engine constraints. Retry the original operation packet; do not reorder or regenerate its params. The native engine stdio/Host API is not the network protocol.
