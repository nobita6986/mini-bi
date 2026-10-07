import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildMemberContributions,
  resolveDashboardAudience,
  resolveDashboardAudienceKind,
  resolveScopedDashboardView,
} from "./p3-w06c-audience-view.ts";

const ALL = { kind: "all", label: "Toàn công ty" };
const TEAM = { kind: "team", label: "Nhóm Alpha" };
const OWN = { kind: "own", label: "Nguyễn Văn A" };

test("W06C audience kind: all / team / own map straight through", () => {
  assert.equal(resolveDashboardAudienceKind(ALL), "all");
  assert.equal(resolveDashboardAudienceKind(TEAM), "team");
  assert.equal(resolveDashboardAudienceKind(OWN), "own");
});

test("W06C audience kind: missing or unknown audience fails closed to own", () => {
  assert.equal(resolveDashboardAudienceKind(null), "own");
  assert.equal(resolveDashboardAudienceKind(undefined), "own");
  assert.equal(resolveDashboardAudienceKind({ kind: "admin", label: "x" }), "own");
  assert.deepEqual(resolveDashboardAudience(null), { kind: "own", label: "Cá nhân" });
});

test("W06C team view: team-scoped copy, member ranking and recruiter filter", () => {
  const view = resolveScopedDashboardView(TEAM);
  assert.equal(view.kind, "team");
  assert.equal(view.scopeLabel, "Nhóm Alpha");
  assert.ok(view.eyebrow.includes("Trưởng nhóm"));
  assert.ok(view.title.includes("Nhóm Alpha"), "team title must name the DB scope label");
  assert.ok(view.scopeNote.includes("Nhóm Alpha"), "scope note must name the DB scope label");
  assert.ok(view.emptyTitle.includes("Nhóm"));
  assert.equal(view.showMemberRanking, true);
  assert.equal(view.showProjectProviderMix, true);
  assert.equal(view.showRecruiterFilter, true);
});

test("W06C own view: personal copy, no member ranking and no recruiter filter", () => {
  const view = resolveScopedDashboardView(OWN);
  assert.equal(view.kind, "own");
  assert.equal(view.scopeLabel, "Nguyễn Văn A");
  assert.ok(view.eyebrow.includes("Cá nhân"));
  assert.ok(view.scopeNote.includes("Nguyễn Văn A"), "scope note must name the DB scope label");
  assert.ok(view.emptyTitle.includes("Bạn"));
  assert.equal(view.showMemberRanking, false);
  assert.equal(view.showProjectProviderMix, false);
  assert.equal(view.showRecruiterFilter, false);
});

test("W06C own view: a null audience renders the personal view, never the BoD copy", () => {
  const view = resolveScopedDashboardView(null);
  assert.equal(view.kind, "own");
  assert.equal(view.scopeLabel, "Cá nhân");
  assert.ok(!view.eyebrow.includes("BoD"));
  assert.ok(!view.title.includes("Tổng quan tuyển dụng"));
});

test("W06C member contributions: descending by count with share of the team total", () => {
  const rows = buildMemberContributions({
    a: { key: "a", display: "An", recruitedCount: 3 },
    b: { key: "b", display: "Bình", recruitedCount: 5 },
    c: { key: "c", display: "Cường", recruitedCount: 2 },
  });
  assert.deepEqual(rows.map((r) => r.display), ["Bình", "An", "Cường"]);
  assert.equal(rows[0].count, 5);
  assert.equal(Math.round(rows[0].share * 100), 50);
  assert.equal(Math.round(rows[1].share * 100), 30);
  assert.equal(rows.reduce((a, r) => a + r.count, 0), 10);
});

test("W06C member contributions: empty buckets produce no rows and no null share", () => {
  assert.deepEqual(buildMemberContributions({}), []);
});
