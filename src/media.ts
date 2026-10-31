import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describeMedia, type ImageMime } from './ai.js';
import type { ChannelRow, Media } from './channels/types.js';
import { fetchWhatsAppMedia } from './channels/whatsapp.js';
import { config } from './config.js';
import { decrypt } from './crypto.js';

/**
 * Photos, videos and voice messages customers send. Claude reads images, not audio or video, so:
 * - photo: downscaled JPEG -> Claude writes a short note of what it shows;
 * - video: a few frames + the sound track transcribed -> one note;
 * - voice message: transcribed by the speech-to-text service (STT_API_URL), the transcript is the note.
 * The note ("[Şəkil: ...]", "[Səsli mesaj: "..."]") is stored encrypted with the message (messages.media_text): the AI
 * reads it in the conversation, staff see it in the inbox. Without ffmpeg / STT the note says what could not be opened.
 */

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_VIDEO_BYTES = 25 * 1024 * 1024;
const MAX_ITEMS = 3; // per message
const MAX_SECONDS = 180; // of video / voice that is analysed
const FRAMES = 4; // per video, 768 px: enough to see what happens, ~4× cheaper than full-size
const LONG_EDGE = 1568; // larger images cost more tokens without helping a shop assistant

// Instagram attachment / story URLs come from Meta's CDNs; anything else is refused (the URL is customer-controlled data).
const IG_MEDIA_HOSTS = ['fbsbx.com', 'fbcdn.net', 'cdninstagram.com', 'instagram.com', 'facebook.com'];
const allowedHost = (u: URL) =>
  (u.protocol === 'https:' && IG_MEDIA_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`))) ||
  u.origin === new URL(config.IG_GRAPH_BASE).origin;

/** Downloads an Instagram CDN file, following redirects only to allowed hosts, with a size cap. */
async function downloadInstagram(url: string, maxBytes: number): Promise<{ body: Buffer; mime: string }> {
  let u = new URL(url);
  for (let hop = 0; hop < 4; hop++) {
    if (!allowedHost(u)) throw new Error('media host not allowed');
    const res = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(20_000) });
    const next = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && next) {
      u = new URL(next, u);
      continue;
    }
    if (!res.ok) throw new Error(`media download ${res.status}`);
    if (Number(res.headers.get('content-length') ?? 0) > maxBytes) throw new Error('media too large');
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length > maxBytes) throw new Error('media too large');
    return { body, mime: (res.headers.get('content-type') ?? '').split(';')[0]!.trim() };
  }
  throw new Error('too many redirects');
}

const download = async (ch: ChannelRow, m: Media, maxBytes: number) => {
  if (ch.type === 'whatsapp' && m.id) {
    const f = await fetchWhatsAppMedia(decrypt(ch.access_token_enc), m.id, maxBytes);
    return { body: Buffer.from(f.body), mime: f.mime };
  }
  if (m.url) return downloadInstagram(m.url, maxBytes);
  throw new Error('no media source');
};

// ---------- ffmpeg ----------

let ffmpegOk: Promise<boolean> | undefined;
// ffmpeg is a large C decoder surface fed with customer files (audit M-2). Beyond the size caps and the 30 s wall
// clock it runs with OS limits: 60 s CPU, 2 GB address space, 200 MB per written file, lowest CPU priority.
const LIMITS = 'ulimit -t 60 -v 2097152 -f 409600 2>/dev/null; exec nice -n 19 "$0" "$@"';
const run = (cmd: string, args: string[], timeoutMs = 30_000) =>
  new Promise<string>((resolve, reject) => {
    const p = spawn('/bin/sh', ['-c', LIMITS, cmd, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} failed: ${err.trim().slice(0, 200)}`));
    });
  });
export const hasFfmpeg = () =>
  (ffmpegOk ??= run('ffmpeg', ['-version'], 5000).then(
    () => true,
    () => false,
  ));

// Customer files are untrusted: a "video" may really be a playlist pointing at URLs (SSRF). ffmpeg reads local files
// only, and only through the demuxers real photos, videos and voice notes need (no playlists, no exotic containers).
const DEMUXERS = 'mov,matroska,ogg,mp3,wav,aac,flac,amr,jpeg_pipe,png_pipe,webp_pipe,gif,gif_pipe,image2,mjpeg';
const LOCAL_ONLY = ['-protocol_whitelist', 'file', '-format_whitelist', DEMUXERS, '-threads', '2'];

/** Fits within edge×edge, never upscales. */
const scale = (edge: number) => `scale='min(${edge},iw)':'min(${edge},ih)':force_original_aspect_ratio=decrease`;

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'media-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** One JPEG frame no larger than LONG_EDGE (also turns WebP stickers / PNG / GIF into JPEG). */
async function toJpeg(dir: string, input: string): Promise<Buffer> {
  const out = path.join(dir, 'photo.jpg');
  await run('ffmpeg', ['-y', '-v', 'error', ...LOCAL_ONLY, '-i', input, '-frames:v', '1', '-vf', scale(LONG_EDGE), '-q:v', '4', out]);
  return readFile(out);
}

async function videoFrames(dir: string, input: string): Promise<Buffer[]> {
  const duration = Math.min(
    // An unreadable file (or a refused format) is not an error of the job: no frames, and the note says so.
    Number(await run('ffprobe', ['-v', 'error', ...LOCAL_ONLY, '-show_entries', 'format=duration', '-of', 'csv=p=0', input]).catch(() => '0')) || 0,
    MAX_SECONDS,
  );
  const n = duration < 4 ? 2 : FRAMES;
  const frames: Buffer[] = [];
  for (let i = 0; i < n; i++) {
    const out = path.join(dir, `f${i}.jpg`);
    const at = ((duration * (i + 0.5)) / n).toFixed(2);
    await run('ffmpeg', ['-y', '-v', 'error', '-ss', at, ...LOCAL_ONLY, '-i', input, '-frames:v', '1', '-vf', scale(768), '-q:v', '5', out]).catch(() => {});
    frames.push(
      ...(await readFile(out).then(
        (b) => [b],
        () => [],
      )),
    );
  }
  return frames;
}

