import { h } from './dom.js';
import { icon } from './icons.js';
import { kbd } from './util.js';

/* ---------- Toasts ---------- */
let toastHost = null;
export function toast(message, { tone = 'default', ms = 2800 } = {}) {
  if (!toastHost || !toastHost.isConnected) {
    toastHost = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastHost);
  }
  const label = h('span', {}, message);
  const t = h('div', { class: ['toast', `toast-${tone}`] }, tone === 'error' ? h('i', { class: 'toast-dot' }) : null, label);
  toastHost.append(t);
  requestAnimationFrame(() => t.classList.add('in'));
  let timer = null;
  const close = () => {
    clearTimeout(timer);
    t.classList.remove('in');
    setTimeout(() => t.remove(), 220);
  };
  if (ms) timer = setTimeout(close, ms);
  return { close, update(m) { label.textContent = m; } };
}

/* ---------- Floating layer (menus / popovers) ---------- */
let floating = null;

export function closeFloating() {
  if (floating) {
    const f = floating;
    floating = null;
    f.cleanup();
  }
}

function anchorRect(anchor) {
  if (anchor instanceof Element) return anchor.getBoundingClientRect();
  return { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y, width: 0, height: 0 };
}

function place(panel, anchor, { side = 'bottom', align = 'start', gap = 6 } = {}) {
  const r = anchorRect(anchor);
  panel.style.visibility = 'hidden';
  panel.style.left = '0px';
  panel.style.top = '0px';
  const pw = panel.offsetWidth, ph = panel.offsetHeight;
  const vw = window.innerWidth, vh = window.innerHeight;
  let x, y;
  if (side === 'right' || side === 'left') {
    x = side === 'right' ? r.right + gap : r.left - pw - gap;
    if (side === 'right' && x + pw > vw - 8) x = r.left - pw - gap;
    if (side === 'left' && x < 8) x = r.right + gap;
    y = align === 'center' ? r.top + r.height / 2 - ph / 2 : r.top;
  } else {
    y = side === 'bottom' ? r.bottom + gap : r.top - ph - gap;
    if (side === 'bottom' && y + ph > vh - 8 && r.top - ph - gap > 8) y = r.top - ph - gap;
    if (side === 'top' && y < 8) y = r.bottom + gap;
    x = align === 'end' ? r.right - pw : align === 'center' ? r.left + r.width / 2 - pw / 2 : r.left;
  }
  x = Math.max(8, Math.min(x, vw - pw - 8));
  y = Math.max(8, Math.min(y, vh - ph - 8));
  panel.style.left = `${Math.round(x)}px`;
  panel.style.top = `${Math.round(y)}px`;
  panel.style.visibility = '';
}

// True when the anchor was just used to close its own menu (so the trailing click shouldn't reopen it).
export function justClosed(anchor) {
  return anchor instanceof Element && anchor._closedAt && performance.now() - anchor._closedAt < 400;
}

function openFloating(panel, anchor, opts = {}) {
  closeFloating();
  document.body.append(panel);
  place(panel, anchor, opts);
  const onDown = (e) => {
    if (panel.contains(e.target)) return;
    if (anchor instanceof Element && anchor.contains(e.target) && opts.toggle !== false) {
      anchor._closedAt = performance.now();
      closeFloating();
      return;
    }
    closeFloating();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFloating(); if (anchor instanceof Element) anchor.focus?.(); }
  };
  const onResize = () => closeFloating();
  setTimeout(() => {
    document.addEventListener('pointerdown', onDown, true);
  }, 0);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', onResize);
  if (anchor instanceof Element) anchor.classList.add('is-open');
  floating = {
    panel,
    cleanup() {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onResize);
      if (anchor instanceof Element) anchor.classList.remove('is-open');
      panel.remove();
      opts.onClose?.();
    },
  };
  return { close: closeFloating, panel, reposition: () => place(panel, anchor, opts) };
}

