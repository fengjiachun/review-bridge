import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
  authorizeRemotePublication,
  derivePublicationStatus,
  finalizePublicationGate,
  getPublication,
  getPublicationSummary,
  getThreadResolutionPlan,
  inspectPublicationAudit,
  publicationConstants,
  readObservationFile,
  recordCodexReviewRequest,
  recordGithubSnapshot,
  startPublication,
  threadResolutionEligibility,
  verifyPublicationGate,
} from "../src/publication.mjs";
import { adaptCodexEvidence } from "../src/github-adapter.mjs";
import { PUBLICATION_ACTION_INPUTS } from "../src/tool-inputs.mjs";
import {
  acquireStateLock,
  atomicWriteCanonicalJson,
  canonicalJson,
  StoreError,
} from "../src/storage.mjs";
import {
  baseline,
  baselineV2,
  completeSource,
  correlatedRequestBody,
  digest,
  iso,
  observation,
  observationV2,
} from "./helpers/github-observation.mjs";

const APP_SUMMARY_BODY =
  "<!-- codex-pull-request-review-summary -->\n\n## Codex Review Summary";
const UNKNOWN_APP_BODY = "Codex is thinking about this pull request.";

function git(cwd, ...args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}


async function fixture(reviewerProvider = "CLAUDE_DESKTOP") {
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
    reviewerProvider,
  });
  await submitInitialReview(store, review.id, [], reviewerProvider);
  await finalizeLocalGate(store, review.id);
  return { root, repository, store, reviewId: review.id, baseSha, headSha };
}

async function remoteFixture(authorizedAt = Date.now()) {
  const state = await fixture();
  const authorization = await authorizeRemotePublication(
    state.store,
    {
      repositoryPath: state.repository,
      baseSha: state.baseSha,
      headSha: state.headSha,
      acknowledgement: "LOCAL_REVIEW_SKIPPED",
      operatorLabel: "maintainer",
      rationale: "Use the GitHub Codex, CI, and review-thread gates only.",
    },
    { clock: () => authorizedAt },
  );
  return {
    ...state,
    reviewId: authorization.review_id,
    authorization,
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

async function successorFixture(state) {
  await fsp.writeFile(
    path.join(state.repository, "value.js"),
    "export const value = 3;\n",
  );
  git(state.repository, "add", ".");
  git(state.repository, "commit", "-m", "successor");
  const headSha = git(state.repository, "rev-parse", "HEAD");
  const review = await prepareReview(state.store, {
    repositoryPath: state.repository,
    baseRef: state.baseSha,
    requirement: "Change the exported value again.",
    implementationScope: "Update value.js.",
  });
  await submitInitialReview(state.store, review.id, []);
  await finalizeLocalGate(state.store, review.id);
  return { ...state, reviewId: review.id, headSha };
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

test("publication summary reports compact next actions and gate state", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const startedAt = Date.now();
  await start(state, startedAt);

  const created = await getPublicationSummary(state.store, state.reviewId);
  assert.deepEqual(created, {
    review_id: state.reviewId,
    revision: 1,
    status: "PR_PENDING",
    authorization_mode: "LOCAL_GATE",
    base_sha: state.baseSha,
    head_sha: state.headSha,
    target: {
      owner: "owner",
      repo: "repo",
      pr_number: 7,
      base_branch: "main",
      head_branch: "agent/change",
    },
    latest_observed_at: null,
    blocking_reason: "NO_GITHUB_SNAPSHOT",
    next_action: "POST_AND_RECORD_CODEX_REVIEW_REQUEST",
    codex_review_request: {
      body: "@codex review",
      body_sha256: publicationConstants.request_body_sha256,
    },
    required_request_refs: [],
    required_ambiguous_results: [],
    required_inputs:
      PUBLICATION_ACTION_INPUTS.POST_AND_RECORD_CODEX_REVIEW_REQUEST,
    gate_state: "ABSENT",
    gate_expires_in_seconds: null,
  });

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
  const requested = await getPublicationSummary(state.store, state.reviewId);
  assert.equal(requested.blocking_reason, "NO_GITHUB_SNAPSHOT");
  assert.equal(requested.next_action, "RECORD_GITHUB_SNAPSHOT");

  const pendingAt = startedAt + 2_000;
  await recordGithubSnapshot(
    state.store,
    state.reviewId,
    {
      expectedRevision: 2,
      observation: observation({
        at: pendingAt,
        baseSha: state.baseSha,
        headSha: state.headSha,
        requestId: 100,
        requestAt,
        withResult: false,
      }),
    },
    { clock: () => pendingAt + 10 },
  );
  const pending = await getPublicationSummary(state.store, state.reviewId);
  assert.equal(pending.status, "GITHUB_REVIEW_PENDING");
  assert.equal(pending.blocking_reason, "GITHUB_REVIEW_PENDING");
  assert.equal(pending.next_action, "REFRESH_GITHUB_SNAPSHOT");

  const readyAt = startedAt + 3_000;
  await recordGithubSnapshot(
    state.store,
    state.reviewId,
    {
      expectedRevision: 3,
      observation: observation({
        at: readyAt,
        baseSha: state.baseSha,
        headSha: state.headSha,
        requestId: 100,
        requestAt,
      }),
    },
    { clock: () => readyAt + 10 },
  );
  const ready = await getPublicationSummary(state.store, state.reviewId);
  assert.equal(ready.status, "MERGE_READY");
  assert.equal(ready.blocking_reason, null);
  assert.equal(ready.next_action, "FINALIZE_PUBLICATION_GATE");
  assert.equal(ready.gate_state, "ABSENT");

  await finalizePublicationGate(
    state.store,
    state.reviewId,
    { expectedRevision: 4 },
    { clock: () => readyAt + 20 },
  );
  const finalized = await getPublicationSummary(state.store, state.reviewId);
  assert.equal(finalized.next_action, "VERIFY_PUBLICATION_GATE");
  assert.equal(finalized.gate_state, "PRESENT");
});

test("version 2 derives and binds one correlated Codex request", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const startedAt = Date.now();
  await start(state, startedAt, baselineV2(startedAt - 100));

  const created = await getPublicationSummary(state.store, state.reviewId);
  assert.equal(created.next_action, "POST_AND_RECORD_CODEX_REVIEW_REQUEST");
  assert.match(created.codex_review_request.request_id, /^rbreq-[0-9a-f]{32}$/);
  assert.equal(
    created.codex_review_request.body,
    correlatedRequestBody(created.codex_review_request.request_id),
  );

  const requestAt = startedAt + 1_000;
  await assert.rejects(
    recordCodexReviewRequest(
      state.store,
      state.reviewId,
      {
        expectedRevision: 1,
        commentId: 100,
        url: "https://github.com/owner/repo/issues/7#issuecomment-100",
        createdAt: iso(requestAt),
        requestedHeadSha: state.headSha,
        requestId: `rbreq-${"f".repeat(32)}`,
      },
      { clock: () => requestAt + 10 },
    ),
    /request_id does not match/,
  );
  const requested = await recordCodexReviewRequest(
    state.store,
    state.reviewId,
    {
      expectedRevision: 1,
      commentId: 100,
      url: "https://github.com/owner/repo/issues/7#issuecomment-100",
      createdAt: iso(requestAt),
      requestedHeadSha: state.headSha,
      requestId: created.codex_review_request.request_id,
    },
    { clock: () => requestAt + 10 },
  );
  assert.equal(
    requested.codex_request_history[0].request_id,
    created.codex_review_request.request_id,
  );
  assert.equal(
    requested.codex_request_history[0].body_sha256,
    digest(created.codex_review_request.body),
  );

  const observedAt = startedAt + 2_000;
  const ready = await recordGithubSnapshot(
    state.store,
    state.reviewId,
    {
      expectedRevision: 2,
      observation: observationV2(
        {
          at: observedAt,
          baseSha: state.baseSha,
          headSha: state.headSha,
          requestId: 100,
          requestAt,
        },
        created.codex_review_request.request_id,
      ),
    },
    { clock: () => observedAt + 10 },
  );
  assert.equal(ready.status, "MERGE_READY");
});

test("version 2 accepts one markerless result bound to the authorized head", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const startedAt = Date.now();
  await start(state, startedAt, baselineV2(startedAt - 100));
  const source = await getPublicationSummary(state.store, state.reviewId);
  const oldRequestId = source.codex_review_request.request_id;
  const oldRequestAt = startedAt + 1_000;
  const oldRequest = {
    resource_id: 90,
    resource_kind: "ISSUE_COMMENT",
    url: "https://github.com/owner/repo/issues/7#issuecomment-90",
    event_at: iso(oldRequestAt),
    timestamp_field: "created_at",
    body_sha256: digest(correlatedRequestBody(oldRequestId)),
    request_id: oldRequestId,
    actor: { id: 7, type: "User" },
  };
  await recordCodexReviewRequest(
    state.store,
    state.reviewId,
    {
      expectedRevision: 1,
      commentId: 90,
      url: oldRequest.url,
      createdAt: oldRequest.event_at,
      requestedHeadSha: state.headSha,
      requestId: oldRequestId,
    },
    { clock: () => oldRequestAt + 10 },
  );
  const successor = await successorFixture(state);
  await start(
    successor,
    startedAt + 2_000,
    baselineV2(startedAt + 1_900, [oldRequest]),
  );
  const publication = await getPublication(
    successor.store,
    successor.reviewId,
  );
  const storedBaseline = publication.codex_review_baseline.requests[0];
  assert.deepEqual(storedBaseline.issuance, {
    review_id: state.reviewId,
    recorded_revision: 2,
    requested_head_sha: state.headSha,
  });
  const created = await getPublicationSummary(
    successor.store,
    successor.reviewId,
  );
  const requestAt = startedAt + 3_000;
  await recordCodexReviewRequest(
    successor.store,
    successor.reviewId,
    {
      expectedRevision: 1,
      commentId: 100,
      url: "https://github.com/owner/repo/issues/7#issuecomment-100",
      createdAt: iso(requestAt),
      requestedHeadSha: successor.headSha,
      requestId: created.codex_review_request.request_id,
    },
    { clock: () => requestAt + 10 },
  );
  const current = observationV2(
    {
      at: startedAt + 4_000,
      baseSha: successor.baseSha,
      headSha: successor.headSha,
      requestId: 100,
      requestAt,
      baselineRequests: [
        {
          ...oldRequest,
          issuance: storedBaseline.issuance,
        },
      ],
    },
    created.codex_review_request.request_id,
  );
  current.codex_review.results[0].request_id = null;
  current.codex_review.results[0].association = "SINGLE_OPEN_REQUEST";
  current.codex_review.results[0].format = "CODEX_CLEAN_COMMENT_V1";
  const missingRequestId = structuredClone(current);
  delete missingRequestId.codex_review.results[0].request_id;
  await assert.rejects(
    recordGithubSnapshot(
      successor.store,
      successor.reviewId,
      { expectedRevision: 2, observation: missingRequestId },
      { clock: () => startedAt + 4_010 },
    ),
    /version 2 results must include request_id/,
  );

  const ready = await recordGithubSnapshot(
    successor.store,
    successor.reviewId,
    { expectedRevision: 2, observation: current },
    { clock: () => startedAt + 4_010 },
  );
  assert.equal(ready.status, "MERGE_READY");
});

test("version 2 rejects a markerless result with an unverified baseline request", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const startedAt = Date.now();
  const oldRequestId = `rbreq-${"1".repeat(32)}`;
  const oldRequest = {
    resource_id: 90,
    resource_kind: "ISSUE_COMMENT",
    url: "https://github.com/owner/repo/issues/7#issuecomment-90",
    event_at: iso(startedAt - 1_000),
    timestamp_field: "created_at",
    body_sha256: digest(correlatedRequestBody(oldRequestId)),
    request_id: oldRequestId,
    actor: { id: 7, type: "User" },
  };
  await start(
    state,
    startedAt,
    baselineV2(startedAt - 100, [oldRequest]),
  );
  const created = await getPublicationSummary(state.store, state.reviewId);
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
      requestId: created.codex_review_request.request_id,
    },
    { clock: () => requestAt + 10 },
  );
  const current = observationV2(
    {
      at: startedAt + 2_000,
      baseSha: state.baseSha,
      headSha: state.headSha,
      requestId: 100,
      requestAt,
      baselineRequests: [oldRequest],
    },
    created.codex_review_request.request_id,
  );
  current.codex_review.results[0].request_id = null;
  current.codex_review.results[0].association = "SINGLE_OPEN_REQUEST";
  current.codex_review.results[0].format = "CODEX_CLEAN_COMMENT_V1";

  const blocked = await recordGithubSnapshot(
    state.store,
    state.reviewId,
    { expectedRevision: 2, observation: current },
    { clock: () => startedAt + 2_010 },
  );
  assert.equal(blocked.status, "GITHUB_REVIEW_UNKNOWN");
});

test("version 2 rejects caller-supplied baseline issuance provenance", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const startedAt = Date.now();
  const requestId = `rbreq-${"1".repeat(32)}`;
  const request = {
    resource_id: 90,
    resource_kind: "ISSUE_COMMENT",
    url: "https://github.com/owner/repo/issues/7#issuecomment-90",
    event_at: iso(startedAt - 1_000),
    timestamp_field: "created_at",
    body_sha256: digest(correlatedRequestBody(requestId)),
    request_id: requestId,
    actor: { id: 7, type: "User" },
    issuance: {
      review_id: state.reviewId,
      recorded_revision: 2,
      requested_head_sha: state.headSha,
    },
  };
  await assert.rejects(
    start(
      state,
      startedAt,
      baselineV2(startedAt - 100, [request]),
    ),
    /issuance provenance is server-derived/,
  );
});

test("version 2 rejects head-claiming 64-hex request IDs", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const startedAt = Date.now();
  const requestId = `rbreq-${state.baseSha}${"1".repeat(24)}`;
  await assert.rejects(
    start(
      state,
      startedAt,
      baselineV2(startedAt - 100, [
        {
          resource_id: 90,
          resource_kind: "ISSUE_COMMENT",
          url: "https://github.com/owner/repo/issues/7#issuecomment-90",
          event_at: iso(startedAt - 1_000),
          timestamp_field: "created_at",
          body_sha256: digest(correlatedRequestBody(requestId)),
          request_id: requestId,
          actor: { id: 7, type: "User" },
        },
      ]),
    ),
    /request_id is invalid/,
  );
});

test("version 2 ignores a delayed result correlated to a baseline request", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const startedAt = Date.now();
  const oldRequestId = `rbreq-${"1".repeat(32)}`;
  const oldRequestBody = correlatedRequestBody(oldRequestId);
  const oldRequest = {
    resource_id: 90,
    resource_kind: "ISSUE_COMMENT",
    url: "https://github.com/owner/repo/issues/7#issuecomment-90",
    event_at: iso(startedAt - 1_000),
    timestamp_field: "created_at",
    body_sha256: digest(oldRequestBody),
    request_id: oldRequestId,
    actor: { id: 7, type: "User" },
  };
  await start(
    state,
    startedAt,
    baselineV2(startedAt - 100, [oldRequest]),
  );

  const created = await getPublicationSummary(state.store, state.reviewId);
  assert.equal(created.next_action, "POST_AND_RECORD_CODEX_REVIEW_REQUEST");
  assert.deepEqual(created.required_request_refs, []);

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
      requestId: created.codex_review_request.request_id,
    },
    { clock: () => requestAt + 10 },
  );

  const observedAt = startedAt + 2_000;
  const value = observationV2(
    {
      at: observedAt,
      baseSha: state.baseSha,
      headSha: state.headSha,
      requestId: 100,
      requestAt,
      baselineRequests: [oldRequest],
    },
    created.codex_review_request.request_id,
  );
  value.codex_review.results.unshift({
    result_id: 91,
    resource_kind: "ISSUE_COMMENT",
    native_review_state: null,
    url: "https://github.com/owner/repo/issues/7#issuecomment-91",
    event_at: iso(requestAt + 50),
    timestamp_field: "created_at",
    actor: {
      id: 99,
      type: "Bot",
      login: "chatgpt-codex-connector[bot]",
    },
    request_ref: {
      resource_kind: "ISSUE_COMMENT",
      resource_id: 90,
    },
    association: "BASELINE_LATE_RESULT",
    reviewed_head_sha: state.headSha,
    commit_binding: {
      source: "CODEX_REVIEWED_COMMIT_PREFIX_AND_REQUEST_HEAD",
      field: "body.reviewed_commit",
      prefix: state.headSha.slice(0, 10),
    },
    attached_review_comments: [],
    format: "UNKNOWN",
    verdict: "UNKNOWN",
    body_sha256: digest("delayed predecessor result"),
    request_id: oldRequestId,
  });

  const ready = await recordGithubSnapshot(
    state.store,
    state.reviewId,
    {
      expectedRevision: 2,
      observation: value,
    },
    { clock: () => observedAt + 10 },
  );
  assert.equal(ready.status, "MERGE_READY");
});

test("version 2 rejects a forged correlated baseline classification", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const startedAt = Date.now();
  const requestId = `rbreq-${"1".repeat(32)}`;
  const request = {
    resource_id: 90,
    resource_kind: "ISSUE_COMMENT",
    url: "https://github.com/owner/repo/issues/7#issuecomment-90",
    event_at: iso(startedAt - 1_000),
    timestamp_field: "created_at",
    body_sha256: digest("@codex review with untrusted metadata"),
    request_id: requestId,
    actor: { id: 7, type: "User" },
  };
  const started = await start(
    state,
    startedAt,
    baselineV2(startedAt - 100, [request]),
  );
  assert.equal(
    started.codex_review_baseline.requests[0].classification,
    "BASELINE_UNSUPPORTED",
  );

  started.codex_review_baseline.requests[0].classification =
    "BASELINE_CORRELATED";
  started.codex_review_baseline.requests[0].reason = null;
  await atomicWriteCanonicalJson(
    path.join(
      state.store,
      "reviews",
      state.reviewId,
      "publication.json",
    ),
    started,
  );
  await assert.rejects(
    getPublication(state.store, state.reviewId),
    /stored baseline request classification changed/,
  );
});

test("version 2 validates unbound request IDs and canonical bodies", async (t) => {
  for (const [name, requestId, bodySha256] of [
    ["missing request ID", undefined, digest("@codex review")],
    ["null request ID", null, digest("@codex review")],
    [
      "mismatched body",
      `rbreq-${"e".repeat(32)}`,
      digest("@codex review with changed guidance"),
    ],
    [
      "array-wrapped request ID",
      [`rbreq-${"e".repeat(32)}`],
      digest(correlatedRequestBody(`rbreq-${"e".repeat(32)}`)),
    ],
    [
      "request ID with trailing newline",
      `rbreq-${"e".repeat(32)}\n`,
      digest(correlatedRequestBody(`rbreq-${"e".repeat(32)}\n`)),
    ],
  ]) {
    await t.test(name, async (t) => {
      const state = await fixture();
      t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
      const startedAt = Date.now();
      await start(state, startedAt, baselineV2(startedAt - 100));
      const current = observationV2(
        {
          at: startedAt + 1_000,
          baseSha: state.baseSha,
          headSha: state.headSha,
          requestId: null,
          requestAt: startedAt,
          withResult: false,
        },
        null,
      );
      current.codex_review.unbound_requests.push({
        resource_id: 150,
        resource_kind: "ISSUE_COMMENT",
        url: "https://github.com/owner/repo/issues/7#issuecomment-150",
        event_at: iso(startedAt + 500),
        timestamp_field: "created_at",
        body_sha256: bodySha256,
        ...(requestId === undefined ? {} : { request_id: requestId }),
        reason: "MISSING_POST_BINDING",
      });
      await assert.rejects(
        recordGithubSnapshot(
          state.store,
          state.reviewId,
          { expectedRevision: 1, observation: current },
          { clock: () => startedAt + 1_010 },
        ),
        /request_id is invalid|version 2 unbound request is not canonical/,
      );
    });
  }

  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const startedAt = Date.now();
  await start(state, startedAt, baselineV2(startedAt - 100));
  const requestId = `rbreq-${"e".repeat(32)}`;
  const current = observationV2(
    {
      at: startedAt + 1_000,
      baseSha: state.baseSha,
      headSha: state.headSha,
      requestId: null,
      requestAt: startedAt,
      withResult: false,
    },
    null,
  );
  current.codex_review.unbound_requests.push({
    resource_id: 150,
    resource_kind: "ISSUE_COMMENT",
    url: "https://github.com/owner/repo/issues/7#issuecomment-150",
    event_at: iso(startedAt + 500),
    timestamp_field: "created_at",
    body_sha256: digest(correlatedRequestBody(requestId)),
    request_id: requestId,
    reason: "MISSING_POST_BINDING",
  });
  const recorded = await recordGithubSnapshot(
    state.store,
    state.reviewId,
    { expectedRevision: 1, observation: current },
    { clock: () => startedAt + 1_010 },
  );
  recorded.codex_request_history[0].request_id = null;
  await atomicWriteCanonicalJson(
    path.join(
      state.store,
      "reviews",
      state.reviewId,
      "publication.json",
    ),
    recorded,
  );
  await assert.rejects(
    getPublication(state.store, state.reviewId),
    /stored version 2 unbound request is not canonical/,
  );
});

