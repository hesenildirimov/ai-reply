// Automation flow builder: renders trigger + step blocks from JSON, supports add/remove/drag-reorder,
// serializes back to the hidden "config" input. The server validates everything again (zod + Meta rules).
(() => {
  const dataEl = document.getElementById('automation-data');
  const flow = document.getElementById('flow');
  if (!dataEl || !flow) return;
  const D = JSON.parse(dataEl.textContent);
  const cfg = D.config;
  cfg.match ||= { mode: 'any', keywords: [], exclude: [] };
  cfg.media ||= { scope: 'all', ids: [] };
  cfg.public_reply ||= { enabled: false, texts: [] };
  cfg.steps ||= [];
  const ro = !D.editable;
  const isComment = D.trigger === 'comment';
  const maxButtons = D.channelType === 'whatsapp' ? 3 : 13;

  const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else if (v === true) el.setAttribute(k, '');
      else if (v !== false && v != null) el.setAttribute(k, v);
    }
    for (const k of kids.flat()) if (k != null) el.append(k.nodeType ? k : document.createTextNode(String(k)));
    if (ro && /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(el.tagName)) el.disabled = true;
    return el;
  };
  const field = (label, input, help) => h('label', {}, label, input, help ? h('small', { class: 'help' }, help) : null);
  const input = (value, onchange, attrs = {}) => h('input', { value: value ?? '', oninput: (e) => onchange(e.target.value), ...attrs });
  const area = (value, onchange, attrs = {}) => {
    const t = h('textarea', { rows: 3, oninput: (e) => onchange(e.target.value), ...attrs });
    t.value = value ?? '';
    return t;
  };
  const select = (value, options, onchange) =>
    h(
      'select',
      { onchange: (e) => onchange(e.target.value) },
      options.map(([v, l]) => h('option', { value: v, selected: v === value }, l)),
    );

  // Comma-separated chips editor
  const chips = (list, placeholder, max = 50) => {
    const wrap = h('div', { class: 'chips' });
    const draw = () => {
      wrap.replaceChildren(
        ...list.map((k, i) =>
          h(
            'span',
            { class: 'chip-x' },
            k,
            ro
              ? null
              : h(
                  'button',
                  {
                    type: 'button',
                    'aria-label': 'Sil',
                    onclick: () => {
                      list.splice(i, 1);
                      draw();
                    },
                  },
                  '×',
                ),
          ),
        ),
        ro
          ? ''
          : h('input', {
              placeholder,
              onkeydown: (e) => {
                if ((e.key === 'Enter' || e.key === ',') && e.target.value.trim()) {
                  e.preventDefault();
                  if (list.length < max)
                    list.push(
                      ...e.target.value
                        .split(',')
                        .map((s) => s.trim())
                        .filter(Boolean),
                    );
                  draw();
                  wrap.querySelector('input')?.focus();
                }
              },
            }),
      );
    };
    draw();
    return wrap;
  };

  const STEP_TYPES = {
    message: { label: 'Mesaj', icon: '💬', make: () => ({ type: 'message', text: '', quick_replies: [], track_links: false }) },
    tag: { label: 'Tag', icon: '🏷', make: () => ({ type: 'tag', add: [], remove: [] }) },
    field: { label: 'Sahə yaz', icon: '✎', make: () => ({ type: 'field', key: '', value: '' }) },
    condition: { label: 'Şərt', icon: '⑂', make: () => ({ type: 'condition', check: 'has_tag', tag: '', key: '', value: '' }) },
    delay: { label: 'Gözlə', icon: '⏱', make: () => ({ type: 'delay', minutes: 30 }) },
    handoff: { label: 'Operatora ötür', icon: '🎧', make: () => ({ type: 'handoff', note: '' }) },
    ai: { label: 'AI cavab versin', icon: '✦', make: () => ({ type: 'ai' }) },
  };
  // Meta: a comment flow can send only one private reply and nothing that needs the person to answer first.
  const allowed = isComment ? ['message', 'tag', 'field', 'condition', 'handoff'] : Object.keys(STEP_TYPES);

  function stepBody(s, _render) {
    switch (s.type) {
      case 'message': {
        const qrs = h('div', { class: 'qr-list' });
        const drawQr = () =>
          qrs.replaceChildren(
            ...s.quick_replies.map((qr, i) =>
              h(
                'div',
                { class: 'qr-row' },
                input(qr.title, (v) => (qr.title = v), { maxlength: 20, placeholder: 'Düymə (≤20)' }),
                select(qr.goto || '', [['', '— cavabı yadda saxla —'], ...D.targets.map((t) => [t.id, `→ ${t.name}`])], (v) => (qr.goto = v)),
                ro
                  ? null
                  : h(
                      'button',
                      {
                        type: 'button',
                        class: 'icon-btn',
                        onclick: () => {
                          s.quick_replies.splice(i, 1);
                          drawQr();
                        },
                      },
                      '×',
                    ),
              ),
            ),
            ro || s.quick_replies.length >= maxButtons
              ? ''
              : h(
                  'button',
                  {
                    type: 'button',
                    class: 'btn sm secondary',
                    onclick: () => {
                      s.quick_replies.push({ title: '', goto: '' });
                      drawQr();
                    },
                  },
                  '+ Düymə',
                ),
          );
        drawQr();
        return [
          field(
            isComment ? 'Şəxsi cavab (private reply)' : 'Mesaj',
            area(s.text, (v) => (s.text = v), { maxlength: 1000, required: true }),
          ),
          h('div', { class: 'sub-label' }, `Quick reply düymələri (ən çox ${maxButtons}). Hər düymə başqa avtomatlaşdırmaya keçə bilər.`),
          qrs,
          h(
            'label',
            { class: 'switch-row compact' },
            h('span', {}, 'Linkləri izlə (klik sayı)'),
            h('input', { type: 'checkbox', class: 'switch', checked: s.track_links, onchange: (e) => (s.track_links = e.target.checked) }),
          ),
        ];
      }
      case 'tag':
        return [field('Əlavə et', chips(s.add, 'tag yazıb Enter', 10)), field('Sil', chips(s.remove, 'tag yazıb Enter', 10))];
      case 'field':
        return [
          h(
            'div',
            { class: 'two' },
            field(
              'Sahə açarı',
              input(s.key, (v) => (s.key = v), { pattern: '[a-z][a-z0-9_]*', placeholder: 'mes: olcu' }),
            ),
            field(
              'Dəyər',
              input(s.value, (v) => (s.value = v), { maxlength: 500 }),
            ),
          ),
        ];
      case 'condition': {
        const box = h('div', {});
        const draw = () =>
          box.replaceChildren(
            field(
              'Yoxla',
              select(
                s.check,
                [
                  ['has_tag', 'Tag var'],
                  ['not_tag', 'Tag yoxdur'],
                  ['field_equals', 'Sahə bərabərdir'],
                ],
                (v) => {
                  s.check = v;
                  draw();
                },
              ),
            ),
            s.check === 'field_equals'
              ? h(
                  'div',
                  { class: 'two' },
                  field(
                    'Sahə',
                    input(s.key, (v) => (s.key = v)),
                  ),
                  field(
                    'Dəyər',
                    input(s.value, (v) => (s.value = v)),
                  ),
                )
              : field(
                  'Tag',
                  input(s.tag, (v) => (s.tag = v)),
                ),
            h('small', { class: 'help' }, 'Şərt ödənməsə, axın burada dayanır.'),
          );
        draw();
        return [box];
      }
      case 'delay':
        return [
          field(
            'Dəqiqə (1–1380)',
            input(s.minutes, (v) => (s.minutes = Number(v) || 1), { type: 'number', min: 1, max: 1380 }),
            'Mesaj yalnız 24 saatlıq pəncərə açıqdırsa göndərilir.',
          ),
        ];
      case 'handoff':
        return [
          field(
            'Operator üçün qeyd',
            input(s.note, (v) => (s.note = v), { maxlength: 200 }),
          ),
        ];
      case 'ai':
        return [h('p', { class: 'muted' }, 'Bu nöqtədən sonra AI köməkçi biznes məlumatlarına əsasən cavab verir (token xərci yaranır).')];
    }
    return [];
  }

  let dragFrom = null;
  function render() {
    const nodes = [];
    // Trigger block
    const trig = [];
    if (['comment', 'dm_keyword', 'story_reply'].includes(D.trigger)) {
      trig.push(
        field(
          'Uyğunluq',
          select(
            cfg.match.mode,
            [
              ['any', 'Açar sözlərdən biri'],
              ['all', 'Bütün açar sözlər'],
              ['exact', 'Dəqiq uyğunluq'],
              ['anything', 'İstənilən mətn'],
            ],
            (v) => {
              cfg.match.mode = v;
              render();
            },
          ),
        ),
      );
      if (cfg.match.mode !== 'anything')
        trig.push(field('Açar sözlər', chips(cfg.match.keywords, 'qiymət, price… (Enter)'), 'Böyük/kiçik hərf və ə/e, ı/i fərqi nəzərə alınmır.'));
      trig.push(field('İstisna sözlər', chips(cfg.match.exclude, 'məs: spam (Enter)')));
    }
    if (isComment) {
      const pick = h('div', { class: 'media-pick' });
      trig.push(
        field(
          'Hansı postlar',
          select(
            cfg.media.scope,
            [
              ['all', 'Bütün post və Reel-lər'],
              ['selected', 'Seçilmiş postlar'],
            ],
            (v) => {
              cfg.media.scope = v;
              render();
            },
          ),
        ),
      );
      if (cfg.media.scope === 'selected') {
        trig.push(pick);
        pick.textContent = 'Postlar yüklənir…';
        fetch(D.mediaUrl)
          .then((r) => r.json())
          .then((res) => {
            if (!res.items?.length) {
              pick.textContent = res.error || 'Post tapılmadı.';
              return;
            }
            pick.replaceChildren(
              ...res.items.map((m) =>
                h(
                  'button',
                  {
                    type: 'button',
                    class: `media-item ${cfg.media.ids.includes(m.id) ? 'on' : ''}`,
                    title: m.caption,
                    onclick: (e) => {
                      const i = cfg.media.ids.indexOf(m.id);
                      i >= 0 ? cfg.media.ids.splice(i, 1) : cfg.media.ids.push(m.id);
                      e.currentTarget.classList.toggle('on');
                    },
                  },
                  m.thumb ? h('img', { src: m.thumb, alt: '', loading: 'lazy' }) : h('span', {}, m.type),
                  h('small', {}, m.caption || m.id),
                ),
              ),
            );
          })
          .catch(() => (pick.textContent = 'Postları yükləmək alınmadı.'));
      }
      trig.push(
        h(
          'label',
          { class: 'switch-row compact' },
          h('span', {}, 'Şərhə ictimai cavab da yaz'),
          h('input', {
            type: 'checkbox',
            class: 'switch',
            checked: cfg.public_reply.enabled,
            onchange: (e) => {
              cfg.public_reply.enabled = e.target.checked;
              render();
            },
          }),
        ),
      );
      if (cfg.public_reply.enabled) {
        cfg.public_reply.texts.length || cfg.public_reply.texts.push('Sizə DM-də yazdıq 🙌');
        trig.push(...cfg.public_reply.texts.map((t, i) => input(t, (v) => (cfg.public_reply.texts[i] = v), { maxlength: 300 })));
        if (!ro && cfg.public_reply.texts.length < 5)
          trig.push(
            h(
              'button',
              {
                type: 'button',
                class: 'btn sm secondary',
                onclick: () => {
                  cfg.public_reply.texts.push('');
                  render();
                },
              },
              '+ Variant (təsadüfi seçilir)',
            ),
          );
      }
    }
    if (!trig.length)
      trig.push(
        h(
          'p',
          { class: 'muted' },
          D.trigger === 'story_mention'
            ? 'Sizi story-də qeyd edən hər kəs üçün işləyir.'
            : D.trigger === 'quick_reply'
              ? 'Başqa avtomatlaşdırmadakı düymə bu axına yönləndirəndə işləyir.'
              : '',
        ),
      );
    nodes.push(h('div', { class: 'fblock trigger' }, h('div', { class: 'block-head' }, h('b', {}, '⚡ Trigger')), ...trig));

    cfg.steps.forEach((s, i) => {
      nodes.push(h('div', { class: 'connector' }));
      const meta = STEP_TYPES[s.type];
      const block = h(
        'div',
        {
          class: `fblock step-${s.type}`,
          draggable: !ro,
          ondragstart: () => (dragFrom = i),
          ondragover: (e) => {
            e.preventDefault();
            block.classList.add('drop');
          },
          ondragleave: () => block.classList.remove('drop'),
          ondrop: (e) => {
            e.preventDefault();
            if (dragFrom == null || dragFrom === i) return;
            const [m] = cfg.steps.splice(dragFrom, 1);
            cfg.steps.splice(i, 0, m);
            dragFrom = null;
            render();
          },
        },
        h(
          'div',
          { class: 'block-head' },
          ro ? null : h('span', { class: 'grip', title: 'Sürüşdürün' }, '⋮⋮'),
          h('b', {}, `${i + 1}. ${meta.icon} ${meta.label}`),
          ro
            ? null
            : h(
                'span',
                { class: 'block-actions' },
                h(
                  'button',
                  {
                    type: 'button',
                    class: 'icon-btn',
                    title: 'Yuxarı',
                    disabled: i === 0,
                    onclick: () => {
                      [cfg.steps[i - 1], cfg.steps[i]] = [cfg.steps[i], cfg.steps[i - 1]];
                      render();
                    },
                  },
                  '↑',
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    class: 'icon-btn',
                    title: 'Aşağı',
                    disabled: i === cfg.steps.length - 1,
                    onclick: () => {
                      [cfg.steps[i + 1], cfg.steps[i]] = [cfg.steps[i], cfg.steps[i + 1]];
                      render();
                    },
                  },
                  '↓',
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    class: 'icon-btn',
                    title: 'Sil',
                    onclick: () => {
                      cfg.steps.splice(i, 1);
                      render();
                    },
                  },
                  '×',
                ),
              ),
        ),
        ...stepBody(s, render),
      );
      nodes.push(block);
    });
    if (!ro) {
      nodes.push(h('div', { class: 'connector' }));
      nodes.push(
        h(
          'div',
          { class: 'add-step' },
          h('span', { class: 'muted' }, 'Addım əlavə et:'),
          allowed.map((t) =>
            h(
              'button',
              {
                type: 'button',
                class: 'btn sm secondary',
                disabled: t === 'message' && isComment && cfg.steps.some((s) => s.type === 'message'),
                onclick: () => {
                  cfg.steps.push(STEP_TYPES[t].make());
                  render();
                },
              },
              `${STEP_TYPES[t].icon} ${STEP_TYPES[t].label}`,
            ),
          ),
        ),
      );
    }
    flow.replaceChildren(...nodes);
  }
  render();

  document.getElementById('builder-form')?.addEventListener('submit', () => {
    document.getElementById('config-input').value = JSON.stringify(cfg);
  });

  const out = document.getElementById('test-out');
  document.getElementById('test-run')?.addEventListener('click', async () => {
    out.textContent = 'Yoxlanılır…';
    try {
      const res = await fetch(D.testUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': D.csrf },
        body: JSON.stringify({ text: document.getElementById('test-text').value, config: cfg }),
      });
      const r = await res.json();
      if (!r.ok) {
        out.textContent = r.error || 'Xəta';
        return;
      }
      out.replaceChildren(
        h('p', { class: r.matched ? 'ok-text' : 'muted' }, r.matched ? '✓ Uyğun gəlir — bu addımlar icra olunardı:' : '✗ Uyğun gəlmir (heç nə göndərilməzdi).'),
        r.steps.length
          ? h(
              'ol',
              {},
              r.steps.map((s) => h('li', {}, s)),
            )
          : '',
        r.errors.length
          ? h(
              'div',
              { class: 'warn-text' },
              h('b', {}, 'Aktivləşdirmədən əvvəl düzəldin:'),
              h(
                'ul',
                {},
                r.errors.map((e) => h('li', {}, e)),
              ),
            )
          : '',
      );
    } catch {
      out.textContent = 'Yoxlamaq alınmadı.';
    }
  });
})();
