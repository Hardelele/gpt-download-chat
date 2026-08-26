#!/usr/bin/env node
/**
 * build.mjs — validate, stage and package the extension.
 *
 *   node scripts/build.mjs                              # the ChatGPT build
 *   node scripts/build.mjs --dir extensions/claude      # any other store item
 *   node scripts/build.mjs --zip-only                   # skip the verify gate
 *
 * The output stem comes from the manifest's own name, so the Claude / Gemini /
 * AI Mode builds (CONTRACT-PLATFORMS.md) work through this same script.
 *
 * The ZIP is written by hand with node:zlib (deflateRaw + local headers + central
 * directory). No dependencies, no shelling out to PowerShell — which also avoids
 * Compress-Archive's habit of storing backslash separators and CRLF-mangling.
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
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const ZIP_ONLY = process.argv.includes('--zip-only');

const DIR_ARG = (() => {
  const i = process.argv.indexOf('--dir');
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : 'extension';
})();
const EXT = join(ROOT, DIR_ARG);

if (!existsSync(join(EXT, 'manifest.json'))) {
  console.error(`build: no manifest.json under ${DIR_ARG}/ — nothing to package`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

/* ---------------------------------------------------------------- */
/* 1. gate                                                            */
/* ---------------------------------------------------------------- */

if (!ZIP_ONLY) {
  console.log('build: running verify gate...');
  try {
    const out = execFileSync(process.execPath, [join(ROOT, 'scripts', 'verify.mjs'), '--dir', DIR_ARG], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    process.stdout.write(out.replace(/^/gm, '  '));
  } catch (e) {
    process.stdout.write(String(e.stdout ?? '').replace(/^/gm, '  '));
    process.stderr.write(String(e.stderr ?? '').replace(/^/gm, '  '));
    console.error('build: aborted — verify failed');
    process.exit(1);
  }
}

const manifest = JSON.parse(readFileSync(join(EXT, 'manifest.json'), 'utf8'));
const version = manifest.version;
if (manifest.version !== pkg.version) {
  console.error(
    `build: version mismatch — package.json is ${pkg.version} but manifest.json is ${manifest.version}`
  );
  process.exit(1);
}

// Deterministic stem from the source tree, not the display name:
//   extension/            -> chat2md-<version>
//   extensions/claude/    -> chat2md-claude-<version>
const dirLeaf = DIR_ARG.split(/[\\/]/).filter(Boolean).pop();
const stem = `chat2md${dirLeaf === 'extension' ? '' : '-' + dirLeaf}-${version}`;
const stageDir = join(DIST, stem);
const zipPath = join(DIST, `${stem}.zip`);

/* ---------------------------------------------------------------- */
/* 2. stage                                                           */
/* ---------------------------------------------------------------- */

rmSync(stageDir, { recursive: true, force: true });
rmSync(zipPath, { force: true });
mkdirSync(DIST, { recursive: true });

const SKIP = new Set(['.DS_Store', 'Thumbs.db', '.gitkeep']);
cpSync(EXT, stageDir, {
  recursive: true,
  filter: (src) => !SKIP.has(src.split(/[\\/]/).pop()),
});
console.log(`build: staged  dist/${stem}/`);

/* ---------------------------------------------------------------- */
/* 3. zip                                                             */
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

function collect(dir, base = dir, acc = []) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) collect(p, base, acc);
    // ZIP spec: forward slashes only, relative to the archive root.
    else acc.push({ name: relative(base, p).split('\\').join('/'), path: p });
  }
  return acc;
}

const entries = collect(stageDir);
if (!entries.some((e) => e.name === 'manifest.json')) {
  console.error('build: FATAL — manifest.json is not at the archive root');
  process.exit(1);
}

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

/* ---------------------------------------------------------------- */
/* 4. read the archive back and prove it is well formed               */
/* ---------------------------------------------------------------- */

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

const listed = listZip(zipPath);
const zipBytes = statSync(zipPath).size;

console.log(`build: wrote   dist/${stem}.zip  (${zipBytes} bytes, ${listed.length} entries)`);
for (const e of listed) {
  console.log(`         ${e.name}  ${e.uncompressed} -> ${e.compressed}`);
}

if (listed[0]?.name !== 'manifest.json' && !listed.some((e) => e.name === 'manifest.json')) {
  console.error('build: FATAL — archive readback has no root manifest.json');
  process.exit(1);
}
if (listed.some((e) => e.name.includes('\\'))) {
  console.error('build: FATAL — archive contains backslash separators');
  process.exit(1);
}

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
      console.error(`build: FATAL — .NET ZipFile sees ${ps} entries, we wrote ${listed.length}`);
      process.exit(1);
    }
    console.log(`build: zip validated by .NET System.IO.Compression (${ps} entries)`);
  } catch {
    console.log('build: (skipped .NET zip cross-check — powershell unavailable)');
  }
}

console.log('build: done');
