#!/usr/bin/env node
/**
 * make-icons.mjs — generates the Chat2MD extension icons with zero dependencies.
 *
 * Everything here is hand-rolled on purpose: no sharp, no canvas, no jimp.
 * We rasterise into an RGBA byte buffer with 4x4 supersampling for antialiasing,
 * then encode a real PNG using only node:zlib.
 *
 * PNG layout we emit:
 *   \x89PNG\r\n\x1a\n | IHDR | IDAT (zlib deflate of filter-0 scanlines) | IEND
 * Each chunk is: length(4) type(4) data(n) crc32(4)  — CRC over type+data.
 *
 * Design: full-bleed rounded square in deep ink holding a chat bubble in the
 * platform accent, with a bold ink `#` cut into it — "a chat, as Markdown".
 * The `#` is the one Markdown glyph everyone recognises; the bubble says chat.
 * Thick strokes, three colours, no fine detail, so it survives 16px.
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------------ *
 * PNG encoding
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** @param {Uint8Array} rgba row-major RGBA, size*size*4 */
function encodePng(rgba, width, height) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour with alpha
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0 (None)
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1
    );
  }

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ *
 * Geometry, all in a 0..1 unit square
 * ------------------------------------------------------------------ */

const INK_TOP = [0x1c, 0x26, 0x33];
const INK_BOTTOM = [0x0d, 0x12, 0x18];

/**
 * CLI:
 *   node scripts/make-icons.mjs                                  the ChatGPT set + store icon
 *   node scripts/make-icons.mjs --dir extensions/claude          a sibling extension's set
 *   node scripts/make-icons.mjs --dir extensions/claude --accent "#d97757"
 *
 * The badge, bubble and `#` are identical across platforms on purpose — one family,
 * one recognisable mark. Only the bubble is tinted, which tells the four store items
 * apart in a toolbar without inventing four unrelated logos.
 */
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const OUT_DIR = arg('--dir', 'extension');

const hexToRgb = (hex) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`--accent must be a #rrggbb colour, got "${hex}"`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
};
const ACCENT = hexToRgb(arg('--accent', '#f7b733'));

const BADGE_RADIUS = 0.215;

// Chat bubble body and its tail (bottom-left, pointing down-left).
const BUB_X0 = 0.135, BUB_X1 = 0.865, BUB_Y0 = 0.165, BUB_Y1 = 0.735, BUB_R = 0.15;
const TAIL = [[0.250, 0.700], [0.470, 0.700], [0.200, 0.885]];
// The `#`: two slanted verticals, two horizontals, centred in the bubble.
const HASH_CX = 0.500, HASH_CY = 0.450, HASH_HALF = 0.185, HASH_W = 0.085, HASH_SLANT = 0.22;
const HASH_V = [-0.085, 0.085];   // vertical bar centres, relative to HASH_CX
const HASH_H = [-0.075, 0.075];   // horizontal bar centres, relative to HASH_CY

function inRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function inTriangle(x, y, [a, b, c]) {
  const d = (p, q) => (x - q[0]) * (p[1] - q[1]) - (p[0] - q[0]) * (y - q[1]);
  const d1 = d(a, b), d2 = d(b, c), d3 = d(c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

function inBubble(x, y) {
  return inRoundedRect(x, y, BUB_X0, BUB_Y0, BUB_X1, BUB_Y1, BUB_R) || inTriangle(x, y, TAIL);
}

function inHash(x, y) {
  const dy = y - HASH_CY;
  if (Math.abs(dy) <= HASH_HALF) {
    // Verticals lean forward like an italic `#`.
    const sx = x - HASH_CX + dy * HASH_SLANT;
    for (const v of HASH_V) if (Math.abs(sx - v) <= HASH_W / 2) return true;
  }
  const dx = x - HASH_CX;
  if (Math.abs(dx + dy * HASH_SLANT) <= HASH_HALF) {
    for (const h of HASH_H) if (Math.abs(dy - h) <= HASH_W / 2) return true;
  }
  return false;
}

function lerp(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

/**
 * Render one icon at `size` px using SS x SS supersampling.
 * Accumulates premultiplied-ish coverage per layer so edges blend cleanly.
 */
function render(size, ss = 4) {
  const out = new Uint8Array(size * size * 4);
  const inv = 1 / (ss * ss);

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let covBadge = 0, covBubble = 0, covHash = 0;
      let bgR = 0, bgG = 0, bgB = 0;

      for (let sy = 0; sy < ss; sy++) {
        const y = (py + (sy + 0.5) / ss) / size;
        for (let sx = 0; sx < ss; sx++) {
          const x = (px + (sx + 0.5) / ss) / size;
          if (!inRoundedRect(x, y, 0, 0, 1, 1, BADGE_RADIUS)) continue;
          covBadge++;
          const c = lerp(INK_TOP, INK_BOTTOM, y);
          bgR += c[0]; bgG += c[1]; bgB += c[2];
          if (inBubble(x, y)) {
            if (inHash(x, y)) covHash++;
            else covBubble++;
          }
        }
      }

      const i = (py * size + px) * 4;
      if (covBadge === 0) {
        out[i] = out[i + 1] = out[i + 2] = out[i + 3] = 0;
        continue;
      }

      // Base colour = average ink under the covered subsamples.
      let r = bgR / covBadge, g = bgG / covBadge, b = bgB / covBadge;

      // The `#` is the badge ink showing through the bubble, so only the bubble paints.
      const aBubble = covBubble / covBadge;
      r = r * (1 - aBubble) + ACCENT[0] * aBubble;
      g = g * (1 - aBubble) + ACCENT[1] * aBubble;
      b = b * (1 - aBubble) + ACCENT[2] * aBubble;

      out[i] = Math.round(r);
      out[i + 1] = Math.round(g);
      out[i + 2] = Math.round(b);
      out[i + 3] = Math.round((covBadge * inv) * 255);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

const iconsDir = join(ROOT, ...OUT_DIR.split(/[\\/]/), 'icons');
const TARGETS = [
  { size: 16, path: join(iconsDir, 'icon16.png'), ss: 8 },
  { size: 32, path: join(iconsDir, 'icon32.png'), ss: 8 },
  { size: 48, path: join(iconsDir, 'icon48.png'), ss: 6 },
  { size: 128, path: join(iconsDir, 'icon128.png'), ss: 4 },
];
// The 512px listing asset only belongs to the primary build.
if (OUT_DIR === 'extension') {
  TARGETS.push({ size: 512, path: join(ROOT, 'store', 'assets', 'icon512.png'), ss: 3 });
}

let failed = false;
for (const { size, path, ss } of TARGETS) {
  const png = encodePng(render(size, ss), size, size);

  // Sanity checks before we claim success.
  const sigOk = png.subarray(0, 8).equals(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  );
  if (!sigOk) {
    console.error(`  FAIL ${path}: bad PNG signature`);
    failed = true;
    continue;
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, png);
  console.log(`  ok  ${path.replace(ROOT + '\\', '').replace(ROOT + '/', '')}  ${size}x${size}  ${png.length} bytes`);
}

if (failed) process.exit(1);
console.log('icons: done');
