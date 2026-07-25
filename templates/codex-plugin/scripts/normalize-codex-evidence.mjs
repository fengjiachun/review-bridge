#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { adaptCodexEvidence } from "../server/github-adapter.mjs";

const input = process.argv[2]
  ? await readFile(process.argv[2], "utf8")
  : await new Promise((resolve, reject) => {
      let value = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => {
        value += chunk;
      });
      process.stdin.on("end", () => resolve(value));
      process.stdin.on("error", reject);
    });

process.stdout.write(`${JSON.stringify(adaptCodexEvidence(JSON.parse(input)), null, 2)}\n`);
