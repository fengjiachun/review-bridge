import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  exportHumanArbitration,
  finalizeLocalGate,
  getReview,
  getReviewSummary,
  openReview,
  prepareRereview,
  prepareReview,
  readReviewArtifact,
  recordMaintainerRuling,
  submitInitialReview,
  submitRereview,
  submitResolutions,
} from "../src/core.mjs";
import { renderReviewBrief, renderReviewReport } from "../src/report.mjs";
import { commit, fixture } from "./helpers/repository-fixture";

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

const ledgerPath = (store, reviewId) =>
  path.join(store, "reviews", reviewId, "review.json");

const readLedger = async (store, reviewId) =>
  JSON.parse(await fsp.readFile(ledgerPath(store, reviewId), "utf8"));

function prepare(state, extra = {}) {
  return prepareReview(state.store, {
    repositoryPath: state.repository,
    baseRef: state.baseSha,
    requirement: REQUIREMENT,
    implementationScope: "Update app.js.",
    reviewerProvider: "CLAUDE_DESKTOP",
    ...extra,
  });
}

// Round one raises the findings given and the author rejects every one, so
// the review stands in the ruling window.
async function inRulingWindow(state, severities, extra = {}) {
  const prepared = await prepare(state, extra);
  const review = await submitInitialReview(
    state.store,
    prepared.id,
    severities.map((severity, index) => finding(severity, `Issue ${index + 1}`)),
  );
  await submitResolutions(
    state.store,
    prepared.id,
    review.findings.map((entry) => ({
      finding_id: entry.id,
      disposition: "rejected",
      rationale: "A maintainer ruling is being sought.",
    })),
  );
  return prepared.id;
}

const rule = (store, reviewId, text, findingIds = []) =>
  recordMaintainerRuling(store, reviewId, {
    text,
    findingIds,
    operatorLabel: "Jordan (maintainer)",
  });

const accepted = (findingId, verification = "Read app.js; the rebuttal holds.") => ({
  finding_id: findingId,
  decision: "rebuttal_accepted",
  rationale: "The rebuttal holds.",
  verification,
});

async function cleanRoundTwo(state, reviewId, verification) {
  await prepareRereview(state.store, reviewId);
  const review = await getReview(state.store, reviewId);
  return submitRereview(
    state.store,
    reviewId,
    review.findings.map((entry) => accepted(entry.id, verification)),
    [],
  );
}

test("a ruling is recorded only in the window between round one and round two", async (t) => {
  const state = await repositoryFixture(t);
  const prepared = await prepare(state);
  const refused = /accepted only in AUTHOR_RESPONDED before the last round/;
  await assert.rejects(rule(state.store, prepared.id, "Too early."), refused);
  await submitInitialReview(state.store, prepared.id, [finding("major"), finding("minor")]);
  await assert.rejects(rule(state.store, prepared.id, "Unanswered."), refused);
  await submitResolutions(state.store, prepared.id, [
    { finding_id: "F-001", disposition: "rejected", rationale: "Ruling sought." },
    { finding_id: "F-002", disposition: "rejected", rationale: "Ruling sought." },
  ]);

  await assert.rejects(
    rule(state.store, prepared.id, "Names a stranger.", ["F-009"]),
    /names no finding of this review: "F-009"/,
  );
  await assert.rejects(
    rule(state.store, prepared.id, "Names one twice.", ["F-001", "F-001"]),
    /names F-001 twice/,
  );
  const before = await readLedger(state.store, prepared.id);
  assert.equal(before.version, 1);
  assert.equal("rulings" in before, false);
  assert.deepEqual((await getReview(state.store, prepared.id)).rulings, []);

  const summary = await rule(state.store, prepared.id, "The literal stays a number.", ["F-001"]);
  const after = await readLedger(state.store, prepared.id);
  assert.equal(after.version, 2);
  assert.equal(after.state_version, before.state_version + 1);
  assert.equal(after.last_transition_state_version, before.last_transition_state_version);
  assert.equal(after.status, "AUTHOR_RESPONDED");
  assert.deepEqual(after.history, before.history);
  assert.deepEqual(summary.rulings, [
    {
      id: "R-001",
      at: after.rulings[0].at,
      round: 1,
      operator_label: "Jordan (maintainer)",
      finding_ids: ["F-001"],
      text: "The literal stays a number.",
    },
  ]);

  // Every other status refuses, whether the server reaches it or not.
  for (const [status, round] of [
    ["WAITING_FOR_LENS_REVIEW", 1],
    ["CONTINUABLE_FINDINGS", 2],
    ["HUMAN_REQUIRED", 1],
    ["CLEAN", 2],
    ["LOCAL_GATE_PASSED", 2],
    ["AUTHOR_RESPONDED", 2],
  ]) {
    const bytes = `${JSON.stringify({ ...after, status, current_round: round }, null, 2)}\n`;
    await fsp.writeFile(ledgerPath(state.store, prepared.id), bytes);
    await assert.rejects(rule(state.store, prepared.id, "Outside the window."), refused);
    assert.equal(await fsp.readFile(ledgerPath(state.store, prepared.id), "utf8"), bytes);
  }
  await fsp.writeFile(ledgerPath(state.store, prepared.id), `${JSON.stringify(after, null, 2)}\n`);

  await prepareRereview(state.store, prepared.id);
  await assert.rejects(rule(state.store, prepared.id, "Too late."), refused);
  const opened = await openReview(state.store, prepared.id);
  assert.equal(opened.current_round, 2);
  assert.deepEqual(opened.rulings, summary.rulings);
});

