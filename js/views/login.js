import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api, configured, friendlyError } from '../data/api.js';

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;

export function mountLogin(root, { onDone }) {
  let mode = 'signin'; // 'signin' | 'signup'
  let busy = false;

  const word = h('h1', { class: 'login-word', 'aria-label': 'Architect' },
    [...'ARCHITECT'].map((c, i) => h('span', { style: { '--i': i } }, c)));

  const user = h('input', { class: 'input', name: 'username', autocomplete: 'username', autocapitalize: 'none', spellcheck: false, required: true, maxlength: 32, placeholder: 'yourname' });
  const pass = h('input', { class: 'input', name: 'password', type: 'password', autocomplete: 'current-password', required: true, placeholder: '••••••••' });
  const pass2 = h('input', { class: 'input', name: 'confirm', type: 'password', autocomplete: 'new-password', placeholder: '••••••••' });
  const confirmField = h('label', { class: 'field', hidden: true }, h('span', { class: 'field-label' }, 'Confirm password'), pass2);
  const error = h('p', { class: 'login-error', role: 'alert', hidden: true });
  const submit = h('button', { class: 'btn btn-primary login-submit', type: 'submit' }, 'Sign in');
  const swap = h('button', { class: 'login-swap', type: 'button' });
  const reveal = h('button', { class: 'icon-btn sm login-reveal', type: 'button', 'aria-label': 'Show password' }, icon('eye', 16));

  const form = h('form', { class: 'login-form', novalidate: true },
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Username'), user),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Password'), h('div', { class: 'login-pass' }, pass, reveal)),
    confirmField,
    error,
    submit,
    swap,
  );

  const mode_note = configured
    ? h('span', {}, h('i', { class: 'status-dot on' }), 'Synced with Supabase')
    : h('span', {}, h('i', { class: 'status-dot' }), 'Local mode — data stays in this browser');

  const el = h('main', { class: 'login' },
    h('div', { class: 'login-grid', 'aria-hidden': 'true' }),
    h('section', { class: 'login-card' },
      word,
      h('p', { class: 'login-sub' }, 'Paths for what you do. Blueprint for what you plan.'),
      form,
    ),
    h('footer', { class: 'login-foot' }, mode_note),
  );

  function setMode(m) {
    mode = m;
    const up = m === 'signup';
    confirmField.hidden = !up;
    pass.autocomplete = up ? 'new-password' : 'current-password';
    submit.textContent = up ? 'Create account' : 'Sign in';
    swap.replaceChildren(up ? 'Have an account? ' : 'New here? ', h('u', {}, up ? 'Sign in' : 'Create an account'));
    showError('');
  }

  function showError(msg) {
    error.hidden = !msg;
    error.textContent = msg || '';
  }

  reveal.addEventListener('click', () => {
    const show = pass.type === 'password';
    pass.type = show ? 'text' : 'password';
    pass2.type = pass.type;
    reveal.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    reveal.replaceChildren(icon(show ? 'eyeOff' : 'eye', 16));
  });
  swap.addEventListener('click', () => setMode(mode === 'signin' ? 'signup' : 'signin'));
  user.addEventListener('input', () => { user.value = user.value.toLowerCase().replace(/\s/g, ''); });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    const u = user.value.trim().toLowerCase();
    const p = pass.value;
    if (!USERNAME_RE.test(u)) return showError('Usernames are 3–32 characters: letters, numbers, dot, dash or underscore.');
    if (p.length < 6) return showError('Passwords need at least 6 characters.');
    if (mode === 'signup' && p !== pass2.value) return showError('Passwords don’t match.');
    busy = true;
    submit.disabled = true;
    submit.textContent = mode === 'signup' ? 'Creating…' : 'Signing in…';
    showError('');
    try {
      const s = mode === 'signup' ? await api.auth.signUp(u, p) : await api.auth.signIn(u, p);
      onDone(s);
    } catch (err) {
      showError(friendlyError(err));
      busy = false;
      submit.disabled = false;
      submit.textContent = mode === 'signup' ? 'Create account' : 'Sign in';
    }
  });

  setMode('signin');
  root.append(el);
  requestAnimationFrame(() => { el.classList.add('in'); user.focus(); });
  return { destroy() { el.remove(); } };
}
