import "server-only";

/**
 * P1.5-W04 — Repository cho durable job (Supabase RPC, service-role).
 *
 * DB queue là AUTHORITY: mọi thao tác claim/lease/fencing/idempotency nằm trong RPC SQL,
 * module này chỉ gọi và chuẩn hoá kết quả. Không log payload/packet/analysis.
 */

import { createServiceSupabaseClient } from "@/lib/supabase/server";

function fail(code, message) {
  return { ok: false, code, message };
}

async function rpc(name, params) {
  const client = createServiceSupabaseClient();
  const { data, error } = await client.rpc(name, params);
  if (error) {
    // Không bao giờ trả raw provider/db error ra ngoài.
    return { ok: false, code: "AI_INTERNAL", message: "rpc " + name + " thất bại" };
  }
  if (!data || typeof data !== "object") return fail("AI_INTERNAL", "rpc " + name + " trả dữ liệu rỗng");
  if (data.ok === false) return fail(data.code ?? "AI_INTERNAL", data.message ?? "rpc " + name + " từ chối");
  return { ok: true, value: data };
}

export function createSupabaseJobRepository() {
  return {
    async enqueueOrReuse({ identity_hash, identity_components, request }) {
      const result = await rpc("ai_report_enqueue", {
        p_identity_hash: identity_hash,
        p_identity_components: identity_components,
        p_request: request.db_request,
        p_actor_ref: request.actor_ref,
        p_access_scope_hash: request.access_scope_hash,
        p_snapshot_hash: request.snapshot_hash,
        p_lineage_ref: request.lineage_ref,
        p_packet: request.packet,
        p_packet_hash: request.packet_hash,
        p_packet_contract_version: request.packet_contract_version,
        p_output_contract_version: request.output_contract_version,
        p_prompt_version: request.prompt_version,
        p_provider_key: request.provider_key,
        p_model_key: request.model_key,
        p_adapter_version: request.adapter_version,
        p_max_attempts: request.max_attempts,
      });
      if (!result.ok) return result;
      return {
        ok: true,
        job_id: result.value.job_id,
        status: result.value.status,
        reused: result.value.reused === true,
        cache_hit: result.value.cache_hit === true,
        revision_id: result.value.revision_id ?? null,
      };
    },

    async claim({ worker_ref, lease_seconds }) {
      const result = await rpc("ai_report_claim", { p_worker: worker_ref, p_lease_seconds: lease_seconds });
      // R2 (E): CHỈ AI_IDLE mới là idle; mọi lỗi DB/RPC khác phải nổi lên thành worker error.
      if (!result.ok) {
        if (result.code === "AI_IDLE") return null;
        return { ok: false, code: result.code ?? "AI_INTERNAL", message: result.message ?? "claim thất bại" };
      }
      const job = result.value.job;
      if (!job) return { ok: false, code: "AI_INTERNAL", message: "claim trả job rỗng" };
      return {
        job: {
          job_id: job.job_id,
          identity_hash: job.identity_hash,
          status: job.status,
          attempts: job.attempts,
          max_attempts: job.max_attempts,
          // R2 (D): field đã đóng băng trong row — worker phải đối chiếu trước khi gọi provider.
          provider_key: job.provider_key,
          model_key: job.model_key,
          adapter_version: job.adapter_version,
          prompt_version: job.prompt_version,
          packet: job.packet,
        },
        lease_token: result.value.lease_token,
        attempt: result.value.attempt,
      };
    },

    async markStage({ job_id, lease_token, status }) {
      const result = await rpc("ai_report_mark_stage", { p_job_id: job_id, p_lease_token: lease_token, p_status: status });
      return result.ok ? { ok: true } : result;
    },

    async complete({ job_id, lease_token, analysis, usage }) {
      const result = await rpc("ai_report_complete", {
        p_job_id: job_id,
        p_lease_token: lease_token,
        p_analysis: analysis,
        p_usage: usage,
      });
      if (!result.ok) return result;
      return { ok: true, revision_id: result.value.revision_id, already_completed: result.value.already_completed === true };
    },

    async fail({ job_id, lease_token, error_code, next_status, next_attempt_at, message }) {
      const result = await rpc("ai_report_fail", {
        p_job_id: job_id,
        p_lease_token: lease_token,
        p_error_code: error_code,
        p_next_status: next_status,
        p_next_attempt_at: next_attempt_at,
        p_message: typeof message === "string" ? message.slice(0, 500) : null,
      });
      return result.ok ? { ok: true } : result;
    },

    async recordUsage(usage) {
      const result = await rpc("ai_report_record_usage", { p_usage: usage });
      return result.ok ? { ok: true, inserted: result.value.inserted === true } : result;
    },

    /**
     * Policy context: RPC lỗi ⇒ FAIL-CLOSED (R1). Không bao giờ biến lỗi DB thành quota 0
     * (quota 0 sẽ cho phép vượt rate/concurrency/token ceiling một cách âm thầm).
     */
    async policyContext({ actor_ref, window_seconds }) {
      const result = await rpc("ai_report_policy_context", { p_actor_ref: actor_ref, p_window_seconds: window_seconds });
      if (!result.ok) {
        return { ok: false, code: "AI_POLICY_REQUIRED", message: "không đọc được policy context (DB/RPC lỗi)" };
      }
      return {
        ok: true,
        value: {
          recent_requests: Array.isArray(result.value.recent_requests) ? result.value.recent_requests : [],
          active_jobs: Number.isInteger(result.value.active_jobs) ? result.value.active_jobs : 0,
          tokens_used_today: Number.isFinite(result.value.tokens_used_today) ? result.value.tokens_used_today : 0,
        },
      };
    },

    async status(job_id) {
      const result = await rpc("ai_report_status", { p_job_id: job_id });
      return result.ok ? { ok: true, value: result.value } : result;
    },

    async regenerate({ job_id, actor_ref, reason }) {
      const result = await rpc("ai_report_regenerate", { p_job_id: job_id, p_actor_ref: actor_ref, p_reason: reason });
      return result.ok ? { ok: true, value: result.value } : result;
    },

    async recoverStale({ lease_seconds }) {
      const result = await rpc("ai_report_recover_stale", { p_lease_seconds: lease_seconds });
      return result.ok ? { ok: true, recovered: result.value.recovered ?? 0 } : result;
    },
  };
}

/** Audit append-only qua bảng (chỉ insert; revoke update/delete ở migration). */
export function createSupabaseAuditSink() {
  return {
    async append({ job_id, event_type, actor_ref, reason, payload }) {
      const client = createServiceSupabaseClient();
      const { error } = await client.from("ai_report_audit_events").insert({
        job_id,
        event_type,
        actor_ref,
        reason: typeof reason === "string" ? reason.slice(0, 300) : null,
        payload: payload ?? null,
      });
      if (error) return fail("AI_INTERNAL", "ghi audit thất bại");
      return { ok: true };
    },
  };
}
