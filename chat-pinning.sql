-- БЮДЖЕТ 2 «А»: ЗАКРЕПЛЕНИЕ СООБЩЕНИЙ ЧАТА
-- Применять после class-chat.sql и до chat-archive.sql/useful-info.sql.
-- Повторный запуск сохраняет существующую схему и переопределяет RPC без дублей.

begin;

alter table public.chat_messages
  add column if not exists is_pinned boolean not null default false,
  add column if not exists pinned_at timestamptz null,
  add column if not exists pinned_by uuid null;

do $$
begin
  if not exists (
    select 1
    from pg_attribute as a
    where a.attrelid = 'public.chat_messages'::regclass
      and a.attname = 'is_pinned'
      and a.attnum > 0
      and not a.attisdropped
      and a.atttypid = 'pg_catalog.bool'::regtype
      and a.atttypmod = -1
      and a.attnotnull
      and a.atthasdef
      and a.attidentity = ''
      and a.attgenerated = ''
      and (
        select pg_get_expr(d.adbin, d.adrelid)
        from pg_attrdef as d
        where d.adrelid = a.attrelid and d.adnum = a.attnum
      ) = 'false'
  ) then
    raise exception 'Schema conflict: public.chat_messages.is_pinned must be boolean NOT NULL DEFAULT false';
  end if;

  if not exists (
    select 1
    from pg_attribute as a
    where a.attrelid = 'public.chat_messages'::regclass
      and a.attname = 'pinned_at'
      and a.attnum > 0
      and not a.attisdropped
      and a.atttypid = 'pg_catalog.timestamptz'::regtype
      and a.atttypmod = -1
      and not a.attnotnull
      and not a.atthasdef
      and a.attidentity = ''
      and a.attgenerated = ''
  ) then
    raise exception 'Schema conflict: public.chat_messages.pinned_at must be timestamptz NULL without default';
  end if;

  if not exists (
    select 1
    from pg_attribute as a
    where a.attrelid = 'public.chat_messages'::regclass
      and a.attname = 'pinned_by'
      and a.attnum > 0
      and not a.attisdropped
      and a.atttypid = 'pg_catalog.uuid'::regtype
      and a.atttypmod = -1
      and not a.attnotnull
      and not a.atthasdef
      and a.attidentity = ''
      and a.attgenerated = ''
  ) then
    raise exception 'Schema conflict: public.chat_messages.pinned_by must be uuid NULL without default';
  end if;
end
$$;

do $$
declare
  v_constraint_oid oid;
begin
  select c.oid
  into v_constraint_oid
  from pg_constraint as c
  where c.conname = 'chat_messages_pinned_by_fkey'
    and c.conrelid = 'public.chat_messages'::regclass;

  if v_constraint_oid is null then
    alter table public.chat_messages
      add constraint chat_messages_pinned_by_fkey
      foreign key (pinned_by)
      references auth.users(id)
      on update no action
      on delete set null
      not deferrable;
  elsif not exists (
    select 1
    from pg_constraint as c
    where c.oid = v_constraint_oid
      and c.contype = 'f'
      and c.conkey = array[
        (select a.attnum from pg_attribute as a
         where a.attrelid = 'public.chat_messages'::regclass and a.attname = 'pinned_by')
      ]::smallint[]
      and c.confrelid = 'auth.users'::regclass
      and c.confkey = array[
        (select a.attnum from pg_attribute as a
         where a.attrelid = 'auth.users'::regclass and a.attname = 'id')
      ]::smallint[]
      and c.confupdtype = 'a'
      and c.confdeltype = 'n'
      and c.confmatchtype = 's'
      and not c.condeferrable
      and not c.condeferred
      and c.convalidated
  ) then
    raise exception 'Schema conflict: chat_messages_pinned_by_fkey does not match the expected FK to auth.users(id) ON DELETE SET NULL';
  end if;
end
$$;

do $$
declare
  v_index_oid oid;
  v_index_kind "char";
  v_index_matches boolean;
