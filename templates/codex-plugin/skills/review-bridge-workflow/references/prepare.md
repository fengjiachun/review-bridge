## Prepare

Load only the selected provider when step 9 reaches dispatch:
[CODEX_TASK](codex-task.md), [HERMES](hermes.md),
[DEEPSEEK_HARNESS](deepseek-harness.md), or [CLAUDE_DESKTOP](claude-desktop.md).
After a verdict, load [Handle findings](findings.md) for findings or
[Finish](finish.md) for CLEAN or HUMAN_REQUIRED.

1. Confirm the repository path and choose the exact base ref. Resolve it to an
   immutable commit SHA before creating or committing publication changes, and
   pass that SHA to `prepare_review`. Do not silently guess between `HEAD`,
   `origin/main`, or another release branch.
2. Summarize the user's requirement faithfully.
3. State the implementation scope, changed behavior, and verification evidence.
4. If the user intends to publish the change, create a topic branch and commit
   the intended diff before review. Before each commit, remove comments that
   do not state a constraint the code cannot express and remove tests that no
   behavior change can turn red. Commit later fixes before rereview. This
   lets the local gate attest the exact commit that will become the PR head.
5. Leave `parent_review_id` unset unless you have a specific parent in mind.
   The server then selects one itself, considering only tasks that are already
   `LOCAL_GATE_PASSED` for the same repository and immutable base SHA and whose
   gated head is a strict ancestor of the head being captured; each candidate
   still has to pass the full successor proof. It prefers a parent gated for
   the same requirement, and when none exists it records the parent's
   requirement and `requirement_match: false` in the proof so the reviewer
   knows the gate was granted while reviewing for different work. Naming a
   parent explicitly still requires the requirement to match exactly, because
   there a mismatch means you picked the wrong parent. The
   result reports `review_strategy.parent_selection` as `AUTOMATIC`,
   `EXPLICIT`, or `NONE`. Pass `parent_review_id` to pin a specific parent.
   A verified `SUCCESSOR` is the default and stands: on a long-lived branch its
   delta is a small fraction of the cumulative patch, and re-reviewing
   already-gated code costs the reviewer far more context than it buys.
   `force_full_review: true` is the deliberate exception, and two scenarios
   name it. A continuation from `CONTINUABLE_FINDINGS` passes it beside
   `continued_from_review_id`, which the server requires. An advisory panel
   over an external pull request passes it because the reviewed unit is that
   whole pull request and this store's own gates are no parent for it. Outside
   those two, demanding a full patch buys a re-review of gated code, so state
   the reason in the session before passing it.
6. Choose `reviewer_provider` explicitly:
   - `CLAUDE_DESKTOP` for a fresh Claude Desktop conversation.
   - `CODEX_TASK` for a newly created Codex task that is not a fork of the
     author task and has no authoring history for the change.
   - `HERMES` for a fresh, independent Hermes reviewer context using the
     packaged Hermes reviewer profile.
   - `DEEPSEEK_HARNESS` for a fresh DeepSeek Harness session using the
     packaged DeepSeek Harness reviewer profile.

   For publish-bound work — any change that will go on to a publication
   ledger — the local gate's provider is `CODEX_TASK` by default rather than a
   per-review choice. The publication-side Codex pass reads the same code the
   local gate already passed, and what it finds there costs a full remote round
   to repair; the same defect found at the local gate costs one local round.
   `DEEPSEEK_HARNESS` is the verification-shape second opinion beside that
   gate — pins that match a substring, fixtures that do not cover the case, a
   refusal test passing on a neighbour's message — which is the local
   counterpart of the [advisory panel](advisory-panel.md). Run it in addition to the
   `CODEX_TASK` gate when the risk in a change is how it is verified; never as
   the sole gate on a publication path.

   Never call reviewer tools from the author task; provider binding and task
   separation are workflow attestations, not authenticated model identity.
7. Call `prepare_review` with the base SHA captured in step 1, the selected
   provider, and the optional verified parent from step 5.
8. Call `get_review_summary`, record its `state_version`, and report the
   returned `review_id`, `reviewer_provider`, `review_strategy`, and state
   `WAITING_FOR_REVIEW`. Also report `current_snapshot.change_size`: manual
   review continues even when `over_budget` is true, because the operator is
   already present to decide whether the change should be split. When
   `warning_threshold_crossed` is true, state the total and
   `remaining_headroom` and say whether the change will continue or split.
9. Start a fresh reviewer context for every new `review_id`. For
   `CLAUDE_DESKTOP`, use a fresh Claude conversation. For `CODEX_TASK`, create
   a new Codex task rather than forking this task, and send it only the review
   ID and a request to follow the packaged reviewer skill; to launch that task
   from this session's shell, follow [Dispatching a CODEX_TASK review](codex-task.md). For
   `HERMES`, start
   a fresh, independent Hermes reviewer context in the packaged Hermes reviewer
   profile, and send it only the review ID and a request to follow the packaged
   reviewer skill; to launch that context from this session's shell, follow
   [Dispatching a HERMES review](hermes.md). For `DEEPSEEK_HARNESS`, start a fresh
   session in the packaged DeepSeek Harness reviewer profile on the same terms;
   to launch it from this session's shell, follow [Dispatching a
   DEEPSEEK_HARNESS review](deepseek-harness.md). A round-two rereview of the same ID may stay
   in that reviewer context where the provider allows it, and is otherwise a
   fresh context deciding from the ledger — the reviewer skill requires the
   same evidence either way.
10. Require the reviewer to follow the returned strategy. For `SUCCESSOR`, it
    must read `successor.json` and all of `successor.diff` and inspect changed
    files plus relevant callers, contracts, and tests; it expands to
    `patch.diff` only for a cross-file contract change, a security or
    compatibility surface, or a proof that fails to verify. For `FULL`, it
    reads `patch.diff` through `current_snapshot.patch_index` and reports which
    sections it skipped.
11. Use `wait_for_review_state` with the recorded `state_version` to observe the
   transition without repeatedly loading the full ledger. It waits 25 seconds
   by default and accepts at most 30 seconds. A `timed_out` result is expected
   while a human-paced review remains in progress; call it again with the same
   `state_version` until `changed` is true, or report the returned summary and
   resume when the user confirms the review is complete.

In local-review mode, do not push or open a pull request while the task is
waiting for its reviewer.
