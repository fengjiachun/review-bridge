import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  prepareRereview,
  prepareReview,
  submitInitialReview,
  submitRereview,
  submitResolutions,
} from "../src/core.mjs";
import { buildScorecard, renderScorecardMarkdown } from "../src/scorecard.mjs";
import { fixture, git } from "./helpers/repository-fixture";

async function emptyStore(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-card-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return root;
}

function finding(id, severity, status) {
  return {
    id,
    introduced_round: 1,
    severity,
    title: `finding ${id}`,
    explanation: "explanation",
    recommendation: "",
    status,
  };
}

async function writeReview(storeRoot, id, review) {
  const directory = path.join(storeRoot, "reviews", id);
  await fsp.mkdir(directory, { recursive: true });
  await fsp.writeFile(
    path.join(directory, "review.json"),
    `${JSON.stringify(review, null, 2)}\n`,
  );
}

// Mirrors the record core.mjs writes, minus the snapshot fields the scorecard
// never reads. `provider: null` omits the key, as pre-provider ledgers do.
function reviewLedger({
  id,
  status,
  provider = "CLAUDE_DESKTOP",
  createdAt = "2026-08-01T00:00:00.000Z",
  currentRound = 1,
  findings = [],
  resolutions = [],
  decisions = [],
  carriedFindings = [],
  history = [],
}) {
  return {
    version: 1,
    id,
    created_at: createdAt,
    updated_at: createdAt,
    state_version: 3,
    ...(provider == null ? {} : { reviewer_provider: provider }),
    status,
    current_round: currentRound,
    max_rounds: 2,
    rounds: [],
    findings,
    resolutions,
    rereview_decisions: decisions,
    carried_findings: carriedFindings,
    history,
  };
}

async function writeWorkflow(storeRoot, id, { workflow, events, committedLines }) {
  const directory = path.join(storeRoot, "workflows", id);
  await fsp.mkdir(directory, { recursive: true });
  await fsp.writeFile(
    path.join(directory, "workflow.json"),
    `${JSON.stringify({ version: 1, workflow_id: id, ...workflow })}\n`,
  );
  const lines = events.map((event) => `${JSON.stringify(event)}\n`);
  const committed = lines.slice(0, committedLines ?? lines.length).join("");
  await fsp.writeFile(
    path.join(directory, "action-audit.jsonl"),
    lines.join(""),
  );
  await fsp.writeFile(
    path.join(directory, "action-audit-head.json"),
    `${JSON.stringify({
      version: 1,
      workflow_id: id,
      committed_bytes: Buffer.byteLength(committed),
      next_sequence: events.length + 1,
      last_event_sha256: null,
    })}\n`,
  );
}

function auditEvent(event, workflowState) {
  return { version: 1, sequence: 1, event, workflow_state: workflowState };
}

test("the aggregate matches a ledger the server itself wrote", async (t) => {
  const { root, repository, store } = await fixture();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const baseSha = git(repository, "rev-parse", "HEAD");
  await fsp.writeFile(path.join(repository, "app.js"), "export const value = 2;\n");
  git(repository, "add", "app.js");
  git(repository, "commit", "-m", "change");

  const prepared = await prepareReview(store, {
    repositoryPath: repository,
    baseRef: baseSha,
    requirement: "Count what the server wrote.",
    implementationScope: "Edit app.js.",
    reviewerProvider: "HERMES",
  });
  await submitInitialReview(
    store,
    prepared.id,
    [
      { severity: "major", title: "one", explanation: "first" },
      { severity: "nit", title: "two", explanation: "second" },
    ],
    "HERMES",
  );
  await submitResolutions(store, prepared.id, [
    { finding_id: "F-001", disposition: "fixed", rationale: "changed it" },
    { finding_id: "F-002", disposition: "rejected", rationale: "intended" },
  ]);
  await fsp.writeFile(path.join(repository, "app.js"), "export const value = 3;\n");
  git(repository, "add", "app.js");
  git(repository, "commit", "-m", "address");
  await prepareRereview(store, prepared.id);
  await submitRereview(
    store,
    prepared.id,
    [
      { finding_id: "F-001", decision: "resolved", rationale: "verified" },
      {
        finding_id: "F-002",
        decision: "rebuttal_accepted",
        rationale: "agreed",
        verification: "read app.js and the caller",
      },
    ],
    [],
    "HERMES",
  );

  const scorecard = await buildScorecard(store);
  const hermes = scorecard.providers.HERMES;
  assert.equal(scorecard.corpus.reviews_counted, 1);
  assert.equal(scorecard.corpus.reviews_skipped, 0);
  assert.equal(hermes.reviews, 1);
  assert.equal(hermes.reviews_by_status.CLEAN, 1);
  assert.deepEqual(hermes.rounds_to_clean, { 2: 1 });
  assert.deepEqual(hermes.findings_by_severity, {
    blocker: 0,
    major: 1,
    minor: 0,
    nit: 1,
  });
  assert.equal(hermes.disposition_outcomes.fixed.resolved, 1);
  assert.equal(hermes.disposition_outcomes.rejected.rebuttal_accepted, 1);
  // The obligation is live, so the record it just wrote must land after it.
  assert.deepEqual(hermes.rebuttals.after_obligation, {
    rebuttals: 1,
    sustained: 1,
    overturned: 0,
    resolved: 0,
    overturn_rate: 0,
  });
  assert.deepEqual(hermes.rebuttals.before_obligation.rebuttals, 0);
});

