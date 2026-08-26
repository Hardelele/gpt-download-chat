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

  const rendered = renderContent(msg.content, msg);
  const { contentType, attachments } = rendered;
  // Code is kept byte-exact; prose gets the invisible citation junk stripped.
  const text = contentType === 'code' ? rendered.text : sanitizeText(rendered.text);

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

/**
 * ChatGPT wraps search citations in private-use-area control characters
 * (U+E200–U+E20F and friends) that render as tofu boxes in a text editor, and
 * sprinkles zero-width joiners into streamed text. Strip both; keep everything
 * else byte-for-byte.
 * @param {string} text
 */
export function sanitizeText(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/[\uE000-\uF8FF]/g, '')             // private-use area (citation markers)
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')  // zero-width joiners / BOM
    .replace(/\u00A0/g, ' ');                   // non-breaking space to plain space
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

    // Result of a code / tool run. Observed live on every conversation that used
    // python, web.run or container.exec. Render it as a plain fenced block; the
    // role ('tool') and the hidden flag decide whether the renderer shows it.
    case 'execution_output': {
      const body = typeof content.text === 'string' ? content.text
        : typeof content.result === 'string' ? content.result
          : stringifyUnknown(content);
      if (!String(body).trim()) return { text: '', contentType: 'other', attachments };
      return { text: fence(body, ''), contentType: 'code', attachments };
    }

    case 'tether_quote':
    case 'tether_browsing_display':
    case 'system_error': {
      const body = typeof content.text === 'string' ? content.text
        : typeof content.result === 'string' ? content.result
          : stringifyUnknown(content);
      if (!String(body).trim()) return { text: '', contentType: 'other', attachments };
      return { text: fence(body, ''), contentType: 'other', attachments };
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

/** True when the node is not explicitly flagged hidden and is not a system message. */
function meta_isNotHidden(msg) {
  const meta = (msg && msg.metadata) || {};
  const role = String((msg && msg.author && msg.author.role) || '').toLowerCase();
  return meta.is_visually_hidden_from_conversation !== true && role !== 'system';
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
    for (const extra of metadataAttachments(node.message)) {
      const existing = msg.attachments.find((a) => a.url && a.url === extra.url);
      if (existing) {
        // The metadata block carries the real filename; the content part carries the pointer.
        if (extra.name) existing.name = extra.name;
        if (!existing.alt && extra.name) existing.alt = extra.name;
      } else {
        msg.attachments.push(extra);
      }
    }
    if (msg.hidden && msg.attachments.length && meta_isNotHidden(node.message)) msg.hidden = false;
    messages.push(msg);
  }

  const totalNodes = Object.keys(mapping).filter((k) => mapping[k] && mapping[k].message).length;
  if (totalNodes > messages.length && messages.length) {
    warnings.push(
      `Conversation has ${totalNodes - messages.length} message(s) outside the active branch `
      + '(edited prompts / regenerated answers); only the active branch was exported.',
    );
  }

  // The conversation object carries `default_model_slug` (observed live, e.g.
  // "gpt-5-6-thinking"); it is the authoritative answer. The per-message
  // `metadata.model_slug` scan is the fallback for older payloads.
  let model = typeof data.default_model_slug === 'string' && data.default_model_slug.trim()
    ? data.default_model_slug.trim()
    : null;
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
/* Embedded payload (shared links)                                     */
/* ------------------------------------------------------------------ */

/** Does this object look like a conversation payload? */
function looksLikeConversation(value) {
  return Boolean(
    value && typeof value === 'object' && !Array.isArray(value)
    && value.mapping && typeof value.mapping === 'object'
    && Object.keys(value.mapping).length > 0,
  );
}

function searchForConversation(value, depth = 0) {
  if (depth > 8 || !value || typeof value !== 'object') return null;
  if (looksLikeConversation(value)) return value;
  const children = Array.isArray(value) ? value : Object.values(value);
  for (const child of children) {
    const found = searchForConversation(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function tryParseJson(text) {
  try { return JSON.parse(text); } catch { /* fall through */ }
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first === -1 || last <= first) return null;
  try { return JSON.parse(text.slice(first, last + 1)); } catch { return null; }
}

/**
 * `/share/<id>` pages have no reachable backend endpoint, but the server ships
 * the very same conversation JSON inside a <script> tag. Reading it gives full
 * fidelity (timestamps, model, branch structure) instead of scraped HTML.
 *
 * @param {Document} doc
 * @returns {object|null} raw conversation payload
 */
export function findEmbeddedPayload(doc) {
  if (!doc || typeof doc.querySelectorAll !== 'function') return null;
  let scripts;
  try { scripts = Array.prototype.slice.call(doc.querySelectorAll('script')); } catch { return null; }
  for (const script of scripts) {
    const text = script && typeof script.textContent === 'string' ? script.textContent : '';
    if (!text || text.length < 40 || !text.includes('"mapping"')) continue;
    const parsed = tryParseJson(text);
    if (!parsed) continue;
    const found = searchForConversation(parsed);
    if (found) return found;
  }
  return null;
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
 * Pick the workspace account id out of /backend-api/accounts/check/v4-2023-04-27.
 * Team / Enterprise workspaces need it on the conversation call; personal
 * accounts ignore it. Prefers a non-personal workspace when the user has both.
 * @param {object} payload
 * @returns {string|null}
 */
export function pickAccountId(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const accounts = payload.accounts && typeof payload.accounts === 'object' ? payload.accounts : null;
  if (!accounts) return null;
  const ordering = Array.isArray(payload.account_ordering) ? payload.account_ordering : [];
  const keys = ordering.concat(Object.keys(accounts).filter((k) => !ordering.includes(k)));
  let personal = null;
  for (const key of keys) {
    const entry = accounts[key];
    const account = (entry && (entry.account || entry)) || null;
    const id = account && (account.account_id || account.id);
    if (!id) continue;
    const structure = String((account && account.structure) || '').toLowerCase();
    const isPersonal = key === 'default' || structure === 'personal';
    if (!isPersonal) return String(id);
    if (!personal) personal = String(id);
  }
  return personal;
}

/**
 * @param {{fetch?:Function, location?:{origin:string}, token?:string|null}} [opts]
 * @returns {Promise<string|null>} account id, or null (never throws)
 */
export async function getAccountId(opts = {}) {
  try {
    const fetchImpl = fetchImplOf(opts);
    const origin = currentLocation(opts).origin || 'https://chatgpt.com';
    const res = await fetchImpl(`${origin}/backend-api/accounts/check/v4-2023-04-27`, {
      credentials: 'include',
      headers: authHeaders(opts.token),
    });
    if (!res || !res.ok) return null;
    return pickAccountId(await res.json());
  } catch {
    return null;
  }
}

/**
 * Header set for backend-api calls. Cookies alone are accepted today (verified
 * live), so the token is strictly an upgrade — never a precondition. Both
 * `Authorization` and `X-Authorization` are sent because ChatGPT's own edge has
 * accepted either at different times.
 * @param {string|null|undefined} token
 * @param {string|null|undefined} accountId
 */
export function authHeaders(token, accountId) {
  const headers = { accept: 'application/json' };
  if (token) {
    headers.authorization = `Bearer ${token}`;
    headers['x-authorization'] = `Bearer ${token}`;
  }
  if (accountId) headers['chatgpt-account-id'] = String(accountId);
  return headers;
}

/**
 * @param {string} conversationId
 * @param {string|null} token
 * @param {{fetch?:Function, location?:{origin:string}, accountId?:string|null}} [opts]
 * @returns {Promise<object>} raw conversation payload
 */
export async function fetchConversation(conversationId, token, opts = {}) {
  const fetchImpl = fetchImplOf(opts);
  const origin = currentLocation(opts).origin || 'https://chatgpt.com';
  const headers = authHeaders(token, opts.accountId);
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

  // A missing token is NOT a failure: cookies alone are accepted by
  // /backend-api today, so we always attempt the call. Bailing to the DOM here
  // would throw away a working request.
  let token = null;
  try {
    token = await getAccessToken(opts);
  } catch {
    token = null;
  }

  // Workspace id — only Team/Enterprise users need it, and the probe is allowed
  // to fail silently.
  const accountId = opts.accountId !== undefined
    ? opts.accountId
    : await getAccountId({ ...opts, token });

  const payload = await fetchConversation(conversationId, token, { ...opts, accountId });
  const conversation = mapConversationPayload(payload, {
    sourceUrl,
    conversationId,
    extractedVia: 'api',
  });
  if (!token) {
    conversation.warnings.push(
      'No access token from /api/auth/session — the conversation was fetched with session cookies only.',
    );
  }
  return conversation;
}
