-- Rollback for 014 (then DELETE FROM schema_migrations WHERE name = '014_least_privilege.sql').
DROP INDEX IF EXISTS memberships_user_unique;
