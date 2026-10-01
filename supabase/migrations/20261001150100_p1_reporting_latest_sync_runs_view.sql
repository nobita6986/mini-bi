-- =============================================================================
-- P1-T1-W02-R2 — Reporting latest run chính xác (bỏ .limit(5000))
--
-- View service-role-only trả đúng MỘT latest run cho mỗi source với thứ tự
-- deterministic: started_at DESC, run_id DESC (không phụ thuộc giới hạn lịch sử).
--
-- security_invoker = true: RLS của sync_runs áp dụng theo quyền người gọi.
--   - service_role bypass RLS + có SELECT grant => đọc được toàn bộ.
--   - anon/authenticated/public bị revoke grant => không đọc được.
-- Không sửa bảng/RPC ingestion. Idempotent (create or replace + revoke/grant no-op).
-- =============================================================================

create or replace view public.reporting_latest_sync_runs_v01
with (security_invoker = true)
as
select distinct on (source_id)
       source_id,
       run_id,
       status,
       started_at,
       finished_at
  from public.sync_runs
 order by source_id, started_at desc, run_id desc;

comment on view public.reporting_latest_sync_runs_v01 is
  'Latest run cho mỗi source (deterministic: started_at DESC, run_id DESC). '
  'Service-role-only cho reporting BoD P1; không dùng cho ingestion.';

revoke all on public.reporting_latest_sync_runs_v01 from public, anon, authenticated;
grant select on public.reporting_latest_sync_runs_v01 to service_role;
