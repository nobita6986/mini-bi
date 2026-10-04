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

test("dashboard hero keeps its page identity, timestamp and AI actions", () => {
  const src = readFileSync(viewPath, "utf8");
  assert.ok(src.includes("BoD · Báo cáo điều hành"), "must retain the report eyebrow");
  assert.ok(src.includes("Tổng quan tuyển dụng"), "must retain the page title");
  assert.ok(src.includes("Báo cáo tạo lúc"), "must retain the generated timestamp");
  assert.ok(src.includes("<AiReportPanel />"), "must retain the AI report action");
  assert.ok(src.includes("{aiSettingsEnabled ? <AiSettingsPanel /> : null}"), "must retain conditional AI settings");
  assert.ok(src.includes("flex flex-col gap-3 sm:flex-row"), "actions must wrap below the title on mobile");
  assert.ok(src.includes("flex flex-wrap items-start"), "actions must be allowed to wrap");
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
