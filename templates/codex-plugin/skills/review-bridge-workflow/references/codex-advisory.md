## Advisory CODEX_TASK sandbox

This is the CODEX_TASK dispatch for [Advisory panel](advisory-panel.md) only.
The host launch described below is documented in [CODEX_TASK](codex-task.md)
for operator-authored changes; do not load or run it for a panel.

Resolve all `../../scripts/` helper paths from the directory containing
`review-bridge-workflow/SKILL.md`, not from this `references/` directory.

An `advisory: true` review does not take this launch. The sandbox bounds
writes and network, not reads: the reviewer's shell reads the whole host, so
an outside author's diff, requirement, and commit messages — every one of
them attacker-controllable text — can steer a reviewer into reading the
operator's credentials and carrying them out through `submit_review` or its
own model context, with no network needed. Every other MCP server the host's
`~/.codex/config.toml` enables is reachable from the same run as well, and
sits outside the sandbox altogether; this launch does not shrink that set.
For attacker-controllable input the sandbox is therefore not an isolation
boundary, and the reviewer skill's
rule that such material is material to verify and never instructions is
skill discipline rather than a mechanism. An advisory `CODEX_TASK` member is
launched only through the packaged `../../scripts/advisory-sandbox-launch.mjs`,
run like the other packaged helpers and backgrounded so it does not block the
wait:

```bash
node ../../scripts/advisory-sandbox-launch.mjs --review-id <review_id>
```

