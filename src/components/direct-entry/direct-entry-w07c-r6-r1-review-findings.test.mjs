import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  DDMM_SETTLE_IDLE,
  canDdmmSettle,
  decideDdmmCommit,
  formatDateToDDMM,
  reduceDdmmSettle,
} from "../../lib/direct-entry/direct-entry-date-format.ts";

function read(relative) {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}
const live = read("./direct-entry-live.tsx");
const grid = read("./direct-entry-spreadsheet-grid.tsx");
const shell = read("./direct-entry-shell.tsx");
const proposer = read("./direct-entry-change-request-proposer.tsx");
const reviewer = read("./direct-entry-change-request-reviewer.tsx");

/**
 * P3-W07C-R6-R1: quet MOI cach dung ensureCatalog va tra ve cac vi pham.
 * Bat ca: goi truc tiep voi ngay cua row, truyen reference (map(ensureCatalog)),
 * va date-set dung de tai catalog.
 */
export function findCatalogLoadViolations(source) {
  const text = stripComments(source);
  const violations = [];
  // 1. Goi truc tiep: doi so phai la ngay trang (today / hcmTodayDate()).
  for (const match of text.matchAll(/ensureCatalog\s*\(([^)]*)\)/g)) {
    const arg = match[1].trim();
    // Chi chap nhan ngay trang: "today" hoac "hcmTodayDate()" (co the long paren).
    const isPageDate = arg === "today" || arg.startsWith("hcmTodayDate");
    if (!isPageDate) violations.push("direct:" + arg);
  }
  // 2. Truyen reference: map(ensureCatalog) hoac .map(ensureCatalog).
  if (/\.map\(\s*ensureCatalog\s*\)/.test(text)) violations.push("reference:map");
  // 3. Date-set / vong lap theo ngay cua row.
  if (/neededDates/.test(text)) violations.push("dateset:neededDates");
  if (/catalogDates/.test(text)) violations.push("dateset:catalogDates");
  // Bat moi date-set duoc dung de tai catalog: new Set(...firstWorkDate/first_work_date...)
  if (/new Set\([^\n]*(firstWorkDate|first_work_date)/.test(text)) violations.push("dateset:rowDateSet");
  return violations;
}

test("R6-R1-1: bo quet bat duoc dung cac dang tai catalog theo ngay cua ban cu", () => {
  // Chung minh scanner THAT SU sensitive voi code cu (commit 6408945).
  const oldLive = [
    "const neededDates = [...new Set(mapped.map(({ firstWorkDate }) => firstWorkDate))]",
    "  .filter((date) => date !== today);",
    "await Promise.all(neededDates.map(ensureCatalog));",
  ].join("\n");
  const oldProposer = [
    "await Promise.all([...new Set(loaded.map((item) => item.first_work_date))]",
    "  .map((date) => ensureCatalog(date).catch(() => null)));",
  ].join("\n");
  assert.deepEqual(findCatalogLoadViolations(oldLive).sort(),
    ["dateset:neededDates", "dateset:rowDateSet", "reference:map"]);
  assert.deepEqual(findCatalogLoadViolations(oldProposer).sort(),
    ["dateset:rowDateSet", "direct:date"]);
  // Va scanner khong bao dong thuan nao tren code hien tai.
  for (const [name, source] of [["live", live], ["proposer", proposer], ["reviewer", reviewer]]) {
    assert.deepEqual(findCatalogLoadViolations(source), [], name + " con tai catalog theo ngay");
  }
});

