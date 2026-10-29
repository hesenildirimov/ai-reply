import type { ChannelRow } from './channels/types.js';
import { one, q, tx } from './db.js';
import { openText, sealText } from './messages.js';
import { emit } from './webhooks.js';

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
  merged_into: string | null;
}

/**
 * Finds or creates the contact for a channel identity. If that contact was merged into another one, the surviving
 * contact is returned (it owns tags, fields, opt-out and conversations from then on).
 */
export async function upsertContact(ch: Pick<ChannelRow, 'id' | 'workspace_id'>, externalId: string, name = '', username = ''): Promise<ContactRow> {
  const row = (await one<ContactRow>(
    `INSERT INTO contacts (workspace_id, channel_id, external_id, display_name, username) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (channel_id, external_id) DO UPDATE SET last_seen_at = now(),
       display_name = CASE WHEN EXCLUDED.display_name <> '' THEN EXCLUDED.display_name ELSE contacts.display_name END,
       username = CASE WHEN EXCLUDED.username <> '' THEN EXCLUDED.username ELSE contacts.username END
     RETURNING *`,
    [ch.workspace_id, ch.id, externalId, name.slice(0, 200), username.slice(0, 100)],
  ))!;
  if (!row.merged_into) return row;
  return (await one<ContactRow>(`UPDATE contacts SET last_seen_at = now() WHERE id = $1 RETURNING *`, [row.merged_into])) ?? row;
}

/** Finds or creates the conversation for a contact (used when a flow starts from a comment, before any DM). */
export async function ensureConversation(ch: Pick<ChannelRow, 'id' | 'workspace_id'>, contact: ContactRow, externalId: string): Promise<string> {
  const row = await one<{ id: string }>(
    `INSERT INTO conversations (workspace_id, channel_id, external_user_id, display_name, contact_id) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (channel_id, external_user_id) DO UPDATE SET contact_id = EXCLUDED.contact_id RETURNING id`,
    [ch.workspace_id, ch.id, externalId, contact.username ? `@${contact.username}` : contact.display_name, contact.id],
  );
  return row!.id;
}

const tagIds = async (workspaceId: string, names: string[], create: boolean) => {
  const ids: string[] = [];
  for (const name of names.map((n) => n.trim()).filter(Boolean)) {
    const row = create
      ? await one(`INSERT INTO tags (workspace_id, name) VALUES ($1, $2) ON CONFLICT (workspace_id, lower(name)) DO UPDATE SET name = tags.name RETURNING id`, [
          workspaceId,
          name.slice(0, 40),
        ])
      : await one(`SELECT id FROM tags WHERE workspace_id = $1 AND lower(name) = lower($2)`, [workspaceId, name]);
    if (row) ids.push(row.id);
  }
  return ids;
};

export async function addTags(c: Pick<ContactRow, 'id' | 'workspace_id'>, names: string[]) {
  for (const id of await tagIds(c.workspace_id, names, true)) {
    const added = await one(
      `INSERT INTO contact_tags (contact_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING (SELECT name FROM tags WHERE id = $2) AS name`,
      [c.id, id],
    );
    if (added) await emit(c.workspace_id, 'contact.tag_added', { contact_id: c.id, tag: added.name });
  }
}

export async function removeTags(c: Pick<ContactRow, 'id' | 'workspace_id'>, names: string[]) {
  const ids = await tagIds(c.workspace_id, names, false);
  if (ids.length) await q(`DELETE FROM contact_tags WHERE contact_id = $1 AND tag_id = ANY($2)`, [c.id, ids]);
}

export async function hasTag(contactId: string, name: string): Promise<boolean> {
  return !!(await one(`SELECT 1 FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.contact_id = $1 AND lower(t.name) = lower($2)`, [
    contactId,
    name,
  ]));
}

export const FIELD_KEY = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * Custom field values (phone, address, order number...) are stored encrypted ("v1:..." strings inside the JSON);
 * the keys stay readable because they are the column names. Legacy plaintext values are sealed by maintenance.
 */
export const sealField = (value: string) => sealText(value);
export const openFields = (fields: Record<string, string> | null | undefined): Record<string, string> =>
  Object.fromEntries(Object.entries(fields ?? {}).map(([k, v]) => [k, openText(v)]));
export const sealFields = (fields: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, sealField(v)]));

export async function setField(contactId: string, key: string, value: string) {
  if (!FIELD_KEY.test(key)) throw new Error('invalid field key');
  // Cap the number of custom fields per contact.
  await q(
    `UPDATE contacts SET fields = fields || jsonb_build_object($2::text, $3::text) WHERE id = $1 AND (fields ? $2 OR (SELECT count(*) FROM jsonb_object_keys(fields)) < 50)`,
    [contactId, key, sealField(value.slice(0, 500))],
  );
}

/**
 * Merges `sourceId` into `targetId` (same workspace): conversations, runs and tags move to the target, fields are
 * combined (target wins on conflicts), opt-out/block are kept if either had them. The source row stays as an alias
 * so later messages from its channel identity land on the target.
 */
export async function mergeContacts(workspaceId: string, sourceId: string, targetId: string): Promise<boolean> {
  if (sourceId === targetId) return false;
  return tx(async (c) => {
    const rows = (
      await c.query(`SELECT * FROM contacts WHERE id = ANY($1) AND workspace_id = $2 AND merged_into IS NULL FOR UPDATE`, [[sourceId, targetId], workspaceId])
    ).rows;
    if (rows.length !== 2) return false;
    const src = rows.find((r) => r.id === sourceId)!;
    await c.query(
      `UPDATE contacts SET fields = $2::jsonb || fields, opted_out = opted_out OR $3, blocked = blocked OR $4,
         first_seen_at = least(first_seen_at, $5), last_seen_at = greatest(last_seen_at, $6),
         display_name = CASE WHEN display_name = '' THEN $7 ELSE display_name END, username = CASE WHEN username = '' THEN $8 ELSE username END
       WHERE id = $1`,
      [targetId, src.fields, src.opted_out, src.blocked, src.first_seen_at, src.last_seen_at, src.display_name, src.username],
    );
    await c.query(`INSERT INTO contact_tags (contact_id, tag_id) SELECT $2, tag_id FROM contact_tags WHERE contact_id = $1 ON CONFLICT DO NOTHING`, [
      sourceId,
      targetId,
    ]);
    await c.query(`DELETE FROM contact_tags WHERE contact_id = $1`, [sourceId]);
    await c.query(`UPDATE conversations SET contact_id = $2 WHERE contact_id = $1`, [sourceId, targetId]);
    await c.query(`UPDATE automation_runs SET contact_id = $2 WHERE contact_id = $1`, [sourceId, targetId]);
    // Aliases of the source now point straight at the target (no chains).
    await c.query(`UPDATE contacts SET merged_into = $2 WHERE merged_into = $1 OR id = $1`, [sourceId, targetId]);
    return true;
  });
}
