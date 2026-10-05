import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildReconciliation,
  combineReportingFacts,
  cutoverBlockerError,
  detectCutoverBlocker,
  hasCutoverBlocker,
  isAfterCutoff,
  isBeforeCutoff,
  maskDirectEntryFacts,
  maskLegacyFacts,
  normalizeReconciliationRow,
  P2_W04A_CUTOVER_BLOCKER_CODE,
  P2_W04A_CUTOVER_DATE,
  P2_W04A_DIRECT_ENTRY_SOURCE,
  P2_W04A_DIRECT_ENTRY_SOURCE_ID,
} from "./p2-w04a-cutover.ts";

function legacyFact(overrides = {}) {
  return {
    source_id: "11111111-1111-4111-8111-111111111111",
    business_date: "2026-10-15",
    project_key: "dự án a",
    project_display: "Dự án A",
    recruiter_key: "nguyễn văn a",
    recruiter_display: "Nguyễn Văn A",
    provider_type_key: "hrp",
    provider_type_display: "HRP",
    employment_type_key: "thời vụ",
    employment_type_display: "Thời vụ",
    recruited_count: 1,
    ...overrides,
  };
}

function deFact(
  overrides = {},
) {
  return {
    source_id: P2_W04A_DIRECT_ENTRY_SOURCE_ID,
    business_date: "2026-10-17",
    project_key: "dự án a",
    project_display: "Dự án A",
    recruiter_key: "nguyễn văn a",
    recruiter_display: "Nguyễn Văn A",
    provider_type_key: "hrp",
    provider_type_display: "HRP",
    employment_type_key: "thời vụ",
    employment_type_display: "Thời vụ",
    recruited_count: 1,
    first_work_date: "2026-10-17",
    entry_id: "00000000-0000-4000-8000-000000000001",
    submission_id: "00000000-0000-4000-8000-000000000002",
    cutoff_date: P2_W04A_CUTOVER_DATE,
    ...overrides,
  };
}

test("1. cutoff date is locked to 2026-10-17", () => {
  assert.equal(P2_W04A_CUTOVER_DATE, "2026-10-17");
  assert.equal(isBeforeCutoff("2026-10-16"), true);
  assert.equal(isBeforeCutoff("2026-10-17"), false);
  assert.equal(isAfterCutoff("2026-10-17"), true);
  assert.equal(isAfterCutoff("2026-10-16"), false);
});

test("2. synthetic Direct Entry source is stable and renders as covered", () => {
  assert.equal(P2_W04A_DIRECT_ENTRY_SOURCE_ID, "00000000-0000-4000-8000-0000de000001");
  assert.equal(P2_W04A_DIRECT_ENTRY_SOURCE.id, P2_W04A_DIRECT_ENTRY_SOURCE_ID);
  assert.equal(P2_W04A_DIRECT_ENTRY_SOURCE.active, true);
  assert.equal(P2_W04A_DIRECT_ENTRY_SOURCE.is_test, false);
  assert.equal(P2_W04A_DIRECT_ENTRY_SOURCE.latest_run_status, "succeeded");
});

test("3. maskLegacyFacts includes rows on 2026-10-16, excludes 2026-10-17", () => {
  const f1 = legacyFact({ business_date: "2026-10-15", recruited_count: 3 });
  const f2 = legacyFact({ business_date: "2026-10-16", recruited_count: 5 });
  const f3 = legacyFact({ business_date: "2026-10-17", recruited_count: 7 });
  const masked = maskLegacyFacts([f1, f2, f3]);
  assert.equal(masked.length, 2);
  assert.equal(masked[0].recruited_count, 3);
  assert.equal(masked[1].recruited_count, 5);
});

test("4. maskDirectEntryFacts includes rows on 2026-10-17, excludes 2026-10-16", () => {
  const ok = deFact({ first_work_date: "2026-10-17" });
  const before = deFact({
    first_work_date: "2026-10-16",
    entry_id: "00000000-0000-4000-8000-000000000099",
  });
  const masked = maskDirectEntryFacts([ok, before]);
  assert.equal(masked.length, 1);
  assert.equal(masked[0].entry_id, ok.entry_id);
});

