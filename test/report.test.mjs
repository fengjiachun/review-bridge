import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  appendReviewErratum,
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
  renderReviewBrief,
  renderReviewReport,
  REPORT_FORMAT,
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
import {
  BASELINE_RENDERED_AT,
  BASELINE_REVIEW_ID,
  continuableInTwoRounds,
  continuableWithOneMoreOpenFinding,
} from "./helpers/report-ledger.mjs";

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

// Commit dates are pinned so two fixtures built in the same second, or in
// different seconds, produce the same SHAs for the same content: whether two
// fixtures differ is then decided by their content, never by the clock.
function git(cwd, ...args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_DATE: "2026-09-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-09-01T00:00:00Z",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function gatedFixture(t, { change = "export const value = 2;\n", finalize = true } = {}) {
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
  await fsp.writeFile(path.join(repository, "value.js"), change);
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
  if (finalize) await finalizeLocalGate(store, review.id);
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
  // Each round is its own snapshot with its cumulative file table; between
  // rounds only the head relation is stated, never a delta the ledger lacks.
  assert.match(markdown, /### Changes between rounds\n\n- Round 1 snapshot: `a{40}` → `b{40}`; files: `src\/a\.mjs`, `test\/a\.test\.mjs`\n- Round 1 → 2: head `b{40}` → `c{40}`\n- Round 2 snapshot: `a{40}` → `c{40}`; files: `src\/a\.mjs`, `src\/b\.mjs`, `test\/a\.test\.mjs`\n/);
  assert.doesNotMatch(markdown, /fix head|files in the reviewed diff/);
  assert.match(markdown, /- Terminal state: `CLEAN`\n- Rounds to CLEAN: 2\n- Clean snapshot: `2{64}`/);
  assert.match(markdown, /## Remote publication\n\nNo publication ledger was rendered\./);
});

test("the footer names the review, both revisions, the render time, the ledger path, and the projection sentence", () => {
  const markdown = render(cleanInTwoRounds(), { ledgerDirectory: "/store/reviews/x" });
  assert.match(markdown, new RegExp(`## Footer\\n\\n- Review: \`rb-2026-09-01T000000-000Z-0badf00d\`\\n- Review ledger state_version: 6\\n- Publication ledger revision: none\\n- Report revision: \`6-f${REPORT_FORMAT}\`\\n- Rendered at: 2026-09-10T12:00:00\\.000Z\\n- Ledger: \`/store/reviews/x/review\\.json\`\\n`));
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
  assert.match(markdown, /### Changes between rounds\n\n- Round 1 snapshot: `a{40}` → `c{40}`; files: /);
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
        successor_delta_sha256: "d".repeat(64),
        successor_parent_head_sha: BASE,
        successor_current_head_sha: HEAD_ONE,
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
  assert.match(firstSection, /^#### Round 1 strategy: `SUCCESSOR`\n/);
  assert.match(firstSection, /- Parent head → current head: `a{40}` → `b{40}`\n- Delta: 10 bytes/);
  assert.doesNotMatch(firstSection, /unverified|as recorded/);
  const secondSection = markdown.slice(second, markdown.indexOf("### Findings"));
  assert.match(secondSection, /^#### Round 2 strategy: `FULL`\n\nReviewed as a full diff of `a{40}` → `c{40}`\.\n\n$/);
  assert.doesNotMatch(secondSection, /Delta|Parent/);
  assert.doesNotMatch(markdown, /### Successor delta/);
});

// A rereview after a rebuttal reviews the same head again: the ledger has no
// delta between the rounds, so the section states the unchanged head and
// calls nothing a fix.
test("a rereview at the same head prints the head as unchanged and names no fix", () => {
  const review = cleanInTwoRounds({
    rounds: [round(1, HEAD_ONE, "2026-09-01T00:00:00.000Z"), round(2, HEAD_ONE, "2026-09-01T00:20:00.000Z")],
  });
  const markdown = render(review);
  const section = markdown.slice(markdown.indexOf("### Changes between rounds"), markdown.indexOf("### Outcome"));
  assert.match(section, /\n- Round 1 → 2: head unchanged since round 1\n- Round 2 snapshot: `a{40}` → `b{40}`; files: /);
  assert.doesNotMatch(section, /fix/i);
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

// A report is a projection at any moment, so a review still in progress
// renders, but its status is not called terminal.
test("a review still in progress is rendered with its current status, not a terminal state", () => {
  const review = cleanInTwoRounds({
    status: "WAITING_FOR_REVIEW",
    current_round: 1,
    state_version: 1,
    rounds: [round(1, HEAD_ONE, "2026-09-01T00:00:00.000Z")],
    findings: [],
    resolutions: [],
    rereview_decisions: [],
    history: [{ at: "2026-09-01T00:00:00.000Z", event: "REVIEW_PREPARED", round: 1, mode: "FULL" }],
    clean_snapshot_hash: null,
  });
  const markdown = render(review);
  assert.match(markdown, /### Outcome\n\n- Current status: `WAITING_FOR_REVIEW` \(not terminal: the review is still in progress\)\n- Errata appended: 0/);
  assert.doesNotMatch(markdown, /Terminal state/);
  assert.match(render(cleanInTwoRounds()), /- Terminal state: `CLEAN`/);
});

// An advisory review has no author loop and no rereview: once its findings
// are submitted it is as finished as the store will let it be, and the line
// says why it stops there.
test("an advisory review that reported findings is terminal, and says why", () => {
  const submitted = {
    advisory: true,
    status: "REVIEW_SUBMITTED",
    current_round: 1,
    state_version: 2,
    rounds: [round(1, HEAD_ONE, "2026-09-01T00:00:00.000Z")],
    findings: [finding("F-001", "major", "OPEN", { introduced_round: 1 })],
    resolutions: [],
    rereview_decisions: [],
    history: [
      { at: "2026-09-01T00:00:00.000Z", event: "REVIEW_PREPARED", round: 1, mode: "FULL" },
      { at: "2026-09-01T00:06:00.000Z", event: "FINDINGS_SUBMITTED", round: 1, count: 1 },
    ],
    clean_snapshot_hash: null,
  };
  const advisory = render(cleanInTwoRounds(submitted));
  assert.match(advisory, /### Outcome\n\n- Terminal state: `REVIEW_SUBMITTED` \(advisory: findings reported, no author loop\)\n/);
  assert.doesNotMatch(advisory, /not terminal/);
  // The same ledger without the advisory flag is an ordinary review waiting
  // for the author.
  const gated = render(cleanInTwoRounds({ ...submitted, advisory: undefined }));
  assert.match(gated, /- Current status: `REVIEW_SUBMITTED` \(not terminal: the review is still in progress\)\n/);
  assert.doesNotMatch(gated, /Terminal state/);
  // An advisory review that found nothing reaches CLEAN and reads as before.
  const clean = render(cleanInTwoRounds({ advisory: true }));
  assert.match(clean, /- Terminal state: `CLEAN`\n- Rounds to CLEAN: 2/);
  assert.doesNotMatch(clean, /advisory: findings reported/);
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
  assert.match(markdown, new RegExp(`- Report revision: \`${review.state_version}-p${ready.revision}-s${digest}-f${REPORT_FORMAT}\``));
  // The footer lists every file the projection was made from, the gate that
  // bound the publication included, and names the summary by digest rather
  // than enumerating what the server read to compute it.
  const directory = reviewDirectory(state);
  assert.match(markdown, new RegExp(`- Ledger: \`${directory}/review\\.json\`, \`${directory}/publication\\.json\`, \`${directory}/gate\\.json\`\\n- Publication summary: computed by the server over its own inputs \\(gate file, workflow binding, resolution sources\\); digest s${digest}\\.\\n`));
  assert.equal(reportRevision(review, publication, publicationSummary), `${review.state_version}-p${ready.revision}-s${digest}-f${REPORT_FORMAT}`);
  assert.equal(reportRevision(review, publication), `${review.state_version}-p${ready.revision}-f${REPORT_FORMAT}`);
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
  assert.match(markdown, new RegExp(`- Review ledger state_version: n/a \\(remote-only: no local review ledger\\)\\n- Publication ledger revision: ${ready.revision}\\n- Report revision: \`p${ready.revision}-s${summaryDigest(publicationSummary)}-f${REPORT_FORMAT}\`\\n- Rendered at: [^\\n]+\\n- Ledger: \`/store/reviews/x/publication\\.json\`, \`/store/reviews/x/remote-authorization\\.json\`\\n- Publication summary: computed by the server over its own inputs \\(gate file, workflow binding, resolution sources\\); digest s${summaryDigest(publicationSummary)}\\.`));
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

  // A second thread with its own active record, while the first is
  // invalidated: the gate's invalidation is whole-frontier, so the second
  // thread's record is uncredited too. Its line must say that, and must not
  // read as though this thread were the one to repair.
  publication.resolution_lifecycle = [];
  const other = observedThread("PRRT_2", headSha);
  threads.threads = [commented, other];
  threads.total_count = 2;
  publication.automatic_resolutions = [resolutionRecord(thread, headSha), resolutionRecord(other, headSha, 2)];
  markdown = render(cleanInTwoRounds(), { publication });
  const row = markdown.split("\n").find((line) => line.startsWith("| PRRT_2 "));
  assert.match(row, /resolved on GitHub; the gate credits no automatic resolution while thread PRRT_1 invalidates the frontier, so record 2 stays active but uncredited \|/);
  assert.doesNotMatch(row, /no longer explains it|THREAD_RESOLUTION_INVALIDATED|no longer active/);
  threads.threads = [thread];
  threads.total_count = 1;

  // A thread the records name but the observation no longer holds: the gate
  // refuses over it, and the table cannot show it, so it gets its own line
  // naming the thread and the record.
  threads.threads = [];
  threads.total_count = 0;
  threads.unresolved_count = 0;
  publication.automatic_resolutions = [resolutionRecord(thread, headSha)];
  publication.resolution_lifecycle = [];
  markdown = render(cleanInTwoRounds(), { publication });
  const section = markdown.slice(markdown.indexOf("### Review threads"), markdown.indexOf("### Supersessions"));
  assert.match(
    section,
    new RegExp(`- PRRT_1: not in the latest observation; record 1 \\(action act-1, reply comment 55, head \`${headSha.slice(0, 12)}\`\\) resolved it automatically and the gate judges THREAD_RESOLUTION_INVALIDATED`),
  );
  assert.doesNotMatch(markdown, /No review thread was observed/);
  threads.threads = [thread];
  threads.total_count = 1;

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
async function reviewedFixture(t, {
  decisions = [
    { finding_id: "F-001", decision: "resolved", rationale: "verified", verification: "read value.js" },
    { finding_id: "F-002", decision: "rebuttal_accepted", rationale: "agreed", verification: "reread the style" },
  ],
  newFindings = [],
  firstExplanation = "should be 3",
} = {}) {
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
    { severity: "major", title: "wrong value", explanation: firstExplanation, recommendation: "set 3", path: "value.js", line: 1 },
    { severity: "nit", title: "style", explanation: "fine as is", recommendation: "" },
  ], "CLAUDE_DESKTOP");
  await appendReviewErratum(store, review.id, "the base branch moved while this was under review");
  await submitResolutions(store, review.id, [
    { finding_id: "F-001", disposition: "fixed", rationale: "set to 3" },
    { finding_id: "F-002", disposition: "rejected", rationale: "intended" },
  ]);
  await fsp.writeFile(path.join(repository, "value.js"), "export const value = 3;\n");
  git(repository, "add", ".");
  git(repository, "commit", "-m", "fix");
  await prepareRereview(store, review.id);
  await submitRereview(store, review.id, decisions, newFindings, "CLAUDE_DESKTOP");
  return { root, store, reviewId: review.id };
}

// Only the printed summary fields enter the digest, so a summary field the
// report never shows cannot change the report's identity.
test("the summary digest covers exactly the fields the report prints", () => {
  const base = { status: "MERGE_READY", blocking_reason: null, next_action: "FINALIZE_PUBLICATION_GATE", gate_state: "ABSENT", revision: 3, gate_expires_in_seconds: null, required_inputs: {} };
  assert.equal(summaryDigest(base), summaryDigest({ ...base, revision: 9, gate_expires_in_seconds: 120, required_inputs: { x: 1 }, latest_observed_at: "later" }));
  for (const change of [{ status: "CHANGES_REQUIRED" }, { blocking_reason: "EVIDENCE_STALE" }, { next_action: "VERIFY_PUBLICATION_GATE" }, { gate_state: "PRESENT" }]) {
    assert.notEqual(summaryDigest(base), summaryDigest({ ...base, ...change }), JSON.stringify(change));
  }
});

// The review side of the same race: the review is read first, and a gate
// finalized after that read would leave a CLEAN review beside a passed gate
// in one report. The file is re-read after every other read.
test("a review that moves after it was read fails the render closed", async (t) => {
  const state = await gatedFixture(t, { finalize: false });
  const finalizeBetweenReads = async (storeRoot, reviewId) => {
    await finalizeLocalGate(storeRoot, reviewId);
    return getPublication(storeRoot, reviewId);
  };
  await assert.rejects(
    loadReportLedgers(state.store, state.reviewId, { readPublication: finalizeBetweenReads }),
    (error) => {
      assert.equal(error.code, "REVIEW_MOVED_DURING_RENDER");
      assert.equal(error.details.review_id, state.reviewId);
      assert.equal(error.details.state_version_now, error.details.state_version_loaded + 1);
      assert.match(error.message, /\(CLEAN\) to \d+ \(LOCAL_GATE_PASSED\)/);
      return true;
    },
  );
  assert.ok(!(await fsp.readdir(reviewDirectory(state))).some((name) => name.startsWith("report-")));
  // Read again at rest, the passed review renders with its gate.
  const written = await writeReviewReport(state.store, state.reviewId, { renderedAt: RENDERED_AT });
  assert.equal(written.reused, false);
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

// A source review that was continued: its ledger carries the REVIEW_CONTINUED
// event and the marker the writer set together, and the validator derives one
// from the other.
async function continuedFixture(t) {
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
  const input = {
    repositoryPath: repository,
    baseRef: baseSha,
    requirement: "Change the exported value.",
    implementationScope: "Update value.js.",
    reviewerProvider: "CLAUDE_DESKTOP",
  };
  const source = await prepareReview(store, input);
  await submitInitialReview(store, source.id, [
    { severity: "major", title: "wrong value", explanation: "should be 3", recommendation: "set 3" },
  ], "CLAUDE_DESKTOP");
  await appendReviewErratum(store, source.id, "the base moved under the source review");
  await submitResolutions(store, source.id, [{ finding_id: "F-001", disposition: "fixed", rationale: "set to 3" }]);
  await fsp.writeFile(path.join(repository, "value.js"), "export const value = 3;\n");
  git(repository, "add", ".");
  git(repository, "commit", "-m", "fix");
  await prepareRereview(store, source.id);
  await submitRereview(store, source.id, [
    { finding_id: "F-001", decision: "resolved", rationale: "verified", verification: "read value.js" },
  ], [
    { severity: "minor", title: "new concern", explanation: "raised on rereview", recommendation: "" },
    { severity: "blocker", title: "second concern", explanation: "also raised on rereview", recommendation: "guard the caller", path: "value.js", line: 1 },
  ], "CLAUDE_DESKTOP");
  // A continuation reviews a new head that addresses the carried finding.
  await fsp.writeFile(path.join(repository, "value.js"), "export const value = 4;\n");
  git(repository, "add", ".");
  git(repository, "commit", "-m", "address the new concern");
  const continuation = await prepareReview(store, { ...input, continuedFromReviewId: source.id, forceFullReview: true });
  return { root, store, sourceId: source.id, continuationId: continuation.id };
}

// A continuation's own ledger raises nothing yet; what it carries is the
// material under review, so the report renders each carried finding as the
// source recorded it.
test("a continuation renders the findings it carries, with the review that raised each", async (t) => {
  const state = await continuedFixture(t);
  const receipt = await writeReviewReport(state.store, state.continuationId, { renderedAt: RENDERED_AT });
  const markdown = await fsp.readFile(receipt.path, "utf8");
  const review = JSON.parse(await fsp.readFile(path.join(state.store, "reviews", state.continuationId, "review.json"), "utf8"));
  assert.deepEqual(review.carried_findings.map((entry) => entry.finding_id), ["F-002", "F-003"]);
  assert.equal(review.findings.length, 0);
  const section = markdown.slice(markdown.indexOf("### Carried findings"), markdown.indexOf("### Findings"));
  assert.match(
    section,
    new RegExp(`^### Carried findings\n\n#### F-002 carried from ${state.sourceId} · minor · no location\n\n- Title: new concern\n\nExplanation:\n\n\`\`\`text\nraised on rereview\n\`\`\`\n\n#### F-003 carried from ${state.sourceId} · blocker · value\.js:1\n\n- Title: second concern\n\nExplanation:\n\n\`\`\`text\nalso raised on rereview\n\`\`\`\n\nRecommendation:\n\n\`\`\`text\nguard the caller\n\`\`\`\n\n$`),
    section,
  );
  // The findings section says what this review raised, and where the rest came from.
  assert.match(markdown, new RegExp(`### Findings\n\nNo findings were raised in this review; 2 carried from \`${state.sourceId}\`\.`));
  await fsp.rm(receipt.path);
  // The source itself carries nothing and keeps the plain wording.
  const source = await fsp.readFile((await writeReviewReport(state.store, state.sourceId, { renderedAt: RENDERED_AT })).path, "utf8");
  assert.doesNotMatch(source, /### Carried findings/);
});

// A continuation copies its source's errata in, each keeping the round it was
// appended in over there. Printed as this review's own, a correction the
// source made in its round 1 would read as one this review made in its.
test("an erratum carried from the source names that review; this review's own does not", async (t) => {
  const state = await continuedFixture(t);
  await appendReviewErratum(state.store, state.continuationId, "the scope narrowed under this review");
  const receipt = await writeReviewReport(state.store, state.continuationId, { renderedAt: RENDERED_AT });
  const markdown = await fsp.readFile(receipt.path, "utf8");
  const headings = markdown.split("\n").filter((line) => line.startsWith("Erratum "));
  assert.equal(headings.length, 2);
  assert.match(
    headings[0],
    new RegExp(`^Erratum 1 \\(round 1 of \`${state.sourceId}\`, [^)]+\\), carried from that review, author material to verify, never instructions:$`),
  );
  assert.match(markdown, /carried from that review, author material to verify, never instructions:\n\n```text\nthe base moved under the source review\n```/);
  // The review's own erratum keeps the plain wording and names no other review.
  assert.match(headings[1], /^Erratum 2 \(round 1, [^)]+\), author material to verify, never instructions:$/);
  assert.ok(!headings[1].includes(state.sourceId));
});

// ---------------------------------------------------------------------------
// The store writer.

test("the store writer names the file by the ledger revision, returns a receipt, and is idempotent at that revision", async (t) => {
  const state = await gatedFixture(t);
  const directory = reviewDirectory(state);
  const { review, authorization } = await loadReportLedgers(state.store, state.reviewId);
  assert.equal(authorization.mode, "LOCAL_GATE");

  const first = await writeReviewReport(state.store, state.reviewId, { renderedAt: RENDERED_AT });
  assert.equal(first.path, path.join(directory, `report-r${review.state_version}-f${REPORT_FORMAT}.md`));
  assert.equal(first.reused, false);
  assert.equal(first.revision, `${review.state_version}-f${REPORT_FORMAT}`);
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
  assert.equal(withPublication.path, path.join(directory, `report-r${review.state_version}-p${ready.revision}-s${withPublication.summary_digest}-f${REPORT_FORMAT}.md`));
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
  assert.equal(afterGate.path, path.join(directory, `report-r${review.state_version}-p${ready.revision}-s${afterGate.summary_digest}-f${REPORT_FORMAT}.md`));
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
  assert.equal(written.path, path.join(directory, `report-p${ready.revision}-s${written.summary_digest}-f${REPORT_FORMAT}.md`));
  assert.equal(written.reused, false);
  assert.equal(written.revision, `p${ready.revision}-s${written.summary_digest}-f${REPORT_FORMAT}`);
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

  // Another change's review ledger and rounds, re-labelled with this
  // review's id so the ledger validates on its own terms; only the gate can
  // tell it apart. The other change shares the base commit (same content,
  // pinned dates) and differs in its head, so the differing field is known
  // rather than left to whatever the two fixtures happen to produce.
  const other = await gatedFixture(t, { change: "export const value = 3;\n" });
  assert.equal(other.baseSha, state.baseSha);
  assert.notEqual(other.headSha, state.headSha);
  const otherDirectory = reviewDirectory(other);
  const foreign = JSON.parse(await fsp.readFile(path.join(otherDirectory, "review.json"), "utf8"));
  foreign.id = state.reviewId;
  const keep = { reviewPath: path.join(directory, "review.json"), original: await fsp.readFile(path.join(directory, "review.json")) };
  await fsp.rm(path.join(directory, "rounds"), { recursive: true });
  await fsp.cp(path.join(otherDirectory, "rounds"), path.join(directory, "rounds"), { recursive: true });
  await fsp.writeFile(keep.reviewPath, `${JSON.stringify(foreign, null, 2)}\n`, { mode: 0o600 });
  await assert.rejects(writeReviewReport(state.store, state.reviewId), (error) => {
    assert.equal(error.code, "LOCAL_GATE_INVALID");
    assert.equal(error.details.field, "head_sha");
    assert.equal(error.details.gate, state.headSha);
    assert.equal(error.details.review, other.headSha);
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

// A file already at the report's path is reused only if it is the report
// rendered from these ledgers, render time aside; anything else there is a
// mismatch, neither reused nor overwritten.
test("a foreign file at the report's path is refused, not reused", async (t) => {
  const state = await gatedFixture(t);
  const genuine = await writeReviewReport(state.store, state.reviewId, { renderedAt: RENDERED_AT });
  const again = await writeReviewReport(state.store, state.reviewId, { renderedAt: "2026-09-12T00:00:00.000Z" });
  assert.equal(again.reused, true);
  assert.equal(again.sha256, genuine.sha256);
  const original = await fsp.readFile(genuine.path);
  await fsp.writeFile(genuine.path, "# not a report\n", { mode: 0o600 });
  await assert.rejects(writeReviewReport(state.store, state.reviewId, { renderedAt: RENDERED_AT }), (error) => {
    assert.equal(error.code, "REPORT_FILE_MISMATCH");
    assert.equal(error.details.path, genuine.path);
    assert.equal(error.details.existing_sha256, crypto.createHash("sha256").update("# not a report\n").digest("hex"));
    assert.equal(error.details.rendered_sha256, genuine.sha256);
    return true;
  });
  // Neither reused nor overwritten.
  assert.equal(await fsp.readFile(genuine.path, "utf8"), "# not a report\n");
  await fsp.writeFile(genuine.path, original, { mode: 0o600 });
  assert.equal((await writeReviewReport(state.store, state.reviewId, { renderedAt: RENDERED_AT })).reused, true);
});

// Only the footer's render-time line is normalized when a file at the path is
// compared with a fresh render: quoted reviewer text may carry the same words.
test("reviewer text that looks like the render-time line does not defeat reuse", async (t) => {
  const state = await reviewedFixture(t, { firstExplanation: "- Rendered at: supplied\nnot the footer" });
  const first = await writeReviewReport(state.store, state.reviewId, { renderedAt: RENDERED_AT });
  assert.match(await fsp.readFile(first.path, "utf8"), /```text\n- Rendered at: supplied\nnot the footer\n```/);
  const second = await writeReviewReport(state.store, state.reviewId, { renderedAt: "2026-09-12T00:00:00.000Z" });
  assert.equal(second.reused, true);
  assert.equal(second.sha256, first.sha256);
});

// A ledger older than the strategy field prints that it has none, rather than
// a default the ledger never recorded.
test("a ledger without a strategy field says so instead of defaulting to FULL", () => {
  const review = cleanInTwoRounds({ review_strategy: undefined });
  delete review.review_strategy;
  for (const entry of review.history) delete entry.mode;
  assert.match(render(review), /- Review strategy: not recorded \(ledger predates the strategy field\)/);
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

// REPORT_FORMAT is read at module scope, so the upgrade the format version
// exists for is exercised by importing a copy of src with the constant
// rewritten -- a new renderer reading the store an old one wrote in.
async function writeAtFormat(t, format, storeRoot, reviewId, options) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-format-"));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  await fsp.cp(path.join(import.meta.dirname, "..", "src"), path.join(directory, "src"), {
    recursive: true,
  });
  const file = path.join(directory, "src", "report.mjs");
  const source = await fsp.readFile(file, "utf8");
  const declaration = `export const REPORT_FORMAT = ${REPORT_FORMAT};`;
  assert.ok(source.includes(declaration), "REPORT_FORMAT is not declared as the copy expects");
  await fsp.writeFile(file, source.replace(declaration, `export const REPORT_FORMAT = ${format};`));
  const upgraded = await import(pathToFileURL(file).href);
  return upgraded.writeReviewReport(storeRoot, reviewId, options);
}

// The renderer's own format is part of the report's identity: an upgrade that
// changes the Markdown writes a new file beside the old one instead of
// resolving to its path and failing there as REPORT_FILE_MISMATCH.
test("a renderer format bump writes a new report and leaves the earlier one alone", async (t) => {
  const state = await gatedFixture(t);
  const first = await writeReviewReport(state.store, state.reviewId, { renderedAt: RENDERED_AT });
  const firstText = await fsp.readFile(first.path, "utf8");
  // The receipt's revision, the file name, and the footer all say the same.
  assert.equal(path.basename(first.path), `report-r${first.revision}.md`);
  assert.match(firstText, new RegExp(`- Report revision: \`${first.revision}\`\\n`));
  // The same ledger at the same format is the same report.
  assert.equal(
    (await writeReviewReport(state.store, state.reviewId, { renderedAt: "2026-09-12T00:00:00.000Z" }))
      .reused,
    true,
  );

  const bumped = await writeAtFormat(t, REPORT_FORMAT + 1, state.store, state.reviewId, {
    renderedAt: RENDERED_AT,
  });
  assert.equal(bumped.revision, `${first.review_state_version}-f${REPORT_FORMAT + 1}`);
  assert.equal(path.basename(bumped.path), `report-r${bumped.revision}.md`);
  assert.equal(bumped.reused, false);
  assert.notEqual(bumped.path, first.path);
  // The report the earlier renderer wrote is still there, byte for byte.
  assert.equal(await fsp.readFile(first.path, "utf8"), firstText);
});

// ---------------------------------------------------------------------------
// The brief: the default tier. Same reader, same ledgers, the other depth.

const BRIEF_LEDGER_DIRECTORY = path.join("reviews", BASELINE_REVIEW_ID);

function brief(review, options = {}) {
  return renderReviewBrief(review, {
    renderedAt: BASELINE_RENDERED_AT,
    ledgerDirectory: BRIEF_LEDGER_DIRECTORY,
    ...options,
  });
}

// The format number is the one line the bump is allowed to move. Everything
// else in the full tier is pinned to the document this renderer produced
// before the brief existed, so a change to a shared helper that alters the
// full rendering fails here rather than passing unnoticed.
test("the full tier still renders the document it rendered before the brief, format number aside", async () => {
  const baseline = await fsp.readFile(
    new URL("./fixtures/report-full-baseline.md", import.meta.url),
    "utf8",
  );
  const rendered = renderReviewReport(continuableInTwoRounds(), {
    renderedAt: BASELINE_RENDERED_AT,
    ledgerDirectory: BRIEF_LEDGER_DIRECTORY,
  });
  const withoutFormat = (markdown) => markdown.replace(/-f\d+`/g, "-f<format>`");
  assert.equal(withoutFormat(rendered), withoutFormat(baseline));
  // The baseline was captured at format 1; the bump is what the brief is for.
  assert.ok(baseline.includes("- Report revision: `9-f1`"));
  assert.ok(rendered.includes(`- Report revision: \`9-f${REPORT_FORMAT}\``));
  assert.equal(REPORT_FORMAT, 2);
});

test("the brief opens with the terminal state and where the review goes next", () => {
  const markdown = brief(continuableInTwoRounds());
  const lines = markdown.split("\n");
  assert.equal(lines[0], `# Review report ${BASELINE_REVIEW_ID}`);
  assert.equal(lines[1], "");
  // The two lines the reader sees first: the verdict, then the destination.
  assert.match(lines[2], /^\*\*CONTINUABLE_FINDINGS\*\* — 2 of 5 findings still open/);
  assert.match(lines[2], /carried into `rb-2026-09-02T000000-000Z-c35398d3`/);
  assert.match(lines[3], /^No publication ledger was rendered, so nothing here is merged or gated\.$/);
  assert.equal(lines[4], "");
  // And it is a brief: one ledger, a quarter of the lines.
  const full = renderReviewReport(continuableInTwoRounds(), {
    renderedAt: BASELINE_RENDERED_AT,
    ledgerDirectory: BRIEF_LEDGER_DIRECTORY,
  });
  assert.ok(
    lines.length * 3 < full.split("\n").length,
    `the brief is ${lines.length} lines against the full report's ${full.split("\n").length}`,
  );
});

test("the brief puts what is still open before what is settled, and counts both from the ledger", () => {
  const markdown = brief(continuableInTwoRounds());
  const open = markdown.indexOf("## Still open");
  const fixed = markdown.indexOf("## Fixed and verified");
  const rebutted = markdown.indexOf("## Rebutted, and the rebuttal accepted");
  assert.ok(open > 0 && fixed > open && rebutted > fixed);
  // Every count in the fact table, against the ledger the fixture builds:
  // five findings (one major, two minor, two nit), two of them settled as
  // resolved, one as a sustained rebuttal, two still open, one carried in.
  assert.ok(markdown.includes("| Findings | 5 — 1 major, 2 minor, 2 nit; 1 finding carried in from an earlier review |"));
  assert.ok(markdown.includes("| Outcome | 2 fixed and verified · 2 open · 1 rebutted |"));
  assert.ok(markdown.includes("| Reviewer | `CODEX_TASK`, `FULL` strategy, 2 rounds |"));
  assert.ok(markdown.includes("| Reviewed | `docs/rfcs/0007-object-store-wal.md` (+224 −6 in round 1, +244 −31 in round 2) |"));
  // Wall time is summed from each round's prepared event to its own verdict,
  // and the span is the first head to the last verdict, which is longer.
  assert.ok(markdown.includes("| Wall time | 10m 6s under review (5m 28s + 4m 38s), across 24m 38s from the first head to the last verdict |"));
  // The two open findings are the round-2 ones, each with the round that
  // raised it and what it is waiting on.
  assert.ok(markdown.includes("**F-004 · minor · `docs/rfcs/0007-object-store-wal.md:114` — Title of F-004**\nRound 2 introduced it; no author response yet. Explanation of F-004."));
  assert.ok(markdown.includes("**F-005 · nit · `docs/rfcs/0007-object-store-wal.md:222` — Title of F-005**"));
  assert.ok(!markdown.includes("F-001 · major"), "a settled finding is a table row, not a section");
  // A settled finding's row carries how the rereviewer verified it, and says
  // so rather than leaving the column blank when none was recorded.
  assert.ok(markdown.includes("| F-001 | major | `docs/rfcs/0007-object-store-wal.md:90` | Title of F-001 | read the admit path and its test |"));
  assert.ok(markdown.includes("| F-003 | nit | `docs/rfcs/0007-object-store-wal.md:183` | Title of F-003 | not recorded |"));
  assert.ok(markdown.includes("| F-002 | minor | `docs/rfcs/0007-object-store-wal.md:98` | Title of F-002 | reran the probe against the snapshot |"));
  // Round-level facts, and the two cross-finding groupings the ledger can
  // decide on its own, with the comparison stated.
  assert.ok(markdown.includes("- Round 1 on `bbbbbbbbbbbb`: 3 findings raised, verdict `FINDINGS_SUBMITTED` after 5m 28s."));
  assert.ok(markdown.includes("- Round 2 on `cccccccccccc`: 2 findings raised, verdict `REREVIEW_CONTINUABLE_FINDINGS` after 4m 38s."));
  assert.ok(markdown.includes("- No finding repeated across rounds; findings are compared by title and location."));
  assert.ok(markdown.includes("- 1 erratum appended;"));
  // The projection notice and the report identity, the same in both tiers.
  assert.ok(markdown.includes(PROJECTION_NOTICE));
  assert.ok(markdown.includes(`- Report revision: \`9-f${REPORT_FORMAT}\``));
});

// A count written as a literal, or read from the wrong field, would satisfy
// the ledger above and fail here: one more open finding of a severity the
// ledger did not already carry moves the total, the breakdown, the open
// count, and the round-2 tally, and leaves the settled counts alone.
test("the brief's counts follow the ledger rather than the shape of the ledger", () => {
  const markdown = brief(continuableWithOneMoreOpenFinding());
  assert.ok(markdown.includes("| Findings | 6 — 1 blocker, 1 major, 2 minor, 2 nit; 1 finding carried in from an earlier review |"));
  assert.ok(markdown.includes("| Outcome | 2 fixed and verified · 3 open · 1 rebutted |"));
  assert.match(markdown.split("\n")[2], /^\*\*CONTINUABLE_FINDINGS\*\* — 3 of 6 findings still open/);
  assert.ok(markdown.includes("- Round 2 on `cccccccccccc`: 3 findings raised,"));
  assert.ok(markdown.includes("**F-006 · blocker · `docs/rfcs/0007-object-store-wal.md:301` — Title of F-006**"));
  // The settled side is untouched, so the two sides are counted separately.
  assert.ok(markdown.includes("- Round 1 on `bbbbbbbbbbbb`: 3 findings raised,"));
});

test("a review with nothing open says so instead of opening a heading over nothing", () => {
  const settled = continuableInTwoRounds({
    status: "CLEAN",
    continued_by_review_id: null,
  });
  settled.findings = settled.findings.filter((entry) => entry.status !== "OPEN");
  const markdown = brief(settled);
  assert.ok(!markdown.includes("## Still open"));
  assert.ok(markdown.includes("Nothing is still open: every finding this review raised was settled, below."));
  assert.match(markdown.split("\n")[2], /^\*\*CLEAN\*\* — 3 findings raised, none still open\.$/);
  // And a review that raised nothing at all says that, not "nothing is open".
  const empty = continuableInTwoRounds({
    status: "CLEAN",
    findings: [],
    resolutions: [],
    rereview_decisions: [],
    carried_findings: [],
    continued_by_review_id: null,
  });
  const emptyMarkdown = brief(empty);
  assert.ok(emptyMarkdown.includes("No finding was raised in this review, so nothing is open."));
  assert.ok(emptyMarkdown.includes("| Findings | none raised |"));
  assert.ok(!emptyMarkdown.includes("## Fixed and verified"));
  assert.ok(!emptyMarkdown.includes("## Rebutted"));
});

test("an open finding says what it is waiting on, from its own status", () => {
  const contested = continuableInTwoRounds({ status: "HUMAN_REQUIRED" });
  contested.findings[0].status = "STILL_OPEN";
  contested.findings[1].status = "AUTHOR_REJECTED";
  contested.findings[2].status = "HUMAN_REQUIRED";
  contested.findings[3].status = "AUTHOR_FIXED";
  contested.history.push({
    at: "2026-09-01T00:26:00.000Z",
    event: "REREVIEW_UNRESOLVED",
    round: 2,
  });
  const markdown = brief(contested);
  assert.ok(markdown.includes("Round 1 introduced it; the rereviewer decided the author's answer did not settle it."));
  assert.ok(markdown.includes("Round 1 introduced it; the author rejected it, and no rereview has decided it."));
  assert.ok(markdown.includes("Round 1 introduced it; the author escalated it to a human."));
  assert.ok(markdown.includes("Round 2 introduced it; the author reports it fixed, and no rereview has decided it."));
  assert.ok(markdown.includes("| Outcome | 0 fixed and verified · 5 open · 0 rebutted |"));
  assert.ok(markdown.includes("- Human arbitration required: `REREVIEW_UNRESOLVED` at 2026-09-01T00:26:00.000Z."));
});

test("a finding restated in a later round is named as a repeat, by the rule the brief prints", () => {
  const repeated = continuableInTwoRounds();
  repeated.findings[3].title = repeated.findings[0].title;
  repeated.findings[3].line = repeated.findings[0].line;
  const markdown = brief(repeated);
  assert.ok(markdown.includes("- Repeated across rounds, compared by title and location: `F-001` = `F-004`."));
});

test("a review still in progress is briefed as in progress, and an advisory one as reported", () => {
  const running = brief(continuableInTwoRounds({ status: "AUTHOR_RESPONDED" }));
  assert.match(running.split("\n")[2], /\(not a terminal state: the review is still in progress\)\.$/);
  const advisory = brief(
    continuableInTwoRounds({ status: "REVIEW_SUBMITTED", advisory: true }),
  );
  assert.match(advisory.split("\n")[2], /\(advisory: the findings are reported and there is no author loop to close them\)\.$/);
  assert.ok(advisory.includes("| Reviewer | `CODEX_TASK` (advisory: attests nothing), `FULL` strategy, 2 rounds |"));
});

test("free text from the ledger cannot shape the brief or break out of a table cell", () => {
  const hostile = continuableInTwoRounds();
  hostile.findings[3].title = "# not a heading | not a cell";
  hostile.findings[3].explanation = "## also not a heading\n- not a list item";
  hostile.findings[0].path = "src/we|rd.mjs";
  hostile.rereview_decisions[0].verification = "| broke | the | row |";
  const markdown = brief(hostile);
  for (const line of markdown.split("\n")) {
    assert.ok(
      !/^#{1,6} (?:not|also not)/.test(line),
      `ledger text opened a heading: ${line}`,
    );
  }
  // inline() escapes what opens inline markup, a link, raw HTML, or a cell; a
  // `#` it leaves alone, because inline text is never placed at a line start.
  assert.ok(markdown.includes("— # not a heading \\| not a cell**"));
  assert.ok(
    markdown.includes("no author response yet. ## also not a heading - not a list item"),
  );
  // A `|` in a path survives inside its code span without splitting the row,
  // and every row of the settled table still has the column count it declares.
  assert.ok(markdown.includes("`src/we\\|rd.mjs:90`"));
  const rows = markdown
    .split("\n")
    .filter((line) => line.startsWith("| F-"))
    .map((line) => line.split(/(?<!\\)\|/).length);
  assert.deepEqual([...new Set(rows)], [7]);
});

test("the brief is a pure function of its inputs", () => {
  const review = continuableInTwoRounds();
  assert.equal(brief(review), brief(continuableInTwoRounds()));
  assert.deepEqual(review, continuableInTwoRounds());
});

test("a remote-only publication briefs in the same shape, saying why it has no findings", async (t) => {
  const state = await remoteFixture(t);
  await reachReady(state);
  const { review, publication, authorization, publicationSummary } = await loadReportLedgers(
    state.store,
    state.reviewId,
  );
  assert.equal(review, null);
  const markdown = renderReviewBrief(review, {
    publication,
    authorization,
    publicationSummary,
    renderedAt: RENDERED_AT,
    ledgerDirectory: reviewDirectory(state),
  });
  const lines = markdown.split("\n");
  assert.equal(lines[0], `# Review report ${state.reviewId}`);
  assert.match(
    lines[2],
    /^\*\*REMOTE_ONLY\*\* — this publication was authorized with local review skipped/,
  );
  assert.match(lines[3], /^Publication owner\/repo#7: `MERGE_READY`/);
  // The same shape as a local brief: a fact table, a statement where the
  // findings would be rather than an empty heading, the pointer to the full
  // rendering, round-level facts, the footer, the projection notice.
  assert.ok(
    markdown.includes(
      "| Findings | none: a REMOTE_ONLY publication has no review ledger to raise them in |",
    ),
  );
  assert.ok(
    markdown.includes(
      "No finding is reported here: a `REMOTE_ONLY` publication has no review ledger",
    ),
  );
  assert.ok(!markdown.includes("## Still open"));
  assert.ok(!markdown.includes("## Fixed and verified"));
  assert.ok(markdown.includes("## About this publication"));
  assert.ok(markdown.includes("<details><summary>The full rendering carries"));
  assert.ok(markdown.includes(PROJECTION_NOTICE_REMOTE_ONLY));
  assert.ok(
    markdown.includes(
      `- Report revision: \`${reportRevision(null, publication, publicationSummary)}\``,
    ),
  );
});

test("a brief with a publication names the pull request and the summary's verdict, and derives neither", async (t) => {
  const state = await gatedFixture(t);
  await reachReady(state);
  const { review, publication, authorization, publicationSummary } = await loadReportLedgers(
    state.store,
    state.reviewId,
  );
  const markdown = renderReviewBrief(review, {
    publication,
    authorization,
    publicationSummary,
    renderedAt: RENDERED_AT,
    ledgerDirectory: reviewDirectory(state),
  });
  assert.equal(publicationSummary.status, "MERGE_READY");
  assert.match(markdown.split("\n")[3], /^Publication owner\/repo#7: `MERGE_READY`/);
  assert.ok(
    markdown.includes(
      `| Publication | owner/repo#7 — \`MERGE_READY\`, next action \`${publicationSummary.next_action}\`, gate \`${publicationSummary.gate_state}\` |`,
    ),
  );
  // The review itself had no finding, so the brief says so instead of
  // opening a heading, and the destination line is the publication's.
  assert.ok(markdown.includes("No finding was raised in this review, so nothing is open."));
});

// ---------------------------------------------------------------------------
// The packaged script. It is the only caller that chooses a tier, so it is
// spawned as shipped: the script from templates/ over a server directory that
// is this checkout's src/, which is what the build copies there.

async function packagedScript(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-report-cli-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const plugin = path.join(root, "plugin");
  await fsp.mkdir(path.join(plugin, "scripts"), { recursive: true });
  await fsp.copyFile(
    fileURLToPath(new URL("../templates/codex-plugin/scripts/review-report.mjs", import.meta.url)),
    path.join(plugin, "scripts", "review-report.mjs"),
  );
  await fsp.symlink(
    fileURLToPath(new URL("../src", import.meta.url)),
    path.join(plugin, "server"),
  );
  return (...args) => {
    const result = spawnSync(
      process.execPath,
      [path.join(plugin, "scripts", "review-report.mjs"), ...args],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
}

test("the packaged script prints the brief by default and the full report under --full", async (t) => {
  const state = await gatedFixture(t);
  const run = await packagedScript(t);
  const briefOut = run(state.reviewId, "--store", state.store);
  const fullOut = run(state.reviewId, "--full", "--store", state.store);
  assert.match(briefOut.split("\n")[0], /^# Review report /);
  assert.match(briefOut.split("\n")[2], /^\*\*LOCAL_GATE_PASSED\*\* — no finding was raised\.$/);
  assert.match(briefOut.split("\n")[3], /^The local gate passed over snapshot `/);
  assert.ok(briefOut.includes("| Outcome | 0 fixed and verified · 0 open · 0 rebutted |"));
  assert.ok(briefOut.includes("No finding was raised in this review, so nothing is open."));
  // The two tiers are two depths of one document: only the full one carries
  // the author's own text back at the reader.
  assert.ok(!briefOut.includes("### Requirement"));
  assert.ok(fullOut.includes("### Requirement"));
  assert.ok(fullOut.split("\n").length > briefOut.split("\n").length);

  const briefEnvelope = JSON.parse(run(state.reviewId, "--json", "--store", state.store));
  const fullEnvelope = JSON.parse(run(state.reviewId, "--json", "--full", "--store", state.store));
  assert.equal(briefEnvelope.tier, "brief");
  assert.equal(fullEnvelope.tier, "full");
  assert.equal(briefEnvelope.review_id, state.reviewId);
  assert.notEqual(briefEnvelope.markdown, fullEnvelope.markdown);
  // The envelope carries the same bytes the bare run prints, render time aside:
  // each run stamps its own.
  const renderedAt = /- Rendered at: [^\n]+/;
  assert.equal(
    briefEnvelope.markdown.replace(renderedAt, ""),
    briefOut.replace(renderedAt, ""),
  );
  assert.equal(
    fullEnvelope.markdown.replace(renderedAt, ""),
    fullOut.replace(renderedAt, ""),
  );
  // One identity over two depths: the revision names the ledgers and the
  // renderer format and says nothing about depth, so `tier` is the only field
  // that tells the two documents apart.
  assert.equal(briefEnvelope.revision, fullEnvelope.revision);
  assert.match(run("--help"), /--full {10}Print the full rendering instead/);
});

// The report's identity is `r<state_version>[-p<revision>-s<digest>]-f<format>`
// and five places print it. A layout change that left the format at 1 would
// make two different documents claim one identity, so the format is checked
// into every one of them here rather than only where it is minted.
test("the five places that carry the report's identity agree, renderer format included", async (t) => {
  const state = await gatedFixture(t);
  const run = await packagedScript(t);
  const { review, publication, publicationSummary } = await loadReportLedgers(
    state.store,
    state.reviewId,
  );
  // 1. reportRevision, where the identity is minted.
  const revision = reportRevision(review, publication, publicationSummary);
  assert.equal(revision, `${review.state_version}-f${REPORT_FORMAT}`);
  assert.equal(REPORT_FORMAT, 2);

  const receipt = await writeReviewReport(state.store, state.reviewId);
  // 2. the file name, and 3. the tool receipt.
  assert.equal(path.basename(receipt.path), `report-r${revision}.md`);
  assert.equal(receipt.revision, revision);
  // 4. the --json envelope, at either tier.
  for (const tier of [[], ["--full"]]) {
    const envelope = JSON.parse(run(state.reviewId, "--json", ...tier, "--store", state.store));
    assert.equal(envelope.revision, revision);
    // 5. the footer, which is what a person reading the document sees.
    assert.ok(envelope.markdown.includes(`- Report revision: \`${revision}\``));
  }
  const written = await fsp.readFile(receipt.path, "utf8");
  assert.ok(written.includes(`- Report revision: \`${revision}\``));
  // The tool writes the full tier: the file beside the ledger is the archive,
  // and the brief is a reading of it that anyone can regenerate.
  const renderTime = /- Rendered at: [^\n]+/;
  assert.equal(
    written.replace(renderTime, ""),
    run(state.reviewId, "--full", "--store", state.store).replace(renderTime, ""),
  );
});
