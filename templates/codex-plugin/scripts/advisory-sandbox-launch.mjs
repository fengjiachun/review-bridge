#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isolatedGit as hostGit } from "./isolated-git.mjs";

// The only launch form for an advisory CODEX_TASK review. The container is the
// read boundary: nothing from the host exists inside it except the mounts
// listed in mountTable(), so an outside author's diff cannot steer the
// reviewer into reading host credentials — the paths are absent, not denied.
// Inside the container the reviewer runs with `--sandbox danger-full-access`
// on purpose: Codex's nested bubblewrap does not start under Docker's default
// seccomp/apparmor confinement, and relaxing that confinement to fit a second
// sandbox inside would weaken the one boundary that matters. Egress is routed
// through a sidecar proxy that admits only the model endpoints, so the one
// host secret inside (auth.json) has nowhere else to go.

const CODEX_VERSION = "0.153.4";
const BASE_IMAGE = "node:22.22.0-bookworm";
const MARKETPLACE_NAME = "review-bridge-local";
const PLUGIN_NAME = "review-bridge";
const AUTHOR_SERVER = "review-bridge-author";
const REVIEWER_SERVER = "review-bridge-reviewer";
// chatgpt.com carries the model calls in ChatGPT-token mode, api.openai.com
// in API-key mode, and auth.openai.com is the token refresh endpoint an
// expired ChatGPT token is renewed against mid-run. Refreshed tokens are not
// persisted back: auth.json is read-only in the container, so the next run
// refreshes again.
const EGRESS_ALLOW = ["chatgpt.com", "api.openai.com", "auth.openai.com"];
const listOf = (names) => `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
const PROXY_PORT = 3128;
const PROXY_ALIAS = "egress";
// Every proxy variable a client may read, pinned explicitly: the Docker CLI
// injects the lowercase pair, ALL_PROXY, and NO_PROXY from its own proxy
// configuration, curl prefers the lowercase names, and NO_PROXY can switch a
// proxy off wholesale. The four proxy names point at the sidecar; the four
// override names are set to the empty string rather than left unset.
const PROXY_URL = `http://${PROXY_ALIAS}:${PROXY_PORT}`;
const PROXY_ENV = {
  HTTP_PROXY: PROXY_URL,
  HTTPS_PROXY: PROXY_URL,
  http_proxy: PROXY_URL,
  https_proxy: PROXY_URL,
  ALL_PROXY: "",
  all_proxy: "",
  NO_PROXY: "",
  no_proxy: "",
};
const CONTAINER_CODEX_HOME = "/codex-home";
const CONTAINER_MARKETPLACE = "/marketplace";
const CONTAINER_STORE = "/store";
const CONTAINER_WORK = "/work";
const CONTAINER_LAUNCHER = "/launcher";
// Host prefixes Docker Desktop does not keep serving: on macOS, files under an
// app-sandbox scratch directory (`/private/tmp/<app>-<uid>/…`) and on a
// removable volume were readable when a container started and returned
// `Permission denied` to a plain read a few seconds later, while the same
// files under the home directory stayed readable for whole runs (measured
// 2026-09-10, Docker Desktop 28.3.2). A checkout, marketplace, store, or
// scratch directory there is refused up front rather than probed or worked
// around.
const UNSERVED_HOST_PREFIXES = ["/private/tmp/", "/Volumes/"];

const scriptPath = fileURLToPath(import.meta.url);
const pluginRoot = path.resolve(path.dirname(scriptPath), "..");

// /codex-home is created world-writable so the volume mounted there inherits
// that mode and the operator's uid can write it.
const DOCKERFILE = `FROM ${BASE_IMAGE}
RUN apt-get update \\
 && apt-get install -y --no-install-recommends git ca-certificates procps util-linux \\
 && rm -rf /var/lib/apt/lists/* \\
 && git config --system safe.directory '*' \\
 && mkdir -m 1777 ${CONTAINER_CODEX_HOME} ${CONTAINER_WORK}
RUN npm install -g @openai/codex@${CODEX_VERSION} && codex --version
ENV CODEX_HOME=${CONTAINER_CODEX_HOME}
WORKDIR ${CONTAINER_WORK}
`;
// The tag carries the Dockerfile's hash, so a changed Dockerfile is a new
// image rather than a stale reuse.
const IMAGE = `review-bridge-advisory-codex:${CODEX_VERSION}-${crypto
  .createHash("sha256")
  .update(DOCKERFILE)
  .digest("hex")
  .slice(0, 8)}`;

// No container the launcher starts may exhaust the host: memory is capped
// with swap pinned to the same figure (so the cap is real rather than pushed
// into swap), processes and CPU are capped too. The reviewer's container gets
// the headroom a review needs and the operator can raise it; the helpers —
// the probes, the sidecar, the copies in and out — need very little.
const DEFAULT_MEMORY = "4g";
const DEFAULT_CPUS = "2";
const HELPER_LIMITS = ["--memory", "512m", "--memory-swap", "512m", "--pids-limit", "128", "--cpus", "1"];
const codexLimits = (memory, cpus) => ["--memory", memory, "--memory-swap", memory, "--pids-limit", "512", "--cpus", cpus];

// The staged store is a Docker volume, so a reviewer writing without bound
// fills the volume rather than the host's partition; what comes back out is
// measured inside the container first. A review's ledger, findings, and
// artifacts are far below this.
const STAGED_STORE_LIMIT_MB = 64;
const STAGED_FILE_LIMIT_MB = 8;
// The reviewer's own output: the transcript keeps its head, where the session
// id and the mcp lines are, and stops there; a rollout larger than one review
// ever needs is evidence the launcher will not read into memory.
const TRANSCRIPT_LIMIT_MB = 64;
const ROLLOUT_LIMIT_MB = 8;
const CODEX_HOME_LIMIT = "1g";

const USAGE = `Usage: advisory-sandbox-launch.mjs --review-id <id> [--store <path>]
       [--marketplace <path>] [--dry-run]

  Launch the CODEX_TASK reviewer for one advisory review inside a Linux
  container that is the filesystem read boundary. This is the only launch an
  advisory review takes; the host launch in the workflow skill is for the
  operator's own changes and never reviews a third party's pull request.

  --review-id <id>     The advisory review to run. The ledger must be bound to
                       CODEX_TASK, carry advisory: true, and be waiting for
                       review; what is mounted read-only at the ledger's own
                       repository_path is a fresh clone the launcher makes
                       from that checkout (git clone --template= --no-local),
                       never the operator's .git; the path is the recorded one
                       because the reviewer server reads it by that path.
  --store <path>       The review store (default: REVIEW_BRIDGE_HOME, else the
                       server's default). The host store is never mounted, and
                       neither is any host directory the reviewer can write:
                       the one review is copied into a tmpfs-backed Docker
                       volume capped at ${STAGED_STORE_LIMIT_MB} MB (CODEX_HOME
                       likewise, at ${CODEX_HOME_LIMIT}), mounted read-write at
                       ${CONTAINER_STORE}, so a write past the cap fails inside
                       the container; both caps last the run and go with the
                       volumes. Afterwards the store's apparent size is
                       measured there and it is copied out only within
                       ${STAGED_STORE_LIMIT_MB} MB overall and
                       ${STAGED_FILE_LIMIT_MB} MB for any one file — past
                       either the volume is kept unread and named in the
                       report. The verdict is copied back only after
                       validation.
  --marketplace <path> The packaged codex-marketplace directory (default: the
                       source of [marketplaces.${MARKETPLACE_NAME}] in the
                       operator's codex config.toml). Mounted read-only.
  --memory <size>      Memory for the reviewer's container, swap pinned to it
                       (default ${DEFAULT_MEMORY}; a smaller figure is refused).
  --cpus <count>       CPUs for the reviewer's container (default
                       ${DEFAULT_CPUS}; a smaller figure is refused). Every
                       container also runs under a process limit, and the
                       helpers — probes, sidecar, the copies in and out — get
                       512m and one CPU.
  --dry-run            Validate every input and print the docker commands
                       without running any of them. Needs no Docker.

  Fails closed, exit 2, when Docker is unavailable or any mount source is
  missing: the advisory member has no other launch. Also refused, exit 2: a
  checkout, marketplace, store, or scratch directory under /private/tmp/ or
  /Volumes/, because Docker Desktop stops serving files there a few seconds
  into a container; place the panel worktree and store under your home
  directory. The image (${BASE_IMAGE}
  plus @openai/codex@${CODEX_VERSION}) is built on first use and reused.
  The operator's ~/.codex/auth.json is bind-mounted read-only and never copied
  into an image layer. Egress from the container goes only through a sidecar
  proxy that admits ${listOf(EGRESS_ALLOW)}, allowlisted by CONNECT host and by
  the TLS SNI the client then presents; everything else is refused. The last
  is the token refresh endpoint; refreshed tokens are not persisted back
  (auth.json is read-only in the container).

  On exit the launcher prints the three criteria it just verified — the
  reviewer's MCP calls completed inside the container, the host filesystem
  was absent, the validated verdict was copied back to the host store — with
  the guardian's verdict per call and the proxy's egress log. The first
  criterion is run-health evidence recorded inside the container and
  forgeable by a reviewer with shell access; the copy-back's integrity rests
  on the host replay, not on it. The staged
  bytes are never copied: the verdict is replayed through the host's own
  submit_review against the host ledger, under that review's own state lock,
  with the findings the staged ledger records as the payload, and the host
  keeps the replay's result only when it equals the staged ledger field for
  field, timestamps aside. A staged ledger the replay cannot produce, a staged
  store that changed or added any other file, or a host ledger that moved
  since launch is refused; a failed check leaves the host store unwritten and
  the staged copy for inspection. The isolated CODEX_HOME lives
  in a Docker volume for the run and its sessions (the rollouts, guardian
  threads included) are copied into the scratch directory beside the codex
  transcript, which is kept and named for the record.

  Residual: the one host secret inside the container is auth.json, so the
  operator's credential rides into every advisory review. A narrowly scoped
  API key in place of the ChatGPT token is the operator's option; this
  launcher does not touch how auth.json is produced.
`;

// Every exit goes through process.exitCode and a natural return, never
// process.exit() after a write: stdout and stderr may be pipes, and a write
// followed by process.exit() can lose its tail when the reader is slow. fail()
// therefore throws, and the top level turns the throw into the exit code.
class LaunchFailure extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

function fail(message, code = 2) {
  throw new LaunchFailure(message, code);
}

