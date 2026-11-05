import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { menu, dialog, toast } from '../core/ui.js';
import { fmtClock, store } from '../core/util.js';
import { api, configured, friendlyError } from '../data/api.js';

export function setTheme(t) {
  document.documentElement.dataset.theme = t;
  store.set('architect.theme', t);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t === 'light' ? '#f3f3f3' : '#000000');
}
export const currentTheme = () => document.documentElement.dataset.theme || 'dark';
export function toggleTheme() { setTheme(currentTheme() === 'dark' ? 'light' : 'dark'); }

export function mountShell(root, { session }) {
  const navPaths = h('a', { href: '#/paths' }, 'Paths');
  const navBlue = h('a', { href: '#/blueprint' }, 'Blueprint');
  const clock = h('time', { class: 'clock', 'aria-label': 'Current time' }, fmtClock());
  const themeBtn = h('button', { class: 'icon-btn', 'aria-label': 'Switch light or dark', 'data-tip': 'Theme', onclick: toggleTheme }, icon('theme', 18));
  const userBtn = h('button', { class: 'user-btn', 'aria-label': 'Account' },
    h('span', { class: 'user-dot' }, (session.user.username || '?').slice(0, 1).toUpperCase()),
    h('span', { class: 'user-name' }, session.user.username));

  userBtn.addEventListener('click', () => {
    menu(userBtn, [
      { header: configured ? 'Synced with Supabase' : 'Local mode' },
      { label: 'Change password', icon: 'key', onSelect: changePassword },
      { label: currentTheme() === 'dark' ? 'Light theme' : 'Dark theme', icon: 'theme', onSelect: toggleTheme },
      '-',
      { label: 'Sign out', icon: 'logout', onSelect: () => api.auth.signOut() },
    ], { align: 'end' });
  });

  const outlet = h('div', { class: 'outlet' });
  const el = h('div', { class: 'shell' },
    h('header', { class: 'shell-head' },
      h('a', { class: 'wordmark', href: '#/paths', 'aria-label': 'Architect home' }, 'Architect'),
      h('nav', { class: 'nav', 'aria-label': 'Sections' }, navPaths, navBlue),
      h('div', { class: 'head-right' },
        !configured ? h('span', { class: 'mode-chip', title: 'Data is stored in this browser. Add your Supabase keys to config.js to sync.' }, h('i'), 'Local') : null,
        clock, themeBtn, userBtn)),
    outlet);
  root.append(el);

  const tick = setInterval(() => { clock.textContent = fmtClock(); }, 10_000);

  return {
    outlet,
    setActive(view) {
      navPaths.classList.toggle('active', view === 'paths');
      navBlue.classList.toggle('active', view === 'blueprint' || view === 'board');
      navPaths.toggleAttribute('aria-current', view === 'paths');
      navBlue.toggleAttribute('aria-current', view === 'blueprint');
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
