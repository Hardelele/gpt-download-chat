# Chrome Web Store submission checklist — Chat2MD

Ordered. Everything above the line marked **HUMAN ONLY** is already done in this repo;
everything below needs a person with a browser, a Google account and a credit card.

---

## 0. Already done in this repo

- [x] `manifest.json` is MV3, version `0.1.0`, description 127/132 chars.
- [x] Icons at 16/32/48/128 px — real PNGs, verified to decode (`npm run icons`).
- [x] Store icon at 512×512 — `store/assets/icon512.png`.
- [x] Three screenshots at exactly 1280×800 — `store/assets/screenshot-*.png`
      (`npm run screenshots`; sources in `store/assets/src/` if you want to re-render).
- [x] Listing copy — `store/listing.md`.
- [x] Permission justifications, single purpose, data-usage answers — `store/permissions-justification.md`.
- [x] Privacy policy written (`PRIVACY.md`) and a hosted copy staged at `docs/privacy.html`.
- [x] Packaged archives — `npm run build` → four zips under `dist/`, manifest at the root of
      each, every archive read back and validated. See the table at the bottom for names.
- [x] **GitHub Pages is live and the privacy policy resolves** — verified 200:
      `https://hardelele.github.io/gpt-download-chat/privacy.html`

---

## Submission record

| item | publisher | store ID | status |
| --- | --- | --- | --- |
| `chatgpt` | Perfect Storms | `bngmdbdgobfoagmedlobigmfjikcadcc` | submitted 2026-08-30, **pending review**, auto-publish on pass |

Google warned at submit time that the host permissions may trigger an in-depth review, so
expect this one to be slower than the "few hours" best case.

## The publisher limit counts PUBLISHED items, not drafts

The console's own wording: *"You've used 1 of 3 allowed published extensions. While you can
continue to save drafts after reaching this limit, you will be unable to submit new extensions
for review."* So all four items can be prepared in the dashboard; only submission is gated.

Both publisher accounts sit at 1/3 (Reckue holds Reckue Languages; Perfect Storms holds Git
pages). The cap can be raised — the request is made from the dashboard and usually answered
immediately, but Google declines when the existing published items show weak engagement or the
account is young. Practically: ship, get installs, then ask.

## Only ONE item is submittable today

`chatgpt` is complete. **Claude, Gemini and AI Mode have no screenshots** — the store requires
at least one, so those three cannot be submitted until someone captures them. Their listing
files spell out what each shot must show. `npm run screenshots` only renders the ChatGPT set;
it is not parameterised per platform.

## Automating the dashboard — what works and what does not

Two different routes, and they do not behave the same:

- **Extension-based automation cannot touch it.** Chrome forbids extensions from injecting
  into `chrome.google.com` (the extensions gallery), and the console is served from that
  origin. Every action fails with *"The extensions gallery cannot be scripted"* — including
  taking a screenshot, because that path is injection too.
- **External automation (Playwright / CDP) reaches it fine.** It drives the browser from
  outside rather than as an extension, so the gallery restriction does not apply. Verified:
  the console loads and redirects to the normal Google sign-in.

What is *not* automatable either way is the Google sign-in itself — the password, and any
2FA, have to be typed by the account owner. Whether Google accepts a sign-in from an
automation-controlled browser at all is unverified; it often challenges them.

---

## HUMAN ONLY — from here down, someone has to do this by hand

### 1. GitHub Pages — DONE, nothing to do

Source is `main` / `/docs`, build status `built`, and both URLs return 200:

```
https://hardelele.github.io/gpt-download-chat/privacy.html   ← privacy policy field
https://hardelele.github.io/gpt-download-chat/               ← landing page
```

A policy URL that 404s is the most common avoidable rejection, so re-check it in a private
window if `docs/` ever changes shape.

> `docs/.nojekyll` is committed so GitHub Pages serves the files as-is rather than running
> them through Jekyll. Do not delete it.

### 2. Register a developer account (one-time)

1. Go to <https://chrome.google.com/webstore/devconsole>.
2. Sign in with the Google account that will *own* the item. Choose carefully — transferring
   an item to a different account later is a support ticket, not a setting.
3. Pay the **one-time US$5 registration fee**. It is per account, not per extension, and it
   is non-refundable. Payment can take a few minutes to clear before the console unlocks.
