/**
 * dom-scrape.js — fallback extraction path (Agent A).
 *
 * Used when the backend API is unavailable: logged-out session, 401/403, a
 * `/share/` page, or a Cloudflare interstitial. ChatGPT virtualises the message
 * list, so we scroll the transcript container to the top until the turn count
 * stops growing before reading anything.
 *
 * Pure helpers (`turnToMessage`, `collectTurns`) take nodes/documents and are
 * unit-testable; nothing here touches `document` at module load time.
 */

import { htmlToMarkdown } from './html2md.js';

export const TURN_SELECTORS = [
  'article[data-testid^="conversation-turn-"]',
  '[data-testid^="conversation-turn-"]',
  'div[data-testid^="conversation-turn-"]',
  '[data-message-author-role]',
];

const BODY_SELECTORS = [
  '.markdown',
  '.prose',
  '[data-message-content]',
  '.whitespace-pre-wrap',
  '.text-message',
];

const ROLES = new Set(['user', 'assistant', 'system', 'tool']);

function q(root, selector) {
  return root && typeof root.querySelector === 'function' ? root.querySelector(selector) : null;
}

function qa(root, selector) {
  if (!root || typeof root.querySelectorAll !== 'function') return [];
  return Array.prototype.slice.call(root.querySelectorAll(selector));
}

/**
 * Find the conversation turn elements in a document, trying selectors in order
 * and keeping the first that yields anything.
 * @param {Document|Element} root
 * @returns {Element[]}
 */
export function collectTurns(root) {
  for (const selector of TURN_SELECTORS) {
    const found = qa(root, selector);
    if (found.length) return dedupeNested(found);
  }
  return [];
}

/** Drop elements that are descendants of another element in the list. */
function dedupeNested(elements) {
  return elements.filter((el) => !elements.some(
    (other) => other !== el && typeof other.contains === 'function' && other.contains(el),
  ));
}

function roleOf(turn) {
  const direct = turn.getAttribute && turn.getAttribute('data-message-author-role');
  if (direct && ROLES.has(direct)) return direct;
  const inner = q(turn, '[data-message-author-role]');
  const attrRole = inner && inner.getAttribute('data-message-author-role');
  if (attrRole && ROLES.has(attrRole)) return attrRole;
  // Last resort: ChatGPT tags user turns with a specific bubble class.
  const cls = (turn.getAttribute && turn.getAttribute('class')) || '';
  if (/user-message|from-user/.test(cls)) return 'user';
  if (q(turn, '.user-message-bubble-color, [data-message-author-role="user"]')) return 'user';
  return 'assistant';
}

function idOf(turn) {
  const direct = turn.getAttribute && turn.getAttribute('data-message-id');
  if (direct) return direct;
  const inner = q(turn, '[data-message-id]');
  const attrId = inner && inner.getAttribute('data-message-id');
  return attrId || null;
}

function bodyOf(turn) {
  const holder = q(turn, '[data-message-author-role]') || turn;
  for (const selector of BODY_SELECTORS) {
    const el = q(holder, selector);
    if (el) return el;
  }
  return holder;
}

/**
 * Convert one turn element into a contract `Message`.
 * @param {Element} turn
 * @returns {import('./extract.js').Message|null}
 */
export function turnToMessage(turn) {
  if (!turn) return null;
  const role = roleOf(turn);
  const body = bodyOf(turn);
  const text = htmlToMarkdown(body).trim();
  const attachments = qa(body, 'img')
    .map((img) => ({
      type: 'image',
      name: null,
      url: (img.getAttribute && img.getAttribute('src')) || null,
      alt: (img.getAttribute && img.getAttribute('alt')) || null,
    }))
    .filter((a) => a.url && !String(a.url).startsWith('data:image/svg'));

  if (!text && attachments.length === 0) return null;

  let contentType = 'text';
  if (attachments.length) contentType = 'multimodal';
  if (/^```/.test(text) && /```$/.test(text)) contentType = 'code';

  return {
    id: idOf(turn),
    role,
    authorName: role === 'tool' ? 'tool' : null,
    createTime: null,
    contentType,
    text,
    attachments,
    hidden: role === 'system',
  };
}

/* ------------------------------------------------------------------ */
/* Virtualised-list handling                                           */
/* ------------------------------------------------------------------ */