test("version 2 acknowledgements keep closed request IDs out of replay", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const startedAt = Date.now();
  await start(state, startedAt, baselineV2(startedAt - 100));
  const firstSummary = await getPublicationSummary(state.store, state.reviewId);
  const firstRequestId = firstSummary.codex_review_request.request_id;
  const firstRequestAt = startedAt + 1_000;
  await recordCodexReviewRequest(
    state.store,
    state.reviewId,
    {
      expectedRevision: 1,
      commentId: 100,
      url: "https://github.com/owner/repo/issues/7#issuecomment-100",
      createdAt: iso(firstRequestAt),
      requestedHeadSha: state.headSha,
      requestId: firstRequestId,
    },
    { clock: () => firstRequestAt + 10 },
  );
  const unboundRequestId = `rbreq-${"e".repeat(32)}`;
  const unboundRequest = {
    resource_id: 150,
    resource_kind: "ISSUE_COMMENT",
    url: "https://github.com/owner/repo/issues/7#issuecomment-150",
    event_at: iso(firstRequestAt + 50),
    timestamp_field: "created_at",
    body_sha256: digest(correlatedRequestBody(unboundRequestId)),
    request_id: unboundRequestId,
    reason: "MISSING_POST_BINDING",
  };
  const ambiguous = observationV2(
    {
      at: startedAt + 2_000,
      baseSha: state.baseSha,
      headSha: state.headSha,
      requestId: 100,
      requestAt: firstRequestAt,
      withResult: false,
    },
    firstRequestId,
  );
  ambiguous.codex_review.unbound_requests.push(unboundRequest);
  await recordGithubSnapshot(
    state.store,
    state.reviewId,
    {
      expectedRevision: 2,
      observation: ambiguous,
    },
    { clock: () => startedAt + 2_010 },
  );
  const unknown = await getPublicationSummary(state.store, state.reviewId);
  assert.equal(unknown.required_request_refs.length, 2);
  await acknowledgeCodexReviewAmbiguity(
    state.store,
    state.reviewId,
    {
      expectedRevision: 3,
      headSha: state.headSha,
      requestRefs: unknown.required_request_refs,
      ambiguousResults: [],
      acknowledgement: "NO_FURTHER_RESULTS_EXPECTED",
      operatorLabel: "maintainer",
      rationale: "Close the legacy correlation epoch.",
    },
    { clock: () => startedAt + 2_020 },
  );

  const delayedResult = (resultId, eventAt) => ({
    result_id: resultId,
    resource_kind: "ISSUE_COMMENT",
    native_review_state: null,
    url: `https://github.com/owner/repo/issues/7#issuecomment-${resultId}`,
    event_at: iso(eventAt),
    timestamp_field: "created_at",
    actor: {
      id: 99,
      type: "Bot",
      login: "chatgpt-codex-connector[bot]",
    },
    request_ref: null,
    association: "UNSOLICITED",
    reviewed_head_sha: null,
    commit_binding: {
      source: "CODEX_REVIEWED_COMMIT_PREFIX_AND_REQUEST_HEAD",
      field: "body.reviewed_commit",
      prefix: state.headSha.slice(0, 10),
    },
    attached_review_comments: [],
    format: "UNKNOWN",
    verdict: "UNKNOWN",
    body_sha256: digest(`delayed result ${resultId}`),
    request_id: firstRequestId,
  });
  const delayedBeforeReplacement = observationV2(
    {
      at: startedAt + 3_000,
      baseSha: state.baseSha,
      headSha: state.headSha,
      requestId: 100,
      requestAt: firstRequestAt,
      withResult: false,
    },
    firstRequestId,
  );
  delayedBeforeReplacement.codex_review.unbound_requests.push(unboundRequest);
  delayedBeforeReplacement.codex_review.results.push(
    delayedResult(101, startedAt + 2_500),
  );
  const accepted = await recordGithubSnapshot(
    state.store,
    state.reviewId,
    { expectedRevision: 4, observation: delayedBeforeReplacement },
    { clock: () => startedAt + 3_010 },
  );
  assert.equal(accepted.status, "GITHUB_REVIEW_NOT_REQUESTED");

  const replacementSummary = await getPublicationSummary(
    state.store,
    state.reviewId,
  );
  const replacementId = replacementSummary.codex_review_request.request_id;
  const replacementAt = startedAt + 4_000;
  await recordCodexReviewRequest(
    state.store,
    state.reviewId,
    {
      expectedRevision: 5,
      commentId: 200,
      url: "https://github.com/owner/repo/issues/7#issuecomment-200",
      createdAt: iso(replacementAt),
      requestedHeadSha: state.headSha,
      requestId: replacementId,
    },
    { clock: () => replacementAt + 10 },
  );
  const replacement = observationV2(
    {
      at: startedAt + 5_000,
      baseSha: state.baseSha,
      headSha: state.headSha,
      requestId: 200,
      requestAt: replacementAt,
    },
    replacementId,
  );
  replacement.codex_review.unbound_requests.push(unboundRequest);
  replacement.codex_review.requests.unshift(
    delayedBeforeReplacement.codex_review.requests[0],
  );
  replacement.codex_review.results.unshift(
    delayedResult(101, startedAt + 2_500),
    delayedResult(102, replacementAt + 50),
  );
  const ready = await recordGithubSnapshot(
    state.store,
    state.reviewId,
    { expectedRevision: 6, observation: replacement },
    { clock: () => startedAt + 5_010 },
  );
  assert.equal(ready.status, "MERGE_READY");
});

test("publication summary refreshes expired evidence instead of prescribing gate verification", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const { ready, observedAt } = await reachReady(state);
  const gate = await finalizePublicationGate(
    state.store,
    state.reviewId,
    { expectedRevision: ready.revision },
    { clock: () => observedAt + 20 },
  );

  const summary = await getPublicationSummary(
    state.store,
    state.reviewId,
    { clock: () => Date.parse(gate.expires_at) + 1 },
  );
  assert.equal(summary.status, "MERGE_READY");
  assert.equal(summary.blocking_reason, "EVIDENCE_STALE");
  assert.equal(summary.next_action, "REFRESH_GITHUB_SNAPSHOT");
  assert.equal(summary.gate_state, "EXPIRED");
});

test("publication summary reports the finalized gate's remaining window", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const { ready, observedAt } = await reachReady(state);
  const gate = await finalizePublicationGate(
    state.store,
    state.reviewId,
    { expectedRevision: ready.revision },
    { clock: () => observedAt + 20 },
  );
  // The window runs from the oldest source collection in the observation, so
  // this gate is already 920ms into its five minutes when it is issued.
  const expiresAt = Date.parse(gate.expires_at);
  assert.equal(expiresAt, observedAt - 900 + 5 * 60 * 1_000);

  const live = await getPublicationSummary(state.store, state.reviewId, {
    clock: () => expiresAt - 120_500,
  });
  assert.equal(live.gate_state, "PRESENT");
  assert.equal(live.gate_expires_in_seconds, 120);

  // The gate is alive at its expiry instant and dead one millisecond later:
  // the reported window has to agree with that comparison from both sides.
  const boundary = await getPublicationSummary(state.store, state.reviewId, {
    clock: () => expiresAt,
  });
  assert.equal(boundary.gate_state, "PRESENT");
  assert.equal(boundary.gate_expires_in_seconds, 0);

  const expired = await getPublicationSummary(state.store, state.reviewId, {
    clock: () => expiresAt + 1,
  });
  assert.equal(expired.gate_state, "EXPIRED");
  assert.equal(expired.gate_expires_in_seconds, null);
});

test("publication summary refinalizes an uncommitted crash candidate", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const { ready, observedAt } = await reachReady(state);
  const gate = await finalizePublicationGate(
    state.store,
    state.reviewId,
    { expectedRevision: ready.revision },
    { clock: () => observedAt + 20 },
  );
  await atomicWriteCanonicalJson(
    path.join(
      state.store,
      "reviews",
      state.reviewId,
      "publication-gate.json",
    ),
    { ...gate, issuance_committed: false },
  );

  const summary = await getPublicationSummary(
    state.store,
    state.reviewId,
    { clock: () => observedAt + 30 },
  );
  assert.equal(summary.status, "MERGE_READY");
  assert.equal(summary.blocking_reason, "PUBLICATION_GATE_INVALID");
  assert.equal(summary.next_action, "FINALIZE_PUBLICATION_GATE");
  assert.equal(summary.gate_state, "INVALID");
});

test("publication summary refreshes GitHub evidence to recover a malformed gate", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const { ready, observedAt } = await reachReady(state);
  await finalizePublicationGate(
    state.store,
    state.reviewId,
    { expectedRevision: ready.revision },
    { clock: () => observedAt + 20 },
  );
  await fsp.writeFile(
    path.join(
      state.store,
      "reviews",
      state.reviewId,
      "publication-gate.json",
    ),
    "{malformed\n",
    { mode: 0o600 },
  );

  const summary = await getPublicationSummary(
    state.store,
    state.reviewId,
    { clock: () => observedAt + 30 },
  );
  assert.equal(summary.status, "MERGE_READY");
  assert.equal(summary.blocking_reason, "PUBLICATION_GATE_MALFORMED");
  assert.equal(summary.next_action, "REFRESH_GITHUB_SNAPSHOT");
  assert.equal(summary.gate_state, "MALFORMED");
});

test("publication state rejects mutually consistent foreign review IDs", async (t) => {
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
  const publicationPath = path.join(directory, "publication.json");
  const gatePath = path.join(directory, "publication-gate.json");
  const publication = JSON.parse(await fsp.readFile(publicationPath, "utf8"));
  const gate = JSON.parse(await fsp.readFile(gatePath, "utf8"));
  const foreignReviewId = `${state.reviewId.slice(0, -8)}deadbeef`;
  await atomicWriteCanonicalJson(publicationPath, {
    ...publication,
    review_id: foreignReviewId,
  });
  await atomicWriteCanonicalJson(gatePath, {
    ...gate,
    review_id: foreignReviewId,
  });

  for (const operation of [
    () => getPublication(state.store, state.reviewId),
    () => getPublicationSummary(state.store, state.reviewId),
    () => verifyPublicationGate(state.store, state.reviewId),
  ]) {
    await assert.rejects(
      operation(),
      (error) => error?.code === "PUBLICATION_STORE_INVALID",
    );
  }
});

test("publication summary exposes the exact ambiguity acknowledgement sets", async (t) => {
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
  await recordGithubSnapshot(
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

  const summary = await getPublicationSummary(state.store, state.reviewId);
  assert.equal(summary.status, "GITHUB_REVIEW_UNKNOWN");
  assert.equal(
    summary.next_action,
    "ACKNOWLEDGE_CODEX_REVIEW_AMBIGUITY",
  );
  assert.deepEqual(summary.required_request_refs, [
    { resource_kind: "ISSUE_COMMENT", resource_id: 77 },
  ]);
  assert.deepEqual(summary.required_ambiguous_results, []);
});

test("publication ledger reaches a fresh audited merge gate", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const startedAt = Date.now();
  const created = await start(state, startedAt);
  assert.equal(created.status, "PR_PENDING");
  assert.equal(created.revision, 1);
  assert.equal(created.authorization.reviewer_provider, "CLAUDE_DESKTOP");

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
  assert.equal(gate.reviewer_provider, "CLAUDE_DESKTOP");
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
  assert.equal(verified.reviewer_provider, "CLAUDE_DESKTOP");
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

test("HERMES local gates propagate through publication surfaces", async (t) => {
  const state = await fixture("HERMES");
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const startedAt = Date.now();
  const created = await start(state, startedAt);
  assert.equal(created.status, "PR_PENDING");
  assert.equal(created.revision, 1);
  assert.equal(created.authorization.reviewer_provider, "HERMES");

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

  const gate = await finalizePublicationGate(
    state.store,
    state.reviewId,
    { expectedRevision: ready.revision },
    { clock: () => observedAt + 20 },
  );
  assert.equal(gate.issuance_committed, true);
  assert.equal(gate.reviewer_provider, "HERMES");

  const verified = await verifyPublicationGate(state.store, state.reviewId, {
    clock: () => observedAt + 30,
  });
  assert.equal(verified.valid, true);
  assert.equal(verified.reviewer_provider, "HERMES");
});

test("request binding canonicalizes GitHub second-precision timestamps", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const startedAt = Math.floor(Date.now() / 1_000) * 1_000;
  const publication = await start(state, startedAt);
  const requestAt = startedAt + 1_000;
  const githubCreatedAt = iso(requestAt).replace(".000Z", "Z");

  const requested = await recordCodexReviewRequest(
    state.store,
    state.reviewId,
    {
      expectedRevision: publication.revision,
      commentId: 100,
      url: "https://github.com/owner/repo/issues/7#issuecomment-100",
      createdAt: githubCreatedAt,
      requestedHeadSha: state.headSha,
    },
    { clock: () => requestAt + 10 },
  );

  assert.equal(requested.codex_request_history[0].event_at, iso(requestAt));
});

test("remote-only authorization reaches the same audited merge gate", async (t) => {
  const startedAt = Date.now();
  const state = await remoteFixture(startedAt - 100);
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));

  assert.equal(state.authorization.mode, "REMOTE_ONLY");
  assert.equal(state.authorization.head_sha, state.headSha);
  assert.equal(state.authorization.base_sha, state.baseSha);
  assert.equal(state.authorization.reviewer_provider, null);
  assert.equal(state.authorization.acknowledgement, "LOCAL_REVIEW_SKIPPED");
  const authorizationPath = path.join(
    state.store,
    "reviews",
    state.reviewId,
    "remote-authorization.json",
  );
  assert.equal((await fsp.stat(authorizationPath)).mode & 0o777, 0o600);

  const created = await start(state, startedAt);
  assert.equal(created.version, 2);
  assert.equal(created.authorization.mode, "REMOTE_ONLY");
  assert.equal(created.authorization.head_sha, state.headSha);
  assert.equal(created.authorization.reviewer_provider, null);
  assert.equal("local_gate" in created, false);

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

  const gate = await finalizePublicationGate(
    state.store,
    state.reviewId,
    { expectedRevision: ready.revision },
    { clock: () => observedAt + 20 },
  );
  assert.equal(gate.version, 2);
  assert.equal(gate.authorization_mode, "REMOTE_ONLY");
  assert.equal(gate.authorization_sha256.length, 64);
  assert.equal(gate.reviewer_provider, null);
  assert.equal("local_gate_sha256" in gate, false);
  assert.equal("resolution_sha256" in gate, false);
  const verified = await verifyPublicationGate(state.store, state.reviewId, {
    clock: () => observedAt + 30,
  });
  assert.equal(verified.valid, true);
  assert.equal(verified.reviewer_provider, null);
});

test("publication rejects local gate reviewer provider drift", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const gatePath = path.join(
    state.store,
    "reviews",
    state.reviewId,
    "gate.json",
  );
  const gate = JSON.parse(await fsp.readFile(gatePath, "utf8"));
  gate.reviewer_provider = "CODEX_TASK";
  await fsp.writeFile(gatePath, `${JSON.stringify(gate, null, 2)}\n`);

  await assert.rejects(
    start(state, Date.now()),
    (error) => {
      assert.equal(error.code, "LOCAL_GATE_INVALID");
      assert.match(error.message, /reviewer provider/);
      return true;
    },
  );
});

test("publication mutations reject authorization reviewer provider drift", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const startedAt = Date.now();
  const publication = await start(state, startedAt);
  publication.authorization.reviewer_provider = "CODEX_TASK";
  const publicationPath = path.join(
    state.store,
    "reviews",
    state.reviewId,
    "publication.json",
  );
  await atomicWriteCanonicalJson(publicationPath, publication);
  const before = await fsp.readFile(publicationPath);

  await assert.rejects(
    recordCodexReviewRequest(
      state.store,
      state.reviewId,
      {
        expectedRevision: publication.revision,
        commentId: 100,
        url: "https://github.com/owner/repo/issues/7#issuecomment-100",
        createdAt: iso(startedAt + 1_000),
        requestedHeadSha: state.headSha,
      },
      { clock: () => startedAt + 1_010 },
    ),
    (error) => {
      assert.equal(error.code, "LOCAL_GATE_INVALID");
      assert.match(error.message, /authorization changed/);
      return true;
    },
  );
  assert.deepEqual(await fsp.readFile(publicationPath), before);
});

test("publication verification rejects final gate reviewer provider drift", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const { ready, observedAt } = await reachReady(state);
  const gate = await finalizePublicationGate(
    state.store,
    state.reviewId,
    { expectedRevision: ready.revision },
    { clock: () => observedAt + 20 },
  );
  gate.reviewer_provider = "CODEX_TASK";
  await atomicWriteCanonicalJson(
    path.join(
      state.store,
      "reviews",
      state.reviewId,
      "publication-gate.json",
    ),
    gate,
  );

  const verified = await verifyPublicationGate(state.store, state.reviewId, {
    clock: () => observedAt + 30,
  });
  assert.equal(verified.valid, false);
  assert.equal(verified.reason, "GATE_MISMATCH");
});

test("legacy local records default their reviewer provider to Claude", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const directory = path.join(state.store, "reviews", state.reviewId);
  for (const name of ["review.json", "gate.json"]) {
    const filePath = path.join(directory, name);
    const value = JSON.parse(await fsp.readFile(filePath, "utf8"));
    delete value.reviewer_provider;
    await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
  }

  const publication = await start(state, Date.now());
  assert.equal(
    publication.authorization.reviewer_provider,
    "CLAUDE_DESKTOP",
  );
});

test("version 2 local ledgers without reviewer provenance default to Claude", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const startedAt = Date.now();
  const publication = await start(state, startedAt);
  delete publication.authorization.reviewer_provider;
  const publicationPath = path.join(
    state.store,
    "reviews",
    state.reviewId,
    "publication.json",
  );
  await atomicWriteCanonicalJson(publicationPath, publication);

  const requested = await recordCodexReviewRequest(
    state.store,
    state.reviewId,
    {
      expectedRevision: publication.revision,
      commentId: 100,
      url: "https://github.com/owner/repo/issues/7#issuecomment-100",
      createdAt: iso(startedAt + 1_000),
      requestedHeadSha: state.headSha,
    },
    { clock: () => startedAt + 1_010 },
  );
  assert.equal(requested.revision, 2);
});

test("version 1 local ledgers remain readable and completable", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const startedAt = Date.now();
  const created = await start(state, startedAt);
  const ledgerPath = path.join(
    state.store,
    "reviews",
    state.reviewId,
    "publication.json",
  );
  const legacy = structuredClone(created);
  legacy.version = 1;
  legacy.local_gate = {
    head_sha: created.authorization.head_sha,
    base_sha: created.authorization.base_sha,
    snapshot_hash: created.authorization.snapshot_hash,
    gate_sha256: created.authorization.source_sha256,
  };
  delete legacy.authorization;
  await atomicWriteCanonicalJson(ledgerPath, legacy);
  assert.equal((await getPublication(state.store, state.reviewId)).version, 1);
  assert.deepEqual(
    (await getPublicationSummary(state.store, state.reviewId))
      .codex_review_request,
    {
      body: "@codex review",
      body_sha256: publicationConstants.request_body_sha256,
    },
  );

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
  const gate = await finalizePublicationGate(
    state.store,
    state.reviewId,
    { expectedRevision: ready.revision },
    { clock: () => observedAt + 20 },
  );
  assert.equal(gate.version, 1);
  assert.equal(gate.local_gate_sha256, legacy.local_gate.gate_sha256);
  assert.equal(gate.reviewer_provider, "CLAUDE_DESKTOP");
  assert.equal("resolution_sha256" in gate, false);
  const verified = await verifyPublicationGate(state.store, state.reviewId, {
    clock: () => observedAt + 30,
  });
  assert.equal(verified.valid, true);
  assert.equal(verified.reviewer_provider, "CLAUDE_DESKTOP");
});