/* items: [{ label, icon, kbd, onSelect, danger, disabled, checked }] | '-' | { header } */
export function menu(anchor, items, opts = {}) {
  if (justClosed(anchor)) return null;
  const panel = h('div', { class: 'menu', role: 'menu' });
  for (const it of items) {
    if (!it) continue;
    if (it === '-') { panel.append(h('div', { class: 'menu-sep', role: 'separator' })); continue; }
    if (it.header) { panel.append(h('div', { class: 'menu-head' }, it.header)); continue; }
    panel.append(
      h('button', {
        class: ['menu-item', it.danger && 'is-danger'],
        role: it.checked != null ? 'menuitemcheckbox' : 'menuitem',
        'aria-checked': it.checked != null ? String(!!it.checked) : null,
        disabled: !!it.disabled,
        type: 'button',
        onmousedown: (e) => e.preventDefault(),
        onclick: (e) => { e.stopPropagation(); closeFloating(); it.onSelect?.(); },
      },
        it.icon ? icon(it.icon, 16) : h('span', { class: 'menu-ic-sp' }),
        h('span', { class: ['menu-label', it.labelClass] }, it.label),
        it.kbd ? h('kbd', {}, kbd(it.kbd)) : null,
        it.checked != null ? h('span', { class: 'menu-check' }, it.checked ? icon('check', 14) : null) : null,
      ),
    );
  }
  panel.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const btns = [...panel.querySelectorAll('.menu-item:not(:disabled)')];
    const i = btns.indexOf(document.activeElement);
    const n = e.key === 'ArrowDown' ? (i + 1) % btns.length : (i - 1 + btns.length) % btns.length;
    btns[n]?.focus();
  });
  const f = openFloating(panel, anchor, { side: 'bottom', align: 'start', ...opts });
  if (opts.focusFirst !== false && !(anchor && anchor.x != null)) {
    requestAnimationFrame(() => panel.querySelector('.menu-item:not(:disabled)')?.focus({ preventScroll: true }));
  }
  return f;
}

export function popover(anchor, content, opts = {}) {
  if (justClosed(anchor)) return null;
  const panel = h('div', { class: ['popover', opts.class] }, content);
  panel.addEventListener('mousedown', (e) => {
    if (!(e.target instanceof Element) || !e.target.closest('input, textarea')) e.preventDefault();
  });
  return openFloating(panel, anchor, { side: 'bottom', align: 'center', ...opts });
}

/* ---------- Dialogs ---------- */
export function dialog({ title, body, actions = [], width = 420, className }) {
  closeFloating();
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    let done = false;
    const close = (val) => {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey, true);
      overlay.classList.remove('in');
      setTimeout(() => overlay.remove(), 160);
      if (prevFocus instanceof HTMLElement) prevFocus.focus({ preventScroll: true });
      resolve(val);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); }
    };
    const primary = actions.find((a) => a.primary);
    const form = h('form', {
      class: ['dlg', className],
      style: { width: `min(${width}px, calc(100vw - 32px))` },
      role: 'dialog',
      'aria-modal': 'true',
      onsubmit: (e) => {
        e.preventDefault();
        if (!primary) return;
        const v = typeof primary.value === 'function' ? primary.value() : primary.value;
        if (v === undefined) return; // validation failed, stay open
        close(v);
      },
    },
      title ? h('h2', { class: 'dlg-title' }, title) : null,
      body,
      actions.length ? h('div', { class: 'dlg-actions' }, actions.map((a) =>
        h('button', {
          class: ['btn', a.primary && 'btn-primary', a.danger && 'btn-danger'],
          type: a.primary ? 'submit' : 'button',
          onclick: a.primary ? null : () => close(typeof a.value === 'function' ? a.value() : a.value),
        }, a.label))) : null,
    );
    const overlay = h('div', { class: 'dlg-overlay', onpointerdown: (e) => { if (e.target === overlay) close(null); } }, form);
    document.body.append(overlay);
    document.addEventListener('keydown', onKey, true);
    requestAnimationFrame(() => {
      overlay.classList.add('in');
      const f = form.querySelector('[autofocus]') || form.querySelector('input, textarea') || form.querySelector('.btn-primary');
      f?.focus();
      if (f instanceof HTMLInputElement) f.select();
    });
    form._close = close;
  });
}

export async function confirmDialog(title, message, { ok = 'Delete', danger = true } = {}) {
  const v = await dialog({
    title,
    body: message ? h('p', { class: 'dlg-text' }, message) : null,
    actions: [{ label: 'Cancel', value: false }, { label: ok, primary: true, danger, value: true }],
  });
  return !!v;
}

export async function promptDialog(title, { value = '', placeholder = '', ok = 'Save', label, maxLength = 120 } = {}) {
  const input = h('input', { class: 'input', value, placeholder, maxlength: maxLength, autofocus: true, 'aria-label': label || title });
  const v = await dialog({
    title,
    body: h('label', { class: 'field' }, label ? h('span', { class: 'field-label' }, label) : null, input),
    actions: [{ label: 'Cancel', value: null }, { label: ok, primary: true, value: () => input.value.trim() }],
  });
  return v == null ? null : v;
}
