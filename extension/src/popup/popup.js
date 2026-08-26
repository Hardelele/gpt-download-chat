/**
 * popup.js — the whole UI. Loaded as an ES module, so it can import the renderer
 * directly for the "copy to clipboard" path.
 *
 * Flow:
 *   1. find the active tab and decide whether it is a ChatGPT conversation
 *   2. inject `src/content.js` (idempotent) using the `activeTab` grant that the
 *      user's click on the toolbar icon just handed us
 *   3. ask it for a Conversation, render title / count / warnings
 *   4. Download -> service worker (survives the popup closing)
 *      Copy     -> rendered here, straight to the clipboard
 */

import { toMarkdown, DEFAULT_OPTIONS } from '../lib/markdown.js';
import { buildFilename } from '../lib/filename.js';

const CHAT_HOSTS = new Set(['chatgpt.com', 'chat.openai.com']);
const CONVERSATION_PATH = /^\/(?:c\/|share\/|g\/[^/]+\/c\/)/;
const STORAGE_KEY = 'renderOptions';

const OPTION_IDS = [
  'frontmatter',
  'timestamps',
  'includeThoughts',
  'includeTools',
  'includeSystem',
  'headingStyle',
];

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
  el('copy').addEventListener('click', () => { void onCopy(); });

  await start();
}

async function start() {
  show('loading');
  try {
    const tab = await activeTab();
    if (!tab || typeof tab.id !== 'number') {
      return showIdle('No active tab', 'Open a ChatGPT conversation and try again.');
    }
    const verdict = classify(tab.url || tab.pendingUrl || '');
    if (verdict !== 'conversation') {
      return showIdle(...IDLE_COPY[verdict]);
    }

    await injectContentScript(tab.id);
    const reply = await sendToTab(tab.id, { type: 'chat2md:extract' });

    if (!reply) throw new Error('The ChatGPT tab did not answer. Reload it and try again.');
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
  return CONVERSATION_PATH.test(url.pathname) ? 'conversation' : 'new-chat';
}

const IDLE_COPY = {
  elsewhere: [
    'Not a ChatGPT conversation',
    'Open a chat on <b>chatgpt.com</b>, then click the Chat2MD icon again.',
  ],
  'new-chat': [
    'No conversation open yet',
    'This looks like a new chat. Send a message first — Chat2MD exports saved conversations.',
  ],
};

async function injectContentScript(id) {
  try {
    await chrome.scripting.executeScript({ target: { tabId: id }, files: ['src/content.js'] });
  } catch (err) {
    throw new Error(
      `Chat2MD could not attach to the page (${String((err && err.message) || err)}). `
        + 'Reload the ChatGPT tab and try again.',
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
  el('chat-title').textContent = c.title || 'ChatGPT conversation';
  el('chat-meta').textContent = metaLine(c);

  const warnings = Array.isArray(c.warnings) ? c.warnings.filter(Boolean) : [];
  const box = el('warnings');
  const list = el('warning-list');
  list.replaceChildren(
    ...warnings.map((w) => {
      const li = document.createElement('li');
      li.textContent = w;
      return li;
    }),
  );
  box.hidden = warnings.length === 0;

  setStatus('');
  show('ready');
}

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
  return list.filter((m) => {
    if (!m || typeof m !== 'object') return false;
    if (m.contentType === 'thoughts' && !o.includeThoughts) return false;
    if (m.role === 'system' && !o.includeSystem) return false;
    if (m.role === 'tool' && !o.includeTools) return false;
    if (m.hidden === true && !o.includeSystem) return false;
    const hasText = typeof m.text === 'string' && m.text.trim() !== '';
    return hasText || (Array.isArray(m.attachments) && m.attachments.length > 0);
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
  const o = { ...DEFAULT_OPTIONS };
  for (const key of OPTION_IDS) {
    const input = optionInput(key);
    if (!input) continue;
    o[key] = input.type === 'checkbox' ? input.checked : input.value;
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
    if (input.type === 'checkbox') input.checked = Boolean(value);
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

async function onDownload() {
  if (!conversation) return;
  const button = el('download');
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
