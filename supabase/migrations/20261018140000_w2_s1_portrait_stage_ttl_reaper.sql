begin;

alter table public.direct_entry_worker_portrait_stages
  add column cleanup_pending_at timestamptz,
  add column cleanup_lease_until timestamptz,
  add column cleanup_claim_token uuid,
  add column cleanup_attempts integer not null default 0,
  add column cleanup_completed_at timestamptz,
  add constraint direct_entry_worker_portrait_stages_cleanup_state_check
    check (
      (
        cleanup_pending_at is null and cleanup_lease_until is null and
        cleanup_claim_token is null and cleanup_attempts = 0 and
        cleanup_completed_at is null
      )
      or
      (
        status = 'CANCELLED' and cleanup_pending_at is not null and
        cleanup_attempts > 0 and
        (
          (cleanup_completed_at is null and
            ((cleanup_lease_until is null and cleanup_claim_token is null) or
             (cleanup_lease_until is not null and cleanup_claim_token is not null)))
          or
          (cleanup_completed_at is not null and cleanup_lease_until is null and
            cleanup_claim_token is null)
        )
      )
    );

create index direct_entry_worker_portrait_stages_cleanup_pending_idx
  on public.direct_entry_worker_portrait_stages(cleanup_lease_until, cleanup_pending_at)
  where status = 'CANCELLED' and cleanup_pending_at is not null
    and cleanup_completed_at is null;

create function public.direct_entry_claim_expired_worker_portrait_stage_cleanup(
  p_claim_token uuid,
  p_limit integer default 50
)
returns uuid[]
language plpgsql
security definer
set search_path = pg_catalog, public
as $cleanup$
declare
  v_now timestamptz := clock_timestamp();
  v_ids uuid[];
begin
  if p_claim_token is null or p_limit is null or p_limit not between 1 and 100 then
    raise exception 'portrait cleanup claim invalid' using errcode = '22023';
  end if;

  with eligible as (
    select s.stage_id
      from public.direct_entry_worker_portrait_stages s
     where (
       (s.status = 'STAGED' and s.created_at <= v_now - interval '24 hours')
       or
       (s.status = 'CANCELLED' and s.cleanup_pending_at is not null
        and s.cleanup_completed_at is null
        and (s.cleanup_lease_until is null or s.cleanup_lease_until <= v_now))
     )
     order by coalesce(s.cleanup_pending_at, s.created_at), s.stage_id
     for update skip locked
     limit p_limit
  ), claimed as (
    update public.direct_entry_worker_portrait_stages s
       set status = 'CANCELLED',
           cleanup_pending_at = coalesce(s.cleanup_pending_at, v_now),
           cleanup_lease_until = v_now + interval '5 minutes',
           cleanup_claim_token = p_claim_token,
           cleanup_attempts = s.cleanup_attempts + 1
      from eligible e
     where s.stage_id = e.stage_id
       and (
         s.status = 'STAGED'
         or (s.status = 'CANCELLED' and s.cleanup_completed_at is null
             and (s.cleanup_lease_until is null or s.cleanup_lease_until <= v_now))
       )
     returning s.stage_id
  )
  select coalesce(array_agg(stage_id order by stage_id), '{}'::uuid[])
    into v_ids from claimed;

  return v_ids;
end;
$cleanup$;

create function public.direct_entry_complete_worker_portrait_stage_cleanup(
  p_stage_id uuid,
  p_claim_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $cleanup$
begin
  if p_stage_id is null or p_claim_token is null then
    raise exception 'portrait cleanup completion invalid' using errcode = '22023';
  end if;

  update public.direct_entry_worker_portrait_stages
     set cleanup_completed_at = clock_timestamp(),
         cleanup_lease_until = null,
         cleanup_claim_token = null
   where stage_id = p_stage_id
     and status = 'CANCELLED'
     and cleanup_pending_at is not null
     and cleanup_completed_at is null
     and cleanup_claim_token = p_claim_token;

  return found;
end;
$cleanup$;

revoke all on function public.direct_entry_claim_expired_worker_portrait_stage_cleanup(uuid,integer)
  from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_complete_worker_portrait_stage_cleanup(uuid,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_claim_expired_worker_portrait_stage_cleanup(uuid,integer)
  to service_role;
grant execute on function public.direct_entry_complete_worker_portrait_stage_cleanup(uuid,uuid)
  to service_role;

commit;
