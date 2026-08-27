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
  parseSnapshotId,
  isShareUrl,
  toUnixSeconds,
  isArtifactBlock,
  renderArtifact,
  renderFoldedArtifact,
  collectArtifacts,
  renderContent,
  mapAttachments,
  flattenTree,
  buildBranch,
  nodeToMessages,
  mapConversationPayload,
  extractedAttachmentText,
  fence,
  listOrganizationIds,
  readCookie,
  fetchConversation,
  fetchSnapshot,
  ROOT_PARENT_UUID,
} from '../extensions/claude/src/lib/api-client.js';

import {
  extractConversation,
  normalizeConversation,
  normalizeMessage,
} from '../extensions/claude/src/lib/extract.js';

// Agent A's fake DOM (shared test harness) — the real html2md converter runs
// underneath it, so the fallback path is exercised, not mocked.
import { makeDocument } from './fixtures/fake-dom.mjs';

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
  // The repl call and its result are now ONE paired part, not two.
  assert.deepEqual(kinds, ['text', 'code', 'tool', 'text']);
  assert.ok(!parts.some((p) => p.kind === 'tool' && /artifacts/.test(p.text)));
  assert.deepEqual(
    parts.filter((p) => p.kind === 'tool').map((p) => p.authorName),
    ['repl'],
  );
  const repl = parts.find((p) => p.kind === 'tool');
  assert.match(repl.text, /console\.log\(1\)/, 'the call must be rendered');
  assert.match(repl.text, /_Result:_/, 'the result must render with its call');
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

test('nodeToMessages folds in a flat `text` field that content[] does not already contain', () => {
  // An agent turn can put its final answer in `text` while content[] holds only
  // thinking and tool blocks — dropping `text` would lose the answer.
  const answerOnlyInText = nodeToMessages({
    uuid: 'x', sender: 'assistant',
    text: 'The answer is 42.',
    content: [{ type: 'thinking', thinking: 'counting' }],
  });
  assert.deepEqual(answerOnlyInText.map((m) => m.contentType), ['thoughts', 'text']);
  assert.equal(answerOnlyInText[1].text, 'The answer is 42.');

  const legacyOnly = nodeToMessages({ uuid: 'y', sender: 'human', text: 'LEGACY', content: [] });
  assert.equal(legacyOnly[0].text, 'LEGACY');
});

test('nodeToMessages does not duplicate text that is already a content block', () => {
  const msgs = nodeToMessages({
    uuid: 'x', sender: 'human',
    text: 'Same thing',
    content: [{ type: 'text', text: 'Same thing' }],
  });
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].text, 'Same thing');
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
    'tool:other',          // M6 repl call paired with its result
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

/* ------------------------------------------------------------------ */
/* End to end: extractConversation through both paths                  */
/* ------------------------------------------------------------------ */

/** A trimmed stand-in for claude.ai's rendered transcript. */
const CLAUDE_PAGE = `
<main>
  <div data-test-render-count="1">
    <div data-testid="user-message"><p>Sort this file by the third column.</p></div>
  </div>
  <div data-test-render-count="2">
    <div class="font-claude-response">
      <div data-testid="thinking-block"><p>Still weighing the options here.</p></div>
      <p>Here you go.</p>
      <pre><code class="language-python">import csv
</code></pre>
    </div>
  </div>
</main>`;

test('extractConversation returns the API result when the API works', async () => {
  const fetchFn = fakeFetch({
    '/api/organizations': [{ uuid: ORG, capabilities: ['chat'] }],
    [`/organizations/${ORG}/chat_conversations/${CONV}`]: fixture(),
  });
  const convo = await extractConversation({
    fetch: fetchFn,
    location: { href: SOURCE_URL, origin: 'https://claude.ai' },
  });
  assert.equal(convo.extractedVia, 'api');
  assert.equal(convo.title, 'Sorting a CSV in Python');
  assert.equal(convo.messages.length, 8);
});

