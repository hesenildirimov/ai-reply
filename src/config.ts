import { z } from 'zod';

const optional = z.string().trim().min(1).optional().catch(undefined);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  APP_URL: z.url(),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  // 32 bytes, base64. Generate: openssl rand -base64 32
  ENCRYPTION_KEY: z.string().refine((v) => Buffer.from(v, 'base64').length === 32, 'ENCRYPTION_KEY must be 32 bytes base64'),

  ANTHROPIC_API_KEY: optional,
  AI_EFFORT: z.enum(['low', 'medium', 'high']).default('low'),
  AI_DEBOUNCE_MS: z.coerce.number().int().min(0).default(4000),
  // 'on' = simple messages use the fast/cheap model from config/ai-models.json
  AI_ROUTING: z.enum(['on', 'off']).default('on'),
  // Max AI calls per workspace per minute (protects against bursts / runaway cost)
  AI_WORKSPACE_RPM: z.coerce.number().int().min(1).default(30),

  // Meta app (WhatsApp Cloud API + Embedded Signup)
  META_APP_ID: optional,
  META_APP_SECRET: optional,
  META_GRAPH_VERSION: z.string().regex(/^v\d+\.\d+$/).default('v24.0'),
  META_WEBHOOK_VERIFY_TOKEN: optional,
  WA_EMBEDDED_SIGNUP_CONFIG_ID: optional,
  // Instagram API with Instagram Login (separate app id/secret shown in the Instagram product settings)
  IG_APP_ID: optional,
  IG_APP_SECRET: optional,
  // Overridable for tests only
  META_GRAPH_BASE: z.url().default('https://graph.facebook.com'),
  IG_GRAPH_BASE: z.url().default('https://graph.instagram.com'),
  IG_API_BASE: z.url().default('https://api.instagram.com'),

  // Telegram alerts: create a bot with @BotFather
  TELEGRAM_BOT_TOKEN: optional,
  TELEGRAM_BOT_USERNAME: optional,
  TELEGRAM_WEBHOOK_SECRET: z.string().regex(/^[A-Za-z0-9_-]{16,256}$/).optional().catch(undefined),
  TELEGRAM_API_BASE: z.url().default('https://api.telegram.org'),

  // WhatsApp alerts from the platform's own WhatsApp Business number (approved utility template)
  PLATFORM_WA_PHONE_NUMBER_ID: optional,
  PLATFORM_WA_TOKEN: optional,
  PLATFORM_WA_NUMBER: z.string().regex(/^\d{8,15}$/).optional().catch(undefined), // digits only, e.g. 994501234567
  PLATFORM_WA_TEMPLATE: optional,
  PLATFORM_WA_TEMPLATE_LANG: z.string().default('az'),
  // Browser (Chrome) push: npx web-push generate-vapid-keys
  VAPID_PUBLIC_KEY: optional,
  VAPID_PRIVATE_KEY: optional,
  VAPID_SUBJECT: z.string().default('mailto:support@example.com'),

  SMTP_URL: optional,
  MAIL_FROM: z.string().default('AI Reply <no-reply@example.com>'),

  LEGAL_COMPANY_NAME: z.string().default('[Şirkət adı]'),
  LEGAL_ADDRESS: z.string().default('[Ünvan], Bakı, Azərbaycan'),
  SUPPORT_EMAIL: z.string().default('support@example.com'),
  CONTACT_PHONE: z.string().default(''),

  RETENTION_DAYS: z.coerce.number().int().min(1).default(90),

  // Capacity (defaults measured with scripts/loadtest.ts, see README "Capacity"). Per process.
  DB_POOL_MAX: z.coerce.number().int().min(2).max(200).default(20),
  // Parallel AI replies / sends per worker process (I/O-bound: mostly waiting for Claude and Meta).
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(500).default(25),
  // Parallel webhook-intake jobs per worker process (short DB work).
  INBOUND_CONCURRENCY: z.coerce.number().int().min(1).max(500).default(50),
  DEFAULT_REPLY_LIMIT: z.coerce.number().int().min(0).default(1000),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment:', z.prettifyError(parsed.error));
  process.exit(1);
}
const env = parsed.data;

if (env.NODE_ENV === 'production') {
  const missing: string[] = env.ANTHROPIC_API_KEY ? [] : ['ANTHROPIC_API_KEY'];
  if (!env.APP_URL.startsWith('https://')) missing.push('APP_URL(https)');
  if (missing.length) {
    console.error(`Missing required production config: ${missing.join(', ')}`);
    process.exit(1);
  }
}

export const config = {
  ...env,
  isProd: env.NODE_ENV === 'production',
  appOrigin: new URL(env.APP_URL).origin,
  whatsappEnabled: Boolean(env.META_APP_ID && env.META_APP_SECRET && env.WA_EMBEDDED_SIGNUP_CONFIG_ID),
  mailEnabled: Boolean(env.SMTP_URL),
  waAlertsEnabled: Boolean(env.PLATFORM_WA_PHONE_NUMBER_ID && env.PLATFORM_WA_TOKEN && env.PLATFORM_WA_NUMBER && env.PLATFORM_WA_TEMPLATE),
  pushEnabled: Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY),
  instagramEnabled: Boolean(env.IG_APP_ID && env.IG_APP_SECRET),
};
