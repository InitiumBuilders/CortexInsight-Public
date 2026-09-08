// make-icon.js — generates assets/icon.ico (a 256² PNG-in-ICO) with no deps.
// The mark: a deep-space disc with a violet→cyan synaptic glow — the Cortex sigil.
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const S = 256;
const buf = Buffer.alloc(S * S * 4);
function px(x, y, r, g, b, a) { const i = (y * S + x) * 4; buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a; }
const cx = S / 2, cy = S / 2;
for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
  const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy);
  // background near-black
  let r = 5, g = 6, b = 12, a = 255;
  // outer disc
  if (d < 118) {
    const t = d / 118;
    // radial violet core → cyan rim
    r = Math.round(40 + 120 * (1 - t)); g = Math.round(20 + 60 * (1 - t)); b = Math.round(70 + 140 * (1 - t));
    // cyan ring
    const ring = Math.exp(-Math.pow((d - 96) / 10, 2));
    r = Math.min(255, r + ring * 40); g = Math.min(255, g + ring * 180); b = Math.min(255, b + ring * 210);
  }
  // bright core
  const core = Math.exp(-Math.pow(d / 30, 2));
  r = Math.min(255, r + core * 200); g = Math.min(255, g + core * 150); b = Math.min(255, b + core * 255);
  // a couple of synaptic spokes
  const ang = Math.atan2(dy, dx);
  for (const k of [0.4, 2.1, -1.3, 3.6]) {
    const spoke = Math.exp(-Math.pow((((ang - k + Math.PI) % (2 * Math.PI)) - Math.PI) / 0.05, 2)) * Math.exp(-Math.pow((d - 60) / 40, 2));
    r = Math.min(255, r + spoke * 120); g = Math.min(255, g + spoke * 220); b = Math.min(255, b + spoke * 255);
  }
  // round mask (transparent corners)
  if (d > 124) a = 0;
  px(x, y, Math.round(r), Math.round(g), Math.round(b), a);
}
// encode PNG
function crc32(b) { let c = ~0; for (let i = 0; i < b.length; i++) { c ^= b[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } return ~c >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6; // RGBA
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) { raw[y * (S * 4 + 1)] = 0; buf.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4); }
const idat = zlib.deflateSync(raw, { level: 9 });
const png = Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
// wrap PNG in ICO
const ico = Buffer.alloc(6 + 16);
ico.writeUInt16LE(0, 0); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4);
ico[6] = 0; ico[7] = 0; ico[8] = 0; ico[9] = 0; ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12);
ico.writeUInt32LE(png.length, 14); ico.writeUInt32LE(22, 18);
fs.mkdirSync(path.join(__dirname, 'assets'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'assets', 'icon.ico'), Buffer.concat([ico, png]));
fs.writeFileSync(path.join(__dirname, 'assets', 'icon.png'), png);
console.log('icon written:', png.length, 'bytes png');
