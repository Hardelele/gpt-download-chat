/**
 * platforms.config.mjs — the manifest table for every store item we ship.
 *
 * ONE source of truth. `scripts/build.mjs` reads this to compose each build:
 * which extractor to bundle, what the manifest says, which hosts are allowed,
 * which accent the icon set is tinted with, and what the renderer calls the
 * assistant inside the exported file.
 *
 * Adding a fifth platform should be: write an extractor under
 * `extensions/<id>/src/lib/extract.js`, add an entry here, run `npm run build`.
 * Nothing else.
 *
 * ------------------------------------------------------------------
 * Naming rule (read before touching `name`)
 * ------------------------------------------------------------------
 * Our own brand comes first. A third-party mark may appear in the *name* only
 * where that owner's guidelines bless the construction:
 *
 *   - Google permits "<Your Product> for Gemini™" / "... for AI Mode™" as long
 *     as the ™ is used (never ®) and the listing carries an attribution and a
 *     non-affiliation line. Hence the two Google items keep their marks.
 *   - OpenAI's brand guidelines say not to build their marks into a product
 *     name, and Anthropic grants no equivalent carve-out. So the ChatGPT and
 *     Claude items have MARK-FREE names and state compatibility in the
 *     description instead. Do not "helpfully" put ChatGPT or Claude back into
 *     `name` — that is a documented review-delay cause.
 *
 * Every `name` here must match the "Item name" block of the matching
 * `store/**\/listing.md`, and every `description` must match its "Short
 * description" block.
 */

/** Shipped version. The manifests inherit it, so there is nothing to keep in sync. */
export const PRODUCT = 'Chat2MD';

/**
 * @typedef {Object} Platform
 * @property {string}   id              short key; names the dist directory
 * @property {string}   outputName      zip/stage stem, `<outputName>-<version>`
 * @property {string}   name            manifest + store item name (see naming rule above)
 * @property {string}   description     manifest + store short description, <=132 chars
 * @property {string[]} hostPermissions manifest `host_permissions`
 * @property {string[]} webAccessibleMatches  who may pull `src/lib/*.js`
 * @property {string}   extractorDir    directory whose contents become `src/lib/`
 * @property {string}   extractorEntry  the module `content.js` dynamically imports
 * @property {string}   assistantLabel  heading label inside the exported Markdown
 * @property {string}   accent          `#rrggbb` for the icon baseline bar
 * @property {string}   siteName        what the popup calls the site in prose
 * @property {string}   siteHost        host shown in bold in the popup's idle pane
 * @property {string}   fallbackTitle   title used when the extractor found none
 * @property {string[]} conversationUrl regex sources tested against `pathname + search`
 * @property {{elsewhere: [string,string], newChat: [string,string]}} idle popup copy
 */

/** @type {Platform[]} */
export const PLATFORMS = [
  {
    id: 'chatgpt',
    outputName: 'chat2md-chatgpt',
    name: 'Chat2MD — Save AI chats as Markdown',
    description:
      'Export any ChatGPT conversation to a clean Markdown file. Code blocks, tables and LaTeX survive. Runs entirely on your machine.',
    hostPermissions: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
    webAccessibleMatches: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
    extractorDir: 'extension/src/lib',
    extractorEntry: 'src/lib/extract.js',
    assistantLabel: 'ChatGPT',
    accent: '#f7b733',
    siteName: 'ChatGPT',
    siteHost: 'chatgpt.com',
    fallbackTitle: 'ChatGPT conversation',
    conversationUrl: ['^/(?:c/|share/|g/[^/]+/c/)'],
    idle: {
      elsewhere: [
        'Not a ChatGPT conversation',
        'Open a chat on <b>chatgpt.com</b>, then click the Chat2MD icon again.',
      ],
      newChat: [
        'No conversation open yet',
        'This looks like a new chat. Send a message first — Chat2MD exports saved conversations.',
      ],
    },
  },

  {
    id: 'claude',
    outputName: 'chat2md-claude',
    // Mark-free on purpose — see the naming rule at the top of this file.
    name: 'Chat2MD — AI Chat to Markdown',
    description:
      'Works with claude.ai. Save a conversation as a clean Markdown file — code, artifacts and tables survive. Runs on your machine.',
    hostPermissions: ['https://claude.ai/*'],
    webAccessibleMatches: ['https://claude.ai/*'],
    extractorDir: 'extensions/claude/src/lib',
    extractorEntry: 'src/lib/extract.js',
    assistantLabel: 'Claude',
    accent: '#d97757',
    siteName: 'claude.ai',
    siteHost: 'claude.ai',
    fallbackTitle: 'Claude conversation',
    conversationUrl: [
      '^/(?:chat/|share/|project/[^/]+/chat/)',
      '^/[0-9a-fA-F-]{36}/?(?:$|\\?)',
    ],
    idle: {
      elsewhere: [
        'Not a claude.ai conversation',
        'Open a chat on <b>claude.ai</b>, then click the Chat2MD icon again.',
      ],
      newChat: [
        'No conversation open yet',
        'This looks like a new chat. Send a message first — Chat2MD exports saved conversations.',
      ],
    },
  },

  {
    id: 'gemini',
    outputName: 'chat2md-gemini',
    // Google explicitly permits the "for <product>™" form with attribution.
    name: 'Chat2MD for Gemini™ — Save chats as Markdown',
    description:
      'Export any Gemini or AI Studio chat to a clean Markdown file. Code blocks and tables survive. Runs entirely on your machine.',
    hostPermissions: ['https://gemini.google.com/*', 'https://aistudio.google.com/*'],
    webAccessibleMatches: ['https://gemini.google.com/*', 'https://aistudio.google.com/*'],
    extractorDir: 'extensions/gemini/src/lib',
    extractorEntry: 'src/lib/extract.js',
    assistantLabel: 'Gemini',
    accent: '#4285f4',
    siteName: 'Gemini',
    siteHost: 'gemini.google.com',
    fallbackTitle: 'Gemini conversation',
    conversationUrl: [
      '^(?:/u/\\d+)?/(?:app|chat|gem)/[A-Za-z0-9_-]{4,}',
      '^(?:/app)?/prompts/[A-Za-z0-9_-]{4,}',
    ],
    idle: {
      elsewhere: [
        'Not a Gemini conversation',
        'Open a chat on <b>gemini.google.com</b> or <b>aistudio.google.com</b>, then click the Chat2MD icon again.',
      ],
      newChat: [
        'No conversation open yet',
        'This looks like a new chat. Send a message first — Chat2MD exports saved conversations.',
      ],
    },
  },

  {
    id: 'aimode',
    outputName: 'chat2md-aimode',
    name: 'Chat2MD for AI Mode™ — Save AI answers as Markdown',
    description:
      'Save an AI Mode answer thread from Google Search™ as a Markdown file, with every inline citation and source link kept.',
    hostPermissions: ['https://www.google.com/search*', 'https://www.google.com/ai*'],
    webAccessibleMatches: ['https://www.google.com/*'],
    extractorDir: 'extensions/aimode/src/lib',
    extractorEntry: 'src/lib/extract.js',
    assistantLabel: 'AI Mode',
    accent: '#34a853',
    siteName: 'AI Mode',
    siteHost: 'google.com',
    fallbackTitle: 'AI Mode thread',
    // AI Mode is a query parameter on an ordinary results URL, not a path, so
    // the patterns below are matched against `pathname + search`.
    conversationUrl: ['^/search\\?.*(?:\\budm=50\\b|\\baep=11\\b)', '^/ai(?:/|\\?|$)'],
    idle: {
      elsewhere: [
        'Not an AI Mode answer',
        'Open AI Mode on <b>google.com</b>, then click the Chat2MD icon again.',
      ],
      newChat: [
        'No AI answer on this page yet',
        'Switch to the AI Mode tab and ask something — Chat2MD exports the answer thread.',
      ],
    },
  },
];

