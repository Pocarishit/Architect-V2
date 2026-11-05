// Compact board previews for Archive thumbnails (stored alongside each board).
import { s } from '../core/dom.js';
import { lineGeom } from './geometry.js';
import { css } from './palette.js';

const r = (v) => Math.round(v);

export function makePreview(els, byId) {
  const out = [];
  for (const el of els) {
    if (out.length >= 400) break;
    if (el.type === 'line') {
      const g = lineGeom(el, byId);
      out.push(['l', r(g.a.x), r(g.a.y), r(g.b.x), r(g.b.y)]);
    } else if (el.type === 'pen') {
      const pts = el.points || [];
      const step = Math.max(1, Math.ceil(pts.length / 14));
      const sampled = pts.filter((_, i) => i % step === 0 || i === pts.length - 1).map(([x, y]) => [r(el.x + x), r(el.y + y)]);
      out.push(['p', sampled, el.stroke || 'auto']);
    } else {
      out.push(['b', el.type, r(el.x), r(el.y), r(el.w), r(el.h), el.fill || '', el.kind || '']);
    }
  }
  return out;
}

export function previewSvg(items) {
  const svg = s('svg', { class: 'pv', preserveAspectRatio: 'xMidYMid meet', 'aria-hidden': 'true' });
  if (!Array.isArray(items) || !items.length) return null;
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  const grow = (x, y) => { x1 = Math.min(x1, x); y1 = Math.min(y1, y); x2 = Math.max(x2, x); y2 = Math.max(y2, y); };
  for (const it of items) {
    if (it[0] === 'l') { grow(it[1], it[2]); grow(it[3], it[4]); }
    else if (it[0] === 'p') it[1].forEach(([x, y]) => grow(x, y));
    else if (it[0] === 'b') { grow(it[2], it[3]); grow(it[2] + it[4], it[3] + it[5]); }
  }
  const w = Math.max(x2 - x1, 1), hgt = Math.max(y2 - y1, 1);
  const pad = Math.max(w, hgt) * 0.08;
  svg.setAttribute('viewBox', `${x1 - pad} ${y1 - pad} ${w + pad * 2} ${hgt + pad * 2}`);
  const sw = Math.max(w, hgt) / 160;
  const isFrame = (it) => it[0] === 'b' && it[1] === 'frame';
  for (const it of [...items.filter(isFrame), ...items.filter((it) => !isFrame(it))]) {
    if (it[0] === 'l') {
      svg.append(s('line', { x1: it[1], y1: it[2], x2: it[3], y2: it[4], stroke: 'var(--fg-3)', 'stroke-width': sw }));
    } else if (it[0] === 'p') {
      svg.append(s('polyline', { points: it[1].map((p) => p.join(',')).join(' '), fill: 'none', stroke: 'var(--fg-2)', 'stroke-width': sw * 1.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    } else {
      const [, type, x, y, bw, bh, fill, kind] = it;
      if (type === 'frame') {
        svg.append(s('rect', { x, y, width: bw, height: bh, rx: sw * 2, fill: 'var(--s2)', stroke: 'var(--line-2)', 'stroke-width': sw }));
      } else if (type === 'sticky') {
        svg.append(s('rect', { x, y, width: bw, height: bh, rx: sw, fill: css(fill || '#FFFFFF') }));
      } else if (type === 'text') {
        svg.append(s('rect', { x, y: y + bh * 0.3, width: bw * 0.8, height: Math.max(bh * 0.4, sw * 2), rx: sw, fill: 'var(--fg-3)' }));
      } else if (type === 'shape') {
        const filled = fill && fill !== 'none';
        const attrs = { fill: filled ? css(fill) : 'none', stroke: filled ? 'none' : 'var(--fg-2)', 'stroke-width': sw };
        if (kind === 'ellipse') svg.append(s('ellipse', { cx: x + bw / 2, cy: y + bh / 2, rx: bw / 2, ry: bh / 2, ...attrs }));
        else svg.append(s('rect', { x, y, width: bw, height: bh, rx: kind === 'round' || kind === 'pill' ? Math.min(bw, bh) / 4 : 0, ...attrs }));
      } else {
        svg.append(s('rect', { x, y, width: bw, height: bh, rx: sw * 2, fill: 'var(--s3)', stroke: 'var(--line-2)', 'stroke-width': sw }));
      }
    }
  }
  return svg;
}
