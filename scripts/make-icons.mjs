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
 * Design: full-bleed rounded square in deep ink, a white download arrow over an
 * amber baseline. Thick strokes, two colours, no fine detail, so it survives 16px.
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
const PAPER = [0xf8, 0xfa, 0xfc];
const AMBER = [0xf7, 0xb7, 0x33];

const BADGE_RADIUS = 0.215;

// Arrow stem
const STEM_X0 = 0.415, STEM_X1 = 0.585, STEM_Y0 = 0.150, STEM_Y1 = 0.520;
// Arrow head: apex down
const HEAD_APEX_Y = 0.715, HEAD_Y = 0.455, HEAD_X0 = 0.265, HEAD_X1 = 0.735;
// Baseline bar
const BAR_X0 = 0.250, BAR_X1 = 0.750, BAR_Y0 = 0.775, BAR_Y1 = 0.900;

function inRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function inArrow(x, y) {
  if (inRoundedRect(x, y, STEM_X0, STEM_Y0, STEM_X1, STEM_Y1, 0.05)) return true;
  // Triangle (HEAD_X0,HEAD_Y) (HEAD_X1,HEAD_Y) (0.5,HEAD_APEX_Y)
  if (y < HEAD_Y || y > HEAD_APEX_Y) return false;
  const t = (y - HEAD_Y) / (HEAD_APEX_Y - HEAD_Y); // 0 at base, 1 at apex
  const halfW = ((HEAD_X1 - HEAD_X0) / 2) * (1 - t);
  return Math.abs(x - 0.5) <= halfW;
}

function inBar(x, y) {
  return inRoundedRect(x, y, BAR_X0, BAR_Y0, BAR_X1, BAR_Y1, (BAR_Y1 - BAR_Y0) / 2);
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
      let covBadge = 0, covArrow = 0, covBar = 0;
      let bgR = 0, bgG = 0, bgB = 0;

      for (let sy = 0; sy < ss; sy++) {
        const y = (py + (sy + 0.5) / ss) / size;
        for (let sx = 0; sx < ss; sx++) {
          const x = (px + (sx + 0.5) / ss) / size;
          if (!inRoundedRect(x, y, 0, 0, 1, 1, BADGE_RADIUS)) continue;
          covBadge++;
          const c = lerp(INK_TOP, INK_BOTTOM, y);
          bgR += c[0]; bgG += c[1]; bgB += c[2];
          if (inArrow(x, y)) covArrow++;
          else if (inBar(x, y)) covBar++;
        }
      }

      const i = (py * size + px) * 4;
      if (covBadge === 0) {
        out[i] = out[i + 1] = out[i + 2] = out[i + 3] = 0;
        continue;
      }

      // Base colour = average ink under the covered subsamples.
      let r = bgR / covBadge, g = bgG / covBadge, b = bgB / covBadge;

      const aArrow = covArrow / covBadge;
      const aBar = covBar / covBadge;
      r = r * (1 - aArrow) + PAPER[0] * aArrow;
      g = g * (1 - aArrow) + PAPER[1] * aArrow;
      b = b * (1 - aArrow) + PAPER[2] * aArrow;
      r = r * (1 - aBar) + AMBER[0] * aBar;
      g = g * (1 - aBar) + AMBER[1] * aBar;
      b = b * (1 - aBar) + AMBER[2] * aBar;

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

const TARGETS = [
  { size: 16, path: join(ROOT, 'extension', 'icons', 'icon16.png'), ss: 8 },
  { size: 32, path: join(ROOT, 'extension', 'icons', 'icon32.png'), ss: 8 },
  { size: 48, path: join(ROOT, 'extension', 'icons', 'icon48.png'), ss: 6 },
  { size: 128, path: join(ROOT, 'extension', 'icons', 'icon128.png'), ss: 4 },
  { size: 512, path: join(ROOT, 'store', 'assets', 'icon512.png'), ss: 3 },
];

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
