// PDF export through the browser's own print engine ("Save as PDF"):
// vector text, real fonts, no dependencies. The content is laid out on a single
// page sized to fit it, so a whole board or kanban lands on one sheet.
import { h } from './dom.js';
import { toast } from './ui.js';

const MAX_SIDE = 14000; // px — browsers/PDF viewers cap page size around 200in

let busy = false;

/**
 * content: element to print (already laid out at width × height CSS px)
 * width/height: natural size of the content in px
 * title: becomes the suggested PDF file name
 */
export async function printToPdf({ content, width, height, title = 'Architect', background = null }) {
  if (busy) return;
  busy = true;
  const k = Math.min(1, MAX_SIDE / Math.max(width, height));
  const pw = Math.ceil(width * k);
  const ph = Math.ceil(height * k);

  const page = h('style', { 'data-print-page': '' },
    `@page { size: ${pw}px ${ph}px; margin: 0; }
     @media print { html, body { width: ${pw}px; height: ${ph}px; } }`);
  const sheet = h('div', { class: 'print-sheet', style: { width: `${pw}px`, height: `${ph}px`, background: background || null } });
  const inner = h('div', { class: 'print-inner', style: { width: `${width}px`, height: `${height}px`, transform: `scale(${k})` } }, content);
  sheet.append(inner);
  const root = h('div', { class: 'print-root', 'aria-hidden': 'true' }, sheet);

  document.head.append(page);
  document.body.append(root);
  document.body.classList.add('is-printing');
  const prevTitle = document.title;
  document.title = title.replace(/[\\/:*?"<>|]+/g, '').trim() || 'Architect';

  const cleanup = () => {
    document.body.classList.remove('is-printing');
    root.remove();
    page.remove();
    document.title = prevTitle;
    busy = false;
  };

  try {
    await Promise.race([waitForMedia(root), new Promise((r) => setTimeout(r, 6000))]);
    await document.fonts?.ready;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    let done = false;
    const finish = () => { if (done) return; done = true; window.removeEventListener('afterprint', finish); setTimeout(cleanup, 50); };
    window.addEventListener('afterprint', finish);
    window.print();
    // Some mobile browsers don't fire afterprint; print() is blocking on desktop.
    setTimeout(finish, 1500);
  } catch (e) {
    cleanup();
    toast('Couldn’t open the PDF export.', { tone: 'error' });
  }
}

function waitForMedia(root) {
  const imgs = [...root.querySelectorAll('img')].filter((i) => !i.complete);
  return Promise.all(imgs.map((img) => new Promise((r) => { img.addEventListener('load', r, { once: true }); img.addEventListener('error', r, { once: true }); })));
}

export const pdfHint = () => toast('Choose “Save as PDF” as the printer', { ms: 3200 });
