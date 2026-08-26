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
