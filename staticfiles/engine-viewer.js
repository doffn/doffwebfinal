import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
import { OrbitControls } from 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/controls/OrbitControls.js';

/*
 * Interactive educational high-bypass turbofan (GEnx-inspired) with a
 * running-engine simulation.  Procedural model, NOT OEM CAD or approved data.
 * Engine axis: X; inlet at -X, exhaust at +X.
 *
 * Layout (front to back):
 *   spinner, fan blades, fan case (with OGVs at its rear) enclosing the booster,
 *   booster (4) in the fan hub frame, HPC (10), combustor, HPT (2), LPT (6),
 *   rear frame / nozzle / tail cone.
 *
 * The control bar and the primary / secondary display are created by this
 * script (no HTML changes needed).  Needs an import map in the page for the
 * bare "three" specifier used by OrbitControls.
 *
 * Expects #engine-canvas, .viewer-stage, .component-card, .control-btn,
 * #part-detail, #engine-label, optionally #auto-rotate and .viewer-controls.
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
      'The booster sits inside the fan case, mounted in the fan hub frame that separates it from the HPC.'
  },
  hpc: {
    title: 'High-pressure compressor',
    description:
      'Ten-stage axial compressor with a tapering flow path, rotor and stator rows and compressor case.'
  },
  combustor: {
    title: 'Combustor',
    description:
      'Annular combustor with dome, fuel nozzles and stems, inner and outer liners with cooling holes, and the fuel manifold.'
  },
  hpt: {
    title: 'High-pressure turbine',
    description:
      'Two-stage turbine with nozzle guide vanes and rotors that extract power to drive the HP compressor.'
  },
  lpt: {
    title: 'Low-pressure turbine',
    description:
      'Six-stage turbine with a flared flow path, driven by the LP spool and connected to the fan and booster.'
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

// Natural daytime sky (gradient + clouds + sun glow), used as background AND reflections
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

const skyTex = makeSkyTexture();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromEquirectangular(skyTex).texture;
scene.background = skyTex;

scene.add(new THREE.HemisphereLight(0xbcd8f0, 0x6b7a5a, 0.5));

const key = new THREE.DirectionalLight(0xfff0dc, 3.0); // the sun
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
controls.maxPolarAngle = deg(89); // never go under the ground
controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
canvas.style.touchAction = 'pan-y'; // vertical swipes still scroll the page on phones
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

  // fine machining / brushing lines (run around the circumference)
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

  // speckle
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

// Heat tint along the casing (v on a closed lathe profile is a "tent": 0 -> 1 -> 0)
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
const TINT = {}; // heat is shown with a live emissive glow instead of baked tints

// [color, metalness, roughness, options]
const MATSPEC = {
  // FAN: titanium-blue blades, deep-blue case, polished spinner
  fan: {
    blade: [0x6fb4ff, 0.7, 0.28],
    blade2: [0x2b6fd0, 0.6, 0.38],
    casing: [0x1d4f9c, 0.55, 0.42, { bump: 0.15 }],
    hub: [0x143a73, 0.65, 0.4],
    trim: [0xeaf3ff, 0.95, 0.14, { brush: false }]
  },
  // BOOSTER: cyan / teal
  booster: {
    blade: [0x3fe0e8, 0.7, 0.28],
    blade2: [0x17a8b8, 0.65, 0.32],
    casing: [0x11778a, 0.6, 0.4],
    hub: [0x0b4f5e, 0.65, 0.4],
    trim: [0xdffcff, 0.95, 0.16, { brush: false }]
  },
  // HPC: green
  hpc: {
    blade: [0x5ff09a, 0.7, 0.28],
    blade2: [0x2fb872, 0.65, 0.32],
    casing: [0x1c8a55, 0.6, 0.4],
    hub: [0x125c38, 0.65, 0.4],
    trim: [0xe2fff0, 0.95, 0.16, { brush: false }]
  },
  // COMBUSTOR: copper / orange
  combustor: {
    blade: [0xffb24a, 0.75, 0.3],
    blade2: [0xf0902a, 0.7, 0.32],
    casing: [0xd0602a, 0.6, 0.42],
    hub: [0x8a3a18, 0.65, 0.4],
    trim: [0xffd98a, 0.9, 0.22, { brush: false }],
    liner: [0xff7a2e, 0.45, 0.45, { double: true }]
  },
  // HPT: gold / yellow
  hpt: {
    blade: [0xffd83a, 0.8, 0.26],
    blade2: [0xe0aa1a, 0.7, 0.34],
    casing: [0xb98312, 0.6, 0.42],
    hub: [0x7a560c, 0.65, 0.4],
    trim: [0xfff1b0, 0.9, 0.2, { brush: false }]
  },
  // LPT: violet
  lpt: {
    blade: [0xc29bff, 0.75, 0.28],
    blade2: [0x8f65e0, 0.65, 0.34],
    casing: [0x6a46b8, 0.6, 0.4],
    hub: [0x452a82, 0.65, 0.4],
    trim: [0xf0e6ff, 0.95, 0.2, { brush: false }]
  },
  // EXHAUST: red / rose
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
  g.rotateZ(-Math.PI / 2); // lathe Y axis -> engine X axis
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
  solidLathe(g, hubPts, m.trim, 'fan', 'spinner'); // tip points to -X (inlet)

  const prof = [[1.42, -0.3], [1.5, -1.2], [1.52, -1.85], [1.52, -2.38]];
  for (let k = 1; k <= 10; k++) {
    const t = (k / 10) * Math.PI;
    prof.push([1.6 - 0.08 * Math.cos(t), -2.38 - 0.08 * Math.sin(t)]);
  }
  prof.push([1.7, -2.0], [1.68, -1.2], [1.55, -0.6], [1.5, -0.3], [1.42, -0.3]);
  shell(g, prof, m.casing, 'fan', 'fan-case');

  [-2.1, -1.5, -0.9].forEach(x => ring(g, x, fanCaseIn(x) + 0.17, 0.02, m.trim, 'fan'));
  ring(g, -0.32, 1.52, 0.03, m.trim, 'fan');

  // OGVs: the single stator row, part of the fan case, at its rear
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

  // Fan hub frame: S-duct, hub, bearing ring, outer ring, inner struts
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

  // Tail cone: base at the turbine hub, tip points to +X (rearward)
  const plug = [[0, 2.4]];
  const PN = 28;
  for (let i = 0; i <= PN; i++) {
    const t = i / PN;
    plug.push([0.4 * (1 - Math.pow(t, 1.7)), 2.4 + 0.85 * t]);
  }
  solidLathe(g, plug, m.blade, 'exhaust', 'exhaust-centerbody');
}

/* ================================================================== */
/* Ground                                                              */
/* ================================================================== */

/* ---- Hot-section glow: sprites + point lights (driven by EGT) ---- */

const glowTex = softSprite();
const glowObjs = [];
const heatLights = [];

function addGlow(part, x, y, z, scale, color, weight) {
  const s = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: glowTex, color, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, fog: false })
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
  addGlow('combustor', 1.03, Math.cos(a) * 0.46, Math.sin(a) * 0.46, 0.6, 0xff7a2a, 1.0);
}
for (let i = 0; i < 6; i++) {
  const a = (i / 6) * TAU;
  addGlow('hpt', 1.33, Math.cos(a) * 0.5, Math.sin(a) * 0.5, 0.45, 0xffa83a, 0.8);
}
for (let i = 0; i < 5; i++) {
  const a = (i / 5) * TAU;
  addGlow('lpt', 1.85, Math.cos(a) * 0.62, Math.sin(a) * 0.62, 0.5, 0xff6a3a, 0.35);
}
addGlow('exhaust', 3.0, 0, 0, 1.5, 0xff8a3a, 0.55);
addGlow('exhaust', 2.7, 0, 0, 0.9, 0xff6a2a, 0.5);
addHeatLight('combustor', 1.0, 0xff7a2a, 16, 3.2);
addHeatLight('hpt', 1.35, 0xffa03a, 7, 2.4);
addHeatLight('exhaust', 2.8, 0xff7a3a, 3, 3);

