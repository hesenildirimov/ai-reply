import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { q } from '../db.js';
import { createLead, LEAD_PLANS, type LeadPlan } from '../leads.js';
import { csrfField, html, logo, page, raw, type Safe } from './html.js';
import { icon } from './icons.js';
import { emailSchema, flash } from './public.js';
import { LANGS, type Lang, type SiteText, TEXT } from './site-i18n.js';

/**
 * Public website on the same domain as the panel: product, how it works, plans, FAQ and the request form.
 * Flow: a visitor picks a plan (or "not sure") → fills the form → the request lands in the admin's Leads list, and
 * the admins get an e-mail and a Telegram message. No self sign-up: accounts are created after the meeting.
 */

const prefix = (lang: Lang) => (lang === 'az' ? '' : `/${lang}`);
const PLAN_KEYS: Record<string, LeadPlan> = { start: 'start', biznes: 'biznes', pro: 'pro' };

interface PlanCard {
  key: LeadPlan;
  name: string;
  price: string;
  limits: Record<string, number | null>;
}

async function planCards(): Promise<PlanCard[]> {
  const rows = await q<{ name: string; price_note: string; limits: Record<string, number | null> }>(
    `SELECT name, price_note, limits FROM plans ORDER BY created_at`,
  );
  return rows
    .filter((p) => PLAN_KEYS[p.name.toLowerCase()])
    .map((p) => ({
      key: PLAN_KEYS[p.name.toLowerCase()]!,
      name: p.name,
      price: /^[\d\s.,]+\s*\p{L}+/u.exec(p.price_note)?.[0] ?? p.price_note,
      limits: p.limits,
    }));
}

// 6 000 in Azerbaijani and Russian, 6,000 in English.
const fmtNum = (n: number, lang: Lang) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, lang === 'en' ? ',' : ' ');

function header(t: SiteText, lang: Lang, path: string): Safe {
  const p = prefix(lang);
  const switcher = LANGS.map((l) => {
    const target = `${prefix(l)}${path}` || '/';
    return html`<a href="${target}" class="${l === lang ? 'on' : ''}" hreflang="${l}" lang="${l}">${l.toUpperCase()}</a>`;
  });
  return html`<header class="site-top"><div class="site-wrap site-bar">
    <a class="brand" href="${p || '/'}">${logo}<span>AI Reply</span></a>
    <nav class="site-nav" aria-label="Menu"><a href="${p}/#features">${t.nav.features}</a><a href="${p}/#how">${t.nav.how}</a><a href="${p}/#pricing">${t.nav.pricing}</a><a href="${p}/#faq">${t.nav.faq}</a></nav>
    <div class="site-actions"><span class="lang-switch">${switcher}</span>
      <a class="site-login" href="/login">${t.nav.login}</a>
      ${config.DEMO_URL ? html`<a class="btn secondary" href="${config.DEMO_URL}" target="_blank" rel="noopener">${t.nav.demo}</a>` : ''}
      <a class="btn" href="${p}/request?intent=demo">${t.nav.book}</a></div>
  </div></header>`;
}

const sitePage = (req: FastifyRequest, reply: FastifyReply, lang: Lang, title: string, path: string, body: Safe) =>
  reply
    .type('text/html; charset=utf-8')
    .header('Content-Language', lang)
    .send(
      page(title, html`<div class="site">${body}</div>`, {
        csrf: req.csrfToken,
        user: null,
        flash: flash(req),
        lang,
        header: header(TEXT[lang], lang, path),
        path,
      }),
    );

