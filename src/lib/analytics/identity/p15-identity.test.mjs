import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";

import { projectIdentity, resolveIdentityFacts, buildTeamCoverage, resolveRefForDisplay } from "./projection.ts";
import { validateAnalysisPacket } from "../contracts/analysis-packet.ts";
import { isWithinInterval, normalizeReportingKey } from "./identity-shared.mjs";

const IDENT_DIR = new URL("../../../../docs/contracts/fixtures/p1.5-identity/", import.meta.url);
const ANALYSIS_DIR = new URL("../../../../docs/contracts/fixtures/p1.5-analysis/", import.meta.url);
const readJson = (base, rel) => JSON.parse(readFileSync(new URL(rel, base), "utf8"));
const listJson = (base, dir) => readdirSync(new URL(dir, base)).filter((f) => f.endsWith(".json")).sort();

const baseCatalog = readJson(IDENT_DIR, "catalog.json");
const loadCases = () => listJson(IDENT_DIR, "cases/").map((f) => readJson(IDENT_DIR, "cases/" + f));
const caseById = (id) => loadCases().find((c) => c.case_id === id);

function catalogFor(c) {
  const catalog = JSON.parse(JSON.stringify(baseCatalog));
  if (c.catalog_extends) {
    for (const key of Object.keys(c.catalog_extends)) catalog[key] = catalog[key].concat(c.catalog_extends[key]);
  }
  return catalog;
}
const projectCase = (c) => projectIdentity(catalogFor(c), c.facts);
const F = (date, key, provider, count) => ({ business_date: date, recruiter_key: key, provider_type_key: provider, recruited_count: count });

test("W02 golden: 15 case và mỗi case khớp expected đã ghi", () => {
  const cases = loadCases();
  assert.equal(cases.length, 15);
  assert.deepEqual(cases.map((c) => c.case_id), ["c01","c02","c03","c04","c05","c06","c07","c08","c09","c10","c11","c12","c13","c14","c15"]);
  for (const c of cases) {
    assert.ok(c.title, c.case_id + " title");
    assert.ok(Array.isArray(c.facts), c.case_id + " facts");
    assert.ok(c.expected, c.case_id + " expected");
  }
});

test("W02 golden: coverage khớp expected và invariant tổng", () => {
  for (const c of loadCases()) {
    const proj = projectCase(c);
    const tm = proj.team_mapping;
    const e = c.expected;
    if (e.same_projection_as) continue;
    assert.equal(tm.availability, e.availability, c.case_id + " availability");
    assert.equal(tm.mapped_recruited_count, e.mapped_recruited_count, c.case_id + " mapped");
    assert.equal(tm.unmapped_recruited_count, e.unmapped_recruited_count, c.case_id + " unmapped");
    assert.equal(tm.ambiguous_recruited_count, e.ambiguous_recruited_count, c.case_id + " ambiguous");
    assert.deepEqual(tm.coverage_ratio, e.coverage_ratio, c.case_id + " coverage");
    assert.equal(tm.teams_in_scope, e.teams_in_scope, c.case_id + " teams_in_scope");
    assert.equal(tm.reason_code, e.reason_code, c.case_id + " reason");
    assert.deepEqual(proj.ref_map.recruiters.map((r) => r.ref), e.recruiter_refs, c.case_id + " recruiter refs");
    assert.deepEqual(proj.ref_map.teams.map((r) => r.ref), e.team_refs, c.case_id + " team refs");
    assert.deepEqual([...new Set(proj.quality_issues.map((q) => q.code))].sort(), [...e.quality_issue_codes].sort(), c.case_id + " quality codes");
    const counts = { mapped: 0, unmapped: 0, ambiguous: 0 };
    for (const f of proj.facts) counts[f.classification] += 1;
    assert.deepEqual(counts, e.classification_counts, c.case_id + " classification counts");
    const sum = tm.mapped_recruited_count + tm.unmapped_recruited_count + tm.ambiguous_recruited_count;
    assert.equal(sum, c.facts.reduce((a, f) => a + f.recruited_count, 0), c.case_id + " sum invariant");
    assert.equal(proj.totals.recruited_total, sum, c.case_id + " totals");
  }
});

test("W02 interval: nửa mở [valid_from, valid_to) — boundary chính xác", () => {
  assert.equal(isWithinInterval("2026-08-31", "2026-01-01", "2026-09-01"), true);
  assert.equal(isWithinInterval("2026-09-01", "2026-01-01", "2026-09-01"), false);
  assert.equal(isWithinInterval("2026-09-01", "2026-09-01", null), true);
  assert.equal(isWithinInterval("2026-08-31", "2026-09-01", null), false);
  assert.equal(isWithinInterval("2026-09-01", "2026-09-01", "2026-09-02"), true);
  assert.equal(isWithinInterval("bad-date", "2026-01-01", null), false);
  // transfer boundary qua fixture
  const c06 = projectCase(caseById("c06"));
  assert.deepEqual(c06.facts.map((f) => [f.business_date, f.team_ref]), [["2026-08-31", "team_01"], ["2026-09-01", "team_02"]]);
});

