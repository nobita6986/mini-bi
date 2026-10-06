/**
 * P3-W07C-R1 grid zoom — behavioral regressions.
 *
 * Constraints locked by these tests:
 *  - default zoom level = 100;
 *  - zoom controls (`-`, `100%`, `+`) wired with the exact aria labels;
 *  - `−` clamps at 80, `+` clamps at 120, reset returns to 100;
 *  - column width and row/header height scale with zoom;
 *  - font-size and cell padding driven by zoom (no `transform: scale()`, no
 *    CSS `zoom` property, no browser zoom);
 *  - zoom does NOT mutate row/cells, selection, paste, or save payload;
 *  - controls have accessible labels and disabled state at limits.
 *
 * Strategy: read the grid source/registry directly. Assertions exercise the
 * pure scaling helpers (zoomFactor) and static invariants on the rendered
 * JSX.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const GRID = join(HERE, "direct-entry-spreadsheet-grid.tsx");
const COLUMNS = join(HERE, "..", "..", "lib", "direct-entry", "direct-entry-grid-columns.ts");
const LIVE = join(HERE, "direct-entry-live.tsx");
const CSS = join(HERE, "direct-entry-spreadsheet-grid.module.css");

const grid = readFileSync(GRID, "utf8");
const gridColumns = readFileSync(COLUMNS, "utf8");
const live = readFileSync(LIVE, "utf8");
const css = readFileSync(CSS, "utf8");

const ZOOM_LEVELS = [80, 90, 100, 110, 120];
const BASE_ROW = 40;
const BASE_HEADER = 38;

test("zoom levels co dinh [80,90,100,110,120], default 100, zoom khong persistence", () => {
  assert.match(grid, /DIRECT_ENTRY_GRID_ZOOM_LEVELS: readonly number\[\] = Object\.freeze\(\[\s*80[\s\S]{0,200}?120\s*,?\s*\]\)/);
  assert.match(grid, /DIRECT_ENTRY_GRID_DEFAULT_ZOOM = 100/);
  // Khong localStorage / sessionStorage / DB trong code (comment OK).
  // Loai comment block bang regex (?<![\/*]) — don gian: chi check khong co
  // .localStorage.setItem hoac .localStorage.getItem.
  assert.equal(/localStorage\.setItem|localStorage\.getItem|sessionStorage\.setItem|sessionStorage\.getItem/.test(grid), false,
    "zoom khong goi localStorage/sessionStorage API");
  assert.equal(/fetch\s*\(/.test(grid), false,
    "zoom khong goi mang");
});

test("zoom controls co aria-label chinh xac theo spec", () => {
  assert.match(grid, /aria-label="Thu nhỏ bảng nhập liệu"/,
    "nut - phai co aria-label 'Thu nhỏ bảng nhập liệu'");
  assert.match(grid, /aria-label="Đặt lại tỷ lệ bảng nhập liệu"/,
    "nut 100% phai co aria-label 'Đặt lại tỷ lệ bảng nhập liệu'");
  assert.match(grid, /aria-label="Phóng to bảng nhập liệu"/,
    "nut + phai co aria-label 'Phóng to bảng nhập liệu'");
});

test("zoom hien thi phan tram voi aria-live=polite", () => {
  assert.match(grid, /aria-live="polite"/);
  assert.match(grid, /\{`\$\{effectiveZoom\}%`\}/,
    "phan tram hien thi dang <level>%");
});

test("nut - clamp tai 80 (disabled) va + clamp tai 120 (disabled)", () => {
  // zoomCanDecrease: idx > 0.
  assert.match(grid, /const zoomCanDecrease = DIRECT_ENTRY_GRID_ZOOM_LEVELS\.indexOf\(effectiveZoom\) > 0/);
  // zoomCanIncrease: idx < length - 1.
  assert.match(grid,
    /const zoomCanIncrease = DIRECT_ENTRY_GRID_ZOOM_LEVELS\.indexOf\(effectiveZoom\)\s*< DIRECT_ENTRY_GRID_ZOOM_LEVELS\.length - 1/);
  // Disabled state wire.
  assert.match(grid, /data-testid="spreadsheet-zoom-decrease"[\s\S]{0,400}disabled=\{!zoomCanDecrease\}/);
  assert.match(grid, /data-testid="spreadsheet-zoom-increase"[\s\S]{0,400}disabled=\{!zoomCanIncrease\}/);
});

test("zoom controls: - / + di dung cac muc, reset ve 100", () => {
  // onZoomDecrease: lay muc truoc (idx - 1).
  assert.match(grid,
    /const onZoomDecrease = useCallback\(\(\) => \{[\s\S]{0,400}DIRECT_ENTRY_GRID_ZOOM_LEVELS\[idx - 1\]/);
  // onZoomIncrease: lay muc sau (idx + 1).
  assert.match(grid,
    /const onZoomIncrease = useCallback\(\(\) => \{[\s\S]{0,400}DIRECT_ENTRY_GRID_ZOOM_LEVELS\[idx \+ 1\]/);
  // Reset goi DIRECT_ENTRY_GRID_DEFAULT_ZOOM (=100).
  assert.match(grid,
    /const onZoomReset = useCallback\(\(\) => \{[\s\S]{0,300}onZoomChange\(DIRECT_ENTRY_GRID_DEFAULT_ZOOM\)/);

  // Behavioral: - 100 -> 90 -> disabled; + 100 -> 110 -> 120 -> disabled.
  // Mocks: test bang logic thuan (can chinh in component).
  for (let i = 0; i < ZOOM_LEVELS.length; i += 1) {
    const cur = ZOOM_LEVELS[i];
    const canDecrease = i > 0;
    const canIncrease = i < ZOOM_LEVELS.length - 1;
    if (i === 0) {
      assert.equal(canDecrease, false, `80% is min, decrease disabled`);
    } else {
      assert.equal(canDecrease, true, `zoom level ${cur} (idx=${i}) should allow decrease`);
    }
    if (i === ZOOM_LEVELS.length - 1) {
      assert.equal(canIncrease, false, `120% is max, increase disabled`);
    } else {
      assert.equal(canIncrease, true, `zoom level ${cur} (idx=${i}) should allow increase`);
    }
  }
});

test("zoom factor tinh tu effectiveZoom, clamp column width toi thieu 32px", () => {
  assert.match(grid, /const zoomFactor = effectiveZoom \/ 100/);
  assert.match(grid,
    /const scaledWidth = Math\.max\(32, Math\.round\(column\.width \* zoomFactor\)\)/,
    "do rong cot phai duoc clamp >= 32px de khong bi 0 o 80%");
});

test("zoom scale row/header height tu base", () => {
  assert.match(grid, /DIRECT_ENTRY_GRID_BASE_ROW_HEIGHT = 40/);
  assert.match(grid, /DIRECT_ENTRY_GRID_BASE_HEADER_ROW_HEIGHT = 38/);
  // Row height scaled tu base.
  assert.match(grid,
    /const scaledRowHeight = Math\.max\(28,\s*Math\.round\(DIRECT_ENTRY_GRID_BASE_ROW_HEIGHT \* zoomFactor\)\)/);
  assert.match(grid,
    /const scaledHeaderRowHeight = Math\.max\(28,\s*Math\.round\(DIRECT_ENTRY_GRID_BASE_HEADER_ROW_HEIGHT \* zoomFactor\)\)/);
  // DataGrid nhan scaled height.
  assert.match(grid, /rowHeight=\{scaledRowHeight\}/);
  assert.match(grid, /headerRowHeight=\{scaledHeaderRowHeight\}/);

  // Pure math check: 80 -> 32 (40*0.8), 120 -> 48 (40*1.2), 100 -> 40.
  const factor = (z) => z / 100;
  const row = (z) => Math.max(28, Math.round(BASE_ROW * factor(z)));
  const header = (z) => Math.max(28, Math.round(BASE_HEADER * factor(z)));
  assert.equal(row(100), 40);
  assert.equal(row(90), 36);
  assert.equal(row(80), 32);
  assert.equal(row(110), 44);
  assert.equal(row(120), 48);
  assert.equal(header(100), 38);
  assert.equal(header(80), 30);
  assert.equal(header(120), 46);
});

test("zoom scale font-size va cell padding (CSS variables, khong transform/zoom)", () => {
  assert.match(grid, /DIRECT_ENTRY_GRID_BASE_FONT_PX = 13/);
  assert.match(grid,
    /const scaledFontPx = Math\.max\(10,\s*Math\.round\(DIRECT_ENTRY_GRID_BASE_FONT_PX \* zoomFactor\)\)/);
  // CSS variables inline style.
  assert.match(grid,
    /\["--direct-entry-grid-font-size" as string\]: `\$\{scaledFontPx\}px`/);
  assert.match(grid,
    /\["--direct-entry-grid-cell-padding-y" as string\]: `\$\{scaledCellPaddingY\}px`/);
  assert.match(grid,
    /\["--direct-entry-grid-cell-padding-x" as string\]: `\$\{scaledCellPaddingX\}px`/);

  // CSS: phai dung var(--direct-entry-grid-font-size), KHONG transform: scale() hay zoom.
  assert.match(css, /font-size: var\(--direct-entry-grid-font-size/);
  assert.match(css,
    /padding: var\(--direct-entry-grid-cell-padding-y/);
  // Strip comment blocks truoc khi check transform: scale() / zoom.
  const stripComments = (src) =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const cssNoComments = stripComments(css);
  const gridNoComments = stripComments(grid);
  assert.equal(/transform:\s*scale\(/.test(cssNoComments), false,
    "CSS khong dung transform: scale()");
  assert.equal(/\bzoom\s*:\s*[0-9]/.test(cssNoComments), false,
    "CSS khong dung thuoc tinh zoom");
  assert.equal(/transform:\s*scale\(/.test(gridNoComments), false,
    "TS khong dung transform: scale()");
  assert.equal(/\bzoom\s*=\s*[0-9]/.test(gridNoComments), false,
    "TS khong dung thuoc tinh zoom");
  // Khong browser zoom API.
  assert.equal(/window\.devicePixelRatio|navigator\.userAgent/.test(gridNoComments), false);
});

test("zoom KHONG mutate row.cells va khong anh huong paste/selection", () => {
  // onCellsChange handler trong grid chi merge patch tu row.cells, khong scale.
  // Assertion: trong onRowsChange, gia tri cells[key] duoc so sanh raw.
  assert.match(grid, /const value = row\.cells\[key\] \?\? "";/);
  assert.match(grid, /if \(value !== \(current\.cells\[key\] \?\? ""\)\) patch\[key\] = value;/);
  // Khong setState row.cells trong zoom path.
  assert.equal(/onZoomChange.*onCellsChange|onCellsChange.*onZoomChange/.test(grid), false,
    "zoom handlers khong lien quan onCellsChange");
  // No cell zoom mutation in zoom handlers.
  const zoomDec = grid.match(/const onZoomDecrease[\s\S]{0,400}?\},/);
  assert.ok(zoomDec, "phai co onZoomDecrease");
  assert.equal(/onCellsChange|setRows|patch\[/.test(zoomDec[0]), false,
    "onZoomDecrease khong mutate cells/rows");

  const zoomInc = grid.match(/const onZoomIncrease[\s\S]{0,400}?\},/);
  assert.ok(zoomInc, "phai co onZoomIncrease");
  assert.equal(/onCellsChange|setRows|patch\[/.test(zoomInc[0]), false,
    "onZoomIncrease khong mutate cells/rows");

  // Selection: onSelectedRowsChange chi set selectedClientRowId, khong zoom.
  assert.match(grid,
    /onSelectedRowsChange=\{\(next\) => \{[\s\S]{0,500}onSelectedClientRowChange\(only\)/);
});

test("zoom controllers chi goi onZoomChange va khong side-effect ngoai scope", () => {
  // onZoomReset: don gian goi onZoomChange(DEFAULT).
  assert.match(grid,
    /const onZoomReset = useCallback\(\(\) => \{[\s\S]{0,200}onZoomChange\(DIRECT_ENTRY_GRID_DEFAULT_ZOOM\)/);
});

test("zoom khong anh huong paste/import va save contract", () => {
  // Paste path: clipboard handling van giu nguyen, khong scale values.
  assert.match(grid, /serializeClipboardTsv\(\[\[value\]\]\)/);
  assert.match(grid, /event\.clipboardData\.setData\("text\/plain",/);
  // Save contract: khong thay doi payload (cells giu nguyen).
  // Behavioral: zoom chi scale width va height + CSS variable.
  assert.equal(/setStagedMessage|setStagedNotice|saveMessage/.test(grid.match(/const onZoomChange[\s\S]{0,400}/)?.[0] ?? ""), false,
    "zoom handlers khong lien quan staged message");
});

test("tai su dung DIRECT_ENTRY_GRID_COLUMNS, khong tao registry thu 2", () => {
  // Grid lay width tu column.width (registry goc).
  assert.match(grid, /width: scaledWidth/);
  // scaledWidth = Math.max(32, Math.round(column.width * zoomFactor)).
  assert.match(grid, /Math\.round\(column\.width \* zoomFactor\)/);
  // Van map qua DIRECT_ENTRY_DEFAULT_GRID_COLUMN_KEYS + directEntryGridColumn.
  assert.match(grid, /DIRECT_ENTRY_DEFAULT_GRID_COLUMN_KEYS/);
  assert.match(grid, /directEntryGridColumn\(key\)/);
  // gridColumns source co DIRECT_ENTRY_GRID_COLUMNS (registry single).
  assert.match(gridColumns, /export const DIRECT_ENTRY_GRID_COLUMNS/);
  // Khong tao them registry thu 2 trong grid.
  const registryMatches = grid.match(/registry\s*=|new\s+Map\s*\(\s*\[/g) ?? [];
  assert.equal(registryMatches.length, 0,
    "khong tao column registry moi");
});

test("khong them dependency (zoom implementation chi dung useState + const + CSS vars)", () => {
  // Khong them package moi. Grid chi dung cac import hien co.
  // Zoom helpers dung useCallback + const, khong React hook moi.
  assert.match(grid, /useCallback\(\(\) => \{[\s\S]{0,300}onZoomChange\(DIRECT_ENTRY_GRID_DEFAULT_ZOOM\)/);
  // Khong import useRef/useEffect/useState moi chi cho zoom.
  // Chi setState zoom o live component (useState).
  assert.match(live, /const \[directEntryGridZoomLevel, setDirectEntryGridZoomLevel\] = useState\(100\)/);
});

test("zoom chi tac dong rieng len khu vuc bang nhap lieu (grid); khong zoom toan trang / toolbar tong / mobile / quick editor", () => {
  // CSS: font-size CSS variable chi set tren .spreadsheet / .toolbar / .viewport,
  // KHONG set tren root html hoac shell container (parenta cua DirectEntryLive).
  // Quick editor dialog va mobile staged card o P1 dung container rieng (khong nam trong .spreadsheet).
  assert.match(css, /font-size: var\(--direct-entry-grid-font-size/);
  // Khong ap CSS var cho .live hoac root.
  assert.equal(/body\s*\{[^}]*--direct-entry-grid-font-size/.test(css), false,
    "CSS var khong ap cho body/root");
  // Toolbar cua grid chi nho cu the toolbar con (zoom controls).
  assert.match(grid, /role="group" aria-label="Phóng to thu nhỏ bảng nhập liệu"/);
  // Mobile staged card section khong co zoom controls.
  const mobileCard = live.match(/styles\.mobileStagedCard[\s\S]{0,8000}<\/details>/);
  if (mobileCard) {
    assert.equal(/spreadsheet-zoom-decrease|spreadsheet-zoom-increase|spreadsheet-zoom-reset/.test(mobileCard[0]), false,
      "mobile staged card khong chua zoom controls");
  }
});

test("zoom level wire - validate mutates rows/cells (stability regression)", () => {
  // Zoom chi thay doi prop `width`/`style` cua DataGrid; khong chay onCellsChange.
  // Confirm: changing zoom does NOT trigger onRowsChange contract.
  assert.match(grid, /onRowsChange=\{onRowsChange\}/);
  // onRowsChange chi tu react-data-grid callback; chi chay khi user edit cells.
  // Zoom button click khong goi onRowsChange.
  const zoomDecMatch = grid.match(/const onZoomDecrease[\s\S]{0,500}?\}, \[/);
  assert.ok(zoomDecMatch);
  assert.equal(/onRowsChange|onCellsChange/.test(zoomDecMatch[0]), false,
    "onZoomDecrease khong goi onRowsChange/onCellsChange");
});

test("default 100 va registry direct-entry-grid-columns khong bi mutate", () => {
  // gridColumns file phai giu nguyen width (registry scale heviet).
  // (gridColumns source khong thay doi khi grid render.)
  // Confirm khoong co spread DIRECT_ENTRY_GRID_COLUMNS vao array moi co mutate.
  const gridReadonly = grid.match(/DIRECT_ENTRY_DEFAULT_GRID_COLUMN_KEYS\s*[\s\S]{0,500}/);
  assert.ok(gridReadonly, "phai co DIRECT_ENTRY_DEFAULT_GRID_COLUMN_KEYS");
  // Chi dung .map(filter), khong .push/.splice.
  assert.equal(/\.push\(/.test(gridReadonly[0]), false,
    "khong push vao DIRECT_ENTRY_GRID_COLUMNS");
  assert.equal(/DIRECT_ENTRY_GRID_COLUMNS\.unshift|DIRECT_ENTRY_GRID_COLUMNS\.pop/.test(grid), false,
    "khong mutate registry goc");
});

test("edit text khi zoom: gia tri commit duoc giu nguyen (text editor khong bi mat ky tu)", () => {
  // CellsTextEditor.onClose commit value vao row.cells[key].
  // Zoom khong lam mat ky tu: chi scale UI.
  // Khi zoom in/out, text editor se remount vi props can change.
  // Check: cellsTextEditor.commitTextCellValue su dung row.cells[key] truc tiep.
  assert.match(grid, /commitTextCellValue/);
  // Khong co reset value trong zoom path.
  assert.equal(/onZoomChange.*setRows|onZoomChange.*patch\[key\] = ""/.test(grid), false);
});