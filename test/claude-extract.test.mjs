/**
 * claude-extract.test.mjs — Agent D.
 *
 * Zero dependencies, `node --test`. Everything imported here must be pure:
 * no top-level `window` / `document` / `chrome` access.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseConversationId,
  isShareUrl,
  toUnixSeconds,
  isArtifactBlock,
  renderArtifact,
  renderContent,
  mapAttachments,
  flattenTree,
  buildBranch,
  nodeToMessages,
  mapConversationPayload,
  fence,
  listOrganizationIds,
  fetchConversation,
  ROOT_PARENT_UUID,
} from '../extensions/claude/src/lib/api-client.js';

import { normalizeConversation, normalizeMessage } from '../extensions/claude/src/lib/extract.js';

/* ------------------------------------------------------------------ */
/* Fixture: a realistic /api/organizations/<org>/chat_conversations/<id> */
/* response with a thinking block, an artifact, an attachment and a     */
/* branch that was abandoned after the user edited their second turn.   */
/* ------------------------------------------------------------------ */

const ORG = '11111111-1111-4111-8111-111111111111';
const CONV = '22222222-2222-4222-8222-222222222222';

const M1 = 'aaaaaaaa-0000-4000-8000-000000000001'; // human: first question + a file
const M2 = 'aaaaaaaa-0000-4000-8000-000000000002'; // assistant: thinking + prose
const M3 = 'aaaaaaaa-0000-4000-8000-000000000003'; // human: ABANDONED edit
const M4 = 'aaaaaaaa-0000-4000-8000-000000000004'; // assistant: reply to abandoned edit
const M5 = 'aaaaaaaa-0000-4000-8000-000000000005'; // human: the kept re-ask
const M6 = 'aaaaaaaa-0000-4000-8000-000000000006'; // assistant: artifact + tool call

function fixture() {
  return {
    uuid: CONV,
    name: 'Sorting a CSV in Python',
    summary: '',
    model: 'claude-sonnet-4-5-20250929',
    created_at: '2026-03-01T10:00:00.000000Z',
    updated_at: '2026-03-01T10:12:30.000000Z',
    current_leaf_message_uuid: M6,
    chat_messages: [
      // Deliberately NOT in chronological order: the walk must use parent links.
      {
        uuid: M4,
        parent_message_uuid: M3,
        sender: 'assistant',
        index: 3,
        created_at: '2026-03-01T10:04:00.000000Z',
        text: 'This branch was thrown away.',
        content: [{ type: 'text', text: 'This branch was thrown away.' }],
        attachments: [],
        files: [],
      },
      {
        uuid: M1,
        parent_message_uuid: ROOT_PARENT_UUID,
        sender: 'human',
        index: 0,
        created_at: '2026-03-01T10:00:00.000000Z',
        text: 'Sort this file by the third column.',
        content: [{ type: 'text', text: 'Sort this file by the third column.' }],
        attachments: [
          {
            id: 'file-1',
            file_name: 'sales.csv',
            file_type: 'text/csv',
            file_size: 2048,
            extracted_content: 'a,b,c\n1,2,3\n',
          },
        ],
        files: [
          {
            file_kind: 'image',
            file_name: 'screenshot.png',
            preview_url: '/api/files/xyz/preview',
            thumbnail_url: '/api/files/xyz/thumb',
          },
        ],
      },
      {
        uuid: M6,
        parent_message_uuid: M5,
        sender: 'assistant',
        index: 5,
        model: 'claude-sonnet-4-5-20250929',
        created_at: '2026-03-01T10:12:00.000000Z',
        text: '',
        content: [
          { type: 'text', text: 'Here you go.' },
          {
            type: 'tool_use',
            id: 'toolu_art_1',
            name: 'artifacts',
            input: {
              id: 'sort-csv',
              command: 'create',
              type: 'application/vnd.ant.code',
              language: 'python',
              title: 'sort_csv.py',
              content: 'import csv\n\nrows = sorted(csv.reader(open("sales.csv")), key=lambda r: r[2])\n',
            },
          },
          {
            type: 'tool_result',
            tool_use_id: 'toolu_art_1',
            name: 'artifacts',
            content: [{ type: 'text', text: 'OK' }],
            is_error: false,
          },
          {
            type: 'tool_use',
            id: 'toolu_repl_1',
            name: 'repl',
            input: { code: 'console.log(1)' },
          },
          {
            type: 'tool_result',
            tool_use_id: 'toolu_repl_1',
            name: 'repl',
            content: [{ type: 'text', text: '1' }],
          },
          { type: 'text', text: 'Let me know if you want it as a one-liner.' },
        ],
        attachments: [],
        files: [],
      },
      {
        uuid: M2,
        parent_message_uuid: M1,
        sender: 'assistant',
        index: 1,
        created_at: '2026-03-01T10:01:00.000000Z',
        text: '',
        content: [
          { type: 'thinking', thinking: 'The third column looks numeric, so I should cast it.' },
          { type: 'text', text: 'Sure — here is the plan:\n\n1. read\n2. sort\n3. write' },
        ],
        attachments: [],
        files: [],
      },
      {
        uuid: M3,
        parent_message_uuid: M1,
        sender: 'human',
        index: 2,
        created_at: '2026-03-01T10:03:00.000000Z',
        text: 'Actually never mind.',
        content: [{ type: 'text', text: 'Actually never mind.' }],
        attachments: [],
        files: [],
      },
      {
        uuid: M5,
        parent_message_uuid: M2,
        sender: 'human',
        index: 4,
        created_at: '2026-03-01T10:11:00.000000Z',
        text: 'Show me the script.',
        content: [{ type: 'text', text: 'Show me the script.' }],
        attachments: [],
        files: [],
      },
    ],
  };
}

