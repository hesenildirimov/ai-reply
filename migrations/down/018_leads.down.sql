-- Rollback for 018 (then DELETE FROM schema_migrations WHERE name = '018_leads.sql').
DROP TABLE IF EXISTS lead_notes;
DROP TABLE IF EXISTS leads;
