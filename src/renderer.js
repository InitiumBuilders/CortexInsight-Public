/* ============================================================================
   CortexInsight — renderer
   Login gate · living neural field · 11 sections · /steer & /goal · live pulse.
   Talks to the main process only through window.cortex (see preload.js).
   ============================================================================ */
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const C = window.cortex;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
// 2026-09-02: sympath-sei moved rose -> spring. Rose was serving two agents at once, and
// colour is the only disambiguator Davari has in the constellation (davara/davaris/davari
// all render the letter 'D'). Davari keeps rose; the external agent took the new tone.
const TONE = { davara: 'violet', davaris: 'cyan', davari: 'rose', 'sympath-cortex': 'emerald', arden: 'gold', august: 'amber', 'august-v3': 'slate', 'sympath-sei': 'spring' };
const ANAME = { davara: 'Davara', davaris: 'Davaris', davari: 'Davari', 'sympath-cortex': 'Sympath-Cortex', arden: 'Arden AI', august: 'August', 'august-v3': 'August-V3', 'sympath-sei': 'Sympath SEI' };
const aname = (id) => ANAME[id] || cap(id);
// The live fleet, fetched once at boot and refreshed on config changes. Every
// agent picker in the app reads from HERE, so no screen can miss an agent.
let FLEET_LIVE = [];
let QUALITY_LIVE = [];
let MODELS_LIVE = [];
let CONTROL = { stopped: false, hard: false };
const relayFleet = () => FLEET_LIVE.filter((f) => f.lane === 'relay');
const fleetIds = () => FLEET_LIVE.map((f) => f.id);
const QLABEL = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'X-High', max: 'ULTRACODE' };
const mlabel = (id) => (MODELS_LIVE.find((m) => m.id === id) || {}).label || id || '—';
let CUR = { view: 'overview', chatAgent: 'davara', workAgent: 'davara', taskAgent: 'all', taskStatus: 'all',
  subAgent: 'all', boardFilter: 'open', wfEdit: null, usageWin: 'fiveH' };
let SETTINGS = null;

/* ---------- formatting ---------- */
function fmtDur(ms) {
  if (ms == null || ms < 0 || !isFinite(ms)) return '—';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  if (d) return `${d}d ${h}h`; if (h) return `${h}h ${m}m`; if (m) return `${m}m ${ss}s`; return `${ss}s`;
}
function fmtSecs(sec) {
  if (!sec) return '0s'; const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  if (sec >= 3600) return `${(sec / 3600).toFixed(1)}h`; if (m) return `${m}m ${s}s`; return `${s.toFixed ? Math.round(sec) : s}s`;
}
function compact(n) {
  n = n || 0; if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B'; if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'; if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'; return String(Math.round(n));
}
function ago(ts) {
  const e = typeof ts === 'number' ? ts : Date.parse(String(ts).replace(' ', 'T'));
  if (!e) return '—'; const d = (Date.now() - e) / 1000;
  if (d < 60) return `${Math.round(d)}s`; if (d < 3600) return `${Math.round(d / 60)}m`; if (d < 86400) return `${Math.round(d / 3600)}h`; return `${Math.round(d / 86400)}d`;
}
function statusClass(s) { s = String(s || ''); return s.startsWith('OK') ? 's-ok' : s.startsWith('FAULT') || s.startsWith('TIMEOUT') ? 's-fault' : 's-other'; }

/* ---------- no-flicker rendering core ----------
   Every poll used to rebuild innerHTML even when nothing changed — that was the
   screen-flash AND it destroyed text selection. setHTML() hashes the markup and
   touches the DOM only when the content truly changed. Returns true on change
   (so event listeners are re-attached only then). */
const _domHash = new WeakMap();
function djb2(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return h; }
// One counter, incremented only when the DOM genuinely changed. It is the
// cheapest possible signal for "is anything happening?", and it is already
// being computed — setHTML has always known the answer and thrown it away.
let _domWrites = 0;
function setHTML(el, html) {
  if (!el) return false;
  const h = djb2(html);
  if (_domHash.get(el) === h) return false;
  // THE PULSE ON CHANGE. This is the one place every paint passes, so it is
  // the one place that can know which strip figure actually moved. Snapshot
  // the old figures, write, then mark the cells whose figure differs: one
  // transform-only lift, once. Skipped while the window is idle (nobody is
  // looking) and for hosts that hold no strip (almost every write).
  const old = (_domHash.has(el) && !document.body.classList.contains('win-idle') && el.firstElementChild)
    ? Array.from(el.querySelectorAll('.st-si > b')).map((b) => b.textContent) : null;
  _domHash.set(el, h);
  el.innerHTML = html;
  _domWrites++;
  if (old && old.length) {
    const cells = el.querySelectorAll('.st-si');
    for (let i = 0; i < cells.length && i < old.length; i++) {
      const b = cells[i].querySelector('b');
      if (b && b.textContent !== old[i]) cells[i].classList.add('moved');
    }
  }
  return true;
}
function copyText(t, label) {
  if (!navigator.clipboard) { toast('Copy unavailable', 'bad'); return; }
  navigator.clipboard.writeText(t == null ? '' : String(t)).then(() => toast((label || 'Copied') + ' ✓', 'good')).catch(() => toast('Copy failed', 'bad'));
}
// safe escaping for single-quoted-or-anything attributes (covers ' too)
const escAttr = (s) => esc(s).replace(/'/g, '&#39;');
// robust timestamp formatter — never shows "Invalid Date"
function fmtTs(ts) { const d = new Date(ts); return isNaN(d.getTime()) ? String(ts || '—') : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }); }
const PER_PAGE = 8;
const PAGE = {};   // containerId -> how many items shown (the "max to view at a time")
// Renders the first N of a list with a Show-more / Collapse control. This is what
// keeps reflections, learnings, logs from running off-screen forever.
function capList(id, items, renderItem) {
  const shown = PAGE[id] || PER_PAGE;
  let html = items.slice(0, shown).map(renderItem).join('');
  if (items.length > shown) html += `<button class="show-more" data-more="${id}">▾ Show ${Math.min(PER_PAGE, items.length - shown)} more · ${items.length - shown} hidden of ${items.length}</button>`;
  else if (shown > PER_PAGE && items.length > PER_PAGE) html += `<button class="show-more" data-more="${id}" data-collapse="1">▴ Collapse to ${PER_PAGE}</button>`;
  return html;
}
// One delegated listener for read / expand / copy / show-more / clear across the whole app.
document.addEventListener('click', (e) => {
  const more = e.target.closest('[data-more]');
  if (more) { const id = more.dataset.more; PAGE[id] = more.dataset.collapse ? PER_PAGE : (PAGE[id] || PER_PAGE) + PER_PAGE; loadView(CUR.view); return; }
  const clr = e.target.closest('[data-clear]');
  if (clr) { e.stopPropagation(); handleClear(clr.dataset.clear, clr.dataset.clearLabel || clr.dataset.clear); return; }
  const rd = e.target.closest('[data-read]');
  if (rd) { e.stopPropagation(); const it = rd.closest('[data-body]'); if (it) openReader(it.dataset.title || it.dataset.rtitle || 'Full text', it.dataset.body, it.dataset.rsub || ''); return; }
  const cp = e.target.closest('[data-copy]');
  if (cp) { e.stopPropagation(); copyText(cp.dataset.copy); return; }
  const ex = e.target.closest('.expandable');
  if (ex && !e.target.closest('button,a,input,textarea')) {
    // ⚠ THE CARD THAT CLOSED ITSELF. The toggle was always correct — but Live
    // is on the 4s auto-refresh list, and setHTML replaces innerHTML, so the
    // freshly-opened element was destroyed and rebuilt closed a beat later.
    // Open-ness is USER STATE and must not live only in the DOM. Keyed here so
    // it survives every repaint, and stays open until he closes it.
    ex.classList.toggle('open');
    const k = expKey(ex);
    if (k) { if (ex.classList.contains('open')) OPEN_EXP.add(k); else OPEN_EXP.delete(k); }
  }
});
// Full-text reader — the always-available "view / read more" for anything long.
function openReader(title, body, sub) {
  let m = $('#reader');
  if (!m) {
    m = document.createElement('div'); m.id = 'reader'; m.className = 'reader';
    m.innerHTML = '<div class="reader-card glass-deep"><div class="reader-head"><div class="reader-title"></div>'
      + '<div class="reader-actions"><button class="mini" id="readerCopy">⧉ copy</button><button class="mini" id="readerClose">✕ close</button></div></div>'
      + '<div class="reader-sub"></div><div class="reader-body"></div></div>';
    document.body.appendChild(m);
    m.addEventListener('click', (ev) => { if (ev.target === m) closeReader(); });
  }
  $('.reader-title', m).textContent = title || 'Full text';
  $('.reader-sub', m).textContent = sub || '';
  $('.reader-body', m).textContent = body || '(no content)';
  $('#readerCopy', m).onclick = () => copyText((title ? title + '\n\n' : '') + (body || ''), 'Copied');
  $('#readerClose', m).onclick = closeReader;
  m.classList.add('open');
}
function closeReader() { const m = $('#reader'); if (m) m.classList.remove('open'); }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeReader(); });
async function handleClear(key, label) {
  if (key === 'chat') { chatMsgs.length = 0; seedChatGreeting(); toast('Conversation cleared', 'good'); return; }
  if (key === 'livefeed') { LIVE.events = []; LIVE.rendered = 0; renderLive(true); toast('Feed cleared', 'good'); return; }
  if (!confirm(`Clear ${label}?\n\nThis wipes CortexInsight's own record only — it never touches the fleet logs. Cannot be undone.`)) return;
  const r = await C.clear(key);
  if (r && r.ok) { toast('Cleared ✓', 'good'); if (key === 'notifications') loadNotifications(); loadView(CUR.view); }
  else toast('Could not clear: ' + ((r && r.error) || '?'), 'bad');
}
function toast(msg, kind = '') {
  let t = $('.toast'); if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
  t.className = `toast ${kind}`; t.textContent = msg; requestAnimationFrame(() => t.classList.add('show'));
  clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), 3200);
}

/* Which expandables he opened, by a key that survives a rebuild. Bounded so a
   long session cannot grow it without limit. */
const OPEN_EXP = new Set();
function expKey(el) {
  if (!el) return '';
  if (el.dataset && el.dataset.expKey) return el.dataset.expKey;
  const host = el.closest('[data-agent],[data-task],[data-ts]');
  const base = host ? (host.dataset.agent || host.dataset.task || host.dataset.ts || '') : '';
  if (!base) return '';
  const sibs = Array.from(host.querySelectorAll('.expandable'));
  return base + '#' + sibs.indexOf(el);
}
/* Re-apply after any render. Cheap: only touches elements that ARE keyed. */
function restoreExpanded(root) {
  if (!OPEN_EXP.size) return;
  for (const el of (root || document).querySelectorAll('.expandable')) {
    const k = expKey(el);
    if (k && OPEN_EXP.has(k)) el.classList.add('open');
  }
  if (OPEN_EXP.size > 200) OPEN_EXP.clear();
}

/* ============================ WINDOW CONTROLS ============================ */
$('#winMin').onclick = () => C.win.min();
$('#winMax').onclick = () => C.win.max();
$('#winClose').onclick = () => C.win.close();

/* ============================ LOGIN GATE ============================ */
const gate = $('#gate');
/* FIRST RUN — a fresh vault has no password; the gate creates one, once, and
   the hash lives in the vault. Nothing is shipped in the code any more. */
let GATE_SETUP = false;
function gateSetupMode() {
  GATE_SETUP = true;
  $('#gateTag').textContent = 'First run. Create the passphrase that opens this console; it is stored as a hash, never as text.';
  $('#gatePass').placeholder = 'New passphrase (12+ characters)';
  const p2 = $('#gatePass2'); if (p2) p2.hidden = false;
  $('#gateBtn').textContent = 'Create and enter';
}
if (C.guardStatus) C.guardStatus().then((g) => { if (g && g.needsSetup) gateSetupMode(); }).catch(() => {});
$('#gateForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pass = $('#gatePass').value;
  const btn = $('#gateBtn'); btn.disabled = true; btn.textContent = 'Verifying…';
  if (GATE_SETUP) {
    const p2 = ($('#gatePass2') || {}).value || '';
    const err = $('#gateErr');
    const fail = (m) => { err.textContent = m; err.classList.add('show'); btn.disabled = false; btn.textContent = 'Create and enter'; gate.classList.add('shake'); setTimeout(() => gate.classList.remove('shake'), 460); };
    if (pass.length < 12) return fail('Use at least 12 characters.');
    if (pass !== p2) return fail('The two entries do not match.');
    const s = await C.setup(pass).catch(() => null);
    if (!s || !s.ok) return fail(s && s.reason === 'link-unavailable' ? 'Could not reach the Cortex on this network. Retry shortly.' : 'Could not create the passphrase.');
    btn.textContent = 'Welcome';
    setTimeout(boot, 240);
    return;
  }
  const r = await C.unlock(pass);
  if (r.ok) {
    btn.textContent = 'Welcome, August';
    setTimeout(boot, 240);
  } else if (r.reason === 'link-unavailable') {
    // discreet: looks like an ordinary connectivity problem on this network
    $('#gateTag').textContent = 'Establishing secure link to the Cortex…';
    $('#gateForm').style.display = 'none';
    setTimeout(() => { $('#gateErr').textContent = 'Could not reach the Cortex on this network. Retry shortly.'; $('#gateErr').classList.add('show'); }, 2600);
  } else {
    gate.classList.add('shake'); const err = $('#gateErr'); err.textContent = 'Passphrase not recognized.'; err.classList.add('show');
    btn.disabled = false; btn.textContent = 'Enter the Cortex'; $('#gatePass').value = ''; $('#gatePass').focus();
    setTimeout(() => gate.classList.remove('shake'), 460);
  }
});
window.addEventListener('DOMContentLoaded', () => { $('#gatePass').focus(); startField(); });
// returning from tray/minimize: refresh immediately and re-establish the live watch
// (main stops the transcript tail while hidden to save resources)
document.addEventListener('visibilitychange', () => {
  if (document.hidden || document.body.classList.contains('locked')) return;
  tick();
  if (CUR.view === 'live' && LIVE.active) startLive();
});

/* ============================ BOOT ============================ */
let pollTimer = null;
async function boot() {
  document.body.classList.remove('locked');
  const st = await C.settings(); SETTINGS = st.settings; CUR.chatAgent = SETTINGS.defaultAgent || 'davara';
  if (SETTINGS.reduceMotion) document.body.classList.add('reduce-motion');
  await refreshFleet();     // every agent picker in the app reads from this
  buildNav();
  wireControlBar();
  seedChatGreeting();
  loadNotifications();
  await refreshAll();
  checkUpdate();            // a staged build he has not installed is a build he does not have
  clearInterval(pollTimer);
  paintSigil(CUR.view || 'overview');
  // ⚠ MEASURED: the attention sweep grew from three IPC calls to five (overview
  // and loops are among the heaviest in the app), and firing them all during
  // boot starved the first view load — the MotusLive view came up EMPTY, with
  // no error anywhere, because its own fetch simply never finished in time.
  // Attention is a minute-scale question; it has no business competing with
  // first paint. Let the app come up, then read the system.
  setTimeout(() => { if (!document.hidden) syncAttention(); }, 5000);
  _pollMs = SETTINGS.pollMs || POLL_FAST;
  pollTimer = setInterval(() => { if (!document.hidden) tick(); }, _pollMs);
  // The rail's own reading runs on a slower beat than the pulse — attention is
  // a minute-scale question, and polling it at 4s would be three wasted reads
  // out of every four.
  setInterval(() => { if (!document.hidden) syncAttention(); }, 90000);
}

