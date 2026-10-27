import type { FastifyInstance } from 'fastify';
import { type AnalyticsFilters, aiStats, automationStats, commentFunnel, daily, filterSchema, overview, windowFor } from '../analytics.js';
import { TRIGGER_LABELS } from '../automations/capabilities.js';
import type { Trigger } from '../automations/schema.js';
import { csvLine } from '../csv.js';
import { q } from '../db.js';
import { requirePerm, requireUser } from './auth.js';
import { html, pageHead, raw, type Safe } from './html.js';
import { icon } from './icons.js';
import { view } from './public.js';
import { chip, pct, stat } from './ui.js';

const nf = new Intl.NumberFormat('az-AZ');
const n = (v: number | null | undefined) => (v === null || v === undefined ? '—' : nf.format(v));
const usd = (v: number) => `$${v < 1 ? v.toFixed(4) : v.toFixed(2)}`;
const dur = (s: number | null) =>
  s === null ? '—' : s < 90 ? `${Math.round(s)} san` : s < 5400 ? `${Math.round(s / 60)} dəq` : `${(s / 3600).toFixed(1)} saat`;

/** Grouped bar chart (incoming vs outgoing per day). Server-rendered SVG; hover tooltip via /public/charts.js. */
function dailyChart(rows: { day: string; incoming: number; outgoing: number }[]): Safe {
  const W = 760,
    H = 220,
    L = 36,
    B = 24,
    T = 8;
  const max = Math.max(4, ...rows.map((r) => Math.max(r.incoming, r.outgoing)));
  const step = 10 ** Math.floor(Math.log10(max)) * (max / 10 ** Math.floor(Math.log10(max)) > 5 ? 2 : 1);
  const top = Math.ceil(max / step) * step;
  const ticks = Array.from({ length: Math.floor(top / step) + 1 }, (_, i) => i * step);
  const y = (v: number) => T + (H - T - B) * (1 - v / top);
  const slot = (W - L) / rows.length;
  const bw = Math.max(2, Math.min(18, (slot - 6) / 2 - 1));
  const every = Math.ceil(rows.length / 8);
  const bar = (x: number, v: number, cls: string) => {
    if (!v) return '';
    const h = Math.max(1, y(0) - y(v));
    const r = Math.min(4, bw / 2, h);
    // rounded data-end, square at the baseline
    return `<path class="${cls}" d="M${x},${y(0)} V${y(v) + r} Q${x},${y(v)} ${x + r},${y(v)} H${x + bw - r} Q${x + bw},${y(v)} ${x + bw},${y(v) + r} V${y(0)} Z"/>`;
  };
  const svg = `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Gündəlik gələn və gedən mesajlar">
    ${ticks.map((t) => `<line class="grid" x1="${L}" x2="${W}" y1="${y(t)}" y2="${y(t)}"/><text class="tick" x="${L - 6}" y="${y(t) + 4}" text-anchor="end">${t}</text>`).join('')}
    ${rows
      .map((r, i) => {
        const x0 = L + i * slot + (slot - (bw * 2 + 2)) / 2;
        const label = r.day.slice(5).replace('-', '.');
        return `<g class="col" tabindex="0" data-day="${label}" data-a="${r.incoming}" data-b="${r.outgoing}">
        <rect class="hit" x="${L + i * slot}" y="${T}" width="${slot}" height="${H - T - B}"/>${bar(x0, r.incoming, 's1')}${bar(x0 + bw + 2, r.outgoing, 's2')}
        ${i % every === 0 ? `<text class="tick" x="${L + i * slot + slot / 2}" y="${H - 6}" text-anchor="middle">${label}</text>` : ''}</g>`;
      })
      .join('')}
  </svg>`;
  return raw(svg);
}

