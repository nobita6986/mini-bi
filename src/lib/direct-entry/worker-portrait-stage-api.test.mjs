import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";

import {
  deleteWorkerPortraitStage,
  postWorkerPortraitStage,
} from "./worker-portrait-stage-api.ts";

const actor = {
  auth_subject: "91000000-0000-4000-8000-000000000001",
  app_user_id: "92000000-0000-4000-8000-000000000001",
};
const stageId = "b2000000-0000-4000-8000-000000000001";

async function portraitWithExif() {
  return new Uint8Array(await sharp({
    create: { width: 2, height: 2, channels: 3, background: "#336699" },
  }).jpeg().withMetadata({
    exif: { IFD0: { ImageDescription: "synthetic-personal-metadata" } },
  }).toBuffer());
}

function deps({ capabilities = ["document_upload"], createResult, cancelResult } = {}) {
  const calls = [];
  const storage = {
    available: () => true,
    async writeEnrollmentPortraitStage(input) { calls.push(["write", input]); },
    async deleteEnrollmentPortraitStage(id) { calls.push(["delete", id]); },
  };
  const repository = {
    async create(input) {
      calls.push(["create", input]);
      return createResult ?? { ok: true, data: {
        stage_id: input.stage_id,
        mime_type: input.mime_type,
        size_bytes: input.size_bytes,
        checksum_sha256: input.checksum_sha256,
        status: "STAGED",
        claim_idempotency_key: null,
        entry_id: null,
        document_id: null,
      } };
    },
    async cancel(input) {
      calls.push(["cancel", input]);
      return cancelResult ?? { ok: true, data: true };
    },
  };
  return {
    calls,
    resolveSession: async () => ({
      actor: { ok: true, actor: { ...actor, capabilities } },
      response_headers: {},
    }),
    repository,
    storage,
  };
}

function uploadRequest(bytes, mimeType = "image/jpeg") {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mimeType }), "client-filename.jpg");
  return new Request("https://example.test/api/direct-entry/worker-portrait-stages", {
    method: "POST",
    headers: { origin: "https://example.test", host: "example.test" },
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
  assert.deepEqual(d.calls.map(([name]) => name), ["write", "create"]);
  const stagedBytes = d.calls[0][1].bytes;
  assert.notDeepEqual(stagedBytes, source);
  assert.equal((await sharp(stagedBytes).metadata()).exif, undefined);
  assert.deepEqual(d.calls[1][1], {
    ...actor,
    stage_id: body.stage_id,
    mime_type: "image/jpeg",
    size_bytes: stagedBytes.byteLength,
    checksum_sha256: (await import("./document-r2-contract.ts")).sha256Hex(stagedBytes),
  });
});

test("portrait stage rejects unsupported MIME and missing capability without storing bytes", async () => {
  const source = await portraitWithExif();
  const d = deps();
  const invalid = await postWorkerPortraitStage(
    uploadRequest(new Uint8Array([1, 2, 3]), "application/pdf"), "true", d,
  );
  assert.equal(invalid.status, 400);
  assert.deepEqual(d.calls, []);

  const denied = deps({ capabilities: ["document_view"] });
  assert.equal((await postWorkerPortraitStage(uploadRequest(source), "true", denied)).status, 403);
  assert.deepEqual(denied.calls, []);
});

test("failed stage registration removes the uploaded orphan", async () => {
  const source = await portraitWithExif();
  const d = deps({ createResult: { ok: false, kind: "unavailable" } });
  const response = await postWorkerPortraitStage(uploadRequest(source), "true", d);
  assert.equal(response.status, 503, JSON.stringify(await response.json()));
  assert.deepEqual(d.calls.map(([name]) => name), ["write", "create", "delete"]);
  assert.equal(d.calls[0][1].stage_id, d.calls[2][1]);
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
