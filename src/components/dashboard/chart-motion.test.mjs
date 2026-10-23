import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");

function resolveCandidatePath(basePath) {
  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}.js`,
    `${basePath}.mjs`,
    path.join(basePath, "index.ts"),
    path.join(basePath, "index.tsx"),
  ];
  return (
    candidates.find((candidate) => {
      try {
        return existsSync(candidate) && statSync(candidate).isFile();
      } catch {
        return false;
      }
    }) ?? null
  );
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      const target = resolveCandidatePath(path.join(repoRoot, "src", specifier.slice(2)));
      if (target) {
        return { url: pathToFileURL(target).href, shortCircuit: true };
      }
    }
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      context.parentURL?.startsWith("file:") &&
      !context.parentURL.includes("/node_modules/") &&
      !context.parentURL.includes("\\node_modules\\")
    ) {
      const parentDir = path.dirname(fileURLToPath(context.parentURL));
      const target = resolveCandidatePath(path.resolve(parentDir, specifier));
      if (target) {
        return { url: pathToFileURL(target).href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("file:") && (url.endsWith(".ts") || url.endsWith(".tsx"))) {
      const filePath = fileURLToPath(url);
      const sourceText = readFileSync(filePath, "utf8");
      const transpiled = ts.transpileModule(sourceText, {
        fileName: filePath,
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          moduleResolution: ts.ModuleResolutionKind.Bundler,
          jsx: ts.JsxEmit.ReactJSX,
          target: ts.ScriptTarget.ES2022,
        },
      });
      return {
        format: "module",
        source: transpiled.outputText,
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

const {
  CHART_ANIMATION_DURATION_MS,
  CHART_ANIMATION_EASING,
  CHART_RAPID_UPDATE_COOLDOWN_MS,
  CHART_MAX_ANIMATED_TREND_POINTS,
  CHART_MAX_ANIMATED_BAR_ITEMS,
  CHART_MAX_ANIMATED_DONUT_SLICES,
  buildTrendDatasetSignature,
  buildBarDatasetSignature,
  buildDonutDatasetSignature,
  createChartMotionTracker,
  prefersReducedMotion,
} = await import("./chart-motion.ts");

const { ThemeProvider } = await import("@/lib/theme/theme-provider");
const { TrendChart } = await import("./trend-chart.tsx");
const { RecruiterBarChart } = await import("./recruiter-bar-chart.tsx");
const { ProjectDonut } = await import("./project-donut.tsx");
const { ProviderDonut } = await import("./provider-donut.tsx");

describe("UIUX S2-01 — Controlled Chart Data Animation", () => {
  it("disables animation on SSR / unmounted and initial mounted render, then animates only on valid dataset change", () => {
    let nowMs = 1_000;
    const tracker = createChartMotionTracker({
      now: () => nowMs,
      isReducedMotion: () => false,
    });

    const dsA = buildTrendDatasetSignature(
      [
        { date: "2026-10-01", count: 4 },
        { date: "2026-10-02", count: 7 },
      ],
      { from: "2026-10-01", to: "2026-10-02" },
    );

    // 1. Unmounted SSR pass -> initial-mount, does not commit
    const unmountedDecision = tracker.evaluate({
      chartId: "trend",
      mounted: false,
      signature: dsA.signature,
      valid: dsA.valid,
      itemCount: dsA.itemCount,
      maxItems: CHART_MAX_ANIMATED_TREND_POINTS,
    });
    assert.equal(unmountedDecision.isAnimationActive, false);
    assert.equal(unmountedDecision.reason, "initial-mount");

    // 2. First mounted pass -> still initial-mount (never animates from 0 on mount), commits dsA
    const initialMountDecision = tracker.evaluate({
      chartId: "trend",
      mounted: true,
      signature: dsA.signature,
      valid: dsA.valid,
      itemCount: dsA.itemCount,
      maxItems: CHART_MAX_ANIMATED_TREND_POINTS,
    });
    assert.equal(initialMountDecision.isAnimationActive, false);
    assert.equal(initialMountDecision.reason, "initial-mount");

    // 3. Re-render with identical dataset (e.g. theme change, resize, resolution toggle) -> unchanged-dataset
    const unchangedDecision = tracker.evaluate({
      chartId: "trend",
      mounted: true,
      signature: dsA.signature,
      valid: dsA.valid,
      itemCount: dsA.itemCount,
      maxItems: CHART_MAX_ANIMATED_TREND_POINTS,
    });
    assert.equal(unchangedDecision.isAnimationActive, false);
    assert.equal(unchangedDecision.reason, "unchanged-dataset");

    // 4. Filter/period change produces a new valid dataset -> animates (340ms, ease-out)
    const dsB = buildTrendDatasetSignature(
      [
        { date: "2026-10-01", count: 9 },
        { date: "2026-10-02", count: 12 },
      ],
      { from: "2026-10-01", to: "2026-10-02" },
    );
    const changedDecision = tracker.evaluate({
      chartId: "trend",
      mounted: true,
      signature: dsB.signature,
      valid: dsB.valid,
      itemCount: dsB.itemCount,
      maxItems: CHART_MAX_ANIMATED_TREND_POINTS,
    });
    assert.equal(changedDecision.isAnimationActive, true);
    assert.equal(changedDecision.animationDuration, CHART_ANIMATION_DURATION_MS);
    assert.ok(
      CHART_ANIMATION_DURATION_MS >= 300 && CHART_ANIMATION_DURATION_MS <= 400,
      "Chart animation duration must be within 300-400ms",
    );
    assert.equal(changedDecision.animationEasing, CHART_ANIMATION_EASING);
    assert.equal(changedDecision.reason, "dataset-changed");

    // 5. Subsequent render on dsB returns to unchanged-dataset (isAnimationActive: false)
    const afterChangeDecision = tracker.evaluate({
      chartId: "trend",
      mounted: true,
      signature: dsB.signature,
      valid: dsB.valid,
      itemCount: dsB.itemCount,
      maxItems: CHART_MAX_ANIMATED_TREND_POINTS,
    });
    assert.equal(afterChangeDecision.isAnimationActive, false);
    assert.equal(afterChangeDecision.reason, "unchanged-dataset");
  });

  it("respects prefers-reduced-motion, empty/1-point datasets, large datasets, and rapid-update cooldown", () => {
    let nowMs = 5_000;
    let reducedMotion = false;
    const tracker = createChartMotionTracker({
      now: () => nowMs,
      isReducedMotion: () => reducedMotion,
    });

    assert.equal(prefersReducedMotion({ matchMedia: () => ({ matches: true }) }), true);
    assert.equal(prefersReducedMotion({ matchMedia: () => ({ matches: false }) }), false);
    assert.equal(prefersReducedMotion(null), false);

    // Empty and 1-point datasets are invalid for animation
    const emptyBar = buildBarDatasetSignature([]);
    assert.equal(emptyBar.valid, false);
    const singleBar = buildBarDatasetSignature([
      { key: "r1", name: "Recruiter 1", value: 10, color: "--chart-1" },
    ]);
    assert.equal(singleBar.valid, false);

    const zeroDonut = buildDonutDatasetSignature([
      { key: "p1", value: 0, percent: 0 },
      { key: "p2", value: 0, percent: 0 },
    ]);
    assert.equal(zeroDonut.valid, false);

    const validBarA = buildBarDatasetSignature([
      { key: "r1", name: "Recruiter 1", value: 10, color: "--chart-1" },
      { key: "r2", name: "Recruiter 2", value: 6, color: "--chart-2" },
    ]);
    const validBarB = buildBarDatasetSignature([
      { key: "r1", name: "Recruiter 1", value: 14, color: "--chart-1" },
      { key: "r2", name: "Recruiter 2", value: 8, color: "--chart-2" },
    ]);
    const validBarC = buildBarDatasetSignature([
      { key: "r1", name: "Recruiter 1", value: 20, color: "--chart-1" },
      { key: "r2", name: "Recruiter 2", value: 11, color: "--chart-2" },
    ]);
    const validBarD = buildBarDatasetSignature([
      { key: "r1", name: "Recruiter 1", value: 25, color: "--chart-1" },
      { key: "r2", name: "Recruiter 2", value: 15, color: "--chart-2" },
    ]);

    // Initial mount with validBarA
    assert.equal(
      tracker.evaluate({
        chartId: "bar",
        signature: validBarA.signature,
        valid: validBarA.valid,
        itemCount: validBarA.itemCount,
        maxItems: CHART_MAX_ANIMATED_BAR_ITEMS,
      }).reason,
      "initial-mount",
    );

    // Reduced motion blocks animation on dataset change
    reducedMotion = true;
    const rmDecision = tracker.evaluate({
      chartId: "bar",
      signature: validBarB.signature,
      valid: validBarB.valid,
      itemCount: validBarB.itemCount,
      maxItems: CHART_MAX_ANIMATED_BAR_ITEMS,
    });
    assert.equal(rmDecision.isAnimationActive, false);
    assert.equal(rmDecision.reason, "reduced-motion");

    // Re-enable motion and advance past cooldown
    reducedMotion = false;
    nowMs += CHART_RAPID_UPDATE_COOLDOWN_MS + 50;
    const animatedDecision = tracker.evaluate({
      chartId: "bar",
      signature: validBarC.signature,
      valid: validBarC.valid,
      itemCount: validBarC.itemCount,
      maxItems: CHART_MAX_ANIMATED_BAR_ITEMS,
    });
    assert.equal(animatedDecision.isAnimationActive, true);
    assert.equal(animatedDecision.reason, "dataset-changed");

    // Rapid update within cooldown disables animation
    nowMs += 120;
    const rapidDecision = tracker.evaluate({
      chartId: "bar",
      signature: validBarD.signature,
      valid: validBarD.valid,
      itemCount: validBarD.itemCount,
      maxItems: CHART_MAX_ANIMATED_BAR_ITEMS,
    });
    assert.equal(rapidDecision.isAnimationActive, false);
    assert.equal(rapidDecision.reason, "rapid-update");

    // Large dataset disables animation
    nowMs += CHART_RAPID_UPDATE_COOLDOWN_MS + 50;
    const largeDecision = tracker.evaluate({
      chartId: "bar",
      signature: validBarA.signature,
      valid: true,
      itemCount: CHART_MAX_ANIMATED_BAR_ITEMS + 5,
      maxItems: CHART_MAX_ANIMATED_BAR_ITEMS,
    });
    assert.equal(largeDecision.isAnimationActive, false);
    assert.equal(largeDecision.reason, "large-dataset");

    // Reset clears committed state so remount starts at initial-mount
    tracker.reset("bar");
    const remountDecision = tracker.evaluate({
      chartId: "bar",
      signature: validBarA.signature,
      valid: validBarA.valid,
      itemCount: validBarA.itemCount,
      maxItems: CHART_MAX_ANIMATED_BAR_ITEMS,
    });
    assert.equal(remountDecision.isAnimationActive, false);
    assert.equal(remountDecision.reason, "initial-mount");
  });

  it("renders real production chart components on initial mount and synchronizes tooltip/label keys", () => {
    const html = renderToStaticMarkup(
      createElement(
        ThemeProvider,
        null,
        createElement(TrendChart, {
          data: [
            { date: "2026-10-01", count: 3 },
            { date: "2026-10-02", count: 5 },
          ],
          from: "2026-10-01",
          to: "2026-10-02",
        }),
        createElement(RecruiterBarChart, {
          title: "Biểu đồ theo người tuyển",
          data: [
            { key: "r1", name: "Nguyễn Văn A", value: 5, color: "--chart-1" },
            { key: "r2", name: "Trần Thị B", value: 3, color: "--chart-2" },
          ],
        }),
        createElement(ProjectDonut, {
          title: "Biểu đồ theo dự án",
          slices: [
            { key: "p1", display: "Dự án A", value: 5, percent: 62.5, color: "--chart-1" },
            { key: "p2", display: "Dự án B", value: 3, percent: 37.5, color: "--chart-2" },
          ],
        }),
        createElement(ProviderDonut, {
          title: "Biểu đồ theo HRP/Vendor",
          segments: [
            { key: "hrp", display: "HRP", value: 5, percent: 62.5, color: "--chart-1" },
            { key: "vendor", display: "Vendor", value: 3, percent: 37.5, color: "--chart-2" },
          ],
        }),
      ),
    );

    assert.match(html, /Độ phân giải xu hướng/);
    assert.match(html, /Biểu đồ theo người tuyển/);
    assert.match(html, /Biểu đồ theo dự án/);
    assert.match(html, /Biểu đồ theo HRP\/Vendor/);

    for (const relPath of [
      "src/components/dashboard/trend-chart.tsx",
      "src/components/dashboard/recruiter-bar-chart.tsx",
      "src/components/dashboard/project-donut.tsx",
      "src/components/dashboard/provider-donut.tsx",
    ]) {
      const src = readFileSync(path.join(repoRoot, relPath), "utf8");
      assert.match(src, /useChartDataAnimation\(/, `${relPath} must use useChartDataAnimation`);
      assert.match(src, /isAnimationActive=\{chartMotion\.isAnimationActive\}/);
      assert.match(src, /animationDuration=\{chartMotion\.animationDuration\}/);
      assert.match(src, /animationEasing=\{chartMotion\.animationEasing\}/);
      assert.match(src, /<Tooltip[\s\S]*?key=\{chartMotion\.signature\}/);
      assert.doesNotMatch(src, /isAnimationActive=\{true\}/);
    }

    assert.equal(CHART_MAX_ANIMATED_DONUT_SLICES, 12);
  });
});
