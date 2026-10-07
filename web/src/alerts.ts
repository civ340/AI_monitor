import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentState } from "@shared/types";
import { useAgentStore } from "./useAgentStream";
import { displayName } from "./agentStyle";
import { alertsForChange, titleWithCount, waitingCount, type AlertKind } from "./logic/notify";
import { projectName } from "./logic/format";

/**
 * 「等你回覆」的提醒：桌面通知、提示音、分頁標題計數。
 * 觸發判斷在 logic/notify.ts（純函式），這裡只負責接瀏覽器 API。
 */

const KEY_NOTIFY = "aim.notify";
const KEY_SOUND = "aim.sound";

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

function writeFlag(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? "1" : "0");
  } catch {
    // 隱私模式等情況存不了，當作這次工作階段有效即可
  }
}

const hasNotification = typeof Notification !== "undefined";

// ---------- 提示音（Web Audio 合成，不用外部音檔）----------
let audio: AudioContext | null = null;

function ctx(): AudioContext | null {
  try {
    if (!audio) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      audio = new Ctor();
    }
    if (audio.state === "suspended") void audio.resume();
    return audio;
  } catch {
    return null;
  }
}

function beep(c: AudioContext, freq: number, at: number, dur: number, type: OscillatorType, peak: number): void {
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  // 短促的包絡：避免爆音
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(peak, at + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  osc.connect(gain).connect(c.destination);
  osc.start(at);
  osc.stop(at + dur + 0.02);
}

/** permission＝兩聲上揚的急促提示；input＝一聲柔和的叮 */
export function playChime(kind: AlertKind): void {
  const c = ctx();
  if (!c) return;
  const t = c.currentTime + 0.01;
  if (kind === "permission") {
    beep(c, 880, t, 0.14, "triangle", 0.22);
    beep(c, 1175, t + 0.16, 0.22, "triangle", 0.22);
  } else {
    beep(c, 660, t, 0.35, "sine", 0.16);
  }
}

function notifyDesktop(agent: AgentState, kind: AlertKind): void {
  const who = displayName(agent);
  const project = projectName(agent.cwd);
  const title = kind === "permission" ? `${who} 需要你核准權限` : `${who} 在等你下一步`;
  const body = [project, agent.detail].filter(Boolean).join(" · ") || "回去看看吧";
  try {
    const n = new Notification(title, { body, tag: `aim-${agent.id}` });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    // 某些環境（例如部分行動瀏覽器）不允許 new Notification
  }
}

export type AlertControls = {
  /** 這個瀏覽器有沒有 Notification API */
  supported: boolean;
  permission: NotificationPermission | "unsupported";
  notifyOn: boolean;
  soundOn: boolean;
  /** 第一次點會跳出權限詢問；之後是開關 */
  toggleNotify: () => void;
  toggleSound: () => void;
};

/**
 * 掛在 App 最外層一次。直接訂閱 store 而不是看 render 後的 agents 陣列：
 * 兩次推播被 React 合併成一次 render 時，中間的轉換會被吃掉。
 */
export function useAlerts(agents: AgentState[]): AlertControls {
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(
    hasNotification ? Notification.permission : "unsupported",
  );
  const [notifyOn, setNotifyOn] = useState(() => readFlag(KEY_NOTIFY, true));
  const [soundOn, setSoundOn] = useState(() => readFlag(KEY_SOUND, true));

  // 訂閱只做一次，設定走 ref
  const live = useRef({ permission, notifyOn, soundOn });
  live.current = { permission, notifyOn, soundOn };

  useEffect(() => {
    return useAgentStore.subscribe((state, prev) => {
      // 第一份 snapshot（含斷線重連後的第一份）只同步狀態，不是轉換 —— 判斷在 alertsForChange
      for (const { agent, kind } of alertsForChange(prev, state)) {
        const s = live.current;
        if (s.soundOn) playChime(kind);
        if (s.notifyOn && s.permission === "granted") notifyDesktop(agent, kind);
      }
    });
  }, []);

  const toggleNotify = useCallback(() => {
    if (!hasNotification) return;
    if (live.current.permission === "default") {
      // 一定要在使用者點擊裡才請求權限，所以只放在這個按鈕
      void Notification.requestPermission().then((p) => {
        setPermission(p);
        if (p === "granted") {
          setNotifyOn(true);
          writeFlag(KEY_NOTIFY, true);
        }
      });
      return;
    }
    if (live.current.permission !== "granted") return;
    const next = !live.current.notifyOn;
    writeFlag(KEY_NOTIFY, next);
    setNotifyOn(next);
  }, []);

  const toggleSound = useCallback(() => {
    // 副作用不能放進 setState 的 updater（StrictMode 會執行兩次），所以從 ref 讀現值
    const next = !live.current.soundOn;
    writeFlag(KEY_SOUND, next);
    setSoundOn(next);
    // 開啟時順便響一聲：既確認有聲音，也在使用者手勢內解鎖 AudioContext
    if (next) playChime("input");
  }, []);

  // 分頁不在前景時，標題前面加等待數
  const baseTitle = useRef(document.title);
  const [hidden, setHidden] = useState(document.hidden);
  useEffect(() => {
    const on = (): void => setHidden(document.hidden);
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  const waiting = waitingCount(agents);
  useEffect(() => {
    document.title = titleWithCount(baseTitle.current, waiting, hidden);
  }, [waiting, hidden]);

  return { supported: hasNotification, permission, notifyOn, soundOn, toggleNotify, toggleSound };
}
