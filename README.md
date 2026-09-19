# Review Bridge

[![CI](https://github.com/fengjiachun/review-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/fengjiachun/review-bridge/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/fengjiachun/review-bridge)](https://github.com/fengjiachun/review-bridge/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)
[![Platform](https://img.shields.io/badge/platform-macOS%2013%2B%20%7C%20Linux-lightgrey.svg)](#platform-support)

A code-review handoff between an author task and an explicitly bound
reviewer: Claude Desktop, a fresh Codex task, a Hermes profile, a DeepSeek
Harness profile, or GitHub Codex in remote-only publication mode. Review Bridge
captures an **immutable snapshot** of a change, hands it to a reviewer that
had no part in writing it, and records every verdict in a ledger that later
steps check before they proceed. A publication gate then binds the pull
request, its checks, and the Codex review to one head SHA before it reads
`MERGE_READY`. Nothing starts without an operator instruction, and merging
stays a human decision.

Any MCP client can drive the author role (`--role author`). Codex is the
packaged author driver, so the example below uses it.

Review Bridge is an independent community project. It is not affiliated with,
endorsed by, or sponsored by OpenAI or Anthropic.

## Platform support

macOS 13 Ventura or newer, or Linux, with Node.js 18 or newer. Windows is not
supported or tested. State locking uses `/usr/bin/lockf` on macOS,
`/usr/bin/flock` on Linux, and `/bin/ps` on both. Publication needs an
authenticated [GitHub CLI](https://cli.github.com/) (`gh auth status`).

## Install the Codex plugin

The Codex plugin alone carries the author tools and the `CODEX_TASK` reviewer,
so with the Codex GitHub App on the repository it is enough to take a change
from a commit to `MERGE_READY`. Build it from a clone at a release tag:

```bash
git clone https://github.com/fengjiachun/review-bridge.git
cd review-bridge
git checkout v0.15.3
npm ci
npm run build
codex plugin marketplace add "$(pwd)/dist/review-bridge-v0.15.3/codex-marketplace"
```

Restart the Codex desktop app, open Plugins, select **Review Bridge Local**, and
install **Review Bridge**. Keep the `codex-marketplace` directory in place: the
installed plugin is served from it. `npm run build` refuses a working tree with
any modified or untracked file and needs network access; a fresh clone at a
release tag satisfies both.

Every process shares one store, by default
`~/Library/Application Support/ReviewBridge`; set `REVIEW_BRIDGE_HOME` to
override it. Pin every participant to the same release tag.

Other clients:

- [Claude Desktop reviewer extension](docs/install/claude-desktop.md)
- [Hermes reviewer and author profiles](docs/install/hermes.md)
- [DeepSeek Harness reviewer and author profiles](docs/install/deepseek-harness.md)

## From a commit to `MERGE_READY`

Commit the change on a topic branch. Then, in a Codex task:

> Prepare the current changes for a `CODEX_TASK` review. The requirement is
> "...", the implementation scope is "...", and the base ref is `origin/main`.

Codex returns a `review_id` and waits in `WAITING_FOR_REVIEW`. Create a **new**
Codex task — not a fork of the author task — and give it only this request:

> Independently review Review Bridge task `<review_id>` using the packaged
> reviewer skill. Submit every actionable finding and do not modify the code.

If the reviewer submitted no findings, the review is `CLEAN`. Otherwise, back
in the author task:

> Read the reviewer's findings, address each one, and prepare round two.

and start another new Codex task with the same review ID and a request to
rereview the author's resolutions. Round two ends in one of three
states: `CLEAN`, `CONTINUABLE_FINDINGS` (a new issue, addressed in a fresh full
review), or `HUMAN_REQUIRED` (a prior finding still contested). Once the review
is `CLEAN`, the author task finalizes it to `LOCAL_GATE_PASSED`, which re-checks
that the working tree still matches the reviewed snapshot.

Then ask the author task to publish:

> Publish this change through GitHub in `LOCAL_GATE` mode.

The packaged workflow skill pushes the gated head, opens a draft pull request,
records a baseline of the existing Codex feeds, posts one Codex review request
carrying a server-issued request ID, and records complete GitHub observations.
A Codex finding means a fix commit and a new local review; a new commit
invalidates the publication. Mark the pull request ready for review yourself:
a draft never reads `MERGE_READY`. When the head is the gated head, the
correlated Codex result is clean, every required check has passed, and no
review thread is unresolved, the ledger reads `MERGE_READY`.
`finalize_publication_gate` then mints an expiring gate, and
`verify_publication_gate` must return `valid: true` immediately before a
head-matching merge. Merging stays your decision.

[How Review Bridge reviews a change](docs/review-flow.md) walks the same path
and explains why each step exists.

## Documentation

| Page | For |
| --- | --- |
| [How Review Bridge reviews a change](docs/review-flow.md) | The narrative: commit to merge-ready, and why |
| [Run a local review](docs/local-review.md) | Every provider's request, round two, successor reviews, the state machine |
| [GitHub publication gate](docs/publication-gate.md) | `LOCAL_GATE` and `REMOTE_ONLY` publication |
| [Autonomous workflow](docs/autonomous-workflow.md) | The authorized end-to-end workflow |
| [Reference](docs/reference.md) | Every tool and error code, generated from the source |
| [Troubleshooting](docs/troubleshooting.md) | Structured errors and build failures |
| [Install pages](docs/install/) | Claude Desktop, Codex plugin, Hermes, DeepSeek Harness |

The contract an agent driver follows lives in the packaged
[`review-bridge-workflow` skill](templates/codex-plugin/skills/review-bridge-workflow/SKILL.md), not in this README.

## Security and scope

- The bound local reviewer receives read-only snapshot and search tools and
  verdict-writing tools. It has no Review Bridge tool for modifying the
  repository, pushing code, or creating pull requests.
- Author and reviewer roles run as separate MCP processes with different tool
  lists, and each local review is bound to one reviewer provider.
- Local, remote-only, and publication gates are workflow attestations, not Git
  or GitHub security boundaries. Review Bridge does not install a `pre-push`
  hook. Provider binding and separate Codex tasks are not authenticated human
  or model identity, and a `CODEX_TASK` review improves context isolation
  without the model diversity of a separate provider.
- The Review Bridge MCP server receives no GitHub credentials. The packaged
  Codex skill and read-only observation collector use the user's separately
  configured GitHub tools.

## Data handling and cleanup

The review store contains repository paths, requirements, patches, manifests,
review findings, remote-only operator labels and rationales, and copies of
changed working-tree files. Store directories are created with mode `0700` and
files with mode `0600`. Files larger than 10 MiB are recorded but not copied
into the snapshot.

The Review Bridge MCP servers do not contain a network client or telemetry
integration. The selected client may send source returned by reviewer tools to
its model provider according to the account and organization configuration in
use.

Review data is retained until it is deleted. To remove one task, stop active
Review Bridge operations and delete `reviews/<review_id>` inside the configured
store. To remove all tasks, quit active Review Bridge processes and delete the
configured directory.

See [SECURITY.md](SECURITY.md) for vulnerability reporting and the supported
release policy.

## Develop

Requirements: the platform above, npm, and Git; `npm run verify:build`
additionally requires `unzip`.

```bash
npm ci
npm test
npm audit --omit=dev
npm run build
npm run verify:build
```

`npm run build` writes to `dist/review-bridge-v0.15.3/`; set
`REVIEW_BRIDGE_OUTPUT_ROOT` to write elsewhere. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the pull request process,
[docs/rfcs/](docs/rfcs/) for design records, and [CHANGELOG.md](CHANGELOG.md)
for release history.

## License

[MIT](LICENSE).
