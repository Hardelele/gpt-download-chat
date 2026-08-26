/**
 * dom-scrape.js — claude.ai fallback extraction path (Agent D).
 *
 * Used when the private API is unreachable: 401/403, a shape change, or a
 * `/share/` snapshot page. claude.ai virtualises long transcripts, so we scroll
 * the conversation container to the top until the turn count stops growing
 * before reading anything.
 *
 * The HTML -> Markdown conversion is *not* reimplemented here — it reuses Agent
 * A's converter. Until the orchestrator hoists it into `shared/`, it is imported
 * by relative path (see docs/HANDOFF.md).
 */

import { htmlToMarkdown } from '../../../../extension/src/lib/html2md.js';

/** Selectors that identify a human turn, most specific first. */
export const USER_SELECTORS = [
  '[data-testid="user-message"]',
  'div[data-testid="user-message"]',
  '.font-user-message',
];

/** Selectors that identify an assistant turn, most specific first. */
export const ASSISTANT_SELECTORS = [
  '[data-testid="assistant-message"]',
  '.font-claude-response',
  '.font-claude-message',
];

/** Container that wraps one rendered turn; used to find attachments/labels. */
const TURN_WRAPPER_SELECTORS = [
  'div[data-test-render-count]',
  '[data-testid="chat-message"]',
];

/** Claude's "thinking"/extended-reasoning disclosure inside an assistant turn. */
const THOUGHTS_SELECTORS = [
  '[data-testid="thinking-block"]',
  '[data-testid="thinking"]',
  'details[data-thinking]',
];

const ALL_SELECTORS = USER_SELECTORS.concat(ASSISTANT_SELECTORS);

function qa(root, selector) {
  if (!root || typeof root.querySelectorAll !== 'function') return [];
  try {
    return Array.prototype.slice.call(root.querySelectorAll(selector));
  } catch {
    return [];
  }
}

function q(root, selector) {
  if (!root || typeof root.querySelector !== 'function') return null;
  try {
    return root.querySelector(selector);
  } catch {
    return null;
  }
}

function matches(el, selector) {
  if (!el || typeof el.matches !== 'function') return false;
  try {
    return el.matches(selector);
  } catch {
    return false;
  }
}

/** Drop elements contained by another element in the same list. */
function dedupeNested(elements) {
  return elements.filter((el) => !elements.some(
    (other) => other !== el && typeof other.contains === 'function' && other.contains(el),
  ));
}

/**
 * All message elements in document order.
 * @param {Document|Element} root
 * @returns {Element[]}
 */
export function collectTurns(root) {
  const found = qa(root, ALL_SELECTORS.join(','));
  if (found.length) return dedupeNested(found);
  // Last resort: some builds only tag the render-count wrapper.
  for (const selector of TURN_WRAPPER_SELECTORS) {
    const wrappers = qa(root, selector);
    if (wrappers.length) return dedupeNested(wrappers);
  }
  return [];
}

/**
 * 'user' | 'assistant' for one turn element.
 * @param {Element} el
 */
export function roleOfTurn(el) {
  if (!el) return 'assistant';
  for (const selector of USER_SELECTORS) {
    if (matches(el, selector) || q(el, selector)) return 'user';
  }
  for (const selector of ASSISTANT_SELECTORS) {
    if (matches(el, selector) || q(el, selector)) return 'assistant';
  }
  const cls = (el.getAttribute && el.getAttribute('class')) || '';
  return /user/i.test(cls) ? 'user' : 'assistant';
}

function wrapperOf(el) {
  let node = el;
  let hops = 0;
  while (node && hops < 8) {
    for (const selector of TURN_WRAPPER_SELECTORS) {
      if (matches(node, selector)) return node;
    }
    node = node.parentElement;
    hops += 1;
  }
  return el;
}

function detachThoughts(el) {
  // Extended thinking is rendered inside the assistant turn. Pull it out so it
  // lands on its own contract message with contentType 'thoughts'.
  for (const selector of THOUGHTS_SELECTORS) {
    const node = q(el, selector);
    if (node) return node;
  }
  return null;
}

