/**
 * P3.1-HF-R3 - navigation + server page gate cho /reports/duplicate-cccd.
 *
 * Khoa: predicate nav va quyet dinh page DUNG authority cua RPC #74 (Full Admin triple |
 * catalog_master_manage | entry_privileged_edit, kem effective all scope); khong mo rong
 * quyen de lam link xuat hien; menu entry tro dung route.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  duplicateCccdReportNavPredicate,
  resolveNavCapabilityPredicate,
} from "../navigation/registry-capability.ts";
import { NAV_ENTRIES } from "../navigation/registry.ts";
import { decideDuplicateCccdReportPageAccess } from "./direct-entry-page-access.ts";

function actor(capabilities, scopes = [{ kind: "all", reference: "all" }]) {
  return {
    ok: true,
    actor: {
      auth_subject: "subject-fixture",
      app_user_id: "user-fixture",
      display_name: "Fixture",
      enabled: true,
      capabilities,
      scopes,
      self_recruiter_suggestion: null,
      session: { provider: "supabase", verification: "getUser", authenticated_at: null },
    },
  };
}

const FULL_ADMIN = ["entry_admin", "recruiter_master_manage", "team_master_manage"];

test("the nav predicate matches exactly the three RPC audiences at all scope", () => {
  const predicate = resolveNavCapabilityPredicate("duplicate_cccd_report");
  assert.equal(predicate, duplicateCccdReportNavPredicate);
  const all = [{ kind: "all", reference: "all" }];

  assert.equal(duplicateCccdReportNavPredicate({ capabilities: FULL_ADMIN, scopes: all }), true);
  assert.equal(duplicateCccdReportNavPredicate({ capabilities: ["catalog_master_manage"], scopes: all }), true);
  assert.equal(duplicateCccdReportNavPredicate({ capabilities: ["entry_privileged_edit"], scopes: all }), true);

  // entry_admin alone, change_review, leader/PM and actor without capability do not open it.
  for (const capabilities of [
    ["entry_admin"], ["change_review"], ["team_manager_assign"], [], ["pii_view"],
    ["entry_admin", "recruiter_master_manage"],
  ]) {
    assert.equal(duplicateCccdReportNavPredicate({ capabilities, scopes: all }), false,
      JSON.stringify(capabilities));
  }

  // Every audience needs an effective all scope.
  for (const scopes of [[], [{ kind: "own", reference: "own" }], [{ kind: "team", reference: "t" }]]) {
    assert.equal(duplicateCccdReportNavPredicate({ capabilities: FULL_ADMIN, scopes }), false);
    assert.equal(duplicateCccdReportNavPredicate({ capabilities: ["catalog_master_manage"], scopes }), false);
    assert.equal(duplicateCccdReportNavPredicate({ capabilities: ["entry_privileged_edit"], scopes }), false);
  }
});

test("the page gate allows the three audiences and denies everyone else", () => {
  assert.equal(decideDuplicateCccdReportPageAccess({ actor: actor(FULL_ADMIN) }), "ALLOW");
  assert.equal(decideDuplicateCccdReportPageAccess({ actor: actor(["catalog_master_manage"]) }), "ALLOW");
  assert.equal(decideDuplicateCccdReportPageAccess({ actor: actor(["entry_privileged_edit"]) }), "ALLOW");
  assert.equal(decideDuplicateCccdReportPageAccess({ actor: actor(["entry_admin"]) }), "ACCESS_DENIED");
  assert.equal(decideDuplicateCccdReportPageAccess({ actor: actor(["change_review"]) }), "ACCESS_DENIED");
  assert.equal(decideDuplicateCccdReportPageAccess({
    actor: actor(FULL_ADMIN, [{ kind: "team", reference: "t" }]) }), "ACCESS_DENIED");
});

test("missing/mapped-failure actor resolutions fail closed", () => {
  assert.equal(decideDuplicateCccdReportPageAccess({ actor: null }), "TEMPORARY_UNAVAILABLE");
  assert.equal(decideDuplicateCccdReportPageAccess({
    actor: { ok: false, reason: "UNAUTHENTICATED" } }), "REDIRECT_LOGIN");
  for (const reason of ["ACTOR_DISABLED", "ACTOR_MAPPING_MISSING"]) {
    assert.equal(decideDuplicateCccdReportPageAccess({ actor: { ok: false, reason } }),
      "ACCOUNT_UNAVAILABLE", reason);
  }
  assert.equal(decideDuplicateCccdReportPageAccess({
    actor: { ok: false, reason: "AMBIGUOUS_RECRUITER_LINK" } }), "TEMPORARY_UNAVAILABLE");
});

test("the registry exposes exactly one report menu entry", () => {
  const entries = NAV_ENTRIES.filter((entry) => entry.id === "duplicate-cccd-report");
  assert.equal(entries.length, 1);
  const [entry] = entries;
  assert.equal(entry.path, "/reports/duplicate-cccd");
  assert.equal(entry.capability, "duplicate_cccd_report");
  assert.equal(entry.status, "current");
  assert.equal(entry.visibility.desktop, true);
  assert.equal(entry.visibility.mobile, true);
});

test("the route/page boundary resolves the actor server-side and never widens the client", () => {
  const page = readFileSync(
    new URL("../../app/reports/duplicate-cccd/page.tsx", import.meta.url), "utf8");
  const layout = readFileSync(
    new URL("../../app/reports/layout.tsx", import.meta.url), "utf8");
  const route = readFileSync(
    new URL("../../app/api/direct-entry/duplicate-cccd-report/route.ts", import.meta.url), "utf8");
  const panel = readFileSync(
    new URL("../../components/reporting/duplicate-cccd-report-panel.tsx", import.meta.url), "utf8");

  assert.match(page, /resolveActorForRequest\(\)/);
  assert.match(page, /decideDuplicateCccdReportPageAccess/);
  assert.match(layout, /AppShell/);
  assert.match(route, /DIRECT_ENTRY_API_ENABLED/);
  assert.match(route, /createDuplicateCccdReportRepository/);

  // The UI never renders the routing key or the capability the RPC used.
  assert.doesNotMatch(panel, /project_id|authority/);
  assert.match(panel, /maskedCccd/);
});
