import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const vscode = acquireVsCodeApi();

const X_SPACING = 2;
const LANE_STRETCH = 2.2; // extra horizontal spread between branches
const GOLDEN_ANGLE = 2.399963;
const LANE_COLORS = [0x4fc3f7, 0xff8a65, 0x81c784, 0xba68c8, 0xffd54f, 0xf06292, 0x4db6ac, 0x9575cd, 0xaed581, 0xe57373];
const REF_COLORS = { head: '#ffffff', branch: '#4caf50', remote: '#2196f3', tag: '#ffb300' };
const CLICK_TOLERANCE = 5;
const EDGE_SEGMENTS = 16;
const LABEL_PX = 22;
const BG_COLOR = 0x161616;
const DRAG_FALLOFF = 5; // world units; neighbours move by exp(-(d/R)^2)
const DIM_OPACITY = 0.25;
const LABEL_DIST_MAX = 200; // slider max means unlimited
const LOD_MIN_CHAIN = 6;
const CHAIN_RADIUS = 0.35;
const LOAD_MORE_MARGIN = 40;
const GLOW_COUNT = 12;
const SIM_WINDOW = 30; // repulsion only between commits this close in topo order
const SIM_REPULSION = 3;
const NO_DATA_COLOR = new THREE.Color(0x777777);
const UP = new THREE.Vector3(0, 1, 0);
const TUBE_SEGS = 12;
const TUBE_RADIAL = 6;
const TUBE_VERTS = (TUBE_SEGS + 1) * TUBE_RADIAL;
const ZOOM_SPEED = 0.002;
const MIN_ORBIT = 1.5; // closer than this, zooming flies forward instead of stalling
const DETAIL_PX = 18;
const DETAIL_MIN_ROW_PX = 20; // commit details appear once rows are at least this far apart on screen
const DETAIL_CACHE = 500;
const MAP_LANE = 0.45; // map layout: lane width as a fraction of branch spacing
const MAP_VIEW = new THREE.Vector3(0, 0, 55);

// --- scene setup ---
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(BG_COLOR);
scene.fog = new THREE.Fog(BG_COLOR, 140, 400);

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.05, 6000);

const controls = new OrbitControls(camera, renderer.domElement);
controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
controls.enableZoom = false; // custom wheel zoom below
controls.enableDamping = true;
controls.dampingFactor = 0.2;

let needsRender = true;
const invalidate = () => { needsRender = true; };
controls.addEventListener('change', invalidate);

const graphGroup = new THREE.Group();
scene.add(graphGroup);

// Blender-style backdrop grid behind the graph (XY plane) with a vertical time axis; snaps to the camera target so it seems infinite
const floor = new THREE.Group();
const grid = new THREE.GridHelper(8000, 1600, 0x262626, 0x1f1f1f);
const xAxis = new THREE.Line(
  new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, -4000, 0), new THREE.Vector3(0, 4000, 0)]),
  new THREE.LineBasicMaterial({ color: 0xc8404f })
);
// the grid fades out further away than the graph so the floor reaches the horizon
const GRID_FOG_SCALE = '3.0';
for (const m of [grid.material, xAxis.material]) {
  m.onBeforeCompile = shader => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <fog_fragment>', `#ifdef USE_FOG
      gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, smoothstep(fogNear * ${GRID_FOG_SCALE}, fogFar * ${GRID_FOG_SCALE}, vFogDepth));
    #endif`);
  };
}
floor.add(grid, xAxis);
grid.rotation.x = Math.PI / 2;
grid.renderOrder = xAxis.renderOrder = -2;
scene.add(floor);

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

let state = null; // { graph, positions, commitMesh, sprites, byHash }
let selectedHash = null;
let hoveredIndex = -1;
let hoveredKey = -1;
let loadedRoot = null;
const movedPositions = new Map(); // hash -> Vector3, survives refreshes
const simPositions = new Map(); // hash -> Vector3 from the organic layout, survives refreshes
const settings = {
  labelsDimmed: false,
  groupRefLabels: true,
  declutter: true,
  details: true,
  layout: 'map',
  depthVariation: 4,
  labelDistance: LABEL_DIST_MAX,
  colorMode: 'branch',
  sizeByChanges: true,
  organic: false,
  collapse: true,
  branchSpacing: 6,
  renderDistance: 400
};
let highlightUntil = 0;
let boundsDirty = false;
let chainsDirty = false;
let loadingMore = false;
let simAlpha = 0;
let simVel = null;

const sphereGeo = new THREE.SphereGeometry(0.28, 12, 8);
const cylGeo = new THREE.CylinderGeometry(1, 1, 1, 10, 1, true);
const haloTex = makeHaloTexture();
const SHARED = new Set([sphereGeo, cylGeo, haloTex]);
const tmpMatrix = new THREE.Matrix4();
const tmpColor = new THREE.Color();

// --- layout ---
function assignLanes(commits) {
  const index = new Map(commits.map((c, i) => [c.hash, i]));
  const lanes = [];
  const laneOf = new Array(commits.length);
  const head = commits.find(c => c.refs.some(r => r.type === 'head'));
  if (head) lanes[0] = head.hash; // keep HEAD's first-parent chain as the trunk

  const freeLane = () => {
    const i = lanes.findIndex(v => v == null);
    return i === -1 ? lanes.length : i;
  };

  commits.forEach((c, ci) => {
    let lane = lanes.indexOf(c.hash);
    if (lane === -1) lane = freeLane();
    for (let i = 0; i < lanes.length; i++) if (lanes[i] === c.hash) lanes[i] = null;
    laneOf[ci] = lane;
    const [first, ...rest] = c.parents;
    lanes[lane] = first && index.has(first) ? first : null;
    for (const p of rest) {
      if (index.has(p) && !lanes.includes(p)) lanes[freeLane()] = p;
    }
  });
  return laneOf;
}

// Time runs along Y by commit order (newest at 0, older downward), with an extra gap whenever the day changes.
const DAY_GAP = 5;
const dayKey = date => {
  const d = new Date(date);
  return d.getFullYear() * 10000 + d.getMonth() * 100 + d.getDate();
};
let timeAxisX = -6;

function commitTimes(commits) {
  const ts = new Float32Array(commits.length);
  for (let i = 1; i < commits.length; i++) {
    const newDay = dayKey(commits[i].cdate ?? commits[i].date) !== dayKey(commits[i - 1].cdate ?? commits[i - 1].date);
    ts[i] = ts[i - 1] - X_SPACING - (newDay ? DAY_GAP : 0);
  }
  return ts;
}

function lanePosition(lane) {
  if (settings.layout === 'map') {
    // deterministic per-lane depth so lanes don't all sit on one flat sheet; lane 0 (HEAD) stays at 0
    const z = lane === 0 ? 0 : Math.sin(lane * GOLDEN_ANGLE * 3.7) * settings.depthVariation;
    return [lane * settings.branchSpacing * MAP_LANE, z];
  }
  if (lane === 0) return [0, 0];
  const r = settings.branchSpacing * Math.sqrt(lane);
  const a = lane * GOLDEN_ANGLE;
  return [Math.cos(a) * r * LANE_STRETCH, Math.sin(a) * r]; // [x, z]
}

function makeHaloTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.3, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeLabelSprite(text, color) {
  const dpr = Math.max(2, window.devicePixelRatio);
  const fontPx = 13 * dpr;
  const font = `600 ${fontPx}px Segoe UI, sans-serif`;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = font;
  const pad = 6 * dpr;
  const bar = color ? 4 * dpr : 0;
  const w = Math.ceil(ctx.measureText(text).width) + pad * 2 + bar;
  const h = Math.round(LABEL_PX * dpr);
  canvas.width = w;
  canvas.height = h;
  ctx.fillStyle = 'rgba(24,24,24,0.92)';
  ctx.beginPath();
  ctx.roundRect(0, 0, w, h, 4 * dpr);
  ctx.fill();
  if (color) {
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, bar, h);
  }
  ctx.font = font;
  ctx.fillStyle = color ? '#f2f2f2' : '#b0b0b0';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, bar + pad, h / 2 + dpr);
  return spriteFromCanvas(canvas, LABEL_PX);
}

function relativeTime(ms) {
  const s = (Date.now() - ms) / 1000;
  const units = [[31536000, 'year'], [2592000, 'month'], [86400, 'day'], [3600, 'hour'], [60, 'minute']];
  for (const [sec, name] of units) {
    if (s >= sec) {
      const v = Math.floor(s / sec);
      return `${v} ${name}${v === 1 ? '' : 's'} ago`;
    }
  }
  return 'just now';
}

// One row of commit info (subject, author, age, hash), drawn next to the node like a git log row.
function makeDetailSprite(c) {
  const dpr = Math.max(2, window.devicePixelRatio);
  const fontPx = 12 * dpr;
  const ui = `${fontPx}px Segoe UI, sans-serif`;
  const subject = c.subject.length > 90 ? c.subject.slice(0, 89) + '\u2026' : c.subject;
  const parts = [
    [subject, '#e8e8e8', `500 ${ui}`],
    [c.author, '#a8a8a8', ui],
    [relativeTime(c.date), '#8c8c8c', ui],
    [c.hash.slice(0, 7), '#7c7c7c', `${fontPx}px Consolas, monospace`]
  ];
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const pad = 6 * dpr;
  const gap = 14 * dpr;
  const widths = parts.map(([t, , f]) => {
    ctx.font = f;
    return ctx.measureText(t).width;
  });
  canvas.width = Math.ceil(widths.reduce((a, b) => a + b, 0) + gap * (parts.length - 1) + pad * 2);
  canvas.height = Math.round(DETAIL_PX * dpr);
  ctx.fillStyle = 'rgba(22,22,22,0.88)';
  ctx.beginPath();
  ctx.roundRect(0, 0, canvas.width, canvas.height, 3 * dpr);
  ctx.fill();
  ctx.textBaseline = 'middle';
  let x = pad;
  parts.forEach(([t, color, f], k) => {
    ctx.font = f;
    ctx.fillStyle = color;
    ctx.fillText(t, x, canvas.height / 2 + dpr);
    x += widths[k] + gap;
  });
  return spriteFromCanvas(canvas, DETAIL_PX);
}

function spriteFromCanvas(canvas, px) {
  const w = canvas.width;
  const h = canvas.height;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  // Constant on-screen size regardless of zoom.
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, sizeAttenuation: false, fog: false });
  const sprite = new THREE.Sprite(mat);
  sprite.userData.aspect = w / h;
  sprite.userData.px = px;
  sprite.renderOrder = 10;
  sizeLabel(sprite);
  return sprite;
}

function sizeLabel(sprite) {
  // Non-attenuated sprite scale is in view units at distance 1.
  const unitsPerPx = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / window.innerHeight;
  const h = (sprite.userData.px ?? LABEL_PX) * unitsPerPx;
  sprite.scale.set(h * sprite.userData.aspect, h, 1);
}

