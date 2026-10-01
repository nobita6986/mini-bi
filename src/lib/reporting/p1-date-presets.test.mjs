import assert from "node:assert/strict";
import { test } from "node:test";

import {
  computeDatePresets,
  countActiveFilterCriteria,
  matchDatePreset,
  todayInHoChiMinh,
} from "./p1-date-presets.ts";

// Reference = 2026-10-02 (giữa ngày theo Asia/Ho_Chi_Minh).
const REF = new Date("2026-10-02T12:00:00+07:00");

function preset(key) {
  return computeDatePresets(REF).find((p) => p.key === key);
}

test("1. 7 ngày qua = 09-26 → 10-02", () => {
  assert.deepEqual(preset("last-7-days"), { key: "last-7-days", label: "7 ngày qua", from: "2026-09-26", to: "2026-10-02" });
});

test("2. tuần này = 09-28 → 10-02", () => {
  assert.deepEqual(preset("this-week"), { key: "this-week", label: "Tuần này", from: "2026-09-28", to: "2026-10-02" });
});

test("3. tuần trước = 09-21 → 09-27", () => {
  assert.deepEqual(preset("last-week"), { key: "last-week", label: "Tuần trước", from: "2026-09-21", to: "2026-09-27" });
});

test("4. tháng này = 10-01 → 10-02", () => {
  assert.deepEqual(preset("this-month"), { key: "this-month", label: "Tháng này", from: "2026-10-01", to: "2026-10-02" });
});

test("5. tháng trước = 09-01 → 09-30", () => {
  assert.deepEqual(preset("last-month"), { key: "last-month", label: "Tháng trước", from: "2026-09-01", to: "2026-09-30" });
});

test("6. quý này = 10-01 → 10-02", () => {
  assert.deepEqual(preset("this-quarter"), { key: "this-quarter", label: "Quý này", from: "2026-10-01", to: "2026-10-02" });
});

test("7. quý trước = 07-01 → 09-30", () => {
  assert.deepEqual(preset("last-quarter"), { key: "last-quarter", label: "Quý trước", from: "2026-07-01", to: "2026-09-30" });
});

test("8. boundary Thứ Hai và Chủ Nhật", () => {
  const monday = new Date("2026-09-28T12:00:00+07:00");
  assert.equal(computeDatePresets(monday).find((p) => p.key === "this-week").from, "2026-09-28");
  const sunday = new Date("2026-09-27T12:00:00+07:00");
  assert.equal(computeDatePresets(sunday).find((p) => p.key === "this-week").from, "2026-09-21");
});

test("9. tháng Một → tháng trước thuộc năm trước", () => {
  const jan = new Date("2026-01-15T12:00:00+07:00");
  const p = computeDatePresets(jan).find((x) => x.key === "last-month");
  assert.deepEqual([p.from, p.to], ["2025-12-01", "2025-12-31"]);
});

test("10. Q1 → quý trước thuộc năm trước", () => {
  const feb = new Date("2026-02-15T12:00:00+07:00");
  const p = computeDatePresets(feb).find((x) => x.key === "last-quarter");
  assert.deepEqual([p.from, p.to], ["2025-10-01", "2025-12-31"]);
});

test("11. năm nhuận tháng Hai", () => {
  const mar2024 = new Date("2024-03-01T12:00:00+07:00");
  const p = computeDatePresets(mar2024).find((x) => x.key === "last-month");
  assert.deepEqual([p.from, p.to], ["2024-02-01", "2024-02-29"]);
});

test("12. UTC instant nhưng ngày tại GMT+7 đã sang ngày mới", () => {
  // 17:30Z = 00:30 ngày 03-10 theo GMT+7.
  assert.deepEqual(todayInHoChiMinh(new Date("2026-10-02T17:30:00Z")), { y: 2026, m: 10, d: 3 });
});

test("13. active preset matching", () => {
  assert.equal(matchDatePreset("2026-09-26", "2026-10-02", REF), "last-7-days");
  assert.equal(matchDatePreset("2026-09-01", "2026-09-30", REF), "last-month");
});

test("14. custom range không active", () => {
  assert.equal(matchDatePreset("2026-09-25", "2026-10-01", REF), null);
  assert.equal(matchDatePreset(null, null, REF), null);
});

test("15. countActiveFilterCriteria: date range là một tiêu chí", () => {
  assert.equal(countActiveFilterCriteria({ from: "2026-09-26", to: "2026-10-02" }), 1);
  assert.equal(countActiveFilterCriteria({ from: "2026-09-26", to: "2026-10-02", project: "p", provider: "hrp" }), 3);
  assert.equal(countActiveFilterCriteria({ project: "p", recruiter: "r", source: "s" }), 3);
  assert.equal(countActiveFilterCriteria({}), 0);
});