/* ---- Natural environment: grass field, concrete apron, hills, stands ---- */

function makeConcrete() {
  const S = 512;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const x = c.getContext('2d');
  x.fillStyle = '#a2a4a5';
  x.fillRect(0, 0, S, S);
  for (let i = 0; i < 7000; i++) {
    const g = (120 + Math.random() * 90) | 0;
    x.fillStyle = `rgba(${g},${g},${g},${0.05 + Math.random() * 0.18})`;
    x.fillRect(Math.random() * S, Math.random() * S, 1 + Math.random() * 3, 1 + Math.random() * 3);
  }
  for (let i = 0; i < 40; i++) {
    const px = Math.random() * S;
    const py = Math.random() * S;
    const r = 20 + Math.random() * 60;
    const sg = x.createRadialGradient(px, py, 0, px, py, r);
    sg.addColorStop(0, `rgba(40,40,45,${0.04 + Math.random() * 0.07})`);
    sg.addColorStop(1, 'rgba(40,40,45,0)');
    x.fillStyle = sg;
    x.fillRect(px - r, py - r, r * 2, r * 2);
  }
  x.strokeStyle = 'rgba(55,57,60,0.8)';
  x.lineWidth = 3;
  x.strokeRect(1.5, 1.5, S - 3, S - 3);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function makeGrass() {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const x = c.getContext('2d');
  x.fillStyle = '#58803a';
  x.fillRect(0, 0, S, S);
  for (let i = 0; i < 6000; i++) {
    x.strokeStyle = `hsl(${92 + Math.random() * 22},${38 + Math.random() * 20}%,${24 + Math.random() * 18}%)`;
    x.lineWidth = 1;
    const px = Math.random() * S;
    const py = Math.random() * S;
    const a = Math.random() * TAU;
    const l = 3 + Math.random() * 6;
    x.beginPath();
    x.moveTo(px, py);
    x.lineTo(px + Math.cos(a) * l, py + Math.sin(a) * l);
    x.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(280, 280);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

const grass = new THREE.Mesh(
  new THREE.PlaneGeometry(1400, 1400),
  new THREE.MeshStandardMaterial({ map: makeGrass(), roughness: 1, metalness: 0 })
);
grass.rotation.x = -Math.PI / 2;
grass.position.y = -2.0;
grass.receiveShadow = true;
scene.add(grass);

const concreteTex = makeConcrete();
concreteTex.repeat.set(12.8, 8);
const apron = new THREE.Mesh(
  new THREE.PlaneGeometry(64, 40),
  new THREE.MeshStandardMaterial({ map: concreteTex, roughness: 0.92, metalness: 0 })
);
apron.rotation.x = -Math.PI / 2;
apron.position.set(0.4, -1.97, 0);
apron.receiveShadow = true;
scene.add(apron);

// painted safety lines around the engine position
const paint = new THREE.MeshStandardMaterial({ color: 0xe8c020, roughness: 0.8 });
[
  [10, 0.14, 0.5, -4.4],
  [10, 0.14, 0.5, 4.4],
  [0.14, 8.9, -4.5, 0],
  [0.14, 8.9, 5.5, 0]
].forEach(([w, d, px, pz]) => {
  const l = new THREE.Mesh(new THREE.PlaneGeometry(w, d), paint);
  l.rotation.x = -Math.PI / 2;
  l.position.set(px, -1.965, pz);
  l.receiveShadow = true;
  scene.add(l);
});

// distant hills (fade into the haze)
const hillMat = new THREE.MeshLambertMaterial({ color: 0x58724a });
for (let i = 0; i < 26; i++) {
  const a = (i / 26) * TAU + Math.random() * 0.2;
  const R = 170 + Math.random() * 70;
  const h = new THREE.Mesh(new THREE.SphereGeometry(1, 18, 10), hillMat);
  h.scale.set(40 + Math.random() * 50, 8 + Math.random() * 16, 30 + Math.random() * 30);
  h.position.set(Math.cos(a) * R, -2, Math.sin(a) * R);
  scene.add(h);
}

// engine stands (hidden in the exploded view)
const standMat = new THREE.MeshStandardMaterial({ color: 0x3b4249, metalness: 0.6, roughness: 0.5 });
const stands = new THREE.Group();
scene.add(stands);

function standMesh(geo, px, py, pz) {
  const m = new THREE.Mesh(geo, standMat);
  m.position.set(px, py, pz);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function makeStand(x, R, halfArcDeg) {
  const g = new THREE.Group();
  g.position.x = x;
  const tg = new THREE.TorusGeometry(R, 0.05, 10, 48, deg(halfArcDeg * 2));
  tg.rotateZ(deg(270 - halfArcDeg));
  tg.rotateY(Math.PI / 2);
  g.add(standMesh(tg, 0, 0, 0));
  const yEnd = -R * Math.cos(deg(halfArcDeg));
  const zEnd = R * Math.sin(deg(halfArcDeg));
  const floor = -1.97;
  const h = yEnd - floor;
  for (const sgn of [-1, 1]) {
    g.add(standMesh(new THREE.BoxGeometry(0.12, h, 0.12), 0, (yEnd + floor) / 2, sgn * zEnd));
    g.add(standMesh(new THREE.BoxGeometry(1.1, 0.08, 0.22), 0, floor + 0.04, sgn * zEnd));
  }
  g.add(standMesh(new THREE.BoxGeometry(0.16, 0.08, zEnd * 2 + 0.3), 0, floor + 0.04, 0));
  return g;
}
stands.add(makeStand(-1.3, 1.73, 52));
stands.add(makeStand(2.05, 0.88, 52));

/* ================================================================== */
/* ENGINE SIMULATION                                                   */
/* ================================================================== */

const AMB = 20;
const N2_IDLE = 60;
const N1_IDLE = 22;
const LP_MAX = 5.5;   // rad/s visual at 100 % N1
const HP_MAX = 8.5;   // rad/s visual at 100 % N2

const eng = {
  state: 'off', // off | start | run | stop
  n1: 0,
  n2: 0,
  egt: AMB,
  ff: 0,
  oilP: 0,
  oilT: AMB,
  vib1: 0,
  vib2: 0,
  thrust: 0,
  thr: 0,
  starter: false,
  ign: false,
  fuel: false,
  sim: 2,
  vibBoost: 0,
  egtBoost: 0,
  msgs: [],
  dirty: true
};

const n1FromN2 = n2 =>
  n2 < N2_IDLE
    ? N1_IDLE * Math.pow(Math.max(n2, 0) / N2_IDLE, 1.7)
    : N1_IDLE + 80 * Math.pow(Math.min((n2 - N2_IDLE) / 38, 1.1), 1 / 0.7);
const n2Target = t => N2_IDLE + 38 * Math.pow(t, 0.7);
const lag = (cur, tgt, tau, dt) => cur + (tgt - cur) * (1 - Math.exp(-dt / tau));

function msg(text, level = 'ok') {
  eng.msgs.unshift({ text, level });
  eng.msgs.length = Math.min(eng.msgs.length, 4);
  eng.dirty = true;
}

function startEngine() {
  if (eng.state === 'start' || eng.state === 'run') return;
  eng.state = 'start';
  eng.fuel = false;
  msg('ENG START · STARTER AIR', 'info');
  resumeAudio();
}

function stopEngine() {
  if (eng.state === 'off' && eng.n2 < 0.5) return;
  eng.state = 'stop';
  eng.fuel = false;
  eng.ign = false;
  eng.starter = false;
  msg('FUEL CUTOFF · ENG SHUTDOWN', 'info');
}

function birdStrike() {
  if (eng.n2 < 5) {
    msg('NO EFFECT · ENGINE NOT RUNNING', 'info');
    return;
  }
  eng.vibBoost = 4.6;
  eng.egtBoost += 110;
  eng.n2 = Math.max(0, eng.n2 - 3);
  eng.n1 = Math.max(0, eng.n1 - 4);
  msg('BIRD STRIKE · ENG VIB HIGH', 'warn');
  msg('N1 FLUCTUATION', 'warn');
}

function stepEngine(dt) {
  const e = eng;
  const prevN2 = e.n2;

  if (e.state === 'start') {
    e.starter = e.n2 < 50;
    if (e.n2 >= 8 && !e.ign) {
      e.ign = true;
      msg('IGNITION A/B', 'info');
    }
    if (e.n2 >= 18 && !e.fuel) {
      e.fuel = true;
      msg('FUEL ON · LIGHT-OFF', 'ok');
    }
    let rate = e.starter ? 2.2 * Math.max(0, 1 - e.n2 / 32) : 0;
    if (e.fuel) {
      rate += (N2_IDLE - e.n2) * 0.11 + (e.starter ? 1.2 * Math.max(0, 1 - e.n2 / 50) : 0);
    }
    e.n2 = Math.min(N2_IDLE, e.n2 + rate * dt);
    if (e.fuel && e.n2 >= N2_IDLE - 0.6) {
      e.state = 'run';
      e.ign = false;
      e.starter = false;
      msg('ENG STABLE · IDLE', 'ok');
    }
  } else if (e.state === 'run') {
    const tgt = n2Target(e.thr);
    e.n2 = lag(e.n2, tgt, tgt > e.n2 ? 3.2 : 4.5, dt);
  } else {
    // off / stop: coast down
    e.n2 = Math.max(0, e.n2 - (0.04 * e.n2 + 0.18) * dt);
    if (e.state === 'stop' && e.n2 < 0.2 && e.n1 < 0.3) {
      e.n2 = 0;
      e.state = 'off';
      msg('ENG OFF', 'info');
    }
  }

  const dn2dt = (e.n2 - prevN2) / dt;

  // N1 follows N2 with its own lag
  const n1t = n1FromN2(e.n2);
  e.n1 = lag(e.n1, n1t, e.n1 < n1t ? 2.6 : 5.5, dt);
  if (e.n1 < 0.05 && e.n2 === 0) e.n1 = 0;

  const tN = clamp((e.n1 - N1_IDLE) / 80, 0, 1.05);

  // EGT
  e.egtBoost *= Math.exp(-dt / 5);
  let egtT = AMB;
  if (e.state === 'start') {
    if (e.fuel) {
      const frac = clamp((e.n2 - 18) / 12, 0, 1);
      const spike = 270 * Math.sin(Math.PI * clamp((e.n2 - 20) / 40, 0, 1));
      egtT = AMB + (360 + spike - AMB) * frac;
    } else {
      egtT = AMB + e.n2 * 0.8;
    }
  } else if (e.state === 'run') {
    egtT = 360 + 590 * Math.pow(tN, 1.2) + clamp(dn2dt, 0, 12) * 7;
  }
  egtT += e.egtBoost;
  e.egt = lag(e.egt, egtT, egtT > e.egt ? 2.5 : e.state === 'run' || e.state === 'start' ? 4 : 28, dt);

  // Fuel flow (kg/h)
  let ffT = 0;
  if (e.fuel) {
    if (e.state === 'start') ffT = 140 + Math.max(0, e.n2 - 18) * 11;
    else if (e.state === 'run') ffT = 560 + 6600 * Math.pow(tN, 1.6) + clamp(dn2dt, 0, 12) * 140;
  }
  e.ff = lag(e.ff, ffT, e.fuel ? 1.2 : 0.4, dt);
  if (e.ff < 1) e.ff = 0;

  // Oil
  const oilPT = e.n2 < 3 ? 0 : 8 + e.n2 * 0.62;
  e.oilP = lag(e.oilP, oilPT, 1.5, dt);
  const oilTT = AMB + 5 + e.n2 * 0.5 + Math.max(0, e.egt - 360) * 0.06;
  e.oilT = lag(e.oilT, e.n2 < 3 && e.state === 'off' ? AMB : oilTT, oilTT > e.oilT ? 70 : 140, dt);

  // Vibration
  e.vibBoost *= Math.exp(-dt / 6);
  const nz = Math.random() - 0.5;
  const v1 = e.n1 < 1 ? 0 : 0.12 + e.n1 * 0.006 + e.vibBoost + nz * 0.06;
  const v2 = e.n2 < 1 ? 0 : 0.15 + e.n2 * 0.004 + e.vibBoost * 0.6 + nz * 0.06;
  e.vib1 = lag(e.vib1, v1, 0.4, dt);
  e.vib2 = lag(e.vib2, v2, 0.4, dt);

  e.thrust = 296 * Math.pow(clamp(e.n1 / 102, 0, 1.05), 2.7);

  if (e.vib1 > 4 && !e.vibWarned) {
    e.vibWarned = true;
    msg('ENG VIB HIGH', 'warn');
  }
  if (e.vib1 < 2.5) e.vibWarned = false;
  if (e.n1 > 104 && !e.overspeed) {
    e.overspeed = true;
    msg('ENG N1 OVERSPEED', 'warn');
  }
  if (e.n1 < 103) e.overspeed = false;
}

/* ---- Auto flight demo ------------------------------------------- */

const DEMO = [
  { start: true },
  { waitRun: true },
  { thr: 0, hold: 6 },
  { thr: 1, hold: 26 },
  { thr: 0.72, hold: 20 },
  { thr: 0.55, hold: 18 },
  { thr: 0.12, hold: 10 },
  { thr: 0, hold: 6 },
  { stop: true }
];
const demo = { active: false, i: 0, t: 0, set: false };

function setThrottle(v) {
  eng.thr = clamp(v, 0, 1);
  const s = document.querySelector('#eng-thr');
  if (s) s.value = Math.round(eng.thr * 100);
  eng.dirty = true;
}

function startDemo() {
  demo.active = true;
  demo.i = 0;
  demo.t = 0;
  demo.set = false;
  msg('AUTO FLIGHT · ENGAGED', 'info');
  syncBar();
}

function cancelDemo() {
  if (!demo.active) return;
  demo.active = false;
  msg('AUTO FLIGHT · OFF', 'info');
  syncBar();
}

function stepDemo(dt) {
  if (!demo.active) return;
  const s = DEMO[demo.i];
  if (!s) {
    demo.active = false;
    syncBar();
    return;
  }
  if (s.start) {
    startEngine();
    demo.i++;
  } else if (s.waitRun) {
    if (eng.state === 'run') demo.i++;
  } else if (s.stop) {
    stopEngine();
    demo.i++;
  } else {
    if (!demo.set) {
      setThrottle(s.thr);
      demo.set = true;
    }
    demo.t += dt;
    if (demo.t >= s.hold) {
      demo.i++;
      demo.t = 0;
      demo.set = false;
    }
  }
}

/* ================================================================== */
/* Airflow particles                                                   */
/* ================================================================== */

const HUB_FAN = x =>
  x < -2.55 ? 0
    : x < -2.05 ? 0.5 * Math.pow(Math.sin(((x + 2.55) / 0.5) * Math.PI / 2), 0.8)
      : x < -1.6 ? lerp(0.5, 0.4, (x + 2.05) / 0.45)
        : 0.4;
const CORE_IN = [[-1.62, 0.41], [-0.62, 0.47], [-0.3, 0.31], [0.8, 0.34], [0.9, 0.38], [1.12, 0.38], [1.2, 0.32], [1.55, 0.35], [2.4, 0.41], [2.9, 0.2], [3.25, 0]];
const CORE_OUT = [[-1.62, 0.72], [-0.62, 0.64], [-0.3, 0.56], [0.8, 0.38], [0.9, 0.52], [0.96, 0.55], [1.12, 0.55], [1.2, 0.57], [1.55, 0.6], [2.4, 0.82], [2.52, 0.78], [2.68, 0.7], [2.84, 0.62], [2.9, 0.6]];
const OUT_C = [[-1.62, 0.74], [-0.62, 0.66], [-0.3, 0.58], [0.8, 0.4], [0.88, 0.62], [0.96, 0.68], [1.08, 0.68], [1.15, 0.6], [1.55, 0.62], [2.4, 0.84], [2.52, 0.8], [2.68, 0.72], [2.84, 0.64], [2.9, 0.62]];

const PCOUNT = 2600;
const PACTIVE = IS_SMALL ? 1300 : PCOUNT;
const pPos = new Float32Array(PCOUNT * 3);
const pCol = new Float32Array(PCOUNT * 4);
const pd = [];

function spawn(p, initial) {
  p.core = Math.random() < 0.22;
  p.f = Math.random();
  p.th = Math.random() * TAU;
  p.v = 0.75 + Math.random() * 0.5;
  const xmax = p.core ? 5.3 : 4.3;
  p.x = initial ? lerp(-4.2, xmax, Math.random()) : -4.2 - Math.random() * 0.4;
}
for (let i = 0; i < PCOUNT; i++) {
  const p = {};
  spawn(p, true);
  pd.push(p);
}

function particleRadius(p) {
  const x = p.x;
  const tot = p.core ? p.f * 0.22 : 0.26 + p.f * 0.74;
  const rInlet = lerp(HUB_FAN(x), 1.5, tot) * lerp(1.3, 1, sstep(-4.2, -2.4, x));
  let rs;
  if (x > 2.9) {
    const jr = 0.6 + 0.2 * (x - 2.9);
    rs = p.core ? jr * Math.pow(p.f, 0.6) : lerp(jr + 0.08, Math.max(jr + 0.3, 1.1), p.f);
  } else if (p.core) {
    const a = tbl(CORE_IN, x) + 0.012;
    const b = tbl(CORE_OUT, x) - 0.015;
    rs = lerp(a, Math.max(b, a + 0.01), p.f);
  } else {
    const a = tbl(OUT_C, x) + 0.075;
    const b = x < -0.3 ? fanCaseIn(x) - 0.025 : lerp(1.4, 1.2, (x + 0.3) / 3.2);
    rs = lerp(a, Math.max(b, a + 0.05), p.f);
  }
  return lerp(rInlet, rs, sstep(-1.9, -1.5, x));
}

const pGeo = new THREE.BufferGeometry();
pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
pGeo.setAttribute('color', new THREE.BufferAttribute(pCol, 4));
pGeo.setDrawRange(0, PACTIVE);

function softSprite() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.45)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

const flow = new THREE.Points(
  pGeo,
  new THREE.PointsMaterial({
    size: 0.075,
    map: softSprite(),
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    fog: false,
    sizeAttenuation: true
  })
);
flow.frustumCulled = false;
root.add(flow);

let airflowOn = true;

function heatLevel() {
  return Math.pow(clamp((eng.egt - 120) / 800, 0, 1), 0.8);
}

function updateParticles(dt) {
  flow.visible = airflowOn && !exploded && (eng.n1 > 0.5 || eng.n2 > 0.5);
  if (!flow.visible) return;

  const s1 = clamp(eng.n1 / 100, 0, 1.1);
  const s2 = clamp(eng.n2 / 100, 0, 1.1);
  const alpha = clamp(Math.max(eng.n1, eng.n2 * 0.5) / 14, 0, 1);
  const hot = clamp(heatLevel() * 1.5, 0, 1);

  for (let i = 0; i < PACTIVE; i++) {
    const p = pd[i];
    const sp = (p.core ? s2 * 5.2 : s1 * 6.2) * p.v * (p.x > 2.9 ? 1.5 : 1);
    p.x += sp * dt;
    if (p.x > (p.core ? 5.3 : 4.3)) spawn(p, false);

    const r = particleRadius(p);
    pPos[i * 3] = p.x;
    pPos[i * 3 + 1] = Math.cos(p.th) * r;
    pPos[i * 3 + 2] = Math.sin(p.th) * r;

    let cr = 0.5;
    let cg = 0.76;
    let cb = 1.0;
    let br = 0.75;
    const x = p.x;
    if (p.core) {
      const w = sstep(-0.4, 0.85, x);
      cr = lerp(cr, 1, w);
      cg = lerp(cg, 0.9, w);
      cb = lerp(cb, 0.72, w);
      const h = sstep(0.85, 1.0, x) * hot;
      cr = lerp(cr, 1.0, h);
      cg = lerp(cg, 0.45, h);
      cb = lerp(cb, 0.1, h);
      if (x > 2.9) br *= 1 - sstep(2.9, 5.3, x);
    } else if (x > 2.9) {
      br *= (1 - sstep(2.9, 4.3, x)) * 0.7;
    }
    br *= alpha;
    pCol[i * 4] = cr;
    pCol[i * 4 + 1] = cg;
    pCol[i * 4 + 2] = cb;
    pCol[i * 4 + 3] = br;
  }
  pGeo.attributes.position.needsUpdate = true;
  pGeo.attributes.color.needsUpdate = true;
}

/* ================================================================== */
/* Sound (Web Audio, synthesized)                                      */
/* ================================================================== */

const audio = { ctx: null, on: false };

function initAudio() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return false;
  const ctx = new AC();
  audio.ctx = ctx;
  audio.master = ctx.createGain();
  audio.master.gain.value = 0;
  audio.master.connect(ctx.destination);

  const len = ctx.sampleRate * 3;
  const brown = ctx.createBuffer(1, len, ctx.sampleRate);
  const white = ctx.createBuffer(1, len, ctx.sampleRate);
  const bd = brown.getChannelData(0);
  const wd = white.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    last = (last + 0.02 * w) / 1.02;
    bd[i] = last * 3.5;
    wd[i] = w;
  }

  const noise = (buf, type, freq, q) => {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    if (q) f.Q.value = q;
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(f);
    f.connect(g);
    g.connect(audio.master);
    src.start();
    return { f, g };
  };
  audio.rumble = noise(brown, 'lowpass', 200);
  audio.hiss = noise(white, 'bandpass', 2500, 0.7);

  const osc = type => {
    const o = ctx.createOscillator();
    o.type = type;
    const g = ctx.createGain();
    g.gain.value = 0;
    o.connect(g);
    g.connect(audio.master);
    o.start();
    return { o, g };
  };
  audio.fanTone = osc('sawtooth');
  audio.hpTone = osc('triangle');
  return true;
}

function resumeAudio() {
  if (audio.ctx && audio.ctx.state === 'suspended') audio.ctx.resume();
}

function updateAudio() {
  if (!audio.ctx) return;
  const t = audio.ctx.currentTime;
  const n1 = eng.n1 / 100;
  const n2 = eng.n2 / 100;
  audio.master.gain.setTargetAtTime(audio.on ? 0.5 : 0, t, 0.1);
  audio.rumble.g.gain.setTargetAtTime(Math.min(1, n2 * 1.2 + n1 * 0.6) * 0.9, t, 0.15);
  audio.rumble.f.frequency.setTargetAtTime(120 + n1 * 420, t, 0.15);
  audio.hiss.g.gain.setTargetAtTime(Math.pow(n1, 2.2) * 0.4, t, 0.15);
  audio.hiss.f.frequency.setTargetAtTime(1200 + n1 * 3200, t, 0.15);
  audio.fanTone.o.frequency.setTargetAtTime(90 + n1 * 620, t, 0.1);
  audio.fanTone.g.gain.setTargetAtTime(n1 > 0.02 ? 0.01 + n1 * 0.035 : 0, t, 0.15);
  audio.hpTone.o.frequency.setTargetAtTime(300 + n2 * 1500, t, 0.1);
  audio.hpTone.g.gain.setTargetAtTime(Math.pow(n2, 2) * 0.02, t, 0.15);
}

/* ================================================================== */
/* HUD: primary / secondary display (bottom right) + control bar       */
/* ================================================================== */

const css = document.createElement('style');
css.textContent = `
.eng-display{position:absolute;right:12px;bottom:12px;width:min(340px,calc(100% - 24px));z-index:5;
  background:linear-gradient(180deg,rgba(8,16,26,.88),rgba(4,9,16,.92));border:1px solid rgba(90,160,210,.35);
  border-radius:12px;padding:9px 11px 10px;color:#d8e8f5;backdrop-filter:blur(6px);
  font:11px/1.25 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;box-shadow:0 8px 30px rgba(0,0,0,.45);user-select:none}
.eng-head{display:flex;align-items:center;gap:8px;margin-bottom:4px}
.eng-title{font-weight:700;letter-spacing:.08em;color:#fff;flex:1}
.eng-title i{font-style:normal;color:#7fb4d6;font-weight:400;margin-left:4px}
.eng-badge{padding:2px 8px;border-radius:99px;font-weight:700;letter-spacing:.08em;background:#243746;color:#9db8cc}
.eng-badge.start{background:#4a3a10;color:#ffcf5a}.eng-badge.run{background:#10432b;color:#6dffb0}.eng-badge.stop{background:#4a2a12;color:#ff9c5a}
.eng-min{background:none;border:1px solid rgba(120,170,210,.4);color:#9fc4de;border-radius:6px;width:22px;height:20px;cursor:pointer;line-height:1}
.eng-display.min .eng-body{display:none}
.eng-sec{margin:6px 0 3px;color:#4fb6ff;letter-spacing:.18em;font-size:9px}
.eng-gauges{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.eng-gauge{width:100%;height:auto;display:block}
.eng-gauge .trk{fill:none;stroke:#26384a;stroke-width:6;stroke-linecap:round}
.eng-gauge .val{fill:none;stroke:#5cff9d;stroke-width:6;stroke-linecap:round}
.eng-gauge .val.warn{stroke:#ffbf3a}.eng-gauge .val.red{stroke:#ff4d4d}
.eng-gauge .zw{fill:none;stroke:#ffbf3a;stroke-width:2;opacity:.8}.eng-gauge .zr{fill:none;stroke:#ff4d4d;stroke-width:2}
.eng-gauge .tk{stroke:#5d7a92;stroke-width:1}
.eng-gauge .ndl{stroke:#fff;stroke-width:2.2;stroke-linecap:round}
.eng-gauge .bug{stroke:#35d6ff;stroke-width:3;stroke-linecap:round}
.eng-gauge .hub{fill:#fff}
.eng-gauge .lbl{fill:#7fb4d6;font:700 9px ui-monospace,Menlo,monospace;text-anchor:middle;letter-spacing:.1em}
.eng-gauge .num{fill:#6dffb0;font:700 15px ui-monospace,Menlo,monospace;text-anchor:middle}
.eng-gauge .num.warn{fill:#ffbf3a}.eng-gauge .num.red{fill:#ff4d4d}
.eng-grid{display:grid;grid-template-columns:1fr 1fr;gap:5px 12px}
.eng-row{display:grid;grid-template-columns:auto 1fr auto;column-gap:5px;align-items:baseline}
.eng-row .k{color:#7fb4d6}.eng-row .v{text-align:right;color:#fff;font-weight:700}.eng-row .v.warn{color:#ffbf3a}.eng-row .v.red{color:#ff4d4d}
.eng-row u{text-decoration:none;color:#58758b;font-size:9px}
.eng-row .bar{grid-column:1/-1;height:3px;background:#1c2b3a;border-radius:2px;overflow:hidden}
.eng-row .bar b{display:block;height:100%;width:0;background:#4fb6ff}
.eng-ann{display:flex;gap:5px;margin-top:7px;flex-wrap:wrap}
.eng-ann span{padding:2px 7px;border-radius:5px;background:#16232f;color:#4d6679;font-weight:700;letter-spacing:.06em}
.eng-ann span.on{background:#10432b;color:#6dffb0}.eng-ann span.amb{background:#4a3a10;color:#ffcf5a}
.eng-msgs{margin-top:6px;min-height:42px}
.eng-msgs div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#9ec4dd}
.eng-msgs div.ok{color:#6dffb0}.eng-msgs div.warn{color:#ffbf3a}.eng-msgs div.info{color:#8fd0ff}
.eng-msgs div:not(:first-child){opacity:.55}
@media (max-width:560px){.eng-gauges{gap:2px}.eng-grid{gap:4px 8px}}

.eng-bar{display:flex;flex-wrap:wrap;gap:10px 18px;align-items:center;margin:12px 0;padding:11px 14px;
  background:rgba(8,16,26,.72);border:1px solid rgba(90,160,210,.28);border-radius:12px;color:#d8e8f5;
  font:11px/1.2 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.06em}
.eng-group{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.eng-group>label{color:#7fb4d6;font-size:10px;letter-spacing:.14em}
.eng-btn{font:inherit;color:#d8e8f5;background:#13222f;border:1px solid rgba(120,170,210,.4);border-radius:8px;padding:7px 11px;cursor:pointer;letter-spacing:.1em;transition:.15s}
.eng-btn:hover{background:#1b3144}.eng-btn.on{background:#10432b;border-color:#3fe08f;color:#6dffb0}
.eng-btn.go{border-color:#3fe08f;color:#6dffb0;font-weight:700}.eng-btn.halt{border-color:#ff7a4d;color:#ff9c7a;font-weight:700}
.eng-btn.warn{border-color:#ffbf3a;color:#ffcf5a}.eng-btn:disabled{opacity:.35;cursor:not-allowed}
.eng-btn.sel{background:#16384f;border-color:#4fb6ff;color:#fff}
.eng-bar input[type=range]{width:150px;accent-color:#4fb6ff}
.eng-thrv{min-width:92px;color:#fff;font-weight:700}
.eng-mini{display:none;color:#9fc4de;white-space:nowrap}
.eng-display.min .eng-mini{display:inline}
.eng-display.compact{left:8px;right:8px;width:auto;bottom:8px;padding:7px 9px}
.eng-display.compact .eng-title i{display:none}
.eng-display.compact .eng-gauges{max-width:270px;margin:0 auto}
.eng-display.compact .eng-grid{grid-template-columns:repeat(3,1fr);gap:4px 8px}
.eng-display.compact .eng-msgs{display:none}

/* overlay captions stay readable on the bright sky */
.viewer-overlay span,.viewer-label{text-shadow:0 1px 3px rgba(0,0,0,.65);background:rgba(6,14,24,.55);
  padding:4px 8px;border-radius:6px;backdrop-filter:blur(4px)}

/* adaptive layout */
.viewer-stage{position:relative;height:clamp(340px,68vh,700px);min-height:320px;max-width:100%;overflow:hidden}
.engine-viewer,.viewer-top,.viewer-controls,.component-grid{max-width:100%}
.viewer-top{flex-wrap:wrap;gap:8px 16px}
.viewer-controls{flex-wrap:wrap;gap:8px}
@media (max-width:900px){
  .component-grid{display:grid!important;grid-template-columns:repeat(4,minmax(0,1fr))!important}
}
@media (max-width:640px){
  .viewer-stage{height:clamp(300px,58vh,520px)}
  .component-grid{display:grid!important;grid-template-columns:repeat(2,minmax(0,1fr))!important}
  .eng-bar{gap:10px;padding:10px}
  .eng-group{width:100%}
  .eng-bar input[type=range]{flex:1;min-width:120px}
  .eng-btn{padding:9px 12px;min-height:40px}
}
@media (max-width:380px){
  .component-grid{grid-template-columns:1fr!important}
}
`;
document.head.appendChild(css);

function gaugeHTML(id, label, max, warn, red, unit, bug) {
  const cx = 50;
  const cy = 52;
  const r = 36;
  const pt = (a, rad) => [cx + rad * Math.sin(deg(a)), cy - rad * Math.cos(deg(a))];
  const ang = v => -135 + (270 * v) / max;
  const [x1, y1] = pt(-135, r);
  const [x2, y2] = pt(135, r);
  const d = `M${x1.toFixed(2)} ${y1.toFixed(2)} A${r} ${r} 0 1 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
  const arc = (a0, a1, rad) => {
    const [ax, ay] = pt(a0, rad);
    const [bx, by] = pt(a1, rad);
    return `M${ax.toFixed(2)} ${ay.toFixed(2)} A${rad} ${rad} 0 0 1 ${bx.toFixed(2)} ${by.toFixed(2)}`;
  };
  let ticks = '';
  for (let i = 0; i <= 10; i++) {
    const a = -135 + 27 * i;
    const [ax, ay] = pt(a, r + 3);
    const [bx, by] = pt(a, r + (i % 5 === 0 ? 8 : 6));
    ticks += `<line class="tk" x1="${ax.toFixed(1)}" y1="${ay.toFixed(1)}" x2="${bx.toFixed(1)}" y2="${by.toFixed(1)}"/>`;
  }
  const L = (r * deg(270)).toFixed(2);
  return `<svg class="eng-gauge" viewBox="0 0 100 100" id="g-${id}">
    <path class="trk" d="${d}"/>
    <path class="val" id="${id}-val" d="${d}" stroke-dasharray="${L}" stroke-dashoffset="${L}"/>
    <path class="zw" d="${arc(ang(warn), ang(red), r + 11)}"/>
    <path class="zr" d="${arc(ang(red), 135, r + 11)}"/>
    ${ticks}
    ${bug ? `<line class="bug" id="${id}-bug" x1="50" y1="${cy - r - 4}" x2="50" y2="${cy - r + 6}" transform="rotate(-135 50 52)"/>` : ''}
    <line class="ndl" id="${id}-ndl" x1="50" y1="52" x2="50" y2="22" transform="rotate(-135 50 52)"/>
    <circle class="hub" cx="50" cy="52" r="3.4"/>
    <text class="lbl" x="50" y="38">${label}${unit ? ' ' + unit : ''}</text>
    <text class="num" id="${id}-num" x="50" y="93">0</text>
  </svg>`;
}

const gaugeCfg = {
  n1: { max: 110, warn: 102, red: 104 },
  egt: { max: 1200, warn: 950, red: 1050 }
};

const row = (id, k, u) =>
  `<div class="eng-row"><span class="k">${k}</span><span class="v" id="v-${id}">0</span><u>${u}</u><div class="bar"><b id="b-${id}"></b></div></div>`;

const display = document.createElement('div');
display.className = 'eng-display';
display.innerHTML = `
  <div class="eng-head">
    <span class="eng-title">ENGINE 1<i>GEnx-1B · SIM</i></span>
    <span class="eng-mini" id="eng-mini"></span>
    <span class="eng-badge" id="eng-badge">OFF</span>
    <button class="eng-min" id="eng-min" aria-label="Collapse display">–</button>
  </div>
  <div class="eng-body">
    <div class="eng-sec">PRIMARY</div>
    <div class="eng-gauges">
      ${gaugeHTML('n1', 'N1', 110, 102, 104, '%', true)}
      ${gaugeHTML('egt', 'EGT', 1200, 950, 1050, '°C', false)}
    </div>
    <div class="eng-sec">SECONDARY</div>
    <div class="eng-grid">
      ${row('n2', 'N2', '%')}
      ${row('ff', 'FF', 'KG/H')}
      ${row('oilp', 'OIL P', 'PSI')}
      ${row('oilt', 'OIL T', '°C')}
      ${row('vib', 'VIB', 'N1')}
      ${row('thr', 'THRUST', 'kN')}
    </div>
    <div class="eng-ann">
      <span id="a-starter">STARTER</span><span id="a-ign">IGN</span><span id="a-fuel">FUEL</span><span id="a-tgt">N1 TGT --</span>
    </div>
    <div class="eng-msgs" id="eng-msgs"></div>
  </div>`;
stage.appendChild(display);

display.querySelector('#eng-min').addEventListener('click', () => {
  display.classList.toggle('min');
});

const gEl = {};
['n1', 'egt'].forEach(id => {
  gEl[id] = {
    val: display.querySelector(`#${id}-val`),
    ndl: display.querySelector(`#${id}-ndl`),
    num: display.querySelector(`#${id}-num`),
    bug: display.querySelector(`#${id}-bug`),
    L: 36 * deg(270)
  };
});

