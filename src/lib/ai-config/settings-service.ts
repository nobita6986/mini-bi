import "server-only";

/**
 * P1.5-W04A — Settings service (thuần, DI) cho cấu hình provider: save · test · rotate · activate · disable.
 *
 * Nguyên tắc:
 * - Secret CHỈ tồn tại trong bộ nhớ server; store chỉ nhận envelope đã mã hoá; projection không có envelope.
 * - Mọi mutation kiểm tra optimistic version (không ghi đè âm thầm) và ghi audit CÙNG transaction ở tầng store.
 * - Test connection dùng safe-outbound (HTTPS-only, allowlist, DNS pinning, redirect same-origin, trần byte).
 * - Test CHỈ chạy khi có yêu cầu tường minh của Owner; không tự chạy khi render/mở panel.
 */

import {
  createConfigCommand,
  projectConfig,
  rotateConfigCommand,
  type ConfigReadProjection,
  type ProviderConfig,
} from "./config-contract.ts";
import {
  decryptSecret,
  normalizeModel,
  type Keyring,
} from "./crypto-envelope.ts";
import { SecurityError, type SecurityErrorCode } from "./errors.ts";
import {
  buildConnectionProbe,
  DEFAULT_PROVIDER_PROFILE_ID,
  isKnownProviderProfile,
} from "./provider-profiles.ts";
import { safeOutboundRequest, type PinnedResponse } from "./safe-outbound.ts";
import type { UrlPolicyOptions } from "./provider-url-policy.ts";
import type { ActiveConfigProjection, ConfigStore } from "./store-core.ts";

/** Một cấu hình pilot duy nhất (nhiều version). P3 sẽ tách theo tổ chức/RBAC. */
export const PILOT_CONFIG_ID = "pilot-provider";
export const MAX_SECRET_LENGTH = 16_384;
export const MAX_URL_LENGTH = 2_048;
export const MAX_MODEL_LENGTH = 256;
export const TEST_TIMEOUT_MS = 5_000;
export const TEST_MAX_RESPONSE_BYTES = 64 * 1024;

export type SettingsStatusResult =
  | { ok: true; config: ConfigReadProjection | null; active: ActiveConfigProjection | null }
  | StoreFail;

export type SettingsMutationResult = { ok: true; config: ConfigReadProjection } | StoreFail;

export type SettingsTestResult =
  | { ok: true; verified: boolean; reason_code: string; config: ConfigReadProjection }
  | StoreFail;

/** Hợp đồng service mà route/panel dùng (để .mjs wiring có kiểu tường minh). */
export type SettingsService = {
  status(): Promise<SettingsStatusResult>;
  save(body: unknown): Promise<SettingsMutationResult>;
  rotate(body: unknown): Promise<SettingsMutationResult>;
  test(body: unknown): Promise<SettingsTestResult>;
  activate(body: unknown): Promise<SettingsMutationResult>;
  disable(body: unknown): Promise<SettingsMutationResult>;
};

export type StoreFail = { ok: false; code: string; message: string };
export type StoreResult = { ok: true; config: ProviderConfig } | StoreFail;

export type { ActiveConfigProjection, ConfigStore, StoreRead } from "./store-core.ts";

export type OutboundSeam = {
  resolve?: (hostname: string) => Promise<readonly string[]>;
  request?: (input: {
    url: URL;
    addresses: readonly string[];
    method: "GET" | "POST";
    headers: Readonly<Record<string, string>>;
    body?: Buffer | string;
    timeoutMs: number;
    maxResponseBytes: number;
    signal: AbortSignal;
  }) => Promise<PinnedResponse>;
};

function fail(code: SecurityErrorCode): StoreFail {
  return { ok: false, code, message: new SecurityError(code).message };
}

/**
 * R2 (B4) — Projection an toàn: validator throw (config không hợp lệ) ⇒ sanitized AI_INTERNAL,
 * KHÔNG để exception thoát ra route và KHÔNG trả config giả.
 */
function safeProjectConfig(config: ProviderConfig): { ok: true; config: ConfigReadProjection } | StoreFail {
  try {
    return { ok: true, config: projectConfig(config) };
  } catch {
    /**
     * R3 (B) — Config đọc từ store bị malformed ⇒ lỗi HẠ TẦNG, KHÔNG phải "thiếu cấu hình":
     * dùng AI_INTERNAL (mã CONFIGURATION bị API ánh xạ thành AI_CONFIG_REQUIRED) và thông điệp CỐ ĐỊNH,
     * đã sanitize — không raw error, không URL, không envelope, không secret.
     */
    return { ok: false, code: "AI_INTERNAL", message: "cấu hình provider đọc được không hợp lệ" };
  }
}

