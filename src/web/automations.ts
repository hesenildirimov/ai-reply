import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { type Capability, capability, TRIGGER_LABELS } from '../automations/capabilities.js';
import { matches, normalize } from '../automations/engine.js';
import { type AutomationConfig, configSchema, defaultConfig, TRIGGERS, type Trigger, validateForTrigger } from '../automations/schema.js';
import { recentMedia } from '../channels/instagram.js';
import type { ChannelRow } from '../channels/types.js';
import { decrypt } from '../crypto.js';
import { one, q, tx } from '../db.js';
import { audit } from '../events.js';
import { checkLimit } from '../plans.js';
import { can, requirePerm, requireUser } from './auth.js';
import { csrfField, html, pageHead } from './html.js';
import { icon } from './icons.js';
import { MESSAGES, view } from './public.js';
import { type ChipTone, chip, empty, fmt, idParam, jsonData, postForm, typeLabel } from './ui.js';

Object.assign(MESSAGES, {
  auto_saved: { type: 'ok', text: 'Avtomatlaşdırma yadda saxlanıldı (yeni versiya).' },
  auto_active: { type: 'ok', text: 'Avtomatlaşdırma aktivdir.' },
  auto_paused: { type: 'ok', text: 'Avtomatlaşdırma dayandırıldı. Yeni icralar başlamayacaq.' },
  auto_deleted: { type: 'ok', text: 'Avtomatlaşdırma silindi.' },
});

const CAP_TONE: Record<Capability['status'], ChipTone> = { available: 'ok', configuration_required: 'warn', requires_approval: 'info', unsupported: 'neutral' };
const CAP_LABEL: Record<Capability['status'], string> = {
  available: 'Mövcuddur',
  configuration_required: 'Qurulma lazımdır',
  requires_approval: 'Meta təsdiqi lazımdır',
  unsupported: 'Dəstəklənmir',
};
const STATUS_CHIP = { draft: chip('neutral', 'Qaralama'), active: chip('ok', 'Aktiv'), paused: chip('warn', 'Dayandırılıb') } as const;
const capChip = (c: Capability) => chip(CAP_TONE[c.status], CAP_LABEL[c.status]);

const loadOwned = (req: FastifyRequest) => {
  const id = idParam(req);
  return id ? one(`SELECT * FROM automations WHERE id = $1 AND workspace_id = $2`, [id, req.user!.workspaceId]) : Promise.resolve(undefined);
};
const channelsOf = (workspaceId: string) => q<ChannelRow>(`SELECT * FROM channels WHERE workspace_id = $1 ORDER BY created_at`, [workspaceId]);

/** Errors that block activation: Meta rules for the trigger, channel capability, quick-reply targets, plan limit. */
async function activationErrors(a: any, cfg: AutomationConfig): Promise<string[]> {
  const errors = validateForTrigger(a.trigger, cfg);
  const chs = await channelsOf(a.workspace_id);
  const targets = a.channel_id ? chs.filter((c) => c.id === a.channel_id) : chs;
  const caps = targets.map((c) => capability(a.trigger, c));
  if (a.trigger === 'follow') errors.push(capability('follow', null).note);
  else if (!caps.some((c) => c.status === 'available')) errors.push(caps[0]?.note ?? 'Bu trigger üçün uyğun kanal bağlanmayıb.');
  const gotos = cfg.steps.flatMap((s) => (s.type === 'message' ? s.quick_replies.map((x) => x.goto).filter(Boolean) : []));
  if (gotos.length) {
    const ok = await q(`SELECT id FROM automations WHERE workspace_id = $1 AND trigger = 'quick_reply' AND id = ANY($2)`, [a.workspace_id, gotos]);
    if (ok.length !== new Set(gotos).size) errors.push('Düymənin yönləndirdiyi avtomatlaşdırma tapılmadı.');
  }
  if (a.status !== 'active') {
    const lim = await checkLimit(a.workspace_id, 'active_automations');
    if (!lim.ok) errors.push(`Tarifinizdə aktiv avtomatlaşdırma limiti dolub (${lim.used}/${lim.limit}).`);
  }
  return errors;
}

