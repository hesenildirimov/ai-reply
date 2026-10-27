import webpush from 'web-push';
import { z } from 'zod';
import { config } from './config.js';

if (config.pushEnabled) webpush.setVapidDetails(config.VAPID_SUBJECT, config.VAPID_PUBLIC_KEY!, config.VAPID_PRIVATE_KEY!);

// The server POSTs to the subscription endpoint, so only real browser push services are allowed (prevents SSRF).
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^[a-z0-9-]+\.notify\.windows\.com$/, /^web\.push\.apple\.com$/];

export const subscriptionSchema = z.object({
  endpoint: z
    .url()
    .max(1000)
    .refine((u) => {
      const url = URL.parse(u);
      return url?.protocol === 'https:' && !url.port && PUSH_HOSTS.some((h) => h.test(url.hostname));
    }, 'unsupported push service'),
  keys: z.object({ p256dh: z.string().regex(/^[A-Za-z0-9_-]{40,200}$/), auth: z.string().regex(/^[A-Za-z0-9_-]{10,50}$/) }),
});
export type PushSubscription = z.infer<typeof subscriptionSchema>;

/** Returns false when the subscription is gone (unsubscribed/expired) and should be deleted. */
export async function sendPush(sub: PushSubscription, payload: { title: string; body: string; url: string }): Promise<boolean> {
  try {
    await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 3600, urgency: 'high' });
    return true;
  } catch (e: any) {
    if (e?.statusCode === 404 || e?.statusCode === 410) return false;
    throw new Error(`push failed: ${e?.statusCode ?? ''}`);
  }
}
