import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// 前端 root 在 web/，build 產物丟給 server 當靜態檔
export default defineConfig({
  root: "web",
  plugins: [react()],
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("./shared", import.meta.url)),
      "@server": fileURLToPath(new URL("./server", import.meta.url)),
      // 顯示設定放在專案根，前後端共用同一份
      "@config": fileURLToPath(new URL("./config.json", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // dev 時前端打 /api 與 /events 都轉給 collector 服務
    proxy: {
      "/api": "http://127.0.0.1:4321",
      "/events": {
        target: "http://127.0.0.1:4321",
        // SSE 不能被 buffer
        configure: (proxy) => {
          proxy.on("proxyRes", (proxyRes) => {
            proxyRes.headers["cache-control"] = "no-cache";
          });
        },
      },
    },
  },
  build: {
    outDir: "../server/public",
    emptyOutDir: true,
    rollupOptions: {
      // 儀表板與 3D 測試場景各自是一頁，3D 那包才不會拖累主頁的載入
      input: {
        main: fileURLToPath(new URL("./web/index.html", import.meta.url)),
        scene3d: fileURLToPath(new URL("./web/scene3d.html", import.meta.url)),
      },
    },
  },
});
