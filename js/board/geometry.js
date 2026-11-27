// Pure geometry for board elements. World coordinates throughout.

export const TEXTUAL = new Set(['sticky', 'text', 'shape']);
export const CONNECTABLE = new Set(['sticky', 'text', 'shape', 'image', 'video', 'pdf', 'embed', 'link', 'task']);

export const center = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });

export function rectFromPoints(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

export function bboxOf(pts) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const p of pts) {
    if (p.x < x1) x1 = p.x;
    if (p.y < y1) y1 = p.y;
    if (p.x > x2) x2 = p.x;
    if (p.y > y2) y2 = p.y;
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

export function unionRects(rs) {
  const list = rs.filter(Boolean);
  if (!list.length) return null;
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const r of list) {
    x1 = Math.min(x1, r.x); y1 = Math.min(y1, r.y);
    x2 = Math.max(x2, r.x + r.w); y2 = Math.max(y2, r.y + r.h);
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

export const intersects = (a, b) => a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y;
export const contains = (o, i) => i.x >= o.x && i.y >= o.y && i.x + i.w <= o.x + o.w && i.y + i.h <= o.y + o.h;
export const pointIn = (r, p, pad = 0) => p.x >= r.x - pad && p.x <= r.x + r.w + pad && p.y >= r.y - pad && p.y <= r.y + r.h + pad;

export function distToSeg(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function rectOf(el, byId) {
  if (el.type === 'line') return lineGeom(el, byId).bbox;
  return { x: el.x, y: el.y, w: el.w, h: el.h };
}

/* ---------------- Connectors ---------------- */

// The side whose midpoint is nearest to p, by real distance. (Comparing offsets relative to width and
// height made wide text blocks always connect at the bottom.)
function sideFacing(r, p) {
  let best = 'b', bd = Infinity;
  for (const s of ['t', 'r', 'b', 'l']) {
    const q = sidePoint(r, s);
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d < bd) { bd = d; best = s; }
  }
  return best;
}

/** The edge of r nearest to the pointer — where a connector was dropped. */
export function nearestSide(r, p) {
  const d = { t: Math.abs(p.y - r.y), b: Math.abs(r.y + r.h - p.y), l: Math.abs(p.x - r.x), r: Math.abs(r.x + r.w - p.x) };
  return Object.entries(d).sort((a, b) => a[1] - b[1])[0][0];
}
export const DIR_SIDE = { n: 't', e: 'r', s: 'b', w: 'l' };

function sidePoint(r, side) {
  if (side === 'r') return { x: r.x + r.w, y: r.y + r.h / 2 };
  if (side === 'l') return { x: r.x, y: r.y + r.h / 2 };
  if (side === 't') return { x: r.x + r.w / 2, y: r.y };
  return { x: r.x + r.w / 2, y: r.y + r.h };
}

function rayPoint(el, r, toward) {
  const c = center(r);
  const dx = toward.x - c.x, dy = toward.y - c.y;
  if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return c;
  const hw = Math.max(r.w / 2, 0.5), hh = Math.max(r.h / 2, 0.5);
  let t;
  if (el.type === 'shape' && el.kind === 'ellipse') t = 1 / Math.sqrt((dx * dx) / (hw * hw) + (dy * dy) / (hh * hh));
  else if (el.type === 'shape' && el.kind === 'diamond') t = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
  else t = Math.min(hw / Math.abs(dx || 1e-9), hh / Math.abs(dy || 1e-9));
  return { x: c.x + dx * t, y: c.y + dy * t };
}

function push(p, side, k) {
  if (side === 'r') return { x: p.x + k, y: p.y };
  if (side === 'l') return { x: p.x - k, y: p.y };
  if (side === 't') return { x: p.x, y: p.y - k };
  return { x: p.x, y: p.y + k };
}

const isH = (s) => s === 'l' || s === 'r';

function elbowPoints(a, sa, b, sb) {
  let pts;
  if (isH(sa) && isH(sb)) { const mx = (a.x + b.x) / 2; pts = [a, { x: mx, y: a.y }, { x: mx, y: b.y }, b]; }
  else if (!isH(sa) && !isH(sb)) { const my = (a.y + b.y) / 2; pts = [a, { x: a.x, y: my }, { x: b.x, y: my }, b]; }
  else if (isH(sa)) pts = [a, { x: b.x, y: a.y }, b];
  else pts = [a, { x: a.x, y: b.y }, b];
  return pts.filter((p, i) => i === 0 || Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) > 0.01);
}

function roundedPath(pts, radius = 10) {
  if (pts.length < 3) return `M${pts[0].x} ${pts[0].y}` + pts.slice(1).map((p) => `L${p.x} ${p.y}`).join('');
  let d = `M${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p0 = pts[i - 1], p1 = pts[i], p2 = pts[i + 1];
    const l1 = Math.hypot(p1.x - p0.x, p1.y - p0.y), l2 = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const r = Math.min(radius, l1 / 2, l2 / 2);
    const a = { x: p1.x - ((p1.x - p0.x) / (l1 || 1)) * r, y: p1.y - ((p1.y - p0.y) / (l1 || 1)) * r };
    const b = { x: p1.x + ((p2.x - p1.x) / (l2 || 1)) * r, y: p1.y + ((p2.y - p1.y) / (l2 || 1)) * r };
    d += `L${a.x} ${a.y}Q${p1.x} ${p1.y} ${b.x} ${b.y}`;
  }
  const last = pts[pts.length - 1];
  return d + `L${last.x} ${last.y}`;
}

function cubicAt(a, c1, c2, b, t) {
  const u = 1 - t;
  return {
    x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
    y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
  };
}

// Resolve a connector: endpoints (bound or free), path data and tangents.
export function lineGeom(line, byId) {
  const ta = line.a?.id ? byId?.get(line.a.id) : null;
  const tb = line.b?.id ? byId?.get(line.b.id) : null;
  const ra = ta && ta.type !== 'line' ? { x: ta.x, y: ta.y, w: ta.w, h: ta.h } : null;
  const rb = tb && tb.type !== 'line' ? { x: tb.x, y: tb.y, w: tb.w, h: tb.h } : null;
  const ca = ra ? center(ra) : { x: line.a.x, y: line.a.y };
  const cb = rb ? center(rb) : { x: line.b.x, y: line.b.y };
  const route = line.route || 'straight';
  let a, b, sa = null, sb = null;
  // An end attached to a specific side (where you dropped it / the dot you dragged from) stays there.
  const fixedA = ra && ['t', 'r', 'b', 'l'].includes(line.a.side) ? line.a.side : null;
  const fixedB = rb && ['t', 'r', 'b', 'l'].includes(line.b.side) ? line.b.side : null;
  if (route === 'straight') {
    a = fixedA ? sidePoint(ra, (sa = fixedA)) : ra ? rayPoint(ta, ra, fixedB ? sidePoint(rb, fixedB) : cb) : ca;
    b = fixedB ? sidePoint(rb, (sb = fixedB)) : rb ? rayPoint(tb, rb, fixedA ? a : ca) : cb;
  } else {
    if (ra) { sa = fixedA || sideFacing(ra, fixedB ? sidePoint(rb, fixedB) : cb); a = sidePoint(ra, sa); } else a = ca;
    if (rb) { sb = fixedB || sideFacing(rb, a); b = sidePoint(rb, sb); } else b = cb;
  }
  const dx = b.x - a.x, dy = b.y - a.y;
  const horiz = Math.abs(dx) >= Math.abs(dy);
  if (!sa) sa = horiz ? (dx >= 0 ? 'r' : 'l') : (dy >= 0 ? 'b' : 't');
  if (!sb) sb = horiz ? (dx >= 0 ? 'l' : 'r') : (dy >= 0 ? 't' : 'b');

  let d, pts, tanA, tanB;
  if (route === 'curve') {
    const k = Math.max(30, Math.hypot(dx, dy) * 0.4);
    const c1 = push(a, sa, k), c2 = push(b, sb, k);
    d = `M${a.x} ${a.y}C${c1.x} ${c1.y} ${c2.x} ${c2.y} ${b.x} ${b.y}`;
    pts = Array.from({ length: 17 }, (_, i) => cubicAt(a, c1, c2, b, i / 16));
    tanA = sub(a, c1);
    tanB = sub(b, c2);
  } else if (route === 'elbow') {
    pts = elbowPoints(a, sa, b, sb);
    d = roundedPath(pts, 12);
    tanA = pts.length > 1 ? sub(pts[0], pts[1]) : { x: -1, y: 0 };
    tanB = pts.length > 1 ? sub(pts[pts.length - 1], pts[pts.length - 2]) : { x: 1, y: 0 };
  } else {
    pts = [a, b];
    d = `M${a.x} ${a.y}L${b.x} ${b.y}`;
    tanA = sub(a, b);
    tanB = sub(b, a);
  }
  // Nov 27 — by default a connector between two objects goes around anything in its way (recomputed whenever
  // either end or another object moves; only the connector changes). "Allow intersections" (line.through)
  // lets it pass straight through on purpose.
  if (ra && rb && !line.through && byId) {
    const detour = routeAround(line, ta, tb, a, sa, b, sb, pts, byId);
    if (detour) {
      pts = detour;
      d = roundedPath(pts, 12);
      tanA = sub(pts[0], pts[1]);
      tanB = sub(pts[pts.length - 1], pts[pts.length - 2]);
    }
  }
  return { a, b, d, pts, tanA, tanB, bbox: bboxOf(pts) };
}

/* ---------------- obstacle-avoiding routes ---------------- */
const ROUTE_CACHE = new Map(); // line id → { key, pts }
// Nov 29: every visible object is an obstacle — sticky notes, images, media, cards, widgets, text, shapes —
// everything except other connectors, drawings, borders and frames (which contain things rather than block).
const PASS = new Set(['line', 'pen', 'border', 'frame']);
const rotBox = (el) => {
  if (!el.rot) return { x: el.x, y: el.y, w: el.w, h: el.h };
  const t = (el.rot * Math.PI) / 180, c = Math.abs(Math.cos(t)), s2 = Math.abs(Math.sin(t));
  const w = el.w * c + el.h * s2, h = el.w * s2 + el.h * c;
  return { x: el.x + el.w / 2 - w / 2, y: el.y + el.h / 2 - h / 2, w, h };
};
const M = 18; // clearance around obstacles
function segHitsRect(p, q, r) {
  // Liang–Barsky
  let t0 = 0, t1 = 1;
  const dx = q.x - p.x, dy = q.y - p.y;
  const P = [-dx, dx, -dy, dy], Q = [p.x - r.x, r.x + r.w - p.x, p.y - r.y, r.y + r.h - p.y];
  for (let i = 0; i < 4; i++) {
    if (P[i] === 0) { if (Q[i] < 0) return false; continue; }
    const t = Q[i] / P[i];
    if (P[i] < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
  }
  return t1 - t0 > 1e-6;
}
const polyHits = (pts, r) => { for (let i = 1; i < pts.length; i++) if (segHitsRect(pts[i - 1], pts[i], r)) return true; return false; };
function routeAround(line, ta, tb, a, sa, b, sb, pts, byId) {
  const lo = { x: Math.min(a.x, b.x) - 400, y: Math.min(a.y, b.y) - 400, x2: Math.max(a.x, b.x) + 400, y2: Math.max(a.y, b.y) + 400 };
  const obs = [];
  for (const el of byId.values()) {
    if (el === ta || el === tb || PASS.has(el.type) || el.hidden || !Number.isFinite(el.x) || !(el.w > 0) || !(el.h > 0)) continue;
    const r = rotBox(el);
    if (r.x > lo.x2 || r.y > lo.y2 || r.x + r.w < lo.x || r.y + r.h < lo.y) continue;
    // an object that holds either end (a frame-like container, or overlapping) isn't an obstacle
    if (inside(a, r) || inside(b, r)) continue;
    obs.push(r);
  }
  if (!obs.length) { ROUTE_CACHE.delete(line.id); return null; }
  const key = `${a.x},${a.y},${sa},${b.x},${b.y},${sb}|${obs.map((r) => `${r.x},${r.y},${r.w},${r.h}`).join(';')}`;
  const hit = ROUTE_CACHE.get(line.id);
  if (hit && hit.key === key) return hit.pts;
  const grown = obs.map((r) => ({ x: r.x - M, y: r.y - M, w: r.w + 2 * M, h: r.h + 2 * M }));
  let out = null;
  if (grown.some((r) => polyHits(pts, { x: r.x + M / 2, y: r.y + M / 2, w: r.w - M, h: r.h - M }))) out = gridRoute(a, sa, b, sb, grown);
  if (ROUTE_CACHE.size > 800) ROUTE_CACHE.clear();
  ROUTE_CACHE.set(line.id, { key, pts: out });
  return out;
}
const inside = (p, r) => p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h;
function gridRoute(a, sa, b, sb, grown) {
  const s0 = push(a, sa, M + 4), e0 = push(b, sb, M + 4);
  const xs = [...new Set([s0.x, e0.x, ...grown.flatMap((r) => [r.x, r.x + r.w])].map((v) => Math.round(v)))].sort((p, q) => p - q);
  const ys = [...new Set([s0.y, e0.y, ...grown.flatMap((r) => [r.y, r.y + r.h])].map((v) => Math.round(v)))].sort((p, q) => p - q);
  if (xs.length * ys.length > 4000) return null;
  const blocked = (x, y) => grown.some((r) => x > r.x + 0.5 && x < r.x + r.w - 0.5 && y > r.y + 0.5 && y < r.y + r.h - 0.5);
  const segFree = (p, q) => !grown.some((r) => segHitsRect(p, q, { x: r.x + 1, y: r.y + 1, w: r.w - 2, h: r.h - 2 }));
  const sxi = xs.indexOf(Math.round(s0.x)), syi = ys.indexOf(Math.round(s0.y));
  const exi = xs.indexOf(Math.round(e0.x)), eyi = ys.indexOf(Math.round(e0.y));
  const id = (i, j) => i * ys.length + j;
  // A* over grid nodes, cost = length + a penalty per bend
  const open = [[0, sxi, syi, -1]];
  const best = new Map([[id(sxi, syi) * 3 + 2, 0]]);
  const prev = new Map();
  const H = (i, j) => Math.abs(xs[i] - xs[exi]) + Math.abs(ys[j] - ys[eyi]);
  let guard = 0, found = null;
  while (open.length && guard++ < 20000) {
    let k = 0;
    for (let n = 1; n < open.length; n++) if (open[n][0] < open[k][0]) k = n;
    const [f, i, j, dir] = open.splice(k, 1)[0];
    const g0 = best.get(id(i, j) * 3 + (dir + 1)) ?? 0;
    if (i === exi && j === eyi) { found = { i, j, dir }; break; }
    void f;
    for (const [di, dj, nd] of [[1, 0, 0], [-1, 0, 0], [0, 1, 1], [0, -1, 1]]) {
      const ni = i + di, nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= xs.length || nj >= ys.length) continue;
      if (blocked(xs[ni], ys[nj]) && !(ni === exi && nj === eyi)) continue;
      if (!segFree({ x: xs[i], y: ys[j] }, { x: xs[ni], y: ys[nj] })) continue;
      const g1 = g0 + Math.abs(xs[ni] - xs[i]) + Math.abs(ys[nj] - ys[j]) + (dir !== -1 && dir !== nd ? 60 : 0);
      const key = id(ni, nj) * 3 + (nd + 1);
      if (g1 >= (best.get(key) ?? Infinity)) continue;
      best.set(key, g1);
      prev.set(key, id(i, j) * 3 + (dir + 1));
      open.push([g1 + H(ni, nj), ni, nj, nd]);
    }
  }
  if (!found) return null;
  const path = [];
  let k = id(found.i, found.j) * 3 + (found.dir + 1);
  while (k != null) {
    const n = Math.floor(k / 3);
    path.push({ x: xs[Math.floor(n / ys.length)], y: ys[n % ys.length] });
    k = prev.get(k);
  }
  path.reverse();
  // drop points that don't turn
  const simple = [a, ...path, b].filter((p, i, arr) => {
    if (i === 0 || i === arr.length - 1) return true;
    const q = arr[i - 1], r = arr[i + 1];
    return !((q.x === p.x && p.x === r.x) || (q.y === p.y && p.y === r.y));
  });
  return simple;
}

export function capPath(p, tan, size, kind) {
  const len = Math.hypot(tan.x, tan.y) || 1;
  const ux = tan.x / len, uy = tan.y / len;
  const px = -uy, py = ux;
  const back = { x: p.x - ux * size, y: p.y - uy * size };
  if (kind === 'arrow') {
    const w = size * 0.6;
    return { d: `M${back.x + px * w} ${back.y + py * w}L${p.x} ${p.y}L${back.x - px * w} ${back.y - py * w}`, fill: false };
  }
  if (kind === 'triangle') {
    const w = size * 0.55;
    return { d: `M${back.x + px * w} ${back.y + py * w}L${p.x} ${p.y}L${back.x - px * w} ${back.y - py * w}Z`, fill: true };
  }
  if (kind === 'dot') {
    const r = size * 0.38;
    const c = { x: p.x - ux * r, y: p.y - uy * r };
    return { d: `M${c.x - r} ${c.y}a${r} ${r} 0 1 0 ${r * 2} 0a${r} ${r} 0 1 0 ${-r * 2} 0`, fill: true };
  }
  return null;
}

/* ---------------- Shapes ---------------- */

export const SHAPES = ['rect', 'round', 'ellipse', 'triangle', 'diamond', 'hexagon', 'parallelogram', 'star', 'arrowblock', 'pill'];

export function shapePath(kind, w, h) {
  switch (kind) {
    case 'round': { const r = Math.min(18, w / 4, h / 4); return rr(w, h, r); }
    case 'pill': return rr(w, h, Math.min(w, h) / 2);
    case 'ellipse': return `M${w / 2} 0A${w / 2} ${h / 2} 0 1 1 ${w / 2} ${h}A${w / 2} ${h / 2} 0 1 1 ${w / 2} 0Z`;
    case 'triangle': return `M${w / 2} 0L${w} ${h}L0 ${h}Z`;
    case 'diamond': return `M${w / 2} 0L${w} ${h / 2}L${w / 2} ${h}L0 ${h / 2}Z`;
    case 'hexagon': return `M${w * 0.25} 0H${w * 0.75}L${w} ${h / 2}L${w * 0.75} ${h}H${w * 0.25}L0 ${h / 2}Z`;
    case 'parallelogram': return `M${w * 0.22} 0H${w}L${w * 0.78} ${h}H0Z`;
    case 'arrowblock': return `M0 ${h * 0.28}H${w * 0.62}V0L${w} ${h / 2}L${w * 0.62} ${h}V${h * 0.72}H0Z`;
    case 'star': {
      let d = '';
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const r = i % 2 ? 0.2 : 0.5;
        d += `${i ? 'L' : 'M'}${w / 2 + Math.cos(a) * r * w} ${h * 0.54 + Math.sin(a) * r * h * 1.02}`;
      }
      return d + 'Z';
    }
    default: return `M0 0H${w}V${h}H0Z`;
  }
}

function rr(w, h, r) {
  return `M${r} 0H${w - r}A${r} ${r} 0 0 1 ${w} ${r}V${h - r}A${r} ${r} 0 0 1 ${w - r} ${h}H${r}A${r} ${r} 0 0 1 0 ${h - r}V${r}A${r} ${r} 0 0 1 ${r} 0Z`;
}

/* ---------------- Freehand ---------------- */

export function penPath(pts) {
  if (!pts.length) return '';
  if (pts.length < 3) {
    const [a, b = [a[0] + 0.01, a[1]]] = pts;
    return `M${a[0]} ${a[1]}L${b[0]} ${b[1]}`;
  }
  let d = `M${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[i + 1];
    d += `Q${x1} ${y1} ${(x1 + x2) / 2} ${(y1 + y2) / 2}`;
  }
  const l = pts[pts.length - 1];
  return d + `L${l[0]} ${l[1]}`;
}

// Ramer–Douglas–Peucker simplification on [x, y] arrays.
export function simplify(pts, eps) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let max = 0, idx = -1;
    const a = { x: pts[s][0], y: pts[s][1] }, b = { x: pts[e][0], y: pts[e][1] };
    for (let i = s + 1; i < e; i++) {
      const d = distToSeg({ x: pts[i][0], y: pts[i][1] }, a, b);
      if (d > max) { max = d; idx = i; }
    }
    if (max > eps && idx > 0) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
  }
  return pts.filter((_, i) => keep[i]);
}
