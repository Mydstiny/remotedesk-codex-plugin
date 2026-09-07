# Maintainer instructions

This repository owns the RemoteDesk Codex plugin. HarmonyOS application code belongs in Mydstiny/RemoteDeskHarmonyOS; never copy that checkout, its history or credentials here.

- The source of truth is this GitHub repository. The maintainer currently requests GitHub branch/commit/PR management; temporary local files are for validation only.
- This is host-only remote bridge code. Keep authentication and execution isolation fail-closed; HarmonyOS application/device integration belongs to a later separate task. Keep the listener loopback by default.
- Read README.md, compatibility.json and docs/compatibility.md first. Use exact supported versions. Never read user account/session stores to diagnose compatibility.
- Keep changes on a task branch and create a PR. Run npm test, node syntax checks and npm pack --dry-run --ignore-scripts. Codex transport changes require the local probe; DSH lifecycle changes require test/agent-loop-runtime.mjs on the pinned runtime.
- Obtain an independent review before merge. Never commit secrets, machine paths, operational logs, generated upstream source, node_modules or floating dependency pins.
- Changes to upstream contracts require compatibility evidence, docs and NOTICE/provenance updates. Do not claim runtime or device coverage from fixture tests.
