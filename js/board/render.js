// Creates and patches the DOM node for each board element.
import { h, s } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { css, onColor } from './palette.js';
import { lineGeom, capPath, shapePath, penPath } from './geometry.js';
import { sanitize } from './richtext.js';

export const FONTS = [
  { id: 'sans', name: 'Space Grotesk' },
  { id: 'noto', name: 'Noto Sans' },
  { id: 'mono', name: 'Space Mono' },
  { id: 'dot', name: 'Doto' },
  { id: 'serif', name: 'Instrument Serif' },
  { id: 'hand', name: 'Caveat' },
];
const FONT = Object.fromEntries(FONTS.map((f) => [f.id, `f-${f.id}`]));
const STICKY_PAD = 16;

export function createNode(el) {
  const node = el.type === 'line' || el.type === 'pen'
    ? s('svg', { class: `el el-${el.type}`, 'data-eid': el.id })
    : h('div', { class: `el el-${el.type}`, 'data-eid': el.id });
  node._type = el.type;
  return node;
}

function place(node, el, autoHeight = false) {
  const st = node.style;
  st.left = `${el.x}px`;
  st.top = `${el.y}px`;
  st.width = `${Math.max(1, el.w)}px`;
  st.height = autoHeight ? '' : `${Math.max(1, el.h)}px`;
}

function textBlock(node, el, { align = 'left', size = 18, placeholder = 'Type something' } = {}) {
  let t = node._text;
  if (!t) {
    t = h('div', { class: 'el-txt' });
    node.append(t);
    node._text = t;
  }
  t.className = ['el-txt', FONT[el.font] || 'f-sans', el.bold && 'is-bold', el.italic && 'is-italic', el.underline && 'is-underline', el.strike && 'is-strike'].filter(Boolean).join(' ');
  t.style.textAlign = el.align || align;
  if (el.fontSize) t.style.fontSize = `${el.fontSize}px`;
  else if (size) t.style.fontSize = `${size}px`;
  t.dataset.ph = placeholder;
  if (!t.isContentEditable) {
    const key = el.html ? `h:${el.html}` : `t:${el.text || ''}`;
    if (t._key !== key) {
      if (el.html) t.innerHTML = sanitize(el.html);
      else t.textContent = el.text || '';
      t._key = key;
    }
  }
  return t;
}

// Shrink sticky text until it fits (Miro-style auto size).
export function fitText(node, el) {
  const t = node._text;
  if (!t || el.fontSize) return;
  const availH = el.h - STICKY_PAD * 2;
  let hi = Math.max(10, Math.min(64, Math.min(el.w, el.h) * 0.15));
  let lo = 5;
  t.style.fontSize = `${hi}px`;
  if (t.scrollHeight <= availH + 0.5) return;
  for (let i = 0; i < 7; i++) {
    const mid = (lo + hi) / 2;
    t.style.fontSize = `${mid}px`;
    if (t.scrollHeight <= availH + 0.5) lo = mid; else hi = mid;
  }
  t.style.fontSize = `${lo}px`;
}

function shield(label) {
  return h('div', { class: 'el-shield' }, h('span', { class: 'el-badge' }, icon('play', 12), label));
}

function safeMedia(url) {
  return typeof url === 'string' && /^(https?:|blob:|data:(image|video)\/)/i.test(url) ? url : null;
}

function safeHref(url) {
  try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? u.href : null; } catch { return null; }
}

