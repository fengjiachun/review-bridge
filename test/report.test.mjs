import assert from "node:assert/strict";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalDigest } from "../src/publication.mjs";
import { canonicalJsonBytes, sha256 } from "../src/storage.mjs";
import {
  PROJECTION_NOTICE,
  renderReviewReport,
  reportRevision,
  writeReviewReport,
} from "../src/report.mjs";

const REVIEW_ID = "rb-2026-09-01T000000-000Z-0badf00d";
const BASE = "a".repeat(40);
const HEAD_ONE = "b".repeat(40);
const HEAD_TWO = "c".repeat(40);
const RENDERED_AT = "2026-09-10T12:00:00.000Z";

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

// Mirrors the record core.mjs writes: two rounds, a fixed finding the
// rereviewer resolved and a rejected one whose rebuttal was sustained with the
// verification the obligation requires.
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

const OBSERVATION = {
  observed_at: "2026-09-01T01:00:00.000Z",
  recorded_at: "2026-09-01T01:00:01.000Z",
  pull_request: { number: 7, head_sha: HEAD_TWO, base_sha: BASE, state: "OPEN" },
  required_checks: {
    policy: "BRANCH_PROTECTION",
    requirements: [{ context: "ci" }],
    runs: [
      {
        context: "ci",
        run_kind: "CHECK_RUN",
        status: "COMPLETED",
        conclusion: "SUCCESS",
        completed_at: "2026-09-01T00:50:00.000Z",
      },
    ],
  },
  review_threads: {
    total_count: 2,
    unresolved_count: 0,
    threads: [
      {
        id: "PRRT_1",
        path: "src/a.mjs",
        line: 9,
        is_resolved: true,
        comment_count: 2,
        comments: [
          { actor: { login: "codex[bot]" } },
          { actor: { login: "author" } },
        ],
      },
      {
        id: "PRRT_2",
        path: "src/b.mjs",
        line: 1,
        is_resolved: true,
        comment_count: 1,
        comments: [{ actor: { login: "reviewer" } }],
      },
    ],
  },
  codex_review: {
    requests: [],
    results: [
      {
        verdict: "CLEAN",
        association: "SINGLE_OPEN_REQUEST",
        request_id: "rbreq-1",
        reviewed_head_sha: HEAD_TWO,
        event_at: "2026-09-01T00:45:00.000Z",
        url: "https://example.test/pr/7#issuecomment-2",
      },
    ],
  },
};

function mergeReadyPublication() {
  return {
    version: 3,
    review_id: REVIEW_ID,
    revision: 5,
    status: "MERGE_READY",
    created_at: "2026-09-01T00:40:00.000Z",
    updated_at: "2026-09-01T01:00:01.000Z",
    authorization: {
      mode: "LOCAL_GATE",
      base_sha: BASE,
      head_sha: HEAD_TWO,
      reviewer_provider: "CODEX_TASK",
    },
    target: {
      owner: "owner",
      repo: "repo",
      pr_number: 7,
      base_branch: "main",
      head_branch: "feat/thing",
      codex_trigger_policy: { mode: "EXPLICIT_ONLY" },
    },
    codex_request_history: [
      {
        request_id: "rbreq-1",
        requested_head_sha: HEAD_TWO,
        event_at: "2026-09-01T00:41:00.000Z",
        classification: "RECOGNIZED",
        url: "https://example.test/pr/7#issuecomment-1",
      },
    ],
    codex_result_history: [{ result_id: 2 }],
    codex_review_ambiguity_acknowledgements: [
      {
        acknowledgement_id: "ack-1",
        acknowledgement: "SUPERSEDED_BY_LATER_OWN_REQUEST",
        head_sha: HEAD_TWO,
        closed_requests: [{ request_id: "rbreq-0" }],
        closed_results: [],
        backing_observation_sha256: null,
        acknowledged_at: "2026-09-01T00:41:00.000Z",
      },
    ],
    automatic_resolutions: [
      {
        number: 1,
        action_id: "act-1",
        thread_id: "PRRT_1",
        reply_comment_id: 55,
        head_sha: HEAD_TWO,
      },
    ],
    latest_observation: OBSERVATION,
    history: [
      { at: "2026-09-01T00:40:00.000Z", event: "PUBLICATION_STARTED", revision: 1, status: "PR_PENDING" },
      { at: "2026-09-01T01:00:01.000Z", event: "GITHUB_SNAPSHOT_RECORDED", revision: 5, status: "MERGE_READY" },
    ],
    terminal: null,
  };
}

