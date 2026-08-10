import assert from "node:assert/strict";
import test from "node:test";
import { threadActionExecutingProof } from "../src/server-input.mjs";

test("thread executing proof preserves the pull request identity for unresolve", () => {
  assert.deepEqual(
    threadActionExecutingProof({
      thread_id: "PRRT_1",
      is_resolved: true,
      thread_watermark: "watermark-2",
      pr_repository_id: 101,
      pr_number: 36,
    }),
    {
      thread_id: "PRRT_1",
      is_resolved: true,
      thread_watermark: "watermark-2",
      repository_id: 101,
      pr_number: 36,
    },
  );
});

test("ordinary thread resolution proof does not invent a pull request identity", () => {
  assert.deepEqual(
    threadActionExecutingProof({
      thread_id: "PRRT_1",
      is_resolved: false,
      thread_watermark: "watermark-1",
    }),
    {
      thread_id: "PRRT_1",
      is_resolved: false,
      thread_watermark: "watermark-1",
    },
  );
});
