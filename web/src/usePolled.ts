import { useEffect, useRef, useState } from "react";
import { getJson } from "./api";

export type Polled<T> = {
  data: T | null;
  /** 最近一次請求失敗（404、後端沒開、格式壞掉都算）。舊資料仍保留在 data */
  failed: boolean;
  /** 還沒有任何一次回應 */
  loading: boolean;
};

/**
 * 載入時抓一次、之後每 intervalMs 更新。enabled=false 時完全不打 API。
 * getUrl 每次請求都重新呼叫，所以像「今天 00:00」這種會過午夜變動的參數也安全。
 */
export function usePolled<T>(getUrl: () => string, intervalMs: number, enabled = true): Polled<T> {
  const [state, setState] = useState<Polled<T>>({ data: null, failed: false, loading: true });
  const urlRef = useRef(getUrl);
  urlRef.current = getUrl;

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let ctrl: AbortController | null = null;

    const load = (): void => {
      ctrl?.abort();
      ctrl = new AbortController();
      getJson<T>(urlRef.current(), ctrl.signal)
        .then((data) => alive && setState({ data, failed: false, loading: false }))
        .catch((err: unknown) => {
          if (!alive || (err instanceof DOMException && err.name === "AbortError")) return;
          setState((s) => ({ data: s.data, failed: true, loading: false }));
        });
    };

    load();
    const timer = window.setInterval(load, intervalMs);
    return () => {
      alive = false;
      ctrl?.abort();
      window.clearInterval(timer);
    };
  }, [intervalMs, enabled]);

  return state;
}

/** 本地今天 00:00（epoch ms） */
export function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
