-- =========================================================
-- БЮДЖЕТ КЛАССА: АРХИВ СБОРОВ, УЧЕНИКИ, НОВЫЙ УЧЕБНЫЙ ГОД
--
-- Безопасно для повторного запуска в Supabase -> SQL Editor.
-- Скрипт не удаляет текущие записи. Перед любой массовой
-- операцией интерфейс создаёт снимок через create_budget_backup().
-- =========================================================

create extension if not exists pgcrypto;

-- 1. Новые поля хранят историю сборов, не меняя существующие данные.
alter table public.campaigns
  add column if not exists archived_at timestamptz null,
  add column if not exists archived_by uuid null references auth.users(id) on delete set null,
  add column if not exists school_year text null,
  add column if not exists archived_students jsonb null check (archived_students is null or jsonb_typeof(archived_students) = 'array');

alter table public.expenses
  add column if not exists receipt_path text null,
  add column if not exists campaign_id uuid null references public.campaigns(id) on delete set null;

create index if not exists idx_campaigns_active_sort
  on public.campaigns (sort_order)
  where archived_at is null;

create index if not exists idx_campaigns_archive_year
  on public.campaigns (school_year, archived_at desc)
  where archived_at is not null;

create index if not exists idx_expenses_campaign_id
  on public.expenses (campaign_id);