const $ = id => display.querySelector('#' + id);

function setGauge(id, v, digits) {
  const c = gaugeCfg[id];
  const g = gEl[id];
  let { warn, red } = c;
  if (id === 'egt' && eng.state === 'start') {
    warn = 700;
    red = 750;
  }
  const f = clamp(v / c.max, 0, 1);
  g.val.setAttribute('stroke-dashoffset', (g.L * (1 - f)).toFixed(2));
  g.ndl.setAttribute('transform', `rotate(${(-135 + 270 * f).toFixed(2)} 50 52)`);
  const cls = v >= red ? 'red' : v >= warn ? 'warn' : '';
  g.val.setAttribute('class', 'val ' + cls);
  g.num.setAttribute('class', 'num ' + cls);
  g.num.textContent = v.toFixed(digits);
}

function setRow(id, v, max, digits, cls = '') {
  const el = $('v-' + id);
  el.textContent = v.toFixed(digits);
  el.className = 'v ' + cls;
  $('b-' + id).style.width = clamp((v / max) * 100, 0, 100) + '%';
}

function modeName() {
  const t = eng.thr;
  return t < 0.05 ? 'IDLE' : t < 0.35 ? 'APPR' : t < 0.65 ? 'CRZ' : t < 0.92 ? 'CLB' : 'TOGA';
}

