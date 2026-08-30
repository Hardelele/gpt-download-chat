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
 * @property {'dollar'|'preserve'} mathDelimiters
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
  mathDelimiters: 'dollar',
});

const FALLBACK_TITLE = 'ChatGPT conversation';

/**
 * Sentinel that the extractors put at the front of a warning when they know the
 * transcript they recovered is only part of the conversation.
 *
 * Defined here, in the shared renderer, because the popup and the renderer both
 * need it and neither may import a platform-specific extractor. Agent A owns the
 * producing copy in `dom-scrape.js`; `test/markdown.test.mjs` asserts the two
 * strings are identical, so a reword on either side fails the build rather than
 * silently disarming the refusal.
 */
export const INCOMPLETE_PREFIX = 'INCOMPLETE EXPORT';

/**
 * The headline warning explaining why an export is partial, or '' when it is not.
 * @param {object|null|undefined} conversation
 * @returns {string}
 */
export function incompleteWarning(conversation) {
  const list = conversation && Array.isArray(conversation.warnings) ? conversation.warnings : [];
  const hit = list.find((w) => typeof w === 'string' && w.startsWith(INCOMPLETE_PREFIX));
  return hit || '';
}

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

  // A truncated file that looks complete is this category's defining failure, so
  // say so at the top, where it cannot be missed, not only in the notes footer.
  // `> [!WARNING]` is a callout in Obsidian and on GitHub and degrades to an
  // ordinary blockquote everywhere else.
  const partial = incompleteWarning(c);
  if (partial) {
    blocks.push(`> [!WARNING]\n> **Incomplete export.** ${headingSafe(stripPrefix(partial))}`);
  }

  visible.forEach((m, i) => {
    if (useRules && i > 0) blocks.push('---');
    blocks.push(renderMessage(m, o));
  });

  if (visible.length === 0) blocks.push('*(no messages)*');

  const warnings = Array.isArray(c.warnings) ? c.warnings.filter((w) => nonEmptyString(w)) : [];
  if (warnings.length) {
    // Incomplete-export warnings lead; they are the ones that change what the
    // reader should believe about the file.
    const ordered = [
      ...warnings.filter((w) => w.startsWith(INCOMPLETE_PREFIX)),
      ...warnings.filter((w) => !w.startsWith(INCOMPLETE_PREFIX)),
    ];
    blocks.push('---');
    blocks.push(
      ['> **Export notes**', '>', ...ordered.map((w) => `> - ${headingSafe(w)}`)].join('\n'),
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
  if (o.mathDelimiters !== 'preserve') o.mathDelimiters = 'dollar';
  if (!o.userLabel.trim()) o.userLabel = DEFAULT_OPTIONS.userLabel;
  if (!o.assistantLabel.trim()) o.assistantLabel = DEFAULT_OPTIONS.assistantLabel;
  // internal, test-only: pins the `exported:` stamp
  if (src.now !== undefined && src.now !== null) o.now = src.now;
  return o;
}

/* ------------------------------------------------------------------ *
 * message selection
 * ------------------------------------------------------------------ */

/**
 * Each category is gated by exactly one option, and that option also overrides
 * `hidden`. That matters in practice: ChatGPT flags most tool output and all
 * reasoning as `is_visually_hidden_from_conversation`, so gating those on
 * `includeSystem` as well would make `includeTools` / `includeThoughts` do
 * nothing at all. (Reported by Agent A, docs/HANDOFF.md.)
 */
function shouldRender(m, o) {
  if (m.contentType === 'thoughts') return o.includeThoughts && hasContent(m);
  if (m.role === 'tool') return o.includeTools && hasContent(m);
  if (m.role === 'system') return o.includeSystem && hasContent(m);
  // Everything else that is plumbing — custom instructions, memory injections,
  // tether markers — rides along with the system toggle.
  if (m.hidden === true && !o.includeSystem) return false;
  return hasContent(m);
}

function hasContent(m) {
  if (nonEmptyString(m.text) !== '') return true;
  return Array.isArray(m.attachments) && m.attachments.length > 0;
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
  // Only ever emitted when true, so a script can trust its presence.
  if (incompleteWarning(c)) put('incomplete', 'true');
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

  // Order matters: strip the private-use delimiters and the citation residue
  // first, so a marker sitting next to a formula cannot confuse the math scan.
  let raw = sanitizeProse(m.text);
  if (o.mathDelimiters === 'dollar') raw = convertMathDelimiters(raw);
  const body = tidyBody(raw);
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
 * prose sanitisation
 * ------------------------------------------------------------------ */

/**
 * Internal plumbing that leaks out of the chat UI and into exports.
 *
 * `citeturn0search1` is the residue of a citation marker. In the wire format
 * the marker is delimited by private-use characters
 * (`U+E200 cite U+E202 turn0search1 U+E201`); strip only the private-use
 * characters — which is as far as every exporter in this category gets — and
 * the ASCII payload is left welded into the prose. That is the exact text users
 * report finding in their notes. We remove the private-use characters first and
 * then the payload.
 *
 * The pattern is deliberately narrow: a `cite`/`navlist`/`video` lead-in plus at
 * least one full `turn<digits><word><digits>` group. Prose does not contain that
 * by accident, and eating real text would be far worse than leaving a marker in.
 */
const CITATION_RESIDUE = /(?:cite|navlist|video)(?:turn\d+[a-z]+\d+)+/gi;

/** Private-use area: never legitimate prose. Icon fonts live in code, which is protected. */
const PRIVATE_USE = /[\uE000-\uF8FF]/g;

/**
 * Whitespace that looks like a space but is not one. Normalised because it
 * breaks search, diff and word wrap in a notes app.
 * U+3000 (ideographic space) is deliberately NOT here: it is real punctuation
 * in CJK text.
 */
const FAKE_SPACES = /[\u00A0\u2007\u202F]/g;

/** Invisible characters that carry no meaning in prose. */
const INVISIBLES = /[\u200B\uFEFF]/g;

// Detector for the fast path — same character classes, no `g` flag.
const NEEDS_SANITISING = /[\uE000-\uF8FF\u00A0\u2007\u202F\u200B\uFEFF]|(?:cite|navlist|video)turn\d/i;

/**
 * Removes UI plumbing and normalises look-alike whitespace, in prose only.
 * Fenced blocks and inline code are byte-exact: a non-breaking space inside a
 * code sample may well be deliberate, and private-use characters inside a fence
 * are probably Nerd Font icons.
 *
 * Note what is deliberately NOT touched: curly quotes, en/em dashes and other
 * real typography (they are correct, not corruption), and zero-width joiners
 * (U+200D/U+200C), which hold multi-part emoji together and are load-bearing in
 * Persian and Indic scripts.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function sanitizeProse(text) {
  if (typeof text !== 'string' || text === '') return '';
  if (!NEEDS_SANITISING.test(text)) return text; // fast path
  return mapProse(text, sanitizeRun);
}

function sanitizeRun(run) {
  return run
    .replace(PRIVATE_USE, '')
    .replace(CITATION_RESIDUE, '')
    .replace(FAKE_SPACES, ' ')
    .replace(INVISIBLES, '');
}

/* ------------------------------------------------------------------ *
 * LaTeX delimiter normalisation
 * ------------------------------------------------------------------ */

/**
 * Rewrites ChatGPT's LaTeX delimiters into the dollar form that Obsidian,
 * MathJax and most Markdown renderers expect:
 *
 *     \( x \)   ->  $x$
 *     \[ x \]   ->  $$x$$
 *
 * Code is sacred: fenced blocks and inline-code spans are never touched, so a
 * shell script containing `\(` survives byte-for-byte.
 *
 * The scan is deliberately timid — anything it is not sure about is left
 * exactly as it was. It refuses to convert when:
 *   - the delimiter's backslash is itself escaped (`\\(` is a literal paren)
 *   - there is no matching closer (unbalanced)
 *   - the span would contain a blank line (that is prose, not math)
 *   - the span already contains a `$` (converting could produce broken output)
 *   - the span is empty
 *
 * @param {unknown} text
 * @returns {string} the text, with `\(`/`\[` spans converted outside code
 */
export function convertMathDelimiters(text) {
  if (typeof text !== 'string' || text === '') return '';
  if (!text.includes('\\(') && !text.includes('\\[')) return text; // fast path
  return mapProse(text, convertSpans);
}

/**
 * Applies `transform` to every run of ordinary prose, leaving fenced code blocks
 * and inline-code spans byte-for-byte identical.
 * @param {string} text
 * @param {(run: string) => string} transform
 * @returns {string}
 */
function mapProse(text, transform) {
  return splitOutFences(text)
    .map((seg) => (seg.code ? seg.text : convertOutsideInlineCode(seg.text, transform)))
    .join('');
}

/**
 * Split a body into fenced-code and non-code segments, preserving every byte.
 * @param {string} text
 * @returns {{code: boolean, text: string}[]}
 */
function splitOutFences(text) {
  const lines = text.split('\n');
  const segments = [];
  let buffer = [];
  let inCode = false;
  let fence = null;

  const flush = (code) => {
    if (buffer.length) segments.push({ code, text: buffer.join('\n') });
    buffer = [];
  };

  for (const line of lines) {
    if (inCode) {
      buffer.push(line);
      if (isFenceClose(line, fence)) {
        flush(true);
        inCode = false;
        fence = null;
      }
      continue;
    }
    const open = openingFence(line);
    if (open) {
      flush(false);
      inCode = true;
      fence = open;
      buffer.push(line);
      continue;
    }
    buffer.push(line);
  }
  flush(inCode);

  // `join('\n')` inside each segment loses the newline that separated two
  // segments, so stitch them back with the separators they were split on.
  return segments.map((seg, i) => (i === 0 ? seg : { ...seg, text: `\n${seg.text}` }));
}

/** Transform the plain runs of a non-code segment, skipping `` `inline code` ``. */
function convertOutsideInlineCode(segment, transform) {
  let out = '';
  let plainStart = 0;
  let i = 0;

  while (i < segment.length) {
    if (segment[i] !== '`') {
      i += 1;
      continue;
    }
    let run = 0;
    while (segment[i + run] === '`') run += 1;
    const closer = findBacktickRun(segment, i + run, run);
    if (closer === -1) {
      i += run; // unmatched backticks are ordinary text
      continue;
    }
    out += transform(segment.slice(plainStart, i));
    out += segment.slice(i, closer + run); // the code span, verbatim
    i = closer + run;
    plainStart = i;
  }

  return out + transform(segment.slice(plainStart));
}

/** Index of the next backtick run of exactly `length`, or -1. */
function findBacktickRun(text, from, length) {
  for (let i = from; i < text.length; i += 1) {
    if (text[i] !== '`') continue;
    let run = 0;
    while (text[i + run] === '`') run += 1;
    if (run === length) return i;
    i += run - 1;
  }
  return -1;
}

/** The actual delimiter rewrite, over a run of text known to be plain prose. */
function convertSpans(text) {
  if (text === '') return '';
  let out = '';
  let i = 0;

  while (i < text.length) {
    if (text[i] !== '\\') {
      out += text[i];
      i += 1;
      continue;
    }

    let slashes = 0;
    while (text[i + slashes] === '\\') slashes += 1;
    const next = text[i + slashes];
    const display = next === '[';

    // Only an ODD run of backslashes leaves one free to pair with the bracket:
    // `\(` opens math, `\\(` is an escaped backslash before a literal paren.
    if ((display || next === '(') && slashes % 2 === 1) {
      const contentStart = i + slashes + 1;
      const closer = findMathCloser(text, contentStart, display ? ']' : ')');
      if (closer !== -1) {
        const wrapped = wrapMath(text.slice(contentStart, closer), display);
        if (wrapped !== null) {
          out += text.slice(i, i + slashes - 1); // backslashes not part of the delimiter
          out += wrapped;
          i = closer + 2; // past the closing `\)` / `\]`
          continue;
        }
      }
    }

    out += text.slice(i, i + slashes);
    i += slashes;
  }

  return out;
}

/** Index of the backslash of the next unescaped `\)` / `\]`, or -1. */
function findMathCloser(text, from, bracket) {
  for (let i = from; i < text.length; i += 1) {
    if (text[i] !== '\\') continue;
    let slashes = 0;
    while (text[i + slashes] === '\\') slashes += 1;
    if (text[i + slashes] === bracket && slashes % 2 === 1) return i + slashes - 1;
    i += slashes - 1;
  }
  return -1;
}

/**
 * `null` means "refuse, leave the original alone".
 * Horizontal whitespace next to the delimiters is dropped (`\( x \)` -> `$x$`,
 * which Obsidian requires) but newlines are kept, so multi-line display math
 * keeps its shape.
 */
function wrapMath(content, display) {
  const trimmed = content.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  if (trimmed.trim() === '') return null; // empty span
  if (trimmed.includes('$')) return null; // would collide with the new delimiter
  if (/\n[ \t]*\n/.test(trimmed)) return null; // spans a paragraph break: prose, not math
  return display ? `$$${trimmed}$$` : `$${trimmed}$`;
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

/** Drop the machine-readable sentinel and any separator that followed it. */
function stripPrefix(warning) {
  return warning.slice(INCOMPLETE_PREFIX.length).replace(/^[\s—–-]+/, '');
}

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
