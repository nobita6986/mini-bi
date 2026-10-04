import assert from "node:assert/strict";
import test from "node:test";

import {
  PAYMENT_STATES,
  projectPaymentInput,
  projectPaymentProjection,
  projectPaymentUpdateResult,
  projectAccountMetadataInput,
} from "./payment-contract.ts";

const activeBanks = new Set(["bank_synthetic"]);

test("accepts all four payment states with explicit null non-provided fields", () => {
  assert.deepEqual(PAYMENT_STATES, [
    "omitted", "unknown", "intentionally_blank", "provided",
  ]);
  for (const state of PAYMENT_STATES.slice(0, 3)) {
    assert.deepEqual(projectPaymentInput({
      state,
      account_number: null,
      bank_id: null,
      account_holder_name: null,
    }, activeBanks), {
      state,
      account_number: null,
      bank_id: null,
      account_holder_name: null,
    });
  }
});

test("provided account stays a string including leading zeroes and requires every field", () => {
  const input = {
    state: "provided",
    account_number: "000012340056",
    bank_id: "bank_synthetic",
    account_holder_name: "Synthetic Account Holder",
  };
  assert.equal(projectPaymentInput(input, activeBanks)?.account_number, "000012340056");
  for (const key of ["account_number", "bank_id", "account_holder_name"]) {
    const incomplete = { ...input, [key]: null };
    assert.equal(projectPaymentInput(incomplete, activeBanks), null, key);
  }
});

test("account metadata is explicit keep/set/clear and rejects ambiguous nulls", () => {
  assert.deepEqual(projectAccountMetadataInput({
    account_number: { op: "keep" },
    bank_name: { op: "set", value: " Ngân hàng Á Châu " },
    account_holder_name: { op: "clear" },
  }), {
    account_number: { op: "keep" },
    bank_name: { op: "set", value: "Ngân hàng Á Châu" },
    account_holder_name: { op: "clear" },
  });
  assert.deepEqual(projectAccountMetadataInput({
    account_number: { op: "set", value: " 00001234 " },
    bank_name: { op: "keep" },
    account_holder_name: { op: "set", value: "Synthetic Holder" },
  }), {
    account_number: { op: "set", value: "00001234" },
    bank_name: { op: "keep" },
    account_holder_name: { op: "set", value: "Synthetic Holder" },
  });
  for (const invalid of [
    { account_number: { op: "set" }, bank_name: { op: "keep" }, account_holder_name: { op: "keep" } },
    { account_number: { op: "clear", value: "123" }, bank_name: { op: "keep" }, account_holder_name: { op: "keep" } },
    { account_number: { op: "keep", value: "123" }, bank_name: { op: "keep" }, account_holder_name: { op: "keep" } },
    { account_number: { op: "set", value: "12 34" }, bank_name: { op: "keep" }, account_holder_name: { op: "keep" } },
    { account_number: { op: "set", value: "••••0056" }, bank_name: { op: "keep" }, account_holder_name: { op: "keep" } },
    { account_number: { op: "set", value: "****0056" }, bank_name: { op: "keep" }, account_holder_name: { op: "keep" } },
    { account_number: { op: "set", value: "   " }, bank_name: { op: "keep" }, account_holder_name: { op: "keep" } },
    { account_number: { op: "set", value: "1".repeat(65) }, bank_name: { op: "keep" }, account_holder_name: { op: "keep" } },
    { account_number: { op: "keep" }, bank_name: { op: "set", value: "x".repeat(257) }, account_holder_name: { op: "keep" } },
    { account_number: { op: "keep" }, bank_name: { op: "keep" }, account_holder_name: { op: "set", value: "bad\nname" } },
    { account_number: { op: "keep" }, bank_name: { op: "keep" }, account_holder_name: { op: "keep" }, bank_id: "legacy" },
    { account_number: { op: "keep" }, bank_name: { op: "keep" }, account_holder_name: { op: "keep" } },
    { account_number: null, bank_name: { op: "keep" }, account_holder_name: { op: "keep" } },
  ]) assert.equal(projectAccountMetadataInput(invalid), null);
});

test("provided payment rejects inactive/unknown banks, non-digit values, and extra fields", () => {
  const input = {
    state: "provided",
    account_number: "000012340056",
    bank_id: "bank_synthetic",
    account_holder_name: "Synthetic Account Holder",
  };
  assert.equal(projectPaymentInput(input, new Set()), null);
  assert.equal(projectPaymentInput({ ...input, account_number: 1234 }, activeBanks), null);
  assert.equal(projectPaymentInput({ ...input, capability: "payment_view" }, activeBanks), null);
  assert.equal(projectPaymentInput({
    state: "unknown",
    account_number: "masked",
    bank_id: null,
    account_holder_name: null,
  }), null);
});

test("accepts only safe masked/full read projections and strict update versions", () => {
  assert.deepEqual(projectPaymentProjection({
    state: "provided",
    account_number: "••••0056",
    version: 2,
  }), {
    state: "provided",
    account_number: "••••0056",
    bank_id: null,
    bank_name: null,
    account_holder_name: null,
    version: 2,
    masked: true,
  });
  assert.deepEqual(projectPaymentProjection({
    state: "provided",
    account_number: "000012340056",
    bank_id: "bank_synthetic",
    bank_name: null,
    account_holder_name: "Synthetic Account Holder",
    version: 2,
  })?.account_number, "000012340056");
  assert.deepEqual(projectPaymentProjection({
    state: "provided",
    account_number: null,
    bank_id: null,
    bank_name: "Ngân hàng Á Châu",
    account_holder_name: null,
    version: 2,
  })?.bank_name, "Ngân hàng Á Châu");
  assert.equal(projectPaymentProjection({
    state: "provided",
    account_number: "000012340056",
    bank_id: "bank_synthetic",
    account_holder_name: "Synthetic Account Holder",
  }), null);
  assert.deepEqual(projectPaymentUpdateResult({
    entry_id: "a2000000-0000-4000-8000-000000000001",
    entry_version: 3,
    payment_version: 2,
  }, "a2000000-0000-4000-8000-000000000001"), {
    entry_id: "a2000000-0000-4000-8000-000000000001",
    entry_version: 3,
    payment_version: 2,
  });
});
