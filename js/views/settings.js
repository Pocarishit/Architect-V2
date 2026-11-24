// Settings: your face, the look of your Space, who's in it, integrations, personal API tokens, and the
// Updates Catalogue (with custom CSS / JS tucked under it).
import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { dialog, toast, confirmDialog } from '../core/ui.js';
import { uid } from '../core/util.js';
import { api, configured, friendlyError } from '../data/api.js';
import { getPref, setPref, loadPrefs } from '../data/prefs.js';
import { myAvatar, setMyAvatar, clearMyAvatar, avatarsFor } from '../data/profile.js';
import { colorFor, initials } from '../board/collab.js';
import { applyCustom } from '../core/custom.js';
import { releases, pushRelease, rollback } from '../data/releases.js';
import { THEMES, setTheme, currentTheme } from './shell.js';
import { CATALOGUE } from '../data/catalogue.js';
import { integrations } from './integrations.js';
import { PATTERNS, bgOf, setBg, paintBg } from '../space/backgrounds.js';
import { updatesCanvas } from './updates.js';
import { urlOf } from '../space/media.js';

const TABS = [['profile', 'Profile'], ['general', 'General'], ['personalize', 'Personalize'], ['members', 'Members'], ['integrations', 'Integrations'], ['api', 'API'], ['custom', 'Updates & Fixes']];

/** actions: hooks into the Space (shortcuts, bench, camera points, toolbar, snap, personal background). */
export async function openSettings({ tab = 'profile', spaceId = null, actions = {} } = {}) {
  await loadPrefs().catch(() => {});
  const me = api.auth.current()?.user;
  let cur = TABS.some(([id]) => id === tab) ? tab : 'profile';
  const nav = h('div', { class: 'seg seg-sm set-tabs', role: 'tablist' });
  const pane = h('div', { class: 'set-pane' });
  const paint = () => {
    nav.replaceChildren(...TABS.map(([id, label]) => h('button', { type: 'button', role: 'tab', class: cur === id ? 'is-on' : null, 'aria-selected': String(cur === id), onclick: () => { cur = id; paint(); } }, label)));
    pane.classList.toggle('is-canvas', cur === 'custom');
    pane.closest('.dlg')?.classList.toggle('is-wide', cur === 'custom');
    pane.replaceChildren(({ profile, general, personalize, members, integrations, api: apiTab, custom: updatesTab })[cur]({ me, spaceId, actions }));
  };
  paint();
  dialog({ title: 'Settings', width: 640, className: 'set-dlg', body: h('div', { class: 'set' }, nav, pane), actions: [{ label: 'Done', primary: true, value: true }] });
  requestAnimationFrame(() => pane.closest('.dlg')?.classList.toggle('is-wide', cur === 'custom'));
}

/* ---------------- Profile ---------------- */
function profile({ me }) {
  const face = h('span', { class: 'set-face', style: { '--c': colorFor(me.id) } }, initials(me.username));
  const show = (url) => face.replaceChildren(url ? h('img', { src: url, alt: '' }) : initials(me.username));
  myAvatar().then(show).catch(() => {});
  const file = h('input', { type: 'file', accept: 'image/*', hidden: true });
  file.addEventListener('change', async () => {
    const f = file.files[0];
    file.value = '';
    if (!f) return;
    try { show(await setMyAvatar(f)); toast('Face updated — others see it on your cursor after they reload.'); }
    catch (e) { toast(friendlyError(e), { tone: 'error', ms: 5000 }); }
  });
  return h('div', { class: 'stack' },
    h('div', { class: 'set-profile' }, face,
      h('div', { class: 'set-profile-text' },
        h('b', {}, me.username),
        h('span', {}, configured ? 'Synced with Supabase' : 'Local mode — this browser only'),
        h('div', { class: 'set-row' },
          h('button', { class: 'btn sm', type: 'button', onclick: () => file.click() }, icon('upload', 14), 'Upload face'),
          h('button', { class: 'btn sm', type: 'button', onclick: async () => { try { await clearMyAvatar(); show(null); } catch (e) { toast(friendlyError(e), { tone: 'error' }); } } }, 'Remove')))),
    file,
    h('p', { class: 'dlg-text' }, 'Your face rides on your cursor in the Space and on blueprints, as a bubble head with a pointer.'));
}