function updateDisplay() {
  setGauge('n1', eng.n1, 1);
  setGauge('egt', eng.egt, 0);
  $('eng-mini').textContent = `N1 ${eng.n1.toFixed(0)} · EGT ${eng.egt.toFixed(0)}`;
  const n1Tgt = eng.state === 'run' ? n1FromN2(n2Target(eng.thr)) : null;
  const g = gEl.n1.bug;
  if (n1Tgt !== null) {
    g.setAttribute('transform', `rotate(${(-135 + 270 * clamp(n1Tgt / 110, 0, 1)).toFixed(2)} 50 52)`);
    g.style.opacity = 1;
  } else {
    g.style.opacity = 0;
  }

  setRow('n2', eng.n2, 105, 1, eng.n2 > 100 ? 'red' : '');
  setRow('ff', eng.ff, 7500, 0);
  setRow('oilp', eng.oilP, 100, 0, eng.n2 > 20 && eng.oilP < 20 ? 'warn' : '');
  setRow('oilt', eng.oilT, 160, 0, eng.oilT > 140 ? 'warn' : '');
  const vib = Math.max(eng.vib1, eng.vib2);
  setRow('vib', vib, 6, 1, vib > 5 ? 'red' : vib > 4 ? 'warn' : '');
  setRow('thr', eng.thrust, 300, 0);

  $('a-starter').className = eng.starter ? 'amb' : '';
  $('a-ign').className = eng.ign ? 'amb' : '';
  $('a-fuel').className = eng.fuel ? 'on' : '';
  $('a-tgt').textContent = n1Tgt !== null ? `N1 TGT ${n1Tgt.toFixed(1)}` : 'N1 TGT --';

  const badge = $('eng-badge');
  badge.textContent = { off: 'OFF', start: 'START', run: 'RUN', stop: 'SHUTDOWN' }[eng.state];
  badge.className = 'eng-badge ' + eng.state;

  if (eng.dirty) {
    $('eng-msgs').innerHTML = eng.msgs.map(m => `<div class="${m.level}">› ${m.text}</div>`).join('');
    eng.dirty = false;
    syncBar();
  }
}