function isControlFreeString(value: string): boolean {
  return !/[\u0000-\u001f\u007f]/.test(value);
}

/** Validate body từ client — KHÔNG nhận header, KHÔNG nhận config_id tùy ý. */
export function validateSaveInput(body: unknown): {
  ok: true;
  value: { provider_profile: string; api_url: string; model: string; api_key: string; expected_version: number | null };
} | { ok: false; code: "INVALID_INPUT"; message: string } {
  const invalid = { ok: false as const, code: "INVALID_INPUT" as const, message: new SecurityError("INVALID_INPUT").message };
  if (!body || typeof body !== "object" || Array.isArray(body)) return invalid;
  const record = body as Record<string, unknown>;
  const providerProfile = record.provider_profile === undefined || record.provider_profile === null
    ? DEFAULT_PROVIDER_PROFILE_ID
    : record.provider_profile;
  const { api_url: apiUrl, model, api_key: apiKey } = record;
  if (!isKnownProviderProfile(providerProfile)) return invalid;
  if (typeof apiUrl !== "string" || apiUrl.length === 0 || apiUrl.length > MAX_URL_LENGTH) return invalid;
  if (typeof model !== "string") return invalid;
  const normalizedModel = normalizeModel(model);
  if (normalizedModel.length === 0 || normalizedModel.length > MAX_MODEL_LENGTH || !isControlFreeString(normalizedModel)) return invalid;
  if (typeof apiKey !== "string" || apiKey.length === 0 || apiKey.length > MAX_SECRET_LENGTH) return invalid;
  if (!isControlFreeString(apiKey)) return invalid;
  if (apiUrl.includes(apiKey) || normalizedModel.includes(apiKey) || String(providerProfile).includes(apiKey)) return invalid;
  const expected = record.expected_version;
  if (expected !== undefined && expected !== null && (!Number.isSafeInteger(expected) || (expected as number) < 1)) return invalid;
  return {
    ok: true,
    value: {
      provider_profile: providerProfile as string,
      api_url: apiUrl,
      model: normalizedModel,
      api_key: apiKey,
      expected_version: (expected ?? null) as number | null,
    },
  };
}

/**
 * Trạng thái sanitized cho panel (KHÔNG có envelope/URL đầy đủ).
 * R1 (C): lỗi đọc (DB/transport/malformed) ⇒ trả lỗi sanitized, KHÔNG trả config:null giả.
 */
export async function readSettingsStatus(input: {
  store: ConfigStore;
  config_id?: string;
}): Promise<SettingsStatusResult> {
  const [current, active] = await Promise.all([
    input.store.readCurrent(input.config_id ?? PILOT_CONFIG_ID),
    input.store.readActiveProjection(),
  ]);
  if (!current.ok) return current;
  if (!active.ok) return active;
  let projection: ConfigReadProjection | null = null;
  if (current.config) {
    const projected = safeProjectConfig(current.config);
    if (!projected.ok) return projected;
    projection = projected.config;
  }
  return {
    ok: true,
    config: projection,
    active: active.config,
  };
}

/**
 * R2 (C) — Từ chối do optimistic conflict CHỈ được tuyên bố sau khi audit
 * `config_mutation_rejected` đã persist THÀNH CÔNG. Audit lỗi ⇒ AI_INTERNAL (không conflict giả,
 * cũng không success giả) và KHÔNG mutation nào được thực hiện.
 */
async function rejectConflict(
  store: ConfigStore,
  input: { config_id: string; version: number; actor: string }
): Promise<StoreFail> {
  const audited = await store.recordRejected({
    config_id: input.config_id,
    version: input.version,
    actor: input.actor,
    reason_code: "version_conflict",
  });
  if (!audited || audited.ok !== true) {
    return { ok: false, code: "AI_INTERNAL", message: "không ghi được audit từ chối (DB/RPC lỗi)" };
  }
  return fail("VERSION_CONFLICT");
}