test("W02 missing/ambiguity: thiếu alias, thiếu team, overlap alias, overlap team", () => {
  const c02 = projectCase(caseById("c02"));
  assert.equal(c02.facts[0].classification, "unmapped");
  assert.equal(c02.facts[0].recruiter_ref, null);
  const c03 = projectCase(caseById("c03"));
  assert.equal(c03.facts[0].classification, "unmapped");
  assert.notEqual(c03.facts[0].recruiter_ref, null);
  assert.equal(c03.facts[0].team_ref, null);
  assert.equal(projectCase(caseById("c04")).facts[0].classification, "ambiguous");
  assert.equal(projectCase(caseById("c05")).facts[0].classification, "ambiguous");
});

test("W02 provider mismatch: fact KHÔNG bị overwrite, classification không đổi", () => {
  const c08 = projectCase(caseById("c08"));
  assert.equal(c08.facts[0].provider_type_key, "vendor");
  assert.equal(c08.facts[0].classification, "mapped");
  assert.ok(c08.quality_issues.some((q) => q.code === "PROVIDER_MISMATCH"));
  const c07 = projectCase(caseById("c07"));
  assert.ok(!c07.quality_issues.some((q) => q.code === "PROVIDER_MISMATCH"));
  const resolved = resolveIdentityFacts(catalogFor(caseById("c08")), caseById("c08").facts);
  assert.equal(resolved[0].provider_membership_type, "hrp");
  assert.equal(resolved[0].provider_mismatch, true);
});

test("W02 coverage: SUM recruited_count, không đếm row; available/partial phải có team subject", () => {
  const c10 = projectCase(caseById("c10"));
  assert.equal(c10.facts.length, 1);
  assert.equal(c10.team_mapping.mapped_recruited_count, 7);
  const c11 = projectCase(caseById("c11"));
  assert.equal(c11.team_mapping.availability, "partial");
  assert.ok(c11.team_mapping.teams_in_scope >= 1);
  assert.equal(c11.team_mapping.coverage_ratio, 5 / 7);
  const c12 = projectCase(caseById("c12"));
  assert.equal(c12.team_mapping.availability, "ambiguous");
  assert.equal(c12.team_mapping.teams_in_scope, 0);
  const c13 = projectCase(caseById("c13"));
  assert.equal(c13.team_mapping.coverage_ratio, null);
  assert.equal(c13.team_mapping.availability, "unavailable");
});

test("W02 refs: opaque ref deterministic và KHÔNG phụ thuộc thứ tự input", () => {
  const c01 = caseById("c01");
  const forward = projectCase(c01);
  const reversed = projectIdentity(catalogFor(c01), [...c01.facts].reverse());
  assert.deepEqual(reversed, forward);
  assert.deepEqual(forward.ref_map.recruiters.map((r) => r.ref), ["recruiter_01", "recruiter_02"]);
  assert.deepEqual(forward.ref_map.recruiters.map((r) => r.stable_id), ["rcr_001", "rcr_002"]);
  const c14 = projectCase(caseById("c14"));
  assert.deepEqual(c14, forward);
});

test("W02 refs: packet-facing KHÔNG chứa stable id/display/PII", () => {
  for (const c of loadCases()) {
    const proj = projectCase(c);
    const packetFacing = JSON.stringify({ facts: proj.facts, team_mapping: proj.team_mapping });
    assert.ok(!packetFacing.includes("rcr_"), c.case_id + " stable recruiter id");
    assert.ok(!packetFacing.includes("Recruiter "), c.case_id + " display");
    assert.ok(!packetFacing.includes("rec-alpha"), c.case_id + " reporting key");
    assert.ok(!/@/.test(packetFacing), c.case_id + " email-like");
    for (const f of proj.facts) {
      if (f.recruiter_ref !== null) assert.match(f.recruiter_ref, /^recruiter_[0-9]{2,}$/);
      if (f.team_ref !== null) assert.match(f.team_ref, /^team_[0-9]{2,}$/);
    }
  }
});

test("W02 audit: không PII, có version/actor/reason/effective date", () => {
  const audit = JSON.stringify(baseCatalog.audit);
  assert.ok(!/@/.test(audit));
  assert.ok(!/Recruiter |Team Alpha/.test(audit));
  for (const a of baseCatalog.audit) {
    assert.ok(a.change_id && Number.isInteger(a.version) && a.entity && a.ref, "audit shape");
    assert.ok(a.actor_ref && a.reason && /^\d{4}-\d{2}-\d{2}$/.test(a.effective_date), "audit fields");
    assert.ok(typeof a.after_revision_ref === "string", "after revision");
  }
});

