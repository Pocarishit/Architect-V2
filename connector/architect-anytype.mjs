#!/usr/bin/env node
// Architect ⇄ Anytype connector (Nov 23b, "Anytype sync for Architect" runbook).
//
// Runs on the PC where Anytype Desktop runs. Reads only the Anytype sources you map (through Anytype's
// loopback API, http://127.0.0.1:31009 — never exposed to the phone or the internet), normalizes the
// allowed fields, and publishes them to your Architect account over HTTPS with its own revocable token.
// Your phone reads the result from Architect after sign-in: no IP address, port, key or shared Wi-Fi.
//
// No dependencies (Node 18+). Secrets live in the OS credential store: Windows DPAPI (per user), macOS
// Keychain, or a 0600 file on Linux — never in config.json, never in logs.
//
//   node architect-anytype.mjs pair <CODE> --project <supabase url> --key <publishable key> [--name "My PC"]
//   node architect-anytype.mjs connect-anytype [--key <anytype api key>]
//   node architect-anytype.mjs ui            mapping editor + sync, at http://127.0.0.1:31019
//   node architect-anytype.mjs run [--ui]    sync in the background (install-windows.ps1 starts it with --ui)
//   node architect-anytype.mjs sync          one sync of every mapping, then exit
//   node architect-anytype.mjs status        pairing, Anytype access and mappings
//   node architect-anytype.mjs inspect [--space <id>] [--collection <id>] [--object <id>]
//                                            read-only smoke test: shapes and counts, no content
//   node architect-anytype.mjs forget        delete the saved Architect token, Anytype key and config
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const VERSION = '1.0.0';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI_PORT = 31019;
const MAX_ITEMS = 500;

/* ================= config + secrets ================= */
const DIR = process.platform === 'win32'
  ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'ArchitectAnytype')
  : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'architect-anytype');
const CONFIG = path.join(DIR, 'config.json');
const DEFAULTS = {
  project: '', publishableKey: '', connectorId: '', username: '',
  anytypeBase: 'http://127.0.0.1:31009', apiPrefix: 'v2', anytypeVersion: '2025-11-08',
  pollMinutes: 5, uiPort: UI_PORT,
};
const readConfig = () => { try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG, 'utf8')) }; } catch { return { ...DEFAULTS }; } };
const writeConfig = (c) => { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(CONFIG, JSON.stringify(c, null, 2)); };

const secrets = {
  file: (name) => path.join(DIR, `${name}.secret`),
  set(name, value) {
    fs.mkdirSync(DIR, { recursive: true });
    if (process.platform === 'win32') {
      // DPAPI, current user: only this Windows account on this PC can decrypt it. The value travels in an
      // environment variable, never on a command line.
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        '$s = ConvertTo-SecureString -String $env:ARCH_SECRET -AsPlainText -Force; ConvertFrom-SecureString $s'],
      { env: { ...process.env, ARCH_SECRET: value }, encoding: 'utf8' });
      if (r.status !== 0) throw new Error('Windows refused to protect the secret (DPAPI).');
      fs.writeFileSync(this.file(name), r.stdout.trim());
    } else if (process.platform === 'darwin') {
      const r = spawnSync('security', ['add-generic-password', '-U', '-a', 'architect-anytype', '-s', `architect-anytype.${name}`, '-w', value]);
      if (r.status !== 0) throw new Error('macOS Keychain refused the secret.');
    } else {
      fs.writeFileSync(this.file(name), value, { mode: 0o600 });
    }
  },
  get(name) {
    try {
      if (process.platform === 'win32') {
        if (!fs.existsSync(this.file(name))) return null;
        const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          '$s = Get-Content -Raw $env:ARCH_FILE | ConvertTo-SecureString; [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))'],
        { env: { ...process.env, ARCH_FILE: this.file(name) }, encoding: 'utf8' });
        return r.status === 0 ? r.stdout.replace(/\r?\n$/, '') || null : null;
      }
      if (process.platform === 'darwin') {
        const r = spawnSync('security', ['find-generic-password', '-a', 'architect-anytype', '-s', `architect-anytype.${name}`, '-w'], { encoding: 'utf8' });
        return r.status === 0 ? r.stdout.trim() || null : null;
      }
      return fs.existsSync(this.file(name)) ? fs.readFileSync(this.file(name), 'utf8').trim() || null : null;
    } catch { return null; }
  },
  del(name) {
    try { fs.rmSync(this.file(name), { force: true }); } catch {}
    if (process.platform === 'darwin') spawnSync('security', ['delete-generic-password', '-a', 'architect-anytype', '-s', `architect-anytype.${name}`]);
  },
};
// Tests point these at a temporary store.
if (process.env.ARCHITECT_ANYTYPE_TEST_SECRETS) {
  const f = (n) => path.join(process.env.ARCHITECT_ANYTYPE_TEST_SECRETS, `${n}.secret`);
  secrets.set = (n, v) => { fs.mkdirSync(path.dirname(f(n)), { recursive: true }); fs.writeFileSync(f(n), v, { mode: 0o600 }); };
  secrets.get = (n) => { try { return fs.readFileSync(f(n), 'utf8'); } catch { return null; } };
  secrets.del = (n) => fs.rmSync(f(n), { force: true });
}

