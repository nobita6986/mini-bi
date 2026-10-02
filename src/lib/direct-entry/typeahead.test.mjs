import assert from "node:assert/strict";
import test from "node:test";

import {
  matchTypeaheadIds,
  moveTypeaheadIndex,
  typeaheadKeyAction,
} from "./typeahead.ts";

const options = [
  { id: "rec-hrp-1", label: "CongHr1", groupLabel: "HRP · Team Bắc" },
  { id: "rec-hrp-2", label: "CongHr2", groupLabel: "HRP · Team Nam" },
  { id: "rec-vendor-1", label: "ChungVendor", groupLabel: "Vendor · Team Bắc" },
  { id: "team-north", label: "Công ty Bắc", groupLabel: "Team" },
  { id: "bank-north", label: "Công Thương Bắc", groupLabel: "Bank" },
];

test("matches case-insensitively by Vietnamese NFC text and returns stable IDs only", () => {
  assert.deepEqual(matchTypeaheadIds(options, "C"), [
    "rec-hrp-1", "rec-hrp-2", "rec-vendor-1", "team-north", "bank-north",
  ]);
  assert.deepEqual(matchTypeaheadIds(options, "Co"), ["rec-hrp-1", "rec-hrp-2"]);
  assert.deepEqual(matchTypeaheadIds(options, "cOnGhR1"), ["rec-hrp-1"]);
  assert.deepEqual(matchTypeaheadIds(options, "Công"), ["team-north", "bank-north"]);
  assert.deepEqual(matchTypeaheadIds(options, "Co\u0302ng"), ["team-north", "bank-north"]);
  assert.ok(matchTypeaheadIds(options, "Co").every((value) =>
    options.some(({ id }) => id === value),
  ));
});

test("keyboard actions wrap, commit explicitly, and do not commit during IME composition", () => {
  assert.equal(moveTypeaheadIndex(-1, 3, "down"), 0);
  assert.equal(moveTypeaheadIndex(2, 3, "down"), 0);
  assert.equal(moveTypeaheadIndex(-1, 3, "up"), 2);
  assert.equal(moveTypeaheadIndex(0, 3, "up"), 2);
  assert.equal(moveTypeaheadIndex(0, 0, "down"), -1);
  assert.equal(typeaheadKeyAction("ArrowDown", false), "down");
  assert.equal(typeaheadKeyAction("ArrowUp", false), "up");
  assert.equal(typeaheadKeyAction("Enter", false), "commit");
  assert.equal(typeaheadKeyAction("Escape", false), "close");
  assert.equal(typeaheadKeyAction("Tab", false), "tab");
  assert.equal(typeaheadKeyAction("Enter", true), "ignore");
  assert.equal(typeaheadKeyAction("ArrowDown", true), "ignore");
  assert.equal(typeaheadKeyAction("x", false), null);
});
