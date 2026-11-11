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
import { menu, toast, promptDialog } from '../core/ui.js';
import { uid, store } from '../core/util.js';
import { api, friendlyError } from '../data/api.js';

const MAX = 400; // messages kept on the object (older ones drop off; export before if you need them all)

/* ---------------- speech ---------------- */
// ElevenLabs (default): the sender makes the audio once, saves it with the message, and everyone
// plays that same file — one generation per message, and only the sender needs the API key.
// The key stays on your device (localStorage), never in the shared Space or your synced prefs.
// Browser voice is the fallback (no key, or ElevenLabs fails).
export const EL_DEFAULT_VOICE = 'G3zrXA9moYrFCgwBAvxJ';
const EL_MODEL = 'eleven_flash_v2_5'; // lowest latency: it plays almost as you hit Enter
const spoken = new Set();
export const ttsSupported = () => typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
const voicePref = () => store.get('architect.tts.voice', '');
const ratePref = () => Number(store.get('architect.tts.rate', 1)) || 1;
const elKey = () => { try { return localStorage.getItem('architect.tts.elKey') || ''; } catch { return ''; } };
const setElKey = (k) => { try { if (k) localStorage.setItem('architect.tts.elKey', k); else localStorage.removeItem('architect.tts.elKey'); } catch {} };
const elVoice = () => store.get('architect.tts.elVoice', EL_DEFAULT_VOICE) || EL_DEFAULT_VOICE;
const engine = () => store.get('architect.tts.engine', 'eleven');

function voices() {
  try { return window.speechSynthesis.getVoices() || []; } catch { return []; }
}

// One voice at a time: messages queue up instead of talking over each other.
let chain = Promise.resolve();
const enqueue = (fn) => { chain = chain.then(fn).catch((e) => console.warn('TTS', e)); return chain; };

function playUrl(url) {
  return new Promise((resolve) => {
    const a = new Audio(url);
    a.onended = a.onerror = () => resolve();
    a.play().catch(() => { toast('Click anywhere once so the Voice chat can play sound.', { ms: 3500 }); resolve(); });
  });
}
function browserSay(text) {
  if (!ttsSupported()) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      const u = new SpeechSynthesisUtterance(String(text).slice(0, 600));
      const v = voices().find((x) => x.name === voicePref());
      if (v) u.voice = v;
      u.rate = ratePref();
      u.onend = u.onerror = () => resolve();
      window.speechSynthesis.speak(u);
    } catch { resolve(); }
  });
}

export async function elevenAudio(text, key = elKey()) {
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(elVoice())}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({ text: String(text).slice(0, 1000), model_id: EL_MODEL }),
  });
  if (!r.ok) {
    let msg = `ElevenLabs error ${r.status}`;
    try { const j = await r.json(); msg = j?.detail?.message || j?.detail?.status || (typeof j?.detail === 'string' ? j.detail : msg); } catch {}
    if (r.status === 401 && !/sk_/.test(msg)) msg = 'ElevenLabs rejected the API key — paste the one that starts with “sk_”.';
    throw new Error(msg);
  }
  return r.blob();
}

