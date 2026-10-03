import assert from "node:assert/strict";
import test from "node:test";

import { uploadDirectEntryDocument } from "./document-api.ts";
import { createDocumentWorkerAdapter } from "./document-worker-adapter.ts";

const entryId = "a2000000-0000-4000-8000-000000000001";
const documentId = "b2000000-0000-4000-8000-000000000001";
const storageKey = "p1.6/c2000000-0000-4000-8000-000000000001/CCCD_FRONT/1/b2000000-0000-4000-8000-000000000001";
const actor = {
  auth_subject: "91000000-0000-4000-8000-000000000001",
  app_user_id: "92000000-0000-4000-8000-000000000001",
  capabilities: ["entry_own", "document_upload"],
  ok: true,
};
const projection = {
  entry_id: entryId,
  submission_id: "a1000000-0000-4000-8000-000000000001",
  project_id: "project_synthetic_01",
  first_work_date: "2026-10-15",
  employee_code: "hrp-2026-000001",
  worker_details: {},
  recruiter_id: "93000000-0000-4000-8000-000000000001",
  team_id: "94000000-0000-4000-8000-000000000001",
  provider_type: "hrp",
  labor_type: "TEMPORARY",
  version: 1,
  scope_kind: "own",
  payment: null,
  employment_status: { status: "UNCONFIRMED", effective_date: "2026-10-15", version: 1 },
  documents: [],
};
const bytes = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

function request({
  fields = {},
  file = true,
  includeIdempotency = true,
  headers = {},
  bodyBytes = bytes,
} = {}) {
  const form = new FormData();
  form.set("document_type", "CCCD_FRONT");
  form.set("expected_entry_version", "1");
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  if (file) form.set("file", new Blob([bodyBytes], { type: "image/png" }), "synthetic.png");
  const requestHeaders = {
    origin: "https://example.test",
    host: "example.test",
    ...(includeIdempotency ? { "idempotency-key": "document-synthetic-key" } : {}),
    ...headers,
  };
  return new Request(`https://example.test/api/direct-entry/entries/${entryId}/documents`, {
    method: "POST",
    headers: requestHeaders,
    body: form,
  });
}

function dependencies(overrides = {}) {
  const sessions = [];
  const reads = [];
  const reservations = [];
  const uploads = [];
  return {
    sessions,
    reads,
    reservations,
    uploads,
    resolveSession: async () => {
      sessions.push(true);
      return { actor: { ok: true, actor }, response_headers: {} };
    },
    repository: {
      async readEntry(input) {
        reads.push(input);
        return { ok: true, data: projection };
      },
      async reserveDocumentUpload(input) {
        reservations.push(input);
        return {
          ok: true,
          data: {
            document_id: documentId,
            version: 1,
            entry_version: 2,
            event_sequence: 3,
            attempts: 0,
            attempt: 1,
            upload_status: "QUEUED",
            scan_status: "PENDING",
            reused: false,
            storage_key: storageKey,
          },
        };
      },
      ...overrides.repository,
    },
    storage: {
      available() {
        return true;
      },
      async upload(input) {
        uploads.push(input);
        return { kind: "unavailable" };
      },
      ...overrides.storage,
    },
  };
}

test("gate, UUID, CSRF and idempotency reject before session or mutation", async () => {
  const deps = dependencies();
  assert.equal((await uploadDirectEntryDocument(
    request(), entryId, undefined, deps,
  )).status, 404);
  assert.equal((await uploadDirectEntryDocument(
    request(), "bad", "true", deps,
  )).status, 400);
  assert.equal((await uploadDirectEntryDocument(
    request({ headers: { origin: "https://attacker.test" } }), entryId, "true", deps,
  )).status, 403);
  assert.equal((await uploadDirectEntryDocument(
    request({ includeIdempotency: false }), entryId, "true", deps,
  )).status, 400);
  assert.equal((await uploadDirectEntryDocument(
    request({ headers: { "idempotency-key": "" } }), entryId, "true", deps,
  )).status, 400);
  assert.equal((await uploadDirectEntryDocument(
    request({ headers: { "idempotency-key": "x".repeat(129) } }), entryId, "true", deps,
  )).status, 400);
  assert.equal(deps.sessions.length, 0);
  assert.equal(deps.reservations.length, 0);
});