/* ---------------- General: look, canvas, tools (Nov 23b) ---------------- */
function general({ actions = {} }) {
  const sec = (title, ...kids) => h('section', { class: 'set-section' }, h('h3', {}, title), ...kids);
  const sw = (label, get, set) => {
    if (!get || !set) return null;
    let on = !!get();
    const b = h('button', { type: 'button', class: ['px-check', on && 'is-on'], role: 'switch', 'aria-checked': String(on) });
    const paint = () => { b.classList.toggle('is-on', on); b.setAttribute('aria-checked', String(on)); b.replaceChildren(h('i', {}, on ? icon('check', 11, { weight: 2.8 }) : null), label); };
    b.addEventListener('click', () => { on = !on; set(on); paint(); });
    paint();
    return b;
  };

  // Theme
  const themes = h('div', { class: 'set-themes' });
  const paintThemes = () => themes.replaceChildren(...THEMES.map((t) => h('button', {
    type: 'button', class: ['btn sm', currentTheme() === t.id && 'is-on'], 'aria-pressed': String(currentTheme() === t.id),
    onclick: () => { setTheme(t.id); paintThemes(); },
  }, h('span', { class: 'theme-dots', 'aria-hidden': 'true' }, t.dots.map((c) => h('i', { style: { background: c } }))), t.name)));
  paintThemes();

  return h('div', { class: 'stack' },
    sec('Theme', themes),
    actions.toolbar || actions.snap || actions.cameraPoints ? sec('Canvas',
      h('div', { class: 'set-row' }, sw('Show toolbar', actions.toolbar, actions.setToolbar), sw('Snap objects together', actions.snap, actions.setSnap)),
      actions.cameraPoints ? h('div', { class: 'set-row' },
        h('button', { class: 'btn sm', type: 'button', onclick: () => actions.saveView?.() }, icon('target', 14), 'Save this view…'),
        h('button', { class: 'btn sm', type: 'button', onclick: () => actions.cameraPoints() }, icon('target', 14), 'Camera points…')) : null) : null,
    actions.shortcuts || actions.bench ? sec('Tools',
      h('div', { class: 'set-row' },
        actions.shortcuts ? h('button', { class: 'btn sm', type: 'button', onclick: () => actions.shortcuts() }, icon('keyboard', 14), 'Keyboard shortcuts', h('kbd', {}, '?')) : null,
        actions.bench ? h('button', { class: 'btn sm', type: 'button', onclick: () => actions.bench() }, icon('fit', 14), 'Performance test (500 objects)') : null)) : null);
}

