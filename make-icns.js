// make-icns.js — assets/icon.icns from assets/icon.png, no deps.
// An icns file is a container: the magic 'icns' and a total length, then
// entries of a four-byte type, a length (including its own eight-byte header)
// and the data. 'ic08' is a 256×256 PNG. macOS accepts a single size and
// scales it for the Dock and the Finder.
//   node make-icns.js        (run make-icon.js first if assets/icon.png is missing)
const fs = require('fs');
const path = require('path');
const png = fs.readFileSync(path.join(__dirname, 'assets', 'icon.png'));
const entry = (type, data) => {
  const h = Buffer.alloc(8);
  h.write(type, 0, 'ascii');
  h.writeUInt32BE(data.length + 8, 4);
  return Buffer.concat([h, data]);
};
const body = entry('ic08', png);
const head = Buffer.alloc(8);
head.write('icns', 0, 'ascii');
head.writeUInt32BE(body.length + 8, 4);
fs.writeFileSync(path.join(__dirname, 'assets', 'icon.icns'), Buffer.concat([head, body]));
console.log('icns written:', body.length + 8, 'bytes');
