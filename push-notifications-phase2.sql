-- =========================================================
-- BUDGET 2A: PUSH NOTIFICATIONS — PHASE 2A SQL FOUNDATION
--
-- Durable per-subscription delivery ledger and two backend-only RPCs.
-- This migration does not send notifications, create Edge Functions,
-- generate VAPID keys, or change any Phase 1 table definition/policy.
-- =========================================================

begin;

-- The controlled production SQL Editor pre-check must confirm this owner.
-- Keeping the owner deterministic is part of the SECURITY DEFINER contract.
do $preflight$
declare
  v_relation record;
  v_function record;
begin
  if current_user <> 'postgres' then
    raise exception 'Phase 2A must be executed as postgres; current_user=%', current_user;
  end if;

  if to_regprocedure('public.set_updated_at()') is null then
    raise exception 'Required function public.set_updated_at() is missing';
  end if;

  if to_regclass('public.notification_events') is null
     or to_regclass('public.push_subscriptions') is null
     or to_regclass('public.notification_preferences') is null
     or to_regclass('public.class_members') is null
     or to_regclass('auth.users') is null then
    raise exception 'Required Phase 1/access relation is missing';
  end if;

  if not exists (select 1 from pg_roles where rolname = 'service_role')
     or not exists (select 1 from pg_roles where rolname = 'authenticated')
     or not exists (select 1 from pg_roles where rolname = 'anon') then
    raise exception 'Required Supabase database role is missing';
  end if;

  select c.relkind, c.relowner, c.relforcerowsecurity
  into v_relation
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'notification_deliveries';

  if found and (
    v_relation.relkind <> 'r'
    or v_relation.relowner <> 'postgres'::regrole
    or v_relation.relforcerowsecurity
  ) then
    raise exception 'Schema conflict: public.notification_deliveries relation/owner/FORCE RLS contract mismatch';
  end if;

  -- Reject same-name overloads. The expected signatures are the only allowed
  -- functions with these names.
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'claim_notification_delivery_batch'
      and p.oid <> coalesce(
        to_regprocedure('public.claim_notification_delivery_batch(uuid,integer)')::oid,
        0::oid
      )
  ) then
    raise exception 'Function conflict: unexpected overload public.claim_notification_delivery_batch';
  end if;

  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'record_notification_delivery_result'
      and p.oid <> coalesce(
        to_regprocedure('public.record_notification_delivery_result(uuid,uuid,text,integer,text,integer)')::oid,
        0::oid
      )
  ) then
    raise exception 'Function conflict: unexpected overload public.record_notification_delivery_result';
  end if;

  -- Existing functions are preserved only when their executable bodies and
  -- hardening metadata match this migration exactly. Incompatible definitions
  -- fail before CREATE OR REPLACE can touch them.
  if to_regprocedure('public.claim_notification_delivery_batch(uuid,integer)') is not null then
    select p.oid, p.prosecdef, p.proconfig, p.proowner, l.lanname,
           md5(p.prosrc) as body_md5
    into v_function
    from pg_proc p
    join pg_language l on l.oid = p.prolang
    where p.oid = 'public.claim_notification_delivery_batch(uuid,integer)'::regprocedure;

    if not v_function.prosecdef
       or v_function.proowner <> 'postgres'::regrole
       or v_function.lanname <> 'plpgsql'
       or cardinality(v_function.proconfig) is distinct from 1
       or replace(v_function.proconfig[1], ' ', '') is distinct from 'search_path=pg_catalog,public,pg_temp'
       or v_function.body_md5 <> '1d6335bf315f67709121e55d5e153505' then
      raise exception 'Function drift: public.claim_notification_delivery_batch(uuid,integer)';
    end if;
  end if;

  if to_regprocedure('public.record_notification_delivery_result(uuid,uuid,text,integer,text,integer)') is not null then
    select p.oid, p.prosecdef, p.proconfig, p.proowner, l.lanname,
           md5(p.prosrc) as body_md5
    into v_function
    from pg_proc p
    join pg_language l on l.oid = p.prolang
    where p.oid = 'public.record_notification_delivery_result(uuid,uuid,text,integer,text,integer)'::regprocedure;

    if not v_function.prosecdef
       or v_function.proowner <> 'postgres'::regrole
       or v_function.lanname <> 'plpgsql'
       or cardinality(v_function.proconfig) is distinct from 1
       or replace(v_function.proconfig[1], ' ', '') is distinct from 'search_path=pg_catalog,public,pg_temp'
       or v_function.body_md5 <> '46eec83b405642f16ecf566ea259a599' then
      raise exception 'Function drift: public.record_notification_delivery_result(uuid,uuid,text,integer,text,integer)';
    end if;
  end if;
end
$preflight$;