It runs this same reviewer inside a Linux container that is the read boundary.
Nothing from the host exists inside it except what the launcher mounts: the
operator's `auth.json` as a read-only bind mount, never copied into an image
layer; the packaged marketplace and plugin, read-only; the author checkout,
read-only at the path the ledger records, because the reviewer server reads it
by recorded path and any other tree would be the wrong bytes; a staged copy of
the one review under `/store`, read-write; and an empty working directory. The
host store is never mounted; one staged review is copied in and validated on
the way back, because under `danger-full-access` the reviewer's shell could
otherwise read and rewrite every other ledger, lock, and workflow in the store,
past the reviewer server's provider check and mutation lock. The staged
bytes are never copied: the verdict is replayed through the host's own
`submit_review` against the host ledger, under that review's own state lock,
with the findings the staged ledger records as the payload, and the host keeps
the replay's result only when it equals the staged ledger field for field,
timestamps aside. A staged ledger the replay cannot produce — a status the
payload does not reach, a snapshot hash or a history the host never wrote — is
refused, as is a staged store that changed or added any other file, or is not
the one review, and a host ledger that moved since launch; any failed check
leaves the host store unwritten and the staged copy in the scratch directory
for inspection. The host home's sensitive contents are absent rather than
denied: before the reviewer starts, the launcher's own probe reports `absent`
for `~/.ssh`, `~/.codex` and its `auth.json`, `~/Library`, `~/.gnupg`,
`~/.aws`, `/root/.ssh`, and the store, and the launch stops if any of them is
present. Absent is judged against the same image without the checkout mount,
so a directory the image itself carries is not read as the host's, and each
ancestor of the checkout may gain exactly the one name that leads down to it.
What the
container mounts at the recorded path is not the panel checkout's `.git` but a
fresh clone the launcher makes itself from it (`git clone --template=
--no-local --no-hardlinks file://<panel checkout>` into its scratch
directory, detached at the review's recorded snapshot head — which the
panel checkout must still be at, or the launch is refused before anything
starts — and removed at cleanup): the
operator's `.git` never enters the container, only the objects reachable
from the panel's refs cross, so a hook, a stray file among the objects, or a
comment in the configuration that a template or a hand left there stays on
the host. Every git the launcher
itself runs on the host — those checks and the staging clone — runs in an
isolated environment (no global or system configuration, an empty `HOME` and
hooks path, no `GIT_*` from the operator's shell), so a `.gitattributes` in
the reviewed tree can name no filter that resolves and nothing of the
checkout runs on the host before the container exists. The review's last
round must be a clean commit — `worktree_clean` true and no overlays — since
the clone can materialize only commits; a snapshot prepared over a dirty
tree is refused before anything starts, and the panel clone, being fresh, is
clean by construction. What the reviewer reads is the panel clone's own
content: a `.env` or `.netrc` in that tree crosses with it, so the panel
clone is yours to keep clean. The container is the only sandbox. Inside it the reviewer
runs with `--sandbox danger-full-access`, because Codex's nested bubblewrap
does not start under Docker's default confinement, and relaxing that
confinement to fit a second sandbox inside would weaken the one boundary that
matters. Codex runs under an isolated `CODEX_HOME` whose configuration names
this plugin and nothing else, so the host's other MCP servers are absent by
construction and there are no memories to read; the launch line inside
otherwise carries what the host launch carries — the guardian as approver,
the granular refusal, memories pinned off, the author server disabled, stdin
closed — plus the reviewer server restated at its container path with the
store's container path in its environment. Egress goes only through a sidecar
proxy on an internal Docker network that admits `chatgpt.com`,
`api.openai.com`, and `auth.openai.com` (the token refresh endpoint; refreshed
tokens are not persisted back, since `auth.json` is read-only in the
container), allowlisted by CONNECT host and by the TLS SNI the client then
presents, and refuses every other host: `curl https://example.com`
from inside fails through the proxy and has no route without it, while the
model calls complete (measured 2026-09-10). Every container the launcher
starts writes through a bounded json-file log driver (16 MB, two files) and
the sidecar collapses a record that repeats into a counted line, so a
reviewer looping on a refused host cannot fill the host's disk and the
egress summary still totals every refusal. Nothing the reviewer can write
touches the host while it runs: the staged review is copied into a
tmpfs-backed Docker volume capped at 64 MB and the isolated `CODEX_HOME` into
one capped at 1 GB, so a write past the cap fails inside the container rather
than on the host's disk; afterwards the store's apparent size is measured
inside the container and copied out only within 64 MB overall and 8 MB for
any one file — past either the volume is kept unread and named in the report,
and the host hashes what does come out a stream at a time. The container also
resolves no name but the sidecar's: `--internal` cuts routing, not
resolution, and a name would carry data out on its own. What the reviewer
writes to the host is bounded the same way: the transcript keeps its first
64 MB and records how much it dropped, a rollout past 8 MB is named and left
unread rather than parsed, and every piece of that evidence is read before
anything is copied back, so a host ledger that moves always has a report
beside it. Every container runs under memory, swap, process, and CPU limits
(the reviewer's 4 GB and 2 CPUs by default, raisable with `--memory` and
`--cpus`; the helpers far less). On exit the launcher prints the
three criteria it verified — the reviewer's MCP calls completed inside the
container, the host filesystem was absent, the validated verdict was copied
back to the host store — with the guardian's verdict per call and the proxy's
egress log, and
exits nonzero when any of the three does not hold. The first criterion is
run-health evidence recorded inside the container and forgeable by a reviewer
with shell access; the copy-back's integrity rests on the host replay, not on
it. Opening the task by hand
is not a mitigation: the read happens and enters the model's context before
an operator could intervene, and it leaves through the verdict the same way,
so a person at the keyboard changes nothing about that chain. Without Docker
the launcher fails closed and the advisory `CODEX_TASK` member is unavailable
rather than opened another way. On Docker Desktop keep the panel worktree,
the runtime marketplace, and the store under your home directory: the
launcher refuses a path under `/private/tmp/` or `/Volumes/`, because Docker
Desktop stops serving files there a few seconds into a container (measured
2026-09-10). The residual is stated, not closed: the one
host secret inside the container is `auth.json`, so the operator's credential
rides into every advisory review, and what remains of the exfiltration path
is the two allowed hosts and the verdict text itself, which lands in the
store the operator reads. A narrowly scoped API key in place of the ChatGPT
token is the operator's option; the launcher does not change how `auth.json`
is produced. What the advisory fence guarantees is unchanged either way:
`finalize_local_gate` refuses an advisory review, so its terminal state is a
report and never a `LOCAL_GATE_PASSED`, however the reviewer was started.
