import * as THREE from "three";
import { type ScenePalette } from "./palette";
import { type Character, type CharacterMats } from "./characters";
import { layoutDesks } from "../logic/deskLayout";
import { fmtTokens, fmtUsd, projectName } from "../logic/format";

/**
 * 程序化生成的低多邊形辦公室 —— 刻意不用外部 .glb：
 * 素材檔要處理授權、離線、CSP 一堆問題，而這個場景的重點是驗證
 * 「真 3D + 主題切換 + 角色動畫」在這個專案裡跑不跑得動。
 * 想試真模型的話，scene3d/main.ts 有拖放載入 .glb 的入口。
 *
 * 房間本身不認識「agent」也不認識角色長什麼樣：
 * 誰站在哪由 setOccupants 決定，長相由外面傳進來的 CharacterFactory 決定。
 * 測試頁餵它 config 裡的三個人 + 低多邊形角色，儀表板餵它線上的 agent + 動漫角色。
 */

/** 房間裡的一個人。resident 有自己的桌子，transient 站在地毯上 */
export type Occupant = {
  id: string;
  accent: number;
  resident: boolean;
  activity: "working" | "idle" | "offline";
  /** 工作目錄：同一個 cwd 的工位相鄰，地上掛專案牌 */
  cwd?: string;
  /** transient 的所屬 resident id：從那張桌子附近進場，並畫連線 */
  parent?: string;
  /** 活動以外的情緒／狀態，決定頭上的圖示與姿勢 */
  mood?: Mood;
  /** context 使用率 0–1；沒有 usage 就不給（不畫能量條） */
  usage?: number;
  /** 閒置太久，去茶水間待著 */
  lounging?: boolean;
};

/** permission／input＝等你回覆；error＝失敗；stalled＝卡住；normal＝沒事 */
export type Mood = "normal" | "permission" | "input" | "error" | "stalled";

/** 白板內容。error＝讀不到今日摘要；loading＝還沒回來 */
export type BoardData =
  | { state: "loading" | "error" }
  | {
      state: "ok";
      input: number;
      output: number;
      cacheRead: number;
      cacheCreation: number;
      costUsd: number;
    };

/** 角色工廠。房間只負責擺位置，不管你給的是低多邊形還是動漫角色 */
export type CharacterFactory = (ctx: {
  /** occupant id；用來挑一張固定的臉，同一個 agent 每次都長一樣 */
  id: string;
  accent: number;
  mats: CharacterMats;
  /** 低多邊形角色要的 accent 材質；動漫角色用不到，自己吃 accent 數值 */
  accentMat: THREE.MeshStandardMaterial;
}) => Character;

export type Office = {
  root: THREE.Group;
  /** 每幀更新：角色浮動與走動、椅子微轉、螢幕呼吸光、連線流動 */
  update: (elapsed: number) => void;
  /** 更新白板上的今日用量 */
  setBoard: (data: BoardData) => void;
  /** 窗外天空色（日夜循環）；null＝回到主題原色 */
  setSky: (hex: number | null) => void;
  applyPalette: (p: ScenePalette) => void;
  /** 換角色長相；下一次 setOccupants 生效 */
  setFactory: (make: CharacterFactory) => void;
  /** 依 id 差異增刪人與桌子，既有的人不重建（重建會讓動畫相位跳掉） */
  setOccupants: (list: Occupant[]) => void;
  /** 射線挑人，回傳 occupant id */
  pick: (ray: THREE.Raycaster) => string | null;
  /** 名牌掛點：該角色頭頂的世界座標 */
  anchorOf: (id: string, out: THREE.Vector3) => boolean;
  /** 目前所有角色的世界包圍盒，相機用它決定要退多遠才裝得下。沒人時回傳 false */
  crewBounds: (out: THREE.Box3) => boolean;
  /** 白板外框四個角的世界座標（左上、右上、右下、左下），名牌避讓用 */
  boardCorners: () => THREE.Vector3[];
  dispose: () => void;
};

/**
 * 角色專用的 render layer。three 的燈只會照亮「layer 有交集」的物件，
 * 所以把角色多掛一層、補光只設這一層，就能只提亮人不提亮房間。
 * 角色仍然留在 layer 0，一般的燈與相機照樣看得到他們。
 */
export const CAST_LAYER = 1;

const ROOM_W = 14;
const ROOM_D = 10;
const WALL_H = 5;

