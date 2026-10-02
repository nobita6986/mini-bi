import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";

import { validateAnalysisPacket } from "./analysis-packet.ts";
import { validateBusinessAnalysis } from "./business-analysis.ts";

const FIX = new URL("../../../../docs/contracts/fixtures/p1.5-analysis/", import.meta.url);
const readJson = (rel) => JSON.parse(readFileSync(new URL(rel, FIX), "utf8"));
const listJson = (dir) => readdirSync(new URL(dir, FIX)).filter((f) => f.endsWith(".json")).sort();
const loadCases = () => listJson("cases/").map((f) => readJson("cases/" + f));
const caseById = (id) => loadCases().find((c) => c.case_id === id);

/** Context cho validator output — dựng từ packet đã validate (thay cho import chéo). */
function contextFromPacket(packet) {
  return {
    periodRef: packet.period.period_ref,
    evidenceIds: packet.evidence.map((e) => e.evidence_id),
    subjectRefs: packet.subjects.map((s) => s.ref),
    evidence: packet.evidence.map((e) => ({ evidence_id: e.evidence_id, value: e.value, unit: e.unit })),
    insufficientKeys: packet.sufficiency.filter((s) => s.status === "not_met").map((s) => s.key),
  };
}
function contextForCase(id) {
  const c = caseById(id);
  const v = validateAnalysisPacket(c.packet);
  assert.ok(v.ok, "packet " + id + " phải hợp lệ: " + (v.ok ? "" : v.code));
  return contextFromPacket(v.value);
}

test("golden: có đủ 12 case và mỗi case có input + expected đầy đủ", () => {
  const cases = loadCases();
  assert.equal(cases.length, 12);
  const ids = cases.map((c) => c.case_id);
  assert.deepEqual(ids, ["c01", "c02", "c03", "c04", "c05", "c06", "c07", "c08", "c09", "c10", "c11", "c12"]);
  for (const c of cases) {
    assert.ok(c.title, "title " + c.case_id);
    assert.ok(c.packet, "packet " + c.case_id);
    assert.ok(c.expected && Array.isArray(c.expected.allowed_categories) && c.expected.allowed_categories.length > 0, "allowed_categories " + c.case_id);
    assert.ok(Array.isArray(c.expected.forbidden_claims) && c.expected.forbidden_claims.length > 0, "forbidden_claims " + c.case_id);
    assert.ok(c.expected.max_confidence, "max_confidence " + c.case_id);
    assert.ok(Array.isArray(c.expected.invariants) && c.expected.invariants.length > 0, "invariants " + c.case_id);
    assert.ok(c.allowed_analysis && c.forbidden_analysis, "analyses " + c.case_id);
    assert.ok(c.forbidden_expected_code, "forbidden_expected_code " + c.case_id);
  }
});

test("golden: mọi packet hợp lệ và sufficiency khớp kỳ vọng", () => {
  for (const c of loadCases()) {
    const v = validateAnalysisPacket(c.packet);
    assert.ok(v.ok, c.case_id + " packet phải hợp lệ: " + (v.ok ? "" : v.code + " " + v.message));
    const ctx = contextFromPacket(v.value);
    assert.deepEqual(ctx.insufficientKeys.slice().sort(), (c.expected.insufficient_keys || []).slice().sort(), c.case_id + " insufficient keys");
  }
});

test("golden: finding được phép PASS, finding bị cấm FAIL đúng reason code", () => {
  for (const c of loadCases()) {
    const ctx = contextForCase(c.case_id);
    const okRes = validateBusinessAnalysis(c.allowed_analysis, ctx);
    assert.ok(okRes.ok, c.case_id + " allowed phải PASS: " + (okRes.ok ? "" : okRes.code + " " + okRes.message));
    const badRes = validateBusinessAnalysis(c.forbidden_analysis, ctx);
    assert.equal(badRes.ok, false, c.case_id + " forbidden phải FAIL");
    assert.equal(badRes.code, c.forbidden_expected_code, c.case_id + " forbidden reason code");
  }
});

test("golden: evidence_ref trong allowed analysis đều tồn tại trong packet", () => {
  for (const c of loadCases()) {
    const v = validateAnalysisPacket(c.packet);
    assert.ok(v.ok);
    const ids = new Set(v.value.evidence.map((e) => e.evidence_id));
    for (const f of c.allowed_analysis.findings) {
      for (const r of f.evidence_refs) assert.ok(ids.has(r), c.case_id + " thiếu evidence " + r);
    }
  }
});

test("invalid packet: mọi case bị từ chối đúng reason code", () => {
  const files = listJson("invalid-packets/");
  assert.ok(files.length >= 12, "cần >=12 invalid packet, có " + files.length);
  for (const f of files) {
    const x = readJson("invalid-packets/" + f);
    const res = validateAnalysisPacket(x.packet);
    assert.equal(res.ok, false, f + " phải bị từ chối");
    assert.equal(res.code, x.expect_code, f + " reason code");
  }
});

test("invalid analysis: mọi case bị từ chối đúng reason code", () => {
  const files = listJson("invalid-analysis/");
  assert.ok(files.length >= 12, "cần >=12 invalid analysis, có " + files.length);
  const ctxCache = new Map();
  for (const f of files) {
    const x = readJson("invalid-analysis/" + f);
    if (!ctxCache.has(x.context_case)) ctxCache.set(x.context_case, contextForCase(x.context_case));
    const res = validateBusinessAnalysis(x.analysis, ctxCache.get(x.context_case));
    assert.equal(res.ok, false, f + " phải bị từ chối");
    assert.equal(res.code, x.expect_code, f + " reason code");
  }
});

