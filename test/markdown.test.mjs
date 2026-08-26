import test from 'node:test';
import assert from 'node:assert/strict';

import {
  toMarkdown,
  DEFAULT_OPTIONS,
  EXPORTER_VERSION,
} from '../shared/lib/markdown.js';
import { buildFilename, slugify } from '../shared/lib/filename.js';

const NOW = '2026-08-26T12:00:00Z';

/** A Conversation per CONTRACT.md with every optional field filled in. */
function conv(overrides = {}) {
  return {
    id: '6f1c0f2a-0000-4000-8000-abcdefabcdef',
    title: 'Some chat title',
    createTime: 1774519451, // 2026-03-26T10:04:11Z
    updateTime: 1774523451,
    model: 'gpt-4o',
    sourceUrl: 'https://chatgpt.com/c/6f1c0f2a-0000-4000-8000-abcdefabcdef',
    extractedVia: 'api',
    messages: [],
    warnings: [],
    ...overrides,
  };
}

/** A Message per CONTRACT.md. */
function msg(overrides = {}) {
  return {
    id: 'm1',
    role: 'user',
    authorName: null,
    createTime: 1774519451,
    contentType: 'text',
    text: 'hello',
    attachments: [],
    hidden: false,
    ...overrides,
  };
}

/** Everything-null Conversation, the contract invariant. */
const EMPTY = {
  id: 'unknown',
  title: 'ChatGPT conversation',
  createTime: null,
  updateTime: null,
  model: null,
  sourceUrl: '',
  extractedVia: 'dom',
  messages: [],
  warnings: [],
};

/* ------------------------------------------------------------------ *
 * defaults & invariants
 * ------------------------------------------------------------------ */

test('DEFAULT_OPTIONS matches the contract', () => {
  assert.deepEqual({ ...DEFAULT_OPTIONS }, {
    frontmatter: true,
    timestamps: false,
    includeSystem: false,
    includeTools: false,
    includeThoughts: false,
    headingStyle: 'h2',
    userLabel: 'You',
    assistantLabel: 'ChatGPT',
  });
});

