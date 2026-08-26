#!/usr/bin/env node
/**
 * make-screenshots.mjs — Chrome Web Store screenshots at exactly 1280x800.
 *
 * Nothing here is a mock-up of the product:
 *   - the popup panel is the real shared/popup/popup.html markup,
 *     styled by the real shared/popup/popup.css;
 *   - the Markdown shown in shot 2 is the real output of
 *     shared/lib/markdown.js, and the filename is the real output of
 *     shared/lib/filename.js.
 * Only the sample conversation is fabricated, and it is obviously a sample.
 *
 *   node scripts/make-screenshots.mjs
 *
 * Renders with headless Chrome. If Chrome is not installed, the HTML sources are
 * still written to store/assets/src/ so a human can open and screenshot them.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const POPUP = join(ROOT, 'shared', 'popup');
const OUT = join(ROOT, 'store', 'assets');
const SRC = join(OUT, 'src');
mkdirSync(SRC, { recursive: true });

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* ---------------------------------------------------------------- */
/* 1. real sample conversation -> real renderer output                */
/* ---------------------------------------------------------------- */

const { toMarkdown } = await import(
  pathToFileURL(join(ROOT, 'shared', 'lib', 'markdown.js')).href
);
const { buildFilename } = await import(
  pathToFileURL(join(ROOT, 'shared', 'lib', 'filename.js')).href
);

const sample = {
  id: '68ad1f42-3c7a-4e19-9f0b-2c1d5a6e8b30',
  title: 'Debugging a flaky Postgres index',
  createTime: 1756200000,
  updateTime: 1756213800,
  model: 'gpt-4o',
  sourceUrl: 'https://chatgpt.com/c/68ad1f42-3c7a-4e19-9f0b-2c1d5a6e8b30',
  extractedVia: 'api',
  warnings: [],
  messages: [
    {
      id: 'm1',
      role: 'user',
      authorName: null,
      createTime: 1756200000,
      contentType: 'text',
      text: 'This query got 40x slower after we added a partial index. Why would the planner ignore it?\n\n```sql\nSELECT id, status FROM orders\nWHERE tenant_id = $1 AND status = \'pending\'\nORDER BY created_at DESC\nLIMIT 50;\n```',
      attachments: [],
      hidden: false,
    },
    {
      id: 'm2',
      role: 'assistant',
      authorName: null,
      createTime: 1756200130,
      contentType: 'text',
      text:
        'The planner is almost certainly rejecting the partial index because the predicate is not *provably* implied by the query.\n\n' +
        '| Symptom | Likely cause |\n| --- | --- |\n| Index never chosen | Predicate not provable at plan time |\n| Chosen, still slow | Missing `created_at` for the sort |\n\n' +
        'Two things to check:\n\n1. The index predicate must be a literal match. If you declared it as\n   `WHERE status = \'pending\'::order_status` but pass a `text` parameter, the\n   implication test fails silently.\n2. Your `ORDER BY created_at DESC LIMIT 50` needs the sort column *in the index*,\n   otherwise Postgres still has to sort the whole matched set:\n\n```sql\nCREATE INDEX CONCURRENTLY orders_pending_recent\n  ON orders (tenant_id, created_at DESC)\n  WHERE status = \'pending\';\n```\n\nThe cost model is roughly $O(n \\log n)$ for the sort you are paying for now, versus\n$O(\\log n)$ for an index scan that is already ordered.',
      attachments: [],
      hidden: false,
    },
  ],
};

const markdown = toMarkdown(sample);
const filename = buildFilename(sample);

/* ---------------------------------------------------------------- */
/* 2. the real popup, in its "ready" state                            */
/* ---------------------------------------------------------------- */

let popupCss = readFileSync(join(POPUP, 'popup.css'), 'utf8');
const popupHtml = readFileSync(join(POPUP, 'popup.html'), 'utf8');

