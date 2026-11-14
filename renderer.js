'use strict';

// ---------- Setup ----------
const canvas = document.getElementById('overlay'); // takes all pen/mouse input
// Scene (finished work) is painted on the main canvas only when something changes;
// live ink, cursor and selection go on a transparent low-latency overlay above it.
const scenes = [document.getElementById('board'), document.getElementById('board2')];
const sceneCtxs = scenes.map((c) => c.getContext('2d', { alpha: false }));
let front = 0;                 // which scene canvas is showing
let sceneCanvas = scenes[0];
let sctx = sceneCtxs[0];
const overlay = canvas;
const ctx = overlay.getContext('2d', { desynchronized: true });
const toolbar = document.getElementById('toolbar');
const hint = document.getElementById('hint');

// Colors are stored as names and resolved per theme, so each has a light and dark variant.
const COLORS = ['ink', 'red', 'blue', 'green', 'orange', 'purple'];
const PALETTE = {
  light: { ink: '#2b3340', red: '#d6677a', blue: '#4f86d4', green: '#3e9e8c', orange: '#d9935f', purple: '#8a78d0' },
  dark:  { ink: '#e4e8ef', red: '#ee95a3', blue: '#86b1ec', green: '#77cbb8', orange: '#eeb487', purple: '#b3a5ee' },
};
const HIGHLIGHT_INK = { light: '#f3d34a', dark: '#ffdf5e' }; // highlighter color when "Ink" is chosen
// Strokes drawn with the earlier palette map onto the new names
const LEGACY_COLORS = { '#e53935': 'red', '#1e88e5': 'blue', '#43a047': 'green', '#fb8c00': 'orange', '#ab47bc': 'purple' };
const MIN_SCALE = 0.1;
const MAX_SCALE = 10;
const HANDLE = 10;          // resize handle size in screen px
const ERASER_R = 8;         // eraser radius in screen px
const HOLD_MS = 550;        // hold the pen still this long to straighten a stroke
const SNAP_DEG = 6;         // straight lines snap to horizontal / vertical within this angle
const ACCENT = '#4c7dff';

const state = {
  items: [],          // strokes and images; treated as immutable snapshots for undo
  undo: [],
  redo: [],
  view: { ox: 0, oy: 0, s: 1 }, // screen = world * s + o
  tool: 'pen',
  color: 'ink',
  size: 3,
  dark: false,
  invert: true,
  grid: 0.05, // grid line opacity: 0 (off), 0.05 or 0.1
  lines: 0,   // ruled lines opacity: 0 (off), 0.05 or 0.1 — only one of grid/lines is on
  smooth: 1,  // handwriting smoothing: 0 off, 1 low, 2 high
  learn: false,
  selection: new Set(),
  hover: null,        // last pointer position over the canvas, for the brush cursor
};

let W = 0, H = 0, dpr = 1, canvasTop = 0;
let action = null;
let spaceDown = false;
let ctrlDown = false;

// ---------- Helpers ----------
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const r2 = (v) => Math.round(v * 100) / 100;

function screenPos(e) {
  return [e.clientX, e.clientY - canvasTop];
}
function toWorld(sx, sy) {
  const v = state.view;
  return [(sx - v.ox) / v.s, (sy - v.oy) / v.s];
}
function toScreen(wx, wy) {
  const v = state.view;
  return [wx * v.s + v.ox, wy * v.s + v.oy];
}
function inkColor(c) {
  const pal = state.dark ? PALETTE.dark : PALETTE.light;
  return pal[c] || pal[LEGACY_COLORS[c]] || c;
}
function highlightColor(c) {
  return c === 'ink' ? HIGHLIGHT_INK[state.dark ? 'dark' : 'light'] : inkColor(c);
}
function widthAt(stroke, p) {
  return stroke.size * (0.25 + 0.95 * p);
}
function pressureOf(e) {
  return e.pointerType === 'pen' ? clamp(e.pressure || 0, 0, 1) : 0.5;
}
function itemBounds(it) {
  return it.type === 'image' ? [it.x, it.y, it.x + it.w, it.y + it.h] : it.bbox;
}
function unionBounds(list) {
  let b = null;
  for (const it of list) {
    const r = itemBounds(it);
    b = b ? [Math.min(b[0], r[0]), Math.min(b[1], r[1]), Math.max(b[2], r[2]), Math.max(b[3], r[3])] : r.slice();
  }
  return b;
}
function strokeBBox(st) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of st.pts) {
    if (x < x0) x0 = x; if (y < y0) y0 = y;
    if (x > x1) x1 = x; if (y > y1) y1 = y;
  }
  const pad = st.size;
  return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
}
function shiftItem(it, dx, dy) {
  if (it.type === 'image') return { ...it, x: it.x + dx, y: it.y + dy };
  const b = it.bbox;
  return {
    ...it,
    pts: it.pts.map(([x, y, p]) => [r2(x + dx), r2(y + dy), p]),
    bbox: [b[0] + dx, b[1] + dy, b[2] + dx, b[3] + dy],
  };
}
function selectionList() {
  if (!state.selection.size) return [];
  return state.items.filter((it) => state.selection.has(it));
}

// ---------- Image cache ----------
const imageCache = new Map();     // src -> HTMLImageElement
const invertedCache = new Map();  // src -> canvas with inverted colors

function getImage(src) {
  let img = imageCache.get(src);
  if (!img) {
    img = new Image();
    img.onload = () => { invalidateLayer(); requestRender(); };
    img.src = src;
    imageCache.set(src, img);
  }
  return img;
}
function getInverted(src) {
  let c = invertedCache.get(src);
  if (c) return c;
  const img = getImage(src);
  if (!img.complete || !img.naturalWidth) return null;
  c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const g = c.getContext('2d');
  g.filter = 'invert(1) hue-rotate(180deg)';
  g.drawImage(img, 0, 0);
  invertedCache.set(src, c);
  return c;
}

// ---------- Canvas sizing ----------
function resize() {
  canvasTop = toolbar.offsetHeight;
  dpr = window.devicePixelRatio || 1;
  W = window.innerWidth;
  H = window.innerHeight - canvasTop;
  for (const c of scenes) {
    c.style.top = canvasTop + 'px';
    c.style.width = W + 2 * MARGIN + 'px';
    c.style.height = H + 2 * MARGIN + 'px';
    c.width = Math.round((W + 2 * MARGIN) * dpr);
    c.height = Math.round((H + 2 * MARGIN) * dpr);
  }
  overlay.style.top = canvasTop + 'px';
  overlay.style.width = W + 'px';
  overlay.style.height = H + 'px';
  overlay.width = Math.round(W * dpr);
  overlay.height = Math.round(H * dpr);

  invalidateLayer();
  requestRender();
}

// ---------- Rendering ----------
// Finished content is painted into an offscreen layer and reused until something
// changes (items, view, theme). Live things (current stroke, cursor, lasso) draw on top.
let layerKey = null;