const SOURCE_URL = `https://claude.ai/chat/${CONV}`;

/* ------------------------------------------------------------------ */
/* URL helpers                                                         */
/* ------------------------------------------------------------------ */

test('parseConversationId reads the uuid out of a claude.ai chat URL', () => {
  assert.equal(parseConversationId(SOURCE_URL), CONV);
  assert.equal(parseConversationId(`https://claude.ai/chat/${CONV}?foo=1#x`), CONV);
  assert.equal(
    parseConversationId(`https://claude.ai/project/${ORG}/chat/${CONV}`),
    CONV,
  );
  assert.equal(parseConversationId('https://claude.ai/new'), null);
  assert.equal(parseConversationId('https://claude.ai/recents'), null);
  assert.equal(parseConversationId(''), null);
  assert.equal(parseConversationId(null), null);
});

test('isShareUrl only matches snapshot links', () => {
  assert.equal(isShareUrl(`https://claude.ai/share/${CONV}`), true);
  assert.equal(isShareUrl(SOURCE_URL), false);
});

test('toUnixSeconds handles Claude ISO strings and epoch numbers', () => {
  assert.equal(toUnixSeconds('2026-03-01T10:00:00.000000Z'), 1772359200);
  assert.equal(toUnixSeconds(1772359200), 1772359200);
  assert.equal(toUnixSeconds(1772359200000), 1772359200);
  assert.equal(toUnixSeconds(null), null);
  assert.equal(toUnixSeconds('not a date'), null);
});

/* ------------------------------------------------------------------ */
/* Branch reconstruction                                               */
/* ------------------------------------------------------------------ */

test('buildBranch follows parent links to the current leaf and ignores hash order', () => {
  const payload = fixture();
  const branch = buildBranch(payload.chat_messages, payload.current_leaf_message_uuid);
  assert.deepEqual(branch.map((n) => n.uuid), [M1, M2, M5, M6]);
});