/** Human-readable dry run (no message is sent). */
function describeSteps(trigger: Trigger, cfg: AutomationConfig): string[] {
  const out: string[] = [];
  if (trigger === 'comment' && cfg.public_reply.enabled) out.push(`Şərhə ictimai cavab: "${cfg.public_reply.texts[0] ?? ''}"`);
  cfg.steps.forEach((s, i) => {
    const n = `${i + 1}.`;
    if (s.type === 'message')
      out.push(
        `${n} ${trigger === 'comment' ? 'Şəxsi cavab (private reply)' : 'Mesaj'}: "${s.text.slice(0, 80)}"${s.quick_replies.length ? ` + ${s.quick_replies.length} düymə` : ''}`,
      );
    if (s.type === 'tag') out.push(`${n} Tag: +${s.add.join(', ') || '—'} / -${s.remove.join(', ') || '—'}`);
    if (s.type === 'field') out.push(`${n} Sahə: ${s.key} = "${s.value}"`);
    if (s.type === 'condition')
      out.push(
        `${n} Şərt: ${s.check === 'field_equals' ? `${s.key} = "${s.value}"` : `${s.check === 'has_tag' ? 'tag var' : 'tag yoxdur'}: ${s.tag}`} (ödənməsə dayanır)`,
      );
    if (s.type === 'delay') out.push(`${n} Gözlə: ${s.minutes} dəq (24 saat pəncərəsi daxilində)`);
    if (s.type === 'handoff') out.push(`${n} Operatora ötür`);
    if (s.type === 'ai') out.push(`${n} AI cavab versin`);
  });
  return out;
}

const saveSchema = z.object({
  name: z.string().trim().min(1).max(120),
  channel_id: z.union([z.literal(''), z.uuid()]),
  priority: z.coerce.number().int().min(1).max(1000),
  starts_at: z.string().max(30).default(''),
  ends_at: z.string().max(30).default(''),
  config: z.string().max(100_000),
});
const parseDate = (s: string) => (s ? (Number.isNaN(Date.parse(s)) ? null : new Date(s)) : null);

