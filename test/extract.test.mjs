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
  getAccountId,
  pickAccountId,
  authHeaders,
  findEmbeddedPayload,
} from '../extension/src/lib/api-client.js';
import { extractConversation, normalizeConversation } from '../extension/src/lib/extract.js';
import {
  turnToMessage,
  collectTurns,
  scrapeConversation,
  harvestTurns,
  completenessReport,
  findScrollContainer,
  roleOf,
  turnIndex,
  turnKey,
} from '../extension/src/lib/dom-scrape.js';
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
  assert.equal(conv.model, 'gpt-5-6-thinking', 'model comes from the conversation default_model_slug');

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
  assert.ok(conv.warnings.some((w) => /read from the page itself/i.test(w)));
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
  assert.ok(conv.warnings.some((w) => /gave up rewinding|never scrolled fully/.test(w)), conv.warnings.join(' | '));
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
  assert.equal(conv.model, 'gpt-5-6-thinking');
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
  assert.equal(conv.model, 'gpt-5-6-thinking');
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

/* ------------------------------------------------------------------ */
/* Live-verified deltas (coordinator ran these against chatgpt.com)    */
/* ------------------------------------------------------------------ */

test('model comes from default_model_slug, falling back to the last assistant slug', () => {
  assert.equal(mapConversationPayload(PAYLOAD, {}).model, 'gpt-5-6-thinking');

  const noDefault = clone(PAYLOAD);
  delete noDefault.default_model_slug;
  assert.equal(mapConversationPayload(noDefault, {}).model, 'gpt-5-4-thinking');

  const blankDefault = clone(PAYLOAD);
  blankDefault.default_model_slug = '   ';
  assert.equal(mapConversationPayload(blankDefault, {}).model, 'gpt-5-4-thinking');

  const nothing = clone(PAYLOAD);
  delete nothing.default_model_slug;
  for (const id of Object.keys(nothing.mapping)) {
    const m = nothing.mapping[id].message;
    if (m && m.metadata) delete m.metadata.model_slug;
  }
  assert.equal(mapConversationPayload(nothing, {}).model, null);
});

test('execution_output renders as a plain fenced block, not as dumped JSON', () => {
  const msg = nodeToMessage(PAYLOAD.mapping['n-tool']);
  assert.equal(msg.contentType, 'code', 'not "other"');
  assert.equal(msg.role, 'tool');
  assert.equal(msg.authorName, 'python');
  assert.equal(msg.text, '```\n0.0041231\n```');
  assert.ok(!/content_type|"text":/.test(msg.text), 'the raw JSON envelope must not leak');
});

test('an empty execution_output collapses instead of emitting an empty fence', () => {
  const msg = nodeToMessage({
    id: 'x',
    message: {
      id: 'x',
      author: { role: 'tool', name: 'container.exec' },
      content: { content_type: 'execution_output', text: '   ' },
      metadata: {},
    },
  });
  assert.equal(msg.text, '');
  assert.equal(msg.hidden, true, 'nothing to show, so the renderer skips it');
});

test('an opaque recipient hash is labelled verbatim, not matched against an enum', () => {
  for (const recipient of ['python', 'web.run', 'container.exec', 't2uay3k.sj1i4kz']) {
    const msg = nodeToMessage({
      id: 'c',
      message: {
        id: 'c',
        author: { role: 'assistant' },
        recipient,
        channel: 'analysis',
        content: { content_type: 'code', language: 'json', text: '{"q": 1}' },
        metadata: {},
      },
    });
    assert.ok(msg.text.includes('tool call \u2192 `' + recipient + '`'), recipient);
    assert.ok(msg.text.includes('```json'));
  }
});

test('thoughts and reasoning_recap keep their text intact', () => {
  const recap = nodeToMessage({
    id: 'r',
    message: {
      id: 'r',
      author: { role: 'assistant' },
      content: { content_type: 'reasoning_recap', content: 'Considered three approaches, picked slicing.' },
      metadata: { model_slug: 'gpt-5-6-thinking' },
    },
  });
  assert.equal(recap.contentType, 'thoughts');
  assert.equal(recap.text, 'Considered three approaches, picked slicing.');
  assert.equal(recap.hidden, false, 'the renderer gates thoughts by contentType, not by hidden');
});

test('authHeaders sends Authorization AND X-Authorization, plus the account id', () => {
  assert.deepEqual(authHeaders('tok', 'acc-1'), {
    accept: 'application/json',
    authorization: 'Bearer tok',
    'x-authorization': 'Bearer tok',
    'chatgpt-account-id': 'acc-1',
  });
  assert.deepEqual(authHeaders(null, null), { accept: 'application/json' });
  assert.deepEqual(authHeaders(undefined), { accept: 'application/json' });
});