test('buildBranch never picks the abandoned branch', () => {
  const payload = fixture();
  const branch = buildBranch(payload.chat_messages, payload.current_leaf_message_uuid);
  const ids = branch.map((n) => n.uuid);
  assert.ok(!ids.includes(M3), 'abandoned user edit must not be exported');
  assert.ok(!ids.includes(M4), 'reply to the abandoned edit must not be exported');
});

test('buildBranch falls back to the newest deepest leaf when there is no current_leaf', () => {
  const payload = fixture();
  const branch = buildBranch(payload.chat_messages, null);
  assert.deepEqual(branch.map((n) => n.uuid), [M1, M2, M5, M6]);
});

test('buildBranch survives a cycle without hanging', () => {
  const nodes = [
    { uuid: 'a', parent_message_uuid: 'b', sender: 'human', content: [] },
    { uuid: 'b', parent_message_uuid: 'a', sender: 'assistant', content: [] },
  ];
  const branch = buildBranch(nodes, 'a');
  assert.ok(branch.length <= 2);
});

test('buildBranch sorts a flat, link-free list by index', () => {
  const nodes = [
    { uuid: 'b', index: 1, sender: 'assistant', created_at: '2026-01-01T00:00:01Z', content: [] },
    { uuid: 'a', index: 0, sender: 'human', created_at: '2026-01-01T00:00:00Z', content: [] },
  ];
  assert.deepEqual(buildBranch(nodes, null).map((n) => n.uuid), ['a', 'b']);
});

test('flattenTree turns a nested tree=True response into parent-linked nodes', () => {
  const nested = [
    {
      uuid: 'root',
      sender: 'human',
      content: [{ type: 'text', text: 'hi' }],
      children: [
        {
          uuid: 'kid',
          sender: 'assistant',
          content: [{ type: 'text', text: 'hello' }],
          children: [],
        },
      ],
    },
  ];
  const flat = flattenTree(nested);
  assert.equal(flat.length, 2);
  assert.equal(flat[1].parent_message_uuid, 'root');
  assert.ok(!('children' in flat[0]), 'children must be stripped from the flattened copy');
  assert.deepEqual(buildBranch(nested, 'kid').map((n) => n.uuid), ['root', 'kid']);
});

/* ------------------------------------------------------------------ */
/* Content blocks                                                      */
/* ------------------------------------------------------------------ */

test('renderContent passes text blocks through as Markdown, untouched', () => {
  const parts = renderContent([{ type: 'text', text: '**bold** and `code`\n\n| a | b |\n| - | - |' }]);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].kind, 'text');
  assert.equal(parts[0].text, '**bold** and `code`\n\n| a | b |\n| - | - |');
});

test('renderContent maps a thinking block to a thoughts part', () => {
  const parts = renderContent([{ type: 'thinking', thinking: 'hmm' }]);
  assert.deepEqual(parts.map((p) => p.kind), ['thoughts']);
  assert.equal(parts[0].text, 'hmm');
});

test('renderContent accepts a thinking block that uses `text` instead of `thinking`', () => {
  const parts = renderContent([{ type: 'thinking', text: 'hmm' }]);
  assert.deepEqual(parts.map((p) => p.kind), ['thoughts']);
});

test('renderContent keeps an unknown block type rather than dropping it', () => {
  const parts = renderContent([{ type: 'something_new', text: 'still content' }]);
  assert.deepEqual(parts.map((p) => p.kind), ['text']);
  assert.equal(parts[0].text, 'still content');
});

test('renderContent drops the artifact tool_result echo but keeps other tool results', () => {
  const parts = renderContent(fixture().chat_messages.find((m) => m.uuid === M6).content);
  const kinds = parts.map((p) => p.kind);
  assert.deepEqual(kinds, ['text', 'code', 'tool', 'tool', 'text']);
  assert.ok(!parts.some((p) => p.kind === 'tool' && /artifacts/.test(p.text)));
  assert.deepEqual(
    parts.filter((p) => p.kind === 'tool').map((p) => p.authorName),
    ['repl', 'repl'],
  );
});

