## Finish

Only if publication is authorized, continue to [Publish through GitHub](publication.md).

- If the reviewer returns `CLEAN`, call `finalize_local_gate`.
- Finalization must fail if the working tree changed after the clean
  verdict.
- Treat `LOCAL_GATE_PASSED` as permission to continue the user's publication
  workflow, not as permission by itself to push or create a pull request.
- Once `LOCAL_GATE_PASSED` is recorded, call `render_review_report` with the
  `review_id` and print the returned path. If `command -v plannotator` finds
  Plannotator on PATH, run `plannotator annotate <path>` so the operator can
  read the report there; otherwise the printed path is the whole step.
  Annotations never flow back into the ledger: whatever the reader decides
  goes through the ordinary tools. The report is a projection of the ledger,
  not evidence, and a failure in this step changes no gate and no workflow
  state.
- If the state is `HUMAN_REQUIRED`, call `get_review_summary`, then call
  `export_human_arbitration` with its exact `state_version`. Give the returned
  Markdown to the human or externally coordinated reviewer. The export is
  read-only and does not authorize publication. Do not start a third model
  round.

The review ledger, not free-form chat text, is the source of truth.
