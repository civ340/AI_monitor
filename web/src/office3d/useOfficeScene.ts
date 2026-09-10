import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { buildOffice, CAST_LAYER, type Occupant, type Office } from "../scene3d/office";
import { PALETTES, type ScenePalette } from "../scene3d/palette";
import { makeAnimeCharacter } from "./animeCast";
import { setOutlineColor } from "../charstyle/toon";

/**
 * three.js 的生命週期完全放在 React 之外：場景建一次就好，
 * 之後靠 setOccupants 增刪人。把場景做成 React state 會在每次 SSE 推播時
 * 重建整個房間 —— 相機視角、動畫相位、GPU 資源全部跟著重來。
 */

export type TagAnchor = {
  id: string;
  /** 螢幕座標（CSS px），相對於 canvas 左上角 */
  x: number;
  y: number;
  /** 在鏡頭後面或被裁掉時為 false */
  visible: boolean;
};

type Options = {
  onPick: (id: string | null) => void;
  /** 每幀回報名牌該貼在哪；直接改 DOM，不走 React state */
  onAnchors: (anchors: TagAnchor[], canvasW: number, canvasH: number) => void;
};

export type OfficeHandle = {
  setOccupants: (list: Occupant[]) => void;
  setTheme: (themeId: string) => void;
};

