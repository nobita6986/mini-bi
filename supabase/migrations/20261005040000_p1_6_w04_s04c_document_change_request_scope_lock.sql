-- P1.6-W04-S04C-S03B4B1 - P1.6 change-request scope excludes DOCUMENT.
-- Fail before schema changes if historical DOCUMENT items exist; preserve all rows.
do $$
begin
  if exists (
    select 1
      from public.direct_entry_change_request_items
     where target_kind = 'DOCUMENT'
  ) then
    raise exception 'DOCUMENT change request items exist; refusing scope lock'
      using errcode = '23514';
  end if;
end;
$$;

alter table public.direct_entry_change_request_items
  add constraint direct_entry_change_request_items_document_scope_lock
  check (target_kind <> 'DOCUMENT');
