import assert from "node:assert/strict";
import test from "node:test";

import { applyDraftEmploymentStatus } from "./draft-employment-status-api.ts";
import { createDirectEntryWriteRepository } from "./write-repository.ts";

const actor = {
  auth_subject: "91100000-0000-4000-8000-000000000001",
  app_user_id: "92100000-0000-4000-8000-000000000001",
};
const entryId = "a2000000-0000-4000-8000-000000000001";
const session = async () => ({ actor: { ok: true, actor }, response_headers: {} });
const requestBody = {
  expected_entry_version: 3,
  status: "OFF",
  effective_date: "2026-10-20",
  leave_date: "2026-10-20",
  leave_reason_text: "Synthetic reason",
  reason: "Synthetic draft correction",
};

function request(body = requestBody, headers = {}) {
  return new Request(`https://example.test/api/direct-entry/entries/${entryId}/employment-status`, {
    method: "PATCH",
    headers: {
      origin: "https://example.test",
      host: "example.test",
      "content-type": "application/json",
      "idempotency-key": "draft-status-001",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

test("draft status API validates the exact status contract before resolving the session", async () => {
  let sessions = 0;
  const dependencies = {
    async resolveSession() {
      sessions += 1;
      return session();
    },
    repository: {
      async applyDraftEmploymentStatus() {
        assert.fail("invalid requests must not reach the repository");
      },
    },
  };
  assert.equal((await applyDraftEmploymentStatus(request(), "bad", "true", dependencies)).status, 400);
  assert.equal((await applyDraftEmploymentStatus(request(), entryId, undefined, dependencies)).status, 404);
  assert.equal((await applyDraftEmploymentStatus(request(requestBody, { origin: "https://evil.test" }),
    entryId, "true", dependencies)).status, 403);
  assert.equal((await applyDraftEmploymentStatus(request({
    ...requestBody, status: "ON", leave_date: null, leave_reason_text: null, actor_user_id: actor.app_user_id,
  }), entryId, "true", dependencies)).status, 400);
  assert.equal((await applyDraftEmploymentStatus(request({
    ...requestBody, leave_date: "2026-10-19",
  }), entryId, "true", dependencies)).status, 400);
  assert.equal((await applyDraftEmploymentStatus(request({
    ...requestBody, effective_date: "2026-02-30",
  }), entryId, "true", dependencies)).status, 400);
  assert.equal((await applyDraftEmploymentStatus(request({
    ...requestBody, leave_reason_text: "  ", reason: null,
  }), entryId, "true", dependencies)).status, 400,
  "OFF leave reason remains mandatory even when action reason is optional");
  assert.equal((await applyDraftEmploymentStatus(request({
    ...requestBody, status: "ON", leave_date: null, leave_reason_text: null,
    reason: "x".repeat(4001),
  }), entryId, "true", dependencies)).status, 400);
  assert.equal(sessions, 0);
});

test("draft status API resolves actor from session and sends only the supported DB arguments", async () => {
  const calls = [];
  const dependencies = {
    resolveSession: session,
    repository: {
      async applyDraftEmploymentStatus(input) {
        calls.push(input);
        return {
          ok: true,
          data: {
            entry_id: entryId,
            entry_version: 4,
            status_version: 2,
            status: "OFF",
          },
        };
      },
    },
  };
  const response = await applyDraftEmploymentStatus(request(), entryId, "true", dependencies);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    entry_id: entryId,
    entry_version: 4,
    status_version: 2,
    status: "OFF",
  });
  assert.deepEqual(calls, [{
    ...actor,
    entry_id: entryId,
    expected_entry_version: 3,
    status: "OFF",
    effective_date: "2026-10-20",
    leave_reason_text: "Synthetic reason",
    reason: "Synthetic draft correction",
    idempotency_key: "draft-status-001",
  }]);
  assert.equal(response.headers.get("cache-control"), "private, no-store");

  const denied = {
    resolveSession: session,
    repository: {
      async applyDraftEmploymentStatus() { return { ok: false, kind: "denied" }; },
    },
  };
  assert.equal((await applyDraftEmploymentStatus(request(), entryId, "true", denied)).status, 403);
});

test("draft status action reason may be omitted while ON status has no leave reason", async () => {
  let called = null;
  const body = { expected_entry_version: 3, status: "ON", effective_date: "2026-10-20",
    leave_date: null, leave_reason_text: null };
  const response = await applyDraftEmploymentStatus(request(body), entryId, "true", {
    resolveSession: session,
    repository: { async applyDraftEmploymentStatus(input) {
      called = input;
      return { ok: true, data: { entry_id: entryId, entry_version: 4,
        status_version: 2, status: "ON" } };
    } },
  });
  assert.equal(response.status, 200);
  assert.equal(called.reason, null);
  assert.equal(called.leave_reason_text, null);
});

test("write repository calls the DRAFT-only employment status RPC with mapped error categories", async () => {
  const calls = [];
  const repository = createDirectEntryWriteRepository(async (name, args) => {
    calls.push({ name, args });
    return {
      data: {
        entry_id: entryId,
        entry_version: 4,
        status_version: 2,
        status: "OFF",
      },
      error: null,
    };
  });
  const input = {
    ...actor,
    entry_id: entryId,
    expected_entry_version: 3,
    status: "OFF",
    effective_date: "2026-10-20",
    leave_reason_text: "Synthetic reason",
    reason: "Synthetic draft correction",
    idempotency_key: "draft-status-001",
  };
  assert.deepEqual(await repository.applyDraftEmploymentStatus(input), {
    ok: true,
    data: {
      entry_id: entryId,
      entry_version: 4,
      status_version: 2,
      status: "OFF",
    },
  });
  assert.deepEqual(calls, [{
    name: "direct_entry_apply_draft_employment_status",
    args: {
      p_auth_subject: actor.auth_subject,
      p_app_user_id: actor.app_user_id,
      p_entry_id: entryId,
      p_expected_entry_version: 3,
      p_status: "OFF",
      p_effective_date: "2026-10-20",
      p_leave_reason: "Synthetic reason",
      p_reason: "Synthetic draft correction",
      p_idempotency_key: "draft-status-001",
    },
  }]);
  const nullCalls = [];
  const nullRepository = createDirectEntryWriteRepository(async (name, args) => {
    nullCalls.push({ name, args });
    return { data: { entry_id: entryId, entry_version: 4, status_version: 2, status: "OFF" }, error: null };
  });
  await nullRepository.applyDraftEmploymentStatus({ ...input, reason: null });
  assert.equal(nullCalls[0].args.p_reason, null);

  const conflict = createDirectEntryWriteRepository(async () => ({
    data: null,
    error: { code: "40001" },
  }));
  assert.deepEqual(await conflict.applyDraftEmploymentStatus(input), {
    ok: false, kind: "conflict",
  });
});
