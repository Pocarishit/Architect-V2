// Blueprint board page: loads a board, wires the editor to toolbars, panels, media and autosave.
import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { menu, popover, toast, dialog, confirmDialog, promptDialog, closeFloating } from '../core/ui.js';
import { uid, store, debounce, posBetween, clamp, kbd } from '../core/util.js';
import { go } from '../core/router.js';
import { printToPdf, pdfHint } from '../core/print.js';
import { api, friendlyError } from '../data/api.js';
import { Editor, CLIP_MARK } from './editor.js';
import { createContextBar } from './contextbar.js';
import { makePreview } from './preview.js';
import { parseUrl, looksLikeUrl } from './embed.js';
import { TEMPLATES } from './templates.js';
import { SWATCHES, STICKY_FILLS, swatchStyle } from './palette.js';
import { SHAPES, rectOf } from './geometry.js';
import { pdfInfo, openPdfViewer, PDF_HEAD } from './pdf.js';
import { startCollab, colorFor, initials } from './collab.js';
import { myAvatar } from '../data/profile.js';
import { getPref, setPref, loadPrefs } from '../data/prefs.js';

const SHAPE_NAMES = { rect: 'Rectangle', round: 'Rounded', ellipse: 'Ellipse', triangle: 'Triangle', diamond: 'Diamond', hexagon: 'Hexagon', parallelogram: 'Parallelogram', star: 'Star', arrowblock: 'Arrow', pill: 'Pill' };

