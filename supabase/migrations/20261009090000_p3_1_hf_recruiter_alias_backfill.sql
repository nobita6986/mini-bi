-- P3.1 hotfix: canonical recruiter aliases are part of recruiter creation.
--
-- Existing catalog and bootstrap paths created the recruiter and provider
-- membership atomically, but did not create recruiter_aliases. Reporting then
-- resolved a named recruiter to __unknown__. This migration repairs the
-- canonical rows and installs the single database boundary used by every
-- current and future create/import path.

create or replace function public.direct_entry_seed_recruiter_alias_from_provider()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_key text;
  v_existing text;
begin
  if new.provider_type = 'hrp' then
    select public.recruitment_dimension_key(r.personnel_code)
      into v_key
      from public.recruiters r
     where r.recruiter_id = new.recruiter_id;
  elsif new.provider_type = 'vendor' then
    v_key := public.recruitment_dimension_key(new.vendor_id);
  end if;

  -- Legacy/non-canonical rows may intentionally lack a reporting key and are
  -- already excluded by the catalog projections. Do not turn this hotfix into
  -- a new raw-table invariant; reviewed create/import paths always carry the
  -- canonical code and therefore take the insert path below.
  if v_key is null then
    return new;
  end if;

  if v_key = '__unknown__' or length(v_key) > 200 then
    raise exception 'canonical recruiter reporting key required'
      using errcode = '23514';
  end if;

  select a.reporting_key
    into v_existing
    from public.recruiter_aliases a
   where a.recruiter_id = new.recruiter_id
     and a.valid_from <= new.valid_from
     and (a.valid_to is null or new.valid_from < a.valid_to)
   order by a.valid_from desc
   limit 1;

  if v_existing is not null then
    if v_existing <> v_key then
      raise exception 'provider and recruiter alias conflict'
        using errcode = '23514';
    end if;
    return new;
  end if;

  insert into public.recruiter_aliases
    (recruiter_id, reporting_key, valid_from, valid_to)
  values
    (new.recruiter_id, v_key, new.valid_from, new.valid_to);

  return new;
end;
$$;

revoke all on function public.direct_entry_seed_recruiter_alias_from_provider()
  from public, anon, authenticated, service_role;

drop trigger if exists direct_entry_seed_recruiter_alias_from_provider
  on public.recruiter_provider_memberships;
create trigger direct_entry_seed_recruiter_alias_from_provider
after insert on public.recruiter_provider_memberships
for each row execute function public.direct_entry_seed_recruiter_alias_from_provider();

-- Backfill every canonical recruiter (exactly one provider-membership row).
-- The anchor is no later than either the provider start or the first stored,
-- non-deleted work date. Existing same-key history is extended backwards;
-- conflicting history fails the migration rather than guessing.
do $$
declare
  v record;
  v_effective integer;
  v_aliases integer;
  v_other_keys integer;
  v_alias_id uuid;
  v_alias_from date;
