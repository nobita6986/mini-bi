#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

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
const rootCommands = packageJson.scripts.test.split(/\s*&&\s*/).map((part) => {
  const match = /^pnpm (test:[a-zA-Z0-9._-]+)$/.exec(part.trim());
  if (match === null) {
    throw new Error(`Unsupported command in package.json scripts.test: ${part}`);
  }
  return match[1];
});

for (const command of POSTGRES_TESTS) {
  if (!rootCommands.includes(command)) {
    throw new Error(`PostgreSQL test is missing from package.json scripts.test: ${command}`);
  }
}

const seenTestInvocations = new Set();
let originalTestCount = 0;
let duplicateTestCount = 0;

const plannedCommands = rootCommands.map((name, index) => {
  const script = packageJson.scripts[name];
  if (typeof script !== "string") {
    throw new Error(`Test command is missing from package.json scripts: ${name}`);
  }

  const commands = script.split(/\s*&&\s*/).flatMap((part) => {
    const tokens = part.trim().split(/\s+/);
    const testFlagIndex = tokens.indexOf("--test");
    if (tokens[0] !== "node" || testFlagIndex < 1 || testFlagIndex === tokens.length - 1) {
      throw new Error(`Unsupported test command in package.json scripts.${name}: ${part}`);
    }

    const nodeArgs = tokens.slice(1, testFlagIndex);
    const testFiles = tokens.slice(testFlagIndex + 1).filter((testFile) => {
      originalTestCount += 1;
      const normalizedPath = path.posix.normalize(testFile.replaceAll("\\", "/"));
      const invocationKey = JSON.stringify([nodeArgs, normalizedPath]);
      if (seenTestInvocations.has(invocationKey)) {
        duplicateTestCount += 1;
        return false;
      }
      seenTestInvocations.add(invocationKey);
      return true;
    });

    return testFiles.length === 0
      ? []
      : [{ args: [...nodeArgs, "--test", ...testFiles], testFiles }];
  });

  return { name, index, commands };
});

const uniqueTestCount = plannedCommands.reduce(
  (total, plan) => total + plan.commands.reduce(
    (commandTotal, command) => commandTotal + command.testFiles.length,
    0,
  ),
  0,
);

if (uniqueTestCount !== seenTestInvocations.size) {
  throw new Error("CI test de-duplication produced an inconsistent test plan.");
}

const selected = plannedCommands.filter(({ name, index, commands }) => {
  if (commands.length === 0) return false;
  if (POSTGRES_TESTS.has(name)) return shard === POSTGRES_SHARD;
  return index % SHARD_COUNT === shard - 1;
});

if (selected.length === 0) {
  throw new Error(`CI test shard ${shard} is empty.`);
}

const selectedCommandCount = selected.reduce(
  (total, plan) => total + plan.commands.length,
  0,
);
const selectedTestCount = selected.reduce(
  (total, plan) => total + plan.commands.reduce(
    (commandTotal, command) => commandTotal + command.testFiles.length,
    0,
  ),
  0,
);

console.log(
  `CI test plan: ${uniqueTestCount} unique file invocations; `
    + `${duplicateTestCount} exact duplicates removed from ${originalTestCount}`,
);
console.log(
  `CI test shard ${shard}/${SHARD_COUNT}: ${selected.length} package scripts, `
    + `${selectedCommandCount} node commands, ${selectedTestCount} file invocations`,
);
if (listOnly) {
  for (const plan of selected) {
    for (const command of plan.commands) {
      console.log(`${plan.name}: node ${command.args.join(" ")}`);
    }
  }
  process.exit(0);
}

for (const plan of selected) {
  for (const command of plan.commands) {
    console.log(
      `\n[CI shard ${shard}/${SHARD_COUNT}] ${plan.name}: node ${command.args.join(" ")}`,
    );
    const result = spawnSync(process.execPath, command.args, { stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
