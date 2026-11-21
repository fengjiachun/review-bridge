#!/usr/bin/env node
import fs from "node:fs";
if (process.argv[2] === "exec") {
  fs.writeFileSync("executed.json", JSON.stringify({ args: process.argv.slice(2), stdin: fs.readFileSync(0, "utf8") }));
  // Waits while the configured hold file exists, so removing the fixture root also ends it.
  const hold = process.env.RB_TEST_HOLD;
  const exitWhenReleased = () => hold && fs.existsSync(hold) ? setTimeout(exitWhenReleased, 10) : process.exit(0);
  exitWhenReleased();
}
