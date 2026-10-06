/**
 * P2-W04B-R1 — table-driven preflight safety gate test.
 *
 * Exercises the pure `evaluatePreflight` evaluator with a fake DB
 * adapter. The fake executes the closure passed to `withReadOnly` against
 * a literal in-memory result bag, so the test can simulate any stop
 * condition without touching Production.
 *
 * Each `withReadOnly` call is verified to ROLLBACK (i.e. the closure
 * is invoked exactly once and the adapter is then closed), proving
 * the script never leaves an open transaction in any branch.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluatePreflight, STOP_REASONS } from "./p2-w04b-preflight.mjs";

const W04B_FILENAME =
  "20261008030000_p2_w04b_post_purge_cutover_rebaseline.sql";

const FAKE_LOCAL = [
  { name: "20261007020000_p2_w04a_direct_entry_reporting_cutover.sql", checksum: "w04a" },
  { name: "20261008000000_p3_w07a_catalog_bootstrap_personnel.sql", checksum: "w07a" },
  { name: "20261008010000_p3_w07a_r2_catalog_contract_hotfix.sql", checksum: "w07a-r2" },
  { name: "20261008020000_p3_w07b_project_manager_scope.sql", checksum: "w07b" },
  { name: W04B_FILENAME, checksum: "w04b" },
];

const FAKE_LOCAL_44 = [
  ...FAKE_LOCAL,
  ...Array.from({ length: 39 }, (_, i) => ({
    name: `20261000${(100000 + i).toString().padStart(6, "0")}_filler_${i}.sql`,
    checksum: `filler-${i}`,
  })),
];

function buildAdapter(overrides) {
  const calls = { withReadOnly: 0, rolledBack: 0 };
  const q = {
    appliedMigrations: async () => overrides.applied ?? [],
    reconciliationTotals: async () =>
      overrides.totals ?? {
        legacy_subtotal: 0,
        direct_entry_subtotal: 0,
        overlap_blocker: 0,
        cutoff_date: "2026-10-17",
      },
    legacyAll: async () => overrides.legacyAll ?? 0,
    legacyMaskedSubtotal: async () => overrides.legacyMaskedSubtotal ?? 0,
    dePreNewCutoff: async () => overrides.dePreNewCutoff ?? 0,
    deWindow: async () => overrides.deWindow ?? 0,
    dePostOldCutoff: async () => overrides.dePostOldCutoff ?? 0,
    activeNonTestSources: async () => overrides.activeNonTestSources ?? 0,
  };
  const db = {
    async withReadOnly(fn) {
      calls.withReadOnly += 1;
      try {
        return await fn(q);
      } finally {
        calls.rolledBack += 1;
      }
    },
  };
  return { db, calls };
}

// Production has 43 migrations applied (W04B is the single pending one).
const SUCCESS_APPLIED = FAKE_LOCAL_44
  .filter((m) => m.name !== W04B_FILENAME)
  .map((m) => ({ version: m.name, checksum: m.checksum }));

test("P2-W04B-R1 preflight: success fixture passes and rolls back exactly once", async () => {
  const { db, calls } = buildAdapter({ applied: SUCCESS_APPLIED });
  const r = await evaluatePreflight(
    {
      localMigrations: FAKE_LOCAL_44,
      expectedLocalCount: 44,
      expectedProductionCount: 43,
      expectedW04bFilename: W04B_FILENAME,
      oldCutover: "2026-10-17",
    },
    db,
  );
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.summary.local_migration_count, 44);
    assert.equal(r.summary.production_applied_count, 43);
    assert.equal(r.summary.pending_count, 1);
    assert.equal(r.summary.mismatch_count, 0);
    assert.equal(r.summary.legacy_rows_total, 0);
    assert.equal(r.summary.legacy_subtotal_masked, 0);
    assert.equal(r.summary.de_pre_new_cutoff, 0);
    assert.equal(r.summary.active_non_test_sources, 0);
  }
  assert.equal(calls.withReadOnly, 1, "DB adapter called exactly once");
  assert.equal(calls.rolledBack, 1, "DB adapter rolled back exactly once");
});

test("P2-W04B-R1 preflight: STALE_LOCAL_INVENTORY when local count != 44", async () => {
  const { db, calls } = buildAdapter({ applied: SUCCESS_APPLIED });
  const r = await evaluatePreflight(
    {
      localMigrations: FAKE_LOCAL_44.slice(0, 43),
      expectedLocalCount: 44,
      expectedProductionCount: 43,
      expectedW04bFilename: W04B_FILENAME,
      oldCutover: "2026-10-17",
    },
    db,
  );
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, STOP_REASONS.STALE_LOCAL_INVENTORY);
  }
  // Inventory check is pure; the DB must NOT be opened.
  assert.equal(calls.withReadOnly, 0);
});

test("P2-W04B-R1 preflight: PRODUCTION_NOT_AT_43 stops", async () => {
  const { db, calls } = buildAdapter({ applied: SUCCESS_APPLIED.slice(0, 42) });
  const r = await evaluatePreflight(
    {
      localMigrations: FAKE_LOCAL_44,
      expectedLocalCount: 44,
      expectedProductionCount: 43,
      expectedW04bFilename: W04B_FILENAME,
      oldCutover: "2026-10-17",
    },
    db,
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, STOP_REASONS.PRODUCTION_NOT_AT_43);
  assert.equal(calls.withReadOnly, 1);
  assert.equal(calls.rolledBack, 1);
});

test("P2-W04B-R1 preflight: UNEXPECTED_PENDING when an unexpected filename is the only pending one", async () => {
  // 43 applied, but the single missing local migration is W04A (not
  // W04B). W04B is already applied.
  const fillersOnly = FAKE_LOCAL_44.filter(
    (m) => m.name !== W04B_FILENAME && m.name !== FAKE_LOCAL_44[0].name,
  );
  const applied = [...fillersOnly, { version: W04B_FILENAME, checksum: "w04b" }];
  const { db, calls } = buildAdapter({ applied });
  const r = await evaluatePreflight(
    {
      localMigrations: FAKE_LOCAL_44,
      expectedLocalCount: 44,
      expectedProductionCount: 43,
      expectedW04bFilename: W04B_FILENAME,
      oldCutover: "2026-10-17",
    },
    db,
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, STOP_REASONS.UNEXPECTED_PENDING);
  assert.equal(calls.rolledBack, 1);
});

test("P2-W04B-R1 preflight: UNEXPECTED_PENDING when two migrations are pending (pending=2)", async () => {
  // 42 applied (only 42 fillers). Local has 44 (W04A + W04B + 42 fillers).
  // expectedProductionCount is set to 42 so we get past
  // PRODUCTION_NOT_AT_43 and reach the pending check.
  const fillersOnly = FAKE_LOCAL_44.filter(
    (m) => m.name !== W04B_FILENAME && m.name !== FAKE_LOCAL_44[0].name,
  );
  const applied = [...fillersOnly];
  const { db } = buildAdapter({ applied });
  const r = await evaluatePreflight(
    {
      localMigrations: FAKE_LOCAL_44,
      expectedLocalCount: 44,
      expectedProductionCount: 42, // intentionally lower
      expectedW04bFilename: W04B_FILENAME,
      oldCutover: "2026-10-17",
    },
    db,
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, STOP_REASONS.UNEXPECTED_PENDING);
});

test("P2-W04B-R1 preflight: CHECKSUM_MISMATCH stops", async () => {
  const applied = SUCCESS_APPLIED.map((m, idx) =>
    idx === 0 ? { ...m, checksum: "w04a-DRIFT" } : m,
  );
  const { db, calls } = buildAdapter({ applied });
  const r = await evaluatePreflight(
    {
      localMigrations: FAKE_LOCAL_44,
      expectedLocalCount: 44,
      expectedProductionCount: 43,
      expectedW04bFilename: W04B_FILENAME,
      oldCutover: "2026-10-17",
    },
    db,
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, STOP_REASONS.CHECKSUM_MISMATCH);
  assert.equal(calls.rolledBack, 1);
});

test("P2-W04B-R1 preflight: DB_MISSING_LOCAL trips when 43 applied but one of them is phantom", async () => {
  // 43 applied. Composition: W04A + 41 fillers + 1 phantom. Local has
  // 43 (W04A + W04B + 41 fillers). So pending = { W04B } (W04A is in
  // applied, all 41 fillers are in applied, W04B is the only local
  // item missing from applied), and 1 applied item is absent from
  // local (the phantom). expectedLocalCount = 43 to match.
  const fillersOnly = FAKE_LOCAL_44.filter(
    (m) => m.name !== W04B_FILENAME && m.name !== FAKE_LOCAL_44[0].name,
  ); // 42 fillers
  const local43 = [
    FAKE_LOCAL_44[0],
    ...fillersOnly.slice(0, 41).map((m) => ({ name: m.name, checksum: m.checksum })),
    { name: W04B_FILENAME, checksum: "w04b" },
  ];
  const applied = [
    { version: FAKE_LOCAL_44[0].name, checksum: FAKE_LOCAL_44[0].checksum },
    ...fillersOnly.slice(0, 41).map((m) => ({ version: m.name, checksum: m.checksum })),
    { version: "20999999999999_phantom.sql", checksum: "phantom" },
  ];
  const { db, calls } = buildAdapter({ applied });
  const r = await evaluatePreflight(
    {
      localMigrations: local43,
      expectedLocalCount: 43,
      expectedProductionCount: 43,
      expectedW04bFilename: W04B_FILENAME,
      oldCutover: "2026-10-17",
    },
    db,
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, STOP_REASONS.DB_MISSING_LOCAL);
  assert.equal(calls.rolledBack, 1);
});

test("P2-W04B-R1 preflight: CUTOVER_NOT_OLD stops when production cutoff is already 2026-10-06", async () => {
  const { db } = buildAdapter({
    applied: SUCCESS_APPLIED,
    totals: {
      legacy_subtotal: 0,
      direct_entry_subtotal: 0,
      overlap_blocker: 0,
      cutoff_date: "2026-10-06", // already rebaselined
    },
  });
  const r = await evaluatePreflight(
    {
      localMigrations: FAKE_LOCAL_44,
      expectedLocalCount: 44,
      expectedProductionCount: 43,
      expectedW04bFilename: W04B_FILENAME,
      oldCutover: "2026-10-17",
    },
    db,
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, STOP_REASONS.CUTOVER_NOT_OLD);
});

test("P2-W04B-R1 preflight: LEGACY_NOT_ZERO stops when legacy aggregate has rows", async () => {
  const { db } = buildAdapter({
    applied: SUCCESS_APPLIED,
    legacyAll: 3,
    legacyMaskedSubtotal: 7,
  });
  const r = await evaluatePreflight(
    {
      localMigrations: FAKE_LOCAL_44,
      expectedLocalCount: 44,
      expectedProductionCount: 43,
      expectedW04bFilename: W04B_FILENAME,
      oldCutover: "2026-10-17",
    },
    db,
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, STOP_REASONS.LEGACY_NOT_ZERO);
});

test("P2-W04B-R1 preflight: LEGACY_NOT_ZERO trips when masked subtotal is non-zero even if count is 0", async () => {
  // Pathological: every legacy row has business_date >= cutoff, so
  // legacyAll=0 but legacyMaskedSubtotal > 0. The script must still
  // stop because the post-purge invariant is "subtotal=0" not "count=0".
  const { db } = buildAdapter({
    applied: SUCCESS_APPLIED,
    legacyAll: 0,
    legacyMaskedSubtotal: 5,
  });
  const r = await evaluatePreflight(
    {
      localMigrations: FAKE_LOCAL_44,
      expectedLocalCount: 44,
      expectedProductionCount: 43,
      expectedW04bFilename: W04B_FILENAME,
      oldCutover: "2026-10-17",
    },
    db,
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, STOP_REASONS.LEGACY_NOT_ZERO);
});

test("P2-W04B-R1 preflight: DE_PRE_CUTOFF_BLOCKER stops when DE pre 2026-10-06 > 0", async () => {
  const { db } = buildAdapter({
    applied: SUCCESS_APPLIED,
    dePreNewCutoff: 1,
  });
  const r = await evaluatePreflight(
    {
      localMigrations: FAKE_LOCAL_44,
      expectedLocalCount: 44,
      expectedProductionCount: 43,
      expectedW04bFilename: W04B_FILENAME,
      oldCutover: "2026-10-17",
    },
    db,
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, STOP_REASONS.DE_PRE_CUTOFF_BLOCKER);
});

test("P2-W04B-R1 preflight: ACTIVE_SOURCE_NOT_ZERO stops when an active non-test source exists", async () => {
  const { db } = buildAdapter({
    applied: SUCCESS_APPLIED,
    activeNonTestSources: 1,
  });
  const r = await evaluatePreflight(
    {
      localMigrations: FAKE_LOCAL_44,
      expectedLocalCount: 44,
      expectedProductionCount: 43,
      expectedW04bFilename: W04B_FILENAME,
      oldCutover: "2026-10-17",
    },
    db,
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, STOP_REASONS.ACTIVE_SOURCE_NOT_ZERO);
});

test("P2-W04B-R1 preflight: 2026-10-06..2026-10-16 DE band is NOT a blocker under the new contract", async () => {
  const { db, calls } = buildAdapter({
    applied: SUCCESS_APPLIED,
    deWindow: 5, // five eligible DE rows in the new accept-band
  });
  const r = await evaluatePreflight(
    {
      localMigrations: FAKE_LOCAL_44,
      expectedLocalCount: 44,
      expectedProductionCount: 43,
      expectedW04bFilename: W04B_FILENAME,
      oldCutover: "2026-10-17",
    },
    db,
  );
  assert.equal(r.ok, true, "DE in 2026-10-06..2026-10-16 is accepted by the new contract");
  if (r.ok) {
    assert.equal(r.deWindowCount, 5);
    assert.equal(r.summary.de_window_06_to_16, 5);
  }
  assert.equal(calls.rolledBack, 1);
});

test("P2-W04B-R1 preflight: every stop path rolls back the read-only transaction", async () => {
  // Iterate over every STOP_REASONS value; build a fake that triggers
  // the corresponding stop; assert withReadOnly was called and the
  // finally-block incremented the rollback counter.
  const cases = [
    { reason: STOP_REASONS.PRODUCTION_NOT_AT_43, overrides: { applied: [] } },
    // UNEXPECTED_PENDING: 43 applied but the single missing local is W04A, not W04B.
    { reason: STOP_REASONS.UNEXPECTED_PENDING,
      overrides: (() => {
        const fillersOnly = FAKE_LOCAL_44.filter(
          (m) => m.name !== W04B_FILENAME && m.name !== FAKE_LOCAL_44[0].name,
        );
        return { applied: [...fillersOnly, { version: W04B_FILENAME, checksum: "w04b" }] };
      })() },
    { reason: STOP_REASONS.CHECKSUM_MISMATCH,
      overrides: { applied: SUCCESS_APPLIED.map((m) => ({ ...m, checksum: "drift" })) } },
    // DB_MISSING_LOCAL: 43 applied, 1 phantom not in local, W04B pending. expectedLocalCount=43 to match.
    { reason: STOP_REASONS.DB_MISSING_LOCAL,
      overrides: (() => {
        const fillersOnly = FAKE_LOCAL_44.filter(
          (m) => m.name !== W04B_FILENAME && m.name !== FAKE_LOCAL_44[0].name,
        );
        return {
          applied: [
            { version: FAKE_LOCAL_44[0].name, checksum: FAKE_LOCAL_44[0].checksum },
            ...fillersOnly.slice(0, 41).map((m) => ({ version: m.name, checksum: m.checksum })),
            { version: "20999999999999_phantom.sql", checksum: "phantom" },
          ],
          expectedLocalCountOverride: 43,
        };
      })() },
    { reason: STOP_REASONS.CUTOVER_NOT_OLD,
      overrides: { applied: SUCCESS_APPLIED,
        totals: { legacy_subtotal: 0, direct_entry_subtotal: 0, overlap_blocker: 0, cutoff_date: "2026-10-06" } } },
    { reason: STOP_REASONS.LEGACY_NOT_ZERO,
      overrides: { applied: SUCCESS_APPLIED, legacyAll: 1 } },
    { reason: STOP_REASONS.DE_PRE_CUTOFF_BLOCKER,
      overrides: { applied: SUCCESS_APPLIED, dePreNewCutoff: 2 } },
    { reason: STOP_REASONS.ACTIVE_SOURCE_NOT_ZERO,
      overrides: { applied: SUCCESS_APPLIED, activeNonTestSources: 1 } },
  ];
  for (const c of cases) {
    const { db, calls } = buildAdapter(c.overrides);
    const expectedLocal = c.overrides.expectedLocalCountOverride ?? 44;
    const localMigrations = expectedLocal === 43
      ? [
          FAKE_LOCAL_44[0],
          ...FAKE_LOCAL_44.filter(
            (m) => m.name !== W04B_FILENAME && m.name !== FAKE_LOCAL_44[0].name,
          ).slice(0, 41).map((m) => ({ name: m.name, checksum: m.checksum })),
          { name: W04B_FILENAME, checksum: "w04b" },
        ]
      : FAKE_LOCAL_44;
    const r = await evaluatePreflight(
      {
        localMigrations,
        expectedLocalCount: expectedLocal,
        expectedProductionCount: 43,
        expectedW04bFilename: W04B_FILENAME,
        oldCutover: "2026-10-17",
      },
      db,
    );
    assert.equal(r.ok, false, `expected stop for ${c.reason}`);
    if (!r.ok) assert.equal(r.reason, c.reason, `wrong stop for ${c.reason}`);
    assert.equal(calls.withReadOnly, 1, `withReadOnly should have run for ${c.reason}`);
    assert.equal(calls.rolledBack, 1, `rollback should have run for ${c.reason}`);
  }
});

test("P2-W04B-R1 preflight: adapter error during read-only block is re-thrown (DB failure => exit 2)", async () => {
  // The pure evaluator does not catch adapter errors; it surfaces them
  // so the CLI can return exit code 2. We simulate by throwing inside
  // the closure.
  const db = {
    async withReadOnly() {
      throw new Error("connection lost");
    },
  };
  await assert.rejects(
    () =>
      evaluatePreflight(
        {
          localMigrations: FAKE_LOCAL_44,
          expectedLocalCount: 44,
          expectedProductionCount: 43,
          expectedW04bFilename: W04B_FILENAME,
          oldCutover: "2026-10-17",
        },
        db,
      ),
    /connection lost/,
  );
});
