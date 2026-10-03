#!/usr/bin/env node
/**
 * P3-W03-S01C - Replay prior browser-acceptance checks without
 * DB / Supabase Auth / R2 / dev-server access.
 *
 * Suites touched by the S01A + S01B change:
 *   - S01B login UI source-guard (auth-ui helpers + login form/gate/control + page)
 *   - S01A auth-session server (auth-session-core + supabase cookie adapter)
 *   - Pilot access + Basic Auth proxy + Direct Entry session bootstrap
 *   - AppShell + navigation registry + dashboard/pipeline-check layouts
 *   - Direct Entry session routes + W02 authority
 *
 * Each suite is an existing `node:test` file in the repo. We re-run them
 * with the same commands so the handoff can quote the prior-check coverage.
 */
import { spawnSync } from "node:child_process";

const SUITES = [
  {
    name: "S01B login UI source-guard (form/gate/control/page + auth-ui helpers)",
    cmd: ["node", "--test",
      "src/components/auth/login.test.mjs",
      "src/lib/auth/auth-ui.test.mjs"],
    expectMinimum: 8,
  },
  {
    name: "S01A auth-session server + Basic Auth proxy + Direct Entry session bootstrap",
    cmd: ["node", "--conditions=react-server", "--test",
      "src/lib/auth/auth-session-core.test.mjs",
      "src/lib/auth/supabase-cookie-adapter.test.mjs",
      "src/lib/auth/pilot-access.test.mjs",
      "src/proxy.test.mjs",
      "src/app/api/direct-entry/session/route.test.mjs",
      "src/lib/direct-entry/session-bootstrap.test.mjs",
      "src/lib/auth/direct-entry-v2.test.mjs"],
    expectMinimum: 55,
  },
  {
    name: "AppShell + navigation registry + dashboard/pipeline-check layouts",
    cmd: ["node", "--test",
      "src/lib/navigation/registry.test.mjs",
      "src/components/app-shell/app-shell.test.mjs",
      "src/app/direct-entry/layout.test.mjs",
      "src/app/pipeline-check/layout.test.mjs"],
    expectMinimum: 50,
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