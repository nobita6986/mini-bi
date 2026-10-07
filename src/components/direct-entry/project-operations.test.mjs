/**
 * P2.5-W06A - Source/structure test cho Project Operations UI.
 * (tsx khong import duoc bang node:test => kiem tra o muc source + test logic thuan
 *  trong src/lib/direct-entry/project-operations-model.test.mjs)
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./project-operations.tsx", import.meta.url), "utf8");
const page = readFileSync(
  new URL("../../app/direct-entry/projects/page.tsx", import.meta.url), "utf8");
const model = readFileSync(
  new URL("../../lib/direct-entry/project-operations-model.ts", import.meta.url), "utf8");

test("la client component va KHONG import server-only", () => {
  assert.ok(source.includes('"use client"'), "phai la client component");
  assert.equal(source.includes("server-only"), false);
  assert.equal(/from\s+["']@\/lib\/ai\//.test(source), false);
});

test("tai su dung component/khung co san, khong tao framework moi", () => {
  assert.match(source, /AccessDenied/, "tai su dung AccessDenied");
  assert.match(source, /TemporaryUnavailable/, "tai su dung TemporaryUnavailable");
  assert.match(source, /from "radix-ui"/, "dung Radix Dialog co san");
  assert.equal(/from "react-data-grid"/.test(source), false, "khong keo them grid");
});

test("co du cac trang thai loading/empty/error/denied", () => {
  for (const state of ['"loading"', '"empty"', '"error"', '"denied"', '"unavailable"']) {
    assert.ok(source.includes(state), "thieu trang thai " + state);
  }
  assert.match(source, /Đang tải dữ liệu/);
  assert.match(source, /Chưa có dự án nào/);
  assert.match(source, /Không tải được danh sách dự án/);
});

test("ly do la bat buoc o moi dialog thay doi", () => {
  assert.match(source, /aria-required="true"/);
  assert.match(source, /<textarea[\s\S]{0,200}required/);
  assert.match(source, /Bắt buộc cho mọi thao tác thay đổi/);
  for (const kind of ["create", "rename", "set-active", "assign", "unassign"]) {
    assert.ok(source.includes('kind: "' + kind + '"'), "thieu dialog " + kind);
  }
});

test("gui dung version OCC (du an + phan cong)", () => {
  assert.match(source, /expectedVersion: detail\.project_version/);
  assert.match(source, /expectedProjectVersion: detail\.project_version/);
  assert.match(source, /expectedVersion: assignment\.version/);
});

test("xung dot OCC => bat buoc tai lai, KHONG ghi de ngam", () => {
  // 409 duoc map thanh reload-required: khong cap nhat state du an truc tiep.
  assert.match(source, /outcome\.kind === "reload-required"/);
  assert.match(source, /setConflict\(outcome\.message\)/);
  assert.match(source, /Tải lại dữ liệu/);
  // Sau moi thao tac thanh cong deu TAI LAI tu server, khong tu suy dien version.
  assert.match(source, /async function afterSuccess/);
  assert.match(source, /await loadList\(\)/);
  assert.match(source, /await loadDetail\(/);
});

test("client khong gui actor/capability/scope/role", () => {
  // Khong duoc xuat hien nhu MOT KEY trong bat ky object nao (comment khong tinh).
  for (const field of ["auth_subject", "app_user_id", "capability", "capabilities",
    "scope", "scopes", "role", "created_by"]) {
    assert.equal(new RegExp("\\b" + field + "\\s*:").test(source), false,
      "client khong duoc gui key " + field);
  }
  // Body gui len chi den tu builder da validate trong model.
  assert.match(source, /JSON\.stringify\(request\.body\)/);
  assert.match(source, /if \(!request\.ok\)/);
});

test("a11y + keyboard parity", () => {
  assert.match(source, /role="alert"/);
  assert.match(source, /aria-busy/);
  assert.match(source, /<Dialog\.Title/);
  assert.match(source, /<Dialog\.Description/);
  assert.match(source, /<caption/);
  assert.match(source, /scope="col"/);
  assert.match(source, /<label htmlFor/, "moi input co label that");
  assert.match(source, /onSubmit=\{/, "ho tro Enter de gui form");
  assert.match(source, /type="submit"/);
});

test("mobile parity: bang cuon ngang va layout responsive", () => {
  assert.match(source, /overflow-x-auto/);
  assert.match(source, /sm:flex-row/);
  assert.match(source, /min-w-\[/);
});

test("page boundary: gate flag truoc, cung quyet dinh truy cap nhu /direct-entry", () => {
  assert.match(page, /isDirectEntryUiEnabled\(process\.env\.DIRECT_ENTRY_UI_ENABLED\)/);
  assert.match(page, /decideDirectEntryPageAccess/);
  assert.match(page, /case "NOT_FOUND":[\s\S]{0,40}notFound\(\)/);
  assert.match(page, /redirect\("\/login\?next=\/direct-entry\/projects"\)/);
  assert.match(page, /case "ALLOW":[\s\S]{0,80}<ProjectOperations \/>/);
});

test("model la noi duy nhat build request va khong chua truong quyen", () => {
  for (const field of ["auth_subject", "app_user_id", "capability", "scope", "role",
    "created_by"]) {
    assert.equal(new RegExp("\\b" + field + "\\s*:").test(model), false,
      "model khong duoc dung key " + field);
  }
  assert.match(model, /export function buildCreateRequest/);
  assert.match(model, /export function buildSetActiveRequest/);
  assert.equal(/deactivate/i.test(model), false, "khong co duong tat deactivate rieng");
});
