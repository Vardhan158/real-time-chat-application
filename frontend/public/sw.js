self.addEventListener("push", (event) => {
  if (!event.data) {
    return;
  }

  let payload = {};

  try {
    payload = event.data.json();
  } catch {
    payload = {
      title: "New message",
      body: event.data.text(),
      url: "/",
    };
  }

  const title = payload.title || "New message";
  const options = {
    body: payload.body || "",
    tag: payload.tag || "chat-message",
    data: {
      url: payload.url || "/",
      chatId: payload.data?.chatId || null,
    },
    renotify: true,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const targetUrl = new URL(
    event.notification.data?.url || "/",
    self.location.origin,
  ).href;

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (!client.url.startsWith(self.location.origin)) {
          continue;
        }

        return client.navigate(targetUrl).then(() => client.focus());
      }

      return clients.openWindow(targetUrl);
    }),
  );
});