test("R6-R1-2: chi catalog ngay HCM cua trang duoc load", () => {
  const calls = [...stripComments(live).matchAll(/ensureCatalog\s*\(([^)]*)\)/g)].map((m) => m[1].trim());
  assert.deepEqual(calls, ["today"], "live.tsx chi con ensureCatalog(today)");
  assert.equal(/neededDates/.test(live), false, "neededDates da bi xoa");
  assert.equal(/\.map\(\s*ensureCatalog\s*\)/.test(live), false);
  // Khong con lookup catalog bang first_work_date o bat ky be mat nao.
  for (const [name, source] of [["live", live], ["proposer", proposer]]) {
    assert.equal(/catalogs\[(row|entry|cells|target)[.\w]*first_work/i.test(source), false, name);
    assert.equal(/catalogFor\(\s*(row|entry|singleEntry|draft)\.first_work_date/.test(source), false, name);
  }
});

test("R6-R1-3: change request khong con native date input cho first_work_date", () => {
  const text = stripComments(proposer);
  assert.equal(/type="date"/.test(text.replace(/id="status-date"[\s\S]{0,200}/, "")), false,
    "chi con status-date (field nghiep vu khac) duoc phep la native date");
  assert.match(text, /<DdmmDateInput/);
  assert.match(text, /onCommit=\{\(iso\) => editEntry\(entry\.entry_id, \{ first_work_date: iso \}\)\}/);
  // status-date (ngay hieu luc trang thai) KHONG bi doi.
  assert.match(text, /id="status-date" type="date"/);
});

test("R6-R1-4: ngay trong change request khong dieu khien catalog Du an / Nguoi tuyen", () => {
  const text = stripComments(proposer);
  assert.equal(/catalogFor\(entry\.first_work_date\)/.test(text), false);
  assert.equal(/catalogFor\(singleEntry\.first_work_date\)/.test(text), false);
  assert.match(text, /const catalog = catalogFor\(hcmTodayDate\(\)\);/);
});

test("R6-R1-5/6/7/8: vong doi settle cua editor ngay", () => {
  // 5. Commit hai lan lien tiep (sau khi parent cap nhat value).
  let state = DDMM_SETTLE_IDLE;
  assert.equal(canDdmmSettle(state), true, "luot dau commit duoc");
  state = reduceDdmmSettle(state, "settle");
  assert.equal(canDdmmSettle(state), false, "trong cung luot thi khong commit lai");
  state = reduceDdmmSettle(state, "edit");
  assert.equal(canDdmmSettle(state), true, "go tiep => luot moi, commit duoc lan hai");
  state = reduceDdmmSettle(state, "settle");
  assert.equal(canDdmmSettle(state), false);

  // 6. Nhap sai -> sua dung -> commit duoc.
  assert.equal(decideDdmmCommit("31/02/2026", "2026-10-02").ok, false);
  let afterInvalid = reduceDdmmSettle(DDMM_SETTLE_IDLE, "settle");
  afterInvalid = reduceDdmmSettle(afterInvalid, "focus");
  assert.equal(canDdmmSettle(afterInvalid), true, "focus lai sau khi sai van commit duoc");
  assert.equal(decideDdmmCommit("02/10/2026", "2026-10-02").iso, "2026-10-02");

  // 7. Enter roi blur chi settle mot lan.
  let enterThenBlur = reduceDdmmSettle(DDMM_SETTLE_IDLE, "settle");
  assert.equal(canDdmmSettle(enterThenBlur), false, "blur sau Enter khong commit lan hai");

  // 8. Escape khong commit va luot sau van commit duoc.
  const afterEscape = reduceDdmmSettle(reduceDdmmSettle(DDMM_SETTLE_IDLE, "settle"), "escape");
  assert.equal(canDdmmSettle(afterEscape), true, "Escape mo lai luot moi");
  assert.equal(afterEscape.settled, false);
  // Editor dung reducer + canDdmmSettle, khong dung co boolean khong reset.
  const ddmm = read("./direct-entry-ddmm-date-input.tsx");
  assert.match(ddmm, /reduceDdmmSettle\(settle\.current, action\)/);
  assert.match(ddmm, /if \(!canDdmmSettle\(settle\.current\)\) return;/);
  assert.equal(/settled\.current = true/.test(ddmm), false, "khong con co settled khong reset");
});

test("R6-R1-9: khong con native date input cho first_work_date tren moi be mat", () => {
  for (const [name, source] of [["live", live], ["grid", grid], ["shell", shell], ["proposer", stripComments(proposer).replace(/id="status-date"[\s\S]{0,200}/, "")]]) {
    assert.equal(/type="date"/.test(stripComments(source)), false, name + " con type=date");
  }
  assert.equal(formatDateToDDMM("2026-10-02"), "02/10/2026");
});
