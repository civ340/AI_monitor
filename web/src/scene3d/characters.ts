import * as THREE from "three";

/**
 * 角色種類庫。每種都吃同一組共用材質 + 該 agent 的 accent 色，
 * 換種類時場景其他東西一律不動，才能真的拿來比較長相。
 *
 * 共同約束：站在原點、腳貼地（y=0）、高度約 2、正面朝 +Z，
 * 這樣 office.ts 擺位與浮動動畫對每一種都成立。
 */

export type CharacterMats = {
  face: THREE.MeshStandardMaterial;
  ink: THREE.MeshStandardMaterial;
  metal: THREE.MeshStandardMaterial;
};

export type Character = {
  group: THREE.Group;
  /** 種類自己的小動作（尾巴、耳朵…）；共通的上下浮動由 office 統一處理 */
  update?: (t: number) => void;
  /**
   * 自己收拾 GPU 資源。沒給的話 office 會用預設做法（丟幾何 + 非共用材質），
   * 那對「材質是模組層快取、跨角色共用」的實作（動漫角色）會誤刪別人的東西。
   */
  dispose?: () => void;
};

export type CharacterKind = {
  id: string;
  label: string;
  build: (mats: CharacterMats, accent: THREE.MeshStandardMaterial) => Character;
};

export const CHARACTER_KINDS: CharacterKind[] = [
  { id: "capsule", label: "🧑 膠囊同事", build: buildCapsule },
  { id: "cat", label: "🐱 貓咪", build: buildCat },
  { id: "robot", label: "🤖 方塊機器人", build: buildRobot },
  { id: "blob", label: "👻 史萊姆", build: buildBlob },
  { id: "bird", label: "🐧 圓企鵝", build: buildBird },
];

/** 兩顆黑眼珠 —— 每種角色都要，位置與大小才是差別 */
function addEyes(
  g: THREE.Object3D,
  mats: CharacterMats,
  y: number,
  z: number,
  dx: number,
  r: number,
): void {
  for (const sx of [-dx, dx]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(r, 14, 12), mats.ink);
    eye.position.set(sx, y, z);
    g.add(eye);
  }
}

/** 微笑：半圈甜甜圈，比畫一條線有立體感 */
function addSmile(g: THREE.Object3D, mats: CharacterMats, y: number, z: number, r: number): void {
  const mouth = new THREE.Mesh(new THREE.TorusGeometry(r, r * 0.26, 8, 20, Math.PI), mats.ink);
  mouth.position.set(0, y, z);
  mouth.rotation.z = Math.PI;
  g.add(mouth);
}

/** 狀態燈天線：之後要接 agent 的 busy / idle 就靠這顆燈 */
function addAntenna(
  g: THREE.Group,
  mats: CharacterMats,
  accent: THREE.MeshStandardMaterial,
  y: number,
): THREE.Mesh {
  const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.26, 8), mats.metal);
  rod.position.y = y;
  g.add(rod);
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.08, 14, 12), accent);
  bulb.position.y = y + 0.15;
  g.add(bulb);
  return bulb;
}

// ---------- 膠囊同事（原本那隻） ----------
function buildCapsule(mats: CharacterMats, accent: THREE.MeshStandardMaterial): Character {
  const g = new THREE.Group();

  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.34, 0.5, 6, 20), accent);
  body.position.y = 0.62;
  body.castShadow = true;
  g.add(body);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.4, 28, 20), mats.face);
  head.position.y = 1.42;
  head.castShadow = true;
  g.add(head);

  addEyes(g, mats, 1.46, 0.36, 0.14, 0.052);
  addSmile(g, mats, 1.34, 0.37, 0.07);
  addAntenna(g, mats, accent, 1.9);

  for (const dx of [-0.42, 0.42]) {
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.09, 0.28, 4, 12), accent);
    arm.position.set(dx, 0.66, 0.02);
    arm.rotation.z = dx > 0 ? -0.3 : 0.3;
    arm.castShadow = true;
    g.add(arm);
  }

  return { group: g };
}