test("W02 alias: resolve bằng exact normalized key, không dùng display", () => {
  assert.equal(normalizeReportingKey("  Rec-Alpha  "), "rec-alpha");
  assert.equal(normalizeReportingKey("REC-ALPHA"), "rec-alpha");
  assert.equal(normalizeReportingKey("  "), null);
  const catalog = catalogFor(caseById("c01"));
  // key khác casing/whitespace vẫn resolve cùng recruiter
  const proj = projectIdentity(catalog, [F("2026-10-15", "  REC-ALPHA ", "vendor", 5)]);
  assert.equal(proj.facts[0].classification, "mapped");
  // display KHÔNG bao giờ là identity: hai recruiter cùng display vẫn khác ref
  const c09 = projectCase(caseById("c09"));
  assert.deepEqual([...new Set(c09.facts.map((f) => f.recruiter_ref))].sort(), ["recruiter_01", "recruiter_02"]);
});

test("W02 retired membership: không viết lại fact quá khứ", () => {
  const c15 = projectCase(caseById("c15"));
  assert.deepEqual(c15.facts.map((f) => [f.business_date, f.classification]), [["2026-06-29", "mapped"], ["2026-06-30", "unmapped"]]);
  assert.equal(c15.facts[0].team_ref, "team_01");
});

test("W02 sentinel/unknown recruiter không tự gán team", () => {
  const catalog = catalogFor(caseById("c01"));
  const proj = projectIdentity(catalog, [F("2026-10-15", "__unknown__", "__unknown__", 3), F("2026-10-15", "__invalid__", "__invalid__", 2)]);
  for (const f of proj.facts) {
    assert.equal(f.classification, "unmapped");
    assert.equal(f.recruiter_ref, null);
    assert.equal(f.team_ref, null);
  }
  assert.equal(proj.team_mapping.availability, "unavailable");
  assert.ok(proj.quality_issues.every((q) => q.code === "RECRUITER_KEY_SENTINEL"));
});

/** Dựng packet analysis-packet/0.1 từ team_mapping projection để chứng minh tương thích. */
function packetFromCoverage(coverage) {
  const tpl = readJson(ANALYSIS_DIR, "cases/c01.json").packet;
  const packet = JSON.parse(JSON.stringify(tpl));
  const zero = { top1_ref: null, top1_share: null, top3_share: null, distinct_subjects: 0 };
  const total = coverage.mapped_recruited_count + coverage.unmapped_recruited_count + coverage.ambiguous_recruited_count;
  packet.totals = { current: total, comparable: null, delta: null, delta_pct: null };
  packet.period.comparable = null;
  packet.drivers = { project: [], recruiter: [], team: [], provider: [], employment: [] };
  packet.concentration = { project: { ...zero }, recruiter: { ...zero }, team: { ...zero }, provider: { ...zero }, employment: { ...zero } };
  packet.project_provider_mix = [];
  const teamSubjects = [];
  for (let i = 1; i <= coverage.teams_in_scope; i++) teamSubjects.push({ ref: "team_" + String(i).padStart(2, "0"), kind: "team", catalog_key: null });
  packet.subjects = [{ ref: "scope", kind: "project", catalog_key: null }].concat(teamSubjects);
  packet.team_mapping = { ...coverage };
  packet.evidence = [{
    evidence_id: "ev_01", metric: "recruited_total", formula: "sum(recruited_count)", formula_version: "v0.1",
    period_ref: packet.period.period_ref, scope_ref: packet.scope.scope_hash, subject_ref: "scope",
    value: total, unit: "people", sufficiency: "met", quality: "ok", snapshot_ref: packet.snapshot.hash,
  }];
  return packet;
}

test("W02 tương thích analysis-packet/0.1: team_mapping của mọi golden case validate được", () => {
  for (const c of loadCases()) {
    const proj = projectCase(c);
    const packet = packetFromCoverage(proj.team_mapping);
    const res = validateAnalysisPacket(packet);
    assert.ok(res.ok, c.case_id + " packet phải hợp lệ: " + (res.ok ? "" : res.code + " " + res.message));
  }
});

test("W02 tương thích: team_mapping sai (do projection cũ) vẫn bị validator chặn", () => {
  const proj = projectCase(caseById("c01"));
  const bad = packetFromCoverage(proj.team_mapping);
  bad.team_mapping.mapped_recruited_count += 1;
  const res = validateAnalysisPacket(bad);
  assert.equal(res.ok, false);
  assert.equal(res.code, "TEAM_MAPPING_INCONSISTENT");
});

test("W02 resolveRefForDisplay: chỉ resolve server-side, không nằm trong packet", () => {
  const c01 = caseById("c01");
  const catalog = catalogFor(c01);
  const proj = projectIdentity(catalog, c01.facts);
  const resolved = resolveRefForDisplay(proj.ref_map, catalog, "recruiter_01");
  assert.ok(resolved);
  assert.equal(resolved.stable_id, "rcr_001");
  assert.equal(resolved.display, "Recruiter Alpha");
  assert.equal(resolveRefForDisplay(proj.ref_map, catalog, "recruiter_99"), null);
});

test("W02 coverage: buildTeamCoverage là hàm thuần, không phụ thuộc input order", () => {
  const c11 = caseById("c11");
  const catalog = catalogFor(c11);
  const a = buildTeamCoverage(resolveIdentityFacts(catalog, c11.facts));
  const b = buildTeamCoverage(resolveIdentityFacts(catalog, [...c11.facts].reverse()));
  assert.deepEqual(a, b);
});
