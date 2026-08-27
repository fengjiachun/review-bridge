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
  // Every real event names its workflow; an event may still override this to
  // stand in for a copied or tampered log.
  const lines = events.map(
    (event) => `${JSON.stringify({ workflow_id: id, ...event })}\n`,
  );
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

test("a missing or truncated audit artifact is damage, not an empty log", async (t) => {
  const store = await emptyStore(t);
  const write = async (id, mutate) => {
    await writeWorkflow(store, id, {
      workflow: { status: "ACTIVE" },
      events: [
        auditEvent("WORKFLOW_PAUSED", {
          pause: { reason_code: "LOCAL_CYCLE_BUDGET_EXHAUSTED" },
        }),
      ],
    });
    await mutate(path.join(store, "workflows", id));
  };
  await write("rbwf-2026-08-12T000000-000Z-eeeeeeee", (directory) =>
    fsp.rm(path.join(directory, "action-audit-head.json")),
  );
  await write("rbwf-2026-08-13T000000-000Z-ffffffff", (directory) =>
    fsp.rm(path.join(directory, "action-audit.jsonl")),
  );
  // The head still points past the end after the log loses its last event.
  await write("rbwf-2026-08-14T000000-000Z-a1a1a1a1", async (directory) => {
    await fsp.writeFile(path.join(directory, "action-audit.jsonl"), "");
  });

  const scorecard = await buildScorecard(store);
  assert.equal(scorecard.corpus.workflows_counted, 3);
  assert.equal(scorecard.corpus.audit_logs_skipped, 3);
  assert.equal(scorecard.workflows.budget_pauses.LOCAL_CYCLE_BUDGET_EXHAUSTED, 0);
  assert.deepEqual(
    scorecard.skipped_audit_logs.map(({ reason }) => reason),
    [
      "audit artifact is missing",
      "audit artifact is missing",
      "audit log is shorter than its cursor",
    ],
  );
});

test("an unsupported reviewer provider is skipped, not made a bucket", async (t) => {
  const store = await emptyStore(t);
  // A non-string provider would break the provider sort and abort the report.
  await writeReview(
    store,
    "rb-2026-08-18T000000-000Z-e5e5e5e5",
    reviewLedger({
      id: "rb-2026-08-18T000000-000Z-e5e5e5e5",
      status: "CLEAN",
      provider: 7,
    }),
  );
  // "ALL" is the name of the aggregate row, so it would be counted twice.
  await writeReview(
    store,
    "rb-2026-08-19T000000-000Z-f6f6f6f6",
    reviewLedger({
      id: "rb-2026-08-19T000000-000Z-f6f6f6f6",
      status: "CLEAN",
      provider: "ALL",
      findings: [finding("F-001", "major", "OPEN")],
    }),
  );
  await writeReview(
    store,
    "rb-2026-08-20T000000-000Z-a7a7a7a7",
    reviewLedger({
      id: "rb-2026-08-20T000000-000Z-a7a7a7a7",
      status: "CLEAN",
      provider: "HERMES",
    }),
  );

  const scorecard = await buildScorecard(store);
  assert.equal(scorecard.corpus.reviews_counted, 1);
  assert.equal(scorecard.corpus.reviews_skipped, 2);
  assert.deepEqual(
    scorecard.skipped.map(({ reason }) => reason),
    ['unknown reviewer_provider 7', 'unknown reviewer_provider "ALL"'],
  );
  assert.deepEqual(Object.keys(scorecard.providers), ["ALL", "HERMES"]);
  assert.equal(scorecard.providers.ALL.reviews, 1);
  assert.equal(scorecard.providers.ALL.findings, 0);
});

