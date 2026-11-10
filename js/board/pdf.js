// PDFs on a board: a page card on the canvas (flip pages in place) and a full reader on double-click.
// Rendering uses pdf.js, loaded on first use. Set window.ARCHITECT_PDFJS to self-host it.
import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';

const LIB = window.ARCHITECT_PDFJS || 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.2.108/legacy/build/pdf.min.mjs';
export const PDF_HEAD = 34; // card header height (px)

let lib = null;
function pdfjs() {
  if (!lib) {
    lib = import(LIB).then((m) => {
      m.GlobalWorkerOptions.workerSrc = LIB.replace(/pdf(\.min)?\.mjs$/, 'pdf.worker$1.mjs');
      return m;
    });
    lib.catch(() => { lib = null; });
  }
  return lib;
}

const docs = new Map(); // url → Promise<PDFDocumentProxy>
export function openDoc(src) {
  if (!docs.has(src)) {
    const p = pdfjs().then((m) => m.getDocument({ url: src, isEvalSupported: false }).promise);
    p.catch(() => docs.delete(src));
    docs.set(src, p);
  }
  return docs.get(src);
}

// Page count + first-page size, for sizing a new card. Accepts a File/Blob or URL.
export async function pdfInfo(source) {
  const url = typeof source === 'string' ? source : URL.createObjectURL(source);
  try {
    const m = await pdfjs();
    const task = m.getDocument({ url, isEvalSupported: false });
    try {
      const doc = await task.promise;
      const vp = (await doc.getPage(1)).getViewport({ scale: 1 });
      return { pages: doc.numPages, w: vp.width, h: vp.height };
    } finally { task.destroy(); }
  } finally {
    if (typeof source !== 'string') URL.revokeObjectURL(url);
  }
}

// Draw one page to an image URL (an <img> survives cloning for print/export, a canvas doesn't).
async function pageImage(doc, n, width) {
  const page = await doc.getPage(n);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: width / base.width });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: ctx, viewport }).promise;
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  canvas.width = canvas.height = 0;
  return { url: URL.createObjectURL(blob), ratio: base.height / base.width };
}

const clampPage = (p, n) => Math.min(Math.max(1, Math.round(p) || 1), Math.max(1, n || 1));

/* ---------- canvas card ---------- */
export function updatePdfNode(node, el, url, ctx) {
  if (!node._pdf) {
    const img = h('img', { class: 'pdf-img', alt: '', draggable: 'false' });
    const label = h('span', { class: 'pdf-count' });
    const name = h('span', { class: 'pdf-name' });
    const flip = (d) => (e) => {
      e.stopPropagation();
      const cur = node._el || el;
      const next = clampPage((cur.page || 1) + d, cur.pages);
      if (next !== (cur.page || 1)) ctx.pdfPage?.(cur.id, next);
    };
    const prev = h('button', { class: 'pdf-flip', type: 'button', 'aria-label': 'Previous page', 'data-noptr': '', onclick: flip(-1) }, icon('chevronLeft', 16));
    const next = h('button', { class: 'pdf-flip', type: 'button', 'aria-label': 'Next page', 'data-noptr': '', onclick: flip(1) }, icon('chevronRight', 16));
    const stage = h('div', { class: 'pdf-stage' }, img, h('div', { class: 'pdf-nav' }, prev, next));
    node.replaceChildren(h('div', { class: 'pdf-head' }, icon('file', 14), name, label), stage);
    node._pdf = { img, label, name, stage, prev, next, key: '', seq: 0 };
  }
  const st = node._pdf;
  const page = clampPage(el.page || 1, el.pages);
  st.name.textContent = el.name || 'Document.pdf';
  st.label.textContent = el.pages ? `${page} / ${el.pages}` : 'PDF';
  st.prev.disabled = page <= 1;
  st.next.disabled = !!el.pages && page >= el.pages;
  node.classList.toggle('is-multi', (el.pages || 1) > 1);

  if (!url) { st.stage.dataset.state = 'missing'; return; }
  // Render width snaps to steps so resizing doesn't re-render on every pixel.
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const width = Math.min(2400, Math.ceil((el.w * dpr * 1.5) / 240) * 240);
  const key = `${url}|${page}|${width}`;
  if (st.key === key) return;
  st.key = key;
  const seq = ++st.seq;
  if (!st.img.getAttribute('src')) st.stage.dataset.state = 'loading';
  clearTimeout(st.timer);
  st.timer = setTimeout(async () => {
    try {
      const doc = await openDoc(url);
      const out = await pageImage(doc, Math.min(page, doc.numPages), width);
      if (seq !== st.seq) { URL.revokeObjectURL(out.url); return; }
      const old = st.img.getAttribute('src');
      st.img.src = out.url;
      if (old?.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(old), 1000);
      st.stage.dataset.state = 'ready';
      if (!el.pages && doc.numPages) ctx.pdfPage?.(el.id, page, doc.numPages);
    } catch {
      if (seq === st.seq) { st.stage.dataset.state = 'error'; st.key = ''; }
    }
  }, st.img.getAttribute('src') ? 120 : 0);
}

