import type { ChannelRow, InboundEvent } from '../channels/types.js';
import { replyToComment } from '../channels/instagram.js';
import { automationBlocked, limitAlert } from '../plans.js';
import { emit } from '../webhooks.js';
import { addTags, ensureConversation, hasTag, removeTags, setField, upsertContact, type ContactRow } from '../contacts.js';
import { deliver, handoff, inWindow, loadConv, type ConvCtx } from '../conversation.js';
import { decrypt } from '../crypto.js';
import { one, q } from '../db.js';
import { queue } from '../queue.js';
import { trackLinks } from '../links.js';
import { capability } from './capabilities.js';
import { configSchema, type AutomationConfig, type Trigger } from './schema.js';

export { normalize } from '../text.js';
import { normalize } from '../text.js';

const containsPhrase = (hay: string, kw: string) => ` ${hay} `.includes(` ${kw} `);

export function matches(m: AutomationConfig['match'], text: string): boolean {
  const t = normalize(text);
  if (m.exclude.some((k) => containsPhrase(t, normalize(k)))) return false;
  if (m.mode === 'anything') return true;
  const kws = m.keywords.map(normalize).filter(Boolean);
  if (!kws.length) return false;
  if (m.mode === 'exact') return kws.includes(t);
  if (m.mode === 'all') return kws.every((k) => containsPhrase(t, k));
  return kws.some((k) => containsPhrase(t, k));
}

export interface AutomationRow {
  id: string;
  workspace_id: string;
  channel_id: string | null;
  name: string;
  trigger: Trigger;
  status: 'draft' | 'active' | 'paused';
  config: AutomationConfig;
  version: number;
}

/** Active, in-schedule automations for a trigger on a channel, highest priority first. */
export async function activeAutomations(workspaceId: string, channelId: string, trigger: Trigger): Promise<AutomationRow[]> {
  return q<AutomationRow>(
    `SELECT * FROM automations WHERE workspace_id = $1 AND trigger = $2 AND status = 'active' AND (channel_id IS NULL OR channel_id = $3)
       AND (starts_at IS NULL OR starts_at <= now()) AND (ends_at IS NULL OR ends_at > now())
     ORDER BY priority, created_at`,
    [workspaceId, trigger, channelId],
  );
}

interface RunRow {
  id: string;
  automation_id: string;
  version: number;
  contact_id: string | null;
  conversation_id: string | null;
  steps: unknown[];
  sent_at: Date | null;
}

/** Creates the run once per (automation, trigger ref). Returns null if this event already ran (duplicate webhook/job). */
async function startRun(a: AutomationRow, triggerRef: string, contactId: string, conversationId: string | null): Promise<RunRow | null> {
  return (
    (await one<RunRow>(
      `INSERT INTO automation_runs (workspace_id, automation_id, version, contact_id, conversation_id, trigger_ref, status, attempted_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'running', now()) ON CONFLICT (automation_id, trigger_ref) DO NOTHING RETURNING *`,
      [a.workspace_id, a.id, a.version, contactId, conversationId, triggerRef],
    )) ?? null
  );
}

const logStep = (runId: string, entry: Record<string, unknown>) =>
  q(`UPDATE automation_runs SET steps = steps || $2::jsonb WHERE id = $1`, [runId, JSON.stringify([{ ...entry, at: new Date().toISOString() }])]);

async function finish(runId: string, status: 'sent' | 'failed' | 'skipped', reason = '') {
  const r = await one(
    `UPDATE automation_runs SET status = CASE WHEN status = 'sent' AND $2 <> 'failed' THEN 'sent' ELSE $2 END, reason = $3 WHERE id = $1
     RETURNING workspace_id, automation_id, contact_id, conversation_id, status, reason`,
    [runId, status, reason.slice(0, 200)],
  );
  if (r) await emit(r.workspace_id, 'automation.run_finished', { run_id: runId, automation_id: r.automation_id, contact_id: r.contact_id, conversation_id: r.conversation_id, status: r.status, reason: r.reason });
}

export type StepOutcome = 'done' | 'ai' | 'handoff' | 'delayed' | 'failed';

/**
 * Executes steps from `start`. Sends are idempotent per (run, step) so a retried job never repeats a message.
 * commentId: the run started from a comment -> its single message step is sent as a Meta private reply.
 */
