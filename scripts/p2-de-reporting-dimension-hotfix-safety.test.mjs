/**
 * P2 Direct Entry reporting dimension hotfix - data-plane safety test (offline).
 *
 * Nothing here touches a database: apply mode must refuse before it opens any
 * connection, and check/dry-run must stay non-committing by construction. The
 * script is only ever executed WITHOUT a valid confirmation token.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

const SCRIPT = path.resolve("scripts/p2-de-reporting-dimension-hotfix-repair.mjs");
const MODULE = path.resolve("scripts/lib/p2-de-reporting-dimension-repair.mjs");
const TOKEN = "P2_DE_DIM_REPAIR_APPLY";

function run(args, env = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, P2_DE_DIM_REPAIR_CONFIRM: "", ...env },
  });
  assert.equal(result.error, undefined, String(result.error));
  return result;
}

test("P2-DE-dim repair: apply refuses without the confirmation token", () => {
  const result = run(["--apply"]);
  assert.equal(result.status, 0);
  assert.equal(result.stderr.includes("P2_DE_DIM_REPAIR_FAILED"), false,
    "a refusal must happen before any Production connection is attempted");
  assert.deepEqual(JSON.parse(result.stdout), {
    mode: "apply", applied: false, reason: "CONFIRMATION_REQUIRED",
  });
});

test("P2-DE-dim repair: apply refuses a wrong or empty token", () => {
  for (const token of ["", "yes", "P2_DE_DIM_REPAIR", TOKEN.toLowerCase()]) {
    const result = run(["--apply"], { P2_DE_DIM_REPAIR_CONFIRM: token });
    assert.equal(result.status, 0);
    assert.equal(result.stderr.includes("P2_DE_DIM_REPAIR_FAILED"), false);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.applied, false);
    assert.equal(payload.reason, "CONFIRMATION_REQUIRED");
  }
});

test("P2-DE-dim repair: exactly one mode flag is accepted", () => {
  for (const args of [[], ["--check", "--apply"], ["--watch"], ["--apply", "extra"]]) {
    const result = run(args);
    assert.equal(result.status, 1, "invalid arguments must fail: " + args.join(" "));
    assert.equal(result.stderr.includes("P2_DE_DIM_REPAIR_FAILED ARGUMENTS_INVALID"), true);
    assert.equal(result.stdout.trim(), "");
  }
});

test("P2-DE-dim repair: check and dry-run never commit", async () => {
  const source = await readFile(SCRIPT, "utf8");
  assert.equal(source.includes("await client.query(\"begin read only\")"), true);
  assert.equal(source.includes("DRY_RUN_ROLLED_BACK"), true);
  assert.equal(source.includes("ROLLBACK\""), false);
  // A commit may only be reached through the acceptance gate.
  const commitAt = source.indexOf("await client.query(\"commit\")");
  const acceptanceAt = source.indexOf("if (!result.ok)");
  assert.ok(acceptanceAt > 0 && commitAt > acceptanceAt,
    "commit must be guarded by the in-transaction acceptance check");
  assert.equal(source.includes("REFUSED_ROWS_PRESENT"), true,
    "a single refused row must block the whole apply");
});

test("P2-DE-dim repair: the plan is evidence-only and never guesses a code", async () => {
  const moduleSource = await readFile(MODULE, "utf8");
  assert.equal(moduleSource.includes("recruiters.personnel_code"), true);
  assert.equal(moduleSource.includes("recruiter_provider_memberships.vendor_id"), true);
  assert.equal(moduleSource.includes("REPORTING_KEY_PATTERN"), true);
  // No literal business code may be baked into the executable logic (comments may
  // illustrate the shape of a code).
  const logic = moduleSource
    .split("\n")
    .filter((line) => !/^\s*(\*|\/\*|\/\/)/.test(line))
    .join("\n");
  for (const code of ["tu.vd", "thinhvuong.vd", "anhhn.td", "dhr.vd", "hainq.td", "nhieunt.td", "hao.vd"]) {
    assert.equal(logic.includes(code), false, "the module must not hardcode " + code);
  }
});