/* ---- control bar ------------------------------------------------- */

const bar = document.createElement('div');
bar.className = 'eng-bar';
bar.innerHTML = `
  <div class="eng-group">
    <button class="eng-btn go" id="eng-start">▶ START</button>
    <button class="eng-btn halt" id="eng-stop">■ STOP</button>
  </div>
  <div class="eng-group">
    <label>THROTTLE</label>
    <input type="range" id="eng-thr" min="0" max="100" value="0" aria-label="Throttle">
    <span class="eng-thrv" id="eng-thr-val">IDLE 0%</span>
    <button class="eng-btn" data-thr="0">IDLE</button>
    <button class="eng-btn" data-thr="65">CLB</button>
    <button class="eng-btn" data-thr="100">TOGA</button>
  </div>
  <div class="eng-group">
    <label>SIM SPEED</label>
    <button class="eng-btn" data-sim="1">1×</button>
    <button class="eng-btn" data-sim="2">2×</button>
    <button class="eng-btn" data-sim="4">4×</button>
  </div>
  <div class="eng-group">
    <button class="eng-btn" id="eng-air">AIRFLOW</button>
    <button class="eng-btn" id="eng-snd">SOUND</button>
    <button class="eng-btn" id="eng-cut">CUTAWAY</button>
    <button class="eng-btn" id="eng-demo">AUTO FLIGHT</button>
    <button class="eng-btn warn" id="eng-bird">BIRD STRIKE</button>
  </div>`;

