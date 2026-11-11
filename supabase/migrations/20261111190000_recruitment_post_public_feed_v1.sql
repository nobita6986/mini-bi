-- =============================================================================
-- Public Recruitment Feed v1 (`GET /feeds/jobs.v1.json`)
-- =============================================================================
-- Scope:
--   1. Add partial index `recruitment_project_briefs_published_updated_idx`
--      for single-query read of all currently `PUBLISHED` recruitment posts
--      ordered by `(updated_at desc, brief_id desc)`.
--   2. Add read-only SECURITY DEFINER RPC `public.recruitment_post_public_feed_v1()`
--      that returns `{ "schema_version": 1, "jobs": [...] }` in a single query
--      using an explicit public field allowlist (excluding internal manager
--      contact/name, internal project/location UUIDs, creator/editor/withdrawer
--      identities, and UI action permissions).
--   3. Align RPC owner to `public.direct_entries` owner, revoke all privileges
--      from `public, anon, authenticated, service_role`, grant `EXECUTE` only
--      to `service_role`, and verify invariants fail-closed.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Partial index for single-query public feed ordering on PUBLISHED posts.
-- -----------------------------------------------------------------------------
create index if not exists recruitment_project_briefs_published_updated_idx
  on public.recruitment_project_briefs (updated_at desc, brief_id desc)
  where status = 'PUBLISHED';

-- -----------------------------------------------------------------------------
-- 2. Read-only RPC: `public.recruitment_post_public_feed_v1()`
-- -----------------------------------------------------------------------------
create or replace function public.recruitment_post_public_feed_v1()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select pg_catalog.jsonb_build_object(
    'schema_version', 1,
    'jobs', coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', b.brief_id,
          'brief_id', b.brief_id,
          'version', b.version,
          'published_at', pg_catalog.to_char(b.published_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          'updated_at', pg_catalog.to_char(b.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          'location', pg_catalog.jsonb_build_object(
            'province_code', prov.province_code,
            'province_name', prov.display_name,
            'industrial_park_code', ip.industrial_park_code,
            'industrial_park_name', ip.display_name
          ),
          'general', pg_catalog.jsonb_build_object(
            'customer_name', b.customer_name,
            'investment_origin', b.investment_origin,
            'manufacturing_industry', b.manufacturing_industry,
            'job_description', b.job_description,
            'environment_types', pg_catalog.to_jsonb(b.environment_types),
            'work_postures', pg_catalog.to_jsonb(b.work_postures),
            'shift_pattern', b.shift_pattern,
            'shift_details', b.shift_details,
            'labor_types', coalesce(lt_agg.labor_types, '[]'::jsonb),
            'supply_schedule_text', b.supply_schedule_text,
            'expected_headcount', b.expected_headcount
          ),
          'candidate', pg_catalog.jsonb_build_object(
            'age_min', b.age_min,
            'age_max', b.age_max,
            'gender_requirement', b.gender_requirement,
            'gender_label', case b.gender_requirement
              when 'ANY' then 'Nam/Nữ'
              when 'MALE' then 'Nam'
              when 'FEMALE' then 'Nữ'
            end,
            'education_requirement', b.education_requirement,
            'experience_required', b.experience_required,
            'experience_details', b.experience_details,
            'accept_former_customer_workers', b.accept_former_customer_workers,
            'entry_assessment_text', b.entry_assessment_text,
            'other_requirements_text', b.other_requirements_text
          ),
          'compensation', pg_catalog.jsonb_build_object(
            'base_salary_vnd', b.base_salary_vnd::text,
            'base_salary_conditions', b.base_salary_conditions,
            'attendance_bonus_vnd', b.attendance_bonus_vnd::text,
            'attendance_bonus_conditions', b.attendance_bonus_conditions,
            'living_allowance_vnd', b.living_allowance_vnd::text,
            'living_allowance_conditions', b.living_allowance_conditions,
            'seniority_allowance_vnd', b.seniority_allowance_vnd::text,
            'seniority_allowance_conditions', b.seniority_allowance_conditions,
            'eyesight_allowance_vnd', b.eyesight_allowance_vnd::text,
            'eyesight_allowance_conditions', b.eyesight_allowance_conditions,
            'other_allowance_text', b.other_allowance_text,
            'average_income_min_vnd', b.average_income_min_vnd::text,
            'average_income_max_vnd', b.average_income_max_vnd::text,
            'salary_payment_schedule', b.salary_payment_schedule,
            'salary_advance_available', b.salary_advance_available,
            'salary_advance_amount_vnd', b.salary_advance_amount_vnd::text,
            'salary_advance_schedule', b.salary_advance_schedule,
            'weekly_salary_available', b.weekly_salary_available,
            'weekly_salary_payment_schedule', b.weekly_salary_payment_schedule,
            'day_shift_8h_vnd', b.day_shift_8h_vnd::text,
            'day_shift_11h_vnd', b.day_shift_11h_vnd::text,
            'night_shift_8h_vnd', b.night_shift_8h_vnd::text,
            'night_shift_11h_vnd', b.night_shift_11h_vnd::text,
            'sunday_day_11h_vnd', b.sunday_day_11h_vnd::text,
            'sunday_night_11h_vnd', b.sunday_night_11h_vnd::text,
            'holiday_day_11h_vnd', b.holiday_day_11h_vnd::text,
            'holiday_night_11h_vnd', b.holiday_night_11h_vnd::text,
            'ppe_provided', b.ppe_provided,
            'ppe_details', b.ppe_details,
            'other_benefits', b.other_benefits
          ),
          'documents', pg_catalog.jsonb_build_object(
            'require_original_cccd_and_copy', b.require_original_cccd_and_copy,
            'require_certified_resume', b.require_certified_resume,
            'require_health_certificate_within_6_months', b.require_health_certificate_within_6_months,
            'require_photo_3x4', b.require_photo_3x4,
            'require_degree_or_certificate', b.require_degree_or_certificate,
            'require_social_insurance_book', b.require_social_insurance_book,
            'require_other_documents', b.require_other_documents,
            'other_documents_text', b.other_documents_text
          )
        )
        order by b.updated_at desc, b.brief_id desc
      ),
      '[]'::jsonb
    )
  )
  from public.recruitment_project_briefs b
  join public.industrial_parks ip
    on ip.industrial_park_id = b.industrial_park_id
  join public.administrative_provinces prov
    on prov.province_id = ip.province_id
  left join lateral (
    select pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'labor_type_key', lt.labor_type_key,
               'display_name', lt.display_name
             )
             order by lt.sort_order asc, lt.labor_type_key asc
           ) as labor_types
      from public.recruitment_project_brief_labor_types blt
      join public.direct_entry_labor_types lt
        on lt.labor_type_key = blt.labor_type_key
     where blt.brief_id = b.brief_id
  ) lt_agg on true
  where b.status = 'PUBLISHED';
