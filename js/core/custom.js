// Your custom CSS theme and JS hotfixes (Settings → Customize, or the Local API).
// Safe mode — the toggle, or opening the app with ?safe — switches both off.
import { api } from '../data/api.js';
import { getPref, loadPrefs } from '../data/prefs.js';
import { toast } from './ui.js';

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
  window.architect = { api, toast, version: 'space-1' };
  try {
    // eslint-disable-next-line no-new-func
    new Function('architect', js)(window.architect);
  } catch (e) {
    console.error('[architect custom js]', e);
    toast(`Your custom JS failed: ${e.message}. Open with ?safe to skip it.`, { tone: 'error', ms: 7000 });
  }
}

export function clearCustom() {
  document.getElementById('architect-custom-css')?.remove();
  ranJs = null;
}
