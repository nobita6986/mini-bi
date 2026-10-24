import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  createR2VendorFinanceEvidenceStorage,
  inspectVfinEvidenceContent,
  isOpaqueVfinEvidenceStorageKey,
  vfinFinalObjectKey,
  vfinStagingObjectKey,
} from "./r2-evidence-storage.ts";
import { VENDOR_FINANCE_EVIDENCE_MAX_BYTES } from "./vendor-finance-contract.ts";

const TARGET_UUID = "11111111-1111-4111-8111-111111111111";
const EVIDENCE_UUID = "22222222-2222-4222-8222-222222222222";
const VALID_ENTRY_KEY = `vfin-01/entry/${TARGET_UUID}/${EVIDENCE_UUID}`;
const VALID_REC_KEY = `vfin-01/reconciliation/${TARGET_UUID}/${EVIDENCE_UUID}`;

const VALID_JPEG_BYTES = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9,
]);
const VALID_PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x00,
  0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

const VALID_R2_ENV = Object.freeze({
  DOCUMENT_STORAGE_ENVIRONMENT: "preview",
  R2_ACCOUNT_ID: "a".repeat(32),
  R2_BUCKET_NAME: "hrp-bi-preview",
  R2_ACCESS_KEY_ID: "A".repeat(24),
  R2_SECRET_ACCESS_KEY: "B".repeat(40),
});

test("opaque VFIN R2 storage key accepts only vfin-01/(entry|reconciliation)/<uuid>/<uuid> and rejects PII/filenames/vendor_id", () => {
  assert.equal(isOpaqueVfinEvidenceStorageKey(VALID_ENTRY_KEY), true);
  assert.equal(isOpaqueVfinEvidenceStorageKey(VALID_REC_KEY), true);
  assert.equal(vfinStagingObjectKey("preview", VALID_ENTRY_KEY), `preview/staging/${VALID_ENTRY_KEY}`);
  assert.equal(vfinFinalObjectKey("production", VALID_REC_KEY), `production/final/${VALID_REC_KEY}`);

  for (const invalidKey of [
    `vfin-01/VND_ALPHA/${TARGET_UUID}/${EVIDENCE_UUID}`,
    `vfin-01/entry/${TARGET_UUID}/uy-nhiem-chi-cong-ty-a.jpg`,
    `vfin-01/entry/../${TARGET_UUID}/${EVIDENCE_UUID}`,
    `p1.6/${TARGET_UUID}/CCCD_FRONT/1/${EVIDENCE_UUID}`,
    `${VALID_ENTRY_KEY}?secret=1`,
    "",
  ]) {
    assert.equal(isOpaqueVfinEvidenceStorageKey(invalidKey), false, `must reject ${invalidKey}`);
    assert.throws(() => vfinStagingObjectKey("preview", invalidKey));
    assert.throws(() => vfinFinalObjectKey("preview", invalidKey));
  }
});

test("inspectVfinEvidenceContent verifies JPEG/PNG magic header + trailer, size, embedded markup, and SHA-256", () => {
  const jpegCheck = inspectVfinEvidenceContent({
    mime_type: "image/jpeg",
    expected_size_bytes: VALID_JPEG_BYTES.byteLength,
    expected_checksum_sha256: sha256(VALID_JPEG_BYTES),
    bytes: VALID_JPEG_BYTES,
  });
  assert.equal(jpegCheck.ok, true);

  const pngCheck = inspectVfinEvidenceContent({
    mime_type: "image/png",
    expected_size_bytes: VALID_PNG_BYTES.byteLength,
    expected_checksum_sha256: sha256(VALID_PNG_BYTES),
    bytes: VALID_PNG_BYTES,
  });
  assert.equal(pngCheck.ok, true);

  // Unsupported MIME
  assert.deepEqual(
    inspectVfinEvidenceContent({
      mime_type: "application/pdf",
      expected_size_bytes: VALID_JPEG_BYTES.byteLength,
      expected_checksum_sha256: sha256(VALID_JPEG_BYTES),
      bytes: VALID_JPEG_BYTES,
    }),
    { ok: false, code: "VENDOR_FINANCE_EVIDENCE_MIME_INVALID" },
  );

  // Size mismatch or > 10 MiB
  assert.deepEqual(
    inspectVfinEvidenceContent({
      mime_type: "image/jpeg",
      expected_size_bytes: VALID_JPEG_BYTES.byteLength + 1,
      expected_checksum_sha256: sha256(VALID_JPEG_BYTES),
      bytes: VALID_JPEG_BYTES,
    }),
    { ok: false, code: "VENDOR_FINANCE_EVIDENCE_SIZE_INVALID" },
  );

  // Truncated JPEG missing FFD9 trailer
  const truncatedJpeg = VALID_JPEG_BYTES.subarray(0, VALID_JPEG_BYTES.byteLength - 2);
  assert.deepEqual(
    inspectVfinEvidenceContent({
      mime_type: "image/jpeg",
      expected_size_bytes: truncatedJpeg.byteLength,
      expected_checksum_sha256: sha256(truncatedJpeg),
      bytes: truncatedJpeg,
    }),
    { ok: false, code: "VENDOR_FINANCE_EVIDENCE_CONTENT_INVALID" },
  );

  // Polyglot JPEG containing embedded <script>
  const polyglotJpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.from("<script>alert(1)</script>", "utf8"),
    Buffer.from([0xff, 0xd9]),
  ]);
  assert.deepEqual(
    inspectVfinEvidenceContent({
      mime_type: "image/jpeg",
      expected_size_bytes: polyglotJpeg.byteLength,
      expected_checksum_sha256: sha256(polyglotJpeg),
      bytes: polyglotJpeg,
    }),
    { ok: false, code: "VENDOR_FINANCE_EVIDENCE_CONTENT_INVALID" },
  );

  // SHA-256 mismatch
  assert.deepEqual(
    inspectVfinEvidenceContent({
      mime_type: "image/png",
      expected_size_bytes: VALID_PNG_BYTES.byteLength,
      expected_checksum_sha256: "f".repeat(64),
      bytes: VALID_PNG_BYTES,
    }),
    { ok: false, code: "VENDOR_FINANCE_EVIDENCE_CHECKSUM_INVALID" },
  );
});

