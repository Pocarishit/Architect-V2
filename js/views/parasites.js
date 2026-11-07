// Ticket board (formerly Parasites): a ticket tracker for the problems a team has to break through together.
// Open a ticket for a problem, work it like a bug: chat, log every attempt (failed / partly / worked),
// label it and move it across the board — Open → Working on it → Testing → Solved.
// Everyone on a ticket checks "I can do it" once they can; when all have, it's solved.
import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { toast, dialog, confirmDialog, menu } from '../core/ui.js';
import { uid, store } from '../core/util.js';
import { api, friendlyError } from '../data/api.js';
import { go } from '../core/router.js';

const DAY = 86_400_000;
const pad = (n) => String(n).padStart(2, '0');
export const STATUSES = [
  { id: 'open', label: 'Open' },
  { id: 'working', label: 'Working on it' },
  { id: 'testing', label: 'Testing' },
  { id: 'solved', label: 'Solved' },
];
const OUTCOMES = [
  { id: 'failed', label: 'Failed' },
  { id: 'partial', label: 'Partly' },
  { id: 'worked', label: 'Worked' },
];
const statusLabel = (id) => STATUSES.find((s) => s.id === id)?.label || 'Open';

function dueText(p, now = Date.now()) {
  if (!p.deadline) return { text: 'No deadline', tone: 'mute' };
  const [y, m, d] = String(p.deadline).slice(0, 10).split('-').map(Number);
  const end = new Date(y, m - 1, d, 23, 59, 59).getTime();
  if (p.status === 'solved') {
    const at = new Date(p.broken_at || p.updated_at || now).getTime();
    return at <= end ? { text: 'Solved on time', tone: 'ok' } : { text: `Solved ${Math.ceil((at - end) / DAY)}d late`, tone: 'mute' };
  }
  const left = end - now;
  if (left < 0) return { text: `${Math.ceil(-left / DAY)}d overdue`, tone: 'late' };
  const days = Math.floor(left / DAY);
  const hrs = Math.floor((left % DAY) / 3_600_000);
  return { text: days ? `${days}d ${pad(hrs)}h left` : `${hrs}h ${pad(Math.floor((left % 3_600_000) / 60_000))}m left`, tone: days < 2 ? 'soon' : 'run' };
}

