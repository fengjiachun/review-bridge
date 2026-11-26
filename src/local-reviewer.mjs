import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const server = fileURLToPath(new URL("./server.mjs", import.meta.url));

// Unless the user chooses, the reviewer model follows the operator's Codex
// configuration and the reasoning effort is pinned, so a lighter everyday
// default cannot weaken reviews.
export const REVIEWER_REQUESTED = Object.freeze({ reasoning_effort: "high" });

export async function reviewerRuntime(storeRoot) {
  let cwd = path.join(storeRoot, "codex-runtime");
  await fsp.mkdir(cwd, { recursive: true, mode: 0o700 });
  cwd = await fsp.realpath(cwd);
  // Inherited GIT_* variables such as GIT_DIR would answer for another repository.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const git = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", stdio: ["ignore", "ignore", "pipe"], env: { ...env, LC_ALL: "C" } });
  if (git.error) throw new Error("Cannot verify the reviewer runtime is outside a Git repository: git could not be started");
  if (git.status !== 0 && (git.status !== 128 ||
      !/^fatal: not a git repository \((or any of the parent directories\): \.git|or any parent up to mount point [^\n]+\))\n/.test(git.stderr ?? ""))) {
    throw new Error(`Cannot verify the reviewer runtime is outside a Git repository: ${(git.stderr ?? "").trim() || `git exited with ${git.status ?? git.signal}`}`);
  }
  if (git.status === 0) {
    throw new Error("Reviewer runtime must be outside a Git repository; choose an external REVIEW_BRIDGE_HOME");
  }
  const name = process.env.REVIEW_BRIDGE_CODEX_COMMAND || "codex";
  const candidates = path.isAbsolute(name) ? [name] :
    (process.env.PATH ?? "").split(path.delimiter).map((directory) => path.resolve(directory, name));
  for (const candidate of candidates) {
    try {
      await fsp.access(candidate, 1);
      // A searchable directory passes the execute check; keep looking.
      if (!(await fsp.stat(candidate)).isFile()) continue;
      return { command: await fsp.realpath(candidate), cwd };
    } catch (error) {
      if (!["ENOENT", "EACCES", "ENOTDIR"].includes(error.code)) throw error;
    }
  }
  throw new Error(`Codex executable unavailable: ${name}`);
}

export async function queryCodexModels(runtime, { timeoutMs = 30000 } = {}) {
  const child = spawn(runtime.command, ["app-server", "--listen", "stdio://"], {
    cwd: runtime.cwd, stdio: ["pipe", "pipe", "pipe"], detached: true,
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-2000); });
  const pending = new Map();
  let sequence = 0;
  let failure;
  const fail = (error) => {
    failure = error;
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };
  child.on("error", fail);
  child.stdin.on("error", fail);
  child.on("close", (code, signal) => fail(new Error(
    `Codex model listing process exited (${signal ?? `code ${code}`})${stderr.trim() ? `: ${stderr.trim()}` : ""}`)));
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const waiter = pending.get(message?.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error == null) waiter.resolve(message.result);
    else if (typeof message.error.message === "string") waiter.reject(new Error(`Codex model listing: ${message.error.message}`));
    else waiter.reject(new Error("Codex model listing: invalid error reply"));
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    if (failure) return reject(failure);
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  const timer = setTimeout(() => fail(new Error("Codex model listing timed out")), timeoutMs);
  try {
    await request("initialize", { clientInfo: { name: "review_bridge", version: "0" } });
    child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    const config = await request("config/read", { includeLayers: false });
    if (config?.config == null || typeof config.config !== "object" || Array.isArray(config.config) ||
        (config.config.model != null && typeof config.config.model !== "string")) {
      throw new Error("Invalid Codex config/read response");
    }
    const models = [];
    const cursors = new Set();
    let cursor = null;
    do {
      const page = await request("model/list", { limit: 100, includeHidden: false, cursor });
      if (!Array.isArray(page?.data)) throw new Error("Invalid Codex model/list response");
      for (const entry of page.data) {
        if (typeof entry?.model !== "string" || !entry.model ||
            !Array.isArray(entry.supportedReasoningEfforts) ||
            entry.supportedReasoningEfforts.some((e) => typeof e?.reasoningEffort !== "string")) {
          throw new Error("Invalid Codex model capabilities");
        }
        models.push({
          model: entry.model, display_name: entry.displayName ?? null,
          reasoning_efforts: entry.supportedReasoningEfforts.map((e) => e.reasoningEffort),
        });
      }
      cursor = page.nextCursor;
      if (cursor != null && (typeof cursor !== "string" || cursors.has(cursor))) {
        throw new Error("Invalid Codex model/list pagination cursor");
      }
      cursors.add(cursor);
    } while (cursor != null);
    return { configured_model: config.config.model ?? null, models };
  } finally {
    clearTimeout(timer);
    lines.close();
    child.stdin.end();
    // The listing has no state to save, and the executable may be a wrapper:
    // end its whole process group, including processes that ignore SIGTERM.
    if (child.pid != null) {
      try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
  }
}