/* ============================ NAV ============================ */
// [id, label, icon path, hue, group] — the 4th field is each view's OWN LIGHT,
// the 5th is where it sits in the flow.
//
// ⚠ THE ORGANISING IDEA, because twenty-five flat items is not a menu, it is a
// pile. These are grouped by WHAT HE IS DOING, not by what the feature is
// called, and ordered the way a session actually runs:
//
//   NOW    — orient. where am I, what matters, what is happening right now.
//   MOVE   — act. the surfaces that change something in the world.
//   FLEET  — who is working, and what they are.
//   SIGNAL — what went out and what came back.
//   MIND   — think about the system itself.
//   CORE   — the machine under it: keys, models, config, depth.
//
// The rail is a circuit, so the groups are stations on one line — every view
// carries its own hue, the active node glows in it, and the page tints toward
// it (--view-hue). Variety with a spine, not twenty-five decorations.
const NAV = [
  ['overview', 'Pulse', 'M3 12h4l2 6 4-14 2 8h6', 195, 'NOW'],
  ['motus', 'Motus', 'M13 3L4 14h6l-1 7 9-11h-6z', 265, 'NOW'],
  ['goal', 'Goal', 'M12 3a9 9 0 1 0 .01 0M12 8a4 4 0 1 0 .01 0M12 12a.6 .6 0 1 0 .01 0', 45, 'NOW'],
  // LIVE rides fourth — August: "put Live right after the Goal tab". Watching
  // the work happen is a first-class activity, not a footnote.
  ['live', 'Live', 'M12 11.5a.6 .6 0 1 0 .01 0M8 8a5.7 5.7 0 0 0 0 8M16 8a5.7 5.7 0 0 1 0 8M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14', 350, 'NOW'],

  ['omni', 'Motus Max', 'M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1M12 8.2a3.8 3.8 0 1 0 .01 0', 175, 'MOVE'],
  ['tasks', 'Board', 'M4 6h16M4 12h16M4 18h10', 155, 'MOVE'],
  ['duo', 'Duo-Drive', 'M8 6a2.4 2.4 0 1 0 .01 0M16 6a2.4 2.4 0 1 0 .01 0M4 18c0-3 2-4.4 4-4.4M20 18c0-3-2-4.4-4-4.4M9.5 20h5', 320, 'MOVE'],
  ['workflows', 'Workflows', 'M4 7h5v4H4zM15 13h5v4h-5zM9 9h3a2 2 0 0 1 2 2v4M9 9', 280, 'MOVE'],
  ['chat', 'Command', 'M4 5h16v10H8l-4 4z', 205, 'MOVE'],
  ['voice', 'DASH-OPS', 'M12 4a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V7a3 3 0 0 1 3-3zM5 11a7 7 0 0 0 14 0M12 18v3M9 21h6', 185, 'MOVE'],

  ['agents', 'Agents', 'M9 7a3 3 0 1 0-.01 0M15 7a3 3 0 1 0-.01 0M4 19c0-3 2.5-4 5-4M15 15c2.5 0 5 1 5 4', 210, 'FLEET'],
  ['subagents', 'Subagents', 'M12 4a2 2 0 1 0 .01 0M6 12a2 2 0 1 0 .01 0M18 12a2 2 0 1 0 .01 0M9 19a2 2 0 1 0 .01 0M15 19a2 2 0 1 0 .01 0M12 6v4M11 11L7.5 11M12.5 11L17 11M6.5 14l2 3M17.5 14l-2 3', 230, 'FLEET'],
  ['sympath', 'Sympath', 'M12 21C7 17 4 14 4 10a4 4 0 0 1 8-1 4 4 0 0 1 8 1c0 4-3 7-8 11zM8.5 11h2l1-2 1.5 4 1-2h1.5', 160, 'FLEET'],
  ['motusmodels', 'MotusModels', 'M12 3l7.5 4.3v8.6L12 20.2 4.5 15.9V7.3zM12 3v8.6M12 11.6l7.5-4.3M12 11.6L4.5 7.3M12 11.6v8.6', 260, 'FLEET'],

  ['stream', 'MotusLive', 'M12 12a1 1 0 1 0 .01 0M12 12v9M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.7 5.7a9 9 0 0 0 0 12.6M18.3 5.7a9 9 0 0 1 0 12.6', 10, 'SIGNAL'],
  ['output', 'Output', 'M12 3v12M8 11l4 4 4-4M5 21h14M5 17v4M19 17v4', 95, 'SIGNAL'],
  ['work', 'Work', 'M4 5h16v14H4zM4 9h16M8 13h8', 145, 'SIGNAL'],

  ['systems', 'Systems', 'M12 4a2 2 0 1 0 .01 0M5 18a2 2 0 1 0 .01 0M19 18a2 2 0 1 0 .01 0M11 6L6 16M13 6l5 10M7.5 18.5h9', 220, 'MIND'],
  ['mind', 'Davara', 'M12 3l7 9-7 9-7-9 7-9zM12 8l3.5 4-3.5 4-3.5-4 3.5-4z', 268, 'MIND'],
  ['learnings', 'Learn', 'M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5', 55, 'MIND'],
  ['nextsteps', 'Next', 'M5 12h14M13 6l6 6-6 6', 15, 'MIND'],
  ['usage', 'Usage', 'M4 19V5M4 19h16M8 16v-5M12 16V8M16 16v-8', 30, 'MIND'],

  ['models', 'Model', 'M12 3a4 4 0 0 1 4 4c2 1 3 2 3 5a7 7 0 0 1-14 0c0-3 1-4 3-5a4 4 0 0 1 4-4z', 285, 'CORE'],
  ['security', 'Secure', 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z', 355, 'CORE'],
  ['settings', 'Config', 'M12 9a3 3 0 1 0 .01 0M19 12l2 1-2 4-2-1a7 7 0 0 1-2 1l-.5 2h-5L9 19a7 7 0 0 1-2-1l-2 1-2-4 2-1a7 7 0 0 1 0-2l-2-1 2-4 2 1a7 7 0 0 1 2-1l.5-2h5l.5 2a7 7 0 0 1 2 1l2-1 2 4-2 1a7 7 0 0 1 0 2z', 240, 'CORE'],
  ['levels', 'Levels', 'M12 3l3.6 3.6L12 10.2 8.4 6.6 12 3zM12 11.2l3.6 3.6L12 18.4l-3.6-3.6L12 11.2z', 48, 'CORE'],
];
const FLEET = window.FLEET_DATA || { sympath: {}, arden: {} };
function buildNav() {
  let seen = '';
  $('#railNav').innerHTML = NAV.map(([id, lab, d, hue, grp]) => {
    // a group label appears once, where the flow changes phase
    const head = grp && grp !== seen ? `<div class="nav-grp"><span>${grp}</span></div>` : '';
    seen = grp || seen;
    return head + `<button class="nav-btn ${id === CUR.view ? 'active' : ''}" data-nav="${id}" style="--nh:${hue == null ? 195 : hue}" title="${lab}">
       <span class="badge"></span><svg viewBox="0 0 24 24"><path d="${d}"/></svg><span class="lab">${lab}</span>
     </button>`;
  }).join('');
  $$('#railNav .nav-btn').forEach((b) => b.onclick = () => switchView(b.dataset.nav));
}
function switchView(view) {
  if (CUR.view === 'live' && view !== 'live') { try { C.liveStop(); } catch {} LIVE.active = false; }
  if (CUR.view === 'levels' && view !== 'levels') LEVELS.unlocked = false; // re-seal on leave
  CUR.view = view;
  // the whole page leans toward the view's own light — headings, accents and
  // the active nav node all draw from one hue variable
  const hue = (NAV.find((n) => n[0] === view) || [])[3];
  if (hue != null) document.documentElement.style.setProperty('--view-hue', hue);
  paintSigil(view);
  $$('#railNav .nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.nav === view));
  $$('.view').forEach((v) => v.classList.toggle('active', v.dataset.view === view));
  $('#content').scrollTop = 0;
  loadView(view);
}
/* ── THE SIGIL ──────────────────────────────────────────────────────────────
   Meaning outward: a page should feel like a PLACE, and a place has a mark.
   The mark is not a new asset — it is the view's own nav glyph, the one he
   already associates with that room, enlarged and drawn in that room's hue.
   Nothing new to learn, and every one of the twenty-five pages gains an
   identity from a single element.

   Two disciplines it must never break: it is drawn OUTSIDE the reading column
   and far under the contrast floor, so it can never compete with a word; and
   the entrance is one-shot and event-keyed — a permanently animating layer
   behind every page is exactly the kind of idle loop that made the machine
   warm in v2.1. */
function paintSigil(view) {
  const host = $('#viewSigil');
  if (!host) return;
  const nav = NAV.find((n) => n[0] === view);
  if (!nav) { host.innerHTML = ''; return; }
  host.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.05"'
    + ' stroke-linecap="round" stroke-linejoin="round"><path d="' + nav[2] + '"/></svg>';
  // restart the one-shot entrance without a timer: force a reflow between
  // removing and re-adding the class, so the animation re-runs per navigation
  // and never loops.
  // `on` is the RESTING state and never comes off — without it, dropping the
  // entrance class would drop the only thing holding the mark visible and the
  // sigil would silently vanish after one second on every page.
  host.classList.add('on');
  host.classList.remove('in');
  void host.offsetWidth;
  host.classList.add('in');
  host.dataset.state = '';
  // ⚠ THE HANDOFF. The entrance rule has to outrank the breathing rule while it
  // plays, or a navigation would fight an in-progress breath — but that means
  // .in must actually COME OFF, or the breath can never start. It is dropped
  // the moment the entrance finishes, and the state is applied behind it.
  host.addEventListener('animationend', function done() {
    host.removeEventListener('animationend', done);
    host.classList.remove('in');
    host.dataset.state = '';
    applySigilState();
  }, { once: true });
  applySigilState();
}

/* ── HARMONIC ATTENTION ─────────────────────────────────────────────────────
   The readings now exist on every major surface, but each one only speaks when
   he is standing on it — so a stale board or a drifting broadcast stays silent
   until he happens to look. This is the loop closing: the surfaces inform the
   NAVIGATION, and the rail lights the room that is asking for him.

   Strictly derived from data already fetched for other reasons — no extra
   calls, no tokens. And deliberately conservative: a rail that always glows is
   a rail nobody reads, so only genuinely unanswered things light up. */
let ATTN = { stations: [], ts: 0, air: null, ov: null, running: false };

/* ═══════════════════════════════════════════════════════════════════════════
   THE WHOLE-SYSTEM READ

   Nine questions, asked of the running system every ninety seconds, each one
   phrased so the answer is either silence or a sentence he can act on. This is
   the only place in the app that looks ACROSS surfaces — every other reading
   speaks for its own room, and a room cannot tell you that it has been quiet
   for two days while another one is on fire.

   Two disciplines, both learned the hard way:

   · SEQUENCE, DO NOT BURST. The first version fired five IPC calls at once and
     starved the first view paint — MotusLive came up EMPTY with no error
     anywhere. Deferring the start hid it; sequencing removes it. This is a
     ninety-second job, so wall-clock does not matter and never blocking does.

   · SILENCE IS THE DEFAULT. Every check must be able to return nothing. A
     station only lights when something is genuinely unanswered, because a rail
     that always glows is a rail nobody reads.
   ═══════════════════════════════════════════════════════════════════════════ */
const ATTN_SEV = { hard: 0, ask: 1, soft: 2 };
async function syncAttention() {
  if (ATTN.running) return;                 // a slow sweep must never stack on itself
  ATTN.running = true;
  const st = [];
  const add = (view, label, reason, sev) => st.push({ view, label, reason, sev: sev || 'ask', hard: sev === 'hard' });
  // one at a time, yielding between each, so the UI thread is never held
  const step = async (fn) => { try { return await fn(); } catch (e) { diagPush('attention', e); return null; } finally { await new Promise((r) => setTimeout(r, 40)); } };
  try {
    // 1 · THE FRAME — without a Motus every agent optimises against a weaker signal
    const ov = await step(() => C.overview());
    if (ov && !ov.error && !ov.motus) add('motus', 'Motus', 'no prime mover is named — the fleet is guessing at your priority', 'ask');

    // 2 · BOARD — work that stopped being work a fortnight ago
    const b = await step(() => C.board());
    if (b && b.tasks) {
      const cut = Date.now() - 14 * 864e5;
      const stale = b.tasks.filter((t) => t.status !== 'done' && (Date.parse(t.updated || t.created) || 0) < cut).length;
      if (stale) add('tasks', 'Board', stale + ' task(s) untouched for a fortnight — stuck, not open', 'soft');
    }

    // 3 · MOTUSLIVE — either half of the privacy law reporting something wrong
    const air = await step(() => C.onAir());
    const A = air && air.onAir;
    if (A) {
      if (A.drift && (A.drift.extraCount || 0) > 0) add('stream', 'MotusLive', A.drift.extraCount + ' thing(s) are being served that you did not tick', 'hard');
      else if (A.sweep && A.sweep.clean === false) add('stream', 'MotusLive', 'content of yours is public while you are off air', 'hard');
      else if (A.sweep && A.sweep.ok === false) add('stream', 'MotusLive', 'the broadcast state cannot be verified — unknown is not the same as safe', 'ask');
    }

    // 4 · SYSTEMS — something has now happened more than once
    const learn = await step(() => C.learnings());
    if (learn && (learn.patterns || []).length) add('systems', 'Systems', learn.patterns.length + ' thing(s) have now happened more than once', 'ask');

    // 5 · DUO — a loop she designed and is not allowed to run
    const L = await step(() => C.loops());
    if (L && L.loops) {
      const pend = L.loops.filter((l) => !l.approved).length;
      if (pend) add('duo', 'Duo-Drive', pend + ' loop(s) she designed are waiting on your approval', 'ask');
    }

    // 6 · OUTPUT — the silence that a file list cannot show you.
    //     A list of files always looks like work; a clock since the last one
    //     does not. This is the only reading in the app that gets LOUDER the
    //     less there is to see.
    const out = await step(() => C.outputs());
    if (out && out.files) {
      const newest = out.files.map((x) => Date.parse(x.ts) || 0).sort((a2, b2) => b2 - a2)[0] || 0;
      const hrs = newest ? Math.floor((Date.now() - newest) / 36e5) : 999;
      if (!newest) add('output', 'Output', 'nothing has been written in the last 7 days of sessions', 'soft');
      else if (hrs >= 48) add('output', 'Output', 'nothing has landed in ' + Math.floor(hrs / 24) + ' day(s) — the fleet is talking, not shipping', 'soft');
    }

    // 7 · USAGE — depth is compute, and the five-hour window is the real
    //     constraint. Warn on the WINDOW, not on the total: a big lifetime
    //     number is not a problem, a window about to close is.
    const u = await step(() => C.usageReal());
    if (u && !u.error) {
      // ⚠ CAUGHT IN REVIEW: this read `outputTokens`; the payload's field is
      // `out`. The 85%-of-cap alarm had been comparing zero to the cap since
      // the day it was written. It fires now.
      const five = (u.fiveH && (u.fiveH.out || u.fiveH.outputTokens)) || 0;
      const cap = u.budget && u.budget.fiveHour;
      if (cap && five > cap * 0.85) add('usage', 'Usage', Math.round((five / cap) * 100) + '% of your 5-hour cap is spent', 'hard');
      else if (!cap && (u.burnPerHour || 0) > 60000) add('usage', 'Usage', 'burning ~' + compact(u.burnPerHour) + ' output tokens an hour with no cap set', 'ask');
    }

    // 7b · THE RECEIPTS — one extra sequenced read so the landing page can
    //      show what actually SHIPPED today without its own fetch burst.
    const dw = await step(() => C.duoWork({}));
    if (dw && dw.items) {
      const today = new Date().toISOString().slice(0, 10);
      const shipped = dw.items.filter((x) => x.verdict === 'shipped' && String(x.ts || '').slice(0, 10) === today);
      ATTN.ship = { today: shipped.length, latest: shipped.slice(0, 3).map((x) => String(x.title || '').slice(0, 90)) };
    }

    // 8 · WORKFLOWS — a progression that stopped is not a progression. A
    //     BLOCKED run in particular is a gate that did its job and is now
    //     waiting on a human; leaving that silent wastes the whole gate.
    const wf = await step(() => C.workflows());
    if (wf && wf.runs) {
      const dead = wf.runs.filter((r) => ['failed', 'blocked', 'stopped'].includes(r.status));
      const blocked = dead.filter((r) => r.status === 'blocked').length;
      if (blocked) add('workflows', 'Workflows', blocked + ' run(s) BLOCKED at a gate — resumable, and waiting on you', 'ask');
      else if (dead.length) add('workflows', 'Workflows', dead.length + ' run(s) ended early and can be resumed', 'soft');
    }

    // 9 · THE INTERFACE ITSELF — the app is allowed to say it has become slow.
    //     Measured, never guessed, and only once a MEDIAN is bad: one slow
    //     paint is an event, a median is a property of the code.
    const w = perfWorstView();
    if (w) add(w.view, 'Interface', 'the ' + w.view + ' view takes ' + (w.ms / 1000).toFixed(1) + 's to paint — that is felt, not measured', 'soft');
    // …and the main process names its own slow handlers, so a slow SCREEN and
    // a slow HANDLER stop being one blurred complaint. Different bugs,
    // different owners, different sentences.
    const ip = await step(() => C.ipcPerf && C.ipcPerf());
    if (ip && ip.top && ip.top.length) {
      const t = ip.top[0];
      add('systems', 'Interface', 'the ' + String(t.channel).replace('cortex:', '') + ' handler answers in ' + (t.med / 1000).toFixed(1) + 's — every screen that asks it waits that long', 'soft');
    }

    // 10 · MOTUS MAX — the wait, as a number. A drive seat whose typical turn
    //      is over five minutes makes every screen move feel like a hang; when
    //      a seat with hands is clearly faster, name it.
    const om = await step(() => C.omni());
    const oc = om && om.omni && om.omni.seatClock;
    if (oc && oc.n >= 3 && oc.median > 300) {
      const f = om.omni.fastestHands;
      const faster = f && f.id !== oc.agent && f.median < oc.median * 0.7;
      add('omni', 'Motus Max', 'the drive seat takes ~' + Math.round(oc.median / 60) + ' min a turn' + (faster ? '. ' + f.name + ' has hands and answers in ~' + Math.round(f.median / 60) + ' min' : ''), 'soft');
    }

    st.sort((x, y) => ATTN_SEV[x.sev] - ATTN_SEV[y.sev]);
    const keep = { ship: ATTN.ship };   // stashed above, survives the rebuild
    ATTN = { stations: st, ts: Date.now(), air: A || null, ov: (ov && !ov.error && ov) || null, running: false,
      ship: keep.ship || null,
      auto: (b && b.autoWork) || null,
      out: (out && out.files) ? (() => {
        const today = new Date().toISOString().slice(0, 10);
        return { today: out.files.filter((x) => String(x.ts || '').slice(0, 10) === today).length };
      })() : null,
      wf: (wf && wf.runs) ? {
        running: (wf.runs || []).filter((r) => r.status === 'running').length,
        blocked: (wf.runs || []).filter((r) => r.status === 'blocked').length,
      } : null };
    for (const v of ['tasks', 'stream', 'systems', 'duo', 'motus', 'output', 'usage', 'workflows', 'omni']) {
      setBadge(v, st.some((x) => x.view === v));
    }
    renderPulseStrip();
    if (_ovCache) { renderEngineRoom(_ovCache); renderDayLedger(_ovCache); }
    applySigilState();
  } catch (e) {
    diagPush('attention', e);
  } finally {
    ATTN.running = false;
  }
}
function safeAsync(fn) { try { return fn(); } catch { return null; } }

/* ── THE SIGIL BREATHES WHAT ITS ROOM REPORTS ───────────────────────────────
   The mark made each page a place. This makes the place ALIVE — and only
   honestly so. Three states, and the default is stillness:

     still  — nothing is happening here. Most rooms, most of the time.
     live   — this room's subject is ACTING right now (she is armed, a loop is
              compounding, the broadcast is on). A slow, deep breath.
     alert  — this room is reporting something unanswered. A shallower, gold
              pulse, because unease should not look like calm.

   The discipline that keeps it from becoming the v2.1 slowdown: exactly ONE
   element animates in the whole app, it only animates when the state earns it,
   it only ever touches opacity and transform, and its period is measured in
   seconds — a mark that breathes eight times a minute is atmosphere, one that
   flickers is noise. */
function sigilStateFor(view) {
  const st = (ATTN.stations || []).some((x) => x.view === view);
  const air = ATTN.air;
  const alive =
    view === 'stream' ? !!(air && air.on)
    : view === 'omni' ? !!((ATTN.ov && ATTN.ov.omniArmed) || (typeof OMNI !== 'undefined' && OMNI && OMNI.data && OMNI.data.armed))
    : view === 'duo' ? !!((ATTN.ov && ATTN.ov.duoActive) || (typeof CONTROL !== 'undefined' && CONTROL && CONTROL.duo && CONTROL.duo.active))
    : view === 'overview' || view === 'live' ? ((ATTN.ov && ATTN.ov.working) || []).some((w) => w.inflight)
    : false;
  // acting outranks asking: a room that is DOING something should read as busy,
  // not as a complaint.
  return alive ? 'live' : st ? 'alert' : '';
}
function applySigilState() {
  const host = $('#viewSigil');
  if (!host) return;
  const want = sigilStateFor(CUR.view);
  if (host.dataset.state === want) return;   // never restart an animation for no reason
  host.dataset.state = want;
  host.classList.remove('s-live', 's-alert');
  if (want) host.classList.add('s-' + want);
}

/* ── PULSE · THE ROOMS ASKING FOR YOU ───────────────────────────────────────
   Pulse already counted turns, tokens and characters — every one of them a
   VOLUME metric, and volume always flatters. None of them could tell him that
   a task had been stuck for a fortnight or that something of his was public.

   This is the one reading on the landing page that can say "go here". It is
   assembled from data the attention loop already fetched, so it costs nothing,
   and every cell is a door. */
function renderPulseStrip() {
  const host = $('#pulseStrip');
  if (!host) return;
  const st = ATTN.stations || [];
  const ov = ATTN.ov || {};
  const air = ATTN.air;
  const cell = (cls, big, sub, jump) => '<div class="st-si ' + (cls || '') + (jump ? ' jump' : '') + '"'
    + (jump ? ' data-jump="' + jump + '" role="button" tabindex="0"' : '') + '><b>' + big + '</b><i>' + sub + '</i></div>';
  const first = st[0];
  const hard = st.some((x) => x.hard);
  const airCell = !air ? cell('', '—', 'broadcast state not read yet')
    : air.on ? cell('live', 'ON AIR', 'the ticked items are public, by your choice', 'stream')
    : (air.sweep && air.sweep.clean) ? cell('go', 'DARK', 'nothing of yours is retrievable', 'stream')
    : cell('zero', 'UNVERIFIED', 'the broadcast state has not been confirmed', 'stream');
  setHTML(host, '<div class="st-strip n5">'
    // ⚠ TONE IS MEANING. This shipped red for an ordinary "1 room is asking",
    // which reads as an emergency and spends the loudest colour in the app on
    // a stale task. Red belongs to a privacy finding and nothing else — gold
    // asks, red alarms — and this now matches the rows underneath it exactly.
    + cell(st.length ? (hard ? 'live' : 'zero') : 'go', st.length || '✓',
        st.length ? 'room(s) asking for you — ' + esc(first.label.toLowerCase()) + ' first' : 'nothing is asking for you',
        first ? first.view : '')
    + cell(ov.motus ? 'go' : 'zero', ov.motus ? '◆' : '—',
        ov.motus ? 'a prime mover is named' : 'no Motus — the fleet is guessing', 'motus')
    + cell((ov.stats && ov.stats.todayTurns) ? '' : 'zero', (ov.stats && ov.stats.todayTurns) || 0, 'turns today')
    + cell((ov.working || []).some((w) => w.inflight) ? 'live' : '',
        (ov.working || []).filter((w) => w.inflight).length, 'agent(s) working right now', 'live')
    + airCell
    + '</div>'
    + (st.length ? '<div class="attn-list">' + st.map((x) =>
        '<button class="attn-row' + (x.hard ? ' hard' : '') + '" data-jump="' + x.view + '">'
        + '<span class="ar-w">' + esc(x.label) + '</span>'
        + '<span class="ar-r">' + esc(x.reason) + '</span>'
        + '<span class="ar-go">go →</span></button>').join('') + '</div>' : ''));
}
/* every cell and row on that strip is a door */
document.addEventListener('click', (e) => {
  const j = e.target.closest('[data-jump]');
  if (j && j.dataset.jump) switchView(j.dataset.jump);
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const j = e.target.closest && e.target.closest('.st-si.jump[data-jump]');
  if (j) { e.preventDefault(); switchView(j.dataset.jump); }
});

function setBadge(view, on) { const b = $(`#railNav .nav-btn[data-nav="${view}"]`); if (b) b.classList.toggle('alert', !!on); }

/* ============================ THE TWO FOCUSES — Motus & Goal ============================ */
const FOCUS_META = {
  motus: { title: 'Motus', icon: '◆', tag: 'Prime mover · now',
    sub: 'The single strongest thing you are moving on right now — the focus of focus. Shorter-horizon than your goal. Naming it points every agent at the same push.',
    ph: 'e.g. Get the CortexInsight Motus + Goal screens live and verified tonight', cmd: '/motus', noun: 'prime mover' },
  goal: { title: 'Goal', icon: '◎', tag: 'North star · long-term',
    sub: 'Your long-term north star. Every reflection, next-step and Davara recommendation is weighed against this. It changes rarely.',
    ph: 'e.g. Master and teach systems thinking through the Motus platform', cmd: '/goal', noun: 'north star' },
};
async function loadFocus(which) {
  const host = $(which === 'motus' ? '#motusBody' : '#goalBody'); if (!host) return;
  const meta = FOCUS_META[which];
  let f = null;
  try { const r = await C.focus(); f = r && (which === 'motus' ? r.motus : r.goal); } catch (e) {}
  const cur = f && f.text ? f.text : '';
  const when = f && f.ts ? ago(f.ts) : '';
  host.innerHTML =
    `<div class="view-head"><h2>${meta.title}</h2></div>
     <div class="focus-wrap focus-${which}">
       <div class="focus-cur ${f ? 'set' : 'empty'}">
         <div class="focus-cur-tag">${meta.icon} ${meta.tag}</div>
         ${f
           ? `<div class="focus-cur-text">${esc(cur)}</div><div class="focus-cur-meta">set ${when} ago · held by ${esc(aname((f && f.agent) || 'davara'))}</div>`
           : `<div class="focus-cur-empty">Nothing set yet. Name it below — it becomes the ${meta.noun} every agent holds.</div>`}
       </div>
       <p class="focus-sub">${meta.sub}</p>
       <textarea class="focus-input" id="focusInput-${which}" rows="3" placeholder="${esc(meta.ph)}">${esc(cur)}</textarea>
       <div class="focus-actions">
         <button class="focus-set" id="focusSet-${which}">${meta.icon} Set ${meta.title.toLowerCase()}</button>
         <span class="focus-hint">or type <code>${meta.cmd} …</code> in Command</span>
       </div>
       <div class="focus-status" id="focusStatus-${which}"></div>
     </div>`;
  const btn = $(`#focusSet-${which}`), ta = $(`#focusInput-${which}`), st = $(`#focusStatus-${which}`);
  if (btn) btn.onclick = async () => {
    const text = (ta.value || '').trim();
    if (!text) { toast(`Write the ${meta.title.toLowerCase()} first`, 'bad'); return; }
    btn.disabled = true; if (st) st.textContent = 'Sending to Davara…';
    try { await C.send({ agent: 'davara', kind: which, text }); if (st) st.textContent = '✓ Set — Davara is holding it.'; toast(`${meta.title} set`, 'ok'); setTimeout(() => loadFocus(which), 700); }
    catch (e) { if (st) st.textContent = 'Could not set — try again.'; toast('Failed to set', 'bad'); btn.disabled = false; }
  };
}
function loadMotus() { return loadFocus('motus'); }
function loadGoal() { return loadFocus('goal'); }

/* ============================ REFRESH ============================ */
/* A staged build he has not installed is a build he does not have — and being
   two versions behind has been the quiet cause of half the bugs he reported.
   One click, from inside the app that is out of date. */
async function checkUpdate() {
  const r = await C.updateCheck().catch(() => null);
  const bar = $('#updateBar');
  if (!r || !r.ok || !r.update) { if (bar) bar.remove(); return; }
  const u = r.update;
  if (bar) return;
  const el = document.createElement('div');
  el.id = 'updateBar';
  el.className = 'update-bar';
  el.innerHTML = `<span class="ub-dot"></span>
    <div class="ub-t"><b>v${esc(u.version)} is ready</b> — you are running v${esc(u.current)}. Every fix since then is in it.</div>
    <button class="ub-go" id="ubGo">Install &amp; restart</button>
    <button class="ub-x" id="ubX" title="later">✕</button>`;
  document.body.appendChild(el);
  $('#ubGo').onclick = async () => {
    $('#ubGo').disabled = true; $('#ubGo').textContent = 'installing…';
    const a = await C.updateApply().catch(() => null);
    if (!a || !a.ok) { $('#ubGo').disabled = false; $('#ubGo').textContent = 'Install & restart'; toast((a && a.error) || 'update failed', 'bad'); }
  };
  $('#ubX').onclick = () => el.remove();
}

/* ═══════════════════════════════════════════════════════════════════════════
   THE INSTRUMENT — the app measures its own responsiveness, forever.

   "Less lag" is not a thing you can fix by guessing; every optimisation is a
   claim, and a claim needs a number. So every view paint is timed, kept as a
   rolling window, and the app is allowed to say out loud that it has become
   slow — through the same attention channel that reports everything else.

   Cost is a subtraction and two array writes per paint. It is cheaper than the
   first thing it will ever find.
   ═══════════════════════════════════════════════════════════════════════════ */
const PERF = { view: {}, slow: 0, since: Date.now() };
const PERF_WINDOW = 12;          // enough to see a trend, small enough to forget a fluke
const PERF_SLOW_MS = 900;        // beyond this a paint is FELT, not measured
function perfRecord(name, ms, ok) {
  const p = PERF.view[name] || (PERF.view[name] = { ms: [], fails: 0, last: 0, worst: 0 });
  p.ms.push(Math.round(ms));
  if (p.ms.length > PERF_WINDOW) p.ms.shift();
  p.last = Math.round(ms);
  if (ms > p.worst) p.worst = Math.round(ms);
  if (!ok) p.fails++;
  if (ms > PERF_SLOW_MS) PERF.slow++;
}
function perfMedian(name) {
  const p = PERF.view[name];
  if (!p || !p.ms.length) return 0;
  const a = [...p.ms].sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
}
/* The worst offender, but only once there is enough evidence to name it. One
   slow paint is an event; a median over several is a property of the code. */
function perfWorstView() {
  let worst = null;
  for (const [name, p] of Object.entries(PERF.view)) {
    if (p.ms.length < 3) continue;
    const med = perfMedian(name);
    if (med > PERF_SLOW_MS && (!worst || med > worst.ms)) worst = { view: name, ms: med, worst: p.worst };
  }
  return worst;
}

/* ═══════════════════════════════════════════════════════════════════════════
   HONEST FAILURE — a view that could not load must SAY SO.

   Thirty-one loaders shared one line: `if (!r || r.error) return;`. A failed
   fetch left the screen blank, or worse, showing the last good data with no
   sign it had gone stale — which is the most expensive failure mode in this
   whole app, because he would act on it. Silence is not a safe default; it is
   just the failure you cannot see.
   ═══════════════════════════════════════════════════════════════════════════ */
const VIEW_BODY = {
  motus: 'motusBody', goal: 'goalBody', models: 'modelBody', tasks: 'boardBody',
  subagents: 'subBody', workflows: 'wfBody', duo: 'duoBody', voice: 'voiceBody',
  omni: 'omniBody', motusmodels: 'mmBody', usage: 'usageBody', systems: 'sysBody',
  stream: 'streamBody', output: 'outFiles',
};
const DIAG = [];                 // a small ring of what actually went wrong
function diagPush(where, err) {
  DIAG.unshift({ ts: Date.now(), where, err: String((err && (err.error || err.message)) || err || 'no answer').slice(0, 200) });
  if (DIAG.length > 40) DIAG.length = 40;
}
function viewFail(where, res) {
  diagPush(where, res);
  const id = VIEW_BODY[where];
  const el = id ? $('#' + id) : null;
  // Only paint the failure into the room he is actually standing in — an error
  // card written into a hidden view is a jump-scare on his next navigation.
  if (el && CUR.view === where) {
    setHTML(el, '<div class="load-fail">'
      + '<div class="lf-h">◍ This view could not read its data.</div>'
      + '<div class="lf-b">' + esc(String((res && res.error) || 'The request came back empty.')) + '</div>'
      + '<div class="lf-n">Nothing here is stale — it is simply not loaded. Your data is untouched.</div>'
      + '<button class="prime-btn lf-retry" data-retry="' + where + '">↻ Try again</button></div>');
  }
  return undefined;
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-retry]');
  if (b) loadView(b.dataset.retry);
});

