import "server-only";

/**
 * P1.5-W05-S02 — Server boundary cho review (approve/reject) + durable history.
 * Chỉ gọi RPC hẹp (service_role); projection thuần ở review-projection.
 * KHÔNG trả packet/prompt/raw provider output/secret.
 */

import { createServiceSupabaseClient } from "@/lib/supabase/server";

import { projectHistoryResponse, projectReviewResponse } from "@/lib/ai-report/review-projection";

function fail(code, message) {
  return { ok: false, code, message };
}

function sanitize(message, fallback) {
  const text = typeof message === "string" ? message.replace(/[\u0000-\u001f\u007f]/g, " ").trim() : "";
  return text === "" ? fallback : text.slice(0, 200);
}

async function rpc(name, params) {
  let response;
  try {
    const client = createServiceSupabaseClient();
    response = await client.rpc(name, params);
  } catch {
    return fail("AI_INTERNAL", "rpc " + name + " không gọi được");
  }
  const { data, error } = response ?? {};
  if (error) return fail("AI_INTERNAL", "rpc " + name + " thất bại");
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return fail("AI_INTERNAL", "rpc " + name + " trả dữ liệu rỗng/sai kiểu");
  }
  if (data.ok === false) {
    return fail(typeof data.code === "string" && data.code !== "" ? data.code : "AI_INTERNAL", sanitize(data.message, "rpc " + name + " từ chối"));
  }
  return { ok: true, value: data };
}

export function createServerAiReviewService() {
  return {
    /** Fail-closed: RPC chưa tồn tại (migration chưa apply) ⇒ approve/reject = false. */
    async capability() {
      const result = await rpc("ai_report_review_capability", {});
      if (!result.ok) {
        return { approve: false, reject: false, regenerate: true };
      }
      const value = result.value;
      return {
        approve: value.approve === true,
        reject: value.reject === true,
        regenerate: value.regenerate !== false,
      };
    },

    async approve({ job_id, expected_revision_number, actor_ref }) {
      const result = await rpc("ai_report_approve_revision", {
        p_job_id: job_id,
        p_expected_revision_number: expected_revision_number,
        p_actor_ref: actor_ref,
      });
      if (!result.ok) return result;
      return projectReviewResponse(result.value);
    },

    async reject({ job_id, expected_revision_number, actor_ref, reason }) {
      const result = await rpc("ai_report_reject_revision", {
        p_job_id: job_id,
        p_expected_revision_number: expected_revision_number,
        p_actor_ref: actor_ref,
        p_reason: reason,
      });
      if (!result.ok) return result;
      return projectReviewResponse(result.value);
    },

    async history({ actor_ref, cursor, page_size }) {
      const result = await rpc("ai_report_history", {
        p_actor_ref: actor_ref,
        p_cursor: cursor ?? null,
        p_page_size: page_size,
      });
      if (!result.ok) return result;
      return projectHistoryResponse(result.value);
    },
  };
}
