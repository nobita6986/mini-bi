#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const SHARD_COUNT = 4;
const POSTGRES_SHARD = 4;
const POSTGRES_TESTS = new Set([
  "test:p3-1-w02a-team-leader-project-manager",
]);

const shard = Number(process.argv[2]);
const listOnly = process.argv.includes("--list");

if (!Number.isInteger(shard) || shard < 1 || shard > SHARD_COUNT) {
  throw new Error(`Shard must be an integer from 1 to ${SHARD_COUNT}.`);
}

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const commands = packageJson.scripts.test.split(/\s*&&\s*/).map((part) => {
  const match = /^pnpm (test:[a-zA-Z0-9._-]+)$/.exec(part.trim());
  if (match === null) {
    throw new Error(`Unsupported command in package.json scripts.test: ${part}`);
  }
  return match[1];
});

for (const command of POSTGRES_TESTS) {
  if (!commands.includes(command)) {
    throw new Error(`PostgreSQL test is missing from package.json scripts.test: ${command}`);
  }
}

const selected = commands.filter((command, index) => {
  if (POSTGRES_TESTS.has(command)) return shard === POSTGRES_SHARD;
  return index % SHARD_COUNT === shard - 1;
});

if (selected.length === 0) {
  throw new Error(`CI test shard ${shard} is empty.`);
}

console.log(`CI test shard ${shard}/${SHARD_COUNT}: ${selected.length} commands`);
if (listOnly) {
  console.log(selected.join("\n"));
  process.exit(0);
}

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
for (const command of selected) {
  console.log(`\n[CI shard ${shard}/${SHARD_COUNT}] pnpm ${command}`);
  const result = spawnSync(pnpm, [command], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
