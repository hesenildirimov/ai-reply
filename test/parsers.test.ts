import { describe, expect, it } from 'vitest';
import { parseInstagramWebhook } from '../src/channels/instagram.js';
import { parseWhatsAppWebhook } from '../src/channels/whatsapp.js';
import { toMessages } from '../src/ai.js';

describe('webhook parsers', () => {
  it('parses WhatsApp text and media, ignores statuses', () => {
    const ev = parseWhatsAppWebhook({
      object: 'whatsapp_business_account',
      entry: [{ id: 'WABA', changes: [{ field: 'messages', value: {
        metadata: { phone_number_id: '111' },
        contacts: [{ wa_id: '994501234567', profile: { name: 'Aysel' } }],
        messages: [
          { from: '994501234567', id: 'wamid.1', type: 'text', text: { body: 'Salam' } },
          { from: '994501234567', id: 'wamid.2', type: 'image', image: {} },
        ],
        statuses: [{ id: 'wamid.x', status: 'delivered' }],
      } }] }],
    });
    expect(ev).toEqual([
      { type: 'message', channelType: 'whatsapp', channelExternalId: '111', userId: '994501234567', userName: 'Aysel', mid: 'wamid.1', text: 'Salam' },
      { type: 'message', channelType: 'whatsapp', channelExternalId: '111', userId: '994501234567', userName: 'Aysel', mid: 'wamid.2', text: null },
    ]);
  });

  it('parses Instagram messages and echoes', () => {
    const ev = parseInstagramWebhook({ object: 'instagram', entry: [{ id: 'IG1', messaging: [
      { sender: { id: 'U1' }, recipient: { id: 'IG1' }, message: { mid: 'm1', text: 'Qiymət?' } },
      { sender: { id: 'IG1' }, recipient: { id: 'U1' }, message: { mid: 'm2', text: 'Cavab', is_echo: true } },
      { sender: { id: 'U1' }, recipient: { id: 'IG1' }, read: { mid: 'm2' } },
    ] }] });
    expect(ev.map((e) => [e.type, e.userId, e.mid])).toEqual([['message', 'U1', 'm1'], ['echo', 'U1', 'm2']]);
  });
});

describe('toMessages', () => {
  it('merges same-role turns and starts/ends with user', () => {
    expect(toMessages([
      { role: 'assistant', text: 'old' },
      { role: 'user', text: 'a' }, { role: 'user', text: 'b' },
      { role: 'assistant', text: 'c' },
      { role: 'user', text: 'd' },
    ])).toEqual([{ role: 'user', content: 'a\nb' }, { role: 'assistant', content: 'c' }, { role: 'user', content: 'd' }]);
  });
});
