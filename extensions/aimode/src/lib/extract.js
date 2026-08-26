/**
 * extract.js — Chat2MD extractor for **Google's AI Mode in Search** (Agent F).
 *
 * Target surface (verified 2026-08-26):
 *   - `https://www.google.com/search?q=...&udm=50` (AI Mode tab; `aep=11` also seen)
 *   - `https://www.google.com/ai` (Google's own documented entry point for AI Mode)
 *   - as a cheap bonus, the **AI Overview** block on an ordinary results page.
 *
 * This is a **DOM-only** target. There is no same-origin JSON endpoint we may call
 * (the answer streams in over `/async/folwr`, which is not replayable), and Google's
 * markup is hashed and rotates. Everything below is therefore built as a *prioritised
 * list of strategies* that fall through, plus an explicit, loud failure mode: if no
 * turn is recognised we return `messages: []` **and** a warning that says so. A
 * silently truncated export is worse than a clear error.
 *
 * Anchors used, strongest first (documented / observed, not hashed classes):
 *   - `[data-session-thread-id]`     AI Mode thread node; the answer lives in its parent
 *   - `[data-subtree="aimc"]`        "AI Mode container"
 *   - `button[data-icl-uuid][data-amic="true"]`  inline citation pill
 *   - `<!--Sv6Kpe[["<uuid>",...]]-->`            hidden comment block holding pill URLs
 *   - `a.ZbQNgf` / `[data-container-id="rhs-col"] [role="dialog"] a`  source panel links
 *   - `#m-x-content [data-container-id="main-col"]` / `[data-rl]`     AI Overview block
 *   - `[jsname="HtgYJd"]` / `ul[jsname="Z3saHd"]`                     AI Overview pills
 * Everything else is structural: headings/`role="heading"` as question nodes, the
 * common-ancestor of those headings as the thread column, and contiguous ranges of
 * that column's children as turns.
 *
 * Produces the `Conversation` typedef from CONTRACT.md, unchanged. Never throws for a
 * recoverable problem; degrades and pushes a line into `warnings[]`.
 *
 * The HTML→Markdown conversion is Agent A's `html2md.js` — imported, never re-implemented.
 * (Relative path is temporary; the orchestrator hoists it into `shared/`. See HANDOFF.)
 */

import { htmlToMarkdown, parseHTML } from '../../../../extension/src/lib/html2md.js';

export { parseHTML };

/* ------------------------------------------------------------------ */
/* 0. Node model — normalise real DOM and hand-built fakes to one shape */
/* ------------------------------------------------------------------ */

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const COMMENT_NODE = 8;

/** Attributes probed by name when a node exposes neither `.attributes` nor `.attrs`. */
const PROBE_ATTRS = [
  'class', 'id', 'href', 'src', 'alt', 'title', 'role', 'aria-label', 'aria-hidden',
  'aria-expanded', 'start', 'colspan', 'rowspan', 'jsname', 'encoding', 'display',
  'data-language', 'data-session-thread-id', 'data-subtree', 'data-container-id',
  'data-icl-uuid', 'data-amic', 'data-rl', 'data-turn-id', 'data-thread-turn-id',
  'data-url', 'data-href', 'data-model', 'data-model-name', 'data-q', 'data-query',
];

class SnapText {
  constructor(value) {
    this.nodeType = TEXT_NODE;
    this.nodeValue = value == null ? '' : String(value);
    this.childNodes = [];
    this.parent = null;
  }
  get textContent() { return this.nodeValue; }
}

class SnapComment {
  constructor(value) {
    this.nodeType = COMMENT_NODE;
    this.nodeValue = value == null ? '' : String(value);
    this.childNodes = [];
    this.parent = null;
  }
  get textContent() { return ''; }
}

class SnapElement {
  constructor(tagName, attrs) {
    this.nodeType = ELEMENT_NODE;
    this.tagName = String(tagName || 'div').toUpperCase();
    this.attrs = attrs || Object.create(null);
    this.childNodes = [];
    this.parent = null;
    /** set by the citation/noise rewriter; nodes flagged true are not rendered */
    this.skip = false;
  }
  getAttribute(name) {
    const v = this.attrs[String(name).toLowerCase()];
    return v === undefined ? null : v;
  }
  setAttribute(name, value) { this.attrs[String(name).toLowerCase()] = String(value); }
  get className() { return this.getAttribute('class') || ''; }
  get children() { return this.childNodes.filter((n) => n.nodeType === ELEMENT_NODE); }
  get textContent() {
    let out = '';
    for (const child of this.childNodes) out += child.textContent;
    return out;
  }
}

function readAttributes(el) {
  const out = Object.create(null);
  if (el.attrs && typeof el.attrs === 'object') {
    for (const key of Object.keys(el.attrs)) out[String(key).toLowerCase()] = el.attrs[key];
    return out;
  }
  const list = el.attributes;
  if (list && typeof list.length === 'number') {
    for (let i = 0; i < list.length; i += 1) {
      const a = list[i];
      if (a && a.name) out[String(a.name).toLowerCase()] = a.value == null ? '' : String(a.value);
    }
    return out;
  }
  if (typeof el.getAttribute === 'function') {
    for (const name of PROBE_ATTRS) {
      const v = el.getAttribute(name);
      if (v != null) out[name] = String(v);
    }
  }
  return out;
}

const MAX_SNAPSHOT_NODES = 400000;
const MAX_SNAPSHOT_DEPTH = 300;

/**
 * Copy any DOM-like tree (real `Element`, or the fake nodes `parseHTML` builds) into
 * our own plain tree with parent pointers. We never mutate the live page — Google's
 * DOM is not ours to rewrite — so the citation rewriting below happens on this copy.
 *
 * @param {object} node
 * @returns {SnapElement|SnapText|SnapComment|null}
 */
