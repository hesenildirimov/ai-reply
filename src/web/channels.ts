import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { removeChannel } from '../channels/index.js';
import { exchangeInstagramCode, instagramAuthorizeUrl, subscribeInstagram } from '../channels/instagram.js';
import type { ChannelRow } from '../channels/types.js';
import { completeEmbeddedSignup } from '../channels/whatsapp.js';
import { config } from '../config.js';
import { encryptSecret, randomToken, sha256 } from '../crypto.js';
import { one, q } from '../db.js';
import { audit } from '../events.js';
import { checkLimit } from '../plans.js';
import { queue } from '../queue.js';
import { requirePerm, requireUser } from './auth.js';
import { html, pageHead, type Safe } from './html.js';
import { channelIcon, icon } from './icons.js';
import { MESSAGES, view } from './public.js';
import { chip, idParam, postForm, typeLabel } from './ui.js';

Object.assign(MESSAGES, {
  channel_limit: { type: 'error', text: 'Tarifinizdə bağlı hesab limiti dolub. Artırmaq üçün bizimlə əlaqə saxlayın.' },
  ig_connected: { type: 'ok', text: 'Instagram hesabı bağlandı.' },
  wa_connected: { type: 'ok', text: 'WhatsApp nömrəsi bağlandı.' },
  disconnected: { type: 'ok', text: 'Kanal ayrıldı və onun bütün məlumatları silindi.' },
  connect_failed: { type: 'error', text: 'Bağlantı alınmadı. Yenidən cəhd edin.' },
});

/** A platform account can belong to one workspace only; moving it drops the old workspace's data. */
async function claimExternalAccount(type: 'whatsapp' | 'instagram', externalId: string, workspaceId: string) {
  const others = await q<ChannelRow>('SELECT * FROM channels WHERE type = $1 AND external_id = $2 AND workspace_id <> $3', [type, externalId, workspaceId]);
  for (const ch of others) await q('DELETE FROM channels WHERE id = $1', [ch.id]);
}

/** Plan limit on connected accounts; reconnecting an account the workspace already has is always allowed. */
async function channelAllowed(workspaceId: string, type: string, externalId: string) {
  if (await one(`SELECT 1 FROM channels WHERE workspace_id = $1 AND type = $2 AND external_id = $3`, [workspaceId, type, externalId])) return true;
  const lim = await checkLimit(workspaceId, 'channels');
  if (!lim.ok) await audit(workspaceId, null, 'plan.limit_reached', 'workspace', workspaceId, { limit: 'channels', used: lim.used, max: lim.limit });
  return lim.ok;
}

