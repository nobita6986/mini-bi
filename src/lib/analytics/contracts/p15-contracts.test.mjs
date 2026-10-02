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
    teamAvailability: packet.team_mapping.availability,
    allowedDates: [...new Set([
      packet.period.start,
      packet.period.end,
      packet.period.comparable ? packet.period.comparable.start : null,
      packet.period.comparable ? packet.period.comparable.end : null,
      ...packet.series.points.flatMap((p) => [p.period_start, p.period_end]),
    ].filter(Boolean))],
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

test("R1 valid: mọi packet mẫu trong valid/ đều PASS (gồm PTD comparable = null)", () => {
  const files = listJson("valid/");
  const packets = files.map((f) => readJson("valid/" + f)).filter((x) => x.packet);
  assert.ok(packets.length >= 2, "cần >= 2 packet mẫu");
  for (const x of packets) {
    const res = validateAnalysisPacket(x.packet);
    assert.ok(res.ok, x.case_id + " phải hợp lệ: " + (res.ok ? "" : res.code + " " + res.message));
  }
  const ptd = packets.find((x) => x.packet.period.status === "period_to_date");
  assert.ok(ptd, "cần một packet PTD mẫu");
  // PTD + equal window không khả dụng ⇒ comparable null và KHÔNG có claim so sánh.
  assert.equal(ptd.packet.period.comparable, null);
  assert.equal(ptd.packet.totals.comparable, null);
  assert.equal(ptd.packet.totals.delta, null);
  assert.equal(ptd.packet.totals.delta_pct, null);
  assert.equal(ptd.packet.stability.trend_direction, "unknown");
});

test("R1 PTD clarification: comparable null được phép, nhưng cửa sổ comparable phải đúng độ dài elapsed_days", () => {
  const base = JSON.parse(JSON.stringify(readJson("valid/analysis-packet-ptd-no-comparable.json").packet));
  // comparable = null ⇒ hợp lệ (đã assert ở test trên).
  assert.ok(validateAnalysisPacket(base).ok);
  // Cửa sổ comparable khác null nhưng độ dài thật != elapsed_days ⇒ reject.
  const mismatch = JSON.parse(JSON.stringify(caseById("c04").packet));
  mismatch.period.comparable.end = "2026-09-30";
  assert.equal(validateAnalysisPacket(mismatch).code, "COMPARABLE_WINDOW_LENGTH_MISMATCH");
  // PTD comparable hợp lệ: elapsed khớp và độ dài cửa sổ khớp.
  assert.ok(validateAnalysisPacket(caseById("c04").packet).ok);
  // PTD comparable lệch elapsed ⇒ reject.
  const elapsedMismatch = JSON.parse(JSON.stringify(caseById("c04").packet));
  elapsedMismatch.period.comparable.elapsed_days = 2;
  assert.equal(validateAnalysisPacket(elapsedMismatch).code, "PTD_ELAPSED_MISMATCH");
});