export async function executeSteps(run: RunRow, cfg: AutomationConfig, start: number, conv: ConvCtx, contact: ContactRow, commentId?: string): Promise<StepOutcome> {
  let sent = !!run.sent_at;
  for (let i = start; i < cfg.steps.length; i++) {
    const step = cfg.steps[i]!;
    switch (step.type) {
      case 'message': {
        if (!commentId && !inWindow(conv)) {
          await logStep(run.id, { i, type: 'message', result: 'window_closed' });
          await finish(run.id, sent ? 'sent' : 'skipped', 'window_closed');
          return 'done';
        }
        const text = step.track_links ? await trackLinks(step.text, conv.workspace_id, run.automation_id, run.id) : step.text;
        const quickReplies = step.quick_replies.map((qr) => ({ title: qr.title, payload: `qr:${qr.goto || 'none'}` }));
        try {
          await deliver(conv, text, 'bot', `run:${run.id}:${i}`, { commentId, quickReplies }, commentId ? 'private_reply' : 'text');
          if (!sent) await q(`UPDATE automation_runs SET status = 'sent', sent_at = now() WHERE id = $1`, [run.id]);
          sent = true;
          await logStep(run.id, { i, type: 'message', result: 'sent' });
        } catch (e) {
          const reason = (e as { reason?: string }).reason ?? 'send_failed';
          await logStep(run.id, { i, type: 'message', result: 'failed', reason });
          await finish(run.id, 'failed', reason);
          if ((e as { retryable?: boolean }).retryable) throw e; // BullMQ retries; already-sent steps are skipped by idempotency
          return 'failed';
        }
        break;
      }
      case 'tag':
        await addTags(contact, step.add);
        await removeTags(contact, step.remove);
        await logStep(run.id, { i, type: 'tag', add: step.add, remove: step.remove });
        break;
      case 'field':
        await setField(contact.id, step.key, step.value);
        await logStep(run.id, { i, type: 'field', key: step.key });
        break;
      case 'condition': {
        const ok =
          step.check === 'has_tag' ? await hasTag(contact.id, step.tag)
          : step.check === 'not_tag' ? !(await hasTag(contact.id, step.tag))
          : String((await one(`SELECT fields->>$2 AS v FROM contacts WHERE id = $1`, [contact.id, step.key]))?.v ?? '') === step.value;
        await logStep(run.id, { i, type: 'condition', result: ok });
        if (!ok) {
          await finish(run.id, sent ? 'sent' : 'skipped', 'condition_not_met');
          return 'done';
        }
        break;
      }
      case 'delay':
        await queue.add('automation_step', { kind: 'automation_step', runId: run.id, step: i + 1 }, { delay: step.minutes * 60_000, jobId: `step-${run.id}-${i + 1}` });
        await logStep(run.id, { i, type: 'delay', minutes: step.minutes });
        return 'delayed';
      case 'handoff':
        await logStep(run.id, { i, type: 'handoff' });
        await finish(run.id, sent ? 'sent' : 'skipped', 'handoff');
        await handoff(conv, '', step.note || 'avtomatlaşdırma operatora ötürdü', `run:${run.id}`);
        return 'handoff';
      case 'ai':
        await logStep(run.id, { i, type: 'ai' });
        await finish(run.id, sent ? 'sent' : 'skipped', 'ai');
        return 'ai';
    }
  }
  await finish(run.id, sent ? 'sent' : 'skipped', sent ? '' : 'no_message');
  return 'done';
}

const configOf = async (automationId: string, version: number): Promise<AutomationConfig> =>
  configSchema.parse((await one(`SELECT config FROM automation_versions WHERE automation_id = $1 AND version = $2`, [automationId, version]))?.config ?? {});

/** Resumes a run after a delay step. Stops if the automation was paused meanwhile or the 24h window closed. */
export async function resumeRun(runId: string, step: number): Promise<void> {
  const run = await one<RunRow & { status: string }>(`SELECT * FROM automation_runs WHERE id = $1`, [runId]);
  if (!run || !run.conversation_id || !run.contact_id) return;
  const a = await one<AutomationRow>(`SELECT * FROM automations WHERE id = $1`, [run.automation_id]);
  if (!a || a.status !== 'active') return void (await finish(run.id, run.sent_at ? 'sent' : 'skipped', 'automation_paused'));
  const conv = await loadConv(run.conversation_id);
  const contact = await one<ContactRow>(`SELECT * FROM contacts WHERE id = $1`, [run.contact_id]);
  if (!conv || !contact || contact.opted_out || contact.blocked || conv.needs_human || conv.ai_paused || conv.assignee_user_id) {
    return void (await finish(run.id, run.sent_at ? 'sent' : 'skipped', 'staff_or_opt_out'));
  }
  await executeSteps(run, await configOf(a.id, run.version), step, conv, contact);
}

