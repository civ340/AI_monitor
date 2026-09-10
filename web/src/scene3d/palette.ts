import config from "@config";

/**
 * 3D 場景的配色，刻意跟 styles.css 的 CSS 變數對齊，
 * 之後真的要把場景搬進儀表板時，主題切換才不會出現兩套色。
 */
export type ScenePalette = {
  id: string;
  label: string;
  wall: number;
  wallSide: number;
  floor: number;
  rug: number;
  desk: number;
  metal: number;
  screen: number;
  /** 螢幕自發光強度：夜間房間暗，螢幕要更亮才像唯一光源 */
  screenGlow: number;
  fog: number;
  ambient: number;
  ambientIntensity: number;
  sun: number;
  sunIntensity: number;
  windowGlow: number;
  /** 只打在角色身上的補光。房間暗下來時角色會跟著暗掉，但角色的顏色是辨識 agent 的唯一線索，不能一起沉進背景 */
  castFill: number;
  castFillIntensity: number;
  /** 角色的輪廓線顏色。要跟背景拉開對比，不然剪影會糊掉 */
  castOutline: number;
};

export const PALETTES: ScenePalette[] = [
  {
    id: "day",
    label: "☀️ 白天",
    wall: 0xf4e7dd,
    wallSide: 0xe8d8cc,
    floor: 0xe3c9b4,
    rug: 0xffd9c0,
    desk: 0xd9b494,
    metal: 0xb9a89c,
    screen: 0x9fd8ff,
    screenGlow: 0.5,
    fog: 0xf4e7dd,
    ambient: 0xfff3e6,
    ambientIntensity: 1.6,
    sun: 0xfff0dc,
    sunIntensity: 2.6,
    windowGlow: 0xfff6e2,
    // 白天房間本來就亮，補光只是讓臉不要落在陰影裡
    castFill: 0xfff4e8,
    castFillIntensity: 0.25,
    castOutline: 0x4a3340,
  },
  {
    id: "night",
    label: "🌙 夜班",
    wall: 0x34324d,
    wallSide: 0x2c2a42,
    floor: 0x2a2840,
    rug: 0x46436c,
    desk: 0x413d5c,
    metal: 0x5b5878,
    screen: 0x8fb8ff,
    screenGlow: 2.4,
    fog: 0x201e32,
    ambient: 0x5a5a8c,
    ambientIntensity: 0.7,
    sun: 0x9fb4ff,
    sunIntensity: 0.9,
    windowGlow: 0x2b3766,
    // 夜班要靠這盞把人從背景裡拉出來，所以下得比日間重得多
    // 偏藍會把暖色的衣服洗成灰褐色，accent 就認不出來了 —— 只留一點點冷調呼應房間
    castFill: 0xeceeff,
    castFillIntensity: 3.1,
    // 比夜間的牆(0x34324d)亮一階，剪影才切得出來
    castOutline: 0x9c96c8,
  },
  {
    id: "mint",
    label: "🌿 薄荷",
    wall: 0xe6f5ee,
    wallSide: 0xd6ebe1,
    floor: 0xcfe6da,
    rug: 0xb3d3c4,
    desk: 0xc2ddcd,
    metal: 0xa9c4b7,
    screen: 0xa8e6d4,
    screenGlow: 0.6,
    fog: 0xe6f5ee,
    ambient: 0xeafff6,
    ambientIntensity: 1.5,
    sun: 0xf2fffa,
    sunIntensity: 2.3,
    windowGlow: 0xf4fffb,
    castFill: 0xf4fffa,
    castFillIntensity: 0.3,
    castOutline: 0x3f5a50,
  },
];

/**
 * 角色配色沿用 config.json 的 accent，讓 3D 版的 Claude / Codex 認得出是同一個人。
 * 直接讀 config 而不是把色碼抄過來：抄一份的話改了 config.json 只有 2D 儀表板會變，
 * 3D 場景會默默留著舊色，「同一個 agent 到哪都同一個顏色」這個前提就破了。
 * default 只是查不到 agent 時的墊檔，不是工位上的人，所以排除。
 */
type AgentConfig = { label: string; accent: string };

export const AGENT_COLORS = Object.entries(config.agents as Record<string, AgentConfig>)
  .filter(([id]) => id !== "default")
  .map(([id, a]) => ({ id, label: a.label, accent: hexToInt(a.accent) }));

/** config 存的是 CSS 的 "#rrggbb"，three 要的是數字 */
function hexToInt(css: string): number {
  return parseInt(css.replace("#", ""), 16);
}