async function refreshAll() { await loadOverview(); await loadView(CUR.view); }
// Only views whose data genuinely changes second-to-second auto-refresh. The rest
// (learnings, next-steps, security, agents, systems, settings…) reload on entry and
// on the actions that change them — so pagination/expansion you set is never wiped,
// and the screen never churns. setHTML() still gates every write to changed content.
// 'tasks' (the Board) and 'usage' are deliberately NOT auto-refreshed: both now
// contain text inputs, and a poll-driven re-render would wipe what you're typing
// mid-sentence. They reload on entry and after any action that changes them.
const AUTO_REFRESH = new Set(['overview', 'live', 'output']);
/* ── THE SELF-TUNING PULSE ──────────────────────────────────────────────────
   A fixed 4-second poll spends the same energy whether the system is moving or
   completely still — and "still" is most of the time. setHTML() already tells
   us the truth for free: it returns false when the rendered HTML is identical
   to what is on screen. So the app can FEEL whether anything is happening.

   Quiet begets patience: after several unchanged ticks the pulse slows toward
   20s. The instant anything changes, or he touches the app, it snaps back to
   4s. He never waits for a slow poll, because interacting resets it — the only
   time it is slow is when nothing is happening AND he is not looking.

   This is where the heat came from on the laptop, and it is the cheapest
   possible fix: not doing work nobody asked for. */
const POLL_FAST = 4000, POLL_SLOW = 20000;
let _quiet = 0, _pollMs = POLL_FAST;
function pollInterval() {
  if (_quiet < 5) return POLL_FAST;
  return Math.min(POLL_SLOW, POLL_FAST * Math.pow(1.6, _quiet - 4));
}
function repollIfNeeded() {
  const want = Math.round(pollInterval());
  if (Math.abs(want - _pollMs) < 250) return;
  _pollMs = want;
  clearInterval(pollTimer);
  pollTimer = setInterval(() => { if (!document.hidden) tick(); }, _pollMs);
}
/* any touch means he is here — wake up immediately */
function pollWake() {
  // a pointer or key in THIS window is proof he is looking — the brake must
  // release even if the focus event was lost (the empty-tabs sequence)
  if (document.body.classList.contains('win-idle')) setWindowIdle(false);
  if (_quiet === 0) return;
  _quiet = 0;
  repollIfNeeded();
}
['pointerdown', 'keydown', 'wheel'].forEach((ev) =>
  document.addEventListener(ev, pollWake, { passive: true, capture: true }));

/* ── THE IDLE BRAKE ─────────────────────────────────────────────────────────
   MEASURED 2026-08-20 on his machine: the desktop felt heavy and the mouse
   stuttered while agents ran. This app was not the memory cause, but it WAS
   paying continuous GPU for animation and blur while he worked elsewhere.
   Focus is the honest signal for "is anyone looking at this?" — and blur is
   the moment to stop spending. */
function setWindowIdle(idle) {
  document.body.classList.toggle('win-idle', !!idle);
}
window.addEventListener('blur', () => setWindowIdle(true));
window.addEventListener('focus', () => { setWindowIdle(false); pollWake(); });
// a window that is hidden or minimised is idle by definition
document.addEventListener('visibilitychange', () => setWindowIdle(document.hidden || !document.hasFocus()));
// start in the correct state rather than assuming focus
setWindowIdle(!document.hasFocus());
document.addEventListener('visibilitychange', () => { if (!document.hidden) { pollWake(); tick(); } });

async function tick() {
  try {
    // ⚠ The loaders do not return a changed-flag and never did — asking them to
    // would mean editing twenty functions and trusting each one. setHTML is the
    // single choke point every paint goes through, so count there instead: one
    // number, impossible to forget to update.
    const before = _domWrites;
    await loadOverview();
    if (CUR.view !== 'overview' && AUTO_REFRESH.has(CUR.view)) await loadView(CUR.view, true);
    if (_domWrites > before) _quiet = 0; else _quiet++;
    repollIfNeeded();
  } catch (e) { diagPush('tick', e); /* a single bad tick must never break the loop */ }
}
async function loadView(view, quiet) {
  const t0 = performance.now();
  try {
    const r = await _loadView(view, quiet);
    perfRecord(view, performance.now() - t0, true);
    return r;
  } catch (e) {
    // A loader that THROWS used to take the whole tick down with it. Now it
    // costs exactly one view, says so on screen, and the loop keeps running.
    perfRecord(view, performance.now() - t0, false);
    return viewFail(view, e);
  }
}
function _loadView(view, quiet) {
  switch (view) {
    // THE MOVE paints alongside the Pulse — it answers "what now", the rest
    // of the view reports "how are we". Fired without awaiting so a slow
    // board read can never delay the vitals.
    case 'overview': { if (typeof paintTheMove === 'function') paintTheMove(); return loadOverview(); }
    case 'motus': return loadMotus();
    case 'goal': return loadGoal();
    case 'agents': return loadAgents();
    case 'tasks': return loadBoard();
    case 'subagents': return loadSubagents();
    case 'workflows': return loadWorkflows();
    case 'duo': return loadDuo();
    case 'voice': return loadVoice();
    case 'omni': return loadOmni();
    case 'motusmodels': return loadMotusModels();
    case 'stream': return (typeof loadStream === 'function' ? loadStream() : null);
    case 'chat': return loadChatBar();
    case 'work': return loadWork();
    case 'live': return loadLive();
    case 'output': return loadOutput();
    case 'systems': return loadSystems();
    case 'mind': return (typeof loadMind === 'function' ? loadMind() : null);
    case 'sympath': return loadSympath();
    case 'levels': return loadLevels();
    case 'usage': return loadUsage();
    case 'learnings': return loadLearnings();
    case 'nextsteps': return loadNext();
    case 'models': return loadModels();
    case 'security': return loadSecurity();
    case 'settings': return loadSettings();
  }
}

/* ============================ OVERVIEW ============================ */
/* ⚠ MEASURED: overview's median was ~800–1300 ms — but cortex:overview never
   crossed the handler instrument's 350 ms line. The cost was the COLD path:
   the first read after boot parses every transcript file, and a navigation
   that lands during it waits for the world to be re-derived. The landing page
   must never wait on that. So Pulse is stale-while-revalidate: the last known
   payload paints in ONE FRAME, then the fresh read lands over it — and setHTML
   hash-gates mean an unchanged world costs zero DOM writes on the second pass. */
let _ovCache = null;
async function loadOverview() {
  if (_ovCache) safe0(() => renderOverview(_ovCache));   // instant, honest-stale
  const o = await C.overview(); if (!o || o.error) return viewFail('overview', o || null);
  _ovCache = o;
  return renderOverview(o);
}
function safe0(fn) { try { return fn(); } catch (e) { diagPush('overview-stale', e); } }
function renderOverview(o) {
  // titlebar status
  const h = o.health || {};
  const dotc = h.level === 'nominal' ? 'good' : h.level === 'degraded' ? 'bad' : 'warn';
  setHTML($('#tbStatus'),
    `<span class="pill"><span class="dot ${dotc}"></span> Cortex ${h.level || '—'}</span>
     <span class="pill"><span class="dot ${o.uptime ? 'good' : 'bad'}"></span> relay ${o.uptime ? 'up ' + fmtDur(o.uptime) : 'offline'}</span>
     <span class="pill">${o.stats.totalTurns} turns · ${compact(o.stats.totalTokens)} tok</span>`);
  // rail orb + meta
  const orb = $('#cortexOrb'); orb.className = 'cortex-orb' + (h.level === 'degraded' ? ' bad' : h.level === 'watch' ? ' warn' : '');
  $('#cmUptime').textContent = o.uptime ? fmtDur(o.uptime) : 'offline';
  $('#cmModel').textContent = o.model || '—'; $('#cmModel').title = o.model || '';
  // focus strip — motus (prime mover now) + goal (north star), both clickable to their screens
  setHTML($('#goalStrip'),
    (o.motus
      ? `<span class="gchip motus" data-go="motus" title="Open Motus"><span class="gicon">◆</span> <b>Motus:</b> ${esc(o.motus.text.slice(0, 120))}</span>`
      : `<span class="gchip motus muted" data-go="motus" title="Set your prime mover"><span class="gicon">◆</span> <span class="muted">No Motus set — name the strongest thing moving now</span></span>`)
    + (o.goal
      ? `<span class="gchip goal" data-go="goal" title="Open Goal"><span class="gicon">◎</span> <b>Goal:</b> ${esc(o.goal.text.slice(0, 120))}</span>`
      : `<span class="gchip goal muted" data-go="goal" title="Set your north star"><span class="gicon">◎</span> <span class="muted">No long-term goal set — open Goal or send <code>/goal …</code></span></span>`));
  $$('#goalStrip [data-go]').forEach((el) => el.onclick = () => switchView(el.dataset.go));
  // NOW strip — what each agent is working on RIGHT NOW (live transcript-fed)
  renderNow(o.working || []);
  // constellation
  renderConstellation(o.pulse);
  // vitals
  setHTML($('#vitals'), `
    ${vital('Reliability', Math.round((o.stats.cleanRate || 1) * 100) + '%', `${o.stats.totalTurns} turns lifetime`, (o.stats.cleanRate || 1) * 100)}
    ${vital('Relay uptime', o.uptime ? fmtDur(o.uptime) : 'offline', o.proxyStart ? 'since ' + fmtTs(o.proxyStart) : 'no START line', o.uptime ? 100 : 0)}
    ${vital('Reasoning time', fmtSecs(o.stats.totalCompute), 'total agent compute', Math.min(100, o.stats.totalCompute / 36))}`);
  // stat grid
  setHTML($('#statGrid'), [
    stat('Total turns', compact(o.stats.totalTurns), 'lifetime', 'v', '◇'),
    stat('Today', compact(o.stats.todayTurns), 'turns today', 'c', '☀'),
    stat('Est. tokens', compact(o.stats.totalTokens), '≈ chars ÷ 4', 'v', '◈'),
    stat('Output', compact(o.stats.totalChars), 'chars relayed', 'c', '∿'),
    stat('In flight', String((o.working || []).filter((w) => w.inflight).length), 'working right now', 'v', '◉'),
  ].join(''));
  // recent engagements — in-flight first (live), then completed turns
  $('#recentSub').textContent = o.lastTurn ? 'last ' + ago(o.lastTurn.epoch) + ' ago' : '';
  const liveRows = (o.working || []).filter((w) => w.inflight).map((w) => `
    <div class="rrow rlive expandable">
      <span class="rtime"><span class="live-dot"></span> now</span>
      <span class="ragent tone-${TONE[w.agent] || 'slate'}">${esc(cap(w.agent))}</span>
      <span class="rmsg">${esc(w.inbound || '(session open)')}</span>
      <span class="rstat s-live">LIVE</span>
      <span class="rlat" ${w.startEpoch > 0 ? `data-elapsed="${w.startEpoch}"` : ''}>${w.startEpoch > 0 ? fmtDur(Date.now() - w.startEpoch) : '—'}</span>
    </div>`).join('');
  setHTML($('#recentList'), liveRows + ((o.recent || []).map(rrow).join('') || `<div class="empty">No activity yet.</div>`));
  // badges
  setBadge('overview', h.level === 'degraded');
  updateArdenSign(o.ardenSign);
  renderEngineRoom(o);
  renderReading();
  renderDayLedger(o);
  wireRelayBtn(o);
  return true;
}

/* ── THE ENGINE ROOM ────────────────────────────────────────────────────────
   Every autonomous system in the app on one band — lit when genuinely running,
   dim when still. This is the founder's first question ("what is working while
   I am not looking?") answered without a single click. Each station is a door
   to its room, and each lights in its room's own hue, so the band doubles as a
   map of the app. Honesty rule: a station lights only on evidence from the
   live payload — never on configuration, never on hope. */
/* ── RESTART THE RELAY, from where he actually notices it is down ──────────
   The action already existed in Config (heal:run restart-relay) — but the
   place he LEARNS the relay is down is the Pulse header, and making him go
   hunt a settings screen at that moment is the whole friction. Only appears
   when it is genuinely useful. */
function wireRelayBtn(o) {
  const bar = document.querySelector('.ritual-bar');
  if (!bar) return;
  let b = document.getElementById('relayBtn');
  const down = !o.uptime;
  if (!b) {
    b = document.createElement('button');
    b.id = 'relayBtn'; b.className = 'ritual-btn relay';
    b.innerHTML = '<span class="rb-ic">⟲</span> Restart relay';
    b.onclick = async () => {
      if (!confirm('Restart the mouth-proxy relay?\n\nIn-flight agent turns will be interrupted. It usually returns within a couple of seconds.')) return;
      b.disabled = true; const was = b.innerHTML; b.innerHTML = '<span class="rb-ic">⟲</span> restarting…';
      const r = await C.heal('restart-relay').catch(() => null);
      b.disabled = false; b.innerHTML = was;
      toast(r && r.ok ? 'Relay is back up ✓' : 'Relay not confirmed — see Config', r && r.ok ? 'good' : 'warn');
      loadOverview();
    };
    bar.appendChild(b);
  }
  b.classList.toggle('urgent', down);
  b.title = down ? 'The relay is OFFLINE — nothing can reach the agents until it is back' : 'Restart the mouth-proxy relay';
}
/* ── THE READING — the whole system in one sentence, with the day ring ──
   Every counter on Pulse measures volume. This reads the shape: the window,
   the attractor, the lever, her score, the open stacks. Fetched at most
   every 45 s; the ring is static SVG in the view's hue. */
