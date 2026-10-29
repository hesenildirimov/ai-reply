import { config } from './config.js';
import { q } from './db.js';
import { sendMail } from './mailer.js';
import { redis } from './queue.js';

/**
 * Platform alerts: an e-mail to every platform admin plus one structured log line (`event: 'platform_alert'`) that a
 * log drain can page on. Used for admin actions that touch customers (audit H-2) and for health signals (L-4).
 * `throttleKey`: at most one alert per key per `throttleSeconds`. Never throws: an alert must not break the action.
 */
export async function alertAdmins(subject: string, text: string, opts: { throttleKey?: string; throttleSeconds?: number } = {}): Promise<void> {
  try {
    if (opts.throttleKey && (await redis.set(`alert:${opts.throttleKey}`, '1', 'EX', opts.throttleSeconds ?? 3600, 'NX')) !== 'OK') return;
    console.warn(JSON.stringify({ level: 40, event: 'platform_alert', subject }));
    if (!config.mailEnabled) return;
    const admins = await q<{ email: string }>(`SELECT email FROM users WHERE is_admin AND email_verified_at IS NOT NULL`);
    for (const a of admins) await sendMail(a.email, `AI Reply: ${subject}`, text).catch(() => {});
  } catch (e) {
    console.error('platform alert failed:', (e as Error).message);
  }
}

/** Short "who, when, from where" line for admin-action alerts. */
export const actor = (email: string, ip: string) => `${email} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC · IP ${ip}`;

const HEALTH = {
  login_locked: { threshold: 20, windowSeconds: 3600, subject: 'çox sayda bloklanmış giriş (brute force ola bilər)' },
  server_error: { threshold: 20, windowSeconds: 600, subject: 'server xətaları artıb (5xx)' },
  job_dead: { threshold: 10, windowSeconds: 3600, subject: 'arxa plan işləri alınmır (təkrarlardan sonra da uğursuz)' },
} satisfies Record<string, { threshold: number; windowSeconds: number; subject: string }>;

/**
 * Counts a health signal in a time bucket; when the count reaches the signal's threshold, the platform admins are
 * alerted once (audit L-4: lockouts, 5xx and dead jobs must not go unnoticed). Never throws.
 */
export async function healthSignal(signal: keyof typeof HEALTH, detail = ''): Promise<void> {
  const h = HEALTH[signal];
  try {
    const bucket = Math.floor(Date.now() / (h.windowSeconds * 1000));
    const key = `health:${signal}:${bucket}`;
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, h.windowSeconds * 2);
    if (n === h.threshold)
      await alertAdmins(
        h.subject,
        `${h.threshold}+ hadisə son ${Math.round(h.windowSeconds / 60)} dəqiqədə.${detail ? `\nSon: ${detail}` : ''}\nLoglara baxın.`,
        {
          throttleKey: `health:${signal}`,
          throttleSeconds: h.windowSeconds,
        },
      );
  } catch {
    // Redis down: the log line is still there for the log drain.
  }
}
