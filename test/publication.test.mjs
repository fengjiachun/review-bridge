import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  finalizeLocalGate,
  prepareReview,
  submitInitialReview,
} from "../src/core.mjs";
import {
  acknowledgeCodexReviewAmbiguity,
  derivePublicationStatus,
  finalizePublicationGate,
  getPublication,
  publicationConstants,
  recordCodexReviewRequest,
  recordGithubSnapshot,
  startPublication,
  verifyPublicationGate,
} from "../src/publication.mjs";
import {
  atomicWriteCanonicalJson,
  canonicalJson,
  StoreError,
} from "../src/storage.mjs";

function git(cwd, ...args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function iso(milliseconds) {
  return new Date(milliseconds).toISOString();
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-publication-"));
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
  });
  await submitInitialReview(store, review.id, []);
  await finalizeLocalGate(store, review.id);
  return { root, repository, store, reviewId: review.id, baseSha, headSha };
}

function completeSource(kind, collectedAt, extra = {}) {
  return {
    kind,
    endpoint: `GET /fixture/${kind}`,
    collected_at: collectedAt,
    status: "COMPLETE",
    ...extra,
  };
}

function baseline(at, requests = []) {
  const sourceAt = iso(at - 100);
  return {
    observed_at: iso(at),
    collection: {
      status: "COMPLETE",
      collected_at: sourceAt,
      adapter_version: 1,
      sources: [
        completeSource("ISSUE_COMMENTS", sourceAt, {
          pagination_complete: true,
          page_count: 1,
        }),
        completeSource("PULL_REQUEST_REVIEWS", sourceAt, {
          pagination_complete: true,
          page_count: 1,
        }),
        completeSource("PULL_REQUEST_REVIEW_COMMENTS", sourceAt, {
          pagination_complete: true,
          page_count: 1,
        }),
      ],
    },
    requests,
    candidate_results: [],
  };
}

