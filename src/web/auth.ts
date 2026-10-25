import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { randomToken, safeEqual, sha256 } from '../crypto.js';
import { one, q } from '../db.js';

export interface SessionUser {
  id: string;
  email: string;
  emailVerified: boolean;
  workspaceId: string;
  role: Role;
  isAdmin: boolean;
  mfa: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
    csrfToken: string;
    rawBody?: Buffer;
  }
  interface FastifyContextConfig {
    csrf?: boolean;
  }
}

const SID = config.isProd ? '__Host-sid' : 'sid';
const PRE = config.isProd ? '__Host-pcsrf' : 'pcsrf';
const SESSION_DAYS = 7;
const cookieOpts = { httpOnly: true, secure: config.isProd, sameSite: 'lax' as const, path: '/' };
const NO_SESSION = /^\/(public|webhooks|meta|healthz|readyz|sw\.js)(\/|$)/;

export async function createSession(reply: FastifyReply, userId: string): Promise<void> {
  const token = randomToken();
  await q(`INSERT INTO sessions (id_hash, user_id, csrf_token, expires_at) VALUES ($1, $2, $3, now() + interval '${SESSION_DAYS} days')`, [
    sha256(token),
    userId,
    randomToken(),
  ]);
  reply.setCookie(SID, token, { ...cookieOpts, maxAge: SESSION_DAYS * 86400 });
  reply.clearCookie(PRE, { path: '/' });
}

export async function destroySession(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = req.cookies[SID];
  if (token) await q('DELETE FROM sessions WHERE id_hash = $1', [sha256(token)]);
  reply.clearCookie(SID, { path: '/' });
}

export function registerAuth(app: FastifyInstance) {
  app.decorateRequest('user', null);
  app.decorateRequest('csrfToken', '');

  app.addHook('onRequest', async (req, reply) => {
    if (NO_SESSION.test(req.url)) return;
    const token = req.cookies[SID];
    if (token) {
      const row = await one(
        `SELECT s.csrf_token, s.expires_at < now() + interval '6 days' AS stale, u.id, u.email, u.email_verified_at, u.is_admin, u.totp_enabled_at IS NOT NULL AS mfa, m.workspace_id, m.role
         FROM sessions s JOIN users u ON u.id = s.user_id JOIN memberships m ON m.user_id = u.id
         WHERE s.id_hash = $1 AND s.expires_at > now() LIMIT 1`,
        [sha256(token)],
      );
      if (row) {
        req.user = { id: row.id, email: row.email, emailVerified: !!row.email_verified_at, workspaceId: row.workspace_id, role: row.role, isAdmin: row.is_admin, mfa: row.mfa };
        req.csrfToken = row.csrf_token;
        if (row.stale) {
          await q(`UPDATE sessions SET expires_at = now() + interval '${SESSION_DAYS} days' WHERE id_hash = $1`, [sha256(token)]);
          reply.setCookie(SID, token, { ...cookieOpts, maxAge: SESSION_DAYS * 86400 });
        }
        return;
      }
      reply.clearCookie(SID, { path: '/' });
    }
    // Anonymous forms (login/signup) use a double-submit token in a strict cookie.
    let pre = req.cookies[PRE];
    if (!pre || pre.length < 32) {
      pre = randomToken();
      reply.setCookie(PRE, pre, { ...cookieOpts, sameSite: 'strict' });
    }
    req.csrfToken = pre;
  });

  // CSRF: same-origin check + token on every state-changing request (except signed Meta callbacks).
  app.addHook('preHandler', async (req, reply) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.routeOptions.config?.csrf === false) return;
    const origin = req.headers.origin ?? (req.headers.referer ? URL.parse(req.headers.referer)?.origin ?? 'invalid' : undefined);
    const token = (req.body as any)?._csrf ?? req.headers['x-csrf-token'];
    if ((origin && origin !== config.appOrigin) || typeof token !== 'string' || !req.csrfToken || !safeEqual(token, req.csrfToken)) {
      return reply.code(403).send('Forbidden (CSRF)');
    }
  });
}

export type Role = 'owner' | 'admin' | 'agent' | 'analyst';
export type Permission =
  | 'inbox.reply' | 'inbox.manage' | 'contacts.write' | 'automations.write' | 'assistant.write'
  | 'channels.manage' | 'team.manage' | 'billing.view' | 'analytics.view' | 'workspace.delete';

/** Backend permission matrix. Every write route checks this (UI hiding is only cosmetic). */
const PERMS: Record<Role, Permission[]> = {
  owner: ['inbox.reply', 'inbox.manage', 'contacts.write', 'automations.write', 'assistant.write', 'channels.manage', 'team.manage', 'billing.view', 'analytics.view', 'workspace.delete'],
  admin: ['inbox.reply', 'inbox.manage', 'contacts.write', 'automations.write', 'assistant.write', 'channels.manage', 'team.manage', 'billing.view', 'analytics.view'],
  agent: ['inbox.reply', 'inbox.manage', 'contacts.write', 'analytics.view'],
  analyst: ['analytics.view'],
};
export const can = (user: SessionUser | null, p: Permission) => !!user && (PERMS[user.role] ?? []).includes(p);

/** preHandler factory: 403 unless the signed-in user has the permission. */
export const requirePerm = (p: Permission) => async (req: FastifyRequest, reply: FastifyReply) => {
  if (!req.user) return reply.redirect('/login');
  if (!can(req.user, p)) return reply.code(403).type('text/plain; charset=utf-8').send('Bu əməliyyat üçün icazəniz yoxdur.');
};

export async function requireUser(req: FastifyRequest, reply: FastifyReply) {
  if (!req.user) return reply.redirect('/login');
}

export async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  if (!req.user) return reply.redirect('/login');
  if (!req.user.isAdmin) return reply.code(404).send('Not found');
  // Admins must use two-factor login before touching customer accounts.
  if (!req.user.mfa) return reply.redirect('/app/2fa?m=mfa_required');
}

export async function requireOwner(req: FastifyRequest, reply: FastifyReply) {
  if (!req.user) return reply.redirect('/login');
  if (req.user.role !== 'owner') return reply.code(403).send('Forbidden');
}
