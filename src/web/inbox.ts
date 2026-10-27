import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { fetchWhatsAppMedia } from '../channels/whatsapp.js';
import { addTags, FIELD_KEY, removeTags } from '../contacts.js';
import { WINDOW_MS } from '../conversation.js';
import { decrypt, randomToken } from '../crypto.js';
import { one, q } from '../db.js';
import { audit } from '../events.js';
import { sendManualReply } from '../pipeline.js';
import { openBody, openRows, queryTokens } from '../messages.js';
import { limitsOf } from '../plans.js';
import { publish, subscribe } from '../realtime.js';
import { can, requirePerm, requireUser, type Permission } from './auth.js';
import { csrfField, html, pageHead, raw, type Safe } from './html.js';
import { icon } from './icons.js';
import { MESSAGES, view } from './public.js';
import { avatar, chip, empty, fmt, idParam, postForm, typeLabel, when } from './ui.js';

Object.assign(MESSAGES, {
  sent: { type: 'ok', text: 'Göndərildi. Bot bu söhbətdə 12 saat dayandırıldı.' },
  window_closed: { type: 'error', text: 'Müştərinin son mesajından 24 saat keçib. Meta qaydalarına görə indi cavab göndərmək olmur.' },
  send_failed: { type: 'error', text: 'Göndərmək alınmadı. Bir az sonra yenidən cəhd edin.' },
});

// ---------- Queries ----------

const filterSchema = z.object({
  f: z.enum(['all', 'unread', 'open', 'closed', 'mine', 'unassigned', 'waiting']).catch('open').default('open'),
  ch: z.enum(['', 'instagram', 'whatsapp']).catch('').default(''),
  tag: z.union([z.literal(''), z.uuid()]).catch('').default(''),
  auto: z.union([z.literal(''), z.uuid()]).catch('').default(''),
  q: z.string().trim().max(100).catch('').default(''),
  before: z.string().regex(/^\d{4}-\d\d-\d\dT[\d:.]+Z_[0-9a-f-]{36}$/).or(z.literal('')).catch('').default(''),
});
type Filters = z.infer<typeof filterSchema>;
const PAGE = 40;

export const CONV_LIST_SQL = `SELECT c.id, c.display_name, c.external_user_id, c.needs_human, c.status, c.unread_count, c.assignee_user_id, c.contact_id,
    coalesce(c.ai_paused_until > now(), false) AS paused, c.last_message_at, ch.type, coalesce(ct.username, '') AS username, u.email AS assignee_email,
    lm.body AS last, lm.enc AS last_enc, lm.sender AS last_sender
  FROM conversations c JOIN channels ch ON ch.id = c.channel_id
  LEFT JOIN contacts ct ON ct.id = c.contact_id
  LEFT JOIN users u ON u.id = c.assignee_user_id
  LEFT JOIN LATERAL (SELECT body, enc, sender FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) lm ON true
  WHERE c.workspace_id = $1`;

/** Decrypts the last-message preview of CONV_LIST_SQL rows. */
export const openLast = <T extends { last?: string | null; last_enc?: boolean }>(rows: T[]): T[] => {
  for (const r of rows) if (r.last) r.last = openBody({ body: r.last, enc: r.last_enc });
  return rows;
};