4. Complete the **account tab**: publisher display name, a contact email, and a physical
   address if you are asked for one.
5. **Verify the contact email.** Unverified contact email blocks publishing, and the console
   does not always say so loudly.

> **Two different addresses, on purpose — do not "fix" one to match the other.**
> The console signs in as `hardelele@gmail.com` (the Google account that owns the item).
> `store/listing.md` gives the published developer contact as `hardelele@yahoo.com`. The
> contact address is the one that must be verified in the account tab; the sign-in address is
> not automatically the contact address. Decide which one users should write to, set that in
> the account tab, verify it, and make `store/listing.md` agree.

### 3. Create the item and upload

1. Console → **Items** → **Add new item**.
2. Upload `dist/chat2md-chatgpt-0.1.0.zip`.
   - If you get *"Manifest file is missing or unreadable"*, the archive has the manifest one
     folder down. `npm run build` prevents this and fails loudly if it ever happens, so
     rebuild rather than repacking by hand — and specifically **do not** zip the `extension`
     folder from Explorer's right-click menu, which produces exactly that broken layout.

### 4. Fill in the Store listing tab

Copy from `store/listing.md`:

- [ ] **Item name** — `Chat2MD — Save AI chats as Markdown` (pulled from the manifest, which
      `npm run build` generates from `platforms.config.mjs`).
- [ ] **Short description** — pulled from the manifest; do not edit it here, edit the manifest.
- [ ] **Detailed description** — paste the block from `store/listing.md`. Plain text only;
      the field does not render Markdown or HTML.
- [ ] **Category** — the field is a *grouped* list. "Productivity" is a group heading, not a
      selectable value; pick **Workflow & Planning** underneath it.
- [ ] **Language** — English (United States).
- [ ] **Store icon** — upload the **128×128** icon from the built package, e.g.
      `dist/chat2md-<id>-<version>/icons/icon128.png`. It must be *exactly* 128×128.
      **`store/assets/icon512.png` is rejected** with *"The image size is incorrect"* — the
      console does not downscale a larger file, contrary to what this checklist used to claim.
      Using the package's own icon also means the store tile matches the toolbar icon the user
      sees after installing.
- [ ] **Screenshots** — upload all three from `store/assets/`, **one file per drop**; the
      input is not `multiple` and rejects a multi-file selection. At least one is mandatory,
      five is the maximum. Requirements: **1280×800 or 640×400**, PNG or JPEG, no alpha
      channel, no rounded corners or drop shadows added by you around the outside of the
      image. Ours are 1280×800 PNG.
- [ ] **Small promo tile** — 440×280 PNG/JPEG. *Optional.* Only needed to be eligible for
      store curation/featuring. Not generated; skip unless you want it.
- [ ] **Marquee promo tile** — 1400×560 PNG/JPEG. *Optional*, homepage carousel only. Skip.
- [ ] **Homepage URL** — `https://github.com/hardelele/gpt-download-chat`
- [ ] **Support URL** — `https://github.com/hardelele/gpt-download-chat/issues`

### 5. Fill in the Privacy tab

Copy from `store/permissions-justification.md`.

> That file is written for the **ChatGPT** item only — its host-permission paragraph names
> `chatgpt.com` and `chat.openai.com`. The other three items carry their own
> `## Permissions justification` section inside `store/<id>/listing.md`, naming their own
> hosts (`claude.ai`, `gemini.google.com` + `aistudio.google.com`,
> `www.google.com/search*` + `/ai*`). Pasting the ChatGPT text into a sibling item justifies
> hosts that item does not request, which is a rejection in its own right.

Fields:

- [ ] **Single purpose description** — the paragraph in that file.
- [ ] **Justification for `downloads`**.
- [ ] **Justification for `activeTab`**.
- [ ] **Justification for `scripting`**.
- [ ] **Justification for `storage`**.
- [ ] **Justification for host permissions** (`chatgpt.com`, `chat.openai.com`).
- [ ] **Remote code** → *No, I am not using remote code.*
      **The form defaults to "Yes, I am using Remote code".** Leaving it is an explicit
      declaration of the one thing MV3 forbids, on an extension that does not do it. Change it.
- [ ] **Data usage** → leave every category **unchecked**. Nothing is collected.
- [ ] Tick all **three certification checkboxes**.
- [ ] **Privacy policy URL** → `https://hardelele.github.io/gpt-download-chat/privacy.html`