test("R1 data quality: unknown_count và invalid_count độc lập, mỗi chỉ số <= totals.current", () => {
  const base = caseById("c01").packet;
  const mk = (unknown, invalid) => {
    const p = JSON.parse(JSON.stringify(base));
    p.data_quality.unknown_count = unknown;
    p.data_quality.invalid_count = invalid;
    p.data_quality.unknown_share = unknown / p.totals.current;
    p.data_quality.invalid_share = invalid / p.totals.current;
    return p;
  };
  // Tổng hai chỉ số vượt totals.current vẫn HỢP LỆ (grain vừa unknown vừa invalid tính cả hai).
  const overlap = mk(30, 30);
  const res = validateAnalysisPacket(overlap);
  assert.ok(res.ok, res.ok ? "" : res.code + " " + res.message);
  // Từng chỉ số vượt totals.current ⇒ reject (giữ share <= 1 để vượt qua schema, chạm đúng rule ngữ nghĩa).
  const overUnknown = mk(30, 0);
  overUnknown.data_quality.unknown_count = 31;
  overUnknown.data_quality.unknown_share = 1;
  assert.equal(validateAnalysisPacket(overUnknown).code, "DATA_QUALITY_INVALID");
  const overInvalid = mk(0, 30);
  overInvalid.data_quality.invalid_count = 31;
  overInvalid.data_quality.invalid_share = 1;
  assert.equal(validateAnalysisPacket(overInvalid).code, "DATA_QUALITY_INVALID");
  // Share phải khớp count/current.
  const badShare = mk(10, 5);
  badShare.data_quality.unknown_share = 0.5;
  assert.equal(validateAnalysisPacket(badShare).code, "DATA_QUALITY_INVALID");
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
    assert.ok(!/(?:\+84|\b0)\d{9,10}\b/.test(all), c.case_id + " phone");
    const refs = c.packet.subjects.map((s) => s.ref);
    assert.ok(refs.includes("scope"));
    assert.ok(refs.every((r) => /^(scope|(project|recruiter|team)_[0-9]{2,}|provider_(hrp|vendor|unknown|invalid)|employment_(seasonal|official|unknown|invalid))$/.test(r)), "opaque ref " + c.case_id);
  }
  const invalid = listJson("invalid-analysis/").map((f) => JSON.stringify(readJson("invalid-analysis/" + f))).join("");
  assert.ok(/sk-[A-Za-z0-9]{16,}/.test(invalid), "invalid fixtures phải có case secret để test rejection");
});

// ---------------------------------------------------------------------------
// R1 — period_ref
// ---------------------------------------------------------------------------

test("R1 period_ref: mọi loại kỳ hợp lệ khi prefix khớp type", () => {
  const valid = [
    ["week", "week:2026-W01", ["2026-01-01", "2026-01-07"]],
    ["week", "week:2026-W53", ["2026-12-01", "2026-12-07"]],
    ["month", "month:2026-01", ["2026-01-01", "2026-01-31"]],
    ["month", "month:2026-12", ["2026-12-01", "2026-12-31"]],
    ["quarter", "quarter:2026-Q1", ["2026-01-01", "2026-03-31"]],
    ["quarter", "quarter:2026-Q4", ["2026-10-01", "2026-12-31"]],
    ["custom", "custom:2026-09-01/2026-09-30", ["2026-09-01", "2026-09-30"]],
  ];
  for (const [type, ref, [start, end]] of valid) {
    const packet = JSON.parse(JSON.stringify(caseById("c01").packet));
    packet.period.type = type;
    packet.period.period_ref = ref;
    packet.period.start = start;
    packet.period.end = end;
    packet.period.comparable = null;
    packet.totals.comparable = null;
    packet.totals.delta = null;
    packet.totals.delta_pct = null;
    for (const e of packet.evidence) e.period_ref = ref;
    const res = validateAnalysisPacket(packet);
    assert.ok(res.ok, ref + " phải hợp lệ: " + (res.ok ? "" : res.code + " " + res.message));
  }
});

test("R1 period_ref: sai range/format bị reject", () => {
  const bad = [
    ["week", "week:2026-W00"],
    ["week", "week:2026-W54"],
    ["week", "week:2026-W1"],
    ["month", "month:2026-00"],
    ["month", "month:2026-13"],
    ["quarter", "quarter:2026-Q5"],
    ["custom", "custom:2026-09-01"],
  ];
  for (const [type, ref] of bad) {
    const packet = JSON.parse(JSON.stringify(caseById("c01").packet));
    packet.period.type = type;
    packet.period.period_ref = ref;
    assert.equal(validateAnalysisPacket(packet).ok, false, ref + " phải bị reject");
  }
});

test("R1 period_ref: type mismatch, custom range mismatch, comparable khác loại kỳ", () => {
  const base = caseById("c01").packet;
  const mk = () => JSON.parse(JSON.stringify(base));

  const a = mk();
  a.period.period_ref = "month:2026-10";
  assert.equal(validateAnalysisPacket(a).code, "PERIOD_REF_TYPE_MISMATCH");

  const b = mk();
  b.period.type = "custom";
  b.period.period_ref = "custom:2026-09-01/2026-09-30";
  b.period.comparable = null;
  b.totals.comparable = null;
  b.totals.delta = null;
  b.totals.delta_pct = null;
  assert.equal(validateAnalysisPacket(b).code, "PERIOD_REF_RANGE_MISMATCH");

  const c = mk();
  c.period.comparable.period_ref = "month:2026-09";
  assert.equal(validateAnalysisPacket(c).code, "COMPARABLE_PERIOD_TYPE_MISMATCH");
});

