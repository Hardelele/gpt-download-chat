# Privacy Policy — Chat2MD

**Last updated: 26 August 2026**
**Applies to: the Chat2MD browser extension ("Save ChatGPT chats as Markdown"), all versions.**

## The short version

Chat2MD does not collect, transmit, store, or sell any data. It has no server, no
account, no analytics, and no third-party SDKs. Everything it does happens inside your
browser, on your machine, and the only thing it produces is a `.md` file in your
Downloads folder.

## What data Chat2MD handles

When you click **Download .md**, the extension reads the conversation that is open in
your active tab. To do that it accesses:

- the conversation content (titles, message text, timestamps, model name, attachment
  names and URLs) as ChatGPT already serves it to your own browser session;
- the URL of the active tab, in order to work out which conversation you meant.

This content is converted to Markdown **in memory, in the page**, and handed straight
to Chrome's download machinery. It is not copied anywhere else.

## What Chat2MD does not do

- **No collection.** Nothing is written to any storage the developer can read.
- **No transmission.** The extension makes no network requests to any server operated
  by the developer or by anyone else. The only requests it makes are to
  `chatgpt.com` / `chat.openai.com` — the site you are already on — using your existing
  logged-in session, exactly as the page itself would.
- **No analytics or telemetry.** No page views, no event counters, no crash reporting,
  no unique identifiers, no fingerprinting.
- **No advertising.** Your data is never used for ads, ad targeting, or profiling.
- **No sale or transfer.** There is nothing to sell and no one to transfer it to.
- **No remote code.** The extension ships all of its JavaScript in the package. It does
  not fetch, evaluate, or inject code from any remote source.
- **No background activity.** Nothing runs until you open the popup and click the button.

## Where your data goes

Into the file you asked for. Chrome's `downloads` permission writes it to your normal
download location. What happens to that file afterwards is entirely up to you — the
extension never reads it back.

## Permissions and why they exist

| Permission | Why |
| --- | --- |
| `downloads` | To save the generated Markdown file to your computer. This is the extension's entire output. |
| `activeTab` | To act on the conversation in the tab you are currently looking at, only after you click the extension's button. |
| `scripting` | To run the extraction code inside that one tab so it can read the conversation. The code is bundled in the extension; nothing is downloaded. |
| Host access to `chatgpt.com` / `chat.openai.com` | To read the conversation from the site you are on. Chat2MD requests no access to any other website. |

## Limited Use disclosure

Chat2MD's use of information received from Google APIs and from the user's browsing
session adheres to the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq),
including the Limited Use requirements. Specifically: the data accessed is used **solely**
to provide the single user-facing feature — producing a Markdown file of the conversation
the user explicitly chose to export — and for no other purpose. It is not transferred to
any third party, not used for advertising, not used to build user profiles, and not read
by humans.

## Children

Chat2MD is not directed at children and collects no data from anyone, of any age.

## Changes to this policy

If this policy ever changes it will be updated in this repository and re-published at the
URL below, with a new "Last updated" date. Because the extension collects nothing, a
change would most likely mean a change in permissions — and Chrome shows you those before
an update installs.

## Source code

Chat2MD is open source under the MIT licence. Every claim on this page can be checked
against the code: <https://github.com/hardelele/gpt-download-chat>

## Contact

Questions or a privacy concern: open an issue at
<https://github.com/hardelele/gpt-download-chat/issues>, or email hardelele@yahoo.com.

---

*Published copy of this policy:*
<https://hardelele.github.io/gpt-download-chat/privacy.html>
