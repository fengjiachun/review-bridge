#!/usr/bin/env node
import fs from "node:fs";
import { createInterface } from "node:readline";
if (process.argv[2] === "exec") {
  fs.writeFileSync("executed.json", JSON.stringify({ args: process.argv.slice(2), stdin: fs.readFileSync(0, "utf8") }));
  // Waits while the configured hold file exists, so removing the fixture root also ends it.
  const hold = process.env.RB_TEST_HOLD;
  const exitWhenReleased = () => hold && fs.existsSync(hold) ? setTimeout(exitWhenReleased, 10) : process.exit(0);
  exitWhenReleased();
}
if (process.argv[2] === "app-server") {
  // Two model/list pages; RB_TEST_CONFIG_MODEL overrides the configured model, "" for none.
  const efforts = (...values) => values.map((reasoningEffort) => ({ reasoningEffort, description: reasoningEffort }));
  const pages = {
    null: { data: [{ model: "fixture-sol", displayName: "Fixture Sol", isDefault: true, supportedReasoningEfforts: efforts("low", "medium", "high", "xhigh", "max", "ultra") }], nextCursor: "page-2" },
    "page-2": { data: [{ model: "fixture-luna", displayName: "Fixture Luna", supportedReasoningEfforts: efforts("low", "medium", "high", "xhigh", "max") }], nextCursor: null },
  };
  const configured = process.env.RB_TEST_CONFIG_MODEL ?? "fixture-luna";
  const results = {
    initialize: () => ({ userAgent: "fixture" }),
    "config/read": () => ({ config: { model: configured || null, model_reasoning_effort: "low" } }),
    "model/list": (params) => pages[params.cursor],
  };
  createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id == null) return;
    process.stdout.write(`${JSON.stringify({ id: message.id, result: results[message.method](message.params) })}\n`);
  });
}
