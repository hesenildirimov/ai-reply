// Shows browser notifications for customers waiting on a reply. Payload: { title, body, url }.
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { /* ignore */ }
  const url = typeof d.url === 'string' && d.url.startsWith('/app/') ? d.url : '/app/inbox';
  e.waitUntil(self.registration.showNotification(d.title || 'AI Reply', { body: d.body || '', tag: url, renotify: true, data: { url }, icon: '/public/icon.svg' }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = e.notification.data?.url ? e.notification.data.url : '/app/inbox';
  e.waitUntil((async () => {
    const wins = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) if ('focus' in w) { await w.navigate(url); return w.focus(); }
    return clients.openWindow(url);
  })());
});
