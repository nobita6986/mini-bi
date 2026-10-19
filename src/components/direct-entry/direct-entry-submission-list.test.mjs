import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import * as lifecycle from "../../lib/direct-entry/submission-lifecycle.ts";

function source(relative) {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

const listComponent = source("./direct-entry-submission-list.tsx");
const liveComponent = source("./direct-entry-live.tsx");
const helper = source("../../lib/direct-entry/submission-lifecycle.ts");

const TABLE_ACCESS = /\.from\s*\(/;
const CLIENT_AUTHORITY = /(?:actor_id|auth_subject|app_user_id|capability|capabilities|scope|owner_user_id|created_by_user_id)\s*:/;
const RAW_LOGGING = /console\.(?:log|error|warn|info)\(/;

// Execute the actual component and click its rendered handlers; only hooks and visual wrappers are stubbed.
const compiledList = ts.transpileModule(listComponent, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const require = createRequire(import.meta.url);
const submission = {
  submission_id: "00000000-0000-4000-8000-000000000001", state: "DRAFT", version: 1,
  allowed_transitions: ["SUBMITTED"], entry_count: 1, updated_at: "2026-10-19T00:00:00Z",
};
const preflight = { submission_id: submission.submission_id, version: 3,
  fingerprint: "a".repeat(64), conflict_count: 1, conflicts: [] };

function findElement(node, predicate) {
  if (Array.isArray(node)) return node.map((item) => findElement(item, predicate)).find(Boolean);
  if (!node || typeof node !== "object") return undefined;
  if (predicate(node)) return node;
  return findElement(node.props?.children, predicate);
}

function renderList(overrides = {}) {
  const state = [];
  let cursor = 0;
  const reads = [], writes = [], deletes = [];
  const props = {
    state: "ready", submissions: [submission], hasMore: false, busySubmissionId: null,
    blockedSubmissionIds: new Set(), queueFilter: "ACTIVE",
    onPreflight: async (value) => { reads.push(value); return preflight; },
    onTransition: async (value) => { writes.push(value); return "applied"; },
    onDeleteDraft: async (value) => { deletes.push(value); },
    ...overrides,
  };
  const exports = {};
  runInNewContext(compiledList, { exports, require(name) {
    if (name === "react") return { useState(initial) {
      const slot = cursor++;
      if (!(slot in state)) state[slot] = initial;
      return [state[slot], (value) => { state[slot] = value; }];
    } };
    if (name === "react/jsx-runtime") return require(name);
    if (name === "radix-ui") return { AlertDialog: new Proxy({}, { get: (_, key) => "AlertDialog." + key }) };
    if (name.endsWith("submission-lifecycle")) return lifecycle;
    if (name.endsWith("direct-entry-compact-panel")) return { DirectEntryCompactPanel: "CompactPanel" };
    if (name.endsWith("direct-entry-queue-tabs")) return { DirectEntryQueueTabs: "QueueTabs" };
    if (name.endsWith("direct-entry-duplicate-cccd-dialog")) return { DirectEntryDuplicateCccdDialog: "DuplicateDialog" };
    if (name.endsWith(".module.css")) return { default: {} };
    throw new Error("Unexpected component dependency: " + name);
  } });
  function tree() { cursor = 0; return exports.DirectEntrySubmissionList(props); }
  function find(type) { return findElement(tree(), (node) => node.type === type); }
  function deleteButton() {
    return findElement(tree(), (node) => node.props?.["data-testid"] === "submission-delete-draft");
  }
  function confirmDeleteButton() {
    return findElement(tree(), (node) => node.props?.["data-testid"] === "submission-delete-confirm");
  }
  return {
    reads, writes, deletes, props, tree,
    duplicate: () => find("DuplicateDialog").props,
    generic: () => find("AlertDialog.Root").props,
    deleteButton,
    confirmDeleteButton,
    openDelete() {
      const button = deleteButton();
      assert.ok(button, "DRAFT card co nut xoa dot");
      button.props.onClick();
    },
    async confirmDelete() {
      const button = confirmDeleteButton();
      assert.ok(button, "hop thoai xac nhan xoa dang mo");
      button.props.onClick();
      await new Promise(setImmediate);
    },
    async submit(target = "SUBMITTED") {
      const button = findElement(tree(), (node) => node.type === "button" && node.key === target);
      assert.ok(button, "server-allowed action is rendered");
      button.props.onClick();
      await new Promise(setImmediate);
    },
    async confirm() {
      const action = find("AlertDialog.Action");
      assert.ok(action, "generic confirmation is rendered");
      action.props.children.props.onClick();
      await new Promise(setImmediate);
    },
    async confirmDuplicate() {
      find("DuplicateDialog").props.onConfirm();
      await new Promise(setImmediate);
    },
  };
}

test("DRAFT submit preflights, then sends the acknowledged fingerprint and current version", async () => {
  const ui = renderList();
  await ui.submit();
  assert.equal(ui.reads.length, 1);
  assert.equal(ui.generic().open, false);
  assert.equal(ui.duplicate().preflight, preflight);
  assert.equal(ui.writes.length, 0, "opening the warning must not submit");
  await ui.confirmDuplicate();
  assert.equal(ui.writes.length, 1);
  assert.equal(ui.writes[0].action.target_state, "SUBMITTED");
  assert.equal(ui.writes[0].submission.version, preflight.version);
  assert.equal(ui.writes[0].acknowledgement.fingerprint, preflight.fingerprint);
  assert.equal(ui.writes[0].acknowledgement.count, 1);
});

test("unsaved DRAFT rows block submit before preflight or confirmation", async () => {
  const ui = renderList({ blockedSubmissionIds: new Set([submission.submission_id]) });
  await ui.submit();
  assert.equal(ui.reads.length, 0);
  assert.equal(ui.writes.length, 0);
  assert.equal(ui.generic().open, false);
  assert.equal(ui.duplicate().preflight, null);
  assert.ok(findElement(ui.tree(), (node) => typeof node.props?.children === "string" &&
    node.props.children.includes("Còn dòng chưa được máy chủ xác nhận")));
});

test("preflight unavailable keeps both confirmation paths closed", async () => {
  const ui = renderList({ onPreflight: async () => null });
  await ui.submit();
  assert.equal(ui.generic().open, false);
  assert.equal(ui.duplicate().preflight, null);
  assert.equal(ui.writes.length, 0);
});

test("no conflicts uses normal confirmation with the preflight version", async () => {
  const ui = renderList({ onPreflight: async () => ({ ...preflight, conflict_count: 0 }) });
  await ui.submit();
  assert.equal(ui.generic().open, true);
  assert.equal(ui.writes.length, 0);
  await ui.confirm();
  assert.equal(ui.writes.length, 1);
  assert.equal(ui.writes[0].submission.version, preflight.version);
  assert.equal(ui.writes[0].acknowledgement, undefined);
});

test("a conflict appearing after normal confirmation reopens duplicate confirmation without auto-submit", async () => {
  const writes = [];
  let reads = 0;
  const ui = renderList({
    onPreflight: async () => ({ ...preflight, conflict_count: reads++ === 0 ? 0 : 1 }),
    onTransition: async (input) => { writes.push(input); return "duplicate-changed"; },
  });
  await ui.submit();
  await ui.confirm();
  assert.equal(reads, 2);
  assert.equal(writes.length, 1, "never auto-submit the refreshed conflicts");
  assert.equal(ui.generic().open, false);
  assert.equal(ui.duplicate().preflight.conflict_count, 1);
});

test("stale duplicate confirmation refreshes fingerprint/version and needs another explicit confirmation", async () => {
  let reads = 0;
  const writes = [];
  const fresh = { ...preflight, version: 4, fingerprint: "b".repeat(64) };
  const ui = renderList({
    onPreflight: async () => reads++ === 0 ? preflight : fresh,
    onTransition: async (input) => { writes.push(input); return writes.length === 1 ? "duplicate-changed" : "applied"; },
  });
  await ui.submit();
  await ui.confirmDuplicate();
  assert.equal(writes.length, 1);
  assert.equal(ui.duplicate().preflight, fresh);
  await ui.confirmDuplicate();
  assert.equal(writes.length, 2);
  assert.equal(writes[1].submission.version, 4);
  assert.equal(writes[1].acknowledgement.fingerprint, fresh.fingerprint);
});

test("legacy REVIEW transitions do not request a DRAFT-only preflight", async () => {
  for (const target of ["DRAFT", "SUBMITTED"]) {
    const ui = renderList({ submissions: [{ ...submission, state: "REVIEW", allowed_transitions: [target] }] });
    await ui.submit(target);
    assert.equal(ui.reads.length, 0);
    await ui.confirm();
    assert.equal(ui.writes[0].action.target_state, target);
    assert.equal(ui.writes[0].acknowledgement, undefined);
  }
});

test("confirmation uses Radix AlertDialog without manual modal plumbing", () => {
  assert.match(listComponent, /import \{ AlertDialog \} from "radix-ui"/);
  for (const marker of ["AlertDialog.Root", "AlertDialog.Portal", "AlertDialog.Title",
    "AlertDialog.Description", "AlertDialog.Cancel", "AlertDialog.Action"]) {
    assert.match(listComponent, new RegExp(marker.replace(".", "\\.")), marker);
  }
  assert.doesNotMatch(listComponent, /window\.confirm/);
  assert.doesNotMatch(listComponent, /addEventListener\(\s*"key(down|up)"/);
  assert.doesNotMatch(listComponent, /focus\(\)/);
  assert.doesNotMatch(listComponent, /querySelectorAll\(\s*"\[tabindex/);
  assert.doesNotMatch(listComponent + liveComponent, /createFocusTrap|focus-trap|aria-modal="true"/);
});

test("DRAFT cards expose edit before the renamed submit action", () => {
  assert.match(listComponent, /submission\.state === "DRAFT"[\s\S]*?Sửa/);
  assert.match(listComponent, /onEditDraft\(submission\)/);
  assert.match(helper, /label: "Gửi duyệt"/);
});

test("UI boundary sends only contract fields and never client authority", () => {
  for (const file of [listComponent, liveComponent, helper]) {
    assert.doesNotMatch(file, CLIENT_AUTHORITY);
    assert.doesNotMatch(file, TABLE_ACCESS);
    assert.doesNotMatch(file, RAW_LOGGING);
    assert.doesNotMatch(file, /service_role|SUPABASE_|getSession\(/);
  }
  assert.match(liveComponent, /\/api\/direct-entry\/submissions\?" \+ params\.toString\(\)/);
  assert.match(liveComponent, /\/transition",/);
  assert.match(liveComponent, /method: "POST"/);
  assert.match(liveComponent, /"Idempotency-Key": resolved\.key/);
  assert.match(liveComponent, /expected_version: submission\.version,/);
  assert.match(liveComponent, /target_state: action\.target_state,/);
  assert.match(liveComponent, /idempotency_key: resolved\.key,/);
  const bodyStart = liveComponent.indexOf("body: JSON.stringify({") + "body: JSON.stringify({".length;
  const body = liveComponent.slice(bodyStart, liveComponent.indexOf("}),", bodyStart));
  assert.equal((body.match(/: /g) ?? []).length, 2, "body chi co dung hai truong contract");
  assert.match(liveComponent, /cache: "no-store"/);
  assert.match(liveComponent, /credentials: "same-origin"/);
});

test("live component reuses server projections and lifecycle helpers instead of ad hoc logic", () => {
  assert.match(liveComponent, /projectSubmissionListPage\(/);
  assert.match(liveComponent, /projectSubmissionTransitionResult\(/);
  assert.doesNotMatch(liveComponent, /parseSubmission|JSON\.parse\(/);
  for (const marker of ["isRowEditable(", "dropSubmissionRows(", "mergeReloadedDrafts(",
    "confirmBlockReason(", "resolveIntentKey(", "clearIntentKey(", "transitionErrorMessage("]) {
    assert.match(liveComponent, new RegExp(marker.replace("(", "\\(")), marker);
  }
  assert.match(liveComponent, /crypto\.randomUUID\(\)/);
  assert.match(liveComponent, /crypto\.randomUUID\(\),\s*\n\s*\);/, "key moi cho intent moi");
  assert.doesNotMatch(liveComponent, /optimistic/i);
});

test("project-scoped submissions allow proposals but keep document management out of scope", () => {
  assert.match(listComponent, /submission\.project_scoped\s*\?/);
  assert.match(listComponent, /Yêu cầu thay đổi/);
  assert.match(listComponent, /!submission\.project_scoped\s*&&\s*\(\s*<button[\s\S]*?onManageDocuments\(submission\)/);
});

test("no test or mock route exists inside the app router", () => {
  function walk(directory) {
    const entries = readdirSync(directory, { withFileTypes: true });
    const found = [];
    for (const entry of entries) {
      const full = directory + "/" + entry.name;
      if (entry.isDirectory()) found.push(...walk(full));
      else found.push(full);
    }
    return found;
  }
  const appFiles = walk(fileURLToPath(new URL("../../app", import.meta.url)));
  const directEntryRoutes = appFiles.filter((file) => file.includes("/api/direct-entry/"));
  assert.equal(directEntryRoutes.length > 0, true);
  const suspicious = directEntryRoutes.filter((file) => /mock|fixture|synthetic|_test/i.test(file));
  assert.deepEqual(suspicious, []);
});

/* -------------------- PRE-W2-HF: xoa dot nhap lieu (xoa mem DRAFT) */

test("PRE-W2-HF: chỉ card DRAFT mới có nút Xóa đợt nhập liệu", () => {
  const draft = renderList();
  assert.ok(draft.deleteButton(), "DRAFT co nut xoa dot");
  for (const state of ["SUBMITTED", "REVIEW"]) {
    const ui = renderList({ submissions: [{ ...submission, state, allowed_transitions: [] }] });
    assert.equal(ui.deleteButton(), undefined, state + " khong duoc co nut xoa dot");
  }
});

test("PRE-W2-HF: ẩn nút xóa với đợt chỉ được thấy theo phạm vi dự án", () => {
  const ui = renderList({ submissions: [{ ...submission, project_scoped: true }] });
  assert.equal(ui.deleteButton(), undefined);
});

test("PRE-W2-HF: mở xác nhận không xóa; xác nhận gọi đúng đợt một lần", async () => {
  const ui = renderList();
  ui.openDelete();
  assert.equal(ui.deletes.length, 0, "mo confirm khong goi API");
  assert.ok(ui.confirmDeleteButton(), "hop thoai xac nhan dang mo");
  await ui.confirmDelete();
  assert.equal(ui.deletes.length, 1);
  assert.equal(ui.deletes[0].submission_id, submission.submission_id);
  assert.equal(ui.deletes[0].version, submission.version);
});

test("PRE-W2-HF: request đang chạy khóa nút xóa (disabled + aria-busy)", () => {
  const ui = renderList({ busySubmissionId: submission.submission_id });
  assert.equal(ui.deleteButton().props.disabled, true);
  assert.equal(ui.deleteButton().props["aria-busy"], true);
});

test("PRE-W2-HF: bản xác nhận nói rõ đây là bản nháp và không tuyên bố đã xóa storage", () => {
  assert.match(listComponent, /Xóa đợt nhập liệu\?/);
  assert.match(listComponent, /đang ở trạng thái bản nháp/);
  assert.match(listComponent, /không thể hoàn tác/);
  assert.match(listComponent, /hàng đợi dọn/);
  assert.doesNotMatch(listComponent, /đã xóa khỏi (kho|storage|bucket)/i);
  assert.match(listComponent, /data-testid="submission-delete-confirm"/);
});

test("PRE-W2-HF: live gửi expected_version + Idempotency-Key và chỉ bỏ đợt sau khi server xác nhận", () => {
  assert.match(liveComponent,
    /deleteDraftSubmission\(\{[\s\S]{0,240}expectedVersion: submission\.version,[\s\S]{0,240}idempotencyKey: resolved\.key/);
  const deletedBranch = liveComponent.indexOf('if (result.kind === "deleted")');
  const remove = liveComponent.indexOf("setSubmissions((current) => current.filter(", deletedBranch);
  const failure = liveComponent.indexOf("draftSubmissionDeleteErrorMessage(result)", deletedBranch);
  assert.ok(deletedBranch > 0 && remove > deletedBranch && failure > remove,
    "chi bo dot trong nhanh deleted; nhanh loi chi bao message");
  assert.match(liveComponent, /onDeleteDraft=\{\(submission\) => onDeleteDraftSubmission\(submission\)\}/);
  assert.match(liveComponent, /data-testid="submission-delete-notice"/);
  assert.match(liveComponent, /setBusySubmissionId\(submission\.submission_id\)/);
});
