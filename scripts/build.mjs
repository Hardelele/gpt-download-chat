#!/usr/bin/env node
/**
 * build.mjs — compose, validate and package every store item.
 *
 *   node scripts/build.mjs                    all four platforms
 *   node scripts/build.mjs claude             just one (also: --platform claude)
 *   npm run build -- claude                   the same, through npm
 *   node scripts/build.mjs --zip-only         skip the verify gate
 *   node scripts/build.mjs --list             print the platform table and exit
 *
 * Composition (there is no per-platform copy of the shell anywhere in git):
 *
 *   dist/<outputName>-<version>/
 *     manifest.json          generated from platforms.config.mjs   <- ZIP ROOT
 *     icons/icon{16,32,48,128}.png   generated, tinted per platform
 *     src/background.js  src/content.js  src/popup/**   from shared/
 *     src/platform.js        generated: assistantLabel, hosts, URL patterns
 *     src/lib/markdown.js  src/lib/filename.js          from shared/lib/
 *     src/lib/html2md.js                                from extension/src/lib/
 *     src/lib/*.js                                      that platform's extractor
 *
 * The extractors under `extensions/**` import the shared HTML converter across
 * the tree as `../../../../extension/src/lib/html2md.js`. That path is correct
 * in the source tree (it is what `node --test` resolves) but reaches outside the
 * package, so `normaliseImports()` below rewrites it to `./html2md.js` while
 * staging. Source stays runnable; the package stays self-contained.
 *
 * The ZIP is written by hand with node:zlib (deflateRaw + local headers +
 * central directory). No dependencies, no shelling out to PowerShell — which
 * also avoids Compress-Archive's habit of storing backslash separators and
 * CRLF-mangling.
 *
 * CRITICAL: manifest.json sits at the ZIP ROOT. Chrome Web Store rejects an
 * upload where the manifest is one directory down.
 */

import { deflateRawSync } from 'node:zlib';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  cpSync,
  readdirSync,
  statSync,
  existsSync,
} from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { PLATFORMS, platformById, manifestFor, platformModuleSource } from '../platforms.config.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const SHARED = join(ROOT, 'shared');
/** Agent A owns this; it is shared by every extractor and copied, never moved. */
const HTML2MD = join(ROOT, 'extension', 'src', 'lib', 'html2md.js');

const argv = process.argv.slice(2);
const ZIP_ONLY = argv.includes('--zip-only');

if (argv.includes('--list')) {
  for (const p of PLATFORMS) console.log(`${p.id.padEnd(8)} ${p.outputName.padEnd(16)} ${p.name}`);
  process.exit(0);
}

/* ---------------------------------------------------------------- */
/* which platforms                                                    */
/* ---------------------------------------------------------------- */

const selected = (() => {
  const ids = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--platform' || a === '--dir') {
      // `--dir extensions/claude` is still accepted so older notes keep working.
      const v = argv[++i];
      if (v) ids.push(v.split(/[\\/]/).filter(Boolean).pop());
    } else if (!a.startsWith('-')) {
      ids.push(a);
    }
  }
  if (ids.length === 0) return PLATFORMS;
  return ids.map((id) => platformById(id === 'extension' ? 'chatgpt' : id));
})();

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;

mkdirSync(DIST, { recursive: true });

/* ---------------------------------------------------------------- */
/* helpers                                                           */
/* ---------------------------------------------------------------- */

const SKIP = new Set(['.DS_Store', 'Thumbs.db', '.gitkeep']);
const copyTree = (from, to) =>
  cpSync(from, to, { recursive: true, filter: (src) => !SKIP.has(src.split(/[\\/]/).pop()) });

function walk(dir, acc = []) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

/**
 * Rewrite cross-tree imports so the staged package is self-contained.
 * `(../)+extension/src/lib/<name>.js` -> a path relative to `src/lib/<name>.js`.
 */
