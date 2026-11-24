// The shared idea pool — the Ideas on the shared Space's Fleeting Ideas object.
// That object registers itself here when it mounts, so a Fleeting Ideas object in your personal Space
// can show (and add to) the same pool in its Shared view. Nothing new in the database: the pool is the
// shared object's `ideas`, synced like every other object on the shared canvas.
const subs = new Set();
let pool = null; // { id, get(), set(list, live), field(k), patch(p), priv?() }
// Nov 26: every shared-Space Fleeting object offers itself; the pool is chosen the same way on every screen —
// never one hidden from others ("Hide from others"), then the lowest id — so Hiru and Maveri always read and
// write the same record. (It used to be whichever object mounted first, which could differ per person, or be
// one only its owner could see: that's how Hiru's moments never reached Maveri's Story.)
const cands = new Set();

const emit = () => { for (const fn of subs) { try { fn(); } catch {} } };
function choose() {
  const best = [...cands].filter((p) => !p.priv?.()).sort((a, b) => String(a.id).localeCompare(String(b.id)))[0] || null;
  if (best !== pool) { pool = best; emit(); return true; }
  return false;
}

/** Called by the shared Space's Fleeting objects. Returns { changed(), off() }. */
export function registerPool(p) {
  cands.add(p);
  choose();
  return {
    changed() { if (!choose() && pool === p) emit(); },
    off() { cands.delete(p); if (!choose() && pool === p) emit(); },
  };
}

export const poolReady = () => !!pool;
export const poolIdeas = () => (pool ? pool.get() || [] : []);
export function setPoolIdeas(list, live = false) { if (pool) pool.set(list, live); }
export function onPool(fn) { subs.add(fn); return () => subs.delete(fn); }
// Nov 19 (sync): the shared object's Story and Weekly ride the same pool, so Fleeting Moments shows the
// same days and the same plan in both Spaces — what you write in one is exactly what the other shows.
export const poolField = (k) => (pool?.field ? pool.field(k) : undefined);
export function patchPool(p) { if (pool?.patch) pool.patch(p); }