-- Одна строка с названием класса и текущим учебным годом.
create table if not exists public.class_profile (
  id boolean primary key default true check (id),
  class_name text not null default '2 «А»',
  school_year text not null default '2025/2026',
  updated_by uuid null references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

insert into public.class_profile (id, class_name, school_year)
values (true, '2 «А»', '2025/2026')
on conflict (id) do nothing;

alter table public.class_profile enable row level security;

drop policy if exists "Class members read class profile" on public.class_profile;
create policy "Class members read class profile"
on public.class_profile for select to authenticated
using (public.can_access_budget());

drop policy if exists "Admins update class profile" on public.class_profile;
create policy "Admins update class profile"
on public.class_profile for update to authenticated
using (public.is_admin())
with check (public.is_admin());

revoke all on public.class_profile from anon;
grant select, update on public.class_profile to authenticated;

-- 2. Самодостаточное восстановление ручных копий.
-- Не использует pg_cron, поэтому кнопка ручной копии работает
-- независимо от наличия планировщика в тарифе Supabase.
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
    'version', 2,
    'created_at', now(),
    'class_profile', coalesce((
      select to_jsonb(item)
      from public.class_profile item
      where item.id = true
    ), '{}'::jsonb),
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

  -- Ограничиваем только технические снимки, ручные остаются у администратора.
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
  select id, full_name, sort_order, coalesce(is_active, true), created_at, updated_at
  from jsonb_to_recordset(p_snapshot -> 'students') as item(
    id uuid,
    full_name text,
    sort_order integer,
    is_active boolean,
    created_at timestamptz,
    updated_at timestamptz
  );

  insert into public.campaigns (
    id, name, campaign_type, fund, expected_amount, is_open, sort_order,
    archived_at, archived_by, school_year, archived_students, created_at, updated_at
  )
  select
    id, name, campaign_type::public.campaign_type, fund::public.fund_type,
    expected_amount, coalesce(is_open, false), sort_order,
    archived_at, archived_by, school_year, archived_students, created_at, updated_at
  from jsonb_to_recordset(p_snapshot -> 'campaigns') as item(
    id uuid,
    name text,
    campaign_type text,
    fund text,
    expected_amount numeric,
    is_open boolean,
    sort_order integer,
    archived_at timestamptz,
    archived_by uuid,
    school_year text,
    archived_students jsonb,
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
    receipt_url, receipt_path, campaign_id, created_at, updated_at
  )
  select
    id, expense_date, description, category::public.expense_category,
    fund::public.fund_type, amount, receipt_url, receipt_path, campaign_id, created_at, updated_at
  from jsonb_to_recordset(p_snapshot -> 'expenses') as item(
    id uuid,
    expense_date date,
    description text,
    category text,
    fund text,
    amount numeric,
    receipt_url text,
    receipt_path text,
    campaign_id uuid,
    created_at timestamptz,
    updated_at timestamptz
  );

  -- Старые снимки не содержат профиль класса, поэтому они остаются полностью совместимыми.
  if jsonb_typeof(p_snapshot -> 'class_profile') = 'object' then
    update public.class_profile
    set class_name = coalesce(p_snapshot #>> '{class_profile,class_name}', class_name),
        school_year = coalesce(p_snapshot #>> '{class_profile,school_year}', school_year),
        updated_at = now()
    where id = true;
  end if;
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

-- 3. Административные действия. Функции проверяют права на стороне БД.
create or replace function public.archive_campaign(p_campaign_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_admin() then
    raise exception 'Administrator access required';
  end if;

  update public.campaigns
  set is_open = false,
      archived_at = now(),
      archived_by = auth.uid(),
      school_year = coalesce(school_year, (select school_year from public.class_profile where id = true)),
      archived_students = coalesce((
        select jsonb_agg(jsonb_build_object('id', item.id, 'full_name', item.full_name, 'sort_order', item.sort_order) order by item.sort_order, item.full_name)
        from public.students item
        where item.is_active = true
      ), '[]'::jsonb)
  where id = p_campaign_id
    and archived_at is null
    and is_open = false;

  if not found then
    raise exception 'Campaign not found, is open, or is already archived';
  end if;
end;
$$;

create or replace function public.restore_archived_campaign(p_campaign_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_admin() then
    raise exception 'Administrator access required';
  end if;

  update public.campaigns
  set archived_at = null,
      archived_by = null
  where id = p_campaign_id
    and archived_at is not null;

  if not found then
    raise exception 'Archived campaign not found';
  end if;
end;
$$;

create or replace function public.add_student(p_full_name text, p_sort_order integer default null)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_name text := btrim(p_full_name);
  v_order integer;
begin
  if not public.is_admin() then
    raise exception 'Administrator access required';
  end if;
  if length(v_name) < 2 or length(v_name) > 120 then
    raise exception 'Student name must be between 2 and 120 characters';
  end if;
  if exists (select 1 from public.students where lower(full_name) = lower(v_name)) then
    raise exception 'Student with this name already exists';
  end if;

  select coalesce(p_sort_order, coalesce(max(sort_order), 0) + 10)
  into v_order
  from public.students;

  insert into public.students (full_name, sort_order, is_active)
  values (v_name, greatest(v_order, 0), true)
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function public.update_student(p_student_id uuid, p_full_name text, p_sort_order integer)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_name text := btrim(p_full_name);
begin
  if not public.is_admin() then
    raise exception 'Administrator access required';
  end if;
  if length(v_name) < 2 or length(v_name) > 120 then
    raise exception 'Student name must be between 2 and 120 characters';
  end if;
  if exists (select 1 from public.students where lower(full_name) = lower(v_name) and id <> p_student_id) then
    raise exception 'Student with this name already exists';
  end if;

  update public.students
  set full_name = v_name,
      sort_order = greatest(coalesce(p_sort_order, sort_order), 0)
  where id = p_student_id;

  if not found then
    raise exception 'Student not found';
  end if;
end;
$$;

create or replace function public.deactivate_student(p_student_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_admin() then
    raise exception 'Administrator access required';
  end if;

  update public.students
  set is_active = false
  where id = p_student_id
    and is_active = true;

  if not found then
    raise exception 'Active student not found';
  end if;
end;
$$;

create or replace function public.reactivate_student(p_student_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_admin() then
    raise exception 'Administrator access required';
  end if;

  update public.students
  set is_active = true
  where id = p_student_id
    and is_active = false;

  if not found then
    raise exception 'Inactive student not found';
  end if;
end;
$$;

create or replace function public.prepare_new_school_year(
  p_class_name text,
  p_school_year text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_class_name text := btrim(p_class_name);
  v_school_year text := btrim(p_school_year);
  v_old_year text;
begin
  if not public.is_admin() then
    raise exception 'Administrator access required';
  end if;
  if length(v_class_name) < 2 or length(v_class_name) > 40 then
    raise exception 'Class name must be between 2 and 40 characters';
  end if;
  if v_school_year !~ '^20[0-9]{2}/20[0-9]{2}$' then
    raise exception 'School year must be in format YYYY/YYYY';
  end if;

  select school_year into v_old_year from public.class_profile where id = true;
  perform public.capture_budget_snapshot_internal('manual', auth.uid());

  -- Все незавершённые сборы становятся частью истории. Деньги и чеки не удаляются.
  update public.campaigns
  set is_open = false,
      archived_at = now(),
      archived_by = auth.uid(),
      school_year = coalesce(school_year, v_old_year),
      archived_students = coalesce((
        select jsonb_agg(jsonb_build_object('id', item.id, 'full_name', item.full_name, 'sort_order', item.sort_order) order by item.sort_order, item.full_name)
        from public.students item
        where item.is_active = true
      ), '[]'::jsonb)
  where archived_at is null;

  update public.class_profile
  set class_name = v_class_name,
      school_year = v_school_year,
      updated_by = auth.uid(),
      updated_at = now()
  where id = true;
end;
$$;

revoke all on function public.archive_campaign(uuid) from public, anon;
revoke all on function public.restore_archived_campaign(uuid) from public, anon;
revoke all on function public.add_student(text, integer) from public, anon;
revoke all on function public.update_student(uuid, text, integer) from public, anon;
revoke all on function public.deactivate_student(uuid) from public, anon;
revoke all on function public.reactivate_student(uuid) from public, anon;
revoke all on function public.prepare_new_school_year(text, text) from public, anon;

grant execute on function public.archive_campaign(uuid) to authenticated;
grant execute on function public.restore_archived_campaign(uuid) to authenticated;
grant execute on function public.add_student(text, integer) to authenticated;
grant execute on function public.update_student(uuid, text, integer) to authenticated;
grant execute on function public.deactivate_student(uuid) to authenticated;
grant execute on function public.reactivate_student(uuid) to authenticated;
grant execute on function public.prepare_new_school_year(text, text) to authenticated;

-- Метки текущих сборов заполняются только для новых записей; старые остаются без метки,
-- пока администратор не начнёт новый учебный год или не архивирует конкретный сбор.
