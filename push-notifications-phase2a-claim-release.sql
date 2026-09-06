-- =========================================================
-- BUDGET 2A: PUSH NOTIFICATIONS — PHASE 2A.1 CLAIM RELEASE
--
-- Additive backend-only RPC for releasing a delivery claim when the trusted
-- sender has not started the external Web Push request. The consumed claim
-- attempt is restored exactly once under the current claim token.
-- =========================================================

begin;

do $preflight$
declare
  v_count integer;
begin
  if current_user <> 'postgres' then
    raise exception 'Phase 2A.1 must be executed as postgres; current_user=%', current_user;
  end if;

  if to_regclass('public.notification_deliveries') is null
     or to_regclass('public.notification_events') is null then
    raise exception 'Required Phase 2A relation is missing';
  end if;

  if to_regprocedure('public.claim_notification_delivery_batch(uuid,integer)') is null
     or to_regprocedure('public.record_notification_delivery_result(uuid,uuid,text,integer,text,integer)') is null then
    raise exception 'Required Phase 2A backend RPC is missing';
  end if;

  if not exists (select 1 from pg_roles where rolname = 'service_role')
     or not exists (select 1 from pg_roles where rolname = 'authenticated')
     or not exists (select 1 from pg_roles where rolname = 'anon') then
    raise exception 'Required Supabase database role is missing';
  end if;

  select count(*)
  into v_count
  from pg_proc as procedure_entry
  join pg_namespace as namespace_entry
    on namespace_entry.oid = procedure_entry.pronamespace
  where namespace_entry.nspname = 'public'
    and procedure_entry.proname = 'release_notification_delivery_claim';

  if v_count <> 0 then
    raise exception 'Function conflict: public.release_notification_delivery_claim already exists';
  end if;

  if not exists (
    select 1
    from pg_class as relation_entry
    join pg_namespace as namespace_entry
      on namespace_entry.oid = relation_entry.relnamespace
    where namespace_entry.nspname = 'public'
      and relation_entry.relname = 'notification_deliveries'
      and relation_entry.relkind = 'r'
      and relation_entry.relowner = 'postgres'::regrole
      and relation_entry.relrowsecurity
      and not relation_entry.relforcerowsecurity
  ) then
    raise exception 'Required notification_deliveries table/owner/RLS contract mismatch';
  end if;

  if (
    select count(*)
    from pg_attribute as attribute_entry
    where attribute_entry.attrelid = 'public.notification_deliveries'::regclass
      and attribute_entry.attnum > 0
      and not attribute_entry.attisdropped
      and (attribute_entry.attname, attribute_entry.atttypid, attribute_entry.attnotnull) in (
        ('id', 'uuid'::regtype, true),
        ('event_id', 'uuid'::regtype, true),
        ('status', 'text'::regtype, true),
        ('attempt_count', 'integer'::regtype, true),
        ('last_http_status', 'smallint'::regtype, false),
        ('last_error_code', 'character varying'::regtype, false),
        ('claim_token', 'uuid'::regtype, false),
        ('claimed_at', 'timestamp with time zone'::regtype, false),
        ('next_attempt_at', 'timestamp with time zone'::regtype, false),
        ('sent_at', 'timestamp with time zone'::regtype, false),
        ('updated_at', 'timestamp with time zone'::regtype, true)
      )
  ) <> 11 then
    raise exception 'Required notification_deliveries column contract mismatch';
  end if;

  if not exists (
    select 1
    from pg_trigger as trigger_entry
    where trigger_entry.tgrelid = 'public.notification_deliveries'::regclass
      and trigger_entry.tgname = 'notification_deliveries_set_updated_at'
      and not trigger_entry.tgisinternal
      and trigger_entry.tgtype = 19
      and trigger_entry.tgenabled = 'O'
      and trigger_entry.tgfoid = 'public.set_updated_at()'::regprocedure
  ) then
    raise exception 'Required notification_deliveries updated_at trigger mismatch';
  end if;

  if (
    select count(*)
    from pg_constraint as constraint_entry
    where constraint_entry.conrelid = 'public.notification_deliveries'::regclass
      and constraint_entry.conname in (
        'notification_deliveries_status_check',
        'notification_deliveries_attempt_count_check',
        'notification_deliveries_claim_state_check',
        'notification_deliveries_sent_state_check'
      )
      and constraint_entry.contype = 'c'
      and constraint_entry.convalidated
  ) <> 4 then
    raise exception 'Required notification_deliveries CHECK contract is missing';
  end if;