export async function saveProviderConfig(input: {
  store: ConfigStore;
  keyring: Keyring;
  url_policy: UrlPolicyOptions;
  actor: string;
  body: unknown;
  now?: Date;
}): Promise<{ ok: true; config: ConfigReadProjection } | StoreFail> {
  const parsed = validateSaveInput(input.body);
  if (!parsed.ok) return fail("INVALID_INPUT");
  const now = input.now ?? new Date();
  const read = await input.store.readCurrent(PILOT_CONFIG_ID);
  if (!read.ok) return read;
  const current = read.config;
  if (current && parsed.value.expected_version !== current.version) {
    return rejectConflict(input.store, {
      config_id: current.config_id,
      version: current.version,
      actor: input.actor,
    });
  }
  if (!current && parsed.value.expected_version !== null) {
    return rejectConflict(input.store, {
      config_id: PILOT_CONFIG_ID,
      version: parsed.value.expected_version,
      actor: input.actor,
    });
  }

  let config: ProviderConfig;
  try {
    config = createConfigCommand({
      config_id: PILOT_CONFIG_ID,
      provider_profile: parsed.value.provider_profile,
      api_base_url: parsed.value.api_url,
      model: parsed.value.model,
      secret: parsed.value.api_key,
      keyring: input.keyring,
      url_policy: input.url_policy,
      now,
      version: (current?.version ?? 0) + 1,
    });
  } catch (error) {
    return fail(error instanceof SecurityError ? error.code : "INVALID_INPUT");
  }

  const saved = await input.store.saveVersion({
    expected_version: current?.version ?? null,
    config,
    actor: input.actor,
    action: "config_created",
  });
  if (!saved.ok) return saved;
  // R2 (B4): projection an toàn — validator throw ⇒ AI_INTERNAL, không trả config giả.
  return safeProjectConfig(saved.config);
}

export async function rotateProviderKey(input: {
  store: ConfigStore;
  keyring: Keyring;
  actor: string;
  body: unknown;
  now?: Date;
}): Promise<{ ok: true; config: ConfigReadProjection } | StoreFail> {
  const record = (input.body ?? {}) as Record<string, unknown>;
  const apiKey = record.api_key;
  const expected = record.expected_version;
  if (typeof apiKey !== "string" || apiKey.length === 0 || apiKey.length > MAX_SECRET_LENGTH || !isControlFreeString(apiKey)) {
    return fail("INVALID_INPUT");
  }
  /**
   * R1 (D) — Rotate BẮT BUỘC `expected_version` là integer >= 1 (optimistic concurrency):
   * thiếu hoặc sai kiểu ⇒ AI_INPUT_INVALID; DB RPC vẫn là authority cuối cùng.
   */
  if (!Number.isSafeInteger(expected) || (expected as number) < 1) return fail("INVALID_INPUT");
  const read = await input.store.readCurrent(PILOT_CONFIG_ID);
  if (!read.ok) return read;
  const current = read.config;
  if (!current) return fail("NOT_FOUND");
  if (expected !== current.version) {
    return rejectConflict(input.store, {
      config_id: current.config_id,
      version: current.version,
      actor: input.actor,
    });
  }

  let next: ProviderConfig;
  try {
    // KHÔNG giải mã key cũ: chỉ dùng metadata (URL/model/profile) + secret MỚI.
    next = rotateConfigCommand(current, apiKey, input.keyring, input.now ?? new Date());
  } catch (error) {
    /**
     * R3 (B) — Input đã được validate TRƯỚC đó, nên lỗi ở đây nghĩa là config ĐỌC TỪ STORE bị malformed
     * ⇒ lỗi hạ tầng AI_INTERNAL (không phải input error, không phải "thiếu cấu hình").
     */
    if (error instanceof SecurityError && error.code === "INVALID_INPUT") {
      return { ok: false, code: "AI_INTERNAL", message: "cấu hình provider đọc được không hợp lệ" };
    }
    return fail(error instanceof SecurityError ? error.code : "INVALID_INPUT");
  }
  const saved = await input.store.saveVersion({
    expected_version: current.version,
    config: next,
    actor: input.actor,
    action: "credential_rotated",
  });
  if (!saved.ok) return saved;
  // R2 (B4): projection an toàn — validator throw ⇒ AI_INTERNAL, không trả config giả.
  return safeProjectConfig(saved.config);
}

function reasonCodeFor(error: unknown): string {
  if (error instanceof SecurityError) {
    return String(error.code).toLowerCase();
  }
  return "outbound_failed";
}

/**
 * Test connection: CHỈ khi được gọi tường minh. Dùng outbound guard, không log/!trả raw response.
 * Trả verified=false (đã ghi test_failed) khi provider trả lỗi; chỉ lỗi KHÔNG chạy được mới là ok:false.
 */
export async function testProviderConnection(input: {
  store: ConfigStore;
  keyring: Keyring;
  url_policy: UrlPolicyOptions;
  actor: string;
  body: unknown;
  now?: Date;
  outbound?: OutboundSeam;
}): Promise<
  | { ok: true; verified: boolean; reason_code: string; config: ConfigReadProjection }
  | StoreFail