test("version 1 preserves legacy baseline reason precedence", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const startedAt = Date.now();
  const unsupported = {
    resource_id: 90,
    resource_kind: "PULL_REQUEST_REVIEW",
    url: "https://github.com/owner/repo/pull/7#pullrequestreview-90",
    event_at: iso(startedAt - 1_000),
    timestamp_field: "submitted_at",
    body_sha256: digest("@codex review with guidance"),
    actor: { id: 7, type: "User" },
  };
  const started = await start(
    state,
    startedAt,
    baseline(startedAt - 100, [unsupported]),
  );
  assert.equal(
    started.codex_review_baseline.requests[0].reason,
    "NON_EXACT_TRIGGER_SHAPE",
  );
  assert.equal(
    (await getPublication(state.store, state.reviewId))
      .codex_review_baseline.requests[0].reason,
    "NON_EXACT_TRIGGER_SHAPE",
  );
});

test("remote-only authorization is explicit and binds a clean local head", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const input = {
    repositoryPath: state.repository,
    baseSha: state.baseSha,
    headSha: state.headSha,
    acknowledgement: "LOCAL_REVIEW_SKIPPED",
    operatorLabel: "maintainer",
    rationale: "Remote review is sufficient for this change.",
  };

  for (const [override, pattern] of [
    [{ acknowledgement: "YES" }, /LOCAL_REVIEW_SKIPPED/],
    [{ operatorLabel: "" }, /operator_label/],
    [{ rationale: "" }, /rationale/],
    [{ headSha: "f".repeat(40) }, /local HEAD/],
    [{ baseSha: "f".repeat(40) }, /base_sha/],
  ]) {
    await assert.rejects(
      authorizeRemotePublication(
        state.store,
        { ...input, ...override },
        { clock: () => Date.now() },
      ),
      pattern,
    );
  }

  await fsp.writeFile(path.join(state.repository, "untracked.txt"), "dirty\n");
  await assert.rejects(
    authorizeRemotePublication(state.store, input),
    /working tree must be clean/,
  );
});

test("remote-only publication rejects a new local commit and invalidates a new PR head", async (t) => {
  const startedAt = Date.now();
  const state = await remoteFixture(startedAt - 100);
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  await start(state, startedAt);

  await fsp.writeFile(path.join(state.repository, "value.js"), "export const value = 3;\n");
  git(state.repository, "add", ".");
  git(state.repository, "commit", "-m", "later change");
  const changedHead = git(state.repository, "rev-parse", "HEAD");
  await assert.rejects(
    recordCodexReviewRequest(
      state.store,
      state.reviewId,
      {
        expectedRevision: 1,
        commentId: 100,
        url: "https://github.com/owner/repo/issues/7#issuecomment-100",
        createdAt: iso(startedAt + 1_000),
        requestedHeadSha: changedHead,
      },
      { clock: () => startedAt + 1_010 },
    ),
    /local HEAD differs from the remote authorization/,
  );

  const invalidated = await recordGithubSnapshot(
    state.store,
    state.reviewId,
    {
      expectedRevision: 1,
      observation: observation({
        at: startedAt + 2_000,
        baseSha: state.baseSha,
        headSha: state.headSha,
        requestId: null,
        requestAt: startedAt,
        withResult: false,
        headOverride: changedHead,
      }),
    },
    { clock: () => startedAt + 2_010 },
  );
  assert.equal(invalidated.status, "INVALIDATED");
  assert.match(invalidated.terminal.reason, /authorization/);
});

test("remote-only publication allows the target base to advance from the reviewed merge base", async (t) => {
  const startedAt = Date.now();
  const state = await remoteFixture(startedAt - 100);
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
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
  const current = observation({
    at: observedAt,
    baseSha: state.baseSha,
    headSha: state.headSha,
    requestId: 100,
    requestAt,
  });
  const advancedBaseSha = "e".repeat(40);
  current.pull_request.base_sha = advancedBaseSha;
  current.pull_request.pr_reported_base_sha = advancedBaseSha;
  current.pull_request.base_head_comparison.base_sha = advancedBaseSha;
  current.pull_request.reviewed_base_current_base_comparison.status = "AHEAD";
  current.pull_request.reviewed_base_current_base_comparison.head_sha =
    advancedBaseSha;
  current.pull_request.collection.sources.find(
    (source) => source.kind === "BASE_BRANCH_METADATA",
  ).branch_tip_sha = advancedBaseSha;
  current.required_checks.collection.policy_sources.find(
    (source) => source.kind === "BRANCH_METADATA",
  ).branch_tip_sha = advancedBaseSha;

  const ready = await recordGithubSnapshot(
    state.store,
    state.reviewId,
    { expectedRevision: 2, observation: current },
    { clock: () => observedAt + 10 },
  );
  assert.equal(ready.status, "MERGE_READY");
});

test("tampering with a remote-only authorization fails closed", async (t) => {
  const startedAt = Date.now();
  const state = await remoteFixture(startedAt - 100);
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const { ready, observedAt } = await reachReady(state, startedAt);
  await finalizePublicationGate(
    state.store,
    state.reviewId,
    { expectedRevision: ready.revision },
    { clock: () => observedAt + 20 },
  );
  const authorizationPath = path.join(
    state.store,
    "reviews",
    state.reviewId,
    "remote-authorization.json",
  );
  const authorization = JSON.parse(await fsp.readFile(authorizationPath, "utf8"));
  authorization.rationale = "tampered";
  await atomicWriteCanonicalJson(authorizationPath, authorization);

  await assert.rejects(
    verifyPublicationGate(state.store, state.reviewId, {
      clock: () => observedAt + 30,
    }),
    (error) => error?.code === "REMOTE_AUTHORIZATION_INVALID",
  );
});

test("remote-only authorization rejects local reviewer provenance", async (t) => {
  const state = await remoteFixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const authorizationPath = path.join(
    state.store,
    "reviews",
    state.reviewId,
    "remote-authorization.json",
  );
  const authorization = JSON.parse(await fsp.readFile(authorizationPath, "utf8"));
  authorization.reviewer_provider = "CODEX_TASK";
  await atomicWriteCanonicalJson(authorizationPath, authorization);

  await assert.rejects(
    start(state, Date.now()),
    (error) => {
      assert.equal(error.code, "REMOTE_AUTHORIZATION_INVALID");
      assert.match(error.message, /reviewer provider/);
      return true;
    },
  );
});

