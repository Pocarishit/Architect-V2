// Enter to talk (Nov 24) — press Enter anywhere in Architect (when you're not typing) and a small Voice Chat
// composer opens over whatever you're looking at: no Voice Chat object to open, nothing to leave.
//   · Type and press Enter: the message is read out loud (text-to-speech).
//   · Or hold the mic (or click it to start / stop) to send your actual voice.
// Where it goes: if a Variables chat is open — on the board or picked from the sidebar — that chat is the
// destination (the message lands in its conversation and is read aloud there). Otherwise it goes to the
// Space's Voice chat, as before.
import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { toast } from '../core/ui.js';
import { speak } from './chat.js';
import { canRecord, startRecording, uploadMedia } from './media.js';

/* ---------------- Variables chats announce themselves ---------------- */
const chats = new Set(); // { root, name(), send(text), sendFiles(files), last }
/** A Variables chat that's open on screen registers here; returns the unregister function. */
export function registerVarChat(c) {
  const entry = { last: Date.now(), ...c };
  chats.add(entry);
  const touch = () => { entry.last = Date.now(); };
  c.root.addEventListener('pointerdown', touch, true);
  c.root.addEventListener('focusin', touch);
  return () => { chats.delete(entry); c.root.removeEventListener('pointerdown', touch, true); c.root.removeEventListener('focusin', touch); };
}
const visible = (n) => n?.isConnected && n.getClientRects().length > 0 && getComputedStyle(n).visibility !== 'hidden';
function openVarChat() {
  return [...chats].filter((c) => visible(c.root) && (c.isOpen?.() ?? true)).sort((a, b) => b.last - a.last)[0] || null;
}

/* ---------------- the composer ---------------- */
let bar = null;

/**
 * Open the composer. voiceChat: the Space's Voice chat — { send(text, files) } or a function that makes one.
 */
export function openSayComposer({ voiceChat, host = document.body } = {}) {
  if (bar?.isConnected) { bar.querySelector('input')?.focus(); return; }
  const dest = () => {
    const v = openVarChat();
    if (v) return { kind: 'var', name: v.name?.() || 'this chat', v };
    return { kind: 'tts', name: 'Voice chat' };
  };
  let d = dest();
  const input = h('input', { class: 'say-input', maxlength: 2000, placeholder: `Say something to ${d.name}…`, 'aria-label': `Message to ${d.name}`, autocomplete: 'off' });
  const to = h('span', { class: 'say-to', title: d.kind === 'var' ? 'Goes to the open Variables chat' : 'Read out loud for everyone in the Space' }, d.kind === 'var' ? d.name.toUpperCase() : 'VOICE CHAT');
  const mic = h('button', { type: 'button', class: 'say-mic', 'aria-label': 'Record a voice message', title: 'Voice message — click to start, click again to send (Esc cancels)', hidden: !canRecord() }, icon('mic', 15));
  const send = h('button', { type: 'button', class: 'say-send', 'aria-label': 'Send', title: 'Send (Enter)' }, icon('send', 14));
  bar = h('div', { class: 'say-pop', role: 'dialog', 'aria-label': 'Say something' }, h('span', { class: 'say-ic' }, icon('speaker', 15)), to, input, mic, send);
  host.append(bar);
  requestAnimationFrame(() => bar?.classList.add('is-in'));
  input.focus();

  let rec = null, ticker = null;
  const close = () => { rec?.cancel(); rec = null; clearInterval(ticker); bar?.remove(); bar = null; window.removeEventListener('pointerdown', outside, true); };
  const outside = (e) => { if (bar && !bar.contains(e.target) && !rec) close(); };
  setTimeout(() => window.addEventListener('pointerdown', outside, true), 0);

  async function deliver({ text = '', files = null }) {
    d = dest();
    if (d.kind === 'var') {
      if (text) { d.v.send(text); speak({ id: `say-${Date.now()}`, text }, { force: true }); }
      if (files?.length) d.v.sendFiles(files);
      return;
    }
    const vc = typeof voiceChat === 'function' ? voiceChat() : voiceChat;
    if (!vc) { toast('There’s no Voice chat here yet.', { tone: 'error' }); return; }
    vc.send(text, files); // the Voice chat reads typed messages aloud for everyone
  }
  function submit() {
    const t = input.value.trim();
    if (!t) { close(); return; }
    input.value = '';
    deliver({ text: t });
    toast(`Said to ${dest().name}.`, { ms: 1200 });
  }
  async function toggleRec() {
    if (!rec) {
      try {
        rec = await startRecording({ onTick: (s) => { mic.dataset.t = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; } });
        bar.classList.add('is-rec'); mic.setAttribute('aria-label', 'Stop and send'); input.placeholder = 'Recording… click the mic to send, Esc to cancel';
      } catch { toast('The microphone isn’t available.', { tone: 'error' }); rec = null; }
      return;
    }
    const r = rec; rec = null;
    bar.classList.remove('is-rec'); delete mic.dataset.t;
    const got = await r.stop();
    if (!got) { close(); return; }
    bar.classList.add('is-busy');
    try {
      const up = await uploadMedia(got.file, { dur: got.dur });
      await deliver({ files: [{ kind: 'audio', path: up.path, name: up.name, dur: got.dur }] });
      toast(`Voice message sent to ${dest().name}.`, { ms: 1400 });
    } catch (e) { toast(e?.message || 'The voice message didn’t send.', { tone: 'error' }); }
    close();
  }
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submit(); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  bar.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } });
  mic.addEventListener('click', toggleRec);
  send.addEventListener('click', submit);
  input.addEventListener('blur', () => setTimeout(() => { if (bar && !rec && !bar.contains(document.activeElement) && !input.value.trim()) close(); }, 200));
}

/** Should this Enter open the composer? Not while typing, in a menu or dialog, or on something clickable. */
export function enterOpensComposer(e) {
  if (e.key !== 'Enter' || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.isComposing || e.repeat) return false;
  const t = e.target;
  if (t instanceof Element) {
    if (t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"], button, a[href], [role="button"], [role="menuitem"], [role="tab"], [role="checkbox"], [role="switch"], summary, iframe')) return false;
  }
  if (document.querySelector('.dlg-overlay, .menu, .popover, .er-room')) return false;
  return true;
}
