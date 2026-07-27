import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  adaptCodexEvidence,
  githubAdapterVersion,
} from "../src/github-adapter.mjs";

async function fixture(name) {
  return JSON.parse(
    await readFile(
      new URL(`./fixtures/github/${name}.json`, import.meta.url),
      "utf8",
    ),
  );
}

function requestBody(requestId) {
  return [
    "@codex review",
    "",
    "When you finish, append exactly this marker to the review summary:",
    `<!-- review-bridge-request-id: ${requestId} -->`,
  ].join("\n");
}

function withRequestMarker(body, requestId) {
  return `${body}\n\n<!-- review-bridge-request-id: ${requestId} -->`;
}

function digest(body) {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

test("version 1 adapter recognizes the observed clean issue-comment shape", async () => {
  const result = adaptCodexEvidence(await fixture("codex-clean"));
  assert.equal(githubAdapterVersion, 2);
  assert.equal(result.collection.adapter_version, 1);
  assert.equal(result.requests.length, 1);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].format, "CODEX_CLEAN_COMMENT_V1");
  assert.equal(result.results[0].verdict, "CLEAN");
  assert.equal(result.results[0].association, "SINGLE_OPEN_REQUEST");
  assert.equal(
    result.results[0].reviewed_head_sha,
    "e059e4f846e9e55890dc44e656ed653431d812d5",
  );
});

test("version 2 adapter binds a clean result by request ID and exact head", async () => {
  const input = await fixture("codex-clean");
  const requestId = `rbreq-${"1".repeat(32)}`;
  const body = requestBody(requestId);
  input.adapter_version = 2;
  input.issue_comments[0].body = body;
  input.issue_comments[1].body = withRequestMarker(
    input.issue_comments[1].body,
    requestId,
  );
  input.request_history[0].request_id = requestId;
  input.request_history[0].body_sha256 = digest(body);

  const result = adaptCodexEvidence(input);
  assert.equal(result.collection.adapter_version, 2);
  assert.equal(result.requests[0].request_id, requestId);
  assert.equal(result.results[0].request_id, requestId);
  assert.equal(result.results[0].association, "CORRELATED_REQUEST_ID");
  assert.equal(result.results[0].format, "CODEX_CLEAN_COMMENT_V2");
  assert.equal(result.results[0].verdict, "CLEAN");
});

test("version 2 keeps a delayed predecessor result out of the active request", async () => {
  const input = await fixture("codex-clean");
  const oldRequestId = `rbreq-${"1".repeat(32)}`;
  const activeRequestId = `rbreq-${"2".repeat(32)}`;
  const oldRequestBody = requestBody(oldRequestId);
  const activeRequestBody = requestBody(activeRequestId);
  const oldRequest = {
    id: 90,
    html_url: "https://github.com/fengjiachun/review-bridge/pull/6#issuecomment-90",
    created_at: "2026-07-25T23:07:00Z",
    body: oldRequestBody,
    user: {
      id: 3860496,
      type: "User",
      login: "fengjiachun",
    },
  };
  const delayedResult = {
    ...structuredClone(input.issue_comments[1]),
    id: 91,
    html_url: "https://github.com/fengjiachun/review-bridge/pull/6#issuecomment-91",
    created_at: "2026-07-25T23:10:22Z",
    body: withRequestMarker(input.issue_comments[1].body, oldRequestId),
  };

  input.adapter_version = 2;
  input.baseline.requests = [
    {
      resource_id: oldRequest.id,
      resource_kind: "ISSUE_COMMENT",
      url: oldRequest.html_url,
      event_at: "2026-07-25T23:07:00.000Z",
      timestamp_field: "created_at",
      body_sha256: digest(oldRequestBody),
      request_id: oldRequestId,
      actor: { id: 3860496, type: "User" },
      classification: "BASELINE_CORRELATED",
      reason: null,
    },
  ];
  input.issue_comments[0].body = activeRequestBody;
  input.issue_comments[1].body = withRequestMarker(
    input.issue_comments[1].body,
    activeRequestId,
  );
  input.issue_comments.unshift(oldRequest);
  input.issue_comments.splice(2, 0, delayedResult);
  input.request_history[0].request_id = activeRequestId;
  input.request_history[0].body_sha256 = digest(activeRequestBody);

  const result = adaptCodexEvidence(input);
  const oldResult = result.results.find((item) => item.result_id === 91);
  const activeResult = result.results.find(
    (item) => item.result_id === 5080972188,
  );
  assert.equal(oldResult.request_id, oldRequestId);
  assert.equal(oldResult.association, "BASELINE_LATE_RESULT");
  assert.equal(oldResult.verdict, "UNKNOWN");
  assert.equal(activeResult.request_id, activeRequestId);
  assert.equal(activeResult.association, "CORRELATED_REQUEST_ID");
  assert.equal(activeResult.verdict, "CLEAN");
});

