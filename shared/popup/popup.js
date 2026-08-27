/**
 * popup.js — the whole UI. Loaded as an ES module, so it can import the renderer
 * directly for the "copy to clipboard" path.
 *
 * Platform-agnostic: everything that differs between the four store items —
 * which hosts count, which URLs are a conversation, what the assistant is
 * called in the exported file — comes from the generated `platform.js`
 * (see platforms.config.mjs). There is no site name hardcoded below.
 *
 * Flow:
 *   1. find the active tab and decide whether it is a conversation
 *   2. inject `src/content.js` (idempotent) using the `activeTab` grant that the
 *      user's click on the toolbar icon just handed us
 *   3. ask it for a Conversation, render title / count / warnings
 *   4. Download -> service worker (survives the popup closing)
 *      Copy     -> rendered here, straight to the clipboard
 */

import {
  toMarkdown,
  DEFAULT_OPTIONS,
  incompleteWarning,
  INCOMPLETE_PREFIX,
} from '../lib/markdown.js';
import { buildFilename } from '../lib/filename.js';
import { PLATFORM, CONVERSATION_URL } from '../platform.js';

const CHAT_HOSTS = new Set(PLATFORM.hosts);
const STORAGE_KEY = 'renderOptions';

const OPTION_IDS = [
  'frontmatter',
  'mathDelimiters',
  'timestamps',
  'includeThoughts',
  'includeTools',
  'includeSystem',
  'headingStyle',
];

/**
 * Options whose value is one of two strings but which read better as a single
 * checkbox: `[checked, unchecked]`.
 */
const CHECKBOX_ENUMS = {
  mathDelimiters: ['dollar', 'preserve'],
};

const el = (id) => document.getElementById(id);
const panes = {
  loading: el('pane-loading'),
  idle: el('pane-idle'),
  error: el('pane-error'),
  ready: el('pane-ready'),
};

/** @type {object|null} */
let conversation = null;
let statusTimer = 0;

/* ------------------------------------------------------------------ *
 * boot
 * ------------------------------------------------------------------ */

init();

async function init() {
  wireOptions();
  await loadOptions();

  el('retry').addEventListener('click', () => { void start(); });
  el('download').addEventListener('click', () => { void onDownload(); });
  el('download-anyway').addEventListener('click', () => { void onDownload('download-anyway'); });
  el('copy').addEventListener('click', () => { void onCopy(); });

  await start();
}

async function start() {
  show('loading');
  try {
    const tab = await activeTab();
    if (!tab || typeof tab.id !== 'number') {
      return showIdle('No active tab', `Open a ${PLATFORM.siteName} conversation and try again.`);
    }
    const verdict = classify(tab.url || tab.pendingUrl || '');
    if (verdict !== 'conversation') {
      return showIdle(...IDLE_COPY[verdict]);
    }

    await injectContentScript(tab.id);
    const reply = await sendToTab(tab.id, { type: 'chat2md:extract' });

    if (!reply) throw new Error(`The ${PLATFORM.siteName} tab did not answer. Reload it and try again.`);
    if (!reply.ok) throw new Error(reply.error || 'Extraction failed.');

    conversation = reply.conversation;
    renderReady(conversation);
  } catch (err) {
    showError(String((err && err.message) || err));
  }
}

/* ------------------------------------------------------------------ *
 * tab plumbing
 * ------------------------------------------------------------------ */

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/** @returns {'conversation'|'new-chat'|'elsewhere'} */
function classify(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return 'elsewhere';
  }
  if (url.protocol !== 'https:' || !CHAT_HOSTS.has(url.hostname)) return 'elsewhere';
  // Matched against path AND query: on AI Mode the discriminator is `?udm=50`,
  // not the path, so a path-only test would reject every valid page.
  const target = url.pathname + url.search;
  return CONVERSATION_URL.some((re) => re.test(target)) ? 'conversation' : 'new-chat';
}

const IDLE_COPY = {
  elsewhere: PLATFORM.idle.elsewhere,
  'new-chat': PLATFORM.idle.newChat,
};

async function injectContentScript(id) {
  try {
    await chrome.scripting.executeScript({ target: { tabId: id }, files: ['src/content.js'] });
  } catch (err) {
    throw new Error(
      `${PLATFORM.productName} could not attach to the page (${String((err && err.message) || err)}). `
        + `Reload the ${PLATFORM.siteName} tab and try again.`,
    );
  }
}

function sendToTab(id, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(id, message, (reply) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(reply);
    });
  });
}

function sendToWorker(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (reply) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(reply);
    });
  });
}

/* ------------------------------------------------------------------ *
 * rendering
 * ------------------------------------------------------------------ */

function show(name) {
  for (const [key, node] of Object.entries(panes)) node.hidden = key !== name;
}

function showIdle(title, htmlText) {
  el('idle-title').textContent = title;
  el('idle-text').innerHTML = htmlText; // fixed, local strings only
  show('idle');
}

function showError(text) {
  el('error-text').textContent = text;
  show('error');
}

function renderReady(c) {
  el('chat-title').textContent = c.title || PLATFORM.fallbackTitle;
  el('chat-meta').textContent = metaLine(c);

  // A partial export must never be one click away. The primary button is
  // withdrawn entirely and replaced by an explicitly-labelled second action, so
  // nobody can archive a truncated chat without having read why it is truncated.
  const partial = incompleteWarning(c);
  el('partial').hidden = !partial;
  el('download').hidden = Boolean(partial);
  el('download-anyway').hidden = !partial;
  if (partial) {
    el('partial-text').textContent = partial
      .slice(INCOMPLETE_PREFIX.length)
      .replace(/^[\s—–-]+/, '');
    el('partial-why').textContent = PARTIAL_EXPLANATION;
  }

  // The headline warning is already shown above; don't repeat it in the list.
  const warnings = (Array.isArray(c.warnings) ? c.warnings.filter(Boolean) : []).filter(
    (w) => w !== partial,
  );
  const list = el('warning-list');
  list.replaceChildren(
    ...warnings.map((w) => {
      const li = document.createElement('li');
      li.textContent = w;
      return li;
    }),
  );
  el('warnings').hidden = warnings.length === 0;

  setStatus('');
  show('ready');
}

