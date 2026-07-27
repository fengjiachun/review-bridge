import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = process.env.REVIEW_BRIDGE_OUTPUT_ROOT
  ? path.resolve(process.env.REVIEW_BRIDGE_OUTPUT_ROOT)
  : path.join(projectRoot, "dist", "review-bridge-v0.4.1");
const marketplaceRoot = path.join(outputRoot, "codex-marketplace");
const pluginRoot = path.join(marketplaceRoot, "plugins", "review-bridge");
const authorServer = path.join(pluginRoot, "server", "server.mjs");
const reviewerRoot = path.join(outputRoot, "claude-extension-source");
const reviewerServer = path.join(reviewerRoot, "server", "server.mjs");
const mcpb = path.join(outputRoot, "review-bridge-reviewer-v0.4.1.mcpb");
const dxt = path.join(outputRoot, "review-bridge-reviewer-v0.4.1.dxt");
const sourceArchive = path.join(outputRoot, "review-bridge-source-v0.4.1.zip");

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function readJson(filePath) {
  return JSON.parse(await fsp.readFile(filePath, "utf8"));
}

async function connect(serverPath, role, store, reviewerProvider = null) {
  const args = [serverPath, "--role", role];
  if (role === "reviewer") {
    args.push("--reviewer-provider", reviewerProvider);
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args,
    env: { ...process.env, REVIEW_BRIDGE_HOME: store },
    stderr: "pipe",
  });
  const client = new Client({ name: "review-bridge-verifier", version: "0.4.1" });
  await client.connect(transport);
  return client;
}

function parseToolResult(result) {
  const text = result.content.find((item) => item.type === "text")?.text;
  assert.ok(text, "tool returned no text content");
  const parsed = JSON.parse(text);
  if (result.isError) {
    throw new Error(parsed.error || text);
  }
  return parsed;
}

async function call(client, name, args) {
  return parseToolResult(await client.callTool({ name, arguments: args }));
}

function iso(milliseconds) {
  return new Date(milliseconds).toISOString();
}

function publicationBaseline(at) {
  const collectedAt = iso(at - 10);
  const source = (kind) => ({
    kind,
    endpoint: `GET /fixture/${kind}`,
    collected_at: collectedAt,
    status: "COMPLETE",
    pagination_complete: true,
    page_count: 1,
  });
  return {
    observed_at: iso(at),
    collection: {
      status: "COMPLETE",
      collected_at: collectedAt,
      adapter_version: 1,
      sources: [
        source("ISSUE_COMMENTS"),
        source("PULL_REQUEST_REVIEWS"),
        source("PULL_REQUEST_REVIEW_COMMENTS"),
      ],
    },
    requests: [],
    candidate_results: [],
  };
}