// Like `git name-rev`: each commit takes the name of the first branch whose first-parent chain reaches it.
// Priority: checked-out branch, then local branches, then remotes (newest tip first).
function computeBranchOf(commits, byHash) {
  const branchOf = new Array(commits.length);
  const tips = [];
  commits.forEach((c, i) => {
    const isHead = c.refs.some(r => r.type === 'head');
    for (const r of c.refs) {
      if (r.type === 'branch') tips.push({ i, name: r.name, rank: isHead ? 0 : 1 });
      else if (r.type === 'remote') tips.push({ i, name: r.name, rank: 2 });
    }
  });
  tips.sort((a, b) => a.rank - b.rank || a.i - b.i);
  for (const t of tips) {
    for (let k = t.i; k !== undefined && branchOf[k] === undefined; k = byHash.get(commits[k].parents[0])) {
      branchOf[k] = t.name;
    }
  }
  return branchOf;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const TICK_GAP_PX = 110;

// A tick in each day gap, labelled with the newer day and sitting just above the gap.
// level: 0 = year, 1 = month, 2 = day (lower wins when space is tight).
function buildTimeTicks(commits, ts) {
  const ticks = [];
  for (let i = 0; i < commits.length; i++) {
    const d = new Date(commits[i].cdate ?? commits[i].date);
    const last = i === commits.length - 1;
    const next = last ? null : new Date(commits[i + 1].cdate ?? commits[i + 1].date);
    let level;
    if (!next || next.getFullYear() !== d.getFullYear()) level = 0;
    else if (next.getMonth() !== d.getMonth()) level = 1;
    else if (next.getDate() !== d.getDate()) level = 2;
    else continue;
    const text = level === 2 ? `${d.getDate()} ${MONTHS[d.getMonth()]}` : `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
    const y = last ? ts[i] - X_SPACING / 2 : (ts[i] + ts[i + 1]) / 2;
    ticks.push({ y, level, text, sprite: null });
  }
  return ticks;
}

const shownTickY = [];
function updateTimeTicks() {
  const unitsPerPx = (2 * camera.position.distanceTo(controls.target) * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / window.innerHeight;
  const gap = TICK_GAP_PX * unitsPerPx;
  const range = settings.renderDistance;
  const cy = controls.target.y;
  shownTickY.length = 0;
  for (const t of state.timeTicks) t.show = false;
  for (let level = 0; level <= 2; level++) {
    for (const t of state.timeTicks) {
      if (t.level !== level) continue;
      const y = t.y;
      if (Math.abs(y - cy) > range) continue;
      if (shownTickY.some(sy => Math.abs(sy - y) < gap)) continue;
      shownTickY.push(y);
      t.show = true;
    }
  }
  for (const t of state.timeTicks) {
    if (t.show && !t.sprite) {
      t.sprite = makeLabelSprite(t.text, null);
      // Opaque + low renderOrder so it's drawn before nodes/edges, which then paint over it.
      Object.assign(t.sprite.material, { transparent: false, alphaTest: 0.5, depthWrite: false });
      t.sprite.renderOrder = -1;
      t.sprite.center.set(1 + 8 / (LABEL_PX * t.sprite.userData.aspect), -0.1);
      t.sprite.position.set(timeAxisX, t.y, floor.position.z);
      graphGroup.add(t.sprite);
    }
    if (t.sprite) t.sprite.visible = t.show;
  }
}

function clearGraph() {
  graphGroup.traverse(o => {
    if (o.geometry && !SHARED.has(o.geometry)) o.geometry.dispose();
    if (o.material) {
      if (o.material.map && !SHARED.has(o.material.map)) o.material.map.dispose();
      o.material.dispose();
    }
  });
  graphGroup.clear();
}

function buildGraph(graph) {
  if (state && settings.organic) state.graph.commits.forEach((c, i) => simPositions.set(c.hash, state.positions[i].clone()));
  clearGraph();
  simVel = null;
  const { commits } = graph;
  const n = commits.length;
  const laneOf = assignLanes(commits);
  const byHash = new Map(commits.map((c, i) => [c.hash, i]));
  const anchors = laneOf.map(lanePosition);
  const ts = commitTimes(commits);
  const positions = commits.map((c, i) => {
    const moved = movedPositions.get(c.hash);
    if (moved) return moved.clone();
    const sim = settings.organic && simPositions.get(c.hash);
    const [x, z] = sim ? [sim.x, sim.z] : anchors[i];
    return new THREE.Vector3(x, ts[i], z); // newest at y=0, older history extends downward
  });
  const sizes = Float32Array.from(commits, commitSize);

  // commits
  const commitMesh = new THREE.InstancedMesh(sphereGeo, new THREE.MeshBasicMaterial(), Math.max(n, 1));
  commitMesh.count = n;
  graphGroup.add(commitMesh);

  // edges: fixed segment count per edge so they can be rewritten in place when nodes move
  const edges = [];
  const nodeEdges = commits.map(() => []);
  commits.forEach((c, i) => {
    c.parents.forEach((ph, pi) => {
      const j = byHash.get(ph);
      if (j === undefined) return;
      nodeEdges[i].push(edges.length);
      nodeEdges[j].push(edges.length);
      edges.push({ i, j, pi });
    });
  });
  const vertsPerEdge = EDGE_SEGMENTS * 2;
  const edgePos = new Float32Array(edges.length * vertsPerEdge * 3);
  const edgeCol = new Float32Array(edges.length * vertsPerEdge * 3);
  const edgeGeo = new THREE.BufferGeometry();
  edgeGeo.setAttribute('position', new THREE.BufferAttribute(edgePos, 3));
  edgeGeo.setAttribute('color', new THREE.BufferAttribute(edgeCol, 3));
  const edgeLines = new THREE.LineSegments(edgeGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.75 }));
  edgeLines.frustumCulled = false;
  graphGroup.add(edgeLines);

  // merge edges as tubes (one batched mesh), thicker the more commits the merged lane brought in
  const tubes = [];
  const tubeOfEdge = new Map();
  edges.forEach((e, k) => {
    if (e.pi === 0) return;
    let size = 0;
    for (let cur = e.j; cur !== undefined && laneOf[cur] === laneOf[e.j]; cur = byHash.get(commits[cur].parents[0])) size++;
    tubeOfEdge.set(k, tubes.length);
    tubes.push({ k, radius: Math.min(0.03 + 0.035 * Math.sqrt(size), 0.35) });
  });
  const tubeGeo = new THREE.BufferGeometry();
  tubeGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(tubes.length * TUBE_VERTS * 3), 3));
  tubeGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(tubes.length * TUBE_VERTS * 3), 3));
  const tubeIdx = new Uint32Array(tubes.length * TUBE_SEGS * TUBE_RADIAL * 6);
  let ti = 0;
  for (let t = 0; t < tubes.length; t++) {
    const base = t * TUBE_VERTS;
    for (let s = 0; s < TUBE_SEGS; s++) {
      for (let r = 0; r < TUBE_RADIAL; r++) {
        const a = base + s * TUBE_RADIAL + r;
        const b = base + s * TUBE_RADIAL + ((r + 1) % TUBE_RADIAL);
        tubeIdx.set([a, a + TUBE_RADIAL, b, b, a + TUBE_RADIAL, b + TUBE_RADIAL], ti);
        ti += 6;
      }
    }
  }
  tubeGeo.setIndex(new THREE.BufferAttribute(tubeIdx, 1));
  const tubeMesh = new THREE.Mesh(tubeGeo, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide }));
  tubeMesh.frustumCulled = false;
  graphGroup.add(tubeMesh);

  // ref labels
  const REF_RANK = { branch: 1, remote: 2, tag: 3, head: 4 };
  const LABEL_RANK = { head: 0, branch: 1, tag: 2, remote: 3 };
  const sprites = [];
  const nodeSprites = commits.map(() => []);
  commits.forEach((c, i) => {
    let refs = c.refs;
    let more = 0;
    if (settings.groupRefLabels && refs.length > 1) {
      const rank = r => (r.type === 'branch' && r.name === graph.currentBranch ? 0 : REF_RANK[r.type] ?? 5);
      refs = [refs.reduce((best, r) => (rank(r) < rank(best) ? r : best))];
      more = c.refs.length - 1;
    }
    refs.forEach((ref, k) => {
      const isCurrent = ref.type === 'branch' && ref.name === graph.currentBranch;
      let text = isCurrent ? `\u25CF ${ref.name}` : ref.name;
      if (more) text += `  +${more}`;
      const sprite = makeLabelSprite(text, REF_COLORS[ref.type]);
      sprite.position.copy(positions[i]);
      sprite.center.set(-8 / (LABEL_PX * sprite.userData.aspect), 0.5 + k * 1.2); // right of the node, stacked downward
      sprite.userData.commitIndex = i;
      sprite.userData.ref = ref;
      sprite.userData.rank = isCurrent ? 0 : LABEL_RANK[ref.type] ?? 4;
      if (more) sprite.userData.more = c.refs.filter(r => r !== ref);
      graphGroup.add(sprite);
      sprites.push(sprite);
      nodeSprites[i].push(sprite);
    });
  });

  // HEAD ring
  const headIdx = commits.findIndex(c => c.refs.some(r => r.type === 'head'));
  let headRing = null;
  if (headIdx >= 0) {
    headRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.45, 0.05, 8, 32),
      new THREE.MeshBasicMaterial({ color: 0xffffff })
    );
    headRing.position.copy(positions[headIdx]);
    headRing.rotation.x = Math.PI / 2;
    graphGroup.add(headRing);
  }

  // glow on HEAD and the most recent commits
  const nodeHalo = new Array(n).fill(null);
  const addHalo = (i, strength) => {
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: haloTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: strength
    }));
    graphGroup.add(halo);
    halo.userData.strength = strength;
    nodeHalo[i] = halo;
    return halo;
  };
  commits.map((_, i) => i)
    .sort((a, b) => commits[b].date - commits[a].date)
    .slice(0, GLOW_COUNT)
    .forEach((i, rank) => addHalo(i, 0.8 - (0.6 * rank) / GLOW_COUNT));
  if (headIdx >= 0) {
    const halo = nodeHalo[headIdx] ?? addHalo(headIdx, 1);
    halo.material.opacity = halo.userData.strength = 1;
    halo.userData.head = true;
  }

  // level of detail: long linear runs collapse into a tube when far from the camera
  const childCount = new Int32Array(n);
  edges.forEach(e => childCount[e.j]++);
  const firstParent = commits.map(c => byHash.get(c.parents[0]) ?? -1);
  const linear = i => commits[i].parents.length === 1 && firstParent[i] >= 0 && childCount[i] === 1 && !commits[i].refs.length;
  const seen = new Uint8Array(n);
  const chains = [];
  for (let i = 0; i < n; i++) {
    if (seen[i] || !linear(i)) continue;
    const nodes = [i];
    for (let p = firstParent[i]; p >= 0 && !seen[p] && linear(p) && laneOf[p] === laneOf[i]; p = firstParent[p]) nodes.push(p);
    nodes.forEach(k => { seen[k] = 1; });
    if (nodes.length >= LOD_MIN_CHAIN) chains.push({ nodes, label: null, collapsed: false });
  }
  const chainMesh = new THREE.InstancedMesh(cylGeo, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.8 }), Math.max(chains.length, 1));
  chainMesh.count = chains.length;
  chainMesh.frustumCulled = false;
  tmpMatrix.makeScale(0, 0, 0);
  for (let c = 0; c < chains.length; c++) chainMesh.setMatrixAt(c, tmpMatrix);
  graphGroup.add(chainMesh);

  timeAxisX = Math.min(0, ...anchors.map(a => a[0])) - 6;
  floor.position.z = Math.min(0, ...anchors.map(a => a[1])) - 6;

  // selection marker
  const selMarker = new THREE.Mesh(
    new THREE.SphereGeometry(0.42, 20, 14),
    new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true })
  );
  selMarker.visible = false;
  graphGroup.add(selMarker);

  state = {
    graph, positions, sizes, anchors, hidden: new Uint8Array(n), commitMesh, sprites, nodeSprites, byHash, laneOf,
    details: new Array(n).fill(null), detailCount: 0,
    headIdx, headRing, selMarker, edges, nodeEdges, edgeGeo, tubes, tubeOfEdge, tubeGeo, nodeHalo, chains, chainMesh, nodeColors: [],
    timeTicks: buildTimeTicks(commits, ts),
    branchOf: computeBranchOf(commits, byHash)
  };
  for (let i = 0; i < n; i++) syncNode(i);
  edges.forEach((_, k) => writeEdge(k));
  tubes.forEach((_, t) => writeTube(t));
  applyColors();
  markMoved();
  if (settings.organic) startSim(simPositions.size ? 0.3 : 1);
}

const bezier = new THREE.QuadraticBezierCurve3();
const tmpPt = new THREE.Vector3();

function commitSize(c) {
  return THREE.MathUtils.clamp(1 + 0.45 * Math.log10(1 + (c.changes || 0)), 1, 3);
}

function edgeCurve(k, curve) {
  const { i, j, pi } = state.edges[k];
  const a = state.positions[i];
  const b = state.positions[j];
  // First parent: stay in own lane then bend into parent. Merge parent: leave immediately.
  curve.v0.copy(a);
  curve.v2.copy(b);
  if (pi === 0) curve.v1.set(a.x, b.y, a.z);
  else curve.v1.set(b.x, a.y, b.z);
  return curve;
}

const tan = new THREE.Vector3();
const n1 = new THREE.Vector3();
const n2 = new THREE.Vector3();
const X_AXIS = new THREE.Vector3(1, 0, 0);

function writeTube(t) {
  const { k, radius } = state.tubes[t];
  const { v0, v1, v2 } = edgeCurve(k, bezier);
  const arr = state.tubeGeo.attributes.position.array;
  let o = t * TUBE_VERTS * 3;
  for (let s = 0; s <= TUBE_SEGS; s++) {
    const u = s / TUBE_SEGS;
    bezier.getPoint(u, tmpPt);
    // analytic quadratic bezier derivative avoids Curve.getTangent's allocations
    tan.subVectors(v1, v0).multiplyScalar(1 - u).addScaledVector(n1.subVectors(v2, v1), u);
    if (tan.lengthSq() < 1e-8) tan.copy(X_AXIS);
    tan.normalize();
    n1.crossVectors(tan, Math.abs(tan.y) < 0.9 ? UP : X_AXIS).normalize();
    n2.crossVectors(tan, n1);
    for (let r = 0; r < TUBE_RADIAL; r++) {
      const ang = (r / TUBE_RADIAL) * Math.PI * 2;
      const c = Math.cos(ang) * radius;
      const sn = Math.sin(ang) * radius;
      arr[o++] = tmpPt.x + n1.x * c + n2.x * sn;
      arr[o++] = tmpPt.y + n1.y * c + n2.y * sn;
      arr[o++] = tmpPt.z + n1.z * c + n2.z * sn;
    }
  }
}

function writeEdge(k) {
  edgeCurve(k, bezier);
  const a = bezier.v0;
  const b = bezier.v2;
  const arr = state.edgeGeo.attributes.position.array;
  let o = k * EDGE_SEGMENTS * 2 * 3;
  a.toArray(arr, o);
  for (let s = 1; s < EDGE_SEGMENTS; s++) {
    bezier.getPoint(s / EDGE_SEGMENTS, tmpPt);
    tmpPt.toArray(arr, o + 3);
    tmpPt.toArray(arr, o + 6);
    o += 6;
  }
  b.toArray(arr, o + 3);
}

function nodeScale(i) {
  if (state.hidden[i]) return 1e-4;
  return settings.sizeByChanges ? state.sizes[i] : 1;
}

function syncNode(i) {
  const p = state.positions[i];
  const s = nodeScale(i);
  tmpMatrix.makeScale(s, s, s).setPosition(p);
  state.commitMesh.setMatrixAt(i, tmpMatrix);
  state.nodeSprites[i].forEach(sp => sp.position.copy(p));
  state.details[i]?.position.copy(p);
  const halo = state.nodeHalo[i];
  if (halo) {
    halo.position.copy(p);
    halo.scale.setScalar((halo.userData.head ? 1.8 : 1.2) * s);
    halo.visible = !state.hidden[i];
  }
  if (i === state.headIdx) {
    state.headRing.position.copy(p);
    state.headRing.scale.setScalar(s);
  }
  if (state.graph.commits[i].hash === selectedHash) {
    state.selMarker.position.copy(p);
    state.selMarker.userData.base = s;
  }
}

function markMoved() {
  state.commitMesh.instanceMatrix.needsUpdate = true;
  state.edgeGeo.attributes.position.needsUpdate = true;
  state.tubeGeo.attributes.position.needsUpdate = true;
  boundsDirty = true;
  chainsDirty = true;
  invalidate();
}

function placeNode(index, pos) {
  const p = state.positions[index].copy(pos);
  movedPositions.set(state.graph.commits[index].hash, p);
  syncNode(index);
}

const tmpVec = new THREE.Vector3();

function dragNodes(delta) {
  for (const a of drag.affected) placeNode(a.i, tmpVec.copy(a.start).addScaledVector(delta, a.w));
  drag.edges.forEach(k => {
    writeEdge(k);
    const t = state.tubeOfEdge.get(k);
    if (t !== undefined) writeTube(t);
  });
  markMoved();
}

function startDrag(index, plane, offset) {
  const origin = state.positions[index];
  const maxD = DRAG_FALLOFF * 2.5;
  const affected = [];
  const edges = new Set();
  const lane = state.laneOf[index];
  state.positions.forEach((p, i) => {
    if (state.laneOf[i] !== lane) return;
    const d = p.distanceTo(origin);
    if (d > maxD) return;
    affected.push({ i, start: p.clone(), w: Math.exp(-((d / DRAG_FALLOFF) ** 2)) });
    state.nodeEdges[i].forEach(k => edges.add(k));
  });
  drag = { index, plane, offset, start: origin.clone(), affected, pinned: new Set(affected.map(a => a.i)), edges };
}

// --- level of detail ---
const tmpQuat = new THREE.Quaternion();
const tmpScale = new THREE.Vector3();

function placeChain(c) {
  const ch = state.chains[c];
  if (!ch.collapsed) {
    state.chainMesh.setMatrixAt(c, tmpMatrix.makeScale(0, 0, 0));
    return;
  }
  const a = state.positions[ch.nodes[0]];
  const b = state.positions[ch.nodes[ch.nodes.length - 1]];
  tmpPt.subVectors(b, a);
  const len = tmpPt.length();
  tmpQuat.setFromUnitVectors(UP, tmpPt.normalize());
  tmpVec.addVectors(a, b).multiplyScalar(0.5);
  tmpMatrix.compose(tmpVec, tmpQuat, tmpScale.set(CHAIN_RADIUS, len + 0.6, CHAIN_RADIUS));
  state.chainMesh.setMatrixAt(c, tmpMatrix);
  if (!ch.label) {
    ch.label = makeLabelSprite(`${ch.nodes.length} commits`, '#888888');
    ch.label.center.set(-0.15, 0.5);
    graphGroup.add(ch.label);
  }
  ch.label.position.copy(tmpVec);
}

function updateLod() {
  const lodDistance = settings.renderDistance * 0.35;
  let changed = false;
  let chainsMoved = false;
  state.chains.forEach((ch, c) => {
    const mid = state.positions[ch.nodes[ch.nodes.length >> 1]];
    const collapse = settings.collapse && mid.distanceTo(camera.position) > lodDistance;
    const flipped = collapse !== ch.collapsed;
    if (flipped) {
      ch.collapsed = collapse;
      for (const i of ch.nodes) {
        state.hidden[i] = collapse ? 1 : 0;
        syncNode(i);
      }
      if (ch.label) ch.label.visible = collapse;
      changed = true;
    }
    if (flipped || (collapse && chainsDirty)) {
      placeChain(c);
      chainsMoved = true;
    }
  });
  chainsDirty = false;
  if (chainsMoved) state.chainMesh.instanceMatrix.needsUpdate = true;
  if (changed) {
    state.commitMesh.instanceMatrix.needsUpdate = true;
    boundsDirty = true;
  }
}

function maybeLoadMore() {
  if (!state.graph.hasMore || loadingMore) return;
  let oldestY = 0;
  for (const p of state.positions) if (p.y < oldestY) oldestY = p.y;
  if (Math.min(camera.position.y, controls.target.y) < oldestY + LOAD_MORE_MARGIN) {
    loadingMore = true;
    document.getElementById('repoName').textContent += '  \u00B7  loading older history...';
    vscode.postMessage({ type: 'loadMore' });
  }
}

// --- organic layout: force simulation on X/Z only, Y stays time ---
function startSim(alpha) {
  if (!settings.organic || !state) return;
  simAlpha = Math.max(simAlpha, alpha);
  invalidate();
}

function simTick() {
  const { positions, edges, laneOf, anchors, graph } = state;
  const n = positions.length;
  if (!simVel || simVel.length !== n * 2) simVel = new Float32Array(n * 2);
  const f = new Float32Array(n * 2);
  for (const e of edges) {
    const a = positions[e.i];
    const b = positions[e.j];
    const k = laneOf[e.i] === laneOf[e.j] ? 0.08 : 0.02;
    const dy = (b.x - a.x) * k;
    const dz = (b.z - a.z) * k;
    f[e.i * 2] += dy; f[e.i * 2 + 1] += dz;
    f[e.j * 2] -= dy; f[e.j * 2 + 1] -= dz;
  }
  for (let i = 0; i < n; i++) {
    const a = positions[i];
    const end = Math.min(n, i + SIM_WINDOW);
    for (let j = i + 1; j < end; j++) {
      if (laneOf[i] === laneOf[j]) continue;
      const b = positions[j];
      const dx = a.y - b.y; // time distance
      let dy = a.x - b.x;
      let dz = a.z - b.z;
      let yz = Math.hypot(dy, dz);
      if (yz < 1e-3) { dy = Math.random() - 0.5; dz = Math.random() - 0.5; yz = Math.hypot(dy, dz); }
      const s = (SIM_REPULSION * (settings.branchSpacing / 2.2) ** 2) / (dx * dx + yz * yz + 0.1) / yz;
      f[i * 2] += dy * s; f[i * 2 + 1] += dz * s;
      f[j * 2] -= dy * s; f[j * 2 + 1] -= dz * s;
    }
    f[i * 2] += (anchors[i][0] - a.x) * 0.01;
    f[i * 2 + 1] += (anchors[i][1] - a.z) * 0.01;
  }
  for (let i = 0; i < n; i++) {
    if (movedPositions.has(graph.commits[i].hash) || drag?.pinned.has(i)) continue;
    const vy = THREE.MathUtils.clamp((simVel[i * 2] + f[i * 2] * simAlpha) * 0.6, -0.5, 0.5);
    const vz = THREE.MathUtils.clamp((simVel[i * 2 + 1] + f[i * 2 + 1] * simAlpha) * 0.6, -0.5, 0.5);
    simVel[i * 2] = vy;
    simVel[i * 2 + 1] = vz;
    positions[i].x += vy;
    positions[i].z += vz;
    syncNode(i);
  }
  edges.forEach((_, k) => writeEdge(k));
  state.tubes.forEach((_, t) => writeTube(t));
  markMoved();
  simAlpha *= 0.985;
  if (simAlpha < 0.005) simAlpha = 0;
}

// --- colour modes ---
function categoryColor(rank) {
  return rank < LANE_COLORS.length ? new THREE.Color(LANE_COLORS[rank]) : new THREE.Color().setHSL((rank * 0.618034) % 1, 0.6, 0.6);
}

function categorical(keys) {
  const counts = new Map();
  keys.forEach(k => k != null && counts.set(k, (counts.get(k) || 0) + 1));
  const ranked = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a));
  const colorOf = new Map(ranked.map((k, r) => [k, categoryColor(r)]));
  return {
    colors: keys.map(k => (k == null ? NO_DATA_COLOR : colorOf.get(k))),
    legend: ranked.map(k => ({ label: `${k} (${counts.get(k)})`, color: colorOf.get(k) }))
  };
}

function applyColors() {
  const { commits } = state.graph;
  let colors;
  let legend = null;
  switch (settings.colorMode) {
    case 'author':
      ({ colors, legend } = categorical(commits.map(c => c.author)));
      break;
    case 'folder':
      ({ colors, legend } = categorical(commits.map(c => c.folder ?? null)));
      break;
    case 'age': {
      const dates = commits.map(c => c.date);
      const min = Math.min(...dates);
      const max = Math.max(...dates);
      const ageColor = t => new THREE.Color().setHSL(0.66 * (1 - t), 0.85, 0.35 + 0.2 * t);
      colors = dates.map(d => ageColor((d - min) / (max - min || 1)));
      legend = [
        { label: `Oldest  ${new Date(min).toLocaleDateString()}`, color: ageColor(0) },
        { label: `Newest  ${new Date(max).toLocaleDateString()}`, color: ageColor(1) }
      ];
      break;
    }
    default:
      colors = state.laneOf.map(l => new THREE.Color(LANE_COLORS[l % LANE_COLORS.length]));
  }
  state.nodeColors = colors;
  const faded = computeFaded();
  state.faded = faded;
  const bg = new THREE.Color(BG_COLOR);
  const shown = colors.map((c, i) => (faded[i] ? c.clone().lerp(bg, FADE_AMOUNT) : c));
  const edgeColor = e => {
    const c = colors[e.pi === 0 ? e.i : e.j];
    return faded[e.i] || faded[e.j] ? tmpColor.copy(c).lerp(bg, FADE_AMOUNT) : c;
  };

  shown.forEach((c, i) => state.commitMesh.setColorAt(i, c));
  if (state.commitMesh.instanceColor) state.commitMesh.instanceColor.needsUpdate = true;

  const col = state.edgeGeo.attributes.color;
  const vertsPerEdge = EDGE_SEGMENTS * 2;
  state.edges.forEach((e, k) => {
    const c = edgeColor(e);
    for (let v = 0; v < vertsPerEdge; v++) c.toArray(col.array, (k * vertsPerEdge + v) * 3);
  });
  col.needsUpdate = true;

  const tubeCol = state.tubeGeo.attributes.color;
  state.tubes.forEach((t, ti) => {
    const e = state.edges[t.k];
    const c = faded[e.i] || faded[e.j] ? tmpColor.copy(colors[e.j]).lerp(bg, FADE_AMOUNT) : colors[e.j];
    for (let v = 0; v < TUBE_VERTS; v++) c.toArray(tubeCol.array, (ti * TUBE_VERTS + v) * 3);
  });
  tubeCol.needsUpdate = true;
  state.chains.forEach((ch, c) => state.chainMesh.setColorAt(c, shown[ch.nodes[0]]));
  if (state.chainMesh.instanceColor) state.chainMesh.instanceColor.needsUpdate = true;
  state.nodeHalo.forEach((h, i) => {
    if (!h) return;
    h.material.color.copy(h.userData.head ? tmpColor.setHex(0xffffff) : colors[i]);
    h.material.opacity = (h.userData.strength ?? 1) * (faded[i] ? 0.1 : 1);
  });
  renderLegend(legend);
  renderPins();
  invalidate();
}

// --- filtering & pinning ---
const FADE_AMOUNT = 0.85;
let pinsByRoot = {}; // root -> [branch name]
let pins = new Set(); // pinned branch names for the loaded repo
let fadeUnpinned = true;
const filters = []; // [{ type: 'branch' | 'author', value }]

function loadPins(root) {
  pins = new Set(pinsByRoot[root] || []);
}

function savePins() {
  pinsByRoot[loadedRoot] = [...pins];
  persist();
}

function togglePin(name) {
  if (!name) return;
  if (pins.has(name)) pins.delete(name);
  else pins.add(name);
  savePins();
  applyColors();
  renderSide();
}

// branch / remote name -> tip commit index
function branchTips() {
  if (state.tips) return state.tips;
  state.tips = new Map();
  state.graph.commits.forEach((c, i) => {
    for (const r of c.refs) if (r.type === 'branch' || r.type === 'remote') state.tips.set(r.name, { i, type: r.type });
  });
  return state.tips;
}

// First-parent chain from the tip, stopping where it joins HEAD's first-parent chain (the fork point).
function branchMembers(name) {
  state.members ??= new Map();
  if (state.members.has(name)) return state.members.get(name);
  const { commits } = state.graph;
  if (!state.trunk) {
    state.trunk = new Uint8Array(commits.length);
    for (let k = state.headIdx >= 0 ? state.headIdx : undefined; k !== undefined && !state.trunk[k]; k = state.byHash.get(commits[k].parents[0])) state.trunk[k] = 1;
  }
  const tip = branchTips().get(name);
  let set = null;
  if (tip) {
    set = new Uint8Array(commits.length);
    const onTrunk = state.trunk[tip.i];
    for (let k = tip.i; k !== undefined && !set[k]; k = state.byHash.get(commits[k].parents[0])) {
      if (!onTrunk && state.trunk[k]) break;
      set[k] = 1;
    }
  }
  state.members.set(name, set);
  return set;
}

function computeFaded() {
  const { commits } = state.graph;
  const n = commits.length;
  const faded = new Uint8Array(n);
  const branchSets = filters.filter(f => f.type === 'branch').map(f => branchMembers(f.value)).filter(Boolean);
  const branchFiltered = filters.some(f => f.type === 'branch');
  const authors = new Set(filters.filter(f => f.type === 'author').map(f => f.value));
  const pinSets = [...pins].map(branchMembers).filter(Boolean);
  const isolate = fadeUnpinned && pins.size > 0;
  let matches = 0;
  for (let i = 0; i < n; i++) {
    const pass = (!branchFiltered || branchSets.some(s => s[i])) && (!authors.size || authors.has(commits[i].author));
    if (pass) matches++;
    const pinned = pinSets.some(s => s[i]);
    faded[i] = !pinned && (!pass || isolate) ? 1 : 0;
  }
  filterCountEl.textContent = filters.length ? `${matches} / ${n}` : '';
  return faded;
}

const pinsEl = document.getElementById('pins');
const filterEl = document.getElementById('filter');
const filterChipsEl = document.getElementById('filterChips');
const filterCountEl = document.getElementById('filterCount');
const filterInput = document.getElementById('filterInput');
const filterResults = document.getElementById('filterResults');

function renderPins() {
  pinsEl.replaceChildren();
  pinsEl.classList.toggle('hidden', pins.size === 0);
  if (!pins.size) return;
  const head = el('div', 'pins-head');
  head.title = 'Click to collapse / expand';
  head.onclick = () => toggleCollapsed('pins');
  const clear = el('button', 'pins-clear', 'Clear');
  clear.title = 'Unpin all';
  clear.onclick = ev => {
    ev.stopPropagation();
    pins.clear();
    savePins();
    applyColors();
  };
  head.append(el('span', '', `Pinned Branches (${pins.size})`), clear);
  const fade = el('label', 'check');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = fadeUnpinned;
  box.onchange = () => {
    fadeUnpinned = box.checked;
    persist();
    applyColors();
  };
  fade.append(box, ' Fade others');
  const list = el('div', 'pins-list');
  const tips = branchTips();
  for (const name of pins) {
    const tip = tips.get(name);
    const item = el('div', 'pin-item' + (tip ? '' : ' missing'));
    const dot = el('span', 'search-dot');
    if (tip) dot.style.background = '#' + state.nodeColors[tip.i].getHexString();
    const unpin = el('button', 'pin-remove', '\u00D7');
    unpin.title = 'Unpin';
    unpin.onclick = ev => {
      ev.stopPropagation();
      togglePin(name);
    };
    item.append(dot, el('span', 'pin-subject', name), el('span', 'pin-hash', tip ? tip.type : ''), unpin);
    item.title = tip ? name : 'Not in the loaded history';
    if (tip) item.onclick = () => goToRef(tip.i);
    list.append(item);
  }
  pinsEl.append(head, fade, list);
}

function addFilter(f) {
  if (!filters.some(x => x.type === f.type && x.value === f.value)) filters.push(f);
  filterInput.value = '';
  renderFilters();
}

function renderFilters() {
  filterChipsEl.replaceChildren();
  filters.forEach((f, k) => {
    const chip = el('span', 'filter-chip ' + f.type);
    const x = el('button', 'filter-chip-x', '\u00D7');
    x.title = 'Remove filter';
    x.onclick = () => {
      filters.splice(k, 1);
      renderFilters();
    };
    chip.append(el('span', 'filter-chip-type', f.type === 'author' ? '\u263A' : '\u2387'), el('span', '', f.value), x);
    chip.title = `${f.type}: ${f.value}`;
    filterChipsEl.append(chip);
  });
  renderFilterResults();
  persist();
  if (state) applyColors();
}

function renderFilterResults() {
  filterResults.replaceChildren();
  const q = filterInput.value.trim().toLowerCase();
  if (!state || !q || document.activeElement !== filterInput) {
    filterResults.classList.add('hidden');
    return;
  }
  const active = new Set(filters.map(f => `${f.type}\u0000${f.value}`));
  const items = [];
  for (const [name, tip] of branchTips()) {
    if (name.toLowerCase().includes(q) && !active.has(`branch\u0000${name}`)) items.push({ type: 'branch', value: name, label: tip.type, color: REF_COLORS[tip.type] });
  }
  const authors = new Map();
  for (const c of state.graph.commits) {
    if (!authors.has(c.author) && (c.author.toLowerCase().includes(q) || c.email.toLowerCase().includes(q))) authors.set(c.author, c.email);
  }
  for (const [name, email] of authors) {
    if (!active.has(`author\u0000${name}`)) items.push({ type: 'author', value: name, label: email, color: '#9a9a9a' });
  }
  items.sort((a, b) => a.value.localeCompare(b.value));
  for (const it of items.slice(0, 50)) {
    const row = el('div', 'search-item');
    const dot = el('span', 'search-dot');
    dot.style.background = it.color;
    row.append(dot, el('span', '', it.value), el('span', 'search-type', it.type === 'author' ? `author \u00B7 ${it.label}` : it.label));
    row.addEventListener('pointerdown', e => {
      e.preventDefault();
      addFilter({ type: it.type, value: it.value });
    });
    filterResults.append(row);
  }
  if (!items.length) filterResults.append(el('div', 'search-empty', 'No matching branches or authors'));
  filterResults.classList.remove('hidden');
}

filterInput.addEventListener('input', renderFilterResults);
filterInput.addEventListener('focus', renderFilterResults);
filterInput.addEventListener('blur', () => filterResults.classList.add('hidden'));
filterInput.addEventListener('keydown', e => {
  e.stopPropagation();
  if (e.key === 'Escape') filterInput.blur();
  else if (e.key === 'Enter') filterResults.querySelector('.search-item')?.dispatchEvent(new Event('pointerdown'));
  else if (e.key === 'Backspace' && !filterInput.value && filters.length) {
    filters.pop();
    renderFilters();
  }
});
filterEl.addEventListener('pointerdown', e => {
  if (e.target === filterEl || e.target === filterChipsEl) {
    e.preventDefault();
    filterInput.focus();
  }
});

const legendEl = document.getElementById('legend');

function renderLegend(entries) {
  legendEl.replaceChildren();
  legendEl.classList.toggle('hidden', !entries);
  if (!entries) return;
  const titles = { author: 'Authors', folder: 'Top-level folders', age: 'Commit age' };
  legendEl.append(el('div', 'legend-title', titles[settings.colorMode]));
  const MAX = 10;
  entries.slice(0, MAX).forEach(({ label, color }) => {
    const item = el('div', 'legend-item');
    const dot = el('span', 'search-dot');
    dot.style.background = '#' + color.getHexString();
    item.append(dot, el('span', '', label));
    legendEl.append(item);
  });
  if (entries.length > MAX) legendEl.append(el('div', 'legend-more', `+${entries.length - MAX} more`));
}

// --- camera ---
function focusOn(pos, keepOffset) {
  const offset = keepOffset ? camera.position.clone().sub(controls.target)
    : settings.layout === 'map' ? MAP_VIEW.clone() : new THREE.Vector3(-4, 4, 16);
  controls.target.copy(pos);
  camera.position.copy(pos).add(offset);
  controls.update();
  invalidate();
}

function resetView() {
  if (!state || !state.positions.length) return;
  const idx = state.headIdx >= 0 ? state.headIdx : 0;
  const pos = state.positions[idx].clone();
  if (settings.layout === 'map') {
    // top-down with HEAD in the upper-left, history and other branches filling the rest
    const visH = 2 * MAP_VIEW.z * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    pos.x += visH * camera.aspect * 0.24;
    pos.y -= visH * 0.15;
  }
  focusOn(pos, false);
}

// --- picking ---
function setPointer(e) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
}

function pick(e) {
  if (!state) return null;
  if (boundsDirty) {
    state.commitMesh.computeBoundingSphere();
    boundsDirty = false;
  }
  setPointer(e);
  raycaster.setFromCamera(pointer, camera);
  const spriteHits = settings.labelsDimmed ? [] : raycaster.intersectObjects([...state.sprites, ...state.details].filter(s => s?.visible), false);
  if (spriteHits.length) {
    const { commitIndex, ref, more } = spriteHits[0].object.userData;
    return { index: commitIndex, ref, more };
  }
  const hits = raycaster.intersectObject(state.commitMesh, false);
  if (hits.length) return { index: hits[0].instanceId, ref: null };
  return null;
}

// --- selection / info ---
const infoEl = document.getElementById('info');
const menuEl = document.getElementById('menu');
const tooltipEl = document.getElementById('tooltip');

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function select(index, fly) {
  invalidate();
  if (!state || index == null || index < 0) {
    selectedHash = null;
    if (state) state.selMarker.visible = false;
    renderSide();
    return;
  }
  const c = state.graph.commits[index];
  selectedHash = c.hash;
  state.selMarker.position.copy(state.positions[index]);
  state.selMarker.userData.base = nodeScale(index);
  state.selMarker.visible = true;
  if (fly) focusOn(state.positions[index], true);
  renderSide();
}

// Sidebar shows the selection, or HEAD when nothing is selected.
const actionsEl = document.getElementById('actions');
function renderSide() {
  if (!state) return;
  let i = selectedHash ? state.byHash.get(selectedHash) : undefined;
  if (i === undefined) i = state.graph.commits.findIndex(c => c.refs.some(r => r.type === 'head'));
  if (i < 0) {
    infoEl.replaceChildren(el('div', 'panel-empty', 'Nothing selected'));
    actionsEl.replaceChildren();
    return;
  }
  renderInfo(state.graph.commits[i], !selectedHash);
  renderActions(i);
}

function renderActions(index) {
  actionsEl.replaceChildren();
  const groups = commitGroups(index);
  const tagGroups = groups.filter(g => g.tag);
  const appendGroup = g => {
    const grid = el('div', 'act-grid');
    g.items.forEach(item => {
      const b = el('button', item.danger ? 'danger' : '', item.label);
      b.title = item.label;
      b.disabled = !!item.disabled;
      b.onclick = () => runItem(item, g.payload);
      grid.append(b);
    });
    actionsEl.append(el('div', 'act-title', g.title), grid);
  };
  groups.filter(g => !g.tag).forEach(appendGroup);
  if (!tagGroups.length) return;
  const head = el('div', 'act-section' + (ui.tagActionsOpen ? ' open' : ''), `Tags (${tagGroups.length})`);
  head.title = 'Show / hide tag actions';
  head.onclick = () => {
    setUi({ tagActionsOpen: !ui.tagActionsOpen });
    renderActions(index);
  };
  actionsEl.append(head);
  if (ui.tagActionsOpen) tagGroups.forEach(appendGroup);
}

function renderInfo(c, isHead) {
  infoEl.replaceChildren();
  const owner = state.branchOf[state.byHash.get(c.hash)];
  const title = el('div', 'branch-title');
  title.append(isHead ? 'HEAD on ' : 'Branch ', el('b', '', owner || state.graph.currentBranch || 'detached'));
  infoEl.append(title);
  if (!isHead) {
    const close = el('button', 'close', '\u00D7');
    close.title = 'Deselect (Esc)';
    close.onclick = () => select(null);
    infoEl.append(close);
  }
  infoEl.append(el('div', 'subject', c.subject));
  if (owner) {
    const pin = el('button', 'pin-toggle', `${pins.has(owner) ? 'Unpin' : 'Pin'} branch ${owner}`);
    pin.title = 'Pin / unpin this commit\'s branch (P)';
    pin.onclick = () => togglePin(owner);
    infoEl.append(pin);
  }

  const row = (label, value) => {
    const r = el('div', 'row');
    r.append(el('span', 'label', label), value instanceof Node ? value : el('span', 'value', value));
    infoEl.append(r);
  };
  row('Commit', c.hash);
  row('Author', `${c.author} <${c.email}>`);
  row('Date', new Date(c.date).toLocaleString());
  if (c.files) row('Changes', `${c.changes} lines in ${c.files} file${c.files === 1 ? '' : 's'}${c.folder ? ` (mostly ${c.folder})` : ''}`);

  if (c.parents.length) {
    const wrap = el('span', 'value');
    c.parents.forEach(p => {
      const a = el('a', 'link', p.slice(0, 8));
      const idx = state.byHash.get(p);
      if (idx !== undefined) a.onclick = () => select(idx, true);
      else a.classList.add('missing');
      wrap.append(a, ' ');
    });
    row(c.parents.length > 1 ? 'Parents' : 'Parent', wrap);
  }
  if (c.refs.length) {
    const wrap = el('span', 'value');
    c.refs.forEach(r => {
      const chip = el('span', 'chip', r.name);
      chip.style.borderColor = REF_COLORS[r.type];
      chip.style.color = REF_COLORS[r.type];
      wrap.append(chip);
    });
    row('Refs', wrap);
  }
  renderChanges(c);
}

// --- commit changes (body + changed files), fetched on demand ---
const commitDetailCache = new Map(); // hash -> { body, files } | 'loading'

function showCommitDetails(index) {
  const c = state.graph.commits[index];
  if (!commitDetailCache.has(c.hash)) {
    commitDetailCache.set(c.hash, 'loading');
    vscode.postMessage({ type: 'commitDetails', hash: c.hash, parent: c.parents[0] });
  }
  select(index);
}

const openInCommitView = (c, path) => vscode.postMessage({ type: 'openCommitView', hash: c.hash, path });

function renderChanges(c) {
  const d = commitDetailCache.get(c.hash);
  if (!d) {
    const b = el('button', 'details-btn', 'Show changes');
    b.title = 'Double-click the commit for the full commit view';
    b.onclick = () => showCommitDetails(state.byHash.get(c.hash));
    infoEl.append(b);
    return;
  }
  if (d === 'loading') {
    infoEl.append(el('div', 'info-loading', 'Loading changes\u2026'));
    return;
  }
  const rest = d.body.split('\n').slice(1).join('\n').trim();
  if (rest) infoEl.append(el('pre', 'body', rest));
  const add = d.files.reduce((s, f) => s + f.add, 0);
  const del = d.files.reduce((s, f) => s + f.del, 0);
  const head = el('div', 'files-head');
  const stat = el('span', 'files-stat');
  stat.append(`${d.files.length} file${d.files.length === 1 ? '' : 's'}  `, el('span', 'add', `+${add}`), ' ', el('span', 'del', `\u2212${del}`));
  const all = el('button', '', 'Open commit view');
  all.title = 'Open the commit with its file tree and diffs';
  all.onclick = () => openInCommitView(c);
  head.append(stat, all);
  const list = el('div', 'files');
  for (const f of d.files) {
    const item = el('div', 'file');
    const slash = f.path.lastIndexOf('/');
    const name = el('span', 'file-name', f.path.slice(slash + 1));
    const dir = el('span', 'file-dir', slash >= 0 ? f.path.slice(0, slash) : '');
    const counts = el('span', 'file-counts');
    if (f.binary) counts.append('bin');
    else counts.append(el('span', 'add', `+${f.add}`), ' ', el('span', 'del', `\u2212${f.del}`));
    item.append(el('span', 'file-status st-' + f.status, f.status), name, dir, counts);
    item.title = `${f.path}\nClick to show the diff in the commit view`;
    item.onclick = () => openInCommitView(c, f.path);
    list.append(item);
  }
  if (c.parents.length > 1) infoEl.append(el('div', 'info-note', `Merge commit: changes shown against first parent ${c.parents[0].slice(0, 7)}`));
  infoEl.append(head, list);
}

// --- context menu ---
function send(action, payload) {
  vscode.postMessage({ type: 'action', action, ...payload });
}

function refActions(ref, current) {
  switch (ref.type) {
    case 'branch':
      return [
        { label: 'Checkout', action: 'checkoutBranch', disabled: ref.name === current },
        { label: 'Merge into current', action: 'mergeBranch', disabled: ref.name === current },
        { label: 'Rebase current onto', action: 'rebaseOnto', disabled: ref.name === current },
        { label: 'Rename...', action: 'renameBranch' },
        { label: 'Delete', action: 'deleteBranch', danger: true, disabled: ref.name === current }
      ];
    case 'remote':
      return [
        { label: 'Checkout as local branch', action: 'checkoutRemote' },
        { label: 'Merge into current', action: 'mergeBranch' }
      ];
    case 'tag':
      return [
        { label: 'Checkout', action: 'checkoutBranch' },
        { label: 'Delete tag', action: 'deleteTag', danger: true }
      ];
    default:
      return [];
  }
}

const COMMIT_ACTIONS = [
  { label: 'Checkout (detached)', action: 'checkoutCommit' },
  { label: 'Create branch here...', action: 'createBranch' },
  { label: 'Create tag here...', action: 'createTag' },
  { label: 'Cherry-pick', action: 'cherryPick' },
  { label: 'Revert', action: 'revert' },
  { label: 'Reset current branch to here...', action: 'reset', danger: true },
  { label: 'Copy hash', action: 'copyHash' }
];

function commitGroups(index, onlyRef) {
  const c = state.graph.commits[index];
  const refs = onlyRef ? [onlyRef] : c.refs;
  const groups = [];
  const tagGroups = [];
  const pinLabel = name => `${pins.has(name) ? 'Unpin' : 'Pin'} branch`;
  refs.forEach(r => {
    const items = refActions(r, state.graph.currentBranch);
    if (r.type === 'branch' || r.type === 'remote') items.unshift({ label: pinLabel(r.name), run: () => togglePin(r.name) });
    if (!items.length) return;
    const g = { title: `${r.type}: ${r.name}`, items, payload: { hash: c.hash, branch: r.name } };
    if (r.type === 'tag') tagGroups.push({ ...g, tag: true });
    else groups.push(g);
  });
  const owner = state.branchOf[index];
  const showItems = [
    { label: 'Open commit view', run: () => openInCommitView(c) },
    { label: 'Show changes', run: () => showCommitDetails(index) }
  ];
  const items = owner && !refs.some(r => r.name === owner)
    ? [...showItems, { label: `${pins.has(owner) ? 'Unpin' : 'Pin'} branch ${owner}`, run: () => togglePin(owner) }, ...COMMIT_ACTIONS]
    : [...showItems, ...COMMIT_ACTIONS];
  groups.push({ title: `commit ${c.hash.slice(0, 8)}`, items, payload: { hash: c.hash } });
  return [...groups, ...tagGroups];
}

const runItem = (item, payload) => (item.run ? item.run() : send(item.action, payload));

function showMenu(e, target) {
  menuEl.replaceChildren();
  for (const g of commitGroups(target.index, target.ref).filter(g => !g.tag)) {
    menuEl.append(el('div', 'menu-title', g.title));
    g.items.forEach(item => {
      const b = el('button', 'menu-item' + (item.danger ? ' danger' : ''), item.label);
      b.disabled = !!item.disabled;
      b.onclick = () => {
        hideMenu();
        runItem(item, g.payload);
      };
      menuEl.append(b);
    });
  }

  menuEl.classList.remove('hidden');
  const { innerWidth: W, innerHeight: H } = window;
  const r = menuEl.getBoundingClientRect();
  menuEl.style.left = Math.min(e.clientX, W - r.width - 4) + 'px';
  menuEl.style.top = Math.min(e.clientY, H - r.height - 4) + 'px';
}

function hideMenu() {
  menuEl.classList.add('hidden');
  menuAnchor?.classList.remove('open');
  menuAnchor = null;
}

// --- header: git toolbar and menus ---
const tool = (name, extra) => vscode.postMessage({ type: 'gitTool', tool: name, hash: selectedHash ?? undefined, ...extra });
let gitStatus = { stashes: 0 };
let menuAnchor = null;

function showDropdown(anchor, items) {
  if (menuAnchor === anchor && !menuEl.classList.contains('hidden')) {
    hideMenu();
    return;
  }
  hideMenu();
  menuEl.replaceChildren();
  items.forEach(item => {
    if (item.sep) {
      menuEl.append(el('div', 'menu-sep'));
      return;
    }
    const b = el('button', 'menu-item' + (item.danger ? ' danger' : ''), item.label);
    if (item.key) b.append(el('span', 'menu-key', item.key));
    b.disabled = !!item.disabled;
    b.onclick = () => {
      hideMenu();
      if (item.run) item.run();
      else tool(item.tool);
    };
    menuEl.append(b);
  });
  menuEl.classList.remove('hidden');
  menuAnchor = anchor;
  anchor.classList.add('open');
  const a = anchor.getBoundingClientRect();
  const r = menuEl.getBoundingClientRect();
  menuEl.style.left = Math.max(4, Math.min(a.left, window.innerWidth - r.width - 4)) + 'px';
  menuEl.style.top = a.bottom + 4 + 'px';
}

window.addEventListener('pointerdown', e => {
  if (!menuEl.contains(e.target) && !(menuAnchor && menuAnchor.contains(e.target))) hideMenu();
}, true);

document.querySelectorAll('#header [data-tool]').forEach(b => { b.onclick = () => tool(b.dataset.tool); });
document.getElementById('branchBtn').onclick = () => tool('checkout');
document.getElementById('remoteMore').onclick = e => showDropdown(e.currentTarget, [
  { label: 'Fetch all remotes & prune', tool: 'fetchAll' },
  { label: 'Pull with rebase', tool: 'pullRebase' },
  { label: 'Push...', tool: 'pushMenu' },
  { label: 'Force push (with lease)', tool: 'pushForce', danger: true }
]);
document.getElementById('stashBtn').onclick = e => showDropdown(e.currentTarget, [
  { label: 'Stash all changes', tool: 'stashPush' },
  { label: 'Stash unstaged only (keep staged)', tool: 'stashKeepIndex' },
  { label: 'Stash including untracked', tool: 'stashPushU' },
  { sep: true },
  { label: 'Pop latest stash', tool: 'stashPop', disabled: !gitStatus.stashes },
  { label: 'Manage stashes...', tool: 'manageStashes' }
]);
document.getElementById('commandsMenu').onclick = e => showDropdown(e.currentTarget, [
  { label: 'Commit...', tool: 'commit' },
  { label: 'Undo last commit', tool: 'undoCommit' },
  { label: 'Pull/Fetch...', tool: 'pullFetch' },
  { label: 'Push...', tool: 'pushMenu' },
  { sep: true },
  { label: 'Manage stashes...', tool: 'manageStashes' },
  { label: 'Reset changes...', tool: 'resetChanges', danger: true },
  { label: 'Clean working directory...', tool: 'clean', danger: true },
  { sep: true },
  { label: 'Create branch...', tool: 'createBranch' },
  { label: 'Delete branch...', tool: 'deleteBranch' },
  { label: 'Checkout branch...', tool: 'checkout' },
  { label: 'Merge branches...', tool: 'merge' },
  { label: 'Rebase...', tool: 'rebase' },
  { label: 'Solve merge conflicts...', tool: 'conflicts' },
  { sep: true },
  { label: 'Create tag...', tool: 'createTag' },
  { label: 'Delete tag...', tool: 'deleteTag' },
  { sep: true },
  { label: 'Cherry pick...', tool: 'cherryPick' },
  { label: 'Archive revision...', tool: 'archive' },
  { label: 'Checkout revision...', tool: 'checkoutRevision' },
  { label: 'Bisect...', tool: 'bisect' },
  { label: 'Show reflog...', tool: 'reflog' },
  { sep: true },
  { label: 'Format patch...', tool: 'formatPatch' },
  { label: 'Apply patch...', tool: 'applyPatch' },
  { label: 'View patch file...', tool: 'viewPatch' }
]);
document.getElementById('viewMenu').onclick = e => showDropdown(e.currentTarget, [
  { label: 'Refresh', run: () => vscode.postMessage({ type: 'refresh' }) },
  { label: 'Reset view', key: 'Home', run: resetView },
  { label: 'Reset layout', run: resetLayout },
  { sep: true },
  { label: `${ui.sideHidden ? 'Show' : 'Hide'} sidebar`, key: 'N', run: () => setUi({ sideHidden: !ui.sideHidden }) },
  { label: 'Hide interface', key: 'H', run: () => setUi({ uiHidden: true }) }
]);

function renderGitStatus(s) {
  gitStatus = s;
  document.getElementById('branchName').textContent = s.branch || 'detached HEAD';
  const count = (id, n) => { document.getElementById(id).textContent = n ? ` ${n}` : ''; };
  count('behindCount', s.behind);
  count('aheadCount', s.ahead);
  count('stashCount', s.stashes);
  document.getElementById('changeCount').textContent = s.changes;
  document.getElementById('commitBtn').classList.toggle('dirty', s.changes > 0);
}

// --- input ---
let downPos = null;
const canvas = renderer.domElement;

window.addEventListener('contextmenu', e => e.preventDefault());

// Zoom toward the cursor; near the orbit target keep flying forward instead of stalling.
const zoomPlane = new THREE.Plane();
const zoomPoint = new THREE.Vector3();
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const delta = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1);
  const factor = Math.exp(delta * ZOOM_SPEED);
  setPointer(e);
  raycaster.setFromCamera(pointer, camera);
  const dist = camera.position.distanceTo(controls.target);
  if (factor < 1 && dist * factor < MIN_ORBIT) {
    tmpVec.copy(raycaster.ray.direction).multiplyScalar(Math.max(MIN_ORBIT * (1 - factor) * 2, 0.05));
    camera.position.add(tmpVec);
    controls.target.add(tmpVec);
  } else {
    const hit = state && raycaster.intersectObject(state.commitMesh, false)[0];
    if (hit) zoomPoint.copy(hit.point);
    else {
      zoomPlane.setFromNormalAndCoplanarPoint(camera.getWorldDirection(tmpPt), controls.target);
      if (!raycaster.ray.intersectPlane(zoomPlane, zoomPoint)) zoomPoint.copy(controls.target);
    }
    const f = Math.min(factor, 4000 / Math.max(dist, 1e-3));
    camera.position.sub(zoomPoint).multiplyScalar(f).add(zoomPoint);
    controls.target.sub(zoomPoint).multiplyScalar(f).add(zoomPoint);
  }
  controls.update();
  invalidate();
}, { passive: false });

let drag = null; // { index, plane, offset }
const dragHit = new THREE.Vector3();

canvas.addEventListener('pointerdown', e => {
  downPos = { x: e.clientX, y: e.clientY, button: e.button };
  hideMenu();
  if (e.button !== 0) return;
  const hit = pick(e);
  // Left-drag on empty space pans like a map; on a node it moves the node.
  controls.mouseButtons.LEFT = hit ? -1 : THREE.MOUSE.PAN;
  if (!hit) return;
  // Drag on a plane facing the camera through the node.
  const pos = state.positions[hit.index];
  const normal = camera.getWorldDirection(new THREE.Vector3());
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, pos);
  if (!raycaster.ray.intersectPlane(plane, dragHit)) return;
  startDrag(hit.index, plane, pos.clone().sub(dragHit));
}, true); // capture: must run before OrbitControls reads mouseButtons

canvas.addEventListener('pointerup', e => {
  if (e.button === 0 && drag) {
    drag = null;
    startSim(0.3);
  }
  if (!downPos || downPos.button !== e.button) return;
  const moved = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y);
  downPos = null;
  if (moved > CLICK_TOLERANCE) return; // it was a drag (move/rotate/pan)
  const hit = pick(e);
  if (e.button === 0) select(hit ? hit.index : null);
  else if (e.button === 2 && hit) {
    select(hit.index);
    showMenu(e, hit);
  }
});

// Coalesce pointer moves to at most one raycast per frame.
canvas.addEventListener('dblclick', e => {
  const hit = pick(e);
  if (!hit) return;
  select(hit.index);
  vscode.postMessage({ type: 'openCommitView', hash: state.graph.commits[hit.index].hash });
});
let pendingMove = null;
canvas.addEventListener('pointermove', e => { pendingMove = e; });

function handlePointerMove(e) {
  if (drag && state && downPos &&
      Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > CLICK_TOLERANCE) {
    setPointer(e);
    raycaster.setFromCamera(pointer, camera);
    if (raycaster.ray.intersectPlane(drag.plane, dragHit)) dragNodes(dragHit.add(drag.offset).sub(drag.start));
    canvas.style.cursor = 'grabbing';
  }
  if (e.buttons) {
    tooltipEl.classList.add('hidden');
    return;
  }
  const hit = pick(e);
  const idx = hit ? hit.index : -1;
  const hoverKey = hit?.more ? `${idx}:refs` : idx;
  canvas.style.cursor = hit ? 'pointer' : 'default';
  if (hoverKey !== hoveredKey) {
    hoveredKey = hoverKey;
    hoveredIndex = idx;
    if (idx >= 0) {
      const c = state.graph.commits[idx];
      const title = document.createElement('div');
      title.textContent = `${c.hash.slice(0, 8)}  ${c.subject}`;
      const branch = document.createElement('div');
      branch.className = 'tooltip-branch';
      branch.textContent = state.branchOf[idx] ?? '(unknown branch)';
      tooltipEl.replaceChildren(title, branch);
      if (hit.more) {
        for (const r of hit.more) {
          const row = document.createElement('div');
          row.className = 'tooltip-ref';
          const dot = document.createElement('span');
          dot.className = 'search-dot';
          dot.style.background = REF_COLORS[r.type];
          row.append(dot, r.name);
          tooltipEl.append(row);
        }
      }
      tooltipEl.classList.remove('hidden');
    } else tooltipEl.classList.add('hidden');
  }
  tooltipEl.style.left = e.clientX + 14 + 'px';
  // above the cursor so it doesn't cover the context menu
  tooltipEl.style.top = Math.max(0, e.clientY - 10 - tooltipEl.offsetHeight) + 'px';
}

window.addEventListener('keydown', e => {
  const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement;
  if (e.key === 'Escape') {
    hideMenu();
    select(null);
  } else if (typing || e.ctrlKey || e.metaKey || e.altKey) {
    return;
  } else if ((e.key === 'p' || e.key === 'P') && state && selectedHash) {
    const idx = state.byHash.get(selectedHash);
    if (idx !== undefined) togglePin(state.branchOf[idx]);
  } else if (e.key === 'n' || e.key === 'N') setUi({ sideHidden: !ui.sideHidden });
  else if (e.key === 'h' || e.key === 'H') setUi({ uiHidden: !ui.uiHidden });
  else if (e.key === 'Home') resetView();
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  state?.sprites.forEach(sizeLabel);
  state?.chains.forEach(ch => ch.label && sizeLabel(ch.label));
  state?.timeTicks.forEach(t => t.sprite && sizeLabel(t.sprite));
  state?.details.forEach(d => d && sizeLabel(d));
  invalidate();
});

function rebuild() {
  if (!state) return;
  buildGraph(state.graph);
  const idx = selectedHash ? state.byHash.get(selectedHash) : undefined;
  select(idx ?? null);
}

function resetLayout() {
  movedPositions.clear();
  simPositions.clear();
  rebuild();
}

// --- interface layout: sidebar width, collapsed panels, hidden UI ---
const SIDE_MIN = 220;
const ui = { sideW: 320, sideHidden: false, uiHidden: false, collapsed: [], itemFrac: 0.55, tagActionsOpen: false };
const sidebar = document.getElementById('sidebar');

function applyUi() {
  document.documentElement.style.setProperty('--side-w', ui.sideW + 'px');
  sidebar.style.setProperty('--item-h', (ui.itemFrac * 100).toFixed(1) + '%');
  document.body.classList.toggle('side-hidden', ui.sideHidden);
  document.body.classList.toggle('ui-hidden', ui.uiHidden);
  document.querySelectorAll('#sidebar .panel').forEach(p => p.classList.toggle('collapsed', ui.collapsed.includes(p.id)));
  pinsEl.classList.toggle('collapsed', ui.collapsed.includes('pins'));
  document.getElementById('eyeBtn').title = `${ui.uiHidden ? 'Show' : 'Hide'} the interface (H)`;
}

function setUi(patch) {
  Object.assign(ui, patch);
  applyUi();
  persist();
}

function toggleCollapsed(id) {
  setUi({ collapsed: ui.collapsed.includes(id) ? ui.collapsed.filter(x => x !== id) : [...ui.collapsed, id] });
}

document.getElementById('eyeBtn').onclick = () => setUi({ uiHidden: !ui.uiHidden });
document.getElementById('sideToggle').onclick = () => setUi({ sideHidden: !ui.sideHidden });
document.querySelectorAll('#sidebar .panel-head').forEach(h => {
  h.onclick = () => toggleCollapsed(h.parentElement.id);
});

// drag between the Item and Actions panels; stored as a fraction of the sidebar height
const sideSplit = document.getElementById('sideSplit');
sideSplit.addEventListener('pointerdown', e => {
  sideSplit.setPointerCapture(e.pointerId);
  sideSplit.classList.add('dragging');
});
sideSplit.addEventListener('pointermove', e => {
  if (!sideSplit.hasPointerCapture(e.pointerId)) return;
  const r = sidebar.getBoundingClientRect();
  ui.itemFrac = Math.min(Math.max((e.clientY - r.top) / r.height, 0.1), 0.9);
  applyUi();
});
sideSplit.addEventListener('pointerup', () => {
  sideSplit.classList.remove('dragging');
  persist();
});

const sideResize = document.getElementById('sideResize');
sideResize.addEventListener('pointerdown', e => {
  sideResize.setPointerCapture(e.pointerId);
  sideResize.classList.add('dragging');
});
sideResize.addEventListener('pointermove', e => {
  if (!sideResize.hasPointerCapture(e.pointerId)) return;
  ui.sideW = Math.round(Math.min(Math.max(window.innerWidth - e.clientX, SIDE_MIN), window.innerWidth * 0.7));
  applyUi();
});
sideResize.addEventListener('pointerup', () => {
  sideResize.classList.remove('dragging');
  persist();
});
applyUi();

const viewPanel = document.getElementById('viewPanel');
document.getElementById('viewBtn').onclick = () => viewPanel.classList.toggle('hidden');
canvas.addEventListener('pointerdown', () => viewPanel.classList.add('hidden'));

document.getElementById('colorMode').onchange = e => {
  settings.colorMode = e.target.value;
  if (state) applyColors();
};
document.getElementById('sizeByChanges').onchange = e => {
  settings.sizeByChanges = e.target.checked;
  if (!state) return;
  for (let i = 0; i < state.positions.length; i++) syncNode(i);
  const idx = selectedHash ? state.byHash.get(selectedHash) : undefined;
  if (idx !== undefined) state.selMarker.userData.base = nodeScale(idx);
  markMoved();
};
document.getElementById('organic').onchange = e => {
  settings.organic = e.target.checked;
  simAlpha = 0;
  simPositions.clear();
  rebuild();
};
document.getElementById('collapseChains').onchange = e => {
  settings.collapse = e.target.checked;
  invalidate();
};
document.getElementById('dimLabels').onchange = e => {
  settings.labelsDimmed = e.target.checked;
  invalidate();
};
document.getElementById('details').onchange = e => {
  settings.details = e.target.checked;
  invalidate();
};
document.getElementById('layout').onchange = e => {
  settings.layout = e.target.value;
  simPositions.clear();
  rebuild();
  resetView();
};
document.getElementById('declutter').onchange = e => {
  settings.declutter = e.target.checked;
  invalidate();
};
document.getElementById('groupRefLabels').onchange = e => {
  settings.groupRefLabels = e.target.checked;
  rebuild();
};
const labelDistEl = document.getElementById('labelDist');
labelDistEl.max = LABEL_DIST_MAX;
labelDistEl.value = settings.labelDistance;
labelDistEl.oninput = () => {
  settings.labelDistance = Number(labelDistEl.value);
  invalidate();
};
const branchSpacingEl = document.getElementById('branchSpacing');
branchSpacingEl.value = settings.branchSpacing;
branchSpacingEl.onchange = () => {
  settings.branchSpacing = Number(branchSpacingEl.value);
  simPositions.clear();
  rebuild();
};
const depthVarEl = document.getElementById('depthVariation');
depthVarEl.value = settings.depthVariation;
depthVarEl.onchange = () => {
  settings.depthVariation = Number(depthVarEl.value);
  simPositions.clear();
  rebuild();
};
const renderDistEl = document.getElementById('renderDist');
renderDistEl.value = settings.renderDistance;
function applyRenderDistance() {
  settings.renderDistance = Number(renderDistEl.value);
  scene.fog.near = settings.renderDistance * 0.35;
  scene.fog.far = settings.renderDistance;
  invalidate();
}
renderDistEl.oninput = applyRenderDistance;
applyRenderDistance();

// --- persistence: kept by the extension in VS Code's global storage, not in the repo ---
const cameraByRoot = {}; // root -> { p, t }
const filtersByRoot = {}; // root -> [{ type, value }]
let persistTimer;

function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    if (loadedRoot) {
      cameraByRoot[loadedRoot] = { p: camera.position.toArray(), t: controls.target.toArray() };
      filtersByRoot[loadedRoot] = [...filters];
    }
    vscode.postMessage({
      type: 'persist',
      data: { settings, pinnedBranches: pinsByRoot, fadeUnpinned, cameras: cameraByRoot, filters: filtersByRoot, ui }
    });
  }, 400);
}

function restore(data) {
  Object.assign(settings, data.settings);
  pinsByRoot = data.pinnedBranches || {};
  if (typeof data.fadeUnpinned === 'boolean') fadeUnpinned = data.fadeUnpinned;
  Object.assign(cameraByRoot, data.cameras);
  Object.assign(filtersByRoot, data.filters);
  Object.assign(ui, data.ui);
  applyUi();
  const set = (id, prop, value) => { document.getElementById(id)[prop] = value; };
  set('colorMode', 'value', settings.colorMode);
  set('sizeByChanges', 'checked', settings.sizeByChanges);
  set('collapseChains', 'checked', settings.collapse);
  set('layout', 'value', settings.layout);
  set('organic', 'checked', settings.organic);
  set('dimLabels', 'checked', settings.labelsDimmed);
  set('details', 'checked', settings.details);
  set('declutter', 'checked', settings.declutter);
  set('groupRefLabels', 'checked', settings.groupRefLabels);
  labelDistEl.value = settings.labelDistance;
  branchSpacingEl.value = settings.branchSpacing;
  depthVarEl.value = settings.depthVariation;
  renderDistEl.value = settings.renderDistance;
  applyRenderDistance();
}

function restoreCamera(root) {
  const cam = cameraByRoot[root];
  if (!cam) return false;
  camera.position.fromArray(cam.p);
  controls.target.fromArray(cam.t);
  controls.update();
  invalidate();
  return true;
}

// handlers on the controls run first, then this saves the new values
viewPanel.addEventListener('change', persist);
viewPanel.addEventListener('input', persist);
controls.addEventListener('change', persist);

// --- search: refs, commit subjects, authors and hashes ---
const searchInput = document.getElementById('searchInput');
const searchResults = document.getElementById('searchResults');
const SEARCH_LIMIT = 100;
let searchRows = []; // [{ row, i }]
let searchActive = 0;

function goToRef(index, keepOpen) {
  if (!keepOpen) searchResults.classList.add('hidden');
  select(index);
  focusOn(state.positions[index], false);
  highlightUntil = performance.now() + 1500;
}

// Wraps every occurrence of any term in <mark>.
function highlighted(text, terms, cls) {
  const span = el('span', cls);
  const lower = text.toLowerCase();
  const hits = new Uint8Array(text.length);
  for (const t of terms) {
    if (!t) continue;
    for (let k = lower.indexOf(t); k !== -1; k = lower.indexOf(t, k + 1)) hits.fill(1, k, k + t.length);
  }
  let start = 0;
  for (let k = 1; k <= text.length; k++) {
    if (k < text.length && hits[k] === hits[start]) continue;
    const part = text.slice(start, k);
    span.append(hits[start] ? el('mark', '', part) : part);
    start = k;
  }
  return span;
}

// "author:" and "branch:" prefixes narrow a term to that field; plain terms must all match somewhere.
function parseQuery(q) {
  const terms = { any: [], author: [], branch: [] };
  for (const tok of q.split(/\s+/)) {
    const m = /^(author|branch):(.*)$/.exec(tok);
    if (m) { if (m[2]) terms[m[1]].push(m[2]); }
    else if (tok) terms.any.push(tok);
  }
  return terms;
}

function setSearchActive(k) {
  if (!searchRows.length) return;
  searchRows[searchActive]?.row.classList.remove('active');
  searchActive = (k + searchRows.length) % searchRows.length;
  const { row } = searchRows[searchActive];
  row.classList.add('active');
  row.scrollIntoView({ block: 'nearest' });
}

function renderSearch() {
  searchResults.replaceChildren();
  searchRows = [];
  searchActive = 0;
  const q = searchInput.value.trim().toLowerCase();
  if (!state || !q) {
    searchResults.classList.add('hidden');
    return;
  }
  const t = parseQuery(q);
  const refTerms = [...t.any, ...t.branch];
  const refs = [];
  const commits = [];
  state.graph.commits.forEach((c, i) => {
    if (!t.author.length) {
      for (const r of c.refs) {
        const name = r.name.toLowerCase();
        if (r.type !== 'head' && refTerms.every(x => name.includes(x))) refs.push({ r, i, name });
      }
    }
    if (t.branch.length) return;
    const author = `${c.author} ${c.email}`.toLowerCase();
    const subject = c.subject.toLowerCase();
    if (t.author.every(x => author.includes(x)) && t.any.every(x => subject.includes(x) || author.includes(x) || c.hash.startsWith(x))) commits.push(i);
  });
  // prefix matches first, then shorter names
  const lead = refTerms[0] ?? '';
  const score = ({ name }) => (name.startsWith(lead) || name.includes('/' + lead) ? 0 : 1);
  refs.sort((a, b) => score(a) - score(b) || a.name.length - b.name.length || a.name.localeCompare(b.name));

  const addRow = (row, i) => {
    // pointerdown so it fires before the input's blur hides the list
    row.addEventListener('pointerdown', e => {
      e.preventDefault();
      goToRef(i);
    });
    row.addEventListener('pointermove', () => setSearchActive(searchRows.findIndex(s => s.row === row)));
    searchRows.push({ row, i });
    searchResults.append(row);
  };

  if (refs.length) {
    searchResults.append(el('div', 'search-group', `Branches & tags (${refs.length})`));
    for (const { r, i } of refs.slice(0, SEARCH_LIMIT)) {
      const row = el('div', 'search-item');
      const dot = el('span', 'search-dot');
      dot.style.background = REF_COLORS[r.type];
      row.append(dot, highlighted(r.name, refTerms, 'search-main'), el('span', 'search-type', r.type));
      row.title = r.name;
      addRow(row, i);
    }
  }
  if (commits.length) {
    searchResults.append(el('div', 'search-group', `Commits (${commits.length})`));
    const { commits: all } = state.graph;
    for (const i of commits.slice(0, SEARCH_LIMIT)) {
      const c = all[i];
      const row = el('div', 'search-item commit');
      const dot = el('span', 'search-dot');
      dot.style.background = '#' + state.nodeColors[i].getHexString();
      const meta = el('span', 'search-type');
      meta.append(highlighted(c.author, [...t.any, ...t.author]), ` \u00B7 ${relativeTime(c.date)}`);
      row.append(dot, highlighted(c.hash.slice(0, 7), t.any.filter(x => c.hash.startsWith(x)), 'search-hash'), highlighted(c.subject, t.any, 'search-main'), meta);
      row.title = `${c.subject}\n${c.author} \u00B7 ${new Date(c.date).toLocaleString()}`;
      addRow(row, i);
    }
  }
  if (!searchRows.length) searchResults.append(el('div', 'search-empty', 'No matches'));
  else {
    const shown = searchRows.length < refs.length + commits.length ? ` \u00B7 showing ${searchRows.length}` : '';
    searchResults.append(el('div', 'search-footer', `\u2191\u2193 move \u00B7 Enter go to, again for next \u00B7 author: branch:${shown}`));
    setSearchActive(0);
  }
  searchResults.classList.remove('hidden');
}

searchInput.addEventListener('input', renderSearch);
searchInput.addEventListener('focus', renderSearch);
searchInput.addEventListener('blur', () => searchResults.classList.add('hidden'));
searchInput.addEventListener('keydown', e => {
  e.stopPropagation();
  if (e.key === 'Escape') searchInput.blur();
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    setSearchActive(searchActive + (e.key === 'ArrowDown' ? 1 : -1));
  } else if (e.key === 'Enter' && searchRows.length) {
    // jump but stay open so repeated Enter walks through the matches (Shift+Enter goes back)
    goToRef(searchRows[searchActive].i, true);
    setSearchActive(searchActive + (e.shiftKey ? -1 : 1));
  }
});
window.addEventListener('keydown', e => {
  if (e.target instanceof HTMLInputElement) return;
  if ((e.key === 'f' && (e.ctrlKey || e.metaKey)) || e.key === '/') {
    e.preventDefault();
    searchInput.focus();
    searchInput.select();
  }
});

// --- messages ---
window.addEventListener('message', ({ data }) => {
  if (data.type === 'graph') {
    loadingMore = false;
    const firstLoad = loadedRoot !== data.graph.root;
    loadedRoot = data.graph.root;
    if (firstLoad) {
      movedPositions.clear();
      simPositions.clear();
      const hadPins = pinsByRoot[loadedRoot] !== undefined;
      loadPins(loadedRoot);
      filters.splice(0, filters.length, ...(filtersByRoot[loadedRoot] || []));
      if (!hadPins && data.graph.currentBranch) {
        pins.add(data.graph.currentBranch);
        savePins();
      }
    }
    document.getElementById('repoName').textContent =
      `${data.graph.name}  \u00B7  ${data.graph.commits.length}${data.graph.hasMore ? '+' : ''} commits`;
    buildGraph(data.graph);
    if (firstLoad) {
      renderFilters();
      if (!restoreCamera(loadedRoot)) resetView();
    }
    const idx = selectedHash ? state.byHash.get(selectedHash) : undefined;
    select(idx ?? null);
  } else if (data.type === 'stats' && state) {
    const { commits } = state.graph;
    for (const c of commits) {
      const s = data.stats[c.hash];
      if (s) Object.assign(c, s);
    }
    state.sizes = Float32Array.from(commits, commitSize);
    for (let i = 0; i < commits.length; i++) syncNode(i);
    applyColors();
    markMoved();
    const idx = selectedHash ? state.byHash.get(selectedHash) : undefined;
    if (idx !== undefined) select(idx);
    else renderSide();
  } else if (data.type === 'restore') {
    restore(data.data || {});
  } else if (data.type === 'gitStatus') {
    renderGitStatus(data);
  } else if (data.type === 'commitDetails') {
    if (data.error) commitDetailCache.delete(data.hash);
    else commitDetailCache.set(data.hash, { body: data.body, files: data.files });
    if (state) renderSide();
  } else if (data.type === 'error') {
    loadingMore = false;
    document.getElementById('repoName').textContent = data.message;
  }
});

function animate() {
  requestAnimationFrame(animate);
  if (pendingMove) {
    handlePointerMove(pendingMove);
    pendingMove = null;
  }
  stepViewAnim();
  controls.update();
  if (state) {
    if (simAlpha > 0) simTick();
    const base = state.selMarker.userData.base ?? 1;
    const now = performance.now();
    const target = now < highlightUntil ? base * (1 + 0.6 * Math.abs(Math.sin(now / 150))) : base;
    if (state.selMarker.scale.x !== target) {
      state.selMarker.scale.setScalar(target);
      needsRender = true;
    }
  }
  if (!needsRender) return;
  needsRender = false;
  if (state) {
    updateLod();
    updateLabels();
    updateTimeTicks();
    maybeLoadMore();
  }
  grid.position.set(Math.round(controls.target.x / 5) * 5, Math.round(controls.target.y / 5) * 5, 0);
  xAxis.position.set(timeAxisX, grid.position.y, 0);
  renderer.render(scene, camera);
  drawGizmo();
}

// --- navigation gizmo (Blender-style): click an axis to look from that side ---
const GIZMO_SIZE = 90;
const GIZMO_R = 32; // axis length in px
const GIZMO_AXES = [
  { dir: new THREE.Vector3(1, 0, 0), color: '#e8414f', label: 'X' },
  { dir: new THREE.Vector3(0, 1, 0), color: '#6ea927', label: 'Y' },
  { dir: new THREE.Vector3(0, 0, 1), color: '#3a7ee8', label: 'Z' },
  { dir: new THREE.Vector3(-1, 0, 0), color: '#e8414f' },
  { dir: new THREE.Vector3(0, -1, 0), color: '#6ea927' },
  { dir: new THREE.Vector3(0, 0, -1), color: '#3a7ee8' }
];
const gizmoEl = document.getElementById('gizmo');
const gizmoCtx = gizmoEl.getContext('2d');
const gizmoDpr = Math.max(1, window.devicePixelRatio);
gizmoEl.width = gizmoEl.height = GIZMO_SIZE * gizmoDpr;
const viewQuat = new THREE.Quaternion();
let gizmoHover = -1;
let gizmoHits = [];
let viewAnim = null; // { from, rot, dist, t0 }

function drawGizmo() {
  const ctx = gizmoCtx;
  const c = GIZMO_SIZE / 2;
  ctx.setTransform(gizmoDpr, 0, 0, gizmoDpr, 0, 0);
  ctx.clearRect(0, 0, GIZMO_SIZE, GIZMO_SIZE);
  if (gizmoEl.matches(':hover')) {
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.beginPath();
    ctx.arc(c, c, c - 1, 0, Math.PI * 2);
    ctx.fill();
  }
  viewQuat.copy(camera.quaternion).invert();
  gizmoHits = GIZMO_AXES.map((a, k) => {
    tmpPt.copy(a.dir).applyQuaternion(viewQuat);
    return { k, x: c + tmpPt.x * GIZMO_R, y: c - tmpPt.y * GIZMO_R, z: tmpPt.z };
  }).sort((a, b) => a.z - b.z); // back to front
  ctx.lineWidth = 2;
  ctx.font = 'bold 11px Segoe UI, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const h of gizmoHits) {
    const a = GIZMO_AXES[h.k];
    const r = a.label ? 9 : 7;
    ctx.globalAlpha = a.label ? 1 : 0.55;
    if (a.label) {
      ctx.strokeStyle = a.color;
      ctx.beginPath();
      ctx.moveTo(c, c);
      ctx.lineTo(h.x, h.y);
      ctx.stroke();
    }
    ctx.fillStyle = a.color;
    ctx.beginPath();
    ctx.arc(h.x, h.y, r, 0, Math.PI * 2);
    ctx.fill();
    if (h.k === gizmoHover) {
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
    }
    if (a.label) {
      ctx.fillStyle = '#101010';
      ctx.fillText(a.label, h.x, h.y + 0.5);
    }
  }
  ctx.globalAlpha = 1;
}

function gizmoAxisAt(e) {
  const rect = gizmoEl.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  // front-most first
  for (let n = gizmoHits.length - 1; n >= 0; n--) {
    const h = gizmoHits[n];
    if (Math.hypot(h.x - x, h.y - y) <= 10) return h.k;
  }
  return -1;
}

function viewFrom(dir) {
  const offset = camera.position.clone().sub(controls.target);
  const from = offset.clone().normalize();
  let to = dir.clone();
  if (from.dot(to) > 0.999) to.negate(); // clicking the axis you're already looking down flips to the opposite side, like Blender
  if (Math.abs(to.y) > 0.999) to.z += 1e-3; // keep OrbitControls off its pole
  to.normalize();
  viewAnim = { from, rot: new THREE.Quaternion().setFromUnitVectors(from, to), dist: offset.length(), t0: performance.now() };
  invalidate();
}

function stepViewAnim() {
  if (!viewAnim) return;
  const t = Math.min((performance.now() - viewAnim.t0) / 300, 1);
  const e = t * t * (3 - 2 * t);
  tmpQuat.identity().slerp(viewAnim.rot, e);
  camera.position.copy(viewAnim.from).applyQuaternion(tmpQuat).multiplyScalar(viewAnim.dist).add(controls.target);
  camera.lookAt(controls.target);
  if (t === 1) viewAnim = null;
  invalidate();
}

gizmoEl.addEventListener('pointermove', e => {
  const k = gizmoAxisAt(e);
  gizmoEl.style.cursor = k >= 0 ? 'pointer' : 'default';
  if (k !== gizmoHover) {
    gizmoHover = k;
    drawGizmo();
  }
});
gizmoEl.addEventListener('pointerleave', () => {
  gizmoHover = -1;
  drawGizmo();
});
gizmoEl.addEventListener('click', e => {
  const k = gizmoAxisAt(e);
  if (k >= 0) viewFrom(GIZMO_AXES[k].dir);
});

// Hide labels that would overlap a higher-priority one on screen (selected > current/HEAD > local > tag > remote, then nearest).
const labelRects = [];
const projVec = new THREE.Vector3();
function declutterLabels() {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const cands = [];
  for (const s of [...state.sprites, ...state.details]) {
    if (!s?.visible) continue;
    projVec.copy(s.position).project(camera);
    if (projVec.z > 1 || projVec.x < -1.2 || projVec.x > 1.2 || projVec.y < -1.2 || projVec.y > 1.2) {
      s.visible = false;
      continue;
    }
    const i = s.userData.commitIndex;
    const selected = state.graph.commits[i].hash === selectedHash;
    const h = s.userData.px ?? LABEL_PX;
    const w = h * s.userData.aspect;
    const px = (projVec.x + 1) / 2 * W;
    const py = (1 - projVec.y) / 2 * H;
    const left = px - s.center.x * w;
    const top = py + s.center.y * h - h;
    const rank = selected ? -1 : (state.faded?.[i] ? 10 : 0) + s.userData.rank;
    cands.push({ s, rank, depth: projVec.z, left, top, right: left + w, bottom: top + h });
  }
  cands.sort((a, b) => a.rank - b.rank || a.depth - b.depth);
  labelRects.length = 0;
  for (const c of cands) {
    const hit = c.rank >= 0 && labelRects.some(r => c.left < r.right + 2 && c.right > r.left - 2 && c.top < r.bottom + 1 && c.bottom > r.top - 1);
    c.s.visible = !hit;
    if (!hit) labelRects.push(c);
  }
}

// Google Earth-style detail: commit rows get their info label only once zoomed in enough for rows to be readable.
function updateDetails() {
  const { commits } = state.graph;
  const pxPerUnit = window.innerHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
  const opacity = settings.labelsDimmed ? DIM_OPACITY : 1;
  for (let i = 0; i < commits.length; i++) {
    const p = state.positions[i];
    const selected = commits[i].hash === selectedHash;
    let show = (settings.details || selected) && !state.hidden[i];
    if (show && !selected) show = X_SPACING * pxPerUnit / p.distanceTo(camera.position) >= DETAIL_MIN_ROW_PX;
    if (show) {
      projVec.copy(p).project(camera);
      show = projVec.z < 1 && Math.abs(projVec.x) < 1.1 && Math.abs(projVec.y) < 1.1;
    }
    let d = state.details[i];
    if (show && !d) {
      d = makeDetailSprite(commits[i]);
      const ref = state.nodeSprites[i][0];
      const offsetPx = 8 + (ref ? LABEL_PX * ref.userData.aspect + 6 : 0);
      d.center.set(-offsetPx / (DETAIL_PX * d.userData.aspect), 0.5);
      d.position.copy(p);
      d.userData.commitIndex = i;
      d.userData.rank = 6;
      graphGroup.add(d);
      state.details[i] = d;
      state.detailCount++;
    }
    if (!d) continue;
    d.visible = show;
    d.material.opacity = state.faded?.[i] && !selected ? opacity * 0.15 : opacity;
  }
  if (state.detailCount <= DETAIL_CACHE) return;
  state.details.forEach((d, i) => {
    if (!d || d.visible) return;
    graphGroup.remove(d);
    d.material.map.dispose();
    d.material.dispose();
    state.details[i] = null;
    state.detailCount--;
  });
}

function updateLabels() {
  const maxSq = settings.labelDistance >= LABEL_DIST_MAX ? Infinity : settings.labelDistance ** 2;
  const opacity = settings.labelsDimmed ? DIM_OPACITY : 1;
  for (const s of state.sprites) {
    const i = s.userData.commitIndex;
    const selected = state.graph.commits[i].hash === selectedHash;
    s.visible = selected || s.position.distanceToSquared(camera.position) <= maxSq;
    s.material.opacity = state.faded?.[i] && !selected ? opacity * 0.15 : opacity;
  }
  updateDetails();
  if (settings.declutter) declutterLabels();
  const chainLabelSq = (settings.renderDistance * 0.6) ** 2;
  for (const ch of state.chains) {
    if (!ch.label) continue;
    ch.label.material.opacity = opacity;
    ch.label.visible = ch.collapsed && ch.label.position.distanceToSquared(camera.position) <= chainLabelSq;
  }
}
animate();
vscode.postMessage({ type: 'ready' });