test('pickAccountId prefers a workspace account over the personal one', () => {
  assert.equal(pickAccountId({
    accounts: {
      default: { account: { account_id: 'personal-1', structure: 'personal' } },
      'ws-key': { account: { account_id: 'workspace-9', structure: 'workspace' } },
    },
    account_ordering: ['default', 'ws-key'],
  }), 'workspace-9');

  assert.equal(pickAccountId({
    accounts: { default: { account: { account_id: 'personal-1', structure: 'personal' } } },
    account_ordering: ['default'],
  }), 'personal-1');

  assert.equal(pickAccountId({}), null);
  assert.equal(pickAccountId(null), null);
  assert.equal(pickAccountId({ accounts: { a: {} } }), null);
});

test('getAccountId never throws, whatever the endpoint does', async () => {
  assert.equal(await getAccountId({
    fetch: fakeFetch([['/accounts/check/', () => json({
      accounts: { default: { account: { account_id: 'acc-42', structure: 'personal' } } },
      account_ordering: ['default'],
    })]]),
    location: { origin: 'https://chatgpt.com' },
  }), 'acc-42');

  assert.equal(await getAccountId({
    fetch: fakeFetch([['/accounts/check/', () => json({}, 500)]]),
    location: { origin: 'https://chatgpt.com' },
  }), null);

  assert.equal(await getAccountId({
    fetch: async () => { throw new Error('network down'); },
    location: { origin: 'https://chatgpt.com' },
  }), null);
});

test('a missing access token does NOT abort the API path - cookies alone are enough', async () => {
  const fetchImpl = fakeFetch([
    ['/api/auth/session', () => json({ WARNING_BANNER: null, user: {}, expires: '2026-09-01' })],
    ['/accounts/check/', () => json({}, 403)],
    ['/backend-api/conversation/', () => json(PAYLOAD)],
  ]);
  const conv = await extractViaApi({
    fetch: fetchImpl,
    location: { origin: 'https://chatgpt.com', href: 'https://chatgpt.com/c/' + PAYLOAD.conversation_id },
  });

  assert.equal(conv.extractedVia, 'api');
  assert.equal(conv.messages.length, 8, 'full transcript, no DOM fallback');
  const call = fetchImpl.calls.find((c) => c.url.includes('/backend-api/conversation/'));
  assert.ok(call, 'the conversation was still requested');
  assert.equal(call.init.headers.authorization, undefined);
  assert.equal(call.init.credentials, 'include', 'cookies carry the session');
  assert.ok(conv.warnings.some((w) => /session cookies only/.test(w)));
});

test('the workspace account id rides along on the conversation call', async () => {
  const fetchImpl = fakeFetch([
    ['/api/auth/session', () => json({ accessToken: 'tok-xyz' })],
    ['/accounts/check/v4-2023-04-27', () => json({
      accounts: { biz: { account: { account_id: 'workspace-9', structure: 'workspace' } } },
      account_ordering: ['biz'],
    })],
    ['/backend-api/conversation/', () => json(PAYLOAD)],
  ]);
  await extractViaApi({
    fetch: fetchImpl,
    location: { origin: 'https://chatgpt.com', href: 'https://chatgpt.com/c/' + PAYLOAD.conversation_id },
  });

  const call = fetchImpl.calls.find((c) => c.url.includes('/backend-api/conversation/'));
  assert.equal(call.init.headers.authorization, 'Bearer tok-xyz');
  assert.equal(call.init.headers['x-authorization'], 'Bearer tok-xyz');
  assert.equal(call.init.headers['chatgpt-account-id'], 'workspace-9');
});

test('a personal account with no workspace still exports (no account header required)', async () => {
  const fetchImpl = fakeFetch([
    ['/api/auth/session', () => json({ accessToken: 'tok' })],
    ['/accounts/check/', () => json({ accounts: {} })],
    ['/backend-api/conversation/', () => json(PAYLOAD)],
  ]);
  const conv = await extractViaApi({
    fetch: fetchImpl,
    location: { origin: 'https://chatgpt.com', href: 'https://chatgpt.com/c/' + PAYLOAD.conversation_id },
  });
  assert.equal(conv.messages.length, 8);
  const call = fetchImpl.calls.find((c) => c.url.includes('/backend-api/conversation/'));
  assert.equal(call.init.headers['chatgpt-account-id'], undefined);
});

