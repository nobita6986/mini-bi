import "server-only";

import sharp from "sharp";
import type { DocumentMimeType } from "./document-r2-contract.ts";
import { DOCUMENT_MAX_BYTES } from "./document-upload-contract.ts";

export type WorkerPortraitMimeType = "image/jpeg" | "image/png";

export async function sanitizeWorkerPortrait(
  bytes: Uint8Array,
  mimeType: DocumentMimeType,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false }> {
  if (mimeType !== "image/jpeg" && mimeType !== "image/png") return { ok: false };
  try {
    const image = sharp(bytes, { failOn: "error", limitInputPixels: 40_000_000 });
    const metadata = await image.metadata();
    const expectedFormat = mimeType === "image/jpeg" ? "jpeg" : "png";
    if (metadata.format !== expectedFormat || (metadata.pages ?? 1) !== 1) {
      return { ok: false };
    }

    const output = mimeType === "image/jpeg"
      ? await image.rotate().jpeg({ quality: 95 }).toBuffer()
      : await image.rotate().png().toBuffer();
    if (output.byteLength < 1 || output.byteLength > DOCUMENT_MAX_BYTES) {
      return { ok: false };
    }
    return { ok: true, bytes: new Uint8Array(output) };
  } catch {
    return { ok: false };
  }
}