/** Connecting and disconnecting Instagram / WhatsApp accounts. */
export function channelRoutes(app: FastifyInstance) {
  app.register(async (r) => {
    r.addHook('preHandler', requireUser);

    // ---------- Channels ----------
    r.get('/app/channels', async (req, reply) => {
      const chans = await q<ChannelRow>('SELECT * FROM channels WHERE workspace_id = $1 ORDER BY created_at', [req.user!.workspaceId]);
      const owner = req.user!.role === 'owner';
      const head = config.whatsappEnabled
        ? html`<script src="/public/wa-signup.js" defer></script><script async defer crossorigin="anonymous" src="https://connect.facebook.net/en_US/sdk.js"></script>`
        : undefined;
      const card = (type: 'instagram' | 'whatsapp', desc: string, connect: Safe) => {
        const list = chans.filter((c) => c.type === type);
        return html`<section class="card channel">
          <div class="channel-top"><span class="brand-tile ${type === 'whatsapp' ? 'wa' : 'ig'}">${channelIcon(type)}</span>
            <div><h2>${typeLabel(type)}</h2><p class="muted">${desc}</p></div></div>
          ${list.map(
            (c) => html`<div class="acct"><span>${icon(c.status === 'active' ? 'check' : 'alert')}<b>${c.display_name}</b></span>
            ${c.status === 'active' ? chip('ok', 'Bağlıdır') : chip('danger', 'Xəta, yenidən bağlayın')}
            ${owner ? postForm(`/app/channels/${c.id}/disconnect`, req.csrfToken, html`Ayır`, 'btn sm danger-ghost', { confirm: 'Kanal ayrılsın və bütün söhbətləri silinsin?' }) : ''}</div>`,
          )}
          ${owner ? connect : ''}</section>`;
      };
      return view(
        req,
        reply,
        'Kanallar',
        html`${pageHead('Kanallar', 'Hesabınızı bir kliklə bağlayın. Şifrənizi bizimlə paylaşmırsınız, giriş Meta-nın öz səhifəsində olur.')}
        <div class="channels">
          ${card(
            'instagram',
            'Direct mesajlara avtomatik cavab. Hesab Business və ya Creator olmalıdır.',
            config.instagramEnabled
              ? html`<a class="btn" href="/app/channels/instagram/connect">${icon('link')}Instagram bağla</a>`
              : html`<p class="hint">Meta tətbiqi hələ qurulmayıb (IG_APP_ID).</p>`,
          )}
          ${card(
            'whatsapp',
            'WhatsApp Business nömrənizə gələn mesajlara avtomatik cavab.',
            config.whatsappEnabled
              ? html`<button class="btn" id="wa-connect" data-app-id="${config.META_APP_ID}" data-config-id="${config.WA_EMBEDDED_SIGNUP_CONFIG_ID}" data-version="${config.META_GRAPH_VERSION}" data-csrf="${req.csrfToken}">${icon('link')}WhatsApp bağla</button><p class="hint" id="wa-status"></p>`
              : html`<p class="hint">Meta tətbiqi hələ qurulmayıb (META_APP_ID).</p>`,
          )}
        </div>
        <p class="hint">${icon('lock', 'i xs')} Yalnız mesajları oxumaq və cavab göndərmək icazəsi istəyirik. Kanalı ayıranda onun bütün yazışmaları silinir.</p>`,
        head,
      );
    });

    r.get('/app/channels/instagram/connect', { preHandler: requirePerm('channels.manage') }, async (req, reply) => {
      if (!config.instagramEnabled) return reply.redirect('/app/channels?m=connect_failed');
      const state = randomToken();
      await q(`INSERT INTO oauth_states (state_hash, workspace_id, provider, expires_at) VALUES ($1, $2, 'instagram', now() + interval '10 minutes')`, [
        sha256(state),
        req.user!.workspaceId,
      ]);
      return reply.redirect(instagramAuthorizeUrl(state));
    });

    r.get('/oauth/instagram/callback', { preHandler: requirePerm('channels.manage') }, async (req, reply) => {
      const { code, state } = req.query as Record<string, string | undefined>;
      if (!code || !state || state.length > 100) return reply.redirect('/app/channels?m=connect_failed');
      const st = await one(`DELETE FROM oauth_states WHERE state_hash = $1 AND provider = 'instagram' AND expires_at > now() RETURNING workspace_id`, [
        sha256(state),
      ]);
      if (!st || st.workspace_id !== req.user!.workspaceId) return reply.redirect('/app/channels?m=connect_failed');
      try {
        const ig = await exchangeInstagramCode(code.replace(/#_$/, ''));
        if (!(await channelAllowed(req.user!.workspaceId, 'instagram', ig.igId))) return reply.redirect('/app/channels?m=channel_limit');
        await subscribeInstagram(ig.token);
        await claimExternalAccount('instagram', ig.igId, req.user!.workspaceId);
        await q(
          `INSERT INTO channels (workspace_id, type, external_id, display_name, access_token_enc, token_expires_at, scopes, token_refreshed_at) VALUES ($1, 'instagram', $2, $3, $4, $5, $6, now())
           ON CONFLICT (type, external_id) DO UPDATE SET display_name = EXCLUDED.display_name, access_token_enc = EXCLUDED.access_token_enc,
             token_expires_at = EXCLUDED.token_expires_at, scopes = EXCLUDED.scopes, token_refreshed_at = now(), status = 'active', status_reason = ''`,
          [req.user!.workspaceId, ig.igId, `@${ig.username}`, encryptSecret(ig.token), ig.expiresAt, ig.scopes],
        );
        await queue.add('learn_style', { kind: 'learn_style', workspaceId: req.user!.workspaceId }, { delay: 5000 });
        await audit(req.user!.workspaceId, req.user!.id, 'channel.connect', 'channel', ig.igId, { type: 'instagram', scopes: ig.scopes });
        return reply.redirect('/app/channels?m=ig_connected');
      } catch (e) {
        req.log.warn({ err: e }, 'instagram connect failed');
        return reply.redirect('/app/channels?m=connect_failed');
      }
    });

    r.post(
      '/app/channels/whatsapp/complete',
      { preHandler: requirePerm('channels.manage'), config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
      async (req, reply) => {
        const p = z
          .object({ code: z.string().min(10).max(2000), waba_id: z.string().regex(/^\d{5,25}$/), phone_number_id: z.string().regex(/^\d{5,25}$/) })
          .safeParse(req.body);
        if (!p.success || !config.whatsappEnabled) return reply.code(400).send({ ok: false });
        if (!(await channelAllowed(req.user!.workspaceId, 'whatsapp', p.data.phone_number_id)))
          return reply.code(403).send({ ok: false, error: MESSAGES.channel_limit!.text });
        try {
          const wa = await completeEmbeddedSignup(p.data.code, p.data.waba_id, p.data.phone_number_id);
          await claimExternalAccount('whatsapp', p.data.phone_number_id, req.user!.workspaceId);
          await q(
            `INSERT INTO channels (workspace_id, type, external_id, waba_id, display_name, access_token_enc, extra_enc) VALUES ($1, 'whatsapp', $2, $3, $4, $5, $6)
           ON CONFLICT (type, external_id) DO UPDATE SET waba_id = EXCLUDED.waba_id, display_name = EXCLUDED.display_name,
             access_token_enc = EXCLUDED.access_token_enc, extra_enc = coalesce(EXCLUDED.extra_enc, channels.extra_enc), status = 'active', status_reason = '', scopes = '{whatsapp_business_messaging,whatsapp_business_management}'`,
            [
              req.user!.workspaceId,
              p.data.phone_number_id,
              p.data.waba_id,
              wa.displayName,
              encryptSecret(wa.token),
              wa.pin ? encryptSecret(JSON.stringify({ pin: wa.pin })) : null,
            ],
          );
          await audit(req.user!.workspaceId, req.user!.id, 'channel.connect', 'channel', p.data.phone_number_id, { type: 'whatsapp' });
          return reply.send({ ok: true });
        } catch (e) {
          req.log.warn({ err: e }, 'whatsapp connect failed');
          return reply.code(400).send({ ok: false });
        }
      },
    );

    r.post('/app/channels/:id/disconnect', { preHandler: requirePerm('channels.manage') }, async (req, reply) => {
      const id = idParam(req);
      const ch = id && (await one<ChannelRow>('SELECT * FROM channels WHERE id = $1 AND workspace_id = $2', [id, req.user!.workspaceId]));
      if (ch) {
        await removeChannel(ch);
        await audit(req.user!.workspaceId, req.user!.id, 'channel.disconnect', 'channel', ch.external_id, { type: ch.type });
      }
      return reply.redirect('/app/channels?m=disconnected');
    });
  });
}