/* ---------------- Personalize: Space backgrounds (Nov 24) ---------------- */
// Personal Space and Shared Space each get their own background — a built-in pattern or your own PNG
// (Fill, or Tile with a scale). Both are your preference only: nobody else's view changes.
function personalize() {
  const sec = (title, ...kids) => h('section', { class: 'set-section' }, h('h3', {}, title), ...kids);
  const block = (space, text) => {
    let bg = bgOf(space);
    const prev = h('div', { class: 'sbg-prev' }, 'NONE');
    const opts = h('div', { class: 'sbg-opts', role: 'radiogroup', 'aria-label': `${space === 'shared' ? 'Shared' : 'Personal'} Space background` });
    const layout = h('div', { class: 'sbg-opts' });
    const scaleIn = h('input', { type: 'range', min: 10, max: 400, step: 5, value: Math.round((bg.scale || 1) * 100), 'aria-label': 'Tile size' });
    const scaleVal = h('b', {}, `${Math.round((bg.scale || 1) * 100)}%`);
    const scale = h('label', { class: 'sbg-scale' }, 'TILE SIZE', scaleIn, scaleVal);
    const file = h('input', { type: 'file', accept: 'image/png', hidden: true });
    const save = async (next) => {
      bg = next;
      paint();
      try { await setBg(space, next); } catch (e) { toast(friendlyError(e), { tone: 'error' }); }
    };
    const choice = (label, on, fn) => h('button', { type: 'button', class: ['btn sm', on && 'is-on'], role: 'radio', 'aria-checked': String(!!on), onclick: fn }, label);
    function paint() {
      const img = bg.kind === 'image';
      opts.replaceChildren(
        ...PATTERNS.map((p) => choice(p.label, bg.kind === 'pattern' && bg.pattern === p.id, () => save({ kind: 'pattern', pattern: p.id }))),
        choice(img ? 'Your PNG' : 'Upload PNG…', img, () => (img ? null : file.click())),
        ...(bg.kind !== 'none' ? [choice('Default', false, () => save({ kind: 'none' }))] : []));
      layout.hidden = !img; scale.hidden = !(img && bg.layout === 'tile');
      if (img) layout.replaceChildren(
        choice('Fill', bg.layout !== 'tile', () => save({ ...bg, layout: 'fill' })),
        choice('Tile', bg.layout === 'tile', () => save({ ...bg, layout: 'tile', scale: bg.scale || 1 })),
        h('button', { type: 'button', class: 'btn sm', onclick: () => file.click() }, icon('upload', 13), 'Replace PNG'));
      scaleVal.textContent = `${Math.round((bg.scale || 1) * 100)}%`;
      prev.textContent = bg.kind === 'none' ? 'DEFAULT' : '';
      // The preview shows a pattern or tile at a smaller scale, like a zoomed-out canvas.
      paintBg(prev, bg, { x: 0, y: 0, z: bg.kind === 'image' && bg.layout === 'tile' ? 0.35 : 0.7 });
    }
    let t = 0;
    scaleIn.addEventListener('input', () => {
      bg = { ...bg, scale: Number(scaleIn.value) / 100 };
      scaleVal.textContent = `${scaleIn.value}%`;
      paintBg(prev, bg, { x: 0, y: 0, z: 0.35 });
      clearTimeout(t); t = setTimeout(() => save(bg), 250);
    });
    file.addEventListener('change', async () => {
      const f = file.files[0];
      file.value = '';
      if (!f) return;
      if (f.type !== 'image/png') { toast('Pick a PNG image.', { tone: 'error' }); return; }
      if (f.size > 15 * 1024 * 1024) { toast('That PNG is over 15 MB.', { tone: 'error' }); return; }
      try {
        const { path } = await api.media.upload(f);
        await save({ kind: 'image', path, layout: bg.kind === 'image' ? bg.layout : 'fill', scale: bg.scale || 1 });
        toast(`Your ${space === 'shared' ? 'Shared' : 'Personal'} Space has its new background.`, { ms: 2200 });
      } catch (e) { toast(friendlyError(e), { tone: 'error', ms: 5000 }); }
    });
    paint();
    return h('div', { class: 'sbg' }, prev, h('div', { class: 'stack' }, h('p', { class: 'dlg-text' }, text), opts, layout, scale), file);
  };
  return h('div', { class: 'stack' },
    sec('Sidebar', sidebarLook()),
    sec('Personal Space background', block('personal', 'Behind your personal Space only. The Shared Space and the objects on the board stay as they are.')),
    sec('Shared Space background', block('shared', 'Only you see this one: everyone else in the Shared Space keeps their own background. The board itself doesn’t change.')));
}

/* Nov 26 — the sidebar's color and PNG (beside Customize My View, which lives in the sidebar itself). Kept on
   your account (prefs.sbLook), so it's the same after a reload and on your other devices. Changing it never
   touches the sidebar's layout, its views, or what's shown or hidden. */
