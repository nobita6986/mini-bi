import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCccdQrFieldMergePreview,
  CCCD_QR_AUTHENTICITY,
  CCCD_QR_SOURCE,
  isBlankWorkerDetailField,
  parseCccdQrPayload,
  parseCccdQrProcessRequest,
} from "./cccd-qr-contract.ts";

const REFERENCE_DATE = "2026-10-25";

test("parseCccdQrPayload parses official 7-field Vietnamese chip-based CCCD QR payload with 9-digit CMND", () => {
  const raw =
    "079095001234|025123456|Nguyễn Văn An|15081995|Nam|123 Nguyễn Trãi, Phường Bến Thành, Quận 1, TP. Hồ Chí Minh|20102021";
  const result = parseCccdQrPayload(raw, { referenceDateIso: REFERENCE_DATE });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.data, {
    source: CCCD_QR_SOURCE,
    authenticity: CCCD_QR_AUTHENTICITY,
    national_id: "079095001234",
    legacy_national_id: "025123456",
    display_name: "Nguyễn Văn An",
    date_of_birth: "15/08/1995",
    date_of_birth_iso: "1995-08-15",
    gender: "MALE",
    gender_label: "Nam",
    address: "123 Nguyễn Trãi, Phường Bến Thành, Quận 1, TP. Hồ Chí Minh",
    national_id_issued_at: "20/10/2021",
    national_id_issued_at_iso: "2021-10-20",
  });
});

test("parseCccdQrPayload parses 7-field CCCD QR payload with empty legacy CMND, female/other genders, and slash dates", () => {
  const femaleRaw =
    "001198005678||Trần Thị Bích Ngọc|29/02/1996|Nữ|Thôn 2, Xã Hòa Tiến, Huyện Hòa Vang, Đà Nẵng|05/05/2022|\r\n";
  const femaleResult = parseCccdQrPayload(femaleRaw, { referenceDateIso: REFERENCE_DATE });

  assert.equal(femaleResult.ok, true);
  if (!femaleResult.ok) return;
  assert.equal(femaleResult.data.national_id, "001198005678");
  assert.equal(femaleResult.data.legacy_national_id, null);
  assert.equal(femaleResult.data.display_name, "Trần Thị Bích Ngọc");
  assert.equal(femaleResult.data.date_of_birth, "29/02/1996");
  assert.equal(femaleResult.data.date_of_birth_iso, "1996-02-29");
  assert.equal(femaleResult.data.gender, "FEMALE");
  assert.equal(femaleResult.data.gender_label, "Nữ");
  assert.equal(femaleResult.data.national_id_issued_at, "05/05/2022");
  assert.equal(femaleResult.data.national_id_issued_at_iso, "2022-05-05");
  assert.equal(femaleResult.data.authenticity, "UNVERIFIED_QR_TEXT");

  const otherRaw =
    "048099004321||Lê Minh Khôi|01011999|Khac|Quận Hải Châu, Đà Nẵng|10012023";
  const otherResult = parseCccdQrPayload(otherRaw, { referenceDateIso: REFERENCE_DATE });
  assert.equal(otherResult.ok, true);
  if (!otherResult.ok) return;
  assert.equal(otherResult.data.gender, "OTHER");
  assert.equal(otherResult.data.gender_label, "Khác");
});

test("parseCccdQrPayload rejects malformed structure, invalid fields, and never leaks PII in error objects", () => {
  const cases = [
    {
      input: null,
      error_code: "QR_PAYLOAD_EMPTY",
      error_field: "payload",
    },
    {
      input: "   \r\n",
      error_code: "QR_PAYLOAD_EMPTY",
      error_field: "payload",
    },
    {
      input: "079095001234|025123456|Nguyễn Văn An|15081995|Nam|TP.HCM",
      error_code: "QR_FIELD_MISSING",
      error_field: "payload",
    },
    {
      input: "079095001234|025123456|Nguyễn Văn An|15081995|Nam|TP.HCM|20102021|EXTRA",
      error_code: "QR_FORMAT_INVALID",
      error_field: "payload",
    },
    {
      input: "079095001234|025123456|Nguyễn\u0000Văn An|15081995|Nam|TP.HCM|20102021",
      error_code: "QR_FORMAT_INVALID",
      error_field: "payload",
    },
    {
      input: "07909500123|025123456|Nguyễn Văn An|15081995|Nam|TP.HCM|20102021",
      error_code: "QR_NATIONAL_ID_INVALID",
      error_field: "national_id",
    },
    {
      input: "000000000000|025123456|Nguyễn Văn An|15081995|Nam|TP.HCM|20102021",
      error_code: "QR_NATIONAL_ID_INVALID",
      error_field: "national_id",
    },
    {
      input: "079095001234|12345|Nguyễn Văn An|15081995|Nam|TP.HCM|20102021",
      error_code: "QR_LEGACY_ID_INVALID",
      error_field: "legacy_national_id",
    },
    {
      input: "079095001234|000000000|Nguyễn Văn An|15081995|Nam|TP.HCM|20102021",
      error_code: "QR_LEGACY_ID_INVALID",
      error_field: "legacy_national_id",
    },
    {
      input: "079095001234|025123456|=CMD()|15081995|Nam|TP.HCM|20102021",
      error_code: "QR_NAME_INVALID",
      error_field: "display_name",
    },
    {
      input: "079095001234|025123456|123456|15081995|Nam|TP.HCM|20102021",
      error_code: "QR_NAME_INVALID",
      error_field: "display_name",
    },
    {
      input: "079095001234|025123456|Nguyễn Văn An|31021995|Nam|TP.HCM|20102021",
      error_code: "QR_DOB_INVALID",
      error_field: "date_of_birth",
    },
    {
      input: "079095001234|025123456|Nguyễn Văn An|26102026|Nam|TP.HCM|20102021",
      error_code: "QR_DOB_INVALID",
      error_field: "date_of_birth",
    },
    {
      input: "079095001234|025123456|Nguyễn Văn An|15081995|UnknownGender|TP.HCM|20102021",
      error_code: "QR_GENDER_INVALID",
      error_field: "gender",
    },
    {
      input: "079095001234|025123456|Nguyễn Văn An|15081995|Nam|   |20102021",
      error_code: "QR_ADDRESS_INVALID",
      error_field: "address",
    },
    {
      input: "079095001234|025123456|Nguyễn Văn An|15081995|Nam|@SUM(1,2)|20102021",
      error_code: "QR_ADDRESS_INVALID",
      error_field: "address",
    },
    {
      input: "079095001234|025123456|Nguyễn Văn An|15081995|Nam|TP.HCM|14081995",
      error_code: "QR_ISSUE_DATE_INVALID",
      error_field: "national_id_issued_at",
    },
    {
      input: "079095001234|025123456|Nguyễn Văn An|15081995|Nam|TP.HCM|26102026",
      error_code: "QR_ISSUE_DATE_INVALID",
      error_field: "national_id_issued_at",
    },
  ];

  for (const tc of cases) {
    const result = parseCccdQrPayload(tc.input, { referenceDateIso: REFERENCE_DATE });
    assert.equal(result.ok, false, `Expected failure for input: ${String(tc.input)}`);
    if (result.ok) continue;
    assert.equal(result.error_code, tc.error_code);
    assert.equal(result.error_field, tc.error_field);

    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes("079095001234"), "Error object must never leak CCCD digits");
    assert.ok(!serialized.includes("025123456"), "Error object must never leak CMND digits");
    assert.ok(!serialized.includes("Nguyễn Văn An"), "Error object must never leak full name");
    assert.ok(!serialized.includes("TP.HCM"), "Error object must never leak address");
  }
});

