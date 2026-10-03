import assert from "node:assert/strict";
import test from "node:test";

import {
  CHANGE_REQUEST_MAX_ITEMS,
  CHANGE_REQUEST_TARGET_KINDS,
  findForbiddenChangeRequestField,
  isChangeRequestState,
  projectChangeRequestCreate,
  projectChangeRequestCreated,
  projectChangeRequestDecision,
  projectChangeRequestItem,
  projectChangeRequestStateResult,
  projectChangeRequestWithdraw,
} from "./change-request-contract.ts";

const entryA = "c1000000-0000-4000-8000-000000000001";
const entryB = "c1000000-0000-4000-8000-000000000002";
const recruiterId = "93000000-0000-4000-8000-000000000001";
const requestId = "d1000000-0000-4000-8000-000000000001";

function item(overrides = {}) {
  return {
    entry_id: entryA,
    target_kind: "ENTRY_FIELD",
    expected_version: 1,
    proposal: { labor_type: "PERMANENT" },
    ...overrides,
  };
}

function createBody(overrides = {}) {
  return {
    items: [item()],
    reason: "Synthetic change reason",
    idempotency_key: "change-request-synthetic-key",
    ...overrides,
  };
}

test("valid single and multi entry create requests pass with exact vocabulary", () => {
  const single = projectChangeRequestCreate(createBody());
  assert.equal(single.ok, true);
  assert.deepEqual(single.value.items, [{
    entry_id: entryA,
    target_kind: "ENTRY_FIELD",
    expected_version: 1,
    proposal: { labor_type: "PERMANENT" },
  }]);
  assert.equal(single.value.reason, "Synthetic change reason");

  const multi = projectChangeRequestCreate(createBody({
    items: [item(), item({
      entry_id: entryB,
      target_kind: "PAYMENT",
      proposal: {
        state: "provided",
        account_number: "000012340056",
        bank_id: "bank_synthetic",
        account_holder_name: "Synthetic Holder",
      },
    })],
  }));
  assert.equal(multi.ok, true);
  assert.equal(multi.value.items.length, 2);
  assert.deepEqual(multi.value.items[1].proposal, {
    state: "provided",
    account_number: "000012340056",
    bank_id: "bank_synthetic",
    account_holder_name: "Synthetic Holder",
  });

  for (const kind of CHANGE_REQUEST_TARGET_KINDS) {
    assert.equal(typeof kind, "string");
  }
});

test("DOCUMENT create and mixed DOCUMENT create fail closed as a whole", () => {
  const documentItem = item({
    target_kind: "DOCUMENT",
    proposal: {
      document_type: "EMPLOYMENT_CONTRACT",
      idempotency_key: "document-synthetic-key",
      checksum_sha256: "a".repeat(64),
      size_bytes: 2048,
      mime_type: "application/pdf",
    },
  });
  for (const items of [[documentItem], [item(), documentItem]]) {
    assert.deepEqual(projectChangeRequestCreate(createBody({ items })), {
      ok: false,
      code: "DOCUMENT_CHANGE_REQUEST_UNSUPPORTED",
    });
  }
  assert.equal(projectChangeRequestItem(documentItem)?.target_kind, "DOCUMENT",
    "item projection remains available for historical/read compatibility");
});

test("empty, oversized and duplicate items fail closed", () => {
  assert.equal(projectChangeRequestCreate(createBody({ items: [] })).ok, false);
  assert.equal(projectChangeRequestCreate(createBody({ items: {} })).ok, false);
  assert.equal(projectChangeRequestCreate(createBody({ items: "x" })).ok, false);
  assert.equal(projectChangeRequestCreate(createBody({
    items: Array.from({ length: CHANGE_REQUEST_MAX_ITEMS + 1 }, () => item()),
  })).ok, false);
  const duplicate = projectChangeRequestCreate(createBody({ items: [item(), item()] }));
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.code, "CHANGE_REQUEST_INVALID");
  assert.equal(projectChangeRequestItem(item({ entry_id: "not-a-uuid" })), null);
  assert.equal(projectChangeRequestItem(item({ target_kind: "entry_field" })), null);
  assert.equal(projectChangeRequestItem(item({ proposal: {} })), null);
  assert.equal(projectChangeRequestItem({ ...item(), extra: 1 }), null);
});

