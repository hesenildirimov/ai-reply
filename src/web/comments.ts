import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { recentMedia } from '../channels/instagram.js';
import type { ChannelRow } from '../channels/types.js';
import { afterCommentDm, type CommentRow, privateReplyOpen, setCommentStatus } from '../comments.js';
import { businessFacts } from '../context.js';
import { deliver, inWindow, loadConv } from '../conversation.js';
import { decrypt } from '../crypto.js';
import { one, q } from '../db.js';
import { audit } from '../events.js';
import { publicTextOk } from '../guard.js';
import { openText, sealText } from '../messages.js';
import { can, requirePerm, requireUser } from './auth.js';
import { csrfField, html, pageHead, raw } from './html.js';
import { icon } from './icons.js';
import { MESSAGES, view } from './public.js';
import { type ChipTone, chip, empty, fmt } from './ui.js';

Object.assign(MESSAGES, {
  comments_saved: { type: 'ok', text: 'Şərh ayarları yadda saxlanıldı.' },
  comment_sent: { type: 'ok', text: 'Cavab göndərildi.' },
  comment_rejected: { type: 'ok', text: 'Cavab rədd edildi, heç nə göndərilmədi.' },
  comment_public_unsafe: { type: 'error', text: 'İctimai cavabda qiymət, rəqəm, link və ya telefon olmamalıdır.' },
  comment_expired: { type: 'error', text: 'Bu şərhə artıq şəxsi cavab göndərmək olmur (Meta: 7 gün). Müştəriyə inboxdan yazın.' },
  comment_send_failed: { type: 'error', text: 'Meta cavabı qəbul etmədi. Bir az sonra yenidən cəhd edin.' },
});

const STATUS: Record<string, [ChipTone, string]> = {
  queued: ['info', 'Cavablanır'],
  pending_approval: ['warn', 'Təsdiq gözləyir'],
  replied: ['ok', 'Cavablandı'],
  invited: ['ok', 'DM-ə dəvət edildi'],
  handoff: ['danger', 'Əməkdaşa ötürüldü'],
  skipped: ['neutral', 'Cavab lazım deyil'],
  rejected: ['neutral', 'Rədd edildi'],
  failed: ['danger', 'Göndərilmədi'],
};

const settingsSchema = z.object({
  comment_ai: z.literal('1').optional(),
  comment_approval: z.literal('1').optional(),
  excluded: z.union([z.string(), z.array(z.string())]).optional(),
});