/* ================= logging (redacted) ================= */
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = (...a) => console.log(`[${stamp()}]`, ...a);
const redact = (s) => String(s ?? '').replace(/(axc_|Bearer\s+)[\w-]+/g, '$1••••').replace(/[A-Za-z0-9+/_-]{32,}/g, '••••').slice(0, 300);

/* ================= Architect (Supabase RPC) ================= */
class ArchitectError extends Error { constructor(msg, code, status) { super(msg); this.code = code; this.status = status; } }
async function rpc(cfg, name, args) {
  if (!cfg.project || !cfg.publishableKey) throw new ArchitectError('Not paired. Run: node architect-anytype.mjs pair <CODE> --project … --key …', 'not_paired');
  const url = `${cfg.project.replace(/\/$/, '')}/rest/v1/rpc/${name}`;
  if (!/^https:\/\//.test(url) && !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)) throw new ArchitectError('Architect must be reached over HTTPS.', 'insecure');
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers: { apikey: cfg.publishableKey, 'Content-Type': 'application/json' }, body: JSON.stringify(args), signal: AbortSignal.timeout(20000) });
  } catch (e) { throw new ArchitectError(`Can’t reach Architect (${e.cause?.code || e.name}).`, 'offline'); }
  const text = await res.text();
  let body = null; try { body = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) {
    const msg = body?.message || text || res.statusText;
    throw new ArchitectError(msg, /connector_revoked/.test(msg) ? 'revoked' : /stale_mapping/.test(msg) ? 'stale' : /mapping_disabled/.test(msg) ? 'disabled' : /too_many/.test(msg) ? 'too_many' : body?.code || 'error', res.status);
  }
  return body;
}

/* ================= Anytype (loopback API) ================= */
class AnytypeError extends Error { constructor(msg, kind, status) { super(msg); this.kind = kind; this.status = status; } }
function anytype(cfg, key) {
  const base = cfg.anytypeBase.replace(/\/$/, '');
  if (!/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(base)) throw new AnytypeError('The Anytype API must be on this PC (127.0.0.1).', 'config');
  const pre = `/${cfg.apiPrefix}`;
  async function call(method, p, body) {
    let res;
    try {
      res = await fetch(`${base}${pre}${p}`, {
        method,
        headers: { Authorization: `Bearer ${key}`, 'Anytype-Version': cfg.anytypeVersion, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20000),
      });
    } catch (e) { throw new AnytypeError('Anytype isn’t running (or its API is off) on this PC.', 'closed'); }
    const text = await res.text();
    let j = null; try { j = text ? JSON.parse(text) : null; } catch {}
    if (res.status === 401 || res.status === 403) throw new AnytypeError(`Anytype refused access (${res.status}).`, 'no_access', res.status);
    if (res.status === 404) throw new AnytypeError('Not found in Anytype.', 'missing', 404);
    if (!res.ok) throw new AnytypeError(`Anytype error ${res.status}.`, 'error', res.status);
    return j;
  }
  // Every page of a list (v2: {data,total,offset,limit,has_more}; v1: {data,pagination:{…}}). Throws on a gap.
  async function all(p, { limit = 100, max = 5000 } = {}) {
    const out = [];
    let offset = 0, total = null;
    for (let guard = 0; guard < 200; guard++) {
      const j = await call('GET', `${p}${p.includes('?') ? '&' : '?'}offset=${offset}&limit=${limit}`);
      const rows = Array.isArray(j) ? j : j?.data || j?.objects || [];
      const meta = j?.pagination || j || {};
      if (typeof meta.total === 'number') total = meta.total;
      out.push(...rows);
      if (out.length > max) throw new AnytypeError(`More than ${max} entries.`, 'too_many');
      const more = meta.has_more ?? (total != null ? out.length < total : rows.length === limit);
      if (!more || !rows.length) break;
      offset += rows.length;
    }
    if (total != null && out.length < total) throw new AnytypeError(`Anytype returned ${out.length} of ${total} entries.`, 'partial');
    return out;
  }
  return {
    call, all,
    spaces: () => all('/spaces'),
    object: (sid, oid) => call('GET', `/spaces/${encodeURIComponent(sid)}/objects/${encodeURIComponent(oid)}`).then(unwrap),
    collection: (sid, cid) => all(`/spaces/${encodeURIComponent(sid)}/collections/${encodeURIComponent(cid)}/objects`),
    objects: (sid) => all(`/spaces/${encodeURIComponent(sid)}/objects`, { max: 20000 }),
    search: (sid, query) => call('POST', `/spaces/${encodeURIComponent(sid)}/search?limit=100`, { query }).then((j) => (Array.isArray(j) ? j : j?.data || [])),
  };
}
const unwrap = (j) => j?.object || j?.data || j?.document || j || {};