test("conflicting local and remote authorization files fail closed", async (t) => {
  const state = await remoteFixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const directory = path.join(state.store, "reviews", state.reviewId);
  await atomicWriteCanonicalJson(path.join(directory, "gate.json"), {
    version: 1,
    review_id: state.reviewId,
    status: "LOCAL_GATE_PASSED",
    passed_at: new Date().toISOString(),
    snapshot_hash: "a".repeat(64),
    base_sha: state.baseSha,
    head_sha: state.headSha,
  });

  await assert.rejects(
    start(state, Date.now()),
    (error) => error?.code === "PUBLICATION_AUTHORIZATION_INVALID",
  );
  await assert.rejects(
    fsp.access(path.join(directory, "publication.json")),
  );
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
    normalized_reason: "GATE_MISMATCH",
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

test("complete audit events require valid fields and semantics", async (t) => {
  const invalidTails = [
    {
      name: "missing required field",
      mutate(event) {
        delete event.at;
      },
    },
    {
      name: "failed gate finalization",
      mutate(event) {
        event.event = "GATE_FINALIZATION_PASSED";
      },
    },
    {
      name: "successful verification with failure reason",
      mutate(event) {
        event.outcome = "SUCCESS";
      },
    },
  ];
  for (const { name, mutate } of invalidTails) {
    await t.test(name, async (t) => {
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
      const headPath = path.join(
        directory,
        "publication-gate-audit-head.json",
      );
      const head = JSON.parse(await fsp.readFile(headPath, "utf8"));
      const event = {
        version: 1,
        review_id: state.reviewId,
        sequence: head.next_sequence,
        event_id: "1".repeat(32),
        previous_event_sha256: head.last_event_sha256,
        event: "GATE_VERIFIED",
        outcome: "FAILURE",
        normalized_reason: "GATE_MISMATCH",
        at: iso(observedAt + 25),
        publication_revision: ready.revision,
        head_sha: state.headSha,
        github_observation_sha256: gate.github_observation_sha256,
        gate_sha256: digest(canonicalJson(gate)),
        expires_at: gate.expires_at,
      };
      mutate(event);
      await fsp.appendFile(auditPath, `${canonicalJson(event)}\n`);
      const before = {
        audit: await fsp.readFile(auditPath),
        head: await fsp.readFile(headPath),
      };

      await assert.rejects(
        verifyPublicationGate(state.store, state.reviewId, {
          clock: () => observedAt + 30,
        }),
        (error) => error?.code === "AUDIT_CORRUPT",
      );
      assert.deepEqual(await fsp.readFile(auditPath), before.audit);
      assert.deepEqual(await fsp.readFile(headPath), before.head);
    });
  }

  await t.test("committed semantic corruption", async (t) => {
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
    const headPath = path.join(
      directory,
      "publication-gate-audit-head.json",
    );
    const event = JSON.parse((await fsp.readFile(auditPath, "utf8")).trim());
    event.outcome = "FAILURE";
    event.normalized_reason = "GATE_MISMATCH";
    const line = canonicalJson(event);
    const head = JSON.parse(await fsp.readFile(headPath, "utf8"));
    head.committed_bytes = Buffer.byteLength(line) + 1;
    head.last_event_sha256 = digest(line);
    await fsp.writeFile(auditPath, `${line}\n`, { mode: 0o600 });
    await atomicWriteCanonicalJson(headPath, head);
    const before = {
      audit: await fsp.readFile(auditPath),
      head: await fsp.readFile(headPath),
    };

    for (const operation of [
      () => inspectPublicationAudit(state.store, state.reviewId),
      () =>
        verifyPublicationGate(state.store, state.reviewId, {
          clock: () => observedAt + 30,
        }),
    ]) {
      await assert.rejects(
        operation(),
        (error) => error?.code === "AUDIT_CORRUPT",
      );
    }
    assert.deepEqual(await fsp.readFile(auditPath), before.audit);
    assert.deepEqual(await fsp.readFile(headPath), before.head);
  });
});

test("audit temporary preflight fails before crash-tail recovery mutates state", async (t) => {
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
  const gatePath = path.join(directory, "publication-gate.json");
  await fsp.appendFile(auditPath, '{"incomplete":');
  const temporary = `${headPath}.${"a".repeat(32)}.tmp`;
  await fsp.symlink("untrusted-target", temporary);
  const before = {
    audit: await fsp.readFile(auditPath),
    head: await fsp.readFile(headPath),
    gate: await fsp.readFile(gatePath),
  };

  await assert.rejects(
    verifyPublicationGate(state.store, state.reviewId, {
      clock: () => observedAt + 30,
    }),
    (error) => error?.code === "AUDIT_STATE_INVALID",
  );
  assert.deepEqual(await fsp.readFile(auditPath), before.audit);
  assert.deepEqual(await fsp.readFile(headPath), before.head);
  assert.deepEqual(await fsp.readFile(gatePath), before.gate);
  assert.equal((await fsp.lstat(temporary)).isSymbolicLink(), true);
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
  const omittedObservation = observation({
    at: omittedAt,
    baseSha: first.baseSha,
    headSha: first.headSha,
    requestId: null,
    requestAt,
    withResult: false,
  });
  omittedObservation.codex_review.collection.collected_at = iso(requestAt + 50);
  omittedObservation.codex_review.collection.sources.forEach((source) => {
    source.collected_at = iso(requestAt + 50);
  });
  const omitted = await recordGithubSnapshot(
    first.store,
    first.reviewId,
    {
      expectedRevision: 2,
      observation: omittedObservation,
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
  const lateObservation = observation({
    at: lateAt,
    baseSha: second.baseSha,
    headSha: second.headSha,
    requestId: null,
    requestAt,
    withResult: false,
  });
  lateObservation.codex_review.collection.collected_at = iso(requestAt + 31_000);
  lateObservation.codex_review.collection.sources.forEach((source) => {
    source.collected_at = iso(requestAt + 31_000);
  });
  const invalidated = await recordGithubSnapshot(
    second.store,
    second.reviewId,
    {
      expectedRevision: 2,
      observation: lateObservation,
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

test("adapter baseline round-trips through the server without actor-login drift", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const startedAt = Date.now();
  const collectedAt = iso(startedAt - 100);
  const raw = {
    mode: "BASELINE",
    collection: {
      status: "COMPLETE",
      collected_at: collectedAt,
      sources: [
        completeSource("ISSUE_COMMENTS", collectedAt, {
          pagination_complete: true,
          page_count: 1,
        }),
        completeSource("PULL_REQUEST_REVIEWS", collectedAt, {
          pagination_complete: true,
          page_count: 1,
        }),
        completeSource("PULL_REQUEST_REVIEW_COMMENTS", collectedAt, {
          pagination_complete: true,
          page_count: 1,
        }),
      ],
    },
    expected_actor: { id: 99, type: "Bot" },
    local_gate_head_sha: state.headSha,
    issue_comments: [
      {
        id: 77,
        html_url: "https://github.com/owner/repo/issues/7#issuecomment-77",
        created_at: iso(startedAt - 1_000),
        body: "@codex review",
        user: { id: 42, type: "User", login: "maintainer" },
      },
      {
        id: 78,
        html_url: "https://github.com/owner/repo/issues/7#issuecomment-78",
        created_at: iso(startedAt - 900),
        body: `Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** \`${state.headSha.slice(0, 10)}\``,
        user: { id: 99, type: "Bot", login: "codex[bot]" },
      },
    ],
    pull_request_reviews: [],
    pull_request_review_comments: [],
  };
  const adaptedBaseline = adaptCodexEvidence(raw);
  await start(state, startedAt, adaptedBaseline);
  const observedAt = startedAt + 1_000;
  const snapshotCollectedAt = iso(observedAt - 100);
  const snapshotCodex = adaptCodexEvidence({
    ...raw,
    mode: "SNAPSHOT",
    collection: {
      ...raw.collection,
      collected_at: snapshotCollectedAt,
      sources: raw.collection.sources.map((source) => ({
        ...source,
        collected_at: snapshotCollectedAt,
      })),
    },
    baseline: adaptedBaseline,
    request_history: [],
    ambiguity_acknowledgements: [],
  });
  const current = observation({
    at: observedAt,
    baseSha: state.baseSha,
    headSha: state.headSha,
    requestId: null,
    requestAt: observedAt,
    withResult: false,
  });
  current.codex_review = snapshotCodex;
  const ledger = await recordGithubSnapshot(
    state.store,
    state.reviewId,
    { expectedRevision: 1, observation: current },
    { clock: () => observedAt + 10 },
  );
  assert.equal(ledger.status, "GITHUB_REVIEW_UNKNOWN");
  assert.equal(ledger.terminal, null);
  assert.deepEqual(snapshotCodex.preexisting_requests[0].actor, {
    id: 42,
    type: "User",
  });
  assert.deepEqual(snapshotCodex.preexisting_candidate_results[0].actor, {
    id: 99,
    type: "Bot",
  });
});

test("a baseline actor the snapshot projection cannot reproduce is refused at start", async (t) => {
  // The snapshot side pins baseline actors to exactly {id, type}, so a stored
  // actor carrying a login can never satisfy the identity comparison: the
  // ledger is doomed at start and dies at the first snapshot, terminally. The
  // key sets are shared with the snapshot side, so the refusal names the field.
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const startedAt = Date.now();
  const collectedAt = iso(startedAt - 100);
  const adapted = adaptCodexEvidence({
    mode: "BASELINE",
    collection: {
      status: "COMPLETE",
      collected_at: collectedAt,
      sources: [
        "ISSUE_COMMENTS",
        "PULL_REQUEST_REVIEWS",
        "PULL_REQUEST_REVIEW_COMMENTS",
      ].map((kind) =>
        completeSource(kind, collectedAt, {
          pagination_complete: true,
          page_count: 1,
        }),
      ),
    },
    expected_actor: { id: 99, type: "Bot" },
    local_gate_head_sha: state.headSha,
    issue_comments: [
      {
        id: 77,
        html_url: "https://github.com/owner/repo/issues/7#issuecomment-77",
        created_at: iso(startedAt - 1_000),
        body: "@codex review",
        user: { id: 42, type: "User", login: "maintainer" },
      },
      {
        id: 78,
        html_url: "https://github.com/owner/repo/issues/7#issuecomment-78",
        created_at: iso(startedAt - 900),
        body: `Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** \`${state.headSha.slice(0, 10)}\``,
        user: { id: 99, type: "Bot", login: "codex[bot]" },
      },
    ],
    pull_request_reviews: [],
    pull_request_review_comments: [],
  });
  const requestLogin = structuredClone(adapted);
  requestLogin.requests[0].actor.login = "maintainer";
  await assert.rejects(
    start(state, startedAt, requestLogin),
    /baseline\.requests\[0\]\.actor contains unexpected field login/,
  );
  const resultLogin = structuredClone(adapted);
  resultLogin.candidate_results[0].actor.login = "codex[bot]";
  await assert.rejects(
    start(state, startedAt, resultLogin),
    /baseline\.candidate_results\[0\]\.actor contains unexpected field login/,
  );
  // The adapter's own output still starts: the accepted key sets are the
  // projection's, not a narrower list of them.
  const ledger = await start(state, startedAt, adapted);
  assert.equal(ledger.revision, 1);
});

test("a baseline result outside its resource kind's projected shape is refused at start", async (t) => {
  // The same defect one level down and in the other direction: the projection
  // always writes `reviewed_head_sha`, `commit_binding` and
  // `attached_review_comments`, and pins attachment actors to {id, type}, so a
  // stored result that omits one or carries a raw GitHub field inside an
  // attachment diverges canonically at the first snapshot exactly as an extra
  // top-level key does.
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const startedAt = Date.now();
  const collectedAt = iso(startedAt - 100);
  const adapted = adaptCodexEvidence({
    mode: "BASELINE",
    collection: {
      status: "COMPLETE",
      collected_at: collectedAt,
      sources: [
        "ISSUE_COMMENTS",
        "PULL_REQUEST_REVIEWS",
        "PULL_REQUEST_REVIEW_COMMENTS",
      ].map((kind) =>
        completeSource(kind, collectedAt, {
          pagination_complete: true,
          page_count: 1,
        }),
      ),
    },
    expected_actor: { id: 99, type: "Bot" },
    local_gate_head_sha: state.headSha,
    issue_comments: [
      {
        id: 800,
        html_url: "https://github.com/owner/repo/issues/7#issuecomment-800",
        created_at: iso(startedAt - 910),
        body: `Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** \`${state.headSha.slice(0, 10)}\``,
        user: { id: 99, type: "Bot", login: "codex[bot]" },
      },
    ],
    pull_request_reviews: [
      {
        id: 900,
        html_url:
          "https://github.com/owner/repo/pull/7#pullrequestreview-900",
        submitted_at: iso(startedAt - 900),
        commit_id: state.headSha,
        state: "COMMENTED",
        body: "### 💡 Codex Review\n\nHere are some automated review suggestions.",
        user: { id: 99, type: "Bot", login: "codex[bot]" },
      },
    ],
    pull_request_review_comments: [
      {
        id: 901,
        pull_request_review_id: 900,
        html_url: "https://github.com/owner/repo/pull/7#discussion_r901",
        created_at: iso(startedAt - 890),
        commit_id: state.headSha,
        body: "One finding.",
        user: { id: 99, type: "Bot", login: "codex[bot]" },
      },
      {
        id: 902,
        pull_request_review_id: 800,
        html_url: "https://github.com/owner/repo/pull/7#discussion_r902",
        created_at: iso(startedAt - 880),
        commit_id: state.headSha,
        body: "A standalone comment.",
        user: { id: 99, type: "Bot", login: "codex[bot]" },
      },
      {
        id: 903,
        pull_request_review_id: 900,
        html_url: "https://github.com/owner/repo/pull/7#discussion_r903",
        created_at: iso(startedAt - 870),
        commit_id: state.headSha,
        body: "A second finding.",
        user: { id: 99, type: "Bot", login: "codex[bot]" },
      },
    ],
  });
  // One candidate result per resource kind, so every row of the projected
  // shape table is exercised — and asserted here, because a mutation below
  // proves nothing about a field the adapter left empty on its own.
  const [comment, review, replyComment] = adapted.candidate_results;
  assert.deepEqual(
    adapted.candidate_results.map((result) => result.resource_kind),
    ["ISSUE_COMMENT", "PULL_REQUEST_REVIEW", "PULL_REQUEST_REVIEW_COMMENT"],
  );
  assert.equal(comment.reviewed_head_sha, null);
  assert.notEqual(comment.commit_binding, null);
  assert.deepEqual(comment.attached_review_comments, []);
  assert.equal(review.reviewed_head_sha, state.headSha);
  assert.equal(review.attached_review_comments.length, 2);
  assert.equal(replyComment.commit_binding, null);
  assert.deepEqual(replyComment.attached_review_comments, []);

  async function refuses(mutate, pattern) {
    const mutated = structuredClone(adapted);
    mutate(...mutated.candidate_results);
    await assert.rejects(start(state, startedAt, mutated), pattern);
  }

  for (const field of [
    "reviewed_head_sha",
    "commit_binding",
    "attached_review_comments",
  ]) {
    await refuses(
      (_c, r) => delete r[field],
      new RegExp(`baseline\\.candidate_results\\[1\\] is missing field ${field}`),
    );
  }
  await refuses(
    (_c, r) => {
      r.attached_review_comments[0].actor.login = "codex[bot]";
    },
    /attached_review_comments\[0\]\.actor contains unexpected field login/,
  );
  await refuses(
    (_c, r) => {
      r.commit_binding.prefix = state.headSha.slice(0, 10);
    },
    /commit_binding contains unexpected field prefix/,
  );
  // A binding's provenance is written from constants and its prefix is the
  // substring a fixed pattern matched, so neither is the caller's to choose.
  await refuses(
    (c) => {
      c.commit_binding.source = "PULL_REQUEST_REVIEW_COMMIT_ID";
    },
    /commit_binding\.source must be CODEX_REVIEWED_COMMIT_PREFIX_AND_REQUEST_HEAD/,
  );
  await refuses(
    (_c, r) => {
      r.commit_binding.field = "body.reviewed_commit";
    },
    /commit_binding\.field must be commit_id/,
  );
  // One guard writes a review's reviewed head and its binding together, and
  // the projection filters attachments to the expected actor before rebuilding
  // each one's identity from it.
  await refuses(
    (_c, r) => {
      r.reviewed_head_sha = null;
    },
    /baseline\.candidate_results\[1\] must carry a reviewed head and a commit binding together/,
  );
  await refuses(
    (_c, r) => {
      r.commit_binding = null;
    },
    /baseline\.candidate_results\[1\] must carry a reviewed head and a commit binding together/,
  );
  await refuses(
    (_c, r) => {
      r.attached_review_comments[0].actor = { id: 42, type: "User" };
    },
    /attached_review_comments\[0\]\.actor does not match the pinned Codex actor/,
  );
  for (const prefix of ["not-hexadecimal", state.headSha.slice(0, 4), 1]) {
    await refuses(
      (c) => {
        c.commit_binding.prefix = prefix;
      },
      /commit_binding\.prefix is not a commit prefix/,
    );
  }
  // Present but not an array, and present but not an object: the walk must
  // refuse these as input rather than crash on them.
  await refuses(
    (_c, r) => {
      r.attached_review_comments = null;
    },
    /baseline\.candidate_results\[1\]\.attached_review_comments must be an array/,
  );
  await refuses(
    (_c, r) => {
      r.attached_review_comments = [null];
    },
    /baseline\.candidate_results\[1\] attachment must be an object/,
  );
  // The canonical comparison reads an array in order, so the projection's own
  // sort is part of the shape.
  await refuses(
    (_c, r) => r.attached_review_comments.reverse(),
    /attached_review_comments\[1\] is out of comment_id order/,
  );
  // A field a kind does not carry reproduces null or [] and nothing else — an
  // empty object, or a well-formed value borrowed from the kind that does
  // carry it, included.
  await refuses(
    (_c, _r, reply) => {
      reply.commit_binding = {};
    },
    /baseline\.candidate_results\[2\]\.commit_binding must be null for PULL_REQUEST_REVIEW_COMMENT/,
  );
  await refuses(
    (_c, review_, reply) => {
      reply.attached_review_comments = structuredClone(
        review_.attached_review_comments,
      );
    },
    /baseline\.candidate_results\[2\]\.attached_review_comments must be empty for PULL_REQUEST_REVIEW_COMMENT/,
  );
  await refuses(
    (c) => {
      c.attached_review_comments = [
        {
          comment_id: 901,
          actor: { id: 99, type: "Bot" },
          commit_id: state.headSha,
          body_sha256: digest("One finding."),
        },
      ];
    },
    /baseline\.candidate_results\[0\]\.attached_review_comments must be empty for ISSUE_COMMENT/,
  );
  for (const [position, kind] of [
    [0, "ISSUE_COMMENT"],
    [2, "PULL_REQUEST_REVIEW_COMMENT"],
  ]) {
    await refuses(
      (...results) => {
        results[position].reviewed_head_sha = state.headSha;
      },
      new RegExp(
        `baseline\\.candidate_results\\[${position}\\].reviewed_head_sha must be null for ${kind}`,
      ),
    );
  }
  const ledger = await start(state, startedAt, adapted);
  assert.equal(ledger.revision, 1);
});

test("an App notice edited after the baseline leaves the ledger alive", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const startedAt = Date.now();
  const collectedAt = iso(startedAt - 100);
  const sources = [
    "ISSUE_COMMENTS",
    "PULL_REQUEST_REVIEWS",
    "PULL_REQUEST_REVIEW_COMMENTS",
  ].map((kind) =>
    completeSource(kind, collectedAt, {
      pagination_complete: true,
      page_count: 1,
    }),
  );
  const raw = {
    mode: "BASELINE",
    collection: { status: "COMPLETE", collected_at: collectedAt, sources },
    expected_actor: { id: 99, type: "Bot" },
    local_gate_head_sha: state.headSha,
    issue_comments: [
      {
        id: 79,
        html_url: "https://github.com/owner/repo/issues/7#issuecomment-79",
        created_at: iso(startedAt - 900),
        body: APP_SUMMARY_BODY,
        user: { id: 99, type: "Bot", login: "chatgpt-codex-connector[bot]" },
      },
    ],
    pull_request_reviews: [],
    pull_request_review_comments: [],
  };
  const adaptedBaseline = adaptCodexEvidence(raw);
  await start(state, startedAt, adaptedBaseline);

  // The App rewrites its summary comment in place on its next review round.
  const observedAt = startedAt + 1_000;
  const snapshotCollectedAt = iso(observedAt - 100);
  const edited = structuredClone(raw);
  edited.issue_comments[0].body = `${APP_SUMMARY_BODY}\n\n| Code Review | Completed |`;
  const snapshotCodex = adaptCodexEvidence({
    ...edited,
    mode: "SNAPSHOT",
    collection: {
      ...raw.collection,
      collected_at: snapshotCollectedAt,
      sources: sources.map((source) => ({
        ...source,
        collected_at: snapshotCollectedAt,
      })),
    },
    baseline: adaptedBaseline,
    request_history: [],
    ambiguity_acknowledgements: [],
  });
  const current = observation({
    at: observedAt,
    baseSha: state.baseSha,
    headSha: state.headSha,
    requestId: null,
    requestAt: observedAt,
    withResult: false,
  });
  current.codex_review = snapshotCodex;
  const ledger = await recordGithubSnapshot(
    state.store,
    state.reviewId,
    { expectedRevision: 1, observation: current },
    { clock: () => observedAt + 10 },
  );
  assert.equal(ledger.terminal, null);
  assert.equal(ledger.status, "GITHUB_REVIEW_NOT_REQUESTED");
  assert.deepEqual(
    ledger.latest_observation.codex_review.app_notices.map(
      (notice) => notice.resource_id,
    ),
    [79],
  );
});

test("server replay rejects a caller-forged pre-request result association", async (t) => {
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
  const current = observation({
    at: startedAt + 2_000,
    baseSha: state.baseSha,
    headSha: state.headSha,
    requestId: 100,
    requestAt,
  });
  current.codex_review.results[0].event_at = iso(requestAt - 1);
  const ledger = await recordGithubSnapshot(
    state.store,
    state.reviewId,
    { expectedRevision: 2, observation: current },
    { clock: () => startedAt + 2_010 },
  );
  assert.equal(ledger.status, "GITHUB_REVIEW_UNKNOWN");
});

test("a correctly classified unsolicited result does not poison a later clean request", async (t) => {
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
  const current = observation({
    at: startedAt + 2_000,
    baseSha: state.baseSha,
    headSha: state.headSha,
    requestId: 100,
    requestAt,
  });
  current.codex_review.results.unshift({
    ...structuredClone(current.codex_review.results[0]),
    result_id: 90,
    event_at: iso(requestAt - 100),
    request_ref: null,
    association: "UNSOLICITED",
    reviewed_head_sha: null,
    commit_binding: null,
    format: "UNKNOWN",
    verdict: "UNKNOWN",
    body_sha256: digest("unsolicited"),
  });
  const ledger = await recordGithubSnapshot(
    state.store,
    state.reviewId,
    { expectedRevision: 2, observation: current },
    { clock: () => startedAt + 2_010 },
  );
  assert.equal(ledger.status, "MERGE_READY");
});

test("request visibility grace uses collection time rather than submission time", async (t) => {
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
  const collectedAt = requestAt + 20_000;
  const current = observation({
    at: collectedAt + 500,
    baseSha: state.baseSha,
    headSha: state.headSha,
    requestId: null,
    requestAt,
    withResult: false,
  });
  current.codex_review.collection.collected_at = iso(collectedAt);
  current.codex_review.collection.sources.forEach((source) => {
    source.collected_at = iso(collectedAt);
  });
  const ledger = await recordGithubSnapshot(
    state.store,
    state.reviewId,
    { expectedRevision: 2, observation: current },
    { clock: () => requestAt + 40_000 },
  );
  assert.equal(ledger.status, "EVIDENCE_INCOMPLETE");
  assert.equal(ledger.terminal, null);

  const between = await fixture();
  t.after(() => fsp.rm(between.root, { recursive: true, force: true }));
  await start(between, startedAt);
  await recordCodexReviewRequest(
    between.store,
    between.reviewId,
    {
      expectedRevision: 1,
      commentId: 100,
      url: "https://github.com/owner/repo/issues/7#issuecomment-100",
      createdAt: iso(requestAt),
      requestedHeadSha: between.headSha,
    },
    { clock: () => requestAt + 10 },
  );
  const collectedBetweenPostAndBinding = requestAt + 5;
  const beforeBinding = observation({
    at: requestAt + 500,
    baseSha: between.baseSha,
    headSha: between.headSha,
    requestId: null,
    requestAt,
    withResult: false,
  });
  beforeBinding.codex_review.collection.collected_at = iso(
    collectedBetweenPostAndBinding,
  );
  beforeBinding.codex_review.collection.sources.forEach((source) => {
    source.collected_at = iso(collectedBetweenPostAndBinding);
  });
  const accepted = await recordGithubSnapshot(
    between.store,
    between.reviewId,
    { expectedRevision: 2, observation: beforeBinding },
    { clock: () => requestAt + 510 },
  );
  assert.equal(accepted.status, "EVIDENCE_INCOMPLETE");
  assert.equal(accepted.terminal, null);
});

test("future check values are recorded and derive incomplete evidence", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const { ready } = await reachReady(state);
  for (const [field, value] of [
    ["status", "FUTURE_STATUS"],
    ["conclusion", "FUTURE_CONCLUSION"],
  ]) {
    const ledger = structuredClone(ready);
    ledger.latest_observation.required_checks.policy = "REQUIRED";
    ledger.latest_observation.required_checks.requirements = [
      {
        context: "ci",
        app_binding: "EXPLICITLY_UNBOUND",
        required_app_id: null,
        binding_sources: [
          {
            kind: "APPLICABLE_RULES",
            field: "required_status_checks",
            raw_representation: "ABSENT",
          },
        ],
      },
    ];
    ledger.latest_observation.required_checks.runs = [
      {
        run_id: 1,
        run_kind: "COMMIT_STATUS",
        context: "ci",
        head_sha: state.headSha,
        started_at: ledger.latest_observation.observed_at,
        status: "COMPLETED",
        completed_at: ledger.latest_observation.observed_at,
        conclusion: "SUCCESS",
        app_id: null,
        app_id_source: "COMMIT_STATUS_UNAVAILABLE",
        [field]: value,
      },
    ];
    assert.equal(
      derivePublicationStatus(ledger).status,
      "EVIDENCE_INCOMPLETE",
    );
  }
});

test("audit preflight and offline inspection fail closed without changing gate validity", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const startedAt = Date.now();
  await start(state, startedAt);
  const directory = path.join(state.store, "reviews", state.reviewId);
  const auditPath = path.join(directory, "publication-gate-audit.jsonl");
  await fsp.chmod(auditPath, 0o644);
  await assert.rejects(
    finalizePublicationGate(
      state.store,
      state.reviewId,
      { expectedRevision: 1 },
      { clock: () => startedAt + 10 },
    ),
    (error) => error instanceof StoreError && error.code === "STORE_MODE_MISMATCH",
  );
  await fsp.chmod(auditPath, 0o600);

  const second = await fixture();
  t.after(() => fsp.rm(second.root, { recursive: true, force: true }));
  const reached = await reachReady(second, startedAt);
  await finalizePublicationGate(
    second.store,
    second.reviewId,
    { expectedRevision: reached.ready.revision },
    { clock: () => reached.observedAt + 20 },
  );
  await verifyPublicationGate(second.store, second.reviewId, {
    clock: () => reached.observedAt + 30,
  });
  const secondDirectory = path.join(second.store, "reviews", second.reviewId);
  const secondAudit = path.join(
    secondDirectory,
    "publication-gate-audit.jsonl",
  );
  const original = await fsp.readFile(secondAudit, "utf8");
  const lines = original.trimEnd().split("\n");
  const firstEvent = JSON.parse(lines[0]);
  firstEvent.event_id =
    `${firstEvent.event_id[0] === "0" ? "1" : "0"}${firstEvent.event_id.slice(1)}`;
  lines[0] = canonicalJson(firstEvent);
  await fsp.writeFile(secondAudit, `${lines.join("\n")}\n`, { mode: 0o600 });
  await assert.rejects(
    inspectPublicationAudit(second.store, second.reviewId),
    /AUDIT_CORRUPT/,
  );
  const stillValid = await verifyPublicationGate(
    second.store,
    second.reviewId,
    { clock: () => reached.observedAt + 40 },
  );
  assert.equal(stillValid.valid, true);
});

test("offline audit inspection does not read an unbounded audit file into memory", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const startedAt = Date.now();
  const reached = await reachReady(state, startedAt);
  const gate = await finalizePublicationGate(
    state.store,
    state.reviewId,
    { expectedRevision: reached.ready.revision },
    { clock: () => reached.observedAt + 20 },
  );
  const directory = path.join(state.store, "reviews", state.reviewId);
  const auditPath = path.join(directory, "publication-gate-audit.jsonl");
  const auditHeadPath = path.join(
    directory,
    "publication-gate-audit-head.json",
  );
  const lines = [];
  let previous = null;
  for (let sequence = 1; sequence <= 400; sequence += 1) {
    const line = canonicalJson({
      version: 1,
      review_id: state.reviewId,
      sequence,
      event_id: sequence.toString(16).padStart(32, "0"),
      previous_event_sha256: previous,
      event: "GATE_VERIFIED",
      outcome: "SUCCESS",
      normalized_reason: null,
      at: iso(reached.observedAt + 30),
      publication_revision: reached.ready.revision,
      head_sha: state.headSha,
      github_observation_sha256: gate.github_observation_sha256,
      gate_sha256: digest(canonicalJson(gate)),
      expires_at: gate.expires_at,
    });
    lines.push(line);
    previous = digest(line);
  }
  const committed = `${lines.join("\n")}\n`;
  await fsp.writeFile(auditPath, committed, { mode: 0o600 });
  const committedBytes = Buffer.byteLength(committed);
  await atomicWriteCanonicalJson(auditHeadPath, {
    version: 1,
    review_id: state.reviewId,
    committed_bytes: committedBytes,
    next_sequence: lines.length + 1,
    last_event_sha256: previous,
  });
  const sparseSize = 3 * 1024 * 1024 * 1024;
  await fsp.truncate(auditPath, sparseSize);

  const probe = await fsp.open(auditPath, "r");
  const fileHandlePrototype = Object.getPrototypeOf(probe);
  await probe.close();
  const originalRead = fileHandlePrototype.read;
  fileHandlePrototype.read = function shortRead(
    buffer,
    offset,
    length,
    position,
  ) {
    return originalRead.call(
      this,
      buffer,
      offset,
      Math.min(length, 4096),
      position,
    );
  };
  let inspected;
  try {
    inspected = await inspectPublicationAudit(state.store, state.reviewId);
  } finally {
    fileHandlePrototype.read = originalRead;
  }
  assert.equal(inspected.valid, true);
  assert.equal(inspected.event_count, lines.length);
  assert.equal(inspected.committed_bytes, committedBytes);
  assert.equal(
    inspected.uncommitted_tail_bytes,
    sparseSize - committedBytes,
  );
});

test("parseable non-object store JSON reports structured corruption errors", async (t) => {
  await t.test("local gate", async (t) => {
    const state = await fixture();
    t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
    await fsp.writeFile(
      path.join(state.store, "reviews", state.reviewId, "gate.json"),
      "null\n",
      { mode: 0o600 },
    );
    await assert.rejects(
      start(state, Date.now()),
      (error) => error?.code === "LOCAL_GATE_INVALID",
    );
  });

  await t.test("publication ledger", async (t) => {
    const state = await fixture();
    t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
    await start(state, Date.now());
    await atomicWriteCanonicalJson(
      path.join(state.store, "reviews", state.reviewId, "publication.json"),
      null,
    );
    await assert.rejects(
      getPublication(state.store, state.reviewId),
      (error) => error?.code === "PUBLICATION_STORE_INVALID",
    );
  });

  await t.test("audit head", async (t) => {
    const state = await fixture();
    t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
    await start(state, Date.now());
    await atomicWriteCanonicalJson(
      path.join(
        state.store,
        "reviews",
        state.reviewId,
        "publication-gate-audit-head.json",
      ),
      null,
    );
    await assert.rejects(
      inspectPublicationAudit(state.store, state.reviewId),
      (error) => error?.code === "AUDIT_CORRUPT",
    );
  });

  await t.test("audit event", async (t) => {
    const state = await fixture();
    t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
    await start(state, Date.now());
    const directory = path.join(state.store, "reviews", state.reviewId);
    await fsp.writeFile(
      path.join(directory, "publication-gate-audit.jsonl"),
      "null\n",
      { mode: 0o600 },
    );
    await atomicWriteCanonicalJson(
      path.join(directory, "publication-gate-audit-head.json"),
      {
        version: 1,
        review_id: state.reviewId,
        committed_bytes: 5,
        next_sequence: 2,
        last_event_sha256: digest("null"),
      },
    );
    await assert.rejects(
      inspectPublicationAudit(state.store, state.reviewId),
      (error) => error?.code === "AUDIT_CORRUPT",
    );
  });
});

test("persisted lone surrogates report structured corruption errors", async (t) => {
  await t.test("publication ledger", async (t) => {
    const state = await fixture();
    t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
    await start(state, Date.now());
    const publicationPath = path.join(
      state.store,
      "reviews",
      state.reviewId,
      "publication.json",
    );
    const ledger = JSON.parse(await fsp.readFile(publicationPath, "utf8"));
    await fsp.writeFile(
      publicationPath,
      `${JSON.stringify({ ...ledger, malformed: "\ud800" })}\n`,
      { mode: 0o600 },
    );

    for (const operation of [
      () => getPublication(state.store, state.reviewId),
      () => verifyPublicationGate(state.store, state.reviewId),
    ]) {
      await assert.rejects(
        operation(),
        (error) => error?.code === "PUBLICATION_STORE_INVALID",
      );
    }
  });

  await t.test("audit head", async (t) => {
    const state = await fixture();
    t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
    const { ready, observedAt } = await reachReady(state);
    await finalizePublicationGate(
      state.store,
      state.reviewId,
      { expectedRevision: ready.revision },
      { clock: () => observedAt + 20 },
    );
    const headPath = path.join(
      state.store,
      "reviews",
      state.reviewId,
      "publication-gate-audit-head.json",
    );
    const head = JSON.parse(await fsp.readFile(headPath, "utf8"));
    await fsp.writeFile(
      headPath,
      `${JSON.stringify({ ...head, malformed: "\ud800" })}\n`,
      { mode: 0o600 },
    );

    for (const operation of [
      () => inspectPublicationAudit(state.store, state.reviewId),
      () =>
        verifyPublicationGate(state.store, state.reviewId, {
          clock: () => observedAt + 30,
        }),
    ]) {
      await assert.rejects(
        operation(),
        (error) => error?.code === "AUDIT_CORRUPT",
      );
    }
  });

  await t.test("committed audit event", async (t) => {
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
    const headPath = path.join(
      directory,
      "publication-gate-audit-head.json",
    );
    const event = JSON.parse((await fsp.readFile(auditPath, "utf8")).trim());
    const malformedLine = JSON.stringify({ ...event, malformed: "\ud800" });
    const head = JSON.parse(await fsp.readFile(headPath, "utf8"));
    head.committed_bytes = Buffer.byteLength(malformedLine) + 1;
    head.last_event_sha256 = digest(malformedLine);
    await fsp.writeFile(auditPath, `${malformedLine}\n`, { mode: 0o600 });
    await atomicWriteCanonicalJson(headPath, head);

    for (const operation of [
      () => inspectPublicationAudit(state.store, state.reviewId),
      () =>
        verifyPublicationGate(state.store, state.reviewId, {
          clock: () => observedAt + 30,
        }),
    ]) {
      await assert.rejects(
        operation(),
        (error) => error?.code === "AUDIT_CORRUPT",
      );
    }
  });
});

test("pre-start audit and stored-history invariants report their contract errors", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const directory = path.join(state.store, "reviews", state.reviewId);
  await fsp.writeFile(
    path.join(directory, "publication-gate-audit.jsonl"),
    "{}\n",
    { mode: 0o600 },
  );
  await assert.rejects(
    start(state, Date.now()),
    /AUDIT_STATE_INVALID/,
  );

  const second = await fixture();
  t.after(() => fsp.rm(second.root, { recursive: true, force: true }));
  const ledger = await start(second, Date.now());
  ledger.history[0].cleared_observation_sha256 = "0".repeat(64);
  await atomicWriteCanonicalJson(
    path.join(second.store, "reviews", second.reviewId, "publication.json"),
    ledger,
  );
  await assert.rejects(
    getPublication(second.store, second.reviewId),
    /only request or thread-mutation history/,
  );
});

test("verification audits the canonical digest of parseable non-canonical gate JSON", async (t) => {
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
  await fsp.writeFile(
    path.join(directory, "publication-gate.json"),
    `${JSON.stringify(gate, null, 2)}\n`,
    { mode: 0o600 },
  );
  const result = await verifyPublicationGate(state.store, state.reviewId, {
    clock: () => observedAt + 30,
  });
  assert.equal(result.valid, false);
  const events = (await fsp.readFile(
    path.join(directory, "publication-gate-audit.jsonl"),
    "utf8",
  )).trim().split("\n").map(JSON.parse);
  assert.equal(events.at(-1).gate_sha256, digest(canonicalJson(gate)));
});

test("verification audits parseable gates that cannot be canonicalized", async (t) => {
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
  await fsp.writeFile(
    path.join(directory, "publication-gate.json"),
    `${JSON.stringify({ ...gate, malformed: "\ud800" })}\n`,
    { mode: 0o600 },
  );

  const result = await verifyPublicationGate(state.store, state.reviewId, {
    clock: () => observedAt + 30,
  });

  assert.equal(result.valid, false);
  assert.equal(result.reason, "GATE_MISSING_OR_MALFORMED");
  const events = (await fsp.readFile(
    path.join(directory, "publication-gate-audit.jsonl"),
    "utf8",
  )).trim().split("\n").map(JSON.parse);
  assert.equal(events.at(-1).event, "GATE_VERIFIED");
  assert.equal(events.at(-1).outcome, "FAILURE");
  assert.equal(
    events.at(-1).normalized_reason,
    "GATE_MISSING_OR_MALFORMED",
  );
  assert.equal(events.at(-1).gate_sha256, null);
});

test("strict policy retains false source provenance", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const startedAt = Date.now();
  await start(state, startedAt);
  const observedAt = startedAt + 1_000;
  const value = observation({
    at: observedAt,
    baseSha: state.baseSha,
    headSha: state.headSha,
    requestId: null,
    requestAt: startedAt,
    withResult: false,
  });
  value.required_checks.collection.policy_sources.push({
    kind: "CLASSIC_BRANCH_PROTECTION",
    endpoint: "GET /fixture/classic",
    collected_at:
      value.required_checks.collection.policy_sources[0].collected_at,
    status: "COMPLETE",
    result: "SUCCESS",
  });
  value.required_checks.strict_policy.sources = [
    {
      kind: "CLASSIC_BRANCH_PROTECTION",
      field: "required_status_checks.strict",
      value: false,
    },
  ];

  const recorded = await recordGithubSnapshot(
    state.store,
    state.reviewId,
    { expectedRevision: 1, observation: value },
    { clock: () => observedAt + 10 },
  );
  assert.deepEqual(
    recorded.latest_observation.required_checks.strict_policy,
    value.required_checks.strict_policy,
  );
});

test("required-check evaluation covers binding, reruns, and independent run kinds", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const { ready } = await reachReady(state);
  const checked = (requirements, runs) => {
    const ledger = structuredClone(ready);
    ledger.latest_observation.required_checks.policy = "REQUIRED";
    ledger.latest_observation.required_checks.requirements = requirements;
    ledger.latest_observation.required_checks.runs = runs;
    return derivePublicationStatus(ledger).status;
  };
  const source = {
    kind: "APPLICABLE_RULES",
    field: "required_status_checks",
    raw_representation: "POSITIVE_INTEGER",
  };
  const pinned = {
    context: "ci",
    app_binding: "PINNED",
    required_app_id: 7,
    binding_sources: [source],
  };
  const unbound = {
    context: "ci",
    app_binding: "EXPLICITLY_UNBOUND",
    required_app_id: null,
    binding_sources: [{ ...source, raw_representation: "NULL" }],
  };
  const run = (overrides) => ({
    run_id: 1,
    run_kind: "CHECK_RUN",
    context: "ci",
    head_sha: state.headSha,
    started_at: ready.latest_observation.observed_at,
    status: "COMPLETED",
    completed_at: ready.latest_observation.observed_at,
    conclusion: "SUCCESS",
    app_id: 7,
    app_id_source: "CHECK_RUN_APP_ID",
    ...overrides,
  });
  const status = (overrides = {}) =>
    run({
      run_kind: "COMMIT_STATUS",
      app_id: null,
      app_id_source: "COMMIT_STATUS_UNAVAILABLE",
      ...overrides,
    });

  assert.equal(checked([pinned], [status()]), "CHECKS_PENDING");
  assert.equal(checked([pinned], [run({}), status()]), "MERGE_READY");
  assert.equal(
    checked([pinned], [run({}), status({ conclusion: "FAILURE" })]),
    "CHECKS_FAILED",
  );
  assert.equal(checked([unbound], [status()]), "MERGE_READY");
  assert.equal(
    checked(
      [pinned],
      [
        run({ run_id: 1 }),
        run({
          run_id: 2,
          started_at: iso(
            Date.parse(ready.latest_observation.observed_at) + 1,
          ),
          status: "IN_PROGRESS",
          completed_at: null,
          conclusion: null,
        }),
      ],
    ),
    "CHECKS_PENDING",
  );
  assert.equal(
    checked(
      [pinned],
      [
        run({ run_id: 1, conclusion: "FAILURE" }),
        run({
          run_id: 2,
          started_at: iso(
            Date.parse(ready.latest_observation.observed_at) + 1,
          ),
        }),
      ],
    ),
    "MERGE_READY",
  );
  assert.equal(
    checked([pinned], [run({ conclusion: "FUTURE_VALUE" })]),
    "EVIDENCE_INCOMPLETE",
  );
});

