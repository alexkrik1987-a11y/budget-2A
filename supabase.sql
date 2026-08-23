-- =========================================================
-- БЮДЖЕТ КЛАССА: СХЕМА SUPABASE, RLS И НАЧАЛЬНЫЕ ДАННЫЕ
-- Выполните файл целиком в Supabase → SQL Editor → New query.
-- Скрипт рассчитан на новый проект. Повторный запуск безопасен для справочников.
-- =========================================================

create extension if not exists pgcrypto;

-- Типы-справочники не позволяют записать в БД случайное значение.
do $$ begin
  create type public.fund_type as enum ('MAIN', 'HOLIDAYS', 'BIRTHDAYS');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.campaign_type as enum ('MONTH', 'HOLIDAY', 'OTHER');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.expense_category as enum ('MAIN', 'HOLIDAYS', 'BIRTHDAYS', 'HOUSEHOLD', 'EXCURSIONS');
exception when duplicate_object then null;
end $$;

-- Закрытый список участников. Доступ определяется по подтверждённому email из Google JWT.
-- На таблицу намеренно нет клиентских политик записи: никто не может повысить себе роль.
do $$ begin
  create type public.member_role as enum ('PARENT', 'ADMIN');
exception when duplicate_object then null;
end $$;

create table if not exists public.class_members (
  email text primary key check (email = lower(email) and email ~ '^[^@]+@[^@]+\.[^@]+$'),
  role public.member_role not null default 'PARENT',
  created_at timestamptz not null default now()
);

