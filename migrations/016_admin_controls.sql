-- Two-person rule for deleting a customer (audit H-2): who asked, and when (the request expires after 24 hours).
ALTER TABLE workspaces ADD COLUMN delete_requested_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE workspaces ADD COLUMN delete_requested_at timestamptz;

-- Where the business sells (audit M-4): 'eu' = AI self-identification is mandatory (EU AI Act, Art. 50).
ALTER TABLE workspaces ADD COLUMN region text NOT NULL DEFAULT 'az' CHECK (region IN ('az', 'eu', 'other'));