async function home(req: FastifyRequest, reply: FastifyReply, lang: Lang) {
  const t = TEXT[lang];
  const p = prefix(lang);
  const plans = await planCards();
  const limit = (v: number | null | undefined, label: string) => html`<li><b>${v == null ? t.limits.unlimited : fmtNum(v, lang)}</b> ${label}</li>`;
  return sitePage(
    req,
    reply,
    lang,
    `AI Reply — ${t.hero.title}`,
    '',
    html`<section class="site-hero"><div class="site-wrap">
      <p class="eyebrow">${icon('instagram')} Instagram · ${icon('whatsapp')} WhatsApp</p>
      <h1>${t.hero.title}</h1><p class="lead">${t.hero.lead}</p>
      <div class="hero-actions"><a class="btn lg" href="${p}/request?intent=demo">${t.hero.book}</a>
        ${config.DEMO_URL ? html`<a class="btn lg secondary" href="${config.DEMO_URL}" target="_blank" rel="noopener">${t.hero.demo}</a>` : ''}</div>
      <p class="hero-note">${t.hero.note}</p></div></section>
    <section id="features" class="site-section"><div class="site-wrap"><h2>${t.featuresTitle}</h2>
      <div class="site-grid">${t.features.map(([h, d], i) => html`<div class="site-card">${icon((['book', 'shield', 'globe', 'sparkle', 'instagram', 'users'] as const)[i]!, 'i feat')}<h3>${h}</h3><p>${d}</p></div>`)}</div></div></section>
    <section id="how" class="site-section alt"><div class="site-wrap"><h2>${t.howTitle}</h2>
      <ol class="steps">${t.how.map(([h, d]) => html`<li><h3>${h}</h3><p>${d}</p></li>`)}</ol></div></section>
    <section id="pricing" class="site-section"><div class="site-wrap"><h2>${t.pricingTitle}</h2><p class="muted">${t.pricingLead}</p>
      <div class="plans">${plans.map(
        (c) => html`<div class="plan ${c.key === 'biznes' ? 'featured' : ''}"><h3>${c.name}</h3>
          <p class="price">${c.price}<small>${t.perMonth}</small></p>
          <ul>${limit(c.limits.ai_replies_month, t.limits.replies)}${limit(c.limits.channels, t.limits.channels)}${limit(c.limits.members, t.limits.members)}${limit(c.limits.knowledge_mb, t.limits.knowledge)}${limit(c.limits.active_automations, t.limits.automations)}</ul>
          <a class="btn ${c.key === 'biznes' ? '' : 'secondary'} block" href="${p}/request?plan=${c.key}">${t.choose}</a></div>`,
      )}</div>
      <p class="onboarding">${icon('check')} ${t.onboarding}</p></div></section>
    <section id="faq" class="site-section alt"><div class="site-wrap narrow"><h2>${t.faqTitle}</h2>
      ${t.faq.map(([qq, a]) => html`<details class="faq"><summary>${qq}</summary><p>${a}</p></details>`)}</div></section>
    <section class="site-cta"><div class="site-wrap"><h2>${t.ctaTitle}</h2><p>${t.ctaLead}</p>
      <a class="btn lg" href="${p}/request?intent=demo">${t.hero.book}</a></div></section>`,
  );
}

const requestQuery = z.object({
  plan: z.enum(LEAD_PLANS).catch('unknown'),
  intent: z.enum(['demo', 'call']).catch('demo'),
});

async function requestPage(req: FastifyRequest, reply: FastifyReply, lang: Lang, values: Record<string, string> = {}, invalid = false) {
  const t = TEXT[lang];
  const f = t.form;
  const qy = requestQuery.parse(req.query ?? {});
  const plans = await planCards();
  const v = (k: string) => values[k] ?? '';
  const plan = values.plan ?? qy.plan;
  const intent = values.intent ?? qy.intent;
  const opt = (value: string, label: string, current: string) => html`<option value="${value}" ${value === current ? raw('selected') : ''}>${label}</option>`;
  return sitePage(
    req,
    reply,
    lang,
    `${f.title} · AI Reply`,
    '/request',
    html`<section class="site-section"><div class="site-wrap narrow"><div class="request card">
      <h1>${f.title}</h1><p class="muted">${f.lead}</p>
      ${invalid ? html`<p class="flash error" role="alert">${icon('alert')}<span>${f.invalid}</span></p>` : ''}
      <form method="post" action="/request" class="form-grid">${csrfField(req.csrfToken)}<input type="hidden" name="lang" value="${lang}">
        <label>${f.name} *<input name="name" required maxlength="120" autocomplete="name" value="${v('name')}"></label>
        <label>${f.business} *<input name="business" required maxlength="120" autocomplete="organization" value="${v('business')}"></label>
        <label>${f.phone} *<input name="phone" type="tel" required maxlength="40" autocomplete="tel" placeholder="+994 50 000 00 00" value="${v('phone')}"></label>
        <label>${f.email} *<input name="email" type="email" required maxlength="254" autocomplete="email" value="${v('email')}"></label>
        <label>${f.instagram}<input name="instagram" maxlength="120" placeholder="@" value="${v('instagram')}"></label>
        <label>${f.industry}<select name="industry">${opt('', '—', v('industry'))}${Object.entries(f.industries).map(([k, l]) => opt(k, l, v('industry')))}</select></label>
        <label>${f.volume}<select name="monthly_messages">${opt('', '—', v('monthly_messages'))}${Object.entries(f.volumes).map(([k, l]) => opt(k, l, v('monthly_messages')))}</select></label>
        <label>${f.plan}<select name="plan">${plans.map((c) => opt(c.key, `${c.name} · ${c.price}${t.perMonth}`, plan))}${opt('unknown', t.unknownPlan, plan)}</select></label>
        <fieldset class="span"><legend>${f.intent}</legend>
          ${(['demo', 'call'] as const).map((k) => html`<label class="radio"><input type="radio" name="intent" value="${k}" ${intent === k ? raw('checked') : ''}> ${f.intents[k]}</label>`)}</fieldset>
        <label>${f.time}<input name="preferred_time" maxlength="120" placeholder="${f.timePlaceholder}" value="${v('preferred_time')}"></label>
        <label class="span">${f.message}<textarea name="message" rows="3" maxlength="2000">${v('message')}</textarea></label>
        <label class="hp" aria-hidden="true">Website<input name="website" tabindex="-1" autocomplete="off"></label>
        <label class="check span"><input type="checkbox" name="consent" value="1" required> ${f.consent} (<a href="/privacy" target="_blank">${f.privacy}</a>)</label>
        <button class="btn lg span">${f.submit}</button>
      </form></div></div></section>`,
  );
}