function observation({
  at,
  baseSha,
  headSha,
  requestId,
  requestAt,
  withResult = true,
  headOverride = headSha,
  baselineRequests = [],
}) {
  const pullBaseAt = iso(at - 900);
  const checksBaseAt = iso(at - 800);
  const pullAt = iso(at - 700);
  const runAt = iso(at - 600);
  const codexAt = iso(at - 500);
  const threadsAt = iso(at - 400);
  const request = {
    comment_id: requestId,
    resource_kind: "ISSUE_COMMENT",
    url: `https://github.com/owner/repo/issues/7#issuecomment-${requestId}`,
    event_at: iso(requestAt),
    timestamp_field: "created_at",
    body: "@codex review",
    body_sha256: publicationConstants.request_body_sha256,
    requested_head_sha: headSha,
  };
  const result = {
    result_id: requestId + 1,
    resource_kind: "ISSUE_COMMENT",
    native_review_state: null,
    url: `https://github.com/owner/repo/issues/7#issuecomment-${requestId + 1}`,
    event_at: iso(requestAt + 100),
    timestamp_field: "created_at",
    actor: {
      id: 99,
      type: "Bot",
      login: "chatgpt-codex-connector[bot]",
    },
    request_ref: {
      resource_kind: "ISSUE_COMMENT",
      resource_id: requestId,
    },
    association: "SINGLE_OPEN_REQUEST",
    reviewed_head_sha: headSha,
    commit_binding: {
      source: "CODEX_REVIEWED_COMMIT_PREFIX_AND_REQUEST_HEAD",
      field: "body.reviewed_commit",
      prefix: headSha.slice(0, 10),
    },
    attached_review_comments: [],
    format: "CODEX_CLEAN_COMMENT_V1",
    verdict: "CLEAN",
    body_sha256: digest("codex clean result"),
  };
  return {
    observed_at: iso(at),
    pull_request: {
      collection: {
        status: "COMPLETE",
        collected_at: pullAt,
        sources: [
          completeSource("PULL_REQUEST", pullAt),
          completeSource("BASE_BRANCH_METADATA", pullBaseAt, {
            branch_tip_sha: baseSha,
          }),
          completeSource("BASE_HEAD_COMPARISON", pullAt),
          completeSource("REVIEWED_BASE_CURRENT_BASE_COMPARISON", pullAt),
        ],
      },
      repository_id: 42,
      number: 7,
      url: "https://github.com/owner/repo/pull/7",
      state: "OPEN",
      is_merged: false,
      merged_at: null,
      merge_commit_sha: null,
      is_draft: false,
      head_sha: headOverride,
      head_branch: "agent/change",
      base_branch: "main",
      pr_reported_base_sha: baseSha,
      base_sha: baseSha,
      mergeable: "MERGEABLE",
      base_head_comparison: {
        status: "AHEAD",
        source: "REST_COMPARE_BASE_TO_HEAD",
        base_sha: baseSha,
        head_sha: headOverride,
      },
      reviewed_base_current_base_comparison: {
        status: "IDENTICAL",
        source: "REST_COMPARE_REVIEWED_BASE_TO_CURRENT_BASE",
        base_sha: baseSha,
        head_sha: baseSha,
      },
    },
    required_checks: {
      collection: {
        status: "COMPLETE",
        collected_at: runAt,
        policy_sources: [
          {
            kind: "APPLICABLE_RULES",
            endpoint: "GET /fixture/rules",
            collected_at: checksBaseAt,
            result: "SUCCESS",
            pagination_complete: true,
            page_count: 1,
          },
          {
            kind: "BRANCH_METADATA",
            endpoint: "GET /fixture/branch",
            collected_at: checksBaseAt,
            result: "SUCCESS",
            protected: false,
            branch_tip_sha: baseSha,
          },
        ],
        run_sources: [
          {
            ...completeSource("CHECK_RUN", runAt, {
            pagination_complete: true,
            page_count: 1,
            item_count: 0,
            reported_total_count: 0,
            }),
            endpoint: "GET /repos/owner/repo/commits/head/check-runs?filter=all",
          },
          completeSource("COMMIT_STATUS", runAt, {
            pagination_complete: true,
            page_count: 1,
            item_count: 0,
            reported_total_count: null,
          }),
        ],
      },
      policy: "NONE_CONFIGURED",
      strict_policy: { required: false, sources: [] },
      requirements: [],
      runs: [],
    },
    codex_review: {
      collection: {
        status: "COMPLETE",
        collected_at: codexAt,
        adapter_version: 1,
        sources: [
          completeSource("ISSUE_COMMENTS", codexAt, {
            pagination_complete: true,
            page_count: 1,
          }),
          completeSource("PULL_REQUEST_REVIEWS", codexAt, {
            pagination_complete: true,
            page_count: 1,
          }),
          completeSource("PULL_REQUEST_REVIEW_COMMENTS", codexAt, {
            pagination_complete: true,
            page_count: 1,
          }),
        ],
      },
      preexisting_requests: baselineRequests,
      preexisting_candidate_results: [],
      requests: requestId == null ? [] : [request],
      unbound_requests: [],
      unsupported_requests: [],
      foreign_actor_objects: [],
      results: withResult && requestId != null ? [result] : [],
    },
    review_threads: {
      collection: {
        status: "COMPLETE",
        collected_at: threadsAt,
        sources: [
          completeSource("PULL_REQUEST_REVIEW_THREADS", threadsAt, {
            pagination_complete: true,
            page_count: 1,
          }),
        ],
      },
      total_count: 0,
      unresolved_count: 0,
      threads: [],
    },
  };
}

async function start(fixtureState, startedAt, baselineOverride = null) {
  return startPublication(
    fixtureState.store,
    {
      reviewId: fixtureState.reviewId,
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
      baseline: baselineOverride ?? baseline(startedAt - 100),
    },
    { clock: () => startedAt },
  );
}

async function reachReady(state, startedAt = Date.now()) {
  await start(state, startedAt);
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
  return { ready, requestAt, observedAt };
}

