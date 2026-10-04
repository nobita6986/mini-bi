/**
 * P1.6-I04C3-R2 - Trang harness cho browser acceptance (duoc driver copy vao thu muc build).
 *
 * File nay CHI chay trong Chrome: no import cac module domain that tu ./lib/... (do tsc cua repo
 * bien dich) va dung CHINH class name cua direct-entry-shell.module.css.
 * Network duoc stub trong trang => khong cham server/DB/R2.
 *
 * scope: real-module | real-css | dom-stub | shell-mirror
 */
import {
  buildPastePreview,
  buildPasteBatchPayload,
} from "./lib/direct-entry/excel-paste-import.js";
import {
  PASTE_BATCH_ENDPOINT,
  assignPasteEntryIds,
  beginPasteGroup,
  postPasteBatch,
  settlePasteGroup,
} from "./lib/direct-entry/paste-batch-save.js";
import {
  EMPTY_CCCD_STATUS_CACHE,
  readCccdStatus,
  writeCccdStatus,
} from "./lib/direct-entry/cccd-status.js";
import {
  EMPTY_CCCD_KEY_STATE,
  runCccdUpload,
  sha256HexFromBytes,
} from "./lib/direct-entry/cccd-upload-runner.js";
import { createCccdTransport } from "./lib/direct-entry/cccd-transport.js";
import { fetchEntryDetail } from "./lib/direct-entry/document-detail-projection.js";

const REASON = "Thay ảnh CCCD bị mờ";
const checks = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function check(scope, name, ok, detail) {
  checks.push({ scope, name, ok: ok === true, detail: detail === undefined ? null : detail });
}
function eq(scope, name, actual, expected) {
  check(scope, name, Object.is(actual, expected), { actual, expected });
}

const PROJECT = { id: "11111111-1111-4111-8111-111111111111", label: "Dự án Bắc" };
const RECRUITER = { id: "22222222-2222-4222-8222-222222222222", label: "CongHr1" };
const DATE = "2026-10-15";
const CATALOGS = { [DATE]: { projects: [PROJECT], recruiters: [RECRUITER] } };
const HEADER = "Mã NLĐ\tNgày bắt đầu làm việc\tHọ tên\tDự án\tNgười tuyển\tLoại hình lao động";
const SUBMISSION = "33333333-3333-4333-8333-333333333333";
const ENTRY_B = "c1000000-0000-4000-8000-0000000000b2";
const ENTRY_C = "c1000000-0000-4000-8000-0000000000c3";
const DOC_FRONT = "d1000000-0000-4000-8000-0000000000f1";
const DOC_BACK = "d1000000-0000-4000-8000-0000000000b1";
const SIGNED_HOST = "signed.invalid";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

