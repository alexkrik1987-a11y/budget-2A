-- =========================================================
-- БЮДЖЕТ КЛАССА: САМОСТОЯТЕЛЬНЫЕ ЗАЯВКИ РОДИТЕЛЕЙ
--
-- Запускается один раз в Supabase -> SQL Editor.
-- Скрипт НЕ открывает бюджет или чат автоматически.
-- По умолчанию приём заявок ЗАКРЫТ. Администратор открывает
-- его на сайте, проверяет заявителей и одобряет только знакомых.
-- =========================================================

create extension if not exists pgcrypto;

-- Единственная строка с состоянием приёма заявок.
create table if not exists public.access_enrollment_settings (
  id boolean primary key default true check (id),
  enrollment_open boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid null references auth.users(id) on delete set null
);

insert into public.access_enrollment_settings (id, enrollment_open)
values (true, false)
on conflict (id) do nothing;

-- Заявка хранит email и имя исключительно из подтверждённого Google JWT.
-- Администратор видит её в настройках и принимает решение вручную.
create table if not exists public.access_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  email text not null unique check (email = lower(email) and email ~ '^[^@]+@[^@]+\.[^@]+$'),
  display_name text not null check (char_length(display_name) between 1 and 120),
  avatar_url text null check (avatar_url is null or avatar_url ~ '^https://'),
  request_status text not null default 'PENDING' check (request_status in ('PENDING', 'APPROVED', 'REJECTED')),
  requested_at timestamptz not null default now(),
  reviewed_at timestamptz null,
  reviewed_by uuid null references auth.users(id) on delete set null
);

create index if not exists idx_access_requests_status_time
  on public.access_requests (request_status, requested_at desc);

alter table public.access_enrollment_settings enable row level security;
alter table public.access_requests enable row level security;

-- Обычный пользователь не читает заявки и не может создать/подделать их напрямую.
-- Только администратор читает список через RLS; запись идёт через защищённые RPC ниже.
drop policy if exists "Admins read enrollment settings" on public.access_enrollment_settings;
create policy "Admins read enrollment settings"
on public.access_enrollment_settings for select to authenticated
using (public.is_admin());

drop policy if exists "Admins read access requests" on public.access_requests;
create policy "Admins read access requests"
on public.access_requests for select to authenticated
using (public.is_admin());

revoke all on public.access_enrollment_settings from anon;
revoke all on public.access_requests from anon;
grant select on public.access_enrollment_settings to authenticated;
grant select on public.access_requests to authenticated;

