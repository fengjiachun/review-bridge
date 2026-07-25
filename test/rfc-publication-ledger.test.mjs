import assert from "node:assert/strict";
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

test("publication ledger RFC JSON examples are internally consistent", async () => {
  const markdown = await readFile(RFC_URL, "utf8");
  const examples = [...markdown.matchAll(/```json\n([\s\S]*?)\n```/g)].map(
    (match) => JSON.parse(match[1]),
  );

  assert.equal(examples.length, 7);
  const [
    ledger,
    unsupportedExample,
    permissionProof,
    terminalExample,
    acknowledgement,
    verification,
    gate,
  ] = examples;
  const observation = ledger.latest_observation;
  const baselineCollection = ledger.codex_review_baseline.collection;
  const codexCollection = observation.codex_review.collection;

  assert.equal(ledger.updated_at, observation.recorded_at);
  assert.deepEqual(
    ledger.history.map((entry) => entry.revision),
    [1, 2, 3],
  );
  assert.equal(ledger.history.at(-1).revision, ledger.revision);
  assert.equal(ledger.history.at(-1).at, observation.recorded_at);
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
  assert.equal("excluded_request_pairs" in ledger.codex_review_baseline, false);
  assert.deepEqual(
    observation.codex_review.preexisting_requests,
    ledger.codex_review_baseline.requests,
  );
  assert.deepEqual(
    observation.codex_review.preexisting_candidate_results,
    ledger.codex_review_baseline.candidate_results,
  );
  assert.equal(observation.codex_review.requests[0].body, "@codex review");

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
    runCounts.set(run.resource_kind, (runCounts.get(run.resource_kind) ?? 0) + 1);
  }
  for (const source of observation.required_checks.collection.run_sources) {
    assert.equal(source.item_count, runCounts.get(source.resource_kind) ?? 0);
    if (source.resource_kind === "CHECK_RUN") {
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
  assert.equal(gate.publication_revision, ledger.revision);
  assert.equal(verification.publication_revision, ledger.revision);
});
