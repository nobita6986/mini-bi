/**
 * R2.2 Grid No-Touch & CSS Isolation Guard Suite.
 *
 * Verifies:
 * 1. 100% SHA-256 content match against baseline commit `8bf16afe9360e5eebe0dd9183c8ef9d85fc39b0c`
 *    for all 21 locked `/direct-entry` spreadsheet grid, multi-entry form, paste, portrait, and controller files.
 * 2. Exact anchor/subtree slice preservation in `src/components/direct-entry/direct-entry-live.tsx`
 *    for `<div className={styles.inputModeSwitch}` .. `</section>` of `.gridSection`,
 *    and `<section className={styles.mobileSection}` .. EOF.
 * 3. Exact CSS rule block preservation in `src/components/direct-entry/direct-entry-shell.module.css`
 *    for `.page`, `.primaryButton`, `.secondaryButton`, `.gridEditButton`, `.dangerButton`,
 *    `.gridSection`, `.inputModeSwitch`, `.contextualActionBar`, `.gridViewport`, `.grid`, `.mobileSection`.
 * 4. Strict selector scoping in `src/app/globals.css` (`table.r22-card-table` and `table.r22-report-table`),
 *    preventing any bare `table`, `tr`, `td`, `th` rule bleed into `.rdg` or `.grid`.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_COMMIT = "8bf16afe9360e5eebe0dd9183c8ef9d85fc39b0c";

const LOCKED_FILES = [
  "src/components/direct-entry/direct-entry-spreadsheet-grid.tsx",
  "src/components/direct-entry/direct-entry-spreadsheet-grid.module.css",
  "src/components/direct-entry/direct-entry-ddmm-date-input.tsx",
  "src/components/direct-entry/direct-entry-excel-paste-dialog.tsx",
  "src/components/direct-entry/direct-entry-worker-profile-paste-dialog.tsx",
  "src/components/direct-entry/direct-entry-initial-worker-uploads.tsx",
  "src/components/direct-entry/worker-portrait-stage-slot.tsx",
  "src/components/direct-entry/use-worker-portrait-stages.ts",
  "src/components/direct-entry/typeahead-picker-smoke.tsx",
  "src/components/direct-entry/text-cell-state.ts",
  "src/lib/direct-entry/spreadsheet-row-model.ts",
  "src/lib/direct-entry/direct-entry-grid-columns.ts",
  "src/lib/direct-entry/direct-entry-grid-clipboard.ts",
  "src/lib/direct-entry/direct-entry-grid-validation.ts",
  "src/lib/direct-entry/live-grid-paste.ts",
  "src/lib/direct-entry/live-controller.ts",
  "src/lib/direct-entry/draft-profile-grid.ts",
  "src/lib/direct-entry/worker-profile-paste.ts",
  "src/lib/direct-entry/worker-profile-xlsx.ts",
];

function normalizeEol(text) {
  return text.replace(/\r\n/g, "\n");
}

function sha256(text) {
  return createHash("sha256").update(normalizeEol(text), "utf8").digest("hex");
}

function readWorkingFile(relPath) {
  return normalizeEol(readFileSync(resolve(ROOT, relPath), "utf8"));
}

function readBaselineFile(relPath) {
  const out = execFileSync("git", ["show", `${BASELINE_COMMIT}:${relPath}`], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return normalizeEol(out);
}

/**
 * Extract all top-level and media-nested CSS rule blocks whose selector list
 * mentions a given class selector (e.g. `.gridSection`).
 */
function extractCssRuleBlocksForClass(cssText, classSelector) {
  const normalized = normalizeEol(cssText);
  // Strip block comments for deterministic rule parsing while keeping rule bodies intact
  const stripped = normalized.replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks = [];
  const escaped = classSelector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const classRegex = new RegExp(`(?:^|[^a-zA-Z0-9_-])${escaped}(?=$|[^a-zA-Z0-9_-])`);

  let i = 0;
  while (i < stripped.length) {
    while (i < stripped.length && /\s/.test(stripped[i])) i++;
    if (i >= stripped.length) break;

    const openBrace = stripped.indexOf("{", i);
    if (openBrace === -1) break;

    const header = stripped.slice(i, openBrace).trim();
    let depth = 1;
    let cursor = openBrace + 1;
    while (cursor < stripped.length && depth > 0) {
      if (stripped[cursor] === "{") depth++;
      else if (stripped[cursor] === "}") depth--;
      cursor++;
    }
    const fullBlock = stripped.slice(i, cursor).trim();
    const innerBody = stripped.slice(openBrace + 1, cursor - 1);

    if (header.startsWith("@")) {
      // Recurse into @media / @container blocks
      const nested = extractCssRuleBlocksForClass(innerBody, classSelector);
      for (const n of nested) {
        blocks.push(`${header} { ${n} }`);
      }
    } else if (classRegex.test(header)) {
      blocks.push(fullBlock.replace(/\s+/g, " "));
    }

    i = cursor;
  }

  return blocks;
}

