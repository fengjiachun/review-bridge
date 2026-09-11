import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadReview, prepareReview } from "../src/core.mjs";
import { commit, fixture as repositoryFixture, git as fixtureGit } from "./helpers/repository-fixture";

// The advisory sandbox launcher is packaged beside the other plugin scripts
// and imports the server the same way, so it is exercised from a
// plugin-shaped copy: scripts/ holding the launcher, server/ linking to src/.
// Its --dry-run validates every input and prints the docker commands without
// touching Docker, which is what makes the mount table and the launch line
// assertable in CI.

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const panelSource = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "templates", "codex-plugin", "scripts", "advisory-panel-checkout.mjs");
const launcherSource = path.join(
  projectRoot,
  "templates",
  "codex-plugin",
  "scripts",
  "advisory-sandbox-launch.mjs",
);
const REVIEW_ID = "rb-2026-09-10T000000-000Z-0badcafe";

async function fixture(t, { ledger = {}, checkoutName = "panel/review-bridge", checkoutPath = null, realReview = false, beforePrepare = null } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-advisory-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const plugin = path.join(root, "plugin");
  await fsp.mkdir(path.join(plugin, "scripts"), { recursive: true });
  await fsp.copyFile(launcherSource, path.join(plugin, "scripts", "advisory-sandbox-launch.mjs"));
  await fsp.copyFile(path.join(path.dirname(launcherSource), "isolated-git.mjs"), path.join(plugin, "scripts", "isolated-git.mjs"));
  await fsp.symlink(path.join(projectRoot, "src"), path.join(plugin, "server"));

  const home = path.join(root, "home");
  const marketplace = path.join(home, "Runtime", "codex-marketplace");
  const pluginSource = path.join(marketplace, "plugins", "review-bridge");
  let checkout = checkoutPath ?? path.join(home, checkoutName);
  let store = path.join(root, "store");
  let reviewId = REVIEW_ID;
  if (realReview) {
    // A ledger the server itself wrote, over a real repository, so the fake
    // reviewer below can move it with the server's own submit.
    const repo = await repositoryFixture();
    t.after(() => fsp.rm(repo.root, { recursive: true, force: true }));
    await commit(repo.repository, "export const value = 2;\n");
    if (beforePrepare) await beforePrepare(repo.repository);
    const prepared = await prepareReview(repo.store, {
      repositoryPath: repo.repository,
      baseRef: repo.baseSha,
      requirement: "Author's claim (unverified), PR #1: \"change\"",
      implementationScope: "advisory panel member",
      forceFullReview: true,
      reviewerProvider: "CODEX_TASK",
      advisory: true,
    });
    checkout = repo.repository;
    store = repo.store;
    reviewId = prepared.id;
  }
  await fsp.mkdir(path.join(home, ".codex"), { recursive: true });
  await fsp.writeFile(path.join(home, ".codex", "auth.json"), "{}\n");
  await fsp.writeFile(
    path.join(home, ".codex", "config.toml"),
    `model = "x"\n\n[marketplaces.review-bridge-local]\nsource_type = "local"\nsource = "${marketplace}"\n\n[memories]\nuse_memories = true\n`,
  );
  await fsp.mkdir(path.join(marketplace, ".agents", "plugins"), { recursive: true });
  await fsp.writeFile(path.join(marketplace, ".agents", "plugins", "marketplace.json"), "{}\n");
  await fsp.mkdir(path.join(pluginSource, ".codex-plugin"), { recursive: true });
  await fsp.mkdir(path.join(pluginSource, "server"), { recursive: true });
  await fsp.writeFile(
    path.join(pluginSource, ".codex-plugin", "plugin.json"),
    JSON.stringify({ name: "review-bridge", version: "9.9.9" }),
  );
  await fsp.writeFile(path.join(pluginSource, "server", "server.mjs"), "");
  if (!realReview) {
    await fsp.mkdir(checkout, { recursive: true });
    // The ledger's repository_path is always a repository; the credential
    // precheck reads its configuration.
    if (!checkoutPath) spawnSync("git", ["-C", checkout, "init", "-q", "--template="]);
    // The ledger's last round names the commit under review; the fake
    // checkout is at it (an empty commit made with -c, so nothing lands in
    // .git/config), or a placeholder when the checkout cannot answer.
    if (spawnSync("git", ["-C", checkout, "rev-parse", "HEAD"]).status !== 0) {
      spawnSync("git", ["-C", checkout, "-c", "user.name=fixture", "-c", "user.email=fixture@example.com", "commit", "-q", "--allow-empty", "-m", "init"]);
    }
    const fakeHead = spawnSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim() || "0".repeat(40);
    await fsp.mkdir(path.join(store, "reviews", REVIEW_ID), { recursive: true });
    await fsp.writeFile(
      path.join(store, "reviews", REVIEW_ID, "review.json"),
      JSON.stringify({
        id: REVIEW_ID,
        reviewer_provider: "CODEX_TASK",
        advisory: true,
        status: "WAITING_FOR_REVIEW",
        state_version: 1,
        repository_path: checkout,
        rounds: [{ round: 1, base_sha: fakeHead, head_sha: fakeHead, worktree_clean: true, overlays: [] }],
        ...ledger,
      }),
    );
  }
  return {
    root,
    plugin,
    launcher: path.join(plugin, "scripts", "advisory-sandbox-launch.mjs"),
    home,
    marketplace,
    pluginSource,
    checkout,
    store,
    reviewId,
    authJson: path.join(home, ".codex", "auth.json"),
  };
}

