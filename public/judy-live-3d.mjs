/* JUDY live office: the three.js scene.

   createScene(container, handlers) builds an isometric 3D office and returns
   the small API judy-live.js drives:

     setSlots(n)  play(slot, action, speed) -> Promise  clearRun()  restore(slots, counts)
     setClock(x)  pause(bool)  setTarget(name, sub)  select(slot)
     counts  layout  slotCount  runner(slot) -> { q }

   Actions are the director's: start, retry, answer, followup, stamp, error,
   finale. Each returns a promise that settles when the judge has finished it.

   Art: Kenney Mini Characters + Furniture Kit (CC0), Microsoft Fluent Emoji
   (MIT); see assets/LICENSES.md. Everything else is built from primitives.

   World axes: layout x is the aisle (away from the agent) = world X, layout y
   is across the aisle = world Z, world Y is up. */

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const win = window;
const gsap = win.gsap;
const Judy = win.Judy;
const JudyLive = win.JudyLive;

/* ---------------------------------------------------------------- constants */

const ASSETS = "/assets";
const CHARACTERS = [
  "male-a", "female-a", "male-b", "female-b", "male-c", "female-c",
  "male-d", "female-d", "male-e", "female-e", "male-f", "female-f",
];
const PROPS = [
  "desk", "chairDesk", "books", "bookcaseClosed", "pottedPlant", "plantSmall1",
  "lampRoundTable", "wallWindow", "wall", "rugRectangle", "trashcan",
];
const EMOJI = {
  think: "thinking_face",
  hourglass: "hourglass_not_done",
  hammer: "hammer",
  ok: "check_mark_button",
  partial: "warning",
  false: "cross_mark",
  error: "collision",
  party: "party_popper",
  note: "memo",
  read: "magnifying_glass_tilted_left",
  page: "page_facing_up",
};
const emojiUrl = (kind) => `${ASSETS}/emoji/${EMOJI[kind]}.png`;

const TRAYS = [
  { key: "ok", verdict: "OK", label: "OK" },
  { key: "partial", verdict: "PARTIAL", label: "PARTIAL" },
  { key: "false", verdict: "FALSE", label: "FALSE" },
  { key: "error", verdict: "ERROR", label: "ERROR" },
];
const trayFor = (verdict) => TRAYS.find((t) => t.verdict === verdict) || TRAYS[3];

const CHAR_S = 1.9; // Kenney minis are ~0.67 tall
const DESK_S = 2.3;
const CHAIR_S = 1.75;
const SEAT_Y = 0.36; // how far a seated judge is lifted onto the chair
const WALK_SPEED = 3.2; // world units per second
const WALK_RATE = 2.0; // clip playback rate that matches WALK_SPEED
const WALL_H = 3.35;
const PILE_BASE = 3;
const SHEET_W = 0.78;
const SHEET_D = 0.56;
const SHEET_H = 0.022;
const CAM_DIR = new THREE.Vector3(1, 1.1, 1).normalize();
const AXIS_X = new THREE.Vector3(1, 0, 0);

const motionOn = () => Boolean(gsap) && Judy.motion.enabled;
const D = (seconds) => (motionOn() ? seconds : 0);

function seeded(seed) {
  let s = (seed * 9301 + 49297) % 233280;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

function shortestAngle(from, to) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return from + d;
}

/* ------------------------------------------------------------------- theme */

function readTheme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name) => cs.getPropertyValue(name).trim();
  return {
    dark: document.documentElement.dataset.theme === "dark",
    floor: v("--lv-floor"),
    floorLine: v("--lv-floor-line"),
    carpet: v("--lv-carpet"),
    wall: v("--lv-wall-a"),
    pod: v("--lv-pod"),
    screen: v("--lv-screen"),
    glow: v("--lv-screen-glow"),
    sheet: v("--lv-sheet"),
    sheetLine: v("--lv-sheet-line"),
    ink: v("--lv-ink"),
    accent: v("--accent"),
    ok: v("--ok"),
    partial: v("--partial"),
    false: v("--false"),
    error: v("--error"),
    panel: v("--panel"),
    text: v("--text"),
  };
}

const verdictColor = (theme, key) => theme[key] || theme.accent;

/* ------------------------------------------------------------------ assets */

function loadAssets(onProgress) {
  const manager = new THREE.LoadingManager();
  manager.onProgress = (url, loaded, total) => onProgress(total ? loaded / total : 0);
  const loader = new GLTFLoader(manager);
  const load = (url) => loader.loadAsync(url);

  return Promise.all([
    Promise.all(CHARACTERS.map((c) => load(`${ASSETS}/models/characters/character-${c}.glb`))),
    load(`${ASSETS}/models/characters/character-robot.glb`),
    Promise.all(PROPS.map((p) => load(`${ASSETS}/models/props/${p}.glb`))),
    Promise.all(
      Object.values(EMOJI).map(
        (file) =>
          new Promise((resolve) => {
            const img = new Image();
            img.onload = img.onerror = () => resolve();
            img.src = `${ASSETS}/emoji/${file}.png`;
          }),
      ),
    ),
  ]).then(([characters, robot, props]) => ({
    characters,
    robot,
    props: Object.fromEntries(PROPS.map((name, i) => [name, props[i]])),
  }));
}

/* Named clips for one Kenney character. Seated poses are stitched together
   from the "sit" clip (legs, root drop, left arm) and a standing clip's
   upper-body tracks, so a judge can swing the gavel without standing up. */
function buildClips(gltf) {
  const byName = Object.fromEntries(gltf.animations.map((a) => [a.name, a]));
  const pick = (clip, nodes) => clip.tracks.filter((t) => nodes.includes(t.name.split(".")[0])).map((t) => t.clone());
  const sit = byName.sit;
  const melee = byName["attack-melee-right"];
  const stamp = new THREE.AnimationClip("stamp", melee.duration, [
    ...pick(melee, ["torso", "head", "arm-right"]),
    ...pick(sit, ["root", "leg-left", "leg-right", "arm-left"]),
  ]);
  return {
    idle: byName.idle,
    walk: byName.walk,
    sit,
    stamp,
    cheer: byName.jump || byName["emote-yes"],
    shock: byName["emote-no"],
    work: byName["interact-right"],
    yes: byName["emote-yes"],
    no: byName["emote-no"],
    die: byName.die,
  };
}

/* The shared colormap with every non-skin texel turned into dark robe cloth,
   so the same palette works for all twelve characters. */
function makeRobeTexture(image) {
  const size = image.width;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, size, size);
  const data = ctx.getImageData(0, 0, size, size);
  const px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i];
    const g = px[i + 1];
    const b = px[i + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const v = max / 255;
    const s = max ? (max - min) / max : 0;
    let h = 0;
    if (max !== min) {
      if (max === r) h = ((g - b) / (max - min)) * 60;
      else if (max === g) h = (2 + (b - r) / (max - min)) * 60;
      else h = (4 + (r - g) / (max - min)) * 60;
      if (h < 0) h += 360;
    }
    const skin = h >= 12 && h <= 42 && s >= 0.14 && s <= 0.62 && v >= 0.6;
    if (skin) continue;
    const lum = (r * 0.3 + g * 0.59 + b * 0.11) / 255;
    px[i] = 24 + lum * 40;
    px[i + 1] = 25 + lum * 40;
    px[i + 2] = 34 + lum * 46;
  }
  ctx.putImageData(data, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.flipY = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/* Centre a prop on the origin, base on the floor, scaled and turned. */
function fitProp(source, { scale = 1, rotY = 0 } = {}) {
  const obj = source.scene.clone(true);
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(obj);
  const c = box.getCenter(new THREE.Vector3());
  obj.position.set(-c.x, -box.min.y, -c.z);
  const spin = new THREE.Group();
  spin.add(obj);
  spin.rotation.y = rotY;
  spin.scale.setScalar(scale);
  const wrap = new THREE.Group();
  wrap.add(spin);
  return wrap;
}

function shadows(obj, cast = true, receive = true) {
  obj.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = cast;
      o.receiveShadow = receive;
    }
  });
  return obj;
}

/* --------------------------------------------------------------- the scene */