export function updateNode(node, el, ctx) {
  node.classList.toggle('is-locked', !!el.locked);
  switch (el.type) {
    case 'sticky': {
      place(node, el);
      const fill = el.fill || '#FFFFFF';
      node.style.background = css(fill);
      node.style.color = el.color ? css(el.color) : onColor(fill);
      textBlock(node, el, { align: 'center', size: 0, placeholder: 'Write an idea' });
      fitText(node, el);
      break;
    }
    case 'text': {
      place(node, el, true);
      // autoW: the box hugs its text (click-created text), up to 640px, then wraps.
      node.style.width = el.autoW ? 'max-content' : `${Math.max(40, el.w)}px`;
      node.style.maxWidth = el.autoW ? '640px' : '';
      node.style.minWidth = el.autoW ? '24px' : '';
      node.style.color = css(el.color || 'auto');
      node.style.background = el.fill && el.fill !== 'none' ? css(el.fill) : '';
      node.classList.toggle('has-fill', !!(el.fill && el.fill !== 'none'));
      textBlock(node, el, { size: 22, placeholder: 'Type something' });
      break;
    }
    case 'shape': {
      place(node, el);
      if (!node._svg) {
        node._path = s('path');
        node._svg = s('svg', { class: 'el-shape-svg' }, node._path);
        node.prepend(node._svg);
      }
      const p = node._path;
      const sw = el.strokeWidth ?? 2;
      const stroke = el.stroke ?? 'auto';
      p.setAttribute('d', shapePath(el.kind || 'rect', el.w, el.h));
      p.setAttribute('fill', css(el.fill || 'none'));
      p.setAttribute('stroke', stroke === 'none' ? 'none' : css(stroke));
      p.setAttribute('stroke-width', sw);
      p.setAttribute('stroke-linejoin', 'round');
      p.setAttribute('stroke-linecap', 'round');
      p.setAttribute('stroke-dasharray', el.dash === 'dashed' ? `${sw * 4} ${sw * 3}` : el.dash === 'dotted' ? `0 ${sw * 2.6}` : '');
      node.style.color = el.color ? css(el.color) : onColor(el.fill || 'none');
      textBlock(node, el, { align: 'center', size: 16, placeholder: '' });
      break;
    }
    case 'frame': {
      place(node, el);
      if (!node._title) {
        node._body = h('div', { class: 'el-frame-body' });
        node._title = h('div', { class: 'el-frame-title' });
        node.append(node._body, node._title);
      }
      if (!node._title.isContentEditable) node._title.textContent = el.title || 'Frame';
      node._body.style.background = el.fill && el.fill !== 'none' ? css(el.fill) : '';
      break;
    }
    case 'image': {
      place(node, el);
      const url = safeMedia(ctx.mediaUrl(el));
      if (url) {
        if (!node._img) {
          node._img = h('img', { alt: el.alt || '' });
          node._img.setAttribute('draggable', 'false');
          node.replaceChildren(node._img);
        }
        if (node._img.getAttribute('src') !== url) node._img.setAttribute('src', url);
      } else {
        node._img = null;
        node.replaceChildren(h('div', { class: 'el-missing' }, icon('image', 22), h('span', {}, el.path ? 'Loading image' : 'Image unavailable')));
      }
      break;
    }
    case 'video': {
      place(node, el);
      const url = safeMedia(ctx.mediaUrl(el));
      const live = ctx.activeId === el.id;
      if (url) {
        if (!node._video) {
          node._video = h('video', { class: 'el-media', playsinline: '', preload: 'metadata' });
          node._shield = shield('Double-click to play');
          node.replaceChildren(node._video, node._shield);
        }
        if (node._video.getAttribute('src') !== url) node._video.setAttribute('src', url);
        node._video.controls = live;
        if (!live && !node._video.paused) node._video.pause();
      } else {
        node._video = null;
        node.replaceChildren(h('div', { class: 'el-missing' }, icon('video', 22), h('span', {}, el.path ? 'Loading video' : 'Video unavailable')));
      }
      node.classList.toggle('is-live', live);
      break;
    }
    case 'embed': {
      place(node, el);
      const live = ctx.activeId === el.id;
      if (!safeHref(el.embed)) {
        node._frame = null;
        node.replaceChildren(h('div', { class: 'el-missing' }, icon('embed', 22), h('span', {}, 'Embed unavailable')));
        break;
      }
      if (!node._frame || node._frame.dataset.src !== el.embed) {
        const attrs = {
          class: 'el-media',
          src: el.embed,
          title: el.provider || 'Embedded page',
          allow: 'autoplay; encrypted-media; picture-in-picture; fullscreen; clipboard-write',
          allowfullscreen: '',
          referrerpolicy: 'strict-origin-when-cross-origin',
          loading: 'lazy',
        };
        if (el.provider === 'Web page') attrs.sandbox = 'allow-scripts allow-same-origin allow-popups allow-forms';
        node._frame = h('iframe', attrs);
        node._frame.dataset.src = el.embed;
        node.replaceChildren(
          node._frame,
          h('span', { class: 'el-chip' }, el.provider || 'Embed'),
          shield(el.provider === 'Spotify' || el.provider === 'Web page' || el.provider === 'Google Maps' || el.provider === 'Figma' || el.provider === 'Google Docs' || el.provider === 'Google Drive' ? 'Double-click to interact' : 'Double-click to play'),
        );
      }
      node.classList.toggle('is-live', live);
      break;
    }
    case 'link': {
      place(node, el);
      const sig = `${el.url}|${el.title}|${el.host}`;
      if (node._sig !== sig) {
        node._sig = sig;
        const href = safeHref(el.url);
        node.replaceChildren(h('div', { class: 'lk' },
          h('div', { class: 'lk-top' }, icon('link', 14), h('span', { class: 'lk-host' }, el.host || '')),
          h('div', { class: 'lk-title' }, el.title || el.url || ''),
          href ? h('a', { class: 'lk-open', href, target: '_blank', rel: 'noopener noreferrer', 'data-noptr': '' }, 'Open', icon('external', 13)) : null));
      }
      break;
    }
    case 'line': {
      const g = lineGeom(el, ctx.byId);
      const sw = el.strokeWidth ?? 2;
      const color = css(el.stroke ?? 'auto');
      if (!node._vis) {
        node._hit = s('path', { class: 'hit' });
        node._vis = s('path', { class: 'vis', fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
        node._ca = s('path', { 'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
        node._cb = s('path', { 'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
        node.append(node._hit, node._vis, node._ca, node._cb);
      }
      const size = 7 + sw * 2.4;
      const ca = capPath(g.a, g.tanA, size, el.startCap || 'none');
      const cb = capPath(g.b, g.tanB, size, el.endCap || 'none');
      const sig = `${g.d}|${sw}|${color}|${el.dash}|${el.startCap}|${el.endCap}`;
      if (node._sig === sig) break;
      node._sig = sig;
      node._hit.setAttribute('d', g.d);
      node._hit.setAttribute('stroke-width', Math.max(14, sw + 12));
      node._vis.setAttribute('d', g.d);
      node._vis.setAttribute('stroke', color);
      node._vis.setAttribute('stroke-width', sw);
      node._vis.setAttribute('stroke-dasharray', el.dash === 'dashed' ? `${sw * 4} ${sw * 3}` : el.dash === 'dotted' ? `0 ${sw * 2.6}` : '');
      for (const [p, c] of [[node._ca, ca], [node._cb, cb]]) {
        if (!c) { p.setAttribute('d', ''); continue; }
        p.setAttribute('d', c.d);
        p.setAttribute('fill', c.fill ? color : 'none');
        p.setAttribute('stroke', color);
        p.setAttribute('stroke-width', sw);
      }
      break;
    }
    case 'pen': {
      if (!node._g) {
        node._hit = s('path', { class: 'hit' });
        node._vis = s('path', { class: 'vis', fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
        node._g = s('g', {}, node._hit, node._vis);
        node.append(node._g);
      }
      node._g.setAttribute('transform', `translate(${el.x} ${el.y})`);
      if (node._pts !== el.points) {
        node._pts = el.points;
        const d = penPath(el.points || []);
        node._hit.setAttribute('d', d);
        node._vis.setAttribute('d', d);
      }
      const sw = el.strokeWidth ?? 3;
      node._vis.setAttribute('stroke', css(el.stroke || 'auto'));
      node._vis.setAttribute('stroke-width', sw);
      node._vis.setAttribute('opacity', el.opacity ?? 1);
      node._hit.setAttribute('stroke-width', Math.max(12, sw + 10));
      break;
    }
    default:
      place(node, el);
  }
}
