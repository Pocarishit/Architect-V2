#!/usr/bin/env node
// Architect runner (Nov 24) — runs the updates you push from Settings → Updates & Fixes.
//
// Runs on your PC, hidden (no terminal windows, pop-ups or focus stealing). Every few seconds it asks
// Architect for the next due run (Push Update = now, Schedule = later). For each one it:
//   1. resumes the Claude session linked to Architect (this note's last session, or the one you linked with
//      --session) — or starts a fresh one with the note and the latest saved project (git pull);
//   2. reports every step, the status and an estimated time left back to the panel in Settings;
//   3. stops as Blocked when Claude needs your input (you answer in the panel; it resumes with your answer);
//   4. writes the tested result back onto the note.
//
// No dependencies (Node 18+). Needs Claude Code on this PC (the `claude` command), signed in.
//
//   node architect-runner.mjs setup --token arch_… --repo "C:\path\to\Architect-V2" [--session <id>] [--push]
//   node architect-runner.mjs run        keep running (install-windows.ps1 starts this at sign-in)
//   node architect-runner.mjs once       one pass, then exit
//   node architect-runner.mjs status
//   node architect-runner.mjs forget     delete the saved token and config
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '1.0.0';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = process.platform === 'win32'
  ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'ArchitectRunner')
  : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'architect-runner');
const CONFIG = path.join(DIR, 'config.json');
const DEFAULTS = {
  project: '', publishableKey: '', repo: '', session: '', claude: '', push: false, pollSeconds: 8, maxMinutes: 90,
  allowedTools: 'Read,Edit,Write,MultiEdit,Glob,Grep,Bash,TodoWrite',
};
const readConfig = () => { try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG, 'utf8')) }; } catch { return { ...DEFAULTS }; } };
const writeConfig = (c) => { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(CONFIG, JSON.stringify(c, null, 2)); };
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = (...a) => console.log(`[${stamp()}]`, ...a);

/* ---------- the API token: Windows DPAPI (this user only), else a 0600 file ---------- */
const secretFile = path.join(DIR, 'token.secret');
const secret = {
  set(v) {
    fs.mkdirSync(DIR, { recursive: true });
    if (process.platform === 'win32') {
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$s = ConvertTo-SecureString -String $env:ARCH_SECRET -AsPlainText -Force; ConvertFrom-SecureString $s'],
        { env: { ...process.env, ARCH_SECRET: v }, encoding: 'utf8', windowsHide: true });
      if (r.status !== 0) throw new Error('Windows refused to protect the token (DPAPI).');
      fs.writeFileSync(secretFile, r.stdout.trim());
    } else fs.writeFileSync(secretFile, v, { mode: 0o600 });
  },
  get() {
    try {
      if (!fs.existsSync(secretFile)) return null;
      if (process.platform === 'win32') {
        const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$s = Get-Content -Raw $env:ARCH_FILE | ConvertTo-SecureString; [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))'],
          { env: { ...process.env, ARCH_FILE: secretFile }, encoding: 'utf8', windowsHide: true });
        return r.status === 0 ? r.stdout.replace(/\r?\n$/, '') || null : null;
      }
      return fs.readFileSync(secretFile, 'utf8').trim() || null;
    } catch { return null; }
  },
  del() { try { fs.rmSync(secretFile, { force: true }); } catch {} },
};

/* ---------- Architect ---------- */
function projectFromRepo(repo) {
  // config.js in the Architect folder already holds the project URL and publishable key.
  try {
    const t = fs.readFileSync(path.join(repo, 'config.js'), 'utf8');
    return { project: t.match(/supabaseUrl:\s*'([^']+)'/)?.[1] || '', publishableKey: t.match(/supabaseKey:\s*'([^']+)'/)?.[1] || '' };
  } catch { return { project: '', publishableKey: '' }; }
}
async function runner(cfg, token, action, payload = {}) {
  const url = `${cfg.project.replace(/\/$/, '')}/rest/v1/rpc/architect_runner`;
  const res = await fetch(url, { method: 'POST', headers: { apikey: cfg.publishableKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ token, action, payload }), signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  let body = null; try { body = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) throw new Error(body?.message || text || res.statusText);
  return body;
}

/* ---------- Claude Code ---------- */
function findClaude(cfg) {
  if (cfg.claude && fs.existsSync(cfg.claude)) return cfg.claude;
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], { encoding: 'utf8', windowsHide: true });
  const hits = (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return hits.find((x) => /\.exe$/i.test(x)) || hits.find((x) => /\.cmd$/i.test(x)) || hits[0] || null;
}

