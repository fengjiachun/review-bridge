import assert from "node:assert/strict";
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

test("version 1 adapter recognizes the observed clean issue-comment shape", async () => {
  const result = adaptCodexEvidence(await fixture("codex-clean"));
  assert.equal(githubAdapterVersion, 1);
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