test("publication ledger reaches a fresh audited merge gate", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const startedAt = Date.now();
  const created = await start(state, startedAt);
  assert.equal(created.status, "PR_PENDING");
  assert.equal(created.revision, 1);

  const requestAt = startedAt + 1_000;
  const requested = await recordCodexReviewRequest(
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
  assert.equal(requested.status, "PR_PENDING");
  assert.equal(requested.latest_observation, null);

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
  assert.equal(ready.revision, 3);

  const gate = await finalizePublicationGate(
    state.store,
    state.reviewId,
    { expectedRevision: 3 },
    { clock: () => observedAt + 20 },
  );
  assert.equal(gate.issuance_committed, true);
  const publicationPath = path.join(
    state.store,
    "reviews",
    state.reviewId,
    "publication.json",
  );
  const beforeVerification = await fsp.readFile(publicationPath);
  const verified = await verifyPublicationGate(state.store, state.reviewId, {
    clock: () => observedAt + 30,
  });
  assert.equal(verified.valid, true);
  assert.equal(verified.head_sha, state.headSha);
  assert.deepEqual(await fsp.readFile(publicationPath), beforeVerification);

  const audit = await fsp.readFile(
    path.join(
      state.store,
      "reviews",
      state.reviewId,
      "publication-gate-audit.jsonl",
    ),
    "utf8",
  );
  const events = audit.trim().split("\n").map(JSON.parse);
  assert.deepEqual(events.map((event) => event.event), [
    "GATE_FINALIZATION_PASSED",
    "GATE_VERIFIED",
  ]);
  assert.equal(events[1].previous_event_sha256, digest(audit.trim().split("\n")[0]));
});

test("a later ledger mutation revokes the publication gate before advancing", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const startedAt = Date.now();
  await start(state, startedAt);
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
  await recordGithubSnapshot(
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
  await finalizePublicationGate(
    state.store,
    state.reviewId,
    { expectedRevision: 3 },
    { clock: () => observedAt + 20 },
  );

  const secondRequestAt = observedAt + 100;
  const ledger = await recordCodexReviewRequest(
    state.store,
    state.reviewId,
    {
      expectedRevision: 3,
      commentId: 200,
      url: "https://github.com/owner/repo/issues/7#issuecomment-200",
      createdAt: iso(secondRequestAt),
      requestedHeadSha: state.headSha,
    },
    { clock: () => secondRequestAt + 10 },
  );
  assert.equal(ledger.status, "PR_PENDING");
  assert.equal(ledger.history.at(-1).cleared_observation_sha256.length, 64);
  await assert.rejects(
    fsp.access(
      path.join(
        state.store,
        "reviews",
        state.reviewId,
        "publication-gate.json",
      ),
    ),
  );
  assert.equal((await getPublication(state.store, state.reviewId)).revision, 4);
});

test("authorization mode drift is non-mutating and actionable", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const startedAt = Date.now();
  await start(state, startedAt);
  const auditPath = path.join(
    state.store,
    "reviews",
    state.reviewId,
    "publication-gate-audit.jsonl",
  );
  await fsp.chmod(auditPath, 0o644);
  const before = await fsp.readFile(auditPath);
  await assert.rejects(
    verifyPublicationGate(state.store, state.reviewId),
    (error) => error instanceof StoreError && error.code === "STORE_MODE_MISMATCH",
  );
  assert.deepEqual(await fsp.readFile(auditPath), before);
});

test("a changed pull request head terminally invalidates the ledger", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const startedAt = Date.now();
  await start(state, startedAt);
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
  const changedHead = "f".repeat(40);
  const invalidated = await recordGithubSnapshot(
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
        headOverride: changedHead,
      }),
    },
    { clock: () => observedAt + 10 },
  );
  assert.equal(invalidated.status, "INVALIDATED");
  assert.equal(invalidated.terminal.status, "INVALIDATED");
  await assert.rejects(
    recordGithubSnapshot(
      state.store,
      state.reviewId,
      {
        expectedRevision: 3,
        observation: observation({
          at: observedAt + 100,
          baseSha: state.baseSha,
          headSha: state.headSha,
          requestId: 100,
          requestAt,
        }),
      },
      { clock: () => observedAt + 110 },
    ),
    /PUBLICATION_TERMINAL/,
  );
});

