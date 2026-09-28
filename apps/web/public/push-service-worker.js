function boundedText(value, maxLength) {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }

  const threadName = boundedText(payload.threadName, 80);
  const threadId = boundedText(payload.threadId, 128);
  const safeThreadId = threadId && /^[A-Za-z0-9._:-]+$/.test(threadId) ? threadId : null;
  const title = threadName ? `Codex · ${threadName}` : 'Codex';

  event.waitUntil(
    self.registration.showNotification(title, {
      body: 'Работа в чате завершена.',
      tag: safeThreadId ? `codex-thread:${safeThreadId}` : 'codex-chat',
      data: { url: '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL('/', self.location.origin);

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (windows) => {
      const existing = windows.find(
        (client) => new URL(client.url).origin === self.location.origin,
      );
      if (existing) {
        if ('navigate' in existing) await existing.navigate(target.href);
        return existing.focus();
      }
      return self.clients.openWindow('/');
    }),
  );
});
