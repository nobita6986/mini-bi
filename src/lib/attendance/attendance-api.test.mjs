import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import sharp from "sharp";

import { sha256Hex } from "../direct-entry/document-r2-contract.ts";
import { getAttendanceTime, postAttendanceCheckIn } from "./attendance-api.ts";
import {
  ATTENDANCE_ERROR_CODES,
  ATTENDANCE_MAX_SYNC_WINDOW_MS,
  attendanceHttpStatusForError,
} from "./attendance-contract.ts";
import {
  attendancePhotoObjectKey,
  createR2AttendanceStorage,
} from "./r2-attendance-storage.ts";
import {
  ATTENDANCE_TIME_TOKEN_TTL_MS,
  issueAttendanceTimeToken,
  verifyAttendanceTimeToken,
} from "./time-token.ts";

const DEDICATED_SECRET = "att-wp1-signing-secret-2026-unique-9f8e7d6c5b4a3210";
const ACTOR_A = {
  auth_subject: "91000000-0000-4000-8000-0000000000a1",
  app_user_id: "92000000-0000-4000-8000-0000000000a1",
};
const ACTOR_B = {
  auth_subject: "91000000-0000-4000-8000-0000000000b2",
  app_user_id: "92000000-0000-4000-8000-0000000000b2",
};

const KEY_1 = "c1000000-0000-4000-8000-000000000001";
const KEY_2 = "c1000000-0000-4000-8000-000000000002";

const VALID_ENV = {
  ATTENDANCE_ENABLED: "true",
  ATTENDANCE_TIME_TOKEN_SECRET: DEDICATED_SECRET,
  SUPABASE_SECRET_KEY: "sb-secret-service-role-key-do-not-reuse-123456",
  R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  R2_BUCKET_NAME: "hrp-bi-preview",
  R2_ACCESS_KEY_ID: "R2ACCESSKEYID0123456789",
  R2_SECRET_ACCESS_KEY: "R2SECRETACCESSKEY0123456789abcdef",
  DOCUMENT_STORAGE_ENVIRONMENT: "preview",
  AI_WORKER_TOKEN: "ai-worker-token-distinct-value-1234567890",
};

const FIXED_NOW_MS = Date.parse("2026-10-23T01:25:00.000Z");
const ANCHOR_ISSUED_MS = Date.parse("2026-10-23T01:15:00.000Z");
const ELAPSED_MS = 312_000; // +5m12s => 2026-10-23T01:20:12.000Z (08:20:12.000+07:00)

let cachedJpegA = null;
let cachedJpegB = null;

async function realJpegA() {
  if (!cachedJpegA) {
    cachedJpegA = new Uint8Array(
      await sharp({
        create: { width: 8, height: 8, channels: 3, background: "#1f5f8b" },
      })
        .jpeg({ quality: 90 })
        .withMetadata({
          exif: { IFD0: { Software: "mini-bi-android-camera" } },
        })
        .toBuffer(),
    );
  }
  return cachedJpegA;
}

async function realJpegB() {
  if (!cachedJpegB) {
    cachedJpegB = new Uint8Array(
      await sharp({
        create: { width: 10, height: 6, channels: 3, background: "#8b2f1f" },
      })
        .jpeg({ quality: 88 })
        .toBuffer(),
    );
  }
  return cachedJpegB;
}

function createFakeR2Harness(env = VALID_ENV) {
  const objects = new Map();
  const commands = [];

  const client = {
    async send(command) {
      if (command instanceof HeadObjectCommand) {
        commands.push({ op: "head", key: command.input.Key });
        const found = objects.get(command.input.Key);
        if (!found) {
          const err = new Error("NotFound");
          err.name = "NotFound";
          err.$metadata = { httpStatusCode: 404 };
          throw err;
        }
        return {
          ContentLength: found.bytes.byteLength,
          ContentType: found.contentType,
          Metadata: found.metadata,
        };
      }
      if (command instanceof PutObjectCommand) {
        const bytes = new Uint8Array(command.input.Body);
        commands.push({ op: "put", key: command.input.Key, size: bytes.byteLength });
        objects.set(command.input.Key, {
          bytes,
          contentType: command.input.ContentType,
          metadata: { ...(command.input.Metadata ?? {}) },
        });
        return {};
      }
      if (command instanceof GetObjectCommand) {
        commands.push({ op: "get", key: command.input.Key });
        const found = objects.get(command.input.Key);
        if (!found) {
          const err = new Error("NoSuchKey");
          err.name = "NoSuchKey";
          err.$metadata = { httpStatusCode: 404 };
          throw err;
        }
        return {
          ContentLength: found.bytes.byteLength,
          ContentType: found.contentType,
          Body: {
            async transformToByteArray() {
              return new Uint8Array(found.bytes);
            },
          },
        };
      }
      if (command instanceof DeleteObjectCommand) {
        commands.push({ op: "delete", key: command.input.Key });
        objects.delete(command.input.Key);
        return {};
      }
      throw new Error(`Unexpected S3 command: ${command?.constructor?.name}`);
    },
  };

  return {
    objects,
    commands,
    storage: createR2AttendanceStorage(env, { client }),
  };
}