test("a preexisting request requires exact direct-human closure before posting", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const startedAt = Date.now();
  const baselineRequest = {
    resource_id: 77,
    resource_kind: "ISSUE_COMMENT",
    url: "https://github.com/owner/repo/issues/7#issuecomment-77",
    event_at: iso(startedAt - 500),
    timestamp_field: "created_at",
    body_sha256: publicationConstants.request_body_sha256,
    actor: { id: 123, type: "User" },
  };
  await start(
    state,
    startedAt,
    baseline(startedAt - 100, [baselineRequest]),
  );
  const observedAt = startedAt + 1_000;
  const unknown = await recordGithubSnapshot(
    state.store,
    state.reviewId,
    {
      expectedRevision: 1,
      observation: observation({
        at: observedAt,
        baseSha: state.baseSha,
        headSha: state.headSha,
        requestId: null,
        requestAt: observedAt,
        withResult: false,
        baselineRequests: [baselineRequest],
      }),
    },
    { clock: () => observedAt + 10 },
  );
  assert.equal(unknown.status, "GITHUB_REVIEW_UNKNOWN");
  await assert.rejects(
    acknowledgeCodexReviewAmbiguity(
      state.store,
      state.reviewId,
      {
        expectedRevision: 2,
        headSha: state.headSha,
        requestRefs: [],
        ambiguousResults: [],
        acknowledgement: "NO_FURTHER_RESULTS_EXPECTED",
        operatorLabel: "maintainer",
        rationale: "The old request will not answer.",
      },
      { clock: () => observedAt + 20 },
    ),
    /ACKNOWLEDGEMENT_SET_MISMATCH/,
  );
  const acknowledged = await acknowledgeCodexReviewAmbiguity(
    state.store,
    state.reviewId,
    {
      expectedRevision: 2,
      headSha: state.headSha,
      requestRefs: [
        { resource_kind: "ISSUE_COMMENT", resource_id: 77 },
      ],
      ambiguousResults: [],
      acknowledgement: "NO_FURTHER_RESULTS_EXPECTED",
      operatorLabel: "maintainer",
      rationale: "The old request will not answer.",
    },
    { clock: () => observedAt + 20 },
  );
  assert.equal(acknowledged.status, "GITHUB_REVIEW_NOT_REQUESTED");
  assert.deepEqual(
    acknowledged.codex_review_ambiguity_acknowledgements[0].closed_requests,
    [{ resource_kind: "ISSUE_COMMENT", resource_id: 77 }],
  );
});

test("gate verification is valid at expiry and fails one millisecond later", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const { ready, observedAt } = await reachReady(state);
  const gate = await finalizePublicationGate(
    state.store,
    state.reviewId,
    { expectedRevision: ready.revision },
    { clock: () => observedAt + 20 },
  );
  const expires = Date.parse(gate.expires_at);
  assert.equal(
    (
      await verifyPublicationGate(state.store, state.reviewId, {
        clock: () => expires,
      })
    ).valid,
    true,
  );
  const expired = await verifyPublicationGate(state.store, state.reviewId, {
    clock: () => expires + 1,
  });
  assert.equal(expired.valid, false);
  assert.equal(expired.reason, "EVIDENCE_STALE");
  assert.equal(expired.head_sha, null);
});

test("verification truncates one incomplete audit crash tail before appending", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const { ready, observedAt } = await reachReady(state);
  await finalizePublicationGate(
    state.store,
    state.reviewId,
    { expectedRevision: ready.revision },
    { clock: () => observedAt + 20 },
  );
  const directory = path.join(state.store, "reviews", state.reviewId);
  const auditPath = path.join(directory, "publication-gate-audit.jsonl");
  const headPath = path.join(directory, "publication-gate-audit-head.json");
  const headBefore = JSON.parse(await fsp.readFile(headPath, "utf8"));
  await fsp.appendFile(auditPath, '{"incomplete":');

  const verified = await verifyPublicationGate(state.store, state.reviewId, {
    clock: () => observedAt + 30,
  });
  assert.equal(verified.valid, true);
  const lines = (await fsp.readFile(auditPath, "utf8")).trim().split("\n");
  assert.equal(lines.length, 2);
  assert.doesNotMatch(lines.join(""), /incomplete/);
  const headAfter = JSON.parse(await fsp.readFile(headPath, "utf8"));
  assert.equal(headAfter.next_sequence, headBefore.next_sequence + 1);
});

