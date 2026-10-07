/**
 * 「所有 collector 首輪 emit 完成」的閘門。
 *
 * server 重啟時如果先送 snapshot，前端會看到一份不完整的名單（各 collector 還沒掃完）：
 * 角色整批離場再進場、狀態也會從舊的跳到新的而重發通知。
 * 所以 /events 與 /api/state 先等這個閘門；為避免某個 collector 卡住拖垮整個服務，等待有上限，
 * 第一次逾時就永久放行（之後的請求不再等）。
 */
export type ReadyGate = {
  markReady(): void;
  isReady(): boolean;
  /** 已 ready 或超過上限時 resolve；不會 reject */
  wait(): Promise<void>;
};

export function createReadyGate(maxWaitMs: number): ReadyGate {
  let ready = false;
  /** 已經逾時放行過一次：之後視同 ready。否則某個 collector 永久卡住時，每個請求都要多等 maxWaitMs */
  let timedOut = false;
  let resolveReady!: () => void;
  const readyP = new Promise<void>((r) => (resolveReady = r));
  return {
    markReady() {
      ready = true;
      resolveReady();
    },
    isReady: () => ready,
    wait() {
      if (ready || timedOut) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          timedOut = true;
          resolve();
        }, maxWaitMs);
        t.unref?.();
        void readyP.then(() => {
          clearTimeout(t);
          resolve();
        });
      });
    },
  };
}
