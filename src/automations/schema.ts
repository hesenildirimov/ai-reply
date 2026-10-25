import { z } from 'zod';

export const TRIGGERS = ['comment', 'dm_keyword', 'story_reply', 'story_mention', 'quick_reply', 'follow'] as const;
export type Trigger = (typeof TRIGGERS)[number];

const keyword = z.string().trim().min(1).max(60);
const text = z.string().trim().min(1).max(1000);

export const quickReplySchema = z.object({
  title: z.string().trim().min(1).max(20),
  /** Automation (trigger = quick_reply) to run when tapped; empty = just record the answer. */
  goto: z.string().uuid().or(z.literal('')).default(''),
});

export const stepSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('message'), text, quick_replies: z.array(quickReplySchema).max(13).default([]), track_links: z.boolean().default(false) }),
  z.object({ type: z.literal('tag'), add: z.array(z.string().trim().min(1).max(40)).max(10).default([]), remove: z.array(z.string().trim().min(1).max(40)).max(10).default([]) }),
  z.object({ type: z.literal('field'), key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), value: z.string().max(500) }),
  z.object({
    type: z.literal('condition'),
    check: z.enum(['has_tag', 'not_tag', 'field_equals']),
    tag: z.string().max(40).default(''),
    key: z.string().max(40).default(''),
    value: z.string().max(500).default(''),
  }),
  z.object({ type: z.literal('delay'), minutes: z.number().int().min(1).max(1380) }), // < 24h window
  z.object({ type: z.literal('handoff'), note: z.string().max(200).default('') }),
  z.object({ type: z.literal('ai') }),
]);
export type Step = z.infer<typeof stepSchema>;

export const configSchema = z.object({
  match: z
    .object({
      mode: z.enum(['any', 'all', 'exact', 'anything']).default('any'),
      keywords: z.array(keyword).max(50).default([]),
      exclude: z.array(keyword).max(50).default([]),
    })
    .default({ mode: 'any', keywords: [], exclude: [] }),
  /** Comment trigger: which posts/reels. */
  media: z.object({ scope: z.enum(['all', 'selected']).default('all'), ids: z.array(z.string().regex(/^\d{1,30}$/)).max(50).default([]) }).default({ scope: 'all', ids: [] }),
  /** Comment trigger: optional public reply under the comment (one is picked at random). */
  public_reply: z.object({ enabled: z.boolean().default(false), texts: z.array(z.string().trim().min(1).max(300)).max(5).default([]) }).default({ enabled: false, texts: [] }),
  steps: z.array(stepSchema).max(20).default([]),
});
export type AutomationConfig = z.infer<typeof configSchema>;

export const defaultConfig = (trigger: Trigger): AutomationConfig =>
  configSchema.parse({
    match: { mode: trigger === 'dm_keyword' || trigger === 'comment' ? 'any' : 'anything', keywords: [] },
    steps: [{ type: 'message', text: trigger === 'comment' ? 'Salam! Məlumatı sizə yazdım 🙏' : 'Salam! 🙂' }],
  });

/** Trigger-specific rules (Meta limits) checked before activation. Returns human-readable errors. */
export function validateForTrigger(trigger: Trigger, c: AutomationConfig): string[] {
  const errors: string[] = [];
  const messages = c.steps.filter((s) => s.type === 'message');
  if (!messages.length && !c.steps.some((s) => s.type === 'ai' || s.type === 'handoff')) errors.push('Ən azı bir mesaj, AI və ya operator addımı əlavə edin.');
  if ((trigger === 'comment' || trigger === 'dm_keyword') && c.match.mode !== 'anything' && !c.match.keywords.length) errors.push('Açar söz əlavə edin və ya "istənilən mətn" seçin.');
  if (trigger === 'comment') {
    // Meta: one private reply per comment; further messages only after the person answers.
    if (messages.length > 1) errors.push('Şərhə yalnız 1 şəxsi mesaj göndərmək olar (Meta qaydası). Növbəti mesajları "Quick reply" düymələri ilə davam etdirin.');
    if (c.steps.some((s) => s.type === 'delay' || s.type === 'ai')) errors.push('Şərh avtomatlaşdırmasında gecikmə və AI addımı istifadə edilə bilməz: istifadəçi hələ cavab yazmayıb.');
    if (c.media.scope === 'selected' && !c.media.ids.length) errors.push('Ən azı bir post seçin.');
    if (c.public_reply.enabled && !c.public_reply.texts.length) errors.push('İctimai cavab mətni yazın.');
  }
  for (const s of messages) if (s.quick_replies.length > 13) errors.push('Ən çox 13 quick reply düyməsi ola bilər.');
  return errors;
}
