-- P1.5-W04 — AI report gateway: durable job/revision/usage/audit + atomic RPC boundary.
--
-- Phạm vi: CHỈ schema + function cho hàng đợi generation (DEV). Không gọi AI, không secret trong DB.
-- Security: RLS bật trên mọi bảng; revoke PUBLIC/anon/authenticated; chỉ service_role (server boundary)
--   được select/insert/update; audit append-only (chặn UPDATE/DELETE bằng trigger).
-- Idempotent: mọi DDL dùng IF NOT EXISTS / CREATE OR REPLACE / DROP TRIGGER IF EXISTS.
--
-- ROLLBACK (chạy tay khi cần, theo thứ tự ngược):
--   drop function if exists public.ai_report_policy_context(text, integer);
--   drop function if exists public.ai_report_recover_stale(integer);
--   drop function if exists public.ai_report_regenerate(uuid, text, text);
--   drop function if exists public.ai_report_status(uuid);
--   drop function if exists public.ai_report_record_usage(jsonb);
--   drop function if exists public.ai_report_fail(uuid, uuid, text, text, timestamptz, text);
--   drop function if exists public.ai_report_complete(uuid, uuid, jsonb, jsonb);
--   drop function if exists public.ai_report_mark_stage(uuid, uuid, text);
--   drop function if exists public.ai_report_claim(text, integer);
--   drop function if exists public.ai_report_enqueue(text, jsonb, jsonb, text, text, text, text, jsonb, text, text, text, text, text, text, text, integer);
--   drop table if exists public.ai_report_audit_events;
--   drop table if exists public.ai_report_usage;
--   drop table if exists public.ai_report_revisions;
--   drop table if exists public.ai_report_jobs;
--   (bảng không chứa secret; dữ liệu báo cáo AI là dữ liệu suy ra, xoá được an toàn)

-- ---------------------------------------------------------------------------
-- 1. Jobs
-- ---------------------------------------------------------------------------
create table if not exists public.ai_report_jobs (
  job_id                   uuid primary key default gen_random_uuid(),
  identity_hash            text not null,
  identity_components      jsonb not null,
  request                  jsonb not null,
  actor_ref                text not null,
  access_scope_hash        text not null,
  snapshot_hash            text not null,
  lineage_ref              text not null,
  packet                   jsonb not null,
  packet_hash              text not null,
  packet_contract_version  text not null,
  output_contract_version  text not null,
  prompt_version           text not null,
  provider_key             text not null,
  model_key                text not null,
  adapter_version          text not null,
  generation_kind          text not null default 'primary',
  regenerate_reason        text,
  status                   text not null default 'queued',
  attempts                 integer not null default 0,
  max_attempts             integer not null default 3,
  lease_owner              text,
  lease_token              uuid,
  lease_expires_at         timestamptz,
  next_attempt_at          timestamptz,
  error_code               text,
  error_message            text,
  revision_id              uuid,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  completed_at             timestamptz,
  constraint ai_report_jobs_status_check check (status in (
    'requested','queued','computing','ai_generating','validating','draft',
    'failed_input','failed_config','failed_provider_transient','failed_provider_permanent',
    'failed_validation','failed_budget','failed_internal')),
  constraint ai_report_jobs_kind_check check (generation_kind in ('primary','manual_regenerate')),
  constraint ai_report_jobs_attempts_check check (attempts >= 0 and max_attempts between 1 and 5),
  constraint ai_report_jobs_identity_check check (length(identity_hash) between 16 and 64),
  constraint ai_report_jobs_error_message_check check (error_message is null or length(error_message) <= 500),
  constraint ai_report_jobs_regenerate_reason_check check (
    (generation_kind = 'primary' and regenerate_reason is null)
    or (generation_kind = 'manual_regenerate' and regenerate_reason is not null and length(regenerate_reason) between 3 and 300))
);

