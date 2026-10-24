export type ChannelType = 'whatsapp' | 'instagram';

export type InboundEvent =
  | {
      type: 'message';
      channelType: ChannelType;
      channelExternalId: string;
      userId: string;
      userName: string;
      mid: string;
      /** null = unsupported content (media, stickers, ...) */
      text: string | null;
    }
  | { type: 'echo'; channelType: 'instagram'; channelExternalId: string; userId: string; mid: string; text: string };

export interface ChannelRow {
  id: string;
  workspace_id: string;
  type: ChannelType;
  external_id: string;
  waba_id: string | null;
  display_name: string;
  access_token_enc: string;
  token_expires_at: Date | null;
  status: 'active' | 'error';
}
