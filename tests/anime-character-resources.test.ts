import { describe, it, expect } from "vitest";
import * as THREE from "three";

// node 環境沒有 document：用 Proxy 假造一個什麼方法都吞掉的 2d context，
// 這支測試只關心物件圖與 dispose，不關心畫出來的像素
const ctx2d: unknown = new Proxy(
  {},
  {
    get: () => () => ctx2d,
    set: () => true,
  },
);
(globalThis as unknown as { document: unknown }).document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d }),
};

const { makeAnimeCharacter } = await import("../web/src/office3d/animeCast");

describe("blob shadow removal + full per-character resource release", () => {
  it("removes the blob decal and leaks no per-character material/texture", () => {
    // 建兩個同種角色：一個拿來 dispose，一個留著當「還在場上的人」
    // 刻意用同一個 id + 同一個 accent 建兩次：這樣種類與配色完全相同，
    // 凡是「以顏色為 key 的共用快取」必定是同一個實例，只有每角色現做的才會不同。
    // 這個判準不依賴實作的 isOwned 旗標，才驗得出「漏標」這種缺陷。
    const a = makeAnimeCharacter("agent-a", 0x66ccff);
    const b = makeAnimeCharacter("agent-a", 0x66ccff);

    // blob 貼片不該還掛在場上，也不該進 shadow pass
    let planes = 0;
    let casters = 0;
    a.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      if (m.geometry?.type === "PlaneGeometry") planes++;
      if (m.castShadow) casters++;
    });

    // 收集 a 可達的所有材質/貼圖，以及 b 可達的（= 共用的，不可丟）
    const collect = (g: THREE.Object3D) => {
      const mats = new Set<THREE.Material>();
      const texs = new Set<THREE.Texture>();
      g.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || !m.material) return;
        for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
          mats.add(mat);
          for (const k of ["map", "gradientMap", "emissiveMap", "alphaMap", "normalMap"] as const) {
            const t = (mat as unknown as Record<string, THREE.Texture | null>)[k];
            if (t) texs.add(t);
          }
        }
      });
      return { mats, texs };
    };
    const A = collect(a.group);
    const B = collect(b.group);

    const disposed = new Set<unknown>();
    for (const m of A.mats) m.addEventListener("dispose", () => disposed.add(m));
    for (const t of A.texs) t.addEventListener("dispose", () => disposed.add(t));

    // Character.dispose 在型別上是選用的，這裡先確認 animeCast 真的有給
    expect(a.dispose).toBeTypeOf("function");
    a.dispose?.();

    // a 自有（b 沒共用）的東西必須全被丟
    const leakedMats = [...A.mats].filter((m) => !B.mats.has(m) && !disposed.has(m));
    const leakedTexs = [...A.texs].filter((t) => !B.texs.has(t) && !disposed.has(t));
    // 反向：b 還在用的東西一個都不能被丟
    const killedShared = [...B.mats].filter((m) => disposed.has(m));

    console.log({
      planes,
      casters,
      leakedMats: leakedMats.map((m) => m.type),
      leakedTexs: leakedTexs.map((t) => t.type),
      killedShared: killedShared.map((m) => m.type),
    });

    expect(planes).toBe(0);
    expect(leakedMats).toEqual([]);
    expect(leakedTexs).toEqual([]);
    expect(killedShared).toEqual([]);
    expect(casters).toBeGreaterThan(0);
  });
});
