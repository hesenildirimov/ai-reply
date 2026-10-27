// Photos, videos, voice messages; Russian in Latin letters; staff pause and hourly cap.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { aiText, fake, loginAs, resetDb, seedWorkspace, startFake, stopFake } from './helpers.js';

const enabled = !!process.env.TEST_DATABASE_URL && !!process.env.TEST_REDIS_URL;
const ffmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const FAKE = 'http://127.0.0.1:4011';

/** Test media made with ffmpeg: a large photo, a 3 s video with sound, a 1 s voice note. */
function makeMedia() {
  const dir = mkdtempSync(path.join(tmpdir(), 'mt-'));
  const f = (n: string) => path.join(dir, n);
  const ff = (...a: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...a]);
  ff('-f', 'lavfi', '-i', 'color=c=red:s=3000x2000', '-frames:v', '1', f('photo.jpg'));
  ff(
    '-f',
    'lavfi',
    '-i',
    'testsrc=d=3:s=320x240:r=10',
    '-f',
    'lavfi',
    '-i',
    'sine=f=440:d=3',
    '-shortest',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    f('clip.mp4'),
  );
  ff('-f', 'lavfi', '-i', 'sine=f=300:d=1', f('voice.wav'));
  return { photo: readFileSync(f('photo.jpg')), video: readFileSync(f('clip.mp4')), voice: readFileSync(f('voice.wav')) };
}

