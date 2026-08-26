/**
 * aimode-extract.test.mjs — Agent F.
 *
 * Zero dependencies, `node --test`. The extractor deliberately accepts any DOM-like
 * node (it only ever touches nodeType / childNodes / tagName / getAttribute /
 * textContent / nodeValue), so these tests drive it with the tiny `parseHTML` fake
 * DOM that ships inside Agent A's html2md.js. No jsdom, no browser.
 *
 * The HTML fixtures below are hand-built to mirror the anchors that Google actually
 * ships on AI Mode pages (`data-session-thread-id`, `data-subtree="aimc"`,
 * `button[data-icl-uuid][data-amic="true"]`, the hidden `<!--Sv6Kpe[[...]]-->`
 * comment block, `a.ZbQNgf` source links) — see the header of extract.js for where
 * each of those was verified. They are NOT captures of a live page: Google's real
 * markup is thousands of hashed-class nodes deep, so a capture would test nothing but
 * the capture. What is tested here is the contract: given those anchors, the right
 * Conversation comes out; given none of them, an explicit warning comes out.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractConversation,
  buildConversation,
  parseHTML,
  parseCitationComments,
  collectPanelSources,
  normalizeUrl,
  queryParam,
  slugify,
  isCitationPill,
  findThreadRoot,
  detectModel,
  expandThread,
  snapshot,
} from '../extensions/aimode/src/lib/extract.js';

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const AIMODE_URL = 'https://www.google.com/search?q=how+do+heat+pumps+work&udm=50&aep=11';

/**
 * Hidden metadata block that carries the real target of each citation pill.
 *
 * NOTE: Agent A's `parseHTML` throws comments away (it is a Markdown-oriented parser,
 * comments are noise there), so the fixtures below mark the block with a placeholder
 * and `dom()` re-attaches it as a real comment node — which is what a content script
 * sees on the live page. See docs/HANDOFF.md.
 */
const SV6KPE_MARK = '@@SV6KPE@@';

function sv6kpe(entries) {
  const payload = entries
    .map((e) => `["${e.uuid}",null,"${e.url}","${e.title}"]`)
    .join(',');
  return `<!--${SV6KPE_MARK}Sv6Kpe[[${payload}]]-->`;
}

/** Comment node in the shape both the real DOM and our snapshotter understand. */
function commentNode(value) {
  return { nodeType: 8, nodeValue: value, childNodes: [] };
}

/** Parse `html`, then graft the stripped `<!--Sv6Kpe...-->` comments back on. */
function dom(html) {
  const root = parseHTML(html);
  const re = new RegExp(`<!--${SV6KPE_MARK}([\\s\\S]*?)-->`, 'g');
  let m;
  while ((m = re.exec(html)) !== null) root.childNodes.push(commentNode(m[1]));
  return root;
}

function pill(uuid, n) {
  return `<button data-icl-uuid="${uuid}" data-amic="true" aria-label="Source ${n}">${n}</button>`;
}

/** Two-turn thread, three citations in the first answer, one collapsed second answer. */
function twoTurnThread({ collapsedSecond = false } = {}) {
  return `
<div id="rcnt">
  <div data-subtree="aimc">
    <div data-session-thread-id="thr_abc123">
      <div class="Xq1">
        <h2 role="heading">How do heat pumps work</h2>
        <div class="answer">
          <p>A heat pump moves heat instead of making it.${pill('u-1', 1)}</p>
          <p>Efficiency is measured as COP.${pill('u-2', 2)} Cold climates need a backup.${pill('u-3', 3)}</p>
          <ul><li>Air source</li><li>Ground source</li></ul>
        </div>
        <div role="toolbar"><button aria-label="Share">Share</button><button>Copy</button></div>
      </div>
      <div class="Xq1">
        <h2 role="heading">What about cold climates</h2>
        <div class="answer">
          ${collapsedSecond
    ? '<div class="collapsed"><p>Modern cold-climate units work to -25 °C.</p>'
      + '<div class="hidden-part"><p>Below that a resistive coil takes over.</p></div></div>'
      + '<button aria-label="Show more">Show more</button>'
    : '<p>Modern cold-climate units work to -25 °C.</p>'}
        </div>
      </div>
    </div>
  </div>
  <div data-container-id="rhs-col">
    <div role="dialog">
      <a class="ZbQNgf" href="/url?q=https%3A%2F%2Fenergy.gov%2Fheat-pumps&amp;sa=U">Energy.gov — Heat pumps</a>
      <a class="ZbQNgf" href="https://example.org/cop">COP explained</a>
    </div>
  </div>
  ${sv6kpe([
    { uuid: 'u-1', url: 'https://energy.gov/heat-pumps', title: 'Heat pump basics' },
    { uuid: 'u-2', url: 'https://example.org/cop', title: 'COP explained' },
    { uuid: 'u-3', url: 'https://coldclimate.example/report', title: 'Cold climate field report' },
  ])}
</div>`;
}