end
$preflight$;

create function public.release_notification_delivery_claim(
  p_delivery_id uuid,
  p_claim_token uuid
)
returns table (
  delivery_status text,
  event_status text,
  attempt_count integer,
  next_attempt_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $release$
declare
  v_event_id uuid;
  v_delivery public.notification_deliveries%rowtype;
  v_has_active boolean;
  v_has_failed boolean;
  v_event_status text;
begin
  if p_delivery_id is null or p_claim_token is null then
    raise exception 'p_delivery_id and p_claim_token are required';
  end if;

  -- Match the Phase 2A lock order: resolve the event id, lock the event,
  -- then lock the exact current delivery claim.
  select delivery.event_id
  into v_event_id
  from public.notification_deliveries as delivery
  where delivery.id = p_delivery_id;

  if not found then
    raise exception 'Notification delivery claim is not releasable';
  end if;

  perform 1
  from public.notification_events as notification_event
  where notification_event.id = v_event_id
    and notification_event.status = 'sending'
  for update;

  if not found then
    raise exception 'Notification delivery claim is not releasable';
  end if;

  select delivery.*
  into v_delivery
  from public.notification_deliveries as delivery
  where delivery.id = p_delivery_id
    and delivery.status = 'sending'
    and delivery.claim_token = p_claim_token
    and delivery.attempt_count > 0
    and delivery.claimed_at is not null
    and delivery.sent_at is null
  for update;

  if not found then
    raise exception 'Notification delivery claim is not releasable';
  end if;

  update public.notification_deliveries as delivery
  set status = 'queued',
      attempt_count = delivery.attempt_count - 1,
      claim_token = null,
      claimed_at = null,
      next_attempt_at = null,
      last_http_status = null,
      last_error_code = 'claim_released_unsent'
  where delivery.id = v_delivery.id
    and delivery.status = 'sending'
    and delivery.claim_token = p_claim_token
    and delivery.attempt_count > 0
    and delivery.sent_at is null
  returning delivery.* into v_delivery;

  if not found then
    raise exception 'Notification delivery claim is no longer releasable';
  end if;

  select
    exists (
      select 1
      from public.notification_deliveries as delivery
      where delivery.event_id = v_event_id
        and delivery.status in ('queued', 'sending')
    ),
    exists (
      select 1
      from public.notification_deliveries as delivery
      where delivery.event_id = v_event_id
        and delivery.status = 'failed'
    )
  into v_has_active, v_has_failed;

  v_event_status := case
    when v_has_active then 'sending'
    when v_has_failed then 'failed'
    else 'sent'
  end;

  if v_event_status <> 'sending' then
    raise exception 'Notification event aggregate is inconsistent after claim release';
  end if;

  update public.notification_events as notification_event
  set status = v_event_status,
      last_error = case when v_has_failed then 'delivery_failed' else null end
  where notification_event.id = v_event_id;

  return query
  select
    v_delivery.status,
    v_event_status,
    v_delivery.attempt_count,
    v_delivery.next_attempt_at;
end;
$release$;

alter function public.release_notification_delivery_claim(uuid, uuid) owner to postgres;

revoke all on function public.release_notification_delivery_claim(uuid, uuid)
from public, anon, authenticated, service_role;
grant execute on function public.release_notification_delivery_claim(uuid, uuid)
to service_role;

do $validate$
declare
  v_actual record;
  v_count integer;
begin
  select count(*)
  into v_count
  from pg_proc as procedure_entry
  join pg_namespace as namespace_entry
    on namespace_entry.oid = procedure_entry.pronamespace
  where namespace_entry.nspname = 'public'
    and procedure_entry.proname = 'release_notification_delivery_claim';

  if v_count <> 1
     or to_regprocedure('public.release_notification_delivery_claim(uuid,uuid)') is null then
    raise exception 'Function drift: release_notification_delivery_claim signature/count mismatch';
  end if;

  select
    procedure_entry.proname,
    procedure_entry.prosecdef,
    procedure_entry.proowner,
    procedure_entry.proconfig,
    procedure_entry.pronargs,
    procedure_entry.pronargdefaults,
    procedure_entry.proretset,
    procedure_entry.prorettype,
    oidvectortypes(procedure_entry.proargtypes) as arg_types,
    regexp_replace(
      lower(pg_get_function_arguments(procedure_entry.oid)),
      '[[:space:]]', '', 'g'
    ) as arguments_norm,
    regexp_replace(
      lower(pg_get_function_result(procedure_entry.oid)),
      '[[:space:]]', '', 'g'
    ) as result_norm,
    procedure_entry.prokind,
    procedure_entry.provolatile,
    procedure_entry.proparallel,
    procedure_entry.proisstrict,
    procedure_entry.proleakproof,
    language_entry.lanname,
    md5(procedure_entry.prosrc) as body_md5
  into v_actual
  from pg_proc as procedure_entry
  join pg_language as language_entry
    on language_entry.oid = procedure_entry.prolang
  where procedure_entry.oid = 'public.release_notification_delivery_claim(uuid,uuid)'::regprocedure;

  if not found
     or v_actual.proname <> 'release_notification_delivery_claim'
     or not v_actual.prosecdef
     or v_actual.proowner <> 'postgres'::regrole
     or v_actual.lanname <> 'plpgsql'
     or v_actual.pronargs <> 2
     or v_actual.pronargdefaults <> 0
     or v_actual.arg_types <> 'uuid, uuid'
     or v_actual.arguments_norm <> 'p_delivery_iduuid,p_claim_tokenuuid'
     or v_actual.result_norm <> 'table(delivery_statustext,event_statustext,attempt_countinteger,next_attempt_attimestampwithtimezone)'
     or not v_actual.proretset
     or v_actual.prorettype <> 'record'::regtype
     or v_actual.prokind <> 'f'
     or v_actual.provolatile <> 'v'
     or v_actual.proparallel <> 'u'
     or v_actual.proisstrict
     or v_actual.proleakproof
     or cardinality(v_actual.proconfig) is distinct from 1
     or replace(v_actual.proconfig[1], ' ', '') is distinct from 'search_path=pg_catalog,public,pg_temp'
     or v_actual.body_md5 <> 'a4637e3c9523b115c2ad9f40c1e3a28c' then
    raise exception 'Function drift: release_notification_delivery_claim metadata/body mismatch';
  end if;

  if exists (
    select 1
    from pg_proc as procedure_entry
    cross join lateral aclexplode(
      coalesce(procedure_entry.proacl, acldefault('f', procedure_entry.proowner))
    ) as acl_entry
    left join pg_roles as role_entry
      on role_entry.oid = acl_entry.grantee
    where procedure_entry.oid = 'public.release_notification_delivery_claim(uuid,uuid)'::regprocedure
      and acl_entry.grantee <> procedure_entry.proowner
      and not (
        role_entry.rolname = 'service_role'
        and acl_entry.privilege_type = 'EXECUTE'
        and not acl_entry.is_grantable
      )
  ) then
    raise exception 'ACL drift: claim release RPC has unexpected EXECUTE ACL';
  end if;

  if not exists (
    select 1
    from pg_proc as procedure_entry
    cross join lateral aclexplode(
      coalesce(procedure_entry.proacl, acldefault('f', procedure_entry.proowner))
    ) as acl_entry
    join pg_roles as role_entry
      on role_entry.oid = acl_entry.grantee
    where procedure_entry.oid = 'public.release_notification_delivery_claim(uuid,uuid)'::regprocedure
      and role_entry.rolname = 'service_role'
      and acl_entry.privilege_type = 'EXECUTE'
      and not acl_entry.is_grantable
  ) then
    raise exception 'ACL drift: service_role EXECUTE is missing from claim release RPC';
  end if;
end
$validate$;

notify pgrst, 'reload schema';
commit;

-- Rerun policy: an exact second run stops in preflight because the additive
-- function already exists. This migration never replaces an existing RPC.
