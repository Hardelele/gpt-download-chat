/**
 * gemini-dom.js — pure parsing layer for gemini.google.com (Agent E).
 *
 * WHY THE DOM AND NOT AN API
 * --------------------------
 * ChatGPT and Claude both expose a same-origin JSON conversation endpoint that
 * an extension can call with the user's own session. Gemini does not. The
 * consumer app is driven by `/_/BardChatUi/data/batchexecute`, a Google RPC
 * envelope whose payloads are positional arrays inside a doubly-encoded JSON
 * string, keyed by rotating per-build request ids (`f.req`, `rpcids`, `bl`,
 * `at`). Every open-source Gemini exporter that survives more than a release
 * cycle scrapes the DOM instead. So here the DOM is the *primary* path, not a
 * fallback, and `extractedVia` is always `'dom'`. See docs/HANDOFF.md.
 *
 * EVERYTHING IN THIS FILE IS PURE.
 * It takes DOM-like nodes (real DOM, `parseHTML()` fakes, or `VNode`s) and
 * returns plain data. No `document`, no `window`, no timers — that lives in
 * `extract.js`. This is what makes the parsing unit-testable under plain Node.
 */

import {
  tagOf, attrOf, hasClassLike, childNodesOf, textOf,
  findAll, findFirst, byTag, firstByTag, firstByClassLike,
  el, txt, fragment, VNode, VText, ELEMENT_NODE, TEXT_NODE,
} from './dom-util.js';
import { htmlToMarkdown } from '../../../../extension/src/lib/html2md.js';

/** Emitted in place of an image a Markdown reader could never fetch. */
export const NOT_EXPORTABLE_IMAGE = '*(image — not exportable)*';

/* ------------------------------------------------------------------ */
/* Drop lists                                                          */
/* ------------------------------------------------------------------ */

/**
 * Custom elements that are pure UI chrome. Angular Material ligature icons
 * (`<mat-icon>content_copy</mat-icon>`) are the nastiest of these: their text
 * content looks like real prose to a naive walker.
 */
const DROP_TAGS = new Set([
  'mat-icon', 'mat-ripple', 'mat-tooltip', 'mat-progress-bar', 'mat-spinner',
  'mat-menu', 'mat-slide-toggle', 'mat-form-field', 'mat-bottom-sheet',
  'message-footer', 'model-response-footer', 'user-query-footer',
  'sources-carousel', 'sources-carousel-inline', 'sources-list',
  'hallucination-disclaimer', 'sensitive-memories-banner',
  'thumbs-up-down', 'feedback-buttons', 'share-button', 'export-button',
  'response-element-footer', 'toolbelt', 'attachment-container-actions',
  'sources-carousel-tooltip', 'cdk-visually-hidden',
  // aistudio.google.com chrome
  'ms-chat-turn-options', 'ms-turn-footer', 'ms-token-count', 'ms-run-button',
]);

/** Class-name substrings that mark UI chrome rather than content. */
const DROP_CLASS_LIKE = [
  'visually-hidden', 'cdk-visually-hidden', 'sr-only', 'screen-reader',
  'mat-ripple', 'mat-mdc-tooltip', 'mat-mdc-focus-indicator',
  'response-footer', 'actions-container', 'buttons-container',
  'thumbs-container', 'avatar', 'sources-carousel', 'attribution-container',
  'code-block-decoration', 'disclaimer',
];

/**
 * Strings that are interface labels, never content. Checked case-insensitively
 * against the *whole trimmed* text of a candidate node, so a code block that
 * genuinely says "copy" on its own line is the only false positive, and that
 * is a price worth paying.
 */
const UI_LABELS = new Set([
  'copy code', 'copy', 'copied', 'copied!', 'copy to clipboard', 'content_copy',
  'edit', 'edit code', 'run', 'run code', 'download', 'download code',
  'expand', 'collapse', 'expand_more', 'expand_less', 'more_vert',
  'wrap lines', 'unwrap lines', 'open in colab', 'open_in_new',
  'use code with caution', 'show more', 'show less', 'show thinking',
  'hide thinking', 'show drafts', 'thinking', 'gemini said', 'you said',
  'копировать код', 'копировать', 'скопировано', 'показать ещё',
]);

function isUiLabel(text) {
  const t = String(text).trim().toLowerCase().replace(/[.:•]+$/, '');
  if (!t) return true;
  if (UI_LABELS.has(t)) return true;
  // "Use code with caution. Python" — the caution footer with a language suffix.
  return /^use code with caution\b/.test(t);
}