begin
  select c.oid, c.relkind
  into v_index_oid, v_index_kind
  from pg_class as c
  join pg_namespace as n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'idx_chat_messages_pinned_at';

  if v_index_oid is null then
    create index idx_chat_messages_pinned_at
      on public.chat_messages using btree (pinned_at desc)
      where (is_pinned = true);
  elsif v_index_kind <> 'i' then
    raise exception 'Schema conflict: public.idx_chat_messages_pinned_at exists but is not an index';
  else
    select exists (
      select 1
      from pg_index as i
      join pg_class as index_class on index_class.oid = i.indexrelid
      join pg_am as access_method on access_method.oid = index_class.relam
      where i.indexrelid = v_index_oid
        and i.indrelid = 'public.chat_messages'::regclass
        and access_method.amname = 'btree'
        and not i.indisunique
        and i.indnkeyatts = 1
        and i.indnatts = 1
        and i.indkey[0] = (
          select a.attnum from pg_attribute as a
          where a.attrelid = i.indrelid and a.attname = 'pinned_at'
        )
        and i.indexprs is null
        and (i.indoption[0] & 1) = 1
        and (i.indoption[0] & 2) = 2
        and i.indpred is not null
        and regexp_replace(
          lower(pg_get_expr(i.indpred, i.indrelid, false)),
          '[[:space:]()]', '', 'g'
        ) in ('is_pinned=true', 'true=is_pinned', 'is_pinned', 'is_pinnedistrue')
        and i.indisvalid
        and i.indisready
        and i.indislive
    )
    into v_index_matches;

    if not coalesce(v_index_matches, false) then
      raise exception 'Schema conflict: idx_chat_messages_pinned_at does not match the production structure';
    end if;
  end if;

  v_index_oid := null;
  v_index_kind := null;
  v_index_matches := null;

  select c.oid, c.relkind
  into v_index_oid, v_index_kind
  from pg_class as c
  join pg_namespace as n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'idx_chat_messages_single_pinned';

  if v_index_oid is null then
    create unique index idx_chat_messages_single_pinned
      on public.chat_messages using btree (is_pinned)
      where (is_pinned = true);
  elsif v_index_kind <> 'i' then
    raise exception 'Schema conflict: public.idx_chat_messages_single_pinned exists but is not an index';
  else
    select exists (
      select 1
      from pg_index as i
      join pg_class as index_class on index_class.oid = i.indexrelid
      join pg_am as access_method on access_method.oid = index_class.relam
      where i.indexrelid = v_index_oid
        and i.indrelid = 'public.chat_messages'::regclass
        and access_method.amname = 'btree'
        and i.indisunique
        and i.indnkeyatts = 1
        and i.indnatts = 1
        and i.indkey[0] = (
          select a.attnum from pg_attribute as a
          where a.attrelid = i.indrelid and a.attname = 'is_pinned'
        )
        and i.indexprs is null
        and (i.indoption[0] & 1) = 0
        and (i.indoption[0] & 2) = 0
        and i.indpred is not null
        and regexp_replace(
          lower(pg_get_expr(i.indpred, i.indrelid, false)),
          '[[:space:]()]', '', 'g'
        ) in ('is_pinned=true', 'true=is_pinned', 'is_pinned', 'is_pinnedistrue')
        and i.indisvalid
        and i.indisready
        and i.indislive
    )
    into v_index_matches;

    if not coalesce(v_index_matches, false) then
      raise exception 'Schema conflict: idx_chat_messages_single_pinned does not match the production structure';
    end if;
  end if;
end
$$;

create or replace function public.pin_class_chat_message(p_message_id uuid)
 returns chat_messages
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_message public.chat_messages;
begin
  if not public.is_admin() then
    raise exception 'Administrator access required';
  end if;

  -- Сначала снимаем старое закрепление, затем закрепляем выбранное сообщение.
  update public.chat_messages
  set is_pinned = false,
      pinned_at = null,
      pinned_by = null
  where is_pinned = true;

  update public.chat_messages
  set is_pinned = true,
      pinned_at = now(),
      pinned_by = auth.uid()
  where id = p_message_id
  returning * into v_message;

  if not found then
    raise exception 'Chat message not found';
  end if;

  return v_message;
end;
$function$;

create or replace function public.unpin_class_chat_message()
 returns void
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
begin
  if not public.is_admin() then
    raise exception 'Administrator access required';
  end if;

  update public.chat_messages
  set is_pinned = false,
      pinned_at = null,
      pinned_by = null
  where is_pinned = true;
end;
$function$;

revoke execute on function public.pin_class_chat_message(uuid) from public;
revoke execute on function public.pin_class_chat_message(uuid) from anon;
grant execute on function public.pin_class_chat_message(uuid) to authenticated;
grant execute on function public.pin_class_chat_message(uuid) to service_role;

revoke execute on function public.unpin_class_chat_message() from public;
revoke execute on function public.unpin_class_chat_message() from anon;
grant execute on function public.unpin_class_chat_message() to authenticated;
grant execute on function public.unpin_class_chat_message() to service_role;

commit;
