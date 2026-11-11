// Your custom CSS theme and JS hotfixes (Settings → Customize, or the Local API).
// Safe mode — the toggle, or opening the app with ?safe — switches both off.
import { api } from '../data/api.js';
import { getPref, loadPrefs } from '../data/prefs.js';
import { toast } from './ui.js';
import { pushRelease, rollback, releases } from '../data/releases.js';

let ranJs = null;

export const safeMode = () => !!getPref('safeMode', false) || /[?&]safe\b/.test(location.search) || /[?&]safe\b/.test(location.hash);

export async function applyCustom({ rerunJs = false } = {}) {
  try { await loadPrefs(); } catch {}
  const safe = safeMode();
  let style = document.getElementById('architect-custom-css');
  if (!style) { style = document.createElement('style'); style.id = 'architect-custom-css'; document.head.append(style); }
  style.textContent = safe ? '' : String(getPref('customCss', '') || '');
  const js = safe ? '' : String(getPref('customJs', '') || '');
  if (!js.trim() || (js === ranJs && !rerunJs)) return;
  ranJs = js;
  window.architect = architectGlobal();
  try {
    // eslint-disable-next-line no-new-func
    new Function('architect', js)(window.architect);
  } catch (e) {
    console.error('[architect custom js]', e);
    // Something you pushed broke on load: one click puts the previous version back.
    const { list, active } = await releases().catch(() => ({ list: [] }));
    const prev = list.find((r) => r.v < (active ?? Infinity));
    toast(`Your custom JS failed: ${e.message}.${prev ? '' : ' Open with ?safe to skip it.'}`, {
      tone: 'error', ms: 12000,
      action: prev ? { label: `Roll back to v${prev.v}`, onClick: async () => { await rollback(prev.v); location.reload(); } } : null,
    });
  }
}

// What custom scripts get as `architect` (also handy from the browser console).
function architectGlobal() {
  return {
    api, toast, version: 'space-2',
    /** Push an update: { css?, js?, note? } — becomes the next version and applies on reload. */
    update: async (u) => { const r = await pushRelease({ ...u, source: 'script' }); toast(`Pushed v${r.v} — reload to run it.`); return r; },
    /** Roll back to a version (default: the previous one). */
    rollback: async (v) => { const r = await rollback(v); toast(`Rolled back to v${r.v} — reloading.`); setTimeout(() => location.reload(), 600); return r; },
    releases,
  };
}

export function clearCustom() {
  document.getElementById('architect-custom-css')?.remove();
  ranJs = null;
}