create table if not exists public.notification_deliveries (
  id uuid not null default gen_random_uuid(),
  event_id uuid not null,
  subscription_id uuid null,
  subscription_ref uuid not null,
  status text not null default 'queued',
  attempt_count integer not null default 0,
  last_http_status smallint null,
  last_error_code varchar(64) null,
  claim_token uuid null,
  claimed_at timestamptz null,
  next_attempt_at timestamptz null,
  sent_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint notification_deliveries_pkey primary key (id),
  constraint notification_deliveries_event_fkey
    foreign key (event_id)
    references public.notification_events(id)
    on delete restrict,
  constraint notification_deliveries_subscription_fkey
    foreign key (subscription_id)
    references public.push_subscriptions(id)
    on delete set null,
  constraint notification_deliveries_event_subscription_ref_key
    unique (event_id, subscription_ref),
  constraint notification_deliveries_subscription_ref_matches
    check (subscription_id is null or subscription_ref = subscription_id),
  constraint notification_deliveries_status_check
    check (status in ('queued', 'sending', 'sent', 'expired', 'failed', 'skipped')),
  constraint notification_deliveries_attempt_count_check
    check (attempt_count between 0 and 5),
  constraint notification_deliveries_http_status_check
    check (last_http_status is null or last_http_status between 100 and 599),
  constraint notification_deliveries_error_code_check
    check (
      last_error_code is null
      or (
        char_length(last_error_code) between 1 and 64
        and last_error_code ~ '^[a-z0-9][a-z0-9_.:-]{0,63}$'
      )
    ),
  constraint notification_deliveries_claim_state_check
    check (
      (status = 'sending' and claim_token is not null and claimed_at is not null)
      or (status <> 'sending' and claim_token is null)
    ),
  constraint notification_deliveries_sent_state_check
    check (
      (status = 'sent' and sent_at is not null)
      or (status <> 'sent' and sent_at is null)
    )
);

create index if not exists idx_notification_deliveries_event_status
  on public.notification_deliveries (event_id, status);

create index if not exists idx_notification_deliveries_claimable
  on public.notification_deliveries (event_id, next_attempt_at, created_at)
  where status = 'queued';

create index if not exists idx_notification_deliveries_stale_claims
  on public.notification_deliveries (event_id, claimed_at)
  where status = 'sending';

create index if not exists idx_notification_deliveries_subscription
  on public.notification_deliveries (subscription_id)
  where subscription_id is not null;

alter table public.notification_deliveries enable row level security;

-- No direct data path exists even for service_role. The Edge backend receives
-- only the two narrowly-scoped SECURITY DEFINER RPCs below.
revoke all on public.notification_deliveries
from public, anon, authenticated, service_role;

-- Reuse the already-audited generic updated_at trigger function.
do $trigger$
declare
  v_actual record;
begin
  select t.tgtype, t.tgenabled, t.tgattr, t.tgqual, t.tgnargs, t.tgfoid
  into v_actual
  from pg_trigger t
  where t.tgrelid = 'public.notification_deliveries'::regclass
    and t.tgname = 'notification_deliveries_set_updated_at'
    and not t.tgisinternal;

  if found then
    if v_actual.tgtype <> 19
       or v_actual.tgenabled <> 'O'
       or v_actual.tgattr is distinct from ''::int2vector
       or v_actual.tgqual is not null
       or v_actual.tgnargs <> 0
       or v_actual.tgfoid <> 'public.set_updated_at()'::regprocedure then
      raise exception 'Trigger drift: public.notification_deliveries_set_updated_at';
    end if;
  else
    execute 'create trigger notification_deliveries_set_updated_at '
      || 'before update on public.notification_deliveries '
      || 'for each row execute function public.set_updated_at()';
  end if;
end
$trigger$;

do $create_claim$
begin
  if to_regprocedure('public.claim_notification_delivery_batch(uuid,integer)') is null then
    execute $definition$
create function public.claim_notification_delivery_batch(
  p_event_id uuid,
  p_limit integer default 25
)
returns table (
  delivery_id uuid,
  claim_token uuid,
  endpoint text,
  p256dh text,
  auth text,
  event_id uuid,
  event_type text,
  title text,
  body text,
  deep_link text,
  attempt_count integer
)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $claim$
declare
  v_event public.notification_events%rowtype;
  v_claimed_ids uuid[] := array[]::uuid[];
  v_has_active boolean;
  v_has_failed boolean;
