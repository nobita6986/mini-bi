import "server-only";

/**
 * P1.5-W04 — Wiring server-only: config + Supabase repository + packet source + scripted provider.
 * Live provider vẫn TẮT (chờ G4A). Không log packet/payload/output.
 */

import {
  PILOT_ACTOR_REF,
  accessScopeHashFor,
  currentPromptVersion,
  readGatewayPolicy,
  readProviderConfig,
} from "./config.mjs";
import { createSupabaseAuditSink, createSupabaseJobRepository } from "./repository.mjs";
import { loadFrozenPacket } from "./packet-source.mjs";
import { SCRIPTED_ADAPTER_VERSION, createScriptedAdapter } from "../provider.mjs";
import { createDefaultTimeoutSignal } from "../run-one-job.mjs";
import { getPromptManifest } from "../prompt-registry.mjs";
import { createAiReportService } from "../service-core.mjs";

/**
 * @returns {{ ok: true, service: any, actor_ref: string, access_scope_hash: string, provider_key: string, model_key: string, adapter_version: string, prompt_version: string }
 *   | { ok: false, code: string, message: string }}
 */
export function createServerAiReportGateway() {
  const manifest = getPromptManifest(currentPromptVersion());
  if (!manifest) return { ok: false, code: "AI_CONFIG_REQUIRED", message: "prompt version không tồn tại trong registry" };

  const provider = readProviderConfig();
  if (!provider.ok) return provider;

  const policy = readGatewayPolicy();
  if (!policy.ok) return policy;

  const service = createAiReportService({
    queue: createSupabaseJobRepository(),
    audit: createSupabaseAuditSink(),
    packetLoader: loadFrozenPacket,
    manifest,
    policy: { config: policy.config },
    provider: {
      provider_key: provider.provider_key,
      model_key: provider.model_key,
      config: { scenario: "valid" },
    },
    timeout: { create: createDefaultTimeoutSignal },
    clock: { nowMs: () => Date.now() },
  });

  return {
    ok: true,
    service,
    actor_ref: PILOT_ACTOR_REF,
    access_scope_hash: accessScopeHashFor(PILOT_ACTOR_REF),
    provider_key: provider.provider_key,
    model_key: provider.model_key,
    adapter_version: SCRIPTED_ADAPTER_VERSION,
    prompt_version: manifest.prompt_version,
  };
}

/** Adapter scripted cho đường inline (fast-path). Live ⇒ disabled. */
export function scriptedAdapterFor(scenario) {
  return createScriptedAdapter({ scenario: scenario ?? "valid" });
}
