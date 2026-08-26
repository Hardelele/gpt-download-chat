/**
 * A ~120-line stand-in for the parts of the DOM that dom-scrape.js touches:
 * querySelector / querySelectorAll with simple selectors, parentElement,
 * contains(), textContent. Built on the parser inside html2md.js so the tests
 * exercise the real converter, not a mock of it.
 *
 * Supported selectors: comma-separated groups of `tag`, `.class`, `#id`,
 * `[attr]`, `[attr="v"]`, `[attr^="v"]`, `[attr*="v"]`, optionally combined.
 * Descendant combinators are approximated by matching the rightmost compound.
 */

import { parseHTML } from '../../extension/src/lib/html2md.js';

function matchesCompound(el, compound) {
  let rest = compound.trim();
  if (!rest || rest === '*') return true;
  const tagMatch = rest.match(/^[a-zA-Z][a-zA-Z0-9-]*/);
  if (tagMatch) {
    if (el.tagName.toLowerCase() !== tagMatch[0].toLowerCase()) return false;
    rest = rest.slice(tagMatch[0].length);
  }
  const partRe = /(\[[^\]]*\]|\.[A-Za-z0-9_-]+|#[A-Za-z0-9_-]+)/g;
  let m;
  while ((m = partRe.exec(rest)) !== null) {
    const part = m[1];
    if (part[0] === '.') {
      const classes = (el.getAttribute('class') || '').split(/\s+/);
      if (!classes.includes(part.slice(1))) return false;
    } else if (part[0] === '#') {
      if (el.getAttribute('id') !== part.slice(1)) return false;
    } else {
      const body = part.slice(1, -1);
      const am = body.match(/^([^\^*$~|=]+)(?:([\^*$~|]?)=\s*"?([^"]*)"?)?$/);
      if (!am) return false;
      const value = el.getAttribute(am[1].trim());
      if (value == null) return false;
      if (am[3] === undefined) continue;
      const want = am[3];
      const op = am[2] || '';
      if (op === '^' && !value.startsWith(want)) return false;
      if (op === '*' && !value.includes(want)) return false;
      if (op === '$' && !value.endsWith(want)) return false;
      if (op === '' && value !== want) return false;
    }
  }
  return true;
}

function matches(el, selector) {
  return String(selector).split(',').some((group) => {
    const compounds = group.trim().split(/\s+/).filter((c) => c && c !== '>');
    if (!compounds.length) return false;
    return matchesCompound(el, compounds[compounds.length - 1]);
  });
}

function descendants(el, out = []) {
  for (const child of el.childNodes) {
    if (child.nodeType === 1) { out.push(child); descendants(child, out); }
  }
  return out;
}

function enhance(el, parent) {
  el.parentElement = parent;
  el.matches = (selector) => matches(el, selector);
  el.querySelectorAll = (selector) => descendants(el).filter((d) => matches(d, selector));
  el.querySelector = (selector) => el.querySelectorAll(selector)[0] || null;
  el.contains = (other) => other === el || descendants(el).includes(other);
  if (el.scrollHeight === undefined) el.scrollHeight = 0;
  if (el.clientHeight === undefined) el.clientHeight = 0;
  if (el.scrollTop === undefined) el.scrollTop = 0;
  for (const child of el.childNodes) if (child.nodeType === 1) enhance(child, el);
}

/**
 * @param {string} html
 * @param {{title?:string, href?:string, scrollable?:boolean}} [opts]
 */
export function makeDocument(html, opts = {}) {
  const root = parseHTML(html);
  root.tagName = 'HTML';
  enhance(root, null);

  const doc = {
    title: opts.title || '',
    documentElement: root,
    defaultView: { location: { href: opts.href || 'https://chatgpt.com/c/test' } },
    scrollingElement: root,
    querySelector: (s) => root.querySelector(s),
    querySelectorAll: (s) => root.querySelectorAll(s),
  };

  if (opts.scrollable) {
    // Make the outer element look scrollable so loadFullTranscript engages.
    root.scrollHeight = 4000;
    root.clientHeight = 800;
    root.scrollTop = 3000;
  }
  return doc;
}

export { matches };