function shellQuote(value) {
  return /^[A-Za-z0-9_./:=@%+,-]+$/.test(value)
    ? value
    : `'${value.replace(/'/g, `'\\''`)}'`;
}

function parseArgs(argv) {
  const options = {
    reviewId: null,
    store: null,
    marketplace: null,
    dryRun: false,
    egressProxy: false,
    help: false,
    memory: DEFAULT_MEMORY,
    cpus: DEFAULT_CPUS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined) fail(`${arg} needs a value\n${USAGE}`);
      index += 1;
      return next;
    };
    if (arg === "--review-id") options.reviewId = value();
    else if (arg === "--store") options.store = path.resolve(value());
    else if (arg === "--marketplace") options.marketplace = path.resolve(value());
    else if (arg === "--memory") options.memory = value();
    else if (arg === "--cpus") options.cpus = value();
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--egress-proxy") options.egressProxy = true;
    else if (arg === "--help") options.help = true;
    else fail(`unknown argument ${arg}\n${USAGE}`);
  }
  // The defaults are a floor: the operator may give the reviewer more, never
  // less, since below them a review does not finish and the failure looks
  // like the reviewer's.
  const memory = /^([1-9][0-9]*)(m|g)$/.exec(options.memory);
  if (!memory) fail(`--memory takes a figure such as 4g or 6144m, not ${options.memory}`);
  if (Number(memory[1]) * (memory[2] === "g" ? 1024 : 1) < 4096) fail(`--memory ${options.memory} is below the ${DEFAULT_MEMORY} a review needs`);
  if (!/^[1-9][0-9]*(\.[0-9]+)?$/.test(options.cpus) || Number(options.cpus) < Number(DEFAULT_CPUS)) {
    fail(`--cpus ${options.cpus} is below the ${DEFAULT_CPUS} a review needs`);
  }
  return options;
}

// The sidecar. A CONNECT-only proxy: an allowlisted host on 443 is tunnelled,
// anything else — another host, another port, a plain HTTP request — is
// refused with 403 and logged. The codex container sits on an internal Docker
// network with no route out, so this process is its only path to the network
// and its log is the complete egress record of the run.
//
// The CONNECT authority alone is not the allowlist: a client could CONNECT to
// an allowed host and then present a TLS ClientHello whose server_name points
// at another tenant of the same front (domain fronting), and the bytes would
// be piped blind. So after CONNECT is admitted the proxy reads the client's
// first TLS record, parses the ClientHello's server_name, and starts the
// tunnel only when it equals the CONNECT host; no SNI, a different SNI, a
// first record that is not a ClientHello, or a record over 16 KB closes the
// connection and logs `deny sni-mismatch`. TLS is not terminated: the proxy
// never sees inside the session, it only reads the name the client announces.
// EGRESS_ALLOW, EGRESS_LISTEN_PORT, and EGRESS_UPSTREAM_PORT exist for the
// tests; the launcher starts the sidecar with none of them set.
const MAX_CLIENT_HELLO_BYTES = 16384 + 5;

function clientHelloServerName(buffer) {
  // Returns { complete: false } until a whole first record is buffered, then
  // { complete: true, name } with name null when there is no usable SNI.
  if (buffer.length < 5) return { complete: false };
  const recordLength = buffer.readUInt16BE(3);
  if (buffer[0] !== 0x16 || 5 + recordLength > MAX_CLIENT_HELLO_BYTES) {
    return { complete: true, name: null };
  }
  if (buffer.length < 5 + recordLength) return { complete: false };
  const hello = buffer.subarray(5, 5 + recordLength);
  try {
    if (hello[0] !== 0x01) return { complete: true, name: null };
    let offset = 4 + 2 + 32; // handshake header, client version, random
    offset += 1 + hello[offset]; // session id
    offset += 2 + hello.readUInt16BE(offset); // cipher suites
    offset += 1 + hello[offset]; // compression methods
    if (offset + 2 > hello.length) return { complete: true, name: null };
    const extensionsEnd = offset + 2 + hello.readUInt16BE(offset);
    offset += 2;
    while (offset + 4 <= extensionsEnd && extensionsEnd <= hello.length) {
      const type = hello.readUInt16BE(offset);
      const length = hello.readUInt16BE(offset + 2);
      offset += 4;
      if (type === 0 && length >= 5) {
        const nameType = hello[offset + 2];
        const nameLength = hello.readUInt16BE(offset + 3);
        if (nameType === 0 && offset + 5 + nameLength <= extensionsEnd) {
          return { complete: true, name: hello.toString("ascii", offset + 5, offset + 5 + nameLength).toLowerCase() };
        }
        return { complete: true, name: null };
      }
      offset += length;
    }
    return { complete: true, name: null };
  } catch {
    return { complete: true, name: null };
  }
}

function runEgressProxy() {
  const allowlist = (process.env.EGRESS_ALLOW ?? EGRESS_ALLOW.join(",")).split(",").filter(Boolean);
  const listenPort = Number(process.env.EGRESS_LISTEN_PORT ?? PROXY_PORT);
  const upstreamPort = Number(process.env.EGRESS_UPSTREAM_PORT ?? 443);
  // A record that repeats is written at most REPEAT_LIMIT times; after that
  // the proxy counts it and writes one `… ×N suppressed` line whenever the
  // count reaches REPEAT_LIMIT, and every FLUSH_MS regardless, so a loop of
  // refused CONNECTs cannot grow the log without bound while what is missing
  // from the total is at most the last FLUSH_MS of activity — and nothing at
  // all when the proxy is stopped rather than killed, since SIGTERM flushes
  // before the server closes.
  const repeatLimit = Number(process.env.EGRESS_LOG_REPEAT ?? 1000);
  const flushMs = Number(process.env.EGRESS_LOG_FLUSH_MS ?? 5000);
  const records = new Map();
  const write = (text) => process.stdout.write(`${new Date().toISOString()} ${text}\n`);
  const flush = () => {
    for (const [record, state] of records) {
      if (state.pending === 0) continue;
      write(`${record} ×${state.pending} suppressed`);
      state.pending = 0;
    }
  };
  const log = (...parts) => {
    const record = parts.join(" ");
    const state = records.get(record) ?? { written: 0, pending: 0 };
    records.set(record, state);
    if (state.written < repeatLimit) {
      state.written += 1;
      write(record);
      return;
    }
    state.pending += 1;
    if (state.pending >= repeatLimit) {
      write(`${record} ×${state.pending} suppressed`);
      state.pending = 0;
    }
  };
  setInterval(flush, flushMs).unref();
  // Every client-supplied value in the log — the CONNECT authority, the
  // method, the SNI — is written JSON-quoted and capped at 253 characters,
  // so a name carrying a newline cannot forge a second log line.
  const shown = (value) => JSON.stringify(String(value).slice(0, 253));
  const allowed = (host, port) =>
    port === "443" &&
    allowlist.some((domain) => host === domain || host.endsWith(`.${domain}`));
  const server = http.createServer((request, response) => {
    log("deny", "plain", shown(request.method), shown(request.url));
    response.writeHead(403);
    response.end();
  });
  server.on("connect", (request, socket, head) => {
    const [host, port = "443"] = request.url.split(":");
    if (!allowed(host, port)) {
      log("deny", "connect", shown(request.url));
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    // Admitted by authority; now the client's first record must name the same
    // host before a single byte goes upstream.
    let buffered = Buffer.from(head);
    const deny = (name) => {
      log("deny", "sni-mismatch", shown(request.url), `sni=${shown(name ?? "none")}`);
      socket.destroy();
    };
    const timer = setTimeout(() => deny(null), 15000);
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > MAX_CLIENT_HELLO_BYTES) {
        socket.off("data", onData);
        clearTimeout(timer);
        deny(null);
        return;
      }
      const parsed = clientHelloServerName(buffered);
      if (!parsed.complete) return;
      socket.off("data", onData);
      clearTimeout(timer);
      if (parsed.name !== host.toLowerCase()) {
        deny(parsed.name);
        return;
      }
      log("allow", "connect", shown(request.url));
      const upstream = net.connect(upstreamPort, host, () => {
        upstream.write(buffered);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      upstream.on("error", (error) => {
        log("error", shown(request.url), error.code ?? error.message);
        socket.destroy();
      });
      socket.on("error", () => upstream.destroy());
    };
    socket.on("data", onData);
    socket.on("error", () => clearTimeout(timer));
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (buffered.length > 0) onData(Buffer.alloc(0));
  });
  // Stopped, not killed: flush what is counted and stop accepting. The
  // process then leaves on its own once its sockets are done, and docker's
  // stop timeout is the backstop.
  process.on("SIGTERM", () => {
    flush();
    server.close();
  });
  server.listen(listenPort, "0.0.0.0", () =>
    log("listening", String(listenPort), "allow", allowlist.join(",")),
  );
}

async function exists(target) {
  try {
    await fsp.stat(target);
    return true;
  } catch {
    return false;
  }
}

function codexHome() {
  return process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(os.homedir(), ".codex");
}

// The runtime marketplace the operator registered, read from the one line of
// their config that names it. Anything more elaborate than this would be a
// TOML parser; the block has exactly one `source` key.
async function marketplaceFromCodexConfig() {
  const configPath = path.join(codexHome(), "config.toml");
  let config;
  try {
    config = await fsp.readFile(configPath, "utf8");
  } catch {
    return null;
  }
  const block = config.match(
    new RegExp(
      `^\\[marketplaces\\.${MARKETPLACE_NAME.replace(/[.-]/g, "\\$&")}\\]\\n(?<body>(?:[^[].*\\n?)*)`,
      "m",
    ),
  );
  const source = block?.groups.body.match(/^source\s*=\s*"(?<path>[^"]+)"/m);
  return source ? source.groups.path : null;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  return result;
}

async function resolveInputs(options) {
  if (!options.reviewId || !/^rb-[0-9TZ-]+-[a-f0-9]{8}$/.test(options.reviewId)) {
    fail(`invalid --review-id\n${USAGE}`);
  }
  const { defaultStoreRoot } = await import("../server/core.mjs");
  const store = options.store ?? defaultStoreRoot();
  const ledgerPath = path.join(store, "reviews", options.reviewId, "review.json");
  let ledger;
  try {
    ledger = JSON.parse(await fsp.readFile(ledgerPath, "utf8"));
  } catch (error) {
    fail(`cannot read the review ledger ${ledgerPath}: ${error.message}`);
  }
  if (ledger.reviewer_provider !== "CODEX_TASK") {
    fail(
      `${options.reviewId} is bound to ${ledger.reviewer_provider}, not CODEX_TASK; the container runs the CODEX_TASK reviewer only`,
    );
  }
  if (ledger.advisory !== true) {
    fail(
      `${options.reviewId} is not an advisory review; a review of the operator's own changes takes the host launch in the workflow skill, not this one`,
    );
  }
  if (ledger.status !== "WAITING_FOR_REVIEW") {
    fail(
      `${options.reviewId} is ${ledger.status}, not WAITING_FOR_REVIEW; an advisory review has one round and this one is not waiting for it`,
    );
  }
  const repository = ledger.repository_path;
  if (typeof repository !== "string" || !path.isAbsolute(repository)) {
    fail(`${options.reviewId} records no absolute repository_path`);
  }
  const marketplace = options.marketplace ?? (await marketplaceFromCodexConfig());
  if (!marketplace) {
    fail(
      `no --marketplace given and [marketplaces.${MARKETPLACE_NAME}] names no source in ${path.join(codexHome(), "config.toml")}`,
    );
  }
  const pluginSource = path.join(marketplace, "plugins", PLUGIN_NAME);
  const authJson = path.join(codexHome(), "auth.json");
  const servedOnly = (candidates) => {
    for (const [target, label] of candidates) {
      const prefix = UNSERVED_HOST_PREFIXES.find(
        (p) => target === p.slice(0, -1) || target.startsWith(p),
      );
      if (prefix) {
        fail(
          `${label} ${target} is under ${prefix}: Docker Desktop stops serving files under ${prefix} a few seconds into a container; place the panel worktree and store under your home directory`,
        );
      }
    }
  };
  const hostPaths = [
    [store, "the review store"],
    [repository, "the author checkout the ledger records"],
    [marketplace, "the marketplace"],
    [authJson, "the codex auth.json"],
    [os.tmpdir(), "the scratch directory (TMPDIR)"],
  ];
  servedOnly(hostPaths);
  const required = [
    [store, "the review store"],
    [repository, "the author checkout the ledger records"],
    [authJson, "the operator's codex auth.json"],
    [
      path.join(marketplace, ".agents", "plugins", "marketplace.json"),
      "the marketplace manifest",
    ],
    [
      path.join(pluginSource, ".codex-plugin", "plugin.json"),
      "the packaged plugin manifest",
    ],
    [path.join(pluginSource, "server", "server.mjs"), "the packaged reviewer server"],
  ];
  for (const [target, label] of required) {
    if (!(await exists(target))) {
      fail(`${label} is missing: ${target}`);
    }
  }
  // Every --mount source, the scratch directory included: it is the source
  // of the config, staged-store, and sessions mounts, and a comma there would
  // otherwise be found by docker only after the review had been staged.
  for (const [target, label] of [
    [store, "the review store"],
    [repository, "the author checkout"],
    [marketplace, "the marketplace"],
    [authJson, "the codex auth.json"],
    [os.tmpdir(), "the scratch directory (TMPDIR)"],
  ]) {
    if (target.includes(",")) {
      fail(`${label} ${target} contains a comma, which docker's --mount syntax cannot carry`);
    }
  }
  // The ledger is the authority on which commit is under review: the staged
  // snapshot describes its last round's head_sha, and a panel checkout that
  // has since been switched or reset would put other bytes under the same
  // recorded path. The launcher's clone is detached at the recorded head,
  // and the panel checkout must still be there.
  const lastRound = ledger.rounds?.at(-1);
  const snapshotHead = lastRound?.head_sha;
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(snapshotHead ?? "")) {
    fail(`the review records no snapshot head_sha in its last round`);
  }
  // The clone can materialize only commits. A snapshot prepared over a dirty
  // tree carries overlays the MCP reads would see and the container's shell
  // would not; refused rather than replayed (the panel clone is fresh, so it
  // is clean by construction — this pins the premise).
  if (lastRound.worktree_clean !== true || (lastRound.overlays?.length ?? 0) > 0) {
    fail(
      "the review's snapshot carries worktree overlays; the container review needs a clean commit — prepare it from the panel clone",
    );
  }
  const panelHead = hostGit(["-C", repository, "rev-parse", "HEAD"]);
  if (panelHead.error || panelHead.status !== 0) {
    fail(`cannot read the author checkout's HEAD: ${panelHead.error?.message ?? panelHead.stderr.trim()}`);
  }
  if (panelHead.stdout.trim() !== snapshotHead) {
    fail(`the panel checkout is at ${panelHead.stdout.trim()}, but the review's snapshot head is ${snapshotHead}`);
  }
  // Again on the real paths, so a symlink such as /tmp → /private/tmp cannot
  // slip a refused prefix past the check.
  servedOnly(
    await Promise.all(
      hostPaths.map(async ([target, label]) => [
        await fsp.realpath(target).catch(() => target),
        label,
      ]),
    ),
  );
  const pluginVersion = JSON.parse(
    await fsp.readFile(path.join(pluginSource, ".codex-plugin", "plugin.json"), "utf8"),
  ).version;
  if (typeof pluginVersion !== "string" || pluginVersion === "") {
    fail(`the packaged plugin manifest under ${pluginSource} names no version`);
  }
  return {
    reviewId: options.reviewId,
    store,
    ledgerPath,
    ledger,
    snapshotHead,
    repository,
    marketplace,
    pluginSource,
    pluginVersion,
    authJson,
  };
}

