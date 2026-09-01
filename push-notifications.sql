-- =========================================================
-- БЮДЖЕТ 2 «А»: PUSH-УВЕДОМЛЕНИЯ — PHASE 1
--
-- Только новые таблицы, индексы, RLS и права доступа.
-- SQL намеренно НЕ выполняет отправку уведомлений, не создаёт
-- Edge Function/VAPID secrets и не меняет существующие объекты.
-- Запускать только после базовой схемы supabase.sql и access-flow
-- migrations, в которых определены can_access_budget() и is_admin().
-- =========================================================

begin;

-- Phase 1 переиспользует существующий безопасный trigger-function
-- public.set_updated_at() из supabase.sql. Новую копию функции не создаём.
do $$
begin
  if to_regprocedure('public.set_updated_at()') is null then
    raise exception 'Required function public.set_updated_at() is missing';
  end if;
  if to_regprocedure('public.can_access_budget()') is null then
    raise exception 'Required function public.can_access_budget() is missing';
  end if;
end
$$;

-- Подписки браузеров. Endpoint уникален глобально, поэтому один endpoint
-- не может появиться у нескольких пользователей или устройств повторно.
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  enabled boolean not null default true,
  user_agent text null,
  device_label text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_success_at timestamptz null,
  last_failure_at timestamptz null,
  failure_count integer not null default 0,
  constraint push_subscriptions_endpoint_key unique (endpoint),
  constraint push_subscriptions_endpoint_https check (endpoint ~ '^https://'),
  constraint push_subscriptions_keys_nonempty check (char_length(p256dh) > 0 and char_length(auth) > 0),
  constraint push_subscriptions_failure_count_nonnegative check (failure_count >= 0),
  constraint push_subscriptions_device_label_length check (device_label is null or char_length(device_label) between 1 and 120)
);

create index if not exists idx_push_subscriptions_user_enabled
  on public.push_subscriptions (user_id, enabled);

create index if not exists idx_push_subscriptions_failure_cleanup
  on public.push_subscriptions (last_failure_at)
  where enabled = false;

do $$
begin
  if not exists (
    select 1
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'push_subscriptions'
      and t.tgname = 'push_subscriptions_set_updated_at'
      and not t.tgisinternal
  ) then
    create trigger push_subscriptions_set_updated_at
    before update on public.push_subscriptions
    for each row execute function public.set_updated_at();
  end if;
end
$$;

alter table public.push_subscriptions enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'push_subscriptions'
      and policyname = 'Users read own push subscriptions'
  ) then
    create policy "Users read own push subscriptions"
    on public.push_subscriptions for select to authenticated
    using (user_id = auth.uid());
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'push_subscriptions'
      and policyname = 'Approved users create own push subscriptions'
  ) then
    create policy "Approved users create own push subscriptions"
    on public.push_subscriptions for insert to authenticated
    with check (
      user_id = auth.uid()
      and public.can_access_budget()
    );
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'push_subscriptions'
      and policyname = 'Approved users update own push subscriptions'
  ) then
    create policy "Approved users update own push subscriptions"
    on public.push_subscriptions for update to authenticated
    using (user_id = auth.uid())
    with check (
      user_id = auth.uid()
      and public.can_access_budget()
    );
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'push_subscriptions'
      and policyname = 'Users delete own push subscriptions'
  ) then
    create policy "Users delete own push subscriptions"
    on public.push_subscriptions for delete to authenticated
    using (user_id = auth.uid());
  end if;
end
$$;

revoke all on public.push_subscriptions from public, anon, authenticated, service_role;
grant select, insert, update, delete on public.push_subscriptions to authenticated;
-- Это единственный bulk-access путь для будущего trusted backend.
-- service_role никогда не выдаётся frontend-коду.
grant select, insert, update, delete on public.push_subscriptions to service_role;

-- Настройки категорий принадлежат пользователю, а не class_profile:
-- они одинаковы для всех устройств пользователя.
create table if not exists public.notification_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  schedule_enabled boolean not null default true,
  memos_enabled boolean not null default true,
  announcements_enabled boolean not null default true,
  contributions_enabled boolean not null default false,
  expenses_enabled boolean not null default false,
  reports_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'notification_preferences'
      and t.tgname = 'notification_preferences_set_updated_at'
      and not t.tgisinternal
  ) then
    create trigger notification_preferences_set_updated_at
    before update on public.notification_preferences
    for each row execute function public.set_updated_at();
  end if;
end
$$;

