-- =========================================================
-- БЮДЖЕТ 2 «А»: PRIVATE REALTIME PRESENCE
-- Скрипт затрагивает только две policy на realtime.messages
-- для topic class:2a:presence и extension presence.
-- =========================================================

do $$
declare
  v_authenticated_oid oid;
  v_topic_function_oid oid;
  v_access_function_oid oid;
  v_policy_oid oid;
  v_policy_permissive boolean;
  v_policy_command "char";
  v_policy_roles oid[];
  v_policy_qual text;
  v_policy_with_check text;
  v_normalized_qual text;
  v_normalized_with_check text;
  v_expected_policy record;
begin
  if to_regnamespace('realtime') is null
     or to_regclass('realtime.messages') is null then
    raise exception 'Presence conflict: realtime.messages does not exist';
  end if;

  if not exists (
    select 1
    from pg_class as relation
    where relation.oid = 'realtime.messages'::regclass
      and relation.relkind = 'p'
      and relation.relrowsecurity
  ) then
    raise exception 'Presence conflict: realtime.messages must be an RLS-enabled partitioned table';
  end if;

  if not exists (
    select 1
    from pg_attribute as attribute
    where attribute.attrelid = 'realtime.messages'::regclass
      and attribute.attname = 'topic'
      and attribute.atttypid = 'pg_catalog.text'::regtype
      and attribute.atttypmod = -1
      and attribute.attnotnull
      and attribute.attnum > 0
      and not attribute.attisdropped
  ) or not exists (
    select 1
    from pg_attribute as attribute
    where attribute.attrelid = 'realtime.messages'::regclass
      and attribute.attname = 'extension'
      and attribute.atttypid = 'pg_catalog.text'::regtype
      and attribute.atttypmod = -1
      and attribute.attnotnull
      and attribute.attnum > 0
      and not attribute.attisdropped
  ) then
    raise exception 'Presence conflict: realtime.messages topic/extension columns have unexpected definitions';
  end if;

  select role.oid
  into v_authenticated_oid
  from pg_roles as role
  where role.rolname = 'authenticated';

  if v_authenticated_oid is null then
    raise exception 'Presence conflict: authenticated role does not exist';
  end if;

  v_topic_function_oid := to_regprocedure('realtime.topic()');
  if v_topic_function_oid is null
     or not exists (
       select 1
       from pg_proc as procedure
       where procedure.oid = v_topic_function_oid
         and procedure.prorettype = 'pg_catalog.text'::regtype
         and not procedure.prosecdef
     )
     or not has_function_privilege(v_authenticated_oid, v_topic_function_oid, 'EXECUTE') then
    raise exception 'Presence conflict: realtime.topic() has an unexpected definition or privileges';
  end if;

  v_access_function_oid := to_regprocedure('public.can_access_budget()');
  if v_access_function_oid is null
     or not exists (
       select 1
       from pg_proc as procedure
       where procedure.oid = v_access_function_oid
         and procedure.prorettype = 'pg_catalog.bool'::regtype
         and procedure.prosecdef
         and procedure.proconfig @> array['search_path=public']::text[]
     )
     or not has_function_privilege(v_authenticated_oid, v_access_function_oid, 'EXECUTE') then
    raise exception 'Presence conflict: public.can_access_budget() has an unexpected definition or privileges';
  end if;

  for v_expected_policy in
    select *
    from (values
      (
        'Approved class members listen to class presence'::text,
        'r'::"char",
        'topic=''class:2a:presence''andextension=''presence''andcan_access_budget'::text,
        null::text
      ),
      (
        'Approved class members track class presence'::text,
        'a'::"char",
        null::text,
        'topic=''class:2a:presence''andextension=''presence''andcan_access_budget'::text
      )
    ) as expected(policy_name, policy_command, policy_qual, policy_with_check)
  loop
    v_policy_oid := null;

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
    where policy.polrelid = 'realtime.messages'::regclass
      and policy.polname = v_expected_policy.policy_name;

    if v_policy_oid is null then
      case v_expected_policy.policy_name
        when 'Approved class members listen to class presence' then
          create policy "Approved class members listen to class presence"
          on realtime.messages for select to authenticated
          using (
            (select realtime.topic()) = 'class:2a:presence'
            and realtime.messages.extension = 'presence'
            and public.can_access_budget()
          );
        when 'Approved class members track class presence' then
          create policy "Approved class members track class presence"
          on realtime.messages for insert to authenticated
          with check (
            (select realtime.topic()) = 'class:2a:presence'
            and realtime.messages.extension = 'presence'
            and public.can_access_budget()
          );
      end case;

      continue;
    end if;

    v_normalized_qual := case
      when v_policy_qual is null then null
      else replace(
        replace(
          replace(
            replace(
              replace(
                replace(
                  replace(
                    replace(
                      regexp_replace(lower(v_policy_qual), '[[:space:]()]', '', 'g'),
                      '"', ''
                    ),
                    '::text', ''
                  ),
                  'realtime.messages.', ''
                ),
                'messages.', ''
              ),
              'realtime.', ''
            ),
            'public.', ''
          ),
          'select', ''
        ),
        'astopic', ''
      )
    end;
    v_normalized_with_check := case
      when v_policy_with_check is null then null
      else replace(
        replace(
          replace(
            replace(
              replace(
                replace(
                  replace(
                    replace(
                      regexp_replace(lower(v_policy_with_check), '[[:space:]()]', '', 'g'),
                      '"', ''
                    ),
                    '::text', ''
                  ),
                  'realtime.messages.', ''
                ),
                'messages.', ''
              ),
              'realtime.', ''
            ),
            'public.', ''
          ),
          'select', ''
        ),
        'astopic', ''
      )
    end;

    if not v_policy_permissive
       or v_policy_command <> v_expected_policy.policy_command
       or v_policy_roles <> array[v_authenticated_oid]
       or v_normalized_qual is distinct from v_expected_policy.policy_qual
       or v_normalized_with_check is distinct from v_expected_policy.policy_with_check
    then
      raise exception 'Presence conflict: policy "%" on realtime.messages has an unexpected definition',
        v_expected_policy.policy_name;
    end if;
  end loop;
end
$$;