const DEFINITIONS: [string, string][] = [
  ['Söhbətlər', 'Seçilmiş dövrdə ən azı bir mesaj olan söhbətlər.'],
  ['Yeni söhbətlər', 'İlk mesajı seçilmiş dövrə düşən söhbətlər.'],
  ['Gələn / gedən mesajlar', 'Müştəridən gələn mesajlar / uğurla göndərilmiş (Meta qəbul etmiş) cavablar: AI, avtomatlaşdırma və operator.'],
  ['Unikal kontaktlar', 'Dövrdə ən azı bir mesaj yazan fərqli şəxslər.'],
  ['Cavab müddəti', 'Müştərinin növbəti mesaj seriyasının ilk mesajından ilk göndərilmiş cavaba qədər (7 gündən uzun gözləmələr xaric). Median və orta.'],
  ['Operatora ötürülən', 'Bot/AI-nin söhbəti əməkdaşa ötürdüyü hallar (hər ötürmə bir dəfə).'],
  ['Avtomatlaşdırma icraları', 'Bir trigger hadisəsi (şərh/mesaj) üçün bir icra. Uğurlu = ən azı bir mesaj Meta tərəfindən qəbul edilib.'],
  ['Trigger hadisələri', 'Yalnız şərh avtomatlaşdırmaları üçün ölçülür: əhatə olunan postlara gələn şərhlər.'],
  ['Cavab yazanlar', 'Avtomatlaşdırma mesajından sonra 24 saat ərzində həmin şəxsdən gələn DM.'],
  ['Link klikləri', '"Linkləri izlə" aktiv olan mesajlardakı /r/ linklərinə kliklər (IP saxlanılmır).'],
  ['AI xərci', 'config/ai-models.json-dakı siyahı qiymətlərinə görə TƏXMİNİ hesablanır; Anthropic hesab-fakturası deyil.'],
  ['Çatdırılma, konversiya', 'Meta bu məlumatı vermir / hadisə təyin edilməyib: göstərilmir (uydurulmur).'],
];