/* ---------- normalizing what Anytype returns (v2 flat AnyBlock documents, v1 nested blocks) ---------- */
const typeKey = (o) => String(o?.type?.key ?? o?.type_key ?? o?.type ?? o?.layout ?? '').toLowerCase();
const isChat = (o) => /chat/.test(typeKey(o)) || /chat/.test(String(o?.layout || '').toLowerCase());
const nameOf = (o) => String(o?.name ?? o?.properties?.name ?? o?.title ?? '').trim();
const cleanText = (t) => String(t ?? '')
  .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
  .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/(\*\*|__|~~|`)/g, '')
  .replace(/(^|\s)[*_](\S[^*_]*\S|\S)[*_](?=\s|$)/g, '$1$2')
  .replace(/^\s*#{1,6}\s+/, '')
  .replace(/^\s*(?:[-*+•]|\d+[.)])\s+/, '')
  .replace(/^\s*\[[ xX]\]\s+/, '')
  .replace(/\s+/g, ' ').trim();
const blockText = (b) => (typeof b?.text === 'string' ? b.text : b?.text?.text ?? b?.content ?? b?.markdown ?? '');
const blockKind = (b) => String(b?.type ?? b?.text?.style ?? b?.style ?? '').toLowerCase();
/** 0 = title (never a section), 1–6 = heading rank (1 highest), null = not a heading. */
function headingRank(b) {
  const k = blockKind(b);
  if (k === 'title') return 0;
  let m = k.match(/^(?:h|header|heading)[\s_-]?(\d)$/);
  if (m) return Number(m[1]);
  if (/^(heading|header)$/.test(k)) return Number(b?.level ?? b?.heading?.level ?? 2) || 2;
  return null;
}
const isListItem = (b) => /bullet|marked|checkbox|check|todo|task|numbered|ordered|list/.test(blockKind(b));
/** The document's blocks in reading order, each with { id, kind, rank, text, indent }. */
function flatBlocks(doc) {
  const raw = doc?.blocks || doc?.content?.blocks || [];
  const byId = new Map(raw.map((b) => [b.id, b]));
  const kidsOf = (b) => b?.children_ids || b?.childrenIds || b?.children || [];
  const nested = raw.some((b) => kidsOf(b).length);
  const out = [];
  const push = (b, indent) => out.push({ id: b.id, kind: blockKind(b), rank: headingRank(b), item: isListItem(b), text: cleanText(blockText(b)), indent: Number(b.indent ?? indent) || 0, checked: !!(b.checked ?? b.text?.checked) });
  if (nested) {
    // v1: a tree under the root (the root's id is the object's id, or the block nobody points to)
    const pointed = new Set(raw.flatMap(kidsOf));
    const roots = raw.filter((b) => !pointed.has(b.id));
    const seen = new Set();
    const walk = (b, d) => { if (!b || seen.has(b.id)) return; seen.add(b.id); if (blockKind(b) || blockText(b)) push(b, d); for (const k of kidsOf(b)) walk(byId.get(k), d + (blockKind(b) ? 1 : 0)); };
    roots.forEach((r) => walk(r, -1));
  } else raw.forEach((b) => push(b, 0)); // v2: already a flat, pre-order array with indent
  return out;
}
/** Headings in a page, with how many list items sit under each. */
function headingsOf(doc) {
  const bl = flatBlocks(doc);
  return bl.map((b, i) => (b.rank > 0 ? { id: b.id, text: b.text, rank: b.rank, items: sectionItems(bl, i).length } : null)).filter(Boolean);
}
function sectionItems(bl, at) {
  const rank = bl[at].rank;
  const out = [];
  for (let i = at + 1; i < bl.length; i++) {
    const b = bl[i];
    if (b.rank != null && b.rank > 0 && b.rank <= rank) break; // the next heading of equal or higher rank
    if (b.item && b.text) out.push(b);
  }
  return out;
}
/** A YYYY-MM-DD from a typed date property (v2 map or v1 array), or null. */
function dateProp(o, key) {
  if (!key) return null;
  const p = o?.properties;
  let v = null;
  if (Array.isArray(p)) { const x = p.find((y) => y?.key === key || y?.id === key); v = x?.date ?? x?.value ?? null; }
  else if (p && typeof p === 'object') { const x = p[key]; v = x?.date ?? x?.value ?? x ?? null; }
  if (typeof v === 'number') v = new Date(v * (v < 1e12 ? 1000 : 1)).toISOString();
  const m = String(v ?? '').match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/* ================= reading one mapping ================= */
class ReadError extends Error { constructor(msg, status) { super(msg); this.status = status; } }
/** A complete read of a mapping's scope → items, or a ReadError (never a partial list). */
async function readMapping(at, m) {
  const fields = new Set(m.allow_fields || ['title']);
  const items = [];
  try {
    if (m.source_kind === 'section') {
      const doc = await at.object(m.source_space_id, m.source_id);
      if (isChat(doc)) throw new ReadError('Chats are never imported.', 'unsupported');
      const bl = flatBlocks(doc);
      const at0 = bl.findIndex((b) => b.id === m.section_block_id);
      if (at0 < 0) throw new ReadError(`The heading “${m.section_name || 'Path items'}” isn’t in that page any more.`, 'missing_section');
      if (!(bl[at0].rank > 0)) throw new ReadError('The chosen block is no longer a heading.', 'missing_section');
      sectionItems(bl, at0).forEach((b, i) => items.push({ source_object_id: m.source_id, source_block_id: b.id, sort: i + 1, fields: { title: b.text.slice(0, 500) } }));
    } else {
      const rows = m.source_kind === 'collection' ? await at.collection(m.source_space_id, m.source_id) : (m.object_ids || []).map((id) => ({ id }));
      const allowIds = new Set(m.object_ids || []);
      const allowTypes = new Set((m.allow_types || []).map((t) => String(t).toLowerCase()));
      let i = 0;
      for (const r of rows) {
        if (m.source_kind === 'collection' && allowIds.size && !allowIds.has(r.id)) continue;
        if (isChat(r)) continue; // chats are blocked whatever the filter says
        if (allowTypes.size && !allowTypes.has(typeKey(r))) continue;
        const needFull = m.source_kind === 'objects' || (fields.has('date') && m.date_property) || !nameOf(r);
        const o = needFull ? await at.object(m.source_space_id, r.id) : r;
        if (isChat(o)) continue;
        const title = nameOf(o);
        if (!title) continue;
        const f = { title: title.slice(0, 500) };
        if (fields.has('date') && m.date_property) { const d = dateProp(o, m.date_property); if (d) f.date = d; }
        items.push({ source_object_id: r.id, source_block_id: null, sort: ++i, fields: f });
      }
    }
  } catch (e) {
    if (e instanceof ReadError) throw e;
    if (e instanceof AnytypeError) throw new ReadError(e.message, { closed: 'anytype_closed', no_access: 'no_access', partial: 'partial', too_many: 'too_many', missing: 'missing_section' }[e.kind] || 'error');
    throw new ReadError('Unexpected response from Anytype.', 'error');
  }
  if (items.length > MAX_ITEMS) throw new ReadError(`${items.length} items — narrow the section or collection (max ${MAX_ITEMS}).`, 'too_many');
  return items;
}

/* ================= the sync engine ================= */
function engine(cfg) {
  const token = secrets.get('architect-token');
  const key = secrets.get('anytype-key');
  const at = key ? anytype(cfg, key) : null;
  const state = { running: false, revoked: false, lastRun: 0, lastPollReq: null, backoff: new Map(), results: new Map(), lastStatus: new Map() };

  async function mappings() {
    const list = await rpc(cfg, 'anytype_list_mappings', { token });
    return (list || []).filter((m) => m.connector_id === cfg.connectorId); // only the ones this PC owns
  }
  async function report(m, status, message) {
    const sig = `${status}|${message}`;
    if (state.lastStatus.get(m.id) === sig) return; // don't repeat the same error every few minutes
    state.lastStatus.set(m.id, sig);
    try { await rpc(cfg, 'anytype_report', { token, p_mapping_id: m.id, p_mapping_version: m.version, p_status: status, p_message: message }); } catch {}
  }
  async function runOne(m) {
    const b = state.backoff.get(m.id);
    if (b && Date.now() < b.until) return { id: m.id, skipped: 'backoff' };
    try {
      if (!at) throw new ReadError('Anytype isn’t connected on this PC. Run: node architect-anytype.mjs connect-anytype', 'no_access');
      const items = await readMapping(at, m);
      const r = await rpc(cfg, 'anytype_publish', { token, p_mapping_id: m.id, p_mapping_version: m.version, items, complete: true });
      state.backoff.delete(m.id); state.lastStatus.set(m.id, 'ok|');
      log(`✓ ${m.name || m.id.slice(0, 8)} v${m.version}: ${r.kept} items (${r.new} new, ${r.changed} changed, ${r.archived} archived)`);
      return { id: m.id, ok: true, ...r };
    } catch (e) {
      if (e instanceof ArchitectError && e.code === 'revoked') { state.revoked = true; throw e; }
      if (e instanceof ArchitectError && (e.code === 'stale' || e.code === 'disabled')) { log(`· ${m.name || m.id.slice(0, 8)}: ${e.code} — will reload mappings`); return { id: m.id, skipped: e.code }; }
      const status = e instanceof ReadError ? e.status : e instanceof ArchitectError && e.code === 'too_many' ? 'too_many' : 'error';
      const prev = state.backoff.get(m.id)?.n || 0;
      const transient = ['anytype_closed', 'error', 'partial'].includes(status) || e instanceof ArchitectError;
      if (transient) state.backoff.set(m.id, { n: prev + 1, until: Date.now() + Math.min(30 * 60_000, 30_000 * 2 ** prev) });
      if (!(e instanceof ArchitectError && e.code === 'offline')) await report(m, status, e.message); // keeps the last good import
      log(`✗ ${m.name || m.id.slice(0, 8)}: ${status} — ${redact(e.message)}`);
      return { id: m.id, ok: false, status, message: e.message };
    }
  }
  async function runAll(reason = 'timer', { force = false } = {}) {
    if (state.running || state.revoked) return [];
    if (!force && reason === 'manual' && Date.now() - state.lastRun < 15_000) return []; // debounce Sync now
    state.running = true;
    try {
      if (force) state.backoff.clear();
      const list = (await mappings()).filter((m) => m.enabled && !m.paused && m.dest_kind === 'path');
      const out = [];
      for (const m of list) out.push(await runOne(m)); // serialized per connector (and per mapping on the server)
      state.lastRun = Date.now();
      if (list.length) log(`sync (${reason}): ${out.filter((x) => x.ok).length}/${list.length} ok`);
      return out;
    } catch (e) {
      if (e instanceof ArchitectError && e.code === 'revoked') { state.revoked = true; log('This PC was disconnected in Architect. Pair it again to resume.'); }
      else log(`sync (${reason}) failed: ${redact(e.message)}`);
      return [];
    } finally { state.running = false; }
  }
  async function poll() {
    try {
      const p = await rpc(cfg, 'anytype_poll', { token });
      if (p?.sync_requested_at && p.sync_requested_at !== state.lastPollReq) {
        const first = state.lastPollReq === null;
        state.lastPollReq = p.sync_requested_at;
        if (!first) await runAll('Sync now', { force: true });
      } else if (state.lastPollReq === null) state.lastPollReq = p?.sync_requested_at || '';
    } catch (e) { if (e instanceof ArchitectError && e.code === 'revoked') { state.revoked = true; log('This PC was disconnected in Architect.'); } }
  }
  function start() {
    log(`Architect Anytype connector ${VERSION} — syncing every ${cfg.pollMinutes} min; Sync now is checked every 45 s.`);
    runAll('startup');
    setInterval(() => runAll('timer'), Math.max(1, cfg.pollMinutes) * 60_000);
    setInterval(poll, 45_000);
    poll();
    // Resume / reconnect: a long gap between ticks means the PC slept.
    let last = Date.now();
    setInterval(() => { const now = Date.now(); if (now - last > 90_000) runAll('resume', { force: true }); last = now; }, 15_000);
  }
  return { token, key, at, state, mappings, runAll, runOne, start, readMapping: (m) => readMapping(at, m) };
}

/* ================= the local mapping editor (127.0.0.1 only) ================= */
function serveUi(cfg, eng, { open = true } = {}) {
  const session = randomBytes(18).toString('hex');
  const port = cfg.uiPort || UI_PORT;
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  const html = fs.readFileSync(path.join(HERE, 'ui.html'), 'utf8').replace('__SESSION__', session);
  const send = (res, code, body, type = 'application/json') => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
      ...(type.startsWith('text/html') ? { 'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'" } : {}) });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  const readBody = (req) => new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > 256 * 1024) { reject(new Error('too big')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); } });
  });
  let dests = null;
  const destinations = async () => (dests ||= await rpc(cfg, 'anytype_destinations', { token: eng.token }));
  const srv = http.createServer(async (req, res) => {
    // DNS-rebinding and cross-site guards: our own host, our own origin, our own session.
    if (!hosts.has(req.headers.host || '')) return send(res, 403, { error: 'host' });
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (req.method === 'GET' && url.pathname === '/') return send(res, 200, html, 'text/html; charset=utf-8');
    if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });
    if (req.headers.origin && !origins.has(req.headers.origin)) return send(res, 403, { error: 'origin' });
    if (req.headers['x-architect-ui'] !== session) return send(res, 403, { error: 'session' });
    try {
      const p = url.pathname.slice(5);
      if (req.method === 'GET' && p === 'state') {
        let who = null, maps = [], anytypeOk = false, anytypeError = null;
        try { who = await rpc(cfg, 'anytype_poll', { token: eng.token }); maps = await rpc(cfg, 'anytype_list_mappings', { token: eng.token }); } catch (e) { return send(res, 200, { paired: false, error: e.message }); }
        try { if (eng.at) { await eng.at.spaces(); anytypeOk = true; } else anytypeError = 'Anytype isn’t connected yet. Run: node architect-anytype.mjs connect-anytype'; } catch (e) { anytypeError = e.message; }
        dests = null;
        return send(res, 200, { paired: true, username: who?.username, connector: who?.name, connectorId: cfg.connectorId, anytypeOk, anytypeError, mappings: maps, destinations: await destinations(), version: VERSION });
      }
      if (!eng.at) return send(res, 409, { error: 'Anytype isn’t connected yet. Run: node architect-anytype.mjs connect-anytype' });
      if (req.method === 'GET' && p === 'spaces') return send(res, 200, (await eng.at.spaces()).map((s) => ({ id: s.id, name: nameOf(s) || s.id })));
      if (req.method === 'GET' && p === 'objects') {
        const sid = url.searchParams.get('space') || '';
        const q = (url.searchParams.get('q') || '').trim();
        const rows = q ? await eng.at.search(sid, q) : (await eng.at.objects(sid)).slice(0, 400);
        return send(res, 200, rows.filter((o) => !isChat(o)).map((o) => ({ id: o.id, name: nameOf(o) || '(untitled)', type: typeKey(o) })));
      }
      if (req.method === 'GET' && p === 'headings') {
        const doc = await eng.at.object(url.searchParams.get('space') || '', url.searchParams.get('object') || '');
        if (isChat(doc)) return send(res, 200, { name: nameOf(doc), headings: [], chat: true });
        return send(res, 200, { name: nameOf(doc), headings: headingsOf(doc) });
      }
      if (req.method === 'POST' && p === 'preview') {
        const { mapping } = await readBody(req);
        const items = await readMapping(eng.at, { allow_fields: ['title'], ...mapping });
        const d = await destinations();
        const dest = (d.path || []).find((c) => c.id === mapping.dest_id);
        return send(res, 200, { items, count: items.length, fields: mapping.allow_fields || ['title'], destination: dest ? `Path · ${dest.title}` : null, visibility: 'Private — only your account' });
      }
      if (req.method === 'POST' && p === 'save') {
        const { mapping } = await readBody(req);
        const saved = await rpc(cfg, 'anytype_save_mapping', { token: eng.token, m: { ...mapping, enabled: true } });
        const r = await eng.runOne(saved);
        return send(res, 200, { saved, run: r });
      }
      if (req.method === 'POST' && p === 'sync') return send(res, 200, { results: await eng.runAll('manual', { force: true }) });
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      const msg = e instanceof ReadError || e instanceof AnytypeError || e instanceof ArchitectError ? e.message : 'Something went wrong.';
      return send(res, e instanceof ReadError ? 422 : 500, { error: msg, status: e.status || e.kind || e.code || 'error' });
    }
  });
  srv.listen(port, '127.0.0.1', () => {
    const u = `http://127.0.0.1:${port}`;
    log(`Mapping editor: ${u}  (this PC only)`);
    if (open && !process.env.ARCHITECT_ANYTYPE_NO_OPEN) openUrl(u);
  });
  return srv;
}

