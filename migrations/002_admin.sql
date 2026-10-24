-- Accounts are created by the operator (no self-signup); payment is tracked manually.
ALTER TABLE users ADD COLUMN is_admin boolean NOT NULL DEFAULT false;
ALTER TABLE workspaces ADD COLUMN paid_until date;          -- NULL = no expiry
ALTER TABLE workspaces ADD COLUMN note text NOT NULL DEFAULT '';
