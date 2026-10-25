-- Two-factor login (TOTP) — mandatory for admins.
ALTER TABLE users ADD COLUMN totp_secret_enc text;
ALTER TABLE users ADD COLUMN totp_enabled_at timestamptz;
ALTER TABLE users ADD COLUMN totp_last_step bigint NOT NULL DEFAULT 0; -- blocks code replay

-- More alert channels: WhatsApp (platform number) and browser push.
ALTER TABLE notify_targets DROP CONSTRAINT notify_targets_kind_check;
ALTER TABLE notify_targets ADD CONSTRAINT notify_targets_kind_check CHECK (kind IN ('telegram', 'whatsapp', 'webpush'));
ALTER TABLE notify_targets ADD COLUMN data_enc text; -- encrypted push subscription

-- Fingerprint of ENCRYPTION_KEY: refuse to start with a different key instead of silently breaking tokens.
CREATE TABLE app_meta (key text PRIMARY KEY, value text NOT NULL);
