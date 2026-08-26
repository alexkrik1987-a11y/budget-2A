-- Реквизиты для перевода (Банк / Телефон / Карта) для бюджета 2 «А» класса.
-- Выполнять один раз в Supabase SQL Editor.
-- Ничего из финансовых таблиц не удаляет и не меняет.
-- Реальные реквизиты вносятся администратором через интерфейс сайта и в Git не попадают.

begin;

alter table public.class_profile
  add column if not exists payment_details jsonb not null default '{}'::jsonb;

alter table public.class_profile
  drop constraint if exists class_profile_payment_details_object;

alter table public.class_profile
  add constraint class_profile_payment_details_object
  check (jsonb_typeof(payment_details) = 'object');

-- Права доступа наследуются от существующих политик class_profile:
--   SELECT: authenticated + can_access_budget()  → родители читают
--   UPDATE: authenticated + is_admin()           → только администратор меняет
-- Отдельные политики для payment_details не нужны.

-- Родители получают реквизиты вместе со снимком бюджета.
create or replace function public.load_class_budget_snapshot()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.can_access_budget() then
    raise exception 'Class membership required';
  end if;

  return jsonb_build_object(
    'students', coalesce((
      select jsonb_agg(to_jsonb(item) order by item.is_active desc, item.sort_order, item.full_name)
      from (
        select id, full_name, sort_order, is_active, created_at, updated_at
        from public.students
      ) as item
    ), '[]'::jsonb),
    'campaigns', coalesce((
      select jsonb_agg(to_jsonb(item) order by item.sort_order)
      from (
        select id, name, campaign_type, fund, expected_amount, is_open, sort_order,
               archived_at, archived_by, school_year, archived_students, created_at, updated_at
        from public.campaigns
      ) as item
    ), '[]'::jsonb),
    'contributions', coalesce((
      select jsonb_agg(to_jsonb(item) order by item.created_at, item.id)
      from (
        select id, student_id, campaign_id, amount, created_at, updated_at
        from public.contributions
      ) as item
    ), '[]'::jsonb),
    'expenses', coalesce((
      select jsonb_agg(to_jsonb(item) order by item.expense_date desc, item.created_at desc)
      from (
        select id, expense_date, description, category, fund, amount, receipt_url,
               receipt_path, campaign_id, created_at, updated_at
        from public.expenses
      ) as item
    ), '[]'::jsonb),
    'class_profile', coalesce((
      select to_jsonb(item)
      from (
        select class_name, school_year, useful_info, payment_details, updated_at
        from public.class_profile
        where id = true
      ) as item
    ), jsonb_build_object(
      'class_name', '2 «А»',
      'school_year', '',
      'useful_info', '{}'::jsonb,
      'payment_details', '{}'::jsonb
    )),
    'chat_messages', coalesce((
      select jsonb_agg(to_jsonb(item) order by item.created_at, item.id)
      from (
        select id, author_id, author_name, body, created_at, is_pinned, pinned_at, archived_at
        from public.chat_messages
        where archived_at is null or public.is_admin()
        order by created_at desc, id desc
        limit 120
      ) as item
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.load_class_budget_snapshot() from public, anon;
grant execute on function public.load_class_budget_snapshot() to authenticated;

-- Бэкапы: реквизиты сохраняются и восстанавливаются вместе с профилем класса.
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
    id uuid, full_name text, sort_order integer, is_active boolean,
    created_at timestamptz, updated_at timestamptz
  );

  insert into public.campaigns (
    id, name, campaign_type, fund, expected_amount, is_open, sort_order,
    archived_at, archived_by, school_year, archived_students, created_at, updated_at
  )
  select id, name, campaign_type, fund, expected_amount, coalesce(is_open, false), sort_order,
         archived_at, archived_by, school_year, archived_students, created_at, updated_at
  from jsonb_to_recordset(p_snapshot -> 'campaigns') as item(
    id uuid, name text, campaign_type text, fund text, expected_amount numeric,
    is_open boolean, sort_order integer, archived_at timestamptz, archived_by uuid,
    school_year text, archived_students jsonb, created_at timestamptz, updated_at timestamptz
  );

  insert into public.contributions (id, student_id, campaign_id, amount, created_at, updated_at)
  select id, student_id, campaign_id, amount, created_at, updated_at
  from jsonb_to_recordset(p_snapshot -> 'contributions') as item(
    id uuid, student_id uuid, campaign_id uuid, amount numeric, created_at timestamptz, updated_at timestamptz
  );

  insert into public.expenses (
    id, expense_date, description, category, fund, amount,
    receipt_url, receipt_path, campaign_id, created_at, updated_at
  )
  select id, expense_date, description, category, fund, amount,
         receipt_url, receipt_path, campaign_id, created_at, updated_at
  from jsonb_to_recordset(p_snapshot -> 'expenses') as item(
    id uuid, expense_date date, description text, category text, fund text, amount numeric,
    receipt_url text, receipt_path text, campaign_id uuid, created_at timestamptz, updated_at timestamptz
  );

  if jsonb_typeof(p_snapshot -> 'class_profile') = 'object' then
    update public.class_profile
    set class_name = coalesce(p_snapshot #>> '{class_profile,class_name}', class_name),
        school_year = coalesce(p_snapshot #>> '{class_profile,school_year}', school_year),
        useful_info = case
          when jsonb_typeof(p_snapshot #> '{class_profile,useful_info}') = 'object'
            then p_snapshot #> '{class_profile,useful_info}'
          else useful_info
        end,
        payment_details = case
          when jsonb_typeof(p_snapshot #> '{class_profile,payment_details}') = 'object'
            then p_snapshot #> '{class_profile,payment_details}'
          else payment_details
        end,
        updated_at = now()
    where id = true;
  end if;
end;
$$;

revoke all on function public.restore_budget_snapshot(jsonb) from public, anon;
grant execute on function public.restore_budget_snapshot(jsonb) to authenticated;

notify pgrst, 'reload schema';
commit;

-- Проверка после запуска:
select
  payment_details is not null as payment_details_ready,
  jsonb_typeof(payment_details) = 'object' as payment_details_is_object
from public.class_profile
where id = true;
