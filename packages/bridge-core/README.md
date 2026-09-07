# RemoteDesk bridge core

Original MIT implementation shared by the Codex and DSH host plugins. The public v1 wire contract lives in `packages/protocol` in the canonical Codex repository. See the host operations and security documentation for installation, limits and recovery procedures.

This package has no npm runtime dependencies. Node.js 22.16 or newer supplies SQLite, TLS and HTTP; certificate operations use the locally installed OpenSSL 3 executable. Restricted project tools use the locally installed Docker CLI and an administrator-selected immutable Linux image. These external runtimes are not bundled.

DSH redistributes an exact tarball from this directory with its license and records the source commit and SHA256 in `docs/provenance.json`. Update that tarball, lockfile and bundled package together; never maintain a divergent copy of core source in DSH.
