import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const view = readFileSync(join(here, "dashboard-view.tsx"), "utf8");
const filters = readFileSync(join(here, "dashboard-filters.tsx"), "utf8");

test("dashboard omits legacy source-status UI and copy", () => {
  const loweredView = view.toLocaleLowerCase();
  for (const text of [
    "Trạng thái dữ liệu cần lưu ý",
    "Nguồn báo cáo",
    "Độ phủ dữ liệu",
    "Trạng thái nguồn dữ liệu",
    "Chưa có nguồn dữ liệu",
    "Chưa có nguồn báo cáo nào",
    "Khi n8n chạy workflow lần đầu",
    "Có nguồn nhưng chưa có dữ liệu tuyển dụng",
    "Google Sheets",
    "nguồn",
    "daily_recruitment_breakdown",
    "snapshot",
    "n8n",
    "đồng bộ",
  ]) {
    assert.ok(!loweredView.includes(text.toLocaleLowerCase()), `dashboard must not include "${text}"`);
  }
});

test("empty report uses a neutral recruitment-data message", () => {
  assert.ok(view.includes("data.empty.noSources || data.empty.noFacts"));
  assert.ok(view.includes('title="Chưa có dữ liệu tuyển dụng"'));
  assert.ok(view.includes("Hiện chưa có dữ liệu để hiển thị."));
});

test("remaining business dashboard KPIs and charts stay rendered", () => {
  for (const label of [
    "Tổng tuyển mới",
    "Số ngày có tuyển",
    "Xu hướng tuyển dụng",
    "Theo dự án",
    "Theo HRP/Vendor",
    "Tỷ lệ HRP/Vendor theo dự án",
    "Theo người tuyển",
    "Theo loại hình làm việc",
  ]) {
    assert.ok(view.includes(label), `dashboard must keep "${label}"`);
  }
  assert.ok(view.includes("grid-cols-1 gap-3 sm:grid-cols-2"));
});

test("legacy source filter is hidden while its URL parser remains compatible", () => {
  assert.ok(filters.includes("source: parseAsString"));
  assert.ok(!filters.includes('<Field id="f-source"'));
  assert.ok(!filters.includes("options.sources"));
});