test('a stale token that 401s is retried with cookies only instead of falling back to the DOM', async () => {
  let attempt = 0;
  const fetchImpl = fakeFetch([
    ['/api/auth/session', () => json({ accessToken: 'stale-token' })],
    ['/accounts/check/', () => json({
      accounts: { biz: { account: { account_id: 'workspace-9', structure: 'workspace' } } },
      account_ordering: ['biz'],
    })],
    ['/backend-api/conversation/', (_url, init) => {
      attempt += 1;
      if (init.headers.authorization || init.headers['chatgpt-account-id']) return json({ detail: 'expired' }, 401);
      return json(PAYLOAD);
    }],
  ]);

  const conv = await extractViaApi({
    fetch: fetchImpl,
    location: { origin: 'https://chatgpt.com', href: 'https://chatgpt.com/c/' + PAYLOAD.conversation_id },
  });

  assert.equal(attempt, 2, 'exactly one retry');
  assert.equal(conv.extractedVia, 'api');
  assert.equal(conv.messages.length, 8);
  assert.ok(conv.warnings.some((w) => /failed with 401/.test(w)));
});

test('a genuine failure is not retried forever and still surfaces to the caller', async () => {
  let attempts = 0;
  const fetchImpl = fakeFetch([
    ['/api/auth/session', () => json({ accessToken: 'tok' })],
    ['/accounts/check/', () => json({ accounts: {} })],
    ['/backend-api/conversation/', () => { attempts += 1; return json({ detail: 'gone' }, 401); }],
  ]);

  await assert.rejects(() => extractViaApi({
    fetch: fetchImpl,
    location: { origin: 'https://chatgpt.com', href: 'https://chatgpt.com/c/' + PAYLOAD.conversation_id },
  }), /401/);
  assert.equal(attempts, 2, 'one attempt plus one retry, then it gives up');
});

test('a 500 is not retried - only auth-shaped failures are', async () => {
  let attempts = 0;
  const fetchImpl = fakeFetch([
    ['/api/auth/session', () => json({ accessToken: 'tok' })],
    ['/accounts/check/', () => json({ accounts: {} })],
    ['/backend-api/conversation/', () => { attempts += 1; return json({ detail: 'boom' }, 500); }],
  ]);
  await assert.rejects(() => extractViaApi({
    fetch: fetchImpl,
    location: { origin: 'https://chatgpt.com', href: 'https://chatgpt.com/c/' + PAYLOAD.conversation_id },
  }), /500/);
  assert.equal(attempts, 1);
});

/* ------------------------------------------------------------------ */
/* Current DOM shape (measured live: <section data-turn>, no <article>) */
/* ------------------------------------------------------------------ */

/** One turn in the shape the site ships today: section + data-turn + data-turn-id,
 *  a LOCALISED sr-only speaker label, and no .markdown / .prose anywhere. */
function currentTurnHtml(index, role, body) {
  const label = role === 'user' ? 'Вы сказали:' : 'ChatGPT сказал:';
  return '<section data-testid="conversation-turn-' + index + '" data-turn="' + role + '"'
    + ' data-turn-id="uuid-' + index + '">'
    + '<h4 class="sr-only">' + label + '</h4>'
    + '<div class="fKQ0lq_Layout"><div class="WlXitW_TransitionGroupChild">'
    + '<div class="flex max-w-full flex-col">' + body + '</div></div></div>'
    + '<div class="flex"><button aria-label="Копировать">Копировать</button></div>'
    + '</section>';
}

const CURRENT_SHAPE_HTML = '<main id="main">'
  + currentTurnHtml(2, 'user', '<div class="text-message"><p>What is 2+2?</p></div>')
  + currentTurnHtml(3, 'assistant', '<p>It is <strong>4</strong>.</p>'
    + '<pre><div class="flex items-center">python</div><button>Copy code</button>'
    + '<code class="language-python">print(2 + 2)</code></pre>')
  + '</main>';

