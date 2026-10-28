/**
 * Before/after prompt-size comparison on a synthetic but realistic workspace (80 catalogue items, 30-message chat).
 * "Before" = the P2 behaviour: whole knowledge text in the cached system prompt + last 20 messages.
 * "After"  = P3: short general info cached, only relevant knowledge items, history within budget, routing.
 *
 * Numbers are ESTIMATES (chars/3.5) unless MEASURE_EXACT=1 and a real ANTHROPIC_API_KEY are set, in which case the
 * API's count_tokens endpoint is used for the input side. Run: npx tsx --env-file=.env scripts/measure-context.ts
 */
import Anthropic from '@anthropic-ai/sdk';
import { type AssistantProfile, buildSystem, type Turn, toMessages } from '../src/ai.js';
import { aiConfig, estimateTokens } from '../src/aiconfig.js';
import { chooseRoute, planKnowledge } from '../src/context.js';

const colors = ['qırmızı', 'ağ', 'qara', 'göy', 'yaşıl', 'bej'];
const kinds = ['don', 'köynək', 'şalvar', 'ətək', 'pencək', 'çanta', 'ayaqqabı', 'kəmər'];
function scenario(n: number) {
  const items = Array.from({ length: n }, (_, i) => {
    const k = kinds[i % kinds.length];
    return {
      kind: i % 10 === 9 ? 'faq' : 'price',
      title: `${k} model ${i + 1}`,
      body: `${k[0].toUpperCase() + k.slice(1)} model ${i + 1}: qiymət ${30 + (i % 7) * 5} AZN, ölçülər S-XL, rənglər ${colors[i % 6]} və ${colors[(i + 2) % 6]}. Material pambıq, Bakı daxili çatdırılma 1 gün.`,
      keywords: [`${k} ${i + 1}`],
    };
  });
  items.push({ kind: 'policy', title: 'Qaytarma', body: '14 gün ərzində etiketli məhsul geri qəbul olunur. Pul kartla qaytarılır.', keywords: [] });
  items.push({ kind: 'forbidden', title: 'Endirim', body: 'Fərdi endirim vəd etmə.', keywords: [] });

  const general = 'Mağaza: Nərgiz Butik. Ünvan: Nizami küç. 10, Bakı. İş saatı 10:00-20:00. Çatdırılma Bakı daxili 5 AZN, 50 AZN-dən yuxarı pulsuz.';
  const fullKnowledge = `${general}\n${items.map((i) => `${i.title}: ${i.body}`).join('\n')}`;
  const profile = (knowledge: string): AssistantProfile =>
    ({
      business_name: 'Nərgiz Butik',
      knowledge,
      style_preset: 'auto',
      style_guide: 'Qısa yazır, "qiymet" yazılışını işlədir, salamla başlayır.',
      disclose_ai: false,
    }) as AssistantProfile;

  const chat: Turn[] = Array.from({ length: 30 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    text:
      i % 2
        ? 'Salam, bəli var. Ölçünüzü yazın, yoxlayım. Çatdırılma Bakı daxili 1 gündür.'
        : `Salam, don model ${i + 3} ${colors[i % 6]} rəngdə var? Qiyməti neçədir?`,
  }));
  const latest = chat.filter((t) => t.role === 'user').at(-1)!.text;

  const before = { system: buildSystem(profile(fullKnowledge), false), messages: toMessages(chat.slice(-20)) };
  const { pinned, knowledge } = planKnowledge(items, latest);
  let used = 0;
  const recent: Turn[] = [];
  for (const t of [...chat].reverse()) {
    const n = estimateTokens(t.text);
    if (recent.length >= 20 || (recent.length >= 4 && used + n > aiConfig.limits.history_token_budget)) break;
    recent.unshift(t);
    used += n;
  }
  const after = { system: buildSystem(profile(general), false, { pinnedKnowledge: pinned, knowledge }), messages: toMessages(recent) };
  const route = chooseRoute(latest, recent.length, knowledge.length);

  return { before, after, route, pinned: !!pinned };
}
type Prompt = { system: ReturnType<typeof buildSystem>; messages: ReturnType<typeof toMessages> };
const est = (p: Prompt) => {
  const cached = estimateTokens(p.system[0].text);
  const dynamic = p.system.slice(1).reduce((s, b) => s + estimateTokens(b.text), 0) + p.messages.reduce((s, m) => s + estimateTokens(String(m.content)), 0);
  return { cached, dynamic, total: cached + dynamic };
};

async function exact(p: Prompt, model: string) {
  const client = new Anthropic();
  const r = await client.messages.countTokens({ model, system: p.system, messages: p.messages });
  return r.input_tokens;
}

const price = (model: string) => aiConfig.models[model];
const cost = (model: string, t: { cached: number; dynamic: number }, hit: boolean) => {
  const p = price(model);
  const out = 120 * p.output; // same assumed reply length for both
  return ((hit ? t.cached * p.cache_read : t.cached * p.cache_write) + t.dynamic * p.input + out) / 1e6;
};

const smart = aiConfig.routing.smart;
console.log(
  'Synthetic workspace, 30-message chat. Token counts are ESTIMATES (chars/3.5); costs use config/ai-models.json prices and an assumed 120-token reply.',
);
for (const n of [20, 80, 300]) {
  const { before, after, route, pinned } = scenario(n);
  const b = est(before);
  const a = est(after);
  const m = route === 'fast' ? aiConfig.routing.fast : smart;
  console.log(`\n${n} catalogue items — after: ${pinned ? 'whole knowledge pinned in cached prefix' : 'per-message retrieval'}, route=${route}`);
  console.table({
    before: { ...b, model: smart, 'hit $': cost(smart, b, true).toFixed(5), 'miss $': cost(smart, b, false).toFixed(5) },
    after: { ...a, model: m, 'hit $': cost(m, a, true).toFixed(5), 'miss $': cost(m, a, false).toFixed(5) },
    // Same prompt when the latest message is a simple one-question text and routing picks the fast model.
    'after, simple msg → fast': {
      ...a,
      model: aiConfig.routing.fast,
      'hit $': cost(aiConfig.routing.fast, a, true).toFixed(5),
      'miss $': cost(aiConfig.routing.fast, a, false).toFixed(5),
    },
  });
  if (process.env.MEASURE_EXACT === '1') console.log('count_tokens:', { before: await exact(before, smart), after: await exact(after, m) });
}
if (process.env.MEASURE_EXACT !== '1') console.log('\nSet MEASURE_EXACT=1 with a real ANTHROPIC_API_KEY to replace estimates with count_tokens.');
