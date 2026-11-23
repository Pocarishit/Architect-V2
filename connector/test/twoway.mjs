// Two-way (Nov 24) unit gates: Architect-side changes applied to a page section (markdown) and to a
// collection (object properties), against a fake Anytype. Test-only; never shipped.
import { mdSection, applyOp, doneProp } from '../architect-anytype.mjs';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

function fakePage(md, { ignore = false } = {}) {
  const st = { md, patches: 0, calls: [] };
  return {
    st,
    object: async () => ({ id: 'p', markdown: st.md }),
    patch: async (sid, oid, body) => { st.calls.push(['patch', oid, body]); st.patches++; if ('markdown' in body && !ignore) st.md = body.markdown; return {}; },
    create: async (sid, body) => { st.calls.push(['create', body]); return { id: 'new1' }; },
    archive: async (sid, oid) => { st.calls.push(['archive', oid]); },
    addToList: async (sid, lid, ids) => { st.calls.push(['list', lid, ids]); },
  };
}
const MD = ['# GM', 'intro', '## Path items', '- [ ] Walk 20 min', '- [x] Read 10 pages', '- Stretch', '## Notes', '- not me'].join('\n');
const map = { source_kind: 'section', source_space_id: 's', source_id: 'p', section_name: 'Path items' };
const item = (title, sort) => ({ key: 'k', source_object_id: 'p', fields: { title }, sort });

console.log('markdown sections');
const sec = mdSection(MD, 'Path items');
ok(sec.items.map((x) => `${x.text}:${x.box ? (x.checked ? 'x' : 'o') : '-'}`).join('|') === 'Walk 20 min:o|Read 10 pages:x|Stretch:-', 'reads the items under the heading only');

console.log('section ops');
let a = fakePage(MD);
await applyOp(a, { op: 'check', payload: { done: true }, mapping: map, item: item('Walk 20 min', 1) });
ok(a.st.md.includes('- [x] Walk 20 min'), 'check → [x]');
await applyOp(a, { op: 'check', payload: { done: false }, mapping: map, item: item('Read 10 pages', 2) });
ok(a.st.md.includes('- [ ] Read 10 pages'), 'uncheck → [ ]');
await applyOp(a, { op: 'check', payload: { done: true }, mapping: map, item: item('Stretch', 3) });
ok(a.st.md.includes('- [x] Stretch'), 'checking a plain bullet makes it a checked box');
await applyOp(a, { op: 'rename', payload: { title: 'Walk 30 min' }, mapping: map, item: item('Walk 20 min', 1) });
ok(a.st.md.includes('- [x] Walk 30 min') && !a.st.md.includes('Walk 20 min'), 'rename keeps the checkbox');
await applyOp(a, { op: 'add', payload: { title: 'Cold shower' }, mapping: map, item: null });
const s2 = mdSection(a.st.md, 'Path items');
ok(s2.items.at(-1).text === 'Cold shower' && a.st.md.indexOf('Cold shower') < a.st.md.indexOf('## Notes'), 'add lands at the end of the section');
await applyOp(a, { op: 'delete', payload: {}, mapping: map, item: item('Read 10 pages', 2) });
ok(!a.st.md.includes('Read 10 pages') && a.st.md.includes('- not me'), 'delete removes only that line');
let b = fakePage(MD, { ignore: true });
let err = null; try { await applyOp(b, { op: 'check', payload: { done: true }, mapping: map, item: item('Walk 20 min', 1) }); } catch (e) { err = e.message; }
ok(/didn’t apply/.test(err || ''), 'an ignored body edit is reported, not assumed');
err = null; try { await applyOp(fakePage(MD), { op: 'check', payload: { done: true }, mapping: { ...map, section_name: 'Gone' }, item: item('Walk 20 min', 1) }); } catch (e) { err = e.message; }
ok(/isn’t in that page/.test(err || ''), 'missing heading → clear error');

console.log('collection ops');
const cm = { source_kind: 'collection', source_space_id: 's', source_id: 'coll' };
const c = fakePage('');
await applyOp(c, { op: 'check', payload: { done: true }, mapping: cm, item: { source_object_id: 't1', fields: { title: 'A' } } });
ok(JSON.stringify(c.st.calls.at(-1)) === JSON.stringify(['patch', 't1', { properties: [{ key: 'done', checkbox: true }] }]), 'check → done property');
await applyOp(c, { op: 'rename', payload: { title: 'B' }, mapping: cm, item: { source_object_id: 't1', fields: { title: 'A' } } });
ok(c.st.calls.at(-1)[2].name === 'B', 'rename → name');
const made = await applyOp(c, { op: 'add', payload: { title: 'New' }, mapping: cm, item: null });
ok(made?.source_object_id === 'new1' && c.st.calls.at(-1)[0] === 'list' && c.st.calls.at(-1)[1] === 'coll', 'add → create + add to the collection');
await applyOp(c, { op: 'delete', payload: {}, mapping: cm, item: { source_object_id: 't1', fields: {} } });
ok(c.st.calls.at(-1)[0] === 'archive', 'delete → archive (Anytype bin)');
ok(doneProp({ properties: [{ key: 'done', checkbox: true }] }) === true && doneProp({ properties: { done: { checkbox: false } } }) === false && doneProp({ properties: [] }) === null, 'done property read from v2 shapes');

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
