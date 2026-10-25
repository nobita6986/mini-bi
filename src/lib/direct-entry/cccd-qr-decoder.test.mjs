import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";

import { decodeCccdQrFromImageBytes } from "./cccd-qr-decoder.ts";

const REFERENCE_DATE = "2026-10-25";

/**
 * Pure-JS QR Code Version 5-L (37x37, single RS block: 108 data + 26 EC bytes)
 * matrix generator for deterministic PNG/JPEG test fixtures.
 */
function encodeQrVersion5LMatrix(utf8Text) {
  const payloadBytes = Buffer.from(utf8Text, "utf8");
  assert.ok(payloadBytes.length <= 106, "Version 5-L supports up to 106 UTF-8 bytes");

  const dataWords = [];
  let bitBuffer = 0;
  let bitCount = 0;
  const pushBits = (value, length) => {
    for (let i = length - 1; i >= 0; i -= 1) {
      bitBuffer = (bitBuffer << 1) | ((value >>> i) & 1);
      bitCount += 1;
      if (bitCount === 8) {
        dataWords.push(bitBuffer & 0xff);
        bitBuffer = 0;
        bitCount = 0;
      }
    }
  };

  // Byte mode indicator (0100) + 8-bit byte count
  pushBits(0b0100, 4);
  pushBits(payloadBytes.length, 8);
  for (const b of payloadBytes) {
    pushBits(b, 8);
  }
  // Terminator (up to 4 zero bits)
  const remainingDataBits = 108 * 8 - (dataWords.length * 8 + bitCount);
  pushBits(0, Math.min(4, Math.max(0, remainingDataBits)));
  if (bitCount > 0) {
    pushBits(0, 8 - bitCount);
  }
  const padBytes = [0xec, 0x11];
  let padIdx = 0;
  while (dataWords.length < 108) {
    dataWords.push(padBytes[padIdx % 2]);
    padIdx += 1;
  }

  // GF(256) with primitive polynomial 0x11d
  const gfExp = new Uint8Array(512);
  const gfLog = new Uint8Array(256);
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    gfExp[i] = x;
    gfLog[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) {
    gfExp[i] = gfExp[i - 255];
  }
  const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : gfExp[gfLog[a] + gfLog[b]]);

  // Generator polynomial for 26 EC codewords
  const ecCount = 26;
  let poly = [1];
  for (let i = 0; i < ecCount; i += 1) {
    const next = new Array(poly.length + 1).fill(0);
    const root = gfExp[i];
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], root);
    }
    poly = next;
  }

  const ecWords = new Array(ecCount).fill(0);
  for (const byte of dataWords) {
    const factor = byte ^ ecWords[0];
    ecWords.shift();
    ecWords.push(0);
    if (factor !== 0) {
      for (let j = 0; j < ecCount; j += 1) {
        ecWords[j] ^= gfMul(poly[j + 1], factor);
      }
    }
  }

  const allCodewords = [...dataWords, ...ecWords];
  const size = 37;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const isFunction = Array.from({ length: size }, () => new Array(size).fill(false));

  const setFunctionModule = (r, c, dark) => {
    if (r < 0 || r >= size || c < 0 || c >= size) return;
    modules[r][c] = Boolean(dark);
    isFunction[r][c] = true;
  };

  // Finder patterns + separators
  const placeFinder = (top, left) => {
    for (let dy = -1; dy <= 7; dy += 1) {
      for (let dx = -1; dx <= 7; dx += 1) {
        const r = top + dy;
        const c = left + dx;
        const inOuter = dy >= 0 && dy <= 6 && dx >= 0 && dx <= 6;
        const onBorder = dy === 0 || dy === 6 || dx === 0 || dx === 6;
        const inCore = dy >= 2 && dy <= 4 && dx >= 2 && dx <= 4;
        setFunctionModule(r, c, inOuter && (onBorder || inCore));
      }
    }
  };
  placeFinder(0, 0);
  placeFinder(0, size - 7);
  placeFinder(size - 7, 0);

  // Timing patterns
  for (let i = 8; i < size - 8; i += 1) {
    setFunctionModule(6, i, i % 2 === 0);
    setFunctionModule(i, 6, i % 2 === 0);
  }

  // Alignment pattern at (30, 30) for Version 5
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      const dist = Math.max(Math.abs(dy), Math.abs(dx));
      setFunctionModule(30 + dy, 30 + dx, dist !== 1);
    }
  }

  // Reserve format info areas + dark module
  for (let i = 0; i <= 8; i += 1) {
    if (i !== 6) {
      setFunctionModule(8, i, false);
      setFunctionModule(i, 8, false);
    }
  }
  for (let i = 0; i < 8; i += 1) {
    setFunctionModule(8, size - 1 - i, false);
    setFunctionModule(size - 1 - i, 8, false);
  }
  setFunctionModule(size - 8, 8, true);

  // Place data + EC bits in upward/downward 2-column zigzag
  let bitIdx = 0;
  const totalBits = allCodewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = (( right + 1 ) & 2) === 0;
    for (let vert = 0; vert < size; vert += 1) {
      const r = upward ? size - 1 - vert : vert;
      for (let j = 0; j < 2; j += 1) {
        const c = right - j;
        if (isFunction[r][c]) continue;
        let dark = false;
        if (bitIdx < totalBits) {
          const byte = allCodewords[bitIdx >>> 3];
          dark = ((byte >>> (7 - (bitIdx & 7))) & 1) === 1;
          bitIdx += 1;
        }
        // Mask 0: (r + c) % 2 === 0
        if ((r + c) % 2 === 0) {
          dark = !dark;
        }
        modules[r][c] = dark;
      }
    }
  }

  // Format bits for EC Level L (01) + Mask 0 (000) -> 0x77c4
  const formatBits = 0x77c4;
  const getFormatBit = (i) => ((formatBits >>> i) & 1) === 1;

  for (let i = 0; i <= 5; i += 1) setFunctionModule(8, i, getFormatBit(i));
  setFunctionModule(8, 7, getFormatBit(6));
  setFunctionModule(8, 8, getFormatBit(7));
  setFunctionModule(7, 8, getFormatBit(8));
  for (let i = 9; i < 15; i += 1) setFunctionModule(14 - i, 8, getFormatBit(i));

  for (let i = 0; i < 8; i += 1) setFunctionModule(8, size - 1 - i, getFormatBit(i));
  for (let i = 8; i < 15; i += 1) setFunctionModule(size - 15 + i, 8, getFormatBit(i));
  setFunctionModule(size - 8, 8, true);

  return modules;
}

