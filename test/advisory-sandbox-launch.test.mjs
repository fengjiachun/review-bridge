import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadReview, prepareReview } from "../src/core.mjs";
import { commit, fixture as repositoryFixture } from "./helpers/repository-fixture";

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
const launcherSource = path.join(
  projectRoot,
  "templates",
  "codex-plugin",
  "scripts",
  "advisory-sandbox-launch.mjs",
);
const REVIEW_ID = "rb-2026-09-10T000000-000Z-0badcafe";

async function fixture(t, { ledger = {}, checkoutName = "panel/review-bridge", checkoutPath = null, realReview = false } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "review-bridge-advisory-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const plugin = path.join(root, "plugin");
  await fsp.mkdir(path.join(plugin, "scripts"), { recursive: true });
  await fsp.copyFile(launcherSource, path.join(plugin, "scripts", "advisory-sandbox-launch.mjs"));
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
    const prepared = await prepareReview(repo.store, {
      repositoryPath: repo.repository,
      baseRef: repo.baseSha,
      requirement: "Author's claim (unverified), PR #1: \"change\"",
      implementationScope: "advisory panel member",
      forceFullReview: true,
      reviewerProvider: "CODEX_TASK",
      advisory: true,
    });
    // The fixture commits with a local user.name/user.email; a fresh clone
    // never writes those, and the launcher accepts only what a fresh clone
    // writes, so drop them once the commits are done.
    for (const key of ["user.name", "user.email"]) {
      spawnSync("git", ["-C", repo.repository, "config", "--unset", key]);
    }
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
    if (!checkoutPath) spawnSync("git", ["-C", checkout, "init", "-q"]);
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
async function fakeDocker(f, { tamper = "", directCode = "", big = false, serverError = "", present = "", imagePresent = "", baselineChildren = "", baselineHasExpected = false, leak = "", exit = "" } = {}) {
  const bin = path.join(f.root, "bin");
  await fsp.mkdir(bin, { recursive: true });
  const runner = path.join(bin, "fake-run.mjs");
  await fsp.writeFile(
    runner,
    `import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
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
  out.push({ kind: "checkout-head", value: spawnSync("git", ["-C", spec.checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim() });
  out.push({ kind: "store-writable", value: true });
  out.push({ kind: "egress", via: "proxy", code: "000", exit: 56 });
  out.push({ kind: "egress", via: "direct", code: process.env.FAKE_DIRECT_CODE || "000", exit: process.env.FAKE_DIRECT_CODE ? 0 : 6 });
  out.push({ kind: "codex-version", value: "codex-cli 0.153.4" });
  out.push({ kind: "uid", value: process.getuid() });
  process.stdout.write(out.map((r) => JSON.stringify(r)).join("\\n") + "\\n");
} else {
  const staged = bind("/store");
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
    call("submit_review");
  }
  if (variant === "extra-line") process.stdout.write("mcp: review-bridge-reviewer/list_pending_reviews started\\nmcp: review-bridge-reviewer/list_pending_reviews (completed)\\n");
  fs.mkdirSync(path.join(scratch, "sessions"), { recursive: true });
  const event = (item) => JSON.stringify({ type: "event_msg", payload: { type: "item_completed", item } });
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
case "$1 $2" in
  "version --format") echo "28.3.2 linux/arm64" ;;
  "image inspect") exit 0 ;;
  "network create"|"network connect"|"network rm"|"volume rm"|"rm -f") exit 0 ;;
  "logs "*) echo "2026-09-10T00:00:00.000Z listening 3128 allow chatgpt.com,api.openai.com"; echo "2026-09-10T00:00:01.000Z deny connect example.com:443"; echo "2026-09-10T00:00:02.000Z allow connect chatgpt.com:443" ;;
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
  };
}

function launch(f, args, env = {}) {
  return spawnSync(process.execPath, [f.launcher, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
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
  assert.match(out, new RegExp(`checkout ${f.checkout} \\(read-only, at its recorded path\\)`));
  assert.match(out, new RegExp(`marketplace ${f.marketplace} \\(plugin 9\\.9\\.9, read-only\\)`));
  // The mount table: read-only unless the reviewer must write it.
  const bind = (source, target, readonly) =>
    new RegExp(`--mount type=bind,src=${source},dst=${target}${readonly ? ",readonly" : ""}(?: |'? )`);
  assert.match(out, bind(f.authJson, "/codex-home/auth\\.json", true));
  assert.match(out, bind(f.marketplace, "/marketplace", true));
  assert.match(
    out,
    bind(f.pluginSource, "/codex-home/plugins/cache/review-bridge-local/review-bridge/9\\.9\\.9", true),
  );
  assert.match(out, bind(f.checkout, f.checkout, true));
  // The host store is never mounted; a staged copy of the one review is.
  assert.doesNotMatch(out, new RegExp(`src=${f.store}[,/]`));
  assert.match(out, /store,dst=\/store'? /);
  assert.match(out, new RegExp(`store ${f.store} \\(never mounted; the review is staged under`));
  assert.match(out, /config\.toml,dst=\/codex-home\/config\.toml,readonly'? /);
  // CODEX_HOME is a volume and the working directory a tmpfs, not host
  // directories; the six binds above are the whole of the host inside.
  assert.match(out, /--mount type=volume,src=review-bridge-advisory-\S+-home,dst=\/codex-home /);
  assert.match(out, /--tmpfs \/work:rw,mode=1777/);
  const codexLine = out.split("\n").filter((line) => line.includes(" codex exec ")).pop();
  assert.equal((codexLine.match(/ --mount '?type=bind,/g) ?? []).length, 6);
  assert.doesNotMatch(codexLine, / -v /);
  assert.match(out, /cp -a \/codex-home\/sessions \/out\/sessions/);
  assert.match(out, /docker volume rm review-bridge-advisory-\S+-home/);
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
  assert.equal((probeLines[0].match(/ --mount '?type=bind,/g) ?? []).length, 5);
  assert.doesNotMatch(probeLines[0], new RegExp(`src=${f.checkout},`));
  assert.equal((probeLines[1].match(/ --mount '?type=bind,/g) ?? []).length, 6);
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
    new RegExp(`--mount 'type=bind,src=${f.checkout},dst=${f.checkout},readonly'`),
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

test("a checkout whose Git configuration carries a credential is refused before Docker is touched", async (t) => {
  const PATH = await gitOnlyPath(t);
  const f = await fixture(t, { realReview: true });
  spawnSync("git", ["-C", f.checkout, "config", "http.https://github.com/.extraheader", "AUTHORIZATION: basic c2VjcmV0"]);
  let result = launch(f, ["--review-id", f.reviewId], { PATH });
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stderr, /local Git configuration holds more than a fresh clone writes \(http\.https:\/\/github\.com\/\.extraheader\)/);
  assert.doesNotMatch(result.stderr, /c2VjcmV0|Docker is not available/);
  const g = await fixture(t, { realReview: true });
  spawnSync("git", ["-C", g.checkout, "remote", "set-url", "origin", "https://user:t0k3n@example.com/x.git"]);
  result = launch(g, ["--review-id", g.reviewId], { PATH });
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stderr, /holds more than a fresh clone writes \(remote\.origin\.url \(credential in the URL\)\)/);
  assert.doesNotMatch(result.stderr, /t0k3n/);
  // A token standing as the user of an https URL is a credential; the
  // fixture's own `ssh://git@github.com/…` remote is a username and passes.
  const h = await fixture(t, { realReview: true });
  spawnSync("git", ["-C", h.checkout, "remote", "set-url", "origin", "https://ghp_t0k3n@github.com/x/y.git"]);
  result = launch(h, ["--review-id", h.reviewId], { PATH });
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stderr, /holds more than a fresh clone writes \(remote\.origin\.url \(credential in the URL\)\)/);
  const i = await fixture(t, { realReview: true });
  result = launch(i, ["--review-id", i.reviewId, "--dry-run"]);
  assert.equal(result.status, 0, result.stderr);
  // A credential URL in a key name is refused too, and printed redacted.
  const m = await fixture(t, { realReview: true });
  spawnSync("git", ["-C", m.checkout, "config", "url.https://ghp_s3cr3t@github.com/.insteadOf", "https://github.com/"]);
  result = launch(m, ["--review-id", m.reviewId], { PATH });
  assert.equal(result.status, 2, result.stdout);
  // git lowercases the variable part of the key on output.
  assert.match(result.stderr, /holds more than a fresh clone writes \(url\.https:\/\/<redacted>@github\.com\/\.insteadof\)/i);
  assert.doesNotMatch(result.stderr, /ghp_s3cr3t/);
  // An included file is read too; a credential helper is a credential.
  const k = await fixture(t, { realReview: true });
  await fsp.writeFile(path.join(k.checkout, ".git", "cred.inc"), '[http "https://github.com/"]\n\textraheader = AUTHORIZATION: basic c2VjcmV0\n');
  spawnSync("git", ["-C", k.checkout, "config", "include.path", "cred.inc"]);
  result = launch(k, ["--review-id", k.reviewId], { PATH });
  assert.equal(result.status, 2, result.stdout);
  // include.path is itself outside the allowlist, so both keys are named.
  assert.match(result.stderr, /holds more than a fresh clone writes \(include\.path, http\.https:\/\/github\.com\/\.extraheader\)/);
  const l = await fixture(t, { realReview: true });
  spawnSync("git", ["-C", l.checkout, "config", "credential.helper", "store --file=.git/credentials"]);
  result = launch(l, ["--review-id", l.reviewId], { PATH });
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stderr, /holds more than a fresh clone writes \(credential\.helper\)/);
  assert.doesNotMatch(result.stderr, /\.git\/credentials/);
  // The keys that slipped a denylist: a cookie file and a client key inside
  // the checkout are refused by name, values unread.
  for (const [key, value] of [["http.cookieFile", ".git/cookies"], ["http.sslKey", ".git/client.key"]]) {
    const n = await fixture(t, { realReview: true });
    spawnSync("git", ["-C", n.checkout, "config", key, value]);
    result = launch(n, ["--review-id", n.reviewId], { PATH });
    assert.equal(result.status, 2, `${key}: ${result.stdout}`);
    assert.match(result.stderr, new RegExp(`holds more than a fresh clone writes \\(${key.toLowerCase().replace(".", "\\.")}\\)`));
    assert.doesNotMatch(result.stderr, /\.git\/(cookies|client\.key)/);
  }
  // core.* is not accepted wholesale: the keys that carry a command or a
  // credential are refused by name.
  for (const [key, value] of [["core.askPass", "/tmp/askpass.sh"], ["core.gitProxy", "/tmp/proxy.sh"], ["core.sshCommand", "ssh -i .git/id"]]) {
    const q = await fixture(t, { realReview: true });
    spawnSync("git", ["-C", q.checkout, "config", key, value]);
    result = launch(q, ["--review-id", q.reviewId], { PATH });
    assert.equal(result.status, 2, `${key}: ${result.stdout}`);
    assert.match(result.stderr, new RegExp(`holds more than a fresh clone writes \\(${key.toLowerCase().replace(".", "\\.")}\\)`));
    assert.doesNotMatch(result.stderr, /askpass\.sh|proxy\.sh|\.git\/id/);
  }
  // The configuration a fresh clone plus the skill's fetch and checkout
  // steps actually write passes: a bare origin, cloned, fetched into
  // refs/review-bridge/…, checked out detached.
  const origin = await repositoryFixture();
  t.after(() => fsp.rm(origin.root, { recursive: true, force: true }));
  const bare = path.join(origin.root, "origin.git");
  spawnSync("git", ["clone", "-q", "--bare", origin.repository, bare]);
  const panel = path.join(origin.root, "panel-clone");
  spawnSync("git", ["clone", "-q", bare, panel]);
  spawnSync("git", ["-C", panel, "fetch", "-q", "origin", "+main:refs/review-bridge/1/base", "+agent/workflow-core:refs/review-bridge/1/head"]);
  spawnSync("git", ["-C", panel, "checkout", "-q", "--detach", "refs/review-bridge/1/head"]);
  const o = await fixture(t, { checkoutPath: panel });
  result = launch(o, ["--review-id", REVIEW_ID, "--dry-run"]);
  // On a failure here, the message names the key git wrote that the
  // enumeration lacks; add it to FRESH_CLONE_CONFIG_KEYS with the platform.
  assert.equal(result.status, 0, `${result.stderr}\nclone config:\n${spawnSync("git", ["-C", panel, "config", "--local", "--list"], { encoding: "utf8" }).stdout}`);
  // git itself unavailable: the check fails closed rather than passing by
  // not running.
  const j = await fixture(t, { realReview: true });
  result = launch(j, ["--review-id", j.reviewId, "--dry-run"], { PATH: "" });
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stderr, /cannot read the author checkout's Git configuration/);
});

test("a host credential directory present inside the container fails the boundary before the reviewer starts", async (t) => {
  const f = await fixture(t, { realReview: true });
  const env = await fakeDocker(f, { present: `${f.home}/.ssh` });
  const result = launch(f, ["--review-id", f.reviewId], env);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, new RegExp(`the container boundary did not hold:\\n {2}host path present inside the container: ${f.home}/\\.ssh`));
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

test("only a self-contained clone is accepted: a linked worktree and a shared clone are refused before Docker", async (t) => {
  const PATH = await gitOnlyPath(t);
  const repo = await repositoryFixture();
  t.after(() => fsp.rm(repo.root, { recursive: true, force: true }));
  const worktree = path.join(repo.root, "linked");
  spawnSync("git", ["-C", repo.repository, "worktree", "add", "-q", worktree, "-b", "panel"]);
  const f = await fixture(t, { checkoutPath: worktree });
  let result = launch(f, ["--review-id", REVIEW_ID], { PATH });
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stderr, /is not a self-contained clone: \.git is a file \(a linked worktree or a separate git dir\); use a self-contained clone \(git clone <remote-url> <path>\)/);
  const shared = path.join(repo.root, "shared");
  spawnSync("git", ["clone", "-q", "-s", repo.repository, shared]);
  const g = await fixture(t, { checkoutPath: shared });
  result = launch(g, ["--review-id", REVIEW_ID], { PATH });
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stderr, /is not a self-contained clone: it reads objects through \.git\/objects\/info\/alternates/);
  const plain = path.join(repo.root, "plain");
  spawnSync("git", ["clone", "-q", repo.repository, plain]);
  const h = await fixture(t, { checkoutPath: plain });
  result = launch(h, ["--review-id", REVIEW_ID, "--dry-run"]);
  assert.equal(result.status, 0, result.stderr);
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

async function withEgressProxy(t, run) {
  const upstream = net.createServer((socket) => socket.pipe(socket));
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const listenPort = 20000 + Math.floor(Math.random() * 20000);
  const proxy = spawn(process.execPath, [launcherSource, "--egress-proxy"], {
    env: { ...process.env, EGRESS_ALLOW: "localhost,auth.openai.com", EGRESS_LISTEN_PORT: String(listenPort), EGRESS_UPSTREAM_PORT: String(upstream.address().port) },
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
  await run({ connect, log: () => log });
}

test("the sidecar tunnels only a ClientHello whose SNI equals the CONNECT host", async (t) => {
  await withEgressProxy(t, async ({ connect, log }) => {
    // Same name: admitted, and the hello bytes reach the upstream (echoed back).
    const hello = clientHello("localhost");
    let result = await connect([hello]);
    assert.ok(result.established);
    assert.ok(result.received.equals(hello), "the buffered ClientHello was forwarded upstream");
    assert.match(log(), /allow connect localhost:443/);
    // The same hello split across two writes is still one record.
    result = await connect([hello.subarray(0, 7), hello.subarray(7)]);
    assert.ok(result.received.equals(hello));
    // A different name: closed before any byte goes upstream.
    result = await connect([clientHello("evil.example")]);
    assert.equal(result.received.length, 0);
    assert.match(log(), /deny sni-mismatch localhost:443 sni=evil\.example/);
    // No SNI at all.
    result = await connect([clientHello(null)]);
    assert.equal(result.received.length, 0);
    assert.match(log(), /deny sni-mismatch localhost:443 sni=none/);
    // Not TLS at all.
    result = await connect([Buffer.from("GET / HTTP/1.1\r\nHost: localhost\r\n\r\n")]);
    assert.equal(result.received.length, 0);
    assert.equal((log().match(/deny sni-mismatch localhost:443 sni=none/g) ?? []).length, 2);
    assert.equal((log().match(/allow connect localhost:443/g) ?? []).length, 2);
    // The refresh endpoint is admitted the same way: CONNECT host and SNI
    // both auth.openai.com. The allow decision is logged before the upstream
    // connection, so this needs no network.
    await connect([clientHello("auth.openai.com")], "auth.openai.com:443");
    assert.match(log(), /allow connect auth\.openai\.com:443/);
    await connect([clientHello("chatgpt.com")], "auth.openai.com:443");
    assert.match(log(), /deny sni-mismatch auth\.openai\.com:443 sni=chatgpt\.com/);
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
