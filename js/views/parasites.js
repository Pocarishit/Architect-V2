// Parasites: problems the team has to break through together.
// Every member checks themselves off ("I can do it"). The wall stays standing until everyone has —
// whoever is through first becomes the guide for the others.
import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { toast, dialog, confirmDialog, menu } from '../core/ui.js';
import { uid } from '../core/util.js';
import { api, friendlyError } from '../data/api.js';

const DAY = 86_400_000;
const pad = (n) => String(n).padStart(2, '0');

function dueText(p, now = Date.now()) {
  if (!p.deadline) return { text: 'No deadline', tone: 'mute' };
  const [y, m, d] = String(p.deadline).slice(0, 10).split('-').map(Number);
  const end = new Date(y, m - 1, d, 23, 59, 59).getTime();
  if (p.broken_at) {
    const at = new Date(p.broken_at).getTime();
    return at <= end ? { text: 'Broken on time', tone: 'ok' } : { text: `Broken ${Math.ceil((at - end) / DAY)}d late`, tone: 'mute' };
  }
  const left = end - now;
  if (left < 0) return { text: `${Math.ceil(-left / DAY)}d overdue`, tone: 'late' };
  const days = Math.floor(left / DAY);
  const hrs = Math.floor((left % DAY) / 3_600_000);
  return { text: days ? `${days}d ${pad(hrs)}h left` : `${hrs}h ${pad(Math.floor((left % 3_600_000) / 60_000))}m left`, tone: days < 2 ? 'soon' : 'run' };
}

