import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// 只在 production build 註冊 service worker：dev 時它會把 HMR 與舊檔案快取起來，很難除錯
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // 不支援或被擋（例如非 https 的區網 IP）就算了，不影響主功能
    });
  });
}
