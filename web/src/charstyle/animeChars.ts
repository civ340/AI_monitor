import * as THREE from "three";
import { toonMat, glowMat, addOutlines, makeBlobShadow } from "./toon";
import { makeFacePatch, type FaceOpts } from "./faces";
import { hairShell, bangEdge } from "./hair";

/**
 * 動漫風角色庫。跟 scene3d/characters.ts 的共同約束一樣
 * （站原點、腳貼地 y=0、高度約 2、正面朝 +Z），差別只在風格：
 * Q 版頭身比、cel shading、外框線、貼圖式五官。
 */

export type AnimeChar = {
  group: THREE.Group;
  update: (t: number) => void;
};

export type AnimeKind = {
  id: string;
  label: string;
  build: (accent: number) => AnimeChar;
};

const SKIN = 0xffe2d0;
/**
 * 頭部的幾何一律以 HEAD_R 為單位算（髮殼、臉部貼片、耳朵、髮飾都是），
 * 所以要調頭身比就改 HEAD_SCALE、不要動 HEAD_R —— 直接改 HEAD_R
 * 等於要把每個配件的座標重算一遍。整組縮放則所有配件自動跟著走。
 * 總高固定 2.0（office 的擺位與浮動動畫依賴這個約束）：
 * 頭高 = HEAD_R × 1.04 × HEAD_SCALE × 2 = 0.769 → 約 2.6 頭身。
 */
const HEAD_R = 0.42;
const HEAD_SCALE = 0.88;
const HEAD_Y = 1.616;

type BaseOpts = {
  hair: number;
  cloth: number;
  cloth2: number;
  shoe: number;
  face: FaceOpts;
  /** 裙子而不是褲子 */
  skirt?: boolean;
  /** 瀏海下緣深度 [正中央, 兩側]，弧度從頭頂算起。眉毛大約在 1.25，臉頰 2.0 */
  bangs?: [number, number];
  /** 關掉頭髮高光帶。頭上有帽子時，那條帶子從開口露出來會變成髮箍 */
  halo?: boolean;
};

type Base = {
  g: THREE.Group;
  /** 頭是獨立節點：所有髮型與五官都掛在它底下，轉頭時整組一起走 */
  head: THREE.Group;
  torso: THREE.Mesh;
};

/** 共用的 Q 版身體：頭大、四肢短、手腳圓 */
function buildBase(o: BaseOpts): Base {
  const g = new THREE.Group();
  const skin = toonMat(SKIN, true);
  const cloth = toonMat(o.cloth);
  const cloth2 = toonMat(o.cloth2);
  const shoeMat = toonMat(o.shoe);

  // ---------- 軀幹 ----------
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.235, 0.3, 6, 20), cloth);
  torso.position.y = 0.88;
  torso.scale.set(1, 1, 0.84);
  g.add(torso);

  // 臀部：一顆壓扁的球，把軀幹底部的圓弧接到腿。
  // 少了它，細腿是直接從一顆球底下冒出來，看起來像插上去的
  const hip = new THREE.Mesh(new THREE.SphereGeometry(0.225, 20, 14), cloth2);
  hip.position.y = 0.5;
  hip.scale.set(1, 0.6, 0.86);
  g.add(hip);

  // ---------- 腿與鞋 ----------
  for (const dx of [-0.135, 0.135]) {
    const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.088, 0.24, 4, 14), skin);
    leg.position.set(dx, 0.36, 0);
    g.add(leg);
    const shoe = new THREE.Mesh(new THREE.SphereGeometry(0.13, 18, 14), shoeMat);
    shoe.position.set(dx, 0.105, 0.035);
    shoe.scale.set(1, 0.72, 1.32);
    g.add(shoe);
  }

  if (o.skirt) {
    const skirt = new THREE.Mesh(new THREE.CylinderGeometry(0.23, 0.42, 0.32, 24), cloth2);
    skirt.position.y = 0.6;
    g.add(skirt);
  }

  // ---------- 肩膀與手臂 ----------
  // 手臂要有一大截埋進軀幹裡才不會像掛上去的：反向外殼描邊會沿著
  // 每個量體各畫一圈，兩個量體只是輕輕相碰的話，那兩圈線就變成一條分隔線。
  for (const dx of [-1, 1]) {
    const shoulder = new THREE.Mesh(new THREE.SphereGeometry(0.12, 16, 12), cloth);
    shoulder.position.set(dx * 0.235, 1.09, 0.01);
    shoulder.scale.set(1, 1, 0.88);
    g.add(shoulder);

    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.24, 4, 12), cloth);
    arm.position.set(dx * 0.295, 0.9, 0.02);
    // 下端往外撇，手才不會貼在身體上
    arm.rotation.z = dx > 0 ? 0.14 : -0.14;
    g.add(arm);

    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.085, 14, 12), skin);
    hand.position.set(dx * 0.35, 0.71, 0.03);
    g.add(hand);
  }

  // ---------- 頭 ----------
  const head = new THREE.Group();
  head.position.y = HEAD_Y;
  head.scale.setScalar(HEAD_SCALE);
  g.add(head);

  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.095, 0.14, 12), skin);
  neck.position.y = 1.21;
  g.add(neck);

  const skull = new THREE.Mesh(new THREE.SphereGeometry(HEAD_R, 36, 28), skin);
  skull.scale.set(1, 1.04, 0.97);
  head.add(skull);
  head.add(makeFacePatch(HEAD_R, o.face));

  // ---------- 頭髮：後腦杓一片、瀏海一片，正面留出臉的開口 ----------
  // 兩片都從頭頂長出來，所以頭頂不會留缺口；瀏海的 phi 範圍比開口寬，
  // 兩片在鬢角處重疊，轉頭時不會看到接縫。
  const hairMat = toonMat(o.hair);
  const gap = 1.5;
  const back = new THREE.Mesh(
    hairShell({
      phiStart: Math.PI / 2 + gap / 2,
      phiLength: Math.PI * 2 - gap,
      inner: HEAD_R - 0.012,
      outer: HEAD_R + 0.034,
      edge: () => 1.62,
    }),
    hairMat,
  );
  back.scale.set(1, 1.04, 0.97);
  head.add(back);

  const [bc, bs] = o.bangs ?? [1.14, 1.95];
  const arc = 3.4;
  const bangs = new THREE.Mesh(
    hairShell({
      phiStart: Math.PI / 2 - arc / 2,
      phiLength: arc,
      inner: HEAD_R - 0.012,
      outer: HEAD_R + 0.037,
      edge: bangEdge(bc, bs),
    }),
    hairMat,
  );
  bangs.scale.set(1, 1.04, 0.97);
  head.add(bangs);

  if (o.halo !== false) addHalo(head, o.hair);

  return { g, head, torso };
}

