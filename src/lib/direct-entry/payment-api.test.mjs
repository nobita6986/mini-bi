import assert from "node:assert/strict";
import test from "node:test";

import { patchDraftPayment } from "./payment-api.ts";

const actor = {
  auth_subject: "91000000-0000-4000-8000-000000000001",
  app_user_id: "92000000-0000-4000-8000-000000000001",
  capabilities: ["entry_own"],
  ok: true,
};
const entryId = "a2000000-0000-4000-8000-000000000001";
const payment = {
  state: "provided",
  account_number: "000012340056",
  bank_id: "bank_synthetic",
  account_holder_name: "Synthetic Account Holder",
};
const readProjection = {
  entry_id: entryId,
  submission_id: "a1000000-0000-4000-8000-000000000001",
  project_id: "project_synthetic_01",
  first_work_date: "2026-10-15",
  employee_code: "hrp-2026-000001",
  worker_details: {
    display_name: { present: true },
    gender: { state: "provided" },
    date_of_birth: { state: "provided" },
    national_id: { state: "provided" },
    national_id_issued_at: { state: "omitted" },
    national_id_issued_place: { state: "omitted" },
    address: { state: "provided" },
    phone: { state: "provided" },
  },
  recruiter_id: "93000000-0000-4000-8000-000000000001",
  team_id: "94000000-0000-4000-8000-000000000001",
  provider_type: "hrp",
  labor_type: "TEMPORARY",
  general_note: null,
  version: 1,
  scope_kind: "own",
  payment: null,
  employment_status: { status: "UNCONFIRMED", effective_date: "2026-10-15", version: 1 },
  documents: [],
};

function request(body, headers = {}) {
  return new Request(`https://example.test/api/direct-entry/entries/${entryId}/payment`, {
    method: "PATCH",
    headers: {
      origin: "https://example.test",
      host: "example.test",
      "content-type": "application/json",
      "idempotency-key": "payment-synthetic-key",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function validBody(overrides = {}) {
  return {
    expected_entry_version: 1,
    expected_payment_version: 0,
    payment,
    reason: "Synthetic test correction",
    ...overrides,
  };
}

function dependencies(overrides = {}) {
  const calls = [];
  const reads = [];
  const catalogs = [];
  const deps = {
    calls,
    reads,
    catalogs,
    resolveSession: async () => ({ actor: { ok: true, actor }, response_headers: {} }),
    repository: {
      async readEntry(input) {
        reads.push(input);
        return { ok: true, data: readProjection };
      },
      async loadInputCatalog(input) {
        catalogs.push(input);
        return {
          ok: true,
          data: {
            effective_date: "2026-10-15",
            projects: [],
            recruiters: [],
            banks: [{ bank_id: "bank_synthetic", display_name: "Synthetic Bank" }],
          },
        };
      },
      async updatePayment(input) {
        calls.push(input);
        return {
          ok: true,
          data: { entry_id: entryId, entry_version: 2, payment_version: 1 },
        };
      },
      ...overrides,
    },
  };
  return deps;
}

test("gate, CSRF, authority and malformed fields fail before session or payment RPC", async () => {
  let sessions = 0;
  const deps = dependencies();
  deps.resolveSession = async () => {
    sessions += 1;
    return { actor: { ok: true, actor }, response_headers: {} };
  };
  assert.equal((await patchDraftPayment(
    request(validBody()), entryId, undefined, deps,
  )).status, 404);
  assert.equal((await patchDraftPayment(
    request(validBody(), { origin: "https://attacker.test" }), entryId, "true", deps,
  )).status, 403);
  for (const authority of [
    "actor", "app_user", "role", "capability", "scope", "team",
    "provider", "created_by", "owner",
  ]) {
    const response = await patchDraftPayment(request({
      ...validBody(),
      payment: { ...payment, [authority]: "spoof" },
    }), entryId, "true", deps);
    assert.equal(response.status, 400, authority);
  }
  assert.equal(sessions, 0);
  assert.equal(deps.calls.length, 0);
  assert.equal((await patchDraftPayment(
    request(validBody()), "not-a-uuid", "true", deps,
  )).status, 400);
});

test("valid update uses only trusted actor IDs and preserves the account string", async () => {
  const deps = dependencies();
  const response = await patchDraftPayment(
    request(validBody()), entryId, "true", deps,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    entry_id: entryId,
    entry_version: 2,
    payment_version: 1,
  });
  assert.deepEqual(deps.calls, [{
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    entry_id: entryId,
    expected_entry_version: 1,
    expected_payment_version: 0,
    payment,
    reason: "Synthetic test correction",
    idempotency_key: "payment-synthetic-key",
  }]);
  assert.deepEqual(deps.reads, [{
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    entry_id: entryId,
  }]);
  assert.deepEqual(deps.catalogs, [{
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    effective_date: "2026-10-15",
  }]);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
});

test("unknown/inactive bank, invalid versions, and missing reason fail closed", async () => {
  const invalidBank = dependencies({
    async loadInputCatalog(input) {
      return { ok: true, data: { ...input, projects: [], recruiters: [], banks: [] } };
    },
  });
  const bankResponse = await patchDraftPayment(
    request(validBody()), entryId, "true", invalidBank,
  );
  assert.equal(bankResponse.status, 400);
  assert.equal((await bankResponse.json()).code, "BANK_INVALID");
  assert.equal(invalidBank.calls.length, 0);

  for (const body of [
    validBody({ expected_entry_version: 0 }),
    validBody({ expected_payment_version: -1 }),
    validBody({ reason: "" }),
    validBody({ payment: { ...payment, account_number: 1234 } }),
    validBody({ payment: { ...payment, account_holder_name: "" } }),
    validBody({ payment: {
      state: "provided",
      account_number: null,
      bank_id: null,
      account_holder_name: null,
    } }),
    validBody({ payment: {
      state: "unknown",
      account_number: "000012340056",
      bank_id: null,
      account_holder_name: null,
    } }),
  ]) {
    const response = await patchDraftPayment(
      request(body), entryId, "true", dependencies(),
    );
    assert.equal(response.status, 400);
  }
});

test("entry_own can update draft payment without payment_edit; database scope remains authoritative", async () => {
  const ownDraft = dependencies();
  assert.equal((await patchDraftPayment(
    request(validBody()), entryId, "true", ownDraft,
  )).status, 200);
  assert.equal(ownDraft.calls.length, 1);

  const outOfScope = dependencies({
    async readEntry() { return { ok: false, kind: "denied" }; },
  });
  assert.equal((await patchDraftPayment(
    request(validBody()), entryId, "true", outOfScope,
  )).status, 404);
  assert.equal(outOfScope.calls.length, 0);
});

test("OCC conflicts and malformed/database failures are sanitized", async () => {
  const conflict = dependencies({
    async updatePayment() { return { ok: false, kind: "conflict" }; },
  });
  const stale = await patchDraftPayment(request(validBody()), entryId, "true", conflict);
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, "PAYMENT_CONFLICT");

  const originalError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(" "));
  try {
    const unavailable = dependencies({
      async updatePayment() {
        throw new Error("private 000012340056 account detail");
      },
    });
    const response = await patchDraftPayment(
      request(validBody()), entryId, "true", unavailable,
    );
    assert.equal(response.status, 500);
    assert.doesNotMatch(JSON.stringify(await response.json()), /000012340056|private/);
    assert.doesNotMatch(logged.join(" "), /000012340056|private/);
  } finally {
    console.error = originalError;
  }
});
