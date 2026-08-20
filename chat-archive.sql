-- БЮДЖЕТ 2 «А»: БЕЗОПАСНОЕ АРХИВИРОВАНИЕ СТАРЫХ СООБЩЕНИЙ ЧАТА
-- Запустить один раз в Supabase -> SQL Editor.
-- Сообщения не удаляются: они получают archived_at и остаются в базе.

begin;

alter table public.chat_messages
  add column if not exists archived_at timestamptz null,
  add column if not exists archived_by text null;

create index if not exists idx_chat_messages_active_created_at
  on public.chat_messages (created_at desc, id desc)
  where archived_at is null;

create index if not exists idx_chat_messages_archived_at
  on public.chat_messages (archived_at desc)
  where archived_at is not null;

-- Родители видят только активную переписку. Администратор может видеть и архив,
-- но обычный клиент всё равно запрашивает только активные сообщения.
drop policy if exists "Class members read chat messages" on public.chat_messages;
create policy "Class members read chat messages"
on public.chat_messages for select to authenticated
using (
  public.can_access_budget()
  and (archived_at is null or public.is_admin())
);

-- Архивирует старые сообщения, не трогая закреплённое объявление и последние 200
-- активных сообщений. Повторный запуск безопасен: уже архивные строки не меняются.
create or replace function public.archive_old_class_chat_messages(
  p_keep_recent integer default 200,
  p_age interval default interval '1 year'
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_archived integer;
begin
  if p_keep_recent < 0 or p_keep_recent > 10000 then
    raise exception 'p_keep_recent is out of range';
  end if;

  if p_age < interval '30 days' then
    raise exception 'p_age must be at least 30 days';
  end if;

  -- Вызов разрешён администратору или планировщику Supabase/ Postgres.
  if current_user <> 'postgres' and not public.is_admin() then
    raise exception 'Administrator or scheduler access required';
  end if;

  with keep_messages as (
    select id
    from public.chat_messages
    where archived_at is null
    order by created_at desc, id desc
    limit p_keep_recent
  )
  update public.chat_messages as message
  set archived_at = now(),
      archived_by = 'automatic-retention'
  where message.archived_at is null
    and message.is_pinned is not true
    and message.created_at < now() - p_age
    and not exists (
      select 1 from keep_messages keep where keep.id = message.id
    );

  get diagnostics v_archived = row_count;
  return v_archived;
end;
$$;

revoke all on function public.archive_old_class_chat_messages(integer, interval) from public, anon, authenticated;
grant execute on function public.archive_old_class_chat_messages(integer, interval) to postgres;

-- Если в проекте доступен pg_cron, администратор может включить еженедельную уборку:
-- select cron.schedule(
--   'budget-2a-chat-archive-weekly',
--   '17 3 * * 0',
--   $$select public.archive_old_class_chat_messages(200, interval '1 year');$$
-- );

commit;

-- Проверка после запуска:
-- select count(*) filter (where archived_at is null) as active_messages,
--        count(*) filter (where archived_at is not null) as archived_messages,
--        count(*) filter (where is_pinned = true) as pinned_messages
-- from public.chat_messages;