let _readingAt = 0, _readingV = null;
function rhythmRingSvg(ring, today, peak, size) {
  if (!ring || ring.length !== 24) return '';
  const max = Math.max(1, ...ring), c = size / 2, r0 = size * 0.19, len = size * 0.24;
  const pt = (i, r) => { const a = (i / 24) * Math.PI * 2 - Math.PI / 2; return [(c + r * Math.cos(a)).toFixed(1), (c + r * Math.sin(a)).toFixed(1)]; };
  const sp = (i, v, cls) => { const [x1, y1] = pt(i, r0); const [x2, y2] = pt(i, r0 + len * (v / max)); return '<line class="' + cls + '" x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '"/>'; };
  const two = (n) => String(n).padStart(2, '0');
  return '<svg class="rd-ring" viewBox="0 0 ' + size + ' ' + size + '" aria-label="turns by hour, last 28 days">'
    + '<circle cx="' + c + '" cy="' + c + '" r="' + (r0 - 3) + '" class="dr-core"/>'
    + ring.map((v, i) => sp(i, v, 'dr-all')).join('') + (today || []).map((v, i) => (v ? sp(i, v, 'dr-today') : '')).join('')
    + (peak ? '<text x="' + c + '" y="' + (c + 4) + '" class="rd-c">' + two(peak.start) + '–' + two(peak.end) + '</text>' : '')
    + '</svg>';
}
async function renderReading() {
  const host = $('#sysReading');
  if (!host || !C.reading) return;
  if (!_readingV || Date.now() - _readingAt > 45000) {
    const v = await C.reading().catch(() => null);
    if (v && !v.error) { _readingV = v; _readingAt = Date.now(); }
  }
  const v = _readingV;
  if (!v) return;
  setHTML(host, '<div class="reading glass-deep" data-jump="systems" role="button" tabindex="0" title="open the Systems Lens">'
    + rhythmRingSvg(v.ring, v.today, v.peak, 120)
    + '<div class="rd-text"><div class="rd-k">THE READING</div><div class="rd-line">' + esc(v.line) + '</div>'
    + (v.more ? '<div class="rd-more">' + esc(v.more) + '</div>' : '') + '</div></div>');
}
function renderEngineRoom(o) {
  const host = $('#engineRoom');
  if (!host) return;
  const air = ATTN.air;
  const wf = ATTN.wf || {};
  const auto = ATTN.auto || null;
  const inflight = (o.working || []).filter((w) => w.inflight).length;
  // main-side truth first — the renderer globals are blind until their views
  // have been opened, and this band's one job is to never be blind
  const duoOn = o.duoActive != null ? !!o.duoActive
    : !!(typeof CONTROL !== 'undefined' && CONTROL && CONTROL.duo && CONTROL.duo.active);
  const omniArmed = o.omniArmed != null ? !!o.omniArmed
    : !!(typeof OMNI !== 'undefined' && OMNI && OMNI.data && OMNI.data.armed);
  const st = (hue, view, name, on, line) =>
    '<button class="er-st' + (on ? ' on' : '') + '" style="--sh:' + hue + '" data-jump="' + view + '">'
    + '<span class="er-orb"></span><span class="er-name">' + name + '</span>'
    + '<span class="er-line">' + esc(line) + '</span></button>';
  setHTML(host, '<div class="engine-room glass">'
    + st(210, 'live', 'FLEET', inflight > 0, inflight ? inflight + ' agent(s) mid-turn' : 'idle — waiting on you')
    + st(320, 'duo', 'DUO-DRIVE', duoOn, duoOn ? 'compounding on its own' : 'off — progress stops with you')
    + st(175, 'omni', 'MOTUS MAX', omniArmed, omniArmed ? (o.omniPreRead && o.omniPreRead.status === 'ready' ? 'armed — a move is ready, press Drive' : o.omniPreRead && o.omniPreRead.status === 'reading' ? 'armed — choosing the move now' : 'armed — she may act') : 'disarmed')
    + st(155, 'tasks', 'AUTO-WORK', !!(auto && (auto.on || auto.current)), (auto && (auto.on || auto.current)) ? 'working the fleet queue' : 'queue is quiet')
    + st(280, 'workflows', 'WORKFLOWS', (wf.running || 0) > 0, (wf.running || 0) ? wf.running + ' progression(s) in flight' : (wf.blocked ? wf.blocked + ' blocked at a gate' : 'none running'))
    + st(10, 'stream', 'BROADCAST', !!(air && air.on), (air && air.on) ? 'ON AIR — by your choice' : 'dark — nothing shared')
    + '</div>');
}

/* ── TODAY — the receipts ───────────────────────────────────────────────────
   Lifetime counters flatter and midnight resets them honest. Four receipts
   since midnight, each a door to its evidence, plus the last three things that
   actually SHIPPED — titles, not numbers, because a title can be disputed and
   a number cannot be checked. */
function renderDayLedger(o) {
  const host = $('#dayLedger');
  if (!host) return;
  const out = ATTN.out || {};
  const ship = ATTN.ship || {};
  const pats = (ATTN.stations || []).some((x) => x.view === 'systems');
  const cell = (cls, big, sub, jump) => '<div class="st-si ' + (cls || '') + (jump ? ' jump' : '') + '"'
    + (jump ? ' data-jump="' + jump + '" role="button" tabindex="0"' : '') + '><b>' + big + '</b><i>' + sub + '</i></div>';
  setHTML(host, '<div class="panel glass day-ledger">'
    + '<div class="panel-head"><h3>Today</h3><span class="panel-sub">receipts since midnight — each one is a door</span></div>'
    + '<div class="st-strip n4">'
    + cell((o.stats && o.stats.todayTurns) ? 'go' : 'zero', (o.stats && o.stats.todayTurns) || 0, 'turns driven', 'usage')
    + cell(out.today ? 'go' : 'zero', out.today || 0, out.today ? 'file(s) landed' : 'nothing landed yet', 'output')
    + cell(ship.today ? 'live' : 'zero', ship.today || 0, ship.today ? 'move(s) shipped' : 'nothing shipped yet', 'duo')
    + cell(pats ? 'zero' : 'go', pats ? '⟲' : '✓', pats ? 'a pattern is repeating' : 'no repeats today', 'systems')
    + '</div>'
    + ((ship.latest || []).length ? '<div class="rcp-list">' + ship.latest.map((t) =>
        '<div class="rcp-row"><span class="rcp-tick">✓</span><span class="rcp-t">' + esc(t) + '</span></div>').join('') + '</div>' : '')
    + '</div>');
}
function renderNow(working) {
  const live = working.filter((w) => w.inflight || w.status === 'incomplete');
  setHTML($('#nowStrip'), live.length ? live.map((w) => `
    <div class="now-card glass-deep tone-${TONE[w.agent]}" data-agent="${w.agent}">
      <div class="now-head">
        <span class="now-orb ${w.inflight ? 'live' : ''}"></span>
        <span class="now-agent">${esc(cap(w.agent))}</span>
        <span class="now-state">${w.inflight ? 'working now' : 'paused — will resume'}</span>
        <span class="now-elapsed mono" ${w.startEpoch > 0 ? `data-elapsed="${w.startEpoch}"` : ''}>${w.startEpoch > 0 ? fmtDur(Date.now() - w.startEpoch) : '—'}</span>
        <button class="now-watch" data-watch="${w.agent}">Watch live →</button>
      </div>
      <div class="now-ask expandable"><span class="now-lbl">Your ask</span>${esc(w.inbound || '—')}</div>
      <div class="now-foot">
        ${w.lastEvent ? `<span class="now-ev">${w.lastEvent.kind === 'tool' ? '⚙ ' + esc(w.lastEvent.name) : '✎ writing'} <i>${esc((w.lastEvent.summary || '').slice(0, 90))}</i></span>` : ''}
        <span class="now-meta">${w.toolCount} tool calls${w.filesTouched.length ? ` · ${w.filesTouched.length} file(s) touched` : ''} · active ${ago(w.lastActivity)} ago</span>
      </div>
    </div>`).join('') : '');
  restoreExpanded($('#nowStrip'));
  $$('#nowStrip [data-watch]').forEach((b) => b.onclick = (e) => { e.stopPropagation(); LIVE.agent = b.dataset.watch; switchView('live'); });
}
function vital(label, big, sub, meter) {
  meter = +meter; if (!isFinite(meter)) meter = 0;
  return `<div class="vital"><div style="flex:1">
    <div class="vlabel">${label}</div><div class="vbig">${big}</div><div class="vsub">${sub}</div>
    <div class="vmeter" style="margin-top:8px"><i style="width:${Math.max(2, Math.min(100, meter))}%"></i></div>
  </div></div>`;
}
function stat(k, v, u, tone, ic) {
  return `<div class="stat glass accent-${tone}"><div class="sk">${ic ? `<span class="tone-${tone === 'v' ? 'violet' : 'cyan'}">${ic}</span>` : ''}${k}</div><div class="sv">${v}</div><div class="su">${u}</div></div>`;
}
function rrow(x) {
  return `<div class="rrow expandable" title="click to expand">
    <span class="rtime">${esc((x.ts || '').slice(5, 16))}</span>
    <span class="ragent tone-${TONE[x.agent] || 'slate'}">${esc(cap(x.agent))}</span>
    <span class="rmsg">${esc(x.msg || '—')}</span>
    <span class="rstat ${statusClass(x.status)}">${esc((x.status || '').split('-')[0])}</span>
    <span class="rlat">${x.latency ? Math.round(x.latency) + 's' : '—'}</span>
  </div>`;
}
// tick the elapsed counters in place — no re-render, no flicker. Idle when hidden.
setInterval(() => {
  if (document.hidden) return;
  $$('[data-elapsed]').forEach((el) => { const s = +el.dataset.elapsed; if (s && isFinite(s)) el.textContent = fmtDur(Date.now() - s); });
}, 1000);
/* rituals */
async function runRitual(kind) {
  const btn = kind === 'lockin' ? $('#lockinBtn') : kind === 'compact' ? $('#compactBtn') : $('#wrapupBtn');
  if (kind === 'wrapup' && !confirm('Wrap up the day?\n\n• Archives memory files older than 7 days (newest 2 always kept, reversible)\n• Compacts CortexInsight\'s own vault\n• Asks Davara for an end-of-day recap (arrives as a notification)\n\nProceed?')) return;
  if (btn) btn.disabled = true;
  const r = await C.ritual(kind);
  if (btn) btn.disabled = false;
  if (!r || !r.ok) { toast('Ritual failed: ' + ((r && r.error) || '?'), 'bad'); return; }
  setHTML($('#ritualResult'), `
    <div class="ritual-card glass-deep ${kind}">
      <div class="ritual-title">${esc(r.title)}</div>
      ${r.lines.map((l) => `<div class="ritual-line">${esc(l)}</div>`).join('')}
      <button class="ritual-close" onclick="this.parentElement.remove()">dismiss</button>
    </div>`);
  toast(kind === 'lockin' ? 'Locked in ⚡' : kind === 'compact' ? 'Compacted ◇' : 'Day wrapped ☾', 'good');
}
$('#lockinBtn').onclick = () => runRitual('lockin');
$('#compactBtn').onclick = () => runRitual('compact');
$('#wrapupBtn').onclick = () => runRitual('wrapup');
const NODE_POS = { davara: [22, 24], davaris: [78, 24], davari: [50, 26], 'sympath-cortex': [9, 58], arden: [91, 58], august: [32, 84], 'august-v3': [68, 84] };
const NODE_LETTER = { davara: 'D', davaris: 'D', davari: 'D', 'sympath-cortex': 'S', arden: 'A', august: 'A', 'august-v3': 'V' };
function renderConstellation(pulse) {
  const agents = (pulse && pulse.agents) || {};
  const lines = Object.keys(NODE_POS).map((a) => {
    const [x, y] = NODE_POS[a]; return `<line x1="50%" y1="50%" x2="${x}%" y2="${y}%"/>`;
  }).join('');
  const nodes = Object.keys(NODE_POS).map((a) => {
    const [x, y] = NODE_POS[a]; const st = agents[a] || {};
    const cls = st.live ? 'live' : st.recent ? 'recent' : st.lastEpoch ? '' : 'dormant';
    const stTxt = st.live ? 'live' : st.recent ? 'active' : st.lastEpoch ? 'idle' : 'dormant';
    return `<div class="cnode ${cls} ${a === 'arden' ? 'cnode-hidden' : ''}" data-tone="${TONE[a]}" style="left:${x}%;top:${y}%;transform:translate(-50%,-50%)">
      <div class="core">${NODE_LETTER[a] || cap(a)[0]}</div><div class="lbl">${esc(aname(a))}</div>
      <div class="st s-${stTxt}">${stTxt}</div></div>`;
  }).join('');
  setHTML($('#constellation'), `<svg class="links">${lines}</svg><div class="center-sun"></div>${nodes}`);
}

/* ============================ AGENTS ============================ */
async function loadAgents() {
  const list = await C.agents(); if (!list || list.error) return viewFail('agents', list || null);
  setHTML($('#agentGrid'), list.map((a) => `
    <div class="acard glass" data-tone="${a.tone}">
      <div class="acard-top">
        <div class="ava">${cap(a.id)[0]}</div>
        <div style="flex:1;min-width:0"><div class="aname">${esc(a.id)}</div><div class="arole">${esc(a.role)}</div></div>
        <div class="astatus ${a.status}">${esc(a.status)}</div>
      </div>
      <div class="focus expandable">${a.lastFocus ? esc(a.lastFocus) : '<span class="muted">No recent focus on record.</span>'}</div>
      <div class="ametrics">
        <div class="ametric"><div class="mv">${a.turns}</div><div class="ml">turns</div></div>
        <div class="ametric"><div class="mv">${Math.round((a.cleanRate || 1) * 100)}%</div><div class="ml">clean</div></div>
        <div class="ametric"><div class="mv">${a.avgLatency ? Math.round(a.avgLatency) + 's' : '—'}</div><div class="ml">avg</div></div>
      </div>
      <div style="display:flex;justify-content:space-between;margin-top:12px;font-size:10.5px;color:var(--faint)">
        <span>${a.lastTs ? 'last ' + ago(a.lastTs) + ' ago' : 'dormant'}</span>
        <span>~${compact(a.tokens)} tok · ${a.maxTurns} max-turns</span>
      </div>
    </div>`).join(''));
}

/* ============================ TASKS ============================ */
async function loadTasks() {
  const agents = ['all', ...(FLEET_LIVE.length ? fleetIds() : ['davara', 'davaris', 'august', 'august-v3'])];
  setHTML($('#taskFilters'),
    agents.map((a) => `<button class="chip ${CUR.taskAgent === a ? 'on' : ''}" data-ta="${a}">${a === 'all' ? 'All agents' : cap(a)}</button>`).join('') +
    `<span style="width:14px"></span>` +
    ['all', 'faults'].map((s) => `<button class="chip ${CUR.taskStatus === s ? 'on' : ''}" data-ts="${s}">${s === 'all' ? 'All' : 'Faults only'}</button>`).join(''));
  $$('#taskFilters [data-ta]').forEach((b) => b.onclick = () => { CUR.taskAgent = b.dataset.ta; loadTasks(); });
  $$('#taskFilters [data-ts]').forEach((b) => b.onclick = () => { CUR.taskStatus = b.dataset.ts; loadTasks(); });
  const r = await C.tasks({ agent: CUR.taskAgent, status: CUR.taskStatus, limit: 200 });
  if (!r || r.error) return;
  setHTML($('#taskTable'),
    `<div class="thead"><span>Date · Time</span><span>Agent</span><span>Focus / Subject</span><span>Status</span><span>Time</span><span>~Tok</span></div>
     <div class="task-rows">` +
    (r.items.map((x) => `
      <div class="trow expandable" title="click to expand">
        <span class="ttime">${esc(fmtDT(x.ts))}</span>
        <span class="ragent tone-${TONE[x.agent] || 'slate'}">${esc(cap(x.agent))}</span>
        <span class="tmsg">${esc(x.msg || '—')}</span>
        <span class="tstat ${statusClass(x.status)}">${esc((x.status || '').split('-')[0])}</span>
        <span class="tnum">${x.latency ? Math.round(x.latency) + 's' : '—'}</span>
        <span class="tnum">${compact(x.tokens)}</span>
      </div>`).join('') || `<div class="empty">No matching turns.</div>`) +
    `</div><div style="padding:12px 10px;font-size:11px;color:var(--faint)">Showing ${r.items.length} of ${r.total} turns</div>`);
}

/* ============================ CHAT / COMMAND ============================ */
const chatMsgs = [];
function loadChatBar() {
  // EVERY agent in the fleet appears here — including the OpenRouter lane, which
  // is shown as observed-only (it answers on its own gateway, not the relay).
  const list = FLEET_LIVE.length ? FLEET_LIVE : [{ id: 'davara', lane: 'relay' }];
  const tagOf = (f) => f.lane !== 'relay' ? ' · openrouter'
    : f.id === 'august-v3' ? ' · observer' : f.id === 'sympath-cortex' ? ' · healer'
    : f.id === 'arden' ? ' · guardian' : f.id === 'davaris' ? ' · builder'
    : f.id === 'davari' ? ' · fast lane' : '';
  $('#chatAgentBar').innerHTML = list.map((f) => {
    const id = f.id;
    const off = f.lane !== 'relay';
    const paused = !!f.paused;
    return `<button class="abtn ${CUR.chatAgent === id ? 'on' : ''} ${off ? 'ext' : ''} ${paused ? 'paused' : ''}" data-tone="${TONE[id] || 'slate'}" data-ca="${id}"
      title="${off ? 'Runs on its own OpenRouter gateway — observed in Live / Board / Output, not driven from Command.' : paused ? 'Paused — resume it in Agents or Model.' : esc(mlabel(f.model) + ' · ' + (QLABEL[f.effort] || f.effort || ''))}">
      <span class="d"></span>${aname(id)}${tagOf(f)}${paused ? ' ⏸' : ''}</button>`;
  }).join('');
  $$('#chatAgentBar [data-ca]').forEach((b) => b.onclick = () => { CUR.chatAgent = b.dataset.ca; loadChatBar(); });
  renderCommandStrip(list);
}
/* ── COMMAND · WHO YOU ARE ABOUT TO TALK TO ─────────────────────────────────
   The one view with no reading at all, and the one where a wrong assumption is
   most expensive: a message sent to a paused agent, or at a depth he did not
   mean to spend. This states the seat, its brain, its depth and whether the
   line is busy — before he types, not after he waits. */
function renderCommandStrip(list) {
  const host = $('#cmdStrip');
  if (!host) return;
  const me = (list || []).find((f) => f.id === CUR.chatAgent) || (list || [])[0] || {};
  const ov = ATTN.ov || {};
  const inflight = (ov.working || []).filter((w) => w.inflight);
  const mine = inflight.filter((w) => w.agent === me.id).length;
  const cell = (cls, big, sub) => '<div class="st-si ' + (cls || '') + '"><b>' + big + '</b><i>' + sub + '</i></div>';
  setHTML(host, '<div class="st-strip n5">'
    + cell(me.paused ? 'zero' : 'go', esc(aname(me.id) || '—'),
        me.paused ? 'PAUSED — it will not answer' : (me.lane !== 'relay' ? 'observed only — answers on its own gateway' : 'on deck'))
    + cell('', esc(mlabel(me.model) || 'default'), 'the brain it thinks with')
    + cell('', esc((QLABEL[me.effort] || me.effort || 'default')), 'depth — this is what it costs')
    + cell(mine ? 'live' : '', mine, mine ? 'turn(s) of yours in flight' : 'the line is free')
    + cell('', (ov.stats && ov.stats.todayTurns) || 0, 'turns today, whole fleet')
    + '</div>');
}
function seedChatGreeting() {
  if (chatMsgs.length) return;
  pushMsg('sys', '', 'You are speaking to the Cortex through the same loopback relay Hermes uses. Plain text → selected agent · /steer … nudges live work · /goal … sets the north star · /motus … names the strongest thing moving now · /compact tidies the vault and keeps you working.');
}
function pushMsg(role, who, text, kind = '') {
  chatMsgs.push({ role, who, text, kind });
  // A window left open for a week accumulated every message ever sent and
  // re-rendered all of them on each new one — quadratic work, unbounded memory.
  if (chatMsgs.length > 160) chatMsgs.splice(0, chatMsgs.length - 160);
  renderChat();
}
function renderChat() {
  const log = $('#chatLog'); if (!log) return;
  if (chatMsgs.length > 80) chatMsgs.splice(0, chatMsgs.length - 80); // keep the conversation bounded
  log.innerHTML = chatMsgs.map((m) => {
    if (m.role === 'sys') return `<div class="msg sys">${esc(m.text)}</div>`;
    const who = m.who ? `<div class="who">${esc(m.who)}</div>` : '';
    const pend = m.pending ? ' pending' : '';
    const kc = m.kind ? ' kind-' + m.kind : '';
    return `<div class="msg ${m.role}${pend}${kc}">${who}${esc(m.text)}${m.timer ? `<div class="thinking-timer" data-timer>${m.timer}</div>` : ''}</div>`;
  }).join('');
  log.scrollTop = log.scrollHeight;
}
const chatBox = $('#chatBox');
chatBox.addEventListener('input', () => { chatBox.style.height = 'auto'; chatBox.style.height = Math.min(140, chatBox.scrollHeight) + 'px'; });
chatBox.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#chatForm').requestSubmit(); } });
$('#chatForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const raw = chatBox.value.trim(); if (!raw) return;
  let kind = 'chat', text = raw, agent = CUR.chatAgent;
  // /compact — a command, not a message: compact the vault and keep working.
  if (/^\/compact\b/i.test(raw)) {
    chatBox.value = ''; chatBox.style.height = 'auto';
    pushMsg('me', 'You', '/compact', 'goal');
    switchView('overview');
    await runRitual('compact');
    return;
  }
  if (/^\/steer\b/i.test(raw)) { kind = 'steer'; text = raw.replace(/^\/steer\s*/i, ''); if (!text) { toast('Usage: /steer <your nudge>', 'bad'); return; } }
  else if (/^\/goal\b/i.test(raw)) { kind = 'goal'; text = raw.replace(/^\/goal\s*/i, ''); if (!text) { toast('Usage: /goal <your long-term focus>', 'bad'); return; } }
  else if (/^\/motus\b/i.test(raw)) { kind = 'motus'; text = raw.replace(/^\/motus\s*/i, ''); if (!text) { toast('Usage: /motus <the strongest thing moving now>', 'bad'); return; } }
  chatBox.value = ''; chatBox.style.height = 'auto';
  pushMsg('me', kind === 'steer' ? `/steer → ${aname(agent)}` : kind === 'goal' ? `/goal → ${aname(agent)}` : kind === 'motus' ? `/motus → ${aname(agent)}` : `You → ${aname(agent)}`, text, kind === 'chat' ? '' : kind);
  const pending = { role: 'them', who: aname(agent), text: '', pending: true, timer: '0s', kind: kind === 'chat' ? '' : kind };
  chatMsgs.push(pending); renderChat();
  const t0 = Date.now();
  // tick the timer node in place — never re-render the log (kills selection + flickers)
  const iv = setInterval(() => { pending.timer = Math.round((Date.now() - t0) / 1000) + 's'; const tEl = $('#chatLog [data-timer]'); if (tEl) tEl.textContent = pending.timer; }, 1000);
  $('#chatSend').disabled = true;
  const r = await C.send({ agent, kind, text });
  clearInterval(iv); $('#chatSend').disabled = false;
  pending.pending = false; pending.timer = null;
  pending.text = r.ok ? r.text : `⚠ ${r.error || 'relay did not return'}`;
  if (!r.ok) pending.role = 'them';
  renderChat();
  if (kind === 'goal') { toast('North-star goal set ◎', 'good'); loadOverview(); }
  if (kind === 'steer') toast('Steer delivered ↗', 'good');
});

