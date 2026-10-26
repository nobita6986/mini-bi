import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const list = readFileSync(new URL("./direct-entry-change-request-list.tsx", import.meta.url), "utf8");
const reviewer = readFileSync(new URL("./direct-entry-change-request-reviewer.tsx", import.meta.url), "utf8");
const submissions = readFileSync(new URL("./direct-entry-submission-list.tsx", import.meta.url), "utf8");
const queueTabs = readFileSync(new URL("./direct-entry-queue-tabs.tsx", import.meta.url), "utf8");
const live = readFileSync(new URL("./direct-entry-live.tsx", import.meta.url), "utf8");
const workspace = readFileSync(new URL("./change-requests-workspace.tsx", import.meta.url), "utf8");
const panel = readFileSync(new URL("./direct-entry-compact-panel.tsx", import.meta.url), "utf8");
const grid = readFileSync(new URL("./direct-entry-spreadsheet-grid.tsx", import.meta.url), "utf8");
const gridCss = readFileSync(new URL("./direct-entry-spreadsheet-grid.module.css", import.meta.url), "utf8");
const css = readFileSync(new URL("./direct-entry-shell.module.css", import.meta.url), "utf8");
const compactStyles = css.slice(css.indexOf(".compactPanel"), css.indexOf("@media (min-width: 640px)"));

