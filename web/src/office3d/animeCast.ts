import * as THREE from "three";
import type { Character } from "../scene3d/characters";
import { ANIME_KINDS } from "../charstyle/animeChars";
import config from "@config";

/**
 * 把動漫角色接到 office.ts 的角色工廠介面上。
 *
 * 兩件事必須在這裡處理，動漫角色模組本身不該知道辦公室的存在：
 * 1. 那套角色自帶一片假的軟陰影（給沒有陰影貼圖的試作頁用的），
 *    辦公室有真的 shadow map，兩層疊起來腳下會糊成一塊。
 * 2. 材質是模組層以顏色為 key 的快取、跨角色共用（膚色每個人都同一份），
 *    所以 dispose 只能丟幾何 —— 丟材質會把還在場上的其他人一起弄壞。
 */

type AgentConfig = { label: string; character?: string };

const AGENTS = config.agents as Record<string, AgentConfig>;

/**
 * 哪個 agent 長什麼樣：config.json 可以指定，沒指定就用 id 雜湊挑一個。
 * 用雜湊而不是流水號，是為了讓同一個 agent 每次重整都拿到同一張臉 ——
 * 換一次臉就等於換一個人，看板上會失去「這個角色＝這個工具」的連結。
 */
export function kindForAgent(agentId: string): number {
  const prefix = agentId.split(":")[0] ?? "";
  const wanted = AGENTS[prefix]?.character;
  if (wanted) {
    const i = ANIME_KINDS.findIndex((k) => k.id === wanted);
    if (i >= 0) return i;
  }
  let h = 2166136261;
  for (let i = 0; i < agentId.length; i++) {
    h ^= agentId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % ANIME_KINDS.length;
}

export function makeAnimeCharacter(agentId: string, accent: number): Character {
  const kind = ANIME_KINDS[kindForAgent(agentId)]!;
  const built = kind.build(accent);
  const group = built.group;

  const ownGeometries: THREE.BufferGeometry[] = [];
  const blobs: THREE.Object3D[] = [];
  group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (mesh.userData.blobShadow) {
      blobs.push(mesh);
      return;
    }
    mesh.castShadow = true;
    ownGeometries.push(mesh.geometry);
  });
  for (const b of blobs) {
    b.removeFromParent();
    const mesh = b as THREE.Mesh;
    mesh.geometry.dispose();
    const mat = mesh.material as THREE.MeshBasicMaterial;
    mat.map?.dispose();
    mat.dispose();
  }

  return {
    group,
    update: built.update,
    dispose() {
      // 只丟幾何。材質全是 toon.ts 裡以顏色為 key 的共用快取，丟掉會波及其他角色
      for (const g of ownGeometries) g.dispose();
    },
  };
}
