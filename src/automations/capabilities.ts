import type { ChannelRow } from '../channels/types.js';
import type { Trigger } from './schema.js';

export type CapabilityStatus = 'available' | 'requires_approval' | 'unsupported' | 'configuration_required';
export interface Capability {
  status: CapabilityStatus;
  note: string;
}

/**
 * What a trigger can really do on a channel, per Meta's official APIs. Only 'available' triggers can be activated.
 * Sources: Instagram Platform docs — private replies (instagram_business_manage_comments, webhook field "comments",
 * one reply per comment within 7 days), messaging webhooks (story replies via reply_to.story, story mentions as
 * story_mention attachments), quick replies (≤13). There is no generally available "new follower" webhook.
 */
export function capability(trigger: Trigger, ch: Pick<ChannelRow, 'type' | 'status' | 'scopes'> | null | undefined): Capability {
  if (trigger === 'follow') {
    return { status: 'unsupported', note: 'Meta-nın rəsmi API-si yeni izləyici hadisəsini (webhook) ümumi istifadə üçün təqdim etmir. Alternativ: şərhdən DM, story cavabı, DM açar sözü, Click-to-Instagram-Direct reklamı.' };
  }
  if (!ch) return { status: 'configuration_required', note: 'Əvvəlcə kanal bağlayın.' };
  if (ch.status !== 'active') return { status: 'configuration_required', note: 'Kanal yenidən bağlanmalıdır.' };
  const scopes = ch.scopes ?? [];
  if (ch.type === 'whatsapp') {
    if (trigger === 'dm_keyword' || trigger === 'quick_reply') return { status: 'available', note: 'WhatsApp-da düymələr ən çox 3 ədəd olur.' };
    return { status: 'unsupported', note: 'WhatsApp-da şərh və story yoxdur.' };
  }
  if (trigger === 'comment') {
    return scopes.includes('instagram_business_manage_comments')
      ? { status: 'available', note: 'Hər şərhə 1 şəxsi mesaj, şərhdən sonra 7 gün ərzində.' }
      : { status: 'configuration_required', note: 'Instagram-ı yenidən bağlayın: şərhlərə giriş icazəsi (instagram_business_manage_comments) verilməyib.' };
  }
  if (!scopes.includes('instagram_business_manage_messages')) return { status: 'configuration_required', note: 'Mesaj icazəsi yoxdur, Instagram-ı yenidən bağlayın.' };
  if (trigger === 'story_mention') return { status: 'available', note: 'Hesab story-də mention edildikdə (yalnız story; post tag-ləri hadisə göndərmir).' };
  return { status: 'available', note: '' };
}

export const TRIGGER_LABELS: Record<Trigger, { title: string; desc: string }> = {
  comment: { title: 'Şərhdən DM', desc: 'Post və ya Reel-ə açar sözlü şərh yazana şəxsi mesaj' },
  dm_keyword: { title: 'DM açar sözü', desc: 'Direct-də açar söz yazana hazır cavab' },
  story_reply: { title: 'Story cavabı', desc: 'Story-nizə cavab yazana avtomatik mesaj' },
  story_mention: { title: 'Story mention', desc: 'Sizi story-də qeyd edənə təşəkkür mesajı' },
  quick_reply: { title: 'Düymə cavabı', desc: 'Quick reply düyməsinə toxunduqda davam edən addımlar' },
  follow: { title: 'Yeni izləyici', desc: 'İzləyən kimi mesaj' },
};
