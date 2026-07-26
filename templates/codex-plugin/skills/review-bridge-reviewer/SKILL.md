---
name: review-bridge-reviewer
description: Use in a fresh Codex task to independently review a pending Review Bridge task bound to CODEX_TASK.
---

# Review Bridge reviewer

Use only in a newly created Codex task with no authoring history for the change
under review. The reviewer task must not be a fork of the author task. If this
task wrote or fixed the reviewed change, stop and ask the user to create a fresh
reviewer task.

## Review

1. Use only the Review Bridge reviewer tools. Do not call author tools, modify
   repository files, run publication actions, push code, or open a pull request.
2. Call `list_pending_reviews` and select the exact requested `review_id`.
3. Call `open_review`. Require `reviewer_provider: CODEX_TASK`; a mismatch is a
   workflow error.
4. Follow `review_strategy`:
   - `SUCCESSOR`: read all of `successor.json` and `successor.diff`. Inspect
     every changed file plus relevant callers, contracts, and tests with
     `read_snapshot_file` and `search_snapshot`. Read all of `patch.diff` when
     the delta is cross-cutting, security- or compatibility-sensitive, or any
     uncertainty remains.
   - `FULL`: read all of `patch.diff`.
   Continue chunked artifact reads from `next_offset` until it is null.
5. Review correctness, regressions, security, compatibility, error handling,
   and test coverage. Treat every actionable finding as blocking the clean
   verdict; do not waive lower-severity findings.
6. For round one call `submit_review`. Use an empty findings array only when no
   actionable issue remains.
7. For round two call `submit_rereview`, deciding every previous finding as
   `resolved`, `rebuttal_accepted`, or `still_open`, and report new findings
   separately. Any open or new finding escalates to human arbitration.

The immutable snapshot and Review Bridge ledger are the source of truth. Do not
substitute the live working tree or inherited chat context.
