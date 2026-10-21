/**
 * R2.1 — Explicit CI Test Manifest & Zero-Orphan Discovery Guard.
 *
 * Every `*.test.mjs` file under `src/` and `scripts/` MUST be accounted for in one of:
 *   1. `CI_PGLITE` — Active CI shard execution via `package.json` `scripts.test` (Shards 1..6)
 *   2. `CI_POSTGRES` — Real PostgreSQL 16 service-container execution (`POSTGRES_TEST_FILES`)
 *   3. `NON_CI_CLASSIFIED_TESTS` — Explicitly classified non-CI tests with a documented
 *      category (`HISTORICAL_RELEASE_ACCEPTANCE` or `UI_SOURCE_PINNED` or `MANUAL_UAT_HARNESS`)
 *      and rationale.
 *
 * Any unclassified `*.test.mjs` file (or stale manifest entry pointing to a deleted or
 * already-promoted CI file) fails closed in `assertZeroOrphanTests()`.
 */
import { readdirSync } from "node:fs";
import path from "node:path";

export const TEST_MANIFEST_CATEGORIES = Object.freeze([
  "CI_PGLITE",
  "CI_POSTGRES",
  "HISTORICAL_RELEASE_ACCEPTANCE",
  "UI_SOURCE_PINNED",
  "MANUAL_UAT_HARNESS",
]);

/**
 * Explicit registry of `*.test.mjs` files intentionally excluded from default CI shards,
 * with their classification category and architectural rationale.
 *
 * Note: 23 active unit/API/auth tests from the 40 historical non-CI files surveyed in
 * T2-Survey were promoted into active `CI_PGLITE` via `test:r2-1` in R2.1. The remaining
 * 17 files are explicitly classified below.
 */
export const NON_CI_CLASSIFIED_TESTS = Object.freeze({
  "scripts/p2-w04a-acceptance.test.mjs": {
    category: "HISTORICAL_RELEASE_ACCEPTANCE",
    rationale: "P2-W04A historical cutover acceptance suite pinned to pre-R1 schema/cutover state.",
  },
  "scripts/p2-w04a-migration.test.mjs": {
    category: "HISTORICAL_RELEASE_ACCEPTANCE",
    rationale: "P2-W04A historical migration #40 snapshot test superseded by later reporting migrations.",
  },
  "scripts/p2-w04a-reconcile-verify.test.mjs": {
    category: "HISTORICAL_RELEASE_ACCEPTANCE",
    rationale: "P2-W04A one-time reconciliation CLI verification harness.",
  },
  "scripts/p2-w04b-preflight.test.mjs": {
    category: "HISTORICAL_RELEASE_ACCEPTANCE",
    rationale: "P2-W04B historical cutover preflight check.",
  },
  "scripts/p3-first-owner-bootstrap.test.mjs": {
    category: "HISTORICAL_RELEASE_ACCEPTANCE",
    rationale: "P3 initial owner bootstrap test superseded by S0/R1 account management.",
  },
  "scripts/p3-w07a-catalog-bootstrap.test.mjs": {
    category: "HISTORICAL_RELEASE_ACCEPTANCE",
    rationale: "P3-W07A initial catalog bootstrap test superseded by P3.1 dynamic catalog migrations.",
  },
  "scripts/p3-w07a-catalog-projection.test.mjs": {
    category: "HISTORICAL_RELEASE_ACCEPTANCE",
    rationale: "P3-W07A static catalog projection test superseded by P3.1 dynamic catalogs.",
  },
  "src/components/auth/access-denied.test.mjs": {
    category: "HISTORICAL_RELEASE_ACCEPTANCE",
    rationale: "P3-W03-S02B source-regex test superseded by P3-W06A resolveActorForRequest and direct-entry-page-access.test.mjs.",
  },
  "src/lib/reporting/p2-w04a-cutover.test.mjs": {
    category: "HISTORICAL_RELEASE_ACCEPTANCE",
    rationale: "P2-W04A cutover source-inspection test superseded by P3-W05A actor-scoped reporting.",
  },
  "src/components/direct-entry/direct-entry-h05-r1-ui-gaps.test.mjs": {
    category: "HISTORICAL_RELEASE_ACCEPTANCE",
    rationale: "P1.7-H05-R1 historical release acceptance test pinned to pre-W2/P3.1 spreadsheet/live TSX strings.",
  },
  "src/components/direct-entry/direct-entry-h06-row-actions.test.mjs": {
    category: "HISTORICAL_RELEASE_ACCEPTANCE",
    rationale: "P1.7-H06 historical release acceptance test pinned to pre-W2/R1 row-action TSX strings.",
  },
  "src/components/direct-entry/direct-entry-h07-session-grid-ux.test.mjs": {
    category: "HISTORICAL_RELEASE_ACCEPTANCE",
    rationale: "P1.7-H07 historical release acceptance test pinned to pre-P3.1 save-button/grid TSX strings.",
  },
  "src/components/direct-entry/direct-entry-h08-r1-defaults-text-regression.test.mjs": {
    category: "HISTORICAL_RELEASE_ACCEPTANCE",
    rationale: "P1.7-H08-R1 historical release acceptance test superseded by P3.1 dynamic labor-type catalog and R2.2 promoted UI tests.",
  },
});

