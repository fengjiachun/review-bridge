import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startPublication } from "../src/publication.mjs";
import { executingProof } from "../src/server-input.mjs";
import {
  DECLARATION_TABLES,
  PUBLICATION_ACTION_INPUTS,
  REVIEW_ACTION_INPUTS,
  WARNING_GATED_INPUTS,
  WORKFLOW_ACTION_INPUTS,
  WORKFLOW_STOP_INPUTS,
  workflowRequiredInputs,
} from "../src/tool-inputs.mjs";
import {
  ACTION_KIND_SPECS,
  changeSizeWarningPending,
  continuesLocalCycle,
  resolutionOwesRecord,
  workflowSummary,
} from "../src/workflow.mjs";

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

// A post-ready stop and a terminal run both wait on the operator while ACTIVE
// or MERGE_READY. Resume refuses either, so neither may be told to call it.
// What separates them is ownership: a terminal run still holds its claims.
test("an unpaused operator stop declares no resume", () => {
  const stop = (status, claims) =>
    workflowRequiredInputs("AWAIT_OPERATOR", { status, pause: null, claims });
  for (const status of ["ACTIVE", "MERGE_READY"]) {
    assert.deepEqual(
      stop(status, [{ disposition: "RELEASED" }]),
      {},
      `${status} must not advertise a call resume rejects`,
    );
  }
  assert.deepEqual(
    stop("MERGE_READY", [{ disposition: "ACTIVE" }]),
    WORKFLOW_STOP_INPUTS.MERGE_READY,
    "a terminal run still owes the release of the claims it holds",
  );
  assert.deepEqual(stop("ACTIVE", [{ disposition: "ACTIVE" }]), {});
});

// Every one of these pauses is cleared by two calls, not one: the extension
// only raises the budget and leaves the workflow paused on the same reason.
test("a budget pause declares the resume that follows the extension", () => {
  for (const [reasonCode, extension] of [
    ["CHANGE_SIZE_BUDGET_EXCEEDED", "extend_change_size_budget"],
    ["LOCAL_CYCLE_BUDGET_EXHAUSTED", "extend_local_cycle_budget"],
    ["REMOTE_CYCLE_BUDGET_EXHAUSTED", "extend_remote_cycle_budget"],
  ]) {
    assert.deepEqual(
      Object.keys(WORKFLOW_STOP_INPUTS[reasonCode]),
      [extension, "resume_autonomous_workflow"],
      `${reasonCode} must declare its extension and then the resume`,
    );
  }
});

// Resume re-reads the bound publication and refuses a closed or merged pull
// request, which no field of the workflow ledger reports, so the pause declares
// the cancellation that is then the only exit.
test("an invalidated publication declares the cancellation too", () => {
  assert.deepEqual(Object.keys(WORKFLOW_STOP_INPUTS.PUBLICATION_INVALIDATED), [
    "resume_autonomous_workflow",
    "cancel_autonomous_workflow",
  ]);
  for (const fields of Object.values(
    WORKFLOW_STOP_INPUTS.PUBLICATION_INVALIDATED,
  )) {
    const rationale = fields.find(([field]) => field === "rationale")?.[1];
    assert.match(rationale, /CLOSED or MERGED/);
  }
});

// A local-review ledger transition moves the review, not the workflow. Every
// phase that owes one owes advance_local_workflow after it, or the summary
// keeps naming a transition the review state already rejects.
test("every local-review phase declares the advance that follows it", () => {
  for (const action of [
    "ADDRESS_LOCAL_FINDINGS",
    "WAIT_LOCAL_REVIEW",
    "PREPARE_REREVIEW",
    "WAIT_LOCAL_REREVIEW",
    "FINALIZE_LOCAL_GATE",
  ]) {
    assert.deepEqual(
      WORKFLOW_ACTION_INPUTS[action].advance_local_workflow?.map(
        ([field]) => field,
      ),
      ["workflow_id", "expected_revision"],
      `${action} must declare advance_local_workflow`,
    );
  }
});

