#!/usr/bin/env node
import fs from "node:fs";
import { createInterface } from "node:readline";
const config = () => process.env.RB_TEST_CATALOG ? JSON.parse(fs.readFileSync(process.env.RB_TEST_CATALOG)) : {};
if (process.argv[2] === "exec") {
  fs.writeFileSync("executed.json", JSON.stringify({ args: process.argv.slice(2), stdin: fs.readFileSync(0, "utf8") }));
  setTimeout(() => process.exit(0), config().delay ?? 0);
} else if (process.argv[2] === "app-server") {
  createInterface({ input: process.stdin }).on("line", (line) => {
    const { id, method, params } = JSON.parse(line);
    if (id == null) return;
    const c = config();
    let result;
    if (method === "initialize") result = { userAgent: "test-runtime/1" };
    if (method === "account/read") result = { account: { id: c.account ?? "fixture" } };
    if (method === "config/read") result = { config: { model: "author-model" } };
    if (method === "model/list") {
      if (c.failure) { console.log(JSON.stringify({ id, error: { message: "catalog unavailable" } })); return; }
      const entry = (name, hidden = false) => ({ id: name, model: name, displayName: name, hidden, isDefault: name === "review-model", defaultReasoningEffort: "medium", supportedReasoningEfforts: (c.efforts ?? ["medium", "high"]).map(reasoningEffort => ({ reasoningEffort })) });
      result = params.cursor == null
        ? { data: [entry(c.model ?? "review-model"), entry("hidden-model", true)], nextCursor: "page-two" }
        : { data: [entry("second-model")], nextCursor: null };
    }
    console.log(JSON.stringify({ id, result }));
  });
}
