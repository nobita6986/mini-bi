import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ACCOUNTING_ADDITION,
  APPLY_CONFIRM_ENV,
  APPLY_CONFIRM_TOKEN,
  FORBIDDEN_CAPABILITIES,
  REQUIRED_SCOPE,
  REVIEWER_BUNDLE,
  assertApplyConfirmed,
  planBundle,
} from "./p2-5-accounting-project-admin-provision.mjs";

const source = readFileSync(
  new URL("./p2-5-accounting-project-admin-provision.mjs", import.meta.url), "utf8");

function state(capabilities, scopeKinds = [REQUIRED_SCOPE]) {
  return { capabilities, scopeKinds };
}

test("Accounting bundle = reviewer bundle + entry_admin, all scope", () => {
  assert.deepEqual([...REVIEWER_BUNDLE], ["change_review", "pii_view", "payment_view"]);
  assert.deepEqual([...ACCOUNTING_ADDITION], ["entry_admin"]);
  assert.equal(REQUIRED_SCOPE, "all");
  // Khong cap cac capability nguy hiem.
  for (const capability of ["payment_edit", "employment_status.apply",
    "entry_privileged_edit", "document_view", "document_upload", "pii_export"]) {
    assert.ok(FORBIDDEN_CAPABILITIES.includes(capability), capability);
    assert.equal(ACCOUNTING_ADDITION.includes(capability), false);
  }
});

test("reviewer bundle + all, thieu entry_admin => chi cap entry_admin", () => {
  const plan = planBundle(state(["change_review", "pii_view", "payment_view"]));
  assert.equal(plan.ok, true);
  assert.equal(plan.code, "GRANT_REQUIRED");
  assert.deepEqual(plan.missingCapabilities, ["entry_admin"]);
});

test("idempotent: da co entry_admin => ALREADY_GRANTED, khong cap lai", () => {
  const plan = planBundle(state(["change_review", "pii_view", "payment_view", "entry_admin"]));
  assert.equal(plan.ok, true);
  assert.equal(plan.code, "ALREADY_GRANTED");
  assert.deepEqual(plan.missingCapabilities, []);
});

test("fail-closed: thieu reviewer bundle thi KHONG cap entry_admin", () => {
  for (const missing of REVIEWER_BUNDLE) {
    const capabilities = REVIEWER_BUNDLE.filter((capability) => capability !== missing);
    const plan = planBundle(state(capabilities));
    assert.equal(plan.ok, false, "thieu " + missing);
    assert.equal(plan.code, "REVIEWER_BUNDLE_INCOMPLETE");
    assert.equal("missingCapabilities" in plan, false, "khong duoc cap entry_admin");
  }
});

test("fail-closed: thieu all scope thi khong cap", () => {
  const plan = planBundle(state(["change_review", "pii_view", "payment_view"], ["team"]));
  assert.equal(plan.ok, false);
  assert.equal(plan.code, "ALL_SCOPE_REQUIRED");
});

test("target khong ton tai => TARGET_NOT_FOUND", () => {
  assert.deepEqual(planBundle(null), { ok: false, code: "TARGET_NOT_FOUND" });
});

test("bao cao capability bi cam neu tai khoan dang co", () => {
  const plan = planBundle(state(["change_review", "pii_view", "payment_view", "payment_edit"]));
  assert.deepEqual(plan.forbidden, ["payment_edit"]);
  assert.deepEqual(plan.missingCapabilities, ["entry_admin"]);
});

test("--apply bat buoc token truoc khi ket noi; --check thi khong", () => {
  assert.doesNotThrow(() => assertApplyConfirmed({ apply: false }, {}));
  assert.throws(() => assertApplyConfirmed({ apply: true }, {}), /APPLY_CONFIRMATION_REQUIRED/);
  assert.throws(() => assertApplyConfirmed({ apply: true }, { [APPLY_CONFIRM_ENV]: "sai" }),
    /APPLY_CONFIRMATION_REQUIRED/);
  assert.doesNotThrow(() => assertApplyConfirmed({ apply: true },
    { [APPLY_CONFIRM_ENV]: APPLY_CONFIRM_TOKEN }));
});

test("token duoc kiem tra truoc khi load config / mo ket noi", () => {
  const guardIndex = source.indexOf("assertApplyConfirmed(options, env)");
  const connectIndex = source.indexOf("await client.connect()");
  const configIndex = source.indexOf("await loadSupabaseConfig()");
  assert.ok(guardIndex !== -1 && connectIndex !== -1 && configIndex !== -1);
  assert.ok(guardIndex < configIndex, "token truoc loadSupabaseConfig");
  assert.ok(guardIndex < connectIndex, "token truoc client.connect");
});

test("khong hardcode email/tai khoan trong product authorization", () => {
  const code = source.split("\n").filter((line) => !/^\s*\*/.test(line)).join("\n");
  for (const account of ["ngattt", "lienvu", "@hrpartner.vn"]) {
    assert.equal(code.includes(account), false, "khong duoc hardcode " + account);
  }
});
