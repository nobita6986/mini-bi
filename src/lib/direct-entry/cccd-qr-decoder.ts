import "server-only";

import jsQR from "jsqr";
import sharp, { type Sharp } from "sharp";

import {
  parseCccdQrPayload,
  type CccdQrCandidateData,
  type CccdQrErrorCode,
  type CccdQrErrorField,
} from "./cccd-qr-contract.ts";

export type CccdQrDecodeResult =
  | {
      status: "SUCCEEDED";
      candidate_data: CccdQrCandidateData;
      error_code: null;
      error_field: null;
    }
  | {
      status: "NO_QR_FOUND";
      candidate_data: null;
      error_code: "QR_NOT_DETECTED" | "QR_IMAGE_UNREADABLE";
      error_field: null;
    }
  | {
      status: "INVALID_QR";
      candidate_data: null;
      error_code: CccdQrErrorCode;
      error_field: CccdQrErrorField;
    }
  | {
      status: "FAILED_RETRYABLE";
      candidate_data: null;
      error_code: "QR_DECODE_FAILED";
      error_field: null;
    };

export type CccdQrDecoderOptions = {
  referenceDateIso?: string;
};

const MAX_DECODE_DIMENSION = 1600;
const MIN_DECODE_DIMENSION = 360;
const MAX_INPUT_PIXELS = 64_000_000;

function extractQrText(binaryData: readonly number[], fallbackText: string): string {
  if (Array.isArray(binaryData) && binaryData.length > 0) {
    try {
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
        Uint8Array.from(binaryData),
      );
      if (decoded.trim().length > 0) {
        return decoded;
      }
    } catch {
      // Fallback to jsQR string decoding when byte payload is not raw UTF-8.
    }
  }
  return fallbackText;
}

async function tryDecodePipeline(pipeline: Sharp): Promise<string | null> {
  const { data, info } = await pipeline
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.width <= 0 || info.height <= 0 || info.channels !== 4) {
    return null;
  }
  const clamped = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);
  const result = jsQR(clamped, info.width, info.height, {
    inversionAttempts: "attemptBoth",
  });
  if (!result) return null;
  return extractQrText(result.binaryData, result.data);
}

function buildScalePipeline(
  input: Buffer,
  width: number,
  height: number,
  rotationAngle?: 90 | 180 | 270,
): Sharp {
  let img = sharp(input, { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS }).rotate();
  if (rotationAngle) {
    img = img.rotate(rotationAngle);
  }
  const effectiveW = rotationAngle === 90 || rotationAngle === 270 ? height : width;
  const effectiveH = rotationAngle === 90 || rotationAngle === 270 ? width : height;
  const maxDim = Math.max(effectiveW, effectiveH);
  const minDim = Math.min(effectiveW, effectiveH);

  if (maxDim > MAX_DECODE_DIMENSION) {
    return img.resize({
      width: MAX_DECODE_DIMENSION,
      height: MAX_DECODE_DIMENSION,
      fit: "inside",
      withoutEnlargement: true,
    });
  }
  if (minDim < MIN_DECODE_DIMENSION && maxDim > 0) {
    const scale = Math.min(4, Math.ceil(MIN_DECODE_DIMENSION / Math.max(1, minDim)));
    return img.resize({
      width: effectiveW * scale,
      height: effectiveH * scale,
      kernel: sharp.kernel.nearest,
    });
  }
  return img;
}

function buildTopRightCropPipeline(
  input: Buffer,
  width: number,
  height: number,
): Sharp | null {
  if (width < 120 || height < 120) return null;
  const cropLeft = Math.floor(width * 0.42);
  const cropWidth = width - cropLeft;
  const cropHeight = Math.floor(height * 0.62);
  if (cropWidth < 64 || cropHeight < 64) return null;

  const targetWidth = Math.min(1200, Math.max(640, cropWidth * 2));
  return sharp(input, { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS })
    .rotate()
    .extract({ left: cropLeft, top: 0, width: cropWidth, height: cropHeight })
    .resize({ width: targetWidth, withoutEnlargement: false, kernel: sharp.kernel.lanczos3 });
}

/**
 * Decodes and validates a Vietnamese CCCD QR code from raw image bytes (JPEG/PNG).
 *
 * Security invariants:
 * - Never logs or returns raw QR payload or decoded PII in any error path.
 * - Uses bounded pixel limits and pure in-memory buffers.
 */
