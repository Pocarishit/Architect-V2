// End-to-end gates for the Anytype connector (runbook §06), against a mock Anytype (v2 shapes) and the
// real supabase/anytype.sql in a local Postgres (see README in this folder). Test-only; never shipped.
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONN = path.join(HERE, '..', 'architect-anytype.mjs');
const tmp = fs.mkdtempSync('/tmp/axc-');
const env = { ...process.env, XDG_CONFIG_HOME: tmp, ARCHITECT_ANYTYPE_TEST_SECRETS: `${tmp}/secrets`, ARCHITECT_ANYTYPE_NO_OPEN: '1' };
const sql = (q) => execFileSync('sudo', ['-u', 'postgres', 'psql', '-d', 'axtest', '-tAq', '-c', q], { encoding: 'utf8' }).trim();
const node = (...a) => new Promise((res) => { const p = spawn('node', [CONN, ...a], { env }); let stdout = '', stderr = ''; p.stdout.on('data', (d) => { stdout += d; }); p.stderr.on('data', (d) => { stderr += d; }); p.on('close', () => res({ stdout, stderr })); });
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const mock = spawn('node', [path.join(HERE, 'mock-anytype.mjs'), '31999'], { stdio: 'ignore' });
const ctl = (op) => fetch('http://127.0.0.1:31999/__ctl', { method: 'POST', body: op });
const shim = spawn('python3', [path.join(HERE, 'shim.py'), '54321'], { stdio: 'ignore' });
await sleep(800);
try {
  console.log('pairing');
  const code = JSON.parse(sql(`set role authenticated; set request.jwt.claim.sub='11111111-1111-1111-1111-111111111111'; select public.anytype_pair_start();`).split('\n').pop()).code;
  let r = await node('pair', code, '--project', 'http://127.0.0.1:54321', '--key', 'sb_publishable_test', '--name', 'Test PC');
  ok(/Paired with hiru/.test(r.stdout), `pair → ${r.stdout.split('\n')[0] || r.stderr}`);
  const cfgPath = `${tmp}/architect-anytype/config.json`;
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  ok(!JSON.stringify(cfg).includes('axc_'), 'config.json holds no token');
  Object.assign(cfg, { anytypeBase: 'http://127.0.0.1:31999', uiPort: 31919, pollMinutes: 60 });
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  r = await node('connect-anytype', '--key', 'test-key');
  ok(/Anytype connected/.test(r.stdout), 'connect-anytype with key');

  console.log('mapping editor (local UI)');
  const ui = spawn('node', [CONN, 'run', '--ui', '--no-open'], { env, stdio: ['ignore', 'pipe', 'ignore'] });
  let out = ''; ui.stdout.on('data', (d) => { out += d; });
  await sleep(1500);
  const html = await (await fetch('http://127.0.0.1:31919/')).text();
  const session = html.match(/name="architect-session" content="(\w+)"/)[1];
  const H = { 'X-Architect-UI': session, 'Content-Type': 'application/json' };
  const bad1 = await new Promise((res) => http.get({ host: '127.0.0.1', port: 31919, path: '/api/state', headers: { ...H, Host: 'evil.com:31919' } }, (r) => { r.resume(); res({ status: r.statusCode }); }));
  ok(bad1.status === 403, `wrong Host → ${bad1.status}`);
  const bad2 = await fetch('http://127.0.0.1:31919/api/state');
  ok(bad2.status === 403, `no session → ${bad2.status}`);
  const bad3 = await fetch('http://127.0.0.1:31919/api/state', { headers: { ...H, Origin: 'https://evil.com' } });
  ok(bad3.status === 403, `foreign Origin → ${bad3.status}`);
  const st = await (await fetch('http://127.0.0.1:31919/api/state', { headers: H })).json();
  ok(st.paired && st.anytypeOk && st.destinations.path.length === 2, `state: paired=${st.paired} anytype=${st.anytypeOk} dests=${st.destinations?.path?.length}`);
  const hd = await (await fetch('http://127.0.0.1:31919/api/headings?space=u57ueu&object=pageGM', { headers: H })).json();
  const pathH = hd.headings.find((x) => x.text === 'Path items');
  ok(pathH && pathH.items === 3, `headings: ${hd.headings.map((x) => `${x.text}(${x.items})`).join(', ')}`);
  const mapping = { name: 'GM → Morning', dest_kind: 'path', dest_id: 'aaaaaaaa-0000-0000-0000-000000000001', dest_name: 'Morning', source_kind: 'section', source_space_id: 'u57ueu', source_id: 'pageGM', source_name: 'GM 6:00-13:00', section_block_id: pathH.id, section_name: 'Path items', allow_fields: ['title'] };
  const pv = await (await fetch('http://127.0.0.1:31919/api/preview', { method: 'POST', headers: H, body: JSON.stringify({ mapping }) })).json();
  ok(pv.count === 3 && pv.items.map((i) => i.fields.title).join('|') === 'Walk 20 min|Read 10 pages|Stretch', `preview: ${pv.items?.map((i) => i.fields.title).join(' | ')} → ${pv.destination} (${pv.visibility})`);
  const sv = await (await fetch('http://127.0.0.1:31919/api/save', { method: 'POST', headers: H, body: JSON.stringify({ mapping }) })).json();
  ok(sv.run?.ok && sv.run.new === 3, `save + first run: ${JSON.stringify(sv.run)}`);
  const mid = sv.saved.id;
  ok(sql(`select count(*) from anytype_items where mapping_id='${mid}' and not archived`) === '3', 'DB has 3 live items');
  const keys1 = sql(`select string_agg(key, ',' order by sort) from anytype_items where mapping_id='${mid}'`);

  console.log('repeat + edit');
  r = await node('sync');
  ok(/0 new, 0 changed, 0 archived/.test(r.stdout), 'rerun: no duplicates, no changes');
  await ctl('edit_b1');
  r = await node('sync');
  ok(/0 new, 1 changed, 0 archived/.test(r.stdout), 'edited bullet: 1 changed');
  ok(sql(`select string_agg(key, ',' order by sort) from anytype_items where mapping_id='${mid}'`) === keys1, 'keys stable across edits (identity, not text)');
  // a checkmark recorded in Architect survives the edit/import
  sql(`set role authenticated; set request.jwt.claim.sub='11111111-1111-1111-1111-111111111111'; select public.anytype_set_check('${keys1.split(',')[0]}', '2026-11-24', true);`);
  await node('sync');
  ok(sql(`select done from anytype_checks where item_key='${keys1.split(',')[0]}'`) === 't', 'checkmark untouched by imports');

  console.log('errors keep the last good import');
  await ctl('drop_heading');
  r = await node('sync');
  ok(sql(`select status from anytype_runs where mapping_id='${mid}'`) === 'missing_section', 'missing heading → status missing_section');
  ok(sql(`select count(*) from anytype_items where mapping_id='${mid}' and not archived`) === '3', 'items retained after missing heading');
  await ctl('restore');
  await ctl('down');
  r = await node('sync');
  ok(sql(`select status from anytype_runs where mapping_id='${mid}'`) === 'anytype_closed', 'Anytype closed → status anytype_closed');
  ok(sql(`select count(*) from anytype_items where mapping_id='${mid}' and not archived`) === '3', 'items retained while Anytype is closed');
  await ctl('up');
  await ctl('drop_b2');
  r = await node('sync');
  ok(/archived/.test(r.stdout) && sql(`select count(*) from anytype_items where mapping_id='${mid}' and archived`) === '1', 'removed bullet archived after a complete read');
  await ctl('restore');

} catch (e) { fail++; console.log('  ✗ threw', e.message.split('\n')[0]); }
try {
  const tok = fs.readFileSync(`${tmp}/secrets/architect-token.secret`, 'utf8');
  const H2 = (m) => JSON.stringify(m).replace(/'/g, "''");
  const coll = { name: 'Tasks', dest_kind: 'path', dest_id: 'aaaaaaaa-0000-0000-0000-000000000002', source_kind: 'collection', source_space_id: 'u57ueu', source_id: 'c1', allow_fields: ['title', 'date'], date_property: 'due_date', enabled: true };
  const cid = JSON.parse(sql(`set role anon; select public.anytype_save_mapping('${tok}', '${H2(coll)}'::jsonb);`).split('\n').pop()).id;
  // the connector only runs mappings it saved itself — this one was saved with its token, so it is ours
  await ctl('partial');
  let r = await node('sync');
  ok(sql(`select status from anytype_runs where mapping_id='${cid}'`) === 'partial', 'partial page → status partial, nothing published');
  await ctl('full');
  // force: backoff cleared by sync command (force)
  r = await node('sync');
  ok(sql(`select count(*) from anytype_items where mapping_id='${cid}'`) === '4', `collection imported 4 (chat excluded): ${sql(`select count(*) from anytype_items where mapping_id='${cid}'`)}`);
  ok(sql(`select fields->>'date' from anytype_items where mapping_id='${cid}' limit 1`) === '2026-11-25', 'typed date mapped');

  console.log('revocation + logs');
  sql(`update anytype_connectors set revoked_at = now()`);
  r = await node('sync');
  ok(/disconnected/i.test(r.stdout + r.stderr), 'revoked connector stops');
  const logs = r.stdout + r.stderr;
  ok(!/axc_[\w-]{6}|test-key|Walk/.test(logs), 'logs carry no keys or content');
} catch (e) { fail++; console.log('  ✗', e.message); }
console.log(`\n${pass} passed, ${fail} failed`);
shim.kill(); mock.kill(); spawnSync('pkill', ['-f', 'architect-anytype.mjs run']);
process.exit(fail ? 1 : 0);