/* ============================ WORK PREVIEW ============================ */
function loadWork() {
  const agents = (FLEET_LIVE.length ? fleetIds() : ['davara', 'davaris', 'august', 'august-v3']);
  $('#workTabs').innerHTML = agents.map((a) => `<button class="chip ${CUR.workAgent === a ? 'on' : ''}" data-wa="${a}">${aname(a)}</button>`).join('');
  $$('#workTabs [data-wa]').forEach((b) => b.onclick = () => { CUR.workAgent = b.dataset.wa; loadWork(); });
  renderWorkBody();
}
async function renderWorkBody() {
  const r = await C.taskDetail(CUR.workAgent); if (!r || r.error) return viewFail('work', r || null);
  const body = (r.preview || '').trim();
  if (!body) { $('#workBody').innerHTML = `<div class="empty">No continuity thread yet for ${cap(CUR.workAgent)}.</div>`; return; }
  const html = esc(body)
    .replace(/^### (.+)$/gm, '<span class="wh">◷ $1</span>')
    .replace(/^\*\*In:\*\* (.+)$/gm, '<span class="win">▸ In: $1</span>')
    .replace(/^\*\*(DAVARA|DAVARIS|Cortex →):\*\*/gm, '<span class="wh">$1 →</span>')
    .replace(/^---$/gm, '<span class="wsep">─────────</span>');
  $('#workBody').innerHTML = html;
}

/* ============================ USAGE ============================ */
async function loadUsage() {
  const u = await C.usage(); if (!u || u.error) return viewFail('usage', u);
  setHTML($('#usageTotals'), [
    stat('Total turns', compact(u.totals.turns), 'lifetime', 'v', '◇'),
    stat('Est. tokens', compact(u.totals.tokens), '≈ output ÷ 4', 'c', '◈'),
    stat('Output chars', compact(u.totals.chars), 'relayed', 'v', '∿'),
    stat('Reasoning time', fmtSecs(u.totals.secs), 'agent compute', 'c', '◷'),
  ].join(''));
  const max = Math.max(1, ...u.byAgent.map((a) => a.turns));
  setHTML($('#usageByAgent'), u.byAgent.filter((a) => a.turns).map((a) => `
    <div class="ub-row">
      <span class="ragent tone-${TONE[a.agent] || 'slate'}">${cap(a.agent)}</span>
      <span class="ubar"><i style="width:${(a.turns / max) * 100}%"></i></span>
      <span class="tnum">${a.turns} t</span>
      <span class="tnum">${compact(a.tokens)} tok</span>
      <span class="tnum">${Math.round((a.cleanRate || 1) * 100)}%</span>
    </div>`).join('') || `<div class="empty">No usage yet.</div>`);
  const series = u.series.slice(-30);
  const maxC = Math.max(1, ...series.map((d) => d.secs));
  setHTML($('#usageChart'), series.map((d) => `
    <div class="bar" style="height:${Math.max(3, (d.secs / maxC) * 100)}%">
      <span class="btip">${d.day} · ${d.turns} turns · ${fmtSecs(d.secs)} · ${compact(d.tokens)} tok</span>
      <span class="blab">${d.day.slice(5)}</span>
    </div>`).join('') || `<div class="empty">No daily data.</div>`);
}

/* ============================ LEARNINGS ============================ */
async function loadLearnings() {
  const r = await C.learnings(); if (!r || r.error) return viewFail('learnings', r || null);
  // WHAT KEEPS HAPPENING — the same text that rides in every agent brief, so
  // what he reads and what the fleet reads are one sentence. Repetition only:
  // a single failure is an event, twice is a pattern.
  const pat = $('#learnPatterns');
  if (pat) {
    // APPLIED — the R2 loop's output gauge. Banked is memory; applied is
    // closed work that later spoke a learning's words. Zero tokens.
    const ap = r.applied || null;
    const applied = ap && ap.considered
      ? `<div class="pat-card applied"><div class="pat-h">Applied</div><div class="pat-row">${ap.week} learning${ap.week === 1 ? '' : 's'} showed up in work closed this week · ${ap.any} ever, of ${ap.considered} read. A learning counts as applied when a task closed or a receipt shipped after it shares its words.</div></div>`
      : '';
    pat.innerHTML = applied + ((r.patterns || []).length
      ? `<div class="pat-card"><div class="pat-h">What keeps happening</div>${
          r.patterns.map((p) => `<div class="pat-row">${esc(String(p).replace(/^-\s*/, ''))}</div>`).join('')
        }<div class="pat-foot">These ride in every agent brief too — the fleet starts each turn knowing them.</div></div>`
      : '');
  }
  setHTML($('#learnDerived'), r.derived.length ? capList('learnDerived', r.derived, (it) => ledger(it, null)) : `<div class="empty">Not enough telemetry yet — insights appear as turns accumulate.</div>`);
  attachLedger($('#learnDerived'), null, loadLearnings);
  setHTML($('#learnLedger'), r.persisted.length ? capList('learnLedger', r.persisted, (it) => ledger(it, 'learnings')) : `<div class="empty">Empty ledger. Hit “Ask Cortex to reflect” to begin compounding.</div>`);
  attachLedger($('#learnLedger'), 'learnings', loadLearnings);
}
// shared action wiring for ledger lists (approve / done / propose / dismiss)
function attachLedger(container, list, reload) {
  $$('[data-lact]', container).forEach((b) => b.onclick = async (e) => {
    e.stopPropagation();
    const item = b.closest('.ledger-item');
    const act = b.dataset.lact, ts = item.dataset.ts, title = item.dataset.title, body = item.dataset.body;
    if (act === 'task') {
      // a learning with a next move in it becomes work, not just memory
      const r = await C.taskCreate({ title: String(title).slice(0, 140), body, tags: ['learning'], owner: 'mine' });
      toast(r && r.ok ? 'On the Board' : 'could not add: ' + ((r && r.error) || '?'), r && r.ok ? 'good' : 'bad');
      return;
    }
    if (act === 'propose') {
      if (!confirm(`Send this to Sympath-Cortex to implement?\n\n"${title}"\n\nShe'll receive it as an approved proposal and work it within the Cortex guardrails (read-only diagnosis + proposed fix). Her response arrives as a notification.`)) return;
      const r = await C.propose({ agent: 'sympath-cortex', title, body });
      toast(r && r.ok ? 'Proposed → Sympath-Cortex is on it; you\'ll get a notification' : 'Could not send', r && r.ok ? 'good' : 'bad');
      return;
    }
    const r = await C.ledgerAct({ list, ts, action: act });
    if (r && r.ok) { toast(act === 'approve' ? 'Approved ✓' : act === 'done' ? 'Marked done ✓' : 'Dismissed', 'good'); reload(); }
  });
}
let _reflecting = false;
$('#reflectBtn').onclick = async () => {
  if (_reflecting) return; _reflecting = true;
  const b = $('#reflectBtn'); b.disabled = true; b.textContent = '↻ Davara is reflecting…';
  const r = await C.reflect('learn').catch(() => null);
  _reflecting = false;
  b.disabled = false; b.textContent = '↻ Ask Cortex to reflect';
  if (r && r.ok) { toast(r.added ? `Davara folded ${r.added} new learning(s) in` : 'Nothing new — already in the ledger', 'good'); loadLearnings(); }
  else toast('Reflection could not complete: ' + ((r && r.error) || 'relay'), 'bad');
};
function ledger(it, list) {
  const src = (it.source || 'telemetry').replace(/[^a-z-]/gi, '');
  const full = `${it.title}${it.body && it.body !== it.title ? '\n\n' + it.body : ''}`;
  const acts = [];
  if (it.body && it.body.length > 160) acts.push(`<button class="mini accent" data-read="1">⤢ read full</button>`);
  acts.push(`<button class="mini" data-copy="${escAttr(full)}">⧉ copy</button>`);
  const canPropose = list || src === 'telemetry' || src === 'arden' || src === 'sympath-reflection' || src === 'davara-reflection' || src === 'wrapup-recap';
  if (canPropose) acts.push(`<button class="mini accent" data-lact="propose">↗ propose → sympath</button>`);
  if (list === 'learnings') acts.push(`<button class="mini good" data-lact="approve">✓ approve</button>`);
  if (list === 'learnings') acts.push(`<button class="mini" data-lact="task" title="make this a task on the Board">→ board</button>`);
  if (list === 'nextSteps') acts.push(`<button class="mini good" data-lact="done">✓ done</button>`);
  if (list) acts.push(`<button class="mini" data-lact="dismiss">✕</button>`);
  return `<div class="ledger-item expandable ${it.approved ? 'approved' : ''} ${it.done ? 'isdone' : ''}" data-ts="${esc(it.ts || '')}" data-title="${esc(it.title)}" data-body="${esc(it.body || '')}">
    <div class="lt"><span class="src-tag src-${src}">${esc(it.source || 'telemetry')}</span> ${esc(it.title)}
      ${it.endorsedBy ? `<span class="lflag endorse">★ ${esc(it.endorsedBy)} endorsed</span>` : ''}${it.approved ? '<span class="lflag good">✓ approved</span>' : ''}${it.done ? '<span class="lflag good">✓ done</span>' : ''}${it.applied ? `<span class="lflag good" title="closed tasks or shipped receipts after this was banked that share its words">↻ applied ${it.applied}×</span>` : ''}</div>
    ${it.body && it.body !== it.title ? `<div class="lb">${esc(it.body)}</div>` : ''}
    <div class="lact">${acts.join('')}${it.ts ? `<span class="lm">${fmtTs(it.ts)}</span>` : ''}</div>
  </div>`;
}

/* ============================ NEXT STEPS ============================ */
async function loadNext() {
  const r = await C.nextSteps(); if (!r || r.error) return viewFail('nextsteps', r);
  setHTML($('#nextDerived'), r.derived.length ? capList('nextDerived', r.derived, (it) => ledger(it, null)) : `<div class="empty">All measured signals nominal — no action items right now. 🌱</div>`);
  attachLedger($('#nextDerived'), null, loadNext);
  setHTML($('#nextLedger'), r.persisted.length ? capList('nextLedger', r.persisted, (it) => ledger(it, 'nextSteps')) : `<div class="empty">No proposals yet. Ask the Cortex for next moves.</div>`);
  attachLedger($('#nextLedger'), 'nextSteps', loadNext);
  loadEvolution();
}
async function loadEvolution() {
  const r = await C.proposals(); if (!r || r.error) return;
  setHTML($('#evoProposals'), r.proposals.length ? r.proposals.map((p) => `
    <div class="evo-card" data-pid="${esc(p.id)}">
      <div class="evo-top">
        <div><div class="evo-title">${esc(p.title)}</div>
          <div class="evo-lever"><span class="conf conf-${p.confidence}">${p.confidence}</span> ${esc(p.lever)} · <span class="muted">${esc(p.from)}</span> → <b>${esc(p.to)}</b></div></div>
        <div class="evo-actions">
          <button class="evo-apply" data-apply="${escAttr(JSON.stringify(p))}">Apply</button>
          <button class="mini" data-copy="${esc(p.title + '\n' + p.lever + ': ' + p.from + ' → ' + p.to + '\n\n' + p.rationale)}">⧉</button>
          <button class="evo-dismiss" data-dismiss="${esc(p.id)}">Dismiss</button>
        </div>
      </div>
      <div class="evo-why">${esc(p.rationale)}</div>
    </div>`).join('') : `<div class="empty">No proposals — telemetry is within healthy bounds. Proposals appear when a clear, safe optimization is measured.</div>`);
  setHTML($('#evoExperiments'), r.experiments.length ? r.experiments.map((e) => `
    <div class="exp-row">
      <div class="exp-main"><div class="exp-title">${esc(e.title || e.lever)}</div>
        <div class="exp-sub muted">${esc(e.lever)} · ${esc(e.from)} → ${esc(e.to)} · ${fmtTs(e.ts)}</div></div>
      <div class="exp-verdict ${e.verdict ? (e.verdict.good ? 'good' : 'mixed') : 'running'}">
        ${e.verdict ? esc(e.verdict.summary) : `measuring… (${e.before ? e.before.n + ' before' : ''})`}
      </div>
    </div>`).join('') : `<div class="empty">No experiments yet. Applying a proposal (or switching a model) starts a measured before/after here.</div>`);
  $$('#evoProposals .evo-apply').forEach((b) => b.onclick = async () => {
    const p = JSON.parse(b.dataset.apply);
    if (!confirm(`Apply this evolution?\n\n${p.title}\n${p.lever}: ${p.from} → ${p.to}\n\nThis rewrites the runner default (a .bak backup is kept), takes effect next turn, and starts a measured before/after. Proceed?`)) return;
    b.disabled = true; b.textContent = 'Applying…';
    const res = await C.applyProposal(p);
    if (res.ok) { toast('Evolution applied — measuring effect', 'good'); loadEvolution(); loadModels && loadModels(); }
    else { toast('Could not apply: ' + (res.error || '?'), 'bad'); b.disabled = false; b.textContent = 'Apply'; }
  });
  $$('#evoProposals .evo-dismiss').forEach((b) => b.onclick = async () => { await C.dismissProposal(b.dataset.dismiss); loadEvolution(); });
}
$('#nextBtn').onclick = async () => {
  if (_reflecting) return; _reflecting = true;
  const b = $('#nextBtn'); b.disabled = true; b.textContent = '↻ Davara is planning…';
  const r = await C.reflect('next').catch(() => null);
  _reflecting = false;
  b.disabled = false; b.textContent = '↻ Ask Cortex for next moves';
  if (r && r.ok) { toast(r.added ? `${r.added} new proposal(s) added` : 'Nothing new — already in the ledger', 'good'); loadNext(); }
  else toast('Could not complete: ' + ((r && r.error) || 'relay'), 'bad');
};
$('#davaraNextBtn').onclick = async () => {
  if (_reflecting) return; _reflecting = true;
  const b = $('#davaraNextBtn'); b.disabled = true; b.textContent = '✦ Davara is seeing…';
  const r = await C.davaraNextMoves('manual').catch(() => null);
  _reflecting = false;
  b.disabled = false; b.textContent = '✦ Ask Davara — highest leverage';
  if (r && r.ok) { toast(r.added ? `Davara surfaced ${r.added} move(s) — also sent to Telegram` : 'Davara weighed in (no new distinct moves)', 'good'); loadNext(); }
  else toast('Could not complete: ' + ((r && r.error) || 'relay'), 'bad');
};

/* ============================ MODELS ============================ */
async function loadModels() {
  const r = await C.models(); if (!r || r.error) return viewFail('models', r || null);
  const cur = r.current.model;
  $('#modelCurrent').innerHTML = `<div class="mc-orb"></div><div><div class="mc-name">${esc(cur)}</div>
    <div class="mc-src">pinned in ${esc(r.current.source || 'runner')}</div></div>
    <div style="margin-left:auto;font-size:11px;color:var(--muted);max-width:280px">Single source of truth. Switching rewrites the <code>MODEL=</code> default (backup written, reversible) — effective next turn.</div>`;
  $('#modelGrid').innerHTML = r.known.map((m) => `
    <div class="mcard ${m.id === cur ? 'current' : ''}" data-mid="${esc(m.id)}">
      <div class="mn">${esc(m.label)}</div><div class="mid">${esc(m.id)}</div><div class="mnote">${esc(m.note)}</div>
      <div class="mcur">● current pin</div></div>`).join('');
  $$('#modelGrid .mcard').forEach((c) => c.onclick = async () => {
    const mid = c.dataset.mid; if (mid === cur) return;
    if (!confirm(`Switch the live model pin to:\n\n${mid}\n\nThis rewrites the runner MODEL= line (a .bak backup is kept). It takes effect on the next turn and does not interrupt any turn in flight. Proceed?`)) return;
    const res = await C.setModel({ model: mid });
    if (res.ok) { toast(`Model pin → ${mid}`, 'good'); loadModels(); loadOverview(); }
    else toast('Could not switch: ' + (res.error || '?'), 'bad');
  });
}

/* ============================ SECURITY ============================ */
async function loadSecurity() {
  const s = await C.security(); if (!s || s.error) return viewFail('security', s || null);
  const d = s.device;
  const verified = d.hashMatch || (d.wslReadable && d.relayReachable);
  setHTML($('#secDevice'), `
    <div class="sec-card ${verified ? 'verified' : ''}">
      <div class="scl">This device</div><div class="scv">${esc(d.hostname)} · ${esc(d.username)}</div>
      ${verified ? '<div class="vcheck">✓ Verified — this is the paired machine</div>' : '<div class="vcheck" style="color:var(--bad)">⚠ Unverified device</div>'}
      <div class="loop-note">
        <div class="sig"><span class="sd ${d.hashMatch ? 'y' : 'n'}"></span> Hardware fingerprint ${d.hashMatch ? 'matched' : 'not matched'}</div>
        <div class="sig"><span class="sd ${d.wslReadable ? 'y' : 'n'}"></span> fleet tree readable</div>
        <div class="sig"><span class="sd ${d.relayReachable ? 'y' : 'n'}"></span> Loopback relay reachable</div>
      </div>
    </div>
    <div class="sec-card"><div class="scl">Public IP</div><div class="scv ip-reveal" id="secIpVal" title="click to reveal">•••• ••• ••• ·· <span class="ip-cta">click to reveal</span></div>
      <div class="scl" style="margin-top:12px">Local IP</div><div class="scv">hidden</div></div>
    <div class="sec-card"><div class="scl">Fingerprint</div><div class="scv" style="font-size:11px">${esc(d.fingerprint.slice(0, 24))}…</div>
      <div class="scl" style="margin-top:12px">Relay binding</div><div class="scv" style="font-size:12px">${esc(s.relayBinding)}</div></div>
    <div class="sec-card" style="grid-column:1/-1"><div class="loop-note" style="border-color:var(--cyan)">${esc(s.note)} Tunnel-originated turns on record: <b>${s.tunnelTurns}</b>.</div></div>`);
  setHTML($('#secSent'), s.sentLog.length ? capList('secSent', s.sentLog, (e) => `
    <div class="ub-row" style="grid-template-columns:120px 60px 1fr 60px">
      <span class="ttime">${esc(fmtTs(e.ts))}</span>
      <span class="ragent tone-${TONE[e.agent] || 'slate'}">${cap(e.agent)}</span>
      <span class="rmsg">${esc(e.kind)} · ${esc((e.text || '').slice(0, 60))} <span style="color:var(--faint)">from ${esc(e.srcLocalIp || '—')}</span></span>
      <span class="rstat ${e.ok ? 's-ok' : 's-fault'}">${e.ok ? 'OK' : 'ERR'}</span>
    </div>`) : `<div class="empty">No commands issued via CortexInsight yet. Each one is stamped with its origin IP + this device's fingerprint.</div>`);
  setHTML($('#secInject'), s.injections.length ? capList('secInject', s.injections, (f) => `
    <div class="inject-row"><div class="ip">⚑ ${esc(f.ts)} · ${esc(f.agent)} · matched /${esc(f.pattern)}/</div><div class="ix">${esc(f.excerpt)}</div></div>`)
    : `<div class="heal-item ok"><span class="hi">✓</span> No injection patterns detected in recent inbound messages.</div>`);
  setHTML($('#secIntrusions'), s.intrusions.length ? capList('secIntrusions', s.intrusions, (i) => `
    <div class="inject-row"><div class="ip">⚠ ${esc(fmtTs(i.ts))} · ${esc(i.hostname)} · ${esc(i.publicIp || 'unknown IP')}</div>
      <div class="ix">fingerprint ${esc((i.fingerprint || '').slice(0, 16))}… · signals: hw=${i.signals.hashMatch} wsl=${i.signals.wslReadable} relay=${i.signals.relayReachable}</div></div>`)
    : `<div class="heal-item ok"><span class="hi">✓</span> No foreign-device attempts recorded. CortexInsight has only ever unlocked here.</div>`);
  // "click to reveal" — looks like an ordinary reveal; silently serves a decoy (the trap is never named here)
  const ipv = $('#secIpVal');
  if (ipv) ipv.onclick = async () => { const r = await C.canary().catch(() => null); if (r && r.ok) { ipv.classList.add('revealed'); ipv.textContent = r.served; } };
  setBadge('security', s.injections.length > 0 || s.intrusions.length > 0);
  loadIntegrity();
}
async function loadIntegrity() {
  const r = await C.integrity(); if (!r || r.error) return;
  const alerts = r.alerts || [];
  const alertHtml = alerts.length ? alerts.map((a) => `
    <div class="intg-alert">
      <div class="intg-head"><span class="ip">⚠ ${esc(a.rel)} changed</span>
        <button class="ghost-btn intg-accept" data-rel="${esc(a.rel)}">Accept new</button></div>
      <div class="intg-meta muted">${fmtTs(a.ts)} · ${esc(a.oldHash)} → ${esc(a.newHash)} · +${a.added}/−${a.removed} lines</div>
      ${(a.sample || []).length ? `<pre class="intg-diff">${(a.sample || []).map((l) => `<span class="${l[0] === '+' ? 'da' : 'dr'}">${esc(l)}</span>`).join('\n')}</pre>` : ''}
    </div>`).join('') : '';
  const baseHtml = (r.baseline || []).map((b) => {
    const flagged = alerts.find((a) => a.rel === b.rel);
    return `<div class="intg-row ${flagged ? 'flag' : ''}">
      <span class="intg-file">${flagged ? '⚠' : '✓'} ${esc(b.rel)}</span>
      <span class="muted mono" style="font-size:10px">${esc(b.hash)}</span>
      <span class="muted" style="font-size:10px">${(b.size / 1024).toFixed(1)} KB · baselined ${esc(new Date(b.ts).toLocaleDateString())}</span>
    </div>`;
  }).join('');
  setHTML($('#secIntegrity'),
    (alerts.length ? `<div class="intg-banner bad">${alerts.length} critical file(s) changed since baseline — review below.</div>` : `<div class="heal-item ok" style="margin-bottom:10px"><span class="hi">✓</span> All ${(r.baseline || []).length} critical files match their baseline. No tampering detected.</div>`)
    + alertHtml + `<div class="intg-list">${baseHtml || '<div class="empty">Baseline capturing…</div>'}</div>`);
  $$('#secIntegrity .intg-accept').forEach((b) => b.onclick = async () => { await C.acceptIntegrity(b.dataset.rel); toast('New baseline accepted for ' + b.dataset.rel, 'good'); loadIntegrity(); });
  const allBtn = $('#integrityAcceptAll'); if (allBtn) allBtn.onclick = async () => { if (confirm('Re-baseline ALL critical files to their current contents? Do this only if you made these changes yourself.')) { await C.acceptIntegrity('*'); toast('All baselines refreshed', 'good'); loadIntegrity(); } };
  setBadge('security', alerts.length > 0 || $(`#railNav .nav-btn[data-nav="security"]`).classList.contains('alert'));
}

/* ============================ SETTINGS + HEAL ============================ */
/* ── INTEGRATIONS · two stacks, one honest panel ──────────────────────────
   Every card says what the connection is, whether it is live, what leaves the
   machine, and how to wire it. Keys are verified before they are sealed and
   never come back to this side; the panel only ever sees keySet flags.
   Wiring is delegated on the document, so it survives every repaint.      */
function integrationsPanel(oa) {
  const on = !!(oa && oa.keySet);
  const st = (live, txt) => `<span class="integ-st ${live ? 'on' : 'off'}">${txt}</span>`;
  return `
    <div class="panel-head" style="margin-top:22px"><h3>Integrations</h3><span class="panel-sub">two stacks, three providers · <a href="#" data-go="mind">see her mind →</a></span></div>
    <div class="integ">
      <div class="integ-card">
        <div class="integ-h"><h4>Anthropic · the fleet</h4>${st(true, 'relay')}</div>
        <div class="integ-p">Davara and the relay seats run through the fleet relay on your Claude Code subscription. No API key is involved and none is stored here. The prompt leaves through Claude Code, nothing else.</div>
        <div class="integ-note">Path: Preferences → Fleet path. Per-seat models: Model → fleet bridge.</div>
      </div>
      <div class="integ-card">
        <div class="integ-h"><h4>OpenAI · the GPT seat and the studio</h4>${st(on, on ? 'key sealed' : 'no key')}</div>
        <div class="integ-p">${on
          ? 'Verified ' + esc(String(oa.verified).slice(0, 10)) + '. The GPT seat answers <code>/gpt</code> on Command; the studio makes images for every agent with this key, ' + oa.imagesToday + ' of ' + oa.imagesPerDay + ' today.'
          : 'Paste an API key from platform.openai.com. It is verified against the models endpoint before it is sealed with the OS keystore. This opens the GPT seat (<code>/gpt</code> on Command) and the image studio for the whole fleet.'}</div>
        <div class="integ-row">
          <input type="password" id="oaKey" placeholder="${on ? 'replace the key (sk-…)' : 'sk-…'}" autocomplete="off" spellcheck="false" />
          <button class="mini go" id="oaSave">${on ? 'Replace' : 'Verify and save'}</button>
          ${on ? '<button class="mini" id="oaClear">Forget key</button>' : ''}
        </div>
        ${on ? `<div class="integ-row">
          <select id="oaModel" class="sel"><option value="${escAttr(oa.model || '')}">${esc(oa.model || 'choose a model')}</option></select>
          <button class="mini" id="oaModels">Load models</button>
          <input type="text" id="oaImageModel" value="${escAttr(oa.imageModel || 'gpt-image-1')}" title="image model" style="max-width:150px" />
          <label class="nt-wip">images/day <input type="number" id="oaImages" min="0" max="200" value="${oa.imagesPerDay}" /></label>
        </div>` : ''}
        <div class="integ-note">What leaves the machine: the turn's text or the image prompt, to api.openai.com over TLS. Sign-in with a ChatGPT account is not wired; OpenAI's consumer login has no public app flow this app could use safely, so the key is the door.</div>
      </div>
      <div class="integ-card">
        <div class="integ-h"><h4>ElevenLabs · voice</h4>${st(!!(SETTINGS && SETTINGS.elevenKeySet), SETTINGS && SETTINGS.elevenKeySet ? 'key sealed' : 'no key')}</div>
        <div class="integ-p">Davara's voice on DASH-OPS. Only the reply text goes to ElevenLabs; your speech is transcribed locally.</div>
        <div class="integ-note">Manage it on DASH-OPS → voice.</div>
      </div>
      <div class="integ-card">
        <div class="integ-h"><h4>OpenRouter · Sympath SEI</h4>${st(true, 'own gateway')}</div>
        <div class="integ-p">Sympath SEI runs in her own Hermes gateway on her own key. This app observes her and never relays to her.</div>
        <div class="integ-note">Full flows: docs/INTEGRATIONS.md in the project.</div>
      </div>
    </div>

    <div class="panel-head" style="margin-top:22px"><h3>Access</h3><span class="panel-sub">the gate password</span></div>
    <div class="integ-card">
      <div class="integ-p">Set your own password for the gate. It is stored as a hash in the vault, never the text. Nothing in the code can open the gate.</div>
      <div class="integ-row"><input type="password" id="pwNew" placeholder="new password (12+ characters)" autocomplete="new-password" /><button class="mini go" id="pwSave">Set password</button></div>
    </div>`;
}
document.addEventListener('click', async (e) => {
  const t = e.target.closest('#settingsPanel [data-go], #oaSave, #oaClear, #oaModels, #pwSave');
  if (!t) return;
  if (t.dataset && t.dataset.go) { e.preventDefault(); switchView(t.dataset.go); return; }
  if (t.id === 'oaSave') {
    const k = (($('#oaKey') || {}).value || '').trim();
    if (!k) { toast('Paste a key first', 'warn'); return; }
    t.disabled = true; t.textContent = '… verifying';
    const r = await C.openaiSave({ key: k }).catch(() => null);
    t.disabled = false;
    if ($('#oaKey')) $('#oaKey').value = '';
    if (r && r.ok) { toast('OpenAI key verified and sealed', 'good'); loadSettings(); }
    else { t.textContent = 'Verify and save'; toast((r && r.error) || 'could not save', 'bad'); }
    return;
  }
  if (t.id === 'oaClear') {
    if (!confirm('Forget the OpenAI key? The GPT seat and the studio go dark until a key is added again.')) return;
    await C.openaiSave({ clearKey: true }); toast('Key forgotten', 'good'); loadSettings(); return;
  }
  if (t.id === 'oaModels') {
    t.disabled = true; t.textContent = '… loading';
    const r = await C.openaiModels().catch(() => null);
    t.disabled = false; t.textContent = 'Load models';
    const sel = $('#oaModel');
    if (!r || !r.ok || !sel) { toast((r && r.error) || 'could not list models', 'bad'); return; }
    const cur = sel.value;
    sel.innerHTML = r.models.map((m) => `<option value="${escAttr(m)}" ${m === cur ? 'selected' : ''}>${esc(m)}</option>`).join('');
    toast(r.models.length + ' models visible to this key', 'good');
    return;
  }
  if (t.id === 'pwSave') {
    const v = (($('#pwNew') || {}).value || '');
    if (v.length < 12) { toast('Use at least 12 characters', 'warn'); return; }
    const r = await C.saveSettings({ newPassword: v }).catch(() => null);
    if ($('#pwNew')) $('#pwNew').value = '';
    toast(r && r.ok ? 'Password set. It applies at the next unlock.' : 'could not set the password', r && r.ok ? 'good' : 'bad');
  }
});
document.addEventListener('change', async (e) => {
  const t = e.target;
  if (!t || !t.id) return;
  if (t.id === 'oaModel') { await C.openaiSave({ model: t.value }); toast('Seat model: ' + t.value, 'good'); }
  else if (t.id === 'oaImageModel') { await C.openaiSave({ imageModel: t.value }); toast('Image model: ' + t.value, 'good'); }
  else if (t.id === 'oaImages') { await C.openaiSave({ imagesPerDay: t.value }); toast('Images per day: ' + t.value, 'good'); }
});

/* ── THE STUDIO — images the fleet made, and a box to make one ───────────
   Painted into #studioBand on the Output view. Thumbnails load from the user
   data folder (the CSP allows local file images for this). Without a key the
   band says so and points at Integrations; it never pretends.               */
async function renderStudio() {
  const host = $('#studioBand');
  if (!host || !C.studio) return;
  const r = await C.studio().catch(() => null);
  if (!r) return;
  const imgs = (r.images || []).filter((x) => x.exists);
  const on = !!(r.openai && r.openai.keySet);
  const fileUrl = (p) => 'file:///' + String(p).replace(/\\/g, '/').replace(/^\/+/, '');
  setHTML(host, `<div class="panel glass studio">
    <div class="panel-head"><h3>Studio</h3><span class="panel-sub">${on ? imgs.length + ' image(s) · ' + r.openai.imagesToday + ' of ' + r.openai.imagesPerDay + ' today · any agent can ask with ci.sh image' : 'add an OpenAI key on Settings → Integrations and every agent can make images here'}</span></div>
    ${on ? `<div class="studio-row"><input id="stPrompt" placeholder="what should the studio make? (also: /image … on Command)" spellcheck="true" />
      <select id="stSize" class="sel"><option value="1024x1024">square</option><option value="1536x1024">wide</option><option value="1024x1536">tall</option></select>
      <button class="prime-btn" id="stGo">✦ Generate</button></div>` : ''}
    ${imgs.length ? `<div class="studio-grid">${imgs.slice(0, 24).map((x) => `<div class="studio-img">
      <img src="${escAttr(fileUrl(x.file))}" alt="${escAttr(x.prompt)}" loading="lazy" />
      <div class="studio-cap">${esc(x.prompt)}<span class="mono">${esc(aname(x.by))} · ${esc(x.model)} · ${esc(x.size)} · ${ago(x.ts)} ago</span>
        <button class="mini" data-stopen="${escAttr(x.file)}">open</button> <button class="mini" data-stdel="${x.id}">✕</button></div>
    </div>`).join('')}</div>` : (on ? '<div class="empty">Nothing made yet. The first image lands here.</div>' : '')}
  </div>`);
  const go = $('#stGo');
  if (go) go.onclick = async () => {
    const prompt = ($('#stPrompt').value || '').trim();
    if (!prompt) { toast('Give the studio a prompt', 'warn'); return; }
    go.disabled = true; go.textContent = '… making';
    const res = await C.imageGen({ prompt, size: $('#stSize').value }).catch(() => null);
    go.disabled = false; go.textContent = '✦ Generate';
    if (res && res.ok) { $('#stPrompt').value = ''; toast('Image ready', 'good'); renderStudio(); }
    else toast((res && res.error) || 'the studio could not make it', 'bad');
  };
  $$('#studioBand [data-stopen]').forEach((b) => b.onclick = () => C.openPath(b.dataset.stopen, false));
  $$('#studioBand [data-stdel]').forEach((b) => b.onclick = async () => { if (!confirm('Delete this image?')) return; await C.studioDelete(b.dataset.stdel); renderStudio(); });
}

async function loadSettings() {
  const st = await C.settings(); SETTINGS = st.settings;
  // the running version, from the one channel that carries it (local read, no network)
  const ver = await (C.updateCheck ? C.updateCheck().then((u) => (u && u.current) || '').catch(() => '') : Promise.resolve(''));
  const oa = await (C.openai ? C.openai().catch(() => null) : Promise.resolve(null));
  $('#settingsPanel').innerHTML = `
    <div class="about glass-deep">
      <div class="about-sigil" aria-hidden="true">◈</div>
      <div class="about-lines">
        <div class="about-presented">Presented By Outlier.Systems</div>
        <div class="about-date">9/7/2026</div>
        <div class="about-desc">Strategic Systems Intelligence Agency. Emergent Systems Design, Evolution, and Systems Gardening. Motus Inspired. Motus Designed.</div>
        <div class="about-tag">Solutions For The Data Backed World</div>
        <div class="about-service">This Is A Service From Motivus.One</div>
        <div class="about-meta">CortexInsight${ver ? ' v' + esc(ver) : ''} · <a href="https://www.outlier.systems" target="_blank" rel="noopener">outlier.systems</a> · August@Outlier.Systems</div>
        <div class="about-meta"><a href="https://github.com/InitiumBuilders/Semble-CC" target="_blank" rel="noopener">source on GitHub</a> · <a href="https://semble.cc/live" target="_blank" rel="noopener">semble.cc/live</a> · open source, sealed by default</div>
        <div class="about-meta"><a href="https://github.com/InitiumBuilders/Semble-CC/blob/main/docs/GUIDE.md" target="_blank" rel="noopener">the guide</a> · <a href="https://github.com/InitiumBuilders/Semble-CC/blob/main/docs/FEATURES.md" target="_blank" rel="noopener">every feature</a> · <a href="https://github.com/InitiumBuilders/Semble-CC/blob/main/docs/ARCHITECTURE.md" target="_blank" rel="noopener">architecture</a> · <a href="https://github.com/InitiumBuilders/Semble-CC/blob/main/CONTRIBUTING.md" target="_blank" rel="noopener">contribute</a> · type <code>/help</code> on Command</div>
      </div>
    </div>
    ${integrationsPanel(oa)}
    <div class="panel-head"><h3>Preferences</h3></div>
    ${setText('cortexRoot', 'Fleet path', 'Where CortexInsight reads state (read-only). The UNC path to the fleet tree in WSL; discovered on first run, editable here.', SETTINGS.cortexRoot)}
    ${setText('beaconUrl', 'Foreign-device beacon URL', 'Optional. If a copy ever opens on another machine, an alert POSTs here (e.g. a here.now webhook). Leave empty to rely on local notification only.', SETTINGS.beaconUrl)}
    ${setSelectAgent(SETTINGS.defaultAgent)}
    ${setToggle('reduceMotion', 'Reduce motion', 'Calms the neural field and animations (lighter on the GPU).', SETTINGS.reduceMotion)}
    ${setNum('pollMs', 'Refresh cadence (ms)', 'How often live panels poll the logs.', SETTINGS.pollMs)}

    <div class="panel-head" style="margin-top:22px"><h3>Sentinel</h3><span class="panel-sub">always-on guardian</span></div>
    ${setToggle('minimizeToTray', 'Minimize to tray', 'Closing the window keeps CortexInsight watching from the tray (icon colour = Cortex health).', SETTINGS.minimizeToTray)}
    ${setNum('watchdogMs', 'Watchdog cadence (ms)', 'How often the guardian checks relay, faults, hangs, and integrity in the background.', SETTINGS.watchdogMs)}
    ${setToggle('alertRelay', 'Alert · relay offline', 'Notify if the mouth-proxy stops responding.', SETTINGS.alertRelay)}
    ${setToggle('alertFaults', 'Alert · faults', 'Notify on a new fault or timeout.', SETTINGS.alertFaults)}
    ${setToggle('alertHang', 'Alert · possible hang', 'Notify if a turn is stuck inflight too long.', SETTINGS.alertHang)}
    ${setToggle('alertIntegrity', 'Alert · file tampering', 'Notify if a critical Cortex file changes vs. baseline.', SETTINGS.alertIntegrity)}
    ${setToggle('alertComplete', 'Alert · every completion', 'Notify when any turn finishes (noisy — off by default).', SETTINGS.alertComplete)}
    ${setNum('hangMinutes', 'Hang threshold (min)', 'Inflight longer than this counts as a possible hang.', SETTINGS.hangMinutes)}

    <div class="panel-head" style="margin-top:22px"><h3>Evolution</h3><span class="panel-sub">self-improvement loop</span></div>
    ${setNum('autoReflectHours', 'Auto-reflect every (hours)', '0 = off. Sympath-Cortex periodically studies telemetry and compounds learnings + proposals on her own.', SETTINGS.autoReflectHours)}

    <div class="panel-head" style="margin-top:22px"><h3>Autonomy</h3><span class="panel-sub">the self-evolving layer</span></div>
    ${setToggle('davaraNextMovesDaily', 'Davara · daily next moves', 'Once a day (and when you go quiet mid-work) Davara surfaces the highest-leverage next moves and DMs them to you.', SETTINGS.davaraNextMovesDaily)}
    ${setToggle('autoApprove', 'Davaris · auto-endorse', 'Davaris auto-endorses ONLY the high-conviction reflections & next-steps — the no-brainers. A non-destructive flag; he never applies a runner change unasked.', SETTINGS.autoApprove)}
    ${setToggle('telegramNudges', 'Telegram nudges', 'Key/critical moments (endorsements, next moves, break + cleanup nudges, relay offline) also ping you on Telegram.', SETTINGS.telegramNudges)}
    ${setNum('breakNudgeHours', 'Break nudge after (hours)', '0 = off. After this many hours of an active day, the Cortex nudges you to pause or wrap up.', SETTINGS.breakNudgeHours)}

    <div class="panel-head" style="margin-top:22px"><h3>Data &amp; Maintenance</h3><span class="panel-sub">keep the app fast over months</span></div>
    <div id="vaultStatsRow" class="set-row"><div><div class="sl">Vault size</div><div class="sd" id="vaultStatsDesc">measuring…</div></div><span id="vaultGauge" class="masked-tag">—</span></div>
    ${setNum('cleanupThreshold', 'Cleanup nudge at (items)', 'When the stored vault grows past this many items, the Cortex recommends a compaction.', SETTINGS.cleanupThreshold)}
    <div class="set-row"><div><div class="sl">Compact now</div><div class="sd">Trim every log &amp; ledger to a healthy cap. Same as /compact — keeps your data, drops the overflow.</div></div><button class="ghost-btn" id="compactNowBtn">◇ Compact vault</button></div>
    <div class="set-row"><div><div class="sl">Clear all logs &amp; data</div><div class="sd" style="color:var(--bad)">Wipes this app's private vault — learnings, next-steps, notifications, security &amp; Arden logs. Keeps your settings &amp; goal. Never touches the Cortex's own logs. Not reversible.</div></div><button class="ghost-btn" id="fullResetBtn" style="border-color:rgba(255,90,90,.4)">🧹 Clear everything</button></div>

    <div class="panel-head" style="margin-top:22px"><h3>Alert email</h3><span class="panel-sub">private channel</span></div>
    ${setText('canaryEmailTo', 'Send alerts to', 'Where the IP-reveal alert is emailed.', SETTINGS.canaryEmailTo)}
    ${setText('smtpUser', 'From (Gmail)', 'The Gmail account that sends the alert.', SETTINGS.smtpUser)}
    ${setPassword('smtpAppPassword', 'Gmail App Password', 'NOT your login password. Generate at myaccount.google.com → Security → App passwords. Stored encrypted (Windows DPAPI) on this machine only, never shown again.', SETTINGS.smtpAppPasswordSet)}
    <div class="set-row"><div><div class="sl">Test the pipeline</div><div class="sd">Send a sample alert now to confirm it reaches your inbox.</div></div><button class="ghost-btn" id="testEmailBtn">Send test email</button></div>

    <div style="margin-top:16px;font-size:10.5px;color:var(--faint)">Vault: ${esc(st.userData)}</div>`;
  $$('#settingsPanel [data-set]').forEach((inp) => inp.onchange = async () => {
    let v = inp.value;
    if (inp.dataset.pw) {                       // app password — blank means keep existing
      if (!v.trim()) return;
      await C.saveSettings({ [inp.dataset.set]: v }); SETTINGS = (await C.settings()).settings;
      inp.value = ''; toast('App password saved (encrypted)', 'good'); loadSettings(); return;
    }
    if (inp.dataset.num) {
      v = parseInt(v) || 0; const k = inp.dataset.set;
      if (k === 'pollMs') v = Math.max(1500, v || 4000);
      else if (k === 'watchdogMs') v = Math.max(15000, v || 45000);
      else if (k === 'hangMinutes') v = Math.max(2, v || 30);
      else if (k === 'autoReflectHours') v = Math.max(0, Math.min(168, v));
      else if (k === 'breakNudgeHours') v = Math.max(0, Math.min(24, v));
      else if (k === 'cleanupThreshold') v = Math.max(100, Math.min(20000, v || 800));
      inp.value = v;
    }
    const patch = {}; patch[inp.dataset.set] = v;
    await C.saveSettings(patch); SETTINGS = (await C.settings()).settings; toast('Saved', 'good');
  });
  $$('#settingsPanel .toggle').forEach((t) => t.onclick = async () => {
    const key = t.dataset.toggle; const next = !t.classList.contains('on'); t.classList.toggle('on', next);
    await C.saveSettings({ [key]: next });
    if (key === 'reduceMotion') document.body.classList.toggle('reduce-motion', next);
    toast('Saved', 'good');
  });
  $$('#settingsPanel [data-agent]').forEach((b) => b.onclick = async () => {
    $$('#settingsPanel [data-agent]').forEach((x) => x.classList.remove('on')); b.classList.add('on');
    await C.saveSettings({ defaultAgent: b.dataset.agent }); CUR.chatAgent = b.dataset.agent; toast('Saved', 'good');
  });
  const teb = $('#testEmailBtn');
  if (teb) teb.onclick = async () => {
    teb.disabled = true; teb.textContent = 'Sending…';
    const r = await C.testCanaryEmail().catch(() => null);
    teb.disabled = false; teb.textContent = 'Send test email';
    toast(r && r.ok ? `Test sent ✓ · ref ${r.token}` : 'Failed: ' + ((r && r.error) || 'set the app password first'), r && r.ok ? 'good' : 'bad');
  };
  // --- Data & Maintenance ---
  refreshVaultStats();
  const cnb = $('#compactNowBtn');
  if (cnb) cnb.onclick = async () => {
    cnb.disabled = true; cnb.textContent = 'Compacting…';
    const r = await C.ritual('compact').catch(() => null);
    cnb.disabled = false; cnb.textContent = '◇ Compact vault';
    toast(r && r.ok ? 'Vault compacted ◇' : 'Could not compact', r && r.ok ? 'good' : 'bad');
    refreshVaultStats();
  };
  const frb = $('#fullResetBtn');
  if (frb) frb.onclick = async () => {
    if (!confirm('Clear ALL of CortexInsight\'s private data?\n\n• Learnings, next-steps, proposals\n• Notifications, command + security logs, Arden\'s reflections\n\nYour settings and goal are kept. The Cortex\'s own logs are NEVER touched. This is not reversible.\n\nProceed?')) return;
    frb.disabled = true; frb.textContent = 'Clearing…';
    const r = await C.clear('full-reset').catch(() => null);
    frb.disabled = false; frb.textContent = '🧹 Clear everything';
    toast(r && r.ok ? 'Vault cleared — fresh start ✓' : 'Could not clear', r && r.ok ? 'good' : 'bad');
    refreshVaultStats();
  };
  loadHeal();
}
async function refreshVaultStats() {
  const v = await C.vaultStats().catch(() => null);
  const desc = $('#vaultStatsDesc'), gauge = $('#vaultGauge');
  if (!v || v.error || !desc) return;
  const kb = Math.round((v.bytes || 0) / 1024);
  desc.textContent = `${v.items} stored items · ${kb} KB on disk · nudge at ${v.threshold}`;
  if (gauge) {
    gauge.textContent = v.recommend ? 'compact recommended' : 'healthy';
    gauge.style.color = v.recommend ? 'var(--bad)' : 'var(--good)';
    gauge.style.borderColor = v.recommend ? 'rgba(255,90,90,.4)' : 'rgba(84,230,168,.4)';
  }
}
function setText(key, label, desc, val) {
  return `<div class="set-row"><div><div class="sl">${label}</div><div class="sd">${desc}</div></div>
    <input type="text" data-set="${key}" value="${esc(val || '')}"/></div>`;
}
function setToggle(key, label, desc, on) {
  return `<div class="set-row"><div><div class="sl">${label}</div><div class="sd">${desc}</div></div>
    <div class="toggle ${on ? 'on' : ''}" data-toggle="${key}"></div></div>`;
}
function setNum(key, label, desc, val) {
  return `<div class="set-row"><div><div class="sl">${label}</div><div class="sd">${desc}</div></div>
    <input type="text" data-set="${key}" data-num="1" value="${esc(String(val))}" style="width:110px;text-align:center"/></div>`;
}
function setPassword(key, label, desc, isSet) {
  return `<div class="set-row"><div><div class="sl">${label}${isSet ? ' <span class="masked-tag" style="color:var(--good);border-color:rgba(84,230,168,.4)">set</span>' : ''}</div><div class="sd">${desc}</div></div>
    <input type="password" data-set="${key}" data-pw="1" placeholder="${isSet ? '•••••• — leave blank to keep' : 'paste app password'}" value="" autocomplete="off"/></div>`;
}
// Derived from the live fleet (2026-09-02). This was a hardcoded ['davara','davaris','august'],
// so Davari could be talked to but never made the default — the same class of bug as the missing
// ROUTE_TOKEN: an agent existing in one view and not another. Relay lane only; external agents
// run on their own gateway and are not drivable from Command.
function setSelectAgent(cur) {
  return `<div class="set-row"><div><div class="sl">Default agent</div><div class="sd">Who the Command view talks to first.</div></div>
    <div style="display:flex;gap:6px;flex-wrap:wrap">${(relayFleet().length ? relayFleet().map((f) => f.id) : ['davara', 'davaris', 'august']).map((a) => `<button class="chip ${cur === a ? 'on' : ''}" data-agent="${a}">${aname(a)}</button>`).join('')}</div></div>`;
}
async function loadHeal() {
  const [h, dg] = await Promise.all([C.health(), C.diagnosis()]);
  if (!h || h.error) return;
  const v = h.verdict;
  let html = `<div style="display:flex;gap:14px;align-items:center;margin-bottom:14px">
    <div style="font-family:'Sora';font-weight:700;font-size:30px" class="${v.level === 'nominal' ? 'tone-cyan' : v.level === 'degraded' ? '' : ''}" >${v.score}</div>
    <div><div style="font-family:'Sora';font-weight:600">Health: ${v.level}</div>
    <div class="muted" style="font-size:12px">${v.faults} fault(s) in last 25 turns · relay ${h.relay.reachable ? 'reachable' : 'offline'}${v.stale ? ' · activity stale' : ''}</div></div></div>`;
  html += `<div class="heal-actions">
    <button class="heal-btn" data-heal="health">⟳ Run cortex-health.sh</button>
    <button class="heal-btn warn" data-heal="restart-relay">↻ Restart relay</button>
    <button class="heal-btn warn" data-heal="clear-checkpoint" data-agent="davara">⊘ Clear Davara checkpoint</button>
    <button class="heal-btn warn" data-heal="clear-checkpoint" data-agent="davaris">⊘ Clear Davaris checkpoint</button>
  </div>
  <div class="heal-legend">
    <div class="hl-row"><b>⟳ Run cortex-health.sh</b><span>Read-only. Runs your own health script in WSL and prints what it finds. Safe any time — it changes nothing.</span></div>
    <div class="hl-row"><b>↻ Restart relay</b><span>Restarts <code>cortex-mouth-proxy.service</code> — the loopback every agent talks through. Use when turns hang or the relay reads offline. <b>In-flight turns are interrupted</b>; it is back within a couple of seconds.</span></div>
    <div class="hl-row"><b>⊘ Clear a checkpoint</b><span>Each agent keeps <code>checkpoint.state</code> — a note saying "session SID is still <b>inflight</b>", so the next turn RESUMES that conversation instead of starting fresh. If a session dies badly (crash, killed process, a turn that never returned) the note is never cleared, and every later turn tries to resume a session that is gone — the agent looks stuck, slow, or amnesiac. This rewrites <code>STATUS=inflight</code> to <code>STATUS=complete</code> and keeps a <code>.bak</code> beside it. <b>Use when:</b> an agent shows "paused — will resume" for a long time with no activity, or its replies stop making sense in context. <b>Cost:</b> the agent loses that one conversation thread and starts clean. Memory, learnings and the board are untouched.</span></div>
  </div>
  <pre class="heal-output" id="healOutput"></pre>`;
  const heal = v.heal && v.heal.length ? v.heal : [];
  if (!heal.length) html += `<div class="heal-item ok"><span class="hi">✓</span> Nothing to heal — the Cortex is running clean. Loopback relay up, no fault clusters, logs fresh.</div>`;
  else html += heal.map((x) => `<div class="heal-item"><span class="hi">⚠</span> ${esc(x)}</div>`).join('');
  // --- diagnosis: WHY is the badge what it is, in plain language ---
  if (dg && !dg.error) {
    html += `<div class="panel-head" style="margin-top:18px"><h3>Diagnosis</h3><span class="panel-sub">why the badge says ${esc(dg.verdict.level)}</span></div>`;
    html += (dg.why || []).map((w) => `<div class="heal-item ${dg.verdict.level === 'nominal' ? 'ok' : ''}"><span class="hi">${dg.verdict.level === 'nominal' ? '✓' : '◆'}</span> ${esc(w)}</div>`).join('');
    if ((dg.faults || []).length) html += dg.faults.map((f) => `
      <div class="inject-row"><div class="ip">✗ ${esc(f.ts)} · ${esc(cap(f.agent))} · ${esc(f.status)} · ${f.latency}s</div>
        <div class="ix">"${esc(f.msg)}"</div><div class="ix" style="color:var(--ink);margin-top:5px">${esc(f.explain)}</div></div>`).join('');
    html += `<div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:10px">` + (dg.memory || []).map((m) =>
      `<div class="ametric" style="flex:1;min-width:160px"><div class="mv">${m.totalKB} KB</div><div class="ml">${esc(m.agent)} memory · ${m.files} day(s) · today ${m.todayKB} KB</div></div>`).join('') + `</div>`;
    for (const [a, lines] of Object.entries(dg.stderr || {}))
      html += `<div class="panel-head" style="margin-top:14px"><h3 style="font-size:12px">runner-stderr · ${esc(a)}</h3></div><div class="proxy-tail">${lines.map((l) => `<div>${esc(l)}</div>`).join('')}</div>`;
    html += `<div style="margin-top:12px">` + (dg.tips || []).map((t) => `<div class="ritual-line">◦ ${esc(t)}</div>`).join('') + `</div>`;
  }
  html += `<div class="panel-head" style="margin-top:18px"><h3>Relay tail</h3><span class="panel-sub">logs/mouth-proxy.log</span></div>
    <div class="proxy-tail">${(h.proxyTail || []).map((l) => {
      const c = /\bOK\b/.test(l) ? 'lok' : /FAULT|TIMEOUT/.test(l) ? 'lbad' : /RETRY/.test(l) ? 'lwarn' : '';
      return `<div class="${c}">${esc(l)}</div>`;
    }).join('') || '<div class="muted">no recent lines</div>'}</div>`;
  $('#healBody').innerHTML = html;
  $$('#healBody [data-heal]').forEach((b) => b.onclick = async () => {
    const action = b.dataset.heal, agent = b.dataset.agent;
    if (action === 'restart-relay' && !confirm('Restart the mouth-proxy relay now?\n\nAny turn currently in flight will be interrupted — checkpoint-resume recovers it on the next message. Proceed?')) return;
    if (action === 'clear-checkpoint' && !confirm(`Mark ${cap(agent)}'s checkpoint complete?\n\nUse only if a session is genuinely stuck. A .bak backup is kept; the next turn starts fresh instead of resuming. Proceed?`)) return;
    const out = $('#healOutput'); out.classList.add('show'); out.textContent = `Running ${action}${agent ? ' (' + agent + ')' : ''}…`;
    $$('#healBody [data-heal]').forEach((x) => x.disabled = true);
    const r = await C.heal(action, agent);
    $$('#healBody [data-heal]').forEach((x) => x.disabled = false);
    out.textContent = (r.ok ? '✓ ' : '⚠ ') + (r.output || r.error || 'done');
    toast(r.ok ? 'Heal action complete' : 'Action reported an issue', r.ok ? 'good' : 'bad');
  });
}

/* ============================ LIVE PULSE → field + orb ============================ */
let PULSE = { intensity: 0.3, faulting: false, agents: {} };
C.onPulse((p) => {
  PULSE = p;
  if (CUR.view === 'overview') renderConstellation(p);
  const orb = $('#cortexOrb'); if (orb) orb.classList.toggle('bad', !!p.faulting);
});
C.onSendProgress(() => {});

/* ============================ LIVE STREAMING ============================ */
const LIVE = { active: false, agent: 'davara', events: [], sid: '', rendered: 0 };
async function loadLive() {
  const [st, wk] = await Promise.all([C.liveStatus(), C.working()]);
  if (!st || st.error) return;
  // per-agent live cards — both agents at a glance, even before picking a stream
  const working = (wk && wk.working) || [];
  // EVERY agent gets a live card — both lanes. Awake agents sort to the front so
  // the ones actually moving are never buried under dormant seats.
  const liveOrder = (st.agents || []).slice().sort((a, b) =>
    (b.inflight ? 2 : b.hasTranscript ? 1 : 0) - (a.inflight ? 2 : a.hasTranscript ? 1 : 0));
  setHTML($('#liveNow'), liveOrder.map((info) => {
    const a = info.agent;
    const w = working.find((x) => x.agent === a);
    const ext = info.lane && info.lane !== 'relay';
    const sub = info.subagentsRunning ? `<span class="now-sub">◦ ${info.subagentsRunning} subagent${info.subagentsRunning > 1 ? 's' : ''} running</span>` : '';
    if (!w) return `<div class="now-card glass-deep tone-${TONE[a] || 'slate'} dim"><div class="now-head"><span class="now-orb"></span><span class="now-agent">${aname(a)}</span><span class="now-state">${ext ? 'gateway idle' : info.status === 'paused' ? 'paused by you' : 'no session on record'}</span></div></div>`;
    const dl = (w.deliveries || []);
    return `<div class="now-card glass-deep tone-${TONE[a] || 'slate'} ${w.inflight ? '' : 'dim'}" data-agent="${a}">
      <div class="now-head">
        <span class="now-orb ${w.inflight ? 'live' : ''}"></span>
        <span class="now-agent">${aname(a)}</span>
        <span class="now-state">${w.inflight ? (ext ? 'active on gateway' : 'working now') : w.status === 'incomplete' ? 'paused — will resume' : 'idle · last session'}</span>
        ${ext ? `<span class="now-lane">openrouter</span>` : ''}
        ${w.inflight && w.startEpoch > 0 ? `<span class="now-elapsed mono" data-elapsed="${w.startEpoch}">${fmtDur(Date.now() - w.startEpoch)}</span>` : `<span class="now-elapsed mono muted">${ago(w.lastActivity)} ago</span>`}
      </div>
      <div class="now-ask expandable" data-exp-key="ask:${a}"><span class="now-lbl">${w.inflight ? 'Working on' : 'Last worked on'}</span>${esc(w.inbound || '—')}</div>
      ${dl.length ? `<div class="dlv">
        <div class="dlv-h">◈ LAST ${dl.length} DELIVERED</div>
        ${dl.map((d) => `<div class="dlv-row v-${esc(d.verdict)}">
          <span class="dlv-tick">${d.verdict === 'shipped' ? '✓' : d.verdict === 'task' ? '◆' : '·'}</span>
          <span class="dlv-t">${esc(d.title)}</span>
          <span class="dlv-m mono">${d.files ? d.files + ' file(s) · ' : ''}${esc(fmtDT(d.ts))}</span>
        </div>`).join('')}
      </div>` : ''}
      <div class="now-foot"><span class="now-meta">${w.toolCount} tool calls${(w.filesTouched || []).length ? ` · files: ${esc(w.filesTouched.slice(0, 3).map((f) => f.split('/').pop()).join(', '))}${w.filesTouched.length > 3 ? ` +${w.filesTouched.length - 3}` : ''}` : ''}</span>${sub}</div>
    </div>`;
  }).join('') || `<div class="empty">No agents reporting yet.</div>`);
  if (setHTML($('#liveTabs'), (st.agents || []).map((info) => {
    const a = info.agent;
    const tag = info.inflight ? '<span class="live-dot"></span> live' : info.hasTranscript ? '· last session' : '· no session';
    return `<button class="chip ${LIVE.agent === a ? 'on' : ''}" data-la="${a}">${aname(a)} ${tag}</button>`;
  }).join(''))) {
    $$('#liveTabs [data-la]').forEach((b) => b.onclick = () => { LIVE.agent = b.dataset.la; startLive(); });
  }
  restoreExpanded($('#liveNow'));
  if (!LIVE.active || LIVE.watchedAgent !== LIVE.agent) startLive();
}
async function startLive() {
  LIVE.active = true; LIVE.watchedAgent = LIVE.agent; LIVE.events = []; LIVE.rendered = 0;
  $$('#liveTabs [data-la]').forEach((b) => b.classList.toggle('on', b.dataset.la === LIVE.agent));
  const feed = $('#liveFeed'); feed.innerHTML = `<div class="empty">Connecting to ${cap(LIVE.agent)}'s session…</div>`; _domHash.delete(feed);
  // one delegated listener opens any file she touches, straight from the feed —
  // attached to the container (which persists), never per-row
  feed.onclick = async (e) => {
    const b = e.target.closest('[data-open]');
    if (!b) return;
    const r = await C.openPath(b.dataset.open, false).catch(() => null);
    if (!r || r.ok === false) toast((r && r.error) || 'could not open it', 'bad');
  };
  $('#liveMeta').innerHTML = '';
  const r = await C.liveWatch(LIVE.agent);
  if (!r || !r.ok) { feed.innerHTML = `<div class="empty">${esc((r && r.error) || 'Could not open transcript.')}</div>`; _domHash.delete(feed); return; }
  LIVE.sid = r.sid;
  $('#liveMeta').innerHTML = `<span class="live-stat ${r.inflight ? 'on' : ''}">${r.inflight ? '● LIVE — working now' : '○ idle — last session'}</span>
    <span class="muted">session ${esc((r.sid || '').slice(0, 8))} · ${esc(r.status)} · tailed read-only</span>`;
  LIVE.events = r.snapshot || [];
  renderLive(true);
}
// append-only: new events are inserted, existing DOM (and your selection) is untouched
function renderLive(reset) {
  const feed = $('#liveFeed'); if (!feed) return;
  // the feed manages its own DOM (append-only) — keep it out of the hash cache
  _domHash.delete(feed);
  if (!LIVE.events.length) { feed.innerHTML = `<div class="empty">No activity in this session yet. When ${cap(LIVE.agent)} works, it streams here.</div>`; LIVE.rendered = 0; return; }
  const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 120;
  if (reset || LIVE.rendered === 0) { feed.innerHTML = LIVE.events.slice(-400).map(liveEventHtml).join(''); LIVE.rendered = LIVE.events.length; }
  else if (LIVE.events.length > LIVE.rendered) {
    feed.insertAdjacentHTML('beforeend', LIVE.events.slice(LIVE.rendered).map(liveEventHtml).join(''));
    LIVE.rendered = LIVE.events.length;
  }
  // bound the DOM (and memory) on long watches — keep the most recent 400 rows
  while (feed.childElementCount > 400) feed.removeChild(feed.firstChild);
  if (LIVE.events.length > 1200) { LIVE.events = LIVE.events.slice(-600); LIVE.rendered = LIVE.events.length; }
  if (reset || nearBottom) feed.scrollTop = feed.scrollHeight;
}
// Every tool speaks in its own mark and its own light — the same language the
// Motus Max ticker uses, so watching any agent anywhere reads identically.
const LIVE_TOOL = {
  Edit: ['✎', 'edit'], NotebookEdit: ['✎', 'edit'], Write: ['✚', 'write'],
  Bash: ['▸', 'bash'], Read: ['⌕', 'read'], Grep: ['⌕', 'read'], Glob: ['⌕', 'read'],
  WebFetch: ['⇄', 'web'], WebSearch: ['⇄', 'web'], Task: ['◈', 'sub'], Agent: ['◈', 'sub'],
  Skill: ['◆', 'skill'], TodoWrite: ['☰', 'skill'],
};
function liveClock(ts) {
  const d = new Date(ts);
  return isNaN(d) ? String(ts || '').slice(11, 16)
    : d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });
}
const _levPathish = (s) => /^[A-Za-z]:[\\/]|^[\\/~]/.test(String(s || '').trim());
function liveEventHtml(ev) {
  const t = liveClock(ev.ts);
  if (ev.kind === 'text') return `<div class="lev lev-text"><span class="lev-t">${t}</span><div class="lev-body">${esc(ev.text)}</div></div>`;
  if (ev.kind === 'thinking') return `<div class="lev lev-think"><span class="lev-t">${t}</span><div class="lev-body"><i>◌ ${esc(ev.text.slice(0, 500))}</i></div></div>`;
  if (ev.kind === 'tool') {
    const [mark, tone] = LIVE_TOOL[ev.name] || ['·', 'skill'];
    // a file she touched is a door, not a string — open it from the stream
    const arg = ev.summary || '';
    const argHtml = _levPathish(arg)
      ? `<button class="lev-open" data-open="${escAttr(arg)}" title="open this file">${esc(arg)}</button>`
      : `<span class="tool-arg">${esc(arg)}</span>`;
    return `<div class="lev lev-tool tl-${tone} ${ev.sub ? 'sub' : ''}"><span class="lev-t">${t}</span><div class="lev-body"><span class="tl-mark">${mark}</span><span class="tool-name">${ev.sub ? 'subagent · ' : ''}${esc(ev.name)}</span> ${argHtml}</div></div>`;
  }
  if (ev.kind === 'result') return `<div class="lev lev-res"><span class="lev-t">${t}</span><div class="lev-body ${ev.success === false ? 'bad' : ''}">${ev.success === false ? '✗' : '✓'} ${esc((ev.text || '').slice(0, 200))}</div></div>`;
  return '';
}
C.onLiveEvent((d) => {
  if (!LIVE.active || d.agent !== LIVE.agent) return;
  if (d.events && d.events.length) LIVE.events.push(...d.events);
  const stat = $('#liveMeta .live-stat');
  if (stat) { stat.className = 'live-stat ' + (d.inflight ? 'on' : ''); stat.textContent = d.inflight ? '● LIVE — working now' : '○ idle — last session'; }
  renderLive(false);
});

