// hudtest.js — proves the Motus Max HUD with your own eyes, and proves the one
// property that cannot be checked by looking: that it is INVISIBLE to her.
//
// It opens the overlay, drives it through the real states, captures the screen
// through the same desktopCapturer path she uses, and writes two PNGs:
//   hud-visible.png  — what August sees (captured with content protection OFF)
//   hud-hidden.png   — what SHE sees (content protection ON, the shipped setting)
// If the second one contains the HUD, the drive loop would photograph its own
// telemetry and read it as his screen. That is the whole test.
//
//   npx electron hudtest.js
const { app, BrowserWindow, desktopCapturer, screen } = require('electron');
const path = require('path');
const fs = require('fs');

const OUT = path.join(app.getPath('temp'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function shoot(name, target) {
  const d = target || screen.getPrimaryDisplay();
  const sf = d.scaleFactor || 1;
  const w = Math.round(d.size.width * sf), h = Math.round(d.size.height * sf);
  const srcs = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.min(1400, w), height: Math.round(h * Math.min(1400, w) / w) } });
  const src = srcs.find((s) => String(s.display_id) === String(d.id)) || srcs[0];
  const f = path.join(OUT, name);
  fs.writeFileSync(f, src.thumbnail.toPNG());
  console.log('[hudtest] wrote', f, Math.round(fs.statSync(f).size / 1024) + ' KB');
  return f;
}

app.whenReady().then(async () => {
  // span every monitor, exactly as the app does now
  const all = screen.getAllDisplays().map((x) => x.bounds);
  const ux = Math.min(...all.map((b) => b.x)), uy = Math.min(...all.map((b) => b.y));
  const u = { x: ux, y: uy,
    width: Math.max(...all.map((b) => b.x + b.width)) - ux,
    height: Math.max(...all.map((b) => b.y + b.height)) - uy };
  const cur = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const d = cur;
  const win = new BrowserWindow({
    x: u.x, y: u.y, width: u.width, height: u.height,
    resizable: true, maxWidth: u.width, maxHeight: u.height,
    transparent: true, frame: false, skipTaskbar: true, focusable: false,
    hasShadow: false, alwaysOnTop: true, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload-overlay.js'), contextIsolation: true },
  });
  win.setMaximumSize(u.width, u.height); win.setBounds(u);
  win.setIgnoreMouseEvents(true, { forward: true });
  win.setAlwaysOnTop(true, 'screen-saver');
  await win.loadFile(path.join(__dirname, 'src', 'overlay.html'));
  win.showInactive();
  await wait(400);
  const gb = win.getBounds();
  console.log(`[hudtest] union asked ${u.width}x${u.height} · got ${gb.width}x${gb.height} @${gb.x},${gb.y}`);
  console.log(`[hudtest] framing "${d.label || 'primary'}" ${d.bounds.width}x${d.bounds.height}`);
  const push = (o) => win.webContents.send('hud', o);
  push({ kind: 'stage', stage: { x: d.bounds.x - u.x, y: d.bounds.y - u.y, w: d.bounds.width, h: d.bounds.height } });
  await wait(700);

  // ARMED · STANDBY — the state August never got to see, because arming used to
  // raise nothing at all. This is the "golden" hold: unmistakably on, and it
  // states the next action so arming can never again be a dead end.
  console.log('[hudtest] 0 · ARMED / STANDBY (the golden hold)…');
  push({ kind: 'state', armed: true, remainingMs: 25 * 60000, status: 'standby', phase: 'armed', agent: 'Davara', goal: '' });
  await wait(900);
  await shoot('hud-standby.png');

  console.log('[hudtest] driving the HUD through its real states…');
  push({ kind: 'state', armed: true, remainingMs: 22 * 60000, status: 'running', origin: 'chosen',
    goal: 'Mint MotusModel One and hand the skill link to one person who is not August',
    cycle: 3, cursor: 7, maxSteps: 60, agent: 'Davara', phase: 'frame' });
  await wait(700);
  // clicks land where she clicked
  push({ kind: 'ping', ping: 'click', x: Math.round(d.bounds.width * 0.42), y: Math.round(d.bounds.height * 0.38) });
  await wait(220);
  push({ kind: 'ping', ping: 'dblclick', x: Math.round(d.bounds.width * 0.63), y: Math.round(d.bounds.height * 0.55) });
  push({ kind: 'state', phase: 'acted', status: 'running' });
  await wait(500);

  // 1 · what August sees
  console.log('[hudtest] capturing WITH the HUD visible (what August sees)…');
  await shoot('hud-visible.png');

  // 2 · what she sees — the shipped setting
  console.log('[hudtest] enabling content protection, capturing again (what SHE sees)…');
  win.setContentProtection(true);
  await wait(700);
  push({ kind: 'state', phase: 'thought', status: 'running' });
  await wait(400);
  await shoot('hud-hidden.png');

  // 3 · the waiting + blocked palettes, so the colour states are eyeballed too
  win.setContentProtection(false);
  push({ kind: 'state', status: 'waiting', phase: 'ask', goal: 'Which of the two payout addresses should I use?' });
  await wait(800);
  await shoot('hud-waiting.png');

  // THE THING HE REPORTED: pick the OTHER monitor and prove the HUD lands there,
  // full size, by photographing that monitor.
  const all2 = screen.getAllDisplays();
  if (all2.length > 1) {
    const other = all2.find((x) => x.id !== screen.getPrimaryDisplay().id) || all2[1];
    console.log(`[hudtest] framing the OTHER monitor: "${other.label}" ${other.bounds.width}x${other.bounds.height}`);
    push({ kind: 'stage', stage: { x: other.bounds.x - u.x, y: other.bounds.y - u.y, w: other.bounds.width, h: other.bounds.height } });
    push({ kind: 'state', armed: true, remainingMs: 25 * 60000, status: 'standby', phase: 'armed', agent: 'Davara' });
    await wait(900);
    await shoot('hud-other-monitor.png', other);
  }

  console.log('[hudtest] done — compare hud-visible.png and hud-hidden.png');
  setTimeout(() => app.quit(), 500);
});
