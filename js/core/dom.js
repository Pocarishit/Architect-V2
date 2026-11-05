// Tiny DOM helpers. h() builds HTML elements, s() builds SVG elements.
const SVG_NS = 'http://www.w3.org/2000/svg';
const PROPS = new Set(['value', 'checked', 'disabled', 'selected', 'tabIndex', 'spellcheck', 'hidden', 'draggable', 'multiple', 'readOnly']);

export function h(tag, props, ...kids) {
  return build(document.createElement(tag), props, kids, false);
}

export function s(tag, props, ...kids) {
  return build(document.createElementNS(SVG_NS, tag), props, kids, true);
}

function build(el, props, kids, svg) {
  if (props) {
    for (const k in props) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === 'class') {
        const c = Array.isArray(v) ? v.filter(Boolean).join(' ') : v;
        if (c) el.setAttribute('class', c);
      } else if (k === 'style') {
        if (typeof v === 'string') el.style.cssText = v;
        else for (const sk in v) {
          if (v[sk] == null) continue;
          if (sk.startsWith('--')) el.style.setProperty(sk, v[sk]);
          else el.style[sk] = v[sk];
        }
      } else if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (k === 'text') {
        el.textContent = v;
      } else if (k === 'html') {
        el.innerHTML = v;
      } else if (k === 'ref') {
        v(el);
      } else if (!svg && PROPS.has(k)) {
        el[k] = v;
      } else {
        el.setAttribute(k, v === true ? '' : v);
      }
    }
  }
  append(el, kids);
  return el;
}

function append(el, kids) {
  for (const k of kids) {
    if (k == null || k === false || k === true) continue;
    if (Array.isArray(k)) append(el, k);
    else if (typeof k === 'object') el.appendChild(k);
    else el.appendChild(document.createTextNode(String(k)));
  }
}

// Event delegation: fn(event, matchedElement)
export function delegate(root, type, selector, fn, opts) {
  const handler = (e) => {
    const t = e.target instanceof Element ? e.target.closest(selector) : null;
    if (t && root.contains(t)) fn(e, t);
  };
  root.addEventListener(type, handler, opts);
  return () => root.removeEventListener(type, handler, opts);
}

export function isTypingTarget(t) {
  if (!(t instanceof Element)) return false;
  return !!t.closest('input, textarea, select, [contenteditable="true"]');
}
