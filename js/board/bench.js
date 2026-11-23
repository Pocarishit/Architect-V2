// Crowded-board benchmark (Nov 23 — Miro → Architect runbook, first release).
// Builds a disposable board with ~500 plain objects (optionally plus live widgets), then plays three
// scripted gestures through the real input paths — pan (wheel), cursor-centred zoom (Ctrl+wheel) and a
// group drag (pointer events on 50 selected objects) — and records every frame.
//   · p95 frame time and dropped frames (a frame longer than 1.5 × the display's frame budget)
//   · time in scripting / style+layout / paint, from Long Animation Frame entries where the browser has them
// Each gesture runs once as warm-up, then three times; the report keeps every run and the median.
// Nothing here touches your real boards: the fixture board is created for the run and deleted after.

const raf = () => new Promise((r) => requestAnimationFrame(r));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** ~n plain objects (stickies, shapes, text) in a grid of the same density every run. */
export function crowdedFixture(n = 500, { seed = 7 } = {}) {
  let s = seed;
  const rnd = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
  const cols = Math.ceil(Math.sqrt(n * 1.25));
  const els = [];
  const fills = ['#F0B429', '#3FA66B', '#3B82D8', '#FFFFFF', '#D9D9D9', '#D71921'];
  for (let i = 0; i < n; i++) {
    const cx = (i % cols) * 260, cy = Math.floor(i / cols) * 240;
    const k = i % 3;
    const id = `bench-${i}`;
    if (k === 0) els.push({ id, type: 'sticky', x: cx, y: cy, w: 200, h: 200, fill: fills[i % fills.length], text: `Note ${i} — ${'lorem ipsum '.repeat(1 + Math.floor(rnd() * 3)).trim()}` });
    else if (k === 1) els.push({ id, type: 'shape', kind: i % 2 ? 'rect' : 'ellipse', x: cx, y: cy + 20, w: 200, h: 160, fill: 'none', stroke: 'auto', strokeWidth: 2, fontSize: 16, align: 'center', text: `Shape ${i}` });
    else els.push({ id, type: 'text', x: cx, y: cy + 60, w: 220, h: 40, text: `Text block ${i}`, fontSize: 20, color: 'auto', align: 'left' });
  }
  return els;
}

function pct(list, p) {
  if (!list.length) return 0;
  const a = [...list].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];
}
const median = (a) => pct(a, 50);
const r1 = (v) => Math.round(v * 10) / 10;

// Frame recorder: rAF deltas + Long Animation Frame breakdown (Chrome 123+).
function recorder() {
  const frames = [];
  const loaf = { script: 0, layout: 0, render: 0, n: 0 };
  let on = true, last = 0;
  const tick = (t) => { if (!on) return; if (last) frames.push(t - last); last = t; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  let po = null;
  try {
    po = new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        loaf.n++;
        loaf.script += (e.scripts || []).reduce((s2, x) => s2 + x.duration, 0);
        if (e.styleAndLayoutStart) loaf.layout += Math.max(0, e.startTime + e.duration - e.styleAndLayoutStart);
        if (e.renderStart) loaf.render += Math.max(0, (e.styleAndLayoutStart || e.startTime + e.duration) - e.renderStart);
      }
    });
    po.observe({ type: 'long-animation-frame', buffered: false });
  } catch { po = null; }
  return {
    stop() { on = false; po?.disconnect(); return { frames, loaf: po ? loaf : null }; },
  };
}

function summarize(frames, budget) {
  const f = frames.slice(1); // the first delta straddles the gesture start
  return {
    frames: f.length,
    p95: r1(pct(f, 95)),
    avg: r1(f.reduce((a, b) => a + b, 0) / Math.max(1, f.length)),
    dropped: f.filter((d) => d > budget * 1.5).length,
  };
}

async function measureBudget() {
  const d = [];
  let last = 0;
  for (let i = 0; i < 30; i++) { const t = await raf(); if (last) d.push(t - last); last = t; }
  return Math.max(4, median(d));
}

