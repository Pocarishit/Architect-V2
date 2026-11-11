// Chat objects on the Space canvas.
//   chat  — a thread, optionally connected to another object (a sticky, a widget, a Blueprint portal…).
//           Resizable, scrolls on hover, exports to Markdown / text / JSON.
//   tts   — Voice chat: every message is read out loud (text-to-speech) on everyone's screen,
//           the moment it's sent. Your own plays as you hit Enter.
// Messages live on the widget object itself, so they sync live with the rest of the Space.
// Two people sending at the same moment can overwrite each other; each sender keeps its message
// pending until it shows up in the shared copy and re-adds it if it was lost.
// Order is arrival order (not each device's clock — a clock a minute behind used to file your
// new messages above everyone else's). "… is typing" travels over the live channel only.
import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { menu, toast } from '../core/ui.js';
import { uid, store } from '../core/util.js';

const MAX = 400; // messages kept on the object (older ones drop off; export before if you need them all)

/* ---------------- speech ---------------- */
const spoken = new Set();
export const ttsSupported = () => typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
const voicePref = () => store.get('architect.tts.voice', '');
const ratePref = () => Number(store.get('architect.tts.rate', 1)) || 1;

function voices() {
  try { return window.speechSynthesis.getVoices() || []; } catch { return []; }
}

export function speak(m, { force = false } = {}) {
  if (!ttsSupported() || !m?.text) return;
  if (!force && spoken.has(m.id)) return;
  spoken.add(m.id);
  try {
    const u = new SpeechSynthesisUtterance(String(m.text).slice(0, 600));
    const v = voices().find((x) => x.name === voicePref());
    if (v) u.voice = v;
    u.rate = ratePref();
    window.speechSynthesis.speak(u);
  } catch (e) { console.warn('TTS failed', e); }
}

