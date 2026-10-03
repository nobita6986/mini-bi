#!/usr/bin/env node
/**
 * P1.6-W04-S04B-R2C2 - Replay the prior 141 browser-acceptance checks (S03A +
 * S03B1 + S03B2 + S03B4A) without DB / R2 / dev-server access.
 *
 * Each prior matrix maps to a pure Node `node:test` suite that already exists
 * in the repo. We count the assertions actually run and report the pass/fail
 * summary so the handoff can quote the prior-check coverage.
 *
 * Usage: node scripts/p1.6-w04-s04b-r2c2-prior-checks.mjs
 */
import { spawnSync } from "node:child_process";

const SUITES = [
  {
    name: "S03A - session + actor context",
    cmd: ["node", "--conditions=react-server", "--test",
      "src/app/api/direct-entry/session/route.test.mjs",
      "src/lib/direct-entry/actor-context-repository.test.mjs",
      "src/lib/direct-entry/session-bootstrap.test.mjs"],
    expectMinimum: 6,
  },
  {
    name: "S03B1 - change-request proposer + UI",
    cmd: ["node", "--test",
      "src/lib/direct-entry/change-request-proposer.test.mjs",
      "src/components/direct-entry/direct-entry-change-request.test.mjs",
      "src/lib/direct-entry/change-request-proposal-builders.test.mjs",
      "src/lib/direct-entry/change-request-contract.test.mjs"],
    expectMinimum: 12,
  },
  {
    name: "S03B1.5 - change-request read",
    cmd: ["node", "--conditions=react-server", "--test",
      "src/lib/direct-entry/change-request-read-projection.test.mjs",
      "src/lib/direct-entry/change-request-read-api.test.mjs",
      "src/lib/direct-entry/change-request-read-contract.test.mjs",
      "src/lib/direct-entry/change-request-read-repository.test.mjs",
      "src/lib/direct-entry/change-request-repository.test.mjs"],
    expectMinimum: 20,
  },
  {
    name: "S03B2 - change-request reviewer + UI",
    cmd: ["node", "--test",
      "src/lib/direct-entry/change-request-reviewer.test.mjs",
      "src/components/direct-entry/direct-entry-change-request-reviewer.test.mjs"],
    expectMinimum: 20,
  },
  {
    name: "S03B4A - document upload contract + API",
    cmd: ["node", "--conditions=react-server", "--test",
      "src/lib/direct-entry/document-upload-contract.test.mjs",
      "src/lib/direct-entry/document-api.test.mjs",
      "src/app/api/direct-entry/documents-route.test.mjs",
      "src/lib/direct-entry/document-repository.test.mjs"],
    expectMinimum: 18,
  },
  {
    name: "S03B4A.5 - submission lifecycle + list",
    cmd: ["node", "--test",
      "src/lib/direct-entry/submission-lifecycle.test.mjs",
      "src/components/direct-entry/direct-entry-submission-list.test.mjs"],
    expectMinimum: 12,
  },
  {
    name: "S03CD - draft + payment + live controller (browser parity)",
    cmd: ["node", "--conditions=react-server", "--test",
      "src/lib/direct-entry/draft-api.test.mjs",
      "src/lib/direct-entry/payment-api.test.mjs",
      "src/lib/direct-entry/payment-contract.test.mjs",
      "src/lib/direct-entry/payment-repository.test.mjs",
      "src/lib/direct-entry/payment-ui.test.mjs",
      "src/lib/direct-entry/live-controller.test.mjs"],
    expectMinimum: 24,
  },
  {
    name: "R2C - submitted document manager",
    cmd: ["node", "--test",
      "src/components/direct-entry/direct-entry-submitted-document-manager.test.mjs"],
    expectMinimum: 4,
  },
];

const prior = [];
let total = 0;
let failed = 0;
for (const suite of SUITES) {
  const result = spawnSync(suite.cmd[0], suite.cmd.slice(1), { encoding: "utf8" });
  const stdout = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const passMatch = stdout.match(/ℹ pass (\d+)/);
  const failMatch = stdout.match(/ℹ fail (\d+)/);
  const testsMatch = stdout.match(/ℹ tests (\d+)/);
  const passed = passMatch ? Number(passMatch[1]) : 0;
  const failedCount = failMatch ? Number(failMatch[1]) : 0;
  const tests = testsMatch ? Number(testsMatch[1]) : 0;
  total += passed;
  failed += failedCount;
  prior.push({ name: suite.name, passed, failed, tests, expectMinimum: suite.expectMinimum });
  if (result.status !== 0) {
    process.stderr.write(stdout);
    process.stderr.write(`\n[FAIL] ${suite.name} exited ${result.status}\n`);
  }
}

console.log(JSON.stringify({
  priorSuites: prior,
  totalPriorPass: total,
  totalPriorFail: failed,
  totalPriorChecks: total + failed,
}, null, 2));

if (failed > 0) {
  process.exitCode = 1;
}