/* ============================ NOTIFICATIONS ============================ */
const NOTIF = { unread: 0, open: false };
async function loadNotifications() {
  const r = await C.notifications(); if (!r || r.error) return;
  NOTIF.unread = r.unread || 0; updateBell();
  $('#notifList').innerHTML = r.items.length ? r.items.map((n) => `
    <div class="notif-item ${n.read ? '' : 'unread'} lvl-${n.level}" ${n.view ? `data-go="${esc(n.view)}"` : ''}>
      <div class="notif-dot"></div>
      <div style="min-width:0"><div class="notif-title">${esc(n.title)}</div><div class="notif-body">${esc(n.body)}</div>
        <div class="notif-ts">${esc(fmtTs(n.ts))}</div></div>
    </div>`).join('') : `<div class="empty">No notifications. The watchdog is quiet — that's good.</div>`;
  $$('#notifList [data-go]').forEach((el) => el.onclick = () => { switchView(el.dataset.go); toggleNotif(false); });
}
function updateBell() {
  const badge = $('#bellBadge'); if (!badge) return;
  badge.textContent = NOTIF.unread > 9 ? '9+' : NOTIF.unread;
  badge.style.display = NOTIF.unread ? 'grid' : 'none';
  $('#bellBtn').classList.toggle('has', NOTIF.unread > 0);
}
function toggleNotif(force) {
  NOTIF.open = force !== undefined ? force : !NOTIF.open;
  $('#notifPanel').classList.toggle('open', NOTIF.open);
  if (NOTIF.open) loadNotifications();
}
$('#bellBtn').onclick = (e) => { e.stopPropagation(); toggleNotif(); };
$('#notifClear').onclick = async () => { await C.markNotificationsRead(); NOTIF.unread = 0; updateBell(); loadNotifications(); };
$('#notifClearAll').onclick = async () => { const r = await C.clear('notifications'); if (r && r.ok) { NOTIF.unread = 0; updateBell(); loadNotifications(); toast('Notifications cleared', 'good'); } };
document.addEventListener('click', (e) => { if (NOTIF.open && !$('#notifPanel').contains(e.target) && e.target.closest('#bellBtn') === null) toggleNotif(false); });
C.onNotify((n) => {
  NOTIF.unread++; updateBell();
  const bell = $('#bellBtn'); bell.classList.add('ring'); setTimeout(() => bell.classList.remove('ring'), 1000);
  if (NOTIF.open) loadNotifications();
  if (n.view) setBadge(n.view, true);
});
C.onNavigate((view) => { showWindowView(view); });
function showWindowView(view) { switchView(view); }

