/**
 * background.js — MV3 service worker. Registered with `"type": "module"` so it
 * can import the renderer directly.
 *
 * Its only job: turn a Conversation into a file on disk. It exists (rather than
 * the popup doing the download) so an in-flight download survives the popup
 * being dismissed.
 *
 * Service workers have no `URL.createObjectURL`, so the Markdown is handed to
 * `chrome.downloads.download` as a base64 `data:` URL. The bytes come from
 * `TextEncoder` — `btoa()` on a raw JS string throws on anything above U+00FF
 * and would mangle Cyrillic, CJK and emoji.
 */

import { toMarkdown } from './lib/markdown.js';
import { buildFilename } from './lib/filename.js';

const MIME = 'text/markdown;charset=utf-8';

export function handleMessage(message, _sender, sendResponse) {
  if (!message || message.type !== 'chat2md:download') return undefined;

  (async () => {
    try {
      const { conversation, options } = message;
      const markdown = toMarkdown(conversation, options);
      const filename = buildFilename(conversation);
      const downloadId = await chrome.downloads.download({
        url: toDataUrl(markdown),
        filename,
        saveAs: Boolean(options && options.saveAs),
        conflictAction: 'uniquify',
      });
      sendResponse({ ok: true, downloadId, filename, bytes: markdown.length });
    } catch (err) {
      sendResponse({ ok: false, error: String((err && err.message) || err) });
    }
  })();

  return true; // async reply
}

// Guarded so the module can also be imported by `node --test`.
if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener(handleMessage);
}

/**
 * UTF-8 safe `data:` URL. Encoded in chunks so a very long conversation cannot
 * blow the argument limit of `String.fromCharCode`.
 * @param {string} text
 * @returns {string}
 */
export function toDataUrl(text) {
  const bytes = new TextEncoder().encode(text);
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return `data:${MIME};base64,${btoa(binary)}`;
}