export function buildOffice(palette: ScenePalette): Office {
  const root = new THREE.Group();

  // 換主題時只改材質顏色，不重建幾何 —— 重建會讓相機視角與動畫相位整個重來
  const mats = {
    wall: new THREE.MeshStandardMaterial({ color: palette.wall, roughness: 0.95 }),
    wallSide: new THREE.MeshStandardMaterial({ color: palette.wallSide, roughness: 0.95 }),
    floor: new THREE.MeshStandardMaterial({ color: palette.floor, roughness: 0.85 }),
    rug: new THREE.MeshStandardMaterial({ color: palette.rug, roughness: 1 }),
    desk: new THREE.MeshStandardMaterial({ color: palette.desk, roughness: 0.7 }),
    metal: new THREE.MeshStandardMaterial({ color: palette.metal, roughness: 0.4, metalness: 0.3 }),
    screen: new THREE.MeshStandardMaterial({
      color: palette.screen,
      emissive: new THREE.Color(palette.screen),
      emissiveIntensity: palette.screenGlow,
      roughness: 0.3,
    }),
    windowGlass: new THREE.MeshStandardMaterial({
      color: palette.windowGlow,
      emissive: new THREE.Color(palette.windowGlow),
      emissiveIntensity: 0.8,
      roughness: 0.1,
    }),
    leaf: new THREE.MeshStandardMaterial({ color: 0x6bbf7a, roughness: 0.8 }),
    pot: new THREE.MeshStandardMaterial({ color: 0xd98b6b, roughness: 0.8 }),
    face: new THREE.MeshStandardMaterial({ color: 0xfffaf5, roughness: 0.6 }),
    ink: new THREE.MeshStandardMaterial({ color: 0x4a3b34, roughness: 0.5 }),
  };
  // 螢幕的呼吸光要在「主題定義的亮度」上下擺動，所以基準值得存起來
  mats.screen.userData.baseGlow = palette.screenGlow;

  // ---------- 房間 ----------
  const floor = new THREE.Mesh(new THREE.BoxGeometry(ROOM_W, 0.3, ROOM_D), mats.floor);
  floor.position.y = -0.15;
  floor.receiveShadow = true;
  root.add(floor);

  const backWall = new THREE.Mesh(new THREE.BoxGeometry(ROOM_W, WALL_H, 0.3), mats.wall);
  backWall.position.set(0, WALL_H / 2, -ROOM_D / 2);
  backWall.receiveShadow = true;
  root.add(backWall);

  const sideWall = new THREE.Mesh(new THREE.BoxGeometry(0.3, WALL_H, ROOM_D), mats.wallSide);
  sideWall.position.set(-ROOM_W / 2, WALL_H / 2, 0);
  sideWall.receiveShadow = true;
  root.add(sideWall);

  const rug = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.2, 0.04, 48), mats.rug);
  rug.position.set(1, 0.02, 1.8);
  rug.receiveShadow = true;
  root.add(rug);

  // 窗戶：夜間主題時它是牆上唯一的暖色，房間才不會全黑一片
  const windowGroup = new THREE.Group();
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 2.2), mats.windowGlass);
  const frameMat = mats.metal;
  windowGroup.add(glass);
  for (const [w, h, x, y] of [
    [3.7, 0.16, 0, 1.18],
    [3.7, 0.16, 0, -1.18],
    [0.16, 2.5, -1.77, 0],
    [0.16, 2.5, 1.77, 0],
    [0.1, 2.2, 0, 0],
  ] as const) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.12), frameMat);
    bar.position.set(x, y, 0.02);
    windowGroup.add(bar);
  }
  windowGroup.position.set(-3.4, 2.9, -ROOM_D / 2 + 0.17);
  root.add(windowGroup);

  // ---------- 工位 ----------
  // 桌子與人都是現場依人數長出來的：線上幾個 agent 就幾張桌子。
  const crew = new THREE.Group();
  root.add(crew);

  type Entry = {
    occupant: Occupant;
    character: Character;
    accentMat: THREE.MeshStandardMaterial;
    desk: THREE.Group | null;
    chair: THREE.Group | null;
    /** 動畫相位：每個人錯開，不然整排像同一顆彈簧 */
    phase: number;
    /** 名牌掛的高度。相鄰的人高低錯開，名牌才不會在畫面上疊成一團 */
    tagY: number;
    /** 目前所在位置（x,z）與要去的位置；update 每幀往目標走，所以進場／去茶水間都是走過去 */
    pos: THREE.Vector2;
    target: THREE.Vector2;
    /** 抵達後面向的角度 */
    homeRot: number;
    /** 目前面向；走動時朝行進方向，抵達後轉回 homeRot */
    rotY: number;
    /** 姿勢的平滑值（前傾、左右晃），避免 mood 切換時瞬間跳姿勢 */
    tiltX: number;
    /** 頭上特效：狀態圖示、能量條、冒煙。獨立於角色 group，不影響點選與取景 */
    fx: Fx;
  };

  type Fx = {
    group: THREE.Group;
    icon: THREE.Sprite;
    iconMat: THREE.SpriteMaterial;
    iconKind: string;
    barBg: THREE.Sprite;
    barFill: THREE.Sprite;
    puffs: THREE.Sprite[];
    mats: THREE.SpriteMaterial[];
  };
  const entries = new Map<string, Entry>();
  /** 這一輪 setOccupants 新來的人 id（用來決定初始位置） */
  const fresh = new Set<string>();
  const icons = new IconCache();
  const groupLabels = new Map<string, { mesh: THREE.Mesh; tex: THREE.Texture; tag: string }>();
  /** parent → transient 的連線，key 是 transient id */
  const links = new Map<string, Link>();
  let makeCharacter: CharacterFactory = () => ({ group: new THREE.Group() });

  /** 桌椅的材質全是房間共用的那幾份（accentMat 另外丟），所以這裡只清幾何 */
  function disposeGeometries(node: THREE.Object3D): void {
    node.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) mesh.geometry.dispose();
    });
  }

  /** 房間自己的材質不能丟（牆壁還在用），角色自帶的才丟 */
  function disposeEntry(e: Entry): void {
    if (e.character.dispose) {
      e.character.dispose();
    } else {
      const shared = new Set<THREE.Material>(Object.values(mats));
      e.character.group.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.geometry.dispose();
        const used = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of used) if (m && !shared.has(m) && m !== e.accentMat) m.dispose();
      });
    }
    e.accentMat.dispose();
    // 圖示貼圖是房間共用的快取，這裡只丟每個人自己的 sprite 材質
    for (const m of e.fx.mats) m.dispose();
    crew.remove(e.fx.group);
    crew.remove(e.character.group);
    // 桌椅的幾何得在這裡自己丟掉：這一步會把它們從 root 底下拔走，
    // 之後場景 teardown 的 root.traverse 就再也掃不到它們了
    if (e.desk) {
      crew.remove(e.desk);
      disposeGeometries(e.desk);
    }
    if (e.chair) {
      crew.remove(e.chair);
      disposeGeometries(e.chair);
    }
  }

  function setFactory(make: CharacterFactory): void {
    makeCharacter = make;
    // 換長相要整批重來；沿用舊的 occupant 清單
    const current = [...entries.values()].map((e) => e.occupant);
    for (const e of entries.values()) disposeEntry(e);
    entries.clear();
    setOccupants(current);
  }

  function setOccupants(list: Occupant[]): void {
    const wanted = new Set(list.map((o) => o.id));
    for (const [id, e] of entries) {
      if (!wanted.has(id)) {
        disposeEntry(e);
        entries.delete(id);
      }
    }

    for (const o of list) {
      const hit = entries.get(o.id);
      if (hit) {
        // 已經在場的人只更新狀態，不重建 —— 重建會讓動畫相位跳掉，看起來像閃爍
        hit.occupant = o;
        continue;
      }
      const accentMat = new THREE.MeshStandardMaterial({ color: o.accent, roughness: 0.55 });
      const character = makeCharacter({ id: o.id, accent: o.accent, mats, accentMat });
      character.group.userData.occupantId = o.id;
      character.group.traverse((n) => n.layers.enable(CAST_LAYER));
      crew.add(character.group);

      let desk: THREE.Group | null = null;
      let chair: THREE.Group | null = null;
      if (o.resident) {
        desk = buildDesk(mats);
        crew.add(desk);
        chair = buildChair(mats, accentMat);
        crew.add(chair);
      }
      const fx = buildFx(icons);
      crew.add(fx.group);
      entries.set(o.id, {
        occupant: o,
        character,
        accentMat,
        desk,
        chair,
        phase: hash01(o.id) * Math.PI * 2,
        tagY: 2.3,
        pos: new THREE.Vector2(),
        target: new THREE.Vector2(),
        homeRot: 0,
        rotY: 0,
        tiltX: 0,
        fx,
      });
      fresh.add(o.id);
    }

    layout(list);

    // 新來的人：resident 直接坐在位子上；transient 從 parent 的桌子附近走出來
    for (const id of fresh) {
      const e = entries.get(id);
      if (!e) continue;
      const parent = e.occupant.parent ? entries.get(e.occupant.parent) : undefined;
      e.pos.copy(parent && !e.occupant.resident ? parent.target : e.target);
      e.rotY = e.homeRot;
    }
    fresh.clear();
  }

  /**
   * 常駐沿著後牆一排（同專案相鄰，專案之間留空隙），臨時的站在地毯上圍一個弧。
   * 閒置太久的常駐改站到茶水間；回來工作時 target 變回座位，update 會讓他走回去。
   */
  function layout(list: Occupant[]): void {
    const residents = list.filter((o) => o.resident);
    const guests = list.filter((o) => !o.resident);

    const desks = layoutDesks(residents.map((o) => ({ id: o.id, cwd: o.cwd })));
    const xOf = new Map(desks.slots.map((s) => [s.id, s.x]));
    const orderOf = new Map(desks.slots.map((s, i) => [s.id, i]));

    const lounging = residents
      .filter((o) => o.lounging)
      .sort((a, b) => (orderOf.get(a.id) ?? 0) - (orderOf.get(b.id) ?? 0));

    residents.forEach((o, i) => {
      const e = entries.get(o.id);
      if (!e) return;
      const x = xOf.get(o.id) ?? 0;
      e.desk?.position.set(x, 0, -2.8);
      e.chair?.position.set(x - 0.78, 0, -1.15);
      const k = lounging.indexOf(o);
      if (k >= 0) {
        // 茶水間：咖啡機前面排成兩列
        e.target.set(LOUNGE_X - 1.0 + (k % 3) * 0.85, LOUNGE_Z + 1.15 + Math.floor(k / 3) * 0.8);
        e.homeRot = 0.25 - (k % 2) * 0.5;
      } else {
        e.target.set(x + 0.62, -0.72);
        e.homeRot = -0.22;
      }
      e.tagY = i % 2 === 0 ? 2.35 : 3.05;
    });

    guests.forEach((o, i) => {
      const e = entries.get(o.id);
      if (!e) return;
      const [x, z] = floorSpot(i, guests.length);
      e.target.set(x, z);
      // 臨時人力面向鏡頭，跟後排的常駐分得開
      e.homeRot = Math.atan2(x - 1, z - 1.8) * 0.4;
      e.tagY = i % 2 === 0 ? 2.3 : 2.85;
    });

    syncGroupLabels(desks.groups);
  }

  /** 專案牌：貼在地上、各組角色前方。組消失或改名時重畫，不留殘影 */
  function syncGroupLabels(groups: ReturnType<typeof layoutDesks>["groups"]): void {
    const live = new Set<string>();
    for (const g of groups) {
      const name = projectName(g.cwd);
      if (!g.key || !name) continue;
      live.add(g.key);
      const width = Math.max(2.6, g.x1 - g.x0 + 2.4);
      const tag = `${name}|${width.toFixed(2)}`;
      let l = groupLabels.get(g.key);
      if (l && l.tag !== tag) {
        disposeLabel(l);
        groupLabels.delete(g.key);
        l = undefined;
      }
      if (!l) {
        const { mesh, tex } = buildGroupLabel(name, width);
        mesh.rotation.x = -Math.PI / 2;
        root.add(mesh);
        l = { mesh, tex, tag };
        groupLabels.set(g.key, l);
      }
      l.mesh.position.set(g.cx + 0.3, 0.075, 0.45);
    }
    for (const [key, l] of groupLabels) {
      if (!live.has(key)) {
        disposeLabel(l);
        groupLabels.delete(key);
      }
    }
  }

  function disposeLabel(l: { mesh: THREE.Mesh; tex: THREE.Texture }): void {
    root.remove(l.mesh);
    l.mesh.geometry.dispose();
    (l.mesh.material as THREE.Material).dispose();
    l.tex.dispose();
  }

  function pick(ray: THREE.Raycaster): string | null {
    const groups = [...entries.values()].map((e) => e.character.group);
    for (const hit of ray.intersectObjects(groups, true)) {
      let node: THREE.Object3D | null = hit.object;
      while (node) {
        const id = node.userData.occupantId as string | undefined;
        if (id) return id;
        node = node.parent;
      }
    }
    return null;
  }

  function crewBounds(out: THREE.Box3): boolean {
    if (entries.size === 0) return false;
    out.makeEmpty();
    // 以「目標位置」估框而不是現在的位置：走路中的人（剛進場、去茶水間）
    // 還沒到，用當下位置取景會在他們走到定位後把人切出畫面
    for (const e of entries.values()) {
      out.expandByPoint(tmpA.set(e.target.x - 0.6, 0, e.target.y - 0.5));
      out.expandByPoint(tmpA.set(e.target.x + 0.6, 2.1, e.target.y + 0.5));
    }
    // 名牌掛在頭上，構圖要把那塊也算進去，不然名牌會頂到畫面外
    out.max.y += 1.2;
    return true;
  }

  function anchorOf(id: string, out: THREE.Vector3): boolean {
    const e = entries.get(id);
    if (!e) return false;
    out.set(0, e.tagY, 0).applyMatrix4(e.character.group.matrixWorld);
    return true;
  }

  let lastT = 0;
  const tmpA = new THREE.Vector3();
  const tmpB = new THREE.Vector3();

  /** 一個人每幀的動作：往目標走、依活動與 mood 擺姿勢、更新頭上特效 */
  function stepEntry(e: Entry, t: number, dt: number): void {
    const { activity, mood = "normal", usage } = e.occupant;
    const g = e.character.group;

    // 走路：以固定速度往 target 移動，走動時朝行進方向、到了轉回 homeRot
    const dx = e.target.x - e.pos.x;
    const dz = e.target.y - e.pos.y;
    const dist = Math.hypot(dx, dz);
    const walking = dist > 0.04;
    if (walking) {
      const stepLen = Math.min(dist, WALK_SPEED * dt);
      e.pos.x += (dx / dist) * stepLen;
      e.pos.y += (dz / dist) * stepLen;
    }
    const wantRot = walking ? Math.atan2(dx, dz) : e.homeRot;
    e.rotY += angleDiff(e.rotY, wantRot) * Math.min(1, dt * (walking ? 10 : 6));

    // 浮動：在工作的人晃得比較勤；下班的沉下去不動 —— 不靠文字就看得出狀態的線索
    let amp = activity === "working" ? 0.075 : activity === "idle" ? 0.045 : 0;
    let speed = activity === "working" ? 2.4 : 1.4;
    let base = activity === "offline" ? -0.02 : 0.06;
    let hop = 0;
    let wiggle = 0;
    let tiltTarget = 0;
    if (walking) {
      // 走路：小碎步彈跳
      amp = 0.09;
      speed = 11;
    } else if (mood === "permission") {
      // 舉手求救：用力蹦蹦跳＋左右搖
      hop = Math.abs(Math.sin(t * 5.5 + e.phase)) * 0.26;
      wiggle = Math.sin(t * 11 + e.phase) * 0.07;
      amp = 0;
    } else if (mood === "input") {
      wiggle = Math.sin(t * 2.2 + e.phase) * 0.08;
      hop = Math.max(0, Math.sin(t * 2.2 + e.phase)) * 0.06;
    } else if (mood === "error") {
      // 沮喪：垂頭、微微發抖、沉下去一點
      tiltTarget = 0.2;
      wiggle = Math.sin(t * 28) * 0.025;
      amp = 0.015;
      base = 0;
    } else if (mood === "stalled") {
      // 趴下去：大幅前傾、幾乎不動
      tiltTarget = 0.55;
      amp = 0.01;
      base = -0.03;
    }
    e.tiltX += (tiltTarget - e.tiltX) * Math.min(1, dt * 5);

    g.position.set(e.pos.x, Math.sin(t * speed + e.phase) * amp + base + hop, e.pos.y);
    g.rotation.set(e.tiltX, e.rotY, wiggle);
    if (activity !== "offline") e.character.update?.(t + e.phase);
    e.chair?.rotation.set(0, Math.sin(t * 0.5 + e.phase) * 0.18, 0);

    updateFx(e, mood, usage, t);
  }

  const ICON_FOR: Record<Mood, string | null> = {
    normal: null,
    permission: "permission",
    input: "input",
    error: "error",
    stalled: "stalled",
  };

  /** 頭上的圖示、能量條與冒煙 */
  function updateFx(e: Entry, mood: Mood, usage: number | undefined, t: number): void {
    const fx = e.fx;
    fx.group.position.set(e.pos.x, 0, e.pos.y);
    const kind = ICON_FOR[mood];
    if (kind !== null && kind !== fx.iconKind) {
      fx.iconKind = kind;
      fx.iconMat.map = icons.get(kind);
      fx.iconMat.needsUpdate = true;
    }
    fx.icon.visible = kind !== null;
    if (kind !== null) {
      const bob = Math.sin(t * 3 + e.phase) * 0.06;
      // 求救的圖示脈動放大，提醒度最高
      const pulse = mood === "permission" ? 1 + Math.sin(t * 9) * 0.12 : 1;
      fx.icon.position.set(0.55, 2.05 + bob, 0.1);
      fx.icon.scale.setScalar((mood === "stalled" ? 0.85 : 0.62) * pulse);
    }

    // 能量條：沒有 usage 就整條藏起來；超過 80% 變紅
    const show = usage !== undefined && e.occupant.activity !== "offline";
    fx.barBg.visible = show;
    fx.barFill.visible = show;
    if (show) {
      const r = Math.min(1, Math.max(0, usage));
      fx.barFill.scale.x = Math.max(0.001, BAR_W * r);
      (fx.barFill.material as THREE.SpriteMaterial).color.setHex(
        r > 0.8 ? 0xff5a4a : r > 0.6 ? 0xffb23d : 0x5ccf8a,
      );
    }

    // 冒煙：三團灰煙輪流上升淡出
    const smoking = mood === "error";
    fx.puffs.forEach((p, i) => {
      p.visible = smoking;
      if (!smoking) return;
      const k = (t * 0.55 + i / fx.puffs.length) % 1;
      p.position.set(-0.12 + Math.sin(k * 6 + i) * 0.14, 1.95 + k * 0.7, -0.05);
      p.scale.setScalar(0.22 + k * 0.3);
      (p.material as THREE.SpriteMaterial).opacity = (1 - k) * 0.75;
    });
  }

  // ---------- parent → subagent 連線 ----------
  function disposeLink(l: Link): void {
    root.remove(l.line);
    l.line.geometry.dispose();
    (l.line.material as THREE.Material).dispose();
  }

  /** 有 parent 的 transient 與 parent 之間拉一條弧形虛線；working 時虛線流動 */
  function updateLinks(t: number, dt: number): void {
    const wanted = new Set<string>();
    for (const e of entries.values()) {
      const pid = e.occupant.parent;
      const parent = pid ? entries.get(pid) : undefined;
      if (!parent || e.occupant.resident) continue;
      wanted.add(e.occupant.id);
      let l = links.get(e.occupant.id);
      if (!l) {
        l = buildLink(e.occupant.accent);
        root.add(l.line);
        links.set(e.occupant.id, l);
      }
      tmpA.set(parent.pos.x, 1.55, parent.pos.y);
      tmpB.set(e.pos.x, 1.35, e.pos.y);
      const arr = l.positions;
      for (let i = 0; i <= LINK_SEGS; i++) {
        const k = i / LINK_SEGS;
        // 中點往上拱，連線才不會貼著地板穿過別人
        arr[i * 3] = tmpA.x + (tmpB.x - tmpA.x) * k;
        arr[i * 3 + 1] = tmpA.y + (tmpB.y - tmpA.y) * k + Math.sin(k * Math.PI) * 0.7;
        arr[i * 3 + 2] = tmpA.z + (tmpB.z - tmpA.z) * k;
      }
      (l.line.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
      l.line.computeLineDistances();
      const working = e.occupant.activity === "working";
      const mat = l.line.material as THREE.LineDashedMaterial;
      if (working) mat.dashOffset -= dt * 0.9;
      mat.opacity = working ? 0.6 + Math.sin(t * 5) * 0.2 : 0.3;
    }
    for (const [id, l] of links) {
      if (!wanted.has(id)) {
        disposeLink(l);
        links.delete(id);
      }
    }
  }

  // ---------- 擺設 ----------
  // 盆栽放兩側角落 —— 放中間會正好擋在工位跟相機之間
  const plant = buildPlant(mats);
  plant.position.set(6.0, 0, -3.4);
  root.add(plant);

  const plant2 = buildPlant(mats);
  plant2.position.set(-5.9, 0, -2.4);
  plant2.scale.setScalar(0.78);
  root.add(plant2);

  // 茶水間：右前方一個獨立小吧台，閒置太久的人會走來這邊待著
  const lounge = buildLounge();
  lounge.group.position.set(LOUNGE_X, 0, LOUNGE_Z);
  root.add(lounge.group);

  // 白板：今日 token 與估算成本，貼在後牆右側
  const board = buildBoard();
  board.group.position.set(3.7, 3.3, -ROOM_D / 2 + 0.2);
  root.add(board.group);

  /** 天空色覆寫：日夜循環要蓋過主題的窗光；null＝回到主題原色 */
  let skyOverride: number | null = null;
  let themeWindow = palette.windowGlow;
  function paintWindow(): void {
    const c = skyOverride ?? themeWindow;
    mats.windowGlass.color.setHex(c);
    mats.windowGlass.emissive.setHex(c);
  }

  return {
    root,
    setFactory,
    setOccupants,
    pick,
    anchorOf,
    crewBounds,
    boardCorners: () => {
      board.group.updateMatrixWorld(true);
      return [[-1.8, 1.1], [1.8, 1.1], [1.8, -1.1], [-1.8, -1.1]].map(([x, y]) =>
        new THREE.Vector3(x, y, 0).applyMatrix4(board.group.matrixWorld),
      );
    },
    setBoard: (d) => board.draw(d),
    setSky(hex) {
      skyOverride = hex;
      paintWindow();
    },
    update(t) {
      const dt = Math.min(0.1, Math.max(0, t - lastT));
      lastT = t;
      for (const e of entries.values()) stepEntry(e, t, dt);
      updateLinks(t, dt);
      const glow = mats.screen.userData.baseGlow as number;
      mats.screen.emissiveIntensity = glow * (0.88 + Math.sin(t * 2.4) * 0.12);
    },
    dispose() {
      for (const e of entries.values()) disposeEntry(e);
      entries.clear();
      for (const l of links.values()) disposeLink(l);
      links.clear();
      for (const l of groupLabels.values()) disposeLabel(l);
      groupLabels.clear();
      icons.dispose();
      board.dispose();
      lounge.dispose();
      root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) mesh.geometry.dispose();
      });
      for (const m of Object.values(mats)) m.dispose();
    },
    applyPalette(p) {
      mats.wall.color.setHex(p.wall);
      mats.wallSide.color.setHex(p.wallSide);
      mats.floor.color.setHex(p.floor);
      mats.rug.color.setHex(p.rug);
      mats.desk.color.setHex(p.desk);
      mats.metal.color.setHex(p.metal);
      mats.screen.color.setHex(p.screen);
      mats.screen.emissive.setHex(p.screen);
      mats.screen.userData.baseGlow = p.screenGlow;
      themeWindow = p.windowGlow;
      paintWindow();
    },
  };
}

