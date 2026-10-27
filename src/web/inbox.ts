import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { fetchWhatsAppMedia } from '../channels/whatsapp.js';
import { addTags, FIELD_KEY, removeTags } from '../contacts.js';
import { decrypt, randomToken } from '../crypto.js';
import * as data from '../data/inbox.js';
import { audit } from '../events.js';
import { sendManualReply } from '../pipeline.js';
import { publish, subscribe } from '../realtime.js';
import { can, type Permission, requirePerm, requireUser, SID, sessionAlive } from './auth.js';
import type { Safe } from './html.js';
import { html } from './html.js';
import { inboxBody, listHtml, paneHtml, profileHtml, savedRepliesHtml, threadHtml } from './inbox-views.js';
import { MESSAGES, view } from './public.js';
import { idParam, pauseLabel } from './ui.js';

/** Inbox routes: tenant checks, permissions and validation here; SQL in data/inbox.ts, HTML in inbox-views.ts. */

Object.assign(MESSAGES, {
  sent: { type: 'ok', text: `Göndərildi. AI bu söhbətdə ${pauseLabel()} dayandırıldı.` },
  window_closed: { type: 'error', text: 'Müştərinin son mesajından 24 saat keçib. Meta qaydalarına görə indi cavab göndərmək olmur.' },
  send_failed: { type: 'error', text: 'Göndərmək alınmadı. Bir az sonra yenidən cəhd edin.' },
});

// Live inbox streams (SSE): a few tabs per user are normal, thousands would exhaust the web process.
const SSE_MAX_PER_USER = 5;
const SSE_PING_MS = 25_000;
const sseOpen = new Map<string, number>();

const wantsJson = (req: FastifyRequest) => String(req.headers.accept ?? '').includes('application/json');
const done = (req: FastifyRequest, reply: FastifyReply, id: string, m = 'saved') =>
  wantsJson(req) ? reply.send({ ok: true }) : reply.redirect(`/app/inbox/${id}?m=${m}`);
const fail = (req: FastifyRequest, reply: FastifyReply, id: string, m: string, code = 400) =>
  wantsJson(req) ? reply.code(code).send({ ok: false, error: MESSAGES[m]?.text ?? 'Xəta' }) : reply.redirect(`/app/inbox/${id}?m=${m}`);
const fragment = (reply: FastifyReply, s: Safe) => reply.type('text/html; charset=utf-8').send(s.value);

const thread = async (c: any) => threadHtml(await data.threadItems(c.id));
const profile = async (req: FastifyRequest, c: any) => profileHtml(req, c, c.contact_id ? await data.profileData(c) : null);
const pane = async (req: FastifyRequest, c: any) => {
  const [pd, t] = await Promise.all([data.paneData(c.workspace_id), thread(c)]);
  return paneHtml(req, c, pd, t);
};

async function inboxPage(req: FastifyRequest, reply: FastifyReply, activeId?: string) {
  const w = req.user!.workspaceId;
  const f = data.filterSchema.parse(req.query ?? {});
  const c = activeId ? await data.loadConversation(w, activeId) : undefined;
  if (activeId && !c) return reply.code(404).send('Not found');
  if (c?.unread_count > 0) await data.markRead(c.id);
  const [list, counts, choices, active] = await Promise.all([
    data.listConversations(w, req.user!.id, f),
    data.tabCounts(w, req.user!.id),
    data.filterChoices(w),
    c ? Promise.all([pane(req, c), profile(req, c)]).then(([p, pr]) => ({ c, pane: p, profile: pr })) : undefined,
  ]);
  const title = c ? `${c.display_name || 'Söhbət'} · Söhbətlər` : 'Söhbətlər';
  return view(req, reply, title, inboxBody({ f, list, counts, choices, active }), html`<script src="/public/inbox.js" defer></script>`, true);
}