test("verification adopts one complete valid audit crash tail", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const { ready, observedAt } = await reachReady(state);
  const gate = await finalizePublicationGate(
    state.store,
    state.reviewId,
    { expectedRevision: ready.revision },
    { clock: () => observedAt + 20 },
  );
  const directory = path.join(state.store, "reviews", state.reviewId);
  const auditPath = path.join(directory, "publication-gate-audit.jsonl");
  const headPath = path.join(directory, "publication-gate-audit-head.json");
  const head = JSON.parse(await fsp.readFile(headPath, "utf8"));
  const crashEvent = {
    version: 1,
    review_id: state.reviewId,
    sequence: head.next_sequence,
    event_id: "1".repeat(32),
    previous_event_sha256: head.last_event_sha256,
    event: "GATE_VERIFIED",
    outcome: "FAILURE",
    normalized_reason: "SIMULATED_CRASH",
    at: iso(observedAt + 25),
    publication_revision: ready.revision,
    head_sha: state.headSha,
    github_observation_sha256: gate.github_observation_sha256,
    gate_sha256: digest(canonicalJson(gate)),
    expires_at: gate.expires_at,
  };
  await fsp.appendFile(auditPath, `${canonicalJson(crashEvent)}\n`);

  const verified = await verifyPublicationGate(state.store, state.reviewId, {
    clock: () => observedAt + 30,
  });
  assert.equal(verified.valid, true);
  const lines = (await fsp.readFile(auditPath, "utf8")).trim().split("\n");
  assert.equal(lines.length, 3);
  const headAfter = JSON.parse(await fsp.readFile(headPath, "utf8"));
  assert.equal(headAfter.next_sequence, head.next_sequence + 2);
});

test("a disappeared recorded Codex result persists terminal invalidation", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const startedAt = Date.now();
  const { ready, requestAt, observedAt } = await reachReady(state, startedAt);
  const missingResult = observation({
    at: observedAt + 100,
    baseSha: state.baseSha,
    headSha: state.headSha,
    requestId: 100,
    requestAt,
    withResult: false,
  });
  const invalidated = await recordGithubSnapshot(
    state.store,
    state.reviewId,
    {
      expectedRevision: ready.revision,
      observation: missingResult,
    },
    { clock: () => observedAt + 110 },
  );
  assert.equal(invalidated.status, "INVALIDATED");
  assert.match(invalidated.terminal.reason, /result ISSUE_COMMENT:101 disappeared/);
});

test("post-to-list omission is retryable for 30 seconds, then terminal", async (t) => {
  const first = await fixture();
  t.after(() => fsp.rm(first.root, { recursive: true, force: true }));
  const startedAt = Date.now();
  await start(first, startedAt);
  const requestAt = startedAt + 1_000;
  await recordCodexReviewRequest(
    first.store,
    first.reviewId,
    {
      expectedRevision: 1,
      commentId: 100,
      url: "https://github.com/owner/repo/issues/7#issuecomment-100",
      createdAt: iso(requestAt),
      requestedHeadSha: first.headSha,
    },
    { clock: () => requestAt + 10 },
  );
  const omittedAt = requestAt + 100;
  const omitted = await recordGithubSnapshot(
    first.store,
    first.reviewId,
    {
      expectedRevision: 2,
      observation: observation({
        at: omittedAt,
        baseSha: first.baseSha,
        headSha: first.headSha,
        requestId: null,
        requestAt,
        withResult: false,
      }),
    },
    { clock: () => omittedAt + 10 },
  );
  assert.equal(omitted.status, "EVIDENCE_INCOMPLETE");
  assert.equal(omitted.codex_request_history.length, 1);
  const retryAt = omittedAt + 100;
  const ready = await recordGithubSnapshot(
    first.store,
    first.reviewId,
    {
      expectedRevision: 3,
      observation: observation({
        at: retryAt,
        baseSha: first.baseSha,
        headSha: first.headSha,
        requestId: 100,
        requestAt,
      }),
    },
    { clock: () => retryAt + 10 },
  );
  assert.equal(ready.status, "MERGE_READY");

  const second = await fixture();
  t.after(() => fsp.rm(second.root, { recursive: true, force: true }));
  await start(second, startedAt);
  await recordCodexReviewRequest(
    second.store,
    second.reviewId,
    {
      expectedRevision: 1,
      commentId: 100,
      url: "https://github.com/owner/repo/issues/7#issuecomment-100",
      createdAt: iso(requestAt),
      requestedHeadSha: second.headSha,
    },
    { clock: () => requestAt + 10 },
  );
  const lateAt = requestAt + 31_100;
  const invalidated = await recordGithubSnapshot(
    second.store,
    second.reviewId,
    {
      expectedRevision: 2,
      observation: observation({
        at: lateAt,
        baseSha: second.baseSha,
        headSha: second.headSha,
        requestId: null,
        requestAt,
        withResult: false,
      }),
    },
    { clock: () => lateAt + 10 },
  );
  assert.equal(invalidated.status, "INVALIDATED");
  assert.match(invalidated.terminal.reason, /request ISSUE_COMMENT:100 disappeared/);
});