/** @param {string} id */
export function platformById(id) {
  const p = PLATFORMS.find((x) => x.id === id);
  if (!p) {
    throw new Error(`unknown platform "${id}" — known ids: ${PLATFORMS.map((x) => x.id).join(', ')}`);
  }
  return p;
}

/**
 * The full MV3 manifest for one platform.
 *
 * Everything outside the per-platform fields is the shared shell and is
 * deliberately identical across all four items:
 *   - no `content_scripts`: `content.js` is injected on demand with `activeTab`
 *     + `scripting`, so the extension is inert until the user clicks the icon;
 *   - `web_accessible_resources` exposes `src/lib/*.js` because `content.js`
 *     reaches the ES modules through `import(chrome.runtime.getURL(...))`;
 *   - `storage` is present on ALL FOUR because the shared popup persists the
 *     user's render options through `chrome.storage.sync`. Removing it from one
 *     item would make that item's popup throw on open.
 *
 * @param {Platform} p
 * @param {string} version
 */
export function manifestFor(p, version) {
  const icons = {
    16: 'icons/icon16.png',
    32: 'icons/icon32.png',
    48: 'icons/icon48.png',
    128: 'icons/icon128.png',
  };
  return {
    manifest_version: 3,
    name: p.name,
    version,
    description: p.description,
    icons,
    action: {
      default_title: 'Save this chat as Markdown',
      default_popup: 'src/popup/popup.html',
      default_icon: icons,
    },
    background: {
      service_worker: 'src/background.js',
      type: 'module',
    },
    permissions: ['downloads', 'activeTab', 'scripting', 'storage'],
    host_permissions: p.hostPermissions,
    web_accessible_resources: [
      {
        resources: ['src/lib/*.js'],
        matches: p.webAccessibleMatches,
      },
    ],
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self'",
    },
  };
}

/**
 * Source of the generated `src/platform.js` module.
 *
 * The shell (popup, background worker) is written once and imports this to
 * learn which product it is running inside — that is how `assistantLabel`
 * reaches `toMarkdown()`, and how the popup knows which URLs count as a
 * conversation. `shared/platform.js` is the checked-in ChatGPT copy so the
 * source tree stays runnable; `scripts/build.mjs` overwrites it per platform
 * while staging.
 *
 * @param {Platform} p
 */
export function platformModuleSource(p) {
  const view = {
    id: p.id,
    productName: PRODUCT,
    assistantLabel: p.assistantLabel,
    userLabel: 'You',
    siteName: p.siteName,
    siteHost: p.siteHost,
    fallbackTitle: p.fallbackTitle,
    hosts: p.webAccessibleMatches.map((m) => m.replace(/^https?:\/\//, '').replace(/\/.*$/, '')),
    conversationUrl: p.conversationUrl,
    extractorEntry: p.extractorEntry,
    idle: p.idle,
  };
  return `/**
 * platform.js — GENERATED. Do not edit by hand.
 *
 * Written by scripts/build.mjs from the "${p.id}" entry in platforms.config.mjs.
 * The copy checked in at shared/platform.js is the ChatGPT one, so \`node --test\`
 * and a load-unpacked of the source tree keep working.
 */

export const PLATFORM = Object.freeze(${JSON.stringify(view, null, 2)});

/** Compiled once; matched against \`pathname + search\`. */
export const CONVERSATION_URL = PLATFORM.conversationUrl.map((src) => new RegExp(src));
`;
}