const SCROLL_CONTAINER_SELECTORS = [
  '[class*="react-scroll-to-bottom"] > div',
  'main [class*="overflow-y-auto"]',
  'main div.flex-1.overflow-hidden > div',
  '#thread',
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
 * Scroll the transcript to the top repeatedly until the turn count stops
 * growing, so virtualised messages get mounted.
 *
 * @param {Document} doc
 * @param {{maxIterations?:number, waitMs?:number, warnings?:string[]}} [opts]
 * @returns {Promise<{turns:number, iterations:number, hitCap:boolean}>}
 */
export async function loadFullTranscript(doc, opts = {}) {
  const maxIterations = opts.maxIterations == null ? 60 : opts.maxIterations;
  const waitMs = opts.waitMs == null ? 220 : opts.waitMs;
  const warnings = opts.warnings || [];
  const container = findScrollContainer(doc);
  let previous = collectTurns(doc).length;
  let stable = 0;
  let iterations = 0;
  let hitCap = false;

  if (!container) {
    warnings.push('DOM fallback: could not find the transcript scroll container; only visible messages were read.');
    return { turns: previous, iterations: 0, hitCap: false };
  }

  const initialScrollTop = container.scrollTop;

  try {
    for (; iterations < maxIterations; iterations++) {
      container.scrollTop = 0;
      if (typeof container.dispatchEvent === 'function' && typeof doc.defaultView !== 'undefined') {
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
        `DOM fallback: stopped after ${maxIterations} scroll attempts; the beginning of a very long `
        + 'conversation may be missing.',
      );
    }
  } catch (err) {
    warnings.push(`DOM fallback: scrolling failed (${err && err.message ? err.message : err}); `
      + 'only the mounted part of the conversation was read.');
  }

  try { container.scrollTop = initialScrollTop; } catch { /* ignore */ }
  return { turns: collectTurns(doc).length, iterations, hitCap };
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

function titleFrom(doc, loc) {
  const heading = q(doc, 'h1, [data-testid="conversation-title"]');
  const headingText = heading && heading.textContent ? heading.textContent.trim() : '';
  if (headingText && headingText.toLowerCase() !== 'chatgpt') return headingText;

  const active = q(doc, 'nav a[aria-current="page"], nav li[data-active] a, a[data-active]');
  const activeText = active && active.textContent ? active.textContent.trim() : '';
  if (activeText) return activeText;

  const docTitle = typeof doc.title === 'string' ? doc.title.trim() : '';
  const cleaned = docTitle.replace(/\s*[|-]\s*ChatGPT\s*$/i, '').trim();
  if (cleaned && cleaned.toLowerCase() !== 'chatgpt') return cleaned;

  void loc;
  return 'ChatGPT conversation';
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
  const doc = opts.document
    || (typeof globalThis !== 'undefined' ? globalThis.document : null);
  const loc = opts.location
    || (doc && doc.defaultView && doc.defaultView.location)
    || (typeof globalThis !== 'undefined' ? globalThis.location : null)
    || { href: '' };
  const warnings = ['Backend API unavailable — this transcript was scraped from the page. '
    + 'Timestamps and the model name may be missing.'];

  if (!doc) {
    return emptyConversation(opts.conversationId, loc, warnings.concat('DOM fallback: no document available.'));
  }

  if (opts.scroll !== false) {
    await loadFullTranscript(doc, {
      warnings,
      maxIterations: opts.maxIterations,
      waitMs: opts.waitMs,
    });
  }

  const turns = collectTurns(doc);
  const messages = [];
  for (const turn of turns) {
    let msg = null;
    try {
      msg = turnToMessage(turn);
    } catch (err) {
      warnings.push(`DOM fallback: failed to convert one message (${err && err.message ? err.message : err}).`);
    }
    if (msg) messages.push(msg);
  }

  if (!messages.length) warnings.push('DOM fallback: no conversation turns found on the page.');

  const conversationId = opts.conversationId || null;
  return {
    id: conversationId ? String(conversationId) : 'unknown',
    title: titleFrom(doc, loc),
    createTime: null,
    updateTime: null,
    model: null,
    sourceUrl: loc.href || '',
    extractedVia: 'dom',
    messages,
    warnings,
  };
}

function emptyConversation(conversationId, loc, warnings) {
  return {
    id: conversationId ? String(conversationId) : 'unknown',
    title: 'ChatGPT conversation',
    createTime: null,
    updateTime: null,
    model: null,
    sourceUrl: (loc && loc.href) || '',
    extractedVia: 'dom',
    messages: [],
    warnings,
  };
}