/**
 * Calm and factual, and deliberately quotes no totals: turn indices are not
 * global message ordinals, so any number we could name would understate the
 * loss (Agent A, docs/HANDOFF.md).
 */
const PARTIAL_EXPLANATION =
  `${PLATFORM.siteName} keeps only part of a long conversation loaded in the page, so an export `
  + 'read from the page can only contain what was there. That is a limitation of the site, not a '
  + `bug in ${PLATFORM.productName}. Signing in at ${PLATFORM.siteHost} and reopening this chat `
  + `lets ${PLATFORM.productName} read the whole conversation instead.`;

function metaLine(c) {
  const shown = countRendered(c);
  const bits = [`${shown} message${shown === 1 ? '' : 's'}`];
  if (c.model) bits.push(c.model);
  bits.push(c.extractedVia === 'dom' ? 'read from the page' : 'read from the API');
  return bits.join(' · ');
}

/** Mirrors the renderer's filter so the count matches the file. */
function countRendered(c) {
  const o = currentOptions();
  const list = Array.isArray(c.messages) ? c.messages : [];
  const has = (m) =>
    (typeof m.text === 'string' && m.text.trim() !== '')
    || (Array.isArray(m.attachments) && m.attachments.length > 0);

  return list.filter((m) => {
    if (!m || typeof m !== 'object') return false;
    if (m.contentType === 'thoughts') return o.includeThoughts && has(m);
    if (m.role === 'tool') return o.includeTools && has(m);
    if (m.role === 'system') return o.includeSystem && has(m);
    if (m.hidden === true && !o.includeSystem) return false;
    return has(m);
  }).length;
}

function setStatus(text, tone) {
  const node = el('status');
  node.textContent = text;
  if (tone) node.dataset.tone = tone;
  else delete node.dataset.tone;

  clearTimeout(statusTimer);
  if (text && tone === 'ok') {
    statusTimer = setTimeout(() => setStatus(''), 4000);
  }
}

/* ------------------------------------------------------------------ *
 * options
 * ------------------------------------------------------------------ */

function optionInput(key) {
  return el(`opt-${key}`);
}

function currentOptions() {
  // The renderer defaults to `assistantLabel: 'ChatGPT'`; every build overrides
  // it here so a Gemini export says "## Gemini" and not "## ChatGPT".
  const o = {
    ...DEFAULT_OPTIONS,
    userLabel: PLATFORM.userLabel,
    assistantLabel: PLATFORM.assistantLabel,
  };
  for (const key of OPTION_IDS) {
    const input = optionInput(key);
    if (!input) continue;
    const pair = CHECKBOX_ENUMS[key];
    if (pair) o[key] = input.checked ? pair[0] : pair[1];
    else o[key] = input.type === 'checkbox' ? input.checked : input.value;
  }
  if (o.headingStyle !== 'bold') o.headingStyle = 'h2';
  return o;
}

function wireOptions() {
  for (const key of OPTION_IDS) {
    const input = optionInput(key);
    if (!input) continue;
    input.addEventListener('change', () => {
      void saveOptions();
      if (conversation) el('chat-meta').textContent = metaLine(conversation);
      setStatus('');
    });
  }
}

async function loadOptions() {
  let stored = {};
  try {
    const bag = await chrome.storage.sync.get(STORAGE_KEY);
    if (bag && bag[STORAGE_KEY] && typeof bag[STORAGE_KEY] === 'object') stored = bag[STORAGE_KEY];
  } catch {
    /* first run, or sync unavailable — defaults are fine */
  }
  for (const key of OPTION_IDS) {
    const input = optionInput(key);
    if (!input) continue;
    const value = stored[key] !== undefined ? stored[key] : DEFAULT_OPTIONS[key];
    const pair = CHECKBOX_ENUMS[key];
    if (pair) input.checked = value !== pair[1];
    else if (input.type === 'checkbox') input.checked = Boolean(value);
    else input.value = value === 'bold' ? 'bold' : 'h2';
  }
}

async function saveOptions() {
  try {
    await chrome.storage.sync.set({ [STORAGE_KEY]: currentOptions() });
  } catch {
    /* non-fatal: the export still uses what is on screen */
  }
}

/* ------------------------------------------------------------------ *
 * actions
 * ------------------------------------------------------------------ */

async function onDownload(buttonId = 'download') {
  if (!conversation) return;
  const button = el(buttonId);
  button.disabled = true;
  setStatus('Saving…');
  try {
    const reply = await sendToWorker({
      type: 'chat2md:download',
      conversation,
      options: currentOptions(),
    });
    if (!reply || !reply.ok) throw new Error((reply && reply.error) || 'Download failed.');
    setStatus(`Saved ${reply.filename || buildFilename(conversation)}`, 'ok');
  } catch (err) {
    setStatus(String((err && err.message) || err), 'err');
  } finally {
    button.disabled = false;
  }
}

async function onCopy() {
  if (!conversation) return;
  const button = el('copy');
  button.disabled = true;
  try {
    await navigator.clipboard.writeText(toMarkdown(conversation, currentOptions()));
    setStatus('Markdown copied to the clipboard', 'ok');
  } catch (err) {
    setStatus(`Could not copy: ${String((err && err.message) || err)}`, 'err');
  } finally {
    button.disabled = false;
  }
}
