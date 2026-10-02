/**
 * P1.5-W04 — In-memory job queue (test double) mô phỏng ĐÚNG semantics của RPC SQL:
 * enqueue-or-reuse, cache hit, claim atomic + lease/fencing, complete idempotent, usage unique
 * theo logical_call_id, audit append-only, regenerate cần reason.
 *
 * KHÔNG dùng ở production — chỉ cho test deterministic.
 */

import { isActiveStatus } from "../job-state.mjs";

/** Actor cho audit stage: ưu tiên worker đang giữ lease. */
function workerRefFor(job) {
  return job.lease_owner ?? "worker";
}

export function createMemoryQueue(options = {}) {
  const jobs = new Map();
  const revisions = new Map();
  const usage = new Map();
  const audit = [];
  const hooks = options.hooks ?? {};
  let sequence = 0;
  const uuid = () => {
    sequence += 1;
    return "00000000-0000-4000-8000-" + String(sequence).padStart(12, "0");
  };
  const iso = (ms) => new Date(ms).toISOString();

  function findActive(identityHash) {
    for (const job of jobs.values()) {
      if (job.identity_hash === identityHash && isActiveStatus(job.status)) return job;
    }
    return null;
  }

  function findLiveRevision(identityHash) {
    for (const revision of revisions.values()) {
      const job = jobs.get(revision.job_id);
      if (!job || job.identity_hash !== identityHash) continue;
      if (revision.lifecycle_status === "draft" || revision.lifecycle_status === "approved") return revision;
    }
    return null;
  }

  return {
    store: { jobs, revisions, usage, audit },
    /** Audit trail do queue ghi (mô phỏng RPC ghi audit trong DB). */

    async enqueueOrReuse({ identity_hash, identity_components, request, now_ms }) {
      // R4 (D): audit insert nằm CÙNG transaction với quyết định ⇒ insert lỗi thì RPC fail và KHÔNG tạo job.
      if (hooks.auditInsertError === true) {
        return { ok: false, code: "AI_INTERNAL", message: "audit insert lỗi (mô phỏng) — rollback toàn bộ" };
      }
      const active = findActive(identity_hash);
      if (active) {
        audit.push({ job_id: active.job_id, event_type: "job_reused", actor_ref: request.actor_ref ?? null, reason: null });
        return { ok: true, job_id: active.job_id, status: active.status, reused: true, cache_hit: false, revision_id: active.revision_id ?? null };
      }
      const live = findLiveRevision(identity_hash);
      if (live) {
        audit.push({ job_id: live.job_id, event_type: "job_cache_hit", actor_ref: request.actor_ref ?? null, reason: null });
        return { ok: true, job_id: live.job_id, status: "draft", reused: false, cache_hit: true, revision_id: live.revision_id };
      }
      const job_id = uuid();
      // Audit authority = DB: enqueue mới ghi job_enqueued (reuse/cache-hit do application ghi).
      audit.push({ job_id, event_type: "job_enqueued", actor_ref: request.actor_ref ?? null, reason: null });
      jobs.set(job_id, {
        job_id,
        identity_hash,
        identity_components,
        request,
        // R2 — job ĐÓNG BĂNG provider/model/adapter/prompt (worker phải đối chiếu trước khi gọi provider).
        provider_key: request.provider_key,
        model_key: request.model_key,
        adapter_version: request.adapter_version,
        prompt_version: request.prompt_version,
        status: "queued",
        attempts: 0,
        max_attempts: request.max_attempts,
        lease_owner: null,
        lease_token: null,
        lease_expires_at: null,
        next_attempt_at: null,
        error_code: null,
        error_message: null,
        revision_id: null,
        created_at: iso(now_ms),
        updated_at: iso(now_ms),
        completed_at: null,
      });
      return { ok: true, job_id, status: "queued", reused: false, cache_hit: false, revision_id: null };
    },

    async claim({ worker_ref, lease_seconds = 120, now_ms, max_concurrent_jobs }) {
      // R2 (E): lỗi DB/RPC claim phải nổi lên, KHÔNG giả thành idle.
      if (hooks.claimError === true) {
        return { ok: false, code: "AI_INTERNAL", message: "claim RPC lỗi (mô phỏng)" };
      }
      let recovered = 0;
      for (const job of jobs.values()) {
        if (!["computing", "ai_generating", "validating"].includes(job.status)) continue;
        // Mirror SQL claim: chỉ thu hồi khi lease ĐÃ hết hạn (lease_expires_at < now).
        if (job.lease_expires_at !== null && Date.parse(job.lease_expires_at) >= now_ms) continue;
        job.status = "queued";
        job.lease_owner = null;
        job.lease_token = null;
        job.lease_expires_at = null;
        job.next_attempt_at = iso(now_ms);
        job.updated_at = iso(now_ms);
        recovered += 1;
      }
      if (hooks.claimRecovered !== undefined) hooks.claimRecovered(recovered);

      // R3 — Concurrency authority: chỉ tính job ĐANG giữ slot provider (lease còn hiệu lực).
      const ceiling = Number.isInteger(max_concurrent_jobs) ? max_concurrent_jobs : null;
      const inflight = [...jobs.values()].filter(
        (job) =>
          ["computing", "ai_generating", "validating"].includes(job.status) &&
          job.lease_expires_at !== null &&
          Date.parse(job.lease_expires_at) > now_ms
      ).length;
      if (ceiling !== null && inflight >= ceiling) {
        return { ok: false, code: "AI_CONCURRENCY_LIMITED", message: "không còn slot provider", inflight };
      }

      const candidates = [...jobs.values()]
        .filter((job) => ["requested", "queued"].includes(job.status))
        .filter((job) => job.next_attempt_at === null || Date.parse(job.next_attempt_at) <= now_ms)
        .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
      const job = candidates[0];
      if (!job) return null;
      const token = uuid();
      job.status = "computing";
      job.attempts += 1;
      job.lease_owner = worker_ref;
      job.lease_token = token;
      job.lease_expires_at = iso(now_ms + lease_seconds * 1000);
      job.updated_at = iso(now_ms);
      audit.push({ job_id: job.job_id, event_type: "job_claimed", actor_ref: worker_ref, reason: null });
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
          packet: job.request.packet,
        },
        lease_token: token,
        attempt: job.attempts,
      };
    },

    async markStage({ job_id, lease_token, status, now_ms }) {
      // R2 (F): mô phỏng lỗi DB ở bước fencing.
      if (hooks.markStageError === true) {
        return { ok: false, code: "AI_INTERNAL", message: "markStage RPC lỗi (mô phỏng)" };
      }
      if (hooks.markStageLeaseLost === true) {
        return { ok: false, code: "AI_LEASE_LOST" };
      }
      const job = jobs.get(job_id);
      if (!job) return { ok: false, code: "AI_JOB_NOT_FOUND" };
      if (job.lease_token !== lease_token) return { ok: false, code: "AI_LEASE_LOST" };
      if (!["computing", "ai_generating", "validating"].includes(job.status)) return { ok: false, code: "AI_LEASE_LOST" };
      job.status = status;
      job.updated_at = iso(now_ms);
      audit.push({ job_id: job.job_id, event_type: "job_stage", actor_ref: workerRefFor(job), reason: status });
      return { ok: true };
    },

    async complete({ job_id, lease_token, analysis, usage: usageRow, now_ms }) {
      const job = jobs.get(job_id);
      if (!job) return { ok: false, code: "AI_JOB_NOT_FOUND" };
      if (job.status === "draft" && job.revision_id !== null) {
        return { ok: true, revision_id: job.revision_id, already_completed: true };
      }
      if (job.lease_token !== lease_token) return { ok: false, code: "AI_LEASE_LOST" };
      if (job.lease_expires_at === null || Date.parse(job.lease_expires_at) < now_ms) return { ok: false, code: "AI_LEASE_LOST" };

      const existingLive = [...revisions.values()].find((row) => row.job_id === job_id && ["draft", "approved"].includes(row.lifecycle_status));
      if (existingLive) {
        job.status = "draft";
        job.revision_id = existingLive.revision_id;
        return { ok: true, revision_id: existingLive.revision_id, already_completed: true };
      }

      const revisionNumber = [...revisions.values()].filter((row) => row.job_id === job_id).length + 1;
      const revision_id = uuid();
      revisions.set(revision_id, {
        revision_id,
        job_id,
        revision_number: revisionNumber,
        analysis,
        lifecycle_status: "draft",
        created_at: iso(now_ms),
      });
      if (usageRow && !usage.has(usageRow.logical_call_id)) usage.set(usageRow.logical_call_id, { ...usageRow });
      job.status = "draft";
      job.revision_id = revision_id;
      job.lease_owner = null;
      job.lease_token = null;
      job.lease_expires_at = null;
      job.next_attempt_at = null;
      job.error_code = null;
      job.completed_at = iso(now_ms);
      job.updated_at = iso(now_ms);
      // Audit authority = tầng DB (RPC). Memory queue mô phỏng ĐÚNG chuỗi event để test parity.
      audit.push({ job_id, event_type: "job_completed", actor_ref: job.lease_owner ?? "worker", reason: null });

      if (hooks.completeAfterCommit === true) {
        // Mô phỏng: DB đã commit nhưng response bị mất.
        return { ok: false, code: "AI_INTERNAL", message: "mất response sau khi commit" };
      }
      return { ok: true, revision_id, already_completed: false };
    },

    async fail({ job_id, lease_token, error_code, next_status, next_attempt_at, message, now_ms }) {
      // R3 (B): mô phỏng lỗi DB/RPC hoặc lease đã mất ở bước ghi trạng thái thất bại.
      if (hooks.failError === true) return { ok: false, code: "AI_INTERNAL", message: "fail RPC lỗi (mô phỏng)" };
      if (hooks.failLeaseLost === true) return { ok: false, code: "AI_LEASE_LOST" };
      const job = jobs.get(job_id);
      if (!job) return { ok: false, code: "AI_JOB_NOT_FOUND" };
      if (job.status === "draft") return { ok: false, code: "AI_LEASE_LOST" };
      if (job.lease_token !== lease_token) return { ok: false, code: "AI_LEASE_LOST" };
      job.status = next_status;
      job.error_code = error_code;
      job.error_message = typeof message === "string" ? message.slice(0, 500) : null;
      job.lease_owner = null;
      job.lease_token = null;
      job.lease_expires_at = null;
      job.next_attempt_at = next_status === "queued" ? (next_attempt_at ?? iso(now_ms)) : null;
      job.updated_at = iso(now_ms);
      audit.push({ job_id, event_type: "job_failed", actor_ref: job.lease_owner ?? "worker", reason: error_code });
      return { ok: true, status: next_status };
    },

    async recordUsage(row) {
      if (usage.has(row.logical_call_id)) return { ok: true, inserted: false };
      usage.set(row.logical_call_id, { ...row });
      return { ok: true, inserted: true };
    },

    async policyContext({ actor_ref, window_seconds }) {
      const windowMs = (window_seconds ?? 60) * 1000;
      const nowMs = options.clock ? options.clock.nowMs() : Date.now();
      const recent = [...jobs.values()]
        .filter((job) => job.request?.actor_ref === actor_ref)
        .map((job) => Date.parse(job.created_at));
      let tokens = 0;
      for (const row of usage.values()) tokens += (row.input_tokens ?? 0) + (row.output_tokens ?? 0);
      const queued = [...jobs.values()].filter((job) => ["requested", "queued"].includes(job.status)).length;
      const inflight = [...jobs.values()].filter(
        (job) =>
          ["computing", "ai_generating", "validating"].includes(job.status) &&
          job.lease_expires_at !== null &&
          Date.parse(job.lease_expires_at) > nowMs
      ).length;
      return {
        ok: true,
        value: {
          recent_requests: recent.filter((timestamp) => nowMs - timestamp < windowMs),
          queued_jobs: queued,
          inflight_jobs: inflight,
          active_jobs: queued + inflight,
          tokens_used_today: tokens,
        },
      };
    },

    async status(job_id) {
      const job = jobs.get(job_id);
      if (!job) return { ok: false, code: "AI_JOB_NOT_FOUND" };
      const revision = job.revision_id ? revisions.get(job.revision_id) : null;
      return {
        ok: true,
        value: {
          job_id: job.job_id,
          status: job.status,
          attempts: job.attempts,
          max_attempts: job.max_attempts,
          error_code: job.error_code,
          revision_id: job.revision_id,
          revision,
        },
      };
    },

    async regenerate({ job_id, actor_ref, reason }) {
      const source = jobs.get(job_id);
      if (!source) return { ok: false, code: "AI_JOB_NOT_FOUND" };
      if (typeof reason !== "string" || reason.trim().length < 3) {
        return { ok: false, code: "AI_INPUT_INVALID", message: "regenerate cần reason" };
      }
      if (isActiveStatus(source.status)) return { ok: false, code: "AI_INPUT_INVALID", message: "job đang chạy" };
      // Mô phỏng partial unique index `ai_report_jobs_identity_active_uidx`: không tạo job regenerate
      // thứ hai khi identity đã có job đang hoạt động (double-click/concurrent).
      for (const candidate of jobs.values()) {
        if (candidate.identity_hash === source.identity_hash && isActiveStatus(candidate.status)) {
          return { ok: false, code: "AI_INTERNAL", message: "identity đang có job hoạt động" };
        }
      }
      const newId = uuid();
      jobs.set(newId, {
        ...source,
        job_id: newId,
        status: "queued",
        attempts: 0,
        revision_id: null,
        created_at: iso(options.clock ? options.clock.nowMs() : Date.now()),
        error_code: null,
        generation_kind: "manual_regenerate",
        regenerate_reason: reason.trim(),
      });
      audit.push({ job_id: newId, event_type: "job_regenerated", actor_ref, reason: reason.trim() });
      return { ok: true, value: { job_id: newId, status: "queued", source_job_id: job_id } };
    },

    async recoverStale({ lease_seconds = 0, now_ms }) {
      if (hooks.recoverStaleError === true) {
        return { ok: false, code: "AI_INTERNAL", message: "recoverStale RPC lỗi (mô phỏng)" };
      }
      let recovered = 0;
      const now = Number.isFinite(now_ms) ? now_ms : Date.parse(new Date().toISOString());
      for (const job of jobs.values()) {
        if (!["computing", "ai_generating", "validating"].includes(job.status)) continue;
        // Mirror SQL recover_stale: chỉ thu hồi khi lease đã hết hạn QUÁ ngưỡng grace (lease_seconds).
        const staleThreshold = now - lease_seconds * 1000;
        if (job.lease_expires_at !== null && Date.parse(job.lease_expires_at) >= staleThreshold) continue;
        job.status = "queued";
        job.lease_token = null;
        job.lease_expires_at = null;
        recovered += 1;
      }
      return { ok: true, recovered };
    },
  };
}

export function createMemoryAudit() {
  const events = [];
  return {
    events,
    async append(event) {
      events.push({ ...event });
      return { ok: true };
    },
  };
}
