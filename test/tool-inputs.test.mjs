import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startPublication } from "../src/publication.mjs";
import {
  PUBLICATION_ACTION_INPUTS,
  REVIEW_ACTION_INPUTS,
} from "../src/tool-inputs.mjs";

const serverPath = path.resolve("src/server.mjs");

async function authorTools(t) {
  const store = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-decl-"));
  t.after(() => fsp.rm(store, { recursive: true, force: true }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath, "--role", "author"],
    env: { ...process.env, REVIEW_BRIDGE_HOME: store },
    stderr: "pipe",
  });
  const client = new Client({ name: "review-bridge-test", version: "0.9.0" });
  await client.connect(transport);
  t.after(() => client.close());
  const listed = await client.listTools();
  return new Map(listed.tools.map((tool) => [tool.name, tool]));
}

function declaredCalls() {
  return [REVIEW_ACTION_INPUTS, PUBLICATION_ACTION_INPUTS].flatMap((table) =>
    Object.entries(table).flatMap(([action, calls]) =>
      Object.entries(calls).map(([tool, fields]) => ({ action, tool, fields })),
    ),
  );
}

// The nail against a stale declaration: a transition that gains a required
// argument without this table following it leaves that argument undeclared,
// and a renamed argument leaves a declared name with nothing behind it.
test("every declared call matches the tool schema it names", async (t) => {
  const tools = await authorTools(t);
  const calls = declaredCalls();
  assert.ok(calls.length > 0);
  for (const { action, tool, fields } of calls) {
    const registered = tools.get(tool);
    assert.ok(registered, `${action} declares unregistered tool ${tool}`);
    const declared = fields.map(([field]) => field);
    assert.deepEqual(
      declared.length,
      new Set(declared).size,
      `${action}/${tool} declares a duplicate field`,
    );
    for (const [field, source] of fields) {
      assert.ok(
        Object.hasOwn(registered.inputSchema.properties, field),
        `${action}/${tool} declares unknown field ${field}`,
      );
      assert.ok(
        typeof source === "string" && source.length > 0,
        `${action}/${tool} declares ${field} without a source`,
      );
    }
    for (const required of registered.inputSchema.required ?? []) {
      assert.ok(
        declared.includes(required),
        `${action}/${tool} omits required field ${required}`,
      );
    }
  }
});

test("read-surface tool descriptions point at required_inputs", async (t) => {
  const tools = await authorTools(t);
  for (const name of [
    "get_review_summary",
    "get_publication_summary",
  ]) {
    assert.match(tools.get(name).description, /required_inputs/);
  }
});
// The replacement authorization a spent publication needs: start_publication
// requires a review ID whose ledger does not exist yet, and this one's does.
test("a spent publication declares how its replacement is minted", () => {
  const declared =
    PUBLICATION_ACTION_INPUTS.START_NEW_PUBLICATION_AUTHORIZATION;
  assert.deepEqual(Object.keys(declared), [
    "authorize_remote_publication",
    "start_publication",
  ]);
  assert.match(
    declared.start_publication.find(([field]) => field === "review_id")[1],
    /authorize_remote_publication/,
  );
});

// start_publication requires the acknowledgement pair in automatic mode and
// refuses it in explicit-only mode. Neither rule is visible to a JSON schema,
// so the declaration is checked against the transition itself.
test("declared start_publication inputs carry the acknowledgement pair", async (t) => {
  const store = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-decl-"));
  t.after(() => fsp.rm(store, { recursive: true, force: true }));
  const declared = new Set(
    REVIEW_ACTION_INPUTS.PUBLISH.start_publication.map(([field]) => field),
  );
  assert.ok(declared.has("operator_label"));
  assert.ok(declared.has("rationale"));

  // The publication lock is taken on the review directory before any argument
  // is validated, so the directory has to exist for these refusals to be the
  // ones under test.
  const reviewId = "rb-2026-07-26T000000-000Z-deadbeef";
  const reviewRoot = path.join(store, "reviews", reviewId);
  await fsp.mkdir(reviewRoot, { recursive: true, mode: 0o700 });
  await fsp.writeFile(
    path.join(reviewRoot, "review.json"),
    `${JSON.stringify({ id: reviewId, status: "LOCAL_GATE_PASSED", current_round: 1 })}\n`,
    { mode: 0o600 },
  );

  const start = (overrides) =>
    startPublication(store, {
      reviewId,
      repositoryId: 11,
      owner: "owner",
      repo: "repo",
      prNumber: 7,
      baseBranch: "main",
      headBranch: "topic",
      codexActorId: 99,
      codexActorType: "Bot",
      codexActorLogin: "codex[bot]",
      codexTriggerMode: "AUTOMATIC_QUIESCENCE_ACKNOWLEDGED",
      baseline: {},
      ...overrides,
    });

  await assert.rejects(
    () => start({ rationale: "why" }),
    /operator_label/,
    "automatic mode must still demand the declared operator_label",
  );
  await assert.rejects(
    () => start({ operatorLabel: "jeremyhi" }),
    /rationale/,
    "automatic mode must still demand the declared rationale",
  );
  // Supplying both gets past the acknowledgement gate; the call still fails on
  // the absent review, which is what proves the gate was cleared.
  await assert.rejects(
    () => start({ operatorLabel: "jeremyhi", rationale: "why" }),
    (error) => !/operator_label|rationale/.test(error.message),
  );
  // The same pair is refused in explicit-only mode, which is why the
  // declaration states the condition instead of listing them unconditionally.
  await assert.rejects(
    () =>
      start({
        codexTriggerMode: "EXPLICIT_ONLY",
        operatorLabel: "jeremyhi",
        rationale: "why",
      }),
    /explicit-only mode cannot include an acknowledgement/,
  );
});

test("the continuation declaration lets a CODEX_TASK source omit reviewer_provider", () => {
  assert.match(
    REVIEW_ACTION_INPUTS.ADDRESS_LOCAL_FINDINGS.prepare_review.find(
      ([field]) => field === "reviewer_provider",
    )[1],
    /^reviewer_provider; may be omitted when it is CODEX_TASK$/,
  );
});
