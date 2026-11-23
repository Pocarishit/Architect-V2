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
import { uid } from '../core/util.js';
import { api, configured, friendlyError } from '../data/api.js';
import { getPref, setPref } from '../data/prefs.js';

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

export function updatesCanvas({ extras } = {}) {
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
