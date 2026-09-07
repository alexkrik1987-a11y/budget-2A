-- Durable push dispatch. Additive, backend-only, one-shot send permits.
-- Exact re-frozen contract: requested begin timeout survives auto-release;
-- release_reason is the accepted logical input, not the eligibility outcome.
-- No external I/O. Legacy RPCs are neither called nor replaced.
begin;

do $preflight$
declare v_name text; v_sig text; v_hash text;
begin
  if current_user <> 'postgres' then raise exception 'POSTGRES_OWNER_REQUIRED'; end if;
  foreach v_name in array array['postgres','anon','authenticated','service_role'] loop
    if not exists(select 1 from pg_roles where rolname=v_name) then raise exception 'ROLE_MISSING'; end if;
  end loop;
  foreach v_name in array array['notification_dispatch_jobs','notification_dispatch_attempts'] loop
    if to_regclass('public.'||v_name) is not null then raise exception 'DURABLE_DISPATCH_ALREADY_EXISTS'; end if;
  end loop;
  if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname = any(array[
      'enqueue_notification_dispatch','acquire_notification_dispatch_job',
      'prepare_notification_dispatch_batch','get_notification_dispatch_state',
      'begin_notification_dispatch_send','record_notification_dispatch_result',
      'release_notification_dispatch_attempt','settle_notification_dispatch_job'])) then
    raise exception 'DURABLE_DISPATCH_RPC_CONFLICT';
  end if;
  foreach v_name in array array['notification_events','notification_deliveries',
    'push_subscriptions','notification_preferences','class_members'] loop
    if to_regclass('public.'||v_name) is null then raise exception 'BASELINE_MISSING'; end if;
  end loop;
  if to_regclass('auth.users') is null then raise exception 'AUTH_BASELINE_MISSING'; end if;
  for v_sig,v_hash in select * from (values
    ('public.claim_notification_delivery_batch(uuid,integer)','1d6335bf315f67709121e55d5e153505'),
    ('public.record_notification_delivery_result(uuid,uuid,text,integer,text,integer)','46eec83b405642f16ecf566ea259a599'),
    ('public.release_notification_delivery_claim(uuid,uuid)','a4637e3c9523b115c2ad9f40c1e3a28c')
  ) x(s,h) loop
    if not exists(select 1 from pg_proc where oid=to_regprocedure(v_sig)
      and md5(prosrc)=v_hash and proowner='postgres'::regrole and prosecdef) then
      raise exception 'LEGACY_CONTRACT_MISMATCH';
    end if;
  end loop;
end
$preflight$;

create table public.notification_dispatch_jobs (
  id uuid not null default gen_random_uuid() primary key,
  event_id uuid not null unique,
  event_key text not null unique,
  event_type text not null,
  title text not null,
  body text not null,
  source_entity text not null,
  source_entity_id text not null,
  deep_link text not null,
  enqueued_by uuid not null,
  stage text not null default 'ready',
  next_run_at timestamptz null default now(),
  snapshot_at timestamptz null,
  lease_epoch bigint not null default 0,
  lease_owner uuid null,
  lease_started_at timestamptz null,
  lease_until timestamptz null,
  acquire_operation_id uuid null unique,
  acquire_expected_epoch bigint null,
  batch_id uuid null unique,
  batch_limit integer null,
  batch_prepared_at timestamptz null,
  batch_count integer null,
  settle_operation_id uuid null unique,
  settled_at timestamptz null,
  settle_reason text null,
  last_error_code varchar(64) null,
  completed_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dispatch_job_event_fk foreign key(event_id)
    references public.notification_events(id) on delete restrict deferrable initially deferred,
  constraint dispatch_job_payload check(
    char_length(btrim(event_key)) between 1 and 200
    and event_type in ('schedule','memo','announcement')
    and char_length(btrim(title)) between 1 and 160
    and char_length(btrim(body)) between 1 and 500
    and source_entity in ('class_profile','chat_messages')
    and char_length(btrim(source_entity_id))>0 and deep_link='/'),
  constraint dispatch_job_stage check(stage in ('ready','leased','waiting','completed','blocked')),
  constraint dispatch_job_lease check(
    (lease_epoch=0 and num_nonnulls(lease_owner,lease_started_at,lease_until,
      acquire_operation_id,acquire_expected_epoch,batch_id,batch_limit,batch_prepared_at,
      batch_count,settle_operation_id,settled_at,settle_reason)=0)
    or (lease_epoch>0 and num_nonnulls(lease_owner,lease_started_at,lease_until,
      acquire_operation_id,acquire_expected_epoch,batch_id,batch_limit,settle_operation_id)=8
      and acquire_expected_epoch=lease_epoch-1 and lease_until>lease_started_at
      and batch_limit between 1 and 25)),
  constraint dispatch_job_batch check(
    (batch_prepared_at is null and batch_count is null)
    or (batch_prepared_at is not null and batch_count is not null and batch_count between 0 and batch_limit)),
  constraint dispatch_job_settle check(
    (settled_at is null and settle_reason is null)
    or (settled_at is not null and settle_reason is not null and settle_reason in ('yield','transient_backend','configuration_blocked'))),
  constraint dispatch_job_schedule check(
    ((stage in ('ready','waiting') and next_run_at is not null)
      or (stage in ('leased','completed','blocked') and next_run_at is null))
    and (stage<>'leased' or lease_epoch>0)
    and ((stage='completed' and completed_at is not null) or (stage<>'completed' and completed_at is null))
    and (stage<>'blocked' or last_error_code is not null)),
  constraint dispatch_job_error check(last_error_code is null or last_error_code ~ '^[a-z0-9][a-z0-9_.:-]{0,63}$')
);
create index idx_notification_dispatch_jobs_due
  on public.notification_dispatch_jobs(next_run_at,id) where stage in ('ready','waiting');
create index idx_notification_dispatch_jobs_expired_lease
  on public.notification_dispatch_jobs(lease_until,id) where stage='leased';

create table public.notification_dispatch_attempts (
  id uuid not null default gen_random_uuid() primary key,
  job_id uuid not null references public.notification_dispatch_jobs(id) on delete restrict,
  delivery_id uuid not null references public.notification_deliveries(id) on delete restrict,
  subscription_ref uuid not null,
  batch_id uuid not null,
  prepared_epoch bigint not null check(prepared_epoch>0),
  attempt_no integer not null check(attempt_no between 1 and 5),
  claim_token uuid not null unique,
  credentials_hash bytea not null check(octet_length(credentials_hash)=32),
  stage text not null default 'prepared',
  begin_operation_id uuid not null default gen_random_uuid() unique,
  record_operation_id uuid not null default gen_random_uuid() unique,
  ambiguity_operation_id uuid not null default gen_random_uuid() unique,
  release_operation_id uuid not null default gen_random_uuid() unique,
  prepared_at timestamptz not null default now(),
  begin_requested_timeout_ms integer null check(begin_requested_timeout_ms between 1 and 8000),
  send_owner uuid null,
  send_epoch bigint null,
  send_timeout_ms integer null,
  send_started_at timestamptz null,
  send_deadline_at timestamptz null,
  ambiguity_after timestamptz null,
  ambiguity_at timestamptz null,
  ambiguity_reason text null,
  provider_outcome text null,
  provider_http_status smallint null,
  provider_retry_after_seconds integer null,
  result_recorded_at timestamptz null,
  release_reason text null,
  released_at timestamptz null,
  release_owner uuid null,
  release_epoch bigint null,
  release_attempt_count integer null,
  updated_at timestamptz not null default now(),
  unique(job_id,batch_id,delivery_id),
  constraint dispatch_attempt_stage check(stage in ('prepared','send_started','result_recorded','ambiguous','released')),
  constraint dispatch_attempt_send check(
    num_nonnulls(send_owner,send_epoch,send_timeout_ms,send_started_at,send_deadline_at,ambiguity_after)=0
    or (num_nonnulls(send_owner,send_epoch,send_timeout_ms,send_started_at,send_deadline_at,ambiguity_after)=6
      and begin_requested_timeout_ms is not null
      and send_epoch=prepared_epoch and send_timeout_ms=begin_requested_timeout_ms
      and send_timeout_ms between 1 and 8000
      and send_deadline_at=send_started_at+send_timeout_ms*interval '1 millisecond'
      and ambiguity_after=send_deadline_at+interval '5 seconds')),
  constraint dispatch_attempt_ambiguity check(
    (ambiguity_at is null and ambiguity_reason is null)
    or (ambiguity_at is not null and ambiguity_reason is not null
      and ambiguity_reason in ('provider_timeout','provider_reset','provider_unknown_response','send_result_missing'))),
  constraint dispatch_attempt_provider check(
    (num_nonnulls(provider_outcome,provider_http_status,provider_retry_after_seconds,result_recorded_at)=0)
    or (provider_outcome is not null and provider_http_status is not null and result_recorded_at is not null
      and ((provider_outcome='sent' and provider_http_status between 200 and 299)
        or (provider_outcome='expired' and provider_http_status in (404,410))
        or (provider_outcome='retryable' and (provider_http_status=429 or provider_http_status between 500 and 599))
        or (provider_outcome='permanent_failure' and provider_http_status between 400 and 499
          and provider_http_status not in (404,410,429)))
      and (provider_retry_after_seconds is null
        or (provider_outcome='retryable' and provider_http_status=429 and provider_retry_after_seconds>0)))),
  constraint dispatch_attempt_release check(
    num_nonnulls(release_reason,released_at,release_owner,release_epoch,release_attempt_count)=0
    or (num_nonnulls(release_reason,released_at,release_owner,release_epoch,release_attempt_count)=5
      and release_epoch>0 and release_attempt_count=attempt_no-1
      and release_reason in ('worker_budget','stale_prepared','credentials_changed',
        'subscription_removed','subscription_disabled','recipient_revoked','preference_disabled'))),
  constraint dispatch_attempt_stage_fields check(
    (stage='prepared' and begin_requested_timeout_ms is null and send_started_at is null
      and ambiguity_at is null and result_recorded_at is null and released_at is null)
    or (stage='send_started' and send_started_at is not null and ambiguity_at is null
      and result_recorded_at is null and released_at is null)
    or (stage='ambiguous' and send_started_at is not null and ambiguity_at is not null
      and result_recorded_at is null and released_at is null)
    or (stage='result_recorded' and send_started_at is not null and result_recorded_at is not null and released_at is null)
    or (stage='released' and send_started_at is null and ambiguity_at is null
      and result_recorded_at is null and released_at is not null))
);
create unique index idx_notification_dispatch_attempts_active
  on public.notification_dispatch_attempts(delivery_id) where stage in ('prepared','send_started');
