// Live modules that sit on the Space canvas as movable objects ("widgets").
// Each widget element: { type: 'widget', kind, x, y, w, h, ... }. The header is the drag handle;
// the body is a normal page area (scroll, type, click) that the canvas leaves alone.
import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { toast, dialog } from '../core/ui.js';
import { uid } from '../core/util.js';
import { go } from '../core/router.js';
import { api, friendlyError } from '../data/api.js';
import { mountPaths } from '../views/paths.js';
import { mountParasites } from '../views/parasites.js';
import { previewSvg } from '../board/preview.js';
import { mountTrackerWidget } from './tracker.js';

export const WIDGETS = {
  path: { label: 'Path', icon: 'toPaths', w: 1490, h: 520 },
  column: { label: 'Path column', icon: 'toPaths', w: 330, h: 520 },
  tracker: { label: 'Tracker & Weekly', icon: 'calendar', w: 460, h: 690 },
  tickets: { label: 'Ticket board', icon: 'ticket', w: 980, h: 640 },
  ticketcol: { label: 'Ticket column', icon: 'ticket', w: 300, h: 520 },
  ticket: { label: 'Ticket', icon: 'ticket', w: 270, h: 168 },
  blueprints: { label: 'Blueprints', icon: 'frame', w: 380, h: 460 },
  portal: { label: 'Blueprint', icon: 'frame', w: 340, h: 260 },
  custom: { label: 'Custom widget', icon: 'code', w: 420, h: 320 },
};

const possessive = (name) => `${name || 'Someone'}’${/s$/i.test(name || '') ? '' : 's'}`;

/**
 * host: { editor(), spaceId, me, snapBack(colWidgetId), detach(pathWidgetId, colId, at), openMenuFor(id, anchor), reveal(id) }
 */
export function createWidgetHost(host) {
  return function mountWidget(el, node) {
    const kind = el.kind in KINDS ? el.kind : 'missing';
    node.dataset.wkind = el.kind || '';
    if (el.owner) node.dataset.owner = el.owner;
    const title = h('span', { class: 'wg-title' });
    const badge = h('span', { class: 'wg-badge', hidden: true });
    const tools = h('span', { class: 'wg-tools', 'data-noptr': '' });
    const more = h('button', {
      class: 'wg-btn', type: 'button', 'data-noptr': '', 'aria-label': 'Widget options',
      onclick: (e) => host.openMenuFor(el.id, e.currentTarget),
    }, icon('more', 15));
    const lock = h('span', { class: 'wg-lock', title: 'Only you can see this', hidden: true }, icon('lock', 12));
    const head = h('div', { class: 'wg-head' }, h('span', { class: 'wg-grip', 'aria-hidden': 'true' }), title, lock, badge, h('span', { class: 'wg-space' }), tools, more);
    const body = h('div', { class: 'wg-body', 'data-noptr': '' });
    node.append(head, body);
    const w = {
      el,
      spaceId: host.spaceId,
      me: host.me,
      tools,
      setTitle(t) { title.textContent = t; },
      setBadge(n) { badge.hidden = !n; badge.textContent = n > 99 ? '99+' : String(n || ''); },
      current: () => host.editor()?.byId.get(el.id) || w.el,
      patch(p) { host.editor()?.updateEls([el.id], p); },
      host,
    };
    lock.hidden = !el.privateTo;
    let inner = null;
    try { inner = KINDS[kind](body, el, w) || {}; } catch (e) { console.error(e); body.replaceChildren(h('p', { class: 'wg-empty' }, 'This widget failed to load.')); inner = {}; }
    return {
      update(next) { w.el = next; lock.hidden = !next.privateTo; inner.update?.(next); },
      destroy() { try { inner.destroy?.(); } catch (e) { console.error(e); } },
    };
  };
}