describe.skipIf(!enabled || !ffmpeg)('media, language, pauses (integration)', () => {
  let db: typeof import('../src/db.js');
  let pipeline: typeof import('../src/pipeline.js');
  let config: typeof import('../src/config.js').config;
  let app: import('fastify').FastifyInstance;
  let ws: Awaited<ReturnType<typeof seedWorkspace>>;
  let owner: Awaited<ReturnType<typeof loginAs>>;
  let media: ReturnType<typeof makeMedia>;
  let n = 0;

  const isVision = (b: any) => JSON.stringify(b?.system ?? '').includes('shop assistant who will answer');
  const visionCalls = () => fake.aiCalls().filter((c) => isVision(c.body));
  const replyCalls = () => fake.aiCalls().filter((c) => !isVision(c.body));
  const images = (b: any) => (b.messages[0].content as any[]).filter((x) => x.type === 'image');

  /** One inbound message through the real ingest path, then the reply job. */
  async function dm(ev: Record<string, unknown>) {
    const mid = `md.${++n}`;
    await pipeline.ingest({
      type: 'message',
      channelType: 'instagram',
      channelExternalId: 'IGM',
      userId: `M${n}`,
      userName: '',
      mid,
      text: null,
      ...ev,
    } as never);
    const row = await db.one(`SELECT id, conversation_id FROM messages WHERE external_id = $1`, [mid]);
    await pipeline.processReply(row.conversation_id, row.id);
    return { conversationId: row.conversation_id as string, messageId: row.id as string, user: `M${n}` };
  }
  const note = async (messageId: string) => {
    const { openText } = await import('../src/messages.js');
    const r = await db.one(`SELECT media_text FROM messages WHERE id = $1`, [messageId]);
    expect(r.media_text === '' || String(r.media_text).startsWith('v1:')).toBe(true); // encrypted at rest
    return openText(r.media_text);
  };
  const lastUserTurn = (b: any) => JSON.stringify(b.messages.at(-1).content);

  beforeAll(async () => {
    media = makeMedia();
    await startFake();
    db = await import('../src/db.js');
    pipeline = await import('../src/pipeline.js');
    config = (await import('../src/config.js')).config;
    await resetDb();
    ws = await seedWorkspace('media', 'IGM');
    app = await (await import('../src/server.js')).buildServer();
    owner = await loginAs(app, ws.email);
  });
  beforeEach(() => {
    fake.reset();
    config.STT_API_URL = undefined;
    config.STT_API_KEY = undefined;
  });
  afterAll(async () => {
    await app.close();
    await stopFake();
    (await import('../src/realtime.js')).closeRealtime();
    const { closeQueues, redis } = await import('../src/queue.js');
    await closeQueues();
    redis.disconnect();
    await db.pool.end();
  });

  it('photo: downscaled, described by the vision model, answered from the description, shown and searchable in the inbox', async () => {
    fake.handler = (b, p) =>
      p === '/cdn/photo.jpg'
        ? { file: { body: media.photo, type: 'image/jpeg' } }
        : p === '/v1/messages' && isVision(b)
          ? aiText('Qırmızı rəngli parça, üzərində yazı yoxdur.')
          : undefined;
    const { conversationId, messageId } = await dm({ kind: 'media', media: [{ type: 'image', url: `${FAKE}/cdn/photo.jpg` }] });
    expect(visionCalls()).toHaveLength(1);
    const [img] = images(visionCalls()[0]!.body);
    expect(img.source.media_type).toBe('image/jpeg');
    const dims = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', '-'], {
      input: Buffer.from(img.source.data, 'base64'),
    });
    expect(String(dims).trim()).toBe('1568,1045'); // 3000×2000 original, long edge capped
    expect(await note(messageId)).toBe('[Şəkil: Qırmızı rəngli parça, üzərində yazı yoxdur]');
    expect(lastUserTurn(replyCalls()[0]!.body)).toContain('[Şəkil: Qırmızı rəngli parça');
    expect(lastUserTurn(replyCalls()[0]!.body)).not.toContain('cannot be viewed');
    expect(fake.sends()).toHaveLength(1);
    const page = (await app.inject({ url: `/app/inbox/${conversationId}`, headers: owner.headers })).body;
    expect(page).toContain('Qırmızı rəngli parça');
    expect((await app.inject({ url: '/app/inbox?f=all&q=q%C4%B1rm%C4%B1z%C4%B1', headers: owner.headers })).body).toContain(conversationId);
    expect((await db.one(`SELECT count(*)::int AS n FROM ai_usage WHERE purpose = 'media'`)).n).toBe(1); // counts toward the AI budget
  });

  it('WhatsApp photo: downloaded through the Graph API with the channel token', async () => {
    const { encrypt } = await import('../src/crypto.js');
    await db.q(
      `INSERT INTO channels (workspace_id, type, external_id, display_name, access_token_enc) VALUES ($1, 'whatsapp', 'PNM', 'WA', $2) ON CONFLICT DO NOTHING`,
      [ws.workspaceId, encrypt('wa-token')],
    );
    fake.handler = (b, p) =>
      p.endsWith('/WAIMG1')
        ? { json: { url: `${FAKE}/wa/img.jpg`, mime_type: 'image/jpeg', file_size: media.photo.length } }
        : p === '/wa/img.jpg'
          ? { file: { body: media.photo, type: 'image/jpeg' } }
          : p === '/v1/messages' && isVision(b)
            ? aiText('Qırmızı fon.')
            : undefined;
    const mid = `wamid.md.${++n}`;
    await pipeline.ingest({
      type: 'message',
      channelType: 'whatsapp',
      channelExternalId: 'PNM',
      userId: '99455',
      userName: 'Aysel',
      mid,
      text: null,
      kind: 'media',
      media: [{ type: 'image', id: 'WAIMG1' }],
    } as never);
    const row = await db.one(`SELECT id, conversation_id FROM messages WHERE external_id = $1`, [mid]);
    await pipeline.processReply(row.conversation_id, row.id);
    expect(fake.calls.find((c) => c.path === '/wa/img.jpg')!.headers?.authorization).toBe('Bearer wa-token');
    expect(await note(row.id)).toBe('[Şəkil: Qırmızı fon]');
  });

  it('voice message: transcribed by the speech-to-text service; the AI answers what was said', async () => {
    config.STT_API_URL = `${FAKE}/v1/audio/transcriptions`;
    config.STT_API_KEY = 'stt-key';
    fake.handler = (_b, p) =>
      p === '/cdn/voice.m4a'
        ? { file: { body: media.voice, type: 'audio/wav' } }
        : p === '/v1/audio/transcriptions'
          ? { json: { text: 'Salam, Gəncəyə çatdırılma var?' } }
          : undefined;
    const { messageId } = await dm({ kind: 'media', media: [{ type: 'audio', url: `${FAKE}/cdn/voice.m4a` }] });
    const stt = fake.calls.find((c) => c.path === '/v1/audio/transcriptions')!;
    expect(stt.headers?.authorization).toBe('Bearer stt-key');
    expect(stt.raw).toContain('whisper-1');
    expect(await note(messageId)).toBe('[Səsli mesaj: "Salam, Gəncəyə çatdırılma var?"]');
    expect(visionCalls()).toHaveLength(0); // audio needs no vision call
    expect(lastUserTurn(replyCalls()[0]!.body)).toContain('Gəncəyə çatdırılma var?');
  });

  it('voice message without a speech-to-text service: the AI is told it could not be listened to', async () => {
    fake.handler = (_b, p) => (p === '/cdn/voice2.m4a' ? { file: { body: media.voice, type: 'audio/wav' } } : undefined);
    const { messageId } = await dm({ kind: 'media', media: [{ type: 'audio', url: `${FAKE}/cdn/voice2.m4a` }] });
    expect(await note(messageId)).toBe('[Səsli mesaj: dinləmək mümkün olmadı]');
    expect(lastUserTurn(replyCalls()[0]!.body)).toContain('dinləmək mümkün olmadı');
  });

  it('video: frames and transcribed sound go into one vision call', async () => {
    config.STT_API_URL = `${FAKE}/v1/audio/transcriptions`;
    config.STT_API_KEY = 'stt-key';
    fake.handler = (b, p) =>
      p === '/cdn/clip.mp4'
        ? { file: { body: media.video, type: 'video/mp4' } }
        : p === '/v1/audio/transcriptions'
          ? { json: { text: 'bu rəngdən var?' } }
          : p === '/v1/messages' && isVision(b)
            ? aiText('Rəngli test zolaqları göstərən qısa video.')
            : undefined;
    const { messageId } = await dm({ kind: 'media', media: [{ type: 'video', url: `${FAKE}/cdn/clip.mp4` }] });
    const call = visionCalls()[0]!.body;
    expect(images(call).length).toBe(2); // 3 s video -> 2 frames
    expect(JSON.stringify(call.messages)).toContain('bu rəngdən var?');
    expect(await note(messageId)).toBe('[Video: Rəngli test zolaqları göstərən qısa video. Səs: "bu rəngdən var?"]');
  });

  it('caption is kept and the note follows it; media from a non-Meta host is never fetched', async () => {
    const { messageId } = await dm({ text: 'Bu necəyədir?', kind: 'text', media: [{ type: 'image', url: 'https://evil.example.com/x.jpg' }] });
    expect(fake.calls.some((c) => c.path === '/x.jpg')).toBe(false);
    expect(await note(messageId)).toBe('[Şəkil: açmaq mümkün olmadı]');
    expect(lastUserTurn(replyCalls()[0]!.body)).toContain('Bu necəyədir?\\n[Şəkil: açmaq mümkün olmadı]');
  });

  it('Russian typed in Latin letters gets a Russian reply instruction; Azerbaijani does not', async () => {
    await dm({ text: 'Privet, skolko stoit dostavka?' });
    expect(JSON.stringify(replyCalls()[0]!.body.system)).toContain('Reply in Russian written in Cyrillic');
    fake.reset();
    await dm({ text: 'Salam, çatdırılma neçəyədir?' });
    expect(JSON.stringify(replyCalls()[0]!.body.system)).not.toContain('Reply in Russian');
  });

  it('after staff writes, the AI stays silent for 1 hour (not 12)', async () => {
    const { conversationId, user } = await dm({ text: 'Salam' });
    await pipeline.processEcho(ws.channelId, user, 'mid.staff.media', 'Əməkdaş cavabı', true);
    const r = await db.one(`SELECT extract(epoch FROM ai_paused_until - now())::int AS s FROM conversations WHERE id = $1`, [conversationId]);
    expect(r.s).toBeGreaterThan(3500);
    expect(r.s).toBeLessThanOrEqual(3600);
  });

  it('allows 30 AI replies per conversation per hour, then hands over', async () => {
    const { conversationId, user } = await dm({ text: 'Salam' });
    await db.q(
      `INSERT INTO messages (workspace_id, conversation_id, direction, sender, body, status) SELECT $1, $2, 'out', 'ai', 'x', 'sent' FROM generate_series(1, 28)`,
      [ws.workspaceId, conversationId],
    );
    const again = async (text: string) => {
      const mid = `md.${++n}`;
      await pipeline.ingest({
        type: 'message',
        channelType: 'instagram',
        channelExternalId: 'IGM',
        userId: user,
        userName: '',
        mid,
        text,
        kind: 'text',
      } as never);
      const row = await db.one(`SELECT id FROM messages WHERE external_id = $1`, [mid]);
      await pipeline.processReply(conversationId, row.id);
    };
    fake.reset();
    await again('Sual 30'); // 1 + 28 + this = 30th reply: still answered
    expect(replyCalls()).toHaveLength(1);
    await again('Sual 31');
    expect(replyCalls()).toHaveLength(1); // 31st: no AI call
    expect((await db.one(`SELECT needs_human FROM conversations WHERE id = $1`, [conversationId])).needs_human).toBe(true);
  });
});
