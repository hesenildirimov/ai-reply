import { describe, expect, it } from 'vitest';
import { toMessages } from '../src/ai.js';
import { parseInstagramWebhook } from '../src/channels/instagram.js';
import { parseWhatsAppWebhook } from '../src/channels/whatsapp.js';

describe('webhook parsers', () => {
  it('parses WhatsApp text and media, ignores statuses', () => {
    const ev = parseWhatsAppWebhook({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA',
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: '111' },
                contacts: [{ wa_id: '994501234567', profile: { name: 'Aysel' } }],
                messages: [
                  { from: '994501234567', id: 'wamid.1', type: 'text', text: { body: 'Salam' } },
                  { from: '994501234567', id: 'wamid.2', type: 'image', image: {} },
                ],
                statuses: [{ id: 'wamid.x', status: 'delivered' }],
              },
            },
          ],
        },
      ],
    });
    expect(ev).toMatchObject([
      {
        type: 'message',
        channelType: 'whatsapp',
        channelExternalId: '111',
        userId: '994501234567',
        userName: 'Aysel',
        mid: 'wamid.1',
        text: 'Salam',
        kind: 'text',
      },
      {
        type: 'message',
        channelType: 'whatsapp',
        channelExternalId: '111',
        userId: '994501234567',
        userName: 'Aysel',
        mid: 'wamid.2',
        text: null,
        kind: 'media',
        media: [{ type: 'image' }],
      },
    ]);
  });

  it('parses Instagram messages and echoes', () => {
    const ev = parseInstagramWebhook({
      object: 'instagram',
      entry: [
        {
          id: 'IG1',
          messaging: [
            { sender: { id: 'U1' }, recipient: { id: 'IG1' }, message: { mid: 'm1', text: 'Qiymət?' } },
            { sender: { id: 'IG1' }, recipient: { id: 'U1' }, message: { mid: 'm2', text: 'Cavab', is_echo: true } },
            { sender: { id: 'U1' }, recipient: { id: 'IG1' }, read: { mid: 'm2' } },
          ],
        },
      ],
    });
    expect(ev.map((e) => [e.type, (e as any).userId, (e as any).mid])).toEqual([
      ['message', 'U1', 'm1'],
      ['echo', 'U1', 'm2'],
    ]);
  });

  it('parses Instagram comments, story replies/mentions and quick replies', () => {
    const ev = parseInstagramWebhook({
      object: 'instagram',
      entry: [
        {
          id: 'IG1',
          time: 1700000000,
          messaging: [
            {
              sender: { id: 'U1' },
              recipient: { id: 'IG1' },
              message: { mid: 's1', text: 'Super!', reply_to: { story: { id: 'st1', url: 'https://cdn/x' } } },
            },
            {
              sender: { id: 'U2' },
              recipient: { id: 'IG1' },
              message: { mid: 's2', attachments: [{ type: 'story_mention', payload: { url: 'https://cdn/y' } }] },
            },
            { sender: { id: 'U3' }, recipient: { id: 'IG1' }, message: { mid: 'q1', text: 'Qiymət', quick_reply: { payload: 'qr:abc' } } },
          ],
          changes: [{ field: 'comments', value: { id: 'c1', text: 'qiymət?', from: { id: 'U4', username: 'aysel' }, media: { id: '999' } } }],
        },
      ],
    });
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
    expect(
      toMessages([
        { role: 'assistant', text: 'old' },
        { role: 'user', text: 'a' },
        { role: 'user', text: 'b' },
        { role: 'assistant', text: 'c' },
        { role: 'user', text: 'd' },
      ]),
    ).toEqual([
      { role: 'user', content: 'a\nb' },
      { role: 'assistant', content: 'c' },
      { role: 'user', content: 'd' },
    ]);
  });
});

describe('Russian in Latin letters', () => {
  it('detects translit Russian, not Azerbaijani, English or Cyrillic', async () => {
    const { isLatinRussian } = await import('../src/language.js');
    for (const t of ['privet', 'Skolko stoit eta sumka?', 'u vas est dostavka v Sumgait?', 'Mojno zakazat?', 'Salam skolko stoit', 'spasibo bolshoe'])
      expect(isLatinRussian(t), t).toBe(true);
    for (const t of [
      'Salam, qiymeti nece?',
      'Salam',
      'bu çanta var?',
      'Cənab, çatdırılma var?',
      'ok',
      'Привет, сколько стоит?',
      'Hello how much',
      'Zakaz vermək istəyirəm',
    ])
      expect(isLatinRussian(t), t).toBe(false);
  });
  it('the price guard also reads Cyrillic currency words', async () => {
    const { checkReply } = await import('../src/guard.js');
    expect(checkReply('Цена 50 манат', 'Don: 45 AZN')).toMatchObject({ ok: false, reason: 'unverified_price' });
    expect(checkReply('Стоит 45 манатов', 'Don: 45 AZN')).toEqual({ ok: true });
    expect(checkReply('30 ман.', 'Don: 45 AZN')).toMatchObject({ ok: false });
  });
  it('the price guard catches other currencies and ignores long numbers in the facts (A-9)', async () => {
    const { checkReply } = await import('../src/guard.js');
    const facts = 'Qiymət: 25 AZN';
    for (const t of [
      'Qiyməti 10 USD-dir',
      'Cəmi $10',
      '10$ olar',
      '15 € və ya 15 euro',
      '200 TL',
      '₺200',
      '100 rubl',
      '100 ₽',
      '100 рублей',
      '20 dollara',
      '20 доллар',
    ])
      expect(checkReply(t, facts), t).toMatchObject({ ok: false, reason: 'unverified_price' });
    expect(checkReply('25 AZN', 'Qiymət: 25 AZN, tel 0501234567')).toEqual({ ok: true });
    // a phone, IBAN or order number in the business info does not whitelist a made-up price
    expect(checkReply('Qiyməti 501234567 AZN', 'tel 0501234567')).toMatchObject({ ok: false });
    expect(checkReply('Qiyməti 2 USD', 'IBAN AZ21NABZ00000000137010001944')).toMatchObject({ ok: false });
    // ordinary words that only look like currency codes are not prices
    for (const t of ['10 mangal var', 'try 10 times', '3 man-ı', 'Saat 10-da'])
      expect(checkReply(t, facts), t).toEqual(t === '3 man-ı' ? expect.objectContaining({ ok: false }) : { ok: true });
  });
});
