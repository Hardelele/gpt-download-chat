# Chrome Web Store listing — Chat2MD for AI Mode

Copy each block verbatim into the corresponding field of the Web Store developer
dashboard (**Store listing** tab). Character counts are the store's hard limits.

> Structure mirrors `store/listing.md` (the ChatGPT item) and `store/claude/listing.md`
> on purpose — privacy, pricing, support and distribution are identical across all store
> items. Only the product name, the "which site" sentence, the positioning and the
> screenshots change.

---

## Item name

*Limit 75 characters. Currently 49.*

```
Chat2MD for AI Mode — Save AI answers as Markdown
```

> Must match `extensions/aimode/manifest.json` → `name`. It does.
>
> **Naming is deliberate and must not be "improved".** Google's brand rules forbid using a
> Google trademark as the name of a third-party product; the accepted phrasing for a
> compatible companion is "for …", with the ™ symbol on the trademark itself where it is
> used. "AI Mode" is the feature name and is spelled out in the description with the
> attribution line at the end. Do **not** rename this to "Google AI Mode Exporter",
> "Google AI Export" or anything that starts with "Google" — Web Store review rejects
> items whose name implies official affiliation, and it is the single most common
> rejection reason for extensions in this category.

---

## Short description (summary)

*Limit 132 characters. Currently 118. Shown in search results and on the tile.*

```
Save an AI Mode answer thread from Google Search™ as a Markdown file, with every inline citation and source link kept.
```

> Must match `extensions/aimode/manifest.json` → `description`. The store pulls this field
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
Chat2MD saves an AI Mode thread from Google Search to a Markdown file, in one click, with the answer and the sources it was built from kept together.

WHY IT EXISTS

AI Mode is the one AI surface where the sources are the point. You do not just get an answer — you get an answer stitched together from numbered pages you can go and check. And that is exactly the part you cannot keep.

Select an AI Mode answer, press Ctrl+C, paste it somewhere: the little numbered citation markers survive as bare digits and every link behind them is gone. They are not links in the page — they are buttons, and the pages they point at live in a metadata block the clipboard never sees. What lands in your notes is prose with mysterious numbers in it and no way to retrace a single claim. Code blocks lose their fences, tables collapse into runs of words, and a long thread loses the turns that were not scrolled into view.

The built-in options do not fill the gap either.

Share gives you a public link, not a file. It requires Search history and personalized recommendations to be switched on, it publishes the thread to anyone who has the URL, and follow-up questions you ask after sharing are not included in what you shared.

Google Takeout gives you an account-wide archive. It is queued, it arrives by email, and it is a log of everything you have ever searched — a record that the answer happened, not a readable document of this one thread with its citations in place.

If what you wanted was this thread, as a file, in your notes folder, with the sources attached, neither of those is it.

WHAT YOU GET

• The whole thread. Every question you asked and every answer you got, in order — not just the turn on screen. Collapsed answers are expanded and earlier turns are loaded before anything is written.
• Citations as real links. Each numbered marker becomes a working Markdown link exactly where it appeared in the sentence it supports.
• A Sources list under every answer, numbered to match the markers, with the page title and the full URL. Six months later you can still check the claim.
• Fenced code blocks that keep their language, so highlighting still works when you paste the file into your editor or a pull request.
• Tables, nested lists, block quotes and inline formatting preserved as Markdown.
• A YAML front-matter block with the query, source URL and export date — so the file drops straight into Obsidian, Logseq, Quartz, Hugo or Jekyll without editing.
• A sensible, filesystem-safe filename derived from your question.
• AI Overviews too. The generated summary at the top of an ordinary results page exports the same way, sources and all.
• An honest failure. Google rewrites this page often. If the layout is not recognised, Chat2MD tells you so instead of handing you a half-empty file that looks complete.

WHO IT IS FOR

Anyone who uses AI Mode as a research step rather than a quick lookup. Analysts and journalists who need the citation trail, not just the summary. Students and researchers keeping a record of where an answer came from. SEO and content teams tracking which pages AI Mode is actually citing for a query. Anyone who has ever pasted an AI answer into a document and then could not remember which source said what.

HOW IT WORKS

Open AI Mode — the AI Mode tab on a Google Search results page, or google.com/ai. Click the Chat2MD icon. Click Download .md. The file appears in your Downloads folder. There is nothing to sign up for, nothing to configure, and no step where you paste anything anywhere.

PRIVACY

Chat2MD has no server, because it does not need one. The conversion happens inside your browser and the finished file goes straight to your disk.

• No data is collected. None.
• No analytics, no telemetry, no crash reporting, no identifiers.
• No account, no login, no subscription.
• The extension makes no network requests to the developer or to any third party. It reads the page you are already looking at, in the session you are already signed in to.
• No remote code: every line of JavaScript ships inside the package and can be read before you install it.

Chat2MD for AI Mode requests access to Google Search pages and to no other website.

OPEN SOURCE