const SB_COLORS = ['#141414', '#1d1f24', '#22201b', '#1b2420', '#1f1b24', '#2a1a1a', '#e9e6df'];
function sidebarLook() {
  let look = { ...(getPref('sbLook', null) || {}) };
  const swatches = h('div', { class: 'sbl-swatches', role: 'radiogroup', 'aria-label': 'Sidebar color' });
  const custom = h('input', { type: 'color', class: 'sbl-custom', 'aria-label': 'Custom sidebar color', value: look.color || '#141414' });
  const prev = h('div', { class: 'sbl-prev', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'));
  const imgRow = h('div', { class: 'sbg-opts' });
  const file = h('input', { type: 'file', accept: 'image/png', hidden: true });
  const save = async (next) => {
    look = next;
    paint();
    try { await setPref('sbLook', Object.keys(look).length ? look : null); window.dispatchEvent(new Event('architect:sidebar-look')); }
    catch (e) { toast(friendlyError(e), { tone: 'error' }); }
  };
  const without = (k) => { const n = { ...look }; delete n[k]; return n; };
  function paint() {
    swatches.replaceChildren(
      h('button', { type: 'button', class: ['sbl-sw is-default', !look.color && 'is-on'], role: 'radio', 'aria-checked': String(!look.color), title: 'Default', 'aria-label': 'Default color', onclick: () => save(without('color')) }),
      ...SB_COLORS.map((c) => h('button', { type: 'button', class: ['sbl-sw', look.color === c && 'is-on'], role: 'radio', 'aria-checked': String(look.color === c), title: c, 'aria-label': `Color ${c}`, style: { '--c': c }, onclick: () => save({ ...look, color: c }) })),
      custom);
    imgRow.replaceChildren(
      h('button', { type: 'button', class: 'btn sm', onclick: () => file.click() }, icon('upload', 13), look.png ? 'Replace PNG' : 'Choose PNG…'),
      look.png ? h('button', { type: 'button', class: 'btn sm', onclick: () => save(without('png')) }, icon('close', 13), 'Remove PNG') : null);
    prev.style.setProperty('--c', look.color || '');
    prev.classList.toggle('has-color', !!look.color);
    const url = look.png ? urlOf(look.png, paint) : null;
    prev.style.backgroundImage = url ? `url("${url}")` : '';
  }
  let t = 0;
  custom.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => save({ ...look, color: custom.value }), 200); });
  file.addEventListener('change', async () => {
    const f = file.files[0];
    file.value = '';
    if (!f) return;
    if (f.type !== 'image/png') { toast('Pick a PNG image.', { tone: 'error' }); return; }
    if (f.size > 15 * 1024 * 1024) { toast('That PNG is over 15 MB.', { tone: 'error' }); return; }
    try { const { path } = await api.media.upload(f); await save({ ...look, png: path }); toast('The sidebar has its new image.', { ms: 2000 }); }
    catch (e) { toast(friendlyError(e), { tone: 'error', ms: 5000 }); }
  });
  paint();
  return h('div', { class: 'sbg' }, prev, h('div', { class: 'stack' },
    h('p', { class: 'dlg-text' }, 'The sidebar’s color and an optional PNG behind its icons. Its layout and what it shows don’t change.'),
    swatches, imgRow), file);
}

/* ---------------- Members ---------------- */
function members({ me, spaceId }) {
  const wrap = h('div', { class: 'stack' });
  if (api.mode === 'local' || !spaceId) {
    wrap.append(h('p', { class: 'dlg-text' }, 'Inviting people needs Supabase. In local mode you can still try live editing by opening the Space in a second tab.'));
    return wrap;
  }
  const input = h('input', { class: 'input', placeholder: 'Their username', autocapitalize: 'none', spellcheck: false, maxlength: 32, 'aria-label': 'Username to invite' });
  const invite = h('button', { class: 'btn btn-primary', type: 'button' }, 'Invite');
  const err = h('p', { class: 'share-err', hidden: true });
  const list = h('div', { class: 'share-list' }, h('span', { class: 'dots-loader' }, h('i'), h('i'), h('i')));
  let rows = [];
  let owner = null;
  async function load() {
    try {
      rows = (await api.rpc('board_people', { b: spaceId })) || [];
      owner = rows.find((r) => r.role === 'owner')?.user_id || null;
      const faces = await avatarsFor(rows.map((r) => r.user_id));
      list.replaceChildren(...rows.map((r) => {
        const self = r.user_id === me.id;
        return h('div', { class: 'share-person' },
          h('span', { class: 'bp-av', style: { '--c': colorFor(r.user_id) } }, faces.get(r.user_id) ? h('img', { src: faces.get(r.user_id), alt: '' }) : initials(r.username)),
          h('span', { class: 'share-name' }, r.username, self ? h('span', { class: 'share-you' }, ' (you)') : null),
          h('span', { class: 'share-role' }, r.role === 'owner' ? 'Owner' : 'Member'),
          owner === me.id && !self ? h('button', { type: 'button', class: 'icon-btn sm', 'aria-label': `Remove ${r.username}`, onclick: () => remove(r) }, icon('close', 15)) : null,
          self && r.role !== 'owner' ? h('button', { type: 'button', class: 'btn btn-sm', onclick: leave }, icon('leave', 14), 'Leave') : null);
      }));
    } catch (e) { list.replaceChildren(h('p', { class: 'dlg-text' }, friendlyError(e))); }
  }
  async function doInvite() {
    const name = input.value.trim().replace(/^@/, '');
    if (!name) { input.focus(); return; }
    err.hidden = true;
    invite.disabled = true;
    try { await api.rpc('space_invite', { b: spaceId, uname: name }); input.value = ''; toast(`${name} is in the Space.`); await load(); }
    catch (e) { err.textContent = /function|space_invite/i.test(String(e?.message)) ? 'Run supabase/space.sql first.' : friendlyError(e); err.hidden = false; }
    finally { invite.disabled = false; }
  }
  async function remove(r) {
    if (!(await confirmDialog(`Remove ${r.username}?`, 'They lose access to the Space. Their Path stays on the canvas until you delete it.', { ok: 'Remove' }))) return;
    try { await api.db.removeWhere('blueprint_members', { board_id: spaceId, user_id: r.user_id }); load(); } catch (e) { toast(friendlyError(e), { tone: 'error' }); }
  }
  async function leave() {
    if (!(await confirmDialog('Leave this Space?', 'You’ll get your own empty Space next time. A member can invite you back.', { ok: 'Leave' }))) return;
    try { await api.db.removeWhere('blueprint_members', { board_id: spaceId, user_id: me.id }); await setPref('spaceId', null); location.hash = '#/'; location.reload(); }
    catch (e) { toast(friendlyError(e), { tone: 'error' }); }
  }
  invite.addEventListener('click', doInvite);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doInvite(); } });
  load();
  wrap.append(
    h('p', { class: 'dlg-text' }, 'The Space is invite-only. Anyone in it can invite someone by username; they’ll land here next time they open Architect.'),
    h('div', { class: 'share-row' }, input, invite), err,
    h('div', { class: 'pop-label' }, 'In this Space'), list);
  return wrap;
}

