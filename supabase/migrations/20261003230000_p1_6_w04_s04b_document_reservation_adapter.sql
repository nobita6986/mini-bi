create or replace function public.direct_entry_reserve_document_upload(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_id uuid,
  p_expected_entry_version integer,
  p_document_type text,
  p_idempotency_key text,
  p_checksum_sha256 text,
  p_size_bytes bigint,
  p_mime_type text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_result jsonb;
  v_storage_key text;
  v_scan_status text;
  v_reused boolean;
begin
  select coalesce(i.result is not null, false) into v_reused
    from public.direct_entry_rpc_idempotency i
   where i.app_user_id = p_app_user_id
     and i.action = 'document_metadata_create'
     and i.idempotency_key = p_idempotency_key;
  v_reused := coalesce(v_reused, false);
  v_result := public.direct_entry_create_document_metadata(
    p_auth_subject, p_app_user_id, p_entry_id, p_expected_entry_version,
    p_document_type, p_idempotency_key, p_checksum_sha256, p_size_bytes,
    p_mime_type, p_reason
  );
  select d.storage_key, latest_event.scan_status
    into v_storage_key, v_scan_status
    from public.direct_entry_document_versions d
    join lateral (
      select e.scan_status
        from public.direct_entry_document_events e
       where e.document_id = d.document_id
       order by e.version desc
       limit 1
    ) latest_event on true
   where d.document_id = (v_result->>'document_id')::uuid;
  if v_storage_key is null or v_scan_status is null then
    raise exception 'document reservation unavailable' using errcode = 'P0002';
  end if;
  return v_result || jsonb_build_object(
    'storage_key', v_storage_key, 'scan_status', v_scan_status, 'reused', v_reused
  );
end;
$$;

revoke all on function public.direct_entry_reserve_document_upload(
  uuid, uuid, uuid, integer, text, text, text, bigint, text, text
) from public, anon, authenticated;
grant execute on function public.direct_entry_reserve_document_upload(
  uuid, uuid, uuid, integer, text, text, text, bigint, text, text
) to service_role;