alter table public.notification_preferences enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'notification_preferences'
      and policyname = 'Users read own notification preferences'
  ) then
    create policy "Users read own notification preferences"
    on public.notification_preferences for select to authenticated
    using (user_id = auth.uid());
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'notification_preferences'
      and policyname = 'Approved users create own notification preferences'
  ) then
    create policy "Approved users create own notification preferences"
    on public.notification_preferences for insert to authenticated
    with check (
      user_id = auth.uid()
      and public.can_access_budget()
    );
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'notification_preferences'
      and policyname = 'Approved users update own notification preferences'
  ) then
    create policy "Approved users update own notification preferences"
    on public.notification_preferences for update to authenticated
    using (user_id = auth.uid())
    with check (
      user_id = auth.uid()
      and public.can_access_budget()
    );
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'notification_preferences'
      and policyname = 'Users delete own notification preferences'
  ) then
    create policy "Users delete own notification preferences"
    on public.notification_preferences for delete to authenticated
    using (user_id = auth.uid());
  end if;
end
$$;

revoke all on public.notification_preferences from public, anon, authenticated, service_role;
grant select, insert, update, delete on public.notification_preferences to authenticated;
grant select, insert, update, delete on public.notification_preferences to service_role;

-- Trusted outbox/audit table. Parents получают NONE: ни сырые события,
-- ни статусы fanout не должны читаться из клиентского API.
-- source_entity_id выбран как text, потому что текущие источники включают
-- JSON-секции singleton class_profile и UUID chat/будущих announcement rows.
create table if not exists public.notification_events (
  id uuid primary key default gen_random_uuid(),
  event_key text not null unique,
  event_type text not null,
  title text not null,
  body text not null,
  source_entity text null,
  source_entity_id text null,
  deep_link text not null,
  created_by uuid null references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  status text not null default 'queued',
  attempt_count integer not null default 0,
  last_error text null,
  constraint notification_events_type_check
    check (event_type in ('schedule', 'memo', 'announcement')),
  constraint notification_events_status_check
    check (status in ('queued', 'sending', 'sent', 'failed')),
  constraint notification_events_event_key_nonempty
    check (char_length(btrim(event_key)) between 1 and 200),
  constraint notification_events_title_length
    check (char_length(btrim(title)) between 1 and 160),
  constraint notification_events_body_length
    check (char_length(btrim(body)) between 1 and 500),
  constraint notification_events_deep_link_internal
    check (deep_link ~ '^/' and deep_link !~ '^//')
);

create index if not exists idx_notification_events_status_created
  on public.notification_events (status, created_at);

alter table public.notification_events enable row level security;

revoke all on public.notification_events from public, anon, authenticated, service_role;
grant select, insert, update, delete on public.notification_events to service_role;

-- =========================================================
-- STRICT SCHEMA/CATALOG VALIDATION
-- =========================================================
-- CREATE ... IF NOT EXISTS проверяет только имя relation/index. Поэтому
-- после DDL проверяем фактический контракт и при любом drift останавливаем
-- всю транзакцию. Это assertion-only слой: он ничего не исправляет.
do $$
declare
  v_relation record;
  v_column record;
  v_actual record;
  v_constraint record;
  v_index record;
  v_policy record;
  v_acl record;
  v_trigger record;
  v_norm text;
  v_actual_count integer;
