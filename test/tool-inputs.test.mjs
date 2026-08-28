import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { executingProof } from "../src/server-input.mjs";
import {
  DECLARATION_TABLES,
  WORKFLOW_ACTION_INPUTS,
  WORKFLOW_STOP_INPUTS,
  workflowRequiredInputs,
} from "../src/tool-inputs.mjs";
import { ACTION_KIND_SPECS } from "../src/workflow.mjs";

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
  return DECLARATION_TABLES.flatMap((table) =>
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
    "get_autonomous_workflow_summary",
    "list_autonomous_workflows",
  ]) {
    assert.match(tools.get(name).description, /required_inputs/);
  }
});

// The flat tool arguments a declaration names, with values a matching action
// target and workflow carry, so the pre-read shape can be built from the
// declaration alone.
const EXECUTING_PROOF_CASES = {
  PUSH_TOPIC_BRANCH: {
    kind: "PUSH_TOPIC_BRANCH",
    target: { head_repository_id: 11, remote_url: "https://example/x.git" },
    workflow: { pull_request: { pr_number: 7 } },
    args: {
      resolved_repository_id: 11,
      resolved_url: "https://example/x.git",
      pull_request_is_draft: true,
    },
  },
  RESOLVE_REVIEW_THREAD: {
    kind: "RESOLVE_REVIEW_THREAD",
    target: { thread_id: "PRRT_1", thread_watermark: "w-1" },
    workflow: {},
    args: { thread_id: "PRRT_1", is_resolved: false, thread_watermark: "w-1" },
  },
  UNRESOLVE_REVIEW_THREAD: {
    kind: "UNRESOLVE_REVIEW_THREAD",
    target: {
      repository_id: 11,
      pr_number: 7,
      thread_id: "PRRT_1",
      new_watermark: "w-2",
    },
    workflow: {},
    args: {
      thread_id: "PRRT_1",
      is_resolved: true,
      thread_watermark: "w-2",
      pr_repository_id: 11,
      pr_number: 7,
    },
  },
  RETURN_PR_TO_DRAFT: {
    kind: "RETURN_PR_TO_DRAFT",
    target: {
      repository_id: 11,
      pr_number: 7,
      base_branch: "main",
      head_branch: "topic",
    },
    workflow: {},
    args: {
      pr_repository_id: 11,
      pr_number: 7,
      base_branch: "main",
      head_branch: "topic",
      is_draft: false,
    },
  },
  MARK_PR_READY: {
    kind: "MARK_PR_READY",
    target: {
      repository_id: 11,
      pr_number: 7,
      base_branch: "main",
      head_branch: "topic",
      head_sha: "a".repeat(40),
    },
    workflow: {},
    args: {
      pr_repository_id: 11,
      pr_number: 7,
      base_branch: "main",
      head_branch: "topic",
      head_sha: "a".repeat(40),
      is_draft: true,
    },
  },
};

const ACTION_ENVELOPE = ["workflow_id", "expected_revision", "action_id"];

function proofFields(nextAction) {
  const declared =
    WORKFLOW_ACTION_INPUTS[nextAction].mark_workflow_action_executing;
  assert.ok(declared, `${nextAction} declares no executing call`);
  return declared
    .map(([field]) => field)
    .filter((field) => !ACTION_ENVELOPE.includes(field));
}

// The same nail one layer down: the pre-read fields these arms require are
// enforced by validateExecutingProof, which no JSON schema can see. A proof
// carrying exactly the declared fields must satisfy the validator, and every
// declared field must be one the validator actually demands.
test("declared pre-read fields are exactly what each executing proof requires", () => {
  for (const [nextAction, fixture] of Object.entries(EXECUTING_PROOF_CASES)) {
    const spec = ACTION_KIND_SPECS[fixture.kind];
    const action = { kind: fixture.kind, target: fixture.target };
    const declared = proofFields(nextAction);
    assert.deepEqual(
      declared.slice().sort(),
      Object.keys(fixture.args).sort(),
      `${nextAction} fixture does not carry the declared fields`,
    );
    spec.validateExecutingProof(
      action,
      executingProof(fixture.args),
      fixture.workflow,
    );
    for (const field of declared) {
      const withoutField = { ...fixture.args };
      delete withoutField[field];
      assert.throws(
        () =>
          spec.validateExecutingProof(
            action,
            executingProof(withoutField),
            fixture.workflow,
          ),
        `${nextAction} declares ${field}, which its validator does not require`,
      );
    }
  }
});

test("executing arms without a pre-read declare only the action envelope", () => {
  for (const nextAction of [
    "CREATE_CODEX_REVIEWER_TASK",
    "CREATE_DRAFT_PULL_REQUEST",
    "REPLY_TO_CODEX_THREAD",
  ]) {
    assert.deepEqual(proofFields(nextAction), []);
  }
  for (const kind of [
    "CREATE_CODEX_REVIEWER_TASK",
    "CREATE_DRAFT_PULL_REQUEST",
    "REPLY_TO_CODEX_THREAD",
  ]) {
    assert.equal(ACTION_KIND_SPECS[kind].validateExecutingProof, undefined);
  }
});

test("a stopped workflow declares the call its own reason needs", () => {
  const paused = (reasonCode) =>
    workflowRequiredInputs("AWAIT_OPERATOR", {
      status: "PAUSED",
      pause: { reason_code: reasonCode },
    });
  assert.deepEqual(
    paused("LOCAL_CYCLE_BUDGET_EXHAUSTED"),
    WORKFLOW_STOP_INPUTS.LOCAL_CYCLE_BUDGET_EXHAUSTED,
  );
  assert.deepEqual(paused("NO_PROGRESS"), WORKFLOW_STOP_INPUTS.PAUSED);
  assert.deepEqual(
    workflowRequiredInputs("NONE", {
      status: "CANCELLED",
      claims: [{ disposition: "ACTIVE" }],
    }),
    WORKFLOW_STOP_INPUTS.CANCELLED,
  );
  assert.deepEqual(
    workflowRequiredInputs("NONE", {
      status: "CANCELLED",
      claims: [{ disposition: "RELEASED" }],
    }),
    {},
  );
});
