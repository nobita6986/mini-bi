import assert from "node:assert/strict";
import test from "node:test";

import { formatEmployeeCode, parseClipboardMatrix, searchRecruiters, validateEmployeeCode } from "./grid-spike-helpers.mjs";

test("employee codes derive their year from the start date and preserve zero padding", () => {
  assert.equal(formatEmployeeCode("2026-03-14", "00042"), "hrp-2026-00042");
  assert.equal(formatEmployeeCode("not-a-date", "00042"), "hrp-????-00042");
  assert.equal(formatEmployeeCode("2026-02-30", "00042"), "hrp-????-00042");
});

test("employee-code validation rejects malformed, wrong-year, and duplicate values", () => {
  assert.equal(validateEmployeeCode("hrp-2026-00042", "2026-03-14"), null);
  assert.match(validateEmployeeCode("hrp-26-42", "2026-03-14"), /dạng/);
  assert.match(validateEmployeeCode("hrp-2025-00042", "2026-03-14"), /Năm/);
  assert.match(validateEmployeeCode("hrp-2026-00042", "2026-03-14", ["hrp-2026-00042"]), /trùng/);
});

test("recruiter search narrows deterministically and filters HRP/vendor groups", () => {
  assert.deepEqual(searchRecruiters("C").map(({ id }) => id), [
    "hrp-001", "hrp-002", "hrp-003", "hrp-004", "hrp-005", "hrp-006",
    "vendor-001", "vendor-002", "vendor-003", "vendor-004", "vendor-005", "hrp-007", "vendor-006",
  ]);
  assert.deepEqual(searchRecruiters("Co").map(({ id }) => id), [
    "vendor-001", "vendor-002", "vendor-003", "vendor-004", "vendor-005",
  ]);
  assert.ok(searchRecruiters("C", "HRP").every(({ group }) => group === "HRP"));
});

test("clipboard parser reads a tabular matrix with quoted tabs and line breaks", () => {
  assert.deepEqual(parseClipboardMatrix('A\t"B\tC"\r\n"D\nE"\tF\r\n'), [
    ["A", "B\tC"],
    ["D\nE", "F"],
  ]);
});
