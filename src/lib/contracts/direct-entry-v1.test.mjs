import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  DIRECT_ENTRY_CONTRACT_VERSION,
  applyPrivilegedDirectEdit,
  appendStatusEvent,
  canEditRows,
  canonicalizeEmployeeCode,
  correctLatestStatusEvent,
  createChangeRequest,
  createDocumentVersion,
  decideChangeRequest,
  deriveCurrentStatus,
  resolveExplicitRecruiterLink,
  searchEligibleRecruiters,
  transitionDocumentUpload,
  transitionSubmission,
  validateEmployeeCode,
  validateEntry,
  validatePaymentDetails,
  validateRecruiterSelection,
  validateStatusProposal,
} from "./direct-entry-v1.ts";

const fixture = JSON.parse(readFileSync(
  new URL("../../../docs/contracts/fixtures/p1.6-w01/direct-entry-fixture.json", import.meta.url),
  "utf8",
));
const entry = fixture.entry;
const validationContext = {
  projects: fixture.projects,
  banks: fixture.banks,
  catalog: fixture.identity_catalog,
};
const timestamp = "2026-10-16T08:00:00.000Z";
const requiredDocument = {
  document_id: "doc_0123456789abcdef0123456789abcdef",
  candidate_ref: "00000000-0000-4000-8000-0000000000b1",
  document_type: "CCCD_FRONT",
  idempotency_key: "upload_synthetic_01",
  checksum_sha256: "a".repeat(64),
  size_bytes: 1_024,
  mime_type: "image/png",
  created_by: "user_synthetic_02",
  created_at: timestamp,
};

function readyDocument(document) {
  let next = transitionDocumentUpload(document, "START");
  next = transitionDocumentUpload(next, "QUARANTINE");
  next = transitionDocumentUpload(next, "SCAN");
  return transitionDocumentUpload(next, "SCAN_CLEAN");
}

function changeRequest(items, requestId = "request_synthetic_01") {
  return createChangeRequest({
    submission_state: "SUBMITTED",
    request_id: requestId,
    proposer_id: "user_synthetic_02",
    capabilities: ["change_request_create"],
    reason: "Synthetic correction request",
    items,
    created_at: timestamp,
  });
}

test("contract is versioned and fixtures pass the direct-entry validator", () => {
  assert.equal(DIRECT_ENTRY_CONTRACT_VERSION, "direct-entry/1.0");
  assert.equal(validateEntry({ entry, ...validationContext }).ok, true);
  assert.equal(validateEntry({ entry: null, ...validationContext }).issues[0].code, "ENTRY_INVALID");
  assert.equal(entry.employment_events[0].status, "UNCONFIRMED");
});

test("app user and recruiter are separate; a verified explicit link is optional", () => {
  assert.notEqual(entry.app_user_id, entry.recruiter_id);
  assert.equal(resolveExplicitRecruiterLink({
    app_user_id: entry.app_user_id,
    date: entry.first_work_date,
    links: fixture.identity_catalog.app_user_recruiter_links,
  }), null);
  assert.equal(resolveExplicitRecruiterLink({
    app_user_id: "00000000-0000-4000-8000-0000000000d1",
    date: "2026-10-15",
    links: fixture.identity_catalog.app_user_recruiter_links,
  }), "rcr_synthetic_01");
  assert.equal(resolveExplicitRecruiterLink({
    app_user_id: "00000000-0000-4000-8000-0000000000d1",
    date: "2025-12-31",
    links: fixture.identity_catalog.app_user_recruiter_links,
  }), null);
});

test("recruiter picker normalizes search and filters stable master IDs by provider", () => {
  const cResults = searchEligibleRecruiters({
    query: "C",
    provider_type: "hrp",
    business_date: "2026-10-15",
    catalog: fixture.identity_catalog,
  });
  const coResults = searchEligibleRecruiters({
    query: "Co",
    provider_type: "hrp",
    business_date: "2026-10-15",
    catalog: fixture.identity_catalog,
  });
  assert.ok(cResults.length > coResults.length);
  assert.deepEqual(coResults.map((option) => option.recruiter_id), ["rcr_synthetic_01"]);
  assert.deepEqual(searchEligibleRecruiters({
    query: "C",
    provider_type: "vendor",
    business_date: "2026-10-15",
    catalog: fixture.identity_catalog,
  }).map((option) => option.recruiter_id), ["rcr_synthetic_03"]);
});