test("missing file and authority fields reject before session or reservation", async () => {
  const deps = dependencies();
  const noFile = await uploadDirectEntryDocument(request({ file: false }), entryId, "true", deps);
  assert.equal(noFile.status, 400);
  assert.equal((await noFile.json()).code, "DOCUMENT_FILE_REQUIRED");
  const authority = await uploadDirectEntryDocument(
    request({ fields: { metadata: JSON.stringify([{ actor: { app_user_id: actor.app_user_id } }]) } }),
    entryId,
    "true",
    deps,
  );
  assert.equal(authority.status, 400);
  assert.equal((await authority.json()).code, "CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  assert.equal(deps.sessions.length, 0);
  assert.equal(deps.reservations.length, 0);
});

test("valid file uses server actor, checksum, DB storage key, and fails closed without Drive", async () => {
  const deps = dependencies();
  const response = await uploadDirectEntryDocument(request(), entryId, "true", deps);
  const payload = await response.json();
  assert.equal(response.status, 503);
  assert.equal(payload.code, "DOCUMENT_STORAGE_UNAVAILABLE");
  assert.equal(payload.document_id, documentId);
  assert.equal(payload.entry_version, 2);
  assert.equal("storage_key" in payload, false);
  assert.equal("checksum_sha256" in payload, false);
  assert.equal(deps.reads.length, 0);
  assert.equal(deps.reservations.length, 1);
  assert.deepEqual(deps.reservations[0], {
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    entry_id: entryId,
    expected_entry_version: 1,
    document_type: "CCCD_FRONT",
    idempotency_key: "document-synthetic-key",
    checksum_sha256: "4c4b6a3be1314ab86138bef4314dde022e600960d8689a2c8f8631802d20dab6",
    size_bytes: bytes.length,
    mime_type: "image/png",
    reason: null,
  });
  assert.equal(deps.uploads[0].storage_key, storageKey);
  assert.equal(deps.uploads[0].bytes.length, bytes.length);
  assert.equal(deps.uploads[0].entry_id, entryId);
});

test("invalid signature, over-limit upload, and stale version fail before reservation", async () => {
  const deps = dependencies();
  const badSignature = await uploadDirectEntryDocument(
    request({ bodyBytes: new TextEncoder().encode("%PDF-1.7") }),
    entryId, "true", deps,
  );
  assert.equal((await badSignature.json()).code, "DOCUMENT_CONTENT_INVALID");
  const oversized = await uploadDirectEntryDocument(
    request({ bodyBytes: new Uint8Array(10 * 1024 * 1024 + 1) }),
    entryId, "true", deps,
  );
  assert.equal((await oversized.json()).code, "DOCUMENT_SIZE_INVALID");
  assert.equal(deps.reservations.length, 0);

  const staleDeps = dependencies({
    repository: {
      async reserveDocumentUpload(input) {
        staleDeps.reservations.push(input);
        return { ok: false, kind: "conflict" };
      },
    },
  });
  const stale = await uploadDirectEntryDocument(request(), entryId, "true", staleDeps);
  assert.equal(stale.status, 409);
  assert.equal(staleDeps.reservations.length, 1);
  assert.equal(staleDeps.uploads.length, 0);
});

test("storage acknowledgement cannot mark a document ready and invalid acknowledgements fail closed", async () => {
  const deps = dependencies({
    storage: {
      async upload() {
        return {
          kind: "durable",
          document_id: documentId,
          version: 1,
          storage_key: storageKey,
          object_version: "synthetic-object-v1",
          checksum_sha256: "f".repeat(64),
        };
      },
    },
  });
  const response = await uploadDirectEntryDocument(request(), entryId, "true", deps);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "DOCUMENT_STORAGE_UNAVAILABLE");

  const goodDeps = dependencies({
    storage: {
      async upload(input) {
        return {
          kind: "durable",
          document_id: documentId,
          version: 1,
          storage_key: input.storage_key,
          object_version: "synthetic-object-v1",
          checksum_sha256: input.checksum_sha256,
        };
      },
    },
  });
  const accepted = await uploadDirectEntryDocument(request(), entryId, "true", goodDeps);
  const payload = await accepted.json();
  assert.equal(accepted.status, 202);
  assert.equal(payload.upload_status, "QUEUED");
  assert.equal(payload.callback_pending, true);
  assert.equal(payload.upload_status === "READY", false);
});