test("caller-controlled evidence limits are rejected without advancing state", async (t) => {
  const first = await fixture();
  t.after(() => fsp.rm(first.root, { recursive: true, force: true }));
  const oversizedBaseline = baseline(Date.now() - 100);
  oversizedBaseline.padding = "x".repeat(
    publicationConstants.max_baseline_bytes,
  );
  await assert.rejects(
    start(first, Date.now(), oversizedBaseline),
    /baseline exceeds 2 MiB/,
  );
  const tooManyBaselineEntries = baseline(Date.now() - 100);
  tooManyBaselineEntries.requests = Array.from({ length: 5_001 }, () => ({}));
  await assert.rejects(
    start(first, Date.now(), tooManyBaselineEntries),
    /baseline exceeds 5,000 evidence entries/,
  );

  const second = await fixture();
  t.after(() => fsp.rm(second.root, { recursive: true, force: true }));
  const startedAt = Date.now();
  await start(second, startedAt);
  const oversizedObservation = observation({
    at: startedAt + 1_000,
    baseSha: second.baseSha,
    headSha: second.headSha,
    requestId: null,
    requestAt: startedAt,
    withResult: false,
  });
  oversizedObservation.padding = "x".repeat(
    publicationConstants.max_observation_bytes,
  );
  await assert.rejects(
    recordGithubSnapshot(
      second.store,
      second.reviewId,
      { expectedRevision: 1, observation: oversizedObservation },
      { clock: () => startedAt + 1_010 },
    ),
    /observation exceeds 6 MiB/,
  );
  const tooManyRequirements = observation({
    at: startedAt + 1_000,
    baseSha: second.baseSha,
    headSha: second.headSha,
    requestId: null,
    requestAt: startedAt,
    withResult: false,
  });
  tooManyRequirements.required_checks.requirements = Array.from(
    { length: 1_001 },
    (_, index) => ({ context: `ci-${index}` }),
  );
  await assert.rejects(
    recordGithubSnapshot(
      second.store,
      second.reviewId,
      { expectedRevision: 1, observation: tooManyRequirements },
      { clock: () => startedAt + 1_010 },
    ),
    /requirements exceeds 1,000 entries/,
  );
  const tooManyEvidenceEntries = observation({
    at: startedAt + 1_000,
    baseSha: second.baseSha,
    headSha: second.headSha,
    requestId: null,
    requestAt: startedAt,
    withResult: false,
  });
  tooManyEvidenceEntries.review_threads.threads = Array.from(
    { length: 10_001 },
    (_, index) => ({ id: `thread-${index}` }),
  );
  await assert.rejects(
    recordGithubSnapshot(
      second.store,
      second.reviewId,
      { expectedRevision: 1, observation: tooManyEvidenceEntries },
      { clock: () => startedAt + 1_010 },
    ),
    /observation exceeds 10,000 evidence entries/,
  );
  assert.equal((await getPublication(second.store, second.reviewId)).revision, 1);
});

test("the 64 KiB terminal reserve boundary is exact", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const ledger = await start(state, Date.now());
  const entry = {
    resource_id: 1,
    resource_kind: "ISSUE_COMMENT",
    classification: "UNBOUND",
    binding_source: "OBSERVED_UNBOUND",
    url: "https://github.com/owner/repo/issues/7#issuecomment-1",
    event_at: ledger.created_at,
    timestamp_field: "created_at",
    recorded_at: ledger.created_at,
    recorded_revision: 1,
    body_sha256: "0".repeat(64),
    requested_head_sha: null,
    reason: "MISSING_POST_BINDING",
    padding: "",
  };
  ledger.codex_request_history.push(entry);
  const limit =
    publicationConstants.max_publication_bytes -
    publicationConstants.terminal_reserve_bytes;
  entry.padding = "x".repeat(limit - Buffer.byteLength(canonicalJson(ledger)) - 1);
  const publicationPath = path.join(
    state.store,
    "reviews",
    state.reviewId,
    "publication.json",
  );
  assert.equal(Buffer.byteLength(`${canonicalJson(ledger)}\n`), limit);
  await atomicWriteCanonicalJson(publicationPath, ledger);
  assert.equal((await getPublication(state.store, state.reviewId)).revision, 1);
  entry.padding += "x";
  await atomicWriteCanonicalJson(publicationPath, ledger);
  await assert.rejects(
    getPublication(state.store, state.reviewId),
    /would exceed/,
  );
});

test("baseline snapshots use identity-set equality and reject caller classifications", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const startedAt = Date.now();
  const requests = [77, 78].map((id) => ({
    resource_id: id,
    resource_kind: "ISSUE_COMMENT",
    url: `https://github.com/owner/repo/issues/7#issuecomment-${id}`,
    event_at: iso(startedAt - 1_000 + id),
    timestamp_field: "created_at",
    body_sha256: publicationConstants.request_body_sha256,
    actor: { id: 42, type: "User" },
  }));
  await start(state, startedAt, baseline(startedAt - 100, requests));
  const observedAt = startedAt + 1_000;
  const reordered = observation({
    at: observedAt,
    baseSha: state.baseSha,
    headSha: state.headSha,
    requestId: null,
    requestAt: observedAt,
    withResult: false,
    baselineRequests: [...requests].reverse(),
  });
  const accepted = await recordGithubSnapshot(
    state.store,
    state.reviewId,
    { expectedRevision: 1, observation: reordered },
    { clock: () => observedAt + 10 },
  );
  assert.equal(accepted.status, "GITHUB_REVIEW_UNKNOWN");
  const withClassification = structuredClone(reordered);
  withClassification.codex_review.preexisting_requests[0].classification =
    "BASELINE_EXACT";
  await assert.rejects(
    recordGithubSnapshot(
      state.store,
      state.reviewId,
      { expectedRevision: 2, observation: withClassification },
      { clock: () => observedAt + 20 },
    ),
    /unexpected field classification/,
  );
  assert.equal((await getPublication(state.store, state.reviewId)).revision, 2);
});

test("a thread collection that admits incompleteness is still recordable", async (t) => {
  // The single-page rule is gated on COMPLETE, and this is the boundary that
  // gating draws. A collection claiming completeness with two pages is refused
  // because the gate would decide from it; one that admits incompleteness is
  // recorded and the gate declines to decide from it instead. Checking
  // unconditionally would make this state unrecordable.
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const startedAt = Date.now();
  await start(state, startedAt);
  const observedAt = startedAt + 1_000;
  const partial = observation({
    at: observedAt,
    baseSha: state.baseSha,
    headSha: state.headSha,
    requestId: null,
    requestAt: startedAt,
    withResult: false,
  });
  partial.review_threads.collection.status = "INCOMPLETE";
  partial.review_threads.collection.sources[0].page_count = 2;
  const recorded = await recordGithubSnapshot(
    state.store,
    state.reviewId,
    { expectedRevision: 1, observation: partial },
    { clock: () => observedAt + 20 },
  );
  assert.equal(recorded.status, "EVIDENCE_INCOMPLETE");
  assert.equal(recorded.revision, 2);
});

test("observation validation rejects incomplete provenance and unsafe check bindings", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const startedAt = Date.now();
  await start(state, startedAt);
  const fresh = () =>
    observation({
      at: startedAt + 1_000,
      baseSha: state.baseSha,
      headSha: state.headSha,
      requestId: null,
      requestAt: startedAt,
      withResult: false,
    });
  const cases = [
    {
      pattern: /must prove complete pagination/,
      mutate(value) {
        value.codex_review.collection.sources[0].pagination_complete = false;
      },
    },
    {
      // The observation arrives as caller-supplied JSON, so the collector's
      // refusal to walk threads has to be restated here or it holds in only
      // one of the two layers that claim it. Bound to collections claiming
      // completeness; the incompleteness case above pins the other side.
      pattern: /must be a single atomic page/,
      mutate(value) {
        value.review_threads.collection.sources[0].page_count = 2;
      },
    },
    {
      // Same rule, other collection: a check run's conclusion decides the gate
      // too, so it cannot be assembled from several instants either.
      pattern: /CHECK_RUN must be a single atomic page/,
      mutate(value) {
        const source = value.required_checks.collection.run_sources.find(
          (entry) => entry.kind === "CHECK_RUN",
        );
        source.page_count = 2;
      },
    },
    {
      // decidingRunsFor treats the two kinds alike, so the rule must too.
      pattern: /COMMIT_STATUS must be a single atomic page/,
      mutate(value) {
        const source = value.required_checks.collection.run_sources.find(
          (entry) => entry.kind === "COMMIT_STATUS",
        );
        source.page_count = 2;
      },
    },
    {
      pattern: /CHECK_RUN collection counts are inconsistent/,
      mutate(value) {
        value.required_checks.collection.run_sources[0].item_count = 1;
      },
    },
    {
      pattern: /filter=all/,
      mutate(value) {
        value.required_checks.collection.run_sources[0].endpoint =
          "GET /repos/owner/repo/commits/head/check-runs";
      },
    },
    {
      pattern: /protected branches require an explicit classic-protection source/,
      mutate(value) {
        const branch = value.required_checks.collection.policy_sources.find(
          (source) => source.kind === "BRANCH_METADATA",
        );
        branch.protected = true;
      },
    },
    {
      pattern: /classic-protection NOT_CONFIGURED must prove the exact target HTTP 404/,
      mutate(value) {
        const branch = value.required_checks.collection.policy_sources.find(
          (source) => source.kind === "BRANCH_METADATA",
        );
        branch.protected = true;
        value.required_checks.collection.policy_sources.push({
          kind: "CLASSIC_BRANCH_PROTECTION",
          endpoint: "GET /fixture/classic",
          collected_at:
            value.required_checks.collection.policy_sources[0].collected_at,
          status: "COMPLETE",
          result: "NOT_CONFIGURED",
        });
      },
    },
    {
      pattern: /classic-protection NOT_CONFIGURED requires endpoint-specific administration proof/,
      mutate(value) {
        const policySources =
          value.required_checks.collection.policy_sources;
        const branch = policySources.find(
          (source) => source.kind === "BRANCH_METADATA",
        );
        branch.protected = true;
        policySources.push(
          {
            kind: "CLASSIC_BRANCH_PROTECTION",
            endpoint: "GET /repos/owner/repo/branches/main/protection",
            collected_at: policySources[0].collected_at,
            result: "NOT_CONFIGURED",
            http_status: 404,
          },
          {
            kind: "GITHUB_OAUTH_REPOSITORY_PERMISSIONS",
            endpoint: "GET /repos/other/repo",
            collected_at: policySources[0].collected_at,
            result: "SUCCESS",
            credential_type: "OAUTH_SCOPE_TOKEN",
            field: "x-oauth-scopes+permissions.admin",
            level: "ADMIN",
            scope: "repo",
          },
        );
      },
    },
    ...[
      {
        endpoint: "GET /repos/other/repo/branches/main/protection",
        httpStatus: 404,
      },
      {
        endpoint: "GET /repos/owner/repo/branches/main/protection",
        httpStatus: 403,
      },
      {
        endpoint: "GET /repos/owner/repo/branches/main/protection",
        httpStatus: undefined,
      },
    ].map(({ endpoint, httpStatus }) => ({
      pattern: /classic-protection NOT_CONFIGURED must prove the exact target HTTP 404/,
      mutate(value) {
        const policySources =
          value.required_checks.collection.policy_sources;
        policySources.find(
          (source) => source.kind === "BRANCH_METADATA",
        ).protected = true;
        policySources.push(
          {
            kind: "CLASSIC_BRANCH_PROTECTION",
            endpoint,
            collected_at: policySources[0].collected_at,
            result: "NOT_CONFIGURED",
            ...(httpStatus === undefined
              ? {}
              : { http_status: httpStatus }),
          },
          {
            kind: "GITHUB_OAUTH_REPOSITORY_PERMISSIONS",
            endpoint: "GET /repos/owner/repo",
            collected_at: policySources[0].collected_at,
            result: "SUCCESS",
            credential_type: "OAUTH_SCOPE_TOKEN",
            field: "x-oauth-scopes+permissions.admin",
            level: "ADMIN",
            scope: "repo",
          },
        );
      },
    })),
    {
      pattern: /administration proof must not precede the classic-protection 404/,
      mutate(value) {
        const policySources =
          value.required_checks.collection.policy_sources;
        policySources.find(
          (source) => source.kind === "BRANCH_METADATA",
        ).protected = true;
        const classicAt = policySources[0].collected_at;
        policySources.push(
          {
            kind: "CLASSIC_BRANCH_PROTECTION",
            endpoint: "GET /repos/owner/repo/branches/main/protection",
            collected_at: classicAt,
            result: "NOT_CONFIGURED",
            http_status: 404,
          },
          {
            kind: "GITHUB_OAUTH_REPOSITORY_PERMISSIONS",
            endpoint: "GET /repos/owner/repo",
            collected_at: new Date(
              Date.parse(classicAt) - 1,
            ).toISOString(),
            result: "SUCCESS",
            credential_type: "OAUTH_SCOPE_TOKEN",
            field: "x-oauth-scopes+permissions.admin",
            level: "ADMIN",
            scope: "repo",
          },
        );
      },
    },
    {
      pattern: /classic-protection NOT_CONFIGURED requires endpoint-specific administration proof/,
      mutate(value) {
        const policySources =
          value.required_checks.collection.policy_sources;
        policySources.push({
          kind: "CLASSIC_BRANCH_PROTECTION",
          endpoint: "GET /repos/owner/repo/branches/main/protection",
          collected_at: policySources[0].collected_at,
          result: "NOT_CONFIGURED",
          http_status: 404,
        });
        value.required_checks.policy = "REQUIRED";
        value.required_checks.requirements = [
          {
            context: "ruleset-only",
            app_binding: "PINNED",
            required_app_id: 15368,
            binding_sources: [
              {
                kind: "APPLICABLE_RULES",
                field:
                  "rules[].parameters.required_status_checks[].integration_id",
                raw_representation: "POSITIVE_INTEGER",
              },
            ],
          },
        ];
      },
    },
    {
      pattern: /APPLICABLE_RULES is not complete/,
      mutate(value) {
        const source = value.required_checks.collection.policy_sources.find(
          (item) => item.kind === "APPLICABLE_RULES",
        );
        source.status = "COMPLETE";
        source.result = "ERROR";
      },
    },
    {
      pattern: /strict policy provenance contradicts required flag/,
      mutate(value) {
        value.required_checks.strict_policy.sources = [
          {
            kind: "CLASSIC_BRANCH_PROTECTION",
            field: "required_status_checks.strict",
            value: true,
          },
        ];
      },
    },
    {
      pattern: /pinned Codex actor cannot appear in the foreign partition/,
      mutate(value) {
        value.codex_review.foreign_actor_objects.push({
          resource_id: 999,
          resource_kind: "ISSUE_COMMENT",
          url: "https://github.com/owner/repo/issues/7#issuecomment-999",
          event_at: value.observed_at,
          timestamp_field: "created_at",
          actor: { id: 99, type: "Bot" },
          body_sha256: "0".repeat(64),
        });
      },
    },
    {
      pattern: /codex_review\.app_notices\[0\] must be an object/,
      mutate(value) {
        value.codex_review.app_notices = [null];
      },
    },
    {
      pattern: /codex_review\.foreign_actor_objects\[0\] must be an object/,
      mutate(value) {
        value.codex_review.foreign_actor_objects = [null];
      },
    },
    ...[
      {
        pattern: /app notice has wrong timestamp_field/,
        notice: {
          resource_kind: "PULL_REQUEST_REVIEW",
          url: "https://github.com/owner/repo/pull/7#pullrequestreview-998",
        },
      },
      {
        pattern: /app notice must carry the pinned Codex actor/,
        notice: { actor: { id: 7, type: "User" } },
      },
      {
        pattern: /app notice body does not match its digest/,
        notice: { body_sha256: "0".repeat(64) },
      },
      {
        pattern: /app notice body does not carry its marker/,
        notice: {
          body: UNKNOWN_APP_BODY,
          body_sha256: digest(UNKNOWN_APP_BODY),
        },
      },
    ].map(({ pattern, notice }) => ({
      pattern,
      mutate(value) {
        value.codex_review.app_notices = [
          {
            resource_id: 998,
            resource_kind: "ISSUE_COMMENT",
            url: "https://github.com/owner/repo/issues/7#issuecomment-998",
            event_at: value.observed_at,
            timestamp_field: "created_at",
            actor: { id: 99, type: "Bot" },
            body: APP_SUMMARY_BODY,
            body_sha256: digest(APP_SUMMARY_BODY),
            marker: "codex-pull-request-review-summary",
            ...notice,
          },
        ];
      },
    })),
    {
      pattern: /commit status cannot claim an App ID/,
      mutate(value) {
        const source = value.required_checks.collection.run_sources.find(
          (item) => item.kind === "COMMIT_STATUS",
        );
        source.item_count = 1;
        value.required_checks.runs.push({
          run_id: 1,
          run_kind: "COMMIT_STATUS",
          context: "ci",
          head_sha: state.headSha,
          started_at: value.observed_at,
          status: "COMPLETED",
          completed_at: value.observed_at,
          conclusion: "SUCCESS",
          app_id: 7,
          app_id_source: "CHECK_RUN_APP_ID",
        });
      },
    },
  ];
  for (const { mutate, pattern } of cases) {
    const value = fresh();
    mutate(value);
    await assert.rejects(
      recordGithubSnapshot(
        state.store,
        state.reviewId,
        { expectedRevision: 1, observation: value },
        { clock: () => startedAt + 1_010 },
      ),
      pattern,
    );
  }
  assert.equal((await getPublication(state.store, state.reviewId)).revision, 1);
});

