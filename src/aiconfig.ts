import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const price = z.object({ input: z.number(), output: z.number(), cache_read: z.number(), cache_write: z.number() });
const schema = z.object({
  models: z.record(z.string(), price),
  routing: z.object({ fast: z.string(), smart: z.string() }),
  limits: z.object({
    max_output_tokens: z.number().int().positive(),
    history_token_budget: z.number().int().positive(),
    knowledge_token_budget: z.number().int().positive(),
    summary_after_messages: z.number().int().positive(),
  }),
});

/** Single source of truth for model names, prices and AI budgets (config/ai-models.json, overridable via AI_MODELS_FILE). */
export const aiConfig = schema.parse(JSON.parse(readFileSync(path.resolve(process.env.AI_MODELS_FILE ?? 'config/ai-models.json'), 'utf8')));

// Env overrides keep deployments flexible without editing the file.
if (process.env.AI_MODEL) aiConfig.routing.smart = process.env.AI_MODEL;
if (process.env.AI_MODEL_FAST) aiConfig.routing.fast = process.env.AI_MODEL_FAST;

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/** Estimated USD cost from list prices. Returns 0 for models without a price entry (shown as unknown in the UI). */
export function estimateCost(model: string, u: Usage): number {
  const p = aiConfig.models[model];
  if (!p) return 0;
  return (u.input_tokens * p.input + u.output_tokens * p.output + (u.cache_read_input_tokens ?? 0) * p.cache_read + (u.cache_creation_input_tokens ?? 0) * p.cache_write) / 1e6;
}

/** Rough token estimate (≈3.5 chars/token for Azerbaijani/Latin text). Used only for budgeting context, never for billing. */
export const estimateTokens = (s: string) => Math.ceil(s.length / 3.5);
