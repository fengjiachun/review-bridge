## Dispatching a HERMES review

Use [Prepare](prepare.md) for a local review or [Advisory panel](advisory-panel.md)
for an advisory member. After a local verdict, load [Handle findings](findings.md)
or [Finish](finish.md) as its state requires.

This driver session can dispatch the `HERMES` reviewer itself rather than
asking the operator to start it by hand. Nothing else moves: Prepare, Handle
findings, and Finish still own the review, and this section adds only the
shell launch between them.

1. Follow Prepare through `get_review_summary`, choosing `HERMES` at its
   provider step. Record the returned `review_id` and `state_version` and
   report the summary exactly as Prepare requires.
2. Launch a fresh Hermes instance in the reviewer profile from the shell,
   handing it the reviewer request below as its single query:

   ```bash
   hermes -p <reviewer-profile> chat -q '<the reviewer request below>' < /dev/null
   ```

   > Independently review Review Bridge task `<review_id>` using the packaged
   > Hermes reviewer skill. Require `reviewer_provider: HERMES`, follow the
   > review strategy, and submit every actionable finding.

   Single-quote that request: it contains backticks, and a double-quoted
   shell string would execute them instead of passing them through. Pass it as
   one line with `<review_id>` substituted. Redirect stdin from `/dev/null`,
   as both launch lines here do: the launch has no terminal on stdin, and an
   approval prompt that fires anyway then reads end-of-file and is denied at
   once instead of waiting — what can raise one is stated below the launch
   discipline. Run the launch so it does not block step 3 — background it or
   use a separate terminal — and capture its stderr, where Hermes prints a
   `session_id:` line on exit.
3. Wait with `wait_for_review_state` on the recorded `state_version`, treating
   `timed_out` as the expected in-progress result described in Prepare. Unlike
   the one-shot `-z` mode, `chat -q` does not auto-approve tool prompts; what
   keeps the seven Review Bridge calls from raising one is the reviewer
   snippet's `trust: full`, below. If the wait keeps timing out, read the
   launch output before assuming the review is merely slow. When the state
   changes, hand the review to Handle findings, which owns narrating every
   finding from the ledger and, after `submit_resolutions`, every persisted
   disposition.

The launch discipline is fixed, and it states what must never happen rather
than counting launches. Never run two reviewers on the same round at once, and
never review from the author profile: never launch the author profile to
review, never resume or continue an existing Hermes session for a new review,
and never pass any authoring history — not the diff you wrote, the requirement
discussion, your reasoning, or this session's transcript. Within those two
bars launches are not rationed. That request is the whole handoff.

A round-two rereview of the same `review_id` resumes the instance that
produced round one, in the same shape as the launch:

```bash
hermes -p <reviewer-profile> chat --resume <session-id> -q '<rereview request>' < /dev/null
```

Send it the same review ID and a request to rereview the author's resolutions
with the packaged reviewer skill. That resume is round two's launch, so it is
required rather than an exception, and it starts no second reviewer: the
resumed instance is the one reviewer on that round.

A launch that has exited leaves the round to be judged from the ledger: if the
ledger shows no verdict for this round, no reviewer is working it, so start a
replacement launch in the same shape as the original; that replacement is the
same round, and both bars still hold, because the reviewer it replaces is gone.
The exit status, zero or not, establishes only that the process is gone — a run
can submit its verdict and then fail while saving its session or printing its
output, and a replacement started on that exit code alone would rerun a round
the ledger already carries. Judge that by the process having exited, never by
`wait_for_review_state` timing out: a timeout says the round is unfinished, not
that the reviewer is gone, and replacing a reviewer that is merely slow creates
exactly the concurrent pair the first bar forbids. The driver started the
process, so it has the exit status to judge by. A round-one replacement is a
fresh instance, not a resume: the launch it replaces produced no round one, so
there is nothing to resume, and the replacement's own `session_id:` line is the
one round two resumes. A round-two replacement resumes the round-one instance
again, as the launch it replaces did.

A launch sitting at a prompt has not exited, so the replacement rule does not
fire for it while it waits, and a replacement started after the denial meets
the same prompt; that is why the approval is settled by the snippet's
`trust: full` rather than by anyone at the keyboard.

Launch it outside the repository under review. Hermes injects project context
from the working directory — the first of `.hermes.md`, `AGENTS.md`,
`CLAUDE.md`, or `.cursorrules` that it finds wins, and the first two are
collected from the git root down rather than from that directory alone — so a
reviewer started in the authoring worktree inherits whatever rules the
workspace carries for its author. Pass `--in <directory outside the
worktree>` when this session's shell is inside it, and prefer a directory in
no repository at all, since one inside another repository inherits that
repository's rules instead. The reviewer process needs no checkout of its own:
its tools read the change from the immutable snapshot and from the author's
repository by recorded path, never from its own working directory. Its
`SOUL.md`, memory, and skills come from the reviewer profile's Hermes home,
which `-p` already separates.

This launch may run unattended; it needs no operator at the keyboard, and
what that rests on is one key in the packaged reviewer snippet: `trust: full`
on the `review-bridge-reviewer` server. Hermes routes an MCP call through its
approval prompt only on a server configured `trust: untrusted`, and there for
every tool without a `readOnlyHint` annotation, which is all seven here; on a
`trust: full` server no call of that server's tools is gated, so
`list_pending_reviews`, `open_review`, and `submit_review` run without a
prompt. That was measured on 2026-09-10 rather than read: under this launch
`list_pending_reviews` completed in 0.4 s and the run exited 0, and with the
same server marked `trust: untrusted` the same call raised the prompt —
`Server 'review-bridge-reviewer' is configured 'trust: untrusted'` — read
end-of-file from the closed stdin, and was denied without running. `full` is
also what Hermes assumes for a server with no `trust` key; the snippet names
it so the launch rests on packaged configuration rather than on a default.
One prompt remains outside the snippet's reach: a shell command Hermes classes
as dangerous, from any built-in toolset the reviewer profile carries beside
the server. The reviewer skill gives the reviewer no reason to run one, and
by Hermes' approval code every prompt path is bounded by `approvals.timeout`,
300 s by default, and denies when it expires — read from the source, not
measured here — so even that prompt ends in a denial rather than a wait.

Review Bridge records the review's `HERMES` binding; it observes nothing about
how the instance was started, and this section adds no mechanism that would.
The autonomous workflow continues to accept `CODEX_TASK` dispatch only.
The `CLAUDE_DESKTOP` boundary is unchanged, and nothing above narrows it:
never launch, script, or otherwise programmatically invoke a Claude reviewer
from this session — the operator opens that conversation themselves, an
account-compliance boundary rather than a convenience.
