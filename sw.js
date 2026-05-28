self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  if (event.action === 'like') {
    event.waitUntil(
      self.clients.matchAll({type: 'window'}).then(function(clients) {
        clients.forEach(function(client) {
          client.postMessage({action: 'like'});
        });
        if (clients.length > 0) clients[0].focus();
      })
    );
  } else {
    event.waitUntil(
      self.clients.matchAll({type: 'window'}).then(function(clients) {
        if (clients.length > 0) {
          clients[0].focus();
        } else {
          self.clients.openWindow('/');
        }
      })
    );
  }
});