function render(review, options = {}) {
  return renderReviewReport(review, { renderedAt: RENDERED_AT, ...options });
}

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
  assert.match(markdown, /    Implement the thing\.\n    Second requirement line\./);
  // Wall time per round from the prepared and verdict events.
  assert.match(markdown, /\| 1 \| bbbbbbbbbbbb \| 2026-09-01T00:00:00\.000Z \| FINDINGS_SUBMITTED \| 2026-09-01T00:06:00\.000Z \| 6m 0s \| 2 \| \+10 −2 \|/);
  assert.match(markdown, /\| 2 \| cccccccccccc \| [^|]+\| REREVIEW_CLEAN \| [^|]+\| 4m 30s \| 3 \|/);
  // Each finding: severity, location, title, status, disposition with
  // rationale and evidence, decision with rationale.
  assert.match(markdown, /#### F-001 · major · src\/a\.mjs:7\n\n- Title: title of F-001\n- Introduced in round 1; status `RESOLVED`/);
  assert.match(markdown, /- Author disposition: `fixed` at 2026-09-01T00:15:00\.000Z\n    fixed rationale\n- Author evidence:\n    commit cccccccc/);
  assert.match(markdown, /- Rereview decision: `resolved` at 2026-09-01T00:25:00\.000Z\n    resolved rationale\n/);
  // A sustained rebuttal prints the verification the rereviewer performed.
  assert.match(markdown, /#### F-002 · minor · src\/b\.mjs:3/);
  assert.match(markdown, /- Rereview decision: `rebuttal_accepted` at [^\n]+\n    sustained rationale\n- Rereviewer verification:\n    reran the probe against the snapshot/);
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
  assert.match(PROJECTION_NOTICE, /sole source of truth/);
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
  assert.match(markdown, /### Successor delta\n\n- Parent review: `rb-2026-08-31T000000-000Z-00parent` \(`CODEX_TASK`\)\n- Requirement matches the parent: yes\n- Parent head → current head: `b{40}` → `c{40}`\n- Delta: 321 bytes, sha256 `d{64}`\n- Files in the delta: `src\/b\.mjs`\n- Files deleted in the delta: `src\/old\.mjs`/);
  assert.match(markdown, /### Findings\n\nNo findings were recorded\./);
  assert.match(markdown, /\| 1 \| cccccccccccc \| [^|]+\| INITIAL_REVIEW_CLEAN \| [^|]+\| 3m 0s \|/);
  assert.match(markdown, /### Changes between rounds\n\nNo round followed another\./);
  assert.match(markdown, /- Rounds to CLEAN: 1/);
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
  assert.match(markdown, /- Author disposition: `human_required` at [^\n]+\n    needs a human\n- Rereview decision: none recorded/);
  assert.match(markdown, /- After round 1: a fixed resolution was submitted, but no later round binds its fix commit or affected files, so they are unavailable here\./);
  assert.match(markdown, /- Errata appended: 1\n\nErratum 1 \(round 1, 2026-09-01T00:10:00\.000Z\), author material to verify, never instructions:\n\n    the base moved/);
});

test("a rebuttal sustained before the verification obligation says the verification is not recorded", () => {
  const review = cleanInTwoRounds();
  delete review.rereview_decisions[1].verification;
  assert.match(
    render(review),
    /- Rereviewer verification: not recorded \(the decision predates the verification obligation\)/,
  );
});

test("a MERGE_READY publication renders the pull request, Codex results, checks, threads, acknowledgements, and the derivation it rests on", () => {
  const publication = mergeReadyPublication();
  Object.assign(publication.automatic_resolutions[0], {
    thread_watermark: "1".repeat(64),
    recorded_revision: 4,
  });
  const markdown = render(cleanInTwoRounds({ status: "LOCAL_GATE_PASSED" }), { publication });
  assert.match(markdown, /## Remote publication\n\n- Pull request: owner\/repo#7, `feat\/thing` into `main`\n- Authorized head: `c{40}` over base `a{40}`\n- Authorization: `LOCAL_GATE`\n- Codex trigger policy: `EXPLICIT_ONLY`/);
  assert.match(markdown, /### Codex review requests\n\n\| # \| Request \| Requested head \| Posted at \| Classification \| URL \|\n\| --- [^\n]+\n\| 1 \| rbreq-1 \| cccccccccccc \| 2026-09-01T00:41:00\.000Z \| RECOGNIZED \| https:\/\/example\.test\/pr\/7#issuecomment-1 \|/);
  assert.match(markdown, /### Codex results in the latest observation\n\n[^\n]+\n[^\n]+\n\| 1 \| CLEAN \| SINGLE_OPEN_REQUEST \| rbreq-1 \| cccccccccccc \| 2026-09-01T00:45:00\.000Z \| https:\/\/example\.test\/pr\/7#issuecomment-2 \|\n\nResults recorded in the ledger's own history: 1\./);
  assert.match(markdown, /### Required checks\n\nPolicy `BRANCH_PROTECTION`; requirements: `ci`\.\n\n[^\n]+\n[^\n]+\n\| ci \| CHECK_RUN \| COMPLETED \| SUCCESS \| 2026-09-01T00:50:00\.000Z \|/);
  assert.match(markdown, /\| PRRT_1 \| src\/a\.mjs:9 \| 2 by codex\[bot\], author \| resolved by record 1 \(action act-1, reply comment 55, head cccccccccccc\) \|/);
  assert.match(markdown, /\| PRRT_2 \| src\/b\.mjs:1 \| 1 by reviewer \| resolved on GitHub; no active automatic-resolution record \|/);
  assert.match(markdown, /\| SUPERSEDED_BY_LATER_OWN_REQUEST \| cccccccccccc \| 1 \| 0 \| server-derived \| 2026-09-01T00:41:00\.000Z \|/);
  assert.match(
    markdown,
    new RegExp(
      `- Publication status: \`MERGE_READY\` at revision 5\\n- MERGE_READY rests on the observation recorded at revision 5, observed 2026-09-01T01:00:00\\.000Z, recorded 2026-09-01T01:00:01\\.000Z, canonical sha256 \`${canonicalDigest(OBSERVATION)}\`\\.`,
    ),
  );
  assert.match(markdown, /- Publication ledger revision: 5\n- Report revision: `6-p5`/);
  assert.match(markdown, /- Ledger: `reviews\/[^`]+\/review\.json`, `reviews\/[^`]+\/publication\.json`/);
  assert.equal(reportRevision(cleanInTwoRounds(), publication), "6-p5");
});

test("an unresolved thread and a publication without an observation are stated, not guessed", () => {
  const publication = mergeReadyPublication();
  publication.status = "CHANGES_REQUIRED";
  publication.latest_observation.review_threads.threads[1].is_resolved = false;
  publication.automatic_resolutions = [];
  let markdown = render(cleanInTwoRounds(), { publication });
  assert.match(markdown, /\| PRRT_1 \| [^|]+\| [^|]+\| resolved on GitHub; no active automatic-resolution record \|/);
  assert.match(markdown, /\| PRRT_2 \| [^|]+\| [^|]+\| unresolved; left for a human \|/);
  assert.match(markdown, /- Publication status: `CHANGES_REQUIRED` at revision 5\n- No MERGE_READY derivation is rendered for this status\./);

  publication.latest_observation = null;
  publication.status = "PR_PENDING";
  markdown = render(cleanInTwoRounds(), { publication });
  assert.match(markdown, /### Codex results in the latest observation\n\nThe latest observation holds no Codex result\./);
  assert.match(markdown, /### Required checks\n\nNo observation has been recorded\./);
  assert.match(markdown, /### Review threads\n\nNo observation has been recorded\./);
});

// A REMOTE_ONLY publication has no review ledger: the header comes from the
// authorization file beside it, and the footer says which ledger is absent.
function remoteAuthorization() {
  return {
    version: 1,
    review_id: REVIEW_ID,
    mode: "REMOTE_ONLY",
    acknowledgement: "LOCAL_REVIEW_SKIPPED",
    authorized_at: "2026-09-01T00:39:00.000Z",
    operator_label: "jeremy",
    rationale: "Standing instruction: remote-only review.",
    repository_path: "/tmp/repo",
    base_sha: BASE,
    head_sha: HEAD_TWO,
    reviewer_provider: null,
  };
}

test("a REMOTE_ONLY publication renders without a review ledger, from its publication and authorization", () => {
  const publication = mergeReadyPublication();
  publication.authorization = {
    mode: "REMOTE_ONLY",
    acknowledgement: "LOCAL_REVIEW_SKIPPED",
    base_sha: BASE,
    head_sha: HEAD_TWO,
    operator_label: "jeremy",
    rationale: "Standing instruction: remote-only review.",
    reviewer_provider: null,
  };
  const markdown = render(null, {
    publication,
    remoteAuthorization: remoteAuthorization(),
    ledgerDirectory: "/store/reviews/x",
  });
  assert.ok(markdown.startsWith("# Review report rb-2026-09-01T000000-000Z-0badf00d\n"));
  assert.match(markdown, /## Local review\n\nNone: this publication was authorized `REMOTE_ONLY` with local review skipped, so there is no review ledger, no rounds, and no findings to render\. The authorization is under Remote publication\.\n\n## Remote publication\n/);
  // The authorization file's repository and time are printed once, under
  // Remote publication, not repeated in the local section.
  assert.match(markdown, /- Authorization: `REMOTE_ONLY`, acknowledgement `LOCAL_REVIEW_SKIPPED`, operator jeremy, at 2026-09-01T00:39:00\.000Z\n- Authorized repository: `\/tmp\/repo`\n- Authorization rationale:\n    Standing instruction: remote-only review\.\n- Codex trigger policy/);
  assert.equal(markdown.match(/Standing instruction: remote-only review\./g).length, 1);
  assert.equal(markdown.match(/acknowledgement `LOCAL_REVIEW_SKIPPED`/g).length, 1);
  for (const absent of ["### Rounds", "### Findings", "### Changes between rounds", "### Outcome"]) {
    assert.ok(!markdown.includes(absent), `${absent} rendered without a review`);
  }
  assert.match(markdown, /## Remote publication\n\n- Pull request: owner\/repo#7/);
  assert.match(markdown, /- MERGE_READY rests on the observation recorded at revision 5/);
  assert.match(markdown, /- Review ledger state_version: n\/a \(remote-only: no local review ledger\)\n- Publication ledger revision: 5\n- Report revision: `p5`\n- Rendered at: [^\n]+\n- Ledger: `\/store\/reviews\/x\/publication\.json`, `\/store\/reviews\/x\/remote-authorization\.json`/);
  assert.ok(markdown.endsWith(`\n${PROJECTION_NOTICE}\n`));
  assert.equal(reportRevision(null, publication), "p5");

  // Without the authorization file the publication's own authorization stands in.
  const fallback = render(null, { publication });
  assert.match(fallback, /- Authorization: `REMOTE_ONLY`, acknowledgement `LOCAL_REVIEW_SKIPPED`, operator jeremy\n- Authorization rationale:/);
  assert.doesNotMatch(fallback, /Authorized repository/);
  assert.match(fallback, /- Ledger: `reviews\/rb-2026-09-01T000000-000Z-0badf00d\/publication\.json`\n/);
  assert.throws(() => render(null, {}), /needs a review ledger or a publication ledger/);
});

// A missing review ledger is explained only by a REMOTE_ONLY authorization.
// Under any other authorization the store is incomplete, and rendering "local
// review skipped" over it would be a false report.
test("a LOCAL_GATE publication without its review ledger is refused, not rendered as skipped", () => {
  const publication = mergeReadyPublication();
  assert.throws(() => render(null, { publication }), (error) => {
    assert.equal(error.code, "REVIEW_LEDGER_MISSING");
    assert.match(error.message, /review ledger missing for a LOCAL_GATE publication/);
    return true;
  });
  // A version-1 publication has no authorization record and was always local-gate.
  delete publication.authorization;
  assert.throws(() => render(null, { publication }), { code: "REVIEW_LEDGER_MISSING" });
});

// The observation's resolved flag is read against the replay of the records
// and their lifecycle, so a retired record never explains a resolved thread
// and an unresolve after an automatic resolution is reported as history.
test("a thread's outcome follows the lifecycle replay, not the presence of a record", () => {
  const publication = mergeReadyPublication();
  const [record] = publication.automatic_resolutions;
  // The replay needs the fields the writer records; the frontier compares them.
  Object.assign(record, {
    thread_watermark: "1".repeat(64),
    recorded_revision: 4,
  });
  publication.latest_observation.pull_request.head_sha = HEAD_TWO;
  // Active record and a resolved thread: attributed to the record.
  let markdown = render(cleanInTwoRounds(), { publication });
  assert.match(markdown, /\| PRRT_1 \| [^|]+\| [^|]+\| resolved by record 1 \(action act-1, reply comment 55, head cccccccccccc\) \|/);

  // The record was invalidated and unresolved for repair; the observation now
  // shows the thread unresolved. That is a legitimate state, reported as such.
  publication.resolution_lifecycle = [
    {
      number: 1,
      kind: "INVALIDATED",
      thread_id: "PRRT_1",
      record_id: "act-1",
      prior_watermark: "1".repeat(64),
      new_watermark: "3".repeat(64),
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
  publication.latest_observation.review_threads.threads[0].is_resolved = false;
  markdown = render(cleanInTwoRounds(), { publication });
  assert.match(markdown, /\| PRRT_1 \| [^|]+\| [^|]+\| unresolved; left for a human; record 1 resolved it automatically and is no longer active \(THREAD_RESOLUTION_INVALIDATED\) \|/);

  // A retired record does not explain a thread GitHub shows resolved either.
  publication.latest_observation.review_threads.threads[0].is_resolved = true;
  markdown = render(cleanInTwoRounds(), { publication });
  assert.match(markdown, /\| PRRT_1 \| [^|]+\| [^|]+\| resolved on GitHub; no active automatic-resolution record; record 1 resolved it automatically and is no longer active \(THREAD_RESOLUTION_INVALIDATED\) \|/);

  // An active record with an observation that shows the thread unresolved is
  // a disagreement the report states rather than resolves.
  publication.resolution_lifecycle = [];
  publication.latest_observation.review_threads.threads[0].is_resolved = false;
  markdown = render(cleanInTwoRounds(), { publication });
  assert.match(markdown, /\| PRRT_1 \| [^|]+\| [^|]+\| unresolved; left for a human; record 1 is active in the ledger but the observation shows the thread unresolved \|/);
});

test("rendering is a pure function of its inputs", () => {
  const review = cleanInTwoRounds();
  const publication = mergeReadyPublication();
  const before = JSON.stringify([review, publication]);
  const first = render(review, { publication });
  const second = render(review, { publication });
  assert.equal(first, second);
  assert.equal(JSON.stringify([review, publication]), before);
});

async function store(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-report-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return root;
}

async function writeLedger(root, name, value) {
  const directory = path.join(root, "reviews", REVIEW_ID);
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  await fsp.writeFile(path.join(directory, name), canonicalJsonBytes(value), { mode: 0o600 });
  return directory;
}

// A remote-only publication bound to its authorization file the way
// authorize_remote_publication and start_publication leave them: the ledger's
// authorization carries the sidecar's digest, head, and base.
async function writeRemoteOnlyLedgers(root, mutateSidecar = (value) => value) {
  const sidecar = mutateSidecar(remoteAuthorization());
  const directory = await writeLedger(root, "remote-authorization.json", sidecar);
  const publication = mergeReadyPublication();
  publication.authorization = {
    mode: "REMOTE_ONLY",
    acknowledgement: "LOCAL_REVIEW_SKIPPED",
    authorized_at: "2026-09-01T00:39:00.000Z",
    base_sha: BASE,
    head_sha: HEAD_TWO,
    operator_label: "jeremy",
    rationale: "Standing instruction: remote-only review.",
    reviewer_provider: null,
    snapshot_hash: null,
    source_sha256: sha256(canonicalJsonBytes(remoteAuthorization())),
  };
  await writeLedger(root, "publication.json", publication);
  return { directory, publication };
}

test("the store writer names the file by the ledger revision and is idempotent at that revision", async (t) => {
  const root = await store(t);
  const directory = await writeLedger(root, "review.json", cleanInTwoRounds());

  const first = await writeReviewReport(root, REVIEW_ID, { renderedAt: RENDERED_AT });
  assert.equal(first.path, path.join(directory, "report-r6.md"));
  assert.equal(first.reused, false);
  assert.equal(first.revision, "6");
  assert.equal(first.review_state_version, 6);
  assert.equal(first.publication_revision, null);
  // A receipt, never the Markdown: the file holds the report, the receipt
  // holds what identifies it.
  assert.equal(first.markdown, undefined);
  const written = await fsp.readFile(first.path);
  assert.equal(written.length, first.bytes);
  assert.equal(crypto.createHash("sha256").update(written).digest("hex"), first.sha256);
  assert.equal(
    written.toString("utf8"),
    renderReviewReport(cleanInTwoRounds(), { renderedAt: RENDERED_AT, ledgerDirectory: directory }),
  );
  assert.equal((await fsp.stat(first.path)).mode & 0o777, 0o600);

  // A second render at the same revision keeps the same bytes, render time
  // included, and rewrites nothing.
  const second = await writeReviewReport(root, REVIEW_ID, {
    renderedAt: "2026-09-11T00:00:00.000Z",
  });
  assert.equal(second.reused, true);
  assert.equal(second.sha256, first.sha256);
  assert.equal(second.bytes, first.bytes);
  assert.equal(await fsp.readFile(first.path, "utf8"), written.toString("utf8"));
  assert.deepEqual(
    (await fsp.readdir(directory)).sort(),
    ["report-r6.md", "review.json"],
  );

  // A publication arriving later is a new revision and a new file beside it.
  await writeLedger(root, "publication.json", mergeReadyPublication());
  const withPublication = await writeReviewReport(root, REVIEW_ID, {
    renderedAt: RENDERED_AT,
  });
  assert.equal(withPublication.path, path.join(directory, "report-r6-p5.md"));
  assert.equal(withPublication.reused, false);
  assert.equal(withPublication.publication_revision, 5);
  const withPublicationText = await fsp.readFile(withPublication.path, "utf8");
  assert.match(withPublicationText, /- Pull request: owner\/repo#7/);
  assert.match(withPublicationText, new RegExp(`- Ledger: \`${directory}/review\\.json\`, \`${directory}/publication\\.json\``));
  // The ledgers themselves are untouched.
  assert.deepEqual(JSON.parse(await fsp.readFile(path.join(directory, "review.json"), "utf8")), cleanInTwoRounds());
});

test("a remote-only publication is written as report-p<revision>.md from the publication and authorization alone", async (t) => {
  const root = await store(t);
  const { directory } = await writeRemoteOnlyLedgers(root);
  const written = await writeReviewReport(root, REVIEW_ID, { renderedAt: RENDERED_AT });
  assert.equal(written.path, path.join(directory, "report-p5.md"));
  assert.equal(written.reused, false);
  assert.equal(written.revision, "p5");
  assert.equal(written.review_state_version, null);
  assert.equal(written.publication_revision, 5);
  const text = await fsp.readFile(written.path, "utf8");
  assert.match(text, /authorized `REMOTE_ONLY` with local review skipped/);
  assert.match(text, /- Authorization: `REMOTE_ONLY`, acknowledgement `LOCAL_REVIEW_SKIPPED`, operator jeremy, at 2026-09-01T00:39:00\.000Z\n- Authorized repository: `\/tmp\/repo`/);
  assert.match(text, new RegExp(`- Ledger: \`${directory}/publication\\.json\`, \`${directory}/remote-authorization\\.json\``));
  assert.equal(crypto.createHash("sha256").update(text).digest("hex"), written.sha256);
  assert.deepEqual(
    (await fsp.readdir(directory)).sort(),
    ["publication.json", "remote-authorization.json", "report-p5.md"],
  );
});

// The sidecar is admitted only through the publication reader's own binding
// check, so an edited or replaced authorization file fails the render instead
// of lending the report a head, base, operator, or rationale the ledger never
// bound; a missing sidecar is the same failure.
test("a remote-only authorization file that the ledger does not bind fails the render closed", async (t) => {
  const root = await store(t);
  const { directory } = await writeRemoteOnlyLedgers(root, (sidecar) => ({
    ...sidecar,
    head_sha: "d".repeat(40),
    rationale: "an edited rationale",
  }));
  await assert.rejects(writeReviewReport(root, REVIEW_ID), (error) => {
    assert.equal(error.code, "REMOTE_AUTHORIZATION_INVALID");
    assert.match(error.message, /publication authorization changed/);
    return true;
  });
  assert.deepEqual(
    (await fsp.readdir(directory)).sort(),
    ["publication.json", "remote-authorization.json"],
  );

  // A sidecar with the bound head but different bytes is the same failure:
  // the ledger binds the digest, not only the fields the report prints.
  await fsp.rm(path.join(directory, "remote-authorization.json"));
  await writeLedger(root, "remote-authorization.json", {
    ...remoteAuthorization(),
    operator_label: "someone else",
  });
  await assert.rejects(writeReviewReport(root, REVIEW_ID), { code: "REMOTE_AUTHORIZATION_INVALID" });

  await fsp.rm(path.join(directory, "remote-authorization.json"));
  await assert.rejects(writeReviewReport(root, REVIEW_ID), { code: "PUBLICATION_AUTHORIZATION_INVALID" });
  assert.deepEqual(await fsp.readdir(directory), ["publication.json"]);
});

// Two renderers racing on one revision must leave one file, and each receipt
// must describe that file: the loser reuses the winner's bytes rather than
// replacing them with a render that differs by its render time.
test("concurrent renders at one revision produce one file that both receipts describe", async (t) => {
  const root = await store(t);
  const directory = await writeLedger(root, "review.json", cleanInTwoRounds());
  const [first, second] = await Promise.all([
    writeReviewReport(root, REVIEW_ID, { renderedAt: "2026-09-10T12:00:00.000Z" }),
    writeReviewReport(root, REVIEW_ID, { renderedAt: "2026-09-10T12:00:01.000Z" }),
  ]);
  assert.equal(first.path, second.path);
  assert.equal(first.sha256, second.sha256);
  assert.equal(first.bytes, second.bytes);
  assert.deepEqual([first.reused, second.reused].sort(), [false, true]);
  const onDisk = await fsp.readFile(first.path);
  assert.equal(crypto.createHash("sha256").update(onDisk).digest("hex"), first.sha256);
  assert.equal(onDisk.length, first.bytes);
  // No temporary file survives the race.
  assert.deepEqual((await fsp.readdir(directory)).sort(), ["report-r6.md", "review.json"]);
});

test("a missing or malformed ledger is a structured error, and an invalid ID never reaches the store", async (t) => {
  const root = await store(t);
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
  // A local-gate publication beside no review ledger is an incomplete store.
  await writeLedger(root, "publication.json", mergeReadyPublication());
  await assert.rejects(writeReviewReport(root, REVIEW_ID), (error) => {
    assert.equal(error.code, "REVIEW_LEDGER_MISSING");
    assert.equal(error.details.path, path.join(root, "reviews", REVIEW_ID, "review.json"));
    return true;
  });
  assert.deepEqual(await fsp.readdir(path.join(root, "reviews", REVIEW_ID)), ["publication.json"]);
  await fsp.rm(path.join(root, "reviews", REVIEW_ID, "publication.json"));
  const directory = await writeLedger(root, "review.json", cleanInTwoRounds());
  await fsp.writeFile(path.join(directory, "publication.json"), "{not json");
  await assert.rejects(writeReviewReport(root, REVIEW_ID), (error) => {
    assert.equal(error.code, "LEDGER_UNREADABLE");
    return true;
  });
  assert.deepEqual(
    (await fsp.readdir(directory)).sort(),
    ["publication.json", "review.json"],
  );
});
