import fsp from "node:fs/promises";
import path from "node:path";
import { DEFAULT_CHANGE_SIZE_BUDGET } from "./workflow.mjs";

export const SCORECARD_SCHEMA_VERSION = 1;

const SEVERITIES = ["blocker", "major", "minor", "nit"];
const DISPOSITIONS = ["fixed", "rejected", "human_required"];
const DECISIONS = ["resolved", "rebuttal_accepted", "still_open"];
const DECISION_COLUMNS = [...DECISIONS, "undecided"];
const REVIEW_STATUSES = [
  "WAITING_FOR_REVIEW",
  "REVIEW_SUBMITTED",
  "AUTHOR_RESPONDED",
  "WAITING_FOR_REREVIEW",
  "CLEAN",
  "LOCAL_GATE_PASSED",
  "HUMAN_REQUIRED",
  "CONTINUABLE_FINDINGS",
];
const CLEAN_STATUSES = ["CLEAN", "LOCAL_GATE_PASSED"];
const HUMAN_REQUIRED_EVENTS = [
  "AUTHOR_ESCALATED",
  "ROUND_LIMIT_REACHED",
  "REREVIEW_UNRESOLVED",
];
const HUMAN_REQUIRED_REASONS = [...HUMAN_REQUIRED_EVENTS, "NOT_RECORDED"];
const WORKFLOW_STATUSES = ["ACTIVE", "PAUSED", "CANCELLED", "MERGE_READY"];
const BUDGET_PAUSE_REASONS = [
  "LOCAL_CYCLE_BUDGET_EXHAUSTED",
  "REMOTE_CYCLE_BUDGET_EXHAUSTED",
  "CHANGE_SIZE_BUDGET_EXCEEDED",
];
const BUDGET_EXTENSION_EVENTS = [
  "LOCAL_CYCLE_BUDGET_EXTENDED",
  "REMOTE_CYCLE_BUDGET_EXTENDED",
  "CHANGE_SIZE_BUDGET_EXTENDED",
];
// The obligation landed with the field, so a decision record either predates
// it and has no `verification` key at all, or postdates it and always has one.
const OBLIGATION_BUCKETS = ["before_obligation", "after_obligation"];
const OVERALL = "ALL";

function zeroCounts(keys) {
  return Object.fromEntries(keys.map((key) => [key, 0]));
}

function emptyStats() {
  return {
    reviews: 0,
    reviews_by_status: zeroCounts(REVIEW_STATUSES),
    rounds_to_clean: {},
    not_clean: 0,
    findings: 0,
    findings_by_severity: zeroCounts(SEVERITIES),
    disposition_outcomes: Object.fromEntries(
      DISPOSITIONS.map((disposition) => [
        disposition,
        zeroCounts(DECISION_COLUMNS),
      ]),
    ),
    rebuttals: Object.fromEntries(
      OBLIGATION_BUCKETS.map((bucket) => [
        bucket,
        {
          rebuttals: 0,
          sustained: 0,
          overturned: 0,
          resolved: 0,
          overturn_rate: null,
        },
      ]),
    ),
    rebuttals_pending: 0,
    continuable_findings: 0,
    continuations_started: 0,
    carried_findings: 0,
    human_required: 0,
    human_required_by_reason: zeroCounts(HUMAN_REQUIRED_REASONS),
  };
}

function emptyWorkflowStats() {
  return {
    workflows: 0,
    workflows_by_status: zeroCounts(WORKFLOW_STATUSES),
    budget_pauses: zeroCounts(BUDGET_PAUSE_REASONS),
    budget_extensions: zeroCounts(BUDGET_EXTENSION_EVENTS),
    change_size: {
      snapshots_measured: 0,
      snapshots_without_change_size: 0,
      warning_threshold_crossed: 0,
      over_budget: 0,
    },
    local_cycles: { started: 0, addressed: 0, followed_up: 0 },
    remote_attempts: { recorded: 0, counted: 0, diverted: 0 },
  };
}