function promptFor(run, cfg, previews) {
  const n = run.note || {};
  if (run.answer && run.session) {
    return `Answer from the user (they read your question in Architect → Settings → Updates & Fixes):\n${run.answer}\n\nCarry on with the update. Keep using the ARCHITECT_STEP / ARCHITECT_BLOCKED / ARCHITECT_RESULT lines.`;
  }
  return [
    `You are updating Architect, the web app in this folder (plain HTML, CSS and JS modules, Supabase backend; see README.md and the newest UPDATES-*.md).`,
    `Update note from the Architect SYSTEM Updates board:`,
    `TITLE: ${n.title || run.title || 'Untitled update'}`,
    n.text ? `DETAILS:\n${n.text}` : '',
    previews.length ? `Preview images (screenshots the user linked to this note — look at them):\n${previews.map((p) => `- ${p}`).join('\n')}` : '',
    '',
    'How to work:',
    '- Implement the change with the smallest clean edit that fits the existing code and style. Keep Architect on free services.',
    '- Test it before you finish: at least `node --check` on every JS file you changed, plus any tests in the repo that cover it.',
    '- As you go, print progress lines exactly like:  ARCHITECT_STEP: <what you are doing, a few words>',
    '- If you truly cannot continue without a decision from the user, print  ARCHITECT_BLOCKED: <one clear question>  and stop.',
    '- When it is done and tested, print  ARCHITECT_RESULT: <2–4 sentences: what changed, how you tested it, which files>.',
    cfg.push ? '- Commit the change with a clear message and push it to the current branch.' : '- Do not commit or push; leave the changes in the working folder for the user to review.',
  ].filter((x) => x !== '').join('\n');
}

function describeTool(t) {
  const i = t.input || {};
  const f = (p) => (p ? path.basename(String(p)) : '');
  switch (t.name) {
    case 'Edit': case 'MultiEdit': return `Editing ${f(i.file_path)}`;
    case 'Write': return `Writing ${f(i.file_path)}`;
    case 'Read': return `Reading ${f(i.file_path)}`;
    case 'Grep': return `Searching for “${String(i.pattern || '').slice(0, 40)}”`;
    case 'Glob': return `Looking for ${String(i.pattern || '').slice(0, 40)}`;
    case 'Bash': return `Running ${String(i.description || i.command || '').replace(/\s+/g, ' ').slice(0, 70)}`;
    case 'TodoWrite': { const now = (i.todos || []).find((x) => x.status === 'in_progress'); return now ? (now.activeForm || now.content) : null; }
    default: return null;
  }
}