test('renderContent marks an errored tool result', () => {
  const parts = renderContent([
    { type: 'tool_result', name: 'repl', is_error: true, content: [{ type: 'text', text: 'boom' }] },
  ]);
  assert.match(parts[0].text, /\(error\)/);
  assert.match(parts[0].text, /boom/);
});

/* ------------------------------------------------------------------ */
/* Artifacts                                                           */
/* ------------------------------------------------------------------ */

test('isArtifactBlock recognises the artifacts tool and nothing else', () => {
  assert.equal(isArtifactBlock({ type: 'tool_use', name: 'artifacts' }), true);
  assert.equal(isArtifactBlock({ type: 'tool_use', name: 'Artifacts' }), true);
  assert.equal(isArtifactBlock({ type: 'tool_use', name: 'repl' }), false);
  assert.equal(isArtifactBlock({ type: 'text', text: 'artifacts' }), false);
  assert.equal(isArtifactBlock(null), false);
});

test('renderArtifact emits a bold title line plus a fenced block with the language', () => {
  const block = fixture().chat_messages.find((m) => m.uuid === M6)
    .content.find((c) => c.name === 'artifacts');
  const art = renderArtifact(block);
  assert.equal(art.title, 'sort_csv.py');
  assert.equal(art.language, 'python');
  assert.match(art.text, /^\*\*Artifact: sort_csv\.py\*\*\n\n```python\n/);
  assert.match(art.text, /import csv/);
  assert.match(art.text, /```$/);
});

test('renderArtifact derives a language from the artifact mime type', () => {
  const md = renderArtifact({
    type: 'tool_use', name: 'artifacts',
    input: { title: 'Notes', type: 'text/markdown', content: '# hi' },
  });
  assert.match(md.text, /```markdown\n# hi\n```/);

  const react = renderArtifact({
    type: 'tool_use', name: 'artifacts',
    input: { title: 'App', type: 'application/vnd.ant.react', content: 'export default () => null;' },
  });
  assert.equal(react.language, 'jsx');
});

test('renderArtifact handles a command:update block that only carries new_str', () => {
  const art = renderArtifact({
    type: 'tool_use', name: 'artifacts',
    input: {
      title: 'sort_csv.py', command: 'update', language: 'python',
      old_str: 'r[2]', new_str: 'int(r[2])',
    },
  });
  assert.match(art.text, /Artifact \(updated\): sort_csv\.py/);
  assert.match(art.text, /int\(r\[2\]\)/);
  assert.match(art.text, /r\[2\]/);
});

test('renderArtifact returns null when there is nothing to render', () => {
  assert.equal(renderArtifact({ type: 'tool_use', name: 'artifacts', input: { title: 'x' } }), null);
});

test('fence widens the fence when the body already contains backticks', () => {
  assert.equal(fence('a', 'js'), '```js\na\n```');
  const out = fence('```\ninner\n```', 'md');
  assert.ok(out.startsWith('````md\n'), out);
  assert.ok(out.endsWith('\n````'), out);
});

/* ------------------------------------------------------------------ */
/* Attachments                                                         */
/* ------------------------------------------------------------------ */

test('mapAttachments maps documents to files and uploads to images', () => {
  const m1 = fixture().chat_messages.find((m) => m.uuid === M1);
  const atts = mapAttachments(m1, 'https://claude.ai');
  assert.equal(atts.length, 2);

  const doc = atts.find((a) => a.name === 'sales.csv');
  assert.equal(doc.type, 'file');
  assert.equal(doc.alt, 'text/csv');

  const img = atts.find((a) => a.name === 'screenshot.png');
  assert.equal(img.type, 'image');
  assert.equal(img.url, 'https://claude.ai/api/files/xyz/preview');
});

