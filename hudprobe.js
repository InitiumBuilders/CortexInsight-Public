// hudprobe.js — why is the HUD a quarter of the screen?
// Dumps every display's DIP bounds vs physical size vs scaleFactor, then creates
// the overlay exactly the way main.js does and reports what it ACTUALLY got.
//   npx electron hudprobe.js
const { app, BrowserWindow, screen } = require('electron');
const path = require('path');

app.whenReady().then(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  console.log('[probe] displays:', displays.length, '| primary id:', primary.id);
  displays.forEach((d, i) => {
    console.log(`[probe]  [${i}] id=${d.id} ${d.id === primary.id ? '(PRIMARY)' : ''} label="${d.label || ''}"`);
    console.log(`[probe]      bounds(DIP) x=${d.bounds.x} y=${d.bounds.y} w=${d.bounds.width} h=${d.bounds.height}`);
    console.log(`[probe]      size(DIP)   w=${d.size.width} h=${d.size.height}   scaleFactor=${d.scaleFactor}`);
    console.log(`[probe]      workArea    x=${d.workArea.x} y=${d.workArea.y} w=${d.workArea.width} h=${d.workArea.height}`);
    console.log(`[probe]      physical    w=${Math.round(d.size.width * d.scaleFactor)} h=${Math.round(d.size.height * d.scaleFactor)}`);
  });

  // build it the way omniOverlayOpen() does NOW — on the display his cursor is
  // on, not a fixed index. Index 0 is his 1280x720 primary; he works on the LG.
  const pt = screen.getCursorScreenPoint();
  const cur = screen.getDisplayNearestPoint(pt);
  const idx = Math.max(0, displays.findIndex((x) => x.id === cur.id));
  console.log(`[probe] cursor at ${pt.x},${pt.y} → display[${idx}] "${cur.label || ''}"`);
  const d = displays[idx];
  const w = new BrowserWindow({
    x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height,
    transparent: true, frame: false, resizable: false, skipTaskbar: true, focusable: false,
    hasShadow: false, alwaysOnTop: true, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload-overlay.js'), contextIsolation: true },
  });
  w.setIgnoreMouseEvents(true, { forward: true });
  await w.loadFile(path.join(__dirname, 'src', 'overlay.html'));
  w.showInactive();
  await wait(700);

  // Prove it on EVERY display, not just wherever the cursor happens to be —
  // the bug only showed on the big one.
  for (let i = 0; i < displays.length; i++) {
    const t = displays[i];
    w.setBounds({ x: t.bounds.x, y: t.bounds.y, width: t.bounds.width, height: t.bounds.height });
    await wait(400);
    const gb = w.getBounds();
    const cov = (gb.width / t.bounds.width) * (gb.height / t.bounds.height);
    const on = screen.getDisplayMatching(gb);
    console.log(`[probe] display[${i}] "${t.label || 'primary'}" ${t.bounds.width}x${t.bounds.height} → got ${gb.width}x${gb.height} @${gb.x},${gb.y} · coverage ${(cov * 100).toFixed(0)}% · landed on ${on.id === t.id ? 'the right screen' : 'THE WRONG SCREEN'} ${cov >= 0.99 && on.id === t.id ? '✓' : '✗'}`);
  }

  const b = w.getBounds();
  const cb = w.getContentBounds();
  console.log(`[probe] ASKED FOR   x=${d.bounds.x} y=${d.bounds.y} w=${d.bounds.width} h=${d.bounds.height}`);
  console.log(`[probe] GOT bounds  x=${b.x} y=${b.y} w=${b.width} h=${b.height}`);
  console.log(`[probe] GOT content x=${cb.x} y=${cb.y} w=${cb.width} h=${cb.height}`);
  const inner = await w.webContents.executeJavaScript(
    'JSON.stringify({iw:innerWidth,ih:innerHeight,dpr:devicePixelRatio,sw:screen.width,sh:screen.height})');
  console.log('[probe] page sees ', inner);
  const cover = (b.width / d.bounds.width) * (b.height / d.bounds.height);
  console.log(`[probe] COVERAGE of the screen he is on: ${(cover * 100).toFixed(0)}%  ${cover < 0.99 ? '<-- NOT FULL SCREEN' : 'FULL SCREEN'}`);
  // and which display does Windows think it landed on?
  const landed = screen.getDisplayMatching(b);
  console.log(`[probe] landed on display id=${landed.id} (${landed.bounds.width}x${landed.bounds.height} @${landed.scaleFactor}x)`);

  setTimeout(() => app.quit(), 400);
});
