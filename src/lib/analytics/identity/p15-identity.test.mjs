import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";

import {
  buildTeamCoverage,
  projectIdentity,
  resolveIdentityFacts,
  resolveRefForDisplay,
  validateIdentityFacts,
  validateMembershipCatalog,
} from "./projection.ts";
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
const projectCase = (c) => unwrap(projectIdentity(catalogFor(c), c.facts), c.case_id);
const F = (date, key, provider, count) => ({ business_date: date, recruiter_key: key, provider_type_key: provider, recruited_count: count });

/** Fail-closed: projection chỉ hợp lệ khi input hợp lệ; nếu không phải là lỗi test. */
function unwrap(result, label) {
  assert.ok(result.ok, label + " input phải hợp lệ: " + (result.ok ? "" : result.code + " " + result.message + " @" + result.path));
  return result.projection;
}

/** Catalog nền + mutation (deep clone) để test fail-closed. */
function mutated(mutate) {
  const catalog = JSON.parse(JSON.stringify(baseCatalog));
  mutate(catalog);
  return catalog;
}

function expectCatalogFailure(catalog, code, path) {
  const res = projectIdentity(catalog, [F("2026-10-15", "rec-alpha", "vendor", 1)]);
  assert.equal(res.ok, false, code + " phải fail-closed");
  assert.equal(res.code, code);
  assert.equal(res.path, path);
  // Không bao giờ trả projection "thành công" hay tổng 0 giả.
  assert.equal(res.projection, undefined);
}

function expectFactsFailure(facts, code, path) {
  const res = projectIdentity(catalogFor(caseById("c01")), facts);
  assert.equal(res.ok, false, code + " phải fail-closed");
  assert.equal(res.code, code);
  assert.equal(res.path, path);
  assert.equal(res.projection, undefined);
}

