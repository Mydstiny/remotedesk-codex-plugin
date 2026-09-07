# RemoteDesk AI Bridge Protocol — AI0 boundary

Protocol v1 is not frozen or served by this alpha. This directory will own canonical wire schemas and test vectors for both adapters and HarmonyOS. The internal stdio transport is not the remote protocol.

Fixed design constraints: authenticated device and service identity before business handshake; separate authorization generation, adapter epoch and event cursor; exact live approval ownership; project visibility distinct from actual tool/shell/MCP execution confinement; revocation closes subscriptions and rejects old replies; account/Pro revocation does not cancel unrelated local tasks.

Submission epochs will be signed/recognized, valid for at most 24 hours, with accepted-operation deduplication retained until at least 7 days after expiry. Unknown, expired or recycled epochs require reconciliation and must not re-execute. The client must not silently replace an unresolved operation's epoch/ID after disconnect. Persist enough rejection state to refuse old epochs after storage cleanup or service reset.

None of these planned storage/authentication guarantees is implemented by the AI0 probe. Do not import this document as an implemented capability manifest.
