import assert from "node:assert/strict";
import test from "node:test";

import {
  NATIONAL_ID_DIGIT_LENGTHS,
  NATIONAL_ID_RULE_MESSAGE,
  canonicalNationalIdDigits,
  isCanonicalNationalId,
} from "./national-id.ts";
import { validateWorkerDetails } from "./direct-entry-v1.ts";

function worker(nationalId) {
  return {
    display_name: "R2 Worker",
    date_of_birth: { state: "provided", value: "1990-01-01" },
    national_id: nationalId,
    address: { state: "provided", value: "R2 address" },
    phone: { state: "provided", value: "0900000000" },
  };
}

test("P2.5-HF-R2: exactly one canonical CMT/CCCD rule", () => {
  assert.deepEqual(NATIONAL_ID_DIGIT_LENGTHS, [9, 12]);
  assert.equal(NATIONAL_ID_RULE_MESSAGE, "CMT/CCCD phải gồm đúng 9 hoặc 12 chữ số.");
  for (const value of ["012345678", "012345678901", "123456789", "123456789012"]) {
    assert.equal(isCanonicalNationalId(value), true, value);
  }
  for (const value of [
    "0123 456 78901", "012.345.678", "012-345-678901", "NOT-REAL", "12345678",
    "1234567890", "1234567890123", " 012345678", "012345678 ", "", "0000000000000",
    "01234567890a", "٠١٢٣٤٥٦٧٨٩", 123456789, null, undefined,
  ]) {
    assert.equal(isCanonicalNationalId(value), false, JSON.stringify(value));
  }
  // Digits-only reading keeps the leading zero and never invents a person.
  assert.equal(canonicalNationalIdDigits("0123 456 78901"), "012345678901");
  assert.equal(canonicalNationalIdDigits("012345678"), "012345678");
  assert.equal(canonicalNationalIdDigits("NOT-REAL"), null);
  assert.equal(canonicalNationalIdDigits(""), null);
  assert.equal(canonicalNationalIdDigits(null), null);
});

test("P2.5-HF-R2: the legacy write contract refuses malformed CMT/CCCD", () => {
  for (const bad of ["0123 456 78901", "012.345.678", "NOT-REAL", "12345678",
    "1234567890123", " 012345678 ", "01234567890a"]) {
    assert.deepEqual(validateWorkerDetails(worker({ state: "provided", value: bad })),
      [{ code: "WORKER_DETAILS_INVALID", path: "worker" }], bad);
  }
  for (const good of ["012345678", "012345678901"]) {
    assert.deepEqual(validateWorkerDetails(worker({ state: "provided", value: good })), [], good);
  }
  assert.deepEqual(validateWorkerDetails(worker({ state: "omitted" })), []);
  assert.deepEqual(validateWorkerDetails(worker({ state: "unknown" })), []);
});