test("ruleset-only OAuth administration proof passes observation validation", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const startedAt = Date.now();
  await start(state, startedAt);
  const value = observation({
    at: startedAt + 1_000,
    baseSha: state.baseSha,
    headSha: state.headSha,
    requestId: null,
    requestAt: startedAt,
    withResult: false,
  });
  const policySources = value.required_checks.collection.policy_sources;
  const branch = policySources.find(
    (source) => source.kind === "BRANCH_METADATA",
  );
  branch.protected = true;
  policySources.push(
    {
      kind: "CLASSIC_BRANCH_PROTECTION",
      endpoint: "GET /repos/owner/repo/branches/main/protection",
      collected_at: policySources[0].collected_at,
      result: "NOT_CONFIGURED",
      http_status: 404,
    },
    {
      kind: "GITHUB_OAUTH_REPOSITORY_PERMISSIONS",
      endpoint: "GET /repos/owner/repo",
      collected_at: new Date(
        Date.parse(policySources[0].collected_at) + 1,
      ).toISOString(),
      result: "SUCCESS",
      credential_type: "OAUTH_SCOPE_TOKEN",
      field: "x-oauth-scopes+permissions.admin",
      level: "ADMIN",
      scope: "repo",
    },
  );
  value.required_checks.policy = "REQUIRED";
  value.required_checks.requirements = [
    {
      context: "ruleset-only",
      app_binding: "PINNED",
      required_app_id: 15368,
      binding_sources: [
        {
          kind: "APPLICABLE_RULES",
          field:
            "rules[].parameters.required_status_checks[].integration_id",
          raw_representation: "POSITIVE_INTEGER",
        },
      ],
    },
  ];

  const recorded = await recordGithubSnapshot(
    state.store,
    state.reviewId,
    { expectedRevision: 1, observation: value },
    { clock: () => startedAt + 1_020 },
  );
  assert.equal(recorded.revision, 2);
});

test("ruleset-only GitHub App administration proof enforces response order", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const startedAt = Date.now();
  await start(state, startedAt);
  const value = observation({
    at: startedAt + 1_000,
    baseSha: state.baseSha,
    headSha: state.headSha,
    requestId: null,
    requestAt: startedAt,
    withResult: false,
  });
  const policySources = value.required_checks.collection.policy_sources;
  policySources.find(
    (source) => source.kind === "BRANCH_METADATA",
  ).protected = true;
  const classicAt = policySources[0].collected_at;
  const appPermission = {
    kind: "GITHUB_APP_INSTALLATION_PERMISSIONS",
    endpoint: "GET /repos/owner/repo/installation",
    collected_at: new Date(Date.parse(classicAt) - 1).toISOString(),
    result: "SUCCESS",
    credential_type: "GITHUB_APP",
    field: "permissions.administration",
    level: "READ",
  };
  policySources.push(
    {
      kind: "CLASSIC_BRANCH_PROTECTION",
      endpoint: "GET /repos/owner/repo/branches/main/protection",
      collected_at: classicAt,
      result: "NOT_CONFIGURED",
      http_status: 404,
    },
    appPermission,
  );
  value.required_checks.policy = "REQUIRED";
  value.required_checks.requirements = [
    {
      context: "ruleset-only",
      app_binding: "PINNED",
      required_app_id: 15368,
      binding_sources: [
        {
          kind: "APPLICABLE_RULES",
          field:
            "rules[].parameters.required_status_checks[].integration_id",
          raw_representation: "POSITIVE_INTEGER",
        },
      ],
    },
  ];

  await assert.rejects(
    recordGithubSnapshot(
      state.store,
      state.reviewId,
      { expectedRevision: 1, observation: value },
      { clock: () => startedAt + 1_020 },
    ),
    /administration proof must not precede the classic-protection 404/,
  );
  assert.equal((await getPublication(state.store, state.reviewId)).revision, 1);

  appPermission.collected_at = new Date(
    Date.parse(classicAt) + 1,
  ).toISOString();
  const recorded = await recordGithubSnapshot(
    state.store,
    state.reviewId,
    { expectedRevision: 1, observation: value },
    { clock: () => startedAt + 1_030 },
  );
  assert.equal(recorded.revision, 2);
});

test("publication mutations serialize independently from review mutations", async (t) => {
  const first = await fixture();
  t.after(() => fsp.rm(first.root, { recursive: true, force: true }));
  const directory = path.join(first.store, "reviews", first.reviewId);
  const releasePublication = await acquireStateLock({
    directory,
    reviewId: first.reviewId,
    domain: "publication",
  });
  const startedAt = Date.now();
  const pendingStart = start(first, startedAt);
  await new Promise((resolve) => setTimeout(resolve, 200));
  let settled = false;
  pendingStart.finally(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(settled, false);
  await releasePublication();
  assert.equal((await pendingStart).revision, 1);

  const second = await fixture();
  t.after(() => fsp.rm(second.root, { recursive: true, force: true }));
  const releaseReview = await acquireStateLock({
    directory: path.join(second.store, "reviews", second.reviewId),
    reviewId: second.reviewId,
    domain: "review",
  });
  try {
    assert.equal((await start(second, Date.now())).revision, 1);
  } finally {
    await releaseReview();
  }
});

test("automatic quiescence requires fresh direct-human acknowledgement", async (t) => {
  const accepted = await fixture();
  t.after(() => fsp.rm(accepted.root, { recursive: true, force: true }));
  const now = Date.now();
  const created = await startPublication(
    accepted.store,
    {
      reviewId: accepted.reviewId,
      repositoryId: 42,
      owner: "owner",
      repo: "repo",
      prNumber: 7,
      baseBranch: "main",
      headBranch: "agent/change",
      codexActorId: 99,
      codexActorType: "Bot",
      codexActorLogin: "chatgpt-codex-connector[bot]",
      codexTriggerMode: "AUTOMATIC_QUIESCENCE_ACKNOWLEDGED",
      operatorLabel: "maintainer",
      rationale: "No automatic request remains in flight.",
      baseline: baseline(now - 30_000),
    },
    { clock: () => now },
  );
  assert.deepEqual(created.target.codex_trigger_policy, {
    mode: "AUTOMATIC_QUIESCENCE_ACKNOWLEDGED",
    operator_label: "maintainer",
    rationale: "No automatic request remains in flight.",
    acknowledged_at: iso(now),
  });

  for (const [operatorLabel, rationale, age, pattern] of [
    [null, "reason", 0, /operator_label/],
    ["maintainer", null, 0, /rationale/],
    ["maintainer", "reason", -1, /completed baseline from the last 30 seconds/],
    ["maintainer", "reason", 30_001, /last 30 seconds/],
  ]) {
    const rejected = await fixture();
    t.after(() => fsp.rm(rejected.root, { recursive: true, force: true }));
    await assert.rejects(
      startPublication(
        rejected.store,
        {
          reviewId: rejected.reviewId,
          repositoryId: 42,
          owner: "owner",
          repo: "repo",
          prNumber: 7,
          baseBranch: "main",
          headBranch: "agent/change",
          codexActorId: 99,
          codexActorType: "Bot",
          codexActorLogin: "chatgpt-codex-connector[bot]",
          codexTriggerMode: "AUTOMATIC_QUIESCENCE_ACKNOWLEDGED",
          operatorLabel,
          rationale,
          baseline: baseline(now - age),
        },
        { clock: () => now },
      ),
      pattern,
    );
  }
});

test("closed and merged pull requests persist terminal state", async (t) => {
  for (const terminal of ["CLOSED", "MERGED"]) {
    const state = await fixture();
    t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
    const startedAt = Date.now();
    await start(state, startedAt);
    const current = observation({
      at: startedAt + 1_000,
      baseSha: state.baseSha,
      headSha: state.headSha,
      requestId: null,
      requestAt: startedAt,
      withResult: false,
    });
    current.pull_request.state = "CLOSED";
    if (terminal === "MERGED") {
      current.pull_request.is_merged = true;
      current.pull_request.merged_at = iso(startedAt + 500);
      current.pull_request.merge_commit_sha = "a".repeat(40);
    }
    const recorded = await recordGithubSnapshot(
      state.store,
      state.reviewId,
      { expectedRevision: 1, observation: current },
      { clock: () => startedAt + 1_010 },
    );
    assert.equal(recorded.status, terminal);
    assert.equal(recorded.terminal.status, terminal);

    const reopened = structuredClone(current);
    reopened.pull_request.state = "OPEN";
    reopened.pull_request.is_merged = false;
    reopened.pull_request.merged_at = null;
    reopened.pull_request.merge_commit_sha = null;
    await assert.rejects(
      recordGithubSnapshot(
        state.store,
        state.reviewId,
        { expectedRevision: 2, observation: reopened },
        { clock: () => startedAt + 1_020 },
      ),
      /PUBLICATION_TERMINAL/,
    );
    assert.equal((await getPublication(state.store, state.reviewId)).status, terminal);
  }
});

test("gate expiry uses the oldest independent run source", async (t) => {
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
  const current = observation({
    at: observedAt,
    baseSha: state.baseSha,
    headSha: state.headSha,
    requestId: 100,
    requestAt,
  });
  const oldestRunAt = startedAt + 1_000;
  current.required_checks.collection.run_sources.find(
    (source) => source.kind === "COMMIT_STATUS",
  ).collected_at = iso(oldestRunAt);
  const ready = await recordGithubSnapshot(
    state.store,
    state.reviewId,
    { expectedRevision: 2, observation: current },
    { clock: () => observedAt + 10 },
  );
  const gate = await finalizePublicationGate(
    state.store,
    state.reviewId,
    { expectedRevision: ready.revision },
    { clock: () => observedAt + 20 },
  );
  assert.equal(gate.github_oldest_collection_at, iso(oldestRunAt));
  assert.equal(gate.expires_at, iso(oldestRunAt + 5 * 60 * 1_000));
});

test("ambiguity acknowledgements close one revision-defined correlation epoch", async (t) => {
  const baselineRequest = (startedAt) => ({
    resource_id: 77,
    resource_kind: "ISSUE_COMMENT",
    url: "https://github.com/owner/repo/issues/7#issuecomment-77",
    event_at: iso(startedAt - 500),
    timestamp_field: "created_at",
    body_sha256: publicationConstants.request_body_sha256,
    actor: { id: 123, type: "User" },
  });
  const acknowledgeFirstEpoch = async (state, startedAt) => {
    const source = baselineRequest(startedAt);
    await start(
      state,
      startedAt,
      baseline(startedAt - 100, [source]),
    );
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
    const current = observation({
      at: observedAt,
      baseSha: state.baseSha,
      headSha: state.headSha,
      requestId: 100,
      requestAt,
      withResult: false,
      baselineRequests: [source],
    });
    await recordGithubSnapshot(
      state.store,
      state.reviewId,
      { expectedRevision: 2, observation: current },
      { clock: () => observedAt + 10 },
    );
    await assert.rejects(
      acknowledgeCodexReviewAmbiguity(
        state.store,
        state.reviewId,
        {
          expectedRevision: 3,
          headSha: state.headSha,
          requestRefs: [
            { resource_kind: "ISSUE_COMMENT", resource_id: 77 },
          ],
          ambiguousResults: [],
          acknowledgement: "NO_FURTHER_RESULTS_EXPECTED",
          operatorLabel: "maintainer",
          rationale: "Close the old correlation epoch.",
        },
        { clock: () => observedAt + 20 },
      ),
      /ACKNOWLEDGEMENT_SET_MISMATCH/,
    );
    const acknowledged = await acknowledgeCodexReviewAmbiguity(
      state.store,
      state.reviewId,
      {
        expectedRevision: 3,
        headSha: state.headSha,
        requestRefs: [
          { resource_kind: "ISSUE_COMMENT", resource_id: 77 },
          { resource_kind: "ISSUE_COMMENT", resource_id: 100 },
        ],
        ambiguousResults: [],
        acknowledgement: "NO_FURTHER_RESULTS_EXPECTED",
        operatorLabel: "maintainer",
        rationale: "Close the old correlation epoch.",
      },
      { clock: () => observedAt + 20 },
    );
    assert.equal(acknowledged.revision, 4);
    assert.equal(acknowledged.status, "GITHUB_REVIEW_NOT_REQUESTED");
    return { source, requestAt, observedAt };
  };

  const delayed = await fixture();
  t.after(() => fsp.rm(delayed.root, { recursive: true, force: true }));
  const startedAt = Date.now();
  const delayedEpoch = await acknowledgeFirstEpoch(delayed, startedAt);
  const delayedObservation = observation({
    at: startedAt + 3_000,
    baseSha: delayed.baseSha,
    headSha: delayed.headSha,
    requestId: 100,
    requestAt: delayedEpoch.requestAt,
    baselineRequests: [delayedEpoch.source],
  });
  Object.assign(delayedObservation.codex_review.results[0], {
    association: "UNSOLICITED",
    request_ref: null,
    reviewed_head_sha: null,
    format: "UNKNOWN",
    verdict: "UNKNOWN",
  });
  const acceptedRisk = await recordGithubSnapshot(
    delayed.store,
    delayed.reviewId,
    { expectedRevision: 4, observation: delayedObservation },
    { clock: () => startedAt + 3_010 },
  );
  assert.equal(acceptedRisk.status, "GITHUB_REVIEW_NOT_REQUESTED");

  const recovery = await fixture();
  t.after(() => fsp.rm(recovery.root, { recursive: true, force: true }));
  const recoveryEpoch = await acknowledgeFirstEpoch(recovery, startedAt);
  const acknowledgedAt = startedAt + 2_020;
  const backdatedRequestAt = acknowledgedAt - 1;
  await recordCodexReviewRequest(
    recovery.store,
    recovery.reviewId,
    {
      expectedRevision: 4,
      commentId: 200,
      url: "https://github.com/owner/repo/issues/7#issuecomment-200",
      createdAt: iso(backdatedRequestAt),
      requestedHeadSha: recovery.headSha,
    },
    { clock: () => startedAt + 3_000 },
  );
  const replacement = observation({
    at: startedAt + 4_000,
    baseSha: recovery.baseSha,
    headSha: recovery.headSha,
    requestId: 200,
    requestAt: backdatedRequestAt,
    baselineRequests: [recoveryEpoch.source],
  });
  replacement.codex_review.requests.unshift({
    ...structuredClone(replacement.codex_review.requests[0]),
    comment_id: 100,
    url: "https://github.com/owner/repo/issues/7#issuecomment-100",
    event_at: iso(recoveryEpoch.requestAt),
  });
  const ready = await recordGithubSnapshot(
    recovery.store,
    recovery.reviewId,
    { expectedRevision: 5, observation: replacement },
    { clock: () => startedAt + 4_010 },
  );
  assert.equal(ready.status, "MERGE_READY");
  assert.ok(
    ready.codex_request_history.find((item) => item.resource_id === 200)
      .recorded_revision >
      ready.codex_review_ambiguity_acknowledgements[0].publication_revision,
  );
  assert.ok(
    Date.parse(
      ready.codex_request_history.find((item) => item.resource_id === 200)
        .event_at,
    ) <=
      Date.parse(
        ready.codex_review_ambiguity_acknowledgements[0].acknowledged_at,
      ),
  );
});

test("cross-kind timestamp ties remain server-side ambiguity", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const startedAt = Date.now();
  const tiedAt = startedAt + 1_000;
  const baselineRequest = {
    resource_id: 77,
    resource_kind: "PULL_REQUEST_REVIEW",
    url: "https://github.com/owner/repo/pull/7#pullrequestreview-77",
    event_at: iso(tiedAt),
    timestamp_field: "submitted_at",
    body_sha256: publicationConstants.request_body_sha256,
    actor: { id: 123, type: "User" },
  };
  await start(
    state,
    startedAt,
    baseline(startedAt - 100, [baselineRequest]),
  );
  const current = observation({
    at: startedAt + 2_000,
    baseSha: state.baseSha,
    headSha: state.headSha,
    requestId: null,
    requestAt: tiedAt,
    withResult: false,
    baselineRequests: [baselineRequest],
  });
  current.codex_review.results = [
    {
      result_id: 78,
      resource_kind: "ISSUE_COMMENT",
      native_review_state: null,
      url: "https://github.com/owner/repo/issues/7#issuecomment-78",
      event_at: iso(tiedAt),
      timestamp_field: "created_at",
      actor: {
        id: 99,
        type: "Bot",
        login: "chatgpt-codex-connector[bot]",
      },
      request_ref: null,
      association: "AMBIGUOUS",
      reviewed_head_sha: null,
      commit_binding: null,
      attached_review_comments: [],
      format: "UNKNOWN",
      verdict: "UNKNOWN",
      body_sha256: digest("cross-kind tie"),
    },
  ];
  const recorded = await recordGithubSnapshot(
    state.store,
    state.reviewId,
    { expectedRevision: 1, observation: current },
    { clock: () => startedAt + 2_010 },
  );
  assert.equal(recorded.status, "GITHUB_REVIEW_UNKNOWN");
});