function invalidateLayer() {
  layerKey = null;
  sceneView = null;
}
function currentLayerKey(exclude) {
  const v = state.view;
  return [state.items, v.ox, v.oy, v.s, state.dark, state.invert, state.grid, W, H, dpr, exclude, state.lines];
}
function sameKey(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

let renderPending = false;
function requestRender() {
  if (!renderPending) {
    renderPending = true;
    requestAnimationFrame(render);
  }
}

function applyWorldTransform(g) {
  const { ox, oy, s } = state.view;
  g.setTransform(dpr * s, 0, 0, dpr * s, dpr * ox, dpr * oy);
}

// Paints the whole scene, or only a screen region [x0, y0, x1, y1] (css px)
function paintScene(g, exclude, region) {
  const R = region || [0, 0, W, H];
  g.save();
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (region) {
    g.beginPath();
    g.rect(R[0], R[1], R[2] - R[0], R[3] - R[1]);
    g.clip();
  }
  g.fillStyle = state.dark ? '#16171b' : '#ffffff';
  g.fillRect(R[0], R[1], R[2] - R[0], R[3] - R[1]);
  drawGrid(g);
  applyWorldTransform(g);
  const [vx0, vy0] = toWorld(R[0], R[1]);
  const [vx1, vy1] = toWorld(R[2], R[3]);
  drawItems(g, state.items, [vx0, vy0, vx1, vy1], exclude);
  g.restore();
}

// ----- Fast view changes -----
// The finished scene is painted onto a canvas a little larger than the window (MARGIN on
// every side). Panning and pinch-zooming just move/scale that canvas with a CSS transform,
// which the GPU compositor does for free. The scene is repainted only when you pan past
// the margin, when a zoom gesture settles, or shortly after the view stops moving.
const MARGIN = 256;
const ZOOM_SETTLE_MS = 150;
let lastZoomAt = 0;
let sceneView = null;      // view the scene canvas was painted at (null = repaint needed)
let sceneStatic = null;    // everything else the painted scene depends on
let recenterTimer = 0;
let lastSceneTransform = '';

function noteZooming() {
  lastZoomAt = performance.now();
}

function sceneStaticKey(exclude) {
  return [state.items, state.dark, state.invert, state.grid, state.lines, W, H, dpr, exclude];
}

function paintSceneCanvas(exclude, regions) {
  const view = state.view, w = W, h = H;
  state.view = { ox: view.ox + MARGIN, oy: view.oy + MARGIN, s: view.s };
  W = w + 2 * MARGIN;
  H = h + 2 * MARGIN;
  try {
    if (regions) for (const r of regions) paintScene(sctx, exclude, r);
    else paintScene(sctx, exclude);
  } finally {
    state.view = view;
    W = w;
    H = h;
  }
  sceneView = { ...view };
}

function applySceneTransform() {
  const v = state.view;
  const k = v.s / sceneView.s;
  let tx = v.ox - k * sceneView.ox - k * MARGIN;
  let ty = v.oy - k * sceneView.oy - k * MARGIN;
  if (k === 1) { tx = Math.round(tx * dpr) / dpr; ty = Math.round(ty * dpr) / dpr; }
  const t = k === 1 ? `translate(${tx}px, ${ty}px)` : `translate(${tx}px, ${ty}px) scale(${k})`;
  if (t !== lastSceneTransform) {
    sceneCanvas.style.transform = t;
    lastSceneTransform = t;
  }
}

let wantRecenter = false;

// Re-centres the scene on the current view at the same zoom: the visible pixels are copied
// to the back canvas and only the strips that were outside the old canvas get painted.
function recenterScene(exclude) {
  const v = state.view;
  const dx = Math.round((v.ox - sceneView.ox) * dpr), dy = Math.round((v.oy - sceneView.oy) * dpr);
  const back = 1 - front;
  const bctx = sceneCtxs[back];
  bctx.setTransform(1, 0, 0, 1, 0, 0);
  bctx.drawImage(scenes[front], dx, dy);
  scenes[back].style.transform = scenes[front].style.transform;
  front = back;
  sceneCanvas = scenes[front];
  sctx = sceneCtxs[front];
  const W2 = W + 2 * MARGIN, H2 = H + 2 * MARGIN, dxc = dx / dpr, dyc = dy / dpr;
  const regions = [];
  if (dxc > 0) regions.push([0, 0, dxc + 1, H2]);
  else if (dxc < 0) regions.push([W2 + dxc - 1, 0, W2, H2]);
  if (dyc > 0) regions.push([0, 0, W2, dyc + 1]);
  else if (dyc < 0) regions.push([0, H2 + dyc - 1, W2, H2]);
  sceneView = { ...v };
  paintSceneCanvas(exclude, regions);
  lastSceneTransform = '';
  scenes[front].classList.remove('back');
  scenes[1 - front].classList.add('back');
}

function updateScene(exclude) {
  const v = state.view;
  const key = sceneStaticKey(exclude);
  const zooming = performance.now() - lastZoomAt < ZOOM_SETTLE_MS;
  let repaint = !sceneView || !sameKey(key, sceneStatic);
  let recenter = false;
  if (!repaint) {
    const k = v.s / sceneView.s;
    if (k !== 1 && !zooming) repaint = true; // zoom finished: repaint sharp
    if (k === 1) {
      const far = Math.abs(v.ox - sceneView.ox) > MARGIN - 16 || Math.abs(v.oy - sceneView.oy) > MARGIN - 16;
      const offset = v.ox !== sceneView.ox || v.oy !== sceneView.oy;
      const tooFar = Math.abs(v.ox - sceneView.ox) > W || Math.abs(v.oy - sceneView.oy) > H;
      if (tooFar) repaint = true;
      else if (far || (wantRecenter && offset)) recenter = true;
    }
  }
  wantRecenter = false;
  if (repaint) {
    paintSceneCanvas(exclude);
    sceneStatic = key;
  } else if (recenter) {
    recenterScene(exclude);
  }
  applySceneTransform();
  // Once the view rests, re-centre the scene so the next pan starts with a full margin
  clearTimeout(recenterTimer);
  if (v.ox !== sceneView.ox || v.oy !== sceneView.oy || v.s !== sceneView.s) {
    recenterTimer = setTimeout(() => {
      wantRecenter = true;
      requestRender();
    }, zooming ? ZOOM_SETTLE_MS + 20 : 250);
  }
}

// Images at the bottom, then highlighter, then ink, so writing sits on top of everything.
function drawItems(g, items, view, exclude) {
  const visible = (b) => !view || !(b[0] > view[2] || b[1] > view[3] || b[2] < view[0] || b[3] < view[1]);
  for (const it of items) {
    if (it.type === 'image' && !(exclude && exclude.has(it)) && visible(itemBounds(it))) drawImageItem(g, it);
  }
  for (const it of items) {
    if (it.type === 'stroke' && it.hl && !(exclude && exclude.has(it)) && visible(it.bbox)) drawStroke(g, it);
  }
  const sc = state.view.s;
  for (const it of items) {
    if (it.type !== 'stroke' || it.hl || (exclude && exclude.has(it)) || !visible(it.bbox)) continue;
    const b = it.bbox;
    if (view && (b[2] - b[0]) * sc < 1.5 && (b[3] - b[1]) * sc < 1.5) {
      g.fillStyle = inkColor(it.color);
      g.fillRect(b[0], b[1], Math.max(b[2] - b[0], 1 / sc), Math.max(b[3] - b[1], 1 / sc));
      continue;
    }
    drawStroke(g, it);
  }
}

function render() {
  renderPending = false;
  updateToolbar();

  const v = state.view;
  v.ox = Math.round(v.ox * dpr) / dpr; // whole device pixels, so panning can reuse pixels
  v.oy = Math.round(v.oy * dpr) / dpr;
  const exclude = action && action.exclude ? action.exclude : crop ? crop.set : null;
  updateScene(exclude);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, overlay.width, overlay.height);

  // Live world-space content
  applyWorldTransform(ctx);
  if (action && action.kind === 'move') {
    ctx.save();
    ctx.translate(action.dx, action.dy);
    drawItems(ctx, [...action.exclude], null, null);
    ctx.restore();
  } else if (action && action.kind === 'resize') {
    drawImageItem(ctx, action.preview);
  } else if (action && action.kind === 'draw') {
    drawStroke(ctx, action.stroke);
  }
  if (crop) drawCropWorld();

  // Screen-space overlays
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (action && action.kind === 'lasso') drawLasso(action.pts);
  if (crop) drawCropHandles();
  else drawSelection();
  drawBrushCursor();
  updateSelbar();
  updateFindButton();
}

// Grid (squares) or ruled lines (horizontal only). Drawn in device pixels from a fixed
// origin, so a strip painted while panning lines up exactly with the shifted pixels.
function drawGrid(g) {
  const level = state.grid || state.lines;
  if (!level) return;
  const { ox, oy, s } = state.view;
  let step = (state.grid ? 32 : 40) * s;
  while (step < 14) step *= 4;
  while (step > 160) step /= 4;
  const sd = step * dpr, oxd = Math.round(ox * dpr), oyd = Math.round(oy * dpr);
  const cw = sceneCanvas.width, ch = sceneCanvas.height;
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.strokeStyle = state.dark ? `rgba(255,255,255,${level})` : `rgba(0,0,0,${level})`;
  g.lineWidth = Math.max(1, Math.round(dpr));
  const half = g.lineWidth % 2 ? 0.5 : 0;
  g.beginPath();
  if (state.grid) {
    for (let j = Math.ceil(-oxd / sd) - 1; ; j++) {
      const x = oxd + Math.round(j * sd);
      if (x > cw) break;
      g.moveTo(x + half, 0);
      g.lineTo(x + half, ch);
    }
  }
  for (let j = Math.ceil(-oyd / sd) - 1; ; j++) {
    const y = oyd + Math.round(j * sd);
    if (y > ch) break;
    g.moveTo(0, y + half);
    g.lineTo(cw, y + half);
  }
  g.stroke();
  g.restore();
}

function drawImageItem(g, it) {
  const src = state.dark && state.invert ? getInverted(it.src) : getImage(it.src);
  if (!src || (src instanceof HTMLImageElement && (!src.complete || !src.naturalWidth))) return;
  const nw = src.naturalWidth || src.width, nh = src.naturalHeight || src.height;
  const c = it.crop || [0, 0, 1, 1]; // visible part of the picture, as fractions
  g.save();
  if (it.opacity != null && it.opacity < 1) g.globalAlpha *= it.opacity;
  g.drawImage(src, c[0] * nw, c[1] * nh, c[2] * nw, c[3] * nh, it.x, it.y, it.w, it.h);
  g.restore();
}

// ---------- Image crop mode ----------
let crop = null; // { item, set, full: {x,y,w,h}, r: {x0,y0,x1,y1} } in world units

function startCrop() {
  const img = singleSelectedImage();
  if (!img || action) return;
  const c = img.crop || [0, 0, 1, 1];
  const fw = img.w / c[2], fh = img.h / c[3];
  crop = {
    item: img,
    set: new Set([img]),
    full: { x: img.x - c[0] * fw, y: img.y - c[1] * fh, w: fw, h: fh },
    r: { x0: img.x, y0: img.y, x1: img.x + img.w, y1: img.y + img.h },
  };
  flashHint('Drag the edges to crop · Enter to finish');
  requestRender();
}

function finishCrop(commit) {
  if (!crop) return;
  const { item, full, r } = crop;
  crop = null;
  const changedCrop = Math.abs(r.x0 - item.x) + Math.abs(r.y0 - item.y) +
    Math.abs(r.x1 - item.x - item.w) + Math.abs(r.y1 - item.y - item.h) > 1e-6;
  if (commit && changedCrop && state.items.includes(item)) {
    const out = {
      ...item,
      x: r.x0, y: r.y0, w: r.x1 - r.x0, h: r.y1 - r.y0,
      crop: [(r.x0 - full.x) / full.w, (r.y0 - full.y) / full.h, (r.x1 - r.x0) / full.w, (r.y1 - r.y0) / full.h],
    };
    pushUndo();
    state.items = state.items.map((it) => (it === item ? out : it));
    state.selection = new Set([out]);
    changed();
  }
  requestRender();
}

function cropHandles() {
  const r = crop.r;
  const [x0, y0] = toScreen(r.x0, r.y0);
  const [x1, y1] = toScreen(r.x1, r.y1);
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  return { nw: [x0, y0], n: [mx, y0], ne: [x1, y0], e: [x1, my], se: [x1, y1], s: [mx, y1], sw: [x0, y1], w: [x0, my] };
}
function hitCropHandle(sx, sy) {
  const hs = cropHandles();
  for (const k in hs) if (Math.abs(sx - hs[k][0]) <= 10 && Math.abs(sy - hs[k][1]) <= 10) return k;
  const [x0, y0] = toScreen(crop.r.x0, crop.r.y0);
  const [x1, y1] = toScreen(crop.r.x1, crop.r.y1);
  if (sx > x0 && sx < x1 && sy > y0 && sy < y1) return 'move';
  return null;
}
const CROP_CURSORS = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', move: 'move' };

function drawCropWorld() {
  const { item, full, r } = crop;
  // whole picture faded, the kept part on top at full strength
  drawImageItem(ctx, { ...item, crop: [0, 0, 1, 1], x: full.x, y: full.y, w: full.w, h: full.h, opacity: 0.25 });
  drawImageItem(ctx, {
    ...item, x: r.x0, y: r.y0, w: r.x1 - r.x0, h: r.y1 - r.y0,
    crop: [(r.x0 - full.x) / full.w, (r.y0 - full.y) / full.h, (r.x1 - r.x0) / full.w, (r.y1 - r.y0) / full.h],
  });
}
function drawCropHandles() {
  const [x0, y0] = toScreen(crop.r.x0, crop.r.y0);
  const [x1, y1] = toScreen(crop.r.x1, crop.r.y1);
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 2;
  ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
  ctx.fillStyle = '#fff';
  for (const [hx, hy] of Object.values(cropHandles())) {
    ctx.beginPath();
    ctx.rect(hx - 5, hy - 5, 10, 10);
    ctx.fill();
    ctx.stroke();
  }
}

