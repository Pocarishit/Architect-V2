import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { menu, dialog, toast } from '../core/ui.js';
import { fmtClock, store } from '../core/util.js';
import { api, configured, friendlyError } from '../data/api.js';
import { loadPrefs, getPref, setPref } from '../data/prefs.js';

export const THEMES = [
  { id: 'dark', name: 'Dark', meta: '#000000', dots: ['#000000', '#454545', '#ffffff'] },
  { id: 'light', name: 'Light', meta: '#f3f3f3', dots: ['#ffffff', '#b8b8b8', '#000000'] },
  { id: 'blueprint', name: 'Blueprint', meta: '#0A2550', dots: ['#0A2550', '#2060D0', '#DDEEFA'] },
];
export function setTheme(t, { sync = true } = {}) {
  const th = THEMES.find((x) => x.id === t) || THEMES[0];
  document.documentElement.dataset.theme = th.id;
  store.set('architect.theme', th.id);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', th.meta);
  if (sync) setPref('theme', th.id).catch(() => {}); // follows your account to other devices
}
export const currentTheme = () => document.documentElement.dataset.theme || 'dark';
export function toggleTheme() {
  const i = THEMES.findIndex((x) => x.id === currentTheme());
  setTheme(THEMES[(i + 1) % THEMES.length].id);
}
function themeItems() {
  return THEMES.map((t) => ({
    label: t.name, checked: currentTheme() === t.id, onSelect: () => setTheme(t.id),
    iconEl: h('span', { class: 'theme-dots', 'aria-hidden': 'true' }, t.dots.map((c) => h('i', { style: { background: c } }))),
  }));
}

export function mountShell(root, { session }) {
  const SECTIONS = [
    { id: 'paths', label: 'Paths', icon: 'toPaths' },
    { id: 'blueprint', label: 'Blueprint', icon: 'frame', also: ['board'] },
    { id: 'tracker', label: 'Tracker', icon: 'calendar' },
    { id: 'parasites', label: 'Parasites', icon: 'bug' },
    { id: 'countdown', label: 'Countdown', icon: 'hourglass' },
    { id: 'meter', label: 'Meter', icon: 'chart' },
  ];
  const links = SECTIONS.map((sec) => h('a', { href: `#/${sec.id}` }, sec.label));
  // Phones: one pill with the current section; tap for the rest.
  const navCur = h('span', {}, 'Paths');
  const navPick = h('button', { class: 'nav-pick', type: 'button', 'aria-label': 'Sections' }, navCur, icon('chevronDown', 14));
  let current = 'paths';
  navPick.addEventListener('click', () => menu(navPick, SECTIONS.map((sec) => ({
    label: sec.label, icon: sec.icon, checked: current === sec.id || sec.also?.includes(current), onSelect: () => { location.hash = `#/${sec.id}`; },
  }))));
  const clock = h('time', { class: 'clock', 'aria-label': 'Current time' }, fmtClock());
  const themeBtn = h('button', { class: 'icon-btn', 'aria-label': 'Choose theme', 'data-tip': 'Theme' }, icon('theme', 18));
  themeBtn.addEventListener('click', () => menu(themeBtn, [{ header: 'Theme' }, ...themeItems()], { align: 'end' }));
  const userBtn = h('button', { class: 'user-btn', 'aria-label': 'Account' },
    h('span', { class: 'user-dot' }, (session.user.username || '?').slice(0, 1).toUpperCase()),
    h('span', { class: 'user-name' }, session.user.username));

  userBtn.addEventListener('click', () => {
    menu(userBtn, [
      { header: configured ? 'Synced with Supabase' : 'Local mode' },
      { label: 'Change password', icon: 'key', onSelect: changePassword },
      '-',
      { header: 'Theme' },
      ...themeItems(),
      '-',
      { label: 'Sign out', icon: 'logout', onSelect: () => api.auth.signOut() },
    ], { align: 'end' });
  });

  // Your account's saved theme wins over this browser's (e.g. picked on your phone).
  loadPrefs().then(() => {
    const t = getPref('theme', null);
    if (t && t !== currentTheme()) setTheme(t, { sync: false });
  }).catch(() => {});

  const outlet = h('div', { class: 'outlet' });
  const el = h('div', { class: 'shell' },
    h('header', { class: 'shell-head' },
      h('a', { class: 'wordmark', href: '#/paths', 'aria-label': 'Architect home' }, 'Architect'),
      h('nav', { class: 'nav', 'aria-label': 'Sections' }, links),
      navPick,
      h('div', { class: 'head-right' },
        !configured ? h('span', { class: 'mode-chip', title: 'Data is stored in this browser. Add your Supabase keys to config.js to sync.' }, h('i'), 'Local') : null,
        clock, themeBtn, userBtn)),
    outlet);
  root.append(el);

  const tick = setInterval(() => { clock.textContent = fmtClock(); }, 10_000);

  return {
    outlet,
    setActive(view) {
      current = view;
      SECTIONS.forEach((sec, i) => {
        const on = view === sec.id || !!sec.also?.includes(view);
        links[i].classList.toggle('active', on);
        links[i].toggleAttribute('aria-current', on);
        if (on) navCur.textContent = sec.label;
      });
    },
    destroy() { clearInterval(tick); el.remove(); },
  };
}

async function changePassword() {
  const a = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', autofocus: true, placeholder: 'At least 6 characters' });
  const b = h('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
  const err = h('p', { class: 'login-error', hidden: true });
  const pw = await dialog({
    title: 'Change password',
    body: h('div', { class: 'stack' },
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'New password'), a),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Confirm'), b),
      err),
    actions: [
      { label: 'Cancel', value: null },
      {
        label: 'Save password', primary: true, value: () => {
          const fail = (m) => { err.hidden = false; err.textContent = m; return undefined; };
          if (a.value.length < 6) return fail('Passwords need at least 6 characters.');
          if (a.value !== b.value) return fail('Passwords don’t match.');
          return a.value;
        },
      },
    ],
  });
  if (!pw) return;
  try {
    await api.auth.changePassword(pw);
    toast('Password saved');
  } catch (e) {
    toast(friendlyError(e), { tone: 'error', ms: 5000 });
  }
}