test("monotonic state enforces exact individual and aggregate boundaries", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const started = await start(state, Date.now());
  const publicationPath = path.join(
    state.store,
    "reviews",
    state.reviewId,
    "publication.json",
  );
  const requestEntry = (id) => ({
    resource_id: id,
    resource_kind: "ISSUE_COMMENT",
    classification: "UNBOUND",
    binding_source: "OBSERVED_UNBOUND",
    url: `https://github.com/owner/repo/issues/7#issuecomment-${id}`,
    event_at: started.created_at,
    timestamp_field: "created_at",
    recorded_at: started.created_at,
    recorded_revision: 1,
    body_sha256: "0".repeat(64),
    requested_head_sha: null,
    reason: "MISSING_POST_BINDING",
  });
  const resultEntry = (id) => ({
    result_id: id,
    resource_kind: "ISSUE_COMMENT",
    native_review_state: null,
    url: `https://github.com/owner/repo/issues/7#issuecomment-${id}`,
    event_at: started.created_at,
    timestamp_field: "created_at",
    actor: { id: 99, type: "Bot" },
    reviewed_head_sha: null,
    commit_binding: null,
    attached_review_comments: [],
    body_sha256: "1".repeat(64),
    recorded_at: started.created_at,
  });
  const history = (length, terminal = false) =>
    Array.from({ length }, (_, index) => ({
      at: started.created_at,
      event: index === 0 ? "PUBLICATION_STARTED" : "GITHUB_SNAPSHOT_RECORDED",
      revision: index + 1,
      status:
        terminal && index === length - 1 ? "INVALIDATED" : "PR_PENDING",
      head_sha: state.headSha,
    }));
  const write = async (ledger) => {
    await atomicWriteCanonicalJson(publicationPath, ledger);
    return getPublication(state.store, state.reviewId);
  };

  const requestBoundary = structuredClone(started);
  requestBoundary.codex_request_history = Array.from(
    { length: 10_000 },
    (_, index) => requestEntry(index + 1),
  );
  assert.equal((await write(requestBoundary)).codex_request_history.length, 10_000);
  requestBoundary.codex_request_history.push(requestEntry(10_001));
  await assert.rejects(write(requestBoundary), /at most 10000 entries/);

  const resultBoundary = structuredClone(started);
  resultBoundary.codex_result_history = Array.from(
    { length: 10_000 },
    (_, index) => resultEntry(index + 1),
  );
  assert.equal((await write(resultBoundary)).codex_result_history.length, 10_000);
  resultBoundary.codex_result_history.push(resultEntry(10_001));
  await assert.rejects(write(resultBoundary), /at most 10000 entries/);

  const aggregateBoundary = structuredClone(started);
  aggregateBoundary.codex_request_history = Array.from(
    { length: 10_000 },
    (_, index) => requestEntry(index + 1),
  );
  aggregateBoundary.history = history(9_999);
  aggregateBoundary.revision = 9_999;
  aggregateBoundary.updated_at = started.created_at;
  assert.equal(
    (await write(aggregateBoundary)).codex_request_history.length +
      aggregateBoundary.history.length,
    19_999,
  );
  aggregateBoundary.history = history(10_000, true);
  aggregateBoundary.revision = 10_000;
  aggregateBoundary.status = "INVALIDATED";
  aggregateBoundary.terminal = {
    status: "INVALIDATED",
    revision: 10_000,
    at: started.created_at,
    reason: "capacity boundary",
  };
  const terminalBoundary = await write(aggregateBoundary);
  assert.equal(
    terminalBoundary.codex_request_history.length +
      terminalBoundary.history.length,
    20_000,
  );
  aggregateBoundary.codex_result_history = [resultEntry(20_001)];
  await assert.rejects(write(aggregateBoundary), /exceeds 20,000 entries/);

  const acknowledgementBoundary = structuredClone(started);
  const acknowledgement = (id, closedRequests = []) => ({
    acknowledgement_id: `ack-${id}`,
    head_sha: state.headSha,
    closed_requests: closedRequests,
    closed_results: [],
    acknowledgement: "NO_FURTHER_RESULTS_EXPECTED",
    operator_label: "maintainer",
    rationale: "capacity test",
    backing_observed_at: started.created_at,
    backing_observation_sha256: "2".repeat(64),
    acknowledged_at: started.created_at,
    publication_revision: 1,
  });
  acknowledgementBoundary.codex_review_ambiguity_acknowledgements =
    Array.from({ length: 1_000 }, (_, index) => acknowledgement(index + 1));
  assert.equal(
    (await write(acknowledgementBoundary))
      .codex_review_ambiguity_acknowledgements.length,
    1_000,
  );
  acknowledgementBoundary.codex_review_ambiguity_acknowledgements.push(
    acknowledgement(1_001),
  );
  await assert.rejects(write(acknowledgementBoundary), /at most 1000 entries/);

  const referenceBoundary = structuredClone(started);
  referenceBoundary.codex_review_ambiguity_acknowledgements = [
    acknowledgement(
      1,
      Array.from({ length: 1_000 }, (_, index) => ({
        resource_kind: "ISSUE_COMMENT",
        resource_id: index + 1,
      })),
    ),
  ];
  assert.equal(
    (await write(referenceBoundary))
      .codex_review_ambiguity_acknowledgements[0].closed_requests.length,
    1_000,
  );
  referenceBoundary.codex_review_ambiguity_acknowledgements[0].closed_results =
    [{ resource_kind: "ISSUE_COMMENT", result_id: 1_001 }];
  await assert.rejects(write(referenceBoundary), /more than 1,000 references/);
});

test("observations reach the ledger by path instead of through the caller", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-obs-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  const valid = path.join(root, "observation.json");
  await fsp.writeFile(valid, `${JSON.stringify({ observed_at: "now", runs: [1, 2] })}\n`);
  assert.deepEqual(await readObservationFile(valid), {
    observed_at: "now",
    runs: [1, 2],
  });

  await assert.rejects(
    readObservationFile(path.join(root, "missing.json")),
    (error) => {
      assert.equal(error.code, "OBSERVATION_FILE_UNREADABLE");
      assert.equal(error.details.retryable, false);
      return true;
    },
  );
  await assert.rejects(readObservationFile(root), (error) => {
    assert.equal(error.code, "OBSERVATION_FILE_UNREADABLE");
    return true;
  });
  await assert.rejects(readObservationFile(""), (error) => {
    assert.equal(error.code, "INVALID_INPUT");
    return true;
  });

  const array = path.join(root, "array.json");
  await fsp.writeFile(array, "[1,2,3]\n");
  await assert.rejects(readObservationFile(array), (error) => {
    assert.equal(error.code, "OBSERVATION_FILE_MALFORMED");
    return true;
  });

  const truncated = path.join(root, "truncated.json");
  await fsp.writeFile(truncated, '{"observed_at": ');
  await assert.rejects(readObservationFile(truncated), (error) => {
    assert.equal(error.code, "OBSERVATION_FILE_MALFORMED");
    return true;
  });

  const oversized = path.join(root, "oversized.json");
  await fsp.writeFile(
    oversized,
    `{"pad":"${"x".repeat(publicationConstants.max_observation_bytes)}"}`,
  );
  await assert.rejects(readObservationFile(oversized), (error) => {
    assert.equal(error.code, "OBSERVATION_FILE_TOO_LARGE");
    return true;
  });
});

test("incomplete thread provenance is recorded, not refused", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const startedAt = Date.now();
  const observedAt = startedAt + 1_000;
  const thread = (mutate) => {
    const value = {
      id: "PRRT_1",
      is_resolved: false,
      is_outdated: false,
      comment_count: 1,
      comments_pagination_complete: true,
      provenance_complete: true,
      comments: [
        {
          id: "PRRC_1",
          database_id: 3694779367,
          created_at: iso(startedAt - 5_000),
          updated_at: iso(startedAt - 5_000),
          actor: { id: 99, type: "Bot", login: "codex" },
          review: {
            id: "PRR_1",
            database_id: 4833836859,
            state: "COMMENTED",
            reviewed_head_sha: "c".repeat(40),
            actor: { id: 99, type: "Bot", login: "codex" },
          },
        },
      ],
    };
    mutate(value);
    return value;
  };
  const record = async (mutate) => {
    const next = await fixture();
    t.after(() => fsp.rm(next.root, { recursive: true, force: true }));
    await start(next, startedAt);
    const value = observation({
      at: observedAt,
      baseSha: next.baseSha,
      headSha: next.headSha,
      requestId: null,
      requestAt: startedAt,
      withResult: false,
    });
    const built = thread(mutate);
    value.review_threads.total_count = 1;
    value.review_threads.unresolved_count = 1;
    value.review_threads.threads = [built];
    // Ancestry must cover exactly the finding heads the threads reference.
    const findingHead = built.comments?.[0]?.review?.reviewed_head_sha;
    value.review_threads.ancestry =
      typeof findingHead === "string" && findingHead !== next.headSha
        ? [
            {
              finding_head_sha: findingHead,
              status: "AHEAD",
              descends: true,
              endpoint: `GET /repos/o/r/compare/${findingHead}...${next.headSha}`,
              collected_at: iso(observedAt - 500),
            },
          ]
        : [];
    return recordGithubSnapshot(
      next.store,
      next.reviewId,
      { expectedRevision: 1, observation: value },
      { clock: () => observedAt + 10 },
    );
  };

  const complete = await record(() => {});
  assert.equal(
    complete.latest_observation.review_threads.threads[0].provenance_complete,
    true,
  );

  // A thread the workflow cannot act on is still a real thread. Refusing the
  // observation would stall the publication behind a fact no fix can change,
  // so each of these is stored with the completeness it actually has.
  for (const [name, mutate] of [
    ["a thread deeper than one comment page", (value) => {
      value.comments_pagination_complete = false;
      value.provenance_complete = false;
    }],
    ["a count that disagrees with the comments", (value) => {
      value.comment_count = 2;
      value.provenance_complete = false;
    }],
    ["a root comment with no attached review", (value) => {
      value.comments[0].review = null;
      value.provenance_complete = false;
    }],
    ["a deleted root author", (value) => {
      value.comments[0].actor = { id: null, type: null, login: null };
      value.provenance_complete = false;
    }],
    ["a later comment from a deleted author", (value) => {
      value.comments.push({
        ...value.comments[0],
        id: "PRRC_2",
        database_id: 3694779368,
        actor: { id: null, type: null, login: null },
      });
      value.comment_count = 2;
      value.provenance_complete = false;
    }],
    ["a review with no author identity", (value) => {
      value.comments[0].review.actor = { id: null, type: null, login: null };
      value.provenance_complete = false;
    }],
    ["a review with no reviewed head", (value) => {
      value.comments[0].review.reviewed_head_sha = null;
      value.provenance_complete = false;
    }],
    ["an impossible actor id", (value) => {
      // Zero is not a GitHub actor. Accepting it would let the flag assert a
      // numeric identity that does not exist.
      value.comments[0].actor = { id: 0, type: "Bot", login: "codex" };
      value.provenance_complete = false;
    }],
  ]) {
    const recorded = await record(mutate);
    const stored = recorded.latest_observation.review_threads.threads[0];
    assert.equal(stored.provenance_complete, false, name);
    assert.equal(recorded.latest_observation.review_threads.unresolved_count, 1, name);
  }

  // What must not be storable is a completeness claim the evidence denies.
  await assert.rejects(
    record((value) => {
      value.comments[0].review = null;
    }),
    /disagrees with its evidence/,
    "a forged completeness claim",
  );
  await assert.rejects(
    record((value) => {
      delete value.comments;
    }),
    /requires the comments it summarizes/,
    "a summary with no evidence behind it",
  );
});

test("thread comments must be recorded in creation order", async (t) => {
  // The root binding is positional, so an unordered sequence would silently
  // bind the thread to the wrong review.
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const startedAt = Date.now();
  await start(state, startedAt);
  const observedAt = startedAt + 1_000;
  const value = observation({
    at: observedAt,
    baseSha: state.baseSha,
    headSha: state.headSha,
    requestId: null,
    requestAt: startedAt,
    withResult: false,
  });
  const comment = (databaseId, at) => ({
    id: `PRRC_${databaseId}`,
    database_id: databaseId,
    created_at: iso(at),
    updated_at: iso(at),
    actor: { id: 99, type: "Bot", login: "codex" },
    review: {
      id: "PRR_1",
      database_id: 4833836859,
      state: "COMMENTED",
      reviewed_head_sha: null,
      actor: { id: 99, type: "Bot", login: "codex" },
    },
  });
  value.review_threads.total_count = 1;
  value.review_threads.unresolved_count = 1;
  value.review_threads.threads = [
    {
      id: "PRRT_1",
      is_resolved: false,
      is_outdated: false,
      comment_count: 2,
      comments_pagination_complete: true,
      provenance_complete: true,
      comments: [
        comment(2, startedAt - 1_000),
        comment(1, startedAt - 5_000),
      ],
    },
  ];
  await assert.rejects(
    recordGithubSnapshot(
      state.store,
      state.reviewId,
      { expectedRevision: 1, observation: value },
      { clock: () => observedAt + 10 },
    ),
    /not in creation order/,
  );
});

test("duplicate comment node IDs are refused", async (t) => {
  // The node ID is what the later watermark and resolution joins key on, so a
  // duplicate leaves the identity this evidence exists to establish ambiguous.
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const startedAt = Date.now();
  await start(state, startedAt);
  const observedAt = startedAt + 1_000;
  const value = observation({
    at: observedAt,
    baseSha: state.baseSha,
    headSha: state.headSha,
    requestId: null,
    requestAt: startedAt,
    withResult: false,
  });
  const comment = (databaseId) => ({
    id: "PRRC_SAME",
    database_id: databaseId,
    created_at: iso(startedAt - 5_000),
    updated_at: iso(startedAt - 5_000),
    actor: { id: 99, type: "Bot", login: "codex" },
    review: {
      id: "PRR_1",
      database_id: 4833836859,
      state: "COMMENTED",
      reviewed_head_sha: "c".repeat(40),
      actor: { id: 99, type: "Bot", login: "codex" },
    },
  });
  value.review_threads.total_count = 1;
  value.review_threads.unresolved_count = 1;
  value.review_threads.threads = [
    {
      id: "PRRT_1",
      is_resolved: false,
      is_outdated: false,
      comment_count: 2,
      comments_pagination_complete: true,
      provenance_complete: true,
      comments: [comment(1), comment(2)],
    },
  ];
  await assert.rejects(
    recordGithubSnapshot(
      state.store,
      state.reviewId,
      { expectedRevision: 1, observation: value },
      { clock: () => observedAt + 10 },
    ),
    /thread comment node ids/,
  );
});

test("comments sharing a creation time are ordered by database id", async (t) => {
  // Creation time alone leaves either ordering acceptable for a colliding
  // pair, and the root is positional, so a reordered observation could bind
  // the thread to a reply's review.
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const startedAt = Date.now();
  await start(state, startedAt);
  const observedAt = startedAt + 1_000;
  const sameTime = iso(startedAt - 5_000);
  const comment = (databaseId) => ({
    id: `PRRC_${databaseId}`,
    database_id: databaseId,
    created_at: sameTime,
    updated_at: sameTime,
    actor: { id: 99, type: "Bot", login: "codex" },
    review: {
      id: `PRR_${databaseId}`,
      database_id: 4833836859 + databaseId,
      state: "COMMENTED",
      reviewed_head_sha: "c".repeat(40),
      actor: { id: 99, type: "Bot", login: "codex" },
    },
  });
  const build = (comments) => {
    const value = observation({
      at: observedAt,
      baseSha: state.baseSha,
      headSha: state.headSha,
      requestId: null,
      requestAt: startedAt,
      withResult: false,
    });
    value.review_threads.total_count = 1;
    value.review_threads.unresolved_count = 1;
    value.review_threads.threads = [
      {
        id: "PRRT_1",
        is_resolved: false,
        is_outdated: false,
        comment_count: comments.length,
        comments_pagination_complete: true,
        provenance_complete: true,
        comments,
      },
    ];
    value.review_threads.ancestry = [
      {
        finding_head_sha: "c".repeat(40),
        status: "AHEAD",
        descends: true,
        endpoint: `GET /repos/o/r/compare/${"c".repeat(40)}...${state.headSha}`,
        collected_at: iso(observedAt - 500),
      },
    ];
    return value;
  };

  // Equal timestamps are legitimate and must still be accepted in the
  // determined order.
  const accepted = await recordGithubSnapshot(
    state.store,
    state.reviewId,
    { expectedRevision: 1, observation: build([comment(1), comment(2)]) },
    { clock: () => observedAt + 10 },
  );
  assert.equal(
    accepted.latest_observation.review_threads.threads[0].comments[0].database_id,
    1,
  );

  const next = await fixture();
  t.after(() => fsp.rm(next.root, { recursive: true, force: true }));
  await start(next, startedAt);
  const reordered = build([comment(2), comment(1)]);
  reordered.pull_request.head_sha = next.headSha;
  reordered.pull_request.base_head_comparison.head_sha = next.headSha;
  reordered.pull_request.base_sha = next.baseSha;
  reordered.pull_request.pr_reported_base_sha = next.baseSha;
  await assert.rejects(
    recordGithubSnapshot(
      next.store,
      next.reviewId,
      { expectedRevision: 1, observation: reordered },
      { clock: () => observedAt + 10 },
    ),
    /not in creation order/,
  );
});

test("comments sharing a creation time and database id are refused", async (t) => {
  // Database-ID uniqueness is what makes the ordering key total, and so what
  // determines the root. Without a case that turns on the duplicate itself,
  // the check could be removed as redundant with the node ID and the root
  // would silently become undetermined again.
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const startedAt = Date.now();
  await start(state, startedAt);
  const observedAt = startedAt + 1_000;
  const sameTime = iso(startedAt - 5_000);
  const comment = (nodeId) => ({
    id: nodeId,
    database_id: 7,
    created_at: sameTime,
    updated_at: sameTime,
    actor: { id: 99, type: "Bot", login: "codex" },
    review: {
      id: "PRR_1",
      database_id: 4833836859,
      state: "COMMENTED",
      reviewed_head_sha: "c".repeat(40),
      actor: { id: 99, type: "Bot", login: "codex" },
    },
  });
  const value = observation({
    at: observedAt,
    baseSha: state.baseSha,
    headSha: state.headSha,
    requestId: null,
    requestAt: startedAt,
    withResult: false,
  });
  value.review_threads.total_count = 1;
  value.review_threads.unresolved_count = 1;
  value.review_threads.threads = [
    {
      id: "PRRT_1",
      is_resolved: false,
      is_outdated: false,
      comment_count: 2,
      comments_pagination_complete: true,
      provenance_complete: true,
      comments: [comment("PRRC_A"), comment("PRRC_B")],
    },
  ];
  await assert.rejects(
    recordGithubSnapshot(
      state.store,
      state.reviewId,
      { expectedRevision: 1, observation: value },
      { clock: () => observedAt + 10 },
    ),
    /thread comments/,
  );
});

const GATED_HEAD = "a".repeat(40);
const EARLIER_HEAD = "b".repeat(40);

function eligibilityLedger() {
  return {
    version: 3,
    authorization: { mode: "LOCAL_GATE", head_sha: GATED_HEAD, base_sha: "c".repeat(40) },
    target: { codex_actor: { id: 199175422, type: "Bot" } },
  };
}

function eligibilityContext(overrides = {}) {
  return {
    cleanForGatedHead: true,
    ancestryByHead: new Map([
      [
        EARLIER_HEAD,
        { finding_head_sha: EARLIER_HEAD, status: "AHEAD", descends: true },
      ],
    ]),
    workflow: {
      workflow_id: "wf-1",
      status: "ACTIVE",
      current_head_sha: GATED_HEAD,
      attempt_head_shas: [EARLIER_HEAD, GATED_HEAD],
      addressed_findings: [],
    },
    publicationTerminal: false,
    ...overrides,
  };
}

