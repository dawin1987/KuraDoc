// ═══════════════════════════════════════════════════════════════
//  KuraDoc — Service Worker
//  Estrategia: RED PRIMERO (siempre intenta traer lo más nuevo) y usa
//  la copia guardada solo si no hay internet.
//
//  La línea VERSION la actualiza sola el script deploy.bat en cada
//  despliegue. Que cambie es lo que avisa a los usuarios de la
//  nueva versión. No hace falta editarla a mano.
// ═══════════════════════════════════════════════════════════════
const VERSION = "2026-10-13T00-48-50";
const CACHE = "KuraDoc-cache-" + VERSION;

// ── Instalación ────────────────────────────────────────────────
// Si existe la caché antigua (v1), este es el salto desde el service
// worker viejo: se activa de inmediato para que nadie quede atrapado
// con archivos viejos. En actualizaciones normales se espera a que el
// usuario toque "Actualizar ahora" en el aviso.
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.has("KuraDoc-cache-v1").then((habiaViejo) => {
      if (habiaViejo) return self.skipWaiting();
    })
  );
});

// ── Activación: borra cachés de versiones anteriores ───────────
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((claves) =>
        Promise.all(claves.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

// ── El aviso de la página pide activar la nueva versión ────────
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

// ── Red primero, caché solo si no hay conexión ─────────────────
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;          // Firebase, CDNs, etc.
  if (url.pathname.startsWith("/contacto/")) return;        // redirección a WhatsApp
  if (url.pathname.startsWith("/__/")) return;              // rutas internas de Firebase

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.status === 200 && res.type === "basic") {
          const copia = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copia));
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then(
          (r) => r || (req.mode === "navigate" ? caches.match("index.html") : Response.error())
        )
      )
  );
});
