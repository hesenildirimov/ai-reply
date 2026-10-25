export type ChannelType = 'whatsapp' | 'instagram';

export type MessageKind = 'text' | 'media' | 'story_reply' | 'story_mention' | 'quick_reply';
export interface Media {
  type: string; // image | video | audio | file | story_mention | share | reel ...
  url?: string; // Instagram CDN URL (expires); WhatsApp media needs an authenticated download, so only `id`
  id?: string;
}

export type InboundEvent =
  | {
      type: 'message';
      channelType: ChannelType;
      channelExternalId: string;
      userId: string;
      userName: string;
      mid: string;
      /** null = no text (media only) */
      text: string | null;
      kind?: MessageKind;
      media?: Media[];
      /** Quick reply / button / postback payload */
      payload?: string;
    }
  | { type: 'echo'; channelType: 'instagram'; channelExternalId: string; userId: string; mid: string; text: string }
  | {
      type: 'comment';
      channelType: 'instagram';
      channelExternalId: string;
      commentId: string;
      parentId?: string;
      mediaId: string;
      fromId: string;
      fromUsername: string;
      text: string;
      /** Webhook entry time (ms); Meta allows private replies for 7 days after the comment. */
      time: number;
    };

export interface ChannelRow {
  id: string;
  workspace_id: string;
  type: ChannelType;
  external_id: string;
  waba_id: string | null;
  display_name: string;
  access_token_enc: string;
  token_expires_at: Date | null;
  status: 'active' | 'reauth_required';
  status_reason?: string;
  scopes?: string[];
}
