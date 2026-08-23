-- =========================================================
-- БЮДЖЕТ КЛАССА: БЕСПЛАТНЫЙ ВСТРОЕННЫЙ ЧАТ
--
-- Запускается один раз в Supabase -> SQL Editor.
-- Безопасен для повторного запуска и не меняет бюджетные данные,
-- архивы, взносы, расходы или резервные копии.
-- =========================================================

create extension if not exists pgcrypto;

-- Только текстовые сообщения. Имя автора сохраняется в момент отправки,
-- чтобы история оставалась понятной при смене имени Google-профиля.
create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references auth.users(id) on delete cascade,
  author_name text not null check (char_length(author_name) between 1 and 120),
  body text not null check (char_length(btrim(body)) between 1 and 1000),
  created_at timestamptz not null default now()
);

create index if not exists idx_chat_messages_created_at
  on public.chat_messages (created_at desc, id desc);

alter table public.chat_messages enable row level security;

-- На чистой установке archived_at появится позже, в chat-archive.sql.
-- При replay после архивации не ослабляем policy обратно: если колонка уже есть,
-- сразу сохраняем итоговый фильтр активных сообщений и администраторского архива.
do $$
begin
  drop policy if exists "Class members read chat messages" on public.chat_messages;

  if exists (
    select 1
    from pg_attribute as attribute
    where attribute.attrelid = 'public.chat_messages'::regclass
      and attribute.attname = 'archived_at'
      and attribute.attnum > 0
      and not attribute.attisdropped
  ) then
    execute $policy$
      create policy "Class members read chat messages"
      on public.chat_messages for select to authenticated
      using (
        public.can_access_budget()
        and (archived_at is null or public.is_admin())
      )
    $policy$;
  else
    create policy "Class members read chat messages"
    on public.chat_messages for select to authenticated
    using (public.can_access_budget());
  end if;
end
$$;

-- Прямые INSERT/DELETE из браузера намеренно не разрешены.
-- Запись и удаление проходят только через функции ниже, которые проверяют
-- участника класса, автора и срок удаления на стороне базы.
revoke all on public.chat_messages from anon;
grant select on public.chat_messages to authenticated;

create or replace function public.send_class_chat_message(p_body text)
returns public.chat_messages
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_body text := btrim(coalesce(p_body, ''));
  v_author_name text;
  v_message public.chat_messages;
begin
  if not public.can_access_budget() then
    raise exception 'Class membership required';
  end if;

  if char_length(v_body) < 1 or char_length(v_body) > 1000 then
    raise exception 'Message must be between 1 and 1000 characters';
  end if;

  v_author_name := left(coalesce(
    nullif(btrim(auth.jwt() -> 'user_metadata' ->> 'full_name'), ''),
    nullif(btrim(auth.jwt() -> 'user_metadata' ->> 'name'), ''),
    'Родитель'
  ), 120);

  insert into public.chat_messages (author_id, author_name, body)
  values (auth.uid(), v_author_name, v_body)
  returning * into v_message;

  return v_message;
end;
$$;

create or replace function public.delete_class_chat_message(p_message_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.can_access_budget() then
    raise exception 'Class membership required';
  end if;

  delete from public.chat_messages
  where id = p_message_id
    and (
      public.is_admin()
      or (author_id = auth.uid() and created_at >= now() - interval '15 minutes')
    );

  if not found then
    raise exception 'Message not found, deletion period ended, or access denied';
  end if;
end;
$$;

revoke all on function public.send_class_chat_message(text) from public, anon;
revoke all on function public.delete_class_chat_message(uuid) from public, anon;
grant execute on function public.send_class_chat_message(text) to authenticated;
grant execute on function public.delete_class_chat_message(uuid) to authenticated;

-- Новые сообщения появляются у участников онлайн сразу, без отдельного сервера.
do $$
begin
  alter publication supabase_realtime add table public.chat_messages;
exception when duplicate_object then null;
end $$;

-- Сообщения не включаются в бюджетные снимки намеренно:
-- восстановление финансового отчёта не должно удалять переписку класса.
