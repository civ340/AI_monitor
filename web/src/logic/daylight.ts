/**
 * 日夜循環：由本地時間（小數小時 0–24）算出場景該有的天空色與燈光倍率。
 * 關鍵影格之間線性內插，所以黃昏過渡是平滑的；午夜首尾相接。
 */

export type DayPhase = "dawn" | "day" | "dusk" | "night";

export type Daylight = {
  phase: DayPhase;
  /** 窗外天空色 0xRRGGBB */
  sky: number;
  /** 主光（太陽）強度倍率，白天 1 */
  sun: number;
  /** 環境光強度倍率 */
  ambient: number;
  /** 0 = 不偏色、1 = 主光完全染成 WARM_TINT；黃昏最高 */
  warm: number;
};

type Key = { h: number; sky: number; sun: number; ambient: number; warm: number };

// 時間由小到大；首尾（0 與 24）同值，午夜接得起來
const KEYS: Key[] = [
  { h: 0, sky: 0x1a2147, sun: 0.55, ambient: 0.72, warm: 0 },
  { h: 5, sky: 0x1f2a55, sun: 0.55, ambient: 0.72, warm: 0 },
  { h: 6.5, sky: 0xf2b78a, sun: 0.8, ambient: 0.88, warm: 0.7 },
  { h: 8.5, sky: 0xbfe3ff, sun: 1, ambient: 1, warm: 0.1 },
  { h: 16, sky: 0xbfe3ff, sun: 1, ambient: 1, warm: 0.1 },
  { h: 18, sky: 0xff9a6b, sun: 0.82, ambient: 0.9, warm: 0.9 },
  { h: 19.5, sky: 0x5a4a8a, sun: 0.65, ambient: 0.8, warm: 0.4 },
  { h: 21, sky: 0x1a2147, sun: 0.55, ambient: 0.72, warm: 0 },
  { h: 24, sky: 0x1a2147, sun: 0.55, ambient: 0.72, warm: 0 },
];

/** 黃昏時主光偏的色 */
export const WARM_TINT = 0xffb27a;

export function lerpColor(a: number, b: number, t: number): number {
  const ch = (c: number, s: number): number => (c >> s) & 0xff;
  const mix = (s: number): number => Math.round(ch(a, s) + (ch(b, s) - ch(a, s)) * t);
  return (mix(16) << 16) | (mix(8) << 8) | mix(0);
}

export function hourOf(d: Date): number {
  return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
}

export function phaseOf(hour: number): DayPhase {
  const h = ((hour % 24) + 24) % 24;
  if (h >= 5 && h < 8.5) return "dawn";
  if (h >= 8.5 && h < 16.5) return "day";
  if (h >= 16.5 && h < 20) return "dusk";
  return "night";
}

export function daylightAt(hour: number): Daylight {
  const h = Number.isFinite(hour) ? ((hour % 24) + 24) % 24 : 12;
  let lo = KEYS[0]!;
  let hi = KEYS[KEYS.length - 1]!;
  for (let i = 0; i < KEYS.length - 1; i++) {
    if (h >= KEYS[i]!.h && h <= KEYS[i + 1]!.h) {
      lo = KEYS[i]!;
      hi = KEYS[i + 1]!;
      break;
    }
  }
  const t = hi.h === lo.h ? 0 : (h - lo.h) / (hi.h - lo.h);
  const f = (a: number, b: number): number => a + (b - a) * t;
  return {
    phase: phaseOf(h),
    sky: lerpColor(lo.sky, hi.sky, t),
    sun: f(lo.sun, hi.sun),
    ambient: f(lo.ambient, hi.ambient),
    warm: f(lo.warm, hi.warm),
  };
}