// ---------- Image opacity ----------
const OPACITY_STEPS = [1, 0.6, 0.3];
function cycleImageOpacity() {
  const img = singleSelectedImage();
  if (!img) return;
  const cur = img.opacity == null ? 1 : img.opacity;
  const i = OPACITY_STEPS.findIndex((o) => Math.abs(o - cur) < 0.01);
  const next = OPACITY_STEPS[(i + 1) % OPACITY_STEPS.length];
  const out = { ...img, opacity: next };
  pushUndo();
  state.items = state.items.map((it) => (it === img ? out : it));
  state.selection = new Set([out]);
  changed();
  flashHint('Image opacity ' + Math.round(next * 100) + '%');
}

// Every stroke is turned into one Path2D once and cached, so painting a stroke is a
// single fill()/stroke() call. The cache is keyed by the stroke object and its point
// array, so a stroke that is still being drawn rebuilds as it grows.
const pathCache = new WeakMap();
function strokePath(st) {
  const hit = pathCache.get(st);
  if (hit && hit.pts === st.pts && hit.n === st.pts.length) return hit.path;
  const p = st.hl || st.sharp ? centerlinePath(st) : outlinePath(st);
  pathCache.set(st, { pts: st.pts, n: st.pts.length, path: p });
  return p;
}

// Smoothed centre line (highlighter, shapes): drawn with stroke() at constant width
function centerlinePath(st) {
  const pts = st.pts;
  const p = new Path2D();
  p.moveTo(pts[0][0], pts[0][1]);
  if (pts.length === 1) { p.lineTo(pts[0][0] + 0.01, pts[0][1]); return p; }
  if (st.sharp) {
    for (let i = 1; i < pts.length; i++) p.lineTo(pts[i][0], pts[i][1]);
    return p;
  }
  for (let i = 1; i < pts.length - 1; i++) {
    p.quadraticCurveTo(pts[i][0], pts[i][1], (pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2);
  }
  p.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
  return p;
}

// Pressure ink: the smoothed centre line is sampled, offset left/right by half the
// width at each sample, and closed with round caps — one filled shape per stroke.
function outlinePath(st) {
  const pts = st.pts;
  const p = new Path2D();
  if (pts.length === 1) {
    p.arc(pts[0][0], pts[0][1], widthAt(st, pts[0][2]) / 2, 0, Math.PI * 2);
    return p;
  }
  // 1. sample the same midpoint-quadratic curve the old renderer drew
  const xs = [], ys = [], ws = [];
  const push = (x, y, w) => {
    const n = xs.length;
    if (n && Math.abs(x - xs[n - 1]) < 1e-4 && Math.abs(y - ys[n - 1]) < 1e-4) return;
    xs.push(x); ys.push(y); ws.push(w);
  };
  let px = pts[0][0], py = pts[0][1], pw = widthAt(st, pts[0][2]);
  push(px, py, pw);
  const unit = Math.max(st.size, 0.5);
  for (let i = 1; i < pts.length; i++) {
    const q = pts[i], w = widthAt(st, q[2]);
    if (i < pts.length - 1) {
      const ex = (q[0] + pts[i + 1][0]) / 2, ey = (q[1] + pts[i + 1][1]) / 2;
      const len = Math.hypot(q[0] - px, q[1] - py) + Math.hypot(ex - q[0], ey - q[1]);
      const steps = Math.min(6, Math.max(1, Math.ceil(len / (unit * 1.5))));
      for (let k = 1; k <= steps; k++) {
        const t = k / steps, u = 1 - t;
        push(u * u * px + 2 * u * t * q[0] + t * t * ex, u * u * py + 2 * u * t * q[1] + t * t * ey, pw + (w - pw) * t);
      }
      px = ex; py = ey; pw = w;
    } else {
      push(q[0], q[1], w);
    }
  }
  const n = xs.length;
  if (n === 1) {
    p.arc(xs[0], ys[0], ws[0] / 2, 0, Math.PI * 2);
    return p;
  }
  // 2. left/right offsets using the bisector of neighbouring segment normals (miter capped)
  const lx = new Float64Array(n), ly = new Float64Array(n), rx = new Float64Array(n), ry = new Float64Array(n);
  const nx = new Float64Array(n), ny = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let ax = 0, ay = 0, bx = 0, by = 0;
    if (i > 0) { const dx = xs[i] - xs[i - 1], dy = ys[i] - ys[i - 1], d = Math.hypot(dx, dy) || 1; ax = -dy / d; ay = dx / d; }
    if (i < n - 1) { const dx = xs[i + 1] - xs[i], dy = ys[i + 1] - ys[i], d = Math.hypot(dx, dy) || 1; bx = -dy / d; by = dx / d; }
    if (i === 0) { ax = bx; ay = by; }
    if (i === n - 1) { bx = ax; by = ay; }
    let mx = ax + bx, my = ay + by;
    const ml = Math.hypot(mx, my);
    if (ml < 1e-6) { mx = ax; my = ay; } else { mx /= ml; my /= ml; }
    const scale = 1 / Math.max(0.5, mx * ax + my * ay); // miter limit 2
    const h = (ws[i] / 2) * scale;
    nx[i] = mx; ny[i] = my;
    lx[i] = xs[i] + mx * h; ly[i] = ys[i] + my * h;
    rx[i] = xs[i] - mx * h; ry[i] = ys[i] - my * h;
  }
  // 3. left side forward, round cap, right side back, round cap
  p.moveTo(lx[0], ly[0]);
  for (let i = 1; i < n; i++) p.lineTo(lx[i], ly[i]);
  const ae = Math.atan2(ny[n - 1], nx[n - 1]);
  p.arc(xs[n - 1], ys[n - 1], ws[n - 1] / 2, ae, ae - Math.PI, true);
  for (let i = n - 1; i >= 0; i--) p.lineTo(rx[i], ry[i]);
  const as = Math.atan2(ny[0], nx[0]);
  p.arc(xs[0], ys[0], ws[0] / 2, as + Math.PI, as, true);
  p.closePath();
  return p;
}

function drawStroke(g, st) {
  if (st.hl) {
    // Highlighter: constant width, one stroke so overlaps don't get darker
    g.save();
    g.globalAlpha = state.dark ? 0.3 : 0.35;
    g.strokeStyle = highlightColor(st.color);
    g.lineWidth = st.size;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.stroke(strokePath(st));
    g.restore();
    return;
  }
  const color = inkColor(st.color);
  if (st.sharp && st.pts.length > 1) {
    g.strokeStyle = color;
    g.lineWidth = widthAt(st, st.pts[0][2]);
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.stroke(strokePath(st));
    return;
  }
  g.fillStyle = color;
  g.fill(strokePath(st));
}

function drawLasso(pts) {
  if (pts.length < 2) return;
  ctx.beginPath();
  pts.forEach(([wx, wy], i) => {
    const [x, y] = toScreen(wx, wy);
    if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
  });
  ctx.closePath();
  ctx.fillStyle = 'rgba(76,125,255,0.08)';
  ctx.fill();
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 4]);
  ctx.stroke();
  ctx.setLineDash([]);
}

function selectionScreenRect(list) {
  const b = unionBounds(list);
  if (!b) return null;
  let [x0, y0] = toScreen(b[0], b[1]);
  let [x1, y1] = toScreen(b[2], b[3]);
  if (action && action.kind === 'move') {
    const s = state.view.s;
    x0 += action.dx * s; x1 += action.dx * s;
    y0 += action.dy * s; y1 += action.dy * s;
  }
  return [x0 - 4, y0 - 4, x1 + 4, y1 + 4];
}

function drawSelection() {
  let list = selectionList();
  if (action && action.kind === 'resize') list = [action.preview];
  if (!list.length) return;
  const r = selectionScreenRect(list);
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 4]);
  ctx.strokeRect(r[0], r[1], r[2] - r[0], r[3] - r[1]);
  ctx.setLineDash([]);
  if (list.length === 1 && list[0].type === 'image') {
    const [hx, hy] = toScreen(list[0].x + list[0].w, list[0].y + list[0].h);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(hx, hy, HANDLE / 2 + 1, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}

function drawBrushCursor() {
  const h = state.hover;
  if (!h || spaceDown || ctrlDown || (action && action.kind !== 'draw' && action.kind !== 'erase')) return;
  const tool = action && action.kind === 'erase' ? 'eraser' : state.tool;
  const [x, y] = h;
  if (tool === 'eraser') {
    ctx.beginPath();
    ctx.arc(x, y, ERASER_R, 0, Math.PI * 2);
    ctx.fillStyle = state.dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)';
    ctx.fill();
    ctx.strokeStyle = state.dark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.45)';
    ctx.lineWidth = 1;
    ctx.stroke();
  } else if (tool === 'pen' && !action) {
    const r = Math.max(1.5, (state.size * (0.25 + 0.95 * 0.5)) / 2);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = inkColor(state.color);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, r + 2.5, 0, Math.PI * 2);
    ctx.strokeStyle = state.dark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 1;
    ctx.stroke();
  } else if (tool === 'highlighter' && !action) {
    const r = highlighterSize() / 2;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.globalAlpha = 0.45;
    ctx.fillStyle = highlightColor(state.color);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}

// ---------- Undo / redo ----------
function pushUndo() {
  state.undo.push(state.items);
  if (state.undo.length > 300) state.undo.shift();
  state.redo = [];
}
function undo() {
  finishCrop(false);
  if (action || !state.undo.length) return;
  state.redo.push(state.items);
  state.items = state.undo.pop();
  changed();
}
function redo() {
  if (action || !state.redo.length) return;
  state.undo.push(state.items);
  state.items = state.redo.pop();
  changed();
}
function changed() {
  requestRender();
  scheduleSave();
}