// ---------------------------------------------------------------------------
// R1 — findings 0..7 (không ép AI bịa finding)
// ---------------------------------------------------------------------------

test("R1 findings: 0 finding hợp lệ khi có limitation + executive nêu giới hạn", () => {
  const ctx = contextForCase("c01");
  const a = JSON.parse(JSON.stringify(caseById("c01").allowed_analysis));
  a.findings = [];
  a.overall_limitations = ["Chưa đủ dữ liệu để kết luận xu hướng trong kỳ này."];
  a.executive_analysis = "Kỳ này ghi nhận 30 người so với 24 người kỳ trước; chưa đủ dữ liệu để kết luận xu hướng nên báo cáo không đưa ra finding nào.";
  const res = validateBusinessAnalysis(a, ctx);
  assert.ok(res.ok, res.ok ? "" : res.code + " " + res.message);
});

test("R1 findings: 0 finding nhưng thiếu limitation bị reject", () => {
  const ctx = contextForCase("c01");
  const a = JSON.parse(JSON.stringify(caseById("c01").allowed_analysis));
  a.findings = [];
  a.overall_limitations = [];
  assert.equal(validateBusinessAnalysis(a, ctx).code, "EMPTY_FINDINGS_WITHOUT_LIMITATION");
});

test("R1 findings: không còn tối thiểu 3 finding khi baseline đạt", () => {
  const ctx = contextForCase("c01");
  assert.deepEqual(ctx.insufficientKeys, []);
  const a = JSON.parse(JSON.stringify(caseById("c01").allowed_analysis));
  a.findings = [a.findings[0]];
  const res = validateBusinessAnalysis(a, ctx);
  assert.ok(res.ok, "1 finding phải hợp lệ khi baseline đạt: " + (res.ok ? "" : res.code));
});

test("R1 findings: 8 finding vẫn bị reject bởi schema", () => {
  const ctx = contextForCase("c01");
  const a = JSON.parse(JSON.stringify(caseById("c01").allowed_analysis));
  const f = a.findings[0];
  for (let i = 4; i <= 9; i++) { const n = JSON.parse(JSON.stringify(f)); n.finding_id = "f_0" + i; a.findings.push(n); }
  assert.equal(validateBusinessAnalysis(a, ctx).code, "SCHEMA_INVALID");
});

// ---------------------------------------------------------------------------
// R1 — unit-aware grounding
// ---------------------------------------------------------------------------

test("R1 grounding: count 1 KHÔNG ground claim 100 người", () => {
  const ctx = contextForCase("c09");
  const a = JSON.parse(JSON.stringify(caseById("c09").allowed_analysis));
  a.findings = [a.findings[0]];
  a.findings[0].evidence_refs = ["ev_01"];
  a.findings[0].category = "provider_mix";
  a.findings[0].headline = "Dự án có 100 người trong kỳ";
  a.findings[0].analysis = "Dự án này ghi nhận 100 người nên quy mô là đáng kể trong kỳ.";
  a.findings[0].limitations = [];
  assert.equal(validateBusinessAnalysis(a, ctx).code, "UNGROUNDED_NUMERIC_CLAIM");
});

test("R1 grounding: khoảng cách gần (±1) bị reject — không còn dung sai", () => {
  const ctx = contextForCase("c01");
  const a = JSON.parse(JSON.stringify(caseById("c01").allowed_analysis));
  a.findings = [a.findings[0]];
  a.findings[0].analysis = "Tổng kỳ này là 31 người so với 24 người kỳ trước.";
  assert.equal(validateBusinessAnalysis(a, ctx).code, "UNGROUNDED_NUMERIC_CLAIM");
});