test('mapAttachments de-duplicates files repeated across files and files_v2', () => {
  const dup = { file_kind: 'image', file_name: 'a.png', preview_url: '/p' };
  const atts = mapAttachments({ files: [dup], files_v2: [{ ...dup }] }, 'https://claude.ai');
  assert.equal(atts.length, 1);
});

test('mapAttachments tolerates a message with no attachment fields', () => {
  assert.deepEqual(mapAttachments({}), []);
  assert.deepEqual(mapAttachments(null), []);
});

/* ------------------------------------------------------------------ */
/* Node -> Message[]                                                   */
/* ------------------------------------------------------------------ */

test('nodeToMessages splits thinking off into its own thoughts message', () => {
  const node = fixture().chat_messages.find((m) => m.uuid === M2);
  const msgs = nodeToMessages(node);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].contentType, 'thoughts');
  assert.equal(msgs[0].role, 'assistant');
  assert.equal(msgs[0].text, 'The third column looks numeric, so I should cast it.');
  assert.equal(msgs[1].contentType, 'text');
  assert.match(msgs[1].text, /^Sure — here is the plan:/);
  // Parts of one API message keep the source uuid, suffixed by position.
  assert.equal(msgs[0].id, M2);
  assert.equal(msgs[1].id, `${M2}#2`);
  assert.equal(msgs[0].createTime, toUnixSeconds('2026-03-01T10:01:00.000000Z'));
});

test('nodeToMessages keeps thoughts and tools unhidden so the renderer can gate them', () => {
  // markdown.js gates `hidden` behind includeSystem, and thoughts/tools behind
  // includeThoughts/includeTools. Hiding them would make those options inert.
  const msgs = nodeToMessages(fixture().chat_messages.find((m) => m.uuid === M6));
  for (const m of msgs) assert.equal(m.hidden, false, `${m.contentType} must not be hidden`);
});

test('nodeToMessages maps human to user and attaches files to the prose message', () => {
  const msgs = nodeToMessages(fixture().chat_messages.find((m) => m.uuid === M1), {
    origin: 'https://claude.ai',
  });
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].role, 'user');
  assert.equal(msgs[0].contentType, 'multimodal');
  assert.equal(msgs[0].attachments.length, 2);
});

test('nodeToMessages emits assistant/code for an artifact and tool for real tools', () => {
  const msgs = nodeToMessages(fixture().chat_messages.find((m) => m.uuid === M6));
  assert.deepEqual(
    msgs.map((m) => [m.role, m.contentType]),
    [
      ['assistant', 'text'],
      ['assistant', 'code'],
      ['tool', 'other'],
      ['tool', 'other'],
      ['assistant', 'text'],
    ],
  );
  assert.match(msgs[1].text, /```python/);
  assert.equal(msgs[2].authorName, 'repl');
  assert.equal(msgs[0].id, M6);
  assert.equal(msgs[1].id, `${M6}#2`);
});

test('nodeToMessages merges adjacent text blocks into a single turn', () => {
  const msgs = nodeToMessages({
    uuid: 'x', sender: 'assistant',
    content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }],
  });
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].text, 'one\n\ntwo');
});

test('nodeToMessages falls back to the legacy flat text field only when content is empty', () => {
  const withBoth = nodeToMessages({
    uuid: 'x', sender: 'human',
    text: 'LEGACY',
    content: [{ type: 'text', text: 'MODERN' }],
  });
  assert.equal(withBoth[0].text, 'MODERN');

  const legacyOnly = nodeToMessages({ uuid: 'y', sender: 'human', text: 'LEGACY', content: [] });
  assert.equal(legacyOnly[0].text, 'LEGACY');
});

test('nodeToMessages returns nothing for an empty message', () => {
  assert.deepEqual(nodeToMessages({ uuid: 'z', sender: 'human', text: '', content: [] }), []);
  assert.deepEqual(nodeToMessages(null), []);
});

/* ------------------------------------------------------------------ */
/* Whole-payload mapping                                               */
/* ------------------------------------------------------------------ */