/**
 * 天使の輪：頭髮上那一圈高光帶。動漫頭髮少了它就只是一塊色塊，
 * 這是 2D 插畫裡辨識度最高的一筆，3D 沒有它怎麼打光都不像。
 * 波浪相位讓上下緣錯開，帶子才不是等寬的膠帶。
 */
function addHalo(head: THREE.Group, hair: number): void {
  // 提亮要走 HSL：直接往白色 lerp 會把彩度一起洗掉，棕髮的高光會變成灰色
  const shine = new THREE.Color(hair);
  const hsl = { h: 0, s: 0, l: 0 };
  shine.getHSL(hsl);
  // 本來就很亮的髮色（白髮、淺金）再提亮就看不見了，改成往暗的方向做同一條帶子
  const delta = hsl.l > 0.66 ? -0.12 : 0.28;
  // 只有往亮的方向才補彩度；往暗做的是陰影帶，加彩度會讓白髮變成米黃色
  const sat = delta > 0 ? Math.min(1, hsl.s * 1.15 + 0.04) : hsl.s * 0.8;
  shine.setHSL(hsl.h, sat, THREE.MathUtils.clamp(hsl.l + delta, 0.08, 0.92));

  const hiArc = 3.9;
  const halo = new THREE.Mesh(
    hairShell({
      phiStart: Math.PI / 2 - hiArc / 2,
      phiLength: hiArc,
      // 只比髮面高一點點，拉開就變成飄在頭上的一塊板子
      inner: HEAD_R + 0.036,
      outer: HEAD_R + 0.046,
      edgeTop: (u) => 0.72 + 0.075 * Math.sin(u * Math.PI * 4.2),
      edge: (u) => 0.98 + 0.075 * Math.sin(u * Math.PI * 4.2 + 1.1),
      rows: 4,
    }),
    toonMat(shine.getHex(), true),
  );
  halo.scale.set(1, 1.04, 0.97);
  halo.userData.noOutline = true;
  head.add(halo);
}

/** 呆毛：一撮從頭頂翹起來的彎曲髮絲 */
function addAhoge(head: THREE.Group, hair: number): THREE.Mesh {
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0.42, -0.02),
    new THREE.Vector3(0.04, 0.56, 0.04),
    new THREE.Vector3(0.16, 0.62, 0.02),
    new THREE.Vector3(0.24, 0.55, -0.04),
  ]);
  const m = new THREE.Mesh(new THREE.TubeGeometry(curve, 24, 0.022, 6), toonMat(hair));
  head.add(m);
  return m;
}