// Every host path the container sees, and nothing else. Read-only unless the
// reviewer must write it, and what it writes is a staged copy of the one
// review, never the host store: under danger-full-access the reviewer's shell
// could otherwise read and rewrite every other ledger, lock, and workflow in
// the store, past the reviewer server's provider check and mutation lock. The
// isolated CODEX_HOME is a Docker volume and the working directory a tmpfs
// rather than host directories: nothing Codex keeps there — SQLite databases
// with write-ahead logs, rollouts, caches — needs to be on the host during
// the run, and a host bind would put that churn on the shared filesystem
// beside the checkout. The sessions are copied out afterwards.
function mountTable(inputs, scratch, volumes) {
  const cache = `${CONTAINER_CODEX_HOME}/plugins/cache/${MARKETPLACE_NAME}/${PLUGIN_NAME}/${inputs.pluginVersion}`;
  return {
    cache,
    checkout: inputs.repository,
    volumes: [
      [volumes.home, CONTAINER_CODEX_HOME],
      [volumes.store, CONTAINER_STORE],
    ],
    mounts: [
      [path.join(scratch, "config.toml"), `${CONTAINER_CODEX_HOME}/config.toml`, "ro"],
      [inputs.authJson, `${CONTAINER_CODEX_HOME}/auth.json`, "ro"],
      [inputs.marketplace, CONTAINER_MARKETPLACE, "ro"],
      [inputs.pluginSource, cache, "ro"],
      [inputs.checkout, inputs.repository, "ro"],
    ],
  };
}

// The mount is not the panel checkout but a clone the launcher makes from it
// over git's own transport: `--no-local` over a file:// URL (built by
// pathToFileURL, since a literal `%20` or `#` in the path would otherwise be
// read as an escape or a fragment) packs only the objects
// reachable from the refs, so whatever a template or a hand left in the
// operator's .git — a hook, a stray file among the objects, a directory named
// like a file, a comment in the configuration — stays on the host (Codex
// round twenty-two on #125: an enumeration of what can hide in a .git does
// not converge). It is mounted at the recorded path, because the reviewer
// server reads the repository by that path, and detached at the review's
// recorded snapshot head, which resolveInputs() has already checked the panel
// checkout is at.
//
// Because of that, the panel checkout's own configuration and .git layout are
// no longer inspected at all. They cannot reach the container, and the one
// path that would still read them — git-upload-pack serving this clone —
// executes nothing from a repository-level configuration: measured on git
// 2.54 (Apple Git-157), `uploadpack.packObjectsHook`,
// `core.alternateRefsCommand`, and `core.fsmonitor` set in the served
// repository all went unused during this very clone, since git honours them
// only from system or global scope. A `.gitattributes` filter in the tree is
// held off by the isolated environment every host git runs in, which has its
// own positive control. If the mount source is ever changed back to the panel
// checkout, that whole layer has to come back with it.
function stageCheckout(inputs) {
  const git = (args) => hostGit(args);
  const message = (result) => result.error?.message ?? result.stderr.trim().replace(/'[^']*'/g, "'<redacted>'");
  const hostHead = inputs.snapshotHead;
  const clone = git(["clone", "--quiet", "--template=", "--no-local", "--no-hardlinks", pathToFileURL(inputs.repository).href, inputs.checkout]);
  if (clone.error || clone.status !== 0) fail(`cannot clone the author checkout for the mount: ${message(clone)}`);
  const detach = git(["-C", inputs.checkout, "checkout", "--quiet", "--detach", hostHead]);
  if (detach.error || detach.status !== 0) fail(`cannot check out ${hostHead} in the launcher's clone: ${message(detach)}`);
  const cloned = git(["-C", inputs.checkout, "rev-parse", "HEAD"]);
  if (cloned.error || cloned.status !== 0 || cloned.stdout.trim() !== hostHead) {
    fail(`the launcher's clone is at ${cloned.stdout?.trim() || "no commit"}, the review's snapshot head is ${hostHead}`);
  }
  return hostHead;
}

// Docker keeps a container's log on the host, and a reviewer that hammers a
// refused host would otherwise write without bound there (`--tail` limits
// only what the launcher reads back). Every container the launcher starts
// gets a bounded json-file log; the sidecar also collapses repeated records.
const LOG_LIMITS = ["--log-driver", "json-file", "--log-opt", "max-size=16m", "--log-opt", "max-file=2"];


const LOCK_ARTIFACTS = new Set([".review-state.lock", ".review-state.lock.guard"]);

// Streamed, not read whole: a staged file is written inside the container and
// a sparse one can claim any size (Codex round thirty-five on #125).
async function sha256File(file) {
  const hash = crypto.createHash("sha256");
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest("hex");
}

// Copy the one review into the scratch store and remember every byte of it,
// so that what comes back can be judged against what went in.
async function stageReview(inputs, stagedStore) {
  const source = path.join(inputs.store, "reviews", inputs.reviewId);
  const staged = path.join(stagedStore, "reviews", inputs.reviewId);
  await fsp.mkdir(path.dirname(staged), { recursive: true, mode: 0o700 });
  await fsp.cp(source, staged, {
    recursive: true,
    filter: (entry) => !LOCK_ARTIFACTS.has(path.basename(entry)),
  });
  const digests = new Map();
  for await (const file of walkFiles(staged)) {
    digests.set(path.relative(staged, file), await sha256File(file));
  }
  return { stagedStore, staged, digests };
}

// What may come back from the container at the file level: review.json
// changed, the server's lock artifacts, and nothing else — no other review,
// no new or edited or deleted file. Each failed check is a named reason.
async function inspectStagedStore(inputs, stage) {
  const reasons = [];
  const reviewPrefix = path.join("reviews", inputs.reviewId) + path.sep;
  const seen = new Set();
  let ledgerChanged = false;
  for await (const file of walkFiles(stage.stagedStore)) {
    const relative = path.relative(stage.stagedStore, file);
    if (!relative.startsWith(reviewPrefix)) {
      reasons.push(`unexpected file outside the staged review: ${relative}`);
      continue;
    }
    const inner = path.relative(stage.staged, file);
    if (LOCK_ARTIFACTS.has(inner)) continue;
    seen.add(inner);
    // Sized before it is read: the container wrote it, and nothing the host
    // reads whole may be larger than one review's files ever are.
    const { size } = await fsp.stat(file);
    if (size > STAGED_FILE_LIMIT_MB * 1024 * 1024) {
      reasons.push(`the staged file ${inner} is ${(size / (1024 * 1024)).toFixed(1)} MB, over the ${STAGED_FILE_LIMIT_MB} MB bound for one file`);
      continue;
    }
    const digest = await sha256File(file);
    if (inner === "review.json") {
      ledgerChanged = digest !== stage.digests.get(inner);
    } else if (!stage.digests.has(inner)) {
      reasons.push(`an unexpected file was created in the staged review: ${inner}`);
    } else if (digest !== stage.digests.get(inner)) {
      reasons.push(`an existing snapshot file was modified: ${inner}`);
    }
  }
  for (const known of stage.digests.keys()) {
    if (!seen.has(known)) reasons.push(`a staged file was deleted: ${known}`);
  }
  return { reasons, ledgerChanged };
}

