# Contributing

Open a focused issue or PR with the exact version, operating system, expected behavior and sanitized reproduction. Follow [AGENTS.md](AGENTS.md). Use Node.js 22.16 or newer. Run npm test; source code has no npm runtime dependency. Run node syntax checks and `npm pack --dry-run --ignore-scripts`; review every packaged path.

CI covers Windows/macOS/Linux source tests with Node 22/24/26 and the exact native engine with a deterministic local model. The Linux Docker job exercises real container isolation and mTLS flows. See [compatibility](docs/compatibility.md) for additional native lifecycle gates and remaining hardware boundaries. No test requires user credentials, a paid model, or access to existing user sessions.

Code and documentation are MIT licensed. Any vendored material requires an exact source, license and hash. Keep changes on a task branch, obtain an independent review, and pass checks before merge. Never weaken version checks or copy credentials/operational state into a test or report.
