# Chrome Web Store listing — Chat2MD for Gemini

Copy each block verbatim into the corresponding field of the Web Store developer
dashboard (**Store listing** tab). Character counts are the store's hard limits.

> Structure mirrors `store/listing.md` (ChatGPT) and `store/claude/listing.md` on purpose —
> privacy, pricing, support and distribution are identical across all three store items.
> Only the product name, the "which site" sentence, the positioning and the screenshots change.

---

## Item name

*Limit 75 characters. Currently 44.*

```
Chat2MD for Gemini™ — Save chats as Markdown
```

> Generated from the `gemini` entry in `platforms.config.mjs`; `npm run build` writes the
> same string into `extensions/gemini/manifest.json` → `name`. Change the config, not the
> manifest.
>
> **The ™ is required, and it must be ™ and never ®.** Google's brand-feature guidelines
> permit a third party to say "<product> for Gemini™" provided the symbol is present and
> the listing carries an attribution plus a non-affiliation statement — both are in the
> TRADEMARKS paragraph of the detailed description. Our own brand still leads the name.

---

## Short description (summary)

*Limit 132 characters. Currently 124. Shown in search results and on the tile.*

```
Export any Gemini or AI Studio chat to a clean Markdown file. Code blocks and tables survive. Runs entirely on your machine.
```

> Must match `extensions/gemini/manifest.json` → `description`. The store pulls this field
> from the manifest on upload; editing it in the dashboard alone is overwritten by the next
> package upload.

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
Chat2MD saves a Gemini conversation to a Markdown file, in one click, with the formatting intact.

WHY IT EXISTS

Gemini will not give you the conversation as a file.

What it does offer is close enough to be frustrating. There is an "Export to Docs" button, which takes one response — not the thread — and turns it into a Google Doc in your Drive, which is a second place you now have to manage. There is a Share link, which publishes a snapshot on the web instead of putting anything on your disk. There is a copy button on each answer, one answer at a time. And there is Google Takeout, which is an account-wide archive job: you request it, you wait, an email arrives hours later with a ZIP of raw HTML covering every conversation you have ever had. (Takeout is also easy to get wrong — the entry labelled "Gemini" exports your Gems, not your chats; the conversations live under My Activity → Gemini Apps.)

None of that is "save this chat, as Markdown, into my notes folder".

The obvious workaround does not work either. Gemini only keeps part of a long thread in the page at a time and loads older turns as you scroll, so selecting the conversation and pressing Ctrl+C quietly captures the recent end of it and drops the beginning. Long answers hide behind "Show more". Reasoning hides behind "Show thinking". And whatever you do manage to select arrives flattened: code fences lose their language tag, so nothing highlights when you paste it into an editor; tables collapse into runs of text; nested lists lose their indentation; and the "Copy code" label that sits above every code block comes along for the ride.

WHAT YOU GET

• The complete conversation, from the first message to the last. Chat2MD scrolls the thread to the top and waits for Gemini to load every earlier turn before it reads anything.
• Collapsed content opened first: long answers behind "Show more" and reasoning behind "Show thinking" are expanded, not skipped.
• Fenced code blocks that keep their language label, so syntax highlighting still works in your editor, your notes app or a pull request — and without the "Copy code" and "Use code with caution" interface text leaking into the file.
• Tables, nested lists, block quotes, headings, links and inline formatting preserved as Markdown.
• Gemini's thinking kept as an optional section, off by default, so the transcript reads cleanly but the reasoning is there when you want it.
• Images and attachments recorded in place. Where Gemini serves an image through a temporary in-browser address that no Markdown reader could ever fetch, the file says so plainly instead of embedding a link that is already dead.
• A YAML front-matter block with the conversation title, source URL, model and message count — so the file drops straight into Obsidian, Logseq, Quartz, Hugo or Jekyll without editing.
• A sensible, filesystem-safe filename derived from the chat title.
• Google AI Studio too: prompts at aistudio.google.com export through the same one click.

WHO IT IS FOR

Anyone who treats a Gemini session as work product rather than a chat window. Developers keeping the code Gemini wrote next to the project it belongs to. Researchers keeping a readable record of a line of questioning instead of a Takeout archive they will never open. Writers moving drafts into their own notes. Teams pasting a decision-making thread into a ticket or a design document. Students building a revision file they can still search six months from now.

HOW IT WORKS

Open a conversation on gemini.google.com. Click the Chat2MD icon. Click Download .md. The extension expands the collapsed sections, loads the older turns, converts the thread and the file appears in your Downloads folder. There is nothing to sign up for, nothing to configure, and no step where you paste anything anywhere.

Long conversations take a few seconds, because loading the whole thread honestly takes a few seconds.

PRIVACY

Chat2MD has no server, because it does not need one. The conversion happens inside your browser and the finished file goes straight to your disk.

• No data is collected. None.
• No analytics, no telemetry, no crash reporting, no identifiers.
• No account, no login, no subscription.
• The extension makes no network requests to the developer or to any third party. It reads the page you already have open, using the session you are already signed in to.
• No remote code: every line of JavaScript ships inside the package and can be read before you install it.

Chat2MD for Gemini requests access to gemini.google.com and aistudio.google.com, and to no other website.

