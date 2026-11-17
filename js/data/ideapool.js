// The shared idea pool — the Ideas on the shared Space's Fleeting Ideas object.
// That object registers itself here when it mounts, so a Fleeting Ideas object in your personal Space
// can show (and add to) the same pool in its Shared view. Nothing new in the database: the pool is the
// shared object's `ideas`, synced like every other object on the shared canvas.
const subs = new Set();
let pool = null; // { id, get(), set(list, live) }

const emit = () => { for (const fn of subs) { try { fn(); } catch {} } };

/** Called by the shared Space's Fleeting Ideas object. Returns { changed(), off() }. */
export function registerPool(p) {
  if (!pool) { pool = p; emit(); }
  return {
    changed() { if (pool === p) emit(); },
    off() { if (pool === p) { pool = null; emit(); } },
  };
}

export const poolReady = () => !!pool;
export const poolIdeas = () => (pool ? pool.get() || [] : []);
export function setPoolIdeas(list, live = false) { if (pool) pool.set(list, live); }
export function onPool(fn) { subs.add(fn); return () => subs.delete(fn); }
