// Variables — your map of everything outside you that shapes your life.
// Sections (School, Family, Business, Friends… all renamable) hold entries: a person, a group,
// a commitment. Each entry opens into its own running chat of notes, so you can reflect and
// track how it changes over time. Lives on the widget object, synced like the rest of the Space.
import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { menu, toast, dialog, confirmDialog, promptDialog } from '../core/ui.js';
import { uid, store } from '../core/util.js';
import { api, friendlyError } from '../data/api.js';
import { urlOf, uploadMedia, lightbox, mediaFiles, pickMedia } from './media.js';

export const DEFAULT_SECTIONS = ['School', 'Family', 'Business', 'Friends'];
export const defaultVariables = () => ({ sections: DEFAULT_SECTIONS.map((name) => ({ id: uid(), name })), entries: [] });
const MAX_NOTES = 600;
const pad = (n) => String(n).padStart(2, '0');
const hhmm = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const dayLabel = (ts) => {
  const d = new Date(ts), t = new Date();
  const k = (x) => x.toDateString();
  if (k(d) === k(t)) return 'Today';
  if (k(d) === k(new Date(t.getFullYear(), t.getMonth(), t.getDate() - 1))) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: d.getFullYear() === t.getFullYear() ? undefined : 'numeric' });
};

export function mountVariables(root, el0, w) {
  let el = el0;
  const me = api.auth.current()?.user;
  const memKey = `architect.var.${el.id}`;
  const mem = store.get(memKey, {});
  let section = mem.section || null;
  let open = mem.open || null;      // entry id whose chat is open
  let busy = false;
  let pending = false;
  let draft = '';
  let sending = false;
  const remember = () => store.set(memKey, { section, open });

  const box = h('div', { class: 'vr' });
  root.append(box);

  const sections = () => (el.sections?.length ? el.sections : defaultVariables().sections);
  const entries = () => el.entries || [];
  const save = (p) => w.patch({ sections: sections(), ...p });
  const setEntries = (list) => save({ entries: list });
  const patchEntry = (id, fn) => setEntries(entries().map((x) => (x.id === id ? { ...x, ...fn(x) } : x)));

  function render() {
    if (busy) {
      // Typing a note: refresh the messages in place, keep the composer (and your cursor) alone.
      const x = open && entries().find((e) => e.id === open);
      const list = box.querySelector('.vr-msgs');
      if (x && list) {
        const atEnd = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
        list.replaceChildren(...msgRows(x));
        if (atEnd) list.scrollTop = list.scrollHeight;
      } else pending = true;
      return;
    }
    pending = false;
    const secs = sections();
    if (!secs.some((s) => s.id === section)) section = secs[0]?.id || null;
    const entry = open && entries().find((x) => x.id === open);
    if (open && !entry) open = null;
    box.replaceChildren(entry ? chat(entry) : grid(secs));
    if (entry) requestAnimationFrame(() => { const l = box.querySelector('.vr-msgs'); if (l) l.scrollTop = l.scrollHeight; });
  }

  /* ---------------- sections + grid ---------------- */
  function grid(secs) {
    const tabs = h('div', { class: 'vr-tabs', role: 'tablist' },
      secs.map((s) => {
        const b = h('button', {
          type: 'button', role: 'tab', class: ['vr-tab', s.id === section && 'is-on'], 'aria-selected': String(s.id === section),
          onclick: () => { section = s.id; remember(); render(); },
          ondblclick: () => renameSection(s),
          oncontextmenu: (e) => { e.preventDefault(); e.stopPropagation(); sectionMenu({ x: e.clientX, y: e.clientY }, s); },
        }, s.name.toUpperCase());
        return b;
      }),
      h('button', { type: 'button', class: 'vr-tab-add', title: 'New section', 'aria-label': 'New section', onclick: addSection }, icon('plus', 14)));
    const list = entries().filter((x) => x.section === section);
    const cards = list.map((x) => card(x));
    cards.push(h('button', { type: 'button', class: 'vr-card vr-new', onclick: () => addEntry() }, icon('plus', 18), h('span', {}, 'Add')));
    return h('div', { class: 'vr-home' }, tabs, h('div', { class: 'vr-grid' }, cards),
      !list.length ? h('p', { class: 'vr-hint' }, 'A teacher, a committee, your family, the office — every influence gets its own space.') : null);
  }

  function card(x) {
    const url = x.photo ? urlOf(x.photo, render) : null;
    const notes = x.notes?.length || 0;
    const more = h('button', { type: 'button', class: 'vr-card-more', 'aria-label': `Options for ${x.name}`, onclick: (e) => { e.stopPropagation(); entryMenu(e.currentTarget, x); } }, icon('more', 14));
    return h('div', {
      class: ['vr-card', x.photo ? 'has-face' : 'is-label'], role: 'button', tabindex: 0, 'aria-label': `Open ${x.name}`,
      onclick: (e) => { if (!e.target.closest('button')) openEntry(x.id); },
      onkeydown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) openEntry(x.id); },
      oncontextmenu: (e) => { e.preventDefault(); e.stopPropagation(); entryMenu({ x: e.clientX, y: e.clientY }, x); },
    },
      x.photo ? h('span', { class: 'vr-face' }, url ? h('img', { src: url, alt: '', draggable: false }) : null) : null,
      h('span', { class: 'vr-name' }, x.photo ? x.name : x.name.toUpperCase()),
      notes ? h('span', { class: 'vr-count', title: `${notes} note${notes === 1 ? '' : 's'}` }, String(notes)) : null,
      more);
  }

  function openEntry(id) { open = id; draft = ''; remember(); render(); }

  async function addSection() {
    const name = await promptDialog('New section', { placeholder: 'e.g. Gym, Church, Clients', ok: 'Add', maxLength: 32 });
    if (!name?.trim()) return;
    const s = { id: uid(), name: name.trim() };
    section = s.id; remember();
    save({ sections: [...sections(), s] });
  }

  async function renameSection(s) {
    const name = await promptDialog('Rename section', { value: s.name, maxLength: 32 });
    if (!name?.trim() || name.trim() === s.name) return;
    save({ sections: sections().map((x) => (x.id === s.id ? { ...x, name: name.trim() } : x)) });
  }

  function sectionMenu(anchor, s) {
    const secs = sections();
    const i = secs.findIndex((x) => x.id === s.id);
    const swap = (j) => { const next = [...secs]; [next[i], next[j]] = [next[j], next[i]]; save({ sections: next }); };
    menu(anchor, [
      { label: 'Rename', icon: 'edit', onSelect: () => renameSection(s) },
      { label: 'Move left', icon: 'chevronLeft', disabled: i === 0, onSelect: () => swap(i - 1) },
      { label: 'Move right', icon: 'chevronRight', disabled: i === secs.length - 1, onSelect: () => swap(i + 1) },
      '-',
      { label: 'Delete section', icon: 'trash', danger: true, disabled: secs.length < 2, onSelect: () => deleteSection(s) },
    ]);
  }

  async function deleteSection(s) {
    const inside = entries().filter((x) => x.section === s.id);
    if (inside.length && !(await confirmDialog(`Delete ${s.name}?`, `${inside.length} entr${inside.length === 1 ? 'y' : 'ies'} and their notes go with it.`))) return;
    save({ sections: sections().filter((x) => x.id !== s.id), entries: entries().filter((x) => x.section !== s.id) });
  }

  async function addEntry() {
    const name = h('input', { class: 'input', placeholder: 'A person, a group, a commitment', maxlength: 48, 'aria-label': 'Name' });
    let file = null;
    const face = h('span', { class: 'vr-pick-face' }, icon('user', 22));
    const pick = h('button', {
      type: 'button', class: 'vr-pick', onclick: async () => {
        const [f] = await pickMedia({ multiple: false, accept: 'image/*' });
        if (!f) return;
        file = f;
        face.replaceChildren(h('img', { src: URL.createObjectURL(f), alt: '' }));
        pickLabel.textContent = 'Change photo';
      },
    }, face);
    const pickLabel = h('span', { class: 'vr-pick-label' }, 'Add a photo (optional)');
    const secSel = h('select', { class: 'input', 'aria-label': 'Section' }, sections().map((s) => h('option', { value: s.id, selected: s.id === section }, s.name)));
    setTimeout(() => name.focus(), 50);
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.closest('.dlg')?.querySelector('.btn-primary')?.click(); });
    const ok = await dialog({
      title: 'New variable',
      width: 420,
      body: h('div', { class: 'stack' },
        h('div', { class: 'vr-pick-row' }, pick, pickLabel),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Name'), name),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Section'), secSel)),
      actions: [{ label: 'Cancel', value: false }, { label: 'Add', primary: true, value: true }],
    });
    const n = name.value.trim();
    if (!ok || !n) return;
    const x = { id: uid(), section: secSel.value, name: n, photo: null, notes: [], at: Date.now() };
    section = x.section; remember();
    setEntries([...entries(), x]);
    if (file) setPhoto(x.id, file);
  }

  async function setPhoto(id, f) {
    try {
      const up = await uploadMedia(f);
      patchEntry(id, () => ({ photo: up.path }));
    } catch (e) { toast(e?.message || friendlyError(e), { tone: 'error' }); }
  }

  function entryMenu(anchor, x) {
    const others = sections().filter((s) => s.id !== x.section);
    menu(anchor, [
      { label: 'Open notes', icon: 'chat', onSelect: () => openEntry(x.id) },
      { label: 'Rename', icon: 'edit', onSelect: async () => { const n = await promptDialog('Rename', { value: x.name, maxLength: 48 }); if (n?.trim()) patchEntry(x.id, () => ({ name: n.trim() })); } },
      { label: x.photo ? 'Change photo' : 'Add a photo', icon: 'image', onSelect: async () => { const [f] = await pickMedia({ multiple: false, accept: 'image/*' }); if (f) setPhoto(x.id, f); } },
      x.photo ? { label: 'Remove photo', icon: 'eyeOff', onSelect: () => patchEntry(x.id, () => ({ photo: null })) } : null,
      others.length ? { header: 'Move to' } : null,
      ...others.map((s) => ({ label: s.name, icon: 'folderMove', onSelect: () => patchEntry(x.id, () => ({ section: s.id })) })),
      '-',
      { label: 'Delete', icon: 'trash', danger: true, onSelect: async () => { if (await confirmDialog(`Delete ${x.name}?`, x.notes?.length ? 'Its notes go with it.' : 'This can’t be undone from here.')) setEntries(entries().filter((y) => y.id !== x.id)); } },
    ].filter(Boolean));
  }

  /* ---------------- an entry's notes ---------------- */
  function msgRows(x) {
    const rows = [];
    let lastDay = '';
    for (const m of x.notes || []) {
      const dl = dayLabel(m.ts);
      if (dl !== lastDay) { rows.push(h('div', { class: 'vr-day' }, dl)); lastDay = dl; }
      rows.push(bubble(x, m));
    }
    return rows.length ? rows : [h('p', { class: 'vr-hint is-chat' }, `Notes on ${x.name}. Reflect, keep track, see how things change.`)];
  }

  function chat(x) {
    const ta = h('textarea', {
      class: 'vr-input', rows: 1, placeholder: 'Enter your message', maxlength: 4000, 'aria-label': 'Write a note', value: draft,
      oninput: (e) => { draft = e.target.value; grow(e.target); },
      onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(x.id, e.target); } },
      onfocus: () => { busy = true; },
      onblur: () => { busy = false; if (pending) setTimeout(render, 0); },
    });
    const head = h('div', { class: 'vr-chat-head' },
      h('button', { class: 'vr-back', type: 'button', 'aria-label': 'Back to variables', onclick: () => { open = null; remember(); render(); } }, icon('chevronLeft', 16)),
      x.photo ? h('span', { class: 'vr-mini-face' }, urlOf(x.photo, render) ? h('img', { src: urlOf(x.photo), alt: '' }) : null) : null,
      h('span', { class: 'vr-chat-name' }, x.name),
      h('span', { class: 'vr-chat-sec' }, sections().find((s) => s.id === x.section)?.name || ''),
      h('button', { class: 'vr-card-more', type: 'button', 'aria-label': 'Options', onclick: (e) => entryMenu(e.currentTarget, x) }, icon('more', 14)));
    const wrap = h('div', { class: 'vr-chat' }, head,
      h('div', { class: 'vr-msgs' }, msgRows(x)),
      h('div', { class: 'vr-compose' },
        h('button', { class: ['vr-plus', sending && 'is-busy'], type: 'button', 'aria-label': 'Add a photo', disabled: sending, onclick: async () => { const fs = await pickMedia({ accept: 'image/*,video/*' }); if (fs.length) sendFiles(x.id, fs); } },
          sending ? h('span', { class: 'dots-loader sm' }, h('i'), h('i'), h('i')) : icon('plus', 18)),
        ta));
    wrap.addEventListener('paste', (e) => { const fs = mediaFiles(e.clipboardData); if (fs.length) { e.preventDefault(); sendFiles(x.id, fs); } });
    wrap.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); wrap.classList.add('is-drop'); } });
    wrap.addEventListener('dragleave', (e) => { if (!wrap.contains(e.relatedTarget)) wrap.classList.remove('is-drop'); });
    wrap.addEventListener('drop', (e) => { wrap.classList.remove('is-drop'); const fs = mediaFiles(e.dataTransfer); if (fs.length) { e.preventDefault(); e.stopPropagation(); sendFiles(x.id, fs); } });
    requestAnimationFrame(() => grow(ta));
    return wrap;
  }

  function bubble(x, m) {
    const mine = !m.by || m.by === me?.id;
    const files = (m.files || []).map((f) => {
      const url = urlOf(f.path, render);
      return h('button', { type: 'button', class: ['vr-file', `is-${f.kind}`], onclick: () => lightbox(f), 'aria-label': f.kind === 'video' ? 'Play video' : 'View photo' },
        f.kind === 'photo' ? (url ? h('img', { src: url, alt: '', loading: 'lazy' }) : h('span', { class: 'vr-file-ph' })) : h('span', { class: 'vr-file-vid' }, icon('play', 18), f.name || 'video'));
    });
    return h('div', {
      class: ['vr-msg', mine ? 'is-mine' : 'is-theirs'],
      oncontextmenu: (e) => { e.preventDefault(); e.stopPropagation(); msgMenu({ x: e.clientX, y: e.clientY }, x, m); },
    },
      !mine && m.name ? h('span', { class: 'vr-msg-who' }, m.name) : null,
      ...files,
      m.text ? h('span', { class: 'vr-msg-text' }, m.text) : null,
      h('span', { class: 'vr-msg-time', title: new Date(m.ts).toLocaleString() }, m.edited ? `edited · ${hhmm(m.ts)}` : hhmm(m.ts)));
  }

  function msgMenu(anchor, x, m) {
    menu(anchor, [
      m.text ? { label: 'Copy', icon: 'copy', onSelect: async () => { try { await navigator.clipboard.writeText(m.text); toast('Copied.', { ms: 1400 }); } catch {} } } : null,
      m.text ? { label: 'Edit', icon: 'edit', onSelect: async () => { const t = await promptDialog('Edit note', { value: m.text, maxLength: 4000 }); if (t?.trim()) patchEntry(x.id, (e) => ({ notes: (e.notes || []).map((y) => (y.id === m.id ? { ...y, text: t.trim(), edited: true } : y)) })); } } : null,
      '-',
      { label: 'Delete note', icon: 'trash', danger: true, onSelect: () => patchEntry(x.id, (e) => ({ notes: (e.notes || []).filter((y) => y.id !== m.id) })) },
    ].filter(Boolean));
  }

  const note = (p) => ({ id: uid(), by: me?.id || null, name: me?.username || '', ts: Date.now(), text: '', files: [], ...p });
  const pushNote = (id, n) => patchEntry(id, (e) => ({ notes: [...(e.notes || []), n].slice(-MAX_NOTES) }));

  function send(id, ta) {
    const text = ta.value.trim();
    if (!text) return;
    ta.value = ''; draft = ''; grow(ta);
    pushNote(id, note({ text }));
  }

  async function sendFiles(id, fs) {
    if (sending) return;
    sending = true; render();
    const files = [];
    for (const f of fs) {
      try { const up = await uploadMedia(f); files.push({ kind: up.kind, path: up.path, name: up.name, dur: up.dur }); }
      catch (e) { toast(e?.message || friendlyError(e), { tone: 'error', ms: 5000 }); }
    }
    sending = false;
    if (files.length) pushNote(id, note({ files }));
    render();
  }

  function grow(ta) { ta.style.height = 'auto'; ta.style.height = `${Math.min(140, ta.scrollHeight)}px`; }

  render();

  return {
    update(next) {
      const changed = next.entries !== el.entries || next.sections !== el.sections;
      el = next;
      if (changed) render();
    },
    destroy() { box.remove(); },
  };
}