// ---------- Hit testing ----------
function hitItem(wx, wy) {
  const r = 6 / state.view.s;
  for (let i = state.items.length - 1; i >= 0; i--) {
    const it = state.items[i];
    if (it.type !== 'stroke') continue;
    const b = it.bbox;
    if (wx < b[0] - r || wx > b[2] + r || wy < b[1] - r || wy > b[3] + r) continue;
    if (strokeHit(it, wx, wy, r + it.size / 2)) return it;
  }
  for (let i = state.items.length - 1; i >= 0; i--) {
    const it = state.items[i];
    if (it.type === 'image' && wx >= it.x && wx <= it.x + it.w && wy >= it.y && wy <= it.y + it.h) return it;
  }
  return null;
}
function hitHandle(sx, sy, img) {
  const [hx, hy] = toScreen(img.x + img.w, img.y + img.h);
  return Math.abs(sx - hx) <= HANDLE && Math.abs(sy - hy) <= HANDLE;
}
function singleSelectedImage() {
  const list = selectionList();
  return list.length === 1 && list[0].type === 'image' ? list[0] : null;
}
function insideSelection(sx, sy) {
  const list = selectionList();
  if (!list.length) return false;
  const r = selectionScreenRect(list);
  return sx >= r[0] && sx <= r[2] && sy >= r[1] && sy <= r[3];
}
function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len = dx * dx + dy * dy;
  let t = len ? ((px - ax) * dx + (py - ay) * dy) / len : 0;
  t = clamp(t, 0, 1);
  const cx = ax + t * dx - px, cy = ay + t * dy - py;
  return Math.sqrt(cx * cx + cy * cy);
}
function strokeHit(st, x, y, r) {
  const p = st.pts;
  if (p.length === 1) return Math.hypot(p[0][0] - x, p[0][1] - y) <= r;
  for (let i = 1; i < p.length; i++) {
    if (distToSegment(x, y, p[i - 1][0], p[i - 1][1], p[i][0], p[i][1]) <= r) return true;
  }
  return false;
}
function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function eraseAt(x, y) {
  const r = ERASER_R / state.view.s;
  let hit = false;
  const next = state.items.filter((it) => {
    if (it.type !== 'stroke') return true;
    const b = it.bbox;
    if (x < b[0] - r || x > b[2] + r || y < b[1] - r || y > b[3] + r) return true;
    if (strokeHit(it, x, y, r + it.size / 2)) {
      hit = true;
      return false;
    }
    return true;
  });
  if (hit) {
    state.items = next;
    requestRender();
  }
}

// ---------- Pointer input ----------
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('dblclick', () => { if (!crop && singleSelectedImage()) startCrop(); });

function highlighterSize() {
  return state.size * 5;
}

canvas.addEventListener('pointerdown', (e) => {
  if (action) return;
  closePopovers();
  canvas.setPointerCapture(e.pointerId);
  const [sx, sy] = screenPos(e);
  const [wx, wy] = toWorld(sx, sy);
  const eraserButton = (e.buttons & 32) || e.button === 5 || e.button === 2;

  if (e.button === 1 || spaceDown || state.tool === 'pan') {
    action = { kind: 'pan', lx: e.clientX, ly: e.clientY };
    canvas.style.cursor = 'grabbing';
    return;
  }

  if (crop) {
    const handle = hitCropHandle(sx, sy);
    if (handle) action = { kind: 'crop', handle, start: [wx, wy], r0: { ...crop.r } };
    else finishCrop(true); // click outside the image: done
    requestRender();
    return;
  }

  if (state.tool === 'select' || e.ctrlKey) {
    pointerDownSelect(e, sx, sy, wx, wy);
    requestRender();
    return;
  }

  if (eraserButton || state.tool === 'eraser') {
    action = { kind: 'erase', before: state.items };
    eraseAt(wx, wy);
    return;
  }

  if (e.button !== 0) return;
  const hl = state.tool === 'highlighter';
  const p = pressureOf(e);
  action = {
    kind: 'draw',
    lastP: p,
    straight: e.shiftKey,
    anchor: [sx, sy],
    holdTimer: null,
    sm: [wx, wy],   // smoothed pen position (stabilizer)
    raw: [wx, wy],  // latest unsmoothed position
    stroke: {
      type: 'stroke',
      color: state.color,
      // size in world units keeps the same on-screen thickness at any zoom
      size: (hl ? highlighterSize() : state.size) / state.view.s,
      pts: [[r2(wx), r2(wy), hl ? 0.5 : p]],
      ...(hl ? { hl: true } : {}),
    },
  };
  if (action.straight) action.stroke.pts.push([r2(wx), r2(wy), action.stroke.pts[0][2]]);
  armHoldTimer();
  requestRender();
});

function pointerDownSelect(e, sx, sy, wx, wy) {
  const img = singleSelectedImage();
  if (img && hitHandle(sx, sy, img)) {
    action = {
      kind: 'resize', img, preview: { ...img }, exclude: new Set([img]),
      startX: wx, orig: { w: img.w, h: img.h }, moved: false,
    };
    return;
  }
  if (!e.shiftKey && insideSelection(sx, sy)) {
    beginMove(wx, wy);
    return;
  }
  const hit = hitItem(wx, wy);
  if (hit) {
    if (e.shiftKey) {
      const sel = new Set(state.selection);
      if (sel.has(hit)) sel.delete(hit); else sel.add(hit);
      state.selection = sel;
    } else {
      state.selection = new Set([hit]);
    }
    if (state.selection.size) beginMove(wx, wy);
    return;
  }
  if (!e.shiftKey) state.selection = new Set();
  action = { kind: 'lasso', pts: [[wx, wy]], add: e.shiftKey };
}

function beginMove(wx, wy) {
  const list = selectionList();
  if (!list.length) return;
  action = { kind: 'move', exclude: new Set(list), startX: wx, startY: wy, dx: 0, dy: 0 };
}

// Hold the pen still for a moment while drawing → the stroke becomes a straight line
function armHoldTimer() {
  if (!action || action.kind !== 'draw') return;
  clearTimeout(action.holdTimer);
  const a = action;
  a.holdTimer = setTimeout(() => {
    if (action !== a || a.straight || a.shaped) return;
    const pts = a.stroke.pts;
    const avgP = pts.reduce((sum, p) => sum + p[2], 0) / pts.length;
    // A closed loop becomes a clean circle, ellipse, triangle or rectangle
    const shape = recognizeShape(pts);
    if (shape) {
      a.shaped = true;
      a.stroke.pts = shape.pts.map(([x, y]) => [r2(x), r2(y), avgP]);
      a.stroke.sharp = true;
      flashHint(shape.name);
      requestRender();
      return;
    }
    // An open stroke becomes a straight line (keeps following the pen)
    const first = pts[0], last = pts[pts.length - 1];
    const [fx, fy] = toScreen(first[0], first[1]);
    const [lx, ly] = toScreen(last[0], last[1]);
    if (Math.hypot(lx - fx, ly - fy) < 24) return; // too short to be a line
    a.straight = true;
    a.stroke.pts = [[first[0], first[1], avgP], [last[0], last[1], avgP]];
    snapLine(a.stroke.pts);
    requestRender();
  }, HOLD_MS);
}

// ----- Shape recognition -----
// Ramer–Douglas–Peucker: keeps only the points that matter for the outline
function simplifyPath(pts, eps) {
  if (pts.length < 3) return pts.slice();
  let maxD = 0, idx = 0;
  const a = pts[0], b = pts[pts.length - 1];
  for (let i = 1; i < pts.length - 1; i++) {
    const d = distToSegment(pts[i][0], pts[i][1], a[0], a[1], b[0], b[1]);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD <= eps) return [a, b];
  const left = simplifyPath(pts.slice(0, idx + 1), eps);
  const right = simplifyPath(pts.slice(idx), eps);
  return left.slice(0, -1).concat(right);
}

