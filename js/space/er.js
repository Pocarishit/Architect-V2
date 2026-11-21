// Emergency Room — one problem, all action.
// Press E + R in the Space: red seeps in from the edges, the room's border settles around you,
// and the problem you're on is all there is. Chat on the left (Side Chat style), board on the right.
// The name + dropdown at the top of the chat swaps the whole room (board and chat) in one click.
//
// Storage (no new SQL): each problem is a blueprints row with kind 'er' (its board), and its chat is a
// companion row with kind 'er-chat' whose name is the problem's id. Both are shared with everyone in
// your shared Space, so Maveri and Hiru walk into the same rooms.
import { h, isTypingTarget } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { menu, toast, promptDialog, confirmDialog, closeFloating } from '../core/ui.js';
import { uid, store, prefersReducedMotion } from '../core/util.js';
import { api, friendlyError } from '../data/api.js';
import { mountBoard } from '../board/board.js';
import { getSurface, setSurface } from '../board/editor.js';
import { onEscapeFull } from '../core/guard.js';
import { go } from '../core/router.js';
import { uploadMedia, mediaFiles, pickMedia, canRecord, startRecording, fmtDur, playAllVoice } from './media.js';
import { bubbleRow, dayRow, chatDayLabel, CHAT_GROUP_MS } from './sidechat.js';
import { speak, ttsSupported } from './chat.js';

export const ER_KINDS = ['er', 'er-chat'];
const SURFACE = 'er-room';
const LAST = 'architect.er.last';
const POLL_MS = 3500;
const MAX_MSGS = 2000;
const VOICE = 'architect.er.voice';
const CHAT_OPEN = 'architect.er.chatOpen';

/* ---------------- E + R: press them together, or E then R ---------------- */
// Returns true when this keydown completes the combo. E has no tool of its own any more.
export function comboWatcher() {
  let eAt = 0, eHeld = false;
  const up = (e) => { if (e.code === 'KeyE') eHeld = false; };
  window.addEventListener('keyup', up, true);
  window.addEventListener('blur', () => { eHeld = false; });
  return {
    test(e) {
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.repeat) return false;
      if (e.code === 'KeyE') { eAt = performance.now(); eHeld = true; return false; }
      if (e.code === 'KeyR' && (eHeld || performance.now() - eAt < 700)) { eAt = 0; return true; }
      eAt = 0;
      return false;
    },
    off() { window.removeEventListener('keyup', up, true); },
  };
}

function micIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '17'); svg.setAttribute('height', '17'); svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = '<rect x="9" y="3" width="6" height="11" rx="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>';
  return svg;
}

/* ---------------- data ---------------- */
const listProblems = () => api.db.select('blueprints', { columns: 'id,name,user_id,created_at', filters: { kind: 'er' }, order: 'created_at.asc' });
async function chatRowOf(problemId) {
  const rows = await api.db.select('blueprints', { columns: 'id,name,data', filters: { kind: 'er-chat', name: problemId } });
  return rows[0] || null;
}
async function shareWithSpace(rowIds, spaceId, me) {
  if (api.mode === 'local' || !spaceId) return;
  try {
    const people = (await api.rpc('board_people', { b: spaceId })) || [];
    for (const p of people) if (p.user_id !== me?.id) for (const id of rowIds) await api.rpc('share_board', { b: id, uname: p.username }).catch(() => {});
  } catch {}
}