// ---------- 1. 短髮女孩 ----------
function buildBob(accent: number): AnimeChar {
  const hair = 0x6b4a3f;
  const base = buildBase({
    hair,
    cloth: accent,
    cloth2: 0x5c6b8a,
    shoe: 0x4a4159,
    bangs: [1.16, 2.05],
    face: { iris: "#7a5cc4", ink: "#4a3340", expression: "smile" },
  });

  const ahoge = addAhoge(base.head, hair);

  // 連帽外套的帽子垂在背後
  const hood = new THREE.Mesh(new THREE.SphereGeometry(0.24, 20, 16), toonMat(accent));
  hood.position.set(0, 1.15, -0.21);
  hood.scale.set(1, 0.8, 0.7);
  base.g.add(hood);

  finish(base.g);
  return {
    group: base.g,
    update(t) {
      base.head.rotation.y = Math.sin(t * 0.8) * 0.22;
      base.head.rotation.z = Math.sin(t * 0.8) * 0.05;
      ahoge.rotation.z = Math.sin(t * 3.1) * 0.22;
    },
  };
}

// ---------- 2. 尖髮少年 ----------
function buildSpiky(accent: number): AnimeChar {
  const hair = 0x2f3350;
  const base = buildBase({
    hair,
    cloth: accent,
    cloth2: 0x3d4258,
    shoe: 0xf0efe8,
    bangs: [1.2, 1.58],
    face: { iris: "#3fa9d8", ink: "#2b2438", expression: "wink", blush: false },
  });

  // 亂翹的髮束：長度與角度都錯開，等長會變成海膽
  const spec: [number, number, number, number][] = [
    [-0.26, 0.3, 0.24, 0.3],
    [0.02, 0.42, 0.2, 0.36],
    [0.28, 0.32, 0.2, 0.28],
    [-0.34, 0.34, -0.1, 0.26],
    [0.34, 0.36, -0.14, 0.24],
    [0.0, 0.44, -0.24, 0.3],
  ];
  const up = new THREE.Vector3(0, 1, 0);
  for (const [x, y, z, len] of spec) {
    const s = new THREE.Mesh(new THREE.ConeGeometry(0.1, len, 6), toonMat(hair));
    // 錐體的軸本來就是 +Y，直接把 +Y 轉到「往外上方」即可；
    // 用 lookAt 再補一次 rotateX 會有一根方向整個翻掉，插進臉裡
    // 往外的分量要壓小：前面那根只要多帶一點 +Z，正面看就會變成一根插進額頭的棒子
    const dir = new THREE.Vector3(x * 1.1, len * 2.2 + 0.35, z * 1.1).normalize();
    s.quaternion.setFromUnitVectors(up, dir);
    s.position.set(x, y, z).addScaledVector(dir, len * 0.3);
    base.head.add(s);
  }

  // 耳機頭帶：torus 本來就躺在 XY 平面（繞 Z 的環），那正好就是左耳跨到右耳；
  // 再把環立起來的話會變成從額頭跨到後腦，正面看是一根插在臉中間的棒子。
  // 圓弧從 +X 開始掃，所以只要在自己的平面裡轉半個弧長，就會對準頭頂。
  const arcLen = Math.PI * 0.92;
  const band = new THREE.Mesh(new THREE.TorusGeometry(0.51, 0.038, 8, 28, arcLen), toonMat(0x3a3f55));
  band.rotation.z = Math.PI / 2 - arcLen / 2;
  base.head.add(band);
  for (const dx of [-1, 1]) {
    const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.09, 16), toonMat(0x3a3f55));
    cup.rotation.z = Math.PI / 2;
    cup.position.set(dx * 0.42, -0.02, 0);
    base.head.add(cup);
    const led = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.11, 12), glowMat(accent));
    led.rotation.z = Math.PI / 2;
    led.position.set(dx * 0.45, -0.02, 0);
    led.userData.noOutline = true;
    base.head.add(led);
  }

  finish(base.g);
  return {
    group: base.g,
    update(t) {
      base.head.rotation.y = Math.sin(t * 1.1) * 0.16;
      // 打拍子：跟著點頭
      base.head.rotation.x = Math.sin(t * 4.2) * 0.06;
      base.torso.rotation.y = Math.sin(t * 1.1) * 0.06;
    },
  };
}

