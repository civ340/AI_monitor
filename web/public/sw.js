// 最小 service worker：只快取靜態殼，讓 PWA 可安裝、重開得快。
// 絕不碰 /api 與 /events —— 那是即時資料，快取了就是錯的。
// 殼的結構（SHELL 清單、快取策略）有變就把版本加一：activate 會刪掉所有舊版 cache，不會殘留過期的殼。
const CACHE_PREFIX = "ai-monitor-shell-";
const CACHE_VERSION = 3;
const CACHE = CACHE_PREFIX + "v" + CACHE_VERSION;
const SHELL = ["/", "/manifest.webmanifest", "/icon.svg"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // 不 respondWith＝瀏覽器照常直連網路
  if (url.pathname.startsWith("/api/") || url.pathname === "/events") return;

  // 頁面：網路優先（才吃得到新版），離線才用快取
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((res) => {
          // 只有成功的回應才更新殼：500／錯誤頁寫進去，離線時就會一直拿到壞掉的頁面
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put("/", copy));
          }
          return res;
        })
        .catch(() => caches.match("/")),
    );
    return;
  }

  // 其餘靜態資源（含雜湊檔名的 /assets/*）：快取優先、背景更新
  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => hit);
      return hit || net;
    }),
  );
});
