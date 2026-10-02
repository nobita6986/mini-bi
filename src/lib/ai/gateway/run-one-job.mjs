/**
 * P1.5-W04 — Worker step thuần/testable với dependency injection.
 *
 * DB queue là authority: module này KHÔNG tự giữ state, KHÔNG tự chọn job — nó gọi `queue.claim`.
 * `after()` của Next.js (nếu dùng ở route) chỉ là fast-path, KHÔNG phải durability guarantee.
 */

import { buildProviderPayload, utf8ByteLength } from "./payload.mjs";
import { validateGeneratedAnalysis } from "./output-guard.mjs";
import { evaluateAdmissionPolicy, evaluateAttemptPolicy } from "./policy.mjs";
import { resolveProviderAdapter } from "./provider.mjs";
import { decideAfterFailure } from "./job-state.mjs";
import { projectClaim } from "./rpc-projection.mjs";
import { LEASE_SECONDS } from "./limits.mjs";

/** Signal timeout mặc định (Node/Next server runtime); test có thể inject bản điều khiển được. */
export function createDefaultTimeoutSignal(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === "function") timer.unref();
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

function parseStructured(result) {
  if (result.structured !== null && result.structured !== undefined) return { ok: true, value: result.structured };
  try {
    const parsed = JSON.parse(result.raw_text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, code: "AI_PROVIDER_MALFORMED", message: "output không phải JSON object" };
    }
    return { ok: true, value: parsed };
  } catch {
    return { ok: false, code: "AI_PROVIDER_MALFORMED", message: "output không parse được JSON" };
  }
}

/**
 * Enqueue-or-reuse (idempotent) + ADMISSION policy gate (rate · queue-depth · token budget).
 * Không kiểm attempts/payload ở đây — đó là policy của worker sau claim.
 * deps: { queue, policy, identity, manifest, provider, model, audit, clock, context }
 */
export async function enqueueReport({ deps, request, context, now_ms }) {
  const now = Number.isFinite(now_ms) ? now_ms : deps.clock.nowMs();

  const admission = evaluateAdmissionPolicy({
    config: deps.policy.config,
    context: context ?? {
      now_ms: now,
      actor_ref: request.actor_ref,
      access_scope_hash: request.access_scope_hash,
      recent_requests: [],
      queued_jobs: 0,
      tokens_used_today: 0,
    },
  });
  if (!admission.ok) return { ok: false, code: admission.code, message: admission.message };

  const identity = deps.identity.build(request);
  if (!identity.ok) return identity;

  const enqueued = await deps.queue.enqueueOrReuse({
    identity_hash: identity.identity_hash,
    identity_components: identity.components,
    request,
    now_ms: now,
  });
  if (!enqueued.ok) return enqueued;

  /**
   * D (R4) — Audit authority DUY NHẤT nằm ở DB (`ai_report_enqueue` ghi job_enqueued / job_reused /
   * job_cache_hit trong CÙNG transaction với quyết định) ⇒ application KHÔNG tự append lifecycle event,
   * và không thể trả success nếu insert audit thất bại.
   */
  return {
    ok: true,
    job_id: enqueued.job_id,
    status: enqueued.status,
    reused: enqueued.reused === true,
    cache_hit: enqueued.cache_hit === true,
    revision_id: enqueued.revision_id ?? null,
  };
}

/**
 * Chạy MỘT job (nếu có). Trả RunJobResult; không ném ra ngoài (mọi lỗi được phân loại).
 */