const leadSchema = z.object({
  lang: z.enum(LANGS).catch('az'),
  name: z.string().trim().min(1).max(120),
  business: z.string().trim().min(1).max(120),
  phone: z
    .string()
    .trim()
    .min(5)
    .max(40)
    .regex(/^[+\d][\d\s()-]{4,}$/),
  email: emailSchema,
  instagram: z.string().trim().max(120).default(''),
  industry: z.enum(['', 'clothing', 'beauty', 'food', 'services', 'education', 'electronics', 'other']).catch(''),
  monthly_messages: z.enum(['', 'lt500', '500_2000', '2000_10000', 'gt10000', 'unknown']).catch(''),
  plan: z.enum(LEAD_PLANS).catch('unknown'),
  intent: z.enum(['demo', 'call']).catch('demo'),
  preferred_time: z.string().trim().max(120).default(''),
  message: z.string().trim().max(2000).default(''),
  consent: z.literal('1'),
  website: z.string().max(0).optional(), // honeypot: people never see it, bots fill it in
});

export function siteRoutes(app: FastifyInstance) {
  for (const lang of LANGS) {
    const p = prefix(lang);
    app.get(p || '/', (req, reply) => home(req, reply, lang));
    app.get(`${p}/request`, (req, reply) => requestPage(req, reply, lang));
    app.get(`${p}/request/thanks`, (req, reply) => {
      const t = TEXT[lang];
      return sitePage(
        req,
        reply,
        lang,
        `${t.thanks.title} · AI Reply`,
        '/request/thanks',
        html`<section class="site-section"><div class="site-wrap narrow"><div class="request card center">
          ${icon('check', 'i feat')}<h1>${t.thanks.title}</h1><p>${t.thanks.lead}</p>
          <div class="hero-actions center">${config.DEMO_URL ? html`<a class="btn" href="${config.DEMO_URL}" target="_blank" rel="noopener">${t.thanks.demo}</a>` : ''}
          <a class="btn secondary" href="${p || '/'}">${t.thanks.home}</a></div></div></div></section>`,
      );
    });
  }

  // A few requests per address an hour: enough for a person who corrects a typo, useless for a spam bot.
  app.post('/request', { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const lang = z.enum(LANGS).catch('az').parse(body.lang);
    // Honeypot filled: answer like a success, store nothing (the bot learns nothing).
    if (body.website) {
      req.log.warn({ event: 'lead_honeypot' }, 'security');
      return reply.redirect(`${prefix(lang)}/request/thanks`);
    }
    const p = leadSchema.safeParse(body);
    if (!p.success) {
      const keep = Object.fromEntries(
        Object.entries(body)
          .filter(([k]) => !['_csrf', 'consent', 'website'].includes(k))
          .map(([k, val]) => [k, String(val).slice(0, 2000)]),
      );
      return requestPage(req, reply.code(400), lang, keep, true);
    }
    const d = p.data;
    const lead = {
      name: d.name,
      business: d.business,
      phone: d.phone,
      email: d.email,
      instagram: d.instagram,
      industry: d.industry,
      monthly_messages: d.monthly_messages,
      plan: d.plan,
      intent: d.intent,
      preferred_time: d.preferred_time,
      message: d.message,
      lang: d.lang,
    };
    await createLead(lead);
    req.log.info({ event: 'lead_created', plan: lead.plan, intent: lead.intent }, 'audit');
    return reply.redirect(`${prefix(lang)}/request/thanks`);
  });
}