function recognizeShape(raw) {
  const pts = raw.map((p) => [p[0], p[1]]);
  const sc = state.view.s;
  let len = 0;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    const [x, y] = pts[i];
    if (i) len += Math.hypot(x - pts[i - 1][0], y - pts[i - 1][1]);
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  const w = x1 - x0, h = y1 - y0, diag = Math.hypot(w, h);
  if (len * sc < 80 || diag * sc < 30 || pts.length < 8) return null;
  const first = pts[0], last = pts[pts.length - 1];
  if (Math.hypot(last[0] - first[0], last[1] - first[1]) > Math.max(0.22 * diag, 14 / sc)) return null; // not closed

  // Polygon? Simplify the loop (with the start point repeated at the end) and count corners
  const loop = pts.concat([first]);
  let corners = simplifyPath(loop, 0.07 * diag).slice(0, -1);
  // merge corners that sit almost on top of each other
  corners = corners.filter((c, i) => {
    const n = corners[(i + 1) % corners.length];
    return Math.hypot(n[0] - c[0], n[1] - c[1]) > 0.12 * diag;
  });
  if (corners.length === 3 || corners.length === 4) {
    let dev = 0;
    for (const [x, y] of pts) {
      let best = Infinity;
      for (let i = 0; i < corners.length; i++) {
        const a = corners[i], b = corners[(i + 1) % corners.length];
        best = Math.min(best, distToSegment(x, y, a[0], a[1], b[0], b[1]));
      }
      dev += best;
    }
    if (dev / pts.length < 0.045 * diag) {
      if (corners.length === 4) {
        // nearly axis-aligned sides → a neat rectangle
        const aligned = corners.every((c, i) => {
          const n = corners[(i + 1) % 4];
          const ang = Math.abs((Math.atan2(n[1] - c[1], n[0] - c[0]) * 180) / Math.PI) % 90;
          return ang < 12 || ang > 78;
        });
        if (aligned) {
          const xs = corners.map((c) => c[0]), ys = corners.map((c) => c[1]);
          const l = (Math.min(...xs) + Math.min(...xs.filter((x) => x !== Math.min(...xs)))) / 2;
          const r = (Math.max(...xs) + Math.max(...xs.filter((x) => x !== Math.max(...xs)))) / 2;
          const t = (Math.min(...ys) + Math.min(...ys.filter((y) => y !== Math.min(...ys)))) / 2;
          const b = (Math.max(...ys) + Math.max(...ys.filter((y) => y !== Math.max(...ys)))) / 2;
          const sq = Math.abs((r - l) - (b - t)) < 0.1 * Math.max(r - l, b - t);
          if (sq) {
            const side = ((r - l) + (b - t)) / 2, cx = (l + r) / 2, cy = (t + b) / 2;
            return { name: 'Square', pts: closedPoly([[cx - side / 2, cy - side / 2], [cx + side / 2, cy - side / 2], [cx + side / 2, cy + side / 2], [cx - side / 2, cy + side / 2]]) };
          }
          return { name: 'Rectangle', pts: closedPoly([[l, t], [r, t], [r, b], [l, b]]) };
        }
        return { name: 'Quadrilateral', pts: closedPoly(corners) };
      }
      // triangle: make a nearly flat side exactly horizontal
      const tri = corners.map((c) => c.slice());
      for (let i = 0; i < 3; i++) {
        const a = tri[i], b = tri[(i + 1) % 3];
        const ang = Math.abs((Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI);
        if (ang < SNAP_DEG || ang > 180 - SNAP_DEG) { const y = (a[1] + b[1]) / 2; a[1] = y; b[1] = y; break; }
      }
      return { name: 'Triangle', pts: closedPoly(tri) };
    }
  }

  // Ellipse / circle: points should sit close to the ellipse that fits the bounding box
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = w / 2, ry = h / 2;
  if (rx > 0 && ry > 0) {
    let dev = 0;
    for (const [x, y] of pts) dev += Math.abs(Math.hypot((x - cx) / rx, (y - cy) / ry) - 1);
    if (dev / pts.length < 0.13) {
      const circle = Math.abs(rx - ry) < 0.15 * Math.max(rx, ry);
      const ex = circle ? (rx + ry) / 2 : rx, ey = circle ? (rx + ry) / 2 : ry;
      const out = [];
      for (let i = 0; i <= 72; i++) {
        const t = (i / 72) * Math.PI * 2;
        out.push([cx + ex * Math.cos(t), cy + ey * Math.sin(t)]);
      }
      return { name: circle ? 'Circle' : 'Ellipse', pts: out };
    }
  }
  return null;
}

function closedPoly(corners) {
  return corners.concat([corners[0]]);
}

// Snap a straight line to horizontal or vertical when it's close
function snapLine(pts) {
  const [a, b] = pts;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const ang = Math.abs((Math.atan2(dy, dx) * 180) / Math.PI);
  if (ang < SNAP_DEG || ang > 180 - SNAP_DEG) b[1] = a[1];
  else if (Math.abs(ang - 90) < SNAP_DEG) b[0] = a[0];
}

canvas.addEventListener('pointermove', (e) => {
  const [sx, sy] = screenPos(e);
  state.hover = [sx, sy];
  ctrlDown = e.ctrlKey;
  if (!action) {
    updateCursor(sx, sy);
    requestRender();
    return;
  }
  const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
  const samples = events.length ? events : [e];

  switch (action.kind) {
    case 'pan': {
      state.view.ox += e.clientX - action.lx;
      state.view.oy += e.clientY - action.ly;
      action.lx = e.clientX;
      action.ly = e.clientY;
      requestRender();
      break;
    }
    case 'draw': {
      const st = action.stroke;
      const pts = st.pts;
      if (action.shaped) break;
      if (action.straight) {
        const [wx, wy] = toWorld(sx, sy);
        pts[1] = [r2(wx), r2(wy), pts[0][2]];
        snapLine(pts);
        requestRender();
        break;
      }
      const minDist = 0.6 / state.view.s;
      const follow = SMOOTH_FOLLOW[state.smooth] || 1;
      for (const ce of samples) {
        let [wx, wy] = toWorld(...screenPos(ce));
        action.raw = [wx, wy];
        if (follow < 1) {
          // stabilizer: the ink trails the pen slightly, which irons out shaky lines
          action.sm[0] += (wx - action.sm[0]) * follow;
          action.sm[1] += (wy - action.sm[1]) * follow;
          [wx, wy] = action.sm;
        }
        const last = pts[pts.length - 1];
        if (Math.hypot(wx - last[0], wy - last[1]) < minDist) continue;
        let p = 0.5;
        if (!st.hl) {
          // light smoothing of pressure to avoid jagged width changes
          p = action.lastP * 0.5 + pressureOf(ce) * 0.5;
          action.lastP = p;
        }
        pts.push([r2(wx), r2(wy), Math.round(p * 1000) / 1000]);
      }
      // restart the "hold still" timer only on real movement, not pen jitter
      if (Math.hypot(sx - action.anchor[0], sy - action.anchor[1]) > 4) {
        action.anchor = [sx, sy];
        armHoldTimer();
      }
      requestRender();
      break;
    }
    case 'erase': {
      for (const ce of samples) eraseAt(...toWorld(...screenPos(ce)));
      requestRender();
      break;
    }
    case 'move': {
      const [wx, wy] = toWorld(sx, sy);
      action.dx = wx - action.startX;
      action.dy = wy - action.startY;
      requestRender();
      break;
    }
    case 'resize': {
      const [wx] = toWorld(sx, sy);
      const o = action.orig;
      const w = Math.max(16 / state.view.s, o.w + (wx - action.startX));
      action.preview.w = w;
      action.preview.h = (w * o.h) / o.w;
      action.moved = true;
      requestRender();
      break;
    }
    case 'lasso': {
      const [wx, wy] = toWorld(sx, sy);
      action.pts.push([wx, wy]);
      requestRender();
      break;
    }
    case 'crop': {
      if (!crop) break;
      const [wx, wy] = toWorld(sx, sy);
      const dx = wx - action.start[0], dy = wy - action.start[1];
      const r = { ...action.r0 }, f = crop.full, min = 12 / state.view.s, hnd = action.handle;
      if (hnd === 'move') {
        // slide the crop window over the picture
        const w = r.x1 - r.x0, h = r.y1 - r.y0;
        r.x0 = clamp(r.x0 + dx, f.x, f.x + f.w - w);
        r.y0 = clamp(r.y0 + dy, f.y, f.y + f.h - h);
        r.x1 = r.x0 + w;
        r.y1 = r.y0 + h;
      } else {
        if (hnd.includes('w')) r.x0 = clamp(r.x0 + dx, f.x, r.x1 - min);
        if (hnd.includes('e')) r.x1 = clamp(r.x1 + dx, r.x0 + min, f.x + f.w);
        if (hnd.includes('n')) r.y0 = clamp(r.y0 + dy, f.y, r.y1 - min);
        if (hnd.includes('s')) r.y1 = clamp(r.y1 + dy, r.y0 + min, f.y + f.h);
      }
      crop.r = r;
      requestRender();
      break;
    }
  }
});

canvas.addEventListener('pointerleave', () => {
  state.hover = null;
  requestRender();
});

function endAction() {
  if (!action) return;
  const a = action;
  action = null;
  switch (a.kind) {
    case 'pan':
      scheduleSave();
      break;
    case 'draw': {
      clearTimeout(a.holdTimer);
      const st = a.stroke;
      if (!a.straight && !a.shaped && state.smooth) {
        // let the smoothed line catch up to where the pen actually lifted
        const last = st.pts[st.pts.length - 1];
        if (Math.hypot(a.raw[0] - last[0], a.raw[1] - last[1]) > 0.6 / state.view.s) {
          st.pts.push([r2(a.raw[0]), r2(a.raw[1]), last[2]]);
        }
      }
      st.bbox = strokeBBox(st);
      pushUndo();
      state.items = [...state.items, st];
      changed();
      hideHint();
      break;
    }
    case 'erase':
      if (state.items !== a.before) {
        state.undo.push(a.before);
        state.redo = [];
        changed();
      }
      break;
    case 'move': {
      const s = state.view.s;
      if (Math.abs(a.dx * s) < 1 && Math.abs(a.dy * s) < 1) break; // just a click
      pushUndo();
      const moved = new Set();
      state.items = state.items.map((it) => {
        if (!a.exclude.has(it)) return it;
        const c = shiftItem(it, a.dx, a.dy);
        moved.add(c);
        return c;
      });
      state.selection = moved;
      changed();
      break;
    }
    case 'resize':
      if (a.moved) {
        pushUndo();
        state.items = state.items.map((it) => (it === a.img ? a.preview : it));
        state.selection = new Set([a.preview]);
        changed();
      }
      break;
    case 'lasso':
      finishLasso(a);
      break;
  }
  if (state.hover) updateCursor(...state.hover);
  requestRender();
}
canvas.addEventListener('pointerup', endAction);
canvas.addEventListener('pointercancel', endAction);

function finishLasso(a) {
  const poly = a.pts;
  if (poly.length < 3) return;
  const sel = a.add ? new Set(state.selection) : new Set();
  for (const it of state.items) {
    if (it.type === 'image') {
      if (pointInPolygon(it.x + it.w / 2, it.y + it.h / 2, poly)) sel.add(it);
    } else {
      // a stroke is selected when most of its points are inside the lasso
      const step = Math.max(1, Math.floor(it.pts.length / 40));
      let inside = 0, total = 0;
      for (let i = 0; i < it.pts.length; i += step) {
        total++;
        if (pointInPolygon(it.pts[i][0], it.pts[i][1], poly)) inside++;
      }
      if (inside / total >= 0.5) sel.add(it);
    }
  }
  state.selection = sel;
}

function updateCursor(sx, sy) {
  if (crop && !spaceDown) {
    canvas.style.cursor = CROP_CURSORS[hitCropHandle(sx, sy)] || 'default';
    return;
  }
  if (spaceDown || state.tool === 'pan') {
    canvas.style.cursor = 'grab';
  } else if (state.tool === 'select' || ctrlDown) {
    const img = singleSelectedImage();
    if (img && hitHandle(sx, sy, img)) canvas.style.cursor = 'nwse-resize';
    else if (insideSelection(sx, sy) || hitItem(...toWorld(sx, sy))) canvas.style.cursor = 'move';
    else canvas.style.cursor = 'crosshair';
  } else {
    canvas.style.cursor = 'none'; // the brush cursor is drawn on the canvas
  }
}

// ---------- Zoom & pan ----------
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const v = state.view;
  const unit = e.deltaMode === 1 ? 16 : 1;
  if (e.ctrlKey) {
    // trackpad pinch arrives as ctrl+wheel
    const [sx, sy] = screenPos(e);
    zoomAt(sx, sy, Math.exp(-clamp(e.deltaY * unit, -50, 50) * 0.01));
  } else {
    let dx = e.deltaX * unit, dy = e.deltaY * unit;
    if (e.shiftKey && !dx) { dx = dy; dy = 0; }
    v.ox -= dx;
    v.oy -= dy;
    requestRender();
    scheduleSave();
  }
}, { passive: false });

function zoomAt(sx, sy, factor) {
  noteZooming();
  const v = state.view;
  const ns = clamp(v.s * factor, MIN_SCALE, MAX_SCALE);
  const k = ns / v.s;
  v.ox = sx - (sx - v.ox) * k;
  v.oy = sy - (sy - v.oy) * k;
  v.s = ns;
  requestRender();
  scheduleSave();
}

