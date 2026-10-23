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

const { FormDialog } = await import("@/components/ui/form-dialog");
const { RowOverflowMenu } = await import("@/components/ui/mobile-action-sheet");

describe("UIUX S2-03 — Tab Panel, Drawer, Dialog & Sheet Motion", () => {
  it("defines GPU-safe transform+opacity keyframes (<= 6px, 200ms) and disables them under prefers-reduced-motion", () => {
    const globalsCss = readRel("src/app/globals.css");
    assert.match(globalsCss, /@keyframes ui-panel-enter/);
    assert.match(globalsCss, /translate3d\(0,\s*4px,\s*0\)/);
    assert.match(globalsCss, /@keyframes ui-dialog-enter/);
    assert.match(globalsCss, /@keyframes ui-popover-enter/);
    // Centered dialogs (-translate-x-1/2 -translate-y-1/2) must NEVER have transform overridden by ui-dialog-enter
    const dialogKeyframeMatch = globalsCss.match(/@keyframes\s+ui-dialog-enter\s*\{[\s\S]*?\n\}/);
    assert.ok(dialogKeyframeMatch, "ui-dialog-enter keyframe must exist");
    assert.doesNotMatch(
      dialogKeyframeMatch[0],
      /\b(?:transform|translate|scale)\b/,
      "ui-dialog-enter must animate opacity only so centered Dialog.Content keeps its -50%/-50% transform",
    );
    assert.match(globalsCss, /\[data-ui-dialog-motion="true"\]\s*\{\s*animation:\s*ui-dialog-enter\b/);
    assert.match(globalsCss, /\[data-ui-popover-motion="true"\]\s*\{\s*animation:\s*ui-popover-enter\b/);
    assert.match(globalsCss, /@keyframes ui-drawer-left-enter/);
    assert.match(globalsCss, /@keyframes ui-drawer-right-enter/);
    assert.match(globalsCss, /\[data-ui-panel-motion="true"\]:not\(\[hidden\]\)/);
    assert.match(globalsCss, /var\(--ui-motion-tab,\s*200ms\)/);
    assert.match(globalsCss, /var\(--ui-motion-reveal,\s*200ms\)/);
    assert.match(
      globalsCss,
      /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\[data-ui-panel-motion\][\s\S]*?\[data-ui-dialog-motion\][\s\S]*?\[data-ui-drawer-motion\][\s\S]*?\[data-ui-popover-motion\][\s\S]*?animation:\s*none\s*!important/,
    );
  });

  it("applies panel motion to authorized dashboard tab panels while keeping unauthorized panels out of DOM", () => {
    const tabsSrc = readRel("src/components/dashboard/bod-dashboard-tabs.tsx");
    for (const panelId of [
      "bod-panel-general",
      "bod-panel-deep",
      "bod-panel-team",
      "bod-panel-duplicate-cccd",
    ]) {
      assert.match(
        tabsSrc,
        new RegExp(`id="${panelId}"[^>]*role="tabpanel"[^>]*data-ui-panel-motion="true"`),
        `${panelId} must have data-ui-panel-motion="true"`,
      );
    }

    // Conditional branches ensure only one authorized panel renders in DOM at a time
    assert.match(tabsSrc, /activeTab === "deep" && primaryTabLabel === undefined/);
    assert.match(tabsSrc, /activeTab === "team" && primaryTabLabel === undefined/);
    assert.match(tabsSrc, /rawTab === "duplicate-cccd" && canViewDuplicateCccd/);
  });

  it("wires dialog, drawer, sheet, and filter disclosure motion while preserving Escape, focus return, and hidden semantics", () => {
    const formDialogSrc = readRel("src/components/ui/form-dialog.tsx");
    assert.match(formDialogSrc, /data-ui-overlay-motion="true"/);
    assert.match(formDialogSrc, /data-ui-dialog-motion="true"/);
    assert.match(formDialogSrc, /onCloseAutoFocus=\{onCloseAutoFocus\}/);

    const workerDialogSrc = readRel("src/components/direct-entry/worker-detail-dialog.tsx");
    assert.match(workerDialogSrc, /data-ui-overlay-motion="true"/);
    assert.match(workerDialogSrc, /data-ui-drawer-motion="right"/);
    assert.match(workerDialogSrc, /className=\{styles\.documentsDialog\}/);
    assert.match(workerDialogSrc, /openerRef\.current\.focus\(\)/);

    const mobileNavSrc = readRel("src/components/app-shell/mobile-nav.tsx");
    assert.match(mobileNavSrc, /data-ui-overlay-motion="true"/);
    assert.match(mobileNavSrc, /data-ui-drawer-motion="left"/);
    assert.match(mobileNavSrc, /onEscapeKeyDown/);

    const actionSheetSrc = readRel("src/components/ui/mobile-action-sheet.tsx");
    assert.match(actionSheetSrc, /data-ui-popover-motion="true"/);

    const filtersSrc = readRel("src/components/dashboard/dashboard-filters.tsx");
    assert.match(filtersSrc, /id="advanced-filters"\s+hidden=\{!advancedOpen\}\s+data-ui-panel-motion="true"/);

    const html = renderToStaticMarkup(
      createElement(
        "div",
        null,
        createElement(
          FormDialog,
          {
            open: false,
            onOpenChange: () => {},
            title: "Tạo mới",
            trigger: createElement("button", { type: "button" }, "Mở hộp thoại"),
          },
          createElement("p", null, "Nội dung"),
        ),
        createElement(RowOverflowMenu, {
          ariaLabel: "Thao tác dòng",
          actions: [{ id: "edit", label: "Sửa", onSelect: () => {} }],
        }),
      ),
    );
    assert.match(html, /Mở hộp thoại/);
    assert.match(html, /Thao tác dòng/);
  });
});