/**
 * DM-side triggers for the newest inbound message: quick-reply payload > story mention > story reply > keyword.
 * Returns 'none' when nothing matched (the AI may answer), 'ai' when a flow hands over to the AI.
 */
export async function runMessageAutomations(conv: ConvCtx, contact: ContactRow, msg: { id: string; kind: string; payload: string | null; text: string }): Promise<StepOutcome | 'none'> {
  let candidates: AutomationRow[] = [];
  const gotoId = msg.payload?.startsWith('qr:') ? msg.payload.slice(3) : null;
  if (gotoId && gotoId !== 'none') {
    const a = await one<AutomationRow>(`SELECT * FROM automations WHERE id = $1 AND workspace_id = $2 AND trigger = 'quick_reply' AND status = 'active'`, [gotoId, conv.workspace_id]);
    candidates = a ? [a] : [];
  } else if (msg.kind === 'story_mention') {
    candidates = await activeAutomations(conv.workspace_id, conv.channel.id, 'story_mention');
  } else if (msg.kind === 'story_reply') {
    candidates = (await activeAutomations(conv.workspace_id, conv.channel.id, 'story_reply')).filter((a) => matches(a.config.match, msg.text));
  }
  if (!candidates.length && msg.text) candidates = (await activeAutomations(conv.workspace_id, conv.channel.id, 'dm_keyword')).filter((a) => matches(a.config.match, msg.text));
  const a = candidates.find((x) => capability(x.trigger, conv.channel).status === 'available');
  if (!a) return 'none';
  const run = await startRun(a, `msg:${msg.id}`, contact.id, conv.id);
  if (!run) return 'done'; // already handled by an earlier attempt
  return executeSteps(run, configSchema.parse(a.config), 0, conv, contact);
}

/** Comment-to-DM. Idempotent per comment; skips our own comments, old comments (>7 days) and opted-out contacts. */
export async function processComment(ev: Extract<InboundEvent, { type: 'comment' }>): Promise<void> {
  const ch = await one<ChannelRow>(`SELECT * FROM channels WHERE type = 'instagram' AND external_id = $1`, [ev.channelExternalId]);
  if (!ch || ev.fromId === ch.external_id) return;
  const fresh = await one(
    `INSERT INTO ig_comments (id, workspace_id, channel_id, media_id, from_id, from_username, body) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING RETURNING id`,
    [ev.commentId, ch.workspace_id, ch.id, ev.mediaId, ev.fromId, ev.fromUsername.slice(0, 100), ev.text.slice(0, 2000)],
  );
  if (!fresh) return; // duplicate webhook
  if (ch.status !== 'active' || Date.now() - ev.time > 7 * 86400_000) return;
  const contact = await upsertContact(ch, ev.fromId, '', ev.fromUsername);
  if (contact.blocked || contact.opted_out) return;
  const a = (await activeAutomations(ch.workspace_id, ch.id, 'comment')).find(
    (x) => (x.config.media.scope === 'all' || x.config.media.ids.includes(ev.mediaId)) && matches(x.config.match, ev.text) && capability('comment', ch).status === 'available',
  );
  if (!a) return;
  await q(`UPDATE ig_comments SET matched = true WHERE id = $1`, [ev.commentId]);
  const blocked = await automationBlocked(ch.workspace_id);
  if (blocked) return limitAlert(ch.workspace_id, blocked);
  const conversationId = await ensureConversation(ch, contact, ev.fromId);
  const run = await startRun(a, `comment:${ev.commentId}`, contact.id, conversationId);
  if (!run) return;
  const cfg = configSchema.parse(a.config);
  if (cfg.public_reply.enabled && cfg.public_reply.texts.length) {
    const text = cfg.public_reply.texts[Math.floor(Math.random() * cfg.public_reply.texts.length)]!;
    await replyToComment(decrypt(ch.access_token_enc), ev.commentId, text)
      .then(() => logStep(run.id, { type: 'public_reply', result: 'sent' }))
      .catch((e) => logStep(run.id, { type: 'public_reply', result: 'failed', reason: String((e as Error).message).slice(0, 120) }));
  }
  const conv = (await loadConv(conversationId))!;
  await executeSteps(run, cfg, 0, conv, contact, ev.commentId);
}
