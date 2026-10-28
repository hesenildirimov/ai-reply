import { z } from 'zod';
import { one, q } from '../db.js';
import { openBody, openRows, openText, queryTokens, sealText, withNote } from '../messages.js';
import { limitsOf } from '../plans.js';

/** Inbox data access: every query behind the inbox screens. Rows come back with message text decrypted. */

export const filterSchema = z.object({
  f: z.enum(['all', 'unread', 'open', 'closed', 'mine', 'unassigned', 'waiting']).catch('open').default('open'),
  ch: z.enum(['', 'instagram', 'whatsapp']).catch('').default(''),
  tag: z
    .union([z.literal(''), z.uuid()])
    .catch('')
    .default(''),
  auto: z
    .union([z.literal(''), z.uuid()])
    .catch('')
    .default(''),
  q: z.string().trim().max(100).catch('').default(''),
  before: z
    .string()
    .regex(/^\d{4}-\d\d-\d\dT[\d:.]+Z_[0-9a-f-]{36}$/)
    .or(z.literal(''))
    .catch('')
    .default(''),
});
export type Filters = z.infer<typeof filterSchema>;
const PAGE = 40;

const CONV_LIST_SQL = `SELECT c.id, c.display_name, c.external_user_id, c.needs_human, c.status, c.unread_count, c.assignee_user_id, c.contact_id,
    coalesce(c.ai_paused_until > now(), false) AS paused, c.last_message_at, ch.type, coalesce(ct.username, '') AS username, u.email AS assignee_email,
    lm.body AS last, lm.enc AS last_enc, lm.media_text AS last_note, lm.sender AS last_sender
  FROM conversations c JOIN channels ch ON ch.id = c.channel_id
  LEFT JOIN contacts ct ON ct.id = c.contact_id
  LEFT JOIN users u ON u.id = c.assignee_user_id
  LEFT JOIN LATERAL (SELECT body, enc, media_text, sender FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) lm ON true
  WHERE c.workspace_id = $1`;

/** Decrypts the last-message preview of list rows. */
const openLast = <T extends { last?: string | null; last_enc?: boolean; last_note?: string | null }>(rows: T[]): T[] => {
  for (const r of rows) if (r.last) r.last = withNote(openBody({ body: r.last, enc: r.last_enc }), openText(r.last_note));
  return rows;
};

