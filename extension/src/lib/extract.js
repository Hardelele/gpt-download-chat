/**
 * extract.js — the integration surface (Agent A).
 *
 * `extractConversation()` runs in the page context (content script). It tries
 * the backend conversation JSON first and degrades to DOM scraping. It throws
 * only when both paths yield zero messages.
 */

import {
  parseConversationId,
  isShareUrl,
  extractViaApi,
  findEmbeddedPayload,
  mapConversationPayload,
  buildBranch,
  nodeToMessage,
  renderContent,
} from './api-client.js';
import { scrapeConversation, collectTurns, turnToMessage, loadFullTranscript } from './dom-scrape.js';
import { htmlToMarkdown } from './html2md.js';

/**
 * @typedef {Object} Attachment
 * @property {'image'|'file'} type
 * @property {string|null} name
 * @property {string|null} url
 * @property {string|null} alt
 */

/**
 * @typedef {Object} Message
 * @property {string|null} id
 * @property {'user'|'assistant'|'system'|'tool'} role
 * @property {string|null} authorName
 * @property {number|null} createTime
 * @property {'text'|'code'|'thoughts'|'multimodal'|'other'} contentType
 * @property {string} text  ALREADY MARKDOWN
 * @property {Attachment[]} attachments
 * @property {boolean} hidden
 */

/**
 * @typedef {Object} Conversation
 * @property {string} id
 * @property {string} title
 * @property {number|null} createTime
 * @property {number|null} updateTime
 * @property {string|null} model
 * @property {string} sourceUrl
 * @property {'api'|'dom'} extractedVia
 * @property {Message[]} messages
 * @property {string[]} warnings
 */

const MESSAGE_KEYS = ['id', 'role', 'authorName', 'createTime', 'contentType', 'text', 'attachments', 'hidden'];

/** Guarantee every key of the typedef exists, with null for unknowns. */
export function normalizeConversation(conversation, fallback = {}) {
  const c = conversation && typeof conversation === 'object' ? conversation : {};
  const messages = Array.isArray(c.messages) ? c.messages : [];
  return {
    id: str(c.id) || str(fallback.id) || 'unknown',
    title: str(c.title) || str(fallback.title) || 'ChatGPT conversation',
    createTime: num(c.createTime),
    updateTime: num(c.updateTime),
    model: str(c.model) || null,
    sourceUrl: str(c.sourceUrl) || str(fallback.sourceUrl) || '',
    extractedVia: c.extractedVia === 'dom' ? 'dom' : 'api',
    messages: messages.map(normalizeMessage).filter(Boolean),
    warnings: Array.isArray(c.warnings) ? c.warnings.filter((w) => typeof w === 'string') : [],
  };
}

function normalizeMessage(message) {
  if (!message || typeof message !== 'object') return null;
  const out = {};
  for (const key of MESSAGE_KEYS) out[key] = message[key] === undefined ? null : message[key];
  out.role = ['user', 'assistant', 'system', 'tool'].includes(out.role) ? out.role : 'assistant';
  out.contentType = ['text', 'code', 'thoughts', 'multimodal', 'other'].includes(out.contentType)
    ? out.contentType : 'text';
  out.text = typeof out.text === 'string' ? out.text : '';
  out.attachments = Array.isArray(out.attachments)
    ? out.attachments.map((a) => ({
      type: a && a.type === 'file' ? 'file' : 'image',
      name: str(a && a.name) || null,
      url: str(a && a.url) || null,
      alt: str(a && a.alt) || null,
    }))
    : [];
  out.hidden = Boolean(out.hidden);
  out.authorName = str(out.authorName) || null;
  out.createTime = num(out.createTime);
  out.id = str(out.id) || null;
  return out;
}

function str(v) { return typeof v === 'string' && v.trim() ? v.trim() : (typeof v === 'string' ? v : null); }
function num(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; }

/** Never let a broken page break extraction. */
function safeEmbeddedPayload(opts) {
  try {
    const doc = opts.document || (typeof globalThis !== 'undefined' ? globalThis.document : null);
    return doc ? findEmbeddedPayload(doc) : null;
  } catch {
    return null;
  }
}

