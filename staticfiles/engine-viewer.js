import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
import { OrbitControls } from 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/controls/OrbitControls.js';

/*
 * Interactive educational high-bypass turbofan (GEnx-inspired) with a
 * running-engine simulation. Procedural model, NOT OEM CAD or approved data.
 * Engine axis: X; inlet at -X, exhaust at +X.
 *
 * Layout (front to back):
 *   spinner, fan blades, fan case (with OGVs at its rear) enclosing the booster,
 *   booster (4) in the fan hub frame, HPC (10), combustor, HPT (2), LPT (6),
 *   rear frame / nozzle / tail cone.
 *
 * Spool & shaft architecture:
 *   - LP spool (fan blades, 4-stage booster rotors, 6-stage LPT rotors, and the
 *     mid-fan shaft): mid-fan shaft connects to the booster/fan assembly and is
 *     bolted at its rear flange to the LPT.
 *   - HP spool (10-stage HPC rotors, 2-stage HPT rotors, and the hollow HP shaft):
 *     hollow shaft spans through the core with an open inner bore so the mid-fan
 *     shaft passes concentrically through the center.
 */

const canvas = document.querySelector('#engine-canvas');
if (!canvas) throw new Error('Engine viewer: canvas #engine-canvas was not found.');
const stage = canvas.closest('.viewer-stage') || canvas.parentElement;

canvas.style.display = 'block';
canvas.style.width = '100%';
canvas.style.height = '100%';
if (stage.getBoundingClientRect().height < 200) stage.style.height = '520px';
if (getComputedStyle(stage).position === 'static') stage.style.position = 'relative';

/* ================================================================== */
/* Constants                                                           */
/* ================================================================== */

const TAU = Math.PI * 2;
const deg = d => (d * Math.PI) / 180;
const lerp = THREE.MathUtils.lerp;
const clamp = THREE.MathUtils.clamp;
const sstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const lin = (x0, x1, a, b) => x => a + (b - a) * clamp((x - x0) / (x1 - x0), 0, 1);
const sample = (x0, x1, fn, n = 6) =>
  Array.from({ length: n + 1 }, (_, i) => {
    const x = x0 + ((x1 - x0) * i) / n;
    return [x, fn(x)];
  });
const tbl = (arr, x) => {
  if (x <= arr[0][0]) return arr[0][1];
  for (let i = 1; i < arr.length; i++) {
    if (x <= arr[i][0]) {
      const d = arr[i][0] - arr[i - 1][0] || 1e-6;
      return lerp(arr[i - 1][1], arr[i][1], (x - arr[i - 1][0]) / d);
    }
  }
  return arr[arr.length - 1][1];
};

// Cutaway wedge: 110 degrees removed from the upper-front quadrant.
const CUT_WEDGE = deg(110);
const KEPT = TAU - CUT_WEDGE;
const LATHE_START = deg(10);
const RING_START = deg(190);

// UI / highlight colours per module (materials themselves are realistic metals)
const PALETTE = {
  fan:       { base: 0x8fd0ff },
  booster:   { base: 0x62b0f5 },
  hpc:       { base: 0x3fd6b8 },
  combustor: { base: 0xff8a3d },
  hpt:       { base: 0xf6c445 },
  lpt:       { base: 0xb48cf2 },
  exhaust:   { base: 0xf0678f }
};

const RANGE = {
  fan: [-2.55, -0.3],
  booster: [-1.62, -0.3],
  hpc: [-0.3, 0.8],
  combustor: [0.8, 1.15],
  hpt: [1.15, 1.55],
  lpt: [1.55, 2.4],
  exhaust: [2.4, 3.25]
};
const CENTER = Object.fromEntries(Object.entries(RANGE).map(([k, [a, b]]) => [k, (a + b) / 2]));

const OFFSET = {
  fan: -2.2,
  booster: -0.6,
  hpc: -0.25,
  combustor: 0.1,
  hpt: 0.45,
  lpt: 0.8,
  exhaust: 1.15
};

const ENGINE_CENTER_X = 0.35;
// Set true to also shut the engine down (instead of just freezing the sim) when scrolled away.
const AUTO_SHUTDOWN_ON_SCROLL = false;
const HOME_CAMERA = new THREE.Vector3(-4.3, 2.45, 8.0);
const DIST_ASSEMBLED = 9.6;
const DIST_EXPLODED = 15.5;

const INFO = {
  fan: {
    title: 'Fan & fan case',
    description:
      'Spinner, 18 swept fan blades, fan hub and the fan case with its inlet lip and the outlet guide vanes (OGVs) at its rear. The case encloses the booster and ends at the fan hub frame.'
  },
  booster: {
    title: 'Booster / LPC',
    description:
      'Four-stage booster coupled to the fan and LP mid-fan shaft, mounted inside the fan hub frame that separates it from the HPC.'
  },
  hpc: {
    title: 'High-pressure compressor',
    description:
      'Ten-stage axial compressor rotating on the hollow HP shaft with a tapering flow path, rotor and stator rows and compressor case.'
  },
  combustor: {
    title: 'Combustor',
    description:
      'Annular combustor with dome, fuel nozzles and stems, inner and outer liners with cooling holes, and the fuel manifold.'
  },
  hpt: {
    title: 'High-pressure turbine',
    description:
      'Two-stage turbine with nozzle guide vanes and rotors mounted on the hollow HP shaft to drive the HP compressor.'
  },
  lpt: {
    title: 'Low-pressure turbine',
    description:
      'Six-stage turbine with a flared flow path, bolted to the LP mid-fan shaft to drive the fan and booster.'
  },
  exhaust: {
    title: 'Rear frame & exhaust',
    description:
      'Turbine rear frame with struts, exhaust duct, nozzle lip and tail cone (centerbody).'
  }
};

/* ================================================================== */
/* Renderer / scene                                                    */
/* ================================================================== */

const SUN_DIR = new THREE.Vector3(-5, 7, 8).normalize();
const HAZE = '#d3e3f0';
const IS_SMALL = window.matchMedia('(max-width: 700px)').matches;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(HAZE, 70, 330);

const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 800);
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, IS_SMALL ? 1.75 : 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