test("a ledger spliced into the wrong directory is skipped", async (t) => {
  const store = await emptyStore(t);
  await writeWorkflow(store, "rbwf-2026-08-21T000000-000Z-b8b8b8b8", {
    workflow: { status: "MERGE_READY", remote_attempts: [{ number: 1, diverted_at: null }] },
    events: [
      auditEvent("WORKFLOW_PAUSED", {
        pause: { reason_code: "REMOTE_CYCLE_BUDGET_EXHAUSTED" },
      }),
    ],
  });
  // Rename the ledger's own id so it no longer matches its directory, leaving
  // the audit log of the directory it sits in.
  const ledgerPath = path.join(
    store,
    "workflows",
    "rbwf-2026-08-21T000000-000Z-b8b8b8b8",
    "workflow.json",
  );
  const ledger = JSON.parse(await fsp.readFile(ledgerPath, "utf8"));
  ledger.workflow_id = "rbwf-2026-08-22T000000-000Z-c9c9c9c9";
  await fsp.writeFile(ledgerPath, `${JSON.stringify(ledger)}\n`);

  const scorecard = await buildScorecard(store);
  assert.equal(scorecard.corpus.workflows_counted, 0);
  assert.equal(scorecard.corpus.workflows_skipped, 1);
  assert.equal(
    scorecard.skipped_workflows[0].reason,
    "workflow ID does not match its store directory",
  );
  assert.equal(scorecard.workflows.remote_attempts.recorded, 0);
  assert.equal(scorecard.workflows.budget_pauses.REMOTE_CYCLE_BUDGET_EXHAUSTED, 0);
});

test("a non-array carried_findings is a defect, not four continuations", async (t) => {
  const store = await emptyStore(t);
  const ledger = reviewLedger({
    id: "rb-2026-08-23T000000-000Z-d0d0d0d0",
    status: "CLEAN",
    provider: "HERMES",
  });
  ledger.carried_findings = "oops";
  await writeReview(store, "rb-2026-08-23T000000-000Z-d0d0d0d0", ledger);

  const scorecard = await buildScorecard(store);
  assert.equal(scorecard.corpus.reviews_counted, 0);
  assert.deepEqual(
    scorecard.skipped.map(({ reason }) => reason),
    ["carried_findings is not an array"],
  );
  assert.equal(scorecard.providers.ALL.continuations_started, 0);
  assert.equal(scorecard.providers.ALL.carried_findings, 0);
});

test("ledgers and audit heads must name the directory they sit in", async (t) => {
  const store = await emptyStore(t);
  // The same review ledger copied into a second directory.
  const shared = reviewLedger({
    id: "rb-2026-08-24T000000-000Z-e1e1e1e1",
    status: "CLEAN",
    provider: "HERMES",
    findings: [finding("F-001", "blocker", "RESOLVED")],
  });
  await writeReview(store, "rb-2026-08-24T000000-000Z-e1e1e1e1", shared);
  await writeReview(store, "rb-2026-08-25T000000-000Z-f2f2f2f2", shared);
  // An audit head carrying another workflow's id.
  await writeWorkflow(store, "rbwf-2026-08-26T000000-000Z-a3a3a3a3", {
    workflow: { status: "ACTIVE" },
    events: [
      auditEvent("WORKFLOW_PAUSED", {
        pause: { reason_code: "LOCAL_CYCLE_BUDGET_EXHAUSTED" },
      }),
    ],
  });
  const headPath = path.join(
    store,
    "workflows",
    "rbwf-2026-08-26T000000-000Z-a3a3a3a3",
    "action-audit-head.json",
  );
  const head = JSON.parse(await fsp.readFile(headPath, "utf8"));
  head.workflow_id = "rbwf-2026-08-27T000000-000Z-b4b4b4b4";
  await fsp.writeFile(headPath, `${JSON.stringify(head)}\n`);

  const scorecard = await buildScorecard(store);
  assert.equal(scorecard.corpus.reviews_counted, 1);
  assert.equal(scorecard.corpus.reviews_skipped, 1);
  assert.equal(
    scorecard.skipped[0].reason,
    "review ID does not match its store directory",
  );
  assert.equal(scorecard.providers.ALL.findings, 1);
  assert.equal(scorecard.corpus.audit_logs_skipped, 1);
  assert.equal(
    scorecard.skipped_audit_logs[0].reason,
    "audit head names a different workflow",
  );
  assert.equal(scorecard.workflows.budget_pauses.LOCAL_CYCLE_BUDGET_EXHAUSTED, 0);
});