test("R1 grounding: percent/ratio dùng representation deterministic", () => {
  const ctx = contextForCase("c10");
  const base = caseById("c10").allowed_analysis;
  const mk = (text) => {
    const a = JSON.parse(JSON.stringify(base));
    a.findings = [a.findings[1]];
    a.findings[0].evidence_refs = ["ev_01", "ev_02"];
    a.findings[0].analysis = text;
    return a;
  };
  // ratio 0.9167 -> 91.67 / 91.7 / 92 đều hợp lệ
  for (const ok of ["Dự án có 120 người và tỷ lệ Vendor là 92%.", "Dự án có 120 người và tỷ lệ Vendor là 91.7%.", "Dự án có 120 người và tỷ lệ Vendor là 91.67%."]) {
    const res = validateBusinessAnalysis(mk(ok), ctx);
    assert.ok(res.ok, ok + " phải hợp lệ: " + (res.ok ? "" : res.code));
  }
  // 96% không nằm trong tập representation
  assert.equal(validateBusinessAnalysis(mk("Dự án có 120 người và tỷ lệ Vendor là 96%."), ctx).code, "UNGROUNDED_NUMERIC_CLAIM");
});

test("R1 grounding: cross-unit bị reject (people không ground claim %)", () => {
  const ctx = contextForCase("c01");
  const a = JSON.parse(JSON.stringify(caseById("c01").allowed_analysis));
  a.findings = [a.findings[0]];
  a.findings[0].evidence_refs = ["ev_01"];
  a.findings[0].headline = "Tổng kỳ này đạt 30 người";
  a.findings[0].analysis = "Tổng kỳ này là 30 người, tương đương 50% kế hoạch đề ra.";
  assert.equal(validateBusinessAnalysis(a, ctx).code, "UNGROUNDED_NUMERIC_CLAIM");
});

test("R1 grounding: ratio không tự ground claim số người", () => {
  const ctx = contextForCase("c01");
  const a = JSON.parse(JSON.stringify(caseById("c01").allowed_analysis));
  a.findings = [a.findings[0]];
  a.findings[0].evidence_refs = ["ev_05"];
  a.findings[0].headline = "Team này đóng góp 60 người";
  a.findings[0].analysis = "Team này đóng góp 60 người trong kỳ phân tích hiện tại.";
  assert.equal(validateBusinessAnalysis(a, ctx).code, "UNGROUNDED_NUMERIC_CLAIM");
});

// ---------------------------------------------------------------------------
// R1 — executive grounding
// ---------------------------------------------------------------------------

test("R1 executive: ref phải tồn tại và mọi claim số phải ground", () => {
  const ctx = contextForCase("c01");
  const base = caseById("c01").allowed_analysis;
  const mk = (mutate) => { const a = JSON.parse(JSON.stringify(base)); mutate(a); return a; };
  assert.equal(validateBusinessAnalysis(mk((a) => { a.executive_evidence_refs = ["ev_99"]; }), ctx).code, "DANGLING_EVIDENCE_REF");
  assert.equal(validateBusinessAnalysis(mk((a) => { a.executive_analysis = "Kỳ này ghi nhận 999 người, tăng mạnh so với kỳ so sánh."; }), ctx).code, "UNGROUNDED_NUMERIC_CLAIM");
  assert.equal(validateBusinessAnalysis(mk((a) => { a.overall_limitations = ["Chỉ có 99 kỳ hoàn tất nên chưa đủ baseline."]; }), ctx).code, "UNGROUNDED_NUMERIC_CLAIM");
});

test("R1 executive: limitation không chứa số luôn hợp lệ", () => {
  const ctx = contextForCase("c01");
  const a = JSON.parse(JSON.stringify(caseById("c01").allowed_analysis));
  a.overall_limitations = ["Chưa có target nên không so sánh được năng lực."];
  const res = validateBusinessAnalysis(a, ctx);
  assert.ok(res.ok, res.ok ? "" : res.code + " " + res.message);
});

// ---------------------------------------------------------------------------
// R1 — volatility
// ---------------------------------------------------------------------------

