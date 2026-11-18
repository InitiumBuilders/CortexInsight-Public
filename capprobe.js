// capprobe.js — is she photographing the screen she THINKS she is?
// Dumps every desktopCapturer source next to every display, checks whether
// display_id actually matches (on Windows it is often EMPTY, which silently
// falls back to array order), and saves each source so I can look at them.
//   npx electron capprobe.js
const { app, desktopCapturer, screen } = require('electron');
const fs = require('fs');
const path = require('path');

app.whenReady().then(async () => {
  const out = path.join(app.getPath('temp'), 'capprobe');
  fs.mkdirSync(out, { recursive: true });
  const displays = screen.getAllDisplays();
  console.log('[cap] displays:');
  displays.forEach((d, i) => console.log(`[cap]   [${i}] id=${d.id} label="${d.label}" ${d.bounds.width}x${d.bounds.height}@${d.bounds.x},${d.bounds.y} scale=${d.scaleFactor}`));

  const t0 = Date.now();
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 700, height: 400 } });
  console.log(`[cap] getSources(700px) took ${Date.now() - t0}ms · ${sources.length} sources`);
  sources.forEach((s, i) => {
    const sz = s.thumbnail.getSize();
    const match = displays.findIndex((d) => String(d.id) === String(s.display_id));
    console.log(`[cap]   src[${i}] id="${s.id}" display_id="${s.display_id}" name="${s.name}" thumb=${sz.width}x${sz.height} → matches displays[${match}]${match < 0 ? '  ⚠ NO MATCH — falls back to ARRAY ORDER' : ''}`);
    const f = path.join(out, `src${i}.png`);
    fs.writeFileSync(f, s.thumbnail.toPNG());
    console.log(`[cap]           saved ${f}`);
  });

  // timing: native capture (what v3.7 does) vs direct small thumbnail
  const big = displays.reduce((a, b) => (a.size.width * a.size.height >= b.size.width * b.size.height ? a : b));
  const bw = Math.round(big.size.width * big.scaleFactor), bh = Math.round(big.size.height * big.scaleFactor);
  const t1 = Date.now();
  await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: bw, height: bh } });
  console.log(`[cap] NATIVE ${bw}x${bh} capture: ${Date.now() - t1}ms   <- what the drive loop does today`);
  const t2 = Date.now();
  await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 700, height: 400 } });
  console.log(`[cap] direct 700px capture:      ${Date.now() - t2}ms   <- what it could do`);

  setTimeout(() => app.quit(), 300);
});
