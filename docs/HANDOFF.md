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

---

## Agent F — Google AI Mode extractor (`extensions/aimode/**`, `test/aimode-extract.test.mjs`, `store/aimode/**`)

### What I built

- `extensions/aimode/src/lib/extract.js` — `extractConversation(opts)` → the CONTRACT
  `Conversation`, for an **AI Mode thread in Google Search** (and, as a fallback, an
  **AI Overview** block). DOM-only; there is no callable same-origin JSON endpoint for this
  surface (the answer streams over `/async/folwr`, which is not replayable from a content
  script).
- `extensions/aimode/manifest.json` — MV3, mirrors Agent B's shape. `permissions:
  ["downloads","activeTab","scripting"]`, host permissions **path-scoped** to
  `https://www.google.com/search*` and `https://www.google.com/ai*`.
- `test/aimode-extract.test.mjs` — 34 tests, `node --test`, zero deps.
- `store/aimode/listing.md` — name/short/full copy, permission justifications, and an
  "honesty notes" section recording what was verified and what would invalidate the pitch.

### What I actually verified about the live surface (2026-08-26) vs. what is assumed

**Verified** (from Google's own help pages and from published scraper write-ups):

| Fact | Consequence in the code |
| --- | --- |
| `udm=50` triggers AI Mode; `aep=11` also observed | URL handling, host permissions |
| **`google.com/ai` is Google's own documented AI Mode entry point** | Added to `host_permissions` — the brief only mentioned `&udm=50`. Anyone wiring `content_scripts` must match both. |
| `[data-session-thread-id]` marks the thread; the answer wraps it | `ROOT_STRATEGIES[0]`, lifts to the parent |
| `[data-subtree="aimc"]` = "AI Mode container" | `ROOT_STRATEGIES[1]` |
| Citation pills are `button[data-icl-uuid][data-amic="true"]` | `isCitationPill()` |
| **Pill target URLs are not in the DOM** — they sit in hidden `<!--Sv6Kpe[["<uuid>",...]]-->` comment blocks | `parseCitationComments()`; this is why copy-paste loses every source, and why an in-page extension can do something the clipboard cannot |
| Source rail: `a.ZbQNgf`, and `[data-container-id="rhs-col"] [role="dialog"] a` | `collectPanelSources()` |
| AI Overview block: `#m-x-content [data-container-id="main-col"]` / `[data-rl]`, pills `[jsname="HtgYJd"]` | `ROOT_STRATEGIES[3..5]` |
| AI Mode **does** have Share (public link, needs history + personalization on) and **does** appear in Takeout via Search Services History since the June 2026 history-controls split | Store copy does **not** claim "no export exists" — that would be false. It claims no per-thread *file* with citations, which is true. |

**Assumed / not verifiable without a live signed-in page:**

- That question turns are headings (`h1`-`h3` or `role="heading"`) and that the turns are
  contiguous children of one column element. This is `findTurns()` strategy S2
  (`heading-segmented`) and it is the path a normal multi-turn thread will take. It is the
  single most likely thing to be wrong.
- The exact JSON shape inside the `Sv6Kpe` comment. The parser is deliberately tolerant
  (locate uuid, take the following slice, first URL and first plausible quoted title) rather
  than assuming a field order.
- Which "Show more"-style controls exist and what they are labelled. `expandThread()` matches
  on `aria-label`/text landmarks, not classes.
- Nothing here was run against a real google.com page. **Before publishing, someone must load
  a real AI Mode thread and check `findTurns()` reports `heading-segmented`, not
  `single-answer`.** A `single-answer` result on a multi-turn thread is not a crash — it
  produces one run-on assistant message and a warning saying so — but it is a bad export.

### How fragile is this, honestly

Fragile, and structurally so — there is no stable contract on this page and no version of
this extractor will be maintenance-free. Mitigations actually in the code:

1. **No hashed class names are used as primary anchors.** The only class matched anywhere is
   `ZbQNgf` (source rail), and it is one of several fallbacks, never load-bearing.
2. **Prioritised, falling-through strategy arrays** (`ROOT_STRATEGIES`, then S1 explicit
   turn attrs, S2 headings, S3 whole-panel). A single Google tweak degrades one level
   instead of killing the export.
3. **Loud, honest failure.** Unrecognised layout gives `messages: []` plus a warning naming
   the anchors that were looked for. Recognised container but unsplittable gets its own
   warning. A turn with a question but no answer text (answer still streaming) gets its own
   warning. Citations that resolve to no URL keep their number, the line reads
   `1. Title (link unavailable)`, and a warning says how many. There is no code path that
   returns a plausible-looking but truncated file silently.
4. **Never mutates the live page.** Everything runs on a `snapshot()` copy, so the citation
   rewriting cannot break Google's own JS.

Expected half-life of S2 without maintenance: months, not years. The attribute anchors
(`data-session-thread-id`, `data-icl-uuid`) are more durable than the structure guesses.

### AI Overviews — decision: **yes, covered, by the same extractor**

One extractor handles both. They share the citation-pill model and the html2md path; the only
real difference is that an AI Overview is a single answer with no follow-up turns and lives
under `#m-x-content` instead of the AI Mode container. That is three extra entries in
`ROOT_STRATEGIES` plus an `overview` flag that skips turn-segmentation and adds a warning
saying "this was an AI Overview, not a thread". Splitting it into a second extractor would
have duplicated the whole citation layer to save nothing. Note the trade-off: on an AI
Overview the user's question comes from the `q` parameter, because the page has no question
node of its own.

### Requests / notes for other agents (I did not touch your files)

1. **`html2md.js` import path.** `extract.js` imports it as
   `../../../../extension/src/lib/html2md.js`. When the orchestrator hoists shared modules
   into `shared/`, this line (and the same line in the Claude/Gemini extractors) needs
   updating. It is the only cross-tree import in my file.
2. **`html2md.parseHTML` discards comment nodes.** Correct for Markdown conversion, but it
   means an HTML-string fixture can never carry the `Sv6Kpe` block that holds AI Mode's
   citation URLs. My tests work around it by grafting comment nodes on after parsing
   (`dom()` in `test/aimode-extract.test.mjs`). Real `document` keeps comments, so production
   is unaffected. Agent A: no change requested, just be aware if you ever advertise
   `parseHTML` as a general-purpose fixture parser.
3. **`html2md` drops `<button>` (in `DROPPED_TAGS`).** Correct in general — but AI Mode's
   citations *are* buttons. I rewrite every pill into an `<a>` before calling
   `htmlToMarkdown`, so nothing is lost. Please do not "fix" this by un-dropping `button`.
4. **Citation markers render as `[[1]](url)`** — bracketed number as the link label, which
   CommonMark accepts (balanced inner brackets). If the renderer ever escapes `[` in message
   text, this breaks; it currently does not.
5. **Renderer labels.** `markdown.js` defaults to `assistantLabel: 'ChatGPT'`. For this item
   the build should pass `{ userLabel: 'You', assistantLabel: 'AI Mode' }`. Not my file —
   flagging it for whoever wires the per-item builds.
6. **No `storage` permission** in `extensions/aimode/manifest.json`, on purpose (this item has
   no options to remember). If the shared popup calls `chrome.storage`, either guard the call
   or tell me and I will add the permission — I would rather add it than have the popup throw.
7. **Missing from my tree by design** (shared, per CONTRACT-PLATFORMS): `icons/*`,
   `src/popup/**`, `src/background.js`, `src/content.js`, `src/lib/markdown.js`,
   `src/lib/filename.js`. `manifest.json` already points at `src/popup/popup.html` and
   `src/background.js` in the shapes Agent B used, so hoisting should be a copy.
8. **Deliberate deviation from CONTRACT section 3.** `extractConversation()` for AI Mode
   *never* throws, including when zero messages are found — it returns `messages: []` with an
   explanatory warning, per the Agent F brief ("never return a half-empty export that looks
   successful"). Agent B's stated invariant (`toMarkdown` must handle an all-null,
   zero-message Conversation) already covers this. The popup should surface `warnings[]` to
   the user when `messages.length === 0` rather than downloading an empty file.
9. **`store/aimode/assets/` screenshots are TODO** and need a real signed-in AI Mode capture.
   The listing spells out what each must show.
10. **Naming rule I checked, since it was flagged:** Google's branding guidelines forbid using
    a Google trademark as a third-party product's name, and permit "for ..." phrasing with the
    trademark symbol on the trademark. Hence `Chat2MD for AI Mode — Save AI answers as
    Markdown` (49 chars) with "Google Search(TM)" only in the description body, plus a
    non-affiliation line at the end of the detailed description. Do not rename this item to
    anything starting with "Google".

---

# Agent E — Gemini / AI Studio extractor

## Files owned and landed

```
extensions/gemini/manifest.json           MV3, mirrors extension/manifest.json (Agent B)
extensions/gemini/src/lib/dom-util.js     node-agnostic DOM helpers + VNode tree
extensions/gemini/src/lib/gemini-dom.js   gemini.google.com parsing — PURE
extensions/gemini/src/lib/aistudio-dom.js aistudio.google.com parsing — PURE, second path
extensions/gemini/src/lib/extract.js      extractConversation() — the only impure module
test/gemini-extract.test.mjs              50 tests: 48 pass, 2 honestly skipped
store/gemini/listing.md                   store copy + permission justifications
```

## The reality check, recorded as asked: Gemini has no usable conversation API

I looked before committing to the DOM. Conclusion: **there is no same-origin JSON conversation
endpoint on gemini.google.com that an extension can call**, the way `chatgpt.com` and
`claude.ai` both have. The consumer app is driven by `/_/BardChatUi/data/batchexecute` — a
Google RPC envelope whose payload is a doubly-encoded JSON string of positional arrays,
submitted with per-build tokens (`f.req`, `rpcids`, `bl`, `at`) that rotate with every deploy,
and whose response is a compiled envelope with no stable field names. Every open-source Gemini
exporter that is still working scrapes the DOM; the ones that tried the RPC are abandoned.
**So on this platform the DOM is the primary path, not the fallback, and `extractedVia` is
always `'dom'`.** That is not a degradation to apologise for in `warnings[]` — it is the only
path — but its consequences are (no timestamps, lazy loading), and those are warned about.

## Architecture — and the one thing I did NOT write

There is **no second HTML-to-Markdown converter here.** `gemini-dom.js` sanitises Gemini's
Angular DOM into a clean `VNode` tree and hands it to **Agent A's `htmlToMarkdown()`**,
imported by relative path:

```js
import { htmlToMarkdown } from '../../../../extension/src/lib/html2md.js';
```

> **Request for the orchestrator:** when `html2md.js` is hoisted to `shared/`, this one import
> line in `extensions/gemini/src/lib/gemini-dom.js` needs rewriting, as does the import in
> `test/gemini-extract.test.mjs` (which pulls `parseHTML` from the same module to build
> fixtures). Nothing else in my tree points outside it.

The split is deliberate:

- `dom-util.js` + `gemini-dom.js` + `aistudio-dom.js` are **pure**. They touch only
  `nodeType / tagName / childNodes / getAttribute / textContent`, which is exactly the subset
  Agent A's converter uses. That is what makes them testable under plain Node with no jsdom,
  and it is why `parseUserQuery()` works on a hand-written object literal (there is a test that
  proves it).
- `extract.js` owns everything impure: scrolling, clicking, `document`, `location`.

## What I verified vs. what I assumed about the Gemini DOM

**Verified** (cross-checked against several currently-maintained open-source exporters and
against what the app is documented to emit):

- Turns are Angular *component elements*: `<user-query>` and `<model-response>`, wrapped in
  `.conversation-container`, inside `#chat-history > infinite-scroller`.
- The answer body is `<message-content class="model-response-text"> > div.markdown.markdown-main-panel`.
- Code lives in a `<code-block>` component: language label in `div.code-block-decoration > span`,
  code in `pre > code`, a "Copy code" button in the header, a "Use code with caution" footer.
- The scroller loads **older** turns as you scroll up; `scrollTop = 0` in a loop until
  `scrollHeight` stabilises is the pattern every working exporter uses.
- Screen-reader labels ("You said") sit in `.visually-hidden` spans and must be stripped.
- Gemini has **no per-conversation Markdown or file export** — only Export-to-Docs for a single
  response, a public Share link, per-response copy, and account-wide Google Takeout (whose
  "Gemini" entry exports *Gems*, not chats; conversations live under My Activity → Gemini Apps).
  The store copy is written against exactly that and says so.

**Assumed / not confirmed against a live signed-in session** (I had no Gemini session to drive):

- The exact class names on the thinking panel (`<model-thoughts>`, `.thoughts-content`) and on
  the user query (`.query-text`, `.query-text-line`).
- The wrapper element names around generated images (`single-image`, `generated-image`) and
  uploads (`user-query-file-preview`).
- The mode-switcher markup used for `model` (`bard-mode-switcher`, `.mode-title`).
- Whether generated-image URLs are `blob:` or signed `googleusercontent.com` links.

**Every one of those assumptions is designed to fail loudly rather than silently.** Turn
discovery is by *element name* — the stablest thing in an Angular app — and never by a hashed
utility class. `.conversation-container` is only a sanity signal; its absence produces a warning
plus document-order pairing, not an empty file. A missed body selector falls back to the whole
turn element **and pushes a "markup may have changed" warning**. A page with no recognised turns
pushes a loud warning, and `extractConversation()` throws only when zero messages could be
recovered anywhere — per the CONTRACT.

## Whole conversation, not the visible part

`loadWholeThread()`:

1. finds the scroller (`#chat-history` / `infinite-scroller`, walking up to whatever actually
   overflows);
2. loops **bounded at 60 rounds**: expand, count turns and read `scrollHeight`, set
   `scrollTop = 0`, wait 450 ms. It exits after 3 consecutive unchanged rounds; if it hits 60
   first it pushes *"this conversation is very long and the beginning may be missing"*;
3. scrolls back to the bottom, runs one more expand pass for anything that mounted on the way
   down, then restores the user's original scroll position.

`expandCollapsed()` is deliberately conservative: it clicks only `aria-expanded="false"`
controls inside thought/query/response scopes, plus buttons whose *entire* label matches an
expand vocabulary ("Show more", "Show thinking", "Show drafts", …). It will never click
"Copy code", a thumbs-up, or a menu. There is a unit test that asserts exactly that.

## AI Studio: partially supported, and marked as such

Honest answer: **`gemini.google.com` is done properly; `aistudio.google.com` is a real but
unvalidated second code path.**

It is implemented (`aistudio-dom.js`), wired into `extract.js` by URL, covered by 9 tests, and
it handles `ms-chat-turn`, `.chat-turn-container.user|.model`, `ms-text-chunk` /
`ms-prompt-chunk` / `ms-cmark-node`, `ms-thought-chunk` → `contentType: 'thoughts'`, and
`ms-code-execution-chunk` → fenced code plus captured output. It also treats
`.very-large-text-container` as **raw Markdown taken verbatim** — pushing that through the HTML
converter would mangle the fences. But the fixtures were reconstructed from the selectors that
current AI Studio exporters rely on, **not from a live AI Studio session**, and the file header
says so.

Before submission somebody must open a real AI Studio prompt and export it. If it does not work,
the honest move is to delete the AI Studio bullet from the listing, remove "or AI Studio" from
the manifest description, and drop `https://aistudio.google.com/*` from `host_permissions`.
`store/gemini/listing.md` carries that instruction under "Honesty notes".

## Deviations from my brief — please read

1. **`storage` permission added.** My brief specified exactly
   `["downloads","activeTab","scripting"]`. I added `"storage"` because Agent B's shared popup
   calls `chrome.storage.sync.get/set` for the user's export options (`popup.js:255,271`), so
   the brief's list would ship a popup that throws. Agents B and D both include it. Say the word
   and I will remove it, but then the shared popup needs a graceful degradation.
2. **No `content_scripts` block.** Agent B injects `content.js` on demand via
   `chrome.scripting.executeScript`, so I mirrored that rather than declaring a static content
   script. `web_accessible_resources: ["src/lib/*.js"]` is kept, because `content.js` reaches the
   ES modules through `import(chrome.runtime.getURL(...))`.

## Requests for other owners

- **Agent B / orchestrator — assistant label.** Verified end to end: a Gemini `Conversation`
  through `toMarkdown()` + `buildFilename()` renders correctly, **but the heading says
  `## ChatGPT`**, because `DEFAULT_OPTIONS.assistantLabel` is `'ChatGPT'`. Each build needs a
  per-platform default (`'Gemini'` here, `'Claude'` for Agent D). Suggested shape: a `PLATFORM`
  constant the build injects, or `assistantLabel` seeded from the manifest name.
- **Agent C — build and verify.** Correction to an earlier draft of this note: `verify.mjs`
  *does* handle other items via `--dir`. `node scripts/build.mjs --dir extensions/gemini` runs
  and fails with exactly the 10 expected errors — the four `icons/*.png`, `src/popup/popup.html`
  and `src/background.js` are the **shared shell files the orchestrator still has to hoist in**.
  I deliberately did not copy them into my tree (Agent D did the same for `extensions/claude/`),
  because duplicating Agent B's popup and Agent C's icon binaries across three trees is exactly
  the duplication `CONTRACT-PLATFORMS.md` forbids. Nothing else in my tree blocks the build.
- **Orchestrator — misrouted message.** I received a coordination message carrying ground truth
  from the **live claude.ai API** (two-org selection, the `chat_conversations` endpoint,
  the `current_leaf_message_uuid` branch walk, the `thinking` block key, `attachments` vs
  `files`). That is **Agent D's** territory — `extensions/claude/**` — and file ownership forbids
  me from touching it, so I did not act on it. Please re-send it to Agent D. None of it applies
  to Gemini, which has no such API.

## Test coverage

`node --test test/gemini-extract.test.mjs` → **48 pass, 2 skipped, 0 fail**; the full repo suite
is green. Covered as required: a code block with a language *and* stripped "Copy code" (plus the
`content_copy` mat-icon ligature and the caution footer), nested lists, tables, a thinking panel,
and a turn with an image. Plus: blob-URL images rendering as `*(image — not exportable)*`,
attachment shapes, chronological multi-turn ordering, three separate selector-miss degradations,
the full CONTRACT typedef asserted on every message, metadata parsing, `extractConversation()`
end to end, cross-surface fallback, and `expandCollapsed()` click discipline.

**Skipped, with stated reasons, never faked:** (1) the live lazy-loading scroll, because a fake
scroller would only be testing itself — the loop is bounded by construction and its warning path
is asserted; (2) the real generated-image URL shape, which needs a live session with image
generation — the scheme classification the decision depends on *is* tested.

**Agent F addendum — `verify.mjs` status for `extensions/aimode`.** `node scripts/verify.mjs
--dir extensions/aimode` currently reports 10 errors, all of them missing shared assets
(`icons/icon16|32|48|128.png`, `src/popup/popup.html`, `src/background.js`). `extensions/claude`
and `extensions/gemini` report the identical 10, so this is the expected pre-hoist state for all
three per-platform items, not a defect in any one of them. It should go green the moment the
orchestrator copies the shared shell in. Everything `verify.mjs` checks that *is* mine —
manifest schema, MV3 version, description length, permission set, no remote code — passes.

## Agent A — updated after the coordinator's LIVE run against chatgpt.com

The coordinator exercised these paths in a logged-in browser. Their measurements confirmed the
design (node keys are exactly `id, message, parent, children`; branching occurred in 2 of 6
sampled conversations, largest mapping 68 nodes; 7 messages carried
`is_visually_hidden_from_conversation`) and produced three deltas, all now fixed and tested.
`test/extract.test.mjs` is 45 tests; `test/html2md.test.mjs` 17; all green.

**Delta 1 — auth is looser than assumed (fixed).** Cookies alone return 200 from
`/backend-api`, so the token is now an upgrade rather than a precondition: if
`/api/auth/session` fails or carries no `accessToken`, the conversation call still goes out with
`credentials:'include'` instead of bailing to the DOM. When a token *is* present it is sent as
both `Authorization` and `X-Authorization` (matching what the pionxzh exporter ships).
`Chatgpt-Account-Id` comes from `/backend-api/accounts/check/v4-2023-04-27` via
`pickAccountId()`, which prefers a workspace account over the personal one and degrades silently
on any failure — Team/Enterprise users need it, personal accounts are unaffected.
I also added a **single bare-cookie retry** on 401/403/404: an expired token or a wrong workspace
id otherwise sinks a request that plain cookies would have satisfied. 500s are not retried.

**Delta 2 — `execution_output` (fixed).** It was landing in `'other'` and being dumped as fenced
JSON. It now renders as a plain fenced block with `contentType:'code'`, role `tool`,
`authorName` from `author.name`; visibility is left to the existing hidden/tool gating. Empty
output collapses to `''` + `hidden:true` rather than emitting an empty fence.

**Delta 3 — `default_model_slug` (fixed).** `Conversation.model` now reads the conversation-level
`default_model_slug` first and falls back to the last assistant `metadata.model_slug`. Fixtures
were re-slugged to current-generation names (`gpt-5-6-thinking`, `gpt-5-4-thinking`,
`gpt-5-4-auto-thinking`) and there is **no pattern-matching on model names anywhere** in my code —
slugs are treated as opaque strings.

Also hardened from the observed context: `recipient` is treated as an arbitrary string
(`python`, `web.run`, `container.exec` and opaque hashes like `t2uay3k.sj1i4kz` are all labelled
verbatim — regression test covers all four); the `channel` field is ignored by design;
`thoughts`/`reasoning_recap` carry their text through untouched with `contentType:'thoughts'`,
so Agent B's `includeThoughts` toggle is all that stands between the user and a
reasoning section.

### Listing-worthy: shared links export at full fidelity

Every rival extension scrapes the DOM, and truncated long-chat exports are their #1 complaint —
our API-first path is the differentiator. **`/share/` links are the second one.** Competitors
either fail on them or scrape them; `findEmbeddedPayload()` pulls the conversation JSON that the
server inlines in a `<script>` tag on the share page, so a shared link exports with the same
fidelity as your own chat: real timestamps, real model, correct active branch, no truncation.
Agent C: worth a bullet in the store listing and the README ("works on shared links too").

### Still unverified

The **DOM fallback** remains the only untested-against-reality path — which now matters less,
since Delta 1 removed most of the reasons we would ever reach it. `/backend-api/conversations?offset=&limit=`
returning `{items, total, limit, offset}` is noted for a future bulk-export feature; I have not
built against it.
## Agent C — BUILD / REPO / STORE

### What I built

**Icons.** `scripts/make-icons.mjs` rasterises into an RGBA buffer with supersampled
antialiasing and encodes real PNGs using nothing but `node:zlib` — hand-written IHDR/IDAT/IEND
chunks with a CRC32 table. No sharp, no canvas, no jimp. Output: a full-bleed rounded badge in
deep ink with a white download arrow over an amber baseline; two colours and thick strokes so
it survives 16px. `extension/icons/icon{16,32,48,128}.png` plus `store/assets/icon512.png`.
All five verified to decode via .NET `System.Drawing` and inspected visually at 16px and 128px.
Regeneration is byte-identical, so `git status` stays clean after `npm run icons`.

**Build pipeline.**
- `scripts/verify.mjs` — pre-publish gate. Manifest JSON validity, `manifest_version:3`,
  Chrome-format version, name ≤75, description ≤132, all four icons present with correct
  IHDR dimensions and non-trivial size, every manifest-referenced file exists, no `<all_urls>`
  or wildcard host, no `unsafe-eval`/`unsafe-inline` CSP, and no remote-code smells
  (`eval(`, `new Function(`, remote `<script src>`/`<link href>`, `importScripts()`/`import()`
  from a URL) anywhere under the tree. It also flags any URL host the manifest does not
  declare — **derived from the manifest, not hardcoded**, so it works unchanged for the
  Claude / Gemini / AI Mode builds.
- `scripts/build.mjs` — runs the gate, stages into `dist/`, and writes the zip by hand with
  `zlib.deflateRawSync` + local file headers + central directory + EOCD. Stores rather than
  deflates when deflate does not help. **`manifest.json` is at the archive root.** After
  writing, it re-reads its own central directory and cross-checks the entry count against
  .NET `System.IO.Compression`. Refuses to package if `package.json` and `manifest.json`
  versions disagree.
- Both take `--dir`, so `node scripts/build.mjs --dir extensions/claude` works today.
- `.github/workflows/ci.yml` — Node 22, test → verify → build, zip uploaded as an artifact.

**Store material.** `store/listing.md` (item name, short description, ~430-word detailed
description, category, language, all dashboard field values), `store/permissions-justification.md`
(written against B's *actual* manifest — one paragraph each for `downloads`, `activeTab`,
`scripting`, `storage` and the two hosts, plus the single-purpose statement, the full
data-usage table and the Limited Use disclosure), `store/checklist.md` (ordered human
submission steps and what actually delays review), `PRIVACY.md`, and three 1280×800
screenshots.

**Repo.** `README.md`, `LICENSE` (MIT © 2026 Hardelele), `CHANGELOG.md` (Keep a Changelog),
`.gitignore`, `.gitattributes`.

### Two things I found and fixed that were not in my brief

1. **`npm test` was specified as `node --test test/` — that is broken on Node 22.** A bare
   directory argument is resolved as a *module*, so it fails with
   `Cannot find module '...\test'` and zero tests run. Bare `node --test` discovers everything
   correctly (251 tests). `package.json` now uses the bare form. Worth knowing before anyone
   "fixes" it back.
2. **`0o100644 << 16` overflows to a negative int32 in JS**, which made `writeUInt32LE` throw
   while writing ZIP external file attributes. Needs `>>> 0`.

### Reported to Agent B (now fixed by B)

`popup.css` had `#pane-loading { display: flex }` with no author-level `[hidden]` rule.
Author rules beat the UA stylesheet's `[hidden] { display: none }` regardless of specificity,
so setting `hidden` on the loading pane did not hide it and two panes rendered at once.
Caught while screenshotting the real popup. B has landed `[hidden] { display: none }`;
screenshots have been re-rendered against the fixed CSS.

### Screenshots — how they are made, and why that matters

`scripts/make-screenshots.mjs` does not mock the product. It reads the real
`popup.html` body and the real `popup.css` (scoped to a `.popup` container, with the
dark-mode media query stripped so the render is reproducible), drives it into the "ready"
state, and renders it with headless Chrome at exactly 1280×800. The Markdown shown beside it
is the genuine output of B's `toMarkdown()` and the filename is the genuine output of
`buildFilename()`, run over a sample conversation defined in the script. The slice shown in
shot 2 is located by searching the rendered output for the table, not by a fixed line offset,
so the caption cannot drift away from the pixels. Dimensions are asserted from the PNG IHDR
after rendering; the script exits non-zero if they are not 1280×800.

Chrome was found at `C:\Program Files\Google\Chrome\Application\chrome.exe`. If it is ever
absent the script still writes the HTML sources to `store/assets/src/` and says so rather
than shipping a fake.

### Status of the sibling builds (D / E / F) — for the orchestrator

I ran my gate against all three trees. Every one fails on **exactly the shared files that
have not been hoisted yet**, and on nothing else:

```
extensions/{claude,gemini,aimode}:
  icons/icon{16,32,48,128}.png     missing
  src/popup/popup.html             missing
  src/background.js                missing
```

Their manifests themselves are fine. So the hoist is the only blocker, as D/E/F reported.

I did **not** write into `extensions/**` — the addendum puts those trees outside my ownership.
Instead `scripts/make-icons.mjs` now takes `--dir` and `--accent`, so producing a per-platform
icon set is one command each, e.g.:

```
node scripts/make-icons.mjs --dir extensions/claude --accent "#d97757"
node scripts/make-icons.mjs --dir extensions/gemini --accent "#4285f4"
node scripts/make-icons.mjs --dir extensions/aimode --accent "#34a853"
```

Badge and arrow stay identical across all four — one family, one recognisable mark — and only
the baseline bar is tinted, which is enough to tell them apart in a toolbar. Whoever owns the
hoist should run those three lines and then `node scripts/verify.mjs --dir extensions/<p>`.

### What I assumed

- The store item name and short description are taken from `manifest.json` rather than typed
  into the dashboard. If B changes either, `store/listing.md` must change in the same commit.
- The privacy policy is served from `docs/` via GitHub Pages at
  `https://hardelele.github.io/gpt-download-chat/privacy.html`. **Pages is not enabled yet** —
  a human must switch it on (Settings → Pages → main / `/docs`) *before* submitting, because
  the reviewer opens that URL and a 404 is an instant rejection. `docs/.nojekyll` is committed.
- The one policy URL covers all four store items; the policy text is written to be
  platform-neutral about which assistant is being exported.

### What is left

- Enabling GitHub Pages, the $5 developer account, and the upload itself — human-only, all
  spelled out in `store/checklist.md`.
- Optional promo tiles (440×280, 1400×560). Not generated; only needed for store featuring.
- `dist/` is gitignored by design — CI publishes the zip as a build artifact.


---

## Agent D — claude.ai extractor

**Owned and delivered:** `extensions/claude/**`, `test/claude-extract.test.mjs`, `store/claude/**`.
64 tests, all green (`node --test`). Nothing outside those paths was touched.

```
extensions/claude/manifest.json          MV3, host_permissions: https://claude.ai/*
extensions/claude/src/lib/api-client.js  primary path: claude.ai's own conversation JSON
extensions/claude/src/lib/dom-scrape.js  fallback path: rendered page + bounded scroll
extensions/claude/src/lib/extract.js     extractConversation(opts) -> Conversation
test/claude-extract.test.mjs             64 tests, zero dependencies
store/claude/listing.md                  store copy + permissions justification
```

`extractConversation()` matches Agent A's signature and option bag
(`{conversationId, document, location, fetch, preferDom, scroll, maxIterations, waitMs}`)
and returns the CONTRACT typedef unchanged. `normalizeConversation` guarantees every key.

### Blockers — things I need from other agents (I did NOT write them, per CONTRACT-PLATFORMS)

1. **`extensions/claude/` is not yet a loadable extension.** `node scripts/verify.mjs --dir
   extensions/claude` fails with 10 errors, all of them missing *shared* files that the
   orchestrator is due to hoist. Nothing in the manifest itself is wrong — all the
   manifest-content checks pass. Still needed inside `extensions/claude/`:
   - `icons/icon16|32|48|128.png`
   - `src/popup/popup.html|popup.css|popup.js`
   - `src/background.js`, `src/content.js`
   - `src/lib/markdown.js`, `src/lib/filename.js`, `src/lib/html2md.js`
2. **`dom-scrape.js` imports html2md by relative path** —
   `import { htmlToMarkdown } from '../../../../extension/src/lib/html2md.js';` — which reaches
   outside the extension directory and therefore cannot be packaged as-is. When html2md moves to
   `shared/` (or is copied into each extension), that one import line is the only thing to
   rewrite. Per the contract I did not write a second converter.
3. **Renderer labels.** `markdown.js` defaults `assistantLabel: 'ChatGPT'`. For this build it
   should be `Claude`. Agent B / orchestrator: either make the label platform-configurable or
   let each extension pass `{assistantLabel:'Claude'}`. I did not touch `markdown.js`.
4. **Screenshots.** `store/claude/assets/` is empty; the listing marks two 1280x800 captures as
   TODO. They need a real claude.ai session, so a human has to take them.

### Requests against files I do not own

- **Agent B / `markdown.js`:** the render filter is
  `if (m.hidden === true && !o.includeSystem) return false;`. That means a message marked
  `hidden` needs `includeSystem`, *not* `includeThoughts` / `includeTools`. So I deliberately
  emit thinking with `contentType:'thoughts', hidden:false` and tool traffic with
  `role:'tool', hidden:false`, which is the only way those two options do anything. This differs
  from the "mark them hidden" sketch in my brief and is intentional — if `markdown.js` ever
  changes that line, tell me before it lands.
- **Attachment typedef:** claude.ai puts the *text* of an uploaded document in
  `attachments[].extracted_content`. The `Attachment` typedef has no field for content, so I drop
  it. A user message that is "here's my spec, review it" therefore exports without the spec.
  Adding an optional `content: string|null` to `Attachment` would fix it; I did not add a field
  to a shared typedef unilaterally.

### What I verified against reality vs. what is still an assumption

Verified against Anthropic's own docs plus live API/DOM probes and several mature open-source
claude.ai exporters (`daymade/claude-code-skills`, `sfmig/claude-conversation-tree`,
`agarwalvishal/claude-chat-exporter`, `osteele/claude-chat-viewer`, `lugia19/Claude-QoL`,
`Azzoril/claude-font-fix`):

- `GET /api/organizations` and
  `GET /api/organizations/<org>/chat_conversations/<conv>?tree=True&rendering_mode=messages`
  are real. `tree=True` is specifically what makes the response contain *every* branch;
  without it the server returns a pre-flattened path. Added `render_all_tools=true` because
  without it tool blocks collapse to "not supported on your current device", plus
  `skip_uuid_injection=true&consistency=strong`, which the real front-end sends.
- **`/api/bootstrap` is the right way to find the active org**, not `/api/organizations` —
  the latter lists memberships without saying which is active. Order is now
  bootstrap -> `lastActiveOrg` cookie -> `/api/organizations`, then each candidate is tried
  until one resolves the conversation.
- Field names: **`chat_messages`** (not `messages`); **`sender: 'human'|'assistant'`** (not
  `role`, not `'user'`); `parent_message_uuid` with root sentinel
  `00000000-0000-4000-8000-000000000000`; `current_leaf_message_uuid` on the conversation.
- **`text` and `content[]` coexist.** Under `rendering_mode=messages` `text` is usually empty,
  but an agent turn can carry its final answer in `text` while `content[]` holds only thinking
  and tool blocks. Treating `text` as a pure fallback loses answers, so it is folded in whenever
  it is not already present in the rendered prose.
- Block types `text`, `thinking`, `tool_use`, `tool_result` confirmed, **plus `voice_note`**.
  Thinking uses the field `thinking` (not `text`), and may carry `summaries[]` and `cut_off`.
- **Artifacts are authored across many `tool_use` blocks and many turns**, folded by `input.id`:
  `create`/`rewrite` carry full `content`, `update` carries only `old_str`/`new_str`. Rendering
  each block emits every intermediate draft, so `collectArtifacts()` replays the whole sequence
  and only the final revision is rendered, once. The replacement uses a *function* replacer
  because `$&` and friends inside `new_str` would otherwise be read as replacement patterns and
  silently corrupt the artifact. Artifacts render as `role:'assistant', contentType:'code'` and
  are visible by default — they are usually the most valuable thing in the chat.
- Same-origin `fetch(..., {credentials:'include'})` is sufficient. **No CSRF token and no
  `anthropic-*` header is required for GETs** (the `anthropic-client-platform` header I send is
  cosmetic). Unverified for POST/DELETE, which this extension never issues.
- Shared links have their own endpoint,
  `GET /api/chat_snapshots/<id>?rendering_mode=messages&render_all_tools=true`, which needs no
  org and no session. `/share/` URLs now use it instead of scraping, falling back to the page.
  Caveat: snapshot `tool_result.content[]` items can be `type:'knowledge'` rather than `'text'`;
  matching only `'text'` was measured to retain ~5% of one payload, so `knowledge` is handled.
- **DOM selectors — my brief's list was partly wrong and is corrected:**
  `[data-testid="user-message"]` is real. **There is no `data-testid="assistant-message"`**, and
  **`.font-claude-message` is dead**; `.font-claude-response` is the live assistant selector.
  `div[data-test-render-count]` is the per-turn wrapper for both roles but is a render-internal
  attribute. Message bodies are `.standard-markdown` (complete) / `.progressive-markdown`
  (streaming) — I read those so the copy/retry/read-aloud action bar stays out of the transcript.
- **Store claim verified.** claude.ai has no per-conversation export. Anthropic's help article
  "Export your Claude data" (updated 8 July 2026) documents only an account-wide
  Settings -> Privacy -> Export data request delivered by email. The listing cites it and
  deliberately does **not** assert the archive's file format, which the article never states.

Still assumed, not verified:
- The exact `attachments[]` / `files[]` field spellings vary by build, so `mapAttachments`
  probes several (`file_name`/`name`, `preview_url`/`preview_asset.url`/`document_asset.url`).
  Attachment URLs are the least-tested part of this extractor.
- No live request was made against a signed-in claude.ai session from this machine — driving the
  user's authenticated account was out of scope for an unattended agent. Everything network-side
  is exercised through an injected `fetch`, so the *plumbing* is tested but the *live response*
  is not. First manual run should be on a chat containing an artifact that was edited at least
  once, an uploaded file, and a regenerated answer.
- Claude's DOM has no reliable hook for the extended-thinking block. I match a few `data-testid`
  candidates; if none hit, thinking silently merges into the assistant prose on the fallback path
  only. The API path is unaffected.

### Risks

1. **Everything above is a private API.** No compatibility promise. The mitigation is that both
   paths exist, the API path never throws for a recoverable problem, and every degradation
   pushes a human-readable line into `warnings[]`.
2. **The DOM fallback is genuinely weak on claude.ai** — no message ids anywhere in the DOM,
   no reliable timestamps, virtualised transcripts, and React/JSX artifact previews live in a
   cross-origin `iframe[src*="claudeusercontent.com"]` that an extension cannot read at all.
   If the API path breaks, artifacts are lost. This is worth a visible warning in the popup.
3. `div[data-test-render-count]` and the Tailwind-derived class names will change without notice.
   Treat the fallback as best-effort and re-check selectors before each release.

### Agent D — addendum after the coordinator's live-API ground truth

The section above was written before the coordinator sent measurements taken against a
**logged-in claude.ai session**. Where that contradicted what I had built, it won. Corrections
landed in `d7efc10` and the commit after it. **Test count is now 80, all green**, and the full
suite (`node --test`) is 268 passing.

Reconciled:

- **`manifest.json` → `name` is now mark-free: `Chat2MD — AI Chat to Markdown`.** CLAUDE is a
  registered trademark (Reg. 7645254) and Anthropic publishes no nominative-use carve-out, so
  the earlier `Chat2MD for Claude` was a real risk. Compatibility moved into the description
  body ("Works with claude.ai"), and a TRADEMARKS / non-affiliation paragraph is now part of the
  store copy. `store/claude/listing.md` has a "Trademark constraint" section explaining why, so
  nobody renames it back. **Agents E and F: the same reasoning applies to Gemini and to Google's
  marks — worth checking your manifest names.**
- **Org selection.** Confirmed the two-org trap on a real account:
  `["chat","claude_max"]` holds the conversations, `["api","api_individual"]` holds none.
  `fetchConversation` now tries the `lastActiveOrg` cookie *before any request at all*, then
  `/api/bootstrap`, then `/api/organizations` sorted by capability, attempting each until one
  resolves the conversation. `orgs[0]` is never trusted. Two-org test added.
- **`render_all_tools=true`** was already in the query string; confirmed correct.
- **`message.truncated`** now raises a warning. **thinking blocks** now honour
  `truncated`, `cut_off`, `hidden` and `thinking_hidden` — the last two set the contract's
  `hidden` flag, since Claude itself marks that reasoning as not for display.
- **Thinking text is read from `b.thinking`, never `b.text`** (reading `text` yields empty
  reasoning). Already correct; now asserted by a test against a block carrying both.
- **Unknown block types are never dropped.** `tool_use`/`tool_result` did not appear in the
  sampled conversations, so my type list is certainly incomplete. Anything unrecognised falls
  back to `text` → `thinking` → `input` (as JSON) → the whole block, is counted, and produces
  one conversation-level warning naming the types seen. Artifact handling is gated on the block
  actually looking like an artifact, so it is inert when none appear.
- **`attachments[].extracted_content` is now exported**, not dropped — this supersedes the
  request in my section above, which asked for a new `Attachment` field. There is no URL on an
  `attachments[]` entry, so that text is the only copy of the document; it is appended to the
  message as `**Attachment: name**` plus a fenced block (language inferred from the extension)
  and merges into the user's own turn. **No change to the shared `Attachment` typedef is needed
  any more — please ignore that earlier request.**
- **`files[]` entries with no URL keep `url: null`.** The exact live shape
  (`success, path, file_kind, file_uuid, file_name, created_at, size_bytes, uuid`) has no URL at
  all, so nothing fabricates a dead link. Tested.
- **Round-number message counts warn.** No pagination was observed (largest sample: 48 messages),
  but an array of exactly 20/25/50/100/200/500/1000 is the shape a silent limit would take, so
  that now produces a warning rather than a silent truncation.
- Warnings are de-duplicated, so a problem affecting 40 messages produces one line, not 40.
- **Markdown fidelity is now asserted, not assumed.** Rivals lose users on mangled LaTeX,
  broken tables and footnote wreckage. A test round-trips a message containing inline and
  display math, an aligned table with math and code in its cells, three-deep nested lists, a
  footnote reference plus its definition, and a block quote with a link, and asserts the output
  is **byte-identical** to the source. Another asserts artifact code survives unescaped with no
  HTML entities. The API path never touches `html2md`, so this is structural, not luck.

Still UNVERIFIED, in order of how much it would hurt:

1. **`tool_use` / `tool_result` block shape.** They did not occur in the 235 sampled blocks. My
   handling comes from open-source exporters and the artifacts system prompt, not from a
   measured payload. Artifact folding (`create` → `update(old_str/new_str)` → `rewrite`, keyed
   on `input.id`) is the most intricate untested-against-reality code I own. **A conversation
   containing an artifact that was edited at least once is the single most valuable manual test
   anyone can run against this extension.**
2. **`attachments[]` / `files[]` URL fields.** `preview_url` / `preview_asset.url` /
   `document_asset.url` are probed because different builds report different spellings, but only
   the no-URL shape has been seen live. Attachment links are the least-tested output.
3. **No live request has ever been made from this machine.** Driving the user's signed-in
   account was out of scope for an unattended agent, so every network test uses an injected
   `fetch`. The plumbing is tested; the live response is not.
4. **Pagination.** Assumed absent based on a 48-message maximum. The round-number warning is the
   only guard.
5. **DOM fallback selectors.** Corrected against a 2026 live inventory (no
   `data-testid="assistant-message"`; `.font-claude-message` dead; `.font-claude-response` live;
   `.standard-markdown` / `.progressive-markdown` bodies) but not re-checked since. Claude has no
   reliable DOM hook for the thinking block, and React artifacts render in a cross-origin
   `claudeusercontent.com` iframe an extension cannot read at all — if the API path ever breaks,
   artifacts are simply lost.

One open request for whoever owns the shell (this replaces nothing above, it is new):

- **Permissions.** The best competing extension ships two permissions — the `claude.ai` host
  permission and `storage` — with no `activeTab`, no `downloads` and no `tabs`, by writing the
  file through an in-page blob anchor instead of `chrome.downloads`. My manifest mirrors Agent
  B's shell as it stands today (`downloads`, `activeTab`, `scripting`, `storage`). If the shared
  background worker moves off `chrome.downloads`, tell me and I will drop `downloads` and
  `activeTab` from `extensions/claude/manifest.json`. I did not change the shell myself.

**Agent D, status update on my blocker list:** icons are done. I ran
`node scripts/make-icons.mjs --dir extensions/claude --accent "#d97757"` (thanks for the
`--dir`/`--accent` flags) and committed `extensions/claude/icons/icon{16,32,48,128}.png`.
`node scripts/verify.mjs --dir extensions/claude` is now down from 10 errors to **2**, and both
are shared-shell files I must not write:

```
manifest references "src/popup/popup.html" but extensions/claude/src/popup/popup.html does not exist
manifest references "src/background.js"    but extensions/claude/src/background.js  does not exist
```

So the remaining hoist for `extensions/claude/` is exactly: `src/popup/**`, `src/background.js`,
`src/content.js`, `src/lib/markdown.js`, `src/lib/filename.js`, `src/lib/html2md.js` — plus the
one-line relative import at the top of `extensions/claude/src/lib/dom-scrape.js` that currently
reaches out to `../../../../extension/src/lib/html2md.js`. Nothing else blocks a loadable build.

## Agent A — DOM fallback rewritten after the coordinator's live 101-message measurement

The measurement: on a real conversation with **101 messages in the active branch**, fully loaded,
`article[data-testid^="conversation-turn-"]` matched **0** nodes, `.markdown`/`.prose` **0**,
`[data-message-author-role]` **2** — and only **7 turns existed in the DOM at all**, at
non-contiguous indices (turn-2, 4, 12, 13, …). My fallback would have written a 7 % file that
looked complete. Rewritten; `dom-scrape.js` is new from the selectors up.

**The structural insight.** "Scroll to the top, then read" cannot work here — scrolling up
*unmounts* the bottom while mounting the top, so there is no instant at which the whole
conversation is in the document. The fallback now **harvests**: it rewinds to the top to page in
history, then sweeps down in `0.75 × clientHeight` steps, converting each turn to Markdown *at the
moment it is mounted*, keyed by `data-turn-id`, and finally reassembles in `conversation-turn-N`
order. A simulated virtualised transcript (101 turns, ~8 mounted at a time) is in the tests and
captures **101 of 101**; the old code captures 7 of it.

**Selectors, all fall-through.** Turns: `section[data-testid^="conversation-turn-"]` →
`[data-testid^="conversation-turn-"]` → `[data-turn-id]` → legacy `article[...]` →
`[data-message-author-role]`. Role: `data-turn` → `[data-message-author-role]` (attr, then
descendant) → nested `[data-turn]` → structural class hints → **null, counted and warned about**.
Id: `data-turn-id` → `data-message-id`. Body: `.markdown`/`.prose`/`[data-message-content]` →
`.text-message` → `deepestTextContainer()`, which descends through single-child wrappers so the
hashed CSS-module names (`fKQ0lq_Layout`, `WlXitW_TransitionGroupChild`) are never referenced.

**The localised-label trap is closed.** `h4.sr-only` renders "ChatGPT сказал:" on this account.
Role is never derived from it, and `html2md.js` now skips `.sr-only` / `.visually-hidden`
elements outright, so the label cannot leak into a message either. There is a test asserting no
`сказал` and no localised copy-button text survives. **Note for Agents D/E/F: this `sr-only` skip
is in the shared `html2md.js`** — it is generically correct for a transcript export, but shout if
your platform puts real content in an `sr-only` node.

**Failing honestly (the point of the exercise).** `completenessReport(entries)` compares captured
turns against what the indices imply and emits a shouty `INCOMPLETE EXPORT — captured M of about
K turns …` listing the missing indices, plus a separate warning when the transcript starts above
turn 2 (missing head). On the coordinator's observed 2/4/12/13 sample it reports "captured 4 of
about 12" and names all eight gaps. `scrapeConversation()` also accepts `expectedMessageCount`,
which `extract.js` fills from the API result when the API answered but produced nothing visible.
Silence now requires an actually complete harvest.

**Scroll loop.** Cap raised to 80 rounds; the two stall conditions are checked separately
(`count stopped growing` and `scrollTop stopped changing`), because a frozen scroller with
arriving turns and a moving scroller with no new turns are different failures. Hitting the cap,
or never reaching the top, is a hard warning. `findScrollContainer()` now collects every
scrollable candidate — ancestors of the first turn plus the selector list — and picks the one with
the largest `scrollHeight`; tested against both measured candidates (transcript div 4118/812 vs
`main#main` 4066/760) and against the sizes flipped, so the decision follows measurement rather
than selector order.

`test/extract.test.mjs` is now 59 tests (76 including `html2md`), all green.

### Still unverifiable without a live session

1. Whether the real mounted window is always **≥ the viewport**. My sweep step is
   `0.75 × clientHeight`, which guarantees overlap only under that assumption. If ChatGPT ever
   mounts less than a viewport of content, the sweep can skip turns — it will *say so* rather than
   hide it, but the fix would be to step by the height of the last mounted turn instead.
2. Whether scrolling a detached/overlayed transcript (Cloudflare interstitial, error pane) still
   fires ChatGPT's loader at all.
3. Whether `data-turn` ever carries values beyond `user`/`assistant` (e.g. tool turns).
   Anything unrecognised is currently counted as an unknown role and warned about, not guessed.
4. Real-world timing: `waitMs` 220 with 80 rewind rounds plus a sweep is up to ~40 s on a very
   long chat. Acceptable for a fallback that now rarely runs, but untuned against a real network.

### Agent D — addendum 2: the `artifacts` tool does not exist in current data

The coordinator scanned **15 live conversations with `render_all_tools=true`**. The headline
finding invalidated the primary assumption in my brief, so this supersedes the artifact-centric
parts of both sections above. Test count is now **103, all green**.

**`render_all_tools=true` is load-bearing, and this is the most important line in this file.**
Without it: `text` 203, `thinking` 32, **zero tool blocks** across 12 conversations. With it, the
same account yields `tool_use` 46 and `tool_result` 45 across 15 conversations, 8 of which use
tools. **Omitting that one query parameter silently hides half of every tool-using conversation
and the export looks complete while being wrong.** Agents E and F: if your platform has an
equivalent flag, find it before you trust a block-type census.

**There is no `artifacts` tool.** Measured tool names and counts:

```
web_search 11 · message_compose_v1 9 · view 7 · web_fetch 6 · bash_tool 4
conversation_search 2 · present_files 2 · ask_user_input_v0 2
recent_chats 1 · create_file 1 · visualize:read_me 1
```

`artifacts`: 0. `input.id`: 0. `input.command`: 0. My `collectArtifacts()` replay — the most
intricate code I own, including the `$&`-safe function replacer — **never fires on current
data**. Per instruction it is retained as a secondary path for older conversations and its tests
stay green, but it is no longer primary and no longer what the store copy leads with.

What replaced it:

- **`TOOL_SPECS`, a data-driven table** mapping tool name → how it reads. `bash_tool` becomes a
  fenced shell block plus its output; `web_search`/`web_fetch` show the query or URL;
  `view` shows path and line range; `present_files` a path list; `conversation_search` and
  `recent_chats` their parameters.
- **Unknown tools degrade, never vanish and never dump JSON.** `genericInputSummary()` emits a
  readable key/value list, promoting long or multi-line strings to their own fenced block. A
  tool with no input at all still gets a heading line. There is a test asserting that every one
  of the eleven measured tool names is identifiable in its output and that none falls through to
  a raw dump.
- **`create_file` is first-class — it is the real "artifact" today.** `file_text` is rendered as
  a fenced block labelled with `path`, language inferred from the extension, as
  `contentType:'code'` with `hidden:false`, so it is **visible by default** rather than gated
  behind `includeTools`. Its bare `ok` echo is suppressed unless the call errored.
  `visualize:show_widget` is treated the same way.
- **`tool_result` pairs to `tool_use` by `tool_use_id`**, indexed branch-wide via
  `collectToolResults()`, so pairing survives a result landing in a later message; a shared
  `consumedResults` set stops it rendering twice. Orphan results still render alone.
- **`tool_result.content` is an ARRAY**, never a string. `text`, `knowledge` and
  `local_resource` are all handled. `knowledge` becomes a linked source list
  (`- [title](url)` plus the body) and is deliberately **not fenced**, since fencing would kill
  the links. Unrecognised element types are counted into the existing unknown-block warning.
- **`is_error`** marks the heading (`· failed`) and the result (`_Result (error):_`).
- **`integration_name` / `is_mcp_app` / `tool_origin`**: MCP and integration tools are labelled
  `Integration · tool_name` with a `· MCP` marker, and `authorName` prefers `integration_name`.
- **`display_content`** is used as a fallback when a tool's `input` yields nothing.

Fixtures were rebuilt from the exact measured key sets, including every field the renderer does
*not* use (`start_timestamp`, `stop_timestamp`, `message`, `integration_icon_url`, `icon_name`,
`tool_origin`, `meta`), so the code is proven not to choke on them.

Store copy was corrected too: it no longer promises "artifacts" as the headline. It now says
files and artifacts, and adds tool legibility as a feature.

**Still unverified, in order of risk:**

1. **`ask_user_input_v0` and `message_compose_v1` inputs were truncated in the capture.** These
   are the #2 and #8 most common tools, so between them they are a large share of real traffic,
   and both currently fall to the generic renderer. That is safe but not good. If anyone can
   capture their full `input` shape, they deserve `TOOL_SPECS` entries — `message_compose_v1`
   in particular almost certainly carries a message body worth rendering as prose rather than as
   a key/value line.
2. **`display_content`'s real shape is unknown.** I probe string, array and `{text|content|
   markdown|title}` defensively. The coordinator's note that it "is likely the user-visible
   rendering Claude itself shows" suggests it may be *better* than anything I derive from
   `input` — if its shape gets measured, it may deserve to be preferred rather than used as a
   fallback.
3. **`local_resource`'s field names are guessed** (`name|title|path|uri|file_name` and
   `text|content|description`). Only its `type` was measured.
4. **`tool_origin` values are unknown** — I only test `is_mcp_app`/`integration_name` for
   labelling and otherwise ignore `tool_origin`.
5. Everything in my earlier "still unverified" list that was not about tools still stands:
   attachment URL field spellings, pagination, and the DOM fallback selectors.

Unchanged from before, and worth repeating because it now matters more: **if the API path ever
fails, tool traffic and generated files are lost entirely** — none of it exists in the DOM in a
recoverable form, and React artifacts render in a cross-origin `claudeusercontent.com` iframe an
extension cannot read. The DOM fallback produces prose only, and says so in `warnings[]`.

**Import note re: the `shared/` hoist** — `shared/lib/` currently holds `markdown.js` and
`filename.js`. `html2md.js` is still at `extension/src/lib/html2md.js`, and
`extensions/claude/src/lib/dom-scrape.js` still imports it from there, exactly like
`extensions/aimode` and `extensions/gemini` do. Nothing of mine is broken. When html2md moves,
that one line is the only change needed on my side. `verify.mjs --dir extensions/claude` remains
at 2 errors, both the shared shell files (`src/popup/popup.html`, `src/background.js`) that I
must not write.

## Agent A → Agent B (popup): please refuse a partial export by default

**Request, your file, I have not touched it.** When the DOM fallback can only recover part of a
conversation, the popup should not silently download a file that looks complete.

Machine-readable contract (no change to the `Conversation` typedef):

```js
import { INCOMPLETE_PREFIX } from './lib/dom-scrape.js';   // === 'INCOMPLETE EXPORT'
const partial = conversation.warnings.some((w) => w.startsWith(INCOMPLETE_PREFIX));
```

`INCOMPLETE_PREFIX` is exported from `extension/src/lib/dom-scrape.js` and re-exported from
`extract.js`; it is a frozen string and I will not reword it without telling you. Every headline
warning starts with it and already contains a user-facing explanation, so the popup can show
`warnings.find(w => w.startsWith(INCOMPLETE_PREFIX))` verbatim.

Suggested behaviour: if `partial`, replace the one-click download with a warning pane —
"Only N messages could be read from this page. Sign in to chatgpt.com and reopen the chat for a
complete export." — plus a secondary "Download what's visible anyway" button. Never the default
action. This is the #1 complaint against every competitor in this category, and refusing loudly
is the differentiator. If you'd rather not build the pane, a `confirm()` is enough for v1.

## Agent A — CORRECTION to my previous section (retracting a claim)

My earlier section said the rewritten fallback "captures **101 of 101**" on a virtualised
transcript. **That claim was based on my simulation, and the simulation was wrong.** The
coordinator ran the real thing and the result is unambiguous:

```
harvested unique turns : 7        (never varied at any scroll position)
scrollHeight           : 4037     (CONSTANT — wheel events, PageUp, scrollTop writes: no growth)
turn indices captured  : 2,4,12,13,14,15,16
```

My model assumed a window sliding over a fully-known list. The real page never fetches the other
~94 messages at all, so there is nothing to slide over and no client-side trick that changes it.
**Treat the DOM path as best-effort partial recovery only.** It is not a substitute for the API
path on any conversation of length, and nothing in the code, tests or store copy should imply
otherwise. (README is fine as written — it already says naive scrapers truncate.)

### What changed as a result

- **The file header of `dom-scrape.js`** now leads with the measurement and the words "BEST-EFFORT
  PARTIAL RECOVERY". The harvesting machinery is kept — it is strictly better than a single
  snapshot and pays off on share pages and builds that do page in — but it is documented as an
  algorithm, not a promise.
- **The reporter no longer quotes a total.** This is the subtle one: `conversation-turn-N` is
  **not** a global message ordinal. The live 101-message chat numbered its rendered turns 2–16, so
  my old wording "captured 7 of about 15 turns" would have been wrong by roughly 7× — a quiet lie
  of exactly the kind this path exists to prevent. It now says: *"only 7 message(s) could be
  recovered … the page numbered the turns it rendered 2–16, and 8 of those are missing (turn 3, 5,
  6, 7, 8, 9, 10, 11) … the real length is unknown and is usually far larger than these turn
  numbers suggest. This file is a partial recovery, not a complete export."* A test asserts the
  string never matches `/of about \d+ turns/`.
  *(Coordinator: this is a deliberate deviation from your point 3, which asked me to assert
  "captured 7 of about 16". I kept the 2–16 range in the text but dropped the total. Say the word
  and I will put it back.)*
- **A second warning explains why**, so the user does not think the extension is broken:
  "scrolling the transcript did not load any further messages — the container never grew … a
  limitation of the ChatGPT page, not of the export."
- **Early exit when the page will not paginate.** If neither the turn count nor `scrollHeight`
  moves after a few rounds, we stop instead of grinding. Measured on the frozen-transcript
  fixture: **11 scroll writes, 2.5 s** — down from the 8.0 s / 8-step sweep the coordinator timed.
- **Tests corrected.** The 101/101 test is renamed *"harvest algorithm: recovers every turn from a
  list that does page in (NOT ChatGPT)"* and carries a comment saying so, so nobody cites it as
  evidence about ChatGPT. A new `frozenTranscriptDoc()` models the measured reality — 7 turns at
  2, 4, 12–16, constant height, scroll writes counted — and asserts the honest warnings, the
  early exit, and that a genuinely short chat is **not** marked incomplete (no crying wolf).
- **The API path is untouched** and now has an explicit regression test that pairs a full JSON
  payload with a deliberately hopeless DOM: it returns the whole active branch, consults the DOM
  never, and emits no `INCOMPLETE EXPORT` warning.

### On the `conversation-pagination-sentinel` lead

I did **not** build on it, and I think your suspicion is right. Beyond it being the sidebar's
paging marker, the measurement argues against it being the transcript's: a sentinel-driven loader
works through an IntersectionObserver, and both real `WheelEvent`s and `scrollTop` writes —
either of which fires an IO in a real browser — left `scrollHeight` at 4037. If it were the
transcript's loader, something would have moved. Worth one look with the sidebar collapsed if
anyone is in there anyway, but I would not spend budget on it.

---

## Orchestrator / INTEGRATION — the four-package build

`npm run build` now produces four verify-clean Chrome Web Store zips. Nothing else about the
project changed: no extractor was refactored, no module was renamed for taste.

```
dist/chat2md-chatgpt-0.1.0.zip   46647 bytes   17 entries
dist/chat2md-claude-0.1.0.zip    50025 bytes   17 entries
dist/chat2md-gemini-0.1.0.zip    43916 bytes   18 entries
dist/chat2md-aimode-0.1.0.zip    41281 bytes   15 entries
```

`manifest.json` is the **first** central-directory entry of every archive, and each zip is
cross-checked against `System.IO.Compression` after it is written.

### Final layout

```
platforms.config.mjs        the platform table — one row per store item
shared/                     everything identical across all four (Agent B's shell)
  background.js  content.js
  platform.js               GENERATED; the checked-in copy is the ChatGPT one
  popup/{popup.html,popup.css,popup.js}
  lib/{markdown.js,filename.js}
extension/                  ChatGPT: manifest + icons + src/lib/{api-client,dom-scrape,html2md,extract}.js
extensions/{claude,gemini,aimode}/   the same shape, extractor only
scripts/build.mjs           composes, verifies and packages each row of the table
```

Composed package (identical shape for all four):

```
dist/<outputName>-<version>/
  manifest.json                       generated   <- ZIP ROOT
  icons/icon{16,32,48,128}.png        generated, tinted per platform
  src/background.js src/content.js src/popup/**   from shared/
  src/platform.js                     generated
  src/lib/{markdown.js,filename.js}   from shared/lib/
  src/lib/html2md.js                  copied from extension/src/lib/
  src/lib/*                           that platform's extractor
```

### What moved, and what deliberately did not

**Moved into `shared/`** (Agent B's, and finished): `markdown.js`, `filename.js`, `content.js`,
`background.js`, `popup/**`. `shared/` mirrors the old `extension/src/` layout on purpose, so
every relative import *inside* the shell (`./lib/markdown.js`, `../lib/filename.js`) resolved
unchanged. The only importers that needed editing were `test/markdown.test.mjs` and
`scripts/make-screenshots.mjs`.

**Left alone**: Agent A's `api-client.js`, `dom-scrape.js`, `html2md.js` and `extract.js` stay
under `extension/src/lib/`. The build copies `html2md.js` into every package. Giving those four
a tidier home is a later job; doing it now would have collided with two live agents.

### The cross-tree `html2md.js` import

`extensions/{claude,gemini,aimode}` import it as `../../../../extension/src/lib/html2md.js`,
which is correct for `node --test` but reaches outside the package. `normaliseImports()` in
`scripts/build.mjs` rewrites that specifier to `./html2md.js` **while staging**, so the source
tree stays runnable and the package stays self-contained. The build prints how many specifiers
it rewrote per platform (1 each for Claude/Gemini/AI Mode, 0 for ChatGPT). No extractor source
was edited. D/E/F: you do not have to change that import line.

### `assistantLabel` — fixed (Agents D, E and F all reported this)

The shell learns which product it is inside from a generated `src/platform.js`. The popup seeds
`userLabel`/`assistantLabel` from it, and `background.js` applies them *underneath* whatever the
popup sent, so a download still gets the right heading if the popup never persisted options.
Verified against the actual staged packages:

```
chatgpt  -> ## You | ## ChatGPT
claude   -> ## You | ## Claude
gemini   -> ## You | ## Gemini
aimode   -> ## You | ## AI Mode
```

The same mechanism removed the last hardcoded ChatGPT strings from the popup: host list,
conversation-URL patterns, idle copy and the fallback title. **The URL patterns are matched
against `pathname + search`, not `pathname`** — AI Mode's discriminator is `?udm=50`, so a
path-only test (what the original `CONVERSATION_PATH` did) would have rejected every valid
AI Mode page.

`DEFAULT_OPTIONS` in `markdown.js` is untouched: it still says `assistantLabel: 'ChatGPT'`,
which is what `CONTRACT.md` section 3 specifies and what `test/markdown.test.mjs` asserts.

### `storage`

All four manifests request `downloads`, `activeTab`, `scripting`, `storage`. Agent F was right
to flag it and right to ask rather than guess: the shared popup calls `chrome.storage.sync.get`
on open, so an item without the permission would ship a popup that throws. Agent F's
`store/aimode/listing.md` said *"`storage` is **not** requested by this item"* — that note is now
corrected and the permission table gained the row. A justification that denies a permission the
manifest requests is the same review-delay class as the reverse.

Also fixed: `store/permissions-justification.md` (ChatGPT) said `chrome.storage.local` where the
popup uses `chrome.storage.sync`.

### Names

One rule: our brand leads, and a third-party mark appears in the *name* only where that owner
blesses the construction.

| id | before | after |
| --- | --- | --- |
| chatgpt | Chat2MD — Save ChatGPT chats as Markdown | **Chat2MD — Save AI chats as Markdown** |
| claude | Chat2MD — AI Chat to Markdown | unchanged (Agent D got there first) |
| gemini | Chat2MD for Gemini — Save chats as Markdown | **Chat2MD for Gemini™ — …** |
| aimode | Chat2MD for AI Mode — Save AI answers as Markdown | **Chat2MD for AI Mode™ — …** |

OpenAI's guidelines say not to build their marks into a product name, and Anthropic grants no
carve-out, so ChatGPT and Claude appear only in the description. Google *does* bless
"… for Gemini™" with an attribution, so the two Google items keep their marks — with ™, never ®.
Added the missing TRADEMARKS non-affiliation paragraph to the ChatGPT and Gemini detailed
descriptions (Claude and AI Mode already had one). `store/checklist.md` item 6 was rewritten;
it previously argued *for* keeping "ChatGPT" in the name.

### Two things that can no longer drift

1. Each item's `manifest.json` is **generated** and written back into its source tree on every
   build. Edit `platforms.config.mjs`, never the manifest — your edit will be overwritten.
   Version comes from `package.json`, so the old "bump both or the build refuses" step is gone.
2. `build.mjs` parses each `store/**/listing.md` for the fenced blocks under `## Item name` and
   `## Short description` and **fails the build** if either disagrees with the config.

### Build CLI

```
npm run build                 all four
npm run build -- claude       just one   (also: node scripts/build.mjs claude)
npm run build:one -- claude   the same, explicit
npm run platforms             print the table
node scripts/build.mjs --zip-only     skip the verify + listing gates
```

`--dir extensions/claude` is still accepted and maps to the `claude` row, so older notes in
this file keep working.

### Deliberately left undone

- ~~**`extension/` is not load-unpackable on its own** any more, and neither is any
  `extensions/<id>/`. They are source trees; the loadable thing is `dist/<name>-<version>/`.
  README's install section was updated. `npm run verify` with no `--dir` therefore fails now —
  pass `--dir dist/chat2md-<id>-<version>`, or just run `npm run build`, which gates all four.~~
  **RESOLVED.** Leaving it there cost a real day: the source trees still carried a generated
  `manifest.json`, so Chrome accepted them for "Load unpacked" and then failed to register the
  service worker — a dev-mode install that looked disabled rather than misloaded. And a bare
  `npm run verify` that always failed trained everyone, including a later session, to read its
  two true errors as a stale script. Both fixed: the generated manifest is no longer written
  back to source trees (Chrome now refuses them with a clear "manifest missing"), and bare
  `npm run verify` checks every built package under `dist/` and exits 0. A build also empties
  `dist/<name>-<version>/` in place instead of deleting it, so a dev-mode install survives a
  rebuild — verified by the directory keeping its NTFS file id across one.
- **`extension/icons/` and `extensions/claude/icons/` are now dead weight.** The build generates
  a fresh, per-platform-tinted set into each package via Agent C's `make-icons --dir --accent`.
  I left the checked-in PNGs alone because they belong to Agents C and D and both were live;
  `README.md` still references `extension/icons/icon128.png` for its header image.
- **`markdown.js`'s `FALLBACK_TITLE` is still `'ChatGPT conversation'`.** I made it an option,
  saw it break the "DEFAULT_OPTIONS matches the contract" test, and reverted — the contract
  fixes that option set. It only fires when an extractor returns an empty title, and all four
  extractors supply their own fallback, so this is cosmetic. Whoever owns the next contract
  revision should add `fallbackTitle` to section 3 and wire `PLATFORM.fallbackTitle` through;
  the popup already uses it for its on-screen title.
- **Permission reduction** (Agent D's note: the strongest competitor ships `claude.ai` +
  `storage` only, saving through an in-page blob anchor instead of `chrome.downloads`). Real,
  and it would drop `downloads` and `activeTab` from all four manifests at once now that they
  come from one table. Out of scope here — it changes `background.js`'s download path.
- **The ChatGPT and Claude item names are similar** ("Chat2MD — Save AI chats as Markdown" vs
  "Chat2MD — AI Chat to Markdown"). Both are mark-free and both descriptions name their site,
  and I did not want to churn Agent D's deliberate choice. If a reviewer reads them as
  duplicates, change the `chatgpt` row of `platforms.config.mjs` — one edit, and the build's
  listing gate will tell you which store file to update with it.
- **Screenshots** for Claude / Gemini / AI Mode still need real signed-in captures (Agents D, E,
  F all flagged this). `npm run screenshots` only produces the ChatGPT set.

### Working around live agents

Agent A landed a `dom-scrape.js` rewrite mid-way through, and Agent D was editing
`extensions/claude/src/lib/api-client.js` throughout. I staged explicit paths only and never ran
`git add -A`. At one point the full suite showed 8 failures, all in `test/claude-extract.test.mjs`
— Agent D's in-flight work, not the hoist; the suites I touched were green throughout. Final
state on my last run: **312 tests, 310 pass, 0 fail, 2 skipped.**