test('mapConversationPayload produces a contract-shaped Conversation', () => {
  const convo = mapConversationPayload(fixture(), {
    sourceUrl: SOURCE_URL, conversationId: CONV, origin: 'https://claude.ai',
  });

  assert.equal(convo.id, CONV);
  assert.equal(convo.title, 'Sorting a CSV in Python');
  assert.equal(convo.model, 'claude-sonnet-4-5-20250929');
  assert.equal(convo.sourceUrl, SOURCE_URL);
  assert.equal(convo.extractedVia, 'api');
  assert.equal(convo.createTime, toUnixSeconds('2026-03-01T10:00:00.000000Z'));
  assert.equal(convo.updateTime, toUnixSeconds('2026-03-01T10:12:30.000000Z'));
  assert.ok(Array.isArray(convo.warnings));

  // Every key of the typedef is present on every message.
  const keys = ['id', 'role', 'authorName', 'createTime', 'contentType', 'text', 'attachments', 'hidden'];
  for (const m of convo.messages) {
    for (const k of keys) assert.ok(k in m, `message is missing "${k}"`);
    assert.equal(typeof m.text, 'string');
    assert.ok(Array.isArray(m.attachments));
    assert.equal(typeof m.hidden, 'boolean');
    assert.ok(['user', 'assistant', 'system', 'tool'].includes(m.role));
    assert.ok(['text', 'code', 'thoughts', 'multimodal', 'other'].includes(m.contentType));
  }
});

test('mapConversationPayload exports the active branch in chronological order', () => {
  const convo = mapConversationPayload(fixture(), { sourceUrl: SOURCE_URL });
  const spine = convo.messages.map((m) => `${m.role}:${m.contentType}`);
  assert.deepEqual(spine, [
    'user:multimodal',     // M1
    'assistant:thoughts',  // M2 thinking
    'assistant:text',      // M2 prose
    'user:text',           // M5
    'assistant:text',      // M6 prose
    'assistant:code',      // M6 artifact
    'tool:other',          // M6 repl call
    'tool:other',          // M6 repl result
    'assistant:text',      // M6 closing prose
  ]);
  const joined = convo.messages.map((m) => m.text).join('\n');
  assert.ok(!/thrown away/.test(joined), 'abandoned branch leaked into the export');
  assert.ok(!/never mind/.test(joined), 'abandoned branch leaked into the export');

  const times = convo.messages.map((m) => m.createTime);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] >= times[i - 1], 'not chronological');
});

test('mapConversationPayload warns that a branched conversation was pruned', () => {
  const convo = mapConversationPayload(fixture(), { sourceUrl: SOURCE_URL });
  assert.ok(
    convo.warnings.some((w) => /branch/i.test(w)),
    `expected a branch warning, got ${JSON.stringify(convo.warnings)}`,
  );
});

test('mapConversationPayload survives a garbage payload', () => {
  for (const bad of [null, undefined, {}, { chat_messages: 'nope' }, []]) {
    const convo = mapConversationPayload(bad, { sourceUrl: SOURCE_URL });
    assert.equal(typeof convo.id, 'string');
    assert.ok(convo.title);
    assert.deepEqual(convo.messages, []);
    assert.equal(convo.sourceUrl, SOURCE_URL);
  }
});

test('mapConversationPayload accepts `messages` when `chat_messages` is absent', () => {
  const p = fixture();
  const convo = mapConversationPayload(
    { ...p, chat_messages: undefined, messages: p.chat_messages },
    { sourceUrl: SOURCE_URL },
  );
  assert.ok(convo.messages.length > 0);
});

test('mapConversationPayload falls back to a per-message model', () => {
  const p = fixture();
  delete p.model;
  const convo = mapConversationPayload(p, { sourceUrl: SOURCE_URL });
  assert.equal(convo.model, 'claude-sonnet-4-5-20250929');
});