/**
 * Convert one turn element into contract messages (a turn may yield a thoughts
 * message plus a prose message).
 *
 * @param {Element} el
 * @returns {import('./extract.js').Message[]}
 */
export function turnToMessages(el) {
  if (!el) return [];
  const role = roleOfTurn(el);
  const wrapper = wrapperOf(el);
  const out = [];

  const thoughtsEl = role === 'assistant' ? detachThoughts(el) : null;
  let thoughtsText = '';
  if (thoughtsEl) {
    thoughtsText = String(htmlToMarkdown(thoughtsEl) || '').trim();
    // Remove it from the tree so the prose conversion does not repeat it.
    try {
      if (thoughtsEl.parentNode && typeof thoughtsEl.parentNode.removeChild === 'function') {
        thoughtsEl.parentNode.removeChild(thoughtsEl);
      }
    } catch { /* jsdom-less environments: fall through, duplication is survivable */ }
  }

  const text = String(htmlToMarkdown(el) || '').trim();

  const attachments = qa(wrapper, 'img')
    .map((img) => ({
      type: 'image',
      name: null,
      url: (img.getAttribute && img.getAttribute('src')) || null,
      alt: (img.getAttribute && img.getAttribute('alt')) || null,
    }))
    .filter((a) => a.url
      && !String(a.url).startsWith('data:image/svg')
      && !/\/favicon|logo/i.test(String(a.url)));

  const id = (el.getAttribute && (el.getAttribute('data-message-id') || el.getAttribute('id'))) || null;

  if (thoughtsText) {
    out.push({
      id: id ? `${id}#thoughts` : null,
      role: 'assistant',
      authorName: null,
      createTime: null,
      contentType: 'thoughts',
      text: thoughtsText,
      attachments: [],
      hidden: false,
    });
  }

  if (text || attachments.length) {
    let contentType = 'text';
    if (attachments.length) contentType = 'multimodal';
    else if (/^```[\s\S]*```$/.test(text)) contentType = 'code';
    out.push({
      id,
      role,
      authorName: null,
      createTime: null,
      contentType,
      text,
      attachments,
      hidden: false,
    });
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Virtualised-list handling                                           */
/* ------------------------------------------------------------------ */

const SCROLL_CONTAINER_SELECTORS = [
  '[data-testid="chat-scroll-container"]',
  'main [class*="overflow-y-scroll"]',
  'main [class*="overflow-y-auto"]',
  'div[class*="overflow-y-scroll"]',
  'main',
];

/**
 * Best guess at the element that actually scrolls the transcript.
 * @param {Document} doc
 * @returns {Element|null}
 */
export function findScrollContainer(doc) {
  for (const selector of SCROLL_CONTAINER_SELECTORS) {
    for (const el of qa(doc, selector)) {
      if (el && el.scrollHeight > el.clientHeight + 40) return el;
    }
  }
  const turns = collectTurns(doc);
  let node = turns.length ? turns[0].parentElement : null;
  while (node) {
    if (node.scrollHeight > node.clientHeight + 40) return node;
    node = node.parentElement;
  }
  return doc && doc.scrollingElement ? doc.scrollingElement : null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Scroll to the top repeatedly until the turn count stops growing, so
 * virtualised messages mount. Bounded; pushes a warning if the cap is hit.
 *
 * @param {Document} doc
 * @param {{maxIterations?:number, waitMs?:number, warnings?:string[]}} [opts]
 * @returns {Promise<{turns:number, iterations:number, hitCap:boolean}>}
 */
export async function loadFullTranscript(doc, opts = {}) {
  const maxIterations = opts.maxIterations == null ? 60 : opts.maxIterations;
  const waitMs = opts.waitMs == null ? 250 : opts.waitMs;
  const warnings = opts.warnings || [];
  const container = findScrollContainer(doc);
  let previous = collectTurns(doc).length;
  let stable = 0;
  let iterations = 0;
  let hitCap = false;

  if (!container) {
    warnings.push('Page fallback: could not find the transcript scroll container; '
      + 'only the visible messages were read.');
    return { turns: previous, iterations: 0, hitCap: false };
  }

  const initialScrollTop = container.scrollTop;

  try {
    for (; iterations < maxIterations; iterations++) {
      container.scrollTop = 0;
      if (typeof container.dispatchEvent === 'function' && doc.defaultView && doc.defaultView.Event) {
        try { container.dispatchEvent(new doc.defaultView.Event('scroll')); } catch { /* ignore */ }
      }
      await sleep(waitMs);
      const count = collectTurns(doc).length;
      const atTop = container.scrollTop <= 1;
      if (count === previous) {
        stable += 1;
        if (stable >= 3 && atTop) break;
      } else {
        stable = 0;
      }
      previous = count;
    }
    if (iterations >= maxIterations) {
      hitCap = true;
      warnings.push(
        `Page fallback: stopped after ${maxIterations} scroll attempts; the beginning of a very long `
        + 'conversation may be missing.',
      );
    }
  } catch (err) {
    warnings.push(`Page fallback: scrolling failed (${err && err.message ? err.message : err}); `
      + 'only the mounted part of the conversation was read.');
  }

  try { container.scrollTop = initialScrollTop; } catch { /* ignore */ }
  return { turns: collectTurns(doc).length, iterations, hitCap };
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

export function titleFrom(doc) {
  const heading = q(doc, '[data-testid="chat-menu-trigger"], button[data-testid="chat-menu-trigger"], header h1, main h1');
  const headingText = heading && heading.textContent ? heading.textContent.trim() : '';
  if (headingText && !/^claude$/i.test(headingText)) return headingText;

  const active = q(doc, 'nav a[aria-current="page"], nav [data-active="true"] a');
  const activeText = active && active.textContent ? active.textContent.trim() : '';
  if (activeText) return activeText;

  const docTitle = typeof doc.title === 'string' ? doc.title.trim() : '';
  const cleaned = docTitle.replace(/\s*[|–-]\s*Claude\s*$/i, '').trim();
  if (cleaned && !/^claude$/i.test(cleaned)) return cleaned;

  return 'Claude conversation';
}

/**
 * DOM fallback. Never throws for a recoverable problem — returns a Conversation
 * (possibly with zero messages) and a populated `warnings[]`.
 *
 * @param {{document?:Document, location?:object, conversationId?:string|null,
 *          scroll?:boolean, maxIterations?:number, waitMs?:number}} [opts]
 * @returns {Promise<import('./extract.js').Conversation>}
 */
export async function scrapeConversation(opts = {}) {
  const doc = opts.document || (typeof globalThis !== 'undefined' ? globalThis.document : null);
  const loc = opts.location
    || (doc && doc.defaultView && doc.defaultView.location)
    || (typeof globalThis !== 'undefined' ? globalThis.location : null)
    || { href: '' };

  const warnings = ['Claude\'s conversation API was unavailable — this transcript was read from the '
    + 'page. Timestamps, the model name and artifact source may be incomplete.'];

  const base = {
    id: opts.conversationId ? String(opts.conversationId) : 'unknown',
    title: 'Claude conversation',
    createTime: null,
    updateTime: null,
    model: null,
    sourceUrl: loc.href || '',
    extractedVia: 'dom',
    messages: [],
    warnings,
  };

  if (!doc) {
    warnings.push('Page fallback: no document available.');
    return base;
  }

  if (opts.scroll !== false) {
    await loadFullTranscript(doc, {
      warnings,
      maxIterations: opts.maxIterations,
      waitMs: opts.waitMs,
    });
  }

  const messages = [];
  for (const turn of collectTurns(doc)) {
    try {
      messages.push(...turnToMessages(turn));
    } catch (err) {
      warnings.push(`Page fallback: failed to convert one message (${err && err.message ? err.message : err}).`);
    }
  }

  if (!messages.length) warnings.push('Page fallback: no conversation turns found on the page.');

  base.title = titleFrom(doc);
  base.messages = messages;
  return base;
}

export default scrapeConversation;