test("inactive, provider-mismatched, and outside-effective-date recruiters are rejected", () => {
  assert.equal(validateRecruiterSelection({
    recruiter_id: "rcr_synthetic_inactive",
    provider_type: "hrp",
    business_date: "2026-10-15",
    catalog: fixture.identity_catalog,
  })[0].code, "RECRUITER_NOT_ACTIVE");
  assert.equal(validateRecruiterSelection({
    recruiter_id: "rcr_synthetic_01",
    provider_type: "vendor",
    business_date: "2026-10-15",
    catalog: fixture.identity_catalog,
  })[0].code, "PROVIDER_MEMBERSHIP_NOT_FOUND");
  assert.equal(validateRecruiterSelection({
    recruiter_id: "CongHr1 synthetic",
    provider_type: "hrp",
    business_date: "2026-10-15",
    catalog: fixture.identity_catalog,
  })[0].code, "RECRUITER_NOT_ACTIVE");
  assert.equal(validateRecruiterSelection({
    recruiter_id: "rcr_synthetic_01",
    provider_type: "hrp",
    business_date: "2025-12-31",
    catalog: fixture.identity_catalog,
  })[0].code, "PROVIDER_MEMBERSHIP_NOT_FOUND");
});

test("effective membership uses W02 half-open boundary semantics", () => {
  assert.equal(validateRecruiterSelection({
    recruiter_id: "rcr_synthetic_01",
    provider_type: "hrp",
    business_date: "2026-08-31",
    catalog: fixture.identity_catalog,
  }).length, 0);
  assert.equal(validateRecruiterSelection({
    recruiter_id: "rcr_synthetic_01",
    provider_type: "hrp",
    business_date: "2026-09-01",
    catalog: fixture.identity_catalog,
  }).length, 0);
  const catalog = structuredClone(fixture.identity_catalog);
  catalog.team_memberships = catalog.team_memberships.filter((membership) =>
    membership.membership_id !== "tm_synthetic_new"
  );
  assert.equal(validateRecruiterSelection({
    recruiter_id: "rcr_synthetic_01",
    provider_type: "hrp",
    business_date: "2026-09-01",
    catalog,
  })[0].code, "TEAM_MEMBERSHIP_NOT_FOUND");
});

test("employee code canonicalizes case, preserves leading zeros, and rejects format/year/duplicates", () => {
  assert.equal(canonicalizeEmployeeCode("HRP-2026-000001"), "hrp-2026-000001");
  assert.deepEqual(validateEmployeeCode("HRP-2026-000001", "2026-10-15"), []);
  assert.deepEqual(validateEmployeeCode("hrp-2026-ABC", "2026-10-15")[0], {
    code: "EMPLOYEE_CODE_FORMAT",
    path: "employee_code",
  });
  assert.equal(validateEmployeeCode("hrp-2025-000001", "2026-10-15")[0].code, "EMPLOYEE_CODE_YEAR");
  assert.equal(validateEmployeeCode("hrp-2026-000001", "2026-10-15", ["HRP-2026-000001"])[0].code,
    "EMPLOYEE_CODE_DUPLICATE");
  assert.equal(validateEmployeeCode("hrp-2026-000001", "2026-02-30")[0].code, "EMPLOYEE_CODE_YEAR");
});

test("tri-state worker/payment fields distinguish omitted, unknown, and intentionally blank", () => {
  assert.equal(validateEntry({ entry, ...validationContext }).ok, true);
  assert.equal(validatePaymentDetails({ state: "unknown" }, fixture.banks).length, 0);
  assert.equal(validatePaymentDetails({ state: "intentionally_blank" }, fixture.banks).length, 0);
  assert.equal(validatePaymentDetails({
    state: "provided",
    value: {
      account_number: "0000123400",
      bank_id: "bank_synthetic_a",
      account_holder_name: "Synthetic Holder",
    },
  }, fixture.banks).length, 0);
  assert.equal(validatePaymentDetails({
    state: "provided",
    value: {
      account_number: "0000123400",
      bank_id: "bank_not_in_master",
      account_holder_name: "Synthetic Holder",
    },
  }, fixture.banks)[0].code, "PAYMENT_DETAILS_INVALID");
});

