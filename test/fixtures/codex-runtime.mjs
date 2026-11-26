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
  // RB_TEST_CONFIG_MODEL overrides the configured model ("" for none),
  // RB_TEST_MODELS limits the models served, and RB_TEST_APP_SERVER picks a failure.
  const mode = process.env.RB_TEST_APP_SERVER;
  fs.writeFileSync("app-server.pid", String(process.pid));
  if (mode === "exit") {
    process.stderr.write("error: unknown configuration key\n");
    process.exit(3);
  }
  if (mode === "hang") process.on("SIGTERM", () => {});
  const efforts = (...values) => values.map((reasoningEffort) => ({ reasoningEffort, description: reasoningEffort }));
  const served = process.env.RB_TEST_MODELS?.split(",");
  const visible = (entries) => entries.filter((entry) => served == null || served.includes(entry.model));
  const hidden = { model: "fixture-hidden", hidden: true, supportedReasoningEfforts: efforts("low") };
  const pages = {
    null: { data: [{ model: "fixture-sol", displayName: "Fixture Sol", isDefault: true, supportedReasoningEfforts: efforts("low", "medium", "high", "xhigh", "max", "ultra") }], nextCursor: "page-2" },
    "page-2": { data: [{ model: "fixture-luna", displayName: "Fixture Luna", supportedReasoningEfforts: efforts("low", "medium", "high", "xhigh", "max") }], nextCursor: mode === "repeat-cursor" ? "page-2" : null },
  };
  const configured = process.env.RB_TEST_CONFIG_MODEL ?? "fixture-luna";
  let initialized = false;
  const results = {
    initialize: () => ({ userAgent: "fixture" }),
    "config/read": () => ({ config: { model: configured || null, model_reasoning_effort: "low" } }),
    "model/list": ({ cursor, includeHidden }) => mode === "invalid-page"
      ? { data: [{ model: "fixture-sol", supportedReasoningEfforts: [{ effort: "high" }] }], nextCursor: null }
      : { ...pages[cursor], data: [...visible(pages[cursor].data), ...(includeHidden === false || cursor ? [] : [hidden])] },
  };
  createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.method === "initialized") initialized = true;
    if (message.id == null || mode === "hang") return;
    if (mode === "malformed") process.stdout.write("null\n[]\n");
    const ready = message.method === "initialize" || initialized;
    process.stdout.write(`${JSON.stringify(ready
      ? { id: message.id, result: results[message.method](message.params) }
      : { id: message.id, error: { message: "Not initialized" } })}\n`);
  });
}
