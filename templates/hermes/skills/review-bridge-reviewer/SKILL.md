---
name: review-bridge-reviewer
description: Use in a fresh Hermes reviewer profile to independently review a pending Review Bridge task bound to HERMES.
---

# Review Bridge reviewer (Hermes)

Use only in a fresh Hermes reviewer context with no authoring history for the
change under review. The reviewer context must not be a fork of the author
task or profile. If this context wrote or fixed the reviewed change, stop and
ask the user to create a fresh Hermes reviewer profile.

This skill is owned by Review Bridge. It is distributed with the packaged
build and is not a patch to Hermes bundled skills.

## Review

1. Use only these seven reviewer-scoped tools: `list_pending_reviews`,
   `open_review`, `read_review_artifact`, `read_snapshot_file`,
   `search_snapshot`, `submit_review`, and `submit_rereview`. The list and read
   tools inspect immutable review state; the two submit tools update the review
   ledger. None has author or publication side effects. If any other Review
   Bridge tool is available, stop because the profile is not isolated. Do not
   modify repository files, run publication actions, push code, or open a pull
   request.
2. Call `list_pending_reviews` and select the exact requested `review_id`.
3. Call `open_review`. Require `reviewer_provider: HERMES`; a mismatch is a
   workflow error.
4. Follow `review_strategy`:
   - `SUCCESSOR`: read all of `successor.json` and `successor.diff`. The delta
     is the reviewed unit; everything before it was already gated. Inspect
     every changed file plus relevant callers, contracts, and tests with
     `read_snapshot_file` and `search_snapshot`. Read `patch.diff` only when
     the delta changes a contract used outside it, touches a security or
     compatibility surface, or the successor proof fails to verify. Delta size
     alone is not a reason. When the proof reports `requirement_match: false`,
     the parent gate was granted while reviewing for `parent_requirement`: read
     the already-gated code the current requirement bears on before trusting
     the delta alone.
   - `FULL`: read `patch.diff` through `current_snapshot.patch_index`, which
     gives each file's byte offset and length. Read the sections the reviewed
     behavior depends on and skip sections that cannot affect it, such as
     generated lockfiles or prose documents, unless the requirement is about
     that content. Report which sections you skipped. Read every `path: null`
     entry in full — the remainder entry when `patch_index_truncated` is true,
     and any section whose filename could not be decoded — because a section
     without a path cannot be ruled out by path. If `patch_index` itself is
     null, no index could be derived: read all of `patch.diff`.
   Continue chunked artifact reads from `next_offset` until you have the range
   you intended to read.
5. Review correctness, regressions, security, compatibility, error handling,
   and test coverage. Treat every actionable finding as blocking the clean
   verdict; do not waive lower-severity findings.
6. For round one call `submit_review`. Use an empty findings array only when no
   actionable issue remains.
7. For round two call `submit_rereview`, deciding every previous finding as
   `resolved`, `rebuttal_accepted`, or `still_open`, and report new findings
   separately. Any open or new finding escalates to human arbitration.
   Every `rebuttal_accepted` decision must include `verification`: what you ran
   or read and what you observed, such as a probe test, a mutation, a walk of
   the claimed state, or a direct read of the cited code, concrete enough that
   an auditor can replay it. Conclusions are not verification. The server
   enforces only presence and length, not whether the verification is true.
   `verification` is optional for `resolved` and `still_open` decisions.

The immutable snapshot and Review Bridge ledger are the source of truth. Do not
substitute the live working tree or inherited chat context.
