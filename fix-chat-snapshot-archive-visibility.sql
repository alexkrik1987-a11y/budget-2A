-- БЮДЖЕТ 2 «А»: ЯВНАЯ ФИЛЬТРАЦИЯ АРХИВА ЧАТА В SNAPSHOT
--
-- load_class_budget_snapshot() работает как SECURITY DEFINER, поэтому владелец
-- с BYPASSRLS не ограничивается пользовательской RLS-политикой chat_messages.
-- Фильтр ниже явно повторяет действующее правило видимости архива:
-- участник видит активные сообщения, администратор также видит архивные.

begin;

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
        select class_name, school_year, useful_info, updated_at
        from public.class_profile
        where id = true
      ) as item
    ), jsonb_build_object('class_name', '2 «А»', 'school_year', '', 'useful_info', '{}'::jsonb)),
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

commit;
