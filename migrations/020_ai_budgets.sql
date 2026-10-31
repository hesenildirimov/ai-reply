-- AI budget caps below the plan price (a customer can never cost more than they pay): Biznes 79 AZN ≈ $46,
-- Pro 199 AZN ≈ $117. Expected cost at the full reply limit is ~$16 / ~$52; the caps leave room above that.
UPDATE plans SET limits = limits || '{"ai_budget_usd_month": 30, "ai_budget_usd_day": 3}' WHERE name = 'Biznes';
UPDATE plans SET limits = limits || '{"ai_budget_usd_month": 75, "ai_budget_usd_day": 8}' WHERE name = 'Pro';