test("submission review can return to draft; submitted rows are locked for ordinary editing", () => {
  const review = transitionSubmission(fixture.submission, "BEGIN_REVIEW", 1);
  assert.equal(review.state, "REVIEW");
  const draft = transitionSubmission(review, "RETURN_TO_DRAFT", review.version);
  assert.equal(draft.state, "DRAFT");
  const secondReview = transitionSubmission(draft, "BEGIN_REVIEW", draft.version);
  const submitted = transitionSubmission(secondReview, "SUBMIT", secondReview.version);
  assert.equal(submitted.state, "SUBMITTED");
  assert.equal(canEditRows(submitted.state), false);
  assert.equal(transitionSubmission(submitted, "RETURN_TO_DRAFT", submitted.version), null);
});

test("pending change request leaves canonical entry untouched; approval applies atomically", () => {
  const proposedLabor = {
    target: "ENTRY_FIELD",
    row_id: entry.entry_id,
    field: "labor_type",
    proposed_value: "PERMANENT",
    expected_version: entry.version,
  };
  const pending = changeRequest([proposedLabor]);
  assert.equal(pending.status, "PENDING");
  assert.deepEqual(entry, fixture.entry);

  const approved = decideChangeRequest({
    entries: [entry],
    request: pending,
    decision: "APPROVE",
    reviewer_id: "accounting_synthetic_01",
    capabilities: ["change_review"],
    reason: "Synthetic approval",
    timestamp,
    validation_context: validationContext,
  });
  assert.equal(approved.entries[0].labor_type, "PERMANENT");
  assert.equal(approved.entries[0].version, 2);
  assert.equal(approved.request.status, "APPROVED");
  assert.equal(approved.revisions[0].before.labor_type, "TEMPORARY");
  assert.equal(approved.revisions[0].after.labor_type, "PERMANENT");
  assert.equal(approved.audit[0].actor_id, "accounting_synthetic_01");
  assert.equal(approved.audit[0].reason, "Synthetic approval");
});

test("rejected and stale multi-row changes do not mutate any canonical entry", () => {
  const second = {
    ...structuredClone(entry),
    entry_id: "00000000-0000-4000-8000-0000000000a2",
    candidate_id: "00000000-0000-4000-8000-0000000000b2",
    employee_code: "hrp-2026-000002",
  };
  const request = changeRequest([
    {
      target: "ENTRY_FIELD",
      row_id: entry.entry_id,
      field: "labor_type",
      proposed_value: "PERMANENT",
      expected_version: entry.version,
    },
    {
      target: "ENTRY_FIELD",
      row_id: second.entry_id,
      field: "project_id",
      proposed_value: "project_synthetic_a",
      expected_version: 99,
    },
  ]);
  const before = structuredClone([entry, second]);
  assert.equal(decideChangeRequest({
    entries: before,
    request,
    decision: "APPROVE",
    reviewer_id: "accounting_synthetic_01",
    capabilities: ["change_review"],
    reason: "Stale request",
    timestamp,
    validation_context: validationContext,
  }), null);
  assert.deepEqual(before, [entry, second]);

  const rejected = decideChangeRequest({
    entries: [entry],
    request: changeRequest([{
      target: "ENTRY_FIELD",
      row_id: entry.entry_id,
      field: "labor_type",
      proposed_value: "PERMANENT",
      expected_version: entry.version,
    }]),
    decision: "REJECT",
    reviewer_id: "admin_synthetic_01",
    capabilities: ["change_review"],
    reason: "Synthetic rejection",
    timestamp,
    validation_context: validationContext,
  });
  assert.deepEqual(rejected.entries, [entry]);
  assert.equal(rejected.request.status, "REJECTED");
});

