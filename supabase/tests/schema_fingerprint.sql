\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

WITH schema_components AS (
  SELECT
    'relation' AS kind,
    c.relname AS object_name,
    concat_ws('|', c.relkind, c.relrowsecurity, c.relforcerowsecurity) AS definition
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S')

  UNION ALL

  SELECT
    'column',
    c.relname || '.' || a.attname,
    concat_ws(
      '|',
      a.attnum,
      pg_catalog.format_type(a.atttypid, a.atttypmod),
      a.attnotnull,
      pg_get_expr(d.adbin, d.adrelid),
      col_description(c.oid, a.attnum)
    )
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p', 'v', 'm')
    AND a.attnum > 0
    AND NOT a.attisdropped

  UNION ALL

  SELECT 'constraint', con.conname, pg_get_constraintdef(con.oid, true)
  FROM pg_constraint con
  JOIN pg_namespace n ON n.oid = con.connamespace
  WHERE n.nspname = 'public'

  UNION ALL

  SELECT 'index', c.relname, pg_get_indexdef(c.oid)
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'i'

  UNION ALL

  SELECT
    'function',
    p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
    regexp_replace(pg_get_functiondef(p.oid), '[[:space:]]+', ' ', 'g')
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'

  UNION ALL

  SELECT
    'grant',
    table_name || '.' || grantee || '.' || privilege_type,
    is_grantable
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public'

  UNION ALL

  SELECT
    'policy',
    schemaname || '.' || tablename || '.' || policyname,
    concat_ws('|', permissive, roles::text, cmd, qual, with_check)
  FROM pg_policies
  WHERE schemaname = 'public'

  UNION ALL

  SELECT 'trigger', c.relname || '.' || t.tgname, pg_get_triggerdef(t.oid, true)
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND NOT t.tgisinternal

  UNION ALL

  SELECT 'view', c.relname, pg_get_viewdef(c.oid, true)
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('v', 'm')
)
SELECT
  kind || '=' ||
  md5(
    string_agg(object_name || '|' || coalesce(definition, ''), E'\n'
      ORDER BY object_name, definition)
  ) || ' components=' || count(*)
FROM schema_components
GROUP BY kind

UNION ALL

SELECT
  'all=' ||
  md5(
    string_agg(kind || '|' || object_name || '|' || coalesce(definition, ''), E'\n'
      ORDER BY kind, object_name, definition)
  ) || ' components=' || count(*)
FROM schema_components
ORDER BY 1;
