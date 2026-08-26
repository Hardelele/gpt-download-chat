/**
 * api-client.js — claude.ai primary extraction path (Agent D).
 *
 * claude.ai has no bearer token in the page: the web app authenticates with the
 * `sessionKey` cookie, so a same-origin `fetch(..., {credentials:'include'})`
 * from a content script is enough.
 *
 *   GET /api/organizations
 *   GET /api/organizations/<org>/chat_conversations/<conv>?tree=True&rendering_mode=messages
 *
 * Everything below is written defensively: field names are probed in a
 * preference order rather than assumed, because this is a private API that
 * Anthropic changes without notice. Pure helpers take plain objects so they can
 * be unit-tested in Node with no DOM.
 */

export const API_HOSTS = ['claude.ai'];

/** Claude's sentinel parent uuid for the root of a conversation tree. */
export const ROOT_PARENT_UUID = '00000000-0000-4000-8000-000000000000';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/* ------------------------------------------------------------------ */
/* URL helpers                                                         */
/* ------------------------------------------------------------------ */

/**
 * Pull the conversation uuid out of a claude.ai URL.
 * Handles `/chat/<uuid>` and `/project/<uuid>/chat/<uuid>`.
 * @param {string} url
 * @returns {string|null}
 */
export function parseConversationId(url) {
  if (typeof url !== 'string' || !url) return null;
  let pathname = url;
  try {
    pathname = new URL(url, 'https://claude.ai').pathname;
  } catch {
    /* treat the raw string as a path */
  }
  const chat = /\/chat\/([0-9a-f-]{36})/i.exec(pathname);
  if (chat) return chat[1];
  // Some builds route straight to /<uuid> after a redirect.
  const bare = /^\/([0-9a-f-]{36})\/?$/i.exec(pathname);
  if (bare && UUID_RE.test(bare[1])) return bare[1];
  return null;
}

/**
 * Shared snapshots (`claude.ai/share/<uuid>`) are served by a different,
 * unauthenticated endpoint; the conversation API 404s for them.
 * @param {string} url
 */
export function isShareUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    return new URL(url, 'https://claude.ai').pathname.startsWith('/share/');
  } catch {
    return /\/share\//.test(url);
  }
}

/* ------------------------------------------------------------------ */
/* Small utilities                                                     */
/* ------------------------------------------------------------------ */

