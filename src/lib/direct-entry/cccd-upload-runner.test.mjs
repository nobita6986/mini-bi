import assert from "node:assert/strict";
import test from "node:test";

import {
  EMPTY_CCCD_KEY_STATE,
  clearCccdKey,
  runCccdUpload,
  sha256HexFromBytes,
} from "./cccd-upload-runner.ts";
import { cccdIntentFingerprint } from "./cccd-document-pair.ts";

const ENTRY = "c1000000-0000-4000-8000-00000000000a";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const DOC_FRONT = "d1000000-0000-4000-8000-0000000000f1";
const DOC_BACK = "d1000000-0000-4000-8000-0000000000b1";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

function file(documentType, sha256 = SHA_A) {
  return { documentType, sizeBytes: 2048, mimeType: "image/jpeg", sha256 };
}

function readyDocument(documentType) {
  return { document_type: documentType, upload_status: "READY",
    validation_status: "VALIDATED", scan_status: "CLEAN" };
}

/**
 * Transport gia lap co do do song song: neu pipeline chay tuan tu thi maxInFlight = 1,
 * neu chay song song thi maxInFlight > 1. Khong the treo test.
 */
function makeTransport(options = {}) {
  const behaviour = options.behaviour ?? {};
  const calls = [];
  let version = options.startVersion ?? 5;
  let reserveInFlight = 0;
  let putInFlight = 0;
  let finalizeInFlight = 0;
  const stats = { reserveMax: 0, putMax: 0, finalizeMax: 0 };

  const transport = {
    async reserve(input) {
      calls.push({ op: "reserve", ...input });
      reserveInFlight += 1;
      stats.reserveMax = Math.max(stats.reserveMax, reserveInFlight);
      await tick();
      reserveInFlight -= 1;
      const outcome = behaviour.reserve ? behaviour.reserve(input, version)
        : {
          kind: "reserved",
          documentId: input.documentType === "CCCD_FRONT" ? DOC_FRONT : DOC_BACK,
          entryVersion: version + 1,
          upload: { url: "https://signed.invalid/put/" + input.documentType,
            headers: { "content-type": input.mimeType } },
        };
      if (outcome.kind === "reserved") version = outcome.entryVersion;
      return outcome;
    },
    async put(input) {
      calls.push({ op: "put", ...input });
      putInFlight += 1;
      stats.putMax = Math.max(stats.putMax, putInFlight);
      await tick();
      putInFlight -= 1;
      return behaviour.put ? behaviour.put(input) : { ok: true };
    },
    async finalize(input) {
      calls.push({ op: "finalize", ...input });
      finalizeInFlight += 1;
      stats.finalizeMax = Math.max(stats.finalizeMax, finalizeInFlight);
      await tick();
      finalizeInFlight -= 1;
      const outcome = behaviour.finalize ? behaviour.finalize(input, version)
        : { kind: "finalized", entryVersion: version + 1,
          document: readyDocument(input.documentType) };
      if (outcome.kind === "finalized") version = outcome.entryVersion;
      return outcome;
    },
    async reloadDetail() {
      calls.push({ op: "reload" });
      return { entryVersion: version, documents: [
        readyDocument("CCCD_FRONT"), readyDocument("CCCD_BACK") ] };
    },
  };
  return { transport, calls, stats, versionOf: () => version };
}