// Pin the screenshots to the light theme: headless Chrome's reported colour scheme is not
// something we control from the command line, and a store listing has to be reproducible.
// This strips only the `@media (prefers-color-scheme: dark)` override block.
popupCss = (() => {
  const at = popupCss.indexOf('@media (prefers-color-scheme: dark)');
  if (at === -1) return popupCss;
  let depth = 0;
  for (let i = popupCss.indexOf('{', at); i < popupCss.length; i++) {
    if (popupCss[i] === '{') depth++;
    else if (popupCss[i] === '}' && --depth === 0) return popupCss.slice(0, at) + popupCss.slice(i + 1);
  }
  return popupCss;
})();

// Take the real <body> contents, drop the script tag (no extension APIs here).
let body = popupHtml.slice(popupHtml.indexOf('<body>') + 6, popupHtml.lastIndexOf('</body>'));
body = body.replace(/<script[\s\S]*?<\/script>/g, '');

// Drive it into the state a user actually sees: ready, with the sample loaded.
body = body
  .replace('<section class="pane" id="pane-loading" data-pane="loading">', '<section class="pane" id="pane-loading" data-pane="loading" hidden>')
  .replace('id="pane-ready" data-pane="ready" hidden', 'id="pane-ready" data-pane="ready"')
  .replace('<h2 class="chat-title" id="chat-title"></h2>', `<h2 class="chat-title" id="chat-title">${esc(sample.title)}</h2>`)
  .replace('<p class="meta" id="chat-meta"></p>', '<p class="meta" id="chat-meta">2 messages · gpt-4o · 26 Aug 2026</p>')
  .replace('<p class="status" id="status" role="status" aria-live="polite"></p>', `<p class="status" id="status">Saved <b>${esc(filename)}</b></p>`)
  .replace('<input type="checkbox" id="opt-frontmatter" />', '<input type="checkbox" id="opt-frontmatter" checked />');

// Shot 3 is about the options panel, so drop the title/actions/status rows from that
// copy — otherwise the real panel is ~600px tall and runs off a 800px frame. Everything
// still shown is the untouched popup markup and CSS.
const OPEN_OPTIONS = body
  .replace('<details class="options" id="options">', '<details class="options" id="options" open>')
  .replace(/<h2 class="chat-title"[\s\S]*?<\/h2>/, '')
  .replace(/<p class="meta"[\s\S]*?<\/p>/, '')
  .replace(/<div class="actions">[\s\S]*?<\/div>/, '')
  .replace(/<p class="status"[\s\S]*?<\/p>/, '');

/* ---------------------------------------------------------------- */
/* 3. page shell                                                      */
/* ---------------------------------------------------------------- */

