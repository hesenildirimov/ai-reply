// Small progressive enhancements (no inline JS: CSP blocks it).
document.addEventListener('submit', (e) => {
  const msg = e.target.dataset?.confirm;
  if (msg && !window.confirm(msg)) e.preventDefault();
});

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-copy]');
  if (!btn) return;
  const input = document.getElementById(btn.dataset.copy);
  const done = () => { btn.lastChild.textContent = 'Kopyalandı'; };
  navigator.clipboard?.writeText(input.value).then(done, () => { input.select(); });
});

// Chat: start at the newest message; Enter sends, Shift+Enter makes a new line.
const thread = document.getElementById('thread');
if (thread) thread.scrollTop = thread.scrollHeight;
document.querySelectorAll('.composer textarea').forEach((t) => {
  if (t.closest('.inbox3')) return; // inbox.js handles its own composer
  t.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); t.form.requestSubmit(); }
  });
});

// Inbox: refresh for new messages unless the user is typing.
const box = document.querySelector('[data-autorefresh]');
if (box) {
  setInterval(() => {
    const t = box.querySelector('textarea');
    if (!document.hidden && (!t || (!t.value && document.activeElement !== t))) location.reload();
  }, Number(box.dataset.autorefresh) * 1000);
}
// Selects marked data-autosubmit submit their form on change (filters, role pickers).
document.addEventListener('change', (e) => { if (e.target.matches?.('[data-autosubmit]')) e.target.form.requestSubmit(); });
