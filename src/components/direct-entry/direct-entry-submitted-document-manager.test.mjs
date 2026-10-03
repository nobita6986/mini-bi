import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relative) {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

const editor = source("./direct-entry-document-editor.tsx");
const manager = source("./direct-entry-submitted-document-manager.tsx");
const list = source("./direct-entry-submission-list.tsx");
const live = source("./direct-entry-live.tsx");

test("S03B4B-R2C: reserve body gui reason khi bat buoc, khong luon gui", () => {
  assert.match(editor, /requireReason/);
  assert.match(editor, /\.\.\.\(requireReason && pending\.reason \? \{ reason: pending\.reason \} : \{\}\)/);
  assert.match(editor, /aria-label="Lý do thay thế tài liệu"/);
  assert.match(editor, /requireReason && \(trimmedReason === null || trimmedReason\.length < 1/);
  assert.doesNotMatch(editor, /encodeURIComponent\(reason\)/);
});

test("S03B4B-R2C: reason la mot phan cua idempotency intent", () => {
  assert.match(editor, /\(requireReason && pendingKey\.current\.reason !== trimmedReason\)/);
  assert.match(editor, /reason: trimmedReason \?\? ""/);
  assert.doesNotMatch(editor, /localStorage|sessionStorage/);
});

test("S03B4B-R2C: manager dung submission detail + entry projection, khong goi change-request", () => {
  assert.match(manager, /projectSubmissionDetail\(/);
  assert.match(manager, /projectProposerEntry\(slice\.entry\)/);
  assert.match(manager, /detail\.entry_ids/);
  assert.match(manager, /requireReason/);
  assert.match(manager, /canUpload/);
  assert.match(manager, /canView/);
  assert.doesNotMatch(manager, /change-requests|proposal|target_kind/);
  assert.doesNotMatch(manager + editor, /actor_id|auth_subject|capability\s*:|scope_kind/);
});

test("S03B4B-R2C: entry point tren card SUBMITTED, khong tren DRAFT/REVIEW", () => {
  assert.match(list, /Quản lý tài liệu/);
  assert.match(list, /onManageDocuments\(submission\)/);
  assert.match(list, /terminal && \(/);
  assert.match(live, /DirectEntrySubmittedDocumentManager/);
  assert.match(live, /onManageDocuments=\{/);
  assert.match(live, /canUpload=\{capabilities\.includes\(\"document_upload\"\)\}/);
  assert.match(live, /canView=\{capabilities\.includes\(\"document_view\"\)\}/);
});