// ---------- 茶水間 / 走路 / 特效的常數 ----------
/** 茶水間吧台的位置（房間右前方，不擋後排工位） */
const LOUNGE_X = 5.4;
const LOUNGE_Z = -0.1;
/** 走路速度（單位／秒） */
const WALK_SPEED = 2.2;
/** 能量條滿格寬度 */
const BAR_W = 0.8;
const LINK_SEGS = 20;

/** 兩個角度之間最短的差（弧度），用來平滑轉身 */
function angleDiff(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

const UI_FONT = '"Baloo 2", "Nunito", "Microsoft JhengHei", "PingFang TC", sans-serif';

function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  return [c, ctx];
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function toTexture(c: HTMLCanvasElement): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** 頭上圖示的貼圖快取：每種只畫一次，整個房間共用 */
class IconCache {
  private map = new Map<string, THREE.CanvasTexture>();

  get(kind: string): THREE.CanvasTexture {
    let t = this.map.get(kind);
    if (!t) {
      t = toTexture(drawIcon(kind));
      this.map.set(kind, t);
    }
    return t;
  }

  dispose(): void {
    for (const t of this.map.values()) t.dispose();
    this.map.clear();
  }
}

function drawIcon(kind: string): HTMLCanvasElement {
  const S = 128;
  const [c, ctx] = makeCanvas(S, S);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  if (kind === "permission") {
    // 醒目的紅橘圓章＋白色驚嘆號
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(64, 64, 58, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#ff5a3c";
    ctx.beginPath();
    ctx.arc(64, 64, 50, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.font = `700 88px ${UI_FONT}`;
    ctx.fillText("!", 64, 70);
  } else if (kind === "input") {
    // 溫和的藍色對話泡泡＋三個點
    ctx.fillStyle = "#fff";
    roundRect(ctx, 8, 14, 112, 76, 30);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(34, 84);
    ctx.lineTo(28, 118);
    ctx.lineTo(62, 88);
    ctx.fill();
    ctx.strokeStyle = "#5aa9ff";
    ctx.lineWidth = 6;
    roundRect(ctx, 10, 16, 108, 72, 28);
    ctx.stroke();
    ctx.fillStyle = "#5aa9ff";
    for (const x of [38, 64, 90]) {
      ctx.beginPath();
      ctx.arc(x, 52, 8, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (kind === "error") {
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(64, 64, 58, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#c63d3d";
    ctx.beginPath();
    ctx.arc(64, 64, 50, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 12;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(44, 44);
    ctx.lineTo(84, 84);
    ctx.moveTo(84, 44);
    ctx.lineTo(44, 84);
    ctx.stroke();
  } else if (kind === "stalled") {
    // 黃色標牌＋zzz
    ctx.fillStyle = "#fff";
    roundRect(ctx, 4, 24, 120, 80, 28);
    ctx.fill();
    ctx.fillStyle = "#ffc83d";
    roundRect(ctx, 10, 30, 108, 68, 24);
    ctx.fill();
    ctx.fillStyle = "#6b4a12";
    ctx.font = `700 52px ${UI_FONT}`;
    ctx.fillText("zzz…", 64, 66);
  } else {
    // puff：柔邊灰煙團
    const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 60);
    g.addColorStop(0, "rgba(90,84,96,0.95)");
    g.addColorStop(1, "rgba(90,84,96,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
  }
  return c;
}

/** 頭上特效：狀態圖示、context 能量條、冒煙。全是 sprite，永遠面向鏡頭 */
function buildFx(icons: IconCache): {
  group: THREE.Group;
  icon: THREE.Sprite;
  iconMat: THREE.SpriteMaterial;
  iconKind: string;
  barBg: THREE.Sprite;
  barFill: THREE.Sprite;
  puffs: THREE.Sprite[];
  mats: THREE.SpriteMaterial[];
} {
  const group = new THREE.Group();
  const mats: THREE.SpriteMaterial[] = [];
  const mk = (opts: THREE.SpriteMaterialParameters): THREE.SpriteMaterial => {
    const m = new THREE.SpriteMaterial({ transparent: true, depthWrite: false, fog: false, ...opts });
    mats.push(m);
    return m;
  };

  const iconMat = mk({ depthTest: false });
  const icon = new THREE.Sprite(iconMat);
  icon.renderOrder = 20;
  icon.visible = false;
  group.add(icon);

  const barBg = new THREE.Sprite(mk({ color: 0x3a2f2a, opacity: 0.6, depthTest: false }));
  barBg.center.set(0, 0.5);
  barBg.position.set(-BAR_W / 2 - 0.03, 2.3, 0);
  barBg.scale.set(BAR_W + 0.06, 0.13, 1);
  barBg.renderOrder = 18;
  barBg.visible = false;
  group.add(barBg);

  const barFill = new THREE.Sprite(mk({ color: 0x5ccf8a, depthTest: false }));
  barFill.center.set(0, 0.5);
  barFill.position.set(-BAR_W / 2, 2.3, 0.01);
  barFill.scale.set(BAR_W, 0.08, 1);
  barFill.renderOrder = 19;
  barFill.visible = false;
  group.add(barFill);

  const puffs: THREE.Sprite[] = [];
  for (let i = 0; i < 3; i++) {
    const p = new THREE.Sprite(mk({ map: icons.get("puff"), depthTest: false }));
    p.renderOrder = 17;
    p.visible = false;
    group.add(p);
    puffs.push(p);
  }
  return { group, icon, iconMat, iconKind: "", barBg, barFill, puffs, mats };
}

type Link = { line: THREE.Line; positions: Float32Array };

function buildLink(accent: number): Link {
  const positions = new Float32Array((LINK_SEGS + 1) * 3);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.LineDashedMaterial({
    color: accent,
    dashSize: 0.16,
    gapSize: 0.12,
    transparent: true,
    opacity: 0.6,
    depthWrite: false,
  });
  const line = new THREE.Line(geo, mat);
  // 頂點每幀都在動，內建的包圍球會過期，直接關掉裁切
  line.frustumCulled = false;
  return { line, positions };
}

/** 地上的專案牌 */
function buildGroupLabel(name: string, width: number): { mesh: THREE.Mesh; tex: THREE.CanvasTexture } {
  const H = 0.55;
  const [c, ctx] = makeCanvas(Math.round(width * 200), Math.round(H * 200));
  ctx.fillStyle = "rgba(255,250,245,0.9)";
  roundRect(ctx, 4, 4, c.width - 8, c.height - 8, 30);
  ctx.fill();
  ctx.strokeStyle = "#e8a98a";
  ctx.lineWidth = 6;
  ctx.stroke();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#4a3b34";
  let size = 56;
  ctx.font = `700 ${size}px ${UI_FONT}`;
  while (ctx.measureText(name).width > c.width - 70 && size > 20) {
    size -= 4;
    ctx.font = `700 ${size}px ${UI_FONT}`;
  }
  ctx.fillText(name, c.width / 2, c.height / 2 + 3);
  const tex = toTexture(c);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width, H),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }),
  );
  return { mesh, tex };
}

/** 茶水間：吧台＋咖啡機＋腳墊＋招牌 */
function buildLounge(): { group: THREE.Group; dispose: () => void } {
  const group = new THREE.Group();
  const own: THREE.Material[] = [];
  const mat = (color: number, extra: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial => {
    const m = new THREE.MeshStandardMaterial({ color, roughness: 0.7, ...extra });
    own.push(m);
    return m;
  };
  const wood = mat(0xc9a07c);
  const top = mat(0xf2ebe4);
  const red = mat(0xd96a5b, { roughness: 0.4 });
  const dark = mat(0x3d3540, { roughness: 0.5 });
  const cup = mat(0xfffaf5);
  const mat2 = mat(0xffd9c0, { roughness: 1 });

  const add = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number): THREE.Mesh => {
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };
  add(new THREE.BoxGeometry(2.0, 0.95, 0.8), wood, 0, 0.475, 0);
  add(new THREE.BoxGeometry(2.1, 0.07, 0.9), top, 0, 0.985, 0);
  // 咖啡機
  add(new THREE.BoxGeometry(0.56, 0.7, 0.46), red, -0.45, 1.37, -0.05);
  add(new THREE.BoxGeometry(0.62, 0.1, 0.5), dark, -0.45, 1.77, -0.05);
  add(new THREE.BoxGeometry(0.34, 0.07, 0.1), dark, -0.45, 1.33, 0.2);
  add(new THREE.CylinderGeometry(0.1, 0.08, 0.17, 14), cup, -0.45, 1.1, 0.22);
  // 桌上的杯子
  add(new THREE.CylinderGeometry(0.09, 0.07, 0.15, 14), cup, 0.25, 1.1, 0.1);
  add(new THREE.CylinderGeometry(0.09, 0.07, 0.15, 14), cup, 0.55, 1.1, -0.1);
  // 腳墊：人站的地方
  const pad = add(new THREE.CylinderGeometry(1.35, 1.35, 0.03, 32), mat2, -0.1, 0.015, 1.25);
  pad.castShadow = false;

  const [c, ctx] = makeCanvas(320, 96);
  ctx.fillStyle = "#fffaf5";
  roundRect(ctx, 4, 4, 312, 88, 24);
  ctx.fill();
  ctx.strokeStyle = "#d9a07c";
  ctx.lineWidth = 6;
  ctx.stroke();
  ctx.fillStyle = "#4a3b34";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `700 50px ${UI_FONT}`;
  ctx.fillText("茶水間", 160, 52);
  const tex = toTexture(c);
  const signMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true });
  own.push(signMat);
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.36), signMat);
  sign.position.set(0.1, 0.55, 0.405);
  group.add(sign);

  return {
    group,
    dispose() {
      group.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) mesh.geometry.dispose();
      });
      for (const m of own) m.dispose();
      tex.dispose();
    },
  };
}