function publicationObservation({ at, baseSha, headSha, requestAt }) {
  const pullBaseAt = iso(at - 90);
  const checksBaseAt = iso(at - 80);
  const collectedAt = iso(at - 50);
  const complete = (kind, extra = {}) => ({
    kind,
    endpoint: `GET /fixture/${kind}`,
    collected_at: collectedAt,
    status: "COMPLETE",
    ...extra,
  });
  const requestBodyHash = crypto
    .createHash("sha256")
    .update("@codex review")
    .digest("hex");
  return {
    observed_at: iso(at),
    pull_request: {
      collection: {
        status: "COMPLETE",
        collected_at: collectedAt,
        sources: [
          complete("PULL_REQUEST"),
          {
            ...complete("BASE_BRANCH_METADATA"),
            collected_at: pullBaseAt,
            branch_tip_sha: baseSha,
          },
          complete("BASE_HEAD_COMPARISON"),
          complete("REVIEWED_BASE_CURRENT_BASE_COMPARISON"),
        ],
      },
      repository_id: 42,
      number: 7,
      url: "https://github.com/owner/repo/pull/7",
      state: "OPEN",
      is_merged: false,
      merged_at: null,
      merge_commit_sha: null,
      is_draft: false,
      head_sha: headSha,
      head_branch: "agent/change",
      base_branch: "main",
      pr_reported_base_sha: baseSha,
      base_sha: baseSha,
      mergeable: "MERGEABLE",
      base_head_comparison: {
        status: "AHEAD",
        source: "REST_COMPARE_BASE_TO_HEAD",
        base_sha: baseSha,
        head_sha: headSha,
      },
      reviewed_base_current_base_comparison: {
        status: "IDENTICAL",
        source: "REST_COMPARE_REVIEWED_BASE_TO_CURRENT_BASE",
        base_sha: baseSha,
        head_sha: baseSha,
      },
    },
    required_checks: {
      collection: {
        status: "COMPLETE",
        collected_at: collectedAt,
        policy_sources: [
          {
            kind: "APPLICABLE_RULES",
            endpoint: "GET /fixture/rules",
            collected_at: checksBaseAt,
            result: "SUCCESS",
            pagination_complete: true,
            page_count: 1,
          },
          {
            kind: "BRANCH_METADATA",
            endpoint: "GET /fixture/branch",
            collected_at: checksBaseAt,
            result: "SUCCESS",
            protected: false,
            branch_tip_sha: baseSha,
          },
        ],
        run_sources: [
          {
            ...complete("CHECK_RUN", {
              pagination_complete: true,
              page_count: 1,
              item_count: 0,
              reported_total_count: 0,
            }),
            endpoint: "GET /fixture/check-runs?filter=all",
          },
          complete("COMMIT_STATUS", {
            pagination_complete: true,
            page_count: 1,
            item_count: 0,
            reported_total_count: null,
          }),
        ],
      },
      policy: "NONE_CONFIGURED",
      strict_policy: { required: false, sources: [] },
      requirements: [],
      runs: [],
    },
    codex_review: {
      collection: {
        status: "COMPLETE",
        collected_at: collectedAt,
        adapter_version: 1,
        sources: [
          complete("ISSUE_COMMENTS", {
            pagination_complete: true,
            page_count: 1,
          }),
          complete("PULL_REQUEST_REVIEWS", {
            pagination_complete: true,
            page_count: 1,
          }),
          complete("PULL_REQUEST_REVIEW_COMMENTS", {
            pagination_complete: true,
            page_count: 1,
          }),
        ],
      },
      preexisting_requests: [],
      preexisting_candidate_results: [],
      requests: [
        {
          comment_id: 100,
          resource_kind: "ISSUE_COMMENT",
          url: "https://github.com/owner/repo/issues/7#issuecomment-100",
          event_at: iso(requestAt),
          timestamp_field: "created_at",
          body: "@codex review",
          body_sha256: requestBodyHash,
          requested_head_sha: headSha,
        },
      ],
      unbound_requests: [],
      unsupported_requests: [],
      foreign_actor_objects: [],
      results: [
        {
          result_id: 101,
          resource_kind: "ISSUE_COMMENT",
          native_review_state: null,
          url: "https://github.com/owner/repo/issues/7#issuecomment-101",
          event_at: iso(requestAt + 10),
          timestamp_field: "created_at",
          actor: { id: 99, type: "Bot", login: "codex[bot]" },
          request_ref: {
            resource_kind: "ISSUE_COMMENT",
            resource_id: 100,
          },
          association: "SINGLE_OPEN_REQUEST",
          reviewed_head_sha: headSha,
          commit_binding: {
            source: "CODEX_REVIEWED_COMMIT_PREFIX_AND_REQUEST_HEAD",
            field: "body.reviewed_commit",
            prefix: headSha.slice(0, 10),
          },
          attached_review_comments: [],
          format: "CODEX_CLEAN_COMMENT_V1",
          verdict: "CLEAN",
          body_sha256: crypto
            .createHash("sha256")
            .update("clean result")
            .digest("hex"),
        },
      ],
    },
    review_threads: {
      collection: {
        status: "COMPLETE",
        collected_at: collectedAt,
        sources: [
          complete("PULL_REQUEST_REVIEW_THREADS", {
            pagination_complete: true,
            page_count: 1,
          }),
        ],
      },
      total_count: 0,
      unresolved_count: 0,
      threads: [],
    },
  };
}

const marketplace = await readJson(
  path.join(marketplaceRoot, ".agents", "plugins", "marketplace.json"),
);
assert.equal(marketplace.plugins[0].name, "review-bridge");
assert.equal(marketplace.plugins[0].source.path, "./plugins/review-bridge");

