import type { FastifyRequest } from 'fastify';
import { inWindow } from '../conversation.js';
import { randomToken } from '../crypto.js';
import type { Filters, PaneData, ProfileData, ThreadItem } from '../data/inbox.js';
import { can } from './auth.js';
import { csrfField, html, pageHead, raw, type Safe } from './html.js';
import { icon } from './icons.js';
import { avatar, chip, empty, fmt, postForm, typeLabel, when } from './ui.js';

/** Inbox HTML. Pure rendering: data comes from src/data/inbox.ts, routes are in inbox.ts. */

export const qs = (f: Filters, over: Partial<Filters> = {}) => {
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

const KIND_LABEL: Record<string, string> = {
  story_reply: 'Story-yə cavab',
  story_mention: 'Story-də qeyd etdi',
  private_reply: 'Şərhə şəxsi cavab',
  quick_reply: 'Düymə seçdi',
};
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
    if (['image', 'story', 'story_mention', 'sticker'].includes(x.type))
      return html`<a href="${src}" target="_blank" rel="noopener noreferrer"><img class="msg-img" src="${src}" alt="${x.type}" loading="lazy" referrerpolicy="no-referrer"></a>`;
    if (x.type === 'video' || x.type === 'reel') return html`<video class="msg-img" src="${src}" controls preload="none"></video>`;
    if (x.type === 'audio') return html`<audio src="${src}" controls preload="none"></audio>`;
    return html`<a href="${src}" target="_blank" rel="noopener noreferrer">📎 ${x.type}</a>`;
  })}`;
}

/** Messages and internal notes of one conversation. */
export function threadHtml(items: ThreadItem[]): Safe {
  const who = (s: string) => ({ customer: '', ai: 'AI', bot: 'Avtomatlaşdırma', human: 'Siz' })[s] ?? s;
  return html`${items.length ? '' : empty('chat', 'Hələ mesaj yoxdur.')}${items.map((it: any) =>
    it.n
      ? html`<div class="note"><small>${icon('book', 'i xs')} Daxili qeyd · ${it.n.email?.split('@')[0] ?? ''} · ${fmt(it.n.created_at)}</small>${it.n.body}</div>`
      : html`<div class="msg ${it.m.sender}">${KIND_LABEL[it.m.kind] ? html`<small class="kind">${KIND_LABEL[it.m.kind]}</small>` : ''}
          ${it.m.media ? mediaHtml(it.m.media, it.m.id) : ''}${it.m.body && !it.m.body.startsWith('[') ? html`<div class="bubble">${it.m.body}</div>` : it.m.media ? '' : html`<div class="bubble muted">${it.m.body}</div>`}
          ${it.m.note ? html`<small class="media-note" title="AI-nin gördüyü / eşitdiyi">${icon('sparkle', 'i xs')} ${it.m.note.replace(/^\[|\]$/g, '')}</small>` : ''}
          <small>${it.m.sender !== 'customer' ? html`${it.m.sender === 'human' ? '' : icon('bot', 'i xs')} ${who(it.m.sender)} · ` : ''}${fmt(it.m.created_at)} ${STATUS_ICON[it.m.status] ?? ''}</small></div>`,
  )}`;
}

/** Contact panel (right column). `data` is null when the conversation has no contact. */
export function profileHtml(req: FastifyRequest, c: any, data: ProfileData | null): Safe {
  if (!c.contact_id || !data) return html`<p class="muted pad">Kontakt məlumatı yoxdur.</p>`;
  const { tags, allTags, runs, stats } = data;
  const w = can(req.user, 'contacts.write');
  const name = c.contact_name || c.display_name || c.external_user_id;
  const fields = Object.entries((c.fields ?? {}) as Record<string, string>);
  const ajax = (action: string, inner: Safe, cls = 'inline-form') =>
    html`<form method="post" action="${action}" class="${cls}" data-ajax>${csrfField(req.csrfToken)}${inner}</form>`;
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
    ${
      w
        ? html`<h3>İdarəetmə</h3><div class="actions">
      ${ajax(`/app/contacts/${c.contact_id}/flags`, html`<input type="hidden" name="opted_out" value="${c.opted_out ? '0' : '1'}"><button class="btn sm secondary">${c.opted_out ? 'Avtomatik mesajlara icazə ver' : 'Avtomatik mesajları dayandır'}</button>`, 'inline')}
      ${ajax(`/app/contacts/${c.contact_id}/flags`, html`<input type="hidden" name="blocked" value="${c.blocked ? '0' : '1'}"><button class="btn sm ${c.blocked ? 'secondary' : 'danger-ghost'}">${c.blocked ? 'Blokdan çıxar' : 'Blokla'}</button>`, 'inline')}</div>`
        : ''
    }`;
}