create index idx_notification_dispatch_attempts_batch
  on public.notification_dispatch_attempts(job_id,batch_id,id);
create index idx_notification_dispatch_attempts_recovery
  on public.notification_dispatch_attempts(job_id,stage,ambiguity_after,id);
create index idx_notification_dispatch_attempts_delivery
  on public.notification_dispatch_attempts(delivery_id,prepared_at,id);

alter table public.notification_dispatch_jobs owner to postgres;
alter table public.notification_dispatch_attempts owner to postgres;
alter table public.notification_dispatch_jobs enable row level security;
alter table public.notification_dispatch_attempts enable row level security;
revoke all on public.notification_dispatch_jobs,public.notification_dispatch_attempts
  from public,anon,authenticated,service_role;

create function public.enqueue_notification_dispatch(
  p_event_key text,
  p_event_type text,
  p_title text,
  p_body text,
  p_source_entity text,
  p_source_entity_id text,
  p_deep_link text,
  p_created_by uuid
)
returns table(disposition text,job_id uuid,event_id uuid,job_stage text,event_status text)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
set statement_timeout = '5s'
set lock_timeout = '750ms'
as $rpc$
#variable_conflict use_column
declare
  v_j public.notification_dispatch_jobs%rowtype;
  v_e public.notification_events%rowtype;
  v_d public.notification_deliveries%rowtype;
  v_a public.notification_dispatch_attempts%rowtype;
  v_s public.push_subscriptions%rowtype;
  v_job_id uuid; v_now timestamptz; v_reason text; v_logical text;
  v_disp text; v_active boolean; v_failed boolean; v_ambig boolean;
  v_next timestamptz; v_ids uuid[]; v_count integer; v_delay integer;
begin
  if num_nonnulls(p_event_key,p_event_type,p_title,p_body,p_source_entity,p_source_entity_id,p_deep_link,p_created_by)<>8 then
    raise exception 'INVALID_ENQUEUE_ARGUMENT'; end if;
  v_job_id:=gen_random_uuid();
  -- Deferred event FK: insert/lock job first; no legacy event is adopted.
  insert into public.notification_dispatch_jobs as j
    (id,event_id,event_key,event_type,title,body,source_entity,source_entity_id,deep_link,enqueued_by)
    values(v_job_id,gen_random_uuid(),p_event_key,p_event_type,p_title,p_body,p_source_entity,p_source_entity_id,p_deep_link,p_created_by)
    on conflict(event_key) do nothing returning j.* into v_j;
  if found then
    if exists(select 1 from public.notification_events e where e.event_key=p_event_key) then
      raise exception 'EVENT_WITHOUT_DISPATCH_JOB'; end if;
    insert into public.notification_events(id,event_key,event_type,title,body,source_entity,source_entity_id,deep_link,created_by)
      values(v_j.event_id,p_event_key,p_event_type,p_title,p_body,p_source_entity,p_source_entity_id,p_deep_link,p_created_by)
      returning * into v_e;
    v_disp:='created';
  else
    select j.* into v_j from public.notification_dispatch_jobs j where j.event_key=p_event_key for update;
    select e.* into v_e from public.notification_events e where e.id=v_j.event_id for update;
    if not found then raise exception 'EVENT_NOT_FOUND'; end if;
    if row(v_j.event_key,v_j.event_type,v_j.title,v_j.body,v_j.source_entity,v_j.source_entity_id,v_j.deep_link)
      is distinct from row(p_event_key,p_event_type,p_title,p_body,p_source_entity,p_source_entity_id,p_deep_link)
      or row(v_e.event_key,v_e.event_type,v_e.title,v_e.body,v_e.source_entity,v_e.source_entity_id,v_e.deep_link)
      is distinct from row(p_event_key,p_event_type,p_title,p_body,p_source_entity,p_source_entity_id,p_deep_link) then
      raise exception 'EVENT_CONFLICT'; end if;
    v_disp:='existing';
  end if;
  return query select v_disp,v_j.id,v_j.event_id,v_j.stage,v_e.status;
end;
$rpc$;

create function public.acquire_notification_dispatch_job(
  p_job_id uuid,
  p_worker_id uuid,
  p_operation_id uuid,
  p_expected_epoch bigint,
  p_limit integer default 25
)
returns table(disposition text,job_id uuid,event_id uuid,job_stage text,lease_epoch bigint,lease_until timestamptz,batch_id uuid,batch_limit integer,settle_operation_id uuid)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
set statement_timeout = '5s'
set lock_timeout = '750ms'
as $rpc$
#variable_conflict use_column
declare
  v_j public.notification_dispatch_jobs%rowtype;
  v_e public.notification_events%rowtype;
  v_d public.notification_deliveries%rowtype;
  v_a public.notification_dispatch_attempts%rowtype;
  v_s public.push_subscriptions%rowtype;
  v_job_id uuid; v_now timestamptz; v_reason text; v_logical text;
  v_disp text; v_active boolean; v_failed boolean; v_ambig boolean;
  v_next timestamptz; v_ids uuid[]; v_count integer; v_delay integer;
begin
  if num_nonnulls(p_job_id,p_worker_id,p_operation_id,p_expected_epoch,p_limit)<>5
    or p_limit not between 1 and 25 or p_expected_epoch<0 then raise exception 'INVALID_ACQUIRE_ARGUMENT'; end if;
  select j.* into v_j from public.notification_dispatch_jobs j where j.id=p_job_id for update skip locked;
  if not found then
    if not exists(select 1 from public.notification_dispatch_jobs j where j.id=p_job_id) then raise exception 'JOB_NOT_FOUND'; end if;
    return query select 'busy'::text,p_job_id,null::uuid,null::text,null::bigint,null::timestamptz,null::uuid,null::integer,null::uuid;
    return;
  end if;
  v_now:=clock_timestamp();
  if v_j.acquire_operation_id=p_operation_id then
    if row(v_j.acquire_expected_epoch,v_j.lease_owner,v_j.batch_limit)
      is distinct from row(p_expected_epoch,p_worker_id,p_limit) then raise exception 'OPERATION_ARGUMENT_CONFLICT'; end if;
    v_disp:=case when v_j.stage in ('completed','blocked') then 'terminal'
      when v_j.stage='leased' and v_j.lease_until>v_now then 'existing_lease' else null end;
    if v_disp is null then raise exception 'OPERATION_SUPERSEDED'; end if;
  elsif p_expected_epoch<>v_j.lease_epoch then
    raise exception 'OPERATION_SUPERSEDED';
  elsif v_j.stage in ('completed','blocked') then v_disp:='terminal';
  elsif v_j.stage='leased' and v_j.lease_until>v_now then v_disp:='busy';
  elsif v_j.stage in ('ready','waiting') and v_j.next_run_at>v_now then v_disp:='not_due';
  else
    update public.notification_dispatch_jobs j set stage='leased',next_run_at=null,
      lease_epoch=j.lease_epoch+1,lease_owner=p_worker_id,lease_started_at=v_now,lease_until=v_now+interval '90 seconds',
      acquire_operation_id=p_operation_id,acquire_expected_epoch=p_expected_epoch,
      batch_id=gen_random_uuid(),batch_limit=p_limit,batch_prepared_at=null,batch_count=null,
      settle_operation_id=gen_random_uuid(),settled_at=null,settle_reason=null,
      completed_at=null,last_error_code=null,updated_at=v_now where j.id=p_job_id returning j.* into v_j;
    v_disp:='acquired';
  end if;
  return query select v_disp,v_j.id,v_j.event_id,v_j.stage,v_j.lease_epoch,v_j.lease_until,v_j.batch_id,v_j.batch_limit,v_j.settle_operation_id;
end;
$rpc$;

create function public.prepare_notification_dispatch_batch(
  p_job_id uuid,
  p_worker_id uuid,
  p_lease_epoch bigint,
  p_batch_id uuid
)
returns table(disposition text,job_id uuid,event_id uuid,batch_id uuid,batch_count integer,snapshot_at timestamptz,job_stage text,event_status text)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
set statement_timeout = '5s'
set lock_timeout = '750ms'
as $rpc$
#variable_conflict use_column
declare
  v_j public.notification_dispatch_jobs%rowtype;
  v_e public.notification_events%rowtype;
  v_d public.notification_deliveries%rowtype;
  v_a public.notification_dispatch_attempts%rowtype;
  v_s public.push_subscriptions%rowtype;
  v_job_id uuid; v_now timestamptz; v_reason text; v_logical text;
  v_disp text; v_active boolean; v_failed boolean; v_ambig boolean;
  v_next timestamptz; v_ids uuid[]; v_count integer; v_delay integer;