test("R1 volatility: boundary 0.25 = medium, 0.50 = high", () => {
  const mk = (cv, volatility) => {
    const p = JSON.parse(JSON.stringify(caseById("c01").packet));
    p.stability.mean = 100;
    p.stability.stddev = cv * 100;
    p.stability.cv = cv;
    p.stability.volatility = volatility;
    p.stability.period_points = 8;
    return p;
  };
  assert.ok(validateAnalysisPacket(mk(0.2499, "low")).ok);
  assert.ok(validateAnalysisPacket(mk(0.25, "medium")).ok);
  assert.ok(validateAnalysisPacket(mk(0.4999, "medium")).ok);
  assert.ok(validateAnalysisPacket(mk(0.5, "high")).ok);
  assert.equal(validateAnalysisPacket(mk(0.25, "low")).code, "VOLATILITY_BAND_MISMATCH");
  assert.equal(validateAnalysisPacket(mk(0.5, "medium")).code, "VOLATILITY_BAND_MISMATCH");
});

test("R1 volatility: thiếu 4 điểm hoặc mean <= 0 => cv null + volatility unknown", () => {
  const mk = (mutate) => { const p = JSON.parse(JSON.stringify(caseById("c01").packet)); mutate(p); return p; };
  const shortPoints = mk((p) => { p.stability.period_points = 3; });
  assert.equal(validateAnalysisPacket(shortPoints).code, "STABILITY_INCONSISTENT");
  const fixed = mk((p) => { p.stability.period_points = 3; p.stability.cv = null; p.stability.volatility = "unknown"; });
  assert.ok(validateAnalysisPacket(fixed).ok);
  const zeroMean = mk((p) => { p.stability.mean = 0; p.stability.stddev = 0; p.stability.cv = null; p.stability.volatility = "unknown"; });
  assert.ok(validateAnalysisPacket(zeroMean).ok);
  const zeroMeanBad = mk((p) => { p.stability.mean = 0; p.stability.stddev = 0; p.stability.cv = 0; p.stability.volatility = "low"; });
  assert.equal(validateAnalysisPacket(zeroMeanBad).code, "STABILITY_INCONSISTENT");
});

// ---------------------------------------------------------------------------
// R1 — team optional
// ---------------------------------------------------------------------------

test("R1 team: unavailable/ambiguous phải rỗng team subject + driver", () => {
  const base = caseById("c01").packet;
  const mk = () => JSON.parse(JSON.stringify(base));
  const unavailable = mk();
  unavailable.team_mapping = { availability: "unavailable", mapped_recruited_count: 0, unmapped_recruited_count: unavailable.totals.current, ambiguous_recruited_count: 0, coverage_ratio: 0, teams_in_scope: 0, reason_code: "TEAM_MAPPING_UNAVAILABLE" };
  unavailable.subjects = unavailable.subjects.filter((s) => s.kind !== "team");
  unavailable.drivers.team = [];
  unavailable.evidence = unavailable.evidence.filter((e) => e.subject_ref !== "team_01" && e.subject_ref !== "team_02");
  assert.ok(validateAnalysisPacket(unavailable).ok, "team unavailable rỗng phải hợp lệ");

  const incomplete = mk();
  incomplete.team_mapping = { availability: "ambiguous", mapped_recruited_count: 0, unmapped_recruited_count: 12, ambiguous_recruited_count: 18, coverage_ratio: 0, teams_in_scope: 2, reason_code: "TEAM_MAPPING_AMBIGUOUS" };
  assert.equal(validateAnalysisPacket(incomplete).code, "TEAM_MAPPING_INCONSISTENT");
});