export function snapshot(node) {
  const budget = { left: MAX_SNAPSHOT_NODES, truncated: false };
  const root = snapshotInto(node, 0, budget);
  if (root && root.nodeType === ELEMENT_NODE) root.truncated = budget.truncated;
  return root;
}

function snapshotInto(node, depth, budget) {
  if (!node || budget.left <= 0) { budget.truncated = budget.truncated || !!node; return null; }
  budget.left -= 1;
  const type = node.nodeType;
  if (type === TEXT_NODE) {
    const value = node.nodeValue == null ? node.textContent : node.nodeValue;
    return new SnapText(value);
  }
  if (type === COMMENT_NODE) {
    const value = node.nodeValue == null ? node.data : node.nodeValue;
    return new SnapComment(value);
  }
  if (type !== ELEMENT_NODE && type !== undefined) {
    // Document / fragment: descend through children without producing a node of our own.
    if (type === 9 || type === 11) {
      const holder = new SnapElement('fragment', Object.create(null));
      appendSnapshotChildren(holder, node, depth, budget);
      return holder;
    }
    return null;
  }
  const tagName = node.tagName || node.nodeName || 'div';
  const el = new SnapElement(tagName, readAttributes(node));
  if (depth >= MAX_SNAPSHOT_DEPTH) { budget.truncated = true; return el; }
  appendSnapshotChildren(el, node, depth, budget);
  return el;
}

function appendSnapshotChildren(target, source, depth, budget) {
  const kids = source.childNodes;
  if (!kids) return;
  const len = typeof kids.length === 'number' ? kids.length : 0;
  for (let i = 0; i < len; i += 1) {
    const copy = snapshotInto(kids[i], depth + 1, budget);
    if (!copy) continue;
    copy.parent = target;
    target.childNodes.push(copy);
  }
}

/* ------------------------------------------------------------------ */
/* 1. Tiny traversal helpers (work on snapshot nodes only)             */
/* ------------------------------------------------------------------ */

function tagOf(node) {
  if (!node || node.nodeType !== ELEMENT_NODE) return '';
  return String(node.tagName || '').toLowerCase();
}

function getAttr(node, name) {
  if (!node || node.nodeType !== ELEMENT_NODE) return null;
  return node.getAttribute(name);
}

function hasAttr(node, name) {
  const v = getAttr(node, name);
  return v !== null && v !== undefined && v !== '';
}

function hasClassName(node, cls) {
  const c = getAttr(node, 'class');
  if (!c) return false;
  return String(c).split(/\s+/).includes(cls);
}

function textOf(node) {
  if (!node) return '';
  const t = node.textContent;
  return typeof t === 'string' ? t : '';
}

function normText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/** Pre-order collect of all element descendants satisfying `pred` (root excluded). */
function walk(root, pred, out = []) {
  if (!root) return out;
  for (const kid of root.childNodes || []) {
    if (kid.nodeType === ELEMENT_NODE) {
      if (pred(kid)) out.push(kid);
      walk(kid, pred, out);
    }
  }
  return out;
}

function findFirst(root, pred) {
  if (!root) return null;
  for (const kid of root.childNodes || []) {
    if (kid.nodeType === ELEMENT_NODE) {
      if (pred(kid)) return kid;
      const deep = findFirst(kid, pred);
      if (deep) return deep;
    }
  }
  return null;
}

/** All comment nodes anywhere in the tree. */
function collectComments(root, out = []) {
  if (!root) return out;
  for (const kid of root.childNodes || []) {
    if (kid.nodeType === COMMENT_NODE) out.push(kid.nodeValue);
    else if (kid.nodeType === ELEMENT_NODE) collectComments(kid, out);
  }
  return out;
}

function elementChildren(node) {
  if (!node) return [];
  return (node.childNodes || []).filter((n) => n.nodeType === ELEMENT_NODE);
}

function ancestorsOf(node) {
  const chain = [];
  let n = node;
  while (n) { chain.push(n); n = n.parent; }
  return chain.reverse();
}

function commonAncestor(nodes) {
  if (!nodes.length) return null;
  let path = ancestorsOf(nodes[0]);
  for (let i = 1; i < nodes.length; i += 1) {
    const other = ancestorsOf(nodes[i]);
    let k = 0;
    while (k < path.length && k < other.length && path[k] === other[k]) k += 1;
    path = path.slice(0, k);
    if (!path.length) return null;
  }
  return path[path.length - 1] || null;
}

/** The child of `parent` that contains `node` (possibly `node` itself). */
function childOfContaining(parent, node) {
  let n = node;
  while (n && n.parent !== parent) n = n.parent;
  return n || null;
}

function depthOf(node) { return ancestorsOf(node).length; }

function hasAncestor(node, pred) {
  let n = node.parent;
  while (n) { if (pred(n)) return true; n = n.parent; }
  return false;
}

/* ------------------------------------------------------------------ */
/* 2. URLs                                                             */
/* ------------------------------------------------------------------ */

