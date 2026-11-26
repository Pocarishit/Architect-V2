// ARCHITECT SPACE — live tools in the top bar (Nov 27, "Architect SYSTEM Updates").
//   · Reactions + Timer: one popover. A reaction pops up next to your cursor for everyone on the board, then
//     fades (nothing is left behind). The countdown is shared: set, start, pause, reset — everyone sees the same
//     time, popover open or not.
//   · Camera menu: Record Talktrack (a recorded, replayable walkthrough) and Start a Call (live video) are two
//     separate actions. Recording never starts a call; a call never records.
//   · Present Board: present the board itself — one continuous canvas, no slides. Viewers follow your pan and
//     zoom. It doesn't start or end a call or a recording.
// Everything travels on the board's live channel (collab.x); nothing here is saved on the board except a
// finished Talktrack, which is added to the board as a video.
import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { menu, popover, toast, dialog, closeFloating } from '../core/ui.js';
import { uid, store } from '../core/util.js';
import { serverNow, syncClock } from '../data/clock.js';

const svgIcon = (inner, size = 18) => {
  const sv = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  sv.setAttribute('viewBox', '0 0 24 24'); sv.setAttribute('width', size); sv.setAttribute('height', size);
  sv.setAttribute('fill', 'none'); sv.setAttribute('stroke', 'currentColor'); sv.setAttribute('stroke-width', '1.6');
  sv.setAttribute('stroke-linecap', 'round'); sv.setAttribute('stroke-linejoin', 'round'); sv.setAttribute('aria-hidden', 'true');
  sv.classList.add('ic');
  sv.innerHTML = inner;
  return sv;
};
// A stopwatch with a raised hand beside it (no confetti); a rounded video camera; a monitor outline, no stand.
const IC = {
  stopwatch: '<circle cx="9.5" cy="13.5" r="6.2"/><path d="M9.5 13.5V10.4M8 3.8h3M9.5 3.8v3.5M14.2 8.6l1.1-1.1"/><path d="M17.2 20.5v-6.2a1 1 0 0 1 2 0v-2.6a1 1 0 0 1 2 0v6.9a3.6 3.6 0 0 1-3.6 3.6h-.6a3 3 0 0 1-2.4-1.2l-1.8-2.4a1 1 0 0 1 1.6-1.2l1.8 2.1"/>',
  camera: '<rect x="3" y="6.5" width="12.5" height="11" rx="3.2"/><path d="M15.5 10.4 20.2 8v8l-4.7-2.4"/>',
  monitor: '<rect x="3" y="4.5" width="18" height="13" rx="2.2"/>',
};
const REACTIONS = ['👍', '❤️', '😂', '🎉', '👏', '🔥', '😮', '✅'];
const STUN = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];