test("version 2 rejects a clean result that omits the request ID", async () => {
  const input = await fixture("codex-clean");
  const requestId = `rbreq-${"1".repeat(32)}`;
  const body = requestBody(requestId);
  input.adapter_version = 2;
  input.issue_comments[0].body = body;
  input.request_history[0].request_id = requestId;
  input.request_history[0].body_sha256 = digest(body);

  const result = adaptCodexEvidence(input);
  assert.equal(result.results[0].request_id, null);
  assert.equal(result.results[0].association, "AMBIGUOUS");
  assert.equal(result.results[0].format, "UNKNOWN");
  assert.equal(result.results[0].verdict, "UNKNOWN");
});

test("version 2 binds findings by request ID and native review commit", async () => {
  const input = await fixture("codex-findings");
  const requestId = `rbreq-${"1".repeat(32)}`;
  const body = requestBody(requestId);
  input.adapter_version = 2;
  input.issue_comments[0].body = body;
  input.pull_request_reviews[0].body = withRequestMarker(
    input.pull_request_reviews[0].body,
    requestId,
  );
  input.request_history[0].request_id = requestId;
  input.request_history[0].body_sha256 = digest(body);

  const result = adaptCodexEvidence(input);
  assert.equal(result.results[0].request_id, requestId);
  assert.equal(result.results[0].association, "CORRELATED_REQUEST_ID");
  assert.equal(result.results[0].format, "CODEX_FINDINGS_REVIEW_V2");
  assert.equal(result.results[0].verdict, "FINDINGS");
});

test("version 2 rejects duplicate results for one request ID", async () => {
  const input = await fixture("codex-clean");
  const requestId = `rbreq-${"1".repeat(32)}`;
  const body = requestBody(requestId);
  input.adapter_version = 2;
  input.issue_comments[0].body = body;
  input.issue_comments[1].body = withRequestMarker(
    input.issue_comments[1].body,
    requestId,
  );
  input.request_history[0].request_id = requestId;
  input.request_history[0].body_sha256 = digest(body);
  input.issue_comments.push({
    ...structuredClone(input.issue_comments[1]),
    id: input.issue_comments[1].id + 1,
    created_at: "2026-07-25T23:10:24Z",
  });

  const result = adaptCodexEvidence(input);
  assert.equal(result.results[0].association, "CORRELATED_REQUEST_ID");
  assert.equal(result.results[1].association, "AMBIGUOUS");
});

test("adapter accepts the authorization head and rejects conflicting legacy input", async () => {
  const input = await fixture("codex-clean");
  input.authorization_head_sha = input.local_gate_head_sha;
  delete input.local_gate_head_sha;
  assert.equal(adaptCodexEvidence(input).results.length, 1);

  input.local_gate_head_sha = "f".repeat(40);
  assert.throws(
    () => adaptCodexEvidence(input),
    /authorization_head_sha and local_gate_head_sha must match/,
  );
});

