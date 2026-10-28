-- Rollback for 011 (then DELETE FROM schema_migrations WHERE name = '011_intake.sql').
DROP TABLE IF EXISTS inbound_outbox;
