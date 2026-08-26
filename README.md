<img src="extension/icons/icon128.png" width="72" alt="">

# Chat2MD — save ChatGPT chats as Markdown

A Chrome (MV3) extension that exports a **whole** ChatGPT conversation to a clean `.md`
file. One click, no account, no server, nothing uploaded.

[![CI](https://github.com/hardelele/gpt-download-chat/actions/workflows/ci.yml/badge.svg)](https://github.com/hardelele/gpt-download-chat/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

---

## Why this exists

Selecting a long ChatGPT thread and pressing <kbd>Ctrl</kbd>+<kbd>C</kbd> does not give you
the conversation. It gives you *whatever happened to be rendered*.

ChatGPT virtualises the message list: scroll up in a long chat and older turns are quietly
removed from the DOM. A copy-paste — and any naive "export" extension that just scrapes the
page — silently truncates the thread, usually without telling you. On top of that, copying
flattens the structure: fenced code blocks lose their language tag, tables collapse into
runs of text, nested lists lose their indentation, and LaTeX turns into markup soup.

Chat2MD reads the conversation from the same backend JSON the ChatGPT app itself uses, so it
gets **every turn from root to leaf of the active branch** — and it treats the result as
Markdown, because that is what the model actually authored, rather than round-tripping it
through rendered HTML.

## What you get

- The complete conversation, not the part that was on screen.
- Fenced code blocks that keep their language.
- Tables, nested lists, block quotes, links and inline formatting preserved.
- LaTeX carried through unchanged.
- A YAML front-matter block (title, source URL, model, dates, message count) so the file
  drops straight into Obsidian, Logseq, Quartz, Hugo or Jekyll without editing.
- A filesystem-safe filename derived from the chat title.
- Optional per-message timestamps, system messages, tool calls and reasoning steps.

## Install from source

Until the Chrome Web Store listing is live:

```bash
git clone https://github.com/hardelele/gpt-download-chat
cd gpt-download-chat
```

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked**.
4. Select the `extension/` folder in the cloned repo.
5. Open a conversation on `chatgpt.com`, click the Chat2MD icon, click **Download .md**.

There is no build step for development — the extension ships plain ES modules with no
bundler and no dependencies, so what you load is what you read.

## Build

Node 20+ (CI runs 22). No dependencies to install — `npm install` is not required.

```bash
npm test        # node --test, the whole suite
npm run verify  # pre-publish gate: manifest, icons, permissions, no remote code
npm run build   # verify, stage into dist/, and write dist/chat2md-<version>.zip
npm run icons   # regenerate the PNG icons from scripts/make-icons.mjs
npm run screenshots  # render the 1280x800 store screenshots with headless Chrome
```

`npm run build` produces a Web Store-ready archive with `manifest.json` at the **root** of
the zip, then reads the archive back and checks its central directory before declaring
success. The zip writer and the PNG encoder are both hand-rolled on `node:zlib` — this
repository has no third-party code in it at all.

## Architecture in five lines

1. **`extract.js`** runs in the page, asks the ChatGPT backend for the conversation JSON,
   and falls back to scrolling + scraping the DOM only if that fails — never throwing for a
   recoverable problem, just recording a note in `warnings[]`.
2. **`api-client.js` / `dom-scrape.js`** are those two paths; **`html2md.js`** converts DOM
   nodes to Markdown for the fallback path only.
3. Both paths emit the same `Conversation` object (see [`CONTRACT.md`](CONTRACT.md)).
4. **`markdown.js`** renders that object to Markdown and **`filename.js`** names the file.
5. **`popup/`** collects options and **`background.js`** hands the string to
   `chrome.downloads` — the only place anything leaves the extension.

## Privacy

Chat2MD collects nothing, transmits nothing, and stores nothing but your own render
preferences. There is no server, no account, no analytics, no telemetry and no remote code.
The only network requests are to `chatgpt.com` / `chat.openai.com`, using the session you are
already signed in to, exactly as the page itself does.

`scripts/verify.mjs` enforces this mechanically on every build: it fails if a remote script
reference, an `eval(`, a `new Function(`, an `<all_urls>` host permission, or a URL to a host
the manifest does not declare appears anywhere under `extension/`.

Full policy: [`PRIVACY.md`](PRIVACY.md) ·
published at <https://hardelele.github.io/gpt-download-chat/privacy.html>

## Related builds

The same renderer, popup and build pipeline back three sibling extensions for other
assistants — see [`CONTRACT-PLATFORMS.md`](CONTRACT-PLATFORMS.md). Only the extractor, the
manifest and the store copy differ per platform.

## Contributing

Issues and pull requests welcome. Run `npm test && npm run verify` before opening one; CI
runs exactly that plus `npm run build`.

## License

MIT © 2026 Hardelele. See [`LICENSE`](LICENSE).
