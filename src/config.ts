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
  AI_MODEL: z.string().default('claude-opus-5-5'),
  AI_EFFORT: z.enum(['low', 'medium', 'high']).default('low'),
  AI_DEBOUNCE_MS: z.coerce.number().int().min(0).default(4000),

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

  SMTP_URL: optional,
  MAIL_FROM: z.string().default('AI Reply <no-reply@example.com>'),

  LEGAL_COMPANY_NAME: z.string().default('[Şirkət adı]'),
  LEGAL_ADDRESS: z.string().default('[Ünvan], Bakı, Azərbaycan'),
  SUPPORT_EMAIL: z.string().default('support@example.com'),
  CONTACT_PHONE: z.string().default(''),

  RETENTION_DAYS: z.coerce.number().int().min(1).default(90),
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
  instagramEnabled: Boolean(env.IG_APP_ID && env.IG_APP_SECRET),
};
