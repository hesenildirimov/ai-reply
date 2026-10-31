import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { removeChannel } from '../channels/index.js';
import { parseInstagramWebhook } from '../channels/instagram.js';
import type { ChannelRow } from '../channels/types.js';
import { parseWhatsAppWebhook } from '../channels/whatsapp.js';
import { config } from '../config.js';
import { parseSignedRequest, randomToken, safeEqual, verifyMetaSignature } from '../crypto.js';
import { one, q } from '../db.js';
import { accept, eventJob, type IntakeJob, keyedJob } from '../inbound.js';
import { telegramEnabled } from '../telegram.js';
import { handleTelegramUpdate } from '../telegram-updates.js';

// Meta delivers in bursts from a few IPs: the cap stops floods of unsigned junk (audit F-14) without throttling Meta
// itself at 500+ businesses. A webhook now costs one HMAC and one queue write, so the cap can be generous.
const META = { csrf: false, rateLimit: { max: 6000, timeWindow: '1 minute' } } as const;

function verifyChallenge(req: FastifyRequest, reply: FastifyReply) {
  const qs = req.query as Record<string, string | undefined>;
  const token = qs['hub.verify_token'] ?? '';
  const challenge = qs['hub.challenge'] ?? '';
  if (
    qs['hub.mode'] === 'subscribe' &&
    config.META_WEBHOOK_VERIFY_TOKEN &&
    safeEqual(token, config.META_WEBHOOK_VERIFY_TOKEN) &&
    /^[\w-]{1,200}$/.test(challenge)
  ) {
    return reply.type('text/plain').send(challenge);
  }
  return reply.code(403).send();
}

/** Turns Meta events into intake jobs; the worker stores them and replies. Nothing slow runs inside the webhook. */
async function intake(req: FastifyRequest, jobs: IntakeJob[]) {
  try {
    await accept(jobs);
  } catch (e) {
    req.log.error({ err: e }, 'webhook intake failed');
    throw e; // 500 -> Meta retries; duplicates collapse on the job id / message id
  }
}

async function deleteForPlatformUser(userId: string) {
  const channels = await q<ChannelRow>(`SELECT * FROM channels WHERE external_id = $1`, [userId]);
  for (const ch of channels) await removeChannel(ch);
}

export function metaRoutes(app: FastifyInstance) {
  app.get('/webhooks/whatsapp', { config: META }, verifyChallenge);
  app.get('/webhooks/instagram', { config: META }, verifyChallenge);

  app.post('/webhooks/whatsapp', { config: META }, async (req, reply) => {
    if (!verifyMetaSignature(req.rawBody, req.headers['x-hub-signature-256'] as string, [config.META_APP_SECRET])) return reply.code(401).send();
    const body: any = req.body;
    const jobs: IntakeJob[] = [];
    // Customer removed our app from their WABA -> the worker deletes the channel and its data.
    for (const entry of body?.entry ?? []) {
      for (const change of entry?.changes ?? []) {
        if (change?.field === 'account_update' && change.value?.event === 'PARTNER_REMOVED' && typeof entry.id === 'string') {
          jobs.push(keyedJob(`partner_removed|${entry.id}|${entry.time ?? ''}`, { kind: 'wa_partner_removed', wabaId: entry.id }));
        }
      }
    }
    for (const ev of parseWhatsAppWebhook(body)) {
      // Messages to the platform's own number are alert sign-ups, not customer chats.
      const platform = config.waAlertsEnabled && ev.channelExternalId === config.PLATFORM_WA_PHONE_NUMBER_ID;
      if (!platform) jobs.push(eventJob(ev));
      else if (ev.type === 'message') jobs.push(keyedJob(`alert_link|${ev.mid}`, { kind: 'wa_alert_link', waId: ev.userId, text: ev.text ?? '' }));
    }
    await intake(req, jobs);
    return reply.send('EVENT_RECEIVED');
  });

  app.post('/webhooks/instagram', { config: META }, async (req, reply) => {
    if (!verifyMetaSignature(req.rawBody, req.headers['x-hub-signature-256'] as string, [config.IG_APP_SECRET, config.META_APP_SECRET]))
      return reply.code(401).send();
    await intake(req, parseInstagramWebhook(req.body).map(eventJob));
    return reply.send('EVENT_RECEIVED');
  });

  // Telegram bot: links a chat to a workspace via the one-time /start code. Verified by the secret header.
  app.post('/webhooks/telegram', { config: META }, async (req, reply) => {
    const secret = req.headers['x-telegram-bot-api-secret-token'];
    // Mock mode never accepts outside Telegram traffic: its updates come from the dashboard simulator.
    if (config.mockMode || !telegramEnabled() || typeof secret !== 'string' || !safeEqual(secret, config.TELEGRAM_WEBHOOK_SECRET!))
      return reply.code(401).send();
    await handleTelegramUpdate(req.body);
    return reply.send({ ok: true });
  });

  const signed = (req: FastifyRequest) => {
    const sr = (req.body as any)?.signed_request;
    const payload = typeof sr === 'string' ? parseSignedRequest(sr, [config.META_APP_SECRET, config.IG_APP_SECRET]) : null;
    const userId = payload?.user_id;
    return typeof userId === 'string' || typeof userId === 'number' ? String(userId) : null;
  };

  // Deauthorize callback: the user removed the app.
  app.post('/meta/deauthorize', { config: META }, async (req, reply) => {
    const userId = signed(req);
    if (!userId) return reply.code(400).send();
    await deleteForPlatformUser(userId);
    return reply.send({ ok: true });
  });

  // Data deletion request callback (required by Meta).
  app.post('/meta/data-deletion', { config: META }, async (req, reply) => {
    const userId = signed(req);
    if (!userId) return reply.code(400).send();
    await deleteForPlatformUser(userId);
    const code = randomToken(12);
    await q(`INSERT INTO deletion_requests (confirmation_code, status) VALUES ($1, 'completed')`, [code]);
    return reply.send({ url: `${config.APP_URL}/data-deletion/status?code=${code}`, confirmation_code: code });
  });

  app.get('/data-deletion/status', async (req, reply) => {
    const code = String((req.query as any).code ?? '').slice(0, 64);
    const row = await one(`SELECT status, created_at FROM deletion_requests WHERE confirmation_code = $1`, [code]);
    return reply.type('text/plain; charset=utf-8').send(row ? `Request ${code}: ${row.status} (${row.created_at.toISOString()})` : 'Unknown confirmation code');
  });
}