// opts (used by the Space):
//   space        true for the shared canvas: no chrome, no dot grid, right-click / "/" menus instead
//   mountWidget  builds live modules inside 'widget' objects
//   extendMenu(items, info)  adds to the right-click menu · onReady(api)  hands the page's tools over
export function mountBoard(root, boardId, opts = {}) {
  const space = !!opts.space;
  const page = h('div', { class: ['bp-page', space && 'is-world'] });
  root.append(page);
  page.append(h('div', { class: 'bp-loading' }, h('span', { class: 'dots-loader' }, h('i'), h('i'), h('i'))));

  let editor = null;
  let destroyed = false;
  const cleanups = [];
  const media = new Map(); // storage path → signed URL

  (async () => {
    let board;
    try {
      board = await api.db.get('blueprints', boardId);
    } catch (e) {
      if (!destroyed) showProblem(friendlyError(e));
      return;
    }
    if (destroyed) return;
    if (!board) { showProblem('This board doesn’t exist anymore.'); return; }
    try { await loadPrefs(); } catch {}
    if (destroyed) return;
    page.replaceChildren();
    setup(board);
    const paths = (board.data?.elements || []).map((e) => e.path).filter(Boolean);
    if (paths.length) {
      try {
        const urls = await api.media.sign(paths);
        Object.entries(urls).forEach(([p, u]) => media.set(p, u));
        editor?.refreshMedia();
      } catch (e) {
        toast(`Media didn’t load — ${friendlyError(e)}`, { tone: 'error', ms: 5000 });
      }
    }
  })();

  function showProblem(msg) {
    page.replaceChildren(h('div', { class: 'bp-problem' },
      h('p', { class: 'empty-text' }, msg),
      h('a', { class: 'btn', href: '#/' }, icon('back', 16), 'Back to the Space')));
  }

  function setup(board) {
    document.title = `${board.name} — Architect`;
    const canvas = h('div', { class: 'bp-canvas' });
    page.append(canvas);
    const me = api.auth.current()?.user ? { ...api.auth.current().user } : null;
    editor = new Editor(canvas, {
      elements: board.data?.elements || [],
      camera: store.get(`architect.cam.${boardId}`),
      mediaUrl: (el) => el.src || (el.path ? media.get(el.path) : null) || null,
      me: me?.id || null,
      mountWidget: opts.mountWidget || null,
    });
    // Blueprints open in compact mode (smaller chrome) unless you turn it off.
    if (!space) page.classList.toggle('is-compact', getPref('bpCompact', true) !== false);
    if (/[?&]debug\b/.test(location.search)) window.__editor = editor;

    /* ---------- autosave ---------- */
    let dirty = false, saving = false, again = false, failTimer = null;
    const status = h('span', { class: 'bp-status', role: 'status' }, h('i'), h('span', {}, 'Saved'));
    const setStatus = (state) => {
      status.dataset.state = state;
      status.lastChild.textContent = { saved: 'Saved', saving: 'Saving', dirty: 'Unsaved', error: 'Not saved — retrying' }[state];
    };
    setStatus('saved');
    async function save() {
      if (saving) { again = true; return; }
      if (!dirty) return;
      saving = true;
      dirty = false;
      setStatus('saving');
      const els = editor.els;
      try {
        await api.db.update('blueprints', boardId, { data: { v: 1, elements: els }, preview: makePreview(els, editor.byId) });
        setStatus(dirty ? 'dirty' : 'saved');
      } catch (e) {
        dirty = true;
        setStatus('error');
        clearTimeout(failTimer);
        failTimer = setTimeout(save, 5000);
        if (!save._warned) { save._warned = true; toast(`Board not saved — ${friendlyError(e)}`, { tone: 'error', ms: 6000 }); }
      } finally {
        saving = false;
        if (again) { again = false; save(); }
      }
    }
    const scheduleSave = debounce(save, 800);
    editor.on('change', (d) => {
      if (d?.remote) { ensureMedia(); return; } // whoever made a change saves it
      dirty = true; setStatus('dirty'); scheduleSave();
    });

    // Images added by someone else need their own signed links here.
    const signing = new Set();
    async function ensureMedia() {
      const missing = editor.els.map((e) => e.path).filter((p) => p && !media.has(p) && !signing.has(p));
      if (!missing.length) return;
      missing.forEach((p) => signing.add(p));
      try {
        const urls = await api.media.sign(missing);
        Object.entries(urls).forEach(([p, u]) => media.set(p, u));
        if (!destroyed) editor.refreshMedia();
      } catch {} finally { missing.forEach((p) => signing.delete(p)); }
    }
    const saveCam = debounce(() => store.set(`architect.cam.${boardId}`, editor.cam), 400);
    editor.on('camera', saveCam);
    const beforeUnload = (e) => { if (dirty || saving) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', beforeUnload);
    cleanups.push(() => {
      window.removeEventListener('beforeunload', beforeUnload);
      clearTimeout(failTimer);
      saveCam.flush();
      scheduleSave.cancel();
      if (dirty) save(); // finish in the background
    });

    /* ---------- top bar ---------- */
    const title = h('input', { class: 'bp-title', value: board.name, maxlength: 80, 'aria-label': 'Board name', spellcheck: false });
    const sizeTitle = () => { title.style.width = `${Math.min(420, Math.max(80, title.value.length * 9.2 + 28))}px`; };
    sizeTitle();
    title.addEventListener('input', sizeTitle);
    title.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') { if (e.key === 'Escape') title.value = board.name; title.blur(); } });
    title.addEventListener('change', async () => {
      const name = title.value.trim() || 'Untitled board';
      title.value = name;
      sizeTitle();
      if (name === board.name) return;
      board.name = name;
      document.title = `${name} — Architect`;
      collab?.sendMeta({ name });
      try { await api.db.update('blueprints', boardId, { name }); } catch (e) { toast(friendlyError(e), { tone: 'error' }); }
    });

    const isOwner = !board.user_id || !me || board.user_id === me.id;
    let collab = null;
    let people = 1; // everyone with access, from the share list (owner included)
    const peoplePill = h('div', { class: 'bp-people', hidden: true });
    let hereNow = new Set(); // usernames currently on the board

    const topBtn = (ic, label, fn, opts = {}) => h('button', { class: 'bp-icon', type: 'button', 'aria-label': label, 'data-tip': kbd(label), 'data-tip-pos': 'bottom', onclick: (e) => fn(e.currentTarget), ...opts }, icon(ic, 18));
    // Phones: undo / redo live up here, within thumb reach and never scrolled out of the dock.
    const topUndo = topBtn('undo', 'Undo · two-finger tap', () => editor.undo(), { class: 'bp-icon show-sm' });
    const topRedo = topBtn('redo', 'Redo · three-finger tap', () => editor.redo(), { class: 'bp-icon show-sm' });
    const top = h('div', { class: 'bp-top' },
      h('div', { class: 'bp-pill' },
        h('a', { class: 'bp-icon', href: '#/', 'aria-label': 'Back to the Space', 'data-tip': 'Space', 'data-tip-pos': 'bottom' }, icon('back', 18)),
        h('span', { class: 'bp-mark', 'aria-hidden': 'true' }, 'Blueprint'),
        title,
        status),
      h('div', { class: 'bp-pill' },
        topUndo, topRedo,
        h('span', { class: 'bp-psep show-sm', 'aria-hidden': 'true' }),
        peoplePill,
        topBtn('search', 'Find on board (⌘F)', () => openSearch(), { class: 'bp-icon hide-sm' }),
        topBtn('layers', 'Frames', () => toggleFrames(), { class: 'bp-icon hide-sm' }),
        topBtn('present', 'Present frames', () => startPresent(), { class: 'bp-icon hide-sm' }),
        topBtn('share', 'Share board', () => openShare()),
        topBtn('more', 'Board options', (a) => boardMenu(a))));
    page.append(top);

    /* ---------- live collaboration ---------- */
    if (api.live && me) (async () => {
      // Your face rides along with your cursor.
      me.avatar = await Promise.race([myAvatar().catch(() => null), new Promise((r) => setTimeout(() => r(null), 1500))]);
      if (destroyed) return;
      let warned = false;
      collab = startCollab({
        editor, boardId, me, live: api.live,
        onPeople: renderPeople,
        onStatus: (st) => {
          peoplePill.dataset.live = st;
          if (st === 'error' && people > 1 && !warned) {
            warned = true;
            toast('Live editing isn’t connected. Run supabase/collab.sql in Supabase, then reload.', { tone: 'error', ms: 7000 });
          }
        },
        onMeta: (m) => {
          if (!m.name || m.name === board.name || document.activeElement === title) return;
          board.name = m.name; title.value = m.name; sizeTitle();
          document.title = `${m.name} — Architect`;
        },
        saveNow: async () => { dirty = true; await save(); },
        loadFromDb: async () => (await api.db.get('blueprints', boardId))?.data?.elements || [],
      });
      cleanups.push(() => collab.stop());
      if (api.mode !== 'local') api.rpc('board_people', { b: boardId }).then((rows) => { people = rows?.length || 1; }).catch(() => {});
    })();

    // The Space also changes from outside the page (the Local API): pick that up while you're idle.
    if (space) {
      let lastStamp = board.updated_at || null;
      const poll = setInterval(async () => {
        if (document.hidden || dirty || saving || editor.g || editor.editingId) return;
        try {
          const row = await api.db.get('blueprints', boardId, 'updated_at');
          if (!row || row.updated_at === lastStamp) return;
          lastStamp = row.updated_at;
          const full = await api.db.get('blueprints', boardId);
          if (!full || dirty || saving || editor.g || editor.editingId) return;
          const next = full.data?.elements || [];
          if (JSON.stringify(next) === JSON.stringify(editor.els)) return;
          editor.applyRemote({ up: next, order: next.map((e) => e.id) }, { replaceAll: true });
        } catch {}
      }, 15_000);
      cleanups.push(() => clearInterval(poll));
    }

    // Avatars of everyone else on the board right now. Tap one to jump to where they are.
    function renderPeople(list) {
      const others = list.filter((p) => !p.self);
      hereNow = new Set(others.map((p) => p.name));
      peoplePill.hidden = !others.length;
      const shown = others.slice(0, 4);
      peoplePill.replaceChildren(
        ...shown.map((p) => h('button', {
          type: 'button', class: 'bp-av', style: { '--c': p.color }, 'aria-label': `${p.name} — go to`, 'data-tip': `${p.name} · jump to`, 'data-tip-pos': 'bottom',
          onclick: () => { if (!collab?.follow(p.key)) toast(`${p.name} hasn’t moved yet.`); },
        }, initials(p.name))),
        ...(others.length > shown.length ? [h('span', { class: 'bp-av is-more' }, `+${others.length - shown.length}`)] : []));
    }

    async function openShare() {
      const body = h('div', { class: 'share' });
      if (api.mode === 'local') {
        body.append(h('p', { class: 'dlg-text' }, 'Sharing with other people needs Supabase. In local mode you can still try live editing: open this board in a second tab.'));
        dialog({ title: 'Share board', body, width: 460, actions: [{ label: 'Done', value: true }] });
        return;
      }
      const input = h('input', { class: 'input', placeholder: 'Their username', autocapitalize: 'none', spellcheck: false, maxlength: 32, 'aria-label': 'Username to invite' });
      const invite = h('button', { class: 'btn btn-primary', type: 'button' }, 'Invite');
      const list = h('div', { class: 'share-list', 'aria-live': 'polite' }, h('span', { class: 'dots-loader' }, h('i'), h('i'), h('i')));
      const err = h('p', { class: 'share-err', hidden: true });
      body.append(
        h('p', { class: 'dlg-text' }, isOwner ? 'People you invite can open this board from their Archives and edit it with you, live.' : 'You’re editing this board with the people below.'),
        isOwner ? h('div', { class: 'share-row' }, input, invite) : null,
        err,
        h('div', { class: 'pop-label' }, 'People with access'),
        list);

      let rows = [];
      const paint = () => {
        const here = hereNow;
        list.replaceChildren(...rows.map((r) => {
          const self = r.user_id === me.id;
          const canRemove = isOwner && !self && r.role !== 'owner';
          return h('div', { class: 'share-person' },
            h('span', { class: 'bp-av', style: { '--c': colorFor(r.user_id) } }, initials(r.username)),
            h('span', { class: 'share-name' }, r.username || 'Unknown', self ? h('span', { class: 'share-you' }, ' (you)') : null),
            here.has(r.username) ? h('span', { class: 'share-live' }, h('i'), 'Here') : null,
            h('span', { class: 'share-role' }, r.role === 'owner' ? 'Owner' : 'Can edit'),
            canRemove ? h('button', { type: 'button', class: 'icon-btn sm', 'aria-label': `Remove ${r.username}`, title: 'Remove', onclick: () => removePerson(r) }, icon('close', 15)) : null,
            !isOwner && self ? h('button', { type: 'button', class: 'btn btn-sm', onclick: () => leaveBoard() }, icon('leave', 14), 'Leave') : null);
        }));
      };
      const load = async () => {
        try { rows = (await api.rpc('board_people', { b: boardId })) || []; people = rows.length || 1; paint(); }
        catch (e) { list.replaceChildren(h('p', { class: 'dlg-text' }, friendlyError(e))); }
      };
      const doInvite = async () => {
        const name = input.value.trim().replace(/^@/, '');
        if (!name) { input.focus(); return; }
        err.hidden = true;
        invite.disabled = true;
        try {
          await api.rpc('share_board', { b: boardId, uname: name });
          input.value = '';
          toast(`${name} can now edit this board`);
          await load();
        } catch (e) { err.textContent = friendlyError(e); err.hidden = false; }
        finally { invite.disabled = false; input.focus(); }
      };
      async function removePerson(r) {
        try { await api.db.removeWhere('blueprint_members', { board_id: boardId, user_id: r.user_id }); await load(); }
        catch (e) { err.textContent = friendlyError(e); err.hidden = false; }
      }
      async function leaveBoard() {
        const ok = await confirmDialog('Leave this board?', 'It will disappear from your Archives. The owner can invite you again.', { ok: 'Leave board' });
        if (!ok) return;
        try { await api.db.removeWhere('blueprint_members', { board_id: boardId, user_id: me.id }); go('blueprint'); }
        catch (e) { toast(friendlyError(e), { tone: 'error' }); }
      }
      invite.addEventListener('click', doInvite);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doInvite(); } });
      load();
      dialog({ title: 'Share board', body, width: 480, actions: [{ label: 'Done', value: true }] });
    }

    /* ---------- left toolbar ---------- */
    const toolBtns = new Map();
    const toolbar = h('div', { class: 'bp-tools', role: 'toolbar', 'aria-label': 'Tools', 'aria-orientation': 'vertical' });
    const tbtn = (key, ic, label, fn, extra = {}) => {
      const b = h('button', { class: ['bp-tool', extra.flyout && 'has-fly'], type: 'button', 'aria-label': label, 'data-tip': kbd(label), onclick: (e) => fn(e.currentTarget) }, typeof ic === 'function' ? ic() : icon(ic, 20));
      if (key) toolBtns.set(key, b);
      return b;
    };
    const sep = () => h('span', { class: 'bp-tsep' });
    const undoBtn = tbtn(null, 'undo', 'Undo (⌘Z)', () => editor.undo());
    const redoBtn = tbtn(null, 'redo', 'Redo (⇧⌘Z)', () => editor.redo());
    undoBtn.classList.add('hide-sm'); redoBtn.classList.add('hide-sm');
    const shapeBtn = tbtn('shape', () => icon(editor.opts.shape || 'rect', 20), 'Shapes (S)', (a) => { editor.setTool('shape'); shapeFly(a); }, { flyout: true });
    const lineBtn = tbtn('line', () => icon(editor.opts.line === 'line' ? 'line' : 'arrow', 20), 'Connector (L)', (a) => { editor.setTool('line'); lineFly(a); }, { flyout: true });
    const penBtn = tbtn('pen', () => icon(editor.tool === 'eraser' ? 'eraser' : editor.opts.pen === 'highlighter' ? 'highlighter' : 'pen', 20), 'Draw (P)', (a) => { if (editor.tool !== 'eraser') editor.setTool('pen'); penFly(a); }, { flyout: true });
    const stickyBtn = tbtn('sticky', 'sticky', 'Sticky note (N)', (a) => { editor.setTool('sticky'); stickyFly(a); }, { flyout: true });
    toolbar.append(
      tbtn('select', 'select', 'Select (V)', () => editor.setTool('select')),
      tbtn('hand', 'hand', 'Hand (H · hold Space)', () => editor.setTool('hand')),
      sep(),
      stickyBtn,
      tbtn('text', 'text', 'Text (T)', () => editor.setTool('text')),
      shapeBtn,
      lineBtn,
      penBtn,
      tbtn('frame', 'frame', 'Frame (F)', () => editor.setTool('frame')),
      tbtn('border', 'borderBox', 'Border (B · ⇧B curve)', () => { editor.setOpt('border', 'box'); editor.setTool('border'); }),
      sep(),
      tbtn(null, 'image', 'Upload image, video or PDF (U)', () => pickFiles()),
      tbtn(null, 'video', 'Add video or embed (K)', () => openEmbed()),
      tbtn(null, 'templates', 'Templates', (a) => templateFly(a)),
      h('span', { class: 'bp-tspace' }),
      undoBtn, redoBtn);
    page.append(toolbar);

    function syncTools() {
      const active = editor.tool === 'eraser' ? 'pen' : editor.tool;
      for (const [k, b] of toolBtns) {
        b.classList.toggle('is-on', k === active);
        b.setAttribute('aria-pressed', String(k === active));
      }
      shapeBtn.replaceChildren(icon(editor.opts.shape || 'rect', 20));
      lineBtn.replaceChildren(icon(editor.opts.line === 'line' ? 'line' : 'arrow', 20));
      penBtn.replaceChildren(icon(editor.tool === 'eraser' ? 'eraser' : editor.opts.pen === 'highlighter' ? 'highlighter' : 'pen', 20));
      stickyBtn.querySelector('.ic')?.style.setProperty('color', editor.tool === 'sticky' ? '' : '');
    }
    const syncHistory = () => {
      undoBtn.disabled = topUndo.disabled = !editor.undoStack.length;
      redoBtn.disabled = topRedo.disabled = !editor.redoStack.length;
    };
    editor.on('tool', syncTools);
    editor.on('history', syncHistory);
    editor.on('change', syncHistory);
    syncTools();
    syncHistory();

    const flyOpts = window.matchMedia('(max-width: 720px)').matches
      ? { side: 'top', align: 'start', gap: 10 }
      : { side: 'right', align: 'start', gap: 10 };
    function shapeFly(anchor) {
      const grid = h('div', { class: 'shape-grid' });
      const paint = () => grid.replaceChildren(...SHAPES.map((k) => h('button', {
        type: 'button', class: ['tool-opt', editor.opts.shape === k && 'is-on'], 'aria-label': SHAPE_NAMES[k], title: SHAPE_NAMES[k],
        onclick: () => { editor.setOpt('shape', k); editor.setTool('shape'); closeFloating(); },
      }, icon(k, 20))));
      paint();
      popover(anchor, h('div', { class: 'pop' }, h('div', { class: 'pop-label' }, 'Shapes — click or drag on the board'), grid), flyOpts);
    }
    function lineFly(anchor) {
      const opt = (v, ic, label) => h('button', { type: 'button', class: ['tool-opt wide', editor.opts.line === v && 'is-on'], onclick: () => { editor.setOpt('line', v); editor.setTool('line'); closeFloating(); } }, icon(ic, 18), h('span', {}, label));
      popover(anchor, h('div', { class: 'pop' },
        h('div', { class: 'pop-label' }, 'Drag from one item to another to connect'),
        h('div', { class: 'opt-col' }, opt('arrow', 'arrow', 'Arrow'), opt('line', 'line', 'Line'))), flyOpts);
    }
    function penFly(anchor) {
      const body = h('div', { class: 'pop' });
      const paint = () => {
        const mode = editor.tool === 'eraser' ? 'eraser' : editor.opts.pen;
        const isHl = mode === 'highlighter';
        const colorKey = isHl ? 'hlColor' : 'penColor';
        body.replaceChildren(
          h('div', { class: 'seg seg-sm' },
            ...[['pen', 'pen', 'Pen'], ['highlighter', 'highlighter', 'Highlighter'], ['eraser', 'eraser', 'Eraser']].map(([v, ic, label]) => h('button', {
              type: 'button', class: mode === v ? 'is-on' : null, 'aria-label': label, title: label,
              onclick: () => { if (v === 'eraser') editor.setTool('eraser'); else { editor.setOpt('pen', v); editor.setTool('pen'); } paint(); },
            }, icon(ic, 16), h('span', {}, label)))),
          mode === 'eraser' ? h('p', { class: 'pop-note' }, 'Drag over drawings to erase them.') : [
            h('div', { class: 'pop-label' }, 'Colour'),
            h('div', { class: 'pal-grid' }, SWATCHES.map((c) => h('button', {
              type: 'button', class: ['pal-sw', editor.opts[colorKey] === c.id && 'is-on', c.id === 'auto' && 'is-auto'], 'aria-label': c.name, title: c.name, style: swatchStyle(c.id),
              onclick: () => { editor.setOpt(colorKey, c.id); paint(); },
            }))),
            !isHl ? h('div', { class: 'pop-label' }, 'Thickness') : null,
            !isHl ? h('div', { class: 'seg seg-sm' }, [1.5, 3, 5, 8, 12].map((w) => h('button', {
              type: 'button', class: editor.opts.penWidth === w ? 'is-on' : null, 'aria-label': `${w} px`,
              onclick: () => { editor.setOpt('penWidth', w); paint(); },
            }, h('span', { class: 'thick', style: { height: `${Math.min(w, 10)}px` } })))) : null,
          ]);
      };
      paint();
      popover(anchor, body, flyOpts);
    }
    function stickyFly(anchor) {
      const grid = h('div', { class: 'pal-grid' });
      const paint = () => grid.replaceChildren(...STICKY_FILLS.map((c) => h('button', {
        type: 'button', class: ['pal-sw', editor.opts.sticky === c.id && 'is-on'], 'aria-label': c.name, title: c.name, style: swatchStyle(c.id),
        onclick: () => { editor.setOpt('sticky', c.id); editor.setTool('sticky'); paint(); },
      })));
      paint();
      popover(anchor, h('div', { class: 'pop' }, h('div', { class: 'pop-label' }, 'Note colour — then click the board'), grid), flyOpts);
    }
    function templateFly(anchor) {
      popover(anchor, h('div', { class: 'pop' },
        h('div', { class: 'pop-label' }, 'Templates'),
        h('div', { class: 'opt-col' }, TEMPLATES.map((t) => h('button', {
          type: 'button', class: 'tpl-row',
          onclick: () => {
            closeFloating();
            const els = t.build(editor.viewCenter());
            editor.addEls(els);
            editor.fitRect(rectOfList(els), { maxZ: 1 });
          },
        }, h('span', { class: 'tpl-name' }, t.name), h('span', { class: 'tpl-hint' }, t.hint))))), flyOpts);
    }
    const rectOfList = (els) => {
      const byId = new Map(els.map((e) => [e.id, e]));
      const rs = els.map((e) => rectOf(e, byId));
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
      for (const r of rs) { x1 = Math.min(x1, r.x); y1 = Math.min(y1, r.y); x2 = Math.max(x2, r.x + r.w); y2 = Math.max(y2, r.y + r.h); }
      return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
    };

    /* ---------- zoom bar ---------- */
    const zoomLabel = h('button', { class: 'bp-zoom-val', type: 'button', 'aria-label': 'Zoom options' }, '100%');
    const zoomBar = h('div', { class: 'bp-zoom bp-pill' },
      h('button', { class: 'bp-icon', type: 'button', 'aria-label': 'Zoom out', 'data-tip': kbd('Zoom out (⌘−)'), 'data-tip-pos': 'top', onclick: () => editor.zoomBy(1 / 1.25) }, icon('minus', 18)),
      zoomLabel,
      h('button', { class: 'bp-icon', type: 'button', 'aria-label': 'Zoom in', 'data-tip': kbd('Zoom in (⌘+)'), 'data-tip-pos': 'top', onclick: () => editor.zoomBy(1.25) }, icon('plus', 18)),
      h('button', { class: 'bp-icon', type: 'button', 'aria-label': 'Fit everything', 'data-tip': 'Fit all (⇧1)', 'data-tip-pos': 'top', onclick: () => editor.zoomToFit() }, icon('fit', 18)));
    page.append(zoomBar);
    const syncZoom = () => { zoomLabel.textContent = `${Math.round(editor.cam.z * 100)}%`; };
    editor.on('camera', syncZoom);
    syncZoom();
    zoomLabel.addEventListener('click', () => {
      menu(zoomLabel, [
        { label: 'Zoom to fit', icon: 'fit', kbd: '⇧1', onSelect: () => editor.zoomToFit() },
        { label: 'Zoom to 50%', onSelect: () => editor.zoomTo(0.5) },
        { label: 'Zoom to 100%', kbd: '⌘0', onSelect: () => editor.zoomTo(1) },
        { label: 'Zoom to 200%', onSelect: () => editor.zoomTo(2) },
        '-',
        { label: 'Dot grid', icon: 'grid', kbd: 'G', checked: editor.prefs.grid, onSelect: () => editor.setPref('grid', !editor.prefs.grid) },
        { label: 'Snap to grid', icon: 'magnet', checked: editor.prefs.snap, onSelect: () => editor.setPref('snap', !editor.prefs.snap) },
      ], { side: 'top', align: 'end' });
    });

    /* ---------- context bar ---------- */
    createContextBar(page, editor, {
      sendToPaths,
      askLink,
      present: (id) => startPresent(id),
      openLink: (url) => window.open(url, '_blank', 'noopener'),
      openPdf: (el) => openPdf(el),
    });

    /* ---------- files, links, embeds ---------- */
    const fileInput = h('input', { type: 'file', accept: 'image/*,video/*,application/pdf,.pdf', multiple: true, hidden: true });
    fileInput.addEventListener('change', () => {
      const files = [...fileInput.files];
      fileInput.value = '';
      if (files.length) addFiles(files, editor.viewCenter());
    });
    const jsonInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
    jsonInput.addEventListener('change', () => { const f = jsonInput.files[0]; jsonInput.value = ''; if (f) importJson(f); });
    page.append(fileInput, jsonInput);
    const pickFiles = () => fileInput.click();

    editor.on('files', ({ files, at }) => addFiles(files, at));
    editor.on('url', ({ url, at }) => addUrl(url, at));
    editor.on('command', (cmd) => {
      if (cmd === 'upload') pickFiles();
      else if (cmd === 'embed') openEmbed();
      else if (cmd === 'search') openSearch();
      else if (cmd === 'shortcuts') showShortcuts();
      else if (cmd === 'export') exportJson();
      else if (cmd === 'export-pdf') exportPdf();
      else if (cmd === 'link') askLink();
    });
    editor.on('notice', (msg) => toast(msg, { ms: 900 }));
    const openPdf = (el) => {
      const url = el.src || media.get(el.path);
      if (!url) { toast('The PDF is still loading.', { ms: 1400 }); return; }
      openPdfViewer({ url, name: el.name, page: el.page || 1, onClose: (page) => {
        if (editor.byId.has(el.id) && page !== (editor.byId.get(el.id).page || 1)) editor.updateEls([el.id], { page }, { commit: false });
      } });
    };
    editor.on('open-pdf', openPdf);
    editor.on('contextmenu', ({ x, y, onElement, at }) => contextMenu({ x, y }, onElement, at));

    async function addFiles(files, at) {
      const isPdf = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name || '');
      const list = files.filter((f) => /^(image|video)\//.test(f.type) || isPdf(f));
      if (!list.length) { toast('Only images, videos and PDFs can go on a board.', { tone: 'error' }); return; }
      let offset = 0;
      for (const f of list) {
        const limit = api.media.maxBytes || 50 * 1024 * 1024;
        if (f.size > limit) { toast(`${f.name} is larger than ${Math.round(limit / 1048576)} MB.`, { tone: 'error', ms: 5000 }); continue; }
        const t = toast(`Uploading ${f.name}`, { ms: 0 });
        try {
          const p = { x: at.x + offset, y: at.y + offset };
          if (isPdf(f)) {
            const file = f.type === 'application/pdf' ? f : new File([f], f.name, { type: 'application/pdf' });
            const info = await pdfInfo(file).catch(() => null);
            if (!info) throw new Error('That PDF couldn’t be read.');
            const { path, url } = await api.media.upload(file);
            if (url) media.set(path, url);
            const w = 420, hh = Math.round(w * (info.h / info.w)) + PDF_HEAD;
            editor.addEls([{ id: uid(), type: 'pdf', path, name: f.name, page: 1, pages: info.pages, x: p.x - w / 2, y: p.y - hh / 2, w, h: hh }]);
          } else {
          const kind = f.type.startsWith('video/') ? 'video' : 'image';
          const dims = await mediaSize(f, kind);
          const { path, url } = await api.media.upload(f);
          if (url) media.set(path, url);
          const fit = fitSize(dims, kind === 'video' ? 560 : 480);
          editor.addEls([{ id: uid(), type: kind, path, name: f.name, x: p.x - fit.w / 2, y: p.y - fit.h / 2, w: fit.w, h: fit.h }]);
          }
          offset += 32;
          t.close();
        } catch (e) {
          t.close();
          toast(`${f.name} didn’t upload — ${friendlyError(e)}`, { tone: 'error', ms: 6000 });
        }
      }
    }

    async function addUrl(url, at, { asPage = false } = {}) {
      const info = parseUrl(url);
      if (!info) { toast('That isn’t a web address.', { tone: 'error' }); return; }
      let el;
      if (info.type === 'image') {
        const dims = await imageSizeFromUrl(info.src);
        const fit = fitSize(dims, 480);
        el = { type: 'image', src: info.src, w: fit.w, h: fit.h };
      } else if (info.type === 'video') {
        el = { type: 'video', src: info.src, w: info.w, h: info.h };
      } else if (info.type === 'embed') {
        el = { type: 'embed', url: info.url, embed: info.embed, provider: info.provider, w: info.w, h: info.h };
      } else if (asPage) {
        el = { type: 'embed', url: info.url, embed: info.url, provider: 'Web page', w: 720, h: 480 };
      } else {
        const u = new URL(info.url);
        const tail = decodeURIComponent(u.pathname.replace(/\/$/, '').split('/').pop() || '').replace(/[-_]+/g, ' ');
        el = { type: 'link', url: info.url, host: info.host, title: tail || info.host, w: 320, h: 132 };
      }
      editor.addEls([editor.place(el, at)]);
    }

    function askLink() {
      editor.addLink(() => promptDialog('Add link', { placeholder: 'https://…', ok: 'Add link', label: 'Address' }));
    }

    function openEmbed() {
      const input = h('input', { class: 'input', placeholder: 'Paste a YouTube, Vimeo, Loom, Spotify… link', autofocus: true, 'aria-label': 'Link' });
      const hint = h('p', { class: 'embed-hint' }, 'Videos play right on the board. Other links become cards.');
      let asPage = false;
      const pageToggle = h('label', { class: 'check-row', hidden: true },
        h('input', { type: 'checkbox', onchange: (e) => { asPage = e.target.checked; } }),
        h('span', {}, 'Show the page itself (some sites block this)'));
      input.addEventListener('input', () => {
        const info = looksLikeUrl(input.value) ? parseUrl(input.value) : null;
        pageToggle.hidden = !(info && info.type === 'link');
        hint.textContent = !input.value.trim() ? 'Videos play right on the board. Other links become cards.'
          : !info ? 'Paste a full link starting with https://'
            : info.type === 'link' ? `Link card for ${info.host}` : `${info.label} — ready to add`;
      });
      dialog({
        title: 'Add video or link',
        width: 480,
        body: h('div', { class: 'stack' }, input, hint, pageToggle),
        actions: [{ label: 'Cancel', value: null }, { label: 'Add to board', primary: true, value: () => (looksLikeUrl(input.value) ? input.value.trim() : (hint.textContent = 'Paste a full link starting with https://', undefined)) }],
      }).then((url) => { if (url) addUrl(url, editor.viewCenter(), { asPage }); });
    }

    /* ---------- send sticky to Paths ---------- */
    async function sendToPaths(anchor, sticky) {
      let cols = [];
      try { cols = await api.db.select('path_columns', { order: 'position.asc' }); } catch (e) { toast(friendlyError(e), { tone: 'error' }); return; }
      if (!cols.length) { toast('Open Paths once to set up your columns.'); return; }
      const [first, ...rest] = String(sticky.text || '').trim().split('\n');
      menu(anchor, [
        { header: 'Send note to' },
        ...cols.map((c) => ({
          label: c.title, icon: 'toPaths',
          onSelect: async () => {
            try {
              const tasks = await api.db.select('path_tasks', { columns: 'id,position', filters: { column_id: c.id }, order: 'position.desc' });
              await api.db.insert('path_tasks', { id: uid(), column_id: c.id, title: (first || 'Untitled').slice(0, 300), note: rest.join('\n').trim(), done: false, position: posBetween(tasks[0]?.position ?? null, null) });
              toast(`Sent to ${c.title}`);
            } catch (e) { toast(friendlyError(e), { tone: 'error' }); }
          },
        })),
      ], { align: 'start' });
    }

    /* ---------- search ---------- */
    let panel = null;
    function closePanel() { panel?._off?.(); panel?.remove(); panel = null; page.classList.remove('has-panel'); }
    function openPanel(kind, build) {
      if (panel?.dataset.kind === kind) { closePanel(); return null; }
      closePanel();
      panel = h('aside', { class: 'bp-panel', 'data-kind': kind });
      page.append(panel);
      page.classList.add('has-panel');
      build(panel);
      return panel;
    }

    function openSearch() {
      openPanel('search', (p) => {
        const input = h('input', { class: 'input', type: 'search', placeholder: 'Find text on this board', 'aria-label': 'Find on board' });
        const results = h('div', { class: 'panel-list' });
        const run = () => {
          const q = input.value.trim().toLowerCase();
          const hits = !q ? [] : editor.els.filter((e) => [e.text, e.title, e.url, e.provider, e.name].some((v) => v && String(v).toLowerCase().includes(q))).slice(0, 80);
          results.replaceChildren(...(q && !hits.length ? [h('p', { class: 'panel-empty' }, 'No matches.')] : hits.map((e) => h('button', {
            type: 'button', class: 'panel-row',
            onclick: () => { editor.select([e.id]); editor.fitRect(rectOf(e, editor.byId), { maxZ: 1.5, pad: 120 }); },
          }, h('span', { class: 'panel-type' }, e.type), h('span', { class: 'panel-text' }, String(e.text || e.title || e.name || e.url || e.provider).slice(0, 90))))));
        };
        input.addEventListener('input', run);
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') { closePanel(); editor.vp.focus(); }
          if (e.key === 'Enter') results.querySelector('.panel-row')?.click();
        });
        p.append(panelHead('Find', closePanel), input, results);
        requestAnimationFrame(() => input.focus());
      });
    }

    function panelHead(label, onClose) {
      return h('div', { class: 'panel-head' }, h('h2', { class: 'panel-title' }, label), h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': 'Close panel', onclick: onClose }, icon('close', 16)));
    }

    /* ---------- frames ---------- */
    function toggleFrames() {
      openPanel('frames', (p) => {
        const list = h('div', { class: 'panel-list' });
        const paint = () => {
          const frames = editor.frames();
          list.replaceChildren(...(frames.length ? frames.map((f, i) => h('button', {
            type: 'button', class: 'panel-row',
            onclick: () => { editor.select([f.id]); editor.fitRect(f, { maxZ: 2, pad: 60 }); },
          }, h('span', { class: 'panel-num' }, String(i + 1).padStart(2, '0')), h('span', { class: 'panel-text' }, f.title || 'Frame'))) : [h('p', { class: 'panel-empty' }, 'No frames yet. Press F and drag on the board to make one — frames group content and become slides when you present.')]));
        };
        paint();
        const off = editor.on('change', paint);
        p._off = off;
        p.append(panelHead('Frames', closePanel),
          list,
          h('button', { class: 'btn btn-primary panel-cta', type: 'button', onclick: () => startPresent() }, icon('present', 16), 'Present'));
      });
    }

    /* ---------- presentation ---------- */
    let presentState = null;
    function startPresent(fromId) {
      const frames = editor.frames();
      if (!frames.length) { toast('Add a frame first — press F and drag on the board.'); return; }
      closePanel();
      closeFloating();
      editor.finishEditing();
      editor.setTool('select');
      editor.clearSel();
      editor.presenting = true;
      page.classList.add('is-presenting');
      const counter = h('span', { class: 'hud-count' });
      const label = h('span', { class: 'hud-title' });
      const hud = h('div', { class: 'bp-hud bp-pill' },
        h('button', { class: 'bp-icon', type: 'button', 'aria-label': 'Previous frame', onclick: () => step(-1) }, icon('chevronLeft', 18)),
        counter, label,
        h('button', { class: 'bp-icon', type: 'button', 'aria-label': 'Next frame', onclick: () => step(1) }, icon('chevronRight', 18)),
        h('span', { class: 'hud-sep' }),
        h('button', { class: 'bp-icon', type: 'button', 'aria-label': 'Stop presenting', 'data-tip': 'Exit (Esc)', 'data-tip-pos': 'top', onclick: stopPresent }, icon('close', 18)));
      page.append(hud);
      presentState = { i: Math.max(0, frames.findIndex((f) => f.id === fromId)), hud, counter, label, cam: { ...editor.cam } };
      show();
      editor.vp.focus();
      function show() {
        const fr = editor.frames();
        if (!fr.length) { stopPresent(); return; }
        presentState.i = clamp(presentState.i, 0, fr.length - 1);
        const f = fr[presentState.i];
        counter.textContent = `${String(presentState.i + 1).padStart(2, '0')} / ${String(fr.length).padStart(2, '0')}`;
        label.textContent = f.title || 'Frame';
        editor.fitRect(f, { pad: 32, maxZ: 6 });
      }
      function step(d) { presentState.i += d; show(); }
      presentState.step = step;
    }
    function stopPresent() {
      if (!presentState) return;
      presentState.hud.remove();
      editor.presenting = false;
      page.classList.remove('is-presenting');
      editor.setCamera(presentState.cam, { animate: true });
      presentState = null;
      editor.renderOverlay();
    }
    editor.on('present', (cmd) => {
      if (!presentState) return;
      if (cmd === 'exit') stopPresent();
      else presentState.step(cmd === 'next' ? 1 : -1);
    });

    /* ---------- menus ---------- */
    function boardMenu(anchor) {
      menu(anchor, [
        { label: 'Share board', icon: 'share', onSelect: openShare },
        { label: 'Present frames', icon: 'present', onSelect: () => startPresent() },
        '-',
        { label: 'Find on board', icon: 'search', kbd: '⌘F', onSelect: openSearch },
        { label: 'Frames', icon: 'layers', onSelect: toggleFrames },
        { label: 'Zoom to fit', icon: 'fit', kbd: '⇧1', onSelect: () => editor.zoomToFit() },
        { label: 'Keyboard shortcuts', icon: 'keyboard', kbd: '?', onSelect: showShortcuts },
        '-',
        { label: 'Export as PDF', icon: 'download', kbd: '⌘P', onSelect: exportPdf },
        { label: 'Export board (.json)', icon: 'json', kbd: '⌘E', onSelect: exportJson },
        { label: 'Import into board', icon: 'upload', onSelect: () => jsonInput.click() },
        '-',
        { label: 'Clear board', icon: 'trash', danger: true, disabled: !editor.els.length, onSelect: clearBoard },
        '-',
        { label: 'Compact mode', icon: 'collapse', checked: page.classList.contains('is-compact'), onSelect: () => { const on = !page.classList.contains('is-compact'); page.classList.toggle('is-compact', on); setPref('bpCompact', on).catch(() => {}); } },
      ], { align: 'end' });
    }

    function contextMenu(at, onElement, world) {
      const sel = editor.selected();
      const items = onElement ? [
        { label: 'Copy', icon: 'copy', kbd: '⌘C', onSelect: () => editor.copy() },
        { label: 'Duplicate', icon: 'copy', kbd: '⌘D', onSelect: () => editor.duplicate() },
        { label: 'Bring to front', icon: 'front', kbd: ']', onSelect: () => editor.bringToFront() },
        { label: 'Send to back', icon: 'backward', kbd: '[', onSelect: () => editor.sendToBack() },
        sel.length > 1 ? { label: 'Group', icon: 'group', kbd: '⌘G', onSelect: () => editor.group() } : null,
        sel.some((e) => e.group) ? { label: 'Ungroup', icon: 'ungroup', kbd: '⇧⌘G', onSelect: () => editor.ungroup() } : null,
        { label: sel.every((e) => e.locked) ? 'Unlock' : 'Lock', icon: sel.every((e) => e.locked) ? 'unlock' : 'lock', kbd: '⇧⌘L', onSelect: () => editor.toggleLock() },
        '-',
        { label: 'Delete', icon: 'trash', kbd: 'Del', danger: true, onSelect: () => editor.deleteSelection() },
      ] : [
        { label: 'Paste here', icon: 'copy', kbd: '⌘V', onSelect: () => pasteAt(world) },
        { label: 'Add sticky note', icon: 'sticky', onSelect: () => { editor.addEls([editor.makeEl('sticky', null, world)], { edit: true }); } },
        { label: 'Add text', icon: 'text', onSelect: () => { editor.addEls([editor.makeEl('text', null, world)], { edit: true }); } },
        '-',
        { label: 'Select all', kbd: '⌘A', onSelect: () => editor.selectAll() },
        { label: 'Zoom to fit', icon: 'fit', kbd: '⇧1', onSelect: () => editor.zoomToFit() },
      ];
      menu(at, opts.extendMenu ? opts.extendMenu(items, { onElement, world, sel }) : items);
    }

    async function pasteAt(world) {
      let text = editor.clipboard || '';
      try { text = (await navigator.clipboard.readText()) || text; } catch {}
      if (!text) { toast('Clipboard is empty.'); return; }
      if (text.startsWith(CLIP_MARK)) editor.pasteSerialized(text, world);
      else if (looksLikeUrl(text)) addUrl(text.trim(), world);
      else { const el = editor.makeEl('text', null, world); el.text = text.slice(0, 5000); editor.addEls([el]); }
    }

    async function exportPdf() {
      editor.finishEditing?.();
      const p = editor.printable();
      if (!p) { toast('Nothing on this board to export yet.'); return; }
      const bg = getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim();
      pdfHint();
      await printToPdf({ ...p, title: board.name || 'Blueprint', background: bg });
    }

    function exportJson() {
      const data = { architect: 'blueprint', v: 1, name: board.name, exported_at: new Date().toISOString(), elements: editor.els };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = h('a', { href: URL.createObjectURL(blob), download: `${board.name.replace(/[^\w\- ]+/g, '').trim() || 'board'}.blueprint.json` });
      document.body.append(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    }

    async function importJson(file) {
      let data;
      try { data = JSON.parse(await file.text()); } catch { toast('That file isn’t valid JSON.', { tone: 'error' }); return; }
      const els = Array.isArray(data?.elements) ? data.elements.filter((e) => e && e.id && e.type) : null;
      if (!els?.length) { toast('No board elements found in that file.', { tone: 'error' }); return; }
      editor.pasteSerialized(CLIP_MARK + JSON.stringify({ els }), editor.viewCenter());
      editor.zoomToSelection();
      toast(`Imported ${els.length} items`);
    }

    async function clearBoard() {
      const ok = await confirmDialog('Clear this board?', 'Everything on it will be removed. You can undo right after with ⌘Z.', { ok: 'Clear board' });
      if (ok) editor.setEls([]);
    }

    opts.onReady?.({
      editor, page, board,
      collab: () => collab,
      addFiles, addUrl, pickFiles, openEmbed, askLink, openShare, openSearch, toggleFrames, startPresent,
      exportPdf, exportJson, importJson: () => jsonInput.click(), showShortcuts, pasteAt, clearBoard,
      saveNow: async () => { dirty = true; await save(); },
    });

    function showShortcuts() {
      const groups = [
        ['Tools', [['V', 'Select'], ['H / Space', 'Hand (pan)'], ['N', 'Sticky note'], ['T', 'Text'], ['S · R · O', 'Shape · Rectangle · Ellipse'], ['L · A', 'Line · Arrow'], ['P · E', 'Pen · Eraser'], ['F', 'Frame'], ['B · ⇧B', 'Border box · curve'], ['U', 'Upload media'], ['K', 'Video or link']]],
        ...(space ? [['Space', [['Right-click · /', 'Space menu'], ['Your keys', 'Camera points & object shortcuts']]]] : []),
        ['Edit', [['⌘Z / ⇧⌘Z', 'Undo / redo'], ['2 / 3-finger tap', 'Undo / redo (touch)'], ['⌘C · ⌘X · ⌘V', 'Copy · cut · paste'], ['⌥⌘C / ⌥⌘V', 'Copy / paste style'], ['⌘D', 'Duplicate'], ['Alt + drag', 'Duplicate while moving'], ['⌘G / ⇧⌘G', 'Group / ungroup'], ['⇧⌘L', 'Lock'], [']  [', 'Front / back'], ['Arrows', 'Nudge (⇧ = 10px)'], ['Tab / ⇧Tab', 'Next / previous item'], ['Click · Enter · F2', 'Edit text'], ['Del', 'Delete']]],
        ['Text', [['⌘B · ⌘I · ⌘U', 'Bold · italic · underline'], ['⇧⌘X', 'Strikethrough'], ['⌘K', 'Link'], ['⇧⌘. / ⇧⌘,', 'Bigger / smaller'], ['⇧⌘L · E · R', 'Align text (while typing)'], ['⇧⌘7 / ⇧⌘8', 'Numbered / bullet list'], ['⌘\\', 'Clear formatting'], ['⌘Enter · Esc', 'Finish typing']]],
        ['Arrange', [['⌥A · ⌥D', 'Align left · right'], ['⌥W · ⌥S', 'Align top · bottom'], ['⌥H · ⌥V', 'Align centre · middle'], ['⇧⌥H · ⇧⌥V', 'Distribute across · down']]],
        ['View', [['Scroll · ⇧Scroll', 'Move up/down · sideways'], ['Ctrl + scroll / pinch', 'Zoom'], ['Right-drag · middle-drag · Space+drag', 'Move the screen (works over objects too)'], ['⇧1', 'Fit all'], ['⇧2', 'Fit selection'], ['⌘+ / ⌘−', 'Zoom'], ['⌘0', '100%'], ['G', 'Toggle dot grid'], ['⌘F', 'Find'], ['⌘E', 'Export JSON'], ['⌘P', 'Export PDF'], ['?', 'This list']]],
      ];
      dialog({
        title: 'Keyboard shortcuts',
        width: 1000,
        body: h('div', { class: 'keys' }, groups.map(([g, rows]) => h('section', {},
          h('h3', { class: 'pop-label' }, g),
          h('dl', {}, rows.map(([k, v]) => [h('dt', {}, kbd(k)), h('dd', {}, v)]))))),
        actions: [{ label: 'Done', primary: true, value: true }],
      });
    }
  }

  return {
    destroy() {
      destroyed = true;
      cleanups.forEach((f) => { try { f(); } catch (e) { console.error(e); } });
      closeFloating();
      editor?.destroy();
      page.remove();
      document.title = 'Architect';
    },
  };
}