// Recording a head against an open continuation cycle moves the phase itself,
// into one the advance refuses, so the declaration has to select on the same
// condition the head recording decides with.
test("a continuation cycle declares the head alone", () => {
  const cycle = {
    continued_from_review_id: "rb-first",
    addressed_head_sha: null,
  };
  const workflow = {
    phase: "ADDRESS_LOCAL_FINDINGS",
    local_review_cycles: [cycle],
    current_review: { review_id: "rb-first" },
  };
  const declared = () =>
    workflowRequiredInputs("ADDRESS_LOCAL_FINDINGS", workflow, {
      continuesLocalCycle: continuesLocalCycle(workflow),
    });
  assert.equal(continuesLocalCycle(workflow), true);
  assert.deepEqual(Object.keys(declared()), ["record_workflow_head"]);

  // The ordinary cycle answers findings against its own review and owes the
  // advance, because the head recording leaves it in this phase.
  cycle.continued_from_review_id = null;
  assert.equal(continuesLocalCycle(workflow), false);
  assert.deepEqual(Object.keys(declared()), [
    "record_workflow_head",
    "submit_resolutions",
    "advance_local_workflow",
  ]);
});

// A crossed change-size warning refuses the bind and the advance that prepare
// the next round, so both actions have to name the acknowledgment that clears
// it, and the call it gates has to re-read what the acknowledgment wrote.
test("a pending change-size warning declares the acknowledgment", () => {
  const crossed = {
    phase: "PREPARE_LOCAL_REVIEW",
    change_size_budget: 100,
    change_size_warning: { total_lines: 90, acknowledgment: null },
  };
  assert.equal(changeSizeWarningPending(crossed), true);
  for (const action of ["PREPARE_LOCAL_REVIEW", "ADDRESS_LOCAL_FINDINGS"]) {
    const declared = workflowRequiredInputs(action, crossed, {
      changeSizeWarningPending: changeSizeWarningPending(crossed),
    });
    assert.deepEqual(declared, WARNING_GATED_INPUTS[action]);
    // Either decision must be executable from the declaration, and a split is
    // executed by committing the cut the next round measures.
    assert.ok(declared.record_workflow_head);
    const gated =
      declared.bind_workflow_review ?? declared.advance_local_workflow;
    assert.match(
      gated.find(([field]) => field === "expected_revision")[1],
      /re-read after the acknowledgment/,
    );
    // Without the crossing the same action declares no acknowledgment.
    assert.equal(
      "acknowledge_change_size_warning" in
        workflowRequiredInputs(action, crossed),
      false,
    );
  }
});

// A pre-resolved observation issued no mutation, so the publication exposes no
// resolution to record and the recording call refuses it. Only a RESOLVED
// outcome owes that record before the action may close.
test("a pre-resolved thread declares only its completion", () => {
  const observed = (outcome) => ({
    active_action: {
      kind: "RESOLVE_REVIEW_THREAD",
      status: "OBSERVED",
      provider_response: { outcome },
    },
  });
  for (const [outcome, tools] of [
    ["RESOLVED", ["record_automatic_resolution", "complete_workflow_action"]],
    ["OBSERVED_PRE_RESOLVED", ["complete_workflow_action"]],
  ]) {
    const workflow = observed(outcome);
    assert.deepEqual(
      Object.keys(
        workflowRequiredInputs("COMPLETE_THREAD_RESOLUTION", workflow, {
          resolutionOwesRecord: resolutionOwesRecord(workflow.active_action),
        }),
      ),
      tools,
      `${outcome} must declare exactly the calls it owes`,
    );
  }
});

