import assert from "node:assert/strict";
import test from "node:test";

import {
  OFFBOARDING_HIDE_REASON_MAX_LENGTH,
  newOffboardingHideIntentKey,
  parseOffboardingHideRequest,
  parseOffboardingHideResult,
  parseOffboardingReportExport,
  parseOffboardingReportList,
} from "./offboarding-report-contract.ts";

const SNAPSHOT_ENTRY_ID = "20000000-0000-4000-8000-000000000001";
const SNAPSHOT_EVENT_ID = "30000000-0000-4000-8000-000000000001";
const SUPPRESSION_ID = "40000000-0000-4000-8000-000000000001";

const baseItem = {
  employee_code: "hrp-2026-000001",
  display_name: "Nguyễn Văn A",
  project_id: "project-a",
  project_display: "Dự án A",
  recruiter_id: "10000000-0000-4000-8000-000000000001",
  recruiter_display: "Người tuyển A",
  off_effective_date: "2026-10-20",
  days_since_off: 4,
  phone: "0912345678",
};

const hideableItem = {
  ...baseItem,
  snapshot_entry_id: SNAPSHOT_ENTRY_ID,
  snapshot_status_event_id: SNAPSHOT_EVENT_ID,
};

test("offboarding RPC projectors accept phone as string, null, or undefined and fix the 8-row DB TEST 503 payload", () => {
  // Exact pre-migration DB TEST shape: 8 rows where SQL emits `phone: null` for omitted phones
  const eightRowDbTestPayload = {
    scope: "all",
    authority: "admin",
    can_export: true,
    authorization_date: "2026-10-24",
    page: 1,
    page_size: 25,
    total: 8,
    has_more: false,
    items: Array.from({ length: 8 }, (_, idx) => ({
      ...baseItem,
      employee_code: `hrp-2026-00000${idx + 1}`,
      phone: idx % 2 === 0 ? null : `091234567${idx}`,
    })),
  };

  const parsedPreMigration = parseOffboardingReportList(eightRowDbTestPayload);
  assert.ok(parsedPreMigration !== null, "8-row payload with phone: null must be accepted");
  assert.equal(parsedPreMigration.can_hide, false);
  assert.equal(parsedPreMigration.items.length, 8);
  assert.equal(parsedPreMigration.items[0].phone, null);
  assert.equal(parsedPreMigration.items[1].phone, "0912345671");

  // Post-migration Admin/BoD list payload with can_hide: true and snapshot refs
  const postMigrationList = {
    ...eightRowDbTestPayload,
    can_hide: true,
    items: eightRowDbTestPayload.items.map((row, idx) => ({
      ...row,
      snapshot_entry_id: `20000000-0000-4000-8000-${String(idx + 1).padStart(12, "0")}`,
      snapshot_status_event_id: `30000000-0000-4000-8000-${String(idx + 1).padStart(12, "0")}`,
    })),
  };
  assert.deepEqual(parseOffboardingReportList(postMigrationList), postMigrationList);

  // Undefined phone is also accepted when omitted
  const withoutPhone = Object.fromEntries(
    Object.entries(baseItem).filter(([key]) => key !== "phone"),
  );
  const listWithoutPhone = {
    scope: "all",
    authority: "bod",
    can_export: true,
    can_hide: false,
    authorization_date: "2026-10-24",
    page: 1,
    page_size: 25,
    total: 1,
    has_more: false,
    items: [withoutPhone],
  };
  assert.deepEqual(parseOffboardingReportList(listWithoutPhone), listWithoutPhone);

  // Export payload accepts both phone: string and phone: null
  const exported = {
    authorization_date: "2026-10-24",
    items: [baseItem, { ...baseItem, employee_code: "hrp-2026-000002", phone: null }],
  };
  assert.deepEqual(parseOffboardingReportExport(exported), exported);

  // Malformed phone shapes stay fail-closed
  for (const invalidPhone of [123, false, true, {}, ["0912345678"]]) {
    assert.equal(
      parseOffboardingReportList({
        ...postMigrationList,
        total: 1,
        items: [{ ...hideableItem, phone: invalidPhone }],
      }),
      null,
    );
    assert.equal(
      parseOffboardingReportExport({
        authorization_date: "2026-10-24",
        items: [{ ...baseItem, phone: invalidPhone }],
      }),
      null,
    );
  }
});