test("R1 team: partial yêu cầu coverage trong (0,1) và finding team phải có limitation, không high", () => {
  const packet = JSON.parse(JSON.stringify(caseById("c01").packet));
  packet.team_mapping = { availability: "partial", mapped_recruited_count: 15, unmapped_recruited_count: 15, ambiguous_recruited_count: 0, coverage_ratio: 0.5, teams_in_scope: 2, reason_code: "TEAM_MAPPING_PARTIAL" };
  const pv = validateAnalysisPacket(packet);
  assert.ok(pv.ok, pv.ok ? "" : pv.code + " " + pv.message);
  const ctx = contextFromPacket(pv.value);
  assert.equal(ctx.teamAvailability, "partial");

  const mk = (mutate) => { const a = JSON.parse(JSON.stringify(caseById("c01").allowed_analysis)); a.findings = [a.findings[1]]; a.findings[0].subject_ref = "team_01"; mutate(a.findings[0]); return a; };
  assert.equal(validateBusinessAnalysis(mk((f) => { f.confidence = "high"; f.limitations = ["Coverage team chỉ 50%."]; }), ctx).code, "TEAM_FINDING_WITHOUT_COVERAGE_LIMITATION");
  assert.equal(validateBusinessAnalysis(mk((f) => { f.confidence = "medium"; f.limitations = []; }), ctx).code, "TEAM_FINDING_WITHOUT_COVERAGE_LIMITATION");
  const okRes = validateBusinessAnalysis(mk((f) => { f.confidence = "medium"; f.limitations = ["Coverage team chỉ 50% nên chỉ mang tính tham khảo."]; }), ctx);
  assert.ok(okRes.ok, okRes.ok ? "" : okRes.code + " " + okRes.message);
});

test("R1 team: mapping unavailable thì finding team bị chặn bởi SUBJECT_OUT_OF_SCOPE", () => {
  const ctx = contextForCase("c07");
  assert.equal(ctx.teamAvailability, "unavailable");
  const a = JSON.parse(JSON.stringify(caseById("c07").allowed_analysis));
  const teamFinding = JSON.parse(JSON.stringify(a.findings[0]));
  teamFinding.subject_ref = "team_01";
  a.findings = [teamFinding];
  assert.equal(validateBusinessAnalysis(a, ctx).code, "SUBJECT_OUT_OF_SCOPE");
});

// ---------------------------------------------------------------------------
// R2 — unit-context grounding, date grounding, team fact-weighted semantics
// ---------------------------------------------------------------------------

function minimalPacket(evidenceList) {
  const base = JSON.parse(JSON.stringify(caseById("c01").packet));
  const zero = { top1_ref: null, top1_share: null, top3_share: null, distinct_subjects: 0 };
  base.totals = { current: 30, comparable: null, delta: null, delta_pct: null };
  base.drivers = { project: [], recruiter: [], team: [], provider: [], employment: [] };
  base.concentration = { project: { ...zero }, recruiter: { ...zero }, team: { ...zero }, provider: { ...zero }, employment: { ...zero } };
  base.project_provider_mix = [];
  base.subjects = [{ ref: "scope", kind: "project", catalog_key: null }];
  base.team_mapping = { availability: "unavailable", mapped_recruited_count: 0, unmapped_recruited_count: 30, ambiguous_recruited_count: 0, coverage_ratio: 0, teams_in_scope: 0, reason_code: "TEAM_MAPPING_UNAVAILABLE" };
  base.evidence = evidenceList.map((e, i) => ({
    evidence_id: "ev_" + String(i + 1).padStart(2, "0"),
    metric: "metric_" + (i + 1),
    formula: "sum(recruited_count)",
    formula_version: "v0.1",
    period_ref: base.period.period_ref,
    scope_ref: base.scope.scope_hash,
    subject_ref: "scope",
    value: e.value,
    unit: e.unit,
    sufficiency: "met",
    quality: "ok",
    snapshot_ref: base.snapshot.hash,
  }));
  return base;
}

function unitAnalysis(packet, text) {
  const ids = packet.evidence.map((e) => e.evidence_id);
  return {
    contract_version: "business-analysis/0.1",
    period_ref: packet.period.period_ref,
    report_status: "draft",
    executive_analysis: "Kỳ này được đánh giá dựa trên dữ liệu reporting hiện có và không có sai lệch bất thường.",
    executive_evidence_refs: ids,
    findings: [{
      finding_id: "f_01",
      category: "trend",
      subject_ref: "scope",
      headline: "Kiểm tra claim số theo đơn vị",
      analysis: text,
      evidence_refs: ids,
      confidence: "medium",
      limitations: [],
      recommended_action: null,
    }],
    overall_limitations: [],
  };
}