function createInMemoryCheckInRepo() {
  const byActorKey = new Map();
  const byActorDay = new Map();
  const lookups = [];
  const calls = [];
  let seqCounter = 0;

  return {
    lookups,
    calls,
    byActorKey,
    repository: {
      async lookupCheckInIdempotency(input) {
        lookups.push(input);
        const compositeKey = `${input.app_user_id}:${input.idempotency_key}`;
        const existing = byActorKey.get(compositeKey);
        if (!existing) {
          return { ok: true, found: false };
        }
        if (existing.request_fingerprint !== input.request_fingerprint) {
          return { ok: false, code: "IDEMPOTENCY_CONFLICT" };
        }
        const dayRows = byActorDay.get(`${input.app_user_id}:${existing.business_date}`) ?? [];
        return {
          ok: true,
          found: true,
          checkin: {
            ...existing.projection,
            daily_count: dayRows.length,
            replayed: true,
          },
        };
      },
      async recordCheckIn(input) {
        calls.push(input);
        const compositeKey = `${input.app_user_id}:${input.idempotency_key}`;
        const existing = byActorKey.get(compositeKey);
        if (existing) {
          if (existing.request_fingerprint !== input.request_fingerprint) {
            return { ok: false, code: "IDEMPOTENCY_CONFLICT" };
          }
          const dayRows = byActorDay.get(`${input.app_user_id}:${existing.business_date}`) ?? [];
          return {
            ok: true,
            checkin: {
              ...existing.projection,
              daily_count: dayRows.length,
              replayed: true,
            },
          };
        }

        const receivedAtMs = Date.parse(input.received_at);
        const capturedAtMs =
          input.time_source === "SERVER_ANCHORED"
            ? Date.parse(input.time_anchor_issued_at) + input.elapsed_since_anchor_ms
            : Date.parse(input.device_claimed_at);

        if (
          input.time_source === "SERVER_ANCHORED" &&
          receivedAtMs - capturedAtMs > ATTENDANCE_MAX_SYNC_WINDOW_MS
        ) {
          return { ok: false, code: "ATTENDANCE_SYNC_WINDOW_EXPIRED" };
        }

        const hcmDate = new Intl.DateTimeFormat("en-CA", {
          timeZone: "Asia/Ho_Chi_Minh",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date(capturedAtMs));

        const dayKey = `${input.app_user_id}:${hcmDate}`;
        const dayRows = byActorDay.get(dayKey) ?? [];
        const sequenceInDay = dayRows.length + 1;
        seqCounter += 1;
        const checkinId = `d2000000-0000-4000-8000-${String(seqCounter).padStart(12, "0")}`;

        const projection = {
          checkin_id: checkinId,
          business_date: hcmDate,
          sequence_in_day: sequenceInDay,
          daily_count: sequenceInDay,
          captured_at: new Date(capturedAtMs).toISOString(),
          received_at: new Date(receivedAtMs).toISOString(),
          time_source: input.time_source,
          replayed: false,
        };

        dayRows.push(projection);
        byActorDay.set(dayKey, dayRows);
        byActorKey.set(compositeKey, {
          request_fingerprint: input.request_fingerprint,
          business_date: hcmDate,
          projection,
        });

        return { ok: true, checkin: projection };
      },
    },
  };
}

function activeSession(actor = ACTOR_A) {
  return async () => ({
    actor: {
      ok: true,
      actor: {
        ...actor,
        capabilities: [],
      },
    },
    response_headers: {},
  });
}

function buildMetadata(overrides = {}) {
  const issued = issueAttendanceTimeToken({
    secret: Buffer.from(DEDICATED_SECRET, "utf8"),
    app_user_id: ACTOR_A.app_user_id,
    now_ms: ANCHOR_ISSUED_MS,
    nonce_hex: "00112233445566778899aabbccddeeff",
  });

  return {
    latitude: 21.0285,
    longitude: 105.8542,
    accuracy_meters: 12.5,
    address_hint: "Hà Nội",
    client_captured_at: "2026-10-23T08:20:12.000+07:00",
    note: "Ca sáng",
    idempotency_key: KEY_1,
    photo_sha256: "0".repeat(64),
    time_source: "SERVER_ANCHORED",
    time_token: issued.time_token,
    elapsed_since_anchor_ms: ELAPSED_MS,
    ...overrides,
  };
}

function buildMultipartCheckInRequest({
  url = "https://bi.example.test/api/attendance/check-in",
  headers = {},
  metadataObj,
  rawMetadataString,
  photoBytes,
  photoMimeType = "image/jpeg",
  photoFileName = "checkin.jpg",
  idempotencyHeader = KEY_1,
  extraParts = [],
} = {}) {
  const form = new FormData();
  const metaText =
    rawMetadataString !== undefined ? rawMetadataString : JSON.stringify(metadataObj);
  if (metaText !== null) {
    form.append("metadata", metaText);
  }
  if (photoBytes !== null) {
    form.append(
      "photo",
      new Blob([photoBytes], { type: photoMimeType }),
      photoFileName,
    );
  }
  for (const [k, v] of extraParts) {
    form.append(k, v);
  }

  const mergedHeaders = {
    origin: "https://bi.example.test",
    host: "bi.example.test",
    ...(idempotencyHeader !== null ? { "idempotency-key": idempotencyHeader } : {}),
    ...headers,
  };

  return new Request(url, {
    method: "POST",
    headers: mergedHeaders,
    body: form,
  });
}

test("all 23 Attendance WP1 stable error codes map to deterministic HTTP statuses", () => {
  assert.equal(ATTENDANCE_ERROR_CODES.length, 23);
  assert.equal(attendanceHttpStatusForError("ATTENDANCE_SYNC_WINDOW_EXPIRED"), 422);
  for (const code of ATTENDANCE_ERROR_CODES) {
    const status = attendanceHttpStatusForError(code);
    assert.equal(typeof status, "number");
    assert.ok(status >= 400 && status <= 599);
  }
});

test("feature flag disabled returns 404 NOT_FOUND on both attendance endpoints before session/DB/R2", async () => {
  let sessionCalled = 0;
  const resolveSession = async () => {
    sessionCalled += 1;
    throw new Error("should not resolve session when flag is off");
  };

  for (const flagVal of [undefined, "false", "0", "TRUE", "yes"]) {
    const env = { ...VALID_ENV, ATTENDANCE_ENABLED: flagVal };
    const timeRes = await getAttendanceTime(
      new Request("https://bi.example.test/api/attendance/time"),
      env,
      { resolveSession },
    );
    assert.equal(timeRes.status, 404);
    assert.equal(timeRes.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await timeRes.json(), { ok: false, code: "NOT_FOUND" });

    const r2 = createFakeR2Harness(env);
    const repo = createInMemoryCheckInRepo();
    const checkInRes = await postAttendanceCheckIn(
      new Request("https://bi.example.test/api/attendance/check-in", { method: "POST" }),
      env,
      { resolveSession, repository: repo.repository, storage: r2.storage },
    );
    assert.equal(checkInRes.status, 404);
    assert.deepEqual(await checkInRes.json(), { ok: false, code: "NOT_FOUND" });
  }
  assert.equal(sessionCalled, 0);
});

test("enabled flag with missing, weak, placeholder, or reused ATTENDANCE_TIME_TOKEN_SECRET fails closed with 503 ATTENDANCE_CONFIG_REQUIRED", async () => {
  const invalidSecrets = [
    undefined,
    "",
    "short-secret-123",
    "<attendance-time-token-secret>",
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    VALID_ENV.SUPABASE_SECRET_KEY,
    VALID_ENV.R2_SECRET_ACCESS_KEY,
    VALID_ENV.AI_WORKER_TOKEN,
    "reused-db-password-super-long-value-12345",
  ];

  for (const candidate of invalidSecrets) {
    const env = {
      ...VALID_ENV,
      SUPABASE_DB_URL:
        "postgresql://postgres:reused-db-password-super-long-value-12345@db.example.supabase.co:5432/postgres",
      ATTENDANCE_TIME_TOKEN_SECRET: candidate,
    };

    const timeRes = await getAttendanceTime(
      new Request("https://bi.example.test/api/attendance/time"),
      env,
      { resolveSession: activeSession() },
    );
    assert.equal(timeRes.status, 503);
    assert.deepEqual(await timeRes.json(), {
      ok: false,
      code: "ATTENDANCE_CONFIG_REQUIRED",
    });

    const r2 = createFakeR2Harness(env);
    const repo = createInMemoryCheckInRepo();
    const checkInRes = await postAttendanceCheckIn(
      new Request("https://bi.example.test/api/attendance/check-in", { method: "POST" }),
      env,
      {
        resolveSession: activeSession(),
        repository: repo.repository,
        storage: r2.storage,
      },
    );
    assert.equal(checkInRes.status, 503);
    assert.deepEqual(await checkInRes.json(), {
      ok: false,
      code: "ATTENDANCE_CONFIG_REQUIRED",
    });
  }
});

test("GET /api/attendance/time enforces active session, blocks actor/time spoofing, and issues actor-bound 24h HMAC token", async () => {
  const unauthRes = await getAttendanceTime(
    new Request("https://bi.example.test/api/attendance/time"),
    VALID_ENV,
    {
      resolveSession: async () => ({
        actor: { ok: false, reason: "UNAUTHENTICATED" },
        response_headers: {},
      }),
    },
  );
  assert.equal(unauthRes.status, 401);
  assert.deepEqual(await unauthRes.json(), { ok: false, code: "UNAUTHENTICATED" });

  const disabledRes = await getAttendanceTime(
    new Request("https://bi.example.test/api/attendance/time"),
    VALID_ENV,
    {
      resolveSession: async () => ({
        actor: { ok: false, reason: "ACTOR_DISABLED" },
        response_headers: {},
      }),
    },
  );
  assert.equal(disabledRes.status, 403);
  assert.deepEqual(await disabledRes.json(), { ok: false, code: "ACTOR_NOT_AVAILABLE" });

  const querySpoofRes = await getAttendanceTime(
    new Request(`https://bi.example.test/api/attendance/time?app_user_id=${ACTOR_B.app_user_id}`),
    VALID_ENV,
    { resolveSession: activeSession() },
  );
  assert.equal(querySpoofRes.status, 400);
  assert.deepEqual(await querySpoofRes.json(), {
    ok: false,
    code: "ATTENDANCE_REQUEST_INVALID",
  });

  const headerSpoofRes = await getAttendanceTime(
    new Request("https://bi.example.test/api/attendance/time", {
      headers: { "x-app-user-id": ACTOR_B.app_user_id },
    }),
    VALID_ENV,
    { resolveSession: activeSession() },
  );
  assert.equal(headerSpoofRes.status, 400);

  const okRes = await getAttendanceTime(
    new Request("https://bi.example.test/api/attendance/time"),
    VALID_ENV,
    { resolveSession: activeSession(ACTOR_A), now: () => ANCHOR_ISSUED_MS },
  );
  assert.equal(okRes.status, 200);
  assert.equal(okRes.headers.get("cache-control"), "private, no-store");
  const body = await okRes.json();
  assert.deepEqual(Object.keys(body).sort(), [
    "expires_at",
    "ok",
    "server_time",
    "time_token",
  ]);
  assert.equal(body.ok, true);
  assert.equal(body.server_time, "2026-10-23T01:15:00.000Z");
  assert.equal(body.expires_at, "2026-10-24T01:15:00.000Z");
  assert.doesNotMatch(JSON.stringify(body), new RegExp(DEDICATED_SECRET));

  const verifiedSameActor = verifyAttendanceTimeToken({
    secret: Buffer.from(DEDICATED_SECRET, "utf8"),
    token: body.time_token,
    expected_app_user_id: ACTOR_A.app_user_id,
    now_ms: ANCHOR_ISSUED_MS + 60_000,
  });
  assert.equal(verifiedSameActor.ok, true);

  const verifiedOtherActor = verifyAttendanceTimeToken({
    secret: Buffer.from(DEDICATED_SECRET, "utf8"),
    token: body.time_token,
    expected_app_user_id: ACTOR_B.app_user_id,
    now_ms: ANCHOR_ISSUED_MS + 60_000,
  });
  assert.deepEqual(verifiedOtherActor, {
    ok: false,
    code: "ATTENDANCE_TIME_TOKEN_ACTOR_MISMATCH",
  });

  const verifiedExpired = verifyAttendanceTimeToken({
    secret: Buffer.from(DEDICATED_SECRET, "utf8"),
    token: body.time_token,
    expected_app_user_id: ACTOR_A.app_user_id,
    now_ms: ANCHOR_ISSUED_MS + ATTENDANCE_TIME_TOKEN_TTL_MS + 1,
  });
  assert.deepEqual(verifiedExpired, {
    ok: false,
    code: "ATTENDANCE_TIME_TOKEN_EXPIRED",
  });

  const verifiedExpiredForSync = verifyAttendanceTimeToken({
    secret: Buffer.from(DEDICATED_SECRET, "utf8"),
    token: body.time_token,
    expected_app_user_id: ACTOR_A.app_user_id,
    now_ms: ANCHOR_ISSUED_MS + ATTENDANCE_TIME_TOKEN_TTL_MS + 1,
    allow_expired_anchor: true,
  });
  assert.equal(verifiedExpiredForSync.ok, true);
  assert.equal(verifiedExpiredForSync.anchor_expired, true);

  const tamperedToken = `${body.time_token.slice(0, -2)}ab`;
  const verifiedTampered = verifyAttendanceTimeToken({
    secret: Buffer.from(DEDICATED_SECRET, "utf8"),
    token: tamperedToken,
    expected_app_user_id: ACTOR_A.app_user_id,
    now_ms: ANCHOR_ISSUED_MS + 1_000,
  });
  assert.deepEqual(verifiedTampered, {
    ok: false,
    code: "ATTENDANCE_TIME_TOKEN_INVALID",
  });
});

test("POST /api/attendance/check-in enforces same-origin CSRF without X-Client-Platform bypass and validates session", async () => {
  const jpeg = await realJpegA();
  const sha = sha256Hex(jpeg);
  const meta = buildMetadata({ photo_sha256: sha });
  const r2 = createFakeR2Harness();
  const repo = createInMemoryCheckInRepo();
  const deps = {
    resolveSession: activeSession(),
    repository: repo.repository,
    storage: r2.storage,
    now: () => FIXED_NOW_MS,
  };

  // Missing Origin + X-Client-Platform: android => still 403 CSRF_REJECTED!
  const missingOriginForm = new FormData();
  missingOriginForm.append("metadata", JSON.stringify(meta));
  missingOriginForm.append("photo", new Blob([jpeg], { type: "image/jpeg" }), "c.jpg");
  const noOriginReq = new Request("https://bi.example.test/api/attendance/check-in", {
    method: "POST",
    headers: {
      host: "bi.example.test",
      "x-client-platform": "android",
      "idempotency-key": KEY_1,
    },
    body: missingOriginForm,
  });
  const noOriginRes = await postAttendanceCheckIn(noOriginReq, VALID_ENV, deps);
  assert.equal(noOriginRes.status, 403);
  assert.deepEqual(await noOriginRes.json(), { ok: false, code: "CSRF_REJECTED" });

  // Wrong Origin host
  const wrongOriginRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      headers: { origin: "https://evil.example.test" },
      metadataObj: meta,
      photoBytes: jpeg,
    }),
    VALID_ENV,
    deps,
  );
  assert.equal(wrongOriginRes.status, 403);
  assert.deepEqual(await wrongOriginRes.json(), { ok: false, code: "CSRF_REJECTED" });

  // Scheme downgrade (http Origin against https endpoint)
  const downgradeOriginRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      headers: { origin: "http://bi.example.test" },
      metadataObj: meta,
      photoBytes: jpeg,
    }),
    VALID_ENV,
    deps,
  );
  assert.equal(downgradeOriginRes.status, 403);

  // Unauthenticated session
  const unauthRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({ metadataObj: meta, photoBytes: jpeg }),
    VALID_ENV,
    {
      ...deps,
      resolveSession: async () => ({
        actor: { ok: false, reason: "UNAUTHENTICATED" },
        response_headers: {},
      }),
    },
  );
  assert.equal(unauthRes.status, 401);
  assert.deepEqual(await unauthRes.json(), { ok: false, code: "UNAUTHENTICATED" });

  assert.equal(r2.objects.size, 0);
  assert.equal(repo.calls.length, 0);
});

