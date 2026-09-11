// Every git the advisory launcher family runs on the host — the panel
// checkout script's clone, fetch, and checkout; the launcher's checks on the
// panel checkout and its staging clone — runs in one isolated environment: no
// global or system configuration, an empty HOME and hooks path, no GIT_* from
// the operator's shell, no terminal prompt. A `.gitattributes` in the reviewed
// tree can name a filter, and with the operator's global configuration in
// reach that filter's command would run on the host before the container
// exists (Codex rounds twenty-five and twenty-seven on #125); with nothing to
// resolve the name against, git applies nothing. No credential helper is
// consulted, so an https remote must be reachable without one.
//
// Changing HOME does not isolate OpenSSH: it takes the home directory for
// ~/.ssh/config, the default identity files, and the default known_hosts
// from the passwd entry, not from the environment (Codex round twenty-nine
// on #125). So ssh is pinned by an explicit GIT_SSH_COMMAND rather than by
// HOME: `-F /dev/null` reads no ssh configuration at all, `IdentitiesOnly`
// with `IdentityFile=/dev/null` uses no key from disk, `IdentityAgent` names
// the operator's agent socket as the one credential source (`none` when
// there is no agent), and `ProxyCommand`/`ProxyJump`/`ControlMaster`/
// `ControlPath` are off, so a configuration cannot make ssh run a command or
// reuse a multiplexed connection. Host keys are still checked: the
// operator's ~/.ssh/known_hosts is read (a host public key is not a secret,
// and reading it buys real host verification) with StrictHostKeyChecking
// yes; when that file does not exist the policy falls back to accept-new
// against one file inside the isolation directory, so every git call of a
// run checks the key the first one accepted and the caller can print what
// was accepted — the file goes with the isolation directory at exit, so the
// trust lasts the run and no longer.
//
// The isolation directory is made on first use and removed at exit.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let isolation = null;

const KNOWN_HOSTS = path.join(os.homedir(), ".ssh", "known_hosts");

function isolationDirectory() {
  if (!isolation) {
    isolation = fs.mkdtempSync(path.join(os.tmpdir(), "review-bridge-advisory-git-"));
    fs.mkdirSync(path.join(isolation, "home"));
    fs.mkdirSync(path.join(isolation, "hooks"));
  }
  return isolation;
}

// True when the operator has no known_hosts for ssh to check against, so the
// first host key of a remote is taken on trust. The caller states it.
export function sshTrustsOnFirstUse() {
  return !fs.existsSync(KNOWN_HOSTS);
}

// An ssh-shaped remote: a scheme git carries over ssh, or scp syntax
// (`user@host:path`, which a Windows drive letter cannot be).
export function isSshRemote(remote) {
  return /^(?:ssh|git\+ssh):\/\//i.test(remote) || /^[^/]+@[^/:]+:/.test(remote);
}

function sshCommand() {
  const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
  const trustOnFirstUse = sshTrustsOnFirstUse();
  return [
    "ssh",
    "-F",
    "/dev/null",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "IdentityFile=/dev/null",
    "-o",
    `IdentityAgent=${quote(process.env.SSH_AUTH_SOCK ?? "none")}`,
    "-o",
    "ProxyCommand=none",
    "-o",
    "ProxyJump=none",
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    "-o",
    `StrictHostKeyChecking=${trustOnFirstUse ? "accept-new" : "yes"}`,
    "-o",
    `UserKnownHostsFile=${quote(trustOnFirstUse ? runKnownHosts() : KNOWN_HOSTS)}`,
  ].join(" ");
}

// The known_hosts of a trust-on-first-use run: one file, shared by every git
// call of the run, gone with the isolation directory.
function runKnownHosts() {
  return path.join(isolationDirectory(), "known_hosts");
}

// The host keys such a run accepted, one `ssh-keygen -l` line each, for the
// caller to print. Empty when the operator has a known_hosts of their own
// (nothing was taken on trust) or when nothing was accepted.
export function sshAcceptedHostKeys() {
  if (!sshTrustsOnFirstUse() || !isolation) return [];
  const file = runKnownHosts();
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) return [];
  const shown = spawnSync("ssh-keygen", ["-lf", file], { encoding: "utf8" });
  if (shown.error || shown.status !== 0) return [];
  return shown.stdout.split("\n").filter(Boolean);
}

export function isolatedGit(args) {
  const directory = isolationDirectory();
  const env = {
    PATH: process.env.PATH,
    LANG: process.env.LANG ?? "C.UTF-8",
    TMPDIR: os.tmpdir(),
    HOME: path.join(directory, "home"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  env.GIT_SSH_COMMAND = sshCommand();
  return spawnSync(
    "git",
    ["-c", `core.hooksPath=${path.join(directory, "hooks")}`, "-c", "filter.lfs.required=false", ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env },
  );
}

process.on("exit", () => {
  if (isolation) fs.rmSync(isolation, { recursive: true, force: true });
});