test("rebuttals split by the presence of the verification field", async (t) => {
  const store = await emptyStore(t);
  // Pre-#41: the field did not exist, so the key is absent entirely.
  await writeReview(
    store,
    "rb-2026-07-01T000000-000Z-aaaaaaaa",
    reviewLedger({
      id: "rb-2026-07-01T000000-000Z-aaaaaaaa",
      status: "HUMAN_REQUIRED",
      provider: null,
      currentRound: 2,
      findings: [
        finding("F-001", "major", "REBUTTAL_ACCEPTED"),
        finding("F-002", "minor", "STILL_OPEN"),
        finding("F-003", "nit", "REBUTTAL_ACCEPTED"),
      ],
      resolutions: [
        { finding_id: "F-001", disposition: "rejected", rationale: "no" },
        { finding_id: "F-002", disposition: "rejected", rationale: "no" },
        { finding_id: "F-003", disposition: "rejected", rationale: "no" },
      ],
      decisions: [
        { finding_id: "F-001", decision: "rebuttal_accepted", rationale: "ok" },
        { finding_id: "F-002", decision: "still_open", rationale: "not ok" },
        { finding_id: "F-003", decision: "rebuttal_accepted", rationale: "ok" },
      ],
      history: [{ at: "2026-07-01T01:00:00.000Z", event: "REREVIEW_UNRESOLVED" }],
    }),
  );
  // Post-#41: every record has the key, empty when the decision did not need it.
  await writeReview(
    store,
    "rb-2026-08-01T000000-000Z-bbbbbbbb",
    reviewLedger({
      id: "rb-2026-08-01T000000-000Z-bbbbbbbb",
      status: "HUMAN_REQUIRED",
      provider: "CODEX_TASK",
      currentRound: 2,
      findings: [
        finding("F-001", "blocker", "STILL_OPEN"),
        finding("F-002", "nit", "REBUTTAL_ACCEPTED"),
        finding("F-003", "minor", "STILL_OPEN"),
      ],
      resolutions: [
        { finding_id: "F-001", disposition: "rejected", rationale: "no" },
        { finding_id: "F-002", disposition: "rejected", rationale: "no" },
        { finding_id: "F-003", disposition: "rejected", rationale: "no" },
      ],
      decisions: [
        // Post-#41 and empty: only `rebuttal_accepted` must state a
        // verification, so the key is present but blank here.
        { finding_id: "F-001", decision: "still_open", rationale: "held", verification: "" },
        {
          finding_id: "F-002",
          decision: "rebuttal_accepted",
          rationale: "ok",
          verification: "read the caller",
        },
        { finding_id: "F-003", decision: "still_open", rationale: "held", verification: "" },
      ],
      history: [{ at: "2026-08-01T01:00:00.000Z", event: "REREVIEW_UNRESOLVED" }],
    }),
  );

  const { providers } = await buildScorecard(store);
  assert.deepEqual(providers.CLAUDE_DESKTOP.rebuttals.before_obligation, {
    rebuttals: 3,
    sustained: 2,
    overturned: 1,
    resolved: 0,
    overturn_rate: 0.3333,
  });
  assert.equal(providers.CLAUDE_DESKTOP.rebuttals.after_obligation.rebuttals, 0);
  assert.deepEqual(providers.CODEX_TASK.rebuttals.after_obligation, {
    rebuttals: 3,
    sustained: 1,
    overturned: 2,
    resolved: 0,
    overturn_rate: 0.6667,
  });
  assert.equal(providers.CODEX_TASK.rebuttals.before_obligation.rebuttals, 0);
  assert.deepEqual(providers.ALL.rebuttals.before_obligation.rebuttals, 3);
  assert.deepEqual(providers.ALL.rebuttals.after_obligation.rebuttals, 3);
  // Each provider sits on one side only, so the buckets are not comparable.
  assert.match(
    renderScorecardMarkdown(await buildScorecard(store)),
    /No provider has rebuttals on both sides of the obligation/,
  );
});