test("POST /api/attendance/check-in validates multipart parts, 11-key metadata, actor spoofing, and SERVER_ANCHORED vs DEVICE_CLOCK_UNVERIFIED rules", async () => {
  const jpeg = await realJpegA();
  const sha = sha256Hex(jpeg);
  const r2 = createFakeR2Harness();
  const repo = createInMemoryCheckInRepo();
  const deps = {
    resolveSession: activeSession(ACTOR_A),
    repository: repo.repository,
    storage: r2.storage,
    now: () => FIXED_NOW_MS,
  };

  // Non-multipart Content-Type
  const jsonReq = new Request("https://bi.example.test/api/attendance/check-in", {
    method: "POST",
    headers: {
      origin: "https://bi.example.test",
      host: "bi.example.test",
      "content-type": "application/json",
      "idempotency-key": KEY_1,
    },
    body: JSON.stringify({}),
  });
  const jsonRes = await postAttendanceCheckIn(jsonReq, VALID_ENV, deps);
  assert.equal(jsonRes.status, 400);
  assert.deepEqual(await jsonRes.json(), { ok: false, code: "CONTENT_TYPE_INVALID" });

  // Mismatched Idempotency-Key header vs metadata.idempotency_key
  const mismatchKeyRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      idempotencyHeader: KEY_2,
      metadataObj: buildMetadata({ idempotency_key: KEY_1, photo_sha256: sha }),
      photoBytes: jpeg,
    }),
    VALID_ENV,
    deps,
  );
  assert.equal(mismatchKeyRes.status, 400);
  assert.deepEqual(await mismatchKeyRes.json(), {
    ok: false,
    code: "IDEMPOTENCY_KEY_INVALID",
  });

  // Extra multipart part rejected
  const extraPartRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      metadataObj: buildMetadata({ photo_sha256: sha }),
      photoBytes: jpeg,
      extraParts: [["unexpected", "value"]],
    }),
    VALID_ENV,
    deps,
  );
  assert.equal(extraPartRes.status, 400);
  assert.deepEqual(await extraPartRes.json(), {
    ok: false,
    code: "ATTENDANCE_REQUEST_INVALID",
  });

  // Spoofed actor / sequence fields in metadata rejected (violates exact 11-key contract)
  for (const forbiddenField of [
    "app_user_id",
    "auth_subject",
    "role",
    "scope",
    "team_id",
    "sequence_in_day",
    "daily_count",
    "business_date",
  ]) {
    const spoofRes = await postAttendanceCheckIn(
      buildMultipartCheckInRequest({
        metadataObj: buildMetadata({
          photo_sha256: sha,
          [forbiddenField]: "spoofed",
        }),
        photoBytes: jpeg,
      }),
      VALID_ENV,
      deps,
    );
    assert.equal(spoofRes.status, 400);
    assert.deepEqual(await spoofRes.json(), {
      ok: false,
      code: "ATTENDANCE_REQUEST_INVALID",
    });
  }

  // Mixed time shapes rejected
  const mixedAnchoredRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      metadataObj: buildMetadata({
        photo_sha256: sha,
        time_source: "SERVER_ANCHORED",
        time_token: null,
        elapsed_since_anchor_ms: 1000,
      }),
      photoBytes: jpeg,
    }),
    VALID_ENV,
    deps,
  );
  assert.equal(mixedAnchoredRes.status, 400);
  assert.deepEqual(await mixedAnchoredRes.json(), {
    ok: false,
    code: "ATTENDANCE_REQUEST_INVALID",
  });

  const mixedDeviceRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      metadataObj: buildMetadata({
        photo_sha256: sha,
        time_source: "DEVICE_CLOCK_UNVERIFIED",
        elapsed_since_anchor_ms: null,
      }), // time_token left non-null -> mixed shape!
      photoBytes: jpeg,
    }),
    VALID_ENV,
    deps,
  );
  assert.equal(mixedDeviceRes.status, 400);
  assert.deepEqual(await mixedDeviceRes.json(), {
    ok: false,
    code: "ATTENDANCE_REQUEST_INVALID",
  });

  // Invalid elapsed_since_anchor_ms
  const badElapsedRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      metadataObj: buildMetadata({
        photo_sha256: sha,
        elapsed_since_anchor_ms: -5,
      }),
      photoBytes: jpeg,
    }),
    VALID_ENV,
    deps,
  );
  assert.equal(badElapsedRes.status, 400);
  assert.deepEqual(await badElapsedRes.json(), {
    ok: false,
    code: "ATTENDANCE_TIME_ELAPSED_INVALID",
  });

  // Token belonging to Actor B rejected under Actor A's session
  const actorBToken = issueAttendanceTimeToken({
    secret: Buffer.from(DEDICATED_SECRET, "utf8"),
    app_user_id: ACTOR_B.app_user_id,
    now_ms: ANCHOR_ISSUED_MS,
  }).time_token;
  const actorMismatchRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      metadataObj: buildMetadata({ photo_sha256: sha, time_token: actorBToken }),
      photoBytes: jpeg,
    }),
    VALID_ENV,
    deps,
  );
  assert.equal(actorMismatchRes.status, 403);
  assert.deepEqual(await actorMismatchRes.json(), {
    ok: false,
    code: "ATTENDANCE_TIME_TOKEN_ACTOR_MISMATCH",
  });

  // Sync outside 7-day window rejected with 422 ATTENDANCE_SYNC_WINDOW_EXPIRED
  const capturedAtEpochMs = ANCHOR_ISSUED_MS + ELAPSED_MS;
  const expiredSyncWindowRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      metadataObj: buildMetadata({ photo_sha256: sha }),
      photoBytes: jpeg,
    }),
    VALID_ENV,
    {
      ...deps,
      now: () => capturedAtEpochMs + ATTENDANCE_MAX_SYNC_WINDOW_MS + 1,
    },
  );
  assert.equal(expiredSyncWindowRes.status, 422);
  assert.deepEqual(await expiredSyncWindowRes.json(), {
    ok: false,
    code: "ATTENDANCE_SYNC_WINDOW_EXPIRED",
  });

  // Client skew > 5 seconds rejected with 422 ATTENDANCE_TIME_MISMATCH
  const skewRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      metadataObj: buildMetadata({
        photo_sha256: sha,
        client_captured_at: "2026-10-23T08:20:17.001+07:00", // +5.001s skew vs 08:20:12.000+07:00
      }),
      photoBytes: jpeg,
    }),
    VALID_ENV,
    deps,
  );
  assert.equal(skewRes.status, 422);
  assert.deepEqual(await skewRes.json(), {
    ok: false,
    code: "ATTENDANCE_TIME_MISMATCH",
  });

  // Invalid GPS / accuracy / timestamp / future timestamp
  const badGpsRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      metadataObj: buildMetadata({ photo_sha256: sha, latitude: 95 }),
      photoBytes: jpeg,
    }),
    VALID_ENV,
    deps,
  );
  assert.equal(badGpsRes.status, 400);
  assert.deepEqual(await badGpsRes.json(), {
    ok: false,
    code: "GPS_COORDINATES_INVALID",
  });

  const badAccRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      metadataObj: buildMetadata({ photo_sha256: sha, accuracy_meters: -1 }),
      photoBytes: jpeg,
    }),
    VALID_ENV,
    deps,
  );
  assert.equal(badAccRes.status, 400);
  assert.deepEqual(await badAccRes.json(), {
    ok: false,
    code: "GPS_ACCURACY_INVALID",
  });

  const badCalendarRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      metadataObj: buildMetadata({
        photo_sha256: sha,
        client_captured_at: "2026-02-30T08:20:12.000+07:00",
      }),
      photoBytes: jpeg,
    }),
    VALID_ENV,
    deps,
  );
  assert.equal(badCalendarRes.status, 400);
  assert.deepEqual(await badCalendarRes.json(), {
    ok: false,
    code: "CAPTURED_AT_INVALID",
  });

  const futureUnverifiedRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      metadataObj: buildMetadata({
        photo_sha256: sha,
        time_source: "DEVICE_CLOCK_UNVERIFIED",
        time_token: null,
        elapsed_since_anchor_ms: null,
        client_captured_at: "2026-10-23T08:30:00.000+07:00", // +5m in the future vs FIXED_NOW_MS (08:25+07:00)
      }),
      photoBytes: jpeg,
    }),
    VALID_ENV,
    deps,
  );
  assert.equal(futureUnverifiedRes.status, 422);
  assert.deepEqual(await futureUnverifiedRes.json(), {
    ok: false,
    code: "CAPTURED_AT_FUTURE",
  });

  assert.equal(r2.objects.size, 0);
  assert.equal(repo.calls.length, 0);
});