// A ledger the aggregation cannot count without guessing is skipped whole,
// so a single bad record never silently distorts a column.
function reviewDefect(review) {
  if (review == null || typeof review !== "object") return "not a JSON object";
  if (typeof review.id !== "string") return "missing id";
  if (!REVIEW_STATUSES.includes(review.status)) {
    return `unknown status ${JSON.stringify(review.status)}`;
  }
  if (!Number.isInteger(review.current_round)) return "missing current_round";
  for (const key of ["findings", "resolutions", "rereview_decisions", "history"]) {
    if (!Array.isArray(review[key])) return `${key} is not an array`;
  }
  for (const finding of review.findings) {
    if (!SEVERITIES.includes(finding?.severity)) {
      return `unknown finding severity ${JSON.stringify(finding?.severity)}`;
    }
  }
  for (const resolution of review.resolutions) {
    if (!DISPOSITIONS.includes(resolution?.disposition)) {
      return `unknown disposition ${JSON.stringify(resolution?.disposition)}`;
    }
  }
  for (const decision of review.rereview_decisions) {
    if (!DECISIONS.includes(decision?.decision)) {
      return `unknown rereview decision ${JSON.stringify(decision?.decision)}`;
    }
  }
  return null;
}

function workflowDefect(workflow) {
  if (workflow == null || typeof workflow !== "object") {
    return "not a JSON object";
  }
  if (typeof workflow.workflow_id !== "string") return "missing workflow_id";
  if (!WORKFLOW_STATUSES.includes(workflow.status)) {
    return `unknown status ${JSON.stringify(workflow.status)}`;
  }
  for (const key of ["local_review_cycles", "remote_attempts"]) {
    if (workflow[key] != null && !Array.isArray(workflow[key])) {
      return `${key} is not an array`;
    }
  }
  return null;
}

function humanRequiredReason(review) {
  const event = [...review.history]
    .reverse()
    .find((entry) => HUMAN_REQUIRED_EVENTS.includes(entry?.event));
  return event?.event ?? "NOT_RECORDED";
}

function countReview(stats, review) {
  stats.reviews += 1;
  stats.reviews_by_status[review.status] += 1;
  if (CLEAN_STATUSES.includes(review.status)) {
    const round = String(review.current_round);
    stats.rounds_to_clean[round] = (stats.rounds_to_clean[round] ?? 0) + 1;
  } else {
    stats.not_clean += 1;
  }
  if (review.status === "CONTINUABLE_FINDINGS") {
    stats.continuable_findings += 1;
  }
  if (review.status === "HUMAN_REQUIRED") {
    stats.human_required += 1;
    stats.human_required_by_reason[humanRequiredReason(review)] += 1;
  }
  const carried = review.carried_findings ?? [];
  if (carried.length > 0) {
    stats.continuations_started += 1;
    stats.carried_findings += carried.length;
  }

  const resolutionByFinding = new Map(
    review.resolutions.map((resolution) => [resolution.finding_id, resolution]),
  );
  const decisionByFinding = new Map(
    review.rereview_decisions.map((decision) => [decision.finding_id, decision]),
  );
  for (const finding of review.findings) {
    stats.findings += 1;
    stats.findings_by_severity[finding.severity] += 1;
    const resolution = resolutionByFinding.get(finding.id);
    if (resolution == null) continue;
    const decision = decisionByFinding.get(finding.id);
    const outcome = decision?.decision ?? "undecided";
    stats.disposition_outcomes[resolution.disposition][outcome] += 1;
    if (resolution.disposition !== "rejected") continue;
    // A rebuttal the reviewer has not decided yet has no decision record, so
    // it cannot sit on either side of the obligation. It is counted here
    // instead of being dropped, which would make the buckets' denominator
    // depend on how far each review happens to have got.
    if (decision == null) {
      stats.rebuttals_pending += 1;
      continue;
    }
    const bucket =
      "verification" in decision ? "after_obligation" : "before_obligation";
    const rebuttals = stats.rebuttals[bucket];
    rebuttals.rebuttals += 1;
    if (decision.decision === "rebuttal_accepted") rebuttals.sustained += 1;
    else if (decision.decision === "still_open") rebuttals.overturned += 1;
    else rebuttals.resolved += 1;
  }
}