test("a provider on both sides of the obligation is reported as comparable", async (t) => {
  const store = await emptyStore(t);
  const rejected = (decision) => ({
    findings: [finding("F-001", "major", "REBUTTAL_ACCEPTED")],
    resolutions: [{ finding_id: "F-001", disposition: "rejected", rationale: "no" }],
    decisions: [decision],
  });
  await writeReview(
    store,
    "rb-2026-07-01T000000-000Z-66666666",
    reviewLedger({
      id: "rb-2026-07-01T000000-000Z-66666666",
      status: "CLEAN",
      provider: "HERMES",
      currentRound: 2,
      ...rejected({ finding_id: "F-001", decision: "rebuttal_accepted", rationale: "ok" }),
    }),
  );
  await writeReview(
    store,
    "rb-2026-08-01T000000-000Z-77777777",
    reviewLedger({
      id: "rb-2026-08-01T000000-000Z-77777777",
      status: "CLEAN",
      provider: "HERMES",
      currentRound: 2,
      ...rejected({
        finding_id: "F-001",
        decision: "rebuttal_accepted",
        rationale: "ok",
        verification: "reran the probe",
      }),
    }),
  );

  const scorecard = await buildScorecard(store);
  assert.equal(scorecard.providers.HERMES.rebuttals.before_obligation.rebuttals, 1);
  assert.equal(scorecard.providers.HERMES.rebuttals.after_obligation.rebuttals, 1);
  assert.match(
    renderScorecardMarkdown(scorecard),
    /HERMES has rebuttals on both sides of the obligation/,
  );
});

test("escalations, continuations, and rounds are attributed per provider", async (t) => {
  const store = await emptyStore(t);
  await writeReview(
    store,
    "rb-2026-08-02T000000-000Z-cccccccc",
    reviewLedger({
      id: "rb-2026-08-02T000000-000Z-cccccccc",
      status: "HUMAN_REQUIRED",
      provider: "DEEPSEEK_HARNESS",
      findings: [finding("F-001", "major", "HUMAN_REQUIRED")],
      resolutions: [
        { finding_id: "F-001", disposition: "human_required", rationale: "ask" },
      ],
      history: [{ at: "2026-08-02T01:00:00.000Z", event: "AUTHOR_ESCALATED" }],
    }),
  );
  await writeReview(
    store,
    "rb-2026-08-03T000000-000Z-dddddddd",
    reviewLedger({
      id: "rb-2026-08-03T000000-000Z-dddddddd",
      status: "HUMAN_REQUIRED",
      provider: "DEEPSEEK_HARNESS",
      currentRound: 2,
      history: [{ at: "2026-08-03T01:00:00.000Z", event: "ROUND_LIMIT_REACHED" }],
    }),
  );
  await writeReview(
    store,
    "rb-2026-08-04T000000-000Z-eeeeeeee",
    reviewLedger({
      id: "rb-2026-08-04T000000-000Z-eeeeeeee",
      status: "HUMAN_REQUIRED",
      provider: "DEEPSEEK_HARNESS",
      history: [{ at: "2026-08-04T01:00:00.000Z", event: "REVIEW_PREPARED" }],
    }),
  );
  await writeReview(
    store,
    "rb-2026-08-05T000000-000Z-ffffffff",
    reviewLedger({
      id: "rb-2026-08-05T000000-000Z-ffffffff",
      status: "CONTINUABLE_FINDINGS",
      provider: "CODEX_TASK",
      currentRound: 2,
      findings: [finding("F-003", "minor", "OPEN")],
    }),
  );
  await writeReview(
    store,
    "rb-2026-08-06T000000-000Z-99999999",
    reviewLedger({
      id: "rb-2026-08-06T000000-000Z-99999999",
      status: "LOCAL_GATE_PASSED",
      provider: "CODEX_TASK",
      carriedFindings: [
        {
          continued_from_review_id: "rb-2026-08-05T000000-000Z-ffffffff",
          finding_id: "F-003",
          fingerprint_sha256: "f".repeat(64),
          severity: "minor",
          title: "carried",
          explanation: "carried",
          recommendation: "",
        },
      ],
    }),
  );

  const { providers } = await buildScorecard(store);
  const deepseek = providers.DEEPSEEK_HARNESS;
  assert.equal(deepseek.human_required, 3);
  assert.deepEqual(deepseek.human_required_by_reason, {
    AUTHOR_ESCALATED: 1,
    ROUND_LIMIT_REACHED: 1,
    REREVIEW_UNRESOLVED: 0,
    NOT_RECORDED: 1,
  });
  assert.equal(deepseek.disposition_outcomes.human_required.undecided, 1);
  assert.equal(deepseek.not_clean, 3);
  const codex = providers.CODEX_TASK;
  assert.equal(codex.continuable_findings, 1);
  assert.equal(codex.continuations_started, 1);
  assert.equal(codex.carried_findings, 1);
  assert.deepEqual(codex.rounds_to_clean, { 1: 1 });
});

