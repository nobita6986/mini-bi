import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const list = readFileSync(new URL("./direct-entry-change-request-list.tsx", import.meta.url), "utf8");
const workers = readFileSync(new URL("./worker-operations.tsx", import.meta.url), "utf8");
const live = readFileSync(new URL("./direct-entry-live.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("./direct-entry-shell.module.css", import.meta.url), "utf8");
const scopedCss = css.slice(css.indexOf(".changeRequestPanel"), css.indexOf(".confirmDialog"));
const compactPanel = list.slice(list.indexOf("export function DirectEntryChangeRequestList"));
const mobileGridCss = scopedCss.slice(0, scopedCss.indexOf("@media (min-width: 640px)"));

test("worker change requests use one native collapsed panel before the worker table", () => {
  const requestList = workers.indexOf("<DirectEntryChangeRequestList");
  const workerPanel = workers.indexOf('role="tabpanel"');
  assert.ok(requestList >= 0 && requestList < workerPanel);
  assert.equal((workers.match(/<DirectEntryChangeRequestList/g) ?? []).length, 1);
  assert.match(workers.slice(requestList, workerPanel), /compact/);
  assert.match(list, /<details className=\{styles\.changeRequestPanel\}>/);
  assert.match(list, /<summary className=\{styles\.changeRequestSummary\}>/);
  assert.doesNotMatch(list, /<details[^>]*\bopen(?:=|\s|>)/);
  assert.doesNotMatch(list, /<details[^>]*\bkey=/);
  assert.match(scopedCss, /\.changeRequestSummary:focus-visible/);
});

test("summary reports loaded, pending, loading, and failed states in text", () => {
  assert.match(list, /props\.requests\.length\} đã tải/);
  assert.match(list, /pendingCount > 0 && <span>\{pendingCount\} đang chờ xử lý<\/span>/);
  assert.match(list, /hasError && <span className=\{styles\.changeRequestError\}>Không tải được<\/span>/);
  assert.match(list, /props\.state === "loading" && <span role="status">Đang tải/);
  assert.match(list, /state === "ready" && requests\.length === 0/);
  assert.match(list, /state === "error" && `Không tải được danh sách yêu cầu thay đổi/);
  assert.match(list, /className=\{styles\.changeRequestToggle\}>Mở \/ thu gọn/);
});

test("native toggle does not fetch, and uncontrolled open state survives list prop updates", () => {
  assert.doesNotMatch(compactPanel, /fetch\(|onToggle=|onClick=/i);
  assert.doesNotMatch(workers.slice(workers.indexOf("<DirectEntryChangeRequestList"),
    workers.indexOf('role="tabpanel"')), /key=|onToggle=|open=\{/);
  assert.match(list, /<details className=\{styles\.changeRequestPanel\}>/);
});

test("compact cards form a responsive grid and fit narrow viewports", () => {
  assert.match(scopedCss, /\.changeRequestList\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
  assert.match(scopedCss, /@media \(min-width:\s*640px\)[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(scopedCss, /@media \(min-width:\s*1200px\)[\s\S]*?grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(scopedCss, /\.changeRequestPanel\s*\{[^}]*min-width:\s*0/s);
  assert.match(scopedCss, /\.changeRequestCard\s*\{[^}]*min-width:\s*0/s);
  assert.match(scopedCss, /\.changeRequestMeta[^}]*overflow-wrap:\s*anywhere/);
  assert.doesNotMatch(mobileGridCss, /overflow-x:\s*(?:auto|scroll)|min-width:\s*\d+(?:px|rem)/);
});

test("compact card metadata and actions stay scoped away from submission cards", () => {
  assert.match(list, /compact \? styles\.changeRequestList : styles\.submissionList/);
  assert.match(list, /compact \? styles\.changeRequestMeta : styles\.submissionMeta/);
  assert.match(list, /compact \? styles\.changeRequestActions : styles\.submissionActions/);
  assert.match(scopedCss, /\.changeRequestActions\s*\{[^}]*margin-top:\s*auto/s);
  assert.match(scopedCss, /\.changeRequestActions > button\s*\{[^}]*min-height:\s*44px/s);
  assert.match(css, /\.submissionList\s*\{[\s\S]*?\n\}/);
  assert.doesNotMatch(css.slice(css.indexOf(".submissionList"), css.indexOf(".submissionCard")),
    /grid-template-columns/);
});

test("review and withdraw actions remain gated by the existing server projection", () => {
  assert.match(list, /request\.state === "PENDING" && request\.can_decide === true/);
  assert.match(list, /canReviewChangeRequest\(request\) && \(/);
  assert.match(list, /canWithdrawChangeRequest\(request\) && \(/);
  assert.match(list, /onReview\(request\)/);
  assert.match(list, /onWithdraw\(current\)/);
  assert.match(list, /<AlertDialog\.Root/);
  assert.match(list, /AlertDialog\.Action/);
});

test("cards show only short references and preserve the existing decision flows", () => {
  assert.match(list, /shortRef\(request\.request_id\)/);
  assert.doesNotMatch(list, />\s*\{request\.request_id\}\s*</);
  assert.match(list, /onClick=\{onLoadMore\}/);
  assert.match(list, /onClick=\{\(\) => onReview\(request\)\}/);
  assert.match(list, /setPendingWithdraw\(request\)/);
  assert.match(workers, /onDecided=\{\(message\) => \{[\s\S]{0,180}reloadRequestPage\(\)/);
});

test("Direct Entry live keeps its existing outer collapsed panel and one list", () => {
  assert.match(live, /<details className=\{styles\.secondaryPanel\}>\s*<summary>Yêu cầu thay đổi/);
  const request = live.indexOf("<DirectEntryChangeRequestList");
  assert.equal((live.match(/<DirectEntryChangeRequestList/g) ?? []).length, 1);
  assert.doesNotMatch(live.slice(request, live.indexOf("/>", request)), /\bcompact\b/);
});
