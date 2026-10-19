import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";

import {
  deleteWorkerPortraitStage,
  postWorkerPortraitStage,
  recoverWorkerPortraitStage,
} from "./worker-portrait-stage-api.ts";

const actor = {
  auth_subject: "91000000-0000-4000-8000-000000000001",
  app_user_id: "92000000-0000-4000-8000-000000000001",
};
const stageId = "b2000000-0000-4000-8000-000000000001";
const key = "b3000000-0000-4000-8000-000000000001";

async function portraitWithExif() {
  return new Uint8Array(await sharp({
    create: { width: 2, height: 2, channels: 3, background: "#336699" },
  }).jpeg().withMetadata({
    exif: { IFD0: { ImageDescription: "synthetic-personal-metadata" } },
  }).toBuffer());
}

function deps({
  capabilities = ["document_upload"], createResult, cancelResult, recoverResult,
  deleteError,
} = {}) {
  const calls = [];
  const stagedObjects = new Map();
  const storage = {
    available: () => true,
    async writeEnrollmentPortraitStage(input) {
      calls.push(["write", input]);
      stagedObjects.set(input.stage_id, input.bytes);
    },
    async deleteEnrollmentPortraitStage(id) {
      calls.push(["delete", id]);
      if (deleteError) throw new Error("synthetic delete failure");
    },
  };
  const repository = {
    async create(input) {
      calls.push(["create", input]);
      const stage = {
        stage_id: input.stage_id,
        document_type: input.document_type,
        mime_type: input.mime_type,
        size_bytes: input.size_bytes,
        checksum_sha256: input.checksum_sha256,
        status: "STAGED",
        claim_idempotency_key: null,
        entry_id: null,
        document_id: null,
      };
      return createResult ?? { ok: true, data: { stage, replayed: false } };
    },
    async cancel(input) {
      calls.push(["cancel", input]);
      return cancelResult ?? { ok: true, data: true };
    },
    async recover(input) {
      calls.push(["recover", input]);
      return recoverResult ?? { ok: true, data: {
        stage_id: input.stage_id,
        mime_type: "image/jpeg",
        size_bytes: 256,
        checksum_sha256: "a".repeat(64),
        status: "STAGED",
        claim_idempotency_key: null,
        entry_id: null,
        document_id: null,
      } };
    },
  };
  return {
    calls,
    stagedObjects,
    resolveSession: async () => ({
      actor: { ok: true, actor: { ...actor, capabilities } },
      response_headers: {},
    }),
    repository,
    storage,
  };
}

function uploadRequest(bytes, mimeType = "image/jpeg", idempotencyKey = key, documentType) {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mimeType }), "client-filename.jpg");
  if (documentType !== undefined) form.append("document_type", documentType);
  return new Request("https://example.test/api/direct-entry/worker-portrait-stages", {
    method: "POST",
    headers: {
      origin: "https://example.test", host: "example.test",
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    },
    body: form,
  });
}

function deleteRequest(id = stageId) {
  return new Request("https://example.test/api/direct-entry/worker-portrait-stages", {
    method: "DELETE",
    headers: {
      origin: "https://example.test",
      host: "example.test",
      "content-type": "application/json",
    },
    body: JSON.stringify({ stage_id: id }),
  });
}

test("portrait is sanitized into private staging before any entry is created", async () => {
  const source = await portraitWithExif();
  const d = deps();
  const response = await postWorkerPortraitStage(uploadRequest(source), "true", d);
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  assert.equal(body.status, "STAGED");
  assert.equal(body.mime_type, "image/jpeg");
  assert.match(body.stage_id, /^[0-9a-f-]{36}$/i);
  assert.doesNotMatch(JSON.stringify(body), /storage_key|bucket|signed|url|client-filename/);
  assert.deepEqual(d.calls.map(([name]) => name), ["create", "write"]);
  const stagedBytes = d.calls[1][1].bytes;
  assert.notDeepEqual(stagedBytes, source);
  assert.equal((await sharp(stagedBytes).metadata()).exif, undefined);
  assert.deepEqual(d.calls[0][1], {
    ...actor,
    stage_id: body.stage_id,
    document_type: "WORKER_PORTRAIT",
    mime_type: "image/jpeg",
    size_bytes: stagedBytes.byteLength,
    checksum_sha256: (await import("./document-r2-contract.ts")).sha256Hex(stagedBytes),
    idempotency_key: key,
  });
});

