/**
 * extract.js — the integration surface for claude.ai (Agent D).
 *
 * `extractConversation()` runs in the page context (content script). It tries
 * claude.ai's own conversation JSON first and degrades to reading the rendered
 * page. It throws only when both paths yield zero messages.
 *
 * The Conversation/Message shape is the platform-agnostic typedef from
 * CONTRACT.md — the shared renderer (`markdown.js`) consumes exactly this.
 */

import {
  parseConversationId,
  parseSnapshotId,
  isShareUrl,
  extractViaApi,
  extractSnapshotViaApi,
  mapConversationPayload,
  buildBranch,
  flattenTree,
  nodeToMessages,
  renderContent,
  renderArtifact,
  renderFoldedArtifact,
  collectArtifacts,
  isArtifactBlock,
  mapAttachments,
  toUnixSeconds,
  listOrganizationIds,
  readCookie,
  fetchConversation,
  fetchSnapshot,
  fence,
} from './api-client.js';
import {
  scrapeConversation,
  collectTurns,
  turnToMessages,
  roleOfTurn,
  loadFullTranscript,
  findScrollContainer,
  titleFrom,
} from './dom-scrape.js';

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
const ROLES = ['user', 'assistant', 'system', 'tool'];
const CONTENT_TYPES = ['text', 'code', 'thoughts', 'multimodal', 'other'];

const DEFAULT_TITLE = 'Claude conversation';

function str(v) {
  if (typeof v !== 'string') return null;
  return v.trim() ? v.trim() : null;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Guarantee every key of the typedef exists, with null for unknowns. */
export function normalizeConversation(conversation, fallback = {}) {
  const c = conversation && typeof conversation === 'object' ? conversation : {};
  const messages = Array.isArray(c.messages) ? c.messages : [];
  return {
    id: str(c.id) || str(fallback.id) || 'unknown',
    title: str(c.title) || str(fallback.title) || DEFAULT_TITLE,
    createTime: num(c.createTime),
    updateTime: num(c.updateTime),
    model: str(c.model) || null,
    sourceUrl: str(c.sourceUrl) || str(fallback.sourceUrl) || '',
    extractedVia: c.extractedVia === 'dom' ? 'dom' : 'api',
    messages: messages.map(normalizeMessage).filter(Boolean),
    warnings: Array.isArray(c.warnings) ? c.warnings.filter((w) => typeof w === 'string') : [],
  };
}

export function normalizeMessage(message) {
  if (!message || typeof message !== 'object') return null;
  const out = {};
  for (const key of MESSAGE_KEYS) out[key] = message[key] === undefined ? null : message[key];
  out.role = ROLES.includes(out.role) ? out.role : 'assistant';
  out.contentType = CONTENT_TYPES.includes(out.contentType) ? out.contentType : 'text';
  out.text = typeof out.text === 'string' ? out.text : '';
  out.attachments = Array.isArray(out.attachments)
    ? out.attachments.map((a) => ({
      type: a && a.type === 'file' ? 'file' : 'image',
      name: str(a && a.name),
      url: str(a && a.url),
      alt: str(a && a.alt),
    }))
    : [];
  out.hidden = Boolean(out.hidden);
  out.authorName = str(out.authorName);
  out.createTime = num(out.createTime);
  out.id = str(out.id);
  return out;
}

function visibleCount(conversation) {
  return conversation.messages.filter((m) => !m.hidden).length;
}

/**
 * Extract the whole conversation currently open on claude.ai.
 *
 * @param {{conversationId?:string, organizationId?:string, document?:Document,
 *          location?:object, fetch?:Function, preferDom?:boolean,
 *          scroll?:boolean, maxIterations?:number, waitMs?:number}} [opts]
 * @returns {Promise<Conversation>}
 */
export async function extractConversation(opts = {}) {
  const loc = opts.location
    || (typeof globalThis !== 'undefined' && globalThis.location)
    || { href: '', origin: 'https://claude.ai' };
  const sourceUrl = loc.href || '';
  const conversationId = opts.conversationId || parseConversationId(sourceUrl);
  const warnings = [];

  let apiResult = null;
  if (!opts.preferDom) {
    if (isShareUrl(sourceUrl)) {
      // Shared links have their own endpoint (`/api/chat_snapshots/<id>`),
      // which still beats scraping the rendered snapshot page.
      try {
        apiResult = normalizeConversation(
          await extractSnapshotViaApi({ ...opts, location: loc }),
          { id: parseSnapshotId(sourceUrl) || conversationId, sourceUrl },
        );
      } catch (err) {
        warnings.push('Shared conversation link — the snapshot API did not answer '
          + `(${err && err.message ? err.message : err}), so the page itself was read instead.`);
      }
    } else if (!conversationId) {
      warnings.push('Could not find a conversation id in the URL; the page itself was read instead. '
        + 'Open a chat at claude.ai/chat/… and try again.');
    } else {
      try {
        apiResult = normalizeConversation(
          await extractViaApi({ ...opts, conversationId, location: loc }),
          { id: conversationId, sourceUrl },
        );
      } catch (err) {
        warnings.push(`Claude's conversation API failed (${err && err.message ? err.message : err}); `
          + 'fell back to reading the page.');
      }
    }
  }

  if (apiResult && visibleCount(apiResult) > 0) {
    apiResult.warnings = warnings.concat(apiResult.warnings);
    return apiResult;
  }
  if (apiResult) {
    warnings.push('Claude\'s conversation API returned no visible messages; fell back to reading the page.');
  }

  let domResult = null;
  try {
    domResult = normalizeConversation(
      await scrapeConversation({ ...opts, conversationId, location: loc }),
      { id: conversationId, sourceUrl },
    );
    domResult.extractedVia = 'dom';
  } catch (err) {
    warnings.push(`Page fallback failed (${err && err.message ? err.message : err}).`);
  }

  if (domResult && visibleCount(domResult) > 0) {
    domResult.warnings = warnings.concat(domResult.warnings);
    // Keep whatever metadata the API managed to return.
    if (apiResult) {
      if (apiResult.title !== DEFAULT_TITLE) domResult.title = apiResult.title;
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
    `Could not read this conversation. Make sure you are on a claude.ai chat page and signed in.${detail}`,
  );
}

export {
  parseConversationId,
  parseSnapshotId,
  isShareUrl,
  extractViaApi,
  extractSnapshotViaApi,
  mapConversationPayload,
  buildBranch,
  flattenTree,
  nodeToMessages,
  renderContent,
  renderArtifact,
  renderFoldedArtifact,
  collectArtifacts,
  isArtifactBlock,
  mapAttachments,
  toUnixSeconds,
  listOrganizationIds,
  readCookie,
  fetchConversation,
  fetchSnapshot,
  fence,
  scrapeConversation,
  collectTurns,
  turnToMessages,
  roleOfTurn,
  loadFullTranscript,
  findScrollContainer,
  titleFrom,
};

export default extractConversation;
