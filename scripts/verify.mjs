#!/usr/bin/env node
/**
 * verify.mjs — pre-publish gate for the Chat2MD extension.
 *
 * Everything the Chrome Web Store review (or a broken load-unpacked) would trip
 * over, checked locally with zero dependencies. Exits non-zero on the first
 * failing category with a readable message.
 *
 *   node scripts/verify.mjs [--dir extension]
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative, extname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argDir = (() => {
  const i = process.argv.indexOf('--dir');
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : 'extension';
})();
const EXT = join(ROOT, argDir);

const errors = [];
const warnings = [];
const fail = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

const rel = (p) => relative(ROOT, p).split('\\').join('/');

/* ---------------------------------------------------------------- */
/* 0. tree exists                                                     */
/* ---------------------------------------------------------------- */

if (!existsSync(EXT) || !statSync(EXT).isDirectory()) {
  console.error(`verify: extension directory not found: ${rel(EXT)}`);
  process.exit(1);
}

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, acc);
    else if (entry.isFile()) acc.push(p);
  }
  return acc;
}
const allFiles = walk(EXT);

/* ---------------------------------------------------------------- */
/* 1. manifest.json                                                   */
/* ---------------------------------------------------------------- */

const manifestPath = join(EXT, 'manifest.json');
let manifest = null;

if (!existsSync(manifestPath)) {
  fail('manifest.json is missing at the extension root');
} else {
  const rawManifest = readFileSync(manifestPath, 'utf8');
  try {
    manifest = JSON.parse(rawManifest);
  } catch (e) {
    fail(`manifest.json is not valid JSON: ${e.message}`);
  }
}

