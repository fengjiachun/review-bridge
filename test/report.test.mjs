import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
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

async function gatedFixture(t, { change = "export const value = 2;\n", finalize = true, seed = {}, objectFormat = null } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-report-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const repository = path.join(root, "repo");
  const store = path.join(root, "store");
  await fsp.mkdir(repository);
  git(repository, "init", "-b", "main", ...(objectFormat == null ? [] : [`--object-format=${objectFormat}`]));
  git(repository, "config", "user.name", "Review Bridge Test");
  git(repository, "config", "user.email", "review-bridge@example.invalid");
  await fsp.writeFile(path.join(repository, "value.js"), "export const value = 1;\n");
  // Files a successor's delta can rename or delete exist from the base.
  for (const [file, content] of Object.entries(seed)) {
    await fsp.writeFile(path.join(repository, file), content);
  }
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
  assert.match(markdown, /## Footer\n\n- Review: `rb-2026-09-01T000000-000Z-0badf00d`\n- Review ledger state_version: 6\n- Publication ledger revision: none\n- Report revision: `6`\n- Rendered at: 2026-09-10T12:00:00\.000Z\n- Ledger: `\/store\/reviews\/x\/review\.json`\n/);
  assert.ok(markdown.endsWith(`\n${PROJECTION_NOTICE}\n`));
  assert.match(PROJECTION_NOTICE, /projection of the ledger, not evidence/);
  assert.match(PROJECTION_NOTICE, /rendered from the review ledger and, when present, the publication ledger and its gate listed above, from any parent ledger listed there whose fields this render recomputed, and from the publication summary the server computed/);
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
  // Without the commitment fields the round predates the successor
  // commitment: the proof is relayed as recorded and every item says so.
  const mark = "\\(as recorded; not covered by the snapshot commitment — this ledger predates it\\)";
  assert.match(markdown, new RegExp(`#### Round 1 strategy: \`SUCCESSOR\` \\(unverified proof\\)\n\n- ${mark} Parent review: \`rb-2026-08-31T000000-000Z-00parent\` \\(\`CODEX_TASK\`\\)\n- ${mark} Requirement matches the parent: yes\n- ${mark} Parent head → current head: \`b{40}\` → \`c{40}\`\n- ${mark} Delta: 321 bytes, sha256 \`d{64}\`\n- ${mark} Files in the delta: \`src\\/b\\.mjs\`\n- ${mark} Files deleted in the delta: \`src\\/old\\.mjs\``));
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
  // Records cleared under findings that still read RESOLVED: the response
  // event the history holds now answers nothing, which is caught first.
  await tamper((review) => { review.resolutions = []; review.rereview_decisions = []; }, /history records AUTHOR_RESPONDED for round 1, but no resolution answers a round-1 finding/);
  // Decisions cleared alone: the rereviewed round no longer has a decision
  // for every author response.
  await tamper((review) => { review.rereview_decisions = []; }, /round 2 was rereviewed, but finding "F-001" \(fixed\) has no decision/);
  // The record sets must be complete per round, as the writers demand them.
  await tamper((review) => { review.resolutions.splice(1, 1); }, /round 1 was answered, but finding "F-002" has no resolution/);
  await tamper((review) => { review.rereview_decisions.splice(1, 1); }, /round 2 was rereviewed, but finding "F-002" \(rejected\) has no decision/);
  // The strategy field is required wherever the prepared events record a mode.
  await tamper((review) => { delete review.review_strategy; }, /review_strategy is missing, though the prepared events record a mode/);
  // This review's own errata ride on ERRATUM_APPENDED events, in order.
  await tamper((review) => { review.errata[0].round = 2; }, /erratum 1 \(round 2, [^)]+\) does not match ERRATUM_APPENDED event 1 \(sequence 1, round 1, /);
  await tamper((review) => { review.errata.push({ sequence: 2, at: review.errata[0].at, round: 1, text: "second" }); }, /errata holds 2 of this review's own entries, but the history records 1 ERRATUM_APPENDED event\(s\)/);
  // The top-level strategy is the latest prepared round's.
  await tamper((review) => { review.review_strategy.mode = "SUCCESSOR"; }, /review_strategy\.mode "SUCCESSOR" is not the FULL the latest prepared round recorded/);
  // The prepared event's mode and the round's successor proof must agree.
  await tamper((review) => { review.history[0].mode = "SUCCESSOR"; }, /round 1 was prepared as SUCCESSOR, but its successor proof is absent/);
  await tamper((review) => {
    review.rounds[1].successor = {
      version: 1, parent_review_id: "rb-2026-08-31T000000-000Z-00parent", parent_reviewer_provider: "CODEX_TASK",
      parent_requirement: "x", requirement_match: true, parent_snapshot_hash: "a".repeat(64), parent_gate_sha256: "b".repeat(64),
      base_sha: "1".repeat(40), parent_head_sha: "2".repeat(40), current_head_sha: "3".repeat(40), parent_tree_sha: "4".repeat(40), current_tree_sha: "5".repeat(40),
      changed_files: ["value.js"], deleted_files: [], delta_bytes: 1, delta_sha256: "c".repeat(64),
    };
  }, /round 2 was prepared as FULL, but its successor proof is present/);
  // A decision with no finding.
  await tamper((review) => { review.rereview_decisions.push({ finding_id: "F-009", decision: "resolved", rationale: "x", verification: "", submitted_at: review.updated_at }); }, /a rereview decision names no finding: "F-009"/);
  // A decision with a finding but no resolution behind it: the answered
  // round's record set is incomplete, which is caught before the status
  // derivation (which would refuse it too, deriving no status).
  await tamper((review) => {
    review.history.find((entry) => entry.event === "FINDINGS_SUBMITTED").count = 3;
    review.findings.push({ id: "F-003", introduced_round: 1, severity: "minor", title: "t", explanation: "e", recommendation: "", status: "RESOLVED" });
    review.rereview_decisions.push({ finding_id: "F-003", decision: "resolved", rationale: "x", verification: "", submitted_at: review.updated_at });
  }, /round 1 was answered, but finding "F-003" has no resolution/);
  // A status that does not follow from its own records.
  await tamper((review) => { review.findings[1].status = "RESOLVED"; }, /finding "F-002" is "RESOLVED" but its records derive "REBUTTAL_ACCEPTED"/);
  // Every field the writer sets is held to the writer's own domain and to
  // the rest of the ledger: a round the ledger does not hold, a non-integer
  // round, a bad line, an escaping path, an ID out of position, and a field
  // the writer never sets are each refused by name.
  await tamper((review) => { review.findings[0].introduced_round = 3; }, /finding "F-001" introduced_round 3 is not a round the ledger holds/);
  // A round the ledger does hold, but not the one the history's counts put
  // this position in.
  await tamper((review) => { review.findings[0].introduced_round = 2; }, /finding "F-001" introduced_round 2 is not the round its position derives from the history's counts \(1\)/);
  await tamper((review) => { review.history.find((entry) => entry.event === "FINDINGS_SUBMITTED").count = 1; }, /history counts 1 finding\(s\), but the ledger holds 2/);
  await tamper((review) => { review.findings[0].introduced_round = "1"; }, /finding "F-001" introduced_round "1" is not a round the ledger holds/);
  await tamper((review) => { review.findings[0].line = 0; }, /finding "F-001" line 0 is not absent, or a positive integer/);
  await tamper((review) => { review.findings[0].path = "../secret"; }, /finding "F-001" path "\.\.\/secret" is not absent, or a safe relative path/);
  await tamper((review) => { review.findings[1].id = "F-007"; }, /finding "F-007" id "F-007" is not the position-based finding ID/);
  await tamper((review) => { review.findings[0].reviewer_note = "x"; }, /finding "F-001" carries a field the writer never sets: reviewer_note/);
  await tamper((review) => { delete review.findings[0].explanation; }, /finding "F-001" has no explanation/);
  // A FINDINGS_SUBMITTED that lost its round is refused by name; the gate
  // event, which the writer records without one, is not required to carry it.
  await tamper((review) => { delete review.history.find((entry) => entry.event === "FINDINGS_SUBMITTED").round; }, /history entry 2 \(FINDINGS_SUBMITTED\) has no round/);
  await tamper((review) => { review.history.find((entry) => entry.event === "REREVIEW_PREPARED").round = 0; }, /history entry \d+ \(REREVIEW_PREPARED\) round 0 is not a positive integer/);
  // Cross-field preconditions of the writers, named after the event that
  // could not have been recorded.
  // The first gated event in this ledger is the erratum appended before the
  // author responded; core refuses that on an advisory review too.
  await tamper((review) => { review.advisory = true; }, /history entry 3 \(ERRATUM_APPENDED\) violates the writer's precondition: advisory review/);
  await tamper((review) => { review.history.find((entry) => entry.event === "FINDINGS_SUBMITTED").count = 101; }, /history entry 2 \(FINDINGS_SUBMITTED\) violates the writer's precondition: more than 100 findings/);
  await tamper((review) => { review.history.find((entry) => entry.event === "FINDINGS_SUBMITTED").count = 0; }, /history entry 2 \(FINDINGS_SUBMITTED\) violates the writer's precondition: fewer than 1 finding/);
  // The author's response event is derived from the dispositions: an
  // escalation among them means AUTHOR_ESCALATED, and nothing after it.
  await tamper((review) => { review.resolutions[0].disposition = "human_required"; }, /round 1 author response derives AUTHOR_ESCALATED from its dispositions, but the history records AUTHOR_RESPONDED/);
  await tamper((review) => {
    // A genuinely escalated shape: one round, stopped at the escalation --
    // except that a rereview decision was left on an escalated finding.
    review.status = "HUMAN_REQUIRED";
    review.current_round = 1;
    review.rounds = [review.rounds[0]];
    review.clean_snapshot_hash = null;
    review.history = review.history.slice(0, 4);
    review.history[3] = { ...review.history[3], event: "AUTHOR_ESCALATED" };
    review.state_version = review.history.length;
    review.last_transition_state_version = review.history.length;
    review.resolutions[0].disposition = "human_required";
    review.findings[0].status = "HUMAN_REQUIRED";
    review.findings[1].status = "AUTHOR_REJECTED";
    review.rereview_decisions = [review.rereview_decisions[0]];
  }, /round 1 was escalated, but a rereview decision names "F-001"/);
  // The continuation marker without the event that would have set it.
  await tamper((review) => { review.continued_by_review_id = "rb-2026-09-02T000000-000Z-0000c0de"; }, /continued_by_review_id "rb-2026-09-02T000000-000Z-0000c0de" is recorded, but the history holds no REVIEW_CONTINUED event/);
  // Spliced in right after the author responded, where the writer would
  // record it, but in round 1 of 2, where the writer never would.
  await tamper((review) => { review.max_rounds = 2; review.history.splice(4, 0, { at: review.history[3].at, event: "ROUND_LIMIT_REACHED" }); review.state_version += 1; }, /history entry 5 \(ROUND_LIMIT_REACHED\) violates the writer's precondition: round 1 is below max_rounds 2/);
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

// The rereview verdict is derived the way submitRereview decides it and
// compared with the event the history records for that round.
test("a rereview verdict must be the one its decisions and new findings derive", async (t) => {
  const state = await reviewedFixture(t, {
    decisions: [
      { finding_id: "F-001", decision: "still_open", rationale: "not fixed", verification: "reread value.js" },
      { finding_id: "F-002", decision: "rebuttal_accepted", rationale: "agreed", verification: "reread the style" },
    ],
  });
  const reviewPath = path.join(reviewDirectory(state), "review.json");
  const original = await fsp.readFile(reviewPath, "utf8");
  const genuine = JSON.parse(original);
  assert.equal(genuine.status, "HUMAN_REQUIRED");
  assert.equal(genuine.history.at(-1).event, "REREVIEW_UNRESOLVED");
  assert.equal((await writeReviewReport(state.store, state.reviewId, { renderedAt: RENDERED_AT })).reused, false);
  // The only contesting decision flipped to resolved: the round would have
  // been recorded clean, but the history says unresolved.
  const review = JSON.parse(original);
  review.rereview_decisions[0].decision = "resolved";
  review.findings[0].status = "RESOLVED";
  await fsp.writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, { mode: 0o600 });
  await assert.rejects(writeReviewReport(state.store, state.reviewId), (error) => {
    assert.equal(error.code, "REVIEW_LEDGER_INVALID");
    assert.match(error.details.reason, /round 2 rereview derives REREVIEW_CLEAN from its decisions and new findings, but the history records REREVIEW_UNRESOLVED/);
    return true;
  });
});

// Before CONTINUABLE_FINDINGS existed the writer recorded a rereview that
// raised new findings without contesting any as REREVIEW_UNRESOLVED; ledgers
// from then carry no writer version, so that encoding of this one case is
// accepted beside the current one, and only this one.
test("the older writer's REREVIEW_UNRESOLVED for a rereview that raised findings is accepted, nothing else is", async (t) => {
  const state = await reviewedFixture(t, {
    newFindings: [{ severity: "minor", title: "raised on rereview", explanation: "new", recommendation: "" }],
  });
  const reviewPath = path.join(reviewDirectory(state), "review.json");
  const original = await fsp.readFile(reviewPath, "utf8");
  const genuine = JSON.parse(original);
  assert.equal(genuine.status, "CONTINUABLE_FINDINGS");
  assert.equal(genuine.history.at(-1).event, "REREVIEW_CONTINUABLE_FINDINGS");
  // Re-encoded the way the older writer would have written the same round.
  const older = JSON.parse(original);
  older.history.at(-1).event = "REREVIEW_UNRESOLVED";
  older.status = "HUMAN_REQUIRED";
  await fsp.writeFile(reviewPath, `${JSON.stringify(older, null, 2)}\n`, { mode: 0o600 });
  const written = await writeReviewReport(state.store, state.reviewId, { renderedAt: RENDERED_AT });
  assert.equal(written.reused, false);
  assert.match(await fsp.readFile(written.path, "utf8"), /- Human arbitration required: `REREVIEW_UNRESOLVED`/);
  await fsp.rm(written.path);
  // The other direction is not an older encoding: a clean verdict recorded
  // over a round that raised a finding.
  const clean = JSON.parse(original);
  clean.history.at(-1).event = "REREVIEW_CLEAN";
  clean.status = "CLEAN";
  clean.clean_snapshot_hash = clean.rounds.at(-1).snapshot_hash;
  await fsp.writeFile(reviewPath, `${JSON.stringify(clean, null, 2)}\n`, { mode: 0o600 });
  await assert.rejects(writeReviewReport(state.store, state.reviewId), (error) => {
    assert.equal(error.code, "REVIEW_LEDGER_INVALID");
    return true;
  });
  await fsp.writeFile(reviewPath, original, { mode: 0o600 });
  assert.equal((await writeReviewReport(state.store, state.reviewId, { renderedAt: RENDERED_AT })).reused, false);
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

// Every record kind the report renders has a field table beside its writer,
// and each table refuses a missing required field, a field outside its
// domain, and a field the writer never sets, by name.
test("every rendered record kind is held to its writer's field table", async (t) => {
  const state = await reviewedFixture(t);
  const reviewPath = path.join(reviewDirectory(state), "review.json");
  const original = await fsp.readFile(reviewPath, "utf8");
  const genuine = JSON.parse(original);
  assert.equal(genuine.errata.length, 1);
  const tamper = async (mutate, expected) => {
    const review = JSON.parse(original);
    mutate(review);
    await fsp.writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, { mode: 0o600 });
    await assert.rejects(writeReviewReport(state.store, state.reviewId), (error) => {
      assert.equal(error.code, "REVIEW_LEDGER_INVALID", `${expected}: ${error.message}`);
      assert.match(error.details.reason, expected);
      return true;
    });
  };
  // Top-level identity: types, domains, unknown fields, and agreement with
  // the immutable rounds.
  await tamper((r) => { delete r.requirement; }, /^review ledger has no requirement$/);
  await tamper((r) => { r.max_rounds = "2"; }, /^review ledger max_rounds "2" is not 2$/);
  await tamper((r) => { r.operator_note = "x"; }, /^review ledger carries a field the writer never sets: operator_note$/);
  await tamper((r) => { r.repository_path = "/somewhere/else"; }, /^round 1 repository_path "[^"]+" is not the review's repository_path$/);
  await tamper((r) => { r.base_ref = "origin/other"; }, /^round 1 base_ref "[^"]+" is not the review's base_ref$/);
  // Strategy.
  await tamper((r) => { r.review_strategy.mode = "PARTIAL"; }, /^review ledger review_strategy .* is not a review strategy$/);
  await tamper((r) => { r.review_strategy.chosen_by = "me"; }, /is not a review strategy$/);
  // History events, per event kind.
  await tamper((r) => { delete r.history[0].at; }, /^history entry 1 \(REVIEW_PREPARED\) has no at$/);
  await tamper((r) => { r.history[1].count = "2"; }, /^history entry 2 \(FINDINGS_SUBMITTED\) count "2" is not a non-negative integer$/);
  await tamper((r) => { r.history[1].actor = "codex"; }, /^history entry 2 \(FINDINGS_SUBMITTED\) carries a field the writer never sets: actor$/);
  await tamper((r) => { r.history[0].event = "REVIEW_STARTED"; }, /^history entry 1 \(REVIEW_STARTED\) event "REVIEW_STARTED" is not a history event the writers record$/);
  // Rounds and their successor proof.
  await tamper((r) => { delete r.rounds[0].patch_bytes; }, /^round 1 has no patch_bytes$/);
  // A field the table allows to be absent is still held to the manifest.
  await tamper((r) => { delete r.rounds[0].worktree_clean; }, /^round 1 worktree_clean differs from its immutable manifest$/);
  await tamper((r) => { r.rounds[0].patch_bytes = "12"; }, /^round 1 patch_bytes "12" is not a non-negative integer$/);
  await tamper((r) => { r.rounds[1].reviewer = "x"; }, /^round 2 carries a field the writer never sets: reviewer$/);
  await tamper((r) => { r.rounds[0].change_size = { added_lines: 1, deleted_lines: 1, total_lines: 3 }; }, /^round 1 change_size .* is not null or \{added_lines, deleted_lines, total_lines\} that add up$/);
  // Prepared as SUCCESSOR so the mode agrees, leaving the proof's shape to
  // be what the table refuses.
  await tamper((r) => { r.history[0].mode = "SUCCESSOR"; r.rounds[0].successor = { version: 1 }; }, /^round 1 successor .* is not null or a successor proof$/);
  // Resolutions.
  await tamper((r) => { delete r.resolutions[0].rationale; }, /^resolution 1 has no rationale$/);
  await tamper((r) => { r.resolutions[0].evidence = { commit: "abc" }; }, /^resolution 1 evidence \{"commit":"abc"\} is not a string of at most 20,000 characters$/);
  await tamper((r) => { r.resolutions[1].reviewer_note = "x"; }, /^resolution 2 carries a field the writer never sets: reviewer_note$/);
  await tamper((r) => { r.resolutions[0].submitted_at = "yesterday"; }, /^resolution 1 submitted_at "yesterday" is not a timestamp$/);
  // Rereview decisions.
  await tamper((r) => { delete r.rereview_decisions[0].rationale; }, /^rereview decision 1 has no rationale$/);
  await tamper((r) => { r.rereview_decisions[1].verification = ""; }, /^rereview decision 2 verification "" is not a string of at most 20,000 characters, non-empty for rebuttal_accepted$/);
  await tamper((r) => { r.rereview_decisions[0].verification = 7; }, /^rereview decision 1 verification 7 is not a string/);
  await tamper((r) => { r.rereview_decisions[0].model = "x"; }, /^rereview decision 1 carries a field the writer never sets: model$/);
  // Errata.
  await tamper((r) => { delete r.errata[0].text; }, /^erratum 1 has no text$/);
  await tamper((r) => { r.errata[0].round = 5; }, /^erratum 1 round 5 is not a round the ledger holds/);
  await tamper((r) => { r.errata[0].author = "x"; }, /^erratum 1 carries a field the writer never sets: author$/);
  // Carried findings (injected in the writer's shape first, then broken).
  const carried = { continued_from_review_id: "rb-2026-08-31T000000-000Z-0000c0de", finding_id: "F-001", fingerprint_sha256: "a".repeat(64), severity: "minor", title: "t", explanation: "e", recommendation: "" };
  await tamper((r) => { r.carried_findings = [{ ...carried, fingerprint_sha256: "nope" }]; }, /^carried finding 1 fingerprint_sha256 "nope" is not a digest$/);
  await tamper((r) => { r.carried_findings = [(({ title, ...rest }) => rest)(carried)]; }, /^carried finding 1 has no title$/);
  await tamper((r) => { r.carried_findings = [{ ...carried, carried_at: "x" }]; }, /^carried finding 1 carries a field the writer never sets: carried_at$/);
  // A well-formed carried finding passes the table, and is then held to the
  // source the prepare event recorded: this ledger recorded none.
  const review = JSON.parse(original);
  review.carried_findings = [carried];
  await fsp.writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, { mode: 0o600 });
  await assert.rejects(writeReviewReport(state.store, state.reviewId), (error) => {
    assert.equal(error.code, "CONTINUATION_SOURCE_UNRECORDED");
    assert.match(error.message, /carried records without a recorded source; not renderable/);
    return true;
  });
  await fsp.writeFile(reviewPath, original, { mode: 0o600 });
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

test("the continuation marker must be the one the history's REVIEW_CONTINUED event names", async (t) => {
  const state = await continuedFixture(t);
  const reviewPath = path.join(state.store, "reviews", state.sourceId, "review.json");
  const original = await fsp.readFile(reviewPath, "utf8");
  const genuine = JSON.parse(original);
  assert.equal(genuine.status, "CONTINUABLE_FINDINGS");
  assert.equal(genuine.continued_by_review_id, state.continuationId);
  assert.equal(genuine.history.at(-1).event, "REVIEW_CONTINUED");
  // The genuine source renders, naming its continuation.
  const written = await writeReviewReport(state.store, state.sourceId, { renderedAt: RENDERED_AT });
  assert.match(await fsp.readFile(written.path, "utf8"), new RegExp(`- Continued by: \`${state.continuationId}\``));
  await fsp.rm(written.path);
  const tamper = async (mutate, expected) => {
    const review = JSON.parse(original);
    mutate(review);
    await fsp.writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, { mode: 0o600 });
    await assert.rejects(writeReviewReport(state.store, state.sourceId), (error) => {
      assert.equal(error.code, "REVIEW_LEDGER_INVALID");
      assert.match(error.details.reason, expected);
      return true;
    });
  };
  await tamper((review) => { review.continued_by_review_id = "rb-2026-09-02T000000-000Z-0000c0de"; }, /continued_by_review_id "rb-2026-09-02T000000-000Z-0000c0de" is not the "rb-[^"]+" the history's REVIEW_CONTINUED event names/);
  await tamper((review) => { delete review.continued_by_review_id; }, /continued_by_review_id null is not the "rb-[^"]+" the history's REVIEW_CONTINUED event names/);
  // Restored: the continuation validates its source through the same loader.
  await fsp.writeFile(reviewPath, original, { mode: 0o600 });
  // The continuation itself carries the source's open finding and renders too.
  const continuation = await writeReviewReport(state.store, state.continuationId, { renderedAt: RENDERED_AT });
  assert.match(await fsp.readFile(continuation.path, "utf8"), new RegExp(`carried finding\\(s\\): \`F-002\` from \`${state.sourceId}\``));
  await fsp.rm(continuation.path);

  // What the continuation carries is held to the source ledger in the store:
  // a record the source's open findings do not hold, a fingerprint the
  // source's finding does not produce, a carried set that omits an open
  // finding, and a source that is gone are each named.
  const continuationPath = path.join(state.store, "reviews", state.continuationId, "review.json");
  const continuationOriginal = await fsp.readFile(continuationPath, "utf8");
  const tamperContinuation = async (mutate, code, expected) => {
    const ledger = JSON.parse(continuationOriginal);
    mutate(ledger);
    await fsp.writeFile(continuationPath, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
    await assert.rejects(writeReviewReport(state.store, state.continuationId), (error) => {
      assert.equal(error.code, code, error.message);
      assert.match(error.message, expected);
      return true;
    });
    assert.ok(!(await fsp.readdir(path.dirname(continuationPath))).some((name) => name.startsWith("report-")));
  };
  await tamperContinuation((ledger) => { ledger.carried_findings.push({ ...ledger.carried_findings[0], finding_id: "F-004" }); }, "CONTINUATION_SOURCE_MISMATCH", /finding "F-004" as open/);
  // One carried record per open finding: the same one twice would render
  // twice and count twice, and the source holds it once.
  await tamperContinuation((ledger) => { ledger.carried_findings.push({ ...ledger.carried_findings[0] }); }, "CONTINUATION_SOURCE_MISMATCH", /finding "F-002" more than once/);
  // The same for the errata the freeze copies: the source's list, in order,
  // renumbered from 1, so a repeated one is one erratum too many.
  await tamperContinuation((ledger) => { ledger.errata.push({ ...ledger.errata[0], sequence: ledger.errata.length + 1 }); }, "CONTINUATION_SOURCE_MISMATCH", /2 carried erratum\/errata, where the source holds 1/);
  // The source is still named through the carried erratum, so an emptied
  // carried set is compared with the source's open findings and refused.
  await tamperContinuation((ledger) => { assert.equal(ledger.errata.filter((e) => e.continued_from_review_id).length, 1); ledger.carried_findings = []; }, "CONTINUATION_SOURCE_MISMATCH", /only part of the open findings \(source finding "F-002" is not carried\)/);
  // The source is the one the prepare event recorded: without it, carried
  // records make the ledger unrenderable rather than pointing at a source.
  await tamperContinuation((ledger) => { assert.equal(ledger.history[0].continued_from_review_id, state.sourceId); delete ledger.history[0].continued_from_review_id; }, "CONTINUATION_SOURCE_UNRECORDED", /carried records without a recorded source; not renderable/);
  await tamperContinuation((ledger) => { ledger.history[0].continued_from_review_id = "rb-2026-09-02T000000-000Z-0000c0de"; }, "CONTINUATION_SOURCE_MISMATCH", /carries a record from rb-[^,]+, but its prepare event recorded rb-2026-09-02T000000-000Z-0000c0de as the source/);
  // The carried errata are all of the source's, in order.
  await tamperContinuation((ledger) => { ledger.errata = ledger.errata.filter((e) => e.continued_from_review_id == null); }, "CONTINUATION_SOURCE_MISMATCH", /0 carried erratum\/errata, where the source holds 1/);
  await tamperContinuation((ledger) => { ledger.carried_findings[0].fingerprint_sha256 = "e".repeat(64); }, "CONTINUATION_SOURCE_MISMATCH", /finding "F-002" with fingerprint "e{64}"/);
  await tamperContinuation((ledger) => { ledger.carried_findings[0].title = "reworded"; }, "CONTINUATION_SOURCE_MISMATCH", /finding "F-002" whose carried content does not hash to its fingerprint/);
  await fsp.writeFile(continuationPath, continuationOriginal, { mode: 0o600 });
  // The source must have recorded the continuation into this review, as an
  // event; a source whose event names another continuation disagrees.
  const sourcePath = path.join(state.store, "reviews", state.sourceId, "review.json");
  const sourceOriginal = await fsp.readFile(sourcePath, "utf8");
  const source = JSON.parse(sourceOriginal);
  source.history.at(-1).continued_by_review_id = "rb-2026-09-02T000000-000Z-0000c0de";
  source.continued_by_review_id = "rb-2026-09-02T000000-000Z-0000c0de";
  await fsp.writeFile(sourcePath, `${JSON.stringify(source, null, 2)}\n`, { mode: 0o600 });
  await assert.rejects(writeReviewReport(state.store, state.continuationId), (error) => {
    assert.equal(error.code, "CONTINUATION_SOURCE_MISMATCH");
    assert.match(error.message, new RegExp(`source that never recorded continuation into ${state.continuationId}`));
    return true;
  });
  // A source with no freeze record at all is a continuation the source
  // never vouched for -- the shape of a continuation prepared before the
  // source freeze existed -- and is refused by that name, whatever the dates.
  const unfrozen = JSON.parse(sourceOriginal);
  unfrozen.history = unfrozen.history.filter((entry) => entry.event !== "REVIEW_CONTINUED");
  delete unfrozen.continued_by_review_id;
  await fsp.writeFile(sourcePath, `${JSON.stringify(unfrozen, null, 2)}\n`, { mode: 0o600 });
  await assert.rejects(writeReviewReport(state.store, state.continuationId), (error) => {
    assert.equal(error.code, "CONTINUATION_SOURCE_MISMATCH");
    assert.match(error.message, /the continuation predates the source freeze; not renderable/);
    return true;
  });
  // The source is validated as the continuation is: a source stripped of
  // its rounds (no manifest, no patch) fails its own validation, named
  // apart with the source's error carried along.
  await fsp.writeFile(sourcePath, sourceOriginal, { mode: 0o600 });
  await fsp.rename(path.join(state.store, "reviews", state.sourceId, "rounds"), path.join(state.store, "reviews", state.sourceId, "rounds.away"));
  await assert.rejects(writeReviewReport(state.store, state.continuationId), (error) => {
    assert.equal(error.code, "CONTINUATION_SOURCE_INVALID");
    assert.equal(error.details.source_review_id, state.sourceId);
    assert.equal(error.details.source_code, "REVIEW_LEDGER_INVALID");
    assert.match(error.details.source_reason, /manifest unreadable/);
    return true;
  });
  await fsp.rename(path.join(state.store, "reviews", state.sourceId, "rounds.away"), path.join(state.store, "reviews", state.sourceId, "rounds"));
  // Two reviews carrying from each other: the chain cycles, and is refused
  // as such rather than walked forever.
  const cyclic = JSON.parse(sourceOriginal);
  const back = JSON.parse(continuationOriginal).carried_findings[0];
  cyclic.carried_findings = [{ ...back, continued_from_review_id: state.continuationId }];
  // The source's own prepare event names the continuation as its source, so
  // the source loads the continuation, which is already on the chain.
  cyclic.history[0].continued_from_review_id = state.continuationId;
  await fsp.writeFile(sourcePath, `${JSON.stringify(cyclic, null, 2)}\n`, { mode: 0o600 });
  await assert.rejects(writeReviewReport(state.store, state.continuationId), (error) => {
    assert.equal(error.code, "CONTINUATION_CHAIN_CYCLE");
    assert.deepEqual(error.details.chain, [state.continuationId, state.sourceId]);
    return true;
  });
  await fsp.writeFile(sourcePath, sourceOriginal, { mode: 0o600 });
  // A review cannot continue itself, whatever the dates.
  await tamperContinuation((ledger) => { ledger.history[0].continued_from_review_id = ledger.id; for (const carried of ledger.carried_findings) carried.continued_from_review_id = ledger.id; ledger.errata = ledger.errata.filter((e) => e.continued_from_review_id == null); }, "CONTINUATION_SOURCE_MISMATCH", /a review cannot continue itself/);
  await fsp.writeFile(continuationPath, continuationOriginal, { mode: 0o600 });
  // The source itself gone: named apart from a disagreement.
  await fsp.rename(path.join(state.store, "reviews", state.sourceId), path.join(state.store, "reviews", `${state.sourceId}.away`));
  await assert.rejects(writeReviewReport(state.store, state.continuationId), { code: "CONTINUATION_SOURCE_MISSING" });
  await fsp.rename(path.join(state.store, "reviews", `${state.sourceId}.away`), path.join(state.store, "reviews", state.sourceId));
  assert.equal((await writeReviewReport(state.store, state.continuationId, { renderedAt: RENDERED_AT })).reused, false);
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
  // The writers' ledger-level preconditions, which no single field's domain
  // expresses: core never finalizes an advisory review, never appends an
  // erratum once the gate has passed, and never prepares a rereview past
  // max_rounds.
  assert.deepEqual(await tamper((review) => { review.advisory = true; }), []);
  assert.deepEqual(await tamper((review) => { review.history.push({ at: review.updated_at, event: "ERRATUM_APPENDED", round: 1, sequence: 1 }); review.errata = [{ sequence: 1, at: review.updated_at, round: 1, text: "late" }]; review.state_version += 1; }), []);
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

// A round written before worktree_clean existed cannot have its snapshot
// hash reproduced by the store's own function, and is refused by that name
// rather than as a damaged ledger; the report keeps no second hash format.
test("a round older than the store's snapshot inputs is refused as unreproducible, by name", async (t) => {
  const state = await gatedFixture(t);
  const directory = reviewDirectory(state);
  const reviewPath = path.join(directory, "review.json");
  const manifestPath = path.join(directory, "rounds", "1", "manifest.json");
  const review = JSON.parse(await fsp.readFile(reviewPath, "utf8"));
  const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
  delete review.rounds[0].worktree_clean;
  delete manifest.worktree_clean;
  await fsp.writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, { mode: 0o600 });
  await fsp.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await assert.rejects(writeReviewReport(state.store, state.reviewId), (error) => {
    assert.equal(error.code, "ROUND_SNAPSHOT_UNREPRODUCIBLE");
    assert.equal(error.details.round, 1);
    assert.deepEqual(error.details.missing, ["worktree_clean"]);
    assert.equal(error.details.reason, "the store cannot reproduce this round's snapshot hash");
    assert.match(error.message, /predates worktree_clean/);
    return true;
  });
  assert.ok(!(await fsp.readdir(directory)).some((name) => name.startsWith("report-")));
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

// A successor review, prepared against a passed parent through the writer,
// so its proof is bound to its round and to the parent in the store.
async function successorFixture(t, { extraFile = null, seed = {}, edit = null } = {}) {
  const parent = await gatedFixture(t, { seed });
  await fsp.writeFile(path.join(parent.repository, "value.test.js"), "export const checked = true;\n");
  if (extraFile != null) await fsp.writeFile(path.join(parent.repository, extraFile), "non-ascii path\n");
  if (edit != null) await edit(parent.repository);
  git(parent.repository, "add", ".");
  git(parent.repository, "commit", "-m", "add a test");
  const successor = await prepareReview(parent.store, {
    repositoryPath: parent.repository,
    baseRef: parent.baseSha,
    requirement: "Change the exported value.",
    implementationScope: "Update value.js.",
    reviewerProvider: "CLAUDE_DESKTOP",
    parentReviewId: parent.reviewId,
  });
  assert.equal(successor.review_strategy.mode, "SUCCESSOR");
  return { ...parent, parentId: parent.reviewId, successorId: successor.id, headSha: git(parent.repository, "rev-parse", "HEAD") };
}

test("a successor proof is bound to its round's head and base and to the parent's last head", async (t) => {
  const state = await successorFixture(t);
  const reviewPath = path.join(state.store, "reviews", state.successorId, "review.json");
  const original = await fsp.readFile(reviewPath, "utf8");
  const genuine = JSON.parse(original);
  assert.equal(genuine.rounds[0].successor.current_head_sha, state.headSha);
  assert.equal(genuine.rounds[0].successor.parent_review_id, state.parentId);
  const written = await writeReviewReport(state.store, state.successorId, { renderedAt: RENDERED_AT });
  assert.match(await fsp.readFile(written.path, "utf8"), /#### Round 1 strategy: `SUCCESSOR`/);
  await fsp.rm(written.path);
  const tamper = async (mutate, expected) => {
    const review = JSON.parse(original);
    mutate(review);
    await fsp.writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, { mode: 0o600 });
    await assert.rejects(writeReviewReport(state.store, state.successorId), (error) => {
      assert.equal(error.code, "REVIEW_LEDGER_INVALID", error.message);
      assert.match(error.details.reason, expected);
      return true;
    });
  };
  await tamper((review) => { review.rounds[0].successor.current_head_sha = "1".repeat(40); }, /round 1 successor proof names current_head_sha 1{40}, but the round's head is [0-9a-f]{40}/);
  await tamper((review) => { review.rounds[0].successor.base_sha = "2".repeat(40); }, /round 1 successor proof names base_sha 2{40}, but the round's base is [0-9a-f]{40}/);
  await tamper((review) => { review.rounds[0].successor.parent_head_sha = "3".repeat(40); }, new RegExp(`round 1 successor proof names parent_head_sha "3{40}", but parent ${state.parentId} gives "[0-9a-f]{40}"`));
  // The proof's file lists are what its stored delta names. The stored
  // proof artifact is edited alongside the ledger so the artifact comparison
  // passes and the delta itself is what refuses the extra path.
  assert.deepEqual(genuine.rounds[0].successor.changed_files, ["value.test.js"]);
  assert.deepEqual(genuine.rounds[0].successor.deleted_files, []);
  const proofPath = path.join(state.store, "reviews", state.successorId, "rounds", "1", "successor.json");
  const proofOriginal = await fsp.readFile(proofPath, "utf8");
  const edited = JSON.parse(original);
  edited.rounds[0].successor.changed_files = ["value.test.js", "not-in-the-delta.js"];
  await fsp.writeFile(reviewPath, `${JSON.stringify(edited, null, 2)}\n`, { mode: 0o600 });
  await fsp.writeFile(proofPath, `${JSON.stringify(edited.rounds[0].successor, null, 2)}\n`, { mode: 0o600 });
  await assert.rejects(writeReviewReport(state.store, state.successorId), (error) => {
    assert.equal(error.code, "REVIEW_LEDGER_INVALID", error.message);
    assert.match(error.details.reason, /round 1 successor proof lists changed_files \["not-in-the-delta\.js","value\.test\.js"\], but its delta changes \["value\.test\.js"\]/);
    return true;
  });
  await fsp.writeFile(proofPath, proofOriginal, { mode: 0o600 });
  // Every field the proof took from the parent is recomputed from the parent
  // in the store; the artifact is edited alongside so the field is what is
  // named.
  for (const [field, value] of [["requirement_match", false], ["parent_reviewer_provider", "CODEX_TASK"], ["parent_requirement", "something else"], ["parent_snapshot_hash", "9".repeat(64)]]) {
    const changed = JSON.parse(original);
    changed.rounds[0].successor[field] = value;
    await fsp.writeFile(reviewPath, `${JSON.stringify(changed, null, 2)}\n`, { mode: 0o600 });
    await fsp.writeFile(proofPath, `${JSON.stringify(changed.rounds[0].successor, null, 2)}\n`, { mode: 0o600 });
    await assert.rejects(writeReviewReport(state.store, state.successorId), (error) => {
      assert.equal(error.code, "REVIEW_LEDGER_INVALID", `${field}: ${error.message}`);
      assert.match(error.details.reason, new RegExp(`round 1 successor proof names ${field} ${JSON.stringify(value).replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}, but parent ${state.parentId} gives `));
      return true;
    });
  }
  await fsp.writeFile(proofPath, proofOriginal, { mode: 0o600 });
  await fsp.writeFile(reviewPath, original, { mode: 0o600 });
  assert.equal((await writeReviewReport(state.store, state.successorId, { renderedAt: RENDERED_AT })).reused, false);
});

// The snapshot commitment of a successor round covers its proof: the round's
// manifest records the delta digest and the two heads, the hash is computed
// over them, and the gate minted on a clean successor vouches for the delta.
// A delta swapped afterwards, however consistently, leaves the round
// unreproducible; a round carrying part of the commitment is refused.
test("a successor round's snapshot commitment covers its proof, and a swapped delta is unreproducible", async (t) => {
  const state = await successorFixture(t);
  const directory = path.join(state.store, "reviews", state.successorId);
  const reviewPath = path.join(directory, "review.json");
  const original = await fsp.readFile(reviewPath, "utf8");
  const genuine = JSON.parse(original);
  const round = genuine.rounds[0];
  assert.equal(round.successor_delta_sha256, round.successor.delta_sha256);
  assert.equal(round.successor_parent_head_sha, round.successor.parent_head_sha);
  assert.equal(round.successor_current_head_sha, round.successor.current_head_sha);
  const manifest = JSON.parse(await fsp.readFile(path.join(directory, "rounds", "1", "manifest.json"), "utf8"));
  assert.equal(manifest.snapshot_hash, round.snapshot_hash);
  assert.equal(manifest.successor_delta_sha256, round.successor.delta_sha256);
  // The successor review is reviewed CLEAN and gated: the gate's snapshot
  // hash is the committed one.
  await submitInitialReview(state.store, state.successorId, [], "CLAUDE_DESKTOP");
  await finalizeLocalGate(state.store, state.successorId);
  const gate = JSON.parse(await fsp.readFile(path.join(directory, "gate.json"), "utf8"));
  assert.equal(gate.snapshot_hash, round.snapshot_hash);
  const gated = await fsp.readFile(reviewPath, "utf8");
  assert.equal((await writeReviewReport(state.store, state.successorId, { renderedAt: RENDERED_AT })).reused, false);

  // Delta, artifact, and proof swapped together for another parseable delta
  // with a consistent digest: every artifact check passes, the commitment
  // does not reproduce.
  const deltaPath = path.join(directory, "rounds", "1", "successor.diff");
  const proofPath = path.join(directory, "rounds", "1", "successor.json");
  const deltaOriginal = await fsp.readFile(deltaPath);
  const proofOriginal = await fsp.readFile(proofPath, "utf8");
  const swappedDelta = Buffer.from(deltaOriginal.toString("utf8").replace("export const checked = true;", "export const checked = false;"), "utf8");
  assert.notEqual(swappedDelta.toString("utf8"), deltaOriginal.toString("utf8"));
  const swapped = JSON.parse(gated);
  swapped.rounds[0].successor.delta_bytes = swappedDelta.length;
  swapped.rounds[0].successor.delta_sha256 = crypto.createHash("sha256").update(swappedDelta).digest("hex");
  swapped.rounds[0].successor_delta_sha256 = swapped.rounds[0].successor.delta_sha256;
  await fsp.writeFile(deltaPath, swappedDelta, { mode: 0o600 });
  await fsp.writeFile(proofPath, `${JSON.stringify(swapped.rounds[0].successor, null, 2)}\n`, { mode: 0o600 });
  await fsp.writeFile(reviewPath, `${JSON.stringify(swapped, null, 2)}\n`, { mode: 0o600 });
  const manifestPath = path.join(directory, "rounds", "1", "manifest.json");
  const manifestOriginal = await fsp.readFile(manifestPath, "utf8");
  await fsp.writeFile(manifestPath, `${JSON.stringify({ ...JSON.parse(manifestOriginal), successor_delta_sha256: swapped.rounds[0].successor.delta_sha256 }, null, 2)}\n`, { mode: 0o600 });
  await assert.rejects(writeReviewReport(state.store, state.successorId), (error) => {
    assert.equal(error.code, "REVIEW_LEDGER_INVALID", error.message);
    assert.match(error.details.reason, /round 1 snapshot_hash is not reproduced by its patch/);
    return true;
  });
  // A round with part of the commitment is neither committed nor older than
  // the commitment, and is refused.
  const partial = JSON.parse(gated);
  delete partial.rounds[0].successor_parent_head_sha;
  const partialManifest = JSON.parse(manifestOriginal);
  delete partialManifest.successor_parent_head_sha;
  await fsp.writeFile(deltaPath, deltaOriginal, { mode: 0o600 });
  await fsp.writeFile(proofPath, proofOriginal, { mode: 0o600 });
  await fsp.writeFile(reviewPath, `${JSON.stringify(partial, null, 2)}\n`, { mode: 0o600 });
  await fsp.writeFile(manifestPath, `${JSON.stringify(partialManifest, null, 2)}\n`, { mode: 0o600 });
  await assert.rejects(writeReviewReport(state.store, state.successorId), (error) => {
    assert.equal(error.code, "REVIEW_LEDGER_INVALID", error.message);
    assert.match(error.details.reason, /round 1: review round's successor commitment is incomplete/);
    return true;
  });
  await fsp.writeFile(reviewPath, gated, { mode: 0o600 });
  await fsp.writeFile(manifestPath, manifestOriginal, { mode: 0o600 });
  assert.equal((await writeReviewReport(state.store, state.successorId, { renderedAt: RENDERED_AT })).reused, true);
});

// An older proof records no requirement match at all. The parent in the
// store gives it, and the report prints that; with no parent to give it, the
// report says it is not recorded rather than reading the absence as "no".
test("a proof with no recorded requirement match is printed from the parent, or as not recorded", async (t) => {
  const state = await successorFixture(t, { extraFile: "match.txt" });
  const directory = path.join(state.store, "reviews", state.successorId);
  const parentDirectory = path.join(state.store, "reviews", state.parentId);
  const reviewPath = path.join(directory, "review.json");
  const review = JSON.parse(await fsp.readFile(reviewPath, "utf8"));
  // The proof of an older release: no requirement_match, no parent
  // requirement. Neither is in the snapshot commitment, so the round still
  // reproduces.
  const proof = review.rounds[0].successor;
  assert.equal(proof.requirement_match, true);
  delete proof.requirement_match;
  delete proof.parent_requirement;
  await fsp.writeFile(path.join(directory, "rounds", "1", "successor.json"), `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 });
  await fsp.writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, { mode: 0o600 });
  const strategy = async () => {
    const receipt = await writeReviewReport(state.store, state.successorId, { renderedAt: RENDERED_AT });
    const markdown = await fsp.readFile(receipt.path, "utf8");
    await fsp.rm(receipt.path);
    return markdown.slice(markdown.indexOf("#### Round 1 strategy"), markdown.indexOf("### Findings"));
  };
  // The parent holds the same requirement, so the parent gives "yes".
  assert.match(await strategy(), /\n- Requirement matches the parent: yes\n/);
  // With the parent gone nothing gives it, and the round is already marked.
  await fsp.rename(parentDirectory, path.join(state.store, "parent-aside"));
  const absent = await strategy();
  assert.match(absent, /\n- \(parent review not in this store; parent-derived fields unverified\) Requirement matches the parent: not recorded\n/);
  assert.doesNotMatch(absent, /Requirement matches the parent: (yes|no)\n/);
});

// A parent ledger the render actually used is a source of the rendered
// facts, so the footer names it: the proof that records everything needs no
// parent and names none.
test("the footer names a parent ledger this render recomputed a field from, and no other", async (t) => {
  const state = await successorFixture(t, { extraFile: "footer.txt" });
  const directory = path.join(state.store, "reviews", state.successorId);
  const parentDirectory = path.join(state.store, "reviews", state.parentId);
  const reviewPath = path.join(directory, "review.json");
  const complete = await fsp.readFile(reviewPath, "utf8");
  const footer = async () => {
    const receipt = await writeReviewReport(state.store, state.successorId, { renderedAt: RENDERED_AT });
    const markdown = await fsp.readFile(receipt.path, "utf8");
    await fsp.rm(receipt.path);
    return markdown.slice(markdown.indexOf("## Footer"));
  };
  // A proof that records everything: the render read no parent field.
  assert.doesNotMatch(await footer(), /Parent review:/);
  // The same ledger without the fields an older release omitted: the parent
  // supplied them, so the parent's ledger and the gate its proof names are
  // part of what was rendered.
  const review = JSON.parse(complete);
  const proof = review.rounds[0].successor;
  delete proof.requirement_match;
  delete proof.parent_requirement;
  await fsp.writeFile(path.join(directory, "rounds", "1", "successor.json"), `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 });
  await fsp.writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, { mode: 0o600 });
  const parent = JSON.parse(await fsp.readFile(path.join(parentDirectory, "review.json"), "utf8"));
  const gateSha = crypto.createHash("sha256").update(await fsp.readFile(path.join(parentDirectory, "gate.json"))).digest("hex");
  assert.equal(proof.parent_gate_sha256, gateSha);
  assert.match(
    await footer(),
    new RegExp(`\n- Parent review: \`${state.parentId}\` \\(\`${path.join(parentDirectory, "review.json")}\`, state_version ${parent.state_version}; gate\\.json sha256 \`${gateSha.slice(0, 12)}\`\\)\n`),
  );
  // With the parent gone, what the render used is its absence.
  await fsp.rename(parentDirectory, path.join(state.store, "parent-aside"));
  assert.match(await footer(), new RegExp(`\n- Parent review: \`${state.parentId}\` — not in this store \\(parent-derived fields unverified\\)\n`));
});

// A successor's parent in the store is validated as the review is and its
// gate is required and bound to it; a parent the store has no ledger for
// leaves the parent-derived fields as recorded, and the report says so.
test("a successor's parent in the store must validate with its gate, and a parent not in the store is marked", async (t) => {
  const state = await successorFixture(t, { extraFile: "parent.txt" });
  const parentDirectory = path.join(state.store, "reviews", state.parentId);
  const gatePath = path.join(parentDirectory, "gate.json");
  const gateBytes = await fsp.readFile(gatePath);
  const refused = async (reason) => {
    await assert.rejects(writeReviewReport(state.store, state.successorId), (error) => {
      assert.equal(error.code, "SUCCESSOR_PARENT_INVALID", error.message);
      assert.equal(error.details.parent_review_id, state.parentId);
      assert.equal(error.details.round, 1);
      assert.match(error.details.reason, reason);
      return true;
    });
  };
  // The parent's gate removed.
  await fsp.rm(gatePath);
  await refused(/^parent gate: /);
  // The parent's gate re-serialized: the same gate, not the file the proof digested.
  await fsp.writeFile(gatePath, `${JSON.stringify(JSON.parse(gateBytes.toString("utf8")))}\n`, { mode: 0o600 });
  await refused(/proof names parent_gate_sha256 [0-9a-f]{64}, but the parent gate's bytes digest to [0-9a-f]{64}/);
  await fsp.writeFile(gatePath, gateBytes, { mode: 0o600 });
  // The parent's rounds moved away: the parent no longer validates.
  await fsp.rename(path.join(parentDirectory, "rounds"), path.join(state.store, "rounds-aside"));
  await refused(/round 1/);
  await fsp.rename(path.join(state.store, "rounds-aside"), path.join(parentDirectory, "rounds"));
  // The parent not in the store at all: the round renders, marked.
  await fsp.rename(parentDirectory, path.join(state.store, "parent-aside"));
  const receipt = await writeReviewReport(state.store, state.successorId, { renderedAt: RENDERED_AT });
  const markdown = await fsp.readFile(receipt.path, "utf8");
  const mark = "(parent review not in this store; parent-derived fields unverified)";
  assert.match(markdown, new RegExp(`#### Round 1 strategy: \`SUCCESSOR\` ${mark.replace(/[()]/g, "\\$&")}\n`));
  const section = markdown.slice(markdown.indexOf("#### Round 1 strategy"), markdown.indexOf("### Findings"));
  const items = section.split("\n").filter((line) => line.startsWith("- "));
  assert.deepEqual(items.map((line) => line.startsWith(`- ${mark} `)), [true, true, true, false, false, false]);
  assert.match(items[0], new RegExp(`Parent review: \`${state.parentId}\``));
  assert.doesNotMatch(markdown, /unverified proof/);
  // The parent back: the same round renders without the mark.
  await fsp.rename(path.join(state.store, "parent-aside"), parentDirectory);
  await fsp.rm(receipt.path);
  const fresh = await fsp.readFile((await writeReviewReport(state.store, state.successorId, { renderedAt: RENDERED_AT })).path, "utf8");
  assert.doesNotMatch(fresh, /parent review not in this store/);
});

// A successor round prepared before the commitment existed carries no
// commitment fields and a hash over the round alone. It still renders: the
// hash is reproduced the older way, and the proof is relayed as recorded,
// every item marked as uncovered. Nothing else about the report changes.
test("a successor round older than the commitment renders with its proof marked as unverified", async (t) => {
  const state = await successorFixture(t, { extraFile: "older.txt" });
  const directory = path.join(state.store, "reviews", state.successorId);
  const reviewPath = path.join(directory, "review.json");
  const manifestPath = path.join(directory, "rounds", "1", "manifest.json");
  const committed = JSON.parse(await fsp.readFile(reviewPath, "utf8"));
  const round = committed.rounds[0];
  const patch = await fsp.readFile(path.join(directory, "rounds", "1", "patch.diff"));
  // The hash the store computed before the commitment: the round's identity
  // and its patch, no proof.
  const older = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        baseSha: round.base_sha,
        headSha: round.head_sha,
        requirement: committed.requirement,
        implementationScope: committed.implementation_scope,
        changedFiles: round.changed_files,
        deletedFiles: round.deleted_files,
        overlays: round.overlays,
        worktreeClean: round.worktree_clean,
      }),
    )
    .update(patch)
    .digest("hex");
  assert.notEqual(older, round.snapshot_hash);
  const aged = JSON.parse(JSON.stringify(committed));
  const agedManifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
  for (const target of [aged.rounds[0], agedManifest]) {
    for (const key of ["successor_delta_sha256", "successor_parent_head_sha", "successor_current_head_sha"]) delete target[key];
    target.snapshot_hash = older;
  }
  await fsp.writeFile(reviewPath, `${JSON.stringify(aged, null, 2)}\n`, { mode: 0o600 });
  await fsp.writeFile(manifestPath, `${JSON.stringify(agedManifest, null, 2)}\n`, { mode: 0o600 });
  const receipt = await writeReviewReport(state.store, state.successorId, { renderedAt: RENDERED_AT });
  const markdown = await fsp.readFile(receipt.path, "utf8");
  const mark = "(as recorded; not covered by the snapshot commitment — this ledger predates it)";
  assert.match(markdown, /#### Round 1 strategy: `SUCCESSOR` \(unverified proof\)\n/);
  const section = markdown.slice(markdown.indexOf("#### Round 1 strategy"), markdown.indexOf("### Findings"));
  const items = section.split("\n").filter((line) => line.startsWith("- "));
  assert.equal(items.length, 6);
  for (const line of items) assert.ok(line.startsWith(`- ${mark} `), line);
  assert.match(section, new RegExp(`Delta: ${round.successor.delta_bytes} bytes, sha256 \`${round.successor.delta_sha256}\``));
  // The report's identity is the ledger's revision, not the proof's standing.
  assert.equal(receipt.revision, String(aged.state_version));
  // The committed ledger renders the same proof without the mark.
  await fsp.writeFile(reviewPath, `${JSON.stringify(committed, null, 2)}\n`, { mode: 0o600 });
  await fsp.writeFile(manifestPath, `${JSON.stringify({ ...agedManifest, ...Object.fromEntries(["successor_delta_sha256", "successor_parent_head_sha", "successor_current_head_sha"].map((key) => [key, round[key]])), snapshot_hash: round.snapshot_hash }, null, 2)}\n`, { mode: 0o600 });
  await fsp.rm(receipt.path);
  const fresh = await fsp.readFile((await writeReviewReport(state.store, state.successorId, { renderedAt: RENDERED_AT })).path, "utf8");
  assert.match(fresh, /#### Round 1 strategy: `SUCCESSOR`\n/);
  assert.doesNotMatch(fresh, /unverified proof|as recorded/);
});

// A SHA-256 repository writes 64-character object ids, and the store records
// what the repository gives it. One review is one repository, so one review
// holds one width.
test("a SHA-256 repository's review is prepared, gated, and rendered, and a ledger mixing widths is refused", async (t) => {
  const state = await gatedFixture(t, { objectFormat: "sha256" });
  assert.equal(state.headSha.length, 64);
  const directory = path.join(state.store, "reviews", state.reviewId);
  const reviewPath = path.join(directory, "review.json");
  const review = JSON.parse(await fsp.readFile(reviewPath, "utf8"));
  assert.equal(review.status, "LOCAL_GATE_PASSED");
  assert.equal(review.rounds[0].head_sha, state.headSha);
  const gate = JSON.parse(await fsp.readFile(path.join(directory, "gate.json"), "utf8"));
  assert.equal(gate.head_sha, state.headSha);
  const receipt = await writeReviewReport(state.store, state.reviewId, { renderedAt: RENDERED_AT });
  const markdown = await fsp.readFile(receipt.path, "utf8");
  assert.match(markdown, new RegExp(`- Round 1 snapshot: \`${state.baseSha}\` → \`${state.headSha}\``));
  await fsp.rm(receipt.path);
  // A ledger holding both widths is not one repository's.
  const mixed = JSON.parse(await fsp.readFile(reviewPath, "utf8"));
  mixed.rounds[0].head_sha = "a".repeat(40);
  await fsp.writeFile(reviewPath, `${JSON.stringify(mixed, null, 2)}\n`, { mode: 0o600 });
  await assert.rejects(writeReviewReport(state.store, state.reviewId), (error) => {
    assert.equal(error.code, "REVIEW_LEDGER_INVALID", error.message);
    assert.match(error.details.reason, /round 1 head_sha is 40 hex characters, but round 1 base_sha is 64/);
    return true;
  });
});

// A path with a space cannot be told from the `diff --git` header alone, so
// the paths come from the lines of the block that state one: the rename
// lines, the `---`/`+++` lines, and, only for the binary block that has
// neither, the header itself.
test("a delta naming spaced, renamed, deleted, and binary paths is read as the writer's file lists", async (t) => {
  const state = await successorFixture(t, {
    seed: {
      "doomed with space.txt": "gone\n",
      "old name with space.txt": "renamed unchanged\n",
      "binary with space.dat": Buffer.from([0x00, 0x01, 0x02, 0x00, 0x03]),
    },
    edit: async (repository) => {
      await fsp.writeFile(path.join(repository, "added with space.txt"), "added\n");
      // Quoted and spaced at once: git quotes the path and still ends the
      // line with its tab.
      await fsp.writeFile(path.join(repository, "café with space.txt"), "added\n");
      await fsp.writeFile(path.join(repository, "binary with space.dat"), Buffer.from([0x00, 0x01, 0x02, 0x00, 0x03, 0x04, 0x05]));
      git(repository, "rm", "-q", "doomed with space.txt");
      git(repository, "mv", "old name with space.txt", "new name with space.txt");
    },
  });
  const directory = path.join(state.store, "reviews", state.successorId);
  const delta = await fsp.readFile(path.join(directory, "rounds", "1", "successor.diff"), "utf8");
  // The delta carries each shape the parser must read, unquoted.
  assert.match(delta, /^diff --git a\/added with space\.txt b\/added with space\.txt$/m);
  assert.match(delta, /^\+\+\+ "b\/caf\\303\\251 with space\.txt"\t$/m);
  assert.match(delta, /^rename to new name with space\.txt$/m);
  assert.match(delta, /^diff --git a\/binary with space\.dat b\/binary with space\.dat\nindex [^\n]+\nGIT binary patch$/m);
  // The ledger renders, which means the paths read from the delta are the
  // ones the writer's own `--name-only` recorded.
  const review = JSON.parse(await fsp.readFile(path.join(directory, "review.json"), "utf8"));
  assert.deepEqual(review.rounds[0].successor.changed_files, [
    "added with space.txt",
    "binary with space.dat",
    "café with space.txt",
    "doomed with space.txt",
    "new name with space.txt",
    "value.test.js",
  ]);
  assert.deepEqual(review.rounds[0].successor.deleted_files, ["doomed with space.txt"]);
  assert.equal((await writeReviewReport(state.store, state.successorId, { renderedAt: RENDERED_AT })).reused, false);
});

// A block with no rename and no `---`/`+++` is read from its header, whose
// two operands are one path twice; operands that differ cannot be split and
// are refused rather than guessed.
test("a delta block whose header names two different paths and states neither is refused", async (t) => {
  const state = await successorFixture(t);
  const directory = path.join(state.store, "reviews", state.successorId);
  const reviewPath = path.join(directory, "review.json");
  const manifestPath = path.join(directory, "rounds", "1", "manifest.json");
  const review = JSON.parse(await fsp.readFile(reviewPath, "utf8"));
  const round = review.rounds[0];
  const patch = await fsp.readFile(path.join(directory, "rounds", "1", "patch.diff"));
  // The round is aged out of the successor commitment so the delta can be
  // swapped at all; its hash is then the one the store computed before it.
  const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
  const older = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        baseSha: round.base_sha,
        headSha: round.head_sha,
        requirement: review.requirement,
        implementationScope: review.implementation_scope,
        changedFiles: round.changed_files,
        deletedFiles: round.deleted_files,
        overlays: round.overlays,
        worktreeClean: round.worktree_clean,
      }),
    )
    .update(patch)
    .digest("hex");
  for (const target of [round, manifest]) {
    for (const key of ["successor_delta_sha256", "successor_parent_head_sha", "successor_current_head_sha"]) delete target[key];
    target.snapshot_hash = older;
  }
  const crafted = Buffer.from(
    [
      "diff --git a/left name.txt b/right name.txt",
      "index 0000000000000000000000000000000000000000..1111111111111111111111111111111111111111 100644",
      "GIT binary patch",
      "literal 0",
      "HcmV?d00001",
      "",
      "",
    ].join("\n"),
    "utf8",
  );
  round.successor.delta_bytes = crafted.length;
  round.successor.delta_sha256 = crypto.createHash("sha256").update(crafted).digest("hex");
  await fsp.writeFile(path.join(directory, "rounds", "1", "successor.diff"), crafted, { mode: 0o600 });
  await fsp.writeFile(path.join(directory, "rounds", "1", "successor.json"), `${JSON.stringify(round.successor, null, 2)}\n`, { mode: 0o600 });
  await fsp.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await fsp.writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, { mode: 0o600 });
  await assert.rejects(writeReviewReport(state.store, state.successorId), (error) => {
    assert.equal(error.code, "REVIEW_LEDGER_INVALID", error.message);
    assert.match(error.details.reason, /round 1 successor delta cannot be read for its files: unreadable header "diff --git a\/left name\.txt b\/right name\.txt"/);
    return true;
  });
});

// git quotes a non-ASCII path in a diff header as octal escapes over its
// UTF-8 bytes (core.quotepath, the default); the delta reader decodes the
// bytes whole, so the path equals the one the writer listed.
test("a successor delta with a quoted non-ASCII path yields the path the writer listed", async (t) => {
  const state = await successorFixture(t, { extraFile: "café.txt" });
  const proof = JSON.parse(await fsp.readFile(path.join(state.store, "reviews", state.successorId, "review.json"), "utf8")).rounds[0].successor;
  assert.deepEqual(proof.changed_files, ["café.txt", "value.test.js"]);
  const delta = await fsp.readFile(path.join(state.store, "reviews", state.successorId, "rounds", "1", "successor.diff"), "utf8");
  assert.match(delta, /^diff --git "a\/caf\\303\\251\.txt" "b\/caf\\303\\251\.txt"$/m);
  assert.equal((await writeReviewReport(state.store, state.successorId, { renderedAt: RENDERED_AT })).reused, false);
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
