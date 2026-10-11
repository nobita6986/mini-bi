import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  activeLaborTypeLabel,
  firstActiveLaborTypeKey,
  sortedActiveLaborTypes,
} from "./labor-type-catalog-ui.ts";
import {
  activateSpreadsheetRowLazyDefaults,
  createSpreadsheetRowModel,
  updateSpreadsheetRowCells,
} from "./spreadsheet-row-model.ts";

const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const OPTIONS = [
  { labor_type_key: "LATER", display_name: "Zeta", sort_order: 2 },
  { labor_type_key: "PROBATION", display_name: "Beta", sort_order: 1 },
  { labor_type_key: "PERMANENT", display_name: "Alpha", sort_order: 1 },
];

test("active labor types sort deterministically and empty catalog has no default", () => {
  assert.deepEqual(sortedActiveLaborTypes(OPTIONS).map(({ labor_type_key }) =>
    labor_type_key), ["PERMANENT", "PROBATION", "LATER"]);
  assert.equal(firstActiveLaborTypeKey(OPTIONS), "PERMANENT");
  assert.deepEqual(sortedActiveLaborTypes(undefined), []);
  assert.equal(firstActiveLaborTypeKey([]), "");
});

test("canonical pnpm test invokes the focused W02C UI lane exactly once", () => {
  const scripts = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")).scripts;
  assert.equal(scripts["test:p3-1-w02c-ui-dynamic-catalog"].includes(
    "labor-type-catalog-ui.test.mjs"), true);
  assert.equal((scripts.test.match(/pnpm test:p3-1-w02c-ui-dynamic-catalog/g) ?? []).length, 1);
});

test("grid defaults from active catalog once and never silently remaps on reload", () => {
  const initial = createSpreadsheetRowModel();
  const rowId = initial.rows[0].clientRowId;
  const activated = activateSpreadsheetRowLazyDefaults(
    initial, rowId, new Date("2026-10-15T00:00:00Z"), firstActiveLaborTypeKey(OPTIONS),
  );
  assert.equal(activated.rows[0].cells.labor_type, "PERMANENT");

  const edited = updateSpreadsheetRowCells(activated, rowId, { labor_type: "PROBATION" });
  const reload = activateSpreadsheetRowLazyDefaults(
    edited, rowId, new Date("2026-10-16T00:00:00Z"), firstActiveLaborTypeKey([OPTIONS[2]]),
  );
  assert.equal(reload.rows[0].cells.labor_type, "PROBATION");
  assert.equal(activeLaborTypeLabel([OPTIONS[2]], reload.rows[0].cells.labor_type), null);
});

test("Direct Entry consumers use active catalog keys and server display projections", () => {
  const grid = source("../../components/direct-entry/direct-entry-spreadsheet-grid.tsx");
  const live = source("../../components/direct-entry/direct-entry-live.tsx");
  const worker = source("../../components/direct-entry/worker-operations.tsx");
  const proposer = source("../../components/direct-entry/direct-entry-change-request-proposer.tsx");
  const reviewer = source("../../components/direct-entry/direct-entry-change-request-reviewer.tsx");
  const paste = source("../../components/direct-entry/direct-entry-excel-paste-dialog.tsx");
  const profilePaste = source("../../components/direct-entry/direct-entry-worker-profile-paste-dialog.tsx");
  const xlsx = source("./worker-profile-xlsx.ts");
  const profilePreview = source("./worker-profile-preview.ts");

  for (const ui of [grid, live, worker, proposer, reviewer, paste, profilePaste]) {
    assert.doesNotMatch(ui, /LABOR_TYPE_LABELS|DIRECT_ENTRY_LABOR_TYPE_OPTIONS/);
    assert.doesNotMatch(ui, /["'](?:TEMPORARY|PERMANENT)["']/);
  }
  assert.match(grid, /sortedActiveLaborTypes\(rowCatalogs\?\.laborTypes\)/);
  assert.match(grid, /option\.labor_type_key/);
  assert.match(grid, /option\.display_name/);
  assert.match(grid, /không còn hoạt động/);
  assert.match(live, /firstActiveLaborTypeKey/);
  assert.match(live, /sortedActiveLaborTypes\(selectedRowCatalog\?\.labor_types\)/);
  assert.match(live, /!hasActiveLaborTypes/);
  assert.match(live, /disabled=\{loadState !== "ready" \|\| stagedBusy \|\| !hasActiveLaborTypes\}/);
  assert.match(worker, /labor_type_display/);
  assert.match(worker, /sortedActiveLaborTypes\(entryCatalog\?\.labor_types\)/);
  assert.match(worker, /labor_type_key/);
  assert.match(proposer, /labor_type_display/);
  assert.match(proposer, /sortedActiveLaborTypes\(catalog\?\.labor_types\)/);
  assert.match(reviewer, /field === "labor_type"\s*\) return authoritativeDisplay \?\? null/);
  assert.match(paste, /laborTypes/);
  assert.match(profilePreview, /labor_types/);
  assert.match(profilePaste, /buildWorkerProfilePreview/);
  assert.match(profilePaste, /labor_types: \(catalog\.labor_types \?\? \[\]\)\.map/);
  assert.doesNotMatch(xlsx, /formulae:.*(?:TEMPORARY|PERMANENT|Thời vụ|Chính thức)/);
});
