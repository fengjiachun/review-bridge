# Install the Codex plugin

Describes Review Bridge v0.15.3.

Clone the repository and check out the release tag matching the extension you
installed, then build the local marketplace and register it:

```bash
git clone https://github.com/fengjiachun/review-bridge.git
cd review-bridge
git checkout v0.15.3
npm ci
npm run build
codex plugin marketplace add "$(pwd)/dist/review-bridge-v0.15.3/codex-marketplace"
```

Build from a Git clone, not from the release's source archive: `scripts/build.mjs`
runs `git status` to reject a dirty tree, which fails outside a Git worktree. The
archive is for inspection and provenance.

Restart the Codex desktop app, open Plugins, select **Review Bridge Local**, and
install **Review Bridge**.

The local marketplace remains the source of the installed plugin. Keep the
`codex-marketplace` directory in place while using this build.

Two things about `npm run build` are worth knowing before you run it: it refuses
to build from a working tree with any modified or untracked file, and it runs
`npm install` for the packaged runtime, so it needs network access. A fresh
clone at a release tag satisfies both. See [Develop](../../README.md#develop) for the full
build and verification loop.
