// Settings → Updates & Fixes (Nov 24).
// The "Architect SYSTEM Updates — HQ" board, built into Settings: update notes and their linked previews
// sit on a freeform canvas, so there's no separate Blueprint to open. Select a note and
//   · Push Update — start it now, or
//   · Schedule — run it later.
// The run itself happens on your PC, in the background, through the Architect runner (runner/): it resumes
// the Claude session linked to Architect when there is one, or starts a fresh one with the selected note and
// the latest saved project state (a git pull of your Architect folder). No terminal windows, pop-ups or
// focus stealing, and it keeps going after you close Settings. The panel beside the canvas shows the current
// step, the run status and the estimated time left (when there is one). If the run needs your input it shows
// as Blocked there — answer it in the panel and it carries on. The result is written on the same note once
// it has been tested.
//
// Canvas: prefs.updCanvas = { notes: [{ id, x, y, w, h, title, text, tone }], previews: [{ id, x, y, w, path | url, name }],
//                             links: [{ note, preview }] }
// Runs:   table architect_update_runs (supabase/nov24.sql); the runner talks to architect_runner() with an
//         API token from Settings → API.
import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { menu, toast, confirmDialog } from '../core/ui.js';
import { uid, store } from '../core/util.js';
import { api, configured, friendlyError } from '../data/api.js';
import { getPref, setPref } from '../data/prefs.js';

// Nov 25 — the canvas IS a regular Blueprint now: the same canvas, toolbar, menus and keyboard shortcuts as
// any board (pan, zoom, select, move, edit, connectors). Update notes are sticky notes; a preview is an image
// connected to its note. Push Update, Schedule and the run status stay in the panel beside it, for the
// selected note. The old simple canvas (prefs.updCanvas) moves onto the board once, then isn't used.
import { mountBoard } from '../board/board.js';
import { setSurface, getSurface } from '../board/editor.js';
import { go } from '../core/router.js';
const NOTE = { w: 220, h: 150 };
const PREV = { w: 200 };
const LIVE = new Set(['queued', 'running', 'blocked']);
const STATUS_TEXT = { queued: 'Queued', scheduled: 'Scheduled', running: 'Running', blocked: 'Blocked — needs you', done: 'Done', failed: 'Failed', canceled: 'Canceled' };
const missing = (e) => /relation .* does not exist|Could not find the table|42P01|PGRST205/i.test(`${e?.code || ''} ${e?.message || ''}`);
const clean = (c) => ({ notes: Array.isArray(c?.notes) ? c.notes : [], previews: Array.isArray(c?.previews) ? c.previews : [], links: Array.isArray(c?.links) ? c.links : [] });
const fmtLeft = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); if (s < 60) return `${s}s`; const m = Math.round(s / 60); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
const when = (t) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Runs for your notes (newest first). Shared with the panel, polled while Settings is open. */
async function loadRuns() {
  return api.db.select('architect_update_runs', { columns: 'id,note_id,title,status,step,eta_at,need,answer,result,run_at,started_at,ended_at,created_at,session,log', order: 'created_at.desc' });
}

