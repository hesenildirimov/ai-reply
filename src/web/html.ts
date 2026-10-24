/** Minimal auto-escaping HTML templating. Every interpolation is escaped unless wrapped in raw(). */
export class Safe {
  constructor(readonly value: string) {}
  toString() {
    return this.value;
  }
}

export const raw = (s: string) => new Safe(s);

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };
export const escape = (s: string) => s.replace(/[&<>"'`]/g, (c) => ESC[c]!);

function render(v: unknown): string {
  if (v == null || v === false) return '';
  if (v instanceof Safe) return v.value;
  if (Array.isArray(v)) return v.map(render).join('');
  return escape(String(v));
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): Safe {
  let out = strings[0]!;
  values.forEach((v, i) => (out += render(v) + strings[i + 1]));
  return new Safe(out);
}

export const csrfField = (token: string) => html`<input type="hidden" name="_csrf" value="${token}">`;

export interface PageOpts {
  csrf: string;
  user?: { email: string; isAdmin?: boolean } | null;
  flash?: { type: 'ok' | 'error'; text: string } | null;
  head?: Safe;
}

export function page(title: string, body: Safe, o: PageOpts): string {
  const nav = o.user
    ? html`<nav><a href="/app">Panel</a><a href="/app/inbox">Söhbətlər</a><a href="/app/assistant">AI köməkçi</a><a href="/app/channels">Kanallar</a><a href="/app/test">Test</a><a href="/app/settings">Ayarlar</a>${o.user.isAdmin ? html`<a href="/admin"><b>Admin</b></a>` : ''}
        <form method="post" action="/logout" class="inline">${csrfField(o.csrf)}<button class="link">Çıxış</button></form></nav>`
    : html`<nav><a href="/">Ana səhifə</a><a href="/login">Daxil ol</a></nav>`;
  return `<!doctype html>${html`<html lang="az"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · AI Reply</title><link rel="stylesheet" href="/public/app.css"><script src="/public/app.js" defer></script>${o.head}</head>
<body><header><strong>AI Reply</strong>${nav}</header><main>
${o.flash ? html`<p class="flash ${o.flash.type}">${o.flash.text}</p>` : ''}
${body}</main>
<footer><a href="/privacy">Privacy Policy</a> · <a href="/terms">Terms</a> · <a href="/data-deletion">Data deletion</a></footer></body></html>`}`;
}
