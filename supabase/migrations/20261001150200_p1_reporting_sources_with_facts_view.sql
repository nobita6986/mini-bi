-- =============================================================================
-- P1-T1-W02-R3 — Reporting presence (source có fact hiện hành) — bỏ SELECT thô
--
-- View service-role-only trả DISTINCT source_id từ snapshot hiện hành, để server
-- không phải tải toàn bộ fact chỉ để suy ra source nào có dữ liệu.
--
-- security_invoker = true: RLS của daily_recruitment_breakdown áp dụng theo người gọi.
--   - service_role bypass RLS + có SELECT grant => đọc được.
--   - anon/authenticated/public bị revoke grant => không đọc được.
-- Không sửa bảng/RPC ingestion. Idempotent (create or replace + revoke/grant no-op).
-- =============================================================================

create or replace view public.reporting_sources_with_current_facts_v01
with (security_invoker = true)
as
select distinct source_id
  from public.daily_recruitment_breakdown;

comment on view public.reporting_sources_with_current_facts_v01 is
  'DISTINCT source_id có ít nhất một fact trong snapshot hiện hành. '
  'Service-role-only cho reporting BoD P1 (dùng cho hasCurrentFacts).';

revoke all on public.reporting_sources_with_current_facts_v01 from public, anon, authenticated;
grant select on public.reporting_sources_with_current_facts_v01 to service_role;
