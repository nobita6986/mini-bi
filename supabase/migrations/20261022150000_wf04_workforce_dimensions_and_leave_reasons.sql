-- MBI-DA-2026-01 Chặng 2 / WF-04 (Items 2.7 & 2.8):
--   2.7 Workforce Quality by Recruiter / Team / HRP-Vendor / Project (`dimensions`):
--       evaluates actor-scoped eligible episodes as-of D across 4 dimensions (`recruiter`, `team`,
--       `provider`, `project`), reconciling 100% of bucket counts with `snapshot`, `waiting`, `duration`,
--       and `retention` (including explicit `unknown` buckets for missing/unclassified attribution and
--       explicit `(Ngừng hoạt động)` labeling for inactive teams).
--   2.8 Leave Reason Analysis (`leave_reasons`):
--       classifies worker leave reasons strictly from `direct_entry_employment_status_events.leave_reason_text`
--       on non-superseded `OFF` events (never reading `direct_entry_restricted_reasons` action reasons or
--       `direct_entries.general_note`, and never exposing raw free-text / PII in the aggregate payload)
--       into canonical business categories plus `unclassified_free_text` and `missing_or_unknown` for both
--       the `as_of` OFF snapshot and `[from, to]` in-period OFF transitions.
begin;

create or replace function public.direct_entry_workforce_reporting_scoped(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_filters jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_audience jsonb;
  v_filters jsonb := coalesce(p_filters, '{}'::jsonb);
  v_from_text text;
  v_to_text text;
  v_as_of_text text;
  v_from date;
  v_to date;
  v_open_as_of date;
  v_as_of_override date;
  v_today date;
  v_as_of date;
  v_as_of_source text;
  v_project text;
  v_recruiter text;
  v_provider text;
  v_employment text;
  v_team_bucket text;
  v_team_code text;
  v_result jsonb;
begin
  v_audience := public.direct_entry_reporting_resolve_audience(p_auth_subject, p_app_user_id);

  if jsonb_typeof(v_filters) <> 'object' then
    raise exception 'invalid reporting filters' using errcode = '22023';
  end if;

  v_from_text := nullif(btrim(v_filters->>'from'), '');
  if v_from_text is not null then
    if v_from_text !~ '^\d{4}-\d{2}-\d{2}$' then
      raise exception 'invalid from date' using errcode = '22023';
    end if;
    begin
      v_from := v_from_text::date;
    exception when others then
      raise exception 'invalid from date' using errcode = '22023';
    end;
    if to_char(v_from, 'YYYY-MM-DD') <> v_from_text then
      raise exception 'invalid from date' using errcode = '22023';
    end if;
  end if;

  v_to_text := nullif(btrim(v_filters->>'to'), '');
  if v_to_text is not null then
    if v_to_text !~ '^\d{4}-\d{2}-\d{2}$' then
      raise exception 'invalid to date' using errcode = '22023';
    end if;
    begin
      v_to := v_to_text::date;
    exception when others then
      raise exception 'invalid to date' using errcode = '22023';
    end;
    if to_char(v_to, 'YYYY-MM-DD') <> v_to_text then
      raise exception 'invalid to date' using errcode = '22023';
    end if;
  end if;

  if v_from is not null and v_to is not null and v_from > v_to then
    raise exception 'from must be <= to' using errcode = '22023';
  end if;

  if v_from is not null and v_to is not null then
    v_open_as_of := (v_from - 1);
  end if;

  v_as_of_text := nullif(btrim(v_filters->>'as_of'), '');
  if v_as_of_text is not null then
    if v_as_of_text !~ '^\d{4}-\d{2}-\d{2}$' then
      raise exception 'invalid as_of date' using errcode = '22023';
    end if;
    begin
      v_as_of_override := v_as_of_text::date;
    exception when others then
      raise exception 'invalid as_of date' using errcode = '22023';
    end;
    if to_char(v_as_of_override, 'YYYY-MM-DD') <> v_as_of_text then
      raise exception 'invalid as_of date' using errcode = '22023';
    end if;
  end if;

  v_today := public.direct_entry_authorization_date();
  v_as_of := coalesce(v_as_of_override, v_to, v_today);
  v_as_of_source := case
    when v_as_of_override is not null then 'explicit_as_of'
    when v_to is not null then 'filter_to'
    else 'current_hcm_date'
  end;

  v_project := nullif(btrim(v_filters->>'project'), '');
  v_recruiter := nullif(btrim(v_filters->>'recruiter'), '');
  v_provider := nullif(btrim(v_filters->>'provider'), '');
  v_employment := nullif(btrim(v_filters->>'employment'), '');

  v_team_bucket := nullif(btrim(v_filters->>'team_bucket'), '');
  if v_team_bucket is not null then
    if v_audience->>'audience' = 'own' then
      raise exception 'team bucket not allowed for own scope' using errcode = '42501';
    end if;
    if v_team_bucket = 'unknown' then
      if v_audience->>'audience' <> 'all' then
        raise exception 'unknown team bucket requires all scope' using errcode = '42501';
      end if;
    elsif v_team_bucket like 'team:%' and char_length(v_team_bucket) > 5 then
      v_team_code := substring(v_team_bucket from 6);
      if v_audience->>'audience' = 'team' then
        if not exists (
          select 1
          from public.teams t
          where t.code = v_team_code
            and t.team_id in (
              select (x#>>'{}')::uuid
              from jsonb_array_elements(coalesce(v_audience->'team_ids', '[]'::jsonb)) x
            )
        ) then
          raise exception 'team bucket out of scope' using errcode = '42501';
        end if;
      end if;
    else
      raise exception 'invalid team_bucket filter' using errcode = '22023';
    end if;
  end if;

  with authorized as (
    select a.entry_id
    from public.direct_entry_reporting_authorized_entries(p_auth_subject, p_app_user_id) a
  ),
  scoped_episodes as (
    select
      f.entry_id,
      f.first_work_date,
      case
        when nullif(btrim(coalesce(f.recruiter_key, '')), '') is null
          or lower(btrim(f.recruiter_key)) = 'unknown'
        then 'unknown'
        else lower(btrim(f.recruiter_key))
      end as recruiter_dim_key,
      case
        when nullif(btrim(coalesce(f.recruiter_key, '')), '') is null
          or lower(btrim(f.recruiter_key)) = 'unknown'
        then 'Không xác định'
        else coalesce(nullif(btrim(f.recruiter_display), ''), lower(btrim(f.recruiter_key)))
      end as recruiter_dim_display,
      (
        nullif(btrim(coalesce(f.recruiter_key, '')), '') is null
        or lower(btrim(f.recruiter_key)) = 'unknown'
      ) as recruiter_is_unknown,

      case
        when nullif(btrim(coalesce(f.team_code, '')), '') is null
          or lower(btrim(f.team_code)) = 'unknown'
        then 'unknown'
        else lower(btrim(f.team_code))
      end as team_dim_key,
      case
        when nullif(btrim(coalesce(f.team_code, '')), '') is null
          or lower(btrim(f.team_code)) = 'unknown'
        then 'Chưa phân nhóm / Không xác định'
        when f.team_active is false
        then coalesce(nullif(btrim(f.team_display_name), ''), btrim(f.team_code)) || ' (Ngừng hoạt động)'
        else coalesce(nullif(btrim(f.team_display_name), ''), btrim(f.team_code))
      end as team_dim_display,
      (
        nullif(btrim(coalesce(f.team_code, '')), '') is null
        or lower(btrim(f.team_code)) = 'unknown'
      ) as team_is_unknown,
      case
        when nullif(btrim(coalesce(f.team_code, '')), '') is null
          or lower(btrim(f.team_code)) = 'unknown'
        then null::boolean
        else coalesce(f.team_active, true)
      end as team_dim_active,

      case
        when lower(btrim(coalesce(f.provider_type_key, ''))) in ('hrp', 'vendor')
        then lower(btrim(f.provider_type_key))
        else 'unknown'
      end as provider_dim_key,
      case
        when lower(btrim(coalesce(f.provider_type_key, ''))) = 'hrp' then 'HRP'
        when lower(btrim(coalesce(f.provider_type_key, ''))) = 'vendor' then 'Vendor'
        else 'Không xác định'
      end as provider_dim_display,
      (
        lower(btrim(coalesce(f.provider_type_key, ''))) not in ('hrp', 'vendor')
      ) as provider_is_unknown,

      case
        when nullif(btrim(coalesce(f.project_key, '')), '') is null
          or lower(btrim(f.project_key)) = 'unknown'
        then 'unknown'
        else lower(btrim(f.project_key))
      end as project_dim_key,
      case
        when nullif(btrim(coalesce(f.project_key, '')), '') is null
          or lower(btrim(f.project_key)) = 'unknown'
        then 'Không xác định'
        else coalesce(nullif(btrim(f.project_display), ''), lower(btrim(f.project_key)))
      end as project_dim_display,
      (
        nullif(btrim(coalesce(f.project_key, '')), '') is null
        or lower(btrim(f.project_key)) = 'unknown'
      ) as project_is_unknown
    from authorized a
    join public.direct_entry_reporting_facts_v01 f on f.entry_id = a.entry_id
    join public.direct_entries de on de.entry_id = f.entry_id
    join public.direct_entry_submissions ds on ds.submission_id = de.submission_id
    where ds.state = 'SUBMITTED'
      and de.deleted_at is null
      and de.voided_at is null
      and (v_project is null or f.project_key = v_project)
      and (v_recruiter is null or f.recruiter_key = v_recruiter)
      and (v_provider is null or f.provider_type_key = v_provider)
      and (v_employment is null or f.employment_type_key = v_employment)
      and (
        v_team_bucket is null
        or (v_team_bucket = 'unknown' and f.team_code is null)
        or (v_team_bucket like 'team:%' and f.team_code = v_team_code)
      )
  ),
  active_events as (
    select
      ev.event_id,
      ev.entry_id,
      ev.status,
      ev.effective_date,
      ev.version,
      lag(ev.status) over (
        partition by ev.entry_id
        order by ev.effective_date asc, ev.version asc
      ) as prev_status,
      case
        when ev.status <> 'OFF' then null
        when nullif(btrim(coalesce(ev.leave_reason_text, '')), '') is null then 'missing_or_unknown'
        when lower(btrim(ev.leave_reason_text)) ~ '^(chưa rõ|chua ro|không rõ|khong ro|chưa xác định|chua xac dinh|không xác định|khong xac dinh|chưa biết|chua biet|không biết|khong biet|n/a|na|-|\?|\.+)$'
          or lower(btrim(ev.leave_reason_text)) ~ '(chưa rõ lý do|chua ro ly do|không rõ lý do|khong ro ly do)'
          then 'missing_or_unknown'
        when lower(btrim(ev.leave_reason_text)) ~ '(gia đình|gia dinh|cá nhân|ca nhan|việc riêng|viec rieng|con nhỏ|con nho|chăm con|cham con|chăm bố|cham bo|chăm mẹ|cham me|kết hôn|ket hon|đám cưới|dam cuoi|thai sản|thai san|sinh con|về quê|ve que)'
          then 'personal_or_family'
        when lower(btrim(ev.leave_reason_text)) ~ '(sức khỏe|suc khoe|ốm đau|om dau|bị ốm|bi om|bệnh|benh|tai nạn|tai nan|điều trị|dieu tri|nhập viện|nhap vien|khám bệnh|kham benh|đau lưng|dau lung|dị ứng|di ung|không đủ sức|khong du suc)'
          then 'health'
        when lower(btrim(ev.leave_reason_text)) ~ '(lương|luong|thu nhập|thu nhap|chế độ|che do|phụ cấp|phu cap|thưởng|thuong|bảo hiểm|bao hiem|bhxh|công nợ|cong no|chậm lương|cham luong)'
          then 'compensation_or_benefits'
        when lower(btrim(ev.leave_reason_text)) ~ '(ca đêm|ca dem|xoay ca|tăng ca|tang ca|áp lực|ap luc|nặng nhọc|nang nhoc|vất vả|vat va|môi trường|moi truong|không hợp việc|khong hop viec|không phù hợp|khong phu hop|tiếng ồn|tieng on|đứng nhiều|dung nhieu|công việc nặng|cong viec nang)'
          then 'work_conditions_or_shift'
        when lower(btrim(ev.leave_reason_text)) ~ '(xa nhà|xa nha|đi lại|di lai|chỗ ở|cho o|phòng trọ|phong tro|nhà trọ|nha tro|chuyển chỗ|chuyen cho|chuyển nhà|chuyen nha|xe đưa đón|xe dua don|tuyến xe|tuyen xe|khoảng cách|khoang cach)'
          then 'relocation_or_distance'
        when lower(btrim(ev.leave_reason_text)) ~ '(hết hạn|het han|hết hợp đồng|het hop dong|kết thúc dự án|ket thuc du an|kết thúc đợt|ket thuc dot|hết việc|het viec|giảm sản lượng|giam san luong|cắt giảm|cat giam|hoàn thành đợt|hoan thanh dot|hết thời vụ|het thoi vu)'
          then 'contract_or_project_end'
        when lower(btrim(ev.leave_reason_text)) ~ '(kỷ luật|ky luat|vi phạm|vi pham|tự ý nghỉ|tu y nghi|bỏ việc|bo viec|không báo trước|khong bao truoc|không đạt|khong dat|sa thải|sa thai|nghỉ quá ngày|nghi qua ngay|nội quy|noi quy)'
          then 'discipline_or_performance'
        when lower(btrim(ev.leave_reason_text)) ~ '(đi học|di hoc|nhập học|nhap hoc|nhập ngũ|nhap ngu|nghĩa vụ|nghia vu|chuyển công ty|chuyen cong ty|công việc mới|cong viec moi|tìm việc khác|tim viec khac|đổi nghề|doi nghe)'
          then 'other_career_or_study'
        else 'unclassified_free_text'
      end as leave_reason_category
    from public.direct_entry_employment_status_events ev
    join scoped_episodes ep on ep.entry_id = ev.entry_id
    where not exists (
      select 1
      from public.direct_entry_employment_status_events r
      where r.supersedes_event_id = ev.event_id
    )
  ),
  snapshot_rows as (
    select
      ep.entry_id,
      case
        when ep.first_work_date > v_as_of then 'FUTURE'
        when latest_ev.status in ('ON', 'UNCONFIRMED', 'OFF') then latest_ev.status
        else 'UNKNOWN'
      end as as_of_status,
      case
        when ep.first_work_date <= v_as_of and latest_ev.status = 'OFF'
        then coalesce(latest_ev.leave_reason_category, 'missing_or_unknown')
        else null
      end as as_of_leave_reason_category
    from scoped_episodes ep
    left join lateral (
      select ev.status, ev.leave_reason_category
      from active_events ev
      where ev.entry_id = ep.entry_id
        and ev.effective_date <= v_as_of
      order by ev.effective_date desc, ev.version desc
      limit 1
    ) latest_ev on ep.first_work_date <= v_as_of
  ),
  snapshot_agg as (
    select
      count(*) filter (where sr.as_of_status <> 'FUTURE')::int as eligible_episode_total,
      count(*) filter (where sr.as_of_status = 'ON')::int as on_count,
      count(*) filter (where sr.as_of_status = 'UNCONFIRMED')::int as unconfirmed_count,
      count(*) filter (where sr.as_of_status = 'OFF')::int as off_count,
      count(*) filter (where sr.as_of_status = 'UNKNOWN')::int as unknown_count,
      count(*) filter (where sr.as_of_status = 'FUTURE')::int as future_episode_count
    from snapshot_rows sr
  ),
  period_events as (
    select
      ev.event_id,
      ev.entry_id,
      ev.prev_status,
      ev.status,
      ev.leave_reason_category
    from active_events ev
    join scoped_episodes ep on ep.entry_id = ev.entry_id
    where v_from is not null
      and v_to is not null
      and ep.first_work_date <= v_to
      and ev.effective_date >= v_from
      and ev.effective_date <= v_to
  ),
  transitions_agg as (
    select
      count(*) filter (where pe.prev_status is null and pe.status in ('ON', 'UNCONFIRMED'))::int as initial_total_event_count,
      count(distinct pe.entry_id) filter (where pe.prev_status is null and pe.status in ('ON', 'UNCONFIRMED'))::int as initial_total_episode_count,
      count(*) filter (where pe.prev_status is null and pe.status = 'ON')::int as initial_on_event_count,
      count(distinct pe.entry_id) filter (where pe.prev_status is null and pe.status = 'ON')::int as initial_on_episode_count,
      count(*) filter (where pe.prev_status is null and pe.status = 'UNCONFIRMED')::int as initial_unconfirmed_event_count,
      count(distinct pe.entry_id) filter (where pe.prev_status is null and pe.status = 'UNCONFIRMED')::int as initial_unconfirmed_episode_count,
      count(*) filter (where pe.prev_status = 'UNCONFIRMED' and pe.status = 'ON')::int as unconfirmed_to_on_event_count,
      count(distinct pe.entry_id) filter (where pe.prev_status = 'UNCONFIRMED' and pe.status = 'ON')::int as unconfirmed_to_on_episode_count,
      count(*) filter (where pe.prev_status = 'UNCONFIRMED' and pe.status = 'OFF')::int as unconfirmed_to_off_event_count,
      count(distinct pe.entry_id) filter (where pe.prev_status = 'UNCONFIRMED' and pe.status = 'OFF')::int as unconfirmed_to_off_episode_count,
      count(*) filter (where pe.prev_status = 'ON' and pe.status = 'OFF')::int as on_to_off_event_count,
      count(distinct pe.entry_id) filter (where pe.prev_status = 'ON' and pe.status = 'OFF')::int as on_to_off_episode_count,
      count(*) filter (where pe.prev_status = 'OFF' and pe.status = 'ON')::int as off_to_on_event_count,
      count(distinct pe.entry_id) filter (where pe.prev_status = 'OFF' and pe.status = 'ON')::int as off_to_on_episode_count,
      count(*) filter (
        where pe.prev_status is not null
          and pe.prev_status <> pe.status
          and not (
            (pe.prev_status = 'UNCONFIRMED' and pe.status in ('ON', 'OFF'))
            or (pe.prev_status = 'ON' and pe.status = 'OFF')
            or (pe.prev_status = 'OFF' and pe.status = 'ON')
          )
      )::int as other_transition_event_count,
      count(distinct pe.entry_id) filter (
        where pe.prev_status is not null
          and pe.prev_status <> pe.status
          and not (
            (pe.prev_status = 'UNCONFIRMED' and pe.status in ('ON', 'OFF'))
            or (pe.prev_status = 'ON' and pe.status = 'OFF')
            or (pe.prev_status = 'OFF' and pe.status = 'ON')
          )
      )::int as other_transition_episode_count,
      count(*) filter (where pe.prev_status is not null and pe.prev_status <> pe.status)::int as total_transition_event_count,
      count(distinct pe.entry_id) filter (where pe.prev_status is not null and pe.prev_status <> pe.status)::int as total_transition_episode_count,
      count(*) filter (where pe.prev_status is not null and pe.prev_status = pe.status)::int as noop_repeat_event_count,
      count(distinct pe.entry_id) filter (where pe.prev_status is not null and pe.prev_status = pe.status)::int as noop_repeat_episode_count
    from period_events pe
  ),
  -- WF-02 (2.3): Opening (from - 1 day) & Closing (to) snapshots and per-status balance flows
  opening_snapshot_rows as (
    select
      ep.entry_id,
      ep.first_work_date,
      case
        when v_open_as_of is null then null
        when ep.first_work_date > v_open_as_of then 'FUTURE'
        when open_ev.status in ('ON', 'UNCONFIRMED', 'OFF') then open_ev.status
        else 'UNKNOWN'
      end as open_status
    from scoped_episodes ep
    left join lateral (
      select ev.status
      from active_events ev
      where ev.entry_id = ep.entry_id
        and v_open_as_of is not null
        and ev.effective_date <= v_open_as_of
      order by ev.effective_date desc, ev.version desc
      limit 1
    ) open_ev on v_open_as_of is not null and ep.first_work_date <= v_open_as_of
  ),
  closing_snapshot_rows as (
    select
      ep.entry_id,
      ep.first_work_date,
      case
        when v_to is null then null
        when ep.first_work_date > v_to then 'FUTURE'
        when close_ev.status in ('ON', 'UNCONFIRMED', 'OFF') then close_ev.status
        else 'UNKNOWN'
      end as close_status
    from scoped_episodes ep
    left join lateral (
      select ev.status
      from active_events ev
      where ev.entry_id = ep.entry_id
        and v_to is not null
        and ev.effective_date <= v_to
      order by ev.effective_date desc, ev.version desc
      limit 1
    ) close_ev on v_to is not null and ep.first_work_date <= v_to
  ),
  opening_snapshot_agg as (
    select
      count(*) filter (where osr.open_status is not null and osr.open_status <> 'FUTURE')::int as eligible_episode_total,
      count(*) filter (where osr.open_status = 'ON')::int as on_count,
      count(*) filter (where osr.open_status = 'UNCONFIRMED')::int as unconfirmed_count,
      count(*) filter (where osr.open_status = 'OFF')::int as off_count,
      count(*) filter (where osr.open_status = 'UNKNOWN')::int as unknown_count,
      count(*) filter (where osr.open_status = 'FUTURE')::int as future_episode_count
    from opening_snapshot_rows osr
  ),
  closing_snapshot_agg as (
    select
      count(*) filter (where csr.close_status is not null and csr.close_status <> 'FUTURE')::int as eligible_episode_total,
      count(*) filter (where csr.close_status = 'ON')::int as on_count,
      count(*) filter (where csr.close_status = 'UNCONFIRMED')::int as unconfirmed_count,
      count(*) filter (where csr.close_status = 'OFF')::int as off_count,
      count(*) filter (where csr.close_status = 'UNKNOWN')::int as unknown_count,
      count(*) filter (where csr.close_status = 'FUTURE')::int as future_episode_count
    from closing_snapshot_rows csr
  ),
  balance_episode_base as (
    select
      ep.entry_id,
      ep.first_work_date,
      (ep.first_work_date >= v_from) as is_new_in_period,
      case
        when ep.first_work_date < v_from then null
        when pre_ev.status in ('ON', 'UNCONFIRMED', 'OFF') then pre_ev.status
        when first_in_period_ev.status in ('ON', 'UNCONFIRMED', 'OFF') then first_in_period_ev.status
        else 'UNKNOWN'
      end as new_entry_status,
      case
        when ep.first_work_date >= v_from
             and pre_ev.event_id is null
             and first_in_period_ev.event_id is not null then first_in_period_ev.event_id
        else null
      end as consumed_initial_event_id
    from scoped_episodes ep
    left join lateral (
      select ev.event_id, ev.status
      from active_events ev
      where ev.entry_id = ep.entry_id
        and ev.effective_date < v_from
      order by ev.effective_date desc, ev.version desc
      limit 1
    ) pre_ev on ep.first_work_date >= v_from
    left join lateral (
      select ev.event_id, ev.status
      from active_events ev
      where ev.entry_id = ep.entry_id
        and ev.effective_date >= v_from
        and ev.effective_date <= v_to
      order by ev.effective_date asc, ev.version asc
      limit 1
    ) first_in_period_ev on ep.first_work_date >= v_from
    where v_from is not null
      and v_to is not null
      and ep.first_work_date <= v_to
  ),
  balance_new_agg as (
    select
      count(*) filter (where b.is_new_in_period)::int as new_total_count,
      count(*) filter (where b.is_new_in_period and b.new_entry_status = 'ON')::int as new_on_count,
      count(*) filter (where b.is_new_in_period and b.new_entry_status = 'UNCONFIRMED')::int as new_unconfirmed_count,
      count(*) filter (where b.is_new_in_period and b.new_entry_status = 'OFF')::int as new_off_count,
      count(*) filter (where b.is_new_in_period and b.new_entry_status = 'UNKNOWN')::int as new_unknown_count
    from balance_episode_base b
  ),
  balance_transition_steps as (
    select
      ev.event_id,
      ev.entry_id,
      case
        when ev.prev_status in ('ON', 'UNCONFIRMED', 'OFF') then ev.prev_status
        else 'UNKNOWN'
      end as from_status,
      case
        when ev.status in ('ON', 'UNCONFIRMED', 'OFF') then ev.status
        else 'UNKNOWN'
      end as to_status
    from balance_episode_base b
    join active_events ev on ev.entry_id = b.entry_id
    where ev.effective_date >= v_from
      and ev.effective_date <= v_to
      and (b.consumed_initial_event_id is null or ev.event_id <> b.consumed_initial_event_id)
  ),
  balance_flows_agg as (
    select
      count(*) filter (where s.from_status <> 'ON' and s.to_status = 'ON')::int as on_trans_in,
      count(*) filter (where s.from_status = 'UNCONFIRMED' and s.to_status = 'ON')::int as on_in_from_unconfirmed,
      count(*) filter (where s.from_status = 'OFF' and s.to_status = 'ON')::int as on_in_from_off,
      count(*) filter (where s.from_status = 'UNKNOWN' and s.to_status = 'ON')::int as on_in_from_unknown,
      count(*) filter (where s.from_status = 'ON' and s.to_status <> 'ON')::int as on_trans_out,
      count(*) filter (where s.from_status = 'ON' and s.to_status = 'OFF')::int as on_out_to_off,
      count(*) filter (where s.from_status = 'ON' and s.to_status = 'UNCONFIRMED')::int as on_out_to_unconfirmed,

      count(*) filter (where s.from_status <> 'UNCONFIRMED' and s.to_status = 'UNCONFIRMED')::int as unconfirmed_trans_in,
      count(*) filter (where s.from_status = 'ON' and s.to_status = 'UNCONFIRMED')::int as unconfirmed_in_from_on,
      count(*) filter (where s.from_status = 'OFF' and s.to_status = 'UNCONFIRMED')::int as unconfirmed_in_from_off,
      count(*) filter (where s.from_status = 'UNKNOWN' and s.to_status = 'UNCONFIRMED')::int as unconfirmed_in_from_unknown,
      count(*) filter (where s.from_status = 'UNCONFIRMED' and s.to_status <> 'UNCONFIRMED')::int as unconfirmed_trans_out,
      count(*) filter (where s.from_status = 'UNCONFIRMED' and s.to_status = 'ON')::int as unconfirmed_out_to_on,
      count(*) filter (where s.from_status = 'UNCONFIRMED' and s.to_status = 'OFF')::int as unconfirmed_out_to_off,

      count(*) filter (where s.from_status <> 'OFF' and s.to_status = 'OFF')::int as off_trans_in,
      count(*) filter (where s.from_status = 'ON' and s.to_status = 'OFF')::int as off_in_from_on,
      count(*) filter (where s.from_status = 'UNCONFIRMED' and s.to_status = 'OFF')::int as off_in_from_unconfirmed,
      count(*) filter (where s.from_status = 'UNKNOWN' and s.to_status = 'OFF')::int as off_in_from_unknown,
      count(*) filter (where s.from_status = 'OFF' and s.to_status <> 'OFF')::int as off_trans_out,
      count(*) filter (where s.from_status = 'OFF' and s.to_status = 'ON')::int as off_out_to_on,
      count(*) filter (where s.from_status = 'OFF' and s.to_status = 'UNCONFIRMED')::int as off_out_to_unconfirmed,

      count(*) filter (where s.from_status <> 'UNKNOWN' and s.to_status = 'UNKNOWN')::int as unknown_trans_in,
      count(*) filter (where s.from_status = 'UNKNOWN' and s.to_status <> 'UNKNOWN')::int as unknown_trans_out,
      count(*) filter (where s.from_status = 'UNKNOWN' and s.to_status = 'ON')::int as unknown_out_to_on,
      count(*) filter (where s.from_status = 'UNKNOWN' and s.to_status = 'UNCONFIRMED')::int as unknown_out_to_unconfirmed,
      count(*) filter (where s.from_status = 'UNKNOWN' and s.to_status = 'OFF')::int as unknown_out_to_off
    from balance_transition_steps s
  ),
  -- WF-02 (2.4) & WF-03 (2.5, 2.6): Distinct state change chain up to v_as_of (collapsing no-op repeats)
  as_of_distinct_state_events as (
    select
      ev.event_id,
      ev.entry_id,
      ev.status,
      ev.effective_date,
      ev.version,
      ev.prev_status,
      lead(ev.effective_date) over (
        partition by ev.entry_id
        order by ev.effective_date asc, ev.version asc
      ) as next_effective_date,
      lead(ev.status) over (
        partition by ev.entry_id
        order by ev.effective_date asc, ev.version asc
      ) as next_status
    from active_events ev
    join scoped_episodes ep on ep.entry_id = ev.entry_id
    where ep.first_work_date <= v_as_of
      and ev.effective_date <= v_as_of
      and (ev.prev_status is null or ev.prev_status <> ev.status)
  ),
  as_of_waiting_intervals as (
    select
      dse.entry_id,
      dse.event_id,
      dse.effective_date as start_date,
      coalesce(dse.next_effective_date, v_as_of) as end_date,
      (dse.next_effective_date is not null) as is_completed,
      dse.next_status,
      greatest(0, (coalesce(dse.next_effective_date, v_as_of) - dse.effective_date)::int) as waiting_days
    from as_of_distinct_state_events dse
    where dse.status = 'UNCONFIRMED'
  ),
  as_of_waiting_episodes as (
    select
      wi.entry_id,
      sr.as_of_status,
      count(*)::int as interval_count,
      sum(wi.waiting_days)::int as total_waiting_days,
      bool_or(wi.is_completed and wi.next_status = 'ON') as placed_to_on
    from as_of_waiting_intervals wi
    join snapshot_rows sr on sr.entry_id = wi.entry_id
    group by wi.entry_id, sr.as_of_status
  ),
  as_of_episode_entry_mode as (
    select
      sr.entry_id,
      sr.as_of_status,
      first_ev.status as initial_status,
      exists (
        select 1
        from as_of_waiting_episodes we
        where we.entry_id = sr.entry_id
      ) as had_waiting
    from snapshot_rows sr
    left join lateral (
      select dse.status
      from as_of_distinct_state_events dse
      where dse.entry_id = sr.entry_id
      order by dse.effective_date asc, dse.version asc
      limit 1
    ) first_ev on true
    where sr.as_of_status <> 'FUTURE'
  ),
  as_of_entry_mode_agg as (
    select
      count(*) filter (where em.had_waiting)::int as waiting_episode_total,
      count(*) filter (where not em.had_waiting and em.initial_status = 'ON')::int as direct_on_episode_count,
      count(*) filter (where not em.had_waiting and em.initial_status = 'OFF')::int as direct_off_episode_count,
      count(*) filter (where not em.had_waiting and em.as_of_status = 'UNKNOWN')::int as unknown_episode_count
    from as_of_episode_entry_mode em
  ),
  as_of_waiting_samples_agg as (
    select
      count(*)::int as all_ep_count,
      coalesce(sum(we.interval_count), 0)::int as all_interval_count,
      coalesce(sum(we.total_waiting_days), 0)::int as all_waiting_days,
      max(we.total_waiting_days)::int as all_max_waiting_days,

      count(*) filter (where we.as_of_status <> 'UNCONFIRMED')::int as completed_ep_count,
      coalesce(sum(we.interval_count) filter (where we.as_of_status <> 'UNCONFIRMED'), 0)::int as completed_interval_count,
      coalesce(sum(we.total_waiting_days) filter (where we.as_of_status <> 'UNCONFIRMED'), 0)::int as completed_waiting_days,
      max(we.total_waiting_days) filter (where we.as_of_status <> 'UNCONFIRMED')::int as completed_max_waiting_days,

      count(*) filter (where we.as_of_status <> 'UNCONFIRMED' and we.placed_to_on)::int as placed_ep_count,
      coalesce(sum(we.interval_count) filter (where we.as_of_status <> 'UNCONFIRMED' and we.placed_to_on), 0)::int as placed_interval_count,
      coalesce(sum(we.total_waiting_days) filter (where we.as_of_status <> 'UNCONFIRMED' and we.placed_to_on), 0)::int as placed_waiting_days,
      max(we.total_waiting_days) filter (where we.as_of_status <> 'UNCONFIRMED' and we.placed_to_on)::int as placed_max_waiting_days,

      count(*) filter (where we.as_of_status <> 'UNCONFIRMED' and not we.placed_to_on)::int as exited_ep_count,
      coalesce(sum(we.interval_count) filter (where we.as_of_status <> 'UNCONFIRMED' and not we.placed_to_on), 0)::int as exited_interval_count,
      coalesce(sum(we.total_waiting_days) filter (where we.as_of_status <> 'UNCONFIRMED' and not we.placed_to_on), 0)::int as exited_waiting_days,
      max(we.total_waiting_days) filter (where we.as_of_status <> 'UNCONFIRMED' and not we.placed_to_on)::int as exited_max_waiting_days,

      count(*) filter (where we.as_of_status = 'UNCONFIRMED')::int as current_ep_count,
      coalesce(sum(we.interval_count) filter (where we.as_of_status = 'UNCONFIRMED'), 0)::int as current_interval_count,
      coalesce(sum(we.total_waiting_days) filter (where we.as_of_status = 'UNCONFIRMED'), 0)::int as current_waiting_days,
      max(we.total_waiting_days) filter (where we.as_of_status = 'UNCONFIRMED')::int as current_max_waiting_days
    from as_of_waiting_episodes we
  ),
  period_distinct_state_events as (
    select
      ev.event_id,
      ev.entry_id,
      ev.status,
      ev.effective_date,
      ev.version,
      lead(ev.effective_date) over (
        partition by ev.entry_id
        order by ev.effective_date asc, ev.version asc
      ) as next_effective_date,
      lead(ev.status) over (
        partition by ev.entry_id
        order by ev.effective_date asc, ev.version asc
      ) as next_status
    from active_events ev
    join scoped_episodes ep on ep.entry_id = ev.entry_id
    where v_from is not null
      and v_to is not null
      and ep.first_work_date <= v_to
      and ev.effective_date <= v_to
      and (ev.prev_status is null or ev.prev_status <> ev.status)
  ),
  period_waiting_intervals as (
    select
      pdse.entry_id,
      pdse.effective_date as start_date,
      coalesce(pdse.next_effective_date, v_to) as end_date,
      pdse.next_effective_date,
      pdse.next_status,
      greatest(0, (coalesce(pdse.next_effective_date, v_to) - pdse.effective_date)::int) as full_interval_waiting_days,
      greatest(
        0,
        (least(coalesce(pdse.next_effective_date, v_to), v_to) - greatest(pdse.effective_date, v_from))::int
      ) as clipped_period_waiting_days,
      (pdse.effective_date <= v_to and coalesce(pdse.next_effective_date, v_to) >= v_from) as overlaps_period,
      (
        pdse.next_effective_date is not null
        and pdse.next_effective_date >= v_from
        and pdse.next_effective_date <= v_to
        and pdse.next_status = 'ON'
      ) as placed_in_period,
      (
        pdse.next_effective_date is not null
        and pdse.next_effective_date >= v_from
        and pdse.next_effective_date <= v_to
        and pdse.next_status = 'OFF'
      ) as exited_in_period
    from period_distinct_state_events pdse
    where pdse.status = 'UNCONFIRMED'
  ),
  period_waiting_agg as (
    select
      count(distinct pwi.entry_id) filter (where pwi.overlaps_period)::int as active_waiting_episode_count,
      coalesce(sum(pwi.clipped_period_waiting_days) filter (where pwi.overlaps_period), 0)::int as in_period_waiting_days,
      count(*) filter (where pwi.placed_in_period)::int as placed_event_count,
      count(distinct pwi.entry_id) filter (where pwi.placed_in_period)::int as placed_episode_count,
      coalesce(sum(pwi.full_interval_waiting_days) filter (where pwi.placed_in_period), 0)::int as placed_total_waiting_days,
      count(*) filter (where pwi.exited_in_period)::int as exited_event_count,
      count(distinct pwi.entry_id) filter (where pwi.exited_in_period)::int as exited_episode_count,
      coalesce(sum(pwi.full_interval_waiting_days) filter (where pwi.exited_in_period), 0)::int as exited_total_waiting_days
    from period_waiting_intervals pwi
  ),
  -- WF-03 (2.5): Active ON tenure / duration intervals and in-period status presence days
  as_of_on_intervals as (
    select
      dse.entry_id,
      dse.event_id,
      dse.effective_date as start_date,
      coalesce(dse.next_effective_date, (v_as_of + 1)) as end_exclusive_date,
      greatest(0, (coalesce(dse.next_effective_date, (v_as_of + 1)) - dse.effective_date)::int) as on_days
    from as_of_distinct_state_events dse
    where dse.status = 'ON'
  ),
  as_of_on_episodes as (
    select
      oi.entry_id,
      sr.as_of_status,
      count(*)::int as interval_count,
      sum(oi.on_days)::int as total_on_days
    from as_of_on_intervals oi
    join snapshot_rows sr on sr.entry_id = oi.entry_id
    group by oi.entry_id, sr.as_of_status
  ),
  as_of_duration_agg as (
    select
      count(*)::int as all_ep_count,
      coalesce(sum(oe.interval_count), 0)::int as all_interval_count,
      coalesce(sum(oe.total_on_days), 0)::int as all_on_days,
      max(oe.total_on_days)::int as all_max_on_days,

      count(*) filter (where oe.as_of_status = 'ON')::int as current_ep_count,
      coalesce(sum(oe.interval_count) filter (where oe.as_of_status = 'ON'), 0)::int as current_interval_count,
      coalesce(sum(oe.total_on_days) filter (where oe.as_of_status = 'ON'), 0)::int as current_on_days,
      max(oe.total_on_days) filter (where oe.as_of_status = 'ON')::int as current_max_on_days,

      count(*) filter (where oe.as_of_status <> 'ON')::int as exited_ep_count,
      coalesce(sum(oe.interval_count) filter (where oe.as_of_status <> 'ON'), 0)::int as exited_interval_count,
      coalesce(sum(oe.total_on_days) filter (where oe.as_of_status <> 'ON'), 0)::int as exited_on_days,
      max(oe.total_on_days) filter (where oe.as_of_status <> 'ON')::int as exited_max_on_days,

      count(*) filter (where oe.total_on_days <= 7)::int as days_0_to_7_count,
      count(*) filter (where oe.total_on_days >= 8 and oe.total_on_days <= 30)::int as days_8_to_30_count,
      count(*) filter (where oe.total_on_days >= 31 and oe.total_on_days <= 90)::int as days_31_to_90_count,
      count(*) filter (where oe.total_on_days >= 91)::int as days_91_plus_count
    from as_of_on_episodes oe
  ),
  period_on_intervals as (
    select
      pdse.entry_id,
      pdse.effective_date as start_date,
      coalesce(pdse.next_effective_date, (v_to + 1)) as end_exclusive_date,
      greatest(
        0,
        (least(coalesce(pdse.next_effective_date, (v_to + 1)), (v_to + 1)) - greatest(pdse.effective_date, v_from))::int
      ) as clipped_period_on_days,
      (
        least(coalesce(pdse.next_effective_date, (v_to + 1)), (v_to + 1))
        > greatest(pdse.effective_date, v_from)
      ) as overlaps_period
    from period_distinct_state_events pdse
    where pdse.status = 'ON'
  ),
  period_presence_agg as (
    select
      count(distinct poi.entry_id) filter (where poi.overlaps_period)::int as active_on_episode_count,
      coalesce(sum(poi.clipped_period_on_days) filter (where poi.overlaps_period), 0)::int as in_period_on_days
    from period_on_intervals poi
  ),
  -- WF-03 (2.6): Early attrition and continuous D7 / D30 / D90 cohort retention from first ON effective_date
  cohort_episodes as (
    select distinct on (dse.entry_id)
      dse.entry_id,
      dse.effective_date as cohort_start_date,
      dse.next_effective_date as first_exit_date,
      (dse.effective_date + 7) as d7_date,
      (dse.effective_date + 30) as d30_date,
      (dse.effective_date + 90) as d90_date
    from as_of_distinct_state_events dse
    where dse.status = 'ON'
    order by dse.entry_id, dse.effective_date asc, dse.version asc
  ),
  retention_agg as (
    select
      count(*)::int as cohort_episode_total,
      count(*) filter (where ce.first_exit_date is null)::int as continuously_retained_count,
      count(*) filter (where ce.first_exit_date is not null)::int as exited_from_on_total,

      count(*) filter (where ce.d7_date <= v_as_of)::int as d7_matured_count,
      count(*) filter (where ce.d7_date > v_as_of)::int as d7_immature_count,
      count(*) filter (
        where ce.d7_date <= v_as_of
          and (ce.first_exit_date is null or ce.first_exit_date > ce.d7_date)
      )::int as d7_retained_count,
      count(*) filter (
        where ce.d7_date <= v_as_of
          and ce.first_exit_date is not null
          and ce.first_exit_date <= ce.d7_date
      )::int as d7_exited_count,

      count(*) filter (where ce.d30_date <= v_as_of)::int as d30_matured_count,
      count(*) filter (where ce.d30_date > v_as_of)::int as d30_immature_count,
      count(*) filter (
        where ce.d30_date <= v_as_of
          and (ce.first_exit_date is null or ce.first_exit_date > ce.d30_date)
      )::int as d30_retained_count,
      count(*) filter (
        where ce.d30_date <= v_as_of
          and ce.first_exit_date is not null
          and ce.first_exit_date <= ce.d30_date
      )::int as d30_exited_count,

      count(*) filter (where ce.d90_date <= v_as_of)::int as d90_matured_count,
      count(*) filter (where ce.d90_date > v_as_of)::int as d90_immature_count,
      count(*) filter (
        where ce.d90_date <= v_as_of
          and (ce.first_exit_date is null or ce.first_exit_date > ce.d90_date)
      )::int as d90_retained_count,
      count(*) filter (
        where ce.d90_date <= v_as_of
          and ce.first_exit_date is not null
          and ce.first_exit_date <= ce.d90_date
      )::int as d90_exited_count
    from cohort_episodes ce
  ),
  period_cohort_episodes as (
    select distinct on (pdse.entry_id)
      pdse.entry_id,
      pdse.effective_date as cohort_start_date,
      pdse.next_effective_date as first_exit_by_to_date
    from period_distinct_state_events pdse
    where pdse.status = 'ON'
    order by pdse.entry_id, pdse.effective_date asc, pdse.version asc
  ),
  period_cohort_agg as (
    select
      count(*) filter (where pce.cohort_start_date >= v_from and pce.cohort_start_date <= v_to)::int as entered_on_count,
      count(*) filter (
        where pce.cohort_start_date >= v_from
          and pce.cohort_start_date <= v_to
          and pce.first_exit_by_to_date is null
      )::int as retained_at_to_count,
      count(*) filter (
        where pce.cohort_start_date >= v_from
          and pce.cohort_start_date <= v_to
          and pce.first_exit_by_to_date is not null
      )::int as exited_by_to_count
    from period_cohort_episodes pce
  ),
  -- WF-04 (2.7): Episode-level quality facts unpivoted across recruiter / team / provider / project
  episode_quality_facts as (
    select
      ep.entry_id,
      sr.as_of_status,
      ep.recruiter_dim_key,
      ep.recruiter_dim_display,
      ep.recruiter_is_unknown,
      ep.team_dim_key,
      ep.team_dim_display,
      ep.team_is_unknown,
      ep.team_dim_active,
      ep.provider_dim_key,
      ep.provider_dim_display,
      ep.provider_is_unknown,
      ep.project_dim_key,
      ep.project_dim_display,
      ep.project_is_unknown,

      (we.entry_id is not null) as had_waiting,
      (we.entry_id is not null and sr.as_of_status <> 'UNCONFIRMED') as completed_waiting,
      (we.entry_id is not null and sr.as_of_status <> 'UNCONFIRMED' and we.placed_to_on) as placed_to_on,
      (we.entry_id is not null and sr.as_of_status <> 'UNCONFIRMED' and not we.placed_to_on) as exited_without_on,
      (we.entry_id is not null and sr.as_of_status = 'UNCONFIRMED') as currently_waiting,
      coalesce(we.total_waiting_days, 0)::int as total_waiting_days,

      (oe.entry_id is not null) as ever_on,
      coalesce(oe.total_on_days, 0)::int as total_on_days,

      (ce.entry_id is not null and ce.first_exit_date is null) as continuously_retained,
      (ce.entry_id is not null and ce.first_exit_date is not null) as exited_from_on,

      (ce.entry_id is not null and ce.d7_date <= v_as_of) as d7_matured,
      (ce.entry_id is not null and ce.d7_date > v_as_of) as d7_immature,
      (
        ce.entry_id is not null
        and ce.d7_date <= v_as_of
        and (ce.first_exit_date is null or ce.first_exit_date > ce.d7_date)
      ) as d7_retained,
      (
        ce.entry_id is not null
        and ce.d7_date <= v_as_of
        and ce.first_exit_date is not null
        and ce.first_exit_date <= ce.d7_date
      ) as d7_exited,

      (ce.entry_id is not null and ce.d30_date <= v_as_of) as d30_matured,
      (ce.entry_id is not null and ce.d30_date > v_as_of) as d30_immature,
      (
        ce.entry_id is not null
        and ce.d30_date <= v_as_of
        and (ce.first_exit_date is null or ce.first_exit_date > ce.d30_date)
      ) as d30_retained,
      (
        ce.entry_id is not null
        and ce.d30_date <= v_as_of
        and ce.first_exit_date is not null
        and ce.first_exit_date <= ce.d30_date
      ) as d30_exited,

      (ce.entry_id is not null and ce.d90_date <= v_as_of) as d90_matured,
      (ce.entry_id is not null and ce.d90_date > v_as_of) as d90_immature,
      (
        ce.entry_id is not null
        and ce.d90_date <= v_as_of
        and (ce.first_exit_date is null or ce.first_exit_date > ce.d90_date)
      ) as d90_retained,
      (
        ce.entry_id is not null
        and ce.d90_date <= v_as_of
        and ce.first_exit_date is not null
        and ce.first_exit_date <= ce.d90_date
      ) as d90_exited
    from scoped_episodes ep
    join snapshot_rows sr on sr.entry_id = ep.entry_id
    left join as_of_waiting_episodes we on we.entry_id = ep.entry_id
    left join as_of_on_episodes oe on oe.entry_id = ep.entry_id
    left join cohort_episodes ce on ce.entry_id = ep.entry_id
    where sr.as_of_status <> 'FUTURE'
  ),
  dimension_episode_rows as (
    select
      dim.dim_kind,
      dim.dim_key,
      dim.dim_display,
      dim.is_unknown,
      dim.dim_active,
      eqf.as_of_status,
      eqf.had_waiting,
      eqf.completed_waiting,
      eqf.placed_to_on,
      eqf.exited_without_on,
      eqf.currently_waiting,
      eqf.total_waiting_days,
      eqf.ever_on,
      eqf.total_on_days,
      eqf.continuously_retained,
      eqf.exited_from_on,
      eqf.d7_matured,
      eqf.d7_immature,
      eqf.d7_retained,
      eqf.d7_exited,
      eqf.d30_matured,
      eqf.d30_immature,
      eqf.d30_retained,
      eqf.d30_exited,
      eqf.d90_matured,
      eqf.d90_immature,
      eqf.d90_retained,
      eqf.d90_exited
    from episode_quality_facts eqf
    cross join lateral (
      values
        ('recruiter', eqf.recruiter_dim_key, eqf.recruiter_dim_display, eqf.recruiter_is_unknown, null::boolean),
        ('team', eqf.team_dim_key, eqf.team_dim_display, eqf.team_is_unknown, eqf.team_dim_active),
        ('provider', eqf.provider_dim_key, eqf.provider_dim_display, eqf.provider_is_unknown, null::boolean),
        ('project', eqf.project_dim_key, eqf.project_dim_display, eqf.project_is_unknown, null::boolean)
    ) as dim(dim_kind, dim_key, dim_display, is_unknown, dim_active)
  ),
  dimension_bucket_agg as (
    select
      der.dim_kind,
      der.dim_key,
      max(der.dim_display collate "C") as dim_display,
      der.is_unknown,
      bool_and(der.dim_active) as dim_active,
      count(*)::int as eligible_episode_count,
      count(*) filter (where der.as_of_status = 'ON')::int as on_count,
      count(*) filter (where der.as_of_status = 'UNCONFIRMED')::int as unconfirmed_count,
      count(*) filter (where der.as_of_status = 'OFF')::int as off_count,
      count(*) filter (where der.as_of_status = 'UNKNOWN')::int as unknown_count,

      count(*) filter (where der.had_waiting)::int as waiting_episode_count,
      count(*) filter (where der.completed_waiting)::int as completed_waiting_episode_count,
      count(*) filter (where der.placed_to_on)::int as placed_to_on_episode_count,
      count(*) filter (where der.exited_without_on)::int as exited_without_on_episode_count,
      count(*) filter (where der.currently_waiting)::int as currently_waiting_episode_count,
      coalesce(sum(der.total_waiting_days) filter (where der.had_waiting), 0)::int as total_waiting_days,

      count(*) filter (where der.ever_on)::int as ever_on_episode_count,
      count(*) filter (where der.as_of_status <> 'UNKNOWN' and not der.ever_on)::int as never_on_episode_count,
      count(*) filter (where der.continuously_retained)::int as continuously_retained_count,
      count(*) filter (where der.exited_from_on)::int as exited_from_on_count,
      coalesce(sum(der.total_on_days) filter (where der.ever_on), 0)::int as total_on_days,

      count(*) filter (where der.d7_matured)::int as d7_matured_count,
      count(*) filter (where der.d7_immature)::int as d7_immature_count,
      count(*) filter (where der.d7_retained)::int as d7_retained_count,
      count(*) filter (where der.d7_exited)::int as d7_exited_count,

      count(*) filter (where der.d30_matured)::int as d30_matured_count,
      count(*) filter (where der.d30_immature)::int as d30_immature_count,
      count(*) filter (where der.d30_retained)::int as d30_retained_count,
      count(*) filter (where der.d30_exited)::int as d30_exited_count,

      count(*) filter (where der.d90_matured)::int as d90_matured_count,
      count(*) filter (where der.d90_immature)::int as d90_immature_count,
      count(*) filter (where der.d90_retained)::int as d90_retained_count,
      count(*) filter (where der.d90_exited)::int as d90_exited_count
    from dimension_episode_rows der
    group by der.dim_kind, der.dim_key, der.is_unknown
  ),
  dimension_json_agg as (
    select
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'key', dba.dim_key,
            'display', dba.dim_display,
            'is_unknown', dba.is_unknown,
            'active', dba.dim_active,
            'eligible_episode_count', dba.eligible_episode_count,
            'on_count', dba.on_count,
            'unconfirmed_count', dba.unconfirmed_count,
            'off_count', dba.off_count,
            'unknown_count', dba.unknown_count,
            'waiting_episode_count', dba.waiting_episode_count,
            'completed_waiting_episode_count', dba.completed_waiting_episode_count,
            'placed_to_on_episode_count', dba.placed_to_on_episode_count,
            'exited_without_on_episode_count', dba.exited_without_on_episode_count,
            'currently_waiting_episode_count', dba.currently_waiting_episode_count,
            'total_waiting_days', dba.total_waiting_days,
            'ever_on_episode_count', dba.ever_on_episode_count,
            'never_on_episode_count', dba.never_on_episode_count,
            'continuously_retained_count', dba.continuously_retained_count,
            'exited_from_on_count', dba.exited_from_on_count,
            'total_on_days', dba.total_on_days,
            'checkpoints', jsonb_build_object(
              'd7', jsonb_build_object(
                'checkpoint_days', 7,
                'matured_count', dba.d7_matured_count,
                'immature_count', dba.d7_immature_count,
                'retained_count', dba.d7_retained_count,
                'exited_count', dba.d7_exited_count
              ),
              'd30', jsonb_build_object(
                'checkpoint_days', 30,
                'matured_count', dba.d30_matured_count,
                'immature_count', dba.d30_immature_count,
                'retained_count', dba.d30_retained_count,
                'exited_count', dba.d30_exited_count
              ),
              'd90', jsonb_build_object(
                'checkpoint_days', 90,
                'matured_count', dba.d90_matured_count,
                'immature_count', dba.d90_immature_count,
                'retained_count', dba.d90_retained_count,
                'exited_count', dba.d90_exited_count
              )
            )
          )
          order by
            dba.is_unknown asc,
            dba.eligible_episode_count desc,
            dba.on_count desc,
            dba.ever_on_episode_count desc,
            dba.dim_key collate "C" asc
        ) filter (where dba.dim_kind = 'recruiter'),
        '[]'::jsonb
      ) as by_recruiter,
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'key', dba.dim_key,
            'display', dba.dim_display,
            'is_unknown', dba.is_unknown,
            'active', dba.dim_active,
            'eligible_episode_count', dba.eligible_episode_count,
            'on_count', dba.on_count,
            'unconfirmed_count', dba.unconfirmed_count,
            'off_count', dba.off_count,
            'unknown_count', dba.unknown_count,
            'waiting_episode_count', dba.waiting_episode_count,
            'completed_waiting_episode_count', dba.completed_waiting_episode_count,
            'placed_to_on_episode_count', dba.placed_to_on_episode_count,
            'exited_without_on_episode_count', dba.exited_without_on_episode_count,
            'currently_waiting_episode_count', dba.currently_waiting_episode_count,
            'total_waiting_days', dba.total_waiting_days,
            'ever_on_episode_count', dba.ever_on_episode_count,
            'never_on_episode_count', dba.never_on_episode_count,
            'continuously_retained_count', dba.continuously_retained_count,
            'exited_from_on_count', dba.exited_from_on_count,
            'total_on_days', dba.total_on_days,
            'checkpoints', jsonb_build_object(
              'd7', jsonb_build_object(
                'checkpoint_days', 7,
                'matured_count', dba.d7_matured_count,
                'immature_count', dba.d7_immature_count,
                'retained_count', dba.d7_retained_count,
                'exited_count', dba.d7_exited_count
              ),
              'd30', jsonb_build_object(
                'checkpoint_days', 30,
                'matured_count', dba.d30_matured_count,
                'immature_count', dba.d30_immature_count,
                'retained_count', dba.d30_retained_count,
                'exited_count', dba.d30_exited_count
              ),
              'd90', jsonb_build_object(
                'checkpoint_days', 90,
                'matured_count', dba.d90_matured_count,
                'immature_count', dba.d90_immature_count,
                'retained_count', dba.d90_retained_count,
                'exited_count', dba.d90_exited_count
              )
            )
          )
          order by
            dba.is_unknown asc,
            dba.eligible_episode_count desc,
            dba.on_count desc,
            dba.ever_on_episode_count desc,
            dba.dim_key collate "C" asc
        ) filter (where dba.dim_kind = 'team'),
        '[]'::jsonb
      ) as by_team,
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'key', dba.dim_key,
            'display', dba.dim_display,
            'is_unknown', dba.is_unknown,
            'active', dba.dim_active,
            'eligible_episode_count', dba.eligible_episode_count,
            'on_count', dba.on_count,
            'unconfirmed_count', dba.unconfirmed_count,
            'off_count', dba.off_count,
            'unknown_count', dba.unknown_count,
            'waiting_episode_count', dba.waiting_episode_count,
            'completed_waiting_episode_count', dba.completed_waiting_episode_count,
            'placed_to_on_episode_count', dba.placed_to_on_episode_count,
            'exited_without_on_episode_count', dba.exited_without_on_episode_count,
            'currently_waiting_episode_count', dba.currently_waiting_episode_count,
            'total_waiting_days', dba.total_waiting_days,
            'ever_on_episode_count', dba.ever_on_episode_count,
            'never_on_episode_count', dba.never_on_episode_count,
            'continuously_retained_count', dba.continuously_retained_count,
            'exited_from_on_count', dba.exited_from_on_count,
            'total_on_days', dba.total_on_days,
            'checkpoints', jsonb_build_object(
              'd7', jsonb_build_object(
                'checkpoint_days', 7,
                'matured_count', dba.d7_matured_count,
                'immature_count', dba.d7_immature_count,
                'retained_count', dba.d7_retained_count,
                'exited_count', dba.d7_exited_count
              ),
              'd30', jsonb_build_object(
                'checkpoint_days', 30,
                'matured_count', dba.d30_matured_count,
                'immature_count', dba.d30_immature_count,
                'retained_count', dba.d30_retained_count,
                'exited_count', dba.d30_exited_count
              ),
              'd90', jsonb_build_object(
                'checkpoint_days', 90,
                'matured_count', dba.d90_matured_count,
                'immature_count', dba.d90_immature_count,
                'retained_count', dba.d90_retained_count,
                'exited_count', dba.d90_exited_count
              )
            )
          )
          order by
            dba.is_unknown asc,
            dba.eligible_episode_count desc,
            dba.on_count desc,
            dba.ever_on_episode_count desc,
            dba.dim_key collate "C" asc
        ) filter (where dba.dim_kind = 'provider'),
        '[]'::jsonb
      ) as by_provider,
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'key', dba.dim_key,
            'display', dba.dim_display,
            'is_unknown', dba.is_unknown,
            'active', dba.dim_active,
            'eligible_episode_count', dba.eligible_episode_count,
            'on_count', dba.on_count,
            'unconfirmed_count', dba.unconfirmed_count,
            'off_count', dba.off_count,
            'unknown_count', dba.unknown_count,
            'waiting_episode_count', dba.waiting_episode_count,
            'completed_waiting_episode_count', dba.completed_waiting_episode_count,
            'placed_to_on_episode_count', dba.placed_to_on_episode_count,
            'exited_without_on_episode_count', dba.exited_without_on_episode_count,
            'currently_waiting_episode_count', dba.currently_waiting_episode_count,
            'total_waiting_days', dba.total_waiting_days,
            'ever_on_episode_count', dba.ever_on_episode_count,
            'never_on_episode_count', dba.never_on_episode_count,
            'continuously_retained_count', dba.continuously_retained_count,
            'exited_from_on_count', dba.exited_from_on_count,
            'total_on_days', dba.total_on_days,
            'checkpoints', jsonb_build_object(
              'd7', jsonb_build_object(
                'checkpoint_days', 7,
                'matured_count', dba.d7_matured_count,
                'immature_count', dba.d7_immature_count,
                'retained_count', dba.d7_retained_count,
                'exited_count', dba.d7_exited_count
              ),
              'd30', jsonb_build_object(
                'checkpoint_days', 30,
                'matured_count', dba.d30_matured_count,
                'immature_count', dba.d30_immature_count,
                'retained_count', dba.d30_retained_count,
                'exited_count', dba.d30_exited_count
              ),
              'd90', jsonb_build_object(
                'checkpoint_days', 90,
                'matured_count', dba.d90_matured_count,
                'immature_count', dba.d90_immature_count,
                'retained_count', dba.d90_retained_count,
                'exited_count', dba.d90_exited_count
              )
            )
          )
          order by
            dba.is_unknown asc,
            dba.eligible_episode_count desc,
            dba.on_count desc,
            dba.ever_on_episode_count desc,
            dba.dim_key collate "C" asc
        ) filter (where dba.dim_kind = 'project'),
        '[]'::jsonb
      ) as by_project
    from dimension_bucket_agg dba
  ),
  -- WF-04 (2.8): Leave reason analysis at as_of and in period [v_from, v_to]
  leave_reason_catalog(category_key, sort_order, kind) as (
    values
      ('personal_or_family', 1, 'standardized'),
      ('health', 2, 'standardized'),
      ('compensation_or_benefits', 3, 'standardized'),
      ('work_conditions_or_shift', 4, 'standardized'),
      ('relocation_or_distance', 5, 'standardized'),
      ('contract_or_project_end', 6, 'standardized'),
      ('discipline_or_performance', 7, 'standardized'),
      ('other_career_or_study', 8, 'standardized'),
      ('unclassified_free_text', 9, 'unclassified_free_text'),
      ('missing_or_unknown', 10, 'missing_or_unknown')
  ),
  as_of_off_episodes as (
    select
      sr.entry_id,
      coalesce(sr.as_of_leave_reason_category, 'missing_or_unknown') as category_key,
      (oe.entry_id is not null) as ever_on
    from snapshot_rows sr
    left join as_of_on_episodes oe on oe.entry_id = sr.entry_id
    where sr.as_of_status = 'OFF'
  ),
  as_of_leave_reason_by_cat as (
    select
      lrc.category_key,
      lrc.sort_order,
      lrc.kind,
      count(aoe.entry_id)::int as episode_count,
      count(aoe.entry_id) filter (where aoe.ever_on)::int as from_on_count,
      count(aoe.entry_id) filter (where not aoe.ever_on)::int as from_unconfirmed_without_on_count
    from leave_reason_catalog lrc
    left join as_of_off_episodes aoe on aoe.category_key = lrc.category_key
    group by lrc.category_key, lrc.sort_order, lrc.kind
  ),
  as_of_leave_reason_agg as (
    select
      coalesce(sum(c.episode_count), 0)::int as off_episode_total,
      coalesce(sum(c.episode_count) filter (where c.kind = 'standardized'), 0)::int as standardized_episode_count,
      coalesce(sum(c.episode_count) filter (where c.kind = 'unclassified_free_text'), 0)::int as unclassified_free_text_episode_count,
      coalesce(sum(c.episode_count) filter (where c.kind = 'missing_or_unknown'), 0)::int as missing_reason_episode_count,
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'key', c.category_key,
            'kind', c.kind,
            'episode_count', c.episode_count,
            'from_on_count', c.from_on_count,
            'from_unconfirmed_without_on_count', c.from_unconfirmed_without_on_count
          )
          order by c.sort_order asc
        ),
        '[]'::jsonb
      ) as by_category
    from as_of_leave_reason_by_cat c
  ),
  period_off_transitions as (
    select
      pe.event_id,
      pe.entry_id,
      pe.prev_status,
      coalesce(pe.leave_reason_category, 'missing_or_unknown') as category_key
    from period_events pe
    where pe.prev_status is not null
      and pe.prev_status <> pe.status
      and pe.status = 'OFF'
  ),
  period_leave_reason_by_cat as (
    select
      lrc.category_key,
      lrc.sort_order,
      lrc.kind,
      count(pot.event_id)::int as event_count,
      count(distinct pot.entry_id)::int as episode_count,
      count(pot.event_id) filter (where pot.prev_status = 'ON')::int as on_to_off_event_count,
      count(pot.event_id) filter (where pot.prev_status = 'UNCONFIRMED')::int as unconfirmed_to_off_event_count
    from leave_reason_catalog lrc
    left join period_off_transitions pot on pot.category_key = lrc.category_key
    group by lrc.category_key, lrc.sort_order, lrc.kind
  ),
  period_leave_reason_totals as (
    select
      count(*)::int as off_transition_event_total,
      count(distinct pot.entry_id)::int as off_transition_episode_total,
      count(*) filter (where pot.prev_status = 'ON')::int as on_to_off_event_total,
      count(*) filter (where pot.prev_status = 'UNCONFIRMED')::int as unconfirmed_to_off_event_total
    from period_off_transitions pot
  ),
  period_leave_reason_agg as (
    select
      coalesce(sum(c.event_count) filter (where c.kind = 'standardized'), 0)::int as standardized_event_count,
      coalesce(sum(c.event_count) filter (where c.kind = 'unclassified_free_text'), 0)::int as unclassified_free_text_event_count,
      coalesce(sum(c.event_count) filter (where c.kind = 'missing_or_unknown'), 0)::int as missing_reason_event_count,
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'key', c.category_key,
            'kind', c.kind,
            'event_count', c.event_count,
            'episode_count', c.episode_count,
            'on_to_off_event_count', c.on_to_off_event_count,
            'unconfirmed_to_off_event_count', c.unconfirmed_to_off_event_count
          )
          order by c.sort_order asc
        ),
        '[]'::jsonb
      ) as by_category
    from period_leave_reason_by_cat c
  )
  select jsonb_build_object(
    'audience', v_audience,
    'snapshot', jsonb_build_object(
      'as_of_date', to_char(v_as_of, 'YYYY-MM-DD'),
      'as_of_source', v_as_of_source,
      'eligible_episode_total', sa.eligible_episode_total,
      'on_count', sa.on_count,
      'unconfirmed_count', sa.unconfirmed_count,
      'off_count', sa.off_count,
      'unknown_count', sa.unknown_count,
      'future_episode_count', sa.future_episode_count
    ),
    'transitions', case
      when v_from is not null and v_to is not null then
        jsonb_build_object(
          'applicable', true,
          'reason', null,
          'from_date', to_char(v_from, 'YYYY-MM-DD'),
          'to_date', to_char(v_to, 'YYYY-MM-DD'),
          'initial', jsonb_build_object(
            'total', jsonb_build_object('event_count', ta.initial_total_event_count, 'episode_count', ta.initial_total_episode_count),
            'on', jsonb_build_object('event_count', ta.initial_on_event_count, 'episode_count', ta.initial_on_episode_count),
            'unconfirmed', jsonb_build_object('event_count', ta.initial_unconfirmed_event_count, 'episode_count', ta.initial_unconfirmed_episode_count)
          ),
          'pairs', jsonb_build_object(
            'unconfirmed_to_on', jsonb_build_object('event_count', ta.unconfirmed_to_on_event_count, 'episode_count', ta.unconfirmed_to_on_episode_count),
            'unconfirmed_to_off', jsonb_build_object('event_count', ta.unconfirmed_to_off_event_count, 'episode_count', ta.unconfirmed_to_off_episode_count),
            'on_to_off', jsonb_build_object('event_count', ta.on_to_off_event_count, 'episode_count', ta.on_to_off_episode_count),
            'off_to_on', jsonb_build_object('event_count', ta.off_to_on_event_count, 'episode_count', ta.off_to_on_episode_count),
            'other', jsonb_build_object('event_count', ta.other_transition_event_count, 'episode_count', ta.other_transition_episode_count)
          ),
          'totals', jsonb_build_object(
            'transition_event_count', ta.total_transition_event_count,
            'transition_episode_count', ta.total_transition_episode_count,
            'noop_repeat_event_count', ta.noop_repeat_event_count,
            'noop_repeat_episode_count', ta.noop_repeat_episode_count
          )
        )
      else
        jsonb_build_object(
          'applicable', false,
          'reason', case when v_from is null and v_to is null then 'all_time' else 'one_sided' end,
          'from_date', case when v_from is not null then to_char(v_from, 'YYYY-MM-DD') else null end,
          'to_date', case when v_to is not null then to_char(v_to, 'YYYY-MM-DD') else null end
        )
    end,
    'balance', case
      when v_from is not null and v_to is not null then
        jsonb_build_object(
          'applicable', true,
          'reason', null,
          'from_date', to_char(v_from, 'YYYY-MM-DD'),
          'to_date', to_char(v_to, 'YYYY-MM-DD'),
          'opening_as_of_date', to_char(v_open_as_of, 'YYYY-MM-DD'),
          'closing_as_of_date', to_char(v_to, 'YYYY-MM-DD'),
          'opening_snapshot', jsonb_build_object(
            'as_of_date', to_char(v_open_as_of, 'YYYY-MM-DD'),
            'as_of_source', 'explicit_as_of',
            'eligible_episode_total', osa.eligible_episode_total,
            'on_count', osa.on_count,
            'unconfirmed_count', osa.unconfirmed_count,
            'off_count', osa.off_count,
            'unknown_count', osa.unknown_count,
            'future_episode_count', osa.future_episode_count
          ),
          'closing_snapshot', jsonb_build_object(
            'as_of_date', to_char(v_to, 'YYYY-MM-DD'),
            'as_of_source', 'filter_to',
            'eligible_episode_total', csa.eligible_episode_total,
            'on_count', csa.on_count,
            'unconfirmed_count', csa.unconfirmed_count,
            'off_count', csa.off_count,
            'unknown_count', csa.unknown_count,
            'future_episode_count', csa.future_episode_count
          ),
          'new_episodes_in_period', jsonb_build_object(
            'total', bna.new_total_count,
            'initial_on', bna.new_on_count,
            'initial_unconfirmed', bna.new_unconfirmed_count,
            'initial_off', bna.new_off_count,
            'initial_unknown', bna.new_unknown_count
          ),
          'by_status', jsonb_build_object(
            'on', jsonb_build_object(
              'opening_count', osa.on_count,
              'new_episode_inflow_count', bna.new_on_count,
              'transition_inflow_count', bfa.on_trans_in,
              'transition_inflow_by_source', jsonb_build_object(
                'from_on', 0,
                'from_unconfirmed', bfa.on_in_from_unconfirmed,
                'from_off', bfa.on_in_from_off,
                'from_unknown', bfa.on_in_from_unknown
              ),
              'total_inflow_count', bna.new_on_count + bfa.on_trans_in,
              'outflow_count', bfa.on_trans_out,
              'outflow_by_target', jsonb_build_object(
                'to_on', 0,
                'to_unconfirmed', bfa.on_out_to_unconfirmed,
                'to_off', bfa.on_out_to_off
              ),
              'net_change', (bna.new_on_count + bfa.on_trans_in) - bfa.on_trans_out,
              'closing_count', csa.on_count
            ),
            'unconfirmed', jsonb_build_object(
              'opening_count', osa.unconfirmed_count,
              'new_episode_inflow_count', bna.new_unconfirmed_count,
              'transition_inflow_count', bfa.unconfirmed_trans_in,
              'transition_inflow_by_source', jsonb_build_object(
                'from_on', bfa.unconfirmed_in_from_on,
                'from_unconfirmed', 0,
                'from_off', bfa.unconfirmed_in_from_off,
                'from_unknown', bfa.unconfirmed_in_from_unknown
              ),
              'total_inflow_count', bna.new_unconfirmed_count + bfa.unconfirmed_trans_in,
              'outflow_count', bfa.unconfirmed_trans_out,
              'outflow_by_target', jsonb_build_object(
                'to_on', bfa.unconfirmed_out_to_on,
                'to_unconfirmed', 0,
                'to_off', bfa.unconfirmed_out_to_off
              ),
              'net_change', (bna.new_unconfirmed_count + bfa.unconfirmed_trans_in) - bfa.unconfirmed_trans_out,
              'closing_count', csa.unconfirmed_count
            ),
            'off', jsonb_build_object(
              'opening_count', osa.off_count,
              'new_episode_inflow_count', bna.new_off_count,
              'transition_inflow_count', bfa.off_trans_in,
              'transition_inflow_by_source', jsonb_build_object(
                'from_on', bfa.off_in_from_on,
                'from_unconfirmed', bfa.off_in_from_unconfirmed,
                'from_off', 0,
                'from_unknown', bfa.off_in_from_unknown
              ),
              'total_inflow_count', bna.new_off_count + bfa.off_trans_in,
              'outflow_count', bfa.off_trans_out,
              'outflow_by_target', jsonb_build_object(
                'to_on', bfa.off_out_to_on,
                'to_unconfirmed', bfa.off_out_to_unconfirmed,
                'to_off', 0
              ),
              'net_change', (bna.new_off_count + bfa.off_trans_in) - bfa.off_trans_out,
              'closing_count', csa.off_count
            ),
            'unknown', jsonb_build_object(
              'opening_count', osa.unknown_count,
              'new_episode_inflow_count', bna.new_unknown_count,
              'transition_inflow_count', bfa.unknown_trans_in,
              'transition_inflow_by_source', jsonb_build_object(
                'from_on', 0,
                'from_unconfirmed', 0,
                'from_off', 0,
                'from_unknown', 0
              ),
              'total_inflow_count', bna.new_unknown_count + bfa.unknown_trans_in,
              'outflow_count', bfa.unknown_trans_out,
              'outflow_by_target', jsonb_build_object(
                'to_on', bfa.unknown_out_to_on,
                'to_unconfirmed', bfa.unknown_out_to_unconfirmed,
                'to_off', bfa.unknown_out_to_off
              ),
              'net_change', (bna.new_unknown_count + bfa.unknown_trans_in) - bfa.unknown_trans_out,
              'closing_count', csa.unknown_count
            )
          ),
          'totals', jsonb_build_object(
            'opening_eligible_total', osa.eligible_episode_total,
            'new_episode_total', bna.new_total_count,
            'transition_inflow_total', bfa.on_trans_in + bfa.unconfirmed_trans_in + bfa.off_trans_in + bfa.unknown_trans_in,
            'transition_outflow_total', bfa.on_trans_out + bfa.unconfirmed_trans_out + bfa.off_trans_out + bfa.unknown_trans_out,
            'net_eligible_change', bna.new_total_count,
            'closing_eligible_total', csa.eligible_episode_total
          )
        )
      else
        jsonb_build_object(
          'applicable', false,
          'reason', case when v_from is null and v_to is null then 'all_time' else 'one_sided' end,
          'from_date', case when v_from is not null then to_char(v_from, 'YYYY-MM-DD') else null end,
          'to_date', case when v_to is not null then to_char(v_to, 'YYYY-MM-DD') else null end
        )
    end,
    'waiting', jsonb_build_object(
      'as_of_date', to_char(v_as_of, 'YYYY-MM-DD'),
      'as_of_source', v_as_of_source,
      'eligible_episode_total', sa.eligible_episode_total,
      'waiting_episode_total', ema.waiting_episode_total,
      'direct_on_episode_count', ema.direct_on_episode_count,
      'direct_off_episode_count', ema.direct_off_episode_count,
      'unknown_episode_count', ema.unknown_episode_count,
      'all_waiting', jsonb_build_object(
        'episode_count', wsa.all_ep_count,
        'interval_count', wsa.all_interval_count,
        'total_waiting_days', wsa.all_waiting_days,
        'max_waiting_days', wsa.all_max_waiting_days
      ),
      'completed_waiting', jsonb_build_object(
        'episode_count', wsa.completed_ep_count,
        'interval_count', wsa.completed_interval_count,
        'total_waiting_days', wsa.completed_waiting_days,
        'max_waiting_days', wsa.completed_max_waiting_days
      ),
      'placed_to_on', jsonb_build_object(
        'episode_count', wsa.placed_ep_count,
        'interval_count', wsa.placed_interval_count,
        'total_waiting_days', wsa.placed_waiting_days,
        'max_waiting_days', wsa.placed_max_waiting_days
      ),
      'exited_without_on', jsonb_build_object(
        'episode_count', wsa.exited_ep_count,
        'interval_count', wsa.exited_interval_count,
        'total_waiting_days', wsa.exited_waiting_days,
        'max_waiting_days', wsa.exited_max_waiting_days
      ),
      'currently_waiting', jsonb_build_object(
        'episode_count', wsa.current_ep_count,
        'interval_count', wsa.current_interval_count,
        'total_waiting_days', wsa.current_waiting_days,
        'max_waiting_days', wsa.current_max_waiting_days
      ),
      'period_waiting', case
        when v_from is not null and v_to is not null then
          jsonb_build_object(
            'applicable', true,
            'reason', null,
            'from_date', to_char(v_from, 'YYYY-MM-DD'),
            'to_date', to_char(v_to, 'YYYY-MM-DD'),
            'active_waiting_episode_count', pwa.active_waiting_episode_count,
            'in_period_waiting_days', pwa.in_period_waiting_days,
            'placed_in_period', jsonb_build_object(
              'event_count', pwa.placed_event_count,
              'episode_count', pwa.placed_episode_count,
              'total_waiting_days', pwa.placed_total_waiting_days
            ),
            'exited_in_period', jsonb_build_object(
              'event_count', pwa.exited_event_count,
              'episode_count', pwa.exited_episode_count,
              'total_waiting_days', pwa.exited_total_waiting_days
            )
          )
        else
          jsonb_build_object(
            'applicable', false,
            'reason', case when v_from is null and v_to is null then 'all_time' else 'one_sided' end,
            'from_date', case when v_from is not null then to_char(v_from, 'YYYY-MM-DD') else null end,
            'to_date', case when v_to is not null then to_char(v_to, 'YYYY-MM-DD') else null end
          )
      end
    ),
    'duration', jsonb_build_object(
      'as_of_date', to_char(v_as_of, 'YYYY-MM-DD'),
      'as_of_source', v_as_of_source,
      'eligible_episode_total', sa.eligible_episode_total,
      'known_status_episode_count', (sa.eligible_episode_total - sa.unknown_count),
      'unknown_status_episode_count', sa.unknown_count,
      'ever_on_episode_count', da.all_ep_count,
      'never_on_episode_count', greatest(0, (sa.eligible_episode_total - sa.unknown_count) - da.all_ep_count),
      'all_ever_on', jsonb_build_object(
        'episode_count', da.all_ep_count,
        'interval_count', da.all_interval_count,
        'total_on_days', da.all_on_days,
        'max_on_days', da.all_max_on_days
      ),
      'currently_on', jsonb_build_object(
        'episode_count', da.current_ep_count,
        'interval_count', da.current_interval_count,
        'total_on_days', da.current_on_days,
        'max_on_days', da.current_max_on_days
      ),
      'exited_after_on', jsonb_build_object(
        'episode_count', da.exited_ep_count,
        'interval_count', da.exited_interval_count,
        'total_on_days', da.exited_on_days,
        'max_on_days', da.exited_max_on_days
      ),
      'distribution', jsonb_build_object(
        'days_0_to_7_count', da.days_0_to_7_count,
        'days_8_to_30_count', da.days_8_to_30_count,
        'days_31_to_90_count', da.days_31_to_90_count,
        'days_91_plus_count', da.days_91_plus_count
      ),
      'period_presence', case
        when v_from is not null and v_to is not null then
          jsonb_build_object(
            'applicable', true,
            'reason', null,
            'from_date', to_char(v_from, 'YYYY-MM-DD'),
            'to_date', to_char(v_to, 'YYYY-MM-DD'),
            'active_on_episode_count', ppa.active_on_episode_count,
            'in_period_on_days', ppa.in_period_on_days
          )
        else
          jsonb_build_object(
            'applicable', false,
            'reason', case when v_from is null and v_to is null then 'all_time' else 'one_sided' end,
            'from_date', case when v_from is not null then to_char(v_from, 'YYYY-MM-DD') else null end,
            'to_date', case when v_to is not null then to_char(v_to, 'YYYY-MM-DD') else null end
          )
      end
    ),
    'retention', jsonb_build_object(
      'as_of_date', to_char(v_as_of, 'YYYY-MM-DD'),
      'as_of_source', v_as_of_source,
      'eligible_episode_total', sa.eligible_episode_total,
      'cohort_episode_total', ra.cohort_episode_total,
      'never_entered_on_count', greatest(0, (sa.eligible_episode_total - sa.unknown_count) - ra.cohort_episode_total),
      'unknown_status_episode_count', sa.unknown_count,
      'continuously_retained_count', ra.continuously_retained_count,
      'exited_from_on_total', ra.exited_from_on_total,
      'checkpoints', jsonb_build_object(
        'd7', jsonb_build_object(
          'checkpoint_days', 7,
          'matured_count', ra.d7_matured_count,
          'immature_count', ra.d7_immature_count,
          'retained_count', ra.d7_retained_count,
          'exited_count', ra.d7_exited_count
        ),
        'd30', jsonb_build_object(
          'checkpoint_days', 30,
          'matured_count', ra.d30_matured_count,
          'immature_count', ra.d30_immature_count,
          'retained_count', ra.d30_retained_count,
          'exited_count', ra.d30_exited_count
        ),
        'd90', jsonb_build_object(
          'checkpoint_days', 90,
          'matured_count', ra.d90_matured_count,
          'immature_count', ra.d90_immature_count,
          'retained_count', ra.d90_retained_count,
          'exited_count', ra.d90_exited_count
        )
      ),
      'period_cohort', case
        when v_from is not null and v_to is not null then
          jsonb_build_object(
            'applicable', true,
            'reason', null,
            'from_date', to_char(v_from, 'YYYY-MM-DD'),
            'to_date', to_char(v_to, 'YYYY-MM-DD'),
            'entered_on_count', pca.entered_on_count,
            'retained_at_to_count', pca.retained_at_to_count,
            'exited_by_to_count', pca.exited_by_to_count
          )
        else
          jsonb_build_object(
            'applicable', false,
            'reason', case when v_from is null and v_to is null then 'all_time' else 'one_sided' end,
            'from_date', case when v_from is not null then to_char(v_from, 'YYYY-MM-DD') else null end,
            'to_date', case when v_to is not null then to_char(v_to, 'YYYY-MM-DD') else null end
          )
      end
    ),
    'dimensions', jsonb_build_object(
      'as_of_date', to_char(v_as_of, 'YYYY-MM-DD'),
      'as_of_source', v_as_of_source,
      'eligible_episode_total', sa.eligible_episode_total,
      'by_recruiter', dja.by_recruiter,
      'by_team', dja.by_team,
      'by_provider', dja.by_provider,
      'by_project', dja.by_project
    ),
    'leave_reasons', jsonb_build_object(
      'as_of_date', to_char(v_as_of, 'YYYY-MM-DD'),
      'as_of_source', v_as_of_source,
      'off_episode_total', alra.off_episode_total,
      'with_reason_episode_count', (alra.standardized_episode_count + alra.unclassified_free_text_episode_count),
      'standardized_episode_count', alra.standardized_episode_count,
      'unclassified_free_text_episode_count', alra.unclassified_free_text_episode_count,
      'missing_reason_episode_count', alra.missing_reason_episode_count,
      'by_category', alra.by_category,
      'period_leave_reasons', case
        when v_from is not null and v_to is not null then
          jsonb_build_object(
            'applicable', true,
            'reason', null,
            'from_date', to_char(v_from, 'YYYY-MM-DD'),
            'to_date', to_char(v_to, 'YYYY-MM-DD'),
            'off_transition_event_total', plrt.off_transition_event_total,
            'off_transition_episode_total', plrt.off_transition_episode_total,
            'on_to_off_event_total', plrt.on_to_off_event_total,
            'unconfirmed_to_off_event_total', plrt.unconfirmed_to_off_event_total,
            'with_reason_event_count', (plra.standardized_event_count + plra.unclassified_free_text_event_count),
            'standardized_event_count', plra.standardized_event_count,
            'unclassified_free_text_event_count', plra.unclassified_free_text_event_count,
            'missing_reason_event_count', plra.missing_reason_event_count,
            'by_category', plra.by_category
          )
        else
          jsonb_build_object(
            'applicable', false,
            'reason', case when v_from is null and v_to is null then 'all_time' else 'one_sided' end,
            'from_date', case when v_from is not null then to_char(v_from, 'YYYY-MM-DD') else null end,
            'to_date', case when v_to is not null then to_char(v_to, 'YYYY-MM-DD') else null end
          )
      end
    )
  )
  into v_result
  from snapshot_agg sa
  cross join transitions_agg ta
  cross join opening_snapshot_agg osa
  cross join closing_snapshot_agg csa
  cross join balance_new_agg bna
  cross join balance_flows_agg bfa
  cross join as_of_entry_mode_agg ema
  cross join as_of_waiting_samples_agg wsa
  cross join period_waiting_agg pwa
  cross join as_of_duration_agg da
  cross join period_presence_agg ppa
  cross join retention_agg ra
  cross join period_cohort_agg pca
  cross join dimension_json_agg dja
  cross join as_of_leave_reason_agg alra
  cross join period_leave_reason_totals plrt
  cross join period_leave_reason_agg plra;

  return v_result;
