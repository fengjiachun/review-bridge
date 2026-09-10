// Every git the advisory launcher family runs on the host — the panel
// checkout script's clone, fetch, and checkout; the launcher's checks on the
// panel checkout and its staging clone — runs in one isolated environment: no
// global or system configuration, an empty HOME and hooks path, no GIT_* from
// the operator's shell, no terminal prompt. A `.gitattributes` in the reviewed
// tree can name a filter, and with the operator's global configuration in
// reach that filter's command would run on the host before the container
// exists (Codex rounds twenty-five and twenty-seven on #125); with nothing to
// resolve the name against, git applies nothing. The ssh agent socket is the
// one thing passed through, so a remote can be reached over ssh; no
// credential helper is consulted, so an https remote must be reachable
// without one. The isolation directory is made on first use and removed at
// exit.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let isolation = null;

export function isolatedGit(args) {
  if (!isolation) {
    isolation = fs.mkdtempSync(path.join(os.tmpdir(), "review-bridge-advisory-git-"));
    fs.mkdirSync(path.join(isolation, "home"));
    fs.mkdirSync(path.join(isolation, "hooks"));
  }
  const env = {
    PATH: process.env.PATH,
    LANG: process.env.LANG ?? "C.UTF-8",
    TMPDIR: os.tmpdir(),
    HOME: path.join(isolation, "home"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  if (process.env.SSH_AUTH_SOCK) env.SSH_AUTH_SOCK = process.env.SSH_AUTH_SOCK;
  return spawnSync(
    "git",
    ["-c", `core.hooksPath=${path.join(isolation, "hooks")}`, "-c", "filter.lfs.required=false", ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env },
  );
}

process.on("exit", () => {
  if (isolation) fs.rmSync(isolation, { recursive: true, force: true });
});
