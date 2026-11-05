import { h, delegate, isTypingTarget } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { menu, toast, confirmDialog, dialog } from '../core/ui.js';
import { uid, timeAgo, store, plural } from '../core/util.js';
import { go } from '../core/router.js';
import { api, friendlyError } from '../data/api.js';
import { previewSvg } from '../board/preview.js';

const BOARD_COLS = 'id,user_id,name,folder_id,pinned,preview,created_at,updated_at';
let cache = null; // { folders, boards } — instant paint when moving between folders

export function mountArchive(root, folderId) {
  let folders = cache?.folders || [];
  let boards = cache?.boards || [];
  let loading = !cache;
  let loadError = null;
  let query = '';
  let sort = store.get('architect.archive.sort', 'updated');
  let renaming = null; // { kind, id }
  const meId = api.auth.current()?.user?.id || null;
  let owners = cache?.owners || new Map(); // owner id → username, for boards shared with you
  let sharedOut = cache?.sharedOut || new Set(); // your boards that other people can edit
  const isMine = (b) => !b.user_id || !meId || b.user_id === meId;

  const el = h('div', { class: 'view archive' });
  root.append(el);
  const fail = (e) => toast(friendlyError(e), { tone: 'error', ms: 5000 });
  const pending = new Map(); // id → insert promise, so follow-up updates never race the insert
  const afterInsert = (id) => pending.get(id) || Promise.resolve();

  async function load() {
    try {
      const [f, b] = await Promise.all([
        api.db.select('archive_folders', { order: 'name.asc' }),
        api.db.select('blueprints', { columns: BOARD_COLS, order: 'updated_at.desc' }),
      ]);
      folders = f;
      boards = b;
      loadError = null;
      if (api.mode !== 'local') await loadSharing();
      cache = { folders, boards, owners, sharedOut };
    } catch (e) {
      loadError = friendlyError(e);
    }
    loading = false;
    render();
  }

  // Who shared what. Quietly skipped if sharing isn't set up in Supabase yet.
  async function loadSharing() {
    const ownerIds = [...new Set(boards.filter((b) => !isMine(b)).map((b) => b.user_id))];
    const [people, members] = await Promise.all([
      ownerIds.length ? api.db.select('profiles', { columns: 'id,username', filters: { id: ownerIds } }).catch(() => []) : [],
      api.db.select('blueprint_members', { columns: 'board_id,user_id' }).catch(() => []),
    ]);
    owners = new Map(people.map((p) => [p.id, p.username]));
    sharedOut = new Set(members.filter((m) => m.user_id !== meId).map((m) => m.board_id));
  }

  const folderById = (id) => folders.find((f) => f.id === id) || null;
  const current = () => (folderId ? folderById(folderId) : null);
  const childrenOf = (id) => folders.filter((f) => (f.parent_id || null) === (id || null));
  const boardsIn = (id) => boards.filter((b) => isMine(b) && (b.folder_id || null) === (id || null));
  const sharedWithMe = () => boards.filter((b) => !isMine(b));

  function trail(id) {
    const out = [];
    let f = folderById(id);
    const seen = new Set();
    while (f && !seen.has(f.id)) { seen.add(f.id); out.unshift(f); f = folderById(f.parent_id); }
    return out;
  }

  function isDescendant(candidateId, ancestorId) {
    let f = folderById(candidateId);
    const seen = new Set();
    while (f && !seen.has(f.id)) {
      if (f.id === ancestorId) return true;
      seen.add(f.id);
      f = folderById(f.parent_id);
    }
    return false;
  }

  const sorter = (a, b) => {
    if (sort === 'name') return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    return String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
  };
  const pinnedFirst = (a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || sorter(a, b);

  /* ---------------- Rendering ---------------- */

  function render() {
    const searchFocused = document.activeElement?.classList.contains('arc-search-input');
    const caret = searchFocused ? document.activeElement.selectionStart : null;
    el.replaceChildren(header(), body());
    if (searchFocused) {
      const s = el.querySelector('.arc-search-input');
      s.focus();
      s.setSelectionRange(caret, caret);
    }
    const r = el.querySelector('[data-rename-input]');
    if (r) { r.focus(); r.select(); }
  }

  function header() {
    const search = h('label', { class: 'arc-search' },
      icon('search', 16),
      h('input', { class: 'arc-search-input', type: 'search', placeholder: 'Search boards and folders', value: query, 'aria-label': 'Search archives' }));
    return h('header', { class: 'view-head' },
      h('h1', { class: 'dot-title' }, 'Blueprint'),
      h('div', { class: 'arc-actions' },
        search,
        h('div', { class: 'seg', role: 'group', 'aria-label': 'Sort' },
          h('button', { class: sort === 'updated' ? 'is-on' : null, 'data-act': 'sort', 'data-sort': 'updated' }, 'Recent'),
          h('button', { class: sort === 'name' ? 'is-on' : null, 'data-act': 'sort', 'data-sort': 'name' }, 'A–Z')),
        h('button', { class: 'btn', 'data-act': 'new-folder' }, icon('folder', 16), 'New folder'),
        h('button', { class: 'btn btn-primary', 'data-act': 'new-board' }, icon('plus', 16), 'New board')));
  }

  function crumbs() {
    const t = trail(folderId);
    return h('nav', { class: 'crumbs', 'aria-label': 'Folder path' },
      h('a', { href: '#/blueprint', class: 'crumb', 'data-drop': 'root' }, 'Archives'),
      t.map((f, i) => [
        h('span', { class: 'crumb-sep', 'aria-hidden': 'true' }, '/'),
        i === t.length - 1
          ? h('span', { class: 'crumb is-current', 'data-drop': f.id, 'aria-current': 'page' }, f.name)
          : h('a', { href: `#/blueprint/${f.id}`, class: 'crumb', 'data-drop': f.id }, f.name),
      ]));
  }

  function body() {
    if (loading) return h('div', { class: 'empty' }, h('span', { class: 'dots-loader' }, h('i'), h('i'), h('i')));
    if (loadError) return h('div', { class: 'empty' }, h('p', { class: 'empty-text' }, loadError), h('button', { class: 'btn', onclick: () => { loading = true; render(); load(); } }, 'Try again'));
    if (folderId && !current()) {
      return h('div', { class: 'empty' }, h('p', { class: 'empty-text' }, 'This folder no longer exists.'), h('a', { class: 'btn', href: '#/blueprint' }, 'Back to Archives'));
    }

    if (query) {
      const q = query.toLowerCase();
      const fs = folders.filter((f) => f.name.toLowerCase().includes(q)).sort(sorter);
      const bs = boards.filter((b) => b.name.toLowerCase().includes(q)).sort(sorter);
      return h('div', { class: 'arc-body' },
        section(`Results for “${query}”`, null),
        !fs.length && !bs.length ? h('p', { class: 'empty-text' }, 'Nothing matches. Try a shorter word.') : null,
        fs.length ? h('div', { class: 'agrid folders' }, fs.map((f) => folderTile(f, true))) : null,
        bs.length ? h('div', { class: 'agrid' }, bs.map((b) => boardCard(b, true))) : null);
    }

    const atRoot = !folderId;
    const pinned = atRoot
      ? [...folders.filter((f) => f.pinned).sort(sorter).map((item) => ({ kind: 'folder', item })), ...boards.filter((b) => b.pinned && isMine(b)).sort(sorter).map((item) => ({ kind: 'board', item }))]
      : [];
    const subFolders = childrenOf(folderId).filter((f) => !(atRoot && f.pinned)).sort(atRoot ? sorter : pinnedFirst);
    const here = boardsIn(folderId).filter((b) => !(atRoot && b.pinned)).sort(atRoot ? sorter : pinnedFirst);
    const shared = atRoot ? sharedWithMe().sort(sorter) : [];
    const nothing = !pinned.length && !subFolders.length && !here.length && !shared.length;

    return h('div', { class: 'arc-body' },
      atRoot ? null : crumbs(),
      pinned.length ? [
        section('Pinned', pinned.length),
        h('div', { class: 'agrid' }, pinned.map((x) => (x.kind === 'folder' ? folderTile(x.item, true) : boardCard(x.item, true)))),
      ] : null,
      subFolders.length ? [section('Folders', subFolders.length), h('div', { class: 'agrid folders' }, subFolders.map((f) => folderTile(f)))] : null,
      here.length ? [section('Boards', here.length), h('div', { class: 'agrid' }, here.map((b) => boardCard(b)))] : null,
      shared.length ? [section('Shared with you', shared.length), h('div', { class: 'agrid' }, shared.map((b) => boardCard(b)))] : null,
      nothing ? emptyState() : null);
  }

  function section(title, count) {
    return h('div', { class: 'sec-head' }, h('h2', { class: 'sec-title' }, title), count != null ? h('span', { class: 'sec-count' }, String(count)) : null);
  }

  function emptyState() {
    return h('div', { class: 'empty arc-empty' },
      icon('board', 56, { dotted: true }),
      h('p', { class: 'empty-text' }, folderId ? 'This folder is empty. Make a board here, or drag one in.' : 'No boards yet. Make one to start planning.'),
      h('button', { class: 'btn btn-primary', 'data-act': 'new-board' }, icon('plus', 16), 'New board'));
  }

  function nameNode(kind, item, cls) {
    if (renaming?.kind === kind && renaming.id === item.id) {
      return h('input', { class: ['rename-input', cls], value: item.name, maxlength: 80, 'data-rename-input': '', 'aria-label': 'Name' });
    }
    return h('div', { class: cls, title: item.name }, item.name);
  }

  function folderTile(f, showPath = false) {
    const nb = boardsIn(f.id).length, nf = childrenOf(f.id).length;
    const meta = [nb ? plural(nb, 'board') : null, nf ? plural(nf, 'folder') : null].filter(Boolean).join(', ') || 'Empty';
    const where = showPath && f.parent_id ? trail(f.parent_id).map((x) => x.name).join(' / ') : null;
    return h('div', { class: 'ftile', 'data-folder': f.id, 'data-drop': f.id, draggable: 'true', tabindex: '0', role: 'link', 'aria-label': `Folder ${f.name}` },
      h('div', { class: 'ftile-ic' }, icon('folder', 30, { dotted: true })),
      h('div', { class: 'ftile-text' },
        nameNode('folder', f, 'ftile-name'),
        h('div', { class: 'ftile-meta' }, where ? `${where} · ${meta}` : meta)),
      f.pinned ? h('span', { class: 'pin-mark', 'aria-label': 'Pinned' }, icon('pin', 14)) : null,
      h('button', { class: 'icon-btn sm tile-more', 'data-act': 'folder-menu', 'aria-label': `${f.name} options` }, icon('more', 16)));
  }

  function boardCard(b, showPath = false) {
    const pv = previewSvg(b.preview);
    const mine = isMine(b);
    const where = showPath && mine && b.folder_id ? trail(b.folder_id).map((x) => x.name).join(' / ') : null;
    const meta = !mine ? `Shared by ${owners.get(b.user_id) || 'someone'} · ${timeAgo(b.updated_at).toLowerCase()}`
      : where ? `${where} · ${timeAgo(b.updated_at)}` : `Edited ${timeAgo(b.updated_at).toLowerCase()}`;
    return h('article', { class: ['bcard', !mine && 'is-shared'], 'data-board': b.id, draggable: mine ? 'true' : 'false', tabindex: '0', role: 'link', 'aria-label': `Board ${b.name}` },
      h('div', { class: ['bcard-thumb', !pv && 'is-empty'] }, pv),
      h('div', { class: 'bcard-foot' },
        h('div', { class: 'bcard-text' },
          nameNode('board', b, 'bcard-name'),
          h('div', { class: 'bcard-meta' }, meta)),
        !mine || sharedOut.has(b.id) ? h('span', { class: 'pin-mark', 'aria-label': mine ? 'Shared' : 'Shared with you', title: mine ? 'Other people can edit this' : 'Shared with you' }, icon('users', 15)) : null,
        b.pinned && mine ? h('span', { class: 'pin-mark', 'aria-label': 'Pinned' }, icon('pin', 14)) : null,
        h('button', { class: 'icon-btn sm tile-more', 'data-act': 'board-menu', 'aria-label': `${b.name} options` }, icon('more', 16))));
  }

  /* ---------------- Actions ---------------- */

  async function newBoard() {
    const row = { id: uid(), name: 'Untitled board', folder_id: folderId || null, pinned: false, data: { v: 1, elements: [] }, preview: [] };
    try {
      const made = await api.db.insert('blueprints', row);
      boards.unshift({ ...row, ...made, data: undefined });
      cache = { folders, boards, owners, sharedOut };
      go(`board/${row.id}`);
    } catch (e) { fail(e); }
  }

  async function newFolder() {
    const row = { id: uid(), name: 'New folder', parent_id: folderId || null, pinned: false };
    folders.push({ ...row, updated_at: new Date().toISOString() });
    renaming = { kind: 'folder', id: row.id };
    render();
    const p = api.db.insert('archive_folders', row);
    pending.set(row.id, p.catch(() => {}));
    try { await p; } catch (e) { fail(e); } finally { pending.delete(row.id); }
  }

  async function rename(kind, id, name) {
    renaming = null;
    const list = kind === 'folder' ? folders : boards;
    const item = list.find((x) => x.id === id);
    name = (name || '').trim();
    if (!item || !name || name === item.name) { render(); return; }
    item.name = name;
    render();
    await afterInsert(id);
    try { await api.db.update(kind === 'folder' ? 'archive_folders' : 'blueprints', id, { name }); } catch (e) { fail(e); }
  }

  async function togglePin(kind, item) {
    item.pinned = !item.pinned;
    render();
    toast(item.pinned ? 'Pinned' : 'Unpinned');
    await afterInsert(item.id);
    try { await api.db.update(kind === 'folder' ? 'archive_folders' : 'blueprints', item.id, { pinned: item.pinned }); } catch (e) { fail(e); }
  }

  async function moveItem(kind, item, targetId) {
    targetId = targetId || null;
    if (kind === 'folder') {
      if (targetId === item.id || (targetId && isDescendant(targetId, item.id))) { toast('A folder can’t go inside itself.', { tone: 'error' }); return; }
      if ((item.parent_id || null) === targetId) return;
      item.parent_id = targetId;
    } else {
      if ((item.folder_id || null) === targetId) return;
      item.folder_id = targetId;
    }
    render();
    toast(`Moved to ${targetId ? folderById(targetId)?.name : 'Archives'}`);
    await afterInsert(item.id);
    try {
      await api.db.update(kind === 'folder' ? 'archive_folders' : 'blueprints', item.id, kind === 'folder' ? { parent_id: targetId } : { folder_id: targetId });
    } catch (e) { fail(e); }
  }

  async function chooseFolder(kind, item) {
    const rows = [];
    const walk = (parent, depth) => {
      for (const f of childrenOf(parent).sort((a, b) => a.name.localeCompare(b.name))) {
        if (kind === 'folder' && (f.id === item.id)) continue;
        rows.push({ f, depth });
        walk(f.id, depth + 1);
      }
    };
    walk(null, 0);
    const currentParent = kind === 'folder' ? item.parent_id || null : item.folder_id || null;
    let picked = currentParent;
    const list = h('div', { class: 'pick-list', role: 'listbox', 'aria-label': 'Destination' });
    const option = (id, label, depth) => h('button', {
      type: 'button', class: ['pick-row', picked === id && 'is-on'], role: 'option', 'aria-selected': String(picked === id),
      style: { paddingLeft: `${12 + depth * 18}px` },
      onclick: (e) => { picked = id; list.querySelectorAll('.pick-row').forEach((b) => { b.classList.remove('is-on'); b.setAttribute('aria-selected', 'false'); }); e.currentTarget.classList.add('is-on'); e.currentTarget.setAttribute('aria-selected', 'true'); },
    }, icon(id ? 'folder' : 'board', 16), h('span', {}, label), id === currentParent ? h('span', { class: 'pick-note' }, 'Current') : null);
    list.append(option(null, 'Archives (top level)', 0), ...rows.map(({ f, depth }) => option(f.id, f.name, depth + 1)));
    const v = await dialog({
      title: `Move “${item.name}”`,
      body: list,
      actions: [{ label: 'Cancel', value: null }, { label: 'Move here', primary: true, value: () => ({ id: picked }) }],
    });
    if (v) moveItem(kind, item, v.id);
  }

  async function duplicateBoard(b) {
    try {
      const full = await api.db.get('blueprints', b.id);
      const row = { id: uid(), name: `${b.name} copy`, folder_id: b.folder_id || null, pinned: false, data: full?.data || { v: 1, elements: [] }, preview: full?.preview || [] };
      const made = await api.db.insert('blueprints', row);
      boards.unshift({ ...row, ...made, data: undefined });
      render();
      toast('Board duplicated');
    } catch (e) { fail(e); }
  }

  async function deleteBoard(b) {
    const ok = await confirmDialog(`Delete “${b.name}”?`, 'The board and everything on it will be gone for good.', { ok: 'Delete board' });
    if (!ok) return;
    boards = boards.filter((x) => x.id !== b.id);
    cache = { folders, boards, owners, sharedOut };
    render();
    try { await api.db.remove('blueprints', b.id); } catch (e) { fail(e); }
  }

  async function deleteFolder(f) {
    const nb = boardsIn(f.id).length, nf = childrenOf(f.id).length;
    const dest = f.parent_id ? folderById(f.parent_id)?.name : 'Archives';
    const ok = await confirmDialog(`Delete folder “${f.name}”?`, nb || nf ? `Its ${[nb ? plural(nb, 'board') : '', nf ? plural(nf, 'folder') : ''].filter(Boolean).join(' and ')} will move to ${dest}. Nothing inside is deleted.` : 'The folder is empty.', { ok: 'Delete folder' });
    if (!ok) return;
    const parent = f.parent_id || null;
    const movedBoards = boardsIn(f.id);
    const movedFolders = childrenOf(f.id);
    movedBoards.forEach((b) => { b.folder_id = parent; });
    movedFolders.forEach((x) => { x.parent_id = parent; });
    folders = folders.filter((x) => x.id !== f.id);
    cache = { folders, boards, owners, sharedOut };
    if (folderId === f.id) { go(parent ? `blueprint/${parent}` : 'blueprint'); }
    else render();
    try {
      await Promise.all([
        ...movedBoards.map((b) => api.db.update('blueprints', b.id, { folder_id: parent })),
        ...movedFolders.map((x) => api.db.update('archive_folders', x.id, { parent_id: parent })),
      ]);
      await api.db.remove('archive_folders', f.id);
    } catch (e) { fail(e); }
  }

  /* ---------------- Events ---------------- */

  const offs = [];
  const itemOf = (node) => {
    const fId = node.closest('[data-folder]')?.dataset.folder;
    if (fId) return { kind: 'folder', item: folderById(fId) };
    const bId = node.closest('[data-board]')?.dataset.board;
    if (bId) return { kind: 'board', item: boards.find((b) => b.id === bId) };
    return null;
  };

  async function leaveBoard(b) {
    const ok = await confirmDialog(`Leave “${b.name}”?`, 'It will disappear from your Archives. The owner can invite you again.', { ok: 'Leave board' });
    if (!ok) return;
    boards = boards.filter((x) => x.id !== b.id);
    cache = { folders, boards, owners, sharedOut };
    render();
    try { await api.db.removeWhere('blueprint_members', { board_id: b.id, user_id: meId }); } catch (e) { fail(e); }
  }

  function itemMenu(anchor, kind, item) {
    if (kind === 'board' && !isMine(item)) {
      menu(anchor, [
        { label: 'Open', icon: 'board', onSelect: () => go(`board/${item.id}`) },
        '-',
        { label: 'Leave board', icon: 'leave', danger: true, onSelect: () => leaveBoard(item) },
      ], { align: 'end' });
      return;
    }
    menu(anchor, [
      { label: 'Open', icon: kind === 'folder' ? 'folder' : 'board', onSelect: () => go(kind === 'folder' ? `blueprint/${item.id}` : `board/${item.id}`) },
      { label: 'Rename', icon: 'edit', onSelect: () => { renaming = { kind, id: item.id }; render(); } },
      { label: item.pinned ? 'Unpin' : 'Pin', icon: item.pinned ? 'pinOff' : 'pin', onSelect: () => togglePin(kind, item) },
      { label: 'Move to…', icon: 'folderMove', onSelect: () => chooseFolder(kind, item) },
      kind === 'board' ? { label: 'Duplicate', icon: 'copy', onSelect: () => duplicateBoard(item) } : null,
      '-',
      { label: kind === 'folder' ? 'Delete folder' : 'Delete board', icon: 'trash', danger: true, onSelect: () => (kind === 'folder' ? deleteFolder(item) : deleteBoard(item)) },
    ], { align: 'end' });
  }

  offs.push(delegate(el, 'click', '[data-act]', (e, t) => {
    const act = t.dataset.act;
    if (act === 'new-board') newBoard();
    else if (act === 'new-folder') newFolder();
    else if (act === 'sort') { sort = t.dataset.sort; store.set('architect.archive.sort', sort); render(); }
    else if (act === 'folder-menu' || act === 'board-menu') {
      e.stopPropagation();
      const it = itemOf(t);
      if (it?.item) itemMenu(t, it.kind, it.item);
    }
  }));

  const open = (node) => {
    const it = itemOf(node);
    if (!it?.item) return;
    go(it.kind === 'folder' ? `blueprint/${it.item.id}` : `board/${it.item.id}`);
  };

  // A click on the name waits a beat so a double-click can rename instead of opening.
  let openTimer = null;
  offs.push(delegate(el, 'click', '.ftile, .bcard', (e, t) => {
    if (e.target.closest('button, input, [data-act]')) return;
    clearTimeout(openTimer);
    if (e.target.closest('.ftile-name, .bcard-name') && e.detail === 1) { openTimer = setTimeout(() => open(t), 240); return; }
    if (e.detail > 1) return;
    open(t);
  }));
  offs.push(() => clearTimeout(openTimer));
  offs.push(delegate(el, 'keydown', '.ftile, .bcard', (e, t) => {
    if (e.target !== t) return;
    if (e.key === 'Enter') { e.preventDefault(); open(t); }
    else if (e.key === 'F2') { const it = itemOf(t); if (it?.item && (it.kind === 'folder' || isMine(it.item))) { renaming = { kind: it.kind, id: it.item.id }; render(); } }
  }));
  offs.push(delegate(el, 'dblclick', '.ftile-name, .bcard-name', (e, t) => {
    e.preventDefault();
    clearTimeout(openTimer);
    const it = itemOf(t);
    if (it?.item && (it.kind === 'folder' || isMine(it.item))) { renaming = { kind: it.kind, id: it.item.id }; render(); }
  }));
  offs.push(delegate(el, 'contextmenu', '.ftile, .bcard', (e, t) => {
    const it = itemOf(t);
    if (!it?.item) return;
    e.preventDefault();
    itemMenu({ x: e.clientX, y: e.clientY }, it.kind, it.item);
  }));

  el.addEventListener('input', (e) => {
    if (e.target.classList.contains('arc-search-input')) { query = e.target.value.trim(); render(); }
  });
  el.addEventListener('keydown', (e) => {
    if (e.target.matches('[data-rename-input]')) {
      if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
      else if (e.key === 'Escape') { renaming = null; render(); }
    }
  });
  el.addEventListener('focusout', (e) => {
    if (!e.target.matches?.('[data-rename-input]') || !renaming) return;
    const { kind, id } = renaming;
    rename(kind, id, e.target.value);
  });

  // Drag a board or folder onto a folder tile or a breadcrumb.
  let dragged = null;
  el.addEventListener('dragstart', (e) => {
    const it = itemOf(e.target);
    if (!it?.item || renaming || (it.kind === 'board' && !isMine(it.item))) { e.preventDefault(); return; }
    dragged = it;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', it.item.name);
    e.target.classList.add('is-dragged');
  });
  el.addEventListener('dragend', (e) => {
    dragged = null;
    e.target.classList?.remove('is-dragged');
    el.querySelectorAll('.is-drop').forEach((n) => n.classList.remove('is-drop'));
  });
  el.addEventListener('dragover', (e) => {
    const t = e.target.closest?.('[data-drop]');
    if (!dragged || !t) return;
    const target = t.dataset.drop === 'root' ? null : t.dataset.drop;
    if (dragged.kind === 'folder' && (target === dragged.item.id || (target && isDescendant(target, dragged.item.id)))) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    el.querySelectorAll('.is-drop').forEach((n) => n !== t && n.classList.remove('is-drop'));
    t.classList.add('is-drop');
  });
  el.addEventListener('dragleave', (e) => {
    const t = e.target.closest?.('[data-drop]');
    if (t && !t.contains(e.relatedTarget)) t.classList.remove('is-drop');
  });
  el.addEventListener('drop', (e) => {
    const t = e.target.closest?.('[data-drop]');
    if (!dragged || !t) return;
    e.preventDefault();
    const target = t.dataset.drop === 'root' ? null : t.dataset.drop;
    const d = dragged;
    dragged = null;
    moveItem(d.kind, d.item, target);
  });

  const onKey = (e) => {
    if (e.key === '/' && !isTypingTarget(e.target) && !document.querySelector('.dlg-overlay')) {
      e.preventDefault();
      el.querySelector('.arc-search-input')?.focus();
    }
  };
  window.addEventListener('keydown', onKey);

  render();
  load();

  return {
    destroy() {
      offs.forEach((f) => f());
      window.removeEventListener('keydown', onKey);
      el.remove();
    },
  };
}