function legacyCanvas({ extras } = {}) {
  let data = clean(getPref('updCanvas', null));
  let picked = null;            // selected note id
  let runs = [];
  let runsErr = null;
  let destroyed = false;
  const save = () => setPref('updCanvas', data).catch((e) => toast(friendlyError(e), { tone: 'error' }));

  const world = h('div', { class: 'uf-world' });
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('uf-links');
  const canvas = h('div', { class: 'uf-canvas', tabindex: 0, 'aria-label': 'Updates and fixes canvas' }, svg, world);
  const panel = h('aside', { class: 'uf-panel', 'aria-live': 'polite' });
  const add = (kind) => h('button', { type: 'button', class: 'btn sm', onclick: () => (kind === 'note' ? addNote() : addPreview()) }, icon(kind === 'note' ? 'note' : 'image', 13), kind === 'note' ? 'Note' : 'Preview');
  const bar = h('div', { class: 'uf-bar' }, add('note'), add('preview'), h('span', { class: 'uf-flex' }),
    h('span', { class: 'uf-legend' }, h('i', { class: 'is-todo' }), 'TO BUILD', h('i', { class: 'is-done' }), 'SHIPPED'));
  const root = h('div', { class: 'uf' }, h('div', { class: 'uf-main' }, bar, canvas), panel);
  const wrap = h('div', { class: 'stack uf-wrap' }, root, ...(extras ? [extras()] : []));

  /* ---------------- canvas ---------------- */
  const noteRun = (id) => runs.find((r) => r.note_id === id) || null;
  const toneOf = (n) => {
    const r = noteRun(n.id);
    if (r && LIVE.has(r.status)) return r.status === 'blocked' ? 'blocked' : 'running';
    return n.tone || (r?.status === 'done' ? 'done' : 'todo');
  };
  function paint() {
    if (destroyed) return;
    world.replaceChildren(...data.previews.map(previewNode), ...data.notes.map(noteNode));
    requestAnimationFrame(paintLinks);
    paintPanel();
  }
  function paintLinks() {
    const w = Math.max(canvas.scrollWidth, canvas.clientWidth), hh = Math.max(canvas.scrollHeight, canvas.clientHeight);
    svg.setAttribute('width', w); svg.setAttribute('height', hh);
    svg.replaceChildren(...data.links.map((l) => {
      const a = data.notes.find((n) => n.id === l.note), b = data.previews.find((p) => p.id === l.preview);
      if (!a || !b) return null;
      const bn = world.querySelector(`[data-pid="${b.id}"]`);
      const ax = a.x + (a.w || NOTE.w) / 2, ay = a.y + (a.h || NOTE.h) / 2;
      const bx = b.x + (b.w || PREV.w) / 2, by = b.y + (bn?.offsetHeight || 120) / 2;
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      Object.entries({ x1: ax, y1: ay, x2: bx, y2: by }).forEach(([k, v]) => line.setAttribute(k, v));
      line.classList.toggle('is-on', l.note === picked);
      return line;
    }).filter(Boolean));
  }

  function noteNode(n) {
    const tone = toneOf(n);
    const r = noteRun(n.id);
    const title = h('div', { class: 'uf-note-title', contenteditable: 'plaintext-only', spellcheck: false, 'data-ph': 'Update title' }, n.title || '');
    const text = h('div', { class: 'uf-note-text', contenteditable: 'plaintext-only', spellcheck: false, 'data-ph': 'What should change…' }, n.text || '');
    const commit = () => {
      const t = title.textContent.trim().slice(0, 140), x = text.textContent.trim().slice(0, 4000);
      if (t === (n.title || '') && x === (n.text || '')) return;
      n.title = t; n.text = x; save(); paintPanel();
    };
    for (const f of [title, text]) {
      f.addEventListener('blur', commit);
      f.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' && f === title) { e.preventDefault(); text.focus(); } if (e.key === 'Escape') { e.preventDefault(); f.blur(); } });
    }
    const badge = r && (LIVE.has(r.status) || r.status === 'failed') ? h('span', { class: ['uf-badge', `is-${r.status}`] }, h('i'), STATUS_TEXT[r.status]) : null;
    const result = n.result || (r?.status === 'done' ? r.result : null);
    const node = h('article', {
      class: ['uf-note', `is-${tone}`, picked === n.id && 'is-picked'], 'data-nid': n.id,
      style: { left: `${n.x}px`, top: `${n.y}px`, width: `${n.w || NOTE.w}px`, minHeight: `${n.h || NOTE.h}px` },
      oncontextmenu: (e) => { e.preventDefault(); e.stopPropagation(); noteMenu({ x: e.clientX, y: e.clientY }, n); },
    }, h('span', { class: 'uf-grip', 'aria-hidden': 'true' }), title, text,
      result ? h('div', { class: 'uf-result', title: 'Result after testing' }, h('b', {}, 'RESULT'), result) : null,
      badge,
      h('span', { class: 'uf-link-handle', title: 'Drag onto a preview to link it', 'aria-label': 'Link to a preview' }),
      h('span', { class: 'uf-size', 'aria-hidden': 'true' }));
    node.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('.uf-link-handle')) { linkDrag(e, n); return; }
      if (e.target.closest('.uf-size')) { sizeDrag(e, n, node); return; }
      select(n.id);
      if (e.target.closest('[contenteditable]')) return;
      moveDrag(e, n, node);
    });
    return node;
  }

  function previewNode(p) {
    const img = h('img', { alt: p.name || 'Preview', draggable: false, loading: 'lazy' });
    if (p.path) api.media.sign([p.path]).then((m) => { if (m?.[p.path]) img.src = m[p.path]; }).catch(() => {});
    const linked = data.links.some((l) => l.preview === p.id && l.note === picked);
    const node = h('figure', {
      class: ['uf-prev', linked && 'is-linked'], 'data-pid': p.id, style: { left: `${p.x}px`, top: `${p.y}px`, width: `${p.w || PREV.w}px` },
      oncontextmenu: (e) => { e.preventDefault(); e.stopPropagation(); previewMenu({ x: e.clientX, y: e.clientY }, p); },
    }, p.path ? img : h('a', { href: p.url, target: '_blank', rel: 'noopener' }, p.url), p.name ? h('figcaption', {}, p.name) : null, h('span', { class: 'uf-size', 'aria-hidden': 'true' }));
    node.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('a')) return;
      if (e.target.closest('.uf-size')) { sizeDrag(e, p, node, true); return; }
      moveDrag(e, p, node);
    });
    img.addEventListener('load', () => paintLinks());
    return node;
  }

  const startDrag = (e, onMove, onEnd) => {
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY;
    let moved = false;
    const mv = (ev) => { const dx = ev.clientX - sx, dy = ev.clientY - sy; if (!moved && Math.hypot(dx, dy) < 3) return; moved = true; onMove(dx, dy, ev); };
    const up = (ev) => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); onEnd?.(moved, ev); };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  };
  function moveDrag(e, o, node) {
    const x0 = o.x, y0 = o.y;
    node.classList.add('is-moving');
    startDrag(e, (dx, dy) => { o.x = Math.max(0, Math.round(x0 + dx)); o.y = Math.max(0, Math.round(y0 + dy)); node.style.left = `${o.x}px`; node.style.top = `${o.y}px`; paintLinks(); },
      (moved) => { node.classList.remove('is-moving'); if (moved) save(); });
  }
  function sizeDrag(e, o, node, isPrev = false) {
    const w0 = o.w || (isPrev ? PREV.w : NOTE.w), h0 = o.h || NOTE.h;
    startDrag(e, (dx, dy) => {
      o.w = Math.max(isPrev ? 100 : 160, Math.round(w0 + dx)); node.style.width = `${o.w}px`;
      if (!isPrev) { o.h = Math.max(110, Math.round(h0 + dy)); node.style.minHeight = `${o.h}px`; }
      paintLinks();
    }, (moved) => { if (moved) save(); });
  }
  function linkDrag(e, n) {
    e.preventDefault(); e.stopPropagation();
    const cr = canvas.getBoundingClientRect();
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.classList.add('is-draft');
    const ax = n.x + (n.w || NOTE.w) / 2, ay = n.y + (n.h || NOTE.h) / 2;
    line.setAttribute('x1', ax); line.setAttribute('y1', ay); line.setAttribute('x2', ax); line.setAttribute('y2', ay);
    svg.append(line);
    startDrag(e, (dx, dy, ev) => { line.setAttribute('x2', ev.clientX - cr.left + canvas.scrollLeft); line.setAttribute('y2', ev.clientY - cr.top + canvas.scrollTop); },
      (moved, ev) => {
        line.remove();
        const pid = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('.uf-prev')?.dataset.pid;
        if (!pid || data.links.some((l) => l.note === n.id && l.preview === pid)) return;
        data.links.push({ note: n.id, preview: pid });
        save(); paint();
      });
  }

  // Double-click empty canvas: a new note right there.
  canvas.addEventListener('dblclick', (e) => {
    if (e.target !== canvas && e.target !== world && e.target !== svg) return;
    const r = canvas.getBoundingClientRect();
    addNote({ x: e.clientX - r.left + canvas.scrollLeft - 20, y: e.clientY - r.top + canvas.scrollTop - 20 });
  });
  canvas.addEventListener('pointerdown', (e) => { if (e.target === canvas || e.target === world || e.target === svg) select(null); });
  canvas.addEventListener('contextmenu', (e) => {
    if (e.target !== canvas && e.target !== world && e.target !== svg) return;
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const at = { x: e.clientX - r.left + canvas.scrollLeft, y: e.clientY - r.top + canvas.scrollTop };
    menu({ x: e.clientX, y: e.clientY }, [
      { label: 'New update note', icon: 'note', onSelect: () => addNote(at) },
      { label: 'Add a preview image…', icon: 'image', onSelect: () => addPreview(at) },
    ]);
  });
  // Paste a screenshot onto the canvas: a preview, linked to the selected note.
  canvas.addEventListener('paste', (e) => {
    if (e.target.closest?.('[contenteditable]')) return;
    const fs = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (!fs.length) return;
    e.preventDefault();
    uploadPreviews(fs);
  });
  canvas.addEventListener('keydown', (e) => {
    if (e.target !== canvas) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && picked) { e.preventDefault(); removeNote(data.notes.find((n) => n.id === picked)); }
  });

  const freeSpot = () => {
    const y = Math.max(16, ...data.notes.map((n) => n.y + (n.h || NOTE.h) + 24), ...data.previews.map((p) => p.y + 160)) ;
    return { x: 24 + canvas.scrollLeft, y: data.notes.length || data.previews.length ? Math.min(y, canvas.scrollTop + 40) : 24 };
  };
  function addNote(at = null) {
    const p = at || freeSpot();
    const n = { id: uid(), x: Math.round(p.x), y: Math.round(p.y), w: NOTE.w, h: NOTE.h, title: '', text: '' };
    data.notes.push(n);
    save(); select(n.id); paint();
    requestAnimationFrame(() => world.querySelector(`[data-nid="${n.id}"] .uf-note-title`)?.focus());
  }
  async function addPreview(at = null) {
    const inp = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true });
    document.body.append(inp);
    inp.addEventListener('change', () => { const fs = [...inp.files]; inp.remove(); if (fs.length) uploadPreviews(fs, at); });
    inp.click();
  }
  async function uploadPreviews(files, at = null) {
    const base = at || (() => { const n = data.notes.find((x) => x.id === picked); return n ? { x: n.x + (n.w || NOTE.w) + 40, y: n.y } : freeSpot(); })();
    let i = 0;
    for (const f of files) {
      try {
        const up = await api.media.upload(f);
        const p = { id: uid(), x: Math.round(base.x + i * 24), y: Math.round(base.y + i * 24), w: PREV.w, path: up.path, name: f.name.replace(/\.\w+$/, '').slice(0, 60) };
        data.previews.push(p);
        if (picked) data.links.push({ note: picked, preview: p.id });
        i++;
      } catch (e) { toast(friendlyError(e), { tone: 'error' }); }
    }
    if (i) { save(); paint(); }
  }
  function select(id) {
    if (picked === id) return;
    picked = id;
    world.querySelectorAll('.uf-note').forEach((x) => x.classList.toggle('is-picked', x.dataset.nid === id));
    world.querySelectorAll('.uf-prev').forEach((x) => x.classList.toggle('is-linked', data.links.some((l) => l.preview === x.dataset.pid && l.note === id)));
    paintLinks(); paintPanel();
  }
  async function removeNote(n) {
    if (!n) return;
    if ((n.title || n.text) && !(await confirmDialog('Delete this note?', 'Its links go too. Previews stay on the canvas.', { ok: 'Delete' }))) return;
    data.notes = data.notes.filter((x) => x.id !== n.id);
    data.links = data.links.filter((l) => l.note !== n.id);
    if (picked === n.id) picked = null;
    save(); paint();
  }
  function noteMenu(at, n) {
    const r = noteRun(n.id);
    select(n.id);
    menu(at, [
      { label: 'Push Update', icon: 'upload', disabled: r && LIVE.has(r.status), onSelect: () => push(n) },
      { label: 'Schedule…', icon: 'clock', onSelect: () => { paintPanel(true); } },
      '-',
      { label: n.tone === 'done' || (!n.tone && r?.status === 'done') ? 'Mark as to build (yellow)' : 'Mark as shipped (green)', icon: 'check',
        onSelect: () => { n.tone = toneOf(n) === 'done' ? 'todo' : 'done'; save(); paint(); } },
      { label: 'Add a preview…', icon: 'image', onSelect: () => addPreview() },
      n.result ? { label: 'Clear the result', icon: 'eraser', onSelect: () => { n.result = null; save(); paint(); } } : null,
      '-',
      { label: 'Delete note', icon: 'trash', danger: true, onSelect: () => removeNote(n) },
    ].filter(Boolean));
  }
  function previewMenu(at, p) {
    menu(at, [
      picked ? { label: data.links.some((l) => l.note === picked && l.preview === p.id) ? 'Unlink from the selected note' : 'Link to the selected note', icon: 'link',
        onSelect: () => {
          const has = data.links.some((l) => l.note === picked && l.preview === p.id);
          data.links = has ? data.links.filter((l) => !(l.note === picked && l.preview === p.id)) : [...data.links, { note: picked, preview: p.id }];
          save(); paint();
        } } : null,
      { label: 'Delete preview', icon: 'trash', danger: true, onSelect: () => { data.previews = data.previews.filter((x) => x.id !== p.id); data.links = data.links.filter((l) => l.preview !== p.id); save(); paint(); } },
    ].filter(Boolean));
  }

  /* ---------------- runs ---------------- */
  const noteSnapshot = (n) => ({
    title: n.title || 'Untitled update', text: n.text || '',
    previews: data.links.filter((l) => l.note === n.id).map((l) => data.previews.find((p) => p.id === l.preview)).filter(Boolean).map((p) => ({ path: p.path || null, url: p.url || null, name: p.name || '' })),
  });
  async function push(n, runAt = null) {
    if (!configured) { toast('Push Update needs Supabase sync (config.js).', { tone: 'error' }); return; }
    if (!(n.title || n.text)) { toast('Write what the update should do first.', { tone: 'error' }); return; }
    const last = runs.find((r) => r.note_id === n.id && r.session);
    // Previews travel as links the runner can download (signed for a week — enough for a scheduled run).
    const snap = noteSnapshot(n);
    try {
      const paths = snap.previews.map((p) => p.path).filter(Boolean);
      if (paths.length) { const m = await api.media.sign(paths); snap.previews.forEach((p) => { if (p.path && m?.[p.path]) p.url = m[p.path]; }); }
    } catch {}
    try {
      await api.db.insert('architect_update_runs', {
        id: uid(), note_id: n.id, title: (n.title || 'Untitled update').slice(0, 140), note: snap,
        status: 'queued', run_at: (runAt || new Date()).toISOString(), session: last?.session || null, log: [],
      });
      toast(runAt ? `Scheduled for ${when(runAt)}.` : 'Pushed — it starts on your PC within a few seconds.', { ms: 2600 });
      await refresh();
    } catch (e) { toast(missing(e) ? 'Updates & Fixes needs one database update: run supabase/nov24.sql in the Supabase SQL editor.' : friendlyError(e), { tone: 'error', ms: 6000 }); }
  }
  async function patchRun(r, p) {
    try { await api.db.update('architect_update_runs', r.id, p); await refresh(); } catch (e) { toast(friendlyError(e), { tone: 'error' }); }
  }

  function paintPanel(scheduling = false) {
    if (destroyed) return;
    const n = data.notes.find((x) => x.id === picked);
    if (!n) {
      const live = runs.filter((r) => LIVE.has(r.status));
      panel.replaceChildren(...[
        h('h4', { class: 'uf-h' }, 'RUNS'),
        runsErr ? h('p', { class: 'uf-hint is-bad' }, runsErr) : null,
        live.length ? h('div', { class: 'uf-runs' }, ...live.map((r) => runCard(r, true))) : h('p', { class: 'uf-hint' }, 'Nothing running. Select a note, then Push Update or Schedule.'),
        runnerHelp()].filter(Boolean));
      return;
    }
    const mine = runs.filter((r) => r.note_id === n.id);
    const cur = mine.find((r) => LIVE.has(r.status) || (r.status === 'queued')) || null;
    const dt = h('input', { class: 'input sm', type: 'datetime-local', 'aria-label': 'Run at', value: localInput(new Date(Date.now() + 3600_000)), onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); } } });
    const sched = h('div', { class: 'uf-sched', hidden: !scheduling },
      dt,
      h('button', { type: 'button', class: 'btn sm', onclick: () => { const t = new Date(dt.value); if (!dt.value || Number.isNaN(+t)) { toast('Pick a date and time.', { tone: 'error' }); return; } if (t < new Date()) { toast('That time has passed.', { tone: 'error' }); return; } push(n, t); } }, 'Schedule'));
    panel.replaceChildren(...[
      h('h4', { class: 'uf-h' }, (n.title || 'Untitled update').toUpperCase()),
      h('div', { class: 'uf-actions' },
        h('button', { type: 'button', class: 'btn btn-primary sm', disabled: !!cur, onclick: () => push(n) }, icon('upload', 13), 'Push Update'),
        h('button', { type: 'button', class: 'btn sm', disabled: !!cur, onclick: () => { sched.hidden = !sched.hidden; if (!sched.hidden) dt.focus(); } }, icon('clock', 13), 'Schedule')),
      sched,
      mine.length ? h('div', { class: 'uf-runs' }, ...mine.slice(0, 6).map((r) => runCard(r))) : h('p', { class: 'uf-hint' }, 'Not run yet.'),
      runsErr ? h('p', { class: 'uf-hint is-bad' }, runsErr) : null].filter(Boolean));
  }
  function runCard(r, showTitle = false) {
    const due = r.status === 'queued' && Date.parse(r.run_at) > Date.now() + 30_000;
    const st = due ? 'scheduled' : r.status;
    const eta = r.eta_at && r.status === 'running' ? Date.parse(r.eta_at) - Date.now() : null;
    const ans = h('textarea', { class: 'input uf-answer', rows: 2, placeholder: 'Your answer…', 'aria-label': 'Answer', onkeydown: (e) => e.stopPropagation() });
    return h('div', { class: ['uf-run', `is-${st}`] },
      h('div', { class: 'uf-run-top' }, h('span', { class: ['uf-badge', `is-${st}`] }, h('i'), STATUS_TEXT[st] || st), h('span', { class: 'uf-flex' }), h('small', {}, when(r.started_at || r.run_at || r.created_at))),
      showTitle ? h('b', { class: 'uf-run-title' }, r.title) : null,
      due ? h('p', { class: 'uf-step' }, `Runs ${when(r.run_at)}`) : null,
      r.step && LIVE.has(r.status) ? h('p', { class: 'uf-step' }, r.step) : null,
      eta != null ? h('p', { class: 'uf-eta' }, eta > 0 ? `About ${fmtLeft(eta)} left` : 'Finishing up…') : null,
      r.status === 'blocked' ? h('div', { class: 'uf-block' },
        h('p', {}, r.need || 'The run needs your input.'),
        ans,
        h('button', { type: 'button', class: 'btn btn-primary sm', onclick: () => { const v = ans.value.trim(); if (!v) { ans.focus(); return; } patchRun(r, { answer: v, status: 'queued', need: null, run_at: new Date().toISOString() }); } }, 'Send answer')) : null,
      (r.status === 'done' || r.status === 'failed') && r.result ? h('p', { class: 'uf-res' }, r.result) : null,
      LIVE.has(r.status) || r.status === 'queued' ? h('button', { type: 'button', class: 'btn sm uf-cancel', onclick: () => patchRun(r, { status: 'canceled', ended_at: new Date().toISOString() }) }, 'Cancel') : null);
  }
  function runnerHelp() {
    return h('details', { class: 'uf-help' },
      h('summary', {}, 'How runs work'),
      h('p', {}, 'Runs happen on your PC with the Architect runner (the runner/ folder in your Architect repo). It checks for pushed and scheduled updates every few seconds, resumes the Claude session linked to Architect when there is one — or starts a new one with the note and the latest saved project — then reports each step here.'),
      h('p', {}, 'Set it up once: Settings → API → generate a token, then on the PC run  node runner/architect-runner.mjs setup  and  install-windows.ps1. It runs hidden: no windows, no pop-ups, no focus stealing.'));
  }
  const localInput = (d) => { const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000); return z.toISOString().slice(0, 16); };

  async function refresh() {
    if (destroyed || !configured) return;
    try { runs = await loadRuns(); runsErr = null; }
    catch (e) { runsErr = missing(e) ? 'Run supabase/nov24.sql in the Supabase SQL editor to turn on Push Update.' : friendlyError(e); }
    // A finished run writes its result onto its note (once).
    let changed = false;
    for (const r of runs) {
      if (r.status !== 'done' || !r.result) continue;
      const n = data.notes.find((x) => x.id === r.note_id);
      if (n && n.resultRun !== r.id) { n.result = r.result.slice(0, 1200); n.resultRun = r.id; if (!n.tone) n.tone = 'done'; changed = true; }
    }
    if (changed) save();
    if (!world.querySelector('[contenteditable]:focus')) paint(); else paintPanel();
  }
  const poll = setInterval(() => { if (!wrap.isConnected) { stop(); return; } if (!document.hidden) refresh(); }, 5000);
  function stop() { destroyed = true; clearInterval(poll); }

  paint();
  refresh();
  return wrap;
}


