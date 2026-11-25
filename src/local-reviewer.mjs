import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const server = fileURLToPath(new URL("./server.mjs", import.meta.url));

// The reviewer model follows the operator's Codex configuration; only the
// reasoning effort is pinned, so a lighter everyday default cannot weaken reviews.
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