/* ------------------------------------------------------------------ */
/* Normalisation (the contract invariant)                              */
/* ------------------------------------------------------------------ */

test('normalizeConversation fills every key with null rather than omitting it', () => {
  const c = normalizeConversation({});
  assert.deepEqual(Object.keys(c).sort(), [
    'createTime', 'extractedVia', 'id', 'messages', 'model',
    'sourceUrl', 'title', 'updateTime', 'warnings',
  ]);
  assert.equal(c.id, 'unknown');
  assert.equal(c.title, 'Claude conversation');
  assert.equal(c.createTime, null);
  assert.equal(c.model, null);
  assert.deepEqual(c.messages, []);
  assert.deepEqual(c.warnings, []);
});

test('normalizeMessage clamps bogus roles and content types', () => {
  const m = normalizeMessage({ role: 'wizard', contentType: 'interpretive-dance', text: 42 });
  assert.equal(m.role, 'assistant');
  assert.equal(m.contentType, 'text');
  assert.equal(m.text, '');
  assert.deepEqual(m.attachments, []);
  assert.equal(m.hidden, false);
});

/* ------------------------------------------------------------------ */
/* Network plumbing (injected fetch — no real requests)                */
/* ------------------------------------------------------------------ */

function fakeFetch(routes) {
  const calls = [];
  // Longest pattern wins, so `/organizations/<id>/chat_conversations/...`
  // beats the bare `/api/organizations` route it is a superstring of.
  const patterns = Object.keys(routes).sort((a, b) => b.length - a.length);
  const fn = async (url) => {
    calls.push(url);
    const hit = patterns.find((k) => url.includes(k));
    if (!hit) return { ok: false, status: 404, json: async () => ({}) };
    const value = routes[hit];
    if (typeof value === 'number') return { ok: false, status: value, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => value };
  };
  fn.calls = calls;
  return fn;
}

test('listOrganizationIds prefers a chat org over an API-only org', async () => {
  const fetchFn = fakeFetch({
    '/api/organizations': [
      { uuid: 'api-only', capabilities: ['api'] },
      { uuid: 'chat-org', capabilities: ['chat', 'claude_pro'] },
    ],
  });
  assert.deepEqual(await listOrganizationIds({ fetch: fetchFn }), ['chat-org', 'api-only']);
});

test('listOrganizationIds falls back to /api/bootstrap memberships', async () => {
  const fetchFn = fakeFetch({
    '/api/organizations': 403,
    '/api/bootstrap': { account: { memberships: [{ organization: { uuid: ORG, capabilities: ['chat'] } }] } },
  });
  assert.deepEqual(await listOrganizationIds({ fetch: fetchFn }), [ORG]);
});

test('fetchConversation tries each org until one resolves the conversation', async () => {
  const payload = fixture();
  const fetchFn = fakeFetch({
    '/api/organizations': [
      { uuid: 'wrong-org', capabilities: ['chat'] },
      { uuid: ORG, capabilities: ['chat'] },
    ],
    [`/organizations/wrong-org/chat_conversations/${CONV}`]: 404,
    [`/organizations/${ORG}/chat_conversations/${CONV}`]: payload,
  });
  const got = await fetchConversation(CONV, { fetch: fetchFn });
  assert.equal(got.uuid, CONV);
  assert.ok(fetchFn.calls.some((u) => u.includes('tree=True')), 'tree=True must be requested');
  assert.ok(
    fetchFn.calls.some((u) => u.includes('rendering_mode=messages')),
    'rendering_mode=messages must be requested',
  );
});

test('fetchConversation throws the last error when no org resolves it', async () => {
  const fetchFn = fakeFetch({
    '/api/organizations': [{ uuid: ORG, capabilities: ['chat'] }],
    [`/organizations/${ORG}/chat_conversations/${CONV}`]: 401,
  });
  await assert.rejects(() => fetchConversation(CONV, { fetch: fetchFn }), /401/);
});