test("photo inspection blocks empty, wrong MIME, fake JPEG, polyglot JPEG, oversized body, and SHA-256 mismatch before R2 write", async () => {
  const jpeg = await realJpegA();
  const r2 = createFakeR2Harness();
  const repo = createInMemoryCheckInRepo();
  const deps = {
    resolveSession: activeSession(ACTOR_A),
    repository: repo.repository,
    storage: r2.storage,
    now: () => FIXED_NOW_MS,
  };

  // 1. Empty file
  const emptyBytes = new Uint8Array(0);
  const emptyRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      metadataObj: buildMetadata({ photo_sha256: sha256Hex(emptyBytes) }),
      photoBytes: emptyBytes,
    }),
    VALID_ENV,
    deps,
  );
  assert.equal(emptyRes.status, 422);
  assert.deepEqual(await emptyRes.json(), { ok: false, code: "PHOTO_INVALID" });

  // 2. Wrong MIME (PNG declared as image/png)
  const pngBytes = new Uint8Array(
    await sharp({
      create: { width: 4, height: 4, channels: 3, background: "#112233" },
    })
      .png()
      .toBuffer(),
  );
  const pngMimeRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      metadataObj: buildMetadata({ photo_sha256: sha256Hex(pngBytes) }),
      photoBytes: pngBytes,
      photoMimeType: "image/png",
    }),
    VALID_ENV,
    deps,
  );
  assert.equal(pngMimeRes.status, 422);
  assert.deepEqual(await pngMimeRes.json(), { ok: false, code: "PHOTO_INVALID" });

  // 3. PNG bytes disguised with Content-Type: image/jpeg and .jpg filename
  const disguisedPngRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      metadataObj: buildMetadata({ photo_sha256: sha256Hex(pngBytes) }),
      photoBytes: pngBytes,
      photoMimeType: "image/jpeg",
      photoFileName: "disguised.jpg",
    }),
    VALID_ENV,
    deps,
  );
  assert.equal(disguisedPngRes.status, 422);
  assert.deepEqual(await disguisedPngRes.json(), { ok: false, code: "PHOTO_INVALID" });

  // 4. Minimal fake JPEG magic stub (FF D8 FF E0 FF D9 — passes magic/trailer, fails real JPEG decode)
  const fakeJpegStub = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9]);
  const stubRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      metadataObj: buildMetadata({ photo_sha256: sha256Hex(fakeJpegStub) }),
      photoBytes: fakeJpegStub,
    }),
    VALID_ENV,
    deps,
  );
  assert.equal(stubRes.status, 422);
  assert.deepEqual(await stubRes.json(), { ok: false, code: "PHOTO_INVALID" });

  // 5. Polyglot JPEG containing embedded <script> markup
  const polyglotBytes = new Uint8Array([
    ...jpeg.subarray(0, jpeg.length - 2),
    ...new TextEncoder().encode("<script>alert(1)</script>"),
    0xff,
    0xd9,
  ]);
  const polyglotRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      metadataObj: buildMetadata({ photo_sha256: sha256Hex(polyglotBytes) }),
      photoBytes: polyglotBytes,
    }),
    VALID_ENV,
    deps,
  );
  assert.equal(polyglotRes.status, 422);
  assert.deepEqual(await polyglotRes.json(), { ok: false, code: "PHOTO_INVALID" });

  // 6. Oversized body (> 10 MiB + 64 KiB) via Content-Length
  const tooLargeReq = new Request("https://bi.example.test/api/attendance/check-in", {
    method: "POST",
    headers: {
      origin: "https://bi.example.test",
      host: "bi.example.test",
      "content-type": "multipart/form-data; boundary=---test",
      "content-length": String(11 * 1024 * 1024),
      "idempotency-key": KEY_1,
    },
    body: "x",
  });
  const tooLargeRes = await postAttendanceCheckIn(tooLargeReq, VALID_ENV, deps);
  assert.equal(tooLargeRes.status, 413);
  assert.deepEqual(await tooLargeRes.json(), { ok: false, code: "BODY_TOO_LARGE" });

  // 7. SHA-256 mismatch
  const wrongShaRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      metadataObj: buildMetadata({ photo_sha256: "f".repeat(64) }),
      photoBytes: jpeg,
    }),
    VALID_ENV,
    deps,
  );
  assert.equal(wrongShaRes.status, 422);
  assert.deepEqual(await wrongShaRes.json(), {
    ok: false,
    code: "PHOTO_HASH_MISMATCH",
  });

  assert.equal(r2.objects.size, 0);
  assert.equal(repo.calls.length, 0);
});

