// Starter layouts. Each build(origin) returns elements positioned around origin (world coords).
import { uid } from '../core/util.js';

const text = (x, y, w, t, extra = {}) => ({ id: uid(), type: 'text', x, y, w, h: 34, text: t, color: 'auto', fontSize: 22, align: 'left', ...extra });
const shape = (x, y, w, hh, extra = {}) => ({ id: uid(), type: 'shape', x, y, w, h: hh, kind: 'rect', fill: 'none', stroke: 'auto', strokeWidth: 2, text: '', fontSize: 16, align: 'center', ...extra });
const sticky = (x, y, t = '', fill = '#FFFFFF', size = 160) => ({ id: uid(), type: 'sticky', x, y, w: size, h: size, fill, text: t });
const frame = (x, y, w, hh, title) => ({ id: uid(), type: 'frame', x, y, w, h: hh, title, fill: 'none' });
const line = (a, b, extra = {}) => ({ id: uid(), type: 'line', a, b, stroke: 'auto', strokeWidth: 2, route: 'straight', startCap: 'none', endCap: 'arrow', dash: 'solid', ...extra });

export const TEMPLATES = [
  {
    id: 'week', name: 'Week plan', hint: 'Seven days side by side',
    build(o) {
      const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
      const colW = 240, gap = 16, W = days.length * (colW + gap) + gap, H = 640;
      const x0 = o.x - W / 2, y0 = o.y - H / 2;
      const els = [frame(x0, y0, W, H, 'Week')];
      days.forEach((d, i) => {
        const x = x0 + gap + i * (colW + gap);
        els.push(text(x + 4, y0 + 24, colW - 8, d, { font: 'dot', fontSize: 30, bold: true }));
        els.push(shape(x, y0 + 78, colW, H - 78 - gap, { kind: 'round', stroke: '#3D3D3D', strokeWidth: 1.5, dash: 'dashed' }));
      });
      return els;
    },
  },
  {
    id: 'matrix', name: 'Priority matrix', hint: 'Urgent × important',
    build(o) {
      const S = 380, gap = 12, W = S * 2 + gap, x0 = o.x - W / 2, y0 = o.y - W / 2;
      const q = [['Do now', '#FFFFFF'], ['Schedule', '#D9D9D9'], ['Delegate', '#8C8C8C'], ['Drop', '#3D3D3D']];
      const els = [frame(x0 - 40, y0 - 90, W + 80, W + 130, 'Priority matrix')];
      els.push(text(x0, y0 - 52, S, 'Urgent', { font: 'mono', fontSize: 14, align: 'center' }));
      els.push(text(x0 + S + gap, y0 - 52, S, 'Not urgent', { font: 'mono', fontSize: 14, align: 'center' }));
      q.forEach(([label, fill], i) => {
        const x = x0 + (i % 2) * (S + gap), y = y0 + Math.floor(i / 2) * (S + gap);
        els.push(shape(x, y, S, S, { kind: 'round', fill, stroke: 'none', text: label, fontSize: 28, font: 'dot', bold: true }));
      });
      return els;
    },
  },
  {
    id: 'mindmap', name: 'Mind map', hint: 'One idea, four branches',
    build(o) {
      const core = shape(o.x - 120, o.y - 60, 240, 120, { kind: 'ellipse', fill: '#FFFFFF', stroke: 'none', text: 'Central idea', fontSize: 22, bold: true });
      const spots = [[-420, -220], [300, -220], [-420, 160], [300, 160]];
      const els = [core];
      spots.forEach(([dx, dy], i) => {
        const n = shape(o.x + dx, o.y + dy, 200, 72, { kind: 'pill', text: `Branch ${i + 1}`, fontSize: 18 });
        els.push(n, line({ id: core.id, x: o.x, y: o.y }, { id: n.id, x: n.x, y: n.y }, { route: 'curve', endCap: 'none' }));
      });
      return els;
    },
  },
  {
    id: 'kanban', name: 'Mini kanban', hint: 'To do · Doing · Done',
    build(o) {
      const cols = ['To do', 'Doing', 'Done'];
      const colW = 300, gap = 20, W = cols.length * colW + (cols.length + 1) * gap, H = 620;
      const x0 = o.x - W / 2, y0 = o.y - H / 2;
      const els = [frame(x0, y0, W, H, 'Kanban')];
      cols.forEach((c, i) => {
        const x = x0 + gap + i * (colW + gap);
        els.push(shape(x, y0 + gap, colW, H - gap * 2, { kind: 'round', fill: '#3D3D3D', stroke: 'none', strokeWidth: 1 }));
        els.push(text(x + 20, y0 + gap + 18, colW - 40, c, { font: 'mono', fontSize: 16, color: '#FFFFFF' }));
        els.push(sticky(x + (colW - 200) / 2, y0 + gap + 72, '', '#FFFFFF', 200));
      });
      return els;
    },
  },
  {
    id: 'timeline', name: 'Timeline', hint: 'Five milestones in a row',
    build(o) {
      const n = 5, step = 280, W = (n - 1) * step, x0 = o.x - W / 2;
      const els = [line({ x: x0 - 80, y: o.y }, { x: x0 + W + 80, y: o.y }, { endCap: 'arrow' })];
      for (let i = 0; i < n; i++) {
        const x = x0 + i * step;
        els.push(shape(x - 14, o.y - 14, 28, 28, { kind: 'ellipse', fill: i === 0 ? '#D71921' : 'auto', stroke: 'none' }));
        els.push(text(x - 90, o.y + 34, 180, `Milestone ${i + 1}`, { align: 'center', fontSize: 18 }));
        els.push(text(x - 90, o.y - 70, 180, `Week ${i + 1}`, { align: 'center', fontSize: 14, font: 'mono', color: '#8C8C8C' }));
      }
      return els;
    },
  },
];
