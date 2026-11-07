// Settings: your face, who's in the Space, personal API tokens, and custom CSS / JS.
import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { dialog, toast, confirmDialog } from '../core/ui.js';
import { uid } from '../core/util.js';
import { api, configured, friendlyError } from '../data/api.js';
import { getPref, setPref, loadPrefs } from '../data/prefs.js';
import { myAvatar, setMyAvatar, clearMyAvatar, avatarsFor } from '../data/profile.js';
import { colorFor, initials } from '../board/collab.js';
import { applyCustom } from '../core/custom.js';

const TABS = [['profile', 'Profile'], ['members', 'Members'], ['api', 'API'], ['custom', 'Customize']];

export async function openSettings({ tab = 'profile', spaceId = null } = {}) {
  await loadPrefs().catch(() => {});
  const me = api.auth.current()?.user;
  let cur = tab;
  const nav = h('div', { class: 'seg seg-sm set-tabs', role: 'tablist' });
  const pane = h('div', { class: 'set-pane' });
  const paint = () => {
    nav.replaceChildren(...TABS.map(([id, label]) => h('button', { type: 'button', role: 'tab', class: cur === id ? 'is-on' : null, 'aria-selected': String(cur === id), onclick: () => { cur = id; paint(); } }, label)));
    pane.replaceChildren(({ profile, members, api: apiTab, custom })[cur]({ me, spaceId }));
  };
  paint();
  dialog({ title: 'Settings', width: 640, className: 'set-dlg', body: h('div', { class: 'set' }, nav, pane), actions: [{ label: 'Done', primary: true, value: true }] });
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
      ].join('\n'))));
  return wrap;
}

/* ---------------- Custom CSS / JS ---------------- */
function custom() {
  const css = h('textarea', { class: 'input code-input', rows: 8, spellcheck: false, value: getPref('customCss', '') || '', placeholder: '/* e.g. */\n:root { --red: #ff3b30; }', 'aria-label': 'Custom CSS' });
  const js = h('textarea', { class: 'input code-input', rows: 8, spellcheck: false, value: getPref('customJs', '') || '', placeholder: '// runs once on load, with `architect` = { api, toast, version }', 'aria-label': 'Custom JS' });
  let safe = !!getPref('safeMode', false);
  const sw = h('button', { type: 'button', class: ['px-check', safe && 'is-on'], role: 'switch', 'aria-checked': String(safe) });
  const paintSw = () => { sw.classList.toggle('is-on', safe); sw.setAttribute('aria-checked', String(safe)); sw.replaceChildren(h('i', {}, safe ? icon('check', 11, { weight: 2.8 }) : null), safe ? 'Safe mode on' : 'Safe mode off'); };
  sw.addEventListener('click', () => { safe = !safe; paintSw(); });
  paintSw();
  const save = async () => {
    await setPref('customCss', css.value);
    await setPref('customJs', js.value);
    await setPref('safeMode', safe);
    applyCustom({ rerunJs: true });
    toast(safe ? 'Saved — safe mode keeps them switched off.' : 'Saved and applied.');
  };
  return h('div', { class: 'stack' },
    h('p', { class: 'dlg-text' }, 'Your own theme tweaks and hotfixes, for your account only. The API can set these too. Safe mode switches both off; so does opening Architect with ?safe in the address.'),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'CSS'), css),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'JavaScript'), js),
    h('div', { class: 'set-row' }, sw, h('span', { class: 'set-space' }), h('button', { class: 'btn btn-primary sm', type: 'button', onclick: save }, 'Save & apply')));
}
