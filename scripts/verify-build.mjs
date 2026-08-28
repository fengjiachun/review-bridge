import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  ADVISORY_PANEL_CONTRACT,
  assertDispatchContract,
  assertThirdPartyMaterialBoundary,
  DEEPSEEK_HARNESS_DISPATCH_CONTRACT,
  HERMES_DISPATCH_CONTRACT,
} from "./dispatch-contract.mjs";
import {
  deepSeekHarnessClientEntry,
  parseMcpSnippet,
  renderAndValidateDeepSeekHarnessClient,
  renderAndValidateHermesServerConfig,
} from "./mcp-snippets.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootPackage = JSON.parse(
  await fsp.readFile(path.join(projectRoot, "package.json"), "utf8"),
);
const releaseVersion = rootPackage.version;
const releasePathPlaceholder = "__REVIEW_BRIDGE_RELEASE_PATH__";
const storePlaceholder = "__REVIEW_BRIDGE_HOME__";
const reviewerToolNames = [
  "list_pending_reviews",
  "open_review",
  "read_review_artifact",
  "read_snapshot_file",
  "search_snapshot",
  "submit_rereview",
  "submit_review",
];
const outputRoot = process.env.REVIEW_BRIDGE_OUTPUT_ROOT
  ? path.resolve(process.env.REVIEW_BRIDGE_OUTPUT_ROOT)
  : path.join(projectRoot, "dist", `review-bridge-v${releaseVersion}`);
const marketplaceRoot = path.join(outputRoot, "codex-marketplace");
const pluginRoot = path.join(marketplaceRoot, "plugins", "review-bridge");
const authorServer = path.join(pluginRoot, "server", "server.mjs");
const reviewerRoot = path.join(outputRoot, "claude-extension-source");
const reviewerServer = path.join(reviewerRoot, "server", "server.mjs");
const hermesIntegration = path.join(outputRoot, "hermes-integration");
const hermesServer = path.join(hermesIntegration, "server", "server.mjs");
const deepseekHarness = path.join(outputRoot, "deepseek-harness");
const deepseekServer = path.join(deepseekHarness, "server", "server.mjs");
const mcpb = path.join(
  outputRoot,
  `review-bridge-reviewer-v${releaseVersion}.mcpb`,
);
const dxt = path.join(
  outputRoot,
  `review-bridge-reviewer-v${releaseVersion}.dxt`,
);
const sourceArchive = path.join(
  outputRoot,
  `review-bridge-source-v${releaseVersion}.zip`,
);

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

function scalarValues(value) {
  if (Array.isArray(value)) return value.flatMap(scalarValues);
  if (value && typeof value === "object") {
    return Object.values(value).flatMap(scalarValues);
  }
  return [String(value)];
}

async function connectHermesConfig(serverConfig, store) {
  const rendered = renderAndValidateHermesServerConfig(serverConfig, {
    releasePath: hermesIntegration,
    reviewBridgeHome: store,
  });
  assert.equal(rendered.args[0], hermesServer);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: rendered.args,
    env: { ...process.env, ...rendered.env },
    stderr: "pipe",
  });
  const client = new Client({
    name: "review-bridge-hermes-build-verifier",
    version: releaseVersion,
  });
  await client.connect(transport);
  return client;
}

async function connectDeepSeekHarnessConfig(clientEntry, store) {
  const rendered = renderAndValidateDeepSeekHarnessClient(clientEntry, {
    releasePath: deepseekHarness,
    reviewBridgeHome: store,
  });
  assert.equal(rendered.config.args[0], deepseekServer);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: rendered.config.args,
    env: { ...process.env, ...rendered.config.env },
    stderr: "pipe",
  });
  const client = new Client({
    name: "review-bridge-deepseek-harness-build-verifier",
    version: releaseVersion,
  });
  await client.connect(transport);
  return client;
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
  const client = new Client({
    name: "review-bridge-verifier",
    version: releaseVersion,
  });
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

assert.equal(rootPackage.version, releaseVersion);
if (!process.env.REVIEW_BRIDGE_OUTPUT_ROOT) {
  assert.equal(
    outputRoot,
    path.join(projectRoot, "dist", `review-bridge-v${releaseVersion}`),
  );
}

const marketplace = await readJson(
  path.join(marketplaceRoot, ".agents", "plugins", "marketplace.json"),
);
assert.equal(marketplace.plugins[0].name, "review-bridge");
assert.equal(marketplace.plugins[0].source.path, "./plugins/review-bridge");

