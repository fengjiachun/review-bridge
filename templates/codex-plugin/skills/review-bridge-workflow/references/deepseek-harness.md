## Dispatching a DEEPSEEK_HARNESS review

Use [Prepare](prepare.md) for a local review or [Advisory panel](advisory-panel.md)
for an advisory member. After a local verdict, load [Handle findings](findings.md)
or [Finish](finish.md) as its state requires.

This driver session can dispatch the `DEEPSEEK_HARNESS` reviewer itself rather
than asking the operator to start it by hand. Nothing else moves: Prepare,
Handle findings, and Finish still own the review, and this section adds only
the shell launch between them.

1. Follow Prepare through `get_review_summary`, choosing `DEEPSEEK_HARNESS` at
   its provider step. Record the returned `review_id` and `state_version` and
   report the summary exactly as Prepare requires.
2. Launch a fresh headless run in the reviewer profile from the shell, handing
   it the reviewer request below as its single task:

   ```bash
   dsh --profile <reviewer-profile> '<the reviewer request below>'
   ```

   > Independently review Review Bridge task `<review_id>` using the packaged
   > Review Bridge reviewer skill. Require `reviewer_provider:
   > DEEPSEEK_HARNESS`, follow the review strategy, and submit every
   > actionable finding.

   Single-quote that request: it contains backticks, and a double-quoted
   shell string would execute them instead of passing them through. Pass it as
   one line with `<review_id>` substituted. `headless` is a profile name rather
   than a subcommand, so the reviewer profile's own bundle list selects the
   one-shot runner and the word never appears on this command line; writing it
   after the profile would prepend it to the reviewer request instead. Run the
   launch so it does not block step 3 — background it or use a separate
   terminal.
3. Wait with `wait_for_review_state` on the recorded `state_version`, treating
   `timed_out` as the expected in-progress result described in Prepare. The
   headless run prints only the reviewer's final message on stdout and stays
   silent on stderr unless it failed, so a nonzero exit is the signal to read
   its output before assuming the review is merely slow. When the state
   changes, hand the review to Handle findings, which owns narrating every
   finding from the ledger and, after `submit_resolutions`, every persisted
   disposition.

The launch discipline is fixed, and it states what must never happen rather
than counting launches. Never run two reviewers on the same round at once, and
never review from the author profile: never launch the author profile to
review, never continue an existing DeepSeek Harness session for a new review,
and never pass any authoring history — not the diff you wrote, the requirement
discussion, your reasoning, or this session's transcript. Within those two
bars launches are not rationed. That request is the whole handoff.

A round-two rereview of the same `review_id` is that review's next round, so
its launch is required rather than an exception: another launch in the same
shape, carrying the same review ID and a request to rereview the author's
resolutions with the packaged reviewer skill:

```bash
dsh --profile <reviewer-profile> '<the rereview request>'
```

That round runs in a session that did not perform round one, and there is no
session id to capture: the headless runner mints a fresh session per
invocation and exposes no way to name or resume one. Round two is
reconstructed from the ledger instead, which `open_review` serves whole —
every round-one finding with its explanation, recommendation, and status, and
every author resolution with its rationale and evidence. The reviewer skill
already requires each `rebuttal_accepted` decision to carry verification the
reviewer performed itself rather than recalled, so the evidence bar is the one
a resumed context would have faced.

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
process, so it has the exit status to judge by, and for this runtime that is
the whole signal: the headless run is silent until it ends, so the zero exit
that submitted nothing shows only in the ledger.

Launch it outside the repository under review. The invoking directory is the
session's workspace root, and DeepSeek Harness loads `AGENTS.md` and
`CLAUDE.md` from the project root — the nearest `.git` ancestor — down to that
directory, so a reviewer started in the authoring worktree inherits whatever
rules the workspace carries for its author. No flag that redirects the
workspace root exists, so run the launch from a directory outside the
worktree, and prefer a directory in no repository at all, since one inside
another repository inherits that repository's rules instead. The reviewer
process needs no checkout of its own: its tools read the change from the
immutable snapshot and from the author's repository by recorded path, never
from its own working directory. Its skills and user-global instructions come
from the packaged reviewer profile snippet, which scopes both to the release
directory.

This launch may run unattended; it needs no operator at the keyboard: the
headless runner takes its one task from the command line and runs to its
exit, and it never sits at an approval prompt. DeepSeek Harness routes a tool
call to its approval seam only when a pre-execute listener answers `ask`; its
MCP client registers the seven tools with no such listener, and when a
listener does answer `ask` under the headless runner the seam fails closed at
once — rejected, not waited on — because no answerer is composed there (read
from the source). Measured on 2026-09-10 under this launch:
`list_pending_reviews` completed, the run exited 0 after 42 s, and stderr
stayed empty. A launch waiting on an answer would not have exited and would
not be replaced; this runtime does not wait.

Review Bridge records the review's `DEEPSEEK_HARNESS` binding; it observes
nothing about how the session was started, and this section adds no
mechanism that would. The autonomous workflow continues to accept
`CODEX_TASK` dispatch only. The `CLAUDE_DESKTOP` boundary is unchanged, and
nothing above narrows it: never launch, script, or otherwise programmatically
invoke a Claude reviewer from this session — the operator opens that
conversation themselves, an account-compliance boundary rather than a
convenience.
