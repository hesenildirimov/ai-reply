// Subscribes this browser to alerts (Web Push, VAPID).
(() => {
  const btn = document.getElementById('push-enable');
  const status = document.getElementById('push-status');
  if (!btn) return;
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) { btn.disabled = true; status.textContent = 'Bu brauzer bildirişləri dəstəkləmir. iPhone-da saytı "Ana ekrana əlavə et" ilə açın.'; return; }
  const key = (b64) => { const p = '='.repeat((4 - (b64.length % 4)) % 4); const r = atob((b64 + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(r, (c) => c.charCodeAt(0)); };
  btn.addEventListener('click', async () => {
    try {
      if ((await Notification.requestPermission()) !== 'granted') { status.textContent = 'Bildiriş icazəsi verilmədi. Brauzerin ayarlarından icazə verin.'; return; }
      const reg = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key(btn.dataset.key) }));
      const res = await fetch('/app/notifications/push', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': btn.dataset.csrf }, body: JSON.stringify(sub.toJSON()) });
      if (res.ok) location.href = '/app/settings?m=push_on'; else status.textContent = 'Qoşmaq alınmadı.';
    } catch { status.textContent = 'Qoşmaq alınmadı. Səhifəni yeniləyib yenidən cəhd edin.'; }
  });
})();
