import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relative) {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

const proposer = source("./direct-entry-change-request-proposer.tsx");
const list = source("./direct-entry-change-request-list.tsx");
const styles = source("./direct-entry-shell.module.css");
const submissionList = source("./direct-entry-submission-list.tsx");
const live = source("./direct-entry-live.tsx");
const workspace = source("./change-requests-workspace.tsx");
const helper = source("../../lib/direct-entry/change-request-proposer.ts");
const builder = source("../../lib/direct-entry/change-request-proposal-builders.ts");

const TABLE_ACCESS = /\.from\s*\(/;
const CLIENT_AUTHORITY = /(?:actor_id|auth_subject|app_user_id|capability|capabilities|scope|owner_user_id|created_by_user_id)\s*:/;
const RAW_LOGGING = /console\.(?:log|error|warn|info)\(/;

test("S03B1 list/proposer never fetch the change-request detail endpoint", () => {
  const changeRequestFetches = workspace.split("\n").filter((line) =>
    line.includes("/api/direct-entry/change-requests"));
  assert.equal(changeRequestFetches.length > 0, true);
  for (const line of changeRequestFetches) {
    const isList = line.includes("/api/direct-entry/change-requests");
    const isWithdraw = line.includes("/withdraw");
    assert.equal(isList || isWithdraw, true, line.trim());
  }
  assert.equal(live.includes("/api/direct-entry/change-requests"), false);
  // Detail endpoint chi duoc goi tu dialog reviewer (S03B2) khi nguoi dung mo "Xem xet";
  // danh sach va proposer khong duoc tai truoc chi tiet.
  assert.doesNotMatch(proposer + list, /change-requests\/" \+ encodeURIComponent\(/);
  assert.doesNotMatch(proposer + list, /projectChangeRequestDetail/);
  assert.doesNotMatch(proposer + list, /proposal\s*}/);
  assert.doesNotMatch(proposer + list, /dangerouslySetInnerHTML|JSON\.stringify\(.*proposal/);
  assert.doesNotMatch(list, /\.proposal|proposal\./);
});

test("proposer chi gui cac target kind duoc phep, ENTRY_FIELD giu dung 5 field non-PII", () => {
  // S03B4A va ENTRY_VOID: moi item van di qua validator cua create contract;
  // DOCUMENT khong duoc chon (chua co staging boundary).
  // validator cua create contract; DOCUMENT khong duoc chon (chua co staging boundary).
  assert.match(proposer, /const PROPOSER_KINDS: readonly ProposerTargetKind\[\] =\n  \["ENTRY_FIELD", "WORKER", "PAYMENT", "WORK_STATUS", "ENTRY_VOID"\]/);
  assert.match(proposer, /<option value="DOCUMENT" disabled>\{DOCUMENT_STAGING_MESSAGE\}<\/option>/);
  assert.match(proposer, /buildChangeRequestItem\(\{/);
  assert.match(proposer, /buildWorkerDetailsProposal\(/);
  assert.match(proposer, /buildPaymentProposal\(/);
  assert.match(proposer, /buildWorkStatusProposal\(/);
  // idempotency_key la field HOP LE cua body create (khong phai du lieu proposal tra ve).
  for (const forbidden of ["checksum_sha256", "storage_key", "bucket", "signed_url",
    "localStorage", "sessionStorage"]) {
    assert.doesNotMatch(proposer + builder, new RegExp(forbidden), forbidden);
  }
  assert.doesNotMatch(proposer, /dangerouslySetInnerHTML|JSON\.parse|<pre|<code/);
  assert.match(helper, /PROPOSER_FIELD_ORDER = \[/);
  const order = helper.slice(helper.indexOf("PROPOSER_FIELD_ORDER"),
    helper.indexOf("] as const", helper.indexOf("PROPOSER_FIELD_ORDER")));
  for (const field of ["employee_code", "first_work_date", "project_id", "recruiter_id", "labor_type"]) {
    assert.match(order, new RegExp(field), field);
  }
  assert.equal(order.includes("worker_details"), false);
});

test("create and withdraw requests carry exact URL, body and idempotency header", () => {
  assert.match(proposer, /fetch\("\/api\/direct-entry\/change-requests", \{/);
  assert.equal((proposer.match(/fetch\(/g) ?? []).length, 3,
    "1 fetch list/detail + 1 entry + 1 create trong proposer");
  assert.match(proposer, /method: "POST"/);
  assert.match(proposer, /"Idempotency-Key": resolved\.key/);
  assert.match(proposer, /body: JSON\.stringify\(validated\.value\)/);
  assert.match(proposer, /projectChangeRequestCreate\(body\)/);
  assert.match(proposer, /projectChangeRequestCreated\(/);
  assert.match(workspace, /\/withdraw",/);
  assert.match(workspace, /expected_version: request\.version,/);
  assert.match(workspace, /idempotency_key: resolved\.key,/);
  assert.match(workspace, /projectChangeRequestStateResult\(/);
  assert.match(workspace, /projectChangeRequestListPage\(/);
});

test("idempotency intent covers payload, 409 does not retry, 5xx keeps the key", () => {
  assert.match(proposer,
    /const signature = JSON\.stringify\(\{ items: itemsToSend, reason: normalized \}\)/);
  assert.match(proposer, /resolveIntentKey\(/);
  assert.match(proposer, /clearIntentKey\(resolved\.state, intent\)/);
  const submitBody = proposer.slice(proposer.indexOf("const submit = useCallback"));
  const conflict = submitBody.indexOf("status === 409");
  const serverError = submitBody.indexOf("status >= 500");
  assert.equal(conflict > 0 && serverError > conflict, true);
  const conflictBlock = submitBody.slice(conflict, serverError);
  assert.match(conflictBlock, /clearIntentKey/);
  assert.match(conflictBlock, /onConflict\(\)/);
  const serverBranchEnd = submitBody.indexOf("return;", serverError);
  const serverBlock = submitBody.slice(serverError, serverBranchEnd + "return;".length);
  assert.match(serverBlock, /notify\.error\(\{\s*\n\s*title: changeRequestErrorMessage\(status\)/);
  assert.doesNotMatch(serverBlock, /clearIntentKey/);
  assert.match(submitBody, /catch \{\s*\n\s*notify\.error\(\{\s*\n\s*title: changeRequestErrorMessage\(0\)/);
  assert.doesNotMatch(submitBody, /retry|setTimeout/);
});

test("withdraw action is gated by the server flag and never creates review buttons", () => {
  assert.match(list, /request\.summary/);
  assert.match(list, /request\.proposer_display_name/);
  assert.match(list, /className=\{styles\.changeRequestSummary\}/);
  assert.match(styles, /\.changeRequestSummary\s*\{[^}]*color:\s*var\(--primary\)/s);
  assert.match(list, /className=\{styles\.primaryButton\}[\s\S]{0,200}Xem xét/);
  assert.match(list, /canWithdrawChangeRequest\(request\) && \(/);
  assert.match(list, /Rút yêu cầu/);
  assert.doesNotMatch(list, /onApprove|onReject|onDecide|Duyệt yêu cầu|Từ chối yêu cầu/);
  assert.doesNotMatch(list, /method: "POST"/);
  // S03B2: can_decide chi mo CTA "Xem xet", khong bao gio mo nut rut.
  assert.match(list, /request\.state === "PENDING" && request\.can_decide === true/);
  assert.match(list, /onReview\(request\)/);
  assert.match(helper, /state === "PENDING" && item\.can_withdraw === true/);
});

test("dialogs use Radix without manual modal plumbing and no raw logging", () => {
  for (const file of [proposer, list]) {
    assert.match(file, /import \{ AlertDialog/);
    assert.doesNotMatch(file, /window\.confirm/);
    assert.doesNotMatch(file, /addEventListener\(\s*"key(down|up)"/);
    assert.doesNotMatch(file, RAW_LOGGING);
    assert.doesNotMatch(file, CLIENT_AUTHORITY);
    assert.doesNotMatch(file, TABLE_ACCESS);
  }
  assert.match(proposer, /Dialog\.Root/);
  assert.match(proposer, /AlertDialog\.Action/);
  assert.match(list, /AlertDialog\.Cancel/);
  assert.match(proposer, /<p role="alert">\{statusMessage\}<\/p>/);
  assert.doesNotMatch(proposer + list, /aria-modal="true"|createFocusTrap|focus-trap/);
});

test("S03A lifecycle and submission CTA stay wired while change-request action is hidden", () => {
  assert.match(live, /isRowEditable\(/);
  assert.match(live, /dropSubmissionRows\(/);
  assert.match(live, /mergeReloadedDrafts\(/);
  assert.match(live, /confirmBlockReason\(/);
  assert.doesNotMatch(live, /onRequestChange=/);
  assert.doesNotMatch(submissionList, /onRequestChange\(submission\)/);
  assert.match(submissionList, /actionsForSubmission\(submission\)/);
  assert.match(submissionList, /terminal && \(/);
  assert.doesNotMatch(submissionList, /sắp có/);
});