test("SHA-256 tinh tu BYTES bang Web Crypto, lowercase hex 64 ky tu", async () => {
  const digest = await sha256HexFromBytes(new TextEncoder().encode("abc"));
  assert.equal(digest, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.match(digest, /^[a-f0-9]{64}$/);
  // Cung bytes => cung digest; doi mot byte => doi digest.
  const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
  assert.equal(await sha256HexFromBytes(pdf), await sha256HexFromBytes(pdf.buffer));
  assert.notEqual(await sha256HexFromBytes(pdf),
    await sha256HexFromBytes(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2e])));
  assert.equal(await sha256HexFromBytes(new Uint8Array(0)),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("reserve tuan tu FRONT -> BACK dung version moi nhat, PUT song song, finalize tuan tu", async () => {
  const { transport, calls, stats } = makeTransport();
  const { result } = await runCccdUpload({
    entryId: ENTRY, entryVersion: 5,
    files: [file("CCCD_BACK"), file("CCCD_FRONT")],
    keyState: EMPTY_CCCD_KEY_STATE,
    transport,
    generateKey: () => "k-" + calls.length,
  });
  const reserves = calls.filter((call) => call.op === "reserve");
  const puts = calls.filter((call) => call.op === "put");
  const finalizes = calls.filter((call) => call.op === "finalize");

  assert.deepEqual(reserves.map((call) => call.documentType), ["CCCD_FRONT", "CCCD_BACK"]);
  assert.deepEqual(reserves.map((call) => call.entryVersion), [5, 6],
    "reserve sau dung version moi nhat");
  assert.equal(stats.reserveMax, 1, "reserve tuan tu");
  assert.equal(puts.length, 2);
  assert.equal(stats.putMax, 2, "PUT chay song song");
  assert.deepEqual(finalizes.map((call) => call.documentType), ["CCCD_FRONT", "CCCD_BACK"]);
  assert.deepEqual(finalizes.map((call) => call.entryVersion), [7, 8],
    "finalize dung version moi nhat");
  assert.equal(stats.finalizeMax, 1, "finalize tuan tu");
  assert.equal(calls.filter((call) => call.op === "reload").length, 1, "reload dung mot lan");
  assert.equal(result.entryVersion, 9);
  assert.deepEqual(result.slots.map((slot) => [slot.documentType, slot.status]),
    [["CCCD_FRONT", "complete"], ["CCCD_BACK", "complete"]]);
  assert.deepEqual(result.planErrors, []);
});

test("khong optimistic READY: finalize tra scan PENDING thi slot la pending, khong complete", async () => {
  const { transport } = makeTransport({
    behaviour: {
      finalize: (input, version) => ({ kind: "finalized", entryVersion: version + 1,
        document: { document_type: input.documentType, upload_status: "READY",
          validation_status: "VALIDATED", scan_status: "PENDING" } }),
      reserve: undefined,
    },
  });
  const { result } = await runCccdUpload({
    entryId: ENTRY, entryVersion: 1, files: [file("CCCD_FRONT")],
    keyState: EMPTY_CCCD_KEY_STATE, transport, generateKey: () => "k",
  });
  assert.equal(result.slots[0].status, "pending");
  assert.equal(result.slots[0].code, "DOCUMENT_VALIDATION_PENDING");
});

test("partial failure: mat thanh cong duoc giu, chi mat loi can retry", async () => {
  const run = makeTransport({
    behaviour: {
      put: (input) => input.documentType === "CCCD_FRONT"
        ? { ok: false, code: "DOCUMENT_STORAGE_UNAVAILABLE" }
        : { ok: true },
    },
  });
  const { result, keyState } = await runCccdUpload({
    entryId: ENTRY, entryVersion: 3,
    files: [file("CCCD_FRONT"), file("CCCD_BACK")],
    keyState: EMPTY_CCCD_KEY_STATE, transport: run.transport, generateKey: () => "k-front",
  });
  const front = result.slots.find((slot) => slot.documentType === "CCCD_FRONT");
  const back = result.slots.find((slot) => slot.documentType === "CCCD_BACK");
  assert.equal(front.status, "failed");
  assert.equal(front.retryable, true);
  assert.equal(front.conflict, false);
  assert.equal(back.status, "complete", "mat thanh cong duoc giu");
  // Key cua mat loi duoc giu lai de retry cung intent.
  const frontFingerprint = cccdIntentFingerprint({ entryId: ENTRY, entryVersion: 3,
    documentType: "CCCD_FRONT", sha256: SHA_A });
  assert.ok(keyState[frontFingerprint], "key mat loi duoc giu");
  const backFingerprint = cccdIntentFingerprint({ entryId: ENTRY, entryVersion: 4,
    documentType: "CCCD_BACK", sha256: SHA_A });
  assert.equal(keyState[backFingerprint], undefined, "mat xong thi bo key");

  // Retry CHI mat loi: khong co request nao cho mat da xong.
  // Cung entry version (chua co ghi nhan moi) => dung lai dung idempotency key cu.
  const retry = makeTransport({ startVersion: 3 });
  const retried = await runCccdUpload({
    entryId: ENTRY, entryVersion: 3, files: [file("CCCD_FRONT")],
    keyState, transport: retry.transport, generateKey: () => "k-should-not-be-used",
  });
  const retryReserve = retry.calls.filter((call) => call.op === "reserve");
  assert.deepEqual(retryReserve.map((call) => call.documentType), ["CCCD_FRONT"]);
  assert.equal(retryReserve[0].idempotencyKey, "k-front", "cung fingerprint dung lai key");
  assert.equal(retried.result.slots.length, 1);
  assert.equal(retried.result.slots[0].status, "complete");
});

test("doi version / doi file / doi mat => idempotency key moi", async () => {
  const base = cccdIntentFingerprint({ entryId: ENTRY, entryVersion: 3,
    documentType: "CCCD_FRONT", sha256: SHA_A });
  const otherVersion = cccdIntentFingerprint({ entryId: ENTRY, entryVersion: 4,
    documentType: "CCCD_FRONT", sha256: SHA_A });
  const otherFile = cccdIntentFingerprint({ entryId: ENTRY, entryVersion: 3,
    documentType: "CCCD_FRONT", sha256: SHA_B });
  const otherSlot = cccdIntentFingerprint({ entryId: ENTRY, entryVersion: 3,
    documentType: "CCCD_BACK", sha256: SHA_A });
  assert.equal(new Set([base, otherVersion, otherFile, otherSlot]).size, 4);
  assert.equal(/^[\u0000-\u007f]+$/.test(base), true, "fingerprint chi ASCII, khong PII");
  for (const forbidden of ["Nguyen", "hrp-2026", "cccd.jpg", "/tmp", "storage", "bucket"]) {
    assert.equal(base.includes(forbidden), false, forbidden);
  }

  const run = makeTransport();
  await runCccdUpload({ entryId: ENTRY, entryVersion: 3, files: [file("CCCD_FRONT")],
    keyState: EMPTY_CCCD_KEY_STATE, transport: run.transport, generateKey: () => "key-v3" });
  const bumped = makeTransport();
  await runCccdUpload({ entryId: ENTRY, entryVersion: 4, files: [file("CCCD_FRONT")],
    keyState: EMPTY_CCCD_KEY_STATE, transport: bumped.transport, generateKey: () => "key-v4" });
  assert.equal(run.calls.find((call) => call.op === "reserve").idempotencyKey, "key-v3");
  assert.equal(bumped.calls.find((call) => call.op === "reserve").idempotencyKey, "key-v4");
});

test("OCC 409: khong auto-retry, slot conflict, key bi xoa (lan sau phai la key moi)", async () => {
  let generated = 0;
  const run = makeTransport({
    behaviour: { reserve: () => ({ kind: "conflict", code: "DOCUMENT_VERSION_CONFLICT" }) },
  });
  const { result, keyState } = await runCccdUpload({
    entryId: ENTRY, entryVersion: 2, files: [file("CCCD_FRONT")],
    keyState: EMPTY_CCCD_KEY_STATE, transport: run.transport,
    generateKey: () => "occ-" + (generated += 1),
  });
  assert.equal(result.slots[0].status, "failed");
  assert.equal(result.slots[0].conflict, true);
  assert.equal(result.slots[0].retryable, false);
  assert.equal(run.calls.filter((call) => call.op === "reserve").length, 1, "khong tu retry");
  assert.equal(run.calls.filter((call) => call.op === "finalize").length, 0);

  const fingerprint = cccdIntentFingerprint({ entryId: ENTRY, entryVersion: 2,
    documentType: "CCCD_FRONT", sha256: SHA_A });
  assert.equal(keyState[fingerprint], undefined);

  let second = 0;
  const retry = makeTransport();
  await runCccdUpload({ entryId: ENTRY, entryVersion: 2, files: [file("CCCD_FRONT")],
    keyState, transport: retry.transport, generateKey: () => "re-" + (second += 1) });
  assert.equal(retry.calls.find((call) => call.op === "reserve").idempotencyKey, "re-1");
});

test("response malformed fail-closed: khong co slot complete va giu key de thu lai", async () => {
  const run = makeTransport({
    behaviour: { reserve: () => ({ kind: "retryable", code: "DOCUMENT_RESPONSE_INVALID" }) },
  });
  const { result, keyState } = await runCccdUpload({
    entryId: ENTRY, entryVersion: 2, files: [file("CCCD_BACK")],
    keyState: EMPTY_CCCD_KEY_STATE, transport: run.transport, generateKey: () => "mal-1",
  });
  assert.equal(result.slots[0].status, "failed");
  assert.equal(result.slots[0].retryable, true);
  assert.equal(result.slots.some((slot) => slot.status === "complete"), false);
  const fingerprint = cccdIntentFingerprint({ entryId: ENTRY, entryVersion: 2,
    documentType: "CCCD_BACK", sha256: SHA_A });
  assert.equal(keyState[fingerprint].key, "mal-1", "giu key");

  const retry = makeTransport();
  await runCccdUpload({ entryId: ENTRY, entryVersion: 2, files: [file("CCCD_BACK")],
    keyState, transport: retry.transport, generateKey: () => "mal-2" });
  assert.equal(retry.calls.find((call) => call.op === "reserve").idempotencyKey, "mal-1",
    "thu lai cung intent dung lai key");
});

test("plan khong hop le: khong gui request nao, loi tra ve theo tung mat", async () => {
  for (const input of [
    { entryId: "not-a-uuid", entryVersion: 1, files: [file("CCCD_FRONT")] },
    { entryId: ENTRY, entryVersion: 0, files: [file("CCCD_FRONT")] },
    { entryId: ENTRY, entryVersion: 1, files: [file("CCCD_FRONT", "A".repeat(64))] },
    { entryId: ENTRY, entryVersion: 1, files: [{ ...file("CCCD_FRONT"), sizeBytes: 0 }] },
    { entryId: ENTRY, entryVersion: 1, files: [{ ...file("CCCD_FRONT"), mimeType: "text/plain" }] },
    { entryId: ENTRY, entryVersion: 1, files: [file("CCCD_FRONT"), file("CCCD_FRONT")] },
  ]) {
    const run = makeTransport();
    const { result } = await runCccdUpload({ ...input, keyState: EMPTY_CCCD_KEY_STATE,
      transport: run.transport, generateKey: () => "never" });
    assert.equal(run.calls.length, 0, JSON.stringify(input.files));
    assert.ok(result.planErrors.length > 0);
    assert.equal(result.slots.length, 0);
  }
});

test("idempotency key khong chua PII: transport chi nhan dung truong cho phep", async () => {
  const run = makeTransport();
  await runCccdUpload({ entryId: ENTRY, entryVersion: 1,
    files: [file("CCCD_FRONT"), file("CCCD_BACK")],
    keyState: EMPTY_CCCD_KEY_STATE, transport: run.transport, generateKey: () => "opaque-key" });
  for (const call of run.calls.filter((item) => item.op === "reserve")) {
    assert.deepEqual(Object.keys(call).sort(), ["documentType", "entryVersion", "idempotencyKey",
      "mimeType", "op", "sizeBytes"]);
  }
  for (const call of run.calls.filter((item) => item.op === "put")) {
    assert.deepEqual(Object.keys(call).sort(), ["documentType", "headers", "op", "url"]);
    assert.equal(String(call.url).includes("signed.invalid"), true);
  }
  assert.equal(clearCccdKey({ a: { intent: "a", key: "k" } }, "missing").a.key, "k");
  assert.deepEqual(clearCccdKey({ a: { intent: "a", key: "k" } }, "a"), {});
});