export async function decodeCccdQrFromImageBytes(
  imageBytes: Uint8Array,
  options: CccdQrDecoderOptions = {},
): Promise<CccdQrDecodeResult> {
  if (!(imageBytes instanceof Uint8Array) || imageBytes.byteLength === 0) {
    return {
      status: "NO_QR_FOUND",
      candidate_data: null,
      error_code: "QR_IMAGE_UNREADABLE",
      error_field: null,
    };
  }

  const buffer = Buffer.from(imageBytes.buffer, imageBytes.byteOffset, imageBytes.byteLength);
  let width = 0;
  let height = 0;
  try {
    const metadata = await sharp(buffer, {
      failOn: "error",
      limitInputPixels: MAX_INPUT_PIXELS,
    }).metadata();
    if (
      !metadata.width ||
      !metadata.height ||
      metadata.width <= 0 ||
      metadata.height <= 0 ||
      (metadata.format !== "jpeg" && metadata.format !== "png" && metadata.format !== "webp")
    ) {
      return {
        status: "NO_QR_FOUND",
        candidate_data: null,
        error_code: "QR_IMAGE_UNREADABLE",
        error_field: null,
      };
    }
    const orientedSwap = metadata.orientation !== undefined && metadata.orientation >= 5 && metadata.orientation <= 8;
    width = orientedSwap ? metadata.height : metadata.width;
    height = orientedSwap ? metadata.width : metadata.height;
  } catch {
    return {
      status: "NO_QR_FOUND",
      candidate_data: null,
      error_code: "QR_IMAGE_UNREADABLE",
      error_field: null,
    };
  }

  const candidateBuilders: Array<() => Sharp | null> = [
    // Pass 1: Standard auto-oriented full image
    () => buildScalePipeline(buffer, width, height),
    // Pass 2: Top-right quadrant crop (where QR resides on Vietnamese chip-based CCCD front)
    () => buildTopRightCropPipeline(buffer, width, height),
    // Pass 3: Normalized + sharpened grayscale full image
    () => buildScalePipeline(buffer, width, height).grayscale().normalize().sharpen(),
    // Pass 4: Normalized + sharpened grayscale top-right crop
    () => {
      const crop = buildTopRightCropPipeline(buffer, width, height);
      return crop ? crop.grayscale().normalize().sharpen() : null;
    },
    // Pass 5: High-contrast binary thresholded full image
    () => buildScalePipeline(buffer, width, height).grayscale().normalize().threshold(128),
    // Pass 6: High-contrast binary thresholded top-right crop
    () => {
      const crop = buildTopRightCropPipeline(buffer, width, height);
      return crop ? crop.grayscale().normalize().threshold(128) : null;
    },
    // Pass 7–9: 90°, 180°, 270° rotated passes for sideways/upside-down captures without EXIF
    () => buildScalePipeline(buffer, width, height, 90).grayscale().normalize(),
    () => buildScalePipeline(buffer, width, height, 180).grayscale().normalize(),
    () => buildScalePipeline(buffer, width, height, 270).grayscale().normalize(),
  ];

  let rawQrText: string | null = null;
  try {
    for (const build of candidateBuilders) {
      const pipeline = build();
      if (!pipeline) continue;
      const decoded = await tryDecodePipeline(pipeline);
      if (decoded !== null) {
        rawQrText = decoded;
        break;
      }
    }
  } catch {
    console.error("[direct-entry] cccd qr image decode pipeline failed");
    return {
      status: "FAILED_RETRYABLE",
      candidate_data: null,
      error_code: "QR_DECODE_FAILED",
      error_field: null,
    };
  }

  if (rawQrText === null) {
    return {
      status: "NO_QR_FOUND",
      candidate_data: null,
      error_code: "QR_NOT_DETECTED",
      error_field: null,
    };
  }

  const parsed = parseCccdQrPayload(rawQrText, {
    referenceDateIso: options.referenceDateIso,
  });
  if (!parsed.ok) {
    return {
      status: "INVALID_QR",
      candidate_data: null,
      error_code: parsed.error_code,
      error_field: parsed.error_field,
    };
  }

  return {
    status: "SUCCEEDED",
    candidate_data: parsed.data,
    error_code: null,
    error_field: null,
  };
}
