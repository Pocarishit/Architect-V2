import { api } from './data/api.js';
import { parseRoute } from './core/router.js';
import { closeFloating } from './core/ui.js';
import { mountLogin } from './views/login.js';
import { mountShell } from './views/shell.js';
import { mountPaths } from './views/paths.js';
import { mountArchive } from './views/archive.js';
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
  if (r.view === 'paths') view = mountPaths(shell.outlet, r.id);
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
    session = s;
    if (was !== !!s) render();
  });
  window.addEventListener('hashchange', route);
  render();
}

boot();