end;
$function$;

comment on function public.direct_entry_workforce_reporting_scoped(uuid, uuid, jsonb) is
  'WF-01, WF-02, WF-03 & WF-04 (MBI-DA-2026-01): Actor-scoped business-effective workforce snapshot as-of (2.1), period status transitions (2.2), opening/closing balance reconciliation (2.3), UNCONFIRMED waiting duration & placement metrics (2.4), active ON tenure & in-period status presence days (2.5), D7/D30/D90 cohort retention & early attrition (2.6), dimensional quality by recruiter/team/HRP-Vendor/project (2.7), and privacy-safe leave reason analysis (2.8) on non-superseded direct_entry_employment_status_events.';

do $align_wf04_rpc_owner$
declare
  v_table_owner_oid oid;
  v_table_owner name;
  v_facts_rpc_owner name;
  v_proc_owner_oid oid;
  v_proc_owner name;
begin
  select c.relowner, r.rolname
    into v_table_owner_oid, v_table_owner
    from pg_catalog.pg_class c
    join pg_catalog.pg_roles r on r.oid = c.relowner
   where c.oid = 'public.direct_entry_employment_status_events'::pg_catalog.regclass;

  select r.rolname
    into v_facts_rpc_owner
    from pg_catalog.pg_proc p
    join pg_catalog.pg_roles r on r.oid = p.proowner
   where p.oid = 'public.direct_entry_reporting_scoped_facts(uuid, uuid, jsonb)'::pg_catalog.regprocedure;

  if v_table_owner is null or v_facts_rpc_owner is null or v_table_owner <> v_facts_rpc_owner then
    raise exception 'WF-04 expected owner mismatch between status events table and reporting facts RPC'
      using errcode = '55000';
  end if;

  select p.proowner, r.rolname
    into v_proc_owner_oid, v_proc_owner
    from pg_catalog.pg_proc p
    join pg_catalog.pg_roles r on r.oid = p.proowner
   where p.oid = 'public.direct_entry_workforce_reporting_scoped(uuid, uuid, jsonb)'::pg_catalog.regprocedure;

  if v_proc_owner_oid is distinct from v_table_owner_oid
     and pg_catalog.pg_has_role(current_user, v_table_owner_oid, 'SET') then
    execute pg_catalog.format(
      'alter function public.direct_entry_workforce_reporting_scoped(uuid, uuid, jsonb) owner to %I',
      v_table_owner
    );
    v_proc_owner_oid := v_table_owner_oid;
    v_proc_owner := v_table_owner;
  end if;

  if v_proc_owner_oid is distinct from v_table_owner_oid then
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_reporting_resolve_audience(uuid, uuid) to %I',
      v_proc_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_reporting_authorized_entries(uuid, uuid) to %I',
      v_proc_owner
    );
    execute pg_catalog.format(
      'grant execute on function public.direct_entry_authorization_date() to %I',
      v_proc_owner
    );
  end if;