/* ---------- media helpers ---------- */
function fitSize(d, max) {
  const w = d?.w || 16, hh = d?.h || 9;
  const k = Math.min(1, max / Math.max(w, hh));
  return { w: Math.round(w * k) || max, h: Math.round(hh * k) || Math.round(max * 9 / 16) };
}

function mediaSize(file, kind) {
  const url = URL.createObjectURL(file);
  return new Promise((resolve) => {
    const done = (d) => { URL.revokeObjectURL(url); resolve(d); };
    const timer = setTimeout(() => done({ w: 16, h: 9 }), 6000);
    if (kind === 'video') {
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.muted = true;
      v.onloadedmetadata = () => { clearTimeout(timer); done({ w: v.videoWidth || 16, h: v.videoHeight || 9 }); };
      v.onerror = () => { clearTimeout(timer); done({ w: 16, h: 9 }); };
      v.src = url;
    } else {
      const img = new Image();
      img.onload = () => { clearTimeout(timer); done({ w: img.naturalWidth || 4, h: img.naturalHeight || 3 }); };
      img.onerror = () => { clearTimeout(timer); done({ w: 4, h: 3 }); };
      img.src = url;
    }
  });
}

function imageSizeFromUrl(src) {
  return new Promise((resolve) => {
    const img = new Image();
    const timer = setTimeout(() => resolve({ w: 4, h: 3 }), 5000);
    img.onload = () => { clearTimeout(timer); resolve({ w: img.naturalWidth || 4, h: img.naturalHeight || 3 }); };
    img.onerror = () => { clearTimeout(timer); resolve({ w: 4, h: 3 }); };
    img.src = src;
  });
}
