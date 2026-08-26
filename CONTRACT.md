# CONTRACT — read this first, it is binding

Project: **gpt-download-chat** — Chrome MV3 extension that exports a full ChatGPT conversation to a `.md` file.
Repo: `github.com/hardelele/gpt-download-chat`. Working dir: `C:\develop\gpt-download-chat`.
Product name (store): **Chat2MD** — "Save ChatGPT chats as Markdown".

Three agents work **in this same directory, on branch `main`, at the same time**. The rules below are what
keeps that from turning into a mess. Violating file ownership breaks everyone.

---

## 1. File ownership (hard boundary)

**You may create/edit ONLY the paths you own. Never touch another agent's path — not even to "fix" it.**
If you need a change in someone else's file, write a line into `docs/HANDOFF.md` (append-only, everyone may
append, never rewrite others' lines) and keep going.

### Agent A — EXTRACTOR (owns `extension/src/lib/extract*`, `api-client`, `dom-scrape`, `html2md`)

```
extension/src/lib/api-client.js
extension/src/lib/dom-scrape.js
extension/src/lib/html2md.js
extension/src/lib/extract.js
test/extract.test.mjs
test/html2md.test.mjs
test/fixtures/**
```

### Agent B — RENDER + CHROME SHELL (owns the extension shell and the markdown writer)

```
extension/manifest.json
extension/src/lib/markdown.js
extension/src/lib/filename.js
extension/src/content.js
extension/src/background.js
extension/src/popup/**
test/markdown.test.mjs
```

### Agent C — BUILD / REPO / STORE (owns everything meta)

```
package.json  .gitignore  README.md  LICENSE  PRIVACY.md  CHANGELOG.md
scripts/**  store/**  docs/** (except HANDOFF.md which is shared, append-only)
.github/workflows/**  extension/icons/**
```

`CONTRACT.md` is owned by the orchestrator. Do not edit it.

---

## 2. Merge rule — commit small, commit often

This is a single working tree, so **every commit is an integration**. That is the point.

- Commit **at least every 5–7 minutes**, and always immediately after a file first becomes syntactically valid.
  Small green commits beat one big correct one.
- Stage **only your own paths, explicitly**:
  `git add extension/src/lib/extract.js test/extract.test.mjs`
- **NEVER** run `git add -A`, `git add .`, `git commit -a`, `git checkout`, `git reset`, `git stash`,
  `git rebase`, `git push --force`, or anything that touches the whole tree. You will destroy in-progress
  work from the other two agents.
- If git says `index.lock` exists: wait 2 seconds, retry, up to 5 times. Another agent is mid-commit.
- Commit message: `feat(extract): ...` / `feat(popup): ...` / `chore(build): ...` — prefix with your area.
- After each of your commits, run `git log --oneline -8` and skim what the others landed. If a peer's file
  you depend on now exists, **read it and adapt to it immediately** rather than to this contract's sketch.
- Do not `git push`. The orchestrator pushes.

---

## 3. Shared data types (the actual integration surface)

`extract.js` produces this; `markdown.js` consumes exactly this. Nothing else crosses between agents.

```js
/**
 * @typedef {Object} Conversation
 * @property {string}      id            conversation id, or "unknown"
 * @property {string}      title         chat title, non-empty (fallback "ChatGPT conversation")
 * @property {number|null} createTime    unix seconds
 * @property {number|null} updateTime    unix seconds
 * @property {string|null} model         e.g. "gpt-4o", best effort
 * @property {string}      sourceUrl     full URL of the chat
 * @property {'api'|'dom'} extractedVia  which path produced this
 * @property {Message[]}   messages      chronological, root-to-leaf of the active branch
 * @property {string[]}    warnings      human-readable notes, e.g. "DOM fallback: 3 messages may be truncated"
 */

/**
 * @typedef {Object} Message
 * @property {string|null} id
 * @property {'user'|'assistant'|'system'|'tool'} role
 * @property {string|null} authorName    tool name for role==='tool' (e.g. "python", "web")
 * @property {number|null} createTime    unix seconds
 * @property {'text'|'code'|'thoughts'|'multimodal'|'other'} contentType
 * @property {string}      text          ALREADY MARKDOWN. never HTML.
 * @property {Attachment[]} attachments
 * @property {boolean}     hidden        true for system/hidden plumbing; renderer skips unless asked
 */

/**
 * @typedef {Object} Attachment
 * @property {'image'|'file'} type
 * @property {string|null} name
 * @property {string|null} url
 * @property {string|null} alt
 */
```

### Module APIs (exact signatures — ES modules, no bundler, no dependencies)

```js
// extension/src/lib/extract.js            [Agent A]
export async function extractConversation(opts?: {conversationId?: string}): Promise<Conversation>
// Runs in the page context (content script). Tries the backend API first, falls back to DOM scraping.
// Must NEVER throw for a recoverable problem — degrade to the DOM path and push a note into warnings[].
// Throws only if both paths yield zero messages.

// extension/src/lib/markdown.js           [Agent B]
export function toMarkdown(conversation: Conversation, opts?: RenderOptions): string
export const DEFAULT_OPTIONS: RenderOptions
// RenderOptions = {
//   frontmatter: boolean   (default true)   YAML block with title/url/model/dates/message count
//   timestamps: boolean    (default false)  per-message time
//   includeSystem: boolean (default false)
//   includeTools:  boolean (default false)
//   includeThoughts: boolean (default false)
//   headingStyle: 'h2'|'bold'  (default 'h2')
//   userLabel: string      (default 'You')
//   assistantLabel: string (default 'ChatGPT')
// }

// extension/src/lib/filename.js           [Agent B]
export function buildFilename(conversation: Conversation): string  // safe, ends in .md, no path separators
```

**Contract invariant:** `toMarkdown()` must produce sane output for a `Conversation` where every optional
field is `null` and `messages` is `[]`. Agent B: build against a hand-written fixture, do not wait for Agent A.
Agent A: your output must satisfy the typedef even on the DOM path — fill unknowns with `null`, never omit keys.

---

## 4. Non-negotiable product requirements

1. **The whole conversation, not the visible part.** ChatGPT virtualises the message list; scraping the DOM
   without scrolling silently loses most of a long chat. Primary path must be the backend conversation JSON.
2. **Markdown fidelity**: fenced code blocks keep their language, tables survive, LaTeX survives, nested lists
   survive. The API path already returns author-authored Markdown — do not re-render it through HTML.
3. **One click**: popup → "Download .md" → file lands in Downloads. No login, no account, no server.
4. **Zero network egress.** The extension talks to `chatgpt.com` only, using the user's existing session.
   No analytics, no telemetry, no remote code. This is a store-review requirement and a privacy promise.
5. **Minimum permissions.** Justify every entry in `manifest.json`. Prefer `activeTab`+`scripting` over broad
   host permissions where possible; `downloads` is expected.
6. Works on both `chatgpt.com` and `chat.openai.com`.

## 5. Definition of done for each agent

- Your files exist, are committed, and `node --test test/` passes for the tests you own.
- No `TODO` left in a code path the user can reach.
- You appended a short section to `docs/HANDOFF.md`: what you built, what you assumed, what is left.