-- Một logical job đang hoạt động cho mỗi identity (double-click/concurrent ⇒ cùng một job).
create unique index if not exists ai_report_jobs_identity_active_uidx
  on public.ai_report_jobs (identity_hash)
  where status in ('requested','queued','computing','ai_generating','validating');

create index if not exists ai_report_jobs_claim_idx
  on public.ai_report_jobs (status, next_attempt_at, created_at);

create index if not exists ai_report_jobs_identity_history_idx
  on public.ai_report_jobs (identity_hash, created_at desc);

-- ---------------------------------------------------------------------------
-- 2. Revisions
-- ---------------------------------------------------------------------------
create table if not exists public.ai_report_revisions (
  revision_id      uuid primary key default gen_random_uuid(),
  job_id           uuid not null references public.ai_report_jobs(job_id) on delete restrict,
  revision_number  integer not null,
  analysis         jsonb not null,
  packet_hash      text not null,
  snapshot_hash    text not null,
  lineage_ref      text not null,
  prompt_version   text not null,
  provider_key     text not null,
  model_key        text not null,
  contract_version text not null,
  lifecycle_status text not null default 'draft',
  created_by_ref   text not null,
  created_at       timestamptz not null default now(),
  approved_by_ref  text,
  approved_at      timestamptz,
  rejected_by_ref  text,
  rejected_at      timestamptz,
  rejection_reason text,
  constraint ai_report_revisions_number_check check (revision_number >= 1),
  constraint ai_report_revisions_lifecycle_check check (lifecycle_status in ('draft','approved','rejected')),
  constraint ai_report_revisions_unique_number unique (job_id, revision_number)
);

-- Một revision "còn sống" cho mỗi job ⇒ không duplicate draft khi retry/mất response.
create unique index if not exists ai_report_revisions_one_live_uidx
  on public.ai_report_revisions (job_id)
  where lifecycle_status in ('draft','approved');

-- ---------------------------------------------------------------------------
-- 3. Usage (chỉ metadata an toàn)
-- ---------------------------------------------------------------------------
create table if not exists public.ai_report_usage (
  usage_id         uuid primary key default gen_random_uuid(),
  job_id           uuid not null references public.ai_report_jobs(job_id) on delete restrict,
  logical_call_id  text not null,
  provider_key     text not null,
  model_key        text not null,
  provider_version text,
  latency_ms       integer not null default 0,
  input_tokens     integer,
  output_tokens    integer,
  call_outcome     text not null,
  cache_hit        boolean not null default false,
  retry_count      integer not null default 0,
  created_at       timestamptz not null default now(),
  constraint ai_report_usage_logical_uidx unique (logical_call_id),
  constraint ai_report_usage_nonneg_check check (
    latency_ms >= 0
    and coalesce(input_tokens, 0) >= 0
    and coalesce(output_tokens, 0) >= 0
    and retry_count >= 0)
);

create index if not exists ai_report_usage_job_idx on public.ai_report_usage (job_id, created_at desc);
create index if not exists ai_report_usage_day_idx on public.ai_report_usage (created_at desc);

-- ---------------------------------------------------------------------------
-- 4. Audit (append-only)
-- ---------------------------------------------------------------------------
create table if not exists public.ai_report_audit_events (
  event_id   bigserial primary key,
  job_id     uuid,
  event_type text not null,
  actor_ref  text not null,
  reason     text,
  payload    jsonb,
  created_at timestamptz not null default now(),
  constraint ai_report_audit_event_type_check check (event_type in (
    'job_enqueued','job_reused','job_cache_hit','job_claimed','job_stage','job_completed',
    'job_completed_idempotent','job_failed','job_regenerated','job_recovered')),
  constraint ai_report_audit_payload_check check (payload is null or length(payload::text) <= 2000),
  constraint ai_report_audit_reason_check check (reason is null or length(reason) <= 300)
);

create index if not exists ai_report_audit_job_idx on public.ai_report_audit_events (job_id, created_at desc);

