import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { encrypt, randomToken } from '../crypto.js';
import { one, q } from '../db.js';
import { audit } from '../events.js';
import { queue } from '../queue.js';
import { validateWebhookUrl, WEBHOOK_EVENTS, type WebhookEvent } from '../webhooks.js';
import { requirePerm, requireUser } from './auth.js';
import { csrfField, html, pageHead, raw } from './html.js';
import { icon } from './icons.js';
import { MESSAGES, view } from './public.js';
import { chip, empty, fmt, idParam, postForm } from './ui.js';

Object.assign(MESSAGES, {
  webhook_url: { type: 'error', text: 'URL qəbul olunmadı: yalnız açıq internetdəki https:// ünvanları (daxili/lokal IP-lər bloklanır).' },
  webhook_limit: { type: 'error', text: 'Maksimum 10 webhook.' },
  webhook_test: { type: 'ok', text: 'Test hadisəsi növbəyə qoyuldu, nəticə aşağıdakı cədvəldə görünəcək.' },
});

const MAX_HOOKS = 10;
const EVENT_KEYS = Object.keys(WEBHOOK_EVENTS) as [WebhookEvent, ...WebhookEvent[]];
const createSchema = z.object({
  name: z.string().trim().max(80).default(''),
  url: z.string().trim().max(2000),
  events: z.union([z.enum(EVENT_KEYS), z.array(z.enum(EVENT_KEYS)).min(1)]).transform((v) => (Array.isArray(v) ? [...new Set(v)] : [v])),
});

