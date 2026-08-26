/**
 * extract.js — Gemini / AI Studio conversation extractor (Agent E).
 *
 * Exports the CONTRACT's `Conversation` object for the thread currently open.
 * Runs in the page context (content script).
 *
 *   export async function extractConversation(opts?) -> Promise<Conversation>
 *
 * `extractedVia` is always `'dom'`. Gemini has no callable same-origin
 * conversation JSON endpoint — see the header of `gemini-dom.js` for why —
 * so unlike the ChatGPT extractor there is no API path to prefer.
 *
 * Contract rules honoured here:
 *   • never throw for a recoverable problem — degrade and push a warning;
 *   • throw only when zero messages could be recovered;
 *   • every key of the typedef is present, unknowns are `null`.
 *
 * This file owns all the impure work: scrolling, clicking "Show more" /
 * "Show thinking", and reading `location`/`document`. All parsing lives in the
 * pure modules next to it.
 */

import { parseGeminiTurns, conversationIdFromUrl, pickTitle, pickModel, isConversationContainer } from './gemini-dom.js';
import { parseAiStudioTurns, pickAiStudioTitle, isChatTurnNode } from './aistudio-dom.js';
import { findAll } from './dom-util.js';

export const DEFAULT_TITLE = 'Gemini conversation';

const DEFAULTS = {
  /** Bounded, as required: ~60 rounds then give up loudly. */
  maxScrollRounds: 60,
  /** Consecutive unchanged rounds that mean "the thread is fully loaded". */
  stableRounds: 3,
  scrollDelayMs: 450,
  expandDelayMs: 250,
  maxExpandClicks: 500,
};

/* ------------------------------------------------------------------ */
/* Surface detection                                                   */
/* ------------------------------------------------------------------ */

/** @returns {'gemini'|'aistudio'|'unknown'} */
export function detectSurface(href) {
  const url = String(href || '');
  if (/^https?:\/\/([^/]*\.)?aistudio\.google\.com\b/i.test(url)) return 'aistudio';
  if (/^https?:\/\/([^/]*\.)?gemini\.google\.com\b/i.test(url)) return 'gemini';
  if (/^https?:\/\/bard\.google\.com\b/i.test(url)) return 'gemini';
  return 'unknown';
}

/* ------------------------------------------------------------------ */
/* Live-DOM helpers (all defensive — a selector miss is never fatal)   */
/* ------------------------------------------------------------------ */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function queryAll(doc, selector) {
  try {
    const list = doc.querySelectorAll(selector);
    return list ? Array.prototype.slice.call(list) : [];
  } catch {
    return [];
  }
}

function queryOne(doc, selector) {
  try { return doc.querySelector(selector) || null; } catch { return null; }
}

const GEMINI_SCROLLER_SELECTORS = [
  '#chat-history',
  'infinite-scroller',
  'chat-window .chat-history',
  'main [data-test-id="chat-history-container"]',
];

const AISTUDIO_SCROLLER_SELECTORS = [
  'ms-autoscroll-container',
  'ms-chat-session .chat-container',
  'ms-prompt-chunk-container',
];

/** An element that actually scrolls, searched near the given candidates. */
function findScroller(doc, selectors) {
  for (const selector of selectors) {
    const node = queryOne(doc, selector);
    if (!node) continue;
    let cur = node;
    for (let depth = 0; cur && depth < 6; depth++) {
      if (typeof cur.scrollHeight === 'number' && typeof cur.clientHeight === 'number'
        && cur.scrollHeight > cur.clientHeight + 8) return cur;
      cur = cur.parentElement;
    }
    // Nothing overflows yet (short thread) — the container itself will do.
    return node;
  }
  return null;
}

const GEMINI_EXPAND_SELECTORS = [
  'model-thoughts button[aria-expanded="false"]',
  'model-thoughts mat-expansion-panel-header[aria-expanded="false"]',
  'model-response mat-expansion-panel-header[aria-expanded="false"]',
  'user-query button[aria-expanded="false"]',
  'message-content button[aria-expanded="false"]',
  'ms-thought-chunk button[aria-expanded="false"]',
  'mat-expansion-panel-header[aria-expanded="false"]',
  'button.query-text-expand-button',
  'button[data-test-id="expand-button"]',
];