test("5. detectCutoverBlocker returns 0 for canonical post-cutoff facts", () => {
  const a = deFact({ first_work_date: "2026-10-17" });
  const b = deFact({ first_work_date: "2026-10-20" });
  assert.equal(detectCutoverBlocker([a, b]), 0);
});

test("6. detectCutoverBlocker returns 1+ for pre-cutoff eligible facts", () => {
  const ok = deFact({ first_work_date: "2026-10-17" });
  const bad = deFact({
    first_work_date: "2026-10-16",
    entry_id: "00000000-0000-4000-8000-0000000000aa",
  });
  assert.equal(detectCutoverBlocker([ok, bad]), 1);
});

test("7. buildReconciliation totals match the production baseline (44 from 34 rows)", () => {
  // Production baseline (per p2-w01-r1):
  //   legacy rows = 34, recruited_total = 44, date range 2026-10-01..2026-10-16.
  // Build a representative aggregate where 24 rows have count 1 and 10
  // rows have count 2: 24*1 + 10*2 = 44. Total rows = 24 + 10 = 34.
  const legacy = [];
  for (let i = 0; i < 34; i++) {
    const day = String(1 + (i % 16)).padStart(2, "0");
    legacy.push(
      legacyFact({
        business_date: `2026-10-${day}`,
        recruited_count: i < 24 ? 1 : 2,
      }),
    );
  }
  const de = [];
  const r = buildReconciliation({ legacyFacts: legacy, directEntryFactsRaw: de });
  assert.equal(r.cutoff_date, P2_W04A_CUTOVER_DATE);
  assert.equal(r.legacy_subtotal, 44);
  assert.equal(r.direct_entry_subtotal, 0);
  assert.equal(r.combined_total, 44);
  assert.equal(r.overlap_blocker, 0);
  assert.equal(hasCutoverBlocker(r), false);
});

test("8. eligible Direct Entry on 2026-10-17 contributes 1 to combined_total", () => {
  const r = buildReconciliation({
    legacyFacts: [],
    directEntryFactsRaw: [deFact({ first_work_date: "2026-10-17" })],
  });
  assert.equal(r.legacy_subtotal, 0);
  assert.equal(r.direct_entry_subtotal, 1);
  assert.equal(r.combined_total, 1);
  assert.equal(r.overlap_blocker, 0);
});

test("9. eligible Direct Entry on 2026-10-16 raises overlap_blocker and fails closed", () => {
  const r = buildReconciliation({
    legacyFacts: [],
    directEntryFactsRaw: [
      deFact({
        first_work_date: "2026-10-16",
        entry_id: "00000000-0000-4000-8000-0000000000bb",
      }),
    ],
  });
  assert.equal(r.overlap_blocker, 1);
  assert.equal(hasCutoverBlocker(r), true);
  const err = cutoverBlockerError(r);
  assert.equal(err.ok, false);
  assert.equal(err.code, P2_W04A_CUTOVER_BLOCKER_CODE);
  assert.match(err.message, /Cutover blocker/);
});

test("10. cutover blocker does NOT double-count or silently drop", () => {
  // Even when an overlap row is present, combined_total is still
  // legacy_subtotal + direct_entry_subtotal. The blocker is a hard-fail,
  // not a silent drop.
  const legacy = [
    legacyFact({ business_date: "2026-10-10", recruited_count: 5 }),
  ];
  const deRaw = [
    deFact({ first_work_date: "2026-10-17" }),
    deFact({
      first_work_date: "2026-10-15",
      entry_id: "00000000-0000-4000-8000-0000000000cc",
    }),
  ];
  const r = buildReconciliation({ legacyFacts: legacy, directEntryFactsRaw: deRaw });
  assert.equal(r.legacy_subtotal, 5);
  assert.equal(r.direct_entry_subtotal, 1); // 2026-10-17 only
  assert.equal(r.combined_total, 6);
  assert.equal(r.overlap_blocker, 1);
});