test("a ledger that cannot be counted is reported and left alone", async (t) => {
  const store = await emptyStore(t);
  const brokenDirectory = path.join(
    store,
    "reviews",
    "rb-2026-08-07T000000-000Z-11111111",
  );
  await fsp.mkdir(brokenDirectory, { recursive: true });
  await fsp.writeFile(path.join(brokenDirectory, "review.json"), "{not json");
  await writeReview(
    store,
    "rb-2026-08-08T000000-000Z-22222222",
    reviewLedger({
      id: "rb-2026-08-08T000000-000Z-22222222",
      status: "INVENTED_STATUS",
    }),
  );
  await writeReview(
    store,
    "rb-2026-08-09T000000-000Z-33333333",
    reviewLedger({
      id: "rb-2026-08-09T000000-000Z-33333333",
      status: "CLEAN",
      findings: [finding("F-001", "catastrophic", "OPEN")],
    }),
  );
  // A remote-only publication has no review ledger; that is not damage.
  await fsp.mkdir(
    path.join(store, "reviews", "rb-2026-08-10T000000-000Z-44444444"),
    { recursive: true },
  );
  await writeReview(
    store,
    "rb-2026-08-11T000000-000Z-55555555",
    reviewLedger({ id: "rb-2026-08-11T000000-000Z-55555555", status: "CLEAN" }),
  );

  const scorecard = await buildScorecard(store);
  assert.equal(scorecard.corpus.reviews_counted, 1);
  assert.equal(scorecard.corpus.reviews_skipped, 3);
  assert.equal(scorecard.corpus.review_directories_without_ledger, 1);
  // The parser's own wording is Node's to change; only the prefix is ours.
  assert.match(scorecard.skipped[0].reason, /^unreadable: /);
  assert.deepEqual(
    scorecard.skipped.slice(1).map(({ reason }) => reason),
    ['unknown status "INVENTED_STATUS"', 'unknown finding severity "catastrophic"'],
  );
  assert.equal(
    await fsp.readFile(path.join(brokenDirectory, "review.json"), "utf8"),
    "{not json",
  );
});

