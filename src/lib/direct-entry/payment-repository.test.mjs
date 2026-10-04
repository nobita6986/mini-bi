import assert from "node:assert/strict";
import test from "node:test";

import { createDirectEntryWriteRepository } from "./write-repository.ts";

const actor = {
  auth_subject: "91000000-0000-4000-8000-000000000001",
  app_user_id: "92000000-0000-4000-8000-000000000001",
};
const entryId = "a2000000-0000-4000-8000-000000000001";
const payment = {
  state: "provided",
  account_number: "000012340056",
  bank_id: "bank_synthetic",
  account_holder_name: "Synthetic Account Holder",
};

test("payment repository calls only the existing update RPC and strictly projects its result", async () => {
  const calls = [];
  const repository = createDirectEntryWriteRepository(async (name, args) => {
    calls.push({ name, args });
    return {
      data: { entry_id: entryId, entry_version: 8, payment_version: 3 },
      error: null,
    };
  });
  const result = await repository.updatePayment({
    ...actor,
    entry_id: entryId,
    expected_entry_version: 7,
    expected_payment_version: 2,
    payment,
    reason: "Synthetic correction",
    idempotency_key: "synthetic-payment-key",
  });
  assert.deepEqual(result, {
    ok: true,
    data: { entry_id: entryId, entry_version: 8, payment_version: 3 },
  });
  assert.deepEqual(calls, [{
    name: "direct_entry_update_payment",
    args: {
      p_auth_subject: actor.auth_subject,
      p_app_user_id: actor.app_user_id,
      p_entry_id: entryId,
      p_expected_entry_version: 7,
      p_expected_payment_version: 2,
      p_payment: payment,
      p_reason: "Synthetic correction",
      p_idempotency_key: "synthetic-payment-key",
    },
  }]);
});

test("explicit account metadata operations reuse the existing payment RPC unchanged", async () => {
  const calls = [];
  const metadata = {
    account_number: { op: "keep" },
    bank_name: { op: "set", value: "Synthetic Bank" },
    account_holder_name: { op: "clear" },
  };
  const repository = createDirectEntryWriteRepository(async (name, args) => {
    calls.push({ name, args });
    return {
      data: { entry_id: entryId, entry_version: 8, payment_version: 3 },
      error: null,
    };
  });
  const result = await repository.updatePayment({
    ...actor,
    entry_id: entryId,
    expected_entry_version: 7,
    expected_payment_version: 2,
    payment: metadata,
    reason: "Synthetic metadata correction",
    idempotency_key: "synthetic-metadata-key",
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "direct_entry_update_payment");
  assert.deepEqual(calls[0].args.p_payment, metadata);
});

test("malformed payment RPC results fail closed without returning raw data", async () => {
  const repository = createDirectEntryWriteRepository(async () => ({
    data: {
      entry_id: entryId,
      entry_version: 8,
      payment_version: 3,
      account_number: payment.account_number,
    },
    error: null,
  }));
  assert.deepEqual(await repository.updatePayment({
    ...actor,
    entry_id: entryId,
    expected_entry_version: 7,
    expected_payment_version: 2,
    payment,
    reason: "Synthetic correction",
    idempotency_key: "synthetic-payment-key",
  }), { ok: false, kind: "unavailable" });
});
