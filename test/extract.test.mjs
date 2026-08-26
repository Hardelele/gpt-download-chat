import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  parseConversationId,
  isShareUrl,
  buildBranch,
  nodeToMessage,
  renderContent,
  mapConversationPayload,
  extractViaApi,
  getAccessToken,
  findEmbeddedPayload,
} from '../extension/src/lib/api-client.js';
import { extractConversation, normalizeConversation } from '../extension/src/lib/extract.js';
import { turnToMessage, collectTurns, scrapeConversation } from '../extension/src/lib/dom-scrape.js';
import { makeDocument } from './fixtures/fake-dom.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAYLOAD = JSON.parse(readFileSync(join(HERE, 'fixtures', 'conversation-branched.json'), 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));

const MESSAGE_KEYS = ['id', 'role', 'authorName', 'createTime', 'contentType', 'text', 'attachments', 'hidden'];
const CONVERSATION_KEYS = ['id', 'title', 'createTime', 'updateTime', 'model', 'sourceUrl',
  'extractedVia', 'messages', 'warnings'];

function json(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

/** @param {Array<[string, Function]>} routes */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init });
    for (const [fragment, handler] of routes) {
      if (String(url).includes(fragment)) return handler(url, init);
    }
    return json({ detail: 'not found' }, 404);
  };
  impl.calls = calls;
  return impl;
}

const TRANSCRIPT_HTML = `
<main>
  <article data-testid="conversation-turn-1">
    <div data-message-author-role="user" data-message-id="u-1">
      <div class="whitespace-pre-wrap">What is 2+2?</div>
    </div>
  </article>
  <article data-testid="conversation-turn-2">
    <div data-message-author-role="assistant" data-message-id="a-1">
      <div class="markdown prose">
        <p>It is <strong>4</strong>.</p>
        <pre><div class="flex items-center">python</div><button>Copy code</button><code class="language-python">print(2 + 2)</code></pre>
      </div>
    </div>
  </article>
</main>`;

const SHARE_TURNS = '<main><article data-testid="conversation-turn-1">'
  + '<div data-message-author-role="user" data-message-id="s-1">'
  + '<div class="whitespace-pre-wrap">shared question</div></div></article></main>';

/* ------------------------------------------------------------------ */
/* URL parsing                                                         */
/* ------------------------------------------------------------------ */

test('parseConversationId handles every ChatGPT URL shape', () => {
  const id = '1f0c2b3a-4d5e-6f70-8192-a3b4c5d6e7f8';
  assert.equal(parseConversationId(`https://chatgpt.com/c/${id}`), id);
  assert.equal(parseConversationId(`https://chatgpt.com/c/${id}?model=gpt-4o#top`), id);
  assert.equal(parseConversationId(`https://chatgpt.com/g/g-2fkFE8rbu-dall-e/c/${id}`), id);
  assert.equal(parseConversationId(`https://chat.openai.com/c/${id}`), id);
  assert.equal(parseConversationId(`https://chat.openai.com/chat/${id}`), id);
  assert.equal(parseConversationId(`https://chatgpt.com/share/${id}`), id);
  assert.equal(parseConversationId(`https://chatgpt.com/share/e/${id}`), id);
  assert.equal(parseConversationId('https://chatgpt.com/'), null);
  assert.equal(parseConversationId(''), null);
  assert.equal(parseConversationId(null), null);
});

test('isShareUrl only matches /share/ pages', () => {
  assert.equal(isShareUrl('https://chatgpt.com/share/abc'), true);
  assert.equal(isShareUrl('https://chatgpt.com/c/abc'), false);
});

/* ------------------------------------------------------------------ */
/* Active-branch reconstruction — the core correctness property        */
/* ------------------------------------------------------------------ */

test('buildBranch walks parents from current_node and reverses', () => {
  const branch = buildBranch(PAYLOAD.mapping, PAYLOAD.current_node);
  assert.deepEqual(
    branch.map((n) => n.id),
    ['n-root', 'n-sys', 'n-u1', 'n-think', 'n-a1', 'n-u2', 'n-code', 'n-tool', 'n-a2'],
  );
});

