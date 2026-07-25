# Changelog

## 0.1.1 - 2026-07-25

### Added

- A GitHub Codex review gate after the local Claude review gate.
- Open-source contribution, security, platform, and data-retention guidance.
- Package metadata for the source repository, issue tracker, and MIT license.

### Fixed

- Source packages now contain only files tracked at the release commit and
  builds refuse dirty working trees.
- Snapshots handle committed deletions, UTF-8 chunk boundaries, literal
  backslashes, colon-containing paths, and oversized modified files correctly.
- Publication reviews bind the immutable base SHA, local gate, CI result, and
  GitHub review to the intended pull-request head.
- The release build overrides the vulnerable transitive `tmp` version used by
  the MCP Bundle development toolchain.