test("SERVER_ANCHORED and DEVICE_CLOCK_UNVERIFIED succeed with deterministic R2 replay, conflict protection, and orphan-free cleanup", async () => {
  const jpegA = await realJpegA();
  const shaA = sha256Hex(jpegA);
  const jpegB = await realJpegB();
  const shaB = sha256Hex(jpegB);

  const r2 = createFakeR2Harness();
  const repo = createInMemoryCheckInRepo();
  const deps = {
    resolveSession: activeSession(ACTOR_A),
    repository: repo.repository,
    storage: r2.storage,
    now: () => FIXED_NOW_MS,
  };

  // 1. Create SERVER_ANCHORED check-in (client skew +2s within 5s tolerance; backend uses token + elapsed!)
  const createMeta = buildMetadata({
    idempotency_key: KEY_1,
    photo_sha256: shaA,
    client_captured_at: "2026-10-23T08:20:14.000+07:00", // +2s skew vs 08:20:12.000+07:00
  });
  const firstRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      idempotencyHeader: KEY_1,
      metadataObj: createMeta,
      photoBytes: jpegA,
    }),
    VALID_ENV,
    deps,
  );
  assert.equal(firstRes.status, 201);
  assert.equal(firstRes.headers.get("cache-control"), "private, no-store");
  const firstBody = await firstRes.json();
  assert.equal(firstBody.ok, true);
  assert.deepEqual(Object.keys(firstBody.checkin).sort(), [
    "business_date",
    "captured_at",
    "checkin_id",
    "daily_count",
    "received_at",
    "replayed",
    "sequence_in_day",
    "time_source",
  ]);
  assert.equal(firstBody.checkin.captured_at, "2026-10-23T01:20:12.000Z");
  assert.equal(firstBody.checkin.business_date, "2026-10-23");
  assert.equal(firstBody.checkin.sequence_in_day, 1);
  assert.equal(firstBody.checkin.daily_count, 1);
  assert.equal(firstBody.checkin.time_source, "SERVER_ANCHORED");
  assert.equal(firstBody.checkin.replayed, false);
  assert.doesNotMatch(
    JSON.stringify(firstBody),
    /storage_key|hrp-bi-preview|attendance-checkins|time_token|92000000/,
  );

  // Stored R2 bytes are byte-for-byte identical to uploaded JPEG (no re-encoding altering SHA-256)
  const expectedStorageKey = attendancePhotoObjectKey(
    "preview",
    ACTOR_A.app_user_id,
    KEY_1,
  );
  assert.equal(r2.objects.size, 1);
  assert.deepEqual(r2.objects.get(expectedStorageKey).bytes, jpegA);
  assert.equal(
    r2.commands.filter((c) => c.op === "put").length,
    1,
    "initial check-in uploads photo once",
  );

  // 2. Idempotent retry with exact same key & payload returns 200, same checkin_id, NO second PutObject!
  const replayRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      idempotencyHeader: KEY_1,
      metadataObj: createMeta,
      photoBytes: jpegA,
    }),
    VALID_ENV,
    deps,
  );
  assert.equal(replayRes.status, 200);
  const replayBody = await replayRes.json();
  assert.equal(replayBody.checkin.checkin_id, firstBody.checkin.checkin_id);
  assert.equal(replayBody.checkin.replayed, true);
  assert.equal(
    r2.commands.filter((c) => c.op === "put").length,
    1,
    "retry reuses deterministic R2 object without re-uploading",
  );
  assert.equal(r2.objects.size, 1);

  // 3. Same key with DIFFERENT photo SHA/bytes conflicts at R2 check without overwriting or deleting original photo!
  const photoConflictRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      idempotencyHeader: KEY_1,
      metadataObj: { ...createMeta, photo_sha256: shaB },
      photoBytes: jpegB,
    }),
    VALID_ENV,
    deps,
  );
  assert.equal(photoConflictRes.status, 409);
  assert.deepEqual(await photoConflictRes.json(), {
    ok: false,
    code: "IDEMPOTENCY_CONFLICT",
  });
  assert.deepEqual(
    r2.objects.get(expectedStorageKey).bytes,
    jpegA,
    "conflicting retry must never overwrite or delete the original object",
  );

  // 4. Same key + same photo (`created_now = false`) + different metadata (`note`) conflicts at DB and MUST NOT delete pre-existing R2 object!
  const metaConflictRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      idempotencyHeader: KEY_1,
      metadataObj: { ...createMeta, note: "Sửa ghi chú trái phép" },
      photoBytes: jpegA,
    }),
    VALID_ENV,
    deps,
  );
  assert.equal(metaConflictRes.status, 409);
  assert.deepEqual(await metaConflictRes.json(), {
    ok: false,
    code: "IDEMPOTENCY_CONFLICT",
  });
  assert.equal(
    r2.objects.has(expectedStorageKey),
    true,
    "pre-existing object from earlier successful attempt must never be deleted on conflict",
  );

  // 5. DB failure AFTER uploading a NEW object (`KEY_2`, `created_now = true`) deletes the newly created object so zero orphan remains!
  const key2StorageKey = attendancePhotoObjectKey(
    "preview",
    ACTOR_A.app_user_id,
    KEY_2,
  );
  const failingRepo = {
    async lookupCheckInIdempotency() {
      return { ok: true, found: false };
    },
    async recordCheckIn() {
      return { ok: false, code: "ATTENDANCE_UNAVAILABLE" };
    },
  };
  const dbFailRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      idempotencyHeader: KEY_2,
      metadataObj: buildMetadata({
        idempotency_key: KEY_2,
        photo_sha256: shaB,
        time_source: "DEVICE_CLOCK_UNVERIFIED",
        time_token: null,
        elapsed_since_anchor_ms: null,
        client_captured_at: "2026-10-21T07:45:00.000+07:00",
      }),
      photoBytes: jpegB,
    }),
    VALID_ENV,
    { ...deps, repository: failingRepo },
  );
  assert.equal(dbFailRes.status, 503);
  assert.deepEqual(await dbFailRes.json(), {
    ok: false,
    code: "ATTENDANCE_UNAVAILABLE",
  });
  assert.equal(
    r2.objects.has(key2StorageKey),
    false,
    "newly uploaded object must be deleted when DB write fails",
  );

  // 6. Subsequent retry of `KEY_2` (`DEVICE_CLOCK_UNVERIFIED` offline outbox item from 2 days ago) succeeds cleanly!
  const offlineSuccessRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      idempotencyHeader: KEY_2,
      metadataObj: buildMetadata({
        idempotency_key: KEY_2,
        photo_sha256: shaB,
        time_source: "DEVICE_CLOCK_UNVERIFIED",
        time_token: null,
        elapsed_since_anchor_ms: null,
        client_captured_at: "2026-10-21T07:45:00.000+07:00",
      }),
      photoBytes: jpegB,
    }),
    VALID_ENV,
    deps,
  );
  assert.equal(offlineSuccessRes.status, 201);
  const offlineBody = await offlineSuccessRes.json();
  assert.equal(offlineBody.checkin.business_date, "2026-10-21");
  assert.equal(offlineBody.checkin.sequence_in_day, 1);
  assert.equal(offlineBody.checkin.time_source, "DEVICE_CLOCK_UNVERIFIED");
  assert.equal(offlineBody.checkin.replayed, false);
  assert.equal(r2.objects.has(key2StorageKey), true);
});