/** A results page with an AI Overview block and no AI Mode container at all. */
const AI_OVERVIEW_HTML = `
<div id="m-x-content">
  <div data-container-id="main-col">
    <p>Sourdough rises because wild yeast produces carbon dioxide.<a href="https://example.com/bread">1</a></p>
  </div>
</div>`;

/** A page with none of the known anchors. */
const UNRECOGNISED_HTML = `
<div id="something-else">
  <section><p>Ordinary blue links live here.</p></section>
</div>`;

function build(html, url = AIMODE_URL, extra = {}) {
  return buildConversation({ root: dom(html), url, now: 1_756_000_000_000, ...extra });
}

/* ------------------------------------------------------------------ */
/* URL + slug helpers                                                  */
/* ------------------------------------------------------------------ */

test('queryParam pulls q out of an AI Mode search URL', () => {
  assert.equal(queryParam(AIMODE_URL), 'how do heat pumps work');
  assert.equal(queryParam('https://www.google.com/ai'), null);
});

test('normalizeUrl unwraps Google redirects and rejects non-http targets', () => {
  assert.equal(
    normalizeUrl('/url?q=https%3A%2F%2Fenergy.gov%2Fheat-pumps&sa=U'),
    'https://energy.gov/heat-pumps',
  );
  assert.equal(normalizeUrl('https://example.com/a'), 'https://example.com/a');
  assert.equal(normalizeUrl('javascript:void(0)'), null);
  assert.equal(normalizeUrl('#'), null);
  assert.equal(normalizeUrl(null), null);
});

test('slugify produces a filename-safe slug', () => {
  assert.equal(slugify('How do heat pumps work?'), 'how-do-heat-pumps-work');
  assert.equal(slugify(''), '');
});

/* ------------------------------------------------------------------ */
/* Citation plumbing                                                   */
/* ------------------------------------------------------------------ */

test('parseCitationComments maps pill uuids to url + title', () => {
  const comments = [
    `Sv6Kpe[[["u-1",null,"https://energy.gov/heat-pumps","Heat pump basics"],`
    + `["u-2",null,"https://example.org/cop","COP explained"]]]`,
  ];
  const map = parseCitationComments(comments, ['u-1', 'u-2']);
  assert.equal(map.get('u-1').url, 'https://energy.gov/heat-pumps');
  assert.equal(map.get('u-1').title, 'Heat pump basics');
  assert.equal(map.get('u-2').url, 'https://example.org/cop');
});

test('parseCitationComments ignores comments with no wanted uuid', () => {
  const map = parseCitationComments(['unrelated payload https://x.example'], ['u-9']);
  assert.equal(map.size, 0);
});

test('isCitationPill recognises attribute pills and bare-number links', () => {
  const attrPill = parseHTML('<button data-icl-uuid="x" data-amic="true">1</button>').children[0];
  const numberPill = parseHTML('<a href="https://e.example">2</a>').children[0];
  const prose = parseHTML('<a href="https://e.example">Read the report</a>').children[0];
  assert.equal(isCitationPill(snapshot(attrPill)), true);
  assert.equal(isCitationPill(snapshot(numberPill)), true);
  assert.equal(isCitationPill(snapshot(prose)), false);
});