/* ---------------- the room ---------------- */
export function openEmergencyRoom(root, { me, spaceId = () => null, onClose } = {}) {
  const prevSurface = getSurface();
  let problems = [];
  let cur = null;          // current problem row
  let board = null;        // mounted board
  let chatId = null;       // companion chat row id
  let msgs = [];
  let sig = '';
  let draft = '';
  let sending = false;
  let poll = 0;
  let closed = false;
  const combo = comboWatcher();

  const nameEl = h('button', { class: 'er-name', type: 'button', title: 'Double-click to rename', ondblclick: () => cur && rename(cur) }, 'PROBLEM');
  const drop = h('button', { class: 'er-drop', type: 'button', 'aria-label': 'Switch problem', 'aria-haspopup': 'menu', onclick: (e) => pickMenu(e.currentTarget) }, icon('chevronDown', 15));
  nameEl.addEventListener('click', () => drop.click());
  const list = h('div', { class: 'sc-list er-list', role: 'log', 'aria-label': 'Problem chat' });
  const ta = h('textarea', {
    class: 'sc-input er-input', rows: 1, placeholder: 'Enter your message', maxlength: 4000, 'aria-label': 'Message',
    oninput: (e) => { draft = e.target.value; grow(e.target); },
    onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } },
  });
  const plus = h('button', { class: 'sc-plus', type: 'button', 'aria-label': 'Add a photo or video', onclick: async () => { const fs = await pickMedia(); if (fs.length) sendFiles(fs); } }, icon('plus', 18));
  // Voice mode (this device): every message is read out loud, and the mic turns speech into messages.
  let voice = !!store.get(VOICE, false);
  let rec = null;
  const openedAt = Date.now();
  let heard = new Set();
  const voiceBtn = h('button', { class: 'er-hbtn', type: 'button', onclick: () => setVoice(!voice) });
  // Play all (Nov 22): every voice message in the room, top to bottom, back to back.
  const playAllBtn = h('button', { class: 'er-hbtn er-playall', type: 'button', hidden: true, 'aria-label': 'Play all voice messages', title: 'Play all voice messages in order', onclick: () => playAllVoice(list) }, icon('play', 13));
  // The mic sends your actual voice (Nov 22): tap to record, tap again to send, × to throw it away.
  const mic = h('button', { class: 'sc-plus er-mic', type: 'button', 'aria-label': 'Record a voice message', title: 'Record a voice message', onclick: () => (rec ? stopMic(true) : startMic()) }, micIcon());
  const recTime = h('span', { class: 'er-rec-time' }, '0:00');
  const recBar = h('div', { class: 'er-rec', hidden: true, 'aria-live': 'polite' },
    h('button', { class: 'er-rec-x', type: 'button', 'aria-label': 'Discard recording', title: 'Discard', onclick: () => stopMic(false) }, icon('close', 15)),
    h('i', { class: 'er-rec-dot', 'aria-hidden': 'true' }), recTime, h('span', { class: 'er-rec-hint' }, 'Tap the mic to send'));
  const hideBtn = h('button', { class: 'er-hbtn', type: 'button', 'aria-label': 'Hide chat', title: 'Hide chat', onclick: () => setChatOpen(false) }, icon('chevronLeft', 15));
  const showBtn = h('button', { class: 'er-rail', type: 'button', 'aria-label': 'Show chat', title: 'Show chat', onclick: () => setChatOpen(true) }, icon('chevronRight', 15), h('span', { class: 'er-rail-name' }));
  const chat = h('aside', { class: 'er-chat' },
    h('header', { class: 'er-head' }, nameEl, drop, playAllBtn, voiceBtn, hideBtn),
    list,
    h('div', { class: 'sc-compose er-compose' }, plus, ta, recBar, mic),
    showBtn);
  const boardHost = h('div', { class: 'er-board' });
  const room = h('div', { class: 'er-room', role: 'dialog', 'aria-label': 'Emergency Room' }, chat, boardHost);
  const node = h('div', { class: 'er', 'data-surface': SURFACE }, h('div', { class: 'er-wash', 'aria-hidden': 'true' }), room);
  function paintVoice() {
    voiceBtn.replaceChildren(icon(voice ? 'speaker' : 'mute', 15));
    voiceBtn.classList.toggle('is-on', voice);
    voiceBtn.title = voice ? 'Voice mode on — voice messages play as they arrive, text is read out loud' : 'Voice mode off';
    voiceBtn.setAttribute('aria-label', voice ? 'Turn voice mode off' : 'Turn voice mode on');
    voiceBtn.setAttribute('aria-pressed', String(voice));
    mic.hidden = !canRecord();
  }
  function setVoice(on) {
    if (on && !ttsSupported()) { toast('This browser can’t read messages out loud.', { tone: 'error' }); return; }
    voice = on; store.set(VOICE, on);
    if (!on) { try { window.speechSynthesis.cancel(); } catch {} }
    paintVoice();
    if (on) toast('Voice mode on — voice messages play as they arrive.', { ms: 2000 });
  }
  function setChatOpen(open) {
    store.set(CHAT_OPEN, open);
    room.classList.toggle('is-chat-hidden', !open);
    if (open) requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
  }
  paintVoice();
  setChatOpen(store.get(CHAT_OPEN, true) !== false);

  // Mic: records a clip in the browser (free) and sends it as a voice message.
  async function startMic() {
    if (rec || !cur || sending) return;
    rec = { pending: true };
    mic.classList.add('is-live');
    try {
      const r = await startRecording({ onTick: (sec) => { recTime.textContent = fmtDur(sec) || '0:00'; if (sec >= 600) stopMic(true); } });
      if (!rec || closed) { r.cancel(); return; } // cancelled while the mic was opening
      rec = r;
      recTime.textContent = '0:00';
      recBar.hidden = false; ta.hidden = true; plus.hidden = true;
      try { window.speechSynthesis?.cancel(); } catch {}
    } catch (e) {
      rec = null; mic.classList.remove('is-live');
      toast(e?.name === 'NotAllowedError' ? 'Allow the microphone to send voice messages.' : 'Couldn’t open the microphone.', { tone: 'error', ms: 4000 });
    }
  }
  async function stopMic(send = false) {
    const r = rec;
    rec = null;
    mic.classList.remove('is-live');
    recBar.hidden = true; ta.hidden = false; plus.hidden = false;
    if (!r || r.pending) return;
    if (!send) { r.cancel(); return; }
    const clip = await r.stop();
    if (!clip) { toast('That was too short to send.', { ms: 1800 }); return; }
    if (!cur) return;
    sending = true; mic.classList.add('is-busy');
    try {
      const up = await uploadMedia(clip.file, { dur: clip.dur });
      push(note({ files: [{ kind: 'audio', path: up.path, name: up.name, dur: clip.dur }] }));
    } catch (e) { toast(e?.message || friendlyError(e), { tone: 'error', ms: 5000 }); }
    finally { sending = false; mic.classList.remove('is-busy'); }
  }
  // Voice mode: someone else's voice message plays by itself as it lands, one after another.
  const queue = [];
  let playingQ = false;
  function hear(m) {
    if (m.files?.some((f) => f.kind === 'audio')) { queue.push(m.id); if (!playingQ) nextClip(); }
    else if (m.text) speak(m);
  }
  function nextClip() {
    const id = queue.shift();
    if (!id || closed) { playingQ = false; return; }
    playingQ = true;
    const vn = list.querySelector(`.sc-msg[data-id="${CSS.escape(id)}"] .vn`);
    if (!vn?.play) { setTimeout(nextClip, 0); return; }
    let done = false;
    const go2 = () => { if (done) return; done = true; list.removeEventListener('vn-ended', onEnd); nextClip(); };
    const onEnd = () => go2();
    list.addEventListener('vn-ended', onEnd);
    const attempt = (n) => vn.play().catch(() => {
      if (n < 8 && !closed) setTimeout(() => attempt(n + 1), 400); // the clip's link is still on its way
      else { if (n >= 8) toast('Tap ▶ to hear the new voice message.', { ms: 2600 }); go2(); }
    });
    attempt(0);
  }
  if (prefersReducedMotion?.()) node.classList.add('is-still');
  root.append(node);
  setSurface(SURFACE);
  requestAnimationFrame(() => node.classList.add('in'));

  chat.addEventListener('paste', (e) => { const fs = mediaFiles(e.clipboardData); if (fs.length) { e.preventDefault(); sendFiles(fs); } });
  chat.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); chat.classList.add('is-drop'); } });
  chat.addEventListener('dragleave', (e) => { if (!chat.contains(e.relatedTarget)) chat.classList.remove('is-drop'); });
  chat.addEventListener('drop', (e) => { chat.classList.remove('is-drop'); const fs = mediaFiles(e.dataTransfer); if (fs.length) { e.preventDefault(); e.stopPropagation(); sendFiles(fs); } });

  // E + R again walks you out.
  const onKey = (e) => {
    if (closed || isTypingTarget(e.target) || document.querySelector('.dlg-overlay')) return;
    if (combo.test(e)) { e.preventDefault(); e.stopPropagation(); close(); }
  };
  window.addEventListener('keydown', onKey, true);
  const escOff = onEscapeFull(() => { close(); });

  /* ---------------- problems ---------------- */
  (async () => {
    try { problems = await listProblems(); }
    catch (e) { toast(friendlyError(e), { tone: 'error', ms: 5000 }); problems = []; }
    if (closed) return;
    const last = store.get(LAST, null);
    const pick = problems.find((p) => p.id === last) || problems[problems.length - 1];
    if (pick) show(pick); else empty();
  })();

  function empty() {
    cur = null;
    nameEl.textContent = 'NO PROBLEM YET';
    list.replaceChildren(h('p', { class: 'sc-empty' }, 'One problem at a time. Name it and walk in.'));
    ta.disabled = true; plus.disabled = true;
    unmountBoard();
    const inp = h('input', { class: 'er-new-input', maxlength: 60, placeholder: 'WHAT’S THE PROBLEM?', 'aria-label': 'Name the problem',
      onkeydown: (e) => { e.stopPropagation(); if (e.key === 'Enter' && e.target.value.trim()) create(e.target.value.trim()); if (e.key === 'Escape') e.target.blur(); } });
    boardHost.replaceChildren(h('div', { class: 'er-empty' }, inp, h('span', {}, 'ENTER TO OPEN IT')));
    requestAnimationFrame(() => inp.focus());
  }

  function unmountBoard() {
    try { board?.handle?.destroy(); } catch (e) { console.error(e); }
    board = null;
    setSurface(SURFACE);
  }

  async function show(p) {
    if (closed) return;
    cur = p;
    store.set(LAST, p.id);
    nameEl.textContent = (p.name || 'Problem').toUpperCase();
    showBtn.lastChild.textContent = nameEl.textContent;
    stopMic(false);
    ta.disabled = false; plus.disabled = false;
    ta.value = ''; draft = '';
    // The board: the whole right side.
    unmountBoard();
    boardHost.replaceChildren();
    const handle = mountBoard(boardHost, p.id, {
      windowed: {
        surface: SURFACE,
        onExpand: () => { const id = p.id; close(); go(`board/${id}`); },
        onClose: () => close(),
        onName: () => {},
      },
      onReady: (tools) => { if (board?.handle === handle) board.editor = tools.editor; },
    });
    board = { handle, editor: null };
    // The chat.
    msgs = []; sig = ''; chatId = null;
    list.replaceChildren(h('span', { class: 'dots-loader er-loading' }, h('i'), h('i'), h('i')));
    await loadChat(true);
    clearInterval(poll);
    poll = setInterval(() => { if (!document.hidden) loadChat(false); }, POLL_MS);
  }

  async function loadChat(first) {
    const p = cur;
    if (!p) return;
    let row;
    try { row = await chatRowOf(p.id); } catch (e) { if (first) toast(friendlyError(e), { tone: 'error' }); return; }
    if (closed || cur !== p) return;
    chatId = row?.id || null;
    const next = Array.isArray(row?.data?.messages) ? row.data.messages : [];
    const s = JSON.stringify(next);
    if (!first && s === sig) return;
    sig = s; msgs = next;
    if (first) heard = new Set(next.map((m) => m.id));
    const fresh = !first && voice ? next.filter((m) => !heard.has(m.id) && m.by !== me?.id && m.ts > openedAt - 15_000) : [];
    next.forEach((m) => heard.add(m.id));
    paint(first);
    fresh.forEach(hear);
  }

  function paint(toBottom) {
    playAllBtn.hidden = msgs.filter((m) => m.files?.some((f) => f.kind === 'audio')).length < 2;
    const atBottom = toBottom || list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    const rows = [];
    let lastDay = '', prev = null;
    for (const m of msgs) {
      const dl = chatDayLabel(m.ts);
      if (dl !== lastDay) { rows.push(dayRow(m.ts)); lastDay = dl; prev = null; }
      const mine = !m.by || m.by === me?.id;
      rows.push(bubbleRow({ id: m.id, text: m.text, files: m.files, at: m.ts, edited: m.edited, status: m.status }, {
        cont: !!(prev && prev.by === m.by && m.ts - prev.ts < CHAT_GROUP_MS), theirs: !mine, who: m.name || '',
        onAsset: () => paint(false),
        onMenu: (e) => msgMenu({ x: e.clientX, y: e.clientY }, m),
      }));
      prev = m;
    }
    list.replaceChildren(...(rows.length ? rows : [h('p', { class: 'sc-empty' }, 'Talk it through here. The board is for breaking it down.')]));
    if (atBottom) requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
  }

  // Read the latest, apply the change, write it back — so two people typing at once both land.
  async function mutate(fn) {
    const p = cur;
    if (!p) return;
    let row = null;
    try { row = await chatRowOf(p.id); } catch {}
    if (cur !== p) return;
    const base = Array.isArray(row?.data?.messages) ? row.data.messages : [];
    const next = fn(base).slice(-MAX_MSGS);
    if (row) await api.db.update('blueprints', row.id, { data: { v: 1, messages: next } });
    else {
      const id = uid();
      await api.db.insert('blueprints', { id, name: p.id, kind: 'er-chat', folder_id: null, pinned: false, data: { v: 1, messages: next }, preview: [] });
      chatId = id;
      shareWithSpace([id], spaceId(), me);
    }
    if (cur !== p) return;
    next.forEach((m) => heard.add(m.id));
    msgs = next; sig = JSON.stringify(next);
    paint(true);
  }

  const note = (x) => ({ id: uid(), by: me?.id || null, name: me?.username || '', ts: Date.now(), text: '', files: [], ...x });
  async function push(m) {
    msgs = [...msgs, { ...m, status: 'sending' }];
    paint(true);
    try { await mutate((l) => [...l.filter((y) => y.id !== m.id), m]); }
    catch (e) {
      msgs = msgs.map((y) => (y.id === m.id ? { ...y, status: 'failed' } : y));
      paint(false);
      toast(friendlyError(e), { tone: 'error', ms: 5000 });
    }
  }
  function send() {
    const text = ta.value.trim();
    if (!text || !cur) return;
    ta.value = ''; draft = ''; grow(ta);
    const m = note({ text });
    if (voice) speak(m);
    push(m);
  }
  async function sendFiles(fs) {
    if (sending || !cur) return;
    sending = true; plus.classList.add('is-busy');
    const files = [];
    for (const f of fs) {
      try { const up = await uploadMedia(f); files.push({ kind: up.kind, path: up.path, name: up.name, dur: up.dur }); }
      catch (e) { toast(e?.message || friendlyError(e), { tone: 'error', ms: 5000 }); }
    }
    sending = false; plus.classList.remove('is-busy');
    if (files.length) push(note({ files }));
  }
  function msgMenu(anchor, m) {
    const mine = !m.by || m.by === me?.id;
    menu(anchor, [
      m.text ? { label: 'Copy', icon: 'copy', onSelect: async () => { try { await navigator.clipboard.writeText(m.text); toast('Copied.', { ms: 1400 }); } catch {} } } : null,
      mine && m.text ? { label: 'Edit', icon: 'edit', onSelect: async () => { const t = await promptDialog('Edit message', { value: m.text, maxLength: 4000 }); if (t?.trim()) mutate((l) => l.map((y) => (y.id === m.id ? { ...y, text: t.trim(), edited: true } : y))).catch((e) => toast(friendlyError(e), { tone: 'error' })); } } : null,
      mine ? '-' : null,
      mine ? { label: 'Delete', icon: 'trash', danger: true, onSelect: () => mutate((l) => l.filter((y) => y.id !== m.id)).catch((e) => toast(friendlyError(e), { tone: 'error' })) } : null,
    ].filter(Boolean));
  }

  /* ---------------- switching, new, rename, delete ---------------- */
  async function pickMenu(anchor) {
    try { problems = await listProblems(); } catch {}
    if (closed) return;
    menu(anchor, [
      ...problems.map((p) => ({ label: (p.name || 'Problem').toUpperCase(), checked: cur?.id === p.id, onSelect: () => { if (cur?.id !== p.id) show(p); } })),
      problems.length ? '-' : null,
      { label: 'NEW PROBLEM', icon: 'plus', onSelect: () => newProblem() },
      cur ? '-' : null,
      cur ? { label: 'Rename this problem', icon: 'edit', onSelect: () => rename(cur) } : null,
      cur && (!cur.user_id || cur.user_id === me?.id) ? { label: 'Delete this problem', icon: 'trash', danger: true, onSelect: () => remove(cur) } : null,
    ].filter(Boolean), { class: 'er-menu' });
  }

  async function newProblem() {
    const name = await promptDialog('New problem', { value: '', ok: 'Open it', label: 'Name', maxLength: 60 });
    if (name?.trim()) create(name.trim());
  }

  async function create(name) {
    const id = uid(), cid = uid();
    try {
      await api.db.insert('blueprints', { id, name, kind: 'er', folder_id: null, pinned: false, data: { v: 1, elements: [] }, preview: [] });
      await api.db.insert('blueprints', { id: cid, name: id, kind: 'er-chat', folder_id: null, pinned: false, data: { v: 1, messages: [] }, preview: [] });
    } catch (e) { toast(friendlyError(e), { tone: 'error', ms: 5000 }); return; }
    shareWithSpace([id, cid], spaceId(), me);
    const row = { id, name, user_id: me?.id || null, created_at: new Date().toISOString() };
    problems = [...problems, row];
    show(row);
  }

  async function rename(p) {
    const name = await promptDialog('Rename problem', { value: p.name || '', ok: 'Save', label: 'Name', maxLength: 60 });
    if (!name?.trim() || name.trim() === p.name) return;
    try { await api.db.update('blueprints', p.id, { name: name.trim() }); }
    catch (e) { toast(friendlyError(e), { tone: 'error' }); return; }
    p.name = name.trim();
    if (cur?.id === p.id) nameEl.textContent = p.name.toUpperCase();
  }

  async function remove(p) {
    if (!(await confirmDialog(`Delete “${p.name}”?`, 'Its board and its chat go with it.', { ok: 'Delete' }))) return;
    try {
      const c = await chatRowOf(p.id).catch(() => null);
      await api.db.remove('blueprints', [p.id, ...(c ? [c.id] : [])]);
    } catch (e) { toast(friendlyError(e), { tone: 'error' }); return; }
    problems = problems.filter((x) => x.id !== p.id);
    store.set(LAST, null);
    const next = problems[problems.length - 1];
    if (next) show(next); else empty();
  }

  function grow(t) { t.style.height = 'auto'; t.style.height = `${Math.min(160, t.scrollHeight)}px`; }

  /* ---------------- out ---------------- */
  function close() {
    if (closed) return;
    closed = true;
    clearInterval(poll);
    stopMic(false);
    try { if (voice) window.speechSynthesis.cancel(); } catch {}
    escOff();
    combo.off();
    window.removeEventListener('keydown', onKey, true);
    closeFloating();
    node.classList.remove('in');
    node.classList.add('out');
    setTimeout(() => { unmountBoard(); node.remove(); setSurface(prevSurface && prevSurface !== SURFACE ? prevSurface : null); }, prefersReducedMotion?.() ? 0 : 260);
    onClose?.();
  }

  return { close, get open() { return !closed; } };
}