async function download(previews, dir) {
  const out = [];
  fs.mkdirSync(dir, { recursive: true });
  for (const [k, p] of (previews || []).entries()) {
    if (!p?.url || !/^https:\/\//.test(p.url)) continue;
    try {
      const res = await fetch(p.url, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) continue;
      const type = res.headers.get('content-type') || '';
      const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : type.includes('gif') ? 'gif' : 'jpg';
      const file = path.join(dir, `${String(k + 1).padStart(2, '0')}-${(p.name || 'preview').replace(/[^\w.-]+/g, '_').slice(0, 40)}.${ext}`);
      fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      out.push(file);
    } catch {}
  }
  return out;
}

const stopChild = (child) => {
  if (!child || child.exitCode != null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  else { try { child.kill(); } catch {} }
};

async function work(cfg, token, run) {
  const started = Date.now();
  const avg = Number(run.avg_seconds) || 0;
  let lastStep = '', lastSent = 0, session = run.session || cfg.session || '', blocked = null, result = null, finalText = '', canceled = false;
  const send = async (p) => {
    try {
      const r = await runner(cfg, token, 'report', { id: run.id, ...p, ...(avg ? { eta_seconds: Math.max(20, Math.round(avg - (Date.now() - started) / 1000)) } : {}) });
      if (r?.status === 'canceled') canceled = true;
    } catch (e) { log('report failed:', e.message); }
  };
  const step = (s, force = false) => {
    if (!s || s === lastStep) return;
    lastStep = s;
    if (!force && Date.now() - lastSent < 2500) return;
    lastSent = Date.now();
    send({ step: s, log: s, status: 'running' });
  };

  log(`▶ ${run.title} (${run.id.slice(0, 8)})${session ? ` — resuming ${session.slice(0, 8)}` : ''}`);
  // The latest saved project: pull before a fresh start.
  if (!run.answer && fs.existsSync(path.join(cfg.repo, '.git'))) {
    step('Pulling the latest saved project', true);
    const g = spawnSync('git', ['-C', cfg.repo, 'pull', '--ff-only'], { encoding: 'utf8', windowsHide: true });
    if (g.status !== 0) log('git pull:', (g.stderr || '').trim().slice(0, 200));
  }
  const previews = await download(run.note?.previews, path.join(DIR, 'runs', run.id));
  const claude = findClaude(cfg);
  if (!claude) { await runner(cfg, token, 'finish', { id: run.id, ok: false, result: 'Claude Code isn’t installed on the PC (the `claude` command wasn’t found).' }); return; }

  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--allowedTools', cfg.allowedTools];
  if (session) args.push('--resume', session);
  const shell = /\.cmd$/i.test(claude);
  if (shell && !/^[\w,()* .:-]+$/.test(cfg.allowedTools)) throw new Error('allowedTools has characters the Windows shell would misread.');
  const child = spawn(shell ? `"${claude}"` : claude, args, { cwd: cfg.repo, windowsHide: true, shell, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ARCHITECT_RUN_ID: run.id } });
  child.stdin.end(promptFor(run, cfg, previews));
  step(session ? 'Resuming the Architect session' : 'Starting Claude', true);

  const scan = (text) => {
    for (const line of String(text || '').split(/\r?\n/)) {
      const m = line.match(/^\s*ARCHITECT_(STEP|BLOCKED|RESULT):\s*(.+)$/);
      if (!m) continue;
      if (m[1] === 'STEP') step(m[2].trim().slice(0, 200), true);
      else if (m[1] === 'BLOCKED') blocked = m[2].trim();
      else result = m[2].trim();
    }
  };
  let buf = '', errTail = '';
  child.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      if (ev.session_id && ev.session_id !== session) { session = ev.session_id; send({ session }); }
      if (ev.type === 'assistant') for (const c of ev.message?.content || []) {
        if (c.type === 'text') scan(c.text);
        else if (c.type === 'tool_use') step(describeTool(c));
      }
      if (ev.type === 'result') { finalText = String(ev.result || ''); scan(finalText); if (ev.is_error) errTail = finalText || errTail; }
    }
  });
  child.stderr.on('data', (d) => { errTail = (errTail + d.toString('utf8')).slice(-600); });

  const beat = setInterval(async () => {
    if (canceled) { stopChild(child); return; }
    if (Date.now() - started > cfg.maxMinutes * 60_000) { errTail = `Stopped after ${cfg.maxMinutes} minutes.`; stopChild(child); return; }
    await send({ step: lastStep || 'Working', status: 'running' });
  }, 15_000);
  const code = await new Promise((res) => child.on('close', res));
  clearInterval(beat);

  if (canceled) { log('■ canceled in Architect'); return; }
  if (blocked) {
    log(`⏸ blocked: ${blocked}`);
    await runner(cfg, token, 'report', { id: run.id, status: 'blocked', need: blocked, session, step: 'Waiting for your answer' });
    return;
  }
  const ok = code === 0 && !!(result || finalText);
  const text = result || finalText.split(/\r?\n/).filter(Boolean).slice(-6).join('\n') || errTail.trim() || `Claude exited with code ${code}.`;
  await runner(cfg, token, 'finish', { id: run.id, ok, result: text.slice(0, 4000), session });
  log(`${ok ? '✓' : '✗'} ${run.title} — ${Math.round((Date.now() - started) / 1000)}s`);
}

