/**
 * P1.5-W04 — Service core (DI, testable): normalize request → frozen packet → policy → enqueue →
 * status → bounded worker. Không DB/secret ở đây; wiring nằm ở `server/service.mjs`.
 */

import { canonicalHash } from "../engine-shared.mjs";
import { validateAnalysisPacket } from "../../analytics/contracts/analysis-packet.ts";
import { validateAnalyticsRequest } from "../feature-engine.ts";
import { buildJobIdentity } from "./job-identity.mjs";
import { enqueueReport, runWorkerBatch } from "./run-one-job.mjs";
import { evaluatePolicy } from "./policy.mjs";
import { responseCeilingOf } from "./policy.mjs";
import { LEASE_SECONDS, WORKER_BATCH_LIMIT } from "./limits.mjs";

export const MAX_FOCUS_LENGTH = 120;
export const MAX_REASON_LENGTH = 300;

function fail(code, message) {
  return { ok: false, code, message };
}

/** Chuẩn hoá phần request do người dùng gửi (KHÔNG nhận prompt tự do). */
export function normalizeReportRequest(input) {
  const normalized = validateAnalyticsRequest({ period: input?.period, scope: input?.scope });
  if (!normalized.ok) return { ok: false, code: "AI_INPUT_INVALID", message: normalized.message };
  const focusRaw = input?.focus;
  if (focusRaw !== undefined && focusRaw !== null && typeof focusRaw !== "string") {
    return fail("AI_INPUT_INVALID", "focus phải là chuỗi");
  }
  const focus = typeof focusRaw === "string" ? focusRaw.normalize("NFC").replace(/\s+/g, " ").trim() : "";
  if (focus.length > MAX_FOCUS_LENGTH) return fail("AI_INPUT_INVALID", "focus quá dài");
  if (/[<>]|\{\{|\$\{/.test(focus)) return fail("AI_INPUT_INVALID", "focus chứa ký tự không hợp lệ");
  const reasonRaw = input?.reason;
  if (reasonRaw !== undefined && reasonRaw !== null && typeof reasonRaw !== "string") {
    return fail("AI_INPUT_INVALID", "reason phải là chuỗi");
  }
  const reason = typeof reasonRaw === "string" ? reasonRaw.normalize("NFC").replace(/\s+/g, " ").trim() : "";
  if (reason.length > MAX_REASON_LENGTH) return fail("AI_INPUT_INVALID", "reason quá dài");
  const regenerateOf = input?.regenerate_of ?? null;
  if (regenerateOf !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(regenerateOf))) {
    return fail("AI_INPUT_INVALID", "regenerate_of không phải UUID");
  }
  if (regenerateOf !== null && (reason.length < 3 || reason.length > MAX_REASON_LENGTH)) {
    return fail("AI_INPUT_INVALID", "regenerate cần reason tối thiểu 3 ký tự");
  }
  return {
    ok: true,
    value: {
      period: normalized.value.period,
      scope: normalized.value.scope,
      focus: focus === "" ? null : focus,
      reason: reason === "" ? null : reason,
      regenerate_of: regenerateOf,
    },
  };
}

/** Comparison mode deterministic từ packet (dùng cho identity). */
export function comparisonModeOf(packet) {
  if (packet.totals.comparable !== null) {
    return packet.period.status === "period_to_date" ? "period_to_date_equal_window" : "previous_period";
  }
  return "unavailable";
}

export function createAiReportService(deps) {
  const clock = deps.clock;
  const maxAttempts = deps.policy.config.max_attempts;

  function identityFor({ packet, request, access_scope_hash, provider_key, model_key, adapter_version }) {
    return {
      build() {
        return buildJobIdentity({
          period: {
            period_ref: packet.period.period_ref,
            type: packet.period.type,
            start: packet.period.start,
            end: packet.period.end,
            status: packet.period.status,
            elapsed_days: packet.period.elapsed_days,
          },
          scope: {
            dimensions: [...packet.scope.dimensions],
            filters: {
              project_keys: request.scope.filters.project_keys,
              recruiter_keys: request.scope.filters.recruiter_keys,
              provider_type_keys: request.scope.filters.provider_type_keys,
              employment_type_keys: request.scope.filters.employment_type_keys,
            },
            focus: request.focus,
          },
          comparison_mode: comparisonModeOf(packet),
          access_scope_hash,
          snapshot_hash: packet.snapshot.hash,
          packet_contract_version: packet.contract_version,
          output_contract_version: deps.manifest.compatible_output_contract,
          prompt_version: deps.manifest.prompt_version,
          provider_key,
          model_key,
          adapter_version,
        });
      },
    };
  }

  return {
    /** Enqueue (idempotent). Trả nhanh; KHÔNG chờ provider. */
    async enqueueReport({ input, actor_ref, access_scope_hash, provider_key, model_key, adapter_version, now_ms }) {
      const now = Number.isFinite(now_ms) ? now_ms : clock.nowMs();
      const normalized = normalizeReportRequest(input);
      if (!normalized.ok) return normalized;
      const request = normalized.value;

      /**
       * A — Provider gate (R1): production/preview không bao giờ được dùng scripted; thiếu live config đã duyệt
       * ⇒ fail TRƯỚC packet loader/DB enqueue/provider. Test/dev truyền providerGate ok (hoặc inject adapter trực tiếp).
       */
      if (deps.providerGate && deps.providerGate.ok !== true) {
        return fail(deps.providerGate.code ?? "AI_CONFIG_REQUIRED", deps.providerGate.message ?? "provider chưa sẵn sàng");
      }

      // Policy TRƯỚC khi build packet/DB usage (fail closed sớm).
      // G (R2): policyContext là BẮT BUỘC — thiếu wiring cũng là AI_POLICY_REQUIRED (không có fallback quota 0).
      if (typeof deps.queue.policyContext !== "function") {
        return fail("AI_POLICY_REQUIRED", "thiếu policyContext wiring — fail closed");
      }
      const policyContext = await deps.queue.policyContext({ actor_ref, window_seconds: deps.policy.config.window_ms / 1000 });
      // R1: không đọc được policy context ⇒ FAIL CLOSED (không biến lỗi DB thành quota 0).
      if (!policyContext || policyContext.ok !== true) {
        return fail("AI_POLICY_REQUIRED", "không đọc được policy context (DB/RPC lỗi) — fail closed");
      }
      const policyDecision = evaluatePolicy({
        config: deps.policy.config,
        context: {
          now_ms: now,
          actor_ref,
          access_scope_hash,
          recent_requests: policyContext.value.recent_requests,
          active_jobs: policyContext.value.active_jobs,
          attempts: 0,
          tokens_used_today: policyContext.value.tokens_used_today,
        },
        payload_bytes: 0,
      });
      if (!policyDecision.ok) return fail(policyDecision.code, policyDecision.message);

      /**
       * C (R2) — Regenerate chạy SAU policy: provider gate → policyContext → rate/concurrency/token/budget → regenerate.
       * Dùng frozen packet (KHÔNG reload packet); reason/audit vẫn bắt buộc ở tầng RPC.
       */
      if (request.regenerate_of !== null) {
        if (typeof deps.queue.regenerate !== "function") return fail("AI_CONFIG_REQUIRED", "queue không hỗ trợ regenerate");
        const regenerated = await deps.queue.regenerate({ job_id: request.regenerate_of, actor_ref, reason: request.reason });
        if (!regenerated.ok) return regenerated;
        return {
          ok: true,
          job_id: regenerated.value.job_id,
          status: regenerated.value.status,
          reused: false,
          cache_hit: false,
          revision_id: null,
          regenerated_from: regenerated.value.source_job_id ?? request.regenerate_of,
        };
      }

      /**
       * G — Identity capability (R1): recruiter/team breakdown chỉ hợp lệ khi runtime CÓ catalog authority
       * (P1.6). Không được im lặng trả breakdown rỗng như dữ liệu hợp lệ.
       */
      const catalogAvailable = deps.identityCatalog?.available === true;
      const wantsIdentity =
        request.scope.dimensions.includes("recruiter") ||
        request.scope.dimensions.includes("team") ||
        (request.scope.filters.recruiter_keys ?? null) !== null;
      if (wantsIdentity && !catalogAvailable) {
        return fail(
          "AI_IDENTITY_CATALOG_REQUIRED",
          "runtime chưa có identity catalog authority (P1.6); chỉ phân tích được project/provider/employment"
        );
      }

      const loaded = await deps.packetLoader({
        period: request.period,
        scope: request.scope,
        actor_ref,
        limits: {
          max_lookback_days: deps.policy.config.max_lookback_days,
          max_fact_rows: deps.policy.config.max_fact_rows,
        },
      });
      if (!loaded.ok) return fail(loaded.code ?? "AI_INPUT_INVALID", loaded.message ?? "không dựng được packet");

      const packetCheck = validateAnalysisPacket(loaded.packet);
      if (!packetCheck.ok) return fail("AI_INPUT_INVALID", "packet không hợp lệ: " + packetCheck.code);

      const result = await enqueueReport({
        deps: {
          queue: deps.queue,
          audit: deps.audit,
          policy: {
            config: deps.policy.config,
            contextFor: async () => ({ ok: true, value: { recent_requests: [], active_jobs: 0, tokens_used_today: 0 } }),
          },
          identity: identityFor({
            packet: packetCheck.value,
            request,
            access_scope_hash,
            provider_key,
            model_key,
            adapter_version,
          }),
          clock,
        },
        request: {
          actor_ref,
          access_scope_hash,
          reason: request.reason,
          db_request: {
            period: request.period,
            scope: { dimensions: request.scope.dimensions, filters: request.scope.filters },
            focus: request.focus,
          },
          snapshot_hash: packetCheck.value.snapshot.hash,
          lineage_ref: packetCheck.value.snapshot.lineage_ref,
          packet: packetCheck.value,
          packet_hash: canonicalHash({ packet: packetCheck.value }),
          packet_contract_version: packetCheck.value.contract_version,
          output_contract_version: deps.manifest.compatible_output_contract,
          prompt_version: deps.manifest.prompt_version,
          provider_key,
          model_key,
          adapter_version,
          max_attempts: maxAttempts,
        },
        context: {
          now_ms: now,
          actor_ref,
          access_scope_hash,
          recent_requests: policyContext.value.recent_requests,
          active_jobs: policyContext.value.active_jobs,
          attempts: 0,
          tokens_used_today: policyContext.value.tokens_used_today,
        },
        now_ms: now,
      });
      if (!result.ok) return result;
      return { ...result, regenerated_from: null };
    },

    async getStatus({ job_id }) {
      if (typeof job_id !== "string" || !/^[0-9a-f-]{36}$/i.test(job_id)) return fail("AI_INPUT_INVALID", "job_id không hợp lệ");
      const result = await deps.queue.status(job_id);
      if (!result.ok) return result;
      return { ok: true, status: result.value };
    },

    async runWorker({ worker_ref, limit, now_ms }) {
      const now = Number.isFinite(now_ms) ? now_ms : clock.nowMs();
      const bounded = Number.isInteger(limit) && limit > 0 ? Math.min(limit, WORKER_BATCH_LIMIT) : 1;
      // E (R2): lỗi recoverStale KHÔNG được bỏ qua.
      if (typeof deps.queue.recoverStale === "function") {
        const recovered = await deps.queue.recoverStale({ lease_seconds: LEASE_SECONDS });
        if (!recovered || recovered.ok !== true) {
          return fail(recovered?.code ?? "AI_INTERNAL", "không thu hồi được lease hết hạn (DB/RPC lỗi)");
        }
      }
      const results = await runWorkerBatch({
        deps: {
          queue: deps.queue,
          audit: deps.audit,
          policy: {
            config: deps.policy.config,
            contextFor: async () => {
              // G (R2): thiếu policyContext ⇒ AI_POLICY_REQUIRED (không có fallback quota 0).
              if (typeof deps.queue.policyContext !== "function") {
                return { ok: false, code: "AI_POLICY_REQUIRED", message: "thiếu policyContext wiring" };
              }
              const context = await deps.queue.policyContext({ actor_ref: worker_ref, window_seconds: deps.policy.config.window_ms / 1000 });
              // R1: worker cũng fail-closed khi không đọc được policy context.
              if (!context || context.ok !== true) {
                return { ok: false, code: "AI_POLICY_REQUIRED", message: "không đọc được policy context" };
              }
              return {
                ok: true,
                value: {
                  recent_requests: context.value.recent_requests,
                  active_jobs: context.value.active_jobs,
                  tokens_used_today: context.value.tokens_used_today,
                },
              };
            },
          },
          provider: deps.provider,
          manifest: deps.manifest,
          timeout: deps.timeout,
          clock,
          // R2 (D): giữ DI seam để test inject adapter đếm call; runtime không truyền ⇒ dùng registry.
          adapterFactory: deps.adapterFactory,
        },
        worker_ref,
        now_ms: now,
        limit: bounded,
      });
      // E (R2): lỗi hạ tầng queue (claim/recover) phải nổi lên, không trả về như lần chạy khỏe mạnh.
      const infrastructureError = results.find((row) => row.kind === "error");
      if (infrastructureError) {
        return {
          ok: false,
          code: infrastructureError.error_code ?? "AI_INTERNAL",
          message: "worker dừng do lỗi hạ tầng queue (DB/RPC)",
        };
      }
      return { ok: true, results };
    },
  };
}

export { responseCeilingOf };