function makeSkyTexture() {
  const W = 2048;
  const H = 1024;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const x = c.getContext('2d');

  const g = x.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#2a68b0');
  g.addColorStop(0.22, '#4f90cf');
  g.addColorStop(0.4, '#9fc8e8');
  g.addColorStop(0.495, '#d8e7f2');
  g.addColorStop(0.505, '#c4d0bb');
  g.addColorStop(0.56, '#7b8c68');
  g.addColorStop(1, '#46513a');
  x.fillStyle = g;
  x.fillRect(0, 0, W, H);

  const blob = (px, py, r, a, sy, col) => {
    for (const ox of [-W, 0, W]) {
      x.save();
      x.translate(px + ox, py);
      x.scale(1, sy);
      const rg = x.createRadialGradient(0, 0, 0, 0, 0, r);
      rg.addColorStop(0, `rgba(${col},${a})`);
      rg.addColorStop(1, `rgba(${col},0)`);
      x.fillStyle = rg;
      x.beginPath();
      x.arc(0, 0, r, 0, TAU);
      x.fill();
      x.restore();
    }
  };
  for (let k = 0; k < 46; k++) {
    const cx = Math.random() * W;
    const cy = H * (0.14 + Math.random() * 0.3);
    const n = 6 + ((Math.random() * 9) | 0);
    const sc = 0.6 + Math.random() * 0.9;
    for (let i = 0; i < n; i++) {
      const px = cx + (Math.random() - 0.5) * 220 * sc;
      const py = cy + (Math.random() - 0.5) * 26 * sc;
      blob(px, py + 12 * sc, (40 + Math.random() * 60) * sc, 0.16, 0.45, '140,158,182');
      blob(px, py, (40 + Math.random() * 70) * sc, 0.5, 0.5, '255,255,255');
    }
  }

  const sx = (Math.atan2(SUN_DIR.z, SUN_DIR.x) / TAU + 0.5) * W;
  const sy = (1 - (Math.asin(SUN_DIR.y) / Math.PI + 0.5)) * H;
  for (const ox of [-W, 0, W]) {
    const sg = x.createRadialGradient(sx + ox, sy, 0, sx + ox, sy, 260);
    sg.addColorStop(0, 'rgba(255,250,235,1)');
    sg.addColorStop(0.06, 'rgba(255,244,214,0.95)');
    sg.addColorStop(0.2, 'rgba(255,236,190,0.35)');
    sg.addColorStop(1, 'rgba(255,230,180,0)');
    x.fillStyle = sg;
    x.fillRect(sx + ox - 260, sy - 260, 520, 520);
  }

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.mapping = THREE.EquirectangularReflectionMapping;
  return t;
}

function softSprite() {
  const S = 128;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,245,220,0.65)');
  g.addColorStop(0.7, 'rgba(255,200,120,0.18)');
  g.addColorStop(1, 'rgba(255,160,60,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, S, S);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const skyTex = makeSkyTexture();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromEquirectangular(skyTex).texture;
scene.background = skyTex;

scene.add(new THREE.HemisphereLight(0xbcd8f0, 0x6b7a5a, 0.5));

const key = new THREE.DirectionalLight(0xfff0dc, 3.0);
key.position.copy(SUN_DIR).multiplyScalar(14);
key.castShadow = true;
key.shadow.mapSize.set(IS_SMALL ? 1024 : 2048, IS_SMALL ? 1024 : 2048);
key.shadow.camera.left = -9;
key.shadow.camera.right = 9;
key.shadow.camera.top = 9;
key.shadow.camera.bottom = -9;
key.shadow.camera.near = 1;
key.shadow.camera.far = 34;
key.shadow.bias = -0.0004;
key.shadow.normalBias = 0.02;
scene.add(key);

const skyFill = new THREE.DirectionalLight(0xaecbe8, 0.5);
skyFill.position.set(5, 3, -6);
scene.add(skyFill);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.065;
controls.enablePan = false;
controls.minDistance = 3.5;
controls.maxDistance = 24;
controls.maxPolarAngle = deg(89);
controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
canvas.style.touchAction = 'pan-y';
controls.autoRotate = true;
controls.autoRotateSpeed = 0.38;

const root = new THREE.Group();
scene.add(root);

/* ================================================================== */
/* State                                                               */
/* ================================================================== */

const parts = {};
const selectable = [];
const spinning = [];
const cutVariants = [];
const partMaterials = {};

let selected = null;
let exploded = false;
let cutaway = true;
let engineRunning = true;
let throttle = 0.65;
let lpSpeed = 4.5;
let hpSpeed = 8.2;

const focusGoal = new THREE.Vector3(ENGINE_CENTER_X, 0, 0);
let focusUntil = 0;
let distAssembled = DIST_ASSEMBLED;
let distExploded = DIST_EXPLODED;
let distGoal = DIST_ASSEMBLED;

/* ================================================================== */
/* Procedural textures + realistic materials                           */
/* ================================================================== */

function makeBrushed() {
  const W = 512;
  const H = 256;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const x = c.getContext('2d');
  x.fillStyle = 'rgb(200,200,200)';
  x.fillRect(0, 0, W, H);

  for (let i = 0; i < 2600; i++) {
    const y = Math.random() * H;
    const len = 30 + Math.random() * 320;
    const sx = Math.random() * W;
    const g = (90 + Math.random() * 165) | 0;
    x.strokeStyle = `rgba(${g},${g},${g},${0.08 + Math.random() * 0.35})`;
    x.lineWidth = Math.random() < 0.85 ? 1 : 2;
    const dy = (Math.random() - 0.5) * 1.5;
    for (const ox of [0, -W]) {
      x.beginPath();
      x.moveTo(sx + ox, y);
      x.lineTo(sx + ox + len, y + dy);
      x.stroke();
    }
  }

  const img = x.getImageData(0, 0, W, H);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 20;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n;
  }
  x.putImageData(img, 0, 0);

  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(3, 1);
  t.anisotropy = 8;
  return t;
}