function resetView() {
  const [cx, cy] = toWorld(W / 2, H / 2);
  state.view.s = 1;
  state.view.ox = W / 2 - cx;
  state.view.oy = H / 2 - cy;
  requestRender();
  scheduleSave();
}

// Zoom so all content (or the selection) fits on screen
// Brings all drawings (or the selection) into view, beside the left panel.
// Zooms out only as much as needed and never zooms in past where you are (or 100%).
function fitToContent() {
  const list = selectionList().length ? selectionList() : state.items;
  const b = unionBounds(list);
  if (!b) return resetView();
  const panelRight = document.getElementById('panel').getBoundingClientRect().right;
  const left = Math.max(0, panelRight) + 24, right = W - 32, top = 28, bottom = H - 28;
  const aw = Math.max(60, right - left), ah = Math.max(60, bottom - top);
  const bw = Math.max(1, b[2] - b[0]), bh = Math.max(1, b[3] - b[1]);
  const s = clamp(Math.min(aw / bw, ah / bh, Math.max(1, state.view.s)), MIN_SCALE, MAX_SCALE);
  const cx = (left + right) / 2, cy = (top + bottom) / 2;
  animateViewTo({ s, ox: cx - ((b[0] + b[2]) / 2) * s, oy: cy - ((b[1] + b[3]) / 2) * s });
}

// Smoothly glides the view so you can see where you're being taken
let viewAnim = 0;
function animateViewTo(target, ms = 320) {
  cancelAnimationFrame(viewAnim);
  const from = { ...state.view };
  const t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / ms);
    const e = 1 - Math.pow(1 - k, 3);
    if (target.s !== from.s) noteZooming();
    state.view.s = from.s * Math.pow(target.s / from.s, e);
    state.view.ox = from.ox + (target.ox - from.ox) * e;
    state.view.oy = from.oy + (target.oy - from.oy) * e;
    requestRender();
    if (k < 1) viewAnim = requestAnimationFrame(step);
    else scheduleSave();
  };
  viewAnim = requestAnimationFrame(step);
}

// "Show my drawing" pill: appears when everything you drew is off screen
let boundsCacheKey = null, boundsCache = null;
function contentBounds() {
  if (boundsCacheKey !== state.items) {
    boundsCacheKey = state.items;
    boundsCache = unionBounds(state.items);
  }
  return boundsCache;
}
function updateFindButton() {
  const btn = document.getElementById('findBtn');
  const b = contentBounds();
  let lost = false;
  if (b && !action && !crop) {
    const [vx0, vy0] = toWorld(0, 0);
    const [vx1, vy1] = toWorld(W, H);
    const tiny = (b[2] - b[0]) * state.view.s < 6 && (b[3] - b[1]) * state.view.s < 6;
    lost = tiny || b[0] > vx1 || b[2] < vx0 || b[1] > vy1 || b[3] < vy0;
  }
  btn.hidden = !lost;
}

// ---------- Images: paste & drop ----------
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = getImage(src);
    if (img.complete && img.naturalWidth) return resolve(img);
    img.addEventListener('load', () => resolve(img), { once: true });
    img.addEventListener('error', reject, { once: true });
  });
}

async function addImage(src) {
  const img = await loadImage(src);
  const s = state.view.s;
  let w = img.naturalWidth / dpr / s;
  let h = img.naturalHeight / dpr / s;
  const fit = Math.min(1, (W * 0.8) / s / w, (H * 0.8) / s / h);
  w *= fit;
  h *= fit;
  const [cx, cy] = toWorld(W / 2, H / 2);
  const item = { type: 'image', src, x: cx - w / 2, y: cy - h / 2, w, h };
  pushUndo();
  state.items = [...state.items, item];
  state.selection = new Set([item]);
  setTool('select');
  changed();
  hideHint();
}

window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  for (const file of e.dataTransfer.files) {
    if (!file.type.startsWith('image/')) continue;
    const reader = new FileReader();
    reader.onload = () => addImage(reader.result);
    reader.readAsDataURL(file);
  }
});

// ---------- Selection actions: delete, duplicate, copy/paste ----------
function deleteSelection() {
  const sel = state.selection;
  if (!selectionList().length) return;
  pushUndo();
  state.items = state.items.filter((it) => !sel.has(it));
  state.selection = new Set();
  changed();
}

function insertItems(list, dx, dy) {
  const copies = list.map((it) => shiftItem(it, dx, dy));
  pushUndo();
  state.items = [...state.items, ...copies];
  state.selection = new Set(copies);
  setTool('select');
  changed();
}

function duplicateSelection() {
  const list = selectionList();
  if (list.length) insertItems(list, 24 / state.view.s, 24 / state.view.s);
}

function selectAll() {
  state.selection = new Set(state.items);
  setTool('select');
  requestRender();
}

// Renders items to a PNG (always light theme on white, so it reads anywhere)
function renderItemsToPNG(list, scale = 2) {
  const b = unionBounds(list);
  if (!b) return null;
  const pad = 16;
  const w = Math.ceil((b[2] - b[0] + pad * 2) * scale);
  const h = Math.ceil((b[3] - b[1] + pad * 2) * scale);
  const max = 8000;
  const k = Math.min(1, max / w, max / h);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * k));
  c.height = Math.max(1, Math.round(h * k));
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, c.width, c.height);
  g.setTransform(scale * k, 0, 0, scale * k, (pad - b[0]) * scale * k, (pad - b[1]) * scale * k);
  const wasDark = state.dark;
  state.dark = false;
  try {
    drawItems(g, list, null, null);
  } finally {
    state.dark = wasDark;
  }
  return c.toDataURL('image/png');
}

let internalClip = null; // { items, marker }

function copySelection() {
  const list = selectionList();
  if (!list.length) return false;
  const marker = 'fundraw-clip:' + Date.now() + Math.random().toString(36).slice(2);
  internalClip = { items: list, marker };
  // Also puts a picture on the system clipboard, so you can paste your work into other apps
  window.api.writeClipboard(renderItemsToPNG(list), marker);
  flashHint(`Copied ${list.length} item${list.length > 1 ? 's' : ''}`);
  return true;
}

function cutSelection() {
  if (copySelection()) deleteSelection();
}

async function paste() {
  const clip = await window.api.readClipboard();
  if (internalClip && clip.text === internalClip.marker) {
    // our own strokes: paste them centered on the screen
    const b = unionBounds(internalClip.items);
    const [cx, cy] = toWorld(W / 2, H / 2);
    let dx = cx - (b[0] + b[2]) / 2, dy = cy - (b[1] + b[3]) / 2;
    if (Math.hypot(dx, dy) * state.view.s < 10) { dx += 24 / state.view.s; dy += 24 / state.view.s; }
    insertItems(internalClip.items, dx, dy);
  } else if (clip.image) {
    addImage(clip.image);
  } else {
    flashHint('Nothing to paste — copy an image first');
  }
}

async function exportPNG() {
  closePopovers();
  const list = selectionList().length ? selectionList() : state.items;
  if (!list.length) return flashHint('Nothing to export yet');
  const ok = await window.api.savePng(renderItemsToPNG(list));
  if (ok) flashHint('Exported');
}

// ---------- Toolbar ----------
const SIZES = [1.5, 3, 6];
const toolButtons = document.querySelectorAll('[data-tool]');
const themeBtn = document.getElementById('theme');
const learnBtn = document.getElementById('learn');
const undoBtn = document.getElementById('undo');
const redoBtn = document.getElementById('redo');
const zoomBtn = document.getElementById('zoom');
const styleBtn = document.getElementById('styleBtn');
const styleDot = document.getElementById('styleDot');
const moreBtn = document.getElementById('moreBtn');
const stylePop = document.getElementById('stylePop');
const morePop = document.getElementById('morePop');
const gridItem = document.getElementById('gridItem');
const invertItem = document.getElementById('invertItem');
const opacityInput = document.getElementById('opacity');
const tip = document.getElementById('tip');

function setTool(tool) {
  finishCrop(true);
  state.tool = tool;
  if (tool !== 'select') state.selection = new Set();
  toolButtons.forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  document.getElementById('qPan').classList.toggle('active', tool === 'pan');
  document.getElementById('qHighlighter').classList.toggle('active', tool === 'highlighter');
  if (state.hover) updateCursor(...state.hover);
  requestRender();
  scheduleSave();
}
toolButtons.forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));

const COLOR_NAMES = { ink: 'Ink', red: 'Rose', blue: 'Blue', green: 'Teal', orange: 'Amber', purple: 'Lavender' };

function buildStyleControls() {
  for (const id of ['colors', 'colors2']) {
    const box = document.getElementById(id);
    box.innerHTML = '';
    COLORS.forEach((c, i) => {
      const b = document.createElement('button');
      b.className = 'swatch' + (c === state.color ? ' active' : '');
      b.style.setProperty('--c', inkColor(c));
      b.dataset.tip = `${COLOR_NAMES[c] || c} · ${i + 1}`;
      b.addEventListener('click', () => setColor(c));
      box.appendChild(b);
    });
  }
  for (const id of ['sizes', 'sizes2']) {
    const box = document.getElementById(id);
    box.innerHTML = '';
    SIZES.forEach((sz, i) => {
      const b = document.createElement('button');
      b.className = 'ib size-btn' + (sz === state.size ? ' active' : '');
      b.dataset.tip = ['Thin', 'Medium', 'Thick'][i] + ' · [ ]';
      const d = document.createElement('span');
      const px = 3 + i * 3;
      d.style.width = d.style.height = px + 'px';
      b.appendChild(d);
      b.addEventListener('click', () => setSize(sz));
      box.appendChild(b);
    });
  }
  styleDot.style.background = inkColor(state.color);
  buildSelbarColors();
}

function isDrawingTool(t) {
  return t === 'pen' || t === 'highlighter';
}
function setColor(c) {
  state.color = c;
  // With strokes selected, picking a color recolors them instead of switching to the pen
  if (state.tool === 'select' && selectionList().some((it) => it.type === 'stroke')) recolorSelection(c);
  else if (!isDrawingTool(state.tool)) setTool('pen');
  buildStyleControls();
  requestRender();
  scheduleSave();
}
function recolorSelection(c) {
  if (!selectionList().some((it) => it.type === 'stroke')) return;
  pushUndo();
  const sel = new Set();
  state.items = state.items.map((it) => {
    if (!state.selection.has(it)) return it;
    const out = it.type === 'stroke' ? { ...it, color: c } : it;
    sel.add(out);
    return out;
  });
  state.selection = sel;
  changed();
}