-- Возвращает состояние только текущего Google-аккаунта. Если приём открыт,
-- создаёт единственную заявку. Повторный вход не создаёт дубликаты.
create or replace function public.request_class_access()
returns table (request_status text, enrollment_open boolean, requested_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text := lower(btrim(coalesce(auth.jwt() ->> 'email', '')));
  v_name text;
  v_avatar text;
  v_open boolean := false;
  v_request public.access_requests;
begin
  if auth.uid() is null or v_email = '' then
    raise exception 'Google email is required';
  end if;

  -- Уже одобренный родитель не создаёт заявку и сразу получает доступ.
  if public.can_access_budget() then
    return query select 'APPROVED'::text, false, now();
    return;
  end if;

  select enrollment_open into v_open
  from public.access_enrollment_settings
  where id = true;
  v_open := coalesce(v_open, false);

  select * into v_request
  from public.access_requests
  where user_id = auth.uid() or email = v_email
  limit 1;

  -- Не сбрасываем уже рассмотренное решение повторным входом.
  if found then
    return query select v_request.request_status, v_open, v_request.requested_at;
    return;
  end if;

  if not v_open then
    return query select 'CLOSED'::text, false, null::timestamptz;
    return;
  end if;

  v_name := left(coalesce(
    nullif(btrim(auth.jwt() -> 'user_metadata' ->> 'full_name'), ''),
    nullif(btrim(auth.jwt() -> 'user_metadata' ->> 'name'), ''),
    'Родитель'
  ), 120);
  v_avatar := nullif(btrim(coalesce(
    auth.jwt() -> 'user_metadata' ->> 'avatar_url',
    auth.jwt() -> 'user_metadata' ->> 'picture',
    ''
  )), '');
  if v_avatar is not null and v_avatar !~ '^https://' then v_avatar := null; end if;

  insert into public.access_requests (user_id, email, display_name, avatar_url)
  values (auth.uid(), v_email, v_name, v_avatar)
  returning * into v_request;

  return query select v_request.request_status, true, v_request.requested_at;
end;
$$;

-- Администратор вручную меняет режим приёма. Открытый режим разрешает только
-- оставить заявку; он не даёт доступ к данным без отдельного одобрения.
create or replace function public.set_access_enrollment(p_open boolean)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_admin() then
    raise exception 'Administrator access required';
  end if;

  insert into public.access_enrollment_settings (id, enrollment_open, updated_at, updated_by)
  values (true, p_open, now(), auth.uid())
  on conflict (id) do update set
    enrollment_open = excluded.enrollment_open,
    updated_at = excluded.updated_at,
    updated_by = excluded.updated_by;
  return p_open;
end;
$$;

-- Одобрение добавляет email в уже существующий закрытый список class_members.
-- Бюджет и чат становятся доступны сразу после этого, без новой регистрации.
create or replace function public.approve_access_request(p_request_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.access_requests;
begin
  if not public.is_admin() then
    raise exception 'Administrator access required';
  end if;

  select * into v_request
  from public.access_requests
  where id = p_request_id
  for update;
  if not found then
    raise exception 'Access request not found';
  end if;

  insert into public.class_members (email, role)
  values (v_request.email, 'PARENT')
  on conflict (email) do nothing;

  update public.access_requests
  set request_status = 'APPROVED', reviewed_at = now(), reviewed_by = auth.uid()
  where id = v_request.id;
end;
$$;

create or replace function public.reject_access_request(p_request_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_admin() then
    raise exception 'Administrator access required';
  end if;

  update public.access_requests
  set request_status = 'REJECTED', reviewed_at = now(), reviewed_by = auth.uid()
  where id = p_request_id and request_status = 'PENDING';

  if not found then
    raise exception 'Pending access request not found';
  end if;
end;
$$;

create or replace function public.revoke_class_access(p_request_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_request public.access_requests;
  v_role public.member_role;
begin
  if not public.is_admin() then
    raise exception 'Administrator access required';
  end if;

  select * into v_request
  from public.access_requests
  where id = p_request_id
  for update;

  if not found then
    raise exception 'Access request not found';
  end if;

  select role into v_role
  from public.class_members
  where email = v_request.email;

  if v_role = 'ADMIN'::public.member_role then
    raise exception 'Administrator accounts cannot be removed in this panel';
  end if;

  -- Для одобренного родителя это немедленно закрывает бюджет и чат через can_access_budget().
  delete from public.class_members
  where email = v_request.email;

  -- Удаляем саму заявку, чтобы случайный или лишний профиль исчез из списка.
  delete from public.access_requests
  where id = v_request.id;
end;
$function$;

revoke all on function public.request_class_access() from public, anon;
revoke all on function public.set_access_enrollment(boolean) from public, anon;
revoke all on function public.approve_access_request(uuid) from public, anon;
revoke all on function public.reject_access_request(uuid) from public, anon;
grant execute on function public.request_class_access() to authenticated;
grant execute on function public.set_access_enrollment(boolean) to authenticated;
grant execute on function public.approve_access_request(uuid) to authenticated;
grant execute on function public.reject_access_request(uuid) to authenticated;

revoke execute on function public.revoke_class_access(uuid) from public;
revoke execute on function public.revoke_class_access(uuid) from anon;
grant execute on function public.revoke_class_access(uuid) to authenticated;
grant execute on function public.revoke_class_access(uuid) to service_role;

-- Администратор видит новые заявки на сайте сразу; обычным пользователям
-- эта публикация ничего не раскрывает, потому что RLS запрещает SELECT.
do $$
begin
  alter publication supabase_realtime add table public.access_enrollment_settings;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.access_requests;
exception when duplicate_object then null;
end $$;

-- Заявки намеренно не входят в финансовые резервные копии.
-- Восстановление бюджета не должно случайно отменять решения о доступе.