function openUrl(u) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', u]] : process.platform === 'darwin' ? ['open', [u]] : ['xdg-open', [u]];
  try { spawnSync(cmd[0], cmd[1], { stdio: 'ignore' }); } catch {}
}

/* ================= commands ================= */
function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; out[k] = v; }
    else out._.push(a);
  }
  return out;
}
function ask(q, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) { rl._writeToOutput = (s) => { if (s.includes(q)) rl.output.write(s); }; }
    rl.question(q, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(a.trim()); });
  });
}

async function cmdPair(a) {
  const code = a._[1];
  const cfg = readConfig();
  if (a.project) cfg.project = String(a.project).replace(/\/$/, '');
  if (a.key) cfg.publishableKey = String(a.key);
  if (!code || !cfg.project || !cfg.publishableKey) { console.log('Usage: node architect-anytype.mjs pair <CODE> --project https://….supabase.co --key sb_publishable_…'); process.exit(2); }
  const r = await rpc(cfg, 'anytype_pair_finish', { code, name: String(a.name || os.hostname()).slice(0, 40) });
  secrets.set('architect-token', r.token);
  cfg.connectorId = r.connector_id; cfg.username = r.username || '';
  writeConfig(cfg);
  console.log(`Paired with ${r.username || 'your account'}. The token is in ${process.platform === 'win32' ? 'Windows DPAPI' : process.platform === 'darwin' ? 'the Keychain' : 'a private file'}.`);
  console.log('Next: node architect-anytype.mjs connect-anytype');
}