/** Mono 16 kHz WAV of the first MAX_SECONDS of sound, or null when the file has no sound track. */
async function soundTrack(dir: string, input: string): Promise<Buffer | null> {
  const out = path.join(dir, 'sound.wav');
  try {
    await run('ffmpeg', ['-y', '-v', 'error', ...LOCAL_ONLY, '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-t', String(MAX_SECONDS), out]);
    return await readFile(out);
  } catch {
    return null;
  }
}

// ---------- speech to text ----------

export const sttEnabled = () => !!(config.STT_API_URL && config.STT_API_KEY);

/** Transcript of speech (any language), via an OpenAI-compatible /audio/transcriptions endpoint. */
async function transcribe(audio: Buffer, mime: string, name: string): Promise<string | null> {
  if (!sttEnabled()) return null;
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(audio)], { type: mime }), name);
  form.append('model', config.STT_MODEL);
  const res = await fetch(config.STT_API_URL!, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.STT_API_KEY}` },
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`speech-to-text ${res.status}`);
  const text = String(((await res.json().catch(() => ({}))) as { text?: unknown }).text ?? '').trim();
  return text ? text.replace(/\s+/g, ' ').slice(0, 4000) : null;
}

// ---------- notes ----------

const kindOf = (m: Media, mime: string): 'photo' | 'video' | 'audio' | 'other' =>
  mime.startsWith('image/')
    ? 'photo'
    : mime.startsWith('video/')
      ? 'video'
      : mime.startsWith('audio/')
        ? 'audio'
        : ['image', 'sticker', 'animated_image'].includes(m.type)
          ? 'photo'
          : ['video', 'reel', 'ig_reel'].includes(m.type)
            ? 'video'
            : m.type === 'audio'
              ? 'audio'
              : 'other';

const CLAUDE_IMAGE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const quote = (t: string) => `"${t.replace(/"/g, "'")}"`;
const clause = (t: string) => t.trim().replace(/[.\s]+$/, '');

export interface NoteCtx {
  workspaceId: string;
  conversationId: string;
  /** Model for looking at photos / video frames (assistants.media_model). */
  route?: 'fast' | 'smart';
}

/** Note for one attachment. AI-call failures propagate (the reply job retries); download/format problems become a note. */
async function noteFor(ch: ChannelRow, m: Media, ctx: NoteCtx): Promise<string> {
  const guess = kindOf(m, '');
  let file: { body: Buffer; mime: string };
  try {
    file = await download(ch, m, guess === 'photo' ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES);
  } catch {
    return guess === 'audio'
      ? '[Səsli mesaj: açmaq mümkün olmadı]'
      : guess === 'video'
        ? '[Video: açmaq mümkün olmadı]'
        : guess === 'photo'
          ? '[Şəkil: açmaq mümkün olmadı]'
          : '[Fayl: açmaq mümkün olmadı]';
  }
  const kind = kindOf(m, file.mime);
  if (kind === 'other') return '[Fayl göndərdi: baxmaq mümkün olmadı]';
  const ff = await hasFfmpeg();
  return withTmp(async (dir) => {
    const input = path.join(dir, 'input');
    await writeFile(input, file.body);
    if (kind === 'photo') {
      // Without ffmpeg the original is sent if Claude reads its format.
      const img = ff
        ? await toJpeg(dir, input).then(
            (data) => ({ data, mime: 'image/jpeg' as const }),
            () => null,
          )
        : CLAUDE_IMAGE.has(file.mime)
          ? { data: file.body, mime: file.mime as ImageMime }
          : null;
      if (!img) return '[Şəkil: açmaq mümkün olmadı]';
      const desc = await describeMedia({ kind: 'photo', images: [img] }, { ...ctx, purpose: 'media' });
      return desc ? `[Şəkil: ${clause(desc)}]` : '[Şəkil: baxmaq mümkün olmadı]';
    }
    if (!ff) return kind === 'audio' ? '[Səsli mesaj: dinləmək mümkün olmadı]' : '[Video: baxmaq mümkün olmadı]';
    const sound = await soundTrack(dir, input);
    const transcript = sound ? await transcribe(sound, 'audio/wav', 'sound.wav').catch(() => null) : null;
    if (kind === 'audio') return transcript ? `[Səsli mesaj: ${quote(transcript)}]` : '[Səsli mesaj: dinləmək mümkün olmadı]';
    const frames = (await videoFrames(dir, input)).map((data) => ({ data, mime: 'image/jpeg' as const }));
    if (!frames.length) return transcript ? `[Video: görüntü açılmadı. Səs: ${quote(transcript)}]` : '[Video: baxmaq mümkün olmadı]';
    const desc = await describeMedia({ kind: 'video', images: frames, transcript }, { ...ctx, purpose: 'media' });
    return `[Video: ${clause(desc) || 'baxmaq mümkün olmadı'}${transcript ? `. Səs: ${quote(transcript)}` : ''}]`;
  });
}

/** Notes for the attachments of one message, joined. */
export async function mediaNote(ch: ChannelRow, media: Media[], ctx: NoteCtx): Promise<string> {
  if (config.MEDIA_ANALYSIS === 'off') return '';
  const notes: string[] = [];
  for (const m of media.filter((x) => x.url || x.id).slice(0, MAX_ITEMS)) notes.push(await noteFor(ch, m, ctx));
  return notes.join('\n');
}
