// Rich text for board items: a small whitelist so pasted or imported HTML can't run anything.
const KEEP = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'DEL', 'A', 'BR', 'DIV', 'P', 'UL', 'OL', 'LI', 'SPAN', 'MARK']);
const DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH', 'TEMPLATE', 'IMG', 'VIDEO', 'AUDIO', 'LINK', 'META', 'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT']);
const STYLES = ['color', 'background-color', 'font-weight', 'font-style', 'text-decoration-line', 'text-decoration'];
const RICH = /<(b|strong|i|em|u|s|strike|del|a|ul|ol|li|span|mark)\b/i;

export function sanitize(html) {
  const doc = new DOMParser().parseFromString(`<div>${html || ''}</div>`, 'text/html');
  const root = doc.body.firstElementChild;
  if (!root) return '';
  const walk = (node) => {
    for (const ch of [...node.childNodes]) {
      if (ch.nodeType === 3) continue;
      if (ch.nodeType !== 1) { ch.remove(); continue; }
      let el = ch;
      if (DROP.has(el.tagName)) { el.remove(); continue; }
      if (el.tagName === 'FONT') {
        const span = doc.createElement('span');
        if (el.getAttribute('color')) span.style.color = el.getAttribute('color');
        span.append(...el.childNodes);
        el.replaceWith(span);
        el = span;
      }
      if (!KEEP.has(el.tagName)) { walk(el); el.replaceWith(...el.childNodes); continue; }
      const style = STYLES.map((p) => [p, el.style?.getPropertyValue(p) || '']).filter(([, v]) => v && !/url\(|expression|javascript/i.test(v));
      for (const a of [...el.attributes]) {
        if (el.tagName === 'A' && a.name === 'href' && /^https?:\/\//i.test(a.value.trim())) continue;
        el.removeAttribute(a.name);
      }
      style.forEach(([p, v]) => el.style.setProperty(p, v));
      if (el.tagName === 'A') { el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener noreferrer'); }
      walk(el);
    }
  };
  walk(root);
  return root.innerHTML;
}

// Formatting worth keeping as HTML (otherwise plain text is enough).
export const hasRichMarkup = (html) => RICH.test(html || '');
