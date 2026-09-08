/* ============================================================================
   MOTUS MAX HUD — the animation layer.

   What is drawn, and why each thing earns its frame cost:
     · STARFIELD  — a slow drift of faint points. Establishes "this screen is
                    in a different state" without obscuring a single pixel of
                    what is underneath.
     · SWEEP      — one soft scan line crossing the screen each time she takes
                    a new frame. It is not decoration: it is the tell that she
                    just LOOKED. He can see her perceive.
     · PINGS      — an expanding ring exactly where she clicked. The single
                    most useful thing on the whole overlay, because it makes an
                    invisible action visible at the moment it happens.

   PERFORMANCE LAW (this app has caused a machine-wide slowdown once already):
     · one canvas, 30fps ceiling, devicePixelRatio pinned to 1
     · no filter, no shadowBlur in the hot loop except on the few ping rings
     · the loop SUSPENDS itself when nothing is animating and nothing is due
     · everything is additive-light on transparent — never a full-screen fill
   ========================================================================== */
'use strict';

const cv = document.getElementById('sky');
const ctx = cv.getContext('2d', { alpha: true });
const $ = (id) => document.getElementById(id);

const S = {
  live: false, status: 'idle', phase: '', armed: false, remainingMs: 0,
  goal: '', cycle: 0, cursor: 0, maxSteps: 0, agent: '', origin: '', lane: '', pacing: 'auto',
  stars: [], pings: [], sweep: -1, sweepAt: 0, w: 0, h: 0, raf: 0, last: 0, idleFrames: 0,
};

const TONE = {
  thinking: [169, 120, 255],
  acting:   [84, 230, 255],
  waiting:  [255, 206, 107],
  blocked:  [255, 93, 120],
};
function tone() {
  if (S.status === 'waiting') return TONE.waiting;
  if (S.status === 'blocked' || S.status === 'stopped') return TONE.blocked;
  if (S.phase === 'acted' || S.phase === 'ping') return TONE.acting;
  return TONE.thinking;
}

// The window spans every monitor; the STAGE is the screen he is on. Stars and
// the sweep are drawn only inside the stage, so the other monitor stays clean.
S.stage = { x: 0, y: 0, w: 0, h: 0 };
function applyStage(r) {
  if (!r) return;
  const jumped = Math.abs(r.x - S.stage.x) > 40 || Math.abs(r.y - S.stage.y) > 40;
  S.stage = { x: r.x, y: r.y, w: r.w, h: r.h };
  const el = document.getElementById('stage');
  // ADAPT TO THE DISPLAY. A chip sized in fixed pixels is a postage stamp on a
  // 2560-wide monitor and overbearing on a 1280 laptop. One scale factor,
  // derived from the stage's own width, drives every size in the HUD — so it
  // reads the same at any resolution he moves it to, including mid-session.
  if (el) {
    const k = Math.max(0.82, Math.min(1.55, r.w / 1440));
    el.style.setProperty('--k', k.toFixed(3));
  }
  if (el) {
    // Moving to another monitor snaps instantly — a 200ms slide across a
    // 3840px desktop looks like a bug, not a transition.
    if (jumped) { el.classList.add('snap'); requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove('snap'))); }
    el.style.left = r.x + 'px'; el.style.top = r.y + 'px'; el.style.width = r.w + 'px'; el.style.height = r.h + 'px';
  }
  seedStars();
}
function resize() {
  S.w = cv.width = window.innerWidth;
  S.h = cv.height = window.innerHeight;
  if (!S.stage.w) S.stage = { x: 0, y: 0, w: S.w, h: S.h };
  seedStars();
}
function seedStars() {
  const st = S.stage.w ? S.stage : { x: 0, y: 0, w: S.w, h: S.h };
  const n = Math.min(90, Math.round((st.w * st.h) / 26000));   // ~70 on a 1080p screen
  S.stars = Array.from({ length: n }, () => ({
    x: st.x + Math.random() * st.w, y: st.y + Math.random() * st.h,
    r: Math.random() * 1.25 + 0.35,
    a: Math.random() * 0.45 + 0.12,
    vy: (Math.random() * 0.16 + 0.04),
    tw: Math.random() * Math.PI * 2,
  }));
}
window.addEventListener('resize', resize);

