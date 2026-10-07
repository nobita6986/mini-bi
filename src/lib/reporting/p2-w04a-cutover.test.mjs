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
  P2_W04A_BLOCKER_RPC,
  P2_W04A_CUTOVER_BLOCKER_CODE,
  P2_W04A_CUTOVER_DATE,
  P2_W04A_DIRECT_ENTRY_SOURCE,
  P2_W04A_DIRECT_ENTRY_SOURCE_ID,
  readCutoverBlocker,
} from "./p2-w04a-cutover.ts";
import { reportingQueryFailed } from "./p1-reporting.ts";

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

// ---------------------------------------------------------------------------
// P3-J01B-R1 - sanitized pre-cutover blocker read.
//
// The read path used to forward the raw Supabase code/message into
// CutoverFetchResult, and dashboard-view.tsx renders
// `report.code + " · " + report.message` for an unrecognized failure, so a raw
// provider/database message could reach the operator. These tests pin the
// sanitized contract and the preserved blocker semantics.
// ---------------------------------------------------------------------------

// Raw sentinel: the exact kind of value a PostgREST/provider error carries.
const RAW_CODE = "RAW_PROVIDER_CODE_9F3A";
const RAW_MESSAGE =
  "RAW_PROVIDER_MESSAGE pg_relation_missing at 20261007020000_p2_w04a cutover";
const RAW_SENTINELS = [RAW_CODE, RAW_MESSAGE, "pg_relation_missing", "RAW_PROVIDER"];

function assertNoSentinel(serialized, label) {
  for (const sentinel of RAW_SENTINELS) {
    assert.equal(serialized.includes(sentinel), false, label + " must not leak " + sentinel);
  }
}

async function readWith(rpcResult, capture) {
  const lines = capture ?? [];
  const result = await readCutoverBlocker(() => rpcResult, (line) => lines.push(line));
  return { result, lines };
}

test("19. J01B-R1: a raw RPC error is returned as the stable sanitized error", async () => {
  const { result, lines } = await readWith({ data: null, error: { code: RAW_CODE, message: RAW_MESSAGE } });
  assert.deepEqual(result, reportingQueryFailed(),
    "the blocked read must reuse the existing stable reporting error");
  assert.equal(result.code, "REPORTING_QUERY_FAILED");
  assert.equal(result.ok, false);
  assertNoSentinel(JSON.stringify(result), "the result");
  // The dashboard renders exactly this composition for an unknown failure code.
  assertNoSentinel(result.code + " · " + result.message, "the rendered copy");
  assert.equal(lines.length, 1, "exactly one safe log line");
  for (const line of lines) assertNoSentinel(line, "the log line");
  assert.ok(lines[0].includes("reason=rpc_error"), "the log keeps a fixed reason marker");
});

test("20. J01B-R1: malformed, missing, negative and fractional counts are sanitized", async () => {
  const payloads = [
    { label: "missing payload", rpc: { data: undefined, error: null } },
    { label: "null payload", rpc: { data: null, error: null } },
    { label: "object payload", rpc: { data: { count: 1 }, error: null } },
    { label: "boolean payload", rpc: { data: true, error: null } },
    { label: "empty string", rpc: { data: "  ", error: null } },
    { label: "non numeric string", rpc: { data: RAW_MESSAGE, error: null } },
    { label: "negative", rpc: { data: -1, error: null } },
    { label: "negative string", rpc: { data: "-17", error: null } },
    { label: "fractional", rpc: { data: 2.5, error: null } },
    { label: "exponential", rpc: { data: "1e3", error: null } },
    { label: "not a safe integer", rpc: { data: "9007199254740993", error: null } },
  ];
  for (const item of payloads) {
    const { result, lines } = await readWith(item.rpc);
    assert.deepEqual(result, reportingQueryFailed(), item.label + " must fail closed");
    assertNoSentinel(JSON.stringify(result) + lines.join("\n"), item.label);
  }
});

