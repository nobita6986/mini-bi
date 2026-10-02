import "server-only";

/**
 * P1.5-W04 — Repository cho durable job (Supabase RPC, service-role).
 *
 * DB queue là AUTHORITY: mọi thao tác claim/lease/fencing/idempotency nằm trong RPC SQL,
 * module này chỉ gọi và chuẩn hoá kết quả. Không log payload/packet/analysis.
 */

import { createServiceSupabaseClient } from "@/lib/supabase/server";

import { projectPolicyContext } from "../rpc-projection.mjs";

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
        // W04A: đóng băng provider config vào job (RPC từ chối nếu config chưa active/verified).
        p_provider_config_id: request.provider_config_id,
        p_provider_config_version: request.provider_config_version,
      });
      if (!result.ok) return result;
      // R5: trả raw — consumer (run-one-job) project chặt ⇒ parity với memory queue/test double.
      return result.value;
    },

    async claim({ worker_ref, lease_seconds, max_concurrent_jobs }) {
      // R3: trần concurrency provider được enforce TRONG RPC (atomic, advisory lock).
      const result = await rpc("ai_report_claim", {
        p_worker: worker_ref,
        p_lease_seconds: lease_seconds,
        p_max_concurrent_jobs: Number.isInteger(max_concurrent_jobs) ? max_concurrent_jobs : null,
      });
      // R2 (E): CHỈ AI_IDLE mới là idle; mọi lỗi DB/RPC khác phải nổi lên thành worker error.
      if (!result.ok) {
        if (result.code === "AI_IDLE") return null;
        if (result.code === "AI_CONCURRENCY_LIMITED") {
          return { ok: false, code: "AI_CONCURRENCY_LIMITED", message: "không còn slot provider" };
        }
        return { ok: false, code: result.code ?? "AI_INTERNAL", message: result.message ?? "claim thất bại" };
      }
      // R4: worker tự validate claim shape (projectClaim) ⇒ parity giữa DB thật và test double.
      return result.value;
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
      // R5: trả raw — consumer project chặt (already_completed/revision_id).
      return result.value;
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
      // R4 (C): KHÔNG fallback []/0 — response malformed ⇒ AI_POLICY_REQUIRED (fail closed).
      return projectPolicyContext(result.value);
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
      if (!result.ok) return result;
      // R5: KHÔNG fallback recovered=0 — trả raw để consumer project fail-closed.
      return result.value;
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
