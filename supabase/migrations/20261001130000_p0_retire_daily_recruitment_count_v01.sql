-- =============================================================================
-- P0 — Retire contract daily-recruitment-count/0.1
--
-- Change request của T0 (báo cáo phải phân loại theo dự án / người tuyển /
-- HRP-Vendor / loại hình làm việc) thay grain cũ (source, business_date) bằng
-- grain tổng hợp mới. Contract v0.1 bị thay thế hoàn toàn.
--
-- Gỡ boundary và bảng aggregate cũ để không tồn tại hai pipeline song song.
-- Bảng data_sources / sync_runs / sync_errors giữ nguyên (không phụ thuộc grain).
--
-- Chỉ áp dụng trên DEV. PROD chưa từng được provision với schema v0.1.
-- =============================================================================

drop function if exists public.replace_daily_recruitment_snapshot_v01(jsonb);
drop function if exists public.reject_daily_recruitment_snapshot_v01(text, uuid, text, timestamptz, integer, integer, integer, text, text);

-- Bảng aggregate v0.1: grain cũ không còn được dùng.
drop table if exists public.daily_recruitment_counts;
