/**
 * aistudio-dom.js — pure parsing layer for aistudio.google.com (Agent E).
 *
 * ⚠️  SECOND CODE PATH — READ THIS BEFORE TRUSTING IT.
 * AI Studio is a different application from the Gemini consumer app: a prompt
 * editor, not a chat transcript. Its markup was reconstructed from the
 * selectors that currently-maintained open-source exporters rely on
 * (`ms-chat-turn`, `.chat-turn-container.user|.model`, `ms-text-chunk`,
 * `ms-thought-chunk`, `ms-code-execution-chunk`, `ms-autoscroll-container`),
 * and it is exercised in `test/gemini-extract.test.mjs` against fixtures built
 * from those selectors — NOT against a live AI Studio session. The
 * gemini.google.com path is the one that has been reasoned through end to end.
 *
 * Behaviour on an unrecognised AI Studio DOM is a loud warning plus whatever
 * text could be recovered — never a silently empty export.
 *
 * Pure: DOM-like nodes in, plain data out. No `document`, no `window`.
 */

import {
  tagOf, attrOf, classesOf, hasClassLike,
  findAll, findFirst, firstByTag, firstByClassLike,
} from './dom-util.js';
import { nodeToMarkdown, contentText, isUiLabel } from './gemini-dom.js';

/** `<ms-chat-turn>` — the unit of conversation in AI Studio. */
export function isChatTurnNode(node) {
  const t = tagOf(node);
  if (t === 'ms-chat-turn') return true;
  return hasClassLike(node, 'chat-turn-container');
}

/**
 * Role of a turn. AI Studio marks it with a bare `user` / `model` class token
 * on `.chat-turn-container`; some builds also carry `data-turn-role`.
 * @returns {'user'|'assistant'|null}
 */
export function turnRole(node) {
  const explicit = attrOf(node, 'data-turn-role') || attrOf(node, 'data-role');
  if (explicit) {
    const v = String(explicit).toLowerCase();
    if (v === 'user') return 'user';
    if (v === 'model' || v === 'assistant') return 'assistant';
  }
  const carriers = [node, ...findAll(node, (n) => hasClassLike(n, 'chat-turn-container'))];
  for (const carrier of carriers) {
    const tokens = classesOf(carrier);
    if (tokens.includes('user')) return 'user';
    if (tokens.includes('model') || tokens.includes('assistant')) return 'assistant';
  }
  return null;
}

function classifyContent(markdown, attachments) {
  if (attachments && attachments.length) return 'multimodal';
  const t = String(markdown || '').trim();
  if (!t) return 'other';
  const fences = t.match(/```/g);
  if (t.startsWith('```') && t.endsWith('```') && fences && fences.length === 2) return 'code';
  return 'text';
}

function idOf(node) {
  return attrOf(node, 'id') || attrOf(node, 'data-turn-id') || attrOf(node, 'data-test-id') || null;
}

/**
 * `.very-large-text-container` holds AI Studio's *raw* text (it is the widget
 * used when a chunk is too big to render as rich markdown). Its content is
 * already Markdown source, so it must be taken verbatim rather than pushed
 * through the HTML converter, which would mangle the fences.
 */
function rawTextOf(chunk) {
  const raw = firstByClassLike(chunk, 'very-large-text-container');
  if (!raw) return null;
  const text = contentText(raw).replace(/\r\n/g, '\n').trim();
  return text || null;
}

/** Render one content chunk (`ms-text-chunk`, `ms-prompt-chunk`, …). */
function chunkToMarkdown(chunk) {
  const raw = rawTextOf(chunk);
  if (raw) return { markdown: raw, attachments: [], warnings: [] };
  return nodeToMarkdown(chunk, { dropThoughts: true });
}

/** `<ms-code-execution-chunk>` → fenced code plus its captured output. */
export function codeExecutionToMarkdown(chunk) {
  const parts = [];
  const pre = firstByTag(chunk, 'pre');
  const code = pre ? contentText(pre).replace(/^\n+/, '').replace(/\s+$/, '') : '';
  if (code) {
    let fence = '```';
    while (code.includes(fence)) fence += '`';
    parts.push(`${fence}python\n${code}\n${fence}`);
  }
  const resultNode = findFirst(chunk, (n) => (
    tagOf(n) === 'ms-code-execution-result' || hasClassLike(n, 'code-execution-result')
  ));
  if (resultNode) {
    const out = contentText(resultNode).replace(/^\n+/, '').replace(/\s+$/, '');
    if (out && !isUiLabel(out)) {
      let fence = '```';
      while (out.includes(fence)) fence += '`';
      parts.push(`${fence}text\n${out}\n${fence}`);
    }
  }
  return parts.join('\n\n');
}

/**
 * Parse one `<ms-chat-turn>`.
 * @returns {{messages: Message[], warnings: string[]}}
 */