test("offboarding projectors enforce scope invariants, snapshot ref pairing, API envelope rejection, and zero CCCD keys", () => {
  const validAdminList = {
    scope: "all",
    authority: "admin",
    can_export: true,
    can_hide: true,
    authorization_date: "2026-10-24",
    page: 1,
    page_size: 25,
    total: 1,
    has_more: false,
    items: [hideableItem],
  };

  // Reject API envelopes and sub-threshold days_since_off
  assert.equal(parseOffboardingReportList({ ok: true, data: validAdminList }), null);
  assert.equal(
    parseOffboardingReportList({
      ...validAdminList,
      items: [{ ...hideableItem, days_since_off: 2 }],
    }),
    null,
  );
  assert.equal(
    parseOffboardingReportExport({
      ok: true,
      data: { authorization_date: "2026-10-24", items: [baseItem] },
    }),
    null,
  );

  // When can_hide is true, snapshot_entry_id & snapshot_status_event_id are mandatory valid UUIDs
  assert.equal(
    parseOffboardingReportList({
      ...validAdminList,
      items: [baseItem],
    }),
    null,
  );
  assert.equal(
    parseOffboardingReportList({
      ...validAdminList,
      items: [{ ...baseItem, snapshot_entry_id: SNAPSHOT_ENTRY_ID }],
    }),
    null,
  );

  // Team leader scope: can_hide must be false, can_export must be false, no phone, no snapshot refs
  const teamItem = Object.fromEntries(
    Object.entries(baseItem).filter(([key]) => key !== "phone"),
  );
  const validTeamList = {
    scope: "team",
    authority: "team_leader",
    can_export: false,
    can_hide: false,
    authorization_date: "2026-10-24",
    page: 1,
    page_size: 25,
    total: 1,
    has_more: false,
    items: [teamItem],
  };
  assert.deepEqual(parseOffboardingReportList(validTeamList), validTeamList);
  assert.equal(parseOffboardingReportList({ ...validTeamList, can_hide: true }), null);
  assert.equal(parseOffboardingReportList({ ...validTeamList, can_export: true }), null);
  assert.equal(
    parseOffboardingReportList({
      ...validTeamList,
      items: [{ ...teamItem, phone: null }],
    }),
    null,
  );
  assert.equal(
    parseOffboardingReportList({
      ...validTeamList,
      items: [
        {
          ...teamItem,
          snapshot_entry_id: SNAPSHOT_ENTRY_ID,
          snapshot_status_event_id: SNAPSHOT_EVENT_ID,
        },
      ],
    }),
    null,
  );

  // Export items must never include internal snapshot refs or CCCD keys
  assert.equal(
    parseOffboardingReportExport({
      authorization_date: "2026-10-24",
      items: [hideableItem],
    }),
    null,
  );

  for (const forbiddenKey of [
    "cccd",
    "cccd_last4",
    "cccd_hash",
    "national_id",
    "snapshot_signature",
  ]) {
    assert.equal(
      parseOffboardingReportList({
        ...validAdminList,
        items: [{ ...hideableItem, [forbiddenKey]: "001099000123" }],
      }),
      null,
      `list item must reject ${forbiddenKey}`,
    );
    assert.equal(
      parseOffboardingReportExport({
        authorization_date: "2026-10-24",
        items: [{ ...baseItem, [forbiddenKey]: "001099000123" }],
      }),
      null,
      `export item must reject ${forbiddenKey}`,
    );
  }
});

