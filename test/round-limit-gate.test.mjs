import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  finalizeLocalGate,
  getReviewSummary,
  prepareRereview,
  prepareReview,
  readReviewArtifact,
  submitInitialReview,
  submitRereview,
  submitResolutions,
} from "../src/core.mjs";
import { getPublication, startPublication } from "../src/publication.mjs";
import { loadReportLedgers, renderReviewBrief, writeReviewReport } from "../src/report.mjs";
import { buildScorecard, renderScorecardMarkdown } from "../src/scorecard.mjs";
import { baseline } from "./helpers/github-observation.mjs";
import { commit, fixture, TOPIC_BRANCH } from "./helpers/repository-fixture";

const REQUIREMENT = "Change the exported value.";

const commitValue = (repository, value) =>
  commit(repository, `export const value = ${value};\n`);

async function repositoryFixture(t) {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  await commitValue(state.repository, 2);
  return state;
}

function finding(severity, title = `A ${severity} issue`) {
  return { severity, title, explanation: `${title} needs attention.` };
}

// Round one raises a major and a blocker; the author fixes the major in a new
// commit and rebuts the blocker; round two settles both and raises the
// findings given, so the ledger also holds closed findings of every
// blocking severity.
async function continuableAtRoundTwo(t, newSeverities = ["minor", "nit"]) {
  const state = await repositoryFixture(t);
  const prepared = await prepareReview(state.store, {
    repositoryPath: state.repository,
    baseRef: state.baseSha,
    requirement: REQUIREMENT,
    implementationScope: "Update app.js.",
    reviewerProvider: "CLAUDE_DESKTOP",
  });
  await submitInitialReview(state.store, prepared.id, [finding("major"), finding("blocker")]);
  const headSha = await commitValue(state.repository, 3);
  await submitResolutions(state.store, prepared.id, [
    { finding_id: "F-001", disposition: "fixed", rationale: "Fixed it." },
    { finding_id: "F-002", disposition: "rejected", rationale: "Not reachable." },
  ]);
  await prepareRereview(state.store, prepared.id);
  const review = await submitRereview(
    state.store,
    prepared.id,
    [
      { finding_id: "F-001", decision: "resolved", rationale: "Fixed." },
      {
        finding_id: "F-002",
        decision: "rebuttal_accepted",
        rationale: "Unreachable.",
        verification: "Read app.js and found no caller.",
      },
    ],
    newSeverities.map((severity) => finding(severity)),
  );
  assert.equal(review.status, "CONTINUABLE_FINDINGS");
  return { ...state, reviewId: prepared.id, headSha, review };
}

async function humanRequiredAtRoundTwo(t) {
  const state = await repositoryFixture(t);
  const prepared = await prepareReview(state.store, {
    repositoryPath: state.repository,
    baseRef: state.baseSha,
    requirement: REQUIREMENT,
    implementationScope: "Update app.js.",
    reviewerProvider: "CLAUDE_DESKTOP",
  });
  await submitInitialReview(state.store, prepared.id, [finding("minor")]);
  await submitResolutions(state.store, prepared.id, [
    { finding_id: "F-001", disposition: "rejected", rationale: "Intended." },
  ]);
  await prepareRereview(state.store, prepared.id);
  // Round two is captured but not yet judged, so its finding is undecided.
  await assert.rejects(finalizeLocalGate(state.store, prepared.id), /only a CLEAN review/);
  const review = await submitRereview(
    state.store,
    prepared.id,
    [{ finding_id: "F-001", decision: "still_open", rationale: "Still applies." }],
    [],
  );
  assert.equal(review.status, "HUMAN_REQUIRED");
  assert.equal(review.current_round, 2);
  return { ...state, reviewId: prepared.id, review };
}

function startArgs(state, startedAt) {
  return {
    reviewId: state.reviewId,
    repositoryId: 42,
    owner: "owner",
    repo: "repo",
    prNumber: 7,
    baseBranch: "main",
    headBranch: TOPIC_BRANCH,
    codexActorId: 99,
    codexActorType: "Bot",
    codexActorLogin: "chatgpt-codex-connector[bot]",
    codexTriggerMode: "EXPLICIT_ONLY",
    baseline: baseline(startedAt - 100),
  };
}