test("an audit event naming another workflow is not counted here", async (t) => {
  const store = await emptyStore(t);
  await writeWorkflow(store, "rbwf-2026-08-30T000000-000Z-e7e7e7e7", {
    workflow: { status: "ACTIVE" },
    events: [
      auditEvent("WORKFLOW_PAUSED", {
        pause: { reason_code: "LOCAL_CYCLE_BUDGET_EXHAUSTED" },
      }),
      // Copied from another workflow, under a head that names this one.
      {
        workflow_id: "rbwf-2026-08-31T000000-000Z-f8f8f8f8",
        event: "CHANGE_SIZE_BUDGET_EXTENDED",
        workflow_state: {},
      },
    ],
  });

  const scorecard = await buildScorecard(store);
  assert.equal(scorecard.corpus.workflows_counted, 1);
  assert.equal(scorecard.corpus.audit_logs_skipped, 1);
  assert.equal(
    scorecard.skipped_audit_logs[0].reason,
    "audit event names a different workflow",
  );
  // The whole log is refused, so even the event that did belong is not counted.
  assert.equal(scorecard.workflows.budget_pauses.LOCAL_CYCLE_BUDGET_EXHAUSTED, 0);
  assert.equal(scorecard.workflows.budget_extensions.CHANGE_SIZE_BUDGET_EXTENDED, 0);
});

test("a malformed repair-cycle entry is a defect, not a cycle", async (t) => {
  const store = await emptyStore(t);
  const cases = [
    ["rbwf-2026-08-28T000000-000Z-c5c5c5c5", { local_review_cycles: [null] },
      "local_review_cycles holds an entry that is not an object"],
    ["rbwf-2026-08-29T000000-000Z-d6d6d6d6", { remote_attempts: ["nope"] },
      "remote_attempts holds an entry that is not an object"],
    // An empty object and an array are both `typeof "object"`, so neither is
    // excluded by object-ness alone.
    ["rbwf-2026-09-01T000000-000Z-a1b1c1d1", { local_review_cycles: [{}] },
      "local_review_cycles holds an entry that has no cycle number"],
    ["rbwf-2026-09-02T000000-000Z-b2c2d2e2", { remote_attempts: [[]] },
      "remote_attempts holds an entry that is not an object"],
    ["rbwf-2026-09-03T000000-000Z-c3d3e3f3", { remote_attempts: [{ number: 1, diverted_at: 7 }] },
      "remote_attempts holds an entry that has a non-string diverted_at"],
    ["rbwf-2026-09-04T000000-000Z-d4e4f4a4",
      { local_review_cycles: [{ number: 1, addressed_head_sha: 7 }] },
      "local_review_cycles holds an entry that has a non-string addressed_head_sha"],
  ];
  for (const [id, workflow] of cases) {
    await writeWorkflow(store, id, { workflow: { status: "ACTIVE", ...workflow }, events: [] });
  }

  const scorecard = await buildScorecard(store);
  assert.equal(scorecard.corpus.workflows_counted, 0);
  assert.deepEqual(
    scorecard.skipped_workflows.map(({ reason }) => reason),
    cases.map(([, , reason]) => reason),
  );
  assert.equal(scorecard.workflows.local_cycles.started, 0);
  assert.equal(scorecard.workflows.remote_attempts.counted, 0);
});

test("a blank line between committed events is damage", async (t) => {
  const store = await emptyStore(t);
  const id = "rbwf-2026-09-05T000000-000Z-e5f5a5b5";
  await writeWorkflow(store, id, {
    workflow: { status: "ACTIVE" },
    events: [
      auditEvent("WORKFLOW_PAUSED", {
        pause: { reason_code: "LOCAL_CYCLE_BUDGET_EXHAUSTED" },
      }),
      auditEvent("LOCAL_CYCLE_BUDGET_EXTENDED", {}),
    ],
  });
  const directory = path.join(store, "workflows", id);
  const log = await fsp.readFile(path.join(directory, "action-audit.jsonl"), "utf8");
  const [first, second] = log.split("\n");
  const blanked = `${first}\n\n${second}\n`;
  await fsp.writeFile(path.join(directory, "action-audit.jsonl"), blanked);
  await fsp.writeFile(
    path.join(directory, "action-audit-head.json"),
    `${JSON.stringify({
      version: 1,
      workflow_id: id,
      committed_bytes: Buffer.byteLength(blanked),
      next_sequence: 3,
      last_event_sha256: null,
    })}\n`,
  );

  const scorecard = await buildScorecard(store);
  assert.equal(scorecard.corpus.audit_logs_skipped, 1);
  assert.equal(
    scorecard.skipped_audit_logs[0].reason,
    "audit log has a blank committed line",
  );
  assert.equal(scorecard.workflows.budget_pauses.LOCAL_CYCLE_BUDGET_EXHAUSTED, 0);
  assert.equal(scorecard.workflows.budget_extensions.LOCAL_CYCLE_BUDGET_EXTENDED, 0);
});