create or replace function public.ai_report_audit_immutable()
returns trigger
language plpgsql
as $$
begin
  raise exception 'ai_report_audit_events is append-only';
end;
$$;

drop trigger if exists ai_report_audit_no_mutation on public.ai_report_audit_events;
create trigger ai_report_audit_no_mutation
  before update or delete on public.ai_report_audit_events
  for each row execute function public.ai_report_audit_immutable();

-- ---------------------------------------------------------------------------
-- 5. RLS + grants (deny by default; chỉ service_role ở server boundary)
-- ---------------------------------------------------------------------------
alter table public.ai_report_jobs enable row level security;
alter table public.ai_report_revisions enable row level security;
alter table public.ai_report_usage enable row level security;
alter table public.ai_report_audit_events enable row level security;

revoke all on table public.ai_report_jobs from public;
revoke all on table public.ai_report_jobs from anon;
revoke all on table public.ai_report_jobs from authenticated;
revoke all on table public.ai_report_revisions from public;
revoke all on table public.ai_report_revisions from anon;
revoke all on table public.ai_report_revisions from authenticated;
revoke all on table public.ai_report_usage from public;
revoke all on table public.ai_report_usage from anon;
revoke all on table public.ai_report_usage from authenticated;
revoke all on table public.ai_report_audit_events from public;
revoke all on table public.ai_report_audit_events from anon;
revoke all on table public.ai_report_audit_events from authenticated;

grant select, insert, update on table public.ai_report_jobs to service_role;
grant select, insert, update on table public.ai_report_revisions to service_role;
grant select, insert on table public.ai_report_usage to service_role;
-- audit: CHỈ select + insert (append-only ở tầng quyền, cộng trigger ở trên).
grant select, insert on table public.ai_report_audit_events to service_role;
grant usage, select on sequence public.ai_report_audit_events_event_id_seq to service_role;

-- ---------------------------------------------------------------------------
-- 6. RPC: enqueue-or-reuse (idempotent, chống double-click)
-- ---------------------------------------------------------------------------
create or replace function public.ai_report_enqueue(
  p_identity_hash text,
  p_identity_components jsonb,
  p_request jsonb,
  p_actor_ref text,
  p_access_scope_hash text,
  p_snapshot_hash text,
  p_lineage_ref text,
  p_packet jsonb,
  p_packet_hash text,
  p_packet_contract_version text,
  p_output_contract_version text,
  p_prompt_version text,
  p_provider_key text,
  p_model_key text,
  p_adapter_version text,
  p_max_attempts integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.ai_report_jobs;
  v_revision_id uuid;
begin
  if p_identity_hash is null or length(p_identity_hash) < 16 then
    return jsonb_build_object('ok', false, 'code', 'AI_INPUT_INVALID', 'message', 'identity_hash không hợp lệ');
  end if;

  -- 1) Job đang hoạt động cùng identity ⇒ reuse (double-click/concurrent).
  select * into v_job
    from public.ai_report_jobs
   where identity_hash = p_identity_hash
     and status in ('requested','queued','computing','ai_generating','validating')
   order by created_at desc
   limit 1;
  if found then
    return jsonb_build_object('ok', true, 'job_id', v_job.job_id, 'status', v_job.status,
                              'reused', true, 'cache_hit', false, 'revision_id', v_job.revision_id);
  end if;

  -- 2) Đã có revision hợp lệ cho cùng identity ⇒ cache hit (không gọi provider lại).
  select r.revision_id into v_revision_id
    from public.ai_report_revisions r
    join public.ai_report_jobs j on j.job_id = r.job_id
   where j.identity_hash = p_identity_hash
     and r.lifecycle_status in ('draft','approved')
   order by r.created_at desc
   limit 1;
  if v_revision_id is not null then
    return jsonb_build_object('ok', true, 'job_id', (select job_id from public.ai_report_revisions where revision_id = v_revision_id),
                              'status', 'draft', 'reused', false, 'cache_hit', true, 'revision_id', v_revision_id);
  end if;

  -- 3) Tạo job mới; nếu đua nhau thì unique index partial sẽ chặn và ta reuse job thắng.
  begin
    insert into public.ai_report_jobs (
      identity_hash, identity_components, request, actor_ref, access_scope_hash, snapshot_hash, lineage_ref,
      packet, packet_hash, packet_contract_version, output_contract_version,
      prompt_version, provider_key, model_key, adapter_version, status, max_attempts
    ) values (
      p_identity_hash, p_identity_components, p_request, p_actor_ref, p_access_scope_hash, p_snapshot_hash, p_lineage_ref,
      p_packet, p_packet_hash, p_packet_contract_version, p_output_contract_version,
      p_prompt_version, p_provider_key, p_model_key, p_adapter_version, 'queued', greatest(1, least(5, coalesce(p_max_attempts, 3)))
    )
    returning * into v_job;
  exception when unique_violation then
    select * into v_job
      from public.ai_report_jobs
     where identity_hash = p_identity_hash
       and status in ('requested','queued','computing','ai_generating','validating')
     order by created_at desc
     limit 1;
    if not found then
      raise;
    end if;
    return jsonb_build_object('ok', true, 'job_id', v_job.job_id, 'status', v_job.status,
                              'reused', true, 'cache_hit', false, 'revision_id', v_job.revision_id);
  end;

  insert into public.ai_report_audit_events (job_id, event_type, actor_ref, reason, payload)
  values (v_job.job_id, 'job_enqueued', p_actor_ref, null,
          jsonb_build_object('prompt_version', p_prompt_version, 'provider_key', p_provider_key, 'model_key', p_model_key));

  return jsonb_build_object('ok', true, 'job_id', v_job.job_id, 'status', v_job.status,
                            'reused', false, 'cache_hit', false, 'revision_id', null);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. RPC: atomic claim với lease/fencing + stale recovery
