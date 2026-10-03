import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  receiveDocumentWorkerCallback,
  signDocumentWorkerCallback,
} from "./document-worker-callback-api.ts";

const secret = randomBytes(32).toString("hex");
const callback = {
  callback_id: randomUUID(),
  document_id: "b2000000-0000-4000-8000-000000000001",
  document_version: 1,
  event_sequence: 1,
  attempt: 1,
  storage_object_ref: "p1.6/c2000000-0000-4000-8000-000000000001/CCCD_FRONT/1/b2000000-0000-4000-8000-000000000001",
  checksum_sha256: "a".repeat(64),
  size_bytes: 512,
  mime_type: "image/png",
  upload_outcome: "success",
  scan_outcome: "clean",
};

function request(payload = callback, signatureSecret = secret) {
  const body = Buffer.from(JSON.stringify(payload));
  return new Request("https://example.test/api/direct-entry/document-worker/callback", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-direct-entry-signature": signDocumentWorkerCallback(body, signatureSecret),
    },
    body,
  });
}

function dependencies(overrides = {}) {
  const calls = [];
  return {
    calls,
    secret,
    repository: {
      async applyDocumentWorkerCallback(input) {
        calls.push(input);
        return {
          ok: true,
          data: {
            document_id: input.document_id,
            document_version: input.document_version,
            entry_version: 2,
            event_sequence: 4,
            attempts: 1,
            upload_status: "READY",
            scan_status: "CLEAN",
            reused: false,
          },
        };
      },
      ...overrides.repository,
    },
    ...overrides,
  };
}

test("missing, malformed, or incorrect authentication rejects before repository mutation", async () => {
  const deps = dependencies();
  const missing = new Request("https://example.test/callback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(callback),
  });
  const badSignature = new Request("https://example.test/callback", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-direct-entry-signature": `sha256=${"0".repeat(64)}`,
    },
    body: JSON.stringify(callback),
  });
  assert.equal((await receiveDocumentWorkerCallback(missing, "true", deps)).status, 401);
  assert.equal((await receiveDocumentWorkerCallback(badSignature, "true", deps)).status, 401);
  assert.equal((await receiveDocumentWorkerCallback(request(), "true", {
    ...deps,
    secret: undefined,
  })).status, 401);
  assert.equal(deps.calls.length, 0);
});

test("valid authenticated callback submits only strict minimal fields and returns safe projection", async () => {
  const deps = dependencies();
  const response = await receiveDocumentWorkerCallback(request(), "true", deps);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.upload_status, "READY");
  assert.equal(body.scan_status, "CLEAN");
  assert.equal("storage_object_ref" in body, false);
  assert.equal("checksum_sha256" in body, false);
  assert.equal(JSON.stringify(body).includes(secret), false);
  assert.deepEqual(deps.calls, [callback]);
});

test("authority fields, public URLs, provider errors and invalid lifecycle values reject", async () => {
  const deps = dependencies();
  for (const payload of [
    { ...callback, actor: "forged" },
    { ...callback, public_url: "https://example.test/document" },
    { ...callback, raw_worker_error: "provider secret" },
    { ...callback, upload_status: "READY" },
    { ...callback, scan_status: "CLEAN", upload_outcome: "transient_failure" },
    { ...callback, attempt: 4 },
  ]) {
    assert.equal((await receiveDocumentWorkerCallback(request(payload), "true", deps)).status, 400);
  }
  assert.equal(deps.calls.length, 0);
});

test("repository conflicts become 409 and database messages are never returned", async () => {
  const deps = dependencies({
    repository: {
      async applyDocumentWorkerCallback() {
        return { ok: false, kind: "conflict" };
      },
    },
  });
  const response = await receiveDocumentWorkerCallback(request(), "true", deps);
  assert.equal(response.status, 409);
  assert.doesNotMatch(await response.text(), /raw|database|provider/i);
});

test("callback code uses HMAC constant-time verification and has no storage/client side effects", () => {
  const source = readFileSync(new URL("./document-worker-callback-api.ts", import.meta.url), "utf8");
  assert.match(source, /timingSafeEqual/);
  assert.doesNotMatch(source, /\.from\(["']direct_entry_/);
  assert.doesNotMatch(source, /\bfetch\s*\(/);
});