async function listConversations(workspaceId: string, userId: string, f: Filters) {
  const params: unknown[] = [workspaceId];
  const p = (v: unknown) => `$${params.push(v)}`;
  const where: string[] = [];
  if (f.f === 'unread') where.push('c.unread_count > 0');
  if (f.f === 'open') where.push(`c.status = 'open'`);
  if (f.f === 'closed') where.push(`c.status = 'closed'`);
  if (f.f === 'mine') where.push(`c.assignee_user_id = ${p(userId)}`);
  if (f.f === 'unassigned') where.push(`c.assignee_user_id IS NULL AND c.status = 'open'`);
  if (f.f === 'waiting') where.push('c.needs_human');
  if (f.ch) where.push(`ch.type = ${p(f.ch)}`);
  if (f.tag) where.push(`EXISTS (SELECT 1 FROM contact_tags x WHERE x.contact_id = c.contact_id AND x.tag_id = ${p(f.tag)})`);
  if (f.auto) where.push(`EXISTS (SELECT 1 FROM automation_runs r WHERE r.conversation_id = c.id AND r.automation_id = ${p(f.auto)})`);
  if (f.q) {
    const like = p(`%${f.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
    // Message text is encrypted: it is searched through its blind index (words and word beginnings, see messages.ts).
    const groups = queryTokens(f.q);
    const inText = groups.length ? `EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND ${groups.map((g) => `m.search_tokens && ${p(g)}::text[]`).join(' AND ')})` : 'false';
    where.push(`((coalesce(ct.display_name, '') || ' ' || coalesce(ct.username, '') || ' ' || c.display_name) ILIKE ${like} OR ${inText})`);
  }
  const hist = (await limitsOf(workspaceId)).history_days;
  if (hist) where.push(`c.last_message_at > now() - make_interval(days => ${p(hist)})`);
  if (f.before) {
    const [t, id] = f.before.split('_');
    where.push(`(c.last_message_at, c.id) < (${p(t)}::timestamptz, ${p(id)}::uuid)`);
  }
  const rows = openLast(await q(`${CONV_LIST_SQL} ${where.map((w) => `AND ${w}`).join(' ')} ORDER BY c.last_message_at DESC, c.id DESC LIMIT ${PAGE + 1}`, params));
  const more = rows.length > PAGE;
  return { rows: rows.slice(0, PAGE), next: more ? `${new Date(rows[PAGE - 1].last_message_at).toISOString()}_${rows[PAGE - 1].id}` : '' };
}

const counts = (workspaceId: string, userId: string) =>
  one(
    `SELECT count(*) FILTER (WHERE unread_count > 0)::int AS unread, count(*) FILTER (WHERE status = 'open')::int AS open,
            count(*) FILTER (WHERE assignee_user_id = $2 AND status = 'open')::int AS mine,
            count(*) FILTER (WHERE assignee_user_id IS NULL AND status = 'open')::int AS unassigned, count(*) FILTER (WHERE needs_human)::int AS waiting
     FROM conversations WHERE workspace_id = $1`,
    [workspaceId, userId],
  );

const loadConversation = (workspaceId: string, id: string) =>
  one(
    `SELECT c.*, coalesce(c.ai_paused_until > now(), false) AS paused, ch.type, ch.status AS channel_status, ch.display_name AS channel_name,
            ct.username, ct.display_name AS contact_name, ct.fields, ct.opted_out, ct.blocked, ct.first_seen_at, ct.last_seen_at
     FROM conversations c JOIN channels ch ON ch.id = c.channel_id LEFT JOIN contacts ct ON ct.id = c.contact_id
     WHERE c.id = $1 AND c.workspace_id = $2`,
    [id, workspaceId],
  );

// ---------- Rendering ----------

const qs = (f: Filters, over: Partial<Filters> = {}) => {
  const v = { ...f, before: '', ...over };
  const s = new URLSearchParams(Object.entries(v).filter(([k, x]) => x && !(k === 'f' && x === 'open')) as [string, string][]).toString();
  return s ? `?${s}` : '';
};

export const convRow = (c: any, activeId?: string, f?: Filters) => {
  const name = c.display_name || (c.username ? `@${c.username}` : c.external_user_id);
  return html`<a class="conv ${c.id === activeId ? 'on' : ''} ${c.unread_count > 0 ? 'unread' : ''}" href="/app/inbox/${c.id}${f ? qs(f) : ''}" data-conv="${c.id}">
  ${avatar(name, c.type)}
  <span class="conv-main"><span class="conv-top"><b>${name}</b><time>${when(c.last_message_at)}</time></span>
  <span class="conv-last">${c.last_sender === 'ai' || c.last_sender === 'bot' ? html`${icon('bot', 'i xs')} ` : c.last_sender === 'human' ? 'Siz: ' : ''}${String(c.last ?? '').slice(0, 90)}</span>
  <span class="conv-tags">${c.unread_count > 0 ? html`<span class="count">${c.unread_count}</span>` : ''}${c.needs_human ? chip('warn', 'Operator gözləyir') : ''}${c.status === 'closed' ? chip('neutral', 'Bağlı') : ''}${c.assignee_email ? chip('info', c.assignee_email.split('@')[0]) : ''}</span></span></a>`;
};

const KIND_LABEL: Record<string, string> = { story_reply: 'Story-yə cavab', story_mention: 'Story-də qeyd etdi', private_reply: 'Şərhə şəxsi cavab', quick_reply: 'Düymə seçdi' };
const STATUS_ICON: Record<string, Safe> = {
  pending: html`<span title="Göndərilir">…</span>`,
  failed: html`<span class="st-bad" title="Göndərilmədi">${icon('alert', 'i xs')} göndərilmədi</span>`,
  unknown: html`<span class="st-bad" title="Göndərilib-göndərilmədiyi bilinmir (bağlantı kəsildi)">? bilinmir</span>`,
};

function mediaHtml(m: any, msgId: string): Safe {
  const items = Array.isArray(m) ? m : [];
  return html`${items.map((x: any, i: number) => {
    const src = x.url ? x.url : x.id ? `/app/media/${msgId}/${i}` : '';
    if (!src) return html`<span class="media-ph">📎 ${x.type}</span>`;
    if (['image', 'story', 'story_mention', 'sticker'].includes(x.type)) return html`<a href="${src}" target="_blank" rel="noopener noreferrer"><img class="msg-img" src="${src}" alt="${x.type}" loading="lazy" referrerpolicy="no-referrer"></a>`;
    if (x.type === 'video' || x.type === 'reel') return html`<video class="msg-img" src="${src}" controls preload="none"></video>`;
    if (x.type === 'audio') return html`<audio src="${src}" controls preload="none"></audio>`;
    return html`<a href="${src}" target="_blank" rel="noopener noreferrer">📎 ${x.type}</a>`;
  })}`;
}

async function threadHtml(req: FastifyRequest, c: any): Promise<Safe> {
  const [msgs, notes] = await Promise.all([
    q(`SELECT * FROM (SELECT id, sender, body, enc, created_at, status, kind, media, payload, error FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 150) t ORDER BY created_at`, [c.id]).then(openRows),
    q(`SELECT n.body, n.created_at, u.email FROM conversation_notes n LEFT JOIN users u ON u.id = n.user_id WHERE n.conversation_id = $1 ORDER BY n.created_at DESC LIMIT 50`, [c.id]),
  ]);
  const items = [...msgs.map((m) => ({ t: new Date(m.created_at).getTime(), m })), ...notes.map((n) => ({ t: new Date(n.created_at).getTime(), n }))].sort((a, b) => a.t - b.t);
  const who = (s: string) => ({ customer: '', ai: 'AI', bot: 'Avtomatlaşdırma', human: 'Siz' })[s] ?? s;
  return html`${items.length ? '' : empty('chat', 'Hələ mesaj yoxdur.')}${items.map((it: any) =>
    it.n
      ? html`<div class="note"><small>${icon('book', 'i xs')} Daxili qeyd · ${it.n.email?.split('@')[0] ?? ''} · ${fmt(it.n.created_at)}</small>${it.n.body}</div>`
      : html`<div class="msg ${it.m.sender}">${KIND_LABEL[it.m.kind] ? html`<small class="kind">${KIND_LABEL[it.m.kind]}</small>` : ''}
          ${it.m.media ? mediaHtml(it.m.media, it.m.id) : ''}${it.m.body && !it.m.body.startsWith('[') ? html`<div class="bubble">${it.m.body}</div>` : it.m.media ? '' : html`<div class="bubble muted">${it.m.body}</div>`}
          <small>${it.m.sender !== 'customer' ? html`${it.m.sender === 'human' ? '' : icon('bot', 'i xs')} ${who(it.m.sender)} · ` : ''}${fmt(it.m.created_at)} ${STATUS_ICON[it.m.status] ?? ''}</small></div>`,
  )}`;
}

async function profileHtml(req: FastifyRequest, c: any): Promise<Safe> {
  if (!c.contact_id) return html`<p class="muted pad">Kontakt məlumatı yoxdur.</p>`;
  const [tags, allTags, runs, stats] = await Promise.all([
    q(`SELECT t.id, t.name FROM contact_tags x JOIN tags t ON t.id = x.tag_id WHERE x.contact_id = $1 ORDER BY t.name`, [c.contact_id]),
    q(`SELECT name FROM tags WHERE workspace_id = $1 ORDER BY name LIMIT 100`, [c.workspace_id]),
    q(`SELECT a.name, a.id, r.status, r.matched_at FROM automation_runs r JOIN automations a ON a.id = r.automation_id WHERE r.contact_id = $1 ORDER BY r.matched_at DESC LIMIT 8`, [c.contact_id]),
    one(`SELECT count(*)::int AS n, min(created_at) AS first FROM messages WHERE conversation_id = $1`, [c.id]),
  ]);
  const w = can(req.user, 'contacts.write');
  const name = c.contact_name || c.display_name || c.external_user_id;
  const fields = Object.entries((c.fields ?? {}) as Record<string, string>);
  const ajax = (action: string, inner: Safe, cls = 'inline-form') => html`<form method="post" action="${action}" class="${cls}" data-ajax>${csrfField(req.csrfToken)}${inner}</form>`;
  return html`<div class="profile-head">${avatar(name, c.type)}<div><b>${name}</b>${c.username ? html`<small>@${c.username}</small>` : ''}<small>${typeLabel(c.type)} · ${c.channel_name}</small></div></div>
    <dl class="kv"><dt>İlk əlaqə</dt><dd>${fmt(c.first_seen_at)}</dd><dt>Son aktivlik</dt><dd>${fmt(c.last_seen_at)}</dd><dt>Mesajlar</dt><dd>${stats.n}</dd>
      <dt>Status</dt><dd>${c.blocked ? chip('danger', 'Bloklanıb') : c.opted_out ? chip('warn', 'Avtomatik mesajları dayandırıb') : chip('ok', 'Aktiv')}</dd></dl>
    <h3>Tag-lər</h3>
    <div class="tag-list">${tags.length ? tags.map((t) => html`<span class="chip-x">${t.name}${w ? ajax(`/app/contacts/${c.contact_id}/tags`, html`<input type="hidden" name="remove" value="${t.name}"><button aria-label="Sil">×</button>`, 'inline') : ''}</span>`) : html`<span class="muted">Yoxdur</span>`}</div>
    ${w ? ajax(`/app/contacts/${c.contact_id}/tags`, html`<input name="add" list="tag-options" maxlength="40" placeholder="Tag əlavə et" required><button class="btn sm secondary">Əlavə</button><datalist id="tag-options">${allTags.map((t) => html`<option value="${t.name}">`)}</datalist>`) : ''}
    <h3>Xüsusi sahələr</h3>
    ${fields.length ? html`<dl class="kv">${fields.map(([k, v]) => html`<dt>${k}</dt><dd>${v}${w ? ajax(`/app/contacts/${c.contact_id}/fields`, html`<input type="hidden" name="key" value="${k}"><input type="hidden" name="delete" value="1"><button class="icon-btn" aria-label="Sil">×</button>`, 'inline') : ''}</dd>`)}</dl>` : html`<p class="muted">Yoxdur</p>`}
    ${w ? ajax(`/app/contacts/${c.contact_id}/fields`, html`<input name="key" pattern="[a-z][a-z0-9_]*" maxlength="40" placeholder="açar (məs: olcu)" required><input name="value" maxlength="500" placeholder="dəyər" required><button class="btn sm secondary">Yaz</button>`, 'field-form') : ''}
    <h3>Avtomatlaşdırmalar</h3>
    ${runs.length ? html`<ul class="runs">${runs.map((r) => html`<li><a href="/app/automations/${r.id}">${r.name}</a> ${chip(r.status === 'sent' ? 'ok' : r.status === 'failed' ? 'danger' : 'neutral', r.status)} <small class="muted">${when(r.matched_at)}</small></li>`)}</ul>` : html`<p class="muted">İşləməyib</p>`}
    ${w ? html`<h3>İdarəetmə</h3><div class="actions">
      ${ajax(`/app/contacts/${c.contact_id}/flags`, html`<input type="hidden" name="opted_out" value="${c.opted_out ? '0' : '1'}"><button class="btn sm secondary">${c.opted_out ? 'Avtomatik mesajlara icazə ver' : 'Avtomatik mesajları dayandır'}</button>`, 'inline')}
      ${ajax(`/app/contacts/${c.contact_id}/flags`, html`<input type="hidden" name="blocked" value="${c.blocked ? '0' : '1'}"><button class="btn sm ${c.blocked ? 'secondary' : 'danger-ghost'}">${c.blocked ? 'Blokdan çıxar' : 'Blokla'}</button>`, 'inline')}</div>` : ''}`;
}

async function paneHtml(req: FastifyRequest, c: any): Promise<Safe> {
  const members = await q(`SELECT u.id, u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 AND m.role <> 'analyst' ORDER BY u.email`, [c.workspace_id]);
  const open = !!c.last_inbound_at && Date.now() - new Date(c.last_inbound_at).getTime() < WINDOW_MS;
  const manage = can(req.user, 'inbox.manage');
  const name = c.contact_name || c.display_name || c.external_user_id;
  const ajax = (action: string, inner: Safe) => html`<form method="post" action="${action}" class="inline" data-ajax>${csrfField(req.csrfToken)}${inner}</form>`;
  const saved = await q(`SELECT title, body FROM saved_replies WHERE workspace_id = $1 ORDER BY title LIMIT 50`, [c.workspace_id]);
  const botOn = !c.needs_human && !c.paused && !c.assignee_user_id;
  const banner = c.channel_status !== 'active'
    ? html`<div class="banner warn">${icon('alert')}<span>Kanal yenidən bağlanmalıdır. <a href="/app/channels">Kanallar</a></span></div>`
    : c.assignee_user_id
      ? html`<div class="banner info">${icon('headset')}<span><b>${members.find((m) => m.id === c.assignee_user_id)?.email ?? 'Operator'}</b> bu söhbəti idarə edir. Bot cavab vermir.</span></div>`
      : c.needs_human
        ? html`<div class="banner warn">${icon('headset')}<span><b>Müştəri operator gözləyir.</b> Bot dayanıb.</span>${manage ? ajax(`/app/inbox/${c.id}/ai`, html`<input type="hidden" name="action" value="resume"><button class="btn sm secondary">${icon('play')}Botu bərpa et</button>`) : ''}</div>`
        : c.paused
          ? html`<div class="banner neutral">${icon('pause')}<span>Bot ${fmt(c.ai_paused_until)} tarixinə qədər dayandırılıb.</span>${manage ? ajax(`/app/inbox/${c.id}/ai`, html`<input type="hidden" name="action" value="resume"><button class="btn sm secondary">${icon('play')}Bərpa et</button>`) : ''}</div>`
          : html`<div class="banner ok">${icon('bot')}<span>Bot və AI bu söhbətə avtomatik cavab verir.</span>${manage ? ajax(`/app/inbox/${c.id}/ai`, html`<input type="hidden" name="action" value="pause"><button class="btn sm secondary">${icon('pause')}Dayandır</button>`) : ''}</div>`;
  return html`<div class="thread-head"><a class="icon-btn back" href="/app/inbox" aria-label="Geri">${icon('back')}</a>${avatar(name, c.type)}
      <div><b>${name}</b><small>${typeLabel(c.type)} · ${c.status === 'closed' ? 'Bağlı' : 'Açıq'}</small></div>
      ${manage ? html`<form method="post" action="/app/inbox/${c.id}/assign" class="inline assign" data-ajax>${csrfField(req.csrfToken)}
          <select name="user_id" aria-label="Təyin et" data-autosubmit>${[html`<option value="">Təyin olunmayıb</option>`, ...members.map((m) => html`<option value="${m.id}" ${m.id === c.assignee_user_id ? raw('selected') : ''}>${m.email}</option>`)]}</select></form>
        ${c.assignee_user_id !== req.user!.id ? ajax(`/app/inbox/${c.id}/assign`, html`<input type="hidden" name="user_id" value="me"><button class="btn sm">${icon('headset')}Ələ al</button>`) : ''}
        ${ajax(`/app/inbox/${c.id}/status`, html`<input type="hidden" name="status" value="${c.status === 'closed' ? 'open' : 'closed'}"><button class="btn sm secondary">${c.status === 'closed' ? 'Yenidən aç' : html`${icon('check')}Bağla`}</button>`)}` : ''}
      <button type="button" class="icon-btn" data-toggle-profile aria-label="Profil">${icon('users')}</button>
      ${manage ? postForm(`/app/inbox/${c.id}/delete`, req.csrfToken, icon('trash'), 'icon-btn', { confirm: 'Söhbət həmişəlik silinsin?' }) : ''}</div>
    ${banner}
    <div class="thread" id="thread" data-part="/app/inbox/${c.id}/part/thread">${await threadHtml(req, c)}</div>
    ${can(req.user, 'inbox.reply')
      ? html`<div class="composer-wrap">
        <div class="composer-tabs" role="tablist"><button type="button" class="on" data-tab="reply">Cavab</button>${manage ? html`<button type="button" data-tab="note">Daxili qeyd</button>` : ''}
          ${saved.length ? html`<select class="saved" aria-label="Hazır cavab" data-saved><option value="">Hazır cavablar…</option>${saved.map((s) => html`<option value="${s.body}">${s.title}</option>`)}</select>` : ''}
          <a class="more" href="/app/saved-replies">İdarə et</a></div>
        ${open
          ? html`<form class="composer" method="post" action="/app/inbox/${c.id}/reply" data-ajax data-tab-panel="reply" data-reset>${csrfField(req.csrfToken)}<input type="hidden" name="nonce" value="${randomToken(16)}">
              <textarea name="text" rows="2" maxlength="${c.type === 'whatsapp' ? 4096 : 1000}" required placeholder="Cavab yazın… (Enter göndərir, Shift+Enter yeni sətir)"></textarea>
              <button class="btn" aria-label="Göndər">${icon('send')}</button></form>`
          : html`<div class="composer closed" data-tab-panel="reply">${icon('lock')}<span>24 saatlıq cavab müddəti bitib (Meta qaydası). Müştəri yenidən yazanda cavab verə biləcəksiniz.</span></div>`}
        ${manage ? html`<form class="composer note-form" method="post" action="/app/inbox/${c.id}/note" data-ajax data-tab-panel="note" data-reset hidden>${csrfField(req.csrfToken)}
            <textarea name="body" rows="2" maxlength="2000" required placeholder="Yalnız komandanız görür"></textarea><button class="btn secondary">Qeyd et</button></form>` : ''}
      </div>`
      : html`<p class="hint pad">Sizin rolunuz yalnız oxumağa icazə verir.</p>`}`;
}

async function inboxPage(req: FastifyRequest, reply: FastifyReply, activeId?: string) {
  const w = req.user!.workspaceId;
  const f = filterSchema.parse(req.query ?? {});
  const c = activeId ? await loadConversation(w, activeId) : undefined;
  if (activeId && !c) return reply.code(404).send('Not found');
  if (c?.unread_count > 0) await q(`UPDATE conversations SET unread_count = 0 WHERE id = $1`, [c.id]);
  const [{ rows, next }, n, tags, autos] = await Promise.all([
    listConversations(w, req.user!.id, f),
    counts(w, req.user!.id),
    q(`SELECT id, name FROM tags WHERE workspace_id = $1 ORDER BY name LIMIT 100`, [w]),
    q(`SELECT id, name FROM automations WHERE workspace_id = $1 ORDER BY name LIMIT 100`, [w]),
  ]);
  const tab = (key: Filters['f'], label: string, count?: number) => html`<a href="/app/inbox${qs(f, { f: key })}" class="${f.f === key ? 'on' : ''}">${label}${count ? html` <span class="count ${key === 'waiting' ? 'warn' : ''}">${count}</span>` : ''}</a>`;
  return view(req, reply, c ? `${c.display_name || 'Söhbət'} · Söhbətlər` : 'Söhbətlər', html`
    <div class="inbox3 ${c ? 'has-active' : ''}" data-conv-id="${c?.id ?? ''}" data-list="/app/inbox/part/list">
      <aside class="ib-list">
        <div class="ib-head"><h1>Söhbətlər</h1><span class="live" id="live" title="Canlı yeniləmə"></span></div>
        <form class="ib-search" method="get" action="/app/inbox"><input type="search" name="q" value="${f.q}" placeholder="Ad, @istifadəçi və ya mesaj axtar"><input type="hidden" name="f" value="${f.f}">
          <select name="ch" data-autosubmit aria-label="Kanal"><option value="">Bütün kanallar</option><option value="instagram" ${f.ch === 'instagram' ? raw('selected') : ''}>Instagram</option><option value="whatsapp" ${f.ch === 'whatsapp' ? raw('selected') : ''}>WhatsApp</option></select>
          <select name="tag" data-autosubmit aria-label="Tag"><option value="">Bütün tag-lər</option>${tags.map((t) => html`<option value="${t.id}" ${t.id === f.tag ? raw('selected') : ''}>${t.name}</option>`)}</select>
          <select name="auto" data-autosubmit aria-label="Avtomatlaşdırma"><option value="">Bütün avtomatlaşdırmalar</option>${autos.map((a) => html`<option value="${a.id}" ${a.id === f.auto ? raw('selected') : ''}>${a.name}</option>`)}</select></form>
        <nav class="ib-tabs">${tab('open', 'Açıq', n.open)}${tab('unread', 'Oxunmamış', n.unread)}${tab('mine', 'Mənim', n.mine)}${tab('unassigned', 'Təyinsiz', n.unassigned)}${tab('waiting', 'Gözləyir', n.waiting)}${tab('closed', 'Bağlı')}${tab('all', 'Hamısı')}</nav>
        <div class="conv-list" id="conv-list">${listHtml(rows, next, f, c?.id)}</div>
      </aside>
      <section class="ib-pane">${c ? await paneHtml(req, c) : html`<div class="empty pane-empty">${icon('chat', 'i lg')}<h2>Söhbət seçin</h2><p>Soldan söhbət seçin. Yeni mesajlar avtomatik görünür.</p></div>`}</section>
      <aside class="ib-profile" id="profile" ${c ? html`data-part="/app/inbox/${c.id}/part/profile"` : ''}>${c ? await profileHtml(req, c) : ''}</aside>
    </div>`, html`<script src="/public/inbox.js" defer></script>`, true);
}

const listHtml = (rows: any[], next: string, f: Filters, activeId?: string) =>
  html`${rows.length ? rows.map((r) => convRow(r, activeId, f)) : empty('inbox', f.q ? 'Axtarışa uyğun söhbət tapılmadı.' : 'Bu bölmədə söhbət yoxdur.')}
  ${next ? html`<a class="btn sm secondary load-more" href="/app/inbox${qs(f, { before: next })}" data-more="/app/inbox/part/list${qs(f, { before: next })}">Daha çox</a>` : ''}`;

// ---------- Routes ----------

const wantsJson = (req: FastifyRequest) => String(req.headers.accept ?? '').includes('application/json');
const done = (req: FastifyRequest, reply: FastifyReply, id: string, m = 'saved') => (wantsJson(req) ? reply.send({ ok: true }) : reply.redirect(`/app/inbox/${id}?m=${m}`));
const fail = (req: FastifyRequest, reply: FastifyReply, id: string, m: string, code = 400) =>
  wantsJson(req) ? reply.code(code).send({ ok: false, error: MESSAGES[m]?.text ?? 'Xəta' }) : reply.redirect(`/app/inbox/${id}?m=${m}`);

export function inboxRoutes(app: FastifyInstance) {
  app.register(async (r) => {
    r.addHook('preHandler', requireUser);
    // Reading conversations is personal data: analysts (analytics only) are excluded server-side.
    r.addHook('preHandler', requirePerm('inbox.view'));
    const perm = (p: Permission) => ({ preHandler: requirePerm(p) });
    const owned = async (req: FastifyRequest) => {
      const id = idParam(req);
      return id ? one(`SELECT id, workspace_id, contact_id FROM conversations WHERE id = $1 AND workspace_id = $2`, [id, req.user!.workspaceId]) : undefined;
    };
    const ownedContact = async (req: FastifyRequest) => {
      const id = idParam(req);
      return id ? one(`SELECT id, workspace_id FROM contacts WHERE id = $1 AND workspace_id = $2`, [id, req.user!.workspaceId]) : undefined;
    };

    r.get('/app/inbox', (req, reply) => inboxPage(req, reply));
    r.get('/app/inbox/:id', (req, reply) => {
      const id = idParam(req);
      return id ? inboxPage(req, reply, id) : reply.code(404).send('Not found');
    });

    // HTML fragments for live refresh (same auth + tenant checks as the page).
    r.get('/app/inbox/part/list', async (req, reply) => {
      const f = filterSchema.parse(req.query ?? {});
      const active = z.uuid().safeParse((req.query as any)?.active).data;
      const { rows, next } = await listConversations(req.user!.workspaceId, req.user!.id, f);
      return reply.type('text/html; charset=utf-8').send(listHtml(rows, next, f, active).value);
    });
    r.get('/app/inbox/:id/part/:part', async (req, reply) => {
      const id = idParam(req);
      const c = id ? await loadConversation(req.user!.workspaceId, id) : undefined;
      if (!c) return reply.code(404).send('');
      const part = (req.params as any).part;
      if (part === 'thread') {
        if (c.unread_count > 0) await q(`UPDATE conversations SET unread_count = 0 WHERE id = $1`, [c.id]);
        return reply.type('text/html; charset=utf-8').send((await threadHtml(req, c)).value);
      }
      if (part === 'pane') return reply.type('text/html; charset=utf-8').send((await paneHtml(req, c)).value);
      if (part === 'profile') return reply.type('text/html; charset=utf-8').send((await profileHtml(req, c)).value);
      return reply.code(404).send('');
    });

    // Server-Sent Events: new messages / conversation changes for this workspace only.
    r.get('/app/events', { config: { rateLimit: false } }, (req, reply) => {
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 5000\n\n');
      const off = subscribe(req.user!.workspaceId, (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`));
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
      req.raw.on('close', () => {
        clearInterval(ping);
        off();
      });
    });

    r.post('/app/inbox/:id/reply', { ...perm('inbox.reply'), config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
      const id = idParam(req);
      const text = z.string().trim().min(1).max(4096).safeParse((req.body as any)?.text).data;
      if (!id || !text) return fail(req, reply, id ?? '', 'invalid');
      try {
        const nonce = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/).safeParse((req.body as any)?.nonce).data ?? randomToken(16);
        const res = await sendManualReply(req.user!.workspaceId, id, text, nonce);
        if (res === 'not_found') return reply.code(404).send('Not found');
        if (res !== 'sent') return fail(req, reply, id, 'window_closed');
        await q('UPDATE conversations SET needs_human = false WHERE id = $1', [id]);
        return done(req, reply, id, 'sent');
      } catch (e) {
        req.log.warn({ err: e }, 'manual send failed');
        return fail(req, reply, id, 'send_failed', 502);
      }
    });

    r.post('/app/inbox/:id/note', perm('inbox.manage'), async (req, reply) => {
      const c = await owned(req);
      const body = z.string().trim().min(1).max(2000).safeParse((req.body as any)?.body).data;
      if (!c || !body) return fail(req, reply, c?.id ?? '', 'invalid');
      await q(`INSERT INTO conversation_notes (workspace_id, conversation_id, user_id, body) VALUES ($1, $2, $3, $4)`, [c.workspace_id, c.id, req.user!.id, body]);
      await publish(c.workspace_id, { type: 'conversation', conversationId: c.id });
      return done(req, reply, c.id);
    });

    r.post('/app/inbox/:id/status', perm('inbox.manage'), async (req, reply) => {
      const c = await owned(req);
      const status = z.enum(['open', 'closed']).safeParse((req.body as any)?.status).data;
      if (!c || !status) return fail(req, reply, c?.id ?? '', 'invalid');
      await q(`UPDATE conversations SET status = $2, needs_human = CASE WHEN $2 = 'closed' THEN false ELSE needs_human END WHERE id = $1`, [c.id, status]);
      await audit(c.workspace_id, req.user!.id, `conversation.${status === 'closed' ? 'close' : 'reopen'}`, 'conversation', c.id);
      await publish(c.workspace_id, { type: 'conversation', conversationId: c.id });
      return done(req, reply, c.id);
    });

    // Assigning to a person makes the bot stay silent in that conversation (operator handover).
    r.post('/app/inbox/:id/assign', perm('inbox.manage'), async (req, reply) => {
      const c = await owned(req);
      const raw0 = String((req.body as any)?.user_id ?? '');
      const target = raw0 === 'me' ? req.user!.id : raw0 === '' ? null : z.uuid().safeParse(raw0).data;
      if (!c || target === undefined) return fail(req, reply, c?.id ?? '', 'invalid');
      if (target && !(await one(`SELECT 1 FROM memberships WHERE workspace_id = $1 AND user_id = $2 AND role <> 'analyst'`, [c.workspace_id, target]))) return fail(req, reply, c.id, 'invalid');
      await q(`UPDATE conversations SET assignee_user_id = $2, status = 'open' WHERE id = $1`, [c.id, target]);
      await audit(c.workspace_id, req.user!.id, target ? 'conversation.assign' : 'conversation.unassign', 'conversation', c.id, { to: target });
      await publish(c.workspace_id, { type: 'conversation', conversationId: c.id });
      return done(req, reply, c.id);
    });

    r.post('/app/inbox/:id/ai', perm('inbox.manage'), async (req, reply) => {
      const c = await owned(req);
      if (!c) return reply.code(404).send('Not found');
      const resume = (req.body as any)?.action === 'resume';
      await q(
        resume ? 'UPDATE conversations SET needs_human = false, ai_paused_until = NULL WHERE id = $1' : `UPDATE conversations SET ai_paused_until = now() + interval '30 days' WHERE id = $1`,
        [c.id],
      );
      await audit(c.workspace_id, req.user!.id, resume ? 'conversation.bot_resume' : 'conversation.bot_pause', 'conversation', c.id);
      await publish(c.workspace_id, { type: 'conversation', conversationId: c.id });
      return done(req, reply, c.id);
    });

    r.post('/app/inbox/:id/delete', perm('inbox.manage'), async (req, reply) => {
      const c = await owned(req);
      if (c) {
        await q('DELETE FROM conversations WHERE id = $1', [c.id]);
        await audit(c.workspace_id, req.user!.id, 'conversation.delete', 'conversation', c.id);
      }
      return reply.redirect('/app/inbox?m=saved');
    });

    // ----- Contact edits from the profile panel -----
    const backTo = async (req: FastifyRequest, reply: FastifyReply, contactId: string) => {
      const conv = await one(`SELECT id, workspace_id FROM conversations WHERE contact_id = $1 ORDER BY last_message_at DESC LIMIT 1`, [contactId]);
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
      if (b.delete === '1') await q(`UPDATE contacts SET fields = fields - $2 WHERE id = $1`, [ct.id, b.key]);
      else {
        const v = z.string().max(500).safeParse(b.value);
        if (!v.success) return reply.code(400).send({ ok: false });
        await q(`UPDATE contacts SET fields = fields || jsonb_build_object($2::text, $3::text) WHERE id = $1 AND (fields ? $2 OR (SELECT count(*) FROM jsonb_object_keys(fields)) < 50)`, [ct.id, b.key, v.data]);
      }
      return backTo(req, reply, ct.id);
    });
    r.post('/app/contacts/:id/flags', perm('contacts.write'), async (req, reply) => {
      const ct = await ownedContact(req);
      const b = req.body as any;
      if (!ct) return reply.code(404).send('Not found');
      for (const k of ['opted_out', 'blocked'] as const) {
        if (b?.[k] === '1' || b?.[k] === '0') {
          await q(`UPDATE contacts SET ${k} = $2 WHERE id = $1`, [ct.id, b[k] === '1']);
          await audit(ct.workspace_id, req.user!.id, `contact.${k}`, 'contact', ct.id, { value: b[k] === '1' });
        }
      }
      return backTo(req, reply, ct.id);
    });

    // WhatsApp media needs an authenticated download: proxied after tenant check.
    r.get('/app/media/:id/:i', async (req, reply) => {
      const id = idParam(req);
      const i = Number((req.params as any).i);
      const m = id ? await one(`SELECT m.media, ch.access_token_enc, ch.type FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN channels ch ON ch.id = c.channel_id WHERE m.id = $1 AND m.workspace_id = $2`, [id, req.user!.workspaceId]) : undefined;
      const item = Array.isArray(m?.media) ? m.media[i] : undefined;
      if (!m || !item?.id || m.type !== 'whatsapp') return reply.code(404).send('');
      try {
        const f = await fetchWhatsAppMedia(decrypt(m.access_token_enc), item.id);
        return reply.header('Cache-Control', 'private, max-age=3600').header('X-Content-Type-Options', 'nosniff').type(/^(image|video|audio)\//.test(f.mime) ? f.mime : 'application/octet-stream').send(Buffer.from(f.body));
      } catch {
        return reply.code(502).send('');
      }
    });

    // ----- Saved replies -----
    r.get('/app/saved-replies', async (req, reply) => {
      const rows = await q(`SELECT id, title, body FROM saved_replies WHERE workspace_id = $1 ORDER BY title`, [req.user!.workspaceId]);
      const w = can(req.user, 'inbox.manage');
      return view(req, reply, 'Hazır cavablar', html`<p><a href="/app/inbox" class="more">${icon('back', 'i xs')} Söhbətlər</a></p>${pageHead('Hazır cavablar', 'Operatorların tez-tez yazdığı mətnlər. Söhbətdə bir kliklə əlavə olunur.')}
        ${w ? html`<section class="card"><form method="post" action="/app/saved-replies" class="grid">${csrfField(req.csrfToken)}
          <label>Başlıq<input name="title" maxlength="60" required placeholder="Çatdırılma"></label>
          <label class="span2">Mətn<input name="body" maxlength="1000" required placeholder="Bakı daxili çatdırılma 1 gündür, 3 AZN."></label><button class="btn">${icon('plus')}Əlavə et</button></form></section>` : ''}
        <section class="card flush">${rows.length ? html`<div class="table-wrap"><table><thead><tr><th>Başlıq</th><th>Mətn</th><th></th></tr></thead><tbody>${rows.map((s) => html`<tr><td class="strong">${s.title}</td><td>${s.body}</td>
          <td>${w ? postForm(`/app/saved-replies/${s.id}/delete`, req.csrfToken, icon('trash'), 'icon-btn') : ''}</td></tr>`)}</tbody></table></div>` : empty('book', 'Hələ hazır cavab yoxdur.')}</section>`);
    });
    r.post('/app/saved-replies', perm('inbox.manage'), async (req, reply) => {
      const p = z.object({ title: z.string().trim().min(1).max(60), body: z.string().trim().min(1).max(1000) }).safeParse(req.body);
      if (p.success) await q(`INSERT INTO saved_replies (workspace_id, title, body, created_by) VALUES ($1, $2, $3, $4)`, [req.user!.workspaceId, p.data.title, p.data.body, req.user!.id]);
      return reply.redirect(`/app/saved-replies?m=${p.success ? 'saved' : 'invalid'}`);
    });
    r.post('/app/saved-replies/:id/delete', perm('inbox.manage'), async (req, reply) => {
      const id = idParam(req);
      if (id) await q(`DELETE FROM saved_replies WHERE id = $1 AND workspace_id = $2`, [id, req.user!.workspaceId]);
      return reply.redirect('/app/saved-replies?m=saved');
    });
  });
}