// The staged bytes are never trusted and never copied. The one mutation an
// advisory review admits is submit_review, so the staged ledger's findings
// are taken as that call's payload and replayed through the server's own
// submitInitialReview against a copy of the host ledger, under the host
// review's state lock; the host keeps the replay's result only when it equals
// the staged ledger field for field, timestamps aside. A staged ledger the
// replay cannot produce — a status the payload does not reach, a snapshot
// hash or a history the host never wrote — is refused.
const TIMESTAMP_FIELDS = new Set(["updated_at"]);

function comparableLedger(ledger) {
  const copy = JSON.parse(JSON.stringify(ledger));
  for (const field of TIMESTAMP_FIELDS) delete copy[field];
  if (Array.isArray(copy.history)) {
    copy.history = copy.history.map(({ at, ...event }) => event);
  }
  return copy;
}

function submitPayload(staged) {
  if (!Array.isArray(staged.findings)) {
    throw new Error("the staged ledger carries no findings array to replay");
  }
  return staged.findings.map((finding) => {
    const payload = {
      severity: finding?.severity,
      title: finding?.title,
      explanation: finding?.explanation,
      recommendation: finding?.recommendation,
    };
    if (finding?.path != null) payload.path = finding.path;
    if (finding?.line != null) payload.line = finding.line;
    return payload;
  });
}

async function replayAndCopyBack(inputs, stage, before, scratch, api) {
  const { loadReview, submitInitialReview, withStateLock, atomicWriteFile, canonicalJson } = api;
  const hostDirectory = path.join(inputs.store, "reviews", inputs.reviewId);
  const replayStore = path.join(scratch, "replay");
  const replayDirectory = path.join(replayStore, "reviews", inputs.reviewId);
  return withStateLock(
    { directory: hostDirectory, reviewId: inputs.reviewId, domain: "review" },
    async () => {
      const host = await loadReview(inputs.store, inputs.reviewId);
      if (host.state_version !== before.stateVersion) {
        throw new Error(
          `the host ledger advanced to state_version ${host.state_version} during the run`,
        );
      }
      const staged = await loadReview(stage.stagedStore, inputs.reviewId);
      await fsp.rm(replayStore, { recursive: true, force: true });
      await fsp.mkdir(path.dirname(replayDirectory), { recursive: true, mode: 0o700 });
      await fsp.cp(hostDirectory, replayDirectory, {
        recursive: true,
        filter: (entry) => !LOCK_ARTIFACTS.has(path.basename(entry)),
      });
      await submitInitialReview(replayStore, inputs.reviewId, submitPayload(staged), "CODEX_TASK");
      const replayed = await loadReview(replayStore, inputs.reviewId);
      const expected = comparableLedger(replayed);
      const actual = comparableLedger(staged);
      if (canonicalJson(expected) !== canonicalJson(actual)) {
        const differing = [...new Set([...Object.keys(expected), ...Object.keys(actual)])]
          .filter((key) => canonicalJson(expected[key] ?? null) !== canonicalJson(actual[key] ?? null))
          .sort();
        throw new Error(
          `the staged ledger does not match the host's own replay of its submit_review payload (differs in: ${differing.join(", ")})`,
        );
      }
      await atomicWriteFile(
        path.join(hostDirectory, "review.json"),
        await fsp.readFile(path.join(replayDirectory, "review.json")),
      );
      return replayed;
    },
  );
}

// Bind mounts are given in the `--mount` form, not `-v`. On Docker Desktop
// 28.3.2 a `-v src:dst:ro` whose destination equals its source — the author
// checkout at its recorded path — is present when the container starts and
// missing moments later (git reads first succeeded, then failed with
// `Permission denied`, then `No such file or directory`; measured
// 2026-09-10), while the same mount through `--mount` stays put. Every mount
// takes the form that holds.
function bindMount([source, target, mode]) {
  return `type=bind,src=${source},dst=${target}${mode === "ro" ? ",readonly" : ""}`;
}

function containerArgs({ mounts, volumes, checkout }, network, extra = [], { withoutCheckout = false, limits = HELPER_LIMITS } = {}) {
  const args = [
    "run",
    "--rm",
    ...LOG_LIMITS,
    ...limits,
    "--network",
    network,
    "-w",
    CONTAINER_WORK,
  ];
  for (const [source, target] of volumes) args.push("--mount", `type=volume,src=${source},dst=${target}`);
  // `--internal` cuts routing, not name resolution: Docker's embedded server
  // would forward an outside query to the host's resolver, and a name is
  // enough to carry a secret out (`<encoded>.attacker.example`). Pointing the
  // upstream at the container's own loopback, where nothing listens, leaves
  // the embedded server able to resolve the sidecar's network alias and
  // nothing else (Codex round thirty-five on #125). The sidecar itself keeps
  // a real resolver: it has the allowlisted hosts to look up.
  args.push("--dns", "127.0.0.1");
  args.push("--tmpfs", `${CONTAINER_WORK}:rw,mode=1777`);
  for (const mount of mounts) {
    if (withoutCheckout && mount[1] === checkout) continue;
    args.push("--mount", bindMount(mount));
  }
  args.push("-e", `CODEX_HOME=${CONTAINER_CODEX_HOME}`);
  for (const [name, value] of Object.entries(PROXY_ENV)) args.push("-e", `${name}=${value}`);
  args.push(...extra);
  return args;
}

const REVIEWER_REQUEST = (reviewId) =>
  `Independently review Review Bridge task \`${reviewId}\` using the packaged Review Bridge reviewer skill. Require \`reviewer_provider: CODEX_TASK\`, follow the review strategy, and submit every actionable finding.`;

// The launch inside the container. The same shape as the workflow skill's
// host launch minus the workspace-write pins, which the container makes
// moot, plus the reviewer server restated at its container path with the
// store's container path in its environment — a lone `env` key would turn the
// plugin's entry into a transport-less definition the config refuses to load.
function codexArgs(inputs, cache) {
  return [
    "codex",
    "exec",
    "--skip-git-repo-check",
    "--sandbox",
    "danger-full-access",
    "-c",
    'approvals_reviewer="guardian_subagent"',
    "-c",
    "approval_policy={granular={rules=false,sandbox_approval=false,skill_approval=false,request_permissions=false,mcp_elicitations=false}}",
    "-c",
    "memories.use_memories=false",
    "-c",
    "memories.generate_memories=false",
    "-c",
    `mcp_servers.${AUTHOR_SERVER}.command="node"`,
    "-c",
    `mcp_servers.${AUTHOR_SERVER}.enabled=false`,
    "-c",
    `mcp_servers.${REVIEWER_SERVER}.command="node"`,
    "-c",
    `mcp_servers.${REVIEWER_SERVER}.args=${JSON.stringify([
      `${cache}/server/server.mjs`,
      "--role",
      "reviewer",
      "--reviewer-provider",
      "CODEX_TASK",
    ])}`,
    "-c",
    `mcp_servers.${REVIEWER_SERVER}.cwd="${cache}"`,
    "-c",
    `mcp_servers.${REVIEWER_SERVER}.env.REVIEW_BRIDGE_HOME="${CONTAINER_STORE}"`,
    REVIEWER_REQUEST(inputs.reviewId),
  ];
}

// Paths that must be absent inside the container: the host home's sensitive
// contents — credential directories, the codex home, the macOS Library, the
// store — plus the macOS roots a host home and volumes live under. The home
// directory itself is not probed: `/home` and `/root` are directories of the
// Debian base image (with its own dotfiles under `/root`), so a host home at
// `/root` would read as present, and what the boundary is about is the
// contents anyway. An ancestor of the mounted checkout is present by
// construction, so for those the check is that they hold nothing but the way
// down to the mount — except the home directory itself, again because the
// image's own dotfiles may sit beside the mount there.
function hostPathProbe(inputs) {
  const home = os.homedir();
  const ancestors = [];
  for (let dir = path.dirname(inputs.repository); ; dir = path.dirname(dir)) {
    if (dir === path.dirname(dir)) break;
    if (dir !== home) ancestors.unshift(dir);
  }
  const absent = [
    path.join(home, ".ssh"),
    path.join(home, ".codex"),
    inputs.authJson,
    path.join(home, "Library"),
    path.join(home, ".gnupg"),
    path.join(home, ".aws"),
    "/root/.ssh",
    "/Users",
    "/Volumes",
    inputs.store,
  ].filter((candidate) => candidate !== home && !ancestors.includes(candidate));
  return { absent: [...new Set(absent)], ancestors };
}

// The probe is a node program handed its paths as one JSON argument and
// answering in JSON lines, so a path with a space in it is one path on both
// sides. It runs in the same image with the same mounts as the reviewer.
const PROBE_PROGRAM = `
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const spec = JSON.parse(process.argv[1]);
const emit = (record) => process.stdout.write(JSON.stringify(record) + "\\n");
for (const target of spec.absent) emit({ kind: "path", path: target, present: fs.existsSync(target) });
for (const target of spec.ancestors) {
  let children = null;
  try { children = fs.readdirSync(target); } catch {}
  emit({ kind: "ancestor", path: target, children });
}
if (spec.mode !== "baseline") {
const head = spawnSync("git", ["-C", spec.checkout, "rev-parse", "HEAD"], { encoding: "utf8" });
emit({ kind: "checkout-head", value: ((head.stdout || "") + (head.stderr || "")).trim() });
let writable = false;
try {
  const probe = path.join(spec.store, ".advisory-sandbox-probe");
  fs.writeFileSync(probe, "");
  fs.unlinkSync(probe);
  writable = true;
} catch {}
emit({ kind: "store-writable", value: writable });
const curl = (env) => {
  const result = spawnSync("curl", ["-sS", "-m", "15", "-o", "/dev/null", "-w", "%{http_code}", "https://example.com"], { encoding: "utf8", env });
  return { code: (result.stdout || "").trim(), exit: result.status };
};
emit({ kind: "egress", via: "proxy", ...curl(process.env) });
const direct = { ...process.env };
for (const name of ${JSON.stringify(Object.keys(PROXY_ENV))}) direct[name] = "";
emit({ kind: "egress", via: "direct", ...curl(direct) });
const dns = require("node:dns").promises;
const resolves = async (name) => { try { await dns.lookup(name); return true; } catch { return false; } };
emit({ kind: "codex-version", value: (spawnSync("codex", ["--version"], { encoding: "utf8" }).stdout || "").trim() });
emit({ kind: "uid", value: process.getuid() });
// A name is a channel of its own, so the outside must not resolve at all —
// with the sidecar's alias in the same probe as the positive control, so a
// resolver that answers nothing at all cannot pass for a boundary.
resolves("${PROXY_ALIAS}").then(async (alias) => {
  emit({ kind: "dns", name: "${PROXY_ALIAS}", resolved: alias });
  emit({ kind: "dns", name: "example.com", resolved: await resolves("example.com") });
});
}
`;