> {
  const record = (input.body ?? {}) as Record<string, unknown>;
  const version = record.version;
  if (version !== undefined && version !== null && (!Number.isSafeInteger(version) || (version as number) < 1)) {
    return fail("INVALID_INPUT");
  }
  const readCurrent = await input.store.readCurrent(PILOT_CONFIG_ID);
  if (!readCurrent.ok) return readCurrent;
  if (!readCurrent.config) return fail("NOT_FOUND");
  const current = readCurrent.config;
  let target = current;
  if (version !== undefined && version !== null) {
    const readVersion = await input.store.readVersion(PILOT_CONFIG_ID, version as number);
    if (!readVersion.ok) return readVersion;
    if (!readVersion.config) return fail("NOT_FOUND");
    target = readVersion.config;
  }

  let secret: string;
  let probe: { url: string; method: "POST"; headers: Record<string, string>; body: string };
  try {
    secret = decryptSecret(target.encrypted_secret, {
      config_id: target.config_id,
      provider_profile: target.provider_profile,
      config_version: target.version,
      api_base_url: target.api_base_url,
      model: target.model,
    }, input.keyring);
    probe = buildConnectionProbe({
      api_base_url: target.api_base_url,
      model: target.model,
      secret,
      provider_profile: target.provider_profile,
    });
  } catch (error) {
    // Không giải mã được ⇒ fail-closed, KHÔNG gọi provider (không ghi verified).
    const code = reasonCodeFor(error);
    await input.store.recordTest({
      config_id: target.config_id,
      version: target.version,
      success: false,
      actor: input.actor,
      reason_code: code,
    });
    return fail(error instanceof SecurityError ? error.code : "DECRYPT_FAILED");
  }

  let verified = false;
  let reasonCode = "provider_error";
  try {
    const response = await safeOutboundRequest(probe.url, {
      url_policy: input.url_policy,
      method: probe.method,
      headers: probe.headers,
      body: probe.body,
      timeoutMs: TEST_TIMEOUT_MS,
      maxResponseBytes: TEST_MAX_RESPONSE_BYTES,
      maxRequestBytes: 256 * 1024,
      maxRedirects: 0,
      resolve: input.outbound?.resolve,
      request: input.outbound?.request,
    });
    verified = response.statusCode >= 200 && response.statusCode < 300;
    reasonCode = verified ? "provider_ok" : "provider_status";
  } catch (error) {
    reasonCode = reasonCodeFor(error);
  }

  const recorded = await input.store.recordTest({
    config_id: target.config_id,
    version: target.version,
    success: verified,
    actor: input.actor,
    reason_code: reasonCode,
  });
  if (!recorded.ok) return recorded;
  const projected = safeProjectConfig(recorded.config);
  if (!projected.ok) return projected;
  return {
    ok: true,
    verified,
    reason_code: reasonCode,
    config: projected.config,
  };
}

export async function activateProviderConfig(input: {
  store: ConfigStore;
  actor: string;
  body: unknown;
}): Promise<{ ok: true; config: ConfigReadProjection } | StoreFail> {
  const record = (input.body ?? {}) as Record<string, unknown>;
  const version = record.version;
  if (!Number.isSafeInteger(version) || (version as number) < 1) return fail("INVALID_INPUT");
  const read = await input.store.readVersion(PILOT_CONFIG_ID, version as number);
  if (!read.ok) return read;
  const target = read.config;
  if (!target) return fail("NOT_FOUND");
  if (target.status !== "verified" || !target.verified_at) return fail("NOT_VERIFIED");
  const activated = await input.store.activate({
    config_id: target.config_id,
    version: target.version,
    actor: input.actor,
  });
  if (!activated.ok) return activated;
  return safeProjectConfig(activated.config);
}

export async function disableProviderConfig(input: {
  store: ConfigStore;
  actor: string;
  body: unknown;
}): Promise<{ ok: true; config: ConfigReadProjection } | StoreFail> {
  const record = (input.body ?? {}) as Record<string, unknown>;
  const version = record.version;
  if (!Number.isSafeInteger(version) || (version as number) < 1) return fail("INVALID_INPUT");
  const read = await input.store.readVersion(PILOT_CONFIG_ID, version as number);
  if (!read.ok) return read;
  const target = read.config;
  if (!target) return fail("NOT_FOUND");
  const disabled = await input.store.disable({
    config_id: target.config_id,
    version: target.version,
    actor: input.actor,
  });
  if (!disabled.ok) return disabled;
  return safeProjectConfig(disabled.config);
}
