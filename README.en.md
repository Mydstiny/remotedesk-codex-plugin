# RemoteDesk Codex Plugin

The Codex host component for RemoteDesk's HarmonyOS Pro AI workspace. **0.1.0-alpha.1 is an AI0 engineering probe, not a remotely usable product.** This GitHub repository owns the plugin; HarmonyOS code is managed separately in [RemoteDeskHarmonyOS](https://github.com/Mydstiny/RemoteDeskHarmonyOS).

From a maintainer-verified immutable source revision, with Node.js 22 or later:

```sh
npm test
node bin/remotedesk-codex.mjs doctor --json
```

No npm runtime dependencies or background services are installed. The current probe opens no network listener. A successful doctor result certifies only its listed checks; `capabilities.remoteAccess` stays false. Pairing, persistent remote control, full execution isolation, the HarmonyOS UI and RustDesk transport are not implemented.

Run `node bin/remotedesk-codex.mjs probe --json` for the actual local App Server handshake and ephemeral read-only thread check. It sends no model turn, changes no account/settings, and may cause upstream operational logs/cache writes.

The planned HarmonyOS entitlement is the single lifetime Pro purchase (`pro.lifetime`). These tools do not mint purchase entitlements.

See [operations](docs/operations.md), [agent-assisted setup](docs/agent-deploy.md), [compatibility and evidence](docs/compatibility.md), [roadmap](docs/roadmap.md), and [中文文档](README.md). Full production installation instructions will accompany an actual supported release.
