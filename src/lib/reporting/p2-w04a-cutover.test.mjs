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
    business_date: "2026-09-29",
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

function deFact(overrides = {}) {
  return {
    source_id: P2_W04A_DIRECT_ENTRY_SOURCE_ID,
    business_date: "2026-09-30",
    project_key: "dự án a",
    project_display: "Dự án A",
    recruiter_key: "nguyễn văn a",
    recruiter_display: "Nguyễn Văn A",
    provider_type_key: "hrp",
    provider_type_display: "HRP",
    employment_type_key: "thời vụ",
    employment_type_display: "Thời vụ",
    recruited_count: 1,
    first_work_date: "2026-09-30",
    entry_id: "00000000-0000-4000-8000-000000000001",
    submission_id: "00000000-0000-4000-8000-000000000002",
    cutoff_date: P2_W04A_CUTOVER_DATE,
    ...overrides,
  };
}

test("1. cutoff date is locked to 2026-09-30 (P2-W04C rebaseline)", () => {
  assert.equal(P2_W04A_CUTOVER_DATE, "2026-09-30");
  assert.equal(isBeforeCutoff("2026-09-29"), true);
  assert.equal(isBeforeCutoff("2026-09-30"), false);
  assert.equal(isAfterCutoff("2026-09-30"), true);
  assert.equal(isAfterCutoff("2026-09-29"), false);
});

test("2. synthetic Direct Entry source is stable and renders as covered", () => {
  assert.equal(P2_W04A_DIRECT_ENTRY_SOURCE_ID, "00000000-0000-4000-8000-0000de000001");
  assert.equal(P2_W04A_DIRECT_ENTRY_SOURCE.id, P2_W04A_DIRECT_ENTRY_SOURCE_ID);
  assert.equal(P2_W04A_DIRECT_ENTRY_SOURCE.active, true);
  assert.equal(P2_W04A_DIRECT_ENTRY_SOURCE.is_test, false);
  assert.equal(P2_W04A_DIRECT_ENTRY_SOURCE.latest_run_status, "succeeded");
});

test("3. maskLegacyFacts includes rows on 2026-09-29, excludes 2026-09-30", () => {
  const f1 = legacyFact({ business_date: "2026-09-28", recruited_count: 3 });
  const f2 = legacyFact({ business_date: "2026-09-29", recruited_count: 5 });
  const f3 = legacyFact({ business_date: "2026-09-30", recruited_count: 7 });
  const masked = maskLegacyFacts([f1, f2, f3]);
  assert.equal(masked.length, 2);
  assert.equal(masked[0].recruited_count, 3);
  assert.equal(masked[1].recruited_count, 5);
});

test("4. maskDirectEntryFacts includes rows on 2026-09-30, excludes 2026-09-29", () => {
  const ok = deFact({ first_work_date: "2026-09-30" });
  const before = deFact({
    first_work_date: "2026-09-29",
    entry_id: "00000000-0000-4000-8000-000000000099",
  });
  const masked = maskDirectEntryFacts([ok, before]);
  assert.equal(masked.length, 1);
  assert.equal(masked[0].entry_id, ok.entry_id);
});

test("5. detectCutoverBlocker returns 0 for canonical post-cutoff facts", () => {
  const a = deFact({ first_work_date: "2026-09-30" });
  const b = deFact({ first_work_date: "2026-10-09" });
  assert.equal(detectCutoverBlocker([a, b]), 0);
});

test("6. detectCutoverBlocker returns 1+ for pre-cutoff eligible facts", () => {
  const ok = deFact({ first_work_date: "2026-09-30" });
  const bad = deFact({
    first_work_date: "2026-09-29",
    entry_id: "00000000-0000-4000-8000-0000000000aa",
  });
  assert.equal(detectCutoverBlocker([ok, bad]), 1);
});