function makeTint(stops) {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 256;
  const x = c.getContext('2d');
  const col = new THREE.Color();
  const a = new THREE.Color();
  const b = new THREE.Color();
  for (let y = 0; y < 256; y++) {
    const v = y / 255;
    const xn = v < 0.5 ? v * 2 : (1 - v) * 2;
    let i = 1;
    while (i < stops.length - 1 && xn > stops[i][0]) i++;
    const [x0, c0] = stops[i - 1];
    const [x1, c1] = stops[i];
    a.set(c0);
    b.set(c1);
    col.copy(a).lerp(b, clamp((xn - x0) / (x1 - x0 || 1e-6), 0, 1));
    x.fillStyle = '#' + col.getHexString();
    x.fillRect(0, y, 4, 1);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const BRUSHED = makeBrushed();
const TINT = {};

const MATSPEC = {
  fan: {
    blade: [0x6fb4ff, 0.7, 0.28],
    blade2: [0x2b6fd0, 0.6, 0.38],
    casing: [0x1d4f9c, 0.55, 0.42, { bump: 0.15 }],
    hub: [0x143a73, 0.65, 0.4],
    trim: [0xeaf3ff, 0.95, 0.14, { brush: false }]
  },
  booster: {
    blade: [0x3fe0e8, 0.7, 0.28],
    blade2: [0x17a8b8, 0.65, 0.32],
    casing: [0x11778a, 0.6, 0.4],
    hub: [0x0b4f5e, 0.65, 0.4],
    trim: [0xdffcff, 0.95, 0.16, { brush: false }]
  },
  hpc: {
    blade: [0x5ff09a, 0.7, 0.28],
    blade2: [0x2fb872, 0.65, 0.32],
    casing: [0x1c8a55, 0.6, 0.4],
    hub: [0x125c38, 0.65, 0.4],
    trim: [0xe2fff0, 0.95, 0.16, { brush: false }]
  },
  combustor: {
    blade: [0xffb24a, 0.75, 0.3],
    blade2: [0xf0902a, 0.7, 0.32],
    casing: [0xd0602a, 0.6, 0.42],
    hub: [0x8a3a18, 0.65, 0.4],
    trim: [0xffd98a, 0.9, 0.22, { brush: false }],
    liner: [0xff7a2e, 0.45, 0.45, { double: true }]
  },
  hpt: {
    blade: [0xffd83a, 0.8, 0.26],
    blade2: [0xe0aa1a, 0.7, 0.34],
    casing: [0xb98312, 0.6, 0.42],
    hub: [0x7a560c, 0.65, 0.4],
    trim: [0xfff1b0, 0.9, 0.2, { brush: false }]
  },
  lpt: {
    blade: [0xc29bff, 0.75, 0.28],
    blade2: [0x8f65e0, 0.65, 0.34],
    casing: [0x6a46b8, 0.6, 0.4],
    hub: [0x452a82, 0.65, 0.4],
    trim: [0xf0e6ff, 0.95, 0.2, { brush: false }]
  },
  exhaust: {
    blade: [0xff6f86, 0.7, 0.3],
    blade2: [0xd23f58, 0.65, 0.34],
    casing: [0xa82e45, 0.6, 0.4],
    hub: [0x6b1a2b, 0.65, 0.4],
    trim: [0xffe0e6, 0.95, 0.2, { brush: false }]
  }
};
const MATDEFAULT = {
  liner: [0x6a6f75, 0.7, 0.5, { double: true }],
  dark: [0x12171c, 0.4, 0.6, { brush: false }]
};
const HEATW = { blade: 0.9, blade2: 1, casing: 0.55, hub: 0.7, trim: 0.15, liner: 1.3, dark: 0 };
const PART_HEAT = { fan: 0, booster: 0, hpc: 0.08, combustor: 1, hpt: 0.9, lpt: 0.5, exhaust: 0.32 };
const SELCOL = Object.fromEntries(Object.entries(PALETTE).map(([k, v]) => [k, new THREE.Color(v.base)]));

function makeMaterials(part) {
  const spec = { ...MATDEFAULT, ...MATSPEC[part] };
  const set = {};
  for (const [k, [color, metalness, roughness, o = {}]] of Object.entries(spec)) {
    const brush = o.brush !== false;
    const mat = new THREE.MeshStandardMaterial({
      color,
      metalness,
      roughness,
      side: o.double || k === 'casing' || k === 'liner' ? THREE.DoubleSide : THREE.FrontSide,
      roughnessMap: brush ? BRUSHED : null,
      bumpMap: brush ? BRUSHED : null,
      bumpScale: o.bump ?? 0.25,
      map: k === 'casing' && TINT[part] ? TINT[part] : null
    });
    mat.userData.heatW = HEATW[k] ?? 0;
    set[k] = mat;
  }
  partMaterials[part] = Object.values(set);
  return set;
}

const M = {};
Object.keys(INFO).forEach(name => {
  M[name] = makeMaterials(name);
  parts[name] = new THREE.Group();
  parts[name].name = name;
  root.add(parts[name]);
});

/* ================================================================== */
/* Geometry helpers                                                    */
/* ================================================================== */

function register(obj, part, name, { pick = true, shadow = true } = {}) {
  obj.name = name || part;
  obj.userData.part = part;
  obj.castShadow = shadow;
  obj.receiveShadow = true;
  if (pick) selectable.push(obj);
}

function mesh(parent, geometry, material, part, name = '', opts) {
  const m = new THREE.Mesh(geometry, material);
  register(m, part, name, opts);
  parent.add(m);
  return m;
}

function cutPair(parent, makeGeo, mat, part, name) {
  const cut = mesh(parent, makeGeo(false), mat, part, name);
  cut.userData.variant = 'cut';
  const full = mesh(parent, makeGeo(true), mat, part, name);
  full.userData.variant = 'full';
  full.visible = false;
  cutVariants.push(cut, full);
  return [cut, full];
}

function latheGeo(pts, full) {
  const g = new THREE.LatheGeometry(
    pts,
    full ? 112 : 84,
    full ? 0 : LATHE_START,
    full ? TAU : KEPT
  );
  g.rotateZ(-Math.PI / 2);
  return g;
}

function wall(parent, prof, t, mat, part, name) {
  const inner = prof.map(([x, r]) => new THREE.Vector2(r, x));
  const outer = prof.map(([x, r]) => new THREE.Vector2(r + t, x)).reverse();
  const pts = [...inner, ...outer, inner[0].clone()];
  return cutPair(parent, full => latheGeo(pts, full), mat, part, name || part + '-casing');
}

function shell(parent, ptsRX, mat, part, name) {
  const pts = ptsRX.map(([r, x]) => new THREE.Vector2(r, x));
  return cutPair(parent, full => latheGeo(pts, full), mat, part, name);
}

function solidLathe(parent, ptsRX, mat, part, name) {
  const g = new THREE.LatheGeometry(
    ptsRX.map(([r, x]) => new THREE.Vector2(r, x)),
    96
  );
  g.rotateZ(-Math.PI / 2);
  return mesh(parent, g, mat, part, name);
}

function ring(parent, x, r, tube, mat, part) {
  const make = full => {
    const g = full
      ? new THREE.TorusGeometry(r, tube, 10, 96)
      : new THREE.TorusGeometry(r, tube, 10, 72, KEPT);
    if (!full) g.rotateZ(RING_START);
    g.rotateY(Math.PI / 2);
    return g;
  };
  cutPair(parent, make, mat, part, part + '-ring').forEach(m => (m.position.x = x));
}

function solidRing(parent, x, r, tube, mat, part) {
  const g = new THREE.TorusGeometry(r, tube, 10, 96);
  g.rotateY(Math.PI / 2);
  const m = mesh(parent, g, mat, part, part + '-band');
  m.position.x = x;
  return m;
}

function coneX(parent, x0, x1, r0, r1, mat, part, name) {
  const g = new THREE.CylinderGeometry(r1, r0, x1 - x0, 64, 1, false);
  g.rotateZ(-Math.PI / 2);
  const m = mesh(parent, g, mat, part, name || part + '-drum');
  m.position.x = (x0 + x1) / 2;
  return m;
}

function bladeGeo(r0, r1, chord, thick, sweep, twist) {
  const steps = 9;
  const around = 12;
  const positions = [];
  const uvs = [];
  const indices = [];

  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const r = lerp(r0, r1, t);
    const c = chord * (1 - 0.17 * t);
    const th = thick * (1 - 0.5 * t);

    for (let j = 0; j <= around; j++) {
      const a = (j / around) * TAU;
      const xc = (Math.cos(a) * 0.5 + 0.5) * c - c / 2;
      const zc = Math.sin(a) * th * 0.5;
      const tw = twist * t;

      positions.push(
        sweep * t * t + xc * Math.cos(tw) - zc * Math.sin(tw),
        r,
        xc * Math.sin(tw) + zc * Math.cos(tw)
      );
      uvs.push(j / around, t);
    }
  }

  const row = around + 1;
  for (let s = 0; s < steps; s++) {
    for (let j = 0; j < around; j++) {
      const a = s * row + j;
      const b = a + row;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

function bladeRow(parent, x, r0, r1, count, part, opts = {}) {
  const {
    chord = 0.2,
    thick = 0.05,
    sweep = 0.06,
    twist = 0.2,
    mat,
    stator = false,
    spool = null,
    shroud = false,
    band = true
  } = opts;

  const group = new THREE.Group();
  group.position.x = x;
  parent.add(group);

  const g = bladeGeo(r0 - 0.01, r1, chord, thick, sweep, twist);
  const im = new THREE.InstancedMesh(g, mat, count);
  const m4 = new THREE.Matrix4();
  const off = stator ? Math.PI / count : 0;

  for (let i = 0; i < count; i++) {
    m4.makeRotationX((i / count) * TAU + off);
    im.setMatrixAt(i, m4);
  }
  im.instanceMatrix.needsUpdate = true;
  im.frustumCulled = false;
  register(im, part, `${part}-${stator ? 'stator' : 'rotor'}-row`);
  group.add(im);

  if (band) {
    const b = new THREE.TorusGeometry(r0, 0.02, 8, 80);
    b.rotateY(Math.PI / 2);
    mesh(group, b, M[part].hub, part, part + '-root-band');
  }

  if (shroud) {
    const sh = new THREE.TorusGeometry(r1, 0.012, 8, 80);
    sh.rotateY(Math.PI / 2);
    mesh(group, sh, M[part].trim, part, part + '-shroud');
  }

  if (spool) spinning.push({ group, spool, dir: spool === 'lp' ? 1 : -1 });

  return group;
}

function strut(parent, x, ri, ro, angle, wx, wz, part, mat) {
  const m = mesh(parent, new THREE.BoxGeometry(wx, ro - ri, wz), mat, part, part + '-strut');
  m.position.set(x, (Math.cos(angle) * (ri + ro)) / 2, (Math.sin(angle) * (ri + ro)) / 2);
  m.rotation.x = angle;
  return m;
}

function dots(parent, part, mat, list) {
  const im = new THREE.InstancedMesh(new THREE.SphereGeometry(0.011, 6, 6), mat, list.length);
  const m = new THREE.Matrix4();
  list.forEach((p, i) => {
    m.makeTranslation(p[0], p[1], p[2]);
    im.setMatrixAt(i, m);
  });
  im.frustumCulled = false;
  register(im, part, part + '-cooling-holes', { shadow: false });
  parent.add(im);
}

/* ================================================================== */
/* FAN: spinner, hub, 18 blades, fan case with OGVs                    */
/* ================================================================== */

const fanCaseIn = x =>
  x < -1.85 ? 1.52 : x < -1.2 ? lerp(1.52, 1.5, (x + 1.85) / 0.65) : lerp(1.5, 1.42, (x + 1.2) / 0.9);

{
  const g = parts.fan;
  const m = M.fan;

  const hubPts = [];
  const N = 28;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    hubPts.push([0.5 * Math.pow(Math.sin((t * Math.PI) / 2), 0.8), -2.55 + 0.5 * t]);
  }
  hubPts.push([0.51, -1.95], [0.5, -1.75], [0.46, -1.65], [0.4, -1.6], [0, -1.6]);
  solidLathe(g, hubPts, m.trim, 'fan', 'spinner');

  const prof = [[1.42, -0.3], [1.5, -1.2], [1.52, -1.85], [1.52, -2.38]];
  for (let k = 1; k <= 10; k++) {
    const t = (k / 10) * Math.PI;
    prof.push([1.6 - 0.08 * Math.cos(t), -2.38 - 0.08 * Math.sin(t)]);
  }
  prof.push([1.7, -2.0], [1.68, -1.2], [1.55, -0.6], [1.5, -0.3], [1.42, -0.3]);
  shell(g, prof, m.casing, 'fan', 'fan-case');

  [-2.1, -1.5, -0.9].forEach(x => ring(g, x, fanCaseIn(x) + 0.17, 0.02, m.trim, 'fan'));
  ring(g, -0.32, 1.52, 0.03, m.trim, 'fan');

  const xo = -0.42;
  bladeRow(g, xo, 0.67, fanCaseIn(xo) - 0.01, 38, 'fan', {
    chord: 0.2,
    thick: 0.045,
    sweep: 0.02,
    twist: 0.14,
    mat: m.blade2,
    stator: true,
    shroud: true
  });

  bladeRow(g, -1.85, 0.47, 1.48, 18, 'fan', {
    chord: 0.55,
    thick: 0.11,
    sweep: 0.18,
    twist: 0.55,
    mat: m.blade,
    spool: 'lp'
  });
}

/* ================================================================== */
/* BOOSTER (4 stages) + FAN HUB FRAME                                  */
/* ================================================================== */

const bIn = lin(-1.62, -0.62, 0.74, 0.66);
const bHub = lin(-1.62, -0.62, 0.4, 0.46);

{
  const g = parts.booster;
  const m = M.booster;

  wall(g, sample(-1.62, -0.62, bIn, 6), 0.05, m.casing, 'booster');
  ring(g, -1.62, bIn(-1.62) + 0.05, 0.03, m.trim, 'booster');
  ring(g, -1.0, bIn(-1.0) + 0.06, 0.014, m.trim, 'booster');

  coneX(g, -1.62, -0.62, bHub(-1.62) - 0.005, bHub(-0.62) - 0.005, m.hub, 'booster');

  for (let i = 0; i < 4; i++) {
    const xr = -1.52 + i * 0.22;
    const xs = xr + 0.11;

    bladeRow(g, xr, bHub(xr), bIn(xr) - 0.025, 38 - i * 2, 'booster', {
      chord: 0.1,
      thick: 0.03,
      sweep: 0.05,
      twist: 0.3,
      mat: m.blade,
      spool: 'lp'
    });

    bladeRow(g, xs, bHub(xs), bIn(xs) - 0.005, 36 - i * 2, 'booster', {
      chord: 0.08,
      thick: 0.025,
      sweep: 0.02,
      twist: 0.12,
      mat: m.blade2,
      stator: true,
      shroud: true
    });
  }

  wall(
    g,
    [[-0.62, 0.66], [-0.52, 0.65], [-0.42, 0.61], [-0.3, 0.58]],
    0.05,
    m.casing,
    'booster',
    'frame-core-wall'
  );
  coneX(g, -0.62, -0.3, 0.455, 0.3, m.hub, 'booster', 'frame-hub');
  solidRing(g, -0.46, 0.33, 0.03, m.trim, 'booster');
  solidRing(g, -0.4, 1.4, 0.04, m.trim, 'booster');

  for (let i = 0; i < 10; i++) {
    strut(g, -0.46, 0.33, 0.6, (i / 10) * TAU + 0.15, 0.09, 0.035, 'booster', m.blade);
  }
}

/* ================================================================== */
/* HPC (10 stages)                                                     */
/* ================================================================== */
{
  const g = parts.hpc;
  const m = M.hpc;
  const [x0, x1] = RANGE.hpc;
  const rIn = lin(x0, x1, 0.58, 0.4);
  const rHub = lin(x0, x1, 0.3, 0.33);

  wall(g, sample(x0, x1, rIn, 8), 0.045, m.casing, 'hpc');
  coneX(g, x0, x1, rHub(x0) - 0.005, rHub(x1) - 0.005, m.hub, 'hpc');

  for (let i = 0; i < 10; i++) {
    const xr = -0.22 + i * 0.1;
    const xs = xr + 0.05;
    const n = 48 - i * 2;

    bladeRow(g, xr, rHub(xr), rIn(xr) - 0.02, n, 'hpc', {
      chord: 0.045,
      thick: 0.014,
      sweep: 0.012,
      twist: 0.25,
      mat: m.blade,
      spool: 'hp'
    });

    bladeRow(g, xs, rHub(xs), rIn(xs) - 0.004, n, 'hpc', {
      chord: 0.035,
      thick: 0.012,
      sweep: 0.008,
      twist: 0.11,
      mat: m.blade2,
      stator: true,
      shroud: true
    });

    if (i % 2 === 1) ring(g, xr, rIn(xr) + 0.055, 0.012, m.trim, 'hpc');
  }
}

/* ================================================================== */
/* COMBUSTOR                                                           */
/* ================================================================== */
{
  const g = parts.combustor;
  const m = M.combustor;
  const [x0, x1] = RANGE.combustor;

  wall(
    g,
    [[0.8, 0.42], [0.88, 0.62], [0.96, 0.68], [1.08, 0.68], [1.15, 0.6]],
    0.045,
    m.casing,
    'combustor'
  );

  coneX(g, x0, x1, 0.33, 0.3, m.hub, 'combustor');

  shell(
    g,
    [[0.56, 1.12], [0.56, 0.95], [0.52, 0.9], [0.4, 0.9], [0.36, 0.95], [0.36, 1.12]],
    m.liner,
    'combustor',
    'combustor-liner'
  );

  ring(g, 0.98, 0.76, 0.022, m.trim, 'combustor');

  for (let i = 0; i < 20; i++) {
    const a = (i / 20) * TAU;

    const swirler = mesh(
      g,
      new THREE.CylinderGeometry(0.03, 0.038, 0.12, 14),
      m.trim,
      'combustor',
      `fuel-nozzle-${i + 1}`
    );
    swirler.rotation.z = Math.PI / 2;
    swirler.position.set(0.89, Math.cos(a) * 0.46, Math.sin(a) * 0.46);

    const stem = mesh(g, new THREE.CylinderGeometry(0.014, 0.014, 0.22, 8), m.blade2, 'combustor');
    stem.position.set(0.92, Math.cos(a) * 0.56, Math.sin(a) * 0.56);
    stem.rotation.x = a;
  }

  const holes = [];
  [0.98, 1.05].forEach(x => {
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * TAU;
      holes.push([x, Math.cos(a) * 0.555, Math.sin(a) * 0.555]);
      holes.push([x, Math.cos(a) * 0.365, Math.sin(a) * 0.365]);
    }
  });
  dots(g, 'combustor', m.dark, holes);
}

/* ================================================================== */
/* HPT (2 stages)                                                      */
/* ================================================================== */
{
  const g = parts.hpt;
  const m = M.hpt;
  const [x0, x1] = RANGE.hpt;
  const rIn = lin(x0, x1, 0.6, 0.62);
  const rHub = lin(x0, x1, 0.3, 0.34);

  wall(g, sample(x0, x1, rIn, 5), 0.045, m.casing, 'hpt');
  [1.3, 1.45].forEach(x => ring(g, x, rIn(x) + 0.057, 0.014, m.trim, 'hpt'));

  coneX(g, x0, x1, rHub(x0) - 0.005, rHub(x1) - 0.005, m.hub, 'hpt');

  [
    { xs: 1.2, xr: 1.28, ns: 28, nr: 32 },
    { xs: 1.38, xr: 1.47, ns: 30, nr: 36 }
  ].forEach(s => {
    bladeRow(g, s.xs, rHub(s.xs), rIn(s.xs) - 0.004, s.ns, 'hpt', {
      chord: 0.07,
      thick: 0.03,
      sweep: 0.02,
      twist: 0.15,
      mat: m.blade2,
      stator: true,
      shroud: true
    });

    bladeRow(g, s.xr, rHub(s.xr), rIn(s.xr) - 0.02, s.nr, 'hpt', {
      chord: 0.08,
      thick: 0.032,
      sweep: 0.04,
      twist: 0.26,
      mat: m.blade,
      spool: 'hp',
      shroud: true
    });
  });
}

/* ================================================================== */
/* LPT (6 stages, flared)                                              */
/* ================================================================== */
{
  const g = parts.lpt;
  const m = M.lpt;
  const [x0, x1] = RANGE.lpt;
  const rIn = lin(x0, x1, 0.62, 0.84);
  const rHub = lin(x0, x1, 0.34, 0.4);

  wall(g, sample(x0, x1, rIn, 8), 0.045, m.casing, 'lpt');
  coneX(g, x0, x1, rHub(x0) - 0.005, rHub(x1) - 0.005, m.hub, 'lpt');

  for (let i = 0; i < 6; i++) {
    const xs = 1.6 + i * 0.135;
    const xr = xs + 0.065;

    bladeRow(g, xs, rHub(xs), rIn(xs) - 0.004, 40 + i * 2, 'lpt', {
      chord: 0.055,
      thick: 0.022,
      sweep: 0.02,
      twist: 0.14,
      mat: m.blade2,
      stator: true,
      shroud: true
    });

    bladeRow(g, xr, rHub(xr), rIn(xr) - 0.02, 40 + i * 2, 'lpt', {
      chord: 0.07,
      thick: 0.026,
      sweep: 0.05,
      twist: 0.3,
      mat: m.blade,
      spool: 'lp',
      shroud: true
    });

    ring(g, xr, rIn(xr) + 0.057, 0.012, m.trim, 'lpt');
  }
}

/* ================================================================== */
/* REAR FRAME / EXHAUST                                                */
/* ================================================================== */
{
  const g = parts.exhaust;
  const m = M.exhaust;

  wall(
    g,
    [[2.4, 0.84], [2.52, 0.8], [2.68, 0.72], [2.84, 0.64], [2.9, 0.62]],
    0.045,
    m.casing,
    'exhaust'
  );
  ring(g, 2.9, 0.645, 0.025, m.trim, 'exhaust');

  for (let i = 0; i < 12; i++) {
    strut(g, 2.5, 0.42, 0.82, (i / 12) * TAU + 0.1, 0.09, 0.04, 'exhaust', m.blade2);
  }

  const plug = [[0, 2.4]];
  const PN = 28;
  for (let i = 0; i <= PN; i++) {
    const t = i / PN;
    plug.push([0.4 * (1 - Math.pow(t, 1.7)), 2.4 + 0.85 * t]);
  }
  solidLathe(g, plug, m.blade, 'exhaust', 'exhaust-centerbody');
}

/* ================================================================== */
/* Concentric Spool Shafts (LP Mid-Fan Shaft + Hollow HP Shaft)       */
/* ================================================================== */

const lpShaftGroup = new THREE.Group();
lpShaftGroup.name = 'lp-midfan-shaft';
root.add(lpShaftGroup);
spinning.push({ group: lpShaftGroup, spool: 'lp', dir: 1 });

const hpShaftGroup = new THREE.Group();
hpShaftGroup.name = 'hp-hollow-shaft';
root.add(hpShaftGroup);
spinning.push({ group: hpShaftGroup, spool: 'hp', dir: -1 });

{
  // LP mid-fan shaft runs from fan/booster (-1.85) through the core to LPT (2.32)
  const midShaftGeo = new THREE.CylinderGeometry(0.11, 0.11, 4.17, 48, 1, false);
  midShaftGeo.rotateZ(-Math.PI / 2);
  const midShaft = mesh(lpShaftGroup, midShaftGeo, M.booster.trim, 'booster', 'midfan-shaft');
  midShaft.position.x = 0.235;

  // Front coupling connecting mid-fan shaft to booster/fan hub assembly
  const frontCouplerGeo = new THREE.CylinderGeometry(0.16, 0.15, 0.28, 48, 1, false);
  frontCouplerGeo.rotateZ(-Math.PI / 2);
  const frontCoupler = mesh(
    lpShaftGroup,
    frontCouplerGeo,
    M.booster.hub,
    'booster',
    'booster-shaft-coupling'
  );
  frontCoupler.position.x = -1.45;

  // Rear bolted flange at LPT + ring of bolts
  const rearFlangeGeo = new THREE.CylinderGeometry(0.21, 0.21, 0.06, 48, 1, false);
  rearFlangeGeo.rotateZ(-Math.PI / 2);
  const rearFlange = mesh(
    lpShaftGroup,
    rearFlangeGeo,
    M.lpt.trim,
    'lpt',
    'lpt-midfan-bolted-flange'
  );
  rearFlange.position.x = 2.02;

  const boltGeo = new THREE.CylinderGeometry(0.014, 0.014, 0.09, 8);
  boltGeo.rotateZ(-Math.PI / 2);
  const boltCount = 16;
  const bolts = new THREE.InstancedMesh(boltGeo, M.lpt.dark, boltCount);
  const m4 = new THREE.Matrix4();
  for (let i = 0; i < boltCount; i++) {
    const a = (i / boltCount) * TAU;
    m4.makeTranslation(2.02, Math.cos(a) * 0.175, Math.sin(a) * 0.175);
    bolts.setMatrixAt(i, m4);
  }
  bolts.instanceMatrix.needsUpdate = true;
  bolts.frustumCulled = false;
  register(bolts, 'lpt', 'lpt-flange-bolts');
  lpShaftGroup.add(bolts);

  // Hollow HP shaft: annular wall (r_in = 0.175, r_out = 0.235) leaves center open for mid-fan shaft
  const hpHollowProf = [
    [-0.22, 0.175],
    [0.68, 0.175],
    [1.15, 0.175],
    [1.47, 0.175]
  ];
  wall(hpShaftGroup, hpHollowProf, 0.06, M.hpc.trim, 'hpc', 'hp-hollow-shaft');

  // Attachment collars tying HPC and HPT rotor stages onto the hollow HP shaft
  [-0.22, 0.68, 1.28, 1.47].forEach((xCollar, idx) => {
    const isHpt = idx >= 2;
    solidRing(
      hpShaftGroup,
      xCollar,
      0.21,
      0.035,
      isHpt ? M.hpt.hub : M.hpc.hub,
      isHpt ? 'hpt' : 'hpc'
    );
  });
}

/* ================================================================== */
/* Ground                                                              */
/* ================================================================== */

{
  const groundGeo = new THREE.CircleGeometry(140, 64);
  groundGeo.rotateX(-Math.PI / 2);
  const groundMat = new THREE.MeshStandardMaterial({
    color: 0x677758,
    roughness: 0.92,
    metalness: 0.04
  });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.position.y = -2.25;
  ground.receiveShadow = true;
  ground.name = 'ground';
  scene.add(ground);
}

/* ================================================================== */
/* Hot-section glow: sprites + point lights (driven by EGT)            */
/* ================================================================== */

const glowTex = softSprite();
const glowObjs = [];
const heatLights = [];

function addGlow(part, x, y, z, scale, color, weight) {
  const s = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTex,
      color,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false
    })
  );
  s.position.set(x, y, z);
  s.scale.setScalar(scale);
  parts[part].add(s);
  glowObjs.push({ s, weight, scale });
}