begin
  if p_event_id is null then
    raise exception 'p_event_id is required';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 25 then
    raise exception 'p_limit must be between 1 and 25';
  end if;

  select notification_event.*
  into v_event
  from public.notification_events as notification_event
  where notification_event.id = p_event_id
  for update;

  if not found then
    raise exception 'Notification event not found';
  end if;

  if v_event.status = 'queued' then
    insert into public.notification_deliveries (
      event_id,
      subscription_id,
      subscription_ref
    )
    select
      v_event.id,
      subscription.id,
      subscription.id
    from public.push_subscriptions as subscription
    join auth.users as auth_user
      on auth_user.id = subscription.user_id
    join public.class_members as class_member
      on class_member.email = lower(auth_user.email)
    left join public.notification_preferences as preference
      on preference.user_id = subscription.user_id
    where subscription.enabled = true
      and auth_user.email is not null
      and case v_event.event_type
        when 'schedule' then coalesce(preference.schedule_enabled, true)
        when 'memo' then coalesce(preference.memos_enabled, true)
        when 'announcement' then coalesce(preference.announcements_enabled, true)
        else false
      end
    on conflict on constraint notification_deliveries_event_subscription_ref_key do nothing;

    update public.notification_events as notification_event
    set status = 'sending',
        attempt_count = notification_event.attempt_count + 1,
        last_error = null
    where notification_event.id = v_event.id;

    v_event.status := 'sending';
  elsif v_event.status <> 'sending' then
    -- sent and failed are terminal. A retry requires a new trusted event.
    return;
  end if;

  -- Recover the exact accepted five-minute lease without consuming a new
  -- attempt. Eligibility is evaluated before retry exhaustion so loss of
  -- recipient access always wins over delivery failure accounting.
  update public.notification_deliveries as delivery
  set status = 'queued',
      claim_token = null,
      next_attempt_at = now(),
      last_error_code = 'stale_claim_recovered'
  where delivery.event_id = v_event.id
    and delivery.status = 'sending'
    and delivery.claimed_at <= now() - interval '5 minutes';

  -- A deleted subscription leaves its opaque subscription_ref audit identity.
  update public.notification_deliveries as delivery
  set status = 'skipped',
      next_attempt_at = null,
      last_error_code = 'subscription_removed'
  where delivery.event_id = v_event.id
    and delivery.status = 'queued'
    and delivery.subscription_id is null;

  update public.notification_deliveries as delivery
  set status = 'skipped',
      next_attempt_at = null,
      last_error_code = 'subscription_disabled'
  where delivery.event_id = v_event.id
    and delivery.status = 'queued'
    and exists (
      select 1
      from public.push_subscriptions as subscription
      where subscription.id = delivery.subscription_id
        and subscription.enabled = false
    );

  update public.notification_deliveries as delivery
  set status = 'skipped',
      next_attempt_at = null,
      last_error_code = 'recipient_revoked'
  where delivery.event_id = v_event.id
    and delivery.status = 'queued'
    and not exists (
      select 1
      from public.push_subscriptions as subscription
      join auth.users as auth_user
        on auth_user.id = subscription.user_id
      join public.class_members as class_member
        on class_member.email = lower(auth_user.email)
      where subscription.id = delivery.subscription_id
        and auth_user.email is not null
    );

  update public.notification_deliveries as delivery
  set status = 'skipped',
      next_attempt_at = null,
      last_error_code = 'preference_disabled'
  where delivery.event_id = v_event.id
    and delivery.status = 'queued'
    and exists (
      select 1
      from public.push_subscriptions as subscription
      join auth.users as auth_user
        on auth_user.id = subscription.user_id
      join public.class_members as class_member
        on class_member.email = lower(auth_user.email)
      left join public.notification_preferences as preference
        on preference.user_id = subscription.user_id
      where subscription.id = delivery.subscription_id
        and auth_user.email is not null
        and not case v_event.event_type
          when 'schedule' then coalesce(preference.schedule_enabled, true)
          when 'memo' then coalesce(preference.memos_enabled, true)
          when 'announcement' then coalesce(preference.announcements_enabled, true)
          else false
        end
    );

  update public.notification_deliveries as delivery
  set status = 'failed',
      next_attempt_at = null,
      last_error_code = 'retry_exhausted'
  where delivery.event_id = v_event.id
    and delivery.status = 'queued'
    and delivery.attempt_count >= 5;

  -- The candidate query repeats every recipient condition at claim-time.
  -- FOR UPDATE SKIP LOCKED ensures concurrent workers claim disjoint rows.
  with candidate as (
    select delivery.id
    from public.notification_deliveries as delivery
    join public.push_subscriptions as subscription
      on subscription.id = delivery.subscription_id
     and subscription.enabled = true
    join auth.users as auth_user
      on auth_user.id = subscription.user_id
     and auth_user.email is not null
    join public.class_members as class_member
      on class_member.email = lower(auth_user.email)
    left join public.notification_preferences as preference
      on preference.user_id = subscription.user_id
    where delivery.event_id = v_event.id
      and delivery.status = 'queued'
      and (delivery.next_attempt_at is null or delivery.next_attempt_at <= now())
      and delivery.attempt_count < 5
      and case v_event.event_type
        when 'schedule' then coalesce(preference.schedule_enabled, true)
        when 'memo' then coalesce(preference.memos_enabled, true)
        when 'announcement' then coalesce(preference.announcements_enabled, true)
        else false
      end
    order by delivery.next_attempt_at nulls first, delivery.created_at, delivery.id
    for update of delivery skip locked
    limit p_limit
  ), claimed as (
    update public.notification_deliveries as delivery
    set status = 'sending',
        claim_token = gen_random_uuid(),
        claimed_at = now(),
        next_attempt_at = null,
        attempt_count = delivery.attempt_count + 1,
        last_http_status = null,
        last_error_code = null
    from candidate
    where delivery.id = candidate.id
    returning delivery.id
  )
  select coalesce(array_agg(claimed.id order by claimed.id), array[]::uuid[])
  into v_claimed_ids
  from claimed;

  -- Aggregate completion is mandatory even when v_claimed_ids is empty.
  select
    exists (
      select 1
      from public.notification_deliveries as delivery
      where delivery.event_id = v_event.id
        and delivery.status in ('queued', 'sending')
    ),
    exists (
      select 1
      from public.notification_deliveries as delivery
      where delivery.event_id = v_event.id
        and delivery.status = 'failed'
    )
  into v_has_active, v_has_failed;

  update public.notification_events as notification_event
  set status = case
        when v_has_active then 'sending'
        when v_has_failed then 'failed'
        else 'sent'
      end,
      last_error = case when v_has_failed then 'delivery_failed' else null end
  where notification_event.id = v_event.id;

  return query
  select
    delivery.id,
    delivery.claim_token,
    subscription.endpoint,
    subscription.p256dh,
    subscription.auth,
    v_event.id,
    v_event.event_type,
    v_event.title,
    v_event.body,
    v_event.deep_link,
    delivery.attempt_count
  from public.notification_deliveries as delivery
  join public.push_subscriptions as subscription
    on subscription.id = delivery.subscription_id
  where delivery.id = any(v_claimed_ids)
  order by delivery.id;
