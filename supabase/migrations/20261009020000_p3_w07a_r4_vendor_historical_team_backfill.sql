-- P3-W07A-R4 — historical Vendor team backfill (#66).
--
-- Base: origin/main@c0d7236 (65 migrations).
--
-- P3-W07A-R3 (#65) routed NEW Vendor writes to the reserved, non-business
-- __system_vendor__ team but never migrated the rows written before it, so the
-- read-only Production preflight still found Vendor entries carrying a business
-- team_id (reporting team scope reads direct_entries.team_id, so those workers
-- leaked into the business-team audience). This migration is the append-only
-- data correction; #1-#65 stay byte-identical.
--
-- Contract:
--   * uses the existing public.direct_entry_system_vendor_team_id() helper;
--     no parallel helper, no membership and no team scope for the reserved team.
--   * moves EVERY direct_entries row with provider_type='vendor' whose team is
--     not the reserved team - every state, deleted rows included. The row count
--     is never hard-coded.
--   * touches only team_id (plus the mandatory version bump); project, recruiter,
--     candidate, submission, status, payment, document and worker_details are
--     untouched, and no provider_type='hrp' row is modified.
--   * one immutable system audit event per changed row. The revision table
--     requires a human actor + restricted reason, so no revision is written and
--     no human actor/reason is impersonated: the audit row is actor-null.
--   * re-running is a no-op (no version bump, no extra audit event).
--   * fail-closed postconditions run in the same transaction; any deviation
--     rolls the whole migration back.

begin;

do $p3_w07a_r4$
declare
  v_reserved uuid;
  v_pending integer;
  v_moved integer;
  v_bad integer;
begin
  -- The reserved row must be canonical and unique before anything is moved.
  select count(*) into v_bad
    from public.teams t
   where t.code = '__system_vendor__'
     and (t.display_name <> 'Vendor' or not t.active);
  if v_bad <> 0 then
    raise exception 'P3-W07A-R4 reserved Vendor team row is not canonical' using errcode = '55000';
  end if;
  select count(*) into v_bad
    from public.teams t where t.code = '__system_vendor__';
  if v_bad > 1 then
    raise exception 'P3-W07A-R4 reserved Vendor team is not unique' using errcode = '55000';
  end if;

  select count(*) into v_pending
    from public.direct_entries e
   where e.provider_type = 'vendor'
     and not exists (
       select 1 from public.teams t
        where t.team_id = e.team_id and t.code = '__system_vendor__'
     );

  if v_pending > 0 then
    v_reserved := public.direct_entry_system_vendor_team_id();

    with moved as (
      update public.direct_entries e
         set team_id = v_reserved,
             version = e.version + 1
       where e.provider_type = 'vendor'
         and e.team_id <> v_reserved
      returning e.entry_id
    )
    insert into public.direct_entry_audit_events (
      auth_subject, app_user_id, action, outcome, resource_ref, changed_fields
    )
    select null, null, 'p3_w07a_r4_vendor_team_backfill', 'APPLIED',
           m.entry_id::text, array['team_id']
      from moved m;

    get diagnostics v_moved = row_count;
    raise notice 'P3-W07A-R4 backfilled % Vendor entr(ies) onto the reserved team', v_moved;
  else
    select t.team_id into v_reserved
      from public.teams t where t.code = '__system_vendor__';
  end if;

  -- Fail-closed postconditions, same transaction.
  select count(*) into v_bad
    from public.direct_entries e
   where e.provider_type = 'vendor'
     and (v_reserved is null or e.team_id <> v_reserved);
  if v_bad <> 0 then
    raise exception 'P3-W07A-R4 % Vendor entr(ies) remain outside the reserved team', v_bad using errcode = '55000';
  end if;

  select count(*) into v_bad
    from public.direct_entries e
   where e.provider_type <> 'vendor'
     and v_reserved is not null
     and e.team_id = v_reserved;
  if v_bad <> 0 then
    raise exception 'P3-W07A-R4 % non-Vendor entr(ies) sit on the reserved team', v_bad using errcode = '55000';
  end if;

  if v_reserved is not null then
    select count(*) into v_bad
      from public.recruiter_team_memberships m where m.team_id = v_reserved;
    if v_bad <> 0 then
      raise exception 'P3-W07A-R4 reserved Vendor team has recruiter memberships' using errcode = '55000';
    end if;

    select count(*) into v_bad
      from public.direct_entry_scope_grants g
     where g.scope_kind = 'team' and g.team_id = v_reserved;
    if v_bad <> 0 then
      raise exception 'P3-W07A-R4 reserved Vendor team has team scope grants' using errcode = '55000';
    end if;

    -- The real reporting contract must never emit a team dimension. The legacy
    -- reporting_dimension_options_v01 view has no team dimension at all, so it
    -- cannot prove anything about the reserved team and is not used here.
    select count(*) into v_bad
      from public.direct_entry_reporting_dimension_options_v01 o
     where o.dimension = 'team';
    if v_bad <> 0 then
      raise exception 'P3-W07A-R4 reporting dimension options emitted a team dimension' using errcode = '55000';
    end if;
    select count(*) into v_bad
      from public.direct_entry_reporting_dimension_options_v01 o
     where o.key = v_reserved::text;
    if v_bad <> 0 then
      raise exception 'P3-W07A-R4 reserved Vendor team id appeared as a reporting option' using errcode = '55000';
    end if;
  end if;
end
$p3_w07a_r4$;

commit;