/* ---------- full reader ---------- */
export function openPdfViewer({ url, name = 'Document.pdf', page = 1, onClose } = {}) {
  if (!url) return;
  let zoom = 1;
  let current = page;
  let doc = null;
  const items = [];
  const counter = h('span', { class: 'pdfv-count' }, '…');
  const zoomLabel = h('span', { class: 'pdfv-zoom' }, '100%');
  const body = h('div', { class: 'pdfv-body' });
  const tb = (ic, label, fn) => h('button', { class: 'icon-btn', type: 'button', title: label, 'aria-label': label, onclick: fn }, icon(ic, 17));
  const bar = h('div', { class: 'pdfv-bar' },
    h('div', { class: 'pdfv-title' }, icon('file', 15), h('span', {}, name)),
    h('div', { class: 'pdfv-tools' },
      tb('chevronUp', 'Previous page', () => goTo(current - 1)),
      counter,
      tb('chevronDown', 'Next page', () => goTo(current + 1)),
      h('span', { class: 'pdfv-sep' }),
      tb('minus', 'Zoom out', () => setZoom(zoom / 1.2)),
      zoomLabel,
      tb('plus', 'Zoom in', () => setZoom(zoom * 1.2)),
      tb('fit', 'Fit width', () => setZoom(1)),
      h('span', { class: 'pdfv-sep' }),
      tb('external', 'Open in new tab', () => window.open(url, '_blank', 'noopener')),
      h('a', { class: 'icon-btn', href: url, download: name, title: 'Download', 'aria-label': 'Download' }, icon('download', 17)),
      tb('close', 'Close (Esc)', () => close())));
  const box = h('div', { class: 'dlg pdfv', role: 'dialog', 'aria-label': name }, bar, body);
  const overlay = h('div', { class: 'dlg-overlay pdfv-overlay' }, box);
  overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) close(); });

  const baseWidth = () => Math.min(body.clientWidth - 48, 920);
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) if (en.isIntersecting) draw(items[+en.target.dataset.n - 1]);
  }, { root: body, rootMargin: '600px 0px' });

  function layout() {
    const w = Math.round(baseWidth() * zoom);
    for (const it of items) { it.node.style.width = `${w}px`; it.node.style.height = `${Math.round(w * it.ratio)}px`; it.drawn = 0; }
    for (const it of items) { io.unobserve(it.node); io.observe(it.node); }
  }
  async function draw(it) {
    if (!it || !doc) return;
    const w = Math.round(baseWidth() * zoom * Math.min(2, window.devicePixelRatio || 1));
    if (it.drawn >= w || it.busy === w) return;
    it.busy = w;
    try {
      const out = await pageImage(doc, it.n, w);
      if (it.busy !== w) { URL.revokeObjectURL(out.url); return; }
      const old = it.img.getAttribute('src');
      it.img.src = out.url;
      if (old) setTimeout(() => URL.revokeObjectURL(old), 1000);
      it.drawn = w;
      it.node.classList.add('is-ready');
    } catch { /* leave the blank page */ }
    it.busy = 0;
  }
  function setZoom(z) {
    const s = body.scrollTop / Math.max(1, body.scrollHeight);
    zoom = Math.min(4, Math.max(0.4, z));
    zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
    layout();
    body.scrollTop = s * body.scrollHeight;
  }
  function goTo(n) {
    if (!doc) return;
    const it = items[Math.min(Math.max(1, n), items.length) - 1];
    it?.node.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
  body.addEventListener('scroll', () => {
    const mid = body.scrollTop + body.clientHeight / 3;
    const it = items.find((x) => x.node.offsetTop + x.node.offsetHeight > mid);
    if (it && it.n !== current) { current = it.n; counter.textContent = `${current} / ${items.length}`; }
  }, { passive: true });
  body.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    setZoom(zoom * Math.exp(-e.deltaY * 0.004));
  }, { passive: false });

  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'PageDown' || (e.key === 'ArrowRight' && !e.metaKey)) { e.preventDefault(); goTo(current + 1); }
    else if (e.key === 'PageUp' || e.key === 'ArrowLeft') { e.preventDefault(); goTo(current - 1); }
    else if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) { e.preventDefault(); setZoom(zoom * 1.2); }
    else if ((e.ctrlKey || e.metaKey) && e.key === '-') { e.preventDefault(); setZoom(zoom / 1.2); }
  };
  window.addEventListener('keydown', onKey, true);
  const onResize = () => layout();
  window.addEventListener('resize', onResize);

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onResize);
    io.disconnect();
    overlay.classList.remove('in');
    setTimeout(() => {
      overlay.remove();
      for (const it of items) { const s = it.img.getAttribute('src'); if (s) URL.revokeObjectURL(s); }
    }, 180);
    onClose?.(current);
  }

  document.body.append(overlay);
  requestAnimationFrame(() => overlay.classList.add('in'));
  body.append(h('div', { class: 'pdfv-msg' }, 'Opening…'));

  openDoc(url).then(async (d) => {
    if (closed) return;
    doc = d;
    const first = (await d.getPage(1)).getViewport({ scale: 1 });
    const ratio = first.height / first.width;
    body.replaceChildren();
    for (let n = 1; n <= d.numPages; n++) {
      const img = h('img', { alt: `Page ${n}`, draggable: 'false' });
      const node = h('div', { class: 'pdfv-page', 'data-n': n }, img);
      items.push({ n, node, img, ratio, drawn: 0, busy: 0 });
      body.append(node);
    }
    // Pages other than the first may differ in size; correct them as they load.
    layout();
    current = Math.min(Math.max(1, page), d.numPages);
    counter.textContent = `${current} / ${d.numPages}`;
    if (current > 1) items[current - 1].node.scrollIntoView({ block: 'start' });
    for (const it of items.slice(1)) {
      if (closed) break;
      d.getPage(it.n).then((p) => {
        const v = p.getViewport({ scale: 1 });
        const r = v.height / v.width;
        if (Math.abs(r - it.ratio) > 0.001) { it.ratio = r; it.node.style.height = `${Math.round(parseFloat(it.node.style.width) * r)}px`; }
      }).catch(() => {});
    }
  }).catch(() => {
    if (!closed) body.replaceChildren(h('div', { class: 'pdfv-msg' }, 'This PDF couldn’t be opened. ', h('a', { href: url, target: '_blank', rel: 'noopener' }, 'Open it in a new tab')));
  });
  return { close };
}