test('collectPanelSources reads the right-hand source rail', () => {
  const sources = collectPanelSources(snapshot(dom(twoTurnThread())));
  assert.deepEqual(sources.map((s) => s.url), [
    'https://energy.gov/heat-pumps',
    'https://example.org/cop',
  ]);
  assert.equal(sources[0].title, 'Energy.gov — Heat pumps');
});

/* ------------------------------------------------------------------ */
/* Thread root                                                         */
/* ------------------------------------------------------------------ */

test('findThreadRoot prefers data-session-thread-id over the AI Overview anchors', () => {
  const hit = findThreadRoot(snapshot(dom(twoTurnThread())));
  assert.equal(hit.strategy, 'data-session-thread-id');
  assert.equal(hit.overview, false);
});

test('findThreadRoot falls through to the AI Overview block', () => {
  const hit = findThreadRoot(snapshot(dom(AI_OVERVIEW_HTML)));
  assert.equal(hit.strategy, 'ai-overview:main-col');
  assert.equal(hit.overview, true);
});

/* ------------------------------------------------------------------ */
/* Two-turn thread — the core case                                     */
/* ------------------------------------------------------------------ */

test('a two-turn thread becomes alternating user/assistant messages', () => {
  const convo = build(twoTurnThread());
  assert.deepEqual(convo.messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(convo.messages[0].text, 'How do heat pumps work');
  assert.equal(convo.messages[2].text, 'What about cold climates');
  assert.match(convo.messages[1].text, /heat pump moves heat/i);
  assert.match(convo.messages[3].text, /cold-climate units/i);
});

test('the conversation fills every key of the CONTRACT typedef', () => {
  const convo = build(twoTurnThread());
  for (const key of ['id', 'title', 'createTime', 'updateTime', 'model', 'sourceUrl',
    'extractedVia', 'messages', 'warnings']) {
    assert.ok(key in convo, `missing key ${key}`);
  }
  assert.equal(convo.extractedVia, 'dom');
  assert.equal(convo.createTime, null);
  assert.equal(convo.updateTime, null);
  assert.equal(convo.model, null);
  assert.equal(convo.sourceUrl, AIMODE_URL);
  assert.ok(Array.isArray(convo.warnings));
  for (const m of convo.messages) {
    for (const key of ['id', 'role', 'authorName', 'createTime', 'contentType', 'text',
      'attachments', 'hidden']) {
      assert.ok(key in m, `message missing key ${key}`);
    }
    assert.equal(m.hidden, false);
    assert.ok(Array.isArray(m.attachments));
  }
});

test('title is the first user question; id uses the page thread id when present', () => {
  const convo = build(twoTurnThread());
  assert.equal(convo.title, 'How do heat pumps work');
  assert.equal(convo.id, 'thr_abc123');
});

test('id falls back to a q-slug plus timestamp when the page exposes no thread id', () => {
  const html = twoTurnThread().replace('data-session-thread-id="thr_abc123"', 'data-thread="x"');
  const convo = build(html);
  assert.equal(convo.id, 'aimode-how-do-heat-pumps-work-1756000000');
});

test('id is "unknown" rather than invented when there is no query and no thread id', () => {
  const convo = buildConversation({
    root: parseHTML('<div data-subtree="aimc"><div class="answer"><p>...</p></div></div>'),
    url: 'https://www.google.com/ai',
    now: 1_756_000_000_000,
  });
  // No q param, no thread id, and the only title we could form is the answer text —
  // so the id must be either "unknown" or a slug clearly derived from that text,
  // never something that looks like a Google thread identifier.
  assert.ok(convo.id === 'unknown' || convo.id.startsWith('aimode-'), convo.id);
});

/* ------------------------------------------------------------------ */
/* Citations → ## Sources                                              */
/* ------------------------------------------------------------------ */

test('three inline citations become numbered links plus a Sources block', () => {
  const convo = build(twoTurnThread());
  const answer = convo.messages[1].text;

  // inline, in place, in order of appearance
  assert.match(answer, /instead of making it\.\[\[1\]\]\(https:\/\/energy\.gov\/heat-pumps\)/);
  assert.match(answer, /measured as COP\.\[\[2\]\]\(https:\/\/example\.org\/cop\)/);
  assert.match(answer, /need a backup\.\[\[3\]\]\(https:\/\/coldclimate\.example\/report\)/);

  const sources = answer.slice(answer.indexOf('## Sources'));
  assert.ok(sources.startsWith('## Sources'), 'Sources block must be at the end');
  assert.match(sources, /^1\. \[Heat pump basics\]\(https:\/\/energy\.gov\/heat-pumps\)$/m);
  assert.match(sources, /^2\. \[COP explained\]\(https:\/\/example\.org\/cop\)$/m);
  assert.match(sources, /^3\. \[Cold climate field report\]\(https:\/\/coldclimate\.example\/report\)$/m);
  assert.equal(sources.trim().split('\n').filter((l) => /^\d+\. /.test(l)).length, 3);
});

test('an answer with no citations gets no Sources block', () => {
  const convo = build(twoTurnThread());
  assert.equal(convo.messages[3].text.includes('## Sources'), false);
});

test('a citation whose target cannot be resolved keeps its number and warns loudly', () => {
  // Same thread, but the hidden metadata block is gone.
  const html = twoTurnThread().replace(/<!--@@SV6KPE@@[\s\S]*?-->/, '');
  const convo = build(html);
  const answer = convo.messages[1].text;
  // u-1 and u-2 are still recoverable from the source rail? No — the rail is not keyed
  // by uuid, so all three pills are unresolved and must degrade visibly.
  assert.match(answer, /\[1\]/);
  assert.match(answer, /link unavailable/);
  assert.ok(
    convo.warnings.some((w) => /could not be resolved to a URL/i.test(w)),
    `expected an unresolved-citation warning, got: ${JSON.stringify(convo.warnings)}`,
  );
});

test('duplicate citations of the same source reuse one number', () => {
  const html = `
<div data-subtree="aimc">
  <div data-session-thread-id="t1">
    <div>
      <h2 role="heading">Q</h2>
      <div><p>One.${pill('u-1', 1)} Two.${pill('u-9', 1)}</p></div>
    </div>
  </div>
  ${sv6kpe([
    { uuid: 'u-1', url: 'https://one.example/a', title: 'One' },
    { uuid: 'u-9', url: 'https://one.example/a', title: 'One' },
  ])}
</div>`;
  const convo = build(html);
  const answer = convo.messages[1].text;
  const listed = answer.slice(answer.indexOf('## Sources')).split('\n').filter((l) => /^\d+\. /.test(l));
  assert.equal(listed.length, 1);
  assert.equal((answer.match(/\[\[1\]\]\(https:\/\/one\.example\/a\)/g) || []).length, 2);
});

/* ------------------------------------------------------------------ */
/* Collapsed answers                                                   */
/* ------------------------------------------------------------------ */

test('a collapsed answer still exports the hidden half of its text', () => {
  const convo = build(twoTurnThread({ collapsedSecond: true }));
  const answer = convo.messages[3].text;
  assert.match(answer, /-25 °C/);
  assert.match(answer, /resistive coil takes over/);
  // ...and the "Show more" control itself must not leak into the Markdown.
  assert.equal(/show more/i.test(answer), false);
});

test('expandThread clicks Show-more controls and stops when the page stops growing', async () => {
  let size = 100;
  const clicks = [];
  const control = {
    textContent: 'Show more',
    getAttribute: (n) => (n === 'aria-label' ? 'Show more' : null),
    click() { clicks.push('x'); size += 50; },
  };
  const doc = {
    querySelectorAll: () => [control],
    getElementsByTagName: () => ({ length: size }),
    body: { get textContent() { return 'x'.repeat(size); }, scrollHeight: size },
    documentElement: { scrollHeight: size },
  };
  const res = await expandThread(doc, null, { wait: async () => {}, delay: 0 });
  assert.equal(clicks.length, 1, 'the same control must not be clicked twice');
  assert.equal(res.capped, false);
  assert.ok(res.iterations >= 2 && res.iterations < 60);
});

test('expandThread gives up after the bounded number of passes and reports it', async () => {
  let size = 0;
  const doc = {
    querySelectorAll: () => [],
    getElementsByTagName: () => ({ length: (size += 7) }), // never stabilises
    body: { get textContent() { return 'y'.repeat(size); }, scrollHeight: size },
    documentElement: { scrollHeight: size },
  };
  const res = await expandThread(doc, null, { wait: async () => {}, delay: 0, maxIterations: 6 });
  assert.equal(res.capped, true);
  assert.equal(res.iterations, 6);
});

/* ------------------------------------------------------------------ */
/* Unrecognised layout — must fail loudly, never silently              */
/* ------------------------------------------------------------------ */

test('an unrecognised layout returns no messages AND an explicit warning', () => {
  const convo = build(UNRECOGNISED_HTML, 'https://www.google.com/search?q=weather');
  assert.deepEqual(convo.messages, []);
  assert.ok(convo.warnings.length > 0, 'must not return an empty success');
  assert.ok(
    convo.warnings.some((w) => /did not recognise this page layout/i.test(w)),
    `expected a layout warning, got: ${JSON.stringify(convo.warnings)}`,
  );
  assert.equal(convo.id, 'unknown');
  assert.equal(convo.extractedVia, 'dom');
});

test('extractConversation on a page with no document degrades instead of throwing', async () => {
  const convo = await extractConversation({ document: null, window: null, url: 'https://www.google.com/ai' });
  assert.deepEqual(convo.messages, []);
  assert.ok(convo.warnings.some((w) => /could not access the page document/i.test(w)));
});

test('extractConversation is async, skips expansion when asked, and returns a Conversation', async () => {
  const convo = await extractConversation({
    root: dom(twoTurnThread()),
    url: AIMODE_URL,
    expand: false,
    now: 1_756_000_000_000,
  });
  assert.equal(convo.messages.length, 4);
  assert.equal(convo.title, 'How do heat pumps work');
});

/* ------------------------------------------------------------------ */
/* AI Overviews                                                        */
/* ------------------------------------------------------------------ */

test('an AI Overview block exports as a single turn and says so in warnings', () => {
  const convo = build(AI_OVERVIEW_HTML, 'https://www.google.com/search?q=why+does+sourdough+rise');
  assert.deepEqual(convo.messages.map((m) => m.role), ['user', 'assistant']);
  assert.equal(convo.messages[0].text, 'why does sourdough rise');
  assert.match(convo.messages[1].text, /wild yeast/);
  assert.ok(convo.warnings.some((w) => /AI Overview block/i.test(w)));
});

test('an AI Overview citation link is preserved as a numbered source', () => {
  const convo = build(AI_OVERVIEW_HTML, 'https://www.google.com/search?q=why+does+sourdough+rise');
  const answer = convo.messages[1].text;
  assert.match(answer, /\[\[1\]\]\(https:\/\/example\.com\/bread\)/);
  assert.match(answer, /## Sources[\s\S]*1\. \[example\.com\]\(https:\/\/example\.com\/bread\)/);
});

/* ------------------------------------------------------------------ */
/* Chrome / noise                                                      */
/* ------------------------------------------------------------------ */

test('Share/Copy chrome and toolbars never reach the Markdown', () => {
  const convo = build(twoTurnThread());
  const all = convo.messages.map((m) => m.text).join('\n');
  assert.equal(/^\s*Share\s*$/m.test(all), false);
  assert.equal(/^\s*Copy\s*$/m.test(all), false);
});

test('the follow-up input and suggestion chips are dropped', () => {
  const html = `
<div data-subtree="aimc">
  <div data-session-thread-id="t2">
    <div>
      <h2 role="heading">Q</h2>
      <div><p>The real answer.</p></div>
      <div role="listbox"><div role="option">Ask about costs</div><div role="option">Ask about noise</div></div>
      <div role="search"><textarea aria-label="Ask anything"></textarea></div>
    </div>
  </div>
</div>`;
  const convo = build(html);
  const answer = convo.messages[1].text;
  assert.match(answer, /The real answer\./);
  assert.equal(/Ask about costs/.test(answer), false);
  assert.equal(/Ask about noise/.test(answer), false);
});

test('the "AI responses may include mistakes" disclaimer is stripped', () => {
  const html = `
<div data-subtree="aimc">
  <div data-session-thread-id="t3">
    <div>
      <h2 role="heading">Q</h2>
      <div><p>Answer body.</p><p>AI responses may include mistakes. Learn more</p></div>
    </div>
  </div>
</div>`;
  const convo = build(html);
  assert.match(convo.messages[1].text, /Answer body\./);
  assert.equal(/may include mistakes/i.test(convo.messages[1].text), false);
});

/* ------------------------------------------------------------------ */
/* Markdown fidelity comes from Agent A's html2md — spot-check it       */
/* ------------------------------------------------------------------ */

test('lists, code and tables in an answer survive into Markdown', () => {
  const html = `
<div data-subtree="aimc">
  <div data-session-thread-id="t4">
    <div>
      <h2 role="heading">Show me the numbers</h2>
      <div>
        <ul><li>Air source</li><li>Ground source</li></ul>
        <pre><code class="language-python">print("hi")</code></pre>
        <table><tr><th>Type</th><th>COP</th></tr><tr><td>Air</td><td>3.5</td></tr></table>
      </div>
    </div>
  </div>
</div>`;
  const answer = build(html).messages[1].text;
  assert.match(answer, /^- Air source$/m);
  assert.match(answer, /```python\nprint\("hi"\)\n```/);
  assert.match(answer, /\| Type \| COP \|/);
});

test('images in an answer become attachments', () => {
  const html = `
<div data-subtree="aimc">
  <div data-session-thread-id="t5">
    <div>
      <h2 role="heading">Diagram please</h2>
      <div><p>Here it is.</p><img src="https://img.example/hp.png" alt="Heat pump cycle"></div>
    </div>
  </div>
</div>`;
  const convo = build(html);
  assert.deepEqual(convo.messages[1].attachments, [{
    type: 'image', name: null, url: 'https://img.example/hp.png', alt: 'Heat pump cycle',
  }]);
});

/* ------------------------------------------------------------------ */
/* Model                                                               */
/* ------------------------------------------------------------------ */

test('model stays null when the page only mentions a model inside the answer prose', () => {
  const html = `
<div data-subtree="aimc">
  <div data-session-thread-id="t6">
    <div>
      <h2 role="heading">What is Gemini 3 Pro</h2>
      <div><p>Gemini 3 Pro is a model made by Google.</p></div>
    </div>
  </div>
</div>`;
  assert.equal(build(html).model, null);
});

test('model is read from an explicit data-model attribute', () => {
  const root = snapshot(parseHTML('<div><span data-model="Gemini 3 Pro">m</span></div>'));
  assert.equal(detectModel(root), 'Gemini 3 Pro');
});

/* ------------------------------------------------------------------ */
/* Streaming / partial pages                                           */
/* ------------------------------------------------------------------ */

test('a question with an answer that has not streamed in yet warns instead of silently truncating', () => {
  const html = `
<div data-subtree="aimc">
  <div data-session-thread-id="t7">
    <div><h2 role="heading">Only a question so far</h2><div></div></div>
  </div>
</div>`;
  const convo = build(html);
  assert.ok(
    convo.warnings.some((w) => /no readable answer text/i.test(w))
    || convo.warnings.some((w) => /every turn came out empty/i.test(w)),
    JSON.stringify(convo.warnings),
  );
});
