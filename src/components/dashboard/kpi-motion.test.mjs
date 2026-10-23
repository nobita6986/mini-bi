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
  KPI_TRANSITION_DURATION_MS,
  formatKpiIntegerValue,
  interpolateKpiIntegerFrame,
  isAnimatableKpiInteger,
  resolveKpiTransitionPlan,
  sampleKpiTransitionFrames,
} = await import("./kpi-motion.ts");

const { KpiCard } = await import("./kpi-card.tsx");

describe("UIUX S2-02 — KPI Numeric Value Transition", () => {
  it("never counts up from 0 on initial mount or tab remount, and formats integers in vi-VN locale", () => {
    assert.ok(
      KPI_TRANSITION_DURATION_MS >= 180 && KPI_TRANSITION_DURATION_MS <= 300,
      "KPI transition duration must be within 180-300ms",
    );
    assert.equal(formatKpiIntegerValue(0), "0");
    assert.equal(formatKpiIntegerValue(1250), "1.250");

    const initialPlan = resolveKpiTransitionPlan({
      previousValue: 1250,
      nextValue: 1250,
      hasMounted: false,
      reducedMotion: false,
    });
    assert.equal(initialPlan.shouldAnimate, false);
    assert.equal(initialPlan.reason, "initial-mount");
    assert.equal(initialPlan.toValue, 1250);
    assert.equal(initialPlan.finalDisplay, "1.250");
  });

  it("animates only between two distinct valid non-negative integers and lands on the exact final integer", () => {
    const planUp = resolveKpiTransitionPlan({
      previousValue: 40,
      nextValue: 125,
      hasMounted: true,
      reducedMotion: false,
    });
    assert.equal(planUp.shouldAnimate, true);
    assert.equal(planUp.reason, "animate");
    assert.equal(planUp.fromValue, 40);
    assert.equal(planUp.toValue, 125);
    assert.equal(planUp.finalDisplay, "125");

    const upFrames = sampleKpiTransitionFrames(40, 125, 10);
    assert.equal(upFrames[0], 40);
    assert.equal(upFrames[upFrames.length - 1], 125);
    for (let i = 0; i < upFrames.length; i += 1) {
      assert.equal(Number.isInteger(upFrames[i]), true, "KPI frame must never be decimal");
      assert.ok(upFrames[i] >= 40 && upFrames[i] <= 125, "KPI frame must stay within [from, to]");
      if (i > 0) {
        assert.ok(upFrames[i] >= upFrames[i - 1], "monotonic upward transition");
      }
    }

    const downFrames = sampleKpiTransitionFrames(125, 0, 10);
    assert.equal(downFrames[0], 125);
    assert.equal(downFrames[downFrames.length - 1], 0);
    for (const frame of downFrames) {
      assert.equal(Number.isInteger(frame), true);
      assert.ok(frame >= 0, "KPI frame must never become negative");
    }

    assert.equal(interpolateKpiIntegerFrame(10, 50, -0.5), 10);
    assert.equal(interpolateKpiIntegerFrame(10, 50, 1.5), 50);
  });

  it("never animates '—', 'N/A', formatted ratios, NaN, Infinity, negative numbers, unchanged values, or reduced-motion", () => {
    for (const nonAnimatable of ["—", "N/A", "2.3", null, undefined, Number.NaN, Number.POSITIVE_INFINITY, -1, 3.5]) {
      assert.equal(isAnimatableKpiInteger(nonAnimatable), false);
      const planToNonNum = resolveKpiTransitionPlan({
        previousValue: 10,
        nextValue: nonAnimatable,
        hasMounted: true,
        reducedMotion: false,
      });
      assert.equal(planToNonNum.shouldAnimate, false);
      assert.equal(planToNonNum.reason, "non-numeric");

      const planFromNonNum = resolveKpiTransitionPlan({
        previousValue: nonAnimatable,
        nextValue: 10,
        hasMounted: true,
        reducedMotion: false,
      });
      assert.equal(planFromNonNum.shouldAnimate, false);
      assert.equal(planFromNonNum.reason, "non-numeric");
      assert.equal(planFromNonNum.toValue, 10);
    }

    const unchangedPlan = resolveKpiTransitionPlan({
      previousValue: 42,
      nextValue: 42,
      hasMounted: true,
      reducedMotion: false,
    });
    assert.equal(unchangedPlan.shouldAnimate, false);
    assert.equal(unchangedPlan.reason, "unchanged");

    const reducedMotionPlan = resolveKpiTransitionPlan({
      previousValue: 42,
      nextValue: 99,
      hasMounted: true,
      reducedMotion: true,
    });
    assert.equal(reducedMotionPlan.shouldAnimate, false);
    assert.equal(reducedMotionPlan.reason, "reduced-motion");
    assert.equal(reducedMotionPlan.finalDisplay, "99");

    const disabledPlan = resolveKpiTransitionPlan({
      previousValue: 42,
      nextValue: 99,
      hasMounted: true,
      animateNumeric: false,
      reducedMotion: false,
    });
    assert.equal(disabledPlan.shouldAnimate, false);
    assert.equal(disabledPlan.reason, "disabled");
  });

  it("renders real production KpiCard with tabular-nums, vi-VN formatting, and non-numeric passthrough", () => {
    const html = renderToStaticMarkup(
      createElement(
        "div",
        null,
        createElement(KpiCard, {
          variant: "compact",
          label: "Tổng tuyển mới",
          value: 1250,
          hint: "lượt tuyển ghi nhận",
          accent: "var(--primary)",
        }),
        createElement(KpiCard, {
          variant: "compact",
          label: "Trung bình/ngày có tuyển",
          value: "2.3",
          hint: "lượt tuyển / ngày có tuyển",
          accent: "var(--secondary)",
        }),
        createElement(KpiCard, {
          variant: "compact",
          label: "Đỉnh tuyển/ngày",
          value: "—",
          hint: "chưa có ngày phát sinh",
          accent: "var(--primary)",
        }),
      ),
    );

    assert.match(html, /tabular-nums/);
    assert.match(html, /data-kpi-final-value="1\.250"/);
    assert.match(html, />1\.250</);
    assert.match(html, />2\.3</);
    assert.match(html, />—</);
  });
});