// mode "baseline" runs in a container without the checkout mount and answers
// only the path and ancestor records; mode "mounted" runs with it and answers
// everything. The boundary is judged on the difference between the two.
function probeArgs(inputs, mode) {
  const { absent, ancestors } = hostPathProbe(inputs);
  return [
    "node",
    "-e",
    PROBE_PROGRAM,
    JSON.stringify({ mode, absent, ancestors, checkout: inputs.repository, store: CONTAINER_STORE }),
  ];
}

function parseProbeRecords(output) {
  const records = [];
  for (const line of output.split("\n")) {
    try {
      records.push(JSON.parse(line));
    } catch {
      // not a record
    }
  }
  return records;
}

// The image has directories of its own — /root with its dotfiles, /usr with
// everything under it — so neither "absent" nor "holds exactly one entry" can
// be judged from the mounted container alone. The baseline container, same
// image and no checkout mount, says what the image contributes; a sensitive
// path is a leak when the baseline lacks it and the mounted container has
// it, and an ancestor is clean when the mount added exactly the one name
// that leads down to the checkout and removed nothing.
function evaluateBoundary(baselineOutput, mountedOutput, inputs) {
  const { ancestors } = hostPathProbe(inputs);
  const hostHead = inputs.snapshotHead;
  // The one name an ancestor may gain: the checkout's next path segment below
  // it (not the next probed ancestor, which skips the home directory).
  const wayDown = (ancestor) => path.relative(ancestor, inputs.repository).split(path.sep)[0];
  const baseline = { paths: new Map(), ancestors: new Map() };
  for (const record of parseProbeRecords(baselineOutput)) {
    if (record.kind === "path") baseline.paths.set(record.path, record.present);
    else if (record.kind === "ancestor") baseline.ancestors.set(record.path, record.children);
  }
  const failures = [];
  const facts = { absent: [], present: [], children: [], egressProxied: null, egressDirect: null, dns: [] };
  if (baseline.paths.size + baseline.ancestors.size === 0) {
    failures.push("the baseline probe produced no records");
  }
  for (const record of parseProbeRecords(mountedOutput)) {
    if (record.kind === "path") {
      const inImage = baseline.paths.get(record.path) === true;
      if (!record.present) facts.absent.push(record.path);
      else if (inImage) facts.present.push(`${record.path} (in the image)`);
      else {
        facts.present.push(record.path);
        failures.push(`host path present inside the container: ${record.path}`);
      }
    } else if (record.kind === "ancestor") {
      const before = new Set(baseline.ancestors.get(record.path) ?? []);
      const after = new Set(record.children ?? []);
      const added = [...after].filter((name) => !before.has(name)).sort();
      const removed = [...before].filter((name) => !after.has(name)).sort();
      const expected = wayDown(record.path);
      facts.children.push(`${record.path}: +${added.join(",") || "∅"}${removed.length ? ` −${removed.join(",")}` : ""} over ${before.size} in the image`);
      // The mount may add the way-down name, or nothing when the image has
      // that name already (/usr/src); it may add nothing else and remove
      // nothing, and the way down must be there afterwards.
      const clean =
        ancestors.includes(record.path) &&
        removed.length === 0 &&
        added.every((name) => name === expected) &&
        after.has(expected);
      if (!clean) {
        failures.push(
          `${record.path} changed by more than the way down to the checkout: added ${added.join(", ") || "nothing"}${removed.length ? `, removed ${removed.join(", ")}` : ""}, expected only ${expected}${after.has(expected) ? "" : " (which is missing)"}`,
        );
      }
    } else if (record.kind === "egress") {
      const summary = `${record.code} curl-exit=${record.exit}`;
      if (record.via === "proxy") {
        // Through the proxy the expected answer is its refusal; only a
        // success status means the allowlist let the host through.
        facts.egressProxied = summary;
        if (/^[23]\d\d$/.test(record.code)) {
          failures.push(`the proxy let https://example.com through (${summary})`);
        }
      } else {
        // Without the proxy any HTTP status at all — 403 and 5xx included —
        // means traffic left the container; only a connection-level failure
        // (no status, nonzero curl exit) is the boundary holding.
        facts.egressDirect = summary;
        if (record.code !== "000" || record.exit === 0) {
          failures.push(
            `the container reached https://example.com without the proxy (HTTP ${record.code}, curl exit ${record.exit})`,
          );
        }
      }
    } else if (record.kind === "checkout-head") {
      facts.checkoutHead = record.value;
      // 40 hex for sha1, 64 for sha256 (extensions.objectformat is admitted),
      // and the commit the review's last round recorded.
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(record.value)) {
        failures.push(`git cannot read the mounted checkout: ${record.value}`);
      } else if (record.value !== hostHead) {
        failures.push(`the mounted checkout's HEAD is ${record.value}, the review's snapshot head is ${hostHead}`);
      }
    } else if (record.kind === "dns") {
      facts.dns.push(`${record.name} ${record.resolved ? "resolves" : "does not resolve"}`);
      if (record.name === PROXY_ALIAS && !record.resolved) {
        failures.push(`the sidecar's name ${PROXY_ALIAS} does not resolve inside the container, so the probe proves nothing about the outside`);
      }
      if (record.name !== PROXY_ALIAS && record.resolved) {
        failures.push(`the container resolved ${record.name}, so a name can carry data out`);
      }
    } else if (record.kind === "store-writable") {
      facts.storeWritable = record.value;
      if (record.value !== true) failures.push("the staged store mount is not writable");
    } else if (record.kind === "codex-version") facts.codexVersion = record.value;
    else if (record.kind === "uid") facts.uid = String(record.value);
  }
  if (facts.absent.length + facts.present.length === 0) failures.push("the boundary probe produced no records");
  return { facts, failures };
}

function parseMcpLines(transcript) {
  const calls = new Map();
  for (const match of transcript.matchAll(
    /^mcp: ([^/\s]+)\/(\S+) (started|\(completed\)|\(failed.*)$/gm,
  )) {
    const key = `${match[1]}/${match[2]}`;
    const entry = calls.get(key) ?? { started: 0, completed: 0, failed: 0 };
    if (match[3] === "started") entry.started += 1;
    else if (match[3] === "(completed)") entry.completed += 1;
    else entry.failed += 1;
    calls.set(key, entry);
  }
  return calls;
}

async function* walkFiles(directory) {
  let entries;
  try {
    entries = await fsp.readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walkFiles(full);
    else if (entry.isFile()) yield full;
  }
}

// The guardian's own rollouts under the isolated CODEX_HOME: one thread per
// codex session, one turn per approval, the verdict as the turn's agent
// message and the tool it judged in the approval request that opened it.
// A rollout is read a line at a time and never if it is larger than a review
// writes: the container wrote it, so its size is the reviewer's to choose
// (Codex round thirty-six on #125). `problems` collects what was refused.
async function* rolloutLines(file, problems) {
  const { size } = await fsp.stat(file);
  if (size > ROLLOUT_LIMIT_MB * 1024 * 1024) {
    problems.push(`rollout ${path.basename(file)} is ${(size / (1024 * 1024)).toFixed(1)} MB, over the ${ROLLOUT_LIMIT_MB} MB bound`);
    return;
  }
  const input = fs.createReadStream(file, { encoding: "utf8" });
  try {
    for await (const line of readline.createInterface({ input, crlfDelay: Infinity })) yield line;
  } finally {
    input.destroy();
  }
}

async function guardianVerdicts(sessionsRoot, problems) {
  const verdicts = [];
  for await (const file of walkFiles(sessionsRoot)) {
    if (!file.endsWith(".jsonl")) continue;
    // Whether this is a guardian rollout shows in its lines, so the turns are
    // collected as they stream and kept only if the marker appeared.
    const collected = [];
    let isGuardian = false;
    let turn = null;
    for await (const line of rolloutLines(file, problems)) {
      if (!line) continue;
      if (line.includes('"thread_source":"guardian_review"')) isGuardian = true;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const payload = event.payload ?? {};
      if (event.type !== "event_msg") continue;
      if (payload.type === "task_started") {
        turn = { tool: null, startedAt: event.timestamp, outcome: null };
      } else if (payload.type === "user_message" && turn) {
        const tool = String(payload.message ?? "").match(/"tool_name":\s*"([^"]+)"/);
        if (tool) turn.tool = tool[1];
      } else if (payload.type === "agent_message" && turn) {
        try {
          const verdict = JSON.parse(payload.message);
          Object.assign(turn, {
            outcome: verdict.outcome ?? null,
            risk: verdict.risk_level ?? null,
            authorization: verdict.user_authorization ?? null,
          });
        } catch {
          turn.outcome = turn.outcome ?? "unparsed";
        }
      } else if (payload.type === "task_complete" && turn) {
        turn.seconds = (Date.parse(event.timestamp) - Date.parse(turn.startedAt)) / 1000;
        collected.push(turn);
        turn = null;
      } else if (payload.type === "turn_aborted" && turn) {
        turn.outcome = `aborted (${payload.reason ?? "unknown"})`;
        turn.seconds = (Date.parse(event.timestamp) - Date.parse(turn.startedAt)) / 1000;
        collected.push(turn);
        turn = null;
      }
    }
    if (isGuardian) verdicts.push(...collected);
  }
  return verdicts;
}

// Criterion 1 is derived from the main rollout alone: the one whose
// session_meta id is the session id codex printed in its header, never a
// subagent's. Each MCP call is its own `McpToolCall` item there, with the
// server's result when there was one, so the criterion is a property of
// every record, not a count: every reviewer call completed or was answered
// with an error by the server (a path that is not in the snapshot, say). A
// call with a transport error, or with no result, fails it. The transcript's
// `mcp:` lines are kept only as a cross-check: a started count that differs
// from the record count is a mismatch and fails it too.
async function mainRolloutRecords(sessionsRoot, sessionId, problems) {
  for await (const file of walkFiles(sessionsRoot)) {
    if (!file.endsWith(".jsonl")) continue;
    let records = null;
    for await (const line of rolloutLines(file, problems)) {
      if (records === null) {
        // The first line names the session; anything else is another rollout.
        let meta;
        try {
          meta = JSON.parse(line);
        } catch {
          break;
        }
        if (meta?.type !== "session_meta" || meta.payload?.id !== sessionId) break;
        records = [];
        continue;
      }
      if (!line.includes('"McpToolCall"')) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const item = event.payload?.item;
      if (event.payload?.type !== "item_completed" || item?.type !== "McpToolCall") continue;
      if (item.server !== REVIEWER_SERVER) continue;
      const completed = item.status === "completed";
      const answered = !completed && item.result != null && item.error == null;
      let message = null;
      if (answered) {
        const resultText = item.result?.content?.map((part) => part?.text ?? "").join(" ") ?? "";
        const match = resultText.match(/"error":"((?:[^"\\]|\\.){0,200})/);
        message = match ? match[1] : resultText.slice(0, 200);
      }
      records.push({ id: item.id, tool: item.tool, completed, answered, message });
    }
    if (records !== null) return records;
  }
  return null;
}