end;
$claim$;
$definition$;
  end if;
end
$create_claim$;

do $create_record$
begin
  if to_regprocedure('public.record_notification_delivery_result(uuid,uuid,text,integer,text,integer)') is null then
    execute $definition$
create function public.record_notification_delivery_result(
  p_delivery_id uuid,
  p_claim_token uuid,
  p_outcome text,
  p_http_status integer default null,
  p_error_code text default null,
  p_retry_after_seconds integer default null
)
returns table (
  delivery_status text,
  event_status text,
  next_attempt_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $record$
declare
  v_delivery public.notification_deliveries%rowtype;
  v_event_id uuid;
  v_next_attempt_at timestamptz;
  v_error_code text;
  v_backoff_seconds integer;
  v_has_active boolean;
  v_has_failed boolean;
  v_event_status text;
begin
  if p_delivery_id is null or p_claim_token is null then
    raise exception 'p_delivery_id and p_claim_token are required';
  end if;
  if p_outcome is null
     or p_outcome not in ('success', 'expired', 'transient', 'permanent') then
    raise exception 'Unsupported delivery outcome';
  end if;
  if p_error_code is not null
     and (
       char_length(p_error_code) not between 1 and 64
       or p_error_code !~ '^[a-z0-9][a-z0-9_.:-]{0,63}$'
     ) then
    raise exception 'p_error_code must be a sanitized machine code';
  end if;
  if p_retry_after_seconds is not null and p_retry_after_seconds <= 0 then
    raise exception 'p_retry_after_seconds must be positive';
  end if;

  if p_outcome = 'success' then
    if p_http_status is null or p_http_status not between 200 and 299
       or p_error_code is not null or p_retry_after_seconds is not null then
      raise exception 'success requires 2xx and no error/retry fields';
    end if;
  elsif p_outcome = 'expired' then
    if p_http_status is null
       or p_http_status not in (404, 410)
       or p_error_code is not null or p_retry_after_seconds is not null then
      raise exception 'expired requires exactly HTTP 404 or 410';
    end if;
  elsif p_outcome = 'transient' then
    if not (
      p_http_status is null
      or p_http_status = 429
      or p_http_status between 500 and 599
    ) then
      raise exception 'transient requires network NULL, HTTP 429, or HTTP 5xx';
    end if;
    if p_retry_after_seconds is not null and p_http_status is distinct from 429 then
      raise exception 'Retry-After is accepted only for HTTP 429';
    end if;
  else
    if p_http_status is null
       or p_http_status not between 400 and 499
       or p_http_status in (404, 410, 429)
       or p_retry_after_seconds is not null then
      raise exception 'permanent requires a non-expired, non-transient HTTP 4xx';
    end if;
  end if;

  -- Establish the lock order used by both RPCs: event first, delivery second.
  select delivery.event_id
  into v_event_id
  from public.notification_deliveries as delivery
  where delivery.id = p_delivery_id;

  if not found then
    raise exception 'Notification delivery not found';
  end if;

  perform 1
  from public.notification_events as notification_event
  where notification_event.id = v_event_id
  for update;

  if not found then
    raise exception 'Notification event not found';
  end if;

  select delivery.*
  into v_delivery
  from public.notification_deliveries as delivery
  where delivery.id = p_delivery_id
    and delivery.status = 'sending'
    and delivery.claim_token = p_claim_token
  for update;

  if not found then
    raise exception 'Delivery claim is no longer current';
  end if;

  if p_outcome = 'success' then
    update public.notification_deliveries as delivery
    set status = 'sent',
        sent_at = now(),
        next_attempt_at = null,
        last_http_status = p_http_status::smallint,
        last_error_code = null,
        claim_token = null
    where delivery.id = v_delivery.id;

    update public.push_subscriptions as subscription
    set last_success_at = now(),
        failure_count = 0
    where subscription.id = v_delivery.subscription_id;

  elsif p_outcome = 'expired' then
    update public.notification_deliveries as delivery
    set status = 'expired',
        next_attempt_at = null,
        last_http_status = p_http_status::smallint,
        last_error_code = 'subscription_expired',
        claim_token = null
    where delivery.id = v_delivery.id;

    update public.push_subscriptions as subscription
    set enabled = false,
        last_failure_at = now(),
        failure_count = least(subscription.failure_count::bigint + 1, 2147483647)::integer
    where subscription.id = v_delivery.subscription_id;

  elsif p_outcome = 'transient' then
    if p_http_status is null then
      v_error_code := coalesce(p_error_code, 'network_failure');
    elsif p_http_status = 429 then
      v_error_code := coalesce(p_error_code, 'push_rate_limited');
    else
      v_error_code := coalesce(p_error_code, 'push_server_error');
    end if;

    if v_delivery.attempt_count >= 5 then
      update public.notification_deliveries as delivery
      set status = 'failed',
          next_attempt_at = null,
          last_http_status = p_http_status::smallint,
          last_error_code = 'retry_exhausted',
          claim_token = null
      where delivery.id = v_delivery.id;
    else
      v_backoff_seconds := case v_delivery.attempt_count
        when 1 then 30
        when 2 then 60
        when 3 then 120
        when 4 then 240
        else 480
      end;

      if p_http_status = 429 and p_retry_after_seconds is not null then
        v_backoff_seconds := greatest(30, least(86400, p_retry_after_seconds));
      end if;

      v_next_attempt_at := now() + make_interval(secs => v_backoff_seconds);

      update public.notification_deliveries as delivery
      set status = 'queued',
          next_attempt_at = v_next_attempt_at,
          last_http_status = p_http_status::smallint,
          last_error_code = v_error_code,
          claim_token = null
      where delivery.id = v_delivery.id;
    end if;

    update public.push_subscriptions as subscription
    set last_failure_at = now(),
        failure_count = least(subscription.failure_count::bigint + 1, 2147483647)::integer
    where subscription.id = v_delivery.subscription_id;

  else
    v_error_code := coalesce(p_error_code, 'push_client_error');

    update public.notification_deliveries as delivery
    set status = 'failed',
        next_attempt_at = null,
        last_http_status = p_http_status::smallint,
        last_error_code = v_error_code,
        claim_token = null
    where delivery.id = v_delivery.id;

    update public.push_subscriptions as subscription
    set last_failure_at = now(),
        failure_count = least(subscription.failure_count::bigint + 1, 2147483647)::integer
    where subscription.id = v_delivery.subscription_id;
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

  update public.notification_events as notification_event
  set status = v_event_status,
      last_error = case when v_has_failed then 'delivery_failed' else null end
  where notification_event.id = v_event_id;

  return query
  select
    delivery.status,
    v_event_status,
    delivery.next_attempt_at
  from public.notification_deliveries as delivery
  where delivery.id = v_delivery.id;
end;
$record$;
$definition$;
  end if;
end
$create_record$;

alter function public.claim_notification_delivery_batch(uuid, integer) owner to postgres;
alter function public.record_notification_delivery_result(uuid, uuid, text, integer, text, integer) owner to postgres;

revoke all on function public.claim_notification_delivery_batch(uuid, integer)
from public, anon, authenticated, service_role;
grant execute on function public.claim_notification_delivery_batch(uuid, integer)
to service_role;

revoke all on function public.record_notification_delivery_result(uuid, uuid, text, integer, text, integer)
from public, anon, authenticated, service_role;
grant execute on function public.record_notification_delivery_result(uuid, uuid, text, integer, text, integer)
to service_role;

-- =========================================================
-- STRICT POST-MIGRATION CATALOG VALIDATION
-- =========================================================
do $validate$
declare
  v_actual record;
  v_expected record;
  v_count integer;
  v_names text[];
begin
  -- Exact ordinary-table and RLS contract.
  select c.relkind, c.relpersistence, c.relispartition,
         c.relowner, c.relrowsecurity, c.relforcerowsecurity
  into v_actual
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'notification_deliveries';

  if not found or v_actual.relkind <> 'r'
     or v_actual.relpersistence <> 'p'
     or v_actual.relispartition
     or v_actual.relowner <> 'postgres'::regrole
     or not v_actual.relrowsecurity
     or v_actual.relforcerowsecurity then
    raise exception 'Schema drift: public.notification_deliveries table/owner/RLS contract mismatch';
  end if;

  select count(*) into v_count
  from pg_attribute a
  where a.attrelid = 'public.notification_deliveries'::regclass
    and a.attnum > 0 and not a.attisdropped;
  if v_count <> 14 then
    raise exception 'Schema drift: notification_deliveries must have exactly 14 columns';
  end if;

  for v_expected in
    select * from (values
      (1,'id','uuid','NO','gen_random_uuid()'),
      (2,'event_id','uuid','NO',null),
      (3,'subscription_id','uuid','YES',null),
      (4,'subscription_ref','uuid','NO',null),
      (5,'status','text','NO','''queued''::text'),
      (6,'attempt_count','integer','NO','0'),
      (7,'last_http_status','smallint','YES',null),
      (8,'last_error_code','character varying','YES',null),
      (9,'claim_token','uuid','YES',null),
      (10,'claimed_at','timestamp with time zone','YES',null),
      (11,'next_attempt_at','timestamp with time zone','YES',null),
      (12,'sent_at','timestamp with time zone','YES',null),
      (13,'created_at','timestamp with time zone','NO','now()'),
      (14,'updated_at','timestamp with time zone','NO','now()')
    ) as expected(ordinal_position,column_name,data_type,is_nullable,default_expr)
  loop
    select c.data_type, c.is_nullable,
           pg_get_expr(ad.adbin, ad.adrelid, true) as default_expr,
           c.character_maximum_length, c.ordinal_position,
           c.is_identity, c.is_generated
    into v_actual
    from information_schema.columns c
    join pg_attribute a
      on a.attrelid = 'public.notification_deliveries'::regclass
     and a.attname = c.column_name
     and a.attnum > 0 and not a.attisdropped
    left join pg_attrdef ad
      on ad.adrelid = a.attrelid and ad.adnum = a.attnum
    where c.table_schema = 'public'
      and c.table_name = 'notification_deliveries'
      and c.column_name = v_expected.column_name;

    if not found
       or v_actual.data_type <> v_expected.data_type
       or v_actual.is_nullable <> v_expected.is_nullable
       or v_actual.ordinal_position <> v_expected.ordinal_position
       or v_actual.is_identity <> 'NO'
       or v_actual.is_generated <> 'NEVER'
       or v_actual.default_expr is distinct from v_expected.default_expr then
      raise exception 'Schema drift: notification_deliveries.% column contract mismatch',
        v_expected.column_name;
    end if;

    if v_expected.column_name = 'last_error_code'
       and v_actual.character_maximum_length <> 64 then
      raise exception 'Schema drift: notification_deliveries.last_error_code must be varchar(64)';
    end if;
  end loop;

  -- Exact named constraint set: PK, two FKs, UNIQUE, and seven CHECKs.
  select array_agg(c.conname order by c.conname), count(*)
  into v_names, v_count
  from pg_constraint c
  where c.conrelid = 'public.notification_deliveries'::regclass;

  if v_count <> 11
     or v_names <> array[
       'notification_deliveries_attempt_count_check',
       'notification_deliveries_claim_state_check',
       'notification_deliveries_error_code_check',
       'notification_deliveries_event_fkey',
       'notification_deliveries_event_subscription_ref_key',
       'notification_deliveries_http_status_check',
       'notification_deliveries_pkey',
       'notification_deliveries_sent_state_check',
       'notification_deliveries_status_check',
       'notification_deliveries_subscription_fkey',
       'notification_deliveries_subscription_ref_matches'
     ]::text[] then
    raise exception 'Schema drift: notification_deliveries constraint allowlist mismatch: %', v_names;
  end if;

  -- Semantic PK.
  if not exists (
    select 1
    from pg_constraint c
    where c.conrelid = 'public.notification_deliveries'::regclass
      and c.conname = 'notification_deliveries_pkey'
      and c.contype = 'p'
      and c.convalidated
      and not c.condeferrable and not c.condeferred
      and c.conkey = array[(
        select a.attnum from pg_attribute a
        where a.attrelid = c.conrelid and a.attname = 'id'
      )]::smallint[]
  ) then
    raise exception 'Schema drift: notification_deliveries primary key mismatch';
  end if;

  -- Semantic FKs and exact delete actions: RESTRICT='r', SET NULL='n'.
  if not exists (
    select 1
    from pg_constraint c
    where c.conrelid = 'public.notification_deliveries'::regclass
      and c.conname = 'notification_deliveries_event_fkey'
      and c.contype = 'f' and c.convalidated and c.confdeltype = 'r'
      and c.confupdtype = 'a' and c.confmatchtype = 's'
      and not c.condeferrable and not c.condeferred
      and c.confrelid = 'public.notification_events'::regclass
      and c.conkey = array[(select attnum from pg_attribute where attrelid = c.conrelid and attname = 'event_id')]::smallint[]
      and c.confkey = array[(select attnum from pg_attribute where attrelid = c.confrelid and attname = 'id')]::smallint[]
  ) then
    raise exception 'Schema drift: notification_deliveries event FK mismatch';
  end if;

  if not exists (
    select 1
    from pg_constraint c
    where c.conrelid = 'public.notification_deliveries'::regclass
      and c.conname = 'notification_deliveries_subscription_fkey'
      and c.contype = 'f' and c.convalidated and c.confdeltype = 'n'
      and c.confupdtype = 'a' and c.confmatchtype = 's'
      and not c.condeferrable and not c.condeferred
      and c.confrelid = 'public.push_subscriptions'::regclass
      and c.conkey = array[(select attnum from pg_attribute where attrelid = c.conrelid and attname = 'subscription_id')]::smallint[]
      and c.confkey = array[(select attnum from pg_attribute where attrelid = c.confrelid and attname = 'id')]::smallint[]
  ) then
    raise exception 'Schema drift: notification_deliveries subscription FK mismatch';
  end if;

  -- Exact immutable idempotency UNIQUE.
  if not exists (
    select 1
    from pg_constraint c
    where c.conrelid = 'public.notification_deliveries'::regclass
      and c.conname = 'notification_deliveries_event_subscription_ref_key'
      and c.contype = 'u' and c.convalidated
      and not c.condeferrable and not c.condeferred
      and c.conkey = array[
        (select attnum from pg_attribute where attrelid = c.conrelid and attname = 'event_id'),
        (select attnum from pg_attribute where attrelid = c.conrelid and attname = 'subscription_ref')
      ]::smallint[]
  ) then
    raise exception 'Schema drift: notification_deliveries UNIQUE mismatch';
  end if;

  -- CHECK names, validation state, and canonical expression semantics are
  -- exact. Cast/format normalization is deliberately limited to casts that
  -- PostgreSQL adds while deparsing these known column/literal comparisons.
  if exists (
    select 1
    from pg_constraint c
    where c.conrelid = 'public.notification_deliveries'::regclass
      and c.contype = 'c' and not c.convalidated
  ) then
    raise exception 'Schema drift: notification_deliveries has an unvalidated CHECK';
  end if;

  for v_expected in
    select * from (values
      ('notification_deliveries_subscription_ref_matches',
       'subscription_idisnullorsubscription_ref=subscription_id'),
      ('notification_deliveries_status_check',
       'status=anyarray[''queued'',''sending'',''sent'',''expired'',''failed'',''skipped'']'),
      ('notification_deliveries_attempt_count_check',
       'attempt_count>=0andattempt_count<=5'),
      ('notification_deliveries_http_status_check',
       'last_http_statusisnullorlast_http_status>=100andlast_http_status<=599'),
      ('notification_deliveries_error_code_check',
       'last_error_codeisnullorchar_lengthlast_error_code>=1andchar_lengthlast_error_code<=64andlast_error_code~''^[a-z0-9][a-z0-9_.:-]{0,63}$'''),
      ('notification_deliveries_claim_state_check',
       'status=''sending''andclaim_tokenisnotnullandclaimed_atisnotnullorstatus<>''sending''andclaim_tokenisnull'),
      ('notification_deliveries_sent_state_check',
       'status=''sent''andsent_atisnotnullorstatus<>''sent''andsent_atisnull')
    ) as expected(constraint_name,definition_norm)
  loop
    select replace(replace(replace(
             regexp_replace(lower(pg_get_expr(c.conbin, c.conrelid, true)),
                            '[[:space:]()]', '', 'g'),
             '::text', ''), '::integer', ''), '::smallint', '') as definition_norm
    into v_actual
    from pg_constraint c
    where c.conrelid = 'public.notification_deliveries'::regclass
      and c.conname = v_expected.constraint_name
      and c.contype = 'c'
      and c.convalidated;

    if not found or v_actual.definition_norm <> v_expected.definition_norm then
      raise exception 'Schema drift: CHECK public.notification_deliveries.% mismatch',
        v_expected.constraint_name;
    end if;
  end loop;

  -- Exact index contract, including key order, no INCLUDE columns and predicates.
  for v_expected in
    select * from (values
      ('idx_notification_deliveries_event_status', array['event_id','status']::text[], false, 'none'),
      ('idx_notification_deliveries_claimable', array['event_id','next_attempt_at','created_at']::text[], false, 'status=''queued''::text'),
      ('idx_notification_deliveries_stale_claims', array['event_id','claimed_at']::text[], false, 'status=''sending''::text'),
      ('idx_notification_deliveries_subscription', array['subscription_id']::text[], false, 'subscription_idisnotnull')
    ) as expected(index_name,key_names,is_unique,predicate_norm)
  loop
    select i.indisunique, i.indisvalid, i.indisready,
           i.indisprimary, i.indisexclusion, i.indimmediate,
           i.indnkeyatts, i.indnatts, i.indexprs, am.amname,
           keys.key_names,
           regexp_replace(lower(coalesce(pg_get_expr(i.indpred, i.indrelid, true), '')), '[[:space:]()]', '', 'g') as predicate_norm
    into v_actual
    from pg_index i
    join pg_class idx on idx.oid = i.indexrelid
    join pg_namespace n on n.oid = idx.relnamespace
    join pg_am am on am.oid = idx.relam
    cross join lateral (
      select array_agg(a.attname order by ord.ordinality) as key_names
      from unnest(i.indkey::smallint[]) with ordinality as ord(attnum, ordinality)
      join pg_attribute a on a.attrelid = i.indrelid and a.attnum = ord.attnum
      where ord.ordinality <= i.indnkeyatts
    ) as keys
    where n.nspname = 'public'
      and idx.relname = v_expected.index_name
      and i.indrelid = 'public.notification_deliveries'::regclass;

    if not found
       or v_actual.indisunique <> v_expected.is_unique
       or not v_actual.indisvalid or not v_actual.indisready
       or v_actual.indisprimary or v_actual.indisexclusion
       or not v_actual.indimmediate
       or v_actual.indexprs is not null
       or v_actual.amname <> 'btree'
       or v_actual.indnkeyatts <> v_actual.indnatts
       or v_actual.key_names::text[] <> v_expected.key_names
       or v_actual.predicate_norm <> (
         case
           when v_expected.predicate_norm = 'none' then ''
           else v_expected.predicate_norm
         end
       ) then
      raise exception 'Schema drift: index public.% mismatch', v_expected.index_name;
    end if;
  end loop;

  -- Besides PK/UNIQUE backing indexes, exactly four named secondary indexes exist.
  select count(*) into v_count
  from pg_index i
  join pg_class idx on idx.oid = i.indexrelid
  where i.indrelid = 'public.notification_deliveries'::regclass
    and not exists (
      select 1 from pg_constraint c
      where c.conindid = i.indexrelid
    );
  if v_count <> 4 then
    raise exception 'Schema drift: notification_deliveries must have exactly four secondary indexes';
  end if;

  -- RLS policy allowlist is deliberately empty.
  select count(*) into v_count
  from pg_policies
  where schemaname = 'public' and tablename = 'notification_deliveries';
  if v_count <> 0 then
    raise exception 'Security drift: notification_deliveries must have zero policies';
  end if;

  -- The owner is the only table ACL grantee. PUBLIC, all application roles,
  -- and any unexpected custom role have no direct delivery-table privilege.
  if exists (
    select 1
    from pg_class c
    cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) acl
    left join pg_roles role_entry on role_entry.oid = acl.grantee
    where c.oid = 'public.notification_deliveries'::regclass
      and acl.grantee <> c.relowner
  ) then
    raise exception 'ACL drift: notification_deliveries has an unexpected direct grant';
  end if;

  if exists (
    select 1
    from pg_attribute a
    where a.attrelid = 'public.notification_deliveries'::regclass
      and a.attnum > 0 and not a.attisdropped and a.attacl is not null
  ) then
    raise exception 'ACL drift: notification_deliveries has an explicit column ACL';
  end if;

  -- Exactly one user trigger with exact BEFORE UPDATE ROW semantics.
  select count(*) into v_count
  from pg_trigger t
  where t.tgrelid = 'public.notification_deliveries'::regclass
    and not t.tgisinternal;
  if v_count <> 1 then
    raise exception 'Trigger drift: notification_deliveries must have exactly one user trigger';
  end if;

  select t.tgtype, t.tgenabled, t.tgattr, t.tgqual, t.tgnargs, t.tgfoid
  into v_actual
  from pg_trigger t
  where t.tgrelid = 'public.notification_deliveries'::regclass
    and t.tgname = 'notification_deliveries_set_updated_at'
    and not t.tgisinternal;
  if not found or v_actual.tgtype <> 19 or v_actual.tgenabled <> 'O'
     or v_actual.tgattr is distinct from ''::int2vector
     or v_actual.tgqual is not null or v_actual.tgnargs <> 0
     or v_actual.tgfoid <> 'public.set_updated_at()'::regprocedure then
    raise exception 'Trigger drift: notification_deliveries updated_at trigger mismatch';
  end if;

  -- Exact RPC metadata/body contract.
  for v_expected in
    select * from (values
      ('claim_notification_delivery_batch',
       'public.claim_notification_delivery_batch(uuid,integer)'::regprocedure::oid,
       'uuid, integer', 2, 1,
       'p_event_iduuid,p_limitintegerdefault25',
       'table(delivery_iduuid,claim_tokenuuid,endpointtext,p256dhtext,authtext,event_iduuid,event_typetext,titletext,bodytext,deep_linktext,attempt_countinteger)',
       '1d6335bf315f67709121e55d5e153505'),
      ('record_notification_delivery_result',
       'public.record_notification_delivery_result(uuid,uuid,text,integer,text,integer)'::regprocedure::oid,
       'uuid, uuid, text, integer, text, integer', 6, 3,
       'p_delivery_iduuid,p_claim_tokenuuid,p_outcometext,p_http_statusintegerdefaultnull,p_error_codetextdefaultnull,p_retry_after_secondsintegerdefaultnull',
       'table(delivery_statustext,event_statustext,next_attempt_attimestampwithtimezone)',
       '46eec83b405642f16ecf566ea259a599')
    ) as expected(function_name,function_oid,arg_types,arg_count,default_count,
                  arguments_norm,result_norm,body_md5)
  loop
    select p.proname, p.prosecdef, p.proowner, p.proconfig, p.pronargs,
           p.pronargdefaults, p.proretset, p.prorettype,
           oidvectortypes(p.proargtypes) as arg_types,
           replace(replace(
             regexp_replace(lower(pg_get_function_arguments(p.oid)), '[[:space:]]', '', 'g'),
             '::integer', ''), '::text', '') as arguments_norm,
           regexp_replace(lower(pg_get_function_result(p.oid)), '[[:space:]]', '', 'g') as result_norm,
           p.prokind, p.provolatile, p.proparallel, p.proisstrict, p.proleakproof,
           l.lanname, md5(p.prosrc) as body_md5
    into v_actual
    from pg_proc p
    join pg_language l on l.oid = p.prolang
    where p.oid = v_expected.function_oid;

    if not found
       or v_actual.proname <> v_expected.function_name
       or not v_actual.prosecdef
       or v_actual.proowner <> 'postgres'::regrole
       or v_actual.lanname <> 'plpgsql'
       or v_actual.pronargs <> v_expected.arg_count
       or v_actual.pronargdefaults <> v_expected.default_count
       or v_actual.arg_types <> v_expected.arg_types
       or v_actual.arguments_norm <> v_expected.arguments_norm
       or v_actual.result_norm <> v_expected.result_norm
       or not v_actual.proretset
       or v_actual.prorettype <> 'record'::regtype
       or v_actual.prokind <> 'f'
       or v_actual.provolatile <> 'v'
       or v_actual.proparallel <> 'u'
       or v_actual.proisstrict
       or v_actual.proleakproof
       or cardinality(v_actual.proconfig) is distinct from 1
       or replace(v_actual.proconfig[1], ' ', '') is distinct from 'search_path=pg_catalog,public,pg_temp'
       or v_actual.body_md5 <> v_expected.body_md5 then
      raise exception 'Function drift: public.% metadata/body mismatch', v_expected.function_name;
    end if;
  end loop;

  -- Only service_role receives EXECUTE, without grant option. The function
  -- owner retains its inherent owner privileges and is excluded here.
  for v_expected in
    select unnest(array[
      'public.claim_notification_delivery_batch(uuid,integer)'::regprocedure::oid,
      'public.record_notification_delivery_result(uuid,uuid,text,integer,text,integer)'::regprocedure::oid
    ]::oid[]) as function_oid
  loop
    if exists (
      select 1
      from pg_proc p
      cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
      left join pg_roles role_entry on role_entry.oid = acl.grantee
      where p.oid = v_expected.function_oid
        and acl.grantee <> p.proowner
        and not (
          role_entry.rolname = 'service_role'
          and acl.privilege_type = 'EXECUTE'
          and not acl.is_grantable
        )
    ) then
      raise exception 'ACL drift: backend RPC has unexpected EXECUTE ACL';
    end if;

    if not exists (
      select 1
      from pg_proc p
      cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
      join pg_roles role_entry on role_entry.oid = acl.grantee
      where p.oid = v_expected.function_oid
        and role_entry.rolname = 'service_role'
        and acl.privilege_type = 'EXECUTE'
        and not acl.is_grantable
    ) then
      raise exception 'ACL drift: service_role EXECUTE is missing from backend RPC';
    end if;
  end loop;
end
$validate$;

notify pgrst, 'reload schema';
commit;

-- Clean rerun preserves delivery rows and correct objects. Same-name schema,
-- function, trigger, index, RLS, or ACL drift fails the transaction.
