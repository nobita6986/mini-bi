-- P1.5-W04-R3 — Concurrency authority tại DB claim boundary + policy context tách queue/slot.
--
-- Root cause: policy đếm cả job 'queued' là "đang chạy" và tự chặn ở tầng application ⇒ nhiều job
-- trong queue làm worker tự chặn chính mình (livelock) và trần concurrency không được enforce atomic.
--
-- R3: concurrency của provider được enforce ATOMIC tại claim (advisory lock + đếm job đang giữ lease),
-- còn policy chỉ còn trần HÀNG ĐỢI (max_queue_depth) + rate/budget.
--
-- ROLLBACK:
--   drop function if exists public.ai_report_claim(text, integer, integer);
--   create or replace function public.ai_report_claim(p_worker text, p_lease_seconds integer) ... (bản 160100)
--   create or replace function public.ai_report_policy_context(p_actor_ref text, p_window_seconds integer) ... (bản 160000)

-- ---------------------------------------------------------------------------
-- 1. Claim có trần concurrency (atomic, không tính job queued là slot đang chạy)
-- ---------------------------------------------------------------------------
create or replace function public.ai_report_claim(
  p_worker text,
  p_lease_seconds integer,
  p_max_concurrent_jobs integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.ai_report_jobs;
  v_token uuid := gen_random_uuid();
  v_recovered integer := 0;
  v_seconds integer := greatest(30, least(900, coalesce(p_lease_seconds, 120)));
  v_inflight integer := 0;
  v_ceiling integer := case
    when p_max_concurrent_jobs is null then null
    else greatest(1, least(50, p_max_concurrent_jobs))
  end;
begin
  -- 1a. Serialize claim: quyết định slot + claim phải atomic giữa nhiều worker.
  perform pg_advisory_xact_lock(hashtext('ai_report_claim_concurrency'));

  -- 1b. Recovery: lease hết hạn ⇒ trả về queue (không giữ slot vô hạn).
  update public.ai_report_jobs
     set status = 'queued', lease_owner = null, lease_token = null, lease_expires_at = null,
         next_attempt_at = now(), updated_at = now()
   where status in ('computing','ai_generating','validating')
     and (lease_expires_at is null or lease_expires_at < now());
  get diagnostics v_recovered = row_count;

  -- 1c. Concurrency authority: CHỈ tính job đang thực sự giữ slot provider (lease còn hiệu lực).
  select count(*) into v_inflight
    from public.ai_report_jobs
   where status in ('computing','ai_generating','validating')
     and lease_expires_at is not null
     and lease_expires_at > now();

  if v_ceiling is not null and v_inflight >= v_ceiling then
    return jsonb_build_object('ok', false, 'code', 'AI_CONCURRENCY_LIMITED',
                              'recovered', v_recovered, 'inflight', v_inflight);
  end if;

  -- 1d. Claim job kế tiếp (job queued KHÔNG bị tính là slot đang chạy).
  select * into v_job
    from public.ai_report_jobs
   where status in ('requested','queued')
     and (next_attempt_at is null or next_attempt_at <= now())
   order by created_at asc
   for update skip locked
   limit 1;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'AI_IDLE', 'recovered', v_recovered, 'inflight', v_inflight);
  end if;

  update public.ai_report_jobs
     set status = 'computing',
         attempts = attempts + 1,
         lease_owner = coalesce(nullif(p_worker, ''), 'worker'),
         lease_token = v_token,
         lease_expires_at = now() + make_interval(secs => v_seconds),
         error_code = null,
         error_message = null,
         updated_at = now()
   where job_id = v_job.job_id
   returning * into v_job;

  insert into public.ai_report_audit_events (job_id, event_type, actor_ref, reason, payload)
  values (v_job.job_id, 'job_claimed', v_job.lease_owner, null,
          jsonb_build_object('attempt', v_job.attempts, 'lease_expires_at', v_job.lease_expires_at));

  return jsonb_build_object('ok', true, 'recovered', v_recovered, 'inflight', v_inflight + 1,
                            'attempt', v_job.attempts, 'lease_token', v_token, 'job', to_jsonb(v_job));
end;
$$;

-- Bỏ bản 2 tham số (không có trần concurrency) để không còn đường claim bỏ qua slot.
drop function if exists public.ai_report_claim(text, integer);

revoke all on function public.ai_report_claim(text, integer, integer) from public;
revoke all on function public.ai_report_claim(text, integer, integer) from anon;
revoke all on function public.ai_report_claim(text, integer, integer) from authenticated;
grant execute on function public.ai_report_claim(text, integer, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 2. Policy context: tách QUEUE DEPTH khỏi SLOT ĐANG CHẠY
-- ---------------------------------------------------------------------------
create or replace function public.ai_report_policy_context(p_actor_ref text, p_window_seconds integer)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_window integer := greatest(1, least(86400, coalesce(p_window_seconds, 60)));
  v_queued integer;
  v_inflight integer;
  v_recent jsonb;
  v_tokens integer;
begin
  select count(*) into v_queued
    from public.ai_report_jobs
   where status in ('requested','queued');

  select count(*) into v_inflight
    from public.ai_report_jobs
   where status in ('computing','ai_generating','validating')
     and lease_expires_at is not null
     and lease_expires_at > now();

  select coalesce(jsonb_agg(extract(epoch from created_at) * 1000), '[]'::jsonb) into v_recent
    from public.ai_report_jobs
   where actor_ref = p_actor_ref
     and created_at > now() - make_interval(secs => v_window);

  select coalesce(sum(coalesce(input_tokens, 0) + coalesce(output_tokens, 0)), 0) into v_tokens
    from public.ai_report_usage
   where created_at >= date_trunc('day', now());

  return jsonb_build_object(
    'ok', true,
    'queued_jobs', v_queued,
    'inflight_jobs', v_inflight,
    'active_jobs', v_queued + v_inflight,
    'recent_requests', v_recent,
    'tokens_used_today', v_tokens
  );
end;
$$;

revoke all on function public.ai_report_policy_context(text, integer) from public;
revoke all on function public.ai_report_policy_context(text, integer) from anon;
revoke all on function public.ai_report_policy_context(text, integer) from authenticated;
grant execute on function public.ai_report_policy_context(text, integer) to service_role;

comment on function public.ai_report_claim(text, integer, integer) is
  'P1.5-W04-R3 — atomic claim với lease fencing + trần concurrency provider (advisory lock).';