function normaliseImports(stageDir) {
  const libDir = join(stageDir, 'src', 'lib');
  const CROSS = /(['"])((?:\.\.\/)+)(?:extension\/src\/lib|shared\/lib)\/([A-Za-z0-9_.-]+\.js)\1/g;
  let touched = 0;

  for (const file of walk(join(stageDir, 'src'))) {
    if (!file.endsWith('.js')) continue;
    const before = readFileSync(file, 'utf8');
    const after = before.replace(CROSS, (whole, q, _up, name) => {
      const target = join(libDir, name);
      if (!existsSync(target)) {
        throw new Error(`${relative(stageDir, file)} imports "${name}" but it was not staged`);
      }
      let spec = relative(dirname(file), target).split(sep).join('/');
      if (!spec.startsWith('.')) spec = './' + spec;
      return `${q}${spec}${q}`;
    });
    if (after !== before) {
      writeFileSync(file, after);
      touched++;
    }
  }
  return touched;
}

/**
 * The store dashboard and the manifest must agree on the item name and the short
 * description. A mismatch is a documented review-delay cause, and it is invisible
 * until a human diffs two files by eye — so diff it here instead.
 *
 * Reads the first fenced block under `## Item name` and under
 * `## Short description`, which is the shape every store/**\/listing.md uses.
 */
function checkListing(p) {
  const path = join(ROOT, ...p.listing.split('/'));
  if (!existsSync(path)) return [`${p.listing} is missing`];

  const md = readFileSync(path, 'utf8');
  const block = (heading) => {
    const at = md.indexOf(`## ${heading}`);
    if (at === -1) return null;
    const open = md.indexOf('```', at);
    if (open === -1) return null;
    const start = md.indexOf('\n', open) + 1;
    const close = md.indexOf('```', start);
    return close === -1 ? null : md.slice(start, close).trim();
  };

  const problems = [];
  for (const [heading, expected, field] of [
    ['Item name', p.name, 'name'],
    ['Short description', p.description, 'description'],
  ]) {
    const found = block(heading);
    if (found === null) problems.push(`${p.listing}: no fenced block under "## ${heading}"`);
    else if (found !== expected) {
      problems.push(
        `${p.listing}: "## ${heading}" says\n      ${JSON.stringify(found)}\n    but platforms.config.mjs ${field} is\n      ${JSON.stringify(expected)}`
      );
    }
  }
  return problems;
}

function run(label, args) {
  try {
    return execFileSync(process.execPath, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    process.stdout.write(String(e.stdout ?? '').replace(/^/gm, '    '));
    process.stderr.write(String(e.stderr ?? '').replace(/^/gm, '    '));
    throw new Error(`${label} failed`);
  }
}

/* ---------------------------------------------------------------- */
/* zip                                                               */
/* ---------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** DOS date/time, fixed so builds are reproducible. */
const DOS_TIME = 0; // 00:00:00
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1; // 2026-01-01

function writeZip(stageDir, zipPath) {
  const entries = walk(stageDir).map((p) => ({
    name: relative(stageDir, p).split('\\').join('/'),
    path: p,
  }));
  if (!entries.some((e) => e.name === 'manifest.json')) {
    throw new Error('manifest.json is not at the archive root');
  }
  // manifest.json first, so it is also the first central-directory entry — the
  // shape a reviewer (and every "is the manifest at the root?" script) expects.
  entries.sort((a, b) =>
    a.name === 'manifest.json' ? -1 : b.name === 'manifest.json' ? 1 : a.name < b.name ? -1 : 1
  );

  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const raw = readFileSync(entry.path);
    const deflated = deflateRawSync(raw, { level: 9 });
    // Store instead of deflate when deflate does not help (tiny files, PNGs).
    const useDeflate = deflated.length < raw.length;
    const data = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);
    const flags = 0x0800; // bit 11: filename is UTF-8

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4); // version made by: 3.0, unix
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    // external attrs: unix mode 0100644 in the high 16 bits.
    // (<<16 overflows into a negative int32 in JS, hence the unsigned shift.)
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with central dir
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  writeFileSync(zipPath, Buffer.concat([...locals, centralBuf, eocd]));
}

/** Read the archive back through its central directory and prove it is well formed. */
function listZip(path) {
  const buf = readFileSync(path);
  let eocdAt = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdAt = i;
      break;
    }
  }
  if (eocdAt === -1) throw new Error('no end-of-central-directory record');
  const count = buf.readUInt16LE(eocdAt + 10);
  let p = buf.readUInt32LE(eocdAt + 16);
  const names = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`bad central header #${i}`);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    names.push({
      name: buf.toString('utf8', p + 46, p + 46 + nameLen),
      compressed: buf.readUInt32LE(p + 20),
      uncompressed: buf.readUInt32LE(p + 24),
    });
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return names;
}

/* ---------------------------------------------------------------- */
/* one platform                                                      */
/* ---------------------------------------------------------------- */