function finalizeRebuttals(stats) {
  for (const bucket of OBLIGATION_BUCKETS) {
    const rebuttals = stats.rebuttals[bucket];
    rebuttals.overturn_rate =
      rebuttals.rebuttals === 0
        ? null
        : Number((rebuttals.overturned / rebuttals.rebuttals).toFixed(4));
  }
}

async function readJsonLedgers(root, fileName) {
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return { records: [], skipped: [], absent: 0 };
    throw error;
  }
  const records = [];
  const skipped = [];
  // A directory holding no ledger of this kind is not a damaged ledger — a
  // remote-only publication never creates a local review — so it is counted
  // apart from the skips rather than reported as breakage.
  let absent = 0;
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const filePath = path.join(root, entry.name, fileName);
    try {
      records.push({
        id: entry.name,
        record: JSON.parse(await fsp.readFile(filePath, "utf8")),
      });
    } catch (error) {
      if (error?.code === "ENOENT") absent += 1;
      else skipped.push({ id: entry.name, reason: `unreadable: ${error.message}` });
    }
  }
  return { records, skipped, absent };
}

// Only the first `committed_bytes` of the audit log are committed; a tail
// beyond that is a torn append and is not evidence of anything.
async function readCommittedAuditEvents(directory) {
  let head;
  let raw;
  try {
    // Starting a workflow writes both artifacts, so a missing one is damage,
    // not a workflow that has yet to record anything. The server's own reader
    // fails WORKFLOW_AUDIT_CORRUPT on either.
    head = JSON.parse(
      await fsp.readFile(path.join(directory, "action-audit-head.json"), "utf8"),
    );
    raw = await fsp.readFile(path.join(directory, "action-audit.jsonl"));
  } catch (error) {
    return {
      events: [],
      reason:
        error?.code === "ENOENT"
          ? "audit artifact is missing"
          : `unreadable audit artifact: ${error.message}`,
    };
  }
  if (!Number.isInteger(head?.committed_bytes) || head.committed_bytes < 0) {
    return { events: [], reason: "audit head has no committed_bytes" };
  }
  // subarray clamps, so without this a log truncated at an earlier event
  // boundary would parse cleanly and contribute an arbitrary subset.
  if (raw.length < head.committed_bytes) {
    return { events: [], reason: "audit log is shorter than its cursor" };
  }
  const events = [];
  // committed_bytes counts bytes, so the cut is made on the buffer. Slicing the
  // decoded string would run past the boundary by one position per multi-byte
  // character and swallow part of an uncommitted append.
  const committed = raw.subarray(0, head.committed_bytes).toString("utf8");
  for (const line of committed.split("\n")) {
    if (line === "") continue;
    try {
      events.push(JSON.parse(line));
    } catch (error) {
      // A prefix of a damaged log is an arbitrary subset of the workflow's
      // pauses and extensions, so none of it is returned.
      return { events: [], reason: `unparseable audit line: ${error.message}` };
    }
  }
  return { events, reason: null };
}