export function analyticsRoutes(app: FastifyInstance) {
  app.register(async (r) => {
    r.addHook('preHandler', requireUser);
    r.addHook('preHandler', requirePerm('analytics.view'));

    r.get('/app/analytics', async (req, reply) => {
      const w0 = req.user!.workspaceId;
      const f = filterSchema.parse(req.query ?? {});
      const w = await windowFor(w0, f);
      const [o, days, autos, funnel, ai, autoList, tags] = await Promise.all([
        overview(w0, f, w),
        daily(w0, f, w),
        automationStats(w0, f, w),
        commentFunnel(w0, f, w),
        aiStats(w0, w),
        q(`SELECT id, name FROM automations WHERE workspace_id = $1 ORDER BY name`, [w0]),
        q(`SELECT id, name FROM tags WHERE workspace_id = $1 ORDER BY name LIMIT 100`, [w0]),
      ]);
      const qs = (over: Partial<AnalyticsFilters>) => `?${new URLSearchParams(Object.entries({ ...f, ...over }).filter(([, v]) => v) as [string, string][])}`;
      const preset = (k: AnalyticsFilters['range'], l: string) =>
        html`<a class="${f.range === k ? 'on' : ''}" href="/app/analytics${qs({ range: k, from: '', to: '' })}">${l}</a>`;
      const funnelMax = Math.max(1, ...funnel.map((s) => s.value ?? 0));
      return view(
        req,
        reply,
        'Analitika',
        html`${pageHead('Analitika', `${w.from.toISOString().slice(0, 10)} – ${new Date(w.to.getTime() - 1).toISOString().slice(0, 10)} (Bakı vaxtı)`)}
        <form class="filters" method="get" action="/app/analytics">
          <div class="seg">${preset('today', 'Bu gün')}${preset('7d', '7 gün')}${preset('30d', '30 gün')}</div>
          <input type="hidden" name="range" value="${f.from && f.to ? 'custom' : f.range}"><input type="date" name="from" value="${f.from}" aria-label="Başlanğıc"><input type="date" name="to" value="${f.to}" aria-label="Son"><button class="btn sm secondary">Tətbiq et</button>
          <select name="ch" data-autosubmit aria-label="Kanal"><option value="">Bütün kanallar</option><option value="instagram" ${f.ch === 'instagram' ? raw('selected') : ''}>Instagram</option><option value="whatsapp" ${f.ch === 'whatsapp' ? raw('selected') : ''}>WhatsApp</option></select>
          <select name="automation" data-autosubmit aria-label="Avtomatlaşdırma"><option value="">Bütün avtomatlaşdırmalar</option>${autoList.map((a) => html`<option value="${a.id}" ${a.id === f.automation ? raw('selected') : ''}>${a.name}</option>`)}</select>
          <select name="tag" data-autosubmit aria-label="Tag"><option value="">Bütün tag-lər</option>${tags.map((t) => html`<option value="${t.id}" ${t.id === f.tag ? raw('selected') : ''}>${t.name}</option>`)}</select>
          <details class="export"><summary class="btn sm secondary">${icon('download')}CSV</summary><div>
            ${['daily', 'automations', 'ai', 'conversations'].map((t) => html`<a href="/app/analytics/export.csv${qs({})}&type=${t}">${{ daily: 'Gündəlik', automations: 'Avtomatlaşdırmalar', ai: 'AI istifadəsi', conversations: 'Söhbətlər' }[t]}</a>`)}</div></details>
        </form>
        ${w.clamped ? html`<p class="hint">${icon('alert', 'i xs')} Tarifiniz yalnız son tarixçəni göstərir; başlanğıc tarixi qısaldıldı.</p>` : ''}
        <div class="stats">
          ${stat('chat', 'Söhbətlər', n(o.conversations), `Yeni: ${n(o.new_conversations)} · Oxunmamış: ${n(o.unread_now)}`)}
          ${stat('inbox', 'Gələn / gedən mesajlar', html`${n(o.incoming)}<small> / ${n(o.outgoing)}</small>`, `AI: ${n(o.ai_messages)} · Bot: ${n(o.bot_messages)} · Operator: ${n(o.human_messages)}`)}
          ${stat('users', 'Unikal kontaktlar', n(o.unique_contacts))}
          ${stat('clock', 'Cavab müddəti (median)', dur(o.median_response_s), `Orta: ${dur(o.avg_response_s)} · Operator: ${dur(o.median_human_response_s)}`)}
          ${stat('zap', 'Avtomatlaşdırma icraları', n(o.automation.runs), `Uğurlu: ${n(o.automation.sent)} · Xəta: ${n(o.automation.failed)}`)}
          ${stat('headset', 'Operatora ötürülən', n(o.handoffs), '', o.handoffs ? 'warn' : '')}
          ${stat('alert', 'API xətaları / rate limit', html`${n(o.api_errors)}<small> / ${n(o.rate_limits)}</small>`, `Göndərilməyən: ${n(o.failed_sends)} · Token: ${n(o.token_invalid)} · AI timeout: ${n(o.ai_timeouts)}`, o.api_errors + o.rate_limits ? 'danger' : '')}
        </div>
        <section class="card chart-card"><div class="card-head"><h2>Mesajlar gün üzrə</h2>
          <div class="legend"><span><i class="key s1"></i>Gələn</span><span><i class="key s2"></i>Gedən</span></div></div>
          <div class="chart-wrap">${dailyChart(days)}<div class="tip" hidden></div></div>
          <details class="table-view"><summary>Cədvəl kimi göstər</summary><div class="table-wrap"><table><thead><tr><th>Gün</th><th class="num">Gələn</th><th class="num">Gedən</th></tr></thead>
            <tbody>${days.map((d) => html`<tr><td>${d.day}</td><td class="num">${n(d.incoming)}</td><td class="num">${n(d.outgoing)}</td></tr>`)}</tbody></table></div></details></section>
        <section class="card flush"><div class="card-head pad"><h2>Avtomatlaşdırmalar</h2></div>
          ${
            autos.length
              ? html`<div class="table-wrap"><table><thead><tr><th>Ad</th><th class="num">Trigger hadisəsi</th><th class="num">Uyğun</th><th class="num">Göndərildi</th><th class="num">Xəta</th><th class="num">Kontakt</th><th class="num">Cavab yazdı</th><th class="num">Klik</th><th>Xəta səbəbləri</th></tr></thead><tbody>
            ${autos.map(
              (
                a,
              ) => html`<tr><td><a class="strong" href="/app/automations/${a.id}">${a.name}</a><small class="muted block">${TRIGGER_LABELS[a.trigger as Trigger]?.title ?? a.trigger}</small></td>
              <td class="num">${a.trigger_events === null ? html`<span class="muted" title="Yalnız şərh avtomatlaşdırmaları üçün ölçülür">—</span>` : n(a.trigger_events)}</td>
              <td class="num">${n(a.matched)}</td><td class="num">${n(a.sent)} <small class="muted">${pct(a.sent, a.matched)}</small></td><td class="num">${a.failed ? chip('danger', n(a.failed)) : '0'}</td>
              <td class="num">${n(a.contacts)}</td><td class="num">${n(a.replied)} <small class="muted">${pct(a.replied, a.sent)}</small></td><td class="num">${n(a.clicks)}</td>
              <td class="muted">${
                Object.entries(a.failure_reasons as Record<string, number>)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join(', ') || '—'
              }</td></tr>`,
            )}</tbody></table></div>`
              : html`<p class="muted pad">Avtomatlaşdırma yoxdur.</p>`
          }</section>
        <section class="card"><h2>Şərhdən DM funnel-i</h2><p class="muted">Hər addım əvvəlkinin alt çoxluğudur. Meta-nın vermədiyi göstəricilər uydurulmur.</p>
          <div class="funnel">${funnel.map((s, i) => {
            const prev = i
              ? (funnel
                  .slice(0, i)
                  .reverse()
                  .find((x) => x.value !== null)?.value ?? null)
              : null;
            return html`<div class="f-row ${s.value === null ? 'na' : ''}"><span class="f-label">${s.label}<small>${s.note}</small></span>
              <span class="f-bar">${s.value === null ? html`<em>${s.key === 'delivered' ? 'ölçülmür' : 'mövcud deyil'}</em>` : html`<i style="width:${Math.max(0.5, (s.value / funnelMax) * 100)}%"></i>`}</span>
              <span class="f-val">${s.value === null ? '—' : n(s.value)}${s.value !== null && prev ? html`<small> ${pct(s.value, prev)}</small>` : ''}</span></div>`;
          })}</div></section>
        <section class="card"><h2>AI istifadəsi və xərci</h2>
          <div class="stats compact">
            ${stat('bot', 'Claude çağırışları', n(ai.calls), `Cavab: ${n(ai.reply_calls)} · Xülasə: ${n(ai.summaries)} · Sürətli model: ${n(ai.fast)}`)}
            ${stat('sparkle', 'Təxmini xərc', usd(ai.cost), `Cavab başına: ${usd(ai.avg_cost_reply)}`)}
            ${stat('book', 'Tokenlər (giriş / çıxış)', html`${n(ai.input)}<small> / ${n(ai.output)}</small>`, `Cache oxuma: ${n(ai.cache_read)} · yazma: ${n(ai.cache_write)} · cavab başına ort.: ${n(Math.round(ai.avg_tokens_reply))}`)}
            ${stat('alert', 'Timeout / xəta / imtina', html`${n(ai.timeouts)}<small> / ${n(ai.errors)} / ${n(ai.refusals)}</small>`, `Orta gecikmə: ${n(ai.avg_latency_ms)} ms`, ai.timeouts + ai.errors ? 'warn' : '')}
          </div>
          ${
            ai.models.length
              ? html`<div class="table-wrap"><table><thead><tr><th>Model</th><th class="num">Çağırış</th><th class="num">Giriş</th><th class="num">Çıxış</th><th class="num">Cache oxuma</th><th class="num">Cache yazma</th><th class="num">Təxmini $</th></tr></thead><tbody>
            ${ai.models.map((m: any) => html`<tr><td>${m.model}</td><td class="num">${n(m.calls)}</td><td class="num">${n(Number(m.input))}</td><td class="num">${n(Number(m.output))}</td><td class="num">${n(Number(m.cache_read))}</td><td class="num">${n(Number(m.cache_write))}</td><td class="num">${usd(m.cost)}</td></tr>`)}</tbody></table></div>`
              : ''
          }
          <p class="hint">Xərc config/ai-models.json-dakı siyahı qiymətləri ilə hesablanmış təxmindir; faktiki məbləğ Anthropic hesabınızdadır.</p></section>
        <details class="card defs"><summary><b>Metriklərin tərifləri</b></summary><dl>${DEFINITIONS.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl></details>`,
        html`<script src="/public/charts.js" defer></script>`,
      );
    });

    // CSV export. Aggregates are small; the conversation list streams in keyset batches so large workspaces don't block the DB.
    r.get('/app/analytics/export.csv', async (req, reply) => {
      const w0 = req.user!.workspaceId;
      const f = filterSchema.parse(req.query ?? {});
      const w = await windowFor(w0, f);
      const type = String((req.query as any)?.type ?? 'daily');
      const line = csvLine;
      reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="ai-reply-${type}-${w.from.toISOString().slice(0, 10)}.csv"`);
      if (type === 'daily')
        return reply.send(['﻿day,incoming,outgoing\n', ...(await daily(w0, f, w)).map((d) => line([d.day, d.incoming, d.outgoing]))].join(''));
      if (type === 'automations') {
        const rows = await automationStats(w0, f, w);
        return reply.send(
          [
            '﻿name,trigger,trigger_events,matched,attempted,sent,failed,contacts,replied,clicks\n',
            ...rows.map((a) => line([a.name, a.trigger, a.trigger_events, a.matched, a.attempted, a.sent, a.failed, a.contacts, a.replied, a.clicks])),
          ].join(''),
        );
      }
      if (type === 'ai') {
        const rows = await q(
          `SELECT created_at, purpose, route, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, est_cost_usd, latency_ms, outcome FROM ai_usage WHERE workspace_id = $1 AND created_at >= $2 AND created_at < $3 ORDER BY created_at LIMIT 100000`,
          [w0, w.from, w.to],
        );
        return reply.send(
          [
            '﻿created_at,purpose,route,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,est_cost_usd,latency_ms,outcome\n',
            ...rows.map((r) => line(Object.values(r))),
          ].join(''),
        );
      }
      if (type !== 'conversations') return reply.code(400).send('unknown type');
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="ai-reply-conversations-${w.from.toISOString().slice(0, 10)}.csv"`,
      });
      res.write('﻿conversation_id,contact,channel,status,incoming,outgoing,first_message,last_message\n');
      let cursor = '00000000-0000-0000-0000-000000000000';
      for (;;) {
        const batch = await q(
          `SELECT c.id, coalesce(nullif(ct.username, ''), c.display_name) AS contact, ch.type, c.status,
                  count(m.id) FILTER (WHERE m.direction = 'in')::int AS incoming, count(m.id) FILTER (WHERE m.direction = 'out' AND m.status = 'sent')::int AS outgoing,
                  min(m.created_at) AS first, max(m.created_at) AS last
           FROM conversations c JOIN channels ch ON ch.id = c.channel_id LEFT JOIN contacts ct ON ct.id = c.contact_id
           JOIN messages m ON m.conversation_id = c.id AND m.created_at >= $2 AND m.created_at < $3
           WHERE c.workspace_id = $1 AND c.id > $4 AND ($5 = '' OR ch.type = $5)
           GROUP BY c.id, ct.username, ch.type ORDER BY c.id LIMIT 1000`,
          [w0, w.from, w.to, cursor, f.ch],
        );
        for (const r of batch) res.write(line([r.id, r.contact, r.type, r.status, r.incoming, r.outgoing, r.first, r.last]));
        if (batch.length < 1000) break;
        cursor = batch.at(-1)!.id;
      }
      res.end();
    });
  });
}