describe("R2.2 — Direct Entry Grid No-Touch & CSS Isolation Guard", () => {
  describe("1. Locked Direct Entry Files — 100% SHA-256 Checksum Match", () => {
    for (const relPath of LOCKED_FILES) {
      it(`preserves ${relPath} untouched vs baseline ${BASELINE_COMMIT.slice(0, 8)}`, () => {
        const current = readWorkingFile(relPath);
        const baseline = readBaselineFile(relPath);
        const currentHash = sha256(current);
        const baselineHash = sha256(baseline);
        assert.equal(
          currentHash,
          baselineHash,
          `Locked file ${relPath} was modified! Expected SHA-256 ${baselineHash}, got ${currentHash}`,
        );
        assert.equal(current, baseline);
      });
    }
  });

  describe("2. direct-entry-live.tsx — Subtree Slice Preservation", () => {
    const relPath = "src/components/direct-entry/direct-entry-live.tsx";

    function extractInputModeAndGridSlice(source) {
      const startMarker = "<div className={styles.inputModeSwitch}";
      const gridMarker = "<section className={styles.gridSection}";
      const endMarker = "</section>";

      const startIdx = source.indexOf(startMarker);
      assert.ok(startIdx !== -1, `Missing ${startMarker} in ${relPath}`);

      const gridIdx = source.indexOf(gridMarker, startIdx);
      assert.ok(gridIdx !== -1, `Missing ${gridMarker} after ${startMarker} in ${relPath}`);

      const closeIdx = source.indexOf(endMarker, gridIdx);
      assert.ok(closeIdx !== -1, `Missing closing ${endMarker} for .gridSection in ${relPath}`);

      return source.slice(startIdx, closeIdx + endMarker.length);
    }

    function extractMobileSectionToEofSlice(source) {
      const mobileMarker = "<section className={styles.mobileSection}";
      const startIdx = source.indexOf(mobileMarker);
      assert.ok(startIdx !== -1, `Missing ${mobileMarker} in ${relPath}`);
      return source.slice(startIdx);
    }

    it("preserves exact substring from <div className={styles.inputModeSwitch} through closing </section> of .gridSection", () => {
      const currentSource = readWorkingFile(relPath);
      const baselineSource = readBaselineFile(relPath);

      const currentSlice = extractInputModeAndGridSlice(currentSource);
      const baselineSlice = extractInputModeAndGridSlice(baselineSource);

      assert.equal(currentSlice, baselineSlice);
      assert.equal(sha256(currentSlice), sha256(baselineSlice));
    });

    it("preserves exact substring from <section className={styles.mobileSection} to EOF (including drawers and dialogs)", () => {
      const currentSource = readWorkingFile(relPath);
      const baselineSource = readBaselineFile(relPath);

      const currentMobileSlice = extractMobileSectionToEofSlice(currentSource);
      const baselineMobileSlice = extractMobileSectionToEofSlice(baselineSource);

      assert.equal(currentMobileSlice, baselineMobileSlice);
      assert.equal(sha256(currentMobileSlice), sha256(baselineMobileSlice));
    });
  });

  describe("3. direct-entry-shell.module.css — Locked Rule Blocks Guard", () => {
    const relPath = "src/components/direct-entry/direct-entry-shell.module.css";
    const LOCKED_SELECTORS = [
      ".page",
      ".primaryButton",
      ".secondaryButton",
      ".gridEditButton",
      ".dangerButton",
      ".gridSection",
      ".inputModeSwitch",
      ".contextualActionBar",
      ".gridViewport",
      ".grid",
      ".mobileSection",
    ];

    const currentCss = readWorkingFile(relPath);
    const baselineCss = readBaselineFile(relPath);

    for (const selector of LOCKED_SELECTORS) {
      it(`preserves CSS rule blocks for ${selector} 100% vs baseline`, () => {
        const currentBlocks = extractCssRuleBlocksForClass(currentCss, selector);
        const baselineBlocks = extractCssRuleBlocksForClass(baselineCss, selector);
        assert.ok(
          baselineBlocks.length > 0,
          `Expected at least 1 baseline CSS block for ${selector}`,
        );
        assert.deepEqual(
          currentBlocks,
          baselineBlocks,
          `CSS rule blocks for ${selector} in ${relPath} diverged from baseline`,
        );
      });
    }
  });

  describe("4. src/app/globals.css — Scoped Table Rules & Zero Grid Bleed", () => {
    const globalsCss = readWorkingFile("src/app/globals.css");

    it("scopes all responsive card and report table selectors strictly to table.r22-card-table and table.r22-report-table", () => {
      assert.match(globalsCss, /table\.r22-card-table/);
      assert.match(globalsCss, /table\.r22-report-table/);

      // Extract all selector headers in globals.css (excluding @import, @media, @theme)
      const stripped = globalsCss.replace(/\/\*[\s\S]*?\*\//g, "");
      const selectorHeaders = [];
      const regex = /([^{}@]+)\{/g;
      let match;
      while ((match = regex.exec(stripped)) !== null) {
        const rawSelector = match[1].trim();
        if (!rawSelector || rawSelector.startsWith("@") || rawSelector.startsWith(":root") || rawSelector === "body") {
          continue;
        }
        for (const part of rawSelector.split(",")) {
          const sel = part.trim();
          if (sel) selectorHeaders.push(sel);
        }
      }

      for (const sel of selectorHeaders) {
        if (/\b(?:table|thead|tbody|tr|td|th)\b/.test(sel)) {
          assert.ok(
            sel.startsWith("table.r22-card-table") || sel.startsWith("table.r22-report-table"),
            `Unscoped table/cell selector "${sel}" found in globals.css! Must start with table.r22-card-table or table.r22-report-table.`,
          );
        }
        assert.ok(
          !sel.includes(".rdg") && !sel.includes(".grid"),
          `Selector "${sel}" in globals.css must never target .rdg or .grid`,
        );
      }
    });
  });
});