begin
  v_job_id:=p_job_id;
  -- Resolve without locks, then acquire every existing row in one global order.
  select j.* into v_j from public.notification_dispatch_jobs j where j.id=v_job_id for update;
  if not found then raise exception 'JOB_NOT_FOUND'; end if;
  select e.* into v_e from public.notification_events e where e.id=v_j.event_id for update;
  if not found then raise exception 'EVENT_NOT_FOUND'; end if;
  perform d.id from public.notification_deliveries d where d.event_id=v_j.event_id order by d.id for update;
  perform a.id from public.notification_dispatch_attempts a where a.job_id=v_j.id order by a.id for update;
  perform s.id from public.push_subscriptions s where s.id in
    (select d.subscription_id from public.notification_deliveries d where d.event_id=v_j.event_id)
    order by s.id for update;
  v_now:=clock_timestamp();

  if p_batch_id is null or p_lease_epoch is null or p_worker_id is null then raise exception 'INVALID_PREPARE_ARGUMENT'; end if;
  if p_lease_epoch<>v_j.lease_epoch then raise exception 'OPERATION_SUPERSEDED'; end if;
  if p_batch_id<>v_j.batch_id or p_worker_id<>v_j.lease_owner then raise exception 'OPERATION_ARGUMENT_CONFLICT'; end if;
  if v_j.batch_prepared_at is not null then
    return query select 'already_prepared'::text,v_j.id,v_j.event_id,v_j.batch_id,v_j.batch_count,v_j.snapshot_at,v_j.stage,v_e.status;
    return;
  end if;
  if p_worker_id is null or p_lease_epoch is null then raise exception 'INVALID_LEASE_IDENTITY'; end if;
  if p_lease_epoch<>v_j.lease_epoch then raise exception 'OPERATION_SUPERSEDED'; end if;
  if v_j.stage<>'leased' or v_j.lease_owner<>p_worker_id or v_j.lease_until<=v_now then
    raise exception 'LEASE_NOT_CURRENT';
  end if;

  if row(v_e.event_key,v_e.event_type,v_e.title,v_e.body,v_e.source_entity,v_e.source_entity_id,v_e.deep_link)
    is distinct from row(v_j.event_key,v_j.event_type,v_j.title,v_j.body,v_j.source_entity,v_j.source_entity_id,v_j.deep_link) then
    raise exception 'EVENT_CONFLICT'; end if;
  if exists(select 1 from public.notification_dispatch_attempts a where a.job_id=v_j.id and a.stage in ('prepared','send_started')) then
    raise exception 'RECOVERY_REQUIRED'; end if;
  if exists(select 1 from public.notification_deliveries d where d.event_id=v_j.event_id and d.status='sending') then
    raise exception 'DELIVERY_STATE_CONFLICT'; end if;
  if v_j.snapshot_at is null then
    if exists(select 1 from public.notification_deliveries d where d.event_id=v_j.event_id) or v_e.status<>'queued' then
      raise exception 'LEGACY_EVENT_STATE_CONFLICT'; end if;
    -- New rows are transaction-private; immediate FK key-share locks use subscription UUID order.
    insert into public.notification_deliveries(event_id,subscription_id,subscription_ref)
      select v_j.event_id,s.id,s.id from public.push_subscriptions s
      join auth.users u on u.id=s.user_id and u.email is not null
      join public.class_members m on m.email=lower(u.email)
      left join public.notification_preferences p on p.user_id=s.user_id
      where s.enabled and case v_j.event_type
        when 'schedule' then coalesce(p.schedule_enabled,true)
        when 'memo' then coalesce(p.memos_enabled,true)
        when 'announcement' then coalesce(p.announcements_enabled,true) else false end
      order by s.id;
    update public.notification_dispatch_jobs j set snapshot_at=v_now,updated_at=v_now where j.id=v_j.id returning j.* into v_j;
    update public.notification_events e set status='sending',attempt_count=e.attempt_count+1,last_error=null
      where e.id=v_j.event_id;
  end if;
  -- Eligibility wins over retry exhaustion.
  for v_d in select d.* from public.notification_deliveries d where d.event_id=v_j.event_id and d.status='queued' order by d.id loop
    select s.* into v_s from public.push_subscriptions s where s.id=v_d.subscription_id;
    v_reason:=case
      when v_s.id is null then 'subscription_removed'
      when not v_s.enabled then 'subscription_disabled'
      when not exists(select 1 from auth.users u join public.class_members m on m.email=lower(u.email)
        where u.id=v_s.user_id and u.email is not null) then 'recipient_revoked'
      when not coalesce((select case v_j.event_type
        when 'schedule' then p.schedule_enabled when 'memo' then p.memos_enabled
        when 'announcement' then p.announcements_enabled else false end
        from public.notification_preferences p where p.user_id=v_s.user_id),true) then 'preference_disabled'
      else null end;

    if v_reason is not null then
      update public.notification_deliveries d set status='skipped',next_attempt_at=null,last_error_code=v_reason where d.id=v_d.id;
    elsif v_d.attempt_count>=5 then
      update public.notification_deliveries d set status='failed',next_attempt_at=null,last_error_code='retry_exhausted' where d.id=v_d.id;
    end if;
  end loop;
  -- The candidate repeats recipient checks; only due rows, never an initial-snapshot-only check.
  select coalesce(array_agg(q.id order by q.id),array[]::uuid[]) into v_ids from (
    select d.id from public.notification_deliveries d
    join public.push_subscriptions s on s.id=d.subscription_id and s.enabled
    join auth.users u on u.id=s.user_id and u.email is not null
    join public.class_members m on m.email=lower(u.email)
    left join public.notification_preferences p on p.user_id=s.user_id
    where d.event_id=v_j.event_id and d.status='queued' and d.attempt_count<5
      and (d.next_attempt_at is null or d.next_attempt_at<=v_now)
      and case v_j.event_type when 'schedule' then coalesce(p.schedule_enabled,true)
        when 'memo' then coalesce(p.memos_enabled,true)
        when 'announcement' then coalesce(p.announcements_enabled,true) else false end
    order by d.next_attempt_at nulls first,d.created_at,d.id
    for update of d skip locked limit v_j.batch_limit
  ) q;
  for v_d in select d.* from public.notification_deliveries d where d.id=any(v_ids) order by d.id loop
    select s.* into strict v_s from public.push_subscriptions s where s.id=v_d.subscription_id;
    update public.notification_deliveries d set status='sending',attempt_count=d.attempt_count+1,
      claim_token=gen_random_uuid(),claimed_at=v_now,next_attempt_at=null,last_http_status=null,last_error_code=null
      where d.id=v_d.id returning d.* into v_d;
    insert into public.notification_dispatch_attempts(job_id,delivery_id,subscription_ref,batch_id,
      prepared_epoch,attempt_no,claim_token,credentials_hash,prepared_at)
      values(v_j.id,v_d.id,v_d.subscription_ref,v_j.batch_id,v_j.lease_epoch,v_d.attempt_count,v_d.claim_token,
        pg_catalog.sha256(convert_to(jsonb_build_array(v_s.id,v_s.endpoint,v_s.p256dh,v_s.auth)::text,'UTF8')),v_now);
  end loop;
  update public.notification_dispatch_jobs j set batch_prepared_at=v_now,batch_count=cardinality(v_ids),
    updated_at=v_now where j.id=v_j.id returning j.* into v_j;
  -- blocked is an explicit dispatcher halt, never a successful completion.
  select exists(select 1 from public.notification_deliveries d where d.event_id=v_j.event_id and d.status in ('queued','sending')),
    exists(select 1 from public.notification_deliveries d where d.event_id=v_j.event_id and d.status='failed'),
    exists(select 1 from public.notification_dispatch_attempts a where a.job_id=v_j.id and a.stage='ambiguous')
    into v_active,v_failed,v_ambig;
  update public.notification_events e set
    status=case when v_j.stage='blocked' then 'failed' when v_j.snapshot_at is null then 'queued'
      when v_active then 'sending' when v_ambig or v_failed then 'failed' else 'sent' end,
    last_error=case when v_j.stage='blocked' then 'dispatch_blocked'
      when v_j.snapshot_at is null or v_active then null when v_ambig then 'delivery_ambiguous'
      when v_failed then 'delivery_failed' else null end
    where e.id=v_j.event_id returning e.* into v_e;
  if v_j.stage<>'blocked' and v_j.snapshot_at is not null and not v_active
    and not exists(select 1 from public.notification_dispatch_attempts a where a.job_id=v_j.id and a.stage in ('prepared','send_started')) then
    update public.notification_dispatch_jobs j set stage='completed',next_run_at=null,
      completed_at=coalesce(j.completed_at,v_now),updated_at=v_now where j.id=v_j.id returning j.* into v_j;
  elsif v_j.stage in ('ready','waiting') then
    select min(coalesce(d.next_attempt_at,v_now)) into v_next from public.notification_deliveries d
      where d.event_id=v_j.event_id and d.status='queued';
    select least(v_next,min(a.ambiguity_after)) into v_next from public.notification_dispatch_attempts a
      where a.job_id=v_j.id and a.stage='send_started';
    update public.notification_dispatch_jobs j set stage=case when coalesce(v_next,v_now)<=v_now then 'ready' else 'waiting' end,
      next_run_at=coalesce(v_next,v_now),updated_at=v_now where j.id=v_j.id returning j.* into v_j;
  end if;

  return query select 'prepared'::text,v_j.id,v_j.event_id,v_j.batch_id,v_j.batch_count,v_j.snapshot_at,v_j.stage,v_e.status;
end;
$rpc$;

create function public.begin_notification_dispatch_send(
  p_job_id uuid,
  p_worker_id uuid,
  p_lease_epoch bigint,
  p_attempt_id uuid,
  p_operation_id uuid,
  p_timeout_ms integer default 8000
)
returns table(permit_granted boolean,current_stage text,attempt_id uuid,claim_token uuid,send_deadline_at timestamptz,endpoint text,p256dh text,auth text,event_id uuid,event_type text,title text,body text,deep_link text)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
set statement_timeout = '3s'
set lock_timeout = '750ms'
as $rpc$
#variable_conflict use_column
declare
  v_j public.notification_dispatch_jobs%rowtype;
  v_e public.notification_events%rowtype;
  v_d public.notification_deliveries%rowtype;
  v_a public.notification_dispatch_attempts%rowtype;
  v_s public.push_subscriptions%rowtype;
  v_job_id uuid; v_now timestamptz; v_reason text; v_logical text;
  v_disp text; v_active boolean; v_failed boolean; v_ambig boolean;
  v_next timestamptz; v_ids uuid[]; v_count integer; v_delay integer;