test("reserved history capacity records terminal invalidation instead of losing evidence", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const startedAt = Date.now();
  const ledger = await start(state, startedAt);
  ledger.revision = 9_999;
  ledger.history = Array.from({ length: 9_999 }, (_, index) => ({
    at: ledger.created_at,
    event: index === 0 ? "PUBLICATION_STARTED" : "GITHUB_SNAPSHOT_RECORDED",
    revision: index + 1,
    status: "PR_PENDING",
    head_sha: state.headSha,
  }));
  const publicationPath = path.join(
    state.store,
    "reviews",
    state.reviewId,
    "publication.json",
  );
  await atomicWriteCanonicalJson(publicationPath, ledger);
  const requestAt = startedAt + 1_000;
  const terminal = await recordCodexReviewRequest(
    state.store,
    state.reviewId,
    {
      expectedRevision: 9_999,
      commentId: 100,
      url: "https://github.com/owner/repo/issues/7#issuecomment-100",
      createdAt: iso(requestAt),
      requestedHeadSha: state.headSha,
    },
    { clock: () => requestAt + 10 },
  );
  assert.equal(terminal.status, "INVALIDATED");
  assert.equal(terminal.revision, 10_000);
  assert.equal(terminal.history.length, 10_000);
  assert.equal(terminal.codex_request_history.length, 0);
  assert.match(terminal.terminal.reason, /monotonic publication state/);
});

test("pure publication derivation preserves the normative blocking priority", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const { ready } = await reachReady(state);

  const draft = structuredClone(ready);
  draft.latest_observation.pull_request.is_draft = true;
  assert.equal(derivePublicationStatus(draft).status, "PR_DRAFT");

  const conflicting = structuredClone(ready);
  conflicting.latest_observation.pull_request.mergeable = "CONFLICTING";
  assert.equal(derivePublicationStatus(conflicting).status, "PR_CONFLICTING");

  const strictBehind = structuredClone(ready);
  strictBehind.latest_observation.required_checks.policy = "STRICT_ONLY";
  strictBehind.latest_observation.required_checks.strict_policy = {
    required: true,
    sources: [
      {
        kind: "CLASSIC_BRANCH_PROTECTION",
        field: "required_status_checks.strict",
        value: true,
      },
    ],
  };
  strictBehind.latest_observation.pull_request.base_head_comparison.status =
    "BEHIND";
  assert.equal(
    derivePublicationStatus(strictBehind).status,
    "PR_UPDATE_REQUIRED",
  );

  const unresolved = structuredClone(ready);
  unresolved.latest_observation.review_threads.threads = [
    {
      id: "thread-1",
      is_resolved: false,
      is_outdated: true,
      path: "value.js",
      line: 1,
    },
  ];
  unresolved.latest_observation.review_threads.total_count = 1;
  unresolved.latest_observation.review_threads.unresolved_count = 1;
  assert.equal(
    derivePublicationStatus(unresolved).status,
    "CHANGES_REQUIRED",
  );

  const baseInvalidated = structuredClone(ready);
  baseInvalidated.latest_observation.pull_request
    .reviewed_base_current_base_comparison.status = "DIVERGED";
  assert.equal(
    derivePublicationStatus(baseInvalidated).status,
    "INVALIDATED",
  );
});