-- ---------------------------------------------------------------------------
create or replace function public.ai_report_claim(p_worker text, p_lease_seconds integer)
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
begin
  -- 7a. Recovery: lease hết hạn ⇒ trả về queue (không giữ lease vô hạn).
  update public.ai_report_jobs
     set status = 'queued', lease_owner = null, lease_token = null, lease_expires_at = null,
         next_attempt_at = now(), updated_at = now()
   where status in ('computing','ai_generating','validating')
     and (lease_expires_at is null or lease_expires_at < now());
  get diagnostics v_recovered = row_count;

  -- 7b. Claim atomic: FOR UPDATE SKIP LOCKED ⇒ hai worker không lấy cùng job.
  select * into v_job
    from public.ai_report_jobs
   where status in ('requested','queued')
     and (next_attempt_at is null or next_attempt_at <= now())
   order by created_at asc
   for update skip locked
   limit 1;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'AI_IDLE', 'recovered', v_recovered);
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

  return jsonb_build_object('ok', true, 'recovered', v_recovered, 'attempt', v_job.attempts,
                            'lease_token', v_token, 'job', to_jsonb(v_job));
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. RPC: stage / complete / fail (fencing theo lease_token)
-- ---------------------------------------------------------------------------
create or replace function public.ai_report_mark_stage(p_job_id uuid, p_lease_token uuid, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.ai_report_jobs;
begin
  if p_status not in ('computing','ai_generating','validating') then
    return jsonb_build_object('ok', false, 'code', 'AI_INTERNAL', 'message', 'stage không hợp lệ');
  end if;
  update public.ai_report_jobs
     set status = p_status, updated_at = now()
   where job_id = p_job_id
     and lease_token = p_lease_token
     and status in ('computing','ai_generating','validating')
   returning * into v_job;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'AI_LEASE_LOST');
  end if;
  insert into public.ai_report_audit_events (job_id, event_type, actor_ref, reason, payload)
  values (p_job_id, 'job_stage', v_job.lease_owner, p_status, null);
  return jsonb_build_object('ok', true, 'status', v_job.status);