test("createR2VendorFinanceEvidenceStorage signs short-lived private PUT/GET URLs, bounds reads <= 10 MiB, promotes staged -> final, and cleans staged", async () => {
  const unavailable = createR2VendorFinanceEvidenceStorage({});
  assert.equal(unavailable.available(), false);

  const sentCommands = [];
  const presignCalls = [];
  let getObjectMode = "valid";
  let deleteObjectMode = "ok";

  const storage = createR2VendorFinanceEvidenceStorage(VALID_R2_ENV, {
    now: () => Date.parse("2026-10-24T02:00:00.000Z"),
    client: {
      async send(command) {
        sentCommands.push(command);
        const name = command.constructor.name;
        if (name === "GetObjectCommand") {
          if (getObjectMode === "missing") {
            const err = new Error("NoSuchKey");
            err.name = "NoSuchKey";
            throw err;
          }
          if (getObjectMode === "oversized-header") {
            return {
              ContentLength: VENDOR_FINANCE_EVIDENCE_MAX_BYTES + 1,
              Body: { transformToByteArray: async () => VALID_JPEG_BYTES },
            };
          }
          return {
            ContentLength: VALID_JPEG_BYTES.byteLength,
            Body: { transformToByteArray: async () => VALID_JPEG_BYTES },
          };
        }
        if (name === "DeleteObjectCommand" && deleteObjectMode === "missing") {
          const err = new Error("NoSuchKey");
          err.name = "NoSuchKey";
          throw err;
        }
        return {};
      },
    },
    async presign(_client, command, options) {
      presignCalls.push({ command, options });
      return `https://signed.r2.example/${command.input.Key}?X-Amz-Expires=${options.expiresIn}`;
    },
  });

  assert.equal(storage.available(), true);

  // 1. Presigned PUT to staging (300s)
  const upload = await storage.createUploadUrl({
    storage_key: VALID_ENTRY_KEY,
    mime_type: "image/jpeg",
    size_bytes: VALID_JPEG_BYTES.byteLength,
  });
  assert.equal(upload.expires_at, "2026-10-24T02:05:00.000Z");
  assert.deepEqual(upload.headers, { "Content-Type": "image/jpeg" });
  assert.equal(presignCalls[0].command.input.Key, `preview/staging/${VALID_ENTRY_KEY}`);
  assert.equal(presignCalls[0].options.expiresIn, 300);

  // 2. Bounded read from staging
  const found = await storage.readStagedBounded(VALID_ENTRY_KEY);
  assert.equal(found.kind, "found");
  assert.equal(found.bytes.byteLength, VALID_JPEG_BYTES.byteLength);

  getObjectMode = "missing";
  assert.deepEqual(await storage.readStagedBounded(VALID_ENTRY_KEY), { kind: "missing" });

  getObjectMode = "oversized-header";
  assert.deepEqual(await storage.readStagedBounded(VALID_ENTRY_KEY), { kind: "too-large" });

  // 3. Promote staged -> final MUST copy ONLY and keep staged intact until DB confirms READY
  sentCommands.length = 0;
  await storage.promoteStagedToFinal({
    storage_key: VALID_ENTRY_KEY,
    mime_type: "image/jpeg",
  });
  assert.equal(sentCommands.length, 1);
  assert.equal(sentCommands[0].constructor.name, "CopyObjectCommand");
  assert.equal(sentCommands[0].input.Key, `preview/final/${VALID_ENTRY_KEY}`);
  assert.equal(sentCommands[0].input.CopySource, `hrp-bi-preview/preview/staging/${VALID_ENTRY_KEY}`);

  // 3b. Explicit staged & final cleanup (idempotent on NoSuchKey)
  sentCommands.length = 0;
  await storage.deleteStaged(VALID_ENTRY_KEY);
  await storage.deleteFinal(VALID_ENTRY_KEY);
  assert.equal(sentCommands.length, 2);
  assert.equal(sentCommands[0].constructor.name, "DeleteObjectCommand");
  assert.equal(sentCommands[0].input.Key, `preview/staging/${VALID_ENTRY_KEY}`);
  assert.equal(sentCommands[1].constructor.name, "DeleteObjectCommand");
  assert.equal(sentCommands[1].input.Key, `preview/final/${VALID_ENTRY_KEY}`);

  deleteObjectMode = "missing";
  await storage.deleteStaged(VALID_ENTRY_KEY);
  await storage.deleteFinal(VALID_ENTRY_KEY);

  // 4. Short-lived download URL (120s) with generic attachment filename
  const download = await storage.createDownloadUrl({
    storage_key: VALID_ENTRY_KEY,
    mime_type: "image/jpeg",
  });
  assert.equal(download.expires_at, "2026-10-24T02:02:00.000Z");
  const dlCommand = presignCalls[1].command;
  assert.equal(dlCommand.input.Key, `preview/final/${VALID_ENTRY_KEY}`);
  assert.equal(dlCommand.input.ResponseContentDisposition, 'attachment; filename="vfin-evidence.jpg"');
  assert.equal(dlCommand.input.ResponseContentType, "image/jpeg");
  assert.equal(presignCalls[1].options.expiresIn, 120);
});