const EXPAND_TEXT_RE = /^(show (more|thinking|drafts|reasoning)|see more|expand|read more|показать (ещё|больше)|показать размышления)\b/i;

const EXPAND_SCOPES = [
  '#chat-history', 'chat-window', 'ms-autoscroll-container', 'ms-chat-session', 'main',
];

/**
 * Click every collapsed panel / "Show more" toggle we can positively identify.
 * Deliberately conservative: only `aria-expanded="false"` controls and buttons
 * whose *entire* label matches the expand vocabulary, so menus, "Copy code"
 * and thumbs-up are never clicked.
 * @returns {number} clicks performed
 */
export function expandCollapsed(doc, budget = DEFAULTS.maxExpandClicks) {
  let clicks = 0;
  const clicked = new Set();
  const press = (node) => {
    if (!node || clicked.has(node) || clicks >= budget) return;
    clicked.add(node);
    try { node.click(); clicks++; } catch { /* not clickable — ignore */ }
  };

  for (const selector of GEMINI_EXPAND_SELECTORS) {
    for (const node of queryAll(doc, selector)) press(node);
  }

  for (const scopeSelector of EXPAND_SCOPES) {
    const scope = queryOne(doc, scopeSelector);
    if (!scope) continue;
    for (const button of queryAll(scope, 'button')) {
      const label = String(button.innerText || button.textContent || '').trim();
      if (label && label.length <= 40 && EXPAND_TEXT_RE.test(label)) press(button);
    }
    break; // one scope is enough; they nest
  }
  return clicks;
}

/**
 * Load the *whole* thread, not the visible part. Gemini lazy-loads older turns
 * as you scroll up, so we drive the scroller to the top until the turn count
 * and the scroll height both stop growing.
 */