end;
$$;

create or replace function public.ai_report_complete(p_job_id uuid, p_lease_token uuid, p_analysis jsonb, p_usage jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.ai_report_jobs;
  v_revision public.ai_report_revisions;
  v_next integer;
begin
  select * into v_job from public.ai_report_jobs where job_id = p_job_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'AI_JOB_NOT_FOUND');
  end if;

  -- 8a. Idempotency: đã có draft ⇒ trả lại revision cũ (mất response sau commit).
  if v_job.status = 'draft' and v_job.revision_id is not null then
    return jsonb_build_object('ok', true, 'already_completed', true, 'revision_id', v_job.revision_id);
  end if;

  -- 8b. Fencing: chỉ lease owner/token hiện hành được complete.
  if v_job.lease_token is null or v_job.lease_token <> p_lease_token then
    return jsonb_build_object('ok', false, 'code', 'AI_LEASE_LOST');
  end if;
  if v_job.lease_expires_at is null or v_job.lease_expires_at < now() then
    return jsonb_build_object('ok', false, 'code', 'AI_LEASE_LOST');
  end if;

  select coalesce(max(revision_number), 0) + 1 into v_next
    from public.ai_report_revisions where job_id = p_job_id;

  insert into public.ai_report_revisions (
    job_id, revision_number, analysis, packet_hash, snapshot_hash, lineage_ref,
    prompt_version, provider_key, model_key, contract_version, lifecycle_status, created_by_ref
  ) values (
    p_job_id, v_next, p_analysis, v_job.packet_hash, v_job.snapshot_hash, v_job.lineage_ref,
    v_job.prompt_version, v_job.provider_key, v_job.model_key, v_job.output_contract_version, 'draft', v_job.actor_ref
  )
  returning * into v_revision;

  insert into public.ai_report_usage (
    job_id, logical_call_id, provider_key, model_key, provider_version,
    latency_ms, input_tokens, output_tokens, call_outcome, cache_hit, retry_count
  ) values (
    p_job_id,
    coalesce(p_usage->>'logical_call_id', p_job_id::text || ':1'),
    coalesce(p_usage->>'provider_key', v_job.provider_key),
    coalesce(p_usage->>'model_key', v_job.model_key),
    p_usage->>'provider_version',
    coalesce((p_usage->>'latency_ms')::integer, 0),
    nullif(p_usage->>'input_tokens', '')::integer,
    nullif(p_usage->>'output_tokens', '')::integer,
    coalesce(p_usage->>'call_outcome', 'ok'),
    coalesce((p_usage->>'cache_hit')::boolean, false),
    coalesce((p_usage->>'retry_count')::integer, 0)
  )
  on conflict (logical_call_id) do nothing;

  update public.ai_report_jobs
     set status = 'draft',
         revision_id = v_revision.revision_id,
         lease_owner = null, lease_token = null, lease_expires_at = null,
         next_attempt_at = null, error_code = null, error_message = null,
         completed_at = now(), updated_at = now()
   where job_id = p_job_id;

  insert into public.ai_report_audit_events (job_id, event_type, actor_ref, reason, payload)
  values (p_job_id, 'job_completed', coalesce(v_job.lease_owner, 'worker'), null,
          jsonb_build_object('revision_id', v_revision.revision_id, 'revision_number', v_next));

  return jsonb_build_object('ok', true, 'already_completed', false,
                            'revision_id', v_revision.revision_id, 'revision_number', v_next);
end;
$$;