test("privileged direct edit requires capability/reason and writes revision plus audit", () => {
  const denied = applyPrivilegedDirectEdit({
    entries: [entry],
    row_id: entry.entry_id,
    patch: { payment: { state: "unknown" } },
    expected_version: entry.version,
    actor_id: "admin_synthetic_01",
    capabilities: [],
    reason: "Synthetic direct edit",
    timestamp,
    submission_state: "SUBMITTED",
    validation_context: validationContext,
  });
  assert.equal(denied, null);
  const missingReason = applyPrivilegedDirectEdit({
    entries: [entry],
    row_id: entry.entry_id,
    patch: { payment: { state: "unknown" } },
    expected_version: entry.version,
    actor_id: "accounting_synthetic_01",
    capabilities: ["entry_privileged_edit"],
    reason: " ",
    timestamp,
    submission_state: "SUBMITTED",
    validation_context: validationContext,
  });
  assert.equal(missingReason, null);
  const result = applyPrivilegedDirectEdit({
    entries: [entry],
    row_id: entry.entry_id,
    patch: {
      payment: {
        state: "provided",
        value: {
          account_number: "0000123400",
          bank_id: "bank_synthetic_a",
          account_holder_name: "Synthetic Holder",
        },
      },
    },
    expected_version: entry.version,
    actor_id: "accounting_synthetic_01",
    capabilities: ["entry_privileged_edit"],
    reason: "Synthetic payment details added",
    timestamp,
    submission_state: "SUBMITTED",
    validation_context: validationContext,
  });
  assert.equal(result.entries[0].version, 2);
  assert.equal(result.revision.before.payment.state, "omitted");
  assert.equal(result.revision.after.payment.value.account_number, "0000123400");
  assert.equal(result.audit.outcome, "APPLIED");
  assert.equal(result.audit.reason, "Synthetic payment details added");
});

test("OFF requires a leave date and textarea reason; history derives and corrects current status", () => {
  assert.equal(validateStatusProposal({
    event_id: "status_synthetic_off_bad",
    status: "OFF",
    effective_date: "2026-11-01",
    leave_date: null,
    leave_reason_text: "",
  })[0].code, "OFF_REQUIRES_DATE_AND_REASON");
  const onEvents = appendStatusEvent({
    events: entry.employment_events,
    proposal: {
      event_id: "status_synthetic_on",
      status: "ON",
      effective_date: "2026-10-16",
      leave_date: null,
      leave_reason_text: null,
    },
    actor_id: "accounting_synthetic_01",
    reason: "Synthetic confirmation",
    applied_at: timestamp,
  });
  assert.equal(deriveCurrentStatus(onEvents), "ON");
  const offEvents = appendStatusEvent({
    events: onEvents,
    proposal: {
      event_id: "status_synthetic_off",
      status: "OFF",
      effective_date: "2026-11-01",
      leave_date: "2026-11-01",
      leave_reason_text: "Synthetic leave reason",
    },
    actor_id: "accounting_synthetic_01",
    reason: "Synthetic status change",
    applied_at: timestamp,
  });
  assert.equal(deriveCurrentStatus(offEvents), "OFF");
  const returned = appendStatusEvent({
    events: offEvents,
    proposal: {
      event_id: "status_synthetic_return",
      status: "ON",
      effective_date: "2026-12-01",
      leave_date: null,
      leave_reason_text: null,
    },
    actor_id: "accounting_synthetic_01",
    reason: "Synthetic return to work",
    applied_at: timestamp,
  });
  assert.equal(deriveCurrentStatus(returned), "ON");
  assert.equal(returned.find((event) => event.status === "OFF").leave_reason_text, "Synthetic leave reason");
  const corrected = correctLatestStatusEvent({
    events: offEvents,
    event_id: "status_synthetic_off",
    replacement: {
      event_id: "status_synthetic_off_corrected",
      status: "ON",
      effective_date: "2026-11-01",
      leave_date: null,
      leave_reason_text: null,
    },
    actor_id: "admin_synthetic_01",
    reason: "Correct synthetic status entry",
    applied_at: timestamp,
  });
  assert.equal(deriveCurrentStatus(corrected), "ON");
  assert.ok(corrected.some((event) => event.event_id === "status_synthetic_off"));
});

test("pending employment status request does not change current status before approval", () => {
  const pending = changeRequest([{
    target: "WORK_STATUS",
    row_id: entry.entry_id,
    event: {
      event_id: "status_synthetic_pending_on",
      status: "ON",
      effective_date: "2026-10-16",
      leave_date: null,
      leave_reason_text: null,
    },
    expected_version: entry.version,
  }]);
  assert.equal(deriveCurrentStatus(entry.employment_events), "UNCONFIRMED");
  const result = decideChangeRequest({
    entries: [entry],
    request: pending,
    decision: "APPROVE",
    reviewer_id: "accounting_synthetic_01",
    capabilities: ["change_review"],
    reason: "Synthetic status approval",
    timestamp,
    validation_context: validationContext,
  });
  assert.equal(deriveCurrentStatus(result.entries[0].employment_events), "ON");
});

