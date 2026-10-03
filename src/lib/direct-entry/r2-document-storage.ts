import "server-only";

import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { DocumentType } from "../contracts/direct-entry-v1.ts";
import {
  DOCUMENT_BUCKETS,
  DOCUMENT_DOWNLOAD_URL_TTL_SECONDS,
  DOCUMENT_MAX_UPLOAD_BYTES,
  DOCUMENT_UPLOAD_URL_TTL_SECONDS,
  attachmentDisposition,
  finalObjectKey,
  genericDownloadName,
  stagingObjectKey,
  type DocumentEnvironment,
  type DocumentMimeType,
} from "./document-r2-contract.ts";

export type R2Config = {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  environment: DocumentEnvironment;
};

export type StagedObjectHead =
  | { kind: "missing" }
  | { kind: "found"; size_bytes: number; content_type: string | null };

export type SignedDocumentUrl = {
  url: string;
  expires_at: string;
  headers: Record<string, string>;
};

// All methods throw on provider failure; callers map that to DOCUMENT_STORAGE_UNAVAILABLE.
export type DocumentObjectStorage = {
  available(): boolean;
  createUploadUrl(input: {
    storage_key: string;
    mime_type: DocumentMimeType;
    size_bytes: number;
  }): Promise<SignedDocumentUrl>;
  headStaged(storageKey: string): Promise<StagedObjectHead>;
  readStaged(storageKey: string): Promise<Uint8Array | null>;
  promote(input: { storage_key: string; mime_type: DocumentMimeType }): Promise<void>;
  deleteStaged(storageKey: string): Promise<void>;
  createDownloadUrl(input: {
    storage_key: string;
    mime_type: DocumentMimeType;
    document_type: DocumentType;
    version: number;
  }): Promise<SignedDocumentUrl>;
};

type Send = { send(command: unknown): Promise<unknown> };
type Presign = (
  client: Send,
  command: unknown,
  options: { expiresIn: number; signableHeaders?: Set<string> },
) => Promise<string>;

export type R2Dependencies = {
  client?: Send;
  presign?: Presign;
  now?: () => number;
};

const ACCOUNT_ID = /^[a-f0-9]{32}$/i;
const ACCESS_KEY_ID = /^[A-Za-z0-9]{16,128}$/;
const SECRET_ACCESS_KEY = /^[A-Za-z0-9/+=_-]{16,256}$/;

export function resolveDocumentEnvironment(
  env: Record<string, string | undefined>,
): DocumentEnvironment {
  return env.VERCEL_ENV === "production" ? "production" : "preview";
}

export function loadR2Config(env: Record<string, string | undefined>): R2Config | null {
  const accountId = env.R2_ACCOUNT_ID?.trim();
  const bucket = env.R2_BUCKET_NAME?.trim();
  const accessKeyId = env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY?.trim();
  const environment = resolveDocumentEnvironment(env);
  if (!accountId || !bucket || !accessKeyId || !secretAccessKey ||
      !ACCOUNT_ID.test(accountId) || !ACCESS_KEY_ID.test(accessKeyId) ||
      !SECRET_ACCESS_KEY.test(secretAccessKey) ||
      bucket !== DOCUMENT_BUCKETS[environment]) return null;
  return { accountId, bucket, accessKeyId, secretAccessKey, environment };
}

export const unavailableDocumentObjectStorage: DocumentObjectStorage = {
  available: () => false,
  async createUploadUrl() { throw new Error("DOCUMENT_STORAGE_UNAVAILABLE"); },
  async headStaged() { throw new Error("DOCUMENT_STORAGE_UNAVAILABLE"); },
  async readStaged() { throw new Error("DOCUMENT_STORAGE_UNAVAILABLE"); },
  async promote() { throw new Error("DOCUMENT_STORAGE_UNAVAILABLE"); },
  async deleteStaged() { throw new Error("DOCUMENT_STORAGE_UNAVAILABLE"); },
  async createDownloadUrl() { throw new Error("DOCUMENT_STORAGE_UNAVAILABLE"); },
};

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const value = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return value.name === "NotFound" || value.name === "NoSuchKey" ||
    value.$metadata?.httpStatusCode === 404;
}