const plugin = await readJson(path.join(pluginRoot, ".codex-plugin", "plugin.json"));
assert.equal(plugin.name, "review-bridge");
assert.equal(plugin.version, "0.4.1");
assert.equal(plugin.mcpServers, "./.mcp.json");
const workflowSkillPath = path.join(
  pluginRoot,
  "skills",
  "review-bridge-workflow",
  "SKILL.md",
);
assert.ok(await fsp.stat(workflowSkillPath));
const workflowSkill = await fsp.readFile(workflowSkillPath, "utf8");
assert.match(
  workflowSkill,
  /Resolve it to an\n   immutable commit SHA before creating or committing publication changes/,
);
assert.match(
  workflowSkill,
  /Post exactly one issue\s+comment whose entire body equals the returned `codex_review_request\.body`/,
);
assert.match(
  workflowSkill,
  /when present, the returned\s+`codex_review_request\.request_id`/,
);
assert.match(workflowSkill, /legacy exact body without a request ID/);
assert.match(workflowSkill, /Never infer correlation from timestamps/);
assert.match(workflowSkill, /Set `adapter_version: 2` in the normalizer\s+input/);
assert.match(
  workflowSkill,
  /Require the PR head commit to equal the immutable publication authorization\s+`head_sha`/,
);
assert.match(workflowSkill, /Any new commit invalidates the GitHub review gate/);
assert.match(
  workflowSkill,
  /new local Review Bridge task in `LOCAL_GATE` mode or call\s+`authorize_remote_publication` again/,
);
assert.match(
  workflowSkill,
  /clean issue comment.*Findings must echo the same request ID in\s+   a formal review/s,
);
assert.match(workflowSkill, /Treat an eyes reaction.*as non-passing/s);
assert.match(workflowSkill, /immediately call\s+`record_codex_review_request`/);
assert.match(workflowSkill, /formal review bound by native\s+`commit_id`/);
assert.match(workflowSkill, /get_review_summary/);
assert.match(workflowSkill, /wait_for_review_state/);
assert.match(workflowSkill, /pass that task as `parent_review_id`/);
assert.match(workflowSkill, /Choose `reviewer_provider` explicitly/);
assert.match(workflowSkill, /newly created Codex task/);
assert.match(workflowSkill, /is not a fork of the\s+author task/);
assert.match(workflowSkill, /Never call reviewer tools from the author task/);
assert.match(workflowSkill, /For `SUCCESSOR`/);
assert.match(workflowSkill, /A `timed_out` result is expected/);
assert.match(
  workflowSkill,
  /call it again with the same\s+`state_version` until `changed` is true/,
);
assert.match(
  workflowSkill,
  /Treat `timed_out` as an expected in-progress\s+result and\s+continue with the same `state_version`/,
);
assert.match(workflowSkill, /structured `REVIEW_BUSY`/);
assert.match(workflowSkill, /`details\.retryable: true`/);
assert.match(workflowSkill, /`LOCK_OWNERSHIP_LOST`/);
assert.match(workflowSkill, /`details\.state_may_have_changed: true`/);
assert.match(workflowSkill, /`LOCK_CLEANUP_FAILED`/);
assert.match(workflowSkill, /`STORE_WRITE_INDETERMINATE`/);
assert.match(workflowSkill, /do not\s+loop on the same mutation/);
assert.match(
  workflowSkill,
  /an unsupported\s+standalone review comment/,
);
assert.match(
  workflowSkill,
  /Never learn or replace this identity from a candidate\s+result/,
);
for (const tool of [
  "authorize_remote_publication",
  "start_publication",
  "get_publication",
  "get_publication_summary",
  "record_codex_review_request",
  "record_github_snapshot",
  "acknowledge_codex_review_ambiguity",
  "finalize_publication_gate",
  "verify_publication_gate",
]) {
  assert.match(workflowSkill, new RegExp(`\\b${tool}\\b`));
}
assert.match(workflowSkill, /Immediately before `start_publication`/);
assert.match(
  workflowSkill,
  /`REMOTE_ONLY` is allowed only after the user directly instructs you to skip\s+local review/,
);
assert.match(workflowSkill, /`LOCAL_REVIEW_SKIPPED`/);
assert.match(
  workflowSkill,
  /Resolve `base_sha` as the exact merge base of that\s+fresh base tip and head/,
);
assert.match(
  workflowSkill,
  /Do not infer it from urgency, a prior\s+exception, reviewer unavailability/,
);
assert.match(workflowSkill, /immediately call\s+`record_codex_review_request`/);
assert.match(workflowSkill, /Never post an exact or\s+trigger-shaped Codex review request manually/);
assert.match(workflowSkill, /direct approval of that exact\s+full set/);
assert.match(
  workflowSkill,
  /`AUTOMATIC_QUIESCENCE_ACKNOWLEDGED` requires direct human/,
);
assert.match(workflowSkill, /Immediately\s+before merge call `verify_publication_gate`/);
assert.match(
  workflowSkill,
  /\.\.\/\.\.\/scripts\/normalize-codex-evidence\.mjs/,
);
assert.match(
  workflowSkill,
  /\.\.\/\.\.\/scripts\/collect-github-observation\.mjs/,
);
assert.match(workflowSkill, /canonicalizes GitHub timestamps to UTC milliseconds/);
assert.ok(
  await fsp.stat(
    path.join(pluginRoot, "scripts", "normalize-codex-evidence.mjs"),
  ),
);
const collectorPath = path.join(
  pluginRoot,
  "scripts",
  "collect-github-observation.mjs",
);
assert.ok(await fsp.stat(collectorPath));
assert.match(
  run(process.execPath, [collectorPath, "--help"], pluginRoot),
  /Usage: collect-github-observation\.mjs/,
);
assert.ok(
  await fsp.stat(
    path.join(pluginRoot, "scripts", "inspect-publication-audit.mjs"),
  ),
);

