/**
 * html2md.js — dependency-free HTML → Markdown converter (Agent A).
 *
 * Works on two kinds of input:
 *   1. a real DOM node (content script / `document`), or
 *   2. an HTML string — which is parsed by the tiny parser in this file, so the
 *      module is fully unit-testable under plain Node with no jsdom.
 *
 * The walker only uses `nodeType`, `childNodes`, `tagName`, `getAttribute()` and
 * `textContent`, all of which the fake nodes below implement identically to the
 * real DOM. No top-level `window`/`document` access.
 */

/* ------------------------------------------------------------------ */
/* Minimal HTML parser                                                 */
/* ------------------------------------------------------------------ */

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title']);

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', mdash: '—', ndash: '–', laquo: '«',
  raquo: '»', ldquo: '“', rdquo: '”', lsquo: '‘',
  rsquo: '’', middot: '·', bull: '•', copy: '©',
  reg: '®', trade: '™', deg: '°', times: '×',
  divide: '÷', minus: '−', larr: '←', rarr: '→',
  harr: '↔', infin: '∞', ne: '≠', le: '≤', ge: '≥',
};

/** @param {string} str */
export function decodeEntities(str) {
  if (!str || str.indexOf('&') === -1) return str;
  return str.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      if (Number.isFinite(code) && code >= 0 && code <= 0x10ffff) {
        try { return String.fromCodePoint(code); } catch { return whole; }
      }
      return whole;
    }
    const named = NAMED_ENTITIES[body];
    return named === undefined ? whole : named;
  });
}

class FakeText {
  constructor(value) {
    this.nodeType = 3;
    this.nodeValue = value;
    this.childNodes = [];
  }
  get textContent() { return this.nodeValue; }
}

class FakeElement {
  constructor(tagName) {
    this.nodeType = 1;
    this.tagName = tagName.toUpperCase();
    this.attrs = Object.create(null);
    this.childNodes = [];
  }
  getAttribute(name) {
    const v = this.attrs[String(name).toLowerCase()];
    return v === undefined ? null : v;
  }
  get className() { return this.getAttribute('class') || ''; }
  get textContent() {
    let out = '';
    for (const child of this.childNodes) out += child.textContent;
    return out;
  }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
}

const ATTR_RE = /([^\s"'>/=]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/g;

function parseAttributes(source) {
  const attrs = Object.create(null);
  let m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(source)) !== null) {
    const name = m[1].toLowerCase();
    if (name === '/') continue;
    const raw = m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[5] !== undefined ? m[5] : '';
    attrs[name] = decodeEntities(raw);
  }
  return attrs;
}

/**
 * Parse an HTML fragment into a DOM-like tree.
 * @param {string} html
 * @returns {FakeElement} a synthetic root element ("#fragment")
 */
export function parseHTML(html) {
  const root = new FakeElement('fragment');
  const stack = [root];
  const src = String(html == null ? '' : html);
  let i = 0;

  const top = () => stack[stack.length - 1];
  const pushText = (text) => {
    if (!text) return;
    top().childNodes.push(new FakeText(decodeEntities(text)));
  };

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) { pushText(src.slice(i)); break; }
    if (lt > i) pushText(src.slice(i, lt));

    // comment / doctype / CDATA
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end === -1 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith('<!', lt) || src.startsWith('<?', lt)) {
      const end = src.indexOf('>', lt);
      i = end === -1 ? src.length : end + 1;
      continue;
    }

    // closing tag
    if (src.startsWith('</', lt)) {
      const end = src.indexOf('>', lt);
      if (end === -1) { i = src.length; break; }
      const name = src.slice(lt + 2, end).trim().toLowerCase();
      for (let s = stack.length - 1; s > 0; s--) {
        if (stack[s].tagName.toLowerCase() === name) { stack.length = s; break; }
      }
      i = end + 1;
      continue;
    }

    // opening tag
    const end = src.indexOf('>', lt);
    if (end === -1) { pushText(src.slice(lt)); break; }
    let inner = src.slice(lt + 1, end);
    const selfClosing = inner.endsWith('/');
    if (selfClosing) inner = inner.slice(0, -1);
    const spaceIdx = inner.search(/[\s/]/);
    const tagName = (spaceIdx === -1 ? inner : inner.slice(0, spaceIdx)).toLowerCase();
    if (!/^[a-zA-Z][a-zA-Z0-9:-]*$/.test(tagName)) {
      pushText(src.slice(lt, end + 1));
      i = end + 1;
      continue;
    }
    const el = new FakeElement(tagName);
    if (spaceIdx !== -1) el.attrs = parseAttributes(inner.slice(spaceIdx));
    top().childNodes.push(el);
    i = end + 1;

    if (VOID_TAGS.has(tagName) || selfClosing) continue;

    if (RAW_TEXT_TAGS.has(tagName)) {
      const closeIdx = src.toLowerCase().indexOf(`</${tagName}`, i);
      const text = src.slice(i, closeIdx === -1 ? src.length : closeIdx);
      if (text) el.childNodes.push(new FakeText(text));
      if (closeIdx === -1) { i = src.length; } else {
        const gt = src.indexOf('>', closeIdx);
        i = gt === -1 ? src.length : gt + 1;
      }
      continue;
    }

    // Implicit close for <p> and <li> is handled loosely: a new <li>/<p> inside an
    // open one of the same name closes the previous.
    stack.push(el);
  }

  return root;
}