/* ---------------- API tokens ---------------- */
function apiTab({ me }) {
  const wrap = h('div', { class: 'stack' });
  const cfg = window.ARCHITECT_CONFIG || {};
  const endpoint = `${(cfg.supabaseUrl || 'https://YOUR-PROJECT.supabase.co').replace(/\/$/, '')}/rest/v1/rpc/architect_api`;
  if (api.mode === 'local') {
    wrap.append(h('p', { class: 'dlg-text' }, 'The Local API runs on Supabase (it’s a database function), so it needs Supabase sync. Add your keys to config.js, run supabase/space.sql, then come back here.'));
    return wrap;
  }
  const list = h('div', { class: 'tok-list' }, h('span', { class: 'dots-loader' }, h('i'), h('i'), h('i')));
  const fresh = h('div', { class: 'tok-fresh', hidden: true });
  async function load() {
    try {
      const rows = await api.db.select('api_tokens', { columns: 'id,name,prefix,created_at,last_used_at', order: 'created_at.desc' });
      list.replaceChildren(...(rows.length ? rows.map((r) => h('div', { class: 'tok-row' },
        icon('key', 15),
        h('span', { class: 'tok-name' }, r.name),
        h('code', { class: 'tok-prefix' }, `${r.prefix}…`),
        h('span', { class: 'tok-used' }, r.last_used_at ? `used ${new Date(r.last_used_at).toLocaleDateString()}` : 'never used'),
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => revoke(r) }, 'Revoke'))) : [h('p', { class: 'dlg-text' }, 'No tokens yet.')]));
    } catch (e) { list.replaceChildren(h('p', { class: 'dlg-text' }, /api_tokens/.test(String(e?.message)) ? 'Run supabase/space.sql to enable the API.' : friendlyError(e))); }
  }
  async function create() {
    const name = nameInput.value.trim() || 'My script';
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    const token = `arch_${btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))].map((b) => b.toString(16).padStart(2, '0')).join('');
    try {
      await api.db.insert('api_tokens', { id: uid(), name, prefix: token.slice(0, 10), token_hash: hash });
    } catch (e) { toast(friendlyError(e), { tone: 'error', ms: 5000 }); return; }
    nameInput.value = '';
    const code = h('code', { class: 'tok-secret' }, token);
    fresh.hidden = false;
    fresh.replaceChildren(
      h('b', {}, 'Copy it now — it won’t be shown again.'),
      h('div', { class: 'tok-copy' }, code,
        h('button', { class: 'btn btn-sm', type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(token); toast('Copied'); } catch { toast('Select it and copy.'); } } }, icon('copy', 13), 'Copy')));
    load();
  }
  async function revoke(r) {
    if (!(await confirmDialog(`Revoke “${r.name}”?`, 'Anything using it stops working right away.', { ok: 'Revoke' }))) return;
    try { await api.db.remove('api_tokens', r.id); load(); } catch (e) { toast(friendlyError(e), { tone: 'error' }); }
  }
  const nameInput = h('input', { class: 'input', placeholder: 'Token name, e.g. Raycast', maxlength: 40, 'aria-label': 'Token name', onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); create(); } } });
  const curl = `curl -X POST '${endpoint}' \\
  -H 'apikey: ${cfg.supabaseKey || 'YOUR_PUBLISHABLE_KEY'}' \\
  -H 'Content-Type: application/json' \\
  -d '{"token":"arch_…","action":"tasks.add","payload":{"column":"Morning","title":"Ship #12"}}'`;
  load();
  wrap.append(
    h('p', { class: 'dlg-text' }, 'Personal tokens let your own scripts read and write the Space: canvas objects, Path tasks, tickets, attempts, custom widgets — and push custom CSS / JS hotfixes. A token acts as you; keep it secret.'),
    h('div', { class: 'share-row' }, nameInput, h('button', { class: 'btn btn-primary', type: 'button', onclick: create }, 'Generate')),
    fresh,
    h('div', { class: 'pop-label' }, 'Your tokens'), list,
    h('div', { class: 'pop-label' }, 'Endpoint'),
    h('pre', { class: 'code-block' }, curl),
    h('details', { class: 'api-actions' },
      h('summary', {}, 'All actions'),
      h('pre', { class: 'code-block' }, [
        'whoami',
        'objects.list · objects.add {element} · objects.update {id, patch} · objects.remove {id}',
        'widgets.spawn {title, html, x?, y?, w?, h?}',
        'columns.list · tasks.list · tasks.add {column | column_id, title, note?, private?}',
        'tasks.update {id, patch} · tasks.remove {id}',
        'tickets.list · tickets.add {title, detail?, deadline?, labels?} · tickets.update {id | no, patch}',
        'tickets.message {no, body} · attempts.log {no, outcome: failed|partial|worked, body}',
        'attempts.list {since?, until?}',
        'style.get · style.set {css} · script.set {js} · safe_mode.set {on}',
        'updates.push {css?, js?, note?} · updates.list · updates.current · updates.rollback {version?}',
      ].join('\n'))));
  return wrap;
}

/* ---------------- Updates & Fixes (Nov 24) ---------------- */
// The canvas of update notes + previews with Push Update / Schedule (views/updates.js). The Catalogue of
// what shipped, and your own custom CSS / JS, fold away underneath it.
function updatesTab() {
  return updatesCanvas({ extras: () => h('details', { class: 'set-adv' }, h('summary', {}, 'Catalogue · custom CSS & JS'), updates()) });
}

/* ---------------- Updates: the Catalogue (Nov 23b) ---------------- */
// What changed in Architect, newest first, searchable. Your own custom CSS / JS releases are still here,
// under "Custom CSS & JS".
function updates() {
  const q = h('input', { class: 'input cat-search', type: 'search', placeholder: 'Search updates', 'aria-label': 'Search updates' });
  const list = h('div', { class: 'cat-list' });
  const newest = CATALOGUE[0]?.day;
  const paint = () => {
    const t = q.value.trim().toLowerCase();
    const hits = CATALOGUE.filter((x) => !t || `${x.title} ${x.area} ${x.text}`.toLowerCase().includes(t));
    const out = [];
    let last = '';
    for (const x of hits) {
      if (x.day !== last) {
        last = x.day;
        const [y, m, d] = x.day.split('-').map(Number);
        out.push(h('h4', { class: 'cat-day' }, new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', month: 'long', day: 'numeric', year: 'numeric' }).toUpperCase()));
      }
      out.push(h('article', { class: ['cat-item', x.day === newest && 'is-new'] },
        h('header', {}, h('b', {}, x.title), h('span', { class: 'cat-area' }, x.area)),
        h('p', {}, x.text)));
    }
    list.replaceChildren(...(out.length ? out : [h('p', { class: 'cat-empty' }, 'No update matches.')]));
  };
  q.addEventListener('input', paint);
  paint();
  return h('div', { class: 'stack' },
    q, list,
    h('details', { class: 'set-adv' }, h('summary', {}, 'Custom CSS & JS'), custom()));
}

/* ---------------- Custom CSS / JS, versioned, with rollback ---------------- */
function custom() {
  const css = h('textarea', { class: 'input code-input', rows: 8, spellcheck: false, value: getPref('customCss', '') || '', placeholder: '/* e.g. */\n:root { --red: #ff3b30; }', 'aria-label': 'Custom CSS' });
  const js = h('textarea', { class: 'input code-input', rows: 8, spellcheck: false, value: getPref('customJs', '') || '', placeholder: '// runs once on load, with `architect` = { api, toast, update, rollback }', 'aria-label': 'Custom JS' });
  const note = h('input', { class: 'input', maxlength: 200, placeholder: 'What does this update change? (optional)', 'aria-label': 'Update note' });
  let safe = !!getPref('safeMode', false);
  const sw = h('button', { type: 'button', class: ['px-check', safe && 'is-on'], role: 'switch', 'aria-checked': String(safe) });
  const paintSw = () => { sw.classList.toggle('is-on', safe); sw.setAttribute('aria-checked', String(safe)); sw.replaceChildren(h('i', {}, safe ? icon('check', 11, { weight: 2.8 }) : null), safe ? 'Safe mode on' : 'Safe mode off'); };
  sw.addEventListener('click', async () => { safe = !safe; paintSw(); await setPref('safeMode', safe); applyCustom({ rerunJs: true }); });
  paintSw();
  const history = h('div', { class: 'rel-list' });
  const paintHistory = async () => {
    const { list, active } = await releases();
    history.replaceChildren(...(list.length ? list.map((r) => h('div', { class: ['rel-row', r.v === active && 'is-active'] },
      h('b', { class: 'rel-v' }, `v${r.v}`),
      h('div', { class: 'rel-main' },
        h('span', { class: 'rel-note' }, r.note || (r.v === 0 ? 'Before the first update' : 'No note')),
        h('span', { class: 'rel-meta' }, `${new Date(r.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · ${r.source || 'app'} · ${(r.css || '').length + (r.js || '').length} chars`)),
      r.v === active ? h('span', { class: 'rel-live' }, h('i'), 'Live')
        : h('button', { class: 'btn btn-sm', type: 'button', onclick: async () => {
          if (!(await confirmDialog(`Roll back to v${r.v}?`, 'Your CSS and JS go back to that version right away. Newer versions stay in the list.', { ok: 'Roll back' }))) return;
          const t = await rollback(r.v);
          css.value = t.css || ''; js.value = t.js || '';
          applyCustom({ rerunJs: true });
          toast(`Rolled back to v${t.v}. Reload if a script was running.`, { ms: 4000 });
          paintHistory();
        } }, icon('history', 13), r.v < (active ?? Infinity) ? 'Roll back' : 'Restore')))
      : [h('p', { class: 'dlg-text' }, 'No updates yet. Push one and it shows up here — every version can be rolled back.')]));
  };
  paintHistory();
  const push = async () => {
    try {
      const r = await pushRelease({ css: css.value, js: js.value, note: note.value.trim(), source: 'app' });
      note.value = '';
      applyCustom({ rerunJs: true });
      toast(safe ? `Pushed v${r.v} — safe mode keeps it switched off.` : `Pushed v${r.v} and applied.`);
      paintHistory();
    } catch (e) { toast(friendlyError(e), { tone: 'error' }); }
  };
  return h('div', { class: 'stack' },
    h('p', { class: 'dlg-text' }, 'Push your own fixes and theme tweaks as numbered updates (for your account only). Something broke? Roll back to any earlier version — or open Architect with ?safe to switch them all off. The API can push and roll back too.'),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'CSS'), css),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'JavaScript'), js),
    note,
    h('div', { class: 'set-row' }, sw, h('span', { class: 'set-space' }), h('button', { class: 'btn btn-primary sm', type: 'button', onclick: push }, icon('upload', 14), 'Push update')),
    h('div', { class: 'pop-label' }, 'Versions'),
    history);
}
