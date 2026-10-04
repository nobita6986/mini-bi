import {
  validateClientBusinessPayload,
} from "../auth/direct-entry-v2.ts";
import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core.ts";
import { checkSameOriginRequest } from "../ai/gateway/http-guards.mjs";
import { projectEntry } from "./write-api.ts";
import {
  projectAccountMetadataInput,
  projectPaymentInput,
  type AccountMetadataInput,
  type PaymentInput,
} from "./payment-contract.ts";
import type { DirectEntryRepository } from "./write-repository.ts";
import { readBoundedJson } from "./write-api.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMON_BODY_KEYS = [
  "expected_entry_version",
  "expected_payment_version",
  "reason",
] as const;

type Dependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  repository: DirectEntryRepository;
};

type ProjectedRequestBase = {
  expected_entry_version: number;
  expected_payment_version: number;
  reason: string;
};

type ProjectedRequest = ProjectedRequestBase & (
  | { payment: PaymentInput; usesAccountMetadata: false }
  | { payment: AccountMetadataInput; usesAccountMetadata: true }
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function respond(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function fail(code: string, status: number): Response {
  return respond({ ok: false, code }, status);
}

function projectRequest(value: unknown) {
  if (!isRecord(value) ||
      typeof value.expected_entry_version !== "number" ||
      !Number.isSafeInteger(value.expected_entry_version) || value.expected_entry_version < 1 ||
      typeof value.expected_payment_version !== "number" ||
      !Number.isSafeInteger(value.expected_payment_version) || value.expected_payment_version < 0 ||
      typeof value.reason !== "string" || value.reason.trim().length < 1 ||
      value.reason.length > 4000) return null;
  const common = [
    ...COMMON_BODY_KEYS,
  ];
  if (Object.keys(value).length === common.length + 1 &&
      common.every((key) => key in value) && "payment" in value) {
    const payment = projectPaymentInput(value.payment);
    if (!payment) return null;
    return {
      expected_entry_version: value.expected_entry_version,
      expected_payment_version: value.expected_payment_version,
      payment,
      usesAccountMetadata: false,
      reason: value.reason,
    } satisfies ProjectedRequest;
  }
  if (Object.keys(value).length === common.length + 1 &&
      common.every((key) => key in value) && "account_metadata" in value) {
    const accountMetadata = projectAccountMetadataInput(value.account_metadata);
    if (!accountMetadata) return null;
    return {
      expected_entry_version: value.expected_entry_version,
      expected_payment_version: value.expected_payment_version,
      payment: accountMetadata,
      usesAccountMetadata: true,
      reason: value.reason,
    } satisfies ProjectedRequest;
  }
  return null;
}

export async function patchDraftPayment(
  request: Request,
  entryId: string,
  flag: string | undefined,
  dependencies: Dependencies,
): Promise<Response> {
  if (flag !== "true") return fail("NOT_FOUND", 404);
  if (!UUID.test(entryId)) return fail("ENTRY_ID_INVALID", 400);

  const origin = checkSameOriginRequest({
    origin: request.headers.get("origin"),
    host: request.headers.get("host"),
    secFetchSite: request.headers.get("sec-fetch-site"),
  });
  if (!origin.ok) return fail("CSRF_REJECTED", 403);
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !==
      "application/json") return fail("CONTENT_TYPE_INVALID", 400);
  const idempotencyKey = request.headers.get("idempotency-key");
  if (idempotencyKey === null || idempotencyKey.trim() === "" ||
      idempotencyKey.length > 128) return fail("IDEMPOTENCY_KEY_INVALID", 400);

  const body = await readBoundedJson(request);
  if (body === null) return fail("BODY_INVALID", 400);
  let parsed: ReturnType<typeof projectRequest>;
  try {
    if (!validateClientBusinessPayload(body).ok) {
      return fail("CLIENT_AUTHORITY_FIELD_FORBIDDEN", 400);
    }
    parsed = projectRequest(body);
  } catch {
    return fail("PAYMENT_INVALID", 400);
  }
  if (!parsed) return fail("PAYMENT_INVALID", 400);

  try {
    const session = await dependencies.resolveSession();
    if (!session.actor.ok) {
      return session.actor.reason === "UNAUTHENTICATED"
        ? fail("UNAUTHENTICATED", 401)
        : fail("ACTOR_NOT_AVAILABLE", 403);
    }
    const actor = session.actor.actor;
    const trustedActor = {
      auth_subject: actor.auth_subject,
      app_user_id: actor.app_user_id,
    };

    const readResult = await dependencies.repository.readEntry({
      ...trustedActor,
      entry_id: entryId,
    });
    if (!readResult.ok) {
      if (readResult.kind === "denied" || readResult.kind === "not-found") {
        return fail("ENTRY_NOT_FOUND", 404);
      }
      console.error("[direct-entry] payment entry projection unavailable");
      return fail("PAYMENT_UNAVAILABLE", 500);
    }
    const entry = projectEntry(readResult.data);
    if (!entry || entry.entry_id !== entryId ||
        typeof entry.first_work_date !== "string" ||
        typeof entry.version !== "number") {
      console.error("[direct-entry] payment entry projection malformed");
      return fail("PAYMENT_UNAVAILABLE", 500);
    }

    if (!parsed.usesAccountMetadata && parsed.payment.state === "provided") {
      const catalog = await dependencies.repository.loadInputCatalog({
        ...trustedActor,
        effective_date: entry.first_work_date,
      });
      if (!catalog.ok) {
        if (catalog.kind === "denied") return fail("PAYMENT_DENIED", 403);
        console.error("[direct-entry] payment bank catalog unavailable");
        return fail("PAYMENT_UNAVAILABLE", 500);
      }
      const activeBankIds = new Set(catalog.data.banks.map(({ bank_id }) => bank_id));
      if (!projectPaymentInput(parsed.payment, activeBankIds)) {
        return fail("BANK_INVALID", 400);
      }
    }

    const result = await dependencies.repository.updatePayment({
      ...trustedActor,
      entry_id: entryId,
      expected_entry_version: parsed.expected_entry_version,
      expected_payment_version: parsed.expected_payment_version,
      payment: parsed.payment,
      reason: parsed.reason,
      idempotency_key: idempotencyKey,
    });
    if (!result.ok) {
      if (result.kind === "conflict") return fail("PAYMENT_CONFLICT", 409);
      if (result.kind === "denied") return fail("PAYMENT_DENIED", 403);
      if (result.kind === "not-found") return fail("ENTRY_NOT_FOUND", 404);
      if (result.kind === "invalid") return fail("PAYMENT_INVALID", 400);
      console.error("[direct-entry] payment update unavailable");
      return fail("PAYMENT_UNAVAILABLE", 500);
    }
    return respond({
      ok: true,
      entry_id: result.data.entry_id,
      entry_version: result.data.entry_version,
      payment_version: result.data.payment_version,
    }, 200);
  } catch {
    console.error("[direct-entry] payment update request failed");
    return fail("PAYMENT_UNAVAILABLE", 500);
  }
}