/** ISO-8601 (or epoch millis/seconds) -> unix seconds, or null. */
export function toUnixSeconds(value) {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e11 ? Math.floor(value / 1000) : Math.floor(value);
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function firstString(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v;
  }
  return null;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function absoluteUrl(url, origin) {
  if (typeof url !== 'string' || !url) return null;
  if (/^(https?:|data:|blob:)/i.test(url)) return url;
  const base = origin || 'https://claude.ai';
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

/* ------------------------------------------------------------------ */
/* Artifacts                                                           */
/* ------------------------------------------------------------------ */

/** Claude artifact mime types -> a fence language the renderer can use. */
const ARTIFACT_TYPE_LANGUAGE = {
  'application/vnd.ant.code': '',
  'application/vnd.ant.react': 'jsx',
  'application/vnd.ant.mermaid': 'mermaid',
  'text/markdown': 'markdown',
  'text/html': 'html',
  'image/svg+xml': 'svg',
};

/**
 * Is this `tool_use` block one of Claude's artifacts?
 * @param {object} block
 */
export function isArtifactBlock(block) {
  if (!block || block.type !== 'tool_use') return false;
  const name = typeof block.name === 'string' ? block.name.toLowerCase() : '';
  return name === 'artifacts' || name === 'artifact';
}

/**
 * Fold every artifact revision in a branch into its final content.
 *
 * One artifact is authored across *many* `tool_use` blocks, often spread over
 * several assistant turns: a `create` with the full body, then `update` blocks
 * carrying only `old_str`/`new_str`, and sometimes a `rewrite` with a fresh
 * body. Rendering each block would emit every intermediate draft, so we replay
 * them here and remember which block is the last one for each artifact id —
 * that is the only place the finished artifact gets rendered.
 *
 * @param {object[]} nodes  branch nodes, in order
 * @returns {Map<string, {id:string, content:string, title:string|null,
 *                        type:string|null, language:string|null,
 *                        lastKey:string|null, revisions:number}>}
 */
export function collectArtifacts(nodes) {
  const map = new Map();
  asArray(nodes).forEach((node, ni) => {
    const nodeKey = messageId(node) || `#${ni}`;
    asArray(node && node.content).forEach((block, bi) => {
      if (!isArtifactBlock(block)) return;
      const input = (block.input && typeof block.input === 'object') ? block.input : {};
      const id = firstString(input.id) || '__artifact__';
      const entry = map.get(id) || {
        id, content: '', title: null, type: null, language: null, lastKey: null, revisions: 0,
      };
      const command = typeof input.command === 'string' ? input.command : 'create';

      if (command === 'update' && typeof input.old_str === 'string' && typeof input.new_str === 'string') {
        // A *function* replacer, deliberately: `$&`, `` $` ``, `$'` and `$$`
        // inside new_str would otherwise be read as replacement patterns and
        // silently corrupt the artifact.
        entry.content = entry.content.replace(input.old_str, () => input.new_str);
      } else if (typeof input.content === 'string') {
        entry.content = input.content;
      } else if (typeof input.new_str === 'string') {
        entry.content = input.new_str;
      }

      if (firstString(input.title)) entry.title = input.title;
      if (firstString(input.type)) entry.type = input.type;
      if (firstString(input.language)) entry.language = input.language;
      entry.revisions += 1;
      entry.lastKey = `${nodeKey}|${bi}`;
      map.set(id, entry);
    });
  });
  return map;
}

/**
 * Render a folded artifact: a bold title line, then a fenced block that keeps
 * the artifact's language.
 * @param {{content:string, title:string|null, type:string|null,
 *          language:string|null, revisions:number}} entry
 * @returns {string|null}
 */
export function renderFoldedArtifact(entry) {
  if (!entry || typeof entry.content !== 'string' || !entry.content.trim()) return null;
  const language = firstString(entry.language, ARTIFACT_TYPE_LANGUAGE[entry.type]) || '';
  const heading = entry.title ? `**Artifact: ${entry.title}**` : '**Artifact**';
  const note = entry.revisions > 1
    ? `\n\n_Final version, after ${entry.revisions - 1} revision${entry.revisions > 2 ? 's' : ''}._`
    : '';
  return `${heading}${note}\n\n${fence(entry.content, language)}`;
}

/**
 * Render a single artifacts `tool_use` block in isolation — used when no folded
 * artifact map is available (direct callers, tests, malformed payloads).
 * @param {object} block
 * @returns {{text:string, title:string|null, language:string}|null}
 */
export function renderArtifact(block) {
  const input = (block && block.input && typeof block.input === 'object') ? block.input : {};
  const title = firstString(input.title, input.id);
  const language = firstString(
    input.language,
    ARTIFACT_TYPE_LANGUAGE[input.type],
  ) || '';
  const command = typeof input.command === 'string' ? input.command : 'create';

  let body = typeof input.content === 'string' ? input.content : '';
  let note = '';

  if (!body && typeof input.new_str === 'string') {
    // `command: "update"` sends a diff-ish pair instead of the whole file.
    body = input.new_str;
    note = typeof input.old_str === 'string' && input.old_str
      ? `_Artifact update — replaced:_\n\n${fence(input.old_str, language)}\n\n_with:_\n\n`
      : '_Artifact update._\n\n';
  }

  if (!body) return null;

  const heading = title
    ? `**${command === 'update' || command === 'rewrite' ? 'Artifact (updated)' : 'Artifact'}: ${title}**`
    : '**Artifact**';

  return {
    text: `${heading}\n\n${note}${fence(body, language)}`,
    title,
    language,
  };
}

/** Fence `body`, widening the fence if the body already contains backticks. */
export function fence(body, language) {
  const text = String(body == null ? '' : body);
  let ticks = '```';
  const runs = text.match(/`{3,}/g) || [];
  for (const run of runs) {
    if (run.length >= ticks.length) ticks = '`'.repeat(run.length + 1);
  }
  return `${ticks}${language || ''}\n${text.replace(/\n$/, '')}\n${ticks}`;
}

/* ------------------------------------------------------------------ */
/* Content blocks -> parts                                             */
/* ------------------------------------------------------------------ */

/**
 * @typedef {Object} Part
 * @property {'text'|'thoughts'|'code'|'tool'} kind
 * @property {string} text        already Markdown
 * @property {string|null} authorName
 * @property {boolean} hidden
 */

function toolResultText(block) {
  const content = block && block.content;
  if (typeof content === 'string') return content;
  const chunks = [];
  for (const item of asArray(content)) {
    if (typeof item === 'string') {
      chunks.push(item);
    } else if (item && item.type === 'knowledge') {
      // Share-snapshot payloads return search results as `knowledge` items.
      // Matching only `type === 'text'` here throws most of the payload away.
      const head = [item.title, item.url].filter(Boolean).join(' — ');
      chunks.push([head, item.text].filter(Boolean).join('\n'));
    } else if (item && typeof item.text === 'string') {
      chunks.push(item.text);
    } else if (item && item.type === 'image') {
      chunks.push('_(image result)_');
    } else if (item) {
      chunks.push(safeJson(item));
    }
  }
  return chunks.filter((c) => c && c.trim()).join('\n\n');
}

/**
 * Tools other than `artifacts` whose input carries real content the reader
 * wants, rather than plumbing worth dumping as JSON.
 * name -> [content field, language field or literal, title field]
 */
const CONTENT_TOOLS = {
  create_file: { body: 'file_text', title: 'path' },
  'visualize:show_widget': { body: 'widget_code', title: 'title', language: 'jsx' },
};

function renderContentTool(block) {
  const spec = CONTENT_TOOLS[block && block.name];
  if (!spec) return null;
  const input = (block.input && typeof block.input === 'object') ? block.input : {};
  const body = input[spec.body];
  if (typeof body !== 'string' || !body.trim()) return null;
  const title = firstString(input[spec.title]);
  const language = spec.language || languageFromPath(title) || '';
  return `**${block.name === 'create_file' ? 'File' : 'Widget'}${title ? `: ${title}` : ''}**\n\n${fence(body, language)}`;
}

const EXT_LANGUAGE = {
  js: 'javascript', mjs: 'javascript', ts: 'typescript', tsx: 'tsx', jsx: 'jsx',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin',
  c: 'c', h: 'c', cpp: 'cpp', cs: 'csharp', php: 'php', sh: 'bash', bash: 'bash',
  sql: 'sql', json: 'json', yml: 'yaml', yaml: 'yaml', toml: 'toml', xml: 'xml',
  html: 'html', css: 'css', scss: 'scss', md: 'markdown', csv: 'csv', r: 'r',
};

function languageFromPath(path) {
  if (typeof path !== 'string') return null;
  const m = /\.([a-z0-9]+)$/i.exec(path.trim());
  return m ? (EXT_LANGUAGE[m[1].toLowerCase()] || null) : null;
}

function safeJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * Turn a message's `content` block array into ordered parts.
 * The `text` blocks are already author-authored Markdown and pass through
 * untouched — they must never be round-tripped through HTML.
 *
 * @param {object[]} blocks
 * @param {{artifacts?:Map, messageKey?:string, warnings?:string[]}} [ctx]
 *        folded-artifact context from `collectArtifacts` (without it each
 *        artifact block renders alone), plus a sink for unknown-block warnings.
 * @returns {Part[]}
 */
export function renderContent(blocks, ctx = {}) {
  const parts = [];
  const artifactToolUseIds = new Set();
  const unknown = [];
  const list = asArray(blocks);

  for (let i = 0; i < list.length; i++) {
    const block = list[i];
    if (!block || typeof block !== 'object') continue;
    const type = typeof block.type === 'string' ? block.type : '';

    if (type === 'text' || type === 'voice_note') {
      const text = typeof block.text === 'string' ? block.text : '';
      const title = type === 'voice_note' ? firstString(block.title) : null;
      if (text.trim()) {
        parts.push({
          kind: 'text',
          text: title ? `**${title}**\n\n${text}` : text,
          authorName: null,
          hidden: false,
        });
      }
      continue;
    }

    if (type === 'thinking' || type === 'redacted_thinking') {
      const summaries = asArray(block.summaries)
        .map((s) => (typeof s === 'string' ? s : firstString(s && s.summary, s && s.text)))
        .filter(Boolean)
        .join('\n\n');
      // The reasoning lives in `thinking`. Reading `text` here yields nothing.
      const text = firstString(block.thinking, summaries, block.summary, block.text) || '';
      const cutOff = (block.cut_off === true || block.truncated === true)
        ? '\n\n_(thinking was cut off)_'
        : '';
      // Claude itself marks some reasoning as not for display.
      const suppressed = block.hidden === true || block.thinking_hidden === true;
      if (type === 'redacted_thinking' && !text.trim()) {
        parts.push({
          kind: 'thoughts', text: '_(redacted thinking)_', authorName: null, hidden: suppressed,
        });
      } else if (text.trim()) {
        parts.push({ kind: 'thoughts', text: text + cutOff, authorName: null, hidden: suppressed });
      }
      continue;
    }

    if (type === 'tool_use' || type === 'server_tool_use') {
      if (isArtifactBlock(block)) {
        artifactToolUseIds.add(block.id);
        const input = (block.input && typeof block.input === 'object') ? block.input : {};
        const artifactId = firstString(input.id) || '__artifact__';
        const entry = ctx.artifacts && ctx.artifacts.get(artifactId);
        if (entry) {
          // Only the final revision of each artifact is rendered, and only at
          // the block where that revision was written.
          if (entry.lastKey !== `${ctx.messageKey}|${i}`) continue;
          const text = renderFoldedArtifact(entry);
          if (text) parts.push({ kind: 'code', text, authorName: null, hidden: false });
          continue;
        }
        const artifact = renderArtifact(block);
        if (artifact) parts.push({ kind: 'code', text: artifact.text, authorName: null, hidden: false });
        continue;
      }

      const contentTool = renderContentTool(block);
      if (contentTool) {
        // The matching result is a bare "ok" — the content is already rendered.
        artifactToolUseIds.add(block.id);
        parts.push({ kind: 'code', text: contentTool, authorName: null, hidden: false });
        continue;
      }

      const name = firstString(block.name) || 'tool';
      const input = block.input === undefined ? '' : safeJson(block.input);
      parts.push({
        kind: 'tool',
        text: input ? `**Tool call — \`${name}\`**\n\n${fence(input, 'json')}` : `**Tool call — \`${name}\`**`,
        authorName: name,
        hidden: false,
      });
      continue;
    }

    if (type === 'tool_result' || type === 'web_search_tool_result') {
      // The echo Claude sends back after writing an artifact carries no
      // information the reader wants; the artifact itself is already rendered.
      if (artifactToolUseIds.has(block.tool_use_id)) continue;
      const name = firstString(block.name) || 'tool';
      const text = toolResultText(block);
      if (!text.trim()) continue;
      const isError = block.is_error === true;
      parts.push({
        kind: 'tool',
        text: `**Tool result — \`${name}\`${isError ? ' (error)' : ''}**\n\n${fence(text, '')}`,
        authorName: name,
        hidden: false,
      });
      continue;
    }

    if (type === 'image') {
      // Inline image blocks are surfaced through attachments instead.
      continue;
    }

    // Unknown block type. `tool_use`/`tool_result` did not appear at all in the
    // sampled conversations, so the type list above is certainly incomplete.
    // Never drop a block silently: render whatever it carries, and count it.
    const fallback = firstString(block.text, block.thinking, block.content)
      || (block.input === undefined ? null : safeJson(block.input))
      || safeJson(block);
    if (fallback && fallback.trim()) {
      parts.push({ kind: 'text', text: fallback, authorName: null, hidden: false });
    }
    unknown.push(type || '(untyped)');
  }

  if (unknown.length && Array.isArray(ctx.warnings)) {
    const kinds = Array.from(new Set(unknown)).join(', ');
    ctx.warnings.push(
      `Claude sent ${unknown.length} content block${unknown.length === 1 ? '' : 's'} of an `
      + `unrecognised type (${kinds}). They were exported as raw text rather than dropped, `
      + 'but they may not be formatted correctly.',
    );
  }

  return parts;
}

/* ------------------------------------------------------------------ */
/* Attachments                                                         */
/* ------------------------------------------------------------------ */

/**
 * Map a claude.ai message's `attachments` (documents) and `files` (images)
 * onto the contract's `Attachment[]`.
 * @param {object} apiMessage
 * @param {string} [origin]
 */
export function mapAttachments(apiMessage, origin) {
  const out = [];
  const msg = apiMessage || {};

  for (const a of asArray(msg.attachments)) {
    if (!a || typeof a !== 'object') continue;
    out.push({
      type: 'file',
      name: firstString(a.file_name, a.fileName, a.name),
      url: absoluteUrl(firstString(a.url, a.preview_url, a.download_url), origin),
      alt: firstString(a.file_type, a.fileType) || null,
    });
  }

  for (const f of asArray(msg.files).concat(asArray(msg.files_v2))) {
    if (!f || typeof f !== 'object') continue;
    const kind = firstString(f.file_kind, f.fileKind, f.file_type) || '';
    const isImage = /image/i.test(kind) || Boolean(f.preview_url || f.thumbnail_url);
    out.push({
      type: isImage ? 'image' : 'file',
      name: firstString(f.file_name, f.fileName, f.name),
      url: absoluteUrl(
        firstString(f.preview_url, f.thumbnail_url, f.url, f.document_asset && f.document_asset.url),
        origin,
      ),
      alt: firstString(f.file_name, f.fileName) || null,
    });
  }

  // De-duplicate: `files` and `files_v2` describe the same upload on some builds.
  const seen = new Set();
  return out.filter((a) => {
    const key = `${a.type}|${a.name || ''}|${a.url || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Markdown for the extracted text of each uploaded document on a message.
 * `attachments[]` carries no URL, so this content is not recoverable any other
 * way once the chat is exported.
 * @param {object} apiMessage
 * @returns {string[]}
 */
export function extractedAttachmentText(apiMessage) {
  const out = [];
  for (const a of asArray(apiMessage && apiMessage.attachments)) {
    if (!a || typeof a !== 'object') continue;
    const body = typeof a.extracted_content === 'string' ? a.extracted_content : '';
    if (!body.trim()) continue;
    const name = firstString(a.file_name, a.fileName, a.name) || 'attachment';
    const language = languageFromPath(name) || '';
    out.push(`**Attachment: ${name}**\n\n${fence(body, language)}`);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Branch reconstruction                                               */
/* ------------------------------------------------------------------ */

function messageId(node) {
  return firstString(node && node.uuid, node && node.id);
}

function parentId(node) {
  return firstString(
    node && node.parent_message_uuid,
    node && node.parentMessageUuid,
    node && node.parent_uuid,
    node && node.parent,
  );
}

/**
 * `tree=True` can come back nested (`children: []`). Flatten to a single list
 * where every node knows its parent, so one algorithm handles both shapes.
 * @param {object[]} nodes
 * @returns {object[]}
 */
export function flattenTree(nodes) {
  const out = [];
  const walk = (node, parent) => {
    if (!node || typeof node !== 'object') return;
    const children = asArray(node.children);
    const copy = children.length ? { ...node } : node;
    if (children.length) delete copy.children;
    if (!parentId(copy) && parent) copy.parent_message_uuid = parent;
    out.push(copy);
    for (const child of children) walk(child, messageId(node));
  };
  for (const node of asArray(nodes)) walk(node, null);
  return out;
}

/**
 * Reconstruct the active branch: leaf -> root via parent links, then reversed.
 * Never relies on array/hash order.
 *
 * @param {object[]} nodes      flat message nodes
 * @param {string|null} leafId  `current_leaf_message_uuid` when the payload has one
 * @returns {object[]} chronological root-to-leaf
 */
export function buildBranch(nodes, leafId) {
  const flat = flattenTree(nodes);
  if (!flat.length) return [];

  const byId = new Map();
  for (const node of flat) {
    const id = messageId(node);
    if (id) byId.set(id, node);
  }

  // No usable ids at all — the payload is a plain ordered list.
  if (!byId.size) return sortFlat(flat);

  const childCount = new Map();
  let hasParentLinks = false;
  for (const node of flat) {
    const pid = parentId(node);
    if (pid && pid !== ROOT_PARENT_UUID && byId.has(pid)) {
      hasParentLinks = true;
      childCount.set(pid, (childCount.get(pid) || 0) + 1);
    }
  }

  if (!hasParentLinks) return sortFlat(flat);

  let leaf = leafId && byId.get(leafId);
  if (!leaf) leaf = pickLeaf(flat, byId, childCount);
  if (!leaf) return sortFlat(flat);

  const branch = [];
  const guard = new Set();
  let cursor = leaf;
  while (cursor) {
    const id = messageId(cursor);
    if (id && guard.has(id)) break; // cycle guard
    if (id) guard.add(id);
    branch.push(cursor);
    const pid = parentId(cursor);
    if (!pid || pid === ROOT_PARENT_UUID) break;
    cursor = byId.get(pid);
  }
  branch.reverse();
  return branch;
}

/** Deepest / newest node that nobody claims as a parent. */
function pickLeaf(flat, byId, childCount) {
  const leaves = flat.filter((n) => {
    const id = messageId(n);
    return id && !childCount.get(id);
  });
  const pool = leaves.length ? leaves : flat;
  let best = null;
  let bestScore = -Infinity;
  for (const node of pool) {
    const depth = depthOf(node, byId);
    const time = toUnixSeconds(node.created_at) || 0;
    const idx = Number.isFinite(node.index) ? node.index : 0;
    const score = depth * 1e12 + time * 1e3 + idx;
    if (score > bestScore) {
      bestScore = score;
      best = node;
    }
  }
  return best;
}

function depthOf(node, byId) {
  let depth = 0;
  let cursor = node;
  const seen = new Set();
  while (cursor && depth < 10000) {
    const id = messageId(cursor);
    if (id) {
      if (seen.has(id)) break;
      seen.add(id);
    }
    const pid = parentId(cursor);
    if (!pid || pid === ROOT_PARENT_UUID) break;
    cursor = byId.get(pid);
    if (!cursor) break;
    depth += 1;
  }
  return depth;
}

function sortFlat(flat) {
  return flat.slice().sort((a, b) => {
    const ai = Number.isFinite(a.index) ? a.index : null;
    const bi = Number.isFinite(b.index) ? b.index : null;
    if (ai != null && bi != null && ai !== bi) return ai - bi;
    const at = toUnixSeconds(a.created_at) || 0;
    const bt = toUnixSeconds(b.created_at) || 0;
    return at - bt;
  });
}

/* ------------------------------------------------------------------ */
/* Node -> contract Message[]                                          */
/* ------------------------------------------------------------------ */

const SENDER_ROLE = { human: 'user', user: 'user', assistant: 'assistant', ai: 'assistant' };

/**
 * One claude.ai message becomes one *or more* contract messages: thinking and
 * tool traffic are separate entries so the shared renderer can gate them with
 * `includeThoughts` / `includeTools` instead of them being welded into the prose.
 *
 * @param {object} node
 * @param {{origin?:string, artifacts?:Map, index?:number, warnings?:string[]}} [opts]
 * @returns {import('./extract.js').Message[]}
 */
export function nodeToMessages(node, opts = {}) {
  if (!node || typeof node !== 'object') return [];

  const sender = typeof node.sender === 'string' ? node.sender.toLowerCase() : '';
  const role = SENDER_ROLE[sender] || (typeof node.role === 'string' && SENDER_ROLE[node.role]) || 'assistant';
  const createTime = toUnixSeconds(node.created_at || node.createdAt || node.timestamp);
  const baseId = messageId(node);
  const attachments = mapAttachments(node, opts.origin);

  const warnings = Array.isArray(opts.warnings) ? opts.warnings : null;
  const parts = renderContent(node.content, {
    artifacts: opts.artifacts,
    messageKey: baseId || `#${opts.index == null ? 0 : opts.index}`,
    warnings,
  });

  if (node.truncated === true && warnings) {
    warnings.push('Claude reported one message as truncated; its text may be incomplete.');
  }

  // `text` and `content[]` coexist: under `rendering_mode=messages` `text` is
  // usually empty, but an agent turn can carry its final answer in `text` while
  // `content[]` holds only thinking and tool blocks. So fold it in whenever it
  // is not already part of the rendered prose — never short-circuit on it.
  const legacy = typeof node.text === 'string' ? node.text.trim() : '';
  if (legacy) {
    const prose = parts.filter((p) => p.kind === 'text').map((p) => p.text).join('\n');
    if (!prose.includes(legacy)) {
      parts.push({ kind: 'text', text: legacy, authorName: null, hidden: false });
    }
  }

  // `attachments[].extracted_content` is the actual text of a pasted or
  // uploaded document, and there is no URL to link to instead. Dropping it
  // would export "here is my spec, review it" without the spec.
  for (const extracted of extractedAttachmentText(node)) {
    parts.push({ kind: 'text', text: extracted, authorName: null, hidden: false });
  }

  // Merge adjacent prose so a message split across several text blocks reads
  // as one turn.
  const merged = [];
  for (const part of parts) {
    const prev = merged[merged.length - 1];
    if (part.kind === 'text' && prev && prev.kind === 'text') {
      prev.text = `${prev.text}\n\n${part.text}`;
    } else {
      merged.push({ ...part });
    }
  }

  if (!merged.length) {
    if (!attachments.length) return [];
    merged.push({ kind: 'text', text: '', authorName: null, hidden: false });
  }

  let attachmentsPlaced = false;
  const out = [];
  merged.forEach((part, i) => {
    const isTool = part.kind === 'tool';
    const own = [];
    if (!attachmentsPlaced && !isTool && part.kind !== 'thoughts') {
      own.push(...attachments);
      attachmentsPlaced = true;
    }

    let contentType = 'text';
    if (part.kind === 'thoughts') contentType = 'thoughts';
    else if (part.kind === 'code') contentType = 'code';
    else if (part.kind === 'tool') contentType = 'other';
    else if (own.length) contentType = 'multimodal';

    out.push({
      id: baseId ? (i === 0 ? baseId : `${baseId}#${i + 1}`) : null,
      role: isTool ? 'tool' : role,
      authorName: isTool ? part.authorName : null,
      createTime,
      contentType,
      text: part.text.trim(),
      attachments: own,
      // NOTE: `hidden` is gated by `includeSystem` in the shared renderer, so
      // thoughts and tool traffic stay unhidden and are gated by their own
      // options (`includeThoughts` / `includeTools`) instead. The exception is
      // reasoning Claude itself flagged `hidden`/`thinking_hidden`.
      hidden: part.hidden === true || role === 'system',
    });
  });

  if (!attachmentsPlaced && attachments.length && out.length) {
    out[0].attachments = attachments;
    if (out[0].contentType === 'text') out[0].contentType = 'multimodal';
  }

  return out.filter((m) => m.text || m.attachments.length);
}

/* ------------------------------------------------------------------ */
/* Payload -> Conversation                                             */
/* ------------------------------------------------------------------ */

/**
 * Map a raw `chat_conversations/<uuid>` payload onto the contract Conversation.
 * Pure — no network, no DOM. This is the function the tests exercise.
 *
 * @param {object} payload
 * @param {{sourceUrl?:string, conversationId?:string, origin?:string, warnings?:string[]}} [opts]
 * @returns {import('./extract.js').Conversation}
 */
export function mapConversationPayload(payload, opts = {}) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const warnings = opts.warnings || [];

  const rawNodes = asArray(p.chat_messages).length
    ? asArray(p.chat_messages)
    : asArray(p.messages);

  const leafId = firstString(
    p.current_leaf_message_uuid,
    p.currentLeafMessageUuid,
    p.current_leaf_message_id,
  );

  const branch = buildBranch(rawNodes, leafId);
  const flatCount = flattenTree(rawNodes).length;
  if (flatCount && branch.length && branch.length < flatCount) {
    warnings.push(
      `This conversation has edited/regenerated branches — exported the active branch `
      + `(${branch.length} of ${flatCount} stored messages).`,
    );
  }

  // Artifacts are authored across many blocks and many turns; fold them first
  // so only the finished version of each is rendered.
  const artifacts = collectArtifacts(branch);

  // No pagination has been observed on this endpoint, but an array whose length
  // is exactly a round number is the shape a silent limit would take.
  const ROUND_LIMITS = [20, 25, 50, 100, 200, 500, 1000];
  if (ROUND_LIMITS.includes(flatCount)) {
    warnings.push(
      `Claude returned exactly ${flatCount} messages. That is a suspiciously round number — `
      + 'if this conversation is longer, the export may be missing the rest.',
    );
  }

  const messages = [];
  branch.forEach((node, index) => {
    try {
      messages.push(...nodeToMessages(node, { origin: opts.origin, artifacts, index, warnings }));
    } catch (err) {
      warnings.push(`Skipped one message that could not be read (${err && err.message ? err.message : err}).`);
    }
  });

  // One warning per distinct problem, not one per message.
  const deduped = [];
  for (const w of warnings) if (!deduped.includes(w)) deduped.push(w);
  warnings.length = 0;
  warnings.push(...deduped);

  const model = firstString(p.model, p.settings && p.settings.model)
    || lastModel(branch)
    || null;

  return {
    id: firstString(p.uuid, p.id, opts.conversationId) || 'unknown',
    title: firstString(p.name, p.title, p.summary) || 'Claude conversation',
    createTime: toUnixSeconds(p.created_at || p.createdAt),
    updateTime: toUnixSeconds(p.updated_at || p.updatedAt),
    model,
    sourceUrl: opts.sourceUrl || '',
    extractedVia: 'api',
    messages,
    warnings,
  };
}

function lastModel(branch) {
  for (let i = branch.length - 1; i >= 0; i--) {
    const m = firstString(branch[i] && branch[i].model);
    if (m) return m;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Network                                                             */
/* ------------------------------------------------------------------ */

const JSON_HEADERS = {
  accept: 'application/json',
  'content-type': 'application/json',
  // claude.ai's own client sends these; harmless on a same-origin GET and it
  // keeps us indistinguishable from a normal page request.
  'anthropic-client-platform': 'web_claude_ai',
};

async function getJson(url, opts = {}) {
  const doFetch = opts.fetch || (typeof globalThis !== 'undefined' && globalThis.fetch);
  if (typeof doFetch !== 'function') throw new Error('fetch is not available');
  const res = await doFetch(url, {
    method: 'GET',
    credentials: 'include',
    headers: JSON_HEADERS,
    ...(opts.init || {}),
  });
  if (!res || !res.ok) {
    const status = res ? res.status : 'no response';
    throw new Error(`${url.replace(/^https?:\/\/[^/]+/, '')} -> HTTP ${status}`);
  }
  return res.json();
}

/**
 * Candidate organization uuids for the signed-in user, best first.
 * Orgs whose capabilities mention chat come before API-only (Console) orgs.
 *
 * @param {{fetch?:Function, origin?:string}} [opts]
 * @returns {Promise<string[]>}
 */
export async function listOrganizationIds(opts = {}) {
  const origin = opts.origin || 'https://claude.ai';
  const seen = new Set();
  const out = [];
  const push = (id) => {
    const v = firstString(id);
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  };

  // 1. The `lastActiveOrg` cookie — free, no request, and it is the org the
  //    user is actually looking at.
  push(readCookie('lastActiveOrg', opts.cookie));

  // 2. /api/bootstrap. This is what claude.ai's own client uses; it names the
  //    active membership directly, which /api/organizations does not.
  try {
    const boot = await getJson(`${origin}/api/bootstrap`, opts);
    for (const m of asArray(boot && boot.account && boot.account.memberships)) {
      push(m && m.organization && (m.organization.uuid || m.organization.id));
    }
  } catch { /* older or changed build: fall through */ }

  // 3. /api/organizations. Measured on a real account: this returns TWO orgs,
  //    one with capabilities ["chat","claude_max"] holding the conversations
  //    and one with ["api","api_individual"] holding none. Taking orgs[0] is a
  //    coin flip, so scan capabilities and put chat-capable orgs first.
  try {
    const orgs = asArray(await getJson(`${origin}/api/organizations`, opts))
      .filter((o) => o && firstString(o.uuid, o.id));
    const score = (o) => {
      const caps = asArray(o.capabilities).map((c) => String(c).toLowerCase());
      let s = 0;
      if (caps.includes('chat')) s += 100;
      if (caps.some((c) => c.startsWith('claude_'))) s += 10;
      if (caps.some((c) => c === 'api' || c.startsWith('api_')) && !caps.includes('chat')) s -= 50;
      if (o.active_flags || o.is_active) s += 5;
      return s;
    };
    for (const o of orgs.slice().sort((a, b) => score(b) - score(a))) push(o.uuid || o.id);
  } catch (err) {
    if (!out.length) throw err;
  }

  return out;
}

/** Read one cookie value; `jar` lets tests inject a cookie string. */
export function readCookie(name, jar) {
  const raw = typeof jar === 'string'
    ? jar
    : (typeof globalThis !== 'undefined' && globalThis.document
      && typeof globalThis.document.cookie === 'string' ? globalThis.document.cookie : '');
  if (!raw) return null;
  for (const pair of raw.split(';')) {
    const i = pair.indexOf('=');
    if (i === -1) continue;
    if (pair.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(pair.slice(i + 1).trim()) || null;
      } catch {
        return pair.slice(i + 1).trim() || null;
      }
    }
  }
  return null;
}

/**
 * Fetch one conversation, trying each candidate org until one resolves it.
 *
 * @param {string} conversationId
 * @param {{fetch?:Function, origin?:string, organizationId?:string, warnings?:string[]}} [opts]
 * @returns {Promise<object>} raw payload
 */
export async function fetchConversation(conversationId, opts = {}) {
  const origin = opts.origin || 'https://claude.ai';

  // `tree=True` is what makes the response carry every branch; without it the
  // server picks a linear path for us. `render_all_tools` keeps tool and
  // artifact blocks from being elided.
  const query = 'tree=True&rendering_mode=messages&render_all_tools=true'
    + '&skip_uuid_injection=true&consistency=strong';

  const tried = new Set();
  let lastError = null;

  const attempt = async (orgId) => {
    if (!orgId || tried.has(orgId)) return null;
    tried.add(orgId);
    const url = `${origin}/api/organizations/${orgId}/chat_conversations/${conversationId}?${query}`;
    try {
      const payload = await getJson(url, opts);
      if (payload && typeof payload === 'object') return payload;
      lastError = new Error('empty conversation payload');
    } catch (err) {
      lastError = err;
    }
    return null;
  };

  if (opts.organizationId) {
    const direct = await attempt(opts.organizationId);
    if (direct) return direct;
    throw lastError || new Error('conversation could not be fetched');
  }

  // The `lastActiveOrg` cookie costs nothing and is usually right — try it
  // before spending a round trip on discovery.
  const hinted = await attempt(readCookie('lastActiveOrg', opts.cookie));
  if (hinted) return hinted;

  let orgIds = [];
  try {
    orgIds = await listOrganizationIds({ ...opts, origin });
  } catch (err) {
    throw lastError || err;
  }
  if (!orgIds.length && !tried.size) throw new Error('no organization found for this session');

  for (const orgId of orgIds) {
    const payload = await attempt(orgId);
    if (payload) return payload;
  }
  throw lastError || new Error('conversation could not be fetched');
}

/**
 * Snapshot id out of a `claude.ai/share/<uuid>` URL.
 * @param {string} url
 * @returns {string|null}
 */
export function parseSnapshotId(url) {
  if (typeof url !== 'string' || !url) return null;
  let pathname = url;
  try {
    pathname = new URL(url, 'https://claude.ai').pathname;
  } catch { /* treat as a path */ }
  const m = /\/share\/([0-9a-f-]{36})/i.exec(pathname);
  return m ? m[1] : null;
}

/**
 * Shared conversations are served by their own endpoint, which needs no org and
 * no session. Much better than scraping the snapshot page.
 *
 * @param {string} snapshotId
 * @param {{fetch?:Function, origin?:string}} [opts]
 * @returns {Promise<object>} raw payload
 */
export async function fetchSnapshot(snapshotId, opts = {}) {
  const origin = opts.origin || 'https://claude.ai';
  const url = `${origin}/api/chat_snapshots/${snapshotId}`
    + '?rendering_mode=messages&render_all_tools=true';
  const payload = await getJson(url, opts);
  // Some builds wrap the conversation one level down.
  if (payload && typeof payload === 'object' && !payload.chat_messages && payload.conversation) {
    return payload.conversation;
  }
  return payload;
}

/**
 * Full API path for a shared snapshot link.
 * @param {{fetch?:Function, location?:object, snapshotId?:string}} [opts]
 * @returns {Promise<import('./extract.js').Conversation>}
 */
export async function extractSnapshotViaApi(opts = {}) {
  const loc = opts.location
    || (typeof globalThis !== 'undefined' && globalThis.location)
    || { href: '', origin: 'https://claude.ai' };
  const origin = loc.origin || 'https://claude.ai';
  const sourceUrl = loc.href || '';
  const snapshotId = opts.snapshotId || parseSnapshotId(sourceUrl);
  if (!snapshotId) throw new Error('no snapshot id in the URL');

  const warnings = [];
  const payload = await fetchSnapshot(snapshotId, { ...opts, origin });
  return mapConversationPayload(payload, {
    sourceUrl, conversationId: snapshotId, origin, warnings,
  });
}

/**
 * Full API path: resolve the org, fetch the conversation, map it.
 *
 * @param {{conversationId?:string, fetch?:Function, location?:object,
 *          organizationId?:string}} [opts]
 * @returns {Promise<import('./extract.js').Conversation>}
 */
export async function extractViaApi(opts = {}) {
  const loc = opts.location
    || (typeof globalThis !== 'undefined' && globalThis.location)
    || { href: '', origin: 'https://claude.ai' };
  const origin = loc.origin || 'https://claude.ai';
  const sourceUrl = loc.href || '';
  const conversationId = opts.conversationId || parseConversationId(sourceUrl);
  if (!conversationId) throw new Error('no conversation id in the URL');

  const warnings = [];
  const payload = await fetchConversation(conversationId, { ...opts, origin, warnings });
  return mapConversationPayload(payload, { sourceUrl, conversationId, origin, warnings });
}

export default extractViaApi;