test("CCCD and contract PDFs stage as their declared document type without portrait rewriting", async () => {
  const pdf = new TextEncoder().encode("%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF");
  for (const documentType of ["CCCD_FRONT", "CCCD_BACK", "EMPLOYMENT_CONTRACT"]) {
    const d = deps();
    const response = await postWorkerPortraitStage(
      uploadRequest(pdf, "application/pdf", key, documentType), "true", d,
    );
    const body = await response.json();
    assert.equal(response.status, 201, JSON.stringify(body));
    assert.equal(body.document_type, documentType);
    assert.equal(body.mime_type, "application/pdf");
    assert.deepEqual(d.calls[0][1], {
      ...actor,
      stage_id: body.stage_id,
      document_type: documentType,
      mime_type: "application/pdf",
      size_bytes: pdf.byteLength,
      checksum_sha256: (await import("./document-r2-contract.ts")).sha256Hex(pdf),
      idempotency_key: key,
    });
    assert.deepEqual([...d.stagedObjects.values()][0], pdf,
      "PDF bytes are staged privately as-is; portrait re-encoding is not applied");
  }
});

test("portrait stage retries after a lost response reuse the stage and private object", async () => {
  const source = await portraitWithExif();
  const d = deps();
  const records = new Map();
  d.repository.create = async (input) => {
    d.calls.push(["create", input]);
    const prior = records.get(input.idempotency_key);
    if (prior) {
      if (prior.checksum_sha256 !== input.checksum_sha256 ||
          prior.mime_type !== input.mime_type || prior.size_bytes !== input.size_bytes) {
        return { ok: false, kind: "conflict" };
      }
      return { ok: true, data: { stage: prior, replayed: true } };
    }
    const stage = {
      stage_id: input.stage_id,
      document_type: input.document_type,
      mime_type: input.mime_type,
      size_bytes: input.size_bytes,
      checksum_sha256: input.checksum_sha256,
      status: "STAGED",
      claim_idempotency_key: null,
      entry_id: null,
      document_id: null,
    };
    records.set(input.idempotency_key, stage);
    return { ok: true, data: { stage, replayed: false } };
  };

  const first = await postWorkerPortraitStage(uploadRequest(source), "true", d);
  const firstBody = await first.json();
  const retry = await postWorkerPortraitStage(uploadRequest(source), "true", d);
  const retryBody = await retry.json();
  assert.equal(first.status, 201);
  assert.equal(retry.status, 200);
  assert.equal(retryBody.stage_id, firstBody.stage_id);
  assert.equal(records.size, 1);
  assert.equal(d.stagedObjects.size, 1, "both idempotent writes target the same object key");
  assert.deepEqual([...d.stagedObjects.keys()], [firstBody.stage_id]);
});

test("portrait stage rejects a reused key with different sanitized content before storage write", async () => {
  const first = await portraitWithExif();
  const second = new Uint8Array(await sharp({
    create: { width: 2, height: 2, channels: 3, background: "#993366" },
  }).jpeg().toBuffer());
  const d = deps();
  const prior = new Map();
  d.repository.create = async (input) => {
    d.calls.push(["create", input]);
    const existing = prior.get(input.idempotency_key);
    if (existing) return existing.checksum_sha256 === input.checksum_sha256
      ? { ok: true, data: { stage: existing, replayed: true } }
      : { ok: false, kind: "conflict" };
    const stage = {
      stage_id: input.stage_id, document_type: input.document_type, mime_type: input.mime_type,
      size_bytes: input.size_bytes, checksum_sha256: input.checksum_sha256,
      status: "STAGED", claim_idempotency_key: null, entry_id: null, document_id: null,
    };
    prior.set(input.idempotency_key, stage);
    return { ok: true, data: { stage, replayed: false } };
  };
  assert.equal((await postWorkerPortraitStage(uploadRequest(first), "true", d)).status, 201);
  const conflict = await postWorkerPortraitStage(uploadRequest(second), "true", d);
  assert.equal(conflict.status, 409);
  assert.deepEqual(d.calls.filter(([name]) => name === "write").map(([, input]) => input.stage_id),
    [prior.get(key).stage_id]);
  assert.equal(d.stagedObjects.size, 1);
});

test("concurrent requests with one portrait idempotency key share one stage and object", async () => {
  const source = await portraitWithExif();
  const d = deps();
  const records = new Map();
  d.repository.create = async (input) => {
    d.calls.push(["create", input]);
    let stage = records.get(input.idempotency_key);
    if (!stage) {
      stage = {
        stage_id: input.stage_id, mime_type: input.mime_type,
        size_bytes: input.size_bytes, checksum_sha256: input.checksum_sha256,
        status: "STAGED", claim_idempotency_key: null, entry_id: null, document_id: null,
      };
      records.set(input.idempotency_key, stage);
    }
    return { ok: true, data: { stage, replayed: stage.stage_id !== input.stage_id } };
  };
  const [one, two] = await Promise.all([
    postWorkerPortraitStage(uploadRequest(source), "true", d),
    postWorkerPortraitStage(uploadRequest(source), "true", d),
  ]);
  const oneBody = await one.json();
  const twoBody = await two.json();
  assert.ok([201, 200].includes(one.status));
  assert.ok([201, 200].includes(two.status));
  assert.equal(oneBody.stage_id, twoBody.stage_id);
  assert.equal(records.size, 1);
  assert.equal(d.stagedObjects.size, 1);
});