test("only one interrupted append may sit past the cursor", async (t) => {
  const store = await emptyStore(t);
  const events = [
    auditEvent("WORKFLOW_PAUSED", {
      pause: { reason_code: "LOCAL_CYCLE_BUDGET_EXHAUSTED" },
    }),
    auditEvent("LOCAL_CYCLE_BUDGET_EXTENDED", {}),
    auditEvent("CHANGE_SIZE_BUDGET_EXTENDED", {}),
  ];
  // One whole event past the cursor is an ordinary interrupted append.
  await writeWorkflow(store, "rbwf-2026-08-16T000000-000Z-c3c3c3c3", {
    workflow: { status: "ACTIVE" },
    events: events.slice(0, 2),
    committedLines: 1,
  });
  // Two are not: the cursor and the log have diverged.
  await writeWorkflow(store, "rbwf-2026-08-17T000000-000Z-d4d4d4d4", {
    workflow: { status: "ACTIVE" },
    events,
    committedLines: 1,
  });

  const scorecard = await buildScorecard(store);
  assert.equal(scorecard.corpus.workflows_counted, 2);
  assert.equal(scorecard.corpus.audit_logs_skipped, 1);
  assert.deepEqual(scorecard.skipped_audit_logs, [
    {
      id: "rbwf-2026-08-17T000000-000Z-d4d4d4d4",
      reason: "audit crash tail is ambiguous",
    },
  ]);
  // Only the tolerated one contributes, and only its committed event.
  assert.equal(scorecard.workflows.budget_pauses.LOCAL_CYCLE_BUDGET_EXHAUSTED, 1);
  assert.equal(scorecard.workflows.budget_extensions.LOCAL_CYCLE_BUDGET_EXTENDED, 0);
});

test("a rebuttal awaiting a decision is counted, not dropped", async (t) => {
  const store = await emptyStore(t);
  await writeReview(
    store,
    "rb-2026-08-15T000000-000Z-b2b2b2b2",
    reviewLedger({
      id: "rb-2026-08-15T000000-000Z-b2b2b2b2",
      status: "AUTHOR_RESPONDED",
      provider: "CODEX_TASK",
      findings: [
        finding("F-001", "major", "AUTHOR_REJECTED"),
        finding("F-002", "minor", "AUTHOR_FIXED"),
      ],
      resolutions: [
        { finding_id: "F-001", disposition: "rejected", rationale: "intended" },
        { finding_id: "F-002", disposition: "fixed", rationale: "changed" },
      ],
    }),
  );

  const scorecard = await buildScorecard(store);
  const codex = scorecard.providers.CODEX_TASK;
  assert.equal(codex.rebuttals_pending, 1);
  assert.equal(scorecard.providers.ALL.rebuttals_pending, 1);
  // A pending rebuttal has no decision record, so it enters neither bucket and
  // cannot move the rate.
  assert.equal(codex.rebuttals.before_obligation.rebuttals, 0);
  assert.equal(codex.rebuttals.after_obligation.rebuttals, 0);
  assert.equal(codex.rebuttals.after_obligation.overturn_rate, null);
  assert.equal(codex.disposition_outcomes.rejected.undecided, 1);
  assert.match(
    renderScorecardMarkdown(scorecard),
    /Awaiting a reviewer decision and therefore in neither bucket: CODEX_TASK 1\./,
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