end;
$align_wf04_rpc_owner$;

revoke all on function public.direct_entry_workforce_reporting_scoped(uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_workforce_reporting_scoped(uuid, uuid, jsonb)
  to service_role;

do $assert_wf04_rpc_boundary$
declare
  v_proc constant pg_catalog.regprocedure :=
    'public.direct_entry_workforce_reporting_scoped(uuid, uuid, jsonb)'::pg_catalog.regprocedure;
  v_status_table constant pg_catalog.regclass :=
    'public.direct_entry_employment_status_events'::pg_catalog.regclass;
  v_table_owner oid;
  v_proc_owner oid;
  v_prosecdef boolean;
  v_proconfig text[];
  v_owner_can_bypass_rls boolean;
  v_status_rls_forced boolean;
  v_status_policy_count integer;
  v_public_exec boolean;
begin
  select c.relowner,
         (c.relrowsecurity and c.relforcerowsecurity),
         (select count(*)::integer from pg_catalog.pg_policy pol where pol.polrelid = c.oid)
    into v_table_owner, v_status_rls_forced, v_status_policy_count
    from pg_catalog.pg_class c
   where c.oid = v_status_table;

  select p.proowner,
         p.prosecdef,
         coalesce(p.proconfig, array[]::text[]),
         (r.rolsuper or r.rolbypassrls),
         exists (
           select 1
             from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
            where a.grantee = 0
              and a.privilege_type = 'EXECUTE'
         )
    into v_proc_owner, v_prosecdef, v_proconfig, v_owner_can_bypass_rls, v_public_exec
    from pg_catalog.pg_proc p
    join pg_catalog.pg_roles r on r.oid = p.proowner
   where p.oid = v_proc;

  if v_proc_owner is null
     or not pg_catalog.pg_has_role(v_proc_owner, v_table_owner, 'USAGE')
     or not coalesce(v_prosecdef, false)
     or not (v_proconfig @> array['search_path=pg_catalog, public'])
     or not coalesce(v_status_rls_forced, false)
     or coalesce(v_status_policy_count, -1) <> 0
     or not coalesce(v_owner_can_bypass_rls, false)
     or pg_catalog.has_table_privilege('anon', v_status_table, 'SELECT')
     or pg_catalog.has_table_privilege('authenticated', v_status_table, 'SELECT')
     or pg_catalog.has_table_privilege('service_role', v_status_table, 'SELECT')
     or not pg_catalog.has_table_privilege(v_proc_owner, v_status_table, 'SELECT')
     or not pg_catalog.has_table_privilege(v_proc_owner, 'public.direct_entries'::pg_catalog.regclass, 'SELECT')
     or not pg_catalog.has_table_privilege(v_proc_owner, 'public.direct_entry_submissions'::pg_catalog.regclass, 'SELECT')
     or not pg_catalog.has_table_privilege(v_proc_owner, 'public.direct_entry_reporting_facts_v01'::pg_catalog.regclass, 'SELECT')
     or not pg_catalog.has_table_privilege(v_proc_owner, 'public.teams'::pg_catalog.regclass, 'SELECT')
     or not pg_catalog.has_function_privilege(v_proc_owner, 'public.direct_entry_reporting_resolve_audience(uuid, uuid)'::pg_catalog.regprocedure, 'EXECUTE')
     or not pg_catalog.has_function_privilege(v_proc_owner, 'public.direct_entry_reporting_authorized_entries(uuid, uuid)'::pg_catalog.regprocedure, 'EXECUTE')
     or not pg_catalog.has_function_privilege(v_proc_owner, 'public.direct_entry_authorization_date()'::pg_catalog.regprocedure, 'EXECUTE')
     or not pg_catalog.has_function_privilege(v_proc_owner, v_proc, 'EXECUTE')
     or not pg_catalog.has_function_privilege('service_role', v_proc, 'EXECUTE')
     or coalesce(v_public_exec, true)
     or pg_catalog.has_function_privilege('public', v_proc, 'EXECUTE')
     or pg_catalog.has_function_privilege('anon', v_proc, 'EXECUTE')
     or pg_catalog.has_function_privilege('authenticated', v_proc, 'EXECUTE') then
    raise exception 'WF-04 RPC security definer owner/RLS/ACL boundary drift'
      using errcode = '55000';
  end if;
end;
$assert_wf04_rpc_boundary$;

commit;
