import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { buildOffice, CAST_LAYER, type BoardData, type Occupant, type Office } from "../scene3d/office";
import { daylightAt, lerpColor, WARM_TINT, type Daylight } from "../logic/daylight";
import { PALETTES, type ScenePalette } from "../scene3d/palette";
import { makeAnimeCharacter } from "./animeCast";
import { setOutlineColor } from "../charstyle/toon";

/**
 * three.js 的生命週期完全放在 React 之外：場景建一次就好，
 * 之後靠 setOccupants 增刪人。把場景做成 React state 會在每次 SSE 推播時
 * 重建整個房間 —— 相機視角、動畫相位、GPU 資源全部跟著重來。
 */

/** 白板在螢幕上的外框（CSS px），在鏡頭後面時為 null */
export type BoardRect = { left: number; top: number; right: number; bottom: number };

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
  onAnchors: (anchors: TagAnchor[], canvasW: number, canvasH: number, board: BoardRect | null) => void;
  /** 滑鼠移到哪個角色上（null＝沒有）；只在變動時呼叫 */
  onHover: (id: string | null) => void;
};

export type OfficeHandle = {
  setOccupants: (list: Occupant[]) => void;
  setTheme: (themeId: string) => void;
  /** 日夜循環：天空色與燈光倍率，由外面依真實時間算好傳進來 */
  setDaylight: (d: Daylight) => void;
  setBoard: (data: BoardData) => void;
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

    // 日夜循環疊在主題之上：主題決定基色，這裡只乘倍率、染一點暖色、換窗外天空
    let daylight: Daylight = daylightAt(12);
    function applyPalette(p: ScenePalette): void {
      palette = p;
      office.applyPalette(p);
      scene.background = new THREE.Color(p.fog);
      scene.fog = new THREE.Fog(p.fog, 26, 55);
      ambient.color.setHex(p.ambient);
      sun.color.setHex(lerpColor(p.sun, WARM_TINT, daylight.warm * 0.6));
      ambient.intensity = p.ambientIntensity * daylight.ambient;
      sun.intensity = p.sunIntensity * daylight.sun;
      castFill.color.setHex(p.castFill);
      castFill.intensity = p.castFillIntensity;
      setOutlineColor(p.castOutline);
      office.setSky(daylight.sky);
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
    let hoverId: string | null = null;
    let lastMove = 0;
    const onMove = (e: PointerEvent): void => {
      // 射線檢測不便宜，拖曳或快速移動時限 30Hz 就夠
      const now = performance.now();
      if (now - lastMove < 33) return;
      lastMove = now;
      const r = canvas.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      const id = office.pick(ray);
      if (id !== hoverId) {
        hoverId = id;
        cb.current.onHover(id);
      }
    };
    const onLeave = (): void => {
      if (hoverId !== null) {
        hoverId = null;
        cb.current.onHover(null);
      }
    };
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerleave", onLeave);
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointerup", onUp);

    const box = new THREE.Box3();
    const corner = new THREE.Vector3();
    const dir = new THREE.Vector3();
    // 上一次自動取景算出來的視距。使用者自己拉近拉遠之後就會跟這個對不上，
    // 用來認出「鏡頭距離是使用者設的」，避免視窗一動就把他的縮放重設掉。
    // 只看距離不看角度：frame() 本來就會保留使用者轉過的方位。
    let framedDist = -1;

    /**
     * 依現場人數決定鏡頭退多遠。人數會變（背景 job 來來去去），
     * 固定視距的話人一多就有人被切在畫面外。
     *
     * 用「投影包圍盒的八個角、不夠就往後退」而不是用三角函數一次算完：
     * 角色站的深度跟相機對焦的深度不一樣（人在桌子前面、焦點在桌子上），
     * 拿焦點平面去算貼合，站得比較前面的人一定會被切掉。
     * 只在人數變動或畫布尺寸變動時重算，不然使用者每次自己拉近都會被拉回去。
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
      framedDist = camera.position.distanceTo(controls.target);
    }

    // ---------- 迴圈 ----------
    let ids: string[] = [];
    let framedFor = -1;
    const anchor = new THREE.Vector3();
    const clock = new THREE.Clock();

    // 拿 canvas.width 比對會永遠不相等：three 內部是 Math.floor(w * pixelRatio)，
    // 分數 DPR（Windows 150% 縮放）配上奇數寬度就對不起來，變成每幀都重設 size，
    // 而每次寫 canvas.width 都會重新配置並清空 WebGL drawing buffer
    let lastW = 0;
    let lastH = 0;

    function resize(): void {
      const w = canvas!.clientWidth;
      const h = canvas!.clientHeight;
      if (w === 0 || h === 0) return;
      if (w === lastW && h === lastH) return;
      lastW = w;
      lastH = h;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      // 視窗變窄會把人裁出畫面，所以尺寸一變就重新取景。
      // 第一次 resize 也順便補救初始取景：setOccupants 由 React effect 驅動，
      // 跑在第一次 animation frame 之前，那時 camera.aspect 還是 constructor 的 1。
      // 但使用者自己拉過遠近的話就不要動——這頁整天開著，拖個視窗、開個
      // devtools 就把他的視角重設回去很惱人
      const userZoomed =
        framedDist >= 0 && Math.abs(camera.position.distanceTo(controls.target) - framedDist) > 0.05;
      if (!userZoomed) frame();
    }

    function boardRect(w: number, h: number): BoardRect | null {
      let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
      for (const c of office.boardCorners()) {
        c.project(camera);
        if (c.z >= 1) return null;
        const x = ((c.x + 1) / 2) * w;
        const y = ((1 - c.y) / 2) * h;
        l = Math.min(l, x); r = Math.max(r, x); t = Math.min(t, y); b = Math.max(b, y);
      }
      return { left: l, top: t, right: r, bottom: b };
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
        boardRect(w, h),
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
      setDaylight(d) {
        daylight = d;
        applyPalette(palette);
      },
      setBoard(data) {
        office.setBoard(data);
      },
    };

    return () => {
      renderer.setAnimationLoop(null);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerleave", onLeave);
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
