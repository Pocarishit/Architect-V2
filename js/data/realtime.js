// Live channels for collaboration: broadcast messages + presence.
// Supabase Realtime is spoken directly over its websocket (Phoenix protocol), so there is still no SDK.
// Local mode uses BroadcastChannel, so two tabs in the same browser can edit together.

const HEARTBEAT_MS = 25_000;
const BACKOFF = [500, 1000, 2000, 5000, 10_000, 20_000];

// Presence maps come in as { key: { metas: [meta, ...] } }; flatten to one entry per key.
function flatten(state) {
  return Object.entries(state).map(([key, v]) => ({ key, ...(v.metas?.[v.metas.length - 1] || {}) }));
}

export function createSupabaseRealtime({ base, key, token }) {
  const wsUrl = `${base.replace(/^http/, 'ws')}/realtime/v1/websocket?apikey=${encodeURIComponent(key)}&vsn=1.0.0`;

  return {
    join(name, { presenceKey, meta = {}, onMessage, onPresence, onStatus }) {
      const topic = `realtime:${name}`;
      let ws = null;
      let ref = 0;
      let joinRef = null;
      let joined = false;
      let closed = false;
      let attempt = 0;
      let hb = null, retry = null, tokenTimer = null;
      let lastToken = null;
      let myMeta = meta;
      let presence = {};
      const queue = []; // messages sent before the channel is joined
      const status = (s, detail) => onStatus?.(s, detail);
      const nextRef = () => String(++ref);
      const raw = (msg) => { if (ws?.readyState === 1) ws.send(JSON.stringify(msg)); };

      function emitPresence() { onPresence?.(flatten(presence)); }

      async function connect() {
        if (closed) return;
        status('connecting');
        let access;
        try { access = await token(); } catch { access = null; }
        if (closed) return;
        if (!access) { status('error', 'signed_out'); return; }
        lastToken = access;
        ws = new WebSocket(wsUrl);
        ws.onopen = () => {
          joinRef = nextRef();
          raw({
            topic, event: 'phx_join', ref: joinRef, join_ref: joinRef,
            payload: {
              config: { broadcast: { self: false, ack: false }, presence: { key: presenceKey, enabled: true }, postgres_changes: [], private: true },
              access_token: access,
            },
          });
          clearInterval(hb);
          hb = setInterval(() => raw({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: nextRef() }), HEARTBEAT_MS);
        };
        ws.onmessage = (ev) => {
          let msg;
          try { msg = JSON.parse(ev.data); } catch { return; }
          if (msg.topic !== topic) return;
          const { event, payload } = msg;
          if (event === 'phx_reply' && msg.ref === joinRef) {
            if (payload?.status === 'ok') {
              joined = true;
              attempt = 0;
              status('live');
              raw({ topic, event: 'presence', ref: nextRef(), join_ref: joinRef, payload: { type: 'presence', event: 'track', payload: myMeta } });
              while (queue.length) send(...queue.shift());
              onMessage?.('__joined', {});
            } else {
              const reason = payload?.response?.reason || 'join_failed';
              status('error', reason);
              // An access rule refusal won't fix itself by retrying quickly.
              ws.onclose = null;
              try { ws.close(); } catch {}
              scheduleRetry(/unauthori[sz]ed|policy|denied/i.test(reason) ? 60_000 : null);
            }
          } else if (event === 'broadcast') {
            onMessage?.(payload?.event, payload?.payload || {});
          } else if (event === 'presence_state') {
            presence = { ...payload };
            emitPresence();
          } else if (event === 'presence_diff') {
            for (const k of Object.keys(payload?.leaves || {})) delete presence[k];
            Object.assign(presence, payload?.joins || {});
            emitPresence();
          } else if (event === 'system' && payload?.status === 'error') {
            status('error', payload.message || 'channel_error');
          } else if (event === 'phx_error' || event === 'phx_close') {
            drop();
          }
        };
        ws.onclose = () => drop();
        ws.onerror = () => {};
      }

      function drop() {
        if (!ws) return;
        const was = ws;
        ws = null;
        joined = false;
        clearInterval(hb);
        try { was.onclose = null; was.close(); } catch {}
        presence = {};
        emitPresence();
        if (closed) return;
        status('offline');
        scheduleRetry();
      }

      function scheduleRetry(ms) {
        clearTimeout(retry);
        if (closed) return;
        const wait = ms ?? BACKOFF[Math.min(attempt, BACKOFF.length - 1)];
        attempt++;
        retry = setTimeout(connect, wait);
      }

      // Supabase drops a channel whose token expires, so hand it the fresh one when it rotates.
      tokenTimer = setInterval(async () => {
        if (!joined) return;
        try {
          const t = await token();
          if (t && t !== lastToken) { lastToken = t; raw({ topic, event: 'access_token', ref: nextRef(), join_ref: joinRef, payload: { access_token: t } }); }
        } catch {}
      }, 4 * 60_000);

      const onOnline = () => { if (!ws && !closed) { attempt = 0; scheduleRetry(0); } };
      window.addEventListener('online', onOnline);

      function send(event, payload) {
        if (!joined) { if (queue.length < 200) queue.push([event, payload]); return false; }
        raw({ topic, event: 'broadcast', ref: nextRef(), join_ref: joinRef, payload: { type: 'broadcast', event, payload } });
        return true;
      }

      connect();
      return {
        send,
        get live() { return joined; },
        update(m) {
          myMeta = { ...myMeta, ...m };
          if (joined) raw({ topic, event: 'presence', ref: nextRef(), join_ref: joinRef, payload: { type: 'presence', event: 'track', payload: myMeta } });
        },
        leave() {
          closed = true;
          clearTimeout(retry);
          clearInterval(hb);
          clearInterval(tokenTimer);
          window.removeEventListener('online', onOnline);
          if (ws) {
            raw({ topic, event: 'phx_leave', ref: nextRef(), join_ref: joinRef, payload: {} });
            const w = ws;
            ws = null;
            setTimeout(() => { try { w.onclose = null; w.close(); } catch {} }, 50);
          }
        },
      };
    },
  };
}