test("portrait stage rejects unsupported MIME and missing capability without storing bytes", async () => {
  const source = await portraitWithExif();
  const d = deps();
  const invalid = await postWorkerPortraitStage(
    uploadRequest(new Uint8Array([1, 2, 3]), "application/pdf"), "true", d,
  );
  assert.equal(invalid.status, 400);
  assert.deepEqual(d.calls, []);
  assert.equal((await postWorkerPortraitStage(uploadRequest(source, "image/jpeg", ""), "true", deps()))
    .status, 400);

  const denied = deps({ capabilities: ["document_view"] });
  assert.equal((await postWorkerPortraitStage(uploadRequest(source), "true", denied)).status, 403);
  assert.deepEqual(denied.calls, []);

  const changeRequestOnly = deps({ capabilities: ["change_request_create"] });
  assert.equal((await postWorkerPortraitStage(uploadRequest(source), "true", changeRequestOnly)).status, 403);
  assert.deepEqual(changeRequestOnly.calls, []);
});

test("failed stage registration does not create an orphan object", async () => {
  const source = await portraitWithExif();
  const d = deps({ createResult: { ok: false, kind: "unavailable" } });
  const response = await postWorkerPortraitStage(uploadRequest(source), "true", d);
  assert.equal(response.status, 503, JSON.stringify(await response.json()));
  assert.deepEqual(d.calls.map(([name]) => name), ["create"]);
  assert.equal(d.stagedObjects.size, 0);
});

test("stage cancellation requires owner scope and deletes bytes only after DB cancellation", async () => {
  const denied = deps({ cancelResult: { ok: false, kind: "denied" } });
  assert.equal((await deleteWorkerPortraitStage(deleteRequest(), "true", denied)).status, 404);
  assert.deepEqual(denied.calls.map(([name]) => name), ["cancel"]);

  const allowed = deps({ capabilities: [] });
  assert.equal((await deleteWorkerPortraitStage(deleteRequest(), "true", allowed)).status, 204);
  assert.deepEqual(allowed.calls.map(([name]) => name), ["cancel", "delete"]);
  assert.deepEqual(allowed.calls[0][1], { ...actor, stage_id: stageId });
});

test("recovery restores the claim key for a committed batch retry", async () => {
  const d = deps({ recoverResult: { ok: true, data: {
    stage_id: stageId,
    mime_type: "image/jpeg",
    size_bytes: 256,
    checksum_sha256: "a".repeat(64),
    status: "CLAIMED",
    claim_idempotency_key: "b1000000-0000-4000-8000-000000000001",
    entry_id: null,
    document_id: null,
  } } });
  const response = await recoverWorkerPortraitStage(deleteRequest(), "true", d);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    stage_id: stageId,
    status: "CLAIMED",
    idempotency_key: "b1000000-0000-4000-8000-000000000001",
  });
  assert.deepEqual(d.calls.map(([name]) => name), ["recover"]);
  assert.deepEqual(d.calls[0][1], { ...actor, stage_id: stageId });
});

test("recovery cleanup is idempotently retryable and owner-bound", async () => {
  const denied = deps({ recoverResult: { ok: false, kind: "denied" } });
  assert.equal((await recoverWorkerPortraitStage(deleteRequest(), "true", denied)).status, 404);
  assert.deepEqual(denied.calls.map(([name]) => name), ["recover"]);

  let failDelete = true;
  const d = deps({ recoverResult: { ok: true, data: {
    stage_id: stageId,
    mime_type: "image/jpeg",
    size_bytes: 256,
    checksum_sha256: "a".repeat(64),
    status: "ATTACHED",
    claim_idempotency_key: "b1000000-0000-4000-8000-000000000001",
    entry_id: "a2000000-0000-4000-8000-000000000001",
    document_id: "a3000000-0000-4000-8000-000000000001",
  } } });
  d.storage.deleteEnrollmentPortraitStage = async (id) => {
    d.calls.push(["delete", id]);
    if (failDelete) {
      failDelete = false;
      throw new Error("synthetic delete failure");
    }
  };
  assert.equal((await recoverWorkerPortraitStage(deleteRequest(), "true", d)).status, 503);
  assert.equal((await recoverWorkerPortraitStage(deleteRequest(), "true", d)).status, 200);
  assert.deepEqual(d.calls.map(([name]) => name), ["recover", "delete", "recover", "delete"]);
});
