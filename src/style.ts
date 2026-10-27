import { learnStyleGuide } from './ai.js';
import { instagramOwnMessages } from './channels/instagram.js';
import { decrypt } from './crypto.js';
import { one, q } from './db.js';
import { openRows } from './messages.js';

const MIN_SAMPLES = 5;
const MAX_SAMPLES = 150;
const MAX_CHARS = 12_000; // keeps the one-off learning call cheap

/** Learns the business's writing style from staff replies we stored plus recent Instagram history. */
export async function learnStyle(workspaceId: string): Promise<'ok' | 'not_enough'> {
  const stored = openRows(
    await q<{ body: string; enc: boolean }>(`SELECT body, enc FROM messages WHERE workspace_id = $1 AND sender = 'human' ORDER BY created_at DESC LIMIT $2`, [
      workspaceId,
      MAX_SAMPLES,
    ]),
  );
  const samples = stored.map((m) => m.body);
  for (const ch of await q(`SELECT external_id, access_token_enc FROM channels WHERE workspace_id = $1 AND type = 'instagram' AND status = 'active'`, [
    workspaceId,
  ])) {
    samples.push(...(await instagramOwnMessages(decrypt(ch.access_token_enc), ch.external_id).catch(() => [])));
  }
  const picked: string[] = [];
  let chars = 0;
  for (const s of new Set(samples.map((x) => x.trim()).filter((x) => x.length >= 2 && x.length <= 400))) {
    if (picked.length >= MAX_SAMPLES || chars + s.length > MAX_CHARS) break;
    picked.push(s);
    chars += s.length;
  }
  if (picked.length < MIN_SAMPLES) return 'not_enough';
  const guide = await learnStyleGuide(picked, { workspaceId, purpose: 'style' });
  if (!guide) return 'not_enough';
  await q('UPDATE assistants SET style_guide = $2, style_learned_at = now() WHERE workspace_id = $1', [workspaceId, guide]);
  return 'ok';
}

export const styleStatus = (workspaceId: string) => one('SELECT style_guide, style_learned_at FROM assistants WHERE workspace_id = $1', [workspaceId]);
