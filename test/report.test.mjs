import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  finalizeLocalGate,
  prepareRereview,
  prepareReview,
  submitInitialReview,
  submitRereview,
  submitResolutions,
} from "../src/core.mjs";
import {
  authorizeRemotePublication,
  canonicalDigest,
  derivePublicationStatus,
  finalizePublicationGate,
  getPublication,
  recordCodexReviewRequest,
  recordGithubSnapshot,
  startPublication,
  threadWatermark,
} from "../src/publication.mjs";
import { startAutonomousWorkflow } from "../src/workflow.mjs";
import {
  PROJECTION_NOTICE,
  PROJECTION_NOTICE_REMOTE_ONLY,
  loadReportLedgers,
  renderReviewReport,
  reportRevision,
  summaryDigest,
  writeReviewReport,
} from "../src/report.mjs";
import { atomicWriteCanonicalJson } from "../src/storage.mjs";
import { baseline, iso, observation } from "./helpers/github-observation.mjs";
import {
  gateAndPublishHead,
  reachRemoteWait,
  workflowInput,
} from "./helpers/publication-chain";
import { commit, fixture as workflowFixture } from "./helpers/repository-fixture";

const REVIEW_ID = "rb-2026-09-01T000000-000Z-0badf00d";
const BASE = "a".repeat(40);
const HEAD_ONE = "b".repeat(40);
const HEAD_TWO = "c".repeat(40);
const RENDERED_AT = "2026-09-10T12:00:00.000Z";

// ---------------------------------------------------------------------------
// Hand-built review ledgers for the pure renderer. They mirror the record
// core.mjs writes; the store-level tests below use real ledgers instead.

function round(number, headSha, capturedAt, extra = {}) {
  return {
    round: number,
    version: 1,
    captured_at: capturedAt,
    repository_path: "/tmp/repo",
    base_ref: BASE,
    base_sha: BASE,
    head_sha: headSha,
    snapshot_hash: `${number}`.repeat(64),
    changed_files: ["src/a.mjs", "test/a.test.mjs"],
    deleted_files: [],
    overlays: [],
    worktree_clean: true,
    patch_bytes: 100,
    change_size: { added_lines: 10, deleted_lines: 2, total_lines: 12 },
    successor: null,
    ...extra,
  };
}

function finding(id, severity, status, extra = {}) {
  return {
    id,
    introduced_round: 1,
    severity,
    title: `title of ${id}`,
    explanation: `explanation of ${id}`,
    recommendation: `recommendation for ${id}`,
    status,
    path: "src/a.mjs",
    line: 7,
    ...extra,
  };
}

// Two rounds, a fixed finding the rereviewer resolved and a rejected one whose
// rebuttal was sustained with the verification the obligation requires.
function cleanInTwoRounds(overrides = {}) {
  return {
    version: 1,
    id: REVIEW_ID,
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:30:00.000Z",
    state_version: 6,
    repository_path: "/tmp/repo",
    base_ref: BASE,
    requirement: "Implement the thing.\nSecond requirement line.",
    implementation_scope: "src/a.mjs only",
    reviewer_provider: "CODEX_TASK",
    advisory: false,
    review_strategy: {
      mode: "FULL",
      parent_review_id: null,
      fallback_reason: null,
      parent_selection: "NONE",
    },
    status: "CLEAN",
    current_round: 2,
    max_rounds: 2,
    rounds: [
      round(1, HEAD_ONE, "2026-09-01T00:00:00.000Z"),
      round(2, HEAD_TWO, "2026-09-01T00:20:00.000Z", {
        changed_files: ["src/a.mjs", "src/b.mjs", "test/a.test.mjs"],
      }),
    ],
    findings: [
      finding("F-001", "major", "RESOLVED"),
      finding("F-002", "minor", "REBUTTAL_ACCEPTED", { path: "src/b.mjs", line: 3 }),
    ],
    resolutions: [
      {
        finding_id: "F-001",
        disposition: "fixed",
        rationale: "fixed rationale",
        evidence: "commit cccccccc",
        submitted_at: "2026-09-01T00:15:00.000Z",
      },
      {
        finding_id: "F-002",
        disposition: "rejected",
        rationale: "rejected rationale",
        evidence: "",
        submitted_at: "2026-09-01T00:15:00.000Z",
      },
    ],
    rereview_decisions: [
      {
        finding_id: "F-001",
        decision: "resolved",
        rationale: "resolved rationale",
        verification: "",
        submitted_at: "2026-09-01T00:25:00.000Z",
      },
      {
        finding_id: "F-002",
        decision: "rebuttal_accepted",
        rationale: "sustained rationale",
        verification: "reran the probe against the snapshot",
        submitted_at: "2026-09-01T00:25:00.000Z",
      },
    ],
    errata: [],
    carried_findings: [],
    history: [
      { at: "2026-09-01T00:00:00.000Z", event: "REVIEW_PREPARED", round: 1, mode: "FULL" },
      { at: "2026-09-01T00:06:00.000Z", event: "FINDINGS_SUBMITTED", round: 1, count: 2 },
      { at: "2026-09-01T00:15:00.000Z", event: "AUTHOR_RESPONDED", round: 1 },
      { at: "2026-09-01T00:20:00.000Z", event: "REREVIEW_PREPARED", round: 2, mode: "FULL" },
      { at: "2026-09-01T00:24:30.000Z", event: "REREVIEW_CLEAN", round: 2 },
    ],
    clean_snapshot_hash: "2".repeat(64),
    ...overrides,
  };
}

function render(review, options = {}) {
  return renderReviewReport(review, { renderedAt: RENDERED_AT, ...options });
}

// ---------------------------------------------------------------------------
// Real ledgers through the production path: a git fixture, a CLEAN review,
// a passed local gate, and a publication carried to MERGE_READY, or a
// remote-only authorization published the same way.

function git(cwd, ...args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function gatedFixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-report-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const repository = path.join(root, "repo");
  const store = path.join(root, "store");
  await fsp.mkdir(repository);
  git(repository, "init", "-b", "main");
  git(repository, "config", "user.name", "Review Bridge Test");
  git(repository, "config", "user.email", "review-bridge@example.invalid");
  await fsp.writeFile(path.join(repository, "value.js"), "export const value = 1;\n");
  git(repository, "add", ".");
  git(repository, "commit", "-m", "base");
  const baseSha = git(repository, "rev-parse", "HEAD");
  git(repository, "switch", "-c", "agent/change");
  await fsp.writeFile(path.join(repository, "value.js"), "export const value = 2;\n");
  git(repository, "add", ".");
  git(repository, "commit", "-m", "change");
  const headSha = git(repository, "rev-parse", "HEAD");
  const review = await prepareReview(store, {
    repositoryPath: repository,
    baseRef: baseSha,
    requirement: "Change the exported value.",
    implementationScope: "Update value.js.",
    reviewerProvider: "CLAUDE_DESKTOP",
  });
  await submitInitialReview(store, review.id, [], "CLAUDE_DESKTOP");
  await finalizeLocalGate(store, review.id);
  return { root, repository, store, reviewId: review.id, baseSha, headSha };
}

async function remoteFixture(t) {
  const state = await gatedFixture(t);
  const authorization = await authorizeRemotePublication(state.store, {
    repositoryPath: state.repository,
    baseSha: state.baseSha,
    headSha: state.headSha,
    acknowledgement: "LOCAL_REVIEW_SKIPPED",
    operatorLabel: "maintainer",
    rationale: "Use the GitHub Codex, CI, and review-thread gates only.",
  });
  return { ...state, reviewId: authorization.review_id, authorization };
}

async function startOnly(state) {
  const startedAt = Date.now();
  await startPublication(
    state.store,
    {
      reviewId: state.reviewId,
      repositoryId: 42,
      owner: "owner",
      repo: "repo",
      prNumber: 7,
      baseBranch: "main",
      headBranch: "agent/change",
      codexActorId: 99,
      codexActorType: "Bot",
      codexActorLogin: "chatgpt-codex-connector[bot]",
      codexTriggerMode: "EXPLICIT_ONLY",
      baseline: baseline(startedAt - 100),
    },
    { clock: () => startedAt },
  );
  return startedAt;
}

async function reachReady(state) {
  const startedAt = await startOnly(state);
  const requestAt = startedAt + 1_000;
  await recordCodexReviewRequest(
    state.store,
    state.reviewId,
    {
      expectedRevision: 1,
      commentId: 100,
      url: "https://github.com/owner/repo/issues/7#issuecomment-100",
      createdAt: iso(requestAt),
      requestedHeadSha: state.headSha,
    },
    { clock: () => requestAt + 10 },
  );
  const observedAt = startedAt + 2_000;
  const ready = await recordGithubSnapshot(
    state.store,
    state.reviewId,
    {
      expectedRevision: 2,
      observation: observation({
        at: observedAt,
        baseSha: state.baseSha,
        headSha: state.headSha,
        requestId: 100,
        requestAt,
      }),
    },
    { clock: () => observedAt + 10 },
  );
  assert.equal(ready.status, "MERGE_READY");
  return ready;
}

