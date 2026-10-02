/**
 * P1.5-W04-R4/R5 — Projection CHẶT cho response RPC (fail-closed).
 *
 * RPC trả success nhưng thiếu field / sai kiểu ⇒ KHÔNG được fallback []/0; phải trả lỗi sanitized
 * để caller fail-closed (0 packet load, 0 provider call).
 *
 * R5 — ĐÓNG projection:
 * - claim: CHỈ `null` hoặc `{ok:false, code:"AI_IDLE"}` mới là idle; `undefined`/object rỗng/malformed
 *   success ⇒ `AI_INTERNAL`.
 * - claim: `job.attempts` và `attempt` phải là integer >= 1, `attempt === job.attempts`,
 *   `attempt <= job.max_attempts`; mâu thuẫn ⇒ fail-closed.
 * - enqueue: `reused`/`cache_hit` bắt buộc boolean; không đồng thời true; `cache_hit` cần `revision_id`;
 *   `status` phải thuộc tập trạng thái RPC enqueue thực sự trả được.
 * - complete: `already_completed` bắt buộc boolean thật (không mặc định false) + `revision_id` bắt buộc.
 * - recoverStale: `recovered` bắt buộc integer >= 0 (không fallback 0).
 */

function isInt(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function isUuidLike(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function internal(message) {
  return { ok: false, code: "AI_INTERNAL", message };
}

/** Trạng thái mà `ai_report_enqueue` thực sự có thể trả (job mới, job đang hoạt động, hoặc draft khi cache hit). */
export const ENQUEUE_STATUSES = Object.freeze(["requested", "queued", "computing", "ai_generating", "validating", "draft"]);

/**
 * Policy context: bắt buộc recent_requests (mảng số), queued_jobs, inflight_jobs, tokens_used_today (int >= 0).
 * @returns {{ ok:true, value:{recent_requests:number[], queued_jobs:number, inflight_jobs:number, active_jobs:number, tokens_used_today:number} }
 *   | { ok:false, code:"AI_POLICY_REQUIRED", message:string }}
 */
export function projectPolicyContext(raw) {
  const fail = (message) => ({ ok: false, code: "AI_POLICY_REQUIRED", message });
  if (!raw || typeof raw !== "object") return fail("policy context rỗng hoặc sai kiểu");
  const { recent_requests: recent, queued_jobs: queued, inflight_jobs: inflight, tokens_used_today: tokens } = raw;
  if (!Array.isArray(recent)) return fail("policy context thiếu recent_requests");
  if (!recent.every((value) => typeof value === "number" && Number.isFinite(value))) {
    return fail("recent_requests phải là mảng số hữu hạn");
  }
  if (!isInt(queued)) return fail("policy context thiếu/sai queued_jobs");
  if (!isInt(inflight)) return fail("policy context thiếu/sai inflight_jobs");
  if (!isInt(tokens)) return fail("policy context thiếu/sai tokens_used_today");
  return {
    ok: true,
    value: {
      recent_requests: [...recent],
      queued_jobs: queued,
      inflight_jobs: inflight,
      active_jobs: queued + inflight,
      tokens_used_today: tokens,
    },
  };
}

/**
 * Claim response: `null` | `{ok:false, code:"AI_IDLE"}` (idle) | `{ok:false, code}` (lỗi/không slot) | claim đã validate.
 *
 * R5: `undefined`, object rỗng, `ok` không phải boolean, hoặc success thiếu field ⇒ `AI_INTERNAL`.
 * @returns {null | { ok:false, code:string, message:string }
 *   | { job:object, lease_token:string, attempt:number }}
 */
export function projectClaim(raw) {
  // Idle HỢP LỆ chỉ có đúng hai dạng tường minh.
  if (raw === null) return null;
  if (typeof raw !== "object") return internal("claim response sai kiểu hoặc rỗng");
  if (Array.isArray(raw)) return internal("claim response sai kiểu hoặc rỗng");
  const code = isNonEmptyString(raw.code) ? raw.code : null;
  if (raw.ok === false) {
    if (code === "AI_IDLE") return null;
    if (code === null) return internal("claim thất bại nhưng thiếu code");
    return { ok: false, code, message: isNonEmptyString(raw.message) ? raw.message : "claim thất bại" };
  }
  if (raw.ok !== true) return internal("claim response thiếu ok=true/false tường minh");

  const job = raw.job;
  if (!job || typeof job !== "object" || Array.isArray(job)) return internal("claim thiếu job");
  if (!isNonEmptyString(job.job_id)) return internal("claim thiếu job_id");
  if (!isNonEmptyString(job.status)) return internal("claim thiếu status");
  if (!isInt(job.attempts) || job.attempts < 1) return internal("claim attempts phải là integer >= 1");
  if (!isInt(job.max_attempts) || job.max_attempts < 1) return internal("claim thiếu max_attempts");
  if (!isUuidLike(raw.lease_token)) return internal("claim thiếu lease_token");
  if (!isInt(raw.attempt) || raw.attempt < 1) return internal("claim attempt phải là integer >= 1");
  // R5: attempt trong response phải khớp số lần thử của job và không vượt trần.
  if (raw.attempt !== job.attempts) return internal("claim attempt không khớp job.attempts");
  if (raw.attempt > job.max_attempts) return internal("claim attempt vượt job.max_attempts");
  for (const field of ["provider_key", "model_key", "adapter_version", "prompt_version"]) {
    if (!isNonEmptyString(job[field])) return internal("claim thiếu " + field + " đã đóng băng");
  }
  if (!job.packet || typeof job.packet !== "object" || Array.isArray(job.packet)) return internal("claim thiếu packet");
  return {
    job: {
      job_id: job.job_id,
      identity_hash: job.identity_hash,
      status: job.status,
      attempts: job.attempts,
      max_attempts: job.max_attempts,
      provider_key: job.provider_key,
      model_key: job.model_key,
      adapter_version: job.adapter_version,
      prompt_version: job.prompt_version,
      packet: job.packet,
    },
    lease_token: raw.lease_token,
    attempt: raw.attempt,
  };
}

/**
 * Enqueue response: `job_id` + `status` thuộc tập hợp lệ + `reused`/`cache_hit` boolean tường minh.
 * `cache_hit=true` bắt buộc có `revision_id` non-empty; `reused` và `cache_hit` không được cùng true.
 * @returns {{ ok:true, job_id:string, status:string, reused:boolean, cache_hit:boolean, revision_id:string|null }
 *   | { ok:false, code:"AI_INTERNAL", message:string }}
 */
export function projectEnqueue(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return internal("enqueue response sai kiểu");
  // Thất bại đã sanitize ở tầng RPC: giữ nguyên code, thiếu code ⇒ AI_INTERNAL (không suy diễn).
  if (raw.ok === false) {
    if (!isNonEmptyString(raw.code)) return internal("enqueue thất bại nhưng thiếu code");
    return { ok: false, code: raw.code, message: isNonEmptyString(raw.message) ? raw.message : "enqueue thất bại" };
  }
  if (!isNonEmptyString(raw.job_id)) return internal("enqueue thiếu job_id");
  if (!isNonEmptyString(raw.status) || !ENQUEUE_STATUSES.includes(raw.status)) return internal("enqueue status không hợp lệ");
  if (typeof raw.reused !== "boolean") return internal("enqueue thiếu/sai kiểu reused");
  if (typeof raw.cache_hit !== "boolean") return internal("enqueue thiếu/sai kiểu cache_hit");
  if (raw.reused === true && raw.cache_hit === true) return internal("enqueue không thể vừa reused vừa cache_hit");
  const hasRevision = isNonEmptyString(raw.revision_id);
  if (raw.revision_id !== null && raw.revision_id !== undefined && !hasRevision) {
    return internal("enqueue revision_id sai kiểu");
  }
  if (raw.cache_hit === true && !hasRevision) return internal("enqueue cache_hit thiếu revision_id");
  return {
    ok: true,
    job_id: raw.job_id,
    status: raw.status,
    reused: raw.reused,
    cache_hit: raw.cache_hit,
    revision_id: hasRevision ? raw.revision_id : null,
  };
}

/**
 * Complete response: `revision_id` bắt buộc + `already_completed` phải là boolean thật.
 * @returns {{ ok:true, revision_id:string, already_completed:boolean } | { ok:false, code:"AI_INTERNAL", message:string }}
 */
export function projectComplete(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return internal("complete response sai kiểu");
  // Thất bại đã sanitize (AI_LEASE_LOST / AI_JOB_NOT_FOUND…): giữ nguyên code cho worker phân loại.
  if (raw.ok === false) {
    if (!isNonEmptyString(raw.code)) return internal("complete thất bại nhưng thiếu code");
    return { ok: false, code: raw.code, message: isNonEmptyString(raw.message) ? raw.message : "complete thất bại" };
  }
  if (typeof raw.already_completed !== "boolean") return internal("complete thiếu/sai kiểu already_completed");
  if (!isNonEmptyString(raw.revision_id)) {
    return internal(raw.already_completed ? "complete idempotent thiếu revision_id" : "complete thiếu revision_id");
  }
  return { ok: true, revision_id: raw.revision_id, already_completed: raw.already_completed };
}

/**
 * RecoverStale response: `recovered` bắt buộc integer >= 0 (không được fallback 0).
 * @returns {{ ok:true, recovered:number } | { ok:false, code:string, message:string }}
 */
export function projectRecoverStale(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return internal("recoverStale response sai kiểu");
  if (raw.ok !== true) {
    const code = isNonEmptyString(raw.code) ? raw.code : "AI_INTERNAL";
    return { ok: false, code, message: isNonEmptyString(raw.message) ? raw.message : "recoverStale thất bại" };
  }
  if (!isInt(raw.recovered)) return internal("recoverStale thiếu/sai kiểu recovered");
  return { ok: true, recovered: raw.recovered };
}