// `startedLines` is null when the transcript was truncated: it can then only
// undercount, so the cross-check is skipped rather than failed by a bound of
// our own. What that loses is one detection — a call with a transcript line
// and no rollout record — and the loss sits inside what this criterion
// already declares: it is run-health evidence recorded inside the container,
// forgeable by a reviewer with a shell, and the copy-back's integrity rests
// on the host replay. Every record's own property (completed, answered,
// unexplained) is judged either way, which is the substance of criterion 1.
function judgeMcpCalls(records, startedLines) {
  const reasons = [];
  if (records == null) reasons.push("no main rollout found under the isolated CODEX_HOME");
  const list = records ?? [];
  if (records != null && list.length === 0) reasons.push("no reviewer MCP call recorded in the main rollout");
  const unexplained = list.filter((record) => !record.completed && !record.answered);
  if (unexplained.length > 0) {
    reasons.push(`${unexplained.length} call(s) failed without a server answer: ${unexplained.map((record) => record.tool).join(", ")}`);
  }
  if (records != null && startedLines !== null && startedLines !== list.length) {
    reasons.push(`transcript/rollout mismatch: ${startedLines} started line(s) in the transcript, ${list.length} record(s) in the main rollout`);
  }
  const perTool = new Map();
  for (const record of list) {
    const entry = perTool.get(record.tool) ?? { total: 0, completed: 0 };
    entry.total += 1;
    if (record.completed) entry.completed += 1;
    perTool.set(record.tool, entry);
  }
  const answered = list.filter((record) => record.answered);
  const detail =
    [...perTool.entries()].map(([tool, entry]) => `${tool} ${entry.completed}/${entry.total}`).join(", ") +
    (answered.length
      ? `; ${answered.length} failed call(s) answered by the server with an error (${answered.slice(0, 3).map((record) => `${record.tool}: "${record.message}"`).join(", ")}${answered.length > 3 ? ", …" : ""})`
      : "") +
    (reasons.length ? `; ${reasons.join("; ")}` : "");
  return { ok: reasons.length === 0, reasons, detail: detail || reasons.join("; ") };
}

// Counts every record the log holds, a `… ×N suppressed` line counting as the
// N records the sidecar collapsed into it.
function summarizeProxyLog(log) {
  const counts = new Map();
  for (const match of log.matchAll(/^\S+ ((?:allow|deny|error) .+)$/gm)) {
    const suppressed = /^(.*) ×(\d+) suppressed$/.exec(match[1].trim());
    const key = suppressed ? suppressed[1] : match[1].trim();
    counts.set(key, (counts.get(key) ?? 0) + (suppressed ? Number(suppressed[2]) : 1));
  }
  return [...counts.entries()]
    .sort()
    .map(([key, count]) => `${key} ×${count}`)
    .join(", ");
}

async function ledgerFacts(ledgerPath) {
  const [ledger, info] = await Promise.all([
    fsp.readFile(ledgerPath, "utf8").then(JSON.parse),
    fsp.stat(ledgerPath),
  ]);
  return {
    status: ledger.status,
    stateVersion: ledger.state_version,
    updatedAt: ledger.updated_at,
    findings: Array.isArray(ledger.findings) ? ledger.findings.length : 0,
    mtime: info.mtime.toISOString(),
  };
}

function ensureDocker() {
  let result;
  try {
    result = run("docker", ["version", "--format", "{{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}"]);
  } catch (error) {
    fail(`Docker is not available (${error.message}); the advisory member has no other launch`);
  }
  if (result.status !== 0) {
    fail(
      `Docker is not available: ${(result.stderr || result.stdout).trim()}; the advisory member has no other launch`,
    );
  }
  const [, platform] = result.stdout.trim().split(" ");
  if (!platform.startsWith("linux/")) {
    fail(`Docker reports ${platform}; the read boundary needs a Linux container`);
  }
  return result.stdout.trim();
}