/* ------------------------------------------------------------------ */
/* Small DOM helpers that work on both real and fake nodes             */
/* ------------------------------------------------------------------ */

function tag(node) {
  if (!node || node.nodeType !== 1) return '';
  const t = node.tagName || node.nodeName || '';
  return String(t).toLowerCase();
}

function attr(node, name) {
  if (!node || node.nodeType !== 1) return null;
  if (typeof node.getAttribute === 'function') return node.getAttribute(name);
  return null;
}

function classOf(node) {
  const c = attr(node, 'class');
  return typeof c === 'string' ? c : '';
}

function hasClass(node, needle) {
  return classOf(node).split(/\s+/).includes(needle);
}

function childNodesOf(node) {
  if (!node) return [];
  const cn = node.childNodes;
  if (!cn) return [];
  return Array.prototype.slice.call(cn);
}

function elementChildren(node) {
  return childNodesOf(node).filter((n) => n.nodeType === 1);
}

function textOf(node) {
  if (!node) return '';
  const t = node.textContent;
  return typeof t === 'string' ? t : '';
}

/** Depth-first search for the first descendant satisfying `pred`. */
export function findDescendant(node, pred) {
  const kids = childNodesOf(node);
  for (const kid of kids) {
    if (kid.nodeType === 1 && pred(kid)) return kid;
    const deep = findDescendant(kid, pred);
    if (deep) return deep;
  }
  return null;
}

function findAllDescendants(node, pred, out = []) {
  for (const kid of childNodesOf(node)) {
    if (kid.nodeType === 1 && pred(kid)) out.push(kid);
    findAllDescendants(kid, pred, out);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Converter                                                           */
/* ------------------------------------------------------------------ */

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl', 'dd',
  'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre',
  'section', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
]);

/** Tags that never contribute anything to the transcript. */
const DROPPED_TAGS = new Set([
  'script', 'style', 'noscript', 'svg', 'button', 'template', 'head', 'meta',
  'link', 'input', 'select', 'textarea', 'canvas', 'iframe', 'video', 'audio',
]);

/** UI chrome ChatGPT injects into code headers. Must never reach the output. */
const UI_NOISE = new Set([
  'copy code', 'copy', 'copied!', 'copied', 'edit', 'edit code', 'copy to clipboard',
  'копировать код', 'копировать', 'скопировано', '复制代码', '复制', 'コピーする',
]);

function isUiNoise(text) {
  return UI_NOISE.has(String(text).trim().toLowerCase());
}

/**
 * `sr-only` / `visually-hidden` elements exist for screen readers, not for the
 * transcript. ChatGPT puts a LOCALISED speaker label in one ("ChatGPT said:",
 * "ChatGPT сказал:"), which would otherwise be pasted into every message.
 */
function isScreenReaderOnly(node) {
  const classes = classOf(node).split(/\s+/);
  return classes.includes('sr-only') || classes.includes('visually-hidden');
}

function collapse(text) {
  return String(text).replace(/[\t\f\r ]*\n[\t\f\r ]*/g, ' ').replace(/[ \t ]+/g, ' ');
}

function isKatex(node) {
  const cls = classOf(node);
  if (!cls) return false;
  return /(^|\s)katex(\s|-|$)/.test(cls) || /(^|\s)math(\s|$)/.test(cls);
}

function katexToMarkdown(node) {
  const annotation = findDescendant(
    node,
    (n) => tag(n) === 'annotation' && attr(n, 'encoding') === 'application/x-tex',
  );
  let tex = annotation ? textOf(annotation).trim() : '';
  if (!tex) {
    // Fall back to the rendered text; better than dropping the formula entirely.
    const html = findDescendant(node, (n) => hasClass(n, 'katex-html'));
    tex = (html ? textOf(html) : textOf(node)).trim();
    if (!tex) return '';
  }
  const display = hasClass(node, 'katex-display')
    || classOf(node).includes('katex-display')
    || attr(node, 'display') === 'block';
  return display ? `\n$$\n${tex}\n$$\n` : `$${tex}$`;
}