/* ============================ OUTPUT / DELIVERABLES ============================ */
// Completed work answers three questions at a glance: WHEN exactly (full date
// + time, not a truncated stamp), WHERE (the path, openable), and FOR WHAT
// (the project it served, with its live URL one click away).
// One clock for the whole app: his local time (CST on this machine), 12-hour,
// never military. "Aug 18 · 4:44 PM" — the year appears only when it differs.
function fmtDT(ts) {
  const d = new Date(ts); if (isNaN(d)) return String(ts || '');
  const day = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    + (d.getFullYear() !== new Date().getFullYear() ? ' ' + d.getFullYear() : '');
  const t = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });
  return `${day} · ${t}`;
}
function dayOf(ts) { const d = new Date(ts); return isNaN(d) ? String(ts || '').slice(0, 10) : d.toDateString(); }
function dayLabel(ts) {
  const d = new Date(ts); if (isNaN(d)) return String(ts || '');
  const t = new Date(), y = new Date(Date.now() - 864e5);
  if (d.toDateString() === t.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}
function projChip(x) {
  if (!x || !x.project) return '';
  return x.projectUrl
    ? `<a class="proj-chip" href="${escAttr(x.projectUrl)}" target="_blank" rel="noopener" title="${escAttr(x.projectUrl)}">◈ ${esc(x.project)} ↗</a>`
    : `<span class="proj-chip still">◈ ${esc(x.project)}</span>`;
}
async function loadOutput() {
  const r = await C.outputs(); if (!r || r.error) return viewFail('output', r || null);
  renderStudio().catch(() => {});      // the studio paints alongside, never blocks the list
  // Newest first, and a day heading whenever the date changes — "what moved
  // yesterday" becomes a glance instead of a read. capList's renderItem gets
  // the index from Array.map, so the grouping survives the show-more paging.
  const files = (r.files || []).slice().sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
  /* ═══ THE READINGS — what actually came out, before the list ═══
     Output is the proof surface, so its strip answers the proof questions:
     did anything ship TODAY, how many places did it touch, and how long has it
     been since something landed. "Files written" as a bare list flatters a
     quiet week; a clock since the last write does not. */
  const today = dayOf(new Date().toISOString());
  const nToday = files.filter((f2) => dayOf(f2.ts) === today).length;
  const projects = new Set(files.map((f2) => (f2.project || '')).filter(Boolean));
  const last = files[0];
  const lastAge = last ? (Date.now() - (Date.parse(last.ts) || Date.now())) : 0;
  const hrs = Math.floor(lastAge / 36e5);
  const cell = (cls, big, sub) => '<div class="st-si ' + cls + '"><b>' + big + '</b><i>' + sub + '</i></div>';
  setHTML($('#outStrip'), '<div class="st-strip n5">'
    + cell(nToday ? 'live' : 'zero', nToday, nToday ? 'file(s) written today' : 'nothing written today')
    + cell(files.length ? 'go' : 'zero', files.length, 'files in the last 7 days')
    + cell(projects.size ? '' : 'zero', projects.size, projects.size === 1 ? 'project touched' : 'projects touched')
    + cell('', (r.entries || []).length, 'completed responses')
    + cell(hrs > 24 ? 'zero' : '', last ? (hrs < 1 ? '<1h' : hrs + 'h') : '—',
        last ? 'since the last file landed' : 'nothing has landed')
    + '</div>');
  setHTML($('#outFiles'), files.length ? capList('outFiles', files, (f, i, arr) => `
    ${i === 0 || dayOf(f.ts) !== dayOf(arr[i - 1].ts) ? `<div class="day-sep"><span>${esc(dayLabel(f.ts))}</span></div>` : ''}
    <div class="file-row">
      <span class="file-ic">${f.action === 'Write' ? '✦' : '✎'}</span>
      <span class="file-path" data-open="${escAttr(f.file)}" title="open">${esc(f.file)}</span>
      ${projChip(f)}
      <span class="file-meta">${esc(cap(f.agent))} · ${f.edits} edit(s) · <span class="mono">${esc(fmtDT(f.ts))}</span></span>
      <span class="file-acts">
        <button class="mini" data-open="${escAttr(f.file)}">open</button>
        <button class="mini" data-reveal="${escAttr(f.file)}">folder</button>
        <button class="mini" data-copy="${escAttr(f.file)}">⧉</button>
      </span>
    </div>`) : `<div class="empty">No files written in the last 7 days of sessions.</div>`);
  $$('#outFiles [data-open]').forEach((b) => b.onclick = async () => { const res = await C.openPath(b.dataset.open, false); if (!res.ok) toast(res.error || 'could not open', 'bad'); });
  $$('#outFiles [data-reveal]').forEach((b) => b.onclick = async () => { const res = await C.openPath(b.dataset.reveal, true); if (!res.ok) toast(res.error || 'could not open', 'bad'); });
  setHTML($('#outEntries'), (r.entries || []).length ? capList('outEntries', r.entries, (e) => `
    <div class="out-entry expandable">
      <div class="out-head">
        <span class="ragent tone-${TONE[e.agent] || 'slate'}">${esc(cap(e.agent))}</span>
        <span class="out-ts mono" title="${e.timeKnown === false ? 'this memory entry recorded the day but not the time' : ''}">${esc(e.timeKnown === false ? dayLabel(e.ts) : fmtDT(e.ts))}</span>${e.timeKnown === false ? '<span class="out-approx">day only</span>' : ''}
        ${e.title ? `<span class="out-title">${esc(e.title)}</span>` : ''}
        <span class="out-size">${compact(e.chars)} chars</span>
        <button class="mini" data-copy="${escAttr(e.response)}">⧉ copy reply</button>
      </div>
      ${e.inbound ? `<div class="out-ask"><span class="now-lbl">You asked</span>${esc(e.inbound)}</div>` : ''}
      <div class="out-resp"><span class="now-lbl">Delivered</span>${esc(e.response)}</div>
    </div>`) : `<div class="empty">No completed work on record yet.</div>`);
}

/* ============================ SYSTEMS LENS ============================ */
async function loadSystems() {
  const [u, o, lr, ex] = await Promise.all([C.usage(), C.overview(), C.learnings(), C.experiments()]);
  if (!u || u.error || !o || o.error) return;
  const mem = { davara: 0, davaris: 0 };
  const learnN = ((lr && lr.persisted) || []).length, expN = ((ex && ex.items) || []).length;
  const today = (u.series || []).slice(-1)[0] || { turns: 0, secs: 0 };
  const week = (u.series || []).slice(-7);
  const wTurns = week.reduce((s, d) => s + d.turns, 0), wFaults = week.reduce((s, d) => s + (d.turns - d.ok), 0);
  const clean = Math.round((o.stats.cleanRate || 1) * 100);
  // stocks & flows — drawn from real telemetry
  setHTML($('#sysDiagram'), `
    <div class="sys-flow">
      <div class="sys-node src"><div class="sn-ic">☄</div><div class="sn-t">Your asks</div><div class="sn-v">${today.turns} today · ${wTurns}/wk</div></div>
      <div class="sys-arrow"><span></span><span></span><span></span></div>
      <div class="sys-node stock"><div class="sn-ic">◉</div><div class="sn-t">Reasoning <i>(flow)</i></div><div class="sn-v">${fmtSecs(o.stats.totalCompute)} lifetime</div></div>
      <div class="sys-arrow"><span></span><span></span><span></span></div>
      <div class="sys-node stock big"><div class="sn-ic">◈</div><div class="sn-t">Memory <i>(stock)</i></div><div class="sn-v">continuity on disk · read tail-capped</div></div>
      <div class="sys-arrow loop"><span></span><span></span><span></span></div>
      <div class="sys-node feed"><div class="sn-ic">↺</div><div class="sn-t">Reflection <i>(feedback)</i></div><div class="sn-v">${learnN} learnings · ${expN} experiments</div></div>
    </div>
    <div class="sys-balance">
      <div class="sysb"><span class="sysb-l">Reinforcing loop R1 — capability compounds</span><span class="sysb-d">asks → reasoning → memory → better context → better answers → more trust → more asks</span></div>
      <div class="sysb warn"><span class="sysb-l">Balancing loop B1 — envelope pressure</span><span class="sysb-d">memory growth → bigger prompts → latency/faults. Held in check by the tail-cap (2 days × 250 lines) and Wrap Up's archive. Current health: ${clean}% clean, ${wFaults} fault(s) this week.</span></div>
    </div>`);
  const goal = o.goal ? o.goal.text.slice(0, 90) : 'not set';
  const ladder = [
    { rung: 'Paradigm', power: 12, what: 'The SOUL — who Davara IS. The deepest lever; change it rarely and deliberately.', state: 'SOUL.md integrity-monitored', go: 'security' },
    { rung: 'Goal', power: 10, what: 'The north star the system serves.', state: goal, go: 'chat' },
    { rung: 'Self-organisation', power: 9, what: 'The system rewriting itself — reflections becoming applied, measured changes.', state: `${expN} experiment(s) · auto-reflect ${SETTINGS && SETTINGS.autoReflectHours > 0 ? 'every ' + SETTINGS.autoReflectHours + 'h' : 'off'}`, go: 'nextsteps' },
    { rung: 'Rules', power: 8, what: 'Allowed tools, turn budgets, retry policy.', state: 'max-turns levers in Evolution', go: 'nextsteps' },
    { rung: 'Information flows', power: 6, what: 'Who sees what, when. This entire app is an information-flow intervention.', state: 'Live · Sentinel · notifications', go: 'live' },
    { rung: 'Parameters', power: 3, what: 'Model pin, cadences, thresholds. Easiest to change, weakest to leverage.', state: (o.model || '—'), go: 'models' },
  ];
  if (setHTML($('#sysLadder'), ladder.map((l) => `
    <div class="rung" data-go="${l.go}">
      <div class="rung-power"><i style="height:${l.power * 8}%"></i></div>
      <div class="rung-main"><div class="rung-t">${l.rung}</div><div class="rung-w">${esc(l.what)}</div></div>
      <div class="rung-state">${esc(l.state)}</div>
      <span class="rung-go">→</span>
    </div>`).join('')))
    $$('#sysLadder .rung').forEach((el) => el.onclick = () => switchView(el.dataset.go));
}

/* ============================ COMMAND PALETTE (Ctrl+K) ============================ */
const PAL = { open: false, idx: 0, items: [] };
function paletteCommands() {
  const views = NAV.map(([id, lab]) => ({ label: `Go to ${lab}`, hint: 'view', run: () => switchView(id) }));
  return [
    { label: '⚡ Lock In — begin deep work', hint: 'ritual', run: () => { switchView('overview'); runRitual('lockin'); } },
    { label: '◇ Compact — trim logs, keep working', hint: 'ritual', run: () => { switchView('overview'); runRitual('compact'); } },
    { label: '☾ Wrap Up — end the day', hint: 'ritual', run: () => { switchView('overview'); runRitual('wrapup'); } },
    { label: '⟳ Run cortex-health.sh', hint: 'heal', run: async () => { switchView('settings'); } },
    { label: '✨ Optimize — archive + compact', hint: 'heal', run: async () => { const r = await C.heal('optimize'); toast(r.ok ? 'Optimized ✓' : 'Issue: ' + (r.error || ''), r.ok ? 'good' : 'bad'); } },
    { label: '↺ Ask Davara to reflect (learnings)', hint: 'evolve', run: async () => { switchView('learnings'); $('#reflectBtn').click(); } },
    { label: '→ Ask Davara for next moves', hint: 'evolve', run: async () => { switchView('nextsteps'); $('#nextBtn').click(); } },
    { label: '✦ Davara — highest-leverage moves (→ Telegram)', hint: 'evolve', run: async () => { switchView('nextsteps'); $('#davaraNextBtn').click(); } },
    { label: '? The guide — the first hour, every walkthrough', hint: 'help', run: () => window.open('https://github.com/InitiumBuilders/Semble-CC/blob/main/docs/GUIDE.md') },
    { label: '? The feature map — what every room is for', hint: 'help', run: () => window.open('https://github.com/InitiumBuilders/Semble-CC/blob/main/docs/FEATURES.md') },
    { label: '? Propose a feature or report a problem', hint: 'help', run: () => window.open('https://github.com/InitiumBuilders/Semble-CC/issues/new/choose') },
    { label: '? Commands — type /help on Command', hint: 'help', run: () => { switchView('chat'); } },
    { label: '👁 Watch Davara live', hint: 'live', run: () => { LIVE.agent = 'davara'; switchView('live'); } },
    { label: '👁 Watch Davaris live', hint: 'live', run: () => { LIVE.agent = 'davaris'; switchView('live'); } },
    ...views,
  ];
}
function openPalette() {
  PAL.open = true; PAL.idx = 0;
  $('#palette').classList.add('open');
  $('#paletteInput').value = ''; renderPalette(''); $('#paletteInput').focus();
}
function closePalette() { PAL.open = false; $('#palette').classList.remove('open'); }
function renderPalette(q) {
  const all = paletteCommands();
  PAL.items = q ? all.filter((c) => c.label.toLowerCase().includes(q.toLowerCase())) : all;
  PAL.idx = Math.min(PAL.idx, Math.max(0, PAL.items.length - 1));
  $('#paletteList').innerHTML = PAL.items.slice(0, 12).map((c, i) =>
    `<div class="pal-item ${i === PAL.idx ? 'sel' : ''}" data-pi="${i}"><span>${c.label}</span><span class="pal-hint">${c.hint}</span></div>`).join('') || '<div class="empty" style="padding:14px">No matches.</div>';
  $$('#paletteList .pal-item').forEach((el) => el.onclick = () => { const c = PAL.items[+el.dataset.pi]; closePalette(); if (c) c.run(); });
}
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); PAL.open ? closePalette() : openPalette(); return; }
  if (!PAL.open) return;
  if (e.key === 'Escape') closePalette();
  else if (e.key === 'ArrowDown') { e.preventDefault(); PAL.idx = Math.min(PAL.idx + 1, PAL.items.length - 1); renderPalette($('#paletteInput').value); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); PAL.idx = Math.max(PAL.idx - 1, 0); renderPalette($('#paletteInput').value); }
  else if (e.key === 'Enter') { e.preventDefault(); const c = PAL.items[PAL.idx]; closePalette(); if (c) c.run(); }
});
$('#paletteInput').addEventListener('input', (e) => renderPalette(e.target.value));
$('#palette').addEventListener('click', (e) => { if (e.target.id === 'palette') closePalette(); });