test("document retries are idempotent, replacements append versions, and storage keys omit raw IDs", () => {
  const first = createDocumentVersion({ existing: [], ...requiredDocument });
  assert.equal(first.version, 1);
  assert.equal(first.upload_status, "QUEUED");
  assert.equal(createDocumentVersion({ existing: [first], ...requiredDocument }), first);
  assert.equal(createDocumentVersion({
    existing: [first],
    ...requiredDocument,
    checksum_sha256: "b".repeat(64),
  }), null);
  const readyFirst = readyDocument(first);
  const replacement = createDocumentVersion({
    existing: [first],
    ...requiredDocument,
    idempotency_key: "upload_synthetic_02",
    checksum_sha256: "b".repeat(64),
  });
  const readyReplacement = readyDocument(replacement);
  assert.equal(readyReplacement.version, 2);
  assert.equal(readyReplacement.supersedes_version, 1);
  assert.equal(readyReplacement.storage_key.includes("SYNTHETIC-ID-0000"), false);
  assert.equal(readyReplacement.storage_key.includes(entry.candidate_id), true);

  const pending = changeRequest([{
    target: "DOCUMENT",
    row_id: entry.entry_id,
    document: readyReplacement,
    expected_version: entry.version,
  }]);
  assert.deepEqual(entry.documents, []);
  const applied = decideChangeRequest({
    entries: [{ ...entry, documents: [readyFirst] }],
    request: pending,
    decision: "APPROVE",
    reviewer_id: "admin_synthetic_01",
    capabilities: ["change_review"],
    reason: "Synthetic document replacement approval",
    timestamp,
    validation_context: validationContext,
  });
  assert.equal(applied.entries[0].documents.length, 2);
  assert.equal(applied.entries[0].documents[0].upload_status, "SUPERSEDED");
  assert.equal(applied.entries[0].documents[1].version, 2);
});

test("document type, size ceiling, checksum, quarantine/scan/retry states fail closed", () => {
  assert.equal(createDocumentVersion({
    existing: [],
    ...requiredDocument,
    size_bytes: 10 * 1024 * 1024 + 1,
  }), null);
  assert.equal(createDocumentVersion({
    existing: [],
    ...requiredDocument,
    mime_type: "application/x-executable",
  }), null);
  assert.equal(createDocumentVersion({
    existing: [],
    ...requiredDocument,
    checksum_sha256: "not-a-checksum",
  }), null);
  const queued = createDocumentVersion({ existing: [], ...requiredDocument });
  const uploading = transitionDocumentUpload(queued, "START");
  const quarantined = transitionDocumentUpload(uploading, "QUARANTINE");
  const scanning = transitionDocumentUpload(quarantined, "SCAN");
  const failed = transitionDocumentUpload(scanning, "SCAN_REJECT");
  const retry = transitionDocumentUpload(failed, "RETRY");
  assert.equal(retry.upload_status, "QUEUED");
  assert.equal(retry.scan_status, "REJECTED");
  assert.equal(retry.attempts, 1);
});

test("duplicate employee codes in an approved patch abort the entire request", () => {
  const second = {
    ...structuredClone(entry),
    entry_id: "00000000-0000-4000-8000-0000000000a2",
    candidate_id: "00000000-0000-4000-8000-0000000000b2",
    employee_code: "hrp-2026-000002",
  };
  const request = changeRequest([{
    target: "ENTRY_FIELD",
    row_id: second.entry_id,
    field: "employee_code",
    proposed_value: "hrp-2026-000001",
    expected_version: second.version,
  }]);
  const rejected = decideChangeRequest({
    entries: [entry, second],
    request,
    decision: "APPROVE",
    reviewer_id: "admin_synthetic_01",
    capabilities: ["change_review"],
    reason: "Duplicate must not apply",
    timestamp,
    validation_context: validationContext,
  });
  assert.equal(rejected, null);
  assert.equal(second.employee_code, "hrp-2026-000002");
});

test("fixture and derived storage names contain no real personal data", () => {
  const serialized = JSON.stringify(fixture);
  assert.match(serialized, /synthetic/i);
  assert.doesNotMatch(serialized, /\b\d{9,12}\b/);
});
