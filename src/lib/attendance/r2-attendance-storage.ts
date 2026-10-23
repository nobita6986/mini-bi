import "server-only";

import { Buffer } from "node:buffer";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  DOCUMENT_MAX_UPLOAD_BYTES,
  sha256Hex,
  type DocumentEnvironment,
} from "../direct-entry/document-r2-contract.ts";
import { loadR2Config } from "../direct-entry/r2-document-storage.ts";
import { isUuid } from "../http/direct-entry-api-guard.ts";

const SHA256_LOWER_HEX = /^[0-9a-f]{64}$/;
const ATTENDANCE_STORAGE_KEY_REGEX =
  /^(?:preview|production)\/attendance-checkins\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jpg$/;

export type EnsureAttendancePhotoResult =
  | {
      ok: true;
      storage_key: string;
      created_now: boolean;
    }
  | {
      ok: false;
      kind: "conflict";
    };

export type AttendanceObjectStorage = {
  available(): boolean;
  ensureCheckInPhoto(input: {
    app_user_id: string;
    idempotency_key: string;
    photo_sha256: string;
    bytes: Uint8Array;
  }): Promise<EnsureAttendancePhotoResult>;
  deleteNewlyCreatedCheckInPhoto(storageKey: string): Promise<void>;
};

type S3CommandSender = { send(command: unknown): Promise<unknown> };

export type R2AttendanceStorageDependencies = {
  client?: S3CommandSender;
};

export function attendancePhotoObjectKey(
  environment: DocumentEnvironment,
  appUserId: string,
  idempotencyKey: string,
): string {
  const actor = appUserId.trim().toLowerCase();
  const key = idempotencyKey.trim().toLowerCase();
  if (!isUuid(actor) || !isUuid(key)) {
    throw new Error("ATTENDANCE_STORAGE_KEY_INVALID");
  }
  return `${environment}/attendance-checkins/${actor}/${key}.jpg`;
}

export function isAttendancePhotoObjectKey(value: unknown): value is string {
  return typeof value === "string" && ATTENDANCE_STORAGE_KEY_REGEX.test(value);
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const value = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return (
    value.name === "NotFound" ||
    value.name === "NoSuchKey" ||
    value.$metadata?.httpStatusCode === 404
  );
}

export const unavailableAttendanceStorage: AttendanceObjectStorage = {
  available: () => false,
  async ensureCheckInPhoto() {
    throw new Error("ATTENDANCE_STORAGE_UNAVAILABLE");
  },
  async deleteNewlyCreatedCheckInPhoto() {
    throw new Error("ATTENDANCE_STORAGE_UNAVAILABLE");
  },
};

export function createR2AttendanceStorage(
  env: Record<string, string | undefined> = process.env,
  dependencies: R2AttendanceStorageDependencies = {},
): AttendanceObjectStorage {
  const config = loadR2Config(env);
  if (!config) {
    return unavailableAttendanceStorage;
  }

  let client: S3CommandSender | undefined = dependencies.client;
  const getClient = (): S3CommandSender => {
    client ??= new S3Client({
      region: "auto",
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    }) as unknown as S3CommandSender;
    return client;
  };

  return {
    available: () => true,
    async ensureCheckInPhoto(input) {
      if (
        !SHA256_LOWER_HEX.test(input.photo_sha256) ||
        input.bytes.byteLength < 1 ||
        input.bytes.byteLength > DOCUMENT_MAX_UPLOAD_BYTES
      ) {
        throw new Error("ATTENDANCE_PHOTO_STORAGE_INPUT_INVALID");
      }

      const storageKey = attendancePhotoObjectKey(
        config.environment,
        input.app_user_id,
        input.idempotency_key,
      );

      let existingHead: {
        ContentLength?: number;
        ContentType?: string;
        Metadata?: Record<string, string | undefined>;
      } | null = null;

      try {
        existingHead = (await getClient().send(
          new HeadObjectCommand({
            Bucket: config.bucket,
            Key: storageKey,
          }),
        )) as {
          ContentLength?: number;
          ContentType?: string;
          Metadata?: Record<string, string | undefined>;
        };
      } catch (error) {
        if (!isNotFound(error)) {
          throw error;
        }
      }

      if (existingHead !== null) {
        if (
          typeof existingHead.ContentLength !== "number" ||
          !Number.isSafeInteger(existingHead.ContentLength) ||
          existingHead.ContentLength < 1 ||
          existingHead.ContentLength > DOCUMENT_MAX_UPLOAD_BYTES
        ) {
          throw new Error("ATTENDANCE_STORAGE_UNAVAILABLE");
        }

        if (existingHead.ContentLength !== input.bytes.byteLength) {
          return { ok: false, kind: "conflict" };
        }

        const rawMetaSha = existingHead.Metadata?.sha256?.trim().toLowerCase();
        if (rawMetaSha && SHA256_LOWER_HEX.test(rawMetaSha)) {
          if (rawMetaSha !== input.photo_sha256) {
            return { ok: false, kind: "conflict" };
          }
          return {
            ok: true,
            storage_key: storageKey,
            created_now: false,
          };
        }

        // Fallback when custom metadata was omitted: verify actual stored object bytes.
        const objectResponse = (await getClient().send(
          new GetObjectCommand({
            Bucket: config.bucket,
            Key: storageKey,
          }),
        )) as {
          ContentLength?: number;
          Body?: { transformToByteArray(): Promise<Uint8Array> };
        };
        if (
          !objectResponse.Body ||
          typeof objectResponse.ContentLength !== "number" ||
          objectResponse.ContentLength !== input.bytes.byteLength
        ) {
          throw new Error("ATTENDANCE_STORAGE_UNAVAILABLE");
        }
        const storedBytes = await objectResponse.Body.transformToByteArray();
        if (storedBytes.byteLength !== input.bytes.byteLength) {
          return { ok: false, kind: "conflict" };
        }
        if (sha256Hex(storedBytes) !== input.photo_sha256) {
          return { ok: false, kind: "conflict" };
        }
        return {
          ok: true,
          storage_key: storageKey,
          created_now: false,
        };
      }

      await getClient().send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: storageKey,
          Body: Buffer.from(input.bytes),
          ContentType: "image/jpeg",
          ContentLength: input.bytes.byteLength,
          ContentDisposition: "attachment",
          Metadata: {
            sha256: input.photo_sha256,
          },
        }),
      );

      return {
        ok: true,
        storage_key: storageKey,
        created_now: true,
      };
    },

    async deleteNewlyCreatedCheckInPhoto(storageKey) {
      if (!isAttendancePhotoObjectKey(storageKey)) {
        throw new Error("ATTENDANCE_STORAGE_KEY_INVALID");
      }
      if (!storageKey.startsWith(`${config.environment}/attendance-checkins/`)) {
        throw new Error("ATTENDANCE_STORAGE_KEY_INVALID");
      }
      try {
        await getClient().send(
          new DeleteObjectCommand({
            Bucket: config.bucket,
            Key: storageKey,
          }),
        );
      } catch (error) {
        if (isNotFound(error)) return;
        throw error;
      }
    },
  };
}