export function createLocalRealtime() {
  return {
    join(name, { presenceKey, meta = {}, onMessage, onPresence, onStatus }) {
      if (typeof BroadcastChannel === 'undefined') { onStatus?.('error', 'unsupported'); return { send() { return false; }, update() {}, leave() {}, live: false }; }
      const bc = new BroadcastChannel(`architect.live.${name}`);
      const peers = new Map(); // key → { meta, seen }
      let myMeta = meta;
      let closed = false;
      const emitPresence = () => onPresence?.([{ key: presenceKey, ...myMeta }, ...[...peers].map(([key, p]) => ({ key, ...p.meta }))]);
      const announce = (ask = false) => bc.postMessage({ t: 'presence', key: presenceKey, meta: myMeta, ask });
      bc.onmessage = (ev) => {
        const m = ev.data || {};
        if (m.key === presenceKey) return;
        if (m.t === 'presence') {
          const prev = peers.get(m.key);
          peers.set(m.key, { meta: m.meta, seen: Date.now() });
          if (m.ask) announce(false);
          if (!prev || JSON.stringify(prev.meta) !== JSON.stringify(m.meta)) emitPresence();
        } else if (m.t === 'bye') {
          if (peers.delete(m.key)) emitPresence();
        } else if (m.t === 'msg') {
          onMessage?.(m.event, m.payload);
        }
      };
      const beat = setInterval(() => {
        announce(false);
        const now = Date.now();
        let changed = false;
        for (const [k, p] of peers) if (now - p.seen > 7000) { peers.delete(k); changed = true; }
        if (changed) emitPresence();
      }, 2500);
      const bye = () => bc.postMessage({ t: 'bye', key: presenceKey });
      window.addEventListener('pagehide', bye);
      setTimeout(() => {
        if (closed) return;
        onStatus?.('live');
        announce(true);
        emitPresence();
        onMessage?.('__joined', {});
      }, 0);
      return {
        live: true,
        send(event, payload) { if (closed) return false; bc.postMessage({ t: 'msg', key: presenceKey, event, payload }); return true; },
        update(m) { myMeta = { ...myMeta, ...m }; announce(false); emitPresence(); },
        leave() {
          closed = true;
          clearInterval(beat);
          window.removeEventListener('pagehide', bye);
          bye();
          bc.close();
        },
      };
    },
  };
}