export function parseAiStudioTurn(node) {
  const warnings = [];
  const messages = [];
  const role = turnRole(node) || 'assistant';
  if (!turnRole(node)) {
    warnings.push('AI Studio turn: no user/model class found; assumed assistant. AI Studio markup may have changed.');
  }

  // 1. Thinking chunks first — hidden 'thoughts' messages.
  const thoughtChunks = findAll(node, (n) => (
    tagOf(n) === 'ms-thought-chunk' || hasClassLike(n, 'thought-chunk')
  ));
  for (const tc of thoughtChunks) {
    const r = chunkToMarkdown(tc);
    warnings.push(...r.warnings);
    const text = r.markdown.trim();
    if (!text || isUiLabel(text)) continue;
    messages.push({
      id: idOf(tc),
      role: 'assistant',
      authorName: null,
      createTime: null,
      contentType: 'thoughts',
      text,
      attachments: r.attachments,
      hidden: true,
    });
  }

  // 2. Code execution chunks — kept as tool output, in document order.
  const codeChunks = findAll(node, (n) => (
    tagOf(n) === 'ms-code-execution-chunk' || hasClassLike(n, 'code-execution')
  ));
  const codeMarkdown = codeChunks.map(codeExecutionToMarkdown).filter(Boolean);

  // 3. The visible body.
  const textChunks = findAll(node, (n) => (
    tagOf(n) === 'ms-text-chunk' || tagOf(n) === 'ms-prompt-chunk' || tagOf(n) === 'ms-cmark-node'
  )).filter((n) => !thoughtChunks.some((tc) => tc === n || findFirst(tc, (x) => x === n)));

  // Keep only outermost chunks so nested `ms-cmark-node`s are not emitted twice.
  const outer = textChunks.filter((n) => !textChunks.some((other) => (
    other !== n && findFirst(other, (x) => x === n)
  )));

  let bodyParts = [];
  let attachments = [];
  if (outer.length) {
    for (const chunk of outer) {
      const r = chunkToMarkdown(chunk);
      warnings.push(...r.warnings);
      attachments = attachments.concat(r.attachments);
      if (r.markdown.trim()) bodyParts.push(r.markdown.trim());
    }
  } else {
    const fallback = firstByClassLike(node, 'turn-content') || node;
    if (fallback === node) {
      warnings.push('AI Studio turn: neither <ms-text-chunk> nor .turn-content was found; fell back to the whole turn element.');
    }
    const r = chunkToMarkdown(fallback);
    warnings.push(...r.warnings);
    attachments = attachments.concat(r.attachments);
    if (r.markdown.trim()) bodyParts.push(r.markdown.trim());
  }

  const text = bodyParts.concat(codeMarkdown).join('\n\n').trim();
  if (text || attachments.length) {
    messages.push({
      id: idOf(node),
      role,
      authorName: null,
      createTime: null,
      contentType: classifyContent(text, attachments),
      text,
      attachments,
      hidden: false,
    });
  }
  return { messages, warnings };
}

/**
 * Walk an AI Studio prompt root.
 * @returns {{messages: Message[], warnings: string[], turnCount: number}}
 */
export function parseAiStudioTurns(root) {
  const warnings = [];
  const messages = [];
  const all = findAll(root, isChatTurnNode);
  // Outermost turns only.
  const turns = all.filter((n) => !all.some((other) => other !== n && findFirst(other, (x) => x === n)));

  if (!turns.length) {
    warnings.push('No <ms-chat-turn> elements were found. AI Studio\'s markup has probably changed, or the prompt had not finished loading.');
    return { messages, warnings, turnCount: 0 };
  }
  for (const turn of turns) {
    const r = parseAiStudioTurn(turn);
    for (const w of r.warnings) if (!warnings.includes(w)) warnings.push(w);
    messages.push(...r.messages);
  }
  return { messages, warnings, turnCount: turns.length };
}

/** Best-effort prompt title (the editable name in the AI Studio toolbar). */
export function pickAiStudioTitle(root, documentTitle) {
  const probes = [
    (n) => hasClassLike(n, 'prompt-title'),
    (n) => attrOf(n, 'data-test-id') === 'prompt-title',
    (n) => tagOf(n) === 'ms-prompt-title',
  ];
  for (const probe of probes) {
    const node = findFirst(root, probe);
    if (!node) continue;
    const t = contentText(node).replace(/\s+/g, ' ').trim();
    if (t && !isUiLabel(t)) return t.slice(0, 200);
  }
  const raw = String(documentTitle || '').replace(/\s*[-–—|]\s*Google AI Studio\s*$/i, '').trim();
  return /^(google ai studio|ai studio)?$/i.test(raw) ? '' : raw.slice(0, 200);
}