begin
  -- Таблицы должны быть обычными relations (relkind = 'r').
  for v_relation in
    select * from (values
      ('push_subscriptions'),
      ('notification_preferences'),
      ('notification_events')
    ) as expected(table_name)
  loop
    if not exists (
      select 1
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname = v_relation.table_name
        and c.relkind = 'r'
    ) then
      raise exception 'Schema drift: public.% must be an ordinary table', v_relation.table_name;
    end if;
  end loop;

  -- Exact column names, data types, nullability and defaults.
  for v_column in
    select * from (values
      ('push_subscriptions','id','uuid','NO','gen_random_uuid'),
      ('push_subscriptions','user_id','uuid','NO',null),
      ('push_subscriptions','endpoint','text','NO',null),
      ('push_subscriptions','p256dh','text','NO',null),
      ('push_subscriptions','auth','text','NO',null),
      ('push_subscriptions','enabled','boolean','NO','true'),
      ('push_subscriptions','user_agent','text','YES',null),
      ('push_subscriptions','device_label','text','YES',null),
      ('push_subscriptions','created_at','timestamptz','NO','now'),
      ('push_subscriptions','updated_at','timestamptz','NO','now'),
      ('push_subscriptions','last_success_at','timestamptz','YES',null),
      ('push_subscriptions','last_failure_at','timestamptz','YES',null),
      ('push_subscriptions','failure_count','integer','NO','0'),
      ('notification_preferences','user_id','uuid','NO',null),
      ('notification_preferences','schedule_enabled','boolean','NO','true'),
      ('notification_preferences','memos_enabled','boolean','NO','true'),
      ('notification_preferences','announcements_enabled','boolean','NO','true'),
      ('notification_preferences','contributions_enabled','boolean','NO','false'),
      ('notification_preferences','expenses_enabled','boolean','NO','false'),
      ('notification_preferences','reports_enabled','boolean','NO','false'),
      ('notification_preferences','updated_at','timestamptz','NO','now'),
      ('notification_events','id','uuid','NO','gen_random_uuid'),
      ('notification_events','event_key','text','NO',null),
      ('notification_events','event_type','text','NO',null),
      ('notification_events','title','text','NO',null),
      ('notification_events','body','text','NO',null),
      ('notification_events','source_entity','text','YES',null),
      ('notification_events','source_entity_id','text','YES',null),
      ('notification_events','deep_link','text','NO',null),
      ('notification_events','created_by','uuid','YES',null),
      ('notification_events','created_at','timestamptz','NO','now'),
      ('notification_events','status','text','NO','queued'),
      ('notification_events','attempt_count','integer','NO','0'),
      ('notification_events','last_error','text','YES',null)
    ) as expected(table_name,column_name,expected_type,expected_nullable,expected_default)
  loop
    select c.data_type, c.udt_name, c.is_nullable,
           pg_get_expr(ad.adbin, ad.adrelid, true) as default_expr
    into v_actual
    from information_schema.columns c
    join pg_namespace n on n.nspname = c.table_schema
    join pg_class r on r.relnamespace = n.oid and r.relname = c.table_name
    join pg_attribute a on a.attrelid = r.oid and a.attname = c.column_name
      and a.attnum > 0 and not a.attisdropped
    left join pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum
    where c.table_schema = 'public'
      and c.table_name = v_column.table_name
      and c.column_name = v_column.column_name;

    if not found then
      raise exception 'Schema drift: public.%.% is missing', v_column.table_name, v_column.column_name;
    end if;

    if (case v_column.expected_type
      when 'uuid' then v_actual.udt_name <> 'uuid'
      when 'text' then v_actual.data_type <> 'text'
      when 'boolean' then v_actual.data_type <> 'boolean'
      when 'timestamptz' then v_actual.data_type <> 'timestamp with time zone'
      when 'integer' then v_actual.data_type <> 'integer'
      else true
    end) then
      raise exception 'Schema drift: public.%.% has unexpected type', v_column.table_name, v_column.column_name;
    end if;

    if v_actual.is_nullable <> v_column.expected_nullable then
      raise exception 'Schema drift: public.%.% nullability is % not %',
        v_column.table_name, v_column.column_name, v_actual.is_nullable, v_column.expected_nullable;
    end if;

    if v_column.expected_default is null then
      if v_actual.default_expr is not null then
        raise exception 'Schema drift: public.%.% must not have a default', v_column.table_name, v_column.column_name;
      end if;
    else
      v_norm := lower(regexp_replace(coalesce(v_actual.default_expr, ''), '[[:space:]]+', '', 'g'));
      if v_column.expected_default = 'gen_random_uuid'
         and v_norm not in ('gen_random_uuid()', 'gen_random_uuid()::uuid') then
        raise exception 'Schema drift: public.%.% default is not gen_random_uuid()', v_column.table_name, v_column.column_name;
      elsif v_column.expected_default = 'now'
         and v_norm not in ('now()', 'current_timestamp') then
        raise exception 'Schema drift: public.%.% default is not now()', v_column.table_name, v_column.column_name;
      elsif v_column.expected_default = 'true'
         and v_norm not in ('true', 'true::boolean', 'true::bool', '''true''::boolean', '''true''::bool') then
        raise exception 'Schema drift: public.%.% default is not true', v_column.table_name, v_column.column_name;
      elsif v_column.expected_default = 'false'
         and v_norm not in ('false', 'false::boolean', 'false::bool', '''false''::boolean', '''false''::bool') then
        raise exception 'Schema drift: public.%.% default is not false', v_column.table_name, v_column.column_name;
      elsif v_column.expected_default = '0'
         and v_norm not in ('0', '0::integer', '0::int4', '''0''::integer', '''0''::int4') then
        raise exception 'Schema drift: public.%.% default is not zero', v_column.table_name, v_column.column_name;
      elsif v_column.expected_default = 'queued'
         and v_norm not in ('''queued''', '''queued''::text') then
        raise exception 'Schema drift: public.%.% default is not queued', v_column.table_name, v_column.column_name;
      end if;
    end if;
  end loop;

  -- Неожиданные пользовательские колонки считаются drift, а не игнорируются.
  for v_column in
    select c.table_name, c.column_name
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name in ('push_subscriptions', 'notification_preferences', 'notification_events')
      and not exists (
        select 1
        from (values
          ('push_subscriptions','id'),('push_subscriptions','user_id'),('push_subscriptions','endpoint'),
          ('push_subscriptions','p256dh'),('push_subscriptions','auth'),('push_subscriptions','enabled'),
          ('push_subscriptions','user_agent'),('push_subscriptions','device_label'),('push_subscriptions','created_at'),
          ('push_subscriptions','updated_at'),('push_subscriptions','last_success_at'),('push_subscriptions','last_failure_at'),
          ('push_subscriptions','failure_count'),('notification_preferences','user_id'),
          ('notification_preferences','schedule_enabled'),('notification_preferences','memos_enabled'),
          ('notification_preferences','announcements_enabled'),('notification_preferences','contributions_enabled'),
          ('notification_preferences','expenses_enabled'),('notification_preferences','reports_enabled'),
          ('notification_preferences','updated_at'),('notification_events','id'),('notification_events','event_key'),
          ('notification_events','event_type'),('notification_events','title'),('notification_events','body'),
          ('notification_events','source_entity'),('notification_events','source_entity_id'),('notification_events','deep_link'),
          ('notification_events','created_by'),('notification_events','created_at'),('notification_events','status'),
          ('notification_events','attempt_count'),('notification_events','last_error')
        ) as expected(table_name,column_name)
        where expected.table_name = c.table_name
          and expected.column_name = c.column_name
      )
  loop
    raise exception 'Schema drift: unexpected column public.%.%', v_column.table_name, v_column.column_name;
  end loop;

  -- Exact expected constraint names and validation state.
  for v_constraint in
    select * from (values
      ('push_subscriptions','push_subscriptions_endpoint_key'),
      ('push_subscriptions','push_subscriptions_endpoint_https'),
      ('push_subscriptions','push_subscriptions_keys_nonempty'),
      ('push_subscriptions','push_subscriptions_failure_count_nonnegative'),
      ('push_subscriptions','push_subscriptions_device_label_length'),
      ('notification_events','notification_events_event_key_key'),
      ('notification_events','notification_events_type_check'),
      ('notification_events','notification_events_status_check'),
      ('notification_events','notification_events_event_key_nonempty'),
      ('notification_events','notification_events_title_length'),
      ('notification_events','notification_events_body_length'),
      ('notification_events','notification_events_deep_link_internal')
    ) as expected(table_name,constraint_name)
  loop
    if not exists (
      select 1
      from pg_constraint c
      join pg_class r on r.oid = c.conrelid
      join pg_namespace n on n.oid = r.relnamespace
      where n.nspname = 'public'
        and r.relname = v_constraint.table_name
        and c.conname = v_constraint.constraint_name
        and c.convalidated
    ) then
      raise exception 'Schema drift: missing or invalid constraint public.%.%', v_constraint.table_name, v_constraint.constraint_name;
    end if;
  end loop;

  -- Никаких дополнительных PK/UNIQUE/FK/CHECK constraints в строгом контракте.
  for v_constraint in
    select r.relname as table_name, c.conname
    from pg_constraint c
    join pg_class r on r.oid = c.conrelid
    join pg_namespace n on n.oid = r.relnamespace
    where n.nspname = 'public'
      and r.relname in ('push_subscriptions', 'notification_preferences', 'notification_events')
      and c.contype in ('u','c')
      and c.conname not in (
        'push_subscriptions_endpoint_key',
        'push_subscriptions_endpoint_https','push_subscriptions_keys_nonempty',
        'push_subscriptions_failure_count_nonnegative','push_subscriptions_device_label_length',
        'notification_events_event_key_key',
        'notification_events_type_check','notification_events_status_check',
        'notification_events_event_key_nonempty','notification_events_title_length',
        'notification_events_body_length','notification_events_deep_link_internal'
      )
  loop
    raise exception 'Schema drift: unexpected constraint public.%.%', v_constraint.table_name, v_constraint.conname;
  end loop;

  -- PRIMARY KEY semantics are name-independent: exactly one validated key
  -- with the expected column set/order is required for each table.
  for v_relation in
    select * from (values
      ('push_subscriptions','id'),
      ('notification_preferences','user_id'),
      ('notification_events','id')
    ) as expected(table_name,column_name)
  loop
    select count(*) into v_actual_count
    from pg_constraint c
    join pg_class r on r.oid = c.conrelid
    join pg_namespace n on n.oid = r.relnamespace
    where n.nspname = 'public'
      and r.relname = v_relation.table_name
      and c.contype = 'p';
    if v_actual_count <> 1 then
      raise exception 'Schema drift: public.% must have exactly one primary key', v_relation.table_name;
    end if;
    if not exists (
      select 1
      from pg_constraint c
      join pg_class r on r.oid = c.conrelid
      join pg_namespace n on n.oid = r.relnamespace
      where n.nspname = 'public'
        and r.relname = v_relation.table_name
        and c.contype = 'p'
        and c.convalidated
        and c.conkey = array[(
          select a.attnum
          from pg_attribute a
          where a.attrelid = r.oid
            and a.attname = v_relation.column_name
            and not a.attisdropped
        )]::smallint[]
    ) then
      raise exception 'Schema drift: public.% primary key must be (%)',
        v_relation.table_name, v_relation.column_name;
    end if;
  end loop;

  if not exists (
    select 1 from pg_constraint c join pg_class r on r.oid = c.conrelid
      join pg_namespace n on n.oid = r.relnamespace
    where n.nspname = 'public' and r.relname = 'push_subscriptions' and c.conname = 'push_subscriptions_endpoint_key'
      and c.contype = 'u' and c.conkey = array[(select attnum from pg_attribute where attrelid = r.oid and attname = 'endpoint')]::smallint[]
  ) then raise exception 'Schema drift: push_subscriptions endpoint must be UNIQUE'; end if;
  if not exists (
    select 1 from pg_constraint c join pg_class r on r.oid = c.conrelid
      join pg_namespace n on n.oid = r.relnamespace
    where n.nspname = 'public' and r.relname = 'notification_events' and c.conname = 'notification_events_event_key_key'
      and c.contype = 'u' and c.conkey = array[(select attnum from pg_attribute where attrelid = r.oid and attname = 'event_key')]::smallint[]
  ) then raise exception 'Schema drift: notification_events event_key must be UNIQUE'; end if;

  -- FOREIGN KEY semantics are name-independent and include exact counts,
  -- source/target columns, target relation and ON DELETE action.
  for v_relation in
    select * from (values
      ('push_subscriptions','user_id','c'),
      ('notification_preferences','user_id','c'),
      ('notification_events','created_by','n')
    ) as expected(table_name,column_name,expected_deltype)
  loop
    select count(*) into v_actual_count
    from pg_constraint c
    join pg_class r on r.oid = c.conrelid
    join pg_namespace n on n.oid = r.relnamespace
    where n.nspname = 'public'
      and r.relname = v_relation.table_name
      and c.contype = 'f';
    if v_actual_count <> 1 then
      raise exception 'Schema drift: public.% must have exactly one foreign key', v_relation.table_name;
    end if;
    if not exists (
      select 1
      from pg_constraint c
      join pg_class r on r.oid = c.conrelid
      join pg_namespace n on n.oid = r.relnamespace
      where n.nspname = 'public'
        and r.relname = v_relation.table_name
        and c.contype = 'f'
        and c.convalidated
        and c.confrelid = 'auth.users'::regclass
        and c.conkey = array[(
          select a.attnum
          from pg_attribute a
          where a.attrelid = r.oid
            and a.attname = v_relation.column_name
            and not a.attisdropped
        )]::smallint[]
        and c.confkey = array[(
          select a.attnum
          from pg_attribute a
          where a.attrelid = 'auth.users'::regclass
            and a.attname = 'id'
            and not a.attisdropped
        )]::smallint[]
        and c.confdeltype = v_relation.expected_deltype
    ) then
      raise exception 'Schema drift: public.%.% FK must reference auth.users(id) with expected ON DELETE action',
        v_relation.table_name, v_relation.column_name;
    end if;
  end loop;

  -- Exact CHECK counts: push_subscriptions has four, notification_events
  -- has six, and notification_preferences has none.
  for v_relation in
    select * from (values
      ('push_subscriptions', 4),
      ('notification_preferences', 0),
      ('notification_events', 6)
    ) as expected(table_name, expected_count)
  loop
    select count(*) into v_actual_count
    from pg_constraint c
    join pg_class r on r.oid = c.conrelid
    join pg_namespace n on n.oid = r.relnamespace
    where n.nspname = 'public'
      and r.relname = v_relation.table_name
      and c.contype = 'c';
    if v_actual_count <> v_relation.expected_count then
      raise exception 'Schema drift: public.% must have exactly % CHECK constraints',
        v_relation.table_name, v_relation.expected_count;
    end if;
  end loop;

  -- CHECK expressions are compared as complete normalized expressions, not
  -- by token presence. Parentheses/whitespace and canonical scalar casts are
  -- formatting details; an added OR/AND branch changes the normalized value
  -- and therefore fails. IN is accepted through PostgreSQL's canonical ANY.
  for v_constraint in
    select * from (values
      ('push_subscriptions','push_subscriptions_endpoint_https',
        'endpoint~''^https://''', null),
      ('push_subscriptions','push_subscriptions_keys_nonempty',
        'char_lengthp256dh>0andchar_lengthauth>0', null),
      ('push_subscriptions','push_subscriptions_failure_count_nonnegative',
        'failure_count>=0', null),
      ('push_subscriptions','push_subscriptions_device_label_length',
        'device_labelisnullorchar_lengthdevice_label>=1andchar_lengthdevice_label<=120', null),
      ('notification_events','notification_events_type_check',
        'event_type=anyarray[''schedule'',''memo'',''announcement'']',
        'event_typein[''schedule'',''memo'',''announcement'']'),
      ('notification_events','notification_events_status_check',
        'status=anyarray[''queued'',''sending'',''sent'',''failed'']',
        'statusin[''queued'',''sending'',''sent'',''failed'']'),
      ('notification_events','notification_events_event_key_nonempty',
        'char_lengthbtrimevent_key>=1andchar_lengthbtrimevent_key<=200', null),
      ('notification_events','notification_events_title_length',
        'char_lengthbtrimtitle>=1andchar_lengthbtrimtitle<=160', null),
      ('notification_events','notification_events_body_length',
        'char_lengthbtrimbody>=1andchar_lengthbtrimbody<=500', null),
      ('notification_events','notification_events_deep_link_internal',
        'deep_link~''^/''anddeep_link!~''^//''', null)
    ) as expected(table_name,constraint_name,expected_expression,alternative_expression)
  loop
    select regexp_replace(
             regexp_replace(lower(pg_get_expr(c.conbin, c.conrelid, true)),
               '[[:space:]()]', '', 'g'),
             '::(text|boolean|bool|integer|int4)', '', 'g')
    into v_norm
    from pg_constraint c
    join pg_class r on r.oid = c.conrelid
    join pg_namespace n on n.oid = r.relnamespace
    where n.nspname = 'public'
      and r.relname = v_constraint.table_name
      and c.conname = v_constraint.constraint_name
      and c.contype = 'c'
      and c.convalidated;
    if v_norm is null
       or (v_norm <> v_constraint.expected_expression
           and (v_constraint.alternative_expression is null
                or v_norm <> v_constraint.alternative_expression)) then
      raise exception 'Schema drift: CHECK definition mismatch for public.%.%',
        v_constraint.table_name, v_constraint.constraint_name;
    end if;
  end loop;

  -- Exact explicit index contracts.
  for v_index in
    select * from (values
      ('push_subscriptions','idx_push_subscriptions_user_enabled',ARRAY['user_id','enabled']::text[],'none'),
      ('push_subscriptions','idx_push_subscriptions_failure_cleanup',ARRAY['last_failure_at']::text[],'enabled=false'),
      ('notification_events','idx_notification_events_status_created',ARRAY['status','created_at']::text[],'none')
    ) as expected(table_name,index_name,expected_columns,expected_predicate)
  loop
    select i.indisunique, i.indisvalid, i.indisready, i.indnkeyatts, i.indnatts,
           key_columns.actual_columns,
           case when i.indpred is null then 'none'
                else regexp_replace(
                       regexp_replace(lower(pg_get_expr(i.indpred, i.indrelid, true)),
                         '[[:space:]()]', '', 'g'),
                       '::(boolean|bool)', '', 'g')
           end as actual_predicate
    into v_actual
    from pg_index i
    join pg_class idx on idx.oid = i.indexrelid
    join pg_namespace ns on ns.oid = idx.relnamespace
    cross join lateral (
      select array_agg(a.attname::text order by k.ord)::text[] as actual_columns
      from unnest(i.indkey) with ordinality as k(attnum, ord)
      left join pg_attribute a on a.attrelid = i.indrelid
        and a.attnum = k.attnum
        and a.attnum > 0
        and not a.attisdropped
    ) key_columns
    where ns.nspname = 'public'
      and idx.relname = v_index.index_name
      and i.indrelid = ('public.' || v_index.table_name)::regclass;

    if not found then
      raise exception 'Schema drift: index public.% is missing or on the wrong table', v_index.index_name;
    end if;
    if v_actual.indisunique or not v_actual.indisvalid or not v_actual.indisready
       or v_actual.indnkeyatts <> v_actual.indnatts
       or v_actual.actual_columns is distinct from v_index.expected_columns then
      raise exception 'Schema drift: index public.% definition mismatch', v_index.index_name;
    end if;
    if v_index.expected_predicate = 'none' and v_actual.actual_predicate is distinct from 'none' then
      raise exception 'Schema drift: index public.% must not be partial', v_index.index_name;
    elsif v_index.expected_predicate = 'enabled=false'
      -- enabled is NOT NULL in the validated table contract, so these are
      -- the only safe complete-expression equivalents of enabled = false.
      and v_actual.actual_predicate not in (
        'enabled=false',
        'notenabled',
        'enabledisfalse'
      ) then
      raise exception 'Schema drift: index public.% predicate must be exactly enabled = false',
        v_index.index_name;
    end if;
  end loop;

  -- RLS must be enabled on all three tables.
  for v_relation in
    select * from (values ('push_subscriptions'),('notification_preferences'),('notification_events')) as expected(table_name)
  loop
    if not exists (
      select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = v_relation.table_name and c.relrowsecurity
    ) then
      raise exception 'Security drift: RLS is disabled on public.%', v_relation.table_name;
    end if;
  end loop;

  -- Exact owner-policy allowlist; any extra policy is a blocker.
  select count(*) into v_actual_count from pg_policies
  where schemaname = 'public' and tablename = 'push_subscriptions';
  if v_actual_count <> 4 then raise exception 'Security drift: push_subscriptions must have exactly 4 policies'; end if;
  select count(*) into v_actual_count from pg_policies
  where schemaname = 'public' and tablename = 'notification_preferences';
  if v_actual_count <> 4 then raise exception 'Security drift: notification_preferences must have exactly 4 policies'; end if;
  select count(*) into v_actual_count from pg_policies
  where schemaname = 'public' and tablename = 'notification_events';
  if v_actual_count <> 0 then raise exception 'Security drift: notification_events must have zero policies'; end if;

  for v_policy in
    select * from (values
      ('push_subscriptions','Users read own push subscriptions','SELECT','user_id=auth.uid',''),
      ('push_subscriptions','Approved users create own push subscriptions','INSERT','','user_id=auth.uidandcan_access_budget'),
      ('push_subscriptions','Approved users update own push subscriptions','UPDATE','user_id=auth.uid','user_id=auth.uidandcan_access_budget'),
      ('push_subscriptions','Users delete own push subscriptions','DELETE','user_id=auth.uid',''),
      ('notification_preferences','Users read own notification preferences','SELECT','user_id=auth.uid',''),
      ('notification_preferences','Approved users create own notification preferences','INSERT','','user_id=auth.uidandcan_access_budget'),
      ('notification_preferences','Approved users update own notification preferences','UPDATE','user_id=auth.uid','user_id=auth.uidandcan_access_budget'),
      ('notification_preferences','Users delete own notification preferences','DELETE','user_id=auth.uid','')
    ) as expected(table_name,policy_name,expected_cmd,expected_qual,expected_check)
  loop
    select p.cmd, p.permissive, p.roles,
           replace(
             regexp_replace(lower(coalesce(p.qual,'')), '[[:space:]()]', '', 'g'),
             'public.can_access_budget', 'can_access_budget') as actual_qual,
           replace(
             regexp_replace(lower(coalesce(p.with_check,'')), '[[:space:]()]', '', 'g'),
             'public.can_access_budget', 'can_access_budget') as actual_check
    into v_actual
    from pg_policies p
    where p.schemaname = 'public'
      and p.tablename = v_policy.table_name
      and p.policyname = v_policy.policy_name;
    if not found then
      raise exception 'Security drift: missing policy public.%.%', v_policy.table_name, v_policy.policy_name;
    end if;
    if v_actual.cmd <> v_policy.expected_cmd
       or v_actual.permissive is distinct from 'PERMISSIVE'
       or v_actual.roles <> array['authenticated']::name[]
       or v_actual.actual_qual <> v_policy.expected_qual
       or v_actual.actual_check <> v_policy.expected_check then
      raise exception 'Security drift: policy definition mismatch public.%.%', v_policy.table_name, v_policy.policy_name;
    end if;
  end loop;

  -- Table ACL contract. Owner/system ACL entries are ignored; custom direct
  -- grants and all column-level ACLs are rejected.
  for v_acl in
    with expected(table_name,grantee,expected_privileges) as (
      values
        ('push_subscriptions','anon',ARRAY[]::text[]),
        ('push_subscriptions','PUBLIC',ARRAY[]::text[]),
        ('push_subscriptions','authenticated',ARRAY['DELETE','INSERT','SELECT','UPDATE']::text[]),
        ('push_subscriptions','service_role',ARRAY['DELETE','INSERT','SELECT','UPDATE']::text[]),
        ('notification_preferences','anon',ARRAY[]::text[]),
        ('notification_preferences','PUBLIC',ARRAY[]::text[]),
        ('notification_preferences','authenticated',ARRAY['DELETE','INSERT','SELECT','UPDATE']::text[]),
        ('notification_preferences','service_role',ARRAY['DELETE','INSERT','SELECT','UPDATE']::text[]),
        ('notification_events','anon',ARRAY[]::text[]),
        ('notification_events','PUBLIC',ARRAY[]::text[]),
        ('notification_events','authenticated',ARRAY[]::text[]),
        ('notification_events','service_role',ARRAY['DELETE','INSERT','SELECT','UPDATE']::text[])
    ), actual as (
      select c.relname as table_name,
             case when x.grantee = 0 then 'PUBLIC' else r.rolname end as grantee,
             array_agg(distinct x.privilege_type order by x.privilege_type) as privileges,
             bool_or(x.is_grantable) as has_grant_option
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) x
      left join pg_roles r on r.oid = x.grantee
      where n.nspname = 'public'
        and c.relname in ('push_subscriptions','notification_preferences','notification_events')
      group by c.relname, case when x.grantee = 0 then 'PUBLIC' else r.rolname end
    )
    select e.table_name, e.grantee, e.expected_privileges,
           coalesce(a.privileges, ARRAY[]::text[]) as actual_privileges,
           coalesce(a.has_grant_option, false) as actual_has_grant_option
    from expected e left join actual a using (table_name, grantee)
  loop
    if v_acl.expected_privileges <> v_acl.actual_privileges
       or v_acl.actual_has_grant_option then
      raise exception 'ACL drift: public.% role % has privileges % (grant_option=%), expected % without grant option',
        v_acl.table_name, v_acl.grantee, v_acl.actual_privileges,
        v_acl.actual_has_grant_option, v_acl.expected_privileges;
    end if;
  end loop;

  for v_acl in
    select c.relname as table_name, r.rolname as grantee
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) x
    join pg_roles r on r.oid = x.grantee
    where n.nspname = 'public'
      and c.relname in ('push_subscriptions','notification_preferences','notification_events')
      and x.grantee <> c.relowner
      and r.rolname not in (
        'anon','authenticated','service_role','postgres','supabase_admin','dashboard_user','pg_database_owner',
        'authenticator','supabase_auth_admin','supabase_storage_admin',
        'supabase_realtime_admin','supabase_replication_admin',
        'pg_read_all_data','pg_write_all_data','pg_monitor','pg_read_all_settings',
        'pg_read_all_stats','pg_stat_scan_tables','pg_checkpoint',
        'pg_execute_server_program','pg_read_server_files','pg_signal_backend',
        'pg_write_server_files'
      )
      and not r.rolsuper
  loop
    raise exception 'ACL drift: unexpected direct grant to role % on public.%', v_acl.grantee, v_acl.table_name;
  end loop;

  -- pg_attribute.attacl is the source of truth for explicit column ACLs.
  -- Table-level grants in pg_class.relacl are validated separately above.
  if exists (
    select 1 from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname in ('push_subscriptions','notification_preferences','notification_events')
      and a.attnum > 0 and not a.attisdropped and a.attacl is not null
  ) then
    raise exception 'ACL drift: unexpected column-level grant on a push-notification table';
  end if;

  -- Exact user trigger set and semantics; internal FK triggers ignored.
  select count(*) into v_actual_count
  from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'push_subscriptions' and not t.tgisinternal;
  if v_actual_count <> 1 then raise exception 'Trigger drift: push_subscriptions must have exactly one user trigger'; end if;
  select count(*) into v_actual_count
  from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'notification_preferences' and not t.tgisinternal;
  if v_actual_count <> 1 then raise exception 'Trigger drift: notification_preferences must have exactly one user trigger'; end if;
  select count(*) into v_actual_count
  from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'notification_events' and not t.tgisinternal;
  if v_actual_count <> 0 then raise exception 'Trigger drift: notification_events must have zero user triggers'; end if;

  for v_trigger in
    select * from (values
      ('push_subscriptions','push_subscriptions_set_updated_at'),
      ('notification_preferences','notification_preferences_set_updated_at')
    ) as expected(table_name,trigger_name)
  loop
    select t.tgtype, t.tgenabled, t.tgattr, t.tgqual, t.tgnargs,
           p.oid as function_oid, pn.nspname as function_schema,
           p.proname as function_name, p.pronargs as function_arg_count
    into v_actual
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_proc p on p.oid = t.tgfoid
    join pg_namespace pn on pn.oid = p.pronamespace
    where n.nspname = 'public'
      and c.relname = v_trigger.table_name
      and t.tgname = v_trigger.trigger_name
      and not t.tgisinternal;
    -- pg_trigger.tgtype bit mask: ROW=1, BEFORE=2, INSERT=4,
    -- DELETE=8, UPDATE=16, TRUNCATE=32, INSTEAD OF=64.
    -- Exact value 19 therefore means only BEFORE UPDATE FOR EACH ROW.
    if not found or v_actual.tgenabled <> 'O'
       or v_actual.tgtype <> 19
       or v_actual.tgattr is distinct from ''::int2vector
       or v_actual.tgqual is not null
       or v_actual.tgnargs <> 0
       or v_actual.function_oid <> 'public.set_updated_at()'::regprocedure
       or v_actual.function_schema <> 'public'
       or v_actual.function_name <> 'set_updated_at'
       or v_actual.function_arg_count <> 0 then
      raise exception 'Trigger drift: public.%.% must be enabled BEFORE UPDATE FOR EACH ROW calling public.set_updated_at()',
        v_trigger.table_name, v_trigger.trigger_name;
    end if;
  end loop;
end
$$;

notify pgrst, 'reload schema';
commit;

-- Повторный запуск сохраняет существующие данные: CREATE ... IF NOT EXISTS
-- не пересоздаёт таблицы и индексы, а ожидаемые политики/triggers создаются
-- только при отсутствии. Несовместимая существующая конфигурация проходит
-- строгую catalog-проверку и останавливает транзакцию; существующие
-- бизнес-таблицы и access-flow этим файлом не изменяются.
