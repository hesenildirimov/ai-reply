import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { generateReply } from '../ai.js';
import { reserveReply } from '../billing.js';
import { one, q } from '../db.js';
import { audit } from '../events.js';
import { aiBudgetExceeded } from '../plans.js';
import { queue } from '../queue.js';
import { requirePerm, requireUser } from './auth.js';
import { csrfField, html, pageHead, raw, type Safe } from './html.js';
import { icon } from './icons.js';
import { MESSAGES, view } from './public.js';
import { fmt } from './ui.js';

Object.assign(MESSAGES, {
  limit: { type: 'error', text: 'Aylıq AI cavab limitiniz bitib.' },
  ai_budget: { type: 'error', text: 'AI büdcəsi bitib.' },
  learning: { type: 'ok', text: 'Yazışmalarınız oxunur. Üslub 1-2 dəqiqəyə hazır olacaq, sonra səhifəni yeniləyin.' },
});

/** AI assistant settings, style learning and the test chat. */
export function assistantRoutes(app: FastifyInstance) {
  app.register(async (r) => {
    r.addHook('preHandler', requireUser);

    // ---------- Assistant ----------
    r.get('/app/assistant', { preHandler: requirePerm('assistant.write') }, async (req, reply) => {
      const a = await one(`SELECT a.*, w.region FROM assistants a JOIN workspaces w ON w.id = a.workspace_id WHERE a.workspace_id = $1`, [
        req.user!.workspaceId,
      ]);
      const eu = a.region === 'eu';
      return view(
        req,
        reply,
        'AI köməkçi',
        html`${pageHead('AI köməkçi', 'AI yalnız burada yazdığınız məlumatlara əsasən cavab verir. Bilmədiyi sualı sizə ötürür.')}
        <form method="post" action="/app/assistant" class="form-grid">${csrfField(req.csrfToken)}
          <section class="card span">
            <label class="switch-row"><span><b>Avtomatik cavablar</b><small>Söndürsəniz, AI heç bir mesaja cavab vermir.</small></span>
              <input type="checkbox" class="switch" name="enabled" value="1" ${a.enabled ? raw('checked') : ''}></label></section>
          <section class="card span"><div class="card-head"><h2>${icon('book')}Biznes məlumatları</h2></div>
            <label>Biznesin adı<input name="business_name" value="${a.business_name}" maxlength="120" required></label>
            <label>Məlumat bazası
              <textarea name="knowledge" rows="14" maxlength="30000" placeholder="Nə satırsınız, qiymətlər, iş saatları, ünvan, çatdırılma, ödəniş üsulları, qaytarma qaydaları, tez-tez verilən suallar...">${a.knowledge}</textarea>
              <small class="help">Nə qədər ətraflı yazsanız, AI bir o qədər dəqiq cavab verir. Qiymət dəyişəndə burada yeniləyin.</small></label></section>
          <section class="card span"><div class="card-head"><h2>${icon('sparkle')}Danışıq üslubu</h2>
              <button class="btn sm secondary" formaction="/app/assistant/learn" formnovalidate>${icon('book')}Yazışmalarımdan öyrən</button></div>
            <p class="muted">AI sizin kimi yazsın deyə köhnə yazışmalarınızı oxuyur: yazılış (məsələn "qiymet"), "sən/siz", emoji, mesaj uzunluğu.
              ${a.style_learned_at ? html`Son öyrənmə: <b>${fmt(a.style_learned_at)}</b>.` : html`Instagram tarixçəsi və paneldən yazdığınız cavablar istifadə olunur.`}</p>
            <label>Öyrənilmiş üslub (istəsəniz düzəldin)
              <textarea name="style_guide" rows="6" maxlength="1500" placeholder="Hələ öyrənilməyib. Yuxarıdakı düyməni basın və ya özünüz yazın: məsələn, 'ə' əvəzinə 'e' yazır, 'siz' deyir, hər mesajın sonunda 🙏 qoyur.">${a.style_guide}</textarea></label>
            <label>Ümumi ton
              <select name="style_preset">${[
                ['auto', 'Avtomatik (müştəriyə uyğunlaşır)'],
                ['friendly', 'Səmimi, isti'],
                ['polite', 'Nəzakətli, "siz"'],
                ['short', 'Çox qısa, tez'],
              ].map(([v, l]) => html`<option value="${v}" ${a.style_preset === v ? raw('selected') : ''}>${l}</option>`)}</select></label>
            <label class="switch-row"><span><b>AI olduğunu bildir</b><small>${
              eu
                ? 'Avropa İttifaqında satış edirsiniz: AI ilk cavabda özünü AI köməkçi kimi təqdim etməlidir (AI Act). Bu seçim söndürülə bilməz.'
                : 'Söndürülüb: AI özünü təqdim etmir. Müştəri ciddi şəkildə "bot-san?" soruşarsa, yalan danışmır.'
            }</small></span>
              <input type="checkbox" class="switch" name="ai_disclosure" value="1" ${a.ai_disclosure || eu ? raw('checked') : ''} ${eu ? raw('disabled') : ''}></label></section>
          <section class="card span"><div class="card-head"><h2>${icon('headset')}Bilmədiyi suallar</h2></div>
            <p class="muted">AI cavabı bilməyəndə müştəriyə öz üslubunda qısa, təbii bir cavab yazır (operator və ya AI sözü işlətmədən) və sizə bildiriş göndərir.</p>
            <label>Ehtiyat gözləmə mesajı<input name="handoff_message" value="${a.handoff_message}" maxlength="500"></label>
            <small class="help">Müştəri "operator" və ya "insan" yazanda, ya da limit bitəndə göndərilir. Boş qoysanız, heç nə yazılmır.</small></section>
          <div class="span form-actions"><a class="btn secondary" href="/app/test">${icon('flask')}Test et</a><button class="btn">Yadda saxla</button></div>
        </form>`,
      );
    });

    r.post('/app/assistant', { preHandler: requirePerm('assistant.write') }, async (req, reply) => {
      const p = z
        .object({
          business_name: z.string().trim().min(1).max(120),
          knowledge: z.string().max(30000),
          style_guide: z.string().trim().max(1500),
          style_preset: z.enum(['auto', 'friendly', 'polite', 'short']),
          handoff_message: z.string().trim().max(500),
          enabled: z.literal('1').optional(),
          ai_disclosure: z.literal('1').optional(),
        })
        .safeParse(req.body);
      if (!p.success) return reply.redirect('/app/assistant?m=invalid');
      const d = p.data;
      // EU market: disclosure stays on whatever the form sends (a disabled checkbox is not submitted).
      await q(
        `UPDATE assistants a SET business_name = $2, knowledge = $3, style_guide = $4, style_preset = $5, handoff_message = $6, enabled = $7,
           ai_disclosure = $8 OR (SELECT region = 'eu' FROM workspaces w WHERE w.id = a.workspace_id), updated_at = now() WHERE workspace_id = $1`,
        [req.user!.workspaceId, d.business_name, d.knowledge, d.style_guide, d.style_preset, d.handoff_message, !!d.enabled, !!d.ai_disclosure],
      );
      await audit(req.user!.workspaceId, req.user!.id, 'assistant.update', 'workspace', req.user!.workspaceId, { enabled: !!d.enabled });
      return reply.redirect('/app/assistant?m=saved');
    });

    // One learning run per workspace at a time; each run is a single small AI call.
    r.post(
      '/app/assistant/learn',
      { preHandler: requirePerm('assistant.write'), config: { rateLimit: { max: 3, timeWindow: '1 hour' } } },
      async (req, reply) => {
        await queue.add(
          'learn_style',
          { kind: 'learn_style', workspaceId: req.user!.workspaceId },
          { jobId: `learn-${req.user!.workspaceId}-${Math.floor(Date.now() / 600_000)}` },
        );
        return reply.redirect('/app/assistant?m=learning');
      },
    );

    // ---------- Test chat (single turn, counts toward usage) ----------
    const testPage = (
      req: FastifyRequest,
      msg = '',
      answer: Safe | '' = '',
    ) => html`${pageHead('Test et', 'Müştəri kimi yazın və AI-nin necə cavab verəcəyini görün. Bu mesajlar müştərilərə getmir.')}
      <section class="card phone">
        <div class="thread">${msg ? html`<div class="msg customer"><div class="bubble">${msg}</div></div>${answer}` : html`<div class="empty">${icon('flask', 'i lg')}<p>Məsələn: "Çatdırılma neçəyədir?" və ya "Saat neçədə açıqsınız?"</p></div>`}</div>
        <form class="composer" method="post" action="/app/test">${csrfField(req.csrfToken)}
          <textarea name="message" rows="2" maxlength="1000" required placeholder="Müştərinin mesajını yazın…"></textarea><button class="btn" aria-label="Göndər">${icon('send')}</button></form>
      </section>`;
    r.get('/app/test', { preHandler: requirePerm('assistant.write') }, (req, reply) => view(req, reply, 'Test', testPage(req)));
    r.post('/app/test', { preHandler: requirePerm('assistant.write'), config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
      const msg = z
        .string()
        .trim()
        .min(1)
        .max(1000)
        .safeParse((req.body as any)?.message).data;
      if (!msg) return reply.redirect('/app/test?m=invalid');
      if (await aiBudgetExceeded(req.user!.workspaceId)) return reply.redirect('/app/test?m=ai_budget');
      const quota = await reserveReply(req.user!.workspaceId);
      if (quota !== 'ok') return reply.redirect(`/app/test?m=${quota}`);
      const a = await one('SELECT * FROM assistants WHERE workspace_id = $1', [req.user!.workspaceId]);
      const res = await generateReply(a, [{ role: 'user', text: msg }], a.ai_disclosure, { workspaceId: req.user!.workspaceId, purpose: 'test' });
      const answer =
        res.kind === 'reply'
          ? html`<div class="msg ai"><div class="bubble">${res.text}</div><small>${icon('bot', 'i xs')} AI</small></div>`
          : html`<div class="msg ai"><div class="bubble">${a.handoff_message}</div><small>${icon('headset', 'i xs')} Operatora ötürüldü · ${res.reason}</small></div>`;
      return view(req, reply, 'Test', testPage(req, msg, answer));
    });
  });
}