begin
  for v in
    with membership as (
      select m.recruiter_id,
             count(*)::int as rows_count,
             min(m.provider_type) as provider_type,
             min(m.vendor_id) as vendor_id,
             min(m.valid_from) as provider_from
        from public.recruiter_provider_memberships m
       group by m.recruiter_id
    ), first_work as (
      select e.recruiter_id, min(e.first_work_date) as first_work_date
        from public.direct_entries e
       where e.deleted_at is null
       group by e.recruiter_id
    )
    select r.recruiter_id,
           case when m.provider_type = 'hrp'
                  then public.recruitment_dimension_key(r.personnel_code)
                when m.provider_type = 'vendor'
                  then public.recruitment_dimension_key(m.vendor_id)
           end as reporting_key,
           least(m.provider_from, coalesce(f.first_work_date, m.provider_from)) as target_from
      from public.recruiters r
      join membership m on m.recruiter_id = r.recruiter_id and m.rows_count = 1
      left join first_work f on f.recruiter_id = r.recruiter_id
  loop
    if v.reporting_key is null then
      continue;
    end if;

    if v.reporting_key = '__unknown__' or length(v.reporting_key) > 200 then
      raise exception 'canonical recruiter reporting key required'
        using errcode = '23514';
    end if;

    select count(*)::int
      into v_effective
      from public.recruiter_aliases a
     where a.recruiter_id = v.recruiter_id
       and a.valid_from <= v.target_from
       and (a.valid_to is null or v.target_from < a.valid_to);

    if v_effective > 1 then
      raise exception 'ambiguous recruiter alias history'
        using errcode = '23514';
    elsif v_effective = 0 then
      select count(*)::int,
             count(*) filter (where a.reporting_key <> v.reporting_key)::int
        into v_aliases, v_other_keys
        from public.recruiter_aliases a
       where a.recruiter_id = v.recruiter_id;

      if v_aliases = 0 then
        insert into public.recruiter_aliases
          (recruiter_id, reporting_key, valid_from)
        values
          (v.recruiter_id, v.reporting_key, v.target_from);
      elsif v_other_keys = 0 then
        select a.alias_id, a.valid_from
          into v_alias_id, v_alias_from
          from public.recruiter_aliases a
         where a.recruiter_id = v.recruiter_id
           and a.reporting_key = v.reporting_key
         order by a.valid_from
         limit 1
         for update;

        if v.target_from < v_alias_from then
          update public.recruiter_aliases
             set valid_from = v.target_from
           where alias_id = v_alias_id;
        end if;
      else
        raise exception 'conflicting recruiter alias history'
          using errcode = '23514';
      end if;
    end if;
  end loop;

  if exists (
    with membership as (
      select m.recruiter_id,
             count(*)::int as rows_count,
             min(m.provider_type) as provider_type,
             min(m.vendor_id) as vendor_id,
             min(m.valid_from) as provider_from
        from public.recruiter_provider_memberships m
       group by m.recruiter_id
    ), first_work as (
      select e.recruiter_id, min(e.first_work_date) as first_work_date
        from public.direct_entries e
       where e.deleted_at is null
       group by e.recruiter_id
    )
    select 1
      from public.recruiters r
      join membership m on m.recruiter_id = r.recruiter_id and m.rows_count = 1
      left join first_work f on f.recruiter_id = r.recruiter_id
     where (case when m.provider_type = 'hrp'
                   then public.recruitment_dimension_key(r.personnel_code)
                 when m.provider_type = 'vendor'
                   then public.recruitment_dimension_key(m.vendor_id)
            end) is not null
       and public.direct_entry_reporting_recruiter_alias_key(
             r.recruiter_id,
             least(m.provider_from, coalesce(f.first_work_date, m.provider_from))
           ) = '__unknown__'
  ) then
    raise exception 'canonical recruiter alias backfill incomplete'
      using errcode = '55000';
  end if;
end;
$$;

do $$
declare
  v_definition text;
begin
  select pg_get_functiondef(
           'public.direct_entry_seed_recruiter_alias_from_provider()'::regprocedure
         )
    into v_definition;

  if position('insert into public.recruiter_aliases' in lower(v_definition)) = 0
     or position('public.recruitment_dimension_key' in lower(v_definition)) = 0 then
    raise exception 'recruiter alias trigger function is incomplete'
      using errcode = '55000';
  end if;

  if not exists (
    select 1
      from pg_trigger t
     where t.tgrelid = 'public.recruiter_provider_memberships'::regclass
       and t.tgname = 'direct_entry_seed_recruiter_alias_from_provider'
       and not t.tgisinternal
  ) then
    raise exception 'recruiter alias trigger is missing'
      using errcode = '55000';
  end if;

  if has_function_privilege('anon',
       'public.direct_entry_seed_recruiter_alias_from_provider()', 'EXECUTE')
     or has_function_privilege('authenticated',
       'public.direct_entry_seed_recruiter_alias_from_provider()', 'EXECUTE')
     or has_function_privilege('service_role',
       'public.direct_entry_seed_recruiter_alias_from_provider()', 'EXECUTE') then
    raise exception 'recruiter alias trigger function execute privilege drift'
      using errcode = '55000';
  end if;
end;
$$;
