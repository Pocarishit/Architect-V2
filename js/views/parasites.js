// Parasites: a ticket tracker for the problems a team has to break through together.
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

export function mountParasites(root, initialId = null) {
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
  let outcome = 'failed';
  const local = api.mode === 'local';

  const el = h('div', { class: 'view parasites' });
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
  const numberOf = (p) => {
    const order = [...list].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    return `#${String(order.findIndex((x) => x.id === p.id) + 1).padStart(3, '0')}`;
  };

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

  function render() {
    const ticket = openId && list.find((p) => p.id === openId);
    const keep = el.querySelector('.px-chat-list');
    const atBottom = !keep || keep.scrollHeight - keep.scrollTop - keep.clientHeight < 40;
    const typing = document.activeElement?.hasAttribute?.('data-draft');
    if (ticket) el.replaceChildren(ticketView(ticket));
    else el.replaceChildren(header(), loading ? loader() : loadError ? errorView() : overview());
    const chat = el.querySelector('.px-chat-list');
    if (chat && atBottom) chat.scrollTop = chat.scrollHeight;
    if (typing) el.querySelector('[data-draft]')?.focus();
  }

  const loader = () => h('div', { class: 'empty' }, h('span', { class: 'dots-loader' }, h('i'), h('i'), h('i')));
  const errorView = () => h('div', { class: 'empty' },
    h('p', { class: 'empty-text' }, loadError),
    h('p', { class: 'empty-text px-hint' }, 'Parasites needs its tables — run supabase/nov7.sql in the Supabase SQL editor.'),
    h('button', { class: 'btn', onclick: () => { loading = true; render(); load(); } }, 'Try again'));

  function header() {
    return h('header', { class: 'view-head px-head' },
      h('div', { class: 'px-head-main' },
        h('h1', { class: 'paths-title px-title' }, 'Parasites'),
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
    if (!list.length) {
      return h('div', { class: 'px-empty' },
        h('div', { class: 'px-empty-wall', 'aria-hidden': 'true' }, Array.from({ length: 28 }, (_, i) => h('i', { class: i % 7 === 3 ? 'off' : null }))),
        h('p', {}, 'Open a ticket for a problem you’re stuck behind, add who you’re breaking it with, and set a deadline.'),
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
    return h('div', { class: 'px-board' }, STATUSES.map((st) => {
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
        h('header', { class: 'px-col-head' },
          h('span', { class: 'px-col-title' }, h('i', { class: 'px-status-dot' }), st.label),
          h('span', { class: 'px-col-n' }, String(col.length))),
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
    return h('article', {
      class: ['px-tcard', statusOf(p) === 'solved' && 'is-solved'], draggable: 'true', tabindex: '0',
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
        h('span', { class: 'px-meta' }, icon('chat', 13), String(talk.length)),
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
      return h('button', { class: ['px-row', statusOf(p) === 'solved' && 'is-broken'], type: 'button', onclick: () => openTicket(p.id) },
        h('span', { class: 'px-row-no' }, numberOf(p)),
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

  function openTicket(id) { go(`parasites/${id}`); }
  function closeTicket() { go('parasites'); }

  function ticketView(p) {
    return h('div', { class: 'px-ticket' },
      h('div', { class: 'px-ticket-bar' },
        h('button', { class: 'pback', type: 'button', onclick: closeTicket }, icon('back', 16), 'Parasites'),
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
      h('button', { class: 'btn sm px-add-member', type: 'button', onclick: () => addMember(p) }, icon('users', 14), h('span', {}, 'Add member')));
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
    return h('section', { class: 'px-chat', 'aria-label': 'Ticket chat' },
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
        h('div', { class: 'px-chat-compose' }, input,
          h('button', { class: 'icon-btn tk-talk-send', type: 'button', 'aria-label': 'Send', onclick: () => send(p) }, icon('arrow', 16)))));
  }

  function messageView(m, no) {
    const self = m.user_id === meId;
    const time = new Date(m.created_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
    if (m.kind === 'event') {
      return h('div', { class: 'px-event' }, h('b', {}, self ? 'You' : nameOf(m.user_id)), ` ${m.body} · ${time}`);
    }
    if (m.kind === 'attempt') {
      const o = OUTCOMES.find((x) => x.id === m.outcome) || OUTCOMES[0];
      return h('div', { class: ['px-attempt', `is-${o.id}`] },
        h('header', {},
          h('span', { class: 'px-attempt-no' }, `Attempt ${no || ''}`),
          h('span', { class: ['px-outcome-tag', `is-${o.id}`] }, o.label),
          h('span', { class: 'px-attempt-by' }, `${self ? 'You' : nameOf(m.user_id)} · ${time}`),
          self ? h('button', { class: 'icon-btn xs px-msg-del', type: 'button', 'aria-label': 'Delete attempt', onclick: () => unsend(m) }, icon('close', 12)) : null),
        h('p', {}, m.body));
    }
    return h('div', { class: ['px-msg', self && 'is-me'] },
      self ? null : h('span', { class: 'tk-av' }, nameOf(m.user_id).slice(0, 1).toUpperCase()),
      h('div', { class: 'px-msg-body' },
        self ? null : h('b', { class: 'px-msg-name' }, nameOf(m.user_id)),
        h('p', {}, m.body),
        h('span', { class: 'px-msg-time' }, time)),
      self ? h('button', { class: 'icon-btn xs px-msg-del', type: 'button', 'aria-label': 'Delete message', onclick: () => unsend(m) }, icon('close', 12)) : null);
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
    try { await api.db.insert('parasite_messages', full); }
    catch (e) { messages = messages.filter((m) => m.id !== full.id); render(); throw e; }
  }
  const logEvent = (p, text) => post(p, { kind: 'event', body: text }).catch(() => {});

  async function send(p) {
    const body = draft.trim();
    if (!body) return;
    const attempt = mode === 'attempt';
    draft = '';
    try {
      await post(p, attempt ? { kind: 'attempt', outcome, body } : { body });
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
    try { await api.db.remove('parasite_messages', m.id); } catch (e) { fail(e); load(); }
  }

  async function setStatus(p, status, { quiet = false } = {}) {
    const prev = statusOf(p);
    if (prev === status) return;
    p.status = status;
    render();
    try {
      await api.db.update('parasites', p.id, { status });
      if (!quiet) logEvent(p, `moved this to ${statusLabel(status)}`);
    } catch (e) { p.status = prev; render(); fail(e); }
  }

  async function saveLabels(p, labels) {
    const prev = p.labels || [];
    p.labels = labels;
    render();
    try { await api.db.update('parasites', p.id, { labels }); } catch (e) { p.labels = prev; render(); fail(e); }
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
      if (local) await api.db.update('parasites', p.id, { checks: p.checks, broken_at: everyoneThrough(p) ? new Date().toISOString() : null });
      else Object.assign(p, await api.rpc('parasite_check', { p: p.id, val }));
      logEvent(p, val ? 'can do it now' : 'took back “can do it”');
      // Everyone can do it → solved. Someone takes it back → back to testing.
      if (everyoneThrough(p) && statusOf(p) !== 'solved') { await setStatus(p, 'solved', { quiet: true }); logEvent(p, 'closed it — everyone can do it'); toast('Ticket solved.', { ms: 2400 }); }
      else if (!everyoneThrough(p) && statusOf(p) === 'solved') await setStatus(p, 'testing');
      render();
    } catch (e) { p.checks = before; render(); fail(e); }
  }

  async function edit(p) {
    const title = h('input', { class: 'input', value: p?.title || '', maxlength: 120, placeholder: 'e.g. Can’t finish and publish a video on my own', 'aria-label': 'Problem' });
    const detail = h('textarea', { class: 'input', rows: 3, maxlength: 1000, placeholder: 'What “solved” looks like — e.g. you can actually do it, not just follow along.', value: p?.detail || '', 'aria-label': 'Solved when' });
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
        await api.db.update('parasites', p.id, body);
      } else {
        const row = { id: uid(), ...body, status: 'open', members: [], checks: {} };
        const made = await api.db.insert('parasites', row);
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
    try { await api.db.remove('parasites', p.id); } catch (e) { fail(e); load(); }
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
      const before = talkOf({ id: openId }).length;
      messages = [...messages.filter((m) => m.parasite_id !== openId), ...fresh];
      const p = list.find((x) => x.id === openId);
      const changed = rows[0] && p && (rows[0].status !== p.status || JSON.stringify(rows[0].checks) !== JSON.stringify(p.checks) || JSON.stringify(rows[0].labels) !== JSON.stringify(p.labels));
      if (changed) Object.assign(p, rows[0]);
      if (fresh.length !== before || changed) render();
    } catch {}
  }, 5000);
  const poll = setInterval(() => {
    if (openId || document.hidden || loading || document.querySelector('.dlg')) return;
    load();
  }, 30_000);

  return {
    update(r) { openId = r.id || null; draft = ''; mode = 'msg'; render(); window.scrollTo(0, 0); },
    destroy() { clearInterval(poll); clearInterval(chatPoll); el.remove(); },
  };
}