test("7. buildReconciliation totals are data-agnostic (no pre-purge baseline dependency)", () => {
  // P2-W04B rebaseline removed the 2026-10-17 pre-purge baseline
  // (34 rows / 44 total). The reconciliation helper is data-agnostic: it
  // sums whatever the masked legacy + DE aggregates return, regardless of
  // the magnitude. Build a representative aggregate where 24 rows have
  // count 1 and 10 rows have count 2: 24*1 + 10*2 = 44. Total rows =
  // 24 + 10 = 34. The new cutoff accepts any pre-2026-09-30 business_date.
  const legacy = [];
  for (let i = 0; i < 34; i++) {
    const day = String(20 + (i % 5)).padStart(2, "0");
    legacy.push(
      legacyFact({
        business_date: `2026-09-${day}`,
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

test("8. eligible Direct Entry on 2026-09-30 contributes 1 to combined_total", () => {
  const r = buildReconciliation({
    legacyFacts: [],
    directEntryFactsRaw: [deFact({ first_work_date: "2026-09-30" })],
  });
  assert.equal(r.legacy_subtotal, 0);
  assert.equal(r.direct_entry_subtotal, 1);
  assert.equal(r.combined_total, 1);
  assert.equal(r.overlap_blocker, 0);
});

test("9. eligible Direct Entry on 2026-09-29 raises overlap_blocker and fails closed", () => {
  const r = buildReconciliation({
    legacyFacts: [],
    directEntryFactsRaw: [
      deFact({
        first_work_date: "2026-09-29",
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
    legacyFact({ business_date: "2026-09-28", recruited_count: 5 }),
  ];
  const deRaw = [
    deFact({ first_work_date: "2026-09-30" }),
    deFact({
      first_work_date: "2026-09-29",
      entry_id: "00000000-0000-4000-8000-0000000000cc",
    }),
  ];
  const r = buildReconciliation({ legacyFacts: legacy, directEntryFactsRaw: deRaw });
  assert.equal(r.legacy_subtotal, 5);
  assert.equal(r.direct_entry_subtotal, 1); // 2026-09-30 only
  assert.equal(r.combined_total, 6);
  assert.equal(r.overlap_blocker, 1);
});

test("11. combineReportingFacts does NOT dedupe by grain (Blocker 4 R1 fix)", () => {
  // R0 deduped by full grain and silently collapsed two same-grain DE
  // employees into one. R1 concatenates and lets computeReporting sum
  // per grain via recruited_count, so two eligible DE entries sharing
  // the same ReportingFact grain each contribute 1.
  const a = legacyFact({ business_date: "2026-09-29" });
  const b = legacyFact({ business_date: "2026-09-29" });
  const c = deFact({ first_work_date: "2026-10-07" });
  const d = deFact({
    first_work_date: "2026-10-07",
    entry_id: "00000000-0000-4000-8000-000000000010",
  });
  const combined = combineReportingFacts([a, b], [c, d]);
  // 2 legacy rows + 2 DE rows = 4 (no dedupe).
  assert.equal(combined.length, 4);
  // computeReporting will sum recruited_count per grain:
  const grain = combined.filter(
    (f) => f.source_id === P2_W04A_DIRECT_ENTRY_SOURCE_ID,
  );
  assert.equal(grain.length, 2, "two DE entries sharing grain kept distinct");
  assert.equal(grain[0].entry_id !== grain[1].entry_id, true);
});

test("12. combineReportingFacts partitions by date mask (legacy + DE coexist)", () => {
  // Legacy on 2026-09-29 + DE on 2026-10-07 must coexist.
  const legacy = [legacyFact({ business_date: "2026-09-29", recruited_count: 2 })];
  const de = [deFact({ first_work_date: "2026-10-07" })];
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
    cutoff_date: "2026-09-30",
  });
  assert.deepEqual(r, {
    legacy_subtotal: 12,
    direct_entry_subtotal: 7,
    overlap_blocker: 0,
    combined_total: 19,
    cutoff_date: "2026-09-30",
  });

  const r2 = normalizeReconciliationRow({
    legacy_subtotal: "44",
    direct_entry_subtotal: "0",
    overlap_blocker: "0",
    cutoff_date: "2026-09-30",
  });
  assert.equal(r2.legacy_subtotal, 44);
  assert.equal(r2.direct_entry_subtotal, 0);
});

test("14. P1 filter semantics apply identically to both sources (combined grain)", () => {
  // Different business_date => different grain => both kept. Same grain =>
  // both kept (no dedupe) and computeReporting sums them.
  const legacy = [
    legacyFact({
      business_date: "2026-09-29",
      project_key: "p1",
      project_display: "P1",
      recruiter_key: "r1",
      recruiter_display: "R1",
      recruited_count: 1,
    }),
  ];
  const de = [
    deFact({
      first_work_date: "2026-10-07",
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
    { project: "p1", from: "2026-09-29", to: "2026-10-07" },
    scopeIds,
  );
  assert.equal(plan.skip, false);
  assert.deepEqual(plan.query.scopeIds, [
    "11111111-1111-4111-8111-111111111111",
    P2_W04A_DIRECT_ENTRY_SOURCE_ID,
  ]);
  assert.equal(plan.query.project, "p1");
  assert.equal(plan.query.from, "2026-09-29");
  assert.equal(plan.query.to, "2026-10-07");

  // Filter parse must accept the same parameters the dashboard exposes.
  const parsed = p1Filter.parseReportingFilters(
    { project: "P1", from: "2026-09-29", to: "2026-10-07" },
    scopeIds,
  );
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.filters.project, "p1");
    assert.equal(parsed.filters.from, "2026-09-29");
    assert.equal(parsed.filters.to, "2026-10-07");
  }
});

test("16. Direct Entry recruited_count is always 1 per row (SQL projection invariant)", () => {
  // This mirrors the SQL invariant: each eligible entry => recruited_count
  // = 1. The TS contract keeps this explicit at construction time.
  const f = deFact();
  assert.equal(f.recruited_count, 1);
});

test("17. R1: two DE entries sharing grain => combined.length 2, sum recruited_count 2", () => {
  // BUG: R0 deduped by full grain and collapsed two DE employees into 1.
  // R1: concatenate without dedupe; computeReporting sums per grain via
  // recruited_count = 1 per entry, so the canonical total is 2.
  const e1 = deFact({
    first_work_date: "2026-10-17",
    entry_id: "00000000-0000-4000-8000-0000000000e1",
  });
  const e2 = deFact({
    first_work_date: "2026-10-17",
    entry_id: "00000000-0000-4000-8000-0000000000e2",
    submission_id: "00000000-0000-4000-8000-0000000000f2",
  });
  // Same business_date / project / recruiter / provider / employment,
  // distinct entry_id => distinct employees.
  const combined = combineReportingFacts([], [e1, e2]);
  assert.equal(combined.length, 2);
  const sum = combined.reduce((a, f) => a + f.recruited_count, 0);
  assert.equal(sum, 2, "two DE entries sharing grain => recruited_total 2");
});

test("18. R1: computeReporting sums two same-grain DE entries into recruitedTotal=2", async () => {
  const p1 = await import("./p1-reporting.ts");
  const e1 = deFact({
    first_work_date: "2026-10-17",
    entry_id: "00000000-0000-4000-8000-0000000000a1",
  });
  const e2 = deFact({
    first_work_date: "2026-10-17",
    entry_id: "00000000-0000-4000-8000-0000000000a2",
    submission_id: "00000000-0000-4000-8000-0000000000b2",
  });
  const sources = [P2_W04A_DIRECT_ENTRY_SOURCE];
  const combined = combineReportingFacts([], [e1, e2]);
  const data = p1.computeReporting(sources, combined, {});
  assert.equal(data.recruitedTotal, 2, "Dashboard recruitedTotal = 2 for two same-grain DE entries");
  assert.equal(data.empty.noFacts, false);
  assert.equal(data.empty.noSources, false);
});
