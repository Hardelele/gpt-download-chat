/**
 * dom-scrape.js — fallback extraction path (Agent A).
 *
 * Used only when the backend API is unreachable: logged out, a hard 401/403 that
 * even cookies cannot satisfy, or a Cloudflare interstitial.
 *
 * THE CENTRAL PROBLEM, measured on a live 101-message conversation:
 * only ~7 turns exist in the DOM at rest, and they are not contiguous
 * (turn-2, turn-4, turn-12, turn-13, …). Scrolling to the top does not fix this
 * — it unmounts the bottom of the transcript while mounting the top. There is no
 * moment at which the whole conversation is in the document, so "scroll, then
 * read" cannot work by construction.
 *
 * So we HARVEST: sweep the scroll container from top to bottom and convert each
 * turn to Markdown at the moment it is mounted, keyed by `data-turn-id`, then
 * reassemble in turn-index order. Whatever we still miss is reported loudly —
 * a silently truncated export is the single worst failure mode in this category.
 *
 * Pure helpers are exported separately from the browser-touching entry points so
 * they can be unit-tested; nothing here touches `document` at module load time.
 */

import { htmlToMarkdown } from './html2md.js';
import { sanitizeText } from './api-client.js';

/**
 * Turn containers, most specific first. The current build renders
 * `<section data-testid="conversation-turn-N" data-turn="user|assistant"
 * data-turn-id="<uuid>">`; `<article>` and `.markdown` are gone. The later
 * entries keep older builds (and share pages) working.
 */
export const TURN_SELECTORS = [
  'section[data-testid^="conversation-turn-"]',
  '[data-testid^="conversation-turn-"]',
  '[data-turn-id]',
  'article[data-testid^="conversation-turn-"]',
  '[data-message-author-role]',
];

/**
 * Message body, most specific first. Assistant turns in the current build have
 * no stable class at all — the text sits under hashed CSS-module wrappers
 * (`fKQ0lq_Layout`, `WlXitW_TransitionGroupChild`) that must never be relied on,
 * so those fall through to `deepestTextContainer()`.
 */
const BODY_SELECTORS = [
  '.markdown',
  '.prose',
  '[data-message-content]',
  '.text-message',
  '.whitespace-pre-wrap',
];

const ROLES = new Set(['user', 'assistant', 'system', 'tool']);

/* ------------------------------------------------------------------ */
/* DOM helpers (work on real and fake nodes alike)                     */
/* ------------------------------------------------------------------ */

function q(root, selector) {
  return root && typeof root.querySelector === 'function' ? root.querySelector(selector) : null;
}

function qa(root, selector) {
  if (!root || typeof root.querySelectorAll !== 'function') return [];
  try { return Array.prototype.slice.call(root.querySelectorAll(selector)); } catch { return []; }
}

function attr(node, name) {
  if (!node || node.nodeType !== 1 || typeof node.getAttribute !== 'function') return null;
  return node.getAttribute(name);
}

function tag(node) {
  if (!node || node.nodeType !== 1) return '';
  return String(node.tagName || node.nodeName || '').toLowerCase();
}

function classesOf(node) {
  const c = attr(node, 'class');
  return typeof c === 'string' ? c.split(/\s+/) : [];
}

function textOf(node) {
  return node && typeof node.textContent === 'string' ? node.textContent : '';
}

function elementChildren(node) {
  if (!node || !node.childNodes) return [];
  return Array.prototype.slice.call(node.childNodes).filter((n) => n && n.nodeType === 1);
}

/** Screen-reader labels, icons and buttons: never part of the transcript. */
function isIgnorable(node) {
  if (!node || node.nodeType !== 1) return true;
  const t = tag(node);
  if (t === 'button' || t === 'svg' || t === 'script' || t === 'style' || t === 'noscript') return true;
  if (attr(node, 'aria-hidden') === 'true') return true;
  const classes = classesOf(node);
  return classes.includes('sr-only') || classes.includes('visually-hidden');
}