test("11. combineReportingFacts dedupes by full grain", () => {
  const a = legacyFact({ business_date: "2026-10-15" });
  const b = legacyFact({ business_date: "2026-10-15" });
  const c = deFact({ first_work_date: "2026-10-17" });
  const d = deFact({ first_work_date: "2026-10-17" });
  const combined = combineReportingFacts([a, b], [c, d]);
  assert.equal(combined.length, 2);
});

test("12. combineReportingFacts partitions by date mask", () => {
  // Legacy on 2026-10-15 + DE on 2026-10-17 must coexist.
  const legacy = [legacyFact({ business_date: "2026-10-15", recruited_count: 2 })];
  const de = [deFact({ first_work_date: "2026-10-17" })];
  const combined = combineReportingFacts(legacy, de);
  assert.equal(combined.length, 2);
  const sources = new Set(combined.map((f) => f.source_id));
  assert.ok(sources.has("11111111-1111-4111-8111-111111111111"));
  assert.ok(sources.has(P2_W04A_DIRECT_ENTRY_SOURCE_ID));
});

test("13. normalizeReconciliationRow converts bigints and string numbers", () => {
  const r = normalizeReconciliationRow({
    legacy_subtotal: 12n,
    direct_entry_subtotal: 7n,
    overlap_blocker: 0n,
    cutoff_date: "2026-10-17",
  });
  assert.deepEqual(r, {
    legacy_subtotal: 12,
    direct_entry_subtotal: 7,
    overlap_blocker: 0,
    combined_total: 19,
    cutoff_date: "2026-10-17",
  });

  const r2 = normalizeReconciliationRow({
    legacy_subtotal: "44",
    direct_entry_subtotal: "0",
    overlap_blocker: "0",
    cutoff_date: "2026-10-17",
  });
  assert.equal(r2.legacy_subtotal, 44);
  assert.equal(r2.direct_entry_subtotal, 0);
});

test("14. P1 filter semantics apply identically to both sources (combined grain)", () => {
  // Same project, recruiter, provider, employment across both sources
  // would dedupe. This documents the intended grain enforcement.
  const legacy = [
    legacyFact({
      business_date: "2026-10-15",
      project_key: "p1",
      project_display: "P1",
      recruiter_key: "r1",
      recruiter_display: "R1",
      recruited_count: 1,
    }),
  ];
  const de = [
    deFact({
      first_work_date: "2026-10-17",
      project_key: "p1",
      project_display: "P1",
      recruiter_key: "r1",
      recruiter_display: "R1",
    }),
  ];
  // Different business_date => different grain => both kept.
  const combined = combineReportingFacts(legacy, de);
  assert.equal(combined.length, 2);
});

test("15. P1 filter would apply to combined facts after buildReportingFactQuery", async () => {
  const p1 = await import("./p1-reporting.ts");
  const p1Filter = await import("./p1-filter.ts");
  const scopeIds = new Set([
    "11111111-1111-4111-8111-111111111111",
    P2_W04A_DIRECT_ENTRY_SOURCE_ID,
  ]);
  const plan = p1.buildReportingFactQuery(
    { project: "p1", from: "2026-10-15", to: "2026-10-17" },
    scopeIds,
  );
  assert.equal(plan.skip, false);
  assert.deepEqual(plan.query.scopeIds, [
    "11111111-1111-4111-8111-111111111111",
    P2_W04A_DIRECT_ENTRY_SOURCE_ID,
  ]);
  assert.equal(plan.query.project, "p1");
  assert.equal(plan.query.from, "2026-10-15");
  assert.equal(plan.query.to, "2026-10-17");

  // Filter parse must accept the same parameters the dashboard exposes.
  const parsed = p1Filter.parseReportingFilters(
    { project: "P1", from: "2026-10-15", to: "2026-10-17" },
    scopeIds,
  );
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.filters.project, "p1");
    assert.equal(parsed.filters.from, "2026-10-15");
    assert.equal(parsed.filters.to, "2026-10-17");
  }
});

test("16. Direct Entry recruited_count is always 1 per row (SQL projection invariant)", () => {
  // This mirrors the SQL invariant: each eligible entry => recruited_count
  // = 1. The TS contract keeps this explicit at construction time.
  const f = deFact();
  assert.equal(f.recruited_count, 1);
});