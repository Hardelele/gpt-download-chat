/**
 * dom-util.js — node-agnostic DOM helpers + a tiny virtual-node tree (Agent E).
 *
 * Everything in this file works identically on
 *   1. a real DOM node (content script),
 *   2. the `FakeElement` tree produced by `html2md.js`'s `parseHTML()`, and
 *   3. the `VNode`s constructed below.
 *
 * The only members ever touched are `nodeType`, `tagName`, `childNodes`,
 * `getAttribute()`, `nodeValue` and `textContent` — the exact subset that
 * Agent A's `htmlToMarkdown()` consumes. That is deliberate: the Gemini
 * extractor rewrites the page's DOM into a clean `VNode` tree and then hands
 * it to the *shared* converter instead of writing a second one.
 *
 * No `window` / `document` access at module scope.
 */

export const ELEMENT_NODE = 1;
export const TEXT_NODE = 3;

/* ------------------------------------------------------------------ */
/* Readers                                                             */
/* ------------------------------------------------------------------ */

/** Lower-case tag name, or '' for non-elements. */
export function tagOf(node) {
  if (!node || node.nodeType !== ELEMENT_NODE) return '';
  const t = node.tagName || node.nodeName || '';
  return String(t).toLowerCase();
}

/** `getAttribute` that never throws and returns `null` when absent. */
export function attrOf(node, name) {
  if (!node || node.nodeType !== ELEMENT_NODE) return null;
  if (typeof node.getAttribute === 'function') {
    const v = node.getAttribute(name);
    return v === undefined ? null : v;
  }
  return null;
}

/** Array of class tokens. */
export function classesOf(node) {
  const raw = attrOf(node, 'class');
  if (typeof raw !== 'string' || !raw) return [];
  return raw.split(/\s+/).filter(Boolean);
}

export function hasClass(node, name) {
  return classesOf(node).indexOf(name) !== -1;
}

/**
 * True when any class token *contains* `needle`.
 * Angular Material hashes/suffixes class names (`markdown-main-panel`,
 * `code-block-decoration`, `_ngcontent-ng-c123`), so substring matching is a
 * good deal more durable than exact matching here.
 */
export function hasClassLike(node, needle) {
  const n = String(needle).toLowerCase();
  return classesOf(node).some((c) => c.toLowerCase().includes(n));
}

export function childNodesOf(node) {
  if (!node) return [];
  const cn = node.childNodes;
  if (!cn) return [];
  return Array.prototype.slice.call(cn);
}

export function elementChildrenOf(node) {
  return childNodesOf(node).filter((n) => n && n.nodeType === ELEMENT_NODE);
}

export function textOf(node) {
  if (!node) return '';
  const t = node.textContent;
  return typeof t === 'string' ? t : '';
}

/* ------------------------------------------------------------------ */
/* Traversal (document order, pre-order DFS)                           */
/* ------------------------------------------------------------------ */

/** All descendant elements matching `pred`, in document order. */
export function findAll(node, pred, out = []) {
  for (const kid of childNodesOf(node)) {
    if (kid && kid.nodeType === ELEMENT_NODE) {
      if (pred(kid)) out.push(kid);
      findAll(kid, pred, out);
    }
  }
  return out;
}

/**
 * Like `findAll`, but does not descend into a node that matched. Useful for
 * "top-level turns only" queries where turns can nest visually.
 */
export function findAllShallow(node, pred, out = []) {
  for (const kid of childNodesOf(node)) {
    if (!kid || kid.nodeType !== ELEMENT_NODE) continue;
    if (pred(kid)) out.push(kid);
    else findAllShallow(kid, pred, out);
  }
  return out;
}

/** First descendant element matching `pred`, or null. */
export function findFirst(node, pred) {
  for (const kid of childNodesOf(node)) {
    if (!kid || kid.nodeType !== ELEMENT_NODE) continue;
    if (pred(kid)) return kid;
    const deep = findFirst(kid, pred);
    if (deep) return deep;
  }
  return null;
}

/** Predicate factory: element whose tag name is one of `names`. */
export function byTag(...names) {
  const set = new Set(names.map((n) => String(n).toLowerCase()));
  return (node) => set.has(tagOf(node));
}

/** First descendant with one of the given tag names. */
export function firstByTag(node, ...names) {
  return findFirst(node, byTag(...names));
}

/** All descendants with one of the given tag names. */
export function allByTag(node, ...names) {
  return findAll(node, byTag(...names));
}

/** First descendant whose class list contains a token including `needle`. */
export function firstByClassLike(node, needle) {
  return findFirst(node, (n) => hasClassLike(n, needle));
}

/* ------------------------------------------------------------------ */
/* Virtual nodes (the rewrite target)                                  */
/* ------------------------------------------------------------------ */

export class VText {
  constructor(value) {
    this.nodeType = TEXT_NODE;
    this.nodeValue = String(value == null ? '' : value);
    this.childNodes = [];
  }
  get textContent() { return this.nodeValue; }
}

export class VNode {
  /**
   * @param {string} tagName
   * @param {Record<string,string>} [attrs]
   * @param {Array<VNode|VText>} [children]
   */
  constructor(tagName, attrs = {}, children = []) {
    this.nodeType = ELEMENT_NODE;
    this.tagName = String(tagName).toUpperCase();
    this.attrs = Object.create(null);
    for (const key of Object.keys(attrs || {})) {
      const value = attrs[key];
      if (value == null) continue;
      this.attrs[String(key).toLowerCase()] = String(value);
    }
    this.childNodes = [];
    for (const child of children || []) this.append(child);
  }
  getAttribute(name) {
    const v = this.attrs[String(name).toLowerCase()];
    return v === undefined ? null : v;
  }
  setAttribute(name, value) {
    this.attrs[String(name).toLowerCase()] = String(value);
  }
  append(child) {
    if (child == null) return this;
    if (Array.isArray(child)) {
      for (const c of child) this.append(c);
      return this;
    }
    if (typeof child === 'string') {
      if (child) this.childNodes.push(new VText(child));
      return this;
    }
    this.childNodes.push(child);
    return this;
  }
  get children() {
    return this.childNodes.filter((n) => n.nodeType === ELEMENT_NODE);
  }
  get textContent() {
    let out = '';
    for (const child of this.childNodes) out += child.textContent;
    return out;
  }
}

/** Convenience constructors. */
export function el(tagName, attrs, children) { return new VNode(tagName, attrs, children); }
export function txt(value) { return new VText(value); }

/** A detached container whose children are `nodes` — safe input to htmlToMarkdown. */
export function fragment(nodes) { return new VNode('div', {}, nodes); }