test("live keeps compact submission panel before the worker grid and change-request list lives in dedicated workspace", () => {
  const submission = live.indexOf("<DirectEntrySubmissionList");
  const workerGrid = live.indexOf("<section className={styles.gridSection", submission);
  assert.ok(submission > 0 && submission < workerGrid);
  assert.equal((live.match(/<DirectEntrySubmissionList/g) ?? []).length, 1);
  assert.equal((live.match(/<DirectEntryChangeRequestList/g) ?? []).length, 0);
  assert.equal((workspace.match(/<DirectEntryChangeRequestList/g) ?? []).length, 1);
  assert.match(live.slice(submission, live.indexOf("/>", submission)), /\bcompact\b/);
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
  assert.match(list, /count: displayedCount,[\s\S]*queueFilter === "GLOBAL_AUDIT" \? "lịch sử duyệt"/);
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

test("review queue separates pending/history and fits compact cards in a scrollable 1-5 column grid", () => {
  assert.match(list, /ariaLabel="Trạng thái yêu cầu thay đổi"/);
  assert.match(list, /Chờ duyệt/);
  assert.match(list, /Đã xử lý/);
  assert.match(list, /Lịch sử duyệt/);
  assert.match(list, /canViewGlobalHistory \? QUEUE_TABS/);
  assert.match(list, /onGlobalHistoryAgeFilterChange\?\.\(filter\)/);
  assert.match(list, /data-testid="change-request-decision-audit"/);
  assert.match(list, /useState<ResolvedAgeFilter>\("3"\)/);
  assert.match(list, /value="3">3 ngày gần nhất/);
  assert.match(list, /value="7">7 ngày gần nhất/);
  assert.match(list, /value="30">30 ngày gần nhất/);
  assert.match(list, /value="all">Toàn bộ lịch sử/);
  assert.match(list, /isWithinResolvedAge\(request, resolvedAgeFilter, props\.queueFilter === "GLOBAL_AUDIT"\)/);
  assert.match(queueTabs, /role="tablist" aria-label=\{ariaLabel\}/);
  assert.match(queueTabs, /onChange\(tabs\[next\]\.value\)/);
  assert.match(reviewer, /request_reason/);
  assert.match(reviewer, /const terminal = detail\.state !== "PENDING"/);
  assert.match(reviewer, /const readOnlyView = terminal \|\| !detail\.can_decide/);
  assert.match(reviewer, /if \(readOnlyView\) \{[\s\S]*kind: "terminal"/);
  assert.match(css, /\.compactListViewport\s*\{[^}]*max-height:[^}]*overflow-y:\s*auto/s);
  assert.match(css, /\.compactList\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
  assert.match(css, /@media \(min-width:\s*640px\)[\s\S]*?\.compactList\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(css, /@media \(min-width:\s*1200px\)[\s\S]*?\.compactList\s*\{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(css, /@media \(min-width:\s*1600px\)[\s\S]*?\.compactList\s*\{[^}]*grid-template-columns:\s*repeat\(5,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(css, /\.compactPanel\s*\{[^}]*min-width:\s*0/s);
  assert.match(css, /\.compactCard\s*\{[^}]*min-width:\s*0/s);
  assert.match(css, /\.compactMeta[^}]*overflow-wrap:\s*anywhere/);
  assert.doesNotMatch(compactStyles, /overflow-x:\s*(?:auto|scroll)|min-width:\s*\d+(?:px|rem)/);
});

test("uploader queue separates active submissions from history and hides terminal change-request action", () => {
  assert.match(submissions, /ariaLabel="Trạng thái đợt nhập liệu"/);
  assert.match(submissions, /value: "ACTIVE", label: "Đang gửi"/);
  assert.match(submissions, /value: "HISTORY", label: "Lịch sử gửi"/);
  assert.doesNotMatch(submissions, /onRequestChange|Yêu cầu thay đổi/);
  assert.match(submissions, /onManageDocuments\(submission\)/);
  assert.match(submissions, /Quản lý tài liệu/);
  assert.match(live, /useState<SubmissionQueueFilter>\("ACTIVE"\)/);
  assert.match(live, /state: queue/);
  assert.match(live, /loadSubmissions\("replace", queue\)/);
  assert.match(live, /queueFilter=\{submissionQueue\}/);
  assert.match(live, /submissionQueueRef\.current = queue;[\s\S]{0,120}setSubmissions\(\[\]\)/);
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
  assert.match(workspace, /onDecided=\{\(message\) => \{[\s\S]{0,160}reloadAfterChangeRequestMutation\(message/);
});

test("Excel CTAs stay hidden at every breakpoint and quick-add remains visible on mobile", () => {
  const mobileStyles = css.slice(css.indexOf("@media (max-width: 767px)"));
  const desktopStyles = css.slice(0, css.indexOf("@media (max-width: 767px)"));
  assert.match(live, /className=\{`\$\{styles\.secondaryButton\} \$\{styles\.excelButton\}`\}\s*onClick=\{\(\) => void downloadXlsxTemplate\(\)\}/);
  assert.match(live, /className=\{`\$\{styles\.secondaryButton\} \$\{styles\.excelButton\}`\}\s*onClick=\{\(\) => xlsxInputRef\.current\?\.click\(\)\}/);
  assert.equal((live.match(/className=\{`\$\{styles\.secondaryButton\} \$\{styles\.excelButton\}`\}[\s\S]{0,100}?hidden>/g) ?? []).length, 2);
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

test("spreadsheet actions live once at the end of the grid toolbar", () => {
  const header = live.slice(live.indexOf("<header className={styles.header}>"),
    live.indexOf("</header>", live.indexOf("<header className={styles.header}>")));
  const toolbarStart = grid.indexOf("<div className={styles.toolbar}>");
  const toolbarEnd = grid.indexOf('<div className={styles.viewport}>', toolbarStart);
  const toolbar = grid.slice(toolbarStart, toolbarEnd);
  assert.equal((live.match(/data-testid="add-rows-batch"/g) ?? []).length, 1);
  assert.equal((live.match(/data-testid="spreadsheet-save"/g) ?? []).length, 1);
  assert.doesNotMatch(header, /data-testid="add-rows-batch"|data-testid="spreadsheet-save"/);
  assert.doesNotMatch(live, /styles\.spreadsheetActions/);
  assert.match(live, /toolbarActions=\{\s*<>[\s\S]*?data-testid="add-rows-batch"[\s\S]*?data-testid="spreadsheet-save"[\s\S]*?<\/>\s*\}/);
  assert.ok(toolbarStart >= 0 && toolbarEnd > toolbarStart);
  assert.ok(toolbar.indexOf("styles.zoomControls") < toolbar.indexOf("data-testid=\"spreadsheet-paste-notice\""));
  assert.ok(toolbar.indexOf("data-testid=\"spreadsheet-save-message\"") < toolbar.indexOf("styles.toolbarActions"));
  assert.match(toolbar, /<div className=\{styles\.toolbarActions\}>\s*\{toolbarActions\}\s*<\/div>/);
  assert.match(gridCss, /\.toolbarActions\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;[^}]*margin-left:\s*auto/s);
  assert.match(gridCss, /\.toolbarActions > button\s*\{[^}]*min-height:\s*35px;[^}]*padding:\s*0 10px;[^}]*white-space:\s*nowrap;/s);
  assert.match(live, /className=\{styles\.secondaryButton\}\s*data-testid="add-rows-batch"\s*onClick=\{addStagedRows\}\s*disabled=\{loadState !== "ready" \|\| !canAddStagedRows\(stagedModel\)\}/);
  assert.match(live, /className=\{styles\.primaryButton\}\s*data-testid="spreadsheet-save" onClick=\{\(\) => void onStagedSave\(\)\}\s*disabled=\{loadState !== "ready" \|\| stagedBusy \|\|\s*\(editingDraftSubmissionId === null && !hasActiveLaborTypes\)\}\s*aria-busy=\{stagedBusy\}/);
  assert.match(grid, /data-testid="spreadsheet-undo" onClick=\{onUndo\}/);
  assert.match(grid, /data-testid="spreadsheet-paste-notice"/);
  assert.match(grid, /data-testid="spreadsheet-error-summary"/);
  assert.match(grid, /data-testid="spreadsheet-header-issues"/);
  assert.match(grid, /data-testid="spreadsheet-save-message"/);
  assert.match(live, /onClick=\{addStagedRows\}/);
  assert.match(live, /onClick=\{\(\) => void onStagedSave\(\)\}/);
  assert.match(live, /<DirectEntrySpreadsheetGrid[\s\S]*?toolbarActions=/);
});