async function pass(cfg, token) {
  const run = await runner(cfg, token, 'next');
  if (!run) return false;
  try { await work(cfg, token, run); }
  catch (e) { log('run failed:', e.message); try { await runner(cfg, token, 'finish', { id: run.id, ok: false, result: e.message }); } catch {} }
  return true;
}

/* ---------- commands ---------- */
function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; out[k] = v; } else out._.push(a);
  }
  return out;
}
async function main() {
  const a = args(process.argv.slice(2));
  const cmd = a._[0] || 'help';
  let cfg = readConfig();
  if (cmd === 'setup') {
    const repo = path.resolve(String(a.repo || cfg.repo || path.join(HERE, '..')));
    if (!fs.existsSync(path.join(repo, 'index.html'))) throw new Error(`That doesn't look like the Architect folder: ${repo}`);
    const proj = projectFromRepo(repo);
    cfg = { ...cfg, repo, project: String(a.project || proj.project || cfg.project), publishableKey: String(a.key || proj.publishableKey || cfg.publishableKey) };
    if (a.session) cfg.session = a.session === true ? '' : String(a.session);
    if (a.claude) cfg.claude = String(a.claude);
    if ('push' in a) cfg.push = a.push !== 'false';
    if (!cfg.project || !cfg.publishableKey) throw new Error('Missing the Supabase URL / key: pass --project and --key.');
    writeConfig(cfg);
    if (a.token) secret.set(String(a.token));
    const token = secret.get();
    if (!token) throw new Error('Pass --token arch_… (Settings → API → Generate).');
    // Check the token without touching any run: an unknown id answers "Run not found" for a good token.
    try { await runner(cfg, token, 'get', { id: '00000000-0000-0000-0000-000000000000' }); }
    catch (e) { if (!/Run not found/i.test(e.message)) throw new Error(/Invalid API token/i.test(e.message) ? 'Architect refused that token — generate a new one in Settings → API.' : /architect_runner/i.test(e.message) ? 'Run supabase/nov24.sql in the Supabase SQL editor first.' : e.message); }
    console.log(`Ready. Repo: ${repo}\nClaude: ${findClaude(cfg) || 'not found — install Claude Code'}\nNow run install-windows.ps1 (or: node architect-runner.mjs run).`);
    return;
  }
  if (cmd === 'status') { console.log(JSON.stringify({ version: VERSION, ...cfg, token: secret.get() ? 'saved' : 'missing', claude: findClaude(cfg) }, null, 2)); return; }
  if (cmd === 'forget') { secret.del(); try { fs.rmSync(CONFIG, { force: true }); } catch {} console.log('Forgot the token and config.'); return; }
  if (cmd === 'once' || cmd === 'run') {
    const token = secret.get();
    if (!token || !cfg.project) throw new Error('Not set up. Run: node architect-runner.mjs setup --token arch_… --repo <Architect folder>');
    if (cmd === 'once') { await pass(cfg, token); return; }
    log(`Architect runner ${VERSION} — checking every ${cfg.pollSeconds}s for pushed updates. Repo: ${cfg.repo}`);
    for (;;) {
      let busy = false;
      try { busy = await pass(cfg, token); } catch (e) { log('check failed:', e.message); }
      if (!busy) await new Promise((r) => setTimeout(r, Math.max(3, cfg.pollSeconds) * 1000));
      cfg = readConfig();
    }
  }
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 19).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message || e); process.exitCode = 1; });
}
export { promptFor, describeTool };
