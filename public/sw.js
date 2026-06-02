// Service worker: receives web push and shows a notification on your phone/desktop.
self.addEventListener('push', (event) => {
  let data = { title: 'SailOne CRM', body: 'You have a reminder' };
  try { data = event.data.json(); } catch {}
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon.png',
      badge: '/icon.png',
      vibrate: [100, 50, 100],
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow('/'));
});
