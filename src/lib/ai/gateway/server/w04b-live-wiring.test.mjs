/**
 * P1.5-W04B-S02A — FT0 (test:server): server-only wiring cho live adapter.
 * - Wiring resolves live adapter qua mock secure outbound + url_policy đã validate.
 * - Allowlist thiếu/sai ⇒ validateProviderUrl reject TRƯỚC DNS/network (0 outbound).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { safeOutboundRequest } from "../../../ai-config/safe-outbound.ts";
import { activeProviderConfigForGateway } from "./active-config-bridge.mjs";
import { createLiveAdapterFactory } from "./live-wiring.mjs";
import { getPromptManifest, PROMPT_MANIFEST_V1 } from "../prompt-registry.mjs";

const PROMPT = getPromptManifest(PROMPT_MANIFEST_V1.prompt_version);
const SECRET = "sk-test-secret-1234567890";

function analysisJson() {
  return JSON.stringify({
    contract_version: "business-analysis/0.1",
    period_ref: "week:2026-W41",
    report_status: "draft",
    executive_analysis: "Kỳ này ghi nhận 5 người.",
    findings: [],
    overall_limitations: [],
    executive_evidence_refs: [],
  });
}

function envelope(content) {
  return JSON.stringify({
    id: "chatcmpl-1",
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  });
}

function reqFor() {
  return {
    payload: { payload_version: "provider-payload/0.1", period: { period_ref: "week:2026-W41" }, totals: { current: 5 } },
    promptManifest: PROMPT,
    modelConfig: {
      provider_key: "live",
      model_key: "gpt-4o-mini",
      adapter_version: "live-adapter/0.5",
      timeout_ms: 2000,
      provider_config: { config_id: "pilot-provider", version: 1, provider_profile: "openai-compatible", api_base_url: "https://api.example.test/v1", sanitized_host: "api.example.test" },
      credential_secret: SECRET,
    },
    timeoutSignal: undefined,
  };
}

test("W04B-W1: wiring resolves live adapter qua mock outbound + canonical profile endpoint", async () => {
  const calls = [];
  const outbound = async (url, opts) => {
    calls.push({ url, opts });
    return { statusCode: 200, headers: {}, body: Buffer.from(envelope(analysisJson())) };
  };
  const factory = createLiveAdapterFactory({ outbound, url_policy: { environment: "production", allowedHosts: ["api.example.test"] } });
  const resolved = factory({ provider_key: "live", config: {} });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.adapter.provider_key, "live");
  assert.equal(resolved.adapter.adapter_version, "live-adapter/0.5");

  const result = await resolved.adapter.generateStructured(reqFor());
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.example.test/v1/chat/completions");
  assert.equal(calls[0].opts.headers.authorization, "Bearer " + SECRET);
});

test("W04B-W2: wiring scripted ⇒ resolveProviderAdapter mặc định", () => {
  const factory = createLiveAdapterFactory({ outbound: async () => ({ statusCode: 200, headers: {}, body: Buffer.from("{}") }), url_policy: { environment: "production", allowedHosts: [] } });
  const resolved = factory({ provider_key: "scripted", config: {} });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.adapter.provider_key, "scripted");
});

test("W04B-W3: allowlist sai ⇒ reject TRƯỚC network (0 resolve, 0 request)", async () => {
  let resolveCalls = 0;
  let requestCalls = 0;
  const wrapped = (url, opts) => safeOutboundRequest(url, {
    ...opts,
    resolve: async () => { resolveCalls += 1; return ["8.8.8.8"]; },
    request: async () => { requestCalls += 1; return { statusCode: 200, headers: {}, body: Buffer.from(envelope(analysisJson())) }; },
  });
  const factory = createLiveAdapterFactory({ outbound: wrapped, url_policy: { environment: "production", allowedHosts: ["wrong-host.com"] } });
  const resolved = factory({ provider_key: "live", config: {} });
  const result = await resolved.adapter.generateStructured(reqFor());
  assert.equal(result.ok, false);
  assert.equal(result.error_code, "AI_PROVIDER_PERMANENT");
  assert.equal(resolveCalls, 0, "0 DNS resolve khi allowlist sai");
  assert.equal(requestCalls, 0, "0 network request khi allowlist sai");
});

test("W04B-W4: allowlist rỗng ⇒ reject TRƯỚC network (0 resolve, 0 request)", async () => {
  let resolveCalls = 0;
  let requestCalls = 0;
  const wrapped = (url, opts) => safeOutboundRequest(url, {
    ...opts,
    resolve: async () => { resolveCalls += 1; return ["8.8.8.8"]; },
    request: async () => { requestCalls += 1; return { statusCode: 200, headers: {}, body: Buffer.from(envelope(analysisJson())) }; },
  });
  const factory = createLiveAdapterFactory({ outbound: wrapped, url_policy: { environment: "production", allowedHosts: [] } });
  const resolved = factory({ provider_key: "live", config: {} });
  const result = await resolved.adapter.generateStructured(reqFor());
  assert.equal(result.ok, false);
  assert.equal(result.error_code, "AI_PROVIDER_PERMANENT");
  assert.equal(resolveCalls, 0, "0 DNS resolve khi allowlist rỗng");
  assert.equal(requestCalls, 0, "0 network request khi allowlist rỗng");
});

test("W04B-W5: active config bridge unwrap đúng StoreRead envelope cho enqueue", () => {
  const projection = {
    config_id: "pilot-provider",
    version: 1,
    provider_profile: "openai-compatible",
    model: "deepseek-flash",
    status: "active",
    verified_at: "2026-10-03T03:37:09.000Z",
  };
  const result = activeProviderConfigForGateway({ ok: true, config: projection });
  assert.deepEqual(result, { ok: true, config: projection });
  assert.equal(result.config.config_id, "pilot-provider");
  assert.equal(result.config.version, 1);
  assert.equal(result.config.ok, undefined, "config không được chứa envelope lồng thêm một lớp");
});

test("W04B-W6: active config bridge fail-closed khi thiếu config hoặc store lỗi", () => {
  assert.equal(activeProviderConfigForGateway({ ok: true, config: null }).code, "AI_CONFIG_REQUIRED");
  assert.equal(activeProviderConfigForGateway({ ok: false, code: "AI_INTERNAL", message: "raw" }).code, "AI_INTERNAL");
  assert.equal(activeProviderConfigForGateway(undefined).code, "AI_INTERNAL");
});