/** Language for a `<pre>` block: `language-xxx` class, or ChatGPT's header div. */
export function codeLanguageOf(pre, codeEl) {
  const probe = [codeEl, pre].filter(Boolean);
  for (const el of probe) {
    const cls = classOf(el);
    const m = cls.match(/(?:language|lang|highlight)-([A-Za-z0-9+#._-]+)/);
    if (m) return m[1].toLowerCase();
  }
  if (codeEl) {
    const dataLang = attr(codeEl, 'data-language') || attr(pre, 'data-language');
    if (dataLang) return String(dataLang).toLowerCase();
  }
  // ChatGPT renders `<div class="flex items-center ...">python</div>` above the code.
  const headerCandidates = findAllDescendants(pre, (n) => {
    if (n === codeEl) return false;
    if (DROPPED_TAGS.has(tag(n))) return false;
    if (codeEl && findDescendant(n, (x) => x === codeEl)) return false;
    return true;
  });
  for (const cand of headerCandidates) {
    const t = textOf(cand).trim();
    if (!t || isUiNoise(t)) continue;
    if (/^[A-Za-z0-9+#._-]{1,24}$/.test(t)) return t.toLowerCase();
  }
  return '';
}

function renderPre(pre) {
  const codeEl = tag(pre) === 'code' ? pre : findDescendant(pre, (n) => tag(n) === 'code');
  const lang = codeLanguageOf(pre, codeEl);
  let code;
  if (codeEl) {
    code = textOf(codeEl);
  } else {
    // No <code>: take the text but drop injected UI chrome.
    code = childNodesOf(pre)
      .map((n) => (n.nodeType === 1 && DROPPED_TAGS.has(tag(n)) ? '' : textOf(n)))
      .join('');
  }
  code = String(code).replace(/^\n+/, '').replace(/\s+$/, '');
  // Guard against a stray "Copy code" leaking in as the first line.
  const lines = code.split('\n');
  while (lines.length && isUiNoise(lines[0])) lines.shift();
  code = lines.join('\n');
  let fence = '```';
  while (code.includes(fence)) fence += '`';
  return `${fence}${lang}\n${code}\n${fence}`;
}

function renderTable(table) {
  const rows = findAllDescendants(table, (n) => tag(n) === 'tr');
  if (!rows.length) return '';
  const matrix = rows.map((tr) => elementChildren(tr)
    .filter((c) => tag(c) === 'td' || tag(c) === 'th')
    .map((cell) => inline(cell).replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim()));
  const width = matrix.reduce((max, r) => Math.max(max, r.length), 0);
  if (!width) return '';
  const pad = (r) => { const c = r.slice(); while (c.length < width) c.push(''); return c; };
  const headerIsReal = elementChildren(rows[0]).some((c) => tag(c) === 'th');
  const header = headerIsReal ? pad(matrix[0]) : new Array(width).fill('');
  const bodyRows = headerIsReal ? matrix.slice(1) : matrix;
  const out = [`| ${header.join(' | ')} |`, `| ${new Array(width).fill('---').join(' | ')} |`];
  for (const row of bodyRows) out.push(`| ${pad(row).join(' | ')} |`);
  return out.join('\n');
}

function renderList(node, ordered) {
  const items = elementChildren(node).filter((n) => tag(n) === 'li');
  const startAttr = parseInt(attr(node, 'start') || '1', 10);
  const start = Number.isFinite(startAttr) ? startAttr : 1;
  const out = [];
  items.forEach((li, idx) => {
    const marker = ordered ? `${start + idx}. ` : '- ';
    const indent = ' '.repeat(marker.length);
    // A nested list hugs its parent item; other blocks keep a blank line.
    let body = '';
    blocks(li).forEach((block, i) => {
      if (i === 0) { body = block; return; }
      body += (/^(?:[-*] |\d+\. )/.test(block) ? '\n' : '\n\n') + block;
    });
    body = body.trim();
    const lines = body.split('\n');
    const first = lines.shift() || '';
    const rest = lines.map((l) => (l.trim() ? indent + l : ''));
    out.push([marker + first, ...rest].join('\n'));
  });
  return out.join('\n');
}

/** Inline rendering: returns a single-line-ish markdown string. */
function inline(node) {
  if (!node) return '';
  if (node.nodeType === 3) return collapse(node.nodeValue == null ? node.textContent : node.nodeValue);
  if (node.nodeType !== 1) return '';
  const t = tag(node);
  if (DROPPED_TAGS.has(t)) return '';
  if (attr(node, 'aria-hidden') === 'true' && !isKatex(node)) return '';
  if (isScreenReaderOnly(node)) return '';
  if (isKatex(node)) return katexToMarkdown(node);

  const kids = () => childNodesOf(node).map(inline).join('');

  switch (t) {
    case 'br': return '\n';
    case 'img': {
      const src = attr(node, 'src') || '';
      const alt = (attr(node, 'alt') || '').replace(/[\[\]]/g, '');
      return `![${alt}](${src})`;
    }
    case 'a': {
      const href = attr(node, 'href') || '';
      const label = kids().trim();
      if (!label) return href ? `<${href}>` : '';
      if (!href || href.startsWith('javascript:')) return label;
      return `[${label}](${href})`;
    }
    case 'strong': case 'b': {
      const inner = kids().trim();
      return inner ? `**${inner}**` : '';
    }
    case 'em': case 'i': {
      const inner = kids().trim();
      return inner ? `*${inner}*` : '';
    }
    case 'del': case 's': case 'strike': {
      const inner = kids().trim();
      return inner ? `~~${inner}~~` : '';
    }
    case 'code': {
      const inner = textOf(node);
      if (!inner.trim()) return '';
      let ticks = '`';
      while (inner.includes(ticks)) ticks += '`';
      const padSpace = inner.startsWith('`') || inner.endsWith('`') ? ' ' : '';
      return `${ticks}${padSpace}${inner}${padSpace}${ticks}`;
    }
    case 'sup': return `^${kids()}`;
    case 'sub': return `~${kids()}`;
    default:
      return kids();
  }
}

/** Block rendering: returns an array of block strings. */
function blocks(node) {
  const out = [];
  let buffer = '';
  const flush = () => {
    const text = buffer.replace(/[ \t]+\n/g, '\n').trim();
    if (text) out.push(text);
    buffer = '';
  };

  for (const child of childNodesOf(node)) {
    if (child.nodeType === 3) {
      buffer += collapse(child.nodeValue == null ? child.textContent : child.nodeValue);
      continue;
    }
    if (child.nodeType !== 1) continue;
    const t = tag(child);
    if (DROPPED_TAGS.has(t)) continue;
    if (attr(child, 'aria-hidden') === 'true' && !isKatex(child)) continue;
    if (isScreenReaderOnly(child)) continue;
    if (isKatex(child)) {
      const math = katexToMarkdown(child);
      if (hasClass(child, 'katex-display') || classOf(child).includes('katex-display')) {
        flush();
        if (math.trim()) out.push(math.trim());
      } else {
        buffer += math;
      }
      continue;
    }

    if (!BLOCK_TAGS.has(t)) { buffer += inline(child); continue; }

    flush();
    switch (t) {
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
        const text = inline(child).trim();
        if (text) out.push(`${'#'.repeat(Number(t[1]))} ${text}`);
        break;
      }
      case 'hr': out.push('---'); break;
      case 'pre': out.push(renderPre(child)); break;
      case 'ul': out.push(renderList(child, false)); break;
      case 'ol': out.push(renderList(child, true)); break;
      case 'table': { const tbl = renderTable(child); if (tbl) out.push(tbl); break; }
      case 'blockquote': {
        const body = blocks(child).join('\n\n').trim();
        if (body) out.push(body.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n'));
        break;
      }
      case 'dl': {
        const body = blocks(child).join('\n\n').trim();
        if (body) out.push(body);
        break;
      }
      case 'p': {
        const text = inline(child).replace(/[ \t]+\n/g, '\n').trim();
        if (text) out.push(text);
        break;
      }
      default: {
        // div / section / li-as-child / table remnants: recurse and flatten.
        for (const b of blocks(child)) if (b.trim()) out.push(b);
      }
    }
  }
  flush();
  return out.filter((b) => b !== '');
}

/**
 * Convert HTML (string) or a DOM-like node into Markdown.
 * @param {string|object} input
 * @returns {string}
 */
export function htmlToMarkdown(input) {
  if (input == null) return '';
  const root = typeof input === 'string' ? parseHTML(input) : input;
  const result = blocks(root).join('\n\n');
  return result.replace(/\n{3,}/g, '\n\n').trim();
}

export default htmlToMarkdown;
