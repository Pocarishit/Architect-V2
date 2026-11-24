// One clock for everyone (Nov 26). Shared objects that store moments in time (the Timer's end, a stopwatch's
// start) are read on several devices whose clocks rarely agree — a phone a few seconds ahead of a PC was
// enough for Hiru and Maveri to see different time left on the same timer. This estimates how far this
// device's clock is from the server's (the Date header of a request to this site), and serverNow() uses it.
let offset = 0;      // server − device, in ms
let ready = null;

async function sample() {
  const t0 = Date.now();
  const r = await fetch(`${location.origin}/sw.js?clock=${t0}`, { method: 'HEAD', cache: 'no-store' });
  const t1 = Date.now();
  const d = Date.parse(r.headers.get('date') || '');
  if (!Number.isFinite(d)) return null;
  // The header has whole seconds: the server time sits somewhere in [d, d + 1000).
  return d + 500 - (t0 + t1) / 2;
}

export function syncClock() {
  ready ||= (async () => {
    try {
      const xs = (await Promise.all([sample(), sample(), sample()])).filter((x) => x != null);
      if (xs.length) {
        xs.sort((a, b) => a - b);
        const mid = xs[Math.floor(xs.length / 2)];
        // Small differences are just the header's one-second steps: only correct real drift.
        offset = Math.abs(mid) > 1200 ? mid : 0;
      }
    } catch { /* offline: this device's clock it is */ }
  })();
  return ready;
}

export const serverNow = () => Date.now() + offset;
export const clockOffset = () => offset;
