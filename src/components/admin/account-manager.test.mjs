import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./account-manager.tsx", import.meta.url), "utf8");
const model = readFileSync(new URL("../../lib/admin/account-access-model.ts", import.meta.url), "utf8");
const page = readFileSync(new URL("../../app/admin/access/accounts/page.tsx", import.meta.url), "utf8");
const nav = readFileSync(new URL("../../lib/admin/admin-navigation.ts", import.meta.url), "utf8");
const pageAccess = readFileSync(new URL("../../lib/auth/direct-entry-page-access.ts", import.meta.url), "utf8");
const packageJson = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));

test("account manager provides list loading, empty, denied, unavailable, error and retry states", () => {
  for (const state of ['"loading"', '"loaded"', '"denied"', '"unavailable"', '"error"']) {
    assert.ok(source.includes(state), `missing state ${state}`);
  }
  assert.match(source, /Đang tải danh sách tài khoản/);
  assert.match(source, /Chưa có tài khoản phù hợp/);
  assert.match(source, /Không có quyền xem danh sách tài khoản/);
  assert.match(source, /Dịch vụ tài khoản hiện không khả dụng/);
  assert.match(source, /Thử tải lại/);
  assert.match(source, /role="status"/);
  assert.match(source, /role="alert"/);
});

test("account manager wires search, enabled filter, pagination and strict projection", () => {
  assert.match(source, /buildAccountListQuery/);
  assert.match(source, /projectAccountListForQuery/);
  assert.match(source, /method: "GET",\s*cache: "no-store"/);
  assert.match(source, /<option value="all">Tất cả<\/option>/);
  assert.match(source, /<option value="true">Đang hoạt động<\/option>/);
  assert.match(source, /<option value="false">Ngừng hoạt động<\/option>/);
  assert.match(source, /Trang trước/);
  assert.match(source, /Trang sau/);
  assert.match(source, /Tìm kiếm theo tên hiển thị/);
});

test("enable/disable use exact API routes, mandatory reason, authoritative version and idempotency header", () => {
  assert.match(source, /\/api\/admin\/access\/accounts\/\$\{encodeURIComponent\(dialog\.account\.account_ref\)\}\/\$\{dialog\.nextEnabled \? "enable" : "disable"\}/);
  assert.match(source, /method: "POST",\s*operation: dialog\.nextEnabled \? "enable" : "disable"/);
  assert.match(source, /buildAccountStateRequest/);
  assert.match(source, /newAccountIntentKey\(\)/);
  assert.match(source, /"Idempotency-Key": String\(intent\.body\.idempotency_key\)/);
  assert.match(source, /expectedVersion: dialog\.account\.version/);
  assert.match(source, /Lý do thay đổi/);
  assert.match(source, /maxLength=\{4000\} required/);
  assert.match(source, /Xác nhận kích hoạt/);
  assert.match(source, /Xác nhận ngừng/);
  assert.match(source, /radix-ui\/dialog/);
  assert.match(source, /aria-describedby="account-dialog-description"/);
  assert.match(source, /aria-label="Đóng hộp thoại"/);
});

test("only display_name and status are rendered; account_ref and version stay internal", () => {
  assert.match(source, /<td className="px-3 py-3 font-medium">\{account\.display_name\}<\/td>/);
  assert.match(source, /<strong>\{dialog\.account\.display_name\}<\/strong>/);
  // No JSX text interpolation of the opaque ref or the OCC version.
  assert.doesNotMatch(source, /\{account\.version\}/);
  assert.doesNotMatch(source, /\{dialog\.account\.version\}/);
  assert.doesNotMatch(source, /<td[^>]*>\s*\{account\.account_ref\}/);
  assert.doesNotMatch(source, /\{dialog\.account\.account_ref\}/);
  // No version/label/raw-identity column or field anywhere in the surface.
  for (const file of [source, model]) {
    assert.doesNotMatch(file, /Phiên bản|auth_subject|revision|account_ref<\/th>|UUID<\/th/i);
    assert.doesNotMatch(file, /\.email|display_name \?\?|display_name \|\|/);
  }
  // Exactly three visible columns.
  assert.equal(source.match(/<th scope="col"/g)?.length, 3);
});

test("no optimistic success: applied/conflict lock the account until strict authoritative reload", () => {
  assert.match(source, /outcome\.kind === "applied" \|\| outcome\.kind === "conflict"/);
  assert.match(source, /setConflictIntent\(intent\)/);
  assert.match(source, /await reloadAuthoritative\(intent\)/);
  assert.match(source, /projectAccountItem\(await response\.json\(\)\)/);
  assert.match(source, /account\.account_ref !== intent\.accountRef/);
  assert.match(source, /setConflictIntent\(null\)[\s\S]{0,120}setPendingIntent\(null\)/);
  assert.match(source, /Thao tác vẫn đang bị khóa/);
  assert.match(source, /pendingIntent \|\| conflictIntent/);
  // The manager never reads a projected row out of the mutation outcome/response.
  assert.doesNotMatch(source, /outcome\.account|outcome\.list|payload\.account|payload\.list/);
  // A malformed reload (null projection or ref mismatch) keeps the lock via throw.
  assert.match(source, /if \(!account \|\| account\.account_ref !== intent\.accountRef\) \{\s*throw new Error/);
});

test("page gate resolves actor server-side and uses the Full-Admin-only account access decision", () => {
  assert.match(page, /resolveActorForRequest\(\)/);
  assert.match(page, /decideAccountAccessPageAccess/);
  assert.match(page, /redirect\("\/login\?next=\/admin\/access\/accounts"\)/);
  assert.doesNotMatch(page, /DIRECT_ENTRY_UI_ENABLED|useEffect|useRouter/);
  // The decision must use the canonical Full Admin triple, never the broader Admin-area predicate.
  assert.match(pageAccess, /decideAccountAccessPageAccess[\s\S]{0,220}adminSecurityNavPredicate/);
  assert.doesNotMatch(pageAccess, /decideAccountAccessPageAccess[\s\S]{0,220}decideAdminAreaAccess/);
});

test("Accounts navigation is visible only to the Full Admin triple, not the Admin-area predicate", () => {
  assert.match(nav, /id: "accounts", label: "Tài khoản", href: "\/admin\/access\/accounts", visible: adminSecurityNavPredicate/);
  assert.doesNotMatch(nav, /id: "accounts"[^}]*adminAreaNavPredicate/);
  assert.match(nav, /ADMIN_SECTIONS\.filter\(\(section\) => section\.visible\(actor\)\)/);
  // Catalog sections keep their existing Admin-area visibility.
  assert.match(nav, /id: "personnel"[^}]*adminAreaNavPredicate/);
});

test("the client surface never derives authority from actor, role, capability or email", () => {
  for (const file of [source, model]) {
    assert.doesNotMatch(file, /capabilities|resolveActor|useActor|\.scopes\b|actor\./i);
  }
});

test("canonical pnpm test invokes the W05-A lane exactly once", () => {
  assert.ok(packageJson.scripts["test:p3-1-w05-a-existing-account-ui"]);
  const occurrences = packageJson.scripts.test.match(/test:p3-1-w05-a-existing-account-ui/g) ?? [];
  assert.equal(occurrences.length, 1);
  for (const member of [
    /account-access-model\.test\.mjs/,
    /account-manager\.test\.mjs/,
    /admin-navigation\.test\.mjs/,
    /direct-entry-page-access\.test\.mjs/,
  ]) {
    assert.match(packageJson.scripts["test:p3-1-w05-a-existing-account-ui"], member);
  }
});
