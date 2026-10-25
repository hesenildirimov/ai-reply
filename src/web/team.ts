import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { one, q, tx } from '../db.js';
import { audit } from '../events.js';
import { sendMail } from '../mailer.js';
import { checkLimit } from '../plans.js';
import { requirePerm, requireUser, type Role } from './auth.js';
import { csrfField, html, pageHead, raw } from './html.js';
import { icon } from './icons.js';
import { emailSchema, MESSAGES, passwordLink, view } from './public.js';
import { chip, fmt, idParam, postForm } from './ui.js';

Object.assign(MESSAGES, {
  member_exists: { type: 'error', text: 'Bu e-poçt artıq istifadə olunur (bir istifadəçi yalnız bir biznesə aid ola bilər).' },
  member_limit: { type: 'error', text: 'Tarifinizdə komanda üzvü limiti dolub.' },
  member_forbidden: { type: 'error', text: 'Bu dəyişiklik üçün icazəniz yoxdur.' },
  member_removed: { type: 'ok', text: 'Üzv komandadan çıxarıldı.' },
});

export const ROLE_LABELS: Record<Role, string> = { owner: 'Sahib', admin: 'Admin', agent: 'Operator', analyst: 'Analitik' };
const ROLE_HELP: Record<Exclude<Role, 'owner'>, string> = {
  admin: 'Hər şey (kanallar, avtomatlaşdırma, komanda), sahibi dəyişmək və hesabı silmək xaric',
  agent: 'Söhbətlərə cavab, təyin etmə, kontakt tag/sahələri, analitikaya baxış',
  analyst: 'Yalnız analitikaya baxış',
};
const inviteSchema = z.object({ email: emailSchema, role: z.enum(['admin', 'agent', 'analyst']) });

/** Owners manage everyone except themselves; admins manage agents and analysts only. Nobody changes the owner. */
const mayManage = (actor: Role, target: Role, newRole?: Role) =>
  target !== 'owner' && (actor === 'owner' || (actor === 'admin' && target !== 'admin' && newRole !== 'admin'));

const linkBox = (link: string, email: string) => html`<section class="card link-box"><h2>${icon('link')}Dəvət linki</h2>
  <p>Linki <b>${email}</b> ünvanına göndərin (WhatsApp, e-poçt). Link <b>72 saat</b> etibarlıdır və bir dəfə işləyir.</p>
  <div class="copy-row"><input readonly value="${link}" class="copy" id="invite-link"><button type="button" class="btn secondary" data-copy="invite-link">${icon('link')}Kopyala</button></div>
  ${config.mailEnabled ? html`<p class="muted">Link e-poçtla da göndərildi.</p>` : ''}</section>`;

const AUDIT_GROUPS: Record<string, string> = {
  '': 'Hamısı', 'member.': 'Komanda', 'conversation.': 'Söhbətlər', 'contact.': 'Kontaktlar', 'automation.': 'Avtomatlaşdırma',
  'knowledge.': 'Bilik bazası', 'webhook.': 'İnteqrasiyalar', 'channel.': 'Kanallar', 'ai.': 'AI', 'plan.': 'Tarif limitləri',
};

