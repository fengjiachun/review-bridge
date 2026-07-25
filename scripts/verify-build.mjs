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
  : path.join(projectRoot, "dist", "review-bridge-v0.1.0");
const marketplaceRoot = path.join(outputRoot, "codex-marketplace");
const pluginRoot = path.join(marketplaceRoot, "plugins", "review-bridge");
const authorServer = path.join(pluginRoot, "server", "server.mjs");
const reviewerRoot = path.join(outputRoot, "claude-extension-source");
const reviewerServer = path.join(reviewerRoot, "server", "server.mjs");
const mcpb = path.join(outputRoot, "review-bridge-reviewer-v0.1.0.mcpb");
const dxt = path.join(outputRoot, "review-bridge-reviewer-v0.1.0.dxt");
const sourceArchive = path.join(outputRoot, "review-bridge-source-v0.1.0.zip");

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

async function connect(serverPath, role, store) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath, "--role", role],
    env: { ...process.env, REVIEW_BRIDGE_HOME: store },
    stderr: "pipe",
  });
  const client = new Client({ name: "review-bridge-verifier", version: "0.1.0" });
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

const marketplace = await readJson(
  path.join(marketplaceRoot, ".agents", "plugins", "marketplace.json"),
);
assert.equal(marketplace.plugins[0].name, "review-bridge");
assert.equal(marketplace.plugins[0].source.path, "./plugins/review-bridge");

const plugin = await readJson(path.join(pluginRoot, ".codex-plugin", "plugin.json"));
assert.equal(plugin.name, "review-bridge");
assert.equal(plugin.mcpServers, "./.mcp.json");
const workflowSkillPath = path.join(
  pluginRoot,
  "skills",
  "review-bridge-workflow",
  "SKILL.md",
);
assert.ok(await fsp.stat(workflowSkillPath));
const workflowSkill = await fsp.readFile(workflowSkillPath, "utf8");
assert.match(workflowSkill, /Post a PR comment containing exactly `@codex review`/);
assert.match(workflowSkill, /Any new commit invalidates the GitHub review gate/);
assert.match(workflowSkill, /start a new local Review Bridge task/);

const mcpConfig = await readJson(path.join(pluginRoot, ".mcp.json"));
assert.equal(mcpConfig.mcpServers["review-bridge-author"].cwd, ".");
assert.equal(
  mcpConfig.mcpServers["review-bridge-author"].args[0],
  "./server/server.mjs",
);

const extension = await readJson(path.join(reviewerRoot, "manifest.json"));
assert.equal(extension.manifest_version, "0.3");
assert.equal(extension.server.entry_point, "server/server.mjs");

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
  await fsp.writeFile(
    path.join(repository, "value.js"),
    "export const value = 2;\n",
  );

  const author = await connect(authorServer, "author", store);
  const reviewer = await connect(reviewerServer, "reviewer", store);
  try {
    const prepared = await call(author, "prepare_review", {
      repository_path: repository,
      base_ref: "HEAD",
      requirement: "Change the exported value to 2.",
      implementation_scope: "Update value.js and add a focused test.",
    });
    assert.equal(prepared.status, "WAITING_FOR_REVIEW");

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
  } finally {
    await reviewer.close();
    await author.close();
  }
} finally {
  await fsp.rm(temporary, { recursive: true, force: true });
}

process.stdout.write("Packaged Codex and Claude clients completed the two-round flow.\n");
