import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const list = readFileSync(new URL("./direct-entry-change-request-list.tsx", import.meta.url), "utf8");
const submissions = readFileSync(new URL("./direct-entry-submission-list.tsx", import.meta.url), "utf8");
const workers = readFileSync(new URL("./worker-operations.tsx", import.meta.url), "utf8");
const live = readFileSync(new URL("./direct-entry-live.tsx", import.meta.url), "utf8");
const panel = readFileSync(new URL("./direct-entry-compact-panel.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("./direct-entry-shell.module.css", import.meta.url), "utf8");
const compactStyles = css.slice(css.indexOf(".compactPanel"), css.indexOf("@media (min-width: 640px)"));

test("live keeps one compact panel of each kind before the worker grid", () => {
  const submission = live.indexOf("<DirectEntrySubmissionList");
  const request = live.indexOf("<DirectEntryChangeRequestList");
  const workerGrid = live.indexOf("<section className={styles.gridSection", request);
  assert.ok(submission > 0 && submission < request && request < workerGrid);
  assert.equal((live.match(/<DirectEntrySubmissionList/g) ?? []).length, 1);
  assert.equal((live.match(/<DirectEntryChangeRequestList/g) ?? []).length, 1);
  assert.match(live.slice(submission, live.indexOf("/>", submission)), /\bcompact\b/);
  assert.match(live.slice(request, live.indexOf("/>", request)), /\bcompact\b/);
  assert.match(panel, /<details className=\{styles\.compactPanel\} aria-labelledby=\{headingId\}>/);
  assert.doesNotMatch(panel, /<details[^>]*\bopen(?:=|\s|>)/);
  assert.doesNotMatch(panel, /<details[^>]*\bkey=/);
  assert.match(panel, /<summary className=\{styles\.compactSummary\}>/);
  assert.match(css, /\.compactSummary:focus-visible/);
});

test("panel summary reports loaded count, pending count, loading, and failure in text", () => {
  assert.match(panel, /\{loadedCount\} đã tải/);
  assert.match(panel, /count\} \{label\}/);
  assert.match(panel, /state === "loading" && <span role="status">Đang tải/);
  assert.match(panel, /state === "error"[\s\S]*Không tải được/);
  assert.match(list, /count: pendingCount, label: "đang chờ xử lý"/);
  assert.match(list, /state === "ready" && requests\.length === 0/);
  assert.match(list, /state === "error" && `Không tải được danh sách yêu cầu thay đổi/);
  assert.match(submissions, /state === "ready" && submissions\.length === 0/);
  assert.match(submissions, /state === "error" && `Không tải được danh sách đợt nhập liệu/);
});

test("native panel toggle neither fetches nor resets open state on list prop updates", () => {
  assert.doesNotMatch(panel, /fetch\(|onToggle=|onClick=|open=\{/i);
  assert.doesNotMatch(live, /<DirectEntryCompactPanel[^>]*key=/);
  assert.match(list, /<DirectEntryCompactPanel/);
  assert.match(submissions, /<DirectEntryCompactPanel/);
  assert.match(submissions, /compact = false/);
});

test("compact cards use a responsive one/two/three-column grid without horizontal overflow", () => {
  assert.match(css, /\.compactList\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
  assert.match(css, /@media \(min-width:\s*640px\)[\s\S]*?\.compactList\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(css, /@media \(min-width:\s*1200px\)[\s\S]*?\.compactList\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(css, /\.compactPanel\s*\{[^}]*min-width:\s*0/s);
  assert.match(css, /\.compactCard\s*\{[^}]*min-width:\s*0/s);
  assert.match(css, /\.compactMeta[^}]*overflow-wrap:\s*anywhere/);
  assert.doesNotMatch(compactStyles, /overflow-x:\s*(?:auto|scroll)|min-width:\s*\d+(?:px|rem)/);
});

test("compact card metadata and actions stay aligned without changing submission list defaults", () => {
  assert.match(list, /compact \? styles\.compactList : styles\.submissionList/);
  assert.match(list, /compact \? styles\.compactMeta : styles\.submissionMeta/);
  assert.match(list, /compact \? styles\.compactActions : styles\.submissionActions/);
  assert.match(submissions, /compact \? styles\.compactList : styles\.submissionList/);
  assert.match(submissions, /compact \? styles\.compactMeta : styles\.submissionMeta/);
  assert.match(submissions, /compact \? styles\.compactActions : styles\.submissionActions/);
  assert.match(css, /\.compactActions\s*\{[^}]*margin-top:\s*auto/s);
  assert.match(css, /\.compactActions > button\s*\{[^}]*min-height:\s*44px/s);
  assert.match(css, /\.submissionList\s*\{[\s\S]*?\n\}/);
  assert.doesNotMatch(css.slice(css.indexOf(".submissionList"), css.indexOf(".submissionCard")),
    /grid-template-columns/);
});

test("review and withdraw continue to use server-projected permission and existing dialogs", () => {
  assert.match(list, /request\.state === "PENDING" && request\.can_decide === true/);
  assert.match(list, /canReviewChangeRequest\(request\) && \(/);
  assert.match(list, /canWithdrawChangeRequest\(request\) && \(/);
  assert.match(list, /onReview\(request\)/);
  assert.match(list, /onWithdraw\(current\)/);
  assert.match(list, /<AlertDialog\.Root/);
  assert.match(list, /AlertDialog\.Action/);
  assert.match(list, /shortRef\(request\.request_id\)/);
  assert.doesNotMatch(list, />\s*\{request\.request_id\}\s*</);
  assert.match(list, /onClick=\{onLoadMore\}/);
  assert.match(workers, /onDecided=\{\(message\) => \{[\s\S]{0,180}reloadRequestPage\(\)/);
});

test("mobile hides both Excel CTAs and keeps quick-add visible without changing workflows", () => {
  const mobileStyles = css.slice(css.indexOf("@media (max-width: 767px)"));
  const desktopStyles = css.slice(0, css.indexOf("@media (max-width: 767px)"));
  assert.match(live, /className=\{`\$\{styles\.secondaryButton\} \$\{styles\.excelButton\}`\}\s*onClick=\{\(\) => void downloadXlsxTemplate\(\)\}/);
  assert.match(live, /className=\{`\$\{styles\.secondaryButton\} \$\{styles\.excelButton\}`\}\s*onClick=\{\(\) => xlsxInputRef\.current\?\.click\(\)\}/);
  assert.match(live, /className=\{`\$\{styles\.secondaryButton\} \$\{styles\.quickAddButton\}`\}\s*data-testid="quick-add-row"/);
  assert.match(desktopStyles, /\.excelButton\s*\{\s*display:\s*inline-flex;/);
  assert.match(desktopStyles, /\.quickAddButton\s*\{\s*display:\s*none;\s*\}/);
  assert.match(mobileStyles, /\.excelButton\s*\{\s*display:\s*none;\s*\}/);
  assert.match(mobileStyles, /\.liveHeaderActions > \.quickAddButton\s*\{\s*display:\s*inline-flex;/);
  assert.equal((live.match(/Tải file Excel mẫu/g) ?? []).length, 1);
  assert.equal((live.match(/Nhập file Excel/g) ?? []).length, 1);
  assert.equal((live.match(/data-testid="quick-add-row"/g) ?? []).length, 1);
  assert.equal((live.match(/ref=\{xlsxInputRef\}/g) ?? []).length, 1);
  assert.match(live, /onChange=\{\(event\) => void onXlsxFile\(event\)\}/);
  assert.match(live, /createWorkerProfileTemplate\(\)/);
  assert.match(live, /workerProfileXlsxToTsv\(file\)/);
  assert.doesNotMatch(live, /window\.innerWidth|matchMedia\(/);
});

test("spreadsheet actions remain unique and outside the header without changing callbacks", () => {
  const header = live.slice(live.indexOf("<header className={styles.header}>"),
    live.indexOf("</header>", live.indexOf("<header className={styles.header}>")));
  assert.equal((live.match(/data-testid="add-rows-batch"/g) ?? []).length, 1);
  assert.equal((live.match(/data-testid="spreadsheet-save"/g) ?? []).length, 1);
  assert.doesNotMatch(header, /data-testid="add-rows-batch"|data-testid="spreadsheet-save"/);
  assert.match(live, /<div className=\{styles\.spreadsheetActions\}>[\s\S]*?data-testid="add-rows-batch"[\s\S]*?data-testid="spreadsheet-save"/);
  assert.match(live, /onClick=\{addStagedRows\}/);
  assert.match(live, /onClick=\{\(\) => void onStagedSave\(\)\}/);
  assert.match(live, /<DirectEntrySpreadsheetGrid/);
});
