# Chrome Web Store listing — Chat2MD (claude.ai)

Copy each block verbatim into the corresponding field of the Web Store developer
dashboard (**Store listing** tab). Character counts are the store's hard limits.

> Structure mirrors `store/listing.md` (the ChatGPT item) on purpose — privacy, pricing,
> support and distribution are identical across all store items. Only the product name,
> the "which site" sentence, the positioning, and the screenshots change.

---

## Item name

*Limit 75 characters. Currently 29.*

```
Chat2MD — AI Chat to Markdown
```

> Must match `extensions/claude/manifest.json` → `name`. It does.
> If one changes, change both, or `scripts/verify.mjs` will fail the build.
>
> **Do not put "Claude" in this field.** See the trademark note below — the item
> name has to be mark-free, and compatibility is stated in the description instead.

---

## Short description (summary)

*Limit 132 characters. Currently 126. Shown in search results and on the tile.*

```
Works with claude.ai. Save a conversation as a clean Markdown file — code, artifacts and tables survive. Runs on your machine.
```

> Must match `extensions/claude/manifest.json` → `description`. The store pulls this field
> from the manifest on upload; editing it in the dashboard alone is overwritten by the
> next package upload.

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
Chat2MD works with claude.ai. It saves the conversation you are reading to a Markdown file, in one click, with the formatting and the artifacts intact.

WHY IT EXISTS

There is no way to download a single conversation from claude.ai.

There is a Share button, which publishes a public link rather than giving you a file. And there is an account-wide data export buried in Settings, which is a different thing entirely: you request it under Settings > Privacy > Export data, you wait, and a download link arrives by email covering every conversation on your account at once. If what you wanted was this one thread, as Markdown, in your notes folder, neither of those helps.

The obvious workaround does not work either. Selecting a long Claude thread and pressing Ctrl+C loses material, because the interface only keeps part of a long conversation in the page at any moment. And whatever you do capture arrives flattened: code fences lose their language tag, tables collapse into runs of text, nested lists lose their indentation.

Generated files and artifacts make it worse. The document, the script or the component built for you lives in a side panel, outside the transcript. Copy the chat and it is simply not in there — and it is usually the single most valuable thing in the conversation. Chat2MD puts written files and artifacts into the Markdown, in place, as fenced code blocks labelled with their path and language.

WHAT YOU GET

• The complete conversation, from the first message to the last — not just the part scrolled into view.
• Files and artifacts the assistant produced, included in place, as fenced code blocks that keep their path or title and their language.
• Tool work kept legible when you want it: searches show what was searched for, shell steps show the command and its output, and failures are marked as failures. Off by default, one checkbox to include.
• Fenced code blocks that keep their language, so syntax highlighting still works when you paste the file into your editor, your notes app or a pull request.
• Tables, nested lists, block quotes, links and inline formatting preserved as Markdown.
• The active branch. If you edited a message or asked Claude to try again, you get the version you kept, not a scrambled merge of every attempt.
• A YAML front-matter block with the conversation title, source URL, model and dates — so the file drops straight into Obsidian, Logseq, Quartz, Hugo or Jekyll without editing.
• A sensible, filesystem-safe filename derived from the chat title.
• Optional extras you can switch on: per-message timestamps, tool and web-search steps, and extended thinking.

WHO IT IS FOR

Anyone who treats a Claude session as work product rather than a chat window. Developers keeping the artifact Claude wrote next to the code it belongs to. Researchers keeping a citable record of a line of questioning. Writers moving drafts into their own notes. Teams pasting a decision-making thread into a ticket or a design document. Students building a revision file they can still search six months from now.

HOW IT WORKS

Open a conversation on claude.ai. Click the Chat2MD icon. Click Download .md. The file appears in your Downloads folder. There is nothing to sign up for, nothing to configure, and no step where you paste anything anywhere.

PRIVACY

Chat2MD has no server, because it does not need one. The conversion happens inside your browser and the finished file goes straight to your disk.

• No data is collected. None.
• No analytics, no telemetry, no crash reporting, no identifiers.
• No account, no login, no subscription.
• The extension makes no network requests to the developer or to any third party. It reads from claude.ai only, using the session you are already signed in to.
• No remote code: every line of JavaScript ships inside the package and can be read before you install it.

Chat2MD requests access to claude.ai and to no other website.

TRADEMARKS

Chat2MD is an independent, unofficial tool. Claude is a trademark of Anthropic, PBC. This extension is not affiliated with, endorsed by, or sponsored by Anthropic.

OPEN SOURCE

Chat2MD is MIT-licensed and developed in the open. If you want to confirm any of the claims above, read the code:
https://github.com/hardelele/gpt-download-chat

Bug reports and feature requests are welcome on the issue tracker.

PRICING

Free. No paid tier, no trial, no upsell.

