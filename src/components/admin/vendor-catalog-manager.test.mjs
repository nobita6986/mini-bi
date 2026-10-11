import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./vendor-catalog-manager.tsx", import.meta.url), "utf8");
const page = readFileSync(new URL("../../app/admin/catalog/vendors/page.tsx", import.meta.url), "utf8");

test("vendor manager provides list loading, empty, denied, error and retry states", () => {
  for (const state of ['"loading"', '"loaded"', '"denied"', '"unavailable"', '"error"']) {
    assert.ok(source.includes(state), `missing state ${state}`);
  }
  assert.match(source, /Đang tải danh sách nhà cung cấp/);
  assert.match(source, /Chưa có nhà cung cấp phù hợp/);
  assert.match(source, /Không có quyền xem danh mục nhà cung cấp/);
  assert.match(source, /Thử tải lại/);
  assert.match(source, /whitespace-nowrap rounded-full/);
});

test("vendor manager wires list search/page/inactive filter and strict projection", () => {
  assert.match(source, /buildVendorListQuery/);
  assert.match(source, /projectVendorListForQuery/);
  assert.match(source, /Bao gồm nhà cung cấp ngừng hoạt động/);
  assert.match(source, /Trang trước/);
  assert.match(source, /Trang sau/);
  assert.match(source, /method: "GET",\s*cache: "no-store"/);
});

test("create, rename and active flows use exact API routes, reason, version and idempotency", () => {
  assert.match(source, /url: "\/api\/admin\/catalog\/vendors", method: "POST", operation: "create"/);
  assert.match(source, /method: "PATCH", operation: "update"/);
  assert.match(source, /\/active`[\s\S]{0,140}method: "POST", operation: "set-active"/);
  assert.match(source, /buildVendorCreateRequest/);
  assert.match(source, /buildVendorUpdateRequest/);
  assert.match(source, /buildVendorSetActiveRequest/);
  assert.match(source, /"Idempotency-Key": String\(intent\.body\.idempotency_key\)/);
  assert.match(source, /expectedVersion: dialog\.vendor\.version/);
  assert.match(source, /Lý do thay đổi/);
  assert.match(source, /Xác nhận kích hoạt/);
  assert.match(source, /Xác nhận ngừng/);
});

test("OCC and applied writes stay locked until strict authoritative reload succeeds", () => {
  assert.match(source, /outcome\.kind === "applied" \|\| outcome\.kind === "conflict"/);
  assert.match(source, /setConflictIntent\(intent\)/);
  assert.match(source, /await reloadAuthoritative\(intent\)/);
  assert.match(source, /projectVendorItem\(await response\.json\(\)\)/);
  assert.match(source, /vendorListConfirmsId\(list, vendorId\)/);
  assert.match(source, /setConflictIntent\(null\)[\s\S]{0,100}setConflictError\(null\)/);
  assert.match(source, /Thao tác vẫn đang bị khóa/);
});

test("UI consumes only safe display fields and never renders internal recruiter identifiers or authority", () => {
  assert.match(source, /vendor\.vendor_id/);
  assert.match(source, /vendor\.display_name/);
  assert.doesNotMatch(source, /recruiter_id|recruiterId|app_user_id|auth_subject|capability|role\s*:/);
  assert.match(page, /resolveActorForRequest\(\)/);
  assert.match(page, /decideVendorCatalogPageAccess/);
});