/* ---------------------------------------------------------------- the loop */
function frame(ts) {
  S.raf = 0;
  const dt = Math.min(64, ts - (S.last || ts));
  S.last = ts;
  ctx.clearRect(0, 0, S.w, S.h);

  if (!S.live) { S.idleFrames = 999; return; }   // cleared and stopped — costs nothing

  const [r, g, b] = tone();
  let busy = false;

  // stars — confined to the screen he is on
  const SG = S.stage.w ? S.stage : { x: 0, y: 0, w: S.w, h: S.h };
  for (const st of S.stars) {
    st.y += st.vy * (dt / 16.7);
    st.tw += 0.012 * (dt / 16.7);
    if (st.y > SG.y + SG.h + 2) { st.y = SG.y - 2; st.x = SG.x + Math.random() * SG.w; }
    const a = st.a * (0.62 + 0.38 * Math.sin(st.tw));
    ctx.fillStyle = `rgba(${r},${g},${b},${a.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(st.x, st.y, st.r, 0, 6.2832);
    ctx.fill();
  }
  busy = true;   // the starfield always animates while live

  // the sweep — fires when she takes a frame
  if (S.sweep >= 0) {
    S.sweep += (SG.h + 260) * (dt / 1500);
    const y = SG.y + S.sweep;
    const grad = ctx.createLinearGradient(0, y - 130, 0, y + 26);
    grad.addColorStop(0, `rgba(${r},${g},${b},0)`);
    grad.addColorStop(0.82, `rgba(${r},${g},${b},0.05)`);
    grad.addColorStop(1, `rgba(${r},${g},${b},0.16)`);
    ctx.fillStyle = grad;
    ctx.fillRect(SG.x, y - 130, SG.w, 156);
    ctx.fillStyle = `rgba(${r},${g},${b},0.5)`;
    ctx.fillRect(SG.x, y, SG.w, 1.1);
    if (S.sweep > SG.h + 200) S.sweep = -1;
  }

  // pings — where she actually touched the screen
  for (let i = S.pings.length - 1; i >= 0; i--) {
    const p = S.pings[i];
    p.t += dt / 780;
    if (p.t >= 1) { S.pings.splice(i, 1); continue; }
    const e = 1 - Math.pow(1 - p.t, 3);              // ease-out
    const rad = 8 + e * 62;
    const alpha = (1 - p.t) * 0.85;
    ctx.save();
    ctx.strokeStyle = `rgba(${p.c[0]},${p.c[1]},${p.c[2]},${alpha.toFixed(3)})`;
    ctx.lineWidth = 2.2 * (1 - p.t) + 0.6;
    ctx.shadowColor = `rgba(${p.c[0]},${p.c[1]},${p.c[2]},${(alpha * 0.8).toFixed(3)})`;
    ctx.shadowBlur = 18;
    ctx.beginPath(); ctx.arc(p.x, p.y, rad, 0, 6.2832); ctx.stroke();
    // a second, tighter ring for the double/right click so they read differently
    if (p.k !== 'click') {
      ctx.beginPath(); ctx.arc(p.x, p.y, rad * 0.58, 0, 6.2832); ctx.stroke();
    }
    // the crosshair core
    ctx.shadowBlur = 0;
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.moveTo(p.x - 11, p.y); ctx.lineTo(p.x - 4, p.y);
    ctx.moveTo(p.x + 4, p.y);  ctx.lineTo(p.x + 11, p.y);
    ctx.moveTo(p.x, p.y - 11); ctx.lineTo(p.x, p.y - 4);
    ctx.moveTo(p.x, p.y + 4);  ctx.lineTo(p.x, p.y + 11);
    ctx.stroke();
    ctx.restore();
    busy = true;
  }

  if (busy) S.raf = requestAnimationFrame(throttled);
}
// 30fps ceiling. rAF gives 60+; half of those frames would be paid for nothing.
let _acc = 0, _prev = 0;
function throttled(ts) {
  S.raf = 0;
  if (!_prev) _prev = ts;
  _acc += ts - _prev; _prev = ts;
  if (_acc < 33) { S.raf = requestAnimationFrame(throttled); return; }
  _acc = 0;
  frame(ts);
}
function kick() { if (!S.raf && S.live) { _prev = 0; S.raf = requestAnimationFrame(throttled); } }

/* --------------------------------------------------------------- the chip */
function fmtLeft(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
const PHASE_WORD = {
  reading: 'reading your whole system to choose the move', session: 'starting', frame: 'looking at your screen',
  thought: '▸', acted: 'moving', ask: 'waiting on you', approve: 'waiting on your tap',
  working: 'working in your files — your pointer stays yours',
  move: 'moving in your files',
  call: 'consulting another agent', called: 'consulting another agent', steer: 'you steered her',
  armed: 'armed and standing by', ended: 'finished', zoom: 'changing altitude',
  thinking: 'thinking',
};
function paintChip() {
  const standby = S.status === 'standby';
  document.body.classList.toggle('live', S.live);
  document.body.classList.toggle('standby', standby);
  document.body.classList.toggle('acting', !standby && (S.phase === 'acted' || S.phase === 'ping'));
  document.body.classList.toggle('waiting', S.status === 'waiting');
  document.body.classList.toggle('blocked', S.status === 'blocked' || S.status === 'stopped');

  // Name the MODE, not just whose idea it was. "HER CALL" sitting still for
  // four minutes reads as frozen; "WORKING" with a ticking clock reads as work.
  // ASK-FIRST IS NAMED, ALWAYS. He ran a whole session convinced she was in
  // full drive while every batch sat waiting for his tap — nothing on screen
  // ever told him. If she has to ask before she moves, the glass says so.
  const gated = S.pacing === 'ask' && !standby;
  $('mode').textContent = S.listening ? 'MOTUS MAX · LISTENING'
    : standby ? `MOTUS MAX · ARMED${S.pacing === 'ask' ? ' · ASK FIRST' : ''}`
    : gated ? 'MOTUS MAX · ASK FIRST — SHE WAITS FOR YOUR TAP'
    : S.mode === 'work' ? 'MOTUS MAX · WORKING'
    : S.origin === 'chosen' ? 'MOTUS MAX · HER CALL'
    : S.origin === 'resumed' ? 'MOTUS MAX · RESUMING' : 'MOTUS MAX · DRIVING';
  // Standby states the NEXT ACTION, because arming without knowing how to start
  // is exactly the dead end this HUD exists to prevent.
  const word = PHASE_WORD[S.phase] || (S.status === 'running' ? 'driving' : S.status);
  // WAITING is the one state that must never be truncated: it is a question he
  // has to answer for anything to continue. It gets the full text and the
  // cheapest possible way to reply — his voice.
  const waiting = S.status === 'waiting';
  document.body.classList.toggle('asking', waiting);
  // THE MOVE TICKER ON THE GLASS. A work turn used to show one frozen line for
  // minutes; now the newest real tool move — the file she is editing, the
  // command she just ran — takes the headline while she works, so watching the
  // HUD is watching the work happen. The goal drops to the meta line.
  $('what').textContent = standby
    ? 'say “Motus Max” out loud, or press Drive Now in the app'
    : waiting
      ? (S.question || S.goal || 'she needs an answer')
      : (S.mode === 'work' && S.move)
        ? S.move
        : (S.goal ? `${word} — ${S.goal}` : word);
  $('ask-hint').textContent = S.listening ? '🎙 listening — speak your direction, it sends when you stop'
    : waiting ? 'answer out loud, or press Ctrl+Shift+M and speak' : '';
  // Name the key that is ACTUALLY bound. Advertising a kill switch that failed
  // to register is the one lie this HUD must never tell.
  const pk = (S.panicKey || '').replace('CommandOrControl', 'CTRL').replace(/\+/g, '+').toUpperCase();
  $('kill').textContent = S.listening ? 'CTRL+SHIFT+M AGAIN TO CANCEL'
    : pk ? `CTRL+SHIFT+M TO STEER · ${pk} TO STOP`
    : '⚠ NO PANIC KEY AVAILABLE — STOP FROM THE APP';
  // THE LANE, NAMED ON SCREEN. Two seats now take turns driving, and a split he
  // cannot see is a split he has to take on faith. ⚡ means the fast reflex lane
  // executing a plan she already made; ◈ means she is thinking herself.
  const lane = S.lane === 'reflex' ? ' · ⚡ reflex' : S.lane === 'strategic' ? ' · ◈ her' : '';
  $('meta').textContent = standby ? (S.agent ? S.agent + ' ready' : 'ready')
    : S.mode === 'work' ? (S.move ? `${S.elapsed || 0}s · ${S.goal || 'working'}`.slice(0, 120) : `${S.elapsed || 0}s · one turn, full depth`)
    : (S.maxSteps ? `cycle ${S.cycle} · ${S.cursor}/${S.maxSteps}${lane}` : (S.agent || '—'));
  $('fuse').textContent = S.armed ? `fuse ${fmtLeft(S.remainingMs)}` : 'disarmed';
}

/* --------------------------------------------------------- main → overlay */
window.hud.on((d) => {
  if (!d) return;
  if (d.kind === 'close') {
    S.live = false;
    document.body.classList.remove('live');
    return;
  }
  if (d.kind === 'stage') { applyStage(d.stage); kick(); return; }
  if (d.kind === 'ping') {
    S.pings.push({ x: d.x, y: d.y, t: 0, k: d.ping || 'click', c: TONE.acting });
    S.pings = S.pings.slice(-6);
    S.phase = 'ping';
    kick(); paintChip();
    return;
  }
  // state
  if (d.armed != null) S.armed = d.armed;
  if (d.remainingMs != null) S.remainingMs = d.remainingMs;
  if (d.status) S.status = d.status;
  if (d.goal != null) S.goal = d.goal;
  if (d.question != null) S.question = d.question;
  if (d.cycle != null) S.cycle = d.cycle;
  if (d.cursor != null) S.cursor = d.cursor;
  if (d.maxSteps != null) S.maxSteps = d.maxSteps;
  if (d.agent) S.agent = d.agent;
  if (d.origin) S.origin = d.origin;
  if (d.phase) S.phase = d.phase;
  if (d.mode) S.mode = d.mode;
  if (d.move) S.move = d.move;
  // a fresh session or a session end clears the last move so an old file name
  // never lingers as if it were current work
  if (d.kind === 'state' && d.status && d.status !== 'running') S.move = '';
  if (d.lane) S.lane = d.lane;
  if (d.pacing) S.pacing = d.pacing;
  if (d.elapsed != null) S.elapsed = d.elapsed;
  if (d.listening != null) { S.listening = d.listening; document.body.classList.toggle('listening', !!d.listening); }
  if (d.panicKey != null) S.panicKey = d.panicKey;
  // a new frame means she just LOOKED — send the sweep across
  if (d.phase === 'frame') S.sweep = -60;
  // 'standby' counts as live: the whole point is that arming is VISIBLE.
  S.live = S.status === 'running' || S.status === 'waiting' || S.status === 'standby' || d.phase === 'reading';
  paintChip();
  kick();
});

// The fuse ticks locally so it stays honest between pushes from main.
setInterval(() => {
  if (!S.live || !S.armed) return;
  S.remainingMs = Math.max(0, S.remainingMs - 1000);
  $('fuse').textContent = `fuse ${fmtLeft(S.remainingMs)}`;
}, 1000);

resize();
paintChip();
