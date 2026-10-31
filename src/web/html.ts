import { can, type Permission, type SessionUser } from './auth.js';
import { icon } from './icons.js';
import { html, type Safe } from './tpl.js';

export { escape, html, raw, Safe } from './tpl.js';

export const csrfField = (token: string) => html`<input type="hidden" name="_csrf" value="${token}">`;

export const pageHead = (title: string, sub?: string | Safe, actions?: Safe) =>
  html`<div class="page-head"><div><h1>${title}</h1>${sub ? html`<p class="sub">${sub}</p>` : ''}</div>${actions ? html`<div class="head-actions">${actions}</div>` : ''}</div>`;

export const logo = html`<span class="logo">${icon('chat')}</span>`;

export interface PageOpts {
  csrf: string;
  user?: SessionUser | null;
  flash?: { type: 'ok' | 'error'; text: string } | null;
  head?: Safe;
  path?: string;
  wide?: boolean;
  /** Public website: document language and its own header (navigation, language switch, calls to action). */
  lang?: 'az' | 'ru' | 'en';
  header?: Safe;
}

// Entries a role can't use are hidden (the routes enforce the same permissions server-side).
const NAV: [string, string, string, Permission?][] = [
  ['/app', 'Panel', 'grid'],
  ['/app/inbox', 'Söhbətlər', 'chat', 'inbox.reply'],
  ['/app/comments', 'Şərhlər', 'instagram', 'inbox.view'],
  ['/app/contacts', 'Kontaktlar', 'contact', 'contacts.write'],
  ['/app/automations', 'Avtomatlaşdırma', 'zap', 'automations.view'],
  ['/app/analytics', 'Analitika', 'chart', 'analytics.view'],
  ['/app/assistant', 'AI köməkçi', 'bot', 'assistant.write'],
  ['/app/knowledge', 'Bilik bazası', 'book', 'knowledge.view'],
  ['/app/channels', 'Kanallar', 'plug', 'channels.manage'],
  ['/app/integrations', 'İnteqrasiyalar', 'share', 'integrations.manage'],
  ['/app/team', 'Komanda', 'users', 'team.manage'],
  ['/app/test', 'Test et', 'flask', 'assistant.write'],
  ['/app/settings', 'Ayarlar', 'sliders'],
];

export function page(title: string, body: Safe, o: PageOpts): string {
  const path = o.path ?? '';
  const active = (href: string) => (href === '/app' ? path === '/app' : path === href || path.startsWith(`${href}/`));
  const flash = o.flash
    ? html`<p class="flash ${o.flash.type}" role="status">${icon(o.flash.type === 'ok' ? 'check' : 'alert')}<span>${o.flash.text}</span></p>`
    : '';
  const footer = html`<footer><a href="/privacy">Privacy Policy</a><a href="/terms">Terms</a><a href="/data-deletion">Data deletion</a></footer>`;
  const shell = o.user
    ? html`<div class="shell">
  <aside class="side">
    <a class="brand" href="/app">${logo}<span>AI Reply</span></a>
    <nav class="nav">${NAV.filter(([, , , p]) => !p || can(o.user ?? null, p)).map(([href, label, ic]) => html`<a href="${href}" class="${active(href) ? 'on' : ''}">${icon(ic)}<span>${label}</span></a>`)}
      ${o.user.isAdmin ? html`<a href="/admin" class="${active('/admin') ? 'on' : ''}">${icon('shield')}<span>Admin</span></a>` : ''}</nav>
    <div class="me"><span class="avatar">${o.user.email.slice(0, 1).toUpperCase()}</span><span class="me-mail">${o.user.email}</span>
      <form method="post" action="/logout">${csrfField(o.csrf)}<button class="icon-btn" title="Çıxış" aria-label="Çıxış">${icon('logout')}</button></form></div>
  </aside>
  <div class="content"><main class="${o.wide ? 'wide' : ''}">${flash}${body}</main>${footer}</div>
</div>`
    : html`${o.header ?? html`<header class="top"><a class="brand" href="/">${logo}<span>AI Reply</span></a><a class="btn ghost" href="/login">Daxil ol</a></header>`}
<main class="plain">${flash}${body}</main>${footer}`;
  return `<!doctype html>${html`<html lang="${o.lang ?? 'az'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · AI Reply</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap">
<link rel="stylesheet" href="/public/app.css"><script src="/public/app.js" defer></script>${o.head}</head>
<body>${shell}</body></html>`}`;
}
