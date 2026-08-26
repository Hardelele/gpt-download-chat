import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  htmlToMarkdown,
  parseHTML,
  decodeEntities,
  codeLanguageOf,
  findDescendant,
} from '../extension/src/lib/html2md.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(HERE, 'fixtures', name), 'utf8');

test('parses a fragment into a DOM-like tree', () => {
  const root = parseHTML('<p class="a b">hi <b>there</b></p>');
  const p = root.childNodes[0];
  assert.equal(p.tagName, 'P');
  assert.equal(p.getAttribute('class'), 'a b');
  assert.equal(p.textContent, 'hi there');
  assert.equal(p.getAttribute('missing'), null);
});

test('decodes named and numeric entities', () => {
  assert.equal(decodeEntities('a &amp; b &lt;c&gt; &#65; &#x42;'), 'a & b <c> A B');
  assert.equal(decodeEntities('&nbsp;'), ' ');
  assert.equal(decodeEntities('&unknownentity;'), '&unknownentity;');
});

test('headings and inline emphasis', () => {
  const md = htmlToMarkdown(
    '<h1>Title</h1><h3>Sub</h3><p>a <strong>bold</strong> <em>it</em> <del>gone</del> <code>x = 1</code></p>',
  );
  assert.equal(md, '# Title\n\n### Sub\n\na **bold** *it* ~~gone~~ `x = 1`');
});

test('links and images', () => {
  const md = htmlToMarkdown('<p><a href="https://x.dev/a?b=1">click</a> and <img src="/i.png" alt="pic"></p>');
  assert.equal(md, '[click](https://x.dev/a?b=1) and ![pic](/i.png)');
});

test('nested unordered and ordered lists', () => {
  const md = htmlToMarkdown(
    '<ul><li>one<ul><li>one.a</li></ul></li><li>two</li></ul><ol start="3"><li>three</li><li>four</li></ol>',
  );
  assert.equal(md, ['- one', '  - one.a', '- two', '', '3. three', '4. four'].join('\n'));
});

test('blockquote and horizontal rule', () => {
  const md = htmlToMarkdown('<blockquote><p>quoted</p><p>lines</p></blockquote><hr><p>after</p>');
  assert.equal(md, '> quoted\n>\n> lines\n\n---\n\nafter');
});

test('GFM pipe table with escaped pipes', () => {
  const md = htmlToMarkdown(
    '<table><thead><tr><th>a</th><th>b</th></tr></thead>'
    + '<tbody><tr><td>1|x</td><td>2</td></tr></tbody></table>',
  );
  assert.equal(md, '| a | b |\n| --- | --- |\n| 1\\|x | 2 |');
});

test('fenced code keeps the language from the language-xxx class', () => {
  const md = htmlToMarkdown('<pre><code class="hljs language-js">const a = 1;\nconst b = 2;</code></pre>');
  assert.equal(md, '```js\nconst a = 1;\nconst b = 2;\n```');
});

test('ChatGPT code header supplies the language and its buttons are stripped', () => {
  const html = '<pre><div class="contain-inline-size"><div class="flex items-center">python</div>'
    + '<div class="sticky"><button>Copy code</button><button>Edit</button></div></div>'
    + '<div class="overflow-y-auto"><code class="!whitespace-pre hljs language-python">print(1)</code></div></pre>';
  const md = htmlToMarkdown(html);
  assert.equal(md, '```python\nprint(1)\n```');
  assert.ok(!/Copy code/i.test(md), 'Copy code button text must not leak into the output');
  assert.ok(!/\bEdit\b/.test(md));
});

test('code header language is found even without a language- class', () => {
  const html = '<pre><div class="flex items-center">rust</div><button>Copy code</button>'
    + '<code>fn main() {}</code></pre>';
  assert.equal(htmlToMarkdown(html), '```rust\nfn main() {}\n```');
});