test("version 1 adapter recognizes findings only with native commit and attachments", async () => {
  const input = await fixture("codex-findings");
  const result = adaptCodexEvidence(input);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].format, "CODEX_FINDINGS_REVIEW_V1");
  assert.equal(result.results[0].verdict, "FINDINGS");
  assert.equal(result.results[0].attached_review_comments.length, 1);

  input.pull_request_review_comments[0].commit_id = "f".repeat(40);
  const mismatched = adaptCodexEvidence(input);
  assert.equal(mismatched.results[0].format, "UNKNOWN");
  assert.equal(mismatched.results[0].verdict, "UNKNOWN");
});

test("manual and trigger-shaped requests remain unbound or unsupported", async () => {
  const input = await fixture("codex-clean");
  input.request_history = [];
  input.issue_comments[0].body = "@CODEX   REVIEW please";
  const result = adaptCodexEvidence(input);
  assert.equal(result.requests.length, 0);
  assert.equal(result.unbound_requests.length, 0);
  assert.equal(result.unsupported_requests.length, 1);
  assert.equal(
    result.unsupported_requests[0].reason,
    "NON_EXACT_TRIGGER_SHAPE",
  );
});

test("an expected-actor pending formal review makes the collection incomplete", async () => {
  const input = await fixture("codex-findings");
  input.pull_request_reviews[0].state = "PENDING";
  input.pull_request_reviews[0].submitted_at = null;
  const result = adaptCodexEvidence(input);
  assert.equal(result.collection.status, "INCOMPLETE");
  assert.deepEqual(result.results, []);
});

test("incomplete foreign objects do not block normalization", async () => {
  const input = await fixture("codex-clean");
  const deletedActorComment = structuredClone(input.issue_comments[1]);
  deletedActorComment.id += 1;
  deletedActorComment.user = null;
  input.issue_comments.push(deletedActorComment);

  const findings = await fixture("codex-findings");
  const pendingForeignReview = structuredClone(
    findings.pull_request_reviews[0],
  );
  pendingForeignReview.id += 1;
  pendingForeignReview.state = "PENDING";
  pendingForeignReview.submitted_at = null;
  pendingForeignReview.user.id += 1;
  input.pull_request_reviews.push(pendingForeignReview);

  const snapshot = adaptCodexEvidence(input);
  assert.equal(snapshot.collection.status, "COMPLETE");
  assert.equal(snapshot.results.length, 1);
  assert.deepEqual(snapshot.foreign_actor_objects, []);

  input.mode = "BASELINE";
  const baseline = adaptCodexEvidence(input);
  assert.equal(baseline.collection.status, "COMPLETE");
  assert.equal(baseline.requests.length, 1);
  assert.equal(baseline.candidate_results.length, 1);
});

test("deleted-user requests remain visible and make the baseline incomplete", async () => {
  const input = await fixture("codex-clean");
  input.issue_comments[0].user = null;

  const recognized = adaptCodexEvidence(input);
  assert.equal(recognized.requests.length, 1);

  input.request_history = [];
  const triggerShaped = structuredClone(input.issue_comments[0]);
  triggerShaped.id += 1;
  triggerShaped.body = "@CODEX   REVIEW please";
  input.issue_comments.push(triggerShaped);
  const snapshot = adaptCodexEvidence(input);
  assert.equal(snapshot.collection.status, "COMPLETE");
  assert.equal(snapshot.unbound_requests.length, 1);
  assert.equal(snapshot.unsupported_requests.length, 1);
  assert.equal("actor" in snapshot.unbound_requests[0], false);
  assert.equal("actor" in snapshot.unsupported_requests[0], false);

  const missingTimestamp = structuredClone(input);
  missingTimestamp.issue_comments[0].created_at = null;
  const incomplete = adaptCodexEvidence(missingTimestamp);
  assert.equal(incomplete.collection.status, "INCOMPLETE");

  input.mode = "BASELINE";
  const baseline = adaptCodexEvidence(input);
  assert.equal(baseline.collection.status, "INCOMPLETE");
  assert.deepEqual(baseline.requests, []);
  assert.equal(baseline.candidate_results.length, 1);
});