test("workflow budget events come from the committed audit log", async (t) => {
  const store = await emptyStore(t);
  const snapshot = (reviewId, totalLines) => ({
    review_id: reviewId,
    snapshot_hash: `${reviewId}-hash`,
    change_size: { added_lines: totalLines, deleted_lines: 0, total_lines: totalLines },
  });
  await writeWorkflow(store, "rbwf-2026-08-08T000000-000Z-aaaaaaaa", {
    workflow: {
      status: "PAUSED",
      local_review_cycles: [
        { number: 1, addressed_head_sha: "a".repeat(40), followup_review_id: "rb-x" },
        { number: 2, addressed_head_sha: "b".repeat(40), followup_review_id: null },
        { number: 3, addressed_head_sha: null, followup_review_id: null },
      ],
      remote_attempts: [
        { number: 1, diverted_at: null },
        { number: 2, diverted_at: "2026-08-08T02:00:00.000Z" },
      ],
    },
    events: [
      auditEvent("WORKFLOW_PAUSED", {
        pause: { reason_code: "CHANGE_SIZE_BUDGET_EXCEEDED" },
        change_size_budget: 2000,
        current_review: snapshot("rb-over", 2400),
      }),
      auditEvent("CHANGE_SIZE_BUDGET_EXTENDED", {
        change_size_budget: 3000,
        current_review: snapshot("rb-over", 2400),
      }),
      auditEvent("WORKFLOW_PAUSED", {
        pause: { reason_code: "LOCAL_CYCLE_BUDGET_EXHAUSTED" },
        change_size_budget: 3000,
        current_review: snapshot("rb-warn", 2400),
      }),
      auditEvent("LOCAL_CYCLE_BUDGET_EXTENDED", {
        change_size_budget: 3000,
        current_review: snapshot("rb-small", 40),
      }),
      auditEvent("WORKFLOW_PAUSED", {
        pause: { reason_code: "HUMAN_REVIEW_REQUESTED" },
        change_size_budget: 3000,
        current_review: null,
      }),
      auditEvent("ACTION_COMPLETED", {
        change_size_budget: 3000,
        current_review: { review_id: "rb-legacy", snapshot_hash: "legacy-hash" },
      }),
      // Beyond committed_bytes: a torn append is not evidence of anything.
      auditEvent("REMOTE_CYCLE_BUDGET_EXTENDED", {
        change_size_budget: 3000,
        current_review: snapshot("rb-uncommitted", 9000),
      }),
    ],
    committedLines: 6,
  });

  const { workflows } = await buildScorecard(store);
  assert.equal(workflows.workflows, 1);
  assert.equal(workflows.workflows_by_status.PAUSED, 1);
  assert.deepEqual(workflows.budget_pauses, {
    LOCAL_CYCLE_BUDGET_EXHAUSTED: 1,
    REMOTE_CYCLE_BUDGET_EXHAUSTED: 0,
    CHANGE_SIZE_BUDGET_EXCEEDED: 1,
  });
  assert.deepEqual(workflows.budget_extensions, {
    LOCAL_CYCLE_BUDGET_EXTENDED: 1,
    REMOTE_CYCLE_BUDGET_EXTENDED: 0,
    CHANGE_SIZE_BUDGET_EXTENDED: 1,
  });
  // rb-over is measured against the 2000 in force when it first appeared, not
  // the 3000 it was later extended to, so it is over budget; rb-warn's 2400
  // crosses 0.75 of 3000 without exceeding it; rb-small crosses nothing;
  // rb-legacy carries no change size at all.
  assert.deepEqual(workflows.change_size, {
    snapshots_measured: 3,
    snapshots_without_change_size: 1,
    warning_threshold_crossed: 2,
    over_budget: 1,
  });
  assert.deepEqual(workflows.local_cycles, {
    started: 3,
    addressed: 2,
    followed_up: 1,
  });
  assert.deepEqual(workflows.remote_attempts, {
    recorded: 2,
    counted: 1,
    diverted: 1,
  });
});

test("the committed cut is made in bytes, not in characters", async (t) => {
  const store = await emptyStore(t);
  await writeWorkflow(store, "rbwf-2026-08-09T000000-000Z-bbbbbbbb", {
    workflow: { status: "PAUSED" },
    events: [
      // A rationale in a non-Latin script makes the byte length of this event
      // exceed its length in UTF-16 code units.
      {
        version: 1,
        event: "WORKFLOW_PAUSED",
        metadata: { rationale: "预算超出的说明文本".repeat(8) },
        workflow_state: { pause: { reason_code: "LOCAL_CYCLE_BUDGET_EXHAUSTED" } },
      },
      { version: 1, event: "REMOTE_CYCLE_BUDGET_EXTENDED", workflow_state: {} },
    ],
    committedLines: 1,
  });

  const scorecard = await buildScorecard(store);
  assert.equal(scorecard.corpus.audit_logs_skipped, 0);
  assert.equal(scorecard.workflows.budget_pauses.LOCAL_CYCLE_BUDGET_EXHAUSTED, 1);
  assert.equal(
    scorecard.workflows.budget_extensions.REMOTE_CYCLE_BUDGET_EXTENDED,
    0,
  );
});