begin
  if num_nonnulls(p_job_id,p_worker_id,p_lease_epoch,p_attempt_id,p_operation_id,p_timeout_ms)<>6
    or p_timeout_ms not between 1 and 8000 then raise exception 'INVALID_BEGIN_ARGUMENT'; end if;
  v_job_id:=p_job_id;
  -- Resolve without locks, then acquire every existing row in one global order.
  select j.* into v_j from public.notification_dispatch_jobs j where j.id=v_job_id for update;
  if not found then raise exception 'JOB_NOT_FOUND'; end if;
  select e.* into v_e from public.notification_events e where e.id=v_j.event_id for update;
  if not found then raise exception 'EVENT_NOT_FOUND'; end if;
  perform d.id from public.notification_deliveries d where d.event_id=v_j.event_id order by d.id for update;
  perform a.id from public.notification_dispatch_attempts a where a.job_id=v_j.id order by a.id for update;
  perform s.id from public.push_subscriptions s where s.id in
    (select d.subscription_id from public.notification_deliveries d where d.event_id=v_j.event_id)
    order by s.id for update;
  v_now:=clock_timestamp();

  select a.* into v_a from public.notification_dispatch_attempts a where a.id=p_attempt_id and a.job_id=v_j.id;
  if not found then raise exception 'ATTEMPT_NOT_FOUND'; end if;
  if p_operation_id<>v_a.begin_operation_id then raise exception 'OPERATION_ARGUMENT_CONFLICT'; end if;
  if v_a.begin_requested_timeout_ms is not null then
    if p_timeout_ms<>v_a.begin_requested_timeout_ms
      or p_worker_id is distinct from coalesce(v_a.send_owner,v_a.release_owner)
      or p_lease_epoch is distinct from coalesce(v_a.send_epoch,v_a.release_epoch) then
      raise exception 'OPERATION_ARGUMENT_CONFLICT'; end if;
    return query select false,v_a.stage,v_a.id,v_a.claim_token,v_a.send_deadline_at,
      null::text,null::text,null::text,null::uuid,null::text,null::text,null::text,null::text;
    return;
  end if;
  if v_a.stage='released' then raise exception 'ATTEMPT_ALREADY_RELEASED'; end if;
  if p_worker_id is null or p_lease_epoch is null then raise exception 'INVALID_LEASE_IDENTITY'; end if;
  if p_lease_epoch<>v_j.lease_epoch then raise exception 'OPERATION_SUPERSEDED'; end if;
  if v_j.stage<>'leased' or v_j.lease_owner<>p_worker_id or v_j.lease_until<=v_now then
    raise exception 'LEASE_NOT_CURRENT';
  end if;

  if v_a.stage<>'prepared' or v_a.prepared_epoch<>p_lease_epoch then raise exception 'ATTEMPT_NOT_CURRENT'; end if;
  select d.* into strict v_d from public.notification_deliveries d where d.id=v_a.delivery_id;
    if v_d.event_id<>v_j.event_id or v_a.job_id<>v_j.id
      or v_a.subscription_ref<>v_d.subscription_ref or v_d.status<>'sending'
      or v_d.claim_token is distinct from v_a.claim_token
      or v_d.attempt_count<>v_a.attempt_no then raise exception 'DELIVERY_STATE_CONFLICT'; end if;

    select s.* into v_s from public.push_subscriptions s where s.id=v_d.subscription_id;
    v_reason:=case
      when v_s.id is null then 'subscription_removed'
      when not v_s.enabled then 'subscription_disabled'
      when not exists(select 1 from auth.users u join public.class_members m on m.email=lower(u.email)
        where u.id=v_s.user_id and u.email is not null) then 'recipient_revoked'
      when not coalesce((select case v_j.event_type
        when 'schedule' then p.schedule_enabled when 'memo' then p.memos_enabled
        when 'announcement' then p.announcements_enabled else false end
        from public.notification_preferences p where p.user_id=v_s.user_id),true) then 'preference_disabled'
      else null end;

  if v_reason is null and v_a.credentials_hash is distinct from
    pg_catalog.sha256(convert_to(jsonb_build_array(v_s.id,v_s.endpoint,v_s.p256dh,v_s.auth)::text,'UTF8')) then
    v_logical:='credentials_changed';
  else v_logical:=v_reason; end if;
  if v_logical is not null then
    -- v_logical is the immutable accepted input; v_reason is DB eligibility truth.
    update public.notification_deliveries d set status=case when v_reason is null then 'queued' else 'skipped' end,
      attempt_count=d.attempt_count-1,claim_token=null,claimed_at=null,next_attempt_at=null,
      sent_at=null,last_http_status=null,last_error_code=coalesce(v_reason,'claim_released_unsent')
      where d.id=v_d.id returning d.* into v_d;
    update public.notification_dispatch_attempts a set stage='released',release_reason=v_logical,begin_requested_timeout_ms=p_timeout_ms,
      released_at=v_now,release_owner=p_worker_id,release_epoch=p_lease_epoch,
      release_attempt_count=v_d.attempt_count,updated_at=v_now where a.id=v_a.id returning a.* into v_a;

  -- blocked is an explicit dispatcher halt, never a successful completion.
  select exists(select 1 from public.notification_deliveries d where d.event_id=v_j.event_id and d.status in ('queued','sending')),
    exists(select 1 from public.notification_deliveries d where d.event_id=v_j.event_id and d.status='failed'),
    exists(select 1 from public.notification_dispatch_attempts a where a.job_id=v_j.id and a.stage='ambiguous')
    into v_active,v_failed,v_ambig;
  update public.notification_events e set
    status=case when v_j.stage='blocked' then 'failed' when v_j.snapshot_at is null then 'queued'
      when v_active then 'sending' when v_ambig or v_failed then 'failed' else 'sent' end,
    last_error=case when v_j.stage='blocked' then 'dispatch_blocked'
      when v_j.snapshot_at is null or v_active then null when v_ambig then 'delivery_ambiguous'
      when v_failed then 'delivery_failed' else null end
    where e.id=v_j.event_id returning e.* into v_e;
  if v_j.stage<>'blocked' and v_j.snapshot_at is not null and not v_active
    and not exists(select 1 from public.notification_dispatch_attempts a where a.job_id=v_j.id and a.stage in ('prepared','send_started')) then
    update public.notification_dispatch_jobs j set stage='completed',next_run_at=null,
      completed_at=coalesce(j.completed_at,v_now),updated_at=v_now where j.id=v_j.id returning j.* into v_j;
  elsif v_j.stage in ('ready','waiting') then
    select min(coalesce(d.next_attempt_at,v_now)) into v_next from public.notification_deliveries d
      where d.event_id=v_j.event_id and d.status='queued';
    select least(v_next,min(a.ambiguity_after)) into v_next from public.notification_dispatch_attempts a
      where a.job_id=v_j.id and a.stage='send_started';
    update public.notification_dispatch_jobs j set stage=case when coalesce(v_next,v_now)<=v_now then 'ready' else 'waiting' end,
      next_run_at=coalesce(v_next,v_now),updated_at=v_now where j.id=v_j.id returning j.* into v_j;
  end if;

    return query select false,v_a.stage,v_a.id,v_a.claim_token,null::timestamptz,
      null::text,null::text,null::text,null::uuid,null::text,null::text,null::text,null::text;
    return;
  end if;
  if row(v_e.event_key,v_e.event_type,v_e.title,v_e.body,v_e.source_entity,v_e.source_entity_id,v_e.deep_link)
    is distinct from row(v_j.event_key,v_j.event_type,v_j.title,v_j.body,v_j.source_entity,v_j.source_entity_id,v_j.deep_link) then
    raise exception 'EVENT_CONFLICT'; end if;
  if (select count(*) from public.notification_dispatch_attempts a where a.job_id=v_j.id and a.stage='send_started')>=5 then
    raise exception 'SEND_CAPACITY_REACHED'; end if;
  v_now:=clock_timestamp();
  if v_now+p_timeout_ms*interval '1 millisecond'>v_j.lease_until-interval '3 seconds' then
    raise exception 'INSUFFICIENT_LEASE_BUDGET'; end if;
  update public.notification_dispatch_attempts a set stage='send_started',
    begin_requested_timeout_ms=p_timeout_ms,send_owner=p_worker_id,send_epoch=p_lease_epoch,
    send_timeout_ms=p_timeout_ms,send_started_at=v_now,send_deadline_at=v_now+p_timeout_ms*interval '1 millisecond',
    ambiguity_after=v_now+p_timeout_ms*interval '1 millisecond'+interval '5 seconds',updated_at=v_now
    where a.id=v_a.id returning a.* into v_a;
  -- Sole permit issuance site. A committed replay never reaches this return.
  return query select true,v_a.stage,v_a.id,v_a.claim_token,v_a.send_deadline_at,
    v_s.endpoint,v_s.p256dh,v_s.auth,v_j.event_id,v_j.event_type,v_j.title,v_j.body,v_j.deep_link;
end;
$rpc$;

create function public.release_notification_dispatch_attempt(
  p_job_id uuid,
  p_worker_id uuid,
  p_lease_epoch bigint,
  p_attempt_id uuid,
  p_operation_id uuid,
  p_reason text
)
returns table(disposition text,attempt_id uuid,attempt_stage text,released_attempt_count integer,delivery_status text,delivery_attempt_count integer,next_attempt_at timestamptz,event_status text,job_stage text)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
set statement_timeout = '3s'
set lock_timeout = '750ms'
as $rpc$
#variable_conflict use_column
declare
  v_j public.notification_dispatch_jobs%rowtype;
  v_e public.notification_events%rowtype;
  v_d public.notification_deliveries%rowtype;
  v_a public.notification_dispatch_attempts%rowtype;
  v_s public.push_subscriptions%rowtype;
  v_job_id uuid; v_now timestamptz; v_reason text; v_logical text;
  v_disp text; v_active boolean; v_failed boolean; v_ambig boolean;
  v_next timestamptz; v_ids uuid[]; v_count integer; v_delay integer;