```

*Word count: ~470. Benefit-led, no emoji, no keyword stuffing.*

---

## Honesty notes for whoever maintains this copy

The positioning above rests on one factual claim: **claude.ai offers no per-conversation
export.** This was checked against Anthropic's own documentation, not against hearsay:

> **[Export your Claude data](https://support.claude.com/en/articles/9450526-export-your-claude-data)**
> — Anthropic Help Center, last updated 8 July 2026.
> (`support.anthropic.com` now redirects to `support.claude.com`.)

That article documents exactly one export path: *initials (lower left) → Settings → Privacy →
Export data*, after which **a download link arrives by email and expires after 24 hours**. It
covers "conversation data and the user data for your account" — the whole account. It is web
and Claude Desktop only. The article contains **no mention of exporting a single conversation,
and no mention of Markdown, PDF or HTML**. The only sibling articles are "Export your
organization's data" (also account-wide) and "Import and export your memory from Claude".

Deliberate hedge in the copy above: the help article does **not** state the archive's file
format. "A ZIP containing `conversations.json`" is repeated widely by third parties but is not
an Anthropic-stated fact, so the listing says "a download link arrives by email" and stops
there. Do not add the format back in.

The other built-in options, for completeness — neither is an export of a conversation:

1. **Share** — publishes a public snapshot link. Not a file, and it makes the chat readable by
   anyone who has the link.
2. Per-*artifact* download buttons and per-*code-block* copy buttons, which cover a fragment of
   one message, not the thread.

If Anthropic ships a per-chat "Download as Markdown", the "WHY IT EXISTS" section becomes false
advertising and must be rewritten the same day. The honest reposition is still strong — front
matter, artifacts folded to their final version and inlined in place, active-branch
reconstruction, optional thinking and tool traffic, and a filename you can live with — but the
copy then has to lead with those instead of with the gap. **Re-check the help article before
each store submission.**

## Trademark constraint — read before renaming anything

CLAUDE is a **registered trademark** of Anthropic, PBC (Reg. 7645254), and Anthropic publishes
**no nominative-use carve-out**. Their guidance allows stating compatibility in plain text, but
**not** using the mark as part of a product name. So:

- The item name and `manifest.json` → `name` are deliberately **mark-free**:
  `Chat2MD — AI Chat to Markdown`. Do not "improve" this to `Chat2MD for Claude`,
  `Claude2MD`, `Claude Exporter` or anything similar. An earlier draft of this file used
  `Chat2MD for Claude`; it was changed for exactly this reason.
- Compatibility lives in the **description body** ("Works with claude.ai"), where a factual
  statement of interoperability is what the guidance permits.
- The TRADEMARKS paragraph in the detailed description is required, not decorative. Keep it.
- Never describe the extension as "official", "by Anthropic", or "Anthropic's".
- Prefer writing **claude.ai** (the site you interoperate with) over **Claude** (the mark)
  wherever the sentence still reads naturally.

Related terms-of-service point, which the code already honours: **never read, log or store a
session token.** The extractor uses a same-origin `fetch` with `credentials:'include'`, so the
browser attaches the cookie itself and no extension code ever sees its value. Do not add
anything that reads `sessionKey`.

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

## Permissions justification (dashboard: Privacy practices tab)

The dashboard asks for a sentence per permission. These match
`extensions/claude/manifest.json` exactly.

| Permission | Justification to paste |
| --- | --- |
| `downloads` | Used to write the generated Markdown file to the user's Downloads folder. This is the extension's only output. |
| `activeTab` | Used to read the conversation in the tab the user clicked the extension on, and only at that moment. |
| `scripting` | Used to inject the extraction script into the active claude.ai tab so the conversation can be read and converted in the page. |
| `storage` | Used to remember the user's own export preferences (front matter, timestamps, whether to include thinking and tool calls) between uses. Nothing else is stored, and nothing leaves the browser. |
| `https://claude.ai/*` | The extension reads the open conversation from claude.ai using the user's existing signed-in session. It is the only host the extension contacts. |

> **Permission-reduction opportunity (for Agent B / the orchestrator, not for this file to
> decide).** The strongest competing extension ships with only two permissions — the
> `claude.ai` host permission and `storage` — no `activeTab`, no `downloads`, no `tabs`,
> by saving through an in-page blob anchor instead of `chrome.downloads`. Reviewers and
> privacy-minded users both notice the difference. The permission list above mirrors the
> shared popup/background worker as they are written today; if that shell drops
> `chrome.downloads`, drop `downloads` and `activeTab` here too.

**Single purpose statement:** "Export the claude.ai conversation the user is currently viewing
to a Markdown file on their own computer."

**Remote code:** No. All code is contained in the package.

**Data usage disclosures:** tick *nothing*. The extension collects and transmits no user data
of any category.

---

## Graphic assets

| Asset | Required size | File | Status |
| --- | --- | --- | --- |
| Store icon | 128×128 PNG | reuse `store/assets/icon512.png` (dashboard downscales) | shared with the other items |
| Screenshot 1 | 1280×800 PNG | `store/claude/assets/screenshot-1-popup.png` | TODO — needs a claude.ai capture |
| Screenshot 2 | 1280×800 PNG | `store/claude/assets/screenshot-2-output.png` | TODO — should show an artifact inlined in the .md |
| Small promo tile | 440×280 | optional | only needed to be considered for featuring |

At least one screenshot is mandatory; up to five are allowed. Screenshots must be
1280×800 or 640×400, PNG or JPEG, no alpha channel, no rounded corners applied by you.

---

## Suggested screenshot captions

Burned into the screenshot images themselves (the store does not render separate captions):

1. *"claude.ai cannot download one chat. This can."*
2. *"Files and artifacts land in the Markdown, in place, with their language."*
3. *"The whole thread — including the branch you actually kept."*
