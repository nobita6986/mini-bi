import "server-only";

import {
  authenticateN8nBodRequest,
  N8N_BOD_READONLY_PRINCIPAL,
  type N8nAuthEnvInput,
} from "./auth.ts";
import { getN8nBodCatalog, N8N_BOD_CATALOG_VERSION } from "./catalog.ts";
import {
  dispatchN8nBodQuery,
  MAX_N8N_REQUEST_BODY_BYTES,
  type N8nDispatcherDependencies,
} from "./dispatcher.ts";

const COMMON_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store, no-cache, must-revalidate",
  "x-content-type-options": "nosniff",
});

function jsonResponse(
  status: number,
  payload: unknown,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...COMMON_HEADERS,
      ...(extraHeaders ?? {}),
    },
  });
}

export async function handleN8nBodCatalogGet(
  request: Request,
  options: {
    env?: N8nAuthEnvInput;
    now?: Date;
  } = {},
): Promise<Response> {
  const auth = authenticateN8nBodRequest(request, options.env);
  if (!auth.ok) {
    return jsonResponse(
      auth.status,
      {
        ok: false,
        catalog_version: N8N_BOD_CATALOG_VERSION,
        principal: N8N_BOD_READONLY_PRINCIPAL,
        error: {
          code: auth.code,
          message: auth.message,
        },
      },
      auth.status === 401
        ? { "www-authenticate": 'Bearer realm="n8n-bod-readonly"' }
        : undefined,
    );
  }

  const catalog = getN8nBodCatalog({ now: options.now });
  return jsonResponse(200, {
    ok: true,
    ...catalog,
  });
}

export async function handleN8nBodQueryPost(
  request: Request,
  options: {
    env?: N8nAuthEnvInput;
    dispatcherDeps?: N8nDispatcherDependencies;
  } = {},
): Promise<Response> {
  const auth = authenticateN8nBodRequest(request, options.env);
  if (!auth.ok) {
    return jsonResponse(
      auth.status,
      {
        ok: false,
        catalog_version: N8N_BOD_CATALOG_VERSION,
        principal: N8N_BOD_READONLY_PRINCIPAL,
        error: {
          code: auth.code,
          message: auth.message,
        },
      },
      auth.status === 401
        ? { "www-authenticate": 'Bearer realm="n8n-bod-readonly"' }
        : undefined,
    );
  }

  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader) {
    const contentLength = Number.parseInt(contentLengthHeader, 10);
    if (
      Number.isFinite(contentLength) &&
      contentLength > MAX_N8N_REQUEST_BODY_BYTES
    ) {
      return jsonResponse(413, {
        ok: false,
        catalog_version: N8N_BOD_CATALOG_VERSION,
        principal: N8N_BOD_READONLY_PRINCIPAL,
        error: {
          code: "PAYLOAD_TOO_LARGE",
          message: `Kích thước body truy vấn vượt quá giới hạn ${MAX_N8N_REQUEST_BODY_BYTES} bytes.`,
        },
      });
    }
  }

  let rawText: string;
  try {
    rawText = await request.text();
  } catch {
    return jsonResponse(400, {
      ok: false,
      catalog_version: N8N_BOD_CATALOG_VERSION,
      principal: N8N_BOD_READONLY_PRINCIPAL,
      error: {
        code: "INVALID_JSON_BODY",
        message: "Không thể đọc body của yêu cầu.",
      },
    });
  }

  if (Buffer.byteLength(rawText, "utf8") > MAX_N8N_REQUEST_BODY_BYTES) {
    return jsonResponse(413, {
      ok: false,
      catalog_version: N8N_BOD_CATALOG_VERSION,
      principal: N8N_BOD_READONLY_PRINCIPAL,
      error: {
        code: "PAYLOAD_TOO_LARGE",
        message: `Kích thước body truy vấn vượt quá giới hạn ${MAX_N8N_REQUEST_BODY_BYTES} bytes.`,
      },
    });
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawText);
  } catch {
    return jsonResponse(400, {
      ok: false,
      catalog_version: N8N_BOD_CATALOG_VERSION,
      principal: N8N_BOD_READONLY_PRINCIPAL,
      error: {
        code: "INVALID_JSON_BODY",
        message: "Body yêu cầu không phải JSON hợp lệ.",
      },
    });
  }

  const outcome = await dispatchN8nBodQuery(
    parsedBody,
    options.dispatcherDeps,
  );
  return jsonResponse(outcome.status, outcome.body);
}