async function loadWholeThread(doc, opts, surface, warnings) {
  const selectors = surface === 'aistudio' ? AISTUDIO_SCROLLER_SELECTORS : GEMINI_SCROLLER_SELECTORS;
  const isTurn = surface === 'aistudio' ? isChatTurnNode : isConversationContainer;
  const scroller = findScroller(doc, selectors);
  if (!scroller) {
    warnings.push('Could not find the scrollable chat container, so older turns may not have been loaded. Scroll to the top of the chat manually and try again if the export looks short.');
    expandCollapsed(doc);
    await sleep(opts.expandDelayMs);
    return;
  }

  const originalTop = typeof scroller.scrollTop === 'number' ? scroller.scrollTop : 0;
  const countTurns = () => {
    const byElement = findAll(doc.body || doc, isTurn).length;
    if (byElement) return byElement;
    return queryAll(doc, surface === 'aistudio' ? 'ms-chat-turn' : 'user-query, model-response').length;
  };

  let stable = 0;
  let lastCount = -1;
  let lastHeight = -1;
  let round = 0;
  for (; round < opts.maxScrollRounds && stable < opts.stableRounds; round++) {
    expandCollapsed(doc);
    const count = countTurns();
    const height = Number(scroller.scrollHeight) || 0;
    if (count === lastCount && height === lastHeight) stable++;
    else stable = 0;
    lastCount = count;
    lastHeight = height;
    try { scroller.scrollTop = 0; } catch { /* ignore */ }
    await sleep(opts.scrollDelayMs);
  }

  if (stable < opts.stableRounds) {
    warnings.push(`Stopped loading older turns after ${round} scroll rounds — this conversation is very long and the beginning may be missing.`);
  }

  // Back to the bottom so the newest turns are certainly rendered, then a final
  // expand pass for anything that mounted on the way down.
  try { scroller.scrollTop = Number(scroller.scrollHeight) || originalTop; } catch { /* ignore */ }
  await sleep(opts.scrollDelayMs);
  const late = expandCollapsed(doc);
  if (late) await sleep(opts.expandDelayMs);
  try { scroller.scrollTop = originalTop; } catch { /* ignore */ }
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

/**
 * @param {Object} [opts]
 * @param {string}  [opts.conversationId]  override the id parsed from the URL
 * @param {Document} [opts.document]       injectable for tests
 * @param {{href:string}} [opts.location]  injectable for tests
 * @param {boolean} [opts.autoLoad]        set false to skip scrolling/expanding
 * @param {number}  [opts.maxScrollRounds]
 * @returns {Promise<Conversation>}
 */
export async function extractConversation(opts = {}) {
  const options = { ...DEFAULTS, ...opts };
  const doc = opts.document || (typeof document !== 'undefined' ? document : null);
  const loc = opts.location || (typeof location !== 'undefined' ? location : null);
  const sourceUrl = loc && loc.href ? String(loc.href) : '';
  const surface = detectSurface(sourceUrl);
  const warnings = [];

  if (!doc) throw new Error('Chat2MD: no document to read — the extractor must run in the page.');
  if (surface === 'unknown') {
    warnings.push('This page is not gemini.google.com or aistudio.google.com; extraction was attempted anyway and may be incomplete.');
  }

  if (options.autoLoad !== false) {
    try {
      await loadWholeThread(doc, options, surface, warnings);
    } catch (err) {
      warnings.push(`Could not fully load the conversation before reading it (${short(err)}); the export may be missing older turns.`);
    }
  }

  const root = doc.body || doc.documentElement || doc;
  let parsed;
  if (surface === 'aistudio') {
    parsed = safeParse(() => parseAiStudioTurns(root), warnings, 'AI Studio');
    if (!parsed.messages.length) {
      // A Gemini-shaped DOM inside AI Studio would be surprising, but trying
      // costs nothing and beats handing the user an empty file.
      const alt = safeParse(() => parseGeminiTurns(root), warnings, 'Gemini');
      if (alt.messages.length) {
        parsed = alt;
        warnings.push('AI Studio selectors matched nothing; the Gemini layout parser was used instead.');
      }
    }
  } else {
    parsed = safeParse(() => parseGeminiTurns(root), warnings, 'Gemini');
    if (!parsed.messages.length) {
      const alt = safeParse(() => parseAiStudioTurns(root), warnings, 'AI Studio');
      if (alt.messages.length) {
        parsed = alt;
        warnings.push('Gemini selectors matched nothing; the AI Studio layout parser was used instead.');
      }
    }
  }

  for (const w of parsed.warnings) if (!warnings.includes(w)) warnings.push(w);

  if (!parsed.messages.length) {
    throw new Error('Chat2MD: no messages found on this page. Open a conversation and let it finish loading, then try again.');
  }

  const title = (surface === 'aistudio'
    ? pickAiStudioTitle(root, doc.title)
    : pickTitle(root, doc.title)) || DEFAULT_TITLE;

  let model = null;
  try { model = pickModel(root); } catch { model = null; }

  warnings.push('Gemini\'s page exposes no message timestamps, so per-message and conversation times are omitted.');

  return {
    id: opts.conversationId || conversationIdFromUrl(sourceUrl),
    title,
    createTime: null,
    updateTime: null,
    model,
    sourceUrl,
    extractedVia: 'dom',
    messages: parsed.messages,
    warnings,
  };
}

function safeParse(fn, warnings, label) {
  try {
    const r = fn();
    return { messages: r.messages || [], warnings: r.warnings || [], turnCount: r.turnCount || 0 };
  } catch (err) {
    warnings.push(`The ${label} layout parser failed (${short(err)}).`);
    return { messages: [], warnings: [], turnCount: 0 };
  }
}

function short(err) {
  const msg = err && err.message ? String(err.message) : String(err);
  return msg.length > 120 ? `${msg.slice(0, 117)}…` : msg;
}

export default extractConversation;
