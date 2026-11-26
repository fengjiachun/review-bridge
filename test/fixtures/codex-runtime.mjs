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
  // RB_TEST_MODELS limits the models served, RB_TEST_APP_SERVER picks a failure,
  // and model/list waits while RB_TEST_LIST_HOLD exists.
  const mode = process.env.RB_TEST_APP_SERVER;
  const args = process.argv.slice(3);
  if (args.length !== 2 || args[0] !== "--listen" || args[1] !== "stdio://") {
    process.stderr.write("error: only --listen stdio:// is served\n");
    process.exit(2);
  }
  if (mode === "exit") {
    process.stderr.write("error: unknown configuration key\n");
    process.exit(3);
  }
  // Ignores SIGTERM and fails initialize only after writing its pid.
  if (mode === "stubborn") {
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1000);
    fs.writeFileSync("stubborn.pid", String(process.pid));
  }
  const efforts = (...values) => values.map((reasoningEffort) => ({ reasoningEffort, description: reasoningEffort }));
  const served = process.env.RB_TEST_MODELS?.split(",");
  const visible = (entries) => entries.filter((entry) => served == null || served.includes(entry.model));
  const hidden = { model: "fixture-hidden", hidden: true, supportedReasoningEfforts: efforts("low") };
  const pages = {
    null: { data: [{ model: "fixture-sol", displayName: "Fixture Sol", isDefault: true, supportedReasoningEfforts: efforts("low", "medium", "high", "xhigh", "max", "ultra") }], nextCursor: "page-2" },
    "page-2": { data: [
      { model: "fixture-luna", displayName: "Fixture Luna", supportedReasoningEfforts: efforts("low", "medium", "high", "xhigh", "max") },
      { model: "fixture-mini", displayName: "Fixture Mini", supportedReasoningEfforts: efforts("low", "medium") },
    ], nextCursor: mode === "repeat-cursor" ? "page-2" : null },
  };
  const configured = process.env.RB_TEST_CONFIG_MODEL ?? "fixture-luna";
  let initializeAnswered = false;
  let initialized = false;
  const results = {
    initialize: () => ({ userAgent: "fixture" }),
    "config/read": () => ({ "invalid-config": {}, "array-config": { config: [] } })[mode] ??
      { config: { model: configured || null, model_reasoning_effort: "low" } },
    "model/list": ({ cursor, includeHidden }) => mode === "invalid-page"
      ? { data: [{ model: "fixture-sol", supportedReasoningEfforts: [{ effort: "high" }] }], nextCursor: null }
      : { ...pages[cursor], data: [...visible(pages[cursor].data), ...(includeHidden === false || cursor ? [] : [hidden])] },
  };
  const hold = process.env.RB_TEST_LIST_HOLD;
  const whenReleased = (reply) => hold && fs.existsSync(hold)
    ? (fs.writeFileSync("list-held", ""), setTimeout(() => whenReleased(reply), 10)) : reply();
  createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.method === "initialized" && initializeAnswered) initialized = true;
    if (message.id == null || mode === "hang") return;
    if (mode === "malformed") process.stdout.write("null\n[]\n");
    const reply = (body) => process.stdout.write(`${JSON.stringify({ id: message.id, ...body })}\n`);
    if (mode === "stubborn") return reply({ error: { message: "stubborn listing refuses" } });
    if (message.method === "initialize") {
      initializeAnswered = true;
      return reply({ result: results.initialize() });
    }
    if (!initialized) return reply({ error: { message: "Not initialized" } });
    if (mode === "malformed" && message.method === "model/list") return reply({ error: { message: { toString: 1 } } });
    if (message.method === "model/list") return whenReleased(() => reply({ result: results["model/list"](message.params) }));
    reply({ result: results[message.method](message.params) });
  });
}
