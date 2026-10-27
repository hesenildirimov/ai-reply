-- Photos / videos / voice messages: the note the AI and staff read ("[Şəkil: ...]", "[Səsli mesaj: "..."]"), stored
-- encrypted ("v1:" ciphertext, see src/media.ts). NULL = not analysed yet.
ALTER TABLE messages ADD COLUMN media_text text;

-- Media analysis calls are AI usage too (they count toward the AI budget).
ALTER TABLE ai_usage DROP CONSTRAINT ai_usage_purpose_check;
ALTER TABLE ai_usage ADD CONSTRAINT ai_usage_purpose_check CHECK (purpose IN ('reply', 'summary', 'style', 'test', 'media'));
