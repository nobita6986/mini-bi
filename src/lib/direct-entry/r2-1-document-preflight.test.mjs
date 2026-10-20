import assert from "node:assert/strict";
import test from "node:test";

import { resolveActor, reserveDirectEntryDocument } from "./document-api.ts";
import { postFullProfileBatch } from "./full-profile-api.ts";
import { postWorkerPortraitStage } from "./worker-portrait-stage-api.ts";

const AUTH = "91000000-0000-4000-8000-000000000001";
const APP = "92000000-0000-4000-8000-000000000001";
const ENTRY_ID = "93000000-0000-4000-8000-000000000001";
const STAGE_ID = "94000000-0000-4000-8000-000000000001";
const IDEMPOTENCY_KEY = "95000000-0000-4000-8000-000000000001";

function sessionWithCapabilities(capabilities) {
  return async () => ({
    actor: {
      ok: true,
      actor: {
        auth_subject: AUTH,
        app_user_id: APP,
        display_name: "Synthetic Actor",
        enabled: true,
        capabilities,
        scopes: [{ kind: "own", reference: APP, valid_from: "2020-01-01", valid_to: null }],
        self_recruiter_suggestion: null,
        session: { provider: "supabase", verification: "getUser", authenticated_at: null },
      },
    },
    response_headers: {},
  });
}

test("document-api preflight allows document_upload or draft-PM change_request_create on upload, never on document_view", async () => {
  // 1. Standard uploader with document_upload -> allowed for upload
  const uploader = await resolveActor({
    resolveSession: sessionWithCapabilities(["document_upload"]),
    repository: {},
    storage: {},
  }, "document_upload");
  assert.equal(uploader.ok, true);

  // 2. Project Manager with change_request_create -> allowed for draft upload preflight (DB enforces entry scope)
  const pmUpload = await resolveActor({
    resolveSession: sessionWithCapabilities(["change_request_create"]),
    repository: {},
    storage: {},
  }, "document_upload");
  assert.equal(pmUpload.ok, true);

  // 3. Project Manager with change_request_create ONLY -> denied for document_view (no broad OR widening)
  const pmView = await resolveActor({
    resolveSession: sessionWithCapabilities(["change_request_create"]),
    repository: {},
    storage: {},
  }, "document_view");
  assert.equal(pmView.ok, false);
  assert.equal(pmView.response.status, 403);
  assert.deepEqual(await pmView.response.json(), { ok: false, code: "DOCUMENT_DENIED" });

  // 4. Actor with neither capability -> denied for reserveDirectEntryDocument before storage/DB
  let reserveCalled = false;
  const deniedRes = await reserveDirectEntryDocument(
    new Request(`https://example.test/api/direct-entry/entries/${ENTRY_ID}/documents`, {
      method: "POST",
      headers: {
        origin: "https://example.test",
        host: "example.test",
        "content-type": "application/json",
        "idempotency-key": IDEMPOTENCY_KEY,
      },
      body: JSON.stringify({
        document_type: "CCCD_FRONT",
        expected_entry_version: 1,
        size_bytes: 1024,
        mime_type: "image/jpeg",
      }),
    }),
    ENTRY_ID,
    "true",
    {
      resolveSession: sessionWithCapabilities(["entry_own"]),
      storage: { available: () => true },
      repository: {
        async reserveDocumentUpload() {
          reserveCalled = true;
          throw new Error("should not be called");
        },
      },
    },
  );
  assert.equal(deniedRes.status, 403);
  assert.deepEqual(await deniedRes.json(), { ok: false, code: "DOCUMENT_DENIED" });
  assert.equal(reserveCalled, false);
});

test("full-profile-api preflight requires explicit document_upload when staging documents and does not widen to change_request_create", async () => {
  const makeBatchRequest = () =>
    new Request("https://example.test/api/direct-entry/full-profile", {
      method: "POST",
      headers: {
        origin: "https://example.test",
        host: "example.test",
        "content-type": "application/json",
        "idempotency-key": IDEMPOTENCY_KEY,
      },
      body: JSON.stringify({
        contract_version: "worker-profile/1.0",
        rows: [{
          project_id: "project_synthetic_01",
          first_work_date: "2025-03-04",
          employee_code: "hrp-2025-000001",
          recruiter_id: ENTRY_ID,
          labor_type: "TEMPORARY",
          display_name: "Worker Test",
          portrait_stage_id: STAGE_ID,
          worker: { national_id: { state: "provided", value: "012345678901" } },
        }],
      }),
    });

  let claimCalls = 0;
  // Denied when actor only has entry_create + change_request_create (missing document_upload)
  const denied = await postFullProfileBatch(makeBatchRequest(), "true", {
    resolveSession: sessionWithCapabilities(["entry_create", "change_request_create"]),
    repository: {
      async createFullProfileBatch() {
        throw new Error("should not be called");
      },
    },
    portraitStages: {
      async claim() {
        claimCalls += 1;
        return { ok: false, kind: "denied" };
      },
    },
  });
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), { ok: false, code: "DOCUMENT_DENIED" });
  assert.equal(claimCalls, 0);

  // Allowed past preflight when actor holds document_upload
  const allowedPreflight = await postFullProfileBatch(makeBatchRequest(), "true", {
    resolveSession: sessionWithCapabilities(["entry_create", "document_upload"]),
    repository: {
      async createFullProfileBatch() {
        throw new Error("should not be called");
      },
      async createFullProfileBatchWithPortraitStages() {
        throw new Error("should not be called");
      },
    },
    documentRepository: {},
    documentStorage: {},
    portraitStages: {
      async claim() {
        claimCalls += 1;
        return { ok: false, kind: "denied" };
      },
    },
  });
  assert.equal(claimCalls, 1, "actor with document_upload passes preflight and reaches stage claim");
  assert.equal(allowedPreflight.status, 404);
});

test("worker-portrait-stage-api preflight requires explicit document_upload and rejects change_request_create-only actor", async () => {
  const makeMultipartRequest = () => {
    const boundary = "----R21Boundary";
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="test.jpg"',
      "Content-Type: image/jpeg",
      "",
      "fake-bytes",
      `--${boundary}--`,
      "",
    ].join("\r\n");
    return new Request("https://example.test/api/direct-entry/worker-portrait-stages", {
      method: "POST",
      headers: {
        origin: "https://example.test",
        host: "example.test",
        "content-type": `multipart/form-data; boundary=${boundary}`,
        "idempotency-key": IDEMPOTENCY_KEY,
      },
      body,
    });
  };

  let storageChecked = false;
  const denied = await postWorkerPortraitStage(makeMultipartRequest(), "true", {
    resolveSession: sessionWithCapabilities(["entry_create", "change_request_create"]),
    storage: {
      available() {
        storageChecked = true;
        return true;
      },
    },
    repository: {},
  });
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), { ok: false, code: "DOCUMENT_DENIED" });
  assert.equal(storageChecked, false);

  const allowedPreflight = await postWorkerPortraitStage(makeMultipartRequest(), "true", {
    resolveSession: sessionWithCapabilities(["entry_create", "document_upload"]),
    storage: {
      available() {
        storageChecked = true;
        return false;
      },
    },
    repository: {},
  });
  assert.equal(storageChecked, true, "actor with document_upload passes preflight");
  assert.equal(allowedPreflight.status, 503);
});