/* ---------------- labels for the object a chat is about ---------------- */
const strip = (t) => String(t || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
export function labelOf(el) {
  if (!el) return 'Deleted object';
  if (el.type === 'widget') {
    const names = { path: `${el.ownerName || ''} Path`.trim(), tracker: 'Tracker', tickets: 'Ticket board', blueprints: 'Blueprints', portal: el.name || 'Blueprint', custom: el.title || 'Widget', ticket: 'Ticket', column: 'Path column', ticketcol: 'Ticket column', radio: 'Radio', chat: 'Chat', tts: 'Voice chat' };
    return names[el.kind] || 'Widget';
  }
  if (el.type === 'frame') return el.title || 'Frame';
  if (el.type === 'link' || el.type === 'embed') return el.title || el.provider || el.host || 'Link';
  const t = strip(el.text);
  if (t) return t.length > 48 ? `${t.slice(0, 46)}…` : t;
  return { sticky: 'Sticky note', text: 'Text', shape: 'Shape', image: 'Image', video: 'Video', pdf: el.name || 'PDF', border: 'Border' }[el.type] || 'Object';
}

/* ---------------- export ---------------- */
function download(name, text, type) {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
const stamp = (ts) => new Date(ts).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const fileBase = (title) => (title || 'chat').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'chat';

function exportChat(anchor, title, list) {
  if (!list.length) { toast('Nothing to export yet.'); return; }
  const md = () => [`# ${title}`, `_Exported ${stamp(Date.now())} · ${list.length} message${list.length === 1 ? '' : 's'}_`, '',
    ...list.map((m) => `**${m.name || 'Someone'}** · ${stamp(m.ts)}  \n${String(m.text).replace(/\n/g, '  \n')}\n`)].join('\n');
  const txt = () => [title, '', ...list.map((m) => `[${stamp(m.ts)}] ${m.name || 'Someone'}: ${m.text}`)].join('\n');
  menu(anchor, [
    { header: 'Export chat' },
    { label: 'Copy as text', icon: 'copy', onSelect: async () => { try { await navigator.clipboard.writeText(txt()); toast('Copied.'); } catch { toast('Couldn’t copy — use a download instead.', { tone: 'error' }); } } },
    { label: 'Download Markdown (.md)', icon: 'download', onSelect: () => download(`${fileBase(title)}.md`, md(), 'text/markdown') },
    { label: 'Download text (.txt)', icon: 'file', onSelect: () => download(`${fileBase(title)}.txt`, txt(), 'text/plain') },
    { label: 'Download JSON', icon: 'json', onSelect: () => download(`${fileBase(title)}.json`, JSON.stringify({ title, exported_at: new Date().toISOString(), messages: list }, null, 2), 'application/json') },
  ], { align: 'end' });
}

/* ---------------- the widget ---------------- */
// w: widget helper from widgets.js · opts.tts: Voice chat
export function mountChat(body, el, w, { tts = false } = {}) {
  const me = w.me || {};
  const ed = () => w.host.editor();
  const mutedKey = `architect.tts.muted.${el.id}`;
  let muted = !!store.get(mutedKey, false);
  const mineSent = new Map();
  const mineAfter = new Map(); // message id → the message it came after when you sent it // everything you sent while this is open: re-added if someone's copy overwrote it
  const known = new Set((el.messages || []).map((m) => m.id));
  (el.messages || []).forEach((m) => spoken.add(m.id)); // history isn't read out on load
  const mountedAt = Date.now();
  let retry = null;

  const list = h('div', { class: 'ch-list', 'data-wheel': '', role: 'log', 'aria-live': tts ? 'off' : 'polite' });
  const input = h('textarea', { class: 'ch-input', rows: 1, maxlength: 2000, placeholder: tts ? 'Type — it’s spoken out loud' : 'Message', 'aria-label': 'Message' });
  const sendBtn = h('button', { class: 'ch-send', type: 'button', 'aria-label': 'Send', onclick: () => send() }, icon(tts ? 'speaker' : 'send', 16));
  const about = h('button', { class: 'ch-about', type: 'button', hidden: true, onclick: () => goAbout() });
  const typingRow = h('div', { class: 'ch-typing', 'aria-live': 'polite', hidden: true });
  body.append(h('div', { class: ['ch', tts && 'is-tts'] }, about, list, typingRow, h('div', { class: 'ch-compose' }, input, sendBtn)));

  /* "… is typing" — out over the live channel while you type, in from everyone else */
  const typers = new Map(); // uid → { name, until }
  let lastPing = 0, typingTimer = null;
  const signal = (stop = false) => { try { ed()?.emit('signal', { kind: 'typing', chat: el.id, stop, uid: me.id, name: me.username }); } catch {} };
  function pingTyping() {
    const now = Date.now();
    if (!input.value.trim()) { if (lastPing) { lastPing = 0; signal(true); } return; }
    if (now - lastPing > 1500) { lastPing = now; signal(); }
  }
  function stopTyping() { if (lastPing) { lastPing = 0; signal(true); } }
  function paintTyping() {
    const now = Date.now();
    for (const [id, t] of typers) if (t.until < now) typers.delete(id);
    const names = [...typers.values()].map((t) => t.name || 'Someone');
    typingRow.hidden = !names.length;
    if (names.length) typingRow.replaceChildren(h('span', { class: 'ch-dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
      h('span', {}, names.length === 1 ? `${names[0]} is typing` : names.length === 2 ? `${names[0]} and ${names[1]} are typing` : 'Several people are typing'));
    clearTimeout(typingTimer);
    if (names.length) typingTimer = setTimeout(paintTyping, 1000);
  }
  let offSignal = null;
  const listen = () => {
    const e = ed();
    if (!e || offSignal) return;
    offSignal = e.on('signal-in', (sig) => {
      if (sig?.kind !== 'typing' || sig.chat !== el.id || sig.uid === me.id) return;
      if (sig.stop) typers.delete(sig.uid); else typers.set(sig.uid, { name: sig.name, until: Date.now() + 4000 });
      paintTyping();
    });
  };
  listen();
  setTimeout(listen, 0); // the editor may hand itself over a tick after the widget mounts
  input.addEventListener('blur', stopTyping);

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
    e.stopPropagation(); // typing here never drives canvas shortcuts
  });
  const grow = () => { input.style.height = 'auto'; input.style.height = `${Math.min(120, input.scrollHeight)}px`; };
  input.addEventListener('input', () => { grow(); pingTyping(); });

  /* tools in the widget header */
  const muteBtn = tts ? h('button', { class: 'wg-btn', type: 'button', onclick: () => setMuted(!muted) }) : null;
  const paintMute = () => { if (!muteBtn) return; muteBtn.replaceChildren(icon(muted ? 'mute' : 'speaker', 14)); muteBtn.title = muted ? 'Unmute (only for you)' : 'Mute (only for you)'; muteBtn.setAttribute('aria-label', muteBtn.title); };
  function setMuted(v) { muted = v; store.set(mutedKey, v); paintMute(); if (v) try { window.speechSynthesis.cancel(); } catch {} }
  paintMute();
  const exportBtn = h('button', { class: 'wg-btn', type: 'button', title: 'Export chat', 'aria-label': 'Export chat', onclick: (e) => exportChat(e.currentTarget, titleText(), (w.current().messages || [])) }, icon('download', 14));
  const voiceBtn = tts ? h('button', { class: 'wg-btn', type: 'button', title: 'Voice', 'aria-label': 'Voice', onclick: (e) => voiceMenu(e.currentTarget) }, icon('settings', 14)) : null;
  w.tools.append(...[muteBtn, voiceBtn, exportBtn].filter(Boolean));

  function voiceMenu(anchor) {
    const vs = voices().filter((v) => /^en|^fil|^tl/i.test(v.lang)).slice(0, 14);
    menu(anchor, [
      { header: 'Voice (only for you)' },
      { label: 'Default voice', checked: !voicePref(), onSelect: () => store.set('architect.tts.voice', '') },
      ...vs.map((v) => ({ label: v.name, checked: voicePref() === v.name, onSelect: () => { store.set('architect.tts.voice', v.name); speak({ id: uid(), text: 'Like this.' }); } })),
      '-',
      { header: 'Speed' },
      ...[[0.85, 'Slow'], [1, 'Normal'], [1.2, 'Fast'], [1.45, 'Faster']].map(([r, l]) => ({ label: l, checked: ratePref() === r, onSelect: () => store.set('architect.tts.rate', r) })),
    ], { align: 'end' });
  }

  function titleText() {
    const cur = w.current();
    if (tts) return 'Voice chat';
    return cur.about ? `Chat — ${labelOf(ed()?.byId.get(cur.about))}` : (cur.title || 'Chat');
  }
  function goAbout() {
    const id = w.current().about;
    const e = id && ed()?.byId.get(id);
    if (!e) { toast('That object is gone.'); return; }
    ed().select([id]);
    ed().fitRect(e, { maxZ: 1, pad: 60 });
  }

  /* sending + keeping messages from getting lost */
  function send(text = input.value) {
    const t = String(text || '').trim();
    if (!t) return;
    const m = { id: uid(), by: me.id, name: me.username || 'Me', text: t.slice(0, 2000), ts: Date.now() };
    mineSent.set(m.id, m);
    mineAfter.set(m.id, (w.current().messages || []).at(-1)?.id || null); // where it went, in case it has to be put back
    known.add(m.id);
    if (text === input.value) { input.value = ''; grow(); stopTyping(); }
    commit();
    if (tts && !muted) speak(m);
    paint(true);
  }
  function commit() {
    const cur = w.current().messages || [];
    const have = new Set(cur.map((x) => x.id));
    const add = [...mineSent.values()].filter((m) => !have.has(m.id));
    if (!add.length) return;
    // Arrival order: a new message goes to the bottom; one lost in a race goes back where it was.
    const next = [...cur];
    for (const m of add) {
      const after = mineAfter.get(m.id);
      const i = after ? next.findIndex((x) => x.id === after) : mineAfter.has(m.id) ? -1 : -2; // -1: it was the very first message
      if (i >= -1 && i < next.length - 1) {
        let j = i + 1;
        while (j < next.length && mineSent.has(next[j].id)) j++; // keep your own messages in the order you sent them
        next.splice(j, 0, m);
      } else next.push(m);
    }
    next.splice(0, Math.max(0, next.length - MAX));
    w.live({ messages: next });
  }

  /* drawing */
  let lastSig = '';
  function paint(stick = false) {
    const cur = w.current();
    const msgs = cur.messages || [];
    // About-line for chats connected to an object.
    const target = cur.about ? ed()?.byId.get(cur.about) : null;
    about.hidden = !cur.about;
    if (cur.about) about.replaceChildren(icon('link', 13), h('span', {}, labelOf(target)), icon('target', 13));
    w.setTitle(tts ? 'VOICE CHAT' : cur.about ? 'CHAT' : (cur.title || 'CHAT').toUpperCase());
    const sig = msgs.map((m) => m.id).join();
    if (sig === lastSig) return;
    lastSig = sig;
    const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 30;
    let day = '';
    const rows = [];
    let prev = null;
    for (const m of msgs) {
      const d = new Date(m.ts).toDateString();
      if (d !== day) { day = d; prev = null; rows.push(h('div', { class: 'ch-day' }, new Date(m.ts).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }))); }
      const mine = m.by === me.id;
      const cont = prev && prev.by === m.by && m.ts - prev.ts < 5 * 60_000;
      rows.push(h('div', { class: ['ch-msg', mine && 'is-mine', cont && 'is-cont'] },
        cont ? null : h('div', { class: 'ch-meta' },
          h('span', { class: 'ch-av', 'aria-hidden': 'true' }, (m.name || '?').slice(0, 1).toUpperCase()),
          h('b', {}, mine ? 'You' : (m.name || 'Someone')),
          h('time', {}, new Date(m.ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }))),
        h('div', { class: 'ch-bubble' }, m.text,
          tts ? h('button', { class: 'ch-replay', type: 'button', title: 'Play again', 'aria-label': 'Play again', onclick: () => speak(m, { force: true }) }, icon('play', 11)) : null)));
      prev = m;
    }
    list.replaceChildren(...(rows.length ? rows : [h('p', { class: 'ch-empty' }, tts ? 'Messages here are read out loud for everyone in the Space.' : cur.about ? 'Talk about the connected object here.' : 'No messages yet.')]));
    if (stick || atBottom) list.scrollTop = list.scrollHeight;
  }
  paint(true);

  return {
    update(next) {
      const msgs = next.messages || [];
      const ids = new Set(msgs.map((m) => m.id));
      for (const m of msgs) {
        if (known.has(m.id)) continue;
        known.add(m.id);
        if (typers.delete(m.by)) paintTyping();
        if (tts && !muted && m.by !== me.id && m.ts > mountedAt - 15_000) speak(m);
      }
      // Lost in a simultaneous send (their copy didn't have yours yet): add it back.
      if ([...mineSent.keys()].some((id) => !ids.has(id))) { clearTimeout(retry); retry = setTimeout(commit, 250 + Math.random() * 250); }
      paint();
    },
    destroy() { clearTimeout(retry); clearTimeout(typingTimer); stopTyping(); offSignal?.(); },
    send,
  };
}