export async function runOneJob({ deps, worker_ref, now_ms, lease_seconds = LEASE_SECONDS }) {
  const now = Number.isFinite(now_ms) ? now_ms : deps.clock.nowMs();
  /**
   * C (R4) — Claim response được project/validate TẠI ĐÂY (không phụ thuộc implementation queue):
   * thiếu job/attempt/lease_token/provider-model-adapter-prompt ⇒ worker error, không gọi provider.
   */
  const claimed = projectClaim(
    await deps.queue.claim({
      worker_ref,
      lease_seconds,
      now_ms: now,
      // R3: DB claim là authority cho trần concurrency provider.
      max_concurrent_jobs: deps.policy.config?.max_concurrent_jobs,
    })
  );
  // E — chỉ AI_IDLE mới là idle; lỗi DB/RPC phải nổi lên thành worker error (không giả thành "không có việc").
  if (claimed === null) {
    return { kind: "idle", job_id: null, status: null, error_code: null, revision_id: null, attempts: null, next_attempt_at: null };
  }
  if (claimed.ok === false) {
    // Hết slot provider KHÔNG phải lỗi hạ tầng: job vẫn nằm trong queue và sẽ được claim sau.
    if (claimed.code === "AI_CONCURRENCY_LIMITED") {
      return {
        kind: "deferred",
        job_id: null,
        status: null,
        error_code: "AI_CONCURRENCY_LIMITED",
        revision_id: null,
        attempts: null,
        next_attempt_at: null,
      };
    }
    return {
      kind: "error",
      job_id: claimed.job_id ?? null,
      status: null,
      error_code: claimed.code ?? "AI_INTERNAL",
      revision_id: null,
      attempts: null,
      next_attempt_at: null,
    };
  }

  const job = claimed.job;
  /**
   * B (R4) — MỌI nhánh thất bại đi qua ĐÚNG MỘT writer có kiểm tra kết quả `queue.fail()`:
   * - fail() trả AI_LEASE_LOST ⇒ lease_lost (không báo retry/failed giả)
   * - fail() lỗi DB/RPC ⇒ infrastructure error
   * - chỉ khi DB đã cập nhật thành công mới trả retry_scheduled/failed
   */
  const failWith = async ({ error_code, message, next_status, next_attempt_at }) => {
    const failed = await deps.queue.fail({
      job_id: job.job_id,
      lease_token: claimed.lease_token,
      error_code,
      next_status,
      next_attempt_at,
      message,
      now_ms: now,
    });
    if (!failed || failed.ok !== true) {
      if (failed && failed.code === "AI_LEASE_LOST") {
        return {
          kind: "lease_lost",
          job_id: job.job_id,
          status: null,
          error_code: null,
          revision_id: null,
          attempts: claimed.attempt,
          next_attempt_at: null,
        };
      }
      return {
        kind: "error",
        job_id: job.job_id,
        status: null,
        error_code: (failed && failed.code) || "AI_INTERNAL",
        revision_id: null,
        attempts: claimed.attempt,
        next_attempt_at: null,
      };
    }
    return {
      kind: next_status === "queued" ? "retry_scheduled" : "failed",
      job_id: job.job_id,
      status: next_status,
      error_code,
      revision_id: null,
      attempts: claimed.attempt,
      next_attempt_at: next_attempt_at ?? null,
    };
  };

  const report = async (errorCode, message) => {
    const decision = decideAfterFailure({
      error_code: errorCode,
      attempts: claimed.attempt,
      max_attempts: job.max_attempts,
      now_ms: now,
      seed: job.job_id,
    });
    return failWith({
      error_code: errorCode,
      message,
      next_status: decision.next_status,
      next_attempt_at: decision.next_attempt_at,
    });
  };

  // 1. Minimize payload (whitelist). Lỗi ở đây là lỗi input/config — không gọi provider.
  const built = buildProviderPayload(job.packet, deps.manifest, {
    max_payload_bytes: deps.policy.config?.max_payload_bytes,
  });
  if (!built.ok) {
    return report(
      built.code === "AI_BUDGET_LIMITED" ? "AI_BUDGET_LIMITED" : built.code === "AI_INPUT_INVALID" ? "AI_INPUT_INVALID" : "AI_INTERNAL",
      built.message
    );
  }
  // B — kích thước đo bằng UTF-8 bytes trên payload CUỐI (đã gồm payload_hash).
  const payloadBytes = utf8ByteLength(built.payload);

  // 2. Policy gate cho từng attempt (không gọi provider khi không đạt hoặc không đọc được policy context).
  const policyContext = await deps.policy.contextFor(job);
  if (!policyContext || policyContext.ok !== true) {
    return report("AI_POLICY_REQUIRED", "không đọc được policy context (DB/RPC lỗi) — fail closed");
  }
  /**
   * A (R4) — WORKER/ATTEMPT policy: chỉ attempts + token budget + payload ceiling + provider config.
   * KHÔNG kiểm queue-depth ở đây (queue đầy không được làm worker tự requeue).
   */
  const policyDecision = evaluateAttemptPolicy({
    config: deps.policy.config,
    context: { ...policyContext.value, now_ms: now, attempts: claimed.attempt },
    payload_bytes: payloadBytes,
  });
  if (!policyDecision.ok) {
    const retryablePolicy = policyDecision.code === "AI_RATE_LIMITED" || policyDecision.code === "AI_CONCURRENCY_LIMITED";
    return failWith({
      error_code: policyDecision.code,
      message: policyDecision.message,
      next_status: retryablePolicy ? "queued" : "failed_budget",
      next_attempt_at: retryablePolicy ? new Date(now + 60000).toISOString() : null,
    });
  }

  /**
   * D — Job đã ĐÓNG BĂNG provider/model/adapter/prompt. Worker phải đối chiếu trước khi gọi provider;
   * mismatch ⇒ dừng (không gọi provider, không usage/revision). W04A sẽ bổ sung provider_config_id/version.
   */
  if (job.provider_key !== deps.provider.provider_key || job.model_key !== deps.provider.model_key) {
    return report("AI_CONFIG_REQUIRED", "provider/model của job không khớp cấu hình hiện tại");
  }
  if (job.prompt_version !== deps.manifest.prompt_version) {
    return report("AI_CONFIG_REQUIRED", "prompt version của job không khớp manifest hiện tại");
  }

  // 3. Adapter (scripted trong W04; live ⇒ AI_PROVIDER_DISABLED).
  // DI seam cho test: mặc định resolve từ registry (chỉ scripted), test có thể inject adapter đếm call.
  const resolveAdapter = typeof deps.adapterFactory === "function" ? deps.adapterFactory : resolveProviderAdapter;
  const resolved = resolveAdapter({ provider_key: deps.provider.provider_key, config: deps.provider.config });
  if (!resolved.ok) return report(resolved.code, resolved.message);
  if (job.adapter_version !== resolved.adapter.adapter_version) {
    return report("AI_PROVIDER_DISABLED", "adapter version của job không khớp adapter hiện tại");
  }

  /**
   * F — Fencing TRƯỚC provider call: markStage phải thành công.
   * AI_LEASE_LOST ⇒ dừng ngay (không provider/usage/revision, không ghi fail vì lease đã mất).
   */
  const stage = await deps.queue.markStage({ job_id: job.job_id, lease_token: claimed.lease_token, status: "ai_generating", now_ms: now });
  if (!stage || stage.ok !== true) {
    if (stage && stage.code === "AI_LEASE_LOST") {
      return { kind: "lease_lost", job_id: job.job_id, status: null, error_code: null, revision_id: null, attempts: claimed.attempt, next_attempt_at: null };
    }
    return report("AI_INTERNAL", "không chuyển được job sang ai_generating (queue transition thất bại)");
  }

  const timeout = deps.timeout.create(deps.policy.config.provider_timeout_ms);
  let providerResult;
  try {
    providerResult = await resolved.adapter.generateStructured({
      payload: built.payload,
      promptManifest: deps.manifest,
      modelConfig: {
        provider_key: deps.provider.provider_key,
        model_key: deps.provider.model_key,
        adapter_version: resolved.adapter.adapter_version,
        timeout_ms: deps.policy.config.provider_timeout_ms,
      },
      timeoutSignal: timeout.signal,
    });
  } finally {
    timeout.cancel();
  }

  const usageBase = {
    job_id: job.job_id,
    logical_call_id: job.job_id + ":" + claimed.attempt,
    // Usage ghi ĐÚNG provider/model đã đóng băng trong job (không lấy cấu hình runtime).
    provider_key: job.provider_key,
    model_key: job.model_key,
    provider_version: providerResult.provider_version,
    latency_ms: providerResult.latency_ms,
    input_tokens: providerResult.ok ? providerResult.usage.input_tokens : null,
    output_tokens: providerResult.ok ? providerResult.usage.output_tokens : null,
    call_outcome: providerResult.ok ? "ok" : providerResult.error_code,
    retry_count: claimed.attempt - 1,
  };

  if (!providerResult.ok) {
    // Usage vẫn được ghi (logical) nhưng KHÔNG tạo revision.
    await deps.queue.recordUsage({ ...usageBase, cache_hit: false });
    return report(providerResult.error_code, "provider trả lỗi " + providerResult.error_code);
  }

  const parsed = parseStructured(providerResult);
  if (!parsed.ok) {
    await deps.queue.recordUsage({ ...usageBase, call_outcome: parsed.code });
    return report(parsed.code, parsed.message);
  }

  // 4. Validate + grounding (+ enforcement W04).
  const validated = validateGeneratedAnalysis(parsed.value, job.packet);
  if (!validated.ok) {
    await deps.queue.recordUsage({ ...usageBase, call_outcome: "validation_failed" });
    return report("AI_VALIDATION_FAILED", validated.code + " @ " + (validated.path ?? "analysis"));
  }

  // 5. Complete chỉ bằng lease owner/token hiện hành (fencing).
  const completed = await deps.queue.complete({
    job_id: job.job_id,
    lease_token: claimed.lease_token,
    analysis: validated.value,
    usage: { ...usageBase, cache_hit: false },
    now_ms: now,
  });

  if (!completed.ok && completed.code === "AI_LEASE_LOST") {
    // Worker khác đã chiếm lease (stale) — KHÔNG ghi đè draft/revision hợp lệ.
    return { kind: "lease_lost", job_id: job.job_id, status: "queued", error_code: null, revision_id: null, attempts: claimed.attempt, next_attempt_at: null };
  }
  if (!completed.ok) return report(completed.code ?? "AI_INTERNAL", completed.message ?? "complete thất bại");

  // B (R3): audit `job_completed` do tầng DB ghi DUY NHẤT MỘT LẦN khi tạo revision;
  // complete idempotent (already_completed) không sinh thêm event.
  return {
    kind: "completed",
    job_id: job.job_id,
    status: "draft",
    error_code: null,
    revision_id: completed.revision_id,
    attempts: claimed.attempt,
    next_attempt_at: null,
  };
}

/** Chạy tối đa `limit` job (bounded worker). Trả mảng kết quả. */
export async function runWorkerBatch({ deps, worker_ref, now_ms, limit = 1 }) {
  const results = [];
  for (let i = 0; i < limit; i++) {
    const result = await runOneJob({ deps, worker_ref, now_ms });
    results.push(result);
    // Hết slot provider ⇒ dừng batch (không thử job khác khi không còn slot).
    if (result.kind === "idle" || result.kind === "deferred") break;
  }
  return results;
}