function ensureImage() {
  if (run("docker", ["image", "inspect", IMAGE], { stdio: "ignore" }).status === 0) {
    return "reused";
  }
  process.stdout.write(`building ${IMAGE} from ${BASE_IMAGE}\n`);
  const result = spawnSync("docker", ["build", "-t", IMAGE, "-"], {
    input: DOCKERFILE,
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (result.status !== 0) fail(`docker build of ${IMAGE} failed`, 1);
  return "built";
}

function printCommand(prefix, args) {
  process.stdout.write(`${prefix} ${args.map(shellQuote).join(" ")}\n`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (options.egressProxy) {
    runEgressProxy();
    return;
  }
  const inputs = await resolveInputs(options);
  const runId = crypto.randomBytes(4).toString("hex");
  const scratch = options.dryRun
    ? path.join(os.tmpdir(), `review-bridge-advisory-${inputs.reviewId}-<run>`)
    : await fsp.mkdtemp(path.join(os.tmpdir(), `review-bridge-advisory-${inputs.reviewId}-`));
  const network = `review-bridge-advisory-${runId}`;
  const proxyName = `${network}-egress`;
  const codexName = `${network}-codex`;
  const homeVolume = `${network}-home`;
  const storeVolume = `${network}-store`;
  const stagedStore = path.join(scratch, "store");
  inputs.checkout = path.join(scratch, "checkout");
  const table = mountTable(inputs, scratch, { home: homeVolume, store: storeVolume });
  const { cache } = table;
  const uid = typeof process.getuid === "function" ? `${process.getuid()}:${process.getgid()}` : null;
  const user = uid ? ["--user", uid, "-e", `HOME=${CONTAINER_WORK}`] : [];
  const configToml = [
    'model_reasoning_effort = "high"',
    `[plugins."${PLUGIN_NAME}@${MARKETPLACE_NAME}"]`,
    "enabled = true",
    `[marketplaces.${MARKETPLACE_NAME}]`,
    'source_type = "local"',
    `source = "${CONTAINER_MARKETPLACE}"`,
    "",
  ].join("\n");

  // Both volumes are tmpfs-backed local volumes, so the bound holds while the
  // reviewer runs rather than being discovered afterwards: a write past it
  // fails with ENOSPC inside the container, and the criteria then fail on
  // their own. A tmpfs volume lives only while some container mounts it, so a
  // keeper container holds both for the run — without it the copy in would be
  // gone before the reviewer started (measured 2026-09-11).
  const volumeCreate = (name, size) => [
    "volume",
    "create",
    "--driver",
    "local",
    "--opt",
    "type=tmpfs",
    "--opt",
    "device=tmpfs",
    "--opt",
    `o=size=${size},mode=0700${uid ? `,uid=${process.getuid()},gid=${process.getgid()}` : ""}`,
    name,
  ];
  const homeVolumeCreate = volumeCreate(homeVolume, CODEX_HOME_LIMIT);
  const storeVolumeCreate = volumeCreate(storeVolume, `${STAGED_STORE_LIMIT_MB}m`);
  const keeperName = `${network}-keeper`;
  const keeperRun = [
    "run",
    "-d",
    ...LOG_LIMITS,
    ...HELPER_LIMITS,
    "--name",
    keeperName,
    "--network",
    "none",
    "--mount",
    `type=volume,src=${homeVolume},dst=${CONTAINER_CODEX_HOME}`,
    "--mount",
    `type=volume,src=${storeVolume},dst=${CONTAINER_STORE}`,
    IMAGE,
    "sleep",
    "infinity",
  ];
  const networkCreate = ["network", "create", "--internal", network];
  const proxyRun = [
    "run",
    "-d",
    ...LOG_LIMITS,
    ...HELPER_LIMITS,
    "--name",
    proxyName,
    "--network",
    network,
    "--network-alias",
    PROXY_ALIAS,
    "--mount",
    bindMount([path.dirname(scriptPath), CONTAINER_LAUNCHER, "ro"]),
    IMAGE,
    "node",
    `${CONTAINER_LAUNCHER}/${path.basename(scriptPath)}`,
    "--egress-proxy",
  ];
  const proxyConnect = ["network", "connect", "bridge", proxyName];
  // The staged store travels in a volume: copied in before the run, measured
  // and copied out after it, never a host directory the reviewer can write
  // into without bound.
  const storeHelper = (mode, command) => [
    "run",
    "--rm",
    ...LOG_LIMITS,
    ...HELPER_LIMITS,
    "--network",
    "none",
    "--mount",
    `type=volume,src=${storeVolume},dst=${CONTAINER_STORE}${mode === "ro" ? ",readonly" : ""}`,
    ...(mode === "ro" ? [] : ["--mount", bindMount([scratch, "/in", "ro"])]),
    ...(mode === "ro" ? ["--mount", bindMount([scratch, "/out", "rw"])] : []),
    IMAGE,
    "sh",
    "-c",
    command,
  ];
  const storeImport = storeHelper("rw", `cp -a /in/store/. ${CONTAINER_STORE}/ && chown -R ${uid ?? "0:0"} ${CONTAINER_STORE}`);
  // Apparent size, not blocks: a sparse file allocates nothing and would
  // otherwise pass the bound and then be read whole on the host. The largest
  // single file is measured with it, since one file at the bound is as bad as
  // the whole store.
  const storeSize = storeHelper(
    "ro",
    `echo "$(du -sk --apparent-size ${CONTAINER_STORE} | cut -f1) $(find ${CONTAINER_STORE} -type f -printf '%s\n' | sort -n | tail -1)"`,
  );
  const storeExport = storeHelper("ro", `rm -rf /out/store && cp -a ${CONTAINER_STORE} /out/store && chown -R ${uid ?? "0:0"} /out/store`);
  const sessionsExport = [
    "run",
    "--rm",
    ...LOG_LIMITS,
    ...HELPER_LIMITS,
    "--network",
    "none",
    "--mount",
    `type=volume,src=${homeVolume},dst=${CONTAINER_CODEX_HOME},readonly`,
    "--mount",
    bindMount([scratch, "/out", "rw"]),
    IMAGE,
    "sh",
    "-c",
    // Only one outcome is not a failure: no sessions directory at all (the
    // reviewer never started). Otherwise the copy's and the chown's exit
    // codes are the step's, and a failed export keeps the volume.
    `if [ ! -d ${CONTAINER_CODEX_HOME}/sessions ]; then echo no-sessions-recorded; exit 0; fi; cp -a ${CONTAINER_CODEX_HOME}/sessions /out/sessions && chown -R ${uid ?? "0:0"} /out/sessions`,
  ];
  const baselineRun = [
    ...containerArgs(table, network, user, { withoutCheckout: true }),
    IMAGE,
    ...probeArgs(inputs, "baseline"),
  ];
  const boundaryRun = [...containerArgs(table, network, user), IMAGE, ...probeArgs(inputs, "mounted")];
  const codexRun = [
    ...containerArgs(table, network, [...user, "--name", codexName], { limits: codexLimits(options.memory, options.cpus) }),
    IMAGE,
    ...codexArgs(inputs, cache),
  ];

  process.stdout.write(
    [
      `review ${inputs.reviewId} (${inputs.ledger.status}, state_version ${inputs.ledger.state_version})`,
      `store ${inputs.store} (never mounted; the review is staged in the Docker volume ${storeVolume}, bounded at ${STAGED_STORE_LIMIT_MB} MB, and copied out to ${stagedStore})`,
      `checkout ${inputs.repository} (read-only, at its recorded path; the bytes are a fresh clone the launcher makes at ${inputs.checkout}, detached at the review's snapshot head ${inputs.snapshotHead})`,
      `marketplace ${inputs.marketplace} (plugin ${inputs.pluginVersion}, read-only)`,
      `auth ${inputs.authJson} (read-only bind mount)`,
      `scratch ${scratch}`,
      "",
    ].join("\n"),
  );

  if (options.dryRun) {
    process.stdout.write(
      `dry run: nothing below is executed\n${CONTAINER_CODEX_HOME}/config.toml:\n${configToml.trimEnd().replace(/^/gm, "  ")}\n`,
    );
    printCommand("docker", homeVolumeCreate);
    printCommand("docker", storeVolumeCreate);
    printCommand("docker", keeperRun);
    printCommand("docker", networkCreate);
    printCommand("docker", proxyRun);
    printCommand("docker", proxyConnect);
    printCommand("docker", storeImport);
    printCommand("docker", baselineRun);
    printCommand("docker", boundaryRun);
    printCommand("docker", codexRun);
    process.stdout.write("  (codex stdin is closed: the container is started with stdin ignored)\n");
    printCommand("docker", storeSize);
    printCommand("docker", storeExport);
    printCommand("docker", sessionsExport);
    process.stdout.write(`docker rm -f ${keeperName}\ndocker volume rm ${homeVolume}\ndocker volume rm ${storeVolume}\n`);
    return;
  }

  const dockerVersion = ensureDocker();
  const imageState = ensureImage();
  await fsp.writeFile(path.join(scratch, "config.toml"), configToml);
  const transcriptPath = path.join(scratch, "codex.log");
  const before = await ledgerFacts(inputs.ledgerPath);
  const stage = await stageReview(inputs, stagedStore);
  stageCheckout(inputs);
  const { loadReview, submitInitialReview } = await import("../server/core.mjs");
  const { withStateLock, atomicWriteFile, canonicalJson } = await import("../server/storage.mjs");

  // Every cleanup step runs on its own: a failure is recorded for the report
  // and the next step still runs, so a proxy, network, or volume is never left
  // behind and the sessions are always exported because an earlier step
  // failed. The proxy log is bounded (last 200000 lines, 64 MB) and its
  // failure is a note on the egress line, not a stop.
  const PROXY_LOG_LINES = 200000;
  let proxyLog = "";
  let proxyLogNote = null;
  const cleanupFailures = [];
  let sessionsNote = null;
  let sessionsKept = null;
  let storeKept = null;
  let storeWithinBound = false;
  let keeperStarted = false;
  let transcriptBytes = 0;
  let transcriptDropped = 0;
  let transcriptNote = null;
  // A consumer that reads a line and leaves (`| head`) makes every later write
  // raise EPIPE, and an unhandled one of those kills the process outside the
  // promise and the finally — with the containers, the proxy, the keeper, the
  // network, and the volumes all still up. So stdout's errors are swallowed
  // into a note and every write goes through here; the run still cleans up and
  // still reaches its exit code, it just has nowhere to print.
  let stdoutNote = null;
  process.stdout.on("error", (error) => {
    stdoutNote = stdoutNote ?? `the report could not be printed: ${error.code ?? error.message}`;
  });
  const say = (text) => {
    if (stdoutNote) return;
    try {
      process.stdout.write(text);
    } catch (error) {
      stdoutNote = `the report could not be printed: ${error.code ?? error.message}`;
    }
  };
  const storeFailures = [];
  let cleaned = false;
  // A step fails on a spawn error or a nonzero exit alike; stderr's first
  // 200 characters go into the report.
  // A step may name one stderr text that is not a failure: the codex
  // container runs with --rm (so it is gone even when the launcher dies), and
  // by the time cleanup runs Docker has usually removed it already.
  const step = (label, fn, { tolerate = null } = {}) => {
    try {
      const result = fn();
      if (result?.error) throw result.error;
      if (result && result.status !== 0) {
        const stderr = (result.stderr || "").toString();
        if (tolerate && tolerate.test(stderr)) return;
        throw new Error((stderr || `exited ${result.status}`).trim().slice(0, 200));
      }
    } catch (error) {
      cleanupFailures.push(`${label}: ${error.message}`);
    }
  };
  const quiet = { encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] };
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    step("remove codex container", () => spawnSync("docker", ["rm", "-f", codexName], quiet), { tolerate: /No such container/ });
    // Stop the sidecar before reading its log, so the counts it is holding
    // are flushed into the log rather than killed with it.
    step("stop proxy container", () => spawnSync("docker", ["stop", "-t", "2", proxyName], quiet), { tolerate: /No such container/ });
    step("collect proxy log", () => {
      const result = spawnSync("docker", ["logs", "--tail", String(PROXY_LOG_LINES), proxyName], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error((result.stderr || `docker logs exited ${result.status}`).trim());
      proxyLog = result.stdout ?? "";
      if (proxyLog.split("\n").length - 1 >= PROXY_LOG_LINES) {
        proxyLogNote = `proxy log truncated to last ${PROXY_LOG_LINES} lines`;
      }
    });
    step("remove proxy container", () => spawnSync("docker", ["rm", "-f", proxyName], quiet), { tolerate: /No such container/ });
    step("remove network", () => spawnSync("docker", ["network", "rm", network], quiet));
    // The rollouts are the guardian evidence; copy them out before the
    // volume goes.
    step("export sessions", () => {
      const result = spawnSync("docker", sessionsExport, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      if (result.error || result.status !== 0) sessionsKept = homeVolume;
      else if (result.stdout.includes("no-sessions-recorded")) sessionsNote = "no sessions recorded";
      return result;
    });
    // The rollouts are the only copy of the guardian evidence; if the export
    // failed they are still in the volume, so the volume stays.
    // What the reviewer wrote is measured inside the container before any of
    // it comes out, and copied out only within the bound; past it nothing
    // reaches the host and the volume stays for the operator to look at.
    step("measure staged store", () => {
      const result = spawnSync("docker", storeSize, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      if (result.error || result.status !== 0) {
        storeFailures.push("the staged store could not be measured");
        storeKept = storeVolume;
        return result;
      }
      const [kilobytes, largest] = (result.stdout || "").trim().split(/\s+/).map(Number);
      if (!Number.isFinite(kilobytes)) {
        storeFailures.push("the staged store could not be measured");
        storeKept = storeVolume;
      } else if (kilobytes > STAGED_STORE_LIMIT_MB * 1024) {
        storeFailures.push(`staged store is ${(kilobytes / 1024).toFixed(1)} MB, over the ${STAGED_STORE_LIMIT_MB} MB bound`);
        storeKept = storeVolume;
      } else if (Number.isFinite(largest) && largest > STAGED_FILE_LIMIT_MB * 1024 * 1024) {
        storeFailures.push(`the largest staged file is ${(largest / (1024 * 1024)).toFixed(1)} MB, over the ${STAGED_FILE_LIMIT_MB} MB bound for one file`);
        storeKept = storeVolume;
      } else {
        storeWithinBound = true;
      }
      return result;
    });
    if (storeWithinBound) {
      step("copy the staged store out", () => {
        const result = spawnSync("docker", storeExport, quiet);
        if (result.error || result.status !== 0) {
          storeFailures.push("the staged store could not be copied out");
          storeKept = storeVolume;
        }
        return result;
      });
    }
    // The keeper holds both tmpfs volumes; it goes once nothing else needs
    // to read them.
    // A tmpfs volume holds nothing once no container mounts it, so a volume
    // kept for the operator to look at needs the keeper kept with it.
    if (keeperStarted && !sessionsKept && !storeKept) {
      step("remove volume keeper", () => spawnSync("docker", ["rm", "-f", keeperName], quiet), { tolerate: /No such container/ });
    }
    if (!sessionsKept) step("remove volume", () => spawnSync("docker", ["volume", "rm", homeVolume], quiet));
    // A store past the bound stays where it is; nothing of it reached the
    // host, and the operator may want to look at what filled it.
    if (!storeKept) step("remove store volume", () => spawnSync("docker", ["volume", "rm", storeVolume], quiet));
    step("remove staged checkout", () => fs.rmSync(inputs.checkout, { recursive: true, force: true }));
  };
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      cleanup();
      process.stderr.write("advisory-sandbox-launch: interrupted\n", () => process.exit(130));
    });
  }

  let codexExit = null;
  let elapsed = null;
  let headerAt = null;
  let boundary;
  try {
    for (const args of [networkCreate, proxyRun, proxyConnect]) {
      const result = run("docker", args);
      if (result.status !== 0) {
        throw new Error(`docker ${args[0]} ${args[1]} failed: ${result.stderr.trim()}`);
      }
    }
    // The readiness poll reads the proxy's log too; bounded the same way the
    // final collection is, so a log that grows past the default buffer can
    // never turn the poll into a failure.
    const proxyListening = () => {
      const result = spawnSync("docker", ["logs", "--tail", "20000", proxyName], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
      if (result.error) throw result.error;
      return (result.stdout ?? "").includes("listening");
    };
    const proxyDeadline = Date.now() + 15000;
    while (!proxyListening()) {
      if (Date.now() > proxyDeadline) throw new Error("the egress proxy did not start");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    // The bounded volumes, and the keeper that holds their tmpfs for the run.
    for (const [name, create, size] of [
      [homeVolume, homeVolumeCreate, CODEX_HOME_LIMIT],
      [storeVolume, storeVolumeCreate, `${STAGED_STORE_LIMIT_MB}m`],
    ]) {
      const created = run("docker", create);
      if (created.status !== 0) throw new Error(`the ${size} volume ${name} could not be created: ${(created.stderr || "").trim().slice(0, 200)}`);
      const inspected = run("docker", ["volume", "inspect", name, "--format", "{{json .Options}}"]);
      if (inspected.status !== 0 || !/(^|,|")o":"[^"]*size=/.test((inspected.stdout || "").replace(/\s/g, ""))) {
        throw new Error(
          `the volume ${name} was created without the tmpfs size option (${(inspected.stdout || "").trim() || (inspected.stderr || "").trim()}); this Docker cannot bound the reviewer's writes, so the launch stops rather than running unbounded`,
        );
      }
    }
    const keeper = run("docker", keeperRun);
    if (keeper.status !== 0) throw new Error(`the volume keeper could not start: ${(keeper.stderr || "").trim().slice(0, 200)}`);
    keeperStarted = true;
    // The staged review goes into the volume the reviewer will write to.
    const imported = run("docker", storeImport);
    if (imported.status !== 0) throw new Error(`the staged review could not be copied into the store volume: ${(imported.stderr || "").trim().slice(0, 200)}`);
    // The boundary is measured before the reviewer runs, by a probe with no
    // model in it: once without the checkout mount for what the image itself
    // holds, once with it, and the launch stops here if the difference is
    // more than the checkout.
    const baselineProbe = run("docker", baselineRun);
    const probe = run("docker", boundaryRun);
    boundary = evaluateBoundary(baselineProbe.stdout, probe.stdout, inputs);
    if (baselineProbe.status !== 0 || probe.status !== 0 || boundary.failures.length > 0) {
      process.stderr.write(`${baselineProbe.stderr}${probe.stderr}${probe.stdout}`);
      throw new Error(
        `the container boundary did not hold:\n  ${boundary.failures.join("\n  ") || `probe exited ${probe.status}`}`,
      );
    }

    const started = Date.now();
    const transcript = fs.createWriteStream(transcriptPath);
    // A write that fails is a note in the report, never a throw: the ledger
    // may already be about to move, and a run without a report is worse than
    // a run without a transcript.
    transcript.on("error", (error) => {
      transcriptNote = transcriptNote ?? `the transcript could not be written: ${error.message}`;
    });
    codexExit = await new Promise((resolve, reject) => {
      const child = spawn("docker", codexRun, { stdio: ["ignore", "pipe", "pipe"] });
      const forward = (stream) => {
        stream.on("data", (chunk) => {
          if (headerAt === null && chunk.toString().includes("session id:")) {
            headerAt = (Date.now() - started) / 1000;
          }
          // The head is what carries the session id and the mcp lines, so the
          // head is what is kept; past the bound the bytes are counted and
          // dropped, on this stream and in the file alike.
          const room = TRANSCRIPT_LIMIT_MB * 1024 * 1024 - transcriptBytes;
          const kept = room <= 0 ? null : chunk.length <= room ? chunk : chunk.subarray(0, room);
          if (kept) {
            transcriptBytes += kept.length;
            say(kept);
            transcript.write(kept);
          }
          if (!kept || kept.length < chunk.length) transcriptDropped += chunk.length - (kept?.length ?? 0);
        });
      };
      forward(child.stdout);
      forward(child.stderr);
      child.on("error", reject);
      child.on("close", (code) => resolve(code));
    });
    // The last mcp: line is often the last bytes the child wrote; read the
    // transcript only once the stream has flushed them.
    if (transcriptDropped > 0) {
      transcript.write(`\n[transcript truncated after ${TRANSCRIPT_LIMIT_MB} MB; ${transcriptDropped} more bytes discarded]\n`);
    }
    await new Promise((resolve) => transcript.end(resolve));
    elapsed = (Date.now() - started) / 1000;
  } catch (error) {
    cleanup();
    fail(error instanceof LaunchFailure ? error.message : error.message, error instanceof LaunchFailure ? error.code : 1);
  } finally {
    cleanup();
  }

  // Every piece of evidence is read before anything is copied back, and any
  // failure of that reading is a criterion, not an exception: once the host
  // ledger moves there must be a report saying so.
  const evidenceProblems = [];
  let mcpJudgement = { ok: false, reasons: ["the rollout evidence was not read"], detail: "the rollout evidence was not read" };
  let verdicts = [];
  try {
    const transcriptText = await fsp.readFile(transcriptPath, "utf8");
    const mcp = parseMcpLines(transcriptText);
    const reviewerCalls = [...mcp.entries()].filter(([key]) => key.startsWith(`${REVIEWER_SERVER}/`));
    const started = reviewerCalls.reduce((sum, [, entry]) => sum + entry.started, 0);
    const sessionId = transcriptText.match(/^session id: (\S+)$/m)?.[1] ?? null;
    const sessionsRoot = path.join(scratch, "sessions");
    const records = sessionId ? await mainRolloutRecords(sessionsRoot, sessionId, evidenceProblems) : null;
    verdicts = await guardianVerdicts(sessionsRoot, evidenceProblems);
    mcpJudgement = judgeMcpCalls(records, transcriptDropped > 0 ? null : started);
  } catch (error) {
    evidenceProblems.push(`the run's evidence could not be read: ${error.message}`);
  }
  if (evidenceProblems.length > 0) {
    mcpJudgement = {
      ok: false,
      reasons: [...mcpJudgement.reasons, ...evidenceProblems],
      detail: `${mcpJudgement.detail}; ${evidenceProblems.join("; ")}`,
    };
  }
  if (transcriptDropped > 0) {
    mcpJudgement = {
      ...mcpJudgement,
      detail: `${mcpJudgement.detail}; transcript truncated after ${TRANSCRIPT_LIMIT_MB} MB, ${transcriptDropped} bytes discarded, so its started lines were not counted against the rollout`,
    };
  }
  // The copy-back happens only after criteria 1 and 2 and the exit code have
  // passed: a host ledger advanced to REVIEW_SUBMITTED or CLEAN cannot be
  // launched again, so a run with an unexplained failure or a nonzero exit
  // must leave it where it was. Then: check what the container left in the
  // staged store at the file level, replay the verdict through the host's own
  // submit_review under the host review's lock, and keep the replay only if
  // it equals the staged ledger; otherwise refuse with the reasons.
  const mcpOk = mcpJudgement.ok;
  const preCopyFailures = [
    ...(codexExit === 0 ? [] : [`codex exited ${codexExit}`]),
    ...(mcpOk ? [] : mcpJudgement.reasons),
    ...(boundary.failures.length === 0 ? [] : ["the boundary did not hold"]),
    ...storeFailures,
  ];
  const inspection = preCopyFailures.length > 0 ? { reasons: [], ledgerChanged: false } : await inspectStagedStore(inputs, stage);
  let copyBackOutcome;
  if (preCopyFailures.length > 0) {
    copyBackOutcome = { ok: false, detail: `refused — pre-copy criteria failed: ${preCopyFailures.join("; ")}; host store unwritten, staged copy kept at ${stage.staged}` };
  } else if (inspection.reasons.length > 0) {
    copyBackOutcome = { ok: false, detail: `copy-back refused — ${inspection.reasons.join("; ")}; host store unwritten, staged copy kept at ${stage.staged}` };
  } else if (!inspection.ledgerChanged) {
    copyBackOutcome = { ok: false, detail: "nothing to copy back — the staged ledger is unchanged, so no verdict was recorded" };
  } else {
    try {
      await replayAndCopyBack(inputs, stage, before, scratch, {
        loadReview,
        submitInitialReview,
        withStateLock,
        atomicWriteFile,
        canonicalJson,
      });
      copyBackOutcome = { ok: true, detail: null };
    } catch (error) {
      copyBackOutcome = { ok: false, detail: `copy-back refused — ${error.message}; host store unwritten, staged copy kept at ${stage.staged}` };
    }
  }
  const after = await ledgerFacts(inputs.ledgerPath);
  if (copyBackOutcome.ok) {
    copyBackOutcome.detail = `copy-back applied — the verdict was replayed through the host's own submit_review against the host ledger under its state lock and matched the staged ledger; status ${before.status} → ${after.status}, state_version ${before.stateVersion} → ${after.stateVersion}, findings ${after.findings}, review.json mtime ${before.mtime} → ${after.mtime}`;
  }
  const criteria = [
    ["1 MCP calls completed inside the container", mcpOk, mcpJudgement.detail],
    [
      "2 host filesystem absent",
      boundary.failures.length === 0,
      `absent (and not in the image): ${boundary.facts.absent.join(", ")}${boundary.facts.present.length ? `; present: ${boundary.facts.present.join(", ")}` : ""}${boundary.facts.children.length ? `; checkout ancestors against the unmounted baseline: ${boundary.facts.children.join("; ")}` : ""}${boundary.facts.dns.length ? `; dns: ${boundary.facts.dns.join(", ")}` : ""}`,
    ],
    ["3 validated verdict copied back to the host store", copyBackOutcome.ok, copyBackOutcome.detail],
  ];
  const lines = [
    "",
    "== advisory sandbox launch report ==",
    `review ${inputs.reviewId}  store ${inputs.store} (staged, never mounted)  scratch ${scratch}`,
    `docker ${dockerVersion}  image ${IMAGE} (${imageState})  ${boundary.facts.codexVersion ?? ""}  uid ${boundary.facts.uid ?? "?"}`,
    `codex exit ${codexExit}, ${elapsed?.toFixed(1)} s (header at +${headerAt?.toFixed(1) ?? "?"} s); transcript ${transcriptPath}`,
    ...criteria.flatMap(([name, ok, detail]) => [
      `criterion ${name}: ${ok ? "PASS" : "FAIL"} — ${detail}`,
      ...(name.startsWith("1 ")
        ? ["  (run-health evidence recorded inside the container and forgeable by a reviewer with shell access; the copy-back's integrity rests on the host replay, not on it)"]
        : []),
    ]),
    `egress: example.com via proxy → ${boundary.facts.egressProxied}, without proxy → ${boundary.facts.egressDirect}; proxy log: ${
      cleanupFailures.find((failure) => failure.startsWith("collect proxy log"))
        ? `unavailable: ${cleanupFailures.find((failure) => failure.startsWith("collect proxy log")).slice("collect proxy log: ".length)}`
        : `${summarizeProxyLog(proxyLog) || "(empty)"}${proxyLogNote ? ` (${proxyLogNote})` : ""}${
            / ×\d+ suppressed$/m.test(proxyLog)
              ? " (repeated records collapsed; up to 5s of trailing counts may be unflushed if the proxy was killed)"
              : ""
          }`
    }`,
    `guardian verdicts (${verdicts.length})${sessionsNote ? ` — ${sessionsNote}` : ""}:`,
    ...(verdicts.length
      ? verdicts.map(
          (turn) =>
            `  ${turn.tool ?? "?"}: ${turn.outcome ?? "?"} (risk ${turn.risk ?? "?"}, authorization ${turn.authorization ?? "?"}, ${turn.seconds?.toFixed(1)} s)`,
        )
      : ["  none found in the sessions copied out of the isolated CODEX_HOME"]),
    `residual: the one host secret inside was ${inputs.authJson}, egress limited to ${EGRESS_ALLOW.join(", ")} by the sidecar${cleanupFailures.length ? `; cleanup steps that failed: ${cleanupFailures.join("; ")}` : ""}${sessionsKept ? `; the CODEX_HOME volume ${sessionsKept} was kept for the failed export` : ""}${storeKept ? `; the staged store volume ${storeKept} was kept, unread` : ""}${
      sessionsKept || storeKept
        ? `; the volume keeper ${keeperName} is still running to hold ${[sessionsKept, storeKept].filter(Boolean).join(" and ")} (a tmpfs volume empties when nothing mounts it), so it goes on using memory until you clear it: look with \`docker run --rm -v ${storeKept ?? sessionsKept}:/v alpine ls -la /v\`, then \`docker rm -f ${keeperName} && ${[sessionsKept, storeKept].filter(Boolean).map((volume) => `docker volume rm ${volume}`).join(" && ")}\``
        : ""
    }${transcriptNote ? `; ${transcriptNote}` : ""}`,
    "",
  ];
  say(lines.join("\n"));
  const failed = criteria.some(([, ok]) => !ok);
  process.exitCode = codexExit !== 0 ? codexExit || 1 : failed ? 1 : 0;
}

try {
  await main();
} catch (error) {
  if (error instanceof LaunchFailure) {
    process.stderr.write(`advisory-sandbox-launch: ${error.message}\n`);
    process.exitCode = error.code;
  } else {
    process.stderr.write(`advisory-sandbox-launch: ${error?.stack ?? error}\n`);
    process.exitCode = 1;
  }
}