if (manifest) {
  if (manifest.manifest_version !== 3) {
    fail(`manifest_version must be 3, got ${JSON.stringify(manifest.manifest_version)}`);
  }

  if (typeof manifest.name !== 'string' || !manifest.name.trim()) {
    fail('manifest.name is missing or empty');
  } else if (manifest.name.length > 75) {
    fail(`manifest.name is ${manifest.name.length} chars, the store limit is 75`);
  }

  const SEMVER = /^\d+(\.\d+){0,3}$/;
  if (typeof manifest.version !== 'string' || !SEMVER.test(manifest.version)) {
    fail(
      `manifest.version must be 1-4 dot-separated integers (Chrome's format), got ${JSON.stringify(manifest.version)}`
    );
  }

  if (typeof manifest.description !== 'string' || !manifest.description.trim()) {
    fail('manifest.description is missing or empty (the store requires one)');
  } else if (manifest.description.length > 132) {
    fail(`manifest.description is ${manifest.description.length} chars, the store limit is 132`);
  }

  /* -------------------------------------------------------------- */
  /* 2. icons                                                        */
  /* -------------------------------------------------------------- */

  const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const MIN_BYTES = { 16: 100, 32: 150, 48: 200, 128: 400 };

  for (const size of [16, 32, 48, 128]) {
    const p = join(EXT, 'icons', `icon${size}.png`);
    if (!existsSync(p)) {
      fail(`icons/icon${size}.png is missing`);
      continue;
    }
    const buf = readFileSync(p);
    if (!buf.subarray(0, 8).equals(PNG_SIG)) {
      fail(`icons/icon${size}.png is not a PNG (bad signature)`);
      continue;
    }
    if (buf.length < MIN_BYTES[size]) {
      fail(`icons/icon${size}.png is only ${buf.length} bytes — looks like a placeholder`);
    }
    // IHDR dimensions live at bytes 16..24
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    if (w !== size || h !== size) {
      fail(`icons/icon${size}.png is ${w}x${h}, expected ${size}x${size}`);
    }
  }

  const declaredIcons = Object.values(manifest.icons ?? {});
  if (declaredIcons.length === 0) warn('manifest has no "icons" block');
  const actionIcons = Object.values(manifest.action?.default_icon ?? {});
  if (manifest.action && actionIcons.length === 0) {
    warn('manifest.action has no default_icon — Chrome will render a grey puzzle piece');
  }

  /* -------------------------------------------------------------- */
  /* 3. every file the manifest references must exist                */
  /* -------------------------------------------------------------- */

  const referenced = new Set();
  const addRef = (v) => {
    if (typeof v === 'string' && v && !/^(https?:)?\/\//.test(v)) referenced.add(v);
  };

  declaredIcons.forEach(addRef);
  actionIcons.forEach(addRef);
  addRef(manifest.action?.default_popup);
  addRef(manifest.background?.service_worker);
  addRef(manifest.options_page);
  addRef(manifest.options_ui?.page);
  addRef(manifest.devtools_page);
  for (const cs of manifest.content_scripts ?? []) {
    (cs.js ?? []).forEach(addRef);
    (cs.css ?? []).forEach(addRef);
  }
  for (const war of manifest.web_accessible_resources ?? []) {
    (war.resources ?? []).forEach((r) => {
      if (!r.includes('*')) addRef(r);
    });
  }

  for (const ref of referenced) {
    const p = join(EXT, ref);
    if (!existsSync(p)) fail(`manifest references "${ref}" but ${rel(p)} does not exist`);
  }

  /* -------------------------------------------------------------- */
  /* 4. permissions hygiene                                          */
  /* -------------------------------------------------------------- */

  const hostPerms = [
    ...(manifest.host_permissions ?? []),
    ...(manifest.content_scripts ?? []).flatMap((cs) => cs.matches ?? []),
  ];
  for (const h of hostPerms) {
    if (h === '<all_urls>' || h === '*://*/*' || h === 'http://*/*' || h === 'https://*/*') {
      fail(`over-broad host permission "${h}" — the store will ask why, and we do not need it`);
    }
  }

  const RISKY = new Set(['tabs', 'webRequest', 'webRequestBlocking', 'history', 'cookies', 'management', 'debugger']);
  for (const p of manifest.permissions ?? []) {
    if (RISKY.has(p)) warn(`permission "${p}" needs an explicit justification in the store listing`);
  }
  if ((manifest.permissions ?? []).includes('downloads') === false) {
    warn('no "downloads" permission — the extension cannot write a file without it');
  }

  if (manifest.content_security_policy?.extension_pages) {
    const csp = manifest.content_security_policy.extension_pages;
    if (/unsafe-eval|unsafe-inline/.test(csp)) {
      fail(`content_security_policy allows ${/unsafe-eval/.test(csp) ? 'unsafe-eval' : 'unsafe-inline'} — MV3 forbids it`);
    }
  }
}

/* ---------------------------------------------------------------- */
/* 5. no remote code, no eval, anywhere under extension/             */
/* ---------------------------------------------------------------- */

const TEXT_EXT = new Set(['.js', '.mjs', '.html', '.htm', '.css', '.json']);
const REMOTE_CODE = [
  { re: /<script[^>]+src\s*=\s*["']https?:\/\//i, msg: 'remote <script src>' },
  { re: /<link[^>]+href\s*=\s*["']https?:\/\//i, msg: 'remote <link href> (stylesheet/font)' },
  { re: /\beval\s*\(/, msg: 'eval(' },
  { re: /new\s+Function\s*\(/, msg: 'new Function(' },
  { re: /\bimportScripts\s*\(\s*["']https?:/i, msg: 'importScripts() from a URL' },
  { re: /\bimport\s*\(\s*["']https?:/i, msg: 'dynamic import() from a URL' },
  { re: /["']https?:\/\/[^"']*\.js["']/i, msg: 'a remote .js URL' },
];

// Network egress: the only hosts we may talk to are the ones the manifest itself
// declares. Derived, not hardcoded, so this gate works unchanged for the Claude,
// Gemini and AI Mode builds (see CONTRACT-PLATFORMS.md).
const allowedHosts = new Set();
for (const pattern of [
  ...(manifest?.host_permissions ?? []),
  ...(manifest?.content_scripts ?? []).flatMap((cs) => cs.matches ?? []),
]) {
  const m = /^[a-z*]+:\/\/([^/]+)/i.exec(pattern);
  if (m) allowedHosts.add(m[1].replace(/^\*\./, '').toLowerCase());
}
// Documentation / repository links are never egress.
const DOC_HOSTS = /(^|\.)(w3\.org|github\.com|github\.io|developer\.chrome\.com|schema\.org)$/;
const isAllowedHost = (h) =>
  allowedHosts.has(h) || [...allowedHosts].some((a) => h === a || h.endsWith('.' + a)) || DOC_HOSTS.test(h);

const URL_RE = /https?:\/\/([a-z0-9.-]+)/gi;

for (const file of allFiles) {
  if (!TEXT_EXT.has(extname(file).toLowerCase())) continue;
  const src = readFileSync(file, 'utf8');
  const r = rel(file);

  for (const { re, msg } of REMOTE_CODE) {
    if (re.test(src)) fail(`${r} contains ${msg} — remote code is banned by MV3 and by this project`);
  }

  const seen = new Set();
  for (const m of src.matchAll(URL_RE)) {
    const host = m[1].toLowerCase().replace(/\.$/, '');
    if (seen.has(host) || isAllowedHost(host)) continue;
    seen.add(host);
    warn(`${r} mentions host "${host}" — not declared in the manifest; confirm it is a comment, not egress`);
  }
}

/* ---------------------------------------------------------------- */
/* 6. no reachable TODOs                                             */
/* ---------------------------------------------------------------- */

for (const file of allFiles) {
  if (!['.js', '.mjs'].includes(extname(file).toLowerCase())) continue;
  const src = readFileSync(file, 'utf8');
  const hits = src.split(/\r?\n/).filter((l) => /\bTODO\b|\bFIXME\b/.test(l));
  if (hits.length) warn(`${rel(file)} has ${hits.length} TODO/FIXME marker(s)`);
}

/* ---------------------------------------------------------------- */
/* report                                                            */
/* ---------------------------------------------------------------- */

if (warnings.length) {
  console.log(`verify: ${warnings.length} warning(s)`);
  for (const w of warnings) console.log(`  warn  ${w}`);
}

if (errors.length) {
  console.error(`\nverify: FAILED with ${errors.length} error(s)`);
  for (const e of errors) console.error(`  ERROR ${e}`);
  process.exit(1);
}

console.log(
  `verify: OK — ${allFiles.length} files under ${argDir}/, manifest v${manifest?.manifest_version} version ${manifest?.version}`
);
