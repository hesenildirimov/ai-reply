-- Rollback for 020 (then DELETE FROM schema_migrations WHERE name = '020_ai_budgets.sql').
UPDATE plans SET limits = limits || '{"ai_budget_usd_month": 50, "ai_budget_usd_day": 5}' WHERE name = 'Biznes';
UPDATE plans SET limits = limits || '{"ai_budget_usd_month": 200, "ai_budget_usd_day": 20}' WHERE name = 'Pro';
