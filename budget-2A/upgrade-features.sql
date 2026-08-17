-- =========================================================
-- БЮДЖЕТ 2 «А»: РЕЗЕРВНЫЕ КОПИИ, ВОССТАНОВЛЕНИЕ И ЧЕКИ
-- Выполните файл один раз в Supabase -> SQL Editor -> New query.
-- Скрипт не удаляет существующие данные и безопасен для повторного запуска.
-- =========================================================

create extension if not exists pgcrypto;
create extension if not exists pg_cron;

alter table public.expenses
  add column if not exists receipt_path text null;

-- Исправляем старое опечаточное имя, если оно осталось после первоначального seed.
update public.students
set full_name = 'Мотовилов З.'
where full_name = 'Петровилов З.'
  and not exists (select 1 from public.students where full_name = 'Мотовилов З.');
update public.students
set is_active = false
where full_name = 'Петровилов З.';

create table if not exists public.budget_backups (
  id uuid primary key default gen_random_uuid(),
  backup_type text not null check (backup_type in ('daily', 'manual', 'undo', 'pre_restore', 'import')),
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  record_count integer not null default 0 check (record_count >= 0),
  created_by uuid null,
  created_at timestamptz not null default now()
);

create index if not exists idx_budget_backups_created_at
  on public.budget_backups(created_at desc);

alter table public.budget_backups enable row level security;

drop policy if exists "Admins read backups" on public.budget_backups;
create policy "Admins read backups"
on public.budget_backups for select to authenticated
using (public.is_admin());

revoke all on public.budget_backups from anon;
grant select on public.budget_backups to authenticated;

