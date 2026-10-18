import assert from "node:assert/strict";
import test from "node:test";

import sharp from "sharp";

import { sanitizeWorkerPortrait } from "./worker-portrait-sanitizer.ts";

test("re-encodes JPEG portraits without EXIF metadata", async () => {
  const source = await sharp({
    create: { width: 16, height: 12, channels: 3, background: { r: 40, g: 60, b: 80 } },
  }).jpeg().withMetadata({ exif: { IFD0: { Artist: "private-fixture-value" } } }).toBuffer();
  assert.ok((await sharp(source).metadata()).exif);

  const result = await sanitizeWorkerPortrait(source, "image/jpeg");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal((await sharp(result.bytes).metadata()).exif, undefined);
  assert.equal((await sharp(result.bytes).metadata()).format, "jpeg");
  assert.equal(Buffer.from(result.bytes).includes(Buffer.from("private-fixture-value")), false);
});

test("portrait sanitizer rejects unsupported formats and malformed image bytes", async () => {
  assert.deepEqual(
    await sanitizeWorkerPortrait(new Uint8Array([0x25, 0x50, 0x44, 0x46]), "application/pdf"),
    { ok: false },
  );
  assert.deepEqual(
    await sanitizeWorkerPortrait(new Uint8Array([0xff, 0xd8, 0xff]), "image/jpeg"),
    { ok: false },
  );
});