function build(p) {
  const stem = `${p.outputName}-${version}`;
  const stageDir = join(DIST, stem);
  const zipPath = join(DIST, `${stem}.zip`);
  const stageRel = `dist/${stem}`;

  console.log(`\n=== ${p.id} — ${p.name}`);

  const extractorDir = join(ROOT, ...p.extractorDir.split('/'));
  if (!existsSync(join(extractorDir, 'extract.js'))) {
    throw new Error(`${p.extractorDir}/extract.js is missing — nothing to package`);
  }

  /* 1. stage ------------------------------------------------------ */
  rmSync(stageDir, { recursive: true, force: true });
  rmSync(zipPath, { force: true });
  mkdirSync(join(stageDir, 'src', 'lib'), { recursive: true });

  copyTree(SHARED, join(stageDir, 'src')); // background, content, popup/**, lib/{markdown,filename}
  cpSync(HTML2MD, join(stageDir, 'src', 'lib', 'html2md.js'));
  copyTree(extractorDir, join(stageDir, 'src', 'lib'));

  // Generated, and written last so it always wins over the checked-in copy.
  writeFileSync(join(stageDir, 'src', 'platform.js'), platformModuleSource(p));
  writeFileSync(
    join(stageDir, 'manifest.json'),
    JSON.stringify(manifestFor(p, version), null, 2) + '\n'
  );

  const rewritten = normaliseImports(stageDir);

  /* 1b. keep the checked-in manifest honest ----------------------- */
  // The item's own manifest.json is a generated artifact now: it is what a
  // reviewer reads in git and what `verify.mjs --dir <sourceDir>` sees, but the
  // package always uses the freshly generated one above. Writing it back here
  // is what makes "manifest and store listing disagree" structurally
  // impossible. Edit platforms.config.mjs, never the manifest.
  const srcManifest = join(ROOT, ...p.sourceDir.split('/'), 'manifest.json');
  const generated = readFileSync(join(stageDir, 'manifest.json'), 'utf8');
  if (!existsSync(srcManifest) || readFileSync(srcManifest, 'utf8') !== generated) {
    writeFileSync(srcManifest, generated);
    console.log(`  rewrote  ${p.sourceDir}/manifest.json from platforms.config.mjs`);
  }

  /* 2. icons ------------------------------------------------------ */
  run('icons', [join(ROOT, 'scripts', 'make-icons.mjs'), '--dir', stageRel, '--accent', p.accent]);

  console.log(
    `  staged   ${stageRel}/  (shell + ${p.extractorDir}, ${rewritten} import path(s) normalised, accent ${p.accent})`
  );

  /* 3. gate ------------------------------------------------------- */
  if (ZIP_ONLY) {
    console.log('  verify   skipped (--zip-only)');
  } else {
    const listingProblems = checkListing(p);
    if (listingProblems.length) {
      for (const m of listingProblems) console.error(`    ${m}`);
      throw new Error('store listing does not match the manifest');
    }
    console.log(`  listing  ${p.listing} agrees with the manifest`);

    const out = run('verify', [join(ROOT, 'scripts', 'verify.mjs'), '--dir', stageRel]);
    process.stdout.write(out.replace(/^/gm, '  '));
  }

  /* 4. zip -------------------------------------------------------- */
  writeZip(stageDir, zipPath);

  const listed = listZip(zipPath);
  const bytes = statSync(zipPath).size;

  if (listed[0]?.name !== 'manifest.json') {
    throw new Error(`archive readback: first central-directory entry is "${listed[0]?.name}", not manifest.json`);
  }
  if (listed.some((e) => e.name.includes('\\'))) {
    throw new Error('archive contains backslash separators');
  }

  console.log(`  packaged ${stageRel}.zip  (${bytes} bytes, ${listed.length} entries)`);

  // Optional cross-check with the platform's own ZIP reader.
  if (process.platform === 'win32') {
    try {
      const ps = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
            `$z=[System.IO.Compression.ZipFile]::OpenRead('${zipPath.replace(/'/g, "''")}'); ` +
            `$z.Entries.Count; $z.Dispose()`,
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim();
      if (Number(ps) !== listed.length) {
        throw new Error(`.NET ZipFile sees ${ps} entries, we wrote ${listed.length}`);
      }
      console.log(`  validated by .NET System.IO.Compression (${ps} entries)`);
    } catch (e) {
      if (/ZipFile sees/.test(String(e.message))) throw e;
      console.log('  (skipped .NET zip cross-check — powershell unavailable)');
    }
  }

  return { id: p.id, zip: `${stageRel}.zip`, bytes, entries: listed.length };
}

/* ---------------------------------------------------------------- */
/* main                                                              */
/* ---------------------------------------------------------------- */

const results = [];
for (const p of selected) {
  try {
    results.push(build(p));
  } catch (e) {
    console.error(`\nbuild: aborted on "${p.id}" — ${e.message}`);
    process.exit(1);
  }
}

console.log(`\nbuild: ${results.length} package(s), version ${version}`);
for (const r of results) console.log(`  ${r.zip.padEnd(38)} ${String(r.bytes).padStart(8)} bytes  ${r.entries} entries`);
