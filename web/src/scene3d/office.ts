import * as THREE from "three";
import { type ScenePalette } from "./palette";
import { type Character, type CharacterMats } from "./characters";

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
  /** 每幀更新：角色浮動、椅子微轉、螢幕呼吸光 */
  update: (elapsed: number) => void;
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
  };
  const entries = new Map<string, Entry>();
  let makeCharacter: CharacterFactory = () => ({ group: new THREE.Group() });

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
    crew.remove(e.character.group);
    if (e.desk) crew.remove(e.desk);
    if (e.chair) crew.remove(e.chair);
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
      entries.set(o.id, {
        occupant: o,
        character,
        accentMat,
        desk,
        chair,
        phase: hash01(o.id) * Math.PI * 2,
        tagY: 2.3,
      });
    }

    layout(list);
  }

  /** 常駐沿著後牆一排，臨時的站在地毯上圍一個弧 */
  function layout(list: Occupant[]): void {
    const residents = list.filter((o) => o.resident);
    const guests = list.filter((o) => !o.resident);

    residents.forEach((o, i) => {
      const e = entries.get(o.id);
      if (!e) return;
      const x = deskX(i, residents.length);
      e.desk?.position.set(x, 0, -2.8);
      e.chair?.position.set(x - 0.78, 0, -1.15);
      e.character.group.position.set(x + 0.62, 0, -0.72);
      e.character.group.rotation.y = -0.22;
      e.tagY = i % 2 === 0 ? 2.35 : 3.05;
    });

    guests.forEach((o, i) => {
      const e = entries.get(o.id);
      if (!e) return;
      const [x, z] = floorSpot(i, guests.length);
      e.character.group.position.set(x, 0, z);
      // 臨時人力面向鏡頭，跟後排的常駐分得開
      e.character.group.rotation.y = Math.atan2(x - 1, z - 1.8) * 0.4;
      e.tagY = i % 2 === 0 ? 2.3 : 2.85;
    });
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
    root.updateMatrixWorld(true);
    out.makeEmpty();
    for (const e of entries.values()) out.expandByObject(e.character.group);
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

  // ---------- 擺設 ----------
  // 盆栽放兩側角落 —— 放中間會正好擋在工位跟相機之間
  const plant = buildPlant(mats);
  plant.position.set(6.0, 0, -3.4);
  root.add(plant);

  const plant2 = buildPlant(mats);
  plant2.position.set(-5.9, 0, -2.4);
  plant2.scale.setScalar(0.78);
  root.add(plant2);

  return {
    root,
    setFactory,
    setOccupants,
    pick,
    anchorOf,
    crewBounds,
    update(t) {
      for (const e of entries.values()) {
        const { activity } = e.occupant;
        // 在工作的人晃得比較勤；下班的沉下去不動 —— 這是唯一不靠文字就看得出狀態的線索
        const amp = activity === "working" ? 0.075 : activity === "idle" ? 0.045 : 0;
        const speed = activity === "working" ? 2.4 : 1.4;
        const base = activity === "offline" ? -0.02 : 0.06;
        e.character.group.position.y = Math.sin(t * speed + e.phase) * amp + base;
        if (activity !== "offline") {
          e.character.update?.(t + e.phase);
        }
        e.chair?.rotation.set(0, Math.sin(t * 0.5 + e.phase) * 0.18, 0);
      }
      const glow = mats.screen.userData.baseGlow as number;
      mats.screen.emissiveIntensity = glow * (0.88 + Math.sin(t * 2.4) * 0.12);
    },
    dispose() {
      for (const e of entries.values()) disposeEntry(e);
      entries.clear();
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
      mats.windowGlass.color.setHex(p.windowGlow);
      mats.windowGlass.emissive.setHex(p.windowGlow);
    },
  };
}

/** 桌子沿後牆均分。人多就靠攏，但不會擠出房間 */
function deskX(i: number, n: number): number {
  if (n <= 1) return 0;
  const span = Math.min(2.95 * (n - 1), ROOM_W - 3.6);
  return -span / 2 + (i * span) / (n - 1);
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
