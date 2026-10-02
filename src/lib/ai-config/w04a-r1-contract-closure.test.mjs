/**
 * P1.5-W04A-R1 — Regression cho bốn finding G4A:
 *   B. Trần body theo BYTE cứng (UTF-8), chunked dừng sớm;
 *   C. Read-result truthfulness (không biến lỗi DB/malformed thành null/not_configured);
 *   D. Optimistic concurrency cho rotate (expected_version bắt buộc, DB là authority);
 *   E. Công bố rate limit là process-local/best-effort (P3 thay bằng DB/KV atomic).
 * (A — modal a11y + secret lifecycle — nằm ở src/components/dashboard/ai-settings-panel.test.mjs.)
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

import { keyringFromEnvironment } from "./crypto-envelope.ts";
import {
  classifyRpcResponse,
  projectActiveConfig,
  sanitizeMessage,
} from "./read-result.ts";
import {
  MAX_SETTINGS_BODY_BYTES,
  readBoundedBodyBytes,
  readSettingsBody,
} from "./server/route-helpers.mjs";
import {
  PILOT_CONFIG_ID,
  activateProviderConfig,
  disableProviderConfig,
  readSettingsStatus,
  rotateProviderKey,
  saveProviderConfig,
  testProviderConnection,
} from "./settings-service.ts";
import { createMemoryConfigStore } from "./testing/memory-config-store.mjs";

const SECRET = "sk-test-synthetic-r1";
const KEYRING = keyringFromEnvironment({
  AI_CONFIG_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
  AI_CONFIG_ACTIVE_KEY_ID: "k1",
});
const POLICY = { environment: "production", nodeEnv: "production", allowedHosts: ["api.example.com"], allowedPorts: [443] };
const BODY = {
  provider_profile: "openai-compatible",
  api_url: "https://api.example.com/v1",
  model: "gpt-test-model",
  api_key: SECRET,
  expected_version: null,
};
const INFRA_FAILURE = { ok: false, code: "AI_INTERNAL", message: "rpc ai_provider_config_current thất bại" };

/** Request giả có kiểm soát số chunk thực sự bị đọc (chứng minh dừng sớm). */
function fakeRequest(chunks, contentLength) {
  let pulls = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (pulls >= chunks.length) {
        controller.close();
        return;
      }
      const chunk = chunks[pulls];
      pulls += 1;
      controller.enqueue(chunk);
    },
  });
  const headers = new Headers();
  if (contentLength !== undefined) headers.set("content-length", String(contentLength));
  return { request: { headers, body: stream }, pulls: () => pulls };
}

