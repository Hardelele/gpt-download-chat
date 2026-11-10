# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_Nothing yet._

## [0.1.2] — 2026-11-10

### Changed

- **New icon.** A chat bubble in the platform colour with a bold Markdown `#` cut into it,
  replacing the generic download arrow — it now says "a chat, as Markdown" and no longer
  looks like every other downloader in the toolbar. The popup header uses the same icon
  instead of its own green "MD" tile, and the store screenshots are re-rendered with it.

## [0.1.1] — 2026-11-10

### Fixed

- **ChatGPT: chats someone else shared with you (`/share/<id>`) could not be downloaded.**
  ChatGPT stopped inlining the conversation JSON on share pages and now loads it from
  `/backend-api/share/<id>`; the page DOM carried no turns either, so every path came up
  empty. The extension now reads that endpoint. It sends the request without cookies first —
  with the viewer's cookies the backend binds the call to *their* workspace and answers 401 —
  and retries with the bearer token only if the anonymous call is refused. The embedded-JSON
  and DOM paths remain as fallbacks.

## [0.1.0] — 2026-08-26

First release. Exports a full ChatGPT conversation to a Markdown file.

### Added

- **Full-conversation extraction.** Reads the conversation from the ChatGPT backend JSON and
  walks the active branch root-to-leaf, so long chats are exported in full rather than
  truncated to whatever the virtualised message list happened to have rendered.
- **DOM fallback.** If the backend path is unavailable, the extension scrolls the
  virtualised list and scrapes the page instead, converting rendered HTML to Markdown. The
  fallback records what it may have missed in a `warnings[]` list, surfaced in the popup,
  rather than failing silently.
- **Markdown renderer** with YAML front matter (title, source URL, model, create/update
  dates, message count), `## You` / `## ChatGPT` turn headings, and preservation of fenced
  code blocks with their language tag, tables, nested lists, block quotes and LaTeX.
- **Export options**, remembered locally: front matter, per-message timestamps, system and
  hidden messages, tool calls, reasoning steps, and `h2` vs bold turn headings.
- **Copy to clipboard** as an alternative to downloading.
- **Filesystem-safe filenames** derived from the chat title and date.
- Support for both `chatgpt.com` and `chat.openai.com`.
- Extension icons at 16/32/48/128 px, generated from source by `scripts/make-icons.mjs` —
  a dependency-free PNG encoder built on `node:zlib`.
- `scripts/verify.mjs`, a pre-publish gate that checks the manifest, the icons, that every
  manifest-referenced file exists, that no over-broad host permission is requested, and that
  no remote code (`eval`, `new Function`, remote `<script src>`, undeclared hosts) appears
  anywhere under `extension/`.
- `scripts/build.mjs`, which runs the gate and writes a Chrome Web Store-ready zip with
  `manifest.json` at the archive root, then reads the archive back to confirm it is well
  formed. Both the zip writer and the PNG encoder are hand-rolled; the project has no
  third-party dependencies.
- `scripts/make-screenshots.mjs`, which renders the 1280×800 store screenshots from the real
  popup markup and CSS and the real renderer output using headless Chrome.
- GitHub Actions CI on Node 22: test, verify, build, and upload the zip as an artifact.
- Privacy policy published via GitHub Pages from `docs/`.

### Security

- Manifest V3 with `"content_security_policy": {"extension_pages": "script-src 'self'; object-src 'self'"}`.
- No remote code of any kind; all JavaScript ships inside the package.
- Host access limited to `https://chatgpt.com/*` and `https://chat.openai.com/*`. No
  `<all_urls>`, no wildcard host patterns.
- No data collection, no analytics, no telemetry, no network egress to any third party.

[Unreleased]: https://github.com/hardelele/gpt-download-chat/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/hardelele/gpt-download-chat/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/hardelele/gpt-download-chat/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/hardelele/gpt-download-chat/releases/tag/v0.1.0