// ---------- 3. 貓耳娘 ----------
function buildNeko(accent: number): AnimeChar {
  const hair = 0xf0e2d4;
  const base = buildBase({
    hair,
    cloth: accent,
    cloth2: 0xfdfaf4,
    shoe: 0x5c4a55,
    skirt: true,
    bangs: [1.2, 2.2],
    face: { iris: "#e0864f", ink: "#5a4048", expression: "cat" },
  });


  // 貓耳：外殼加一層粉紅內耳，只有一個錐體會很像紙折的
  const ears: THREE.Group[] = [];
  for (const dx of [-1, 1]) {
    const ear = new THREE.Group();
    const outer = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.27, 8), toonMat(hair));
    ear.add(outer);
    const inner = new THREE.Mesh(new THREE.ConeGeometry(0.075, 0.16, 8), toonMat(0xff9fb0));
    inner.position.set(0, -0.03, 0.05);
    inner.userData.noOutline = true;
    ear.add(inner);
    ear.scale.set(1, 1, 0.62);
    ear.position.set(dx * 0.21, 0.47, 0.0);
    ear.rotation.z = dx * 0.28;
    ear.rotation.x = -0.18;
    base.head.add(ear);
    ears.push(ear);
  }

  // 尾巴：用曲線掃出來的錐狀管，直接接圓柱會很僵硬
  const tailCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0.05, 0.42, -0.24),
    new THREE.Vector3(0.34, 0.38, -0.5),
    new THREE.Vector3(0.66, 0.5, -0.5),
    new THREE.Vector3(0.82, 0.78, -0.36),
  ]);
  const tail = new THREE.Mesh(new THREE.TubeGeometry(tailCurve, 32, 0.075, 8), toonMat(hair));
  // 尾端掛在尾巴底下：擺動時自己繼承同一個旋轉。
  // 之前是兄弟節點、每幀手算旋轉座標，正負號一寫反球就飄出去了
  const tailTip = new THREE.Mesh(new THREE.SphereGeometry(0.075, 12, 10), toonMat(hair));
  tailTip.position.copy(tailCurve.points[3]!);
  tail.add(tailTip);
  base.g.add(tail);

  finish(base.g);
  return {
    group: base.g,
    update(t) {
      base.head.rotation.y = Math.sin(t * 0.9) * 0.26;
      base.head.rotation.z = Math.sin(t * 0.45) * 0.08;
      // 耳朵不同相位地抽動，同步會變成機械
      ears[0]!.rotation.x = -0.18 + Math.sin(t * 5.5) * 0.14;
      ears[1]!.rotation.x = -0.18 + Math.sin(t * 5.5 + 1.4) * 0.14;
      tail.rotation.y = Math.sin(t * 1.6) * 0.22;
    },
  };
}

// ---------- 4. 雙馬尾 ----------
function buildTwin(accent: number): AnimeChar {
  const hair = 0xffc94d;
  const base = buildBase({
    hair,
    cloth: 0xfdfaf4,
    cloth2: accent,
    shoe: 0x4a4159,
    skirt: true,
    bangs: [1.12, 1.8],
    face: { iris: "#4bb8a9", ink: "#7a5230", expression: "smile" },
  });

  // 水手領 + 胸前蝴蝶結
  const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.245, 0.29, 0.085, 22), toonMat(accent));
  collar.position.y = 1.16;
  base.g.add(collar);

  // 蝴蝶結用兩片錐體加一顆結；torus knot 遠看只是一坨纏在一起的東西
  const bowMat = toonMat(0xff6b8a);
  const bow = new THREE.Group();
  for (const dx of [-1, 1]) {
    const wing = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.14, 10), bowMat);
    wing.rotation.z = (dx * Math.PI) / 2;
    wing.position.x = dx * 0.08;
    wing.scale.set(1, 1, 0.7);
    bow.add(wing);
  }
  const knot = new THREE.Mesh(new THREE.SphereGeometry(0.045, 12, 10), bowMat);
  bow.add(knot);
  bow.position.set(0, 1.09, 0.235);
  base.g.add(bow);

  // 雙馬尾：綁繩 + 一束往外下垂的頭髮
  const tails: THREE.Group[] = [];
  for (const dx of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(dx * 0.4, 0.16, -0.06);
    const tie = new THREE.Mesh(new THREE.TorusGeometry(0.09, 0.032, 8, 16), toonMat(0xff6b8a));
    tie.rotation.y = Math.PI / 2;
    pivot.add(tie);
    const strand = new THREE.Mesh(new THREE.CapsuleGeometry(0.11, 0.36, 5, 14), toonMat(hair));
    strand.position.set(dx * 0.14, -0.3, 0);
    strand.rotation.z = dx * 0.34;
    pivot.add(strand);
    // 尾端掛在髮束底下，跟著它的軸走；自己另外算角度一定會對不齊
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.105, 0.24, 10), toonMat(hair));
    tip.position.y = -0.3;
    tip.rotation.x = Math.PI;
    strand.add(tip);
    base.head.add(pivot);
    tails.push(pivot);
  }

  finish(base.g);
  return {
    group: base.g,
    update(t) {
      base.head.rotation.y = Math.sin(t * 1.3) * 0.3;
      // 馬尾比頭晚一拍才甩得動，同相位會像黏死的
      for (const p of tails) {
        p.rotation.z = Math.sin(t * 1.3 - 0.6) * 0.2;
        p.rotation.x = Math.sin(t * 2.1 - 0.4) * 0.12;
      }
    },
  };
}

