// Mock Anytype v2 loopback API with the shapes from developers.anytype.io/skill.md (flat pre-order blocks + indent).
import http from 'node:http';
export const state = {
  down: false, key: 'test-key', partial: false,
  page: { id: 'pageGM', name: 'GM 6:00-13:00', type: 'page', blocks: [
    { id: 'pageGM', type: 'title', text: 'GM 6:00-13:00' },
    { id: 'h-intro', type: 'h2', text: 'Intro' },
    { id: 'p1', type: 'paragraph', text: 'Not imported' },
    { id: 'b0', type: 'bullet', text: 'Not under the heading' },
    { id: 'h-path', type: 'h2', text: 'Path items' },
    { id: 'b1', type: 'bullet', text: '**Walk** 20 min' },
    { id: 'b2', type: 'checkbox', text: '[Read](https://x.y) 10 pages', checked: false },
    { id: 'p2', type: 'paragraph', text: 'paragraphs skipped' },
    { id: 'h3', type: 'h3', text: 'Sub (still inside)' },
    { id: 'b3', type: 'bullet', text: 'Stretch', indent: 1 },
    { id: 'h-next', type: 'h2', text: 'Notes' },
    { id: 'b4', type: 'bullet', text: 'After the section' },
  ] },
  coll: Array.from({ length: 5 }, (_, i) => ({ id: `t${i}`, name: `Task ${i}`, type: i === 4 ? 'chat' : 'task' })),
};
export function start(port) {
  return http.createServer((req, res) => {
    const send = (c, b) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(b)); };
    if (req.url === '/__ctl') {
      let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { CTL[b]?.(); send(200, { ok: true }); });
      return;
    }
    if (state.down) { req.socket.destroy(); return; }
    if (req.headers.authorization !== `Bearer ${state.key}`) return send(401, { error: 'unauthorized' });
    const u = new URL(req.url, 'http://x');
    const off = Number(u.searchParams.get('offset') || 0), lim = Number(u.searchParams.get('limit') || 25);
    const list = (all) => { const data = all.slice(off, off + lim); return { data, total: all.length, offset: off, limit: lim, has_more: off + data.length < all.length }; };
    if (u.pathname === '/v2/spaces') return send(200, list([{ id: 'u57ueu', name: 'Feverish Feedback' }]));
    if (u.pathname === '/v2/spaces/u57ueu/objects/pageGM') return send(200, { ...state.page, etag: 'e1' });
    if (u.pathname.startsWith('/v2/spaces/u57ueu/objects/t')) { const o = state.coll.find((x) => x.id === u.pathname.split('/').pop()); return o ? send(200, { ...o, properties: { due_date: '2026-11-25T00:00:00Z' } }) : send(404, {}); }
    if (u.pathname === '/v2/spaces/u57ueu/collections/c1/objects') {
      const r = list(state.coll);
      if (state.partial) { r.data = r.data.slice(0, 3); r.has_more = false; }
      return send(200, r);
    }
    if (u.pathname === '/v2/spaces/u57ueu/objects') return send(200, list([{ id: 'pageGM', name: 'GM 6:00-13:00', type: 'page' }, { id: 'c1', name: 'Set-points', type: 'collection' }]));
    send(404, { error: 'nf' });
  }).listen(port, '127.0.0.1');
}

const ORIG = JSON.parse(JSON.stringify(state.page.blocks));
const CTL = {
  edit_b1: () => { state.page.blocks.find((b) => b.id === 'b1').text = 'Walk 30 min'; },
  drop_heading: () => { state.page.blocks = state.page.blocks.filter((b) => b.id !== 'h-path'); },
  restore: () => { const b1 = state.page.blocks.find((b) => b.id === 'b1')?.text; state.page.blocks = JSON.parse(JSON.stringify(ORIG)); if (b1) state.page.blocks.find((b) => b.id === 'b1').text = 'Walk 30 min'; },
  drop_b2: () => { state.page.blocks = state.page.blocks.filter((b) => b.id !== 'b2'); },
  down: () => { state.down = true; }, up: () => { state.down = false; },
  partial: () => { state.partial = true; }, full: () => { state.partial = false; },
};
if (process.argv[2]) start(Number(process.argv[2]));