### 6. Distribution tab

- [ ] Visibility: **Public**.
- [ ] Regions: **All**.
- [ ] Pricing: **Free**. No ads, no in-app purchases.

### 7. Submit

- [ ] **Save draft**, then re-read the Privacy tab once more — it is where rejections come from.
- [ ] **Submit for review.**
- [ ] Leave *"Publish immediately after review"* on unless you want to coordinate a launch.

---

## What actually delays review

Typical turnaround is **a few hours to three days**. These are what push it to one to three
*weeks*, roughly in order of how often they bite:

1. **A privacy policy URL that 404s, redirects, or sits behind a login.** Check it in a
   private window before submitting. See step 1.
2. **Permission justifications that do not match the manifest.** If B ever adds a permission,
   `store/permissions-justification.md` must change in the same commit. A justification for a
   permission you do not request is as bad as a missing one.
3. **Anything that looks like remote code.** MV3 forbids it. `npm run verify` fails the build
   on `eval(`, `new Function(`, a remote `<script src>`, or a URL to a host the manifest does
   not declare — keep it passing.
4. **Broad host permissions.** `<all_urls>` or `*://*/*` triggers a much slower manual
   review. We request two explicit hosts; keep it that way.
5. **Keyword stuffing or a misleading description.** Repeating "ChatGPT export markdown save
   download" gets the listing rejected for spam. The copy in `store/listing.md` is
   deliberately written as prose.
6. **Trademark trouble in the name.** Item names are mark-free unless the mark's owner
   blesses the construction. OpenAI and Anthropic do not, so the ChatGPT and Claude items are
   named `Chat2MD — Save AI chats as Markdown` and `Chat2MD — AI Chat to Markdown`; the mark
   appears only in the description, next to a TRADEMARKS non-affiliation paragraph. Google
   does bless "… for Gemini™", so those two items are `Chat2MD for Gemini™ …` and
   `Chat2MD for AI Mode™ …` — with ™, never ®, and with the attribution paragraph. Do **not**
   rename anything to something that reads first-party ("ChatGPT Exporter", "Google AI
   Export"), and do not use anyone's logo or wordmark in an icon or screenshot. Ours use
   none. All four names live in `platforms.config.mjs`; edit them there.
7. **A first submission from a brand-new developer account** is reviewed more slowly than
   subsequent ones. Expect the first one to be the slow one.
8. **Screenshots that are not exactly 1280×800 or 640×400**, or that carry an alpha channel.
   `npm run screenshots` asserts the dimensions and fails if they drift.

## After it is published

- [ ] Tag the release: `git tag v0.1.0 && git push --tags`.
- [ ] Attach the four `dist/chat2md-*-0.1.0.zip` packages to the GitHub release (CI also
      uploads them as build artifacts on every run).
- [ ] Put the store URL in `README.md` and replace the "install from source" framing.
- [ ] For every later version: bump `package.json` only — every manifest inherits that
      version, so the two can no longer disagree — add a `CHANGELOG.md` entry, then upload
      the new zip as a new package in the same item.

## Sibling store items

`CONTRACT-PLATFORMS.md` defines three more items (Claude, Gemini, AI Mode) sharing this
codebase. Each is a **separate** store listing with its own screenshots and its own
permission justifications, but the same developer account, the same $5 fee (paid once), and
the **same privacy policy URL** — the policy is written to cover all of them.

`npm run build` composes and verifies all four at once; `npm run build -- <id>` does one.
`npm run platforms` prints the table. All four request the same four permissions
(`downloads`, `activeTab`, `scripting`, `storage`) because they share one popup — keep every
listing's permission table in step with `platforms.config.mjs` → `manifestFor()`.

| id | package | item name |
| --- | --- | --- |
| `chatgpt` | `dist/chat2md-chatgpt-<version>.zip` | Chat2MD — Save AI chats as Markdown |
| `claude` | `dist/chat2md-claude-<version>.zip` | Chat2MD — AI Chat to Markdown |
| `gemini` | `dist/chat2md-gemini-<version>.zip` | Chat2MD for Gemini™ — Save chats as Markdown |
| `aimode` | `dist/chat2md-aimode-<version>.zip` | Chat2MD for AI Mode™ — Save AI answers as Markdown |
