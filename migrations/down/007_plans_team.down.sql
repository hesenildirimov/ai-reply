-- Rollback for 007 (then DELETE FROM schema_migrations WHERE name = '007_plans_team.sql').
ALTER TABLE memberships DROP COLUMN IF EXISTS created_at;
DELETE FROM memberships WHERE role IN ('admin', 'analyst');
ALTER TABLE memberships DROP CONSTRAINT memberships_role_check;
ALTER TABLE memberships ADD CONSTRAINT memberships_role_check CHECK (role IN ('owner', 'agent'));
ALTER TABLE workspaces ADD COLUMN plan text NOT NULL DEFAULT 'trial';
ALTER TABLE workspaces DROP COLUMN IF EXISTS limit_overrides, DROP COLUMN IF EXISTS plan_id;
DROP TABLE IF EXISTS plans;