/** Unwrap Google's `/url?q=` redirector and reject non-http targets. */
export function normalizeUrl(raw) {
  if (raw == null) return null;
  let u = String(raw).trim();
  if (!u || u.startsWith('#') || /^javascript:/i.test(u)) return null;
  if (u.startsWith('//')) u = `https:${u}`;
  if (/^\/url\?/.test(u) || /^https?:\/\/(?:www\.)?google\.[a-z.]+\/url\?/i.test(u)) {
    const m = u.match(/[?&](?:q|url|imgurl)=([^&]+)/);
    if (m) {
      try { u = decodeURIComponent(m[1]); } catch { /* keep the raw value */ }
    }
  }
  if (!/^https?:\/\//i.test(u)) return null;
  return u;
}

export function hostOf(url) {
  const m = String(url || '').match(/^https?:\/\/([^/?#]+)/i);
  if (!m) return null;
  return m[1].replace(/^www\./i, '');
}

export function slugify(text, max = 60) {
  const s = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9Ѐ-ӿ]+/gi, '-')
    .replace(/^-+|-+$/g, '');
  return s.slice(0, max).replace(/-+$/g, '');
}

/** `q` (or `query`) parameter out of a Search URL, without depending on `URL`. */
export function queryParam(url, name = 'q') {
  const s = String(url || '');
  const qIdx = s.indexOf('?');
  if (qIdx === -1) return null;
  const hashIdx = s.indexOf('#');
  const search = s.slice(qIdx + 1, hashIdx === -1 ? undefined : hashIdx);
  for (const pair of search.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const key = eq === -1 ? pair : pair.slice(0, eq);
    if (key !== name) continue;
    const raw = eq === -1 ? '' : pair.slice(eq + 1);
    try { return decodeURIComponent(raw.replace(/\+/g, ' ')); } catch { return raw; }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 3. Citations                                                        */
/* ------------------------------------------------------------------ */

/**
 * Is this element an inline citation pill?
 *
 * Priority: the two attributes Google actually ships (`data-icl-uuid`, `data-amic`),
 * then the AI Overview `jsname`, then a purely semantic shape — a link or button whose
 * entire label is a small number, which is what a numbered citation looks like to a
 * screen reader regardless of how the classes are hashed this week.
 */
export function isCitationPill(el) {
  if (!el || el.nodeType !== ELEMENT_NODE) return false;
  if (hasAttr(el, 'data-icl-uuid')) return true;
  if (getAttr(el, 'data-amic') === 'true') return true;
  if (getAttr(el, 'jsname') === 'HtgYJd') return true;
  const t = tagOf(el);
  const clickable = t === 'a' || t === 'button' || getAttr(el, 'role') === 'button' || t === 'sup';
  if (!clickable) return false;
  const label = normText(textOf(el));
  return /^\[?\d{1,2}\]?$/.test(label);
}

/**
 * Mine the hidden `<!--Sv6Kpe[["<uuid>", ...]]-->` comment blocks for pill targets.
 *
 * The exact JSON shape is undocumented and changes, so this is deliberately tolerant:
 * for every uuid we care about, take the slice of the comment that follows it (up to
 * the next known uuid) and pull the first URL and the first plausible title out of it.
 *
 * @param {string[]} comments raw comment text
 * @param {Iterable<string>} uuids uuids seen on pills in the page
 * @returns {Map<string, {url: string|null, title: string|null}>}
 */
export function parseCitationComments(comments, uuids) {
  const wanted = new Set(Array.from(uuids || []).filter(Boolean));
  const found = new Map();
  if (!wanted.size) return found;

  for (const raw of comments || []) {
    const text = String(raw || '');
    if (!text) continue;
    // Where does each wanted uuid appear in this comment?
    const marks = [];
    for (const uuid of wanted) {
      let from = 0;
      for (;;) {
        const idx = text.indexOf(uuid, from);
        if (idx === -1) break;
        marks.push({ uuid, at: idx + uuid.length });
        from = idx + uuid.length;
      }
    }
    if (!marks.length) continue;
    marks.sort((a, b) => a.at - b.at);
    for (let i = 0; i < marks.length; i += 1) {
      const start = marks[i].at;
      const end = i + 1 < marks.length ? marks[i + 1].at : text.length;
      const slice = text.slice(start, end);
      const entry = extractUrlAndTitle(slice);
      if (!entry.url && !entry.title) continue;
      const prev = found.get(marks[i].uuid);
      if (!prev || (!prev.url && entry.url)) found.set(marks[i].uuid, entry);
    }
  }
  return found;
}

const URL_IN_BLOB_RE = /https?:\\?\/\\?\/[^"'\\\s,\]}]+/;
const QUOTED_RE = /"((?:[^"\\]|\\.){2,300})"/g;

function extractUrlAndTitle(slice) {
  let url = null;
  const um = slice.match(URL_IN_BLOB_RE);
  if (um) url = normalizeUrl(um[0].replace(/\\\//g, '/'));

  let title = null;
  QUOTED_RE.lastIndex = 0;
  let m;
  while ((m = QUOTED_RE.exec(slice)) !== null) {
    const candidate = m[1].replace(/\\"/g, '"').replace(/\\\//g, '/').trim();
    if (!candidate || candidate.length < 3) continue;
    if (/^https?:\/\//i.test(candidate)) continue;
    if (/^[0-9a-f-]{16,}$/i.test(candidate)) continue;     // another uuid
    if (/^[A-Za-z0-9_-]{20,}$/.test(candidate) && !/\s/.test(candidate)) continue; // opaque token
    if (!/[A-Za-zЀ-ӿ]/.test(candidate)) continue; // pure punctuation/numbers
    title = candidate;
    break;
  }
  return { url, title };
}

/**
 * Source links Google renders outside the answer body — the right-hand "Sources" rail
 * (`[data-container-id="rhs-col"] [role="dialog"] a`) and the inline web-results
 * variant (`a.ZbQNgf`). Used to enrich titles and as a fallback list.
 * @returns {{url: string, title: string|null}[]}
 */
export function collectPanelSources(root) {
  const anchors = walk(root, (el) => {
    if (tagOf(el) !== 'a') return false;
    if (hasClassName(el, 'ZbQNgf')) return true;
    if (hasAncestor(el, (a) => getAttr(a, 'role') === 'dialog')
      && hasAncestor(el, (a) => getAttr(a, 'data-container-id') === 'rhs-col')) return true;
    return false;
  });
  const seen = new Set();
  const out = [];
  for (const a of anchors) {
    const url = normalizeUrl(getAttr(a, 'href'));
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, title: normText(textOf(a)) || null });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 4. Noise filtering                                                  */
/* ------------------------------------------------------------------ */

/** Interactive / chrome roles that never carry answer prose. */
const NOISE_ROLES = new Set([
  'button', 'tab', 'tablist', 'toolbar', 'navigation', 'menu', 'menubar', 'menuitem',
  'menuitemcheckbox', 'menuitemradio', 'dialog', 'alertdialog', 'search', 'searchbox',
  'form', 'banner', 'contentinfo', 'complementary', 'textbox', 'combobox', 'listbox',
  'option', 'switch', 'checkbox', 'radio', 'radiogroup', 'slider', 'progressbar',
]);

const NOISE_TEXT_RE = new RegExp(
  '^(share|copy|copy link|copy text|export|save|more|show more|show less|show all|'
  + 'sources|all sources|feedback|send feedback|report|good response|bad response|'
  + 'like|dislike|thumbs up|thumbs down|ask anything|ask a follow-up|ask a follow up|'
  + 'dive deeper in ai mode|ai mode|all|images|videos|news|shopping|web|short videos|'
  + 'forums|tools|sign in|settings|people also ask|sponsored|ad|ads|'
  + 'поделиться|копировать|ещё|еще|показать ещё|показать еще|свернуть|источники|'
  + 'все|картинки|видео|новости|войти|настройки)$',
  'i',
);

const NOISE_LABEL_RE = /(share|feedback|thumbs|copy link|sign in|search with your camera|clear search|voice search|more options|поделиться|скопировать)/i;

const DISCLAIMER_RE = /^.*(ai responses may include mistakes|ai mode can make mistakes|проверяйте информацию|ответы ии могут содержать ошибки).*$/gim;

function isNoiseElement(el) {
  if (el.skip) return true;
  if (getAttr(el, 'aria-hidden') === 'true') return true;
  const role = (getAttr(el, 'role') || '').toLowerCase();
  if (role && NOISE_ROLES.has(role)) return true;
  const t = tagOf(el);
  if (t === 'button' || t === 'form' || t === 'input' || t === 'select' || t === 'textarea'
    || t === 'nav' || t === 'header' || t === 'footer' || t === 'script' || t === 'style'
    || t === 'noscript' || t === 'svg' || t === 'template') return true;
  const label = getAttr(el, 'aria-label');
  if (label && NOISE_LABEL_RE.test(label)) return true;
  const text = normText(textOf(el));
  if (text && text.length <= 40 && NOISE_TEXT_RE.test(text)) return true;
  return false;
}

/* ------------------------------------------------------------------ */
/* 5. Turning one answer subtree into Markdown + a Sources block       */
/* ------------------------------------------------------------------ */

function makeAnchor(href, label) {
  const a = new SnapElement('a', Object.create(null));
  a.setAttribute('href', href);
  const t = new SnapText(label);
  t.parent = a;
  a.childNodes.push(t);
  return a;
}

function makeSpan(label) {
  const span = new SnapElement('span', Object.create(null));
  const t = new SnapText(label);
  t.parent = span;
  span.childNodes.push(t);
  return span;
}

function replaceNode(oldNode, newNode) {
  const parent = oldNode.parent;
  if (!parent) return;
  const idx = parent.childNodes.indexOf(oldNode);
  if (idx === -1) return;
  newNode.parent = parent;
  parent.childNodes[idx] = newNode;
}

/**
 * Rewrite every citation pill inside `nodes` into a real Markdown-able link, in order
 * of first appearance, and collect the numbered source list for the message.
 *
 * @returns {{sources: {n: number, url: string|null, title: string|null}[], unresolved: number}}
 */
function rewriteCitations(nodes, ctx) {
  const sources = [];
  const byUrl = new Map();
  let unresolved = 0;

  const visit = (node) => {
    if (!node || node.nodeType !== ELEMENT_NODE) return;
    if (isCitationPill(node)) {
      const resolved = resolvePill(node, ctx);
      let entry;
      if (resolved.url && byUrl.has(resolved.url)) {
        entry = byUrl.get(resolved.url);
        if (!entry.title && resolved.title) entry.title = resolved.title;
      } else {
        entry = { n: sources.length + 1, url: resolved.url, title: resolved.title };
        sources.push(entry);
        if (resolved.url) byUrl.set(resolved.url, entry);
        else unresolved += 1;
      }
      const label = `[${entry.n}]`;
      replaceNode(node, entry.url ? makeAnchor(entry.url, label) : makeSpan(label));
      return;
    }
    for (const kid of node.childNodes.slice()) visit(kid);
  };

  for (const node of nodes) visit(node);
  return { sources, unresolved };
}

function resolvePill(pill, ctx) {
  // 1. the pill is itself a link
  let url = normalizeUrl(getAttr(pill, 'href'));
  let title = null;

  // 2. hidden comment block keyed by uuid
  if (!url) {
    const uuid = getAttr(pill, 'data-icl-uuid');
    if (uuid && ctx.commentIndex.has(uuid)) {
      const hit = ctx.commentIndex.get(uuid);
      url = hit.url || null;
      title = hit.title || null;
    }
  }
  // 3. data-* carrying the target directly
  if (!url) url = normalizeUrl(getAttr(pill, 'data-url') || getAttr(pill, 'data-href'));
  // 4. a nested anchor (the AI Overview `ul[jsname="Z3saHd"]` dropdown lands here once open)
  if (!url) {
    const inner = findFirst(pill, (el) => tagOf(el) === 'a' && normalizeUrl(getAttr(el, 'href')));
    if (inner) {
      url = normalizeUrl(getAttr(inner, 'href'));
      title = title || normText(textOf(inner)) || null;
    }
  }
  if (!title) {
    const label = getAttr(pill, 'aria-label') || getAttr(pill, 'title');
    if (label && !/^\[?\d{1,2}\]?$/.test(normText(label))) title = normText(label);
  }
  if (url && (!title || /^\[?\d{1,2}\]?$/.test(title))) {
    const known = ctx.titleByUrl.get(url);
    title = known || hostOf(url);
  }
  return { url, title: title || null };
}

function stripNoise(node) {
  if (!node || node.nodeType !== ELEMENT_NODE) return;
  const kept = [];
  for (const kid of node.childNodes) {
    if (kid.nodeType === ELEMENT_NODE) {
      if (isNoiseElement(kid)) continue;
      stripNoise(kid);
    }
    kept.push(kid);
  }
  node.childNodes = kept;
}

function collectAttachments(nodes) {
  const out = [];
  const seen = new Set();
  for (const node of nodes) {
    const imgs = walk(node, (el) => tagOf(el) === 'img');
    if (tagOf(node) === 'img') imgs.unshift(node);
    for (const img of imgs) {
      const url = normalizeUrl(getAttr(img, 'src'));
      if (!url || seen.has(url)) continue;
      if (/gstatic\.com\/(images\/branding|ui\/)/i.test(url)) continue;
      seen.add(url);
      out.push({
        type: 'image',
        name: null,
        url,
        alt: normText(getAttr(img, 'alt')) || null,
      });
    }
  }
  return out;
}

/**
 * Render one answer (a list of sibling snapshot nodes) into Markdown, with inline
 * citation links and a trailing `## Sources` block.
 * @returns {{text: string, attachments: object[], warnings: string[]}}
 */
export function renderAnswer(nodes, ctx) {
  const warnings = [];
  const attachments = collectAttachments(nodes);
  const { sources, unresolved } = rewriteCitations(nodes, ctx);

  const holder = new SnapElement('div', Object.create(null));
  for (const node of nodes) {
    if (node.nodeType === ELEMENT_NODE && isNoiseElement(node)) continue;
    node.parent = holder;
    holder.childNodes.push(node);
  }
  stripNoise(holder);

  let text = htmlToMarkdown(holder);
  text = text.replace(DISCLAIMER_RE, '').replace(/\n{3,}/g, '\n\n').trim();

  let list = sources;
  if (!list.length && ctx.panelSources.length && ctx.attachPanelSources) {
    list = ctx.panelSources.map((s, i) => ({ n: i + 1, url: s.url, title: s.title }));
  }
  if (list.length) {
    const lines = list.map((s) => {
      const label = s.title || (s.url ? hostOf(s.url) : null) || 'source';
      return s.url ? `${s.n}. [${label}](${s.url})` : `${s.n}. ${label} (link unavailable)`;
    });
    text = `${text}\n\n## Sources\n\n${lines.join('\n')}`.trim();
  }
  if (unresolved) {
    warnings.push(
      `${unresolved} inline citation${unresolved === 1 ? '' : 's'} could not be resolved to a URL — `
      + 'AI Mode keeps pill targets in a hidden metadata block that was not present or not parseable. '
      + 'The citation numbers are preserved in the text.',
    );
  }
  return { text, attachments, warnings };
}

/* ------------------------------------------------------------------ */
/* 6. Locating the thread and its turns                                */
/* ------------------------------------------------------------------ */

/**
 * Prioritised list of thread-root strategies. Each returns the container that holds
 * the whole conversation, or null. `overview: true` marks a strategy that lands on an
 * AI Overview block (single answer, no follow-ups).
 */
export const ROOT_STRATEGIES = [
  {
    name: 'data-session-thread-id',
    overview: false,
    find(root) {
      const nodes = walk(root, (el) => hasAttr(el, 'data-session-thread-id'));
      if (!nodes.length) return null;
      // The answer body wraps the thread node, so lift to the parent when we can.
      const anchor = nodes.length === 1 ? nodes[0] : commonAncestor(nodes);
      if (!anchor) return null;
      return anchor.parent && anchor.parent.parent ? anchor.parent : anchor;
    },
  },
  {
    name: 'data-subtree=aimc',
    overview: false,
    find(root) {
      return findFirst(root, (el) => getAttr(el, 'data-subtree') === 'aimc'
        || getAttr(el, 'data-container-id') === 'aimc'
        || hasAttr(el, 'data-aimc'));
    },
  },
  {
    name: 'aria-label=AI Mode',
    overview: false,
    find(root) {
      return findFirst(root, (el) => {
        const label = getAttr(el, 'aria-label');
        if (!label || !/\bai mode\b/i.test(label)) return false;
        const role = getAttr(el, 'role');
        return role === 'region' || role === 'main' || role === 'log' || tagOf(el) === 'main';
      });
    },
  },
  {
    name: 'ai-overview:main-col',
    overview: true,
    find(root) {
      return findFirst(root, (el) => getAttr(el, 'data-container-id') === 'main-col'
        && hasAncestor(el, (a) => getAttr(a, 'id') === 'm-x-content'));
    },
  },
  {
    name: 'ai-overview:data-rl',
    overview: true,
    find(root) {
      return findFirst(root, (el) => hasAttr(el, 'data-rl')
        && hasAncestor(el, (a) => getAttr(a, 'id') === 'm-x-content'));
    },
  },
  {
    name: 'ai-overview:m-x-content',
    overview: true,
    find(root) { return findFirst(root, (el) => getAttr(el, 'id') === 'm-x-content'); },
  },
  {
    name: 'role=main',
    overview: false,
    find(root) {
      return findFirst(root, (el) => getAttr(el, 'role') === 'main' || tagOf(el) === 'main');
    },
  },
];

export function findThreadRoot(root) {
  for (const strategy of ROOT_STRATEGIES) {
    let node = null;
    try { node = strategy.find(root); } catch { node = null; }
    if (node && normText(textOf(node))) {
      return { node, strategy: strategy.name, overview: !!strategy.overview };
    }
  }
  return { node: null, strategy: null, overview: false };
}

const EXPLICIT_TURN_ATTRS = ['data-turn-id', 'data-thread-turn-id', 'data-async-fc-turn'];

/**
 * Question nodes are headings (`h1`–`h3` or `role="heading"`) that do not themselves
 * contain a citation pill. Several groups usually qualify (the answer has its own
 * sub-headings), so pick the group that best matches the `q` parameter and sits
 * shallowest in the tree — that is the thread column.
 */
export function findQuestionNodes(threadRoot, q) {
  const headings = walk(threadRoot, (el) => {
    const t = tagOf(el);
    const isHeading = t === 'h1' || t === 'h2' || t === 'h3' || getAttr(el, 'role') === 'heading';
    if (!isHeading) return false;
    const txt = normText(textOf(el));
    if (!txt || txt.length > 400) return false;
    if (NOISE_TEXT_RE.test(txt)) return false;
    if (findFirst(el, isCitationPill)) return false;
    return true;
  });
  if (!headings.length) return [];

  const groups = new Map();
  for (const h of headings) {
    const key = `${tagOf(h)}|${getAttr(h, 'role') || ''}|${depthOf(h)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(h);
  }

  const wanted = normText(q).toLowerCase();
  let best = null;
  let bestScore = -Infinity;
  for (const members of groups.values()) {
    const first = normText(textOf(members[0])).toLowerCase();
    let score = 0;
    if (wanted) {
      if (members.some((m) => normText(textOf(m)).toLowerCase() === wanted)) score += 1000;
      else if (first && (first.startsWith(wanted) || wanted.startsWith(first))) score += 400;
    }
    score += members.length * 10;
    score -= depthOf(members[0]);
    if (score > bestScore) { bestScore = score; best = members; }
  }
  return best || [];
}

/**
 * Split `threadRoot` into `{question, answerNodes}` turns.
 * Strategies in priority order; the first that yields at least one turn wins.
 * @returns {{turns: {question: string|null, questionNode: object|null, answerNodes: object[]}[], strategy: string}}
 */
export function findTurns(threadRoot, q, isOverview) {
  // S1 — explicit per-turn containers.
  for (const attrName of EXPLICIT_TURN_ATTRS) {
    const containers = walk(threadRoot, (el) => hasAttr(el, attrName));
    if (containers.length) {
      const turns = containers.map((c) => {
        const qNode = findFirst(c, (el) => {
          const t = tagOf(el);
          return (t === 'h1' || t === 'h2' || t === 'h3' || getAttr(el, 'role') === 'heading')
            && !!normText(textOf(el));
        });
        if (qNode) qNode.skip = true;
        return {
          question: qNode ? normText(textOf(qNode)) : null,
          questionNode: qNode,
          answerNodes: [c],
        };
      });
      if (turns.length) return { turns, strategy: `explicit-turns:${attrName}` };
    }
  }

  // S2 — heading-segmented column (the normal AI Mode shape).
  if (!isOverview) {
    const questions = findQuestionNodes(threadRoot, q);
    if (questions.length) {
      const parent = commonAncestor(questions);
      if (parent) {
        const kids = elementChildren(parent);
        const marks = [];
        for (const qn of questions) {
          const block = childOfContaining(parent, qn);
          const idx = block ? kids.indexOf(block) : -1;
          if (idx === -1) continue;
          if (marks.length && marks[marks.length - 1].idx === idx) continue;
          marks.push({ idx, qNode: qn, block });
        }
        marks.sort((a, b) => a.idx - b.idx);
        const turns = [];
        for (let i = 0; i < marks.length; i += 1) {
          const start = marks[i].idx;
          const end = i + 1 < marks.length ? marks[i + 1].idx : kids.length;
          const slice = kids.slice(start, end);
          marks[i].qNode.skip = true;
          const answerNodes = slice.filter((n) => n !== marks[i].qNode);
          turns.push({
            question: normText(textOf(marks[i].qNode)),
            questionNode: marks[i].qNode,
            answerNodes,
          });
        }
        if (turns.length) return { turns, strategy: 'heading-segmented' };
      }
    }
  }

  // S3 — one question, one answer (AI Overview, or a single-turn AI Mode page).
  const body = normText(textOf(threadRoot));
  if (body) {
    return {
      turns: [{ question: q ? normText(q) : null, questionNode: null, answerNodes: [threadRoot] }],
      strategy: isOverview ? 'single-answer:ai-overview' : 'single-answer',
    };
  }
  return { turns: [], strategy: 'none' };
}

/* ------------------------------------------------------------------ */
/* 7. Model + id                                                       */
/* ------------------------------------------------------------------ */

const MODEL_RE = /\b(Gemini\s+\d+(?:\.\d+)?\s*(?:Pro|Flash|Flash-Lite|Ultra|Thinking)?)\b/i;

/**
 * Only trust an explicit model attribute or a model chip's `aria-label`. Scanning the
 * answer prose would happily pick up "Gemini 3 Pro" out of an answer *about* Gemini.
 */
export function detectModel(root) {
  const explicit = findFirst(root, (el) => hasAttr(el, 'data-model') || hasAttr(el, 'data-model-name'));
  if (explicit) {
    const v = normText(getAttr(explicit, 'data-model') || getAttr(explicit, 'data-model-name'));
    if (v) return v;
  }
  const chip = findFirst(root, (el) => {
    const label = getAttr(el, 'aria-label');
    return !!label && MODEL_RE.test(label) && normText(label).length <= 60;
  });
  if (chip) {
    const m = normText(getAttr(chip, 'aria-label')).match(MODEL_RE);
    if (m) return m[1];
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 8. Expansion (real DOM only)                                        */
/* ------------------------------------------------------------------ */

const EXPAND_TEXT_RE = /^(show more|show all|read more|see more|expand|more|показать ещё|показать еще|ещё|еще|развернуть)$/i;
const EXPAND_LABEL_RE = /(show more|show all|read more|see more|expand|load more|показать ещё|показать еще|развернуть)/i;
const MAX_EXPAND_ITERATIONS = 60;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * AI Mode collapses long answers and lazily renders earlier turns. Click every
 * "Show more"-style control and scroll top↔bottom until the page stops growing.
 * Bounded at 60 iterations; warns if the cap is hit.
 *
 * @returns {Promise<{iterations: number, clicks: number, capped: boolean}>}
 */
export async function expandThread(doc, win, opts = {}) {
  const result = { iterations: 0, clicks: 0, capped: false };
  if (!doc || typeof doc.querySelectorAll !== 'function') return result;
  const maxIterations = opts.maxIterations || MAX_EXPAND_ITERATIONS;
  const wait = opts.wait || sleep;
  const clicked = new Set();
  let stableRounds = 0;
  let lastSignature = -1;

  for (let i = 0; i < maxIterations; i += 1) {
    result.iterations = i + 1;

    let controls = [];
    try {
      controls = Array.from(doc.querySelectorAll('button, [role="button"], a[aria-expanded], summary'));
    } catch { controls = []; }

    for (const el of controls) {
      if (clicked.has(el)) continue;
      let label = '';
      try { label = (el.getAttribute('aria-label') || '') + ' ' + (el.textContent || ''); } catch { label = ''; }
      const text = normText(el.textContent || '');
      const looksExpandable = EXPAND_LABEL_RE.test(label) || EXPAND_TEXT_RE.test(text);
      if (!looksExpandable) continue;
      if (el.getAttribute && el.getAttribute('aria-expanded') === 'true') { clicked.add(el); continue; }
      clicked.add(el);
      try { el.click(); result.clicks += 1; } catch { /* control refused; keep going */ }
    }

    if (win && typeof win.scrollTo === 'function') {
      try {
        win.scrollTo(0, 0);
        const height = (doc.documentElement && doc.documentElement.scrollHeight)
          || (doc.body && doc.body.scrollHeight) || 0;
        win.scrollTo(0, height);
      } catch { /* headless / restricted */ }
    }

    await wait(opts.delay == null ? 250 : opts.delay);

    let signature = 0;
    try {
      const all = doc.getElementsByTagName ? doc.getElementsByTagName('*').length : 0;
      const len = (doc.body && doc.body.textContent ? doc.body.textContent.length : 0);
      signature = all * 31 + len;
    } catch { signature = lastSignature; }

    if (signature === lastSignature) {
      stableRounds += 1;
      if (stableRounds >= 2) return result;
    } else {
      stableRounds = 0;
      lastSignature = signature;
    }
  }
  result.capped = true;
  return result;
}

/* ------------------------------------------------------------------ */
/* 9. Assembly                                                         */
/* ------------------------------------------------------------------ */

const FALLBACK_TITLE = 'AI Mode conversation';
const MAX_TITLE_LEN = 120;

function emptyConversation(url, warnings, extra = {}) {
  return {
    id: 'unknown',
    title: FALLBACK_TITLE,
    createTime: null,
    updateTime: null,
    model: null,
    sourceUrl: url || '',
    extractedVia: 'dom',
    messages: [],
    warnings: warnings.slice(),
    ...extra,
  };
}

/**
 * Build a `Conversation` from an already-loaded page tree. Synchronous and pure — the
 * unit tests drive this directly with a hand-built fake DOM.
 *
 * @param {object} params
 * @param {object} params.root    DOM-like root (real `document.body` or a fake node)
 * @param {string} [params.url]
 * @param {string[]} [params.warnings]
 * @param {number} [params.now]   ms epoch, for the generated id
 * @returns {import('./extract.js').Conversation}
 */
export function buildConversation(params = {}) {
  const url = params.url || '';
  const warnings = (params.warnings || []).slice();
  const now = params.now == null ? Date.now() : params.now;

  const snap = snapshot(params.root);
  if (!snap) {
    warnings.push('Chat2MD could not read the page: no DOM was available to scan.');
    return emptyConversation(url, warnings);
  }
  if (snap.truncated) {
    warnings.push('The page was unusually large and the scan was truncated; the export may be incomplete.');
  }

  const q = queryParam(url, 'q') || queryParam(url, 'query') || '';
  const { node: threadRoot, strategy: rootStrategy, overview } = findThreadRoot(snap);

  if (!threadRoot) {
    warnings.push(
      'Chat2MD did not recognise this page layout as a Google AI Mode thread or an AI Overview. '
      + 'None of the known anchors (data-session-thread-id, data-subtree="aimc", an AI Mode region '
      + 'label, or the #m-x-content AI Overview block) were found. Nothing was exported. '
      + 'Google changes this markup often — please report the page so the selectors can be updated.',
    );
    return emptyConversation(url, warnings);
  }
  if (overview) {
    warnings.push(
      `Exported the AI Overview block on this results page (matched via "${rootStrategy}"), not a full `
      + 'AI Mode thread. AI Overviews are a single generated answer with no follow-up turns.',
    );
  }

  const { turns, strategy: turnStrategy } = findTurns(threadRoot, q, overview);
  if (!turns.length) {
    warnings.push(
      `Chat2MD found the AI Mode container (via "${rootStrategy}") but could not split it into `
      + 'question/answer turns, so nothing was exported. This usually means Google changed the '
      + 'thread markup. Please report the page.',
    );
    return emptyConversation(url, warnings);
  }
  if (turnStrategy.startsWith('single-answer') && !overview) {
    warnings.push(
      'No per-turn structure was recognised, so the whole AI Mode panel was exported as one answer. '
      + 'If the thread had follow-up questions they are run together in this file.',
    );
  }

  // Citation resolution context, built once for the whole page.
  const pillUuids = new Set();
  for (const pill of walk(snap, (el) => hasAttr(el, 'data-icl-uuid'))) {
    pillUuids.add(getAttr(pill, 'data-icl-uuid'));
  }
  const commentIndex = parseCitationComments(collectComments(snap), pillUuids);
  const panelSources = collectPanelSources(snap);
  const titleByUrl = new Map();
  for (const s of panelSources) if (s.url && s.title) titleByUrl.set(s.url, s.title);
  for (const [, v] of commentIndex) if (v.url && v.title && !titleByUrl.has(v.url)) titleByUrl.set(v.url, v.title);

  const ctx = {
    commentIndex,
    panelSources,
    titleByUrl,
    attachPanelSources: turns.length === 1,
  };

  const threadId = (() => {
    const holder = findFirst(snap, (el) => hasAttr(el, 'data-session-thread-id'));
    return holder ? normText(getAttr(holder, 'data-session-thread-id')) : '';
  })();

  const messages = [];
  const answerWarnings = new Set();
  let emptyAnswers = 0;

  turns.forEach((turn, index) => {
    const question = turn.question || (index === 0 && q ? normText(q) : null);
    if (question) {
      messages.push({
        id: null,
        role: 'user',
        authorName: null,
        createTime: null,
        contentType: 'text',
        text: question,
        attachments: [],
        hidden: false,
      });
    } else {
      answerWarnings.add(`Turn ${index + 1}: the question text was not found in the page.`);
    }

    const rendered = renderAnswer(turn.answerNodes, ctx);
    for (const w of rendered.warnings) answerWarnings.add(w);
    if (!rendered.text) {
      emptyAnswers += 1;
      return;
    }
    messages.push({
      id: null,
      role: 'assistant',
      authorName: null,
      createTime: null,
      contentType: 'text',
      text: rendered.text,
      attachments: rendered.attachments,
      hidden: false,
    });
  });

  for (const w of answerWarnings) warnings.push(w);
  if (emptyAnswers) {
    warnings.push(
      `${emptyAnswers} turn${emptyAnswers === 1 ? '' : 's'} had a question but no readable answer text — `
      + 'the answer may still have been streaming when the export ran. Try again once it has finished.',
    );
  }

  if (!messages.length) {
    warnings.push(
      'Chat2MD recognised the AI Mode layout but every turn came out empty, so nothing was exported. '
      + 'If the answer was still generating, wait for it to finish and try again.',
    );
    return emptyConversation(url, warnings);
  }

  const firstUser = messages.find((m) => m.role === 'user');
  let title = normText(firstUser ? firstUser.text : '') || normText(q) || FALLBACK_TITLE;
  if (title.length > MAX_TITLE_LEN) title = `${title.slice(0, MAX_TITLE_LEN - 1).trimEnd()}…`;

  const id = threadId
    || (slugify(q || title) ? `aimode-${slugify(q || title)}-${Math.floor(now / 1000)}` : 'unknown');

  return {
    id,
    title,
    createTime: null,
    updateTime: null,
    model: detectModel(threadRoot),
    sourceUrl: url,
    extractedVia: 'dom',
    messages,
    warnings,
  };
}

/**
 * Entry point (content-script context). Expands the thread, then scrapes it.
 * Never throws for a recoverable problem: an unrecognised page comes back as a
 * Conversation with `messages: []` and a warning that explains why.
 *
 * @param {{document?: object, window?: object, url?: string, root?: object, now?: number,
 *          expand?: boolean, expandOptions?: object}} [opts]
 * @returns {Promise<object>} Conversation
 */
export async function extractConversation(opts = {}) {
  const doc = opts.document || (typeof document !== 'undefined' ? document : null);
  const win = opts.window || (typeof window !== 'undefined' ? window : null);
  const url = opts.url
    || (doc && doc.location && doc.location.href)
    || (win && win.location && win.location.href)
    || '';
  const warnings = [];

  if (!doc && !opts.root) {
    warnings.push('Chat2MD could not access the page document, so nothing was exported.');
    return emptyConversation(url, warnings);
  }

  if (opts.expand !== false && doc) {
    try {
      const expansion = await expandThread(doc, win, opts.expandOptions || {});
      if (expansion.capped) {
        warnings.push(
          `Stopped expanding the thread after ${expansion.iterations} passes because the page was still `
          + 'growing. Very old turns near the top may be missing from this export.',
        );
      }
    } catch (err) {
      warnings.push(`Could not fully expand the thread (${err && err.message ? err.message : 'unknown error'}); `
        + 'collapsed answers or older turns may be missing.');
    }
  }

  const root = opts.root || (doc && (doc.body || doc.documentElement)) || doc;
  return buildConversation({ root, url, warnings, now: opts.now });
}

export default extractConversation;
