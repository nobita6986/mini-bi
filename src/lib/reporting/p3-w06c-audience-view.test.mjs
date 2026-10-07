import assert from "node:assert/strict";
import { test } from "node:test";

import { audienceTeamScopeCount, resolveAudienceScopeLabel } from "./p3-w05a-audience.ts";
import {
  buildMemberContributions,
  resolveDashboardAudienceKind,
  resolveDashboardMode,
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

test("W06C audience kind: missing or unknown audience stays unresolved", () => {
  assert.equal(resolveDashboardAudienceKind(null), null);
  assert.equal(resolveDashboardAudienceKind(undefined), null);
  assert.equal(resolveDashboardAudienceKind({ kind: "admin", label: "x" }), null);
});

test("W06C mode: a successful read without a usable audience is an error, not a scoped dashboard", () => {
  const mode = resolveDashboardMode({ ok: true, audience: null });
  assert.deepEqual(mode, { kind: "error" });
  assert.equal("view" in mode, false, "an unresolved audience must carry no scoped view");
  assert.deepEqual(
    resolveDashboardMode({ ok: true, audience: { kind: "admin", label: "x" } }),
    { kind: "error" },
  );
});

test("W06C mode: a failed read is an error even when an audience is supplied", () => {
  assert.deepEqual(resolveDashboardMode({ ok: false, audience: TEAM }), { kind: "error" });
  assert.deepEqual(resolveDashboardMode({ ok: false, audience: null }), { kind: "error" });
});

test("W06C mode: DB-confirmed audiences select the matching dashboard", () => {
  assert.deepEqual(resolveDashboardMode({ ok: true, audience: ALL }), { kind: "all" });
  const team = resolveDashboardMode({ ok: true, audience: TEAM });
  assert.equal(team.kind, "team");
  const own = resolveDashboardMode({ ok: true, audience: OWN });
  assert.equal(own.kind, "own");
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

test("W06C team label stays inclusive when several teams are in scope", () => {
  assert.equal(resolveAudienceScopeLabel(TEAM, 1), "Nhóm Alpha");
  assert.equal(resolveAudienceScopeLabel(TEAM, 0), "Nhóm Alpha");
  assert.equal(resolveAudienceScopeLabel(TEAM, 3), "Nhóm Alpha và 2 nhóm khác");
  assert.equal(resolveAudienceScopeLabel(ALL, 5), "Toàn công ty");
  assert.equal(resolveAudienceScopeLabel(OWN, 5), "Nguyễn Văn A");
});

test("W06C: a multi-team scope is never rendered as one named team", () => {
  const label = resolveAudienceScopeLabel(TEAM, 2);
  const view = resolveScopedDashboardView({ kind: "team", label });
  assert.ok(view.title.includes("1 nhóm khác"), "title must stay inclusive");
  assert.ok(view.scopeNote.includes("1 nhóm khác"), "scope note must stay inclusive");
});

test("W06C team scope count derives only a count from the raw audience payload", () => {
  assert.equal(audienceTeamScopeCount({ audience: "team", team_ids: ["a", "b"] }), 2);
  assert.equal(audienceTeamScopeCount({ audience: "all", team_ids: [] }), 0);
  assert.equal(audienceTeamScopeCount({ audience: "team" }), 0);
  assert.equal(audienceTeamScopeCount(null), 0);
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

test("W06C member contributions: empty buckets produce no rows", () => {
  assert.deepEqual(buildMemberContributions({}), []);
});