/** Text content with screen-reader / button noise removed. */
function contentText(node) {
  if (!node) return '';
  if (node.nodeType === 3) return textOf(node);
  if (isIgnorable(node)) return '';
  if (!node.childNodes || node.childNodes.length === 0) return textOf(node);
  let out = '';
  for (const child of Array.prototype.slice.call(node.childNodes)) out += contentText(child);
  return out;
}

const measure = (node) => contentText(node).replace(/\s+/g, ' ').trim().length;

/* ------------------------------------------------------------------ */
/* Turn discovery                                                      */
/* ------------------------------------------------------------------ */

/**
 * Find turn elements, trying selectors in priority order and keeping the first
 * that yields anything.
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

function dedupeNested(elements) {
  return elements.filter((el) => !elements.some(
    (other) => other !== el && typeof other.contains === 'function' && other.contains(el),
  ));
}

/**
 * Stable identity for a turn, so the same message harvested twice at different
 * scroll positions is not duplicated.
 * @param {Element} turn
 * @returns {string|null}
 */
export function turnKey(turn) {
  const id = attr(turn, 'data-turn-id')
    || attr(turn, 'data-message-id')
    || (q(turn, '[data-message-id]') && attr(q(turn, '[data-message-id]'), 'data-message-id'));
  if (id) return `id:${id}`;
  const testid = attr(turn, 'data-testid');
  return testid ? `testid:${testid}` : null;
}

/**
 * The N in `conversation-turn-N`, used to detect what we failed to capture.
 * @param {Element} turn
 * @returns {number|null}
 */
