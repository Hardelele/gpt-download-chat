# CONTRACT — multi-platform addendum (orchestrator-owned, do not edit)

Scope grew: **three separate published extensions**, one shared codebase.

| Store item | Site | Extractor owner | Path |
| --- | --- | --- | --- |
| Chat2MD for ChatGPT | chatgpt.com, chat.openai.com | Agent A | `extension/` (will move to `extensions/chatgpt/`) |
| Chat2MD for Claude  | claude.ai | Agent D | `extensions/claude/` |
| Chat2MD for Gemini  | gemini.google.com, aistudio.google.com | Agent E | `extensions/gemini/` |
| Chat2MD for AI Mode | google.com AI Mode in Search (`&udm=50`) | Agent F | `extensions/aimode/` |

Gemini and Google's AI Mode in Search are **separate products and separate store items** — do not merge them.

## What is shared vs. per-platform

**Shared (written once, for the ChatGPT build, by Agents B and C — do not duplicate it):**
`markdown.js` (renderer), `filename.js`, the popup UI, `background.js`, `html2md.js`,
`scripts/build.mjs`, `scripts/verify.mjs`, icons, store copy templates, privacy policy.

**Per-platform (the only genuinely new work per extension):**
1. `extract.js` — produce the SAME `Conversation` typedef defined in `CONTRACT.md`. That typedef is
   platform-agnostic on purpose. Do not invent a different shape; the shared renderer consumes it.
2. `manifest.json` — name, description, `host_permissions`, content-script matches.
3. Store listing copy — name/description/screenshots for that item.

The orchestrator hoists the shared modules into `shared/` and wires all three builds **after** the
ChatGPT extension lands. Agents D and E: **do not write a renderer, a popup, a background worker, or a
build script.** If you think you need one, you are duplicating work that already exists — write the
extractor, stop, and note the gap in `docs/HANDOFF.md`.

## Ownership additions (same hard boundary as CONTRACT.md §1)

```
Agent D:  extensions/claude/**   test/claude-extract.test.mjs   store/claude/**
Agent E:  extensions/gemini/**   test/gemini-extract.test.mjs   store/gemini/**
Agent F:  extensions/aimode/**   test/aimode-extract.test.mjs   store/aimode/**
```

Nobody else touches those trees. Agents A, B, C: your ownership is unchanged; ignore `extensions/`.
The merge rule from `CONTRACT.md` §2 applies unchanged — stage only your own paths, commit every
5–7 minutes, never `git add -A`, never push.