Chat2MD is MIT-licensed and developed in the open. If you want to confirm any of the claims above, read the code:
https://github.com/hardelele/gpt-download-chat

Bug reports and feature requests are welcome on the issue tracker.

PRICING

Free. No paid tier, no trial, no upsell.

Google, Google Search and AI Mode are trademarks of Google LLC. Chat2MD is an independent project and is not affiliated with, endorsed by, or sponsored by Google.
```

*Word count: ~640 in the pasted block. Benefit-led, no emoji, no keyword stuffing.*

---

## Honesty notes for whoever maintains this copy

This was written against the surface as it stood on **2026-08-26**. Three factual claims
carry the positioning, and each was checked rather than assumed:

1. **There is no per-thread file export.** Verified. What exists instead is:
   - **Share** (Google Search Help 16517651) — creates a *public* link, not a file. It is
     gated on Search history + personalized recommendations being enabled; with those off,
     the Share control is unavailable. Follow-ups asked *after* you share are not part of
     the shared link. Public links are managed under AI Mode history → "Manage public links".
   - **AI Mode history** — an in-account list of past threads. Viewing, not exporting.
   - **Google Takeout / Search Services History** — since the June 2026 split of the Search
     history controls, Search Services History does retain the *full text* of generative AI
     responses, and Takeout can export it. So the blunt claim "there is no export" would be
     **false** and must not be made. What Takeout gives you is an account-wide activity
     archive, queued and emailed, not a document of one thread with its citations rendered
     in place. The copy above says exactly that and nothing stronger.
2. **Copy-paste loses the citation targets.** Verified structurally: the inline markers are
   `<button>` elements (`data-icl-uuid` / `data-amic`) whose destination URLs live in a
   hidden metadata block, so a clipboard copy yields bare numbers. This is the strongest and
   most defensible line in the listing — lead with it if anything else has to be cut.
3. **AI Overviews export too.** True of the current build, via a separate fallback path. If
   that path is ever removed, delete that bullet the same day.

If Google ships a "Download" or "Export as Markdown" control on AI Mode threads, the
"WHY IT EXISTS" section becomes false advertising and must be rewritten immediately. The
honest reposition is still strong — citations resolved to real links, a numbered Sources
list per answer, front matter, and a filename you can live with — but the copy has to lead
with those instead of with the gap. Re-check before each store submission.

Do not describe the extension as "official", "by Google", or as a Google product, and do not
use Google's logo, wordmark or brand colours in the icon or screenshots.

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
`extensions/aimode/manifest.json` exactly.

| Permission | Justification to paste |
| --- | --- |
| `downloads` | Used to write the generated Markdown file to the user's Downloads folder. This is the extension's only output. |
| `activeTab` | Used to read the AI Mode thread in the tab the user clicked the extension on, and only at that moment. |
| `scripting` | Used to inject the extraction script into the active Google Search tab so the answer and its citations can be read and converted in the page. |
| `https://www.google.com/search*` | The AI Mode tab of Google Search, where AI Mode threads and AI Overviews are rendered. The extension reads the page the user is already viewing. |
| `https://www.google.com/ai*` | Google's own entry point for AI Mode. Same purpose as above. |

> The host permissions are deliberately path-scoped rather than `https://www.google.com/*`:
> the extension has no business on Gmail, Drive, Docs, Maps or any other Google property,
> and a reviewer who sees a narrow pattern asks fewer questions. `storage` is **not**
> requested by this item — it has no options to remember. `<all_urls>` is never requested.

**Single purpose statement:** "Export the AI Mode answer thread the user is currently
viewing on Google Search to a Markdown file on their own computer, with its source
citations."

**Remote code:** No. All code is contained in the package.

**Data usage disclosures:** tick *nothing*. The extension collects and transmits no user data
of any category.

---

## Graphic assets

| Asset | Required size | File | Status |
| --- | --- | --- | --- |
| Store icon | 128×128 PNG | reuse `store/assets/icon512.png` (dashboard downscales) | shared with the other items |
| Screenshot 1 | 1280×800 PNG | `store/aimode/assets/screenshot-1-popup.png` | TODO — needs an AI Mode capture |
| Screenshot 2 | 1280×800 PNG | `store/aimode/assets/screenshot-2-sources.png` | TODO — must show the `## Sources` block in the .md; that is the whole pitch |
| Small promo tile | 440×280 | optional | only needed to be considered for featuring |

At least one screenshot is mandatory; up to five are allowed. Screenshots must be
1280×800 or 640×400, PNG or JPEG, no alpha channel, no rounded corners applied by you.

**Screenshot rules specific to this item:** do not capture Google's logo, the Google Search
header or the AI Mode branding in a way that dominates the frame — crop to the answer
column and the extension popup. Never present the extension UI as though it were part of
Google's interface.

---

## Suggested screenshot captions

1. "One click on an AI Mode thread — no account, no upload."
2. "Every numbered citation becomes a real link, with a Sources list under each answer."
3. "Front matter, code fences and tables land intact in Obsidian."
4. "AI Overviews export the same way."
