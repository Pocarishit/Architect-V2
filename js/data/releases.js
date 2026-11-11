// Versioned updates for your custom CSS / JS ("push updates and fixes") with rollback.
// Every push is a numbered release kept in your prefs (last 30). The first push also keeps
// a v0 snapshot of what you had before, so you can always get back to it.
// The Local API does the same server-side: updates.push / updates.list / updates.rollback.
import { getPref, setPref, loadPrefs } from './prefs.js';

const KEEP = 30;

export async function releases() {
  await loadPrefs().catch(() => {});
  const list = Array.isArray(getPref('releases', null)) ? getPref('releases', []) : [];
  return { list: [...list].sort((a, b) => b.v - a.v), active: getPref('releaseActive', null) };
}

export async function pushRelease({ css, js, note = '', source = 'app' } = {}) {
  const { list } = await releases();
  const curCss = String(getPref('customCss', '') || ''), curJs = String(getPref('customJs', '') || '');
  let all = [...list].sort((a, b) => a.v - b.v);
  if (!all.length) all.push({ v: 0, css: curCss, js: curJs, note: 'Before the first update', source: 'snapshot', at: new Date().toISOString() });
  const v = Math.max(...all.map((r) => r.v)) + 1;
  const rel = { v, css: css ?? curCss, js: js ?? curJs, note: String(note || '').slice(0, 200), source, at: new Date().toISOString() };
  all.push(rel);
  if (all.length > KEEP) all = [all[0], ...all.slice(-(KEEP - 1))]; // the v0 snapshot always stays
  await setPref('releases', all);
  await setPref('customCss', rel.css);
  await setPref('customJs', rel.js);
  await setPref('releaseActive', v);
  return rel;
}

/** Roll back to a version (default: the one before the active one). */
export async function rollback(toVersion = null) {
  const { list, active } = await releases();
  if (!list.length) throw new Error('No updates to roll back yet.');
  const target = toVersion != null
    ? list.find((r) => r.v === Number(toVersion))
    : list.find((r) => r.v < (active ?? Infinity));
  if (!target) throw new Error(toVersion != null ? `There's no v${toVersion}.` : 'Already at the oldest version.');
  await setPref('customCss', target.css || '');
  await setPref('customJs', target.js || '');
  await setPref('releaseActive', target.v);
  return target;
}