create or replace function public.ai_report_fail(
  p_job_id uuid,
  p_lease_token uuid,
  p_error_code text,
  p_next_status text,
  p_next_attempt_at timestamptz,
  p_message text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.ai_report_jobs;
begin
  select * into v_job from public.ai_report_jobs where job_id = p_job_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'AI_JOB_NOT_FOUND');
  end if;
  if v_job.status = 'draft' then
    -- Không bao giờ hạ cấp một draft hợp lệ vì attempt cũ.
    return jsonb_build_object('ok', false, 'code', 'AI_LEASE_LOST');
  end if;
  if v_job.lease_token is null or v_job.lease_token <> p_lease_token then
    return jsonb_build_object('ok', false, 'code', 'AI_LEASE_LOST');
  end if;
  if p_next_status not in ('queued','failed_input','failed_config','failed_provider_transient',
                           'failed_provider_permanent','failed_validation','failed_budget','failed_internal') then
    return jsonb_build_object('ok', false, 'code', 'AI_INTERNAL', 'message', 'next_status không hợp lệ');
  end if;

  update public.ai_report_jobs
     set status = p_next_status,
         error_code = left(coalesce(p_error_code, 'AI_INTERNAL'), 64),
         error_message = left(coalesce(p_message, ''), 500),
         lease_owner = null, lease_token = null, lease_expires_at = null,
         next_attempt_at = case when p_next_status = 'queued' then coalesce(p_next_attempt_at, now()) else null end,
         updated_at = now()
   where job_id = p_job_id;

  insert into public.ai_report_audit_events (job_id, event_type, actor_ref, reason, payload)
  values (p_job_id, 'job_failed', coalesce(v_job.lease_owner, 'worker'), left(coalesce(p_error_code, 'AI_INTERNAL'), 300),
          jsonb_build_object('next_status', p_next_status, 'attempt', v_job.attempts));

  return jsonb_build_object('ok', true, 'status', p_next_status);
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. RPC: usage idempotent + status + regenerate + policy context
-- ---------------------------------------------------------------------------
create or replace function public.ai_report_record_usage(p_usage jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_inserted integer := 0;
begin
  insert into public.ai_report_usage (
    job_id, logical_call_id, provider_key, model_key, provider_version,
    latency_ms, input_tokens, output_tokens, call_outcome, cache_hit, retry_count
  ) values (
    (p_usage->>'job_id')::uuid,
    p_usage->>'logical_call_id',
    coalesce(p_usage->>'provider_key', 'unknown'),
    coalesce(p_usage->>'model_key', 'unknown'),
    p_usage->>'provider_version',
    coalesce((p_usage->>'latency_ms')::integer, 0),
    nullif(p_usage->>'input_tokens', '')::integer,
    nullif(p_usage->>'output_tokens', '')::integer,
    coalesce(p_usage->>'call_outcome', 'unknown'),
    coalesce((p_usage->>'cache_hit')::boolean, false),
    coalesce((p_usage->>'retry_count')::integer, 0)
  )
  on conflict (logical_call_id) do nothing;
  get diagnostics v_inserted = row_count;
  return jsonb_build_object('ok', true, 'inserted', v_inserted = 1);
end;
$$;

create or replace function public.ai_report_status(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.ai_report_jobs;
  v_revision public.ai_report_revisions;
begin
  select * into v_job from public.ai_report_jobs where job_id = p_job_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'AI_JOB_NOT_FOUND');
  end if;
  if v_job.revision_id is not null then
    select * into v_revision from public.ai_report_revisions where revision_id = v_job.revision_id;
  end if;
  return jsonb_build_object(
    'ok', true,
    'job_id', v_job.job_id,
    'status', v_job.status,
    'attempts', v_job.attempts,
    'max_attempts', v_job.max_attempts,
    'error_code', v_job.error_code,
    'prompt_version', v_job.prompt_version,
    'provider_key', v_job.provider_key,
    'model_key', v_job.model_key,
    'created_at', v_job.created_at,
    'updated_at', v_job.updated_at,
    'completed_at', v_job.completed_at,
    'revision_id', v_job.revision_id,
    'revision', case when v_revision.revision_id is null then null else jsonb_build_object(
      'revision_id', v_revision.revision_id,
      'revision_number', v_revision.revision_number,
      'lifecycle_status', v_revision.lifecycle_status,
      'contract_version', v_revision.contract_version,
      'created_at', v_revision.created_at,
      'analysis', v_revision.analysis
    ) end
  );
end;
$$;

create or replace function public.ai_report_regenerate(p_job_id uuid, p_actor_ref text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_source public.ai_report_jobs;
  v_job public.ai_report_jobs;
begin
  if p_reason is null or length(btrim(p_reason)) < 3 then
    return jsonb_build_object('ok', false, 'code', 'AI_INPUT_INVALID', 'message', 'regenerate cần reason tối thiểu 3 ký tự');
  end if;
  select * into v_source from public.ai_report_jobs where job_id = p_job_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'AI_JOB_NOT_FOUND');
  end if;
  if v_source.status in ('requested','queued','computing','ai_generating','validating') then
    return jsonb_build_object('ok', false, 'code', 'AI_INPUT_INVALID', 'message', 'job đang chạy, không regenerate');
  end if;

  insert into public.ai_report_jobs (
    identity_hash, identity_components, request, actor_ref, access_scope_hash, snapshot_hash, lineage_ref,
    packet, packet_hash, packet_contract_version, output_contract_version,
    prompt_version, provider_key, model_key, adapter_version,
    generation_kind, regenerate_reason, status, max_attempts
  ) values (
    v_source.identity_hash, v_source.identity_components, v_source.request, p_actor_ref, v_source.access_scope_hash,
    v_source.snapshot_hash, v_source.lineage_ref, v_source.packet, v_source.packet_hash,
    v_source.packet_contract_version, v_source.output_contract_version,
    v_source.prompt_version, v_source.provider_key, v_source.model_key, v_source.adapter_version,
    'manual_regenerate', left(btrim(p_reason), 300), 'queued', v_source.max_attempts
  )
  returning * into v_job;

  insert into public.ai_report_audit_events (job_id, event_type, actor_ref, reason, payload)
  values (v_job.job_id, 'job_regenerated', p_actor_ref, left(btrim(p_reason), 300),
          jsonb_build_object('source_job_id', v_source.job_id, 'identity_hash', v_job.identity_hash));

  return jsonb_build_object('ok', true, 'job_id', v_job.job_id, 'status', v_job.status, 'source_job_id', v_source.job_id);
end;
$$;

create or replace function public.ai_report_recover_stale(p_lease_seconds integer)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_recovered integer := 0;
begin
  update public.ai_report_jobs
     set status = 'queued', lease_owner = null, lease_token = null, lease_expires_at = null,
         next_attempt_at = now(), updated_at = now()
   where status in ('computing','ai_generating','validating')
     and (lease_expires_at is null
          or lease_expires_at < now() - make_interval(secs => greatest(0, least(3600, coalesce(p_lease_seconds, 0)))));
  get diagnostics v_recovered = row_count;
  return jsonb_build_object('ok', true, 'recovered', v_recovered);
end;
$$;

create or replace function public.ai_report_policy_context(p_actor_ref text, p_window_seconds integer)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_window integer := greatest(1, least(86400, coalesce(p_window_seconds, 60)));
  v_active integer;
  v_recent jsonb;
  v_tokens integer;
begin
  select count(*) into v_active
    from public.ai_report_jobs
   where status in ('requested','queued','computing','ai_generating','validating');

  select coalesce(jsonb_agg(extract(epoch from created_at) * 1000), '[]'::jsonb) into v_recent
    from public.ai_report_jobs
   where actor_ref = p_actor_ref
     and created_at > now() - make_interval(secs => v_window);

  select coalesce(sum(coalesce(input_tokens, 0) + coalesce(output_tokens, 0)), 0) into v_tokens
    from public.ai_report_usage
   where created_at >= date_trunc('day', now());

  return jsonb_build_object('ok', true, 'active_jobs', v_active, 'recent_requests', v_recent, 'tokens_used_today', v_tokens);
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Function grants: chỉ service_role
-- ---------------------------------------------------------------------------
revoke all on function public.ai_report_enqueue(text, jsonb, jsonb, text, text, text, text, jsonb, text, text, text, text, text, text, text, integer) from public;
revoke all on function public.ai_report_enqueue(text, jsonb, jsonb, text, text, text, text, jsonb, text, text, text, text, text, text, text, integer) from anon;
revoke all on function public.ai_report_enqueue(text, jsonb, jsonb, text, text, text, text, jsonb, text, text, text, text, text, text, text, integer) from authenticated;
grant execute on function public.ai_report_enqueue(text, jsonb, jsonb, text, text, text, text, jsonb, text, text, text, text, text, text, text, integer) to service_role;

revoke all on function public.ai_report_claim(text, integer) from public;
revoke all on function public.ai_report_claim(text, integer) from anon;
revoke all on function public.ai_report_claim(text, integer) from authenticated;
grant execute on function public.ai_report_claim(text, integer) to service_role;

revoke all on function public.ai_report_mark_stage(uuid, uuid, text) from public;
revoke all on function public.ai_report_mark_stage(uuid, uuid, text) from anon;
revoke all on function public.ai_report_mark_stage(uuid, uuid, text) from authenticated;
grant execute on function public.ai_report_mark_stage(uuid, uuid, text) to service_role;

revoke all on function public.ai_report_complete(uuid, uuid, jsonb, jsonb) from public;
revoke all on function public.ai_report_complete(uuid, uuid, jsonb, jsonb) from anon;
revoke all on function public.ai_report_complete(uuid, uuid, jsonb, jsonb) from authenticated;
grant execute on function public.ai_report_complete(uuid, uuid, jsonb, jsonb) to service_role;

revoke all on function public.ai_report_fail(uuid, uuid, text, text, timestamptz, text) from public;
revoke all on function public.ai_report_fail(uuid, uuid, text, text, timestamptz, text) from anon;
revoke all on function public.ai_report_fail(uuid, uuid, text, text, timestamptz, text) from authenticated;
grant execute on function public.ai_report_fail(uuid, uuid, text, text, timestamptz, text) to service_role;

revoke all on function public.ai_report_record_usage(jsonb) from public;
revoke all on function public.ai_report_record_usage(jsonb) from anon;
revoke all on function public.ai_report_record_usage(jsonb) from authenticated;
grant execute on function public.ai_report_record_usage(jsonb) to service_role;

revoke all on function public.ai_report_status(uuid) from public;
revoke all on function public.ai_report_status(uuid) from anon;
revoke all on function public.ai_report_status(uuid) from authenticated;
grant execute on function public.ai_report_status(uuid) to service_role;

revoke all on function public.ai_report_regenerate(uuid, text, text) from public;
revoke all on function public.ai_report_regenerate(uuid, text, text) from anon;
revoke all on function public.ai_report_regenerate(uuid, text, text) from authenticated;
grant execute on function public.ai_report_regenerate(uuid, text, text) to service_role;

revoke all on function public.ai_report_recover_stale(integer) from public;
revoke all on function public.ai_report_recover_stale(integer) from anon;
revoke all on function public.ai_report_recover_stale(integer) from authenticated;
grant execute on function public.ai_report_recover_stale(integer) to service_role;

revoke all on function public.ai_report_policy_context(text, integer) from public;
revoke all on function public.ai_report_policy_context(text, integer) from anon;
revoke all on function public.ai_report_policy_context(text, integer) from authenticated;
grant execute on function public.ai_report_policy_context(text, integer) to service_role;

comment on table public.ai_report_jobs is 'P1.5-W04 — durable AI report generation job (queue authority).';
comment on table public.ai_report_revisions is 'P1.5-W04 — validated business-analysis/0.1 revisions (draft/approved/rejected lifecycle).';
comment on table public.ai_report_usage is 'P1.5-W04 — provider usage metadata (no prompt/response/secret).';
comment on table public.ai_report_audit_events is 'P1.5-W04 — append-only audit events.';
