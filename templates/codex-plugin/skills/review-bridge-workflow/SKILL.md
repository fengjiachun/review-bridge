---
name: review-bridge-workflow
description: Use when preparing local code for Claude Desktop review, handling Claude findings, or deciding whether the local review gate is clean before publishing.
---

# Review Bridge workflow

Use the Review Bridge author tools to coordinate a manual, two-round review with
Claude Desktop.

## Prepare

1. Confirm the repository path and choose the exact base ref. Do not silently
   guess between `HEAD`, `origin/main`, or another release branch.
2. Summarize the user's requirement faithfully.
3. State the implementation scope, changed behavior, and verification evidence.
4. Call `prepare_review`.
5. Report the returned `review_id` and state `WAITING_FOR_REVIEW`. Ask the user
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
