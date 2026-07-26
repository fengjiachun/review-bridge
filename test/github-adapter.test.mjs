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
