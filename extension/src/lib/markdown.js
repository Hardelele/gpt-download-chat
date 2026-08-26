/**
 * markdown.js — renders a Conversation (see CONTRACT.md) into a Markdown document.
 *
 * Owner: Agent B. No dependencies, no DOM, no chrome.* — a pure function usable from
 * the service worker, the popup and `node --test`.
 *
 * Core promise: `message.text` is ALREADY Markdown. It is passed through verbatim.
 * The only things done to it are cosmetic whitespace normalisation (outside code
 * fences) and auto-closing an unterminated fence, so one bad message cannot swallow
 * the rest of the document.
 */

export const EXPORTER_NAME = 'Chat2MD';
export const EXPORTER_VERSION = '0.1.0';

/**
 * @typedef {Object} RenderOptions
 * @property {boolean} frontmatter
 * @property {boolean} timestamps
 * @property {boolean} includeSystem
 * @property {boolean} includeTools
 * @property {boolean} includeThoughts
 * @property {'h2'|'bold'} headingStyle
 * @property {string} userLabel
 * @property {string} assistantLabel
 */

/** @type {RenderOptions} */
export const DEFAULT_OPTIONS = Object.freeze({
  frontmatter: true,
  timestamps: false,
  includeSystem: false,
  includeTools: false,
  includeThoughts: false,
  headingStyle: 'h2',
  userLabel: 'You',
  assistantLabel: 'ChatGPT',
});

const FALLBACK_TITLE = 'ChatGPT conversation';

/* eslint-disable no-control-regex */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const CONTROL_CHARS_AND_NEWLINES = /[\u0000-\u001F\u007F]/g;
/* eslint-enable no-control-regex */

/* ------------------------------------------------------------------ *
 * public API
 * ------------------------------------------------------------------ */

/**
 * @param {object|null|undefined} conversation a Conversation per CONTRACT.md
 * @param {Partial<RenderOptions>} [opts]
 * @returns {string} a Markdown document, always ending in exactly one "\n"
 */
export function toMarkdown(conversation, opts) {
  const o = resolveOptions(opts);
  const c = conversation && typeof conversation === 'object' ? conversation : {};

  const title = nonEmptyString(c.title) || FALLBACK_TITLE;
  const messages = Array.isArray(c.messages) ? c.messages : [];
  const visible = messages.filter((m) => m && typeof m === 'object' && shouldRender(m, o));

  // One decision for the whole document, so the section structure stays consistent:
  // if any turn body could be mistaken for a turn heading, every turn gets a rule.
  const useRules = visible.some((m) => bodyCollidesWithHeading(m.text, o.headingStyle));

  const blocks = [];

  if (o.frontmatter) blocks.push(renderFrontmatter(c, title, visible.length, o));

  blocks.push(`# ${headingSafe(title)}`);

  visible.forEach((m, i) => {
    if (useRules && i > 0) blocks.push('---');
    blocks.push(renderMessage(m, o));
  });

  if (visible.length === 0) blocks.push('*(no messages)*');

  const warnings = Array.isArray(c.warnings) ? c.warnings.filter((w) => nonEmptyString(w)) : [];
  if (warnings.length) {
    blocks.push('---');
    blocks.push(
      ['> **Export notes**', '>', ...warnings.map((w) => `> - ${headingSafe(w)}`)].join('\n'),
    );
  }

  return blocks.filter((b) => b !== '').join('\n\n').replace(/\s+$/, '') + '\n';
}

/* ------------------------------------------------------------------ *
 * options
 * ------------------------------------------------------------------ */

function resolveOptions(opts) {
  const src = opts && typeof opts === 'object' ? opts : {};
  const o = { ...DEFAULT_OPTIONS };
  for (const key of Object.keys(DEFAULT_OPTIONS)) {
    if (src[key] === undefined || src[key] === null) continue;
    const def = DEFAULT_OPTIONS[key];
    if (typeof def === 'boolean') o[key] = Boolean(src[key]);
    else if (typeof def === 'string') o[key] = String(src[key]);
  }
  if (o.headingStyle !== 'bold') o.headingStyle = 'h2';
  if (!o.userLabel.trim()) o.userLabel = DEFAULT_OPTIONS.userLabel;
  if (!o.assistantLabel.trim()) o.assistantLabel = DEFAULT_OPTIONS.assistantLabel;
  // internal, test-only: pins the `exported:` stamp
  if (src.now !== undefined && src.now !== null) o.now = src.now;
  return o;
}

