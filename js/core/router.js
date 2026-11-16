// Hash router: #/ (the Space), #/blueprint[/<folderId>] (Archives), #/board/<boardId>. Old #/paths and #/parasites links land in the Space.
export function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean);
  const [view, id] = parts;
  if (!view || view === 'space') return { view: 'space' };
  // The old full-page Paths and Ticket board (the 2D, non-free-mode version) are retired:
  // links to them open the Space and fly to your Path instead.
  if (view === 'paths' || view === 'parasites' || view === 'tickets') return { view: 'space', redirect: true, focus: 'path' };
  if (view === 'blueprint') return { view: 'blueprint', id: id || null };
  if (view === 'board' && id) return { view: 'board', id };
  return { view: 'space', redirect: true };
}

export function go(path) {
  const target = '#/' + path.replace(/^#?\/?/, '');
  if (location.hash === target) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = target;
}
