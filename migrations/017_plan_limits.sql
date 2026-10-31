-- AI replies per month come from the plan (audit of the business flow): a new customer no longer gets a flat 1 000.
-- workspaces.monthly_reply_limit NULL = "from the plan"; a number = a custom limit set by the platform admin.
ALTER TABLE workspaces ALTER COLUMN monthly_reply_limit DROP NOT NULL;
ALTER TABLE workspaces ALTER COLUMN monthly_reply_limit DROP DEFAULT;
UPDATE plans SET limits = limits || '{"ai_replies_month": 1500, "knowledge_mb": 10}' WHERE name = 'Start';
UPDATE plans SET limits = limits || '{"ai_replies_month": 6000, "knowledge_mb": 20}' WHERE name = 'Biznes';
UPDATE plans SET limits = limits || '{"ai_replies_month": 20000, "knowledge_mb": 40}' WHERE name = 'Pro';

-- Which model looks at photos and video frames: 'fast' (cheap, default) or 'smart' (reads small print better).
ALTER TABLE assistants ADD COLUMN media_model text NOT NULL DEFAULT 'fast' CHECK (media_model IN ('fast', 'smart'));