OPEN SOURCE

Chat2MD is MIT-licensed and developed in the open. If you want to confirm any of the claims above, read the code:
https://github.com/hardelele/gpt-download-chat

Bug reports and feature requests are welcome on the issue tracker.

PRICING

Free. No paid tier, no trial, no upsell.

TRADEMARKS

Google, Gemini and Google AI Studio are trademarks of Google LLC. Chat2MD is an independent project and is not affiliated with, endorsed by, or sponsored by Google.
```

*Word count: ~640. Benefit-led, no emoji, no keyword stuffing.*

---

## Honesty notes for whoever maintains this copy

**The factual claim the positioning rests on:** *Gemini offers no per-conversation Markdown
download.* Verified against the state of the product at the time of writing. The native
options are:

1. **Export to Docs / Gmail / Replit** — acts on a **single response**, not the thread, and
   produces a Google Doc in Drive rather than a file on disk.
2. **Share** — publishes a public snapshot link. Not a file.
3. **Per-code-block "Copy code" and per-response copy** — a fragment of one message.
4. **Google Takeout** — account-wide, asynchronous, emailed, and delivered as a ZIP of raw
   HTML. Note the trap worth keeping in the copy: the Takeout product entry named "Gemini"
   exports **Gems**, not conversations; chat history lives under *My Activity → Gemini Apps*.

There is no "Download as .md", and no per-conversation download of any kind.

**Re-check this before every submission.** If Google ships a per-chat Markdown or file export,
the "WHY IT EXISTS" section becomes false advertising and must be rewritten the same day. The
honest reposition is still strong — front matter, the whole thread including lazily loaded
turns, expanded "Show more" / "Show thinking", code fences that keep their language, and a
filename you can live with — but the copy then has to lead with those instead of with the gap.

**On the AI Studio claim.** The `aistudio.google.com` code path is implemented and unit-tested,
but it was written against the selectors that current open-source AI Studio exporters rely on
rather than against a live AI Studio session (see `docs/HANDOFF.md`, Agent E). Before this
listing is submitted, someone must open a real AI Studio prompt and export it. If it does not
work, delete the "Google AI Studio too" bullet, delete "or AI Studio" from the short
description **and the manifest**, and drop `https://aistudio.google.com/*` from
`host_permissions` — an unused host permission is both a review risk and a broken promise.

**Naming.** Do not describe the extension as "official", "by Google", or "Gemini Export". The
manifest name is deliberately `Chat2MD for Gemini`: "for X" is the phrasing Chrome Web Store
review accepts for third-party companions, and the disclaimer line at the end of the detailed
description is there for the same reason. Google's brand guidance is enforced more strictly
than most — do not put the Gemini spark mark or Google colours in the icon or the screenshots.

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
`extensions/gemini/manifest.json` exactly.

| Permission | Justification to paste |
| --- | --- |
| `downloads` | Used to write the generated Markdown file to the user's Downloads folder. This is the extension's only output. |
| `activeTab` | Used to read the conversation in the tab the user clicked the extension on, and only at that moment. |
| `scripting` | Used to inject the extraction script into the active Gemini tab so the conversation can be read, expanded and converted in the page. |
| `storage` | Used to remember the user's own export preferences (front matter, timestamps, whether to include Gemini's thinking) between uses. Nothing else is stored, and nothing leaves the browser. |
| `https://gemini.google.com/*` | The extension reads the open conversation from the Gemini web app using the user's existing signed-in session. |
| `https://aistudio.google.com/*` | The same one-click export for prompts in Google AI Studio, which is a separate site with a separate page layout. |

**Single purpose statement:** "Export the Gemini conversation the user is currently viewing to
a Markdown file on their own computer."

**Remote code:** No. All code is contained in the package.

**Data usage disclosures:** tick *nothing*. The extension collects and transmits no user data
of any category.

---

## Graphic assets

| Asset | Required size | File | Status |
| --- | --- | --- | --- |
| Store icon | 128×128 PNG | reuse `store/assets/icon512.png` (dashboard downscales) | shared with the other items |
| Screenshot 1 | 1280×800 PNG | `store/gemini/assets/screenshot-1-popup.png` | TODO — needs a gemini.google.com capture |
| Screenshot 2 | 1280×800 PNG | `store/gemini/assets/screenshot-2-output.png` | TODO — should show a `python` fence with no "Copy code" line |
| Screenshot 3 | 1280×800 PNG | `store/gemini/assets/screenshot-3-thinking.png` | TODO — optional, shows expanded thinking in the .md |
| Small promo tile | 440×280 | optional | only needed to be considered for featuring |

At least one screenshot is mandatory; up to five are allowed. Screenshots must be
1280×800 or 640×400, PNG or JPEG, no alpha channel, no rounded corners applied by you.
Blur or replace any real conversation content before publishing a capture.

---

## Suggested screenshot captions

Burned into the screenshot images themselves (the store does not render separate captions):

1. *"Gemini exports one answer to Docs. This exports the whole chat to a file."*
2. *"Code fences keep their language. 'Copy code' does not come with them."*
3. *"The whole thread — including the turns Gemini had not loaded yet."*