begin
  if num_nonnulls(p_job_id,p_worker_id,p_lease_epoch,p_attempt_id,p_operation_id,p_reason)<>6
    or p_reason not in ('worker_budget','stale_prepared','credentials_changed','subscription_removed',
      'subscription_disabled','recipient_revoked','preference_disabled') then raise exception 'INVALID_RELEASE_ARGUMENT'; end if;
  v_job_id:=p_job_id;
  -- Resolve without locks, then acquire every existing row in one global order.
  select j.* into v_j from public.notification_dispatch_jobs j where j.id=v_job_id for update;
  if not found then raise exception 'JOB_NOT_FOUND'; end if;
  select e.* into v_e from public.notification_events e where e.id=v_j.event_id for update;
  if not found then raise exception 'EVENT_NOT_FOUND'; end if;
  perform d.id from public.notification_deliveries d where d.event_id=v_j.event_id order by d.id for update;
  perform a.id from public.notification_dispatch_attempts a where a.job_id=v_j.id order by a.id for update;
  perform s.id from public.push_subscriptions s where s.id in
    (select d.subscription_id from public.notification_deliveries d where d.event_id=v_j.event_id)
    order by s.id for update;
  v_now:=clock_timestamp();

  select a.* into v_a from public.notification_dispatch_attempts a where a.id=p_attempt_id and a.job_id=v_j.id;
  if not found then raise exception 'ATTEMPT_NOT_FOUND'; end if;
  if p_operation_id<>v_a.release_operation_id then raise exception 'OPERATION_ARGUMENT_CONFLICT'; end if;
  select d.* into strict v_d from public.notification_deliveries d where d.id=v_a.delivery_id;
  if v_a.stage='released' then
    if row(v_a.release_reason,v_a.release_owner,v_a.release_epoch) is distinct from row(p_reason,p_worker_id,p_lease_epoch) then
      raise exception 'OPERATION_ARGUMENT_CONFLICT'; end if;
    v_disp:='already_released';
  else
  if p_worker_id is null or p_lease_epoch is null then raise exception 'INVALID_LEASE_IDENTITY'; end if;
  if p_lease_epoch<>v_j.lease_epoch then raise exception 'OPERATION_SUPERSEDED'; end if;
  if v_j.stage<>'leased' or v_j.lease_owner<>p_worker_id or v_j.lease_until<=v_now then
    raise exception 'LEASE_NOT_CURRENT';
  end if;

    if v_a.stage<>'prepared' or v_a.prepared_epoch>p_lease_epoch then raise exception 'ATTEMPT_NOT_RELEASABLE'; end if;
    if v_d.event_id<>v_j.event_id or v_a.job_id<>v_j.id
      or v_a.subscription_ref<>v_d.subscription_ref or v_d.status<>'sending'
      or v_d.claim_token is distinct from v_a.claim_token
      or v_d.attempt_count<>v_a.attempt_no then raise exception 'DELIVERY_STATE_CONFLICT'; end if;

    select s.* into v_s from public.push_subscriptions s where s.id=v_d.subscription_id;
    v_reason:=case
      when v_s.id is null then 'subscription_removed'
      when not v_s.enabled then 'subscription_disabled'
      when not exists(select 1 from auth.users u join public.class_members m on m.email=lower(u.email)
        where u.id=v_s.user_id and u.email is not null) then 'recipient_revoked'
      when not coalesce((select case v_j.event_type
        when 'schedule' then p.schedule_enabled when 'memo' then p.memos_enabled
        when 'announcement' then p.announcements_enabled else false end
        from public.notification_preferences p where p.user_id=v_s.user_id),true) then 'preference_disabled'
      else null end;

    v_logical:=p_reason;
    -- v_logical is the immutable accepted input; v_reason is DB eligibility truth.
    update public.notification_deliveries d set status=case when v_reason is null then 'queued' else 'skipped' end,
      attempt_count=d.attempt_count-1,claim_token=null,claimed_at=null,next_attempt_at=null,
      sent_at=null,last_http_status=null,last_error_code=coalesce(v_reason,'claim_released_unsent')
      where d.id=v_d.id returning d.* into v_d;
    update public.notification_dispatch_attempts a set stage='released',release_reason=v_logical,
      released_at=v_now,release_owner=p_worker_id,release_epoch=p_lease_epoch,
      release_attempt_count=v_d.attempt_count,updated_at=v_now where a.id=v_a.id returning a.* into v_a;

  -- blocked is an explicit dispatcher halt, never a successful completion.
  select exists(select 1 from public.notification_deliveries d where d.event_id=v_j.event_id and d.status in ('queued','sending')),
    exists(select 1 from public.notification_deliveries d where d.event_id=v_j.event_id and d.status='failed'),
    exists(select 1 from public.notification_dispatch_attempts a where a.job_id=v_j.id and a.stage='ambiguous')
    into v_active,v_failed,v_ambig;
  update public.notification_events e set
    status=case when v_j.stage='blocked' then 'failed' when v_j.snapshot_at is null then 'queued'
      when v_active then 'sending' when v_ambig or v_failed then 'failed' else 'sent' end,
    last_error=case when v_j.stage='blocked' then 'dispatch_blocked'
      when v_j.snapshot_at is null or v_active then null when v_ambig then 'delivery_ambiguous'
      when v_failed then 'delivery_failed' else null end
    where e.id=v_j.event_id returning e.* into v_e;
  if v_j.stage<>'blocked' and v_j.snapshot_at is not null and not v_active
    and not exists(select 1 from public.notification_dispatch_attempts a where a.job_id=v_j.id and a.stage in ('prepared','send_started')) then
    update public.notification_dispatch_jobs j set stage='completed',next_run_at=null,
      completed_at=coalesce(j.completed_at,v_now),updated_at=v_now where j.id=v_j.id returning j.* into v_j;
  elsif v_j.stage in ('ready','waiting') then
    select min(coalesce(d.next_attempt_at,v_now)) into v_next from public.notification_deliveries d
      where d.event_id=v_j.event_id and d.status='queued';
    select least(v_next,min(a.ambiguity_after)) into v_next from public.notification_dispatch_attempts a
      where a.job_id=v_j.id and a.stage='send_started';
    update public.notification_dispatch_jobs j set stage=case when coalesce(v_next,v_now)<=v_now then 'ready' else 'waiting' end,
      next_run_at=coalesce(v_next,v_now),updated_at=v_now where j.id=v_j.id returning j.* into v_j;
  end if;

    v_disp:='released';
  end if;
  return query select v_disp,v_a.id,v_a.stage,v_a.release_attempt_count,v_d.status,v_d.attempt_count,v_d.next_attempt_at,v_e.status,v_j.stage;
end;
$rpc$;

create function public.record_notification_dispatch_result(
  p_attempt_id uuid,
  p_worker_id uuid,
  p_send_epoch bigint,
  p_claim_token uuid,
  p_operation_id uuid,
  p_outcome text,
  p_http_status integer default null,
  p_retry_after_seconds integer default null,
  p_error_code text default null
)
returns table(disposition text,attempt_id uuid,attempt_stage text,provider_outcome text,delivery_status text,delivery_attempt_count integer,next_attempt_at timestamptz,event_status text,job_stage text)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
set statement_timeout = '3s'
set lock_timeout = '750ms'
as $rpc$
#variable_conflict use_column
declare
  v_j public.notification_dispatch_jobs%rowtype;
  v_e public.notification_events%rowtype;
  v_d public.notification_deliveries%rowtype;
  v_a public.notification_dispatch_attempts%rowtype;
  v_s public.push_subscriptions%rowtype;
  v_job_id uuid; v_now timestamptz; v_reason text; v_logical text;
  v_disp text; v_active boolean; v_failed boolean; v_ambig boolean;
  v_next timestamptz; v_ids uuid[]; v_count integer; v_delay integer;