test("a finding rejected pending a ruling closes under it without contesting the round", async (t) => {
  const state = await repositoryFixture(t);
  const reviewId = await inRulingWindow(state, ["major"]);
  await rule(state.store, reviewId, "The value may stay a literal.", ["F-001"]);
  const review = await cleanRoundTwo(state, reviewId, "Read app.js against R-001.");
  assert.equal(review.status, "CLEAN");
  assert.equal(review.findings[0].status, "REBUTTAL_ACCEPTED");
});

test("a continuation carries every ruling with its ID and origin across two hops", async (t) => {
  const state = await repositoryFixture(t);
  // Source: F-001 is ruled on and closes in round two; F-002's fix is judged
  // incomplete, which is what continues the review.
  const prepared = await prepare(state);
  await submitInitialReview(state.store, prepared.id, [
    finding("major", "Ruled"),
    finding("minor", "Unfinished"),
    finding("minor", "Third"),
  ]);
  await commitValue(state.repository, 3);
  await submitResolutions(state.store, prepared.id, [
    { finding_id: "F-001", disposition: "rejected", rationale: "Ruling sought." },
    { finding_id: "F-002", disposition: "fixed", rationale: "Fixed." },
    { finding_id: "F-003", disposition: "rejected", rationale: "Ruling sought." },
  ]);
  await rule(state.store, prepared.id, "The value may stay a literal.", ["F-001"]);
  await rule(state.store, prepared.id, "The third issue is accepted as is.", ["F-003"]);
  await rule(state.store, prepared.id, "R-002 is withdrawn.");
  await prepareRereview(state.store, prepared.id);
  const source = await submitRereview(
    state.store,
    prepared.id,
    [
      accepted("F-001", "Read app.js against R-001."),
      { finding_id: "F-002", decision: "still_open", rationale: "Half done." },
      accepted("F-003"),
    ],
    [],
  );
  assert.equal(source.status, "CONTINUABLE_FINDINGS");
  const sourceRulings = (await getReview(state.store, prepared.id)).rulings;

  await commitValue(state.repository, 4);
  const continuation = await prepare(state, {
    continuedFromReviewId: prepared.id,
    forceFullReview: true,
  });
  const carried = sourceRulings.map((entry) => ({
    ...entry,
    continued_from_review_id: prepared.id,
  }));
  assert.deepEqual(continuation.rulings, carried);
  assert.equal((await readLedger(state.store, continuation.id)).version, 2);
  assert.deepEqual((await openReview(state.store, continuation.id)).rulings, carried);

  // The continuation's own F-003 is not the carried ruling's F-003, and its
  // own ruling takes the next unused number.
  await submitInitialReview(state.store, continuation.id, [
    finding("minor", "One"),
    finding("minor", "Two"),
    finding("nit", "Own third"),
  ]);
  await submitResolutions(
    state.store,
    continuation.id,
    ["F-001", "F-002", "F-003"].map((id) => ({
      finding_id: id,
      disposition: "rejected",
      rationale: "Ruling sought.",
    })),
  );
  const own = await rule(state.store, continuation.id, "Own third is fine.", ["F-003"]);
  assert.deepEqual(
    own.rulings.map((entry) => [entry.id, entry.finding_ids, entry.continued_from_review_id ?? null]),
    [
      ["R-001", ["F-001"], prepared.id],
      ["R-002", ["F-003"], prepared.id],
      ["R-003", [], prepared.id],
      ["R-004", ["F-003"], null],
    ],
  );

  // A ruled review at its round limit with only minor and nit findings open
  // is D1-eligible; continuing it instead carries every ruling again, each
  // still naming the ledger it was recorded in.
  await prepareRereview(state.store, continuation.id);
  const eligible = await submitRereview(
    state.store,
    continuation.id,
    [accepted("F-001"), accepted("F-002"), accepted("F-003", "Read app.js against R-004.")],
    [finding("minor", "New")],
  );
  assert.equal(eligible.status, "CONTINUABLE_FINDINGS");
  assert.equal(
    (await getReviewSummary(state.store, continuation.id)).action_required,
    "FINALIZE_LOCAL_GATE",
  );
  await commitValue(state.repository, 5);
  const second = await prepare(state, {
    continuedFromReviewId: continuation.id,
    forceFullReview: true,
  });
  assert.deepEqual(
    second.rulings.map((entry) => [entry.id, entry.continued_from_review_id]),
    [
      ["R-001", prepared.id],
      ["R-002", prepared.id],
      ["R-003", prepared.id],
      ["R-004", continuation.id],
    ],
  );
  const report = renderReviewReport(await readLedger(state.store, second.id));
  assert.match(report, new RegExp(`Ruling \`R-001\` by [^\\n]+ \\(round 1 of \`${prepared.id}\`, carried from that review, `));
  assert.match(report, new RegExp(`Ruling \`R-004\` by [^\\n]+ \\(round 1 of \`${continuation.id}\`, carried from that review, `));
});