/* ---------------- gestures, through the editor's real input handlers ---------------- */
async function pan(ed, frames) {
  const r = ed.vp.getBoundingClientRect();
  for (let i = 0; i < frames; i++) {
    const a = (i / frames) * Math.PI * 2;
    ed.vp.dispatchEvent(new WheelEvent('wheel', { deltaX: Math.cos(a) * 40, deltaY: Math.sin(a) * 40, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true }));
    await raf();
  }
}
async function zoom(ed, frames) {
  const r = ed.vp.getBoundingClientRect();
  const cx = r.left + r.width * 0.62, cy = r.top + r.height * 0.41; // off-centre: zoom must hold the cursor's point
  for (let i = 0; i < frames; i++) {
    const dir = Math.floor(i / 20) % 2 ? 1 : -1;
    ed.vp.dispatchEvent(new WheelEvent('wheel', { deltaY: dir * 8, ctrlKey: true, clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
    await raf();
  }
  await wait(120);
}
async function groupDrag(ed, frames, ids) {
  ed.select(ids);
  await raf();
  const first = ed.byId.get(ids[0]);
  const p = ed.toScreen({ x: first.x + first.w / 2, y: first.y + first.h / 2 });
  const node = ed.vp.querySelector(`.bp-world [data-eid="${CSS.escape(first.id)}"]`) || ed.vp;
  const opt = (x, y, extra = {}) => ({ pointerId: 91, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1, clientX: x, clientY: y, bubbles: true, cancelable: true, composed: true, ...extra });
  node.dispatchEvent(new PointerEvent('pointerdown', opt(p.x, p.y)));
  for (let i = 1; i <= frames; i++) {
    const a = (i / frames) * Math.PI * 2;
    ed.vp.dispatchEvent(new PointerEvent('pointermove', opt(p.x + Math.sin(a) * 160, p.y + (1 - Math.cos(a)) * 80)));
    await raf();
  }
  ed.vp.dispatchEvent(new PointerEvent('pointerup', opt(p.x, p.y, { buttons: 0 })));
  await raf();
}

/**
 * Run the full protocol on an editor that already shows the fixture.
 * Returns { budget, open?, pan, zoom, drag } where each is { runs:[…], median:{p95,dropped,avg} }.
 */
export async function runBench(ed, { frames = 120, runs = 3, onStep } = {}) {
  const budget = await measureBudget();
  const plain = ed.els.filter((e) => /^bench-/.test(e.id));
  const dragIds = plain.slice(0, 50).map((e) => e.id);
  const before = ed.els.map((e) => ({ id: e.id, x: e.x, y: e.y }));
  ed.zoomToFit(false);
  await wait(300);
  const out = { budget: r1(budget), when: new Date().toISOString(), objects: ed.els.length, ua: navigator.userAgent, viewport: `${innerWidth}×${innerHeight}@${devicePixelRatio}x` };
  const gestures = [['pan', (n) => pan(ed, n)], ['zoom', (n) => zoom(ed, n)], ['drag', (n) => groupDrag(ed, n, dragIds)]];
  for (const [name, play] of gestures) {
    onStep?.(`${name} · warm-up`);
    await play(Math.round(frames / 3)); // warm-up
    await wait(250);
    const list = [];
    for (let i = 0; i < runs; i++) {
      onStep?.(`${name} · run ${i + 1}/${runs}`);
      ed.zoomToFit(false);
      await wait(250);
      const rec = recorder();
      await play(frames);
      const { frames: fr, loaf } = rec.stop();
      list.push({ ...summarize(fr, budget), ...(loaf ? { scriptMs: r1(loaf.script), layoutMs: r1(loaf.layout), renderMs: r1(loaf.render), longFrames: loaf.n } : {}) });
      await wait(250);
    }
    out[name] = { runs: list, median: { p95: median(list.map((x) => x.p95)), dropped: median(list.map((x) => x.dropped)), avg: median(list.map((x) => x.avg)) } };
  }
  // Put the dragged objects back exactly where they were (the fixture stays comparable between runs).
  const pos = new Map(before.map((b) => [b.id, b]));
  ed.setEls(ed.els.map((e) => (pos.has(e.id) ? { ...e, x: pos.get(e.id).x, y: pos.get(e.id).y } : e)), { commit: false });
  ed.clearSel?.();
  return out;
}

export function formatBench(r) {
  const row = (k) => `${k.padEnd(5)} p95 ${String(r[k].median.p95).padStart(5)} ms · dropped ${String(r[k].median.dropped).padStart(3)} · avg ${r[k].median.avg} ms`;
  return [`${r.objects} objects · frame budget ${r.budget} ms · ${r.viewport}`, row('pan'), row('zoom'), row('drag')].join('\n');
}

/* ---------------- the in-app runner (Space menu → Performance test) ---------------- */
// Makes a disposable board, opens it full page with ?bench, and board.js hands the editor to
// benchOnReady once it's up. Results are kept in this browser (last 20) so a before/after is one look.
const HIST = 'architect.bench.history';
export function benchHistory() { try { return JSON.parse(localStorage.getItem(HIST) || '[]'); } catch { return []; } }
function keep(r) { try { localStorage.setItem(HIST, JSON.stringify([r, ...benchHistory()].slice(0, 20))); } catch {} }

export async function startBench({ api, uid, go, n = 500 }) {
  const id = uid();
  await api.db.insert('blueprints', { id, name: `Benchmark ${n} (disposable)`, kind: 'board', folder_id: null, pinned: false, data: { v: 1, elements: crowdedFixture(n) }, preview: [] })
    .catch(() => api.db.insert('blueprints', { id, name: `Benchmark ${n} (disposable)`, folder_id: null, pinned: false, data: { v: 1, elements: crowdedFixture(n) }, preview: [] }));
  try { sessionStorage.setItem('architect.bench', id); } catch {}
  go(`board/${id}`);
}

/** Called by board.js when a board opens. Runs only on the board startBench made. */
export async function benchOnReady({ editor, boardId, api, go, dialog, h, label }) {
  let want = null;
  try { want = sessionStorage.getItem('architect.bench'); } catch {}
  if (!want || want !== boardId) return;
  try { sessionStorage.removeItem('architect.bench'); } catch {}
  const status = h('div', { class: 'bench-status' }, 'Benchmark: getting ready…');
  document.body.append(status);
  await wait(1200);
  let r;
  try { r = await runBench(editor, { onStep: (t) => { status.textContent = `Benchmark: ${t}`; } }); }
  finally { status.remove(); }
  r.label = label || 'Architect';
  r.build = document.querySelector('meta[name="architect-build"]')?.content || '';
  keep(r);
  window.__architectBenchResult = r;
  const prev = benchHistory()[1];
  const cmp = (k) => (prev?.[k] ? ` (was ${prev[k].median.p95})` : '');
  await dialog({
    title: 'Crowded-board benchmark',
    width: 520,
    body: h('div', { class: 'stack' },
      h('pre', { class: 'bench-pre' }, `${formatBench(r)}\n\np95 before → now: pan${cmp('pan')} · zoom${cmp('zoom')} · drag${cmp('drag')}`),
      h('p', { class: 'dlg-text' }, 'Same 500-object board, same gestures, warm-up then 3 runs each; the median run is shown. Results stay in this browser so the next run shows the change. The benchmark board is deleted when you close this.')),
    actions: [{ label: 'Copy results', value: 'copy' }, { label: 'Done', primary: true, value: true }],
  }).then(async (v) => { if (v === 'copy') { try { await navigator.clipboard.writeText(JSON.stringify(r, null, 2)); } catch {} } });
  try { await api.db.remove('blueprints', boardId); } catch {}
  go('');
}
