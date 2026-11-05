// Live collaboration for a Blueprint board: element edits, cursors, selections and typing,
// sent over a live channel (api.live). Edits are per element and last-write-wins; whoever made
// a change saves it to the database, everyone else just mirrors it.
import { h, s } from '../core/dom.js';
import { uid } from '../core/util.js';
import { rectOf, center } from './geometry.js';

const OPS_MS = 60;        // edits: ~16 per second while dragging
const CURSOR_MS = 70;     // cursor / selection updates
const TYPE_MS = 140;      // live typing preview
const IDLE_MS = 20_000;   // cursor fades after this long without moving
const MAX_BYTES = 150_000;

// Cursor colours: distinct enough to tell people apart, everything else stays monochrome.
const COLORS = ['#FF5A36', '#3D7BFF', '#16C47F', '#F5A623', '#A66CFF', '#00B4D8', '#FF4F9A', '#8BC34A'];
export function colorFor(id) {
  let h2 = 0;
  for (const ch of String(id)) h2 = (h2 * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h2 % COLORS.length];
}
export const initials = (name) => String(name || '?').trim().slice(0, 1).toUpperCase() || '?';

export function startCollab({ editor, boardId, me, live, onPeople, onStatus, onMeta, saveNow, loadFromDb }) {
  const clientId = uid();
  const color = colorFor(me.id);
  const peers = new Map(); // clientId → { key, uid, name, color, x, y, sel, editing, moved, cursor }
  let lastSent = new Map(editor.els.map((e) => [e.id, e]));
  let lastOrder = editor.els.map((e) => e.id);
  let synced = false;
  let syncTimer = null;
  let answerTimer = null;
  let status = 'connecting';
  const offs = [];

  /* ---------- layer for other people's cursors and selections ---------- */
  const layer = h('div', { class: 'bp-peers', 'aria-hidden': 'true' });
  editor.world.append(layer);

  const ch = live.join(`board:${boardId}`, {
    presenceKey: clientId,
    meta: { uid: me.id, name: me.username, color },
    onStatus: (st, detail) => { status = st; onStatus?.(st, detail); },
    onPresence,
    onMessage,
  });

  const send = (event, payload) => ch.send(event, { ...payload, from: clientId });

  /* ---------- outgoing edits ---------- */
  let opsTimer = null, lastFlush = 0;
  function queueOps() {
    if (opsTimer) return;
    opsTimer = setTimeout(flushOps, Math.max(0, OPS_MS - (performance.now() - lastFlush)));
  }

  function flushOps() {
    clearTimeout(opsTimer);
    opsTimer = null;
    lastFlush = performance.now();
    if (!ch.live) return; // stays pending; sent once the channel is back
    const els = editor.els;
    const ids = els.map((e) => e.id);
    const cur = new Set(ids);
    const up = els.filter((e) => lastSent.get(e.id) !== e);
    const del = [...lastSent.keys()].filter((id) => !cur.has(id));
    // Receivers append new items at the end, so only send the full order when it really changed.
    const expected = lastOrder.filter((id) => cur.has(id)).concat(ids.filter((id) => !lastSent.has(id)));
    const order = expected.length === ids.length && expected.every((id, i) => id === ids[i]) ? null : ids;
    if (!up.length && !del.length && !order) return;
    sendChunks('ops', { up, del, order });
    lastSent = new Map(els.map((e) => [e.id, e]));
    lastOrder = ids;
  }

  // Large pastes are split so each message stays under the channel's size limit.
  function sendChunks(event, { up, del, order }) {
    const size = JSON.stringify(up).length;
    if (size <= MAX_BYTES) { send(event, { up, del, order }); return; }
    let batch = [], bytes = 0;
    for (const e of up) {
      const n = JSON.stringify(e).length;
      if (batch.length && bytes + n > MAX_BYTES) { send(event, { up: batch, del: [], order: null }); batch = []; bytes = 0; }
      batch.push(e); bytes += n;
    }
    send(event, { up: batch, del, order });
  }

  offs.push(editor.on('change', (d) => { if (!d?.remote && !d?.silent) queueOps(); }));

  /* ---------- outgoing cursor, selection and typing ---------- */
  const mine = { x: null, y: null, sel: [], editing: null };
  let curTimer = null, lastCur = 0;
  function queueCursor() {
    if (curTimer) return;
    curTimer = setTimeout(() => {
      curTimer = null;
      lastCur = performance.now();
      if (ch.live) send('cur', mine);
    }, Math.max(0, CURSOR_MS - (performance.now() - lastCur)));
  }
  const onPtr = (e) => {
    if (e.pointerType === 'touch' && !editor.g) return;
    const p = editor.toWorld(e.clientX, e.clientY);
    mine.x = Math.round(p.x * 10) / 10;
    mine.y = Math.round(p.y * 10) / 10;
    queueCursor();
  };
  const onLeave = () => { mine.x = null; mine.y = null; queueCursor(); };
  editor.vp.addEventListener('pointermove', onPtr, { passive: true });
  editor.vp.addEventListener('pointerleave', onLeave);
  offs.push(() => { editor.vp.removeEventListener('pointermove', onPtr); editor.vp.removeEventListener('pointerleave', onLeave); });
  offs.push(editor.on('selection', () => {
    const sel = [...editor.sel];
    if (sel.join() === mine.sel.join() && mine.editing === editor.editingId) return;
    mine.sel = sel;
    mine.editing = editor.editingId || null;
    queueCursor();
  }));

  let typeTimer = null, pendingType = null;
  offs.push(editor.on('typing', (t) => {
    pendingType = t;
    if (typeTimer) return;
    typeTimer = setTimeout(() => { typeTimer = null; if (pendingType && ch.live) send('type', pendingType); pendingType = null; }, TYPE_MS);
  }));

  /* ---------- incoming ---------- */
  function onMessage(event, p) {
    if (event === '__joined') { joined(); return; }
    if (!p || p.from === clientId) return;
    if (event === 'ops') {
      editor.applyRemote(p);
      remember(p.up, p.del, p.order);
      paintPeers();
    } else if (event === 'cur') {
      const peer = peerFor(p.from);
      const moved = peer.x !== p.x || peer.y !== p.y;
      Object.assign(peer, { x: p.x, y: p.y, sel: p.sel || [], editing: p.editing || null });
      if (moved) peer.moved = Date.now();
      paintPeer(peer);
    } else if (event === 'type') {
      editor.showRemoteText(p.id, p);
    } else if (event === 'hello') {
      if (!synced) return; // only people with a settled board answer
      clearTimeout(answerTimer);
      answerTimer = setTimeout(() => answer(p.from), 40 + Math.random() * 260);
      queueCursor(); // let the newcomer see where you are
    } else if (event === 'state') {
      if (p.to !== clientId) { clearTimeout(answerTimer); return; } // someone else answered
      receiveState(p);
    } else if (event === 'meta') {
      onMeta?.(p);
    }
  }

  function remember(up = [], del = [], order = null) {
    // What we just applied is already everyone's state: never echo it back.
    for (const e of up || []) { const cur = editor.byId.get(e.id); if (cur) lastSent.set(e.id, cur); }
    for (const id of del || []) lastSent.delete(id);
    const ids = editor.els.map((e) => e.id);
    if (order || (up || []).some((e) => !lastOrder.includes(e.id))) lastOrder = ids;
    else lastOrder = lastOrder.filter((id) => editor.byId.has(id));
  }

  function joined() {
    flushOps(); // anything changed while offline goes out first
    synced = false;
    send('hello', {});
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => { synced = true; }, 1600); // nobody answered: you're the first one here
  }

  async function answer(to) {
    flushOps();
    const els = editor.els;
    if (JSON.stringify(els).length > MAX_BYTES) {
      // Too big for one message: save, then point them at the database copy.
      try { await saveNow(); } catch {}
      send('state', { to, db: true });
    } else send('state', { to, els });
  }

  async function receiveState(p) {
    clearTimeout(syncTimer);
    let els = p.els;
    if (p.db) { try { els = await loadFromDb(); } catch { els = null; } }
    if (Array.isArray(els)) {
      editor.applyRemote({ up: els }, { replaceAll: true });
      lastSent = new Map(editor.els.map((e) => [e.id, e]));
      lastOrder = editor.els.map((e) => e.id);
    }
    synced = true;
  }

  /* ---------- presence ---------- */
  function peerFor(key) {
    let p = peers.get(key);
    if (!p) { p = { key, uid: null, name: '…', color: '#888', x: null, y: null, sel: [], editing: null, moved: 0 }; peers.set(key, p); }
    return p;
  }

  function onPresence(list) {
    const keys = new Set();
    for (const m of list) {
      if (!m.key || m.key === clientId) continue;
      keys.add(m.key);
      const p = peerFor(m.key);
      p.uid = m.uid; p.name = m.name || 'Someone'; p.color = m.color || colorFor(m.uid || m.key);
    }
    for (const [k, p] of peers) if (!keys.has(k)) { p.cursor?.remove(); p.box?.remove(); peers.delete(k); }
    paintPeers();
    emitPeople();
  }

  function emitPeople() {
    // One avatar per person, even with several tabs open.
    const byUser = new Map();
    for (const p of peers.values()) if (!byUser.has(p.uid || p.key)) byUser.set(p.uid || p.key, p);
    onPeople?.([{ key: clientId, uid: me.id, name: me.username, color, self: true }, ...[...byUser.values()].filter((p) => p.uid !== me.id)]);
  }

  /* ---------- drawing peers ---------- */
  function paintPeer(p) {
    if (!p.cursor) {
      p.cursor = h('div', { class: 'rc' },
        s('svg', { class: 'rc-arrow', viewBox: '0 0 16 16', width: 16, height: 16 }, s('path', { d: 'M1.5 1.5 14 7.2 8.1 8.6 5.6 14.2z' })),
        h('span', { class: 'rc-name' }));
      p.box = h('div', { class: 'rc-sels' });
      layer.append(p.box, p.cursor);
    }
    p.cursor.style.setProperty('--c', p.color);
    p.box.style.setProperty('--c', p.color);
    const label = p.cursor.lastChild;
    const text = p.editing ? `${p.name} · typing` : p.name;
    if (label.textContent !== text) label.textContent = text;
    const show = p.x != null && p.y != null;
    p.cursor.hidden = !show;
    if (show) { p.cursor.style.left = `${p.x}px`; p.cursor.style.top = `${p.y}px`; }
    p.cursor.classList.toggle('is-idle', Date.now() - p.moved > IDLE_MS);
    // Their selection, outlined in their colour.
    p.box.replaceChildren(...(p.sel || []).map((id) => {
      const el = editor.byId.get(id);
      if (!el) return null;
      const r = rectOf(el, editor.byId);
      return h('div', { class: ['rc-sel', p.editing === id && 'is-typing'], style: { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` } });
    }).filter(Boolean));
  }
  function paintPeers() { for (const p of peers.values()) paintPeer(p); }
  offs.push(editor.on('change', () => { if (peers.size) paintPeers(); }));
  const idleTick = setInterval(() => { for (const p of peers.values()) p.cursor?.classList.toggle('is-idle', Date.now() - p.moved > IDLE_MS); }, 5000);

  return {
    clientId,
    color,
    get status() { return status; },
    // Jump the view to where someone is working.
    follow(key) {
      const p = [...peers.values()].find((x) => x.key === key || x.uid === key);
      if (!p) return false;
      let target = null;
      const sel = (p.sel || []).map((id) => editor.byId.get(id)).filter(Boolean);
      if (sel.length) target = center(rectOf(sel[0], editor.byId));
      else if (p.x != null) target = { x: p.x, y: p.y };
      if (!target) return false;
      const r = editor.rect();
      editor.setCamera({ x: r.width / 2 - target.x * editor.cam.z, y: r.height / 2 - target.y * editor.cam.z, z: editor.cam.z }, { animate: true });
      return true;
    },
    sendMeta(m) { if (ch.live) send('meta', m); },
    stop() {
      flushOps();
      clearTimeout(opsTimer); clearTimeout(curTimer); clearTimeout(typeTimer);
      clearTimeout(syncTimer); clearTimeout(answerTimer); clearInterval(idleTick);
      offs.forEach((f) => { try { f(); } catch {} });
      ch.leave();
      layer.remove();
    },
  };
}