test("offboarding hide request and result parsers enforce trimmed reason bounds, idempotency keys, and zero unexpected fields", () => {
  const intentKey = newOffboardingHideIntentKey();
  assert.match(intentKey, /^[0-9a-f-]{36}$/i);

  const parsed = parseOffboardingHideRequest(
    {
      snapshot_entry_id: `  ${SNAPSHOT_ENTRY_ID.toUpperCase()}  `,
      snapshot_status_event_id: SNAPSHOT_EVENT_ID.toUpperCase(),
      reason: "  Đã về quê, quá tuổi bố trí dự án mới  ",
    },
    intentKey,
  );
  assert.deepEqual(parsed, {
    snapshot_entry_id: SNAPSHOT_ENTRY_ID,
    snapshot_status_event_id: SNAPSHOT_EVENT_ID,
    reason: "Đã về quê, quá tuổi bố trí dự án mới",
    idempotency_key: intentKey,
  });

  // Exact 1-char and 500-char trimmed reasons succeed
  assert.equal(
    parseOffboardingHideRequest({
      snapshot_entry_id: SNAPSHOT_ENTRY_ID,
      snapshot_status_event_id: SNAPSHOT_EVENT_ID,
      reason: "   A   ",
      idempotency_key: intentKey,
    })?.reason,
    "A",
  );
  assert.equal(
    parseOffboardingHideRequest({
      snapshot_entry_id: SNAPSHOT_ENTRY_ID,
      snapshot_status_event_id: SNAPSHOT_EVENT_ID,
      reason: `  ${"x".repeat(OFFBOARDING_HIDE_REASON_MAX_LENGTH)}  `,
      idempotency_key: intentKey,
    })?.reason.length,
    OFFBOARDING_HIDE_REASON_MAX_LENGTH,
  );

  // Invalid reasons, mismatched idempotency keys, and unexpected/CCCD keys fail closed
  for (const invalidCase of [
    [{ reason: "   " }, intentKey],
    [{ reason: "x".repeat(OFFBOARDING_HIDE_REASON_MAX_LENGTH + 1) }, intentKey],
    [{ reason: "Lý do\u0000ẩn" }, intentKey],
    [{ reason: "Lý do\u0007ẩn" }, intentKey],
    [{ reason: "Lý do hợp lệ", idempotency_key: "short" }, undefined],
    [{ reason: "Lý do hợp lệ", idempotency_key: "key-body-12345" }, "key-header-99999"],
    [{ reason: "Lý do hợp lệ", idempotency_key: intentKey, cccd: "001099000123" }, undefined],
  ]) {
    const [overrides, headerKey] = invalidCase;
    assert.equal(
      parseOffboardingHideRequest(
        {
          snapshot_entry_id: SNAPSHOT_ENTRY_ID,
          snapshot_status_event_id: SNAPSHOT_EVENT_ID,
          ...overrides,
        },
        headerKey,
      ),
      null,
    );
  }

  const validResult = {
    suppression_id: SUPPRESSION_ID.toUpperCase(),
    snapshot_entry_id: SNAPSHOT_ENTRY_ID.toUpperCase(),
    snapshot_status_event_id: SNAPSHOT_EVENT_ID.toUpperCase(),
    hidden_at: "2026-10-24T08:00:00.000Z",
    replayed: false,
  };
  assert.deepEqual(parseOffboardingHideResult(validResult), {
    suppression_id: SUPPRESSION_ID,
    snapshot_entry_id: SNAPSHOT_ENTRY_ID,
    snapshot_status_event_id: SNAPSHOT_EVENT_ID,
    hidden_at: "2026-10-24T08:00:00.000Z",
    replayed: false,
  });
  assert.equal(parseOffboardingHideResult({ ...validResult, cccd: "001099000123" }), null);
  assert.equal(parseOffboardingHideResult({ ...validResult, reason: "leaked" }), null);
});
