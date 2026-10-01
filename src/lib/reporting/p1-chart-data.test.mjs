import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildBarData,
  buildCategorySegments,
  buildSourceStatusSegments,
  buildTreemapData,
  percentageOfTotal,
  stableColorForKey,
  UNKNOWN_COLOR,
  INVALID_COLOR,
} from "./p1-chart-data.ts";

function src(id, status) {
  return {
    id,
    drive_file_id: "d_" + id,
    fileName: "F" + id + ".xlsx",
    latestRunStatus: null,
    lastSuccessfulSyncAt: null,
    lastSeenAt: null,
    everSucceeded: false,
    hasCurrentFacts: false,
    contributes: false,
    status,
  };
}

function buckets(list) {
  const out = {};
  for (const [key, display, recruitedCount] of list) out[key] = { key, display, recruitedCount };
  return out;
}

test("1. stableColorForKey: cùng key luôn cùng màu, không phụ thuộc thứ tự", () => {
  const keys = ["dự án a", "dự án b", "dự án c", "dự án a"];
  const colors = keys.map(stableColorForKey);
  assert.equal(colors[0], colors[3]); // same key -> same color
  // deterministic across repeated calls
  assert.equal(stableColorForKey("dự án a"), stableColorForKey("dự án a"));
});

test("2. sentinel colors cố định", () => {
  assert.equal(stableColorForKey("__unknown__"), UNKNOWN_COLOR);
  assert.equal(stableColorForKey("__invalid__"), INVALID_COLOR);
  assert.equal(UNKNOWN_COLOR, "#f59e0b");
  assert.equal(INVALID_COLOR, "#f43f5e");
});

test("3. donut (provider) total = recruitedTotal", () => {
  const b = buckets([["hrp", "HRP", 7], ["vendor", "Vendor", 7], ["__unknown__", "Không xác định", 1], ["__invalid__", "Không hợp lệ", 3]]);
  const seg = buildCategorySegments(b);
  assert.equal(seg.reduce((a, s) => a + s.value, 0), 18);
});

test("4. employment composition total = recruitedTotal", () => {
  const b = buckets([["thời vụ", "Thời vụ", 8], ["chính thức", "Chính thức", 5], ["__unknown__", "Không xác định", 1], ["__invalid__", "Không hợp lệ", 4]]);
  const seg = buildCategorySegments(b);
  assert.equal(seg.reduce((a, s) => a + s.value, 0), 18);
});

test("5. source status segments đúng số nguồn", () => {
  const sources = [
    src("1", "covered"), src("2", "covered"),
    src("3", "incomplete"),
    src("4", "stale_snapshot"), src("5", "never_succeeded"),
    src("6", "running"),
    src("7", "no_run"),
  ];
  const seg = buildSourceStatusSegments(sources);
  assert.equal(seg.reduce((a, s) => a + s.count, 0), 7);
  assert.equal(seg[0].count, 2); // Đã đồng bộ
  assert.equal(seg[1].count, 1); // Chưa đầy đủ
  assert.equal(seg[2].count, 2); // Lỗi (stale + never)
  assert.equal(seg[3].count, 1); // Đang đồng bộ
  assert.equal(seg[4].count, 1); // Chưa chạy
});

test("6. percentageOfTotal total=0 không NaN/Infinity", () => {
  assert.equal(percentageOfTotal(5, 0), 0);
  assert.equal(percentageOfTotal(0, 0), 0);
  assert.equal(percentageOfTotal(1, 2), 50);
  const seg = buildCategorySegments({});
  assert.ok(seg.every((s) => Number.isFinite(s.percent)));
});

test("7. unknown/invalid vẫn xuất hiện trong segments", () => {
  const b = buckets([["hrp", "HRP", 5], ["__unknown__", "Không xác định", 2], ["__invalid__", "Không hợp lệ", 1]]);
  const seg = buildCategorySegments(b);
  assert.ok(seg.some((s) => s.key === "__unknown__"));
  assert.ok(seg.some((s) => s.key === "__invalid__"));
  assert.equal(seg.find((s) => s.key === "__unknown__").color, UNKNOWN_COLOR);
  assert.equal(seg.find((s) => s.key === "__invalid__").color, INVALID_COLOR);
});

test("8. Top 10 không làm thay đổi full list", () => {
  const list = [];
  for (let i = 0; i < 15; i++) list.push(["k" + i, "D" + i, i + 1]);
  const b = buckets(list);
  assert.equal(buildTreemapData(b, 10).length, 10);
  assert.equal(buildBarData(b, 10).length, 10);
  assert.equal(Object.keys(b).length, 15); // full list không mất
});

test("9. chart view-model không chứa candidate PII", () => {
  const b = buckets([["dự án a", "Dự án A", 7]]);
  const seg = buildCategorySegments(b)[0];
  assert.deepEqual(Object.keys(seg).sort(), ["color", "display", "key", "percent", "value"]);
  const treemap = buildTreemapData(b, 1)[0];
  assert.deepEqual(Object.keys(treemap).sort(), ["color", "key", "name", "size"]);
  const forbidden = ["ho_ten", "full_name", "candidate", "cccd", "sdt", "phone", "email", "raw"];
  for (const k of Object.keys({ ...seg, ...treemap })) assert.ok(!forbidden.includes(k));
});