test("incomplete expected-actor results remain invalid", async () => {
  const input = await fixture("codex-findings");
  input.pull_request_reviews[0].submitted_at = null;
  assert.throws(
    () => adaptCodexEvidence(input),
    /submitted_at is not a valid timestamp/,
  );
});

test("baseline mode keeps preexisting triggers and candidate results unpaired", async () => {
  const input = await fixture("codex-clean");
  input.mode = "BASELINE";
  const result = adaptCodexEvidence(input);
  assert.equal(result.requests.length, 1);
  assert.equal(result.candidate_results.length, 1);
  assert.equal("classification" in result.requests[0], false);
  assert.equal("association" in result.candidate_results[0], false);
  assert.deepEqual(result.candidate_results[0].actor, {
    id: 199175422,
    type: "Bot",
  });
});

test("generic expected-actor responses remain UNKNOWN instead of disappearing", async () => {
  const input = await fixture("codex-findings");
  input.pull_request_reviews[0].body = "Review completed without a recognized format.";
  input.pull_request_review_comments = [];
  const result = adaptCodexEvidence(input);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].format, "UNKNOWN");
  assert.equal(result.results[0].verdict, "UNKNOWN");
});

test("version 2 baseline keeps request_id on generic expected-actor results", async () => {
  const input = await fixture("codex-findings");
  input.adapter_version = 2;
  input.mode = "BASELINE";
  input.pull_request_reviews[0].body = "Review completed without a recognized format.";
  input.pull_request_review_comments = [];
  const result = adaptCodexEvidence(input);
  assert.equal(result.candidate_results.length, 1);
  assert.equal(result.candidate_results[0].request_id, null);
});

test("clean comment recognition rejects marker and actor lookalikes", async () => {
  const input = await fixture("codex-clean");
  const cleanBody = input.issue_comments[1].body;
  for (const body of [
    cleanBody.replace(/\n\n\*\*Reviewed commit:[\s\S]*/, ""),
    `${cleanBody}\n\n**Reviewed commit:** \`e059e4f846\``,
    cleanBody.replace("e059e4f846", "fffffffffff"),
  ]) {
    const candidate = structuredClone(input);
    candidate.issue_comments[1].body = body;
    const result = adaptCodexEvidence(candidate);
    assert.equal(result.results[0].format, "UNKNOWN");
    assert.equal(result.results[0].verdict, "UNKNOWN");
  }

  const foreign = structuredClone(input);
  foreign.issue_comments[1].user.id += 1;
  const result = adaptCodexEvidence(foreign);
  assert.equal(result.results.length, 0);
  assert.equal(result.foreign_actor_objects.length, 1);
});

test("request and result ordering is resource-kind scoped", async () => {
  const input = await fixture("codex-clean");
  input.issue_comments[1].created_at =
    input.issue_comments[0].created_at;
  input.issue_comments[1].id = input.issue_comments[0].id - 1;
  const before = adaptCodexEvidence(input);
  assert.equal(before.results[0].association, "UNSOLICITED");

  const tied = await fixture("codex-findings");
  tied.pull_request_reviews[0].submitted_at =
    tied.issue_comments[0].created_at;
  const ambiguous = adaptCodexEvidence(tied);
  assert.equal(ambiguous.results[0].association, "AMBIGUOUS");
});

test("a head-incompatible result remains ambiguous while a request is open", async () => {
  const input = await fixture("codex-clean");
  input.issue_comments[1].body = input.issue_comments[1].body.replace(
    "e059e4f846",
    "fffffffffff",
  );
  const result = adaptCodexEvidence(input);
  assert.equal(result.results[0].association, "AMBIGUOUS");
  assert.equal(result.results[0].request_ref, null);
});
