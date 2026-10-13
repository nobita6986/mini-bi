/**
 * PRE-W2-P2 - De xuat sua ho ten NLĐ qua luong duyet hien co.
 *
 * Pham vi: affordance sua ten (target WORKER) o CA HAI entry point chi mo khi du
 * propose_change + pii_view + baseline canonical day du; payload gui di la worker_details day du
 * (chi display_name doi); reviewer before/after + OCC/target_kind van dung implementation hien co.
 * Khong tao workflow/direct-write/name-only.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  WORKER_NAME_DENIED_PII_MESSAGE,
  WORKER_NAME_NO_BASELINE_MESSAGE,
  workerNameAvailability,
} from "./worker-operations-model.ts";
import {
  buildChangeRequestItem,
  buildEntryFieldProposal,
  buildWorkerDetailsProposal,
  workerEntryFormFromBaseline,
  workerFormFromDetails,
} from "./change-request-proposal-builders.ts";
import { workerDetailsRows } from "./change-request-read-projection.ts";

function read(relative) {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}
const drawer = read("../../components/direct-entry/worker-operations.tsx");
const proposer = read("../../components/direct-entry/direct-entry-change-request-proposer.tsx");

const OPTIONAL = { state: "unknown" };
const ENTRY_ID = "c1000000-0000-4000-8000-00000000000a";

function worker(overrides = {}) {
  return {
    display_name: "Nguyen Van Synthetic",
    gender: { state: "provided", value: "MALE" },
    date_of_birth: { state: "provided", value: "1990-01-02" },
    national_id: { state: "provided", value: "012345678901" },
    address: OPTIONAL,
    phone: OPTIONAL,
    ...overrides,
  };
}

function entryBaseline() {
  return {
    project_id: "proj_1",
    first_work_date: "2026-10-01",
    employee_code: "hrp-2026-000001",
    recruiter_id: "22222222-2222-4222-8222-222222222222",
    labor_type: "PERMANENT",
    worker_details: worker(),
  };
}

/* ---------- authority: propose_change VA pii_view la hai quyen doc lap ---------- */

test("P2: affordance sua ten chi mo khi du propose_change + pii_view + baseline", () => {
  assert.deepEqual(
    workerNameAvailability({ proposeChange: true, viewPii: true, hasBaseline: true }),
    { available: true, message: null });

  const noPropose = workerNameAvailability({ proposeChange: false, viewPii: true, hasBaseline: true });
  assert.equal(noPropose.available, false);
  assert.match(noPropose.message, /quyền đề xuất/);

  const noPii = workerNameAvailability({ proposeChange: true, viewPii: false, hasBaseline: true });
  assert.equal(noPii.available, false);
  assert.equal(noPii.message, WORKER_NAME_DENIED_PII_MESSAGE);

  const noBaseline = workerNameAvailability({ proposeChange: true, viewPii: true, hasBaseline: false });
  assert.equal(noBaseline.available, false);
  assert.equal(noBaseline.message, WORKER_NAME_NO_BASELINE_MESSAGE);

  // KHONG suy quyen xem PII tu quyen de xuat: thieu pii_view luon bi tu choi du propose_change=true.
  assert.equal(
    workerNameAvailability({ proposeChange: true, viewPii: false, hasBaseline: true }).available, false);
  // Copy khong lo UUID/raw DB.
  for (const message of [WORKER_NAME_DENIED_PII_MESSAGE, WORKER_NAME_NO_BASELINE_MESSAGE]) {
    assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}/i.test(message), false, "khong lo UUID");
    assert.equal(/42501|SQLSTATE|postgres/i.test(message), false, "khong lo raw DB");
  }
});

/* ---------- payload: worker_details day du, chi display_name doi ---------- */