// A terminal publication refuses every write these two actions would otherwise
// owe, and the server permits each to complete without them exactly there.
test("a terminal publication declares only the completion", () => {
  for (const action of [
    "COMPLETE_THREAD_RESOLUTION",
    "RECORD_AND_COMPLETE_THREAD_UNRESOLVE",
  ]) {
    assert.deepEqual(
      Object.keys(
        workflowRequiredInputs(
          action,
          {},
          { resolutionOwesRecord: true, publicationTerminal: true },
        ),
      ),
      ["complete_workflow_action"],
      `${action} must not name a write a terminal ledger refuses`,
    );
    assert.ok(
      Object.keys(
        workflowRequiredInputs(action, {}, { resolutionOwesRecord: true }),
      ).length > 1,
      `${action} still owes its writes while the publication is mutable`,
    );
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

// Selecting the right declaration is only half of it: the summary has to hand
// every condition to the selection. A dropped one reads as "nothing special
// here" and silently restores the declaration the condition exists to replace.
test("the summary passes every condition its declarations select on", () => {
  const base = {
    status: "ACTIVE",
    local_review_cycles: [],
    remote_attempts: [],
    change_size_budget: 100,
    change_size_warning: null,
    ready_marks: [],
    active_action: null,
  };
  const declared = (workflow, conditions) =>
    Object.keys(
      workflowSummary({ ...base, ...workflow }, conditions).required_inputs,
    );
  assert.deepEqual(
    declared({
      phase: "ADDRESS_LOCAL_FINDINGS",
      current_review: { review_id: "rb-first" },
      local_review_cycles: [
        { continued_from_review_id: "rb-first", addressed_head_sha: null },
      ],
    }),
    ["record_workflow_head"],
    "a continuation cycle must not be told to advance",
  );
  assert.deepEqual(
    declared({
      phase: "PREPARE_LOCAL_REVIEW",
      change_size_warning: { total_lines: 90, acknowledgment: null },
    }),
    Object.keys(WARNING_GATED_INPUTS.PREPARE_LOCAL_REVIEW),
    "a crossed warning must be told what clears it",
  );
  assert.deepEqual(
    declared({
      phase: "RESOLVE_CODEX_THREADS",
      active_action: {
        kind: "RESOLVE_REVIEW_THREAD",
        status: "OBSERVED",
        provider_response: { outcome: "OBSERVED_PRE_RESOLVED" },
      },
    }),
    ["complete_workflow_action"],
    "a pre-resolved thread must not be told to record",
  );
  assert.deepEqual(
    declared(
      {
        phase: "RESOLVE_CODEX_THREADS",
        active_action: {
          kind: "RESOLVE_REVIEW_THREAD",
          status: "OBSERVED",
          provider_response: { outcome: "RESOLVED" },
        },
      },
      { publicationTerminal: true },
    ),
    ["complete_workflow_action"],
    "a terminal publication must not be told to write to it",
  );
});

// The thread loop is planned from an observation and left by an advance.
// Planners alone strand a controller twice over: the workflow's own reply is
// not in the snapshot the plan reads, and once nothing is left to plan, every
// planner refuses while the advance is the only way out of the phase.
test("the thread loop declares its refresh and its exit", () => {
  assert.deepEqual(Object.keys(WORKFLOW_ACTION_INPUTS.PLAN_THREAD_ACTION), [
    "record_github_snapshot",
    "plan_thread_reply",
    "plan_thread_resolution",
    "plan_thread_unresolve",
    "advance_remote_workflow",
  ]);
});

// A declared sequence whose earlier call writes the ledger a later call
// addresses cannot hand both the same revision: the write increments it, and a
// driver resolving the declaration once would send the consumed one.
test("a call after a write in its own sequence re-reads the revision", () => {
  const revisionSource = (calls, tool) =>
    calls[tool].find(([field]) => field === "expected_revision")[1];
  for (const [calls, tool] of [
    [WORKFLOW_ACTION_INPUTS.ADDRESS_LOCAL_FINDINGS, "advance_local_workflow"],
    [
      WORKFLOW_ACTION_INPUTS.RECORD_AND_COMPLETE_THREAD_UNRESOLVE,
      "record_github_snapshot",
    ],
    [
      WORKFLOW_STOP_INPUTS.CHANGE_SIZE_BUDGET_EXCEEDED,
      "resume_autonomous_workflow",
    ],
    [
      WORKFLOW_STOP_INPUTS.LOCAL_CYCLE_BUDGET_EXHAUSTED,
      "resume_autonomous_workflow",
    ],
    [
      WORKFLOW_STOP_INPUTS.REMOTE_CYCLE_BUDGET_EXHAUSTED,
      "resume_autonomous_workflow",
    ],
  ]) {
    assert.match(revisionSource(calls, tool), /, re-read after /);
  }
  // The advance that follows a review-side transition is not in that class:
  // prepare_rereview and finalize_local_gate write the review, so the workflow
  // revision the summary reported still holds.
  for (const action of ["PREPARE_REREVIEW", "FINALIZE_LOCAL_GATE"]) {
    assert.equal(
      revisionSource(WORKFLOW_ACTION_INPUTS[action], "advance_local_workflow"),
      "revision",
    );
  }
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