begin
  if num_nonnulls(p_attempt_id,p_worker_id,p_send_epoch,p_claim_token,p_operation_id,p_outcome)<>6
    or p_outcome not in ('sent','expired','retryable','permanent_failure','ambiguous') then raise exception 'INVALID_RECORD_ARGUMENT'; end if;
  if p_outcome='ambiguous' then
    if p_http_status is not null or p_retry_after_seconds is not null or p_error_code is null
      or p_error_code not in ('provider_timeout','provider_reset','provider_unknown_response','send_result_missing') then
      raise exception 'INVALID_PROVIDER_RESULT'; end if;
  else
    if p_http_status is null or p_error_code is not null or not (
      (p_outcome='sent' and p_http_status between 200 and 299)
      or (p_outcome='expired' and p_http_status in (404,410))
      or (p_outcome='retryable' and (p_http_status=429 or p_http_status between 500 and 599))
      or (p_outcome='permanent_failure' and p_http_status between 400 and 499 and p_http_status not in (404,410,429)))
      or (p_retry_after_seconds is not null and
        (p_outcome<>'retryable' or p_http_status<>429 or p_retry_after_seconds<=0)) then
      raise exception 'INVALID_PROVIDER_RESULT'; end if;
  end if;
  select a.job_id into v_job_id from public.notification_dispatch_attempts a where a.id=p_attempt_id;
  -- Resolve without locks, then acquire every existing row in one global order.
  select j.* into v_j from public.notification_dispatch_jobs j where j.id=v_job_id for update;
  if not found then raise exception 'JOB_NOT_FOUND'; end if;
  select e.* into v_e from public.notification_events e where e.id=v_j.event_id for update;
  if not found then raise exception 'EVENT_NOT_FOUND'; end if;
  perform d.id from public.notification_deliveries d where d.event_id=v_j.event_id order by d.id for update;
  perform a.id from public.notification_dispatch_attempts a where a.job_id=v_j.id order by a.id for update;
  perform s.id from public.push_subscriptions s where s.id in
    (select d.subscription_id from public.notification_deliveries d where d.event_id=v_j.event_id)
    order by s.id for update;
  v_now:=clock_timestamp();

  select a.* into strict v_a from public.notification_dispatch_attempts a where a.id=p_attempt_id and a.job_id=v_j.id;
  select d.* into strict v_d from public.notification_deliveries d where d.id=v_a.delivery_id;
  -- Completion authority is the immutable ORIGINAL send identity, not current job epoch.
  if row(v_a.send_owner,v_a.send_epoch,v_a.claim_token) is distinct from row(p_worker_id,p_send_epoch,p_claim_token)
    or p_operation_id is distinct from (case when p_outcome='ambiguous' then v_a.ambiguity_operation_id else v_a.record_operation_id end) then
    raise exception 'OPERATION_ARGUMENT_CONFLICT'; end if;
  if p_outcome='ambiguous' and v_a.ambiguity_at is not null then
    if p_error_code<>v_a.ambiguity_reason then raise exception 'OPERATION_ARGUMENT_CONFLICT'; end if;
    v_disp:=case when v_a.result_recorded_at is null then 'already_ambiguous' else 'already_resolved' end;
  elsif p_outcome='ambiguous' and v_a.result_recorded_at is not null then
    v_disp:='already_resolved';
  elsif p_outcome<>'ambiguous' and v_a.result_recorded_at is not null then
    if row(v_a.provider_outcome,v_a.provider_http_status::integer,v_a.provider_retry_after_seconds)
      is distinct from row(p_outcome,p_http_status,p_retry_after_seconds) then raise exception 'OPERATION_ARGUMENT_CONFLICT'; end if;
    v_disp:='already_recorded';
  else
    if v_a.stage='send_started' then
    if v_d.event_id<>v_j.event_id or v_a.job_id<>v_j.id
      or v_a.subscription_ref<>v_d.subscription_ref or v_d.status<>'sending'
      or v_d.claim_token is distinct from v_a.claim_token
      or v_d.attempt_count<>v_a.attempt_no then raise exception 'DELIVERY_STATE_CONFLICT'; end if;

    elsif v_a.stage='ambiguous' and p_outcome<>'ambiguous' then
      if v_d.event_id<>v_j.event_id or v_d.status<>'failed' or v_d.last_error_code<>'delivery_ambiguous'
        or v_d.attempt_count<>v_a.attempt_no or v_d.claim_token is not null
        or exists(select 1 from public.notification_dispatch_attempts a
          where a.delivery_id=v_d.id and a.stage in ('prepared','send_started')) then
        raise exception 'DELIVERY_STATE_CONFLICT'; end if;
    else raise exception 'ATTEMPT_NOT_RECORDABLE'; end if;
    if p_outcome='ambiguous' then
      update public.notification_dispatch_attempts a set stage='ambiguous',ambiguity_at=v_now,
        ambiguity_reason=p_error_code,updated_at=v_now where a.id=v_a.id returning a.* into v_a;
      update public.notification_deliveries d set status='failed',claim_token=null,next_attempt_at=null,
        last_http_status=null,last_error_code='delivery_ambiguous' where d.id=v_d.id returning d.* into v_d;
      v_disp:='ambiguity_recorded';
    else
      v_logical:=case when v_a.ambiguity_at is not null then 'late_result_recorded' else 'recorded' end;
      v_reason:=case p_outcome when 'expired' then 'subscription_expired'
        when 'permanent_failure' then 'push_client_error'
        when 'retryable' then case when v_a.ambiguity_at is not null then 'late_retryable_after_ambiguity'
          when v_d.attempt_count>=5 then 'retry_exhausted'
          when p_http_status=429 then 'push_rate_limited' else 'push_server_error' end else null end;
      v_next:=null;
      if p_outcome='retryable' and v_a.ambiguity_at is null and v_d.attempt_count<5 then
        v_delay:=case v_d.attempt_count when 1 then 30 when 2 then 60 when 3 then 120 when 4 then 240 end;
        if p_http_status=429 and p_retry_after_seconds is not null then
          v_delay:=greatest(30,least(86400,p_retry_after_seconds)); end if;
        v_next:=v_now+v_delay*interval '1 second';
      end if;
      update public.notification_deliveries d set
        status=case when p_outcome='sent' then 'sent' when p_outcome='expired' then 'expired'
          when v_next is not null then 'queued' else 'failed' end,
        claim_token=null,next_attempt_at=v_next,sent_at=case when p_outcome='sent' then v_now else null end,
        last_http_status=p_http_status::smallint,last_error_code=v_reason
        where d.id=v_d.id returning d.* into v_d;
      -- Store RAW accepted Retry-After, not the clamped scheduling delay.
      -- Never erase ambiguity evidence during late refinement.
      update public.notification_dispatch_attempts a set stage='result_recorded',provider_outcome=p_outcome,
        provider_http_status=p_http_status::smallint,provider_retry_after_seconds=p_retry_after_seconds,
        result_recorded_at=v_now,updated_at=v_now where a.id=v_a.id returning a.* into v_a;
      select s.* into v_s from public.push_subscriptions s where s.id=v_d.subscription_id;
      if v_s.id is not null and v_a.credentials_hash=
        pg_catalog.sha256(convert_to(jsonb_build_array(v_s.id,v_s.endpoint,v_s.p256dh,v_s.auth)::text,'UTF8')) then
        if p_outcome='sent' then
          update public.push_subscriptions s set last_success_at=v_now,failure_count=0 where s.id=v_s.id;
        else
          update public.push_subscriptions s set enabled=case when p_outcome='expired' then false else s.enabled end,
            last_failure_at=v_now,failure_count=least(s.failure_count::bigint+1,2147483647)::integer where s.id=v_s.id;
        end if;
      end if;
      v_disp:=v_logical;
    end if;
  -- blocked is an explicit dispatcher halt, never a successful completion.
  select exists(select 1 from public.notification_deliveries d where d.event_id=v_j.event_id and d.status in ('queued','sending')),
    exists(select 1 from public.notification_deliveries d where d.event_id=v_j.event_id and d.status='failed'),
    exists(select 1 from public.notification_dispatch_attempts a where a.job_id=v_j.id and a.stage='ambiguous')
    into v_active,v_failed,v_ambig;
  update public.notification_events e set
    status=case when v_j.stage='blocked' then 'failed' when v_j.snapshot_at is null then 'queued'
      when v_active then 'sending' when v_ambig or v_failed then 'failed' else 'sent' end,
    last_error=case when v_j.stage='blocked' then 'dispatch_blocked'
      when v_j.snapshot_at is null or v_active then null when v_ambig then 'delivery_ambiguous'
      when v_failed then 'delivery_failed' else null end
    where e.id=v_j.event_id returning e.* into v_e;
  if v_j.stage<>'blocked' and v_j.snapshot_at is not null and not v_active
    and not exists(select 1 from public.notification_dispatch_attempts a where a.job_id=v_j.id and a.stage in ('prepared','send_started')) then
    update public.notification_dispatch_jobs j set stage='completed',next_run_at=null,
      completed_at=coalesce(j.completed_at,v_now),updated_at=v_now where j.id=v_j.id returning j.* into v_j;
  elsif v_j.stage in ('ready','waiting') then
    select min(coalesce(d.next_attempt_at,v_now)) into v_next from public.notification_deliveries d
      where d.event_id=v_j.event_id and d.status='queued';
    select least(v_next,min(a.ambiguity_after)) into v_next from public.notification_dispatch_attempts a
      where a.job_id=v_j.id and a.stage='send_started';
    update public.notification_dispatch_jobs j set stage=case when coalesce(v_next,v_now)<=v_now then 'ready' else 'waiting' end,
      next_run_at=coalesce(v_next,v_now),updated_at=v_now where j.id=v_j.id returning j.* into v_j;
  end if;

  end if;
  -- Replay reads current state only: no repeated delivery, subscription or event writes.
  return query select v_disp,v_a.id,v_a.stage,v_a.provider_outcome,v_d.status,v_d.attempt_count,v_d.next_attempt_at,v_e.status,v_j.stage;
end;
$rpc$;

create function public.settle_notification_dispatch_job(
  p_job_id uuid,
  p_worker_id uuid,
  p_lease_epoch bigint,
  p_operation_id uuid,
  p_reason text default 'yield'
)
returns table(disposition text,job_id uuid,job_stage text,event_status text,next_run_at timestamptz,queued_count bigint,sending_count bigint,sent_count bigint,expired_count bigint,failed_count bigint,skipped_count bigint,ambiguous_count bigint)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
set statement_timeout = '5s'
set lock_timeout = '750ms'
as $rpc$
#variable_conflict use_column
declare
  v_j public.notification_dispatch_jobs%rowtype;
  v_e public.notification_events%rowtype;
  v_d public.notification_deliveries%rowtype;
  v_a public.notification_dispatch_attempts%rowtype;
  v_s public.push_subscriptions%rowtype;
  v_job_id uuid; v_now timestamptz; v_reason text; v_logical text;
  v_disp text; v_active boolean; v_failed boolean; v_ambig boolean;
  v_next timestamptz; v_ids uuid[]; v_count integer; v_delay integer;
