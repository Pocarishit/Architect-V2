import { h } from './core/dom.js';
import { api } from './data/api.js';
import { parseRoute } from './core/router.js';
import { closeFloating } from './core/ui.js';
import { mountLogin } from './views/login.js';
import { mountShell } from './views/shell.js';
import { mountPaths } from './views/paths.js';
import { mountArchive } from './views/archive.js';
import { mountTracker } from './views/tracker.js';
import { mountParasites } from './views/parasites.js';
import { mountCountdown } from './views/countdown.js';
import { mountMeter } from './views/meter.js';
import { resetPrefs } from './data/prefs.js';
import { mountBoard } from './board/board.js';

const app = document.getElementById('app');
let session = null;
let shell = null;
let view = null;
let login = null;
let viewName = null;

function teardownView() {
  closeFloating();
  try { view?.destroy?.(); } catch (e) { console.error(e); }
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
  document.body.classList.remove('is-board');

  if (!session) {
    login = mountLogin(app, {
      onDone(s) {
        session = s;
        if (parseRoute().redirect) history.replaceState(null, '', '#/paths');
        render();
      },
    });
    return;
  }
  shell = mountShell(app, { session });
  route();
}

function route() {
  if (!session || !shell) return;
  const r = parseRoute();
  if (r.redirect) { history.replaceState(null, '', '#/paths'); }
  // Same view, different sub-page (e.g. a path opened on mobile): update in place, no reload.
  if (view?.update && viewName === r.view) { view.update(r); return; }
  teardownView();
  viewName = r.view;
  shell.outlet.replaceChildren();
  shell.setActive(r.view);
  document.body.classList.toggle('is-board', r.view === 'board');
  window.scrollTo(0, 0);
  // Tracker, Countdown and Meter live under one tab, switched by a small strip on top.
  const GROUP = [['tracker', 'Tracker'], ['countdown', 'Countdown'], ['meter', 'Meter']];
  if (GROUP.some(([id]) => id === r.view)) {
    shell.outlet.append(h('nav', { class: 'subtabs', 'aria-label': 'Metrics sections' },
      GROUP.map(([id, label]) => h('a', { href: `#/${id}`, class: ['subtab', id === r.view && 'is-on'], 'aria-current': id === r.view ? 'page' : null }, label))));
  }
  if (r.view === 'paths') view = mountPaths(shell.outlet, r.id);
  else if (r.view === 'tracker') view = mountTracker(shell.outlet);
  else if (r.view === 'parasites') view = mountParasites(shell.outlet);
  else if (r.view === 'countdown') view = mountCountdown(shell.outlet);
  else if (r.view === 'meter') view = mountMeter(shell.outlet);
  else if (r.view === 'blueprint') view = mountArchive(shell.outlet, r.id);
  else if (r.view === 'board') view = mountBoard(shell.outlet, r.id);
}

async function boot() {
  try {
    session = await api.auth.init();
  } catch (e) {
    console.error(e);
    session = null;
  }
  api.auth.onChange((s) => {
    const was = !!session;
    if (session?.user?.id !== s?.user?.id) resetPrefs();
    session = s;
    if (was !== !!s) render();
  });
  window.addEventListener('hashchange', route);
  render();
}

boot();