export function mountParasites(root) {
  const session = api.auth.current();
  const meId = session?.user?.id;
  const names = new Map([[meId, session?.user?.username || 'you']]);
  let list = [];
  let loading = true;
  let loadError = null;
  let filter = 'standing';
  const local = api.mode === 'local';

  const el = h('div', { class: 'view parasites' });
  root.append(el);
  const fail = (e) => toast(friendlyError(e), { tone: 'error', ms: 5000 });

  const membersOf = (p) => [p.user_id, ...(p.members || [])];
  const checked = (p, id) => !!(p.checks || {})[id];
  const isBroken = (p) => membersOf(p).every((id) => checked(p, id));
  const nameOf = (id) => names.get(id) || 'member';

  async function load() {
    try {
      list = await api.db.select('parasites', { order: 'created_at.desc' });
      if (!local) {
        try { (await api.rpc('parasite_people', {})).forEach((r) => names.set(r.user_id, r.username)); } catch {}
      }
      loadError = null;
    } catch (e) {
      loadError = friendlyError(e);
    }
    loading = false;
    render();
  }

  /* ---------------- Render ---------------- */

  function render() {
    el.replaceChildren(header(), loading ? loader() : loadError ? errorView() : body());
  }

  const loader = () => h('div', { class: 'empty' }, h('span', { class: 'dots-loader' }, h('i'), h('i'), h('i')));
  const errorView = () => h('div', { class: 'empty' },
    h('p', { class: 'empty-text' }, loadError),
    h('p', { class: 'empty-text px-hint' }, 'Parasites needs its table — run supabase/nov7.sql in the Supabase SQL editor.'),
    h('button', { class: 'btn', onclick: () => { loading = true; render(); load(); } }, 'Try again'));

  function header() {
    return h('header', { class: 'view-head px-head' },
      h('div', { class: 'px-head-main' },
        h('h1', { class: 'paths-title px-title' }, 'Parasites'),
        h('p', { class: 'px-sub' }, 'Problems we break through together. The stronger person at a wall is the guide — nobody gets left outside.')),
      h('button', { class: 'btn btn-primary sm', type: 'button', onclick: () => edit(null) }, icon('plus', 14), h('span', {}, 'New problem')));
  }

  function body() {
    const standing = list.filter((p) => !isBroken(p));
    const broken = list.filter(isBroken);
    const shown = filter === 'standing' ? standing : filter === 'broken' ? broken : list;
    const chip = (id, label, n) => h('button', { class: ['tk-chip', filter === id && 'is-on'], type: 'button', 'aria-pressed': String(filter === id), onclick: () => { filter = id; render(); } },
      label, h('span', { class: 'px-chip-n' }, String(n)));
    return h('div', { class: 'px-body' },
      h('div', { class: 'tk-chips' }, chip('standing', 'Standing', standing.length), chip('broken', 'Broken', broken.length), chip('all', 'All', list.length)),
      shown.length
        ? h('div', { class: 'px-grid' }, shown.map(card))
        : h('div', { class: 'px-empty' },
          h('div', { class: 'px-empty-wall', 'aria-hidden': 'true' }, Array.from({ length: 28 }, (_, i) => h('i', { class: i % 7 === 3 ? 'off' : null }))),
          h('p', {}, filter === 'broken' ? 'No walls broken yet.' : list.length ? 'Every wall is down.' : 'List a problem you’re stuck behind, add who you’re breaking it with, and set a deadline.'),
          filter !== 'broken' ? h('button', { class: 'btn sm', type: 'button', onclick: () => edit(null) }, icon('plus', 14), h('span', {}, 'New problem')) : null));
  }

  function card(p) {
    const people = membersOf(p);
    const done = people.filter((id) => checked(p, id)).length;
    const broken = done === people.length;
    const due = dueText(p);
    return h('article', { class: ['px-card', broken && 'is-broken'] },
      h('header', { class: 'px-card-top' },
        h('span', { class: ['px-verdict', broken ? 'is-broken' : 'is-standing'] }, broken ? icon('check', 11, { weight: 2.8 }) : h('i'), broken ? 'Broken' : 'Standing'),
        h('span', { class: ['px-due', `is-${due.tone}`] }, due.text),
        h('button', { class: 'icon-btn xs', type: 'button', 'aria-label': 'Problem options', onclick: (e) => cardMenu(e.currentTarget, p) }, icon('more', 16))),
      h('h2', { class: 'px-card-title' }, p.title || 'Untitled problem'),
      p.detail ? h('p', { class: 'px-card-detail' }, p.detail) : null,
      // The wall: one block per member, knocked out as each one gets through.
      h('div', { class: 'px-wall', 'aria-label': `${done} of ${people.length} through` },
        people.map((id) => h('i', { class: checked(p, id) ? 'is-out' : null })),
        h('span', { class: 'px-wall-n' }, `${done}/${people.length}`)),
      h('ul', { class: 'px-people' }, people.map((id) => {
        const ok = checked(p, id);
        const role = broken ? null : ok && done < people.length ? 'Guide' : !ok && done > 0 ? 'Learning' : null;
        const self = id === meId;
        return h('li', { class: ['px-person', ok && 'is-ok', self && 'is-me'] },
          h('span', { class: 'tk-av' }, nameOf(id).slice(0, 1).toUpperCase()),
          h('span', { class: 'px-person-name' }, self ? 'You' : nameOf(id)),
          role ? h('span', { class: ['px-role', role === 'Guide' && 'is-guide'] }, role) : null,
          self
            ? h('button', { class: ['px-check', ok && 'is-on'], type: 'button', role: 'switch', 'aria-checked': String(ok), onclick: () => toggle(p, !ok) },
              h('i', {}, ok ? icon('check', 11, { weight: 2.8 }) : null), ok ? 'Demonstrated' : 'I can do it')
            : h('span', { class: ['px-state', ok && 'is-ok'] }, ok ? 'Demonstrated' : 'Not yet'));
      })));
  }

  function cardMenu(anchor, p) {
    const owner = p.user_id === meId;
    menu(anchor, [
      { label: 'Edit', icon: 'edit', onSelect: () => edit(p) },
      { label: 'Add member', icon: 'users', onSelect: () => addMember(p) },
      '-',
      owner
        ? { label: 'Delete problem', icon: 'trash', danger: true, onSelect: () => remove(p) }
        : { label: 'Leave problem', icon: 'logout', danger: true, onSelect: () => leave(p) },
    ], { align: 'end' });
  }

  /* ---------------- Actions ---------------- */

  async function toggle(p, val) {
    const before = { ...(p.checks || {}) };
    p.checks = { ...before };
    if (val) p.checks[meId] = true; else delete p.checks[meId];
    p.broken_at = isBroken(p) ? p.broken_at || new Date().toISOString() : null;
    render();
    try {
      if (local) await api.db.update('parasites', p.id, { checks: p.checks, broken_at: p.broken_at });
      else Object.assign(p, await api.rpc('parasite_check', { p: p.id, val }));
      if (val && isBroken(p)) toast('Wall broken.', { ms: 2400 });
      render();
    } catch (e) { p.checks = before; render(); fail(e); }
  }

  async function edit(p) {
    const title = h('input', { class: 'input', value: p?.title || '', maxlength: 120, placeholder: 'e.g. Finish and publish a video on my own', 'aria-label': 'Problem' });
    const detail = h('textarea', { class: 'input', rows: 3, maxlength: 1000, placeholder: 'What counts as broken — e.g. you can actually do it, not just follow along.', value: p?.detail || '', 'aria-label': 'Completion condition' });
    const deadline = h('input', { class: 'input', type: 'date', value: p?.deadline ? String(p.deadline).slice(0, 10) : '', 'aria-label': 'Deadline' });
    const who = p ? null : h('input', { class: 'input', placeholder: local ? 'Needs Supabase sync' : 'Usernames, comma separated', disabled: local, autocapitalize: 'none', spellcheck: false, 'aria-label': 'Members' });
    const ok = await dialog({
      title: p ? 'Edit problem' : 'New problem',
      width: 520,
      body: h('div', { class: 'stack' },
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Problem'), title),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Broken when'), detail),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Deadline'), deadline),
        who ? h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Breaking it with'), who) : null),
      actions: [{ label: 'Cancel', value: false }, { label: p ? 'Save' : 'Create', primary: true, value: true }],
    });
    if (!ok) return;
    const body = { title: title.value.trim() || 'Untitled problem', detail: detail.value.trim(), deadline: deadline.value || null };
    try {
      if (p) {
        Object.assign(p, body);
        render();
        await api.db.update('parasites', p.id, body);
      } else {
        const row = { id: uid(), ...body, members: [], checks: {} };
        const made = await api.db.insert('parasites', row);
        const item = { ...row, user_id: meId, created_at: new Date().toISOString(), ...(made || {}) };
        list = [item, ...list];
        filter = 'standing';
        render();
        const usernames = (who?.value || '').split(/[,\s]+/).map((x) => x.replace(/^@/, '').trim()).filter(Boolean);
        for (const u of usernames) await addByName(item, u);
      }
    } catch (e) { fail(e); load(); }
  }

  async function addByName(p, name) {
    try {
      const row = await api.rpc('parasite_add', { p: p.id, uname: name });
      Object.assign(p, row);
      try { (await api.rpc('parasite_people', {})).forEach((r) => names.set(r.user_id, r.username)); } catch {}
      render();
    } catch (e) { fail(e); }
  }

  async function addMember(p) {
    if (local) { toast('Members need Supabase sync.'); return; }
    const input = h('input', { class: 'input', placeholder: 'Their username', autocapitalize: 'none', spellcheck: false, 'aria-label': 'Username' });
    const ok = await dialog({
      title: 'Add member',
      body: h('div', { class: 'stack' }, h('p', { class: 'px-hint' }, 'They’ll see this problem and check themselves off. The wall resets until they’re through too.'), input),
      actions: [{ label: 'Cancel', value: false }, { label: 'Add', primary: true, value: true }],
    });
    if (ok && input.value.trim()) await addByName(p, input.value.trim().replace(/^@/, ''));
  }

  async function remove(p) {
    if (!(await confirmDialog(`Delete “${p.title}”?`, 'It disappears for everyone on it.', { ok: 'Delete' }))) return;
    list = list.filter((x) => x.id !== p.id);
    render();
    try { await api.db.remove('parasites', p.id); } catch (e) { fail(e); load(); }
  }

  async function leave(p) {
    if (!(await confirmDialog(`Leave “${p.title}”?`, 'You won’t see it anymore.', { ok: 'Leave' }))) return;
    list = list.filter((x) => x.id !== p.id);
    render();
    try { await api.rpc('parasite_remove', { p: p.id, who: meId }); } catch (e) { fail(e); load(); }
  }

  render();
  load();
  // Teammates' checks arrive on their own.
  const poll = setInterval(() => {
    if (document.hidden || loading || document.querySelector('.dlg')) return;
    load();
  }, 30_000);
  const tick = setInterval(() => { if (!loading && !document.querySelector('.dlg')) el.querySelectorAll('.px-due').length && render(); }, 60_000);

  return { destroy() { clearInterval(poll); clearInterval(tick); el.remove(); } };
}