function addressedRecord(overrides = {}) {
  return {
    findings_review: {
      result_id: 4833836859,
      reviewed_head_sha: EARLIER_HEAD,
      ...(overrides.findings_review ?? {}),
    },
    addressed_by: overrides.addressed_by ?? [GATED_HEAD],
  };
}

function contextWithRecord(...records) {
  const context = eligibilityContext();
  context.workflow.addressed_findings = records;
  return context;
}

function eligibleThread(overrides = {}) {
  const codex = { id: 199175422, type: "Bot", login: "chatgpt-codex-connector" };
  return {
    id: "PRRT_1",
    is_resolved: false,
    is_outdated: false,
    provenance_complete: true,
    comments: [
      {
        id: "PRRC_1",
        actor: codex,
        review: {
          id: "PRR_1",
          database_id: 4833836859,
          actor: codex,
          reviewed_head_sha: EARLIER_HEAD,
        },
      },
    ],
    ...overrides,
  };
}

test("an addressed-by record naming the thread's review completes eligibility", () => {
  // RFC 0003 condition 3: with every other condition held, an addressed-by
  // record that names the thread's root review by ID and reviewed head is
  // what turns the verdict eligible. This is the first input for which
  // eligible is reachable at all.
  assert.deepEqual(
    threadResolutionEligibility(
      eligibilityLedger(),
      eligibleThread(),
      contextWithRecord(addressedRecord()),
    ),
    { eligible: true, addressed_by: [GATED_HEAD] },
  );
});

test("a record that does not name the thread's review still refuses", () => {
  // The record is the structural link to the correlated Codex review. A
  // record for another review, another head, or without a commit is not that
  // link, so each of these must land on the same refusal as no record at all.
  const cases = [
    ["no record", eligibilityContext()],
    [
      "different review",
      contextWithRecord(
        addressedRecord({ findings_review: { result_id: 999 } }),
      ),
    ],
    [
      "different reviewed head",
      contextWithRecord(
        addressedRecord({ findings_review: { reviewed_head_sha: "d".repeat(40) } }),
      ),
    ],
    ["no commits", contextWithRecord(addressedRecord({ addressed_by: [] }))],
  ];
  for (const [name, context] of cases) {
    assert.deepEqual(
      threadResolutionEligibility(eligibilityLedger(), eligibleThread(), context),
      { eligible: false, reason: "FIX_NOT_RECORDED" },
      name,
    );
  }
});

test("each missing piece of evidence refuses with its own reason", () => {
  const codex = { id: 199175422, type: "Bot", login: "chatgpt-codex-connector" };
  const human = { id: 5, type: "User", login: "jeremyhi" };
  const withReviewHead = (head) =>
    eligibleThread({
      comments: [
        {
          id: "PRRC_1",
          actor: codex,
          review: {
            id: "PRR_1",
            database_id: 4833836859,
            actor: codex,
            reviewed_head_sha: head,
          },
        },
      ],
    });
  const cases = [
    ["PROVENANCE_INCOMPLETE", eligibleThread({ provenance_complete: false }), eligibilityContext()],
    ["ALREADY_RESOLVED", eligibleThread({ is_resolved: true }), eligibilityContext()],
    [
      // A human reply is a participant this workflow was never authorized to
      // answer for, whoever opened the thread.
      "NOT_CODEX_AUTHORED",
      eligibleThread({
        comments: [
          eligibleThread().comments[0],
          { id: "PRRC_2", actor: human, review: null },
        ],
      }),
      eligibilityContext(),
    ],
    [
      // The review itself must be Codex's, not merely the comment's author.
      "NOT_CODEX_AUTHORED",
      eligibleThread({
        comments: [
          {
            id: "PRRC_1",
            actor: codex,
            review: { id: "PRR_1", actor: human, reviewed_head_sha: EARLIER_HEAD },
          },
        ],
      }),
      eligibilityContext(),
    ],
    [
      // A dismissed review was answered through a path this workflow does not
      // own; resolving on top of it would launder that path into a workflow
      // decision.
      "REVIEW_DISMISSED",
      eligibleThread({
        comments: [
          {
            id: "PRRC_1",
            actor: codex,
            review: {
              id: "PRR_1",
              actor: codex,
              state: "DISMISSED",
              reviewed_head_sha: EARLIER_HEAD,
            },
          },
        ],
      }),
      eligibilityContext(),
    ],
    [
      // Raised against the head the clean result examined: the same review
      // would have both raised it and not raised it.
      "RAISED_AGAINST_GATED_HEAD",
      withReviewHead(GATED_HEAD),
      eligibilityContext(),
    ],
    ["WORKFLOW_NOT_BOUND", eligibleThread(), eligibilityContext({ workflow: null })],
    [
      "WORKFLOW_NOT_ACTIVE",
      eligibleThread(),
      eligibilityContext({
        workflow: {
          workflow_id: "wf-1",
          status: "PAUSED",
          current_head_sha: GATED_HEAD,
          attempt_head_shas: [EARLIER_HEAD],
        },
      }),
    ],
    [
      // A finding from a head this workflow never published is not ours to
      // answer, whatever else the evidence says.
      "FINDING_HEAD_NOT_OURS",
      eligibleThread(),
      eligibilityContext({
        workflow: {
          workflow_id: "wf-1",
          status: "ACTIVE",
          current_head_sha: GATED_HEAD,
          attempt_head_shas: [GATED_HEAD],
        },
      }),
    ],
    [
      // A force-push that discarded the fix leaves the finding unanswered
      // however clean the new head is about its own contents.
      "DESCENT_UNPROVEN",
      eligibleThread(),
      eligibilityContext({
        ancestryByHead: new Map([
          [
            EARLIER_HEAD,
            { finding_head_sha: EARLIER_HEAD, status: "DIVERGED", descends: false },
          ],
        ]),
      }),
    ],
    [
      "DESCENT_UNPROVEN",
      eligibleThread(),
      eligibilityContext({ ancestryByHead: new Map() }),
    ],
    [
      "NO_CLEAN_RESULT_FOR_GATED_HEAD",
      eligibleThread(),
      eligibilityContext({ cleanForGatedHead: false }),
    ],
    [
      // A terminal publication decides nothing further.
      "PUBLICATION_TERMINAL",
      eligibleThread(),
      eligibilityContext({ publicationTerminal: true }),
    ],
    [
      // The workflow has already moved past this publication's head: a plan
      // built on it would be a plan for a publication that no longer exists.
      "PUBLICATION_SUPERSEDED",
      eligibleThread(),
      eligibilityContext({
        workflow: {
          workflow_id: "wf-1",
          status: "ACTIVE",
          current_head_sha: "e".repeat(40),
          attempt_head_shas: [EARLIER_HEAD, GATED_HEAD],
        },
      }),
    ],
  ];
  for (const [reason, thread, context] of cases) {
    assert.deepEqual(
      threadResolutionEligibility(eligibilityLedger(), thread, context),
      { eligible: false, reason },
      reason,
    );
  }
});

test("the reply exception admits exactly the recorded comment and nothing else", () => {
  const operator = { id: 555, type: "User", login: "operator" };
  const withReply = (databaseId, actor = operator) =>
    eligibleThread({
      comments: [
        eligibleThread().comments[0],
        { id: "PRRC_2", database_id: databaseId, actor, review: null },
      ],
    });
  const recorded = (overrides = {}) => {
    const context = contextWithRecord(addressedRecord());
    context.workflow.thread_replies = [
      {
        thread_id: "PRRT_1",
        comment_id: 901,
        actor: { id: 555, type: "User" },
        ...overrides,
      },
    ];
    return context;
  };
  // The recorded reply completes: same thread, same comment, same actor.
  assert.deepEqual(
    threadResolutionEligibility(eligibilityLedger(), withReply(901), recorded()),
    { eligible: true, addressed_by: [GATED_HEAD] },
  );
  const cases = [
    ["comment not recorded", withReply(902), recorded()],
    [
      "recorded for another thread",
      withReply(901),
      recorded({ thread_id: "PRRT_OTHER" }),
    ],
    [
      "another actor on the recorded id",
      withReply(901, { id: 556, type: "User", login: "someone" }),
      recorded(),
    ],
    [
      // Never the root: a reply answers the finding, it cannot be the
      // finding. A root that matches a reply record is a forgery, not a
      // reply.
      "recorded id in root position",
      eligibleThread({
        comments: [
          {
            ...eligibleThread().comments[0],
            database_id: 901,
            actor: operator,
          },
        ],
      }),
      recorded(),
    ],
  ];
  for (const [name, thread, context] of cases) {
    assert.deepEqual(
      threadResolutionEligibility(eligibilityLedger(), thread, context),
      { eligible: false, reason: "NOT_CODEX_AUTHORED" },
      name,
    );
  }
});

test("a thread this workflow already resolved once never becomes eligible again", () => {
  const ledger = {
    ...eligibilityLedger(),
    automatic_resolutions: [{ thread_id: "PRRT_1" }],
  };
  assert.deepEqual(
    threadResolutionEligibility(
      ledger,
      eligibleThread(),
      contextWithRecord(addressedRecord()),
    ),
    { eligible: false, reason: "THREAD_PREVIOUSLY_RESOLVED" },
  );
});

test("an outdated diff hunk is not evidence that a finding was addressed", () => {
  // is_outdated says the code moved, not that the finding was answered -- an
  // unrelated edit displaces the hunk just as well as a fix does. It must not
  // stand in for the clean result.
  const outdated = eligibleThread({ is_outdated: true });
  assert.deepEqual(
    threadResolutionEligibility(
      eligibilityLedger(),
      outdated,
      eligibilityContext({ cleanForGatedHead: false }),
    ),
    { eligible: false, reason: "NO_CLEAN_RESULT_FOR_GATED_HEAD" },
  );
  assert.deepEqual(
    threadResolutionEligibility(
      eligibilityLedger(),
      outdated,
      eligibilityContext(),
    ),
    { eligible: false, reason: "FIX_NOT_RECORDED" },
  );
  // Nor is it necessary: with the real evidence in place the flag adds
  // nothing, so an outdated thread is eligible on the same terms as any other.
  assert.deepEqual(
    threadResolutionEligibility(
      eligibilityLedger(),
      outdated,
      contextWithRecord(addressedRecord()),
    ),
    { eligible: true, addressed_by: [GATED_HEAD] },
  );
});

test("the resolution plan surfaces per-thread verdicts and refuses without evidence", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const startedAt = Date.now();

  // Before any observation: the mandated refusal, not an empty plan. An
  // absent collection establishes nothing, so it plans nothing.
  await start(state, startedAt);
  await assert.rejects(
    getThreadResolutionPlan(state.store, state.reviewId),
    (error) => error.code === "PUBLICATION_THREAD_EVIDENCE_MISSING",
  );

  // An openly incomplete collection is recordable by design, and the plan must
  // refuse it through the same code -- this pins the second half of the
  // disjunction, which the first half cannot reach.
  const incompleteAt = startedAt + 1_500;
  const partial = observation({
    at: incompleteAt,
    baseSha: state.baseSha,
    headSha: state.headSha,
    requestId: null,
    requestAt: startedAt,
    withResult: false,
  });
  partial.review_threads.collection.status = "INCOMPLETE";
  await recordGithubSnapshot(
    state.store,
    state.reviewId,
    { expectedRevision: 1, observation: partial },
    { clock: () => incompleteAt + 10 },
  );
  await assert.rejects(
    getThreadResolutionPlan(state.store, state.reviewId),
    (error) => error.code === "PUBLICATION_THREAD_EVIDENCE_MISSING",
  );

  const observedAt = startedAt + 2_000;
  const value = observation({
    at: observedAt,
    baseSha: state.baseSha,
    headSha: state.headSha,
    requestId: null,
    requestAt: startedAt,
    withResult: false,
  });
  const codex = { id: 99, type: "Bot", login: "codex" };
  value.review_threads.total_count = 1;
  value.review_threads.unresolved_count = 1;
  value.review_threads.threads = [
    {
      id: "PRRT_1",
      is_resolved: false,
      is_outdated: false,
      comment_count: 1,
      comments_pagination_complete: true,
      provenance_complete: true,
      comments: [
        {
          id: "PRRC_1",
          database_id: 3694779367,
          created_at: iso(startedAt - 5_000),
          updated_at: iso(startedAt - 5_000),
          actor: codex,
          review: {
            id: "PRR_1",
            database_id: 4833836859,
            state: "COMMENTED",
            reviewed_head_sha: "c".repeat(40),
            actor: codex,
          },
        },
      ],
    },
  ];
  value.review_threads.ancestry = [
    {
      finding_head_sha: "c".repeat(40),
      status: "AHEAD",
      descends: true,
      endpoint: `GET /repos/o/r/compare/${"c".repeat(40)}...${state.headSha}`,
      collected_at: iso(observedAt - 500),
    },
  ];
  await recordGithubSnapshot(
    state.store,
    state.reviewId,
    { expectedRevision: 2, observation: value },
    { clock: () => observedAt + 10 },
  );

  // A v1 publication has no workflow binding, so the plan must carry the
  // thread with a workflow refusal rather than pretend eligibility.
  const plan = await getThreadResolutionPlan(state.store, state.reviewId);
  assert.equal(plan.review_id, state.reviewId);
  assert.equal(plan.threads.length, 1);
  assert.equal(plan.threads[0].thread_id, "PRRT_1");
  assert.equal(plan.threads[0].eligible, false);
  assert.equal(plan.threads[0].reason, "WORKFLOW_NOT_BOUND");
});

test("ledger ancestry exactness and honesty are each load-bearing", async (t) => {
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const startedAt = Date.now();
  await start(state, startedAt);
  const observedAt = startedAt + 1_000;
  const build = (mutate) => {
    const value = observation({
      at: observedAt,
      baseSha: state.baseSha,
      headSha: state.headSha,
      requestId: null,
      requestAt: startedAt,
      withResult: false,
    });
    const codex = { id: 99, type: "Bot", login: "codex" };
    value.review_threads.total_count = 1;
    value.review_threads.unresolved_count = 1;
    value.review_threads.threads = [
      {
        id: "PRRT_1",
        is_resolved: false,
        is_outdated: false,
        comment_count: 1,
        comments_pagination_complete: true,
        provenance_complete: true,
        comments: [
          {
            id: "PRRC_1",
            database_id: 3694779367,
            created_at: iso(startedAt - 5_000),
            updated_at: iso(startedAt - 5_000),
            actor: codex,
            review: {
              id: "PRR_1",
              database_id: 4833836859,
              state: "COMMENTED",
              reviewed_head_sha: "c".repeat(40),
              actor: codex,
            },
          },
        ],
      },
    ];
    value.review_threads.ancestry = [
      {
        finding_head_sha: "c".repeat(40),
        status: "AHEAD",
        descends: true,
        endpoint: `GET /repos/o/r/compare/${"c".repeat(40)}...${state.headSha}`,
        collected_at: iso(observedAt - 500),
      },
    ];
    mutate(value);
    return value;
  };
  const record = (mutate) =>
    recordGithubSnapshot(
      state.store,
      state.reviewId,
      { expectedRevision: 1, observation: build(mutate) },
      { clock: () => observedAt + 10 },
    );

  // A referenced finding head with no compare escapes the descent question.
  await assert.rejects(
    record((value) => {
      value.review_threads.ancestry = [];
    }),
    /missing a referenced finding head/,
  );
  // A compare for a head no thread references is evidence about nothing.
  await assert.rejects(
    record((value) => {
      value.review_threads.ancestry.push({
        finding_head_sha: "d".repeat(40),
        status: "AHEAD",
        descends: true,
        endpoint: `GET /repos/o/r/compare/${"d".repeat(40)}...${state.headSha}`,
        collected_at: iso(observedAt - 500),
      });
    }),
    /covers a head no thread references/,
  );
  // descends is a derivation: asserting it beside a status that denies it is
  // a caller lying about its own evidence.
  await assert.rejects(
    record((value) => {
      value.review_threads.ancestry[0].status = "DIVERGED";
    }),
    /descent disagrees with its status/,
  );
  // Each comparison read participates in time validation on its own: a
  // too-old compare must not ride in under the summary source's fresher
  // time. Here it lands before the ledger's creation, which is the nearest
  // reachable violation in this fixture; removing the per-entry loop accepts
  // this input, so the rejection is the loop's and nothing else's.
  await assert.rejects(
    record((value) => {
      value.review_threads.ancestry[0].collected_at = iso(
        observedAt - 6 * 60_000,
      );
    }),
    /predates publication creation/,
  );
});

test("an unknown review-state spelling fails closed at the ledger", async (t) => {
  // The predicate compares against DISMISSED exactly, so a lowercase or novel
  // state must refuse at admission rather than slide past the dismissal guard.
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const startedAt = Date.now();
  await start(state, startedAt);
  const observedAt = startedAt + 1_000;
  const value = observation({
    at: observedAt,
    baseSha: state.baseSha,
    headSha: state.headSha,
    requestId: null,
    requestAt: startedAt,
    withResult: false,
  });
  const codex = { id: 99, type: "Bot", login: "codex" };
  value.review_threads.total_count = 1;
  value.review_threads.unresolved_count = 1;
  value.review_threads.threads = [
    {
      id: "PRRT_1",
      is_resolved: false,
      is_outdated: false,
      comment_count: 1,
      comments_pagination_complete: true,
      provenance_complete: true,
      comments: [
        {
          id: "PRRC_1",
          database_id: 3694779367,
          created_at: iso(startedAt - 5_000),
          updated_at: iso(startedAt - 5_000),
          actor: codex,
          review: {
            id: "PRR_1",
            database_id: 4833836859,
            state: "dismissed",
            reviewed_head_sha: "c".repeat(40),
            actor: codex,
          },
        },
      ],
    },
  ];
  value.review_threads.ancestry = [
    {
      finding_head_sha: "c".repeat(40),
      status: "AHEAD",
      descends: true,
      endpoint: `GET /repos/o/r/compare/${"c".repeat(40)}...${state.headSha}`,
      collected_at: iso(observedAt - 500),
    },
  ];
  await assert.rejects(
    recordGithubSnapshot(
      state.store,
      state.reviewId,
      { expectedRevision: 1, observation: value },
      { clock: () => observedAt + 10 },
    ),
    /thread review state/,
  );
});

test("a stale ancestry read expires the stored evidence on its own", async (t) => {
  // The summary source carries only the latest compare time, so without the
  // per-entry times in observationTimes a comparison near the age limit would
  // stay alive until its freshest sibling expires -- and its descends value
  // would be trusted for the whole window.
  const state = await fixture();
  t.after(() => fsp.rm(state.root, { recursive: true, force: true }));
  const startedAt = Date.now();
  await start(state, startedAt);
  const observedAt = startedAt + 100_000;
  const value = observation({
    at: observedAt,
    baseSha: state.baseSha,
    headSha: state.headSha,
    requestId: null,
    requestAt: startedAt,
    withResult: false,
  });
  const codex = { id: 99, type: "Bot", login: "codex" };
  value.review_threads.total_count = 1;
  value.review_threads.unresolved_count = 1;
  value.review_threads.threads = [
    {
      id: "PRRT_1",
      is_resolved: false,
      is_outdated: false,
      comment_count: 1,
      comments_pagination_complete: true,
      provenance_complete: true,
      comments: [
        {
          id: "PRRC_1",
          database_id: 3694779367,
          created_at: iso(startedAt - 5_000),
          updated_at: iso(startedAt - 5_000),
          actor: codex,
          review: {
            id: "PRR_1",
            database_id: 4833836859,
            state: "COMMENTED",
            reviewed_head_sha: "c".repeat(40),
            actor: codex,
          },
        },
      ],
    },
  ];
  // The compare is 90 seconds older than every other read.
  value.review_threads.ancestry = [
    {
      finding_head_sha: "c".repeat(40),
      status: "AHEAD",
      descends: true,
      endpoint: `GET /repos/o/r/compare/${"c".repeat(40)}...${state.headSha}`,
      collected_at: iso(observedAt - 90_000),
    },
  ];
  await recordGithubSnapshot(
    state.store,
    state.reviewId,
    { expectedRevision: 1, observation: value },
    { clock: () => observedAt + 10 },
  );
  // Four minutes after the compare was read: the compare is past the five
  // minute limit only if its own time participates. The freshest sources are
  // not, so a summary keyed to them would still call the evidence live.
  const probeAt = observedAt - 90_000 + 5 * 60_000 + 1_000;
  const summary = await getPublicationSummary(state.store, state.reviewId, {
    clock: () => probeAt,
  });
  assert.equal(summary.blocking_reason, "EVIDENCE_STALE");
});