test("a change size backfilled by a later event still measures its snapshot", async (t) => {
  const store = await emptyStore(t);
  const identity = { review_id: "rb-legacy", snapshot_hash: "legacy-hash" };
  await writeWorkflow(store, "rbwf-2026-08-10T000000-000Z-cccccccc", {
    workflow: { status: "ACTIVE" },
    events: [
      // A legacy dispatch records the review before it records a size, then
      // backfills the size in a later event.
      auditEvent("ACTION_PLANNED", {
        change_size_budget: 2000,
        current_review: { ...identity },
      }),
      auditEvent("WORKFLOW_STATE_UPDATED", {
        change_size_budget: 2000,
        current_review: {
          ...identity,
          change_size: { added_lines: 2400, deleted_lines: 0, total_lines: 2400 },
        },
      }),
    ],
  });

  const { workflows } = await buildScorecard(store);
  assert.deepEqual(workflows.change_size, {
    snapshots_measured: 1,
    snapshots_without_change_size: 0,
    warning_threshold_crossed: 1,
    over_budget: 1,
  });
});

test("a damaged audit log contributes no events and is reported apart", async (t) => {
  const store = await emptyStore(t);
  const directory = path.join(store, "workflows", "rbwf-2026-08-11T000000-000Z-dddddddd");
  await writeWorkflow(store, "rbwf-2026-08-11T000000-000Z-dddddddd", {
    workflow: { status: "ACTIVE", remote_attempts: [{ number: 1, diverted_at: null }] },
    events: [
      auditEvent("WORKFLOW_PAUSED", {
        pause: { reason_code: "REMOTE_CYCLE_BUDGET_EXHAUSTED" },
      }),
    ],
  });
  const log = await fsp.readFile(path.join(directory, "action-audit.jsonl"), "utf8");
  const torn = `${log}{"event":"CHANGE_SIZE_BUDGET_EXTENDED"\n`;
  await fsp.writeFile(path.join(directory, "action-audit.jsonl"), torn);
  await fsp.writeFile(
    path.join(directory, "action-audit-head.json"),
    `${JSON.stringify({
      version: 1,
      workflow_id: "rbwf-2026-08-11T000000-000Z-dddddddd",
      committed_bytes: Buffer.byteLength(torn),
      next_sequence: 3,
      last_event_sha256: null,
    })}\n`,
  );

  const scorecard = await buildScorecard(store);
  // The workflow ledger parsed, so the workflow itself still counts.
  assert.equal(scorecard.corpus.workflows_counted, 1);
  assert.equal(scorecard.corpus.workflows_skipped, 0);
  assert.equal(scorecard.workflows.remote_attempts.recorded, 1);
  // Its audit log did not, so none of its events do.
  assert.equal(scorecard.corpus.audit_logs_skipped, 1);
  assert.equal(scorecard.workflows.budget_pauses.REMOTE_CYCLE_BUDGET_EXHAUSTED, 0);
  assert.match(scorecard.skipped_audit_logs[0].reason, /^unparseable audit line: /);
  assert.match(
    renderScorecardMarkdown(scorecard),
    /workflows\/rbwf-2026-08-11T000000-000Z-dddddddd\/action-audit\.jsonl/,
  );
});

test("an empty store renders a report that states its counting rules", async (t) => {
  const store = await emptyStore(t);
  const scorecard = await buildScorecard(store, {
    generatedAt: "2026-08-27T00:00:00.000Z",
  });
  assert.equal(scorecard.corpus.reviews_counted, 0);
  assert.deepEqual(scorecard.skipped, []);
  const markdown = renderScorecardMarkdown(scorecard);
  assert.match(markdown, /Generated 2026-08-27T00:00:00\.000Z/);
  assert.match(
    markdown,
    /\*\*overturned\*\*\n.*when the reviewer decided `still_open`/,
  );
  assert.match(markdown, /bucketed by field presence, not by date/);
  assert.match(markdown, /No cutoff timestamp is involved/);
  assert.match(markdown, /total_lines >= ceil\(change_size_budget \* 0\.75\)/);
  assert.doesNotMatch(markdown, /## Skipped/);
});
