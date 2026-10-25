// Inbox enhancements: server-confirmed ajax actions (no optimistic UI), live updates over SSE, tabs, saved replies.
(() => {
  const root = document.querySelector('.inbox3');
  if (!root) return;
  const convId = root.dataset.convId;
  const live = document.getElementById('live');
  const toast = (text, bad) => {
    let t = document.getElementById('toast');
    if (!t) { t = document.createElement('div'); t.id = 'toast'; t.setAttribute('role', 'status'); document.body.append(t); }
    t.textContent = text; t.className = bad ? 'bad' : ''; t.hidden = false;
    clearTimeout(t._h); t._h = setTimeout(() => (t.hidden = true), 3500);
  };
  const fetchPart = async (url) => { const r = await fetch(url, { headers: { Accept: 'text/html' } }); if (!r.ok) throw new Error(String(r.status)); return r.text(); };
  const listUrl = () => {
    const p = new URLSearchParams(location.search); p.delete('m'); if (convId) p.set('active', convId);
    return `${root.dataset.list}?${p}`;
  };
  const refresh = {
    async list() { const el = document.getElementById('conv-list'); if (el) el.innerHTML = await fetchPart(listUrl()); },
    async thread() {
      const el = document.getElementById('thread'); if (!el) return;
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      el.innerHTML = await fetchPart(el.dataset.part);
      if (atBottom) el.scrollTop = el.scrollHeight;
    },
    async pane() {
      const pane = document.querySelector('.ib-pane'); if (!pane || !convId) return;
      const draft = pane.querySelector('textarea')?.value;
      pane.innerHTML = await fetchPart(`/app/inbox/${convId}/part/pane`);
      const t = pane.querySelector('textarea'); if (t && draft) t.value = draft;
      bindPane();
    },
    async profile() { const el = document.getElementById('profile'); if (el?.dataset.part) el.innerHTML = await fetchPart(el.dataset.part); },
  };

  // Ajax forms: wait for the server; only then update the UI. On failure nothing changes except an error toast.
  document.addEventListener('submit', async (e) => {
    const form = e.target;
    if (!form.matches('form[data-ajax]') || e.defaultPrevented) return;
    e.preventDefault();
    const btn = form.querySelector('button'); if (btn) btn.disabled = true;
    try {
      const res = await fetch(form.action, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(new FormData(form)) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || 'Əməliyyat alınmadı');
      if (form.hasAttribute('data-reset')) { form.reset(); const n = form.querySelector('[name=nonce]'); if (n) n.value = crypto.randomUUID().replace(/-/g, ''); }
      await Promise.all([refresh.pane(), refresh.profile(), refresh.list()]);
    } catch (err) { toast(err.message, true); } finally { if (btn) btn.disabled = false; }
  });

  function bindPane() {
    const thread = document.getElementById('thread'); if (thread) thread.scrollTop = thread.scrollHeight;
    document.querySelectorAll('.composer-tabs [data-tab]').forEach((b) => b.addEventListener('click', () => {
      document.querySelectorAll('.composer-tabs [data-tab]').forEach((x) => x.classList.toggle('on', x === b));
      document.querySelectorAll('[data-tab-panel]').forEach((p) => (p.hidden = p.dataset.tabPanel !== b.dataset.tab));
    }));
    document.querySelector('[data-saved]')?.addEventListener('change', (e) => {
      const t = document.querySelector('.composer textarea[name=text]');
      if (t && e.target.value) { t.value = (t.value ? `${t.value}\n` : '') + e.target.value; t.focus(); }
      e.target.value = '';
    });
    document.querySelectorAll('.composer textarea').forEach((t) => t.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); t.form.requestSubmit(); }
    }));
    document.querySelector('[data-toggle-profile]')?.addEventListener('click', () => root.classList.toggle('show-profile'));
  }
  bindPane();
  document.addEventListener('change', (e) => { if (e.target.matches('[data-autosubmit]')) e.target.form.requestSubmit(); });

  // "Load more" appends the next page instead of navigating.
  document.addEventListener('click', async (e) => {
    const more = e.target.closest('[data-more]'); if (!more) return;
    e.preventDefault(); more.textContent = '…';
    try { const html = await fetchPart(more.dataset.more); more.insertAdjacentHTML('afterend', html); more.remove(); } catch { more.textContent = 'Yenidən cəhd et'; }
  });

  // Live updates. EventSource reconnects by itself; we show the state and resync on reconnect.
  let timer;
  const schedule = (fn) => { clearTimeout(timer); timer = setTimeout(fn, 400); };
  if ('EventSource' in window) {
    const es = new EventSource('/app/events');
    es.onopen = () => { live.className = 'live on'; live.title = 'Canlı'; };
    es.onerror = () => { live.className = 'live off'; live.title = 'Bağlantı bərpa olunur…'; };
    es.onmessage = (m) => {
      let ev; try { ev = JSON.parse(m.data); } catch { return; }
      schedule(async () => {
        try {
          await refresh.list();
          if (ev.conversationId === convId) await Promise.all([ev.type === 'message' ? refresh.thread() : refresh.pane(), refresh.profile()]);
        } catch { /* next event resyncs */ }
      });
    };
  } else setInterval(() => refresh.list().catch(() => {}), 30000);
})();