export function teamRoutes(app: FastifyInstance) {
  app.register(async (r) => {
    r.addHook('preHandler', requireUser);

    const member = async (req: FastifyRequest) => {
      const id = idParam(req);
      return id ? one<{ user_id: string; role: Role; email: string; email_verified_at: Date | null }>(
        `SELECT m.user_id, m.role, u.email, u.email_verified_at FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 AND m.user_id = $2`,
        [req.user!.workspaceId, id],
      ) : undefined;
    };

    r.get('/app/team', { preHandler: requirePerm('team.manage') }, async (req, reply) => {
      const w0 = req.user!.workspaceId;
      const [rows, lim] = await Promise.all([
        q(`SELECT m.user_id, m.role, m.created_at, u.email, u.email_verified_at, u.totp_enabled_at IS NOT NULL AS mfa,
             (SELECT count(*)::int FROM conversations c WHERE c.assignee_user_id = u.id AND c.status = 'open') AS open_assigned
           FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 ORDER BY (m.role = 'owner') DESC, m.created_at`, [w0]),
        checkLimit(w0, 'members'),
      ]);
      const me = req.user!.role;
      const roles = (me === 'owner' ? ['admin', 'agent', 'analyst'] : ['agent', 'analyst']) as Exclude<Role, 'owner'>[];
      return view(req, reply, 'Komanda', html`${pageHead('Komanda', html`${lim.used} / ${lim.limit ?? '∞'} üzv · rollar serverdə yoxlanılır, hər dəyişiklik audit jurnalına yazılır.`,
        html`<a class="btn secondary" href="/app/audit">${icon('list')}Audit jurnalı</a>`)}
        <section class="card"><h2>${icon('plus')}Üzv dəvət et</h2>
          ${lim.ok ? html`<form method="post" action="/app/team/invite" class="grid">${csrfField(req.csrfToken)}
            <label>E-poçt<input name="email" type="email" required maxlength="254"></label>
            <label>Rol<select name="role">${roles.map((r0) => html`<option value="${r0}" ${r0 === 'agent' ? raw('selected') : ''}>${ROLE_LABELS[r0]}</option>`)}</select></label>
            <button class="btn">${icon('plus')}Dəvət linki yarat</button></form>
            <ul class="list-plain hint">${roles.map((r0) => html`<li><b>${ROLE_LABELS[r0]}:</b> ${ROLE_HELP[r0]}</li>`)}</ul>`
          : html`<p class="muted">Tarifinizdə komanda üzvü limiti (${lim.limit}) dolub. Artırmaq üçün bizimlə əlaqə saxlayın.</p>`}
        </section>
        <section class="card flush"><div class="table-wrap"><table><thead><tr><th>Üzv</th><th>Rol</th><th>Açıq söhbətlər</th><th>Qoşulub</th><th></th></tr></thead><tbody>
          ${rows.map((m) => {
            const editable = m.user_id !== req.user!.id && mayManage(me, m.role);
            return html`<tr><td><b>${m.email}</b> ${m.user_id === req.user!.id ? chip('info', 'siz') : ''} ${m.email_verified_at ? '' : chip('neutral', 'link gözləyir')} ${m.mfa ? chip('ok', '2FA') : ''}</td>
            <td>${editable ? html`<form method="post" action="/app/team/${m.user_id}/role" class="inline">${csrfField(req.csrfToken)}<select name="role" data-autosubmit aria-label="Rol">
                ${roles.concat(roles.includes(m.role) ? [] : [m.role]).map((r0) => html`<option value="${r0}" ${r0 === m.role ? raw('selected') : ''}>${ROLE_LABELS[r0 as Role]}</option>`)}</select><noscript><button class="btn sm secondary">OK</button></noscript></form>`
              : ROLE_LABELS[m.role as Role]}</td>
            <td class="num">${m.open_assigned}</td><td class="muted">${fmt(m.created_at)}</td>
            <td class="right"><div class="actions">${editable && !m.email_verified_at ? postForm(`/app/team/${m.user_id}/link`, req.csrfToken, 'Yeni link', 'btn sm secondary') : ''}
              ${editable ? postForm(`/app/team/${m.user_id}/remove`, req.csrfToken, icon('trash'), 'btn sm danger-ghost', { confirm: `${m.email} komandadan çıxarılsın? Ona təyin olunmuş söhbətlər ümumi növbəyə qayıdacaq.` }) : ''}</div></td></tr>`;
          })}
        </tbody></table></div></section>`);
    });

    r.post('/app/team/invite', { preHandler: requirePerm('team.manage'), config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req, reply) => {
      const w0 = req.user!.workspaceId;
      const p = inviteSchema.safeParse(req.body);
      if (!p.success) return reply.redirect('/app/team?m=invalid');
      if (!mayManage(req.user!.role, p.data.role, p.data.role)) return reply.redirect('/app/team?m=member_forbidden');
      if (!(await checkLimit(w0, 'members')).ok) return reply.redirect('/app/team?m=member_limit');
      if (await one('SELECT 1 FROM users WHERE email = $1', [p.data.email])) return reply.redirect('/app/team?m=member_exists');
      const userId = await tx(async (c) => {
        const u = (await c.query(`INSERT INTO users (email, password_hash) VALUES ($1, '!') RETURNING id`, [p.data.email])).rows[0];
        await c.query(`INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, $3)`, [w0, u.id, p.data.role]);
        return u.id as string;
      });
      const link = await passwordLink(userId, '72 hours');
      await audit(w0, req.user!.id, 'member.invite', 'user', userId, { role: p.data.role });
      if (config.mailEnabled) await sendMail(p.data.email, 'AI Reply komandasına dəvət', `Salam! Sizi AI Reply komandasına (${ROLE_LABELS[p.data.role]}) dəvət etdilər.\nŞifrənizi təyin edin (72 saat etibarlıdır):\n${link}`).catch(() => {});
      return view(req, reply, 'Dəvət', html`${pageHead('Dəvət yaradıldı', `${p.data.email} · ${ROLE_LABELS[p.data.role]}`)}${linkBox(link, p.data.email)}<p><a href="/app/team" class="more">${icon('back', 'i xs')} Komanda</a></p>`);
    });

    r.post('/app/team/:id/role', { preHandler: requirePerm('team.manage') }, async (req, reply) => {
      const m = await member(req);
      const role = z.enum(['admin', 'agent', 'analyst']).safeParse((req.body as any)?.role).data;
      if (!m || !role) return reply.redirect('/app/team?m=invalid');
      if (m.user_id === req.user!.id || !mayManage(req.user!.role, m.role, role)) return reply.redirect('/app/team?m=member_forbidden');
      await q(`UPDATE memberships SET role = $3 WHERE workspace_id = $1 AND user_id = $2`, [req.user!.workspaceId, m.user_id, role]);
      // Analysts can't hold conversations.
      if (role === 'analyst') await q(`UPDATE conversations SET assignee_user_id = NULL WHERE workspace_id = $1 AND assignee_user_id = $2`, [req.user!.workspaceId, m.user_id]);
      await audit(req.user!.workspaceId, req.user!.id, 'member.role', 'user', m.user_id, { from: m.role, to: role });
      return reply.redirect('/app/team?m=saved');
    });

    r.post('/app/team/:id/link', { preHandler: requirePerm('team.manage') }, async (req, reply) => {
      const m = await member(req);
      if (!m || m.email_verified_at || m.user_id === req.user!.id || !mayManage(req.user!.role, m.role)) return reply.redirect('/app/team?m=member_forbidden');
      await audit(req.user!.workspaceId, req.user!.id, 'member.link', 'user', m.user_id);
      return view(req, reply, 'Dəvət', html`${pageHead('Yeni dəvət linki', m.email)}${linkBox(await passwordLink(m.user_id, '72 hours'), m.email)}<p><a href="/app/team" class="more">${icon('back', 'i xs')} Komanda</a></p>`);
    });

    r.post('/app/team/:id/remove', { preHandler: requirePerm('team.manage') }, async (req, reply) => {
      const m = await member(req);
      if (!m || m.user_id === req.user!.id || !mayManage(req.user!.role, m.role)) return reply.redirect('/app/team?m=member_forbidden');
      const w0 = req.user!.workspaceId;
      await tx(async (c) => {
        await c.query(`UPDATE conversations SET assignee_user_id = NULL WHERE workspace_id = $1 AND assignee_user_id = $2`, [w0, m.user_id]);
        await c.query(`DELETE FROM memberships WHERE workspace_id = $1 AND user_id = $2`, [w0, m.user_id]);
        await c.query(`DELETE FROM sessions WHERE user_id = $1`, [m.user_id]); // signed out everywhere
        await c.query(`DELETE FROM users WHERE id = $1 AND NOT is_admin AND NOT EXISTS (SELECT 1 FROM memberships x WHERE x.user_id = users.id)`, [m.user_id]);
      });
      await audit(w0, req.user!.id, 'member.remove', 'user', m.user_id, { email: m.email, role: m.role });
      return reply.redirect('/app/team?m=member_removed');
    });

    r.get('/app/audit', { preHandler: requirePerm('audit.view') }, async (req, reply) => {
      const w0 = req.user!.workspaceId;
      const f = z.object({ g: z.enum(Object.keys(AUDIT_GROUPS) as [string, ...string[]]).catch(''), before: z.coerce.number().int().positive().optional().catch(undefined) }).parse(req.query ?? {});
      const rows = await q(
        `SELECT a.id, a.action, a.target_type, a.target_id, a.meta, a.created_at, u.email FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
         WHERE a.workspace_id = $1 AND ($2 = '' OR a.action LIKE $2 || '%') AND ($3::bigint IS NULL OR a.id < $3) ORDER BY a.id DESC LIMIT 101`,
        [w0, f.g, f.before ?? null],
      );
      const page = rows.slice(0, 100);
      const meta = (m: Record<string, unknown>) => Object.entries(m).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(' · ').slice(0, 200);
      return view(req, reply, 'Audit jurnalı', html`<p><a href="/app/team" class="more">${icon('back', 'i xs')} Komanda</a></p>${pageHead('Audit jurnalı', 'Kim, nə vaxt, nəyi dəyişdi. Mesaj mətnləri və gizli açarlar yazılmır.')}
        <div class="filters"><div class="seg">${Object.entries(AUDIT_GROUPS).map(([k, l]) => html`<a class="${f.g === k ? 'on' : ''}" href="/app/audit${k ? `?g=${k}` : ''}">${l}</a>`)}</div></div>
        <section class="card flush"><div class="table-wrap"><table><thead><tr><th>Vaxt</th><th>Kim</th><th>Hadisə</th><th>Hədəf</th><th>Təfərrüat</th></tr></thead><tbody>
          ${page.map((a) => html`<tr><td class="muted nowrap">${fmt(a.created_at)}</td><td>${a.email ?? html`<span class="muted">sistem</span>`}</td><td><code>${a.action}</code></td>
            <td class="muted">${a.target_type}${a.target_id ? html` <small>${String(a.target_id).slice(0, 8)}</small>` : ''}</td><td class="muted">${meta(a.meta)}</td></tr>`)}
        </tbody></table></div>${rows.length > 100 ? html`<div class="pad"><a class="btn sm secondary" href="/app/audit?${new URLSearchParams({ ...(f.g ? { g: f.g } : {}), before: String(page.at(-1).id) })}">Daha köhnə</a></div>` : ''}</section>`);
    });
  });
}