const mcpConfig = await readJson(path.join(pluginRoot, ".mcp.json"));
assert.equal(mcpConfig.mcpServers["review-bridge-author"].cwd, ".");
assert.equal(
  mcpConfig.mcpServers["review-bridge-author"].args[0],
  "./server/server.mjs",
);
assert.deepEqual(
  mcpConfig.mcpServers["review-bridge-reviewer"].args,
  [
    "./server/server.mjs",
    "--role",
    "reviewer",
    "--reviewer-provider",
    "CODEX_TASK",
  ],
);
const reviewerSkillPath = path.join(
  pluginRoot,
  "skills",
  "review-bridge-reviewer",
  "SKILL.md",
);
const reviewerSkill = await fsp.readFile(reviewerSkillPath, "utf8");
assert.match(reviewerSkill, /newly created Codex task/);
assert.match(reviewerSkill, /must not be a fork of the author task/);
assert.match(reviewerSkill, /Require `reviewer_provider: CODEX_TASK`/);
assert.match(reviewerSkill, /Treat every actionable finding as blocking/);

const extension = await readJson(path.join(reviewerRoot, "manifest.json"));
assert.equal(extension.manifest_version, "0.3");
assert.equal(extension.version, "0.4.1");
assert.equal(extension.server.entry_point, "server/server.mjs");
assert.deepEqual(extension.server.mcp_config.args.slice(-2), [
  "--reviewer-provider",
  "CLAUDE_DESKTOP",
]);
const reviewInstructions = await fsp.readFile(
  path.join(reviewerRoot, "REVIEW_INSTRUCTIONS.md"),
  "utf8",
);
assert.match(reviewInstructions, /Follow the returned `review_strategy`/);
assert.match(
  reviewInstructions,
  /read all of `successor\.json` and `successor\.diff`/,
);
assert.match(reviewInstructions, /Read `patch\.diff` too whenever/);
assert.match(
  reviewInstructions,
  /For every review strategy, inspect relevant source beyond the patch with\s+`read_snapshot_file` and `search_snapshot`/,
);

const [mcpbBytes, dxtBytes] = await Promise.all([fsp.readFile(mcpb), fsp.readFile(dxt)]);
assert.equal(
  crypto.createHash("sha256").update(mcpbBytes).digest("hex"),
  crypto.createHash("sha256").update(dxtBytes).digest("hex"),
);
const archiveFiles = run("unzip", ["-Z1", sourceArchive], projectRoot)
  .split("\n")
  .filter((entry) => entry && !entry.endsWith("/"))
  .sort();
const trackedFiles = run(
  "git",
  ["ls-tree", "-r", "--name-only", "HEAD"],
  projectRoot,
)
  .split("\n")
  .filter(Boolean)
  .sort();
assert.deepEqual(archiveFiles, trackedFiles);