const anchor = document.querySelector('.viewer-controls');
if (anchor) anchor.insertAdjacentElement('afterend', bar);
else stage.insertAdjacentElement('afterend', bar);

const B = id => bar.querySelector('#' + id);

function syncBar() {
  B('eng-start').disabled = eng.state === 'start' || eng.state === 'run';
  B('eng-stop').disabled = eng.state === 'off' && eng.n2 < 0.5;
  B('eng-thr-val').textContent = `${modeName()} ${Math.round(eng.thr * 100)}%`;
  B('eng-air').classList.toggle('on', airflowOn);
  B('eng-snd').classList.toggle('on', audio.on);
  B('eng-cut').classList.toggle('on', cutaway);
  B('eng-demo').classList.toggle('on', demo.active);
  bar.querySelectorAll('[data-sim]').forEach(b => b.classList.toggle('sel', +b.dataset.sim === eng.sim));
}

B('eng-start').addEventListener('click', () => {
  cancelDemo();
  startEngine();
  syncBar();
});
B('eng-stop').addEventListener('click', () => {
  cancelDemo();
  stopEngine();
  syncBar();
});
B('eng-thr').addEventListener('input', e => {
  cancelDemo();
  setThrottle(e.target.value / 100);
  syncBar();
});
bar.querySelectorAll('[data-thr]').forEach(b =>
  b.addEventListener('click', () => {
    cancelDemo();
    setThrottle(+b.dataset.thr / 100);
    syncBar();
  })
);
bar.querySelectorAll('[data-sim]').forEach(b =>
  b.addEventListener('click', () => {
    eng.sim = +b.dataset.sim;
    syncBar();
  })
);
B('eng-air').addEventListener('click', () => {
  airflowOn = !airflowOn;
  syncBar();
});
B('eng-snd').addEventListener('click', () => {
  if (!audio.ctx && !initAudio()) return;
  audio.on = !audio.on;
  resumeAudio();
  syncBar();
});
B('eng-cut').addEventListener('click', () => {
  setCutaway(!cutaway);
  syncBar();
});
B('eng-demo').addEventListener('click', () => (demo.active ? cancelDemo() : startDemo()));
B('eng-bird').addEventListener('click', () => {
  birdStrike();
  syncBar();
});