export function automationRoutes(app: FastifyInstance) {
  // Public click-tracking redirect for automation links.
  app.get('/r/:code', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { resolveClick } = await import('../links.js');
    const url = await resolveClick(String((req.params as any).code ?? ''));
    return url ? reply.redirect(url) : reply.code(404).send('Link tapılmadı');
  });

  app.register(async (r) => {
    r.addHook('preHandler', requireUser);
    const write = { preHandler: requirePerm('automations.write') };

    r.get('/app/automations', async (req, reply) => {
      const w = req.user!.workspaceId;
      const rows = await q(
        `SELECT a.*, (SELECT count(*)::int FROM automation_runs r WHERE r.automation_id = a.id AND r.matched_at > now() - interval '7 days') AS runs7,
                (SELECT count(*)::int FROM automation_runs r WHERE r.automation_id = a.id AND r.sent_at > now() - interval '7 days') AS sent7,
                (SELECT count(*)::int FROM automation_runs r WHERE r.automation_id = a.id AND r.status = 'failed' AND r.matched_at > now() - interval '7 days') AS failed7
         FROM automations a WHERE a.workspace_id = $1 ORDER BY a.status = 'active' DESC, a.updated_at DESC`,
        [w],
      );
      const chs = await channelsOf(w);
      return view(
        req,
        reply,
        'Avtomatlaşdırmalar',
        html`${pageHead('Avtomatlaşdırmalar', 'Şərh, DM, story və düymələrə avtomatik cavablar. AI token xərcləmir.', can(req.user, 'automations.write') ? html`<a class="btn" href="/app/automations/new">${icon('plus')}Yeni avtomatlaşdırma</a>` : undefined)}
        ${
          rows.length
            ? html`<section class="card flush"><div class="table-wrap"><table><thead><tr><th>Ad</th><th>Trigger</th><th>Kanal</th><th>Status</th><th class="num">7 gün: icra</th><th class="num">Göndərildi</th><th class="num">Xəta</th></tr></thead><tbody>
            ${rows.map(
              (
                a,
              ) => html`<tr><td><a class="strong" href="/app/automations/${a.id}">${a.name}</a><small class="muted block">v${a.version} · ${fmt(a.updated_at)}</small></td>
              <td>${TRIGGER_LABELS[a.trigger as Trigger].title}</td><td>${chs.find((c) => c.id === a.channel_id)?.display_name ?? 'Bütün kanallar'}</td>
              <td>${STATUS_CHIP[a.status as keyof typeof STATUS_CHIP]}</td><td class="num">${a.runs7}</td><td class="num">${a.sent7}</td><td class="num">${a.failed7 ? chip('danger', String(a.failed7)) : '0'}</td></tr>`,
            )}
            </tbody></table></div></section>`
            : html`<section class="card">${empty('zap', 'Hələ avtomatlaşdırma yoxdur. Ən populyarı: post altında "qiymət" yazana DM-də qiymət siyahısı göndərmək.', can(req.user, 'automations.write') ? html`<a class="btn" href="/app/automations/new">${icon('plus')}İlkini yarat</a>` : undefined)}</section>`
        }`,
      );
    });

    r.get('/app/automations/new', write, async (req, reply) => {
      const chs = await channelsOf(req.user!.workspaceId);
      return view(
        req,
        reply,
        'Yeni avtomatlaşdırma',
        html`${pageHead('Nə zaman işə düşsün?', 'Trigger seçin. Status Meta-nın rəsmi API imkanlarına görə göstərilir.')}
        <div class="trigger-grid">${TRIGGERS.map((t) => {
          const caps = chs.map((c) => capability(t, c));
          const best = t === 'follow' ? capability('follow', null) : (caps.find((c) => c.status === 'available') ?? caps[0] ?? capability(t, null));
          const usable = best.status !== 'unsupported';
          return html`<form method="post" action="/app/automations" class="trigger-card ${usable ? '' : 'disabled'}">${csrfField(req.csrfToken)}<input type="hidden" name="trigger" value="${t}">
            <div class="tc-head"><b>${TRIGGER_LABELS[t].title}</b>${capChip(best)}</div><p class="muted">${TRIGGER_LABELS[t].desc}</p>${best.note ? html`<p class="hint">${best.note}</p>` : ''}
            ${usable ? html`<button class="btn sm">Seç</button>` : ''}</form>`;
        })}</div>`,
      );
    });

    r.post('/app/automations', write, async (req, reply) => {
      const trigger = z.enum(TRIGGERS).safeParse((req.body as any)?.trigger).data;
      if (!trigger || trigger === 'follow') return reply.redirect('/app/automations/new?m=invalid');
      const cfg = defaultConfig(trigger);
      const id = await tx(async (c) => {
        const a = (
          await c.query(`INSERT INTO automations (workspace_id, name, trigger, config, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [
            req.user!.workspaceId,
            TRIGGER_LABELS[trigger].title,
            trigger,
            cfg,
            req.user!.id,
          ])
        ).rows[0];
        await c.query(`INSERT INTO automation_versions (automation_id, version, config, created_by) VALUES ($1, 1, $2, $3)`, [a.id, cfg, req.user!.id]);
        return a.id as string;
      });
      await audit(req.user!.workspaceId, req.user!.id, 'automation.create', 'automation', id, { trigger });
      return reply.redirect(`/app/automations/${id}`);
    });

    const editor = async (req: FastifyRequest, reply: FastifyReply, a: any, errors: string[] = []) => {
      const w = req.user!.workspaceId;
      const chs = await channelsOf(w);
      const targets = await q(`SELECT id, name FROM automations WHERE workspace_id = $1 AND trigger = 'quick_reply' AND id <> $2 ORDER BY name`, [w, a.id]);
      const runs = await q(
        `SELECT r.*, coalesce(c.username, c.display_name, '') AS who FROM automation_runs r LEFT JOIN contacts c ON c.id = r.contact_id WHERE r.automation_id = $1 ORDER BY r.matched_at DESC LIMIT 15`,
        [a.id],
      );
      const versions = await q(`SELECT version, created_at FROM automation_versions WHERE automation_id = $1 ORDER BY version DESC LIMIT 10`, [a.id]);
      const ch =
        chs.find((c) => c.id === a.channel_id) ??
        chs.find((c) => capability(a.trigger, c).status === 'available') ??
        chs.find((c) => c.type === 'instagram') ??
        chs[0] ??
        null;
      const cap = a.trigger === 'follow' ? capability('follow', null) : capability(a.trigger, ch);
      const editable = can(req.user, 'automations.write');
      const runChip = (s: string) =>
        chip(
          s === 'sent' ? 'ok' : s === 'failed' ? 'danger' : s === 'skipped' ? 'neutral' : 'info',
          { sent: 'göndərildi', failed: 'xəta', skipped: 'keçildi', matched: 'uyğun', running: 'icrada' }[s] ?? s,
        );
      return view(
        req,
        reply,
        a.name,
        html`
        <p><a href="/app/automations" class="more">${icon('back', 'i xs')} Avtomatlaşdırmalar</a></p>
        ${pageHead(
          a.name,
          html`${TRIGGER_LABELS[a.trigger as Trigger].title} · ${STATUS_CHIP[a.status as keyof typeof STATUS_CHIP]} · ${capChip(cap)} · v${a.version}`,
          editable
            ? html`${
                a.status === 'active'
                  ? postForm(`/app/automations/${a.id}/status`, req.csrfToken, html`${icon('pause')}Dayandır`, 'btn secondary', {
                      extra: html`<input type="hidden" name="action" value="pause">`,
                    })
                  : postForm(`/app/automations/${a.id}/status`, req.csrfToken, html`${icon('play')}Aktivləşdir`, 'btn', {
                      extra: html`<input type="hidden" name="action" value="activate">`,
                    })
              }
            ${postForm(`/app/automations/${a.id}/duplicate`, req.csrfToken, 'Kopyala', 'btn secondary')}
            ${postForm(`/app/automations/${a.id}/delete`, req.csrfToken, icon('trash'), 'btn danger-ghost', { confirm: 'Avtomatlaşdırma və onun statistikası silinsin?' })}`
            : undefined,
        )}
        ${errors.length ? html`<div class="flash error">${icon('alert')}<div><b>Aktivləşdirmək olmur:</b><ul>${errors.map((e) => html`<li>${e}</li>`)}</ul></div></div>` : ''}
        ${cap.note ? html`<p class="hint">${icon('alert', 'i xs')} ${cap.note}</p>` : ''}
        <form method="post" action="/app/automations/${a.id}" id="builder-form" class="builder">${csrfField(req.csrfToken)}
          <div class="builder-main">
            <div id="flow" class="flow" aria-live="polite"></div>
            <noscript><p class="flash error">Redaktor üçün JavaScript lazımdır.</p></noscript>
          </div>
          <aside class="builder-side">
            <section class="card"><h2>Ayarlar</h2>
              <label>Ad<input name="name" value="${a.name}" maxlength="120" required ${editable ? '' : 'disabled'}></label>
              <label>Kanal<select name="channel_id">${[html`<option value="">Bütün uyğun kanallar</option>`, ...chs.map((c) => html`<option value="${c.id}" ${c.id === a.channel_id ? 'selected' : ''}>${typeLabel(c.type)}: ${c.display_name}</option>`)]}</select></label>
              <div class="two"><label>Başlanğıc<input type="datetime-local" name="starts_at" value="${a.starts_at ? new Date(a.starts_at).toISOString().slice(0, 16) : ''}"></label>
              <label>Bitmə<input type="datetime-local" name="ends_at" value="${a.ends_at ? new Date(a.ends_at).toISOString().slice(0, 16) : ''}"></label></div>
              <label>Prioritet (kiçik = əvvəl)<input type="number" name="priority" min="1" max="1000" value="${a.priority}"></label>
              <input type="hidden" name="config" id="config-input">
              ${editable ? html`<button class="btn block">Yadda saxla (yeni versiya)</button>` : ''}
            </section>
            <section class="card"><h2>${icon('flask')}Sınaq</h2><p class="muted">Mesaj göndərilmir: yalnız nəyin baş verəcəyi göstərilir.</p>
              <div class="test-row"><input id="test-text" placeholder="${a.trigger === 'comment' ? 'Şərh mətni, məs: qiymət?' : 'Mesaj mətni'}"><button type="button" class="btn sm secondary" id="test-run">Yoxla</button></div>
              <div id="test-out" class="test-out"></div></section>
          </aside>
        </form>
        <section class="card flush"><div class="card-head pad"><h2>Son icralar</h2><a class="more" href="/app/analytics?automation=${a.id}">Analitika ${icon('arrow', 'i xs')}</a></div>
          ${
            runs.length
              ? html`<div class="table-wrap"><table><thead><tr><th>Vaxt</th><th>Kontakt</th><th>Status</th><th>Səbəb</th><th>Addımlar</th></tr></thead><tbody>
            ${runs.map(
              (
                r,
              ) => html`<tr><td>${fmt(r.matched_at)}</td><td>${r.who ? `@${r.who}` : '—'}</td><td>${runChip(r.status)}</td><td class="muted">${r.reason || '—'}</td>
              <td class="muted">${(r.steps as any[]).map((s) => `${s.type}:${s.result ?? 'ok'}`).join(' → ') || '—'}</td></tr>`,
            )}</tbody></table></div>`
              : html`<p class="muted pad">Hələ icra yoxdur.</p>`
          }</section>
        <p class="hint">Versiyalar: ${versions.map((v) => `v${v.version} (${fmt(v.created_at)})`).join(' · ')}</p>
        ${jsonData('automation-data', { trigger: a.trigger, config: a.config, targets, editable, channelType: ch?.type ?? 'instagram', mediaUrl: `/app/automations/${a.id}/media`, testUrl: `/app/automations/${a.id}/test`, csrf: req.csrfToken })}`,
        html`<script src="/public/builder.js" defer></script>`,
      );
    };

    r.get('/app/automations/:id', async (req, reply) => {
      const a = await loadOwned(req);
      return a ? editor(req, reply, a) : reply.code(404).send('Not found');
    });

    r.post('/app/automations/:id', write, async (req, reply) => {
      const a = await loadOwned(req);
      if (!a) return reply.code(404).send('Not found');
      const p = saveSchema.safeParse(req.body);
      let cfg: AutomationConfig | undefined;
      try {
        cfg = p.success ? configSchema.parse(JSON.parse(p.data.config)) : undefined;
      } catch {
        cfg = undefined;
      }
      if (!p.success || !cfg) return editor(req, reply, a, ['Məlumatlar düzgün deyil: sahələri yoxlayın.']);
      const d = p.data;
      if (d.channel_id && !(await one(`SELECT 1 FROM channels WHERE id = $1 AND workspace_id = $2`, [d.channel_id, a.workspace_id])))
        return reply.code(400).send('Bad channel');
      const next = { ...a, channel_id: d.channel_id || null };
      // An active automation keeps running only if the new version is still valid.
      const errors = a.status === 'active' ? await activationErrors({ ...next, status: 'active' }, cfg) : [];
      if (errors.length) return editor(req, reply, { ...a, config: cfg }, errors);
      await tx(async (c) => {
        const v = (
          await c.query(
            `UPDATE automations SET name = $2, channel_id = $3, priority = $4, starts_at = $5, ends_at = $6, config = $7, version = version + 1, updated_at = now() WHERE id = $1 RETURNING version`,
            [a.id, d.name, d.channel_id || null, d.priority, parseDate(d.starts_at), parseDate(d.ends_at), cfg],
          )
        ).rows[0];
        await c.query(`INSERT INTO automation_versions (automation_id, version, config, created_by) VALUES ($1, $2, $3, $4)`, [
          a.id,
          v.version,
          cfg,
          req.user!.id,
        ]);
      });
      await audit(a.workspace_id, req.user!.id, 'automation.update', 'automation', a.id);
      return reply.redirect(`/app/automations/${a.id}?m=auto_saved`);
    });

    r.post('/app/automations/:id/status', write, async (req, reply) => {
      const a = await loadOwned(req);
      if (!a) return reply.code(404).send('Not found');
      const action = (req.body as any)?.action;
      if (action === 'pause') {
        await q(`UPDATE automations SET status = 'paused', updated_at = now() WHERE id = $1`, [a.id]);
        await audit(a.workspace_id, req.user!.id, 'automation.pause', 'automation', a.id);
        return reply.redirect(`/app/automations/${a.id}?m=auto_paused`);
      }
      const errors = await activationErrors(a, configSchema.parse(a.config));
      if (errors.length) return editor(req, reply, a, errors);
      await q(`UPDATE automations SET status = 'active', updated_at = now() WHERE id = $1`, [a.id]);
      await audit(a.workspace_id, req.user!.id, 'automation.activate', 'automation', a.id);
      return reply.redirect(`/app/automations/${a.id}?m=auto_active`);
    });

    r.post('/app/automations/:id/duplicate', write, async (req, reply) => {
      const a = await loadOwned(req);
      if (!a) return reply.code(404).send('Not found');
      const id = await tx(async (c) => {
        const n = (
          await c.query(
            `INSERT INTO automations (workspace_id, channel_id, name, trigger, config, priority, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
            [a.workspace_id, a.channel_id, `${a.name} (kopya)`.slice(0, 120), a.trigger, a.config, a.priority, req.user!.id],
          )
        ).rows[0];
        await c.query(`INSERT INTO automation_versions (automation_id, version, config, created_by) VALUES ($1, 1, $2, $3)`, [n.id, a.config, req.user!.id]);
        return n.id as string;
      });
      await audit(a.workspace_id, req.user!.id, 'automation.duplicate', 'automation', id, { from: a.id });
      return reply.redirect(`/app/automations/${id}`);
    });

    r.post('/app/automations/:id/delete', write, async (req, reply) => {
      const a = await loadOwned(req);
      if (a) {
        await q(`DELETE FROM automations WHERE id = $1`, [a.id]);
        await audit(a.workspace_id, req.user!.id, 'automation.delete', 'automation', a.id, { name: a.name });
      }
      return reply.redirect('/app/automations?m=auto_deleted');
    });

    // Dry run against sample text — nothing is sent, no run is recorded.
    r.post('/app/automations/:id/test', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
      const a = await loadOwned(req);
      if (!a) return reply.code(404).send({ ok: false });
      const text =
        z
          .string()
          .max(1000)
          .safeParse((req.body as any)?.text).data ?? '';
      let cfg: AutomationConfig;
      try {
        cfg = configSchema.parse((req.body as any)?.config ?? a.config);
      } catch {
        return reply.code(400).send({ ok: false, error: 'Konfiqurasiya səhvdir' });
      }
      const matched = ['story_mention', 'quick_reply'].includes(a.trigger) || matches(cfg.match, text);
      return reply.send({
        ok: true,
        matched,
        normalized: normalize(text),
        steps: matched ? describeSteps(a.trigger, cfg) : [],
        errors: validateForTrigger(a.trigger, cfg),
      });
    });

    r.get('/app/automations/:id/media', async (req, reply) => {
      const a = await loadOwned(req);
      if (!a) return reply.code(404).send({ ok: false });
      const ch = await one<ChannelRow>(
        `SELECT * FROM channels WHERE workspace_id = $1 AND type = 'instagram' AND status = 'active' AND ($2::uuid IS NULL OR id = $2) ORDER BY created_at LIMIT 1`,
        [a.workspace_id, a.channel_id],
      );
      if (!ch) return reply.send({ ok: false, items: [], error: 'Instagram bağlı deyil' });
      try {
        return reply.send({ ok: true, items: await recentMedia(decrypt(ch.access_token_enc)) });
      } catch {
        return reply.send({ ok: false, items: [], error: 'Postları yükləmək alınmadı' });
      }
    });
  });
}