function shouldDrop(node) {
  const t = tagOf(node);
  if (!t) return false;
  if (DROP_TAGS.has(t)) return true;
  if (t === 'button') return true;
  for (const needle of DROP_CLASS_LIKE) if (hasClassLike(node, needle)) return true;
  return false;
}

/* ------------------------------------------------------------------ */
/* Attribute whitelist                                                 */
/* ------------------------------------------------------------------ */

const KEEP_ATTRS = ['href', 'src', 'alt', 'title', 'start', 'encoding', 'display', 'data-language'];
const KEEP_CLASS_RE = /^(language-|lang-|highlight-|katex|math$|math-)/;

function keptClass(node) {
  const raw = attrOf(node, 'class');
  if (typeof raw !== 'string' || !raw) return null;
  const kept = raw.split(/\s+/).filter((c) => c && KEEP_CLASS_RE.test(c));
  return kept.length ? kept.join(' ') : null;
}

function cloneAttrs(node) {
  const attrs = {};
  for (const name of KEEP_ATTRS) {
    const v = attrOf(node, name);
    if (v != null && v !== '') attrs[name] = v;
  }
  const cls = keptClass(node);
  if (cls) attrs.class = cls;
  if (attrOf(node, 'aria-hidden') === 'true') attrs['aria-hidden'] = 'true';
  return attrs;
}

/* ------------------------------------------------------------------ */
/* Images                                                              */
/* ------------------------------------------------------------------ */

/**
 * Can a plain Markdown reader resolve this URL later, outside the browser?
 * `blob:`/`filesystem:` die with the tab. `data:` technically works but turns
 * a .md file into megabytes of base64. Scheme-less paths only resolve against
 * gemini.google.com with the user's cookies.
 */
export function isExportableImageUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const u = url.trim();
  if (!u) return false;
  if (/^(blob:|filesystem:|data:|about:|javascript:)/i.test(u)) return false;
  return /^https?:\/\//i.test(u);
}

function filenameFromUrl(url) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  try {
    const path = url.split('?')[0].split('#')[0];
    const last = path.split('/').filter(Boolean).pop();
    return last && /\.[a-z0-9]{2,5}$/i.test(last) ? decodeURIComponent(last) : null;
  } catch { return null; }
}

