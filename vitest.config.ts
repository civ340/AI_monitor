import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// 獨立於 vite.config.ts —— 那份的 root 是 "web"（前端），測試要跑在專案根。
export default defineConfig({
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("./shared", import.meta.url)),
      "@server": fileURLToPath(new URL("./server", import.meta.url)),
      "@config": fileURLToPath(new URL("./config.json", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
