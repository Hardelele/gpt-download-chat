/**
 * content.js — the bridge between the popup and Agent A's extractor.
 *
 * Injected on demand by the popup via `chrome.scripting.executeScript({files})`,
 * which means it is a CLASSIC script: it may not use top-level `import`.
 * `extract.js` and its dependencies are ES modules, so they are pulled in with a
 * dynamic `import()` of a `chrome-extension://` URL. That URL is resolvable
 * because `src/lib/*.js` is listed in `web_accessible_resources`, and the import
 * is governed by the extension's CSP rather than the page's.
 *
 * Injection is idempotent: re-running this file on a tab that already has it
 * does nothing, so the popup can inject unconditionally on every open.
 */

(() => {
  if (window.__chat2mdContentReady) return;
  window.__chat2mdContentReady = true;

  /** @type {Promise<typeof import('./lib/extract.js')>|null} */
  let modulePromise = null;

  function loadExtractor() {
    if (!modulePromise) {
      modulePromise = import(chrome.runtime.getURL('src/lib/extract.js')).catch((err) => {
        modulePromise = null; // let the next attempt retry
        throw new Error(
          `Could not load the extractor module (${describe(err)}). `
            + 'Try reloading the ChatGPT tab.',
        );
      });
    }
    return modulePromise;
  }

  function describe(err) {
    if (!err) return 'unknown error';
    return String(err.message || err);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== 'object') return undefined;

    if (message.type === 'chat2md:ping') {
      sendResponse({ ok: true });
      return undefined;
    }

    if (message.type !== 'chat2md:extract') return undefined;

    (async () => {
      try {
        const mod = await loadExtractor();
        const conversation = await mod.extractConversation({
          conversationId: message.conversationId || undefined,
          scroll: true,
        });
        sendResponse({ ok: true, conversation });
      } catch (err) {
        sendResponse({ ok: false, error: describe(err) });
      }
    })();

    return true; // keep the message channel open for the async reply
  });
})();
