import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { safeOutboundRequest } from "../ai-config/safe-outbound.ts";
import {
  createDocumentWorkerAdapter,
  documentWorkerLimits,
} from "./document-worker-adapter.ts";

const configuration = {
  DIRECT_ENTRY_DOCUMENT_WORKER_URL: "https://worker.example.com/upload",
  DIRECT_ENTRY_DOCUMENT_WORKER_ALLOWED_HOSTS: "worker.example.com",
  DIRECT_ENTRY_DOCUMENT_WORKER_TOKEN: "synthetic-runtime-token-value",
};
const input = {
  entry_id: "a2000000-0000-4000-8000-000000000001",
  document_id: "b2000000-0000-4000-8000-000000000001",
  document_type: "CCCD_FRONT",
  version: 1,
  event_sequence: 1,
  attempt: 1,
  storage_key: "p1.6/c2000000-0000-4000-8000-000000000001/CCCD_FRONT/1/b2000000-0000-4000-8000-000000000001",
  checksum_sha256: "a".repeat(64),
  size_bytes: 8,
  mime_type: "image/png",
  bytes: Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
  idempotency_key: "synthetic-upload-key",
};

test("missing or non-allowlisted worker configuration is unavailable without outbound", async () => {
  const calls = [];
  const transport = async (...args) => {
    calls.push(args);
    return { statusCode: 202, headers: {}, body: Buffer.from('{"accepted":true,"job_id":"x"}') };
  };
  const missing = createDocumentWorkerAdapter({}, transport);
  assert.equal(missing.available(), false);
  assert.deepEqual(await missing.upload(input), { kind: "unavailable" });
  const rejected = createDocumentWorkerAdapter({
    ...configuration,
    DIRECT_ENTRY_DOCUMENT_WORKER_URL: "https://untrusted.example.com/upload",
  }, transport);
  assert.equal(rejected.available(), false);
  assert.equal(calls.length, 0);
});

test("worker dispatch uses pinned HTTPS guard, exact server payload and bounded transport", async () => {
  const requests = [];
  const transportOptions = [];
  const transport = (url, options) => {
    transportOptions.push(options);
    return safeOutboundRequest(url, {
      ...options,
      resolve: async (hostname) => {
        assert.equal(hostname, "worker.example.com");
        return ["8.8.8.8"];
      },
      request: async (request) => {
        requests.push(request);
        return {
          statusCode: 202,
          headers: { "content-type": "application/json" },
          body: Buffer.from('{"accepted":true,"job_id":"job_opaque_01"}'),
        };
      },
    });
  };
  const adapter = createDocumentWorkerAdapter(configuration, transport);
  assert.equal(adapter.available(), true);
  assert.deepEqual(await adapter.upload(input), {
    kind: "durable",
    document_id: input.document_id,
    version: input.version,
    storage_key: input.storage_key,
    object_version: "job_opaque_01",
    checksum_sha256: input.checksum_sha256,
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url.protocol, "https:");
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].headers.authorization, `Bearer ${configuration.DIRECT_ENTRY_DOCUMENT_WORKER_TOKEN}`);
  const payload = JSON.parse(requests[0].body);
  assert.deepEqual(Object.keys(payload).sort(), [
    "attempt", "checksum_sha256", "content_base64", "document_id", "document_type",
    "document_version", "event_sequence", "idempotency_key", "mime_type",
    "protocol_version", "size_bytes", "storage_object_ref",
  ]);
  assert.equal("filename" in payload, false);
  assert.equal("public_url" in payload, false);
  assert.equal(Buffer.from(payload.content_base64, "base64").length, input.bytes.length);
  assert.equal(documentWorkerLimits.timeout_ms, 30_000);
  assert.equal(documentWorkerLimits.max_request_bytes, 15 * 1024 * 1024);
  assert.equal(documentWorkerLimits.max_response_bytes, 4 * 1024);
  assert.equal(transportOptions[0].timeoutMs, 30_000);
  assert.equal(transportOptions[0].maxRequestBytes, 15 * 1024 * 1024);
  assert.equal(transportOptions[0].maxResponseBytes, 4 * 1024);
});

test("maximum-size document fits the exact encoded request ceiling", async () => {
  let requestSize = 0;
  const transport = (url, options) => safeOutboundRequest(url, {
    ...options,
    resolve: async () => ["8.8.8.8"],
    request: async ({ body }) => {
      requestSize = Buffer.byteLength(body ?? "");
      return {
        statusCode: 202,
        headers: {},
        body: Buffer.from('{"accepted":true,"job_id":"job_max_file"}'),
      };
    },
  });
  const adapter = createDocumentWorkerAdapter(configuration, transport);
  const result = await adapter.upload({
    ...input,
    size_bytes: 10 * 1024 * 1024,
    bytes: Buffer.alloc(10 * 1024 * 1024),
  });
  assert.equal(result.kind, "durable");
  assert.ok(requestSize > 10 * 1024 * 1024);
  assert.ok(requestSize < documentWorkerLimits.max_request_bytes);
});

test("private DNS answers and cross-origin redirects stop before following", async () => {
  let outbound = 0;
  const privateAdapter = createDocumentWorkerAdapter(configuration, (url, options) =>
    safeOutboundRequest(url, {
      ...options,
      resolve: async () => ["169.254.169.254"],
      request: async () => {
        outbound += 1;
        throw new Error("must not request");
      },
    })
  );
  assert.deepEqual(await privateAdapter.upload(input), { kind: "unavailable" });
  assert.equal(outbound, 0);

  let requests = 0;
  const redirectAdapter = createDocumentWorkerAdapter(configuration, (url, options) =>
    safeOutboundRequest(url, {
      ...options,
      resolve: async () => ["8.8.8.8"],
      request: async () => {
        requests += 1;
        return {
          statusCode: 307,
          headers: { location: "https://evil.example.com/steal" },
          body: Buffer.alloc(0),
        };
      },
    })
  );
  assert.deepEqual(await redirectAdapter.upload(input), { kind: "unavailable" });
  assert.equal(requests, 1);
});

test("worker protocol has no raw fetch, and acknowledgement/errors are sanitized", async () => {
  const source = readFileSync(new URL("./document-worker-adapter.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  const adapter = createDocumentWorkerAdapter(configuration, async () => ({
    statusCode: 500,
    headers: {},
    body: Buffer.from("sensitive worker failure"),
  }));
  assert.deepEqual(await adapter.upload(input), { kind: "unavailable" });
});
