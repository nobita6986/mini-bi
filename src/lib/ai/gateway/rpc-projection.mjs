/**
 * P1.5-W04-R4 — Projection CHẶT cho response RPC (fail-closed).
 *
 * RPC trả success nhưng thiếu field / sai kiểu ⇒ KHÔNG được fallback []/0; phải trả lỗi sanitized
 * để caller fail-closed (0 packet load, 0 provider call).
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
 * Claim response: null (idle) | { ok:false, code } (lỗi/không có slot) | claim đã validate.
 * Kiểm tối thiểu: job, attempt, lease_token và provider/model/adapter/prompt đã đóng băng.
 */
export function projectClaim(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object") return { ok: false, code: "AI_INTERNAL", message: "claim response sai kiểu" };
  const code = typeof raw.code === "string" ? raw.code : null;
  if (raw.ok === false) {
    if (code === "AI_IDLE") return null;
    return { ok: false, code: code ?? "AI_INTERNAL", message: "claim thất bại" };
  }
  const job = raw.job;
  if (!job || typeof job !== "object") return { ok: false, code: "AI_INTERNAL", message: "claim thiếu job" };
  if (!isNonEmptyString(job.job_id)) return { ok: false, code: "AI_INTERNAL", message: "claim thiếu job_id" };
  if (!isInt(job.attempts)) return { ok: false, code: "AI_INTERNAL", message: "claim thiếu attempts" };
  if (!isInt(job.max_attempts) || job.max_attempts < 1) return { ok: false, code: "AI_INTERNAL", message: "claim thiếu max_attempts" };
  if (!isUuidLike(raw.lease_token)) return { ok: false, code: "AI_INTERNAL", message: "claim thiếu lease_token" };
  if (!isInt(raw.attempt) || raw.attempt < 1) return { ok: false, code: "AI_INTERNAL", message: "claim thiếu attempt" };
  for (const field of ["provider_key", "model_key", "adapter_version", "prompt_version"]) {
    if (!isNonEmptyString(job[field])) return { ok: false, code: "AI_INTERNAL", message: "claim thiếu " + field + " đã đóng băng" };
  }
  if (!job.packet || typeof job.packet !== "object") return { ok: false, code: "AI_INTERNAL", message: "claim thiếu packet" };
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

/** Enqueue response: bắt buộc job_id/status/reused/cache_hit đúng kiểu. */
export function projectEnqueue(raw) {
  if (!raw || typeof raw !== "object") return { ok: false, code: "AI_INTERNAL", message: "enqueue response sai kiểu" };
  if (!isNonEmptyString(raw.job_id)) return { ok: false, code: "AI_INTERNAL", message: "enqueue thiếu job_id" };
  if (!isNonEmptyString(raw.status)) return { ok: false, code: "AI_INTERNAL", message: "enqueue thiếu status" };
  return {
    ok: true,
    job_id: raw.job_id,
    status: raw.status,
    reused: raw.reused === true,
    cache_hit: raw.cache_hit === true,
    revision_id: isNonEmptyString(raw.revision_id) ? raw.revision_id : null,
  };
}

/** Complete response: bắt buộc revision_id khi tạo revision. */
export function projectComplete(raw) {
  if (!raw || typeof raw !== "object") return { ok: false, code: "AI_INTERNAL", message: "complete response sai kiểu" };
  const already = raw.already_completed === true;
  if (!isNonEmptyString(raw.revision_id)) {
    return { ok: false, code: "AI_INTERNAL", message: already ? "complete idempotent thiếu revision_id" : "complete thiếu revision_id" };
  }
  return { ok: true, revision_id: raw.revision_id, already_completed: already };
}