// ---------- 貓咪 ----------
function buildCat(mats: CharacterMats, accent: THREE.MeshStandardMaterial): Character {
  const g = new THREE.Group();

  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.36, 0.34, 6, 20), accent);
  body.position.y = 0.55;
  body.scale.set(1, 1, 0.88);
  body.castShadow = true;
  g.add(body);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.42, 28, 20), accent);
  head.position.y = 1.32;
  head.scale.set(1, 0.92, 0.95);
  head.castShadow = true;
  g.add(head);

  // 臉是淺色的一小塊，不然深色貓看不出五官
  const muzzle = new THREE.Mesh(new THREE.SphereGeometry(0.2, 20, 16), mats.face);
  muzzle.position.set(0, 1.2, 0.32);
  muzzle.scale.set(1.2, 0.8, 0.6);
  g.add(muzzle);

  const ears = new THREE.Group();
  for (const dx of [-0.24, 0.24]) {
    const ear = new THREE.Mesh(new THREE.ConeGeometry(0.15, 0.28, 4), accent);
    ear.position.set(dx, 1.66, 0);
    ear.rotation.y = Math.PI / 4;
    ear.rotation.z = dx > 0 ? -0.2 : 0.2;
    ear.castShadow = true;
    ears.add(ear);
  }
  g.add(ears);

  addEyes(g, mats, 1.38, 0.35, 0.17, 0.058);

  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.06, 4), mats.ink);
  nose.position.set(0, 1.22, 0.48);
  nose.rotation.x = Math.PI / 2;
  g.add(nose);

  for (const dx of [-0.3, 0.3]) {
    for (const dy of [1.16, 1.24]) {
      const whisker = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.3, 6), mats.ink);
      whisker.position.set(dx, dy, 0.4);
      whisker.rotation.z = Math.PI / 2;
      g.add(whisker);
    }
  }

  for (const dx of [-0.36, 0.36]) {
    const paw = new THREE.Mesh(new THREE.SphereGeometry(0.14, 16, 12), mats.face);
    paw.position.set(dx, 0.42, 0.16);
    paw.castShadow = true;
    g.add(paw);
  }

  // 尾巴分段，才能像鞭子一樣一節一節甩
  const tail = new THREE.Group();
  const segments: THREE.Mesh[] = [];
  let parent: THREE.Object3D = tail;
  for (let i = 0; i < 5; i++) {
    const seg = new THREE.Mesh(new THREE.CapsuleGeometry(0.075 - i * 0.008, 0.16, 4, 10), accent);
    seg.position.y = i === 0 ? 0 : 0.22;
    seg.castShadow = true;
    parent.add(seg);
    segments.push(seg);
    parent = seg;
  }
  tail.position.set(0, 0.5, -0.34);
  tail.rotation.x = 0.5;
  g.add(tail);

  return {
    group: g,
    update(t) {
      segments.forEach((seg, i) => {
        seg.rotation.z = Math.sin(t * 2.2 - i * 0.5) * 0.22;
      });
      ears.children.forEach((ear, i) => {
        // 偶爾抖一下耳朵：連續擺動看起來像壞掉，用 pow 壓成間歇的抽動
        ear.rotation.x = Math.pow(Math.max(0, Math.sin(t * 0.9 + i)), 12) * -0.5;
      });
    },
  };
}

// ---------- 方塊機器人 ----------
function buildRobot(mats: CharacterMats, accent: THREE.MeshStandardMaterial): Character {
  const g = new THREE.Group();

  const body = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.8, 0.5), accent);
  body.position.y = 0.86;
  body.castShadow = true;
  g.add(body);

  const panel = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.3, 0.06), mats.metal);
  panel.position.set(0, 0.86, 0.26);
  g.add(panel);

  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.14, 10), mats.metal);
  neck.position.y = 1.32;
  g.add(neck);

  const head = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.5, 0.5), mats.face);
  head.position.y = 1.62;
  head.castShadow = true;
  g.add(head);

  // 面板式的眼睛：方臉配圓眼珠會變成別的物種。
  // 五官掛在 head 底下、用頭的區域座標：頭會左右掃視，
  // 做成 head 的兄弟節點的話，轉頭時面板會留在原地、臉就從頭上滑掉了。
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.2, 0.04), mats.ink);
  visor.position.set(0, 0.04, 0.25);
  head.add(visor);
  for (const dx of [-0.11, 0.11]) {
    const eye = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, 0.04), accent);
    eye.position.set(dx, 0.04, 0.28);
    head.add(eye);
  }

  addAntenna(g, mats, accent, 1.95);

  for (const dx of [-0.48, 0.48]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.5, 0.16), mats.metal);
    arm.position.set(dx, 0.86, 0);
    arm.castShadow = true;
    g.add(arm);
    const hand = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.16, 0.2), accent);
    hand.position.set(dx, 0.56, 0);
    g.add(hand);
  }

  for (const dx of [-0.2, 0.2]) {
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.22, 0.36), mats.metal);
    foot.position.set(dx, 0.11, 0.04);
    foot.castShadow = true;
    g.add(foot);
  }

  return {
    group: g,
    update(t) {
      // 機器人不呼吸，改成頭部左右掃視。面板與眼睛是 head 的子節點，跟著一起走
      head.rotation.y = Math.sin(t * 0.7) * 0.35;
    },
  };
}