test('the current shape parses: section/data-turn/data-turn-id, no article, no .markdown', () => {
  const doc = makeDocument(CURRENT_SHAPE_HTML);

  assert.equal(doc.querySelectorAll('article').length, 0, 'fixture really has no <article>');
  assert.equal(doc.querySelectorAll('.markdown').length, 0, 'fixture really has no .markdown');
  assert.equal(doc.querySelectorAll('[data-message-author-role]').length, 0);

  const turns = collectTurns(doc);
  assert.equal(turns.length, 2);

  const [user, assistantTurn] = turns;
  assert.equal(roleOf(user), 'user', 'role comes from data-turn');
  assert.equal(roleOf(assistantTurn), 'assistant');
  assert.equal(turnKey(user), 'id:uuid-2');
  assert.equal(turnIndex(user), 2);

  const u = turnToMessage(user);
  assert.equal(u.id, 'uuid-2');
  assert.equal(u.role, 'user');
  assert.equal(u.text, 'What is 2+2?');

  const a = turnToMessage(assistantTurn);
  assert.equal(a.role, 'assistant');
  assert.match(a.text, /It is \*\*4\*\*\./);
  assert.match(a.text, /```python\nprint\(2 \+ 2\)\n```/, 'code survives without .markdown');
});

test('the localised sr-only speaker label never reaches the transcript', () => {
  const doc = makeDocument(CURRENT_SHAPE_HTML);
  const text = collectTurns(doc).map((t) => turnToMessage(t).text).join('\n');
  assert.ok(!/сказал/i.test(text), 'Russian label leaked: ' + text);
  assert.ok(!/said:/i.test(text));
  assert.ok(!/Копировать/i.test(text), 'localised copy button leaked');
});

test('role is never guessed from the localised label — unknown stays unknown and is counted', () => {
  const doc = makeDocument('<main><section data-testid="conversation-turn-9" data-turn-id="u-9">'
    + '<h4 class="sr-only">ChatGPT сказал:</h4><div><p>orphan turn</p></div></section></main>');
  const turn = collectTurns(doc)[0];
  assert.equal(roleOf(turn), null, 'no data-turn, no author-role attribute -> honestly unknown');

  const stats = {};
  const msg = turnToMessage(turn, stats);
  assert.equal(stats.unknownRoles, 1);
  assert.equal(msg.text, 'orphan turn');
});

