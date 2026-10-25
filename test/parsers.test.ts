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
    expect(ev).toMatchObject([
      { type: 'message', channelType: 'whatsapp', channelExternalId: '111', userId: '994501234567', userName: 'Aysel', mid: 'wamid.1', text: 'Salam', kind: 'text' },
      { type: 'message', channelType: 'whatsapp', channelExternalId: '111', userId: '994501234567', userName: 'Aysel', mid: 'wamid.2', text: null, kind: 'media', media: [{ type: 'image' }] },
    ]);
  });

  it('parses Instagram messages and echoes', () => {
    const ev = parseInstagramWebhook({ object: 'instagram', entry: [{ id: 'IG1', messaging: [
      { sender: { id: 'U1' }, recipient: { id: 'IG1' }, message: { mid: 'm1', text: 'Qiymət?' } },
      { sender: { id: 'IG1' }, recipient: { id: 'U1' }, message: { mid: 'm2', text: 'Cavab', is_echo: true } },
      { sender: { id: 'U1' }, recipient: { id: 'IG1' }, read: { mid: 'm2' } },
    ] }] });
    expect(ev.map((e) => [e.type, (e as any).userId, (e as any).mid])).toEqual([['message', 'U1', 'm1'], ['echo', 'U1', 'm2']]);
  });

  it('parses Instagram comments, story replies/mentions and quick replies', () => {
    const ev = parseInstagramWebhook({ object: 'instagram', entry: [{ id: 'IG1', time: 1700000000, messaging: [
      { sender: { id: 'U1' }, recipient: { id: 'IG1' }, message: { mid: 's1', text: 'Super!', reply_to: { story: { id: 'st1', url: 'https://cdn/x' } } } },
      { sender: { id: 'U2' }, recipient: { id: 'IG1' }, message: { mid: 's2', attachments: [{ type: 'story_mention', payload: { url: 'https://cdn/y' } }] } },
      { sender: { id: 'U3' }, recipient: { id: 'IG1' }, message: { mid: 'q1', text: 'Qiymət', quick_reply: { payload: 'qr:abc' } } },
    ], changes: [{ field: 'comments', value: { id: 'c1', text: 'qiymət?', from: { id: 'U4', username: 'aysel' }, media: { id: '999' } } }] }] });
    expect(ev).toMatchObject([
      { type: 'message', kind: 'story_reply', text: 'Super!' },
      { type: 'message', kind: 'story_mention', text: null },
      { type: 'message', kind: 'quick_reply', payload: 'qr:abc' },
      { type: 'comment', commentId: 'c1', fromId: 'U4', fromUsername: 'aysel', mediaId: '999', text: 'qiymət?', time: 1700000000000 },
    ]);
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