test("a ruling is refused once the ledger holds 100, carried ones included", async (t) => {
  const state = await repositoryFixture(t);
  const reviewId = await inRulingWindow(state, ["minor"]);
  const ledger = await readLedger(state.store, reviewId);
  ledger.version = 2;
  ledger.rulings = Array.from({ length: 99 }, (_, index) => ({
    id: `R-${String(index + 1).padStart(3, "0")}`,
    at: ledger.updated_at,
    round: 1,
    operator_label: "Jordan",
    finding_ids: [],
    text: `Ruling ${index + 1}.`,
    ...(index < 50 ? { continued_from_review_id: "rb-2026-01-01T000000-000Z-00000000" } : {}),
  }));
  await fsp.writeFile(ledgerPath(state.store, reviewId), `${JSON.stringify(ledger, null, 2)}\n`);
  const last = await rule(state.store, reviewId, "The hundredth.");
  assert.equal(last.rulings.at(-1).id, "R-100");
  await assert.rejects(rule(state.store, reviewId, "One too many."), /at most 100 entries/);
});

test("a ruling on either side keeps equal requirement texts from matching", async (t) => {
  const state = await repositoryFixture(t);
  // An unruled CLEAN parent, then a nearer ruled one, both gated.
  const unruled = await prepare(state, { forceFullReview: true });
  await submitInitialReview(state.store, unruled.id, []);
  await finalizeLocalGate(state.store, unruled.id);
  await commitValue(state.repository, 3);
  const ruled = await inRulingWindow(state, ["minor"], { forceFullReview: true });
  await rule(state.store, ruled, "The literal stays.", ["F-001"]);
  assert.equal((await cleanRoundTwo(state, ruled, "Read app.js against R-001.")).status, "CLEAN");
  await finalizeLocalGate(state.store, ruled);

  // An untouched file changes, so the delta does not touch the ruled code.
  await fsp.writeFile(path.join(state.repository, "notes.txt"), "notes\n");
  await commit(state.repository, "export const value = 3;\n");
  const automatic = await prepare(state);
  assert.equal(automatic.review_strategy.parent_review_id, unruled.id);

  const explicitRuled = await prepare(state, { parentReviewId: ruled });
  assert.equal(explicitRuled.review_strategy.mode, "FULL");
  assert.equal(
    explicitRuled.review_strategy.fallback_reason,
    "parent and successor must use the same requirement",
  );
  const proof = async (reviewId, round) =>
    JSON.parse((await readReviewArtifact(state.store, reviewId, round, "successor.json")).content);

  // A ruled parent selected automatically is reported as a mismatch: the only
  // other candidate is gone once its gate is.
  await fsp.rm(path.join(state.store, "reviews", unruled.id), { recursive: true });
  const onlyRuled = await prepare(state);
  assert.equal(onlyRuled.review_strategy.mode, "SUCCESSOR");
  assert.equal(onlyRuled.review_strategy.parent_review_id, ruled);
  assert.equal((await proof(onlyRuled.id, 1)).requirement_match, false);
  // A successor carries none of its parent's rulings.
  assert.deepEqual(onlyRuled.rulings, []);
  assert.equal((await readLedger(state.store, onlyRuled.id)).version, 1);

  // Round two of a successor after a W1 ruling: an explicit parent falls back
  // to FULL, an automatic one stays SUCCESSOR and reports the mismatch.
  const plain = await inRulingWindow(state, ["minor"], { forceFullReview: true });
  assert.equal((await cleanRoundTwo(state, plain)).status, "CLEAN");
  await finalizeLocalGate(state.store, plain);
  await commitValue(state.repository, 4);
  const explicitChild = await inRulingWindow(state, ["minor"], { parentReviewId: plain });
  const automaticChild = await inRulingWindow(state, ["minor"]);
  for (const child of [explicitChild, automaticChild]) {
    const roundOne = await getReview(state.store, child);
    assert.equal(roundOne.review_strategy.mode, "SUCCESSOR");
    assert.equal(roundOne.review_strategy.parent_review_id, plain);
    assert.equal((await proof(child, 1)).requirement_match, true);
    await rule(state.store, child, "The literal stays.", ["F-001"]);
    await prepareRereview(state.store, child);
  }
  const explicitRoundTwo = await getReview(state.store, explicitChild);
  assert.equal(explicitRoundTwo.review_strategy.mode, "FULL");
  assert.equal(
    explicitRoundTwo.review_strategy.fallback_reason,
    "parent and successor must use the same requirement",
  );
  const automaticRoundTwo = await getReview(state.store, automaticChild);
  assert.equal(automaticRoundTwo.review_strategy.mode, "SUCCESSOR");
  assert.equal((await proof(automaticChild, 2)).requirement_match, false);
});

