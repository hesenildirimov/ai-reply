import path from 'node:path';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import Fastify from 'fastify';
import { healthSignal } from './alerts.js';
import { config } from './config.js';
import { pool } from './db.js';
import { assertEncryptionKey, assertLeastPrivilege } from './keycheck.js';
import { closeQueues, redis } from './queue.js';
import { registerTelegramWebhook } from './telegram.js';
import { adminRoutes } from './web/admin.js';
import { analyticsRoutes } from './web/analytics.js';
import { assistantRoutes } from './web/assistant.js';
import { registerAuth } from './web/auth.js';
import { automationRoutes } from './web/automations.js';
import { channelRoutes } from './web/channels.js';
import { commentRoutes } from './web/comments.js';
import { commerceRoutes } from './web/commerce.js';
import { contactRoutes } from './web/contacts.js';
import { dashboardRoutes } from './web/dashboard.js';
import { inboxRoutes } from './web/inbox.js';
import { integrationRoutes } from './web/integrations.js';
import { knowledgeRoutes } from './web/knowledge.js';
import { leadRoutes } from './web/leads.js';
import { legalRoutes } from './web/legal.js';
import { metaRoutes } from './web/meta.js';
import { publicRoutes } from './web/public.js';
import { settingsRoutes } from './web/settings.js';
import { siteRoutes } from './web/site.js';
import { teamRoutes } from './web/team.js';

export async function buildServer() {
  const app = Fastify({
    // Trust exactly one proxy hop (the TLS proxy); trusting more would let clients spoof their IP for rate limiting.
    trustProxy: config.isProd ? (_addr: string, hop: number) => hop === 0 : false,
    bodyLimit: 512 * 1024,
    logger: {
      level: config.LOG_LEVEL ?? (config.isProd ? 'info' : 'debug'),
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-csrf-token"]',
          '*.access_token',
          '*.token',
          '*.password',
          '*.code',
          '*.secret',
        ],
        censor: '[redacted]',
      },
      // Query strings can carry OAuth codes / tokens: never log them.
      serializers: { req: (r) => ({ method: r.method, url: r.url.split('?')[0], ip: r.ip }) },
    },
  });

  // Keep the raw JSON body for webhook signature verification.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    req.rawBody = body as Buffer;
    try {
      done(null, (body as Buffer).length ? JSON.parse(body.toString('utf8')) : {});
    } catch {
      done(Object.assign(new Error('Invalid JSON'), { statusCode: 400 }), undefined);
    }
  });

  const META_MEDIA = ['https://*.cdninstagram.com', 'https://*.fbcdn.net', 'https://*.fbsbx.com'];
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://connect.facebook.net'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'], // FB SDK injects inline styles
        // Instagram CDN photos/video/audio in the inbox and post thumbnails; Facebook's own images in its login dialog.
        imgSrc: ["'self'", 'data:', ...META_MEDIA, 'https://*.facebook.com'],
        mediaSrc: ["'self'", ...META_MEDIA],
        connectSrc: ["'self'", 'https://graph.facebook.com', 'https://www.facebook.com', 'https://connect.facebook.net'],
        frameSrc: ['https://www.facebook.com', 'https://web.facebook.com', 'https://business.facebook.com'],
        formAction: ["'self'", 'https://t.me', 'https://wa.me', 'https://api.whatsapp.com'], // alert sign-up redirects after POST
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
      },
    },
    // Embedded Signup opens a Facebook popup that posts back via window.opener.
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
    hsts: config.isProd ? { maxAge: 31536000, includeSubDomains: true } : false,
    // Not "no-referrer": browsers then send `Origin: null` on form posts and the CSRF origin check fails.
    // same-origin still keeps URLs (e.g. password links) from leaking to other sites.
    referrerPolicy: { policy: 'same-origin' },
  });
  await app.register(cookie);
  await app.register(formbody, { bodyLimit: 128 * 1024 });
  // skipOnError: a Redis outage must not take the whole site down with it.
  await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute', redis, skipOnError: true });
  await app.register(staticFiles, { root: path.resolve('public'), prefix: '/public/', maxAge: '1h' });

  // Readiness (Docker healthcheck / Railway / uptime monitor). Postgres is required. Redis is not: without it
  // webhooks still land in the Postgres outbox and staff can still read and answer, so the web stays in service
  // and only reports itself degraded. No other details leaked.
  app.get('/readyz', { config: { rateLimit: false } }, async (_req, reply) => {
    try {
      await pool.query('SELECT 1');
    } catch {
      return reply.code(503).send({ ok: false });
    }
    const redisOk = await redis.ping().then(
      () => true,
      () => false,
    );
    return redisOk ? { ok: true } : { ok: true, degraded: true };
  });

  // Service worker must be served from the root to control /app pages.
  app.get('/sw.js', { config: { rateLimit: false } }, (_req, reply) => reply.header('Cache-Control', 'no-cache').sendFile('sw.js'));

  registerAuth(app);
  siteRoutes(app);
  leadRoutes(app);
  publicRoutes(app);
  legalRoutes(app);
  metaRoutes(app);
  dashboardRoutes(app);
  assistantRoutes(app);
  channelRoutes(app);
  settingsRoutes(app);
  automationRoutes(app);
  inboxRoutes(app);
  commentRoutes(app);
  commerceRoutes(app);
  analyticsRoutes(app);
  knowledgeRoutes(app);
  contactRoutes(app);
  teamRoutes(app);
  integrationRoutes(app);
  adminRoutes(app);

  app.setErrorHandler((err: any, req, reply) => {
    const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    if (status >= 500) {
      req.log.error({ err }, 'request failed');
      void healthSignal('server_error', `${req.method} ${req.routeOptions.url ?? ''}`);
    }
    reply
      .code(status)
      .type('text/plain; charset=utf-8')
      .send(status === 429 ? 'Too many requests' : status >= 500 ? 'Server error' : 'Bad request');
  });

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await assertEncryptionKey();
  await assertLeastPrivilege();
  const app = await buildServer();
  const close = async () => {
    await app.close();
    await Promise.allSettled([closeQueues(), pool.end()]);
    redis.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', close);
  process.on('SIGINT', close);
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  await registerTelegramWebhook().catch((e) => app.log.error({ err: e }, 'telegram webhook registration failed'));
}