test("valid examples: packet + output mẫu đều PASS", () => {
  const p = readJson("valid/analysis-packet-c01.json");
  const pv = validateAnalysisPacket(p.packet);
  assert.ok(pv.ok, pv.ok ? "" : pv.code);
  const a = readJson("valid/business-analysis-c01.json");
  const av = validateBusinessAnalysis(a.analysis, contextFromPacket(pv.value));
  assert.ok(av.ok, av.ok ? "" : av.code + " " + av.message);
});

test("strict: unknown field ở mọi cấp bị reject", () => {
  const c = caseById("c01");
  for (const mutate of [
    (p) => { p.extra = 1; },
    (p) => { p.period.extra = 1; },
    (p) => { p.evidence[0].extra = 1; },
    (p) => { p.project_provider_mix[0].extra = 1; },
    (p) => { p.sufficiency[0].extra = 1; },
  ]) {
    const packet = JSON.parse(JSON.stringify(c.packet));
    mutate(packet);
    assert.equal(validateAnalysisPacket(packet).code, "UNKNOWN_FIELD");
  }
});

test("strict: report_status chỉ nhận draft và findings tối đa 7", () => {
  const c = caseById("c01");
  const ctx = contextForCase("c01");
  const a = JSON.parse(JSON.stringify(c.allowed_analysis));
  a.report_status = "published";
  assert.equal(validateBusinessAnalysis(a, ctx).ok, false);
  const b = JSON.parse(JSON.stringify(c.allowed_analysis));
  const f = b.findings[0];
  for (let i = 4; i <= 9; i++) { const n = JSON.parse(JSON.stringify(f)); n.finding_id = "f_0" + i; b.findings.push(n); }
  assert.equal(validateBusinessAnalysis(b, ctx).ok, false);
});

test("R7: mix giữ semantics unknown/invalid ngoài mẫu số và share null khi known_total = 0", () => {
  const c = caseById("c01");
  const packet = JSON.parse(JSON.stringify(c.packet));
  const m = packet.project_provider_mix[0];
  // 1/1 vendor: known_total = 1, share = 1, coverage = 1
  m.project_total = 1; m.hrp_count = 0; m.vendor_count = 1; m.unknown_count = 0; m.invalid_count = 0;
  m.known_total = 1; m.hrp_share = 0; m.vendor_share = 1; m.known_coverage = 1;
  const other = packet.project_provider_mix[1];
  other.project_total = 29; other.hrp_count = 15; other.vendor_count = 14; other.unknown_count = 0; other.invalid_count = 0;
  other.known_total = 29; other.hrp_share = 15 / 29; other.vendor_share = 14 / 29; other.known_coverage = 1;
  const ok = validateAnalysisPacket(packet);
  assert.ok(ok.ok, ok.ok ? "" : ok.code + " " + ok.message);

  // known_total = 0 -> share phải null, nếu không thì reject
  const bad = JSON.parse(JSON.stringify(packet));
  bad.project_provider_mix[0].hrp_count = 0; bad.project_provider_mix[0].vendor_count = 0;
  bad.project_provider_mix[0].unknown_count = 1; bad.project_provider_mix[0].invalid_count = 0;
  bad.project_provider_mix[0].known_total = 0;
  assert.equal(validateAnalysisPacket(bad).code, "PROJECT_MIX_INVARIANT");

  // unknown/invalid không được nhập vào known_total
  const bad2 = JSON.parse(JSON.stringify(packet));
  bad2.project_provider_mix[0].unknown_count = 1;
  bad2.project_provider_mix[0].project_total = 2;
  bad2.project_provider_mix[0].known_total = 1;
  bad2.project_provider_mix[0].known_coverage = 1;
  bad2.project_provider_mix[0].hrp_share = 0;
  bad2.project_provider_mix[0].vendor_share = 1;
  assert.equal(validateAnalysisPacket(bad2).code, "PROJECT_MIX_INVARIANT");
});

test("golden case không chứa PII/secret/tên thật; subject ref là opaque", () => {
  for (const c of loadCases()) {
    const all = JSON.stringify(c);
    assert.ok(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(all), c.case_id + " email");
    assert.ok(!/sk-[A-Za-z0-9]{16,}/.test(all), c.case_id + " api key");
    assert.ok(!/(?:\+84|0)\d{9,10}\b/.test(all), c.case_id + " phone");
    const refs = c.packet.subjects.map((s) => s.ref);
    assert.ok(refs.includes("scope"));
    assert.ok(refs.every((r) => /^(scope|(project|recruiter|team)_[0-9]{2,}|provider_(hrp|vendor|unknown|invalid)|employment_(seasonal|official|unknown|invalid))$/.test(r)), "opaque ref " + c.case_id);
  }
  const invalid = listJson("invalid-analysis/").map((f) => JSON.stringify(readJson("invalid-analysis/" + f))).join("");
  assert.ok(/sk-[A-Za-z0-9]{16,}/.test(invalid), "invalid fixtures phải có case secret để test rejection");
});