async function cmdConnectAnytype(a) {
  const cfg = readConfig();
  let key = typeof a.key === 'string' ? a.key : null;
  if (!key) {
    // Anytype's local grant: Desktop shows a 4-digit code to approve this app.
    try {
      const base = `${cfg.anytypeBase.replace(/\/$/, '')}/${cfg.apiPrefix}`;
      const ch = await fetch(`${base}/auth/challenges`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Anytype-Version': cfg.anytypeVersion }, body: JSON.stringify({ app_name: 'Architect' }) }).then((r) => (r.ok ? r.json() : null));
      const id = ch?.challenge_id || ch?.id;
      if (id) {
        const code = await ask('Anytype is showing a 4-digit code. Type it here: ');
        const k = await fetch(`${base}/auth/api_keys`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Anytype-Version': cfg.anytypeVersion }, body: JSON.stringify({ challenge_id: id, code }) }).then((r) => (r.ok ? r.json() : null));
        key = k?.api_key || k?.key || null;
      }
    } catch {}
    if (!key) key = await ask('Paste an Anytype API key (Anytype → Settings → API keys). It isn’t shown: ', { hidden: true });
  }
  if (!key) { console.log('No key — nothing saved.'); process.exit(2); }
  try { await anytype(cfg, key).spaces(); } catch (e) { console.log(`Anytype didn’t accept that key: ${e.message}`); process.exit(1); }
  secrets.set('anytype-key', key);
  console.log('Anytype connected. The key stays on this PC only. Next: node architect-anytype.mjs ui');
}

async function cmdStatus() {
  const cfg = readConfig();
  const eng = engine(cfg);
  console.log(`Connector ${VERSION} · config ${CONFIG}`);
  console.log(`Architect: ${cfg.project || '(not paired)'} · token ${eng.token ? 'saved' : 'missing'} · user ${cfg.username || '?'}`);
  console.log(`Anytype: ${cfg.anytypeBase}/${cfg.apiPrefix} · key ${eng.key ? 'saved' : 'missing'}`);
  if (eng.at) { try { const s = await eng.at.spaces(); console.log(`  reachable · ${s.length} space(s)`); } catch (e) { console.log(`  ${e.message}`); } }
  if (eng.token) {
    try {
      const ms = await rpc(cfg, 'anytype_list_mappings', { token: eng.token });
      for (const m of ms) console.log(`  · ${m.name || m.id.slice(0, 8)} v${m.version} ${m.enabled ? (m.paused ? 'paused' : 'on') : 'off'} → Path · ${m.dest_name} · ${m.run?.status || 'never'} · ${m.run?.item_count ?? 0} items${m.connector_id === cfg.connectorId ? '' : ' (another PC)'}`);
    } catch (e) { console.log(`  Architect: ${redact(e.message)}`); }
  }
}

// Read-only smoke test (runbook §02): shapes and counts, never content.
async function cmdInspect(a) {
  const cfg = readConfig();
  const key = secrets.get('anytype-key');
  if (!key) { console.log('Run connect-anytype first.'); process.exit(2); }
  const at = anytype(cfg, key);
  const shape = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, Array.isArray(v) ? `array(${v.length})` : v && typeof v === 'object' ? `{${Object.keys(v).slice(0, 8).join(',')}}` : typeof v]));
  const spaces = await at.spaces();
  console.log(`GET /${cfg.apiPrefix}/spaces → ${spaces.length} space(s); row keys: ${Object.keys(spaces[0] || {}).join(', ')}`);
  for (const s of spaces) console.log(`  · ${s.id.slice(0, 6)}…  (${String(nameOf(s)).length} chars)`);
  const sid = a.space || spaces[0]?.id;
  if (a.collection) {
    const rows = await at.collection(sid, a.collection);
    const types = {};
    for (const r of rows) types[typeKey(r)] = (types[typeKey(r)] || 0) + 1;
    console.log(`GET …/collections/${String(a.collection).slice(0, 10)}…/objects → ${rows.length} entries; types ${JSON.stringify(types)}; chats ${rows.filter(isChat).length}`);
    console.log(`  row shape: ${JSON.stringify(shape(rows[0]))}`);
  }
  if (a.object) {
    const doc = await at.object(sid, a.object);
    const bl = flatBlocks(doc);
    const kinds = {};
    for (const b of bl) kinds[b.kind || '(none)'] = (kinds[b.kind || '(none)'] || 0) + 1;
    console.log(`GET …/objects/${String(a.object).slice(0, 10)}… → envelope ${JSON.stringify(shape(doc))}`);
    console.log(`  ${bl.length} blocks; kinds ${JSON.stringify(kinds)}`);
    console.log(`  headings: ${headingsOf(doc).map((x) => `${x.id.slice(-6)}(h${x.rank}, ${x.items} items)`).join(' ') || 'none'}`);
    if (a.ids) for (const b of bl) console.log(`    ${b.id}  ${b.kind.padEnd(10)} indent ${b.indent}  ${b.text.length} chars`);
  }
}

