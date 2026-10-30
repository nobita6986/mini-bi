-- =============================================================================
-- Hotfix: Worker Profile Direct Edit Values & VietQR Bank Catalog Reference
--
-- Scope:
--   1. Allow `gender` to transition to `intentionally_blank` in
--      `public.direct_entry_valid_worker_details` when clearing an existing
--      provided gender value in Direct Edit.
--   2. Widen `direct_entry_payments_metadata_check` on `public.direct_entry_payments`
--      so `state = 'provided'` accepts any non-null combination of
--      `account_number`, `bank_id`, `bank_name`, or `account_holder_name`.
--   3. Provide `public.direct_entry_vietqr_bank_display_name(text)` internal
--      helper mapping canonical VietQR bank codes to their short display names,
--      so selecting a VietQR bank in Direct Edit registers it on demand in
--      `public.direct_entry_banks` without altering existing `bank_id`s or
--      seeding rows into empty bootstrap test databases.
--   4. Update `public.direct_entry_privileged_edit` payment patch validation &
--      persistence:
--      - Accept optional `bank_name` alongside `state`, `account_number`,
--        `bank_id`, and `account_holder_name`.
--      - Allow nullable `account_number`, `bank_id`, `bank_name`, and
--        `account_holder_name` when `state = 'provided'` (requiring at least
--        one non-null field), so reference bank names not in the catalog can
--        be saved with `bank_id = null, bank_name = <reference text>`.
--      - Populate `bank_name` from the catalog when `bank_id` is provided.
--   5. Ensure self-owned bank account eligibility in
--      `public.salary_advance__internal_evaluate_worker` and
--      `public.salary_advance_create_request` depends on `account_number` and
--      `account_holder_name` (not requiring `bank_id`).
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Allow `intentionally_blank` on `gender` in `direct_entry_valid_worker_details`
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_valid_worker_details(p_worker jsonb)
returns boolean
language plpgsql
stable
set search_path = pg_catalog, public
as $$
declare
  v_key text;
  v_field jsonb;
  v_value jsonb;
  v_state text;