/** 白板：CanvasTexture 畫今日 token 與估算成本，draw() 可重複呼叫 */
function buildBoard(): { group: THREE.Group; draw: (d: BoardData) => void; dispose: () => void } {
  const group = new THREE.Group();
  const W = 768;
  const H = 440;
  const [canvas, ctx] = makeCanvas(W, H);
  const tex = toTexture(canvas);

  const frameMat = new THREE.MeshStandardMaterial({ color: 0xb9a89c, roughness: 0.5, metalness: 0.3 });
  const faceMat = new THREE.MeshStandardMaterial({
    map: tex,
    roughness: 0.85,
    // 夜裡房間暗，白板還是要看得清楚：自發光吃同一張貼圖
    emissive: new THREE.Color(0xffffff),
    emissiveMap: tex,
    emissiveIntensity: 0.28,
  });
  const frame = new THREE.Mesh(new THREE.BoxGeometry(3.6, 2.2, 0.1), frameMat);
  frame.castShadow = true;
  group.add(frame);
  const face = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 2.0), faceMat);
  face.position.z = 0.06;
  group.add(face);
  const tray = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.07, 0.16), frameMat);
  tray.position.set(0, -1.14, 0.1);
  group.add(tray);

  function draw(d: BoardData): void {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#fffdf8";
    ctx.fillRect(0, 0, W, H);
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    ctx.fillStyle = "#ff8a6b";
    ctx.font = `700 46px ${UI_FONT}`;
    ctx.fillText("今日用量", 40, 76);
    ctx.fillStyle = "#b9a89c";
    ctx.font = `600 24px ${UI_FONT}`;
    ctx.fillText("估算值", 200, 74);
    ctx.fillStyle = "#e8d9cc";
    ctx.fillRect(40, 96, W - 80, 4);

    if (d.state !== "ok") {
      ctx.fillStyle = "#8a756a";
      ctx.font = `700 48px ${UI_FONT}`;
      ctx.textAlign = "center";
      ctx.fillText(d.state === "loading" ? "讀取中…" : "讀不到", W / 2, 260);
    } else {
      const total = d.input + d.output + d.cacheRead + d.cacheCreation;
      ctx.fillStyle = "#4a3b34";
      ctx.font = `700 120px ${UI_FONT}`;
      ctx.fillText(fmtTokens(total), 40, 220);
      const w = ctx.measureText(fmtTokens(total)).width;
      ctx.fillStyle = "#8a756a";
      ctx.font = `600 34px ${UI_FONT}`;
      ctx.fillText("tokens", 56 + w, 220);

      ctx.fillStyle = "#2f9c8a";
      ctx.font = `700 64px ${UI_FONT}`;
      ctx.fillText(fmtUsd(d.costUsd), 40, 304);
      const costW = ctx.measureText(fmtUsd(d.costUsd)).width;
      ctx.fillStyle = "#8a756a";
      ctx.font = `600 28px ${UI_FONT}`;
      ctx.fillText("估算成本", 56 + costW, 302);

      const rows: [string, number, string][] = [
        ["輸入", d.input, "#ff8a6b"],
        ["輸出", d.output, "#4bb8a9"],
        ["快取讀", d.cacheRead, "#7aa7ff"],
        ["快取寫", d.cacheCreation, "#c79bff"],
      ];
      rows.forEach(([label, n, color], i) => {
        const x = 40 + i * 176;
        ctx.fillStyle = color;
        ctx.fillRect(x, 340, 150, 8);
        ctx.fillStyle = "#8a756a";
        ctx.font = `600 24px ${UI_FONT}`;
        ctx.fillText(label, x, 380);
        ctx.fillStyle = "#4a3b34";
        ctx.font = `700 34px ${UI_FONT}`;
        ctx.fillText(fmtTokens(n), x, 418);
      });
    }
    tex.needsUpdate = true;
  }
  draw({ state: "loading" });

  return {
    group,
    draw,
    dispose() {
      frame.geometry.dispose();
      face.geometry.dispose();
      tray.geometry.dispose();
      frameMat.dispose();
      faceMat.dispose();
      tex.dispose();
    },
  };
}