export function turnIndex(turn) {
  const testid = attr(turn, 'data-testid') || '';
  const m = String(testid).match(/conversation-turn-(\d+)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Speaker for a turn. `data-turn` is the current source of truth; the legacy
 * `[data-message-author-role]` is the fallback.
 *
 * The `h4.sr-only` label inside each turn ("ChatGPT said:" / "ChatGPT сказал:")
 * is LOCALISED — parsing it works in English and silently mislabels every other
 * locale, so it is never used for the role, only as a presence signal.
 *
 * @param {Element} turn
 * @returns {'user'|'assistant'|'system'|'tool'|null} null when genuinely unknown
 */
export function roleOf(turn) {
  const dataTurn = attr(turn, 'data-turn');
  if (dataTurn && ROLES.has(dataTurn)) return dataTurn;

  const direct = attr(turn, 'data-message-author-role');
  if (direct && ROLES.has(direct)) return direct;

  const inner = q(turn, '[data-message-author-role]');
  const innerRole = inner && attr(inner, 'data-message-author-role');
  if (innerRole && ROLES.has(innerRole)) return innerRole;

  const nested = q(turn, '[data-turn]');
  const nestedRole = nested && attr(nested, 'data-turn');
  if (nestedRole && ROLES.has(nestedRole)) return nestedRole;

  // Structural hints only — never the localised label text.
  const classes = classesOf(turn).join(' ');
  if (/user-message|from-user/.test(classes)) return 'user';
  if (q(turn, '.user-message-bubble-color')) return 'user';
  return null;
}

/**
 * Descend through single-child wrapper divs to the element that actually holds
 * the message, so hashed CSS-module wrappers do not have to be named.
 * @param {Element} node
 */
export function deepestTextContainer(node) {
  let current = node;
  const total = measure(node);
  if (!total) return node;
  for (let depth = 0; depth < 12; depth++) {
    const kids = elementChildren(current).filter((k) => !isIgnorable(k));
    if (kids.length !== 1) break;
    const only = kids[0];
    if (measure(only) < total * 0.9) break; // descending would lose text
    current = only;
  }
  return current;
}

function bodyOf(turn) {
  const holder = q(turn, '[data-message-author-role]') || turn;
  for (const selector of BODY_SELECTORS) {
    const el = q(holder, selector);
    if (el && measure(el) > 0) return el;
  }
  return deepestTextContainer(holder);
}

/**
 * Convert one turn element into a contract `Message`.
 * @param {Element} turn
 * @param {{unknownRoles?:number}} [stats] mutated with a count of unknown roles
 * @returns {import('./extract.js').Message|null}
 */
export function turnToMessage(turn, stats) {
  if (!turn) return null;
  const resolved = roleOf(turn);
  if (!resolved && stats) stats.unknownRoles = (stats.unknownRoles || 0) + 1;
  const role = resolved || 'assistant';

  const body = bodyOf(turn);
  const text = sanitizeText(htmlToMarkdown(body)).trim();
  const attachments = qa(body, 'img')
    .map((img) => ({
      type: 'image',
      name: null,
      url: attr(img, 'src'),
      alt: attr(img, 'alt'),
    }))
    .filter((a) => a.url && !String(a.url).startsWith('data:image/svg'));

  if (!text && attachments.length === 0) return null;

  let contentType = 'text';
  if (attachments.length) contentType = 'multimodal';
  if (/^```/.test(text) && /```$/.test(text)) contentType = 'code';

  return {
    id: attr(turn, 'data-turn-id')
      || attr(turn, 'data-message-id')
      || (q(turn, '[data-message-id]') && attr(q(turn, '[data-message-id]'), 'data-message-id'))
      || null,
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
  'main#main',
  '#thread',
  'main',
];

const isScrollable = (el) => Boolean(el)
  && Number(el.scrollHeight) > Number(el.clientHeight || 0) + 40;

/**
 * The element that actually scrolls the transcript.
 *
 * Measured live: exactly two scrollable candidates exist — the transcript div
 * (4118/812) and `main#main` (4066/760) — so "the largest scrollable ancestor of
 * the first turn, else the largest scrollable candidate on the page" resolves
 * correctly without hardcoding either.
 *
 * @param {Document} doc
 * @returns {Element|null}
 */
export function findScrollContainer(doc) {
  const candidates = [];

  const turns = collectTurns(doc);
  let node = turns.length ? turns[0].parentElement : null;
  for (let depth = 0; node && depth < 30; depth++) {
    if (isScrollable(node)) candidates.push(node);
    node = node.parentElement;
  }
  for (const selector of SCROLL_CONTAINER_SELECTORS) {
    for (const el of qa(doc, selector)) if (isScrollable(el)) candidates.push(el);
  }

  if (candidates.length) {
    return candidates.reduce((best, el) => (
      Number(el.scrollHeight) > Number(best.scrollHeight) ? el : best
    ));
  }
  const scrolling = doc && doc.scrollingElement;
  return scrolling || null;
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function setScrollTop(container, value) {
  try { container.scrollTop = value; } catch { /* ignore */ }
}

/**
 * Phase 1: rewind to the top, letting ChatGPT page older history in.
 *
 * Two different stall conditions are checked, because they are genuinely
 * different failures: the turn count can stop growing while the container is
 * still scrolling (mid-load), and the scroll position can freeze while turns
 * keep arriving.
 *
 * @param {Document} doc
 * @param {{maxIterations?:number, waitMs?:number, warnings?:string[], onCapture?:Function}} [opts]
 * @returns {Promise<{turns:number, iterations:number, hitCap:boolean}>}
 */
export async function loadFullTranscript(doc, opts = {}) {
  const maxIterations = opts.maxIterations == null ? 80 : opts.maxIterations;
  const waitMs = opts.waitMs == null ? 220 : opts.waitMs;
  const warnings = opts.warnings || [];
  const onCapture = typeof opts.onCapture === 'function' ? opts.onCapture : () => {};
  const container = findScrollContainer(doc);

  if (!container) {
    warnings.push('DOM fallback: could not find the transcript scroll container; '
      + 'only the messages already on screen were read.');
    onCapture();
    return { turns: collectTurns(doc).length, iterations: 0, hitCap: false };
  }

  let lastCount = collectTurns(doc).length;
  let lastTop = Number(container.scrollTop) || 0;
  let stable = 0;
  let iterations = 0;
  let hitCap = false;

  onCapture();
  for (; iterations < maxIterations; iterations++) {
    setScrollTop(container, 0);
    await sleep(waitMs);
    onCapture();

    const count = collectTurns(doc).length;
    const top = Number(container.scrollTop) || 0;
    const grew = count !== lastCount;
    const moved = top !== lastTop;

    if (!grew && !moved) {
      stable += 1;
      if (stable >= 3 && top <= 1) break;
      if (stable >= 6) break; // frozen but not at the top: give up, warn below
    } else {
      stable = 0;
    }
    lastCount = count;
    lastTop = top;
  }

  if (iterations >= maxIterations) {
    hitCap = true;
    warnings.push(
      `DOM fallback: gave up rewinding to the start of the conversation after ${maxIterations} `
      + 'attempts. The beginning of this chat is probably missing from the export.',
    );
  }
  if (Number(container.scrollTop) > 1) {
    warnings.push('DOM fallback: the transcript never scrolled fully to the top, '
      + 'so early messages may be missing.');
  }

  return { turns: collectTurns(doc).length, iterations, hitCap };
}

/**
 * Phases 1 + 2: rewind, then sweep downwards converting every turn at the moment
 * it is mounted. Returns entries keyed by turn identity, in turn-index order.
 *
 * @param {Document} doc
 * @param {{maxIterations?:number, waitMs?:number, warnings?:string[]}} [opts]
 * @returns {Promise<{entries:Array<{index:number|null, order:number, message:object}>, stats:object}>}
 */
export async function harvestTurns(doc, opts = {}) {
  const warnings = opts.warnings || [];
  const waitMs = opts.waitMs == null ? 220 : opts.waitMs;
  const maxIterations = opts.maxIterations == null ? 80 : opts.maxIterations;
  const collected = new Map();
  const stats = { unknownRoles: 0, conversions: 0, failures: 0 };
  let order = 0;

  const capture = () => {
    for (const turn of collectTurns(doc)) {
      const key = turnKey(turn) || `order:${order}`;
      if (collected.has(key)) continue;
      let message = null;
      try {
        message = turnToMessage(turn, stats);
        stats.conversions += 1;
      } catch (err) {
        stats.failures += 1;
        warnings.push(`DOM fallback: one message could not be converted (${err && err.message ? err.message : err}).`);
      }
      if (message) collected.set(key, { index: turnIndex(turn), order: order++, message });
    }
  };

  await loadFullTranscript(doc, { ...opts, warnings, onCapture: capture });

  const container = findScrollContainer(doc);
  if (container) {
    const view = Number(container.clientHeight) || 800;
    const step = Math.max(120, Math.floor(view * 0.75)); // overlap, so nothing slips through
    const sweepCap = Math.max(maxIterations * 4, 40);
    let position = 0;
    let sweeps = 0;
    let lastHeight = -1;
    let sameHeight = 0;

    for (; sweeps < sweepCap; sweeps++) {
      setScrollTop(container, position);
      await sleep(waitMs);
      capture();

      const height = Number(container.scrollHeight) || 0;
      const bottom = Math.max(0, height - view);
      if (height === lastHeight) sameHeight += 1; else sameHeight = 0;
      lastHeight = height;

      if (position >= bottom) {
        // Height can still grow as the tail re-renders; stop once it settles.
        if (sameHeight >= 2) break;
      }
      position = Math.min(position + step, bottom);
    }
    if (sweeps >= sweepCap) {
      warnings.push('DOM fallback: stopped sweeping the transcript at the safety cap; '
        + 'the end of this chat may be missing from the export.');
    }
  }

  const entries = Array.from(collected.values()).sort((a, b) => {
    if (a.index != null && b.index != null && a.index !== b.index) return a.index - b.index;
    if (a.index != null && b.index == null) return -1;
    if (a.index == null && b.index != null) return 1;
    return a.order - b.order;
  });

  return { entries, stats };
}

/* ------------------------------------------------------------------ */
/* Completeness accounting — fail loudly, never silently               */
/* ------------------------------------------------------------------ */

/**
 * Compare what we captured against what the turn indices imply exists.
 * A plausible-looking but truncated export is the worst outcome in this
 * category, so anything short of complete gets a shouty warning.
 *
 * @param {Array<{index:number|null}>} entries
 * @returns {{captured:number, implied:number|null, missing:number[], warnings:string[]}}
 */
export function completenessReport(entries) {
  const captured = entries.length;
  const indices = entries.map((e) => e.index).filter((i) => Number.isFinite(i));
  const warnings = [];
  if (!indices.length) {
    return { captured, implied: null, missing: [], warnings };
  }

  const min = Math.min(...indices);
  const max = Math.max(...indices);
  const seen = new Set(indices);
  const missing = [];
  for (let i = min; i <= max; i++) if (!seen.has(i)) missing.push(i);

  const spanned = max - min + 1;
  if (missing.length) {
    const preview = missing.slice(0, 8).join(', ');
    const more = missing.length > 8 ? `, … (+${missing.length - 8} more)` : '';
    warnings.push(
      `INCOMPLETE EXPORT — captured ${captured} of about ${spanned} turns. `
      + `${missing.length} turn(s) were never rendered by the page and are missing from this file `
      + `(turn ${preview}${more}). ChatGPT only keeps part of a long conversation in the page at once; `
      + 'open the chat while logged in so the export can use the API instead.',
    );
  }
  // Turn numbering starts at 1 or 2 depending on the build; a higher floor means
  // the top of the conversation never mounted.
  if (min > 2) {
    warnings.push(
      `INCOMPLETE EXPORT — the transcript starts at turn ${min}, so roughly ${min - 1} earlier `
      + 'message(s) are missing from this file.',
    );
  }

  return { captured, implied: spanned, missing, warnings };
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

function titleFrom(doc, loc) {
  const heading = q(doc, 'h1, [data-testid="conversation-title"]');
  const headingText = heading ? textOf(heading).trim() : '';
  if (headingText && headingText.toLowerCase() !== 'chatgpt') return headingText;

  const active = q(doc, 'nav a[aria-current="page"], nav li[data-active] a, a[data-active]');
  const activeText = active ? textOf(active).trim() : '';
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
 *          scroll?:boolean, maxIterations?:number, waitMs?:number,
 *          expectedMessageCount?:number|null}} [opts]
 * @returns {Promise<import('./extract.js').Conversation>}
 */
export async function scrapeConversation(opts = {}) {
  const doc = opts.document
    || (typeof globalThis !== 'undefined' ? globalThis.document : null);
  const loc = opts.location
    || (doc && doc.defaultView && doc.defaultView.location)
    || (typeof globalThis !== 'undefined' ? globalThis.location : null)
    || { href: '' };

  const warnings = ['Backend API unavailable — this transcript was read from the page itself. '
    + 'Timestamps and the model name are not available this way.'];

  if (!doc) {
    return emptyConversation(opts.conversationId, loc,
      warnings.concat('DOM fallback: no document available.'));
  }

  let entries = [];
  let stats = { unknownRoles: 0 };

  if (opts.scroll === false) {
    // Read-only mode (tests, share snapshots): take what is mounted right now.
    let order = 0;
    for (const turn of collectTurns(doc)) {
      let message = null;
      try { message = turnToMessage(turn, stats); } catch { /* skip */ }
      if (message) entries.push({ index: turnIndex(turn), order: order++, message });
    }
  } else {
    const harvest = await harvestTurns(doc, { ...opts, warnings });
    entries = harvest.entries;
    stats = harvest.stats;
  }

  const report = completenessReport(entries);
  warnings.push(...report.warnings);

  if (stats.unknownRoles) {
    warnings.push(
      `DOM fallback: the speaker could not be determined for ${stats.unknownRoles} message(s); `
      + 'they are labelled as the assistant and may be attributed to the wrong side.',
    );
  }

  const messages = entries.map((e) => e.message);
  if (!messages.length) {
    warnings.push('DOM fallback: no conversation turns were found on this page.');
  }

  // If the caller knows how many messages the active branch really has, hold the
  // scrape to that number rather than to what the page happened to render.
  const expected = Number(opts.expectedMessageCount);
  if (Number.isFinite(expected) && expected > 0 && messages.length < expected) {
    warnings.push(
      `INCOMPLETE EXPORT — the conversation has ${expected} messages but only ${messages.length} `
      + 'could be read from the page.',
    );
  }

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