test('code fences grow when the code itself contains backticks', () => {
  const md = htmlToMarkdown('<pre><code class="language-md">```js\nx\n```</code></pre>');
  assert.ok(md.startsWith('````md\n'));
  assert.ok(md.endsWith('\n````'));
});

test('codeLanguageOf reads data-language and class attributes', () => {
  const pre = parseHTML('<pre data-language="Go"><code>x</code></pre>').childNodes[0];
  const code = findDescendant(pre, (n) => n.tagName === 'CODE');
  assert.equal(codeLanguageOf(pre, code), 'go');
});

test('KaTeX inline math uses the original TeX', () => {
  const html = '<p>cost is <span class="katex"><span class="katex-mathml"><math><semantics><mrow>'
    + '<mi>O</mi><mo>(</mo><mi>n</mi><mo>)</mo></mrow>'
    + '<annotation encoding="application/x-tex">O(n)</annotation></semantics></math></span>'
    + '<span class="katex-html" aria-hidden="true"><span class="base">O(n)</span></span></span> here</p>';
  assert.equal(htmlToMarkdown(html), 'cost is $O(n)$ here');
});

test('KaTeX display math becomes a $$ block', () => {
  const html = '<span class="katex-display"><span class="katex"><span class="katex-mathml"><math>'
    + '<semantics><annotation encoding="application/x-tex">E = mc^2</annotation></semantics></math></span>'
    + '<span class="katex-html" aria-hidden="true">E=mc2</span></span></span>';
  assert.equal(htmlToMarkdown(html), '$$\nE = mc^2\n$$');
});

test('script, style and svg never reach the output', () => {
  const md = htmlToMarkdown('<div><script>alert("x < 1")</script><style>.a{}</style>'
    + '<svg><path d="M0"></path></svg><p>kept</p></div>');
  assert.equal(md, 'kept');
});

test('accepts an already-parsed node as well as a string', () => {
  const node = parseHTML('<p>from node</p>');
  assert.equal(htmlToMarkdown(node), 'from node');
  assert.equal(htmlToMarkdown(null), '');
  assert.equal(htmlToMarkdown(''), '');
});

test('full assistant turn fixture converts faithfully', () => {
  const md = htmlToMarkdown(fixture('assistant-turn.html'));

  assert.match(md, /^## Benchmark results/m);
  assert.match(md, /\*\*fastest\*\*/);
  assert.match(md, /~~slowest~~/);
  assert.match(md, /\[the docs\]\(https:\/\/docs\.python\.org\/3\/library\/functions\.html#reversed\)/);

  // nested list survives with indentation
  assert.match(md, /- In place\n {2}- `xs\.reverse\(\)`/);
  assert.match(md, /- Copy\n {2}1\. `xs\[::-1\]`\n {2}2\. `list\(reversed\(xs\)\)`/);
  assert.match(md, /- Copy\n/, 'the literal word "Copy" in prose must not be mistaken for a UI button');

  // code block: language recovered, syntax-highlight spans flattened, buttons gone
  assert.match(md, /```python\nimport timeit\nprint\(timeit\.timeit\('xs\[::-1\]'\)\)\n```/);
  assert.ok(!/Copy code/i.test(md));

  // table, quote, rule, math, image
  assert.match(md, /\| Method \| Time \(ms\) \|\n\| --- \| --- \|/);
  assert.match(md, /\| `xs\[::-1\]` \| 4\.1 \|/);
  assert.match(md, /^> Note: timings are machine dependent\.$/m);
  assert.match(md, /^---$/m);
  assert.match(md, /\$O\(n\)\$ either way/);
  assert.match(md, /\$\$\nT = O\(n\)\n\$\$/);
  assert.match(md, /!\[benchmark chart\]\(https:\/\/files\.oaiusercontent\.com\/chart\.png\)/);

  assert.ok(!/<\w+/.test(md), 'no raw HTML tags may survive');
});