function checkUnit(unit, value, text) {
  const packet = minimalPacket([{ unit, value }]);
  const pv = validateAnalysisPacket(packet);
  assert.ok(pv.ok, "packet " + unit + ": " + (pv.ok ? "" : pv.code + " " + pv.message));
  return validateBusinessAnalysis(unitAnalysis(pv.value, text), contextFromPacket(pv.value));
}

test("R2 unit-context: percent KHÔNG ground token plain", () => {
  assert.equal(checkUnit("percent", 50, "Dự án có 50 người trong kỳ này.").code, "UNGROUNDED_NUMERIC_CLAIM");
  assert.ok(checkUnit("percent", 50, "Tỷ lệ Vendor là 50% trong kỳ này.").ok);
});

test("R2 unit-context: ratio KHÔNG ground token plain, chỉ ground claim %", () => {
  assert.equal(checkUnit("ratio", 0.5, "Dự án có 50 người trong kỳ này.").code, "UNGROUNDED_NUMERIC_CLAIM");
  assert.ok(checkUnit("ratio", 0.5, "Tỷ lệ Vendor là 50% trong kỳ này.").ok);
});

test("R2 unit-context: people không ground 'ngày'", () => {
  assert.equal(checkUnit("people", 5, "Dự án cần 5 ngày để hoàn tất kỳ này.").code, "UNGROUNDED_NUMERIC_CLAIM");
  assert.ok(checkUnit("people", 5, "Dự án ghi nhận 5 người trong kỳ này.").ok);
});

test("R2 unit-context: days không ground 'người'", () => {
  assert.equal(checkUnit("days", 7, "Dự án ghi nhận 7 người trong kỳ này.").code, "UNGROUNDED_NUMERIC_CLAIM");
  assert.ok(checkUnit("days", 7, "Dự án cần 7 ngày để hoàn tất kỳ này.").ok);
});

test("R2 unit-context: count không ground 'người'", () => {
  assert.equal(checkUnit("count", 4, "Dự án ghi nhận 4 người trong kỳ này.").code, "UNGROUNDED_NUMERIC_CLAIM");
  assert.ok(checkUnit("count", 4, "Dự án có 4 nguồn trong kỳ này.").ok);
});

test("R2 unit-context: plain không unit hint chỉ ground bằng count-family", () => {
  assert.ok(checkUnit("people", 5, "Chỉ số ghi nhận 5 cho kỳ này trên toàn scope.").ok);
  assert.equal(checkUnit("ratio", 0.5, "Chỉ số ghi nhận 0.5 cho kỳ này trên toàn scope.").code, "UNGROUNDED_NUMERIC_CLAIM");
  assert.equal(checkUnit("percent", 50, "Chỉ số ghi nhận 50 cho kỳ này trên toàn scope.").code, "UNGROUNDED_NUMERIC_CLAIM");
});

test("R2 date: ngày thuộc packet PASS, ngày bịa FAIL trong finding", () => {
  const c = caseById("c01");
  const ctx = contextForCase("c01");
  const mk = (text) => { const a = JSON.parse(JSON.stringify(c.allowed_analysis)); a.findings = [a.findings[0]]; a.findings[0].analysis = text; return a; };
  const allowed = c.packet.period.start;
  assert.ok(ctx.allowedDates.includes(allowed));
  assert.ok(validateBusinessAnalysis(mk("Tổng ngày " + allowed + " là 30 người so với 24 người kỳ trước."), ctx).ok);
  assert.equal(validateBusinessAnalysis(mk("Tổng ngày 2026-11-30 là 30 người so với 24 người kỳ trước."), ctx).code, "UNGROUNDED_DATE_CLAIM");
});