async function renderQrPngBuffer(utf8Text, { moduleScale = 8, marginModules = 4 } = {}) {
  const matrix = encodeQrVersion5LMatrix(utf8Text);
  const matrixSize = matrix.length;
  const totalModules = matrixSize + marginModules * 2;
  const pixelSize = totalModules * moduleScale;
  const raw = Buffer.alloc(pixelSize * pixelSize * 3, 255);

  for (let r = 0; r < matrixSize; r += 1) {
    for (let c = 0; c < matrixSize; c += 1) {
      if (!matrix[r][c]) continue;
      const startY = (r + marginModules) * moduleScale;
      const startX = (c + marginModules) * moduleScale;
      for (let py = 0; py < moduleScale; py += 1) {
        for (let px = 0; px < moduleScale; px += 1) {
          const offset = ((startY + py) * pixelSize + (startX + px)) * 3;
          raw[offset] = 0;
          raw[offset + 1] = 0;
          raw[offset + 2] = 0;
        }
      }
    }
  }

  return sharp(raw, {
    raw: { width: pixelSize, height: pixelSize, channels: 3 },
  })
    .png()
    .toBuffer();
}

test("decodeCccdQrFromImageBytes decodes standard CCCD QR PNG image with Vietnamese UTF-8 diacritics", async () => {
  const qrPayload =
    "079095001234|025123456|Nguyễn Văn An|15081995|Nam|123 Nguyễn Trãi, Q.1, TP.HCM|20102021";
  const pngBuffer = await renderQrPngBuffer(qrPayload);

  const result = await decodeCccdQrFromImageBytes(new Uint8Array(pngBuffer), {
    referenceDateIso: REFERENCE_DATE,
  });

  assert.equal(result.status, "SUCCEEDED");
  if (result.status !== "SUCCEEDED") return;
  assert.equal(result.error_code, null);
  assert.equal(result.error_field, null);
  assert.deepEqual(result.candidate_data, {
    source: "CCCD_QR",
    authenticity: "UNVERIFIED_QR_TEXT",
    national_id: "079095001234",
    legacy_national_id: "025123456",
    display_name: "Nguyễn Văn An",
    date_of_birth: "15/08/1995",
    date_of_birth_iso: "1995-08-15",
    gender: "MALE",
    gender_label: "Nam",
    address: "123 Nguyễn Trãi, Q.1, TP.HCM",
    national_id_issued_at: "20/10/2021",
    national_id_issued_at_iso: "2021-10-20",
  });
});