/* ------------------------------------------------------------------ *
 * message selection
 * ------------------------------------------------------------------ */

function shouldRender(m, o) {
  if (m.contentType === 'thoughts' && !o.includeThoughts) return false;
  if (m.role === 'system' && !o.includeSystem) return false;
  if (m.role === 'tool' && !o.includeTools) return false;
  // `hidden` is plumbing: custom instructions, memory injections, tether markers.
  if (m.hidden === true && !o.includeSystem) return false;

  const hasText = nonEmptyString(m.text) !== '';
  const hasAttachments = Array.isArray(m.attachments) && m.attachments.length > 0;
  return hasText || hasAttachments;
}

/* ------------------------------------------------------------------ *
 * frontmatter
 * ------------------------------------------------------------------ */

function renderFrontmatter(c, title, messageCount, o) {
  const lines = ['---'];
  const put = (key, value) => {
    if (value === null || value === undefined) return; // never emit a bare `null`
    lines.push(`${key}: ${value}`);
  };

  put('title', yamlString(title));
  put('source', maybeYamlString(c.sourceUrl));
  put('model', maybeYamlString(c.model));
  put('created', isoFromUnix(c.createTime));
  put('updated', isoFromUnix(c.updateTime));
  put('messages', String(messageCount));
  put('exported', nowIso(o));
  put('exported_with', yamlString(`${EXPORTER_NAME} v${EXPORTER_VERSION}`));

  lines.push('---');
  return lines.join('\n');
}

