-- Rollback for 017 (then DELETE FROM schema_migrations WHERE name = '017_plan_limits.sql').
ALTER TABLE assistants DROP COLUMN IF EXISTS media_model;
UPDATE plans SET limits = limits - 'ai_replies_month' - 'knowledge_mb';
UPDATE workspaces SET monthly_reply_limit = 1000 WHERE monthly_reply_limit IS NULL;
ALTER TABLE workspaces ALTER COLUMN monthly_reply_limit SET NOT NULL;
