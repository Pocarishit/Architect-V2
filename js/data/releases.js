// Versioned updates for your custom CSS / JS ("push updates and fixes") with rollback.
// Every push is a numbered release kept in your prefs — only the last few (KEEP), plus the v0 snapshot
// of what you had before the first push. Older ones are pruned on every push, and an oversized history
// left over from before (it used to keep 30, which bloated the prefs row to megabytes) trims itself the
// first time it's read. The Local API does the same server-side: updates.push / updates.list / updates.rollback.
import { getPref, setPref, loadPrefs } from './prefs.js';

const KEEP = 5; // newest releases kept (the v0 snapshot rides along on top)

// Oldest-first list → v0 snapshot + the newest KEEP, and never drops the active version.
function prune(all, active = null) {
  const sorted = [...all].sort((a, b) => a.v - b.v);
  const snap = sorted.find((r) => r.v === 0);
  const rest = sorted.filter((r) => r.v !== 0);
  let kept = rest.slice(-KEEP);
  const act = active != null && rest.find((r) => r.v === active);
  if (act && !kept.includes(act)) kept = [act, ...kept.slice(1)];
  return [...(snap ? [snap] : []), ...kept].sort((a, b) => a.v - b.v);
}

let trimming = null;
export async function releases() {
  await loadPrefs().catch(() => {});
  let list = Array.isArray(getPref('releases', null)) ? getPref('releases', []) : [];
  const active = getPref('releaseActive', null);
  const lean = prune(list, active);
  if (lean.length < list.length) {
    // Self-cleaning: a history saved before the cap gets cut down once, quietly.
    list = lean;
    trimming ||= setPref('releases', lean).catch(() => {}).finally(() => { trimming = null; });
  }
  return { list: [...list].sort((a, b) => b.v - a.v), active };
}

export async function pushRelease({ css, js, note = '', source = 'app' } = {}) {
  const { list } = await releases();
  const curCss = String(getPref('customCss', '') || ''), curJs = String(getPref('customJs', '') || '');
  let all = [...list].sort((a, b) => a.v - b.v);
  if (!all.length) all.push({ v: 0, css: curCss, js: curJs, note: 'Before the first update', source: 'snapshot', at: new Date().toISOString() });
  const v = Math.max(...all.map((r) => r.v)) + 1;
  const rel = { v, css: css ?? curCss, js: js ?? curJs, note: String(note || '').slice(0, 200), source, at: new Date().toISOString() };
  all = prune([...all, rel], v);
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