test('buildBranch excludes abandoned regeneration and edited-prompt siblings', () => {
  const ids = buildBranch(PAYLOAD.mapping, PAYLOAD.current_node).map((n) => n.id);
  assert.ok(!ids.includes('n-a1-abandoned'));
  assert.ok(!ids.includes('n-orphan-branch'));
  // ...even though hash order would have put them right in the middle.
  const hashOrder = Object.keys(PAYLOAD.mapping);
  assert.ok(hashOrder.includes('n-a1-abandoned'), 'fixture really does contain the dead branch');
  assert.notDeepEqual(ids, hashOrder);
});

test('buildBranch survives a missing or dangling current_node by taking the deepest branch', () => {
  const withoutCurrent = { ...clone(PAYLOAD), current_node: undefined };
  const ids = buildBranch(withoutCurrent.mapping, withoutCurrent.current_node).map((n) => n.id);
  assert.equal(ids[0], 'n-root');
  assert.equal(ids[ids.length - 1], 'n-a2');

  const dangling = buildBranch(PAYLOAD.mapping, 'nope-not-a-node').map((n) => n.id);
  assert.equal(dangling[dangling.length - 1], 'n-a2');

  assert.deepEqual(buildBranch({}, 'x'), []);
  assert.deepEqual(buildBranch(null, 'x'), []);
});

test('buildBranch does not hang on a cyclic parent link', () => {
  const cyclic = {
    a: { id: 'a', message: null, parent: 'b', children: ['b'] },
    b: { id: 'b', message: null, parent: 'a', children: ['a'] },
  };
  assert.equal(buildBranch(cyclic, 'a').length, 2);
});

/* ------------------------------------------------------------------ */
/* Node → Message                                                      */
/* ------------------------------------------------------------------ */

test('nodeToMessage returns null for a node with no message', () => {
  assert.equal(nodeToMessage(PAYLOAD.mapping['n-root']), null);
  assert.equal(nodeToMessage(null), null);
});

test('a system node is kept but flagged hidden', () => {
  const msg = nodeToMessage(PAYLOAD.mapping['n-sys']);
  assert.equal(msg.role, 'system');
  assert.equal(msg.hidden, true);
  assert.match(msg.text, /large language model/);
});

test('a node flagged is_visually_hidden_from_conversation is hidden, not dropped', () => {
  const msg = nodeToMessage(PAYLOAD.mapping['n-tool']);
  assert.equal(msg.hidden, true);
  assert.equal(msg.role, 'tool');
  assert.equal(msg.authorName, 'python', 'tool name comes from author.name');
  assert.match(msg.text, /0\.0041231/);
});

test('a code node becomes a fenced block with its language', () => {
  const msg = nodeToMessage(PAYLOAD.mapping['n-code']);
  assert.equal(msg.contentType, 'code');
  assert.match(msg.text, /```python\nimport timeit/);
  assert.match(msg.text, /```$/);
  assert.match(msg.text, /tool call → `python`/, 'non-"all" recipient is labelled');
});

test('a thoughts node is typed as thoughts', () => {
  const msg = nodeToMessage(PAYLOAD.mapping['n-think']);
  assert.equal(msg.contentType, 'thoughts');
  assert.match(msg.text, /\*\*Picking an approach\*\*/);
  assert.match(msg.text, /list reversal/);
});

test('a multimodal_text node yields an image attachment and an inline placeholder', () => {
  const msg = nodeToMessage(PAYLOAD.mapping['n-u2']);
  assert.equal(msg.contentType, 'multimodal');
  assert.equal(msg.attachments.length, 1);
  assert.equal(msg.attachments[0].type, 'image');
  assert.equal(msg.attachments[0].url, 'file-service://file-ABC123');
  assert.match(msg.text, /^!\[.*\]\(file-service:\/\/file-ABC123\)/);
  assert.match(msg.text, /800×600/);
  assert.match(msg.text, /benchmark chart/);
});

test('every Message carries every contract key', () => {
  for (const id of Object.keys(PAYLOAD.mapping)) {
    const msg = nodeToMessage(PAYLOAD.mapping[id]);
    if (!msg) continue;
    assert.deepEqual(Object.keys(msg).sort(), [...MESSAGE_KEYS].sort(), `keys for ${id}`);
  }
});

