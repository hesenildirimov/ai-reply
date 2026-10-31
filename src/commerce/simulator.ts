import { randomBytes } from 'node:crypto';
import { parseInstagramWebhook } from '../channels/instagram.js';
import type { ChannelRow } from '../channels/types.js';
import { config } from '../config.js';
import { one, q } from '../db.js';
import { accept, eventJob } from '../inbound.js';
import { createTelegramLinkCode, handleTelegramUpdate } from '../telegram-updates.js';
import { detectNewPosts } from './posts.js';

/**
 * Development simulator (INTEGRATION_MODE=mock only). It plays the part of Instagram and Telegram: it builds events in
 * the exact shape Meta and Telegram deliver them and hands them to the same entry points the real webhooks use
 * (inbound intake -> worker -> pipeline). Nothing is shortcut inside the business logic.
 */
export class SimulatorDisabled extends Error {}

const assertMock = () => {
  if (!config.mockMode) throw new SimulatorDisabled('The simulator only exists with INTEGRATION_MODE=mock');
};

const igChannel = (workspaceId: string, channelId?: string) =>
  one<ChannelRow>(`SELECT * FROM channels WHERE workspace_id = $1 AND type = 'instagram' AND ($2::uuid IS NULL OR id = $2) ORDER BY created_at LIMIT 1`, [
    workspaceId,
    channelId ?? null,
  ]);

const uid = () => randomBytes(5).toString('hex');

/** "Publishes" a post on the simulated Instagram account. It is not noticed until detection runs. */
export async function simulatePublishPost(workspaceId: string, caption: string, mediaType = 'IMAGE', channelId?: string): Promise<{ mediaId: string }> {
  assertMock();
  const ch = await igChannel(workspaceId, channelId);
  if (!ch) throw new Error('no Instagram account');
  const mediaId = `mock_media_${Date.now()}${uid()}`;
  await q(`INSERT INTO mock_ig_media (channel_id, media_id, caption, media_type, permalink) VALUES ($1, $2, $3, $4, $5)`, [
    ch.id,
    mediaId,
    caption.slice(0, 1000),
    mediaType,
    `https://www.instagram.com/p/${mediaId}/`,
  ]);
  return { mediaId };
}

/** New-post detection for the account, exactly as the worker's sweep does it. */
export async function simulateDetectPosts(workspaceId: string, channelId?: string) {
  assertMock();
  const ch = await igChannel(workspaceId, channelId);
  return ch ? detectNewPosts(ch) : [];
}

const intake = (body: unknown) => accept(parseInstagramWebhook(body).map(eventJob));

/** A customer comment, as Instagram's `comments` webhook delivers it. */
export async function simulateComment(workspaceId: string, mediaId: string, text: string, from: { id: string; username: string }, channelId?: string) {
  assertMock();
  const ch = await igChannel(workspaceId, channelId);
  if (!ch) throw new Error('no Instagram account');
  const commentId = `mock_comment_${Date.now()}${uid()}`;
  const body = {
    object: 'instagram',
    entry: [
      {
        id: ch.external_id,
        time: Math.floor(Date.now() / 1000),
        changes: [{ field: 'comments', value: { id: commentId, text, from, media: { id: mediaId, media_product_type: 'FEED' } } }],
      },
    ],
  };
  await intake(body);
  return { commentId, body };
}

/** A customer tapping a button of a card (messaging_postbacks webhook). */
export async function simulatePostback(workspaceId: string, userId: string, payload: string, title = 'Qiyməti göstər', channelId?: string) {
  assertMock();
  const ch = await igChannel(workspaceId, channelId);
  if (!ch) throw new Error('no Instagram account');
  const body = {
    object: 'instagram',
    entry: [
      {
        id: ch.external_id,
        time: Date.now(),
        messaging: [
          { sender: { id: userId }, recipient: { id: ch.external_id }, timestamp: Date.now(), postback: { mid: `mock.pb.${uid()}`, title, payload } },
        ],
      },
    ],
  };
  await intake(body);
  return { body };
}

/** A plain customer DM (messages webhook). */
export async function simulateDm(workspaceId: string, userId: string, text: string, channelId?: string) {
  assertMock();
  const ch = await igChannel(workspaceId, channelId);
  if (!ch) throw new Error('no Instagram account');
  const body = {
    object: 'instagram',
    entry: [
      {
        id: ch.external_id,
        time: Date.now(),
        messaging: [{ sender: { id: userId }, recipient: { id: ch.external_id }, message: { mid: `mock.dm.${uid()}`, text } }],
      },
    ],
  };
  await intake(body);
  return { body };
}

/** The owner pressing /start in the bot: a new simulated Telegram chat is linked to the business. */
export async function simulateTelegramConnect(workspaceId: string, userId: string): Promise<{ chatId: string }> {
  assertMock();
  const code = await createTelegramLinkCode(workspaceId, userId);
  const chatId = 7_000_000_000 + Math.floor(Math.random() * 900_000_000);
  await handleTelegramUpdate({
    message: { message_id: 1, chat: { id: chatId, type: 'private' }, from: { id: chatId, first_name: 'Demo', username: 'demo_owner' }, text: `/start ${code}` },
  });
  return { chatId: String(chatId) };
}

/** A press on an inline-keyboard button of a message the (simulated) bot sent. */
export async function simulateTelegramCallback(chatId: string, messageId: string, data: string) {
  assertMock();
  await handleTelegramUpdate({
    callback_query: {
      id: `mock.cb.${uid()}`,
      from: { id: Number(chatId) },
      message: { message_id: Number(messageId), chat: { id: Number(chatId), type: 'private' } },
      data,
    },
  });
}
