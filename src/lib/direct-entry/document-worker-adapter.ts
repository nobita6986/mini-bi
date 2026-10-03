import "server-only";

import { safeOutboundRequest } from "../ai-config/safe-outbound.ts";
import { validateProviderUrl } from "../ai-config/provider-url-policy.ts";
import type {
  DocumentStorageAdapter,
  DocumentUploadRequest,
} from "./document-storage-adapter.ts";

const WORKER_TIMEOUT_MS = 30_000;
const WORKER_REQUEST_MAX_BYTES = 15 * 1024 * 1024;
const WORKER_RESPONSE_MAX_BYTES = 4 * 1024;

type WorkerEnvironment = NodeJS.ProcessEnv;

type WorkerTransport = typeof safeOutboundRequest;

function configuration(env: WorkerEnvironment): {
  url: string;
  allowedHosts: string[];
  token: string;
} | null {
  const url = env.DIRECT_ENTRY_DOCUMENT_WORKER_URL;
  const token = env.DIRECT_ENTRY_DOCUMENT_WORKER_TOKEN;
  const allowedHosts = (env.DIRECT_ENTRY_DOCUMENT_WORKER_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);
  if (!url || !token || token.length < 16 || allowedHosts.length === 0) return null;
  try {
    validateProviderUrl(url, {
      environment: "production",
      allowedHosts,
      allowedPorts: [443],
    });
  } catch {
    return null;
  }
  return { url, allowedHosts, token };
}

function workerPayload(input: DocumentUploadRequest): string {
  return JSON.stringify({
    protocol_version: 1,
    document_id: input.document_id,
    document_version: input.version,
    document_type: input.document_type,
    attempt: input.attempt,
    event_sequence: input.event_sequence,
    storage_object_ref: input.storage_key,
    checksum_sha256: input.checksum_sha256,
    size_bytes: input.size_bytes,
    mime_type: input.mime_type,
    idempotency_key: input.idempotency_key,
    content_base64: Buffer.from(input.bytes).toString("base64"),
  });
}

export function createDocumentWorkerAdapter(
  env: WorkerEnvironment = process.env,
  transport: WorkerTransport = safeOutboundRequest,
): DocumentStorageAdapter {
  return {
    available() {
      return configuration(env) !== null;
    },
    async upload(input) {
      const config = configuration(env);
      if (!config) return { kind: "unavailable" };
      const body = workerPayload(input);
      try {
        const response = await transport(config.url, {
          url_policy: {
            environment: "production",
            allowedHosts: config.allowedHosts,
            allowedPorts: [443],
          },
          method: "POST",
          headers: {
            authorization: `Bearer ${config.token}`,
            "content-type": "application/json",
          },
          body,
          timeoutMs: WORKER_TIMEOUT_MS,
          maxRequestBytes: WORKER_REQUEST_MAX_BYTES,
          maxResponseBytes: WORKER_RESPONSE_MAX_BYTES,
          maxRedirects: 2,
        });
        if (response.statusCode !== 202) return { kind: "unavailable" };
        const accepted: unknown = JSON.parse(response.body.toString("utf8"));
        if (typeof accepted !== "object" || accepted === null || Array.isArray(accepted)) {
          return { kind: "unavailable" };
        }
        const ack = accepted as Record<string, unknown>;
        if (Object.keys(ack).length !== 2 || ack.accepted !== true ||
            typeof ack.job_id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(ack.job_id)) {
          return { kind: "unavailable" };
        }
        return {
          kind: "durable",
          document_id: input.document_id,
          version: input.version,
          storage_key: input.storage_key,
          object_version: ack.job_id,
          checksum_sha256: input.checksum_sha256,
        };
      } catch {
        return { kind: "unavailable" };
      }
    },
  };
}

export const documentWorkerLimits = {
  timeout_ms: WORKER_TIMEOUT_MS,
  max_request_bytes: WORKER_REQUEST_MAX_BYTES,
  max_response_bytes: WORKER_RESPONSE_MAX_BYTES,
} as const;