/** One page of the conversation list for the filters; `next` is the cursor of the following page ('' = last page). */
export async function listConversations(workspaceId: string, userId: string, f: Filters) {
  const params: unknown[] = [workspaceId];
  const p = (v: unknown) => `$${params.push(v)}`;
  const where: string[] = [];
  if (f.f === 'unread') where.push('c.unread_count > 0');
  if (f.f === 'open') where.push(`c.status = 'open'`);
  if (f.f === 'closed') where.push(`c.status = 'closed'`);
  if (f.f === 'mine') where.push(`c.assignee_user_id = ${p(userId)}`);
  if (f.f === 'unassigned') where.push(`c.assignee_user_id IS NULL AND c.status = 'open'`);
  if (f.f === 'waiting') where.push('c.needs_human');
  if (f.ch) where.push(`ch.type = ${p(f.ch)}`);
  if (f.tag) where.push(`EXISTS (SELECT 1 FROM contact_tags x WHERE x.contact_id = c.contact_id AND x.tag_id = ${p(f.tag)})`);
  if (f.auto) where.push(`EXISTS (SELECT 1 FROM automation_runs r WHERE r.conversation_id = c.id AND r.automation_id = ${p(f.auto)})`);
  if (f.q) {
    const like = p(`%${f.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
    // Message text is encrypted: it is searched through its blind index (words and word beginnings, see messages.ts).
    const groups = queryTokens(f.q);
    const inText = groups.length
      ? `EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND ${groups.map((g) => `m.search_tokens && ${p(g)}::text[]`).join(' AND ')})`
      : 'false';
    where.push(`((coalesce(ct.display_name, '') || ' ' || coalesce(ct.username, '') || ' ' || c.display_name) ILIKE ${like} OR ${inText})`);
  }
  const hist = (await limitsOf(workspaceId)).history_days;
  if (hist) where.push(`c.last_message_at > now() - make_interval(days => ${p(hist)})`);
  if (f.before) {
    const [t, id] = f.before.split('_');
    where.push(`(c.last_message_at, c.id) < (${p(t)}::timestamptz, ${p(id)}::uuid)`);
  }
  const rows = openLast(
    await q(`${CONV_LIST_SQL} ${where.map((w) => `AND ${w}`).join(' ')} ORDER BY c.last_message_at DESC, c.id DESC LIMIT ${PAGE + 1}`, params),
  );
  const more = rows.length > PAGE;
  return { rows: rows.slice(0, PAGE), next: more ? `${new Date(rows[PAGE - 1].last_message_at).toISOString()}_${rows[PAGE - 1].id}` : '' };
}

/** Open conversations waiting for staff first (dashboard). */
export const urgentConversations = async (workspaceId: string, limit = 5) =>
  openLast(await q(`${CONV_LIST_SQL} AND c.status = 'open' ORDER BY c.needs_human DESC, c.last_message_at DESC LIMIT ${limit}`, [workspaceId]));

/** Badge counts for the inbox tabs. */
export const tabCounts = (workspaceId: string, userId: string) =>
  one(
    `SELECT count(*) FILTER (WHERE unread_count > 0)::int AS unread, count(*) FILTER (WHERE status = 'open')::int AS open,
            count(*) FILTER (WHERE assignee_user_id = $2 AND status = 'open')::int AS mine,
            count(*) FILTER (WHERE assignee_user_id IS NULL AND status = 'open')::int AS unassigned, count(*) FILTER (WHERE needs_human)::int AS waiting
     FROM conversations WHERE workspace_id = $1`,
    [workspaceId, userId],
  );

/** Tag and automation choices for the list filters. */
export const filterChoices = (workspaceId: string) =>
  Promise.all([
    q(`SELECT id, name FROM tags WHERE workspace_id = $1 ORDER BY name LIMIT 100`, [workspaceId]),
    q(`SELECT id, name FROM automations WHERE workspace_id = $1 ORDER BY name LIMIT 100`, [workspaceId]),
  ]).then(([tags, automations]) => ({ tags, automations }));

/** A conversation of this workspace with its channel and contact, or undefined (tenant check). */
export const loadConversation = (workspaceId: string, id: string) =>
  one(
    `SELECT c.*, coalesce(c.ai_paused_until > now(), false) AS paused, ch.type, ch.status AS channel_status, ch.display_name AS channel_name,
            ct.username, ct.display_name AS contact_name, ct.fields, ct.opted_out, ct.blocked, ct.first_seen_at, ct.last_seen_at
     FROM conversations c JOIN channels ch ON ch.id = c.channel_id LEFT JOIN contacts ct ON ct.id = c.contact_id
     WHERE c.id = $1 AND c.workspace_id = $2`,
    [id, workspaceId],
  );

export const markRead = (conversationId: string) => q(`UPDATE conversations SET unread_count = 0 WHERE id = $1 AND unread_count > 0`, [conversationId]);

/** Messages (newest 150) and internal notes (newest 50) of a conversation, merged in time order. */
export async function threadItems(conversationId: string) {
  const [msgs, notes] = await Promise.all([
    q(
      `SELECT * FROM (SELECT id, sender, body, enc, media_text, created_at, status, kind, media, payload, error FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 150) t ORDER BY created_at`,
      [conversationId],
    ).then((rows) => openRows(rows).map(({ media_text, ...m }) => ({ ...m, note: openText(media_text) }))),
    q(
      `SELECT n.body, n.created_at, u.email FROM conversation_notes n LEFT JOIN users u ON u.id = n.user_id WHERE n.conversation_id = $1 ORDER BY n.created_at DESC LIMIT 50`,
      [conversationId],
    ).then((rows) => rows.map((n) => ({ ...n, body: openText(n.body) }))),
  ]);
  return [...msgs.map((m) => ({ t: new Date(m.created_at).getTime(), m })), ...notes.map((n) => ({ t: new Date(n.created_at).getTime(), n }))].sort(
    (a, b) => a.t - b.t,
  );
}
export type ThreadItem = Awaited<ReturnType<typeof threadItems>>[number];

/** Contact panel: tags, the workspace's tag names (autocomplete), recent automation runs, message stats. */
export async function profileData(c: { id: string; contact_id: string; workspace_id: string }) {
  const [tags, allTags, runs, stats] = await Promise.all([
    q(`SELECT t.id, t.name FROM contact_tags x JOIN tags t ON t.id = x.tag_id WHERE x.contact_id = $1 ORDER BY t.name`, [c.contact_id]),
    q(`SELECT name FROM tags WHERE workspace_id = $1 ORDER BY name LIMIT 100`, [c.workspace_id]),
    q(
      `SELECT a.name, a.id, r.status, r.matched_at FROM automation_runs r JOIN automations a ON a.id = r.automation_id WHERE r.contact_id = $1 ORDER BY r.matched_at DESC LIMIT 8`,
      [c.contact_id],
    ),
    one(`SELECT count(*)::int AS n, min(created_at) AS first FROM messages WHERE conversation_id = $1`, [c.id]),
  ]);
  return { tags, allTags, runs, stats: stats! };
}
export type ProfileData = Awaited<ReturnType<typeof profileData>>;

/** Conversation pane: members it can be assigned to, saved replies. */
export async function paneData(workspaceId: string) {
  const [members, saved] = await Promise.all([
    assignableMembers(workspaceId),
    q(`SELECT title, body FROM saved_replies WHERE workspace_id = $1 ORDER BY title LIMIT 50`, [workspaceId]),
  ]);
  return { members, saved };
}
export type PaneData = Awaited<ReturnType<typeof paneData>>;

/** Analysts only read analytics: everyone else can be assigned. */
const assignableMembers = (workspaceId: string) =>
  q(`SELECT u.id, u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 AND m.role <> 'analyst' ORDER BY u.email`, [
    workspaceId,
  ]);

export const isAssignable = async (workspaceId: string, userId: string) =>
  !!(await one(`SELECT 1 FROM memberships WHERE workspace_id = $1 AND user_id = $2 AND role <> 'analyst'`, [workspaceId, userId]));

// ---------- Changes (callers have checked the conversation / contact belongs to the workspace) ----------

export const ownedConversation = (workspaceId: string, id: string) =>
  one<{ id: string; workspace_id: string; contact_id: string | null }>(
    `SELECT id, workspace_id, contact_id FROM conversations WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId],
  );
