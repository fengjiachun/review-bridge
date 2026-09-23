import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const server = fileURLToPath(new URL("./server.mjs", import.meta.url));

export function codexReviewerArguments(reviewId, requested, storeRoot, prompt) {
  const settings = {
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
    "exec", "--skip-git-repo-check", "--sandbox", "workspace-write", "--model", requested.model,
    ...Object.entries(settings).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`]),
    "-c", "approval_policy={granular={rules=false,sandbox_approval=false,skill_approval=false,request_permissions=false,mcp_elicitations=false}}",
    prompt ?? `Independently review Review Bridge task ${reviewId} using the packaged Review Bridge reviewer skill. Require reviewer_provider: CODEX_TASK, follow the review strategy, and submit every actionable finding.`,
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
