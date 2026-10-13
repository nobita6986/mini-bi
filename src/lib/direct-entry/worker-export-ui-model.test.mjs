/**
 * PRE-W2-P1 (T1A) - Pure model cho "Xuat Excel" (recruited / managed).
 *
 * Pham vi: dung hai scope, map filter/reason theo contract, gate capability server-side,
 * taxonomy loi 400/401/403/404/422/5xx + loi mang, filename an toan. Khong lo PII/UUID/raw DB.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  WORKER_EXPORT_CAPABILITIES,
  WORKER_EXPORT_FALLBACK_LIMIT,
  WORKER_EXPORT_REASON_MAX,
  WORKER_EXPORT_SCOPES,
  buildWorkerExportRequest,
  canExportWorkers,
  exportScopeForTab,
  isExportableScope,
  isWorkerExportScope,
  workerExportErrorMessage,
  workerExportFilename,
  workerExportRequestMessage,
  workerExportRowLimit,
} from "./worker-export-ui-model.ts";

const EMPTY_FILTERS = { status: "", projectId: "", recruiterId: "" };

test("T1A: chi recruited|managed duoc xuat, dung allowlist body", () => {
  assert.deepEqual([...WORKER_EXPORT_SCOPES], ["recruited", "managed"]);
  assert.equal(isWorkerExportScope("recruited"), true);
  assert.equal(isWorkerExportScope("managed"), true);
  assert.equal(isWorkerExportScope("all"), false);
  assert.equal(isWorkerExportScope("uploader"), false);
  assert.equal(isWorkerExportScope(null), false);
  // Tab -> scope: uploader/all KHONG xuat.
  assert.equal(exportScopeForTab("recruited"), "recruited");
  assert.equal(exportScopeForTab("managed"), "managed");
  assert.equal(exportScopeForTab("all"), null);
  assert.equal(exportScopeForTab("uploader"), null);
  assert.equal(isExportableScope("managed"), true);
  assert.equal(isExportableScope("all"), false);
  assert.equal(isExportableScope(null), false);
});

test("T1A: recruited gui dung body, filter rong => null", () => {
  const built = buildWorkerExportRequest({
    scope: "recruited", filters: EMPTY_FILTERS, reason: "  Kiểm tra định kỳ  ",
  });
  assert.equal(built.ok, true);
  assert.deepEqual(built.body, {
    scope: "recruited",
    project_id: null,
    recruiter_id: null,
    employment_status: null,
    reason: "Kiểm tra định kỳ",
  });
  assert.deepEqual(Object.keys(built.body).sort(),
    ["employment_status", "project_id", "reason", "recruiter_id", "scope"]);
});

test("T1A: managed gui dung body voi bo loc hien tai", () => {
  const built = buildWorkerExportRequest({
    scope: "managed",
    filters: { status: "ON", projectId: "proj_a", recruiterId: "22222222-2222-4222-8222-222222222222" },
    reason: "Đối soát nhân sự dự án",
  });
  assert.equal(built.ok, true);
  assert.deepEqual(built.body, {
    scope: "managed",
    project_id: "proj_a",
    recruiter_id: "22222222-2222-4222-8222-222222222222",
    employment_status: "ON",
    reason: "Đối soát nhân sự dự án",
  });
});

test("T1A: scope all/invalid va reason sai bi tu choi fail-closed", () => {
  assert.deepEqual(buildWorkerExportRequest({ scope: "all", filters: EMPTY_FILTERS, reason: "x" }),
    { ok: false, code: "SCOPE_INVALID" });
  assert.deepEqual(buildWorkerExportRequest({ scope: "", filters: EMPTY_FILTERS, reason: "x" }),
    { ok: false, code: "SCOPE_INVALID" });
  assert.deepEqual(buildWorkerExportRequest({ scope: "recruited", filters: EMPTY_FILTERS, reason: "   " }),
    { ok: false, code: "REASON_REQUIRED" });
  assert.deepEqual(buildWorkerExportRequest({ scope: "recruited", filters: EMPTY_FILTERS, reason: "" }),
    { ok: false, code: "REASON_REQUIRED" });
  assert.deepEqual(buildWorkerExportRequest({
    scope: "recruited", filters: EMPTY_FILTERS, reason: "x".repeat(WORKER_EXPORT_REASON_MAX + 1),
  }), { ok: false, code: "REASON_TOO_LONG" });
  // Mot status la se bi am tham loai bo => xuat thua; phai tu choi.
  assert.deepEqual(buildWorkerExportRequest({
    scope: "recruited", filters: { status: "MAYBE", projectId: "", recruiterId: "" }, reason: "x",
  }), { ok: false, code: "FILTER_INVALID" });
});

test("T1A: request error copy sanitized", () => {
  for (const message of [
    workerExportRequestMessage("SCOPE_INVALID"),
    workerExportRequestMessage("REASON_REQUIRED"),
    workerExportRequestMessage("REASON_TOO_LONG"),
    workerExportRequestMessage("FILTER_INVALID"),
  ]) {
    assert.ok(message.length > 0);
    assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}/i.test(message), false, "khong lo UUID");
    assert.equal(/42501|P0002|SQLSTATE|postgres/i.test(message), false, "khong lo raw DB");
  }
  assert.ok(workerExportRequestMessage("REASON_TOO_LONG").includes(String(WORKER_EXPORT_REASON_MAX)));
});

test("T1A: nut xuat chi hien khi server cap du capability triple", () => {
  assert.deepEqual([...WORKER_EXPORT_CAPABILITIES], ["pii_export", "pii_view", "payment_view"]);
  const scopes = [{ kind: "own" }];
  assert.equal(canExportWorkers(null), false);
  assert.equal(canExportWorkers({ capabilities: [], scopes }), false);
  assert.equal(canExportWorkers({ capabilities: ["pii_export", "pii_view"], scopes }), false,
    "thieu payment_view => an nut");
  assert.equal(canExportWorkers({ capabilities: ["pii_export", "payment_view"], scopes }), false,
    "thieu pii_view => an nut");
  assert.equal(canExportWorkers({ capabilities: ["pii_view", "payment_view"], scopes }), false,
    "thieu pii_export => an nut");
  assert.equal(canExportWorkers({
    capabilities: ["pii_export", "pii_view", "payment_view"], scopes }), true);
  // Khong suy quyen tu role/scope kind.
  assert.equal(canExportWorkers({ capabilities: ["entry_admin"], scopes: [{ kind: "all" }] }), false);
});

test("T1A: 422 row-limit bao ro gioi han, khong tai file thieu dong", () => {
  assert.equal(workerExportRowLimit({ ok: false, code: "WORKER_EXPORT_ROW_LIMIT_EXCEEDED", limit: 10000 }),
    WORKER_EXPORT_FALLBACK_LIMIT);
  assert.equal(workerExportRowLimit({ limit: 250 }), 250);
  // limit sai kieu/khong hop le => fallback, khong bao gio NaN.
  assert.equal(workerExportRowLimit({ limit: "10000" }), WORKER_EXPORT_FALLBACK_LIMIT);
  assert.equal(workerExportRowLimit({ limit: 0 }), WORKER_EXPORT_FALLBACK_LIMIT);
  assert.equal(workerExportRowLimit(null), WORKER_EXPORT_FALLBACK_LIMIT);
  const message = workerExportErrorMessage(422,
    { ok: false, code: "WORKER_EXPORT_ROW_LIMIT_EXCEEDED", limit: 10000 });
  assert.match(message, /10000/);
  assert.match(message, /vượt giới hạn/i);
  assert.match(message, /thu hẹp bộ lọc/i);
});

test("T1A: taxonomy loi 400/401/403/404/5xx/mang, khong lo PII/raw DB", () => {
  const cases = [
    [401, null], [403, { ok: false, code: "WORKER_EXPORT_DENIED" }],
    [404, { ok: false, code: "NOT_FOUND" }],
    [400, { ok: false, code: "WORKER_EXPORT_REQUEST_INVALID" }],
    [503, { ok: false, code: "WORKER_EXPORT_UNAVAILABLE" }],
    [0, null], [500, null],
  ];
  for (const [status, payload] of cases) {
    const message = workerExportErrorMessage(status, payload);
    assert.ok(message.length > 0, "status " + status);
    assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}/i.test(message), false, "khong lo UUID: " + message);
    assert.equal(/42501|P0002|SQLSTATE|postgres/i.test(message), false, "khong lo raw DB: " + message);
    // Khong bao gio echo raw response body.
    assert.equal(/WORKER_EXPORT_DENIED|NOT_FOUND/.test(message), false, "khong lo raw code: " + message);
  }
});

test("T1A: filename uu tien server, fallback co dinh, chan path traversal", () => {
  assert.equal(
    workerExportFilename('attachment; filename="danh-sach-nguoi-lao-dong-2026-10-13.xlsx"', "2026-10-13"),
    "danh-sach-nguoi-lao-dong-2026-10-13.xlsx");
  // Thieu header / header la => fallback theo ngay.
  assert.equal(workerExportFilename(null, "2026-10-13"), "danh-sach-nguoi-lao-dong-2026-10-13.xlsx");
  assert.equal(workerExportFilename("attachment", "2026-10-13"), "danh-sach-nguoi-lao-dong-2026-10-13.xlsx");
  // Path traversal / ten sai duoi => fallback, khong bao gio tra basename ngoai.
  assert.equal(workerExportFilename('attachment; filename="../../etc/passwd"', "2026-10-13"),
    "danh-sach-nguoi-lao-dong-2026-10-13.xlsx");
  assert.equal(workerExportFilename('attachment; filename="evil.exe"', "2026-10-13"),
    "danh-sach-nguoi-lao-dong-2026-10-13.xlsx");
  // fallbackDate sai => dung ngay hom nay (khong lo gia tri la).
  assert.match(workerExportFilename(null, "not-a-date"), /^danh-sach-nguoi-lao-dong-[0-9]{4}-[0-9]{2}-[0-9]{2}\.xlsx$/);
});