function countWorkflowAudit(stats, events) {
  // A snapshot is measured against the budget in force the first time it
  // appears, so a later extension cannot retroactively erase a crossing.
  const measured = new Map();
  const unmeasurable = new Set();
  for (const event of events) {
    if (BUDGET_EXTENSION_EVENTS.includes(event?.event)) {
      stats.budget_extensions[event.event] += 1;
    }
    const state = event?.workflow_state;
    const reason = state?.pause?.reason_code;
    if (event?.event === "WORKFLOW_PAUSED" && BUDGET_PAUSE_REASONS.includes(reason)) {
      stats.budget_pauses[reason] += 1;
    }
    const review = state?.current_review;
    if (review == null) continue;
    const key = `${review.review_id}:${review.snapshot_hash}`;
    if (measured.has(key)) continue;
    const totalLines = review.change_size?.total_lines;
    // A legacy dispatch backfills the change size in a later event, so an
    // unmeasurable snapshot is provisional: it is measured from the first
    // event that carries a size, and counting it as zero meanwhile would
    // read as "no large snapshot".
    if (!Number.isInteger(totalLines)) {
      unmeasurable.add(key);
      continue;
    }
    unmeasurable.delete(key);
    measured.set(key, {
      totalLines,
      budget: state.change_size_budget ?? DEFAULT_CHANGE_SIZE_BUDGET,
    });
  }
  stats.change_size.snapshots_without_change_size += unmeasurable.size;
  for (const { totalLines, budget } of measured.values()) {
    stats.change_size.snapshots_measured += 1;
    if (totalLines >= Math.ceil(budget * 0.75)) {
      stats.change_size.warning_threshold_crossed += 1;
    }
    if (totalLines > budget) stats.change_size.over_budget += 1;
  }
}

function countWorkflow(stats, workflow) {
  stats.workflows += 1;
  stats.workflows_by_status[workflow.status] += 1;
  for (const cycle of workflow.local_review_cycles ?? []) {
    stats.local_cycles.started += 1;
    if (cycle?.addressed_head_sha != null) stats.local_cycles.addressed += 1;
    if (cycle?.followup_review_id != null) stats.local_cycles.followed_up += 1;
  }
  for (const attempt of workflow.remote_attempts ?? []) {
    stats.remote_attempts.recorded += 1;
    if (attempt?.diverted_at == null) stats.remote_attempts.counted += 1;
    else stats.remote_attempts.diverted += 1;
  }
}

export async function buildScorecard(storeRoot, { generatedAt } = {}) {
  const reviewLedgers = await readJsonLedgers(
    path.join(storeRoot, "reviews"),
    "review.json",
  );
  const providers = new Map([[OVERALL, emptyStats()]]);
  const skipped = [...reviewLedgers.skipped];
  let earliest = null;
  let latest = null;
  for (const { id, record } of reviewLedgers.records) {
    const defect = reviewDefect(record);
    if (defect != null) {
      skipped.push({ id, reason: defect });
      continue;
    }
    const provider = record.reviewer_provider ?? "CLAUDE_DESKTOP";
    if (!providers.has(provider)) providers.set(provider, emptyStats());
    countReview(providers.get(provider), record);
    countReview(providers.get(OVERALL), record);
    if (typeof record.created_at === "string") {
      if (earliest == null || record.created_at < earliest) {
        earliest = record.created_at;
      }
      if (latest == null || record.created_at > latest) latest = record.created_at;
    }
  }
  for (const stats of providers.values()) finalizeRebuttals(stats);

  const workflowsRoot = path.join(storeRoot, "workflows");
  const workflowLedgers = await readJsonLedgers(workflowsRoot, "workflow.json");
  const workflows = emptyWorkflowStats();
  const skippedWorkflows = [...workflowLedgers.skipped];
  const skippedAuditLogs = [];
  for (const { id, record } of workflowLedgers.records) {
    const defect = workflowDefect(record);
    if (defect != null) {
      skippedWorkflows.push({ id, reason: defect });
      continue;
    }
    countWorkflow(workflows, record);
    // The audit log is a separate artifact from the workflow ledger: a damaged
    // one contributes no events at all rather than an arbitrary prefix, but it
    // does not disqualify the ledger that parsed.
    const audit = await readCommittedAuditEvents(path.join(workflowsRoot, id));
    if (audit.reason != null) skippedAuditLogs.push({ id, reason: audit.reason });
    countWorkflowAudit(workflows, audit.events);
  }

  return {
    schema_version: SCORECARD_SCHEMA_VERSION,
    generated_at: generatedAt ?? new Date().toISOString(),
    store_root: storeRoot,
    corpus: {
      reviews_counted: providers.get(OVERALL).reviews,
      reviews_skipped: skipped.length,
      review_directories_without_ledger: reviewLedgers.absent,
      workflows_counted: workflows.workflows,
      workflows_skipped: skippedWorkflows.length,
      workflow_directories_without_ledger: workflowLedgers.absent,
      audit_logs_skipped: skippedAuditLogs.length,
      earliest_review_created_at: earliest,
      latest_review_created_at: latest,
    },
    providers: Object.fromEntries(
      [...providers].sort(([a], [b]) => a.localeCompare(b)),
    ),
    workflows,
    skipped,
    skipped_workflows: skippedWorkflows,
    skipped_audit_logs: skippedAuditLogs,
  };
}