/* ================================================================== */
/* View state                                                          */
/* ================================================================== */

function moduleFocusX(name) {
  const c = CENTER[name] + (exploded ? OFFSET[name] : 0);
  const k = exploded ? 0.5 : 0.3;
  return ENGINE_CENTER_X + (c - ENGINE_CENTER_X) * k;
}

function requestFocus(name) {
  focusGoal.set(name ? moduleFocusX(name) : ENGINE_CENTER_X, 0, 0);
  focusUntil = performance.now() + 1400;
}

function setExploded(on) {
  exploded = on;
  distGoal = on ? distExploded : distAssembled;
  stands.visible = !on;
  requestFocus(selected);

  document.querySelectorAll('.control-btn').forEach(button => {
    if (button.dataset.view === 'exploded' || button.dataset.view === 'assembled') {
      button.classList.toggle('active', button.dataset.view === (on ? 'exploded' : 'assembled'));
    }
  });
}

function setCutaway(on) {
  cutaway = on;
  cutVariants.forEach(m => {
    m.visible = (m.userData.variant === 'cut') === on;
  });
  if (typeof syncBar === 'function' && bar) syncBar();
}

function hexOf(part) {
  return '#' + new THREE.Color(PALETTE[part].base).getHexString();
}

function choosePart(name, focus = true) {
  selected = name && INFO[name] ? name : null;

  document.querySelectorAll('.component-card').forEach(card => {
    const active = !!selected && card.dataset.part === selected;
    const hex = PALETTE[card.dataset.part] ? hexOf(card.dataset.part) : '';
    card.classList.toggle('selected', active);
    card.setAttribute('aria-pressed', active ? 'true' : 'false');
    card.style.borderColor = active ? hex : '';
    card.style.boxShadow = active ? `0 0 0 1px ${hex}, 0 0 18px ${hex}44` : '';
  });

  const detail = document.querySelector('#part-detail');
  if (detail) {
    const h = detail.querySelector('h4');
    const p = detail.querySelector('p');
    if (selected) {
      if (h) {
        h.textContent = INFO[selected].title;
        h.style.color = hexOf(selected);
      }
      if (p) {
        p.textContent =
          INFO[selected].description + ' Procedural educational model; not OEM CAD or maintenance data.';
      }
    } else {
      if (h) {
        h.textContent = 'Select a module';
        h.style.color = '';
      }
      if (p) {
        p.textContent =
          'Click a module card or a part of the engine to inspect it. Click the selected module again to clear the selection.';
      }
    }
  }

  const label = document.querySelector('#engine-label');
  if (label) label.textContent = selected ? INFO[selected].title.toUpperCase() : 'GENX-INSPIRED TURBOFAN';

  if (focus) requestFocus(selected);
}

// Pressing the selected module again clears the selection
function toggleSelect(name) {
  choosePart(selected === name ? null : name);
}