function jsonChunks(text, size = 4096) {
  const bytes = Buffer.from(text, "utf8");
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += size) {
    chunks.push(new Uint8Array(bytes.subarray(offset, Math.min(offset + size, bytes.length))));
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// B. Trần body theo byte cứng
// ---------------------------------------------------------------------------

test("W04A-R1-B1: trần body là 20 KiB và tính bằng BYTE (không dùng string.length)", async () => {
  assert.equal(MAX_SETTINGS_BODY_BYTES, 20 * 1024);

  // Đúng boundary (byte == trần) ⇒ pass.
  const prefix = '{"pad":"';
  const suffix = '"}';
  const padding = "a".repeat(MAX_SETTINGS_BODY_BYTES - Buffer.byteLength(prefix) - Buffer.byteLength(suffix));
  const exact = prefix + padding + suffix;
  assert.equal(Buffer.byteLength(exact, "utf8"), MAX_SETTINGS_BODY_BYTES);
  const exactResult = await readSettingsBody(fakeRequest(jsonChunks(exact)).request);
  assert.equal(exactResult.ok, true);
  assert.equal(exactResult.value.pad.length, padding.length);

  // Multibyte DƯỚI trần: string.length nhỏ hơn nhiều so với số byte ⇒ vẫn pass.
  const multibytePad = "ệ".repeat(6000);
  const multibyteUnder = prefix + multibytePad + suffix;
  assert.ok(Buffer.byteLength(multibyteUnder, "utf8") <= MAX_SETTINGS_BODY_BYTES);
  assert.ok(multibyteUnder.length < Buffer.byteLength(multibyteUnder, "utf8"));
  const underResult = await readSettingsBody(fakeRequest(jsonChunks(multibyteUnder)).request);
  assert.equal(underResult.ok, true);

  // Multibyte VƯỢT trần nhưng string.length vẫn NHỎ hơn trần ⇒ phải bị chặn (đo byte, không đo ký tự).
  const multibyteOver = prefix + "ệ".repeat(7000) + suffix;
  assert.ok(multibyteOver.length < MAX_SETTINGS_BODY_BYTES, "string.length phải nhỏ hơn trần để test có nghĩa");
  assert.ok(Buffer.byteLength(multibyteOver, "utf8") > MAX_SETTINGS_BODY_BYTES);
  const overResult = await readSettingsBody(fakeRequest(jsonChunks(multibyteOver)).request);
  assert.equal(overResult.ok, false);
  assert.equal(overResult.code, "RESULT_TOO_LARGE");
});

test("W04A-R1-B2: chunked (không Content-Length) vượt trần ⇒ chặn và DỪNG SỚM, không đọc hết body", async () => {
  const marker = "MARKER-NOI-DUNG-BI-MAT-";
  const chunks = jsonChunks(marker + "x".repeat(40 * 1024), 4 * 1024); // 10 chunk × 4 KiB = 40 KiB
  const { request, pulls } = fakeRequest(chunks);

  const result = await readBoundedBodyBytes(request, MAX_SETTINGS_BODY_BYTES);
  assert.equal(result.ok, false);
  assert.equal(result.code, "RESULT_TOO_LARGE");
  assert.ok(pulls() < chunks.length, "phải dừng trước khi đọc hết " + chunks.length + " chunk (đã đọc " + pulls() + ")");

  // Và thông điệp lỗi KHÔNG echo nội dung body.
  assert.equal(result.message.includes(marker), false);
  const parsed = await readSettingsBody(fakeRequest(chunks).request);
  assert.equal(parsed.message.includes(marker), false, "lỗi không được echo body");
});

test("W04A-R1-B3: Content-Length vượt trần ⇒ từ chối TRƯỚC khi đọc stream", async () => {
  const chunks = jsonChunks('{"pad":"' + "a".repeat(1000) + '"}', 256);
  let readerCalls = 0;
  const untouchedBody = {
    getReader() {
      readerCalls += 1;
      throw new Error("không được đọc body khi Content-Length đã vượt trần");
    },
  };
  const overHeaders = new Headers({ "content-length": String(MAX_SETTINGS_BODY_BYTES + 1) });
  const result = await readBoundedBodyBytes({ headers: overHeaders, body: untouchedBody }, MAX_SETTINGS_BODY_BYTES);
  assert.equal(result.ok, false);
  assert.equal(result.code, "RESULT_TOO_LARGE");
  assert.equal(readerCalls, 0, "không được mở reader khi Content-Length đã vượt trần");

  const invalidHeaders = new Headers({ "content-length": "khong-phai-so" });
  const invalidResult = await readBoundedBodyBytes({ headers: invalidHeaders, body: untouchedBody }, MAX_SETTINGS_BODY_BYTES);
  assert.equal(invalidResult.ok, false);
  assert.equal(invalidResult.code, "INVALID_INPUT");
  assert.equal(readerCalls, 0);

  // Request thật không có body ⇒ body rỗng hợp lệ (không phải lỗi).
  const emptyRequest = await readBoundedBodyBytes({ headers: new Headers(), body: null }, MAX_SETTINGS_BODY_BYTES);
  assert.equal(emptyRequest.ok, true);
  assert.equal(emptyRequest.bytes, 0);
  assert.ok(chunks.length > 0);
});

test("W04A-R1-B4: body sai định dạng ⇒ thông điệp lỗi ngắn, một dòng, không echo nội dung", async () => {
  const marker = "SECRET-LEAK-CANARY-1234567890";
  const broken = await readSettingsBody(fakeRequest([new Uint8Array(Buffer.from('{"api_key":"' + marker + '"', "utf8"))]).request);
  assert.equal(broken.ok, false);
  assert.equal(broken.code, "INVALID_INPUT");
  assert.equal(broken.message.includes(marker), false);

  const arrayBody = await readSettingsBody(fakeRequest([new Uint8Array(Buffer.from("[1,2,3]", "utf8"))]).request);
  assert.equal(arrayBody.ok, false);
  assert.equal(arrayBody.message.includes("[1,2,3]"), false);

  const empty = await readSettingsBody(fakeRequest([new Uint8Array(0)]).request);
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.value, {});
});

// ---------------------------------------------------------------------------
// C. Read-result truthfulness
// ---------------------------------------------------------------------------