export function mountLive({ editor, page, getCollab, me, boardId, menuItems, onInvite, addFiles }) {
  const offs = [];
  const col = () => getCollab?.() || null;
  const send = (kind, data) => col()?.x(kind, data);
  const myId = () => col()?.clientId || null;
  syncClock();

  /* ---------------- world layer (reactions, attached call tiles) ---------------- */
  const layer = h('div', { class: 'lv-layer', 'aria-hidden': 'true' });
  editor.world.append(layer);
  offs.push(() => layer.remove());
  let lastWorld = null;
  const onMove = (e) => { const r = editor.vp.getBoundingClientRect(); if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) lastWorld = editor.toWorld(e.clientX, e.clientY); };
  window.addEventListener('pointermove', onMove, { passive: true });
  offs.push(() => window.removeEventListener('pointermove', onMove));

  /* ---------------- reactions ---------------- */
  function popReaction(emoji, at, name) {
    if (!at) return;
    const n = h('div', { class: 'lv-react', style: { left: `${at.x + 18}px`, top: `${at.y - 6}px` } }, h('span', { class: 'lv-react-e' }, emoji), name ? h('small', {}, name) : null);
    layer.append(n);
    setTimeout(() => n.remove(), 2600);
  }
  function react(emoji) {
    const at = lastWorld || editor.viewCenter();
    popReaction(emoji, at, null);
    send('react', { emoji, x: Math.round(at.x), y: Math.round(at.y) });
  }

  /* ---------------- the shared timer ---------------- */
  // state: { id, dur, endsAt (server ms) | null, left (ms, while paused), by }
  let timer = store.get(`architect.lv.timer.${boardId || 'b'}`, null);
  const chip = h('button', { type: 'button', class: 'lv-timer-chip', hidden: true, 'aria-live': 'polite', onclick: (e) => openReactTimer(e.currentTarget) });
  page.append(chip);
  offs.push(() => chip.remove());
  const leftNow = () => (!timer ? 0 : timer.endsAt ? Math.max(0, timer.endsAt - serverNow()) : timer.left ?? timer.dur);
  const fmt = (ms) => { const t = Math.ceil(ms / 1000); const m = Math.floor(t / 60), s2 = t % 60; return `${m}:${String(s2).padStart(2, '0')}`; };
  let doneAt = 0;
  function paintChip() {
    if (!timer) { chip.hidden = true; return; }
    const ms = leftNow();
    const running = !!timer.endsAt;
    if (running && ms <= 0 && !doneAt) { doneAt = Date.now(); navigator.vibrate?.(30); }
    if (doneAt && Date.now() - doneAt > 8000 && running && ms <= 0) { timer = null; doneAt = 0; saveTimer(); chip.hidden = true; return; }
    chip.hidden = false;
    chip.classList.toggle('is-paused', !running);
    chip.classList.toggle('is-done', running && ms <= 0);
    chip.replaceChildren(svgIcon(IC.stopwatch, 14), h('b', {}, running && ms <= 0 ? 'Time’s up' : fmt(ms)));
    chip.setAttribute('aria-label', `Shared timer: ${running && ms <= 0 ? 'time is up' : fmt(ms)}${running ? '' : ', paused'}`);
    timerUi?.paint();
  }
  const tick = setInterval(paintChip, 250);
  offs.push(() => clearInterval(tick));
  const saveTimer = () => store.set(`architect.lv.timer.${boardId || 'b'}`, timer);
  function setTimer(next, broadcast = true) {
    timer = next; doneAt = 0; saveTimer(); paintChip();
    if (broadcast) send('timer', { t: timer });
  }
  const timerStart = (dur) => setTimer({ id: uid(), dur, endsAt: serverNow() + (timer && !timer.endsAt && timer.left != null && timer.dur === dur ? timer.left : dur), left: null, by: me.username });
  const timerPause = () => { if (timer?.endsAt) setTimer({ ...timer, left: leftNow(), endsAt: null }); };
  const timerReset = () => setTimer(timer ? { ...timer, endsAt: null, left: timer.dur } : null);
  const timerClear = () => setTimer(null);

  let timerUi = null;
  function openReactTimer(anchor) {
    const dur0 = timer?.dur || store.get('architect.lv.dur', 5 * 60_000);
    const mm = h('input', { class: 'input sm lv-num', type: 'number', min: 0, max: 600, value: Math.floor(dur0 / 60_000), 'aria-label': 'Minutes' });
    const ss = h('input', { class: 'input sm lv-num', type: 'number', min: 0, max: 59, value: Math.floor((dur0 % 60_000) / 1000), 'aria-label': 'Seconds' });
    const readDur = () => Math.max(1000, ((Number(mm.value) || 0) * 60 + (Number(ss.value) || 0)) * 1000);
    const big = h('div', { class: 'lv-big' });
    const ctl = h('div', { class: 'lv-ctl' });
    timerUi = {
      shown: false,
      paint() {
        if (big.isConnected) this.shown = true;
        else if (this.shown) { timerUi = null; return; }
        const running = !!timer?.endsAt;
        big.textContent = timer ? fmt(leftNow()) : fmt(readDur());
        ctl.replaceChildren(
          running
            ? h('button', { type: 'button', class: 'btn sm', onclick: timerPause }, icon('pause', 13), 'Pause')
            : h('button', { type: 'button', class: 'btn btn-primary sm', onclick: () => { const d = readDur(); store.set('architect.lv.dur', d); if (timer && !timer.endsAt && timer.dur !== d) timer = null; timerStart(d); } }, icon('play', 13), timer && !timer.endsAt && timer.left != null && timer.left < timer.dur ? 'Resume' : 'Start'),
          h('button', { type: 'button', class: 'btn sm', disabled: !timer, onclick: timerReset }, icon('undo', 13), 'Reset'),
          timer ? h('button', { type: 'button', class: 'btn sm', onclick: timerClear }, icon('close', 13), 'Clear') : null);
        mm.disabled = ss.disabled = running;
      },
    };
    const onIn = () => timerUi?.paint();
    mm.addEventListener('input', onIn); ss.addEventListener('input', onIn);
    const body = h('div', { class: 'lv-pop' },
      h('div', { class: 'lv-pop-label' }, 'React'),
      h('div', { class: 'lv-reacts' }, REACTIONS.map((e) => h('button', { type: 'button', class: 'lv-r', 'aria-label': `React ${e}`, onclick: () => react(e) }, e))),
      h('div', { class: 'lv-sep' }),
      h('div', { class: 'lv-pop-label' }, 'Shared timer — everyone sees it'),
      big,
      h('div', { class: 'lv-set' }, mm, h('span', {}, 'min'), ss, h('span', {}, 'sec')),
      ctl);
    timerUi.paint();
    popover(anchor, body, { align: 'end', class: 'lv-popover' });
  }

  /* ---------------- Present Board ---------------- */
  let presenting = false, presenter = null, following = true, camT = 0, beat = 0;
  const presBar = h('div', { class: 'lv-presbar', hidden: true });
  page.append(presBar);
  offs.push(() => presBar.remove());
  const camNow = () => { const c = editor.viewCenter(); return { cx: Math.round(c.x), cy: Math.round(c.y), z: +editor.cam.z.toFixed(4) }; };
  function goCam(p) {
    const r = editor.rect();
    editor.setCamera({ x: r.width / 2 - p.cx * p.z, y: r.height / 2 - p.cy * p.z, z: p.z }, { animate: false });
  }
  function paintPres() {
    if (presenting) {
      presBar.hidden = false;
      presBar.replaceChildren(h('span', { class: 'lv-dot' }), h('span', {}, 'Presenting the board — everyone follows your view'), h('button', { type: 'button', class: 'btn sm', onclick: () => stopPresenting() }, 'Stop presenting'));
    } else if (presenter) {
      presBar.hidden = false;
      presBar.replaceChildren(h('span', { class: 'lv-dot' }), h('span', {}, `${presenter.name} is presenting`),
        h('button', { type: 'button', class: 'btn sm', onclick: () => { following = !following; paintPres(); if (following && presenter.cam) goCam(presenter.cam); } }, following ? 'Stop following' : 'Follow'));
    } else { presBar.hidden = true; presBar.replaceChildren(); }
    page.classList.toggle('is-presenting-board', presenting || !!presenter);
  }
  function startPresenting() {
    if (presenting) return;
    presenting = true; presenter = null;
    send('present', { on: true, name: me.username, cam: camNow() });
    beat = setInterval(() => send('present-cam', { cam: camNow(), name: me.username }), 2000);
    paintPres();
    toast('Presenting the board — pan and zoom, everyone follows.', { ms: 2400 });
  }
  function stopPresenting() {
    if (!presenting) return;
    presenting = false; clearInterval(beat);
    send('present', { on: false });
    paintPres();
  }
  offs.push(editor.on('camera', () => {
    if (!presenting || camT) return;
    camT = setTimeout(() => { camT = 0; send('present-cam', { cam: camNow(), name: me.username }); }, 90);
  }));
  offs.push(() => { if (presenting) stopPresenting(); clearInterval(beat); });

  /* ---------------- Talktrack: a recorded walkthrough ---------------- */
  let rec = null; // { streams, recorder, chunks, startedAt, pausedMs, pauseAt, bubble, strip }
  async function devices() {
    try {
      const tmp = await navigator.mediaDevices.getUserMedia({ audio: true, video: true }).catch(() => navigator.mediaDevices.getUserMedia({ audio: true }));
      tmp.getTracks().forEach((t) => t.stop());
    } catch {}
    const list = await navigator.mediaDevices.enumerateDevices().catch(() => []);
    return { mics: list.filter((d) => d.kind === 'audioinput'), cams: list.filter((d) => d.kind === 'videoinput') };
  }
  async function openTalktrack() {
    if (rec) { toast('A Talktrack is already recording.', { ms: 1800 }); return; }
    if (!navigator.mediaDevices?.getUserMedia) { toast('This browser can’t record.', { tone: 'error' }); return; }
    const what = h('div', { class: 'lv-what', role: 'radiogroup', 'aria-label': 'What to record' });
    let pick = store.get('architect.tt.what', 'tab');
    const opts = [['tab', 'Current tab'], ['window', 'Window'], ['screen', 'Full screen'], ['camera', 'Camera only']];
    const paintWhat = () => what.replaceChildren(...opts.map(([k, l]) => h('button', { type: 'button', role: 'radio', class: ['lv-what-opt', pick === k && 'is-on'], 'aria-checked': String(pick === k), onclick: () => { pick = k; paintWhat(); } }, l)));
    paintWhat();
    const mic = h('select', { class: 'input sm', 'aria-label': 'Microphone' }, h('option', { value: '' }, 'Loading…'));
    const cam = h('select', { class: 'input sm', 'aria-label': 'Camera' }, h('option', { value: '' }, 'Loading…'));
    devices().then(({ mics, cams }) => {
      mic.replaceChildren(h('option', { value: 'off' }, 'No microphone'), ...mics.map((d, i) => h('option', { value: d.deviceId }, d.label || `Microphone ${i + 1}`)));
      cam.replaceChildren(h('option', { value: 'off' }, 'No camera'), ...cams.map((d, i) => h('option', { value: d.deviceId }, d.label || `Camera ${i + 1}`)));
      mic.value = store.get('architect.tt.mic', mics[0]?.deviceId || 'off'); if (!mic.value) mic.value = mics[0]?.deviceId || 'off';
      cam.value = store.get('architect.tt.cam', cams[0]?.deviceId || 'off'); if (!cam.value) cam.value = cams[0]?.deviceId || 'off';
    });
    const ok = await dialog({
      title: 'Record Talktrack', className: 'lv-dlg', width: 440,
      body: h('div', { class: 'stack' },
        h('div', { class: 'lv-pop-label' }, 'What to record'), what,
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Microphone'), mic),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Camera'), cam)),
      actions: [{ label: 'Cancel', value: false }, { label: 'Start recording', primary: true, value: true }],
    });
    if (!ok) return;
    store.set('architect.tt.what', pick); store.set('architect.tt.mic', mic.value); store.set('architect.tt.cam', cam.value);
    startRecording({ what: pick, micId: mic.value, camId: cam.value }).catch((e) => toast(`Recording didn’t start — ${e?.message || e}`, { tone: 'error', ms: 5000 }));
  }
  async function startRecording({ what, micId, camId }) {
    const streams = [];
    const micS = micId !== 'off' ? await navigator.mediaDevices.getUserMedia({ audio: micId ? { deviceId: { exact: micId } } : true }).catch(() => null) : null;
    if (micS) streams.push(micS);
    const camS = camId !== 'off' ? await navigator.mediaDevices.getUserMedia({ video: camId ? { deviceId: { exact: camId }, width: 640, height: 640 } : true }).catch(() => null) : null;
    if (camS) streams.push(camS);
    let video = null;
    if (what === 'camera') {
      if (!camS) throw new Error('no camera');
      video = camS.getVideoTracks();
    } else {
      const surface = { tab: 'browser', window: 'window', screen: 'monitor' }[what];
      const disp = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: surface, frameRate: 30 }, audio: false, preferCurrentTab: what === 'tab', selfBrowserSurface: 'include', surfaceSwitching: 'exclude' });
      streams.push(disp);
      video = disp.getVideoTracks();
      video[0].addEventListener('ended', () => { if (rec) stopRecording(true); });
    }
    const mixed = new MediaStream([...video, ...(micS ? micS.getAudioTracks() : [])]);
    rec = { streams, mixed, chunks: [], recorder: null, startedAt: 0, pausedMs: 0, pauseAt: 0, cam: camS, what };
    mountBubble(camS);
    mountStrip();
    begin();
  }
  function begin() {
    const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'].find((m) => window.MediaRecorder?.isTypeSupported?.(m)) || '';
    rec.chunks = [];
    rec.recorder = new MediaRecorder(rec.mixed, mime ? { mimeType: mime } : undefined);
    rec.mime = rec.recorder.mimeType || mime || 'video/webm';
    rec.recorder.ondataavailable = (e) => { if (e.data?.size) rec?.chunks.push(e.data); };
    rec.recorder.start(1000);
    rec.startedAt = Date.now(); rec.pausedMs = 0; rec.pauseAt = 0;
    paintStrip();
  }
  const elapsed = () => (!rec ? 0 : (rec.pauseAt || Date.now()) - rec.startedAt - rec.pausedMs);
  function mountBubble(camS) {
    if (!camS) return;
    const v = h('video', { autoplay: true, muted: true, playsinline: true });
    v.srcObject = camS;
    const ctl = h('div', { class: 'lv-bubble-ctl' },
      h('button', { type: 'button', class: 'lv-bbtn', 'aria-label': 'Smaller', title: 'Smaller', onclick: () => size(-1) }, icon('minus', 13)),
      h('button', { type: 'button', class: 'lv-bbtn', 'aria-label': 'Larger', title: 'Larger', onclick: () => size(1) }, icon('plus', 13)),
      h('button', { type: 'button', class: 'lv-bbtn', 'aria-label': 'Hide camera', title: 'Hide camera', onclick: () => { b.hidden = true; toast('Camera hidden — the recording carries on.', { ms: 1800 }); } }, icon('eyeOff', 13)));
    const b = h('div', { class: 'lv-bubble', style: { '--s': `${store.get('architect.tt.size', 168)}px` } }, h('div', { class: 'lv-bubble-face' }, v), ctl);
    const size = (d) => { const s0 = Math.min(320, Math.max(96, (parseInt(b.style.getPropertyValue('--s'), 10) || 168) + d * 28)); b.style.setProperty('--s', `${s0}px`); store.set('architect.tt.size', s0); };
    // drag it anywhere (the circle stays put when the controls appear)
    b.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      const r = b.getBoundingClientRect(); const dx = e.clientX - r.left, dy = e.clientY - r.top;
      b.setPointerCapture(e.pointerId);
      const mv = (ev) => { b.style.left = `${Math.max(0, Math.min(innerWidth - r.width, ev.clientX - dx))}px`; b.style.top = `${Math.max(0, Math.min(innerHeight - r.height, ev.clientY - dy))}px`; b.style.right = 'auto'; b.style.bottom = 'auto'; };
      const up = () => { b.removeEventListener('pointermove', mv); b.removeEventListener('pointerup', up); };
      b.addEventListener('pointermove', mv); b.addEventListener('pointerup', up);
    });
    document.body.append(b);
    rec.bubble = b;
  }
  let stripT = 0;
  function mountStrip() {
    rec.strip = h('div', { class: 'lv-strip', role: 'toolbar', 'aria-label': 'Talktrack recording' });
    document.body.append(rec.strip);
    stripT = setInterval(paintStrip, 500);
  }
  function paintStrip() {
    if (!rec?.strip) return;
    const paused = rec.recorder?.state === 'paused';
    const t = Math.floor(elapsed() / 1000);
    rec.strip.replaceChildren(
      h('span', { class: ['lv-recdot', paused && 'is-paused'] }),
      h('b', { class: 'lv-elapsed' }, `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`),
      h('button', { type: 'button', class: 'lv-sbtn', 'aria-label': paused ? 'Resume' : 'Pause', title: paused ? 'Resume' : 'Pause', onclick: () => { if (paused) { rec.recorder.resume(); rec.pausedMs += Date.now() - rec.pauseAt; rec.pauseAt = 0; } else { rec.recorder.pause(); rec.pauseAt = Date.now(); } paintStrip(); } }, icon(paused ? 'play' : 'pause', 14)),
      h('button', { type: 'button', class: 'lv-sbtn', 'aria-label': 'Stop and save', title: 'Stop and save', onclick: () => stopRecording(true) }, h('i', { class: 'lv-stopsq' })),
      h('button', { type: 'button', class: 'lv-sbtn', 'aria-label': 'Restart', title: 'Restart', onclick: () => { try { rec.recorder.onstop = null; rec.recorder.stop(); } catch {} begin(); } }, icon('undo', 14)),
      h('button', { type: 'button', class: 'lv-sbtn is-danger', 'aria-label': 'Discard', title: 'Discard', onclick: () => stopRecording(false) }, icon('trash', 14)));
  }
  function stopRecording(keep) {
    if (!rec) return;
    const r = rec; rec = null;
    clearInterval(stripT);
    const finish = () => {
      r.streams.forEach((s0) => s0.getTracks().forEach((t) => t.stop()));
      r.bubble?.remove(); r.strip?.remove();
      if (!keep) { toast('Talktrack discarded.', { ms: 1600 }); return; }
      const blob = new Blob(r.chunks, { type: r.mime });
      if (!blob.size) { toast('Nothing was recorded.', { tone: 'error' }); return; }
      const ext = /mp4/.test(r.mime) ? 'mp4' : 'webm';
      const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '.');
      const file = new File([blob], `Talktrack ${stamp}.${ext}`, { type: r.mime.split(';')[0] });
      Promise.resolve(addFiles?.([file], editor.viewCenter())).then(() => toast('Talktrack added to the board — play it any time.', { ms: 2600 })).catch(() => {});
    };
    try {
      if (r.recorder && r.recorder.state !== 'inactive') { r.recorder.onstop = finish; r.recorder.stop(); } else finish();
    } catch { finish(); }
  }
  offs.push(() => { if (rec) stopRecording(false); });

  /* ---------------- calls: live video (mesh, on the board's channel) ---------------- */
  let call = null;      // a call I'm in: { id, mode, corner, at, local, pcs: Map(clientId → { pc, stream, name }), mic, cam }
  const known = new Map(); // calls on this board: id → { id, mode, at, host, members:Set }
  let dock = null, tileHost = null;
  function callTile(c) {
    // A joinable tile on the board (Attach to Space), anchored in board coordinates.
    let n = layer.querySelector(`.lv-calltile[data-call="${CSS.escape(c.id)}"]`);
    if (!n) { n = h('div', { class: 'lv-calltile', 'data-call': c.id }); layer.append(n); }
    n.style.left = `${c.at.x}px`; n.style.top = `${c.at.y}px`;
    return n;
  }
  function paintCalls() {
    for (const n of layer.querySelectorAll('.lv-calltile')) if (!known.has(n.dataset.call)) n.remove();
    for (const c of known.values()) {
      if (c.mode !== 'attach') continue;
      const n = callTile(c);
      if (call?.id === c.id) { n.replaceChildren(videoGrid(), callCtl()); continue; }
      n.replaceChildren(h('div', { class: 'lv-call-idle' }, svgIcon(IC.camera, 20), h('span', {}, `${c.host || 'Someone'}’s call`), h('button', { type: 'button', class: 'btn btn-primary sm', onclick: () => joinCall(c) }, 'Join')));
    }
    dock?.remove(); dock = null;
    if (call?.mode === 'dock') {
      dock = h('div', { class: ['lv-dock', `is-${call.corner}`] }, videoGrid(), callCtl());
      document.body.append(dock);
    }
    const joinable = [...known.values()].filter((c) => c.mode === 'dock' && call?.id !== c.id);
    let pill = page.querySelector('.lv-joinpill');
    if (joinable.length && !call) {
      if (!pill) { pill = h('div', { class: 'lv-joinpill' }); page.append(pill); }
      const c = joinable[0];
      pill.replaceChildren(svgIcon(IC.camera, 16), h('span', {}, `${c.host || 'Someone'} started a call`), h('button', { type: 'button', class: 'btn btn-primary sm', onclick: () => joinCall(c) }, 'Join'));
    } else pill?.remove();
  }
  function videoGrid() {
    const tile = (stream, name, mine) => {
      const v = h('video', { autoplay: true, playsinline: true, muted: !!mine });
      v.srcObject = stream;
      return h('div', { class: ['lv-vid', mine && 'is-me'] }, v, h('span', { class: 'lv-vname' }, mine ? 'You' : name || 'Guest'));
    };
    const tiles = [tile(call.local, me.username, true), ...[...call.pcs.values()].filter((x) => x.stream).map((x) => tile(x.stream, x.name, false))];
    return h('div', { class: ['lv-grid', `n${Math.min(tiles.length, 4)}`] }, ...tiles);
  }
  function callCtl() {
    const a = call.local.getAudioTracks()[0], v = call.local.getVideoTracks()[0];
    return h('div', { class: 'lv-callctl' },
      h('button', { type: 'button', class: ['lv-sbtn', a && !a.enabled && 'is-off'], 'aria-label': a?.enabled ? 'Mute microphone' : 'Unmute microphone', title: 'Microphone', onclick: () => { if (a) a.enabled = !a.enabled; paintCalls(); } }, icon(a?.enabled ? 'mic' : 'micOff', 14)),
      h('button', { type: 'button', class: ['lv-sbtn', v && !v.enabled && 'is-off'], 'aria-label': v?.enabled ? 'Turn camera off' : 'Turn camera on', title: 'Camera', onclick: () => { if (v) v.enabled = !v.enabled; paintCalls(); } }, svgIcon(IC.camera, 14)),
      call.mode === 'dock' ? h('button', { type: 'button', class: 'lv-sbtn', 'aria-label': 'Move to the other corner', title: 'Other corner', onclick: () => { call.corner = call.corner === 'left' ? 'right' : 'left'; store.set('architect.call.corner', call.corner); paintCalls(); } }, icon('collapse', 14)) : null,
      h('button', { type: 'button', class: 'lv-sbtn is-danger', 'aria-label': 'Leave the call', title: 'Leave', onclick: () => leaveCall() }, icon('close', 14)),
      call.host === me.username ? h('button', { type: 'button', class: 'btn sm lv-end', onclick: () => endCall() }, 'End for all') : null);
  }
  async function askMode() {
    return dialog({
      title: 'Start a call', width: 420,
      body: h('div', { class: 'stack' },
        h('p', { class: 'dlg-text' }, 'Attach to Space puts a joinable video tile on the shared board: it moves with the board and disappears for everyone when the call ends. Dock on Screen keeps the video in a corner of your screen, with nothing added to the board.')),
      actions: [{ label: 'Cancel', value: null }, { label: 'Dock on Screen', value: 'dock' }, { label: 'Attach to Space', primary: true, value: 'attach' }],
    });
  }
  async function localStream() {
    return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: { width: 480, height: 360 } })
      .catch(() => navigator.mediaDevices.getUserMedia({ audio: true }));
  }
  async function startCall() {
    if (call) { toast('You’re already in a call.', { ms: 1600 }); return; }
    if (!col()?.live) { toast('Calls need the live connection — it isn’t connected right now.', { tone: 'error', ms: 3600 }); return; }
    const mode = await askMode();
    if (!mode) return;
    let local;
    try { local = await localStream(); } catch (e) { toast(`Camera and microphone are blocked — ${e?.message || e}`, { tone: 'error', ms: 4000 }); return; }
    const c = { id: uid(), mode, at: (() => { const p = editor.viewCenter(); return { x: Math.round(p.x), y: Math.round(p.y) }; })(), host: me.username, members: new Set() };
    known.set(c.id, c);
    call = { ...c, local, pcs: new Map(), corner: store.get('architect.call.corner', 'right') };
    send('call', { op: 'start', call: { id: c.id, mode, at: c.at, host: c.host } });
    paintCalls();
  }
  async function joinCall(c) {
    if (call) return;
    let local;
    try { local = await localStream(); } catch (e) { toast(`Camera and microphone are blocked — ${e?.message || e}`, { tone: 'error', ms: 4000 }); return; }
    call = { ...c, local, pcs: new Map(), corner: store.get('architect.call.corner', 'right') };
    send('call', { op: 'join', id: c.id, name: me.username });
    paintCalls();
  }
  function pcFor(peerId, name) {
    let x = call.pcs.get(peerId);
    if (x) return x;
    const pc = new RTCPeerConnection({ iceServers: STUN });
    x = { pc, stream: null, name };
    call.pcs.set(peerId, x);
    call.local.getTracks().forEach((t) => pc.addTrack(t, call.local));
    pc.onicecandidate = (e) => { if (e.candidate) send('call', { op: 'ice', id: call.id, to: peerId, cand: e.candidate.toJSON() }); };
    pc.ontrack = (e) => { x.stream = e.streams[0]; paintCalls(); };
    pc.onconnectionstatechange = () => { if (['failed', 'closed'].includes(pc.connectionState)) { call?.pcs.delete(peerId); paintCalls(); } };
    return x;
  }
  function leaveCall(silent = false) {
    if (!call) return;
    const c = call; call = null;
    for (const x of c.pcs.values()) { try { x.pc.close(); } catch {} }
    c.local.getTracks().forEach((t) => t.stop());
    if (!silent) send('call', { op: 'leave', id: c.id });
    const k = known.get(c.id);
    if (k && c.host === me.username && !c.pcs.size) { known.delete(c.id); send('call', { op: 'end', id: c.id }); }
    paintCalls();
  }
  function endCall() {
    if (!call) return;
    const id = call.id;
    send('call', { op: 'end', id });
    leaveCall(true);
    known.delete(id);
    paintCalls();
  }
  offs.push(() => { if (call) leaveCall(); dock?.remove(); page.querySelector('.lv-joinpill')?.remove(); });

  /* ---------------- incoming ---------------- */
  offs.push(editor.on('collab-x', async (p) => {
    if (p.to && p.to !== myId()) return;
    if (p.kind === 'react') { popReaction(p.emoji, { x: p.x, y: p.y }, p.peer?.name || null); return; }
    if (p.kind === 'timer') { timer = p.t || null; doneAt = 0; saveTimer(); paintChip(); return; }
    if (p.kind === 'present') {
      if (p.on) { if (presenting) stopPresenting(); presenter = { from: p.from, name: p.name || 'Someone', cam: p.cam }; following = true; if (p.cam) goCam(p.cam); }
      else if (presenter?.from === p.from) presenter = null;
      paintPres(); return;
    }
    if (p.kind === 'present-cam') {
      if (!presenter || presenter.from !== p.from) { presenter = { from: p.from, name: p.name || 'Someone', cam: p.cam }; following = true; paintPres(); }
      presenter.cam = p.cam;
      if (following && p.cam) goCam(p.cam);
      return;
    }
    if (p.kind === 'call') {
      if (p.op === 'start') { known.set(p.call.id, { ...p.call, members: new Set([p.from]) }); paintCalls(); return; }
      if (p.op === 'end') { if (call?.id === p.id) { leaveCall(true); toast('The call ended.', { ms: 1600 }); } known.delete(p.id); paintCalls(); return; }
      if (!call || p.id !== call.id) { if (p.op === 'join' && known.has(p.id)) known.get(p.id).members.add(p.from); return; }
      if (p.op === 'join') {
        // Everyone already in the call calls the newcomer.
        const x = pcFor(p.from, p.name);
        const offer = await x.pc.createOffer();
        await x.pc.setLocalDescription(offer);
        send('call', { op: 'offer', id: call.id, to: p.from, sdp: x.pc.localDescription.toJSON(), name: me.username });
      } else if (p.op === 'offer') {
        const x = pcFor(p.from, p.name);
        await x.pc.setRemoteDescription(p.sdp);
        const ans = await x.pc.createAnswer();
        await x.pc.setLocalDescription(ans);
        send('call', { op: 'answer', id: call.id, to: p.from, sdp: x.pc.localDescription.toJSON(), name: me.username });
      } else if (p.op === 'answer') {
        const x = call.pcs.get(p.from);
        if (x) { x.name = p.name || x.name; await x.pc.setRemoteDescription(p.sdp); }
      } else if (p.op === 'ice') {
        const x = call.pcs.get(p.from);
        if (x) try { await x.pc.addIceCandidate(p.cand); } catch {}
      } else if (p.op === 'leave') {
        const x = call.pcs.get(p.from);
        if (x) { try { x.pc.close(); } catch {} call.pcs.delete(p.from); paintCalls(); }
      }
    }
  }));
  // Someone opened the board: tell them about the timer, a presentation and calls in progress.
  offs.push(editor.on('collab-hello', (p) => {
    const to = p.from;
    if (timer) send('timer', { t: timer, to });
    if (presenting) send('present', { on: true, name: me.username, cam: camNow(), to });
    if (call && call.host === me.username) send('call', { op: 'start', call: { id: call.id, mode: call.mode, at: call.at, host: call.host }, to });
  }));

  /* ---------------- the top-bar controls ---------------- */
  const btn = (ic, label, fn, cls = '') => h('button', { class: `bp-icon ${cls}`, type: 'button', 'aria-label': label, 'data-tip': label, 'data-tip-pos': 'bottom', onclick: (e) => fn(e.currentTarget) }, svgIcon(ic, 18));
  const reactBtn = btn(IC.stopwatch, 'Reactions + Timer', (a) => openReactTimer(a));
  const camBtn = btn(IC.camera, 'Record / Call', (a) => menu(a, [
    { label: 'Record Talktrack', icon: 'record', onSelect: () => openTalktrack() },
    { label: call ? 'Leave the call' : 'Start a Call', icon: call ? 'close' : 'users', onSelect: () => (call ? leaveCall() : startCall()) },
  ], { align: 'end' }));
  const presentBtn = btn(IC.monitor, 'Present Board', () => (presenting ? stopPresenting() : startPresenting()));
  const face = h('span', { class: 'lv-face' }, (me.username || '?').slice(0, 1).toUpperCase());
  if (me.avatar) face.replaceChildren(h('img', { src: me.avatar, alt: '' }));
  const profileBtn = h('button', { class: 'bp-icon lv-profile', type: 'button', 'aria-label': 'More', 'aria-haspopup': 'menu', 'data-tip': 'More', 'data-tip-pos': 'bottom', onclick: (e) => openMore(e.currentTarget) }, face, icon('chevronDown', 13));
  function openMore(anchor) {
    const st = (() => { try { return localStorage.getItem(`architect.status.${me.id}`) || ''; } catch { return ''; } })();
    menu(anchor, [
      onInvite ? { label: 'Invite People…', icon: 'userPlus', onSelect: () => onInvite() } : null,
      { label: st ? `Status: ${st}` : 'Set a status…', icon: 'edit', onSelect: () => setStatus() },
      st ? { label: 'Clear status', icon: 'close', onSelect: () => putStatus('') } : null,
      '-',
      ...menuItems(),
    ].filter(Boolean), { align: 'end' });
  }
  async function setStatus() {
    const v = await (await import('../core/ui.js')).promptDialog('Your status', { value: (() => { try { return localStorage.getItem(`architect.status.${me.id}`) || ''; } catch { return ''; } })(), placeholder: 'In a meeting · Focusing · Back at 3', maxLength: 40, ok: 'Set' });
    if (v != null) putStatus(v);
  }
  function putStatus(v) {
    try { if (v) localStorage.setItem(`architect.status.${me.id}`, v); else localStorage.removeItem(`architect.status.${me.id}`); } catch {}
    window.dispatchEvent(new CustomEvent('architect:status'));
    toast(v ? `Status: ${v}` : 'Status cleared.', { ms: 1400 });
  }
  const setAvatar = (url) => { if (url) face.replaceChildren(h('img', { src: url, alt: '' })); };

  return {
    reactBtn, camBtn, presentBtn, profileBtn, setAvatar,
    destroy() { offs.forEach((f) => { try { f(); } catch {} }); closeFloating(); },
  };
}