/* ============================ FLEET HELPERS ============================ */
function toChat(agent, text) {
  CUR.chatAgent = agent; switchView('chat'); loadChatBar();
  if (text && chatBox) { chatBox.value = text; chatBox.style.height = 'auto'; chatBox.style.height = Math.min(140, chatBox.scrollHeight) + 'px'; }
  if (chatBox) chatBox.focus();
}
function protoCards(list) {
  return (list || []).map((p) => `<div class="proto expandable"><div class="proto-n">${esc(p.name)}</div><div class="proto-d">${esc(p.desc)}</div></div>`).join('') || `<div class="empty">—</div>`;
}
function cmdRows(list, agent) {
  return (list || []).map((c) => `<div class="cmd-row" data-tochat="${esc(agent)}" data-cmdtext="${escAttr(c.cmd)}"><code>${esc(c.cmd)}</code><span class="cmd-when">${esc(c.when)}</span></div>`).join('') || `<div class="empty">—</div>`;
}
function featGrid(list) {
  return (list || []).map((f) => `<div class="feat expandable">✦ ${esc(f)}</div>`).join('') || `<div class="empty">—</div>`;
}
function wireCmdRows(scope) {
  $$('[data-tochat]', scope).forEach((el) => el.onclick = () => toChat(el.dataset.tochat, el.dataset.cmdtext));
}

/* ============================ SYMPATH-CORTEX ============================ */
async function loadSympath() {
  const s = FLEET.sympath || {};
  if (s.tagline) $('#sympathTagline').textContent = s.tagline;
  const list = await C.agents().catch(() => null);
  const me = (list && !list.error) ? list.find((x) => x.id === 'sympath-cortex') : null;
  setHTML($('#sympathHero'), `
    <div class="sym-hero-in">
      <div class="sym-ava">S</div>
      <div style="flex:1;min-width:0">
        <div class="sym-name">Sympath-Cortex <span class="sym-mode" data-live-mode="sympath-cortex">—</span></div>
        <div class="sym-role">Anchor &amp; Healer · diagnostics · refinement · the learning engine · read-only (proposes, never silently mutates)</div>
        <div class="sym-stats">${me ? `${me.turns} turns · ${Math.round((me.cleanRate || 1) * 100)}% clean · ${me.avgLatency ? Math.round(me.avgLatency) + 's avg' : 'no latency yet'} · ~${compact(me.tokens)} tok` : 'Awaiting her first turn through the relay.'}</div>
      </div>
    </div>`);
  setHTML($('#sympathNow'), (me && me.lastFocus) ? `<div class="now-card glass-deep tone-emerald"><div class="now-head"><span class="now-orb"></span><span class="now-agent">Last focus</span><span class="now-elapsed mono muted">${me.lastTs ? ago(me.lastTs) + ' ago' : ''}</span></div><div class="now-ask expandable">${esc(me.lastFocus)}</div></div>` : '');
  setHTML($('#sympathProtocols'), protoCards(s.protocols));
  setHTML($('#sympathCommands'), cmdRows(s.commands, 'sympath-cortex')); wireCmdRows($('#sympathCommands'));
  setHTML($('#sympathFeatures'), featGrid(s.features));
  const lr = await C.learnings().catch(() => null);
  const items = (lr && lr.persisted) || [];
  setHTML($('#sympathLearnings'), items.length ? capList('sympathLearnings', items, (it) => ledger(it, 'learnings')) : `<div class="empty">No learnings yet — ask her to harvest, or run a diagnostic.</div>`);
  attachLedger($('#sympathLearnings'), 'learnings', loadSympath);
}
$('#sympathDiagnose').onclick = () => toChat('sympath-cortex', 'Run a deep diagnostic of the Cortex now. Sense the system state, reproduce any strain, root-cause it (symptom → structure → lever), and propose fixes as a diff + runbook. ULTRACODE — leave nothing unexamined.');
$('#sympathReflect').onclick = async () => { if (_reflecting) return; _reflecting = true; const b = $('#sympathReflect'); b.disabled = true; b.textContent = '↻ harvesting…'; const r = await C.reflect('learn').catch(() => null); _reflecting = false; b.disabled = false; b.textContent = '↻ Harvest learnings'; if (r && r.ok) { toast(r.added ? `${r.added} learning(s) harvested` : 'Nothing new', 'good'); loadSympath(); } else toast('Could not reach Sympath-Cortex', 'bad'); };

/* ============================ LEVELS · ARDEN (gated) ============================ */
const LEVELS = { unlocked: false };
function loadLevels() {
  $('#levelsTitle').textContent = LEVELS.unlocked ? 'Levels · Arden' : 'Levels';
  renderArden();
}
async function renderArden() {
  const a = FLEET.arden || {};
  // keep the neutral public tagline (index.html) — never echo the forge line that hints at the gesture
  setHTML($('#ardenHero'), `
    <div class="sym-hero-in">
      <div class="sym-ava arden-ava">◈</div>
      <div style="flex:1;min-width:0">
        <div class="sym-name">Arden <span class="sym-mode arden-mode" data-live-mode="arden">—</span></div>
        <div class="sym-role">The current beneath the system — systems-innovation, integrity, and the seer across horizons. The first loop.</div>
      </div>
    </div>`);
  // PUBLIC layer — Arden's reflections / advice / insights (always visible)
  const r = await C.ardenLog().catch(() => null);
  const items = (r && r.items) || [];
  setHTML($('#ardenReflections'), items.length ? capList('ardenReflections', items, (it) => ledger(it, null)) : `<div class="empty">Arden is observing quietly. Ask her to reflect — she sees what the others cannot.</div>`);
  attachLedger($('#ardenReflections'), null, renderArden);
  $('#ardenLoopState').textContent = (r && r.loop) ? r.loop : '';
  // DEEPER layer — rendered only when summoned; scrubbed from the DOM otherwise.
  const sec = $('#levelsSecure');
  if (LEVELS.unlocked) {
    if (sec) sec.style.display = 'block';
    setHTML($('#ardenFocuses'), featGrid(a.features || []));
    setHTML($('#ardenSignals'), (a.signals || []).map((s) => `<div class="signal"><span class="sig-sym">${esc(s.symbol)}</span><span class="sig-mean">${esc(s.meaning)}</span></div>`).join('') || `<div class="empty">—</div>`);
    setHTML($('#ardenProtocols'), protoCards(a.protocols));
    setHTML($('#ardenCommands'), cmdRows(a.commands, 'arden')); wireCmdRows($('#ardenCommands'));
    const trips = (r && r.canaryTrips) || [];
    setHTML($('#ardenCanary'), trips.length ? capList('ardenCanary', trips, (t) => `<div class="inject-row"><div class="ip">${esc(fmtTs(t.ts))} · ${esc(t.host)} · ${esc(t.served)}</div><div class="ix">fingerprint ${esc((t.fingerprint || '').slice(0, 16))}…</div></div>`) : `<div class="heal-item ok"><span class="hi">✓</span> Quiet — no reveals requested.</div>`);
  } else if (sec) {
    sec.style.display = 'none';
    ['ardenFocuses', 'ardenSignals', 'ardenProtocols', 'ardenCommands', 'ardenCanary'].forEach((id) => { const el = $('#' + id); if (el) { el.innerHTML = ''; _domHash.delete(el); } });
  }
  C.ardenSeen().catch(() => {});
  updateArdenSign({ unseen: false });
}
$('#ardenObserve').onclick = async () => {
  const b = $('#ardenObserve'); b.disabled = true; b.textContent = '◈ Arden is observing…';
  const r = await C.ardenObserve().catch(() => null);
  b.disabled = false; b.textContent = '◈ Ask Arden to observe';
  if (r && r.ok) { toast('Arden has left a reflection', 'good'); renderArden(); }
  else toast('Arden is silent: ' + ((r && r.error) || 'relay'), 'bad');
};
$('#ardenChatBtn').onclick = () => toChat('arden', '');

// Arden's discreet sign in the titlebar — appears only when she has something unseen.
function updateArdenSign(sign) {
  const el = $('#ardenSign'); if (!el) return;
  if (sign && sign.unseen) { el.classList.add('lit'); if (sign.symbol) el.textContent = sign.symbol; el.title = 'Arden'; }
  else el.classList.remove('lit');
}
$('#ardenSign').onclick = () => switchView('levels');   // opens Arden's public reflections; the depth stays for you alone

/* ---- the descent: hold Space 5s to unseal the Levels ---- */
let _holdActive = false, _holdStart = 0, _holdRAF = 0, _holdShow = 0;
const DESCENT_MS = 5000, RING = 2 * Math.PI * 52;
function startHold() {
  if (_holdActive) return; _holdActive = true; _holdStart = Date.now();
  _holdShow = setTimeout(() => $('#descent').classList.add('show'), 420); // no flash on a tap
  const tick = () => {
    if (!_holdActive) return;
    const p = Math.min(1, (Date.now() - _holdStart) / DESCENT_MS);
    const fg = $('#descentFg'); if (fg) { fg.style.strokeDasharray = RING; fg.style.strokeDashoffset = RING * (1 - p); }
    if (p >= 1) { completeHold(); return; }
    _holdRAF = requestAnimationFrame(tick);
  };
  tick();
}
function cancelHold() {
  _holdActive = false; if (_holdRAF) cancelAnimationFrame(_holdRAF); _holdRAF = 0;
  clearTimeout(_holdShow); $('#descent').classList.remove('show');
}
function completeHold() {
  cancelHold(); LEVELS.unlocked = true;   // silent — the deeper panels simply appear
  if (CUR.view !== 'levels') switchView('levels'); else loadLevels();
}
document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || e.repeat) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  if (document.body.classList.contains('locked')) return;
  e.preventDefault(); startHold();
});
document.addEventListener('keyup', (e) => { if (e.code === 'Space') cancelHold(); });
window.addEventListener('blur', cancelHold);

/* ============================ THE LIVING NEURAL FIELD ============================ */
function startField() {
  const cv = $('#field'), ctx = cv.getContext('2d');
  let W, H, DPR = Math.min(2, window.devicePixelRatio || 1), nodes = [], pulses = [], t = 0;
  function resize() {
    W = cv.width = innerWidth * DPR; H = cv.height = innerHeight * DPR; cv.style.width = innerWidth + 'px'; cv.style.height = innerHeight + 'px';
    const N = Math.round((innerWidth * innerHeight) / 46000); // density-scaled, capped
    nodes = []; for (let i = 0; i < Math.min(46, N); i++) nodes.push({
      x: Math.random() * W, y: Math.random() * H, vx: (Math.random() - .5) * .12 * DPR, vy: (Math.random() - .5) * .12 * DPR, r: (Math.random() * 1.6 + .8) * DPR,
    });
  }
  resize(); addEventListener('resize', resize);
  function spawnPulse() {
    if (nodes.length < 2) return;
    const a = nodes[(Math.random() * nodes.length) | 0], b = nodes[(Math.random() * nodes.length) | 0];
    if (a === b) return; pulses.push({ a, b, t: 0, life: 70 + Math.random() * 50 });
  }
  function draw() {
    if (document.body.classList.contains('reduce-motion')) { ctx.clearRect(0, 0, W, H); requestAnimationFrame(() => setTimeout(draw, 120)); return; }
    t++; ctx.clearRect(0, 0, W, H);
    const fault = PULSE.faulting;
    const baseR = fault ? '255,93,120' : '124,77,255';
    const baseC = fault ? '255,120,140' : '84,230,255';
    const intensity = 0.25 + (PULSE.intensity || 0) * 0.75;
    // drift
    for (const n of nodes) {
      n.x += n.vx; n.y += n.vy;
      if (n.x < 0 || n.x > W) n.vx *= -1; if (n.y < 0 || n.y > H) n.vy *= -1;
    }
    // links
    const LINK = 132 * DPR;
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j], dx = a.x - b.x, dy = a.y - b.y, d = Math.hypot(dx, dy);
      if (d < LINK) {
        const al = (1 - d / LINK) * 0.14 * intensity;
        ctx.strokeStyle = `rgba(${baseR},${al})`; ctx.lineWidth = DPR * .6;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
    }
    // nodes
    for (const n of nodes) {
      const glow = (Math.sin(t * 0.02 + n.x) * .5 + .5) * .5 + .5;
      ctx.fillStyle = `rgba(${baseC},${0.5 * glow * intensity})`;
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, 7); ctx.fill();
    }
    // travelling pulses
    if (t % Math.max(8, Math.round(34 - intensity * 26)) === 0) spawnPulse();
    pulses = pulses.filter((p) => p.t < p.life);
    for (const p of pulses) {
      p.t++; const k = p.t / p.life; const x = p.a.x + (p.b.x - p.a.x) * k, y = p.a.y + (p.b.y - p.a.y) * k;
      const al = Math.sin(k * Math.PI);
      const grd = ctx.createRadialGradient(x, y, 0, x, y, 7 * DPR);
      grd.addColorStop(0, `rgba(${baseC},${0.9 * al})`); grd.addColorStop(1, `rgba(${baseC},0)`);
      ctx.fillStyle = grd; ctx.beginPath(); ctx.arc(x, y, 7 * DPR, 0, 7); ctx.fill();
    }
    requestAnimationFrame(draw);
  }
  draw();
}
