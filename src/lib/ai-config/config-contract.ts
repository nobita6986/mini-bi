import "server-only";

import {
  encryptSecret,
  fingerprintSecret,
  type Keyring,
  type SecretEnvelope,
} from "./crypto-envelope.ts";
import { SecurityError } from "./errors.ts";
import {
  validateProviderUrl,
  type UrlPolicyOptions,
} from "./provider-url-policy.ts";

export const CONFIG_STATUSES = [
  "draft",
  "test_failed",
  "verified",
  "active",
  "disabled",
  "rotation_required",
] as const;

export type ConfigStatus = typeof CONFIG_STATUSES[number];

export type ProviderConfig = {
  config_id: string;
  provider_profile: string;
  api_base_url: string;
  model: string;
  encrypted_secret: SecretEnvelope;
  version: number;
  status: ConfigStatus;
  verified_at: string | null;
  updated_at: string;
  sanitized_host: string;
  key_fingerprint: string;
  optimistic_version: number;
};

export type ConfigReadProjection = Omit<ProviderConfig, "api_base_url" | "encrypted_secret">;

export type ConfigAudit = {
  actor: string;
  action: string;
  version: number;
  provider_profile: string;
  model: string;
  sanitized_host: string;
  key_fingerprint: string;
  outcome: "success" | "failure";
  timestamp: string;
  reason_code: string;
};

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const FINGERPRINT = /^[a-f0-9]{16}$/;

function isSanitizedHost(value: string): boolean {
  try {
    const url = new URL(`https://${value}`);
    return url.host === value &&
      url.pathname === "/" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "";
  } catch {
    return false;
  }
}

export function assertValidConfig(configValue: unknown): asserts configValue is ProviderConfig {
  if (!configValue || typeof configValue !== "object") {
    throw new SecurityError("INVALID_INPUT");
  }
  const config = configValue as ProviderConfig;
  const envelope = config.encrypted_secret;
  let validBaseUrl = false;
  try {
    const url = new URL(config.api_base_url);
    validBaseUrl =
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.username === "" &&
      url.password === "" &&
      !url.href.includes("?") &&
      !url.href.includes("#") &&
      url.host === config.sanitized_host;
  } catch {
    validBaseUrl = false;
  }
  if (
    !SAFE_ID.test(config.config_id) ||
    !SAFE_ID.test(config.provider_profile) ||
    typeof config.api_base_url !== "string" || !validBaseUrl ||
    typeof config.model !== "string" ||
    config.model.length === 0 ||
    config.model.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(config.model) ||
    !Number.isSafeInteger(config.version) ||
    config.version < 1 ||
    config.optimistic_version !== config.version ||
    !CONFIG_STATUSES.includes(config.status) ||
    !(config.verified_at === null || validTimestamp(config.verified_at)) ||
    !validTimestamp(config.updated_at) ||
    typeof config.sanitized_host !== "string" ||
    !isSanitizedHost(config.sanitized_host) ||
    !FINGERPRINT.test(config.key_fingerprint) ||
    !envelope ||
    envelope.envelope_version !== 1 ||
    envelope.algorithm !== "aes-256-gcm" ||
    !SAFE_ID.test(envelope.key_id) ||
    typeof envelope.iv !== "string" ||
    typeof envelope.ciphertext !== "string" ||
    typeof envelope.authentication_tag !== "string" ||
    !validTimestamp(envelope.created_at) ||
    envelope.config_id !== config.config_id ||
    envelope.provider_profile !== config.provider_profile ||
    envelope.config_version !== config.version
  ) {
    throw new SecurityError("INVALID_INPUT");
  }
}