begin
  if num_nonnulls(p_job_id,p_worker_id,p_lease_epoch,p_operation_id,p_reason)<>5
    or p_reason not in ('yield','transient_backend','configuration_blocked') then raise exception 'INVALID_SETTLE_ARGUMENT'; end if;
  v_job_id:=p_job_id;
  -- Resolve without locks, then acquire every existing row in one global order.
  select j.* into v_j from public.notification_dispatch_jobs j where j.id=v_job_id for update;
  if not found then raise exception 'JOB_NOT_FOUND'; end if;
  select e.* into v_e from public.notification_events e where e.id=v_j.event_id for update;
  if not found then raise exception 'EVENT_NOT_FOUND'; end if;
  perform d.id from public.notification_deliveries d where d.event_id=v_j.event_id order by d.id for update;
  perform a.id from public.notification_dispatch_attempts a where a.job_id=v_j.id order by a.id for update;
  perform s.id from public.push_subscriptions s where s.id in
    (select d.subscription_id from public.notification_deliveries d where d.event_id=v_j.event_id)
    order by s.id for update;
  v_now:=clock_timestamp();

  if p_lease_epoch<>v_j.lease_epoch then raise exception 'OPERATION_SUPERSEDED'; end if;
  if row(p_operation_id,p_worker_id) is distinct from row(v_j.settle_operation_id,v_j.lease_owner) then
    raise exception 'OPERATION_ARGUMENT_CONFLICT'; end if;
  if v_j.settled_at is not null then
    if p_reason<>v_j.settle_reason then raise exception 'OPERATION_ARGUMENT_CONFLICT'; end if;
    v_disp:='already_settled';
  elsif v_j.stage in ('completed','blocked') then v_disp:='already_terminal';
  else
  if p_worker_id is null or p_lease_epoch is null then raise exception 'INVALID_LEASE_IDENTITY'; end if;
  if p_lease_epoch<>v_j.lease_epoch then raise exception 'OPERATION_SUPERSEDED'; end if;
  if v_j.stage<>'leased' or v_j.lease_owner<>p_worker_id or v_j.lease_until<=v_now then
    raise exception 'LEASE_NOT_CURRENT';
  end if;

    for v_a in select a.* from public.notification_dispatch_attempts a
      where a.job_id=v_j.id and a.stage in ('prepared','send_started') order by a.id loop
      select d.* into strict v_d from public.notification_deliveries d where d.id=v_a.delivery_id;
    if v_d.event_id<>v_j.event_id or v_a.job_id<>v_j.id
      or v_a.subscription_ref<>v_d.subscription_ref or v_d.status<>'sending'
      or v_d.claim_token is distinct from v_a.claim_token
      or v_d.attempt_count<>v_a.attempt_no then raise exception 'DELIVERY_STATE_CONFLICT'; end if;

      if v_a.prepared_epoch>p_lease_epoch then raise exception 'ATTEMPT_EPOCH_CONFLICT'; end if;
      if v_a.stage='prepared' then
    select s.* into v_s from public.push_subscriptions s where s.id=v_d.subscription_id;
    v_reason:=case
      when v_s.id is null then 'subscription_removed'
      when not v_s.enabled then 'subscription_disabled'
      when not exists(select 1 from auth.users u join public.class_members m on m.email=lower(u.email)
        where u.id=v_s.user_id and u.email is not null) then 'recipient_revoked'
      when not coalesce((select case v_j.event_type
        when 'schedule' then p.schedule_enabled when 'memo' then p.memos_enabled
        when 'announcement' then p.announcements_enabled else false end
        from public.notification_preferences p where p.user_id=v_s.user_id),true) then 'preference_disabled'
      else null end;

        v_logical:=case when v_a.prepared_epoch<p_lease_epoch then 'stale_prepared' else 'worker_budget' end;
    -- v_logical is the immutable accepted input; v_reason is DB eligibility truth.
    update public.notification_deliveries d set status=case when v_reason is null then 'queued' else 'skipped' end,
      attempt_count=d.attempt_count-1,claim_token=null,claimed_at=null,next_attempt_at=null,
      sent_at=null,last_http_status=null,last_error_code=coalesce(v_reason,'claim_released_unsent')
      where d.id=v_d.id returning d.* into v_d;
    update public.notification_dispatch_attempts a set stage='released',release_reason=v_logical,
      released_at=v_now,release_owner=p_worker_id,release_epoch=p_lease_epoch,
      release_attempt_count=v_d.attempt_count,updated_at=v_now where a.id=v_a.id returning a.* into v_a;

      elsif v_now>=v_a.ambiguity_after then
        update public.notification_dispatch_attempts a set stage='ambiguous',ambiguity_at=v_now,
          ambiguity_reason='send_result_missing',updated_at=v_now where a.id=v_a.id;
        update public.notification_deliveries d set status='failed',claim_token=null,next_attempt_at=null,
          last_http_status=null,last_error_code='delivery_ambiguous' where d.id=v_d.id;
      end if;
    end loop;
    select min(coalesce(d.next_attempt_at,v_now)) into v_next from public.notification_deliveries d
      where d.event_id=v_j.event_id and d.status='queued';
    select least(v_next,min(a.ambiguity_after)) into v_next from public.notification_dispatch_attempts a
      where a.job_id=v_j.id and a.stage='send_started';
    if p_reason='transient_backend' then v_next:=greatest(coalesce(v_next,v_now),v_now+interval '30 seconds'); end if;
    update public.notification_dispatch_jobs j set
      stage=case when p_reason='configuration_blocked' then 'blocked'
        when coalesce(v_next,v_now)<=v_now then 'ready' else 'waiting' end,
      next_run_at=case when p_reason='configuration_blocked' then null else coalesce(v_next,v_now) end,
      last_error_code=case when p_reason='configuration_blocked' then 'dispatch_configuration_blocked' else null end,
      settled_at=v_now,settle_reason=p_reason,updated_at=v_now where j.id=v_j.id returning j.* into v_j;
  -- blocked is an explicit dispatcher halt, never a successful completion.
  select exists(select 1 from public.notification_deliveries d where d.event_id=v_j.event_id and d.status in ('queued','sending')),
    exists(select 1 from public.notification_deliveries d where d.event_id=v_j.event_id and d.status='failed'),
    exists(select 1 from public.notification_dispatch_attempts a where a.job_id=v_j.id and a.stage='ambiguous')
    into v_active,v_failed,v_ambig;
  update public.notification_events e set
    status=case when v_j.stage='blocked' then 'failed' when v_j.snapshot_at is null then 'queued'
      when v_active then 'sending' when v_ambig or v_failed then 'failed' else 'sent' end,
    last_error=case when v_j.stage='blocked' then 'dispatch_blocked'
      when v_j.snapshot_at is null or v_active then null when v_ambig then 'delivery_ambiguous'
      when v_failed then 'delivery_failed' else null end
    where e.id=v_j.event_id returning e.* into v_e;
  if v_j.stage<>'blocked' and v_j.snapshot_at is not null and not v_active
    and not exists(select 1 from public.notification_dispatch_attempts a where a.job_id=v_j.id and a.stage in ('prepared','send_started')) then
    update public.notification_dispatch_jobs j set stage='completed',next_run_at=null,
      completed_at=coalesce(j.completed_at,v_now),updated_at=v_now where j.id=v_j.id returning j.* into v_j;
  elsif v_j.stage in ('ready','waiting') then
    select min(coalesce(d.next_attempt_at,v_now)) into v_next from public.notification_deliveries d
      where d.event_id=v_j.event_id and d.status='queued';
    select least(v_next,min(a.ambiguity_after)) into v_next from public.notification_dispatch_attempts a
      where a.job_id=v_j.id and a.stage='send_started';
    update public.notification_dispatch_jobs j set stage=case when coalesce(v_next,v_now)<=v_now then 'ready' else 'waiting' end,
      next_run_at=coalesce(v_next,v_now),updated_at=v_now where j.id=v_j.id returning j.* into v_j;
  end if;

    -- Preserve an intentional transient-backend delay after aggregation.
    if p_reason='transient_backend' and v_j.stage in ('ready','waiting') then
      update public.notification_dispatch_jobs j set stage='waiting',next_run_at=greatest(j.next_run_at,v_now+interval '30 seconds')
        where j.id=v_j.id returning j.* into v_j;
    end if;
    v_disp:='settled';
  end if;
  return query select v_disp,v_j.id,v_j.stage,v_e.status,v_j.next_run_at,
    count(*) filter(where d.status='queued'),count(*) filter(where d.status='sending'),
    count(*) filter(where d.status='sent'),count(*) filter(where d.status='expired'),
    count(*) filter(where d.status='failed'),count(*) filter(where d.status='skipped'),
    (select count(*) from public.notification_dispatch_attempts a where a.job_id=v_j.id and a.stage='ambiguous')
    from public.notification_deliveries d where d.event_id=v_j.event_id;
end;
$rpc$;

create function public.get_notification_dispatch_state(
  p_job_id uuid default null,
  p_batch_id uuid default null,
  p_attempt_id uuid default null,
  p_after_id uuid default null,
  p_limit integer default 25
)
returns table(row_kind text,job_id uuid,event_id uuid,job_stage text,event_status text,lease_epoch bigint,lease_owner uuid,lease_until timestamptz,next_run_at timestamptz,snapshot_at timestamptz,batch_id uuid,batch_prepared boolean,batch_count integer,settle_operation_id uuid,attempt_id uuid,delivery_id uuid,attempt_stage text,prepared_epoch bigint,attempt_no integer,claim_token uuid,begin_operation_id uuid,record_operation_id uuid,ambiguity_operation_id uuid,release_operation_id uuid,send_owner uuid,send_epoch bigint,send_deadline_at timestamptz,ambiguity_after timestamptz,delivery_status text,delivery_attempt_count integer,delivery_next_attempt_at timestamptz,provider_outcome text,result_recorded_at timestamptz,ambiguity_at timestamptz,released_at timestamptz)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
set statement_timeout = '3s'
set lock_timeout = '750ms'
as $rpc$
#variable_conflict use_column
declare
  v_j public.notification_dispatch_jobs%rowtype;
  v_e public.notification_events%rowtype;
  v_d public.notification_deliveries%rowtype;
  v_a public.notification_dispatch_attempts%rowtype;
  v_s public.push_subscriptions%rowtype;
  v_job_id uuid; v_now timestamptz; v_reason text; v_logical text;
  v_disp text; v_active boolean; v_failed boolean; v_ambig boolean;
  v_next timestamptz; v_ids uuid[]; v_count integer; v_delay integer;
begin
  if p_limit is null or p_limit not between 1 and 25 or
    (p_job_id is null and (p_batch_id is not null or p_attempt_id is not null))
    or (p_attempt_id is not null and p_after_id is not null) then raise exception 'INVALID_STATE_FILTER'; end if;
  -- One SQL statement / one MVCC snapshot; reads confer no send authority.
  return query
  with jobs as materialized (
    select j.*,e.status as event_status from public.notification_dispatch_jobs j
      join public.notification_events e on e.id=j.event_id
      where (p_job_id is not null and j.id=p_job_id)
        or (p_job_id is null and (p_after_id is null or j.id>p_after_id)
          and ((j.stage in ('ready','waiting') and j.next_run_at<=statement_timestamp())
            or (j.stage='leased' and j.lease_until<=statement_timestamp())))
      order by j.id limit p_limit
  ), attempts as materialized (
    select a.*,d.status as delivery_status,d.attempt_count as delivery_attempt_count,d.next_attempt_at as delivery_next_attempt_at
      from public.notification_dispatch_attempts a join public.notification_deliveries d on d.id=a.delivery_id
      where p_job_id is not null and a.job_id=p_job_id
        and (p_batch_id is null or a.batch_id=p_batch_id)
        and (p_attempt_id is null or a.id=p_attempt_id)
        and (p_after_id is null or a.id>p_after_id)
      order by a.id limit p_limit
  )
  select 'job'::text,j.id,j.event_id,j.stage,j.event_status,j.lease_epoch,j.lease_owner,j.lease_until,j.next_run_at,
    j.snapshot_at,j.batch_id,j.batch_prepared_at is not null,j.batch_count,j.settle_operation_id,null::uuid,null::uuid,null::text,null::bigint,null::integer,null::uuid,null::uuid,null::uuid,null::uuid,null::uuid,null::uuid,null::bigint,null::timestamptz,null::timestamptz,null::text,null::integer,null::timestamptz,null::text,null::timestamptz,null::timestamptz,null::timestamptz
    from jobs j
  union all
  select 'attempt'::text,j.id,j.event_id,j.stage,j.event_status,j.lease_epoch,j.lease_owner,j.lease_until,j.next_run_at,
    j.snapshot_at,a.batch_id,j.batch_prepared_at is not null,j.batch_count,j.settle_operation_id,
    a.id,a.delivery_id,a.stage,a.prepared_epoch,a.attempt_no,a.claim_token,a.begin_operation_id,a.record_operation_id,
    a.ambiguity_operation_id,a.release_operation_id,a.send_owner,a.send_epoch,a.send_deadline_at,a.ambiguity_after,
    a.delivery_status,a.delivery_attempt_count,a.delivery_next_attempt_at,a.provider_outcome,a.result_recorded_at,a.ambiguity_at,a.released_at
    from jobs j join attempts a on a.job_id=j.id;
end;
$rpc$;