test("buildCccdQrFieldMergePreview classifies blank vs existing worker_details fields without touching display_name", () => {
  assert.equal(isBlankWorkerDetailField(undefined), true);
  assert.equal(isBlankWorkerDetailField({ state: "omitted" }), true);
  assert.equal(isBlankWorkerDetailField({ state: "unknown" }), true);
  assert.equal(isBlankWorkerDetailField({ state: "intentionally_blank" }), false);
  assert.equal(isBlankWorkerDetailField({ state: "provided", value: "079095001234" }), false);

  const workerDetails = {
    display_name: "Người Lao Động Đã Nhập",
    national_id: { state: "provided", value: "079095009999" },
    date_of_birth: { state: "omitted" },
    gender: { state: "intentionally_blank" },
    address: { state: "unknown" },
  };

  const previewBeforeApply = buildCccdQrFieldMergePreview(workerDetails, []);
  assert.deepEqual(previewBeforeApply, {
    display_name: "kept_existing",
    national_id: "kept_existing",
    date_of_birth: "eligible_blank",
    gender: "kept_existing",
    address: "eligible_blank",
    national_id_issued_at: "eligible_blank",
  });

  const previewAfterApply = buildCccdQrFieldMergePreview(workerDetails, [
    "date_of_birth",
    "address",
    "national_id_issued_at",
  ]);
  assert.deepEqual(previewAfterApply, {
    display_name: "kept_existing",
    national_id: "kept_existing",
    date_of_birth: "applied_to_blank",
    gender: "kept_existing",
    address: "applied_to_blank",
    national_id_issued_at: "applied_to_blank",
  });
});

test("parseCccdQrProcessRequest validates process/retry request payload and requires expected_entry_version when applying blank fields", () => {
  const emptyParsed = parseCccdQrProcessRequest({});
  assert.deepEqual(emptyParsed, {
    ok: true,
    value: {
      document_id: null,
      document_type: null,
      apply_blank_fields: false,
      expected_entry_version: null,
    },
  });

  const validApply = parseCccdQrProcessRequest({
    document_id: "00000000-0000-4000-8000-000000000123",
    document_type: "CCCD_FRONT",
    apply_blank_fields: true,
    expected_entry_version: 3,
  });
  assert.deepEqual(validApply, {
    ok: true,
    value: {
      document_id: "00000000-0000-4000-8000-000000000123",
      document_type: "CCCD_FRONT",
      apply_blank_fields: true,
      expected_entry_version: 3,
    },
  });

  assert.deepEqual(
    parseCccdQrProcessRequest({
      apply_blank_fields: true,
    }),
    {
      ok: false,
      code: "EXPECTED_ENTRY_VERSION_REQUIRED",
    },
  );

  assert.deepEqual(
    parseCccdQrProcessRequest({
      document_id: "not-a-uuid",
    }),
    {
      ok: false,
      code: "DOCUMENT_ID_INVALID",
    },
  );

  assert.deepEqual(
    parseCccdQrProcessRequest({
      document_type: "WORKER_PORTRAIT",
    }),
    {
      ok: false,
      code: "DOCUMENT_TYPE_INVALID",
    },
  );

  assert.deepEqual(
    parseCccdQrProcessRequest({
      unknown_field: true,
    }),
    {
      ok: false,
      code: "CCCD_QR_REQUEST_INVALID",
    },
  );
});