function validTimestamp(value: string): boolean {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

export function createConfigCommand(input: {
  config_id: string;
  provider_profile: string;
  api_base_url: string;
  model: string;
  secret: string;
  keyring: Keyring;
  url_policy: UrlPolicyOptions;
  now?: Date;
}): ProviderConfig {
  if (
    typeof input.config_id !== "string" ||
    typeof input.provider_profile !== "string" ||
    typeof input.model !== "string" ||
    typeof input.secret !== "string"
  ) {
    throw new SecurityError("INVALID_INPUT");
  }
  const now = input.now ?? new Date();
  const model = input.model.trim();
  if (
    input.secret.length === 0 ||
    [input.config_id, input.provider_profile, model].some((value) => value.includes(input.secret))
  ) {
    throw new SecurityError("INVALID_INPUT");
  }
  const validatedUrl = validateProviderUrl(input.api_base_url, input.url_policy);
  const context = {
    config_id: input.config_id,
    provider_profile: input.provider_profile,
    config_version: 1,
  };
  const config: ProviderConfig = {
    config_id: input.config_id,
    provider_profile: input.provider_profile,
    api_base_url: validatedUrl.url.href,
    model,
    encrypted_secret: encryptSecret(input.secret, context, input.keyring, now),
    version: 1,
    status: "draft",
    verified_at: null,
    updated_at: now.toISOString(),
    sanitized_host: validatedUrl.sanitizedHost,
    key_fingerprint: fingerprintSecret(input.secret, input.keyring),
    optimistic_version: 1,
  };
  assertValidConfig(config);
  return config;
}

export function rotateConfigCommand(
  previous: ProviderConfig,
  secret: string,
  keyring: Keyring,
  now = new Date(),
): ProviderConfig {
  assertValidConfig(previous);
  const version = previous.version + 1;
  const next: ProviderConfig = {
    ...previous,
    encrypted_secret: encryptSecret(secret, {
      config_id: previous.config_id,
      provider_profile: previous.provider_profile,
      config_version: version,
    }, keyring, now),
    version,
    status: "draft",
    verified_at: null,
    updated_at: now.toISOString(),
    key_fingerprint: fingerprintSecret(secret, keyring),
    optimistic_version: version,
  };
  assertValidConfig(next);
  return next;
}

export function configNeedsKeyRotation(config: ProviderConfig, activeKeyId: string): boolean {
  assertValidConfig(config);
  return config.encrypted_secret.key_id !== activeKeyId;
}

export function projectConfig(config: ProviderConfig): ConfigReadProjection {
  assertValidConfig(config);
  return {
    config_id: config.config_id,
    provider_profile: config.provider_profile,
    model: config.model,
    version: config.version,
    status: config.status,
    verified_at: config.verified_at,
    updated_at: config.updated_at,
    sanitized_host: config.sanitized_host,
    key_fingerprint: config.key_fingerprint,
    optimistic_version: config.optimistic_version,
  };
}

export function applyVerificationResult(
  configs: readonly ProviderConfig[],
  configId: string,
  version: number,
  success: boolean,
  now = new Date(),
): ProviderConfig[] {
  const target = configs.find((config) => config.config_id === configId && config.version === version);
  if (!target) throw new SecurityError("INVALID_INPUT");
  if (target.status === "active") return [...configs];
  const status: ConfigStatus = success ? "verified" : "test_failed";
  return configs.map<ProviderConfig>((config) => {
    if (config !== target) return config;
    return {
      ...config,
      status,
      verified_at: success ? now.toISOString() : null,
      updated_at: now.toISOString(),
    };
  });
}

export function activateConfig(
  configs: readonly ProviderConfig[],
  configId: string,
  version: number,
  now = new Date(),
): ProviderConfig[] {
  const target = configs.find((config) => config.config_id === configId && config.version === version);
  if (!target || target.status !== "verified" || !target.verified_at) {
    throw new SecurityError("INVALID_INPUT");
  }
  return configs.map<ProviderConfig>((config) => {
    if (config === target) return { ...config, status: "active", updated_at: now.toISOString() };
    if (config.status === "active") return { ...config, status: "disabled", updated_at: now.toISOString() };
    return config;
  });
}

export function disableConfig(
  configs: readonly ProviderConfig[],
  configId: string,
  version: number,
  now = new Date(),
): ProviderConfig[] {
  let found = false;
  const result = configs.map<ProviderConfig>((config) => {
    if (config.config_id !== configId || config.version !== version) return config;
    found = true;
    return { ...config, status: "disabled", updated_at: now.toISOString() };
  });
  if (!found) throw new SecurityError("INVALID_INPUT");
  return result;
}

export function makeConfigAudit(input: ConfigAudit): ConfigAudit {
  const safe = {
    actor: input.actor,
    action: input.action,
    version: input.version,
    provider_profile: input.provider_profile,
    model: input.model,
    sanitized_host: input.sanitized_host,
    key_fingerprint: input.key_fingerprint,
    outcome: input.outcome,
    timestamp: input.timestamp,
    reason_code: input.reason_code,
  };
  if (
    Object.values(safe).some((value) => typeof value !== "string" && typeof value !== "number") ||
    !SAFE_ID.test(safe.actor) ||
    !SAFE_ID.test(safe.action) ||
    !SAFE_ID.test(safe.provider_profile) ||
    typeof safe.model !== "string" ||
    safe.model.length === 0 ||
    safe.model.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(safe.model) ||
    !isSanitizedHost(safe.sanitized_host) ||
    !Number.isSafeInteger(safe.version) ||
    !FINGERPRINT.test(safe.key_fingerprint) ||
    !validTimestamp(safe.timestamp) ||
    !SAFE_ID.test(safe.reason_code) ||
    (safe.outcome !== "success" && safe.outcome !== "failure")
  ) {
    throw new SecurityError("INVALID_INPUT");
  }
  return safe;
}