$function$;

-- -----------------------------------------------------------------------------
-- 3. Align owner and enforce strict RPC ACLs + fail-closed self-check.
-- -----------------------------------------------------------------------------
do $owner_align$
declare
  v_owner name;
begin
  select pg_catalog.pg_get_userbyid(c.relowner)
    into v_owner
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname = 'direct_entries';

  if v_owner is null then
    raise exception 'public.direct_entries owner not found'
      using errcode = '55000';
  end if;

  if v_owner <> current_user
     and pg_catalog.pg_has_role(current_user, v_owner, 'SET') then
    execute pg_catalog.format(
      'alter function public.recruitment_post_public_feed_v1() owner to %I',
      v_owner
    );
  end if;
end;
$owner_align$;

revoke all on function
  public.recruitment_post_public_feed_v1()
from public, anon, authenticated, service_role;

grant execute on function
  public.recruitment_post_public_feed_v1()
to service_role;

do $self_check$
declare
  v_sig constant text := 'public.recruitment_post_public_feed_v1()';
  v_oid oid;
  v_secdef boolean;
  v_config text[];
  v_owner oid;
  v_owner_super boolean;
  v_owner_bypassrls boolean;
begin
  v_oid := pg_catalog.to_regprocedure(v_sig);
  if v_oid is null then
    raise exception 'Public recruitment feed RPC missing: %', v_sig
      using errcode = '55000';
  end if;

  select p.prosecdef, p.proconfig, p.proowner, r.rolsuper, r.rolbypassrls
    into v_secdef, v_config, v_owner, v_owner_super, v_owner_bypassrls
    from pg_catalog.pg_proc p
    join pg_catalog.pg_roles r on r.oid = p.proowner
   where p.oid = v_oid;

  if not coalesce(v_secdef, false) then
    raise exception 'Public recruitment feed RPC is not SECURITY DEFINER: %', v_sig
      using errcode = '55000';
  end if;

  if not coalesce('search_path=pg_catalog, public' = any(v_config), false) then
    raise exception 'Public recruitment feed RPC missing locked search_path: %', v_sig
      using errcode = '55000';
  end if;

  if not (coalesce(v_owner_super, false) or coalesce(v_owner_bypassrls, false)) then
    raise exception 'Public recruitment feed RPC owner lacks BYPASSRLS/superuser: %', v_sig
      using errcode = '55000';
  end if;

  if not pg_catalog.has_function_privilege(v_owner, v_oid, 'EXECUTE') then
    raise exception 'Public recruitment feed RPC owner missing EXECUTE: %', v_sig
      using errcode = '55000';
  end if;

  if pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')
     or pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE')
     or exists (
       select 1
         from pg_catalog.aclexplode(coalesce(
                (select proacl from pg_catalog.pg_proc where oid = v_oid),
                pg_catalog.acldefault('f', v_owner)
              )) a
        where a.grantee = 0
          and a.privilege_type = 'EXECUTE'
     ) then
    raise exception 'Public recruitment feed RPC exposed to anon/authenticated/PUBLIC: %', v_sig
      using errcode = '55000';
  end if;

  if not pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE') then
    raise exception 'Public recruitment feed RPC not granted to service_role: %', v_sig
      using errcode = '55000';
  end if;
end;
$self_check$;

commit;