test('renderContent copes with unknown content types without throwing', () => {
  assert.equal(renderContent(undefined).contentType, 'other');
  assert.equal(renderContent({ content_type: 'text' }).text, '');
  const weird = renderContent({ content_type: 'sonic_webpage', url: 'https://x.dev' });
  assert.equal(weird.contentType, 'other');
  assert.match(weird.text, /x\.dev/);
});

/* ------------------------------------------------------------------ */
/* Payload → Conversation                                              */
/* ------------------------------------------------------------------ */

test('mapConversationPayload produces the contract Conversation', () => {
  const conv = mapConversationPayload(PAYLOAD, { sourceUrl: 'https://chatgpt.com/c/x' });
  assert.deepEqual(Object.keys(conv).sort(), [...CONVERSATION_KEYS].sort());
  assert.equal(conv.id, PAYLOAD.conversation_id);
  assert.equal(conv.title, 'Reversing lists in Python');
  assert.equal(conv.createTime, PAYLOAD.create_time);
  assert.equal(conv.updateTime, PAYLOAD.update_time);
  assert.equal(conv.extractedVia, 'api');
  assert.equal(conv.sourceUrl, 'https://chatgpt.com/c/x');
  assert.equal(conv.model, 'gpt-4o', 'model comes from the last assistant message that has a slug');

  assert.deepEqual(
    conv.messages.map((m) => m.id),
    ['n-sys', 'n-u1', 'n-think', 'n-a1', 'n-u2', 'n-code', 'n-tool', 'n-a2'],
  );
  assert.deepEqual(
    conv.messages.filter((m) => !m.hidden).map((m) => m.role),
    ['user', 'assistant', 'assistant', 'user', 'assistant', 'assistant'],
  );
  assert.ok(!conv.messages.some((m) => /ABANDONED|EDITED PROMPT/.test(m.text)));
  assert.ok(conv.warnings.some((w) => /outside the active branch/.test(w)));
});

test('the uploaded filename from metadata enriches the attachment', () => {
  const conv = mapConversationPayload(PAYLOAD, {});
  const withImage = conv.messages.find((m) => m.id === 'n-u2');
  assert.equal(withImage.attachments[0].name, 'benchmark.png');
});

test('mapConversationPayload never throws on junk input', () => {
  for (const junk of [null, undefined, {}, { mapping: null }, { mapping: {}, current_node: 'x' }]) {
    const conv = mapConversationPayload(junk, {});
    assert.deepEqual(Object.keys(conv).sort(), [...CONVERSATION_KEYS].sort());
    assert.equal(conv.title, 'ChatGPT conversation');
    assert.deepEqual(conv.messages, []);
  }
});

/* ------------------------------------------------------------------ */
/* Network layer (injected fetch)                                      */
/* ------------------------------------------------------------------ */

test('getAccessToken reads /api/auth/session and returns null when logged out', async () => {
  const ok = await getAccessToken({
    fetch: fakeFetch([['/api/auth/session', () => json({ accessToken: 'tok-123', user: {} })]]),
    location: { origin: 'https://chatgpt.com' },
  });
  assert.equal(ok, 'tok-123');

  const loggedOut = await getAccessToken({
    fetch: fakeFetch([['/api/auth/session', () => json({}, 200)]]),
    location: { origin: 'https://chatgpt.com' },
  });
  assert.equal(loggedOut, null);

  const errored = await getAccessToken({
    fetch: fakeFetch([['/api/auth/session', () => json({}, 401)]]),
    location: { origin: 'https://chatgpt.com' },
  });
  assert.equal(errored, null);
});

test('extractViaApi sends the bearer token and same-origin credentials', async () => {
  const fetchImpl = fakeFetch([
    ['/api/auth/session', () => json({ accessToken: 'tok-abc' })],
    ['/backend-api/conversation/', () => json(PAYLOAD)],
  ]);
  const conv = await extractViaApi({
    fetch: fetchImpl,
    location: { origin: 'https://chatgpt.com', href: `https://chatgpt.com/c/${PAYLOAD.conversation_id}` },
  });
  assert.equal(conv.extractedVia, 'api');
  assert.equal(conv.messages.length, 8);

  const convCall = fetchImpl.calls.find((c) => c.url.includes('/backend-api/conversation/'));
  assert.ok(convCall.url.endsWith(PAYLOAD.conversation_id));
  assert.equal(convCall.init.credentials, 'include');
  assert.equal(convCall.init.headers.authorization, 'Bearer tok-abc');
});