alter function public.enqueue_notification_dispatch(text,text,text,text,text,text,text,uuid) owner to postgres;
revoke all on function public.enqueue_notification_dispatch(text,text,text,text,text,text,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.enqueue_notification_dispatch(text,text,text,text,text,text,text,uuid) to service_role;

alter function public.acquire_notification_dispatch_job(uuid,uuid,uuid,bigint,integer) owner to postgres;
revoke all on function public.acquire_notification_dispatch_job(uuid,uuid,uuid,bigint,integer) from public,anon,authenticated,service_role;
grant execute on function public.acquire_notification_dispatch_job(uuid,uuid,uuid,bigint,integer) to service_role;

alter function public.prepare_notification_dispatch_batch(uuid,uuid,bigint,uuid) owner to postgres;
revoke all on function public.prepare_notification_dispatch_batch(uuid,uuid,bigint,uuid) from public,anon,authenticated,service_role;
grant execute on function public.prepare_notification_dispatch_batch(uuid,uuid,bigint,uuid) to service_role;

alter function public.begin_notification_dispatch_send(uuid,uuid,bigint,uuid,uuid,integer) owner to postgres;
revoke all on function public.begin_notification_dispatch_send(uuid,uuid,bigint,uuid,uuid,integer) from public,anon,authenticated,service_role;
grant execute on function public.begin_notification_dispatch_send(uuid,uuid,bigint,uuid,uuid,integer) to service_role;

alter function public.release_notification_dispatch_attempt(uuid,uuid,bigint,uuid,uuid,text) owner to postgres;
revoke all on function public.release_notification_dispatch_attempt(uuid,uuid,bigint,uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.release_notification_dispatch_attempt(uuid,uuid,bigint,uuid,uuid,text) to service_role;

alter function public.record_notification_dispatch_result(uuid,uuid,bigint,uuid,uuid,text,integer,integer,text) owner to postgres;
revoke all on function public.record_notification_dispatch_result(uuid,uuid,bigint,uuid,uuid,text,integer,integer,text) from public,anon,authenticated,service_role;
grant execute on function public.record_notification_dispatch_result(uuid,uuid,bigint,uuid,uuid,text,integer,integer,text) to service_role;

alter function public.settle_notification_dispatch_job(uuid,uuid,bigint,uuid,text) owner to postgres;
revoke all on function public.settle_notification_dispatch_job(uuid,uuid,bigint,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.settle_notification_dispatch_job(uuid,uuid,bigint,uuid,text) to service_role;

alter function public.get_notification_dispatch_state(uuid,uuid,uuid,uuid,integer) owner to postgres;
revoke all on function public.get_notification_dispatch_state(uuid,uuid,uuid,uuid,integer) from public,anon,authenticated,service_role;
grant execute on function public.get_notification_dispatch_state(uuid,uuid,uuid,uuid,integer) to service_role;

do $validate$
declare r record; v_oid oid; v_actual record;
begin
  for r in select * from (values ('notification_dispatch_jobs','id','uuid',true,'gen_random_uuid()' ),
      ('notification_dispatch_jobs','event_id','uuid',true,null ),
      ('notification_dispatch_jobs','event_key','text',true,null ),
      ('notification_dispatch_jobs','event_type','text',true,null ),
      ('notification_dispatch_jobs','title','text',true,null ),
      ('notification_dispatch_jobs','body','text',true,null ),
      ('notification_dispatch_jobs','source_entity','text',true,null ),
      ('notification_dispatch_jobs','source_entity_id','text',true,null ),
      ('notification_dispatch_jobs','deep_link','text',true,null ),
      ('notification_dispatch_jobs','enqueued_by','uuid',true,null ),
      ('notification_dispatch_jobs','stage','text',true,'''ready''::text' ),
      ('notification_dispatch_jobs','next_run_at','timestamp with time zone',false,'now()' ),
      ('notification_dispatch_jobs','snapshot_at','timestamp with time zone',false,null ),
      ('notification_dispatch_jobs','lease_epoch','bigint',true,'0' ),
      ('notification_dispatch_jobs','lease_owner','uuid',false,null ),
      ('notification_dispatch_jobs','lease_started_at','timestamp with time zone',false,null ),
      ('notification_dispatch_jobs','lease_until','timestamp with time zone',false,null ),
      ('notification_dispatch_jobs','acquire_operation_id','uuid',false,null ),
      ('notification_dispatch_jobs','acquire_expected_epoch','bigint',false,null ),
      ('notification_dispatch_jobs','batch_id','uuid',false,null ),
      ('notification_dispatch_jobs','batch_limit','integer',false,null ),
      ('notification_dispatch_jobs','batch_prepared_at','timestamp with time zone',false,null ),
      ('notification_dispatch_jobs','batch_count','integer',false,null ),
      ('notification_dispatch_jobs','settle_operation_id','uuid',false,null ),
      ('notification_dispatch_jobs','settled_at','timestamp with time zone',false,null ),
      ('notification_dispatch_jobs','settle_reason','text',false,null ),
      ('notification_dispatch_jobs','last_error_code','character varying(64)',false,null ),
      ('notification_dispatch_jobs','completed_at','timestamp with time zone',false,null ),
      ('notification_dispatch_jobs','created_at','timestamp with time zone',true,'now()' ),
      ('notification_dispatch_jobs','updated_at','timestamp with time zone',true,'now()' ),
      ('notification_dispatch_attempts','id','uuid',true,'gen_random_uuid()' ),
      ('notification_dispatch_attempts','job_id','uuid',true,null ),
      ('notification_dispatch_attempts','delivery_id','uuid',true,null ),
      ('notification_dispatch_attempts','subscription_ref','uuid',true,null ),
      ('notification_dispatch_attempts','batch_id','uuid',true,null ),
      ('notification_dispatch_attempts','prepared_epoch','bigint',true,null ),
      ('notification_dispatch_attempts','attempt_no','integer',true,null ),
      ('notification_dispatch_attempts','claim_token','uuid',true,null ),
      ('notification_dispatch_attempts','credentials_hash','bytea',true,null ),
      ('notification_dispatch_attempts','stage','text',true,'''prepared''::text' ),
      ('notification_dispatch_attempts','begin_operation_id','uuid',true,'gen_random_uuid()' ),
      ('notification_dispatch_attempts','record_operation_id','uuid',true,'gen_random_uuid()' ),
      ('notification_dispatch_attempts','ambiguity_operation_id','uuid',true,'gen_random_uuid()' ),
      ('notification_dispatch_attempts','release_operation_id','uuid',true,'gen_random_uuid()' ),
      ('notification_dispatch_attempts','prepared_at','timestamp with time zone',true,'now()' ),
      ('notification_dispatch_attempts','begin_requested_timeout_ms','integer',false,null ),
      ('notification_dispatch_attempts','send_owner','uuid',false,null ),
      ('notification_dispatch_attempts','send_epoch','bigint',false,null ),
      ('notification_dispatch_attempts','send_timeout_ms','integer',false,null ),
      ('notification_dispatch_attempts','send_started_at','timestamp with time zone',false,null ),
      ('notification_dispatch_attempts','send_deadline_at','timestamp with time zone',false,null ),
      ('notification_dispatch_attempts','ambiguity_after','timestamp with time zone',false,null ),
      ('notification_dispatch_attempts','ambiguity_at','timestamp with time zone',false,null ),
      ('notification_dispatch_attempts','ambiguity_reason','text',false,null ),
      ('notification_dispatch_attempts','provider_outcome','text',false,null ),
      ('notification_dispatch_attempts','provider_http_status','smallint',false,null ),
      ('notification_dispatch_attempts','provider_retry_after_seconds','integer',false,null ),
      ('notification_dispatch_attempts','result_recorded_at','timestamp with time zone',false,null ),
      ('notification_dispatch_attempts','release_reason','text',false,null ),
      ('notification_dispatch_attempts','released_at','timestamp with time zone',false,null ),
      ('notification_dispatch_attempts','release_owner','uuid',false,null ),
      ('notification_dispatch_attempts','release_epoch','bigint',false,null ),
      ('notification_dispatch_attempts','release_attempt_count','integer',false,null ),
      ('notification_dispatch_attempts','updated_at','timestamp with time zone',true,'now()' )) x(t,c,typ,nn,def) loop
    select format_type(a.atttypid,a.atttypmod) as typ,a.attnotnull as nn,
      pg_get_expr(d.adbin,d.adrelid) as def into v_actual
      from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
      where a.attrelid=to_regclass('public.'||r.t) and a.attname=r.c and a.attnum>0 and not a.attisdropped;
    if not found or row(v_actual.typ,v_actual.nn,v_actual.def) is distinct from row(r.typ,r.nn,r.def) then
      raise exception 'DURABLE_COLUMN_CONTRACT_MISMATCH: %.%',r.t,r.c;
    end if;
  end loop;
  for r in select * from (values
    ('notification_dispatch_jobs',30),
    ('notification_dispatch_attempts',34)
  ) x(t,n) loop
    v_oid:=to_regclass('public.'||r.t);
    if (select count(*) from pg_attribute where attrelid=v_oid and attnum>0 and not attisdropped)<>r.n
      or not exists(select 1 from pg_class where oid=v_oid and relkind='r' and relowner='postgres'::regrole
        and relrowsecurity and not relforcerowsecurity)
      or exists(select 1 from pg_policy where polrelid=v_oid)
      or exists(select 1 from pg_attribute where attrelid=v_oid and attnum>0 and attacl is not null)
      or exists(select 1 from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
        where c.oid=v_oid and a.grantee<>c.relowner)
      or exists(select 1 from pg_constraint where conrelid=v_oid and not convalidated)
      or exists(select 1 from pg_index where indrelid=v_oid and (not indisvalid or not indisready))
      then raise exception 'DURABLE_TABLE_SECURITY_MISMATCH'; end if;
  end loop;
  for r in select * from (values
    ('enqueue_notification_dispatch(text,text,text,text,text,text,text,uuid)',5),
    ('acquire_notification_dispatch_job(uuid,uuid,uuid,bigint,integer)',5),
    ('prepare_notification_dispatch_batch(uuid,uuid,bigint,uuid)',5),
    ('begin_notification_dispatch_send(uuid,uuid,bigint,uuid,uuid,integer)',3),
    ('release_notification_dispatch_attempt(uuid,uuid,bigint,uuid,uuid,text)',3),
    ('record_notification_dispatch_result(uuid,uuid,bigint,uuid,uuid,text,integer,integer,text)',3),
    ('settle_notification_dispatch_job(uuid,uuid,bigint,uuid,text)',5),
    ('get_notification_dispatch_state(uuid,uuid,uuid,uuid,integer)',3)
  ) x(sig,seconds) loop
    v_oid:=to_regprocedure('public.'||r.sig);
    if not exists(select 1 from pg_proc p where p.oid=v_oid and p.proowner='postgres'::regrole and p.prosecdef
      and cardinality(p.proconfig)=3
      and p.proconfig @> array['search_path=pg_catalog, public, pg_temp','statement_timeout='||r.seconds||'s','lock_timeout=750ms'])
      or exists(select 1 from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        where p.oid=v_oid and (a.grantee not in (p.proowner,'service_role'::regrole)
          or (a.grantee='service_role'::regrole and (a.privilege_type<>'EXECUTE' or a.is_grantable))))
      or not has_function_privilege('service_role',v_oid,'EXECUTE') then
      raise exception 'DURABLE_RPC_SECURITY_MISMATCH';
    end if;
  end loop;
end
$validate$;

notify pgrst, 'reload schema';
commit;
