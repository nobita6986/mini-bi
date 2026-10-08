/**
 * P2.5-HF-R3 - Regression TUONG TAC cho hai diem nguoi dung bao:
 *   1) cac nut quan ly du an (Doi ten / Ngung / Kich hoat) o project-operations.tsx
 *   2) lua chon trang thai Lam viec/Nghi viec (WORK_STATUS) o drawer de xuat
 *
 * .tsx khong import duoc bang node:test, nen moi test gom hai phan:
 *   (a) kiem tra DAY NOI (wiring) o muc source bang bieu thuc CHINH XAC, va
 *   (b) chay THAT ham thuan ma wiring do goi -> bat regression ve cuc tinh/nhan/payload.
 * Khong assert quyen o day: quyen do server quyet dinh.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildSetActiveRequest, projectStatusLabel,
} from "../../lib/direct-entry/project-operations-model.ts";
import {
  allowedWorkStatusTargets, buildChangeRequestItem, buildWorkStatusProposal,
} from "../../lib/direct-entry/change-request-proposal-builders.ts";
import { workerStatusLabel } from "../../lib/direct-entry/worker-operations-model.ts";

const projects = readFileSync(new URL("./project-operations.tsx", import.meta.url), "utf8");
const workers = readFileSync(new URL("./worker-operations.tsx", import.meta.url), "utf8");

const IDEMPOTENCY_KEY = "3f2b7c1e-0a4d-4f5b-9c6e-7d8a1b2c3d4e";
const ENTRY_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const REASON = "Ly do nghiep vu bat buoc";
const TODAY = "2026-03-01";

test("HF-R3: nut Ngung/Kich hoat tren dong du an gui DUNG cuc tinh active", () => {
  // (a) wiring: nhan nut, y dinh dialog va payload deu dao tu CUNG mot nguon.
  assert.match(projects, /\{project\.active \? "Ngừng" : "Kích hoạt"\}/);
  assert.match(projects, /openDialog\(\{ kind: "set-active", active: !loaded\.project_active \}\)/);
  assert.match(projects, /void submitSetActive\(dialog\.active\)/);
  assert.match(projects, /submitLabel=\{dialog\.active \? "Kích hoạt" : "Ngừng hoạt động"\}/);
  assert.match(projects, /buildSetActiveRequest\(\{/);

  // (b) hanh vi: du an dang hoat dong => nut "Ngung" => request active=false (va nguoc lai).
  for (const projectActive of [true, false]) {
    const label = projectActive ? "Ngừng" : "Kích hoạt";
    const dialogActive = !projectActive;
    const built = buildSetActiveRequest({
      active: dialogActive, reason: REASON, expectedVersion: 7, idempotencyKey: IDEMPOTENCY_KEY,
    });
    assert.equal(built.ok, true);
    assert.equal(built.body.active, label === "Ngừng" ? false : true);
    assert.deepEqual(Object.keys(built.body).sort(),
      ["active", "expected_version", "idempotency_key", "reason"]);
  }
});

test("HF-R3: tat/kich hoat du an van bat buoc ly do va version OCC", () => {
  const missingReason = buildSetActiveRequest({
    active: false, reason: "   ", expectedVersion: 3, idempotencyKey: IDEMPOTENCY_KEY });
  assert.equal(missingReason.ok, false);
  const badVersion = buildSetActiveRequest({
    active: true, reason: REASON, expectedVersion: -1, idempotencyKey: IDEMPOTENCY_KEY });
  assert.equal(badVersion.ok, false);
  const badKey = buildSetActiveRequest({
    active: true, reason: REASON, expectedVersion: 3, idempotencyKey: "khong-phai-uuid" });
  assert.equal(badKey.ok, false);
  const ok = buildSetActiveRequest({
    active: false, reason: REASON, expectedVersion: 3, idempotencyKey: IDEMPOTENCY_KEY });
  assert.equal(ok.ok, true);
  assert.equal(ok.body.expected_version, 3);
  assert.equal(ok.body.reason, REASON);
});

test("HF-R3: nhan trang thai du an va nut khong doi nghia", () => {
  assert.match(projects, /\{projectStatusLabel\(active\)\}/);
  assert.equal(projectStatusLabel(true), "Đang hoạt động");
  assert.equal(projectStatusLabel(false), "Đã ngừng");
  // Nut khong bi disable boi quyen: chi chan khi dang co thao tac khac chay.
  assert.match(projects, /disabled=\{projectActionId !== null\}/);
  assert.equal(/disabled=\{!canManage/.test(projects), false);
});

test("HF-R3: o chon trang thai chi hien thi buoc chuyen hop le", () => {
  assert.match(workers,
    /\{allowedWorkStatusTargets\(baseline\?\.status \?\? null\)\.map\(\(status\) => \(/);
  assert.match(workers, /<option key=\{status\} value=\{status\}>\{workerStatusLabel\(status\)\}<\/option>/);
  assert.deepEqual(allowedWorkStatusTargets("UNCONFIRMED"), ["ON", "OFF"]);
  assert.deepEqual(allowedWorkStatusTargets("ON"), ["OFF"]);
  assert.deepEqual(allowedWorkStatusTargets("OFF"), ["ON"]);
  assert.deepEqual(allowedWorkStatusTargets(null), []);
});

test("HF-R3: nhan lua chon Lam viec/Nghi viec dung nghiep vu", () => {
  assert.equal(workerStatusLabel("ON"), "Đang làm");
  assert.equal(workerStatusLabel("OFF"), "Đã nghỉ");
  assert.equal(workerStatusLabel("UNCONFIRMED"), "Chưa xác nhận");
  assert.equal(workerStatusLabel(null), "Chưa có trạng thái");
  assert.deepEqual(allowedWorkStatusTargets("ON").map(workerStatusLabel), ["Đã nghỉ"]);
  assert.deepEqual(allowedWorkStatusTargets("OFF").map(workerStatusLabel), ["Đang làm"]);
  assert.match(workers, /Trạng thái làm việc mới/);
  assert.match(workers, /disabled=\{loading \|\| baseline\?\.status == null\}/);
});

test("HF-R3: Nghi viec bat buoc ly do; Lam viec khong gui leave_reason", () => {
  const onBaseline = { status: "ON", effective_date: "2026-01-05" };
  const missing = buildWorkStatusProposal({ baseline: onBaseline, status: "OFF",
    effectiveDate: "2026-02-01", leaveReason: "   ", today: TODAY });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, "STATUS_REASON_REQUIRED");

  const off = buildWorkStatusProposal({ baseline: onBaseline, status: "OFF",
    effectiveDate: "2026-02-01", leaveReason: "  Nghi theo de xuat  ", today: TODAY });
  assert.equal(off.ok, true);
  assert.deepEqual(off.proposal,
    { status: "OFF", effective_date: "2026-02-01", leave_reason: "Nghi theo de xuat" });

  const back = buildWorkStatusProposal({ baseline: { status: "OFF", effective_date: "2026-02-01" },
    status: "ON", effectiveDate: "2026-03-01", leaveReason: "khong duoc dung", today: TODAY });
  assert.equal(back.ok, true);
  assert.deepEqual(Object.keys(back.proposal).sort(), ["effective_date", "status"]);
  assert.equal(Object.prototype.hasOwnProperty.call(back.proposal, "leave_reason"), false);
});

test("HF-R3: buoc chuyen sai bi tu choi ngay tren client", () => {
  // ON -> ON voi cung ngay: khong co thay doi thuc su.
  const unchanged = buildWorkStatusProposal({ baseline: { status: "ON", effective_date: "2026-01-05" },
    status: "ON", effectiveDate: "2026-01-05", leaveReason: "", today: TODAY });
  assert.equal(unchanged.ok, false);
  assert.equal(unchanged.code, "STATUS_UNCHANGED");
  // Ngay hieu luc ngoai khoang [baseline, today] bi tu choi.
  const futureDate = buildWorkStatusProposal({ baseline: { status: "ON", effective_date: "2026-01-05" },
    status: "OFF", effectiveDate: "2026-06-01", leaveReason: "ly do", today: TODAY });
  assert.equal(futureDate.ok, false);
  assert.equal(futureDate.code, "STATUS_DATE_INVALID");
  // Khong co baseline thi khong de xuat duoc.
  const noBaseline = buildWorkStatusProposal({ baseline: null, status: "ON",
    effectiveDate: "2026-02-01", leaveReason: "", today: TODAY });
  assert.equal(noBaseline.ok, false);
  assert.equal(noBaseline.code, "STATUS_INVALID");
});

test("HF-R3: o ly do nghi chi hien khi chon Nghi viec, va bat buoc", () => {
  assert.match(workers, /\{targetStatus === "OFF" \? \(/);
  assert.match(workers, /id="worker-leave-reason"/);
  assert.match(workers, /required aria-required="true"/);
  assert.match(workers, /targetKind = "WORK_STATUS"/);
});

test("HF-R3: proposal trang thai di qua DUNG validator cua create contract", () => {
  const built = buildWorkStatusProposal({ baseline: { status: "ON", effective_date: "2026-01-05" },
    status: "OFF", effectiveDate: "2026-02-01", leaveReason: "Ly do nghi", today: TODAY });
  assert.equal(built.ok, true);
  const item = buildChangeRequestItem({ entryId: ENTRY_ID, expectedVersion: 4,
    targetKind: "WORK_STATUS", proposal: built.proposal });
  assert.notEqual(item, null);
  assert.equal(item.target_kind, "WORK_STATUS");
  assert.equal(item.expected_version, 4);
  assert.deepEqual(item.proposal, built.proposal);
  // Proposal thieu leave_reason khong duoc di qua (fail-closed).
  const broken = buildChangeRequestItem({ entryId: ENTRY_ID, expectedVersion: 4,
    targetKind: "WORK_STATUS", proposal: { status: "OFF", effective_date: "2026-02-01" } });
  assert.equal(broken, null);
});