create table if not exists public.students (
  id uuid primary key default gen_random_uuid(),
  full_name text not null unique check (char_length(full_name) between 2 and 100),
  sort_order integer not null default 0 check (sort_order >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (char_length(name) between 1 and 100),
  campaign_type public.campaign_type not null,
  fund public.fund_type not null,
  expected_amount numeric(12,2) not null default 0 check (expected_amount >= 0),
  is_open boolean not null default false,
  sort_order integer not null default 0 check (sort_order >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.contributions (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.students(id) on delete cascade,
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  amount numeric(12,2) not null default 0 check (amount >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (student_id, campaign_id)
);

create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),
  expense_date date not null default current_date,
  description text not null check (char_length(description) between 1 and 160),
  category public.expense_category not null,
  fund public.fund_type not null,
  amount numeric(12,2) not null check (amount > 0),
  receipt_url text null check (receipt_url is null or receipt_url ~ '^https://'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_students_sort on public.students(sort_order);
create index if not exists idx_campaigns_sort on public.campaigns(sort_order);
create index if not exists idx_contributions_campaign on public.contributions(campaign_id);
create index if not exists idx_contributions_student on public.contributions(student_id);
create index if not exists idx_expenses_date on public.expenses(expense_date desc);
create index if not exists idx_expenses_category on public.expenses(category);

-- Общий триггер автоматически обновляет updated_at.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists students_set_updated_at on public.students;
create trigger students_set_updated_at before update on public.students
for each row execute function public.set_updated_at();

drop trigger if exists campaigns_set_updated_at on public.campaigns;
create trigger campaigns_set_updated_at before update on public.campaigns
for each row execute function public.set_updated_at();

drop trigger if exists contributions_set_updated_at on public.contributions;
create trigger contributions_set_updated_at before update on public.contributions
for each row execute function public.set_updated_at();

drop trigger if exists expenses_set_updated_at on public.expenses;
create trigger expenses_set_updated_at before update on public.expenses
for each row execute function public.set_updated_at();

-- SECURITY DEFINER позволяет проверить закрытый список, не выдавая SELECT на class_members.
create or replace function public.can_access_budget()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.class_members
    where email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.class_members
    where email = lower(coalesce(auth.jwt() ->> 'email', ''))
      and role = 'ADMIN'
  );
$$;

revoke all on function public.can_access_budget() from public;
revoke all on function public.is_admin() from public;
grant execute on function public.can_access_budget() to authenticated;
grant execute on function public.is_admin() to authenticated;

-- Включаем защиту на уровне строк.
alter table public.class_members enable row level security;

-- class_members читается только через SECURITY DEFINER RPC. Удаляем известную
-- широкую legacy-policy, но останавливаемся при любом неожиданном определении.
do $$
declare
  v_policy_oid oid;
  v_policy_permissive boolean;
  v_policy_command "char";
  v_policy_roles oid[];
  v_policy_qual text;
  v_policy_with_check text;
begin
  if not exists (
    select 1
    from pg_class as relation
    where relation.oid = 'public.class_members'::regclass
      and relation.relkind in ('r', 'p')
      and relation.relrowsecurity
  ) then
    raise exception 'Security conflict: RLS is not enabled for public.class_members';
  end if;

  select
    policy.oid,
    policy.polpermissive,
    policy.polcmd,
    policy.polroles,
    pg_get_expr(policy.polqual, policy.polrelid, false),
    pg_get_expr(policy.polwithcheck, policy.polrelid, false)
  into
    v_policy_oid,
    v_policy_permissive,
    v_policy_command,
    v_policy_roles,
    v_policy_qual,
    v_policy_with_check
  from pg_policy as policy
  where policy.polrelid = 'public.class_members'::regclass
    and policy.polname = 'Allow public read';

  if v_policy_oid is not null then
    if not v_policy_permissive
       or v_policy_command <> 'r'
       or v_policy_roles <> array[0::oid]
       or regexp_replace(
            lower(coalesce(v_policy_qual, '')),
            '[[:space:]()]',
            '',
            'g'
          ) <> 'true'
       or v_policy_with_check is not null
    then
      raise exception 'Security conflict: policy "Allow public read" on public.class_members has an unexpected definition';
    end if;

    drop policy "Allow public read" on public.class_members;
  end if;

  revoke all on table public.class_members from public, anon, authenticated;
end
$$;

alter table public.students enable row level security;
alter table public.campaigns enable row level security;
alter table public.contributions enable row level security;
alter table public.expenses enable row level security;

-- Удаляем старые одноимённые политики, чтобы скрипт можно было запускать повторно.
drop policy if exists "Authenticated users read students" on public.students;
drop policy if exists "Admins manage students" on public.students;
drop policy if exists "Authenticated users read campaigns" on public.campaigns;
drop policy if exists "Admins manage campaigns" on public.campaigns;
drop policy if exists "Authenticated users read contributions" on public.contributions;
drop policy if exists "Admins manage contributions" on public.contributions;
drop policy if exists "Authenticated users read expenses" on public.expenses;
drop policy if exists "Admins manage expenses" on public.expenses;

-- Любой вошедший через Google родитель видит данные, но не изменяет их.
create policy "Authenticated users read students"
on public.students for select to authenticated
using (public.can_access_budget());

create policy "Authenticated users read campaigns"
on public.campaigns for select to authenticated
using (public.can_access_budget());

create policy "Authenticated users read contributions"
on public.contributions for select to authenticated
using (public.can_access_budget());

create policy "Authenticated users read expenses"
on public.expenses for select to authenticated
using (public.can_access_budget());

-- Только администраторы могут добавлять, менять и удалять записи.
create policy "Admins manage students"
on public.students for all to authenticated
using (public.is_admin())
with check (public.is_admin());

create policy "Admins manage campaigns"
on public.campaigns for all to authenticated
using (public.is_admin())
with check (public.is_admin());

create policy "Admins manage contributions"
on public.contributions for all to authenticated
using (public.is_admin())
with check (public.is_admin());

create policy "Admins manage expenses"
on public.expenses for all to authenticated
using (public.is_admin())
with check (public.is_admin());

-- Начальные 14 учеников.
insert into public.students (full_name, sort_order) values
  ('Варчак К.', 10),
  ('Горовик В.', 20),
  ('Дергачёв А.', 30),
  ('Иштутинов Т.', 40),
  ('Кармес Д.', 50),
  ('Лепетухина В.', 60),
  ('Лукьянова С.', 70),
  ('Макаренко О.', 80),
  ('Марков М.', 90),
  ('Мотовилов З.', 100),
  ('Удовенко А.', 110),
  ('Чан В.', 120),
  ('Ширманова Д.', 130),
  ('Яковлева М.', 140)
on conflict (full_name) do update set sort_order = excluded.sort_order, is_active = true;

-- 9 учебных месяцев. Нулевой план администратор меняет в интерфейсе.
insert into public.campaigns (name, campaign_type, fund, expected_amount, is_open, sort_order) values
  ('Сентябрь', 'MONTH', 'MAIN', 0, false, 10),
  ('Октябрь', 'MONTH', 'MAIN', 0, false, 20),
  ('Ноябрь', 'MONTH', 'MAIN', 0, false, 30),
  ('Декабрь', 'MONTH', 'MAIN', 0, false, 40),
  ('Январь', 'MONTH', 'MAIN', 0, false, 50),
  ('Февраль', 'MONTH', 'MAIN', 0, false, 60),
  ('Март', 'MONTH', 'MAIN', 0, false, 70),
  ('Апрель', 'MONTH', 'MAIN', 0, false, 80),
  ('Май', 'MONTH', 'MAIN', 0, false, 90),
  ('День учителя', 'HOLIDAY', 'HOLIDAYS', 0, false, 110),
  ('Новый год', 'HOLIDAY', 'HOLIDAYS', 0, false, 120),
  ('23 Февраля / 8 Марта', 'HOLIDAY', 'HOLIDAYS', 0, false, 130),
  ('Окончание года', 'HOLIDAY', 'HOLIDAYS', 0, false, 140)
on conflict (name) do update set
  campaign_type = excluded.campaign_type,
  fund = excluded.fund,
  sort_order = excluded.sort_order;

-- Realtime: добавляем таблицы в публикацию Supabase.
do $$
begin
  alter publication supabase_realtime add table public.students;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.campaigns;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.contributions;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.expenses;
exception when duplicate_object then null;
end $$;

-- =========================================================
-- ДОБАВЛЕНИЕ АДМИНИСТРАТОРА И РОДИТЕЛЕЙ
-- Email указывайте в нижнем регистре, точно как в Google-аккаунте.
--
-- insert into public.class_members (email, role) values
--   ('admin@example.com', 'ADMIN'),
--   ('parent1@example.com', 'PARENT'),
--   ('parent2@example.com', 'PARENT')
-- on conflict (email) do update set role = excluded.role;
--
-- Удаление доступа:
-- delete from public.class_members where email = 'parent1@example.com';
-- =========================================================
