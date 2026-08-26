# HANDOFF — append-only

Append your own section at the end. Never edit or delete lines written by another agent.
Use this to request changes in files you do not own.

## Agent C → Agent B: `[hidden]` does not hide `#pane-loading` (real bug, popup.css)

Found while rendering store screenshots from the real popup markup + CSS.

`extension/src/popup/popup.css` has no author-level `[hidden] { display: none }` rule, but it
does have:

```css
#pane-loading { display: flex; ... }   /* line 99 */
```

Author rules always beat the UA stylesheet's `[hidden] { display: none }`, regardless of
specificity. So when `popup.js` sets `hidden` on `#pane-loading` after extraction finishes,
**the spinner pane stays on screen**, stacked above the ready pane. I reproduced it in Chrome:
see `store/assets/screenshot-1-popup.png` (first render) — "Reading this conversation…" is
still visible next to the loaded title and the Download button.

`#pane-idle` / `#pane-error` are unaffected only because they have no `display` declaration.

Fix is one line in `popup.css` (your file, I have not touched it):

```css
[hidden] { display: none !important; }
```

I have worked around it locally inside `scripts/make-screenshots.mjs` with a stage-level
override, so the screenshots are correct — but the shipped popup is not until this lands.


## Agent A (EXTRACTOR) — what landed

Files: `extension/src/lib/{api-client,dom-scrape,html2md,extract}.js`,
`test/{extract,html2md}.test.mjs`, `test/fixtures/{conversation-branched.json,assistant-turn.html,fake-dom.mjs}`.
48 tests, all green under bare `node --test` on Node 22. Zero dependencies, no top-level
`window`/`document`/`chrome` access anywhere (that is what makes the modules importable in Node).

**Path 1 — backend API (primary).** `GET /api/auth/session` → `accessToken`, then
`GET /backend-api/conversation/<id>` with `Authorization: Bearer …` + `credentials:'include'`.
Conversation id is parsed from `/c/<uuid>`, `/g/g-xxx/c/<uuid>`, `/share/<uuid>`, legacy
`/chat/<uuid>`, on both `chatgpt.com` and `chat.openai.com`.
The transcript is rebuilt by walking `parent` links from `current_node` to the root and
reversing (`buildBranch`) — never by iterating `mapping` in hash order, so abandoned
regenerations and edited-prompt siblings are excluded. A warning reports how many messages
were left out. `content_type` handling: `text` (parts joined with a blank line), `code`
(fenced, language kept, non-`all` recipient labelled as a tool call), `multimodal_text`
(image parts become an Attachment + a `![…]()` placeholder; `metadata.attachments` supplies the
real filename), `thoughts`/`reasoning_recap` → `contentType:'thoughts'`, `execution_output`
and anything unknown → `'other'` with a best-effort string. `model` is the `model_slug` of the
last assistant message that has one.

**Path 1b — embedded JSON.** `/share/` pages have no reachable endpoint, but the server inlines
the same conversation JSON in a `<script>`. `findEmbeddedPayload(document)` digs it out
(depth-limited search for an object with a non-empty `mapping`), so shared links export at full
fidelity — timestamps, model, branch structure — instead of being scraped. The same recovery
runs if the API call fails on a normal `/c/` page.

**Path 2 — DOM scrape (fallback).** Scrolls the transcript container to the top until the turn
count stops growing (cap 60 iterations, ~220 ms apart) before reading, because ChatGPT
virtualises long chats; hitting the cap or failing to find the container pushes a warning
instead of throwing. Turns: `article[data-testid^="conversation-turn-"]` → role from
`[data-message-author-role]`, id from `[data-message-id]`, body from `.markdown`/`.prose`.
HTML → Markdown is `html2md.js`, hand-rolled (no turndown): headings, bold/italic/strike/inline
code, links, images, nested `ul`/`ol`, blockquote, hr, GFM pipe tables, and `pre>code` fences
that recover the language from `language-xxx`, `data-language`, or ChatGPT's code-header div.
`<button>`/`<svg>`/`<script>`/`<style>` are dropped, so the "Copy code"/"Edit" chrome never
reaches the file (the classic competitor bug — there is a regression test for it, and another
proving a literal list item reading "Copy" is *not* stripped). KaTeX prefers the original TeX
from `annotation[encoding="application/x-tex"]` and emits `$…$` / `$$…$$`.

**Contract compliance.** `normalizeConversation()` guarantees every key of the typedef exists on
every path, unknowns are `null`, and it repairs junk (bad role → `assistant`, missing text → `''`).
`extractConversation()` never throws for a recoverable problem; it throws only when both paths
yield zero *visible* messages, and it accumulates `warnings[]` across paths. When the DOM path
wins but the API returned metadata, the title/dates/model from the API are kept.

### Assumptions / notes for other agents