// Selection glow + live heat glow, per-module materials (no shared-material bleed)
function applyEmissive() {
  const H = heatLevel();
  // glow colour: deep red -> orange -> yellow-white as EGT rises
  const hr0 = lerp(0.9, 1.0, H);
  const hg0 = lerp(0.1, 0.7, H * H);
  const hb0 = lerp(0.02, 0.28, H * H * H);

  for (const part in partMaterials) {
    const sel = part === selected;
    const sc = SELCOL[part];
    const ph = PART_HEAT[part] * H * 1.7;
    for (const m of partMaterials[part]) {
      const k = ph * (m.userData.heatW || 0);
      m.emissive.setRGB(
        hr0 * k + (sel ? sc.r * 0.32 : 0),
        hg0 * k + (sel ? sc.g * 0.32 : 0),
        hb0 * k + (sel ? sc.b * 0.32 : 0)
      );
      m.emissiveIntensity = 1;
    }
  }

  const tm = performance.now() * 0.001;
  for (let i = 0; i < glowObjs.length; i++) {
    const g = glowObjs[i];
    g.s.material.opacity = clamp(H * g.weight * 1.15, 0, 1) * 0.85;
    g.s.scale.setScalar(g.scale * (1 + 0.07 * Math.sin(tm * 11 + i * 1.7)) * (0.8 + 0.3 * H));
  }
  for (const h of heatLights) h.l.intensity = h.max * H;
}

/* ================================================================== */
/* Interaction                                                         */
/* ================================================================== */

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

function pickPart(event) {
  const rect = canvas.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);

  const hits = raycaster.intersectObjects(selectable, false);
  for (const h of hits) {
    if (h.object.visible) return h.object.userData.part;
  }
  return null;
}

let downX = 0;
let downY = 0;
let lastMove = 0;

canvas.addEventListener('pointerdown', e => {
  downX = e.clientX;
  downY = e.clientY;
});

canvas.addEventListener('pointerup', e => {
  if (Math.hypot(e.clientX - downX, e.clientY - downY) > 5) return;
  const part = pickPart(e);
  if (part) toggleSelect(part);
});

canvas.addEventListener('pointermove', e => {
  if (e.buttons) return;
  const now = performance.now();
  if (now - lastMove < 60) return;
  lastMove = now;
  canvas.style.cursor = pickPart(e) ? 'pointer' : 'grab';
});

document.querySelectorAll('.component-card').forEach(card => {
  if (PALETTE[card.dataset.part]) card.style.setProperty('--module-color', hexOf(card.dataset.part));
  card.addEventListener('click', () => toggleSelect(card.dataset.part));
});

document.querySelectorAll('.control-btn').forEach(button => {
  button.addEventListener('click', () => {
    switch (button.dataset.view) {
      case 'exploded':
        setExploded(true);
        break;
      case 'assembled':
        setExploded(false);
        break;
      case 'cutaway':
        setCutaway(!cutaway);
        button.classList.toggle('active', cutaway);
        break;
      case 'reset':
        setExploded(false);
        setCutaway(true);
        controls.target.set(ENGINE_CENTER_X, 0, 0);
        placeHome();
        focusGoal.set(ENGINE_CENTER_X, 0, 0);
        focusUntil = 0;
        controls.update();
        break;
    }
  });
});

const auto = document.querySelector('#auto-rotate');
if (auto) {
  controls.autoRotate = auto.checked;
  auto.addEventListener('change', e => {
    controls.autoRotate = e.target.checked;
  });
}

/* ================================================================== */
/* Responsive                                                          */
/* ================================================================== */

let lastAspect = 0;
let hudInit = false;

function placeHome() {
  const dir = HOME_CAMERA.clone().sub(new THREE.Vector3(ENGINE_CENTER_X, 0, 0)).normalize();
  camera.position.copy(controls.target).add(dir.multiplyScalar(exploded ? distExploded : distAssembled));
}

// Keep the whole engine in frame on narrow / portrait screens
function fitDistances() {
  const a = camera.aspect;
  distAssembled = Math.max(DIST_ASSEMBLED, 10.8 / a);
  distExploded = Math.max(DIST_EXPLODED, 16.6 / a);
  controls.maxDistance = Math.max(24, distExploded * 1.25);
}

function layoutHud(w, h) {
  display.classList.toggle('compact', w < 560);
  if (!hudInit) {
    hudInit = true;
    if (w < 560 || h < 420) display.classList.add('min');
  }
}

function resize() {
  const r = stage.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width));
  const h = Math.max(1, Math.round(r.height) || 520);

  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
  layoutHud(w, h);

  if (!lastAspect) {
    lastAspect = camera.aspect;
    fitDistances();
    distGoal = exploded ? distExploded : distAssembled;
    placeHome();
  } else if (Math.abs(camera.aspect / lastAspect - 1) > 0.08) {
    lastAspect = camera.aspect;
    fitDistances();
    distGoal = exploded ? distExploded : distAssembled;
    focusUntil = performance.now() + 1200;
  }
}

if ('ResizeObserver' in window) {
  new ResizeObserver(resize).observe(stage);
} else {
  window.addEventListener('resize', resize);
}

/* ================================================================== */
/* Init                                                                */
/* ================================================================== */

camera.position.copy(HOME_CAMERA);
controls.target.set(ENGINE_CENTER_X, 0, 0);
controls.update();

setCutaway(true);
choosePart(null, false);
msg('ENGINE OFF · PRESS START', 'info');
syncBar();
updateDisplay();
resize();

/* ================================================================== */
/* Render loop                                                         */
/* ================================================================== */

const clock = new THREE.Clock();
let lastHud = 0;

let running = false;
let inView = true;

function animate() {
  if (!running) return;
  requestAnimationFrame(animate);

  const dt = Math.min(clock.getDelta(), 0.05);
  const ease = 1 - Math.pow(0.001, dt);

  // engine physics (sim time)
  let rest = dt * eng.sim;
  while (rest > 1e-6) {
    const h = Math.min(rest, 0.1);
    stepDemo(h);
    stepEngine(h);
    rest -= h;
  }

  // spool-driven rotation
  for (const s of spinning) {
    const n = s.spool === 'lp' ? eng.n1 / 100 : eng.n2 / 100;
    s.group.rotation.x += s.dir * n * (s.spool === 'lp' ? LP_MAX : HP_MAX) * dt;
  }

  // exploded / assembled motion
  for (const name in parts) {
    const target = exploded ? OFFSET[name] : 0;
    parts[name].position.x += (target - parts[name].position.x) * ease;
  }

  // vibration shake
  const shake = Math.min(0.03, Math.max(0, Math.max(eng.vib1, eng.vib2) - 0.5) * 0.004);
  root.position.set((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);

  // focus + dolly
  if (performance.now() < focusUntil) {
    const old = controls.target.clone();
    controls.target.lerp(focusGoal, 0.09);
    camera.position.add(controls.target.clone().sub(old));

    const dist = camera.position.distanceTo(controls.target);
    const nd = lerp(dist, distGoal, 0.08);
    camera.position.sub(controls.target).setLength(nd).add(controls.target);
  }

  applyEmissive();
  updateParticles(dt);
  updateAudio();

  const now = performance.now();
  if (now - lastHud > 80) {
    lastHud = now;
    updateDisplay();
    B('eng-thr-val').textContent = `${modeName()} ${Math.round(eng.thr * 100)}%`;
  }

  controls.update();
  renderer.render(scene, camera);
}

function setRunning(on) {
  if (on === running) return;
  running = on;
  if (on) {
    clock.getDelta(); // drop the paused gap
    animate();
    if (audio.ctx && audio.on) audio.ctx.resume();
  } else if (audio.ctx) {
    audio.ctx.suspend();
  }
}

function updateActive() {
  setRunning(inView && !document.hidden);
}

// Scrolling away from the engine (or hiding the tab) stops the simulation;
// it resumes when the viewer is back on screen.
if ('IntersectionObserver' in window) {
  new IntersectionObserver(
    entries => {
      const e = entries[entries.length - 1];
      const was = inView;
      inView = e.isIntersecting && e.intersectionRatio >= 0.12;
      if (was && !inView && AUTO_SHUTDOWN_ON_SCROLL) stopEngine();
      updateActive();
    },
    { threshold: [0, 0.12, 0.3, 0.6] }
  ).observe(stage);
}
document.addEventListener('visibilitychange', updateActive);
updateActive();
