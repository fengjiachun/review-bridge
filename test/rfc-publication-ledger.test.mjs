import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const RFC_URL = new URL(
  "../docs/rfcs/0001-github-publication-ledger.md",
  import.meta.url,
);

function maxTimestamp(items) {
  return items.map((item) => item.collected_at).sort().at(-1);
}

function collectionTimes(collection) {
  const sources = [
    ...(collection.sources ?? []),
    ...(collection.policy_sources ?? []),
    ...(collection.run_sources ?? []),
  ];
  return [collection.collected_at, ...sources.map((source) => source.collected_at)];
}

function canonicalizeJson(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeJson).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalizeJson(value[key])}`)
    .join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("publication ledger RFC JSON examples are internally consistent", async () => {
  const markdown = await readFile(RFC_URL, "utf8");
  const examples = [...markdown.matchAll(/```json\n([\s\S]*?)\n```/g)].map(
    (match) => JSON.parse(match[1]),
  );

  assert.equal(examples.length, 11);
  const [
    ledger,
    clearedObservationEvent,
    unsupportedExample,
    baselineReplayExample,
    permissionProof,
    terminalExample,
    acknowledgement,
    verification,
    gate,
    gateAudit,
    gateAuditHead,
  ] = examples;
  const observation = ledger.latest_observation;
  const baselineCollection = ledger.codex_review_baseline.collection;
  const codexCollection = observation.codex_review.collection;
  const statusTable = markdown.slice(
    markdown.indexOf("| Status | Sticky | Meaning |"),
    markdown.indexOf("In a separate invalidation scenario"),
  );
  assert.ok(
    statusTable.indexOf("`PR_UPDATE_REQUIRED`") <
      statusTable.indexOf("`CHECKS_PENDING`"),
  );
  assert.ok(
    statusTable.indexOf("`GITHUB_REVIEW_UNKNOWN`") <
      statusTable.indexOf("`GITHUB_REVIEW_NOT_REQUESTED`"),
  );

  assert.equal(ledger.updated_at, observation.recorded_at);
  assert.deepEqual(
    ledger.history.map((entry) => entry.revision),
    [1, 2, 3],
  );
  assert.equal(ledger.history.at(-1).revision, ledger.revision);
  assert.equal(ledger.history.at(-1).at, observation.recorded_at);
  assert.equal(
    ledger.history.find(
      (entry) => entry.event === "CODEX_REVIEW_REQUEST_RECORDED",
    ).cleared_observation_sha256,
    null,
  );
  assert.equal(clearedObservationEvent.event, "CODEX_REVIEW_REQUEST_RECORDED");
  assert.match(
    clearedObservationEvent.cleared_observation_sha256,
    /^[0-9a-f]{64}$/,
  );
  assert.equal(ledger.target.codex_actor.type, "Bot");
  assert.deepEqual(ledger.target.codex_trigger_policy, {
    mode: "EXPLICIT_ONLY",
    operator_label: null,
    rationale: null,
    acknowledged_at: null,
  });
  assert.equal(unsupportedExample.unsupported_requests.length, 1);
  assert.equal(
    unsupportedExample.unsupported_requests[0].reason,
    "WRONG_RESOURCE_KIND",
  );
  assert.equal(permissionProof.result, "SUCCESS");
  assert.equal(permissionProof.credential_type, "GITHUB_APP");
  assert.equal(terminalExample.status, "INVALIDATED");
  assert.deepEqual(acknowledgement.request_refs, acknowledgement.closed_requests);
  assert.deepEqual(
    acknowledgement.ambiguous_results,
    acknowledgement.closed_results,
  );
  assert.equal(baselineCollection.adapter_version, 1);
  assert.equal(codexCollection.adapter_version, 1);
  assert.equal(ledger.codex_review_baseline.requests.length, 0);
  assert.equal(ledger.codex_review_baseline.candidate_results.length, 0);
  assert.deepEqual(
    observation.codex_review.preexisting_requests,
    ledger.codex_review_baseline.requests,
  );
  assert.deepEqual(
    observation.codex_review.preexisting_candidate_results,
    ledger.codex_review_baseline.candidate_results,
  );
  assert.equal(observation.codex_review.requests[0].body, "@codex review");
  assert.match(baselineReplayExample.schema_valid_head_sha, /^[0-9a-f]{40}$/);
  const { classification, reason, ...storedBaselineFacts } =
    baselineReplayExample.stored_baseline_request;
  assert.equal(classification, "BASELINE_EXACT");
  assert.equal(reason, null);
  assert.deepEqual(
    baselineReplayExample.adapter_preexisting_request,
    storedBaselineFacts,
  );

  const request = observation.codex_review.requests[0];
  const requestHistory = ledger.codex_request_history[0];
  assert.equal(requestHistory.resource_id, request.comment_id);
  for (const key of [
    "resource_kind",
    "url",
    "event_at",
    "timestamp_field",
    "body_sha256",
    "requested_head_sha",
  ]) {
    assert.deepEqual(requestHistory[key], request[key], key);
  }
  assert.equal(requestHistory.classification, "RECOGNIZED");
  assert.equal(requestHistory.binding_source, "RECORDED_AT_POST");

  const result = observation.codex_review.results[0];
  const resultHistory = ledger.codex_result_history[0];
  assert.equal(result.resource_kind, "ISSUE_COMMENT");
  assert.equal(result.native_review_state, null);
  assert.equal(result.format, "CODEX_CLEAN_COMMENT_V1");
  assert.deepEqual(result.request_ref, {
    resource_kind: "ISSUE_COMMENT",
    resource_id: observation.codex_review.requests[0].comment_id,
  });
  assert.equal(
    result.commit_binding.source,
    "CODEX_REVIEWED_COMMIT_PREFIX_AND_REQUEST_HEAD",
  );
  assert.equal(result.reviewed_head_sha, ledger.local_gate.head_sha);
  assert.equal(
    observation.codex_review.requests[0].requested_head_sha,
    ledger.local_gate.head_sha,
  );
  assert.match(result.commit_binding.prefix, /^[0-9a-f]{10,40}$/);
  assert.ok(result.reviewed_head_sha.startsWith(result.commit_binding.prefix));

  for (const key of [
    "result_id",
    "resource_kind",
    "native_review_state",
    "url",
    "event_at",
    "timestamp_field",
    "reviewed_head_sha",
    "attached_review_comments",
    "body_sha256",
  ]) {
    assert.deepEqual(resultHistory[key], result[key], key);
  }
  assert.deepEqual(resultHistory.actor, {
    id: result.actor.id,
    type: result.actor.type,
  });
  assert.deepEqual(resultHistory.commit_binding, result.commit_binding);

  const runCounts = new Map();
  for (const run of observation.required_checks.runs) {
    runCounts.set(run.run_kind, (runCounts.get(run.run_kind) ?? 0) + 1);
  }
  for (const source of observation.required_checks.collection.run_sources) {
    assert.equal(source.item_count, runCounts.get(source.kind) ?? 0);
    if (source.kind === "CHECK_RUN") {
      assert.equal(source.reported_total_count, source.item_count);
    } else {
      assert.equal(source.reported_total_count, null);
    }
  }
  assert.equal(
    observation.required_checks.requirements[0].binding_sources[0]
      .raw_representation,
    "POSITIVE_INTEGER",
  );
  const pullRequestBranchSource =
    observation.pull_request.collection.sources.find(
      (source) => source.kind === "BASE_BRANCH_METADATA",
    );
  const policyBranchSource =
    observation.required_checks.collection.policy_sources.find(
      (source) => source.kind === "BRANCH_METADATA",
    );
  assert.notEqual(
    observation.pull_request.base_sha,
    observation.pull_request.pr_reported_base_sha,
  );
  assert.equal(
    observation.pull_request.base_sha,
    pullRequestBranchSource.branch_tip_sha,
  );
  assert.equal(
    observation.pull_request.base_sha,
    policyBranchSource.branch_tip_sha,
  );
  assert.ok(
    Date.parse(pullRequestBranchSource.collected_at) <
      Date.parse(policyBranchSource.collected_at),
  );
  assert.equal(
    observation.pull_request.base_head_comparison.base_sha,
    observation.pull_request.base_sha,
  );
  assert.equal(
    observation.pull_request.base_head_comparison.head_sha,
    observation.pull_request.head_sha,
  );
  assert.equal(
    observation.pull_request.reviewed_base_current_base_comparison.base_sha,
    ledger.local_gate.base_sha,
  );
  assert.equal(
    observation.pull_request.reviewed_base_current_base_comparison.head_sha,
    observation.pull_request.base_sha,
  );

  const collections = [
    baselineCollection,
    observation.pull_request.collection,
    observation.required_checks.collection,
    codexCollection,
    observation.review_threads.collection,
  ];
  for (const collection of collections) {
    const sources = [
      ...(collection.sources ?? []),
      ...(collection.policy_sources ?? []),
      ...(collection.run_sources ?? []),
    ];
    assert.equal(collection.collected_at, maxTimestamp(sources));
    for (const source of sources) {
      assert.equal(typeof source.kind, "string");
      assert.equal("resource_kind" in source, false);
    }
  }

  const latestCollections = collections.slice(1);
  const latestTimes = latestCollections.flatMap(collectionTimes).sort();
  const observedAt = Date.parse(observation.observed_at);
  for (const timestamp of latestTimes) {
    const collectedAt = Date.parse(timestamp);
    assert.ok(collectedAt >= Date.parse(ledger.created_at));
    assert.ok(collectedAt <= observedAt);
    assert.ok(observedAt - collectedAt <= 2 * 60 * 1000);
  }
  assert.ok(
    Date.parse(latestTimes.at(-1)) - Date.parse(latestTimes[0]) <=
      2 * 60 * 1000,
  );

  assert.equal(gate.github_oldest_collection_at, latestTimes[0]);
  const expiryInputs = [
    observation.recorded_at,
    observation.observed_at,
    ...latestTimes,
  ];
  const expectedExpiry = new Date(
    Math.min(...expiryInputs.map(Date.parse)) + 5 * 60 * 1000,
  ).toISOString();
  assert.equal(gate.expires_at, expectedExpiry);
  assert.equal(verification.expires_at, expectedExpiry);
  assert.ok(Date.parse(gate.passed_at) >= Date.parse(observation.recorded_at));
  assert.ok(Date.parse(gate.passed_at) <= Date.parse(verification.verified_at));
  assert.ok(Date.parse(gate.passed_at) <= Date.parse(gate.expires_at));
  assert.equal(gate.status, "MERGE_READY");
  assert.equal(ledger.status, gate.status);
  assert.equal(gate.issuance_committed, true);
  assert.equal(gate.publication_revision, ledger.revision);
  assert.equal(verification.publication_revision, ledger.revision);
  assert.equal(verification.valid, true);
  assert.equal(verification.status, gate.status);
  assert.equal(verification.head_sha, gate.head_sha);
  assert.equal(gate.head_sha, ledger.local_gate.head_sha);
  assert.equal(gate.head_sha, observation.pull_request.head_sha);
  assert.equal(gate.repository_id, ledger.target.repository_id);
  assert.equal(gate.pr_number, ledger.target.pr_number);
  assert.equal(gateAudit.review_id, ledger.review_id);
  assert.deepEqual(
    gateAudit.events.map((event) => [event.sequence, event.event]),
    [
      [1, "GATE_FINALIZATION_PASSED"],
      [2, "GATE_VERIFIED"],
    ],
  );
  assert.equal(
    new Set(gateAudit.events.map((event) => event.event_id)).size,
    gateAudit.events.length,
  );
  for (const event of gateAudit.events) {
    assert.equal(event.version, gateAudit.version);
    assert.equal(event.review_id, gateAudit.review_id);
    assert.match(event.event_id, /^[0-9a-f]{32}$/);
    assert.equal(event.outcome, "SUCCESS");
    assert.equal(event.normalized_reason, null);
    assert.equal(event.publication_revision, ledger.revision);
    assert.equal(event.head_sha, gate.head_sha);
    assert.equal(event.expires_at, gate.expires_at);
    assert.equal(
      event.github_observation_sha256,
      gate.github_observation_sha256,
    );
  }
  assert.equal(gateAudit.events[0].at, gate.passed_at);
  assert.equal(gateAudit.events[1].at, verification.verified_at);
  assert.equal(gateAudit.events[0].previous_event_sha256, null);
  const auditLines = gateAudit.events.map(canonicalizeJson);
  assert.equal(gateAudit.version, gateAuditHead.version);
  assert.equal(gateAudit.review_id, gateAuditHead.review_id);
  assert.equal(gateAuditHead.next_sequence, gateAudit.events.at(-1).sequence + 1);
  assert.match(gateAuditHead.last_event_sha256, /^[0-9a-f]{64}$/);
  assert.equal(
    gateAudit.events[1].previous_event_sha256,
    sha256(auditLines[0]),
  );
  assert.equal(gateAuditHead.last_event_sha256, sha256(auditLines.at(-1)));
  assert.equal(
    gateAuditHead.committed_bytes,
    Buffer.byteLength(`${auditLines.join("\n")}\n`),
  );
  assert.equal(
    gateAudit.events[0].gate_sha256,
    gateAudit.events[1].gate_sha256,
  );
});
