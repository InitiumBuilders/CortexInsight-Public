// make-tray-icons.js — three 32² status orbs (good/warn/bad) as ICOs for the tray.
const fs = require('fs'), zlib = require('zlib'), path = require('path');
const S = 32;
const COLORS = {
  good: [[84, 230, 168], [20, 120, 90]],
  warn: [[255, 206, 107], [150, 110, 30]],
  bad: [[255, 93, 120], [150, 30, 50]],
};
function encodePng(buf) {
  function crc32(b) { let c = ~0; for (let i = 0; i < b.length; i++) { c ^= b[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } return ~c >>> 0; }
  function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(S * (S * 4 + 1));
  for (let y = 0; y < S; y++) { raw[y * (S * 4 + 1)] = 0; buf.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4); }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}
function icoWrap(png) {
  const ico = Buffer.alloc(22);
  ico.writeUInt16LE(0, 0); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4);
  ico[6] = S; ico[7] = S; ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12);
  ico.writeUInt32LE(png.length, 14); ico.writeUInt32LE(22, 18);
  return Buffer.concat([ico, png]);
}
fs.mkdirSync(path.join(__dirname, 'assets'), { recursive: true });
for (const [name, [bright, dark]] of Object.entries(COLORS)) {
  const buf = Buffer.alloc(S * S * 4);
  const cx = S / 2 - .5, cy = S / 2 - .5;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const d = Math.hypot(x - cx, y - cy), i = (y * S + x) * 4;
    let a = 0, r = 0, g = 0, b = 0;
    if (d < 13) {
      const t = Math.min(1, d / 13);
      r = Math.round(bright[0] * (1 - t) + dark[0] * t);
      g = Math.round(bright[1] * (1 - t) + dark[1] * t);
      b = Math.round(bright[2] * (1 - t) + dark[2] * t);
      a = 255;
    } else if (d < 15.5) { const k = 1 - (d - 13) / 2.5; r = bright[0]; g = bright[1]; b = bright[2]; a = Math.round(180 * k); }
    buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a;
  }
  const png = encodePng(buf);
  fs.writeFileSync(path.join(__dirname, 'assets', `tray-${name}.ico`), icoWrap(png));   // Windows tray
  fs.writeFileSync(path.join(__dirname, 'assets', `tray-${name}.png`), png);            // macOS menu bar
}
console.log('tray icons written: good/warn/bad (ico + png)');