const SHELL = (title, caption, sub, content) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  /* --- the real popup stylesheet, scoped to .popup --- */
  /* Scope the real stylesheet to .popup: every top-level body / html,body / :root
     selector becomes .popup, so the panel keeps its true dimensions, background
     and typography instead of inheriting the stage's. */
  ${popupCss
    .replace(/^([ \t]*)(html,[ \t]*\r?\n[ \t]*)?body([ \t]*\{)/gm, '$1.popup$3')
    .replace(/:root\s*\{/g, '.popup {')}
  .popup { width: 320px; border-radius: 12px; overflow: hidden; box-shadow: 0 24px 60px rgba(0,0,0,.45), 0 2px 8px rgba(0,0,0,.3); }
  /* Compensates for the popup.css [hidden] bug reported in docs/HANDOFF.md. Once B lands
     the one-line fix this override becomes a no-op; it is here so the screenshots are
     correct today rather than blocked on someone else's commit. */
  .popup [hidden] { display: none !important; }

  /* --- the stage --- */
  html, body { margin:0; padding:0; }
  body {
    width:1280px; height:800px; overflow:hidden;
    background:
      radial-gradient(1100px 620px at 78% 12%, rgba(247,183,51,.10), transparent 62%),
      linear-gradient(160deg, #1c2633 0%, #0d1218 62%);
    color:#f8fafc;
    font:16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    -webkit-font-smoothing:antialiased;
    display:grid; grid-template-rows:auto 1fr; gap:0;
  }
  .cap { padding:56px 72px 0; }
  .brand { display:flex; align-items:center; gap:12px; margin-bottom:26px; }
  .brand img { width:34px; height:34px; border-radius:8px; }
  .brand span { font-size:14px; letter-spacing:.16em; text-transform:uppercase; color:#f7b733; font-weight:600; }
  h1 { margin:0; font-size:40px; line-height:1.12; letter-spacing:-.028em; max-width:20ch; font-weight:650; }
  h1 em { font-style:normal; color:#f7b733; }
  .sub { margin:14px 0 0; font-size:17px; color:#9aa7b5; max-width:46ch; }
  .stage { padding:30px 72px 44px; display:flex; align-items:flex-start; gap:44px; min-height:0; }
</style></head>
<body>
  <div class="cap">
    <div class="brand"><img src="icon128.png" alt=""><span>Chat2MD</span></div>
    <h1>${caption}</h1>
    <p class="sub">${esc(sub)}</p>
  </div>
  <div class="stage">${content}</div>
</body></html>`;

/* --- shot 1: the popup, plus what it produces --- */

const editor = (name, text, lines) => `
<div class="editor">
  <div class="tabbar"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span>
    <span class="tab">${esc(name)}</span></div>
  <pre class="code">${lines}</pre>
</div>`;

const highlight = (md) =>
  esc(md)
    .split('\n')
    .map((l) => {
      if (/^---$/.test(l)) return `<span class="fm">${l}</span>`;
      if (/^[a-z_]+:/i.test(l)) return `<span class="key">${l.replace(/^([a-z_]+):/i, '<span class="k">$1</span>:')}</span>`;
      if (/^#{1,6} /.test(l)) return `<span class="h">${l}</span>`;
      if (/^```/.test(l)) return `<span class="fence">${l}</span>`;
      if (/^\|/.test(l)) return `<span class="tbl">${l}</span>`;
      if (/^\s*\d+\. |^\s*[-*] /.test(l)) return `<span class="li">${l}</span>`;
      return l;
    })
    .join('\n');

const EDITOR_CSS = `
  .editor { flex:1 1 auto; min-width:0; background:#0b1016; border:1px solid #263140; border-radius:12px;
            box-shadow:0 24px 60px rgba(0,0,0,.45); overflow:hidden; max-height:400px; display:flex; flex-direction:column; }
  .tabbar { display:flex; align-items:center; gap:7px; padding:11px 15px; background:#121a23; border-bottom:1px solid #263140; }
  .dot { width:10px; height:10px; border-radius:50%; }
  .dot.r{background:#ec6a5e}.dot.y{background:#f4bf4f}.dot.g{background:#61c554}
  .tab { margin-left:12px; font-size:12.5px; color:#8fa0b3; font-family:ui-monospace,"Cascadia Mono",Consolas,monospace; }
  .code { margin:0; padding:18px 22px; font:12px/1.6 ui-monospace,"Cascadia Mono",Consolas,"Liberation Mono",monospace;
          color:#c9d5e1; white-space:pre; overflow:hidden; flex:1 1 auto; }
  .code .fm{color:#5f7183}.code .k{color:#f7b733}.code .key{color:#9db3c8}
  .code .h{color:#7cc4ff;font-weight:600}.code .fence{color:#5f7183}
  .code .tbl{color:#8bd5b0}.code .li{color:#dbe5ee}
`;

// Slice the real output at the interesting places rather than at fixed offsets, so the
// caption and the pixels cannot drift apart if the renderer's output changes.
const mdLines = markdown.split('\n');
const lineAt = (pred, fallback) => {
  const i = mdLines.findIndex(pred);
  return i === -1 ? fallback : i;
};
const tableAt = lineAt((l) => l.startsWith('| '), 0);

const shot1 = SHELL(
  'Chat2MD — one click',
  'One click. The <em>whole</em> conversation.',
  'Not just the part that was scrolled into view — every turn, from the first message to the last, written as real Markdown.',
  `<div class="popup">${body}</div>${editor(filename, '', highlight(mdLines.slice(0, 20).join('\n')))}`
).replace('</style>', EDITOR_CSS + '</style>');

const shot2 = SHELL(
  'Chat2MD — formatting survives',
  // Caption names only what the visible slice actually shows. LaTeX is genuinely
  // preserved (see store/assets/sample.md) but sits below the fold here, so it is
  // claimed in the sub-line rather than in the headline.
  'Code fences, tables and lists <em>survive</em>.',
  'Fenced blocks keep their language tag. Tables stay tables. Nested lists keep their indentation, and LaTeX comes through unchanged.',
  editor(filename, '', highlight(mdLines.slice(Math.max(0, tableAt - 1), tableAt + 24).join('\n')))
).replace('</style>', EDITOR_CSS + '</style>');

const shot3 = SHELL(
  'Chat2MD — options',
  'Yours to tune, then <em>remembered</em>.',
  'Timestamps, system messages, tool calls, reasoning steps, heading style. Set them once; Chat2MD keeps them locally for next time.',
  `<div class="popup">${OPEN_OPTIONS}</div>
   <div style="flex:1 1 auto; padding-top:8px">
     <ul style="margin:0; padding:0; list-style:none; font-size:17px; line-height:2.1; color:#c6d2de">
       <li>&#8226; &nbsp;Complete thread, not the visible window</li>
       <li>&#8226; &nbsp;Fenced code keeps its language tag</li>
       <li>&#8226; &nbsp;Tables, nested lists and LaTeX preserved</li>
       <li>&#8226; &nbsp;YAML front matter for Obsidian &amp; co.</li>
       <li>&#8226; &nbsp;No account, no server, no analytics</li>
     </ul>
   </div>`
).replace('</style>', EDITOR_CSS + '</style>');

const pages = [
  { file: 'shot-1-popup.html', png: 'screenshot-1-popup.png', html: shot1 },
  { file: 'shot-2-output.html', png: 'screenshot-2-output.png', html: shot2 },
  { file: 'shot-3-options.html', png: 'screenshot-3-options.png', html: shot3 },
];

for (const p of pages) writeFileSync(join(SRC, p.file), p.html);
// The stage references the icon next to it.
writeFileSync(join(SRC, 'icon128.png'), readFileSync(join(ROOT, 'extension', 'icons', 'icon128.png')));
writeFileSync(join(SRC, 'sample.md'), markdown);
console.log(`screenshots: wrote ${pages.length} source pages to store/assets/src/`);

/* ---------------------------------------------------------------- */
/* 4. render                                                          */
/* ---------------------------------------------------------------- */

const CHROMES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];
const chrome = CHROMES.find((p) => existsSync(p));

if (!chrome) {
  console.warn(
    'screenshots: no Chrome/Edge binary found — PNGs NOT rendered.\n' +
      '             Open store/assets/src/shot-*.html in a 1280x800 window and capture manually.'
  );
  process.exit(0);
}
console.log(`screenshots: rendering with ${chrome}`);

let bad = 0;
for (const p of pages) {
  const src = pathToFileURL(join(SRC, p.file)).href;
  const dest = join(OUT, p.png);
  execFileSync(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--default-background-color=00000000',
      '--virtual-time-budget=2500',
      '--window-size=1280,800',
      `--screenshot=${dest}`,
      src,
    ],
    { stdio: ['ignore', 'ignore', 'ignore'] }
  );

  if (!existsSync(dest)) {
    console.error(`  FAIL ${p.png}: not produced`);
    bad++;
    continue;
  }
  const buf = readFileSync(dest);
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  if (w !== 1280 || h !== 800) {
    console.error(`  FAIL ${p.png}: ${w}x${h}, the store requires exactly 1280x800`);
    bad++;
    continue;
  }
  console.log(`  ok   store/assets/${p.png}  ${w}x${h}  ${statSync(dest).size} bytes`);
}

if (bad) process.exit(1);
console.log('screenshots: done');
