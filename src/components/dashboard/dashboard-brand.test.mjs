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
const appShellPath = join(repoRoot, "src", "components", "app-shell", "app-shell.tsx");
const themeSelectorPath = join(repoRoot, "src", "components", "dashboard", "theme-selector.tsx");

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test("logo asset remains in the repository and is a valid PNG", () => {
  assert.ok(existsSync(logoPath), "public/brand/hrpartner-logo.png must exist");
  const buf = readFileSync(logoPath);
  assert.ok(buf.length > 0, "logo must not be empty");
  assert.ok(buf.subarray(0, 8).equals(PNG_SIG), "must carry the PNG signature");
  assert.equal(buf.readUInt32BE(16), 2166, "logo width");
  assert.equal(buf.readUInt32BE(20), 1706, "logo height");
});

test("dashboard hero does not duplicate the global logo or theme selector", () => {
  const src = readFileSync(viewPath, "utf8");
  assert.ok(!src.includes('from "next/image"'), "dashboard must not import next/image");
  assert.ok(!src.includes("<Image"), "dashboard must not render the logo image");
  assert.ok(!src.includes("/brand/hrpartner-logo.png"), "dashboard must not render the global logo asset");
  assert.ok(!src.includes("ThemeSelector"), "dashboard must not import or render ThemeSelector");
});

test("AppShell remains the single global home for HR Partner brand and ThemeSelector", () => {
  const src = readFileSync(appShellPath, "utf8");
  assert.ok(src.includes("<span>HR Partner</span>"), "AppShell must retain the global brand");
  assert.ok(src.includes('import { ThemeSelector } from "@/components/dashboard/theme-selector"'));
  assert.ok(src.includes("<ThemeSelector />"), "AppShell must retain the global theme selector");
  assert.equal(src.split("<ThemeSelector />").length - 1, 1, "AppShell must render one ThemeSelector");
  assert.ok(src.includes('src="/brand/hrpartner-logo.png"'));
  assert.ok(src.includes('alt="HR Partner"'));
  assert.ok(src.includes("width={2166}") && src.includes("height={1706}"));
  assert.ok(!src.includes("rounded-md bg-primary"), "AppShell must not render a placeholder logo");
  assert.ok(src.includes("max-w-6xl") && !src.includes("max-w-7xl"));
  assert.ok(src.includes("min-h-14") && src.includes("px-4") && src.includes("sm:px-6"));
  assert.equal(src.split("{headerActions}").length - 1, 1, "headerActions must have one render site");
  assert.ok(!src.includes("overflow-hidden"), "navbar ancestors must not clip the theme menu");
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

test("dashboard hero keeps its identity/timestamp and renders the existing compact KPIs", () => {
  const src = readFileSync(viewPath, "utf8");
  assert.ok(src.includes("BoD · Báo cáo điều hành"), "must retain the report eyebrow");
  assert.ok(src.includes("Tổng quan tuyển dụng"), "must retain the page title");
  assert.ok(src.includes("Báo cáo tạo lúc"), "must retain the generated timestamp");
  assert.ok(!src.includes("AiReportPanel") && !src.includes("AiSettingsPanel"));
  assert.equal(src.split('label="Tổng tuyển mới"').length - 1, 1);
  assert.equal(src.split('label="Số ngày có tuyển"').length - 1, 1);
  assert.equal(src.split('variant="compact"').length - 1, 2);
  assert.ok(src.includes("showKpis ?"));
});

test("theme selector is portaled above the dashboard and keeps keyboard/dismiss behavior", () => {
  const src = readFileSync(themeSelectorPath, "utf8");
  assert.ok(src.includes("createPortal(") && src.includes("document.body"));
  assert.ok(src.includes('className="fixed z-[100]'));
  assert.ok(src.includes("max-h-[calc(100dvh-1rem)]"));
  assert.ok(src.includes('e.key === "Escape"'));
  assert.ok(src.includes('e.key !== "ArrowDown" && e.key !== "ArrowUp"'));
  assert.ok(src.includes('[role="radio"][aria-checked="true"]') && src.includes("?.focus()"));
  assert.ok(src.includes('document.addEventListener("mousedown", onDown)'));
  assert.ok(src.includes('aria-label="Chọn màu giao diện"'),
    "swatch-only trigger must retain an accessible name");
  assert.ok(!src.includes("<span>Màu giao diện</span>"),
    "compact trigger must not render the visual label");
  assert.ok(!src.includes('{open ? "▾" : "▸"}'),
    "compact trigger must contain only the three color swatches");
  assert.equal(src.split("<ThemeSelector").length - 1, 0, "ThemeSelector source must not nest another selector");
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
