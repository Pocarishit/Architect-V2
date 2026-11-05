// Floating toolbar above the current selection (Miro-style).
import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { menu, popover, closeFloating } from '../core/ui.js';
import { clamp, kbd } from '../core/util.js';
import { SWATCHES, FILLS, STICKY_FILLS, swatchStyle } from './palette.js';
import { SHAPES, rectOf, unionRects } from './geometry.js';
import { FONTS } from './render.js';

const TXT = ['sticky', 'shape', 'text'];
const HIGHLIGHTS = [
  { id: 'rgba(240, 180, 41, .55)', name: 'Amber' },
  { id: 'rgba(63, 166, 107, .5)', name: 'Green' },
  { id: 'rgba(59, 130, 216, .5)', name: 'Blue' },
  { id: 'rgba(215, 25, 33, .45)', name: 'Red' },
  { id: 'rgba(140, 140, 140, .5)', name: 'Grey' },
  { id: 'transparent', name: 'No highlight' },
];

const SIZES = [12, 14, 16, 18, 22, 28, 36, 48, 64, 96, 144];
const SHAPE_NAMES = { rect: 'Rectangle', round: 'Rounded', ellipse: 'Ellipse', triangle: 'Triangle', diamond: 'Diamond', hexagon: 'Hexagon', parallelogram: 'Parallelogram', star: 'Star', arrowblock: 'Arrow', pill: 'Pill' };

function btn(ic, label, onClick, { on = false, cls, text } = {}) {
  return h('button', {
    class: ['ctx-btn', on && 'is-on', cls], type: 'button', 'aria-label': label, 'data-tip': kbd(label), 'aria-pressed': on ? 'true' : null,
    onmousedown: (e) => e.preventDefault(),
    onclick: (e) => onClick(e.currentTarget),
  }, typeof ic === 'string' ? icon(ic, 18) : ic, text ? h('span', { class: 'ctx-btn-text' }, text) : null);
}

function swatchDot(color, ring = false) {
  return h('span', { class: ['ctx-swatch', ring && 'is-ring', color === 'none' && 'is-none'], style: ring ? { borderColor: color === 'none' ? '' : swatchStyle(color).background } : swatchStyle(color) });
}

function colorGrid(list, current, onPick) {
  const grid = h('div', { class: 'pal-grid', role: 'listbox' });
  const paint = (cur) => {
    grid.replaceChildren(...list.map((c) => h('button', {
      class: ['pal-sw', c.id === cur && 'is-on', c.id === 'none' && 'is-none', c.id === 'auto' && 'is-auto'],
      type: 'button', role: 'option', 'aria-selected': String(c.id === cur), 'aria-label': c.name, title: c.name,
      style: c.id === 'none' ? null : swatchStyle(c.id),
      onclick: () => { onPick(c.id); paint(c.id); },
    })));
  };
  paint(current);
  return grid;
}

function row(label, ...kids) {
  return h('div', { class: 'pop-row' }, h('div', { class: 'pop-label' }, label), h('div', { class: 'pop-items' }, kids));
}

function optionRow(options, current, onPick) {
  const wrap = h('div', { class: 'seg seg-sm' });
  const paint = (cur) => wrap.replaceChildren(...options.map((o) => h('button', {
    type: 'button', class: o.value === cur ? 'is-on' : null, 'aria-label': o.label, title: o.label,
    onclick: () => { onPick(o.value); paint(o.value); },
  }, o.icon ? icon(o.icon, 16) : o.label)));
  paint(current);
  return wrap;
}