function reviewDirectory(state) {
  return path.join(state.store, "reviews", state.reviewId);
}

// ---------------------------------------------------------------------------
// The pure renderer.

test("a FULL review that reached CLEAN in round two renders every section and finding field", () => {
  const markdown = render(cleanInTwoRounds());
  assert.ok(markdown.startsWith("# Review report rb-2026-09-01T000000-000Z-0badf00d\n"));
  for (const heading of [
    "## Local review",
    "### Requirement",
    "### Implementation scope",
    "### Rounds",
    "### Findings",
    "### Changes between rounds",
    "### Outcome",
    "## Remote publication",
    "## Footer",
  ]) {
    assert.ok(markdown.includes(`\n${heading}\n`), `missing ${heading}`);
  }
  assert.match(markdown, /- Review strategy: `FULL`, parent selection `NONE`/);
  assert.match(markdown, /- Reviewer provider: `CODEX_TASK`\n/);
  assert.match(markdown, /#### Round 1 strategy: `FULL`\n\nReviewed as a full diff of `a{40}` → `b{40}`\.\n\n#### Round 2 strategy: `FULL`\n\nReviewed as a full diff of `a{40}` → `c{40}`\./);
  assert.match(markdown, /### Requirement\n\n```text\nImplement the thing\.\nSecond requirement line\.\n```\n/);
  // Wall time per round from the prepared and verdict events.
  assert.match(markdown, /\| 1 \| bbbbbbbbbbbb \| 2026-09-01T00:00:00\.000Z \| FINDINGS_SUBMITTED \| 2026-09-01T00:06:00\.000Z \| 6m 0s \| 2 \| \+10 −2 \|/);
  assert.match(markdown, /\| 2 \| cccccccccccc \| [^|]+\| REREVIEW_CLEAN \| [^|]+\| 4m 30s \| 3 \|/);
  // Each finding: severity, location, title, status, disposition, decision,
  // then every long field as its own fenced block.
  assert.match(
    markdown,
    /#### F-001 · major · src\/a\.mjs:7\n\n- Title: title of F-001\n- Introduced in round 1; status `RESOLVED`\n- Author disposition: `fixed` at 2026-09-01T00:15:00\.000Z\n- Rereview decision: `resolved` at 2026-09-01T00:25:00\.000Z\n\nExplanation:\n\n```text\nexplanation of F-001\n```\n\nRecommendation:\n\n```text\nrecommendation for F-001\n```\n\nAuthor rationale:\n\n```text\nfixed rationale\n```\n\nAuthor evidence:\n\n```text\ncommit cccccccc\n```\n\nRereview rationale:\n\n```text\nresolved rationale\n```\n/,
  );
  // A sustained rebuttal prints the verification the rereviewer performed.
  assert.match(markdown, /#### F-002 · minor · src\/b\.mjs:3/);
  assert.match(markdown, /- Rereview decision: `rebuttal_accepted` at [^\n]+\n[\s\S]*?Rereview rationale:\n\n```text\nsustained rationale\n```\n\nRereviewer verification:\n\n```text\nreran the probe against the snapshot\n```/);
  // What changed between rounds comes from the two immutable rounds.
  assert.match(markdown, /- Round 1 → 2: fix head `b{40}` → `c{40}`; files in the reviewed diff: `src\/a\.mjs`, `src\/b\.mjs`, `test\/a\.test\.mjs`/);
  assert.match(markdown, /- Terminal state: `CLEAN`\n- Rounds to CLEAN: 2\n- Clean snapshot: `2{64}`/);
  assert.match(markdown, /## Remote publication\n\nNo publication ledger was rendered\./);
});

test("the footer names the review, both revisions, the render time, the ledger path, and the projection sentence", () => {
  const markdown = render(cleanInTwoRounds(), { ledgerDirectory: "/store/reviews/x" });
  assert.match(markdown, /## Footer\n\n- Review: `rb-2026-09-01T000000-000Z-0badf00d`\n- Review ledger state_version: 6\n- Publication ledger revision: none\n- Report revision: `6`\n- Rendered at: 2026-09-10T12:00:00\.000Z\n- Ledger: `\/store\/reviews\/x\/review\.json`\n/);
  assert.ok(markdown.endsWith(`\n${PROJECTION_NOTICE}\n`));
  assert.match(PROJECTION_NOTICE, /projection of the ledger, not evidence/);
  assert.match(PROJECTION_NOTICE, /rendered from the review ledger and, when present, the publication ledger and its gate listed above, and from the publication summary the server computed/);
  assert.match(PROJECTION_NOTICE_REMOTE_ONLY, /projection of the ledger, not evidence/);
  assert.match(PROJECTION_NOTICE_REMOTE_ONLY, /rendered from the publication ledger and its bound authorization listed above, and from the publication summary the server computed/);
  for (const notice of [PROJECTION_NOTICE, PROJECTION_NOTICE_REMOTE_ONLY]) {
    assert.doesNotMatch(notice, /sole source/);
  }
  // A review-only report has no publication summary line at all.
  assert.doesNotMatch(markdown, /Publication summary/);
  // Without a directory the path is store-relative rather than invented.
  assert.match(render(cleanInTwoRounds()), /- Ledger: `reviews\/rb-2026-09-01T000000-000Z-0badf00d\/review\.json`/);
});

test("a SUCCESSOR review renders its strategy and the delta it was reviewed as", () => {
  const review = cleanInTwoRounds({
    status: "CLEAN",
    current_round: 1,
    state_version: 2,
    review_strategy: {
      mode: "SUCCESSOR",
      parent_review_id: "rb-2026-08-31T000000-000Z-00parent",
      fallback_reason: null,
    },
    rounds: [
      round(1, HEAD_TWO, "2026-09-01T00:00:00.000Z", {
        successor: {
          version: 1,
          parent_review_id: "rb-2026-08-31T000000-000Z-00parent",
          parent_reviewer_provider: "CODEX_TASK",
          requirement_match: true,
          parent_head_sha: HEAD_ONE,
          current_head_sha: HEAD_TWO,
          changed_files: ["src/b.mjs"],
          deleted_files: ["src/old.mjs"],
          delta_bytes: 321,
          delta_sha256: "d".repeat(64),
        },
      }),
    ],
    findings: [],
    resolutions: [],
    rereview_decisions: [],
    history: [
      { at: "2026-09-01T00:00:00.000Z", event: "REVIEW_PREPARED", round: 1, mode: "SUCCESSOR" },
      { at: "2026-09-01T00:03:00.000Z", event: "INITIAL_REVIEW_CLEAN", round: 1 },
    ],
  });
  const markdown = render(review);
  assert.match(markdown, /- Review strategy: `SUCCESSOR`, parent `rb-2026-08-31T000000-000Z-00parent`/);
  assert.doesNotMatch(markdown, /### Successor delta/);
  assert.match(markdown, /#### Round 1 strategy: `SUCCESSOR`\n\n- Parent review: `rb-2026-08-31T000000-000Z-00parent` \(`CODEX_TASK`\)\n- Requirement matches the parent: yes\n- Parent head → current head: `b{40}` → `c{40}`\n- Delta: 321 bytes, sha256 `d{64}`\n- Files in the delta: `src\/b\.mjs`\n- Files deleted in the delta: `src\/old\.mjs`/);
  assert.match(markdown, /### Findings\n\nNo findings were recorded\./);
  assert.match(markdown, /\| 1 \| cccccccccccc \| [^|]+\| INITIAL_REVIEW_CLEAN \| [^|]+\| 3m 0s \|/);
  assert.match(markdown, /### Changes between rounds\n\nNo round followed another\./);
  assert.match(markdown, /- Rounds to CLEAN: 1/);
});

// A rereview recomputes the proof for the new head and may fall back to
// FULL, so each round shows its own strategy and its own proof.
test("each round renders its own strategy and proof, so a successor first round and a FULL second round do not contradict", () => {
  const review = cleanInTwoRounds({
    review_strategy: { mode: "SUCCESSOR", parent_review_id: "rb-2026-08-31T000000-000Z-00parent", fallback_reason: null },
    rounds: [
      round(1, HEAD_ONE, "2026-09-01T00:00:00.000Z", {
        successor: {
          version: 1,
          parent_review_id: "rb-2026-08-31T000000-000Z-00parent",
          parent_reviewer_provider: "CODEX_TASK",
          requirement_match: true,
          parent_head_sha: BASE,
          current_head_sha: HEAD_ONE,
          changed_files: ["src/a.mjs"],
          deleted_files: [],
          delta_bytes: 10,
          delta_sha256: "d".repeat(64),
        },
      }),
      round(2, HEAD_TWO, "2026-09-01T00:20:00.000Z"),
    ],
    history: [
      { at: "2026-09-01T00:00:00.000Z", event: "REVIEW_PREPARED", round: 1, mode: "SUCCESSOR" },
      { at: "2026-09-01T00:06:00.000Z", event: "FINDINGS_SUBMITTED", round: 1, count: 2 },
      { at: "2026-09-01T00:15:00.000Z", event: "AUTHOR_RESPONDED", round: 1 },
      { at: "2026-09-01T00:20:00.000Z", event: "REREVIEW_PREPARED", round: 2, mode: "FULL" },
      { at: "2026-09-01T00:24:30.000Z", event: "REREVIEW_CLEAN", round: 2 },
    ],
  });
  const markdown = render(review);
  const first = markdown.indexOf("#### Round 1 strategy: `SUCCESSOR`");
  const second = markdown.indexOf("#### Round 2 strategy: `FULL`");
  assert.ok(first > 0 && second > first);
  const firstSection = markdown.slice(first, second);
  assert.match(firstSection, /- Parent head → current head: `a{40}` → `b{40}`\n- Delta: 10 bytes/);
  const secondSection = markdown.slice(second, markdown.indexOf("### Findings"));
  assert.match(secondSection, /^#### Round 2 strategy: `FULL`\n\nReviewed as a full diff of `a{40}` → `c{40}`\.\n\n$/);
  assert.doesNotMatch(secondSection, /Delta|Parent/);
  assert.doesNotMatch(markdown, /### Successor delta/);
});

// The "unavailable" line is about a fix the last round itself raised and no
// later round bound; an earlier round's fix was bound by the round after it.
test("a fix in an earlier round does not make the last round's response read as an unbound fix", () => {
  const review = cleanInTwoRounds({
    status: "HUMAN_REQUIRED",
    findings: [
      finding("F-001", "major", "RESOLVED"),
      finding("F-003", "minor", "HUMAN_REQUIRED", { introduced_round: 2 }),
    ],
    resolutions: [
      { finding_id: "F-001", disposition: "fixed", rationale: "fixed in round one", evidence: "", submitted_at: "2026-09-01T00:15:00.000Z" },
      { finding_id: "F-003", disposition: "human_required", rationale: "needs a human", evidence: "", submitted_at: "2026-09-01T00:30:00.000Z" },
    ],
    rereview_decisions: [
      { finding_id: "F-001", decision: "resolved", rationale: "ok", verification: "", submitted_at: "2026-09-01T00:25:00.000Z" },
    ],
    history: [
      { at: "2026-09-01T00:00:00.000Z", event: "REVIEW_PREPARED", round: 1, mode: "FULL" },
      { at: "2026-09-01T00:06:00.000Z", event: "FINDINGS_SUBMITTED", round: 1, count: 1 },
      { at: "2026-09-01T00:15:00.000Z", event: "AUTHOR_RESPONDED", round: 1 },
      { at: "2026-09-01T00:20:00.000Z", event: "REREVIEW_PREPARED", round: 2, mode: "FULL" },
      { at: "2026-09-01T00:30:00.000Z", event: "AUTHOR_ESCALATED", round: 2 },
    ],
    clean_snapshot_hash: null,
  });
  assert.doesNotMatch(render(review), /no later round binds its fix commit/);
  // A fix to a finding the last round raised, with no round after it, is
  // what the line is for.
  review.resolutions[1] = { finding_id: "F-003", disposition: "fixed", rationale: "fixed", evidence: "", submitted_at: "2026-09-01T00:30:00.000Z" };
  review.findings[1].status = "AUTHOR_FIXED";
  assert.match(render(review), /- After round 2: a fixed resolution was submitted, but no later round binds its fix commit or affected files, so they are unavailable here\./);
});

test("a HUMAN_REQUIRED stop names its reason and does not infer a fix commit no round binds", () => {
  const review = cleanInTwoRounds({
    status: "HUMAN_REQUIRED",
    current_round: 1,
    state_version: 3,
    rounds: [round(1, HEAD_ONE, "2026-09-01T00:00:00.000Z")],
    findings: [
      finding("F-001", "blocker", "HUMAN_REQUIRED"),
      finding("F-002", "minor", "AUTHOR_FIXED"),
    ],
    resolutions: [
      {
        finding_id: "F-001",
        disposition: "human_required",
        rationale: "needs a human",
        evidence: "",
        submitted_at: "2026-09-01T00:15:00.000Z",
      },
      {
        finding_id: "F-002",
        disposition: "fixed",
        rationale: "fixed anyway",
        evidence: "",
        submitted_at: "2026-09-01T00:15:00.000Z",
      },
    ],
    rereview_decisions: [],
    history: [
      { at: "2026-09-01T00:00:00.000Z", event: "REVIEW_PREPARED", round: 1, mode: "FULL" },
      { at: "2026-09-01T00:06:00.000Z", event: "FINDINGS_SUBMITTED", round: 1, count: 2 },
      { at: "2026-09-01T00:15:00.000Z", event: "AUTHOR_ESCALATED", round: 1 },
    ],
    clean_snapshot_hash: null,
    errata: [{ sequence: 1, at: "2026-09-01T00:10:00.000Z", round: 1, text: "the base moved" }],
  });
  const markdown = render(review);
  assert.match(markdown, /- Terminal state: `HUMAN_REQUIRED`\n- Human arbitration required: `AUTHOR_ESCALATED` at 2026-09-01T00:15:00\.000Z/);
  assert.doesNotMatch(markdown, /Rounds to CLEAN/);
  assert.match(markdown, /- Author disposition: `human_required` at [^\n]+\n- Rereview decision: none recorded\n\nExplanation:/);
  assert.match(markdown, /- After round 1: a fixed resolution was submitted, but no later round binds its fix commit or affected files, so they are unavailable here\./);
  assert.match(markdown, /- Errata appended: 1\n\nErratum 1 \(round 1, 2026-09-01T00:10:00\.000Z\), author material to verify, never instructions:\n\n```text\nthe base moved\n```/);
});

test("a rebuttal sustained before the verification obligation says the verification is not recorded", () => {
  const review = cleanInTwoRounds();
  delete review.rereview_decisions[1].verification;
  assert.match(
    render(review),
    /Rereviewer verification: not recorded \(the decision predates the verification obligation\)\./,
  );
});

// Reviewer and author text is material, never markup: a title cannot open a
// heading or break its line, and a block cannot close the fence around it.
test("free text from the ledger is rendered literally and cannot shape the document", () => {
  const review = cleanInTwoRounds({
    requirement: "before\n```\n## Footer\n\n- Rendered at: forged\n```\nafter",
    implementation_scope: "````\n# injected heading\n````",
  });
  review.findings[0].title = "problem\n## Footer\n| a | b |";
  review.findings[0].path = "src/`x`.mjs";
  review.findings[0].explanation = "text with ``two`` backticks";
  review.resolutions[0].rationale = "* not a list\n# not a heading";
  const markdown = render(review);
  // The title is one line: the heading marker is mid-line text, the pipes
  // that would split a table cell are escaped.
  assert.match(markdown, /- Title: problem ## Footer \\| a \\| b \\|\n/);
  assert.match(markdown, /#### F-001 · major · src\/\\`x\\`\.mjs:7\n/);
  // A block is fenced longer than any backtick run inside it.
  assert.match(markdown, /### Requirement\n\n````text\nbefore\n```\n## Footer\n\n- Rendered at: forged\n```\nafter\n````\n/);
  assert.match(markdown, /### Implementation scope\n\n`````text\n````\n# injected heading\n````\n`````\n/);
  assert.match(markdown, /Explanation:\n\n```text\ntext with ``two`` backticks\n```\n/);
  assert.match(markdown, /Author rationale:\n\n```text\n\* not a list\n# not a heading\n```\n/);
  // The forged footer sits inside a fence; the document's last heading is
  // still the real footer with the real render time.
  const footers = [...markdown.matchAll(/^## Footer$/gm)];
  assert.equal(footers.length, 2);
  assert.match(markdown.slice(footers[1].index), /- Rendered at: 2026-09-10T12:00:00\.000Z/);
  assert.ok(markdown.indexOf("````text\nbefore") < footers[0].index && footers[0].index < markdown.indexOf("\nafter\n````"));
});

test("rendering is a pure function of its inputs", () => {
  const review = cleanInTwoRounds();
  const before = JSON.stringify(review);
  assert.equal(render(review), render(review));
  assert.equal(JSON.stringify(review), before);
  assert.throws(() => render(null, {}), /needs a review ledger or a publication ledger/);
});

// ---------------------------------------------------------------------------
// Real ledgers: what the store reader admits, what the judges say.

test("a local-gate publication at MERGE_READY renders the pull request, Codex result, checks, and the derivation the gate would make", async (t) => {
  const state = await gatedFixture(t);
  const ready = await reachReady(state);
  const { review, publication, authorization, publicationSummary } = await loadReportLedgers(state.store, state.reviewId);
  assert.equal(review.id, state.reviewId);
  assert.equal(publication.revision, ready.revision);
  assert.equal(authorization.mode, "LOCAL_GATE");
  assert.equal(authorization.head_sha, state.headSha);
  assert.equal(publicationSummary.status, "MERGE_READY");

  const markdown = render(review, { publication, authorization, publicationSummary, ledgerDirectory: reviewDirectory(state) });
  assert.match(markdown, /## Remote publication\n\n- Pull request: owner\/repo#7, `agent\/change` into `main`\n/);
  assert.match(markdown, new RegExp(`- Authorized head: \`${state.headSha}\` over base \`${state.baseSha}\`\n- Authorization: \`LOCAL_GATE\`, gated by \`CLAUDE_DESKTOP\`\n- Authorized repository: \``));
  assert.match(markdown, /\| 1 \| (?:rbreq-[0-9a-f]{32}|100) \| [0-9a-f]{12} \| [^|]+\| RECOGNIZED \| https:\/\/github\.com\/owner\/repo\/issues\/7#issuecomment-100 \|/);
  assert.match(markdown, /\| 1 \| CLEAN \| SINGLE_OPEN_REQUEST \| 100 \| [0-9a-f]{12} \| [^|]+\| https:\/\/github\.com\/owner\/repo\/issues\/7#issuecomment-101 \|\n\nResults recorded in the ledger's own history: 1\. Codex gate as the publication derives it: passing\./);
  assert.match(markdown, /### Required checks\n\nPolicy `NONE_CONFIGURED`; requirements: none\. Checks gate as the publication derives it: passing\.\n\nNo check run was observed on the head\./);
  assert.match(markdown, /### Review threads\n\nNo review thread was observed\./);
  assert.match(
    markdown,
    new RegExp(
      `- Stored status \`MERGE_READY\` at revision ${ready.revision}; the publication summary derives \`MERGE_READY\`, next action \`${publicationSummary.next_action}\`, gate \`${publicationSummary.gate_state}\`\\.\\n- MERGE_READY rests on the observation recorded at revision ${ready.revision}, observed [^,]+, recorded [^,]+, canonical sha256 \`${canonicalDigest(publication.latest_observation)}\`\\.`,
    ),
  );
  const digest = summaryDigest(publicationSummary);
  assert.match(digest, /^[0-9a-f]{12}$/);
  assert.match(markdown, new RegExp(`- Report revision: \`${review.state_version}-p${ready.revision}-s${digest}\``));
  // The footer lists every file the projection was made from, the gate that
  // bound the publication included, and names the summary by digest rather
  // than enumerating what the server read to compute it.
  const directory = reviewDirectory(state);
  assert.match(markdown, new RegExp(`- Ledger: \`${directory}/review\\.json\`, \`${directory}/publication\\.json\`, \`${directory}/gate\\.json\`\\n- Publication summary: computed by the server over its own inputs \\(gate file, workflow binding, resolution sources\\); digest s${digest}\\.\\n`));
  assert.equal(reportRevision(review, publication, publicationSummary), `${review.state_version}-p${ready.revision}-s${digest}`);
  assert.equal(reportRevision(review, publication), `${review.state_version}-p${ready.revision}`);
});

test("a remote-only publication renders from its publication and bound authorization, without a review ledger", async (t) => {
  const state = await remoteFixture(t);
  const ready = await reachReady(state);
  const { review, publication, authorization, publicationSummary } = await loadReportLedgers(state.store, state.reviewId);
  assert.equal(review, null);
  assert.equal(authorization.mode, "REMOTE_ONLY");
  assert.equal(authorization.source_sha256, publication.authorization.source_sha256);

  const markdown = render(null, { publication, authorization, publicationSummary, ledgerDirectory: "/store/reviews/x" });
  assert.ok(markdown.startsWith(`# Review report ${state.reviewId}\n`));
  assert.match(markdown, /## Local review\n\nNone: this publication was authorized `REMOTE_ONLY` with local review skipped, so there is no review ledger, no rounds, and no findings to render\. The authorization is under Remote publication\.\n\n## Remote publication\n/);
  for (const absent of ["### Rounds", "### Findings", "### Changes between rounds", "### Outcome"]) {
    assert.ok(!markdown.includes(absent), `${absent} rendered without a review`);
  }
  // The authorization prints once, under Remote publication, from the bound file.
  assert.match(markdown, new RegExp(`- Authorization: \`REMOTE_ONLY\`, acknowledgement \`LOCAL_REVIEW_SKIPPED\`, operator maintainer, at ${authorization.authorized_at}\\n- Authorized repository: \`[^\`]*/repo\`\\n- Codex trigger policy: \`EXPLICIT_ONLY\`\\n\\nAuthorization rationale:\\n\\n\`\`\`text\\nUse the GitHub Codex, CI, and review-thread gates only\\.\\n\`\`\``));
  assert.equal(markdown.match(/Use the GitHub Codex, CI, and review-thread gates only\./g).length, 1);
  assert.match(markdown, new RegExp(`- Stored status \`MERGE_READY\` at revision ${ready.revision}; the publication summary derives \`MERGE_READY\`, next action \`${publicationSummary.next_action}\`, gate \`ABSENT\`\\.`));
  assert.match(markdown, new RegExp(`- Review ledger state_version: n/a \\(remote-only: no local review ledger\\)\\n- Publication ledger revision: ${ready.revision}\\n- Report revision: \`p${ready.revision}-s${summaryDigest(publicationSummary)}\`\\n- Rendered at: [^\\n]+\\n- Ledger: \`/store/reviews/x/publication\\.json\`, \`/store/reviews/x/remote-authorization\\.json\`\\n- Publication summary: computed by the server over its own inputs \\(gate file, workflow binding, resolution sources\\); digest s${summaryDigest(publicationSummary)}\\.`));
  // The remote-only footer names the ledgers that were actually rendered.
  assert.ok(markdown.endsWith(`\n${PROJECTION_NOTICE_REMOTE_ONLY}\n`));
  assert.ok(!markdown.includes(PROJECTION_NOTICE));
});

// Before the first snapshot the gates have nothing to judge, and their null
// "nothing wrong" must not be printed as passing over an observation that was
// never recorded: every observation-based section says so instead.
test("a publication with no observation yet says so in every observation-based section and judges nothing", async (t) => {
  const state = await gatedFixture(t);
  await startOnly(state);
  const { review, publication, authorization, publicationSummary } = await loadReportLedgers(state.store, state.reviewId);
  assert.equal(publication.status, "PR_PENDING");
  assert.equal(publication.latest_observation, null);
  const markdown = render(review, { publication, authorization, publicationSummary });
  assert.match(markdown, /### Codex review requests\n\nNo request was recorded\./);
  for (const heading of ["### Codex results in the latest observation", "### Required checks", "### Review threads"]) {
    assert.match(markdown, new RegExp(`${heading}\\n\\nNo observation has been recorded yet, so there is nothing here to judge\\.\\n`), heading);
  }
  assert.match(markdown, /### Derivation\n\n- Stored status `PR_PENDING` at revision 1; the publication summary derives `PR_PENDING` \(`NO_GITHUB_SNAPSHOT`\), next action `POST_AND_RECORD_CODEX_REVIEW_REQUEST`, gate `ABSENT`\.\n- No observation has been recorded yet, so there is nothing here to judge\.\n/);
  assert.doesNotMatch(markdown, /passing/);
  assert.doesNotMatch(markdown, /MERGE_READY rests on/);
  assert.equal(markdown.match(/No observation has been recorded yet/g).length, 4);
});

// A missing review ledger is explained only by a REMOTE_ONLY authorization.
// Under any other authorization the store is incomplete, and rendering "local
// review skipped" over it would be a false report.
test("a LOCAL_GATE publication without its review ledger is refused, not rendered as skipped", async (t) => {
  const state = await gatedFixture(t);
  await reachReady(state);
  const { publication } = await loadReportLedgers(state.store, state.reviewId);
  assert.throws(() => render(null, { publication }), (error) => {
    assert.equal(error.code, "REVIEW_LEDGER_MISSING");
    assert.match(error.message, /review ledger missing for a LOCAL_GATE publication/);
    return true;
  });
  // A version-1 publication has no authorization record and was always local-gate.
  assert.throws(() => render(null, { publication: { ...publication, authorization: undefined } }), { code: "REVIEW_LEDGER_MISSING" });

  await fsp.rm(path.join(reviewDirectory(state), "review.json"));
  await assert.rejects(writeReviewReport(state.store, state.reviewId), (error) => {
    assert.equal(error.code, "REVIEW_LEDGER_MISSING");
    assert.equal(error.details.path, path.join(reviewDirectory(state), "review.json"));
    return true;
  });
  assert.ok(!(await fsp.readdir(reviewDirectory(state))).some((name) => name.startsWith("report-")));
});

// A thread with complete provenance the frontier and the gate can judge.
function observedThread(id, headSha, comments = 1) {
  return {
    id,
    path: "src/value.js",
    line: 1,
    is_outdated: false,
    is_resolved: true,
    provenance_complete: true,
    comments_pagination_complete: true,
    comment_count: comments,
    comments: Array.from({ length: comments }, (_, index) => ({
      id: `${id}-c${index + 1}`,
      database_id: 1000 + index,
      created_at: `2026-09-01T01:0${index}:00.000Z`,
      updated_at: `2026-09-01T01:0${index}:00.000Z`,
      actor: { id: index === 0 ? 99 : 7, type: index === 0 ? "Bot" : "User", login: index === 0 ? "codex[bot]" : "author" },
      review: { id: `PRR_${id}`, database_id: 5000 + index, state: "COMMENTED", reviewed_head_sha: headSha, actor: { id: 7, type: "User", login: "author" } },
    })),
  };
}

function resolutionRecord(thread, headSha, number = 1) {
  return {
    number,
    action_id: `act-${number}`,
    thread_id: thread.id,
    thread_watermark: threadWatermark(thread),
    eligibility_sha256: "e".repeat(64),
    head_sha: headSha,
    actor: { id: 7, type: "User" },
    reply_comment_id: 55,
    recorded_revision: 3,
  };
}

// The observation's resolved flag is read against the publication's own
// judges, so a retired or invalidated record never explains a resolved thread
// and an unresolve after an automatic resolution is reported as history.
test("a thread's outcome follows the frontier replay and the gate's invalidation check, not the presence of a record", async (t) => {
  const state = await gatedFixture(t);
  await reachReady(state);
  const { publication } = await loadReportLedgers(state.store, state.reviewId);
  const headSha = publication.latest_observation.pull_request.head_sha;
  const threads = publication.latest_observation.review_threads;
  const thread = observedThread("PRRT_1", headSha);
  threads.threads = [thread];
  threads.total_count = 1;
  threads.unresolved_count = 0;
  publication.automatic_resolutions = [resolutionRecord(thread, headSha)];

  // Active record, resolved thread, matching watermark: credited.
  let markdown = render(cleanInTwoRounds(), { publication });
  assert.match(markdown, new RegExp(`\\| PRRT_1 \\| src/value\\.js:1 \\| 1 by codex\\\\\\[bot\\\\\\] \\| resolved by record 1 \\(action act-1, reply comment 55, head ${headSha.slice(0, 12)}\\) \\|`));

  // A comment appended after the record: the thread is still resolved on
  // GitHub, but its watermark moved, and the gate judges the resolution
  // invalidated. The record must not be credited.
  const commented = observedThread("PRRT_1", headSha, 2);
  threads.threads = [commented];
  markdown = render(cleanInTwoRounds(), { publication });
  assert.match(markdown, /\| PRRT_1 \| src\/value\.js:1 \| 2 by codex\\\[bot\\\], author \| resolved on GitHub; record 1 no longer explains it: the gate judges THREAD_RESOLUTION_INVALIDATED \(the thread's provenance, resolved flag, or watermark changed since the record\) \|/);
  // A hand-mutated ledger has no summary, and the report derives nothing on
  // its own.
  assert.match(markdown, /- Stored status `MERGE_READY` at revision 3; not derived here: no publication summary was supplied\.\n- No MERGE_READY derivation is rendered for this status\./);
  assert.match(markdown, /- Publication summary: not supplied to this render\./);

  // The record was invalidated and unresolved for repair, and the observation
  // now shows the thread unresolved: a legitimate state, reported as such.
  threads.threads = [{ ...thread, is_resolved: false }];
  threads.unresolved_count = 1;
  publication.resolution_lifecycle = [
    {
      number: 1,
      kind: "INVALIDATED",
      thread_id: "PRRT_1",
      record_id: "act-1",
      prior_watermark: threadWatermark(thread),
      new_watermark: threadWatermark(commented),
      follow_up_comments: [],
      reason: "NEW_COMMENTS",
      at: "2026-09-01T01:05:00.000Z",
    },
    {
      number: 2,
      kind: "UNRESOLVED_FOR_REPAIR",
      thread_id: "PRRT_1",
      record_id: "act-1",
      action_id: "act-2",
      at: "2026-09-01T01:06:00.000Z",
    },
  ];
  markdown = render(cleanInTwoRounds(), { publication });
  assert.match(markdown, /\| PRRT_1 \| [^|]+\| [^|]+\| unresolved; left for a human; record 1 resolved it automatically and is no longer active \(THREAD_RESOLUTION_INVALIDATED\) \|/);

  // A retired record does not explain a thread GitHub shows resolved either.
  threads.threads = [thread];
  threads.unresolved_count = 0;
  markdown = render(cleanInTwoRounds(), { publication });
  assert.match(markdown, /\| PRRT_1 \| [^|]+\| [^|]+\| resolved on GitHub; record 1 resolved it automatically and is no longer active \(THREAD_RESOLUTION_INVALIDATED\) \|/);

  // No record at all: the observed state, nothing more.
  publication.resolution_lifecycle = [];
  publication.automatic_resolutions = [];
  threads.threads = [{ ...thread, is_resolved: false }];
  threads.unresolved_count = 1;
  markdown = render(cleanInTwoRounds(), { publication });
  assert.match(markdown, /\| PRRT_1 \| [^|]+\| [^|]+\| unresolved; left for a human \|/);
  threads.threads = [thread];
  threads.unresolved_count = 0;
  markdown = render(cleanInTwoRounds(), { publication });
  assert.match(markdown, /\| PRRT_1 \| [^|]+\| [^|]+\| resolved on GitHub; no automatic-resolution record \|/);
});

// The gate section is the publication summary's verdict, never a bare
// derivation: on a workflow-bound ledger the summary's terminal replay refuses
// a resolved thread the workflow owns no proof for, where derivePublication
// over the ledger alone still says MERGE_READY.
test("the derivation section agrees with the publication summary where a bare derivation would not", async (t) => {
  const state = await workflowFixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const workflow = await startAutonomousWorkflow(state.store, workflowInput(state.repository, state.baseSha));
  const headSha = await commit(state.repository, "export const value = 2;\n");
  const { workflow: atPublication, reviewId } = await gateAndPublishHead(state, workflow, headSha, "one");
  await reachRemoteWait(state, atPublication, reviewId, headSha, Date.now(), (payload) => {
    // Ready to merge on its face, with one thread resolved by nobody the
    // workflow can account for.
    payload.pull_request.is_draft = false;
    const thread = observedThread("PRRT_unowned", headSha);
    payload.review_threads.threads = [thread];
    payload.review_threads.total_count = 1;
    payload.review_threads.unresolved_count = 0;
    return payload;
  });

  const { review, publication, authorization, publicationSummary } = await loadReportLedgers(state.store, reviewId);
  const bare = derivePublicationStatus(publication);
  assert.equal(bare.status, "MERGE_READY");
  assert.notEqual(publicationSummary.status, "MERGE_READY");
  const markdown = render(review, { publication, authorization, publicationSummary });
  assert.match(
    markdown,
    new RegExp(`- Stored status \`${publication.status}\` at revision ${publication.revision}; the publication summary derives \`${publicationSummary.status}\` \\(\`${publicationSummary.blocking_reason}\`\\), next action \`${publicationSummary.next_action}\`, gate \`${publicationSummary.gate_state}\`\\.\\n- No MERGE_READY derivation is rendered for this status\\.`),
  );
  assert.doesNotMatch(markdown, /MERGE_READY rests on/);
  assert.match(markdown, /\| PRRT_unowned \| [^|]+\| [^|]+\| resolved on GitHub; no automatic-resolution record \|/);
});

// A review that carried findings through both rounds, built through the
// writers, so the validator's derived status table meets real records.
async function reviewedFixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-report-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const repository = path.join(root, "repo");
  const store = path.join(root, "store");
  await fsp.mkdir(repository);
  git(repository, "init", "-b", "main");
  git(repository, "config", "user.name", "Review Bridge Test");
  git(repository, "config", "user.email", "review-bridge@example.invalid");
  await fsp.writeFile(path.join(repository, "value.js"), "export const value = 1;\n");
  git(repository, "add", ".");
  git(repository, "commit", "-m", "base");
  const baseSha = git(repository, "rev-parse", "HEAD");
  git(repository, "switch", "-c", "agent/change");
  await fsp.writeFile(path.join(repository, "value.js"), "export const value = 2;\n");
  git(repository, "add", ".");
  git(repository, "commit", "-m", "change");
  const review = await prepareReview(store, {
    repositoryPath: repository,
    baseRef: baseSha,
    requirement: "Change the exported value.",
    implementationScope: "Update value.js.",
    reviewerProvider: "CLAUDE_DESKTOP",
  });
  await submitInitialReview(store, review.id, [
    { severity: "major", title: "wrong value", explanation: "should be 3", recommendation: "set 3", path: "value.js", line: 1 },
    { severity: "nit", title: "style", explanation: "fine as is", recommendation: "" },
  ], "CLAUDE_DESKTOP");
  await submitResolutions(store, review.id, [
    { finding_id: "F-001", disposition: "fixed", rationale: "set to 3" },
    { finding_id: "F-002", disposition: "rejected", rationale: "intended" },
  ]);
  await fsp.writeFile(path.join(repository, "value.js"), "export const value = 3;\n");
  git(repository, "add", ".");
  git(repository, "commit", "-m", "fix");
  await prepareRereview(store, review.id);
  await submitRereview(store, review.id, [
    { finding_id: "F-001", decision: "resolved", rationale: "verified", verification: "read value.js" },
    { finding_id: "F-002", decision: "rebuttal_accepted", rationale: "agreed", verification: "reread the style" },
  ], [], "CLAUDE_DESKTOP");
  return { root, store, reviewId: review.id };
}

// Every finding's status is derived from its records and the whole table is
// compared, so records removed under a finding, a record with no finding, and
// a decision with no resolution behind it are all one defect.
test("finding statuses must equal what their records derive, in both directions", async (t) => {
  const state = await reviewedFixture(t);
  const reviewPath = path.join(reviewDirectory(state), "review.json");
  const original = await fsp.readFile(reviewPath, "utf8");
  const genuine = JSON.parse(original);
  assert.equal(genuine.status, "CLEAN");
  assert.deepEqual(genuine.findings.map((finding) => finding.status), ["RESOLVED", "REBUTTAL_ACCEPTED"]);
  // The genuine two-round ledger renders.
  const written = await writeReviewReport(state.store, state.reviewId, { renderedAt: RENDERED_AT });
  assert.equal(written.reused, false);
  assert.match(await fsp.readFile(written.path, "utf8"), /#### F-001 · major · value\.js:1[\s\S]*Rereview decision: `resolved`[\s\S]*#### F-002 · nit · no location[\s\S]*Rereview decision: `rebuttal_accepted`/);
  await fsp.rm(written.path);

  const tamper = async (mutate, expected) => {
    const review = JSON.parse(original);
    mutate(review);
    await fsp.writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, { mode: 0o600 });
    await assert.rejects(writeReviewReport(state.store, state.reviewId), (error) => {
      assert.equal(error.code, "REVIEW_LEDGER_INVALID");
      assert.match(error.details.reason, expected);
      return true;
    });
    assert.ok(!(await fsp.readdir(reviewDirectory(state))).some((name) => name.startsWith("report-")));
  };
  // Records cleared under findings that still read RESOLVED.
  await tamper((review) => { review.resolutions = []; review.rereview_decisions = []; }, /finding "F-001" is "RESOLVED" but its records derive "OPEN"/);
  // A decision with no finding.
  await tamper((review) => { review.rereview_decisions.push({ finding_id: "F-009", decision: "resolved", rationale: "x", verification: "", submitted_at: review.updated_at }); }, /a rereview decision names no finding: "F-009"/);
  // A decision with a finding but no resolution behind it.
  await tamper((review) => {
    review.findings.push({ id: "F-003", introduced_round: 2, severity: "minor", title: "t", explanation: "e", recommendation: "", status: "RESOLVED" });
    review.rereview_decisions.push({ finding_id: "F-003", decision: "resolved", rationale: "x", verification: "", submitted_at: review.updated_at });
  }, /finding "F-003" is "RESOLVED" but its records derive no status \(a decision with no resolution\)/);
  // A status that does not follow from its own records.
  await tamper((review) => { review.findings[1].status = "RESOLVED"; }, /finding "F-002" is "RESOLVED" but its records derive "REBUTTAL_ACCEPTED"/);
  // Every field the writer sets is held to the writer's own domain and to
  // the rest of the ledger: a round the ledger does not hold, a non-integer
  // round, a bad line, an escaping path, an ID out of position, and a field
  // the writer never sets are each refused by name.
  await tamper((review) => { review.findings[0].introduced_round = 3; }, /finding "F-001" introduced_round 3 is not a round the ledger holds/);
  await tamper((review) => { review.findings[0].introduced_round = "1"; }, /finding "F-001" introduced_round "1" is not a round the ledger holds/);
  await tamper((review) => { review.findings[0].line = 0; }, /finding "F-001" line 0 is not absent, or a positive integer/);
  await tamper((review) => { review.findings[0].path = "../secret"; }, /finding "F-001" path "\.\.\/secret" is not absent, or a safe relative path/);
  await tamper((review) => { review.findings[1].id = "F-007"; }, /finding "F-007" id "F-007" is not the position-based finding ID/);
  await tamper((review) => { review.findings[0].reviewer_note = "x"; }, /finding "F-001" carries a field the writer never sets: reviewer_note/);
  await tamper((review) => { delete review.findings[0].explanation; }, /finding "F-001" has no explanation/);
  // A FINDINGS_SUBMITTED that lost its round is refused by name; the gate
  // event, which the writer records without one, is not required to carry it.
  await tamper((review) => { delete review.history.find((entry) => entry.event === "FINDINGS_SUBMITTED").round; }, /history entry 2 \(FINDINGS_SUBMITTED\) has no round/);
  await tamper((review) => { review.history.find((entry) => entry.event === "REREVIEW_PREPARED").round = 0; }, /history entry \d+ \(REREVIEW_PREPARED\) has no round/);
  // Restored, it renders again.
  await fsp.writeFile(reviewPath, original, { mode: 0o600 });
  assert.equal((await writeReviewReport(state.store, state.reviewId, { renderedAt: RENDERED_AT })).reused, false);
});

// Only the printed summary fields enter the digest, so a summary field the
// report never shows cannot change the report's identity.
test("the summary digest covers exactly the fields the report prints", () => {
  const base = { status: "MERGE_READY", blocking_reason: null, next_action: "FINALIZE_PUBLICATION_GATE", gate_state: "ABSENT", revision: 3, gate_expires_in_seconds: null, required_inputs: {} };
  assert.equal(summaryDigest(base), summaryDigest({ ...base, revision: 9, gate_expires_in_seconds: 120, required_inputs: { x: 1 }, latest_observed_at: "later" }));
  for (const change of [{ status: "CHANGES_REQUIRED" }, { blocking_reason: "EVIDENCE_STALE" }, { next_action: "VERIFY_PUBLICATION_GATE" }, { gate_state: "PRESENT" }]) {
    assert.notEqual(summaryDigest(base), summaryDigest({ ...base, ...change }), JSON.stringify(change));
  }
});

// The ledger and its summary are read under separate locks. A snapshot
// recorded between the two reads would file a report under revision N with
// revision N+1's verdict; the loader compares the two and fails closed.
test("a publication that moves between the ledger read and the summary read fails the render closed", async (t) => {
  const state = await gatedFixture(t);
  const ready = await reachReady(state);
  const advanceBetweenReads = async (storeRoot, reviewId) => {
    const ledger = await getPublication(storeRoot, reviewId);
    const at = Date.now() + 10_000;
    await recordGithubSnapshot(
      storeRoot,
      reviewId,
      {
        expectedRevision: ledger.revision,
        observation: observation({ at, baseSha: state.baseSha, headSha: state.headSha, requestId: 100, requestAt: at - 5_000 }),
      },
      { clock: () => at + 10 },
    );
    return ledger;
  };
  await assert.rejects(
    loadReportLedgers(state.store, state.reviewId, { readPublication: advanceBetweenReads }),
    (error) => {
      assert.equal(error.code, "PUBLICATION_MOVED_DURING_RENDER");
      assert.deepEqual(error.details, {
        review_id: state.reviewId,
        publication_revision: ready.revision,
        summary_revision: ready.revision + 1,
      });
      return true;
    },
  );
  assert.ok(!(await fsp.readdir(reviewDirectory(state))).some((name) => name.startsWith("report-")));
  // Read again without interference, the two agree and the report renders
  // under the revision the ledger now holds.
  const written = await writeReviewReport(state.store, state.reviewId, { renderedAt: RENDERED_AT });
  assert.equal(written.publication_revision, ready.revision + 1);
  assert.equal(written.reused, false);
});

// ---------------------------------------------------------------------------
// The store writer.

test("the store writer names the file by the ledger revision, returns a receipt, and is idempotent at that revision", async (t) => {
  const state = await gatedFixture(t);
  const directory = reviewDirectory(state);
  const { review, authorization } = await loadReportLedgers(state.store, state.reviewId);
  assert.equal(authorization.mode, "LOCAL_GATE");

  const first = await writeReviewReport(state.store, state.reviewId, { renderedAt: RENDERED_AT });
  assert.equal(first.path, path.join(directory, `report-r${review.state_version}.md`));
  assert.equal(first.reused, false);
  assert.equal(first.revision, String(review.state_version));
  assert.equal(first.review_state_version, review.state_version);
  assert.equal(first.publication_revision, null);
  // A receipt, never the Markdown: the file holds the report, the receipt
  // holds what identifies it.
  assert.equal(first.markdown, undefined);
  const written = await fsp.readFile(first.path);
  assert.equal(written.length, first.bytes);
  assert.equal(crypto.createHash("sha256").update(written).digest("hex"), first.sha256);
  assert.equal(
    written.toString("utf8"),
    renderReviewReport(review, { authorization, renderedAt: RENDERED_AT, ledgerDirectory: directory }),
  );
  // The gate the passed review minted is read and listed even before any
  // publication exists.
  assert.match(written.toString("utf8"), new RegExp(`- Ledger: \`${directory}/review\\.json\`, \`${directory}/gate\\.json\`\\n`));
  assert.equal((await fsp.stat(first.path)).mode & 0o777, 0o600);

  // A second render at the same revision keeps the same bytes, render time
  // included, and rewrites nothing.
  const second = await writeReviewReport(state.store, state.reviewId, {
    renderedAt: "2026-09-11T00:00:00.000Z",
  });
  assert.equal(second.reused, true);
  assert.equal(second.sha256, first.sha256);
  assert.equal(second.bytes, first.bytes);
  assert.equal(await fsp.readFile(first.path, "utf8"), written.toString("utf8"));

  // A publication arriving later is a new revision and a new file beside it.
  const ready = await reachReady(state);
  const withPublication = await writeReviewReport(state.store, state.reviewId, {
    renderedAt: RENDERED_AT,
  });
  assert.match(withPublication.summary_digest, /^[0-9a-f]{12}$/);
  assert.equal(withPublication.path, path.join(directory, `report-r${review.state_version}-p${ready.revision}-s${withPublication.summary_digest}.md`));
  assert.equal(withPublication.reused, false);
  assert.equal(withPublication.publication_revision, ready.revision);
  const withPublicationText = await fsp.readFile(withPublication.path, "utf8");
  assert.match(withPublicationText, /- Pull request: owner\/repo#7/);
  assert.match(withPublicationText, /gate `ABSENT`/);
  assert.match(withPublicationText, new RegExp(`- Ledger: \`${directory}/review\\.json\`, \`${directory}/publication\\.json\`, \`${directory}/gate\\.json\`\\n`));
  // The ledgers themselves are untouched by rendering.
  assert.deepEqual(await getPublication(state.store, state.reviewId), ready);
  // Unchanged, the same three identities reuse the file.
  const again = await writeReviewReport(state.store, state.reviewId, { renderedAt: "2026-09-12T00:00:00.000Z" });
  assert.equal(again.reused, true);
  assert.equal(again.path, withPublication.path);

  // Finalizing the gate moves no ledger revision, only the summary: the
  // report's identity follows the printed summary, so the next render is a
  // new file whose gate section says so, not a reuse of the ABSENT one.
  await finalizePublicationGate(state.store, state.reviewId, { expectedRevision: ready.revision });
  const afterGate = await writeReviewReport(state.store, state.reviewId, { renderedAt: RENDERED_AT });
  assert.equal(afterGate.reused, false);
  assert.equal(afterGate.publication_revision, ready.revision);
  assert.notEqual(afterGate.summary_digest, withPublication.summary_digest);
  assert.notEqual(afterGate.path, withPublication.path);
  assert.equal(afterGate.path, path.join(directory, `report-r${review.state_version}-p${ready.revision}-s${afterGate.summary_digest}.md`));
  const afterGateText = await fsp.readFile(afterGate.path, "utf8");
  assert.match(afterGateText, /gate `PRESENT`/);
  assert.match(afterGateText, /next action `VERIFY_PUBLICATION_GATE`/);
  assert.match(afterGateText, new RegExp(`digest s${afterGate.summary_digest}\\.`));
  // Both reports stay beside the ledger; the earlier one is not rewritten.
  assert.equal(await fsp.readFile(withPublication.path, "utf8"), withPublicationText);
});

test("a remote-only publication is written as report-p<revision>.md", async (t) => {
  const state = await remoteFixture(t);
  const ready = await reachReady(state);
  const directory = reviewDirectory(state);
  const written = await writeReviewReport(state.store, state.reviewId, { renderedAt: RENDERED_AT });
  assert.equal(written.path, path.join(directory, `report-p${ready.revision}-s${written.summary_digest}.md`));
  assert.equal(written.reused, false);
  assert.equal(written.revision, `p${ready.revision}-s${written.summary_digest}`);
  assert.equal(written.review_state_version, null);
  assert.equal(written.publication_revision, ready.revision);
  const text = await fsp.readFile(written.path, "utf8");
  assert.match(text, /authorized `REMOTE_ONLY` with local review skipped/);
  assert.match(text, /- Authorization: `REMOTE_ONLY`, acknowledgement `LOCAL_REVIEW_SKIPPED`, operator maintainer, at [^\n]+\n- Authorized repository: `/);
  assert.match(text, new RegExp(`- Ledger: \`${directory}/publication\\.json\`, \`${directory}/remote-authorization\\.json\``));
  assert.equal(crypto.createHash("sha256").update(text).digest("hex"), written.sha256);
});

// Every ledger passes the reader the server uses, so a file that is not this
// review's, or not bound to this ledger, fails the render and writes nothing.
test("a ledger the store reader rejects fails the render closed", async (t) => {
  const remote = await remoteFixture(t);
  await reachReady(remote);
  const remoteDirectory = reviewDirectory(remote);
  const sidecarPath = path.join(remoteDirectory, "remote-authorization.json");
  const sidecar = JSON.parse(await fsp.readFile(sidecarPath, "utf8"));

  // An edited sidecar: valid JSON, canonical, but not the bytes the ledger bound.
  await atomicWriteCanonicalJson(sidecarPath, { ...sidecar, rationale: "an edited rationale" });
  await assert.rejects(writeReviewReport(remote.store, remote.reviewId), (error) => {
    assert.equal(error.code, "REMOTE_AUTHORIZATION_INVALID");
    assert.match(error.message, /publication authorization changed/);
    return true;
  });
  await atomicWriteCanonicalJson(sidecarPath, { ...sidecar, head_sha: "d".repeat(40) });
  await assert.rejects(writeReviewReport(remote.store, remote.reviewId), { code: "REMOTE_AUTHORIZATION_INVALID" });
  // A missing sidecar is the same failure.
  await fsp.rm(sidecarPath);
  await assert.rejects(writeReviewReport(remote.store, remote.reviewId), { code: "PUBLICATION_AUTHORIZATION_INVALID" });
  assert.ok(!(await fsp.readdir(remoteDirectory)).some((name) => name.startsWith("report-")));

  // A publication copied in from another review: the reader refuses a ledger
  // whose review_id is not the directory's, so review A is never filed with
  // publication B's remote section.
  const local = await gatedFixture(t);
  await reachReady(local);
  const localDirectory = reviewDirectory(local);
  await fsp.copyFile(
    path.join(localDirectory, "publication.json"),
    path.join(remoteDirectory, "publication.json"),
  );
  await assert.rejects(writeReviewReport(remote.store, remote.reviewId), (error) => {
    assert.equal(typeof error.code, "string");
    assert.notEqual(error.code, "PUBLICATION_NOT_FOUND");
    return true;
  });
  // A review ledger that names another review is refused as well.
  const foreignReview = JSON.parse(await fsp.readFile(path.join(localDirectory, "review.json"), "utf8"));
  const third = await gatedFixture(t);
  await fsp.writeFile(path.join(reviewDirectory(third), "review.json"), `${JSON.stringify(foreignReview)}\n`, { mode: 0o600 });
  await assert.rejects(writeReviewReport(third.store, third.reviewId), (error) => {
    assert.equal(error.code, "REVIEW_LEDGER_INVALID");
    assert.match(error.message, new RegExp(local.reviewId));
    return true;
  });
  assert.ok(!(await fsp.readdir(reviewDirectory(third))).some((name) => name.startsWith("report-")));
});

// The review ledger is admitted only as one core could have written: an edit
// or rollback that keeps the id but changes the status, the version history,
// or a round's snapshot commitment is refused before it can be combined with
// a validated publication into a report that looks authoritative.
test("a review ledger edited in place is refused as REVIEW_LEDGER_INVALID", async (t) => {
  const state = await gatedFixture(t);
  const reviewPath = path.join(reviewDirectory(state), "review.json");
  const original = await fsp.readFile(reviewPath, "utf8");
  const tamper = async (mutate) => {
    const review = JSON.parse(original);
    mutate(review);
    // Written the way the store writes it, so the shape check, not the byte
    // check, is what refuses it.
    await fsp.writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, { mode: 0o600 });
    await assert.rejects(writeReviewReport(state.store, state.reviewId), (error) => {
      assert.equal(error.code, "REVIEW_LEDGER_INVALID");
      assert.equal(error.details.path, reviewPath);
      return true;
    });
    return (await fsp.readdir(reviewDirectory(state))).filter((name) => name.startsWith("report-"));
  };
  assert.deepEqual(await tamper((review) => { review.status = "MERGED"; }), []);
  // A legal status the history does not replay to: the gate transition is
  // still the last event, so CLEAN is a rollback by hand.
  assert.deepEqual(await tamper((review) => { review.status = "CLEAN"; }), []);
  // An illegal transition spliced into the history.
  assert.deepEqual(await tamper((review) => { review.history.splice(1, 0, { at: review.history[0].at, event: "REREVIEW_CLEAN", round: 1 }); }), []);
  // A history that opens a round the ledger does not hold.
  assert.deepEqual(await tamper((review) => { review.history.splice(1, 0, { at: review.history[0].at, event: "FINDINGS_SUBMITTED", round: 1 }, { at: review.history[0].at, event: "AUTHOR_RESPONDED", round: 1 }, { at: review.history[0].at, event: "REREVIEW_PREPARED", round: 2 }, { at: review.history[0].at, event: "REREVIEW_CLEAN", round: 2 }); review.history.splice(5, 1); }), []);
  // A clean verdict over a finding still open.
  assert.deepEqual(await tamper((review) => { review.findings.push({ id: "F-1", introduced_round: 1, severity: "minor", title: "t", explanation: "e", status: "OPEN" }); }), []);
  // A round-bound event that lost its round: the writer always records one,
  // and a reader pairing events by round would find nothing for it.
  assert.deepEqual(await tamper((review) => { delete review.history.find((entry) => entry.event === "INITIAL_REVIEW_CLEAN").round; }), []);
  assert.deepEqual(await tamper((review) => { review.state_version = review.history.length - 1; }), []);
  assert.deepEqual(await tamper((review) => { review.rounds[0].snapshot_hash = "f".repeat(64); }), []);
  assert.deepEqual(await tamper((review) => { review.rounds[0].head_sha = "0".repeat(40); }), []);
  assert.deepEqual(await tamper((review) => { review.findings.push({ id: "F-9", severity: "major", status: "OPEN" }); review.resolutions.push({ finding_id: "F-8", disposition: "fixed" }); }), []);
  // A rewrite that keeps the content but not the store's serialization is
  // refused too: the ledger was touched by something other than the store.
  await fsp.writeFile(reviewPath, JSON.stringify(JSON.parse(original)), { mode: 0o600 });
  await assert.rejects(writeReviewReport(state.store, state.reviewId), (error) => {
    assert.equal(error.code, "REVIEW_LEDGER_INVALID");
    assert.match(error.message, /not the store's own serialization/);
    return true;
  });
  // Restored byte for byte, the ledger renders again.
  await fsp.writeFile(reviewPath, original, { mode: 0o600 });
  const written = await writeReviewReport(state.store, state.reviewId, { renderedAt: RENDERED_AT });
  assert.equal(written.reused, false);
});

// A LOCAL_GATE_PASSED review minted its gate; a store without it, or with a
// gate that does not attest the review's clean snapshot, is incomplete and is
// not rendered as a passed gate.
test("a LOCAL_GATE_PASSED review without a valid gate.json is refused even before any publication exists", async (t) => {
  const state = await gatedFixture(t);
  const gatePath = path.join(reviewDirectory(state), "gate.json");
  const original = await fsp.readFile(gatePath, "utf8");
  await fsp.rm(gatePath);
  await assert.rejects(writeReviewReport(state.store, state.reviewId), (error) => {
    assert.equal(error.code, "LOCAL_GATE_MISSING");
    assert.equal(error.details.path, gatePath);
    return true;
  });
  // Every attested field the review also holds is compared, and the error
  // names the one that differs.
  for (const [field, value] of [
    ["snapshot_hash", "f".repeat(64)],
    ["base_sha", "1".repeat(40)],
    ["head_sha", "2".repeat(40)],
    ["reviewer_provider", "CODEX_TASK"],
  ]) {
    const tampered = { ...JSON.parse(original), [field]: value };
    await fsp.writeFile(gatePath, `${JSON.stringify(tampered, null, 2)}\n`, { mode: 0o600 });
    await assert.rejects(writeReviewReport(state.store, state.reviewId), (error) => {
      assert.equal(error.code, "LOCAL_GATE_INVALID", field);
      // The provider mismatch is caught by the gate reader itself, the rest
      // by the field list; either way the render stops before writing.
      if (error.details?.field != null) {
        assert.equal(error.details.field, field);
        assert.equal(error.details.gate, value);
      }
      return true;
    });
  }
  const foreign = { ...JSON.parse(original), review_id: REVIEW_ID };
  await fsp.writeFile(gatePath, `${JSON.stringify(foreign, null, 2)}\n`, { mode: 0o600 });
  await assert.rejects(writeReviewReport(state.store, state.reviewId), { code: "LOCAL_GATE_INVALID" });
  assert.ok(!(await fsp.readdir(reviewDirectory(state))).some((name) => name.startsWith("report-")));
  await fsp.writeFile(gatePath, original, { mode: 0o600 });
  assert.equal((await writeReviewReport(state.store, state.reviewId, { renderedAt: RENDERED_AT })).reused, false);
});

// With a publication, the gate is bound to the publication by the store
// reader; it must still be held to the review, or a structurally valid review
// ledger of another change, filed under this id with its own rounds, would be
// rendered under this gate and publication.
test("a local-gate publication's gate is held to the review ledger beside it", async (t) => {
  const state = await gatedFixture(t);
  await reachReady(state);
  const directory = reviewDirectory(state);
  const genuine = await writeReviewReport(state.store, state.reviewId, { renderedAt: RENDERED_AT });
  assert.equal(genuine.reused, false);
  await fsp.rm(genuine.path);

  // Another review's ledger and rounds, re-labelled with this review's id so
  // the ledger validates on its own terms; only the gate can tell it apart.
  const other = await gatedFixture(t);
  const otherDirectory = reviewDirectory(other);
  const foreign = JSON.parse(await fsp.readFile(path.join(otherDirectory, "review.json"), "utf8"));
  foreign.id = state.reviewId;
  const keep = { reviewPath: path.join(directory, "review.json"), original: await fsp.readFile(path.join(directory, "review.json")) };
  await fsp.rm(path.join(directory, "rounds"), { recursive: true });
  await fsp.cp(path.join(otherDirectory, "rounds"), path.join(directory, "rounds"), { recursive: true });
  await fsp.writeFile(keep.reviewPath, `${JSON.stringify(foreign, null, 2)}\n`, { mode: 0o600 });
  await assert.rejects(writeReviewReport(state.store, state.reviewId), (error) => {
    assert.equal(error.code, "LOCAL_GATE_INVALID");
    assert.ok(["base_sha", "head_sha", "snapshot_hash"].includes(error.details.field), error.details.field);
    return true;
  });
  assert.ok(!(await fsp.readdir(directory)).some((name) => name.startsWith("report-")));
});

// Two renderers racing on one revision must leave one file, and each receipt
// must describe that file: the loser reuses the winner's bytes rather than
// replacing them with a render that differs by its render time.
test("concurrent renders at one revision produce one file that both receipts describe", async (t) => {
  const state = await gatedFixture(t);
  const directory = reviewDirectory(state);
  const [first, second] = await Promise.all([
    writeReviewReport(state.store, state.reviewId, { renderedAt: "2026-09-10T12:00:00.000Z" }),
    writeReviewReport(state.store, state.reviewId, { renderedAt: "2026-09-10T12:00:01.000Z" }),
  ]);
  assert.equal(first.path, second.path);
  assert.equal(first.sha256, second.sha256);
  assert.equal(first.bytes, second.bytes);
  assert.deepEqual([first.reused, second.reused].sort(), [false, true]);
  const onDisk = await fsp.readFile(first.path);
  assert.equal(crypto.createHash("sha256").update(onDisk).digest("hex"), first.sha256);
  assert.equal(onDisk.length, first.bytes);
  // No temporary file survives the race.
  assert.ok(!(await fsp.readdir(directory)).some((name) => name.endsWith(".tmp")));
});

// A write that fails part-way leaves nothing behind: not the temporary file,
// and not a partial report at the final path.
test("a failed write leaves no temporary file, and the next render succeeds", async (t) => {
  const state = await gatedFixture(t);
  const directory = reviewDirectory(state);
  const probe = await fsp.open(path.join(directory, "review.json"));
  const fileHandlePrototype = Object.getPrototypeOf(probe);
  await probe.close();
  t.mock.method(
    fileHandlePrototype,
    "writeFile",
    () => Promise.reject(Object.assign(new Error("no space left on device"), { code: "ENOSPC" })),
    { times: 1 },
  );
  await assert.rejects(writeReviewReport(state.store, state.reviewId), /no space left on device/);
  const afterFailure = await fsp.readdir(directory);
  assert.ok(!afterFailure.some((name) => name.endsWith(".tmp")), `temporary left behind: ${afterFailure}`);
  assert.ok(!afterFailure.some((name) => name.startsWith("report-")));
  const retried = await writeReviewReport(state.store, state.reviewId, { renderedAt: RENDERED_AT });
  assert.equal(retried.reused, false);
  assert.equal((await fsp.readFile(retried.path)).length, retried.bytes);
});

test("a missing ledger is a structured error, and an invalid ID never reaches the store", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-report-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await assert.rejects(writeReviewReport(root, REVIEW_ID), (error) => {
    assert.equal(error.code, "REVIEW_NOT_FOUND");
    assert.match(error.message, /neither review\.json nor publication\.json/);
    assert.equal(error.details.review_id, REVIEW_ID);
    assert.equal(error.details.path, path.join(root, "reviews", REVIEW_ID));
    return true;
  });
  await assert.rejects(writeReviewReport(root, "../etc/passwd"), (error) => {
    assert.equal(error.code, "INVALID_REVIEW_ID");
    return true;
  });
});
