// Space backgrounds (Nov 24) — Settings → Personalize.
// Each Space can have its own background, chosen per account (so it's always a personal preference: in the
// shared Space only you see yours, everyone else keeps their own view). The board and its objects never
// change.
//   · a built-in pattern: the crossed-line square grid, a dotted grid, graph-paper squares, or plain
//   · your own PNG: Fill (one image across the background) or Tile (repeated across the canvas, with a
//     scale for the size of each repeat)
// Patterns and tiles move and zoom with the canvas, like the board's own grid; a filled image stays put.
// Saved in prefs as spaceBg = { personal: {…}, shared: {…} }. The older personalBg (one PNG) still counts.
import { api } from '../data/api.js';
import { getPref, setPref } from '../data/prefs.js';

export const PATTERNS = [
  { id: 'cross', label: 'Square grid' },
  { id: 'dots', label: 'Dotted grid' },
  { id: 'graph', label: 'Graph paper' },
  { id: 'plain', label: 'Plain' },
];
const PATTERN_IDS = new Set(PATTERNS.map((p) => p.id));
const TILE_BASE = 240; // px width of one repeat at 100%

const clean = (b) => {
  if (!b || typeof b !== 'object') return { kind: 'none' };
  if (b.kind === 'pattern' && PATTERN_IDS.has(b.pattern)) return { kind: 'pattern', pattern: b.pattern };
  if (b.kind === 'image' && b.path) return { kind: 'image', path: b.path, layout: b.layout === 'tile' ? 'tile' : 'fill', scale: Math.min(4, Math.max(0.1, Number(b.scale) || 1)) };
  return { kind: 'none' };
};

/** The saved background of one Space ('personal' | 'shared'). */
export function bgOf(space) {
  const all = getPref('spaceBg', null) || {};
  if (all[space]) return clean(all[space]);
  // Before Nov 24 the personal Space could only hold one PNG, as a fill.
  if (space === 'personal' && getPref('personalBg', null)) return { kind: 'image', path: getPref('personalBg', null), layout: 'fill', scale: 1 };
  return { kind: 'none' };
}

export async function setBg(space, bg) {
  const all = { ...(getPref('spaceBg', null) || {}), [space]: clean(bg) };
  await setPref('spaceBg', all);
  if (space === 'personal' && getPref('personalBg', null)) await setPref('personalBg', null).catch(() => {});
  window.dispatchEvent(new CustomEvent('architect:space-bg', { detail: { space } }));
}

const urls = new Map(); // path → signed url
async function urlFor(path) {
  if (urls.has(path)) return urls.get(path);
  const u = (await api.media.sign([path]))?.[path] || null;
  if (u) { urls.set(path, u); setTimeout(() => urls.delete(path), 50 * 60_000); }
  return u;
}

/**
 * Paint a background onto `node` (a Space page or a preview box). cam: { x, y, z } keeps patterns and
 * tiles in step with the canvas; leave it out for a still preview.
 */
export async function paintBg(node, bg, cam = null) {
  bg = clean(bg);
  if (bg.kind === 'none') { delete node.dataset.sbg; node.style.removeProperty('--sbg-img'); node.style.removeProperty('--sbg-tile'); return; }
  if (bg.kind === 'pattern') {
    node.dataset.sbg = bg.pattern;
    node.style.removeProperty('--sbg-img');
  } else {
    let url = null;
    try { url = await urlFor(bg.path); } catch {}
    if (!url) { delete node.dataset.sbg; return; }
    node.dataset.sbg = bg.layout === 'tile' ? 'tile' : 'fill';
    node.style.setProperty('--sbg-img', `url("${url.replace(/"/g, '%22')}")`);
    node.style.setProperty('--sbg-tile', String(TILE_BASE * bg.scale));
  }
  moveBg(node, cam);
}

/** Keep the pattern / tiles under the canvas as it pans and zooms. */
export function moveBg(node, cam) {
  const c = cam || { x: 0, y: 0, z: 1 };
  const z = Math.max(0.05, Number(c.z) || 1);
  node.style.setProperty('--sbg-x', `${Math.round(c.x * 100) / 100}px`);
  node.style.setProperty('--sbg-y', `${Math.round(c.y * 100) / 100}px`);
  node.style.setProperty('--sbg-z', String(Math.round(z * 1000) / 1000));
}