function addHeatLight(part, x, color, max, dist) {
  const l = new THREE.PointLight(color, 0, dist, 2);
  l.position.set(x, 0, 0);
  parts[part].add(l);
  heatLights.push({ l, max });
}

for (let i = 0; i < 8; i++) {
  const a = (i / 8) * TAU;
  addGlow('combustor', 1.03, Math.cos(a) * 0.46, Math.sin(a) * 0.46, 0.34, 0xff7b29, 1.0);
}
addGlow('hpt', 1.28, 0, 0, 0.55, 0xffaa33, 0.8);
addGlow('lpt', 1.85, 0, 0, 0.65, 0xff8c42, 0.45);
addHeatLight('combustor', 1.0, 0xff7722, 2.2, 3.2);
addHeatLight('hpt', 1.32, 0xff9d2e, 1.4, 2.6);

/* ================================================================== */
/* UI controls, selection, cutaway, explode, and simulation loop      */
/* ================================================================== */

const detailEl = document.querySelector('#part-detail');
const labelEl = document.querySelector('#engine-label');
const autoRotateInput = document.querySelector('#auto-rotate');

function ensureViewerUI() {
  let bar = stage.querySelector('.engine-sim-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'engine-sim-bar';
    bar.style.cssText =
      'position:absolute;left:12px;right:12px;bottom:12px;display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;background:rgba(15,23,34,0.78);color:#f3f7fc;padding:8px 12px;border-radius:10px;backdrop-filter:blur(8px);font:12px/1.3 system-ui,sans-serif;z-index:10;';
    stage.appendChild(bar);
  }

  const makeBtn = (id, text, onClick) => {
    let b = bar.querySelector('#' + id);
    if (!b) {
      b = document.createElement('button');
      b.id = id;
      b.type = 'button';
      b.className = 'control-btn';
      b.style.cssText =
        'padding:5px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.22);background:rgba(255,255,255,0.1);color:#fff;cursor:pointer;font-size:12px;';
      bar.appendChild(b);
    }
    b.textContent = text;
    b.onclick = onClick;
    return b;
  };

  makeBtn('btn-cutaway', '', () => setCutaway(!cutaway));
  makeBtn('btn-explode', '', () => setExploded(!exploded));
  makeBtn('btn-power', '', () => setEngineRunning(!engineRunning));
  makeBtn('btn-reset', 'Reset View', () => resetView());

  const thrWrap = document.createElement('label');
  thrWrap.style.cssText = 'display:inline-flex;align-items:center;gap:6px;margin-left:auto;';
  thrWrap.innerHTML = '<span>Throttle</span>';
  const thrInput = document.createElement('input');
  thrInput.type = 'range';
  thrInput.min = '0';
  thrInput.max = '1';
  thrInput.step = '0.01';
  thrInput.value = String(throttle);
  thrInput.oninput = () => {
    throttle = parseFloat(thrInput.value);
  };
  thrWrap.appendChild(thrInput);
  bar.appendChild(thrWrap);

  syncButtons();
}