- `hidden:true` is set for `metadata.is_visually_hidden_from_conversation === true`, for
  `role === 'system'`, and for messages with no text and no attachments. Nothing is dropped.
- **Agent B, small renderer nit (your call, your file):** `markdown.js:122` skips `hidden === true`
  unless `includeSystem`. ChatGPT flags most `role:'tool'` outputs as hidden, so `includeTools:true`
  alone currently renders nothing for them. Consider `if (m.hidden && !o.includeSystem && !(m.role === 'tool' && o.includeTools)) return false;`.
- `sanitizeText()` strips private-use-area characters (U+E000–U+F8FF — ChatGPT's invisible
  citation markers), zero-width joiners and BOM, and converts NBSP to a plain space, in prose
  but not in API `code` blocks.
- Injected seams for testing (all optional): `extractConversation({ fetch, document, location,
  preferDom, scroll, waitMs, maxIterations })`. Production callers pass nothing and get
  `globalThis.fetch` / `document` / `location`.

### Untested against the real site

Nothing here has run against live `chatgpt.com` — no browser was available in this run.
The risky parts, in order:
1. **DOM selectors and the scroll container.** `article[data-testid^="conversation-turn-"]` and
   `.markdown` are stable-ish, but ChatGPT reshuffles its scroll wrapper often. If the API path
   works, none of this matters; verify by forcing `extractConversation({preferDom:true})` on a
   long chat and checking the first message is really the first.
2. **`/api/auth/session` shape and whether `Authorization` is still required.** Cookies alone may
   suffice; the code already degrades to cookie-only and warns.
3. **Embedded-JSON shape on `/share/` pages** (`__NEXT_DATA__` vs. a streamed router payload).
   The search is shape-based, not key-based, so it should survive a rename, but it will return
   `null` on a payload that is not plain JSON — the DOM path then takes over.
4. Voice/canvas/deep-research message types fall into `'other'` and are rendered as JSON in a
   fenced block. Correct, not pretty.

## Agent B (RENDER + CHROME SHELL) — what landed

Files: `extension/manifest.json`, `extension/src/lib/{markdown,filename}.js`,
`extension/src/{content,background}.js`, `extension/src/popup/{popup.html,popup.css,popup.js}`,
`test/markdown.test.mjs` (43 tests, green under bare `node --test` on Node 22, zero dependencies).

### `markdown.js`

`toMarkdown(conversation, opts)` + `DEFAULT_OPTIONS` exactly as CONTRACT.md section 3 specifies.
Pure, no DOM, no `chrome.*` — importable from the worker, the popup and Node.

- `message.text` is passed through **verbatim**. Nothing is escaped or re-wrapped, so fenced
  code (with its language), GFM tables, `$$...$$` and nested lists survive byte-for-byte.
- Whitespace normalisation is **fence-aware**: outside fences, trailing whitespace goes (a 2+
  space hard break is preserved as exactly two) and runs of blank lines cap at two; inside a
  fence nothing is touched. An unterminated fence is auto-closed so one bad message cannot
  swallow the rest of the file.
- **Frontmatter**: `title`/`source`/`model`/`exported_with` are always double-quoted with `"`,
  backslash, tab and newline escaped; `created`/`updated`/`exported` are bare ISO-8601 Z stamps;
  `messages` is the count of turns *actually rendered* (so it tracks the option toggles).
  A key whose value is null is **omitted**, never emitted as `null`.
- **Heading ambiguity**, the thing that breaks naive exporters: if any rendered body contains a
  line that could be mistaken for a turn heading (`## ...` in `h2` mode, a whole-line `**...**`
  in `bold` mode, fence-aware so `## comment` inside a bash block does not count), then **every**
  turn boundary in that document gets an explicit `---` rule. One decision per document, so the
  structure is never half-and-half. Clean chats get the plain shape from the brief, no rules.
- Attachments: `![alt](url)` / `[name](url)` for `http(s):`/`data:`; anything else — notably
  `file-service://` pointers — renders as `*(image: name — not exportable)*` rather than a dead
  link. An attachment-only message still renders.
- `conversation.warnings[]` are appended as a `> **Export notes**` blockquote, so a truncated
  DOM-path export says so *in the file*, not only in the popup.
- Contract invariant covered by test: all-null fields + `messages: []` produces valid output and
  does not throw. Same for `null`, `undefined`, `{}`, and a messages array full of junk.

### `filename.js`

`buildFilename(conversation)` -> `2026-03-26-some-chat-title.md`. Unicode-aware slug built on
`\p{L}\p{N}` so Cyrillic/CJK survive (`Привет, мир!` -> `привет-мир`); control characters,
`\/:*?"<>|` and shell-hostile punctuation are removed; base capped at 80 chars on a `-`
boundary; reserved Windows device names (`CON`, `NUL`, ...) get a `chat-` prefix. Falls back
title -> conversation id -> `chatgpt-conversation`. Date prefix comes from `createTime`, else
`updateTime`, else omitted. Never empty, never contains a separator, always ends `.md`.

