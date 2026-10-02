import "server-only";

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";
import { SecurityError } from "./errors.ts";

export const ENVELOPE_VERSION = 2 as const;
export const ENVELOPE_ALGORITHM = "aes-256-gcm" as const;

export type SecretContext = {
  config_id: string;
  provider_profile: string;
  config_version: number;
  api_base_url: string;
  model: string;
};

export type SecretEnvelope = SecretContext & {
  envelope_version: 2;
  algorithm: "aes-256-gcm";
  key_id: string;
  iv: string;
  ciphertext: string;
  authentication_tag: string;
  created_at: string;
};

export type Keyring = {
  activeKeyId: string;
  keys: ReadonlyMap<string, Buffer>;
};

const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function validateKey(key: Buffer): boolean {
  return Buffer.isBuffer(key) && key.length === 32;
}

function parseMasterKey(value: string | undefined): Buffer {
  if (!value || !BASE64_PATTERN.test(value)) throw new SecurityError("CONFIGURATION");
  const key = Buffer.from(value, "base64");
  if (key.length !== 32 || key.toString("base64") !== value) {
    throw new SecurityError("CONFIGURATION");
  }
  return key;
}

export function keyringFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  previousKeys: ReadonlyMap<string, Buffer> = new Map(),
): Keyring {
  const activeKeyId = env.AI_CONFIG_ACTIVE_KEY_ID ?? "k1";
  if (!ID_PATTERN.test(activeKeyId)) throw new SecurityError("CONFIGURATION");
  const keys = new Map(previousKeys);
  keys.set(activeKeyId, parseMasterKey(env.AI_CONFIG_MASTER_KEY));
  if ([...keys.values()].some((key) => !validateKey(key))) {
    throw new SecurityError("CONFIGURATION");
  }
  return { activeKeyId, keys };
}

function requireKeyring(keyring: Keyring): Buffer {
  const key = keyring.keys.get(keyring.activeKeyId);
  if (!key || !validateKey(key)) throw new SecurityError("CONFIGURATION");
  return key;
}

function encodeAad(context: SecretContext): Buffer {
  let normalizedUrl: string;
  try {
    const url = new URL(context.api_base_url);
    normalizedUrl = url.href;
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw new Error();
    }
  } catch {
    throw new SecurityError("INVALID_INPUT");
  }
  if (
    typeof context.config_id !== "string" ||
    !ID_PATTERN.test(context.config_id) ||
    typeof context.provider_profile !== "string" ||
    !ID_PATTERN.test(context.provider_profile) ||
    !Number.isSafeInteger(context.config_version) ||
    context.config_version < 1 ||
    normalizedUrl !== context.api_base_url ||
    context.api_base_url.includes("?") ||
    context.api_base_url.includes("#") ||
    typeof context.model !== "string" ||
    context.model.length === 0 ||
    context.model.length > 256 ||
    context.model !== context.model.trim().normalize("NFC") ||
    /[\u0000-\u001f\u007f]/.test(context.model)
  ) {
    throw new SecurityError("INVALID_INPUT");
  }
  return Buffer.from(JSON.stringify([
    "ai-config-secret",
    ENVELOPE_VERSION,
    context.config_id,
    context.provider_profile,
    context.config_version,
    normalizedUrl,
    context.model,
  ]));
}

export function encryptSecret(
  plaintext: string,
  context: SecretContext,
  keyring: Keyring,
  now = new Date(),
): SecretEnvelope {
  if (typeof plaintext !== "string" || plaintext.length === 0 || plaintext.length > 16_384) {
    throw new SecurityError("INVALID_INPUT");
  }
  const key = requireKeyring(keyring);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ENVELOPE_ALGORITHM, key, iv, { authTagLength: 16 });
  cipher.setAAD(encodeAad(context));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return {
    envelope_version: ENVELOPE_VERSION,
    algorithm: ENVELOPE_ALGORITHM,
    key_id: keyring.activeKeyId,
    ...context,
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    authentication_tag: cipher.getAuthTag().toString("base64"),
    created_at: now.toISOString(),
  };
}

function decodeBase64(value: string, expectedLength?: number): Buffer {
  if (!BASE64_PATTERN.test(value)) throw new SecurityError("ENVELOPE_INVALID");
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) throw new SecurityError("ENVELOPE_INVALID");
  if (expectedLength !== undefined && decoded.length !== expectedLength) {
    throw new SecurityError("ENVELOPE_INVALID");
  }
  return decoded;
}

function isEnvelope(value: unknown): value is SecretEnvelope {
  if (!value || typeof value !== "object") return false;
  const envelope = value as Partial<SecretEnvelope>;
  return envelope.envelope_version === ENVELOPE_VERSION &&
    envelope.algorithm === ENVELOPE_ALGORITHM &&
    typeof envelope.key_id === "string" && ID_PATTERN.test(envelope.key_id) &&
    typeof envelope.config_id === "string" &&
    typeof envelope.provider_profile === "string" &&
    typeof envelope.config_version === "number" &&
    Number.isSafeInteger(envelope.config_version) && envelope.config_version > 0 &&
    typeof envelope.api_base_url === "string" &&
    typeof envelope.model === "string" &&
    typeof envelope.iv === "string" &&
    typeof envelope.ciphertext === "string" &&
    typeof envelope.authentication_tag === "string" &&
    typeof envelope.created_at === "string" &&
    !Number.isNaN(Date.parse(envelope.created_at));
}

export function decryptSecret(
  envelopeValue: unknown,
  expectedContext: SecretContext,
  keyring: Pick<Keyring, "keys">,
): string {
  if (!isEnvelope(envelopeValue)) throw new SecurityError("ENVELOPE_INVALID");
  const envelope = envelopeValue;
  if (
    envelope.config_id !== expectedContext.config_id ||
    envelope.provider_profile !== expectedContext.provider_profile ||
    envelope.config_version !== expectedContext.config_version ||
    envelope.api_base_url !== expectedContext.api_base_url ||
    envelope.model !== expectedContext.model
  ) {
    throw new SecurityError("DECRYPT_FAILED");
  }
  const key = keyring.keys.get(envelope.key_id);
  if (!key || !validateKey(key)) throw new SecurityError("DECRYPT_FAILED");
  const iv = decodeBase64(envelope.iv, 12);
  const ciphertext = decodeBase64(envelope.ciphertext);
  const authenticationTag = decodeBase64(envelope.authentication_tag, 16);

  try {
    const decipher = createDecipheriv(
      ENVELOPE_ALGORITHM,
      key,
      iv,
      { authTagLength: 16 },
    );
    decipher.setAAD(encodeAad(expectedContext));
    decipher.setAuthTag(authenticationTag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new SecurityError("DECRYPT_FAILED");
  }
}

export function fingerprintSecret(plaintext: string, keyring: Keyring): string {
  return createHmac("sha256", requireKeyring(keyring))
    .update("ai-config-key-fingerprint\0", "utf8")
    .update(plaintext, "utf8")
    .digest("hex")
    .slice(0, 16);
}
