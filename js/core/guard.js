// App-wide keyboard + zoom guards.
//
// 1) Browser zoom never kicks in by accident. Ctrl/⌘ + scroll, trackpad pinches and Ctrl/⌘ +/- used to
//    zoom the whole page whenever the pointer or focus was on a menu, toolbar or inside a widget — Chrome
//    then remembers that zoom for the site, so the bigger UI became the "default view" and, past the
//    phone breakpoint, the Blueprint toolbar dropped out. The canvas handles its own zoom; the page doesn't.
//    Ctrl/⌘ + 0 is left alone so an already-zoomed browser can always be reset.
//
// 2) Escape from a full-screen object: Ctrl+Esc (or Esc twice, quickly — Windows keeps Ctrl+Esc for the
//    Start menu) closes whatever is open on top: a Blueprint window, a full-page Blueprint, an expanded
//    ticket, the full-page Path or Ticket board.
import { isTypingTarget } from './dom.js';

const stack = [];

/** Register what "escape out" means right now. Returns a function that unregisters it. */
export function onEscapeFull(fn) {
  const entry = { fn };
  stack.push(entry);
  return () => { const i = stack.indexOf(entry); if (i >= 0) stack.splice(i, 1); };
}

export function escapeFull() {
  for (let i = stack.length - 1; i >= 0; i--) {
    try { if (stack[i].fn() !== false) return true; } catch (e) { console.error(e); }
  }
  return false;
}

let installed = false;
export function installGuards() {
  if (installed) return;
  installed = true;

  window.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault(); // the canvas still zooms (it reads the event itself); the page never does
  }, { passive: false, capture: true });

  // Safari pinch gestures.
  for (const t of ['gesturestart', 'gesturechange']) document.addEventListener(t, (e) => e.preventDefault(), { passive: false });

  let lastEsc = 0;
  window.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.altKey && ['=', '+', '-', '_'].includes(e.key)) e.preventDefault(); // page zoom; the canvas zooms itself

    if (e.key !== 'Escape') return;
    if (mod) {
      if (escapeFull()) { e.preventDefault(); e.stopPropagation(); }
      lastEsc = 0;
      return;
    }
    // Esc, Esc: same thing, when nothing else wants the key.
    const busy = isTypingTarget(e.target) || document.querySelector('.dlg-overlay, .menu, .popover, .is-presenting');
    const now = performance.now();
    if (!busy && now - lastEsc < 450) {
      lastEsc = 0;
      if (escapeFull()) { e.preventDefault(); e.stopPropagation(); }
      return;
    }
    lastEsc = busy ? 0 : now;
  }, true);
}