// Plays a message: its saved ElevenLabs audio if it has some, otherwise the browser voice.
export function speak(m, { force = false } = {}) {
  if (!m?.text) return;
  if (!force && spoken.has(m.id)) return;
  spoken.add(m.id);
  if (m.audio) {
    enqueue(async () => {
      const url = (await api.media.sign([m.audio]).catch(() => ({})))[m.audio];
      if (url) await playUrl(url); else await browserSay(m.text);
    });
  } else enqueue(() => browserSay(m.text));
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
  const waiting = new Map(); // message id → fallback timer while its ElevenLabs audio is on the way
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
    const vs = voices().filter((v) => /^en|^fil|^tl/i.test(v.lang)).slice(0, 10);
    const test = () => {
      if (engine() === 'eleven' && elKey()) elevenAudio('Like this.').then((b) => { const u = URL.createObjectURL(b); enqueue(() => playUrl(u)); }).catch((e) => toast(e.message, { tone: 'error' }));
      else enqueue(() => browserSay('Like this.'));
    };
    menu(anchor, [
      { header: 'Your voice' },
      { label: `ElevenLabs · ${elVoice().slice(0, 8)}…`, icon: 'speaker', checked: engine() === 'eleven', onSelect: () => { store.set('architect.tts.engine', 'eleven'); if (!elKey()) askKey(); else test(); } },
      { label: 'Browser voice', icon: 'speaker', checked: engine() === 'browser', onSelect: () => { store.set('architect.tts.engine', 'browser'); test(); } },
      '-',
      { header: 'ElevenLabs' },
      { label: elKey() ? 'Change API key…' : 'Add API key…', icon: 'key', onSelect: () => askKey() },
      { label: 'Voice ID…', icon: 'edit', onSelect: async () => {
        const v = await promptDialog('ElevenLabs voice ID', { value: elVoice(), ok: 'Save', maxLength: 64, label: `Default: ${EL_DEFAULT_VOICE}` });
        if (v != null) { store.set('architect.tts.elVoice', v.trim() || EL_DEFAULT_VOICE); test(); }
      } },
      elKey() ? { label: 'Remove API key', icon: 'trash', onSelect: () => { setElKey(''); toast('Key removed from this device.'); } } : null,
      '-',
      { header: 'Browser voice (fallback)' },
      { label: 'Default voice', checked: !voicePref(), onSelect: () => store.set('architect.tts.voice', '') },
      ...vs.map((v) => ({ label: v.name, checked: voicePref() === v.name, onSelect: () => { store.set('architect.tts.voice', v.name); enqueue(() => browserSay('Like this.')); } })),
      ...[[0.85, 'Slow'], [1, 'Normal'], [1.2, 'Fast']].map(([r, l]) => ({ label: `Speed: ${l}`, checked: ratePref() === r, onSelect: () => store.set('architect.tts.rate', r) })),
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
    const useEl = tts && engine() === 'eleven' && !!elKey();
    if (useEl) m.voice = 'el'; // tells everyone the ElevenLabs audio is on its way
    mineSent.set(m.id, m);
    mineAfter.set(m.id, (w.current().messages || []).at(-1)?.id || null); // where it went, in case it has to be put back
    known.add(m.id);
    if (text === input.value) { input.value = ''; grow(); stopTyping(); }
    commit();
    if (useEl) voiceOver(m);
    else if (tts && !muted) speak(m);
    else if (tts) spoken.add(m.id);
    paint(true);
    if (tts && engine() === 'eleven' && !elKey()) askKey(true);
  }

  // Make the ElevenLabs audio, play it here right away, then attach it to the message for everyone.
  async function voiceOver(m) {
    spoken.add(m.id);
    let blob;
    try { blob = await elevenAudio(m.text); }
    catch (e) {
      toast(`${e.message} Using the browser voice.`, { tone: 'error', ms: 5000 });
      patchMine(m.id, { voice: null });
      if (!muted) enqueue(() => browserSay(m.text));
      return;
    }
    const local = URL.createObjectURL(blob);
    if (!muted) enqueue(() => playUrl(local)).then(() => URL.revokeObjectURL(local));
    try {
      const { path } = await api.media.upload(new File([blob], 'voice.mp3', { type: 'audio/mpeg' }));
      patchMine(m.id, { audio: path });
    } catch (e) {
      patchMine(m.id, { voice: null }); // others fall back to their browser voice
      console.warn('Voice upload failed', friendlyError(e));
    }
  }
  function patchMine(id, patch) {
    const mine = mineSent.get(id);
    if (mine) Object.assign(mine, patch);
    const cur = w.current().messages || [];
    if (cur.some((x) => x.id === id)) w.live({ messages: cur.map((x) => (x.id === id ? { ...x, ...patch } : x)) });
  }

  async function askKey(firstTime = false) {
    if (askKey.open) return;
    askKey.open = true;
    try {
      const k = await promptDialog(firstTime ? 'Use your ElevenLabs voice' : 'ElevenLabs API key', {
        value: firstTime ? '' : elKey(), placeholder: 'sk_…', ok: 'Save', maxLength: 200,
        label: 'API key — saved on this device only (elevenlabs.io → Developers → API keys)',
      });
      if (k == null) { if (firstTime) toast('Using the browser voice for now — set the key from the voice ⚙.', { ms: 4000 }); return; }
      const key = k.trim();
      // The dashboard lists each key's ID too; only the secret (shown once, starts with sk_) works.
      if (key && !/^sk_\w{10,}/.test(key)) {
        toast('That looks like the key’s ID, not the key. The real key starts with “sk_” and is shown once when you create or rotate it (ElevenLabs → Developers → API Keys).', { tone: 'error', ms: 9000 });
        return;
      }
      setElKey(key);
      toast(key ? 'ElevenLabs voice on.' : 'Key removed — using the browser voice.', { ms: 2200 });
    } finally { askKey.open = false; }
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
          tts ? h('button', { class: 'ch-replay', type: 'button', title: 'Play again', 'aria-label': 'Play again', onclick: () => speak((w.current().messages || []).find((x) => x.id === m.id) || m, { force: true }) }, icon('play', 11)) : null)));
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
        // ElevenLabs audio arriving for a message we were waiting on.
        if (waiting.has(m.id) && (m.audio || m.voice !== 'el')) { clearTimeout(waiting.get(m.id)); waiting.delete(m.id); if (!muted) speak(m); }
        if (known.has(m.id)) continue;
        known.add(m.id);
        if (typers.delete(m.by)) paintTyping();
        if (!tts || muted || m.by === me.id || m.ts < mountedAt - 15_000) continue;
        if (m.voice === 'el' && !m.audio) {
          // The sender is still making it: wait a few seconds, then fall back to this browser's voice.
          waiting.set(m.id, setTimeout(() => { waiting.delete(m.id); if (!muted) speak({ ...m, audio: null }); }, 9000));
        } else speak(m);
      }
      // Lost in a simultaneous send (their copy didn't have yours yet): add it back.
      if ([...mineSent.keys()].some((id) => !ids.has(id))) { clearTimeout(retry); retry = setTimeout(commit, 250 + Math.random() * 250); }
      paint();
    },
    destroy() { clearTimeout(retry); clearTimeout(typingTimer); stopTyping(); offSignal?.(); waiting.forEach((t) => clearTimeout(t)); },
    send,
  };
}
