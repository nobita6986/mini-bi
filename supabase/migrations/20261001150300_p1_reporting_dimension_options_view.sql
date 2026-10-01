-- =============================================================================
-- P1-T1-W04 — Reporting dimension option catalog (filter dropdown cho dashboard)
--
-- View service-role-only trả danh mục project/recruiter/provider/employment từ
-- snapshot hiện hành, chỉ trong reporting scope (active=true AND is_test=false).
--
-- Mỗi row = (dimension, key, display, recruited_count). recruited_count là weight
-- tổng hợp (SUM) theo (dimension, key, display) để server chọn display theo đúng
-- quy tắc: tổng recruited_count lớn nhất; hòa thì localeCompare("vi"); sentinel cố định.
--
-- security_invoker = true: RLS của bảng áp dụng theo người gọi; anon/authenticated/public
-- bị revoke grant. Không sửa bảng/RPC ingestion. Idempotent.
-- =============================================================================

create or replace view public.reporting_dimension_options_v01
with (security_invoker = true)
as
select 'project' as dimension,
       b.project_key as key,
       b.project_display as display,
       sum(b.recruited_count)::integer as recruited_count
  from public.daily_recruitment_breakdown b
  join public.data_sources s on s.id = b.source_id
 where s.active = true and s.is_test = false
 group by b.project_key, b.project_display
union all
select 'recruiter', b.recruiter_key, b.recruiter_display, sum(b.recruited_count)::integer
  from public.daily_recruitment_breakdown b
  join public.data_sources s on s.id = b.source_id
 where s.active = true and s.is_test = false
 group by b.recruiter_key, b.recruiter_display
union all
select 'provider', b.provider_type_key, b.provider_type_display, sum(b.recruited_count)::integer
  from public.daily_recruitment_breakdown b
  join public.data_sources s on s.id = b.source_id
 where s.active = true and s.is_test = false
 group by b.provider_type_key, b.provider_type_display
union all
select 'employment', b.employment_type_key, b.employment_type_display, sum(b.recruited_count)::integer
  from public.daily_recruitment_breakdown b
  join public.data_sources s on s.id = b.source_id
 where s.active = true and s.is_test = false
 group by b.employment_type_key, b.employment_type_display;

comment on view public.reporting_dimension_options_v01 is
  'Danh mục dimension (project/recruiter/provider/employment) trong reporting scope, '
  'có weight recruited_count để chọn display. Service-role-only cho dashboard P1.';

revoke all on public.reporting_dimension_options_v01 from public, anon, authenticated;
grant select on public.reporting_dimension_options_v01 to service_role;