// opts.embedded: lives inside a canvas widget — tickets open in place instead of changing the page.
// opts.onUnread(n): how many messages from others you haven't seen yet (red badge on the widget).
//   exclude: status columns shown elsewhere on the canvas · only: show just this status column
//   onDetach(status, at): pull a column out onto the canvas · onSnap(): put a detached column back
export function mountParasites(root, initialId = null, opts = {}) {
  const embedded = !!opts.embedded;
  let exclude = new Set(opts.exclude || []);
  const instance = Math.random().toString(36).slice(2);
  // Writes from one Ticket widget refresh the others (e.g. a detached column).
  const db = embedded ? new Proxy(api.db, {
    get(t, k) {
      const fn = t[k];
      if (typeof fn !== 'function' || !['insert', 'update', 'remove'].includes(k)) return fn?.bind?.(t) ?? fn;
      return async (...args) => {
        const out = await fn.apply(t, args);
        window.dispatchEvent(new CustomEvent('architect:tickets-changed', { detail: { from: instance } }));
        return out;
      };
    },
  }) : api.db;
  const session = api.auth.current();
  const meId = session?.user?.id;
  const names = new Map([[meId, session?.user?.username || 'you']]);
  let list = [];
  let messages = [];           // everything you can see, oldest first
  let loading = true;
  let loadError = null;
  let layout = store.get('architect.px.layout', 'board'); // 'board' | 'list'
  let labelFilter = null;
  let openId = initialId;      // ticket on screen (null = overview)
  let draft = '';
  let mode = 'msg';            // composer: 'msg' or 'attempt'
  let pending = [];            // files waiting to be sent: [{ id, file, preview }]
  let uploading = false;
  let editingId = null;        // message being edited
  const signed = new Map();    // storage path → signed URL
  let dirty = false;           // a redraw is waiting for you to finish selecting text
  let outcome = 'failed';
  const local = api.mode === 'local';

  const el = h('div', { class: ['view parasites', embedded && 'is-embedded', opts.only && 'is-single'] });
  // Last message you've seen in each ticket → red dots for anything newer from someone else.
  const SEEN = `architect.px.seen.${meId}`;
  let seen = store.get(SEEN, {});
  const unreadOf = (p) => talkOf(p).filter((m) => m.user_id !== meId && m.kind !== 'event' && String(m.created_at) > String(seen[p.id] || '')).length;
  const markSeen = (p) => {
    const last = talkOf(p).at(-1);
    if (!last || String(seen[p.id] || '') >= String(last.created_at)) return;
    seen = { ...store.get(SEEN, {}), [p.id]: last.created_at };
    store.set(SEEN, seen);
    window.dispatchEvent(new CustomEvent('architect:tickets-seen'));
  };
  const reportUnread = () => opts.onUnread?.(list.reduce((n, p) => n + (p.id === openId ? 0 : unreadOf(p)), 0));
  const onSeen = () => { seen = store.get(SEEN, {}); reportUnread(); };
  window.addEventListener('architect:tickets-seen', onSeen);
  let linked = { no: null, rows: [] }; // path tasks that mention the open ticket
  root.append(el);
  const fail = (e) => toast(friendlyError(e), { tone: 'error', ms: 5000 });

  const membersOf = (p) => [p.user_id, ...(p.members || [])];
  const checked = (p, id) => !!(p.checks || {})[id];
  const everyoneThrough = (p) => membersOf(p).every((id) => checked(p, id));
  const nameOf = (id) => names.get(id) || 'member';
  const statusOf = (p) => p.status || (p.broken_at ? 'solved' : 'open');
  const talkOf = (p) => messages.filter((m) => m.parasite_id === p.id);
  const attemptsOf = (p) => talkOf(p).filter((m) => m.kind === 'attempt');
  const allLabels = () => [...new Set(list.flatMap((p) => p.labels || []))].sort();
  const noOf = (p) => {
    if (p.no) return Number(p.no);
    const order = [...list].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    return order.findIndex((x) => x.id === p.id) + 1;
  };
  const numberOf = (p) => `#${String(noOf(p)).padStart(3, '0')}`;

  async function load() {
    try {
      list = await api.db.select('parasites', { order: 'created_at.desc' });
      try { messages = await api.db.select('parasite_messages', { order: 'created_at.asc' }); } catch { messages = []; }
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

  // True while you have text highlighted in this view — redrawing then would clear it.
  const selecting = () => { const sel = window.getSelection?.(); return !!sel && !sel.isCollapsed && el.contains(sel.anchorNode); };
  const softRender = () => { if (selecting() || editingId) dirty = true; else render(); };

  function render() {
    dirty = false;
    const ticket = openId && list.find((p) => p.id === openId);
    const keep = el.querySelector('.px-chat-list');
    const atBottom = !keep || keep.scrollHeight - keep.scrollTop - keep.clientHeight < 40;
    const typing = document.activeElement?.hasAttribute?.('data-draft');
    if (ticket) el.replaceChildren(ticketView(ticket));
    else el.replaceChildren(...[header(), loading ? loader() : loadError ? errorView() : overview()].filter(Boolean));
    const chat = el.querySelector('.px-chat-list');
    if (chat && atBottom) chat.scrollTop = chat.scrollHeight;
    if (typing) el.querySelector('[data-draft]')?.focus();
    signMissing();
    if (ticket) markSeen(ticket);
    reportUnread();
    if (ticket && linked.no !== noOf(ticket)) loadLinked(ticket);
  }

  // Path tasks whose title mentions this ticket ("#12"), from everyone in your space.
  async function loadLinked(p) {
    const no = noOf(p);
    linked = { no, rows: [], loading: true };
    try {
      if (local) {
        const ts = await api.db.select('path_tasks', {});
        const re = new RegExp(`#0*${no}(?!\\d)`);
        linked.rows = ts.filter((t) => re.test(t.title || '')).map((t) => ({ ...t, username: names.get(t.user_id) || 'you' }));
      } else linked.rows = (await api.rpc('ticket_tasks', { ticket_no: no })) || [];
    } catch { linked.rows = []; }
    linked.loading = false;
    if (openId === p.id) softRender();
  }

  // Signed links for attachments (private bucket), fetched in one batch.
  let signing = false;
  async function signMissing() {
    if (signing) return;
    const paths = messages.flatMap((m) => (m.files || []).map((f) => f.path)).filter((x) => x && !signed.has(x));
    if (!paths.length) return;
    signing = true;
    try {
      const map = await api.media.sign(paths);
      for (const x of paths) signed.set(x, map[x] || null);
      softRender();
    } catch {} finally { signing = false; }
  }
  document.addEventListener('selectionchange', onSelChange);
  function onSelChange() { if (dirty && !selecting() && !editingId) render(); }

  const loader = () => h('div', { class: 'empty' }, h('span', { class: 'dots-loader' }, h('i'), h('i'), h('i')));
  const errorView = () => h('div', { class: 'empty' },
    h('p', { class: 'empty-text' }, loadError),
    h('p', { class: 'empty-text px-hint' }, 'The Ticket board needs its tables — run supabase/nov7.sql and supabase/space.sql in the Supabase SQL editor.'),
    h('button', { class: 'btn', onclick: () => { loading = true; render(); load(); } }, 'Try again'));

  function header() {
    if (opts.only) return null;
    return h('header', { class: 'view-head px-head' },
      embedded ? h('div', { class: 'px-head-main' }) : h('div', { class: 'px-head-main' },
        h('h1', { class: 'paths-title px-title' }, 'Ticket board'),
        h('p', { class: 'px-sub' }, 'Open a ticket for anything you’re stuck behind. Work it like a bug — talk it through, log every attempt, move it along until everyone can do it.')),
      h('div', { class: 'px-head-actions' },
        h('div', { class: 'subtabs px-layout', role: 'tablist', 'aria-label': 'Layout' },
          [['board', 'Board'], ['list', 'List']].map(([id, label]) => h('button', {
            class: ['subtab', layout === id && 'is-on'], type: 'button', role: 'tab', 'aria-selected': String(layout === id),
            onclick: () => { layout = id; store.set('architect.px.layout', id); render(); },
          }, label))),
        h('button', { class: 'btn btn-primary sm', type: 'button', onclick: () => edit(null) }, icon('plus', 14), h('span', {}, 'New ticket'))));
  }

  function overview() {
    if (opts.only) return h('div', { class: 'px-body' }, board(list));
    if (!list.length) {
      return h('div', { class: 'px-empty' },
        h('div', { class: 'px-empty-wall', 'aria-hidden': 'true' }, Array.from({ length: 28 }, (_, i) => h('i', { class: i % 7 === 3 ? 'off' : null }))),
        embedded ? null : h('p', {}, 'Open a ticket for a problem you’re stuck behind, add who you’re breaking it with, and set a deadline.'),
        h('button', { class: 'btn sm', type: 'button', onclick: () => edit(null) }, icon('plus', 14), h('span', {}, 'New ticket')));
    }
    const labels = allLabels();
    const shown = labelFilter ? list.filter((p) => (p.labels || []).includes(labelFilter)) : list;
    return h('div', { class: 'px-body' },
      labels.length ? h('div', { class: 'tk-chips px-label-filter' },
        h('button', { class: ['tk-chip', !labelFilter && 'is-on'], type: 'button', onclick: () => { labelFilter = null; render(); } }, 'All'),
        labels.map((l) => h('button', { class: ['tk-chip', labelFilter === l && 'is-on'], type: 'button', onclick: () => { labelFilter = labelFilter === l ? null : l; render(); } }, h('i', { class: 'px-label-dot' }), l))) : null,
      layout === 'board' ? board(shown) : listView(shown));
  }

  /* Board: one column per status; drag a ticket to move it. */
  function board(items) {
    const cols = STATUSES.filter((st) => (opts.only ? st.id === opts.only : !exclude.has(st.id)));
    if (!cols.length) return h('p', { class: 'wg-empty' }, 'Every column is out on the canvas.');
    return h('div', { class: 'px-board' }, cols.map((st) => {
      const col = items.filter((p) => statusOf(p) === st.id);
      return h('section', {
        class: ['px-col', `is-${st.id}`], 'data-status': st.id,
        ondragover: (e) => { e.preventDefault(); e.currentTarget.classList.add('is-over'); },
        ondragleave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) e.currentTarget.classList.remove('is-over'); },
        ondrop: (e) => {
          e.preventDefault();
          e.currentTarget.classList.remove('is-over');
          const p = list.find((x) => x.id === e.dataTransfer.getData('text/ticket'));
          if (p && statusOf(p) !== st.id) setStatus(p, st.id);
        },
      },
        h('header', { class: 'px-col-head', title: embedded ? (opts.only ? 'Drag onto the Ticket board to snap back' : 'Drag out of the widget to put it on the canvas') : null },
          h('span', { class: 'px-col-title' }, h('i', { class: 'px-status-dot' }), st.label),
          h('span', { class: 'px-col-n' }, String(col.length)),
          embedded && !opts.only && opts.onDetach ? h('button', { class: 'icon-btn xs px-col-out', type: 'button', title: 'Detach to canvas', 'aria-label': `Detach ${st.label} to canvas`, onclick: () => opts.onDetach(st.id, null) }, icon('external', 13)) : null,
          embedded && opts.only && opts.onSnap ? h('button', { class: 'icon-btn xs px-col-out', type: 'button', title: 'Snap back', 'aria-label': 'Snap back into Ticket board', onclick: () => opts.onSnap() }, icon('collapse', 13)) : null),
        h('div', { class: 'px-col-list' },
          col.length ? col.map(ticketCard) : h('p', { class: 'px-col-empty' }, st.id === 'solved' ? 'Nothing solved yet' : 'Drop tickets here')));
    }));
  }

  function ticketCard(p) {
    const people = membersOf(p);
    const done = people.filter((id) => checked(p, id)).length;
    const due = dueText(p);
    const tries = attemptsOf(p);
    const talk = talkOf(p).filter((m) => m.kind !== 'event');
    const unread = unreadOf(p);
    return h('article', {
      class: ['px-tcard', statusOf(p) === 'solved' && 'is-solved', unread && 'has-unread'], draggable: 'true', tabindex: '0',
      ondragstart: (e) => { e.dataTransfer.setData('text/ticket', p.id); e.dataTransfer.effectAllowed = 'move'; e.currentTarget.classList.add('is-dragging'); },
      ondragend: (e) => e.currentTarget.classList.remove('is-dragging'),
      onclick: () => openTicket(p.id),
      onkeydown: (e) => { if (e.key === 'Enter') openTicket(p.id); },
    },
      h('div', { class: 'px-tcard-top' },
        h('span', { class: 'px-no' }, numberOf(p)),
        h('span', { class: ['px-due', `is-${due.tone}`] }, due.text)),
      h('h3', { class: 'px-tcard-title' }, p.title || 'Untitled problem'),
      (p.labels || []).length ? h('div', { class: 'px-labels' }, p.labels.map((l) => h('span', { class: 'px-label' }, l))) : null,
      h('div', { class: 'px-tcard-foot' },
        h('div', { class: 'cd-avatars' }, people.slice(0, 4).map((id) => h('span', { class: ['tk-av', checked(p, id) && 'is-through'], title: `${nameOf(id)}${checked(p, id) ? ' · can do it' : ''}` }, nameOf(id).slice(0, 1).toUpperCase()))),
        h('span', { class: 'px-meta' }, icon('flask', 13), String(tries.length)),
        h('span', { class: ['px-meta', unread && 'is-unread'] }, icon('chat', 13), String(talk.length), unread ? h('b', { class: 'px-unread', 'aria-label': `${unread} unread` }, String(unread)) : null),
        h('span', { class: 'px-meta px-meta-wall' }, `${done}/${people.length}`)));
  }

  /* List: one row per ticket. */
  function listView(items) {
    const order = STATUSES.map((s) => s.id);
    const sorted = [...items].sort((a, b) => order.indexOf(statusOf(a)) - order.indexOf(statusOf(b)) || String(b.created_at).localeCompare(String(a.created_at)));
    return h('div', { class: 'px-list' }, sorted.map((p) => {
      const people = membersOf(p);
      const done = people.filter((id) => checked(p, id)).length;
      const due = dueText(p);
      const last = talkOf(p).at(-1);
      const unread = unreadOf(p);
      return h('button', { class: ['px-row', statusOf(p) === 'solved' && 'is-broken', unread && 'has-unread'], type: 'button', onclick: () => openTicket(p.id) },
        h('span', { class: 'px-row-no' }, numberOf(p), unread ? h('b', { class: 'px-unread' }, String(unread)) : null),
        h('div', { class: 'px-row-main' },
          h('span', { class: 'px-row-title' }, p.title || 'Untitled problem'),
          h('span', { class: 'px-row-last' }, last ? lastLine(last) : (p.detail || 'No messages yet'))),
        h('div', { class: 'px-row-side' },
          statusPill(statusOf(p)),
          h('span', { class: ['px-due', `is-${due.tone}`] }, due.text)),
        h('div', { class: 'px-row-meta' },
          (p.labels || []).slice(0, 2).map((l) => h('span', { class: 'px-label' }, l)),
          h('span', { class: 'px-row-talk' }, icon('flask', 13), String(attemptsOf(p).length)),
          h('span', { class: 'px-row-wall' }, `${done}/${people.length}`)));
    }));
  }

  const lastLine = (m) => {
    const who = m.user_id === meId ? 'You' : nameOf(m.user_id);
    if (m.kind === 'event') return `${who} ${m.body}`;
    if (m.kind === 'attempt') return `${who} · attempt ${OUTCOMES.find((o) => o.id === m.outcome)?.label.toLowerCase() || ''}: ${m.body}`;
    return `${who}: ${m.body}`;
  };
  const statusPill = (s) => h('span', { class: ['px-status', `is-${s}`] }, s === 'solved' ? icon('check', 11, { weight: 2.8 }) : h('i'), statusLabel(s));

  /* ---------------- A ticket ---------------- */

  function openTicket(id) {
    // A detached column hands the ticket to the main Ticket board.
    if (embedded && opts.only) { const p = list.find((x) => x.id === id); if (p) window.dispatchEvent(new CustomEvent('architect:open-ticket', { detail: { no: noOf(p) } })); return; }
    linked = { no: null, rows: [] };
    if (embedded) { openId = id; draft = ''; mode = 'msg'; editingId = null; render(); return; }
    go(`parasites/${id}`);
  }
  function closeTicket() {
    if (embedded) { openId = null; editingId = null; render(); return; }
    go('parasites');
  }
  // "#12" chips in path tasks open the ticket here.
  const primary = () => !embedded || !opts.isPrimary || opts.isPrimary();
  const onOpenTicket = (e) => {
    if (!primary()) return;
    const no = Number(e.detail?.no);
    const p = list.find((x) => noOf(x) === no);
    if (!p) { toast(loading ? 'Tickets are still loading.' : `No ticket #${String(no).padStart(3, '0')}.`); return; }
    if (embedded) { opts.onReveal?.(); openTicket(p.id); }
    else go(`parasites/${p.id}`);
  };
  window.addEventListener('architect:open-ticket', onOpenTicket);
  // A weekly achievement turned into a problem to break.
  const onNewTicket = (e) => { if (primary()) { opts.onReveal?.(); edit(null, e.detail || {}); } };
  window.addEventListener('architect:new-ticket', onNewTicket);

  function ticketView(p) {
    return h('div', { class: 'px-ticket' },
      h('div', { class: 'px-ticket-bar' },
        h('button', { class: 'pback', type: 'button', onclick: closeTicket }, icon('back', 16), 'Ticket board'),
        h('span', { class: 'px-ticket-no' }, numberOf(p))),
      h('div', { class: 'px-ticket-grid' },
        h('div', { class: 'px-ticket-info' }, infoCard(p)),
        chatPanel(p)));
  }

  function infoCard(p) {
    const people = membersOf(p);
    const done = people.filter((id) => checked(p, id)).length;
    const due = dueText(p);
    const st = statusOf(p);
    const tries = attemptsOf(p);
    const worked = tries.filter((t) => t.outcome === 'worked').length;
    const labelInput = h('input', {
      class: 'px-label-input', placeholder: '+ Label', maxlength: 24, list: 'px-label-options', 'aria-label': 'Add label',
      onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); addLabel(p, e.target.value); } },
      onchange: (e) => { if (allLabels().includes(e.target.value)) addLabel(p, e.target.value); },
    });
    return h('article', { class: ['px-card', st === 'solved' && 'is-broken'] },
      h('header', { class: 'px-card-top' },
        statusPill(st),
        h('span', { class: ['px-due', `is-${due.tone}`] }, due.text),
        h('button', { class: 'icon-btn xs', type: 'button', 'aria-label': 'Ticket options', onclick: (e) => cardMenu(e.currentTarget, p) }, icon('more', 16))),
      h('h2', { class: 'px-card-title' }, p.title || 'Untitled problem'),
      p.detail ? h('div', { class: 'px-card-detail' }, h('span', { class: 'tk-stat-label' }, 'Solved when'), h('p', {}, p.detail)) : null,
      // Where it is in the workflow.
      h('div', { class: 'px-steps', role: 'radiogroup', 'aria-label': 'Status' }, STATUSES.map((s, i) => h('button', {
        class: ['px-step', s.id === st && 'is-on', STATUSES.findIndex((x) => x.id === st) > i && 'is-past'], type: 'button', role: 'radio', 'aria-checked': String(s.id === st),
        onclick: () => { if (s.id !== st) setStatus(p, s.id); },
      }, h('i'), h('span', {}, s.label)))),
      h('div', { class: 'px-labels is-edit' },
        (p.labels || []).map((l) => h('span', { class: 'px-label' }, l, h('button', { type: 'button', 'aria-label': `Remove ${l}`, onclick: () => removeLabel(p, l) }, icon('close', 10)))),
        labelInput,
        h('datalist', { id: 'px-label-options' }, allLabels().filter((l) => !(p.labels || []).includes(l)).map((l) => h('option', { value: l })))),
      h('div', { class: 'px-stats' },
        h('div', {}, h('b', {}, String(tries.length)), h('span', {}, tries.length === 1 ? 'Attempt' : 'Attempts')),
        h('div', {}, h('b', {}, String(worked)), h('span', {}, 'Worked')),
        h('div', {}, h('b', {}, `${done}/${people.length}`), h('span', {}, 'Can do it'))),
      h('ul', { class: 'px-people' }, people.map((id) => {
        const ok = checked(p, id);
        const role = done === people.length ? null : ok ? 'Guide' : done > 0 ? 'Learning' : null;
        const self = id === meId;
        return h('li', { class: ['px-person', ok && 'is-ok', self && 'is-me'] },
          h('span', { class: 'tk-av' }, nameOf(id).slice(0, 1).toUpperCase()),
          h('span', { class: 'px-person-name' }, self ? 'You' : nameOf(id)),
          role ? h('span', { class: ['px-role', role === 'Guide' && 'is-guide'] }, role) : null,
          self
            ? h('button', { class: ['px-check', ok && 'is-on'], type: 'button', role: 'switch', 'aria-checked': String(ok), onclick: () => toggle(p, !ok) },
              h('i', {}, ok ? icon('check', 11, { weight: 2.8 }) : null), ok ? 'Can do it' : 'I can do it')
            : h('span', { class: ['px-state', ok && 'is-ok'] }, ok ? 'Can do it' : 'Not yet'));
      })),
      !people.includes(meId) && !local
        ? h('button', { class: 'btn btn-primary sm px-add-member', type: 'button', onclick: () => addByName(p, session?.user?.username) }, icon('plus', 14), h('span', {}, 'Join this ticket'))
        : null,
      h('button', { class: 'btn sm px-add-member', type: 'button', onclick: () => addMember(p) }, icon('users', 14), h('span', {}, 'Add member')),
      linkedView(p));
  }

  function linkedView(p) {
    const rows = linked.no === noOf(p) ? linked.rows : [];
    return h('div', { class: 'px-linked' },
      h('span', { class: 'tk-stat-label' }, 'Linked tasks'),
      rows.length ? h('ul', {}, rows.map((t) => h('li', { class: t.done ? 'is-done' : null },
        h('i', { class: 'px-linked-check' }, t.done ? icon('check', 10, { weight: 2.6 }) : null),
        h('span', { class: 'px-linked-title' }, t.title),
        h('span', { class: 'px-linked-who' }, t.user_id === meId ? 'You' : (t.username || nameOf(t.user_id))))))
        : h('p', { class: 'px-hint' }, linked.loading ? 'Looking…' : `Write ${numberOf(p)} in a Path task to link it here.`));
  }

  function chatPanel(p) {
    const talk = talkOf(p);
    let n = 0;
    const attemptNo = new Map(talk.filter((m) => m.kind === 'attempt').map((m) => [m.id, ++n]));
    const input = h('textarea', {
      class: 'input tk-talk-input', rows: 1, maxlength: 2000, value: draft, 'data-draft': '',
      placeholder: mode === 'attempt' ? 'What did you try, and what happened?' : 'Message the team…', 'aria-label': mode === 'attempt' ? 'Attempt' : 'Message',
      oninput: (e) => { draft = e.target.value; e.target.style.height = 'auto'; e.target.style.height = `${Math.min(160, e.target.scrollHeight)}px`; },
      onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(p); } },
    });
    let lastDay = '';
    return h('section', {
      class: 'px-chat', 'aria-label': 'Ticket chat',
      onpaste: (e) => { const files = [...(e.clipboardData?.files || [])]; if (files.length) { e.preventDefault(); addFiles(files); } },
      ondragover: (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); e.currentTarget.classList.add('is-drop'); } },
      ondragleave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) e.currentTarget.classList.remove('is-drop'); },
      ondrop: (e) => { e.currentTarget.classList.remove('is-drop'); if (e.dataTransfer?.files?.length) { e.preventDefault(); addFiles([...e.dataTransfer.files]); } },
    },
      h('header', { class: 'px-chat-head' },
        h('span', { class: 'tk-stat-label' }, 'Thread'),
        h('span', { class: 'px-chat-n' }, talk.length ? String(talk.length) : '')),
      h('div', { class: 'px-chat-list' },
        talk.length ? talk.map((m) => {
          const day = new Date(m.created_at).toDateString();
          const sep = day !== lastDay ? h('div', { class: 'px-chat-day' }, new Date(m.created_at).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })) : null;
          lastDay = day;
          return [sep, messageView(m, attemptNo.get(m.id))];
        }) : h('div', { class: 'px-chat-empty' }, h('p', {}, 'Describe what’s blocking. When someone tries something, log it as an attempt so the team can see what’s been ruled out.'))),
      h('div', { class: 'px-compose' },
        h('div', { class: 'px-compose-mode' },
          h('div', { class: 'px-seg', role: 'tablist' },
            [['msg', 'Message'], ['attempt', 'Log attempt']].map(([id, label]) => h('button', {
              class: ['px-seg-btn', mode === id && 'is-on'], type: 'button', role: 'tab', 'aria-selected': String(mode === id),
              onclick: () => { mode = id; render(); el.querySelector('[data-draft]')?.focus(); },
            }, id === 'attempt' ? icon('flask', 12) : icon('chat', 12), label))),
          mode === 'attempt' ? h('div', { class: 'px-outcomes', role: 'radiogroup', 'aria-label': 'Outcome' },
            OUTCOMES.map((o) => h('button', {
              class: ['px-outcome', `is-${o.id}`, outcome === o.id && 'is-on'], type: 'button', role: 'radio', 'aria-checked': String(outcome === o.id),
              onclick: () => { outcome = o.id; render(); el.querySelector('[data-draft]')?.focus(); },
            }, o.label))) : null),
        pending.length ? h('div', { class: 'px-pending' }, pending.map((f) => h('span', { class: 'px-pending-item' },
          f.preview ? h('img', { src: f.preview, alt: '' }) : icon('file', 14),
          h('span', { class: 'px-file-name' }, f.file.name),
          h('button', { type: 'button', 'aria-label': `Remove ${f.file.name}`, onclick: () => dropPending(f.id) }, icon('close', 11))))) : null,
        h('div', { class: 'px-chat-compose' },
          h('label', { class: 'icon-btn px-attach', title: 'Attach files', 'aria-label': 'Attach files' },
            icon('paperclip', 17),
            h('input', { type: 'file', multiple: true, hidden: true, onchange: (e) => { addFiles([...e.target.files]); e.target.value = ''; } })),
          input,
          h('button', { class: ['icon-btn', 'tk-talk-send', uploading && 'is-busy'], type: 'button', 'aria-label': 'Send', disabled: uploading, onclick: () => send(p) },
            uploading ? h('span', { class: 'dots-loader sm' }, h('i'), h('i'), h('i')) : icon('arrow', 16)))));
  }

  const fmtSize = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

  function filesView(m) {
    const files = m.files || [];
    if (!files.length) return null;
    return h('div', { class: 'px-files' }, files.map((f) => {
      const url = f.preview || signed.get(f.path);
      if (/^image\//.test(f.type) && url) {
        return h('a', { class: 'px-file-img', href: url, target: '_blank', rel: 'noopener', title: f.name }, h('img', { src: url, alt: f.name, loading: 'lazy' }));
      }
      if (/^video\//.test(f.type) && url) return h('video', { class: 'px-file-video', src: url, controls: true, preload: 'metadata' });
      return h('a', { class: ['px-file', !url && 'is-loading'], href: url || null, target: '_blank', rel: 'noopener', download: f.name },
        icon('file', 16), h('span', { class: 'px-file-name' }, f.name), h('span', { class: 'px-file-size' }, fmtSize(f.size || 0)));
    }));
  }

  // Your own messages and attempts can be edited in place.
  function editBox(m) {
    const box = h('textarea', { class: 'input px-edit-input', rows: 2, maxlength: 2000, value: m.body, 'data-edit': m.id, 'aria-label': 'Edit message',
      onkeydown: (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit(m, e.target.value); }
        else if (e.key === 'Escape') { e.preventDefault(); editingId = null; render(); }
      } });
    requestAnimationFrame(() => { box.focus(); box.setSelectionRange(box.value.length, box.value.length); box.style.height = `${box.scrollHeight}px`; });
    return h('div', { class: 'px-edit' }, box,
      h('div', { class: 'px-edit-actions' },
        h('span', {}, 'Enter to save · Esc to cancel'),
        h('button', { class: 'btn sm', type: 'button', onclick: () => { editingId = null; render(); } }, 'Cancel'),
        h('button', { class: 'btn btn-primary sm', type: 'button', onclick: () => saveEdit(m, box.value) }, 'Save')));
  }

  const ownTools = (m) => h('div', { class: 'px-msg-tools' },
    h('button', { class: 'icon-btn xs', type: 'button', 'aria-label': 'Edit', title: 'Edit', onclick: () => { editingId = m.id; render(); } }, icon('edit', 12)),
    h('button', { class: 'icon-btn xs', type: 'button', 'aria-label': 'Delete', title: 'Delete', onclick: () => unsend(m) }, icon('trash', 12)));

  function messageView(m, no) {
    const self = m.user_id === meId;
    const time = new Date(m.created_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
    const stamp = m.edited_at ? `${time} · edited` : time;
    const editing = editingId === m.id;
    if (m.kind === 'event') {
      return h('div', { class: 'px-event' }, h('b', {}, self ? 'You' : nameOf(m.user_id)), ` ${m.body} · ${time}`);
    }
    if (m.kind === 'attempt') {
      const o = OUTCOMES.find((x) => x.id === m.outcome) || OUTCOMES[0];
      return h('div', { class: ['px-attempt', `is-${o.id}`, editing && 'is-editing'] },
        h('header', {},
          h('span', { class: 'px-attempt-no' }, `Attempt ${no || ''}`),
          h('span', { class: ['px-outcome-tag', `is-${o.id}`] }, o.label),
          h('span', { class: 'px-attempt-by' }, `${self ? 'You' : nameOf(m.user_id)} · ${stamp}`),
          self && !editing ? ownTools(m) : null),
        editing ? editBox(m) : m.body ? h('p', { class: 'px-text' }, m.body) : null,
        filesView(m));
    }
    return h('div', { class: ['px-msg', self && 'is-me', editing && 'is-editing'] },
      self ? null : h('span', { class: 'tk-av' }, nameOf(m.user_id).slice(0, 1).toUpperCase()),
      h('div', { class: 'px-msg-body' },
        self ? null : h('b', { class: 'px-msg-name' }, nameOf(m.user_id)),
        editing ? editBox(m) : m.body ? h('p', { class: 'px-text' }, m.body) : null,
        filesView(m),
        h('span', { class: 'px-msg-time' }, stamp)),
      self && !editing ? ownTools(m) : null);
  }

  async function saveEdit(m, text) {
    const body = String(text || '').trim();
    editingId = null;
    if (!body && !(m.files || []).length) { render(); return; }
    if (body === m.body) { render(); return; }
    const prev = { body: m.body, edited_at: m.edited_at };
    m.body = body;
    m.edited_at = new Date().toISOString();
    render();
    try { await db.update('parasite_messages', m.id, { body, edited_at: m.edited_at }); }
    catch (e) { Object.assign(m, prev); render(); fail(e); }
  }

  /* Attachments waiting in the composer */
  function addFiles(fileList) {
    const max = api.media?.maxBytes || 50 * 1024 * 1024;
    for (const file of fileList) {
      if (file.size > max) { toast(`${file.name} is over ${Math.round(max / 1048576)} MB.`, { tone: 'error' }); continue; }
      pending.push({ id: uid(), file, preview: /^image\//.test(file.type) ? URL.createObjectURL(file) : null });
    }
    render();
    el.querySelector('[data-draft]')?.focus();
  }
  function dropPending(id) {
    const f = pending.find((x) => x.id === id);
    if (f?.preview) URL.revokeObjectURL(f.preview);
    pending = pending.filter((x) => x.id !== id);
    render();
  }

  function cardMenu(anchor, p) {
    const owner = p.user_id === meId;
    menu(anchor, [
      { label: 'Edit ticket', icon: 'edit', onSelect: () => edit(p) },
      { label: 'Add member', icon: 'users', onSelect: () => addMember(p) },
      '-',
      { header: 'Move to' },
      ...STATUSES.filter((s) => s.id !== statusOf(p)).map((s) => ({ label: s.label, icon: 'toPaths', onSelect: () => setStatus(p, s.id) })),
      '-',
      owner
        ? { label: 'Delete ticket', icon: 'trash', danger: true, onSelect: () => remove(p) }
        : { label: 'Leave ticket', icon: 'logout', danger: true, onSelect: () => leave(p) },
    ], { align: 'end' });
  }

  /* ---------------- Actions ---------------- */

  // Post into the thread (messages, attempts, and the ticket's own history).
  async function post(p, row) {
    const full = { id: uid(), parasite_id: p.id, kind: 'msg', ...row };
    messages = [...messages, { ...full, user_id: meId, created_at: new Date().toISOString() }];
    render();
    try { await db.insert('parasite_messages', full); }
    catch (e) { messages = messages.filter((m) => m.id !== full.id); render(); throw e; }
  }
  const logEvent = (p, text) => post(p, { kind: 'event', body: text, files: [] }).catch(() => {});

  async function send(p) {
    const body = draft.trim();
    if ((!body && !pending.length) || uploading) return;
    const attempt = mode === 'attempt';
    let files = [];
    if (pending.length) {
      uploading = true;
      render();
      try {
        for (const f of pending) {
          const up = await api.media.upload(f.file);
          files.push({ path: up.path, name: f.file.name, size: f.file.size, type: f.file.type || 'application/octet-stream' });
          if (up.url) signed.set(up.path, up.url);
        }
      } catch (e) { uploading = false; render(); fail(e); return; }
      pending.forEach((f) => f.preview && URL.revokeObjectURL(f.preview));
      pending = [];
      uploading = false;
    }
    draft = '';
    try {
      await post(p, attempt ? { kind: 'attempt', outcome, body, files } : { body, files });
      if (attempt) window.dispatchEvent(new CustomEvent('architect:attempt-logged'));
      const list = el.querySelector('.px-chat-list');
      if (list) list.scrollTop = list.scrollHeight;
      // Something worked: time to test it.
      if (attempt && outcome === 'worked' && ['open', 'working'].includes(statusOf(p))) await setStatus(p, 'testing');
      else if (attempt && statusOf(p) === 'open') await setStatus(p, 'working');
      if (attempt) { mode = 'msg'; outcome = 'failed'; render(); }
    } catch (e) { draft = body; render(); fail(e); }
  }


  async function unsend(m) {
    messages = messages.filter((x) => x.id !== m.id);
    render();
    try { await db.remove('parasite_messages', m.id); } catch (e) { fail(e); load(); }
  }

  async function setStatus(p, status, { quiet = false } = {}) {
    const prev = statusOf(p);
    if (prev === status) return;
    p.status = status;
    render();
    try {
      await db.update('parasites', p.id, { status });
      if (!quiet) logEvent(p, `moved this to ${statusLabel(status)}`);
    } catch (e) { p.status = prev; render(); fail(e); }
  }

  async function saveLabels(p, labels) {
    const prev = p.labels || [];
    p.labels = labels;
    render();
    try { await db.update('parasites', p.id, { labels }); } catch (e) { p.labels = prev; render(); fail(e); }
  }
  function addLabel(p, text) {
    const l = String(text || '').trim().replace(/\s+/g, ' ').toLowerCase();
    if (!l || (p.labels || []).includes(l)) { render(); return; }
    saveLabels(p, [...(p.labels || []), l]).then(() => el.querySelector('.px-label-input')?.focus());
  }
  const removeLabel = (p, l) => saveLabels(p, (p.labels || []).filter((x) => x !== l));

  async function toggle(p, val) {
    const before = { ...(p.checks || {}) };
    p.checks = { ...before };
    if (val) p.checks[meId] = true; else delete p.checks[meId];
    render();
    try {
      if (local) await db.update('parasites', p.id, { checks: p.checks, broken_at: everyoneThrough(p) ? new Date().toISOString() : null });
      else Object.assign(p, await api.rpc('parasite_check', { p: p.id, val }));
      logEvent(p, val ? 'can do it now' : 'took back “can do it”');
      // Everyone can do it → solved. Someone takes it back → back to testing.
      if (everyoneThrough(p) && statusOf(p) !== 'solved') { await setStatus(p, 'solved', { quiet: true }); logEvent(p, 'closed it — everyone can do it'); toast('Ticket solved.', { ms: 2400 }); }
      else if (!everyoneThrough(p) && statusOf(p) === 'solved') await setStatus(p, 'testing');
      render();
    } catch (e) { p.checks = before; render(); fail(e); }
  }

  async function edit(p, prefill = {}) {
    const title = h('input', { class: 'input', value: p?.title || prefill.title || '', maxlength: 120, placeholder: 'e.g. Can’t finish and publish a video on my own', 'aria-label': 'Problem' });
    const detail = h('textarea', { class: 'input', rows: 3, maxlength: 1000, placeholder: 'What “solved” looks like — e.g. you can actually do it, not just follow along.', value: p?.detail || prefill.detail || '', 'aria-label': 'Solved when' });
    const deadline = h('input', { class: 'input', type: 'date', value: p?.deadline ? String(p.deadline).slice(0, 10) : '', 'aria-label': 'Deadline' });
    const labels = h('input', { class: 'input', value: (p?.labels || []).join(', '), placeholder: 'e.g. editing, scripting', 'aria-label': 'Labels', autocapitalize: 'none' });
    const who = p ? null : h('input', { class: 'input', placeholder: local ? 'Needs Supabase sync' : 'Usernames, comma separated', disabled: local, autocapitalize: 'none', spellcheck: false, 'aria-label': 'Members' });
    const ok = await dialog({
      title: p ? 'Edit ticket' : 'New ticket',
      width: 520,
      body: h('div', { class: 'stack' },
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Problem'), title),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Solved when'), detail),
        h('div', { class: 'ptime-fields' },
          h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Deadline'), deadline),
          h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Labels'), labels)),
        who ? h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Breaking it with'), who) : null),
      actions: [{ label: 'Cancel', value: false }, { label: p ? 'Save' : 'Open ticket', primary: true, value: true }],
    });
    if (!ok) return;
    const body = {
      title: title.value.trim() || 'Untitled problem',
      detail: detail.value.trim(),
      deadline: deadline.value || null,
      labels: [...new Set(labels.value.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean))],
    };
    try {
      if (p) {
        Object.assign(p, body);
        render();
        await db.update('parasites', p.id, body);
      } else {
        const row = { id: uid(), ...body, status: 'open', members: [], checks: {} };
        if (local) row.no = list.reduce((m, x) => Math.max(m, noOf(x)), 0) + 1;
        const made = await db.insert('parasites', row);
        const item = { ...row, user_id: meId, created_at: new Date().toISOString(), ...(made || {}) };
        list = [item, ...list];
        openTicket(item.id);
        logEvent(item, 'opened this ticket');
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
      logEvent(p, `added ${name}`);
      render();
    } catch (e) { fail(e); }
  }

  async function addMember(p) {
    if (local) { toast('Members need Supabase sync.'); return; }
    const input = h('input', { class: 'input', placeholder: 'Their username', autocapitalize: 'none', spellcheck: false, 'aria-label': 'Username' });
    const ok = await dialog({
      title: 'Add member',
      body: h('div', { class: 'stack' }, h('p', { class: 'px-hint' }, 'They’ll see this ticket, its thread and attempts, and check themselves off once they can do it.'), input),
      actions: [{ label: 'Cancel', value: false }, { label: 'Add', primary: true, value: true }],
    });
    if (ok && input.value.trim()) await addByName(p, input.value.trim().replace(/^@/, ''));
  }

  async function remove(p) {
    if (!(await confirmDialog(`Delete ${numberOf(p)}?`, 'The ticket, its thread and attempts disappear for everyone on it.', { ok: 'Delete' }))) return;
    list = list.filter((x) => x.id !== p.id);
    if (openId === p.id) closeTicket(); else render();
    try { await db.remove('parasites', p.id); } catch (e) { fail(e); load(); }
  }

  async function leave(p) {
    if (!(await confirmDialog(`Leave ${numberOf(p)}?`, 'You won’t see it anymore.', { ok: 'Leave' }))) return;
    list = list.filter((x) => x.id !== p.id);
    if (openId === p.id) closeTicket(); else render();
    try { await api.rpc('parasite_remove', { p: p.id, who: meId }); } catch (e) { fail(e); load(); }
  }

  /* ---------------- Live ---------------- */

  render();
  load();
  // Inside a ticket, pick up the team's messages every few seconds.
  const chatPoll = setInterval(async () => {
    if (!openId || document.hidden || loading) return;
    try {
      const [fresh, rows] = await Promise.all([
        api.db.select('parasite_messages', { order: 'created_at.asc', filters: { parasite_id: openId } }),
        api.db.select('parasites', { filters: { id: openId } }),
      ]);
      const sig = (arr) => arr.map((m) => `${m.id}:${m.edited_at || ''}`).join('|');
      const before = sig(talkOf({ id: openId }));
      messages = [...messages.filter((m) => m.parasite_id !== openId), ...fresh];
      const p = list.find((x) => x.id === openId);
      const keys = (o) => JSON.stringify(Object.keys(o || {}).sort());
      const changed = rows[0] && p && (rows[0].status !== p.status || keys(rows[0].checks) !== keys(p.checks) || (rows[0].labels || []).join() !== (p.labels || []).join());
      if (changed) Object.assign(p, rows[0]);
      if (sig(fresh) !== before || changed) softRender();
    } catch {}
  }, 5000);
  const poll = setInterval(() => {
    if ((openId && !embedded) || document.hidden || loading || document.querySelector('.dlg') || selecting()) return;
    load();
  }, 30_000);

  /* ---------------- Embedded: drag a status column out of / back into the widget ---------------- */
  if (embedded && (opts.onDetach || opts.onSnap)) {
    el.addEventListener('pointerdown', (e) => {
      const head = e.target.closest('.px-col-head');
      if (!head || e.button !== 0 || e.target.closest('button')) return;
      const colEl = head.closest('.px-col');
      const status = colEl.dataset.status;
      const d = { x0: e.clientX, y0: e.clientY, started: false, out: false };
      const move = (ev) => {
        if (!d.started) {
          if (Math.hypot(ev.clientX - d.x0, ev.clientY - d.y0) < 6) return;
          const r = colEl.getBoundingClientRect();
          d.started = true;
          d.dx = ev.clientX - r.left; d.dy = ev.clientY - r.top;
          d.ghost = colEl.cloneNode(true);
          d.ghost.classList.add('px-col-ghost');
          Object.assign(d.ghost.style, { width: `${colEl.offsetWidth}px`, maxHeight: '420px', left: '0px', top: '0px' });
          document.body.append(d.ghost);
          document.body.classList.add('is-dragging');
          colEl.style.opacity = '.35';
        }
        d.lx = ev.clientX; d.ly = ev.clientY;
        d.ghost.style.transform = `translate(${ev.clientX - d.dx}px, ${ev.clientY - d.dy}px) rotate(-1deg)`;
        const r = el.getBoundingClientRect();
        d.out = ev.clientX < r.left - 20 || ev.clientX > r.right + 20 || ev.clientY < r.top - 20 || ev.clientY > r.bottom + 20;
        d.ghost.classList.toggle('is-detaching', d.out && !opts.only);
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        if (!d.started) return;
        d.ghost.remove();
        document.body.classList.remove('is-dragging');
        colEl.style.opacity = '';
        if (!d.out) return;
        if (opts.only) {
          const home = document.elementsFromPoint(d.lx, d.ly).find((n) => n.matches?.('.el-widget[data-wkind="tickets"]'));
          if (home) opts.onSnap?.();
        } else opts.onDetach?.(status, { clientX: d.lx, clientY: d.ly });
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up, { once: true });
    });
  }
  let reloadT = 0;
  const onChanged = (e) => {
    if (e.detail?.from === instance) return;
    clearTimeout(reloadT);
    reloadT = setTimeout(() => { if (!document.querySelector('.dlg') && !selecting() && !editingId) load(); }, 300);
  };
  if (embedded) window.addEventListener('architect:tickets-changed', onChanged);

  return {
    setExclude(ids) {
      const next = new Set(ids || []);
      if ([...next].join() === [...exclude].join()) return;
      exclude = next;
      render();
    },
    open(id) { openTicket(id); },
    update(r) { openId = r.id || null; linked = { no: null, rows: [] }; draft = ''; mode = 'msg'; editingId = null; pending = []; render(); window.scrollTo(0, 0); },
    destroy() {
      clearInterval(poll); clearInterval(chatPoll); clearTimeout(reloadT);
      window.removeEventListener('architect:tickets-changed', onChanged);
      window.removeEventListener('architect:open-ticket', onOpenTicket);
      window.removeEventListener('architect:new-ticket', onNewTicket);
      window.removeEventListener('architect:tickets-seen', onSeen);
      document.removeEventListener('selectionchange', onSelChange);
      pending.forEach((f) => f.preview && URL.revokeObjectURL(f.preview));
      el.remove();
    },
  };
}
