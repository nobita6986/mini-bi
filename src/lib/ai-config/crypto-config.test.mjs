import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import {
  activateConfig,
  applyVerificationResult,
  configNeedsKeyRotation,
  createConfigCommand,
  disableConfig,
  makeConfigAudit,
  projectConfig,
  rotateConfigCommand,
} from "./config-contract.ts";
import {
  decryptSecret,
  encryptSecret,
  fingerprintSecret,
  keyringFromEnvironment,
} from "./crypto-envelope.ts";
import { SecurityError } from "./errors.ts";

const policy = {
  environment: "production",
  allowedHosts: ["api.provider.example"],
};
const context = {
  config_id: "pilot-config",
  provider_profile: "provider-one",
  config_version: 1,
  api_base_url: "https://api.provider.example/v1",
  model: "model-synthetic",
};
const now = new Date("2026-10-02T00:00:00.000Z");

function keyring(activeKeyId = "k1", keys = new Map([[activeKeyId, randomBytes(32)]])) {
  return { activeKeyId, keys };
}

function configInput(id, secret, keyringArg) {
  return {
    config_id: id,
    provider_profile: "provider-one",
    api_base_url: "https://api.provider.example/v1",
    model: "model-synthetic",
    secret,
    keyring: keyringArg,
    url_policy: policy,
    now,
  };
}

test("AES-GCM encrypt/decrypt uses fresh nonces and binds identity/version as AAD", () => {
  const keys = keyring();
  const one = encryptSecret("synthetic secret alpha", context, keys, now);
  const two = encryptSecret("synthetic secret alpha", context, keys, now);
  assert.notEqual(one.ciphertext, two.ciphertext);
  assert.notEqual(one.iv, two.iv);
  assert.equal(decryptSecret(one, context, keys), "synthetic secret alpha");
  assert.equal(one.envelope_version, 2);
  assert.equal(one.algorithm, "aes-256-gcm");
  assert.equal(one.created_at, now.toISOString());
});

test("wrong key, unknown key id, malformed and tampered envelope fail closed", () => {
  const keys = keyring();
  const envelope = encryptSecret("synthetic secret beta", context, keys, now);
  assert.throws(
    () => decryptSecret(envelope, context, keyring()),
    (error) => error instanceof SecurityError && error.code === "DECRYPT_FAILED",
  );
  assert.throws(() => decryptSecret({ ...envelope, key_id: "old-unknown" }, context, keys), {
    code: "DECRYPT_FAILED",
  });
  assert.throws(() => decryptSecret({ ...envelope, ciphertext: "!" }, context, keys), {
    code: "ENVELOPE_INVALID",
  });
  assert.throws(() => decryptSecret({ ...envelope, ciphertext: Buffer.from("tampered").toString("base64") }, context, keys), {
    code: "DECRYPT_FAILED",
  });
  assert.throws(() => decryptSecret({
    ...envelope,
    authentication_tag: Buffer.alloc(16).toString("base64"),
  }, context, keys), { code: "DECRYPT_FAILED" });
  assert.throws(() => decryptSecret(envelope, { ...context, config_version: 2 }, keys), {
    code: "DECRYPT_FAILED",
  });
  assert.throws(() => decryptSecret(envelope, { ...context, config_id: "other-config" }, keys), {
    code: "DECRYPT_FAILED",
  });
  assert.throws(() => decryptSecret(envelope, { ...context, provider_profile: "other-provider" }, keys), {
    code: "DECRYPT_FAILED",
  });
  assert.throws(() => decryptSecret(envelope, {
    ...context,
    api_base_url: "https://api.provider.example/v2",
  }, keys), { code: "DECRYPT_FAILED" });
  assert.throws(() => decryptSecret(envelope, {
    ...context,
    model: "other-model",
  }, keys), { code: "DECRYPT_FAILED" });
  assert.throws(() => decryptSecret({
    ...envelope,
    provider_profile: "other-provider",
  }, context, keys), { code: "DECRYPT_FAILED" });
  assert.throws(() => decryptSecret({
    ...envelope,
    config_version: 2,
  }, context, keys), { code: "DECRYPT_FAILED" });
  assert.throws(() => decryptSecret({
    ...envelope,
    api_base_url: "https://api.provider.example/v2",
  }, context, keys), { code: "DECRYPT_FAILED" });
  assert.throws(() => decryptSecret({
    ...envelope,
    model: "other-model",
  }, context, keys), { code: "DECRYPT_FAILED" });
  assert.throws(() => decryptSecret({ ...envelope, envelope_version: 99 }, context, keys), {
    code: "ENVELOPE_INVALID",
  });
});