test("the arbitration export and both report tiers show every ruling, withdrawn ones included", async (t) => {
  const state = await repositoryFixture(t);
  const reviewId = await inRulingWindow(state, ["major"]);
  await rule(state.store, reviewId, "The value may stay a literal.", ["F-001"]);
  await rule(state.store, reviewId, "R-001 is withdrawn.");
  await prepareRereview(state.store, reviewId);
  const disputed = await submitRereview(
    state.store,
    reviewId,
    [{ finding_id: "F-001", decision: "still_open", rationale: "R-001 was withdrawn." }],
    [],
  );
  assert.equal(disputed.status, "HUMAN_REQUIRED");
  const review = await getReview(state.store, reviewId);
  const { state_version } = await getReviewSummary(state.store, reviewId);
  const { arbitration, markdown } = await exportHumanArbitration(state.store, reviewId, state_version);
  assert.deepEqual(arbitration.rulings, review.rulings);
  assert.match(markdown, /## Maintainer rulings \(2\)\n\nMaintainer decisions recorded under an operator label/);
  assert.match(markdown, /"text": "R-001 is withdrawn\."/);

  const ledger = await readLedger(state.store, reviewId);
  const full = renderReviewReport(ledger);
  assert.match(
    full,
    /Ruling `R-001` by Jordan \(maintainer\) \(round 1, [^)]+\), naming `F-001`, a maintainer decision recorded under an operator label:\n\n```text\nThe value may stay a literal\.\n```/,
  );
  assert.match(full, /Ruling `R-002` by [^\n]+naming no finding[^\n]+\n\n```text\nR-001 is withdrawn\.\n```/);
  assert.match(
    renderReviewBrief(ledger),
    /- 2 maintainer rulings: `R-001` by Jordan \(maintainer\), `R-002` by Jordan \(maintainer\); the full report prints each\./,
  );
});