/* ================= the Blueprint version (Nov 25) ================= */
const BOARD_NAME = 'Architect SYSTEM Updates — HQ';
const SURFACE = 'settings-updates';
const TONE_FILL = { todo: '#F2C94C', done: '#3FAE6A' };
const escHtml = (t) => String(t || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const plain = (html) => { const d = document.createElement('div'); d.innerHTML = String(html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<(div|p|li|h\d)\b/gi, '\n<$1').replace(/<\/(div|p|li|h\d)>/gi, '\n'); return (d.textContent || '').replace(/\u00a0/g, ' ').replace(/\n{3,}/g, '\n\n').trim(); };

/** The old canvas's notes, previews and links as board elements (sticky notes, images, connectors). */
function migrate(c) {
  const els = [];
  for (const n of c.notes) {
    els.push({ id: n.id, type: 'sticky', x: n.x || 0, y: n.y || 0, w: Math.max(200, n.w || NOTE.w), h: Math.max(160, n.h || NOTE.h), fill: TONE_FILL[n.tone === 'done' ? 'done' : 'todo'], align: 'left', fontSize: 15,
      html: `<b>${escHtml(n.title || 'Update')}</b>${n.text ? `<div>${escHtml(n.text).replace(/\n/g, '<br>')}</div>` : ''}${n.result ? `<div><b>RESULT</b> ${escHtml(n.result)}</div>` : ''}`,
      text: [n.title || 'Update', n.text || '', n.result ? `RESULT ${n.result}` : ''].filter(Boolean).join('\n'), ...(n.tone ? { updTone: n.tone } : {}) });
  }
  for (const p of c.previews) {
    const w = p.w || PREV.w;
    els.push({ id: p.id, type: 'image', x: p.x || 0, y: p.y || 0, w, h: Math.round(w * 0.66), ...(p.path ? { path: p.path } : { src: p.url }), ...(p.name ? { alt: p.name } : {}) });
  }
  for (const l of c.links) {
    if (!els.some((e) => e.id === l.note) || !els.some((e) => e.id === l.preview)) continue;
    els.push({ id: uid(), type: 'line', a: { id: l.note }, b: { id: l.preview }, stroke: 'auto', strokeWidth: 2, route: 'straight', startCap: 'none', endCap: 'none', dash: 'dashed' });
  }
  return els;
}

async function ensureBoard() {
  const have = getPref('updBoardId', null);
  if (have) {
    try { if (await api.db.get('blueprints', have, 'id')) return have; } catch (e) { if (!/not.*found|no rows/i.test(String(e?.message))) throw e; }
  }
  const id = uid();
  const row = { id, name: BOARD_NAME, kind: 'board', folder_id: null, pinned: false, data: { v: 1, elements: migrate(clean(getPref('updCanvas', null))) }, preview: [] };
  await api.db.insert('blueprints', row).catch(async (e) => {
    if (/kind/.test(String(e?.message))) { delete row.kind; return api.db.insert('blueprints', row); }
    throw e;
  });
  await setPref('updBoardId', id);
  return id;
}

export function updatesCanvas({ extras } = {}) {
  let ed = null;            // the board's editor once it's up
  let picked = null;        // the selected update note (a sticky note's id)
  let runs = [];
  let runsErr = null;
  let destroyed = false;
  let handle = null;
  let boardId = null;
  const host = h('div', { class: 'uf-board', 'data-surface': SURFACE });
  const panel = h('aside', { class: 'uf-panel', 'aria-live': 'polite' });
  const root = h('div', { class: 'uf is-board' }, h('div', { class: 'uf-main' }, host), panel);
  const wrap = h('div', { class: 'stack uf-wrap' }, root, ...(extras ? [extras()] : []));
  host.append(h('div', { class: 'bp-loading' }, h('span', { class: 'dots-loader' }, h('i'), h('i'), h('i'))));
  const prevSurface = getSurface();

  const notes = () => (ed ? ed.els.filter((e) => e.type === 'sticky') : []);
  const noteById = (id) => (ed ? ed.byId.get(id) : null);
  const noteRun = (id) => runs.find((r) => r.note_id === id) || null;
  const txt = (n) => plain(n?.html || n?.text).replace(/^\n+/, '');
  const noteTitle = (n) => txt(n).split('\n')[0].trim().slice(0, 140) || 'Untitled update';
  const noteBody = (n) => txt(n).split('\n').slice(1).join('\n').replace(/\n?RESULT [\s\S]*$/, '').trim().slice(0, 4000);
  const linkedPreviews = (n) => {
    if (!ed || !n) return [];
    const ids = new Set();
    for (const l of ed.els) if (l.type === 'line') { if (l.a?.id === n.id && l.b?.id) ids.add(l.b.id); if (l.b?.id === n.id && l.a?.id) ids.add(l.a.id); }
    return [...ids].map((id) => ed.byId.get(id)).filter((x) => x && (x.type === 'image' || x.type === 'link' || x.type === 'embed'));
  };

  (async () => {
    try { boardId = await ensureBoard(); }
    catch (e) {
      // No board possible (e.g. no Supabase table access): the previous simple canvas still works.
      if (destroyed) return;
      wrap.replaceWith(legacyCanvas({ extras }));
      toast(`Updates & Fixes couldn’t open as a Blueprint — ${friendlyError(e)}`, { tone: 'error', ms: 5000 });
      return;
    }
    if (destroyed) return;
    host.replaceChildren();
    setSurface(SURFACE);
    handle = mountBoard(host, boardId, {
      windowed: {
        surface: SURFACE,
        onExpand: () => { const id = boardId; closeDlg(); go(`board/${id}`); },
        onClose: () => closeDlg(),
        onName: () => {},
      },
      extendMenu: (items, { onElement, sel }) => {
        const n = onElement && sel.length === 1 && sel[0].type === 'sticky' ? sel[0] : null;
        if (!n) return items;
        const r = noteRun(n.id);
        const live = r && LIVE.has(r.status);
        const done = (n.updTone || (r?.status === 'done' ? 'done' : 'todo')) === 'done';
        return [
          { label: 'Push Update', icon: 'upload', disabled: !!live, onSelect: () => push(n.id) },
          { label: 'Schedule…', icon: 'clock', disabled: !!live, onSelect: () => { select(n.id); paintPanel(true); } },
          { label: done ? 'Mark as to build (yellow)' : 'Mark as shipped (green)', icon: 'check', onSelect: () => setTone(n.id, done ? 'todo' : 'done') },
          '-', ...items,
        ];
      },
      onReady: (tools) => {
        ed = tools.editor;
        // Settings focuses its first field on open — here that's the board's name; nobody meant to type there.
        const unfocus = () => { if (document.activeElement?.classList?.contains('bp-title')) document.activeElement.blur(); };
        unfocus(); requestAnimationFrame(unfocus); setTimeout(unfocus, 120);
        if (!store.get(`architect.cam.${boardId}`, null) && ed.els.length) requestAnimationFrame(() => ed.zoomToFit(false));
        ed.on('selection', () => {
          const sel = ed.selected();
          const one = sel.length === 1 && sel[0].type === 'sticky' ? sel[0].id : null;
          // Clicking a preview linked to one note keeps that note in the panel.
          const prev = !one && sel.length === 1 ? notes().find((x) => linkedPreviews(x).some((p) => p.id === sel[0].id)) : null;
          select(one || prev?.id || (sel.length ? picked : null));
        });
        ed.on('change', () => { if (picked && !noteById(picked)) select(null); else paintPanel(); });
        refresh();
      },
    });
  })();

  function closeDlg() { const f = host.closest('form.dlg'); if (f?._close) f._close(true); }
  // Settings is a form: Enter in the board's fields must not submit (close) it, and Esc first clears what
  // you're doing on the board — only an Esc with nothing selected closes Settings.
  host.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target instanceof HTMLInputElement) e.preventDefault(); });
  const onEsc = (e) => {
    if (e.key !== 'Escape' || !ed || !host.isConnected) return;
    if (getSurface() !== SURFACE && !host.contains(document.activeElement)) return;
    if (document.querySelector('.menu, .pop')) return;
    if (ed.editingId) ed.finishEditing();
    else if (ed.sel.size) ed.clearSel();
    else return;
    e.preventDefault(); e.stopImmediatePropagation();
  };
  window.addEventListener('keydown', onEsc, true);
  function select(id) { if (picked === id) return; picked = id; paintPanel(); }
  function setTone(id, tone) {
    if (!ed) return;
    ed.updateEls([id], { updTone: tone, fill: TONE_FILL[tone] });
    paintPanel();
  }

  const noteSnapshot = (n) => ({
    title: noteTitle(n), text: noteBody(n),
    previews: linkedPreviews(n).map((p) => ({ path: p.path || null, url: p.src || p.url || null, name: p.alt || p.title || '' })),
  });
  async function push(id, runAt = null) {
    const n = noteById(id);
    if (!n) return;
    if (!configured) { toast('Push Update needs Supabase sync (config.js).', { tone: 'error' }); return; }
    if (!txt(n)) { toast('Write what the update should do on the note first.', { tone: 'error' }); return; }
    const last = runs.find((r) => r.note_id === n.id && r.session);
    const snap = noteSnapshot(n);
    try {
      const paths = snap.previews.map((p) => p.path).filter(Boolean);
      if (paths.length) { const m = await api.media.sign(paths); snap.previews.forEach((p) => { if (p.path && m?.[p.path]) p.url = m[p.path]; }); }
    } catch {}
    try {
      await api.db.insert('architect_update_runs', {
        id: uid(), note_id: n.id, title: snap.title, note: snap,
        status: 'queued', run_at: (runAt || new Date()).toISOString(), session: last?.session || null, log: [],
      });
      toast(runAt ? `Scheduled for ${when(runAt)}.` : 'Pushed — it starts on your PC within a few seconds.', { ms: 2600 });
      await refresh();
    } catch (e) { toast(missing(e) ? 'Updates & Fixes needs one database update: run supabase/nov24.sql in the Supabase SQL editor.' : friendlyError(e), { tone: 'error', ms: 6000 }); }
  }
  async function patchRun(r, p) {
    try { await api.db.update('architect_update_runs', r.id, p); await refresh(); } catch (e) { toast(friendlyError(e), { tone: 'error' }); }
  }

  function paintPanel(scheduling = false) {
    if (destroyed) return;
    const n = picked ? noteById(picked) : null;
    if (!n) {
      const live = runs.filter((r) => LIVE.has(r.status));
      panel.replaceChildren(...[
        h('h4', { class: 'uf-h' }, 'RUNS'),
        runsErr ? h('p', { class: 'uf-hint is-bad' }, runsErr) : null,
        live.length ? h('div', { class: 'uf-runs' }, ...live.map((r) => runCard(r, true))) : h('p', { class: 'uf-hint' }, 'Nothing running. Select an update note on the canvas, then Push Update or Schedule.'),
        h('p', { class: 'uf-hint' }, 'Notes are sticky notes: yellow is to build, green is shipped. Connect a picture to a note to send it along as a preview.'),
        runnerHelp()].filter(Boolean));
      return;
    }
    const mine = runs.filter((r) => r.note_id === n.id);
    const cur = mine.find((r) => LIVE.has(r.status)) || null;
    const dt = h('input', { class: 'input sm', type: 'datetime-local', 'aria-label': 'Run at', value: localInput(new Date(Date.now() + 3600_000)), onkeydown: (e) => { e.stopPropagation(); if (e.key === 'Enter') e.preventDefault(); } });
    const sched = h('div', { class: 'uf-sched', hidden: !scheduling },
      dt,
      h('button', { type: 'button', class: 'btn sm', onclick: () => { const t = new Date(dt.value); if (!dt.value || Number.isNaN(+t)) { toast('Pick a date and time.', { tone: 'error' }); return; } if (t < new Date()) { toast('That time has passed.', { tone: 'error' }); return; } push(n.id, t); } }, 'Schedule'));
    const pv = linkedPreviews(n).length;
    panel.replaceChildren(...[
      h('h4', { class: 'uf-h' }, noteTitle(n).toUpperCase()),
      pv ? h('p', { class: 'uf-hint' }, `${pv} linked preview${pv === 1 ? '' : 's'}`) : null,
      h('div', { class: 'uf-actions' },
        h('button', { type: 'button', class: 'btn btn-primary sm', disabled: !!cur, onclick: () => push(n.id) }, icon('upload', 13), 'Push Update'),
        h('button', { type: 'button', class: 'btn sm', disabled: !!cur, onclick: () => { sched.hidden = !sched.hidden; if (!sched.hidden) dt.focus(); } }, icon('clock', 13), 'Schedule')),
      sched,
      mine.length ? h('div', { class: 'uf-runs' }, ...mine.slice(0, 6).map((r) => runCard(r))) : h('p', { class: 'uf-hint' }, 'Not run yet.'),
      runsErr ? h('p', { class: 'uf-hint is-bad' }, runsErr) : null].filter(Boolean));
    if (scheduling) requestAnimationFrame(() => dt.focus());
  }
  function runCard(r, showTitle = false) {
    const due = r.status === 'queued' && Date.parse(r.run_at) > Date.now() + 30_000;
    const st = due ? 'scheduled' : r.status;
    const eta = r.eta_at && r.status === 'running' ? Date.parse(r.eta_at) - Date.now() : null;
    const ans = h('textarea', { class: 'input uf-answer', rows: 2, placeholder: 'Your answer…', 'aria-label': 'Answer', onkeydown: (e) => e.stopPropagation() });
    return h('div', { class: ['uf-run', `is-${st}`] },
      h('div', { class: 'uf-run-top' }, h('span', { class: ['uf-badge', `is-${st}`] }, h('i'), STATUS_TEXT[st] || st), h('span', { class: 'uf-flex' }), h('small', {}, when(r.started_at || r.run_at || r.created_at))),
      showTitle ? h('button', { type: 'button', class: 'uf-run-title is-link', onclick: () => { if (noteById(r.note_id)) { ed?.select([r.note_id]); ed?.zoomToSelection?.(); select(r.note_id); } } }, r.title) : null,
      due ? h('p', { class: 'uf-step' }, `Runs ${when(r.run_at)}`) : null,
      r.step && LIVE.has(r.status) ? h('p', { class: 'uf-step' }, r.step) : null,
      eta != null ? h('p', { class: 'uf-eta' }, eta > 0 ? `About ${fmtLeft(eta)} left` : 'Finishing up…') : null,
      r.status === 'blocked' ? h('div', { class: 'uf-block' },
        h('p', {}, r.need || 'The run needs your input.'),
        ans,
        h('button', { type: 'button', class: 'btn btn-primary sm', onclick: () => { const v = ans.value.trim(); if (!v) { ans.focus(); return; } patchRun(r, { answer: v, status: 'queued', need: null, run_at: new Date().toISOString() }); } }, 'Send answer')) : null,
      (r.status === 'done' || r.status === 'failed') && r.result ? h('p', { class: 'uf-res' }, r.result) : null,
      LIVE.has(r.status) ? h('button', { type: 'button', class: 'btn sm uf-cancel', onclick: () => patchRun(r, { status: 'canceled', ended_at: new Date().toISOString() }) }, 'Cancel') : null);
  }
  function runnerHelp() {
    return h('details', { class: 'uf-help' },
      h('summary', {}, 'How runs work'),
      h('p', {}, 'Runs happen on your PC with the Architect runner (the runner/ folder in your Architect repo). It checks for pushed and scheduled updates every few seconds, resumes the Claude session linked to Architect when there is one — or starts a new one with the note and the latest saved project — then reports each step here.'),
      h('p', {}, 'Set it up once: Settings → API → generate a token, then on the PC run  node runner/architect-runner.mjs setup  and  install-windows.ps1. It runs hidden: no windows, no pop-ups, no focus stealing.'));
  }
  const localInput = (d) => { const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000); return z.toISOString().slice(0, 16); };

  async function refresh() {
    if (destroyed || !configured) { paintPanel(); return; }
    try { runs = await loadRuns(); runsErr = null; }
    catch (e) { runsErr = missing(e) ? 'Run supabase/nov24.sql in the Supabase SQL editor to turn on Push Update.' : friendlyError(e); }
    // A finished run writes its result onto its note (once) and turns it green.
    if (ed && !ed.editingId) {
      const done = getPref('updResults', {}) || {};
      let changed = false;
      for (const r of runs) {
        if (r.status !== 'done' || !r.result || done[r.note_id] === r.id) continue;
        const n = noteById(r.note_id);
        if (!n) continue;
        const res = r.result.slice(0, 1200);
        ed.updateEls([n.id], { html: `${n.html || escHtml(n.text || '').replace(/\n/g, '<br>')}<div><b>RESULT</b> ${escHtml(res)}</div>`, text: `${n.text || ''}\nRESULT ${res}`, ...(n.updTone ? {} : { updTone: 'done', fill: TONE_FILL.done }) });
        done[r.note_id] = r.id; changed = true;
      }
      if (changed) setPref('updResults', done).catch(() => {});
    }
    paintPanel();
  }
  const poll = setInterval(() => { if (!wrap.isConnected) { stop(); return; } if (!document.hidden) refresh(); }, 5000);
  function stop() {
    if (destroyed) return;
    destroyed = true; clearInterval(poll);
    window.removeEventListener('keydown', onEsc, true);
    try { handle?.destroy(); } catch {}
    if (getSurface() === SURFACE) setSurface(prevSurface && prevSurface !== SURFACE ? prevSurface : null);
  }
  // Settings closing or switching tabs removes the canvas: stop with it.
  const mo = new MutationObserver(() => { if (!wrap.isConnected && wrap._seen) { mo.disconnect(); stop(); } if (wrap.isConnected) wrap._seen = true; });
  mo.observe(document.body, { childList: true, subtree: true });

  paintPanel();
  return wrap;
}