async function main() {
  const a = args(process.argv.slice(2));
  const cmd = a._[0] || 'help';
  if (cmd === 'pair') return cmdPair(a);
  if (cmd === 'connect-anytype') return cmdConnectAnytype(a);
  if (cmd === 'status') return cmdStatus();
  if (cmd === 'inspect') return cmdInspect(a);
  if (cmd === 'forget') {
    secrets.del('architect-token'); secrets.del('anytype-key');
    try { fs.rmSync(CONFIG, { force: true }); } catch {}
    console.log('Removed the saved Architect token, Anytype key and config from this PC. Disconnect it in Architect → Settings → Integrations too (imported items stay until you remove them there).');
    return;
  }
  const cfg = readConfig();
  if (cmd === 'sync') { const eng = engine(cfg); if (!eng.token) throw new Error('Not paired.'); const r = await eng.runAll('manual', { force: true }); process.exitCode = r.every((x) => x.ok || x.skipped) ? 0 : 1; return; }
  if (cmd === 'run' || cmd === 'ui') {
    const url = `http://127.0.0.1:${cfg.uiPort || UI_PORT}`;
    // Already running in the background (install-windows.ps1)? Just open its editor.
    const up = await fetch(url, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok).catch(() => false);
    if (up) {
      if (cmd === 'ui') { console.log(`The connector is already running — opening ${url}`); openUrl(url); }
      else console.log('The connector is already running on this PC.');
      return;
    }
    const eng = engine(cfg);
    if (!eng.token) { console.log('Not paired yet. In Architect: Settings → Integrations → Connect a PC.'); process.exit(2); }
    eng.start();
    if (cmd === 'ui' || a.ui) serveUi(cfg, eng, { open: !a['no-open'] });
    return;
  }
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 25).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
}

// Exported for tests.
export { flatBlocks, headingsOf, sectionItems, readMapping, cleanText, dateProp, anytype, engine, serveUi, readConfig };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(redact(e.message)); process.exit(1); });
}