export function inboxRoutes(app: FastifyInstance) {
  app.register(async (r) => {
    r.addHook('preHandler', requireUser);
    // Reading conversations is personal data: analysts (analytics only) are excluded server-side.
    r.addHook('preHandler', requirePerm('inbox.view'));
    const perm = (p: Permission) => ({ preHandler: requirePerm(p) });
    const owned = (req: FastifyRequest) => {
      const id = idParam(req);
      return id ? data.ownedConversation(req.user!.workspaceId, id) : Promise.resolve(undefined);
    };
    const ownedContact = (req: FastifyRequest) => {
      const id = idParam(req);
      return id ? data.ownedContact(req.user!.workspaceId, id) : Promise.resolve(undefined);
    };

    r.get('/app/inbox', (req, reply) => inboxPage(req, reply));
    r.get('/app/inbox/:id', (req, reply) => {
      const id = idParam(req);
      return id ? inboxPage(req, reply, id) : reply.code(404).send('Not found');
    });

    // HTML fragments for live refresh (same auth + tenant checks as the page).
    r.get('/app/inbox/part/list', async (req, reply) => {
      const f = data.filterSchema.parse(req.query ?? {});
      const active = z.uuid().safeParse((req.query as any)?.active).data;
      const { rows, next } = await data.listConversations(req.user!.workspaceId, req.user!.id, f);
      return fragment(reply, listHtml(rows, next, f, active));
    });
    r.get('/app/inbox/:id/part/:part', async (req, reply) => {
      const id = idParam(req);
      const c = id ? await data.loadConversation(req.user!.workspaceId, id) : undefined;
      if (!c) return reply.code(404).send('');
      const part = (req.params as any).part;
      if (part === 'thread') {
        if (c.unread_count > 0) await data.markRead(c.id);
        return fragment(reply, await thread(c));
      }
      if (part === 'pane') return fragment(reply, await pane(req, c));
      if (part === 'profile') return fragment(reply, await profile(req, c));
      return reply.code(404).send('');
    });

    // Server-Sent Events: new messages / conversation changes for this workspace only (ids, never message text).
    // Per-process cap on live streams per user; each ping re-checks that the session and membership still exist,
    // so a logged-out or removed member's open tab stops receiving events within one ping.
    r.get('/app/events', { config: { rateLimit: false } }, (req, reply) => {
      const uid = req.user!.id;
      const ws = req.user!.workspaceId;
      const token = req.cookies[SID] ?? '';
      if ((sseOpen.get(uid) ?? 0) >= SSE_MAX_PER_USER) return reply.code(429).send('Too many requests');
      sseOpen.set(uid, (sseOpen.get(uid) ?? 0) + 1);
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 5000\n\n');
      const off = subscribe(ws, (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`));
      const ping = setInterval(async () => {
        const alive = await sessionAlive(token, ws).catch(() => true); // DB hiccup: keep the stream, check again next ping
        if (!alive) return res.end();
        res.write(': ping\n\n');
      }, SSE_PING_MS);
      let closed = false;
      req.raw.on('close', () => {
        if (closed) return;
        closed = true;
        clearInterval(ping);
        off();
        const n = (sseOpen.get(uid) ?? 1) - 1;
        if (n > 0) sseOpen.set(uid, n);
        else sseOpen.delete(uid);
      });
    });

    r.post('/app/inbox/:id/reply', { ...perm('inbox.reply'), config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
      const id = idParam(req);
      const text = z
        .string()
        .trim()
        .min(1)
        .max(4096)
        .safeParse((req.body as any)?.text).data;
      if (!id || !text) return fail(req, reply, id ?? '', 'invalid');
      try {
        const nonce =
          z
            .string()
            .regex(/^[A-Za-z0-9_-]{16,64}$/)
            .safeParse((req.body as any)?.nonce).data ?? randomToken(16);
        const res = await sendManualReply(req.user!.workspaceId, id, text, nonce);
        if (res === 'not_found') return reply.code(404).send('Not found');
        if (res !== 'sent') return fail(req, reply, id, 'window_closed');
        await data.clearWaiting(id);
        return done(req, reply, id, 'sent');
      } catch (e) {
        req.log.warn({ err: e }, 'manual send failed');
        return fail(req, reply, id, 'send_failed', 502);
      }
    });

    r.post('/app/inbox/:id/note', perm('inbox.manage'), async (req, reply) => {
      const c = await owned(req);
      const body = z
        .string()
        .trim()
        .min(1)
        .max(2000)
        .safeParse((req.body as any)?.body).data;
      if (!c || !body) return fail(req, reply, c?.id ?? '', 'invalid');
      await data.addNote(c.workspace_id, c.id, req.user!.id, body);
      await publish(c.workspace_id, { type: 'conversation', conversationId: c.id });
      return done(req, reply, c.id);
    });

    r.post('/app/inbox/:id/status', perm('inbox.manage'), async (req, reply) => {
      const c = await owned(req);
      const status = z.enum(['open', 'closed']).safeParse((req.body as any)?.status).data;
      if (!c || !status) return fail(req, reply, c?.id ?? '', 'invalid');
      await data.setStatus(c.id, status);
      await audit(c.workspace_id, req.user!.id, `conversation.${status === 'closed' ? 'close' : 'reopen'}`, 'conversation', c.id);
      await publish(c.workspace_id, { type: 'conversation', conversationId: c.id });
      return done(req, reply, c.id);
    });

    r.post('/app/inbox/:id/assign', perm('inbox.manage'), async (req, reply) => {
      const c = await owned(req);
      const raw0 = String((req.body as any)?.user_id ?? '');
      const target = raw0 === 'me' ? req.user!.id : raw0 === '' ? null : z.uuid().safeParse(raw0).data;
      if (!c || target === undefined) return fail(req, reply, c?.id ?? '', 'invalid');
      if (target && !(await data.isAssignable(c.workspace_id, target))) return fail(req, reply, c.id, 'invalid');
      await data.assign(c.id, target);
      await audit(c.workspace_id, req.user!.id, target ? 'conversation.assign' : 'conversation.unassign', 'conversation', c.id, { to: target });
      await publish(c.workspace_id, { type: 'conversation', conversationId: c.id });
      return done(req, reply, c.id);
    });

    r.post('/app/inbox/:id/ai', perm('inbox.manage'), async (req, reply) => {
      const c = await owned(req);
      if (!c) return reply.code(404).send('Not found');
      const resume = (req.body as any)?.action === 'resume';
      await data.setBot(c.id, resume);
      await audit(c.workspace_id, req.user!.id, resume ? 'conversation.bot_resume' : 'conversation.bot_pause', 'conversation', c.id);
      await publish(c.workspace_id, { type: 'conversation', conversationId: c.id });
      return done(req, reply, c.id);
    });

    r.post('/app/inbox/:id/delete', perm('inbox.manage'), async (req, reply) => {
      const c = await owned(req);
      if (c) {
        await data.deleteConversation(c.id);
        await audit(c.workspace_id, req.user!.id, 'conversation.delete', 'conversation', c.id);
      }
      return reply.redirect('/app/inbox?m=saved');
    });

    // ----- Contact edits from the profile panel -----
    const backTo = async (req: FastifyRequest, reply: FastifyReply, contactId: string) => {
      const conv = await data.latestConversationOf(contactId);
      if (conv) await publish(conv.workspace_id, { type: 'conversation', conversationId: conv.id });
      if (wantsJson(req)) return reply.send({ ok: true });
      return reply.redirect(conv && (req.body as any)?.back !== 'contact' ? `/app/inbox/${conv.id}?m=saved` : `/app/contacts/${contactId}?m=saved`);
    };
    r.post('/app/contacts/:id/tags', perm('contacts.write'), async (req, reply) => {
      const ct = await ownedContact(req);
      const b = req.body as any;
      const name = z.string().trim().min(1).max(40);
      if (!ct) return reply.code(404).send('Not found');
      if (name.safeParse(b?.add).success) await addTags(ct, [b.add]);
      if (name.safeParse(b?.remove).success) await removeTags(ct, [b.remove]);
      await audit(ct.workspace_id, req.user!.id, 'contact.tags', 'contact', ct.id, { add: b?.add ?? null, remove: b?.remove ?? null });
      return backTo(req, reply, ct.id);
    });
    r.post('/app/contacts/:id/fields', perm('contacts.write'), async (req, reply) => {
      const ct = await ownedContact(req);
      const b = req.body as any;
      if (!ct || !FIELD_KEY.test(String(b?.key ?? ''))) return reply.code(400).send({ ok: false, error: 'Sahə açarı: kiçik hərf, rəqəm, _' });
      if (b.delete === '1') await data.deleteContactField(ct.id, b.key);
      else {
        const v = z.string().max(500).safeParse(b.value);
        if (!v.success) return reply.code(400).send({ ok: false });
        await data.setContactField(ct.id, b.key, v.data);
      }
      return backTo(req, reply, ct.id);
    });
    r.post('/app/contacts/:id/flags', perm('contacts.write'), async (req, reply) => {
      const ct = await ownedContact(req);
      const b = req.body as any;
      if (!ct) return reply.code(404).send('Not found');
      for (const k of ['opted_out', 'blocked'] as const) {
        if (b?.[k] === '1' || b?.[k] === '0') {
          await data.setContactFlag(ct.id, k, b[k] === '1');
          await audit(ct.workspace_id, req.user!.id, `contact.${k}`, 'contact', ct.id, { value: b[k] === '1' });
        }
      }
      return backTo(req, reply, ct.id);
    });

    // WhatsApp media needs an authenticated download: proxied after tenant check.
    r.get('/app/media/:id/:i', async (req, reply) => {
      const id = idParam(req);
      const i = Number((req.params as any).i);
      const m = id ? await data.messageMedia(req.user!.workspaceId, id) : undefined;
      const item = Array.isArray(m?.media) ? m.media[i] : undefined;
      if (!m || !item?.id || m.type !== 'whatsapp') return reply.code(404).send('');
      try {
        const f = await fetchWhatsAppMedia(decrypt(m.access_token_enc), item.id);
        return reply
          .header('Cache-Control', 'private, max-age=3600')
          .header('X-Content-Type-Options', 'nosniff')
          .type(/^(image|video|audio)\//.test(f.mime) ? f.mime : 'application/octet-stream')
          .send(Buffer.from(f.body));
      } catch {
        return reply.code(502).send('');
      }
    });

    // ----- Saved replies -----
    r.get('/app/saved-replies', async (req, reply) =>
      view(req, reply, 'Hazır cavablar', savedRepliesHtml(req, await data.savedReplies(req.user!.workspaceId), can(req.user, 'inbox.manage'))),
    );
    r.post('/app/saved-replies', perm('inbox.manage'), async (req, reply) => {
      const p = z.object({ title: z.string().trim().min(1).max(60), body: z.string().trim().min(1).max(1000) }).safeParse(req.body);
      if (p.success) await data.addSavedReply(req.user!.workspaceId, req.user!.id, p.data.title, p.data.body);
      return reply.redirect(`/app/saved-replies?m=${p.success ? 'saved' : 'invalid'}`);
    });
    r.post('/app/saved-replies/:id/delete', perm('inbox.manage'), async (req, reply) => {
      const id = idParam(req);
      if (id) await data.deleteSavedReply(req.user!.workspaceId, id);
      return reply.redirect('/app/saved-replies?m=saved');
    });
  });
}