export async function listReviewerModels(storeRoot, provider) {
  if (provider !== "CODEX_TASK") {
    return { reviewer_provider: provider, available: false, reason: "Review Bridge cannot list or choose models for this provider." };
  }
  const { configured_model, models } = await queryCodexModels(await reviewerRuntime(storeRoot));
  return {
    reviewer_provider: provider, available: true, configured_model,
    default_reasoning_effort: { value: REVIEWER_REQUESTED.reasoning_effort, source: "launcher default" },
    models,
  };
}

export async function reviewerRequest(runtime, { model, reasoning_effort }) {
  const requested = {
    reasoning_effort: reasoning_effort ?? REVIEWER_REQUESTED.reasoning_effort,
    model_source: model == null ? "configuration" : "selected",
    reasoning_effort_source: reasoning_effort == null ? "default" : "selected",
  };
  if (model == null && reasoning_effort == null) return requested;
  const { configured_model, models } = await queryCodexModels(runtime);
  const name = model ?? configured_model;
  if (name == null) {
    throw new Error("The Codex configuration names no model to check the reasoning effort against; choose a model too. Nothing was launched.");
  }
  const entry = models.find((candidate) => candidate.model === name);
  if (entry == null) {
    throw new Error(`${model == null ? "The configured model" : "Model"} ${name} is not in Codex's model list. Nothing was launched.`);
  }
  if (!entry.reasoning_efforts.includes(requested.reasoning_effort)) {
    throw new Error(`Model ${name} does not support reasoning effort ${requested.reasoning_effort}; it supports ${entry.reasoning_efforts.join(", ")}. Nothing was launched.`);
  }
  // The configured model that was checked is the one launched, even if the
  // configuration changes before the reviewer starts.
  return { model: name, ...requested };
}

export function codexReviewerArguments(reviewId, requested, storeRoot) {
  const packagedSkill = fileURLToPath(new URL("./reviewer-skill.md", import.meta.url));
  const skill = fs.existsSync(packagedSkill) ? packagedSkill :
    fileURLToPath(new URL("../templates/codex-plugin/skills/review-bridge-reviewer/SKILL.md", import.meta.url));
  const settings = {
    developer_instructions: fs.readFileSync(skill, "utf8"),
    model_reasoning_effort: requested.reasoning_effort,
    "sandbox_workspace_write.network_access": false,
    "sandbox_workspace_write.writable_roots": [],
    "sandbox_workspace_write.exclude_slash_tmp": true,
    "sandbox_workspace_write.exclude_tmpdir_env_var": true,
    approvals_reviewer: "guardian_subagent",
    "memories.use_memories": false,
    "memories.generate_memories": false,
    "mcp_servers.review-bridge-author.command": "node",
    "mcp_servers.review-bridge-author.enabled": false,
    "mcp_servers.review-bridge-reviewer.enabled": true,
    "mcp_servers.review-bridge-reviewer.command": process.execPath,
    "mcp_servers.review-bridge-reviewer.args": [server, "--role", "reviewer", "--reviewer-provider", "CODEX_TASK"],
    "mcp_servers.review-bridge-reviewer.env.REVIEW_BRIDGE_HOME": path.resolve(storeRoot),
  };
  return [
    "exec", "--skip-git-repo-check", "--sandbox", "workspace-write",
    ...(requested.model == null ? [] : ["--model", requested.model]),
    ...Object.entries(settings).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`]),
    "-c", "approval_policy={granular={rules=false,sandbox_approval=false,skill_approval=false,request_permissions=false,mcp_elicitations=false}}",
    `Independently review Review Bridge task ${reviewId} using the packaged Review Bridge reviewer skill. Require reviewer_provider: CODEX_TASK, follow the review strategy, and submit every actionable finding.`,
  ];
}

export async function startLocalReviewer(runtime, args, attemptRoot) {
  const log = fs.openSync(path.join(attemptRoot, "process.log"), "a", 0o600);
  const runner = fileURLToPath(new URL("./reviewer-runner.mjs", import.meta.url));
  const child = spawn(process.execPath, [runner, attemptRoot], {
    cwd: runtime.cwd, detached: true, stdio: ["ignore", log, log],
    env: { ...process.env, REVIEW_BRIDGE_LAUNCH: JSON.stringify({ command: runtime.command, args }) },
  });
  fs.closeSync(log);
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const started = await readDispatchReceipt(attemptRoot, "started.json");
    if (started) return started;
    const exited = await readDispatchReceipt(attemptRoot, "exit.json");
    if (exited) throw new Error(`Reviewer failed to start: ${exited.error ?? exited.code}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const error = new Error("Reviewer startup is indeterminate; reconcile this attempt before retrying");
  error.code = "DISPATCH_INDETERMINATE";
  throw error;
}

export async function readDispatchReceipt(attemptRoot, name) {
  try {
    const receipt = JSON.parse(await fsp.readFile(path.join(attemptRoot, name), "utf8"));
    if (name === "started.json" && (receipt.task_id !== path.basename(attemptRoot) ||
        !Number.isSafeInteger(receipt.pid) || receipt.pid <= 0 ||
        !Number.isFinite(Date.parse(receipt.process_started_at)))) {
      throw new Error("Invalid reviewer started-process receipt");
    }
    return receipt;
  }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