// ----- Floating bar above a selection -----
const selbar = document.getElementById('selbar');
function buildSelbarColors() {
  const box = document.getElementById('selColors');
  box.innerHTML = '';
  COLORS.forEach((c) => {
    const b = document.createElement('button');
    b.className = 'swatch small';
    b.style.setProperty('--c', inkColor(c));
    b.dataset.tip = 'Recolor: ' + (COLOR_NAMES[c] || c);
    b.addEventListener('click', () => recolorSelection(c));
    box.appendChild(b);
  });
}
document.getElementById('selDup').addEventListener('click', duplicateSelection);
document.getElementById('selCopy').addEventListener('click', copySelection);
document.getElementById('selDel').addEventListener('click', deleteSelection);
document.getElementById('selCrop').addEventListener('click', startCrop);
document.getElementById('selOpacity').addEventListener('click', cycleImageOpacity);

function updateSelbar() {
  const list = selectionList();
  if (!list.length || action || crop) {
    selbar.hidden = true;
    return;
  }
  selbar.classList.toggle('no-strokes', !list.some((it) => it.type === 'stroke'));
  selbar.classList.toggle('single-image', list.length === 1 && list[0].type === 'image');
  selbar.hidden = false;
  const r = selectionScreenRect(list);
  const w = selbar.offsetWidth, h = selbar.offsetHeight;
  let top = canvasTop + r[1] - h - 10;
  if (top < canvasTop + 6) top = canvasTop + r[3] + 10; // no room above: put it below
  top = clamp(top, canvasTop + 6, window.innerHeight - h - 6);
  selbar.style.top = top + 'px';
  selbar.style.left = clamp((r[0] + r[2]) / 2 - w / 2, 6, window.innerWidth - w - 6) + 'px';
}

// ----- Smoothing -----
const SMOOTH_FOLLOW = [1, 0.5, 0.28]; // off, low, high
const smoothItem = document.getElementById('smoothItem');
function setSmooth(level) {
  state.smooth = clamp(level | 0, 0, 2);
  smoothItem.querySelectorAll('button').forEach((b) => b.classList.toggle('active', +b.dataset.level === state.smooth));
  scheduleSave();
}
smoothItem.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => setSmooth(+b.dataset.level)));
function setSize(sz) {
  state.size = sz;
  if (!isDrawingTool(state.tool)) setTool('pen');
  buildStyleControls();
  requestRender();
  scheduleSave();
}
function stepSize(dir) {
  const i = SIZES.indexOf(state.size);
  setSize(SIZES[clamp((i < 0 ? 1 : i) + dir, 0, SIZES.length - 1)]);
}

function setDark(dark) {
  state.dark = dark;
  document.body.classList.toggle('dark', dark);
  themeBtn.querySelector('use').setAttribute('href', dark ? '#i-sun' : '#i-moon');
  themeBtn.dataset.tip = dark ? 'Light mode · D' : 'Dark mode · D';
  document.querySelector('#qTheme use').setAttribute('href', dark ? '#i-sun' : '#i-moon');
  window.api.setTheme(dark);
  buildStyleControls();
  requestRender();
  scheduleSave();
}
themeBtn.addEventListener('click', () => setDark(!state.dark));

function setInvert(on) {
  state.invert = on;
  invertItem.classList.toggle('on', on);
  requestRender();
  scheduleSave();
}
invertItem.addEventListener('click', () => setInvert(!state.invert));

const GRID_LEVELS = [0, 0.05, 0.1];
const linesItem = document.getElementById('linesItem');
const validLevel = (level) => (GRID_LEVELS.includes(level) ? level : level > 0 ? 0.05 : 0);
function updatePaperUI() {
  gridItem.querySelectorAll('button').forEach((b) => b.classList.toggle('active', +b.dataset.level === state.grid));
  linesItem.querySelectorAll('button').forEach((b) => b.classList.toggle('active', +b.dataset.level === state.lines));
}
// Grid and ruled lines: turning one on turns the other off
function setGrid(level) {
  state.grid = validLevel(level);
  if (state.grid) state.lines = 0;
  updatePaperUI();
  requestRender();
  scheduleSave();
}
function setLines(level) {
  state.lines = validLevel(level);
  if (state.lines) state.grid = 0;
  updatePaperUI();
  requestRender();
  scheduleSave();
}
gridItem.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => setGrid(+b.dataset.level)));
linesItem.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => setLines(+b.dataset.level)));
function cycleGrid() {
  setGrid(GRID_LEVELS[(GRID_LEVELS.indexOf(state.grid) + 1) % GRID_LEVELS.length]);
}
function cycleLines() {
  setLines(GRID_LEVELS[(GRID_LEVELS.indexOf(state.lines) + 1) % GRID_LEVELS.length]);
}

async function setLearn(on) {
  closePopovers();
  state.learn = await window.api.setLearnMode(on);
  document.body.classList.toggle('learn', state.learn);
  learnBtn.classList.toggle('active', state.learn);
  document.getElementById('qLearn').classList.toggle('active', state.learn);
}
learnBtn.addEventListener('click', () => setLearn(!state.learn));
opacityInput.addEventListener('input', () => window.api.setOpacity(+opacityInput.value));

document.getElementById('clearItem').addEventListener('click', () => {
  closePopovers();
  if (!state.items.length) return;
  pushUndo();
  state.items = [];
  state.selection = new Set();
  changed();
});
document.getElementById('exportItem').addEventListener('click', exportPNG);
document.getElementById('fitItem').addEventListener('click', () => { closePopovers(); fitToContent(); });
document.getElementById('centerBtn').addEventListener('click', fitToContent);
document.getElementById('findBtn').addEventListener('click', fitToContent);

undoBtn.addEventListener('click', undo);
redoBtn.addEventListener('click', redo);
zoomBtn.addEventListener('click', resetView);
zoomBtn.addEventListener('dblclick', fitToContent);
document.getElementById('paste').addEventListener('click', paste);

// Called from render(): keeps button states in sync with the document
function updateToolbar() {
  undoBtn.disabled = !state.undo.length;
  redoBtn.disabled = !state.redo.length;
  zoomBtn.textContent = Math.round(state.view.s * 100) + '%';
}

// ----- Responsive toolbar -----
const TOOLBAR_LEVELS = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6'];
function toolbarNeededWidth() {
  const cs = getComputedStyle(toolbar);
  const gap = parseFloat(cs.columnGap) || 0;
  let w = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
  let n = 0;
  for (const el of toolbar.children) {
    const ecs = getComputedStyle(el);
    if (ecs.display === 'none') continue;
    n++;
    if (el.classList.contains('drag-space')) w += parseFloat(ecs.minWidth) || 0;
    else if (el === boardBtn) w += Math.min(el.scrollWidth, 120); // the name can shrink with "…"
    else w += el.getBoundingClientRect().width + (parseFloat(ecs.marginLeft) || 0) + (parseFloat(ecs.marginRight) || 0);
  }
  return w + gap * Math.max(0, n - 1);
}
const PANEL_LEVELS = ['v1', 'v2', 'v3'];
const panelEl = document.getElementById('panel');
const dockEl = document.getElementById('dock');
function fitPanel() {
  document.body.classList.remove(...PANEL_LEVELS);
  for (const level of PANEL_LEVELS) {
    if (panelEl.offsetHeight <= dockEl.clientHeight - 16) break;
    document.body.classList.add(level);
  }
}
window.addEventListener('resize', fitPanel);

function fitToolbar() {
  document.body.classList.remove(...TOOLBAR_LEVELS);
  for (const level of TOOLBAR_LEVELS) {
    if (toolbarNeededWidth() <= toolbar.clientWidth) break;
    document.body.classList.add(level);
  }
}
window.addEventListener('resize', fitToolbar);

document.getElementById('qRedo').addEventListener('click', redo);
document.getElementById('qPaste').addEventListener('click', () => { closePopovers(); paste(); });
document.getElementById('qHighlighter').addEventListener('click', () => { closePopovers(); setTool('highlighter'); });
document.getElementById('qPan').addEventListener('click', () => { closePopovers(); setTool('pan'); });
document.getElementById('qTheme').addEventListener('click', () => setDark(!state.dark));
document.getElementById('qLearn').addEventListener('click', () => setLearn(!state.learn));
document.getElementById('qBoard').addEventListener('click', () => {
  closePopovers();
  openBoardMenu();
});

// ----- Popovers -----
function togglePopover(pop, anchor) {
  const open = pop.hidden;
  closePopovers();
  if (!open) return;
  pop.hidden = false;
  anchor.classList.add('active');
  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth, h = pop.offsetHeight;
  if (anchor.closest('#panel')) {
    pop.style.left = r.right + 12 + 'px';
    pop.style.top = clamp(r.top + r.height / 2 - h / 2, canvasTop + 6, window.innerHeight - h - 6) + 'px';
  } else {
    pop.style.top = r.bottom + 6 + 'px';
    pop.style.left = clamp(r.left + r.width / 2 - w / 2, 6, window.innerWidth - w - 6) + 'px';
  }
}
function closePopovers() {
  for (const p of [stylePop, morePop, boardPop]) p.hidden = true;
  for (const b of [styleBtn, moreBtn, boardBtn]) b.classList.remove('active');
}
styleBtn.addEventListener('click', () => togglePopover(stylePop, styleBtn));
moreBtn.addEventListener('click', () => togglePopover(morePop, moreBtn));
document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('.popover, #styleBtn, #moreBtn, #boardBtn')) closePopovers();
});
window.addEventListener('resize', closePopovers);

// ----- Tooltips -----
let tipTimer = null;
document.addEventListener('pointerover', (e) => {
  const el = e.target.closest('[data-tip]');
  clearTimeout(tipTimer);
  tip.hidden = true;
  if (!el || e.pointerType === 'pen') return;
  tipTimer = setTimeout(() => {
    tip.textContent = el.dataset.tip;
    tip.hidden = false;
    const r = el.getBoundingClientRect();
    const w = tip.offsetWidth, th = tip.offsetHeight;
    if (el.closest('#panel')) {
      tip.style.left = r.right + 10 + 'px';
      tip.style.top = r.top + r.height / 2 - th / 2 + 'px';
    } else {
      tip.style.top = r.bottom + 6 + 'px';
      tip.style.left = clamp(r.left + r.width / 2 - w / 2, 6, window.innerWidth - w - 6) + 'px';
    }
  }, 450);
});
document.addEventListener('pointerdown', () => {
  clearTimeout(tipTimer);
  tip.hidden = true;
});