function reviewPath(state) {
  return path.join(state.store, "reviews", state.reviewId, "review.json");
}

function gatePath(state) {
  return path.join(state.store, "reviews", state.reviewId, "gate.json");
}

test("a round-two continuable review with only minor or nit findings open is gated over its last snapshot", async (t) => {
  const state = await continuableAtRoundTwo(t);
  const eligible = await getReviewSummary(state.store, state.reviewId);
  assert.equal(eligible.action_required, "FINALIZE_LOCAL_GATE");
  assert.deepEqual(eligible.required_inputs, { finalize_local_gate: [["review_id", "id"]] });

  const { gate } = await finalizeLocalGate(state.store, state.reviewId);
  assert.deepEqual(gate.open_findings, [
    { id: "F-003", severity: "minor", status: "OPEN" },
    { id: "F-004", severity: "nit", status: "OPEN" },
  ]);
  const roundTwo = state.review.rounds[1];
  assert.equal(gate.snapshot_hash, roundTwo.snapshot_hash);
  assert.equal(gate.head_sha, state.headSha);
  assert.equal(roundTwo.head_sha, state.headSha);

  const gated = await getReviewSummary(state.store, state.reviewId);
  assert.equal(gated.status, "LOCAL_GATE_PASSED");
  assert.equal(gated.action_required, "PUBLISH");
  assert.equal(gated.clean_snapshot_hash, roundTwo.snapshot_hash);
  assert.deepEqual(gated.active_findings.map((entry) => entry.id), ["F-003", "F-004"]);

  const report = await fsp.readFile(
    (await writeReviewReport(state.store, state.reviewId)).path,
    "utf8",
  );
  assert.match(report, /- Gated at the round limit with 2 findings open/);
  assert.match(report, new RegExp(`- Gated snapshot: \`${roundTwo.snapshot_hash}\``));
  assert.doesNotMatch(report, /Rounds to CLEAN/);
  const scorecard = await buildScorecard(state.store);
  assert.equal(scorecard.providers.ALL.gated_with_open_findings, 1);
  assert.deepEqual(scorecard.providers.ALL.rounds_to_clean, {});
  assert.match(
    renderScorecardMarkdown(scorecard),
    /\| ALL \| 1 \| 0 \| 0 \| 0 \| 1 \| 0 \| 0 \| 0 \|/,
  );

  const startedAt = Date.now();
  await startPublication(state.store, startArgs(state, startedAt), { clock: () => startedAt });
  const gateBytes = await fsp.readFile(gatePath(state));
  assert.deepEqual((await getPublication(state.store, state.reviewId)).authorization, {
    mode: "LOCAL_GATE",
    head_sha: state.headSha,
    base_sha: state.baseSha,
    snapshot_hash: roundTwo.snapshot_hash,
    source_sha256: createHash("sha256").update(gateBytes).digest("hex"),
    reviewer_provider: "CLAUDE_DESKTOP",
    acknowledgement: null,
    operator_label: null,
    rationale: null,
    authorized_at: null,
  });

  await writeReviewReport(state.store, state.reviewId);
  const original = await fsp.readFile(reviewPath(state), "utf8");
  const reordered = (ledger) => {
    const [, , third, fourth] = ledger.findings;
    ledger.findings.splice(2, 2, fourth, third);
  };
  const reSeverity = (ledger) => {
    ledger.findings.find((entry) => entry.id === "F-004").severity = "minor";
  };
  for (const mutate of [reordered, reSeverity]) {
    const ledger = JSON.parse(original);
    mutate(ledger);
    await fsp.writeFile(reviewPath(state), `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
    await assert.rejects(writeReviewReport(state.store, state.reviewId), (error) => {
      assert.equal(error.code, "LOCAL_GATE_INVALID");
      assert.equal(error.details.field, "open_findings");
      return true;
    });
  }
});

test("a round-two human-required review with only a minor finding open is gated", async (t) => {
  const state = await humanRequiredAtRoundTwo(t);
  assert.equal(
    (await getReviewSummary(state.store, state.reviewId)).action_required,
    "FINALIZE_LOCAL_GATE",
  );
  const report = await fsp.readFile(
    (await writeReviewReport(state.store, state.reviewId)).path,
    "utf8",
  );
  assert.match(report, /- Human arbitration available: `REREVIEW_UNRESOLVED` at [^;]+; the local gate can be finalized instead\n/);
  assert.match(
    report,
    /- Next step: `FINALIZE_LOCAL_GATE`, from the review summary: the local gate can be finalized next with 1 minor or nit finding left open\./,
  );
  const { review: ledger } = await loadReportLedgers(state.store, state.reviewId);
  assert.match(renderReviewBrief(ledger), /- Human arbitration available: `REREVIEW_UNRESOLVED` at [^;]+; the local gate can be finalized instead\./);

  const { gate } = await finalizeLocalGate(state.store, state.reviewId);
  assert.deepEqual(gate.open_findings, [
    { id: "F-001", severity: "minor", status: "STILL_OPEN" },
  ]);
  assert.equal(gate.snapshot_hash, state.review.rounds[1].snapshot_hash);

  // A standalone gate is compared by value, so key order inside an entry does
  // not matter, but a missing list or a different entry does.
  const original = JSON.parse(await fsp.readFile(gatePath(state), "utf8"));
  const writeGate = (open_findings) =>
    fsp.writeFile(
      gatePath(state),
      `${JSON.stringify({ ...original, open_findings }, null, 2)}\n`,
      { mode: 0o600 },
    );
  await writeGate([{ status: "STILL_OPEN", severity: "minor", id: "F-001" }]);
  await writeReviewReport(state.store, state.reviewId);
  for (const open_findings of [undefined, [{ id: "F-001", severity: "nit", status: "STILL_OPEN" }]]) {
    await writeGate(open_findings);
    await assert.rejects(writeReviewReport(state.store, state.reviewId), (error) => {
      assert.equal(error.code, "LOCAL_GATE_INVALID");
      assert.equal(error.details.field, "open_findings");
      assert.equal(error.details.gate_absent, open_findings === undefined ? true : undefined);
      return true;
    });
  }
});

test("a CLEAN gate carries no open_findings member, and an explicit empty one fails the report", async (t) => {
  const state = await repositoryFixture(t);
  const prepared = await prepareReview(state.store, {
    repositoryPath: state.repository,
    baseRef: state.baseSha,
    requirement: REQUIREMENT,
    implementationScope: "Update app.js.",
    reviewerProvider: "CLAUDE_DESKTOP",
  });
  await submitInitialReview(state.store, prepared.id, []);
  const { gate } = await finalizeLocalGate(state.store, prepared.id);
  assert.equal(Object.hasOwn(gate, "open_findings"), false);
  const gated = { ...state, reviewId: prepared.id };
  await writeReviewReport(gated.store, gated.reviewId);
  for (const open_findings of [null, []]) {
    await fsp.writeFile(
      gatePath(gated),
      `${JSON.stringify({ ...gate, open_findings }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await assert.rejects(writeReviewReport(gated.store, gated.reviewId), (error) => {
      assert.equal(error.details.field, "open_findings");
      assert.equal(error.details.gate_absent, undefined);
      assert.equal(error.details.review_absent, true);
      assert.match(error.message, /attests open_findings (null|\[\]), but the review holds none$/);
      return true;
    });
  }
});

test("finalization at the round limit refuses an open major or blocker", async (t) => {
  for (const severity of ["major", "blocker"]) {
    const state = await continuableAtRoundTwo(t, ["minor", severity]);
    assert.equal(
      (await getReviewSummary(state.store, state.reviewId)).action_required,
      "ADDRESS_LOCAL_FINDINGS",
    );
    await assert.rejects(finalizeLocalGate(state.store, state.reviewId), /only a CLEAN review/);
  }
});

test("finalization refuses a round-one escalation, a continued source, and a changed working tree", async (t) => {
  const escalated = await repositoryFixture(t);
  const prepared = await prepareReview(escalated.store, {
    repositoryPath: escalated.repository,
    baseRef: escalated.baseSha,
    requirement: REQUIREMENT,
    implementationScope: "Update app.js.",
    reviewerProvider: "CLAUDE_DESKTOP",
  });
  await submitInitialReview(escalated.store, prepared.id, [finding("nit")]);
  await submitResolutions(escalated.store, prepared.id, [
    { finding_id: "F-001", disposition: "human_required", rationale: "Decide." },
  ]);
  const summary = await getReviewSummary(escalated.store, prepared.id);
  assert.equal(summary.status, "HUMAN_REQUIRED");
  assert.equal(summary.action_required, "HUMAN_ARBITRATION");
  await assert.rejects(finalizeLocalGate(escalated.store, prepared.id), /only a CLEAN review/);

  const continued = await continuableAtRoundTwo(t);
  await commitValue(continued.repository, 4);
  await prepareReview(continued.store, {
    repositoryPath: continued.repository,
    baseRef: continued.baseSha,
    requirement: REQUIREMENT,
    implementationScope: "Update app.js.",
    reviewerProvider: "CLAUDE_DESKTOP",
    continuedFromReviewId: continued.reviewId,
    forceFullReview: true,
  });
  assert.equal(
    (await getReviewSummary(continued.store, continued.reviewId)).action_required,
    "ADDRESS_LOCAL_FINDINGS",
  );
  await assert.rejects(finalizeLocalGate(continued.store, continued.reviewId), /only a CLEAN review/);

  const changed = await continuableAtRoundTwo(t);
  await fsp.writeFile(path.join(changed.repository, "app.js"), "export const value = 9;\n");
  await assert.rejects(
    finalizeLocalGate(changed.store, changed.reviewId),
    /working tree changed after the final-round verdict/,
  );
});

test("a gate written before its status was saved is inert, and finalization can be retried", async (t) => {
  const state = await continuableAtRoundTwo(t);
  const before = await fsp.readFile(reviewPath(state));
  await finalizeLocalGate(state.store, state.reviewId);
  // The crash between the two writes: gate.json exists, the ledger did not move.
  await fsp.writeFile(reviewPath(state), before, { mode: 0o600 });

  const startedAt = Date.now();
  await assert.rejects(
    startPublication(state.store, startArgs(state, startedAt), { clock: () => startedAt }),
    { code: "LOCAL_GATE_INVALID" },
  );
  const report = await fsp.readFile(
    (await writeReviewReport(state.store, state.reviewId)).path,
    "utf8",
  );
  assert.match(
    report,
    /- Next step: `FINALIZE_LOCAL_GATE`, from the review summary: the local gate can be finalized next with 2 minor or nit findings left open\./,
  );
  assert.doesNotMatch(report, /Gated at the round limit/);
  const { review: ledger } = await loadReportLedgers(state.store, state.reviewId);
  assert.match(
    renderReviewBrief(ledger),
    /Next: the local gate can be finalized next with 2 minor or nit findings left open\./,
  );

  const { review } = await finalizeLocalGate(state.store, state.reviewId);
  assert.equal(review.status, "LOCAL_GATE_PASSED");
});

test("a review gated with open findings is a successor parent with a verifying proof", async (t) => {
  const parent = await continuableAtRoundTwo(t);
  await finalizeLocalGate(parent.store, parent.reviewId);
  await commitValue(parent.repository, 5);
  const child = await prepareReview(parent.store, {
    repositoryPath: parent.repository,
    baseRef: parent.baseSha,
    requirement: REQUIREMENT,
    implementationScope: "Update app.js.",
    reviewerProvider: "CLAUDE_DESKTOP",
    parentReviewId: parent.reviewId,
  });
  assert.equal(child.review_strategy.mode, "SUCCESSOR");
  const proof = JSON.parse(
    (await readReviewArtifact(parent.store, child.id, 1, "successor.json")).content,
  );
  assert.equal(proof.parent_review_id, parent.reviewId);
  assert.equal(proof.parent_snapshot_hash, parent.review.rounds[1].snapshot_hash);
});