test('extractViaApi rejects on a 401 so the caller can fall back', async () => {
  await assert.rejects(
    () => extractViaApi({
      fetch: fakeFetch([
        ['/api/auth/session', () => json({ accessToken: 't' })],
        ['/backend-api/conversation/', () => json({ detail: 'unauthorized' }, 401)],
      ]),
      location: { origin: 'https://chatgpt.com', href: 'https://chatgpt.com/c/abc-def-123456789' },
    }),
    /401/,
  );
});

/* ------------------------------------------------------------------ */
/* DOM fallback                                                        */
/* ------------------------------------------------------------------ */

test('collectTurns finds the conversation turns', () => {
  const doc = makeDocument(TRANSCRIPT_HTML);
  const turns = collectTurns(doc);
  assert.equal(turns.length, 2);
});

test('turnToMessage converts a turn to Markdown with role and id', () => {
  const doc = makeDocument(TRANSCRIPT_HTML);
  const [user, assistantTurn] = collectTurns(doc);

  const u = turnToMessage(user);
  assert.equal(u.role, 'user');
  assert.equal(u.id, 'u-1');
  assert.equal(u.text, 'What is 2+2?');
  assert.equal(u.hidden, false);
  assert.deepEqual(Object.keys(u).sort(), [...MESSAGE_KEYS].sort());

  const a = turnToMessage(assistantTurn);
  assert.equal(a.role, 'assistant');
  assert.match(a.text, /It is \*\*4\*\*\./);
  assert.match(a.text, /```python\nprint\(2 \+ 2\)\n```/);
  assert.ok(!/Copy code/i.test(a.text));
  assert.equal(a.createTime, null, 'DOM path cannot know timestamps');
});

test('scrapeConversation fills every contract key and warns about the degradation', async () => {
  const doc = makeDocument(TRANSCRIPT_HTML, { title: 'Simple math - ChatGPT' });
  const conv = await scrapeConversation({
    document: doc,
    location: { href: 'https://chatgpt.com/c/abc' },
    waitMs: 0,
    maxIterations: 2,
  });
  assert.deepEqual(Object.keys(conv).sort(), [...CONVERSATION_KEYS].sort());
  assert.equal(conv.extractedVia, 'dom');
  assert.equal(conv.title, 'Simple math');
  assert.equal(conv.model, null);
  assert.equal(conv.createTime, null);
  assert.equal(conv.messages.length, 2);
  assert.ok(conv.warnings.some((w) => /scraped from the page/i.test(w)));
});

test('scrapeConversation warns when the scroll loop hits its cap', async () => {
  const doc = makeDocument(TRANSCRIPT_HTML, { scrollable: true });
  // scrollTop assignment on the fake never settles at 0, so the loop runs to the cap.
  Object.defineProperty(doc.documentElement, 'scrollTop', {
    get: () => 300,
    set: () => {},
    configurable: true,
  });
  const conv = await scrapeConversation({
    document: doc,
    location: { href: 'https://chatgpt.com/c/abc' },
    waitMs: 0,
    maxIterations: 4,
  });
  assert.ok(conv.warnings.some((w) => /scroll attempts/.test(w)), conv.warnings.join(' | '));
  assert.equal(conv.messages.length, 2, 'messages are still returned after a capped scroll');
});

/* ------------------------------------------------------------------ */
/* Orchestrator                                                        */
/* ------------------------------------------------------------------ */

test('extractConversation prefers the API path', async () => {
  const conv = await extractConversation({
    fetch: fakeFetch([
      ['/api/auth/session', () => json({ accessToken: 'tok' })],
      ['/backend-api/conversation/', () => json(PAYLOAD)],
    ]),
    location: { origin: 'https://chatgpt.com', href: `https://chatgpt.com/c/${PAYLOAD.conversation_id}` },
    document: makeDocument(TRANSCRIPT_HTML),
    waitMs: 0,
  });
  assert.equal(conv.extractedVia, 'api');
  assert.equal(conv.model, 'gpt-4o');
  assert.equal(conv.messages.filter((m) => !m.hidden).length, 6);
});