test("SERVER_ANCHORED offline sync grace enforces 24h capture ceiling, deterministic 7-day sync window, original captured_at preservation, and idempotent multi-retry", async () => {
  const jpeg = await realJpegA();
  const sha = sha256Hex(jpeg);
  const r2 = createFakeR2Harness();
  const repo = createInMemoryCheckInRepo();

  const anchorMs = Date.parse("2026-10-15T01:00:00.000Z"); // 08:00:00.000+07:00
  const issued = issueAttendanceTimeToken({
    secret: Buffer.from(DEDICATED_SECRET, "utf8"),
    app_user_id: ACTOR_A.app_user_id,
    now_ms: anchorMs,
    nonce_hex: "aa11bb22cc33dd44ee55ff6677889900",
  });

  // 1. Token past 24h TTL (synced 78h after anchor), elapsed = 2h (<= 24h):
  //    captured_at = 2026-10-15T03:00:00.000Z (10:00+07:00), sync delay = 76h (<= 7d)
  const keyDelayed = "c1000000-0000-4000-8000-0000000000a1";
  const twoHoursMs = 2 * 3_600_000;
  const originalCapturedMs = anchorMs + twoHoursMs; // 2026-10-15T03:00:00.000Z
  const syncAt78hMs = anchorMs + 78 * 3_600_000; // 2026-10-18T07:00:00.000Z
  const delayedMeta = {
    latitude: 10.7769,
    longitude: 106.7009,
    accuracy_meters: 6.5,
    address_hint: "Nhà máy Bình Dương",
    client_captured_at: "2026-10-15T10:00:01.500+07:00", // +1.5s skew within 5s tolerance
    note: "Mất sóng công trường",
    idempotency_key: keyDelayed,
    photo_sha256: sha,
    time_source: "SERVER_ANCHORED",
    time_token: issued.time_token,
    elapsed_since_anchor_ms: twoHoursMs,
  };

  const delayedCreateRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      idempotencyHeader: keyDelayed,
      metadataObj: delayedMeta,
      photoBytes: jpeg,
    }),
    VALID_ENV,
    {
      resolveSession: activeSession(ACTOR_A),
      repository: repo.repository,
      storage: r2.storage,
      now: () => syncAt78hMs,
    },
  );
  assert.equal(delayedCreateRes.status, 201);
  const delayedCreateBody = await delayedCreateRes.json();
  assert.equal(delayedCreateBody.ok, true);
  assert.equal(
    delayedCreateBody.checkin.captured_at,
    new Date(originalCapturedMs).toISOString(),
    "delayed sync must preserve exact original server-derived captured_at without re-anchoring",
  );
  assert.equal(delayedCreateBody.checkin.business_date, "2026-10-15");
  assert.equal(
    delayedCreateBody.checkin.received_at,
    new Date(syncAt78hMs).toISOString(),
  );
  assert.equal(delayedCreateBody.checkin.time_source, "SERVER_ANCHORED");
  assert.equal(delayedCreateBody.checkin.replayed, false);
  assert.equal(r2.objects.size, 1);
  assert.equal(r2.commands.filter((c) => c.op === "put").length, 1);

  // 2. Multiple retries of the same idempotency_key later inside the 7-day window (+96h and +150h)
  //    never create duplicate check-in rows or duplicate R2 uploads, and never mutate captured_at!
  for (const retryHours of [96, 150]) {
    const retryRes = await postAttendanceCheckIn(
      buildMultipartCheckInRequest({
        idempotencyHeader: keyDelayed,
        metadataObj: delayedMeta,
        photoBytes: jpeg,
      }),
      VALID_ENV,
      {
        resolveSession: activeSession(ACTOR_A),
        repository: repo.repository,
        storage: r2.storage,
        now: () => anchorMs + retryHours * 3_600_000,
      },
    );
    assert.equal(retryRes.status, 200);
    const retryBody = await retryRes.json();
    assert.equal(retryBody.checkin.checkin_id, delayedCreateBody.checkin.checkin_id);
    assert.equal(
      retryBody.checkin.captured_at,
      new Date(originalCapturedMs).toISOString(),
    );
    assert.equal(
      retryBody.checkin.received_at,
      new Date(syncAt78hMs).toISOString(),
    );
    assert.equal(retryBody.checkin.sequence_in_day, 1);
    assert.equal(retryBody.checkin.daily_count, 1);
    assert.equal(retryBody.checkin.replayed, true);
  }
  assert.equal(repo.byActorKey.size, 1);
  assert.equal(r2.objects.size, 1);
  assert.equal(r2.commands.filter((c) => c.op === "put").length, 1);

  // 3. Exact 24h elapsed_since_anchor_ms boundary (86,400,000 ms) + exact 7-day sync window boundary
  //    (server_now - captured_at === 604,800,000 ms): ACCEPTED!
  const keyBoundaryExact = "c1000000-0000-4000-8000-0000000000a2";
  const maxElapsedCapturedMs = anchorMs + ATTENDANCE_TIME_TOKEN_TTL_MS; // 2026-10-16T01:00:00.000Z
  const exact7dSyncNowMs = maxElapsedCapturedMs + ATTENDANCE_MAX_SYNC_WINDOW_MS; // 2026-10-23T01:00:00.000Z
  const exactBoundaryRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      idempotencyHeader: keyBoundaryExact,
      metadataObj: {
        ...delayedMeta,
        idempotency_key: keyBoundaryExact,
        elapsed_since_anchor_ms: ATTENDANCE_TIME_TOKEN_TTL_MS,
        client_captured_at: new Date(maxElapsedCapturedMs).toISOString(),
      },
      photoBytes: jpeg,
    }),
    VALID_ENV,
    {
      resolveSession: activeSession(ACTOR_A),
      repository: repo.repository,
      storage: r2.storage,
      now: () => exact7dSyncNowMs,
    },
  );
  assert.equal(exactBoundaryRes.status, 201);
  const exactBoundaryBody = await exactBoundaryRes.json();
  assert.equal(
    exactBoundaryBody.checkin.captured_at,
    new Date(maxElapsedCapturedMs).toISOString(),
  );
  assert.equal(exactBoundaryBody.checkin.business_date, "2026-10-16");

  // 4. 1 millisecond past the 7-day sync window (server_now - captured_at === 604,800,001 ms):
  //    REJECTED with 422 ATTENDANCE_SYNC_WINDOW_EXPIRED before touching R2 or DB!
  const keyPast7d = "c1000000-0000-4000-8000-0000000000a3";
  const putCountBeforeRejects = r2.commands.filter((c) => c.op === "put").length;
  const repoCallsBeforeRejects = repo.calls.length;

  const past7dBy1msRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      idempotencyHeader: keyPast7d,
      metadataObj: {
        ...delayedMeta,
        idempotency_key: keyPast7d,
        elapsed_since_anchor_ms: twoHoursMs,
        client_captured_at: new Date(originalCapturedMs).toISOString(),
      },
      photoBytes: jpeg,
    }),
    VALID_ENV,
    {
      resolveSession: activeSession(ACTOR_A),
      repository: repo.repository,
      storage: r2.storage,
      now: () => originalCapturedMs + ATTENDANCE_MAX_SYNC_WINDOW_MS + 1,
    },
  );
  assert.equal(past7dBy1msRes.status, 422);
  assert.deepEqual(await past7dBy1msRes.json(), {
    ok: false,
    code: "ATTENDANCE_SYNC_WINDOW_EXPIRED",
  });

  // 5. elapsed_since_anchor_ms exceeding 24h (86,400,001 ms) is STILL rejected even when
  //    server_now - captured_at is well within 7 days (e.g. synced 2 days after anchor)!
  const keyElapsedOver24h = "c1000000-0000-4000-8000-0000000000a4";
  const over24hElapsedMs = ATTENDANCE_TIME_TOKEN_TTL_MS + 1;
  const over24hRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      idempotencyHeader: keyElapsedOver24h,
      metadataObj: {
        ...delayedMeta,
        idempotency_key: keyElapsedOver24h,
        elapsed_since_anchor_ms: over24hElapsedMs,
        client_captured_at: new Date(anchorMs + over24hElapsedMs).toISOString(),
      },
      photoBytes: jpeg,
    }),
    VALID_ENV,
    {
      resolveSession: activeSession(ACTOR_A),
      repository: repo.repository,
      storage: r2.storage,
      now: () => anchorMs + 2 * 86_400_000, // only ~24h after capture (<= 7d), yet elapsed > 24h!
    },
  );
  assert.equal(over24hRes.status, 400);
  assert.deepEqual(await over24hRes.json(), {
    ok: false,
    code: "ATTENDANCE_TIME_ELAPSED_INVALID",
  });

  // 6. Invalid signature, wrong actor, and future timestamp during grace window remain fail-closed!
  const keyGraceFailClosed = "c1000000-0000-4000-8000-0000000000a5";
  const tamperedGraceRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      idempotencyHeader: keyGraceFailClosed,
      metadataObj: {
        ...delayedMeta,
        idempotency_key: keyGraceFailClosed,
        time_token: `${issued.time_token.slice(0, -2)}zz`,
      },
      photoBytes: jpeg,
    }),
    VALID_ENV,
    {
      resolveSession: activeSession(ACTOR_A),
      repository: repo.repository,
      storage: r2.storage,
      now: () => syncAt78hMs,
    },
  );
  assert.equal(tamperedGraceRes.status, 422);
  assert.deepEqual(await tamperedGraceRes.json(), {
    ok: false,
    code: "ATTENDANCE_TIME_TOKEN_INVALID",
  });

  const wrongActorGraceRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      idempotencyHeader: keyGraceFailClosed,
      metadataObj: {
        ...delayedMeta,
        idempotency_key: keyGraceFailClosed,
      },
      photoBytes: jpeg,
    }),
    VALID_ENV,
    {
      resolveSession: activeSession(ACTOR_B),
      repository: repo.repository,
      storage: r2.storage,
      now: () => syncAt78hMs,
    },
  );
  assert.equal(wrongActorGraceRes.status, 403);
  assert.deepEqual(await wrongActorGraceRes.json(), {
    ok: false,
    code: "ATTENDANCE_TIME_TOKEN_ACTOR_MISMATCH",
  });

  const futureGraceRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      idempotencyHeader: keyGraceFailClosed,
      metadataObj: {
        ...delayedMeta,
        idempotency_key: keyGraceFailClosed,
      },
      photoBytes: jpeg,
    }),
    VALID_ENV,
    {
      resolveSession: activeSession(ACTOR_A),
      repository: repo.repository,
      storage: r2.storage,
      now: () => originalCapturedMs - 60_000, // server_now is 60s before captured_at (> 30s tolerance)
    },
  );
  assert.equal(futureGraceRes.status, 422);
  assert.deepEqual(await futureGraceRes.json(), {
    ok: false,
    code: "CAPTURED_AT_FUTURE",
  });

  assert.equal(
    r2.commands.filter((c) => c.op === "put").length,
    putCountBeforeRejects,
    "all rejected grace-window requests must never upload objects to R2",
  );
  assert.equal(repo.calls.length, repoCallsBeforeRejects);
});