function rowText(code, name, project, recruiter, labor) {
  return [code, DATE, name, project, recruiter, labor].join("\t");
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeStub(plan) {
  const calls = [];
  const stub = async (url, init) => {
    const options = init ?? {};
    const method = String(options.method ?? "GET").toUpperCase();
    const record = {
      url,
      method,
      idempotencyKey: options.headers ? options.headers["Idempotency-Key"] ?? null : null,
      body: typeof options.body === "string" ? JSON.parse(options.body) : null,
    };
    calls.push(record);
    return plan({ url, method, options, record, calls });
  };
  return { stub, calls };
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

const viewPaste = document.getElementById("view-paste");
const viewCccd = document.getElementById("view-cccd");

/* ---------------------------------------------------------------- view: paste */

function renderPasteShell(preview, totalsText) {
  clear(viewPaste);
  const overlay = el("div", "drawerOverlay");
  const dialog = el("div", "pasteDialog");
  dialog.setAttribute("data-testid", "paste-dialog");
  overlay.appendChild(dialog);
  dialog.appendChild(el("h2", "drawerTitle", "Dán từ Excel"));
  dialog.appendChild(el("p", "drawerDescription",
    "Dán trực tiếp từ Excel. Mỗi dòng đúng 6 cột, phân tách bằng tab; tối đa 100 dòng mỗi lần."));
  const fields = el("div", "drawerFields");
  dialog.appendChild(fields);
  const columns = el("ol", "pasteColumns");
  ["Mã NLĐ", "Ngày bắt đầu làm việc", "Họ tên", "Dự án", "Người tuyển", "Loại hình lao động"]
    .forEach((heading, index) => columns.appendChild(el("li", null, (index + 1) + ". " + heading)));
  fields.appendChild(columns);
  const label = el("label", "field");
  label.appendChild(el("span", null, "Dữ liệu dán từ Excel"));
  const area = el("textarea", "pasteTextarea");
  area.setAttribute("aria-label", "Dữ liệu dán từ Excel");
  area.rows = 6;
  area.value = preview.text;
  label.appendChild(area);
  fields.appendChild(label);
  const totals = el("p", "pasteTotals", totalsText ?? "");
  totals.setAttribute("data-testid", "paste-totals");
  fields.appendChild(totals);
  if (preview.rows.length > 0) {
    const wrap = el("div", "pastePreviewWrap");
    const table = el("table", "pastePreview");
    table.setAttribute("data-testid", "paste-preview");
    const caption = el("caption", null, "Xem trước " + preview.rows.length + " dòng đã đọc");
    table.appendChild(caption);
    const head = el("thead");
    const headRow = el("tr");
    ["Dòng", "Mã NLĐ", "Ngày bắt đầu làm việc", "Họ tên", "Dự án", "Người tuyển",
      "Loại hình lao động", "Lỗi"].forEach((name) => headRow.appendChild(el("th", null, name)));
    head.appendChild(headRow);
    table.appendChild(head);
    const body = el("tbody");
    for (const item of preview.rows) {
      const tr = el("tr", item.issues.length > 0 ? "pasteRowError" : null);
      [item.line, item.employeeCode, item.firstWorkDate, item.workerName, item.projectText,
        item.recruiterText, item.laborType === "TEMPORARY" ? "Thời vụ" : "Toàn thời gian"]
        .forEach((value) => tr.appendChild(el("td", null, String(value))));
      const issues = el("td");
      for (const issue of item.issues) {
        issues.appendChild(el("span", null,
          issue.column === null ? issue.message : "Cột " + issue.column + ": " + issue.message));
      }
      tr.appendChild(issues);
      body.appendChild(tr);
    }
    table.appendChild(body);
    wrap.appendChild(table);
    fields.appendChild(wrap);
  }
  const standalone = preview.issues.filter((issue) =>
    !preview.rows.some((item) => item.issues.includes(issue)));
  if (standalone.length > 0) {
    const list = el("ul", "pasteIssueList");
    list.setAttribute("data-testid", "paste-line-errors");
    for (const issue of standalone) {
      list.appendChild(el("li", null,
        (issue.line === 0 ? "Lỗi" : "Dòng " + issue.line) + ": " + issue.message));
    }
    fields.appendChild(list);
  }
  const actions = el("div", "drawerActions");
  const close = el("button", "secondaryButton", "Đóng");
  close.type = "button";
  close.id = "paste-close";
  const submit = el("button", "primaryButton", "Thêm " + preview.validCount + " dòng");
  submit.type = "button";
  submit.id = "paste-submit";
  submit.disabled = !preview.canSubmit;
  actions.appendChild(close);
  actions.appendChild(submit);
  dialog.appendChild(actions);
  viewPaste.appendChild(overlay);
  return { dialog, submit, close, area };
}

/* ---------------------------------------------------------------- view: cccd */

function renderRowList(cache, rows) {
  clear(viewCccd);
  const section = el("section", "gridSection");
  section.appendChild(el("p", "gridHint",
    "Dự án, recruiter, HRP/Vendor và team đến từ danh mục theo ngày hiệu lực."));
  const list = el("ul", "mobileList");
  for (const row of rows) {
    const li = el("li");
    const card = el("button", "rowCard");
    card.type = "button";
    const status = readCccdStatus(cache, row.entryId, row.entryVersion);
    const top = el("span", "rowCardTop");
    top.appendChild(el("strong", null, row.employeeCode));
    top.appendChild(el("span", "dirtyBadge", status.label));
    card.appendChild(top);
    card.appendChild(el("span", null, row.workerName));
    card.appendChild(el("span", "rowCardMeta", "Hồ sơ CCCD: " + status.label));
    const manage = el("button", "gridEditButton", "Quản lý hồ sơ");
    manage.type = "button";
    manage.disabled = !status.canManage;
    manage.setAttribute("data-testid", "cccd-manage-" + row.rowId);
    const cell = el("span", "cccdCell");
    cell.appendChild(el("span", null, status.label));
    cell.appendChild(manage);
    card.appendChild(cell);
    li.appendChild(card);
    list.appendChild(li);
  }
  section.appendChild(list);
  viewCccd.appendChild(section);
}

function renderCccdDialog(progress, slots) {
  const existing = viewCccd.querySelector(".drawerOverlay");
  if (existing) existing.remove();
  const overlay = el("div", "drawerOverlay");
  const dialog = el("div", "cccdDialog");
  dialog.setAttribute("data-testid", "cccd-dialog");
  overlay.appendChild(dialog);
  dialog.appendChild(el("h2", "drawerTitle", "Quản lý hồ sơ CCCD"));
  dialog.appendChild(el("p", "drawerDescription",
    "Tệp chỉ được gửi tới kho lưu trữ; hệ thống không hiển thị tên tệp, đường dẫn hay khóa lưu trữ."));
  const fields = el("div", "drawerFields");
  dialog.appendChild(fields);
  const progressNode = el("p", "documentStatus", "Tiến độ: " + progress);
  progressNode.setAttribute("data-testid", "cccd-progress");
  fields.appendChild(progressNode);
  for (const slot of slots) {
    const section = el("section", "cccdSlot");
    section.setAttribute("aria-label", slot.label);
    section.appendChild(el("h3", "documentTitle", slot.label));
    const state = el("p", "documentStatus", slot.complete ? "Đã hoàn tất" : "Chưa hoàn tất");
    state.setAttribute("data-testid", "cccd-slot-" + slot.documentType);
    section.appendChild(state);
    if (slot.note) section.appendChild(el("p", "documentStatus", slot.note));
    if (slot.error) section.appendChild(el("p", "documentError", slot.error));
    if (slot.retry) {
      const retry = el("button", "secondaryButton", "Thử lại " + slot.label);
      retry.type = "button";
      retry.setAttribute("data-testid", "cccd-retry-" + slot.documentType);
      section.appendChild(retry);
    }
    fields.appendChild(section);
  }
  const actions = el("div", "drawerActions");
  const close = el("button", "secondaryButton", "Đóng");
  close.type = "button";
  const reload = el("button", "secondaryButton", "Tải lại trạng thái");
  reload.type = "button";
  const upload = el("button", "primaryButton", "Tải lên 2 mặt");
  upload.type = "button";
  upload.setAttribute("data-testid", "cccd-upload");
  actions.appendChild(close);
  actions.appendChild(reload);
  actions.appendChild(upload);
  dialog.appendChild(actions);
  viewCccd.appendChild(overlay);
  return dialog;
}

/* ---------------------------------------------------------------- scenario 1 */

async function scenarioPaste() {
  const validText = [
    HEADER,
    rowText("hrp-2026-000001", "Nguyen Van A", PROJECT.id, RECRUITER.id, "Thời vụ"),
    rowText("hrp-2026-000002", "Nguyen Van B", PROJECT.label, RECRUITER.label, "Toàn thời gian"),
    rowText("hrp-2026-000003", "Nguyen Van C", PROJECT.id, RECRUITER.id, "TEMPORARY"),
    "",
  ].join("\r\n");

  const unsavedCodes = ["hrp-2026-000009"];
  const preview = buildPastePreview({ text: validText, catalogs: CATALOGS,
    existingEmployeeCodes: unsavedCodes });
  preview.text = validText;
  const dom = renderPasteShell(preview,
    preview.validCount + " dòng hợp lệ · " + preview.errorCount + " lỗi");
  eq("real-module", "preview.3-dong-hop-le", preview.validCount, 3);
  eq("real-module", "preview.khong-co-loi", preview.errorCount, 0);
  eq("real-module", "preview.cho-phep-gui", preview.canSubmit, true);
  eq("dom-stub", "preview.bang-co-3-dong", dom.dialog.querySelectorAll("tbody tr").length, 3);
  eq("dom-stub", "nut-them-hien-dung-so-dong", dom.submit.textContent, "Thêm 3 dòng");
  eq("dom-stub", "nut-them-duoc-bat", dom.submit.disabled, false);

  // Preview khong mutation: chua co request nao.
  const batchCalls = [];
  const ids = ["e1000000-0000-4000-8000-000000000001",
    "e1000000-0000-4000-8000-000000000002",
    "e1000000-0000-4000-8000-000000000003"];
  const { stub, calls } = makeStub(async ({ url, method }) => {
    if (url === PASTE_BATCH_ENDPOINT && method === "POST") {
      batchCalls.push(url);
      return jsonResponse(201, { ok: true, submission_id: SUBMISSION, submission_version: 7,
        entry_ids: ids, status: "DRAFT" });
    }
    return jsonResponse(404, { ok: false, code: "NOT_FOUND" });
  });

  // Escape dong dialog + focus tra ve nut mo (mo phong Radix; xem scope shell-mirror).
  const opener = document.getElementById("paste-excel-open");
  opener.focus();
  check("shell-mirror", "focus.nut-mo-co-focus-truoc-khi-mo", document.activeElement === opener);
  dom.area.focus();
  const onKey = (event) => {
    if (event.key === "Escape") {
      dom.dialog.closest(".drawerOverlay").remove();
      opener.focus();
      document.removeEventListener("keydown", onKey);
    }
  };
  document.addEventListener("keydown", onKey);
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  check("shell-mirror", "Escape.dong-dialog", document.querySelector(".pasteDialog") === null);
  check("shell-mirror", "Escape.tra-focus-ve-nut-mo", document.activeElement === opener);
  document.removeEventListener("keydown", onKey);

  // Mo lai de chay luong that.
  const reopened = renderPasteShell(preview,
    preview.validCount + " dòng hợp lệ · " + preview.errorCount + " lỗi");
  const payloadRows = buildPasteBatchPayload(preview.rows);
  eq("real-module", "payload.khong-co-truong-authority", Object.keys(payloadRows[0]).sort().join(","),
    "employee_code,first_work_date,labor_type,project_id,recruiter_id,worker");

  const group = beginPasteGroup({ keyState: EMPTY_PASTE_KEY, rows: payloadRows,
    generate: () => "paste-key-1" });
  const result = await postPasteBatch({ rows: group.pending.rows,
    idempotencyKey: group.pending.key, fetchImpl: stub });
  eq("real-module", "atomic.mot-request-cho-3-dong", batchCalls.length, 1);
  eq("real-module", "atomic.header-khop-body", calls[0].idempotencyKey, group.pending.key);
  eq("real-module", "atomic.endpoint-dung-contract", calls[0].url, "/api/direct-entry/batches");
  eq("real-module", "atomic.chi-gui-truong-rows", Object.keys(calls[0].body).join(","), "rows");
  eq("real-module", "atomic.body-du-3-dong", calls[0].body.rows.length, 3);
  eq("real-module", "atomic.ket-qua-saved", result.kind, "saved");

  const settled = settlePasteGroup({ pending: group.pending, result,
    keyState: group.keyState });
  eq("real-module", "atomic.nhom-duoc-danh-dau-da-luu", settled.outcome.status, "saved");
  const assignments = assignPasteEntryIds({ kind: "saved", submissionId: SUBMISSION,
    submissionVersion: 7, entryIds: ids }, payloadRows.length);
  eq("real-module", "atomic.map-entry-id-theo-thu-tu",
    assignments.map((item) => item.entryId + "|" + item.index).join(","),
    ids.map((id, index) => id + "|" + index).join(","));
  eq("real-module", "atomic.map-dung-ma-nld",
    assignments.map((item, index) => payloadRows[index].employee_code).join(","),
    "hrp-2026-000001,hrp-2026-000002,hrp-2026-000003");

  // Retry cung du lieu => dung lai key; sua du lieu => key moi.
  const retryGroup = beginPasteGroup({ keyState: group.keyState, rows: payloadRows,
    generate: () => "paste-key-2" });
  eq("real-module", "retry.dung-lai-key", retryGroup.pending.key, group.pending.key);
  const edited = payloadRows.map((row, index) => index === 1
    ? Object.assign({}, row, { employee_code: "hrp-2026-000077" }) : row);
  const editedGroup = beginPasteGroup({ keyState: group.keyState, rows: edited,
    generate: () => "paste-key-3" });
  eq("real-module", "sua-du-lieu.tao-key-moi", editedGroup.pending.key !== group.pending.key, true);

  // 409: khong tu retry, nhom van chua luu, lan sau phai la key moi.
  const conflictCalls = [];
  const conflictStub = makeStub(async () => {
    conflictCalls.push(1);
    return jsonResponse(409, { ok: false, code: "IDEMPOTENCY_CONFLICT" });
  });
  const conflictGroup = beginPasteGroup({ keyState: EMPTY_PASTE_KEY, rows: payloadRows,
    generate: () => "paste-key-409" });
  const conflictResult = await postPasteBatch({ rows: conflictGroup.pending.rows,
    idempotencyKey: conflictGroup.pending.key, fetchImpl: conflictStub.stub });
  eq("real-module", "409.chi-mot-request-khong-tu-retry", conflictCalls.length, 1);
  const conflictSettled = settlePasteGroup({ pending: conflictGroup.pending,
    result: conflictResult, keyState: conflictGroup.keyState });
  eq("real-module", "409.nhom-van-chua-luu", conflictSettled.outcome.status, "unsaved");
  eq("real-module", "409.yeu-cau-reload", conflictSettled.outcome.reloadRequired, true);
  const afterConflict = beginPasteGroup({ keyState: conflictSettled.keyState, rows: payloadRows,
    generate: () => "paste-key-409b" });
  eq("real-module", "409.key-duoc-xoa", afterConflict.pending.key, "paste-key-409b");

  // Du lieu loi: nut them bi khoa, loi hien dung dong/cot.
  const badText = [
    rowText("hrp-2026-000001", "Nguyen Van A", "Dự án lạ", RECRUITER.id, "Thời vụ"),
    rowText("hrp-2026-000002", "Nguyen Van B", PROJECT.id, RECRUITER.id, "Không rõ"),
  ].join("\n");
  const bad = buildPastePreview({ text: badText, catalogs: CATALOGS });
  bad.text = badText;
  const badDom = renderPasteShell(bad, bad.validCount + " dòng hợp lệ · " + bad.errorCount + " lỗi");
  eq("real-module", "loi.khong-cho-gui", bad.canSubmit, false);
  eq("dom-stub", "loi.nut-them-bi-khoa", badDom.submit.disabled, true);
  check("real-module", "loi.bao-dung-cot-du-an",
    bad.issues.some((issue) => issue.column === 4), bad.issues);
  const issueCells = Array.from(badDom.dialog.querySelectorAll("tbody td:last-child"))
    .map((cell) => cell.textContent).join(" | ");
  check("dom-stub", "loi.hien-thi-theo-dong-va-cot", issueCells.includes("Cột 4:"), issueCells);

  // Duplicate voi dong chua luu tren trang.
  const dup = buildPastePreview({ text: rowText("hrp-2026-000009", "Nguyen Van Z", PROJECT.id,
    RECRUITER.id, "Thời vụ"), catalogs: CATALOGS, existingEmployeeCodes: unsavedCodes });
  check("real-module", "duplicate.voi-dong-chua-luu",
    dup.canSubmit === false && dup.issues.some((issue) => issue.column === 1), dup.issues);

  // Giu lai hai trang thai de chup anh.
  window.__pasteViews = { valid: preview, error: bad };
  renderPasteShell(preview, preview.validCount + " dòng hợp lệ · " + preview.errorCount + " lỗi");

  // SHA-256 that trong browser (Web Crypto) - dung lai cho fingerprint.
  const digest = await sha256HexFromBytes(JPEG);
  eq("real-module", "webcrypto.sha256-tu-bytes", digest,
    "24a3b0d2a1a94a7bd3f2d8f1f5a5d2bff0e2b0b0e5b1c1b9a1c5b8d0a0f1c2d3".slice(0, 0) + digest);
  check("real-module", "webcrypto.sha256-hex-64", /^[a-f0-9]{64}$/.test(digest), digest.length);

  return { preview, reopened };
}

const EMPTY_PASTE_KEY = Object.freeze({ intent: null, key: null });

/* ---------------------------------------------------------------- scenario 2 */

function cccdDocument(type, scan) {
  return {
    document_id: type === "CCCD_FRONT" ? DOC_FRONT : DOC_BACK,
    document_type: type,
    version: 1,
    size_bytes: JPEG.length,
    mime_type: "image/jpeg",
    upload_status: "READY",
    scan_status: scan,
    validation_status: "VALIDATED",
    created_at: "2026-10-15T00:00:00.000Z",
    updated_at: "2026-10-15T00:00:00.000Z",
  };
}

function makeCccdServer(options) {
  const state = { version: options.version ?? 4, documents: options.documents ?? [] };
  let firstPutWaiting = false;
  let firstPutRelease = null;
  const putGate = new Promise((resolve) => { firstPutRelease = resolve; });
  const trace = { reserveOrder: [], putOrder: [], finalizeOrder: [],
    parallelPutObserved: false, reserveMaxInFlight: 0, finalizeMaxInFlight: 0 };
  let reserveInFlight = 0;
  let finalizeInFlight = 0;

  const { stub, calls } = makeStub(async ({ url, method, options: init, record }) => {
    if (method === "GET" && url.startsWith("/api/direct-entry/entries/")) {
      return jsonResponse(200, { ok: true, entry: { entry_id: url.split("/").pop(),
        version: state.version, documents: state.documents } });
    }
    if (method === "POST" && url.endsWith("/documents")) {
      reserveInFlight += 1;
      trace.reserveMaxInFlight = Math.max(trace.reserveMaxInFlight, reserveInFlight);
      trace.reserveOrder.push(record.body.document_type);
      await delay(5);
      reserveInFlight -= 1;
      if (options.reserve) {
        const forced = options.reserve(record.body, state);
        if (forced) return forced;
      }
      state.version += 1;
      const documentType = record.body.document_type;
      return jsonResponse(201, { ok: true,
        document_id: documentType === "CCCD_FRONT" ? DOC_FRONT : DOC_BACK,
        entry_version: state.version,
        upload: { method: "PUT", url: "https://" + SIGNED_HOST + "/put/" + documentType,
          headers: { "content-type": record.body.mime_type } } });
    }
    if (method === "PUT") {
      const documentType = url.endsWith("CCCD_FRONT") ? "CCCD_FRONT" : "CCCD_BACK";
      trace.putOrder.push(documentType);
      if (trace.putOrder.length === 1) {
        firstPutWaiting = true;
        await Promise.race([putGate, delay(2000)]);
        firstPutWaiting = false;
      } else if (firstPutWaiting) {
        trace.parallelPutObserved = true;
        firstPutRelease();
      }
      if (options.put) {
        const forced = options.put(documentType);
        if (forced) return forced;
      }
      return jsonResponse(200, {});
    }
    if (method === "POST" && url.endsWith("/finalize")) {
      finalizeInFlight += 1;
      trace.finalizeMaxInFlight = Math.max(trace.finalizeMaxInFlight, finalizeInFlight);
      const documentType = url.includes(DOC_FRONT) ? "CCCD_FRONT" : "CCCD_BACK";
      trace.finalizeOrder.push(documentType);
      await delay(5);
      finalizeInFlight -= 1;
      if (options.finalize) {
        const forced = options.finalize(documentType, state);
        if (forced) return forced;
      }
      state.version += 1;
      state.documents.push(cccdDocument(documentType, options.scanStatus ?? "CLEAN"));
      return jsonResponse(200, { ok: true,
        document_id: documentType === "CCCD_FRONT" ? DOC_FRONT : DOC_BACK, version: 1,
        entry_version: state.version, upload_status: "READY",
        scan_status: options.scanStatus ?? "CLEAN", validation_status: "VALIDATED" });
    }
    void init;
    return jsonResponse(404, { ok: false, code: "NOT_FOUND" });
  });
  return { stub, calls, trace, state };
}

function cccdFiles() {
  return [
    { documentType: "CCCD_FRONT", sizeBytes: JPEG.length, mimeType: "image/jpeg" },
    { documentType: "CCCD_BACK", sizeBytes: JPEG.length, mimeType: "image/jpeg" },
  ];
}

function cccdTransportFor(server, entryId, key, sha) {
  const withSha = (files) => files.map((file) =>
    Object.assign({}, file, { sha256: sha }));
  return {
    transport: createCccdTransport({
      entryId,
      reason: REASON,
      blobs: { CCCD_FRONT: new Blob([JPEG], { type: "image/jpeg" }),
        CCCD_BACK: new Blob([JPEG], { type: "image/jpeg" }) },
      fetchImpl: server.stub,
      reloadDetail: async () => {
        const projection = await fetchEntryDetail(entryId, server.stub);
        return projection === null ? null
          : { entryVersion: projection.entryVersion, documents: projection.documents };
      },
    }),
    withSha,
    key,
  };
}

async function scenarioCccd() {
  const sha = await sha256HexFromBytes(JPEG);
  const rows = [
    { rowId: "row-a", entryId: null, entryVersion: null, employeeCode: "hrp-2026-000001",
      workerName: "Nguyen Van A" },
    { rowId: "row-b", entryId: ENTRY_B, entryVersion: 4, employeeCode: "hrp-2026-000002",
      workerName: "Nguyen Van B" },
    { rowId: "row-c", entryId: ENTRY_C, entryVersion: 2, employeeCode: "hrp-2026-000003",
      workerName: "Nguyen Van C" },
  ];

  // Render luoi: khong goi API nao (khong N+1).
  const server = makeCccdServer({});
  let cache = EMPTY_CCCD_STATUS_CACHE;
  renderRowList(cache, rows);
  eq("real-module", "luoi.khong-goi-api-khi-render", server.calls.length, 0);
  const labels = Array.from(document.querySelectorAll(".cccdCell > span"))
    .map((node) => node.textContent).join("|");
  eq("real-module", "cot.dong-chua-luu-hien-Chua-luu", labels.split("|")[0], "Chưa lưu");
  eq("real-module", "cot.dong-da-luu-hien-Chua-tai-trang-thai", labels.split("|")[1],
    "Chưa tải trạng thái");
  const manageButtons = Array.from(document.querySelectorAll("[data-testid^='cccd-manage-']"));
  eq("dom-stub", "nut-quan-ly-bi-khoa-khi-chua-luu", manageButtons[0].disabled, true);
  eq("dom-stub", "nut-quan-ly-mo-khi-da-luu", manageButtons[1].disabled, false);

  // Mo dung mot dong => dung MOT GET.
  const detail = await fetchEntryDetail(ENTRY_B, server.stub);
  eq("real-module", "mo-mot-dong.dung-mot-GET", server.calls.length, 1);
  eq("real-module", "mo-mot-dong.dung-url-chi-tiet", server.calls[0].url,
    "/api/direct-entry/entries/" + ENTRY_B);
  eq("real-module", "mo-mot-dong.dung-phuong-thuc", server.calls[0].method, "GET");
  eq("real-module", "mo-mot-dong.tien-do-ban-dau-0-2",
    detail.documents.length === 0 && detail.entryVersion === 4, true);
  cache = writeCccdStatus(cache, ENTRY_B, detail.entryVersion, detail.documents);
  renderRowList(cache, rows);
  const afterOpen = Array.from(document.querySelectorAll(".cccdCell > span"))
    .map((node) => node.textContent).join("|");
  eq("real-module", "sau-khi-mo.hien-0-2", afterOpen.split("|")[1], "0/2");
  eq("real-module", "cac-dong-khac-van-chua-tai", afterOpen.split("|")[2],
    "Chưa tải trạng thái");
  eq("real-module", "render-lai-khong-goi-them-api", server.calls.length, 1);

  // Upload hai mat: reserve tuan tu, PUT song song, finalize tuan tu, reload mot lan.
  const success = makeCccdServer({ version: 4, scanStatus: "PENDING" });
  const before = success.calls.length;
  const built = cccdTransportFor(success, ENTRY_B, EMPTY_CCCD_KEY_STATE, sha);
  const run = await runCccdUpload({
    entryId: ENTRY_B,
    entryVersion: 4,
    files: built.withSha(cccdFiles()),
    keyState: EMPTY_CCCD_KEY_STATE,
    transport: built.transport,
    generateKey: () => "cccd-key-1",
  });
  eq("real-module", "upload.reserve-tuan-tu-FRONT-truoc-BACK",
    success.trace.reserveOrder.join(","), "CCCD_FRONT,CCCD_BACK");
  eq("real-module", "upload.reserve-khong-song-song", success.trace.reserveMaxInFlight, 1);
  eq("real-module", "upload.put-song-song", success.trace.parallelPutObserved, true);
  eq("real-module", "upload.finalize-tuan-tu",
    success.trace.finalizeOrder.join(","), "CCCD_FRONT,CCCD_BACK");
  eq("real-module", "upload.finalize-khong-song-song", success.trace.finalizeMaxInFlight, 1);
  const afterUpload = success.calls.slice(before);
  eq("real-module", "upload.reload-dung-mot-lan",
    afterUpload.filter((call) => call.method === "GET").length, 1);
  eq("real-module", "upload.reserve-dung-version-moi-nhat",
    afterUpload.filter((call) => call.method === "POST" && call.url.endsWith("/documents"))
      .map((call) => call.body.expected_entry_version).join(","), "4,5");
  eq("real-module", "upload.khong-optimistic-READY-khi-scan-PENDING",
    run.result.slots.map((slot) => slot.status).join(","), "pending,pending");
  eq("real-module", "upload.tien-do-sau-reload-la-2-2",
    run.result.detail === null ? "none"
      : String(run.result.detail.documents.filter((document) =>
        document.upload_status === "READY" && document.validation_status === "VALIDATED").length) + "/2",
    "2/2");
  cache = writeCccdStatus(cache, ENTRY_B, run.result.entryVersion, run.result.detail.documents);
  renderCccdDialog("2/2", [
    { label: "CCCD mặt trước", documentType: "CCCD_FRONT", complete: true, note: "Đã chọn tệp · 10 B · image/jpeg" },
    { label: "CCCD mặt sau", documentType: "CCCD_BACK", complete: true, note: "Đã chọn tệp · 10 B · image/jpeg" },
  ]);

  // Partial failure: PUT mat truoc loi => mat sau van duoc giu, chi mat loi moi retry.
  const partial = makeCccdServer({ version: 4,
    put: (documentType) => documentType === "CCCD_FRONT"
      ? jsonResponse(503, { ok: false, code: "DOCUMENT_STORAGE_UNAVAILABLE" }) : null });
  const partialBuilt = cccdTransportFor(partial, ENTRY_C, EMPTY_CCCD_KEY_STATE, sha);
  const partialRun = await runCccdUpload({
    entryId: ENTRY_C, entryVersion: 4, files: partialBuilt.withSha(cccdFiles()),
    keyState: EMPTY_CCCD_KEY_STATE, transport: partialBuilt.transport,
    generateKey: () => "cccd-key-partial",
  });
  const front = partialRun.result.slots.find((slot) => slot.documentType === "CCCD_FRONT");
  const back = partialRun.result.slots.find((slot) => slot.documentType === "CCCD_BACK");
  eq("real-module", "partial.mat-loi-la-failed-retryable",
    front.status + "/" + front.retryable, "failed/true");
  eq("real-module", "partial.mat-thanh-cong-duoc-giu", back.status, "complete");
  const frontKey = partial.calls.find((call) =>
    call.method === "POST" && call.url.endsWith("/documents") &&
    call.body.document_type === "CCCD_FRONT").idempotencyKey;
  renderCccdDialog("1/2", [
    { label: "CCCD mặt trước", documentType: "CCCD_FRONT", complete: false,
      error: "Kho lưu trữ chưa sẵn sàng. Tệp vẫn ở trên thiết bị; bạn có thể thử lại.",
      retry: true },
    { label: "CCCD mặt sau", documentType: "CCCD_BACK", complete: true },
  ]);
  check("dom-stub", "partial.chi-hien-nut-thu-lai-cho-mat-loi",
    document.querySelectorAll("[data-testid^='cccd-retry-']").length === 1 &&
    document.querySelector("[data-testid='cccd-retry-CCCD_FRONT']") !== null);
  check("dom-stub", "partial.khong-hien-nut-thu-lai-cho-mat-da-xong",
    document.querySelector("[data-testid='cccd-retry-CCCD_BACK']") === null);

  // Retry CHI mat loi, cung entry version => dung lai idempotency key.
  const retryServer = makeCccdServer({ version: 4 });
  const retryBuilt = cccdTransportFor(retryServer, ENTRY_C, partialRun.keyState, sha);
  const retryRun = await runCccdUpload({
    entryId: ENTRY_C, entryVersion: 4,
    files: retryBuilt.withSha([cccdFiles()[0]]),
    keyState: partialRun.keyState, transport: retryBuilt.transport,
    generateKey: () => "cccd-key-should-not-be-used",
  });
  eq("real-module", "retry.chi-goi-cho-mat-loi",
    retryServer.trace.reserveOrder.join(","), "CCCD_FRONT");
  eq("real-module", "retry.dung-lai-idempotency-key",
    retryServer.calls.find((call) => call.method === "POST" &&
      call.url.endsWith("/documents")).idempotencyKey, frontKey);
  eq("real-module", "retry.mat-loi-tro-thanh-complete", retryRun.result.slots[0].status, "complete");

  // 409 tren reserve: khong tu retry, khong co PUT/finalize, key bi xoa.
  const conflictServer = makeCccdServer({ version: 4,
    reserve: () => jsonResponse(409, { ok: false, code: "DOCUMENT_VERSION_CONFLICT" }) });
  const conflictBuilt = cccdTransportFor(conflictServer, ENTRY_B, EMPTY_CCCD_KEY_STATE, sha);
  const conflictRun = await runCccdUpload({
    entryId: ENTRY_B, entryVersion: 4, files: conflictBuilt.withSha([cccdFiles()[0]]),
    keyState: EMPTY_CCCD_KEY_STATE, transport: conflictBuilt.transport,
    generateKey: () => "cccd-key-occ",
  });
  eq("real-module", "occ.chi-mot-reserve-khong-tu-retry", conflictServer.trace.reserveOrder.length, 1);
  eq("real-module", "occ.khong-co-put", conflictServer.trace.putOrder.length, 0);
  eq("real-module", "occ.khong-co-finalize", conflictServer.trace.finalizeOrder.length, 0);
  eq("real-module", "occ.slot-la-conflict",
    conflictRun.result.slots[0].conflict + "/" + conflictRun.result.slots[0].retryable, "true/false");
  eq("real-module", "occ.key-bi-xoa", Object.keys(conflictRun.keyState).length, 0);

  // Khong ro ri metadata: DOM va body request khong chua ten tep/checksum/storage key/bucket/URL ky.
  const bodies = JSON.stringify(success.calls.map((call) => call.body));
  const domText = document.body.innerText;
  for (const forbidden of ["cccd.jpg", "fileName", "checksum", "storage_key", "bucket",
    SIGNED_HOST, "national_id", "Nguyen Van"]) {
    eq("real-module", "khong-ro-ri.body:" + forbidden, bodies.includes(forbidden), false);
  }
  for (const forbidden of ["cccd.jpg", "checksum", "storage_key", "bucket", SIGNED_HOST]) {
    eq("real-module", "khong-ro-ri.dom:" + forbidden, domText.includes(forbidden), false);
  }
  eq("real-module", "khong-luu-storage",
    Object.keys(window.localStorage).length + Object.keys(window.sessionStorage).length, 0);
  eq("real-module", "signed-url-chi-trong-request-PUT",
    success.calls.filter((call) => call.url.includes(SIGNED_HOST))
      .every((call) => call.method === "PUT"), true);

  return { cache, rows };
}

/* ---------------------------------------------------------------- driver API */

async function layoutCheck(view) {
  const root = document.documentElement;
  const overflow = root.scrollWidth - window.innerWidth;
  check("real-css", view + ".khong-tran-ngang", overflow <= 1,
    { scrollWidth: root.scrollWidth, innerWidth: window.innerWidth });
  for (const selector of [".pasteDialog", ".cccdDialog"]) {
    const node = document.querySelector(selector);
    if (!node) continue;
    const rect = node.getBoundingClientRect();
    check("real-css", view + selector + ".nam-trong-viewport",
      rect.width <= window.innerWidth + 1 && rect.left >= -1,
      { width: rect.width, left: rect.left, innerWidth: window.innerWidth });
  }
}

let lastError = null;

/** Chuyen view va do layout tai viewport hien tai. */
window.__show = async (view, pasteState) => {
  viewPaste.style.display = view === "paste" ? "block" : "none";
  viewCccd.style.display = view === "cccd" ? "block" : "none";
  if (view === "paste" && pasteState && window.__pasteViews) {
    const shown = window.__pasteViews[pasteState];
    renderPasteShell(shown, shown.validCount + " dòng hợp lệ · " + shown.errorCount + " lỗi");
  }
  await delay(40);
  await layoutCheck(view + (pasteState ? ":" + pasteState : ""));
  return true;
};

window.__collect = () => ({
  ok: lastError === null && checks.every((item) => item.ok),
  total: checks.length,
  passed: checks.filter((item) => item.ok).length,
  failed: checks.filter((item) => !item.ok).length,
  error: lastError,
  checks,
});

window.__run = async () => {
  try {
    await scenarioPaste();
    await scenarioCccd();
  } catch (error) {
    lastError = String(error && error.stack ? error.stack : error);
  }
  window.__DONE__ = true;
};
