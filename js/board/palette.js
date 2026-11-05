// Content colours for board elements. 'auto' follows the theme (white on dark, black on light).
export const SWATCHES = [
  { id: 'auto', name: 'Ink' },
  { id: '#FFFFFF', name: 'White' },
  { id: '#D9D9D9', name: 'Silver' },
  { id: '#8C8C8C', name: 'Grey' },
  { id: '#3D3D3D', name: 'Graphite' },
  { id: '#000000', name: 'Black' },
  { id: '#D71921', name: 'Signal red' },
  { id: '#F0B429', name: 'Amber' },
  { id: '#3FA66B', name: 'Green' },
  { id: '#3B82D8', name: 'Blue' },
];

export const FILLS = [{ id: 'none', name: 'No fill' }, ...SWATCHES];
export const STICKY_FILLS = SWATCHES.filter((s) => s.id !== 'auto');

export function css(c) {
  if (!c || c === 'none') return 'transparent';
  if (c === 'auto') return 'var(--ink)';
  if (c === 'paper') return 'var(--paper)';
  return c;
}

function luminance(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return 0.5;
  const n = parseInt(m[1], 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

// Readable text colour on top of a fill.
export function onColor(fill) {
  if (!fill || fill === 'none') return 'var(--ink)';
  if (fill === 'auto') return 'var(--paper)';
  return luminance(fill) > 0.36 ? '#0a0a0a' : '#ffffff';
}

export function swatchStyle(id) {
  if (id === 'none') return { background: 'transparent' };
  return { background: css(id) };
}
