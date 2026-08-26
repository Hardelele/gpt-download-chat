/**
 * api-client.js — primary extraction path (Agent A).
 *
 * Talks to ChatGPT's own backend with the user's existing session cookies:
 *   GET /api/auth/session            -> { accessToken, user, expires }
 *   GET /backend-api/conversation/ID -> { title, create_time, mapping, current_node, ... }
 *
 * Everything below the "pure" line has no browser dependency and is unit-tested.
 * No top-level access to window/document/chrome.
 *
 * @typedef {import('./extract.js').Conversation} Conversation
 */

export const API_HOSTS = ['chatgpt.com', 'chat.openai.com'];

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Pull the conversation id out of a ChatGPT URL.
 * Handles: /c/<uuid>, /g/g-xxxx/c/<uuid>, /share/<uuid>, /chat/<uuid> (legacy),
 * chatgpt.com and chat.openai.com, with or without query/hash.
 * @param {string} url
 * @returns {string|null}
 */
export function parseConversationId(url) {
  if (!url || typeof url !== 'string') return null;
  let pathname = url;
  try {
    pathname = new URL(url).pathname;
  } catch {
    const q = url.indexOf('?');
    if (q !== -1) pathname = url.slice(0, q);
  }
  const patterns = [
    /\/(?:g\/[^/]+\/)?c\/([^/?#]+)/i,
    /\/share\/(?:[^/]+\/)?([^/?#]+)/i,
    /\/chat\/([^/?#]+)/i,
  ];
  for (const re of patterns) {
    const m = pathname.match(re);
    if (m && m[1]) {
      const id = decodeURIComponent(m[1]);
      if (UUID_RE.test(id) || /^[A-Za-z0-9_-]{8,}$/.test(id)) return id;
    }
  }
  const bare = pathname.match(UUID_RE);
  return bare ? bare[0] : null;
}

/** True when the URL is a public share link (no /backend-api/conversation access). */
export function isShareUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try { return new URL(url).pathname.startsWith('/share/'); } catch { return /\/share\//.test(url); }
}

/**
 * Walk `parent` links from `current_node` up to the root, then reverse.
 * This is what keeps the transcript in order and excludes abandoned
 * regeneration branches — never iterate Object.values(mapping).
 *
 * @param {Record<string, {id?:string, message?:object|null, parent?:string|null, children?:string[]}>} mapping
 * @param {string|null|undefined} currentNode
 * @returns {object[]} nodes, root-first
 */
export function buildBranch(mapping, currentNode) {
  if (!mapping || typeof mapping !== 'object') return [];
  let leaf = currentNode;
  if (!leaf || !mapping[leaf]) leaf = findFallbackLeaf(mapping);
  if (!leaf || !mapping[leaf]) return [];

  const chain = [];
  const seen = new Set();
  let cursor = leaf;
  while (cursor && mapping[cursor] && !seen.has(cursor)) {
    seen.add(cursor);
    const node = mapping[cursor];
    chain.push({ ...node, id: node.id || cursor });
    cursor = node.parent || null;
  }
  chain.reverse();
  return chain;
}

/**
 * When `current_node` is missing or dangling, pick the deepest leaf reachable
 * from the root — the longest conversation branch is the best guess.
 */
function findFallbackLeaf(mapping) {
  const ids = Object.keys(mapping);
  if (!ids.length) return null;
  const roots = ids.filter((id) => !mapping[id] || !mapping[id].parent || !mapping[mapping[id].parent]);
  const starts = roots.length ? roots : [ids[0]];
  let best = null;
  let bestScore = -1;
  const visit = (id, depth, guard) => {
    if (!id || !mapping[id] || guard.has(id)) return;
    guard.add(id);
    const node = mapping[id];
    const kids = Array.isArray(node.children) ? node.children.filter((k) => mapping[k]) : [];
    if (!kids.length) {
      const time = node.message && Number(node.message.create_time) || 0;
      const score = depth * 1e6 + time / 1e6;
      if (score > bestScore) { bestScore = score; best = id; }
      return;
    }
    for (const kid of kids) visit(kid, depth + 1, guard);
  };
  for (const start of starts) visit(start, 0, new Set());
  return best || ids[ids.length - 1];
}

const ROLE_MAP = { user: 'user', assistant: 'assistant', system: 'system', tool: 'tool' };

/**
 * Turn one mapping node into a contract `Message` (or null when it carries
 * nothing at all, e.g. the synthetic root node with no `message`).
 * @param {object} node
 * @returns {import('./extract.js').Message|null}
 */
export function nodeToMessage(node) {
  if (!node || !node.message) return null;
  const msg = node.message;
  const author = msg.author || {};
  const meta = msg.metadata || {};
  const rawRole = String(author.role || '').toLowerCase();
  const role = ROLE_MAP[rawRole] || (rawRole === 'critic' ? 'system' : 'assistant');

  const { text, contentType, attachments } = renderContent(msg.content, msg);

  // Hidden = plumbing the renderer skips by default. We never drop nodes; the
  // renderer decides what to show.
  let hidden = meta.is_visually_hidden_from_conversation === true || role === 'system';

  if (!text.trim() && attachments.length === 0) hidden = true;

  const authorName = rawRole === 'tool'
    ? (author.name || meta.invoked_plugin && meta.invoked_plugin.namespace || 'tool')
    : (author.name || null);

  return {
    id: msg.id || node.id || null,
    role,
    authorName: authorName || null,
    createTime: numberOrNull(msg.create_time),
    contentType,
    text,
    attachments,
    hidden: Boolean(hidden),
  };
}

function numberOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function fence(text, lang) {
  let f = '```';
  const body = String(text == null ? '' : text);
  while (body.includes(f)) f += '`';
  return `${f}${lang || ''}\n${body.replace(/\s+$/, '')}\n${f}`;
}

/**
 * Render `message.content` into markdown + attachments.
 * @returns {{text:string, contentType:'text'|'code'|'thoughts'|'multimodal'|'other', attachments:object[]}}
 */
export function renderContent(content, message) {
  const attachments = [];
  if (!content || typeof content !== 'object') {
    return { text: '', contentType: 'other', attachments };
  }
  const type = String(content.content_type || 'text');

  switch (type) {
    case 'text': {
      const parts = Array.isArray(content.parts) ? content.parts : [];
      const text = parts
        .map((p) => (typeof p === 'string' ? p : stringifyUnknown(p)))
        .filter((p) => p !== '')
        .join('\n\n');
      return { text: text.trim(), contentType: 'text', attachments };
    }

    case 'code': {
      const lang = content.language && content.language !== 'unknown' ? content.language : '';
      const body = typeof content.text === 'string' ? content.text : stringifyUnknown(content.text);
      const recipient = message && message.recipient && message.recipient !== 'all'
        ? message.recipient : null;
      const header = recipient ? `_tool call → \`${recipient}\`_\n\n` : '';
      return { text: (header + fence(body, lang)).trim(), contentType: 'code', attachments };
    }

    case 'execution_output':
    case 'tether_quote':
    case 'tether_browsing_display':
    case 'system_error': {
      const body = typeof content.text === 'string' ? content.text
        : typeof content.result === 'string' ? content.result
          : stringifyUnknown(content);
      if (!String(body).trim()) return { text: '', contentType: 'other', attachments };
      return { text: fence(body, type === 'execution_output' ? '' : ''), contentType: 'other', attachments };
    }

    case 'thoughts':
    case 'reasoning_recap': {
      let text = '';
      if (Array.isArray(content.thoughts)) {
        text = content.thoughts.map((t) => {
          if (!t || typeof t !== 'object') return String(t || '');
          const summary = t.summary ? `**${t.summary}**` : '';
          const inner = typeof t.content === 'string' ? t.content : stringifyUnknown(t.content);
          return [summary, inner].filter(Boolean).join('\n\n');
        }).filter(Boolean).join('\n\n');
      }
      if (!text && typeof content.content === 'string') text = content.content;
      if (!text && typeof content.text === 'string') text = content.text;
      if (!text && Array.isArray(content.parts)) text = content.parts.filter((p) => typeof p === 'string').join('\n\n');
      return { text: String(text).trim(), contentType: 'thoughts', attachments };
    }

    case 'multimodal_text': {
      const parts = Array.isArray(content.parts) ? content.parts : [];
      const chunks = [];
      for (const part of parts) {
        if (typeof part === 'string') {
          if (part.trim()) chunks.push(part);
          continue;
        }
        if (!part || typeof part !== 'object') continue;
        const partType = String(part.content_type || '');
        if (partType === 'image_asset_pointer' || partType === 'image_url' || part.asset_pointer) {
          const pointer = part.asset_pointer || part.image_url || null;
          const name = pointerToName(pointer);
          const alt = part.alt || (part.metadata && part.metadata.dalle && part.metadata.dalle.prompt) || name || 'image';
          attachments.push({ type: 'image', name, url: pointer, alt });
          const dims = part.width && part.height ? ` (${part.width}×${part.height})` : '';
          chunks.push(`![${alt}${dims}](${pointer || ''})`);
          continue;
        }
        if (partType === 'audio_transcription' && typeof part.text === 'string') {
          chunks.push(part.text);
          continue;
        }
        if (partType === 'real_time_user_audio_video_asset_pointer' || partType === 'audio_asset_pointer') {
          const pointer = part.asset_pointer || (part.audio_asset_pointer && part.audio_asset_pointer.asset_pointer) || null;
          attachments.push({ type: 'file', name: pointerToName(pointer), url: pointer, alt: null });
          continue;
        }
        if (typeof part.text === 'string' && part.text.trim()) { chunks.push(part.text); continue; }
        const fallback = stringifyUnknown(part);
        if (fallback) chunks.push(fallback);
      }
      return { text: chunks.join('\n\n').trim(), contentType: 'multimodal', attachments };
    }

    default: {
      if (Array.isArray(content.parts)) {
        const text = content.parts.map((p) => (typeof p === 'string' ? p : stringifyUnknown(p)))
          .filter(Boolean).join('\n\n');
        return { text: text.trim(), contentType: 'other', attachments };
      }
      if (typeof content.text === 'string') {
        return { text: content.text.trim(), contentType: 'other', attachments };
      }
      return { text: stringifyUnknown(content), contentType: 'other', attachments };
    }
  }
}

function pointerToName(pointer) {
  if (!pointer || typeof pointer !== 'string') return null;
  const m = pointer.match(/([^/]+)$/);
  return m ? m[1] : pointer;
}

function stringifyUnknown(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    const json = JSON.stringify(value, null, 2);
    if (!json || json === '{}' || json === '[]') return '';
    return fence(json, 'json');
  } catch {
    return String(value);
  }
}

/** Attachments declared in message.metadata.attachments (uploaded files). */
function metadataAttachments(msg) {
  const meta = msg && msg.metadata;
  const list = meta && Array.isArray(meta.attachments) ? meta.attachments : [];
  return list.map((a) => ({
    type: a && typeof a.mime_type === 'string' && a.mime_type.startsWith('image/') ? 'image' : 'file',
    name: (a && (a.name || a.id)) || null,
    url: (a && (a.url || (a.id ? `file-service://${a.id}` : null))) || null,
    alt: null,
  }));
}

/**
 * Map a raw /backend-api/conversation payload to the contract `Conversation`.
 * Pure — this is the function the tests hammer.
 *
 * @param {object} payload
 * @param {{sourceUrl?:string, conversationId?:string|null, extractedVia?:'api'|'dom'}} [opts]
 * @returns {Conversation}
 */
export function mapConversationPayload(payload, opts = {}) {
  const warnings = [];
  const data = payload && typeof payload === 'object' ? payload : {};
  const mapping = data.mapping && typeof data.mapping === 'object' ? data.mapping : {};

  if (!data.current_node && Object.keys(mapping).length) {
    warnings.push('Conversation JSON had no current_node; used the longest branch instead.');
  }

  const branch = buildBranch(mapping, data.current_node);
  const messages = [];
  for (const node of branch) {
    const msg = nodeToMessage(node);
    if (!msg) continue;
    const extra = metadataAttachments(node.message);
    if (extra.length) {
      msg.attachments = msg.attachments.concat(
        extra.filter((e) => !msg.attachments.some((a) => a.url && a.url === e.url)),
      );
      if (msg.hidden && msg.text.trim()) msg.hidden = false;
    }
    messages.push(msg);
  }

  const totalNodes = Object.keys(mapping).filter((k) => mapping[k] && mapping[k].message).length;
  if (totalNodes > branch.length + 1 && branch.length) {
    warnings.push(
      `Conversation has ${totalNodes - branch.length} node(s) outside the active branch `
      + '(edited prompts / regenerated answers); only the active branch was exported.',
    );
  }

  // model = model_slug of the last assistant message that carries one.
  let model = null;
  for (let i = branch.length - 1; i >= 0 && !model; i--) {
    const m = branch[i].message;
    const slug = m && m.metadata && m.metadata.model_slug;
    const role = m && m.author && String(m.author.role || '').toLowerCase();
    if (slug && role === 'assistant') model = slug;
  }
  for (let i = branch.length - 1; i >= 0 && !model; i--) {
    const m = branch[i].message;
    if (m && m.metadata && m.metadata.model_slug) model = m.metadata.model_slug;
  }

  const id = data.conversation_id || opts.conversationId || data.id || 'unknown';
  const title = typeof data.title === 'string' && data.title.trim()
    ? data.title.trim()
    : 'ChatGPT conversation';

  return {
    id: String(id),
    title,
    createTime: numberOrNull(data.create_time),
    updateTime: numberOrNull(data.update_time),
    model: model || null,
    sourceUrl: opts.sourceUrl || (id !== 'unknown' ? `https://chatgpt.com/c/${id}` : ''),
    extractedVia: opts.extractedVia || 'api',
    messages,
    warnings,
  };
}

/* ------------------------------------------------------------------ */
/* Browser-touching layer                                              */
/* ------------------------------------------------------------------ */

function currentLocation(opts) {
  if (opts && opts.location) return opts.location;
  if (typeof globalThis !== 'undefined' && globalThis.location) return globalThis.location;
  return { href: '', origin: 'https://chatgpt.com' };
}

function fetchImplOf(opts) {
  if (opts && typeof opts.fetch === 'function') return opts.fetch;
  if (typeof globalThis !== 'undefined' && typeof globalThis.fetch === 'function') {
    return globalThis.fetch.bind(globalThis);
  }
  throw new Error('fetch is not available in this context');
}

/**
 * @param {{fetch?:Function, location?:{origin:string}}} [opts]
 * @returns {Promise<string|null>} bearer token, or null when logged out
 */
export async function getAccessToken(opts = {}) {
  const fetchImpl = fetchImplOf(opts);
  const origin = currentLocation(opts).origin || 'https://chatgpt.com';
  const res = await fetchImpl(`${origin}/api/auth/session`, {
    credentials: 'include',
    headers: { accept: 'application/json' },
  });
  if (!res || !res.ok) return null;
  let json;
  try { json = await res.json(); } catch { return null; }
  const token = json && (json.accessToken || json.access_token);
  return typeof token === 'string' && token.length > 0 ? token : null;
}

/**
 * @param {string} conversationId
 * @param {string|null} token
 * @param {{fetch?:Function, location?:{origin:string}}} [opts]
 * @returns {Promise<object>} raw conversation payload
 */
export async function fetchConversation(conversationId, token, opts = {}) {
  const fetchImpl = fetchImplOf(opts);
  const origin = currentLocation(opts).origin || 'https://chatgpt.com';
  const headers = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetchImpl(
    `${origin}/backend-api/conversation/${encodeURIComponent(conversationId)}`,
    { credentials: 'include', headers },
  );
  if (!res || !res.ok) {
    const status = res ? res.status : 0;
    const err = new Error(`backend-api/conversation returned ${status}`);
    err.status = status;
    throw err;
  }
  return res.json();
}

/**
 * Full API path. Resolves to a Conversation, or throws so extract.js can fall
 * back to the DOM.
 * @param {{conversationId?:string, fetch?:Function, location?:object}} [opts]
 * @returns {Promise<Conversation>}
 */
export async function extractViaApi(opts = {}) {
  const loc = currentLocation(opts);
  const sourceUrl = loc.href || '';
  const conversationId = opts.conversationId || parseConversationId(sourceUrl);
  if (!conversationId) throw new Error('No conversation id in URL');
  if (isShareUrl(sourceUrl)) throw new Error('Shared link: backend API is not available');

  let token = null;
  try {
    token = await getAccessToken(opts);
  } catch {
    token = null;
  }
  const payload = await fetchConversation(conversationId, token, opts);
  const conversation = mapConversationPayload(payload, {
    sourceUrl,
    conversationId,
    extractedVia: 'api',
  });
  if (!token) {
    conversation.warnings.push('No access token from /api/auth/session; used session cookies only.');
  }
  return conversation;
}