const KINDS = {
  path(body, el, w) {
    w.setTitle(`${possessive(el.owner === w.me?.id ? w.me.username : el.ownerName)} Path`.toUpperCase());
    const ctl = mountPaths(body, null, {
      embedded: true, owner: el.owner, exclude: el.detached || [],
      onDetach: (colId, at) => w.host.detach(el.id, colId, at),
    });
    w.tools.append(h('button', { class: 'wg-btn', type: 'button', title: 'Open full page', 'aria-label': 'Open full page', onclick: () => go('paths') }, icon('external', 14)));
    if (el.owner !== w.me?.id) w.tools.replaceChildren();
    else w.host.register?.(el.id, { addColumn: ctl.addColumn });
    return { update: (n) => ctl.setExclude(n.detached || []), destroy: () => { w.host.register?.(el.id, null); ctl.destroy(); } };
  },

  column(body, el, w) {
    w.setTitle(`${possessive(el.owner === w.me?.id ? w.me.username : el.ownerName)} path`.toUpperCase());
    const mine = el.owner === w.me?.id;
    const ctl = mountPaths(body, null, { embedded: true, owner: el.owner, only: el.colId, onSnap: mine ? () => w.host.snapBack(el.id) : null });
    if (mine) w.tools.append(h('button', { class: 'wg-btn', type: 'button', title: 'Snap back into Path', 'aria-label': 'Snap back into Path', onclick: () => w.host.snapBack(el.id) }, icon('collapse', 14)));
    return { destroy: () => ctl.destroy() };
  },

  tracker(body, el, w) {
    w.setTitle('TRACKER & WEEKLY');
    return mountTrackerWidget(body, el, w);
  },

  tickets(body, el, w) {
    w.setTitle('TICKET BOARD');
    const ctl = mountParasites(body, null, {
      embedded: true,
      exclude: el.detached || [],
      onDetach: (status, at) => w.host.detachTicketCol(el.id, status, at),
      onPop: (id, at) => w.host.popTicket(id, at),
      isPopped: (id) => w.host.poppedTickets().has(id),
      onUnread: (n) => w.setBadge(n),
      onReveal: () => w.host.reveal(el.id),
      isPrimary: () => {
        const ed = w.host.editor();
        return !ed || ed.visibleEls().find((e) => e.type === 'widget' && e.kind === 'tickets')?.id === el.id;
      },
    });
    w.tools.append(h('button', { class: 'wg-btn', type: 'button', title: 'Open full page', 'aria-label': 'Open full page', onclick: () => go('parasites') }, icon('external', 14)));
    return { update: (n) => ctl.setExclude(n.detached || []), destroy: () => ctl.destroy() };
  },

  ticketcol(body, el, w) {
    const names = { open: 'OPEN', working: 'WORKING ON IT', testing: 'TESTING', solved: 'SOLVED' };
    w.setTitle(names[el.status] || 'TICKETS');
    const ctl = mountParasites(body, null, {
      embedded: true, only: el.status, isPrimary: () => false, onSnap: () => w.host.snapTicketCol(el.id),
      onPop: (id, at) => w.host.popTicket(id, at), isPopped: (id) => w.host.poppedTickets().has(id),
    });
    w.tools.append(h('button', { class: 'wg-btn', type: 'button', title: 'Snap back into Ticket board', 'aria-label': 'Snap back into Ticket board', onclick: () => w.host.snapTicketCol(el.id) }, icon('collapse', 14)));
    return { destroy: () => ctl.destroy() };
  },

  // One ticket on the canvas: a card; click it to open the full ticket right there.
  ticket(body, el, w) {
    w.setTitle('TICKET');
    const ctl = mountParasites(body, null, {
      embedded: true, ticketOnly: el.ticketId, expanded: !!el.open, isPrimary: () => false,
      onExpand: () => w.host.expandTicket(el.id, true),
      onCollapse: () => w.host.expandTicket(el.id, false),
      onSnap: () => w.host.snapTicket(el.id),
      onUnread: (n) => w.setBadge(n),
    });
    const toggle = h('button', { class: 'wg-btn', type: 'button', onclick: () => w.host.expandTicket(el.id, !w.current().open) });
    const paintToggle = (open) => { toggle.replaceChildren(icon(open ? 'collapse' : 'external', 14)); toggle.title = open ? 'Collapse to card' : 'Open ticket'; toggle.setAttribute('aria-label', toggle.title); };
    paintToggle(el.open);
    w.tools.append(toggle);
    return {
      update: (n) => { ctl.setExpanded(!!n.open); paintToggle(n.open); },
      destroy: () => ctl.destroy(),
    };
  },

  blueprints(body, el, w) {
    w.setTitle('BLUEPRINTS');
    let boards = [];
    let q = '';
    let state = 'loading';
    const list = h('div', { class: 'bs-list' });
    const search = h('input', { class: 'input sm', type: 'search', placeholder: 'Find a blueprint', 'aria-label': 'Find a blueprint', oninput: (e) => { q = e.target.value.trim().toLowerCase(); paint(); } });
    body.append(h('div', { class: 'bs' },
      h('div', { class: 'bs-top' }, search,
        h('button', { class: 'btn btn-primary sm', type: 'button', onclick: create }, icon('plus', 14), h('span', {}, 'New'))),
      list,
      h('a', { class: 'bs-archive', href: '#/blueprint' }, icon('folder', 14), 'All in Archives')));
    async function load() {
      try {
        const rows = await api.db.select('blueprints', { columns: 'id,name,kind,preview,updated_at', order: 'updated_at.desc' })
          .catch(() => api.db.select('blueprints', { columns: 'id,name,preview,updated_at', order: 'updated_at.desc' }));
        boards = rows.filter((b) => b.kind !== 'space' && b.kind !== 'personal');
        state = 'ok';
      } catch (e) { state = friendlyError(e); }
      paint();
    }
    function paint() {
      if (state === 'loading') { list.replaceChildren(h('span', { class: 'dots-loader' }, h('i'), h('i'), h('i'))); return; }
      if (state !== 'ok') { list.replaceChildren(h('p', { class: 'wg-empty' }, state)); return; }
      const shown = boards.filter((b) => !q || String(b.name).toLowerCase().includes(q)).slice(0, 60);
      list.replaceChildren(...(shown.length ? shown.map((b) => h('div', { class: 'bs-row' },
        h('button', { class: 'bs-open', type: 'button', onclick: () => go(`board/${b.id}`) },
          h('span', { class: 'bs-thumb' }, previewSvg(b.preview) || icon('frame', 16)),
          h('span', { class: 'bs-name' }, b.name || 'Untitled')),
        h('button', { class: 'icon-btn xs', type: 'button', title: 'Put a portal on the canvas', 'aria-label': `Put ${b.name} on the canvas`, onclick: () => w.host.addPortal(b, el.id) }, icon('pin', 14))))
        : [h('p', { class: 'wg-empty' }, q ? 'No matches.' : 'No blueprints yet.')]));
    }
    async function create() {
      try {
        const row = { id: uid(), name: 'Untitled blueprint', kind: 'board', folder_id: null, pinned: false, data: { v: 1, elements: [] }, preview: [] };
        await api.db.insert('blueprints', row).catch(async (e) => {
          if (/kind/.test(String(e?.message))) { delete row.kind; return api.db.insert('blueprints', row); }
          throw e;
        });
        go(`board/${row.id}`);
      } catch (e) { toast(friendlyError(e), { tone: 'error' }); }
    }
    load();
    const poll = setInterval(() => { if (!document.hidden) load(); }, 60_000);
    window.addEventListener('architect:blueprints-changed', load);
    return { destroy: () => { clearInterval(poll); window.removeEventListener('architect:blueprints-changed', load); } };
  },

  portal(body, el, w) {
    const paint = (e) => {
      w.setTitle((e.name || 'Blueprint').toUpperCase());
      body.replaceChildren(h('button', { class: 'portal', type: 'button', onclick: () => go(`board/${e.boardId}`), 'aria-label': `Open ${e.name || 'blueprint'}` },
        h('span', { class: 'portal-pv' }, previewSvg(e.preview) || icon('frame', 28)),
        h('span', { class: 'portal-go' }, icon('external', 14), 'Open blueprint')));
    };
    paint(el);
    // Refresh name + thumbnail now and then.
    let alive = true;
    (async () => {
      try {
        const b = await api.db.get('blueprints', el.boardId, 'id,name,preview');
        if (!alive) return;
        if (!b) { body.replaceChildren(h('p', { class: 'wg-empty' }, 'This blueprint was deleted or isn’t shared with you.')); return; }
        if (b.name !== el.name || JSON.stringify(b.preview) !== JSON.stringify(el.preview)) w.patch({ name: b.name, preview: b.preview });
      } catch {}
    })();
    return { update: paint, destroy() { alive = false; } };
  },

  custom(body, el, w) {
    const frame = h('iframe', { class: 'wg-frame', sandbox: 'allow-scripts allow-forms allow-popups', referrerpolicy: 'no-referrer', title: el.title || 'Custom widget' });
    body.append(frame);
    const paint = (e) => {
      w.setTitle((e.title || 'Widget').toUpperCase());
      const key = `${e.html}`;
      if (frame._key === key) return;
      frame._key = key;
      frame.srcdoc = customDoc(e.html || '');
    };
    paint(el);
    w.tools.append(h('button', { class: 'wg-btn', type: 'button', title: 'Edit widget', 'aria-label': 'Edit widget', onclick: () => editCustom(w) }, icon('edit', 14)));
    return { update: paint };
  },

  missing(body, el, w) {
    w.setTitle('WIDGET');
    body.append(h('p', { class: 'wg-empty' }, `Unknown widget “${el.kind}”. Update the app to see it.`));
  },
};

