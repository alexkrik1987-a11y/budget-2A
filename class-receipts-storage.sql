-- =========================================================
-- БЮДЖЕТ 2 «А»: ЗАКРЫТОЕ ХРАНИЛИЩЕ ЧЕКОВ
-- Запускать после supabase.sql и archive-features.sql.
-- Скрипт затрагивает только Supabase Storage bucket class-receipts
-- и четыре связанные policy на storage.objects.
-- =========================================================

do $$
declare
  v_authenticated_oid oid;
  v_bucket_name text;
  v_bucket_public boolean;
  v_bucket_file_size_limit bigint;
  v_bucket_allowed_mime_types text[];
  v_expected_mime_types constant text[] := array[
    'image/jpeg',
    'image/png',
    'image/webp',
    'application/pdf'
  ]::text[];
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
  if to_regnamespace('storage') is null
     or to_regclass('storage.buckets') is null
     or to_regclass('storage.objects') is null then
    raise exception 'Storage conflict: required storage schema or tables do not exist';
  end if;

  if not exists (
    select 1
    from pg_class as relation
    where relation.oid = 'storage.buckets'::regclass
      and relation.relkind in ('r', 'p')
  ) or not exists (
    select 1
    from pg_class as relation
    where relation.oid = 'storage.objects'::regclass
      and relation.relkind in ('r', 'p')
      and relation.relrowsecurity
  ) then
    raise exception 'Storage conflict: storage tables or storage.objects RLS have an unexpected structure';
  end if;

  if not exists (
    select 1 from pg_attribute
    where attrelid = 'storage.buckets'::regclass
      and attname = 'id' and atttypid = 'pg_catalog.text'::regtype
      and attnum > 0 and not attisdropped
  ) or not exists (
    select 1 from pg_attribute
    where attrelid = 'storage.buckets'::regclass
      and attname = 'name' and atttypid = 'pg_catalog.text'::regtype
      and attnum > 0 and not attisdropped
  ) or not exists (
    select 1 from pg_attribute
    where attrelid = 'storage.buckets'::regclass
      and attname = 'public' and atttypid = 'pg_catalog.bool'::regtype
      and attnum > 0 and not attisdropped
  ) or not exists (
    select 1 from pg_attribute
    where attrelid = 'storage.buckets'::regclass
      and attname = 'file_size_limit' and atttypid = 'pg_catalog.int8'::regtype
      and attnum > 0 and not attisdropped
  ) or not exists (
    select 1 from pg_attribute
    where attrelid = 'storage.buckets'::regclass
      and attname = 'allowed_mime_types' and atttypid = 'pg_catalog.text[]'::regtype
      and attnum > 0 and not attisdropped
  ) or not exists (
    select 1 from pg_attribute
    where attrelid = 'storage.objects'::regclass
      and attname = 'bucket_id' and atttypid = 'pg_catalog.text'::regtype
      and attnum > 0 and not attisdropped
  ) then
    raise exception 'Storage conflict: required bucket or object columns have unexpected types';
  end if;

  if to_regprocedure('public.can_access_budget()') is null
     or to_regprocedure('public.is_admin()') is null then
    raise exception 'Storage conflict: required access functions do not exist';
  end if;

  select role.oid
  into v_authenticated_oid
  from pg_roles as role
  where role.rolname = 'authenticated';

  if v_authenticated_oid is null then
    raise exception 'Storage conflict: authenticated role does not exist';
  end if;

  select
    bucket.name,
    bucket.public,
    bucket.file_size_limit,
    bucket.allowed_mime_types
  into
    v_bucket_name,
    v_bucket_public,
    v_bucket_file_size_limit,
    v_bucket_allowed_mime_types
  from storage.buckets as bucket
  where bucket.id = 'class-receipts';

  if not found then
    insert into storage.buckets (
      id,
      name,
      public,
      file_size_limit,
      allowed_mime_types
    ) values (
      'class-receipts',
      'class-receipts',
      false,
      10485760,
      v_expected_mime_types
    );
  elsif v_bucket_name is distinct from 'class-receipts'
     or v_bucket_public is distinct from false
     or v_bucket_file_size_limit is distinct from 10485760
     or v_bucket_allowed_mime_types is null
     or cardinality(v_bucket_allowed_mime_types) <> cardinality(v_expected_mime_types)
     or not (
       v_bucket_allowed_mime_types @> v_expected_mime_types
       and v_bucket_allowed_mime_types <@ v_expected_mime_types
     ) then
    raise exception 'Storage conflict: bucket class-receipts has an unexpected definition';
  end if;

  for v_expected_policy in
    select *
    from (values
      (
        'Class members read receipts'::text,
        'r'::"char",
        'bucket_id=''class-receipts''andcan_access_budget'::text,
        null::text
      ),
      (
        'Admins upload receipts'::text,
        'a'::"char",
        null::text,
        'bucket_id=''class-receipts''andis_admin'::text
      ),
      (
        'Admins update receipts'::text,
        'w'::"char",
        'bucket_id=''class-receipts''andis_admin'::text,
        'bucket_id=''class-receipts''andis_admin'::text
      ),
      (
        'Admins delete receipts'::text,
        'd'::"char",
        'bucket_id=''class-receipts''andis_admin'::text,
        null::text
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
    where policy.polrelid = 'storage.objects'::regclass
      and policy.polname = v_expected_policy.policy_name;

    if v_policy_oid is null then
      case v_expected_policy.policy_name
        when 'Class members read receipts' then
          create policy "Class members read receipts"
          on storage.objects for select to authenticated
          using (bucket_id = 'class-receipts' and public.can_access_budget());
        when 'Admins upload receipts' then
          create policy "Admins upload receipts"
          on storage.objects for insert to authenticated
          with check (bucket_id = 'class-receipts' and public.is_admin());
        when 'Admins update receipts' then
          create policy "Admins update receipts"
          on storage.objects for update to authenticated
          using (bucket_id = 'class-receipts' and public.is_admin())
          with check (bucket_id = 'class-receipts' and public.is_admin());
        when 'Admins delete receipts' then
          create policy "Admins delete receipts"
          on storage.objects for delete to authenticated
          using (bucket_id = 'class-receipts' and public.is_admin());
      end case;

      continue;
    end if;

    v_normalized_qual := case
      when v_policy_qual is null then null
      else replace(
        replace(
          replace(
            regexp_replace(lower(v_policy_qual), '[[:space:]()]', '', 'g'),
            '"public".',
            ''
          ),
          'public.',
          ''
        ),
        '::text',
        ''
      )
    end;
    v_normalized_with_check := case
      when v_policy_with_check is null then null
      else replace(
        replace(
          replace(
            regexp_replace(lower(v_policy_with_check), '[[:space:]()]', '', 'g'),
            '"public".',
            ''
          ),
          'public.',
          ''
        ),
        '::text',
        ''
      )
    end;

    if not v_policy_permissive
       or v_policy_command <> v_expected_policy.policy_command
       or v_policy_roles <> array[v_authenticated_oid]
       or v_normalized_qual is distinct from v_expected_policy.policy_qual
       or v_normalized_with_check is distinct from v_expected_policy.policy_with_check
    then
      raise exception 'Storage conflict: policy "%" on storage.objects has an unexpected definition',
        v_expected_policy.policy_name;
    end if;
  end loop;
end
$$;
