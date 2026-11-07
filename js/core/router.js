// Hash router: #/ (the Space), #/paths, #/parasites (Ticket board), #/blueprint[/<folderId>], #/board/<boardId>
export function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean);
  const [view, id] = parts;
  if (!view || view === 'space') return { view: 'space' };
  if (view === 'paths') return { view: 'paths', id: id || null };
  if (view === 'blueprint') return { view: 'blueprint', id: id || null };
  if (view === 'parasites' || view === 'tickets') return { view: 'parasites', id: id || null };
  if (view === 'board' && id) return { view: 'board', id };
  return { view: 'space', redirect: true };
}

export function go(path) {
  const target = '#/' + path.replace(/^#?\/?/, '');
  if (location.hash === target) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = target;
}