// A stand-in `docker` on PATH: answers the launcher's version, image, network,
// proxy, log, and cleanup calls, plays the boundary probe back as JSON
// records derived from the probe's own argument, and plays the reviewer by
// moving the staged ledger with the server's own submit — or, when asked,
// by also leaving the kind of trace the copy-back must refuse.
async function fakeDocker(f, { tamper = "", directCode = "", big = false, serverError = "", present = "", imagePresent = "", baselineChildren = "", baselineHasExpected = false, leak = "", exit = "", logs = "", volumeRmFail = false, head = "", rmFail = "", sessions = "", storeKb = "", storeLargest = "", dns = "", volumeUnbounded = false, huge = false, fatRollout = false, sessionsFile = false } = {}) {
  const bin = path.join(f.root, "bin");
  await fsp.mkdir(bin, { recursive: true });
  const runner = path.join(bin, "fake-run.mjs");
  await fsp.writeFile(
    runner,
    `import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
if (args.includes("sh")) {
  const command = args[args.length - 1];
  // The store volume stands in for itself: the fake reviewer writes straight
  // into the scratch copy the launcher copies out to, so the copies in and
  // out are no-ops and only the measurement has to answer.
  if (command.includes("du -sk")) { process.stdout.write((process.env.FAKE_STORE_KB || "8") + " " + (process.env.FAKE_STORE_LARGEST || "4096") + "\\n"); process.exit(0); }
  const mode = process.env.FAKE_SESSIONS || "";
  if (command.includes("/sessions")) {
    if (mode === "fail") { process.stderr.write("cp: cannot create /out/sessions"); process.exit(1); }
    if (mode === "none") { process.stdout.write("no-sessions-recorded\\n"); process.exit(0); }
  }
  process.exit(0);
}
const bind = (dst) => args.map((a) => a.match(new RegExp("^type=bind,src=(.*),dst=" + dst + "(,readonly)?$"))).find(Boolean)?.[1];
if (!args.includes("codex")) {
  const spec = JSON.parse(args[args.length - 1]);
  const mounted = spec.mode === "mounted";
  const out = [];
  // A path the host mount brings in is present only when mounted; a path
  // the image itself has is present both times.
  for (const p of spec.absent) out.push({ kind: "path", path: p, present: (mounted && p === process.env.FAKE_PRESENT) || p === process.env.FAKE_IMAGE_PRESENT });
  // What a real mount adds to an ancestor: the checkout's next segment below
  // it, home directory or not.
  const wayDown = (p) => path.relative(p, spec.checkout).split(path.sep)[0];
  const imageChildren = (process.env.FAKE_BASELINE_CHILDREN || "").split(",").filter(Boolean);
  spec.ancestors.forEach((p) => {
    const image = process.env.FAKE_BASELINE_HAS_EXPECTED ? [...imageChildren, wayDown(p)] : imageChildren;
    out.push({ kind: "ancestor", path: p, children: mounted ? [...new Set([...image, wayDown(p), ...(process.env.FAKE_LEAK ? [process.env.FAKE_LEAK] : [])])] : image });
  });
  if (!mounted) { process.stdout.write(out.map((r) => JSON.stringify(r)).join("\\n") + "\\n"); process.exit(0); }
  // What is bound at the recorded path is the launcher's clone; the fake
  // reads that source, as the real container reads the mount.
  const mountedCheckout = bind(spec.checkout.replace(/[.*+?^()|[\\]\\\\]/g, "\\\\$&")) || spec.checkout;
  if (process.env.FAKE_CHECKOUT_LOG) {
    fs.writeFileSync(process.env.FAKE_CHECKOUT_LOG, JSON.stringify({
      checkout: mountedCheckout,
      entries: fs.readdirSync(path.join(mountedCheckout, ".git")).sort(),
      fakeObject: fs.existsSync(path.join(mountedCheckout, ".git", "objects", "ab", "0".repeat(38))),
      remoteUrl: spawnSync("git", ["-C", mountedCheckout, "config", "remote.origin.url"], { encoding: "utf8" }).stdout.trim(),
    }));
  }
  out.push({ kind: "checkout-head", value: process.env.FAKE_HEAD || spawnSync("git", ["-C", mountedCheckout, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim() });
  out.push({ kind: "store-writable", value: true });
  out.push({ kind: "egress", via: "proxy", code: "000", exit: 56 });
  out.push({ kind: "egress", via: "direct", code: process.env.FAKE_DIRECT_CODE || "000", exit: process.env.FAKE_DIRECT_CODE ? 0 : 6 });
  out.push({ kind: "codex-version", value: "codex-cli 0.153.4" });
  out.push({ kind: "dns", name: "egress", resolved: process.env.FAKE_DNS !== "no-alias" });
  out.push({ kind: "dns", name: "example.com", resolved: process.env.FAKE_DNS === "leak" });
  out.push({ kind: "uid", value: process.getuid() });
  process.stdout.write(out.map((r) => JSON.stringify(r)).join("\\n") + "\\n");
} else {
  // The staged store is a volume now; the fake writes where the launcher
  // copies it out to, which is the scratch store directory.
  const staged = path.join(path.dirname(bind("/codex-home/config.toml")), "store");
  const reviewId = args[args.length - 1].match(/rb-[0-9TZ-]+-[a-f0-9]{8}/)[0];
  const { submitInitialReview } = await import(process.env.FAKE_CORE);
  process.stdout.write("OpenAI Codex v0.153.4\\napproval: granular\\nsandbox: danger-full-access\\nsession id: 00000000-0000-0000-0000-000000000000\\n");
  // Every call is printed as codex prints it and recorded as codex records
  // it: one McpToolCall item in the main rollout (session id as in the
  // header). Variants leave a call unrecorded, record it as a transport
  // failure, or park an answered failure in a subagent rollout.
  const records = [];
  const scratch = path.dirname(bind("/codex-home/config.toml"));
  let n = 0;
  const call = (tool, { outcome = "completed", record = true } = {}) => {
    n += 1;
    process.stdout.write("mcp: review-bridge-reviewer/" + tool + " started\\nmcp: review-bridge-reviewer/" + tool + (outcome === "completed" ? " (completed)" : " (failed)") + "\\n");
    if (!record) return;
    const item = { type: "McpToolCall", id: "exec-" + n, server: "review-bridge-reviewer", tool, arguments: {}, status: outcome === "completed" ? "completed" : "failed" };
    if (outcome === "completed") item.result = { content: [{ type: "text", text: "{}" }] };
    if (outcome === "answered") item.result = { content: [{ type: "text", text: JSON.stringify({ error: "git show failed (128): fatal: path 'nope.js' does not exist in 'abc'" }) }], isError: true };
    if (outcome === "transport") item.error = "MCP tool call failed: transport closed";
    records.push(item);
  };
  call("list_pending_reviews");
  call("open_review");
  const variant = process.env.FAKE_SERVER_ERROR || "";
  if (variant === "answered") call("read_snapshot_file", { outcome: "answered" });
  if (variant === "unexplained") { call("read_snapshot_file", { outcome: "answered" }); call("search_snapshot", { outcome: "transport" }); }
  if (variant === "no-record") call("search_snapshot", { outcome: "answered", record: false });
  if (variant === "subagent-answered") call("search_snapshot", { outcome: "transport" });
  const tamper = process.env.FAKE_TAMPER || "";
  if (tamper !== "no-verdict") {
    await submitInitialReview(staged, reviewId, [{ severity: "major", title: "one", explanation: "first", path: "app.js", line: 1 }], "CODEX_TASK");
    if (process.env.FAKE_BIG) for (let i = 0; i < 40000; i += 1) process.stdout.write("codex\\nfiller line " + i + " ".repeat(60) + "\\n");
    // A reviewer that never stops writing: 70 MB, past the transcript's bound.
    if (process.env.FAKE_HUGE) { const megabyte = "x".repeat(1024 * 1024 - 1) + "\\n"; for (let i = 0; i < 70; i += 1) process.stdout.write(megabyte); }
    call("submit_review");
  }
  if (variant === "extra-line") process.stdout.write("mcp: review-bridge-reviewer/list_pending_reviews started\\nmcp: review-bridge-reviewer/list_pending_reviews (completed)\\n");
  if (process.env.FAKE_SESSIONS_FILE) { fs.writeFileSync(path.join(scratch, "sessions"), "not a directory"); }
  else fs.mkdirSync(path.join(scratch, "sessions"), { recursive: true });
  const event = (item) => JSON.stringify({ type: "event_msg", payload: { type: "item_completed", item } });
  // A rollout larger than the launcher will read, and a sessions path that is
  // not a directory at all.
  if (process.env.FAKE_FAT_ROLLOUT) fs.writeFileSync(path.join(scratch, "sessions", "rollout-fat.jsonl"), "x".repeat(9 * 1024 * 1024));
  fs.writeFileSync(path.join(scratch, "sessions", "rollout-main.jsonl"), [
    JSON.stringify({ type: "session_meta", payload: { id: "00000000-0000-0000-0000-000000000000" } }),
    ...records.map(event),
    // Noise that must explain nothing: an error object in a script output
    // and in a shell item's text.
    JSON.stringify({ type: "response_item", payload: { type: "custom_tool_call_output", call_id: "c9", output: JSON.stringify({ error: "x" }) } }),
    event({ type: "CommandExecution", id: "exec-9", status: "completed", aggregated_output: JSON.stringify({ error: "x" }) }),
  ].join("\\n") + "\\n");
  if (variant === "subagent-answered") {
    // A subagent's rollout holding an answered failure for the same tool:
    // it must not stand in for the main run's transport failure.
    fs.writeFileSync(path.join(scratch, "sessions", "rollout-sub.jsonl"), [
      JSON.stringify({ type: "session_meta", payload: { id: "11111111-1111-1111-1111-111111111111", parent_thread_id: "00000000-0000-0000-0000-000000000000" } }),
      event({ type: "McpToolCall", id: "exec-sub", server: "review-bridge-reviewer", tool: "search_snapshot", arguments: {}, status: "failed", result: { content: [{ type: "text", text: JSON.stringify({ error: "answered elsewhere" }) }], isError: true } }),
    ].join("\\n") + "\\n");
  }
  const reviewDir = path.join(staged, "reviews", reviewId);
  const ledgerPath = path.join(reviewDir, "review.json");
  const editLedger = (edit) => { const l = JSON.parse(fs.readFileSync(ledgerPath, "utf8")); edit(l); fs.writeFileSync(ledgerPath, JSON.stringify(l, null, 2) + "\\n"); };
  if (tamper === "forge-clean") editLedger((l) => { l.status = "CLEAN"; l.findings = []; });
  if (tamper === "findings") editLedger((l) => { l.findings.push({ ...l.findings[0], id: "F-002", title: "planted", status: "RESOLVED" }); });
  if (tamper === "hash") editLedger((l) => { l.rounds[0].snapshot_hash = "0".repeat(64); });
  if (tamper === "outside") fs.writeFileSync(path.join(staged, "other.txt"), "x");
  // A sparse file: the container's block count says nothing, the apparent
  // size is what the host would read.
  if (tamper === "big-file") { const fd = fs.openSync(path.join(reviewDir, "snapshot.bin"), "w"); fs.ftruncateSync(fd, 9 * 1024 * 1024); fs.closeSync(fd); }
  if (tamper === "extra") fs.writeFileSync(path.join(reviewDir, "notes.txt"), "x");
  if (tamper === "snapshot") fs.appendFileSync(path.join(reviewDir, "rounds", "1", "manifest.json"), "\\n");
  if (tamper === "id") editLedger((l) => { l.advisory = false; });
  if (tamper === "sibling") { fs.mkdirSync(path.join(staged, "reviews", "rb-2026-01-01T000000-000Z-00000000"), { recursive: true }); fs.writeFileSync(path.join(staged, "reviews", "rb-2026-01-01T000000-000Z-00000000", "review.json"), "{}"); }
  if (process.env.FAKE_EXIT) process.exit(Number(process.env.FAKE_EXIT));
}
`,
  );
  await fsp.writeFile(
    path.join(bin, "docker"),
    `#!/usr/bin/env bash
set -e
[ -n "\${FAKE_CALLS}" ] && echo "$*" >> "\${FAKE_CALLS}"
case "$1 $2" in
  "version --format") echo "28.3.2 linux/arm64" ;;
  "image inspect") exit 0 ;;
  "volume rm") [ -n "\${FAKE_VOLUME_RM_FAIL}" ] && { echo "Error response from daemon: volume is in use" >&2; exit 1; }; exit 0 ;;
  "rm -f") case "\${FAKE_RM_FAIL}:$3" in nosuch:*-codex) echo "Error response from daemon: No such container: $3" >&2; exit 1 ;; other:*-codex) echo "Error response from daemon: boom" >&2; exit 1 ;; esac; exit 0 ;;
  "network create"|"network connect"|"network rm"|"stop -t") exit 0 ;;
  "volume create") exit 0 ;;
  "volume inspect") if [ -n "\${FAKE_VOLUME_UNBOUNDED}" ]; then echo '{"type":"tmpfs"}'; else echo '{"device":"tmpfs","o":"size=64m,mode=0700,uid=502,gid=20","type":"tmpfs"}'; fi ;;
  "logs "*) # the readiness poll (--tail 20000) sees a short log; the final collection (--tail 200000) is where the variants bite
    case "$*" in *"--tail 200000"*) collecting=1 ;; *) collecting= ;; esac
    if [ -n "$collecting" ] && [ -n "\${FAKE_LOGS_FAIL}" ]; then echo "Error response from daemon: log driver failed" >&2; exit 1; fi
    echo "2026-09-10T00:00:00.000Z listening 3128 allow chatgpt.com,api.openai.com"; echo "2026-09-10T00:00:01.000Z deny connect example.com:443"
    if [ -n "$collecting" ] && [ -n "\${FAKE_LOGS_BIG}" ]; then i=0; while [ $i -lt 30000 ]; do echo "2026-09-10T00:00:02.000Z allow connect chatgpt.com:443 filler-padding-to-exceed-the-default-buffer-xxxxxxxxxxxxxxxxxxxxxxxxxx"; i=$((i+1)); done
    elif [ -n "$collecting" ] && [ -n "\${FAKE_LOGS_SUPPRESSED}" ]; then i=0; while [ $i -lt 1000 ]; do echo "2026-09-10T00:00:02.000Z deny connect looped.example:443"; i=$((i+1)); done; i=0; while [ $i -lt 4 ]; do echo "2026-09-10T00:00:03.000Z deny connect looped.example:443 ×1000 suppressed"; i=$((i+1)); done
    else echo "2026-09-10T00:00:02.000Z allow connect chatgpt.com:443"; fi ;;
  "run -d") echo 0123456789ab ;;
  "run --rm") exec "\${FAKE_NODE}" "\${FAKE_RUN}" "$@" ;;
  *) echo "fake docker: unexpected $*" >&2; exit 9 ;;
esac
`,
    { mode: 0o755 },
  );
  return {
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_NODE: process.execPath,
    FAKE_RUN: runner,
    FAKE_CORE: path.join(f.plugin, "server", "core.mjs"),
    FAKE_TAMPER: tamper,
    FAKE_DIRECT_CODE: directCode,
    FAKE_BIG: big ? "1" : "",
    FAKE_SERVER_ERROR: serverError,
    FAKE_PRESENT: present,
    FAKE_IMAGE_PRESENT: imagePresent,
    FAKE_BASELINE_CHILDREN: baselineChildren,
    FAKE_BASELINE_HAS_EXPECTED: baselineHasExpected ? "1" : "",
    FAKE_LEAK: leak,
    FAKE_EXIT: exit,
    FAKE_LOGS_BIG: logs === "big" ? "1" : "",
    FAKE_LOGS_SUPPRESSED: logs === "suppressed" ? "1" : "",
    FAKE_LOGS_FAIL: logs === "fail" ? "1" : "",
    FAKE_CALLS: path.join(bin, "calls.log"),
    FAKE_VOLUME_RM_FAIL: volumeRmFail ? "1" : "",
    FAKE_RM_FAIL: rmFail,
    FAKE_SESSIONS: sessions,
    FAKE_STORE_KB: storeKb,
    FAKE_STORE_LARGEST: storeLargest,
    FAKE_DNS: dns,
    FAKE_HUGE: huge ? "1" : "",
    FAKE_FAT_ROLLOUT: fatRollout ? "1" : "",
    FAKE_SESSIONS_FILE: sessionsFile ? "1" : "",
    FAKE_VOLUME_UNBOUNDED: volumeUnbounded ? "1" : "",
    FAKE_HEAD: head,
    FAKE_CHECKOUT_LOG: path.join(bin, "checkout.json"),
  };
}

function launch(f, args, env = {}, { maxBuffer = 64 * 1024 * 1024 } = {}) {
  return spawnSync(process.execPath, [f.launcher, ...args], {
    encoding: "utf8",
    maxBuffer,
    env: {
      ...process.env,
      HOME: f.home,
      CODEX_HOME: undefined,
      REVIEW_BRIDGE_HOME: f.store,
      ...env,
    },
  });
}

