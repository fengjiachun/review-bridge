import fsp from "node:fs/promises";
import path from "node:path";

export const FIXTURE_CODEX = path.resolve("test/fixtures/codex-runtime.mjs");

export async function waitForExit(attemptRoot) {
  const exitFile = path.join(attemptRoot, "exit.json");
  for (let i = 0; i < 100; i++) {
    try { return JSON.parse(await fsp.readFile(exitFile, "utf8")); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      await new Promise((r) => setTimeout(r, 30));
    }
  }
  throw new Error("fake reviewer did not exit");
}
