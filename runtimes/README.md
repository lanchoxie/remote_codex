# Runtime Bundles

This directory is the release-bundled fallback location for remote bootstrap runtimes.

Expected optional files:

- `node/node-v16.20.2-linux-x64.tar.xz`
- `codex/linux-x86_64/codex`
- `codex/linux-x86_64/rg`
- `codex/linux-x86_64/codex-resources/`

The relay still supports the legacy `tmp/` cache paths, but release packages should include these
runtime files here when targeting remote hosts that may not expose `node` or `codex` in non-interactive
SSH shells.
