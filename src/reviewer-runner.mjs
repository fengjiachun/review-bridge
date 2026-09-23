import { spawn } from "node:child_process";
import path from "node:path";
import { atomicWriteFile } from "./storage.mjs";

const directory = process.argv[2];
const { command, args } = JSON.parse(process.env.REVIEW_BRIDGE_LAUNCH);
delete process.env.REVIEW_BRIDGE_LAUNCH;
const child = spawn(command, args, { stdio: ["ignore", "inherit", "inherit"] });
let recorded = false;
async function finish(result) {
  if (recorded) return;
  recorded = true;
  await atomicWriteFile(path.join(directory, "exit.json"), JSON.stringify({
    ...result, exited_at: new Date().toISOString(),
  }));
}
child.once("error", (error) => finish({ error: error.message }));
child.once("exit", (code, signal) => finish({ code, signal }));
