# Chrome Web Store listing — Chat2MD (ChatGPT)

Copy each block verbatim into the corresponding field of the Web Store developer
dashboard (**Store listing** tab). Character counts are the store's hard limits.

> Sibling store items (Claude / Gemini / AI Mode, see `CONTRACT-PLATFORMS.md`) reuse this
> structure. Only the product name, the "which sites" sentence, and the screenshots change.
> Everything about privacy, pricing and support is identical across all four items.

---

## Item name

*Limit 75 characters. Currently 40.*

```
Chat2MD — Save ChatGPT chats as Markdown
```

> Must match `manifest.json` → `name`. It currently does. If one changes, change both,
> or `scripts/verify.mjs` and the reviewer will both notice.

---

## Short description (summary)

*Limit 132 characters. Currently 127. Shown in search results and on the tile.*

```
Export any ChatGPT conversation to a clean Markdown file. Code blocks, tables and LaTeX survive. Runs entirely on your machine.
```

> Must match `manifest.json` → `description`. The store pulls this field from the manifest
> on upload; editing it in the dashboard alone will be overwritten by the next package.

---

## Category

**Primary category:** Productivity
**Secondary / sub-category (if offered):** Workflow & Planning

## Language

English (United States)

---

## Detailed description

*Limit 16,000 characters. Plain text; the dashboard renders line breaks only — no Markdown,
no HTML. Paste exactly as below.*

```
Chat2MD saves a ChatGPT conversation to a Markdown file, in one click, with the formatting intact.

WHY IT EXISTS

Selecting a long ChatGPT thread and pressing Ctrl+C does not work, and the reason is not obvious. The ChatGPT interface only keeps part of a long conversation in the page at any moment — scroll up and older turns are quietly discarded. Whatever you copy is whatever happened to be loaded. On top of that, a copy-paste flattens the structure: fenced code blocks lose their language tag, tables collapse into runs of text, nested lists lose their indentation, and mathematical notation turns into unreadable markup.

Chat2MD reads the conversation the way the ChatGPT app itself reads it, so it gets the whole thread — every turn, from the first message to the last — and writes real Markdown rather than a transcript of what was on screen.

WHAT YOU GET

• The complete conversation, not just the part that was scrolled into view.
• Fenced code blocks that keep their language, so syntax highlighting still works when you paste the file into your editor, your notes app, or a pull request.
• Tables, nested lists, block quotes, links and inline formatting preserved as Markdown.
• LaTeX and mathematical notation carried through unchanged.
• A YAML front-matter block with the conversation title, source URL, model and dates — which means the file drops straight into Obsidian, Logseq, Quartz, Hugo, Jekyll, or any static site generator without editing.
• A sensible, filesystem-safe filename derived from the chat title.
• Optional extras you can switch on: per-message timestamps, system messages, tool calls, and the assistant's reasoning steps.

WHO IT IS FOR

Anyone who treats a ChatGPT session as work product rather than a chat window. Developers archiving a debugging session next to the code it produced. Researchers keeping a citable record of a line of questioning. Writers moving drafts into their own notes. Teams pasting a decision-making thread into a ticket or a design document. Students building a revision file they can actually search six months later.

HOW IT WORKS

Open a conversation on chatgpt.com. Click the Chat2MD icon. Click Download .md. The file appears in your Downloads folder. There is nothing to sign up for, nothing to configure, and no step where you paste anything anywhere.

PRIVACY

Chat2MD has no server, because it does not need one. The conversion happens inside your browser and the finished file goes straight to your disk.

• No data is collected. None.
• No analytics, no telemetry, no crash reporting, no identifiers.
• No account, no login, no subscription.
• The extension makes no network requests to the developer or to any third party. It reads from chatgpt.com only, using the session you are already signed in to.
• No remote code: every line of JavaScript ships inside the package and can be read before you install it.

Chat2MD requests access to chatgpt.com and chat.openai.com and to no other website.

OPEN SOURCE

Chat2MD is MIT-licensed and developed in the open. If you want to confirm any of the claims above, read the code:
https://github.com/hardelele/gpt-download-chat

Bug reports and feature requests are welcome on the issue tracker.

PRICING

Free. No paid tier, no trial, no upsell.
```

*Word count: ~430. Benefit-led, no emoji, no keyword list — the store rejects listings that
repeat a keyword to game search, and it downranks listings that describe features the
extension does not have.*

---

## Support and links

| Dashboard field | Value |
| --- | --- |
| Homepage URL | `https://github.com/hardelele/gpt-download-chat` |
| Support URL | `https://github.com/hardelele/gpt-download-chat/issues` |
| Privacy policy URL | `https://hardelele.github.io/gpt-download-chat/privacy.html` |
| Developer email | `hardelele@yahoo.com` (must be verified in the dashboard before publishing) |

## Distribution

| Field | Value |
| --- | --- |
| Visibility | Public |
| Regions | All regions |
| Pricing | Free |
| Contains ads | No |
| In-app purchases | No |

---

## Graphic assets

| Asset | Required size | File | Status |
| --- | --- | --- | --- |
| Store icon | 128×128 PNG | `store/assets/icon512.png` (dashboard downscales; upload the 512 for a crisp result) | ready |
| Screenshot 1 | 1280×800 PNG | `store/assets/screenshot-1-popup.png` | see `store/checklist.md` |
| Screenshot 2 | 1280×800 PNG | `store/assets/screenshot-2-output.png` | see `store/checklist.md` |
| Small promo tile | 440×280 PNG/JPEG | optional | only needed to be considered for featuring |
| Marquee promo tile | 1400×560 PNG/JPEG | optional | only needed for the homepage carousel |

At least one screenshot is mandatory; up to five are allowed. Screenshots must be
1280×800 or 640×400, PNG or JPEG, with no alpha channel and no rounded corners applied by you.

---

## Suggested screenshot captions

Burned into the screenshot images themselves (the store does not render separate captions):

1. *"One click. The whole conversation — not just the part on screen."*
2. *"Real Markdown: code fences keep their language, tables and LaTeX survive."*