test("malformed expected_version, reason and idempotency key fail closed", () => {
  for (const value of [0, -1, 1.5, "1", null, true, Number.NaN]) {
    assert.equal(projectChangeRequestCreate(createBody({
      items: [item({ expected_version: value })],
    })).ok, false, String(value));
  }
  for (const value of ["", "   ", null, 12]) {
    assert.equal(projectChangeRequestCreate(createBody({ reason: value })).ok, false, String(value));
  }
  assert.equal(projectChangeRequestCreate(createBody({ reason: "x".repeat(4000) })).ok, true);
  assert.equal(projectChangeRequestCreate(createBody({ reason: "x".repeat(4001) })).ok, false);
  for (const value of ["", "   ", 12, null, "x".repeat(129)]) {
    assert.equal(projectChangeRequestCreate(createBody({ idempotency_key: value })).ok, false);
  }
  assert.equal(projectChangeRequestCreate(createBody({ idempotency_key: "key\nvalue" })).ok, false);
});

test("recursive authority fields are rejected at every depth", () => {
  const envelope = projectChangeRequestCreate(createBody({ actor_id: entryA }));
  assert.equal(envelope.code, "CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  assert.equal(envelope.field, "actor_id");

  const itemLevel = projectChangeRequestCreate(createBody({
    items: [{ ...item(), capability: "change_review" }],
  }));
  assert.equal(itemLevel.code, "CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  assert.equal(itemLevel.field, "items[0].capability");

  const proposalLevel = projectChangeRequestCreate(createBody({
    items: [item({ proposal: { labor_type: "PERMANENT", scope: "all" } })],
  }));
  assert.equal(proposalLevel.code, "CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  assert.equal(proposalLevel.field, "items[0].proposal.scope");

  const nested = projectChangeRequestCreate(createBody({
    items: [item({ proposal: {
      worker_details: { display_name: "Synthetic", created_by_user_id: entryA },
    } })],
  }));
  assert.equal(nested.code, "CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  assert.equal(nested.field, "items[0].proposal.worker_details.created_by_user_id");

  const reviewer = projectChangeRequestCreate(createBody({ reviewer_user_id: entryA }));
  assert.equal(reviewer.code, "CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  assert.deepEqual(findForbiddenChangeRequestField({ proposer: "x" }), { field: "proposer" });
  assert.deepEqual(findForbiddenChangeRequestField({ nested: { proposer: "x" } }), {
    field: "nested.proposer",
  });

  // `state` la field HOP LE trong proposal PAYMENT: khong duoc bao nham la authority.
  assert.equal(findForbiddenChangeRequestField({ proposal: { state: "provided" } }), null);
  assert.equal(projectChangeRequestCreate(createBody({
    items: [item({ target_kind: "PAYMENT", proposal: {
      state: "unknown", account_number: null, bank_id: null, account_holder_name: null,
    } })],
  })).ok, true);
});

test("proposal vocabulary follows the database allowed sets", () => {
  assert.equal(projectChangeRequestItem(item({ proposal: { unknown_field: 1 } })), null);
  assert.equal(projectChangeRequestItem(item({ proposal: { labor_type: "CONTRACT" } })), null);
  assert.equal(projectChangeRequestItem(item({ proposal: { first_work_date: "2026-02-30" } })), null);
  assert.equal(projectChangeRequestItem(item({ proposal: { recruiter_id: "nope" } })), null);
  assert.equal(projectChangeRequestItem(item({ proposal: { project_id: 7 } })), null);
  assert.equal(projectChangeRequestItem(item({ proposal: {
    first_work_date: "2026-10-15", project_id: "project_synthetic_01", recruiter_id: recruiterId,
    employee_code: "hrp-2026-000123", labor_type: "TEMPORARY",
    worker_details: { display_name: "Synthetic", phone: { state: "omitted" } },
  } })) !== null, true);

  assert.equal(projectChangeRequestItem(item({ target_kind: "PAYMENT", proposal: {
    state: "provided", account_number: "000012340056", bank_id: "bank_synthetic",
  } })), null);
  assert.equal(projectChangeRequestItem(item({ target_kind: "PAYMENT", proposal: {
    state: "unknown", account_number: "000012340056", bank_id: null, account_holder_name: null,
  } })), null);

  assert.equal(projectChangeRequestItem(item({ target_kind: "WORK_STATUS", proposal: {
    status: "ON", effective_date: "2026-10-15",
  } })).proposal.leave_reason, null);
  assert.equal(projectChangeRequestItem(item({ target_kind: "WORK_STATUS", proposal: {
    status: "ON", effective_date: "2026-10-15", leave_reason: "khong duoc co",
  } })), null);
  assert.equal(projectChangeRequestItem(item({ target_kind: "WORK_STATUS", proposal: {
    status: "OFF", effective_date: "2026-10-15",
  } })), null);
  assert.equal(projectChangeRequestItem(item({ target_kind: "WORK_STATUS", proposal: {
    status: "OFF", effective_date: "2026-10-15", leave_reason: "Nghi viec theo ke hoach",
  } })).proposal.status, "OFF");
  assert.equal(projectChangeRequestItem(item({ target_kind: "WORK_STATUS", proposal: {
    status: "MAYBE", effective_date: "2026-10-15",
  } })), null);

  const documentProposal = {
    document_type: "CCCD_FRONT",
    idempotency_key: "document-synthetic-key",
    checksum_sha256: "a".repeat(64),
    size_bytes: 1024,
    mime_type: "application/pdf",
  };
  assert.deepEqual(projectChangeRequestItem(item({ target_kind: "DOCUMENT", proposal: documentProposal })).proposal, documentProposal);
  assert.equal(projectChangeRequestItem(item({ target_kind: "DOCUMENT", proposal: {
    ...documentProposal, mime_type: "text/plain",
  } })), null);
  assert.equal(projectChangeRequestItem(item({ target_kind: "DOCUMENT", proposal: {
    ...documentProposal, size_bytes: 10 * 1024 * 1024 + 1,
  } })), null);
  assert.equal(projectChangeRequestItem(item({ target_kind: "DOCUMENT", proposal: {
    ...documentProposal, checksum_sha256: "A".repeat(64),
  } })), null);
  assert.equal(projectChangeRequestItem(item({ target_kind: "DOCUMENT", proposal: {
    ...documentProposal, document_type: "PASSPORT",
  } })), null);
});

test("withdraw and decision envelopes are strict", () => {
  const withdraw = projectChangeRequestWithdraw({
    expected_version: 1, idempotency_key: "withdraw-synthetic-key",
  });
  assert.equal(withdraw.ok, true);
  assert.equal(projectChangeRequestWithdraw({ expected_version: 0, idempotency_key: "k" }).ok, false);
  assert.equal(projectChangeRequestWithdraw({ expected_version: 1, idempotency_key: "k", extra: 1 }).ok, false);
  const withdrawAuthority = projectChangeRequestWithdraw({
    expected_version: 1, idempotency_key: "k", proposer_user_id: entryA,
  });
  assert.equal(withdrawAuthority.code, "CLIENT_AUTHORITY_FIELD_FORBIDDEN");

  for (const decision of ["approve", "reject"]) {
    const parsed = projectChangeRequestDecision({
      decision, expected_version: 2, reason: "Synthetic decision reason",
      idempotency_key: "decision-synthetic-key",
    });
    assert.equal(parsed.ok, true, decision);
    assert.equal(parsed.value.decision, decision);
  }
  for (const decision of ["APPROVE", "approve ", "delete", "", null, 1]) {
    assert.equal(projectChangeRequestDecision({
      decision, expected_version: 2, reason: "x", idempotency_key: "k",
    }).ok, false, String(decision));
  }
  assert.equal(projectChangeRequestDecision({
    decision: "approve", expected_version: 2, reason: "", idempotency_key: "k",
  }).ok, false);
  assert.equal(projectChangeRequestDecision({
    decision: "approve", expected_version: 2, idempotency_key: "k",
  }).ok, false);
  const decisionAuthority = projectChangeRequestDecision({
    decision: "approve", expected_version: 2, reason: "x", idempotency_key: "k",
    reviewer_user_id: entryA,
  });
  assert.equal(decisionAuthority.code, "CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  assert.equal(decisionAuthority.field, "reviewer_user_id");
});

test("result projections are exact and never invent fields", () => {
  assert.deepEqual(
    projectChangeRequestCreated({ request_id: requestId, state: "PENDING", items: 2 }, 2),
    { request_id: requestId, state: "PENDING", items: 2 },
  );
  assert.equal(projectChangeRequestCreated({ request_id: requestId, state: "PENDING", items: 2 }, 1), null);
  assert.equal(projectChangeRequestCreated({
    request_id: requestId, state: "APPROVED", items: 2,
  }, 2), null);
  assert.equal(projectChangeRequestCreated({
    request_id: requestId, state: "PENDING", items: 2, reused: true,
  }, 2), null);
  assert.equal(projectChangeRequestCreated({
    request_id: requestId, state: "PENDING", items: 2, revision_id: requestId,
  }, 2), null);
  assert.equal(projectChangeRequestCreated({ request_id: requestId, state: "PENDING" }, 2), null);
  assert.equal(projectChangeRequestCreated({ state: "PENDING", items: 2 }, 2), null);

  const expected = { request_id: requestId, expected_version: 3, state: "APPROVED" };
  assert.deepEqual(
    projectChangeRequestStateResult({ request_id: requestId, state: "APPROVED", version: 4 }, expected),
    { request_id: requestId, state: "APPROVED", version: 4 },
  );
  assert.equal(projectChangeRequestStateResult({
    request_id: requestId, state: "REJECTED", version: 4,
  }, expected), null);
  assert.equal(projectChangeRequestStateResult({
    request_id: requestId, state: "APPROVED", version: 5,
  }, expected), null);
  assert.equal(projectChangeRequestStateResult({
    request_id: "d1000000-0000-4000-8000-000000000002", state: "APPROVED", version: 4,
  }, expected), null);
  assert.equal(projectChangeRequestStateResult({
    request_id: requestId, state: "APPROVED", version: 4, decided_at: "2026-10-03T00:00:00Z",
  }, expected), null);
  assert.equal(projectChangeRequestStateResult(null, expected), null);
  assert.equal(isChangeRequestState("PENDING"), true);
  assert.equal(isChangeRequestState("pending"), false);
});
test("S03B4A: worker_details OptionalValue duoc chap nhan, authority long ben trong van bi chan", () => {
  const workerDetails = {
    display_name: "Nguyen Van Synthetic",
    date_of_birth: { state: "provided", value: "1990-01-02" },
    national_id: { state: "unknown" },
    address: { state: "intentionally_blank" },
    phone: { state: "provided", value: "0900000000" },
  };
  const accepted = projectChangeRequestCreate(createBody({
    items: [{ entry_id: entryA, target_kind: "ENTRY_FIELD", expected_version: 1,
      proposal: { worker_details: workerDetails } }],
  }));
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.deepEqual(accepted.value.items[0].proposal, { worker_details: workerDetails });

  const injected = projectChangeRequestCreate(createBody({
    items: [{ entry_id: entryA, target_kind: "ENTRY_FIELD", expected_version: 1,
      proposal: { worker_details: { ...workerDetails, actor_id: "x" } } }],
  }));
  assert.equal(injected.ok, false);
  assert.equal(injected.code, "CLIENT_AUTHORITY_FIELD_FORBIDDEN");
});
