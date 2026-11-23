// Settings → Integrations → Anytype (Nov 23b).
// Connect once on the PC that runs Anytype, choose what feeds each Set-Point there (the connector shows the
// exact records and fields before anything leaves the PC), then any device signed into this account sees the
// imports. This tab: turn imports on, pair or disconnect a PC, and see / pause / resume / remove mappings.
import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { toast, confirmDialog } from '../core/ui.js';
import { api, configured, friendlyError } from '../data/api.js';
import { getPref, setPref } from '../data/prefs.js';
import { loadImports, STATUS } from '../data/anytype.js';

const LOCAL_UI = 'http://127.0.0.1:31019';
const REPO_CONNECTOR = 'https://github.com/Pocarishit/Architect-V2/tree/main/connector';
const ago = (t) => {
  if (!t) return 'never';
  const m = Math.round((Date.now() - Date.parse(t)) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
const desktop = () => matchMedia('(hover: hover) and (pointer: fine)').matches && innerWidth >= 720;

export function integrations() {
  const wrap = h('div', { class: 'stack' });
  if (!configured) {
    wrap.append(h('p', { class: 'dlg-text' }, 'Integrations run through your Supabase project, so they need Supabase sync (config.js). In local mode there’s nothing to connect.'));
    return wrap;
  }
  const cfg = window.ARCHITECT_CONFIG || {};
  let on = !!getPref('anytypeSync', false);
  const sw = h('button', { type: 'button', class: ['px-check', on && 'is-on'], role: 'switch', 'aria-checked': String(on) });
  const paintSw = () => { sw.classList.toggle('is-on', on); sw.setAttribute('aria-checked', String(on)); sw.replaceChildren(h('i', {}, on ? icon('check', 11, { weight: 2.8 }) : null), on ? 'Anytype imports on' : 'Anytype imports off'); };
  sw.addEventListener('click', async () => {
    on = !on; paintSw();
    try { await setPref('anytypeSync', on); } catch (e) { toast(friendlyError(e), { tone: 'error' }); }
    if (on) loadImports({ force: true });
    window.dispatchEvent(new CustomEvent('architect:paths-changed', { detail: { owner: api.auth.current()?.user?.id, from: 'settings' } }));
  });
  paintSw();

  const conns = h('div', { class: 'stack' });
  const maps = h('div', { class: 'stack' });
  const pairBox = h('div', { class: 'stack', hidden: true });

  async function load() {
    conns.replaceChildren(h('span', { class: 'dots-loader' }, h('i'), h('i'), h('i')));
    maps.replaceChildren();
    try {
      const [cs, ms, rs, its] = await Promise.all([
        api.db.select('anytype_connectors', { columns: 'id,name,prefix,created_at,last_seen_at,revoked_at,sync_requested_at', order: 'created_at.desc' }),
        api.db.select('anytype_mappings', { columns: 'id,name,source_kind,source_name,section_name,dest_kind,dest_name,version,enabled,paused,connector_id,updated_at', order: 'created_at.asc' }),
        api.db.select('anytype_runs', { columns: 'mapping_id,status,message,last_attempt_at,last_success_at,item_count,mapping_version' }),
        api.db.select('anytype_items', { columns: 'mapping_id', filters: { archived: false } }),
      ]);
      paintConns(cs.filter((c) => !c.revoked_at));
      paintMaps(ms, new Map(rs.map((r) => [r.mapping_id, r])), its);
    } catch (e) {
      const setup = /relation .* does not exist|Could not find the table|42P01|PGRST205/i.test(`${e?.code} ${e?.message}`);
      conns.replaceChildren(h('p', { class: 'dlg-text' }, setup ? 'Anytype sync needs one database update first: run supabase/anytype.sql in the Supabase SQL editor, then reopen this tab.' : friendlyError(e)));
    }
  }

  function pill(tone, text) { return h('span', { class: ['ax-pill', `is-${tone}`] }, h('i'), text); }

  function paintConns(list) {
    if (!list.length) {
      conns.replaceChildren(h('p', { class: 'dlg-text' }, 'No PC connected yet.'));
      return;
    }
    conns.replaceChildren(...list.map((c) => {
      const fresh = c.last_seen_at && Date.now() - Date.parse(c.last_seen_at) < 12 * 60_000;
      return h('div', { class: 'ax-card' },
        h('div', { class: 'ax-row' },
          icon('anytype', 18),
          h('div', { class: 'ax-grow' }, h('div', { class: 'ax-name' }, c.name), h('div', { class: 'ax-meta' }, `${c.prefix}… · paired ${new Date(c.created_at).toLocaleDateString()} · last seen ${ago(c.last_seen_at)}`)),
          fresh ? pill('ok', 'Online') : pill('wait', 'Waiting for desktop')),
        h('div', { class: 'ax-row' },
          h('button', { class: 'btn sm', type: 'button', onclick: async () => {
            try { await api.db.update('anytype_connectors', c.id, { sync_requested_at: new Date().toISOString() }); toast(fresh ? 'Sync requested — it runs within a minute.' : 'Sync requested — it runs when the PC is back.', { ms: 2600 }); }
            catch (e) { toast(friendlyError(e), { tone: 'error' }); }
          } }, icon('history', 13), 'Sync now'),
          desktop() ? h('a', { class: 'btn sm', href: LOCAL_UI, target: '_blank', rel: 'noopener' }, icon('external', 13), 'Open mapping editor') : null,
          h('span', { class: 'ax-grow' }),
          h('button', { class: 'btn sm', type: 'button', onclick: () => disconnect(c) }, icon('leave', 13), 'Disconnect')));
    }));
  }

  async function disconnect(c) {
    if (!(await confirmDialog(`Disconnect ${c.name}?`, 'Its token stops working right away, so imports stop. What was already imported stays — you can remove it separately. Nothing in Anytype changes. On the PC, run “node architect-anytype.mjs forget” to delete its saved keys.', { ok: 'Disconnect' }))) return;
    try {
      await api.db.update('anytype_connectors', c.id, { revoked_at: new Date().toISOString() });
      toast('Disconnected.', { ms: 2000 });
      const rows = await api.db.select('anytype_items', { columns: 'key', filters: { archived: false }, limit: 1 }).catch(() => []);
      if (rows.length && await confirmDialog('Also remove imported items?', 'They disappear from Path on every device. Your own Path tasks, goals and Anytype itself are untouched.', { ok: 'Remove imports' })) {
        const ms = await api.db.select('anytype_mappings', { columns: 'id' });
        for (const m of ms) await api.db.removeWhere('anytype_items', { mapping_id: m.id });
        toast('Imported items removed.', { ms: 2000 });
      }
    } catch (e) { toast(friendlyError(e), { tone: 'error' }); }
    loadImports({ force: true });
    load();
  }

  function paintMaps(list, runs, items) {
    const count = (id) => items.filter((x) => x.mapping_id === id).length;
    maps.replaceChildren(
      h('div', { class: 'pop-label' }, 'Mappings'),
      ...(list.length ? list.map((m) => {
        const r = runs.get(m.id);
        const tone = m.paused || !m.enabled ? 'wait' : !r || r.status === 'never' ? 'wait' : r.status === 'ok' ? 'ok' : 'err';
        const label = m.paused ? 'Paused' : !m.enabled ? 'Off' : !r ? 'Waiting for first import' : r.status === 'ok' ? 'Synced' : (STATUS[r.status] || r.status);
        return h('div', { class: 'ax-card' },
          h('div', { class: 'ax-row' },
            h('div', { class: 'ax-grow' },
              h('div', { class: 'ax-name' }, m.name || `${m.section_name || m.source_name} → ${m.dest_name}`),
              h('div', { class: 'ax-meta' }, `Anytype · ${m.source_name || m.source_kind}${m.section_name ? ` › ${m.section_name}` : ''}  →  Path · ${m.dest_name || '?'} (private)`),
              h('div', { class: 'ax-meta' }, `${count(m.id)} item${count(m.id) === 1 ? '' : 's'} · last good import ${ago(r?.last_success_at)} · v${m.version}${r?.message ? ` · ${r.message}` : ''}`)),
            pill(tone, label)),
          h('div', { class: 'ax-row' },
            h('button', { class: 'btn sm', type: 'button', onclick: async () => {
              try { await api.db.update('anytype_mappings', m.id, { paused: !m.paused }); toast(m.paused ? 'Resumed.' : 'Paused — the last good import stays.', { ms: 2200 }); load(); }
              catch (e) { toast(friendlyError(e), { tone: 'error' }); }
            } }, icon(m.paused ? 'play' : 'pause', 13), m.paused ? 'Resume' : 'Pause'),
            desktop() ? h('a', { class: 'btn sm', href: `${LOCAL_UI}/#edit=${m.id}`, target: '_blank', rel: 'noopener' }, icon('edit', 13), 'Edit on PC') : null,
            h('span', { class: 'ax-grow' }),
            h('button', { class: 'btn sm', type: 'button', onclick: async () => {
              if (!(await confirmDialog('Remove this mapping’s imported items?', 'They leave Path on every device. The mapping stays (pause it to stop new imports). Anytype isn’t touched.', { ok: 'Remove items' }))) return;
              try { await api.db.removeWhere('anytype_items', { mapping_id: m.id }); loadImports({ force: true }); load(); } catch (e) { toast(friendlyError(e), { tone: 'error' }); }
            } }, 'Remove items'),
            h('button', { class: 'btn sm', type: 'button', onclick: async () => {
              if (!(await confirmDialog(`Delete “${m.name || 'this mapping'}”?`, 'The mapping and its imported items go. Your checkmarks history, Path tasks and Anytype stay as they are.', { ok: 'Delete mapping' }))) return;
              try { await api.db.remove('anytype_mappings', m.id); loadImports({ force: true }); load(); } catch (e) { toast(friendlyError(e), { tone: 'error' }); }
            } }, icon('trash', 13))));
      }) : [h('p', { class: 'dlg-text' }, desktop() ? 'No mappings yet. Open the mapping editor on the PC to choose what feeds each Set-Point.' : 'No mappings yet — make them on the PC that runs Anytype.')]));
  }

  async function pair() {
    try {
      const r = await api.rpc('anytype_pair_start', {});
      const code = r?.code;
      if (!code) throw new Error('No code came back.');
      const cmd = `node architect-anytype.mjs pair ${code} --project ${cfg.supabaseUrl} --key ${cfg.supabaseKey}`;
      pairBox.hidden = false;
      pairBox.replaceChildren(h('div', { class: 'ax-card' },
        h('div', { class: 'ax-row' }, h('span', { class: 'ax-code' }, code), h('span', { class: 'ax-meta' }, `one-time code · expires ${new Date(r.expires_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`)),
        h('ol', { class: 'ax-steps' },
          h('li', {}, 'On the Windows PC with Anytype open, get the ', h('a', { href: REPO_CONNECTOR, target: '_blank', rel: 'noopener' }, 'connector folder'), ' (needs Node 18+).'),
          h('li', {}, 'In that folder, run:'),
          h('li', { style: 'list-style:none;margin-left:-18px' }, h('code', { class: 'ax-cmd' }, cmd),
            h('button', { class: 'btn sm', type: 'button', style: 'margin-top:6px', onclick: async () => { try { await navigator.clipboard.writeText(cmd); toast('Copied'); } catch { toast('Select it and copy.'); } } }, icon('copy', 13), 'Copy')),
          h('li', {}, 'Then ', h('code', {}, 'node architect-anytype.mjs connect-anytype'), ' — approve the 4-digit code Anytype shows.'),
          h('li', {}, 'Then ', h('code', {}, 'node architect-anytype.mjs ui'), ' — pick the page section for each Set-Point, check the preview, turn it on.'),
          h('li', {}, 'Optional: ', h('code', {}, 'powershell -ExecutionPolicy Bypass -File install-windows.ps1'), ' keeps it running at sign-in, without Claude Code or a browser tab.')),
        h('p', { class: 'dlg-text' }, 'Your phone needs none of this — sign in to the same account. No IP address, Anytype key or shared Wi-Fi.')));
      setTimeout(load, 15_000);
    } catch (e) { toast(/anytype_pair_start|Could not find the function/i.test(String(e?.message)) ? 'Run supabase/anytype.sql in the Supabase SQL editor first.' : friendlyError(e), { tone: 'error', ms: 5000 }); }
  }

  load();
  wrap.append(
    h('div', { class: 'set-section' },
      h('h3', {}, 'Anytype'),
      h('p', { class: 'dlg-text' }, 'Bring selected Anytype page sections or collections into your Path Set-Points — on desktop and on your phone. Checkmarks and goals stay in Architect; nothing is ever written back to Anytype. Private to your account.'),
      h('div', { class: 'set-row' }, sw, h('span', { class: 'set-space' }),
        desktop() ? h('button', { class: 'btn btn-primary sm', type: 'button', onclick: pair }, icon('plus', 14), 'Connect a PC') : null),
      pairBox),
    h('div', { class: 'pop-label' }, 'Connected PCs'), conns,
    maps);
  return wrap;
}
