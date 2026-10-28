// Contacts page: toggles the import box and uploads the chosen CSV as text/csv (CSRF token in a header).
(() => {
  for (const b of document.querySelectorAll('[data-open]')) {
    b.addEventListener('click', () => {
      const box = document.getElementById(b.dataset.open);
      if (box) box.hidden = !box.hidden;
    });
  }
  const go = document.getElementById('import-go');
  const file = document.getElementById('import-file');
  const out = document.getElementById('import-result');
  if (!go || !file || !out) return;
  go.addEventListener('click', async () => {
    const f = file.files?.[0];
    if (!f) {
      out.textContent = 'Fayl seçin.';
      return;
    }
    if (f.size > 1024 * 1024) {
      out.textContent = 'Fayl 1 MB-dan böyükdür.';
      return;
    }
    go.disabled = true;
    out.textContent = 'Yüklənir…';
    try {
      const res = await fetch('/app/contacts/import', {
        method: 'POST',
        headers: { 'content-type': 'text/csv', 'x-csrf-token': go.dataset.csrf, accept: 'application/json' },
        body: await f.text(),
      });
      const j = await res.json().catch(() => ({}));
      out.textContent = j.ok ? `${j.rows} sətir: ${j.updated} kontakt yeniləndi, ${j.not_found} tapılmadı.` : `Xəta: ${j.error || res.status}`;
    } catch {
      out.textContent = 'Şəbəkə xətası.';
    } finally {
      go.disabled = false;
    }
  });
})();
