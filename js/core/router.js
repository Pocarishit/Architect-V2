// Hash router: #/paths, #/blueprint, #/blueprint/<folderId>, #/board/<boardId>
export function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const [view, id] = parts;
  if (view === 'paths') return { view: 'paths', id: id || null };
  if (view === 'blueprint') return { view: 'blueprint', id: id || null };
  if (view === 'board' && id) return { view: 'board', id };
  return { view: 'paths', redirect: true };
}

export function go(path) {
  const target = '#/' + path.replace(/^#?\/?/, '');
  if (location.hash === target) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = target;
}