const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-build-"));
try {
  const repository = path.join(temporary, "repo");
  const store = path.join(temporary, "store");
  const normalizer = path.join(
    pluginRoot,
    "scripts",
    "normalize-codex-evidence.mjs",
  );
  for (const fixtureName of ["codex-clean.json", "codex-findings.json"]) {
    const fixturePath = path.join(
      projectRoot,
      "test",
      "fixtures",
      "github",
      fixtureName,
    );
    const normalized = JSON.parse(
      run(process.execPath, [normalizer, fixturePath], pluginRoot),
    );
    assert.equal(normalized.collection.adapter_version, 1);
    assert.equal(normalized.results.length, 1);
  }
  const baselineInput = await readJson(
    path.join(
      projectRoot,
      "test",
      "fixtures",
      "github",
      "codex-clean.json",
    ),
  );
  baselineInput.mode = "BASELINE";
  baselineInput.authorization_head_sha = baselineInput.local_gate_head_sha;
  delete baselineInput.local_gate_head_sha;
  const baselineInputPath = path.join(temporary, "codex-baseline-input.json");
  await fsp.writeFile(
    baselineInputPath,
    `${JSON.stringify(baselineInput)}\n`,
  );
  const normalizedBaseline = JSON.parse(
    run(process.execPath, [normalizer, baselineInputPath], pluginRoot),
  );
  assert.equal(normalizedBaseline.requests.length, 1);
  assert.equal(normalizedBaseline.candidate_results.length, 1);
  await fsp.mkdir(repository);
  run("git", ["init", "-b", "main"], repository);
  run("git", ["config", "user.name", "Review Bridge Verifier"], repository);
  run(
    "git",
    ["config", "user.email", "review-bridge@example.invalid"],
    repository,
  );
  await fsp.writeFile(
    path.join(repository, "value.js"),
    "export const value = 1;\n",
  );
  run("git", ["add", "."], repository);
  run("git", ["commit", "-m", "base"], repository);
  const baseSha = run("git", ["rev-parse", "HEAD"], repository);
  run("git", ["switch", "-c", "agent/change"], repository);
  await fsp.writeFile(
    path.join(repository, "value.js"),
    "export const value = 2;\n",
  );
  run("git", ["add", "."], repository);
  run("git", ["commit", "-m", "change value"], repository);

  const author = await connect(authorServer, "author", store);
  const reviewer = await connect(
    reviewerServer,
    "reviewer",
    store,
    "CLAUDE_DESKTOP",
  );
  const codexReviewer = await connect(
    authorServer,
    "reviewer",
    store,
    "CODEX_TASK",
  );
  try {
    const prepared = await call(author, "prepare_review", {
      repository_path: repository,
      base_ref: baseSha,
      requirement: "Change the exported value to 2.",
      implementation_scope: "Update value.js and add a focused test.",
      reviewer_provider: "CLAUDE_DESKTOP",
    });
    assert.equal(prepared.status, "WAITING_FOR_REVIEW");
    const summary = await call(author, "get_review_summary", {
      review_id: prepared.id,
    });
    assert.equal(summary.action_required, "REVIEWER_INITIAL_REVIEW");
    assert.equal(summary.reviewer_provider, "CLAUDE_DESKTOP");
    const timedOut = await call(author, "wait_for_review_state", {
      review_id: prepared.id,
      known_state_version: summary.state_version,
      timeout_ms: 10,
    });
    assert.equal(timedOut.changed, false);
    assert.equal(timedOut.timed_out, true);

    const pending = await call(reviewer, "list_pending_reviews", {});
    assert.equal(pending[0].id, prepared.id);
    const opened = await call(reviewer, "open_review", {
      review_id: prepared.id,
    });
    assert.equal(opened.current_snapshot.changed_files[0], "value.js");
    const patch = await call(reviewer, "read_review_artifact", {
      review_id: prepared.id,
      round: 1,
      artifact: "patch.diff",
    });
    assert.match(patch.content, /value = 2/);

    const observedPromise = call(author, "wait_for_review_state", {
      review_id: prepared.id,
      known_state_version: summary.state_version,
      timeout_ms: 30_000,
    });
    await call(reviewer, "submit_review", {
      review_id: prepared.id,
      findings: [
        {
          severity: "major",
          title: "Missing focused test",
          explanation: "The declared scope includes a test, but none exists.",
          recommendation: "Add a focused test.",
          path: "value.js",
          line: 1,
        },
      ],
    });
    const observed = await observedPromise;
    assert.equal(observed.changed, true);
    assert.equal(observed.summary.status, "REVIEW_SUBMITTED");
    await call(author, "submit_resolutions", {
      review_id: prepared.id,
      resolutions: [
        {
          finding_id: "F-001",
          disposition: "fixed",
          rationale: "Added value.test.js.",
          evidence: "node --test value.test.js",
        },
      ],
    });
    await fsp.writeFile(
      path.join(repository, "value.test.js"),
      "import assert from 'node:assert/strict';\nimport { value } from './value.js';\nassert.equal(value, 2);\n",
    );
    run("git", ["add", "."], repository);
    run("git", ["commit", "-m", "add focused test"], repository);
    await call(author, "prepare_rereview", { review_id: prepared.id });
    const clean = await call(reviewer, "submit_rereview", {
      review_id: prepared.id,
      decisions: [
        {
          finding_id: "F-001",
          decision: "resolved",
          rationale: "The focused test now exists.",
        },
      ],
      new_findings: [],
    });
    assert.equal(clean.status, "CLEAN");
    const finalized = await call(author, "finalize_local_gate", {
      review_id: prepared.id,
    });
    assert.equal(finalized.gate.status, "LOCAL_GATE_PASSED");
    const headSha = finalized.gate.head_sha;
    const startedAt = Date.now();
    const publication = await call(author, "start_publication", {
      review_id: prepared.id,
      repository_id: 42,
      owner: "owner",
      repo: "repo",
      pr_number: 7,
      base_branch: "main",
      head_branch: "agent/change",
      codex_actor_id: 99,
      codex_actor_type: "Bot",
      codex_actor_login: "codex[bot]",
      codex_trigger_mode: "EXPLICIT_ONLY",
      codex_review_baseline: publicationBaseline(startedAt - 10),
    });
    assert.equal(publication.status, "PR_PENDING");
    assert.equal(
      publication.authorization.reviewer_provider,
      "CLAUDE_DESKTOP",
    );
    const requestAt = Date.now();
    const requested = await call(author, "record_codex_review_request", {
      review_id: prepared.id,
      expected_revision: publication.revision,
      comment_id: 100,
      url: "https://github.com/owner/repo/issues/7#issuecomment-100",
      created_at: iso(requestAt),
      requested_head_sha: headSha,
    });
    const observedAt = Date.now() + 1_000;
    const ready = await call(author, "record_github_snapshot", {
      review_id: prepared.id,
      expected_revision: requested.revision,
      observation: publicationObservation({
        at: observedAt,
        baseSha,
        headSha,
        requestAt,
      }),
    });
    assert.equal(ready.status, "MERGE_READY");
    const publicationGate = await call(author, "finalize_publication_gate", {
      review_id: prepared.id,
      expected_revision: ready.revision,
    });
    assert.equal(publicationGate.issuance_committed, true);
    assert.equal(publicationGate.reviewer_provider, "CLAUDE_DESKTOP");
    const verified = await call(author, "verify_publication_gate", {
      review_id: prepared.id,
    });
    assert.equal(verified.valid, true);
    assert.equal(verified.head_sha, headSha);
    assert.equal(verified.reviewer_provider, "CLAUDE_DESKTOP");
    const auditInspection = spawnSync(
      process.execPath,
      [
        path.join(pluginRoot, "scripts", "inspect-publication-audit.mjs"),
        prepared.id,
      ],
      {
        cwd: pluginRoot,
        encoding: "utf8",
        env: { ...process.env, REVIEW_BRIDGE_HOME: store },
      },
    );
    assert.equal(auditInspection.status, 0, auditInspection.stderr);
    assert.equal(JSON.parse(auditInspection.stdout).valid, true);

    const remoteAuthorization = await call(
      author,
      "authorize_remote_publication",
      {
        repository_path: repository,
        base_sha: baseSha,
        head_sha: headSha,
        acknowledgement: "LOCAL_REVIEW_SKIPPED",
        operator_label: "maintainer",
        rationale: "Verify the packaged remote-only publication workflow.",
      },
    );
    assert.equal(remoteAuthorization.mode, "REMOTE_ONLY");
    const remoteStartedAt = Date.now();
    const remotePublication = await call(author, "start_publication", {
      review_id: remoteAuthorization.review_id,
      repository_id: 42,
      owner: "owner",
      repo: "repo",
      pr_number: 7,
      base_branch: "main",
      head_branch: "agent/change",
      codex_actor_id: 99,
      codex_actor_type: "Bot",
      codex_actor_login: "codex[bot]",
      codex_trigger_mode: "EXPLICIT_ONLY",
      codex_review_baseline: publicationBaseline(remoteStartedAt - 10),
    });
    assert.equal(remotePublication.authorization.mode, "REMOTE_ONLY");
    assert.equal(remotePublication.authorization.reviewer_provider, null);
    const remoteRequestAt = Date.now();
    const remoteRequested = await call(author, "record_codex_review_request", {
      review_id: remoteAuthorization.review_id,
      expected_revision: remotePublication.revision,
      comment_id: 100,
      url: "https://github.com/owner/repo/issues/7#issuecomment-100",
      created_at: iso(remoteRequestAt),
      requested_head_sha: headSha,
    });
    const remoteObservedAt = Date.now() + 1_000;
    const remoteReady = await call(author, "record_github_snapshot", {
      review_id: remoteAuthorization.review_id,
      expected_revision: remoteRequested.revision,
      observation: publicationObservation({
        at: remoteObservedAt,
        baseSha,
        headSha,
        requestAt: remoteRequestAt,
      }),
    });
    assert.equal(remoteReady.status, "MERGE_READY");
    const remoteGate = await call(author, "finalize_publication_gate", {
      review_id: remoteAuthorization.review_id,
      expected_revision: remoteReady.revision,
    });
    assert.equal(remoteGate.authorization_mode, "REMOTE_ONLY");
    assert.equal(remoteGate.reviewer_provider, null);
    const remoteVerified = await call(author, "verify_publication_gate", {
      review_id: remoteAuthorization.review_id,
    });
    assert.equal(remoteVerified.valid, true);
    assert.equal(remoteVerified.head_sha, headSha);
    assert.equal(remoteVerified.reviewer_provider, null);

    await fsp.writeFile(
      path.join(repository, "value.test.js"),
      "import assert from 'node:assert/strict';\nimport { value } from './value.js';\nassert.equal(value, 2);\nassert.equal(typeof value, 'number');\n",
    );
    run("git", ["add", "."], repository);
    run("git", ["commit", "-m", "strengthen focused test"], repository);
    const successorHeadSha = run("git", ["rev-parse", "HEAD"], repository);
    const successor = await call(author, "prepare_review", {
      repository_path: repository,
      base_ref: baseSha,
      requirement: "Change the exported value to 2.",
      implementation_scope: "Strengthen the focused test.",
      reviewer_provider: "CODEX_TASK",
      parent_review_id: prepared.id,
    });
    assert.equal(successor.review_strategy.mode, "SUCCESSOR");
    assert.equal(successor.reviewer_provider, "CODEX_TASK");
    await assert.rejects(
      call(reviewer, "open_review", { review_id: successor.id }),
      /reviewer provider mismatch/,
    );
    const successorOpened = await call(codexReviewer, "open_review", {
      review_id: successor.id,
    });
    assert.deepEqual(
      successorOpened.artifacts.map((artifact) => artifact.name),
      ["successor.diff", "successor.json", "patch.diff", "manifest.json"],
    );
    const successorPatch = await call(codexReviewer, "read_review_artifact", {
      review_id: successor.id,
      round: 1,
      artifact: "successor.diff",
    });
    assert.match(successorPatch.content, /typeof value/);
    assert.doesNotMatch(successorPatch.content, /value = 2/);
    const successorProof = JSON.parse(
      (
        await call(codexReviewer, "read_review_artifact", {
          review_id: successor.id,
          round: 1,
          artifact: "successor.json",
        })
      ).content,
    );
    assert.equal(successorProof.parent_head_sha, headSha);
    assert.equal(successorProof.current_head_sha, successorHeadSha);
    assert.equal(
      successorProof.parent_reviewer_provider,
      "CLAUDE_DESKTOP",
    );
    await call(codexReviewer, "submit_review", {
      review_id: successor.id,
      findings: [],
    });
    const successorGate = await call(author, "finalize_local_gate", {
      review_id: successor.id,
    });
    assert.equal(successorGate.gate.head_sha, successorHeadSha);
    assert.equal(successorGate.gate.reviewer_provider, "CODEX_TASK");
  } finally {
    await Promise.all([
      codexReviewer.close(),
      reviewer.close(),
      author.close(),
    ]);
  }
} finally {
  await fsp.rm(temporary, { recursive: true, force: true });
}

process.stdout.write(
  "Packaged Codex author, Codex reviewer, and Claude clients completed full, successor, local publication, and remote-only publication flows.\n",
);
