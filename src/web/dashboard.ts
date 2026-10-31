import type { FastifyInstance } from 'fastify';
import { subscriptionOf } from '../billing.js';
import type { ChannelRow } from '../channels/types.js';
import { pendingPostCount } from '../commerce/posts.js';
import { config } from '../config.js';
import { urgentConversations } from '../data/inbox.js';
import { one, q } from '../db.js';
import { can, requireUser } from './auth.js';
import { csrfField, html, pageHead } from './html.js';
import { channelIcon, icon } from './icons.js';
import { convRow } from './inbox-views.js';
import { MESSAGES, view } from './public.js';
import { chip, day, stat } from './ui.js';

Object.assign(MESSAGES, {
  expired: { type: 'error', text: 'Abunəliyin müddəti bitib, AI cavablar dayandırılıb. Administratorla əlaqə saxlayın.' },
});

/** Home page: subscription, today's numbers, latest conversations, onboarding checklist. */
export function dashboardRoutes(app: FastifyInstance) {
  app.register(async (r) => {
    r.addHook('preHandler', requireUser);

    // ---------- Dashboard ----------
    r.get('/app', async (req, reply) => {
      const w = req.user!.workspaceId;
      const [sub, a, chans, counts, recent, pendingPosts] = await Promise.all([
        subscriptionOf(w).then((s) => s!),
        one('SELECT enabled, knowledge FROM assistants WHERE workspace_id = $1', [w]),
        q<ChannelRow>('SELECT type, display_name, status FROM channels WHERE workspace_id = $1', [w]),
        one(
          `SELECT (SELECT count(*)::int FROM messages WHERE workspace_id = $1 AND direction = 'in' AND created_at >= (now() AT TIME ZONE 'Asia/Baku')::date AT TIME ZONE 'Asia/Baku') AS today,
                  (SELECT count(*)::int FROM conversations WHERE workspace_id = $1 AND needs_human) AS waiting`,
          [w],
        ),
        can(req.user, 'inbox.view') ? urgentConversations(w) : Promise.resolve([]),
        config.commerceEnabled && can(req.user, 'integrations.manage') ? pendingPostCount(w) : Promise.resolve(0),
      ]);
      const pct = sub.replyLimit ? Math.min(100, Math.round((sub.repliesUsed / sub.replyLimit) * 100)) : 100;
      const ob = await one(
        `SELECT w.onboarding_dismissed_at IS NOT NULL AS dismissed,
           EXISTS (SELECT 1 FROM knowledge_items k WHERE k.workspace_id = $1) AS kb,
           EXISTS (SELECT 1 FROM ai_usage u WHERE u.workspace_id = $1 AND u.purpose = 'test') AS tested,
           EXISTS (SELECT 1 FROM automations x WHERE x.workspace_id = $1 AND x.status = 'active') AS automation,
           EXISTS (SELECT 1 FROM notify_targets n WHERE n.workspace_id = $1) AS notify,
           (SELECT count(*) FROM memberships m WHERE m.workspace_id = $1) > 1 AS team
         FROM workspaces w WHERE w.id = $1`,
        [w],
      );
      const steps: [boolean, string, string, string][] = [
        [a.knowledge.length > 50 || ob.kb, 'Biznes məlumatlarını yazın', 'Qiymətlər, iş saatları, çatdırılma — AI yalnız bunlara əsaslanır', '/app/knowledge'],
        [chans.length > 0, 'Instagram və ya WhatsApp bağlayın', 'Rəsmi Meta girişi ilə, şifrə paylaşmadan', '/app/channels'],
        [ob.tested, 'AI-ni sınayın', '"Test et" bölməsində müştəri kimi yazın', '/app/test'],
        [a.enabled, 'AI cavabları aktiv edin', 'Hazır olduqda bir kliklə', '/app/assistant'],
        [ob.automation, 'İlk avtomatlaşdırmanı qurun', 'Məs: şərhə DM ilə cavab, açar sözə cavab', '/app/automations/new'],
        [ob.notify, 'Bildirişləri qoşun', 'Operator lazım olanda WhatsApp/Telegram/Chrome ilə xəbər', '/app/settings'],
        [ob.team, 'Komandanı dəvət edin (istəyə bağlı)', 'Operator və analitik rolları', '/app/team'],
      ];
      const doneN = steps.filter((x) => x[0]).length;
      const allDone = ob.dismissed || doneN === steps.length || !can(req.user, 'assistant.write');
      return view(
        req,
        reply,
        'Panel',
        html`${sub.expired ? html`<p class="flash error">${icon('alert')}<span>${MESSAGES.expired!.text}</span></p>` : ''}
        ${
          pendingPosts
            ? html`<p class="flash ok">${icon('instagram')}<span><b>${pendingPosts} yeni post</b> məhsul seçiminizi gözləyir. <a href="/app/posts">Postlara keç →</a></span></p>`
            : ''
        }
        ${pageHead(
          sub.name,
          html`AI köməkçi: ${a.enabled ? chip('ok', 'Aktiv') : chip('neutral', 'Deaktiv')}${sub.paidUntil ? html` · Abunəlik: <b>${day(sub.paidUntil)}</b> tarixinə qədər` : ''}`,
          html`<a class="btn" href="/app/inbox">${icon('chat')}Söhbətlərə keç</a>`,
        )}
        <div class="stats">
          ${stat('inbox', 'Bu gün gələn mesajlar', counts.today)}
          ${stat('bot', 'Bu ay AI cavabları', html`${sub.repliesUsed}<small> / ${sub.replyLimit}</small>`, html`<span class="bar"><span style="width:${pct}%"></span></span>`)}
          ${stat('headset', 'Operator gözləyir', counts.waiting, counts.waiting ? html`<a href="/app/inbox?f=human">Cavab verin →</a>` : 'Hamısı cavablanıb', counts.waiting ? 'warn' : '')}
          ${stat('plug', 'Bağlı kanallar', chans.length, chans.length ? chans.map((c) => html`${channelIcon(c.type)} `) : html`<a href="/app/channels">Bağlayın →</a>`)}
        </div>
        <div class="cols">
          <section class="card">
            <div class="card-head"><h2>Son söhbətlər</h2><a href="/app/inbox" class="more">Hamısı ${icon('arrow', 'i xs')}</a></div>
            ${
              recent.length
                ? html`<div class="conv-list">${recent.map((c) => convRow(c))}</div>`
                : html`<div class="empty">${icon('chat', 'i lg')}<p>Hələ mesaj yoxdur. Kanal bağlayandan sonra müştəri mesajları burada görünəcək.</p></div>`
            }
          </section>
          <div class="stack">
            ${
              allDone
                ? ''
                : html`<section class="card"><div class="card-head"><h2>Başlanğıc · ${doneN}/${steps.length}</h2>
              <form method="post" action="/app/onboarding/dismiss" class="inline">${csrfField(req.csrfToken)}<button class="btn sm ghost">Gizlət</button></form></div>
              <div class="meter"><i style="width:${Math.round((doneN / steps.length) * 100)}%"></i></div><ol class="steps">${steps.map(
                ([done, t, s, href]) =>
                  html`<li class="${done ? 'done' : ''}"><a href="${href}">${icon(done ? 'check' : 'circle')}<span><b>${t}</b><small>${s}</small></span></a></li>`,
              )}</ol></section>`
            }
            <section class="card how"><h2>Mesajlar necə idarə olunur?</h2>
              <ol>
                <li>${icon('bot')}<span><b>AI avtomatik cavab verir</b><small>Instagram və WhatsApp-a gələn hər mesaja, sizin yazdığınız məlumatlar əsasında.</small></span></li>
                <li>${icon('headset')}<span><b>Bilmədiyini sizə bildirir</b><small>Endirim, şikayət, sifariş təsdiqi kimi hallarda müştəriyə təbii şəkildə "bir dəqiqə" yazır, sizə isə Telegram və ya e-poçtla bildiriş gəlir.</small></span></li>
                <li>${icon('chat')}<span><b>Siz "Söhbətlər"dən cavab verirsiniz</b><small>Bütün yazışmalar orada görünür. Əl ilə yazdıqda AI həmin söhbətdə dayanır.</small></span></li>
              </ol></section>
          </div>
        </div>`,
      );
    });

    r.post('/app/onboarding/dismiss', async (req, reply) => {
      await q(`UPDATE workspaces SET onboarding_dismissed_at = now() WHERE id = $1`, [req.user!.workspaceId]);
      return reply.redirect('/app');
    });
  });
}
