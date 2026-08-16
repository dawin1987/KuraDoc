const CACHE = "KuraDoc-cache-v1";
const FILES = [
  "./",
  "index.html",
  "manifest.json",
  "icons/icon-azul.png",
  "icons/icon-azul-2.png",
  "img/loginmedicina1.png",
  "assets/app.styles.css",
  "assets/app.logic.json"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(FILES))
  );
});

self.addEventListener("fetch", (event) => {
  event.respondWith(
    caches.match(event.request).then((response) => {
      return response || fetch(event.request);
    })
  );
});