function syncButtons() {
  const cutBtn = stage.querySelector('#btn-cutaway');
  const expBtn = stage.querySelector('#btn-explode');
  const pwrBtn = stage.querySelector('#btn-power');
  if (cutBtn) cutBtn.textContent = cutaway ? 'Cutaway: ON' : 'Cutaway: OFF';
  if (expBtn) expBtn.textContent = exploded ? 'Exploded: ON' : 'Exploded: OFF';
  if (pwrBtn) pwrBtn.textContent = engineRunning ? 'Engine: RUN' : 'Engine: IDLE/OFF';
}

function setCutaway(val) {
  cutaway = Boolean(val);
  for (const m of cutVariants) {
    m.visible = cutaway ? m.userData.variant === 'cut' : m.userData.variant === 'full';
  }
  syncButtons();
}

function setExploded(val) {
  exploded = Boolean(val);
  distGoal = exploded ? distExploded : distAssembled;
  syncButtons();
}

function setEngineRunning(val) {
  engineRunning = Boolean(val);
  syncButtons();
}

function selectPart(partName) {
  selected = partName && INFO[partName] ? partName : null;
  for (const [p, mats] of Object.entries(partMaterials)) {
    const selCol = SELCOL[p];
    for (const mat of mats) {
      if (selected && p !== selected) {
        mat.opacity = 0.35;
        mat.transparent = true;
      } else {
        mat.opacity = 1;
        mat.transparent = false;
      }
      if (selected === p && selCol) {
        mat.emissive.copy(selCol).multiplyScalar(0.18);
      }
    }
  }
  if (detailEl) {
    if (selected) {
      const info = INFO[selected];
      detailEl.innerHTML = `<strong>${info.title}</strong><p>${info.description}</p>`;
    } else {
      detailEl.textContent = '';
    }
  }
  if (labelEl) {
    labelEl.textContent = selected ? INFO[selected].title : 'GEnx-Inspired Turbofan';
  }
  if (selected && typeof CENTER[selected] === 'number') {
    focusGoal.set(CENTER[selected], 0, 0);
    focusUntil = performance.now() + 900;
  }
}