export function integrationRoutes(app: FastifyInstance) {
  app.register(async (r) => {
    r.addHook('preHandler', requireUser);
    r.addHook('preHandler', requirePerm('integrations.manage'));
    const owned = async (req: FastifyRequest) => {
      const id = idParam(req);
      return id ? one(`SELECT * FROM webhooks WHERE id = $1 AND workspace_id = $2`, [id, req.user!.workspaceId]) : undefined;
    };

    r.get('/app/integrations', async (req, reply) => {
      const w0 = req.user!.workspaceId;
      const [hooks, deliveries] = await Promise.all([
        q(`SELECT * FROM webhooks WHERE workspace_id = $1 ORDER BY created_at`, [w0]),
        q(`SELECT d.event, d.status, d.attempts, d.response_code, d.error, d.created_at, w.name, w.url FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id
           WHERE d.workspace_id = $1 ORDER BY d.created_at DESC LIMIT 20`, [w0]),
      ]);
      return view(req, reply, 'İnteqrasiyalar', html`${pageHead('İnteqrasiyalar', 'Hadisələri öz sisteminizə, Google Sheets-ə və ya CRM-ə göndərin (webhook).')}
        <section class="card"><h2>${icon('plus')}Yeni webhook</h2>
          <form method="post" action="/app/integrations" class="stack">${csrfField(req.csrfToken)}
            <div class="two"><label>Ad<input name="name" maxlength="80" placeholder="Google Sheets, CRM..."></label>
            <label>URL (https)<input name="url" type="url" required maxlength="2000" placeholder="https://script.google.com/macros/s/.../exec"></label></div>
            <fieldset class="checks"><legend>Hadisələr</legend>${EVENT_KEYS.map((k) => html`<label class="check"><input type="checkbox" name="events" value="${k}" ${k === 'message.received' ? raw('checked') : ''}> ${WEBHOOK_EVENTS[k]} <code>${k}</code></label>`)}</fieldset>
            <button class="btn" ${hooks.length >= MAX_HOOKS ? raw('disabled') : ''}>${icon('plus')}Əlavə et</button></form>
          <p class="hint">Hər sorğu <code>X-AIReply-Signature: sha256=HMAC(secret, timestamp + "." + body)</code> ilə imzalanır; uğursuz sorğular 6 dəfəyə qədər təkrarlanır.
            Google Sheets və CRM nümunələri: <code>docs/INTEGRATIONS.md</code>. Diqqət: <code>message.received</code> müştəri mesajının mətnini göndərir — yalnız etibar etdiyiniz sistemə qoşun.</p>
        </section>
        <section class="card flush">${hooks.length ? html`<div class="table-wrap"><table><thead><tr><th>Webhook</th><th>Hadisələr</th><th>Vəziyyət</th><th></th></tr></thead><tbody>
          ${hooks.map((h) => html`<tr><td><b>${h.name || 'Webhook'}</b><small class="muted block">${h.url}</small></td><td>${h.events.map((e: string) => html`<code>${e}</code> `)}</td>
            <td>${h.active ? chip('ok', 'Aktiv') : chip('neutral', 'Söndürülüb')} ${h.consecutive_failures ? chip('warn', `${h.consecutive_failures} xəta`) : ''}<small class="muted block">${h.last_delivery_at ? `son: ${fmt(h.last_delivery_at)}` : ''}</small></td>
            <td class="right"><div class="actions">${postForm(`/app/integrations/${h.id}/test`, req.csrfToken, 'Test', 'btn sm secondary')}
              ${postForm(`/app/integrations/${h.id}/toggle`, req.csrfToken, h.active ? 'Söndür' : 'Aktiv et', 'btn sm secondary')}
              ${postForm(`/app/integrations/${h.id}/rotate`, req.csrfToken, 'Yeni secret', 'btn sm secondary', { confirm: 'Köhnə secret dərhal etibarsız olacaq. Davam?' })}
              ${postForm(`/app/integrations/${h.id}/delete`, req.csrfToken, icon('trash'), 'btn sm danger-ghost', { confirm: 'Webhook silinsin?' })}</div></td></tr>`)}
          </tbody></table></div>` : empty('share', 'Hələ webhook yoxdur.')}</section>
        ${deliveries.length ? html`<section class="card flush"><div class="card-head pad"><h2>Son çatdırılmalar</h2></div><div class="table-wrap"><table><thead><tr><th>Vaxt</th><th>Webhook</th><th>Hadisə</th><th>Nəticə</th></tr></thead><tbody>
          ${deliveries.map((d) => html`<tr><td class="muted nowrap">${fmt(d.created_at)}</td><td>${d.name || d.url}</td><td><code>${d.event}</code></td>
            <td>${d.status === 'sent' ? chip('ok', `${d.response_code}`) : d.status === 'failed' ? chip('danger', d.error || 'xəta') : chip('neutral', d.attempts ? `təkrar · ${d.error}` : 'gözləyir')}</td></tr>`)}
          </tbody></table></div></section>` : ''}`);
    });

    const secretPage = (req: FastifyRequest, reply: any, name: string, secret: string) =>
      view(req, reply, 'Webhook secret', html`${pageHead('Webhook secret', name || 'Webhook')}<section class="card link-box"><h2>${icon('lock')}İmza açarı</h2>
        <p>Bu açarı qəbul edən tərəfdə imzanı yoxlamaq üçün saxlayın. <b>Bir daha göstərilməyəcək</b> (unutsanız "Yeni secret" yaradın).</p>
        <div class="copy-row"><input readonly value="${secret}" class="copy" id="wh-secret"><button type="button" class="btn secondary" data-copy="wh-secret">Kopyala</button></div></section>
        <p><a href="/app/integrations" class="more">${icon('back', 'i xs')} İnteqrasiyalar</a></p>`);

    r.post('/app/integrations', async (req, reply) => {
      const w0 = req.user!.workspaceId;
      const p = createSchema.safeParse(req.body);
      if (!p.success) return reply.redirect('/app/integrations?m=invalid');
      const url = validateWebhookUrl(p.data.url);
      if (!url) return reply.redirect('/app/integrations?m=webhook_url');
      if ((await one<{ n: number }>(`SELECT count(*)::int AS n FROM webhooks WHERE workspace_id = $1`, [w0]))!.n >= MAX_HOOKS) return reply.redirect('/app/integrations?m=webhook_limit');
      const secret = `whsec_${randomToken(24)}`;
      const h = await one(`INSERT INTO webhooks (workspace_id, name, url, secret_enc, events) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [w0, p.data.name, url, encrypt(secret), p.data.events]);
      await audit(w0, req.user!.id, 'webhook.create', 'webhook', h!.id, { host: new URL(url).host, events: p.data.events });
      return secretPage(req, reply, p.data.name, secret);
    });

    r.post('/app/integrations/:id/rotate', async (req, reply) => {
      const h = await owned(req);
      if (!h) return reply.code(404).send('Not found');
      const secret = `whsec_${randomToken(24)}`;
      await q(`UPDATE webhooks SET secret_enc = $2 WHERE id = $1`, [h.id, encrypt(secret)]);
      await audit(h.workspace_id, req.user!.id, 'webhook.rotate_secret', 'webhook', h.id);
      return secretPage(req, reply, h.name, secret);
    });

    r.post('/app/integrations/:id/toggle', async (req, reply) => {
      const h = await owned(req);
      if (h) {
        await q(`UPDATE webhooks SET active = NOT active, consecutive_failures = 0 WHERE id = $1`, [h.id]);
        await audit(h.workspace_id, req.user!.id, h.active ? 'webhook.disable' : 'webhook.enable', 'webhook', h.id);
      }
      return reply.redirect('/app/integrations?m=saved');
    });

    r.post('/app/integrations/:id/test', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
      const h = await owned(req);
      if (!h || !h.active) return reply.redirect('/app/integrations?m=invalid');
      const payload = { event: 'ping', created_at: new Date().toISOString(), data: { message: 'AI Reply test hadisəsi' } };
      const d = await one(`INSERT INTO webhook_deliveries (webhook_id, workspace_id, event, payload) VALUES ($1, $2, 'ping', $3) RETURNING id`, [h.id, h.workspace_id, payload]);
      await queue.add('webhook', { kind: 'webhook', deliveryId: d!.id }, { jobId: `wh-${d!.id}`, attempts: 1 });
      return reply.redirect('/app/integrations?m=webhook_test');
    });

    r.post('/app/integrations/:id/delete', async (req, reply) => {
      const h = await owned(req);
      if (h) {
        await q(`DELETE FROM webhooks WHERE id = $1`, [h.id]);
        await audit(h.workspace_id, req.user!.id, 'webhook.delete', 'webhook', h.id);
      }
      return reply.redirect('/app/integrations?m=saved');
    });
  });
}
