import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./labor-type-catalog-manager.tsx", import.meta.url), "utf8");
const model = readFileSync(new URL("../../lib/admin/labor-type-catalog-model.ts", import.meta.url), "utf8");
const page = readFileSync(new URL("../../app/admin/catalog/labor-types/page.tsx", import.meta.url), "utf8");
const packageJson = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));

test("labor-type manager provides list loading, empty, denied, error and retry states", () => {
  for (const state of ['"loading"', '"loaded"', '"denied"', '"unavailable"', '"error"']) {
    assert.ok(source.includes(state), `missing state ${state}`);
  }
  assert.match(source, /Đang tải danh sách loại hình lao động/);
  assert.match(source, /Chưa có loại hình lao động phù hợp/);
  assert.match(source, /Không có quyền xem danh mục loại hình lao động/);
  assert.match(source, /Thử tải lại/);
  assert.match(source, /role="status"/);
  assert.match(source, /role="alert"/);
});

test("labor-type manager wires list search/page/inactive filter and strict projection", () => {
  assert.match(source, /buildLaborTypeListQuery/);
  assert.match(source, /projectLaborTypeListForQuery/);
  assert.match(source, /Bao gồm loại hình lao động ngừng hoạt động/);
  assert.match(source, /Trang trước/);
  assert.match(source, /Trang sau/);
  assert.match(source, /method: "GET",\s*cache: "no-store"/);
});

test("create, edit and active flows use exact API routes, reason, version and idempotency", () => {
  assert.match(source, /url: "\/api\/admin\/catalog\/labor-types", method: "POST", operation: "create"/);
  assert.match(source, /method: "PATCH", operation: "update"/);
  assert.match(source, /\/active`[\s\S]{0,140}method: "POST", operation: "set-active"/);
  assert.match(source, /buildLaborTypeCreateRequest/);
  assert.match(source, /buildLaborTypeUpdateRequest/);
  assert.match(source, /buildLaborTypeSetActiveRequest/);
  assert.match(source, /"Idempotency-Key": String\(intent\.body\.idempotency_key\)/);
  assert.match(source, /expectedVersion: dialog\.laborType\.version/);
  assert.match(source, /Lý do thay đổi/);
  assert.match(source, /Xác nhận kích hoạt/);
  assert.match(source, /Xác nhận ngừng/);
  // Dialog accessible: radix dialog with labelled title/description.
  assert.match(source, /radix-ui\/dialog/);
  assert.match(source, /aria-describedby="labor-type-dialog-description"/);
  assert.match(source, /aria-label="Đóng hộp thoại"/);
});

test("labor_type_key is immutable after create and version stays OCC-only, never rendered", () => {
  assert.match(source, /Mã không thể thay đổi sau khi tạo/);
  assert.match(source, /dialog\.laborType\.labor_type_key : "—"/);
  // Edit/active khong bao gio gui key: chi create co labor_type_key trong body.
  assert.doesNotMatch(model, /buildLaborTypeUpdateRequest[\s\S]{0,900}labor_type_key:/);
  assert.doesNotMatch(source, /Phiên bản|revision_count|revision_id|v\{laborType\.version\}/);
});

test("no static TEMPORARY/PERMANENT vocabulary, label map or raw-key fallback can reappear", () => {
  for (const file of [source, model]) {
    assert.doesNotMatch(file, /TEMPORARY|PERMANENT/);
    assert.doesNotMatch(file, /Không xác định/);
    assert.doesNotMatch(file, /display_name \?\?|display_name \|\|/);
  }
  // Ten hien thi va nhan trang thai chi den tu server projection.
  assert.match(source, /\{laborType\.display_name\}/);
  assert.match(source, /\{dialog\.laborType\.display_name\}<\/strong>/);
});

test("inactive rows stay visible with history preserved through the inactive filter", () => {
  assert.match(source, /include_inactive|includeInactive/);
  assert.match(source, /Ngừng hoạt động/);
  assert.match(source, /bg-slate-200[\s\S]{0,120}text-slate-900[\s\S]{0,120}dark:bg-slate-700[\s\S]{0,120}dark:text-slate-100/);
  assert.doesNotMatch(source, /bg-muted px-2\.5 py-1 text-xs font-medium text-muted/);
  assert.match(source, /Thao tác này không xóa dữ liệu hay lịch sử/);
  assert.doesNotMatch(source, /method: "DELETE"/);
});

test("OCC and applied writes stay locked until strict authoritative reload succeeds", () => {
  assert.match(source, /outcome\.kind === "applied" \|\| outcome\.kind === "conflict"/);
  assert.match(source, /setConflictIntent\(intent\)/);
  assert.match(source, /await reloadAuthoritative\(intent\)/);
  assert.match(source, /projectLaborTypeItem\(await response\.json\(\)\)/);
  assert.match(source, /laborTypeListConfirmsKey\(list, laborTypeKey\)/);
  assert.match(source, /setConflictIntent\(null\)[\s\S]{0,100}setConflictError\(null\)/);
  assert.match(source, /Thao tác vẫn đang bị khóa/);
  assert.match(source, /pendingIntent \|\| conflictIntent/);
  assert.match(source, /useNotify\(\)/);
  assert.doesNotMatch(source, /title="Trạng thái thao tác"/);
});

test("page gate resolves actor server-side and uses the explicit labor-type access decision", () => {
  assert.match(page, /resolveActorForRequest\(\)/);
  assert.match(page, /decideLaborTypeCatalogPageAccess/);
  assert.match(page, /redirect\("\/login\?next=\/admin\/catalog\/labor-types"\)/);
  assert.doesNotMatch(page, /DIRECT_ENTRY_UI_ENABLED|useEffect|useRouter/);
});

test("canonical pnpm test invokes the W04-D lane exactly once", () => {
  assert.ok(packageJson.scripts["test:p3-1-w04-d-labor-type-ui"]);
  const occurrences = packageJson.scripts.test.match(/test:p3-1-w04-d-labor-type-ui/g) ?? [];
  assert.equal(occurrences.length, 1);
  for (const member of [
    /labor-type-catalog-model\.test\.mjs/,
    /labor-type-catalog-manager\.test\.mjs/,
    /admin-navigation\.test\.mjs/,
    /admin-access\.test\.mjs/,
    /direct-entry-page-access\.test\.mjs/,
  ]) {
    assert.match(packageJson.scripts["test:p3-1-w04-d-labor-type-ui"], member);
  }
});