test("R2 date: kiểm tra cả executive, overall_limitations và finding limitations", () => {
  const ctx = contextForCase("c01");
  const mk = (mutate) => { const a = JSON.parse(JSON.stringify(caseById("c01").allowed_analysis)); mutate(a); return a; };
  assert.equal(validateBusinessAnalysis(mk((a) => { a.executive_analysis = "Tính đến ngày 2026-12-31, kỳ này ghi nhận 30 người so với 24 người kỳ trước."; }), ctx).code, "UNGROUNDED_DATE_CLAIM");
  assert.equal(validateBusinessAnalysis(mk((a) => { a.overall_limitations = ["Dữ liệu chỉ đầy đủ đến 2026-11-01 nên cần kiểm tra thêm."]; }), ctx).code, "UNGROUNDED_DATE_CLAIM");
  assert.equal(validateBusinessAnalysis(mk((a) => { a.findings[0].limitations = ["Chỉ có dữ liệu đến 2026-11-01."]; }), ctx).code, "UNGROUNDED_DATE_CLAIM");
});

test("R2 stability: mean/stddev/cv âm bị schema reject", () => {
  const mk = (mutate) => { const p = JSON.parse(JSON.stringify(caseById("c01").packet)); mutate(p); return p; };
  assert.equal(validateAnalysisPacket(mk((p) => { p.stability.mean = -1; })).code, "SCHEMA_INVALID");
  assert.equal(validateAnalysisPacket(mk((p) => { p.stability.stddev = -1; })).code, "SCHEMA_INVALID");
  assert.equal(validateAnalysisPacket(mk((p) => { p.stability.cv = -0.1; })).code, "SCHEMA_INVALID");
});

test("R2 team: invariants fact-weighted theo recruited_count", () => {
  const base = caseById("c01").packet;
  const mk = (tm) => { const p = JSON.parse(JSON.stringify(base)); p.team_mapping = tm; return p; };
  const okTm = { availability: "available", mapped_recruited_count: 30, unmapped_recruited_count: 0, ambiguous_recruited_count: 0, coverage_ratio: 1, teams_in_scope: 2, reason_code: "TEAM_MAPPING_AVAILABLE" };
  assert.ok(validateAnalysisPacket(mk(okTm)).ok);
  assert.equal(validateAnalysisPacket(mk({ ...okTm, unmapped_recruited_count: 1 })).code, "TEAM_MAPPING_INCONSISTENT");
  assert.equal(validateAnalysisPacket(mk({ ...okTm, teams_in_scope: 9 })).code, "TEAM_MAPPING_INCONSISTENT");
  assert.equal(validateAnalysisPacket(mk({ availability: "partial", mapped_recruited_count: 10, unmapped_recruited_count: 20, ambiguous_recruited_count: 0, coverage_ratio: 0.9, teams_in_scope: 2, reason_code: "TEAM_MAPPING_PARTIAL" })).code, "TEAM_MAPPING_INCONSISTENT");
  assert.equal(validateAnalysisPacket(mk({ availability: "ambiguous", mapped_recruited_count: 0, unmapped_recruited_count: 30, ambiguous_recruited_count: 0, coverage_ratio: 0, teams_in_scope: 2, reason_code: "TEAM_MAPPING_AMBIGUOUS" })).code, "TEAM_MAPPING_INCONSISTENT");
  const zeroCurrent = JSON.parse(JSON.stringify(base));
  zeroCurrent.totals = { current: 0, comparable: null, delta: null, delta_pct: null };
  zeroCurrent.project_provider_mix = [];
  zeroCurrent.team_mapping = { availability: "unavailable", mapped_recruited_count: 0, unmapped_recruited_count: 0, ambiguous_recruited_count: 0, coverage_ratio: null, teams_in_scope: 0, reason_code: "TEAM_MAPPING_UNAVAILABLE" };
  // R1: totals.current = 0 ⇒ unknown_share/invalid_share phải null (không chia 0).
  zeroCurrent.data_quality.unknown_share = null;
  zeroCurrent.data_quality.invalid_share = null;
  zeroCurrent.subjects = zeroCurrent.subjects.filter((s) => s.kind !== "team");
  zeroCurrent.drivers.team = [];
  zeroCurrent.evidence = zeroCurrent.evidence.filter((e) => !e.subject_ref.startsWith("team_"));
  const zeroRes = validateAnalysisPacket(zeroCurrent);
  assert.ok(zeroRes.ok, zeroRes.ok ? "" : zeroRes.code + " " + zeroRes.message);
});
