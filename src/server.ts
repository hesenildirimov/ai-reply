import path from 'node:path';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import Fastify from 'fastify';
import { config } from './config.js';
import { pool } from './db.js';
import { queue, redis } from './queue.js';
import { appRoutes } from './web/app.js';
import { registerAuth } from './web/auth.js';
import { legalRoutes } from './web/legal.js';
import { metaRoutes } from './web/meta.js';
import { publicRoutes } from './web/public.js';

export async function buildServer() {
  const app = Fastify({
    trustProxy: config.isProd, // behind the hosting provider's TLS proxy
    bodyLimit: 512 * 1024,
    logger: {
      level: config.isProd ? 'info' : 'debug',
      redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-csrf-token"]'],
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

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://connect.facebook.net'],
        styleSrc: ["'self'", "'unsafe-inline'"], // FB SDK injects inline styles
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'", 'https://graph.facebook.com', 'https://www.facebook.com', 'https://connect.facebook.net'],
        frameSrc: ['https://www.facebook.com', 'https://web.facebook.com', 'https://business.facebook.com'],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
      },
    },
    // Embedded Signup opens a Facebook popup that posts back via window.opener.
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
    hsts: config.isProd ? { maxAge: 31536000, includeSubDomains: true } : false,
  });
  await app.register(cookie);
  await app.register(formbody, { bodyLimit: 128 * 1024 });
  await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute', redis });
  await app.register(staticFiles, { root: path.resolve('public'), prefix: '/public/', maxAge: '1h' });

  registerAuth(app);
  publicRoutes(app);
  legalRoutes(app);
  metaRoutes(app);
  appRoutes(app);

  app.setErrorHandler((err: any, req, reply) => {
    const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    if (status >= 500) req.log.error({ err }, 'request failed');
    reply.code(status).type('text/plain; charset=utf-8').send(status === 429 ? 'Too many requests' : status >= 500 ? 'Server error' : 'Bad request');
  });

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = await buildServer();
  const close = async () => {
    await app.close();
    await Promise.allSettled([queue.close(), pool.end()]);
    redis.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', close);
  process.on('SIGINT', close);
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
}