export async function createScene(container, handlers = {}) {
  const loadingEl = document.getElementById("stageLoading");
  const loadingBar = document.getElementById("stageLoadingBar");
  const assets = await loadAssets((p) => {
    if (loadingBar) loadingBar.style.width = `${Math.round(p * 100)}%`;
  });
  if (loadingEl) {
    loadingEl.classList.add("done");
    setTimeout(() => loadingEl.remove(), 500);
  }

  /* ---- renderer, camera, controls ---- */

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(win.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setClearColor(0x000000, 0);
  container.replaceChildren(renderer.domElement);

  const overlay = document.createElement("div");
  overlay.className = "overlay";
  container.appendChild(overlay);

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 400);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.09;
  controls.enablePan = false;
  controls.rotateSpeed = 0.55;
  controls.zoomSpeed = 0.8;
  controls.minZoom = 0.7;
  controls.maxZoom = 3.2;
  controls.minPolarAngle = THREE.MathUtils.degToRad(36);
  controls.maxPolarAngle = THREE.MathUtils.degToRad(64);
  controls.minAzimuthAngle = Math.PI / 4 - 0.5;
  controls.maxAzimuthAngle = Math.PI / 4 + 0.5;

  const hemi = new THREE.HemisphereLight(0xfff4e0, 0xcdbfa6, 1.2);
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  scene.add(hemi, sun, sun.target);
  const podLight = new THREE.PointLight(0x7ee8dd, 14, 9, 1.6);
  scene.add(podLight);

  const state = {
    layout: null,
    count: 0,
    runners: [],
    desks: [],
    trays: new Map(),
    spots: [],
    queue: [],
    counts: { OK: 0, PARTIAL: 0, FALSE: 0, ERROR: 0 },
    timeScale: 1,
    clockSpeed: 1,
    active: new Set(),
    fx: new Set(),
    finale: false,
    selected: null,
    hoverSlot: null,
    paused: false,
    target: { name: "Agent under test", sub: "" },
    home: null,
    size: { w: 1, h: 1 },
  };
  let theme = readTheme();
  let world = null; // THREE.Group holding everything that depends on the layout
  let pod = null;
  let robeMaterial = null;
  const themed = []; // fns re-run when the theme changes
  const hitTargets = [];
  const sheetTextures = {};

  /* ---- shared materials / textures ---- */

  const sheetTop = (() => {
    const c = document.createElement("canvas");
    c.width = 64;
    c.height = 84;
    return c;
  })();
  const sheetTopTex = new THREE.CanvasTexture(sheetTop);
  sheetTopTex.colorSpace = THREE.SRGBColorSpace;
  sheetTopTex.anisotropy = 4;
  const sheetGeo = new THREE.BoxGeometry(SHEET_W, SHEET_H, SHEET_D);
  const halfGeo = new THREE.BoxGeometry(SHEET_W, SHEET_H, SHEET_D / 2);
  const sheetSide = new THREE.MeshLambertMaterial({ color: 0xeeeeee });
  const sheetTopMat = new THREE.MeshLambertMaterial({ map: sheetTopTex });
  const sheetMats = [sheetSide, sheetSide, sheetTopMat, sheetSide, sheetSide, sheetSide];
  const noteTopMat = new THREE.MeshLambertMaterial({ map: sheetTopTex, color: 0xffd9a0 });
  const noteMats = [sheetSide, sheetSide, noteTopMat, sheetSide, sheetSide, sheetSide];

  function paintSheet() {
    const ctx = sheetTop.getContext("2d");
    ctx.fillStyle = theme.sheet;
    ctx.fillRect(0, 0, 64, 84);
    ctx.strokeStyle = theme.sheetLine;
    ctx.lineWidth = 2;
    for (let y = 12; y < 76; y += 9) {
      ctx.beginPath();
      ctx.moveTo(8, y);
      ctx.lineTo(y % 18 === 3 ? 44 : 56, y);
      ctx.stroke();
    }
    sheetTopTex.needsUpdate = true;
    sheetSide.color.set(theme.sheet).multiplyScalar(0.82);
  }
  themed.push(paintSheet);

  function makeSheet(note = false, half = false) {
    const mesh = new THREE.Mesh(half ? halfGeo : sheetGeo, note ? noteMats : sheetMats);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  /* ---- overlay helpers (HTML labels pinned to 3D points) ---- */

  const tmpV = new THREE.Vector3();
  function project(obj3d, out) {
    tmpV.setFromMatrixPosition(obj3d.matrixWorld).project(camera);
    out.x = (tmpV.x * 0.5 + 0.5) * state.size.w;
    out.y = (-tmpV.y * 0.5 + 0.5) * state.size.h;
    out.behind = tmpV.z > 1;
    return out;
  }

  /* ---------------------------------------------------------------- build */

  function disposeWorld() {
    killAll();
    clearFx();
    if (world) {
      scene.remove(world);
      world.traverse((o) => {
        if (o.userData.ownedMaterial) o.material.dispose();
        if (o.userData.ownedMap) o.userData.ownedMap.dispose();
      });
    }
    for (const r of state.runners) r.ui.root.remove();
    if (pod && pod.plate) pod.plate.remove();
    hitTargets.length = 0;
    themed.length = 1; // keep paintSheet
    world = null;
    pod = null;
  }

  function addThemed(fn) {
    themed.push(fn);
    fn();
  }

  function setSlots(n) {
    const count = Math.max(1, Math.floor(n) || 1);
    if (state.layout && state.count === count) return;
    const hadView = Boolean(state.layout);
    disposeWorld();
    state.count = count;
    const L = JudyLive.computeLayout(count);
    state.layout = L;
    state.runners = [];
    state.desks = [];
    state.trays = new Map();
    state.spots = [];
    state.queue = [];
    state.counts = { OK: 0, PARTIAL: 0, FALSE: 0, ERROR: 0 };
    state.finale = false;
    state.selected = null;
    state.hoverSlot = null;

    world = new THREE.Group();
    scene.add(world);
    buildRoom(L);
    buildPod(L);
    TRAYS.forEach((def, i) => buildTray(L, i, def));
    for (const d of L.desks) {
      const desk = buildDesk(d);
      const r = buildJudge(d, desk);
      state.desks.push(desk);
      state.runners.push(r);
      resetPile(r, false);
    }
    setTarget(state.target.name, state.target.sub);
    applyTheme();
    configureLight(L);
    frame(L, hadView);
    notifyCount();
  }

  /* ---- room: floor, walls, windows, decor ---- */

  function buildRoom(L) {
    const w = L.xMax - L.xMin + 2;
    const d = L.halfW * 2 + 2;
    const cx = (L.xMin + L.xMax) / 2;

    // floor tiles drawn on a canvas so the theme can repaint them
    const tile = document.createElement("canvas");
    tile.width = tile.height = 128;
    const floorTex = new THREE.CanvasTexture(tile);
    floorTex.wrapS = floorTex.wrapT = THREE.RepeatWrapping;
    floorTex.repeat.set(w / 1.6, d / 1.6);
    floorTex.colorSpace = THREE.SRGBColorSpace;
    floorTex.anisotropy = 8;
    const floorMat = new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.92, metalness: 0 });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(w, d), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(cx, 0, 0);
    floor.receiveShadow = true;
    world.add(floor);

    const carpetMat = new THREE.MeshStandardMaterial({ roughness: 1 });
    const carpet = new THREE.Mesh(new THREE.PlaneGeometry(L.xMax - L.xMin - 0.6, L.aisle * 2 + 0.4), carpetMat);
    carpet.rotation.x = -Math.PI / 2;
    carpet.position.set(cx, 0.012, 0);
    carpet.receiveShadow = true;
    world.add(carpet);
    const stripeMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.55 });
    for (const sy of [-1, 1]) {
      const stripe = new THREE.Mesh(new THREE.PlaneGeometry(L.xMax - L.xMin - 0.6, 0.07), stripeMat);
      stripe.rotation.x = -Math.PI / 2;
      stripe.position.set(cx, 0.016, sy * (L.aisle + 0.2));
      world.add(stripe);
    }

    // walls: back (x = xMin, runs along z) and side (z = -halfW, runs along x)
    const wallProto = assets.props.wall;
    const windowProto = assets.props.wallWindow;
    const wallMats = new Set();
    const SEG = 2.6;
    const sc = SEG;
    const wallScaleY = WALL_H / 1.29;
    const addWallRun = (len, place) => {
      const segs = Math.ceil(len / SEG);
      for (let i = 0; i < segs; i += 1) {
        const proto = i % 2 === 1 ? windowProto : wallProto;
        const piece = shadows(proto.scene.clone(true), false, true);
        piece.scale.set(sc, wallScaleY, sc);
        place(piece, i * SEG);
        world.add(piece);
        piece.traverse((o) => {
          if (o.isMesh) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => wallMats.add(m));
        });
      }
    };
    // wall along z at x = xMin - 0.2, faces +x
    addWallRun(L.halfW * 2 + 2, (piece, off) => {
      piece.rotation.y = Math.PI / 2;
      piece.position.set(L.xMin - 0.55, 0, -L.halfW - 1 + off + SEG);
    });
    // wall along x at z = -halfW - 1, faces +z
    addWallRun(w, (piece, off) => {
      piece.position.set(L.xMin - 0.55 + off, 0, -L.halfW - 1.0);
    });

    // light the walls with the theme: the default (white) wall material only
    const wallPaint = [...wallMats].filter((m) => m && m.name === "_defaultMat");
    for (const m of wallPaint) m.userData.shared = true;

    // decor
    const place = (name, x, z, { scale = 1, rotY = 0, y = 0 } = {}) => {
      const o = shadows(fitProp(assets.props[name], { scale, rotY }));
      o.position.set(x, y, z);
      world.add(o);
      return o;
    };
    place("bookcaseClosed", L.xMin + 0.4, -L.halfW + 1.6, { scale: 3.4, rotY: Math.PI / 2 });
    place("bookcaseClosed", L.xMin + 0.4, -L.halfW + 3.9, { scale: 3.4, rotY: Math.PI / 2 });
    place("pottedPlant", L.xMin + 0.7, L.halfW - 0.5, { scale: 3.2 });
    place("pottedPlant", L.xMin + 0.7, -L.halfW + 0.6, { scale: 3.4 });
    place("pottedPlant", L.xMax - 0.4, -L.halfW + 0.6, { scale: 3 });
    place("pottedPlant", L.xMax - 0.4, L.halfW - 0.5, { scale: 3 });
    place("trashcan", L.pod.x1 + 1.5, -L.aisle - 0.9, { scale: 2.2 });
    place("pottedPlant", L.pod.x1 + 1.5, L.aisle + 0.9, { scale: 2.6 });

    addThemed(() => {
      const t = theme;
      const c = tile.getContext("2d");
      c.fillStyle = t.floor;
      c.fillRect(0, 0, 128, 128);
      c.strokeStyle = t.floorLine;
      c.lineWidth = 3;
      c.strokeRect(0, 0, 128, 128);
      floorTex.needsUpdate = true;
      carpetMat.color.set(t.carpet);
      stripeMat.color.set(t.accent);
      for (const m of wallPaint) m.color.set(t.wall);
    });
  }

  /* ---- the tested agent: pedestal, hologram robot, screen ---- */

  function buildPod(L) {
    const P = L.pod;
    const group = new THREE.Group();
    world.add(group);
    const podW = P.x1 - P.x0;
    const podD = P.y1 - P.y0;

    const baseMat = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.2 });
    const base = new THREE.Mesh(new THREE.BoxGeometry(podW, 0.2, podD), baseMat);
    base.position.set((P.x0 + P.x1) / 2, 0.1, 0);
    base.castShadow = true;
    base.receiveShadow = true;
    group.add(base);

    const edgeMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.7 });
    // an inset frame: four thin glowing strips along the top edge
    const strips = new THREE.Group();
    const addStrip = (sx, sz, px, pz) => {
      const s = new THREE.Mesh(new THREE.BoxGeometry(sx, 0.03, sz), edgeMat);
      s.position.set(px, 0.215, pz);
      strips.add(s);
    };
    addStrip(podW, 0.07, (P.x0 + P.x1) / 2, P.y0 + 0.035);
    addStrip(podW, 0.07, (P.x0 + P.x1) / 2, P.y1 - 0.035);
    addStrip(0.07, podD, P.x0 + 0.035, 0);
    addStrip(0.07, podD, P.x1 - 0.035, 0);
    group.add(strips);

    // pedestal + ring
    const cx = P.cx;
    const pedMat = new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.4 });
    const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 1.1, 0.22, 40), pedMat);
    ped.position.set(cx, 0.31, 0);
    ped.castShadow = true;
    ped.receiveShadow = true;
    group.add(ped);
    const ringMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.95 });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.88, 0.035, 10, 60), ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.set(cx, 0.43, 0);
    group.add(ring);
    const ring2 = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.02, 8, 48), ringMat);
    ring2.rotation.x = Math.PI / 2;
    ring2.position.set(cx, 0.44, 0);
    group.add(ring2);

    // light cone
    const coneTex = (() => {
      const c = document.createElement("canvas");
      c.width = 4;
      c.height = 64;
      const g = c.getContext("2d");
      const grad = g.createLinearGradient(0, 0, 0, 64);
      grad.addColorStop(0, "rgba(255,255,255,0)");
      grad.addColorStop(1, "rgba(255,255,255,0.8)");
      g.fillStyle = grad;
      g.fillRect(0, 0, 4, 64);
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    })();
    const coneMat = new THREE.MeshBasicMaterial({
      map: coneTex,
      transparent: true,
      opacity: 0.2,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const cone = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.85, 2.7, 36, 1, true), coneMat);
    cone.position.set(cx, 0.43 + 1.35, 0);
    group.add(cone);

    // hologram robot
    const robot = cloneSkinned(assets.robot.scene);
    const ROBOT_S = 2.5;
    robot.scale.setScalar(ROBOT_S);
    const holo = new THREE.Group();
    holo.position.set(cx, 0.75, 0);
    holo.rotation.y = Math.PI / 4;
    holo.add(robot);
    group.add(holo);
    const uniforms = { uTime: { value: 0 }, uGlitch: { value: 0 } };
    const holoMats = [];
    robot.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = false;
      const m = new THREE.MeshStandardMaterial({
        map: o.material.map,
        transparent: true,
        opacity: 0.82,
        roughness: 0.4,
        metalness: 0,
        emissiveIntensity: 0.65,
        depthWrite: false,
      });
      m.emissiveMap = o.material.map;
      m.onBeforeCompile = (shader) => {
        shader.uniforms.uTime = uniforms.uTime;
        shader.uniforms.uGlitch = uniforms.uGlitch;
        shader.vertexShader = shader.vertexShader
          .replace("#include <common>", "#include <common>\nvarying float vHoloY;")
          .replace("#include <project_vertex>", "#include <project_vertex>\nvHoloY = (modelMatrix * vec4(transformed, 1.0)).y;");
        shader.fragmentShader = shader.fragmentShader
          .replace("#include <common>", "#include <common>\nvarying float vHoloY;\nuniform float uTime;\nuniform float uGlitch;")
          .replace(
            "#include <dithering_fragment>",
            `#include <dithering_fragment>
             float scan = 0.78 + 0.22 * step(0.5, fract(vHoloY * 14.0 - uTime * 0.9));
             gl_FragColor.a *= scan * (0.9 + 0.1 * sin(uTime * 23.0));
             gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(1.0, 0.25, 0.3), uGlitch * 0.7);`,
          );
      };
      o.material = m;
      holoMats.push(m);
    });
    const clips = buildClips(assets.robot);
    const mixer = new THREE.AnimationMixer(robot);
    const actions = {};
    for (const k of ["idle", "work", "yes", "no", "die"]) if (clips[k]) actions[k] = mixer.clipAction(clips[k]);
    actions.idle.play();

    // floating status screen (sprite, always faces the camera)
    const screenCanvas = document.createElement("canvas");
    screenCanvas.width = 512;
    screenCanvas.height = 256;
    const screenTex = new THREE.CanvasTexture(screenCanvas);
    screenTex.colorSpace = THREE.SRGBColorSpace;
    const screen = new THREE.Sprite(new THREE.SpriteMaterial({ map: screenTex, transparent: true, depthWrite: false }));
    screen.scale.set(2.5, 1.25, 1);
    screen.position.set(cx, 3.5, 0);
    group.add(screen);

    // name plate (HTML) anchored on the pedestal
    const plate = document.createElement("div");
    plate.className = "agent-plate";
    plate.innerHTML = "<b></b><span></span>";
    overlay.appendChild(plate);
    const plateAnchor = new THREE.Object3D();
    plateAnchor.position.set(cx + 0.9, 0.05, 1.35);
    group.add(plateAnchor);

    pod = {
      group, ring, ring2, edgeMat, ringMat, coneMat, holoMats, holo, robot, mixer, actions, current: actions.idle,
      uniforms, screenCanvas, screenTex, screen, plate, plateAnchor, light: podLight,
      mode: "idle", dots: 0, score: "", dotTimer: null, glow: new THREE.Color(), bob: 0,
    };
    podLight.position.set(cx, 1.6, 0);

    addThemed(() => {
      baseMat.color.set(theme.pod);
      pedMat.color.set(theme.pod).multiplyScalar(0.7);
      pod.glow.set(theme.glow);
      for (const m of holoMats) {
        m.color.set(theme.glow).lerp(new THREE.Color(0xffffff), 0.35);
        m.emissive.set(theme.glow);
      }
      applyPodTint();
      drawScreen();
    });
    updatePod();
  }

  function applyPodTint() {
    if (!pod) return;
    const retry = state.queue.some(Boolean);
    const c = new THREE.Color(retry ? theme.error : theme.glow);
    pod.edgeMat.color.copy(c);
    pod.ringMat.color.copy(c);
    pod.coneMat.color.copy(c);
    pod.light.color.copy(c);
    for (const m of pod.holoMats) m.emissive.copy(c);
  }

  function drawScreen() {
    if (!pod) return;
    const c = pod.screenCanvas;
    const g = c.getContext("2d");
    g.clearRect(0, 0, c.width, c.height);
    const glow = theme.glow;
    g.fillStyle = "rgba(6, 28, 30, 0.82)";
    g.strokeStyle = glow;
    g.lineWidth = 6;
    g.beginPath();
    g.roundRect(12, 12, c.width - 24, c.height - 24, 28);
    g.fill();
    g.stroke();
    g.fillStyle = glow;
    g.textAlign = "center";
    g.textBaseline = "middle";
    if (pod.mode === "score") {
      g.font = "700 130px 'Frank Ruhl Libre', Georgia, serif";
      g.fillText(pod.score, c.width / 2, c.height / 2 + 6);
    } else if (pod.mode === "typing") {
      for (let i = 0; i < 3; i += 1) {
        const on = (pod.dots + i) % 3 === 0;
        g.globalAlpha = on ? 1 : 0.35;
        g.beginPath();
        g.arc(c.width / 2 + (i - 1) * 76, c.height / 2, on ? 21 : 16, 0, Math.PI * 2);
        g.fill();
      }
      g.globalAlpha = 1;
    } else if (pod.mode === "retry") {
      g.fillStyle = theme.error;
      g.font = "700 96px 'Rubik', sans-serif";
      g.fillText("429", c.width / 2, c.height / 2 + 4);
    } else {
      g.globalAlpha = 0.85;
      g.font = "600 56px 'Rubik', sans-serif";
      g.fillText("ready", c.width / 2, c.height / 2 + 4);
      g.globalAlpha = 1;
    }
    pod.screenTex.needsUpdate = true;
  }

  function setPodMode(mode) {
    if (!pod || pod.mode === mode) return;
    pod.mode = mode;
    drawScreen();
  }

  function podAction(name, { loop = false, rate = 1 } = {}) {
    if (!pod || !pod.actions[name]) return;
    const next = pod.actions[name];
    if (pod.current === next && loop) return;
    next.reset();
    next.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    next.clampWhenFinished = !loop;
    next.timeScale = rate;
    next.fadeIn(0.15).play();
    if (pod.current && pod.current !== next) pod.current.fadeOut(0.15);
    pod.current = next;
  }

  function updatePod() {
    if (!pod) return;
    const retrying = state.queue.some(Boolean);
    const waiting = state.spots.some(Boolean) || retrying;
    if (state.finale) return;
    applyPodTint();
    if (retrying) setPodMode("retry");
    else if (waiting) setPodMode("typing");
    else setPodMode("idle");
    if (waiting && !retrying) podAction("work", { loop: true });
    else if (pod.current !== pod.actions.idle) podAction("idle", { loop: true });
    if (!motionOn()) return;
    if (waiting && !retrying && !pod.dotTimer) {
      pod.dotTimer = setInterval(() => {
        pod.dots = (pod.dots + 1) % 3;
        if (pod.mode === "typing") drawScreen();
      }, 280);
    } else if ((!waiting || retrying) && pod.dotTimer) {
      clearInterval(pod.dotTimer);
      pod.dotTimer = null;
    }
  }

  function showScore(summary, stopped) {
    if (!pod) return;
    const total = state.counts.OK + state.counts.PARTIAL + state.counts.FALSE + state.counts.ERROR;
    let text = "";
    if (stopped && !summary) text = "stop";
    else if (summary && summary.passRate != null) text = `${Math.round(Number(summary.passRate))}%`;
    else if (total) text = `${Math.round((state.counts.OK / total) * 100)}%`;
    if (!text) return;
    pod.score = text;
    if (pod.dotTimer) { clearInterval(pod.dotTimer); pod.dotTimer = null; }
    setPodMode("score");
    drawScreen();
    podAction(stopped ? "idle" : "yes", { loop: stopped });
    if (gsap && motionOn()) {
      gsap.fromTo(pod.screen.scale, { x: 1.2, y: 0.6 }, { x: 2.5, y: 1.25, duration: 0.6, ease: "back.out(2.4)" });
      gsap.fromTo(pod.ringMat, { opacity: 1 }, { opacity: 0.3, duration: 0.3, yoyo: true, repeat: 5 });
    }
  }

  function hideScore() {
    if (!pod) return;
    pod.score = "";
    setPodMode("idle");
    drawScreen();
    if (pod.current !== pod.actions.idle) podAction("idle", { loop: true });
  }

  function setTarget(name, sub) {
    state.target = { name: name || "Agent under test", sub: sub || "" };
    if (!pod) return;
    pod.plate.querySelector("b").textContent = state.target.name;
    pod.plate.querySelector("span").textContent = state.target.sub;
    pod.plate.querySelector("span").style.display = state.target.sub ? "" : "none";
  }

  /* ---- outbox trays ---- */

  function buildTray(L, index, def) {
    const gap = L.trayGap;
    const y = (index - 1.5) * gap;
    const x = L.trayX;
    const group = new THREE.Group();
    group.position.set(x, 0, y);
    world.add(group);

    const W = Math.min(1.8, gap - 0.3);
    const DEPTH = 1.25;
    const H = 0.5;
    const binMat = new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.1 });
    const wallGeo = (sx, sy, sz, px, py, pz) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), binMat);
      m.position.set(px, py, pz);
      m.castShadow = true;
      m.receiveShadow = true;
      group.add(m);
    };
    wallGeo(DEPTH, 0.06, W, 0, 0.03, 0); // floor of the bin
    wallGeo(0.06, H, W, -DEPTH / 2, H / 2, 0); // back
    wallGeo(0.06, H * 0.55, W, DEPTH / 2, H * 0.275, 0); // front (low)
    wallGeo(DEPTH, H, 0.06, 0, H / 2, -W / 2); // sides
    wallGeo(DEPTH, H, 0.06, 0, H / 2, W / 2);
    const stripMat = new THREE.MeshBasicMaterial();
    const strip = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.1, W - 0.1), stripMat);
    strip.position.set(DEPTH / 2 + 0.035, 0.14, 0);
    group.add(strip);

    // standing counter sign
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 176;
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    const signMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true });
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.45, 1.0), signMat);
    sign.position.set(-DEPTH / 2 - 0.12, H + 0.78, 0);
    sign.rotation.y = Math.PI / 4;
    group.add(sign);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.8, 8), binMat);
    post.position.set(-DEPTH / 2 - 0.1, H + 0.2, 0);
    group.add(post);

    const stack = new THREE.Group();
    stack.position.set(0, 0.07, 0);
    group.add(stack);

    const rec = { def, group, index, canvas, tex, stack, sheets: [], count: 0, top: new THREE.Vector3(x, 0.5, y), W };
    state.trays.set(def.key, rec);

    addThemed(() => {
      const c = new THREE.Color(verdictColor(theme, def.key));
      binMat.color.copy(c).lerp(new THREE.Color(theme.dark ? 0x2a2620 : 0xffffff), 0.5);
      stripMat.color.copy(c);
      drawTraySign(rec);
    });
    drawTraySign(rec);
  }

  function drawTraySign(rec) {
    const c = rec.canvas;
    const g = c.getContext("2d");
    g.clearRect(0, 0, c.width, c.height);
    const col = verdictColor(theme, rec.def.key);
    g.fillStyle = theme.panel;
    g.strokeStyle = col;
    g.lineWidth = 8;
    g.beginPath();
    g.roundRect(6, 6, c.width - 12, c.height - 12, 26);
    g.fill();
    g.stroke();
    g.textAlign = "center";
    g.fillStyle = col;
    g.font = "700 34px 'Rubik', sans-serif";
    g.textBaseline = "alphabetic";
    g.fillText(rec.def.label, c.width / 2, 52);
    g.fillStyle = theme.text;
    g.font = "700 84px 'Frank Ruhl Libre', Georgia, serif";
    g.fillText(String(rec.count), c.width / 2, 142);
    rec.tex.needsUpdate = true;
  }

  function setTrayCount(rec, n, animate) {
    rec.count = n;
    drawTraySign(rec);
    // stack of sheets inside the bin, capped so it never overflows
    const target = Math.min(n, 16);
    while (rec.sheets.length > target) rec.stack.remove(rec.sheets.pop());
    while (rec.sheets.length < target) {
      const k = rec.sheets.length;
      const s = makeSheet();
      s.scale.set(0.8, 1, 0.8);
      const rnd = seeded(rec.index * 31 + k * 7 + 5);
      s.position.set((rnd() - 0.5) * 0.18, 0.012 + k * 0.026, (rnd() - 0.5) * 0.3);
      s.rotation.y = (rnd() - 0.5) * 0.7;
      rec.stack.add(s);
      rec.sheets.push(s);
      if (animate && gsap && motionOn() && k === target - 1) {
        gsap.from(s.position, { y: s.position.y + 0.5, duration: 0.25, ease: "bounce.out" });
      }
    }
    if (animate && gsap && motionOn()) {
      gsap.fromTo(rec.group.scale, { y: 1.18 }, { y: 1, duration: 0.35, ease: "back.out(3)", overwrite: "auto" });
    }
    rec.top.set(rec.group.position.x, 0.18 + target * 0.026, rec.group.position.z);
  }

  /* ---- desks, chairs, document piles ---- */

  function buildDesk(d) {
    const group = new THREE.Group();
    group.position.set(d.x, 0, d.y);
    world.add(group);
    const desk = shadows(fitProp(assets.props.desk, { scale: DESK_S, rotY: Math.PI / 2 }));
    group.add(desk);

    const chair = shadows(fitProp(assets.props.chairDesk, { scale: CHAIR_S, rotY: Math.PI / 2 }));
    chair.position.set(d.chair.x - d.x, 0, 0);
    group.add(chair);

    const lamp = shadows(fitProp(assets.props.lampRoundTable, { scale: 2.3 }));
    lamp.position.set(0.18, 0.87, -d.side * 0.62);
    group.add(lamp);
    const books = shadows(fitProp(assets.props.books, { scale: 2.6, rotY: 0.3 }));
    books.position.set(0.12, 0.87, d.side * 0.62);
    group.add(books);

    const pileG = new THREE.Group();
    pileG.position.set(-0.04, 0.87, 0);
    group.add(pileG);

    const hit = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.1, 1.9), new THREE.MeshBasicMaterial());
    hit.visible = false;
    hit.position.set(0, 0.55, 0);
    hit.userData.slot = d.slot;
    group.add(hit);
    hitTargets.push(hit);

    const accent = new THREE.Color().setHSL(d.hue / 360, 0.62, 0.5, THREE.SRGBColorSpace);
    const mark = new THREE.Mesh(
      new THREE.BoxGeometry(0.04, 0.012, 0.6),
      new THREE.MeshBasicMaterial({ color: accent }),
    );
    mark.position.set(-0.43, 0.874, 0);
    group.add(mark);

    return { group, pileG, hit, d };
  }

  function pileWorldTop(r) {
    const d = r.desk.d;
    const y = 0.87 + 0.02 + Math.max(r.pile.length, 1) * (SHEET_H + 0.004);
    return new THREE.Vector3(d.x - 0.04, y, d.y);
  }

  function pileSheet(r, k, animate) {
    const rnd = seeded(r.desk.d.slot * 17 + k * 5 + 3);
    const s = makeSheet();
    s.position.set((rnd() - 0.5) * 0.12, 0.012 + k * (SHEET_H + 0.004), (rnd() - 0.5) * 0.18);
    s.rotation.y = (rnd() - 0.5) * 0.5;
    r.desk.pileG.add(s);
    r.pile.push(s);
    if (animate && gsap && motionOn()) {
      gsap.from(s.position, { y: s.position.y + 0.9, duration: 0.35, ease: "bounce.out" });
    }
    return s;
  }

  function resetPile(r, animate) {
    for (const s of r.pile) r.desk.pileG.remove(s);
    r.pile = [];
    for (let k = 0; k < PILE_BASE; k += 1) {
      const s = pileSheet(r, k, false);
      if (animate && gsap && motionOn()) gsap.from(s.position, { y: s.position.y + 0.4, duration: 0.3, delay: k * 0.07 });
    }
  }

  /* ---- judges ---- */

  function buildJudge(d, desk) {
    const variant = assets.characters[d.slot % assets.characters.length];
    if (!robeMaterial) {
      let image = null;
      variant.scene.traverse((o) => {
        if (!image && o.isMesh && o.material.map) image = o.material.map.image;
      });
      robeMaterial = new THREE.MeshStandardMaterial({ map: makeRobeTexture(image), roughness: 0.85, metalness: 0 });
    }
    const model = cloneSkinned(variant.scene);
    model.scale.setScalar(CHAR_S);
    const group = new THREE.Group();
    group.add(model);
    world.add(group);

    const bones = {};
    model.traverse((o) => {
      if (o.name) bones[o.name] = o;
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
        o.frustumCulled = false;
        if (o.name === "body-mesh") o.material = robeMaterial;
      }
    });

    const accent = new THREE.Color().setHSL(d.hue / 360, 0.62, 0.5, THREE.SRGBColorSpace);
    // collar + jabot
    const collar = new THREE.Mesh(
      new THREE.TorusGeometry(0.095, 0.022, 8, 24),
      new THREE.MeshStandardMaterial({ color: accent, roughness: 0.5 }),
    );
    collar.rotation.x = Math.PI / 2;
    collar.position.set(0, 0.145, 0.025);
    bones.torso.add(collar);
    const jabot = new THREE.Mesh(
      new THREE.BoxGeometry(0.07, 0.1, 0.03),
      new THREE.MeshStandardMaterial({ color: 0xf8f4ea, roughness: 0.7 }),
    );
    jabot.position.set(0, 0.095, 0.115);
    bones.torso.add(jabot);

    // gavel in the right hand
    const gavel = new THREE.Group();
    const wood = new THREE.MeshStandardMaterial({ color: 0x8a5a2b, roughness: 0.6 });
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.16, 8), wood);
    handle.position.y = -0.04;
    const gHead = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.1, 12), new THREE.MeshStandardMaterial({ color: 0xa8733a, roughness: 0.5 }));
    gHead.rotation.z = Math.PI / 2;
    gHead.position.y = 0.04;
    gavel.add(handle, gHead);
    gavel.position.set(0, -0.1, 0.03);
    gavel.rotation.x = Math.PI / 2;
    gavel.traverse((o) => { o.castShadow = true; });
    bones["arm-right"].add(gavel);

    // carried sheet / note at the chest
    const carry = new THREE.Group();
    carry.position.set(0, 0.02, 0.17);
    carry.rotation.x = -0.5;
    carry.scale.setScalar(0.4);
    const carrySheet = makeSheet(false);
    const carryNote = makeSheet(true);
    carry.add(carrySheet, carryNote);
    carry.visible = false;
    bones.torso.add(carry);

    // click / hover target
    const hit = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 1.7, 10), new THREE.MeshBasicMaterial());
    hit.visible = false;
    hit.position.y = 0.85;
    hit.userData.slot = d.slot;
    group.add(hit);
    hitTargets.push(hit);

    // selection / hover ring on the floor
    const ringMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.46, 0.58, 40), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.025;
    group.add(ring);

    // head anchor for the HTML label
    const headAnchor = new THREE.Object3D();
    headAnchor.position.set(0, 1.62, 0);
    group.add(headAnchor);

    // mixer + clips
    const clips = buildClips(variant);
    const mixer = new THREE.AnimationMixer(model);
    const actions = {};
    for (const [name, clip] of Object.entries(clips)) if (clip) actions[name] = mixer.clipAction(clip);

    // HTML label
    const ui = document.createElement("div");
    ui.className = "jl off";
    ui.style.setProperty("--jc", `hsl(${d.hue} 62% 50%)`);
    ui.innerHTML = '<div class="emote"><img alt="" draggable="false"><span class="t"></span></div><div class="jnum"></div>';
    overlay.appendChild(ui);

    const r = {
      slot: d.slot,
      desk,
      group,
      model,
      bones,
      mixer,
      actions,
      current: null,
      pose: "idle",
      pos: { x: d.chair.x + 0.1, y: d.y },
      rotY: Math.PI / 2,
      lift: SEAT_Y,
      sit: true,
      headBow: 0,
      where: "desk",
      q: null,
      spot: null,
      queued: null,
      countdown: null,
      verdictKey: "",
      pile: [],
      carry,
      carrySheet,
      carryNote,
      gavel,
      ring,
      ringMat,
      headAnchor,
      accent,
      bubbleKey: "",
      tagKey: "",
      ui: {
        root: ui,
        emote: ui.querySelector(".emote"),
        img: ui.querySelector("img"),
        txt: ui.querySelector(".t"),
        num: ui.querySelector(".jnum"),
      },
      screen: { x: 0, y: 0, behind: false },
    };
    r.verdictBubble = null;
    setPose(r, "sit", true);
    setSit(r, true, true);
    place(r);
    return r;
  }

  const HEAD_FREE = new Set(["sit", "read", "write"]); // clips that leave the head alone
  const POSE_CLIP = {
    idle: "idle", wait: "idle", walk: "walk", sit: "sit", read: "sit", write: "sit",
    stamp: "stamp", cheer: "cheer", shock: "shock",
  };
  const HEAD_BOW = { read: 0.38, write: 0.55, sit: 0 };

  function setPose(r, pose, instant = false) {
    r.pose = pose;
    const clip = POSE_CLIP[pose] || "idle";
    const next = r.actions[clip];
    if (!next) return;
    const once = pose === "stamp";
    if (r.current !== next || once) {
      next.reset();
      next.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
      next.clampWhenFinished = once;
      next.timeScale = pose === "walk" ? WALK_RATE : 1;
      if (r.current && r.current !== next) {
        if (instant || !motionOn()) {
          r.current.stop();
          next.play();
        } else {
          next.fadeIn(0.16).play();
          r.current.fadeOut(0.16);
        }
      } else {
        next.play();
      }
      r.current = next;
      r.currentClip = clip;
    }
    const bow = HEAD_BOW[pose] || 0;
    if (gsap && motionOn() && !instant) gsap.to(r, { headBow: bow, duration: 0.3, overwrite: "auto" });
    else r.headBow = bow;
    if (!motionOn()) r.mixer.update(0);
  }

  function place(r) {
    r.group.position.set(r.pos.x, r.lift, r.pos.y);
    r.group.rotation.y = r.rotY;
  }

  function setSit(r, sit, instant = false) {
    r.sit = sit;
    const to = sit ? SEAT_Y : 0;
    if (!gsap || !motionOn() || instant) {
      r.lift = to;
      place(r);
      return;
    }
    gsap.to(r, { lift: to, duration: 0.18, ease: "power1.out", overwrite: "auto", onUpdate: () => place(r) });
  }

  function setBubble(r, kind, text = "", warn = false) {
    const el = r.ui.emote;
    const key = `${kind}|${text}|${warn}`;
    if (r.bubbleKey === key) return;
    r.bubbleKey = key;
    if (!kind) {
      el.classList.remove("show", "warn");
      return;
    }
    const url = emojiUrl(kind);
    if (r.ui.img.getAttribute("src") !== url) r.ui.img.setAttribute("src", url);
    r.ui.txt.textContent = text;
    el.classList.add("show");
    el.classList.toggle("warn", warn);
  }

  function setTag(r, n, key = "") {
    const k = `${n}|${key}`;
    if (r.tagKey === k) return;
    r.tagKey = k;
    r.ui.root.classList.remove("off");
    r.ui.num.textContent = `#${n}`;
    r.ui.num.className = `jnum ${key}`.trim();
  }

  function setCarry(r, kind) {
    r.carry.visible = Boolean(kind);
    r.carrySheet.visible = kind === "sheet";
    r.carryNote.visible = kind === "note";
  }

  /* ------------------------------------------------------------- camera */

  const tmpCam = new THREE.OrthographicCamera();
  function frame(L, animate) {
    const aspect = state.size.w / Math.max(1, state.size.h);
    const target = new THREE.Vector3((L.xMin + L.xMax) / 2, 0.9, 0);
    tmpCam.position.copy(target).addScaledVector(CAM_DIR, 80);
    tmpCam.lookAt(target);
    tmpCam.updateMatrixWorld(true);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    const v = new THREE.Vector3();
    for (const x of [L.xMin - 0.6, L.xMax + 0.6]) {
      for (const z of [-L.halfW - 1, L.halfW + 1]) {
        for (const y of [0, WALL_H]) {
          v.set(x, y, z).applyMatrix4(tmpCam.matrixWorldInverse);
          minX = Math.min(minX, v.x);
          maxX = Math.max(maxX, v.x);
          minY = Math.min(minY, v.y);
          maxY = Math.max(maxY, v.y);
        }
      }
    }
    const halfH = Math.max((maxY - minY) / 2, (maxX - minX) / 2 / aspect) * 1.04 + 0.2;
    const right = new THREE.Vector3().setFromMatrixColumn(tmpCam.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(tmpCam.matrixWorld, 1);
    const shift = right.multiplyScalar((minX + maxX) / 2).add(up.multiplyScalar((minY + maxY) / 2));
    const home = {
      target: target.clone().add(shift),
      position: tmpCam.position.clone().add(shift),
      halfH,
    };
    state.home = home;
    applyFrustum();
    const jump = !animate || !gsap || !motionOn();
    if (jump) {
      camera.position.copy(home.position);
      controls.target.copy(home.target);
      camera.zoom = 1;
      camera.updateProjectionMatrix();
      controls.update();
    } else {
      resetView();
    }
  }

  function applyFrustum() {
    if (!state.home) return;
    const aspect = state.size.w / Math.max(1, state.size.h);
    const h = state.home.halfH;
    camera.left = -h * aspect;
    camera.right = h * aspect;
    camera.top = h;
    camera.bottom = -h;
    camera.updateProjectionMatrix();
  }

  function resetView() {
    if (!state.home) return;
    const home = state.home;
    if (!gsap || !motionOn()) {
      camera.position.copy(home.position);
      controls.target.copy(home.target);
      camera.zoom = 1;
      camera.updateProjectionMatrix();
      controls.update();
      return;
    }
    gsap.killTweensOf(camera);
    gsap.killTweensOf(camera.position);
    gsap.killTweensOf(controls.target);
    gsap.to(camera.position, { x: home.position.x, y: home.position.y, z: home.position.z, duration: 0.8, ease: "power2.inOut" });
    gsap.to(controls.target, { x: home.target.x, y: home.target.y, z: home.target.z, duration: 0.8, ease: "power2.inOut" });
    gsap.to(camera, { zoom: 1, duration: 0.8, ease: "power2.inOut", onUpdate: () => camera.updateProjectionMatrix() });
  }

  function pushIn(L) {
    if (!gsap || !motionOn()) return;
    gsap.to(camera, { zoom: 1.28, duration: 1.6, ease: "power2.inOut", overwrite: "auto", onUpdate: () => camera.updateProjectionMatrix() });
    if (state.home) {
      const t = state.home.target.clone();
      t.x += (L.trayX - 3 - t.x) * 0.45;
      gsap.to(controls.target, { x: t.x, y: t.y, z: t.z, duration: 1.6, ease: "power2.inOut" });
      const p = state.home.position.clone();
      p.x += t.x - state.home.target.x;
      gsap.to(camera.position, { x: p.x, y: p.y, z: p.z, duration: 1.6, ease: "power2.inOut" });
    }
  }

  function configureLight(L) {
    const cx = (L.xMin + L.xMax) / 2;
    const R = Math.hypot(L.xMax - L.xMin, L.halfW * 2) / 2 + 2;
    sun.position.set(cx - 5, 17, 16);
    sun.target.position.set(cx, 0, 0);
    const cam = sun.shadow.camera;
    cam.left = -R;
    cam.right = R;
    cam.top = R;
    cam.bottom = -R;
    cam.near = 1;
    cam.far = 70;
    cam.updateProjectionMatrix();
  }

  function applyTheme() {
    theme = readTheme();
    if (theme.dark) {
      hemi.color.set(0x8fa3c4);
      hemi.groundColor.set(0x2a2018);
      hemi.intensity = 0.95;
      sun.color.set(0xffe2b8);
      sun.intensity = 1.5;
      podLight.intensity = 22;
    } else {
      hemi.color.set(0xfff6e6);
      hemi.groundColor.set(0xcfc2a8);
      hemi.intensity = 1.45;
      sun.color.set(0xffffff);
      sun.intensity = 2.2;
      podLight.intensity = 8;
    }
    for (const fn of themed) fn();
  }

  /* ------------------------------------------------------------- GSAP plumbing */

  function timeline(speed) {
    let resolve;
    const done = new Promise((res) => { resolve = res; });
    const tl = gsap.timeline({ onComplete: () => { state.active.delete(tl); resolve(); } });
    tl._done = done;
    tl._resolve = resolve;
    tl._base = speed;
    state.active.add(tl);
    return tl;
  }

  /* Zero-length timelines (only .call()s) can finish before anyone listens and
     never report completion again, so back the promise with a short timer. */
  function settle(tl) {
    if (tl.duration() === 0) {
      // GSAP never fires the callbacks of an empty timeline whose timeScale is
      // not 1, so only scale timelines that actually have length.
      gsap.delayedCall(0.05, () => { state.active.delete(tl); tl._resolve(); });
    } else {
      tl.timeScale(tl._base * state.timeScale);
    }
    return tl._done;
  }

  function killAll() {
    if (gsap) {
      for (const tl of state.active) tl.kill();
      for (const r of state.runners) {
        gsap.killTweensOf(r);
        gsap.killTweensOf(r.pos);
        if (r.countdown) { r.countdown.kill(); r.countdown = null; }
      }
    }
    state.active.clear();
    if (pod && pod.dotTimer) { clearInterval(pod.dotTimer); pod.dotTimer = null; }
  }

  function clearFx() {
    for (const fx of state.fx) {
      if (fx.tween) fx.tween.kill();
      if (fx.obj && fx.obj.parent) fx.obj.parent.remove(fx.obj);
    }
    state.fx.clear();
  }

  /* A one-off effect object with its own tween, tracked so clearRun can drop it. */
  function fxObject(obj, parent = world) {
    const fx = { obj, tween: null };
    state.fx.add(fx);
    parent.add(obj);
    fx.finish = () => {
      if (obj.parent) obj.parent.remove(obj);
      state.fx.delete(fx);
    };
    return fx;
  }

  function turnTo(tl, r, ang, state2) {
    const target = shortestAngle(state2.rot, ang);
    state2.rot = target;
    if (!motionOn()) {
      tl.call(() => { r.rotY = target; place(r); });
      return;
    }
    tl.to(r, { rotY: target, duration: 0.14, ease: "power1.out", onUpdate: () => place(r) });
  }

  function walk(tl, r, points, endPose, endSit = false, endAngle = null) {
    tl.call(() => {
      if (r.sit) setSit(r, false);
      setPose(r, "walk");
      r.where = "walking";
    });
    let prev = { x: r.pos.x, y: r.pos.y };
    const rot = { rot: r.rotY };
    for (const p of points) {
      const dist = Math.hypot(p.x - prev.x, p.y - prev.y);
      if (dist < 1e-3) continue;
      const dur = D(Math.max(0.1, dist / WALK_SPEED));
      turnTo(tl, r, Math.atan2(p.x - prev.x, p.y - prev.y), rot);
      tl.to(r.pos, { x: p.x, y: p.y, duration: dur, ease: "none", onUpdate: () => place(r) });
      if (!dur) tl.call(() => { r.pos.x = p.x; r.pos.y = p.y; place(r); });
      prev = p;
    }
    if (endAngle != null) turnTo(tl, r, endAngle, rot);
    tl.call(() => {
      place(r);
      if (endSit) setSit(r, true);
      setPose(r, endPose);
    });
  }

  /* ------------------------------------------------------- places and paths */

  const spotPos = (k) => ({ x: 1.5 + Math.floor(k / 2) * 0.95, y: k % 2 === 0 ? -0.55 : 0.55 });
  const queuePos = (j) => ({ x: 3.2 + j * 0.95, y: 0 });

  function claim(list, r, key) {
    let i = list.indexOf(null);
    if (i < 0) i = list.length;
    list[i] = r;
    r[key] = i;
    return i;
  }

  function release(r) {
    if (r.spot != null) { state.spots[r.spot] = null; r.spot = null; }
    if (r.queued != null) { state.queue[r.queued] = null; r.queued = null; }
    if (r.countdown) { r.countdown.kill(); r.countdown = null; }
    updatePod();
  }

  /* Leaving or reaching a desk goes round the side of the chair, so nobody
     walks through a backrest. */
  function sidestep(r) {
    return r.desk.d.y - r.desk.d.side * 0.95;
  }
  function pathToAgent(r, target) {
    const d = r.desk.d;
    if (r.where === "desk") {
      const sy = sidestep(r);
      return [{ x: d.chair.x, y: sy }, { x: d.laneX, y: sy }, { x: d.laneX, y: 0 }, { x: target.x, y: 0 }, { x: target.x, y: target.y }];
    }
    return [{ x: target.x, y: target.y }];
  }
  function pathToDesk(r) {
    const d = r.desk.d;
    const sy = sidestep(r);
    return [{ x: d.laneX, y: 0 }, { x: d.laneX, y: sy }, { x: d.chair.x, y: sy }, { x: d.chair.x + 0.1, y: d.y }];
  }
  function faceAgent(r) {
    // judges at the agent look towards it (negative x)
    return -Math.PI / 2;
  }

  /* --------------------------------------------------------- effects */

  const FX_COLORS = () => [theme.ok, theme.partial, theme.false, theme.error, theme.accent, "#f3d36b"];

  function burst(at, color) {
    if (!gsap || !motionOn()) return;
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true });
    for (let i = 0; i < 9; i += 1) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(0.05 + (i % 3) * 0.015, 8, 6), mat.clone());
      m.position.copy(at);
      const fx = fxObject(m);
      const ang = (i / 9) * Math.PI * 2;
      fx.tween = gsap.to(m.position, {
        x: at.x + Math.cos(ang) * 0.7,
        z: at.z + Math.sin(ang) * 0.7,
        y: at.y + 0.5 + (i % 2) * 0.25,
        duration: 0.55,
        ease: "power2.out",
        onComplete: fx.finish,
      });
      gsap.to(m.material, { opacity: 0, duration: 0.55, ease: "power1.in" });
    }
    mat.dispose();
  }

  function smoke(at) {
    if (!gsap || !motionOn()) return;
    for (let i = 0; i < 6; i += 1) {
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(0.16 + i * 0.015, 10, 8),
        new THREE.MeshBasicMaterial({ color: theme.dark ? 0x9a9488 : 0x58524a, transparent: true, opacity: 0.7, depthWrite: false }),
      );
      m.position.set(at.x + (i - 2.5) * 0.09, at.y, at.z + ((i * 7) % 3) * 0.06);
      const fx = fxObject(m);
      fx.tween = gsap.to(m.position, {
        y: at.y + 1.2 + i * 0.12,
        x: m.position.x + (i - 2.5) * 0.11,
        duration: 1.2,
        delay: i * 0.08,
        ease: "power1.out",
        onComplete: fx.finish,
      });
      gsap.to(m.scale, { x: 2.2, y: 2.2, z: 2.2, duration: 1.2, delay: i * 0.08 });
      gsap.to(m.material, { opacity: 0, duration: 1.2, delay: i * 0.08, ease: "power1.in" });
    }
  }

  function confetti(at) {
    if (!gsap || !motionOn()) return;
    const colors = FX_COLORS();
    const geo = new THREE.PlaneGeometry(0.11, 0.07);
    for (let i = 0; i < 90; i += 1) {
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: colors[i % colors.length], side: THREE.DoubleSide }));
      m.position.set(at.x + (Math.random() - 0.5) * 1.5, at.y, at.z + (Math.random() - 0.5) * 3);
      m.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
      const fx = fxObject(m);
      const dx = (Math.random() - 0.5) * 3.5;
      const dz = (Math.random() - 0.5) * 6;
      const peak = at.y + 2.2 + Math.random() * 2.2;
      const tl = gsap.timeline({ onComplete: fx.finish });
      fx.tween = tl;
      tl.to(m.position, { x: m.position.x + dx * 0.5, z: m.position.z + dz * 0.5, y: peak, duration: 0.7 + Math.random() * 0.3, ease: "power2.out" });
      tl.to(m.position, { x: m.position.x + dx, z: m.position.z + dz, y: 0.05, duration: 1.8 + Math.random() * 1.2, ease: "power1.in" });
      tl.to(m.rotation, { x: m.rotation.x + 14, y: m.rotation.y + 10, duration: 2.8, ease: "none" }, 0);
    }
  }

  function stampTexture(key) {
    if (sheetTextures[key + theme.dark]) return sheetTextures[key + theme.dark];
    const rec = TRAYS.find((t) => t.key === key);
    const c = document.createElement("canvas");
    c.width = 384;
    c.height = 150;
    const g = c.getContext("2d");
    const col = verdictColor(theme, key);
    g.strokeStyle = col;
    g.fillStyle = col;
    g.lineWidth = 12;
    g.beginPath();
    g.roundRect(10, 10, 364, 130, 22);
    g.stroke();
    g.font = "800 84px 'Rubik', sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(rec.label, 192, 80);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    sheetTextures[key + theme.dark] = t;
    return t;
  }

  let booting = true; // the page is not ready for callbacks until createScene returns
  function notifyCount() {
    if (!booting && handlers.onCount) handlers.onCount({ ...state.counts });
  }

  function land(key) {
    const rec = state.trays.get(key);
    if (!rec) return;
    state.counts[rec.def.verdict] += 1;
    setTrayCount(rec, state.counts[rec.def.verdict], true);
    notifyCount();
  }

  /* A sheet (or the two halves of a torn one) arcs from `from` into a tray. */
  function flight(r, key, torn, speed, from) {
    const rec = state.trays.get(key);
    if (!rec) return;
    const start = (from || pileWorldTop(r)).clone();
    const end = rec.top.clone();
    if (!gsap || !motionOn()) {
      land(key);
      return;
    }
    const pieces = torn ? [makeSheet(false, true), makeSheet(false, true)] : [makeSheet()];
    const holder = new THREE.Group();
    pieces.forEach((p, i) => { p.position.z = torn ? (i ? 0.14 : -0.14) : 0; holder.add(p); });
    const fx = fxObject(holder);
    holder.position.copy(start);
    const proxy = { t: 0 };
    const tl = gsap.timeline({
      onComplete: () => { fx.finish(); state.active.delete(tl); land(key); },
    });
    tl._base = speed;
    fx.tween = tl;
    const lift = 1.6 + start.distanceTo(end) * 0.12;
    tl.to(proxy, {
      t: 1,
      duration: 0.95,
      ease: "power1.inOut",
      onUpdate: () => {
        const t = proxy.t;
        holder.position.set(
          start.x + (end.x - start.x) * t,
          start.y + (end.y - start.y) * t + Math.sin(t * Math.PI) * lift,
          start.z + (end.z - start.z) * t,
        );
        holder.rotation.y = t * 5;
        holder.rotation.x = Math.sin(t * Math.PI) * 0.6;
        if (torn) {
          pieces[0].position.z = -0.14 - t * 0.35;
          pieces[1].position.z = 0.14 + t * 0.35;
          pieces[0].rotation.z = -t * 1.4;
          pieces[1].rotation.z = t * 1.2;
        }
      },
    });
    tl.timeScale(speed * state.timeScale);
    state.active.add(tl);
  }

  /* ------------------------------------------------------------ actions */

  function mixerRate(speed) {
    return Math.min(3, speed * state.timeScale);
  }

  const ACTIONS = {
    start(r, a, speed) {
      const tl = timeline(speed);
      r.mixer.timeScale = mixerRate(speed);
      release(r);
      const spot = claim(state.spots, r, "spot");
      const target = spotPos(spot);
      r.q = a.n;
      r.verdictKey = "";
      tl.call(() => {
        setTag(r, a.n);
        setBubble(r, "");
        resetPile(r, true);
        setCarry(r, "sheet");
        updatePod();
      });
      walk(tl, r, pathToAgent(r, target), "wait", false, faceAgent(r));
      tl.call(() => {
        r.where = "agent";
        setCarry(r, null);
        setBubble(r, "think");
        podAction("work", { loop: true });
      });
      return settle(tl);
    },

    retry(r, a, speed) {
      const tl = timeline(speed);
      r.mixer.timeScale = mixerRate(speed);
      if (r.queued == null) {
        if (r.spot != null) { state.spots[r.spot] = null; r.spot = null; }
        const j = claim(state.queue, r, "queued");
        if (r.where === "agent" || r.where === "queue") {
          const target = queuePos(j);
          walk(tl, r, [{ x: target.x, y: target.y }], "wait", false, faceAgent(r));
        }
      }
      if (r.countdown) r.countdown.kill();
      const secs = Math.max(1, Math.round(a.delayMs / 1000));
      tl.call(() => {
        r.where = "queue";
        updatePod();
        setBubble(r, "hourglass", `429 · ${secs}s`, true);
        if (gsap && motionOn()) {
          const c = { v: secs };
          r.countdown = gsap.to(c, {
            v: 0,
            duration: Math.max(0.5, a.delayMs / 1000 / state.clockSpeed),
            ease: "none",
            onUpdate: () => setBubble(r, "hourglass", `429 · ${Math.max(0, Math.ceil(c.v))}s`, true),
            onComplete: () => setBubble(r, "hourglass", `retry ${a.attempt + 1}/${a.of}`, true),
          });
        }
      });
      return settle(tl);
    },

    answer(r, a, speed) {
      const tl = timeline(speed);
      r.mixer.timeScale = mixerRate(speed);
      tl.call(() => {
        release(r);
        setBubble(r, "");
        setCarry(r, "sheet");
        podAction("yes", { rate: 1.4 });
      });
      walk(tl, r, pathToDesk(r), "read", true, Math.PI / 2);
      tl.call(() => {
        r.where = "desk";
        setCarry(r, null);
        pileSheet(r, r.pile.length, true);
        setBubble(r, "read");
      });
      tl.to({}, { duration: D(0.4) });
      return settle(tl);
    },

    followup(r, a, speed) {
      const tl = timeline(speed);
      r.mixer.timeScale = mixerRate(speed);
      const slot = claim(state.spots, r, "spot");
      const target = spotPos(slot);
      tl.call(() => {
        setPose(r, "write");
        setBubble(r, "note", "note");
      });
      tl.to({}, { duration: D(0.8) });
      tl.call(() => {
        setCarry(r, "note");
        setBubble(r, "");
        updatePod();
      });
      walk(tl, r, pathToAgent(r, target), "wait", false, faceAgent(r));
      tl.call(() => {
        r.where = "agent";
        setCarry(r, null);
        setBubble(r, "think");
        podAction("work", { loop: true });
      });
      return settle(tl);
    },

    stamp(r, a, speed) {
      const tr = trayFor(a.verdict);
      const key = tr.key;
      const tl = timeline(speed);
      r.mixer.timeScale = mixerRate(speed);
      const top = pileWorldTop(r);
      let stampFx = null;
      tl.call(() => {
        release(r);
        setBubble(r, "hammer");
        setPose(r, "stamp");
      });
      // the gavel comes down about 0.29 s into the swing
      tl.to({}, { duration: D(0.27) });
      tl.call(() => {
        if (!gsap || !motionOn()) return;
        const mat = new THREE.MeshBasicMaterial({ map: stampTexture(key), transparent: true, depthWrite: false });
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.43), mat);
        mesh.rotation.set(-Math.PI / 2, 0, 0);
        mesh.rotation.z = 0.15;
        mesh.position.set(top.x, top.y + 0.9, top.z);
        mesh.scale.setScalar(2.2);
        mat.opacity = 0;
        stampFx = fxObject(mesh);
        stampFx.tween = gsap.to(mesh.position, { y: top.y + 0.04, duration: 0.14, ease: "power4.in" });
        gsap.to(mesh.scale, { x: 1, y: 1, z: 1, duration: 0.14, ease: "power4.in" });
        gsap.to(mat, { opacity: 1, duration: 0.14 });
        burst(new THREE.Vector3(top.x, top.y + 0.1, top.z), verdictColor(theme, key));
      });
      tl.to({}, { duration: D(0.2) });
      tl.call(() => setBubble(r, key, tr.label));
      tl.to({}, { duration: D(0.35) });
      tl.call(() => {
        flight(r, key, false, speed);
        const topSheet = r.pile.pop();
        if (topSheet) r.desk.pileG.remove(topSheet);
        if (stampFx) stampFx.finish();
        r.verdictKey = key;
        setTag(r, r.q, key);
        r.where = "desk";
        setPose(r, "sit");
        podAction(key === "ok" ? "yes" : key === "false" ? "no" : "idle", { rate: 1.3 });
      });
      tl.to({}, { duration: D(0.45) });
      tl.call(() => setBubble(r, ""));
      return settle(tl);
    },

    error(r, a, speed) {
      const tl = timeline(speed);
      r.mixer.timeScale = mixerRate(speed);
      const atDesk = r.where === "desk";
      tl.call(() => {
        release(r);
        setBubble(r, "error", "error", true);
        setPose(r, atDesk ? "sit" : "shock");
        if (pod && gsap && motionOn()) gsap.fromTo(pod.uniforms.uGlitch, { value: 1 }, { value: 0, duration: 0.9, ease: "power2.out" });
        smoke(new THREE.Vector3(r.pos.x, 1.3 + r.lift, r.pos.y));
      });
      tl.to({}, { duration: D(0.6) });
      tl.call(() => {
        const from = atDesk ? null : new THREE.Vector3(r.pos.x, 1.0, r.pos.y);
        flight(r, "error", true, speed, from);
        if (atDesk) {
          const topSheet = r.pile.pop();
          if (topSheet) r.desk.pileG.remove(topSheet);
        }
        r.verdictKey = "error";
        if (r.q != null) setTag(r, r.q, "error");
        setCarry(r, null);
        if (atDesk) setPose(r, "sit");
      });
      if (!atDesk) {
        walk(tl, r, pathToDesk(r), "sit", true, Math.PI / 2);
        tl.call(() => { r.where = "desk"; });
      }
      tl.to({}, { duration: D(0.35) });
      tl.call(() => setBubble(r, ""));
      return settle(tl);
    },

    finale(r, a, speed) {
      const tl = timeline(speed);
      r.mixer.timeScale = mixerRate(speed);
      const L = state.layout;
      const n = L.n;
      const gap = Math.min(1.25, (L.halfW * 1.7) / Math.max(n, 1));
      const target = { x: L.trayX - 2.6 - (r.slot % 2) * 0.8, y: (r.slot - (n - 1) / 2) * gap };
      tl.call(() => {
        release(r);
        setBubble(r, "");
        setCarry(r, null);
        if (!state.finale) {
          state.finale = true;
          showScore(a.summary, a.stopped);
          if (!a.stopped) {
            confetti(new THREE.Vector3(L.trayX - 4, 0.4, 0));
            pushIn(L);
          }
        }
      });
      const d = r.desk.d;
      let pts;
      if (r.where === "desk") {
        const sy = sidestep(r);
        pts = [{ x: d.chair.x, y: sy }, { x: d.laneX, y: sy }, { x: d.laneX, y: 0 }, { x: target.x, y: 0 }, target];
      } else {
        pts = [{ x: Math.max(r.pos.x, d.laneX), y: 0 }, { x: target.x, y: 0 }, target];
      }
      walk(tl, r, pts, a.stopped ? "idle" : "cheer", false, Math.PI / 4);
      tl.call(() => {
        r.where = "front";
        if (!a.stopped) setBubble(r, "party");
      });
      return settle(tl);
    },
  };

  function play(slot, action, speed = 1) {
    const r = state.runners[slot];
    const fn = ACTIONS[action.type];
    if (!r || !fn || !gsap) return undefined;
    return fn(r, action, speed);
  }

  /* ---------------------------------------------------- run lifecycle */

  function clearRun() {
    if (!state.layout) return;
    killAll();
    clearFx();
    state.spots = [];
    state.queue = [];
    state.counts = { OK: 0, PARTIAL: 0, FALSE: 0, ERROR: 0 };
    state.finale = false;
    for (const rec of state.trays.values()) setTrayCount(rec, 0, false);
    for (const r of state.runners) {
      r.pos.x = r.desk.d.chair.x + 0.1;
      r.pos.y = r.desk.d.y;
      r.rotY = Math.PI / 2;
      r.where = "desk";
      r.q = null;
      r.spot = null;
      r.queued = null;
      r.verdictKey = "";
      r.tagKey = "";
      r.ui.root.classList.add("off");
      setBubble(r, "");
      setCarry(r, null);
      setSit(r, true, true);
      setPose(r, "sit", true);
      place(r);
      resetPile(r, false);
    }
    hideScore();
    updatePod();
    if (state.home) resetView();
    notifyCount();
  }

  /* Put every judge where the log says they are, without animating. */
  function restore(slotStates, counts) {
    clearRun();
    for (const rec of state.trays.values()) {
      const bucket = rec.def.verdict;
      state.counts[bucket] = (counts && counts[bucket]) || 0;
      setTrayCount(rec, state.counts[bucket], false);
    }
    for (const s of slotStates) {
      const r = state.runners[s.index];
      if (!r || s.state.n == null) continue;
      const st = s.state;
      r.q = st.n;
      const key = st.phase === "done" ? trayFor(st.verdict).key : "";
      setTag(r, st.n, key);
      if (st.phase === "done") {
        r.verdictKey = key;
      } else if (st.phase === "reading") {
        for (let k = 0; k < st.turns; k += 1) pileSheet(r, r.pile.length, false);
        setPose(r, "read", true);
        setBubble(r, "read");
      } else if (st.phase === "atAgent" || st.phase === "start") {
        setSit(r, false, true);
        if (st.retrying) {
          const j = claim(state.queue, r, "queued");
          Object.assign(r.pos, queuePos(j));
          r.where = "queue";
          setBubble(r, "hourglass", "429", true);
        } else {
          const k = claim(state.spots, r, "spot");
          Object.assign(r.pos, spotPos(k));
          r.where = "agent";
          setBubble(r, "think");
        }
        r.rotY = faceAgent(r);
        setPose(r, "wait", true);
        place(r);
      }
    }
    updatePod();
  }

  function setClock(speed) {
    state.clockSpeed = Math.max(0.25, speed);
    state.timeScale = Math.min(16, Math.max(0.5, speed));
    for (const tl of state.active) if (tl.duration() > 0) tl.timeScale((tl._base || 1) * state.timeScale);
  }

  function pause(value) {
    state.paused = Boolean(value);
    if (gsap) gsap.globalTimeline.paused(state.paused);
  }

  function select(slot) {
    state.selected = slot;
    refreshRings();
  }

  function refreshRings() {
    const accent = new THREE.Color(theme.accent);
    for (const r of state.runners) {
      const isSel = r.slot === state.selected;
      const isHover = r.slot === state.hoverSlot;
      r.ringMat.color.copy(accent);
      r.ringMat.opacity = isSel ? 0.95 : isHover ? 0.6 : 0;
    }
  }

  /* ------------------------------------------------- pointer: hover + click */

  const ray = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let downAt = null;
  let lastMove = null;
  let moveQueued = false;

  function pick(event) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    ray.setFromCamera(pointer, camera);
    const hits = ray.intersectObjects(hitTargets, false);
    return hits.length ? hits[0].object.userData.slot : null;
  }

  function setHover(slot, event) {
    if (state.hoverSlot !== slot) {
      state.hoverSlot = slot;
      refreshRings();
      container.classList.toggle("grab", slot != null);
    }
    if (handlers.onHover) handlers.onHover(slot, event || null);
  }

  renderer.domElement.addEventListener("pointermove", (e) => {
    if (e.buttons) {
      if (state.hoverSlot != null) setHover(null);
      return;
    }
    lastMove = e;
    if (moveQueued) return;
    moveQueued = true;
    requestAnimationFrame(() => {
      moveQueued = false;
      if (lastMove) setHover(pick(lastMove), lastMove);
    });
  });
  renderer.domElement.addEventListener("pointerleave", () => setHover(null));
  renderer.domElement.addEventListener("pointerdown", (e) => { downAt = { x: e.clientX, y: e.clientY }; });
  renderer.domElement.addEventListener("pointerup", (e) => {
    if (!downAt) return;
    const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
    downAt = null;
    if (moved > 5) return;
    const slot = pick(e);
    if (slot != null && handlers.onPick) handlers.onPick(slot);
  });

  /* ------------------------------------------------------ render loop */

  const clock = new THREE.Clock();
  const P = { x: 0, y: 0, behind: false };

  function updateOverlay() {
    for (const r of state.runners) {
      if (r.ui.root.classList.contains("off")) continue;
      project(r.headAnchor, r.screen);
      const s = r.screen;
      r.ui.root.style.transform = `translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px) translate(-50%, -100%)`;
    }
    if (pod && pod.plate) {
      project(pod.plateAnchor, P);
      pod.plate.style.transform = `translate(${P.x.toFixed(1)}px, ${P.y.toFixed(1)}px) translate(-50%, 0)`;
    }
  }

  const tmpBow = new THREE.Quaternion();
  function tick() {
    const dt = Math.min(clock.getDelta(), 0.1);
    const t = clock.elapsedTime;
    if (!state.paused) {
      const step = motionOn() ? dt : 0;
      for (const r of state.runners) {
        r.mixer.update(step);
        if (HEAD_FREE.has(r.pose) || !r.currentClip || r.currentClip === "sit") {
          tmpBow.setFromAxisAngle(AXIS_X, r.headBow);
          if (r.bones.head) r.bones.head.quaternion.copy(tmpBow);
        }
      }
      if (pod) {
        pod.mixer.update(step);
        pod.uniforms.uTime.value = t;
        if (motionOn()) {
          pod.holo.position.y = 0.75 + Math.sin(t * 1.6) * 0.07;
          pod.ring.rotation.z = t * 0.4;
          pod.ring2.rotation.z = -t * 0.6;
        }
      }
    }
    controls.update();
    renderer.render(scene, camera);
    updateOverlay();
  }
  renderer.setAnimationLoop(tick);

  /* ------------------------------------------------- resize + theme + reset */

  function resize() {
    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    state.size.w = w;
    state.size.h = h;
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    if (state.layout) frame(state.layout, false);
  }
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  const mo = new MutationObserver(() => {
    applyTheme();
    refreshRings();
  });
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  const resetBtn = document.getElementById("resetViewBtn");
  if (resetBtn) resetBtn.addEventListener("click", resetView);

  applyTheme();
  setSlots(4);
  booting = false;

  return {
    setSlots,
    play,
    clearRun,
    restore,
    setClock,
    pause,
    setTarget,
    select,
    resetView,
    get counts() { return { ...state.counts }; },
    get layout() { return state.layout; },
    get slotCount() { return state.count; },
    runner: (slot) => state.runners[slot] || null,
    debug: { state, camera, controls, scene, renderer, THREE, ACTIONS },
  };
}
