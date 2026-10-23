import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import test from "node:test";

function source(relative) {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

const reviewer = source("./direct-entry-change-request-reviewer.tsx");
const helper = source("../../lib/direct-entry/change-request-reviewer.ts");
const projection = source("../../lib/direct-entry/change-request-read-projection.ts");
const readContract = source("../../lib/direct-entry/change-request-read-contract.ts");
const list = source("./direct-entry-change-request-list.tsx");
const live = source("./direct-entry-live.tsx");

const RAW_LOGGING = /console\.(?:log|error|warn|info)\(/;
const CLIENT_AUTHORITY = /(?:actor_id|auth_subject|app_user_id|capability|capabilities|scope|owner_user_id|created_by_user_id|can_decide|can_withdraw)\s*:/;
const TABLE_ACCESS = /\.from\s*\(/;

test("detail endpoint chi duoc goi khi nguoi dung mo review, khong tai truoc", () => {
  assert.match(reviewer, /useEffect\(\(\) => \{\s*\n\s*if \(!request\) return undefined;/);
  assert.match(reviewer, /"\/api\/direct-entry\/change-requests\/" \+ encodeURIComponent\(requestId\)/);
  assert.equal((reviewer.match(/fetch\(/g) ?? []).length, 3,
    "1 detail + 1 entry projection + 1 decision");
  assert.doesNotMatch(list + live.split("const withdrawChangeRequest")[0], /projectChangeRequestDetail/);
  assert.match(reviewer, /useState<"idle" \| "loading" \| "ready" \| "error">/);
});

test("detail duoc strict-project va map ngay sang view model an toan", () => {
  assert.match(reviewer, /projectChangeRequestDetail\(/);
  assert.match(reviewer, /projectionSlice\(detailBody, DETAIL_KEYS\)/);
  assert.match(reviewer, /projectProposerEntry\(slice\.entry\)/);
  assert.match(reviewer, /buildReviewerViewModel\(\{/);
  assert.match(reviewer, /contexts, bankLabel: bankLabelFromCatalog/);
  assert.match(reviewer, /Người đề xuất: /);
  assert.match(reviewer, /entry\.worker_name/);
  assert.match(reviewer, /entry\.project_name/);
  assert.match(helper, /worker_name: context\?\.workerDetails\?\.display_name \?\? null/);
  assert.match(reviewer, /projectEntrySensitiveContext\(slice\.entry\)/);
  assert.match(reviewer, /projectEntrySensitiveContext\(slice\.entry\)/);
  assert.match(reviewer, /context\?\.workerDetails\) names\.set/);
  assert.match(reviewer, /historyNames\.get\(item\.entry_id\)/);
  assert.match(reviewer, /optionalValueText\(optionalValue\)/);
  assert.match(reviewer, /genderUiLabel\(optionalValue\.value\)/);
  assert.doesNotMatch(reviewer, /String\(fieldValue \?\? "—"\)/);
  assert.match(reviewer, /const terminal = detail\.state !== "PENDING"/);
  assert.match(helper, /export function buildReviewerViewModel\(/);
  assert.match(helper, /item\.target_kind === "ENTRY_FIELD"/);
  assert.match(helper, /projectWorkerDetails\(workerValue\)/);
  assert.match(helper, /projectPaymentReadProposal\(item\.proposal\)/);
  assert.match(helper, /projectWorkStatusReadProposal\(item\.proposal\)/);
  assert.match(helper, /projectDocumentReadProposal\(item\.proposal\)/);
  assert.match(reviewer, /unsupportedReviewerViewModel\(requestId, "PROPOSAL"\)/);
});

test("de xuat khong ho tro hien taxonomy; chi cho tu choi khi server cap quyen", () => {
  assert.match(reviewer, /data-testid="reviewer-unsupported"/);
  // P2.5 hotfix: copy theo tung ly do fail-closed thay vi mot nhan chung mo ho.
  assert.match(reviewer, /data-reason=\{model\.reason\}/);
  assert.match(reviewer, /\{reviewerUnsupportedMessage\(model\.reason\)\}/);
  assert.match(helper, /UNSUPPORTED_REVIEW_MESSAGE =\s*\n\s*"Yêu cầu này cần phiên bản giao diện hoặc quyền xem khác\."/);
  assert.match(helper, /export function reviewerUnsupportedMessage/);
  assert.match(helper, /"ENTRY_DENIED"/);
  assert.match(helper, /"ENTRY_UNAVAILABLE"/);
  assert.match(reviewer, /const canDecide = loadState === "ready" && model\?\.kind === "reviewable";/);
  assert.match(reviewer, /const canReject = request\?\.state === "PENDING" && request\.can_decide === true/);
  assert.match(reviewer, /model\?\.kind === "unsupported" \|\|[\s\S]{0,100}loadState === "error"/);
  assert.match(reviewer, /\{canReject && !canDecide && model\?\.kind !== "stale"/);
  assert.match(reviewer, /Lý do từ chối/);
  assert.match(reviewer, /onCloseAutoFocus=\{/);
  assert.match(reviewer, /opener\.focus\(\)/);
  const decisionButtons = reviewer.slice(reviewer.indexOf("{(canDecide || canReject) && ("));
  assert.match(decisionButtons, /REVIEW_DECISION_LABELS\.reject/);
  assert.match(decisionButtons, /REVIEW_DECISION_LABELS\.approve/);
  assert.match(reviewer, /\{canDecide && <button/);
  assert.match(reviewer, /const expectedVersion = model && "version" in model \? model\.version : request\.version;/);
});

test("before/after chi qua projector strict, khong raw JSON va khong key cam", () => {
  // S03B4A: reviewer duoc phep doc worker_details/payment/employment_status NHUNG chi qua
  // projector strict trong change-request-read-projection; khong bao gio render raw JSON.
  // Key cam cua RESPONSE DOC khong duoc xuat hien o UI/projection. Rieng helper co mot cho dung
  // hop le: body quyet dinh gui len server (idempotency_key) — khong phai proposal tra ve.
  for (const forbidden of ["checksum_sha256", "idempotency_key", "storage_key", "bucket",
    "storage_url", "signed_url", "public_url", "localStorage", "sessionStorage"]) {
    assert.doesNotMatch(reviewer + projection, new RegExp(forbidden), forbidden);
  }
  for (const forbidden of ["checksum_sha256", "storage_key", "bucket", "signed_url"]) {
    assert.doesNotMatch(helper, new RegExp(forbidden), forbidden);
  }
  assert.doesNotMatch(reviewer + helper + projection, /localStorage|sessionStorage/);
  assert.doesNotMatch(reviewer, /dangerouslySetInnerHTML|JSON\.parse|<pre|<code/);
  assert.match(helper, /for \(const field of PROPOSER_FIELD_ORDER\)/);
  assert.match(projection, /export function projectWorkerDetails\(/);
  assert.match(projection, /export function projectPaymentReadProposal\(/);
  assert.match(projection, /export function projectWorkStatusReadProposal\(/);
  assert.match(projection, /export function projectDocumentReadProposal\(/);
  assert.match(projection, /export function projectEntrySensitiveContext\(/);
  assert.match(reviewer, /authoritativeDisplay \?\?/);
  assert.match(readContract, /labor_type_display/);
  assert.match(reviewer, /<table className=\{styles\.reviewerTable\}>/);
  assert.match(reviewer, /<th scope="row">\{row\.label\}<\/th>/);
  assert.match(reviewer, /catalogProjectLabel\(catalog, value\)/);
  assert.match(reviewer, /catalogRecruiterLabel\(catalog, value\)/);
  assert.doesNotMatch(reviewer, /LABOR_TYPE_LABELS|TEMPORARY|PERMANENT/);
});

test("decision request dung URL, body contract va header idempotency", () => {
  assert.match(reviewer, /"\/decision",/);
  assert.match(reviewer, /method: "POST"/);
  assert.match(reviewer, /"Idempotency-Key": resolved\.key/);
  assert.match(reviewer, /body: JSON\.stringify\(payload\)/);
  assert.match(reviewer, /buildDecisionRequest\(\{/);
  assert.match(helper, /projectChangeRequestDecision\(\{/);
  assert.match(reviewer, /projectChangeRequestStateResult\(/);
  assert.match(reviewer, /state: reviewDecisionState\(decision\)/);
  assert.match(reviewer, /onDecided\(message\);\s*onOpenChange\(false\);/);
  assert.doesNotMatch(reviewer + helper, CLIENT_AUTHORITY);
  assert.doesNotMatch(reviewer + helper, TABLE_ACCESS);
  assert.doesNotMatch(reviewer + helper, RAW_LOGGING);
});

test("R1.1: reviewer action reason is optional and a blank value reaches the nullable contract", () => {
  assert.match(reviewer, /Lý do quyết định \(không bắt buộc\)/);
  assert.match(reviewer, /Lý do từ chối \(không bắt buộc\)/);
  assert.match(reviewer, /reason: trimmed,/);
  assert.doesNotMatch(reviewer, /Lý do quyết định là bắt buộc/);
  assert.doesNotMatch(reviewer, /normalizeReason\(reason\) === null/);
  assert.match(helper, /reason: string \| null/);
});

test("idempotency theo intent, 409 khong retry, 5xx giu key", () => {
  assert.match(reviewer, /decisionIntentSignature\(requestId, decision, trimmed\)/);
  assert.match(reviewer, /resolveIntentKey\(intentKey\.current, intent, \(\) => crypto\.randomUUID\(\)\)/);
  const decideBody = reviewer.slice(reviewer.indexOf("const decide = useCallback"));
  const serverError = decideBody.indexOf("status >= 500");
  const conflict = decideBody.indexOf("status === 409");
  assert.equal(serverError > 0 && conflict > serverError, true);
  // 5xx: giu nguyen key de lan thu lai van idempotent, khong tu lap.
  const serverBlock = decideBody.slice(serverError, decideBody.indexOf("return;", serverError) + 7);
  assert.doesNotMatch(serverBlock, /clearIntentKey/);
  assert.doesNotMatch(serverBlock, /onConflict/);
  // Moi status terminal khac (ke ca 409/403) deu xoa key truoc khi bao loi.
  const cleared = decideBody.indexOf("clearIntentKey(resolved.state, intent)", serverError);
  assert.equal(cleared > serverError && cleared < conflict, true);
  const conflictBlock = decideBody.slice(conflict, decideBody.indexOf("} catch", conflict));
  assert.match(conflictBlock, /onConflict\(reviewerErrorMessage\(status\)\)/);
  assert.match(conflictBlock, /setReloadToken\(\(current\) => current \+ 1\)/);
  assert.match(conflictBlock, /status === 401 \|\| status === 403/);
  assert.match(decideBody, /catch \{\s*\n\s*notify\.error\(\{\s*\n\s*title: reviewerErrorMessage\(0\)/);
  assert.match(decideBody, /if \(!updated\) \{/);
  assert.doesNotMatch(decideBody, /retry|setTimeout|setInterval/);
  assert.match(reviewer, /disabled=\{busy !== null\}/);
  assert.match(reviewer, /aria-busy=\{busy === "approve"\}/);
  assert.match(list, /onReview\(request\)/);
  assert.match(list, /request\.state === "PENDING" && request\.can_decide === true/);
});

test("dialog dung Radix, co escape/focus mac dinh va khong co mock route trong repo", () => {
  assert.match(reviewer, /import \{ AlertDialog, Dialog \} from "radix-ui"/);
  assert.match(reviewer, /Dialog\.Root/);
  assert.match(reviewer, /Dialog\.Close/);
  assert.match(reviewer, /AlertDialog\.Action/);
  assert.match(reviewer, /AlertDialog\.Cancel/);
  assert.doesNotMatch(reviewer, /window\.confirm|createFocusTrap|focus-trap|aria-modal="true"/);
  assert.doesNotMatch(reviewer, /addEventListener\(\s*"key(down|up)"/);
  const routeRoot = new URL("../../app/api/direct-entry/", import.meta.url);
  const names = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory)) {
      const path = new URL(entry, directory);
      if (statSync(path).isDirectory()) {
        path.pathname += "/";
        walk(path);
      } else names.push(entry);
    }
  };
  walk(routeRoot);
  for (const name of names) {
    assert.doesNotMatch(name, /mock|fixture|synthetic|_test/i, name);
  }
});
