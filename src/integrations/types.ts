/**
 * Provider interfaces for the two outside systems the product talks to. The business logic (comment handling, product
 * cards, notifications, the reply pipeline) only ever calls these; INTEGRATION_MODE picks the implementation:
 *   mock        -> MockInstagramProvider / MockTelegramProvider: nothing leaves the server, results are SIMULATED
 *   production  -> MetaInstagramProvider / TelegramBotProvider: the real Meta Graph and Telegram Bot APIs
 */

/**
 * SIMULATED  the mock provider handled it; nothing was sent to anyone.
 * PENDING    accepted, outcome not known yet.
 * DELIVERED  a REAL provider confirmed the delivery. The mock providers can never return this (also enforced by a CHECK
 *            constraint on integration_events).
 * FAILED     the send was refused or errored.
 * RECEIVED   (events only) a real inbound event from Meta or Telegram.
 */
export type DeliveryStatus = 'SIMULATED' | 'PENDING' | 'DELIVERED' | 'FAILED';
export type EventStatus = DeliveryStatus | 'RECEIVED';

export interface SendResult {
  /** Provider message id (Meta message_id / Telegram message_id); synthetic "mock.…" ids in mock mode. */
  id: string;
  status: DeliveryStatus;
}

/** Where an Instagram message goes: a user in the 24 h window, or the one private reply to a comment. */
export interface Recipient {
  userId: string;
  commentId?: string;
}

/** Everything a provider needs to act for one connected Instagram account (the token stays encrypted until used). */
export interface IgAccount {
  channelId: string;
  workspaceId: string;
  /** Instagram professional account id (webhook `entry.id`). */
  externalId: string;
  accessTokenEnc: string;
}

export interface QuickReply {
  title: string;
  payload: string;
}

/** One card of a Generic Template (carousel): Meta allows 10 per message, title 80 chars, up to 3 buttons. */
export interface Card {
  title: string;
  subtitle?: string;
  imageUrl?: string;
  buttons: { type: 'postback'; title: string; payload: string }[];
}

export interface InstagramMedia {
  id: string;
  caption: string;
  mediaType: string;
  permalink: string;
  thumbUrl: string;
  timestamp: string;
}

export interface InstagramProvider {
  readonly name: 'mock' | 'meta';
  sendText(acct: IgAccount, to: Recipient, text: string, quickReplies?: QuickReply[]): Promise<SendResult>;
  /** Generic Template / Rich Card carousel. */
  sendCards(acct: IgAccount, to: Recipient, cards: Card[]): Promise<SendResult>;
  /** Public reply under a comment. */
  replyToComment(acct: IgAccount, commentId: string, text: string): Promise<SendResult>;
  /** Newest posts of the account, newest first (new-post detection compares them with what is already stored). */
  listRecentMedia(acct: IgAccount, limit?: number): Promise<InstagramMedia[]>;
  /** Caption of one post (context for a comment under it). */
  mediaCaption(acct: IgAccount, mediaId: string): Promise<string>;
  /** "@username" of a customer, '' when unknown (inbox display only). */
  profileName(acct: IgAccount, igsid: string): Promise<string>;
  /** Texts the business itself sent in recent DM threads (writing-style learning). */
  ownMessages(acct: IgAccount): Promise<string[]>;
  /** Stops webhook delivery for the account (best effort, when a channel is removed). */
  unsubscribe(acct: IgAccount): Promise<void>;
}

export interface InlineButton {
  text: string;
  /** Telegram allows 64 bytes. */
  callbackData: string;
}

export interface TelegramProvider {
  readonly name: 'mock' | 'bot';
  /** False when the bot is not set up (production without token) — callers skip silently, as before. */
  enabled(): boolean;
  sendMessage(chatId: string, text: string, keyboard?: InlineButton[][]): Promise<SendResult>;
  /** Replaces the keyboard of a message we sent (after a button press). */
  editKeyboard(chatId: string, messageId: string, keyboard: InlineButton[][]): Promise<SendResult>;
  /** Stops the loading spinner on a pressed button. */
  answerCallback(callbackQueryId: string, text?: string): Promise<SendResult>;
}
