// Knowledge page: uploads the chosen source file as raw bytes (CSRF token in a header, file name in the query).
(() => {
  const go = document.getElementById('source-upload');
  const file = document.getElementById('source-file');
  const out = document.getElementById('source-result');
  if (!go || !file || !out) return;
  go.addEventListener('click', async () => {
    const f = file.files?.[0];
    if (!f) {
      out.textContent = 'Fayl seçin.';
      return;
    }
    if (f.size > 10 * 1024 * 1024) {
      out.textContent = 'Fayl 10 MB-dan böyükdür.';
      return;
    }
    go.disabled = true;
    out.textContent = 'Yüklənir…';
    try {
      const res = await fetch(`/app/knowledge/sources/file?name=${encodeURIComponent(f.name)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'x-csrf-token': go.dataset.csrf, accept: 'application/json' },
        body: f,
      });
      const j = await res.json().catch(() => ({}));
      if (j.ok) location.assign('/app/knowledge?m=source_added');
      else out.textContent = `Xəta: ${j.error || res.status}`;
    } catch {
      out.textContent = 'Şəbəkə xətası.';
    } finally {
      go.disabled = false;
    }
  });
})();
