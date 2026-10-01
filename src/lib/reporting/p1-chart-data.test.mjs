import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildBarData,
  buildCategorySegments,
  buildProjectDonutData,
  buildSourceStatusSegments,
  percentageOfTotal,
  PROJECT_DONUT_MAX_SLICES,
  OTHER_KEY,
  stableColorForKey,
  UNKNOWN_SLOT,
  INVALID_SLOT,
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

test("2. sentinel slot cố định (amber/rose semantic)", () => {
  assert.equal(stableColorForKey("__unknown__"), UNKNOWN_SLOT);
  assert.equal(stableColorForKey("__invalid__"), INVALID_SLOT);
  assert.equal(UNKNOWN_SLOT, "warning");
  assert.equal(INVALID_SLOT, "error");
});

test("2b. category key map deterministic vào chart slot (chart-1..chart-8)", () => {
  const slot = stableColorForKey("dự án a");
  assert.match(slot, /^chart-[1-8]$/);
  assert.equal(stableColorForKey("dự án a"), slot);
  // sentinel không bao giờ là chart slot
  assert.equal(stableColorForKey("__unknown__"), "warning");
  assert.equal(stableColorForKey("__invalid__"), "error");
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
  assert.equal(seg.find((s) => s.key === "__unknown__").color, UNKNOWN_SLOT);
  assert.equal(seg.find((s) => s.key === "__invalid__").color, INVALID_SLOT);
});

test("8. Top 10 không làm thay đổi full list", () => {
  const list = [];
  for (let i = 0; i < 15; i++) list.push(["k" + i, "D" + i, i + 1]);
  const b = buckets(list);
  assert.equal(buildBarData(b, 10).length, 10);
  assert.equal(Object.keys(b).length, 15); // full list không mất
});

test("9. chart view-model không chứa candidate PII", () => {
  const b = buckets([["dự án a", "Dự án A", 7]]);
  const seg = buildCategorySegments(b)[0];
  assert.deepEqual(Object.keys(seg).sort(), ["color", "display", "key", "percent", "value"]);
  const donut = buildProjectDonutData(b)[0];
  assert.deepEqual(Object.keys(donut).sort(), ["color", "display", "isOther", "key", "percent", "value"]);
  const forbidden = ["ho_ten", "full_name", "candidate", "cccd", "sdt", "phone", "email", "raw"];
  for (const k of Object.keys({ ...seg, ...donut })) assert.ok(!forbidden.includes(k));
});

test("10. donut total = recruitedTotal (kể cả sentinel)", () => {
  const b = buckets([["a", "A", 7], ["b", "B", 5], ["__unknown__", "Không xác định", 2], ["__invalid__", "Không hợp lệ", 1]]);
  const slices = buildProjectDonutData(b);
  assert.equal(slices.reduce((x, s) => x + s.value, 0), 15);
});

test("11. 'Khác' gộp phần dự án thường còn lại; full list không mất", () => {
  const list = [];
  for (let i = 0; i < 12; i++) list.push(["k" + i, "D" + i, i + 1]);
  list.push(["__unknown__", "Không xác định", 3]);
  const b = buckets(list);
  const slices = buildProjectDonutData(b);
  // 8 dự án thường + 1 'Khác' + 1 sentinel = 10 lát
  assert.equal(slices.length, PROJECT_DONUT_MAX_SLICES + 2);
  assert.ok(slices.some((s) => s.key === OTHER_KEY));
  const other = slices.find((s) => s.key === OTHER_KEY);
  // phần còn lại = 4 dự án nhỏ nhất (k3..k0 = 4+3+2+1 = 10)
  assert.equal(other.value, 10);
  // tổng mọi lát = tổng bucket = 1..12 (78) + 3 = 81
  assert.equal(slices.reduce((x, s) => x + s.value, 0), 81);
  assert.equal(Object.keys(b).length, 13); // full list vẫn đủ 13 project
});

test("12. unknown/invalid không bị gộp vào 'Khác'", () => {
  const list = [];
  for (let i = 0; i < 10; i++) list.push(["k" + i, "D" + i, 1]);
  list.push(["__unknown__", "Không xác định", 4], ["__invalid__", "Không hợp lệ", 2]);
  const slices = buildProjectDonutData(buckets(list));
  assert.ok(slices.some((s) => s.key === "__unknown__"));
  assert.ok(slices.some((s) => s.key === "__invalid__"));
  const other = slices.find((s) => s.key === OTHER_KEY);
  assert.equal(other.value, 2); // chỉ 2 dự án thường (k8,k9) bị gộp, không gộp sentinel
});

test("13. visible slices không collision màu liền kề", () => {
  // 20 project cùng hash về cùng màu (ép collision) — dùng key giả định.
  const list = [];
  for (let i = 0; i < 20; i++) list.push(["p" + i, "D" + i, 20 - i]);
  const slices = buildProjectDonutData(buckets(list));
  for (let i = 1; i < slices.length; i++) {
    assert.notEqual(slices[i].color, slices[i - 1].color, "lát liền kề trùng màu tại " + i);
  }
});

test("14. tooltip/legend giữ tên đầy đủ (không rút gọn)", () => {
  const b = buckets([["dự án alpha", "Dự án Alpha Beta Gamma Delta", 5]]);
  const slices = buildProjectDonutData(b);
  assert.equal(slices[0].display, "Dự án Alpha Beta Gamma Delta");
  assert.equal(slices[0].key, "dự án alpha");
});