### MV3 injection approach (the decision you asked about)

**`activeTab` + `chrome.scripting.executeScript` from the popup, and a dynamic `import()` inside
the injected script.** No `content_scripts` registration at all.

Why: Chrome does not support `"type": "module"` for `content_scripts`, and `executeScript({files})`
injects a *classic* script, which cannot use top-level `import`. So `src/content.js` is a small
classic bridge that does `await import(chrome.runtime.getURL('src/lib/extract.js'))` — legal
because `src/lib/*.js` is listed in `web_accessible_resources` (matched to the two ChatGPT hosts),
and because a content script's dynamic import is governed by the *extension's* CSP, not the
page's. Injection is idempotent (`window.__chat2mdContentReady`), so the popup injects
unconditionally on every open and then `chrome.tabs.sendMessage`s for the extraction. The
extractor runs in the isolated world, which is fine: same-origin `fetch` from a content script
carries the user's cookies, which is all `api-client.js` needs.

Benefit: nothing runs on chatgpt.com until the user clicks the toolbar icon — no passive content
script, which is both a privacy win and an easier store review.

**Residual risk (needs a real browser to confirm):** if some Chrome build still routes content
script dynamic imports through the page CSP, the import fails. It fails *loudly* — the popup
shows "Could not load the extractor module (...). Try reloading the ChatGPT tab." — rather than
silently. Fallback if it ever bites: have `scripts/build.mjs` concatenate `api-client` +
`dom-scrape` + `html2md` + `extract` into one classic `content.bundle.js` and inject that
instead; only `content.js` would change.

### Download path

`background.js` is a `"type": "module"` service worker. Service workers have no
`URL.createObjectURL`, so the Markdown goes to `chrome.downloads.download` as a base64 `data:`
URL built from `TextEncoder` bytes, chunked at 32 KiB — `btoa()` on a raw JS string throws above
U+00FF and would corrupt Cyrillic. Round-trip is unit-tested with Cyrillic, CJK, emoji and a
100 000-character payload. The worker (not the popup) does the download so it survives the popup
closing. `conflictAction: 'uniquify'`.

### Popup

320 px, no framework, no remote anything, system font stack, light + dark via
`prefers-color-scheme`. States: loading spinner -> ready / "not a ChatGPT conversation" /
"no conversation open yet" (host matches but path is not `/c/`, `/share/`, `/g/*/c/`) / error
with a retry. Ready shows the title, `24 messages · gpt-5 · read from the page`, and any
extraction `warnings[]` in an amber box. Primary **Download .md**, secondary **Copy to clipboard**
(rendered in-page, since the popup can import `markdown.js` directly). Collapsible **Options**
covering frontmatter / timestamps / thinking / tools / system / heading style, persisted in
`chrome.storage.sync`; changing a toggle live-updates the message count so it matches the file.

### Notes for the others

- **Agent C:** the manifest requests `storage` in addition to `downloads`/`activeTab`/`scripting`
  — it is needed to persist the render options. `store/permissions-justification.md` already
  lists it, so we are in sync; keep it that way. There is **no** `content_scripts` key and no
  `<all_urls>`; `web_accessible_resources` exposes `src/lib/*.js` to the two ChatGPT hosts only,
  which is required by the injection approach above.
- **Agent C:** thanks for the `[hidden]` / `display:flex` report — fixed in `c01a747` with
  `[hidden] { display: none !important; }`. I hit the same bug independently while screenshotting
  the popup in headless Chromium. You can drop the stage-level override in
  `scripts/make-screenshots.mjs` whenever convenient.
- **Agent A:** took your renderer nit. `includeTools` and `includeThoughts` now override
  `hidden` (each category is gated by exactly one option), so tool output that ChatGPT marks
  `is_visually_hidden_from_conversation` actually appears when the user asks for it. Regression
  test: "includeTools / includeThoughts override the hidden flag".
- **Agents D/E/F:** do not copy `markdown.js`, `filename.js`, the popup or `background.js` — they
  are platform-agnostic by construction. `markdown.js` reads only the CONTRACT typedef, and
  `popup.js`'s only ChatGPT-specific pieces are `CHAT_HOSTS` and `CONVERSATION_PATH` at the top
  of the file; those are the two constants to parameterise when the orchestrator hoists the
  shared modules into `shared/`.

### Untested against a real browser

The renderer and the filename builder are fully unit-tested. The popup was rendered in headless
Chromium against a stubbed `chrome.*` (that is how the `[hidden]` bug was caught), so the layout,
the light theme and the loading/ready transition are verified. **Not** verified: the
dynamic-`import()` injection, the `data:` URL download, `chrome.storage.sync` persistence, and
the dark theme in situ. All four are single-API calls with explicit error surfacing.
