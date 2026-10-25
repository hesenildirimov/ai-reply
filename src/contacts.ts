import type { ChannelRow } from './channels/types.js';
import { one, q } from './db.js';

export interface ContactRow {
  id: string;
  workspace_id: string;
  channel_id: string;
  external_id: string;
  display_name: string;
  username: string;
  fields: Record<string, string>;
  opted_out: boolean;
  blocked: boolean;
}

export async function upsertContact(ch: Pick<ChannelRow, 'id' | 'workspace_id'>, externalId: string, name = '', username = ''): Promise<ContactRow> {
  return (await one<ContactRow>(
    `INSERT INTO contacts (workspace_id, channel_id, external_id, display_name, username) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (channel_id, external_id) DO UPDATE SET last_seen_at = now(),
       display_name = CASE WHEN EXCLUDED.display_name <> '' THEN EXCLUDED.display_name ELSE contacts.display_name END,
       username = CASE WHEN EXCLUDED.username <> '' THEN EXCLUDED.username ELSE contacts.username END
     RETURNING *`,
    [ch.workspace_id, ch.id, externalId, name.slice(0, 200), username.slice(0, 100)],
  ))!;
}

/** Finds or creates the conversation for a contact (used when a flow starts from a comment, before any DM). */
export async function ensureConversation(ch: Pick<ChannelRow, 'id' | 'workspace_id'>, contact: ContactRow): Promise<string> {
  const row = await one<{ id: string }>(
    `INSERT INTO conversations (workspace_id, channel_id, external_user_id, display_name, contact_id) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (channel_id, external_user_id) DO UPDATE SET contact_id = EXCLUDED.contact_id RETURNING id`,
    [ch.workspace_id, ch.id, contact.external_id, contact.username ? `@${contact.username}` : contact.display_name, contact.id],
  );
  return row!.id;
}

const tagIds = async (workspaceId: string, names: string[], create: boolean) => {
  const ids: string[] = [];
  for (const name of names.map((n) => n.trim()).filter(Boolean)) {
    const row = create
      ? await one(`INSERT INTO tags (workspace_id, name) VALUES ($1, $2) ON CONFLICT (workspace_id, lower(name)) DO UPDATE SET name = tags.name RETURNING id`, [workspaceId, name.slice(0, 40)])
      : await one(`SELECT id FROM tags WHERE workspace_id = $1 AND lower(name) = lower($2)`, [workspaceId, name]);
    if (row) ids.push(row.id);
  }
  return ids;
};

export async function addTags(c: Pick<ContactRow, 'id' | 'workspace_id'>, names: string[]) {
  for (const id of await tagIds(c.workspace_id, names, true)) await q(`INSERT INTO contact_tags (contact_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [c.id, id]);
}

export async function removeTags(c: Pick<ContactRow, 'id' | 'workspace_id'>, names: string[]) {
  const ids = await tagIds(c.workspace_id, names, false);
  if (ids.length) await q(`DELETE FROM contact_tags WHERE contact_id = $1 AND tag_id = ANY($2)`, [c.id, ids]);
}

export async function hasTag(contactId: string, name: string): Promise<boolean> {
  return !!(await one(`SELECT 1 FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.contact_id = $1 AND lower(t.name) = lower($2)`, [contactId, name]));
}

export const FIELD_KEY = /^[a-z][a-z0-9_]{0,39}$/;

export async function setField(contactId: string, key: string, value: string) {
  if (!FIELD_KEY.test(key)) throw new Error('invalid field key');
  // Cap the number of custom fields per contact.
  await q(`UPDATE contacts SET fields = fields || jsonb_build_object($2::text, $3::text) WHERE id = $1 AND (fields ? $2 OR (SELECT count(*) FROM jsonb_object_keys(fields)) < 50)`, [contactId, key, value.slice(0, 500)]);
}
