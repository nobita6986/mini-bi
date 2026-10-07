/**
 * P3-W07D - data-plane operation safety test (no Production access).
 *
 * Every case here is offline: apply mode must refuse before it opens any
 * connection, and check mode must stay strictly read-only. The script is only
 * ever executed WITHOUT a valid confirmation token.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

const SCRIPT = path.resolve("scripts/p3-w07d-historical-all-scope.mjs");
const TOKEN = "P3_W07D_HISTORICAL_ALL_SCOPE_APPLY";

function run(args, env = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, P3_W07D_CONFIRM: "", ...env },
  });
  assert.equal(result.error, undefined, String(result.error));
  return result;
}

test("W07D data plane: apply refuses without the confirmation token", () => {
  const result = run(["--apply"]);
  assert.equal(result.status, 0);
  assert.equal(result.stderr.includes("P3_W07D_DATA_PLANE_FAILED"), false,
    "a refusal must happen before any Production connection is attempted");
  const summary = JSON.parse(result.stdout);
  assert.deepEqual(summary, { mode: "apply", applied: false, reason: "CONFIRMATION_REQUIRED" });
});

test("W07D data plane: apply refuses a wrong or empty confirmation token", () => {
  for (const token of ["", "yes", "P3_W07D_HISTORICAL", TOKEN.toLowerCase()]) {
    const result = run(["--apply"], { P3_W07D_CONFIRM: token });
    assert.equal(result.status, 0);
    assert.equal(result.stderr.includes("P3_W07D_DATA_PLANE_FAILED"), false);
    assert.equal(JSON.parse(result.stdout).applied, false);
    assert.equal(JSON.parse(result.stdout).reason, "CONFIRMATION_REQUIRED");
  }
});

test("W07D data plane: only a single known mode flag is accepted", () => {
  for (const args of [[], ["--check", "--apply"], ["--watch"], ["--apply", "extra"]]) {
    const result = run(args);
    assert.equal(result.status, 1, "invalid arguments must fail: " + args.join(" "));
    assert.equal(result.stderr.includes("P3_W07D_DATA_PLANE_FAILED ARGUMENTS_INVALID"), true);
    assert.equal(result.stdout.trim(), "");
  }
});

test("W07D data plane: check mode is read-only by construction", async () => {
  const source = await readFile(SCRIPT, "utf8");
  const checkBody = source.slice(source.indexOf("async function runCheck"),
    source.indexOf("async function runApply"));
  assert.equal(checkBody.includes("await client.query(\"begin read only\")"), false,
    "the transaction guard lives in main(), not in runCheck");
  const mainBody = source.slice(source.indexOf("async function main"));
  assert.equal(mainBody.includes("await client.query(\"begin read only\")"), true);
  assert.equal(mainBody.includes("await client.query(\"rollback\")"), true);
  // No write statement may be reached from the check path.
  for (const statement of ["insert into", "update public", "delete from"]) {
    assert.equal(checkBody.toLowerCase().includes(statement), false,
      "check mode must not contain " + statement);
  }
  assert.equal(mainBody.includes("if (summary.applied === true) await client.query(\"commit\")"), true,
    "only an applied mutation may commit");
  assert.equal(mainBody.includes("await client.query(\"rollback\")"), true);
});

test("W07D data plane: apply guards are exact-one and audited", async () => {
  const source = await readFile(SCRIPT, "utf8");
  const applyBody = source.slice(source.indexOf("async function runApply"),
    source.indexOf("async function main"));
  assert.equal(applyBody.includes('process.env.P3_W07D_CONFIRM !== APPLY_CONFIRM_TOKEN'), true);
  assert.equal(applyBody.includes("if (accounts.length !== 1 || enabledCount !== 1)"), true);
  assert.equal(applyBody.includes("reason: \"ACCOUNT_NOT_UNIQUE_ENABLED\""), true);
  assert.equal(applyBody.includes("if (open.rows.length !== 1)"), true);
  assert.equal(applyBody.includes("reason: \"ALL_GRANT_NOT_UNIQUE_OPEN\""), true);
  assert.equal(applyBody.includes("reason: \"ALREADY_EFFECTIVE\""), true,
    "a re-run must be idempotent instead of re-dating an already effective grant");
  assert.equal(applyBody.includes("insert into public.direct_entry_audit_events"), true);
  assert.equal(applyBody.includes('scope_kind, outcome'), true);
  assert.equal(/console\.log\(\s*accounts/.test(source), false,
    "no account row may be printed");
  assert.equal(source.includes("console.log(JSON.stringify"), true);
});
