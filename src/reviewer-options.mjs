import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { atomicWriteFile, canonicalJson } from "./storage.mjs";

const digest = (value) => crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");

export async function reviewerRuntime(storeRoot) {
  let cwd = path.join(storeRoot, "codex-runtime");
  await fsp.mkdir(cwd, { recursive: true, mode: 0o700 });
  cwd = await fsp.realpath(cwd);
  if (spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, stdio: "ignore" }).status === 0) {
    throw new Error("Reviewer runtime must be outside a Git repository; choose an external REVIEW_BRIDGE_HOME");
  }
  const name = process.env.REVIEW_BRIDGE_CODEX_COMMAND || "codex";
  const candidates = path.isAbsolute(name) ? [name] :
    (process.env.PATH ?? "").split(path.delimiter).map((directory) => path.resolve(directory, name));
  for (const candidate of candidates) {
    try {
      await fsp.access(candidate, 1);
      return { command: await fsp.realpath(candidate), cwd };
    } catch (error) {
      if (!["ENOENT", "EACCES"].includes(error.code)) throw error;
    }
  }
  throw new Error(`Codex executable unavailable: ${name}`);
}

// Every query starts the same CLI, home, and neutral cwd used for dispatch.
// model/list exposes no force-refresh or upstream cache timestamp contract.
export async function queryCodexModels(runtime, { timeoutMs = 30000 } = {}) {
  const child = spawn(runtime.command, ["app-server", "--listen", "stdio://"], {
    cwd: runtime.cwd, stdio: ["pipe", "pipe", "ignore"],
  });
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
  child.on("exit", () => fail(new Error("Codex model discovery process exited")));
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(`Codex discovery: ${message.error.message}`));
    else waiter.resolve(message.result);
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    if (failure) return reject(failure);
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  const timer = setTimeout(() => {
    fail(new Error("Codex model discovery timed out; retry discovery"));
    child.kill();
  }, timeoutMs);
  try {
    const initialized = await request("initialize", {
      clientInfo: { name: "review_bridge", version: "0.16.0" },
    });
    child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    const account = await request("account/read", { refreshToken: false });
    const config = await request("config/read", { includeLayers: false });
    const models = [];
    const cursors = new Set();
    let cursor = null;
    do {
      const page = await request("model/list", { limit: 100, includeHidden: false, cursor });
      if (!Array.isArray(page?.data)) throw new Error("Invalid Codex model/list response");
      for (const entry of page.data) {
        if (entry.hidden === true) continue;
        if (typeof entry.model !== "string" || !entry.model ||
            !Array.isArray(entry.supportedReasoningEfforts) ||
            entry.supportedReasoningEfforts.some((e) => typeof e.reasoningEffort !== "string")) {
          throw new Error("Invalid Codex model capabilities");
        }
        models.push({
          id: entry.id, model: entry.model, display_name: entry.displayName,
          description: entry.description, hidden: false, is_default: entry.isDefault === true,
          default_reasoning_effort: entry.defaultReasoningEffort,
          reasoning_efforts: entry.supportedReasoningEfforts.map((e) => ({
            value: e.reasoningEffort, description: e.description,
          })),
        });
      }
      cursor = page.nextCursor;
      if (cursor != null && (typeof cursor !== "string" || cursors.has(cursor))) {
        throw new Error("Invalid Codex model/list pagination cursor");
      }
      cursors.add(cursor);
    } while (cursor != null);
    if (!models.length) throw new Error("Codex returned no picker-visible models");
    return {
      environment_id: digest({ host: os.hostname(), codex_home: process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), runtime, initialized, account, config }),
      runtime: { ...runtime, host: os.hostname(), client: initialized?.userAgent ?? null },
      source: "codex app-server model/list", queried_at: new Date().toISOString(),
      freshness: "runtime_catalog; upstream cache source and age unavailable; not a forced network refresh",
      models,
    };
  } finally {
    clearTimeout(timer);
    lines.close();
    child.kill();
  }
}

function preferencePath(storeRoot, repository, environmentId) {
  return path.join(storeRoot, "reviewer-preferences", `${digest({ repository, environmentId })}.json`);
}

export async function discoverReviewerOptions(storeRoot, repository, provider) {
  if (provider !== "CODEX_TASK") return {
    reviewer_provider: provider, available: false, models: [],
    limitation: "This provider has no Review Bridge capability-discovery/control adapter. Select in its own client; requested and observed configuration are unavailable to Review Bridge.",
  };
  repository = await fsp.realpath(repository);
  const catalog = await queryCodexModels(await reviewerRuntime(storeRoot));
  let previous = null;
  try { previous = JSON.parse(await fsp.readFile(preferencePath(storeRoot, repository, catalog.environment_id), "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  let suggested = null;
  if (previous && selectionIsSupported(catalog, previous)) suggested = previous;
  if (!suggested) {
    const model = catalog.models.find((m) => m.is_default) ?? catalog.models[0];
    const effort = model.reasoning_efforts.some((e) => e.value === "high")
      ? "high" : model.default_reasoning_effort;
    suggested = { model: model.model, reasoning_effort: effort, environment_id: catalog.environment_id };
    if (!selectionIsSupported(catalog, suggested)) suggested = null;
  }
  return { reviewer_provider: provider, available: true, ...catalog, suggested, selection_required: true };
}

function selectionIsSupported(catalog, selected) {
  return selected.environment_id === catalog.environment_id && catalog.models.some((m) =>
    m.model === selected.model && m.reasoning_efforts.some((e) => e.value === selected.reasoning_effort));
}

export async function validateReviewerSelection(storeRoot, selection) {
  if (!selection?.model || !selection?.reasoning_effort || !selection?.environment_id) {
    throw new Error("Reviewer selection required: discover_reviewer_options, then explicitly choose model, reasoning_effort and environment_id");
  }
  const catalog = await queryCodexModels(await reviewerRuntime(storeRoot));
  if (!selectionIsSupported(catalog, selection)) {
    throw new Error("Reviewer selection unavailable or execution environment changed; rediscover and explicitly select again. No fallback was applied.");
  }
  return {
    requested: { model: selection.model, reasoning_effort: selection.reasoning_effort, environment_id: selection.environment_id },
    observed: { status: "unavailable" },
    validated_at: catalog.queried_at, source: catalog.source, freshness: catalog.freshness,
    runtime: catalog.runtime,
  };
}

export async function rememberReviewerSelection(storeRoot, repository, configuration) {
  const file = preferencePath(storeRoot, await fsp.realpath(repository), configuration.requested.environment_id);
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await atomicWriteFile(file, `${JSON.stringify(configuration.requested)}\n`);
}
