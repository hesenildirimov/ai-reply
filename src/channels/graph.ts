import { config } from '../config.js';
import { hmacSha256 } from '../crypto.js';

export class GraphError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | undefined,
    message: string,
  ) {
    super(message);
  }
  /** OAuthException 190 = token invalid/expired/revoked. */
  get tokenInvalid() {
    return this.code === 190 || this.status === 401;
  }
  /** Throttling: app/user/page rate limits (4, 17, 32, 613, 80002-80008) or HTTP 429. */
  get rateLimited() {
    return this.status === 429 || [4, 17, 32, 613].includes(this.code ?? -1) || ((this.code ?? 0) >= 80002 && (this.code ?? 0) <= 80008);
  }
  /** Worth retrying later: throttling, transient (1, 2) or server errors. Everything else is permanent. */
  get retryable() {
    return this.rateLimited || this.status >= 500 || this.code === 1 || this.code === 2;
  }
}

interface Opts {
  method?: 'GET' | 'POST' | 'DELETE';
  token?: string;
  query?: Record<string, string>;
  json?: unknown;
  form?: Record<string, string>;
  /** Adds appsecret_proof (graph.facebook.com, "Require App Secret" setting). */
  appSecretProof?: boolean;
}

/** Calls the Graph API. Never put tokens in error messages or logs. */
export async function graph<T = any>(base: string, path: string, o: Opts = {}): Promise<T> {
  const url = new URL(path.startsWith('/') ? path : `/${path}`, base);
  for (const [k, v] of Object.entries(o.query ?? {})) url.searchParams.set(k, v);
  const headers: Record<string, string> = {};
  let body: string | undefined;
  if (o.token) {
    headers.Authorization = `Bearer ${o.token}`;
    if (o.appSecretProof && config.META_APP_SECRET) {
      url.searchParams.set('appsecret_proof', hmacSha256(config.META_APP_SECRET, o.token).toString('hex'));
    }
  }
  if (o.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(o.json);
  } else if (o.form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(o.form).toString();
  }
  const res = await fetch(url, { method: o.method ?? (body ? 'POST' : 'GET'), headers, body, signal: AbortSignal.timeout(15_000) });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || data?.error) {
    const err = data?.error ?? {};
    throw new GraphError(res.status, err.code, `Graph ${url.pathname} ${res.status}: ${err.message ?? err.error_message ?? 'error'}`);
  }
  return data as T;
}

export const fbPath = (p: string) => `/${config.META_GRAPH_VERSION}/${p.replace(/^\//, '')}`;
