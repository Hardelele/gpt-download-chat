# Permissions justification — Chat2MD (ChatGPT)

Paste these into the **Privacy practices** tab of the Chrome Web Store dashboard. Each
heading below matches a dashboard field exactly. Written against the real
`extension/manifest.json` as committed:

```json
"permissions":      ["downloads", "activeTab", "scripting", "storage"],
"host_permissions": ["https://chatgpt.com/*", "https://chat.openai.com/*"]
```

Reviewers reject vague justifications ("needed for the extension to work") and
justifications that describe a permission the manifest does not request. Keep these in sync
with the manifest — if B changes `permissions`, this file must change in the same commit.

---

## Single purpose

> Field: **Single purpose description**

```
Chat2MD has one purpose: to export the ChatGPT conversation the user is currently viewing to a Markdown (.md) file on the user's own computer. Every permission the extension requests exists to serve that one action, and the extension does nothing when the user is not on chatgpt.com or has not clicked the toolbar button.
```

---

## `downloads`

```
Chat2MD's entire output is a file. After converting the conversation to Markdown in memory, the extension calls chrome.downloads.download() to write that file to the user's normal download location. This is the last step of the only user-facing action the extension has, and it is triggered exclusively by the user clicking "Download .md" in the popup. The extension never enumerates, reads, opens, modifies or deletes any other download, and it never initiates a download the user did not ask for.
```

---

## `activeTab`

```
The user invokes Chat2MD by clicking its toolbar icon while looking at a conversation. activeTab gives the extension access to exactly that one tab, at exactly that moment, as a direct result of that click, and to nothing else. The extension uses it to identify which conversation the user meant — reading the tab's URL to obtain the conversation ID — and to grant the extraction code a foothold in that page. Access granted by activeTab expires when the user navigates away, which is the narrowest form of page access Chrome offers and is why we prefer it over persistent tab access. Chat2MD does not request the "tabs" permission, so it can neither see nor list the user's other tabs.
```

---

## `scripting`

```
The conversation data lives inside the ChatGPT page, in the context of the user's logged-in session. To read it, Chat2MD injects its own extraction module into that page with chrome.scripting.executeScript() when the user clicks the button. Every injected file is bundled inside the extension package (src/lib/*.js) — nothing is fetched from a remote server, nothing is evaluated from a string, and the extension declares a content security policy of "script-src 'self'; object-src 'self'". Injection happens only into the tab the user activated, only on chatgpt.com and chat.openai.com, and only in response to the user's click; the extension has no content script that runs automatically on page load.
```

---

## `storage`

```
Chat2MD offers a handful of export options — whether to include a YAML front-matter block, per-message timestamps, system messages, tool calls and the assistant's reasoning steps, and which heading style and speaker labels to use. chrome.storage.sync remembers the user's choices so they do not have to reset them on every export. Only these render settings are stored: a small object of booleans and short strings. No conversation content, no URLs, no personal data and no identifiers are ever written to storage, and nothing in storage is ever transmitted anywhere — it is read only by the extension's own popup, on the user's own machine.
```

---

## Host permissions — `https://chatgpt.com/*`, `https://chat.openai.com/*`

```
These two hosts are the ChatGPT web application, and they are the only sites Chat2MD is designed to work on. chat.openai.com is the legacy domain that still serves the same product and still holds many users' older conversations, so both are needed for the extension to be reliable. Host access lets the extension read the conversation from the site the user is already signed in to, using the user's existing session — exactly as the page itself does, with no separate authentication and no credentials handled by the extension. Chat2MD requests no other host, does not request <all_urls> or any wildcard host pattern, and cannot run on any other website. It sends no request to any server operated by the developer, because there is no such server.
```

---

## Data usage disclosures

> Field: **Data usage** — tick the certification checkboxes and select the data categories.

**Data collected: none.** Leave every category unchecked:

| Category | Collected? |
| --- | --- |
| Personally identifiable information | No |
| Health information | No |
| Financial and payment information | No |
| Authentication information | No |
| Personal communications | No |
| Location | No |
| Web history | No |
| User activity | No |
| Website content | No |

> **Why "Website content" is No, and how to answer if the reviewer asks.**
> The store's definition of *collect* is "transmit off the user's device". Chat2MD reads
> website content in memory and writes it to a local file at the user's explicit request; it
> never transmits it anywhere. If a reviewer queries this, the accurate reply is:
> *"The conversation is read into memory in the page and written directly to the user's own
> disk via chrome.downloads. It is not sent to any server, not stored by the extension, and
> not retained after the download completes. The extension has no network endpoint of its
> own — this is verifiable in the source, which is public under an MIT licence."*

**Certifications — tick all three:**

```
[x] I do not sell or transfer user data to third parties, outside of the approved use cases.
[x] I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
[x] I do not use or transfer user data to determine creditworthiness or for lending purposes.
```

---

## Limited Use statement

> Paste into the free-text data-usage box if one is offered, and keep the same wording in
> `PRIVACY.md` so the two cannot drift.

```
Chat2MD's use of information received from Google APIs and from the user's browsing session adheres to the Chrome Web Store User Data Policy, including the Limited Use requirements. Data accessed by the extension is used solely to provide the single user-facing feature — producing a Markdown file of the conversation the user explicitly chose to export — and for no other purpose. It is not transferred to any third party, not used for advertising or profiling, not used to train any model, and not read by humans. No data is retained after the export completes.
```

---

## Remote code

> Field: **Are you using remote code?** → **No, I am not using remote code**

```
All executable code is contained in the uploaded package. The extension does not load scripts from a URL, does not use eval() or new Function(), does not use a CDN, and declares "content_security_policy": {"extension_pages": "script-src 'self'; object-src 'self'"}. scripts/verify.mjs enforces this on every build and fails the build if a remote script reference, an eval, or an undeclared host appears anywhere under the extension tree.
```
