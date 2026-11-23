import { api } from './data/api.js';
import { parseRoute } from './core/router.js';
import { closeFloating } from './core/ui.js';
import { mountLogin } from './views/login.js';
import { mountShell } from './views/shell.js';
import { mountArchive } from './views/archive.js';
import { mountSpace } from './views/space.js';
import { resetPrefs } from './data/prefs.js';
import { resetAvatars } from './data/profile.js';
import { applyCustom, clearCustom } from './core/custom.js';
import { mountBoard } from './board/board.js';
import { installGuards, onEscapeFull } from './core/guard.js';
import { go } from './core/router.js';

const app = document.getElementById('app');
let session = null;
let shell = null;
let view = null;
let login = null;
let viewName = null;
let escOff = null;

function teardownView() {
  closeFloating();
  try { view?.destroy?.(); } catch (e) { console.error(e); }
  escOff?.(); escOff = null;
  view = null;
  viewName = null;
}

function render() {
  teardownView();
  shell?.destroy();
  shell = null;
  login?.destroy();
  login = null;
  app.replaceChildren();
  document.body.classList.remove('is-board', 'is-space');

  if (!session) {
    clearCustom();
    login = mountLogin(app, {
      onDone(s) {
        session = s;
        if (parseRoute().redirect) history.replaceState(null, '', '#/');
        render();
      },
    });
    return;
  }
  applyCustom();
  shell = mountShell(app, { session });
  route();
}

function route() {
  if (!session || !shell) return;
  const r = parseRoute();
  if (r.redirect) history.replaceState(null, '', '#/');
  if (r.focus) { try { sessionStorage.setItem('architect.focus', r.focus); } catch {} if (view?.focus && viewName === 'space') { view.focus(r.focus); return; } }
  // Same view, different sub-page (e.g. a path opened on mobile): update in place, no reload.
  if (view?.update && viewName === r.view) { view.update(r); return; }
  teardownView();
  viewName = r.view;
  shell.outlet.replaceChildren();
  shell.setActive(r.view);
  document.body.classList.toggle('is-board', r.view === 'board' || r.view === 'space');
  document.body.classList.toggle('is-space', r.view === 'space');
  window.scrollTo(0, 0);
  // The Space is home; Archives and full-page Blueprints open on top of it.
  if (r.view === 'space') view = mountSpace(shell.outlet);
  else if (r.view === 'blueprint') view = mountArchive(shell.outlet, r.id);
  else if (r.view === 'board') view = mountBoard(shell.outlet, r.id);
  // Ctrl+Esc (or Esc twice) from any full-page view goes back to the Space.
  if (r.view !== 'space') escOff = onEscapeFull(() => { go(''); });
}

async function boot() {
  installGuards();
  try {
    session = await api.auth.init();
  } catch (e) {
    console.error(e);
    session = null;
  }
  api.auth.onChange((s) => {
    const was = !!session;
    if (session?.user?.id !== s?.user?.id) { resetPrefs(); resetAvatars(); }
    session = s;
    if (was !== !!s) render();
  });
  window.addEventListener('hashchange', route);
  render();
}

boot();

// Offline (Nov 23): cache the app shell on this device so Architect reloads with no connection.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Offline cache unavailable', e)); });
}