export function createContextBar(page, editor, { sendToPaths, present, openLink, askLink }) {
  const bar = h('div', { class: 'bp-ctx', role: 'toolbar', 'aria-label': 'Selection tools', hidden: true });
  page.append(bar);

  const ids = () => editor.selected().map((e) => e.id);
  const set = (patch, only) => {
    const sel = editor.selected().filter((e) => !only || only.includes(e.type));
    editor.applyStyle(sel.map((e) => e.id), patch);
  };
  const common = (list, key, fallback) => {
    const vals = new Set(list.map((e) => e[key] ?? fallback));
    return vals.size === 1 ? [...vals][0] : null;
  };

  function rebuild() {
    const sel = editor.selected();
    if (!sel.length || editor.presenting || editor.g) { bar.hidden = true; return; }
    const one = sel.length === 1 ? sel[0] : null;
    const of = (...ts) => sel.filter((e) => ts.includes(e.type));
    const items = [];

    if (sel.every((e) => e.locked)) {
      items.push(btn('unlock', 'Unlock', () => editor.toggleLock(), { text: 'Unlock' }));
      bar.replaceChildren(...items);
      bar.hidden = false;
      position();
      return;
    }

    const texty = of('sticky', 'shape', 'text');
    const editing = editor.isEditingText();
    if (texty.length) {
      items.push(btn('turnInto', 'Turn into', (a) => menu(a, [
        { label: 'Text', icon: 'text', onSelect: () => editor.convert('text') },
        { label: 'Sticky note', icon: 'sticky', onSelect: () => editor.convert('sticky') },
        { label: 'Rectangle', icon: 'rect', onSelect: () => editor.convert('shape', 'rect') },
        { label: 'Rounded', icon: 'round', onSelect: () => editor.convert('shape', 'round') },
        { label: 'Ellipse', icon: 'ellipse', onSelect: () => editor.convert('shape', 'ellipse') },
        { label: 'Diamond', icon: 'diamond', onSelect: () => editor.convert('shape', 'diamond') },
      ])));
    }

    if (one?.type === 'shape') {
      items.push(btn(one.kind || 'rect', 'Shape', (a) => popover(a, shapePicker(one.kind || 'rect'), { side: 'bottom' })));
    }

    const fillables = of('sticky', 'shape', 'frame', 'text');
    if (fillables.length) {
      const onlySticky = fillables.every((e) => e.type === 'sticky');
      const cur = common(fillables, 'fill', 'none');
      items.push(btn(swatchDot(cur || 'none'), 'Fill colour', (a) => popover(a, h('div', { class: 'pop' },
        h('div', { class: 'pop-label' }, onlySticky ? 'Note colour' : 'Fill'),
        colorGrid(onlySticky ? STICKY_FILLS : FILLS, cur, (c) => set({ fill: c }, ['sticky', 'shape', 'frame', 'text'])))), {}));
    }

    const strokables = of('shape', 'line', 'pen');
    if (strokables.length) {
      const cur = common(strokables, 'stroke', 'auto');
      const curW = common(strokables, 'strokeWidth', 2);
      const curDash = common(of('shape', 'line'), 'dash', 'solid');
      const hasDash = of('shape', 'line').length > 0;
      items.push(btn(swatchDot(cur || 'auto', true), 'Line colour and width', (a) => popover(a, h('div', { class: 'pop' },
        h('div', { class: 'pop-label' }, 'Colour'),
        colorGrid(of('shape').length ? [{ id: 'none', name: 'No border' }, ...SWATCHES] : SWATCHES, cur, (c) => set({ stroke: c }, ['shape', 'line', 'pen'])),
        row('Width', optionRow([1, 2, 3, 5, 8, 12].map((w) => ({ value: w, label: String(w) })), curW, (w) => set({ strokeWidth: w }, ['shape', 'line', 'pen']))),
        hasDash ? row('Style', optionRow([
          { value: 'solid', label: 'Solid', icon: 'solid' }, { value: 'dashed', label: 'Dashed', icon: 'dash' }, { value: 'dotted', label: 'Dotted', icon: 'dotted' },
        ], curDash, (d) => set({ dash: d }, ['shape', 'line']))) : null)), {}));
    }

    if (texty.length) {
      items.push(h('span', { class: 'ctx-sep' }));
      items.push(fontPicker(texty));
      items.push(sizeStepper(texty));
      const styleOn = editing ? ['bold', 'italic', 'underline', 'strikeThrough'].some((c) => editor.queryText(c)) : texty.every((e) => e.bold);
      items.push(btn('bold', 'Bold, italic, underline', (a) => popover(a, stylePanel(texty)), { on: styleOn }));
      const al = common(texty, 'align', null) || (texty[0].type === 'text' ? 'left' : 'center');
      const nextAlign = { left: 'center', center: 'right', right: 'left' }[al] || 'left';
      items.push(btn({ left: 'taLeft', center: 'taCenter', right: 'taRight' }[al] || 'taCenter', 'Text alignment', () => set({ align: nextAlign }, TXT)));
      items.push(btn('list', 'Bullet list', () => editor.execText('insertUnorderedList'), { on: editor.queryText('insertUnorderedList') }));
      if (askLink) items.push(btn('link', 'Link (⌘K)', () => askLink()));
      items.push(btn(textColorIcon(texty, editing), 'Text colour', (a) => popover(a, colorPanel(texty))));
      items.push(btn('highlighter', 'Highlight', (a) => popover(a, highlightPanel())));
    }

    const lines = of('line');
    if (lines.length) {
      const route = common(lines, 'route', 'straight') || 'straight';
      items.push(btn({ straight: 'line', curve: 'curve', elbow: 'elbow' }[route], 'Connector style', (a) => popover(a, linePanel(lines))));
      const sc = common(lines, 'startCap', 'none');
      const ec = common(lines, 'endCap', 'none');
      items.push(btn(capIcon(sc, true), 'Start of line', (a) => popover(a, capPicker('startCap', sc))));
      items.push(btn(capIcon(ec, false), 'End of line', (a) => popover(a, capPicker('endCap', ec))));
    }

    if (one && (one.type === 'video' || one.type === 'embed')) {
      const live = editor.activeId === one.id;
      items.push(btn(live ? 'stop' : 'play', live ? 'Stop interacting' : 'Play / interact', () => (live ? editor.deactivate() : editor.activate(one.id)), { text: live ? 'Stop' : 'Play' }));
    }
    if (one && (one.type === 'link' || one.type === 'embed') && one.url) items.push(btn('external', 'Open link in new tab', () => openLink(one.url)));
    if (one?.type === 'sticky' && sendToPaths) items.push(btn('toPaths', 'Send to Paths', (a) => sendToPaths(a, one)));
    if (one?.type === 'frame' && present) items.push(btn('present', 'Present from this frame', () => present(one.id)));

    if (sel.length > 1) {
      items.push(btn('alignLeft', 'Align and distribute', (a) => popover(a, alignPanel(sel.length))));
      const grouped = sel.some((e) => e.group);
      items.push(btn(grouped ? 'ungroup' : 'group', grouped ? 'Ungroup (⇧⌘G)' : 'Group (⌘G)', () => (grouped ? editor.ungroup() : editor.group())));
    }

    if (items.length) items.push(h('span', { class: 'ctx-sep' }));
    items.push(btn('lock', 'Lock (⇧⌘L)', () => editor.toggleLock()));
    items.push(btn('more', 'More', (a) => moreMenu(a)));

    bar.replaceChildren(...items);
    bar.hidden = false;
    position();
  }

  function capIcon(kind, start) {
    const ic = icon({ none: 'capNone', arrow: 'capArrow', triangle: 'capTriangle', dot: 'capDot' }[kind] || 'capNone', 18);
    if (start) ic.style.transform = 'scaleX(-1)';
    return ic;
  }

  function capPicker(key, cur) {
    return h('div', { class: 'pop' },
      h('div', { class: 'pop-label' }, key === 'startCap' ? 'Start' : 'End'),
      optionRow([
        { value: 'none', label: 'None', icon: 'capNone' }, { value: 'arrow', label: 'Arrow', icon: 'capArrow' },
        { value: 'triangle', label: 'Triangle', icon: 'capTriangle' }, { value: 'dot', label: 'Dot', icon: 'capDot' },
      ], cur, (v) => set({ [key]: v }, ['line'])));
  }

  function linePanel(lines) {
    return h('div', { class: 'pop' },
      h('div', { class: 'pop-label' }, 'Connector'),
      optionRow([
        { value: 'straight', label: 'Straight', icon: 'line' }, { value: 'curve', label: 'Curved', icon: 'curve' }, { value: 'elbow', label: 'Elbow', icon: 'elbow' },
      ], common(lines, 'route', 'straight'), (v) => set({ route: v }, ['line'])));
  }

  function shapePicker(cur) {
    const grid = h('div', { class: 'shape-grid' });
    const paint = (c) => grid.replaceChildren(...SHAPES.map((k) => h('button', {
      type: 'button', class: ['tool-opt', k === c && 'is-on'], 'aria-label': SHAPE_NAMES[k], title: SHAPE_NAMES[k],
      onclick: () => { set({ kind: k }, ['shape']); paint(k); },
    }, icon(k, 20))));
    paint(cur);
    return h('div', { class: 'pop' }, h('div', { class: 'pop-label' }, 'Shape'), grid);
  }

  function fontPicker(texty) {
    const font = common(texty, 'font', 'sans');
    const name = FONTS.find((f) => f.id === font)?.name || 'Mixed';
    return btn(h('span', { class: `ctx-font ff-${font || 'sans'}` }, name), 'Font', (a) => menu(a, FONTS.map((f) => ({
      label: f.name, labelClass: `ff-${f.id}`, checked: f.id === font, onSelect: () => set({ font: f.id }, TXT),
    }))), { cls: 'ctx-wide' });
  }

  function sizeStepper(texty) {
    const fs = common(texty, 'fontSize', null);
    const autoOk = texty.every((e) => e.type === 'sticky');
    const base = fs ?? (autoOk ? 18 : texty[0].fontSize || 22);
    const input = h('input', { class: 'ctx-size', value: fs != null ? String(fs) : (autoOk ? 'Auto' : ''), 'aria-label': 'Font size', inputmode: 'numeric', maxlength: 3 });
    const apply = () => {
      const v = Math.round(parseFloat(input.value));
      if (v >= 4 && v <= 400 && v !== fs) set({ fontSize: v }, TXT);
      else input.value = fs != null ? String(fs) : (autoOk ? 'Auto' : '');
    };
    input.addEventListener('focus', () => input.select());
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); apply(); input.blur(); }
      else if (e.key === 'Escape') { input.value = fs ?? 'Auto'; input.blur(); }
      else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); step(e.key === 'ArrowUp' ? 1 : -1); }
    });
    input.addEventListener('change', apply);
    const step = (dir) => {
      const next = dir > 0 ? (SIZES.find((sz) => sz > base) ?? base + 24) : ([...SIZES].reverse().find((sz) => sz < base) ?? Math.max(4, base - 2));
      set({ fontSize: next }, TXT);
    };
    const arrow = (dir) => h('button', { type: 'button', class: 'ctx-step', 'aria-label': dir > 0 ? 'Bigger text' : 'Smaller text', onmousedown: (e) => e.preventDefault(), onclick: () => step(dir) }, icon(dir > 0 ? 'chevronUp' : 'chevronDown', 12, { weight: 2 }));
    return h('div', { class: 'ctx-sizebox', 'data-tip': 'Font size' }, input, h('div', { class: 'ctx-steps' }, arrow(1), arrow(-1)));
  }

  function stylePanel(texty) {
    const wrap = h('div', { class: 'opt-row' });
    const opts = [['bold', 'bold', 'Bold (⌘B)'], ['italic', 'italic', 'Italic (⌘I)'], ['underline', 'underline', 'Underline (⌘U)'], ['strike', 'strike', 'Strikethrough']];
    const cmds = { bold: 'bold', italic: 'italic', underline: 'underline', strike: 'strikeThrough' };
    const paint = () => {
      const now = editor.selected().filter((e) => TXT.includes(e.type));
      wrap.replaceChildren(...opts.map(([prop, ic, label]) => {
        const on = editor.isEditingText() ? editor.queryText(cmds[prop]) : now.every((e) => e[prop]);
        return h('button', { type: 'button', class: ['tool-opt', on && 'is-on'], 'aria-label': kbd(label), title: kbd(label), 'aria-pressed': String(on), onclick: () => { editor.toggleTextProp(prop); paint(); } }, icon(ic, 18));
      }));
    };
    paint();
    return h('div', { class: 'pop' }, h('div', { class: 'pop-label' }, editor.isEditingText() ? 'Style — selected words' : 'Style'), wrap);
  }

  function textColorIcon(texty, editing) {
    const c = editing ? null : common(texty, 'color', null);
    return h('span', { class: 'ctx-tc' }, icon('textColor', 18), h('i', { style: { background: c ? swatchStyle(c).background : 'currentColor' } }));
  }

  function colorPanel(texty) {
    if (editor.isEditingText()) {
      return h('div', { class: 'pop' },
        h('div', { class: 'pop-label' }, 'Colour — selected words'),
        colorGrid(SWATCHES.filter((c) => c.id !== 'auto'), null, (c) => editor.execText('foreColor', c)),
        h('button', { type: 'button', class: 'tool-opt wide', onclick: () => editor.execText('removeFormat') }, icon('clearFormat', 16), h('span', {}, 'Clear formatting')));
    }
    const hasBoxText = texty.some((e) => e.type !== 'text');
    const colors = hasBoxText ? [{ id: 'contrast', name: 'Automatic contrast' }, ...SWATCHES.filter((s2) => s2.id !== 'auto')] : SWATCHES;
    const cur = common(texty, 'color', hasBoxText ? 'contrast' : 'auto');
    return h('div', { class: 'pop' },
      h('div', { class: 'pop-label' }, 'Text colour'),
      colorGrid(colors, cur || (hasBoxText ? 'contrast' : 'auto'), (c) => set({ color: c === 'contrast' ? undefined : c }, TXT)));
  }

  function highlightPanel() {
    const grid = h('div', { class: 'pal-grid' }, HIGHLIGHTS.map((c) => h('button', {
      type: 'button', class: ['pal-sw', c.id === 'transparent' && 'is-none'], 'aria-label': c.name, title: c.name,
      style: c.id === 'transparent' ? null : { background: c.id },
      onclick: () => editor.execText('hiliteColor', c.id),
    })));
    return h('div', { class: 'pop' }, h('div', { class: 'pop-label' }, editor.isEditingText() ? 'Highlight — selected words' : 'Highlight'), grid);
  }

  function textPanel(texty) {
    const allSticky = texty.every((e) => e.type === 'sticky');
    const font = common(texty, 'font', 'sans') || 'sans';
    const size = common(texty, 'fontSize', null);
    const sizes = h('div', { class: 'size-grid' });
    const paintSizes = (cur) => sizes.replaceChildren(
      allSticky ? h('button', { type: 'button', class: ['size-opt', cur == null && 'is-on'], onclick: () => { set({ fontSize: undefined }, ['sticky']); paintSizes(null); } }, 'Auto') : null,
      ...SIZES.map((sz) => h('button', { type: 'button', class: ['size-opt', cur === sz && 'is-on'], onclick: () => { set({ fontSize: sz }, ['sticky', 'shape', 'text']); paintSizes(sz); } }, String(sz))));
    paintSizes(size);
    const hasBoxText = texty.some((e) => e.type !== 'text');
    const colors = hasBoxText ? [{ id: 'contrast', name: 'Automatic contrast' }, ...SWATCHES.filter((s2) => s2.id !== 'auto')] : SWATCHES;
    const curColor = common(texty, 'color', hasBoxText ? 'contrast' : 'auto');
    const italic = h('button', { type: 'button', class: 'size-opt', 'aria-label': 'Italic' }, icon('italic', 16));
    const paintItalic = () => {
      const on = editor.selected().filter((e) => texty.some((t) => t.id === e.id)).every((e) => e.italic);
      italic.classList.toggle('is-on', on);
      italic.setAttribute('aria-pressed', String(on));
      return on;
    };
    italic.addEventListener('click', () => { set({ italic: !paintItalic() }, ['sticky', 'shape', 'text']); paintItalic(); });
    paintItalic();
    return h('div', { class: 'pop pop-text' },
      row('Font', optionRow([{ value: 'sans', label: 'Sans' }, { value: 'mono', label: 'Mono' }, { value: 'dot', label: 'Dot' }], font, (v) => set({ font: v }, ['sticky', 'shape', 'text'])), italic),
      h('div', { class: 'pop-label' }, 'Size'),
      sizes,
      h('div', { class: 'pop-label' }, 'Text colour'),
      colorGrid(colors, curColor || (hasBoxText ? 'contrast' : 'auto'), (c) => set({ color: c === 'contrast' ? undefined : c }, ['sticky', 'shape', 'text'])));
  }

  function alignPanel(n) {
    const b = (ic, label, fn, disabled) => h('button', { type: 'button', class: 'tool-opt', 'aria-label': label, title: label, disabled, onclick: fn }, icon(ic, 18));
    return h('div', { class: 'pop' },
      h('div', { class: 'pop-label' }, 'Align'),
      h('div', { class: 'opt-row' },
        b('alignLeft', 'Align left', () => editor.align('left')),
        b('alignCenter', 'Align centre', () => editor.align('center')),
        b('alignRight', 'Align right', () => editor.align('right')),
        b('alignTop', 'Align top', () => editor.align('top')),
        b('alignMiddle', 'Align middle', () => editor.align('middle')),
        b('alignBottom', 'Align bottom', () => editor.align('bottom'))),
      h('div', { class: 'pop-label' }, 'Distribute'),
      h('div', { class: 'opt-row' },
        b('distH', 'Distribute horizontally', () => editor.distribute('h'), n < 3),
        b('distV', 'Distribute vertically', () => editor.distribute('v'), n < 3)));
  }

  function moreMenu(anchor) {
    const sel = editor.selected();
    menu(anchor, [
      { label: 'Bring to front', icon: 'front', kbd: ']', onSelect: () => editor.bringToFront() },
      { label: 'Send to back', icon: 'backward', kbd: '[', onSelect: () => editor.sendToBack() },
      { label: 'Duplicate', icon: 'copy', kbd: '⌘D', onSelect: () => editor.duplicate() },
      { label: 'Copy', icon: 'copy', kbd: '⌘C', onSelect: () => editor.copy() },
      sel.length > 1 ? { label: 'Group', icon: 'group', kbd: '⌘G', onSelect: () => editor.group() } : null,
      sel.some((e) => e.group) ? { label: 'Ungroup', icon: 'ungroup', kbd: '⇧⌘G', onSelect: () => editor.ungroup() } : null,
      { label: 'Zoom to selection', icon: 'fit', kbd: '⇧2', onSelect: () => editor.zoomToSelection() },
      '-',
      { label: 'Delete', icon: 'trash', kbd: 'Del', danger: true, onSelect: () => editor.deleteSelection() },
    ], { align: 'end' });
  }

  function position() {
    if (bar.hidden) return;
    const sel = editor.selected();
    if (!sel.length) return;
    const r = unionRects(sel.map((e) => rectOf(e, editor.byId)));
    const tl = editor.toScreen({ x: r.x, y: r.y });
    const br = editor.toScreen({ x: r.x + r.w, y: r.y + r.h });
    const pr = page.getBoundingClientRect();
    const bw = bar.offsetWidth, bh = bar.offsetHeight;
    let x = (tl.x + br.x) / 2 - bw / 2 - pr.left;
    let y = tl.y - pr.top - bh - 34; // clears the connection dots
    const topLimit = 68;
    if (y < topLimit) {
      y = br.y - pr.top + 34;
      if (y + bh > pr.height - 72) y = topLimit;
    }
    x = clamp(x, 8, Math.max(8, pr.width - bw - 8));
    bar.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  editor.on('selection', rebuild);
  let selRaf = 0;
  let lastSig = '';
  editor.on('textselection', () => {
    cancelAnimationFrame(selRaf);
    selRaf = requestAnimationFrame(() => {
      // Only repaint when bold/italic/underline/strike/list state actually changed under the caret.
      const sig = ['bold', 'italic', 'underline', 'strikeThrough', 'insertUnorderedList'].map((c) => (editor.queryText(c) ? 1 : 0)).join('');
      if (sig === lastSig || bar.contains(document.activeElement)) return;
      lastSig = sig;
      rebuild();
    });
  });
  editor.on('change', () => { if (!editor.g) rebuild(); });
  editor.on('camera', position);
  editor.on('gesture', (on) => {
    if (on) { bar.hidden = true; closeFloating(); }
    else rebuild();
  });

  return { rebuild, el: bar };
}
