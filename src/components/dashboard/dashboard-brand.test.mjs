import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const logoPath = join(repoRoot, "public", "brand", "hrpartner-logo.png");
const viewPath = join(repoRoot, "src", "components", "dashboard", "dashboard-view.tsx");
const filtersPath = join(repoRoot, "src", "components", "dashboard", "dashboard-filters.tsx");

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test("logo asset exists and is a valid PNG at the trimmed dimensions", () => {
  assert.ok(existsSync(logoPath), "public/brand/hrpartner-logo.png must exist");
  const buf = readFileSync(logoPath);
  assert.ok(buf.length > 0, "logo must not be empty");
  assert.ok(buf.subarray(0, 8).equals(PNG_SIG), "must carry the PNG signature");
  assert.equal(buf.readUInt32BE(16), 2166, "logo width");
  assert.equal(buf.readUInt32BE(20), 1706, "logo height");
});

test("dashboard header renders the logo with fixed dimensions, alt and priority", () => {
  const src = readFileSync(viewPath, "utf8");
  assert.ok(src.includes('src="/brand/hrpartner-logo.png"'), "must reference the public brand asset");
  assert.ok(src.includes('alt="HR Partner"'), "must use the HR Partner alt text");
  assert.ok(src.includes("width={2166}"), "must set explicit width");
  assert.ok(src.includes("height={1706}"), "must set explicit height");
  assert.ok(src.includes("priority"), "must mark the above-the-fold logo priority");
});

test("no local filesystem or Desktop source path leaks into dashboard source", () => {
  const src = readFileSync(viewPath, "utf8");
  assert.ok(!src.includes("logohr"), "must not reference the source filename");
  assert.ok(!src.includes("Desktop"), "must not reference the Desktop directory");
});

test("filter bar uses a single nuqs state and does not scroll on preset change", () => {
  const src = readFileSync(filtersPath, "utf8");
  const calls = src.split("useQueryStates(").length - 1;
  assert.equal(calls, 1, "exactly one filter state object");
  assert.ok(src.includes("scroll: false"), "preset clicks must not scroll to top");
  assert.ok(src.includes("shallow: false"), "filter changes must refetch server data");
});

test("logo plate larger than R5 (h-16 sm:h-20) and not distorted", () => {
  const src = readFileSync(viewPath, "utf8");
  assert.ok(src.includes("h-16"), "plate must be h-16 on mobile");
  assert.ok(src.includes("sm:h-20"), "plate must be sm:h-20 on desktop");
  assert.ok(src.includes('className="h-full w-auto"'), "logo keeps w-auto (no crop/distort)");
  assert.ok(src.includes('bg-white p-1'), "plate stays white in all themes/modes");
});

test("timestamp nằm trong text column, cùng trục trái với title", () => {
  const src = readFileSync(viewPath, "utf8");
  const colStart = src.indexOf('className="min-w-0"');
  const sel = src.indexOf("<ThemeSelector");
  assert.ok(colStart !== -1 && sel !== -1 && sel > colStart, "text column then theme selector");
  const col = src.slice(colStart, sel);
  assert.ok(col.includes("BoD · Báo cáo điều hành"), "label in column");
  assert.ok(col.includes("Tổng quan tuyển dụng"), "title in column");
  assert.ok(col.includes("Báo cáo tạo lúc"), "timestamp in column");
});

test("theme selector được render trong header", () => {
  const src = readFileSync(viewPath, "utf8");
  assert.ok(src.includes("<ThemeSelector"), "ThemeSelector in header");
  const sel = readFileSync(join(repoRoot, "src", "components", "dashboard", "theme-selector.tsx"), "utf8");
  assert.ok(sel.includes("Màu giao diện"), "selector label");
  assert.ok(sel.includes("aria-checked"), "radiogroup uses aria-checked");
});

test("filter bar is non-sticky on mobile, sticky from md, and the advanced disclosure is accessible", () => {
  const src = readFileSync(filtersPath, "utf8");
  assert.ok(src.includes("md:sticky md:top-2 md:z-20"), "sticky behavior starts at the md breakpoint");
  assert.ok(!src.includes('className="sticky '), "mobile must keep the filter bar in normal document flow");
  assert.ok(src.includes("md:backdrop-blur"), "backdrop blur only applies with desktop sticky behavior");
  assert.ok(src.includes("aria-expanded={advancedOpen}"), "disclosure must expose expanded state");
  assert.ok(src.includes('aria-controls="advanced-filters"'), "disclosure must point at the panel");
  assert.ok(src.includes('id="advanced-filters"'), "panel id must match aria-controls");
  assert.ok(src.includes("hidden={!advancedOpen}"), "panel hidden unless opened");
});