test("post-168h idempotency precedes sync-window rejection: replays saved SERVER_ANCHORED check-in after >7 days, returns 409 on fingerprint mismatch, and rejects unsaved stale keys without R2/DB writes", async () => {
  const jpegA = await realJpegA();
  const shaA = sha256Hex(jpegA);
  const jpegB = await realJpegB();
  const shaB = sha256Hex(jpegB);

  const r2 = createFakeR2Harness();
  const repo = createInMemoryCheckInRepo();

  const anchorMs = Date.parse("2026-10-01T01:00:00.000Z"); // 08:00:00.000+07:00
  const issuedA = issueAttendanceTimeToken({
    secret: Buffer.from(DEDICATED_SECRET, "utf8"),
    app_user_id: ACTOR_A.app_user_id,
    now_ms: anchorMs,
    nonce_hex: "11223344556677889900aabbccddeeff",
  });
  const issuedB = issueAttendanceTimeToken({
    secret: Buffer.from(DEDICATED_SECRET, "utf8"),
    app_user_id: ACTOR_B.app_user_id,
    now_ms: anchorMs,
    nonce_hex: "ffeeddccbbaa00998877665544332211",
  });

  const keySaved = "d3000000-0000-4000-8000-000000000001";
  const elapsedMs = 3_600_000; // +1h => captured_at = 2026-10-01T02:00:00.000Z (09:00+07:00)
  const capturedAtMs = anchorMs + elapsedMs;
  const initialReceivedAtMs = capturedAtMs + 48 * 3_600_000; // synced +48h later (within 7d; HTTP response lost on client)

  const savedMeta = {
    latitude: 21.0285,
    longitude: 105.8542,
    accuracy_meters: 9.0,
    address_hint: "KCN Bắc Thăng Long",
    client_captured_at: new Date(capturedAtMs + 1_000).toISOString(), // +1s skew
    note: "Chấm công đầu ca (mất response mạng)",
    idempotency_key: keySaved,
    photo_sha256: shaA,
    time_source: "SERVER_ANCHORED",
    time_token: issuedA.time_token,
    elapsed_since_anchor_ms: elapsedMs,
  };

  // Initial write succeeds within 168h (simulating lost HTTP response before client marks SYNCED)
  const initialRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      idempotencyHeader: keySaved,
      metadataObj: savedMeta,
      photoBytes: jpegA,
    }),
    VALID_ENV,
    {
      resolveSession: activeSession(ACTOR_A),
      repository: repo.repository,
      storage: r2.storage,
      now: () => initialReceivedAtMs,
    },
  );
  assert.equal(initialRes.status, 201);
  const initialBody = await initialRes.json();
  assert.equal(initialBody.checkin.replayed, false);
  assert.equal(initialBody.checkin.captured_at, new Date(capturedAtMs).toISOString());
  assert.equal(initialBody.checkin.received_at, new Date(initialReceivedAtMs).toISOString());
  assert.equal(initialBody.checkin.business_date, "2026-10-01");

  const r2CommandsAfterInitial = r2.commands.length;
  const repoWriteCallsAfterInitial = repo.calls.length;

  // 1. Retry of the ALREADY-SAVED check-in past 168h (+168h + 1ms, +10 days, and +30 days):
  //    MUST return 200 with exact saved projection (`replayed: true`), zero R2 commands, zero DB writes!
  for (const postWindowDelayMs of [
    ATTENDANCE_MAX_SYNC_WINDOW_MS + 1,
    10 * 86_400_000,
    30 * 86_400_000,
  ]) {
    const replayPast7dRes = await postAttendanceCheckIn(
      buildMultipartCheckInRequest({
        idempotencyHeader: keySaved,
        metadataObj: savedMeta,
        photoBytes: jpegA,
      }),
      VALID_ENV,
      {
        resolveSession: activeSession(ACTOR_A),
        repository: repo.repository,
        storage: r2.storage,
        now: () => capturedAtMs + postWindowDelayMs,
      },
    );
    assert.equal(
      replayPast7dRes.status,
      200,
      `saved check-in retried at +${postWindowDelayMs}ms must replay 200 instead of 422`,
    );
    const replayPast7dBody = await replayPast7dRes.json();
    assert.deepEqual(replayPast7dBody, {
      ok: true,
      checkin: {
        ...initialBody.checkin,
        replayed: true,
      },
    });
  }
  assert.equal(
    r2.commands.length,
    r2CommandsAfterInitial,
    "post-168h replay must not issue HeadObject, PutObject, or DeleteObject to R2",
  );
  assert.equal(
    repo.calls.length,
    repoWriteCallsAfterInitial,
    "post-168h replay must resolve via idempotency lookup without calling recordCheckIn",
  );

  // 2. Same actor + saved idempotency_key after >7 days with DIFFERENT fingerprint (metadata OR photo):
  //    MUST return 409 IDEMPOTENCY_CONFLICT (not 422), with zero R2 writes/deletes and zero DB mutations!
  const tenDaysAfterCaptureMs = capturedAtMs + 10 * 86_400_000;

  const noteConflictPast7dRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      idempotencyHeader: keySaved,
      metadataObj: { ...savedMeta, note: "Sửa ghi chú sau 10 ngày" },
      photoBytes: jpegA,
    }),
    VALID_ENV,
    {
      resolveSession: activeSession(ACTOR_A),
      repository: repo.repository,
      storage: r2.storage,
      now: () => tenDaysAfterCaptureMs,
    },
  );
  assert.equal(noteConflictPast7dRes.status, 409);
  assert.deepEqual(await noteConflictPast7dRes.json(), {
    ok: false,
    code: "IDEMPOTENCY_CONFLICT",
  });

  const photoConflictPast7dRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      idempotencyHeader: keySaved,
      metadataObj: { ...savedMeta, photo_sha256: shaB },
      photoBytes: jpegB,
    }),
    VALID_ENV,
    {
      resolveSession: activeSession(ACTOR_A),
      repository: repo.repository,
      storage: r2.storage,
      now: () => tenDaysAfterCaptureMs,
    },
  );
  assert.equal(photoConflictPast7dRes.status, 409);
  assert.deepEqual(await photoConflictPast7dRes.json(), {
    ok: false,
    code: "IDEMPOTENCY_CONFLICT",
  });

  // Spoofing original metadata.photo_sha256 while sending different JPEG bytes after >7 days
  // is still caught by byte hash verification before replay (422 PHOTO_HASH_MISMATCH)
  const spoofedPhotoBytesPast7dRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      idempotencyHeader: keySaved,
      metadataObj: savedMeta,
      photoBytes: jpegB,
    }),
    VALID_ENV,
    {
      resolveSession: activeSession(ACTOR_A),
      repository: repo.repository,
      storage: r2.storage,
      now: () => tenDaysAfterCaptureMs,
    },
  );
  assert.equal(spoofedPhotoBytesPast7dRes.status, 422);
  assert.deepEqual(await spoofedPhotoBytesPast7dRes.json(), {
    ok: false,
    code: "PHOTO_HASH_MISMATCH",
  });

  const savedStorageKey = attendancePhotoObjectKey("preview", ACTOR_A.app_user_id, keySaved);
  assert.deepEqual(r2.objects.get(savedStorageKey).bytes, jpegA);
  assert.equal(r2.commands.length, r2CommandsAfterInitial);
  assert.equal(repo.calls.length, repoWriteCallsAfterInitial);

  // 3. Unsaved/new idempotency_key arriving past 168h (+168h + 1ms and +10 days):
  //    MUST still be rejected with 422 ATTENDANCE_SYNC_WINDOW_EXPIRED, zero R2 upload, zero DB insert!
  const keyUnsavedStale = "d3000000-0000-4000-8000-000000000002";
  for (const staleDelayMs of [ATTENDANCE_MAX_SYNC_WINDOW_MS + 1, 10 * 86_400_000]) {
    const staleUnsavedRes = await postAttendanceCheckIn(
      buildMultipartCheckInRequest({
        idempotencyHeader: keyUnsavedStale,
        metadataObj: {
          ...savedMeta,
          idempotency_key: keyUnsavedStale,
          photo_sha256: shaB,
        },
        photoBytes: jpegB,
      }),
      VALID_ENV,
      {
        resolveSession: activeSession(ACTOR_A),
        repository: repo.repository,
        storage: r2.storage,
        now: () => capturedAtMs + staleDelayMs,
      },
    );
    assert.equal(staleUnsavedRes.status, 422);
    assert.deepEqual(await staleUnsavedRes.json(), {
      ok: false,
      code: "ATTENDANCE_SYNC_WINDOW_EXPIRED",
    });
  }

  // Different actor (ACTOR_B) reusing ACTOR_A's saved UUID with ACTOR_B's own token past 168h
  // has no saved row for ACTOR_B and is rejected with 422 (isolated per actor, zero cross-actor leak)
  const otherActorSameUuidStaleRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      idempotencyHeader: keySaved,
      metadataObj: {
        ...savedMeta,
        time_token: issuedB.time_token,
      },
      photoBytes: jpegA,
    }),
    VALID_ENV,
    {
      resolveSession: activeSession(ACTOR_B),
      repository: repo.repository,
      storage: r2.storage,
      now: () => tenDaysAfterCaptureMs,
    },
  );
  assert.equal(otherActorSameUuidStaleRes.status, 422);
  assert.deepEqual(await otherActorSameUuidStaleRes.json(), {
    ok: false,
    code: "ATTENDANCE_SYNC_WINDOW_EXPIRED",
  });

  assert.equal(
    r2.objects.size,
    1,
    "unsaved stale requests must never create objects in R2",
  );
  assert.equal(
    r2.commands.length,
    r2CommandsAfterInitial,
    "unsaved stale requests must not issue HeadObject or PutObject to R2",
  );
  assert.equal(
    repo.calls.length,
    repoWriteCallsAfterInitial,
    "unsaved stale requests must never invoke recordCheckIn",
  );
  assert.equal(repo.byActorKey.size, 1);

  // 4. Pre-DB-commit interrupted R2 object safety (within 168h window):
  //    If an earlier attempt uploaded to R2 (`keyInterrupted`) and crashed before DB commit,
  //    matching photo SHA reuses R2 object (`created_now = false`), while mismatched SHA returns 409!
  const keyInterrupted = "d3000000-0000-4000-8000-000000000003";
  const preStaged = await r2.storage.ensureCheckInPhoto({
    app_user_id: ACTOR_A.app_user_id,
    idempotency_key: keyInterrupted,
    photo_sha256: shaA,
    bytes: jpegA,
  });
  assert.equal(preStaged.ok, true);
  assert.equal(preStaged.created_now, true);

  const preStagedConflictRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      idempotencyHeader: keyInterrupted,
      metadataObj: {
        ...savedMeta,
        idempotency_key: keyInterrupted,
        photo_sha256: shaB,
      },
      photoBytes: jpegB,
    }),
    VALID_ENV,
    {
      resolveSession: activeSession(ACTOR_A),
      repository: repo.repository,
      storage: r2.storage,
      now: () => initialReceivedAtMs,
    },
  );
  assert.equal(preStagedConflictRes.status, 409);
  assert.deepEqual(await preStagedConflictRes.json(), {
    ok: false,
    code: "IDEMPOTENCY_CONFLICT",
  });

  const putCountBeforeResume = r2.commands.filter((c) => c.op === "put").length;
  const preStagedResumeRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      idempotencyHeader: keyInterrupted,
      metadataObj: {
        ...savedMeta,
        idempotency_key: keyInterrupted,
        photo_sha256: shaA,
      },
      photoBytes: jpegA,
    }),
    VALID_ENV,
    {
      resolveSession: activeSession(ACTOR_A),
      repository: repo.repository,
      storage: r2.storage,
      now: () => initialReceivedAtMs,
    },
  );
  assert.equal(preStagedResumeRes.status, 201);
  assert.equal(
    r2.commands.filter((c) => c.op === "put").length,
    putCountBeforeResume,
    "resuming an interrupted upload with matching SHA reuses pre-existing R2 object without PutObject",
  );
});