// Keep toolbar buttons from holding keyboard focus (Space would "click" them)
document.addEventListener('pointerup', () => {
  if (document.activeElement && document.activeElement.tagName === 'BUTTON') document.activeElement.blur();
});

// ---------- Keyboard ----------
window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (e.key === 'Control' && !ctrlDown) {
    ctrlDown = true;
    if (state.hover) { updateCursor(...state.hover); requestRender(); }
  }
  if (e.ctrlKey) {
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
    else if (k === 'v') { e.preventDefault(); paste(); }
    else if (k === 'c') { e.preventDefault(); copySelection(); }
    else if (k === 'x') { e.preventDefault(); cutSelection(); }
    else if (k === 'd') { e.preventDefault(); duplicateSelection(); }
    else if (k === 'a') { e.preventDefault(); selectAll(); }
    else if (k === 's') { e.preventDefault(); exportPNG(); }
    else if (k === 'n') { e.preventDefault(); newBoard(); }
    else if (k === '0') { e.preventDefault(); resetView(); }
    else if (k === '1') { e.preventDefault(); fitToContent(); }
    else if (k === '=' || k === '+') { e.preventDefault(); zoomAt(W / 2, H / 2, 1.25); }
    else if (k === '-') { e.preventDefault(); zoomAt(W / 2, H / 2, 0.8); }
    return;
  }
  if (e.key === ' ') {
    e.preventDefault();
    if (!spaceDown) {
      spaceDown = true;
      if (state.hover) updateCursor(...state.hover);
      requestRender();
    }
    return;
  }
  if (e.target.tagName === 'INPUT') return;
  if (k === 'b') { openBoardMenu(); return; }
  if (k === 'home') { fitToContent(); return; }
  if (k === 'p') setTool('pen');
  else if (k === 'i') setTool('highlighter');
  else if (k === 'e') setTool('eraser');
  else if (k === 'v' || k === 's') setTool('select');
  else if (k === 'h') setTool('pan');
  else if (k === 'd') setDark(!state.dark);
  else if (k === 'g' && e.shiftKey) cycleLines();
  else if (k === 'g') cycleGrid();
  else if (k === 'l') setLearn(!state.learn);
  else if (k === '[') stepSize(-1);
  else if (k === ']') stepSize(1);
  else if (k === 'delete' || k === 'backspace') deleteSelection();
  else if (k === 'enter' && crop) finishCrop(true);
  else if (k === 'escape') {
    if (crop) finishCrop(false);
    else if (!stylePop.hidden || !morePop.hidden || !boardPop.hidden) closePopovers();
    else if (state.selection.size) { state.selection = new Set(); requestRender(); }
    else if (state.learn) setLearn(false);
  } else if (/^[1-9]$/.test(k) && COLORS[+k - 1]) setColor(COLORS[+k - 1]);
});
window.addEventListener('keyup', (e) => {
  if (e.key === ' ') {
    e.preventDefault();
    spaceDown = false;
  }
  if (e.key === 'Control') ctrlDown = false;
  if (state.hover) updateCursor(...state.hover);
  requestRender();
});
window.addEventListener('blur', () => {
  spaceDown = false;
  ctrlDown = false;
});

// ---------- Hint ----------
let hintTimer = setTimeout(hideHint, 8000);
function hideHint() {
  hint.classList.add('hidden');
}
function flashHint(text) {
  hint.textContent = text;
  hint.classList.remove('hidden');
  clearTimeout(hintTimer);
  hintTimer = setTimeout(hideHint, 1800);
}

// ---------- Save / load (boards) ----------
let boardId = null;
let boardIndex = { current: null, boards: [] };

const itemJSONCache = new WeakMap();
function itemJSON(it) {
  let s = itemJSONCache.get(it);
  if (s === undefined) {
    s = JSON.stringify(it);
    itemJSONCache.set(it, s);
  }
  return s;
}
// Items are immutable once added, so only new ones are stringified on each save
function serialize() {
  const settings = {
    tool: state.tool, color: state.color, size: state.size,
    dark: state.dark, invert: state.invert, grid: state.grid, lines: state.lines, smooth: state.smooth,
  };
  return '{"version":1,"items":[' + state.items.map(itemJSON).join(',') + '],"view":' +
    JSON.stringify(state.view) + ',"settings":' + JSON.stringify(settings) + '}';
}
let saveTimer = null;
function scheduleSave() {
  if (!boardId) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 1000);
}
function flushSave() {
  if (saveTimer === null || !boardId) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  window.api.saveBoard(boardId, serialize());
}
window.addEventListener('beforeunload', () => {
  if (saveTimer !== null && boardId) {
    clearTimeout(saveTimer);
    saveTimer = null;
    window.api.saveBoardSync(boardId, serialize());
  }
});

function applySettings(s) {
  if (s.color) state.color = LEGACY_COLORS[s.color] || (COLORS.includes(s.color) ? s.color : 'ink');
  if (s.size) state.size = s.size;
  if (typeof s.invert === 'boolean') state.invert = s.invert;
  if (typeof s.grid === 'number') state.grid = s.grid;
  else if (typeof s.grid === 'boolean') state.grid = s.grid ? 0.05 : 0;
  state.dark = !!s.dark;
  if (s.tool) state.tool = s.tool;
  if (typeof s.smooth === 'number') state.smooth = s.smooth;
  if (typeof s.lines === 'number') state.lines = s.lines;
}

// Opens a board. Tool, colors and theme carry over from the board you were on,
// except at startup, where they come from the board being opened.
async function openBoard(id, { withSettings = false } = {}) {
  crop = null;
  flushSave();
  if (action) endAction();
  const { id: openedId, json } = await window.api.loadBoard(id);
  boardId = openedId;
  state.items = [];
  state.undo = [];
  state.redo = [];
  state.selection = new Set();
  state.view = { ox: W / 2, oy: H / 2, s: 1 };
  if (json) {
    try {
      const doc = JSON.parse(json);
      state.items = Array.isArray(doc.items) ? doc.items : [];
      for (const it of state.items) if (it.type === 'stroke' && !it.bbox) it.bbox = strokeBBox(it);
      if (doc.view) state.view = doc.view;
      if (withSettings && doc.settings) applySettings(doc.settings);
    } catch (err) {
      console.error('Could not read board', err);
    }
  }
  boardIndex = await window.api.listBoards();
  if (state.items.length) hideHint();
  updateBoardUI();
  invalidateLayer();
  requestRender();
}

// ----- Board switcher UI -----
const boardBtn = document.getElementById('boardBtn');
const boardNameEl = document.getElementById('boardName');
const boardPop = document.getElementById('boardPop');
const boardList = document.getElementById('boardList');

function timeAgo(t) {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + ' min ago';
  const h = Math.round(m / 60);
  if (h < 24) return h + ' h ago';
  const d = Math.round(h / 24);
  return d < 30 ? d + ' d ago' : new Date(t).toLocaleDateString();
}

function updateBoardUI() {
  const cur = boardIndex.boards.find((b) => b.id === boardId);
  boardNameEl.textContent = cur ? cur.name : 'Board';
  document.title = (cur ? cur.name + ' — ' : '') + 'FunDraw';
  fitToolbar();
  if (!boardPop.hidden) buildBoardList();
}

function buildBoardList() {
  boardList.innerHTML = '';
  for (const b of boardIndex.boards) {
    const row = document.createElement('div');
    row.className = 'board-row' + (b.id === boardId ? ' current' : '');
    row.innerHTML =
      '<button class="board-open"><span class="board-title"></span><span class="board-time"></span></button>' +
      '<button class="ib mini" data-act="rename" data-tip="Rename"><svg><use href="#i-pen"/></svg></button>' +
      '<button class="ib mini" data-act="delete" data-tip="Delete"><svg><use href="#i-trash"/></svg></button>';
    row.querySelector('.board-title').textContent = b.name;
    row.querySelector('.board-time').textContent = b.id === boardId ? 'open' : timeAgo(b.updated);
    row.querySelector('.board-open').addEventListener('click', async () => {
      closePopovers();
      if (b.id !== boardId) await openBoard(b.id);
    });
    row.querySelector('[data-act=rename]').addEventListener('click', () => startRename(row, b));
    row.querySelector('[data-act=delete]').addEventListener('click', () => removeBoard(b));
    boardList.appendChild(row);
  }
}

function startRename(row, b) {
  const open = row.querySelector('.board-open');
  if (!open) return;
  const input = document.createElement('input');
  input.className = 'board-input';
  input.value = b.name;
  open.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    if (save && input.value.trim() && input.value.trim() !== b.name) {
      boardIndex = await window.api.renameBoard(b.id, input.value);
    }
    updateBoardUI();
    if (!boardPop.hidden) buildBoardList();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

async function removeBoard(b) {
  if (!confirm('Delete the board "' + b.name + '"?\nThis cannot be undone.')) return;
  if (b.id === boardId) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  boardIndex = await window.api.deleteBoard(b.id);
  if (b.id === boardId || !boardIndex.boards.some((x) => x.id === boardId)) {
    boardId = null;
    await openBoard(boardIndex.current);
  }
  updateBoardUI();
  if (!boardPop.hidden) buildBoardList();
}

async function newBoard() {
  closePopovers();
  const id = await window.api.createBoard('Board ' + (boardIndex.boards.length + 1));
  await openBoard(id);
  // open the menu with the new board's name ready to type over
  openBoardMenu();
  const row = boardList.querySelector('.board-row.current');
  const b = boardIndex.boards.find((x) => x.id === id);
  if (row && b) startRename(row, b);
}

function openBoardMenu() {
  togglePopover(boardPop, boardBtn.offsetWidth ? boardBtn : moreBtn);
  if (!boardPop.hidden) buildBoardList();
}
boardBtn.addEventListener('click', openBoardMenu);
document.getElementById('newBoardBtn').addEventListener('click', newBoard);

async function init() {
  window.addEventListener('resize', resize);
  resize();
  try {
    boardIndex = await window.api.listBoards();
    await openBoard(boardIndex.current, { withSettings: true });
  } catch (err) {
    console.error('Could not load boards', err);
  }
  setDark(state.dark);
  setInvert(state.invert);
  setGrid(state.grid);
  setLines(state.lines);
  setSmooth(state.smooth);
  setTool(state.tool);
  fitToolbar();
  fitPanel();
  clearTimeout(saveTimer); // nothing changed yet
  saveTimer = null;
}
init();