function nowIso(o) {
  const d = o && o.now !== undefined ? new Date(o.now) : new Date();
  const safe = Number.isNaN(d.getTime()) ? new Date() : d;
  return safe.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Unix seconds (tolerating milliseconds) -> "2026-08-26T10:04:11Z", or null. */
function isoFromUnix(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const ms = value > 1e11 ? value : value * 1000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function maybeYamlString(value) {
  const s = nonEmptyString(value);
  return s === '' ? null : yamlString(s);
}

/** Always double-quoted, always safe to hand to a YAML parser. */
function yamlString(value) {
  const escaped = String(value)
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_CHARS, '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\t/g, '\\t')
    .replace(/\n/g, '\\n');
  return `"${escaped}"`;
}

/* ------------------------------------------------------------------ *
 * messages
 * ------------------------------------------------------------------ */

function renderMessage(m, o) {
  const parts = [heading(labelFor(m, o), o.headingStyle)];

  if (o.timestamps) {
    const ts = isoFromUnix(m.createTime);
    if (ts) parts.push(`*${ts}*`);
  }

  const body = tidyBody(m.text);
  if (body) parts.push(body);

  const attachments = renderAttachments(m.attachments);
  if (attachments) parts.push(attachments);

  return parts.join('\n\n');
}

function heading(label, style) {
  return style === 'bold' ? `**${headingSafe(label)}**` : `## ${headingSafe(label)}`;
}

function labelFor(m, o) {
  switch (m.role) {
    case 'user':
      return o.userLabel;
    case 'assistant':
      return m.contentType === 'thoughts' ? `${o.assistantLabel} (thinking)` : o.assistantLabel;
    case 'system':
      return 'System';
    case 'tool': {
      const name = nonEmptyString(m.authorName);
      return name ? `Tool: ${name}` : 'Tool';
    }
    default:
      return nonEmptyString(m.authorName) || nonEmptyString(m.role) || 'Message';
  }
}

/* ------------------------------------------------------------------ *
 * attachments
 * ------------------------------------------------------------------ */

function renderAttachments(list) {
  if (!Array.isArray(list) || list.length === 0) return '';
  return list
    .filter((a) => a && typeof a === 'object')
    .map(renderAttachment)
    .filter(Boolean)
    .join('\n\n');
}

function renderAttachment(a) {
  const isImage = a.type === 'image';
  const kind = isImage ? 'image' : 'file';
  const name = nonEmptyString(a.name) || nonEmptyString(a.alt) || kind;
  const url = nonEmptyString(a.url);

  // file-service:// (and friends) are opaque backend pointers: a Markdown reader
  // cannot resolve them, so a link would be a dead link. Say so instead.
  if (!isRenderableUrl(url)) return `*(${kind}: ${headingSafe(name)} — not exportable)*`;

  const label = labelSafe(isImage ? nonEmptyString(a.alt) || name : name);
  return `${isImage ? '!' : ''}[${label}](${linkTarget(url)})`;
}

function isRenderableUrl(url) {
  return url !== '' && /^(https?:\/\/|data:)/i.test(url);
}

function linkTarget(url) {
  const clean = url.replace(/\s/g, '%20').replace(/</g, '%3C').replace(/>/g, '%3E');
  return /[()]/.test(clean) ? `<${clean}>` : clean;
}

/* ------------------------------------------------------------------ *
 * body normalisation (fence-aware)
 * ------------------------------------------------------------------ */

/**
 * Cosmetic clean-up only:
 *  - CRLF -> LF
 *  - trailing whitespace stripped outside code fences (a 2+ space hard break is
 *    preserved as exactly two spaces)
 *  - at most 2 consecutive blank lines outside code fences
 *  - an unterminated code fence is closed
 * Everything inside a fence is left byte-for-byte alone.
 */
function tidyBody(text) {
  if (typeof text !== 'string' || text === '') return '';
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let fence = null;
  let blanks = 0;

  for (const raw of lines) {
    if (fence !== null) {
      out.push(raw);
      if (isFenceClose(raw, fence)) fence = null;
      continue;
    }

    const open = openingFence(raw);
    if (open) {
      out.push(trimEnd(raw));
      fence = open;
      blanks = 0;
      continue;
    }

    if (/^[ \t]*$/.test(raw)) {
      blanks += 1;
      if (blanks <= 2 && out.length > 0) out.push('');
      continue;
    }

    blanks = 0;
    out.push(trimEnd(raw));
  }

  if (fence !== null) out.push(fence[0].repeat(Math.max(3, fence.length)));

  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

/** Strip trailing whitespace, but keep a Markdown hard break as exactly two spaces. */
function trimEnd(line) {
  return line.replace(/[ \t]+$/, (ws) => (ws.length >= 2 ? '  ' : ''));
}

function openingFence(line) {
  const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
  if (!m) return null;
  // An opening ``` fence may not contain a backtick in its info string.
  if (m[1][0] === '`' && line.slice(line.indexOf(m[1]) + m[1].length).includes('`')) return null;
  return m[1];
}

function isFenceClose(line, fence) {
  const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  return Boolean(m && m[1][0] === fence[0] && m[1].length >= fence.length);
}

/**
 * Would this body be ambiguous with our own turn headings? Fence-aware, so a
 * `## comment` inside a bash block does not trigger it.
 */
function bodyCollidesWithHeading(text, style) {
  if (typeof text !== 'string' || text === '') return false;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let fence = null;
  for (const line of lines) {
    if (fence !== null) {
      if (isFenceClose(line, fence)) fence = null;
      continue;
    }
    const open = openingFence(line);
    if (open) {
      fence = open;
      continue;
    }
    if (style === 'bold') {
      if (/^ {0,3}\*\*[^*\s].*\*\*[ \t]*$/.test(line)) return true;
    } else if (/^ {0,3}#{1,2}[ \t]/.test(line)) {
      return true;
    }
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * small helpers
 * ------------------------------------------------------------------ */

function nonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : '';
}

/** Flatten to a single line: safe inside an ATX heading or a bold label. */
function headingSafe(v) {
  return String(v)
    .replace(CONTROL_CHARS_AND_NEWLINES, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Same, plus escaping of the brackets that would break a link label. */
function labelSafe(v) {
  return headingSafe(v).replace(/([[\]])/g, '\\$1');
}