// ---------- 史萊姆 ----------
function buildBlob(mats: CharacterMats, accent: THREE.MeshStandardMaterial): Character {
  const g = new THREE.Group();

  // 半透明會把身體內部的球面透出來（沒有深度排序的果凍只會像塑膠袋），
  // 改用低粗糙度的不透明材質，靠高光做果凍感
  const jelly = accent.clone();
  jelly.roughness = 0.18;

  const body = new THREE.Mesh(new THREE.SphereGeometry(0.62, 32, 24), jelly);
  body.position.y = 0.6;
  body.scale.set(1, 0.95, 1);
  body.castShadow = true;
  g.add(body);

  // 頂端的小球要埋進本體才會像滴下來的一坨，浮在上面會變成雪人
  const cap = new THREE.Mesh(new THREE.SphereGeometry(0.34, 24, 18), jelly);
  cap.position.y = 1.02;
  cap.castShadow = true;
  g.add(cap);

  // 五官掛在 body 底下、用 body 的區域座標（未縮放的 r=0.62 球面）：
  // body 每一幀都在擠壓，做成兄弟節點的話五官不會跟著變形，
  // 擠到最扁時整張臉會被脹大的本體吞進去。
  // z 值取「球面往外一點點」，讓眼珠是嵌在表面上的珠子而不是浮在前面。
  addEyes(body, mats, 0.125, 0.561, 0.171, 0.075);
  addSmile(body, mats, -0.137, 0.594, 0.09);

  return {
    group: g,
    update(t) {
      // 擠壓保體積：橫向脹多少，縱向就縮多少
      const squash = Math.sin(t * 2.6) * 0.07;
      body.scale.set(1 + squash, 0.95 - squash, 1 + squash);
      // 本體頂端在 y = 0.6 + 0.62 × (0.95 − squash)，小球要跟著那個高度走
      cap.position.y = 1.02 - squash * 0.62;
    },
  };
}

// ---------- 圓企鵝 ----------
function buildBird(mats: CharacterMats, accent: THREE.MeshStandardMaterial): Character {
  const g = new THREE.Group();

  const body = new THREE.Mesh(new THREE.SphereGeometry(0.5, 28, 22), accent);
  body.position.y = 0.72;
  body.scale.set(1, 1.28, 0.95);
  body.castShadow = true;
  g.add(body);

  // 肚子與臉的淺色塊都要凸出母球一點點，埋在裡面就整隻變單色了
  const belly = new THREE.Mesh(new THREE.SphereGeometry(0.38, 24, 18), mats.face);
  belly.position.set(0, 0.66, 0.29);
  belly.scale.set(1, 1.25, 0.6);
  g.add(belly);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.36, 26, 20), accent);
  head.position.y = 1.48;
  head.castShadow = true;
  g.add(head);

  const facePatch = new THREE.Mesh(new THREE.SphereGeometry(0.26, 20, 16), mats.face);
  facePatch.position.set(0, 1.44, 0.25);
  facePatch.scale.set(1, 1, 0.6);
  g.add(facePatch);

  // 臉塊是 r=0.26、z 壓成 0.6 的橢球，在眼睛那個 (x,y) 上表面已經到 z≈0.376。
  // 眼珠 z 給 0.3 的話整顆會被不透明的臉塊包住，正面看就是一張空白的臉。
  addEyes(g, mats, 1.52, 0.4, 0.13, 0.05);

  const beak = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.22, 12), mats.metal);
  beak.material = new THREE.MeshStandardMaterial({ color: 0xf5a742, roughness: 0.6 });
  beak.position.set(0, 1.38, 0.34);
  beak.rotation.x = Math.PI / 2;
  g.add(beak);

  const wings: THREE.Mesh[] = [];
  for (const dx of [-0.46, 0.46]) {
    const wing = new THREE.Mesh(new THREE.CapsuleGeometry(0.1, 0.4, 4, 12), accent);
    wing.position.set(dx, 0.74, 0);
    wing.rotation.z = dx > 0 ? -0.12 : 0.12;
    wing.castShadow = true;
    g.add(wing);
    wings.push(wing);
  }

  for (const dx of [-0.18, 0.18]) {
    const foot = new THREE.Mesh(new THREE.SphereGeometry(0.13, 14, 10), beak.material);
    foot.position.set(dx, 0.08, 0.12);
    foot.scale.set(1, 0.45, 1.4);
    foot.castShadow = true;
    g.add(foot);
  }

  return {
    group: g,
    update(t) {
      wings.forEach((w, i) => {
        const dir = i === 0 ? 1 : -1;
        w.rotation.z = dir * (0.12 + Math.pow(Math.max(0, Math.sin(t * 1.3)), 6) * 0.5);
      });
    },
  };
}
