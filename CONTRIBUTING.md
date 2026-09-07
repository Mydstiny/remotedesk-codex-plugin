# Contributing

Open a focused issue or PR with the observed version, operating system, expected behavior and sanitized reproduction. Follow [AGENTS.md](AGENTS.md). Install Node.js 22 or later and run `npm test` from the repository root. No third-party npm dependencies are required for the current source tests. Run `npm pack --dry-run --ignore-scripts` to inspect package contents. The native engine is supplied by the user and must remain outside the package.

Code and documentation are MIT licensed. Describe copied upstream material and its license before introducing it. A passing source test suite does not enable remote access or establish a supported device/platform release.