function visibleCount(conversation) {
  return conversation.messages.filter((m) => !m.hidden).length;
}

/**
 * @param {{conversationId?:string, document?:Document, location?:object,
 *          fetch?:Function, preferDom?:boolean, scroll?:boolean}} [opts]
 * @returns {Promise<Conversation>}
 */
export async function extractConversation(opts = {}) {
  const loc = opts.location
    || (typeof globalThis !== 'undefined' && globalThis.location)
    || { href: '', origin: 'https://chatgpt.com' };
  const sourceUrl = loc.href || '';
  const conversationId = opts.conversationId || parseConversationId(sourceUrl);
  const warnings = [];

  let apiResult = null;
  if (!opts.preferDom) {
    if (isShareUrl(sourceUrl)) {
      // Share pages have no reachable endpoint, but they ship the same JSON inline.
      const embedded = safeEmbeddedPayload(opts);
      if (embedded) {
        apiResult = normalizeConversation(
          mapConversationPayload(embedded, { sourceUrl, conversationId, extractedVia: 'api' }),
          { id: conversationId, sourceUrl },
        );
        warnings.push('Shared conversation link — read from the conversation JSON embedded in the page.');
      } else {
        warnings.push('Shared conversation link — the backend API is not reachable here, '
          + 'so the page itself was read instead.');
      }
    } else if (!conversationId) {
      warnings.push('Could not find a conversation id in the URL; the page itself was read instead.');
    } else {
      try {
        apiResult = normalizeConversation(
          await extractViaApi({ ...opts, conversationId, location: loc }),
          { id: conversationId, sourceUrl },
        );
      } catch (err) {
        warnings.push(`Backend API path failed (${err && err.message ? err.message : err}); `
          + 'fell back to reading the page.');
        // The page may still carry the conversation JSON inline — better than scraping.
        const embedded = safeEmbeddedPayload(opts);
        if (embedded) {
          apiResult = normalizeConversation(
            mapConversationPayload(embedded, { sourceUrl, conversationId, extractedVia: 'api' }),
            { id: conversationId, sourceUrl },
          );
          warnings.push('Recovered the conversation JSON embedded in the page instead.');
        }
      }
    }
  }

  if (apiResult && visibleCount(apiResult) > 0) {
    apiResult.warnings = warnings.concat(apiResult.warnings);
    return apiResult;
  }
  if (apiResult) {
    warnings.push('Backend API returned no visible messages; fell back to reading the page.');
  }

  let domResult = null;
  try {
    domResult = normalizeConversation(
      await scrapeConversation({ ...opts, conversationId, location: loc }),
      { id: conversationId, sourceUrl },
    );
    domResult.extractedVia = 'dom';
  } catch (err) {
    warnings.push(`DOM fallback failed (${err && err.message ? err.message : err}).`);
  }

  if (domResult && visibleCount(domResult) > 0) {
    domResult.warnings = warnings.concat(domResult.warnings);
    // Keep whatever metadata the API managed to return.
    if (apiResult) {
      domResult.title = apiResult.title !== 'ChatGPT conversation' ? apiResult.title : domResult.title;
      domResult.createTime = domResult.createTime || apiResult.createTime;
      domResult.updateTime = domResult.updateTime || apiResult.updateTime;
      domResult.model = domResult.model || apiResult.model;
    }
    return domResult;
  }

  if (apiResult) {
    apiResult.warnings = warnings.concat(apiResult.warnings);
    return apiResult;
  }

  const detail = warnings.length ? ` Details: ${warnings.join(' ')}` : '';
  throw new Error(
    `Could not read this conversation. Make sure you are on a chatgpt.com chat page and logged in.${detail}`,
  );
}

export {
  parseConversationId,
  isShareUrl,
  mapConversationPayload,
  findEmbeddedPayload,
  buildBranch,
  nodeToMessage,
  renderContent,
  extractViaApi,
  scrapeConversation,
  collectTurns,
  turnToMessage,
  loadFullTranscript,
  htmlToMarkdown,
};

export default extractConversation;
