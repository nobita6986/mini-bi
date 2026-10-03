import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import test from "node:test";

function source(relative) {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

const reviewer = source("./direct-entry-change-request-reviewer.tsx");
const helper = source("../../lib/direct-entry/change-request-reviewer.ts");
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
  assert.match(reviewer, /buildReviewerViewModel\(\{ detail, entries, format: formatField \}\)/);
  assert.match(helper, /export function buildReviewerViewModel\(/);
  assert.match(helper, /isSupportedEntryFieldProposal\(item\.proposal\)/);
  assert.match(helper, /item\.target_kind !== "ENTRY_FIELD"/);
  assert.match(reviewer, /unsupportedReviewerViewModel\(requestId, "PROPOSAL"\)/);
});

test("de xuat khong ho tro chi hien nhan chung va khong co hanh dong quyet dinh", () => {
  assert.match(reviewer, /data-testid="reviewer-unsupported"/);
  assert.match(reviewer, /\{UNSUPPORTED_REVIEW_MESSAGE\}/);
  assert.match(helper, /UNSUPPORTED_REVIEW_MESSAGE =\s*\n\s*"Yêu cầu này cần phiên bản giao diện hoặc quyền xem khác\."/);
  assert.match(reviewer, /const canDecide = loadState === "ready" && model\?\.kind === "reviewable";/);
  assert.match(reviewer, /onCloseAutoFocus=\{/);
  assert.match(reviewer, /opener\.focus\(\)/);
  const decisionButtons = reviewer.slice(reviewer.indexOf("{canDecide && ("));
  assert.match(decisionButtons, /REVIEW_DECISION_LABELS\.reject/);
  assert.match(decisionButtons, /REVIEW_DECISION_LABELS\.approve/);
  assert.doesNotMatch(reviewer.slice(0, reviewer.indexOf("{canDecide && (")), /REVIEW_DECISION_LABELS\.approve/);
});

test("before/after chi gom 5 field non-PII, khong raw JSON va khong PII", () => {
  for (const forbidden of ["worker_details", "account_number", "bank_id", "employment_status",
    "document_type", "checksum_sha256", "mime_type", "national_id", "date_of_birth",
    "payment", "documents"]) {
    assert.doesNotMatch(reviewer + helper, new RegExp(forbidden), forbidden);
  }
  assert.doesNotMatch(reviewer, /dangerouslySetInnerHTML|JSON\.parse|<pre|<code/);
  assert.match(helper, /for \(const field of PROPOSER_FIELD_ORDER\)/);
  assert.match(reviewer, /<table className=\{styles\.reviewerTable\}>/);
  assert.match(reviewer, /<th scope="row">\{row\.label\}<\/th>/);
  assert.match(reviewer, /catalogProjectLabel\(catalog, value\)/);
  assert.match(reviewer, /catalogRecruiterLabel\(catalog, value\)/);
  assert.match(reviewer, /LABOR_TYPE_LABELS\[value\]/);
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
  assert.doesNotMatch(reviewer + helper, CLIENT_AUTHORITY);
  assert.doesNotMatch(reviewer + helper, TABLE_ACCESS);
  assert.doesNotMatch(reviewer + helper, RAW_LOGGING);
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
  assert.match(decideBody, /catch \{\s*\n\s*setStatusMessage\(reviewerErrorMessage\(0\)\)/);
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
      const path = new URL(entry + (statSync(new URL(entry + "/", directory)).isDirectory() ? "/" : ""), directory);
      if (statSync(path).isDirectory()) walk(path);
      else names.push(entry);
    }
  };
  walk(routeRoot);
  for (const name of names) {
    assert.doesNotMatch(name, /mock|fixture|synthetic|_test/i, name);
  }
});