export function useOfficeScene(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  opts: Options,
): React.RefObject<OfficeHandle | null> {
  const handle = useRef<OfficeHandle | null>(null);
  // 回呼每次 render 都是新的，但場景只建一次；用 ref 轉一手避免重建場景
  const cb = useRef(opts);
  cb.current = opts;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 200);
    // 鏡頭放中軸上：偏一邊的話視錐左右不對稱，人一多就會有人被切在畫面外
    camera.position.set(0, 4.1, 10.6);

    const controls = new OrbitControls(camera, canvas);
    controls.target.set(0, 1.55, -2.2);
    controls.enableDamping = true;
    controls.enablePan = false;
    // 儀表板是一直開著的看板，鏡頭不能被轉到迷路 —— 只留小幅度的環顧
    controls.minPolarAngle = Math.PI * 0.22;
    controls.maxPolarAngle = Math.PI * 0.47;
    controls.minAzimuthAngle = -Math.PI * 0.26;
    controls.maxAzimuthAngle = Math.PI * 0.26;
    controls.minDistance = 7;
    controls.maxDistance = 18;

    const ambient = new THREE.HemisphereLight(0xffffff, 0x8a7060, 1);
    scene.add(ambient);
    const sun = new THREE.DirectionalLight(0xffffff, 2);
    sun.position.set(-6, 11, 6);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 40;
    sun.shadow.camera.left = -12;
    sun.shadow.camera.right = 12;
    sun.shadow.camera.top = 12;
    sun.shadow.camera.bottom = -12;
    sun.shadow.bias = -0.0006;
    scene.add(sun);

    // 角色專用補光：只設在 CAST_LAYER，所以照得到人、照不到牆壁與桌子。
    // 用 hemisphere 而不是 directional —— toon 的色塊分界由主光決定，
    // 這盞只要整體抬高亮度，不該再切出第二道明暗交界
    const castFill = new THREE.HemisphereLight(0xffffff, 0xa9adc4, 0);
    castFill.layers.set(CAST_LAYER);
    scene.add(castFill);

    let palette: ScenePalette = PALETTES[0]!;
    const office: Office = buildOffice(palette);
    office.setFactory(({ id, accent }) => makeAnimeCharacter(id, accent));
    scene.add(office.root);

    function applyPalette(p: ScenePalette): void {
      palette = p;
      office.applyPalette(p);
      scene.background = new THREE.Color(p.fog);
      scene.fog = new THREE.Fog(p.fog, 26, 55);
      ambient.color.setHex(p.ambient);
      ambient.intensity = p.ambientIntensity;
      sun.color.setHex(p.sun);
      sun.intensity = p.sunIntensity;
      castFill.color.setHex(p.castFill);
      castFill.intensity = p.castFillIntensity;
      setOutlineColor(p.castOutline);
    }
    applyPalette(palette);

    // ---------- 點角色 ----------
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    let downAt = { x: 0, y: 0 };
    const onDown = (e: PointerEvent): void => {
      downAt = { x: e.clientX, y: e.clientY };
    };
    const onUp = (e: PointerEvent): void => {
      // 拖曳轉視角不該算成點選
      if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5) return;
      const r = canvas.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      cb.current.onPick(office.pick(ray));
    };
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointerup", onUp);

    const box = new THREE.Box3();
    const corner = new THREE.Vector3();
    const dir = new THREE.Vector3();

    /**
     * 依現場人數決定鏡頭退多遠。人數會變（背景 job 來來去去），
     * 固定視距的話人一多就有人被切在畫面外。
     *
     * 用「投影包圍盒的八個角、不夠就往後退」而不是用三角函數一次算完：
     * 角色站的深度跟相機對焦的深度不一樣（人在桌子前面、焦點在桌子上），
     * 拿焦點平面去算貼合，站得比較前面的人一定會被切掉。
     * 只在人數變動時重算，不然使用者每次自己拉近都會被拉回去。
     */
    function frame(): void {
      if (!office.crewBounds(box)) return;
      dir.copy(camera.position).sub(controls.target).normalize();
      let dist = 7.5;
      for (let step = 0; step < 16; step++) {
        camera.position.copy(controls.target).addScaledVector(dir, dist);
        camera.updateMatrixWorld(true);
        camera.updateProjectionMatrix();
        let fits = true;
        for (let i = 0; i < 8 && fits; i++) {
          corner.set(
            i & 1 ? box.max.x : box.min.x,
            i & 2 ? box.max.y : box.min.y,
            i & 4 ? box.max.z : box.min.z,
          );
          corner.project(camera);
          if (Math.abs(corner.x) > 0.94 || Math.abs(corner.y) > 0.94) fits = false;
        }
        if (fits || dist >= 18) break;
        dist = Math.min(18, dist * 1.07);
      }
      controls.update();
    }

    // ---------- 迴圈 ----------
    let ids: string[] = [];
    let framedFor = -1;
    const anchor = new THREE.Vector3();
    const clock = new THREE.Clock();

    function resize(): void {
      const w = canvas!.clientWidth;
      const h = canvas!.clientHeight;
      if (w === 0 || h === 0) return;
      const dpr = renderer.getPixelRatio();
      if (canvas!.width === Math.round(w * dpr) && canvas!.height === Math.round(h * dpr)) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }

    renderer.setAnimationLoop(() => {
      resize();
      const t = clock.getElapsedTime();
      office.update(t);
      controls.update();
      renderer.render(scene, camera);

      // 名牌位置每幀重算，但不經過 React state —— 那會每秒觸發 60 次 re-render
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      cb.current.onAnchors(
        ids.map((id) => {
          if (!office.anchorOf(id, anchor)) return { id, x: 0, y: 0, visible: false };
          anchor.project(camera);
          return {
            id,
            x: ((anchor.x + 1) / 2) * w,
            y: ((1 - anchor.y) / 2) * h,
            visible: anchor.z < 1,
          };
        }),
        w,
        h,
      );
    });

    handle.current = {
      setOccupants(list) {
        ids = list.map((o) => o.id);
        office.setOccupants(list);
        if (list.length !== framedFor) {
          framedFor = list.length;
          frame();
        }
      },
      setTheme(themeId) {
        const p = PALETTES.find((x) => x.id === themeId);
        if (p && p.id !== palette.id) applyPalette(p);
      },
    };

    return () => {
      renderer.setAnimationLoop(null);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerup", onUp);
      controls.dispose();
      office.dispose();
      renderer.dispose();
      handle.current = null;
    };
  }, [canvasRef]);

  return handle;
}
