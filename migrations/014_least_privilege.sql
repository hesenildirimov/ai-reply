-- One user belongs to exactly one workspace; the session lookup (JOIN memberships ... LIMIT 1) relies on it.
-- Fails loudly if a duplicate exists: check first with
--   SELECT user_id, count(*) FROM memberships GROUP BY 1 HAVING count(*) > 1;
CREATE UNIQUE INDEX memberships_user_unique ON memberships (user_id);

-- The app role reads and writes data only; which migrations ran is the migration owner's business.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') AND to_regclass('schema_migrations') IS NOT NULL THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON schema_migrations FROM app_rw;
  END IF;
END $$;