/** Conversation pane: header actions, bot status banner, thread, composer. */
export function paneHtml(req: FastifyRequest, c: any, { members, saved }: PaneData, thread: Safe): Safe {
  const open = inWindow(c);
  const manage = can(req.user, 'inbox.manage');
  const name = c.contact_name || c.display_name || c.external_user_id;
  const ajax = (action: string, inner: Safe) =>
    html`<form method="post" action="${action}" class="inline" data-ajax>${csrfField(req.csrfToken)}${inner}</form>`;
  const banner =
    c.channel_status !== 'active'
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
      ${
        manage
          ? html`<form method="post" action="/app/inbox/${c.id}/assign" class="inline assign" data-ajax>${csrfField(req.csrfToken)}
          <select name="user_id" aria-label="Təyin et" data-autosubmit>${[html`<option value="">Təyin olunmayıb</option>`, ...members.map((m) => html`<option value="${m.id}" ${m.id === c.assignee_user_id ? raw('selected') : ''}>${m.email}</option>`)]}</select></form>
        ${c.assignee_user_id !== req.user!.id ? ajax(`/app/inbox/${c.id}/assign`, html`<input type="hidden" name="user_id" value="me"><button class="btn sm">${icon('headset')}Ələ al</button>`) : ''}
        ${ajax(`/app/inbox/${c.id}/status`, html`<input type="hidden" name="status" value="${c.status === 'closed' ? 'open' : 'closed'}"><button class="btn sm secondary">${c.status === 'closed' ? 'Yenidən aç' : html`${icon('check')}Bağla`}</button>`)}`
          : ''
      }
      <button type="button" class="icon-btn" data-toggle-profile aria-label="Profil">${icon('users')}</button>
      ${manage ? postForm(`/app/inbox/${c.id}/delete`, req.csrfToken, icon('trash'), 'icon-btn', { confirm: 'Söhbət həmişəlik silinsin?' }) : ''}</div>
    ${banner}
    <div class="thread" id="thread" data-part="/app/inbox/${c.id}/part/thread">${thread}</div>
    ${
      can(req.user, 'inbox.reply')
        ? html`<div class="composer-wrap">
        <div class="composer-tabs" role="tablist"><button type="button" class="on" data-tab="reply">Cavab</button>${manage ? html`<button type="button" data-tab="note">Daxili qeyd</button>` : ''}
          ${saved.length ? html`<select class="saved" aria-label="Hazır cavab" data-saved><option value="">Hazır cavablar…</option>${saved.map((s) => html`<option value="${s.body}">${s.title}</option>`)}</select>` : ''}
          <a class="more" href="/app/saved-replies">İdarə et</a></div>
        ${
          open
            ? html`<form class="composer" method="post" action="/app/inbox/${c.id}/reply" data-ajax data-tab-panel="reply" data-reset>${csrfField(req.csrfToken)}<input type="hidden" name="nonce" value="${randomToken(16)}">
              <textarea name="text" rows="2" maxlength="${c.type === 'whatsapp' ? 4096 : 1000}" required placeholder="Cavab yazın… (Enter göndərir, Shift+Enter yeni sətir)"></textarea>
              <button class="btn" aria-label="Göndər">${icon('send')}</button></form>`
            : html`<div class="composer closed" data-tab-panel="reply">${icon('lock')}<span>24 saatlıq cavab müddəti bitib (Meta qaydası). Müştəri yenidən yazanda cavab verə biləcəksiniz.</span></div>`
        }
        ${
          manage
            ? html`<form class="composer note-form" method="post" action="/app/inbox/${c.id}/note" data-ajax data-tab-panel="note" data-reset hidden>${csrfField(req.csrfToken)}
            <textarea name="body" rows="2" maxlength="2000" required placeholder="Yalnız komandanız görür"></textarea><button class="btn secondary">Qeyd et</button></form>`
            : ''
        }
      </div>`
        : html`<p class="hint pad">Sizin rolunuz yalnız oxumağa icazə verir.</p>`
    }`;
}

export interface InboxPageData {
  f: Filters;
  list: { rows: any[]; next: string };
  counts: any;
  choices: { tags: any[]; automations: any[] };
  /** The open conversation with its pane and profile, if one is selected. */
  active?: { c: any; pane: Safe; profile: Safe };
}

/** Three-pane inbox page body: list with filters, conversation, contact profile. */
export function inboxBody({ f, list, counts: n, choices, active }: InboxPageData): Safe {
  const c = active?.c;
  const { rows, next } = list;
  const { tags, automations: autos } = choices;
  const tab = (key: Filters['f'], label: string, count?: number) =>
    html`<a href="/app/inbox${qs(f, { f: key })}" class="${f.f === key ? 'on' : ''}">${label}${count ? html` <span class="count ${key === 'waiting' ? 'warn' : ''}">${count}</span>` : ''}</a>`;
  return html`
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
      <section class="ib-pane">${active ? active.pane : html`<div class="empty pane-empty">${icon('chat', 'i lg')}<h2>Söhbət seçin</h2><p>Soldan söhbət seçin. Yeni mesajlar avtomatik görünür.</p></div>`}</section>
      <aside class="ib-profile" id="profile" ${c ? html`data-part="/app/inbox/${c.id}/part/profile"` : ''}>${active ? active.profile : ''}</aside>
    </div>`;
}

export const listHtml = (rows: any[], next: string, f: Filters, activeId?: string) =>
  html`${rows.length ? rows.map((r) => convRow(r, activeId, f)) : empty('inbox', f.q ? 'Axtarışa uyğun söhbət tapılmadı.' : 'Bu bölmədə söhbət yoxdur.')}
  ${next ? html`<a class="btn sm secondary load-more" href="/app/inbox${qs(f, { before: next })}" data-more="/app/inbox/part/list${qs(f, { before: next })}">Daha çox</a>` : ''}`;

/** Saved replies management page. */
export const savedRepliesHtml = (req: FastifyRequest, rows: any[], canEdit: boolean) =>
  html`<p><a href="/app/inbox" class="more">${icon('back', 'i xs')} Söhbətlər</a></p>${pageHead('Hazır cavablar', 'Operatorların tez-tez yazdığı mətnlər. Söhbətdə bir kliklə əlavə olunur.')}
    ${
      canEdit
        ? html`<section class="card"><form method="post" action="/app/saved-replies" class="grid">${csrfField(req.csrfToken)}
      <label>Başlıq<input name="title" maxlength="60" required placeholder="Çatdırılma"></label>
      <label class="span2">Mətn<input name="body" maxlength="1000" required placeholder="Bakı daxili çatdırılma 1 gündür, 3 AZN."></label><button class="btn">${icon('plus')}Əlavə et</button></form></section>`
        : ''
    }
    <section class="card flush">${
      rows.length
        ? html`<div class="table-wrap"><table><thead><tr><th>Başlıq</th><th>Mətn</th><th></th></tr></thead><tbody>${rows.map(
            (s) => html`<tr><td class="strong">${s.title}</td><td>${s.body}</td>
      <td>${canEdit ? postForm(`/app/saved-replies/${s.id}/delete`, req.csrfToken, icon('trash'), 'icon-btn') : ''}</td></tr>`,
          )}</tbody></table></div>`
        : empty('book', 'Hələ hazır cavab yoxdur.')
    }</section>`;
