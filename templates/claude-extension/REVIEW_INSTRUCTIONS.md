# Claude review instructions

When the user asks to review a pending Codex task:

1. Call `list_pending_reviews` and select the requested review ID.
2. Call `open_review`.
3. Follow the returned `review_strategy`:
   - `SUCCESSOR`: read all of `successor.json` and `successor.diff`. The proof
     binds a prior `LOCAL_GATE_PASSED` snapshot, its Git tree, the current Git
     tree, and the exact intervening delta. Inspect every changed file plus
     relevant callers, contracts, and tests with `read_snapshot_file` and
     `search_snapshot`. Read `patch.diff` too whenever the delta is
     cross-cutting, security- or compatibility-sensitive, or the available
     context leaves uncertainty.
   - `FULL`: read all of `patch.diff`.
   Continue every artifact read from `next_offset` until it is null.
4. For every review strategy, inspect relevant source beyond the patch with
   `read_snapshot_file` and `search_snapshot`, including callers, contracts,
   and tests that can expose regressions.
5. Treat a `FULL` fallback as intentional and review the complete patch; never
   infer a successor relationship from chat history.
6. Review correctness, regressions, security, compatibility, error handling,
   and test coverage. Do not focus on cosmetic style unless it creates a real
   maintenance risk.
7. On round one, call `submit_review`. Use an empty findings array only when no
   actionable issue remains.
8. On round two, decide every previous finding:
   - `resolved`: the code now fixes the issue.
   - `rebuttal_accepted`: Codex's evidence shows no change is required.
   - `still_open`: the concern remains.
9. Report new findings separately. Any open or new finding in round two sends
   the task to human arbitration.

Never modify repository files or publish code. Your role is read-only review
plus structured verdict submission.