test("environment key loading is server-only and strict; injected old keyring decrypts rotation", () => {
  const oldKey = randomBytes(32);
  const oldRing = { activeKeyId: "old-kid", keys: new Map([["old-kid", oldKey]]) };
  const oldEnvelope = encryptSecret("synthetic secret gamma", context, oldRing, now);
  const nextKey = randomBytes(32);
  const activeRing = keyring("new-kid", new Map([["old-kid", oldKey], ["new-kid", nextKey]]));
  assert.equal(configNeedsKeyRotation({
    ...createConfigCommand(configInput("old-version", "synthetic secret gamma", oldRing)),
  }, "new-kid"), true);
  const rotated = encryptSecret("synthetic secret gamma", {
    ...context,
    config_version: 2,
  }, activeRing, now);
  assert.equal(decryptSecret(oldEnvelope, context, activeRing), "synthetic secret gamma");
  assert.equal(rotated.key_id, "new-kid");
  assert.notEqual(rotated.iv, oldEnvelope.iv);
  assert.equal(rotated.api_base_url, context.api_base_url);
  assert.equal(rotated.model, context.model);
  assert.notEqual(rotated.ciphertext, oldEnvelope.ciphertext);
  assert.throws(() => keyringFromEnvironment({ AI_CONFIG_MASTER_KEY: "not-a-key" }), {
    code: "CONFIGURATION",
  });
  assert.throws(() => keyringFromEnvironment({ NEXT_PUBLIC_AI_CONFIG_MASTER_KEY: "not-a-key" }), {
    code: "CONFIGURATION",
  });
  assert.throws(() => keyringFromEnvironment({ AI_CONFIG_MASTER_KEY: Buffer.alloc(16).toString("base64") }), {
    code: "CONFIGURATION",
  });
  const environmentRing = keyringFromEnvironment({
    AI_CONFIG_MASTER_KEY: nextKey.toString("base64"),
    AI_CONFIG_ACTIVE_KEY_ID: "new-kid",
  });
  assert.equal(environmentRing.activeKeyId, "new-kid");
  assert.equal(environmentRing.keys.get("new-kid").equals(nextKey), true);
});

test("config commands create versioned ciphertext; read projection is secret-safe", () => {
  const keys = keyring();
  const config = createConfigCommand(configInput("candidate", "synthetic secret delta", keys));
  const projection = projectConfig(config);
  assert.equal(projection.status, "draft");
  assert.equal(projection.sanitized_host, "api.provider.example");
  assert.equal(projection.optimistic_version, 1);
  assert.equal(Object.hasOwn(projection, "encrypted_secret"), false);
  assert.equal(Object.hasOwn(projection, "api_base_url"), false);
  assert.deepEqual(projectConfig(config), projection);
  for (const forbidden of ["synthetic secret delta", config.api_base_url, config.encrypted_secret.ciphertext, config.encrypted_secret.iv, config.encrypted_secret.authentication_tag]) {
    assert.equal(JSON.stringify(projection).includes(forbidden), false);
  }
  assert.equal(fingerprintSecret("synthetic secret delta", keys), config.key_fingerprint);
  assert.notEqual(config.key_fingerprint, "synthetic secret delta");

  const changed = rotateConfigCommand(config, "synthetic secret epsilon", keys, now);
  assert.equal(config.version, 1);
  assert.equal(config.encrypted_secret.config_version, 1);
  assert.equal(changed.version, 2);
  assert.equal(changed.encrypted_secret.config_version, 2);
  assert.notEqual(changed.encrypted_secret.iv, config.encrypted_secret.iv);
  assert.equal(changed.status, "draft");
  assert.equal(changed.key_fingerprint, fingerprintSecret("synthetic secret epsilon", keys));
  assert.equal(decryptSecret(changed.encrypted_secret, {
    config_id: changed.config_id,
    provider_profile: changed.provider_profile,
    config_version: changed.version,
    api_base_url: changed.api_base_url,
    model: changed.model,
  }, keys), "synthetic secret epsilon");
});

test("failed candidate verification preserves the active config; activation and disable retain versions", () => {
  const keys = keyring();
  const first = createConfigCommand(configInput("first", "synthetic secret zeta", keys));
  const firstVerified = applyVerificationResult([first], "first", 1, true, now);
  const active = activateConfig(firstVerified, "first", 1, now);
  const activeAfterRetest = applyVerificationResult(active, "first", 1, true, now);
  assert.equal(activeAfterRetest.find((config) => config.config_id === "first").status, "active");
  const candidate = createConfigCommand(configInput("candidate", "synthetic secret eta", keys));
  const failed = applyVerificationResult([...active, candidate], "candidate", 1, false, now);
  assert.equal(failed.find((config) => config.config_id === "first").status, "active");
  assert.equal(failed.find((config) => config.config_id === "candidate").status, "test_failed");
  const verified = applyVerificationResult(failed, "candidate", 1, true, now);
  const switched = activateConfig(verified, "candidate", 1, now);
  assert.equal(switched.filter((config) => config.status === "active").length, 1);
  assert.equal(switched.find((config) => config.config_id === "first").status, "disabled");
  assert.equal(switched.length, 2);
  const disabled = disableConfig(switched, "candidate", 1, now);
  assert.equal(disabled.length, 2);
  assert.equal(disabled.find((config) => config.config_id === "candidate").status, "disabled");
  assert.throws(() => activateConfig(failed, "candidate", 1, now), { code: "INVALID_INPUT" });
});

test("audit records contain only the allowlisted safe fields", () => {
  const audit = makeConfigAudit({
    actor: "pilot-actor",
    action: "config_verified",
    version: 2,
    provider_profile: "provider-one",
    model: "model-synthetic",
    sanitized_host: "api.provider.example",
    key_fingerprint: "0123456789abcdef",
    outcome: "failure",
    timestamp: now.toISOString(),
    reason_code: "provider_timeout",
  });
  assert.deepEqual(Object.keys(audit), [
    "actor", "action", "version", "provider_profile", "model",
    "sanitized_host", "key_fingerprint", "outcome", "timestamp", "reason_code",
  ]);
});

test("sanitized crypto errors never include secret or crypto-library detail", () => {
  const secret = "synthetic secret theta";
  let thrown;
  try {
    decryptSecret({}, context, keyring());
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof SecurityError);
  assert.deepEqual(Object.keys(thrown.toJSON()).sort(), ["code", "message"]);
  assert.equal(JSON.stringify(thrown).includes(secret), false);
});
