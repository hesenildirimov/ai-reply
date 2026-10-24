import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { removeChannel } from '../channels/index.js';
import { parseInstagramWebhook } from '../channels/instagram.js';
import type { ChannelRow, InboundEvent } from '../channels/types.js';
import { parseWhatsAppWebhook } from '../channels/whatsapp.js';
import { config } from '../config.js';
import { parseSignedRequest, randomToken, safeEqual, verifyMetaSignature } from '../crypto.js';
import { one, q } from '../db.js';
import { ingest } from '../pipeline.js';

const META = { csrf: false, rateLimit: false } as const;

function verifyChallenge(req: FastifyRequest, reply: FastifyReply) {
  const qs = req.query as Record<string, string | undefined>;
  const token = qs['hub.verify_token'] ?? '';
  const challenge = qs['hub.challenge'] ?? '';
  if (qs['hub.mode'] === 'subscribe' && config.META_WEBHOOK_VERIFY_TOKEN && safeEqual(token, config.META_WEBHOOK_VERIFY_TOKEN) && /^[\w-]{1,200}$/.test(challenge)) {
    return reply.type('text/plain').send(challenge);
  }
  return reply.code(403).send();
}

async function handleEvents(req: FastifyRequest, events: InboundEvent[]) {
  for (const ev of events) {
    try {
      await ingest(ev);
    } catch (e) {
      req.log.error({ err: e, channel: ev.channelType }, 'ingest failed');
      throw e; // 500 -> Meta retries; duplicates are deduplicated by message id
    }
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
    // Customer removed our app from their WABA -> delete the channel and its data.
    for (const entry of body?.entry ?? []) {
      for (const change of entry?.changes ?? []) {
        if (change?.field === 'account_update' && change.value?.event === 'PARTNER_REMOVED' && typeof entry.id === 'string') {
          for (const ch of await q<ChannelRow>(`SELECT * FROM channels WHERE type = 'whatsapp' AND waba_id = $1`, [entry.id])) await removeChannel(ch);
        }
      }
    }
    await handleEvents(req, parseWhatsAppWebhook(body));
    return reply.send('EVENT_RECEIVED');
  });

  app.post('/webhooks/instagram', { config: META }, async (req, reply) => {
    if (!verifyMetaSignature(req.rawBody, req.headers['x-hub-signature-256'] as string, [config.IG_APP_SECRET, config.META_APP_SECRET])) return reply.code(401).send();
    await handleEvents(req, parseInstagramWebhook(req.body));
    return reply.send('EVENT_RECEIVED');
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