test("decodeCccdQrFromImageBytes decodes CCCD card JPEG where QR is small in the top-right quadrant or rotated 90 degrees", async () => {
  const qrPayload =
    "001198005678||Trần Thị Bích|29021996|Nữ|Hòa Vang, Đà Nẵng|05052022";
  const smallQrPng = await renderQrPngBuffer(qrPayload, {
    moduleScale: 4,
    marginModules: 3,
  });

  // Simulate full CCCD card layout (1000x630) with QR code positioned in top-right quadrant
  const cardJpeg = await sharp({
    create: {
      width: 1000,
      height: 630,
      channels: 3,
      background: { r: 235, g: 240, b: 238 },
    },
  })
    .composite([{ input: smallQrPng, left: 740, top: 45 }])
    .jpeg({ quality: 92 })
    .toBuffer();

  const cardResult = await decodeCccdQrFromImageBytes(new Uint8Array(cardJpeg), {
    referenceDateIso: REFERENCE_DATE,
  });
  assert.equal(cardResult.status, "SUCCEEDED");
  if (cardResult.status === "SUCCEEDED") {
    assert.equal(cardResult.candidate_data.national_id, "001198005678");
    assert.equal(cardResult.candidate_data.display_name, "Trần Thị Bích");
    assert.equal(cardResult.candidate_data.gender, "FEMALE");
  }

  // Rotate 90 degrees without EXIF orientation tag to verify rotated fallback pass
  const rotatedPng = await sharp(smallQrPng).rotate(90).png().toBuffer();
  const rotatedResult = await decodeCccdQrFromImageBytes(new Uint8Array(rotatedPng), {
    referenceDateIso: REFERENCE_DATE,
  });
  assert.equal(rotatedResult.status, "SUCCEEDED");
  if (rotatedResult.status === "SUCCEEDED") {
    assert.equal(rotatedResult.candidate_data.national_id, "001198005678");
  }
});

test("decodeCccdQrFromImageBytes returns NO_QR_FOUND or INVALID_QR safely without leaking PII", async () => {
  // 1. Blank image without QR code -> NO_QR_FOUND (QR_NOT_DETECTED)
  const blankJpeg = await sharp({
    create: {
      width: 400,
      height: 260,
      channels: 3,
      background: { r: 240, g: 240, b: 240 },
    },
  })
    .jpeg()
    .toBuffer();

  const noQrResult = await decodeCccdQrFromImageBytes(new Uint8Array(blankJpeg), {
    referenceDateIso: REFERENCE_DATE,
  });
  assert.deepEqual(noQrResult, {
    status: "NO_QR_FOUND",
    candidate_data: null,
    error_code: "QR_NOT_DETECTED",
    error_field: null,
  });

  // 2. Unreadable / non-image bytes -> NO_QR_FOUND (QR_IMAGE_UNREADABLE)
  const unreadableResult = await decodeCccdQrFromImageBytes(
    new Uint8Array(Buffer.from("not-an-image", "utf8")),
    { referenceDateIso: REFERENCE_DATE },
  );
  assert.deepEqual(unreadableResult, {
    status: "NO_QR_FOUND",
    candidate_data: null,
    error_code: "QR_IMAGE_UNREADABLE",
    error_field: null,
  });

  // 3. QR image encoding invalid CCCD payload -> INVALID_QR with zero PII in response
  const invalidPayload =
    "INVALID12345|025123456|Nguyễn Văn Bí Mật|15081995|Nam|Địa Chỉ Bí Mật|20102021";
  const invalidQrPng = await renderQrPngBuffer(invalidPayload);
  const invalidQrResult = await decodeCccdQrFromImageBytes(new Uint8Array(invalidQrPng), {
    referenceDateIso: REFERENCE_DATE,
  });
  assert.deepEqual(invalidQrResult, {
    status: "INVALID_QR",
    candidate_data: null,
    error_code: "QR_NATIONAL_ID_INVALID",
    error_field: "national_id",
  });
  const serialized = JSON.stringify(invalidQrResult);
  assert.ok(!serialized.includes("INVALID12345"));
  assert.ok(!serialized.includes("Nguyễn Văn Bí Mật"));
  assert.ok(!serialized.includes("Địa Chỉ Bí Mật"));
});