test("--help states the launch, the mounts, the egress allowlist, and the residual", async (t) => {
  const f = await fixture(t);
  const result = launch(f, ["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: advisory-sandbox-launch\.mjs --review-id <id>/);
  assert.match(result.stdout, /only launch an\s+advisory review takes/);
  assert.match(result.stdout, /Fails closed, exit 2, when Docker is unavailable or any mount source is\s+missing/);
  assert.match(result.stdout, /The host store is never mounted/);
  assert.match(result.stdout, /under \/private\/tmp\/ or\s+\/Volumes\/, because Docker Desktop stops serving files there/);
  assert.match(result.stdout, /the validated verdict was copied back to the host store/);
  assert.match(result.stdout, /auth\.json is bind-mounted read-only and never copied\s+into an image layer/);
  assert.match(result.stdout, /admits chatgpt\.com, api\.openai\.com, and auth\.openai\.com, allowlisted by CONNECT host and by\s+the TLS SNI the client then presents/);
  assert.match(result.stdout, /refreshed tokens are not persisted back\s+\(auth\.json is read-only in the container\)/);
  assert.match(result.stdout, /Residual: the one host secret inside the container is auth\.json/);
});

test("--dry-run prints the mount table and the container launch without Docker", async (t) => {
  const f = await fixture(t);
  const result = launch(f, ["--review-id", REVIEW_ID, "--dry-run"]);
  assert.equal(result.status, 0, result.stderr);
  const out = result.stdout;
  // Inputs derived from the ledger and the operator's config, not retyped.
  assert.match(out, new RegExp(`checkout ${f.checkout} \\(read-only, at its recorded path; the bytes are a fresh clone the launcher makes at \\S+/checkout, detached at the review's snapshot head [0-9a-f]{40}\\)`));
  assert.match(out, new RegExp(`marketplace ${f.marketplace} \\(plugin 9\\.9\\.9, read-only\\)`));
  // The mount table: read-only unless the reviewer must write it.
  const bind = (source, target, readonly) =>
    new RegExp(`--mount '?type=bind,src=${source},dst=${target}${readonly ? ",readonly" : ""}(?: |'? )`);
  assert.match(out, bind(f.authJson, "/codex-home/auth\\.json", true));
  assert.match(out, bind(f.marketplace, "/marketplace", true));
  assert.match(
    out,
    bind(f.pluginSource, "/codex-home/plugins/cache/review-bridge-local/review-bridge/9\\.9\\.9", true),
  );
  assert.match(out, bind("\\S+/checkout", f.checkout, true));
  // The host store is never mounted; a staged copy of the one review is.
  assert.doesNotMatch(out, new RegExp(`src=${f.store}[,/]`));
  assert.match(out, /--mount type=volume,src=review-bridge-advisory-\S+-store,dst=\/store /);
  assert.doesNotMatch(out, /type=bind,src=\S+\/store,dst=\/store/);
  assert.match(out, new RegExp(`store ${f.store} \\(never mounted; the review is staged in the Docker volume review-bridge-advisory-\\S+-store, bounded at 64 MB, and copied out to`));
  assert.match(out, /config\.toml,dst=\/codex-home\/config\.toml,readonly'? /);
  // CODEX_HOME and the staged store are volumes and the working directory a
  // tmpfs, not host directories; the five binds above are the whole of the
  // host inside, and none of them is writable.
  assert.match(out, /--mount type=volume,src=review-bridge-advisory-\S+-home,dst=\/codex-home /);
  assert.match(out, /--tmpfs \/work:rw,mode=1777/);
  const codexLine = out.split("\n").filter((line) => line.includes(" codex exec ")).pop();
  assert.equal((codexLine.match(/ --mount '?type=bind,/g) ?? []).length, 5);
  assert.equal((codexLine.match(/ --mount '?type=bind,(?!.*,readonly)/g) ?? []).length, 0);
  assert.doesNotMatch(codexLine, / -v /);
  assert.match(out, /cp -a \/codex-home\/sessions \/out\/sessions/);
  assert.match(out, /docker volume rm review-bridge-advisory-\S+-home/);
  assert.match(out, /docker volume rm review-bridge-advisory-\S+-store/);
  // The bound holds while the reviewer runs: both volumes are tmpfs-backed
  // and sized, and a keeper holds their tmpfs for the run.
  assert.match(out, /docker volume create --driver local --opt type=tmpfs --opt device=tmpfs --opt o=size=1g,mode=0700(,uid=\d+,gid=\d+)? review-bridge-advisory-\S+-home/);
  assert.match(out, /docker volume create --driver local --opt type=tmpfs --opt device=tmpfs --opt o=size=64m,mode=0700(,uid=\d+,gid=\d+)? review-bridge-advisory-\S+-store/);
  assert.match(out, /--name review-bridge-advisory-\S+-keeper .*sleep infinity/);
  assert.match(out, /docker rm -f review-bridge-advisory-\S+-keeper/);
  // A name is a channel too: the reviewer's container and the probes get a
  // resolver that answers nothing beyond the sidecar's alias.
  for (const line of out.split("\n").filter((entry) => entry.includes(" node -e ") || entry.includes(" codex exec "))) {
    assert.match(line, /--dns 127\.0\.0\.1/, line.slice(0, 120));
  }
  assert.doesNotMatch(out.split("\n").find((line) => line.includes("-egress --network")) ?? "", /--dns/);
  assert.match(out, /du -sk --apparent-size \/store/);
  assert.match(out, /find \/store -type f -printf/);
  // No container may exhaust the host: the reviewer's gets the documented
  // headroom, the helpers far less, and every one a process cap.
  for (const line of out.split("\n").filter((entry) => entry.startsWith("docker run"))) {
    assert.match(line, /--memory (4g|512m) --memory-swap \1 --pids-limit (?:512|128) --cpus [12]/, line.slice(0, 140));
  }
  assert.match(out.split("\n").find((line) => line.includes(`--name ${"review-bridge-advisory"}`) && line.includes(" codex ")) ?? "", /--memory 4g --memory-swap 4g --pids-limit 512 --cpus 2/);
  // Every container the launcher starts keeps a bounded log on the host.
  for (const line of out.split("\n").filter((entry) => entry.startsWith("docker run"))) {
    assert.match(line, /--log-driver json-file --log-opt max-size=16m --log-opt max-file=2/, line.slice(0, 120));
  }
  // The container is the sandbox: danger-full-access inside, default
  // confinement outside, isolated CODEX_HOME, egress through the sidecar.
  assert.match(out, /codex exec --skip-git-repo-check --sandbox danger-full-access/);
  assert.doesNotMatch(out, /--security-opt/);
  assert.doesNotMatch(out, /--privileged/);
  assert.doesNotMatch(out, /dangerously-bypass/);
  assert.match(out, /docker network create --internal review-bridge-advisory-/);
  assert.match(out, /--network-alias egress .* --egress-proxy/);
  assert.match(out, /docker network connect bridge review-bridge-advisory-\S+-egress/);
  // All eight proxy variables are pinned on every container: the four proxy
  // names at the sidecar, the four override names explicitly empty.
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) {
    assert.match(codexLine, new RegExp(` -e ${name}=http://egress:3128 `));
  }
  for (const name of ["ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"]) {
    assert.match(codexLine, new RegExp(` -e ${name}= `));
  }
  // The direct probe empties all eight before its curl.
  assert.match(out, /for \(const name of \["HTTP_PROXY","HTTPS_PROXY","http_proxy","https_proxy","ALL_PROXY","all_proxy","NO_PROXY","no_proxy"\]\) direct\[name\] = ""/);
  assert.match(out, /-e CODEX_HOME=\/codex-home/);
  assert.match(out, /\/codex-home\/config\.toml:\n(?:.*\n)*? {2}\[plugins\."review-bridge@review-bridge-local"\]\n {2}enabled = true/);
  assert.match(out, /source = "\/marketplace"/);
  // The launch line: guardian, granular refusal, memories off, author server
  // disabled, reviewer server restated at its container path with the store's
  // container path, the request naming the review id, stdin closed.
  assert.match(out, /-c 'approvals_reviewer="guardian_subagent"'/);
  assert.match(
    out,
    /-c 'approval_policy=\{granular=\{rules=false,sandbox_approval=false,skill_approval=false,request_permissions=false,mcp_elicitations=false\}\}'/,
  );
  assert.match(out, /-c memories\.use_memories=false -c memories\.generate_memories=false/);
  assert.match(out, /-c 'mcp_servers\.review-bridge-author\.command="node"' -c mcp_servers\.review-bridge-author\.enabled=false/);
  assert.match(
    out,
    /-c 'mcp_servers\.review-bridge-reviewer\.args=\["\/codex-home\/plugins\/cache\/review-bridge-local\/review-bridge\/9\.9\.9\/server\/server\.mjs","--role","reviewer","--reviewer-provider","CODEX_TASK"\]'/,
  );
  assert.match(out, /-c 'mcp_servers\.review-bridge-reviewer\.env\.REVIEW_BRIDGE_HOME="\/store"'/);
  assert.match(
    out,
    new RegExp(
      `'Independently review Review Bridge task \`${REVIEW_ID}\` using the packaged Review Bridge reviewer skill\\. Require \`reviewer_provider: CODEX_TASK\`, follow the review strategy, and submit every actionable finding\\.'`,
    ),
  );
  assert.match(out, /codex stdin is closed/);
  // The boundary probe is a node program handed its paths as one JSON
  // argument: the host home and the credential paths are in it, and so is
  // the egress check.
  assert.match(out, / node -e /);
  // Two probe runs: a baseline without the checkout mount, then the mounted one.
  const probeLines = out.split("\n").filter((line) => line.includes("docker run --rm") && line.includes(" node -e "));
  assert.equal(probeLines.length, 2);
  assert.match(out, /"mode":"baseline"/);
  assert.match(out, /"mode":"mounted"/);
  assert.equal((probeLines[0].match(/ --mount '?type=bind,/g) ?? []).length, 4);
  assert.doesNotMatch(probeLines[0], new RegExp(`src=${f.checkout},`));
  assert.equal((probeLines[1].match(/ --mount '?type=bind,/g) ?? []).length, 5);
  const spec = probeSpec(out);
  assert.ok(spec.absent.includes(`${f.home}/.codex/auth.json`));
  assert.ok(spec.absent.includes(`${f.home}/.ssh`));
  assert.ok(spec.absent.includes(`${f.home}/Library`));
  assert.ok(spec.absent.includes("/root/.ssh"));
  assert.ok(spec.absent.includes(f.store));
  // The home directory itself is neither probed nor an ancestor to check:
  // /root exists in the base image, dotfiles and all.
  assert.ok(!spec.absent.includes(f.home));
  assert.ok(!spec.ancestors.includes(f.home));
  assert.ok(spec.ancestors.includes(path.join(f.home, "panel")));
  assert.equal(spec.checkout, f.checkout);
  assert.equal(spec.store, "/store");
  assert.match(out, /https:\/\/example\.com/);
  assert.doesNotMatch(out, /if \[ -e /);
});

// The probe's JSON argument, as the dry run prints it (single-quoted, after
// the program text).
function probeSpec(out) {
  return JSON.parse(out.match(/'(\{"mode":"mounted","absent":[^\n]*\})'/)[1]);
}

test("a checkout path with a space stays one path through the mount and the probe", async (t) => {
  const f = await fixture(t, { checkoutName: "My Projects/review bridge" });
  const result = launch(f, ["--review-id", REVIEW_ID, "--dry-run"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    new RegExp(`--mount 'type=bind,src=\\S+/checkout,dst=${f.checkout},readonly'`),
  );
  const spec = probeSpec(result.stdout);
  assert.equal(spec.checkout, f.checkout);
  assert.ok(spec.ancestors.includes(path.dirname(f.checkout)));
});

test("with a stand-in docker the launcher stages the review, runs, validates, and copies the verdict back", async (t) => {
  const f = await fixture(t, { realReview: true, checkoutName: "My Projects/review bridge" });
  // The fake reviewer floods the transcript before its last mcp: lines, so
  // criterion 1 depends on the transcript being flushed before it is read.
  const env = await fakeDocker(f, { big: true });
  const result = launch(f, ["--review-id", f.reviewId], env);
  assert.equal(result.status, 0, `${result.stdout.slice(-3000)}\n${result.stderr}`);
  assert.match(result.stdout, /criterion 1 MCP calls completed inside the container: PASS — list_pending_reviews 1\/1, open_review 1\/1, submit_review 1\/1$/m);
  assert.match(result.stdout, /^ {2}\(run-health evidence recorded inside the container and forgeable by a reviewer with shell access; the copy-back's integrity rests on the host replay, not on it\)$/m);
  assert.match(result.stdout, /criterion 2 host filesystem absent: PASS/);
  assert.match(
    result.stdout,
    /criterion 3 validated verdict copied back to the host store: PASS — copy-back applied — the verdict was replayed through the host's own submit_review against the host ledger under its state lock and matched the staged ledger; status WAITING_FOR_REVIEW → REVIEW_SUBMITTED, state_version 1 → 2, findings 1/,
  );
  assert.match(result.stdout, /egress: example\.com via proxy → 000 curl-exit=56, without proxy → 000 curl-exit=6; proxy log: allow connect chatgpt\.com:443 ×1, deny connect example\.com:443 ×1/);
  const ledger = await loadReview(f.store, f.reviewId);
  assert.equal(ledger.status, "REVIEW_SUBMITTED");
  assert.equal(ledger.state_version, 2);
  assert.equal(ledger.findings.length, 1);
  assert.deepEqual(ledger.findings[0], {
    id: "F-001",
    introduced_round: 1,
    severity: "major",
    title: "one",
    explanation: "first",
    recommendation: "",
    status: "OPEN",
    path: "app.js",
    line: 1,
  });
  assert.equal(ledger.advisory, true);
  assert.equal(ledger.history.at(-1).event, "FINDINGS_SUBMITTED");
  // The scratch directory named in the output holds the staged copy.
  const scratch = result.stdout.match(/^scratch (.+)$/m)[1];
  t.after(() => fsp.rm(scratch, { recursive: true, force: true }));
  assert.ok(await fsp.stat(path.join(scratch, "store", "reviews", f.reviewId, "review.json")));
});

test("the copy-back refuses a staged store that carries anything but the review's own transition, and leaves the host store unwritten", async (t) => {
  for (const [tamper, reason] of [
    ["outside", /unexpected file outside the staged review: other\.txt/],
    ["sibling", /unexpected file outside the staged review: reviews\/rb-2026-01-01T000000-000Z-00000000\/review\.json/],
    ["extra", /an unexpected file was created in the staged review: notes\.txt/],
    ["snapshot", /an existing snapshot file was modified: rounds\/1\/manifest\.json/],
    // The three forgeries the replay exists to catch: a status the payload
    // does not reach, findings the server never normalized, a snapshot hash
    // the host never wrote — and a flipped advisory flag, for good measure.
    ["forge-clean", /does not match the host's own replay of its submit_review payload \(differs in: clean_snapshot_hash, history\)/],
    ["findings", /does not match the host's own replay of its submit_review payload \(differs in: findings, history\)/],
    ["hash", /does not match the host's own replay of its submit_review payload \(differs in: rounds\)/],
    ["id", /does not match the host's own replay of its submit_review payload \(differs in: advisory\)/],
    ["no-verdict", /nothing to copy back — the staged ledger is unchanged/],
  ]) {
    const f = await fixture(t, { realReview: true });
    const env = await fakeDocker(f, { tamper });
    const result = launch(f, ["--review-id", f.reviewId], env);
    assert.equal(result.status, 1, `${tamper}: ${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /criterion 3 validated verdict copied back to the host store: FAIL — /, tamper);
    assert.match(result.stdout, reason, tamper);
    const ledger = await loadReview(f.store, f.reviewId);
    assert.equal(ledger.status, "WAITING_FOR_REVIEW", tamper);
    assert.equal(ledger.state_version, 1, tamper);
    const scratch = result.stdout.match(/^scratch (.+)$/m)[1];
    t.after(() => fsp.rm(scratch, { recursive: true, force: true }));
    if (tamper !== "no-verdict") {
      assert.match(result.stdout, new RegExp(`staged copy kept at ${scratch}/store/reviews/${f.reviewId}`), tamper);
    }
  }
});

test("the launcher refuses a ledger that is not an advisory CODEX_TASK review waiting for review", async (t) => {
  for (const [ledger, message] of [
    [{ advisory: false }, /is not an advisory review; a review of the operator's own changes takes the host launch/],
    [{ reviewer_provider: "HERMES" }, /is bound to HERMES, not CODEX_TASK/],
    [{ status: "CLEAN" }, /is CLEAN, not WAITING_FOR_REVIEW/],
  ]) {
    const f = await fixture(t, { ledger });
    const result = launch(f, ["--review-id", REVIEW_ID, "--dry-run"]);
    assert.equal(result.status, 2, result.stdout);
    assert.match(result.stderr, message);
  }
});

test("the launcher fails closed on a missing mount source, naming it", async (t) => {
  const f = await fixture(t);
  await fsp.rm(f.authJson);
  let result = launch(f, ["--review-id", REVIEW_ID, "--dry-run"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, new RegExp(`operator's codex auth\\.json is missing: ${f.authJson}`));

  const g = await fixture(t);
  await fsp.rm(g.checkout, { recursive: true });
  result = launch(g, ["--review-id", REVIEW_ID, "--dry-run"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, new RegExp(`author checkout the ledger records is missing: ${g.checkout}`));

  const h = await fixture(t);
  result = launch(h, ["--review-id", "rb-2026-09-10T000000-000Z-deadbeef", "--dry-run"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /cannot read the review ledger .*deadbeef\/review\.json/);

  const i = await fixture(t);
  await fsp.writeFile(path.join(i.home, ".codex", "config.toml"), "model = \"x\"\n");
  result = launch(i, ["--review-id", REVIEW_ID, "--dry-run"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /no --marketplace given and \[marketplaces\.review-bridge-local\] names no source/);
  result = launch(i, ["--review-id", REVIEW_ID, "--marketplace", i.marketplace, "--dry-run"]);
  assert.equal(result.status, 0, result.stderr);
});

test("the launcher refuses host paths Docker Desktop stops serving, naming the prefix and the fix", async (t) => {
  const f = await fixture(t, { ledger: { repository_path: "/private/tmp/x/review-bridge" } });
  let result = launch(f, ["--review-id", REVIEW_ID, "--dry-run"]);
  assert.equal(result.status, 2, result.stdout);
  assert.match(
    result.stderr,
    /the author checkout the ledger records \/private\/tmp\/x\/review-bridge is under \/private\/tmp\/: Docker Desktop stops serving files under \/private\/tmp\/ a few seconds into a container; place the panel worktree and store under your home directory/,
  );
  const g = await fixture(t);
  result = launch(g, ["--review-id", REVIEW_ID, "--marketplace", "/Volumes/Disk/codex-marketplace", "--dry-run"]);
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stderr, /the marketplace \/Volumes\/Disk\/codex-marketplace is under \/Volumes\//);
  const h = await fixture(t);
  result = launch(h, ["--review-id", REVIEW_ID, "--dry-run"], { TMPDIR: "/Volumes/Disk/tmp" });
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stderr, /the scratch directory \(TMPDIR\) \/Volumes\/Disk\/tmp is under \/Volumes\//);
  // The prefix itself, with no trailing slash, is what a symlink such as
  // /tmp → /private/tmp resolves to.
  const i = await fixture(t);
  result = launch(i, ["--review-id", REVIEW_ID, "--dry-run"], { TMPDIR: "/Volumes" });
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stderr, /the scratch directory \(TMPDIR\) \/Volumes is under \/Volumes\//);
  // The codex home (and so auth.json) is held to the same check.
  const j = await fixture(t);
  result = launch(j, ["--review-id", REVIEW_ID, "--marketplace", j.marketplace], { CODEX_HOME: "/private/tmp/codex-home", PATH: await gitOnlyPath(t) });
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stderr, /the codex auth\.json \/private\/tmp\/codex-home\/auth\.json is under \/private\/tmp\//);
  assert.doesNotMatch(result.stderr, /Docker is not available/);
});

test("a call the server answered with an error is not a failed call; one nobody answered is", async (t) => {
  const f = await fixture(t, { realReview: true });
  let result = launch(f, ["--review-id", f.reviewId], await fakeDocker(f, { serverError: "answered" }));
  assert.equal(result.status, 0, result.stdout.slice(-2000));
  assert.match(
    result.stdout,
    /criterion 1 MCP calls completed inside the container: PASS — list_pending_reviews 1\/1, open_review 1\/1, read_snapshot_file 0\/1, submit_review 1\/1; 1 failed call\(s\) answered by the server with an error \(read_snapshot_file: "git show failed \(128\): fatal: path 'nope\.js' does not exist in 'abc'"\)$/m,
  );
  const g = await fixture(t, { realReview: true });
  const hostBefore = await fsp.readFile(path.join(g.store, "reviews", g.reviewId, "review.json"));
  result = launch(g, ["--review-id", g.reviewId], await fakeDocker(g, { serverError: "unexplained" }));
  assert.equal(result.status, 1, result.stdout.slice(-2000));
  assert.match(result.stdout, /criterion 1 MCP calls completed inside the container: FAIL — .*search_snapshot 0\/1.*; 1 failed call\(s\) answered by the server with an error \(read_snapshot_file: .*\); 1 call\(s\) failed without a server answer: search_snapshot$/m);
  // The reviewer did submit into the staged store, but a run with an
  // unexplained failure must not advance the host ledger: a REVIEW_SUBMITTED
  // ledger could not be launched again.
  assert.match(result.stdout, /criterion 3 validated verdict copied back to the host store: FAIL — refused — pre-copy criteria failed: 1 call\(s\) failed without a server answer: search_snapshot; host store unwritten/);
  assert.deepEqual(await fsp.readFile(path.join(g.store, "reviews", g.reviewId, "review.json")), hostBefore);
  assert.equal((await loadReview(g.store, g.reviewId)).status, "WAITING_FOR_REVIEW");
  // A (failed) line with no record of its own is a transcript/rollout
  // mismatch, whatever error objects other outputs carry.
  const h = await fixture(t, { realReview: true });
  result = launch(h, ["--review-id", h.reviewId], await fakeDocker(h, { serverError: "no-record" }));
  assert.equal(result.status, 1, result.stdout.slice(-2000));
  assert.match(result.stdout, /criterion 1 MCP calls completed inside the container: FAIL — .*; transcript\/rollout mismatch: 4 started line\(s\) in the transcript, 3 record\(s\) in the main rollout$/m);
  assert.equal((await loadReview(h.store, h.reviewId)).status, "WAITING_FOR_REVIEW");
  // An answered failure in a subagent's rollout does not stand in for the
  // main run's transport failure: the criterion reads the main rollout only.
  const i = await fixture(t, { realReview: true });
  result = launch(i, ["--review-id", i.reviewId], await fakeDocker(i, { serverError: "subagent-answered" }));
  assert.equal(result.status, 1, result.stdout.slice(-2000));
  assert.match(result.stdout, /criterion 1 MCP calls completed inside the container: FAIL — .*; 1 call\(s\) failed without a server answer: search_snapshot$/m);
  assert.doesNotMatch(result.stdout, /answered elsewhere/);
  assert.equal((await loadReview(i.store, i.reviewId)).status, "WAITING_FOR_REVIEW");
  // Every record completed but the transcript shows one more started line
  // than the rollout records: a mismatch, and the host stays untouched.
  const j = await fixture(t, { realReview: true });
  result = launch(j, ["--review-id", j.reviewId], await fakeDocker(j, { serverError: "extra-line" }));
  assert.equal(result.status, 1, result.stdout.slice(-2000));
  assert.match(result.stdout, /criterion 1 MCP calls completed inside the container: FAIL — list_pending_reviews 1\/1, open_review 1\/1, submit_review 1\/1; transcript\/rollout mismatch: 4 started line\(s\) in the transcript, 3 record\(s\) in the main rollout$/m);
  assert.equal((await loadReview(j.store, j.reviewId)).status, "WAITING_FOR_REVIEW");
});

test("a nonzero codex exit leaves the host ledger untouched even when the staged ledger holds a verdict", async (t) => {
  const f = await fixture(t, { realReview: true });
  const hostBefore = await fsp.readFile(path.join(f.store, "reviews", f.reviewId, "review.json"));
  const result = launch(f, ["--review-id", f.reviewId], await fakeDocker(f, { exit: "3" }));
  assert.equal(result.status, 3, result.stdout.slice(-2000));
  assert.match(result.stdout, /criterion 3 validated verdict copied back to the host store: FAIL — refused — pre-copy criteria failed: codex exited 3; host store unwritten/);
  assert.deepEqual(await fsp.readFile(path.join(f.store, "reviews", f.reviewId, "review.json")), hostBefore);
  const scratch = result.stdout.match(/^scratch (.+)$/m)[1];
  t.after(() => fsp.rm(scratch, { recursive: true, force: true }));
  assert.equal((await loadReview(path.join(scratch, "store"), f.reviewId)).status, "REVIEW_SUBMITTED");
});

test("the boundary is judged against the unmounted image: image directories pass, host leaks fail", async (t) => {
  // An ancestor the image populates (a /usr-shaped one) passes when the mount
  // adds exactly the next name; a path the image itself has is not a leak.
  const f = await fixture(t, { realReview: true });
  let result = launch(f, ["--review-id", f.reviewId], await fakeDocker(f, { baselineChildren: "bin,lib,share", imagePresent: "/root/.ssh" }));
  assert.equal(result.status, 0, result.stdout.slice(-2500));
  assert.match(result.stdout, /criterion 2 host filesystem absent: PASS — .*present: \/root\/\.ssh \(in the image\); checkout ancestors against the unmounted baseline: .* over 3 in the image/);
  // Each ancestor gained exactly the checkout's next segment below it.
  assert.match(result.stdout, new RegExp(`${path.dirname(f.checkout)}: \\+${path.basename(f.checkout)} over 3 in the image`));
  // An image that already holds the way-down name (/usr/src) adds nothing
  // and still passes, because the name is there after the mount.
  const h = await fixture(t, { realReview: true });
  result = launch(h, ["--review-id", h.reviewId], await fakeDocker(h, { baselineChildren: "src,bin", baselineHasExpected: true }));
  assert.equal(result.status, 0, result.stdout.slice(-2500));
  assert.match(result.stdout, new RegExp(`${path.dirname(h.checkout)}: \\+∅ over 3 in the image`));
  // A name the mount added beside the way down is a leak.
  const g = await fixture(t, { realReview: true });
  result = launch(g, ["--review-id", g.reviewId], await fakeDocker(g, { leak: "stray" }));
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /changed by more than the way down to the checkout: added .*stray.*, expected only /);
  assert.doesNotMatch(result.stdout, /mcp: /);
});

// A PATH with git on it and nothing else, so a run that reaches Docker fails
// with the Docker message and one that does not never mentions it.
async function gitOnlyPath(t) {
  const bin = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-git-only-"));
  t.after(() => fsp.rm(bin, { recursive: true, force: true }));
  const git = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  await fsp.symlink(git, path.join(bin, "git"));
  return bin;
}

test("a host credential directory present inside the container fails the boundary before the reviewer starts", async (t) => {
  const f = await fixture(t, { realReview: true });
  const env = await fakeDocker(f, { present: `${f.home}/.ssh` });
  const result = launch(f, ["--review-id", f.reviewId], env);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, new RegExp(`the container boundary did not hold:\\n {2}host path present inside the container: ${f.home}/\\.ssh`));
  assert.doesNotMatch(result.stdout, /mcp: /);
});

test("the launcher's host git runs isolated: a global smudge filter named by the reviewed tree never executes", async (t) => {
  // The reviewed tree names a filter; the operator's global configuration
  // defines it with a command. Inherited, git would run that command on the
  // host during the staging clone's checkout — the positive control shows
  // it does — and the launcher's isolated environment resolves the name to
  // nothing.
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-smudge-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const marker = path.join(root, "smudge-ran");
  const evil = path.join(root, "gitconfig");
  // (`&&`, not `;`: in a git config value an unquoted `;` starts a comment.)
  await fsp.writeFile(evil, `[filter "evil"]\n\tsmudge = sh -c 'touch ${marker} && cat'\n`);
  const f = await fixture(t, {
    realReview: true,
    beforePrepare: async (repository) => {
      await fsp.writeFile(path.join(repository, ".gitattributes"), "* filter=evil\n");
      fixtureGit(repository, "add", ".gitattributes");
      fixtureGit(repository, "commit", "-m", "attributes");
    },
  });
  const control = spawnSync("git", ["clone", "-q", "--template=", "--no-local", `file://${f.checkout}`, path.join(root, "control")], {
    encoding: "utf8",
    env: { ...process.env, HOME: root, GIT_CONFIG_GLOBAL: evil },
  });
  assert.equal(control.status, 0, control.stderr);
  await fsp.access(marker);
  await fsp.rm(marker);
  const env = await fakeDocker(f);
  const result = launch(f, ["--review-id", f.reviewId], { ...env, GIT_CONFIG_GLOBAL: evil });
  assert.equal(result.status, 0, result.stdout.slice(-2500));
  await assert.rejects(fsp.access(marker), /ENOENT/);
  assert.match(result.stdout, /criterion 3 validated verdict copied back to the host store: PASS/);
});

test("the panel checkout script clones, fetches, and checks out in the isolated git environment", async (t) => {
  // A pull request whose head tree names a filter the operator's global
  // configuration defines with a command. The bare git sequence under that
  // configuration runs the command on the host (positive control); the
  // packaged script, under the same configuration, does not — and what it
  // makes is the checkout the launcher accepts.
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-panel-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const marker = path.join(root, "smudge-ran");
  const evil = path.join(root, "gitconfig");
  await fsp.writeFile(evil, `[filter "evil"]\n\tsmudge = sh -c 'touch ${marker} && cat'\n`);
  const remote = await repositoryFixture();
  t.after(() => fsp.rm(remote.root, { recursive: true, force: true }));
  await commit(remote.repository, "export const value = 2;\n");
  await fsp.writeFile(path.join(remote.repository, ".gitattributes"), "* filter=evil\n");
  fixtureGit(remote.repository, "add", ".gitattributes");
  fixtureGit(remote.repository, "commit", "-m", "attributes");
  const prHead = fixtureGit(remote.repository, "rev-parse", "HEAD");
  fixtureGit(remote.repository, "update-ref", "refs/pull/7/head", prHead);
  const mainSha = fixtureGit(remote.repository, "rev-parse", "main");
  const inherited = { ...process.env, HOME: root, GIT_CONFIG_GLOBAL: evil };
  const control = path.join(root, "control");
  for (const args of [
    ["clone", "-q", "--template=", `file://${remote.repository}`, control],
    ["-C", control, "fetch", "-q", "origin", "+main:refs/review-bridge/7/base", "+pull/7/head:refs/review-bridge/7/head"],
    ["-C", control, "checkout", "-q", "--detach", "refs/review-bridge/7/head"],
  ]) {
    const step = spawnSync("git", args, { encoding: "utf8", env: inherited });
    assert.equal(step.status, 0, step.stderr);
  }
  await fsp.access(marker);
  await fsp.rm(marker);
  const dest = path.join(root, "panel", "review-bridge");
  const result = spawnSync(process.execPath, [panelSource, `file://${remote.repository}`, "7", "main", dest], { encoding: "utf8", env: inherited });
  assert.equal(result.status, 0, result.stderr);
  await assert.rejects(fsp.access(marker), /ENOENT/);
  assert.equal(result.stdout, `checkout ${dest}\nbase ${mainSha}\nhead ${prHead}\nmerge-base ${remote.baseSha}\n`);
  assert.equal(fixtureGit(dest, "rev-parse", "HEAD"), prHead);
  assert.equal(fixtureGit(dest, "rev-parse", "refs/review-bridge/7/head"), prHead);
  assert.equal(fixtureGit(dest, "rev-parse", "refs/review-bridge/7/base"), mainSha);
  assert.match(await fsp.readFile(path.join(dest, "export.mjs"), "utf8").catch(() => "export const value = 2;"), /value = 2/);
  // What the script made passes the launcher's prechecks as a panel checkout.
  const f = await fixture(t, { checkoutPath: dest });
  const dry = launch(f, ["--review-id", REVIEW_ID, "--dry-run"]);
  assert.equal(dry.status, 0, dry.stderr);
  // The script refuses to write over anything and rejects a bad number.
  const again = spawnSync(process.execPath, [panelSource, `file://${remote.repository}`, "7", "main", dest], { encoding: "utf8", env: inherited });
  assert.equal(again.status, 2);
  assert.match(again.stderr, /already exists/);
  const bad = spawnSync(process.execPath, [panelSource, `file://${remote.repository}`, "seven", "main", path.join(root, "x")], { encoding: "utf8" });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /invalid pull request number/);
  // The target's ref is named in full, so a branch legitimately named
  // `refs/heads/main` is fetched instead of the ordinary `main`.
  fixtureGit(remote.repository, "branch", "refs/heads/main", prHead);
  const oddBase = fixtureGit(remote.repository, "rev-parse", "refs/heads/refs/heads/main");
  assert.notEqual(oddBase, mainSha);
  const odd = spawnSync(process.execPath, [panelSource, `file://${remote.repository}`, "7", "refs/heads/main", path.join(root, "odd-branch")], { encoding: "utf8", env: inherited });
  assert.equal(odd.status, 0, odd.stderr);
  assert.match(odd.stdout, new RegExp(`^base ${oddBase}$`, "m"));
  // Branch legality is git's: names git accepts pass, names it refuses or
  // that would break the refspec are refused by name before any clone.
  for (const name of ["release@v1", "release+1"]) {
    fixtureGit(remote.repository, "branch", name, "main");
    const ok = spawnSync(process.execPath, [panelSource, `file://${remote.repository}`, "7", name, path.join(root, `ok-${name}`)], { encoding: "utf8" });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, new RegExp(`^base ${mainSha}$`, "m"));
  }
  // An ssh remote with no agent is refused before any clone: the agent is
  // the only credential source the isolated environment offers.
  const noAgent = { ...process.env };
  delete noAgent.SSH_AUTH_SOCK;
  const sshRemote = spawnSync(process.execPath, [panelSource, "git@github.com:owner/repo.git", "7", "main", path.join(root, "never-ssh")], { encoding: "utf8", env: noAgent });
  assert.equal(sshRemote.status, 2);
  assert.match(sshRemote.stderr, /is an ssh remote and no ssh agent is available; the agent is the only credential source this script supports/);
  await assert.rejects(fsp.access(path.join(root, "never-ssh")), /ENOENT/);
  for (const name of ["bad..name", "-x", "a:b", "a b"]) {
    const refused = spawnSync(process.execPath, [panelSource, `file://${remote.repository}`, "7", name, path.join(root, "never")], { encoding: "utf8" });
    assert.equal(refused.status, 2, name);
    assert.match(refused.stderr, /invalid target branch name: /);
    await assert.rejects(fsp.access(path.join(root, "never")), /ENOENT/);
  }
});

test("a checkout path carrying %20, a space, or a # is cloned from that path itself", async (t) => {
  // The staging clone's URL is built with pathToFileURL: a literal `%20`
  // would otherwise be decoded to a space and a `#` read as a fragment, and
  // the clone would be of another path or of nothing.
  const f = await fixture(t, { realReview: true });
  const odd = path.join(path.dirname(f.checkout), "pct%20 space #hash");
  await fsp.rename(f.checkout, odd);
  const reviewDir = path.join(f.store, "reviews", f.reviewId);
  for (const name of await fsp.readdir(reviewDir)) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(reviewDir, name);
    const text = await fsp.readFile(file, "utf8");
    await fsp.writeFile(file, text.replaceAll(JSON.stringify(f.checkout).slice(1, -1), JSON.stringify(odd).slice(1, -1)));
  }
  const env = await fakeDocker({ ...f, checkout: odd });
  const result = launch({ ...f, checkout: odd }, ["--review-id", f.reviewId], env);
  assert.equal(result.status, 0, result.stdout.slice(-2500));
  const seen = JSON.parse(await fsp.readFile(env.FAKE_CHECKOUT_LOG, "utf8"));
  assert.equal(seen.remoteUrl, pathToFileURL(await fsp.realpath(odd)).href);
  assert.match(seen.remoteUrl, /pct%2520%20space%20%23hash$/);
  assert.match(result.stdout, /criterion 3 validated verdict copied back to the host store: PASS/);
});

// The GIT_SSH_COMMAND the isolated environment sets, read back through git
// itself, for a home directory the test controls: the module's known_hosts
// lookup follows HOME, so both states — an operator who has a known_hosts and
// one who has none — are reachable on any machine.
async function isolatedSshCommand(t, { knownHosts }) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-ssh-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  await fsp.mkdir(path.join(home, ".ssh"), { recursive: true });
  const knownHostsPath = path.join(home, ".ssh", "known_hosts");
  if (knownHosts) await fsp.writeFile(knownHostsPath, "");
  const repo = path.join(root, "repo");
  await fsp.mkdir(repo);
  spawnSync("git", ["-C", repo, "init", "-q"]);
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const m = await import(${JSON.stringify(pathToFileURL(path.join(path.dirname(launcherSource), "isolated-git.mjs")).href)});
       const shown = m.isolatedGit(["-C", process.argv[1], "-c", 'alias.showssh=!printf %s "$GIT_SSH_COMMAND"', "showssh"]);
       if (shown.status !== 0) { process.stderr.write(shown.stderr); process.exit(1); }
       process.stdout.write(shown.stdout.trim());`,
      repo,
    ],
    { encoding: "utf8", env: { ...process.env, HOME: home } },
  );
  assert.equal(child.status, 0, child.stderr);
  return { command: child.stdout, root, knownHostsPath };
}

// What ssh itself resolves under a command, as `ssh -G` reports it.
function sshSettings(command) {
  const resolved = spawnSync("sh", ["-c", `${command} -G -o BatchMode=yes 127.0.0.1`], { encoding: "utf8" });
  assert.equal(resolved.status, 0, resolved.stderr);
  const settings = new Map();
  for (const line of resolved.stdout.split("\n")) {
    const [key, ...rest] = line.split(" ");
    if (!key) continue;
    settings.set(key, [...(settings.get(key) ?? []), rest.join(" ")]);
  }
  return settings;
}

test("the isolated environment pins ssh itself: no operator configuration, no key on disk, the agent as the only credential source", async (t) => {
  // OpenSSH takes its home from the passwd entry, so the isolated HOME does
  // not reach ~/.ssh; the environment sets GIT_SSH_COMMAND instead.
  const operator = await isolatedSshCommand(t, { knownHosts: true });
  assert.match(operator.command, /^ssh -F \/dev\/null /);
  // What ssh resolves under it: one identity file, that one a null device;
  // the agent (or none); no proxy command at all; and the operator's own
  // known_hosts, strictly checked.
  const settings = sshSettings(operator.command);
  assert.deepEqual(settings.get("identityfile"), ["/dev/null"]);
  assert.equal(settings.has("proxycommand"), false);
  assert.equal(settings.has("proxyjump"), false);
  assert.deepEqual(settings.get("controlmaster"), ["false"]);
  assert.deepEqual(settings.get("identityagent"), [process.env.SSH_AUTH_SOCK ?? "none"]);
  // IdentitiesOnly stays off: with it on, ssh offers only the file it was
  // given and the agent's keys are never presented, which would make every
  // private remote fail.
  assert.deepEqual(settings.get("identitiesonly"), ["no"]);
  assert.deepEqual(settings.get("userknownhostsfile"), [operator.knownHostsPath]);
  assert.deepEqual(settings.get("stricthostkeychecking"), ["true"]);
  // With no known_hosts of the operator's, the run's own file and accept-new
  // — never /dev/null, which would discard the key it accepted.
  const fresh = await isolatedSshCommand(t, { knownHosts: false });
  const freshSettings = sshSettings(fresh.command);
  const [freshKnownHosts] = freshSettings.get("userknownhostsfile");
  assert.equal(path.basename(freshKnownHosts), "known_hosts");
  assert.match(freshKnownHosts, /review-bridge-advisory-git-/);
  assert.notEqual(freshKnownHosts, "/dev/null");
  assert.deepEqual(freshSettings.get("stricthostkeychecking"), ["accept-new"]);
  assert.deepEqual(freshSettings.get("identityfile"), ["/dev/null"]);
  // Positive control: an ssh configuration whose ProxyCommand runs a command.
  // Read (with -F) it fires; the pinned command reads no configuration, so it
  // cannot.
  const marker = path.join(operator.root, "proxy-ran");
  const evil = path.join(operator.root, "config");
  await fsp.writeFile(evil, `Host *\n  ProxyCommand sh -c "touch ${marker}; exit 1"\n`);
  spawnSync("sh", ["-c", `ssh -F ${evil} -o BatchMode=yes -o ConnectTimeout=2 -p 1 127.0.0.1 true`], { encoding: "utf8" });
  await fsp.access(marker);
  await fsp.rm(marker);
  spawnSync("sh", ["-c", `${operator.command} -o BatchMode=yes -o ConnectTimeout=2 -p 1 127.0.0.1 true`], { encoding: "utf8" });
  await assert.rejects(fsp.access(marker), /ENOENT/);
  // And the claim that the agent is a usable credential source is tested
  // against a real server: a local sshd that accepts one key, which lives only
  // in an agent. The same command with IdentitiesOnly=yes is the negative
  // control. Where sshd cannot be started (a runner without it, or one that
  // refuses to run it unprivileged) the test says so rather than passing
  // quietly.
  const server = await localSshd(t, operator.root);
  if (!server) {
    t.diagnostic("no local sshd: the agent authentication control did not run");
    return;
  }
  // The socket path is given, not left to the agent to choose: where it puts
  // one by default depends on the operator's home, which this test moves.
  const agentDir = await fsp.mkdtemp(path.join(os.tmpdir(), "rb-agent-"));
  t.after(() => fsp.rm(agentDir, { recursive: true, force: true }));
  const socket = path.join(agentDir, "s");
  const agent = spawnSync("ssh-agent", ["-a", socket], { encoding: "utf8" });
  const agentPid = /SSH_AGENT_PID=(\d+);/.exec(agent.stdout ?? "")?.[1];
  assert.ok(agentPid, `${agent.stdout}${agent.stderr}`);
  t.after(() => spawnSync("ssh-agent", ["-k"], { env: { ...process.env, SSH_AGENT_PID: agentPid } }));
  assert.equal(spawnSync("ssh-add", ["-q", server.key], { env: { ...process.env, SSH_AUTH_SOCK: socket }, encoding: "utf8" }).status, 0);
  const pinned = [
    "ssh -F /dev/null -o IdentityFile=/dev/null",
    `-o IdentityAgent='${socket}'`,
    "-o ProxyCommand=none -o ProxyJump=none -o ControlMaster=no -o ControlPath=none",
    `-o StrictHostKeyChecking=accept-new -o UserKnownHostsFile='${server.knownHosts}'`,
    "-o BatchMode=yes -o ConnectTimeout=5",
  ].join(" ");
  const connect = (extra) =>
    spawnSync("sh", ["-c", `${pinned} ${extra} -p ${server.port} ${os.userInfo().username}@127.0.0.1 true`], { encoding: "utf8" });
  const allowed = connect("");
  assert.equal(allowed.status, 0, `${allowed.stderr}\n${server.log()}`);
  const refused = connect("-o IdentitiesOnly=yes");
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Permission denied \(publickey\)/);
  t.diagnostic(`agent authentication control ran against a local sshd on port ${server.port}`);
});

// A local sshd for the agent control: its own host key, one authorized key,
// no password auth, run unprivileged on a free port. Null when it will not
// start here.
async function localSshd(t, root) {
  const sshd = "/usr/sbin/sshd";
  if (!fs.existsSync(sshd)) return null;
  const dir = path.join(root, "sshd");
  await fsp.mkdir(dir);
  const hostKey = path.join(dir, "host");
  const key = path.join(dir, "user");
  for (const file of [hostKey, key]) {
    assert.equal(spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", file], { encoding: "utf8" }).status, 0);
  }
  const authorized = path.join(dir, "authorized_keys");
  await fsp.copyFile(`${key}.pub`, authorized);
  await fsp.chmod(authorized, 0o600);
  await fsp.chmod(hostKey, 0o600);
  const port = 20000 + Math.floor(Math.random() * 20000);
  const config = path.join(dir, "sshd_config");
  await fsp.writeFile(
    config,
    `HostKey ${hostKey}\nAuthorizedKeysFile ${authorized}\nUsePAM no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nStrictModes no\nPidFile ${dir}/pid\nLogLevel DEBUG1\n`,
  );
  const logPath = path.join(dir, "sshd.log");
  const log = fs.openSync(logPath, "w");
  const child = spawn(sshd, ["-f", config, "-p", String(port), "-D", "-e"], { stdio: ["ignore", log, log] });
  t.after(() => child.kill("SIGKILL"));
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const text = await fsp.readFile(logPath, "utf8").catch(() => "");
    if (/Server listening on/.test(text)) {
      return { port, key, knownHosts: path.join(dir, "known_hosts"), log: () => text };
    }
    if (child.exitCode !== null) return null;
  }
  return null;
}

test("without an operator known_hosts, one run shares one known_hosts and says what it accepted", async (t) => {
  // accept-new against /dev/null would discard the key and let every call of
  // one checkout trust a new one; the run keeps its own file instead, and it
  // goes with the isolation directory.
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-tofu-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  await fsp.mkdir(home);
  const repo = path.join(root, "repo");
  await fsp.mkdir(repo);
  spawnSync("git", ["-C", repo, "init", "-q"]);
  const key = path.join(root, "host-key");
  assert.equal(spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key], { encoding: "utf8" }).status, 0);
  // A known_hosts entry carries no comment, so ssh-keygen -l shows the host
  // where a comment would be.
  const publicKey = (await fsp.readFile(`${key}.pub`, "utf8")).trim().split(" ").slice(0, 2).join(" ");
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import fs from "node:fs";
       const m = await import(${JSON.stringify(pathToFileURL(path.join(path.dirname(launcherSource), "isolated-git.mjs")).href)});
       const show = () => m.isolatedGit(["-C", process.argv[1], "-c", 'alias.showssh=!printf %s "$GIT_SSH_COMMAND"', "showssh"]).stdout.trim();
       const first = show();
       const file = /UserKnownHostsFile='([^']*)'/.exec(first)[1];
       fs.writeFileSync(file, process.argv[2] + "\\n");
       const second = show();
       console.log(JSON.stringify({
         file,
         same: file === /UserKnownHostsFile='([^']*)'/.exec(second)[1],
         strict: /StrictHostKeyChecking=(\\S+)/.exec(second)[1],
         lines: fs.readFileSync(file, "utf8").split("\\n").filter(Boolean).length,
         accepted: m.sshAcceptedHostKeys(),
       }));`,
      repo,
      `127.0.0.1 ${publicKey}`,
    ],
    { encoding: "utf8", env: { ...process.env, HOME: home } },
  );
  assert.equal(child.status, 0, child.stderr);
  const seen = JSON.parse(child.stdout);
  assert.equal(seen.same, true);
  assert.equal(seen.strict, "accept-new");
  assert.equal(seen.lines, 1, "the second call reused the accepted key instead of writing another");
  assert.ok(seen.file.includes("review-bridge-advisory-git-"), seen.file);
  assert.equal(seen.accepted.length, 1);
  assert.match(seen.accepted[0], /SHA256:/);
  assert.ok(seen.accepted[0].includes("127.0.0.1"), seen.accepted[0]);
  // The file is the run's: it is gone with the isolation directory.
  await assert.rejects(fsp.access(seen.file), /ENOENT/);
  // The panel script states the trust before it starts, and reports no key
  // when none was accepted.
  const refused = spawnSync(
    process.execPath,
    [panelSource, "ssh://git@127.0.0.1:1/owner/repo.git", "7", "main", path.join(root, "never")],
    { encoding: "utf8", env: { ...process.env, HOME: home, SSH_AUTH_SOCK: path.join(root, "agent.sock") } },
  );
  assert.equal(refused.status, 2, refused.stdout + refused.stderr);
  assert.match(refused.stdout, /host key trusted on first use \(no ~\/\.ssh\/known_hosts\): accepted for this run only, not kept — create ~\/\.ssh\/known_hosts to verify the host across runs/);
  assert.doesNotMatch(refused.stdout, /accepted host key/);
});

test("the report's egress summary counts the records the sidecar collapsed", async (t) => {
  // 1000 written plus four ×1000 suppressed lines is 5000 refusals in a log
  // of 1004 lines.
  const f = await fixture(t, { realReview: true });
  const result = launch(f, ["--review-id", f.reviewId], await fakeDocker(f, { logs: "suppressed" }));
  assert.equal(result.status, 0, result.stdout.slice(-2000));
  assert.match(result.stdout, /proxy log: deny connect example\.com:443 ×1, deny connect looped\.example:443 ×5000 \(repeated records collapsed; up to 5s of trailing counts may be unflushed if the proxy was killed\)$/m);
});

test("a staged store past the bound is never copied to the host, and its volume is kept", async (t) => {
  // The reviewer can fill the volume; it cannot fill the host. What the
  // volume holds is measured inside the container, and past the bound
  // nothing of it comes out.
  const f = await fixture(t, { realReview: true });
  const env = await fakeDocker(f, { storeKb: "70000" });
  const result = launch(f, ["--review-id", f.reviewId], env);
  assert.equal(result.status, 1, result.stdout.slice(-2000));
  assert.match(result.stdout, /criterion 3 validated verdict copied back to the host store: FAIL — refused — pre-copy criteria failed: staged store is 68\.4 MB, over the 64 MB bound/);
  assert.match(result.stdout, /the staged store volume review-bridge-advisory-\S+-store was kept, unread/);
  const calls = await fsp.readFile(env.FAKE_CALLS, "utf8");
  assert.doesNotMatch(calls, /^volume rm review-bridge-advisory-\S+-store$/m);
  assert.match(calls, /^volume rm review-bridge-advisory-\S+-home$/m);
  // A kept tmpfs volume is empty unless something mounts it, so the keeper
  // stays up with it, and the report says what it costs and how to clear it.
  assert.doesNotMatch(calls, /^rm -f review-bridge-advisory-\S+-keeper$/m);
  assert.match(
    result.stdout,
    /the volume keeper review-bridge-advisory-\S+-keeper is still running to hold review-bridge-advisory-\S+-store \(a tmpfs volume empties when nothing mounts it\), so it goes on using memory until you clear it: look with `docker run --rm -v review-bridge-advisory-\S+-store:\/v alpine ls -la \/v`, then `docker rm -f review-bridge-advisory-\S+-keeper && docker volume rm review-bridge-advisory-\S+-store`/,
  );
  // The host ledger is where it was.
  const ledger = await loadReview(f.store, f.reviewId);
  assert.equal(ledger.status, "WAITING_FOR_REVIEW");
  assert.equal(ledger.state_version, 1);
});

test("a single staged file past its own bound is refused, in the container and again on the host", async (t) => {
  // The container's measurement names the largest file; and if that
  // measurement is ever fooled, the host sizes every staged file before it
  // reads it.
  const f = await fixture(t, { realReview: true });
  let result = launch(f, ["--review-id", f.reviewId], await fakeDocker(f, { storeLargest: String(9 * 1024 * 1024) }));
  assert.equal(result.status, 1, result.stdout.slice(-2000));
  assert.match(result.stdout, /refused — pre-copy criteria failed: the largest staged file is 9\.0 MB, over the 8 MB bound for one file/);
  assert.match(result.stdout, /the staged store volume review-bridge-advisory-\S+-store was kept, unread/);
  const g = await fixture(t, { realReview: true });
  result = launch(g, ["--review-id", g.reviewId], await fakeDocker(g, { tamper: "big-file" }));
  assert.equal(result.status, 1, result.stdout.slice(-2000));
  assert.match(result.stdout, /copy-back refused — the staged file snapshot\.bin is 9\.0 MB, over the 8 MB bound for one file/);
  const ledger = await loadReview(g.store, g.reviewId);
  assert.equal(ledger.state_version, 1);
});

test("a name is a channel: the container must resolve the sidecar's alias and nothing else", async (t) => {
  const f = await fixture(t, { realReview: true });
  let result = launch(f, ["--review-id", f.reviewId], await fakeDocker(f, { dns: "leak" }));
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /the container resolved example\.com, so a name can carry data out/);
  assert.doesNotMatch(result.stdout, /mcp: /);
  // The positive control rides in the same probe: a resolver that answers
  // nothing at all is not a boundary either.
  const g = await fixture(t, { realReview: true });
  result = launch(g, ["--review-id", g.reviewId], await fakeDocker(g, { dns: "no-alias" }));
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /the sidecar's name egress does not resolve inside the container, so the probe proves nothing about the outside/);
});

test("a Docker that cannot bound the volumes stops the launch rather than running unbounded", async (t) => {
  const f = await fixture(t, { realReview: true });
  const result = launch(f, ["--review-id", f.reviewId], await fakeDocker(f, { volumeUnbounded: true }));
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /was created without the tmpfs size option .*this Docker cannot bound the reviewer's writes, so the launch stops rather than running unbounded/s);
  assert.doesNotMatch(result.stdout, /mcp: /);
});

test("the reviewer's own output cannot fill the host: the transcript keeps its head and a fat rollout is left unread", async (t) => {
  // 70 MB of chatter: the transcript keeps 64 MB, says what it dropped, and
  // the run still reports.
  const f = await fixture(t, { realReview: true });
  let result = launch(f, ["--review-id", f.reviewId], await fakeDocker(f, { huge: true }), { maxBuffer: 192 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stdout.slice(-2000));
  const transcript = result.stdout.match(/^codex exit \d+.*transcript (\S+)$/m)[1];
  const { size } = await fsp.stat(transcript);
  assert.ok(size > 64 * 1024 * 1024 && size < 64 * 1024 * 1024 + 200, `transcript is ${size} bytes`);
  const tail = await fsp.readFile(transcript, "utf8").then((text) => text.slice(-120));
  assert.match(tail, /\[transcript truncated after 64 MB; \d+ more bytes discarded\]/);
  assert.match(result.stdout, /criterion 1 .*: PASS — .*transcript truncated after 64 MB, \d+ bytes discarded/);
  assert.match(result.stdout, /criterion 3 validated verdict copied back to the host store: PASS/);
  assert.match(result.stdout, /^residual: /m);
  // A rollout past its bound is named and never parsed, and the copy-back
  // does not happen.
  const g = await fixture(t, { realReview: true });
  result = launch(g, ["--review-id", g.reviewId], await fakeDocker(g, { fatRollout: true }));
  assert.equal(result.status, 1, result.stdout.slice(-2000));
  assert.match(result.stdout, /criterion 1 .*: FAIL — .*rollout rollout-fat\.jsonl is 9\.0 MB, over the 8 MB bound/);
  assert.match(result.stdout, /refused — pre-copy criteria failed: .*rollout rollout-fat\.jsonl is 9\.0 MB/);
  assert.equal((await loadReview(g.store, g.reviewId)).state_version, 1);
  // Evidence that cannot be read at all is a criterion, not an exception: the
  // report still arrives and the host ledger stays where it was.
  const h = await fixture(t, { realReview: true });
  result = launch(h, ["--review-id", h.reviewId], await fakeDocker(h, { sessionsFile: true }));
  assert.equal(result.status, 1, result.stdout.slice(-2000));
  assert.match(result.stdout, /criterion 1 .*: FAIL — .*(could not be read|no main rollout found)/);
  assert.match(result.stdout, /^residual: /m);
  assert.equal((await loadReview(h.store, h.reviewId)).state_version, 1);
});

test("the container mounts a clone the launcher makes, never the panel checkout's own .git", async (t) => {
  // What the layout check cannot see — a directory where a file is expected,
  // an unreachable object among the real ones — never crosses: the mount is
  // a --no-local clone over file://, and the launcher's clone is gone after
  // the run.
  const f = await fixture(t, { realReview: true });
  await fsp.rm(path.join(f.checkout, ".git", "COMMIT_EDITMSG"), { force: true });
  await fsp.mkdir(path.join(f.checkout, ".git", "COMMIT_EDITMSG"));
  await fsp.writeFile(path.join(f.checkout, ".git", "COMMIT_EDITMSG", "secret"), "ghp_d1rectory\n");
  await fsp.mkdir(path.join(f.checkout, ".git", "objects", "ab"), { recursive: true });
  await fsp.writeFile(path.join(f.checkout, ".git", "objects", "ab", "0".repeat(38)), "not an object");
  const env = await fakeDocker(f);
  const result = launch(f, ["--review-id", f.reviewId], env);
  assert.equal(result.status, 0, result.stdout.slice(-2500));
  const seen = JSON.parse(await fsp.readFile(env.FAKE_CHECKOUT_LOG, "utf8"));
  assert.equal(path.basename(seen.checkout), "checkout");
  assert.notEqual(seen.checkout, f.checkout);
  assert.ok(!seen.checkout.startsWith(`${f.checkout}/`), seen.checkout);
  assert.deepEqual(seen.entries.filter((e) => e === "COMMIT_EDITMSG" || e === "hooks" || e === "info"), []);
  assert.equal(seen.fakeObject, false);
  assert.equal(seen.remoteUrl, `file://${await fsp.realpath(f.checkout)}`);
  const recorded = await fsp.realpath(f.checkout);
  assert.match(result.stdout, new RegExp(`^checkout ${recorded} \\(read-only, at its recorded path; the bytes are a fresh clone the launcher makes at ${seen.checkout}, detached at the review's snapshot head [0-9a-f]{40}\\)$`, "m"));
  const calls = await fsp.readFile(env.FAKE_CALLS, "utf8");
  assert.match(calls, new RegExp(`type=bind,src=${seen.checkout},dst=${recorded},readonly`));
  assert.doesNotMatch(calls, new RegExp(`type=bind,src=${recorded},`));
  await assert.rejects(fsp.access(seen.checkout), /ENOENT/);
  assert.match(result.stdout, /criterion 3 validated verdict copied back to the host store: PASS/);
  assert.doesNotMatch(result.stdout, /cleanup steps that failed/);
});

test("the ledger's snapshot head is the commit: a panel checkout moved since prepare is refused, the probe compares against the record", async (t) => {
  // prepare_review recorded head_sha; a commit, switch, or reset after it
  // would put other bytes under the recorded path.
  const f = await fixture(t, { realReview: true });
  const recordedHead = (await loadReview(f.store, f.reviewId)).rounds.at(-1).head_sha;
  assert.equal(spawnSync("git", ["-C", f.checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim(), recordedHead);
  await commit(f.checkout, "export const value = 3;\n");
  const moved = spawnSync("git", ["-C", f.checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  let result = launch(f, ["--review-id", f.reviewId], { PATH: await gitOnlyPath(t) });
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stderr, new RegExp(`the panel checkout is at ${moved}, but the review's snapshot head is ${recordedHead}`));
  // Back at the recorded head, the launcher's clone is detached there and the
  // probe's HEAD is compared against the record.
  spawnSync("git", ["-C", f.checkout, "checkout", "-q", "--detach", recordedHead]);
  const env = await fakeDocker(f);
  result = launch(f, ["--review-id", f.reviewId], env);
  assert.equal(result.status, 0, result.stdout.slice(-2500));
  assert.match(result.stdout, new RegExp(`detached at the review's snapshot head ${recordedHead}\\)`));
  const probeHead = JSON.parse(await fsp.readFile(env.FAKE_CHECKOUT_LOG, "utf8"));
  assert.equal(spawnSync("git", ["-C", f.checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim(), recordedHead);
  assert.ok(probeHead.checkout.endsWith("/checkout"));
});

test("the mounted checkout's HEAD must be the review's recorded head, at sha1 or sha256 length", async (t) => {
  // A sha256 repository: git writes extensions.objectformat=sha256, which
  // the configuration allowlist admits, and HEAD is 64 hex.
  const previous = process.env.GIT_DEFAULT_HASH;
  process.env.GIT_DEFAULT_HASH = "sha256";
  let f;
  try {
    f = await fixture(t, { realReview: true });
  } finally {
    if (previous === undefined) delete process.env.GIT_DEFAULT_HASH;
    else process.env.GIT_DEFAULT_HASH = previous;
  }
  const head = spawnSync("git", ["-C", f.checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  assert.match(head, /^[0-9a-f]{64}$/);
  assert.match(await fsp.readFile(path.join(f.checkout, ".git", "config"), "utf8"), /objectformat = sha256/);
  let result = launch(f, ["--review-id", f.reviewId], await fakeDocker(f));
  assert.equal(result.status, 0, result.stdout.slice(-2500));
  assert.match(result.stdout, /criterion 3 validated verdict copied back to the host store: PASS/);
  // 39 hex is not a commit id; a different commit is not this checkout.
  const g = await fixture(t, { realReview: true });
  result = launch(g, ["--review-id", g.reviewId], await fakeDocker(g, { head: "0123456789abcdef0123456789abcdef0123456" }));
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /the container boundary did not hold:\n {2}git cannot read the mounted checkout: 0123456789abcdef0123456789abcdef0123456/);
  assert.doesNotMatch(result.stdout, /mcp: /);
  const h = await fixture(t, { realReview: true });
  const hostHead = spawnSync("git", ["-C", h.checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const other = hostHead.replace(/^./, hostHead[0] === "0" ? "1" : "0");
  result = launch(h, ["--review-id", h.reviewId], await fakeDocker(h, { head: other }));
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, new RegExp(`the container boundary did not hold:\\n {2}the mounted checkout's HEAD is ${other}, the review's snapshot head is ${hostHead}`));
  assert.doesNotMatch(result.stdout, /mcp: /);
});

test("a direct egress answer with any HTTP status fails the boundary before the reviewer starts", async (t) => {
  const f = await fixture(t, { realReview: true });
  const env = await fakeDocker(f, { directCode: "403" });
  const result = launch(f, ["--review-id", f.reviewId], env);
  assert.equal(result.status, 1, result.stdout);
  assert.match(
    result.stderr,
    /the container boundary did not hold:\n {2}the container reached https:\/\/example\.com without the proxy \(HTTP 403, curl exit 0\)/,
  );
  assert.doesNotMatch(result.stdout, /mcp: /);
  const ledger = await loadReview(f.store, f.reviewId);
  assert.equal(ledger.state_version, 1);
});

test("a scratch directory with a comma in its path is refused before Docker and before staging", async (t) => {
  const f = await fixture(t, { realReview: true });
  const scratch = path.join(f.root, "t,mp");
  await fsp.mkdir(scratch);
  const result = launch(f, ["--review-id", f.reviewId], { PATH: await gitOnlyPath(t), TMPDIR: scratch });
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stderr, /the scratch directory \(TMPDIR\) .*t,mp contains a comma, which docker's --mount syntax cannot carry/);
  assert.doesNotMatch(result.stderr, /Docker is not available/);
  assert.deepEqual(await fsp.readdir(scratch), []);
});

test("the launcher fails closed when Docker is unavailable", async (t) => {
  const f = await fixture(t);
  const result = launch(f, ["--review-id", REVIEW_ID], { PATH: await gitOnlyPath(t) });
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stderr, /Docker is not available .*; the advisory member has no other launch/);
});

test("the launcher source keeps the container's default confinement and the read-only credential", async () => {
  const source = await fsp.readFile(launcherSource, "utf8");
  assert.doesNotMatch(source, /security-opt|seccomp=unconfined|apparmor=unconfined|--privileged/);
  assert.doesNotMatch(source, /dangerously-bypass-approvals-and-sandbox/);
  assert.match(source, /"--sandbox",\n\s*"danger-full-access"/);
  // auth.json is a bind mount, never a COPY into the image.
  assert.doesNotMatch(source, /COPY|ADD /);
  assert.match(source, /\[inputs\.authJson, `\$\{CONTAINER_CODEX_HOME\}\/auth\.json`, "ro"\]/);
  assert.match(source, /npm install -g @openai\/codex@\$\{CODEX_VERSION\}/);
  assert.match(source, /const CODEX_VERSION = "0\.153\.4"/);
  assert.match(source, /const EGRESS_ALLOW = \["chatgpt\.com", "api\.openai\.com", "auth\.openai\.com"\]/);
  // No exit after a write: every path sets process.exitCode, except the
  // signal handler, which exits from the write callback.
  assert.equal((source.match(/process\.exit\(\d/g) ?? []).length, 1);
  assert.match(source, /process\.stderr\.write\("advisory-sandbox-launch: interrupted\\n", \(\) => process\.exit\(130\)\)/);
});

// The sidecar itself, run locally: CONNECT to an allowlisted host is admitted
// only if the first TLS record is a ClientHello whose server_name equals the
// CONNECT host; the upstream here is a local echo server standing in for
// port 443.
function clientHello(serverName) {
  const parts = [];
  parts.push(Buffer.from([0x03, 0x03]), Buffer.alloc(32, 7), Buffer.from([0x00]));
  parts.push(Buffer.from([0x00, 0x02, 0x13, 0x01]), Buffer.from([0x01, 0x00]));
  let extensions = Buffer.alloc(0);
  if (serverName !== null) {
    const name = Buffer.from(serverName, "ascii");
    const entry = Buffer.concat([Buffer.from([0x00]), Buffer.from([name.length >> 8, name.length & 0xff]), name]);
    const list = Buffer.concat([Buffer.from([entry.length >> 8, entry.length & 0xff]), entry]);
    extensions = Buffer.concat([Buffer.from([0x00, 0x00, list.length >> 8, list.length & 0xff]), list]);
  }
  parts.push(Buffer.from([extensions.length >> 8, extensions.length & 0xff]), extensions);
  const body = Buffer.concat(parts);
  const handshake = Buffer.concat([Buffer.from([0x01, 0x00, body.length >> 8, body.length & 0xff]), body]);
  return Buffer.concat([Buffer.from([0x16, 0x03, 0x01, handshake.length >> 8, handshake.length & 0xff]), handshake]);
}

async function withEgressProxy(t, run, extraEnv = {}) {
  const upstream = net.createServer((socket) => socket.pipe(socket));
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const listenPort = 20000 + Math.floor(Math.random() * 20000);
  const proxy = spawn(process.execPath, [launcherSource, "--egress-proxy"], {
    env: { ...process.env, EGRESS_ALLOW: "localhost,auth.openai.com", EGRESS_LISTEN_PORT: String(listenPort), EGRESS_UPSTREAM_PORT: String(upstream.address().port), ...extraEnv },
  });
  let log = "";
  proxy.stdout.on("data", (chunk) => { log += chunk; });
  await new Promise((resolve) => { const poll = () => (log.includes("listening") ? resolve() : setTimeout(poll, 50)); poll(); });
  t.after(() => { proxy.kill(); upstream.close(); });
  const connect = (firstRecords, authority = "localhost:443") =>
    new Promise((resolve) => {
      const socket = net.connect(listenPort, "127.0.0.1");
      let received = Buffer.alloc(0);
      let established = false;
      socket.on("data", (chunk) => {
        if (!established) {
          established = chunk.toString().includes("200 Connection Established");
          if (established) for (const record of firstRecords) socket.write(record);
          return;
        }
        received = Buffer.concat([received, chunk]);
      });
      socket.on("close", () => resolve({ established, received }));
      socket.on("error", () => {});
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
      setTimeout(() => socket.destroy(), 1500);
    });
  await run({ connect, log: () => log, signal: (name) => proxy.kill(name), exited: () => new Promise((resolve) => proxy.on("exit", resolve)) });
}

test("a record that repeats is written boundedly and the summary still counts every one", async (t) => {
  // A reviewer looping on a refused host would otherwise write a line per
  // attempt into the log Docker keeps on the host.
  await withEgressProxy(
    t,
    async ({ connect, log }) => {
      for (let i = 0; i < 25; i += 1) await connect([], "example.com:443");
      const lines = log().split("\n").filter((line) => line.includes('deny connect "example.com:443"'));
      assert.equal(lines.filter((line) => !line.includes("suppressed")).length, 5);
      assert.equal(lines.filter((line) => line.includes("×5 suppressed")).length, 4);
      // An allowed host's records are counted on their own key.
      assert.doesNotMatch(log(), /allow connect "example\.com/);
    },
    { EGRESS_LOG_REPEAT: "5" },
  );
});

test("counts below the threshold reach the log on their own, by the timer and by SIGTERM", async (t) => {
  // The remainder is not lost: the proxy flushes what it is holding every
  // flush interval, and once more when it is stopped rather than killed.
  await withEgressProxy(
    t,
    async ({ connect, log }) => {
      for (let i = 0; i < 7; i += 1) await connect([], "example.com:443");
      assert.doesNotMatch(log(), /suppressed/);
      await new Promise((resolve) => setTimeout(resolve, 1200));
      assert.match(log(), /deny connect "example\.com:443" ×2 suppressed/);
    },
    { EGRESS_LOG_REPEAT: "5", EGRESS_LOG_FLUSH_MS: "600" },
  );
  // The same remainder, flushed by the SIGTERM `docker stop` sends, with no
  // timer to do it (the interval is longer than the test).
  await withEgressProxy(
    t,
    async ({ connect, log, signal, exited }) => {
      for (let i = 0; i < 8; i += 1) await connect([], "example.com:443");
      assert.doesNotMatch(log(), /suppressed/);
      signal("SIGTERM");
      await exited();
      assert.match(log(), /deny connect "example\.com:443" ×3 suppressed/);
    },
    { EGRESS_LOG_REPEAT: "5", EGRESS_LOG_FLUSH_MS: "600000" },
  );
});

test("the sidecar tunnels only a ClientHello whose SNI equals the CONNECT host", async (t) => {
  await withEgressProxy(t, async ({ connect, log }) => {
    // Same name: admitted, and the hello bytes reach the upstream (echoed back).
    const hello = clientHello("localhost");
    let result = await connect([hello]);
    assert.ok(result.established);
    assert.ok(result.received.equals(hello), "the buffered ClientHello was forwarded upstream");
    assert.match(log(), /allow connect "localhost:443"/);
    // The same hello split across two writes is still one record.
    result = await connect([hello.subarray(0, 7), hello.subarray(7)]);
    assert.ok(result.received.equals(hello));
    // A different name: closed before any byte goes upstream.
    result = await connect([clientHello("evil.example")]);
    assert.equal(result.received.length, 0);
    assert.match(log(), /deny sni-mismatch "localhost:443" sni="evil\.example"/);
    // No SNI at all.
    result = await connect([clientHello(null)]);
    assert.equal(result.received.length, 0);
    assert.match(log(), /deny sni-mismatch "localhost:443" sni="none"/);
    // Not TLS at all.
    result = await connect([Buffer.from("GET / HTTP/1.1\r\nHost: localhost\r\n\r\n")]);
    assert.equal(result.received.length, 0);
    assert.equal((log().match(/deny sni-mismatch "localhost:443" sni="none"/g) ?? []).length, 2);
    // A name carrying a newline cannot forge a second log line: every
    // client-supplied value is written JSON-quoted.
    result = await connect([clientHello("x\n2026-09-10T00:00:00.000Z allow connect evil.example:443")]);
    assert.equal(result.received.length, 0);
    const forged = log().split("\n").filter((line) => line.includes("evil.example:443"));
    assert.equal(forged.length, 1, log());
    // (the parser lowercases the name, as host names compare)
    assert.match(forged[0], /deny sni-mismatch "localhost:443" sni="x\\n2026-09-10t00:00:00\.000z allow connect evil\.example:443"/);
    assert.doesNotMatch(log(), /^\S+ allow connect evil/m);
    assert.equal((log().match(/allow connect "localhost:443"/g) ?? []).length, 2);
    // The refresh endpoint is admitted the same way: CONNECT host and SNI
    // both auth.openai.com. The allow decision is logged before the upstream
    // connection, so this needs no network.
    await connect([clientHello("auth.openai.com")], "auth.openai.com:443");
    assert.match(log(), /allow connect "auth\.openai\.com:443"/);
    await connect([clientHello("chatgpt.com")], "auth.openai.com:443");
    assert.match(log(), /deny sni-mismatch "auth\.openai\.com:443" sni="chatgpt\.com"/);
  });
});

// The report must reach a slow reader whole: the launcher sets the exit code
// and returns rather than exiting after its last write.
test("the final report arrives complete on a slowly drained stdout", async (t) => {
  const f = await fixture(t, { realReview: true });
  const env = await fakeDocker(f, { big: true });
  const child = spawn(process.execPath, [f.launcher, "--review-id", f.reviewId], {
    env: { ...process.env, HOME: f.home, CODEX_HOME: undefined, REVIEW_BRIDGE_HOME: f.store, ...env },
  });
  child.stdout.pause();
  let out = "";
  child.stderr.on("data", () => {});
  const exited = new Promise((resolve) => child.on("close", resolve));
  await new Promise((resolve) => setTimeout(resolve, 2000));
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.stdout.resume();
  const code = await exited;
  assert.equal(code, 0, out.slice(-1500));
  assert.match(out, /^residual: the one host secret inside was .*by the sidecar\n?$/m);
  const scratch = out.match(/^scratch (.+)$/m)[1];
  t.after(() => fsp.rm(scratch, { recursive: true, force: true }));
});

// The proxy log is collected bounded, and a failure to collect it neither
// hides the report nor skips the rest of the cleanup.
test("a huge or failing docker logs leaves the report, the criteria, and every cleanup step intact", async (t) => {
  const f = await fixture(t, { realReview: true });
  const env = await fakeDocker(f, { logs: "big" });
  let result = launch(f, ["--review-id", f.reviewId], env);
  assert.equal(result.status, 0, result.stdout.slice(-2000));
  assert.match(result.stdout, /proxy log: allow connect chatgpt\.com:443 filler[^,]* ×30000, deny connect example\.com:443 ×1$/m);
  assert.match(result.stdout, /criterion 3 validated verdict copied back to the host store: PASS/);
  const g = await fixture(t, { realReview: true });
  const env2 = await fakeDocker(g, { logs: "fail" });
  result = launch(g, ["--review-id", g.reviewId], env2);
  assert.equal(result.status, 0, result.stdout.slice(-2000));
  assert.match(result.stdout, /proxy log: unavailable: Error response from daemon: log driver failed/);
  assert.match(result.stdout, /criterion 2 host filesystem absent: PASS/);
  assert.match(result.stdout, /criterion 3 validated verdict copied back to the host store: PASS/);
  assert.match(result.stdout, /cleanup steps that failed: collect proxy log: Error response from daemon: log driver failed/);
  const calls = await fsp.readFile(env2.FAKE_CALLS, "utf8");
  assert.ok(calls.indexOf("stop -t 2 ") < calls.indexOf("rm -f review-bridge-advisory") || /stop -t 2 review-bridge-advisory-\S+-egress[\s\S]*rm -f review-bridge-advisory-\S+-egress/.test(calls), calls);
  for (const pattern of [/^stop -t 2 review-bridge-advisory-\S+-egress$/m, /^rm -f review-bridge-advisory-\S+-codex$/m, /^rm -f review-bridge-advisory-\S+-egress$/m, /^network rm review-bridge-advisory-/m, /^run --rm .*--network none .*cp -a \/codex-home\/sessions/m, /^volume rm review-bridge-advisory-\S+-home$/m]) {
    assert.match(calls, pattern);
  }
  assert.equal((await loadReview(g.store, g.reviewId)).status, "REVIEW_SUBMITTED");
  // A cleanup step that exits nonzero is a failure too, named with its
  // stderr, and the run's outcome is still the criteria's.
  const h = await fixture(t, { realReview: true });
  result = launch(h, ["--review-id", h.reviewId], await fakeDocker(h, { volumeRmFail: true }));
  assert.equal(result.status, 0, result.stdout.slice(-2000));
  assert.match(result.stdout, /cleanup steps that failed: remove volume: Error response from daemon: volume is in use/);
  assert.match(result.stdout, /criterion 3 validated verdict copied back to the host store: PASS/);
  // The codex container runs with --rm, so Docker has usually removed it
  // before cleanup; that one answer is not a failure, any other still is.
  const i = await fixture(t, { realReview: true });
  result = launch(i, ["--review-id", i.reviewId], await fakeDocker(i, { rmFail: "nosuch" }));
  assert.equal(result.status, 0, result.stdout.slice(-2000));
  assert.doesNotMatch(result.stdout, /cleanup steps that failed/);
  const j = await fixture(t, { realReview: true });
  result = launch(j, ["--review-id", j.reviewId], await fakeDocker(j, { rmFail: "other" }));
  assert.equal(result.status, 0, result.stdout.slice(-2000));
  assert.match(result.stdout, /cleanup steps that failed: remove codex container: Error response from daemon: boom/);
  // The rollouts are the only copy of the guardian evidence: a failed export
  // is a failure and the volume stays, named in the report.
  const k = await fixture(t, { realReview: true });
  const kEnv = await fakeDocker(k, { sessions: "fail" });
  result = launch(k, ["--review-id", k.reviewId], kEnv);
  assert.equal(result.status, 0, result.stdout.slice(-2000));
  assert.match(result.stdout, /cleanup steps that failed: export sessions: cp: cannot create \/out\/sessions/);
  assert.match(result.stdout, /the CODEX_HOME volume review-bridge-advisory-\S+-home was kept for the failed export/);
  const kCalls = await fsp.readFile(kEnv.FAKE_CALLS, "utf8");
  assert.doesNotMatch(kCalls, /^volume rm review-bridge-advisory-\S+-home$/m);
  // The keeper holds that volume's tmpfs, so it stays up with it.
  assert.doesNotMatch(kCalls, /^rm -f review-bridge-advisory-\S+-keeper$/m);
  assert.match(result.stdout, /the volume keeper review-bridge-advisory-\S+-keeper is still running to hold review-bridge-advisory-\S+-home/);
  // No sessions directory at all is the one answer that is not a failure.
  const l = await fixture(t, { realReview: true });
  const lEnv = await fakeDocker(l, { sessions: "none" });
  result = launch(l, ["--review-id", l.reviewId], lEnv);
  assert.equal(result.status, 0, result.stdout.slice(-2000));
  assert.doesNotMatch(result.stdout, /cleanup steps that failed/);
  assert.match(result.stdout, /guardian verdicts \(\d+\) — no sessions recorded:/);
  const lCalls = await fsp.readFile(lEnv.FAKE_CALLS, "utf8");
  assert.match(lCalls, /^volume rm/m);
  // Nothing kept, so the keeper goes with the volumes.
  assert.match(lCalls, /^rm -f review-bridge-advisory-\S+-keeper$/m);
  assert.doesNotMatch(result.stdout, /the volume keeper/);
});

test("a consumer that stops reading does not kill the run: cleanup and the exit code stand", async (t) => {
  // `… | head` closes the pipe; an unhandled EPIPE would take the process
  // down outside the promise and the finally, leaving containers, the proxy,
  // the keeper, the network, and the volumes up.
  const f = await fixture(t, { realReview: true });
  const env = await fakeDocker(f);
  const child = spawn(process.execPath, [f.launcher, "--review-id", f.reviewId], {
    env: { ...process.env, HOME: f.home, CODEX_HOME: undefined, REVIEW_BRIDGE_HOME: f.store, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.once("data", () => child.stdout.destroy());
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 0, stderr.slice(-2000));
  assert.doesNotMatch(stderr, /EPIPE/);
  const calls = await fsp.readFile(env.FAKE_CALLS, "utf8");
  for (const pattern of [
    /^rm -f review-bridge-advisory-\S+-codex$/m,
    /^stop -t 2 review-bridge-advisory-\S+-egress$/m,
    /^rm -f review-bridge-advisory-\S+-egress$/m,
    /^network rm review-bridge-advisory-/m,
    /^rm -f review-bridge-advisory-\S+-keeper$/m,
    /^volume rm review-bridge-advisory-\S+-home$/m,
    /^volume rm review-bridge-advisory-\S+-store$/m,
  ]) {
    assert.match(calls, pattern, calls);
  }
  // The verdict still reached the host ledger, printable or not.
  assert.equal((await loadReview(f.store, f.reviewId)).status, "REVIEW_SUBMITTED");
});

test("a snapshot prepared over a dirty tree is refused before Docker: the clone can materialize only commits", async (t) => {
  const f = await fixture(t, { ledger: { rounds: [{ round: 1, base_sha: "0".repeat(40), head_sha: "0".repeat(40), worktree_clean: false, overlays: [{ path: "src/x.mjs", type: "modified" }] }] } });
  const env = await fakeDocker(f);
  const result = launch(f, ["--review-id", REVIEW_ID], env);
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stderr, /the review's snapshot carries worktree overlays; the container review needs a clean commit — prepare it from the panel clone/);
  await assert.rejects(fsp.access(env.FAKE_CALLS), /ENOENT/);
});