export const ownedContact = (workspaceId: string, id: string) =>
  one<{ id: string; workspace_id: string }>(`SELECT id, workspace_id FROM contacts WHERE id = $1 AND workspace_id = $2`, [id, workspaceId]);

/** Staff answered: the customer no longer waits for a human. */
export const clearWaiting = (conversationId: string) => q('UPDATE conversations SET needs_human = false WHERE id = $1', [conversationId]);

export const addNote = (workspaceId: string, conversationId: string, userId: string, body: string) =>
  q(`INSERT INTO conversation_notes (workspace_id, conversation_id, user_id, body) VALUES ($1, $2, $3, $4)`, [
    workspaceId,
    conversationId,
    userId,
    sealText(body),
  ]);

/** Closing also clears "waiting for staff". */
export const setStatus = (conversationId: string, status: 'open' | 'closed') =>
  q(`UPDATE conversations SET status = $2, needs_human = CASE WHEN $2 = 'closed' THEN false ELSE needs_human END WHERE id = $1`, [conversationId, status]);

/** Assigning to a person makes the bot stay silent in that conversation (operator handover). */
export const assign = (conversationId: string, userId: string | null) =>
  q(`UPDATE conversations SET assignee_user_id = $2, status = 'open' WHERE id = $1`, [conversationId, userId]);

/** Resume = bot answers again (also after a handoff); pause = 30 days of silence. */
export const setBot = (conversationId: string, resume: boolean) =>
  q(
    resume
      ? 'UPDATE conversations SET needs_human = false, ai_paused_until = NULL WHERE id = $1'
      : `UPDATE conversations SET ai_paused_until = now() + interval '30 days' WHERE id = $1`,
    [conversationId],
  );

export const deleteConversation = (conversationId: string) => q('DELETE FROM conversations WHERE id = $1', [conversationId]);

/** The contact's most recent conversation (to refresh it after a contact edit). */
export const latestConversationOf = (contactId: string) =>
  one<{ id: string; workspace_id: string }>(`SELECT id, workspace_id FROM conversations WHERE contact_id = $1 ORDER BY last_message_at DESC LIMIT 1`, [
    contactId,
  ]);

export const deleteContactField = (contactId: string, key: string) => q(`UPDATE contacts SET fields = fields - $2 WHERE id = $1`, [contactId, key]);

/** At most 50 custom fields per contact (an existing key can always be overwritten). */
export const setContactField = (contactId: string, key: string, value: string) =>
  q(
    `UPDATE contacts SET fields = fields || jsonb_build_object($2::text, $3::text) WHERE id = $1 AND (fields ? $2 OR (SELECT count(*) FROM jsonb_object_keys(fields)) < 50)`,
    [contactId, key, value],
  );

export const setContactFlag = (contactId: string, flag: 'opted_out' | 'blocked', value: boolean) =>
  q(flag === 'opted_out' ? `UPDATE contacts SET opted_out = $2 WHERE id = $1` : `UPDATE contacts SET blocked = $2 WHERE id = $1`, [contactId, value]);

/** Media items of a message with its channel credentials (WhatsApp media needs an authenticated download). */
export const messageMedia = (workspaceId: string, messageId: string) =>
  one(
    `SELECT m.media, ch.access_token_enc, ch.type FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN channels ch ON ch.id = c.channel_id WHERE m.id = $1 AND m.workspace_id = $2`,
    [messageId, workspaceId],
  );

// ---------- Saved replies ----------

export const savedReplies = (workspaceId: string) => q(`SELECT id, title, body FROM saved_replies WHERE workspace_id = $1 ORDER BY title`, [workspaceId]);
export const addSavedReply = (workspaceId: string, userId: string, title: string, body: string) =>
  q(`INSERT INTO saved_replies (workspace_id, title, body, created_by) VALUES ($1, $2, $3, $4)`, [workspaceId, title, body, userId]);
export const deleteSavedReply = (workspaceId: string, id: string) => q(`DELETE FROM saved_replies WHERE id = $1 AND workspace_id = $2`, [id, workspaceId]);