test("P2: sua ten gui worker_details DAY DU (khong bao gio name-only)", () => {
  const baseline = worker();
  const form = workerFormFromDetails(baseline);
  form.display_name = "Nguyen Van Renamed";
  const built = buildWorkerDetailsProposal(baseline, form);
  assert.equal(built.ok, true);
  const proposal = built.proposal.worker_details;
  assert.equal(proposal.display_name, "Nguyen Van Renamed");
  for (const key of ["date_of_birth", "national_id", "address", "phone"]) {
    assert.ok(key in proposal, "payload day du phai giu " + key);
  }
  assert.deepEqual(proposal.date_of_birth, baseline.date_of_birth);
  assert.deepEqual(proposal.national_id, baseline.national_id);
  // Chi display_name doi so voi baseline; dat lai ten => y het baseline.
  assert.deepEqual({ ...proposal, display_name: baseline.display_name }, baseline);
});

test("P2: ENTRY_FIELD sua ten giu profile day du + target_kind/version (OCC) hien co", () => {
  const baseline = entryBaseline();
  const form = workerEntryFormFromBaseline(baseline);
  form.workerDetails.display_name = "Nguyen Van Renamed";
  const built = buildEntryFieldProposal({
    entryId: ENTRY_ID, expectedVersion: 8, baseline, form,
  });
  assert.equal(built.ok, true);
  assert.deepEqual(Object.keys(built.proposal), ["worker_details"]);
  assert.equal(built.proposal.worker_details.display_name, "Nguyen Van Renamed");
  assert.ok("national_id" in built.proposal.worker_details);
  const item = buildChangeRequestItem({
    entryId: ENTRY_ID, expectedVersion: 8, targetKind: "ENTRY_FIELD", proposal: built.proposal,
  });
  assert.equal(item.target_kind, "ENTRY_FIELD");
  assert.equal(item.expected_version, 8, "OCC giu nguyen");
});

test("P2: reviewer before/after dung projection hien co, hien thay doi ho ten", () => {
  const before = worker();
  const after = { ...before, display_name: "Nguyen Van Renamed" };
  assert.deepEqual(workerDetailsRows(before, after), [{
    field: "display_name", label: "Họ tên",
    before: "Nguyen Van Synthetic", after: "Nguyen Van Renamed",
  }]);
});

/* ---------- entry point 1: Danh sach nguoi lao dong (WORKER target) ---------- */

test("P2 (Directory): sua ten gate bang propose_change + view_pii, denial thay vi form hong", () => {
  assert.match(drawer, /workerNameAvailability\(\{/);
  assert.match(drawer, /proposeChange: mode === "correction" \? true : row\?\.allowed_actions\.propose_change === true/);
  assert.match(drawer, /viewPii: row\?\.allowed_actions\.view_pii === true/);
  assert.match(drawer, /hasBaseline: entryForm !== null/);
  // Form sua ten chi render khi available; nguoc lai hien giai thich (khong hien form chac chan that bai).
  assert.match(drawer, /entryForm !== null && nameAvailability\.available \?/);
  assert.match(drawer, /data-testid="propose-worker-unavailable"/);
  // Nut gui bi vo hieu hoa khi target WORKER thieu quyen/baseline.
  assert.match(drawer,
    /disabled=\{busy \|\| loading \|\| baseline === null \|\|\s*\n\s*\(workerFieldMode && !nameAvailability\.available\)\}/);
  // Tai su dung builder + change-request lifecycle hien co (khong bypass, khong direct-write).
  assert.match(drawer, /buildEntryFieldProposal\(\{/);
  assert.match(drawer, /fetch\(API \+ "\/change-requests", \{/);
});

/* ---------- entry point 2: Nhap lieu (Yeu cau sua/thay doi) ---------- */

test("P2 (Direct Entry): WORKER dung cung builder, denial khi thieu baseline/pii_view", () => {
  assert.match(proposer, /buildWorkerDetailsProposal\(/);
  assert.match(proposer, /data-testid="proposer-worker-unavailable"/);
  assert.match(proposer, /disabled=\{!canSubmit\}/);
  assert.match(proposer, /fetch\("\/api\/direct-entry\/change-requests", \{/);
  // Khong tao workflow thu hai / direct-write tu proposer.
  assert.equal(/privileged-edit/.test(proposer), false, "proposer khong duoc direct-write");
  assert.equal(/accounts?\/|supabase|\.from\(/.test(proposer), false, "khong tu ghi DB/API khac");
});