test("W02 golden: 15 case gốc + c16 (R1) và mỗi case khớp expected đã ghi", () => {
  const cases = loadCases();
  assert.equal(cases.length, 16);
  assert.deepEqual(cases.map((c) => c.case_id), ["c01","c02","c03","c04","c05","c06","c07","c08","c09","c10","c11","c12","c13","c14","c15","c16"]);
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
  const reversed = unwrap(projectIdentity(catalogFor(c01), [...c01.facts].reverse()), "c01-reversed");
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
  const proj = unwrap(projectIdentity(catalog, [F("2026-10-15", "  REC-ALPHA ", "vendor", 5)]), "normalized-key");
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
  const proj = unwrap(
    projectIdentity(catalog, [F("2026-10-15", "__unknown__", "__unknown__", 3), F("2026-10-15", "__invalid__", "__invalid__", 2)]),
    "sentinel"
  );
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
  const proj = unwrap(projectIdentity(catalog, c01.facts), "c01");
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

test("R1 redaction: availability ambiguous ⇒ mọi packet-facing team_ref = null, ref_map.teams rỗng", () => {
  const c12 = projectCase(caseById("c12"));
  assert.equal(c12.team_mapping.availability, "ambiguous");
  assert.equal(c12.team_mapping.teams_in_scope, 0);
  assert.equal(c12.facts.length, 2);
  // Có fact riêng lẻ resolve được team_001 nhưng VẪN bị redact.
  assert.ok(c12.facts.some((f) => f.classification === "mapped"), "c12 phải có fact mapped riêng lẻ");
  assert.ok(c12.facts.every((f) => f.team_ref === null), "mọi fact phải có team_ref = null");
  assert.deepEqual(c12.ref_map.teams, []);
  // Recruiter ref vẫn giữ khi recruiter identity không mơ hồ.
  assert.deepEqual(c12.ref_map.recruiters.map((r) => r.ref), ["recruiter_01"]);
  assert.equal(c12.facts.find((f) => f.classification === "mapped").recruiter_ref, "recruiter_01");
  // Stable team id chỉ còn ở ops-only diagnostics.
  assert.equal(c12.server_diagnostics.ambiguous_blocked, true);
  assert.deepEqual(c12.server_diagnostics.observed_team_ids, ["team_002"]);
  const packetFacing = JSON.stringify({ facts: c12.facts, team_mapping: c12.team_mapping, ref_map: c12.ref_map });
  assert.ok(!/team_[0-9]/.test(packetFacing), "không được lộ team ref");
  assert.ok(!packetFacing.includes("team_002"), "không được lộ stable team id");
});

test("R1 redaction: không dựng được team subject/driver từ projection mơ hồ", () => {
  const proj = projectCase(caseById("c12"));
  const packet = packetFromCoverage(proj.team_mapping);
  assert.deepEqual(packet.subjects.map((s) => s.kind), ["project"]);
  assert.deepEqual(packet.drivers.team, []);
  assert.equal(packet.concentration.team.distinct_subjects, 0);
  const res = validateAnalysisPacket(packet);
  assert.ok(res.ok, res.ok ? "" : res.code + " " + res.message);
  // Bất biến toàn cục: mọi case ambiguous đều không phát team ref nào.
  for (const c of loadCases()) {
    const p = projectCase(c);
    if (p.team_mapping.availability !== "ambiguous") continue;
    assert.deepEqual(p.ref_map.teams, [], c.case_id + " ref_map.teams");
    assert.ok(p.facts.every((f) => f.team_ref === null), c.case_id + " team_ref");
    assert.equal(p.server_diagnostics.ambiguous_blocked, true, c.case_id + " ambiguous_blocked");
  }
});

test("R1 redaction: case không ambiguous KHÔNG bị redact (không nới rộng quá mức)", () => {
  const c01 = projectCase(caseById("c01"));
  assert.equal(c01.team_mapping.availability, "available");
  assert.equal(c01.server_diagnostics.ambiguous_blocked, false);
  assert.ok(c01.facts.every((f) => f.team_ref !== null));
  assert.ok(c01.ref_map.teams.length > 0);
});

test("R1 alias: bỏ cờ active — hiệu lực chỉ theo interval [valid_from, valid_to)", () => {
  for (const row of baseCatalog.aliases) {
    assert.ok(!("active" in row), "alias " + row.alias_id + " không được có active");
    assert.ok(row.valid_from, "alias valid_from");
  }
  for (const c of loadCases()) {
    for (const row of c.catalog_extends?.aliases ?? []) {
      assert.ok(!("active" in row), c.case_id + " alias extend không được có active");
    }
  }
  // Alias đóng interval tại 2026-06-30: fact trước đó vẫn map, đúng boundary thì không.
  const c15 = projectCase(caseById("c15"));
  assert.deepEqual(c15.facts.map((f) => [f.business_date, f.classification]), [["2026-06-29", "mapped"], ["2026-06-30", "unmapped"]]);
  assert.equal(c15.facts[0].team_ref, "team_01");
  assert.equal(c15.facts[1].team_ref, null);
  // Đóng interval KHÔNG viết lại lịch sử: thêm bản ghi mới cùng key sau đó không đổi fact cũ.
  const catalog = catalogFor(caseById("c15"));
  const reopened = JSON.parse(JSON.stringify(catalog));
  reopened.aliases.push({ alias_id: "alias_900", recruiter_id: "rcr_005", reporting_key: "rec-delta", valid_from: "2026-07-01", valid_to: null });
  assert.deepEqual(unwrap(projectIdentity(reopened, [F("2026-06-29", "rec-delta", "hrp", 1)]), "alias-reopen").facts[0], c15.facts[0]);
});

test("R1 hiệu lực hiện tại không chi phối lịch sử: recruiter/team inactive vẫn map fact cũ", () => {
  assert.equal(baseCatalog.recruiters.find((r) => r.recruiter_id === "rcr_004").active, false);
  const c15 = projectCase(caseById("c15"));
  assert.equal(c15.facts[0].classification, "mapped");
  assert.equal(c15.facts[0].recruiter_ref, "recruiter_01");
  assert.equal(baseCatalog.teams.find((t) => t.team_id === "team_004").active, false);
  const c16 = projectCase(caseById("c16"));
  assert.equal(c16.facts[0].classification, "mapped");
  assert.equal(c16.facts[0].team_ref, "team_01");
  assert.equal(c16.team_mapping.teams_in_scope, 1);
});

test("R1 fail-closed: catalog sai ⇒ lỗi rõ ràng, không trả projection/tổng 0", () => {
  assert.deepEqual(validateMembershipCatalog(baseCatalog), { ok: true });
  expectCatalogFailure(mutated((c) => { c.aliases[0].alias_id = "  "; }), "CATALOG_ID_EMPTY", "aliases[0].alias_id");
  expectCatalogFailure(mutated((c) => { c.recruiters[1].recruiter_id = "rcr_001"; }), "CATALOG_ID_DUPLICATE", "recruiters[1].recruiter_id");
  expectCatalogFailure(mutated((c) => { c.teams[1].team_id = "team_001"; }), "CATALOG_ID_DUPLICATE", "teams[1].team_id");
  expectCatalogFailure(mutated((c) => { c.aliases[0].recruiter_id = "rcr_999"; }), "CATALOG_DANGLING_RECRUITER", "aliases[0].recruiter_id");
  expectCatalogFailure(mutated((c) => { c.team_memberships[0].team_id = "team_999"; }), "CATALOG_DANGLING_TEAM", "team_memberships[0].team_id");
  expectCatalogFailure(mutated((c) => { c.provider_memberships[0].recruiter_id = "rcr_999"; }), "CATALOG_DANGLING_RECRUITER", "provider_memberships[0].recruiter_id");
  expectCatalogFailure(mutated((c) => { c.team_memberships[0].membership_id = "tm_001"; c.team_memberships[0].recruiter_id = "rcr_009"; }), "CATALOG_DANGLING_RECRUITER", "team_memberships[0].recruiter_id");
  expectCatalogFailure(mutated((c) => { c.aliases[0].valid_from = "2026-02-30"; }), "CATALOG_INVALID_INTERVAL", "aliases[0].valid_to");
  expectCatalogFailure(mutated((c) => { c.aliases[0].valid_to = "2026-01-01"; }), "CATALOG_INVALID_INTERVAL", "aliases[0].valid_to");
  expectCatalogFailure(mutated((c) => { c.team_memberships[0].valid_to = "2025-12-31"; }), "CATALOG_INVALID_INTERVAL", "team_memberships[0].valid_to");
  expectCatalogFailure(mutated((c) => { c.provider_memberships[0].valid_from = "not-a-date"; }), "CATALOG_INVALID_INTERVAL", "provider_memberships[0].valid_to");
  expectCatalogFailure(mutated((c) => { c.aliases[0].reporting_key = "  Rec-Alpha  "; }), "CATALOG_INVALID_REPORTING_KEY", "aliases[0].reporting_key");
  expectCatalogFailure(mutated((c) => { c.aliases[0].reporting_key = "__unknown__"; }), "CATALOG_INVALID_REPORTING_KEY", "aliases[0].reporting_key");
  expectCatalogFailure(mutated((c) => { c.provider_memberships[0].provider_type = "freelancer"; }), "CATALOG_INVALID_PROVIDER_TYPE", "provider_memberships[0].provider_type");
  expectCatalogFailure(mutated((c) => { c.recruiters[0].active = "yes"; }), "CATALOG_INVALID_FLAG", "recruiters[0].active");
  expectCatalogFailure(mutated((c) => { c.audit[0].entity = "widget"; }), "CATALOG_INVALID_AUDIT", "audit[0].entity");
  expectCatalogFailure(mutated((c) => { c.audit[1].change_id = "aud_001"; }), "CATALOG_INVALID_AUDIT", "audit[1].change_id");
  expectCatalogFailure(mutated((c) => { c.audit[0].effective_date = "2026-13-01"; }), "CATALOG_INVALID_DATE", "audit[0].effective_date");
  expectCatalogFailure({}, "CATALOG_NOT_OBJECT", "catalog");
  assert.deepEqual(validateIdentityFacts([]), { ok: true });
  expectFactsFailure(null, "FACT_INVALID_DATE", "facts");
});

test("R1 fail-closed: fact sai ⇒ lỗi rõ ràng; sentinel key vẫn là dữ liệu hợp lệ", () => {
  const formatter = (row) => validateIdentityFacts([row]);
  assert.deepEqual(formatter(F("2026-10-15", "rec-alpha", "vendor", 3)), { ok: true });
  assert.deepEqual(formatter(F("2026-10-15", "__unknown__", "__invalid__", 0)), { ok: true });
  assert.equal(formatter(F("2026-02-30", "rec-alpha", "vendor", 3)).code, "FACT_INVALID_DATE");
  assert.equal(formatter(F("15/10/2026", "rec-alpha", "vendor", 3)).code, "FACT_INVALID_DATE");
  assert.equal(formatter(F("2026-10-15", "rec-alpha", "vendor", -1)).code, "FACT_INVALID_COUNT");
  assert.equal(formatter(F("2026-10-15", "rec-alpha", "vendor", 1.5)).code, "FACT_INVALID_COUNT");
  assert.equal(formatter(F("2026-10-15", "rec-alpha", "vendor", "3")).code, "FACT_INVALID_COUNT");
  assert.equal(formatter(F("2026-10-15", "rec-alpha", "freelancer", 3)).code, "FACT_INVALID_PROVIDER_KEY");
  assert.equal(formatter(F("2026-10-15", "rec-alpha", "__bogus__", 3)).code, "FACT_INVALID_PROVIDER_KEY");
  assert.equal(formatter(F("2026-10-15", null, "vendor", 3)).code, "FACT_INVALID_RECRUITER_KEY");
  expectFactsFailure([F("2026-10-15", "rec-alpha", "vendor", -1)], "FACT_INVALID_COUNT", "facts[0].recruited_count");
  expectFactsFailure([F("2026-10-15", "rec-alpha", "vendor", 1), F("bad", "rec-alpha", "vendor", 1)], "FACT_INVALID_DATE", "facts[1].business_date");
});

test("R1 overlap KHÔNG bị sửa âm thầm: shape hợp lệ nhưng vẫn ambiguous", () => {
  const c04 = caseById("c04");
  assert.deepEqual(validateMembershipCatalog(catalogFor(c04)), { ok: true });
  assert.equal(projectCase(c04).facts[0].classification, "ambiguous");
  const c05 = caseById("c05");
  assert.deepEqual(validateMembershipCatalog(catalogFor(c05)), { ok: true });
  assert.equal(projectCase(c05).facts[0].classification, "ambiguous");
  assert.equal(projectCase(c05).team_mapping.availability, "ambiguous");
  assert.deepEqual(projectCase(c05).ref_map.teams, []);
  assert.deepEqual(resolveIdentityFacts(catalogFor(c05), c05.facts)[0].reason_codes.includes("TEAM_MEMBERSHIP_AMBIGUOUS"), true);
});

test("R1 server_diagnostics: ops-only, không lộ display/PII và tách khỏi packet-facing", () => {
  for (const c of loadCases()) {
    const proj = projectCase(c);
    const diag = JSON.stringify(proj.server_diagnostics);
    assert.ok(!diag.includes("Recruiter "), c.case_id + " display");
    assert.ok(!/@/.test(diag), c.case_id + " email-like");
    assert.deepEqual(Object.keys(proj.server_diagnostics).sort(), ["ambiguous_blocked", "observed_team_ids"]);
    for (const id of proj.server_diagnostics.observed_team_ids) assert.match(id, /^team_[0-9]{3}$/);
  }
});
