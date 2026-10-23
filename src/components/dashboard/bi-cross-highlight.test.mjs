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

function readRel(relPath) {
  return readFileSync(path.join(repoRoot, relPath), "utf8");
}

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
    if (specifier === "next/link") {
      return nextResolve("next/link.js", context);
    }
    if (specifier === "next/navigation") {
      return nextResolve("next/navigation.js", context);
    }
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
  INITIAL_BI_HIGHLIGHT_STATE,
  BiHighlightScope,
  BiClearHighlightButton,
  isBucketRowHighlighted,
  reduceBiHighlightState,
  resolveActiveHighlightKey,
  resolveDonutSliceHighlightKey,
  resolvePinnedHighlightKey,
} = await import("./bi-cross-highlight.tsx");

const { ThemeProvider } = await import("@/lib/theme/theme-provider");
const { ProjectDonut } = await import("./project-donut.tsx");
const { ProviderDonut } = await import("./provider-donut.tsx");
const { EmploymentComposition } = await import("./employment-composition.tsx");
const { ProjectProviderMixCard } = await import("./project-provider-mix.tsx");
const { TeamBucketChart } = await import("./team-bucket-chart.tsx");

describe("UIUX S2-04 — BI Interactive Polish & Cross-Highlight", () => {
  it("resolves hover, keyboard focus, and touch tap-pin priority strictly within valid dataset keys", () => {
    const validKeys = ["proj-a", "proj-b", "__other__"];
    let state = INITIAL_BI_HIGHLIGHT_STATE;
    assert.equal(resolveActiveHighlightKey(state, validKeys), null);

    // Touch tap pins proj-a
    state = reduceBiHighlightState(state, { type: "toggle-pin", key: "proj-a" });
    assert.equal(resolvePinnedHighlightKey(state, validKeys), "proj-a");
    assert.equal(resolveActiveHighlightKey(state, validKeys), "proj-a");

    // Keyboard focus temporarily overrides pin
    state = reduceBiHighlightState(state, { type: "focus", key: "proj-b" });
    assert.equal(resolveActiveHighlightKey(state, validKeys), "proj-b");

    // Hover temporarily overrides focus and pin
    state = reduceBiHighlightState(state, { type: "hover", key: "__other__" });
    assert.equal(resolveActiveHighlightKey(state, validKeys), "__other__");

    // Leaving hover falls back to focus, blurring falls back to pin
    state = reduceBiHighlightState(state, { type: "hover", key: null });
    assert.equal(resolveActiveHighlightKey(state, validKeys), "proj-b");
    state = reduceBiHighlightState(state, { type: "focus", key: null });
    assert.equal(resolveActiveHighlightKey(state, validKeys), "proj-a");

    // Dataset change that excludes proj-a drops stale highlight immediately without manual reset
    assert.equal(resolveActiveHighlightKey(state, ["proj-c", "proj-d"]), null);
    assert.equal(resolvePinnedHighlightKey(state, ["proj-c", "proj-d"]), null);

    // Second tap on same key unpins; clear resets all state
    const unpinned = reduceBiHighlightState(state, { type: "toggle-pin", key: "proj-a" });
    assert.equal(unpinned.pinnedKey, null);
    const cleared = reduceBiHighlightState(state, { type: "clear" });
    assert.deepEqual(cleared, INITIAL_BI_HIGHLIGHT_STATE);
  });

  it("maps tail bucket rows and __other__ donut slices bidirectionally within the same project dataset", () => {
    const slices = [
      { key: "proj-1" },
      { key: "proj-2" },
      { key: "__other__" },
    ];
    const allBuckets = ["proj-1", "proj-2", "proj-tail-1", "proj-tail-2"];
    const topSliceKeys = ["proj-1", "proj-2"];

    // Highlighting a tail row in BucketList maps to "__other__" slice on ProjectDonut
    assert.equal(resolveDonutSliceHighlightKey("proj-tail-1", slices, allBuckets), "__other__");
    assert.equal(resolveDonutSliceHighlightKey("proj-1", slices, allBuckets), "proj-1");
    assert.equal(resolveDonutSliceHighlightKey("unrelated-key", slices, allBuckets), null);

    // Highlighting "__other__" slice on ProjectDonut highlights only tail rows in BucketList
    assert.equal(isBucketRowHighlighted("proj-1", "__other__", topSliceKeys), false);
    assert.equal(isBucketRowHighlighted("proj-tail-1", "__other__", topSliceKeys), true);
    assert.equal(isBucketRowHighlighted("proj-1", "proj-1", topSliceKeys), true);
  });

  it("renders cross-highlight controls, keyboard/touch buttons, and clear pill without mutating URL filters", () => {
    const html = renderToStaticMarkup(
      createElement(
        ThemeProvider,
        null,
        createElement(
          BiHighlightScope,
          { validKeys: ["p1", "p2"], topSliceKeys: ["p1", "p2"] },
          createElement(ProjectDonut, {
            title: "Biểu đồ theo dự án",
            slices: [
              { key: "p1", display: "Dự án A", value: 6, percent: 60, color: "--chart-1" },
              { key: "p2", display: "Dự án B", value: 4, percent: 40, color: "--chart-2" },
            ],
          }),
        ),
        createElement(ProviderDonut, {
          title: "Biểu đồ HRP/Vendor",
          segments: [
            { key: "hrp", display: "HRP", value: 6, percent: 60, color: "--chart-1" },
            { key: "vendor", display: "Vendor", value: 4, percent: 40, color: "--chart-2" },
          ],
        }),
        createElement(EmploymentComposition, {
          title: "Biểu đồ loại hình",
          segments: [
            { key: "seasonal", display: "Thời vụ", value: 7, percent: 70, color: "--chart-1" },
            { key: "permanent", display: "Chính thức", value: 3, percent: 30, color: "--chart-2" },
          ],
        }),
        createElement(ProjectProviderMixCard, {
          providerFilterActive: false,
          mix: [
            {
              projectKey: "p1",
              projectDisplay: "Dự án A",
              hrpCount: 4,
              vendorCount: 6,
              unknownCount: 0,
              invalidCount: 0,
              knownTotal: 10,
              projectTotal: 10,
              hrpShare: 0.4,
              vendorShare: 0.6,
              knownCoverage: 1,
            },
          ],
        }),
        createElement(TeamBucketChart, {
          highlightedKey: "team-1",
          buckets: [
            { key: "team-1", display: "Nhóm 1", recruitedCount: 12 },
            { key: "team-2", display: "Nhóm 2", recruitedCount: 8 },
          ],
        }),
        createElement(BiClearHighlightButton, {
          visible: true,
          onClear: () => {},
        }),
      ),
    );

    assert.match(html, /data-bi-highlighted="true"/);
    assert.match(html, /Bỏ đánh dấu/);
    assert.match(html, /aria-pressed="false"/);

    // Cross-highlight helper must never import router or nuqs query mutators (hover/tap only highlights, never auto-filters)
    const crossHighlightSrc = readRel("src/components/dashboard/bi-cross-highlight.tsx");
    assert.doesNotMatch(crossHighlightSrc, /useQueryStates|useRouter|window\.location|history\.pushState/);
  });
});
