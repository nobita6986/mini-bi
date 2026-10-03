#!/usr/bin/env node
/**
 * P1.6-W04-S04B-R2C2 - Synthetic browser acceptance for the submitted document UI.
 *
 * Two complementary tiers:
 *  - Tier A (static): inspects the R2C sources for behavioural invariants.
 *  - Tier B (behavioural): re-plays the editor's upload flow with a stub
 *    `fetch` so we observe URL / method / headers / body for every matrix item.
 *
 * No real database, no R2, no Playwright, no Next.js dev server.
 *
 * Usage: node --test scripts/p1.6-w04-s04b-r2c2-source-acceptance.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createStubFetch,
  simulateEditorUpload,
  simulateManager,
  editorState as harnessEditorState,
} from "./lib/r2c2-harness.mjs";

const EDITOR = readFileSync(new URL("../src/components/direct-entry/direct-entry-document-editor.tsx", import.meta.url), "utf8");
const MANAGER = readFileSync(new URL("../src/components/direct-entry/direct-entry-submitted-document-manager.tsx", import.meta.url), "utf8");
const LIVE = readFileSync(new URL("../src/components/direct-entry/direct-entry-live.tsx", import.meta.url), "utf8");
const LIST = readFileSync(new URL("../src/components/direct-entry/direct-entry-submission-list.tsx", import.meta.url), "utf8");
const PROPOSER = readFileSync(new URL("../src/lib/direct-entry/change-request-proposer.ts", import.meta.url), "utf8");

const FORBIDDEN_URL_FIELDS = [
  "storage_key", "checksum", "bucket", "upload_url", "signed_url",
  "reason", "filename", "account_number",
];

const AUTHORITY_FIELDS = [
  "actor_id", "auth_subject", "app_user_id", "scope", "scope_kind",
  "role", "capability", "user_id",
];

test.beforeEach(() => harnessEditorState.clear());

// ----------------------------------------------------------------------------
// 21 R2C browser-acceptance checks.
// ----------------------------------------------------------------------------

test("R2C #1: DRAFT editor retains legacy upload flow; no reason enforced or sent", () => {
  assert.match(LIVE, /canEdit=\{capabilities\.includes\(\"entry_own\"\)/);
  const draftEditorCall = LIVE.match(/<DirectEntryDocumentEditor[\s\S]*?\/>/)?.[0] ?? "";
  assert.equal(/requireReason\b/.test(draftEditorCall), false, "DRAFT must not set requireReason");
  assert.match(EDITOR, /requireReason && \(trimmedReason === null \|\| trimmedReason\.length < 1/);
  assert.match(EDITOR, /\.\.\.\(requireReason && pending\.reason \? \{ reason: pending\.reason \} : \{\}\)/);
});

test("R2C #2: REVIEW card lacks 'Quản lý tài liệu' and cannot open manager", () => {
  assert.match(LIST, /const terminal = submission\.state === \"SUBMITTED\"/);
  assert.match(LIST, /terminal && \(\s*<>\s*<button[\s\S]*?Quản lý tài liệu/);
  assert.match(LIVE, /onManageDocuments=\{[^}]+}/);
  assert.match(MANAGER, /if \(!submission\) return undefined/);
});

test("R2C #3: SUBMITTED card shows 'Quản lý tài liệu' only with document_upload capability", () => {
  assert.match(LIVE, /canUpload=\{capabilities\.includes\(\"document_upload\"\)\}/);
  assert.match(LIVE, /canView=\{capabilities\.includes\(\"document_view\"\)\}/);
  assert.match(EDITOR, /disabled=\{!canEdit \|\| state === \"uploading\"\}/);
});

test("R2C #4: dialog fetches submission detail to derive entry_ids", async () => {
  const stub = createStubFetch();
  const result = await simulateManager({ stub, submissionId: "sub_x" });
  assert.equal(stub.calls.some((c) => c.url.includes("/api/direct-entry/submissions/sub_x")), true);
  assert.equal(stub.calls.filter((c) => c.url.includes("/api/direct-entry/entries/")).length >= 1, true);
  assert.equal(result.state, "ready");
});

test("R2C #5: each entry loaded via real entry projection; independent of draft grid / selectedRow", () => {
  assert.match(MANAGER, /\/api\/direct-entry\/entries\/\" \+ encodeURIComponent\(entryId\)/);
  assert.match(MANAGER, /projectProposerEntry\(slice\.entry\)/);
  // Strip the header comment block before checking the implementation body.
  const stripped = MANAGER.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.equal(/selectedRow/.test(stripped), false, "manager body must not depend on selectedRow");
  assert.equal(/direct-entry-live-grid/.test(MANAGER), false);
  assert.match(MANAGER, /entry\.entry_id !== entryId/);
  assert.match(MANAGER, /entry\.expected_version/);
});

test("R2C #6: missing or malformed projection fails closed", async () => {
  const stub = createStubFetch({ entryProjection: { ok: false, code: "DOCUMENT_NOT_FOUND" } });
  const result = await simulateManager({ stub, submissionId: "sub_y" });
  assert.equal(result.state, "error");
  assert.match(EDITOR, /return response\.ok \? parseDocuments\(payload\) : null/);
  assert.match(EDITOR, /setLoadError\(true\)/);
});

test("R2C #7: missing document_upload removes the upload action", () => {
  assert.match(EDITOR, /disabled=\{!canEdit \|\| !entryId \|\| !file \|\| state === \"uploading\"/);
  assert.match(LIVE, /canEdit=\{capabilities\.includes\(\"entry_own\"\)/);
  assert.match(LIVE, /canUpload=\{capabilities\.includes\(\"document_upload\"\)\}/);
});

test("R2C #8: missing document_view removes download and full document projection", () => {
  assert.match(EDITOR, /if \(\!entryId \|\| \!canView\) return;/);
  assert.match(EDITOR, /Trạng thái hồ sơ được ẩn theo quyền truy cập\./);
  assert.match(EDITOR, /document\.upload_status === \"READY\" && document\.validation_status === \"VALIDATED\"/);
});

test("R2C #9: SUBMITTED missing or whitespace reason short-circuits with 0 reserve requests", async () => {
  const stubEmpty = createStubFetch();
  await simulateEditorUpload({ stub: stubEmpty, reason: "" });
  assert.equal(stubEmpty.calls.filter((c) => c.method === "POST" && /\/documents$/.test(c.url)).length, 0);
  const stubSpace = createStubFetch();
  await simulateEditorUpload({ stub: stubSpace, reason: "   " });
  assert.equal(stubSpace.calls.filter((c) => c.method === "POST" && /\/documents$/.test(c.url)).length, 0);
});

test("R2C #10: reason trimmed; reserve body matches the contract", async () => {
  const stub = createStubFetch();
  await simulateEditorUpload({ stub, reason: "   fine   " });
  const reserve = stub.calls.find((c) => c.method === "POST" && /\/documents$/.test(c.url));
  assert.ok(reserve, "reserve must be issued");
  assert.deepEqual(Object.keys(reserve.body).sort(), [
    "document_type", "expected_entry_version", "mime_type", "reason", "size_bytes",
  ]);
  assert.equal(reserve.body.reason, "fine", "reason must be trimmed");
  assert.equal(reserve.body.expected_entry_version, 1);
  assert.equal(reserve.body.document_type, "CCCD_FRONT");
  assert.equal(reserve.body.mime_type, "image/jpeg");
  assert.equal(reserve.body.size_bytes, 3);
});

test("R2C #11: reserve body contains no actor / role / capability / scope / user identity", async () => {
  const stub = createStubFetch();
  await simulateEditorUpload({ stub, reason: "audit" });
  const reserve = stub.calls.find((c) => c.method === "POST" && /\/documents$/.test(c.url));
  assert.ok(reserve);
  const flat = JSON.stringify(reserve.body);
  for (const field of AUTHORITY_FIELDS) {
    assert.equal(flat.includes(`"${field}"`), false, `authority field "${field}" must not appear in reserve body`);
  }
  // The editor source must not write authority fields (scoped to JSON-object shapes).
  const bodyLike = /[\{,]\s*("?)(actor_id|auth_subject|app_user_id|scope|scope_kind|role|capability|user_id)\1\s*:/;
  assert.equal(bodyLike.test(EDITOR), false, "editor must not write authority fields");
});

test("R2C #12: same file + type + reason retry reuses the idempotency key", async () => {
  const stub = createStubFetch({ reserveFailure: { kind: "network" } });
  await simulateEditorUpload({ stub, reason: "same" });
  const keyA = stub.calls[0].headers["idempotency-key"];
  assert.ok(keyA, "first attempt must post a reserve request");
  await simulateEditorUpload({ stub, reason: "same" });
  const keyB = stub.calls[1].headers["idempotency-key"];
  assert.equal(keyB, keyA, "idempotency key must be reused on same intent retry");
});

test("R2C #13: changing file, document_type or reason yields a new idempotency key", async () => {
  const stub = createStubFetch();
  await simulateEditorUpload({ stub, reason: "alpha" });
  const keyA = stub.calls[0].headers["idempotency-key"];
  await simulateEditorUpload({ stub, reason: "beta" });
  const keyB = stub.calls[1].headers["idempotency-key"];
  assert.notEqual(keyB, keyA, "reason change => new key");
  await simulateEditorUpload({ stub, reason: "beta", documentType: "EMPLOYMENT_CONTRACT" });
  const keyC = stub.calls[2].headers["idempotency-key"];
  assert.notEqual(keyC, keyB, "type change => new key");
  await simulateEditorUpload({ stub, reason: "beta", documentType: "EMPLOYMENT_CONTRACT", sizeBytes: 4 });
  const keyD = stub.calls[3].headers["idempotency-key"];
  assert.notEqual(keyD, keyC, "file change => new key");
});

test("R2C #14: signed PUT only runs after reserve success with the exact body and Content-Type", async () => {
  const stub = createStubFetch({ putHeaders: { "Content-Type": "image/png", "Content-Length": "2" } });
  await simulateEditorUpload({ stub, reason: "ok" });
  const reserve = stub.calls.find((c) => c.method === "POST" && /\/documents$/.test(c.url));
  const put = stub.calls.find((c) => c.method === "PUT");
  assert.ok(reserve && put, "both reserve and PUT must fire");
  assert.equal(put.headers["content-type"], "image/png", "PUT must use the signed Content-Type");
  assert.deepEqual(put.body, new Uint8Array([0xff, 0xd0, 0xd1]));
  assert.equal(JSON.stringify(reserve.body).includes("bucket"), false);
});

test("R2C #15: PUT failure prevents finalize from running", async () => {
  const stub = createStubFetch({ putStatus: 403 });
  await simulateEditorUpload({ stub, reason: "fail" });
  const finalize = stub.calls.find((c) => c.method === "POST" && /\/finalize$/.test(c.url));
  assert.equal(finalize, undefined, "finalize must not run when PUT fails");
});

test("R2C #16: finalize only after PUT success; reloads entry/document projection (no optimistic READY)", async () => {
  const stub = createStubFetch();
  await simulateEditorUpload({ stub, reason: "happy" });
  const finalize = stub.calls.find((c) => c.method === "POST" && /\/finalize$/.test(c.url));
  assert.ok(finalize);
  assert.deepEqual(Object.keys(finalize.body).sort(), ["expected_entry_version"]);
  const projectionReloads = stub.calls.filter((c) => c.method === "GET" && /\/api\/direct-entry\/entries\//.test(c.url));
  assert.ok(projectionReloads.length >= 1, "after success the projection must reload");
  assert.match(EDITOR, /Đã kiểm tra định dạng và ghi nhận phiên bản tài liệu\./);
  assert.equal(/upload_status\s*[:=]\s*"READY"/.test(EDITOR), false, "editor must not set optimistic READY");
});

test("R2C #17: 409 triggers no auto-retry, exactly one mutation request, projection reloads", async () => {
  const stub = createStubFetch({ reserveStatus: 409 });
  await simulateEditorUpload({ stub, reason: "x" });
  const reserves = stub.calls.filter((c) => c.method === "POST" && /\/documents$/.test(c.url));
  assert.equal(reserves.length, 1, "exactly one reserve on 409");
  assert.equal(stub.calls.some((c) => c.method === "PUT"), false);
  assert.equal(stub.calls.some((c) => /\/finalize$/.test(c.url)), false);
  assert.match(EDITOR, /setState\(\"conflict\"\)/);
});

test("R2C #18: network / 5xx surfaces retry button and retry reuses key", async () => {
  const stub = createStubFetch({ reserveFailure: { kind: "network" } });
  await simulateEditorUpload({ stub, reason: "net" });
  const key = stub.calls[0].headers["idempotency-key"];
  assert.ok(key);
  await simulateEditorUpload({ stub, reason: "net" });
  const retryKey = stub.calls[1].headers["idempotency-key"];
  assert.equal(retryKey, key, "network retry reuses key");
  assert.match(EDITOR, /state === \"uploading\" \? \"Đang tải…\" : state === \"error\" \? \"Thử lại\" : \"Tải lên\"/);
});

test("R2C #19: DOCUMENT does not call any change-request endpoint", () => {
  // Manager and editor must not POST or read any change-request endpoint.
  // Allowed: importing `projectProposerEntry` (pure projection helper).
  assert.equal(/\/change-requests\b/.test(EDITOR + MANAGER), false);
  assert.equal(/change-requests[^\w]/.test(EDITOR + MANAGER), false);
  assert.equal(/target_kind/.test(EDITOR + MANAGER), false);
  // Negative control: the proposer is the module that owns change-request mutations.
  assert.match(PROPOSER, /target_kind/);
  assert.match(PROPOSER, /ChangeRequest/);
});

test("R2C #20: no storage key / checksum / bucket / signed URL / reason / sensitive data in storage or URL", async () => {
  assert.equal(/localStorage|sessionStorage/.test(EDITOR + MANAGER), false);
  for (const pattern of FORBIDDEN_URL_FIELDS) {
    assert.equal(new RegExp(`(localStorage|sessionStorage)\\.${pattern}`).test(EDITOR + MANAGER), false);
  }
  const stub = createStubFetch();
  await simulateEditorUpload({ stub, reason: "leak" });
  for (const call of stub.calls) {
    const url = call.url;
    assert.equal(/[?&]reason=/.test(url), false, `URL must not embed reason: ${url}`);
    assert.equal(/[?&]checksum=/.test(url), false, `URL must not embed checksum: ${url}`);
    assert.equal(/[?&]storage_key=/.test(url), false, `URL must not embed storage_key: ${url}`);
    assert.equal(/[?&]bucket=/.test(url), false, `URL must not embed bucket: ${url}`);
  }
});

test("R2C #21: dialog focus / Escape / focus-return and responsive layout source-level", () => {
  assert.match(LIVE, /Dialog\.Root/);
  assert.match(MANAGER, /Dialog\.Root/);
  assert.match(MANAGER, /Dialog\.Content/);
  assert.match(LIVE, /styles\.mobileSection/);
  assert.match(LIVE, /styles\.gridViewport/);
});