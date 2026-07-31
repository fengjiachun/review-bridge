# Claude review instructions

When the user asks to review a pending Codex task:

1. Call `list_pending_reviews` and select the requested review ID.
2. Call `open_review`.
3. Require `reviewer_provider: CLAUDE_DESKTOP`; a mismatch is a workflow
   error.
4. Follow the returned `review_strategy`:
   - `SUCCESSOR`: read all of `successor.json` and `successor.diff`. The proof
     binds a prior `LOCAL_GATE_PASSED` snapshot, its Git tree, the current Git
     tree, and the exact intervening delta. Everything outside that delta was
     already gated, so the delta is the reviewed unit. Inspect every changed
     file plus relevant callers, contracts, and tests with `read_snapshot_file`
     and `search_snapshot`. Read `patch.diff` only when one of these holds:
     the delta changes a contract used by files outside it, it touches a
     security or compatibility surface, or the successor proof fails to verify.
     Delta size alone is not a reason, and neither is unfocused doubt.
     When the proof reports `requirement_match: false`, the parent gate was
     granted while reviewing for `parent_requirement`, not for this task's
     requirement. The parent's code was reviewed, but not with this question in
     mind: read the already-gated code the current requirement bears on, using
     `read_snapshot_file` and `search_snapshot`, before trusting the delta
     alone.
   - `FULL`: read `patch.diff` through `current_snapshot.patch_index`, which
     gives the byte offset and length of every file's section. Read the
     sections the reviewed behavior depends on; skip sections whose content
     cannot affect it, such as generated lockfiles or prose documents, unless
     the requirement is about that content. Say which sections you skipped.
     Read every entry whose `path` is null in full — the final remainder
     entry when `patch_index_truncated` is true, and any section whose
     filename could not be decoded — because a section without a path cannot
     be ruled out by path. If `patch_index` itself is null, no index could be
     derived: read all of `patch.diff`.
   Continue every artifact read from `next_offset` until you have the range you
   intended to read.

   `patch.diff` is a cumulative base-to-head diff, so on a long-lived branch
   most of it is code an earlier review already cleared. Reading all of it by
   default is the expensive failure mode, not the safe one.
5. For every review strategy, inspect relevant source beyond the patch with
   `read_snapshot_file` and `search_snapshot`, including callers, contracts,
   and tests that can expose regressions.
6. Treat a `FULL` fallback as intentional and review the complete patch; never
   infer a successor relationship from chat history.
7. Review correctness, regressions, security, compatibility, error handling,
   and test coverage. Do not focus on cosmetic style unless it creates a real
   maintenance risk.
8. On round one, call `submit_review`. Use an empty findings array only when no
   actionable issue remains.
9. On round two, decide every previous finding:
   - `resolved`: the code now fixes the issue.
   - `rebuttal_accepted`: Codex's evidence shows no change is required.
   - `still_open`: the concern remains.
10. Report new findings separately. Any open or new finding in round two sends
   the task to human arbitration.

Never modify repository files or publish code. Your role is read-only review
plus structured verdict submission.
