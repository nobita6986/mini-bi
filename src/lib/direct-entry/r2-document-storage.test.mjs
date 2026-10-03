import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyStagingObject, finalObjectKey, genericDownloadName, inspectDocumentContent, sha256Hex, stagingObjectKey,
} from "./document-r2-contract.ts";
import { createR2DocumentStorage, loadR2Config } from "./r2-document-storage.ts";

const documentId = "b2000000-0000-4000-8000-000000000001";
const key = `p1.6/c2000000-0000-4000-8000-000000000001/CCCD_FRONT/1/${documentId}`;
const env = (extra = {}) => ({
  R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  R2_BUCKET_NAME: "hrp-bi-preview",
  R2_ACCESS_KEY_ID: "SYNTHETICACCESSKEY01",
  R2_SECRET_ACCESS_KEY: "synthetic-secret-value-0001",
  ...extra,
});
const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82);
const jpeg = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9);
const pdf = new TextEncoder().encode("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n");

function recorder() {
  const sent = [];
  return {
    sent,
    client: { async send(command) { sent.push(command); return {}; } },
    presign: async (_client, command, options) => {
      sent.push({ presign: command, options });
      return "https://signed.example.test/object?sig=synthetic";
    },
  };
}

test("missing, malformed or wrong-environment config fails closed before any network", async () => {
  const rec = recorder();
  for (const bad of [{}, env({ R2_ACCOUNT_ID: "short" }), env({ R2_BUCKET_NAME: "hrp-bi-product" }), env({ R2_BUCKET_NAME: undefined })]) {
    const storage = createR2DocumentStorage(bad, rec);
    assert.equal(storage.available(), false);
    await assert.rejects(storage.createUploadUrl({ storage_key: key, mime_type: "image/png", size_bytes: 1 }));
    await assert.rejects(storage.headStaged(key));
  }
  assert.deepEqual(rec.sent, []);
});

test("bucket is chosen server-side per environment", () => {
  assert.equal(loadR2Config(env())?.bucket, "hrp-bi-preview");
  assert.equal(loadR2Config(env({ VERCEL_ENV: "production" })), null);
  assert.equal(loadR2Config(env({ VERCEL_ENV: "production", R2_BUCKET_NAME: "hrp-bi-product" }))?.bucket, "hrp-bi-product");
});

test("presigned PUT is bound to staging key, content type, length and expires within five minutes", async () => {
  const rec = recorder();
  const storage = createR2DocumentStorage(env(), { ...rec, now: () => 1_000_000 });
  const signed = await storage.createUploadUrl({ storage_key: key, mime_type: "image/png", size_bytes: 512 });
  const call = rec.sent[0];
  assert.equal(call.presign.input.Bucket, "hrp-bi-preview");
  assert.equal(call.presign.input.Key, `preview/staging/${key}`);
  assert.equal(call.presign.input.ContentType, "image/png");
  assert.equal(call.presign.input.ContentLength, 512);
  assert.ok(call.options.expiresIn <= 300);
  assert.deepEqual(signed.headers, { "Content-Type": "image/png" });
  assert.equal(Date.parse(signed.expires_at) - 1_000_000, 300_000);
  assert.doesNotMatch(JSON.stringify(signed), /synthetic-secret|SYNTHETICACCESSKEY|hrp-bi-preview|p1\.6\//);
});

test("presigned GET is attachment-only with a generic name and lives at most two minutes", async () => {
  const rec = recorder();
  const storage = createR2DocumentStorage(env(), rec);
  await storage.createDownloadUrl({ storage_key: key, mime_type: "application/pdf", document_type: "CCCD_FRONT", version: 2 });
  const call = rec.sent[0];
  assert.ok(call.options.expiresIn <= 120);
  assert.equal(call.presign.input.Key, `preview/final/${key}`);
  assert.equal(call.presign.input.ResponseContentDisposition, 'attachment; filename="cccd-front-v2.pdf"');
});

test("promote copies staging to a final opaque key as attachment and delete targets staging only", async () => {
  const rec = recorder();
  const storage = createR2DocumentStorage(env(), rec);
  await storage.promote({ storage_key: key, mime_type: "image/png" });
  await storage.deleteStaged(key);
  assert.equal(rec.sent[0].input.Key, `preview/final/${key}`);
  assert.equal(rec.sent[0].input.CopySource, `hrp-bi-preview/preview/staging/${key}`);
  assert.equal(rec.sent[0].input.ContentDisposition, "attachment");
  assert.equal(rec.sent[1].input.Key, `preview/staging/${key}`);
});

test("head maps not-found to missing and oversize reads are rejected", async () => {
  const missing = createR2DocumentStorage(env(), { client: { async send() { throw { name: "NotFound" }; } } });
  assert.deepEqual(await missing.headStaged(key), { kind: "missing" });
  const big = createR2DocumentStorage(env(), {
    client: { async send() { return { ContentLength: 10 * 1024 * 1024 + 1, Body: { transformToByteArray: async () => new Uint8Array() } }; } },
  });
  await assert.rejects(big.readStaged(key));
});

test("object keys require opaque ids and never carry names", () => {
  assert.throws(() => stagingObjectKey("preview", "cccd-nguyen-van-a.png"));
  assert.equal(finalObjectKey("production", key), `production/final/${key}`);
  assert.doesNotMatch(genericDownloadName("CCCD_BACK", 1, "image/jpeg"), /[A-Z0-9]{9,}/);
});

test("content inspection accepts real signatures and rejects fakes and polyglots", () => {
  assert.equal(inspectDocumentContent({ document_type: "CCCD_FRONT", mime_type: "image/png", bytes: png }).ok, true);
  assert.equal(inspectDocumentContent({ document_type: "CCCD_FRONT", mime_type: "image/jpeg", bytes: jpeg }).ok, true);
  assert.equal(inspectDocumentContent({ document_type: "EMPLOYMENT_CONTRACT", mime_type: "application/pdf", bytes: pdf }).ok, true);
  assert.equal(inspectDocumentContent({ document_type: "CCCD_FRONT", mime_type: "image/png", bytes: jpeg }).ok, false);
  const text = new TextEncoder().encode("<html><script>alert(1)</script>");
  assert.equal(inspectDocumentContent({ document_type: "CCCD_FRONT", mime_type: "image/png", bytes: text }).ok, false);
  const polyglot = Uint8Array.from([...jpeg.slice(0, 7), ...new TextEncoder().encode("<script>x</script>"), 0xff, 0xd9]);
  assert.equal(inspectDocumentContent({ document_type: "CCCD_FRONT", mime_type: "image/jpeg", bytes: polyglot }).ok, false);
  const truncatedPdf = new TextEncoder().encode("%PDF-1.4 no trailer");
  assert.equal(inspectDocumentContent({ document_type: "EMPLOYMENT_CONTRACT", mime_type: "application/pdf", bytes: truncatedPdf }).ok, false);
});

test("sha256 is computed from bytes and staging cleanup contract is fixed", () => {
  assert.equal(sha256Hex(new TextEncoder().encode("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(classifyStagingObject({ ageHours: 1, invalid: true, finalized: false }), "delete-invalid");
  assert.equal(classifyStagingObject({ ageHours: 23, invalid: false, finalized: false }), "keep");
  assert.equal(classifyStagingObject({ ageHours: 24, invalid: false, finalized: false }), "eligible-for-cleanup");
});