test('the legacy article/.markdown shape still parses (older builds, share snapshots)', () => {
  const doc = makeDocument(TRANSCRIPT_HTML);
  const turns = collectTurns(doc);
  assert.equal(turns.length, 2);
  assert.equal(roleOf(turns[0]), 'user', 'falls back to data-message-author-role');
  const a = turnToMessage(turns[1]);
  assert.match(a.text, /It is \*\*4\*\*\./);
  assert.match(a.text, /```python/);
});

test('deepest text container skips hashed CSS-module wrappers', () => {
  const doc = makeDocument('<main>' + currentTurnHtml(4, 'assistant', '<p>only this</p>') + '</main>');
  const msg = turnToMessage(collectTurns(doc)[0]);
  assert.equal(msg.text, 'only this');
});

/* ------------------------------------------------------------------ */
/* Virtualisation: harvest while scrolling, then account for the gaps  */
/* ------------------------------------------------------------------ */

/**
 * A transcript that behaves like the real one: only a window of turns is mounted
 * at any scroll position, so no single read can ever see the whole conversation.
 */
function virtualisedDoc({ total = 101, turnHeight = 60, clientHeight = 400, overscan = 60 } = {}) {
  const sections = [];
  for (let i = 1; i <= total; i++) {
    const role = i % 2 === 1 ? 'user' : 'assistant';
    const html = currentTurnHtml(i, role, '<p>message ' + i + '</p>');
    sections.push(makeDocument(html).querySelector('section'));
  }
  const container = { scrollTop: 0, scrollHeight: total * turnHeight, clientHeight };
  const mounted = () => sections.filter((_, idx) => {
    const top = idx * turnHeight;
    return top >= container.scrollTop - overscan
      && top <= container.scrollTop + clientHeight + overscan;
  });
  const doc = {
    title: 'Long chat',
    scrollingElement: container,
    defaultView: { location: { href: 'https://chatgpt.com/c/long' } },
    querySelectorAll: (sel) => (/conversation-turn|data-turn|data-message/.test(sel)
      ? mounted().filter((el) => el.matches(sel))
      : []),
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
  };
  return { doc, container, mounted };
}

test('only a fraction of a long conversation is ever mounted at once', () => {
  const { doc, mounted } = virtualisedDoc();
  assert.ok(mounted().length < 12, 'window is small: ' + mounted().length);
  assert.equal(collectTurns(doc).length, mounted().length);
});

test('harvesting while scrolling captures ALL 101 turns, in order', async () => {
  const { doc } = virtualisedDoc({ total: 101 });
  const warnings = [];
  const { entries } = await harvestTurns(doc, { waitMs: 0, maxIterations: 10, warnings });

  assert.equal(entries.length, 101, 'captured ' + entries.length + ' of 101');
  assert.deepEqual(entries.map((e) => e.index).slice(0, 5), [1, 2, 3, 4, 5]);
  assert.equal(entries[0].message.text, 'message 1');
  assert.equal(entries[100].message.text, 'message 101');
  assert.equal(entries[0].message.role, 'user');
  assert.equal(entries[1].message.role, 'assistant');

  const report = completenessReport(entries);
  assert.deepEqual(report.missing, []);
  assert.deepEqual(report.warnings, [], 'a complete harvest must not cry wolf');
});

test('scrapeConversation returns the whole virtualised chat with no scary warning', async () => {
  const { doc } = virtualisedDoc({ total: 101 });
  const conv = await scrapeConversation({
    document: doc,
    location: { href: 'https://chatgpt.com/c/long' },
    waitMs: 0,
    maxIterations: 10,
  });
  assert.equal(conv.messages.length, 101);
  assert.equal(conv.extractedVia, 'dom');
  assert.ok(!conv.warnings.some((w) => /INCOMPLETE/.test(w)), conv.warnings.join(' | '));
  assert.ok(conv.warnings.some((w) => /read from the page itself/.test(w)));
});

test('a truncated scrape is reported LOUDLY, never returned as if complete', () => {
  // Exactly what the coordinator measured at rest: turn-2, 4, 12, 13 and nothing else.
  const entries = [2, 4, 12, 13].map((index, order) => ({ index, order, message: { text: 'x' } }));
  const report = completenessReport(entries);

  assert.equal(report.captured, 4);
  assert.equal(report.implied, 12);
  assert.deepEqual(report.missing, [3, 5, 6, 7, 8, 9, 10, 11]);
  assert.equal(report.warnings.length, 1);
  assert.match(report.warnings[0], /^INCOMPLETE EXPORT/);
  assert.match(report.warnings[0], /captured 4 of about 12 turns/);
  assert.match(report.warnings[0], /turn 3, 5, 6, 7, 8, 9, 10, 11/);
});

test('a transcript that starts at a high turn index warns about the missing head', () => {
  const entries = [40, 41, 42].map((index, order) => ({ index, order, message: { text: 'x' } }));
  const report = completenessReport(entries);
  assert.deepEqual(report.missing, []);
  assert.equal(report.warnings.length, 1);
  assert.match(report.warnings[0], /starts at turn 40, so roughly 39 earlier message/);
});

test('completenessReport stays quiet when turns carry no index at all', () => {
  const report = completenessReport([{ index: null, order: 0, message: {} }]);
  assert.equal(report.implied, null);
  assert.deepEqual(report.warnings, []);
});

test('a caller-supplied expected count catches truncation the indices cannot', async () => {
  const doc = makeDocument(CURRENT_SHAPE_HTML);
  const conv = await scrapeConversation({
    document: doc,
    location: { href: 'https://chatgpt.com/c/abc' },
    waitMs: 0,
    maxIterations: 2,
    expectedMessageCount: 101,
  });
  assert.equal(conv.messages.length, 2);
  assert.ok(conv.warnings.some((w) => /INCOMPLETE EXPORT — the conversation has 101 messages but only 2/.test(w)),
    conv.warnings.join(' | '));
});

test('findScrollContainer picks the larger of the two real scrollable candidates', () => {
  const doc = makeDocument('<main id="main"><div class="overflow-y-auto">'
    + currentTurnHtml(2, 'user', '<p>hi</p>') + '</div></main>');
  const main = doc.querySelector('main');
  const scroller = doc.querySelector('div');

  // Measured live: transcript div 4118/812, main#main 4066/760.
  main.scrollHeight = 4066; main.clientHeight = 760;
  scroller.scrollHeight = 4118; scroller.clientHeight = 812;

  assert.equal(findScrollContainer(doc), scroller, 'largest scrollable wins');

  // Flip the sizes: the decision must follow the measurement, not the selector order.
  main.scrollHeight = 9000;
  assert.equal(findScrollContainer(doc), main);
});

test('a page with nothing scrollable degrades to the scrolling element and warns', async () => {
  const doc = makeDocument(CURRENT_SHAPE_HTML);
  doc.scrollingElement = null;
  const conv = await scrapeConversation({
    document: doc,
    location: { href: 'https://chatgpt.com/c/abc' },
    waitMs: 0,
    maxIterations: 2,
  });
  assert.equal(conv.messages.length, 2, 'still returns what is on screen');
  assert.ok(conv.warnings.some((w) => /scroll container/.test(w)), conv.warnings.join(' | '));
});
