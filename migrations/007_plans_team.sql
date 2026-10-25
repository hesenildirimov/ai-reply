-- P4 foundations: configurable plans with limits, team roles, invites.
CREATE TABLE plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  -- null value = unlimited. Keys: contacts, channels, active_automations, members, bot_messages_month,
  -- ai_budget_usd_month, ai_budget_usd_day, history_days
  limits jsonb NOT NULL DEFAULT '{}',
  price_note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO plans (name, limits, price_note) VALUES
  ('Start',  '{"contacts": 1000,  "channels": 1, "active_automations": 3,  "members": 1,  "bot_messages_month": 2000,  "ai_budget_usd_month": 10,  "ai_budget_usd_day": 1,  "history_days": 30}',  '29 AZN/ay'),
  ('Biznes', '{"contacts": 10000, "channels": 3, "active_automations": 20, "members": 5,  "bot_messages_month": 20000, "ai_budget_usd_month": 50,  "ai_budget_usd_day": 5,  "history_days": 90}',  '79 AZN/ay'),
  ('Pro',    '{"contacts": null,  "channels": 10, "active_automations": null, "members": 20, "bot_messages_month": null, "ai_budget_usd_month": 200, "ai_budget_usd_day": 20, "history_days": 365}', '199 AZN/ay');
ALTER TABLE workspaces ADD COLUMN plan_id uuid REFERENCES plans(id);
UPDATE workspaces SET plan_id = (SELECT id FROM plans WHERE name = 'Biznes');
-- Per-workspace overrides on top of the plan (same keys), set by the platform admin.
ALTER TABLE workspaces ADD COLUMN limit_overrides jsonb NOT NULL DEFAULT '{}';
ALTER TABLE workspaces DROP COLUMN plan;

ALTER TABLE memberships DROP CONSTRAINT memberships_role_check;
ALTER TABLE memberships ADD CONSTRAINT memberships_role_check CHECK (role IN ('owner', 'admin', 'agent', 'analyst'));
ALTER TABLE memberships ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