/** 臨時人力站在地毯前緣的弧線上，不佔工位也不擋住後排 */
function floorSpot(i: number, n: number): [number, number] {
  const t = n > 1 ? i / (n - 1) : 0.5;
  const a = Math.PI * (0.16 + 0.68 * t);
  return [1 + Math.cos(a) * 3.0, 1.8 + Math.sin(a) * 1.25];
}

/** id → 0..1 的穩定值，用來錯開動畫相位；同一個 agent 每次都拿到同一個相位 */
function hash01(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000) / 1000;
}

function buildDesk(mats: Record<string, THREE.MeshStandardMaterial>): THREE.Group {
  const g = new THREE.Group();

  const top = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.12, 1.3), mats.desk);
  top.position.y = 0.78;
  top.castShadow = true;
  top.receiveShadow = true;
  g.add(top);

  for (const [dx, dz] of [
    [-1.15, -0.5],
    [1.15, -0.5],
    [-1.15, 0.5],
    [1.15, 0.5],
  ] as const) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.78, 12), mats.metal);
    leg.position.set(dx, 0.39, dz);
    leg.castShadow = true;
    g.add(leg);
  }

  const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.16, 0.28, 16), mats.metal);
  stand.position.set(0, 0.98, -0.3);
  g.add(stand);

  const bezel = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.92, 0.08), mats.metal);
  bezel.position.set(0, 1.58, -0.3);
  bezel.castShadow = true;
  g.add(bezel);

  const screen = new THREE.Mesh(new THREE.PlaneGeometry(1.36, 0.78), mats.screen);
  screen.position.set(0, 1.58, -0.25);
  g.add(screen);

  const keyboard = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.05, 0.32), mats.metal);
  keyboard.position.set(0, 0.87, 0.25);
  g.add(keyboard);

  const mug = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.09, 0.22, 16), mats.face);
  mug.position.set(0.95, 0.95, 0.2);
  mug.castShadow = true;
  g.add(mug);

  return g;
}