test("same-key retry uses the same document reservation and storage key", async () => {
  const reservations = [];
  const uploads = [];
  const deps = dependencies({
    repository: {
      async reserveDocumentUpload(input) {
        reservations.push(input);
        return {
          ok: true,
          data: {
            document_id: documentId,
            version: 1,
            entry_version: 2,
            event_sequence: 3,
            attempts: 0,
            attempt: 1,
            upload_status: "QUEUED",
            scan_status: "PENDING",
            reused: reservations.length > 1,
            storage_key: storageKey,
          },
        };
      },
    },
    storage: {
      async upload(input) {
        uploads.push(input);
        return {
          kind: "durable",
          document_id: documentId,
          version: 1,
          storage_key: input.storage_key,
          object_version: "synthetic-object-v1",
          checksum_sha256: input.checksum_sha256,
        };
      },
    },
  });
  const first = await uploadDirectEntryDocument(request(), entryId, "true", deps);
  const retry = await uploadDirectEntryDocument(request(), entryId, "true", deps);
  assert.equal(first.status, 202);
  assert.equal(retry.status, 202);
  assert.deepEqual(reservations[1], reservations[0]);
  assert.equal(uploads[1].idempotency_key, uploads[0].idempotency_key);
  assert.equal(uploads[1].storage_key, uploads[0].storage_key);
  assert.equal(uploads[1].checksum_sha256, uploads[0].checksum_sha256);
});

test("same key with a changed file payload maps to conflict without a second upload", async () => {
  let firstChecksum;
  const uploads = [];
  const deps = dependencies({
    repository: {
      async reserveDocumentUpload(input) {
        if (firstChecksum === undefined) {
          firstChecksum = input.checksum_sha256;
          return {
            ok: true,
            data: {
              document_id: documentId,
              version: 1,
              entry_version: 2,
              event_sequence: 3,
              attempts: 0,
              attempt: 1,
              upload_status: "QUEUED",
              scan_status: "PENDING",
              reused: false,
              storage_key: storageKey,
            },
          };
        }
        return input.checksum_sha256 === firstChecksum
          ? { ok: true, data: {
              document_id: documentId,
              version: 1,
              entry_version: 2,
              upload_status: "QUEUED",
              scan_status: "PENDING",
              reused: true,
              storage_key: storageKey,
            } }
          : { ok: false, kind: "conflict" };
      },
    },
    storage: {
      async upload(input) {
        uploads.push(input);
        return { kind: "unavailable" };
      },
    },
  });
  const first = await uploadDirectEntryDocument(request(), entryId, "true", deps);
  const changed = await uploadDirectEntryDocument(
    request({ bodyBytes: Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01) }),
    entryId,
    "true",
    deps,
  );
  assert.equal(first.status, 503);
  assert.equal(changed.status, 409);
  assert.equal((await changed.json()).code, "DOCUMENT_VERSION_CONFLICT");
  assert.equal(uploads.length, 1);
});

test("authority denial and sanitized RPC failure do not expose raw errors or file data", async () => {
  const denied = dependencies();
  denied.resolveSession = async () => ({
    actor: { ok: true, actor: { ...actor, capabilities: ["entry_own"] } },
    response_headers: {},
  });

  test("unavailable production storage fails before projection or document mutation", async () => {
    const deps = dependencies({
      storage: {
        available() {
          return false;
        },
      },
    });

    test("missing worker environment configuration fails before reservation and outbound", async () => {
      const deps = dependencies({
        storage: createDocumentWorkerAdapter({}),
      });
      const response = await uploadDirectEntryDocument(request(), entryId, "true", deps);
      assert.equal(response.status, 503);
      assert.equal((await response.json()).code, "DOCUMENT_STORAGE_UNAVAILABLE");
      assert.equal(deps.reservations.length, 0);
      assert.equal(deps.uploads.length, 0);
    });
    const response = await uploadDirectEntryDocument(request(), entryId, "true", deps);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, "DOCUMENT_STORAGE_UNAVAILABLE");
    assert.equal(deps.reads.length, 0);
    assert.equal(deps.reservations.length, 0);
  });
  const deniedResponse = await uploadDirectEntryDocument(request(), entryId, "true", denied);
  assert.equal(deniedResponse.status, 403);
  assert.equal(denied.reservations.length, 0);

  const unavailable = dependencies({
    repository: {
      async reserveDocumentUpload() {
        return { ok: false, kind: "unavailable" };
      },
    },
  });
  const logged = [];
  const originalError = console.error;
  console.error = (...args) => logged.push(args.join(" "));
  try {
    const response = await uploadDirectEntryDocument(request(), entryId, "true", unavailable);
    const body = JSON.stringify(await response.json());
    assert.equal(response.status, 500);
    assert.equal(body.includes("synthetic.png"), false);
    assert.equal(body.includes("raw secret database error"), false);
    assert.equal(logged.join(" ").includes("synthetic.png"), false);
    assert.equal(logged.join(" ").includes("raw secret database error"), false);
  } finally {
    console.error = originalError;
  }
});