// A custom widget runs in a sandbox (no access to your account), styled like the app.
function customDoc(html) {
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).trim();
  return `<!doctype html><html><head><meta charset="utf-8"><style>
:root{--bg:${v('--s1')};--fg:${v('--fg')};--fg-2:${v('--fg-2')};--line:${v('--line')};--red:#D71921;color-scheme:${v('color-scheme') || 'dark'}}
html,body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 'Space Grotesk',system-ui,sans-serif}
body{padding:12px}button{font:inherit}
</style></head><body>${html}</body></html>`;
}

export async function editCustom(w) {
  const el = w.current();
  const title = h('input', { class: 'input', value: el.title || 'Widget', maxlength: 60, 'aria-label': 'Title' });
  const html = h('textarea', { class: 'input code-input', rows: 12, spellcheck: false, value: el.html || '', 'aria-label': 'HTML, CSS and JS' });
  const ok = await dialog({
    title: 'Custom widget',
    width: 640,
    body: h('div', { class: 'stack' },
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Title'), title),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'HTML (inline <style> and <script> work)'), html),
      h('p', { class: 'dlg-text' }, 'Runs in a sandbox: scripts work, but it can’t read your account or the rest of the page.')),
    actions: [{ label: 'Cancel', value: false }, { label: 'Save', primary: true, value: true }],
  });
  if (ok) w.patch({ title: title.value.trim() || 'Widget', html: html.value });
}