test('extractConversation falls back to the DOM when the API 401s', async () => {
  const conv = await extractConversation({
    fetch: fakeFetch([
      ['/api/auth/session', () => json({}, 403)],
      ['/backend-api/conversation/', () => json({ detail: 'nope' }, 401)],
    ]),
    location: { origin: 'https://chatgpt.com', href: 'https://chatgpt.com/c/abc-1234-5678-90ab' },
    document: makeDocument(TRANSCRIPT_HTML, { title: 'Simple math' }),
    waitMs: 0,
    maxIterations: 2,
  });
  assert.equal(conv.extractedVia, 'dom');
  assert.equal(conv.messages.length, 2);
  assert.ok(conv.warnings.some((w) => /401/.test(w)));
});

test('extractConversation goes straight to the DOM for a /share/ link', async () => {
  const fetchImpl = fakeFetch([['/backend-api/conversation/', () => json(PAYLOAD)]]);
  const conv = await extractConversation({
    fetch: fetchImpl,
    location: { origin: 'https://chatgpt.com', href: 'https://chatgpt.com/share/abc-1234-5678-90ab' },
    document: makeDocument(TRANSCRIPT_HTML),
    waitMs: 0,
    maxIterations: 2,
  });
  assert.equal(conv.extractedVia, 'dom');
  assert.ok(!fetchImpl.calls.some((c) => c.url.includes('/backend-api/conversation/')));
  assert.ok(conv.warnings.some((w) => /Shared conversation link/.test(w)));
});

test('findEmbeddedPayload digs the conversation JSON out of a __NEXT_DATA__ script', () => {
  const embedded = { props: { pageProps: { serverResponse: { data: PAYLOAD } } } };
  const doc = makeDocument(
    `<html><body>${SHARE_TURNS}<script id="__NEXT_DATA__" type="application/json">`
    + `${JSON.stringify(embedded)}</script></body></html>`,
  );
  const found = findEmbeddedPayload(doc);
  assert.ok(found, 'payload found');
  assert.equal(found.current_node, 'n-a2');

  assert.equal(findEmbeddedPayload(makeDocument('<html><body><script>var x = 1;</script></body></html>')), null);
  assert.equal(findEmbeddedPayload(null), null);
});

test('a /share/ page with embedded JSON keeps full fidelity instead of scraping', async () => {
  const embedded = { props: { pageProps: { serverResponse: { data: PAYLOAD } } } };
  const conv = await extractConversation({
    fetch: fakeFetch([]),
    location: { origin: 'https://chatgpt.com', href: 'https://chatgpt.com/share/abc-1234-5678-90ab' },
    document: makeDocument(
      `<html><body>${SHARE_TURNS}<script id="__NEXT_DATA__">${JSON.stringify(embedded)}</script></body></html>`,
    ),
    waitMs: 0,
    maxIterations: 2,
  });
  assert.equal(conv.extractedVia, 'api');
  assert.equal(conv.model, 'gpt-4o');
  assert.equal(conv.createTime, PAYLOAD.create_time);
  assert.equal(conv.messages.length, 8);
  assert.ok(conv.warnings.some((w) => /embedded in the page/.test(w)));
});

test('extractConversation throws only when both paths yield nothing', async () => {
  await assert.rejects(
    () => extractConversation({
      fetch: fakeFetch([]),
      location: { origin: 'https://chatgpt.com', href: 'https://chatgpt.com/c/abc-1234-5678-90ab' },
      document: makeDocument('<main><p>no turns here</p></main>'),
      waitMs: 0,
      maxIterations: 1,
    }),
    /Could not read this conversation/,
  );
});

test('normalizeConversation repairs a malformed conversation', () => {
  const fixed = normalizeConversation({
    messages: [{ role: 'weird', text: null, contentType: 'nope' }, null, 'junk'],
  });
  assert.deepEqual(Object.keys(fixed).sort(), [...CONVERSATION_KEYS].sort());
  assert.equal(fixed.id, 'unknown');
  assert.equal(fixed.title, 'ChatGPT conversation');
  assert.equal(fixed.messages.length, 1);
  assert.equal(fixed.messages[0].role, 'assistant');
  assert.equal(fixed.messages[0].contentType, 'text');
  assert.equal(fixed.messages[0].text, '');
  assert.deepEqual(fixed.messages[0].attachments, []);
  assert.equal(fixed.messages[0].hidden, false);
});