function resetView() {
  selectPart(null);
  setExploded(false);
  focusGoal.set(ENGINE_CENTER_X, 0, 0);
  focusUntil = performance.now() + 900;
  camera.position.copy(HOME_CAMERA);
  distGoal = distAssembled;
}

document.querySelectorAll('.component-card').forEach(card => {
  card.addEventListener('click', () => {
    const p = card.dataset.part || card.getAttribute('data-part');
    if (p) selectPart(selected === p ? null : p);
  });
});

if (autoRotateInput) {
  controls.autoRotate = autoRotateInput.checked;
  autoRotateInput.addEventListener('change', () => {
    controls.autoRotate = autoRotateInput.checked;
  });
}

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let downPos = { x: 0, y: 0 };

canvas.addEventListener('pointerdown', e => {
  downPos = { x: e.clientX, y: e.clientY };
});

canvas.addEventListener('pointerup', e => {
  const moved = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y);
  if (moved > 6) return;
  const rect = canvas.getBoundingClientRect();
  pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(selectable, false);
  const hit = hits.find(h => h.object.visible);
  selectPart(hit ? hit.object.userData.part : null);
});

function resize() {
  const w = Math.max(1, stage.clientWidth || canvas.clientWidth || 800);
  const h = Math.max(1, stage.clientHeight || canvas.clientHeight || 520);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
}

