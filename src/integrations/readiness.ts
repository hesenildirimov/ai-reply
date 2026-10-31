import { config } from '../config.js';
import { one } from '../db.js';
import { telegramConfigured } from './telegram-api.js';

export interface ReadinessItem {
  label: string;
  /** Where it is set. */
  source: string;
  ok: boolean;
}

/**
 * What production mode still needs. Shown on the Events page so production never looks functional while credentials or
 * verification are missing. Nothing here tries to authenticate anywhere.
 */
export async function integrationReadiness(workspaceId: string) {
  const igTokens = await one<{ n: number }>(`SELECT count(*)::int AS n FROM channels WHERE workspace_id = $1 AND type = 'instagram' AND status = 'active'`, [
    workspaceId,
  ]);
  const items: ReadinessItem[] = [
    { label: 'Meta App ID', source: 'META_APP_ID', ok: !!config.META_APP_ID },
    { label: 'Meta App Secret', source: 'META_APP_SECRET', ok: !!config.META_APP_SECRET },
    { label: 'Instagram access token', source: 'Kanallar → Instagram bağlayın', ok: (igTokens?.n ?? 0) > 0 },
    { label: 'Telegram Bot Token', source: 'TELEGRAM_BOT_TOKEN', ok: !!config.TELEGRAM_BOT_TOKEN },
    { label: 'Telegram webhook secret', source: 'TELEGRAM_WEBHOOK_SECRET', ok: !!config.TELEGRAM_WEBHOOK_SECRET },
    { label: 'Telegram bot istifadəçi adı', source: 'TELEGRAM_BOT_USERNAME', ok: telegramConfigured() },
  ];
  const verified = config.META_COMMERCE_VERIFIED === 'on';
  return { mode: config.INTEGRATION_MODE, items, commerceVerified: verified, ready: items.every((i) => i.ok) && verified };
}