test('extractConversation degrades to the page and warns when the API 403s', async () => {
  const fetchFn = fakeFetch({ '/api/organizations': 403, '/api/bootstrap': 403 });
  const doc = makeDocument(CLAUDE_PAGE, { title: 'Sorting a CSV - Claude', href: SOURCE_URL });
  const convo = await extractConversation({
    fetch: fetchFn,
    document: doc,
    location: { href: SOURCE_URL, origin: 'https://claude.ai' },
    scroll: false,
  });

  assert.equal(convo.extractedVia, 'dom');
  assert.ok(convo.warnings.some((w) => /403|API/i.test(w)), JSON.stringify(convo.warnings));
  assert.deepEqual(
    convo.messages.map((m) => [m.role, m.contentType]),
    [['user', 'text'], ['assistant', 'thoughts'], ['assistant', 'text']],
  );
  assert.equal(convo.messages[0].text, 'Sort this file by the third column.');
  assert.match(convo.messages[2].text, /```python/);
  assert.ok(!/weighing the options/.test(convo.messages[2].text), 'thinking leaked into the prose');
});

test('extractConversation throws only when both paths yield nothing', async () => {
  const fetchFn = fakeFetch({ '/api/organizations': 403, '/api/bootstrap': 403 });
  const doc = makeDocument('<main><p>nothing here</p></main>', { href: SOURCE_URL });
  await assert.rejects(
    () => extractConversation({
      fetch: fetchFn,
      document: doc,
      location: { href: SOURCE_URL, origin: 'https://claude.ai' },
      scroll: false,
    }),
    /Could not read this conversation/,
  );
});

test('extractConversation uses the snapshot endpoint for a /share/ link', async () => {
  const shareUrl = `https://claude.ai/share/${CONV}`;
  const fetchFn = fakeFetch({ [`/api/chat_snapshots/${CONV}`]: fixture() });
  const convo = await extractConversation({
    fetch: fetchFn, location: { href: shareUrl, origin: 'https://claude.ai' },
  });
  assert.equal(convo.extractedVia, 'api');
  assert.equal(convo.title, 'Sorting a CSV in Python');
  assert.equal(fetchFn.calls.length, 1, 'a share link needs exactly one request');
  assert.ok(!fetchFn.calls[0].includes('/api/organizations'), 'no org lookup for a share link');
});

test('extractConversation falls back to the page when the snapshot endpoint fails', async () => {
  const shareUrl = `https://claude.ai/share/${CONV}`;
  const fetchFn = fakeFetch({ [`/api/chat_snapshots/${CONV}`]: 404 });
  const doc = makeDocument(CLAUDE_PAGE, { href: shareUrl });
  const convo = await extractConversation({
    fetch: fetchFn, document: doc, location: { href: shareUrl, origin: 'https://claude.ai' }, scroll: false,
  });
  assert.equal(convo.extractedVia, 'dom');
  assert.ok(convo.warnings.some((w) => /Shared conversation link/.test(w)));
});

/* ------------------------------------------------------------------ */
/* Artifact folding across revisions and across turns                  */
/* ------------------------------------------------------------------ */

/** create in one turn, update in the next. */
function artifactBranch() {
  return [
    {
      uuid: 'a1', parent_message_uuid: ROOT_PARENT_UUID, sender: 'assistant',
      created_at: '2026-03-01T10:00:00Z',
      content: [
        { type: 'text', text: 'First draft:' },
        {
          type: 'tool_use', id: 't1', name: 'artifacts',
          input: {
            id: 'demo', command: 'create', type: 'application/vnd.ant.code',
            language: 'python', title: 'demo.py', content: 'x = 1\ny = 2\n',
            version_uuid: 'v1',
          },
        },
      ],
    },
    {
      uuid: 'a2', parent_message_uuid: 'a1', sender: 'human',
      created_at: '2026-03-01T10:01:00Z',
      content: [{ type: 'text', text: 'make x three' }],
    },
    {
      uuid: 'a3', parent_message_uuid: 'a2', sender: 'assistant',
      created_at: '2026-03-01T10:02:00Z',
      content: [
        {
          type: 'tool_use', id: 't2', name: 'artifacts',
          input: { id: 'demo', command: 'update', old_str: 'x = 1', new_str: 'x = 3', version_uuid: 'v2' },
        },
        { type: 'text', text: 'Done.' },
      ],
    },
  ];
}

test('collectArtifacts replays create then update into the final content', () => {
  const map = collectArtifacts(artifactBranch());
  const demo = map.get('demo');
  assert.equal(demo.content, 'x = 3\ny = 2\n');
  assert.equal(demo.title, 'demo.py');
  assert.equal(demo.language, 'python');
  assert.equal(demo.revisions, 2);
  assert.equal(demo.lastKey, 'a3|0', 'the artifact belongs to its last write');
});

test('collectArtifacts uses a function replacer so replacement patterns stay literal', () => {
  // '$&' and the other $-patterns inside new_str would corrupt the artifact if
  // the replacement were passed to String.replace as a plain string.
  const dollarAmp = String.fromCharCode(36, 38);
  const map = collectArtifacts([
    {
      uuid: 'm', sender: 'assistant',
      content: [
        {
          type: 'tool_use', name: 'artifacts',
          input: { id: 'a', command: 'create', content: 'const price = TOKEN;' },
        },
        {
          type: 'tool_use', name: 'artifacts',
          input: { id: 'a', command: 'update', old_str: 'TOKEN', new_str: `"${dollarAmp} cost"` },
        },
      ],
    },
  ]);
  assert.equal(map.get('a').content, `const price = "${dollarAmp} cost";`);
});

test('an artifact is rendered once, at its final revision, not per draft', () => {
  const convo = mapConversationPayload(
    { uuid: 'c', name: 'Artifacts', current_leaf_message_uuid: 'a3', chat_messages: artifactBranch() },
    { sourceUrl: 'https://claude.ai/chat/c' },
  );
  const codeMessages = convo.messages.filter((m) => m.contentType === 'code');
  assert.equal(codeMessages.length, 1, 'intermediate drafts must not be emitted');
  assert.match(codeMessages[0].text, /```python\nx = 3\ny = 2\n```/);
  assert.match(codeMessages[0].text, /\*\*Artifact: demo\.py\*\*/);
  assert.match(codeMessages[0].text, /Final version, after 1 revision\./);

  // It lands in the last assistant turn, where the final revision was written.
  assert.equal(convo.messages.indexOf(codeMessages[0]), convo.messages.length - 2);
});

test('renderFoldedArtifact derives the fence language from the artifact mime type', () => {
  const out = renderFoldedArtifact({
    content: '# Notes', title: 'Notes', type: 'text/markdown', language: null, revisions: 1,
  });
  assert.equal(out, '**Artifact: Notes**\n\n```markdown\n# Notes\n```');
});

test('renderFoldedArtifact returns null for an artifact with no content', () => {
  assert.equal(renderFoldedArtifact({ content: '   ', revisions: 1 }), null);
  assert.equal(renderFoldedArtifact(null), null);
});

/* ------------------------------------------------------------------ */
/* Other verified block types                                          */
/* ------------------------------------------------------------------ */

test('renderContent reads a thinking block written as `summaries` and flags cut_off', () => {
  const parts = renderContent([
    { type: 'thinking', summaries: [{ summary: 'step one' }, { summary: 'step two' }], cut_off: true },
  ]);
  assert.equal(parts[0].kind, 'thoughts');
  assert.equal(parts[0].text, 'step one\n\nstep two\n\n_(thinking was cut off)_');
});

test('renderContent renders a voice_note with its title', () => {
  const parts = renderContent([{ type: 'voice_note', title: 'Memo', text: 'buy milk' }]);
  assert.deepEqual(parts.map((p) => p.kind), ['text']);
  assert.equal(parts[0].text, '**Memo**\n\nbuy milk');
});

test('renderContent renders create_file as code and infers the language from the path', () => {
  const parts = renderContent([
    { type: 'tool_use', id: 'c1', name: 'create_file', input: { path: 'app/main.py', file_text: 'print(1)' } },
    { type: 'tool_result', tool_use_id: 'c1', name: 'create_file', content: [{ type: 'text', text: 'ok' }] },
  ]);
  assert.deepEqual(parts.map((p) => p.kind), ['code'], 'the "ok" result must be suppressed');
  assert.match(parts[0].text, /\*\*File written — `create_file`\*\*/);
  assert.match(parts[0].text, /_app\/main\.py_/);
  assert.match(parts[0].text, /```python\nprint\(1\)\n```/);
  assert.ok(!/_Result:_/.test(parts[0].text), 'the bare "ok" echo must not be shown');
});

test('renderContent keeps knowledge items in a tool_result instead of dropping them', () => {
  const parts = renderContent([
    {
      type: 'tool_result', name: 'web_search',
      content: [{ type: 'knowledge', title: 'A page', url: 'https://example.com', text: 'body text' }],
    },
  ]);
  assert.match(parts[0].text, /\[A page\]\(https:\/\/example\.com\)/);
  assert.match(parts[0].text, /body text/);
  assert.ok(!/```/.test(parts[0].text), 'a knowledge list is Markdown and must not be fenced');
});

/* ------------------------------------------------------------------ */
/* Organization discovery                                              */
/* ------------------------------------------------------------------ */

test('listOrganizationIds puts the bootstrap membership first', async () => {
  const fetchFn = fakeFetch({
    '/api/bootstrap': { account: { memberships: [{ organization: { uuid: 'boot-org' } }] } },
    '/api/organizations': [{ uuid: 'other-org', capabilities: ['chat'] }],
  });
  assert.deepEqual(await listOrganizationIds({ fetch: fetchFn }), ['boot-org', 'other-org']);
});

test('listOrganizationIds falls back to the lastActiveOrg cookie', async () => {
  const fetchFn = fakeFetch({ '/api/bootstrap': 403, '/api/organizations': 403 });
  const ids = await listOrganizationIds({
    fetch: fetchFn,
    cookie: `sessionKey=abc; lastActiveOrg=${ORG}; x=1`,
  });
  assert.deepEqual(ids, [ORG]);
});

test('readCookie picks the right value out of a jar and decodes it', () => {
  assert.equal(readCookie('lastActiveOrg', `a=1; lastActiveOrg=${ORG}; b=2`), ORG);
  assert.equal(readCookie('missing', 'a=1'), null);
  assert.equal(readCookie('a', ''), null);
  assert.equal(readCookie('a', 'a=hello%20world'), 'hello world');
});

test('fetchConversation asks for every branch and for full tool rendering', async () => {
  const fetchFn = fakeFetch({
    '/api/bootstrap': { account: { memberships: [{ organization: { uuid: ORG } }] } },
    [`/organizations/${ORG}/chat_conversations/${CONV}`]: fixture(),
  });
  await fetchConversation(CONV, { fetch: fetchFn });
  const convoCall = fetchFn.calls.find((u) => u.includes('chat_conversations'));
  for (const param of ['tree=True', 'rendering_mode=messages', 'render_all_tools=true']) {
    assert.ok(convoCall.includes(param), `missing ${param} in ${convoCall}`);
  }
});

test('fetchSnapshot unwraps a payload nested under `conversation`', async () => {
  const fetchFn = fakeFetch({ '/api/chat_snapshots/s1': { conversation: fixture() } });
  const got = await fetchSnapshot('s1', { fetch: fetchFn });
  assert.equal(got.uuid, CONV);
});

test('parseSnapshotId reads the id out of a share URL', () => {
  assert.equal(parseSnapshotId(`https://claude.ai/share/${CONV}`), CONV);
  assert.equal(parseSnapshotId(`https://claude.ai/chat/${CONV}`), null);
});

/* ------------------------------------------------------------------ */
/* Ground truth measured against the live claude.ai API                */
/* ------------------------------------------------------------------ */

test('a real account has a chat org AND an api-only org — never take orgs[0]', async () => {
  // Exact capability sets observed on a live account.
  const fetchFn = fakeFetch({
    '/api/organizations': [
      { uuid: 'api-org', capabilities: ['api', 'api_individual'] },
      { uuid: 'chat-org', capabilities: ['chat', 'claude_max'] },
    ],
  });
  const ids = await listOrganizationIds({ fetch: fetchFn });
  assert.equal(ids[0], 'chat-org', 'the chat-capable org must be tried first');
  assert.ok(ids.includes('api-org'), 'the api-only org stays as a last resort');
});

test('fetchConversation still resolves when the chat org is listed second', async () => {
  const fetchFn = fakeFetch({
    '/api/organizations': [
      { uuid: 'api-org', capabilities: ['api', 'api_individual'] },
      { uuid: 'chat-org', capabilities: ['chat', 'claude_max'] },
    ],
    '/organizations/api-org/chat_conversations/': 404,
    [`/organizations/chat-org/chat_conversations/${CONV}`]: fixture(),
  });
  const got = await fetchConversation(CONV, { fetch: fetchFn });
  assert.equal(got.uuid, CONV);
});

test('the lastActiveOrg cookie is tried before any request is made', async () => {
  const fetchFn = fakeFetch({
    [`/organizations/${ORG}/chat_conversations/${CONV}`]: fixture(),
  });
  await fetchConversation(CONV, { fetch: fetchFn, cookie: `lastActiveOrg=${ORG}` });
  assert.ok(
    fetchFn.calls[0].includes(`/organizations/${ORG}/chat_conversations/`),
    `expected the conversation to be the first request, got ${fetchFn.calls[0]}`,
  );
});

test('a message flagged truncated raises a warning', () => {
  const convo = mapConversationPayload({
    uuid: 'c',
    name: 'Truncated',
    chat_messages: [
      {
        uuid: 'm1', parent_message_uuid: ROOT_PARENT_UUID, sender: 'assistant',
        truncated: true, content: [{ type: 'text', text: 'half a sent' }],
      },
    ],
  }, { sourceUrl: SOURCE_URL });
  assert.ok(convo.warnings.some((w) => /truncated/i.test(w)), JSON.stringify(convo.warnings));
});

test('thinking flagged hidden or thinking_hidden is marked hidden', () => {
  for (const flag of ['hidden', 'thinking_hidden']) {
    const msgs = nodeToMessages({
      uuid: 'x', sender: 'assistant',
      content: [
        { type: 'thinking', thinking: 'private reasoning', [flag]: true },
        { type: 'text', text: 'visible answer' },
      ],
    });
    assert.equal(msgs[0].contentType, 'thoughts');
    assert.equal(msgs[0].hidden, true, `${flag} must set hidden`);
    assert.equal(msgs[1].hidden, false);
  }
});

test('thinking text is read from `thinking`, never from `text`', () => {
  // A thinking block that carries BOTH must use `thinking`.
  const parts = renderContent([
    { type: 'thinking', thinking: 'the real reasoning', text: '' },
  ]);
  assert.equal(parts[0].text, 'the real reasoning');
});

test('thinking truncated is reported the same way as cut_off', () => {
  const parts = renderContent([{ type: 'thinking', thinking: 'partial', truncated: true }]);
  assert.match(parts[0].text, /cut off/);
});

test('an unrecognised block type is exported and counted, never dropped', () => {
  const warnings = [];
  const parts = renderContent([
    { type: 'text', text: 'hello' },
    { type: 'some_future_block', payload: { a: 1 } },
    { type: 'another_new_one', input: { b: 2 } },
  ], { warnings });

  assert.equal(parts.length, 3, 'unknown blocks must still produce output');
  assert.match(parts[2].text, /"b": 2/, 'a block with an input must fall back to its input');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /2 content blocks of an unrecognised type/);
  assert.match(warnings[0], /some_future_block/);
  assert.match(warnings[0], /another_new_one/);
});

test('unknown blocks surface as a conversation warning end to end', () => {
  const convo = mapConversationPayload({
    uuid: 'c', name: 'Future',
    chat_messages: [{
      uuid: 'm1', parent_message_uuid: ROOT_PARENT_UUID, sender: 'assistant',
      content: [{ type: 'not_invented_yet', text: 'still readable' }],
    }],
  }, { sourceUrl: SOURCE_URL });
  assert.ok(convo.warnings.some((w) => /unrecognised type/.test(w)));
  assert.match(convo.messages[0].text, /still readable/);
});

test('attachments[] extracted_content is exported, not dropped', () => {
  const msgs = nodeToMessages(fixture().chat_messages.find((m) => m.uuid === M1), {
    origin: 'https://claude.ai',
  });
  // It merges into the user's own turn rather than becoming a separate message.
  assert.equal(msgs.length, 1);
  assert.match(msgs[0].text, /\*\*Attachment: sales\.csv\*\*/);
  assert.match(msgs[0].text, /```csv\na,b,c\n1,2,3\n```/);
});

test('extractedAttachmentText infers a fence language from the file name', () => {
  const out = extractedAttachmentText({
    attachments: [{ file_name: 'main.py', extracted_content: 'print(1)' }],
  });
  assert.equal(out[0], '**Attachment: main.py**\n\n```python\nprint(1)\n```');
});

test('a files[] entry with no URL yields no dead link', () => {
  // Exact shape observed live: no preview_url, no document_asset.
  const atts = mapAttachments({
    files: [{
      success: true, path: '/mnt/user-data/uploads/notes.txt', file_kind: 'blob',
      file_uuid: 'f1', file_name: 'notes.txt', size_bytes: 12, uuid: 'f1',
    }],
  }, 'https://claude.ai');
  assert.equal(atts.length, 1);
  assert.equal(atts[0].name, 'notes.txt');
  assert.equal(atts[0].type, 'file');
  assert.equal(atts[0].url, null, 'a missing URL must stay null, never a fabricated link');
});

test('an exactly-round message count warns about a possible silent limit', () => {
  const chat_messages = [];
  for (let i = 0; i < 20; i++) {
    chat_messages.push({
      uuid: `m${i}`,
      parent_message_uuid: i === 0 ? ROOT_PARENT_UUID : `m${i - 1}`,
      sender: i % 2 === 0 ? 'human' : 'assistant',
      content: [{ type: 'text', text: `turn ${i}` }],
    });
  }
  const convo = mapConversationPayload(
    { uuid: 'c', name: 'Long', current_leaf_message_uuid: 'm19', chat_messages },
    { sourceUrl: SOURCE_URL },
  );
  assert.equal(convo.messages.length, 20);
  assert.ok(convo.warnings.some((w) => /round number/.test(w)), JSON.stringify(convo.warnings));
});

test('a warning is emitted once, not once per message', () => {
  const chat_messages = [];
  for (let i = 0; i < 4; i++) {
    chat_messages.push({
      uuid: `m${i}`,
      parent_message_uuid: i === 0 ? ROOT_PARENT_UUID : `m${i - 1}`,
      sender: 'assistant', truncated: true,
      content: [{ type: 'text', text: 'x' }],
    });
  }
  const convo = mapConversationPayload(
    { uuid: 'c', name: 'T', current_leaf_message_uuid: 'm3', chat_messages },
    { sourceUrl: SOURCE_URL },
  );
  assert.equal(convo.warnings.filter((w) => /truncated/i.test(w)).length, 1);
});

/* ------------------------------------------------------------------ */
/* Markdown fidelity — the thing rivals get wrong                      */
/* ------------------------------------------------------------------ */

test('LaTeX, tables, footnotes and nested lists survive byte-exact on the API path', () => {
  const source = [
    'Inline math $E = mc^2$ and display math:',
    '',
    '$$\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}$$',
    '',
    '| Symbol | Meaning | Units |',
    '| --- | ---: | :---: |',
    '| $\\alpha$ | angle | rad |',
    '| $\\beta$ | `rate` | s^-1 |',
    '',
    '1. first',
    '   - nested *item*',
    '     - deeper `code`',
    '2. second[^1]',
    '',
    '> quoted **text** with a [link](https://example.com)',
    '',
    '[^1]: the footnote body',
  ].join('\n');

  const convo = mapConversationPayload({
    uuid: 'c', name: 'Fidelity',
    chat_messages: [{
      uuid: 'm1', parent_message_uuid: ROOT_PARENT_UUID, sender: 'assistant',
      content: [{ type: 'text', text: source }],
    }],
  }, { sourceUrl: SOURCE_URL });

  assert.equal(convo.messages.length, 1);
  assert.equal(convo.messages[0].text, source, 'the API path must not re-render text at all');
});

test('a code block inside an artifact keeps its exact bytes', () => {
  const code = 'def f(x):\n    return x ** 2  # <tag> & "quote" \\n\n';
  const convo = mapConversationPayload({
    uuid: 'c', name: 'Code',
    chat_messages: [{
      uuid: 'm1', parent_message_uuid: ROOT_PARENT_UUID, sender: 'assistant',
      content: [{
        type: 'tool_use', id: 't', name: 'artifacts',
        input: { id: 'a', command: 'create', language: 'python', title: 'f.py', content: code },
      }],
    }],
  }, { sourceUrl: SOURCE_URL });

  const body = convo.messages[0].text;
  assert.ok(body.includes(code.replace(/\n$/, '')), 'artifact bytes must survive unescaped');
  assert.ok(!body.includes('&lt;'), 'nothing may be HTML-escaped on the API path');
});

/* ------------------------------------------------------------------ */
/* Real tool traffic — shapes measured on a live claude.ai account     */
/* ------------------------------------------------------------------ */

/**
 * A `tool_use` block with the exact key set observed live. Extra keys are
 * present on purpose: the renderer must not choke on them.
 */
function toolUse(name, input, extra = {}) {
  return {
    start_timestamp: '2026-03-01T10:00:00.000000Z',
    stop_timestamp: '2026-03-01T10:00:02.000000Z',
    type: 'tool_use',
    id: `toolu_${name}`,
    name,
    input,
    message: null,
    integration_name: null,
    integration_icon_url: null,
    icon_name: null,
    display_content: null,
    tool_origin: null,
    is_mcp_app: false,
    ...extra,
  };
}

/** A `tool_result` block with the exact key set observed live. */
function toolResult(name, content, extra = {}) {
  return {
    start_timestamp: '2026-03-01T10:00:02.000000Z',
    stop_timestamp: '2026-03-01T10:00:03.000000Z',
    type: 'tool_result',
    tool_use_id: `toolu_${name}`,
    name,
    content,
    is_error: false,
    message: null,
    integration_name: null,
    integration_icon_url: null,
    icon_name: null,
    meta: null,
    tool_origin: null,
    display_content: null,
    ...extra,
  };
}

function onlyTool(parts) {
  const tools = parts.filter((p) => p.kind === 'tool' || p.kind === 'code');
  assert.equal(tools.length, 1, `expected exactly one tool part, got ${parts.length}`);
  return tools[0];
}

test('web_search renders the query and a linked source list, not fenced text', () => {
  const part = onlyTool(renderContent([
    toolUse('web_search', { query: 'markdown export chrome extension' }),
    toolResult('web_search', [
      { type: 'knowledge', title: 'First hit', url: 'https://a.example', text: 'alpha body' },
      { type: 'knowledge', title: 'Second hit', url: 'https://b.example', text: 'beta body' },
    ]),
  ]));
  assert.match(part.text, /\*\*Web search — `web_search`\*\*/);
  assert.match(part.text, /Query: `markdown export chrome extension`/);
  assert.match(part.text, /- \[First hit\]\(https:\/\/a\.example\)/);
  assert.match(part.text, /- \[Second hit\]\(https:\/\/b\.example\)/);
  assert.match(part.text, /alpha body/);
  assert.ok(!/```/.test(part.text), 'a source list is Markdown and must not be fenced');
  assert.equal(part.authorName, 'web_search');
});

test('web_fetch renders the URL it retrieved', () => {
  const part = onlyTool(renderContent([
    toolUse('web_fetch', { url: 'https://example.com/spec' }),
    toolResult('web_fetch', [{ type: 'text', text: 'the page body' }]),
  ]));
  assert.match(part.text, /\*\*Web fetch — `web_fetch`\*\*/);
  assert.match(part.text, /<https:\/\/example\.com\/spec>/);
  assert.match(part.text, /the page body/);
});

test('bash_tool renders the command as a shell block with its output', () => {
  const part = onlyTool(renderContent([
    toolUse('bash_tool', { command: 'ls -la /tmp', description: 'list the temp dir' }),
    toolResult('bash_tool', [{ type: 'text', text: 'total 0\ndrwxr-xr-x 2 root root' }]),
  ]));
  assert.match(part.text, /\*\*Shell — `bash_tool`\*\*/);
  assert.match(part.text, /list the temp dir/);
  assert.match(part.text, /```bash\nls -la \/tmp\n```/);
  assert.match(part.text, /_Result:_/);
  assert.match(part.text, /drwxr-xr-x/);
});

test('view renders the path and the line range', () => {
  const part = onlyTool(renderContent([
    toolUse('view', { path: '/repo/src/main.py', view_range: [10, 40], description: 'the handler' }),
    toolResult('view', [{ type: 'text', text: 'def handler():\n    pass' }]),
  ]));
  assert.match(part.text, /\*\*Viewed file — `view`\*\*/);
  assert.match(part.text, /Path: `\/repo\/src\/main\.py`/);
  assert.match(part.text, /Lines 10-40/);
  assert.match(part.text, /the handler/);
});

test('conversation_search and recent_chats render their parameters', () => {
  const search = onlyTool(renderContent([
    toolUse('conversation_search', { query: 'the deploy thread', max_results: 5 }),
  ]));
  assert.match(search.text, /Query: `the deploy thread`/);
  assert.match(search.text, /Max results: 5/);

  const recent = onlyTool(renderContent([toolUse('recent_chats', { n: 3 })]));
  assert.match(recent.text, /\*\*Recent chats — `recent_chats`\*\*/);
  assert.match(recent.text, /Most recent 3/);
});

test('present_files renders the paths as a list', () => {
  const part = onlyTool(renderContent([
    toolUse('present_files', { filepaths: ['/out/report.md', '/out/data.csv'] }),
  ]));
  assert.match(part.text, /- `\/out\/report\.md`/);
  assert.match(part.text, /- `\/out\/data\.csv`/);
});

test('visualize:read_me renders its module list', () => {
  const part = onlyTool(renderContent([
    toolUse('visualize:read_me', { modules: ['chart', 'table'] }),
  ]));
  assert.match(part.text, /Modules: `chart`, `table`/);
});

test('create_file is first-class: visible code, path label, inferred language', () => {
  const parts = renderContent([
    toolUse('create_file', {
      description: 'the entry point',
      path: 'src/app/main.py',
      file_text: 'def main():\n    print("hi")\n',
    }),
    toolResult('create_file', [{ type: 'text', text: 'ok' }]),
  ]);
  assert.deepEqual(parts.map((p) => p.kind), ['code'], 'a written file is content, not plumbing');
  assert.equal(parts[0].authorName, null, 'content tools are not attributed to a tool author');
  assert.match(parts[0].text, /\*\*File written — `create_file`\*\*/);
  assert.match(parts[0].text, /the entry point/);
  assert.match(parts[0].text, /_src\/app\/main\.py_/);
  assert.match(parts[0].text, /```python\ndef main\(\):\n    print\("hi"\)\n```/);
});

test('create_file survives all the way to a Conversation as a visible code message', () => {
  const convo = mapConversationPayload({
    uuid: 'c', name: 'Wrote a file',
    chat_messages: [{
      uuid: 'm1', parent_message_uuid: ROOT_PARENT_UUID, sender: 'assistant',
      created_at: '2026-03-01T10:00:00Z',
      content: [
        { type: 'text', text: 'Here is the script.' },
        toolUse('create_file', { path: 'run.sh', file_text: '#!/bin/sh\necho hi\n' }),
        toolResult('create_file', [{ type: 'text', text: 'ok' }]),
      ],
    }],
  }, { sourceUrl: SOURCE_URL });

  assert.deepEqual(
    convo.messages.map((m) => [m.role, m.contentType]),
    [['assistant', 'text'], ['assistant', 'code']],
  );
  // Visible by default: not gated behind includeTools, not hidden.
  assert.equal(convo.messages[1].hidden, false);
  assert.match(convo.messages[1].text, /```bash\n#!\/bin\/sh\necho hi\n```/);
});

test('an unknown tool degrades to a readable summary, never a raw JSON dump', () => {
  const part = onlyTool(renderContent([
    toolUse('message_compose_v1', {
      recipient: 'team@example.com',
      subject: 'Weekly update',
      draft_id: 42,
      send_immediately: false,
    }),
    toolResult('message_compose_v1', [{ type: 'text', text: 'draft saved' }]),
  ]));
  assert.match(part.text, /\*\*Tool — `message_compose_v1`\*\*/);
  assert.match(part.text, /- \*\*Recipient:\*\* `team@example\.com`/);
  assert.match(part.text, /- \*\*Subject:\*\* `Weekly update`/);
  assert.match(part.text, /- \*\*Draft id:\*\* 42/);
  assert.match(part.text, /draft saved/);
  assert.ok(!/^\{/m.test(part.text), 'the input must not be dumped as raw JSON');
});

test('an unknown tool with a long string input promotes it to a fenced block', () => {
  const body = 'x'.repeat(400);
  const part = onlyTool(renderContent([toolUse('ask_user_input_v0', { prompt: body })]));
  assert.match(part.text, /_Prompt:_/);
  assert.match(part.text, /```\nx{400}\n```/);
});

test('an unknown tool with no input at all still renders a line', () => {
  const part = onlyTool(renderContent([toolUse('mystery_tool', {})]));
  assert.match(part.text, /\*\*Tool — `mystery_tool`\*\*/);
});

test('is_error is called out on the heading and the result', () => {
  const part = onlyTool(renderContent([
    toolUse('bash_tool', { command: 'exit 1' }),
    toolResult('bash_tool', [{ type: 'text', text: 'command failed' }], { is_error: true }),
  ]));
  assert.match(part.text, /`bash_tool` · failed\*\*/);
  assert.match(part.text, /_Result \(error\):_/);
  assert.match(part.text, /command failed/);
});

test('an errored content tool still shows its result', () => {
  const parts = renderContent([
    toolUse('create_file', { path: 'a.txt', file_text: 'x' }),
    toolResult('create_file', [{ type: 'text', text: 'permission denied' }], { is_error: true }),
  ]);
  assert.match(parts[0].text, /permission denied/);
});

test('MCP and integration tools are labelled by their integration name', () => {
  const part = onlyTool(renderContent([
    toolUse('search_issues', { query: 'bug' }, {
      integration_name: 'Linear', is_mcp_app: true, tool_origin: 'mcp',
    }),
  ]));
  assert.match(part.text, /`Linear · search_issues`/);
  assert.match(part.text, /· MCP/);
  assert.equal(part.authorName, 'Linear');
});

test('local_resource result items are rendered, not dropped', () => {
  const part = onlyTool(renderContent([
    toolUse('view', { path: '/a' }),
    toolResult('view', [
      { type: 'local_resource', name: 'notes.md', text: 'the note body' },
    ]),
  ]));
  assert.match(part.text, /- \*\*notes\.md\*\*/);
  assert.match(part.text, /the note body/);
});

test('an unrecognised tool_result content element is counted and warned about', () => {
  const warnings = [];
  const part = onlyTool(renderContent([
    toolUse('web_search', { query: 'q' }),
    toolResult('web_search', [{ type: 'brand_new_kind', text: 'still readable' }]),
  ], { warnings }));
  assert.match(part.text, /still readable/, 'unknown result items must not vanish');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /tool_result\.content\[brand_new_kind\]/);
});

test('a tool_result in a LATER message still pairs with its call', () => {
  const convo = mapConversationPayload({
    uuid: 'c', name: 'Split tool',
    current_leaf_message_uuid: 'm2',
    chat_messages: [
      {
        uuid: 'm1', parent_message_uuid: ROOT_PARENT_UUID, sender: 'assistant',
        created_at: '2026-03-01T10:00:00Z',
        content: [toolUse('bash_tool', { command: 'echo hi' })],
      },
      {
        uuid: 'm2', parent_message_uuid: 'm1', sender: 'assistant',
        created_at: '2026-03-01T10:00:05Z',
        content: [
          toolResult('bash_tool', [{ type: 'text', text: 'hi' }]),
          { type: 'text', text: 'Done.' },
        ],
      },
    ],
  }, { sourceUrl: SOURCE_URL });

  const tools = convo.messages.filter((m) => m.role === 'tool');
  assert.equal(tools.length, 1, 'the result must not render a second time on its own');
  assert.match(tools[0].text, /echo hi/);
  assert.match(tools[0].text, /_Result:_/);
  assert.ok(convo.messages.some((m) => m.text === 'Done.'));
});

test('an orphan tool_result with no matching call still renders', () => {
  const part = onlyTool(renderContent([
    toolResult('web_fetch', [{ type: 'text', text: 'orphaned output' }]),
  ]));
  assert.match(part.text, /`web_fetch`/);
  assert.match(part.text, /orphaned output/);
});

test('display_content is used when an unknown tool input yields nothing', () => {
  const part = onlyTool(renderContent([
    toolUse('opaque_tool', {}, { display_content: 'Claude’s own rendering' }),
  ]));
  assert.match(part.text, /Claude’s own rendering/);
});

test('tool traffic stays gated behind includeTools, not includeSystem', () => {
  const convo = mapConversationPayload({
    uuid: 'c', name: 'Tools',
    chat_messages: [{
      uuid: 'm1', parent_message_uuid: ROOT_PARENT_UUID, sender: 'assistant',
      content: [
        toolUse('web_search', { query: 'q' }),
        toolResult('web_search', [{ type: 'text', text: 'r' }]),
      ],
    }],
  }, { sourceUrl: SOURCE_URL });
  const tool = convo.messages.find((m) => m.role === 'tool');
  assert.equal(tool.hidden, false, 'hidden would require includeSystem and make includeTools inert');
  assert.equal(tool.contentType, 'other');
});

test('the whole measured tool roster renders without throwing or dumping JSON', () => {
  const roster = [
    ['web_search', { query: 'q' }],
    ['message_compose_v1', { subject: 's' }],
    ['view', { path: '/p', view_range: [1, 2] }],
    ['web_fetch', { url: 'https://e.example' }],
    ['bash_tool', { command: 'ls' }],
    ['conversation_search', { query: 'q', max_results: 3 }],
    ['present_files', { filepaths: ['/a'] }],
    ['ask_user_input_v0', { prompt: 'pick one' }],
    ['recent_chats', { n: 2 }],
    ['create_file', { path: 'a.py', file_text: 'pass' }],
    ['visualize:read_me', { modules: ['m'] }],
  ];
  for (const [name, input] of roster) {
    const parts = renderContent([toolUse(name, input)]);
    assert.equal(parts.length, 1, `${name} produced ${parts.length} parts`);
    assert.ok(parts[0].text.includes(name) || parts[0].text.includes('File written'),
      `${name} is not identifiable in its output`);
    assert.ok(!/^\s*\{\s*$/m.test(parts[0].text), `${name} fell through to a raw JSON dump`);
  }
});

test('artifact folding still works for older conversations', () => {
  // Regression guard: the legacy path must survive the tool-renderer rewrite.
  const map = collectArtifacts(artifactBranch());
  assert.equal(map.get('demo').content, 'x = 3\ny = 2\n');
});