begin
  if jsonb_typeof(p_worker) <> 'object'
     or p_worker - array[
       'display_name','date_of_birth','national_id','address','phone','gender',
       'national_id_issued_at','national_id_issued_place'
     ] <> '{}'::jsonb
     or not (p_worker ?& array[
       'display_name','date_of_birth','national_id','address','phone'
     ])
     or jsonb_typeof(p_worker->'display_name') <> 'string'
     or length(btrim(p_worker->>'display_name')) not between 1 and 256 then
    return false;
  end if;

  foreach v_key in array array[
    'date_of_birth','national_id','address','phone','gender',
    'national_id_issued_at','national_id_issued_place'
  ] loop
    if not (p_worker ? v_key) then
      continue;
    end if;
    v_field := p_worker->v_key;
    if jsonb_typeof(v_field) <> 'object'
       or v_field - array['state','value'] <> '{}'::jsonb
       or not (v_field ? 'state') then
      return false;
    end if;
    v_state := v_field->>'state';
    if v_state in ('omitted','unknown','intentionally_blank') then
      if v_field ? 'value' then
        return false;
      end if;
      continue;
    end if;
    if v_state <> 'provided' or not (v_field ? 'value')
       or jsonb_typeof(v_field->'value') <> 'string' then
      return false;
    end if;
    v_value := v_field->'value';
    if v_key in ('date_of_birth','national_id_issued_at') then
      if length(btrim(v_value#>>'{}')) = 0
         or length(v_value#>>'{}') > 10 then
        return false;
      end if;
    elsif v_key = 'gender' then
      if v_value#>>'{}' not in ('MALE','FEMALE','OTHER') then
        return false;
      end if;
    elsif v_key = 'national_id' then
      if length(btrim(v_value#>>'{}')) not in (9,12)
         or v_value#>>'{}' !~ '^[0-9]+$' then
        return false;
      end if;
    elsif v_key = 'national_id_issued_place' then
      if length(btrim(v_value#>>'{}')) not between 1 and 256 then
        return false;
      end if;
    elsif v_key = 'address' and length(v_value#>>'{}') > 1024 then
      return false;
    elsif v_key = 'phone' and length(v_value#>>'{}') > 64 then
      return false;
    end if;
  end loop;

  return true;
end;
$$;

revoke all on function public.direct_entry_valid_worker_details(jsonb)
  from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 2. Widen `direct_entry_payments_metadata_check` on `public.direct_entry_payments`
-- -----------------------------------------------------------------------------
alter table public.direct_entry_payments
  drop constraint if exists direct_entry_payments_metadata_check;

alter table public.direct_entry_payments
  add constraint direct_entry_payments_metadata_check check (
    (
      state in ('omitted', 'unknown', 'intentionally_blank')
      and account_number is null
      and bank_id is null
      and bank_name is null
      and account_holder_name is null
    )
    or (
      state = 'provided'
      and (
        account_number is not null
        or bank_id is not null
        or bank_name is not null
        or account_holder_name is not null
      )
    )
  );

-- -----------------------------------------------------------------------------
-- 3. Internal VietQR bank display name lookup helper
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_vietqr_bank_display_name(p_bank_id text)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $$
  select case pg_catalog.btrim(coalesce(p_bank_id, ''))
    when 'ICB' then 'VietinBank'
    when 'VCB' then 'Vietcombank'
    when 'BIDV' then 'BIDV'
    when 'VBA' then 'Agribank'
    when 'OCB' then 'OCB'
    when 'MB' then 'MBBank'
    when 'TCB' then 'Techcombank'
    when 'ACB' then 'ACB'
    when 'VPB' then 'VPBank'
    when 'TPB' then 'TPBank'
    when 'STB' then 'Sacombank'
    when 'HDB' then 'HDBank'
    when 'VCCB' then 'VietCapitalBank'
    when 'SCB' then 'SCB'
    when 'VIB' then 'VIB'
    when 'SHB' then 'SHB'
    when 'EIB' then 'Eximbank'
    when 'MSB' then 'MSB'
    when 'CAKE' then 'CAKE'
    when 'UBANK' then 'Ubank'
    when 'VIKKI' then 'Vikki'
    when 'TIMO' then 'Timo'
    when 'VNPTMONEY' then 'VNPTMoney'
    when 'VIETTEL_PAY' then 'ViettelMoney'
    when 'SGICB' then 'SaigonBank'
    when 'BAB' then 'BacABank'
    when 'PVCB' then 'PVcomBank'
    when 'PVDB' then 'PVcomBank Pay'
    when 'PBVN' then 'PublicBank'
    when 'MBV' then 'MBV'
    when 'NCB' then 'NCB'
    when 'SHBVN' then 'ShinhanBank'
    when 'ABB' then 'ABBANK'
    when 'VAB' then 'VietABank'
    when 'NAB' then 'NamABank'
    when 'PGB' then 'PGBank'
    when 'VIETBANK' then 'VietBank'
    when 'BVB' then 'BaoVietBank'
    when 'SEAB' then 'SeABank'
    when 'COOPBANK' then 'COOPBANK'
    when 'LPB' then 'LPBank'
    when 'KLB' then 'KienLongBank'
    when 'KBANK' then 'KBank'
    when 'KBHN' then 'KookminHN'
    when 'KBHCM' then 'KookminHCM'
    when 'KEBHANAHCM' then 'KEBHanaHCM'
    when 'KEBHANAHN' then 'KEBHanaHN'
    when 'MAFC' then 'MAFC'
    when 'CITIBANK' then 'Citibank'
    when 'VBSP' then 'VBSP'
    when 'CBB' then 'CBBank'
    when 'CIMB' then 'CIMB'
    when 'DBS' then 'DBSBank'
    when 'GPB' then 'GPBank'
    when 'HLBVN' then 'HongLeong'
    when 'HSBC' then 'HSBC'
    when 'IBKHN' then 'IBKHN'
    when 'IBKHCM' then 'IBKHCM'
    when 'IVB' then 'IndovinaBank'
    when 'NHB_HN' then 'Nonghyup'
    when 'SCVN' then 'StandardChartered'
    when 'UOB' then 'UnitedOverseas'
    when 'VRB' then 'VRB'
    when 'WVN' then 'Woori'
    when 'LIOBANK' then 'Liobank'
    when 'UMEE' then 'Umee'
    when 'VDB' then 'VDB'
    when 'BNPHN' then 'BNPParibasHN'
    when 'BNPHCM' then 'BNPParibasHCM'
    when 'CUB' then 'CathayBank'
    when 'CFC' then 'VietCredit'
    when 'ZALOPAY' then 'ZaloPay'
    when 'VETC' then 'VETC'
    when 'MOMO' then 'MoMo'
    when 'VNPAY' then 'VNPAY'
    else null
  end;
$$;

revoke all on function public.direct_entry_vietqr_bank_display_name(text)
  from public, anon, authenticated, service_role;

do $grant_vietqr_helper$
declare
  v_owner name;
begin
  for v_owner in
    select distinct r.rolname
      from pg_catalog.pg_proc p
      join pg_catalog.pg_roles r on r.oid = p.proowner
     where p.oid in (
       'public.direct_entry_privileged_edit(uuid,uuid,uuid,integer,jsonb,text,text)'::regprocedure,
       'public.salary_advance__internal_evaluate_worker(uuid)'::regprocedure
     )
  loop
    execute format(
      'grant execute on function public.direct_entry_vietqr_bank_display_name(text) to %I',
      v_owner
    );
  end loop;
end;
$grant_vietqr_helper$;

-- -----------------------------------------------------------------------------
-- 4. Update `direct_entry_privileged_edit` payment validation & persistence
-- -----------------------------------------------------------------------------
do $patch_privileged_edit_flexible_payment$
declare
  v_signature regprocedure :=
    'public.direct_entry_privileged_edit(uuid,uuid,uuid,integer,jsonb,text,text)'::regprocedure;
  v_before_owner oid;
  v_before_acl aclitem[];
  v_before_secdef boolean;
  v_before_config text[];
  v_source text;
  v_definition text;
  v_next text;
  v_old text;
  v_new text;
begin
  select p.proowner, p.proacl, p.prosecdef, p.proconfig, p.prosrc, pg_catalog.pg_get_functiondef(p.oid)
    into v_before_owner, v_before_acl, v_before_secdef, v_before_config, v_source, v_definition
    from pg_catalog.pg_proc p
   where p.oid = v_signature;

  v_next := replace(v_source, E'\r\n', E'\n');

  if position('v_payment_bank_name text;' in v_next) = 0 then
    v_old := '  v_payment jsonb;';
    v_new := v_old || E'\n  v_payment_account_number text;\n  v_payment_bank_id text;\n  v_payment_bank_name text;\n  v_payment_account_holder text;\n  v_vietqr_bank_name text;';
    if position(v_old in v_next) = 0 then
      raise exception 'HF edit-values declaration drift in direct_entry_privileged_edit' using errcode = '55000';
    end if;
    v_next := replace(v_next, v_old, v_new);

    v_old := $old$  if p_patch ? 'payment' then
    v_payment := p_patch->'payment';
    if jsonb_typeof(v_payment) <> 'object'
       or (v_payment - array['state','account_number','bank_id','account_holder_name']) <> '{}'::jsonb
       or not (v_payment ? 'state' and v_payment ? 'account_number' and v_payment ? 'bank_id' and v_payment ? 'account_holder_name')
       or jsonb_typeof(v_payment->'state') <> 'string'
       or v_payment->>'state' not in ('omitted','unknown','intentionally_blank','provided')
       or (v_payment->>'state' <> 'provided' and (
         jsonb_typeof(v_payment->'account_number') <> 'null'
         or jsonb_typeof(v_payment->'bank_id') <> 'null'
         or jsonb_typeof(v_payment->'account_holder_name') <> 'null'
       ))
       or (v_payment->>'state' = 'provided' and (
         jsonb_typeof(v_payment->'account_number') <> 'string'
         or (v_payment->>'account_number') !~ '^[0-9]{1,64}$'
         or jsonb_typeof(v_payment->'bank_id') <> 'string'
         or (v_payment->>'bank_id') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
         or jsonb_typeof(v_payment->'account_holder_name') <> 'string'
         or length(btrim(v_payment->>'account_holder_name')) not between 1 and 256
         or (v_payment->>'account_holder_name') ~ '[[:cntrl:]]'
       )) then
      raise exception 'invalid privileged payment input' using errcode = '22023';
    end if;
  end if;$old$;

    v_new := $new$  if p_patch ? 'payment' then
    v_payment := p_patch->'payment';
    if jsonb_typeof(v_payment) <> 'object'
       or (v_payment - array['state','account_number','bank_id','bank_name','account_holder_name']) <> '{}'::jsonb
       or not (v_payment ? 'state' and v_payment ? 'account_number' and v_payment ? 'bank_id' and v_payment ? 'account_holder_name')
       or jsonb_typeof(v_payment->'state') <> 'string'
       or v_payment->>'state' not in ('omitted','unknown','intentionally_blank','provided')
       or jsonb_typeof(v_payment->'account_number') not in ('string','null')
       or jsonb_typeof(v_payment->'bank_id') not in ('string','null')
       or (v_payment ? 'bank_name' and jsonb_typeof(v_payment->'bank_name') not in ('string','null'))
       or jsonb_typeof(v_payment->'account_holder_name') not in ('string','null') then
      raise exception 'invalid privileged payment input' using errcode = '22023';
    end if;
    v_payment_account_number := case
      when jsonb_typeof(v_payment->'account_number') = 'string' then btrim(v_payment->>'account_number')
      else null
    end;
    v_payment_bank_id := case
      when jsonb_typeof(v_payment->'bank_id') = 'string' then btrim(v_payment->>'bank_id')
      else null
    end;
    v_payment_bank_name := case
      when v_payment ? 'bank_name' and jsonb_typeof(v_payment->'bank_name') = 'string' then btrim(v_payment->>'bank_name')
      else null
    end;
    v_payment_account_holder := case
      when jsonb_typeof(v_payment->'account_holder_name') = 'string' then btrim(v_payment->>'account_holder_name')
      else null
    end;
    if v_payment->>'state' <> 'provided' then
      if v_payment_account_number is not null
         or v_payment_bank_id is not null
         or v_payment_bank_name is not null
         or v_payment_account_holder is not null then
        raise exception 'invalid privileged payment input' using errcode = '22023';
      end if;
    else
      if (v_payment_account_number is not null and v_payment_account_number !~ '^[0-9]{1,64}$')
         or (v_payment_bank_id is not null and v_payment_bank_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
         or (v_payment_bank_name is not null and (
           length(v_payment_bank_name) not between 1 and 256
           or v_payment_bank_name ~ '[[:cntrl:]]'
         ))
         or (v_payment_account_holder is not null and (
           length(v_payment_account_holder) not between 1 and 256
           or v_payment_account_holder ~ '[[:cntrl:]]'
         ))
         or (
           v_payment_account_number is null
           and v_payment_bank_id is null
           and v_payment_bank_name is null
           and v_payment_account_holder is null
         ) then
        raise exception 'invalid privileged payment input' using errcode = '22023';
      end if;
    end if;
  end if;$new$;

    if position(v_old in v_next) = 0 then
      raise exception 'HF edit-values payment validation drift in direct_entry_privileged_edit' using errcode = '55000';
    end if;
    v_next := replace(v_next, v_old, v_new);

    v_old := $old$  if v_payment is not null then
    insert into public.direct_entry_payments (
      entry_id, state, account_number, bank_id, bank_name, account_holder_name, version
    ) values (
      p_entry_id, v_payment->>'state', v_payment->>'account_number',
      v_payment->>'bank_id', null,
      case when v_payment->>'account_holder_name' is null then null else btrim(v_payment->>'account_holder_name') end,
      1
    )
    on conflict (entry_id) do update set
      state = excluded.state,
      account_number = excluded.account_number,
      bank_id = excluded.bank_id,
      bank_name = null,
      account_holder_name = excluded.account_holder_name,
      version = public.direct_entry_payments.version + 1,
      updated_at = now();
  end if;$old$;

    v_new := $new$  if v_payment is not null then
    if v_payment->>'state' = 'provided' and v_payment_bank_id is not null then
      if not exists (
        select 1 from public.direct_entry_banks b where b.bank_id = v_payment_bank_id
      ) then
        v_vietqr_bank_name := public.direct_entry_vietqr_bank_display_name(v_payment_bank_id);
        if v_vietqr_bank_name is not null then
          insert into public.direct_entry_banks (bank_id, display_name, active)
          values (v_payment_bank_id, v_vietqr_bank_name, true)
          on conflict (bank_id) do nothing;
        end if;
      end if;
      if v_payment_bank_name is null then
        select b.display_name
          into v_payment_bank_name
          from public.direct_entry_banks b
         where b.bank_id = v_payment_bank_id;
      end if;
    end if;
    insert into public.direct_entry_payments (
      entry_id, state, account_number, bank_id, bank_name, account_holder_name, version
    ) values (
      p_entry_id,
      v_payment->>'state',
      v_payment_account_number,
      v_payment_bank_id,
      v_payment_bank_name,
      v_payment_account_holder,
      1
    )
    on conflict (entry_id) do update set
      state = excluded.state,
      account_number = excluded.account_number,
      bank_id = excluded.bank_id,
      bank_name = excluded.bank_name,
      account_holder_name = excluded.account_holder_name,
      version = public.direct_entry_payments.version + 1,
      updated_at = now();
  end if;$new$;

    if position(v_old in v_next) = 0 then
      raise exception 'HF edit-values payment write drift in direct_entry_privileged_edit' using errcode = '55000';
    end if;
    v_next := replace(v_next, v_old, v_new);

    execute replace(replace(v_definition, E'\r\n', E'\n'), replace(v_source, E'\r\n', E'\n'), v_next);
  end if;

  if not exists (
    select 1
      from pg_catalog.pg_proc p
     where p.oid = v_signature
       and p.proowner = v_before_owner
       and p.proacl is not distinct from v_before_acl
       and p.prosecdef is not distinct from v_before_secdef
       and p.proconfig is not distinct from v_before_config
  ) then
    raise exception 'HF edit-values changed security metadata on direct_entry_privileged_edit' using errcode = '55000';
  end if;
end;
$patch_privileged_edit_flexible_payment$;

-- -----------------------------------------------------------------------------
-- 5. Self-owned bank account eligibility in salary advance depends on
--    `account_number` + `account_holder_name` (not requiring `bank_id`)
-- -----------------------------------------------------------------------------
do $patch_salary_advance_self_owned_bank_eval$
declare
  v_eval_sig regprocedure :=
    'public.salary_advance__internal_evaluate_worker(uuid)'::regprocedure;
  v_create_sig regprocedure :=
    'public.salary_advance_create_request(uuid,uuid,text,uuid,text,text,text,text,text)'::regprocedure;
  v_before_owner oid;
  v_before_acl aclitem[];
  v_before_secdef boolean;
  v_before_config text[];
  v_source text;
  v_definition text;
  v_next text;
  v_old text;
  v_new text;
begin
  select p.proowner, p.proacl, p.prosecdef, p.proconfig, p.prosrc, pg_catalog.pg_get_functiondef(p.oid)
    into v_before_owner, v_before_acl, v_before_secdef, v_before_config, v_source, v_definition
    from pg_catalog.pg_proc p
   where p.oid = v_eval_sig;

  v_next := replace(v_source, E'\r\n', E'\n');

  if position('public.direct_entry_vietqr_bank_display_name(v_pay.bank_id)' in v_next) = 0 then
    v_old := $old$    v_institution_name := coalesce(
      nullif(pg_catalog.btrim(coalesce(v_pay.bank_name, '')), ''),
      nullif(pg_catalog.btrim(coalesce(v_pay.catalog_bank_name, '')), ''),
      nullif(pg_catalog.btrim(coalesce(v_pay.bank_id, '')), '')
    );$old$;
    v_new := $new$    v_institution_name := coalesce(
      nullif(pg_catalog.btrim(coalesce(v_pay.bank_name, '')), ''),
      nullif(pg_catalog.btrim(coalesce(v_pay.catalog_bank_name, '')), ''),
      public.direct_entry_vietqr_bank_display_name(v_pay.bank_id),
      nullif(pg_catalog.btrim(coalesce(v_pay.bank_id, '')), '')
    );$new$;
    if position(v_old in v_next) = 0 then
      raise exception 'HF edit-values institution_name drift in salary_advance__internal_evaluate_worker' using errcode = '55000';
    end if;
    v_next := replace(v_next, v_old, v_new);

    v_old := $old$    v_has_complete_bank := (
      v_account_number is not null
      and v_institution_name is not null
      and v_account_holder_name is not null
      and v_normalized_holder_name <> ''
    );$old$;
    v_new := $new$    v_has_complete_bank := (
      v_account_number is not null
      and v_account_holder_name is not null
      and v_normalized_holder_name <> ''
    );$new$;
    if position(v_old in v_next) = 0 then
      raise exception 'HF edit-values v_has_complete_bank drift in salary_advance__internal_evaluate_worker' using errcode = '55000';
    end if;
    v_next := replace(v_next, v_old, v_new);

    execute replace(replace(v_definition, E'\r\n', E'\n'), replace(v_source, E'\r\n', E'\n'), v_next);
  end if;

  if not exists (
    select 1
      from pg_catalog.pg_proc p
     where p.oid = v_eval_sig
       and p.proowner = v_before_owner
       and p.proacl is not distinct from v_before_acl
       and p.prosecdef is not distinct from v_before_secdef
       and p.proconfig is not distinct from v_before_config
  ) then
    raise exception 'HF edit-values changed security metadata on salary_advance__internal_evaluate_worker' using errcode = '55000';
  end if;

  select p.proowner, p.proacl, p.prosecdef, p.proconfig, p.prosrc, pg_catalog.pg_get_functiondef(p.oid)
    into v_before_owner, v_before_acl, v_before_secdef, v_before_config, v_source, v_definition
    from pg_catalog.pg_proc p
   where p.oid = v_create_sig;

  v_next := replace(v_source, E'\r\n', E'\n');

  if position('''Chưa khai báo ngân hàng''' in v_next) = 0 then
    v_old := $old$    v_destination_snapshot := pg_catalog.jsonb_build_object(
      'bank_id', v_worker_eval->'bank_account'->'bank_id',
      'institution_name', v_worker_eval->'bank_account'->>'institution_name',
      'account_number', v_worker_eval->'bank_account'->>'account_number',$old$;
    v_new := $new$    v_destination_snapshot := pg_catalog.jsonb_build_object(
      'bank_id', v_worker_eval->'bank_account'->'bank_id',
      'institution_name', coalesce(
        nullif(pg_catalog.btrim(coalesce(v_worker_eval->'bank_account'->>'institution_name', '')), ''),
        'Chưa khai báo ngân hàng'
      ),
      'account_number', v_worker_eval->'bank_account'->>'account_number',$new$;
    if position(v_old in v_next) = 0 then
      raise exception 'HF edit-values destination snapshot drift in salary_advance_create_request' using errcode = '55000';
    end if;
    v_next := replace(v_next, v_old, v_new);

    execute replace(replace(v_definition, E'\r\n', E'\n'), replace(v_source, E'\r\n', E'\n'), v_next);
  end if;

  if not exists (
    select 1
      from pg_catalog.pg_proc p
     where p.oid = v_create_sig
       and p.proowner = v_before_owner
       and p.proacl is not distinct from v_before_acl
       and p.prosecdef is not distinct from v_before_secdef
       and p.proconfig is not distinct from v_before_config
  ) then
    raise exception 'HF edit-values changed security metadata on salary_advance_create_request' using errcode = '55000';
  end if;
end;
$patch_salary_advance_self_owned_bank_eval$;

commit;