export function discoverRepoTestFiles(rootDir = process.cwd()) {
  const walk = (relDir) => {
    const absDir = path.join(rootDir, relDir);
    return readdirSync(absDir, { withFileTypes: true }).flatMap((entry) => {
      const relPath = path.posix.join(relDir, entry.name);
      if (entry.isDirectory()) return walk(relPath);
      if (entry.isFile() && entry.name.endsWith(".test.mjs")) return [relPath];
      return [];
    });
  };
  return [...walk("src"), ...walk("scripts")].sort();
}

export function assertZeroOrphanTests({
  rootDir = process.cwd(),
  ciTestFiles,
  postgresTestFiles,
}) {
  const allRepoTests = discoverRepoTestFiles(rootDir);
  const allRepoSet = new Set(allRepoTests);
  const activeCiSet = new Set(
    [...ciTestFiles].map((file) => path.posix.normalize(file.replaceAll("\\", "/"))),
  );
  const pgSet = new Set(
    [...postgresTestFiles].map((file) => path.posix.normalize(file.replaceAll("\\", "/"))),
  );

  const orphans = [];
  for (const testFile of allRepoTests) {
    const inActiveCi = activeCiSet.has(testFile);
    const classified = NON_CI_CLASSIFIED_TESTS[testFile];
    if (!inActiveCi && !classified) {
      orphans.push(testFile);
    }
  }

  const staleManifestEntries = [];
  for (const [testFile, meta] of Object.entries(NON_CI_CLASSIFIED_TESTS)) {
    if (!allRepoSet.has(testFile)) {
      staleManifestEntries.push(`${testFile} (file does not exist)`);
    } else if (activeCiSet.has(testFile)) {
      staleManifestEntries.push(`${testFile} (already in active CI scripts.test; remove from NON_CI_CLASSIFIED_TESTS)`);
    } else if (!TEST_MANIFEST_CATEGORIES.includes(meta?.category) || !meta?.rationale) {
      staleManifestEntries.push(`${testFile} (invalid category or missing rationale)`);
    }
  }

  for (const pgFile of pgSet) {
    if (!activeCiSet.has(pgFile)) {
      staleManifestEntries.push(`${pgFile} (in POSTGRES_TEST_FILES but missing from scripts.test)`);
    }
  }

  if (orphans.length > 0 || staleManifestEntries.length > 0) {
    const details = [
      orphans.length > 0 ? `Unclassified orphan *.test.mjs files (${orphans.length}):\n  - ${orphans.join("\n  - ")}` : "",
      staleManifestEntries.length > 0
        ? `Stale/invalid manifest entries (${staleManifestEntries.length}):\n  - ${staleManifestEntries.join("\n  - ")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
    throw new Error(`CI Zero-Orphan test manifest check failed:\n${details}`);
  }

  return {
    totalRepoTests: allRepoTests.length,
    activeCiTests: activeCiSet.size,
    postgresTests: pgSet.size,
    pgliteTests: activeCiSet.size - pgSet.size,
    nonCiClassifiedTests: Object.keys(NON_CI_CLASSIFIED_TESTS).length,
  };
}