const plugin = await readJson(path.join(pluginRoot, ".codex-plugin", "plugin.json"));
assert.equal(plugin.name, "review-bridge");
assert.equal(plugin.version, releaseVersion);
assert.equal(plugin.mcpServers, "./.mcp.json");
const workflowSkillPath = path.join(
  pluginRoot,
  "skills",
  "review-bridge-workflow",
  "SKILL.md",
);
assert.ok(await fsp.stat(workflowSkillPath));
const workflowSkill = await fsp.readFile(workflowSkillPath, "utf8");
const packagedReadme = await fsp.readFile(
  path.join(outputRoot, "README.md"),
  "utf8",
);
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
assert.match(workflowSkill, /Never infer\s+correlation from\s+timestamps/);
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
  /adapter version 2, prefer a clean issue comment or findings review that\s+   echoes the exact current Review Bridge request ID/,
);
assert.match(
  workflowSkill,
  /server-replayed fallback of exactly one recorded\s+   open request, no preceding unbound or compatible unresolved baseline\s+   request, and a compatible reviewed-commit prefix or native GitHub\s+   `commit_id`/,
);
assert.match(
  workflowSkill,
  /Adapter-version-1 ledgers retain the legacy exact-body and\s+   single-open-request rules/,
);
assert.match(
  workflowSkill,
  /version-2 `BASELINE_CORRELATED` request with\s+   server-verified issuance provenance from another head is not a candidate/,
);
assert.match(workflowSkill, /eyes reaction.*as\s+non-passing/s);
assert.match(workflowSkill, /immediately call\s+`record_codex_review_request`/);
assert.match(
  workflowSkill,
  /Findings must be a formal review with its complete\s+structurally\s+attached Codex review comments/,
);
assert.match(workflowSkill, /get_review_summary/);
assert.match(workflowSkill, /wait_for_review_state/);
assert.match(workflowSkill, /export_human_arbitration/);
assertDispatchContract(
  workflowSkill,
  "## Dispatching a HERMES review",
  "packaged Codex workflow skill",
  HERMES_DISPATCH_CONTRACT,
);
assertDispatchContract(
  workflowSkill,
  "## Dispatching a DEEPSEEK_HARNESS review",
  "packaged Codex workflow skill",
  DEEPSEEK_HARNESS_DISPATCH_CONTRACT,
);
assertDispatchContract(
  workflowSkill,
  "## Advisory panel review of an external pull request",
  "packaged Codex workflow skill",
  ADVISORY_PANEL_CONTRACT,
);
assert.match(
  workflowSkill,
  /Leave `parent_review_id` unset unless you have a specific parent in mind/,
);
assert.match(workflowSkill, /`force_full_review: true`/);
assert.match(workflowSkill, /`current_snapshot\.patch_index`/);
assert.match(workflowSkill, /Choose `reviewer_provider` explicitly/);
assert.match(workflowSkill, /newly created Codex task/);
assert.match(workflowSkill, /is not a fork of the\s+author task/);
assert.match(workflowSkill, /Never call reviewer tools from the author task/);
assert.match(
  workflowSkill,
  /ID, severity, one-line summary,\s+and location/,
);
assert.match(
  workflowSkill,
  /persisted\s+disposition, rationale, and evidence from its `resolutions`/,
);
assert.match(workflowSkill, /every per-finding decision and any new finding/);
assert.match(workflowSkill, /state the escalation and why it needs a human/);
assert.match(
  workflowSkill,
  /After\s+`prepare_rereview` captures the result, call `get_review` again/,
);
assert.match(
  workflowSkill,
  /compare the preceding and latest rounds'\s+authoritative `head_sha` values with `git diff --name-only` to derive the\s+actual fix files/,
);
assert.match(
  workflowSkill,
  /require a new commit only when at least\s+one resolution is `fixed`/,
);
assert.match(workflowSkill, /rereview is rebuttal-only and no\s+code commit was required/);
assert.match(
  workflowSkill,
  /Any author `human_required` resolution moves directly to `HUMAN_REQUIRED`\s+without capturing a rereview round/,
);
assert.match(
  workflowSkill,
  /If the state is instead `HUMAN_REQUIRED`[\s\S]*stop and follow the human-arbitration flow/,
);
assert.match(
  workflowSkill,
  /When at least one of those resolutions is `fixed`[\s\S]*no\s+rereview round captured its files or commit[\s\S]*Do not infer that metadata from\s+the workspace or session text/,
);
assert.match(
  workflowSkill,
  /`CONTINUABLE_FINDINGS`, present the source ledger's `OPEN`\s+`findings`/,
);
assert.match(workflowSkill, /read its `carried_findings` as the continuation scope/);
assert.match(
  workflowSkill,
  /When a round reports findings, call `get_review`/,
);
assert.match(
  workflowSkill,
  /When rereview\s+completes, call `get_review` again/,
);
assert.match(
  workflowSkill,
  /After\s+`submit_resolutions`, call `get_review` again/,
);
assert.match(workflowSkill, /persisted disposition from its\s+`resolutions`/);
assert.match(
  workflowSkill,
  /`rereview_decisions` and `findings`/,
);
assert.match(
  workflowSkill,
  /Session narration is operator observability only/,
);
assert.match(packagedReadme, /### Operator narration/);
assert.match(
  packagedReadme,
  /This narration is observability, not evidence/,
);
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
  /an\s+unsupported\s+standalone\s+review\s+comment/,
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
const collectorHelp = run(process.execPath, [collectorPath, "--help"], pluginRoot);
assert.match(collectorHelp, /Usage: collect-github-observation\.mjs/);
assert.match(collectorHelp, /--review-id <id>/);
assert.match(collectorHelp, /--out <path>/);
assert.match(collectorHelp, /Never retype\s+the observation itself/);
assert.match(workflowSkill, /--review-id <review_id>/);
assert.match(collectorHelp, /Refused inside any\s+Git worktree/);
assert.match(
  workflowSkill,
  /`record_github_snapshot` with the `observation_path` the helper prints/,
);
assert.match(workflowSkill, /Never paste an\s+observation or a ledger/);
const collectorStore = await fsp.mkdtemp(
  path.join(os.tmpdir(), "review-bridge-collector-"),
);
const collectorFromStore = spawnSync(
  process.execPath,
  [
    collectorPath,
    "--review-id",
    "rb-2026-07-26T000000-000Z-deadbeef",
    "--out",
    path.join(collectorStore, "observation.json"),
  ],
  {
    cwd: pluginRoot,
    encoding: "utf8",
    env: { ...process.env, REVIEW_BRIDGE_HOME: collectorStore },
  },
);
assert.notEqual(collectorFromStore.status, 0);
assert.match(
  collectorFromStore.stderr,
  new RegExp(
    `${collectorStore.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/reviews/rb-2026-07-26T000000-000Z-deadbeef/publication.json`,
  ),
);
const collectorWorktreeOut = spawnSync(
  process.execPath,
  [
    collectorPath,
    "--review-id",
    "rb-2026-07-26T000000-000Z-deadbeef",
    "--out",
    path.join(pluginRoot, "observation.json"),
  ],
  {
    cwd: pluginRoot,
    encoding: "utf8",
    env: { ...process.env, REVIEW_BRIDGE_HOME: os.tmpdir() },
  },
);
assert.equal(collectorWorktreeOut.status, 2);
assert.match(
  collectorWorktreeOut.stderr,
  /refusing to write the observation inside the Git worktree/,
);
const collectorBadId = spawnSync(
  process.execPath,
  [collectorPath, "--review-id", "not-a-review", "--out", "/dev/null"],
  { cwd: pluginRoot, encoding: "utf8" },
);
assert.equal(collectorBadId.status, 2);
assert.match(collectorBadId.stderr, /invalid --review-id/);
await fsp.rm(collectorStore, { recursive: true, force: true });
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
assert.match(reviewerSkill, /Treat\s+every\s+actionable\s+finding\s+as\s+blocking/);
assertThirdPartyMaterialBoundary(reviewerSkill, "packaged Codex reviewer skill");

const extension = await readJson(path.join(reviewerRoot, "manifest.json"));
assert.equal(extension.manifest_version, "0.3");
assert.equal(extension.version, releaseVersion);
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
assert.match(reviewInstructions, /Read `patch\.diff` only when one of these holds/);
assert.match(reviewInstructions, /`current_snapshot\.patch_index`/);
assert.match(
  reviewInstructions,
  /cumulative base-to-head diff/,
);
assert.match(
  reviewInstructions,
  /For every review strategy, inspect relevant source beyond the patch with\s+`read_snapshot_file` and `search_snapshot`/,
);
assertThirdPartyMaterialBoundary(
  reviewInstructions,
  "packaged Claude review instructions",
);

// Hermes profile integration artifact.
const hermesRuntimePackage = await readJson(
  path.join(hermesIntegration, "package.json"),
);
assert.equal(hermesRuntimePackage.version, releaseVersion);
const hermesReviewerConfig = await fsp.readFile(
  path.join(hermesIntegration, "mcp", "reviewer.config.yaml"),
  "utf8",
);
const parsedHermesReviewer = parseMcpSnippet(hermesReviewerConfig);
assert.deepEqual(Object.keys(parsedHermesReviewer), ["mcp_servers"]);
assert.deepEqual(Object.keys(parsedHermesReviewer.mcp_servers), [
  "review-bridge-reviewer",
]);
const hermesReviewerServer =
  parsedHermesReviewer.mcp_servers["review-bridge-reviewer"];
assert.deepEqual(Object.keys(hermesReviewerServer).sort(), [
  "args",
  "command",
  "connect_timeout",
  "enabled",
  "env",
  "timeout",
  "tools",
]);
assert.equal(hermesReviewerServer.command, "node");
assert.deepEqual(hermesReviewerServer.args, [
  `${releasePathPlaceholder}/server/server.mjs`,
  "--role",
  "reviewer",
  "--reviewer-provider",
  "HERMES",
]);
assert.deepEqual(hermesReviewerServer.env, {
  REVIEW_BRIDGE_HOME: storePlaceholder,
});
assert.equal(hermesReviewerServer.enabled, true);
assert.equal(hermesReviewerServer.timeout, 300);
assert.equal(hermesReviewerServer.connect_timeout, 60);
assert.deepEqual(Object.keys(hermesReviewerServer.tools).sort(), [
  "include",
  "prompts",
  "resources",
]);
assert.deepEqual(
  hermesReviewerServer.tools.include.slice().sort(),
  reviewerToolNames,
);
assert.equal(hermesReviewerServer.tools.resources, false);
assert.equal(hermesReviewerServer.tools.prompts, false);
assert.equal("cwd" in hermesReviewerServer, false);
const hermesAuthorConfig = await fsp.readFile(
  path.join(hermesIntegration, "mcp", "author.config.yaml"),
  "utf8",
);
const parsedHermesAuthor = parseMcpSnippet(hermesAuthorConfig);
assert.deepEqual(Object.keys(parsedHermesAuthor), ["mcp_servers"]);
assert.deepEqual(Object.keys(parsedHermesAuthor.mcp_servers), [
  "review-bridge-author",
]);
const hermesAuthorServer = parsedHermesAuthor.mcp_servers["review-bridge-author"];
assert.deepEqual(Object.keys(hermesAuthorServer).sort(), [
  "args",
  "command",
  "connect_timeout",
  "enabled",
  "env",
  "timeout",
]);
assert.equal(hermesAuthorServer.command, "node");
assert.deepEqual(hermesAuthorServer.args, [
  `${releasePathPlaceholder}/server/server.mjs`,
  "--role",
  "author",
]);
assert.deepEqual(hermesAuthorServer.env, {
  REVIEW_BRIDGE_HOME: storePlaceholder,
});
assert.equal(hermesAuthorServer.enabled, true);
assert.equal(hermesAuthorServer.timeout, 300);
assert.equal(hermesAuthorServer.connect_timeout, 60);
assert.equal("cwd" in hermesAuthorServer, false);
assert.equal("tools" in hermesAuthorServer, false);
const hermesConfigValues = scalarValues([
  parsedHermesReviewer,
  parsedHermesAuthor,
]).join("\n");
assert.doesNotMatch(hermesConfigValues, /\$\(|`|\$\{/);
assert.doesNotMatch(
  hermesConfigValues,
  /github_pat_|ghp_|GITHUB_TOKEN|GH_TOKEN|Bearer\s+\S/i,
);
const hermesSkill = await fsp.readFile(
  path.join(
    hermesIntegration,
    "skills",
    "review-bridge-reviewer",
    "SKILL.md",
  ),
  "utf8",
);
assert.match(hermesSkill, /fresh Hermes reviewer/i);
assert.match(hermesSkill, /reviewer_provider:\s*HERMES/);
assert.match(hermesSkill, /successor\.json/);
assert.match(hermesSkill, /successor\.diff/);
assert.match(hermesSkill, /patch\.diff/);
assert.match(hermesSkill, /patch_index/);
assert.match(hermesSkill, /reviewer-scoped/i);
assert.match(hermesSkill, /submit tools update the review\s+ledger/is);
assert.doesNotMatch(hermesSkill, /read-only Review Bridge reviewer tools/i);
assert.doesNotMatch(hermesSkill, /\bprepare_review\b|\bstart_publication\b/);
assertThirdPartyMaterialBoundary(hermesSkill, "packaged Hermes reviewer skill");
const hermesReadme = await fsp.readFile(
  path.join(hermesIntegration, "README.md"),
  "utf8",
);
assert.match(hermesReadme, /separate profiles/i);
assert.match(hermesReadme, /profile-scoped/i);
assert.match(hermesReadme, /auto-injects?\s+every selected/i);
assert.match(hermesReadme, /REVIEW_BRIDGE_HOME/);
assert.match(hermesReadme, /absolute path/i);
assert.match(hermesReadme, /__REVIEW_BRIDGE_RELEASE_PATH__/);
assert.ok(hermesReadme.includes(`v${releaseVersion}`));
assert.match(hermesReadme, /upgrade/i);
assert.match(hermesReadme, /CODEX_TASK/);
assert.match(hermesReadme, /provenance/i);
assert.match(hermesReadme, /not cryptographic/i);
assertDispatchContract(
  hermesReadme,
  "## Dispatch a review from the driver session",
  "packaged Hermes README",
  HERMES_DISPATCH_CONTRACT,
);
assert.match(
  hermesReadme,
  /Remote GitHub Codex publication is performed by the author\/publication side/,
);
assert.ok(await fsp.stat(hermesServer));

// DeepSeek Harness profile integration artifact.
const deepseekRuntimePackage = await readJson(
  path.join(deepseekHarness, "package.json"),
);
assert.equal(deepseekRuntimePackage.version, releaseVersion);
const parsedDeepseekReviewer = parseMcpSnippet(
  await fsp.readFile(
    path.join(deepseekHarness, "cordis", "reviewer.patch.yml"),
    "utf8",
  ),
);
const deepseekReviewerClient = deepSeekHarnessClientEntry(
  parsedDeepseekReviewer,
);
assert.equal(
  deepseekReviewerClient.config.serverName,
  "review-bridge-reviewer",
);
assert.equal(deepseekReviewerClient.config.transport, "stdio");
assert.equal(deepseekReviewerClient.config.command, "node");
assert.deepEqual(deepseekReviewerClient.config.args, [
  `${releasePathPlaceholder}/server/server.mjs`,
  "--role",
  "reviewer",
  "--reviewer-provider",
  "DEEPSEEK_HARNESS",
]);
assert.deepEqual(deepseekReviewerClient.config.env, {
  REVIEW_BRIDGE_HOME: storePlaceholder,
});
assert.equal(deepseekReviewerClient.config.failOnStartupError, true);
// The two host-level scopes the reviewer profile cannot separate on its own.
// Losing either entry would silently hand the reviewer the machine's other
// skills, or the author profile's user-global instructions.
const deepseekSkillPatch = parsedDeepseekReviewer.find(
  (entry) => entry.id === "skill-filesystem",
);
assert.equal(deepseekSkillPatch.config.includeDefaultRoots, false);
assert.deepEqual(deepseekSkillPatch.config.customSkillDirs, [
  `${releasePathPlaceholder}/skills`,
]);
const deepseekInstructionPatch = parsedDeepseekReviewer.find(
  (entry) => entry.id === "agent-instructions",
);
assert.equal(deepseekInstructionPatch.config.dshHome, releasePathPlaceholder);
// A patch replaces `config` wholesale, so a restated entry that drops a
// required key fails at the operator's first launch rather than here.
assert.equal(typeof deepseekInstructionPatch.config.maxBytes, "number");
// That patch is only sound while this directory carries no user-global
// instruction file for the reviewer to inherit.
await assert.rejects(fsp.stat(path.join(deepseekHarness, "AGENTS.md")));
const parsedDeepseekAuthor = parseMcpSnippet(
  await fsp.readFile(
    path.join(deepseekHarness, "cordis", "author.patch.yml"),
    "utf8",
  ),
);
const deepseekAuthorClient = deepSeekHarnessClientEntry(parsedDeepseekAuthor);
assert.equal(deepseekAuthorClient.config.serverName, "review-bridge-author");
assert.deepEqual(deepseekAuthorClient.config.args, [
  `${releasePathPlaceholder}/server/server.mjs`,
  "--role",
  "author",
]);
assert.deepEqual(deepseekAuthorClient.config.env, {
  REVIEW_BRIDGE_HOME: storePlaceholder,
});
// The author snippet must never restrict tools or bind a reviewer provider.
assert.equal("tools" in deepseekAuthorClient.config, false);
assert.equal(
  deepseekAuthorClient.config.args.includes("--reviewer-provider"),
  false,
);
assert.equal(
  parsedDeepseekAuthor.some((entry) =>
    ["skill-filesystem", "agent-instructions"].includes(entry.id),
  ),
  false,
);
const deepseekConfigValues = scalarValues([
  parsedDeepseekReviewer,
  parsedDeepseekAuthor,
]).join("\n");
assert.doesNotMatch(deepseekConfigValues, /\$\(|`|\$\{/);
assert.doesNotMatch(
  deepseekConfigValues,
  /github_pat_|ghp_|GITHUB_TOKEN|GH_TOKEN|Bearer\s+\S/i,
);
const deepseekSkill = await fsp.readFile(
  path.join(deepseekHarness, "skills", "review-bridge-reviewer", "SKILL.md"),
  "utf8",
);
assert.match(deepseekSkill, /fresh DeepSeek Harness reviewer/i);
assert.match(deepseekSkill, /reviewer_provider:\s*DEEPSEEK_HARNESS/);
assert.match(deepseekSkill, /successor\.json/);
assert.match(deepseekSkill, /successor\.diff/);
assert.match(deepseekSkill, /patch\.diff/);
assert.match(deepseekSkill, /patch_index/);
assert.match(deepseekSkill, /reviewer-scoped/i);
assert.match(deepseekSkill, /submit tools update the\s+review ledger/is);
// Round two never inherits round one here, so the skill has to say where the
// decision material comes from instead.
assert.match(deepseekSkill, /session that did not perform round one/i);
assert.doesNotMatch(deepseekSkill, /read-only Review Bridge reviewer tools/i);
assert.doesNotMatch(deepseekSkill, /\bprepare_review\b|\bstart_publication\b/);
assertThirdPartyMaterialBoundary(
  deepseekSkill,
  "packaged DeepSeek Harness reviewer skill",
);
const deepseekReadme = await fsp.readFile(
  path.join(deepseekHarness, "README.md"),
  "utf8",
);
assert.match(deepseekReadme, /separate profiles/i);
assert.match(deepseekReadme, /REVIEW_BRIDGE_HOME/);
assert.match(deepseekReadme, /absolute path/i);
assert.match(deepseekReadme, /__REVIEW_BRIDGE_RELEASE_PATH__/);
assert.ok(deepseekReadme.includes(`v${releaseVersion}`));
// The DeepSeek Harness plugin API is a developer preview, so the snippets are
// only meaningful against the release they were verified on.
assert.match(deepseekReadme, /@deepseek-ai\/dsh@0\.1\.0-rc\.6/);
assert.match(deepseekReadme, /upgrade/i);
assert.match(deepseekReadme, /CODEX_TASK/);
assert.match(deepseekReadme, /provenance/i);
assert.match(deepseekReadme, /not cryptographic/i);
assertDispatchContract(
  deepseekReadme,
  "## Dispatch a review from the driver session",
  "packaged DeepSeek Harness README",
  DEEPSEEK_HARNESS_DISPATCH_CONTRACT,
);
assert.match(
  deepseekReadme,
  /Remote GitHub Codex publication is performed by the author\/publication side/,
);
assert.ok(await fsp.stat(deepseekServer));

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
  const hermesAuthor = await connectHermesConfig(hermesAuthorServer, store);
  const hermesReviewer = await connectHermesConfig(
    hermesReviewerServer,
    store,
  );
  const deepseekAuthor = await connectDeepSeekHarnessConfig(
    deepseekAuthorClient,
    store,
  );
  const deepseekReviewer = await connectDeepSeekHarnessConfig(
    deepseekReviewerClient,
    store,
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

    // Packaged HERMES reviewer: a HERMES-bound review is visible and openable
    // only to the HERMES reviewer process, and the reviewer exposes only the
    // reviewer tool set.
    const [hermesTools, hermesAuthorTools, codexAuthorTools] = await Promise.all([
      hermesReviewer.listTools(),
      hermesAuthor.listTools(),
      author.listTools(),
    ]);
    assert.deepEqual(
      hermesTools.tools.map((tool) => tool.name).sort(),
      reviewerToolNames,
    );
    assert.deepEqual(
      hermesAuthorTools.tools.map((tool) => tool.name).sort(),
      codexAuthorTools.tools.map((tool) => tool.name).sort(),
    );
    for (const tool of reviewerToolNames) {
      assert.equal(
        hermesAuthorTools.tools.some((candidate) => candidate.name === tool),
        false,
      );
    }
    const hermesReview = await call(hermesAuthor, "prepare_review", {
      repository_path: repository,
      base_ref: baseSha,
      requirement: "Change the exported value to 2.",
      implementation_scope: "Update value.js and add a focused test.",
      reviewer_provider: "HERMES",
    });
    assert.equal(hermesReview.reviewer_provider, "HERMES");
    await assert.rejects(
      call(reviewer, "open_review", { review_id: hermesReview.id }),
      /reviewer provider mismatch/,
    );
    const hermesOpened = await call(hermesReviewer, "open_review", {
      review_id: hermesReview.id,
    });
    assert.equal(hermesOpened.current_snapshot.changed_files[0], "value.js");
    await call(hermesReviewer, "submit_review", {
      review_id: hermesReview.id,
      findings: [],
    });
    const hermesGate = await call(hermesAuthor, "finalize_local_gate", {
      review_id: hermesReview.id,
    });
    assert.equal(hermesGate.gate.reviewer_provider, "HERMES");

    // Packaged DEEPSEEK_HARNESS reviewer: the seven reviewer tools come from
    // the server's role alone here, because this client has no allowlist to
    // fall back on.
    const [deepseekTools, deepseekAuthorTools] = await Promise.all([
      deepseekReviewer.listTools(),
      deepseekAuthor.listTools(),
    ]);
    assert.deepEqual(
      deepseekTools.tools.map((tool) => tool.name).sort(),
      reviewerToolNames,
    );
    assert.deepEqual(
      deepseekAuthorTools.tools.map((tool) => tool.name).sort(),
      codexAuthorTools.tools.map((tool) => tool.name).sort(),
    );
    for (const tool of reviewerToolNames) {
      assert.equal(
        deepseekAuthorTools.tools.some((candidate) => candidate.name === tool),
        false,
      );
    }
    const deepseekReview = await call(deepseekAuthor, "prepare_review", {
      repository_path: repository,
      base_ref: baseSha,
      requirement: "Change the exported value to 2.",
      implementation_scope: "Update value.js and add a focused test.",
      reviewer_provider: "DEEPSEEK_HARNESS",
    });
    assert.equal(deepseekReview.reviewer_provider, "DEEPSEEK_HARNESS");
    await assert.rejects(
      call(hermesReviewer, "open_review", { review_id: deepseekReview.id }),
      /reviewer provider mismatch/,
    );
    await assert.rejects(
      call(deepseekReviewer, "open_review", { review_id: hermesReview.id }),
      /reviewer provider mismatch/,
    );
    const deepseekOpened = await call(deepseekReviewer, "open_review", {
      review_id: deepseekReview.id,
    });
    assert.equal(deepseekOpened.current_snapshot.changed_files[0], "value.js");
    await call(deepseekReviewer, "submit_review", {
      review_id: deepseekReview.id,
      findings: [],
    });
    const deepseekGate = await call(deepseekAuthor, "finalize_local_gate", {
      review_id: deepseekReview.id,
    });
    assert.equal(deepseekGate.gate.reviewer_provider, "DEEPSEEK_HARNESS");
  } finally {
    await Promise.all([
      deepseekReviewer.close(),
      deepseekAuthor.close(),
      hermesReviewer.close(),
      hermesAuthor.close(),
      codexReviewer.close(),
      reviewer.close(),
      author.close(),
    ]);
  }
} finally {
  await fsp.rm(temporary, { recursive: true, force: true });
}

process.stdout.write(
  "Packaged Codex author, Codex reviewer, Claude, Hermes, and DeepSeek Harness clients completed full, successor, local publication, remote-only publication, and per-provider role-isolation flows.\n",
);
