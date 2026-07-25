---
name: review-bridge-workflow
description: Use when preparing local code for Claude Desktop review, handling Claude findings, or publishing reviewed code through GitHub.
---

# Review Bridge workflow

Use the Review Bridge author tools to coordinate a manual, two-round review with
Claude Desktop.

## Prepare

1. Confirm the repository path and choose the exact base ref. Resolve it to an
   immutable commit SHA before creating or committing publication changes, and
   pass that SHA to `prepare_review`. Do not silently guess between `HEAD`,
   `origin/main`, or another release branch.
2. Summarize the user's requirement faithfully.
3. State the implementation scope, changed behavior, and verification evidence.
4. If the user intends to publish the change, create a topic branch and commit
   the intended diff before review. Commit later fixes before rereview. This
   lets the local gate attest the exact commit that will become the PR head.
5. Call `prepare_review` with the base SHA captured in step 1.
6. Report the returned `review_id` and state `WAITING_FOR_REVIEW`. Ask the user
   to open Claude Desktop and review that ID.

Do not push or open a pull request while the task is waiting for Claude.

## Handle findings

1. Call `get_review`.
2. Address every open finding. For each finding choose exactly one:
   - `fixed`: change the code and verify the fix.
   - `rejected`: provide concrete technical evidence.
   - `human_required`: stop and request human arbitration.
3. Call `submit_resolutions` with one entry for every finding.
4. If the state is `AUTHOR_RESPONDED`, call `prepare_rereview`.
5. Report `WAITING_FOR_REREVIEW` and ask the user to invoke Claude Desktop
   again.

Keep fixes surgical. Do not mark a finding fixed without verification evidence.

## Finish

- If Claude returns `CLEAN`, call `finalize_local_gate`.
- Finalization must fail if the working tree changed after Claude's clean
  verdict.
- Treat `LOCAL_GATE_PASSED` as permission to continue the user's publication
  workflow, not as permission by itself to push or create a pull request.
- If the state is `HUMAN_REQUIRED`, stop. Do not start a third model round.

The review ledger, not free-form chat text, is the source of truth.

## Publish through GitHub

After `LOCAL_GATE_PASSED`:

1. Confirm the working tree is clean and compare `git rev-parse HEAD` with the
   `head_sha` returned by `finalize_local_gate`. If they differ, the local gate
   is invalid; start a new local Review Bridge task. Otherwise push the reviewed
   topic branch and open a draft pull request.
2. Require the PR head commit to equal that same local-gate `head_sha`. If it
   differs, stop and start a new local Review Bridge task. Record the matching
   PR head, wait for required checks to pass, and mark the PR ready for review.
3. Read the PR head again, post one PR comment containing exactly
   `@codex review`, and record the exact request comment ID, URL, creation time,
   and requested head. Do not rely on automatic review being enabled and do not
   post another exact request for that head while this one is pending.
4. Inspect all supported Codex result resources after the request. A completed
   result may be an issue comment, pull-request review, or pull-request review
   comment; do not require a pull-request review object. Require the configured
   Codex GitHub App's stable actor ID and `Bot` type rather than trusting a
   mutable login alone.
5. A result must explicitly report either actionable findings or the known
   clean outcome, carry a reviewed-commit binding that uniquely matches the
   requested full head, and be attributable to the recorded request. The
   standard clean issue-comment form includes
   `Codex Review: Didn't find any major issues.` and `Reviewed commit:`.
   An eyes reaction is pending, never a pass. A removed reaction, silence, an
   unbound result, or an ambiguous result also remains pending and must not
   authorize merge.
6. After a completed result, read all unresolved review threads, required
   checks, and the PR head again. The completed result, local gate, and checks
   must apply to the same current head, and no unresolved actionable thread may
   remain.
7. If Codex reports an actionable finding, make and commit the fix, run the
   relevant checks, and start a new local Review Bridge task. After its local
   gate passes, push the new commit and request `@codex review` again.
8. Merge only when the local gate, required checks, and completed GitHub Codex
   review all apply to the current PR head and no actionable finding remains.

Any new commit invalidates the GitHub review gate. Compare the reviewed PR head
before merge; a squash merge naturally creates a different merge commit.

The Review Bridge MCP server does not receive GitHub credentials. The Codex
skill orchestrates the repository's configured GitHub tools after the local
gate passes.
