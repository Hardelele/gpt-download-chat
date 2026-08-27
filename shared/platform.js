/**
 * platform.js — GENERATED. Do not edit by hand.
 *
 * Written by scripts/build.mjs from the "chatgpt" entry in platforms.config.mjs.
 * The copy checked in at shared/platform.js is the ChatGPT one, so `node --test`
 * and a load-unpacked of the source tree keep working.
 */

export const PLATFORM = Object.freeze({
  "id": "chatgpt",
  "productName": "Chat2MD",
  "assistantLabel": "ChatGPT",
  "userLabel": "You",
  "siteName": "ChatGPT",
  "siteHost": "chatgpt.com",
  "fallbackTitle": "ChatGPT conversation",
  "hosts": [
    "chatgpt.com",
    "chat.openai.com"
  ],
  "conversationUrl": [
    "^/(?:c/|share/|g/[^/]+/c/)"
  ],
  "extractorEntry": "src/lib/extract.js",
  "idle": {
    "elsewhere": [
      "Not a ChatGPT conversation",
      "Open a chat on <b>chatgpt.com</b>, then click the Chat2MD icon again."
    ],
    "newChat": [
      "No conversation open yet",
      "This looks like a new chat. Send a message first — Chat2MD exports saved conversations."
    ]
  }
});

/** Compiled once; matched against `pathname + search`. */
export const CONVERSATION_URL = PLATFORM.conversationUrl.map((src) => new RegExp(src));