export function createR2DocumentStorage(
  env: Record<string, string | undefined> = process.env,
  dependencies: R2Dependencies = {},
): DocumentObjectStorage {
  const config = loadR2Config(env);
  if (!config) return unavailableDocumentObjectStorage;
  const now = dependencies.now ?? Date.now;
  let client: Send | undefined = dependencies.client;
  const presign: Presign = dependencies.presign ??
    ((signer, command, options) =>
      getSignedUrl(signer as S3Client, command as never, options));
  const getClient = (): Send => {
    client ??= new S3Client({
      region: "auto",
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    }) as unknown as Send;
    return client;
  };
  const expiry = (seconds: number) => new Date(now() + seconds * 1000).toISOString();

  return {
    available: () => true,
    async createUploadUrl(input) {
      const url = await presign(
        getClient(),
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: stagingObjectKey(config.environment, input.storage_key),
          ContentType: input.mime_type,
          ContentLength: input.size_bytes,
        }),
        {
          expiresIn: DOCUMENT_UPLOAD_URL_TTL_SECONDS,
          signableHeaders: new Set(["content-type", "content-length"]),
        },
      );
      return {
        url,
        expires_at: expiry(DOCUMENT_UPLOAD_URL_TTL_SECONDS),
        headers: { "Content-Type": input.mime_type },
      };
    },
    async headStaged(storageKey) {
      try {
        const head = await getClient().send(new HeadObjectCommand({
          Bucket: config.bucket,
          Key: stagingObjectKey(config.environment, storageKey),
        })) as { ContentLength?: number; ContentType?: string };
        if (typeof head.ContentLength !== "number" || !Number.isSafeInteger(head.ContentLength)) {
          throw new Error("DOCUMENT_STORAGE_UNAVAILABLE");
        }
        return {
          kind: "found",
          size_bytes: head.ContentLength,
          content_type: typeof head.ContentType === "string" ? head.ContentType : null,
        };
      } catch (error) {
        if (isNotFound(error)) return { kind: "missing" };
        throw error;
      }
    },
    async readStaged(storageKey) {
      try {
        const result = await getClient().send(new GetObjectCommand({
          Bucket: config.bucket,
          Key: stagingObjectKey(config.environment, storageKey),
        })) as {
          ContentLength?: number;
          Body?: { transformToByteArray(): Promise<Uint8Array> };
        };
        if (!result.Body || typeof result.ContentLength !== "number" ||
            result.ContentLength > DOCUMENT_MAX_UPLOAD_BYTES) {
          throw new Error("DOCUMENT_STORAGE_UNAVAILABLE");
        }
        const bytes = await result.Body.transformToByteArray();
        if (bytes.byteLength > DOCUMENT_MAX_UPLOAD_BYTES) {
          throw new Error("DOCUMENT_STORAGE_UNAVAILABLE");
        }
        return bytes;
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async promote(input) {
      const source = stagingObjectKey(config.environment, input.storage_key);
      await getClient().send(new CopyObjectCommand({
        Bucket: config.bucket,
        Key: finalObjectKey(config.environment, input.storage_key),
        CopySource: `${config.bucket}/${source}`,
        ContentType: input.mime_type,
        ContentDisposition: "attachment",
        MetadataDirective: "REPLACE",
      }));
    },
    async deleteStaged(storageKey) {
      await getClient().send(new DeleteObjectCommand({
        Bucket: config.bucket,
        Key: stagingObjectKey(config.environment, storageKey),
      }));
    },
    async createDownloadUrl(input) {
      const fileName = genericDownloadName(input.document_type, input.version, input.mime_type);
      const url = await presign(
        getClient(),
        new GetObjectCommand({
          Bucket: config.bucket,
          Key: finalObjectKey(config.environment, input.storage_key),
          ResponseContentType: input.mime_type,
          ResponseContentDisposition: attachmentDisposition(fileName),
        }),
        { expiresIn: DOCUMENT_DOWNLOAD_URL_TTL_SECONDS },
      );
      return { url, expires_at: expiry(DOCUMENT_DOWNLOAD_URL_TTL_SECONDS), headers: {} };
    },
  };
}