-- Внутренняя функция создаёт единый согласованный снимок всех бюджетных таблиц.
create or replace function public.capture_budget_snapshot_internal(
  p_backup_type text,
  p_created_by uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_backup_id uuid;
  v_snapshot jsonb;
  v_record_count integer;
begin
  if p_backup_type not in ('daily', 'manual', 'undo', 'pre_restore', 'import') then
    raise exception 'Unsupported backup type';
  end if;

  select jsonb_build_object(
    'version', 1,
    'created_at', now(),
    'students', coalesce((
      select jsonb_agg(to_jsonb(item) order by item.sort_order, item.full_name)
      from public.students item
    ), '[]'::jsonb),
    'campaigns', coalesce((
      select jsonb_agg(to_jsonb(item) order by item.sort_order, item.created_at)
      from public.campaigns item
    ), '[]'::jsonb),
    'contributions', coalesce((
      select jsonb_agg(to_jsonb(item) order by item.created_at)
      from public.contributions item
    ), '[]'::jsonb),
    'expenses', coalesce((
      select jsonb_agg(to_jsonb(item) order by item.expense_date, item.created_at)
      from public.expenses item
    ), '[]'::jsonb)
  ) into v_snapshot;

  select
    jsonb_array_length(v_snapshot -> 'students') +
    jsonb_array_length(v_snapshot -> 'campaigns') +
    jsonb_array_length(v_snapshot -> 'contributions') +
    jsonb_array_length(v_snapshot -> 'expenses')
  into v_record_count;

  insert into public.budget_backups (backup_type, snapshot, record_count, created_by)
  values (p_backup_type, v_snapshot, v_record_count, p_created_by)
  returning id into v_backup_id;

  -- Храним 45 ежедневных снимков и 25 точек быстрой отмены.
  delete from public.budget_backups
  where backup_type = 'daily'
    and id not in (
      select id from public.budget_backups
      where backup_type = 'daily'
      order by created_at desc
      limit 45
    );

  delete from public.budget_backups
  where backup_type = 'undo'
    and id not in (
      select id from public.budget_backups
      where backup_type = 'undo'
      order by created_at desc
      limit 25
    );

  return v_backup_id;
end;
$$;

revoke all on function public.capture_budget_snapshot_internal(text, uuid) from public, anon, authenticated;

create or replace function public.create_budget_backup(p_backup_type text default 'manual')
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_admin() then
    raise exception 'Administrator access required';
  end if;
  if p_backup_type not in ('manual', 'undo', 'import') then
    raise exception 'Unsupported manual backup type';
  end if;
  return public.capture_budget_snapshot_internal(p_backup_type, auth.uid());
end;
$$;

revoke all on function public.create_budget_backup(text) from public, anon;
grant execute on function public.create_budget_backup(text) to authenticated;

create or replace function public.create_scheduled_budget_backup()
returns uuid
language sql
security definer
set search_path = public, pg_temp
as $$
  select public.capture_budget_snapshot_internal('daily', null);
$$;

revoke all on function public.create_scheduled_budget_backup() from public, anon, authenticated;

-- Полное восстановление выполняется одной транзакцией. При ошибке изменения откатятся.
create or replace function public.restore_budget_snapshot(p_snapshot jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_admin() then
    raise exception 'Administrator access required';
  end if;
  if jsonb_typeof(p_snapshot) <> 'object'
    or jsonb_typeof(p_snapshot -> 'students') <> 'array'
    or jsonb_typeof(p_snapshot -> 'campaigns') <> 'array'
    or jsonb_typeof(p_snapshot -> 'contributions') <> 'array'
    or jsonb_typeof(p_snapshot -> 'expenses') <> 'array' then
    raise exception 'Invalid backup format';
  end if;

  perform public.capture_budget_snapshot_internal('pre_restore', auth.uid());

  delete from public.contributions;
  delete from public.expenses;
  delete from public.campaigns;
  delete from public.students;

  insert into public.students (id, full_name, sort_order, is_active, created_at, updated_at)
  select id, full_name, sort_order, is_active, created_at, updated_at
  from jsonb_to_recordset(p_snapshot -> 'students') as item(
    id uuid,
    full_name text,
    sort_order integer,
    is_active boolean,
    created_at timestamptz,
    updated_at timestamptz
  );

  insert into public.campaigns (
    id, name, campaign_type, fund, expected_amount, is_open, sort_order, created_at, updated_at
  )
  select
    id, name, campaign_type::public.campaign_type, fund::public.fund_type,
    expected_amount, is_open, sort_order, created_at, updated_at
  from jsonb_to_recordset(p_snapshot -> 'campaigns') as item(
    id uuid,
    name text,
    campaign_type text,
    fund text,
    expected_amount numeric,
    is_open boolean,
    sort_order integer,
    created_at timestamptz,
    updated_at timestamptz
  );

  insert into public.contributions (
    id, student_id, campaign_id, amount, created_at, updated_at
  )
  select id, student_id, campaign_id, amount, created_at, updated_at
  from jsonb_to_recordset(p_snapshot -> 'contributions') as item(
    id uuid,
    student_id uuid,
    campaign_id uuid,
    amount numeric,
    created_at timestamptz,
    updated_at timestamptz
  );

  insert into public.expenses (
    id, expense_date, description, category, fund, amount,
    receipt_url, receipt_path, created_at, updated_at
  )
  select
    id, expense_date, description, category::public.expense_category,
    fund::public.fund_type, amount, receipt_url, receipt_path, created_at, updated_at
  from jsonb_to_recordset(p_snapshot -> 'expenses') as item(
    id uuid,
    expense_date date,
    description text,
    category text,
    fund text,
    amount numeric,
    receipt_url text,
    receipt_path text,
    created_at timestamptz,
    updated_at timestamptz
  );
end;
$$;

revoke all on function public.restore_budget_snapshot(jsonb) from public, anon;
grant execute on function public.restore_budget_snapshot(jsonb) to authenticated;

create or replace function public.restore_budget_backup(p_backup_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_snapshot jsonb;
begin
  if not public.is_admin() then
    raise exception 'Administrator access required';
  end if;

  select snapshot into v_snapshot
  from public.budget_backups
  where id = p_backup_id;

  if v_snapshot is null then
    raise exception 'Backup not found';
  end if;

  perform public.restore_budget_snapshot(v_snapshot);
end;
$$;

revoke all on function public.restore_budget_backup(uuid) from public, anon;
grant execute on function public.restore_budget_backup(uuid) to authenticated;

-- Закрытое хранилище чеков: родители читают, администраторы загружают и удаляют.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'class-receipts',
  'class-receipts',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Class members read receipts" on storage.objects;
create policy "Class members read receipts"
on storage.objects for select to authenticated
using (bucket_id = 'class-receipts' and public.can_access_budget());

drop policy if exists "Admins upload receipts" on storage.objects;
create policy "Admins upload receipts"
on storage.objects for insert to authenticated
with check (bucket_id = 'class-receipts' and public.is_admin());

drop policy if exists "Admins update receipts" on storage.objects;
create policy "Admins update receipts"
on storage.objects for update to authenticated
using (bucket_id = 'class-receipts' and public.is_admin())
with check (bucket_id = 'class-receipts' and public.is_admin());

drop policy if exists "Admins delete receipts" on storage.objects;
create policy "Admins delete receipts"
on storage.objects for delete to authenticated
using (bucket_id = 'class-receipts' and public.is_admin());

-- Ежедневный снимок в 01:00 UTC. Повторный запуск обновляет расписание.
do $$
declare
  existing_job bigint;
begin
  select jobid into existing_job
  from cron.job
  where jobname = 'budget-2a-daily-backup';

  if existing_job is not null then
    perform cron.unschedule(existing_job);
  end if;

  perform cron.schedule(
    'budget-2a-daily-backup',
    '0 1 * * *',
    'select public.create_scheduled_budget_backup();'
  );
end;
$$;

-- Создаём первый снимок после установки обновления, но не дублируем его при повторном запуске.
do $$
begin
  if not exists (select 1 from public.budget_backups) then
    perform public.capture_budget_snapshot_internal('manual', null);
  end if;
end;
$$;