test('empty conversation: does not throw, emits no null values', () => {
  const out = toMarkdown(EMPTY, { now: NOW });
  assert.match(out, /^---\n/);
  assert.doesNotMatch(out, /: null/);
  assert.doesNotMatch(out, /^(created|updated|model|source):/m);
  assert.match(out, /^messages: 0$/m);
  assert.match(out, /^# ChatGPT conversation$/m);
  assert.equal(out.endsWith('\n'), true);
  assert.equal(out.endsWith('\n\n'), false);
});

test('never throws on hostile input', () => {
  for (const input of [null, undefined, {}, { messages: null }, { messages: [null, 1, 'x'] }]) {
    assert.equal(typeof toMarkdown(input, { now: NOW }), 'string');
  }
  assert.equal(typeof toMarkdown(EMPTY, null), 'string');
  assert.equal(typeof toMarkdown(EMPTY, { headingStyle: 'nonsense' }), 'string');
});

test('always ends in exactly one newline', () => {
  const out = toMarkdown(conv({ messages: [msg({ text: 'trailing\n\n\n\n' })] }), { now: NOW });
  assert.equal(out.endsWith('x\n') || out.endsWith('g\n'), true);
  assert.equal(/\n\n$/.test(out), false);
});

/* ------------------------------------------------------------------ *
 * frontmatter
 * ------------------------------------------------------------------ */

test('frontmatter has the documented shape', () => {
  const out = toMarkdown(conv({ messages: [msg(), msg({ role: 'assistant', text: 'hi' })] }), {
    now: NOW,
  });
  const block = out.slice(0, out.indexOf('\n---', 4) + 4);
  assert.match(block, /^---\ntitle: "Some chat title"\n/);
  assert.match(block, /^source: "https:\/\/chatgpt\.com\/c\/[0-9a-f-]+"$/m);
  assert.match(block, /^model: "gpt-4o"$/m);
  assert.match(block, /^created: 2026-03-26T10:04:11Z$/m);
  assert.match(block, /^updated: 2026-03-26T11:10:51Z$/m);
  assert.match(block, /^messages: 2$/m);
  assert.match(block, new RegExp(`^exported: ${NOW}$`, 'm'));
  assert.match(block, new RegExp(`^exported_with: "Chat2MD v${EXPORTER_VERSION}"$`, 'm'));
});

test('frontmatter escapes quotes, backslashes, newlines', () => {
  const out = toMarkdown(
    conv({ title: 'He said "hi"\\ok\nsecond line', messages: [] }),
    { now: NOW },
  );
  assert.match(out, /^title: "He said \\"hi\\"\\\\ok\\nsecond line"$/m);
  // and the H1 stays on one line
  assert.match(out, /^# He said "hi"\\ok second line$/m);
});

test('frontmatter can be turned off', () => {
  const out = toMarkdown(conv({ messages: [msg()] }), { frontmatter: false, now: NOW });
  assert.equal(out.startsWith('# Some chat title'), true);
  assert.doesNotMatch(out, /exported_with/);
});

test('message count in frontmatter reflects what was actually rendered', () => {
  const c = conv({
    messages: [msg(), msg({ role: 'system', text: 'sys', hidden: true }), msg({ role: 'tool' })],
  });
  assert.match(toMarkdown(c, { now: NOW }), /^messages: 1$/m);
  assert.match(
    toMarkdown(c, { now: NOW, includeSystem: true, includeTools: true }),
    /^messages: 3$/m,
  );
});

/* ------------------------------------------------------------------ *
 * body passthrough
 * ------------------------------------------------------------------ */

test('code fences pass through untouched, language and blank lines intact', () => {
  const code = [
    'Here:',
    '',
    '```python',
    'def f(x):',
    '',
    '',
    '',
    '    return x  # two  spaces  kept',
    '```',
    '',
    'done',
  ].join('\n');
  const out = toMarkdown(conv({ messages: [msg({ role: 'assistant', text: code })] }), {
    now: NOW,
  });
  assert.match(out, /```python\ndef f\(x\):\n\n\n\n    return x  # two  spaces  kept\n```/);
});

test('markdown is never escaped or re-wrapped', () => {
  const text = [
    '| a | b |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    '$$\\int_0^1 x^2\\,dx$$',
    '',
    '- one',
    '  - nested *emphasis* and `code`',
  ].join('\n');
  const out = toMarkdown(conv({ messages: [msg({ role: 'assistant', text })] }), { now: NOW });
  assert.equal(out.includes(text), true);
});

test('blank lines outside fences collapse to at most two', () => {
  const out = toMarkdown(
    conv({ messages: [msg({ text: 'a\n\n\n\n\n\nb' })] }),
    { now: NOW, frontmatter: false },
  );
  assert.equal(out.includes('a\n\n\nb'), true);
  assert.equal(out.includes('a\n\n\n\nb'), false);
});

test('trailing whitespace is stripped but a two-space hard break survives', () => {
  const out = toMarkdown(
    conv({ messages: [msg({ text: 'line one  \nline two   \t\nline three' })] }),
    { now: NOW, frontmatter: false },
  );
  assert.equal(out.includes('line one  \nline two  \nline three'), true);
});

test('an unterminated code fence is closed', () => {
  const out = toMarkdown(
    conv({ messages: [msg({ role: 'assistant', text: '```js\nconst a = 1;' })] }),
    { now: NOW, frontmatter: false },
  );
  assert.equal(out.includes('```js\nconst a = 1;\n```'), true);
});

test('cyrillic survives the renderer', () => {
  const out = toMarkdown(
    conv({ title: 'Привет мир', messages: [msg({ text: 'Как дела, друг?' })] }),
    { now: NOW },
  );
  assert.match(out, /^title: "Привет мир"$/m);
  assert.equal(out.includes('Как дела, друг?'), true);
});

/* ------------------------------------------------------------------ *
 * heading disambiguation
 * ------------------------------------------------------------------ */

test('h2 headings by default, bold headings on request', () => {
  const c = conv({ messages: [msg(), msg({ role: 'assistant', text: 'hi' })] });
  const h2 = toMarkdown(c, { now: NOW });
  assert.match(h2, /^## You$/m);
  assert.match(h2, /^## ChatGPT$/m);

  const bold = toMarkdown(c, { now: NOW, headingStyle: 'bold' });
  assert.match(bold, /^\*\*You\*\*$/m);
  assert.match(bold, /^\*\*ChatGPT\*\*$/m);
  assert.doesNotMatch(bold, /^## You$/m);
});

test('a body containing "## You" makes every turn boundary an explicit rule', () => {
  const c = conv({
    messages: [
      msg({ text: 'quote:\n\n## You\n\nfake' }),
      msg({ role: 'assistant', text: 'real answer' }),
    ],
  });
  const out = toMarkdown(c, { now: NOW, frontmatter: false });
  // exactly one separator: between the two turns, never before the first
  const rules = out.split('\n').filter((l) => l === '---');
  assert.equal(rules.length, 1);
  assert.match(out, /\n---\n\n## ChatGPT\n/);
});

test('a "## comment" inside a code fence does not trigger separators', () => {
  const c = conv({
    messages: [
      msg({ role: 'assistant', text: '```bash\n## You are here\necho hi\n```' }),
      msg({ text: 'ok' }),
    ],
  });
  const out = toMarkdown(c, { now: NOW, frontmatter: false });
  assert.equal(out.split('\n').filter((l) => l === '---').length, 0);
});

test('custom labels are honoured', () => {
  const out = toMarkdown(conv({ messages: [msg(), msg({ role: 'assistant', text: 'hi' })] }), {
    now: NOW,
    userLabel: 'Я',
    assistantLabel: 'Бот',
  });
  assert.match(out, /^## Я$/m);
  assert.match(out, /^## Бот$/m);
});

/* ------------------------------------------------------------------ *
 * option toggles
 * ------------------------------------------------------------------ */

test('system / tool / thoughts / hidden are skipped by default', () => {
  const c = conv({
    messages: [
      msg({ role: 'system', text: 'SYSTEM TEXT' }),
      msg({ role: 'tool', authorName: 'python', text: 'TOOL TEXT' }),
      msg({ role: 'assistant', contentType: 'thoughts', text: 'THOUGHT TEXT' }),
      msg({ text: 'HIDDEN TEXT', hidden: true }),
      msg({ text: 'VISIBLE TEXT' }),
    ],
  });
  const out = toMarkdown(c, { now: NOW });
  for (const s of ['SYSTEM TEXT', 'TOOL TEXT', 'THOUGHT TEXT', 'HIDDEN TEXT']) {
    assert.equal(out.includes(s), false, `${s} should be skipped`);
  }
  assert.equal(out.includes('VISIBLE TEXT'), true);
});

test('each include* option unlocks exactly its own messages', () => {
  const c = conv({
    messages: [
      msg({ role: 'system', text: 'SYSTEM TEXT' }),
      msg({ role: 'tool', authorName: 'python', text: 'TOOL TEXT' }),
      msg({ role: 'assistant', contentType: 'thoughts', text: 'THOUGHT TEXT' }),
    ],
  });
  const sys = toMarkdown(c, { now: NOW, includeSystem: true });
  assert.match(sys, /^## System$/m);
  assert.equal(sys.includes('TOOL TEXT'), false);

  const tools = toMarkdown(c, { now: NOW, includeTools: true });
  assert.match(tools, /^## Tool: python$/m);
  assert.equal(tools.includes('SYSTEM TEXT'), false);

  const thoughts = toMarkdown(c, { now: NOW, includeThoughts: true });
  assert.match(thoughts, /^## ChatGPT \(thinking\)$/m);
  assert.equal(thoughts.includes('TOOL TEXT'), false);
});

test('timestamps option adds a per-message stamp', () => {
  const c = conv({ messages: [msg({ createTime: 1774519451 })] });
  assert.doesNotMatch(toMarkdown(c, { now: NOW }), /^\*2026-03-26T10:04:11Z\*$/m);
  assert.match(toMarkdown(c, { now: NOW, timestamps: true }), /^\*2026-03-26T10:04:11Z\*$/m);
});

test('timestamps option is silent when the message has no time', () => {
  const c = conv({ messages: [msg({ createTime: null })] });
  const out = toMarkdown(c, { now: NOW, timestamps: true, frontmatter: false });
  assert.equal(out, '# Some chat title\n\n## You\n\nhello\n');
});

/* ------------------------------------------------------------------ *
 * attachments
 * ------------------------------------------------------------------ */

test('http images and files render as links', () => {
  const c = conv({
    messages: [
      msg({
        text: 'see this',
        attachments: [
          { type: 'image', name: 'plot.png', url: 'https://cdn.example/plot.png', alt: 'A plot' },
          { type: 'file', name: 'data.csv', url: 'https://cdn.example/data.csv', alt: null },
        ],
      }),
    ],
  });
  const out = toMarkdown(c, { now: NOW });
  assert.equal(out.includes('![A plot](https://cdn.example/plot.png)'), true);
  assert.equal(out.includes('[data.csv](https://cdn.example/data.csv)'), true);
});

test('file-service:// pointers become a note, never a broken link', () => {
  const c = conv({
    messages: [
      msg({
        text: 'look',
        attachments: [
          { type: 'image', name: 'diagram.png', url: 'file-service://file-abc123', alt: null },
          { type: 'file', name: 'notes.txt', url: null, alt: null },
        ],
      }),
    ],
  });
  const out = toMarkdown(c, { now: NOW });
  assert.equal(out.includes('*(image: diagram.png — not exportable)*'), true);
  assert.equal(out.includes('*(file: notes.txt — not exportable)*'), true);
  assert.equal(out.includes('file-service://'), false);
  assert.equal(out.includes(']()'), false);
});

test('an attachment-only message is still rendered', () => {
  const c = conv({
    messages: [
      msg({ text: '', attachments: [{ type: 'image', name: 'a.png', url: 'https://x/a.png', alt: null }] }),
    ],
  });
  const out = toMarkdown(c, { now: NOW, frontmatter: false });
  assert.equal(out, '# Some chat title\n\n## You\n\n![a.png](https://x/a.png)\n');
});

/* ------------------------------------------------------------------ *
 * warnings
 * ------------------------------------------------------------------ */

test('extraction warnings are appended as a note block', () => {
  const c = conv({
    messages: [msg()],
    warnings: ['DOM fallback: 3 messages may be truncated'],
  });
  const out = toMarkdown(c, { now: NOW });
  assert.match(out, /^> \*\*Export notes\*\*$/m);
  assert.match(out, /^> - DOM fallback: 3 messages may be truncated$/m);
});

/* ------------------------------------------------------------------ *
 * filename
 * ------------------------------------------------------------------ */

test('buildFilename: date prefix + slugified title', () => {
  assert.equal(
    buildFilename(conv({ title: 'Some chat title', createTime: 1774519451 })),
    '2026-03-26-some-chat-title.md',
  );
});

test('buildFilename: no timestamps means no date prefix', () => {
  assert.equal(
    buildFilename(conv({ title: 'Some chat title', createTime: null, updateTime: null })),
    'some-chat-title.md',
  );
});

test('buildFilename: falls back to updateTime for the date', () => {
  assert.equal(
    buildFilename(conv({ title: 'x', createTime: null, updateTime: 1774519451 })),
    '2026-03-26-x.md',
  );
});

test('buildFilename: cyrillic titles are preserved, not stripped', () => {
  assert.equal(
    buildFilename(conv({ title: 'Привет, мир! Как дела?', createTime: 1774519451 })),
    '2026-03-26-привет-мир-как-дела.md',
  );
});

test('buildFilename: a title of "///" falls back to the conversation id', () => {
  const out = buildFilename(conv({ title: '///', createTime: null, updateTime: null }));
  assert.equal(out, '6f1c0f2a-0000-4000-8000-abcdefabcdef.md');
});

test('buildFilename: unusable title and unusable id fall back to a constant', () => {
  assert.equal(
    buildFilename({ title: '///', id: 'unknown', createTime: null, updateTime: null }),
    'chatgpt-conversation.md',
  );
  assert.equal(buildFilename(null), 'chatgpt-conversation.md');
  assert.equal(buildFilename({}), 'chatgpt-conversation.md');
});

test('buildFilename: never emits a path separator or a forbidden character', () => {
  const nasty = [
    '../../etc/passwd',
    'C:\\Windows\\System32',
    'a/b\\c:d*e?f"g<h>i|j',
    'trailing dots...',
    '   ',
    'CON',
    'nul',
  ];
  for (const title of nasty) {
    const out = buildFilename({ title, id: 'unknown', createTime: null, updateTime: null });
    assert.doesNotMatch(out, /[\\/:*?"<>|]/, `"${title}" -> ${out}`);
    assert.equal(out.endsWith('.md'), true);
    assert.equal(out.length > 3, true);
    assert.doesNotMatch(out.slice(0, -3), /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i);
  }
});

test('buildFilename: control characters are removed', () => {
  const title = `bad${String.fromCharCode(0)}name${String.fromCharCode(9)}here`;
  const out = buildFilename({ title, id: 'unknown', createTime: null, updateTime: null });
  assert.equal(out, 'bad-name-here.md');
});

test('buildFilename: base is capped near 80 chars, on a word boundary', () => {
  const title = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
  const out = buildFilename({ title, id: 'unknown', createTime: null, updateTime: null });
  const base = out.slice(0, -3);
  assert.equal(base.length <= 80, true);
  assert.equal(base.length > 60, true);
  assert.doesNotMatch(base, /-$/);
});

test('buildFilename: emoji-only title still yields something usable', () => {
  const out = buildFilename({ title: 'x', id: 'unknown', createTime: null, updateTime: null });
  assert.equal(out, 'x.md');
});

test('slugify: collapses whitespace and repeated separators', () => {
  assert.equal(slugify('  Hello   ---   World  '), 'hello-world');
  assert.equal(slugify('a_b-c'), 'a_b-c');
  assert.equal(slugify(''), '');
  assert.equal(slugify(null), '');
  assert.equal(slugify(42), '');
});

/* ------------------------------------------------------------------ *
 * service worker: UTF-8 safe data: URL
 * ------------------------------------------------------------------ */

test('toDataUrl round-trips Cyrillic, CJK and emoji', async () => {
  const { toDataUrl } = await import('../shared/background.js');
  const text = '# Привет\n\n中文 — emoji 🎉 — ok\n';
  const url = toDataUrl(text);
  assert.match(url, /^data:text\/markdown;charset=utf-8;base64,/);
  const b64 = url.slice(url.indexOf(',') + 1);
  assert.equal(Buffer.from(b64, 'base64').toString('utf8'), text);
});

test('toDataUrl handles a payload larger than one encoding chunk', async () => {
  const { toDataUrl } = await import('../shared/background.js');
  const text = 'ё'.repeat(100000);
  const b64 = toDataUrl(text).split(',')[1];
  assert.equal(Buffer.from(b64, 'base64').toString('utf8'), text);
});

test('service worker download handler renders, names and downloads', async (t) => {
  const { handleMessage } = await import('../shared/background.js');
  let captured = null;
  globalThis.chrome = {
    downloads: {
      download: async (opts) => {
        captured = opts;
        return 42;
      },
    },
  };
  t.after(() => {
    delete globalThis.chrome;
  });

  const reply = await new Promise((resolve) => {
    handleMessage(
      {
        type: 'chat2md:download',
        conversation: conv({ title: 'Привет мир', messages: [msg({ text: 'да' })] }),
        options: { frontmatter: false },
      },
      null,
      resolve,
    );
  });

  assert.equal(reply.ok, true);
  assert.equal(reply.downloadId, 42);
  assert.equal(captured.filename, '2026-03-26-привет-мир.md');
  assert.equal(captured.conflictAction, 'uniquify');
  const decoded = Buffer.from(captured.url.split(',')[1], 'base64').toString('utf8');
  assert.equal(decoded, '# Привет мир\n\n## You\n\nда\n');
});

test('service worker ignores messages that are not its own', async () => {
  const { handleMessage } = await import('../shared/background.js');
  assert.equal(handleMessage({ type: 'chat2md:extract' }, null, () => {}), undefined);
  assert.equal(handleMessage(null, null, () => {}), undefined);
});

/* ------------------------------------------------------------------ *
 * integration with Agent A's normaliser
 * ------------------------------------------------------------------ */

test('renders whatever normalizeConversation() produces', async () => {
  const { normalizeConversation } = await import('../extension/src/lib/extract.js');
  const normalized = normalizeConversation({
    id: 'abc',
    title: 'Real chat',
    createTime: 1774519451,
    updateTime: 1774523451,
    model: 'gpt-5',
    sourceUrl: 'https://chatgpt.com/c/abc',
    extractedVia: 'api',
    messages: [
      { id: 'a', role: 'user', contentType: 'text', text: 'What is 2+2?' },
      { id: 'b', role: 'assistant', contentType: 'text', text: '`4`.' },
    ],
    warnings: [],
  });
  const out = toMarkdown(normalized, { now: NOW });
  assert.match(out, /^title: "Real chat"$/m);
  assert.match(out, /^## You\n\nWhat is 2\+2\?$/m);
  assert.match(out, /^## ChatGPT\n\n`4`\.$/m);
  assert.equal(buildFilename(normalized), '2026-03-26-real-chat.md');
});

test('includeTools / includeThoughts override the hidden flag (real ChatGPT shape)', () => {
  // ChatGPT marks tool output and reasoning as visually hidden; gating those on
  // includeSystem too would make their own toggles no-ops.
  const c = conv({
    messages: [
      msg({ role: 'tool', authorName: 'python', text: 'TOOL TEXT', hidden: true }),
      msg({ role: 'assistant', contentType: 'thoughts', text: 'THOUGHT TEXT', hidden: true }),
      msg({ role: 'user', text: 'PLUMBING', hidden: true }),
    ],
  });

  const tools = toMarkdown(c, { now: NOW, includeTools: true });
  assert.equal(tools.includes('TOOL TEXT'), true);
  assert.equal(tools.includes('THOUGHT TEXT'), false);
  assert.equal(tools.includes('PLUMBING'), false);

  const thoughts = toMarkdown(c, { now: NOW, includeThoughts: true });
  assert.equal(thoughts.includes('THOUGHT TEXT'), true);
  assert.equal(thoughts.includes('TOOL TEXT'), false);

  const sys = toMarkdown(c, { now: NOW, includeSystem: true });
  assert.equal(sys.includes('PLUMBING'), true);
  assert.equal(sys.includes('TOOL TEXT'), false);

  assert.match(toMarkdown(c, { now: NOW }), /^messages: 0$/m);
});
