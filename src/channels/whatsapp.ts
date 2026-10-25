import { config } from '../config.js';
import { randomDigits } from '../crypto.js';
import { fbPath, graph, GraphError } from './graph.js';
import type { InboundEvent } from './types.js';

export const WA_TEXT_LIMIT = 4096;
const G = () => config.META_GRAPH_BASE;

/** Normalizes a WhatsApp Cloud API webhook body. Statuses and non-message fields are ignored. */
export function parseWhatsAppWebhook(body: any): InboundEvent[] {
  const out: InboundEvent[] = [];
  for (const entry of body?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      if (change?.field !== 'messages') continue;
      const v = change.value ?? {};
      const pid = v.metadata?.phone_number_id;
      if (typeof pid !== 'string') continue;
      const names = new Map<string, string>((v.contacts ?? []).map((c: any) => [c?.wa_id, c?.profile?.name ?? '']));
      for (const m of v.messages ?? []) {
        if (typeof m?.from !== 'string' || typeof m?.id !== 'string') continue;
        const reply = m.interactive?.button_reply ?? m.interactive?.list_reply;
        const text =
          m.type === 'text' ? m.text?.body
          : m.type === 'button' ? m.button?.text
          : m.type === 'interactive' ? reply?.title
          : typeof m[m.type]?.caption === 'string' ? m[m.type].caption
          : null;
        const mediaObj = ['image', 'video', 'audio', 'document', 'sticker'].includes(m.type) ? m[m.type] : null;
        const payload = m.type === 'interactive' ? reply?.id : m.type === 'button' ? m.button?.payload : undefined;
        out.push({
          type: 'message',
          channelType: 'whatsapp',
          channelExternalId: pid,
          userId: m.from,
          userName: names.get(m.from) ?? '',
          mid: m.id,
          text: typeof text === 'string' && text.trim() ? text : null,
          kind: payload ? 'quick_reply' : mediaObj && !text ? 'media' : 'text',
          media: mediaObj ? [{ type: m.type, id: String(mediaObj.id ?? '') }] : undefined,
          payload: typeof payload === 'string' ? payload : undefined,
        });
      }
    }
  }
  return out;
}

/**
 * Finishes Embedded Signup. The waba_id / phone_number_id come from the browser, so they are
 * verified against what the exchanged token can actually access before anything is stored.
 */
export async function completeEmbeddedSignup(code: string, wabaId: string, phoneNumberId: string) {
  const { access_token: token } = await graph<{ access_token: string }>(G(), fbPath('oauth/access_token'), {
    query: { client_id: config.META_APP_ID!, client_secret: config.META_APP_SECRET!, code },
  });
  const phones = await graph<{ data: { id: string; display_phone_number?: string; verified_name?: string }[] }>(
    G(), fbPath(`${wabaId}/phone_numbers`), { token, appSecretProof: true, query: { fields: 'id,display_phone_number,verified_name' } },
  );
  const phone = phones.data.find((p) => p.id === phoneNumberId);
  if (!phone) throw new Error('Phone number does not belong to the authorized WhatsApp Business Account');

  await graph(G(), fbPath(`${wabaId}/subscribed_apps`), { method: 'POST', token, appSecretProof: true });

  const pin = randomDigits(6);
  let registered = true;
  try {
    await graph(G(), fbPath(`${phoneNumberId}/register`), { token, appSecretProof: true, json: { messaging_product: 'whatsapp', pin } });
  } catch (e) {
    // Numbers already registered on Cloud API (or using coexistence) reject re-registration.
    if (!(e instanceof GraphError)) throw e;
    registered = false;
  }
  return {
    token,
    displayName: [phone.verified_name, phone.display_phone_number].filter(Boolean).join(' · '),
    pin: registered ? pin : null,
  };
}

export async function sendWhatsAppText(token: string, phoneNumberId: string, to: string, text: string, quickReplies?: { title: string; payload: string }[]): Promise<string> {
  // Up to 3 reply buttons (title ≤ 20 chars) — WhatsApp's interactive "button" message.
  const message = quickReplies?.length
    ? { type: 'interactive', interactive: { type: 'button', body: { text: text.slice(0, 1024) }, action: { buttons: quickReplies.slice(0, 3).map((q) => ({ type: 'reply', reply: { id: q.payload.slice(0, 256), title: q.title.slice(0, 20) } })) } } }
    : { type: 'text', text: { body: text.slice(0, WA_TEXT_LIMIT), preview_url: false } };
  const res = await graph<{ messages: { id: string }[] }>(G(), fbPath(`${phoneNumberId}/messages`), {
    token,
    appSecretProof: true,
    json: { messaging_product: 'whatsapp', recipient_type: 'individual', to, ...message },
  });
  return res.messages[0]!.id;
}

/** Marks the message read and shows a typing indicator while the AI works. Best effort. */
export async function markWhatsAppRead(token: string, phoneNumberId: string, messageId: string): Promise<void> {
  await graph(G(), fbPath(`${phoneNumberId}/messages`), {
    token,
    appSecretProof: true,
    json: { messaging_product: 'whatsapp', status: 'read', message_id: messageId, typing_indicator: { type: 'text' } },
  }).catch(() => {});
}

export async function unsubscribeWhatsApp(token: string, wabaId: string): Promise<void> {
  await graph(G(), fbPath(`${wabaId}/subscribed_apps`), { method: 'DELETE', token, appSecretProof: true });
}

/** Template message (works outside the 24h window). Params can't contain newlines/tabs or long runs of spaces. */
export async function sendWhatsAppTemplate(token: string, phoneNumberId: string, to: string, name: string, lang: string, params: string[]): Promise<string> {
  const clean = (s: string) => s.replace(/[\n\t]+/g, ' ').replace(/ {4,}/g, ' ').trim().slice(0, 300) || '-';
  const res = await graph<{ messages: { id: string }[] }>(G(), fbPath(`${phoneNumberId}/messages`), {
    token,
    appSecretProof: true,
    json: {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: { name, language: { code: lang }, components: [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: clean(p) })) }] },
    },
  });
  return res.messages[0]!.id;
}