function table(headers, rows) {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function percent(rate) {
  return rate == null ? "n/a" : `${(rate * 100).toFixed(1)}%`;
}

function pendingRebuttals(scorecard) {
  const pending = Object.entries(scorecard.providers).filter(
    ([provider, stats]) => provider !== OVERALL && stats.rebuttals_pending > 0,
  );
  return pending.length === 0
    ? "Every rebuttal in the corpus has a reviewer decision."
    : `Awaiting a reviewer decision and therefore in neither bucket: ${pending
        .map(([provider, stats]) => `${provider} ${stats.rebuttals_pending}`)
        .join(", ")}.`;
}

// The obligation arrived on a date, but providers were added on other dates.
// Where no single provider spans both buckets, the difference between them is
// not a before-and-after for one reviewer, and the report has to say so.
function obligationComparability(scorecard) {
  const spanning = Object.keys(scorecard.providers).filter(
    (provider) =>
      provider !== OVERALL &&
      OBLIGATION_BUCKETS.every(
        (bucket) => scorecard.providers[provider].rebuttals[bucket].rebuttals > 0,
      ),
  );
  return spanning.length === 0
    ? "No provider has rebuttals on both sides of the obligation, so the gap between the two buckets carries whatever else changed with the provider mix. Read it as a description, not as the obligation's effect."
    : `${spanning.join(", ")} has rebuttals on both sides of the obligation, so the per-provider rows there compare one reviewer with itself.`;
}

function providerRows(scorecard, build) {
  return Object.entries(scorecard.providers).flatMap(([provider, stats]) =>
    build(provider, stats),
  );
}

const COUNTING_RULES = [
  "Reviews are read from `<store>/reviews/*/review.json` and workflows from",
  "`<store>/workflows/*/workflow.json`. Nothing is written.",
  "",
  "- A review is attributed to `reviewer_provider`; a ledger written before that",
  "  field existed counts as `CLAUDE_DESKTOP`, which is the server's own default.",
  "- The corpus window is the span of review `created_at`. No review is excluded",
  "  by time, and `ALL` is every counted review, not a sum of listed providers.",
  "- Rounds-to-CLEAN counts `current_round` for reviews whose status is `CLEAN`",
  "  or `LOCAL_GATE_PASSED`. Every other review counts as not clean.",
  "- A finding's outcome is the author's disposition crossed with the reviewer's",
  "  round-two decision; `undecided` means no round-two decision was recorded.",
  "- A **rebuttal** is a finding the author dispositioned `rejected`. It is",
  "  **sustained** when the reviewer decided `rebuttal_accepted`, **overturned**",
  "  when the reviewer decided `still_open`, and counted under `resolved` when",
  "  the reviewer decided `resolved`. Overturn rate is overturned / rebuttals.",
  "- The buckets below count only rebuttals the reviewer has already decided. A",
  "  rebuttal still awaiting a decision has no decision record and so cannot sit",
  "  on either side of the obligation; it is counted separately under the table",
  "  rather than dropped, which would tie the denominator to how far each review",
  "  happens to have got.",
  "- The verification obligation is bucketed by field presence, not by date: a",
  "  decision record written before it has no `verification` key at all, and",
  "  every record written after it has one, empty when the decision did not",
  "  require it. No cutoff timestamp is involved.",
  "- Size-warning crossings are not persisted; they are recomputed as",
  "  `total_lines >= ceil(change_size_budget * 0.75)` over each distinct review",
  "  snapshot in a workflow's committed audit log, against the budget in force",
  "  the first event that records a size for it — a legacy dispatch backfills",
  "  that size later, and the backfilled value counts. Over-budget snapshots are",
  "  counted in the warning row too, matching `changeSizeReport`.",
  "- Budget exhaustions count `WORKFLOW_PAUSED` audit events by",
  "  `workflow_state.pause.reason_code`; extensions count the `*_BUDGET_EXTENDED`",
  "  audit events. Workflows are dispatched to `CODEX_TASK` by construction, so",
  "  workflow numbers are not split by provider.",
  "- Audit logs are read only up to `action-audit-head.json`'s `committed_bytes`,",
  "  measured in bytes, so an uncommitted append never reaches the counts. The",
  "  hash chain is not verified here. An audit log that does not parse",
  "  contributes no events at all rather than a prefix, and is listed under",
  "  Skipped; the workflow ledger beside it still counts.",
  "- A ledger that does not parse, or does not match the shape above, is listed",
  "  under Skipped and left untouched. A directory holding no ledger of its kind",
  "  is counted separately: a remote-only publication never creates a local",
  "  review, so its directory is expected to have none.",
].join("\n");

export function renderScorecardMarkdown(scorecard) {
  const { corpus, workflows } = scorecard;
  const sections = [
    "# Review Bridge scorecard",
    `Generated ${scorecard.generated_at} from \`${scorecard.store_root}\`. Read-only: this report never writes to the store.`,
    "## Counting rules",
    COUNTING_RULES,
    "## Corpus",
    table(
      ["Ledger", "Counted", "Skipped", "Directories with no ledger"],
      [
        [
          "Reviews",
          corpus.reviews_counted,
          corpus.reviews_skipped,
          corpus.review_directories_without_ledger,
        ],
        [
          "Workflows",
          corpus.workflows_counted,
          corpus.workflows_skipped,
          corpus.workflow_directories_without_ledger,
        ],
      ],
    ),
    `Audit logs skipped: ${corpus.audit_logs_skipped}.`,
    `Review \`created_at\` spans ${corpus.earliest_review_created_at ?? "n/a"} to ${corpus.latest_review_created_at ?? "n/a"}.`,
    "## Review outcomes",
    table(
      [
        "Provider",
        "Reviews",
        "Clean",
        "Clean in round 1",
        "Clean in round 2",
        "Human required",
        "Continuable",
        "In flight",
      ],
      providerRows(scorecard, (provider, stats) => {
        const clean = CLEAN_STATUSES.reduce(
          (total, status) => total + stats.reviews_by_status[status],
          0,
        );
        return [
          [
            provider,
            stats.reviews,
            clean,
            stats.rounds_to_clean["1"] ?? 0,
            stats.rounds_to_clean["2"] ?? 0,
            stats.human_required,
            stats.continuable_findings,
            stats.reviews - clean - stats.human_required - stats.continuable_findings,
          ],
        ];
      }),
    ),
    "## Findings by severity",
    table(
      ["Provider", "Findings", ...SEVERITIES],
      providerRows(scorecard, (provider, stats) => [
        [
          provider,
          stats.findings,
          ...SEVERITIES.map((severity) => stats.findings_by_severity[severity]),
        ],
      ]),
    ),
    "## Disposition outcomes",
    table(
      ["Provider", "Disposition", ...DECISION_COLUMNS],
      providerRows(scorecard, (provider, stats) =>
        DISPOSITIONS.map((disposition) => [
          provider,
          disposition,
          ...DECISION_COLUMNS.map(
            (column) => stats.disposition_outcomes[disposition][column],
          ),
        ]).filter((row) =>
          row.slice(2).some((count) => count > 0),
        ),
      ),
    ),
    "## Rebuttals before and after the verification obligation",
    table(
      [
        "Provider",
        "Bucket",
        "Rebuttals",
        "Sustained",
        "Overturned",
        "Resolved",
        "Overturn rate",
      ],
      providerRows(scorecard, (provider, stats) =>
        OBLIGATION_BUCKETS.map((bucket) => [
          provider,
          bucket,
          stats.rebuttals[bucket].rebuttals,
          stats.rebuttals[bucket].sustained,
          stats.rebuttals[bucket].overturned,
          stats.rebuttals[bucket].resolved,
          percent(stats.rebuttals[bucket].overturn_rate),
        ]).filter((row) => row[2] > 0),
      ),
    ),
    pendingRebuttals(scorecard),
    obligationComparability(scorecard),
    "## Local review continuations",
    table(
      [
        "Provider",
        "Ended continuable",
        "Started as continuation",
        "Findings carried in",
      ],
      providerRows(scorecard, (provider, stats) => [
        [
          provider,
          stats.continuable_findings,
          stats.continuations_started,
          stats.carried_findings,
        ],
      ]),
    ),
    "## Human arbitration escalations",
    table(
      ["Provider", "Human required", ...HUMAN_REQUIRED_REASONS],
      providerRows(scorecard, (provider, stats) => [
        [
          provider,
          stats.human_required,
          ...HUMAN_REQUIRED_REASONS.map(
            (reason) => stats.human_required_by_reason[reason],
          ),
        ],
      ]),
    ),
    "The recorded reason is the escalating ledger event. The prose behind it stays in the ledger; `export_human_arbitration` renders one review's packet.",
    "## Workflow budgets and repair cycles",
    table(
      ["Metric", "Count"],
      [
        ["Workflows", workflows.workflows],
        ...WORKFLOW_STATUSES.map((status) => [
          `Status ${status}`,
          workflows.workflows_by_status[status],
        ]),
        ...BUDGET_PAUSE_REASONS.map((reason) => [
          `Paused: ${reason}`,
          workflows.budget_pauses[reason],
        ]),
        ...BUDGET_EXTENSION_EVENTS.map((event) => [
          `Extended: ${event}`,
          workflows.budget_extensions[event],
        ]),
        ["Snapshots measured", workflows.change_size.snapshots_measured],
        [
          "Snapshots with no recorded change size",
          workflows.change_size.snapshots_without_change_size,
        ],
        [
          "Crossed the size warning",
          workflows.change_size.warning_threshold_crossed,
        ],
        ["Over the size budget", workflows.change_size.over_budget],
        ["Local repair cycles started", workflows.local_cycles.started],
        ["Local repair cycles addressed", workflows.local_cycles.addressed],
        ["Local repair cycles followed up", workflows.local_cycles.followed_up],
        ["Remote repair attempts recorded", workflows.remote_attempts.recorded],
        ["Remote repair attempts counted", workflows.remote_attempts.counted],
        ["Remote repair attempts diverted", workflows.remote_attempts.diverted],
      ],
    ),
  ];
  const skippedRows = [
    ...scorecard.skipped.map(({ id, reason }) => [`reviews/${id}`, reason]),
    ...scorecard.skipped_workflows.map(({ id, reason }) => [
      `workflows/${id}`,
      reason,
    ]),
    ...scorecard.skipped_audit_logs.map(({ id, reason }) => [
      `workflows/${id}/action-audit.jsonl`,
      reason,
    ]),
  ];
  if (skippedRows.length > 0) {
    sections.push("## Skipped", table(["Ledger", "Reason"], skippedRows));
  }
  return `${sections.join("\n\n")}\n`;
}
