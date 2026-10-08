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
  assert.match(source, /<textarea[\s\S]*?required aria-required="true"/);
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

test("F3: multi-assign doc project_version tu response, KHONG dung assignment version", () => {
  // Khong duoc doc .version (assignment) lam OCC project cho buoc tiep theo.
  assert.match(source, /mutationProjectVersion\(payload\)/);
  assert.equal(/root\.project\.version/.test(source), false,
    "khong duoc dung payload.project.version cho OCC project");
});

test("F3: assign khong quang cao all-or-nothing; neu ro xu ly lan luot", () => {
  assert.match(source, /xử lý lần lượt/);
  assert.match(source, /tải lại để xem phần đã áp dụng/);
});

test("W06A-R2: manager selector tim/chon theo ten/ma, khong hien UUID tho", () => {
  // Combobox tim theo ten/ma; luu recruiter_id; khong render UUID tho.
  assert.match(source, /manager-candidates/);
  assert.match(source, /role="combobox"/);
  assert.match(source, /Tìm quản lý \(tên hoặc mã\)/);
  assert.match(source, /setManagerId\(candidate\.recruiter_id\)/);
  assert.match(source, /candidateLabel\(candidate\)/);
  assert.match(source, /managerLabel\(assignment\.manager_recruiter_id\)/);
  // Khong hien raw UUID trong list (font-mono + raw manager_recruiter_id da duoc bo).
  assert.equal(/font-mono[^}]*manager_recruiter_id/.test(source), false);
  assert.equal(/RecruiterTypeahead/.test(source), false);
  assert.equal(/input_catalog/.test(source), false);
});

test("W06A-R2: assignment tuong lai tach rieng va co thu hoi", () => {
  assert.match(source, /view\.future/);
  assert.match(source, /Sắp hiệu lực/);
  assert.match(source, /Sắp hiệu lực từ /);
  assert.match(source, /Đã thu hồi/);
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
  assert.match(source, /return executeProjectRequest\(url, method, request, key\)/);
  assert.match(model, /if \(!request\.ok\)/);
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
  assert.match(source, /aria-activedescendant/);
  assert.match(source, /role="listbox"/);
  assert.match(source, /event\.key === "ArrowDown"/);
  assert.match(source, /onOpenAutoFocus/);
  assert.match(source, /tabIndex=\{-1\}/);
});

test("mobile parity: bang cuon ngang va layout responsive", () => {
  assert.match(source, /overflow-x-auto/);
  assert.match(source, /sm:flex-row/);
  assert.match(source, /min-w-\[/);
});

test("hotfix UI: chi dung token theme that, modal co nen dac va dung z-index", () => {
  for (const invalid of ["bg-card", "border-input", "text-primary-foreground",
    "text-muted-foreground", "bg-background", "border-destructive", "bg-destructive"]) {
    assert.equal(source.includes(invalid), false, "token khong ton tai: " + invalid);
  }
  assert.match(source, /Dialog\.Overlay className="[^"]*z-40[^"]*bg-black/);
  assert.match(source, /Dialog\.Content[\s\S]{0,300}z-50[\s\S]{0,300}bg-surface/);
  assert.match(source, /safe-area-inset-top/);
  assert.match(source, /max-h-\[min\(90dvh,48rem\)\]/);
  assert.match(source, /sticky bottom-0/);
});

test("hotfix action: tai detail thanh cong roi moi mo rename/active", () => {
  assert.match(source, /const loaded = await loadDetail\(project\.project_id\)/);
  assert.match(source, /if \(!loaded\)[\s\S]{0,300}return/);
  assert.match(source, /action === "rename"[\s\S]{0,180}loaded\.display_name/);
  assert.match(source, /action === "set-active"[\s\S]{0,180}!loaded\.project_active/);
  assert.match(source, /detailState === "error"[\s\S]{0,500}Thử lại/);
  assert.match(source, /void loadCandidates\(""\)/,
    "candidate labels nap nen, khong chan nut Xem/Doi ten");
  assert.equal(/await loadCandidates\(""\)/.test(source), false,
    "khong duoc bat project action cho candidate endpoint");
});

test("hotfix mutation: loi mang khong lam nut bi ket va loi hien trong modal", () => {
  assert.match(model, /catch[\s\S]{0,250}Không kết nối được/);
  assert.match(source, /notice && dialog\.kind === "none"/);
  assert.match(source, /Dialog\.Content[\s\S]{0,1200}\{notice \? \(/);
  assert.match(source, /busy \? "Đang xử lý…" : submitLabel/);
  assert.match(source, /disabled=\{busy \|\| locked\}/);
  assert.match(source, /if \(conflict\) return \{ outcome: \{ kind: "reload-required"/);
});

test("hotfix feature coverage: xem, doi ten, active, gan, thu hoi va lich su deu co UI", () => {
  for (const label of ["Xem quản lý", "Đổi tên", "Ngừng", "Kích hoạt", "Gán quản lý",
    "Thu hồi phân công", "Đang phụ trách", "Sắp hiệu lực", "Lịch sử phân công"]) {
    assert.ok(source.includes(label), "thieu tinh nang UI: " + label);
  }
  assert.match(source, /filterProjects\(projects, projectSearch, statusFilter\)/);
  assert.match(source, /paginateProjects\(visibleProjects, projectPage\)/);
  assert.match(source, /aria-label="Phân trang danh sách dự án"/);
  assert.match(source, /type="date"/);
});

test("button to dialog wiring covers create, detail, rename, active, assign, and revoke", () => {
  assert.match(source, /onClick=\{\(\) => openDialog\(\{ kind: "create" \}\)\}/);
  assert.match(source, /openProjectAction\(project, "view"\)/);
  assert.match(source, /openProjectAction\(project, "rename"\)/);
  assert.match(source, /openProjectAction\(project, "set-active"\)/);
  assert.match(source, /onClick=\{\(\) => openDialog\(\{ kind: "assign" \}\)\}/);
  assert.match(source, /openDialog\(\{ kind: "unassign", assignment \}\)/);
  for (const action of ["submitCreate", "submitRename", "submitSetActive", "submitAssign", "submitUnassign"]) {
    assert.ok(source.includes(action), "missing dialog submit handler: " + action);
  }
  assert.match(source, /async function afterSuccess[\s\S]{0,180}await loadList\(\)/);
});

test("conflict stays locked until both authoritative reloads succeed", () => {
  assert.match(source, /const detailReloaded = detail \? \(await loadDetail\(detail\.project_id\)\) !== null : true/);
  assert.match(source, /const listReloaded = await loadList\(\)/);
  assert.match(source, /if \(detailReloaded && listReloaded\) setConflict\(null\)/);
  assert.match(source, /locked=\{conflict !== null\}/);
});

test("page boundary: gate flag truoc + dung project admin decision (F5)", () => {
  assert.match(page, /isDirectEntryUiEnabled\(process\.env\.DIRECT_ENTRY_UI_ENABLED\)/);
  assert.match(page, /decideProjectOperationsPageAccess/);
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
