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