test("W04A-R1-C1: classifier RPC phân biệt thành công · từ chối hợp lệ · lỗi hạ tầng (không lộ raw error)", () => {
  const ok = classifyRpcResponse("x", { data: { ok: true, config: null }, error: null });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.config, null);

  const refusal = classifyRpcResponse("x", { data: { ok: false, code: "AI_CONFIG_NOT_FOUND", message: "không thấy" }, error: null });
  assert.equal(refusal.ok, false);
  assert.equal(refusal.code, "AI_CONFIG_NOT_FOUND");

  const rawError = classifyRpcResponse("x", { data: null, error: { message: "relation \"ai_provider_configs\" does not exist", code: "42P01" } });
  assert.equal(rawError.ok, false);
  assert.equal(rawError.code, "AI_INTERNAL");
  assert.equal(rawError.message.includes("42P01"), false);
  assert.equal(rawError.message.includes("does not exist"), false, "không được lộ raw Supabase error");

  for (const malformed of [undefined, null, {}, { data: null }, { data: "nope" }, { data: [1, 2] }, { data: { ok: false } }]) {
    const result = classifyRpcResponse("x", malformed);
    assert.equal(result.ok, false, JSON.stringify(malformed));
    assert.equal(result.code, "AI_INTERNAL", JSON.stringify(malformed));
  }

  assert.equal(sanitizeMessage("a\nb\u0000c", "fb"), "a b c");
  assert.equal(sanitizeMessage(undefined, "fb"), "fb");
});

test("W04A-R1-C2: projectActiveConfig — shape thiếu/sai kiểu là AI_INTERNAL, KHÔNG phải 'không có cấu hình'", () => {
  const good = projectActiveConfig({
    ok: true,
    config_id: "pilot-provider",
    version: 2,
    provider_profile: "openai-compatible",
    model: "gpt-test-model",
    sanitized_host: "api.example.com",
    verified_at: "2026-10-02T00:00:00.000Z",
  });
  assert.equal(good.ok, true);
  assert.equal(good.config.version, 2);

  const malformed = [
    { ok: true, version: 2, provider_profile: "p", model: "m" },
    { ok: true, config_id: "c", version: 0, provider_profile: "p", model: "m" },
    { ok: true, config_id: "c", version: "2", provider_profile: "p", model: "m" },
    { ok: true, config_id: "c", version: 2, provider_profile: "", model: "m" },
    { ok: true, config_id: "c", version: 2, provider_profile: "p", model: "" },
    { ok: false, code: "AI_INTERNAL" },
  ];
  for (const value of malformed) {
    const result = projectActiveConfig(value);
    assert.equal(result.ok, false, JSON.stringify(value));
    assert.equal(result.code, "AI_INTERNAL", JSON.stringify(value));
  }
});

test("W04A-R1-C3: lỗi đọc KHÔNG bị biến thành NOT_FOUND/AI_CONFIG_REQUIRED (mọi đường)", async () => {
  const store = createMemoryConfigStore({ readFailure: INFRA_FAILURE });

  const status = await readSettingsStatus({ store, config_id: PILOT_CONFIG_ID });
  assert.equal(status.ok, false);
  assert.equal(status.code, "AI_INTERNAL");

  const calls = [
    () => saveProviderConfig({ store, keyring: KEYRING, url_policy: POLICY, actor: "pilot-admin", body: BODY }),
    () => rotateProviderKey({ store, keyring: KEYRING, actor: "pilot-admin", body: { api_key: SECRET, expected_version: 1 } }),
    () => testProviderConnection({ store, keyring: KEYRING, url_policy: POLICY, actor: "pilot-admin", body: {} }),
    () => activateProviderConfig({ store, actor: "pilot-admin", body: { version: 1 } }),
    () => disableProviderConfig({ store, actor: "pilot-admin", body: { version: 1 } }),
  ];
  for (const call of calls) {
    const result = await call();
    assert.equal(result.ok, false);
    assert.equal(result.code, "AI_INTERNAL", "lỗi hạ tầng phải giữ AI_INTERNAL");
    assert.notEqual(result.code, "NOT_FOUND");
    assert.notEqual(result.code, "AI_CONFIG_REQUIRED");
  }
});

test("W04A-R1-C4: store — đọc thành công nhưng KHÔNG có cấu hình vẫn là ok:true (không nhầm với lỗi)", async () => {
  const store = createMemoryConfigStore();
  const status = await readSettingsStatus({ store, config_id: PILOT_CONFIG_ID });
  assert.equal(status.ok, true);
  assert.equal(status.config, null);
  assert.equal(status.active, null);

  // và lỗi hạ tầng thì ngược lại
  const brokenStore = createMemoryConfigStore({ readFailure: INFRA_FAILURE });
  const broken = await readSettingsStatus({ store: brokenStore, config_id: PILOT_CONFIG_ID });
  assert.equal(broken.ok, false);

  const source = readFileSync(new URL("./server/store.mjs", import.meta.url), "utf8");
  assert.equal(source.includes("classifyRpcResponse"), true, "store phải dùng classifier chung");
  assert.equal(source.includes("catch {\n    return fail"), true, "lỗi transport phải map AI_INTERNAL");
  for (const forbidden of ["error.message", "error.details", "error.hint", "data.error"]) {
    assert.equal(source.includes(forbidden), false, "không được lộ raw Supabase error: " + forbidden);
  }
});