// ---------- 5. 兜帽術士 ----------
function buildHood(accent: number): AnimeChar {
  const cloak = 0x453c6b;
  const base = buildBase({
    hair: 0x2b2440,
    cloth: 0x5a4f80,
    cloth2: cloak,
    shoe: 0x2a2440,
    bangs: [1.18, 1.7],
    halo: false,
    face: { iris: "#5fe0cc", ink: "#3a3050", expression: "calm", blush: false },
  });

  // 兜帽：跟頭髮同一套做法（有厚度才畫得出描邊），
  // 只留正面一個開口露出臉，開口兩側最深，往後腦收淺
  const gap = 1.35;
  const hood = new THREE.Mesh(
    hairShell({
      phiStart: Math.PI / 2 + gap / 2,
      phiLength: Math.PI * 2 - gap,
      inner: HEAD_R + 0.03,
      outer: HEAD_R + 0.15,
      edge: (u) => {
        const s = Math.abs(u - 0.5) * 2;
        return 1.72 + 0.5 * Math.pow(s, 1.6);
      },
      cols: 48,
    }),
    toonMat(cloak),
  );
  hood.scale.set(1, 1.04, 0.99);
  base.head.add(hood);

  // 帽尖：垂在後腦，兜帽沒有這一撮就只是一頂安全帽
  const peakCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0.4, -0.42),
    new THREE.Vector3(0, 0.34, -0.62),
    new THREE.Vector3(0.02, 0.14, -0.72),
    new THREE.Vector3(0.05, -0.04, -0.64),
  ]);
  const peak = new THREE.Mesh(
    new THREE.TubeGeometry(peakCurve, 24, 0.09, 8, false),
    toonMat(cloak),
  );
  base.head.add(peak);

  // 斗篷只到膝上，長到腳踝的話整個人就變成一個圓錐
  const cape = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.44, 0.62, 26), toonMat(cloak));
  cape.position.y = 0.8;
  base.g.add(cape);
  const trim = new THREE.Mesh(new THREE.CylinderGeometry(0.445, 0.445, 0.065, 26), toonMat(accent));
  trim.position.y = 0.52;
  base.g.add(trim);
  const clasp = new THREE.Mesh(new THREE.OctahedronGeometry(0.075), glowMat(accent));
  clasp.position.set(0, 1.1, 0.25);
  clasp.userData.noOutline = true;
  base.g.add(clasp);

  // 手邊浮著的符文
  const rune = new THREE.Mesh(new THREE.OctahedronGeometry(0.12), glowMat(accent));
  rune.position.set(0.5, 0.87, 0.26);
  rune.userData.noOutline = true;
  base.g.add(rune);

  finish(base.g);
  return {
    group: base.g,
    update(t) {
      base.head.rotation.y = Math.sin(t * 0.6) * 0.2;
      base.head.rotation.z = Math.sin(t * 0.3) * 0.05;
      rune.rotation.y = t * 1.4;
      rune.rotation.x = t * 0.9;
      rune.position.y = 0.87 + Math.sin(t * 2.2) * 0.05;
      clasp.rotation.y = t * 0.8;
    },
  };
}

/** 每個角色收尾都一樣：加描邊、加腳下軟陰影 */
function finish(g: THREE.Group): void {
  addOutlines(g);
  g.add(makeBlobShadow(0.62));
}

export const ANIME_KINDS: AnimeKind[] = [
  { id: "bob", label: "🧥 短髮女孩", build: buildBob },
  { id: "spiky", label: "🎧 尖髮少年", build: buildSpiky },
  { id: "neko", label: "🐈 貓耳娘", build: buildNeko },
  { id: "twin", label: "🎀 雙馬尾", build: buildTwin },
  { id: "hood", label: "🔮 兜帽術士", build: buildHood },
];