/** Decorative chrome shipped as an <img>, not user content. */
function isDecorativeImage(node) {
  const src = attrOf(node, 'src') || '';
  if (/^data:image\/svg/i.test(src)) return true;
  if (/\.svg(\?|#|$)/i.test(src)) return true;
  if (hasClassLike(node, 'avatar') || hasClassLike(node, 'icon')) return true;
  return false;
}

/* ------------------------------------------------------------------ */
/* Code blocks                                                         */
/* ------------------------------------------------------------------ */

/** Collect text from a subtree, skipping UI chrome (buttons, mat-icons, …). */
function contentText(node) {
  if (!node) return '';
  if (node.nodeType === TEXT_NODE) return node.nodeValue == null ? textOf(node) : node.nodeValue;
  if (node.nodeType !== ELEMENT_NODE) return '';
  if (shouldDrop(node)) return '';
  let out = '';
  for (const kid of childNodesOf(node)) out += contentText(kid);
  return out;
}

/**
 * Language label for a Gemini `<code-block>`. It lives in the header bar
 * (`div.code-block-decoration > span`), right next to the "Copy code" button
 * whose text must never reach the output.
 * @returns {string} lowercase language, or ''
 */
export function codeBlockLanguage(codeBlock) {
  const codeEl = firstByTag(codeBlock, 'code');
  // 1. a real `language-xxx` class, if Gemini ever grows one.
  for (const probe of [codeEl, firstByTag(codeBlock, 'pre'), codeBlock]) {
    if (!probe) continue;
    const cls = attrOf(probe, 'class') || '';
    const m = cls.match(/(?:language|lang|highlight)-([A-Za-z0-9+#._-]+)/);
    if (m) return m[1].toLowerCase();
    const dl = attrOf(probe, 'data-language');
    if (dl) return String(dl).toLowerCase();
  }
  // 2. the header bar.
  const headers = findAll(codeBlock, (n) => hasClassLike(n, 'code-block-decoration'));
  const candidates = [];
  for (const header of headers) candidates.push(header);
  if (!headers.length) {
    // Degraded shape: scan element children that are not the <pre>/<code>.
    for (const kid of childNodesOf(codeBlock)) {
      if (kid.nodeType !== ELEMENT_NODE) continue;
      const t = tagOf(kid);
      if (t === 'pre' || t === 'code') continue;
      candidates.push(kid);
    }
  }
  for (const cand of candidates) {
    const pieces = [contentText(cand)].concat(
      findAll(cand, byTag('span', 'div', 'p')).map(contentText),
    );
    for (const piece of pieces) {
      const t = String(piece).trim();
      if (!t || isUiLabel(t)) continue;
      if (/^[A-Za-z0-9+#._-]{1,24}$/.test(t)) return t.toLowerCase();
    }
  }
  return '';
}

/** `<code-block>` → a plain `<pre><code class="language-x">` VNode. */
export function rewriteCodeBlock(codeBlock) {
  const lang = codeBlockLanguage(codeBlock);
  const codeEl = firstByTag(codeBlock, 'code');
  const preEl = firstByTag(codeBlock, 'pre');
  let code = codeEl ? textOf(codeEl) : (preEl ? textOf(preEl) : contentText(codeBlock));
  code = String(code).replace(/^\n+/, '').replace(/\s+$/, '');
  // Belt and braces: strip a leaked chrome line from either end.
  const lines = code.split('\n');
  while (lines.length && isUiLabel(lines[0])) lines.shift();
  while (lines.length && isUiLabel(lines[lines.length - 1])) lines.pop();
  code = lines.join('\n');
  const attrs = lang ? { class: `language-${lang}` } : {};
  return el('pre', {}, [el('code', attrs, [txt(code)])]);
}

/* ------------------------------------------------------------------ */
/* Sanitizer: page DOM → clean VNode tree                              */
/* ------------------------------------------------------------------ */

/** Custom elements are unwrapped (children spliced in) rather than dropped. */
function isCustomElement(tag) {
  return tag.includes('-');
}

/**
 * @typedef {Object} SanitizeCtx
 * @property {Attachment[]} attachments
 * @property {Set<string>}  warnings
 * @property {boolean}      dropThoughts
 */

function newCtx(options = {}) {
  return {
    attachments: [],
    warnings: new Set(),
    dropThoughts: options.dropThoughts !== false,
  };
}

/**
 * @param {*} node        DOM-like node
 * @param {SanitizeCtx} ctx
 * @returns {VNode|VText|Array<VNode|VText>|null}
 */
function sanitizeNode(node, ctx) {
  if (!node) return null;
  if (node.nodeType === TEXT_NODE) {
    const value = node.nodeValue == null ? textOf(node) : node.nodeValue;
    return value ? new VText(value) : null;
  }
  if (node.nodeType !== ELEMENT_NODE) return null;

  const tag = tagOf(node);
  if (shouldDrop(node)) return null;
  if (ctx.dropThoughts && isThoughtsNode(node)) return null;
  if (tag === 'code-block' || hasClassLike(node, 'code-block')) return rewriteCodeBlock(node);

  if (tag === 'img') {
    if (isDecorativeImage(node)) return null;
    const src = attrOf(node, 'src') || attrOf(node, 'data-src') || '';
    const alt = (attrOf(node, 'alt') || '').trim();
    ctx.attachments.push({
      type: 'image',
      name: alt || filenameFromUrl(src) || null,
      url: src || null,
      alt: alt || null,
    });
    if (!isExportableImageUrl(src)) {
      ctx.warnings.add('One or more images use in-browser (blob/data) URLs and cannot be linked from the Markdown file.');
      return el('p', {}, [txt(NOT_EXPORTABLE_IMAGE)]);
    }
    return el('img', { src, alt: alt || null });
  }

  const kids = [];
  for (const kid of childNodesOf(node)) {
    const out = sanitizeNode(kid, ctx);
    if (out == null) continue;
    if (Array.isArray(out)) kids.push(...out);
    else kids.push(out);
  }

  // Unknown custom element: splice its children into the parent so that an
  // inline chip stays inline and a block wrapper stays block.
  if (isCustomElement(tag)) return kids;
  return new VNode(tag, cloneAttrs(node), kids);
}

/**
 * Sanitize a Gemini content subtree and render it through Agent A's shared
 * `htmlToMarkdown()`. This module deliberately contains no second converter.
 *
 * @param {*} node
 * @param {{dropThoughts?: boolean}} [options]
 * @returns {{markdown: string, attachments: Array, warnings: string[]}}
 */
export function nodeToMarkdown(node, options = {}) {
  const ctx = newCtx(options);
  const out = sanitizeNode(node, ctx);
  const list = out == null ? [] : (Array.isArray(out) ? out : [out]);
  const markdown = htmlToMarkdown(fragment(list));
  return { markdown, attachments: ctx.attachments, warnings: Array.from(ctx.warnings) };
}

/* ------------------------------------------------------------------ */
/* Turn recognition                                                    */
/* ------------------------------------------------------------------ */

export function isUserQueryNode(node) {
  const t = tagOf(node);
  if (t === 'user-query') return true;
  return hasClassLike(node, 'user-query-container') || hasClassLike(node, 'query-content');
}

export function isModelResponseNode(node) {
  const t = tagOf(node);
  if (t === 'model-response') return true;
  return hasClassLike(node, 'model-response-container');
}

export function isThoughtsNode(node) {
  const t = tagOf(node);
  if (t === 'model-thoughts' || t === 'ms-thought-chunk') return true;
  return hasClassLike(node, 'model-thoughts') || hasClassLike(node, 'thoughts-content');
}

export function isConversationContainer(node) {
  return hasClassLike(node, 'conversation-container');
}

function idOf(node) {
  return attrOf(node, 'id') || attrOf(node, 'data-message-id') || attrOf(node, 'data-test-id') || null;
}

function classifyContent(markdown, attachments) {
  if (attachments && attachments.length) return 'multimodal';
  const t = String(markdown || '').trim();
  if (!t) return 'other';
  const fences = t.match(/```/g);
  if (t.startsWith('```') && t.endsWith('```') && fences && fences.length === 2) return 'code';
  return 'text';
}

/** @returns {{message: Message|null, warnings: string[]}} */
export function parseUserQuery(node) {
  const warnings = [];
  let body = firstByClassLike(node, 'query-text');
  if (!body) body = firstByTag(node, 'user-query-content');
  if (!body) {
    body = node;
    warnings.push('User turn: no .query-text / <user-query-content> found; fell back to the whole turn element (Gemini markup may have changed).');
  }
  const { markdown, attachments, warnings: w } = nodeToMarkdown(body);
  warnings.push(...w);

  // File chips ("report.pdf") are rendered as previews, not <img>.
  for (const chip of findAll(node, byTag('user-query-file-preview', 'file-preview'))) {
    const name = contentText(chip).trim().split('\n')[0].trim();
    if (name && !isUiLabel(name)) {
      attachments.push({ type: 'file', name, url: null, alt: null });
    }
  }

  const text = markdown.trim();
  if (!text && !attachments.length) return { message: null, warnings };
  return {
    message: {
      id: idOf(node),
      role: 'user',
      authorName: null,
      createTime: null,
      contentType: classifyContent(text, attachments),
      text,
      attachments,
      hidden: false,
    },
    warnings,
  };
}

/** @returns {{messages: Message[], warnings: string[]}} */
export function parseModelResponse(node) {
  const warnings = [];
  const messages = [];

  // 1. "Show thinking" panel → a hidden 'thoughts' message, emitted first.
  const thoughtsNode = findFirst(node, isThoughtsNode);
  if (thoughtsNode) {
    const inner = firstByClassLike(thoughtsNode, 'thoughts-content')
      || firstByClassLike(thoughtsNode, 'markdown')
      || thoughtsNode;
    const t = nodeToMarkdown(inner, { dropThoughts: false });
    warnings.push(...t.warnings);
    const thoughtText = t.markdown.trim();
    if (thoughtText && !isUiLabel(thoughtText)) {
      messages.push({
        id: idOf(thoughtsNode),
        role: 'assistant',
        authorName: null,
        createTime: null,
        contentType: 'thoughts',
        text: thoughtText,
        attachments: t.attachments,
        hidden: true,
      });
    }
  }

  // 2. The answer body.
  let body = null;
  const messageContent = firstByTag(node, 'message-content');
  if (messageContent) {
    body = firstByClassLike(messageContent, 'markdown') || messageContent;
  } else {
    body = firstByClassLike(node, 'markdown')
      || firstByClassLike(node, 'response-content')
      || null;
  }
  if (!body) {
    body = node;
    warnings.push('Assistant turn: no <message-content>/.markdown container found; fell back to the whole response element (Gemini markup may have changed).');
  }

  const { markdown, attachments, warnings: w } = nodeToMarkdown(body, { dropThoughts: true });
  warnings.push(...w);
  const text = markdown.trim();
  if (text || attachments.length) {
    messages.push({
      id: idOf(node),
      role: 'assistant',
      authorName: null,
      createTime: null,
      contentType: classifyContent(text, attachments),
      text,
      attachments,
      hidden: false,
    });
  }
  return { messages, warnings };
}

/**
 * Walk a Gemini chat root and produce chronological messages.
 *
 * Resilience: turns are found by *element name* (`user-query` /
 * `model-response`), which are Angular component selectors and far more stable
 * than the hashed utility classes around them. `.conversation-container` is
 * only used as a sanity signal, so a rename of that class degrades the export
 * to a warning rather than to an empty file.
 *
 * @param {*} root
 * @returns {{messages: Message[], warnings: string[], turnCount: number}}
 */
export function parseGeminiTurns(root) {
  const warnings = [];
  const messages = [];
  const containers = findAll(root, isConversationContainer);
  const turns = findAll(root, (n) => isUserQueryNode(n) || isModelResponseNode(n));

  if (!turns.length) {
    warnings.push('No <user-query>/<model-response> elements were found in the page. Gemini\'s markup has probably changed, or the conversation had not finished loading.');
    return { messages, warnings, turnCount: containers.length };
  }
  if (!containers.length) {
    warnings.push('No .conversation-container wrappers found; turns were paired by document order instead.');
  }

  // Skip a nested match (e.g. a `model-response` re-rendered inside another).
  const seen = new Set();
  for (const turn of turns) {
    if (seen.has(turn)) continue;
    seen.add(turn);
    if (isUserQueryNode(turn)) {
      const r = parseUserQuery(turn);
      pushWarnings(warnings, r.warnings);
      if (r.message) messages.push(r.message);
    } else {
      const r = parseModelResponse(turn);
      pushWarnings(warnings, r.warnings);
      messages.push(...r.messages);
    }
  }
  return { messages, warnings, turnCount: containers.length || turns.length };
}

function pushWarnings(sink, incoming) {
  for (const w of incoming) if (!sink.includes(w)) sink.push(w);
}

/* ------------------------------------------------------------------ */
/* Metadata                                                            */
/* ------------------------------------------------------------------ */

/** `https://gemini.google.com/u/0/app/abc123?x=1` → `abc123`. */
export function conversationIdFromUrl(url) {
  if (!url) return 'unknown';
  const m = String(url).match(/\/(?:app|chat)\/([A-Za-z0-9_-]{4,})/);
  if (m) return m[1];
  const p = String(url).match(/\/prompts\/([A-Za-z0-9_-]{4,})/);
  if (p) return p[1];
  return 'unknown';
}

/** Best-effort chat title from the sidebar / document title. */
export function pickTitle(root, documentTitle) {
  const selected = findFirst(root, (n) => (
    hasClassLike(n, 'conversation') && hasClassLike(n, 'selected')
  ));
  if (selected) {
    const t = contentText(firstByClassLike(selected, 'conversation-title') || selected).trim();
    if (t && !isUiLabel(t)) return t.replace(/\s+/g, ' ').slice(0, 200);
  }
  const raw = String(documentTitle || '').trim();
  const cleaned = raw
    .replace(/\s*[-–—|]\s*Gemini\s*$/i, '')
    .replace(/\s*[-–—|]\s*Google AI Studio\s*$/i, '')
    .trim();
  if (cleaned && !/^(gemini|google ai studio)$/i.test(cleaned)) {
    return cleaned.replace(/\s+/g, ' ').slice(0, 200);
  }
  return '';
}

/** Best-effort model name from the mode switcher. */
export function pickModel(root) {
  const probes = [
    (n) => tagOf(n) === 'bard-mode-switcher',
    (n) => attrOf(n, 'data-test-id') === 'bard-mode-menu-button',
    (n) => hasClassLike(n, 'mode-title'),
    (n) => hasClassLike(n, 'current-mode-title'),
    (n) => tagOf(n) === 'ms-model-selector',
    (n) => hasClassLike(n, 'model-option-content'),
  ];
  for (const probe of probes) {
    const node = findFirst(root, probe);
    if (!node) continue;
    const t = contentText(node).replace(/\s+/g, ' ').trim();
    if (t && !isUiLabel(t) && t.length <= 60) return t;
  }
  return null;
}

export { contentText, isUiLabel };