function buildChair(
  mats: Record<string, THREE.MeshStandardMaterial>,
  accent: THREE.MeshStandardMaterial,
): THREE.Group {
  const g = new THREE.Group();

  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.12, 0.68), accent);
  seat.position.y = 0.52;
  seat.castShadow = true;
  g.add(seat);

  const back = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.7, 0.12), accent);
  back.position.set(0, 0.9, -0.3);
  back.castShadow = true;
  g.add(back);

  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.46, 12), mats.metal);
  post.position.y = 0.25;
  g.add(post);

  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.46, 0.07, 5), mats.metal);
  base.position.y = 0.05;
  base.castShadow = true;
  g.add(base);

  return g;
}

function buildPlant(mats: Record<string, THREE.MeshStandardMaterial>): THREE.Group {
  const g = new THREE.Group();

  const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.26, 0.5, 18), mats.pot);
  pot.position.y = 0.25;
  pot.castShadow = true;
  g.add(pot);

  const leaves: [number, number, number, number][] = [
    [0, 0.95, 0, 0.46],
    [-0.3, 0.78, 0.12, 0.34],
    [0.28, 0.82, -0.1, 0.3],
    [0.05, 1.28, 0.05, 0.28],
  ];
  for (const [x, y, z, r] of leaves) {
    const leaf = new THREE.Mesh(new THREE.SphereGeometry(r, 18, 14), mats.leaf);
    leaf.position.set(x, y, z);
    leaf.scale.set(1, 1.25, 1);
    leaf.castShadow = true;
    g.add(leaf);
  }

  return g;
}