window.addEventListener('resize', resize);
resize();
camera.position.copy(HOME_CAMERA);
controls.target.copy(focusGoal);
ensureViewerUI();

let simFrozen = false;
if ('IntersectionObserver' in window) {
  const io = new IntersectionObserver(
    entries => {
      const visible = entries.some(en => en.isIntersecting);
      simFrozen = !visible;
      if (!visible && AUTO_SHUTDOWN_ON_SCROLL) setEngineRunning(false);
    },
    { threshold: 0.05 }
  );
  io.observe(stage);
}

let explodeT = 0;
let prevT = performance.now();

function updateExplode(dt) {
  const target = exploded ? 1 : 0;
  explodeT = lerp(explodeT, target, 1 - Math.exp(-7 * dt));

  for (const [k, grp] of Object.entries(parts)) {
    grp.position.x = (OFFSET[k] || 0) * explodeT;
  }

  // Keep shafts aligned with their driven assemblies during explode transition
  lpShaftGroup.position.x = (OFFSET.booster || 0) * explodeT;
  hpShaftGroup.position.x = (OFFSET.hpc || 0) * explodeT;
}

function updateThermalAndSpools(dt) {
  const targetLp = engineRunning ? lerp(1.6, 11.5, throttle) : 0;
  const targetHp = engineRunning ? lerp(3.0, 19.0, throttle) : 0;
  lpSpeed = lerp(lpSpeed, targetLp, 1 - Math.exp(-3.5 * dt));
  hpSpeed = lerp(hpSpeed, targetHp, 1 - Math.exp(-4.0 * dt));

  for (const item of spinning) {
    const rate = item.spool === 'lp' ? lpSpeed : hpSpeed;
    item.group.rotation.x += rate * item.dir * dt;
  }

  const heatLevel = engineRunning ? lerp(0.25, 1.0, throttle) : 0.04;
  for (const [part, mats] of Object.entries(partMaterials)) {
    if (selected === part) continue;
    const baseH = (PART_HEAT[part] ?? 0) * heatLevel;
    for (const mat of mats) {
      const w = mat.userData.heatW ?? 0;
      const g = clamp(baseH * w, 0, 1);
      mat.emissive.setRGB(g * 0.95, g * 0.34, g * 0.05);
    }
  }

  for (const item of glowObjs) {
    item.s.material.opacity = clamp(heatLevel * item.weight * 0.72, 0, 0.85);
  }
  for (const hl of heatLights) {
    hl.l.intensity = heatLevel * hl.max;
  }
}

function animate(now) {
  requestAnimationFrame(animate);
  const dt = Math.min(0.05, (now - prevT) / 1000 || 0.016);
  prevT = now;

  if (!simFrozen) {
    updateExplode(dt);
    updateThermalAndSpools(dt);
  }

  if (now < focusUntil) {
    controls.target.lerp(focusGoal, 1 - Math.exp(-6 * dt));
  }

  const offset = camera.position.clone().sub(controls.target);
  const curDist = offset.length() || distGoal;
  const nextDist = lerp(curDist, distGoal, 1 - Math.exp(-5 * dt));
  if (Math.abs(nextDist - curDist) > 1e-4 && !simFrozen) {
    offset.setLength(nextDist);
    camera.position.copy(controls.target).add(offset);
  }

  controls.update();
  renderer.render(scene, camera);
}

requestAnimationFrame(animate);