test("createServiceAttendanceRepository maps SQL errors without leaking details and route handlers enforce nodejs/force-dynamic/RPC-only boundary", async () => {
  const { readFileSync } = await import("node:fs");
  const { createServiceAttendanceRepository } = await import("./attendance-repository.ts");
  const timeRouteSrc = readFileSync(
    new URL("../../app/api/attendance/time/route.ts", import.meta.url),
    "utf8",
  );
  const checkInRouteSrc = readFileSync(
    new URL("../../app/api/attendance/check-in/route.ts", import.meta.url),
    "utf8",
  );
  const repoSrc = readFileSync(
    new URL("./attendance-repository.ts", import.meta.url),
    "utf8",
  );

  assert.match(timeRouteSrc, /export const runtime = "nodejs"/);
  assert.match(timeRouteSrc, /export const dynamic = "force-dynamic"/);
  assert.match(timeRouteSrc, /export async function GET\(/);
  assert.doesNotMatch(timeRouteSrc, /export async function (POST|PUT|PATCH|DELETE)/);
  assert.doesNotMatch(timeRouteSrc, /\.from\s*\(/);

  assert.match(checkInRouteSrc, /export const runtime = "nodejs"/);
  assert.match(checkInRouteSrc, /export const dynamic = "force-dynamic"/);
  assert.match(checkInRouteSrc, /export async function POST\(/);
  assert.doesNotMatch(checkInRouteSrc, /export async function (GET|PUT|PATCH|DELETE)/);
  assert.doesNotMatch(checkInRouteSrc, /\.from\s*\(/);
  assert.doesNotMatch(repoSrc, /\.from\s*\(/);

  const baseInput = {
    auth_subject: ACTOR_A.auth_subject,
    app_user_id: ACTOR_A.app_user_id,
    idempotency_key: KEY_1,
    request_fingerprint: "a".repeat(64),
    latitude: 21.0285,
    longitude: 105.8542,
    accuracy_meters: 10,
    address_hint: "Hà Nội",
    note: "",
    device_claimed_at: "2026-10-23T01:20:12.000Z",
    time_source: "DEVICE_CLOCK_UNVERIFIED",
    time_anchor_issued_at: null,
    elapsed_since_anchor_ms: null,
    time_token_digest: null,
    photo_storage_key: `preview/attendance-checkins/${ACTOR_A.app_user_id}/${KEY_1}.jpg`,
    photo_sha256: "b".repeat(64),
    photo_size_bytes: 1024,
    photo_mime_type: "image/jpeg",
    received_at: "2026-10-23T01:25:00.000Z",
  };

  const syncExpiredRepo = createServiceAttendanceRepository(async () => ({
    data: null,
    error: { code: "22023", message: "ATTENDANCE_SYNC_WINDOW_EXPIRED" },
  }));
  assert.deepEqual(await syncExpiredRepo.recordCheckIn(baseInput), {
    ok: false,
    code: "ATTENDANCE_SYNC_WINDOW_EXPIRED",
  });

  const deniedRepo = createServiceAttendanceRepository(async () => ({
    data: null,
    error: { code: "42501", message: "actor mapping denied" },
  }));
  assert.deepEqual(await deniedRepo.recordCheckIn(baseInput), {
    ok: false,
    code: "ACTOR_NOT_AVAILABLE",
  });

  const conflictRepo = createServiceAttendanceRepository(async () => ({
    data: null,
    error: { code: "40001", message: "IDEMPOTENCY_CONFLICT" },
  }));
  assert.deepEqual(await conflictRepo.recordCheckIn(baseInput), {
    ok: false,
    code: "IDEMPOTENCY_CONFLICT",
  });

  const unexpectedSqlRepo = createServiceAttendanceRepository(async () => ({
    data: null,
    error: {
      code: "XX000",
      message: "internal relation attendance_checkins detail secret",
    },
  }));
  assert.deepEqual(await unexpectedSqlRepo.recordCheckIn(baseInput), {
    ok: false,
    code: "ATTENDANCE_UNAVAILABLE",
  });

  const lookupBaseInput = {
    auth_subject: ACTOR_A.auth_subject,
    app_user_id: ACTOR_A.app_user_id,
    idempotency_key: KEY_1,
    request_fingerprint: "a".repeat(64),
  };

  const notFoundLookupRepo = createServiceAttendanceRepository(async () => ({
    data: { found: false },
    error: null,
  }));
  assert.deepEqual(await notFoundLookupRepo.lookupCheckInIdempotency(lookupBaseInput), {
    ok: true,
    found: false,
  });

  const foundLookupRepo = createServiceAttendanceRepository(async () => ({
    data: {
      found: true,
      checkin: {
        checkin_id: "d2000000-0000-4000-8000-000000000099",
        business_date: "2026-10-01",
        sequence_in_day: 1,
        daily_count: 2,
        captured_at: "2026-10-01T02:00:00.000Z",
        received_at: "2026-10-03T02:00:00.000Z",
        time_source: "SERVER_ANCHORED",
        replayed: true,
      },
    },
    error: null,
  }));
  const foundLookup = await foundLookupRepo.lookupCheckInIdempotency(lookupBaseInput);
  assert.equal(foundLookup.ok, true);
  assert.equal(foundLookup.found, true);
  assert.equal(foundLookup.checkin.replayed, true);

  assert.deepEqual(await conflictRepo.lookupCheckInIdempotency(lookupBaseInput), {
    ok: false,
    code: "IDEMPOTENCY_CONFLICT",
  });
  assert.deepEqual(await deniedRepo.lookupCheckInIdempotency(lookupBaseInput), {
    ok: false,
    code: "ACTOR_NOT_AVAILABLE",
  });

  const nonReplayedLookupRepo = createServiceAttendanceRepository(async () => ({
    data: {
      found: true,
      checkin: {
        checkin_id: "d2000000-0000-4000-8000-000000000099",
        business_date: "2026-10-01",
        sequence_in_day: 1,
        daily_count: 1,
        captured_at: "2026-10-01T02:00:00.000Z",
        received_at: "2026-10-03T02:00:00.000Z",
        time_source: "SERVER_ANCHORED",
        replayed: false,
      },
    },
    error: null,
  }));
  assert.deepEqual(await nonReplayedLookupRepo.lookupCheckInIdempotency(lookupBaseInput), {
    ok: false,
    code: "ATTENDANCE_UNAVAILABLE",
  });
});
