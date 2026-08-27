/**
 * filename.js — turns a Conversation into a safe download filename.
 *
 * Owner: Agent B. No dependencies, no chrome.*.
 *
 * Guarantees (all of them hold for any input, including `null`):
 *   - never empty
 *   - never contains a path separator, a drive colon, or `\/:*?"<>|`
 *   - never contains a control character
 *   - never a reserved Windows device name
 *   - always ends in `.md`
 */

import { incompleteWarning } from './markdown.js';

const MAX_BASE = 80;
const FALLBACK = 'chatgpt-conversation';
const PARTIAL_SUFFIX = '-partial';

// CON, PRN, AUX, NUL, COM0-9, LPT0-9 — reserved on Windows with or without an extension.
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/* eslint-disable no-control-regex */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
/* eslint-enable no-control-regex */

// Filesystem-hostile characters, plus the ones Chrome's downloads API rejects.
const FORBIDDEN = /[\\/:*?"<>|~#%&{}$!'`+=@]/g;

/**
 * @param {object|null|undefined} conversation a Conversation per CONTRACT.md
 * @returns {string} e.g. "2026-08-26-some-chat-title.md"
 */
export function buildFilename(conversation) {
  const c = conversation && typeof conversation === 'object' ? conversation : {};

  let base = slugify(c.title);
  if (!base) base = slugify(c.id === 'unknown' ? '' : c.id);
  if (!base) base = FALLBACK;

  base = capLength(base, MAX_BASE);
  if (RESERVED.test(base)) base = `chat-${base}`;

  // A partial export is marked on disk too. Six months later the file is all
  // that is left of this decision, and "is my backup complete?" has to be
  // answerable without opening it.
  if (incompleteWarning(c)) base += PARTIAL_SUFFIX;

  const date = datePrefix(c.createTime, c.updateTime);
  return `${date ? `${date}-` : ''}${base}.md`;
}

/**
 * Unicode-aware slug. Keeps letters and digits of any script (Cyrillic, Greek,
 * CJK, …), turns everything else into a single `-`.
 * @param {unknown} value
 * @returns {string} lower-case slug, possibly empty
 */
export function slugify(value) {
  if (typeof value !== 'string') return '';
  let s = value.normalize('NFC').replace(CONTROL_CHARS, ' ').replace(FORBIDDEN, ' ');

  // Everything that is not a letter, digit, underscore or hyphen becomes a separator.
  s = s.replace(/[^\p{L}\p{N}_-]+/gu, '-');

  s = s
    .replace(/-{2,}/g, '-')
    .replace(/^[-_.]+/, '')
    .replace(/[-_.]+$/, '')
    .toLowerCase();

  return s;
}

/** Cut on a `-` boundary when possible so the name does not end mid-word. */
function capLength(base, max) {
  const chars = Array.from(base);
  if (chars.length <= max) return base;
  let cut = chars.slice(0, max).join('');
  const lastDash = cut.lastIndexOf('-');
  if (lastDash >= Math.floor(max * 0.5)) cut = cut.slice(0, lastDash);
  cut = cut.replace(/[-_.]+$/, '');
  return cut || base.slice(0, max);
}

/** "2026-08-26" from the first usable unix-seconds timestamp, else "". */
function datePrefix(...candidates) {
  for (const value of candidates) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue;
    const ms = value > 1e11 ? value : value * 1000;
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) continue;
    return d.toISOString().slice(0, 10);
  }
  return '';
}
