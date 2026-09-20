# Search historical findings

The Codex plugin includes a read-only `scripts/review-findings.mjs` CLI. Run it
with Node from the installed plugin directory:

```bash
node scripts/review-findings.mjs --keyword 'snapshot'
node scripts/review-findings.mjs --repository '/absolute/historical/worktree' --file 'src/writer' --severity major
node scripts/review-findings.mjs --disposition rejected --decision rebuttal_accepted --json
node scripts/review-findings.mjs --decision missing --limit 50 --store /tmp/review-fixtures
```

`--store` overrides `REVIEW_BRIDGE_HOME`. Without either, the command uses the
same default store as the servers. It never creates a store, index, report,
lock, or model request, and does not change ledger or gate state.

## Filters and limits

All supplied filters combine with AND. Each option accepts one value and may
appear once. Unknown options, empty values, invalid enum values, and invalid
limits fail before reading the store.

| Option | Meaning |
| --- | --- |
| `--repository <path>` | Exact, case-sensitive match of the ledger's persisted `repository_path` string. |
| `--file <text>` | Case-sensitive literal substring of the finding's path. |
| `--keyword <text>` | Case-insensitive literal substring of title, explanation, recommendation, author rationale/evidence, or rereview rationale/verification. |
| `--severity <value>` | `blocker`, `major`, `minor`, `nit`. |
| `--disposition <value>` | `fixed`, `rejected`, `human_required`, or `missing` for no author response. |
| `--decision <value>` | `resolved`, `rebuttal_accepted`, `still_open`, or `missing` for no rereview decision. |
| `--limit <n>` | Integer from 1 to 1000; default 20. |
| `--json` | Full records and diagnostics instead of abbreviated readable text. |

Repository filtering does not resolve paths, inspect Git, or require a worktree
to exist. Supply the path exactly as recorded, including its spelling and any
trailing separator. Worktrees with the same basename remain separate. File and
keyword filters are literal strings, not globs or regular expressions.

Results sort by review ID, introduced round, and finding ID, all ascending
(strings use code-unit order). The printed total counts all matches before
truncation. JSON includes `total_matches`, `limit`, `truncated`, and `filters`.
The scan is in memory and does not create a persistent index.

## Reading the evidence

Each result contains `review_id`, `finding_id`, `introduced_round`, the full
`finding`, and `snapshot` with round, head SHA, and snapshot hash. That snapshot
is selected by `introduced_round`; a later head never replaces the original
finding head. Snapshot hashes matter when captured worktree changes differ
from the committed head.

`author_resolution` preserves the recorded disposition, rationale, evidence,
and timestamp. `response_round` comes from the author response/escalation
history event. Its `head_sha` is always null: a response does not capture the
fixed code. `rereview_decision` preserves the reviewer record and separately
identifies the decision's round and snapshot from the rereview verdict history
event. If those events are absent in a historical ledger, the round/snapshot
is null and text says `not recorded`. Missing response or decision objects are
null and text says `missing`.

`evidence.ledger_path` is the absolute path to the original `review.json`;
`evidence.finding_pointer` is a JSON pointer such as `/findings/0`. The readable
format joins them as `…/review.json#/findings/0`. Use `--json` to inspect full
finding and response text; readable excerpts are abbreviated.

Only entries in `review.findings` produce result rows. `continuation_sources`
lists the review's carried references with original review/finding IDs and
ledger paths. These are review-level context, not proof that the current
finding matches a source finding. The source ledger is searched independently
if it exists. A continuation with only carried references adds no matches.
`continued_by_review_id` preserves the recorded forward continuation link.

These are historical evidence to recheck against the current change.
`rebuttal_accepted` is a protocol conclusion, not a false-positive label or
automatic exemption from future review.

## Missing and damaged records

The query uses the core ledger reader and validates fields needed for filtering
and evidence associations. It does not replay the state machine, verify
snapshot artifacts, or attest publication/gate state. Each ledger is read
independently; a scan is not an atomic snapshot of a changing store.

Directories without `review.json`, including remote authorization-only
directories, are counted under `corpus.directories_without_review`. They are
not errors. An absent store returns zero matches without creating directories.

Unreadable JSON, invalid query fields, duplicate IDs, dangling responses, and
missing or ambiguous snapshot associations cause that ledger to be skipped
whole. `skipped` includes its ID, absolute path, and reason. Diagnostics cover
the entire scan even when filters or a limit restrict returned findings.
`corpus.reviews_scanned` counts successfully read and validated review ledgers.

Exit status is 0 for a complete scan, 1 for skipped ledgers or a store read
failure, and 2 for invalid arguments. A scan with skipped ledgers still emits
its partial results and all diagnostics; do not treat its total as a complete
historical count.