/** Comment answers: settings, drafts waiting for approval and recent comments with what the AI did. */
export function commentRoutes(app: FastifyInstance) {
  app.register(async (r) => {
    r.addHook('preHandler', requireUser);
    // Comment text and the DM drafts are customer content: same rule as the inbox.
    r.addHook('preHandler', requirePerm('inbox.view'));

    const ownedComment = (req: FastifyRequest) =>
      one<CommentRow>(`SELECT * FROM ig_comments WHERE id = $1 AND workspace_id = $2`, [
        String((req.params as { id?: string }).id ?? '').slice(0, 100),
        req.user!.workspaceId,
      ]);

    r.get('/app/comments', async (req, reply) => {
      const w = req.user!.workspaceId;
      const a = await one(`SELECT enabled, comment_ai, comment_approval, comment_excluded_media FROM assistants WHERE workspace_id = $1`, [w]);
      const manage = can(req.user, 'assistant.write');
      const ch = manage
        ? await one<ChannelRow>(`SELECT * FROM channels WHERE workspace_id = $1 AND type = 'instagram' AND status = 'active' LIMIT 1`, [w])
        : undefined;
      const posts = ch ? await recentMedia(decrypt(ch.access_token_enc)).catch(() => null) : null;
      const pending = await q<CommentRow>(
        `SELECT * FROM ig_comments WHERE workspace_id = $1 AND ai_status = 'pending_approval' ORDER BY received_at LIMIT 50`,
        [w],
      );
      const recent = await q<CommentRow>(`SELECT * FROM ig_comments WHERE workspace_id = $1 AND ai_status IS NOT NULL ORDER BY received_at DESC LIMIT 50`, [w]);
      const excluded = new Set<string>(a?.comment_excluded_media ?? []);
      const who = (c: CommentRow) => (c.from_username ? `@${c.from_username}` : c.from_id);
      const answer = can(req.user, 'inbox.reply');
      return view(
        req,
        reply,
        'Şərhlər',
        html`${pageHead('Şərhlər', 'AI Instagram şərhlərini oxuyur: suallara DM-də cavab yazır, şərhin altına qısa cavab qoyur, şikayətləri sizə ötürür.')}
        ${
          manage
            ? html`<form method="post" action="/app/comments/settings" class="card">${csrfField(req.csrfToken)}
            <label class="switch-row"><span><b>Şərhlərə AI cavab versin</b><small>Açar sözlü avtomatlaşdırmalar üstündür: onların tutmadığı şərhlərə AI cavab yazır.
              ${a?.enabled ? '' : 'Diqqət: AI köməkçi söndürülüb, əvvəlcə onu aktiv edin.'}</small></span>
              <input type="checkbox" class="switch" name="comment_ai" value="1" ${a?.comment_ai ? raw('checked') : ''}></label>
            <label class="switch-row"><span><b>Göndərməzdən əvvəl təsdiqləyim</b><small>AI cavabı hazırlayır, siz aşağıda baxıb "Göndər" basırsınız.</small></span>
              <input type="checkbox" class="switch" name="comment_approval" value="1" ${a?.comment_approval ? raw('checked') : ''}></label>
            <h3>AI cavab verməyəcək postlar</h3>
            ${
              posts === null
                ? html`<p class="muted">${ch ? 'Instagram postlarını yükləmək alınmadı, bir az sonra yeniləyin.' : 'Instagram bağlı deyil.'}</p>`
                : posts.length
                  ? html`<div class="post-pick">${posts.map(
                      (p) => html`<label class="switch-row compact"><span>${p.caption || p.type || p.id}<small>${fmt(p.timestamp || null)}</small></span>
                      <input type="checkbox" name="excluded" value="${p.id}" ${excluded.has(p.id) ? raw('checked') : ''}></label>`,
                    )}</div>`
                  : html`<p class="muted">Hələ post yoxdur.</p>`
            }
            ${[...excluded].filter((id) => !posts?.some((p) => p.id === id)).map((id) => html`<input type="hidden" name="excluded" value="${id}">`)}
            <button class="btn">${icon('check')}Yadda saxla</button></form>`
            : ''
        }
        <section class="card"><div class="card-head"><h2>${icon('clock')}Təsdiq gözləyir</h2></div>
          ${
            pending.length
              ? pending.map(
                  (c) => html`<form method="post" action="/app/comments/${c.id}/approve" class="comment-draft">${csrfField(req.csrfToken)}
                  <p><b>${who(c)}</b> <span class="muted">${fmt(c.received_at)}</span><br>${c.body}</p>
                  <label>DM cavabı<textarea name="dm" rows="3" maxlength="1000" required>${openText(c.dm_draft)}</textarea></label>
                  <label>Şərhin altına (boş qoysanız yazılmır)<input name="public" maxlength="300" value="${openText(c.public_reply)}"></label>
                  ${
                    answer
                      ? html`<div class="row"><button class="btn">${icon('send')}Göndər</button>
                      <button class="btn secondary" formaction="/app/comments/${c.id}/reject" formnovalidate>Rədd et</button></div>`
                      : ''
                  }</form>`,
                )
              : empty('check', 'Təsdiq gözləyən cavab yoxdur.')
          }</section>
        <section class="card"><div class="card-head"><h2>${icon('chat')}Son şərhlər</h2></div>
          ${
            recent.length
              ? html`<table class="table"><thead><tr><th>Kim</th><th>Şərh</th><th>Vəziyyət</th><th>Vaxt</th></tr></thead><tbody>${recent.map((c) => {
                  const [tone, label] = STATUS[c.ai_status ?? ''] ?? ['neutral', c.ai_status ?? ''];
                  return html`<tr><td>${c.conversation_id ? html`<a href="/app/inbox/${c.conversation_id}">${who(c)}</a>` : who(c)}</td>
                    <td>${c.body.slice(0, 160)}</td><td>${chip(tone, label)}</td><td>${fmt(c.received_at)}</td></tr>`;
                })}</tbody></table>`
              : empty('chat', 'Hələ AI-nin baxdığı şərh yoxdur.')
          }</section>`,
      );
    });

    r.post('/app/comments/settings', { preHandler: requirePerm('assistant.write') }, async (req, reply) => {
      const p = settingsSchema.safeParse(req.body);
      if (!p.success) return reply.redirect('/app/comments?m=invalid');
      const excluded = [p.data.excluded ?? []]
        .flat()
        .filter((id) => /^\d{1,30}$/.test(id))
        .slice(0, 200);
      await q(`UPDATE assistants SET comment_ai = $2, comment_approval = $3, comment_excluded_media = $4, updated_at = now() WHERE workspace_id = $1`, [
        req.user!.workspaceId,
        !!p.data.comment_ai,
        !!p.data.comment_approval,
        excluded,
      ]);
      await audit(req.user!.workspaceId, req.user!.id, 'assistant.comments', 'workspace', req.user!.workspaceId, {
        comment_ai: !!p.data.comment_ai,
        approval: !!p.data.comment_approval,
        excluded: excluded.length,
      });
      return reply.redirect('/app/comments?m=comments_saved');
    });

    r.post(
      '/app/comments/:id/approve',
      { preHandler: requirePerm('inbox.reply'), config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
      async (req, reply) => {
        const c = await ownedComment(req);
        if (c?.ai_status !== 'pending_approval' || !c.conversation_id || !c.message_id) return reply.code(404).send('Not found');
        const p = z.object({ dm: z.string().trim().min(1).max(1000), public: z.string().trim().max(300).default('') }).safeParse(req.body);
        if (!p.success) return reply.redirect('/app/comments?m=invalid');
        const conv = await loadConv(c.conversation_id);
        if (!conv) return reply.code(404).send('Not found');
        // Staff can edit the public text, but the same rule holds: no amounts, links or phone numbers under a comment.
        const facts = await businessFacts(
          c.workspace_id,
          (await one(`SELECT knowledge FROM assistants WHERE workspace_id = $1`, [c.workspace_id]))?.knowledge ?? '',
        );
        if (p.data.public && !publicTextOk(p.data.public, facts)) return reply.redirect('/app/comments?m=comment_public_unsafe');
        const via = inWindow(conv) ? undefined : privateReplyOpen(c) ? { commentId: c.id } : null;
        if (via === null) return reply.redirect('/app/comments?m=comment_expired');
        try {
          await deliver(conv, p.data.dm, 'ai', `ai:${c.message_id}`, via, via ? 'private_reply' : 'text');
        } catch {
          return reply.redirect('/app/comments?m=comment_send_failed');
        }
        const updated = { ...c, public_reply: sealText(p.data.public) };
        await q(`UPDATE ig_comments SET public_reply = $2, dm_draft = '' WHERE id = $1`, [c.id, updated.public_reply]);
        await afterCommentDm(updated, conv.channel);
        await audit(c.workspace_id, req.user!.id, 'comment.approved', 'conversation', c.conversation_id, { comment_id: c.id });
        return reply.redirect('/app/comments?m=comment_sent');
      },
    );

    r.post('/app/comments/:id/reject', { preHandler: requirePerm('inbox.reply') }, async (req, reply) => {
      const c = await ownedComment(req);
      if (c?.ai_status !== 'pending_approval') return reply.code(404).send('Not found');
      await setCommentStatus(c.id, 'rejected', { dm_draft: '' });
      await audit(c.workspace_id, req.user!.id, 'comment.rejected', 'conversation', c.conversation_id ?? '', { comment_id: c.id });
      return reply.redirect('/app/comments?m=comment_rejected');
    });
  });
}