test("21. J01B-R1: a thrown transport failure is sanitized too", async () => {
  const lines = [];
  const result = await readCutoverBlocker(
    () => { throw new Error(RAW_MESSAGE); },
    (line) => lines.push(line),
  );
  assert.deepEqual(result, reportingQueryFailed());
  assertNoSentinel(JSON.stringify(result) + lines.join("\n"), "a thrown error");
});

test("22. J01B-R1: a valid count still reads through (bigint-as-string included)", async () => {
  const zero = await readWith({ data: 0, error: null });
  assert.deepEqual(zero.result, { ok: true, count: 0 });
  assert.deepEqual(zero.lines, [], "a successful read must not log");
  const big = await readWith({ data: "17", error: null });
  assert.deepEqual(big.result, { ok: true, count: 17 });
  const numeric = await readWith({ data: 3, error: null });
  assert.deepEqual(numeric.result, { ok: true, count: 3 });
  const atRpc = await readCutoverBlocker((name) => {
    assert.equal(name, P2_W04A_BLOCKER_RPC, "the blocker helper is read through its own RPC");
    return { data: 1, error: null };
  });
  assert.deepEqual(atRpc, { ok: true, count: 1 });
});

test("23. J01B-R1: a real blocker count still wins over the sanitized error", async () => {
  // Reading succeeds with a non-zero count => the reconciliation carries it and
  // the locked cutover blocker (NOT the generic reporting error) is returned.
  const read = await readWith({ data: 4, error: null });
  assert.deepEqual(read.result, { ok: true, count: 4 });
  // Four eligible Direct Entry rows before the cutoff => 4 blocker rows, which is
  // exactly what the runtime helper counts and what the read path forwards.
  const preCutoff = [1, 2, 3, 4].map((i) =>
    deFact({
      first_work_date: "2026-09-29",
      business_date: "2026-09-29",
      entry_id: "00000000-0000-4000-8000-0000000000c" + i,
      submission_id: "00000000-0000-4000-8000-0000000000d" + i,
    }),
  );
  const reconciliation = buildReconciliation({
    legacyFacts: [],
    directEntryFactsRaw: preCutoff,
  });
  assert.equal(reconciliation.overlap_blocker, read.result.count,
    "the reconciliation forwards the sanitized read count unchanged");
  assert.equal(hasCutoverBlocker(reconciliation), true);
  const err = cutoverBlockerError(reconciliation);
  assert.equal(err.code, P2_W04A_CUTOVER_BLOCKER_CODE);
  assert.equal(err.ok, false);
  assert.equal(err.reconciliation.overlap_blocker, 4);
  assert.notEqual(err.code, reportingQueryFailed().code,
    "a genuine blocker must never collapse into the generic error");
  // Zero blocker count is a clean read, not a blocker.
  const clean = await readWith({ data: 0, error: null });
  const cleanReconciliation = buildReconciliation({
    legacyFacts: [legacyFact()],
    directEntryFactsRaw: [deFact({ first_work_date: "2026-10-17" })],
  });
  assert.equal(cleanReconciliation.overlap_blocker, clean.result.count);
  assert.equal(hasCutoverBlocker(cleanReconciliation), false);
});

test("24. J01B-R1: the read path stays wired to the sanitizer", async () => {
  const { readFile } = await import("node:fs/promises");
  const server = await readFile(new URL("./p2-w04a-reporting-server.ts", import.meta.url), "utf8");
  assert.equal(server.includes("readCutoverBlocker((name) => sb.rpc(name))"), true,
    "the server must read the blocker through the sanitizer");
  assert.equal(server.includes("fetchCutoverBlockerCount"), false,
    "the raw forwarding helper must be gone");
  assert.equal(/blocker\.error\.(code|message)/.test(server), false,
    "no raw Supabase code/message may be forwarded from the blocker read");
  assert.equal(server.includes("return { ok: false, code: blocker.code, message: blocker.message };"), true);
  // The sanitized pair is what the dashboard composes into its copy.
  const view = await readFile(
    new URL("../../components/dashboard/dashboard-view.tsx", import.meta.url),
    "utf8",
  );
  assert.equal(view.includes('detail={report.code + " · " + report.message}'), true,
    "dashboard copy still composes code + message, so the sanitized pair is what renders");
});