// ---------------------------------------------------------------------------
// D. Optimistic concurrency
// ---------------------------------------------------------------------------

test("W04A-R1-D1: rotate bắt buộc expected_version integer >= 1 (thiếu/sai kiểu ⇒ AI_INPUT_INVALID)", async () => {
  const store = createMemoryConfigStore();
  await saveProviderConfig({ store, keyring: KEYRING, url_policy: POLICY, actor: "pilot-admin", body: BODY });

  const invalid = [
    { api_key: SECRET },
    { api_key: SECRET, expected_version: null },
    { api_key: SECRET, expected_version: "1" },
    { api_key: SECRET, expected_version: 0 },
    { api_key: SECRET, expected_version: -2 },
    { api_key: SECRET, expected_version: 1.5 },
  ];
  for (const body of invalid) {
    const result = await rotateProviderKey({ store, keyring: KEYRING, actor: "pilot-admin", body });
    assert.equal(result.ok, false, JSON.stringify(body));
    assert.equal(result.code, "INVALID_INPUT", JSON.stringify(body));
  }
  assert.equal(store.versions.size, 1, "không được tạo version mới khi input không hợp lệ");
});

test("W04A-R1-D2: hai client giữ cùng version — chỉ mutation ĐẦU thành công, client sau bị VERSION_CONFLICT", async () => {
  const store = createMemoryConfigStore();
  await saveProviderConfig({ store, keyring: KEYRING, url_policy: POLICY, actor: "pilot-admin", body: BODY });
  assert.equal(store.versions.size, 1);

  // Hai "client" cùng thấy version 1.
  const clientA = await rotateProviderKey({ store, keyring: KEYRING, actor: "pilot-admin", body: { api_key: "sk-first-wins", expected_version: 1 } });
  const clientB = await rotateProviderKey({ store, keyring: KEYRING, actor: "pilot-admin", body: { api_key: "sk-second-loses", expected_version: 1 } });

  assert.equal(clientA.ok, true);
  assert.equal(clientA.config.version, 2);
  assert.equal(clientB.ok, false);
  assert.equal(clientB.code, "VERSION_CONFLICT");
  assert.equal(store.versions.size, 2, "client sau KHÔNG được tạo version mới");
  assert.equal(store.versions.has(3), false);
  assert.equal(store.audit.at(-1).reason_code, "version_conflict");
  assert.equal(store.audit.at(-1).event_type, "config_mutation_rejected");

  // Save cũng đi theo cùng luật OCC.
  const staleSave = await saveProviderConfig({ store, keyring: KEYRING, url_policy: POLICY, actor: "pilot-admin", body: { ...BODY, expected_version: 1 } });
  assert.equal(staleSave.ok, false);
  assert.equal(staleSave.code, "VERSION_CONFLICT");
  assert.equal(store.versions.size, 2);
});

test("W04A-R1-D3: DB RPC vẫn là authority cuối cùng cho OCC và một-active", () => {
  const sql = readFileSync(new URL("../../../supabase/migrations/20261001170000_p1_5_ai_provider_config.sql", import.meta.url), "utf8");
  assert.equal(sql.includes("p_expected_version is distinct from v_current"), true, "RPC save phải kiểm OCC");
  assert.equal(sql.includes("ai_provider_configs_active_uidx"), true, "phải có unique index một version active");
  assert.equal(sql.includes("pg_advisory_xact_lock"), true, "mutation phải serialize trong transaction");
});

// ---------------------------------------------------------------------------
// E. Công bố rate limit
// ---------------------------------------------------------------------------

test("W04A-R1-E1: rate limit được công bố là process-local/best-effort, P3 phải thay bằng DB/KV atomic", () => {
  const helpers = readFileSync(new URL("./server/route-helpers.mjs", import.meta.url), "utf8");
  const limiter = readFileSync(new URL("./rate-limit.ts", import.meta.url), "utf8");
  const handoff = readFileSync(new URL("../../../docs/handoffs/p1.5-w04.md", import.meta.url), "utf8");

  for (const [label, source] of [["route-helpers", helpers], ["rate-limit", limiter], ["handoff", handoff]]) {
    const text = source.toLowerCase();
    assert.equal(text.includes("process-local"), true, label + " phải nói rõ process-local");
    assert.equal(text.includes("best-effort"), true, label + " phải nói rõ best-effort");
    assert.equal(text.includes("p3"), true, label + " phải nêu P3 thay bằng limiter atomic");
  }
  assert.equal(helpers.includes("hard distributed rate limit"), true, "phải phủ nhận tuyên bố hard distributed");
});
