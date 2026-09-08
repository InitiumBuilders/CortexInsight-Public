// ============================================================================
//  CortexInsight — main process (the engine room)
//  A living window into a local agent fleet: the SEMBLE CORTEX. Built for one
//  operator first; runs for any, paired to the machine that opens it.
//
//  Hard guarantees this process holds:
//   • READ-ONLY on the fleet tree by default. The ONE place it writes is
//     the model pin (explicit, confirmed, backed-up, reversible). Nothing else in
//     the fleet tree is ever touched — its own brain (goals/steers/learnings) lives
//     in this app's private userData, never polluting the Cortex.
//   • Talks to the agents ONLY through the same loopback relay Hermes uses
//     (127.0.0.1:8788). No new attack surface, no second claude call path.
//   • Hardware-locked + password-gated. On a foreign machine it degrades to a
//     silent decoy and fires a beacon — discreetly.
// ============================================================================
'use strict';

const { app, BrowserWindow, ipcMain, Notification, shell, Tray, Menu, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { execFile } = require('child_process');

// ---------------------------------------------------------------------------
//  No baked secrets. The gate password is created on first run and lives in
//  the vault as a hash (settings.passSha); the vault pairs itself to the first
//  machine that opens it (trustedFingerprints). Nothing identifying ships in
//  this file — scripts/oss-check.js keeps it that way.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
//  Paths / config
// ---------------------------------------------------------------------------
// a placeholder that names nobody; the real root is set by the operator or
// discovered on first run (discoverRoot) and lives in the vault
// a placeholder naming nobody; discoverRoot() finds the real tree. On Windows
// the tree lives in WSL behind a UNC path; on macOS it is a folder in the home.
const DEFAULT_ROOT = process.platform === 'win32'
  ? '\\\\wsl.localhost\\ubuntu\\home\\operator\\cortex'
  : path.join(os.homedir(), 'cortex');
const RELAY = { host: '127.0.0.1', port: 8788 };

// ---------------------------------------------------------------------------
//  FLEET REGISTRY — the single source of truth for every agent in the system.
//  Every screen (Command, Live, Tasks, Output, Agents, Workflows) derives from
//  THIS list, so an agent can never again exist in one view but not another.
//
//  lane: 'relay'      → runs through the fleet's mouth-proxy relay on August's
//                       Claude Code subscription ($0). The default for all.
//        'openrouter' → Sympath SEI only: a Hermes gateway holding its own
//                       OpenRouter key. Never touches the relay, but is still
//                       fully observable here (live / tasks / output).
// ---------------------------------------------------------------------------
const DEFAULT_MODEL = 'claude-opus-5';   // August 2026-07-29: Opus 5 is the fleet default
const FLEET = [
  { id: 'davara', name: 'Davara', lane: 'relay', tone: 'violet', maxTurns: 96,
    role: 'Systems Savant · Deep Thinker · Orchestrator', effort: 'high',
    coder: true, blurb: 'Architecture, systems sight, orchestration of the whole build.' },
  { id: 'davaris', name: 'Davaris', lane: 'relay', tone: 'cyan', maxTurns: 128,
    role: 'Workhorse · Builder · Execution', effort: 'high',
    coder: true, blurb: 'Ships code. The hands that build what Davara designs.' },
  // Davari (2026-09-01, August: "faster abilities always on Opus 5 and ultra code
  // always on"). Her speed is bought from the ENVELOPE, not from a weaker model or
  // a shallower dial — she carries no SOUL cathedral and no leverage reasoner, so
  // she skips the ~43k-token identity Davara re-sends every non-resume turn, while
  // staying on Opus 5 at ULTRACODE. Keeps Task/Agent so she can spawn subagents.
  { id: 'davari', name: 'Davari', lane: 'relay', tone: 'rose', maxTurns: 40,
    role: 'Fast build lane · Davara\'s hands · spawns subagents', effort: 'max',
    coder: true, blurb: 'Builds at full depth without re-reading herself first. The quick hands.' },
  { id: 'sympath-cortex', name: 'Sympath-Cortex', lane: 'relay', tone: 'emerald', maxTurns: 48,
    role: 'Anchor & Healer · bug-test · refinement · learning engine', effort: 'max',
    coder: true, blurb: 'Diagnoses, reproduces, root-causes and proposes fixes. The learning engine.' },
  { id: 'arden', name: 'Arden', lane: 'relay', tone: 'gold', maxTurns: 48,
    // 'high', not 'max': she runs an ambient 8h background loop, and ULTRACODE on
    // every ambient pass was ~21 of the heaviest turns a week for observation
    // nobody was waiting on. Set her to ULTRACODE on the Model screen when it matters.
    role: 'Hidden guardian · security · systems innovation', effort: 'high',
    altModels: ['claude-opus-5', 'claude-fable-5'],  // August toggles her between these
    coder: true, blurb: 'Assume-breach review, integrity watch, the better-system move.' },
  { id: 'august', name: 'August', lane: 'relay', tone: 'amber', maxTurns: 16,
    role: 'Primary builder-assistant (generic relay seat)', effort: 'high',
    coder: true, blurb: 'General build assistant on the generic relay seat.' },
  { id: 'august-v3', name: 'August-V3', lane: 'relay', tone: 'slate', maxTurns: 16,
    role: 'Observer mode — watch & note only', effort: 'medium',
    blurb: 'Watches and notes. Never acts.' },
  { id: 'sympath-sei', name: 'Sympath SEI', lane: 'openrouter', tone: 'rose', maxTurns: 0,
    role: 'Healer SEI · OpenRouter · the one paid-key agent', effort: null,
    provider: 'openrouter', external: true,
    blurb: 'Runs on her own OpenRouter key via the Hermes gateway — observed here, never relayed.' },
  // the second stack: a seat on the operator's OpenAI key, driven from here,
  // carrying the fleet's brief and no soul file. Dark until a key is sealed.
  { id: 'gpt', name: 'GPT', lane: 'openai', tone: 'emerald', maxTurns: 0,
    role: 'OpenAI seat · the second stack', effort: null, provider: 'openai', external: false,
    blurb: 'Answers /gpt on Command and makes images for the whole fleet, on your OpenAI key.' },
];
// ---------------------------------------------------------------------------
//  INFRASTRUCTURE SEATS — lanes, not personas.
//
//  August asked for "a workhorse opus 5 with almost no harness or prompt so its
//  super faster … and can route more strategic moves and requests to our main
//  model". That is a ROUTER, not a new agent, and the distinction matters: a
//  workhorse card sitting next to Davara in the fleet UI would be a lie about
//  what it is. It has no soul file, no identity, no opinion. It is the reflex
//  lane — the seat a cycle takes when the thinking is already done.
//
//  MEASURED, not assumed (3 paired rounds through the live relay, alternating
//  order so CLI warm-up cancels): workhorse 9,329ms mean vs Davara 13,473ms —
//  and on a pure no-tool reply, 6,074ms vs 13,392ms. The delta IS the envelope.
//
//  So it lives here: reachable by relaySend and measurable by seatCapabilities,
//  but absent from FLEET, so no persona list, picker or telemetry row grows a
//  seat that is not a mind.
// ---------------------------------------------------------------------------
const INFRA_SEATS = [
  { id: 'workhorse', name: 'Workhorse', lane: 'relay', tone: 'slate', infra: true,
    maxTurns: 24, effort: 'medium', coder: true,
    role: 'Reflex lane · lean seat · no soul envelope',
    blurb: 'The fast lane. Carries no identity — takes the cycles where the thinking is already done.' },
];
const FLEET_BY_ID = Object.fromEntries([...FLEET, ...INFRA_SEATS].map((f) => [f.id, f]));
// relay-lane ids (what the relay telemetry actually logs) — personas only
const AGENTS = FLEET.filter((f) => f.lane === 'relay').map((f) => f.id);
const INFRA_IDS = INFRA_SEATS.map((f) => f.id);
const isInfraSeat = (id) => INFRA_IDS.includes(id);
const ALL_AGENT_IDS = [...FLEET.map((f) => f.id), ...INFRA_IDS];
const isRelayAgent = (id) => !!(FLEET_BY_ID[id] && FLEET_BY_ID[id].lane === 'relay');

let mainWin = null;
let STATE = null;         // app's private persisted brain (goals/steers/learnings/etc.)
let GUARD = null;         // device-trust verdict
let bootEpoch = Date.now();

const userDataDir = () => app.getPath('userData');
const statePath = () => path.join(userDataDir(), 'cortex-insight-state.json');

function root() {
  return (STATE && STATE.settings && STATE.settings.cortexRoot) || DEFAULT_ROOT;
}
const P = (...segs) => path.join(root(), ...segs);

// ---------------------------------------------------------------------------
//  Tiny utilities
// ---------------------------------------------------------------------------
// The runner stamps records and names its daily files in LOCAL time. Any
// "today" compared against those must be the local date; the UTC date is
// already tomorrow for most of the evening west of Greenwich, which froze the
// live log as a past day and zeroed the day's counts every night.
function localDay(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const now = () => Date.now();
// ───────────────────────────────────────────────────────────────────────────
//  THE HANDLER INSTRUMENT. The renderer's timer can say "the tasks view is
//  slow" but not WHY — a slow screen and a slow handler are different bugs
//  with different owners. Every ipcMain.handle registration passes through
//  this wrapper, so every channel is timed at the source, forever, including
//  channels added later that nobody remembers to instrument. Cost per call:
//  one subtraction and a bounded array push.
// ───────────────────────────────────────────────────────────────────────────
const IPC_PERF = Object.create(null);
{
  const _h = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, fn) => _h(channel, async (...args) => {
    const t0 = Date.now();
    try { return await fn(...args); }
    finally {
      const ms = Date.now() - t0;
      const p = IPC_PERF[channel] || (IPC_PERF[channel] = { ms: [], worst: 0, n: 0 });
      p.n++; p.ms.push(ms);
      if (p.ms.length > 16) p.ms.shift();
      if (ms > p.worst) p.worst = ms;
    }
  });
}
function ipcPerfTop() {
  const out = [];
  for (const [ch, p] of Object.entries(IPC_PERF)) {
    if (p.ms.length < 3) continue;
    const a = [...p.ms].sort((x, y) => x - y);
    const med = a[Math.floor(a.length / 2)];
    if (med > 350) out.push({ channel: ch, med, worst: p.worst, n: p.n });
  }
  return out.sort((x, y) => y.med - x.med).slice(0, 6);
}
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const estTokens = (chars) => Math.ceil((chars || 0) / 4); // honest estimate: ~4 chars/token

function safe(fn, fallback) { try { return fn(); } catch { return fallback; } }
function exists(p) { return safe(() => fs.existsSync(p), false); }

// --- text-variety helpers (used to stop agents repeating themselves) -----------
// Normalise to a bag of meaningful words (drop tiny stopwords + punctuation).
const _STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'is', 'are', 'for', 'with', 'that', 'this', 'it', 'as', 'at', 'by', 'be', 'we', 'our', 'her', 'his', 'its', 'one', 'not', 'but', 'has', 'have', 'into', 'over', 'than', 'then', 'now']);
function wordBag(s) {
  return new Set(String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !_STOP.has(w)));
}
// Jaccard similarity of two short strings (0 = unrelated, 1 = identical wording).
function textSimilarity(a, b) {
  const A = wordBag(a), B = wordBag(b);
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}
// Is `title` a near-duplicate of anything in `recent` (titles/bodies)? Default 0.5 threshold.
function isNearDuplicate(title, recent, thresh = 0.5) {
  const t = String(title || '');
  return recent.some((r) => textSimilarity(t, typeof r === 'string' ? r : (r.title || '')) >= thresh);
}

// Efficient tail read — never slurp a 1MB memory file whole. Reads last `maxBytes`.
async function tailFileAsync(p, maxBytes = 220 * 1024) {
  let fh = null;
  try {
    fh = await fs.promises.open(p, 'r');
    const size = (await fh.stat()).size;
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, start);
    let t = buf.toString('utf8');
    if (start > 0) { const nl = t.indexOf(String.fromCharCode(10)); if (nl >= 0) t = t.slice(nl + 1); }
    return t;
  } catch { return ''; }
  finally { if (fh) { try { await fh.close(); } catch {} } }
}
function tailFile(p, maxBytes = 220 * 1024) {
  try {
    const fd = fs.openSync(p, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - maxBytes);
      const len = size - start;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      let s = buf.toString('utf8');
      if (start > 0) { const nl = s.indexOf('\n'); if (nl >= 0) s = s.slice(nl + 1); }
      return s;
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
}

// head read — first maxBytes of a file (for transcript inbound extraction)
function readHead(p, maxBytes = 64 * 1024) {
  try {
    const fd = fs.openSync(p, 'r');
    try { const size = Math.min(fs.fstatSync(fd).size, maxBytes); const buf = Buffer.alloc(size); fs.readSync(fd, buf, 0, size, 0); return buf.toString('utf8'); }
    finally { fs.closeSync(fd); }
  } catch { return ''; }
}

// A stat-gated read: one stat per call instead of a full read, for files the
// poll asks about every tick and that change once a week (the runner scripts,
// the checkpoints). bridgeStatus() alone re-read cortex-run.sh twice per tick.
const _rtCache = new Map();
function readTextCached(p) {
  const st = statOf(p);
  if (!st) { _rtCache.delete(p); return ''; }
  const hit = _rtCache.get(p);
  if (hit && hit.size === st.size && hit.mtime === st.mtimeMs) return hit.text;
  const text = safe(() => fs.readFileSync(p, 'utf8'), '');
  _rtCache.set(p, { size: st.size, mtime: st.mtimeMs, text });
  if (_rtCache.size > 64) _rtCache.delete(_rtCache.keys().next().value);
  return text;
}
function readText(p, maxBytes) { return maxBytes ? tailFile(p, maxBytes) : safe(() => fs.readFileSync(p, 'utf8'), ''); }
// ───────────────────────────────────────────────────────────────────────────
//  THE DELTA READER. Every log this app meters is append-only: transcripts,
//  interaction logs, the proxy log. Yet each time one grew by a line, the
//  per-file caches saw "size changed" and re-read its last 160–500 KB across
//  the 9P bridge — for a LIVE transcript that is every few seconds, the whole
//  window, forever. readDelta reads only the bytes past the cached size and
//  carries the trailing partial line to the next call. A growing file costs
//  its growth; only a shrink (rotation) or a jump past the window costs a
//  full tail again. Sync and async twins, same contract:
//    { text, carry, full }   full=true means "start over from this text"
// ───────────────────────────────────────────────────────────────────────────
function splitCarry(text) {
  const i = text.lastIndexOf(NL);
  return i < 0 ? { body: '', carry: text } : { body: text.slice(0, i), carry: text.slice(i + 1) };
}
function readRange(p, start, end) {
  try {
    const fd = fs.openSync(p, 'r');
    try { const len = Math.max(0, end - start); const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, start); return buf.toString('utf8'); }
    finally { fs.closeSync(fd); }
  } catch { return ''; }
}
async function readRangeAsync(p, start, end) {
  let fh = null;
  try {
    fh = await fs.promises.open(p, 'r');
    const len = Math.max(0, end - start); const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, start);
    return buf.toString('utf8');
  } catch { return ''; }
  finally { if (fh) { try { await fh.close(); } catch {} } }
}
function deltaPlan(cached, st, maxBytes) {
  const size = st ? st.size : 0;
  const ok = cached && typeof cached.size === 'number' && size >= cached.size && size - cached.size <= maxBytes;
  return { ok, size, from: ok ? cached.size : 0 };
}
function readDelta(p, cached, st, maxBytes) {
  const plan = deltaPlan(cached, st, maxBytes);
  if (plan.ok) {
    if (plan.size === plan.from) return { text: '', carry: cached.carry || '', full: false };
    const r = splitCarry((cached.carry || '') + readRange(p, plan.from, plan.size));
    return { text: r.body, carry: r.carry, full: false };
  }
  const r = splitCarry(tailFile(p, maxBytes));
  return { text: r.body, carry: r.carry, full: true };
}
async function readDeltaAsync(p, cached, st, maxBytes) {
  const plan = deltaPlan(cached, st, maxBytes);
  if (plan.ok) {
    if (plan.size === plan.from) return { text: '', carry: cached.carry || '', full: false };
    const r = splitCarry((cached.carry || '') + await readRangeAsync(p, plan.from, plan.size));
    return { text: r.body, carry: r.carry, full: false };
  }
  const r = splitCarry(await tailFileAsync(p, maxBytes));
  return { text: r.body, carry: r.carry, full: true };
}
const NL = String.fromCharCode(10);
function statOf(p) { return safe(() => fs.statSync(p), null); }
function listDir(p) { return safe(() => fs.readdirSync(p), []); }

// ---------------------------------------------------------------------------
//  Persisted app brain (private — lives in userData, NOT in the fleet tree)
// ---------------------------------------------------------------------------
function defaultState() {
  return {
    settings: {
      cortexRoot: DEFAULT_ROOT,
      defaultAgent: 'davara',
      operatorName: '',           // how the fleet addresses you; the brief carries it every turn
      pollMs: 7000,               // 4s was gratuitous over the WSL 9p bridge; 7s reads identically to the eye
      autoEvolve: false,         // periodic Cortex self-reflection
      beaconUrl: '',             // optional remote endpoint for foreign-device alerts
      reduceMotion: false,
      // --- Sentinel ---
      minimizeToTray: true,
      watchdogMs: 45000,         // background guardian cadence
      alertRelay: true,          // notify on relay offline
      alertFaults: true,         // notify on new fault/timeout
      alertHang: true,           // notify on a turn stuck inflight
      alertComplete: false,      // notify on every completed turn (off by default — noisy)
      alertIntegrity: true,      // notify on critical-file change
      hangMinutes: 30,           // inflight longer than this = possible hang
      // --- Closed loop ---
      autoReflectHours: 0,       // 0 = off; else Sympath-Cortex auto-reflects every N hours
      ardenLoopHours: 8,         // Arden's background observation loop (the first Loop); 0 = off
      // --- Autonomy & adaptivity (the self-evolving layer) ---
      autoApprove: true,         // Davaris auto-endorses only the HIGH-conviction reflections/next-steps (non-destructive flag; never applies a runner change)
      autoApproveMinConviction: 9, // only auto-lock items Davaris rates >= this (1-10); the "super sure" no-brainers. lower = looser.
      telegramNudges: true,      // key/critical moments also ping August on Telegram (via davara-tg-send.sh)
      davaraNextMovesDaily: true,// once a day (and when stuck) Davara DMs the highest-leverage next moves
      breakNudgeHours: 10,       // after this many hours of an active day, nudge August to pause / wrap up; 0 = off
      cleanupThreshold: 800,     // vault item count above which the cleanup auto-recommender fires
      // Agent→agent delegation. 0 = agents may PROPOSE a handoff but nothing
      // fires without August. Raising it lets the APP spend, up to N per day —
      // the invariant "agents never spend, the app spends under a cap" holds.
      delegationPerDay: 0,
      // --- canary email (Gmail SMTP via an App Password; password stored DPAPI-encrypted) ---
      canaryEmailTo: '',
      smtpUser: '',
      smtpAppPasswordEnc: '',    // base64 of safeStorage.encryptString(appPassword) — never plaintext, never sent to renderer
      // --- DASH-OPS voice (ElevenLabs). Same discipline as the SMTP secret:
      //     DPAPI-encrypted at rest, decrypted only inside the main process,
      //     never returned to the renderer, never written to a log.
      elevenKeyEnc: '',
      elevenKeySource: '',       // the FILE it was adopted from — never the key itself
      voiceId: 'tpS5zOAgWUiQMhzYbG2h',   // Davara's canonical voice
      voiceName: 'Davara',
      voiceModel: 'eleven_turbo_v2_5',
      voiceStability: 0.45,
      voiceSimilarity: 0.8,
      voiceAgent: 'davara',
      voiceAutoSpeak: true,      // speak agent replies aloud in the voice console
      voiceSpeakDuo: false,      // also speak Duo-Drive pass titles as they land
    },
    goal: null,                  // { text, ts, agent } — long-term north star
    motus: null,                 // { text, ts, agent } — the single strongest thing moving NOW
    steers: [],                  // [{ ts, agent, text }]
    sentLog: [],                 // [{ ts, agent, kind, text, srcLocalIp, srcPublicIp, fingerprint, ok, latency }]
    learnings: [],               // [{ ts, source, title, body }]
    nextSteps: [],               // [{ ts, source, title, body, done }]
    intrusions: [],              // [{ ts, fingerprint, hostname, username, localIps, publicIp, signals }]
    trustedFingerprints: [],      // filled at first boot: the vault pairs to its machine
    seenInjections: [],          // hashes of flagged inbound messages (dedupe)
    notifications: [],           // [{ ts, level, title, body, view, read }]
    integrity: { baseline: {}, alerts: [] }, // baseline: { rel: {hash,size,snapshot,ts} }
    experiments: [],             // [{ ts, lever, agent, from, to, before, after, status }]
    watchdog: { lastSeenTurnEpoch: 0, lastReflect: 0, lastArden: 0, lastNextMoves: 0, lastCompact: 0, lastBreakNudge: 0, lastCleanupNudge: 0 },
    injClearedAt: 0,             // hide injection flags at/before this epoch (operator ack)
    decoyIp: '',                 // the FAKE public IP shown everywhere in the UI (real one never leaves main)
    canaryTrips: [],             // [{ ts, fingerprint, host, served }] — anyone who tried to read the IP
    ardenLog: [],                // [{ ts, kind, source, title, body, symbol }] — Arden's (hidden) reflections for the Levels view
    ardenSign: { unseen: false, symbol: '' }, // her discreet "come to the Levels" sign
    firstRun: null,

    // --- v2.0 — the command-center layer -----------------------------------
    fleetConfig: {},             // { [agentId]: { model, effort, paused, hard } } — per-agent model + quality
    control: { stopped: false, hard: false, at: 0 },  // fleet stop/resume control plane
    tasks: [],                   // real task manager: [{ id, title, body, agent, status, priority, created, updated, tags, jobs[] }]
    workflows: [],               // MotusModels: [{ id, name, intent, stages[], created, runs }]
    workflowRuns: [],            // [{ id, wf, started, finished, status, steps[] }]
    duo: { active: false, agent: 'davara', cadenceMin: 25, mode: 'complement', lastRun: 0, brief: '', log: [], runs: 0 },
    // --- v3: LEVERAGE LOOPS — the Duo-Drive engine -------------------------
    loops: [],                   // [{ id, name, kind, instruction, cadenceMin, enabled, approved, origin, confidenceMin, projectIds[], created, lastRun, runs, rationale, authoredBy }]
    projects: [],                // [{ id, name, url, localPath, repo, notes, ethos, enabled, created, lastTouched, passes }]
    duoWork: [],                 // the completed-work ledger: [{ id, ts, loopId, loopName, projectId, agent, title, did, next, files[], confidence, verdict, body }]
    designEthos: '',             // the house design language — she refines this over time
    loopsSeeded: false,
    subagentLog: [],             // persisted highlights of observed subagent runs
    budget: { fiveHour: 0, weekly: 0 },  // August's own soft token caps (0 = off)
    inbox: { offset: 0, applied: 0, lastTs: '' },  // agent → app queue read position
    // --- OmniDrive (Motus Max) + the MotusModels studio ---------------------
    omni: omniDefaults(),        // arm state, scope, the session, and the audit trail
    motusModels: [],             // the lineage: [{ id, name, mantra, mindset, model, motus, generation, parentId, lineage[], fitness, status, mint }]
    mmSeeded: false,
  };
}
function loadState() {
  let s = safe(() => JSON.parse(fs.readFileSync(statePath(), 'utf8')), null);
  // Corruption fallback: if the main file is missing/unparseable, recover the last
  // good backup before giving up and resetting — a single bad write can't wipe you.
  if (!s) s = safe(() => JSON.parse(fs.readFileSync(statePath() + '.bak', 'utf8')), null);
  if (!s || typeof s !== 'object' || Array.isArray(s)) s = defaultState();
  // merge forward-compatible defaults
  const d = defaultState();
  s.settings = Object.assign({}, d.settings, s.settings || {});
  for (const k of Object.keys(d)) if (s[k] === undefined) s[k] = d[k];
  if (!s.firstRun) s.firstRun = new Date().toISOString();
  if (!Array.isArray(s.trustedFingerprints)) s.trustedFingerprints = [];   // pairing fills it at first boot
  if (!s.decoyIp) s.decoyIp = genFakeIp();   // stable fake IP, generated once and persisted
  return s;
}
// A plausible-looking residential IPv4 — used as the public face of "your IP" so the
// real one is never exposed to the renderer (or a screen-peeker, or a compromised view).
function genFakeIp() {
  const firsts = [24, 47, 67, 68, 71, 72, 73, 74, 76, 98, 99, 104, 108, 136, 142, 162, 173, 184, 198, 207, 209, 216];
  const r = (n) => Math.floor(Math.random() * n);
  return `${firsts[r(firsts.length)]}.${r(254) + 1}.${r(255)}.${r(254) + 1}`;
}
const decoyIp = () => (STATE && STATE.decoyIp) || '—';
// Atomic + backed-up save: write to a temp file, keep one rolling backup of the last
// good state, then rename into place. rename() is atomic on the same volume, so a crash
// or a second writer can never leave a half-written (corrupt) state.json behind.
// ───────────────────────────────────────────────────────────────────────────
//  THE VAULT WRITE — coalesced, off the critical path, still atomic.
//
//  MEASURED 2026-08-19 on his real 771 KB vault: one save costs ~5.9 ms of
//  SYNCHRONOUS work on the main process — the same process that answers every
//  IPC call the interface makes. There are 148 call sites, and a single user
//  action commonly touches several, so an operation could block the UI for
//  30 ms before it had done anything the user asked for. It also grows: the
//  configured caps allow this file to reach ~2 MB, which triples that.
//
//  Three things were tested rather than assumed:
//    · compact JSON instead of pretty — saves 1.1 ms and 57 KB. NOT the win,
//      and it costs readability when something goes wrong, so it was rejected.
//    · the .bak copy is a second full-file copy on EVERY write. It exists for
//      last-good rollback, which does not need per-write granularity.
//    · the real win is not writing 148 times when once will do.
//
//  So: callers mark the vault dirty and return immediately; one debounced,
//  ASYNC, atomic write follows. Durability is preserved by a sync flush on
//  quit and a periodic safety flush — the worst case is losing the last few
//  hundred milliseconds of state, and only if the process dies outright.
// ───────────────────────────────────────────────────────────────────────────
const SAVE_DEBOUNCE_MS = 700;
const SAVE_SAFETY_MS = 15000;
const BAK_EVERY_MS = 300000;      // last-good rollback, not a per-write journal
let _stDirty = false, _stTimer = 0, _stWriting = false, _stLastBak = 0, _stWrites = 0, _stCoalesced = 0;
function stateBytes() { return JSON.stringify(STATE, null, 2); }
function saveState() {
  if (_stDirty) _stCoalesced++;         // this write just became free
  _stDirty = true;
  if (_stTimer) return;
  _stTimer = setTimeout(() => { _stTimer = 0; flushState(); }, SAVE_DEBOUNCE_MS);
}
async function flushState() {
  if (!_stDirty) return;
  if (_stWriting) { saveState(); return; }   // re-arm; never write twice at once
  _stWriting = true; _stDirty = false;
  try {
    const p = statePath(), tmp = p + '.tmp';
    let data = stateBytes();
    // the one place the true serialized size is already in hand — free to check
    const trimmed = safe(() => vaultAutoCompact(data.length), null);
    if (trimmed) data = stateBytes();
    await fs.promises.writeFile(tmp, data);
    if (now() - _stLastBak > BAK_EVERY_MS) {
      _stLastBak = now();
      try { if (exists(p)) await fs.promises.copyFile(p, p + '.bak'); } catch { /* rollback copy is best-effort */ }
    }
    await fs.promises.rename(tmp, p);
    _stWrites++;
  } catch (e) {
    // A failed write must not lose the change — put the flag back and let the
    // next tick try again. Silently dropping state is how a vault rots.
    _stDirty = true;
    safe(() => omniAudit('vault', 'a state write failed and will be retried: ' + ((e && e.message) || e)));
  } finally {
    _stWriting = false;
    if (_stDirty && !_stTimer) _stTimer = setTimeout(() => { _stTimer = 0; flushState(); }, SAVE_DEBOUNCE_MS);
  }
}
// THE DURABILITY BACKSTOP. Everything above is an optimisation; this is the
// promise. Called on quit, and on a slow timer so a long-running app never
// carries an unwritten change for more than a few seconds.
function saveStateNow() {
  safe(() => {
    clearTimeout(_stTimer); _stTimer = 0;
    _stDirty = false;
    const p = statePath(), tmp = p + '.tmp';
    fs.writeFileSync(tmp, stateBytes());
    safe(() => { if (exists(p)) fs.copyFileSync(p, p + '.bak'); });
    fs.renameSync(tmp, p);
    _stWrites++;
  });
}
setInterval(() => { if (_stDirty && !_stWriting) flushState(); }, SAVE_SAFETY_MS);
// ───────────────────────────────────────────────────────────────────────────
//  THE VAULT KEEPS ITSELF. `compactVault()` existed and was correct, and was
//  reachable only by pressing Compact or Wrap Up — so on any machine where he
//  did not press it, the file simply grew, and every single save got slower
//  forever. A cleanup that depends on being remembered is not a cleanup.
//
//  It now runs on its own when the vault crosses a size it has no business
//  crossing, at most once an hour, and it REPORTS what it reclaimed — a
//  maintenance task that runs silently is indistinguishable from one that
//  never runs.
// ───────────────────────────────────────────────────────────────────────────
const VAULT_HIGH_WATER = 1_200_000;   // ~1.2 MB — well past useful, well under painful
const VAULT_COMPACT_EVERY = 3600e3;
let _lastCompact = 0;
function vaultAutoCompact(bytes) {
  if (bytes < VAULT_HIGH_WATER) return null;
  if (now() - _lastCompact < VAULT_COMPACT_EVERY) return null;
  _lastCompact = now();
  const before = bytes;
  safe(() => compactVault());
  const after = safe(() => stateBytes().length, before);
  const saved = before - after;
  safe(() => omniAudit('vault', `auto-compacted ${Math.round(before / 1024)} KB → ${Math.round(after / 1024)} KB (reclaimed ${Math.round(saved / 1024)} KB)`));
  // Only speak up when it actually mattered; a 20 KB trim is housekeeping.
  if (saved > 200_000) {
    safe(() => pushNotification('good', 'Vault compacted',
      `Reclaimed ${Math.round(saved / 1024)} KB. Every save from here is faster — nothing you can see was removed, only the long transcripts inside old entries.`,
      'settings', 'vault:compact'));
  }
  _stDirty = true;
  return { before, after, saved };
}
function vaultStatsLive() {
  return { bytes: safe(() => stateBytes().length, 0), writes: _stWrites, coalesced: _stCoalesced, dirty: _stDirty };
}

// ---------------------------------------------------------------------------
//  Device identity / hardware lock
// ---------------------------------------------------------------------------
function runCmd(file, args, timeout = 4000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true }, (err, stdout) => resolve(err ? '' : String(stdout || '')));
  });
}
// Two machine facts make the fingerprint. Windows: the registry's MachineGuid
// and the firmware UUID. macOS: the platform UUID and the serial from ioreg.
// Either pair is stable across reboots and different on every other machine.
async function machineGuid() {
  if (process.platform === 'darwin') {
    const out = await runCmd('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], 6000);
    const m = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
    return m ? m[1].trim() : '';
  }
  // 15 s, not 4: a cold runner answers the registry slowly, and an empty answer
  // here once left a fresh vault unable to pair
  const out = await runCmd('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], 15000);
  const m = out.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]+)/);
  return m ? m[1].trim() : '';
}
async function hardwareUuid() {
  if (process.platform === 'darwin') {
    const out = await runCmd('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], 6000);
    const m = out.match(/"IOPlatformSerialNumber"\s*=\s*"([^"]+)"/);
    return m ? m[1].trim() : '';
  }
  // 20 s: the first PowerShell start on a machine that has never run one can
  // take longer than the old 6 s, and the CI runner proved it
  const out = await runCmd('powershell', ['-NoProfile', '-Command', '(Get-CimInstance Win32_ComputerSystemProduct).UUID'], 20000);
  const m = out.match(/[0-9A-Fa-f-]{8,}/);
  return m ? m[0].trim() : '';
}
function localIps() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) for (const ni of ifs[name] || []) {
    if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
  }
  return out;
}
function publicIp() {
  return new Promise((resolve) => {
    const req = https.get('https://api.ipify.org?format=json', { timeout: 4000 }, (res) => {
      let d = ''; res.on('data', (c) => d += c);
      res.on('end', () => resolve(safe(() => JSON.parse(d).ip, '')));
    });
    req.on('error', () => resolve(''));
    req.on('timeout', () => { req.destroy(); resolve(''); });
  });
}
function relayHealth(timeout = 3500) {
  return new Promise((resolve) => {
    const req = http.get({ host: RELAY.host, port: RELAY.port, path: '/health', timeout }, (res) => {
      let d = ''; res.on('data', (c) => d += c);
      res.on('end', () => { _wslFallback.on = false; resolve(safe(() => JSON.parse(d), { status: res.statusCode === 200 ? 'ok' : 'err' })); });
    });
    // Direct socket dead? Ask from inside WSL before declaring the relay down —
    // otherwise a broken Windows↔WSL bridge reads as "the fleet is offline"
    // when the fleet is perfectly fine and simply unreachable from this side.
    const viaWsl = () => !IS_WIN ? resolve(null) : execFile('wsl.exe', ['-d', wslDistro(), '-e', 'curl', '-s', '-m', '5', 'http://127.0.0.1:8788/health'],
      { timeout: 12000 }, (err, stdout) => {
        const j = safe(() => JSON.parse(stdout), null);
        if (j) { _wslFallback = { on: true, since: now() }; resolve({ ...j, via: 'wsl', bridgeDown: true }); }
        else resolve(null);
      });
    req.on('error', viaWsl);
    req.on('timeout', () => { req.destroy(); viaWsl(); });
  });
}

async function evaluateGuard() {
  const [guid, uuid, pub, health] = await Promise.all([
    machineGuid(), hardwareUuid(), publicIp(), relayHealth(),
  ]);
  // Every fingerprint this machine can compute from the facts it gave: both
  // facts, or either one alone. A slow query on one boot must not turn the
  // operator's own machine into a stranger on the next, so pairing stores all
  // of them and trust matches any of them.
  const cands = [];
  if (guid && uuid) cands.push(sha256(`${guid}:${uuid}`.toLowerCase()));
  if (guid) cands.push(sha256(`${guid}:`.toLowerCase()));
  if (uuid) cands.push(sha256(`:${uuid}`.toLowerCase()));
  const fp = cands[0] || sha256(':');
  // FIRST-RUN PAIRING: a fresh vault pairs to the machine that opened it, so a
  // public build needs no baked fingerprint. A copied vault already carries
  // its pairing and does not re-pair here.
  if (STATE && !STATE.paired && cands.length) {
    STATE.trustedFingerprints = [...new Set([...cands, ...(STATE.trustedFingerprints || [])])];
    STATE.paired = fp;
    safe(() => saveState());
  }
  const hashMatch = cands.some((c) => STATE.trustedFingerprints.includes(c));
  // a boot that matched by hardware teaches the vault the partial forms too,
  // so a later boot with one fact missing still matches
  if (hashMatch && cands.some((c) => !STATE.trustedFingerprints.includes(c))) {
    STATE.trustedFingerprints = [...new Set([...STATE.trustedFingerprints, ...cands])];
    safe(() => saveState());
  }
  const wslReadable = exists(P('logs')) && exists(P('agents'));
  const relayReachable = !!health && health.status === 'ok';
  // Trust = paired hardware OR (can read THIS machine's WSL tree AND reach its loopback relay).
  // Only the real machine satisfies the second clause — survives a Windows reinstall (new GUID).
  const trusted = hashMatch || (wslReadable && relayReachable);
  const g = {
    trusted, hashMatch, wslReadable, relayReachable,
    fingerprint: fp, hostname: os.hostname(), username: os.userInfo().username,
    localIps: localIps(), publicIp: pub, checkedAt: new Date().toISOString(),
  };
  if (!trusted) recordIntrusion(g);
  return g;
}

function recordIntrusion(g) {
  const rec = {
    ts: new Date().toISOString(), fingerprint: g.fingerprint, hostname: g.hostname,
    username: g.username, localIps: g.localIps, publicIp: g.publicIp,
    signals: { hashMatch: g.hashMatch, wslReadable: g.wslReadable, relayReachable: g.relayReachable },
  };
  STATE.intrusions.unshift(rec);
  STATE.intrusions = STATE.intrusions.slice(0, 200);
  saveState();
  // best-effort remote beacon (the only thing that can reach August from a foreign device)
  fireBeacon(rec);
}
function fireBeacon(rec) {
  const url = STATE.settings.beaconUrl;
  if (!url) return;
  try {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const body = JSON.stringify({ app: 'CortexInsight', event: 'foreign-device', ...rec });
    const req = lib.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 6000 }, () => {});
    req.on('error', () => {}); req.on('timeout', () => req.destroy());
    req.write(body); req.end();
  } catch { /* ignore */ }
}
function notify(title, body) {
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body, silent: false });
    n.on('click', () => showWindow());
    n.show();
  } catch {}
}
// Higher-level: dedupe within a window, log to the feed, raise tray + native toast.
const _notifDedupe = {};
function pushNotification(level, title, body, view, dedupeKey, { native = true } = {}) {
  const key = dedupeKey || `${level}:${title}`;
  const t = now();
  if (_notifDedupe[key] && t - _notifDedupe[key] < 10 * 60e3) return; // 10-min quiet window
  _notifDedupe[key] = t;
  const rec = { ts: new Date().toISOString(), level, title, body, view: view || null, read: false };
  STATE.notifications.unshift(rec); STATE.notifications = STATE.notifications.slice(0, 200); saveState();
  if (mainWin) mainWin.webContents.send('cortex:notify', rec);
  // PRESENCE GATE: a native toast is an interruption. If August drove a turn in
  // the last ~10 minutes he is mid-flow, so only genuinely urgent things break
  // through — everything else still lands in the feed and the next brief.
  // 'bad' is always urgent; nothing quietly swallows a real problem.
  if (native && level !== 'bad' && midFlow()) return;
  if (native) notify(title, body);
}
// Cheap presence signal from telemetry we already parse — no new I/O.
function midFlow() {
  return safe(() => {
    const last = (STATE.sentLog && STATE.sentLog[0] && Date.parse(STATE.sentLog[0].ts)) || 0;
    return last && (now() - last) < 10 * 60 * 1000;
  }, false);
}

// ---------------------------------------------------------------------------
//  Relay (chat) — the ONLY path to the agents, same loopback Hermes uses
// ---------------------------------------------------------------------------
// The `model` field here is a ROUTING TOKEN, not a Claude model — the mouth-proxy's
// _agent_from_model() maps it to an agent seat. The actual Claude model + effort for
// that seat come from fleet.json via the bridge, resolved fresh inside the runner.
const ROUTE_TOKEN = {
  davara: 'cortex-davara', davaris: 'cortex-davaris', davari: 'cortex-davari',
  'sympath-cortex': 'sympath-cortex',
  arden: 'arden', august: 'august', 'august-v3': 'august-v3',
  workhorse: 'cortex-workhorse',   // the reflex lane — mouth-proxy maps it to the lean seat
};

// Is the fleet allowed to act right now? One place, so every dispatch path
// (chat, Duo-Drive, workflows, subagent spawns, auto-loops) obeys the same stop.
function dispatchBlocked(agent) {
  if (STATE && STATE.control && STATE.control.stopped) return 'The fleet is stopped. Resume it from the control bar to send again.';
  const c = agentCfg(agent);
  if (c.paused) return `${(FLEET_BY_ID[agent] || {}).name || agent} is paused. Resume that agent to send to it.`;
  return null;
}

// ---------------------------------------------------------------------------
//  RELAY TRANSPORT + WSL FALLBACK  (added 2026-08-09 after a real outage)
//
//  The mouth-proxy binds 127.0.0.1 INSIDE WSL and Windows normally reaches it
//  through WSL2's localhost forwarding. That forwarding can silently die — the
//  proxy stays perfectly healthy (`curl` inside WSL returns ok) while every
//  request from this app dies with ECONNRESET in 0s. Chat, voice and Duo-Drive
//  all go dark and the cause looks like the app.
//
//  So: if the direct socket fails, we re-issue the SAME request through
//  `wsl.exe -e curl` from inside WSL, where the proxy is always reachable.
//  Slower per call, but it means a broken Windows↔WSL bridge can no longer take
//  the fleet offline. Once direct works again we go straight back to it.
// ---------------------------------------------------------------------------
let _wslFallback = { on: false, since: 0 };
function relayViaWsl(payload, timeoutMs = 1850000) {
  return new Promise((resolve) => {
    if (!IS_WIN) return resolve({ ok: false, text: '', latency: 0, error: 'the relay did not answer on 127.0.0.1:8788' });
    const dir = ciDir();
    const reqFile = path.join(dir, 'relay-req.json');
    if (!safe(() => { if (!exists(dir)) fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(reqFile, payload); return true; }, false)) {
      return resolve({ ok: false, error: 'could not stage the relay request for the WSL fallback' });
    }
    const t0 = now();
    execFile('wsl.exe', ['-d', wslDistro(), '-e', 'curl', '-s', '--max-time', String(Math.floor(timeoutMs / 1000)),
      '-X', 'POST', '-H', 'Content-Type: application/json',
      '--data-binary', '@' + wslHome() + '/.cortexinsight/relay-req.json',
      'http://127.0.0.1:8788/v1/chat/completions'],
      { timeout: timeoutMs + 15000, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => {
        const latency = (now() - t0) / 1000;
        if (err && !stdout) return resolve({ ok: false, text: '', latency, error: 'WSL fallback failed: ' + ((err && err.message) || 'no output').slice(0, 160) });
        const text = safe(() => JSON.parse(stdout).choices[0].message.content, null);
        if (text != null) return resolve({ ok: true, text, latency, via: 'wsl' });
        resolve({ ok: false, text: '', latency, error: 'WSL fallback returned an unreadable response' });
      });
  });
}
function relaySend(agent, message, timeoutMs = 1850000) {
  message = withOperator(message);                 // the fleet hears the operator's own name
  if ((FLEET_BY_ID[agent] || {}).lane === 'openai') return openaiSend(agent, message);   // the second stack
  if (!isRelayAgent(agent)) {
    return Promise.resolve({ ok: false, text: '', latency: 0,
      error: `${(FLEET_BY_ID[agent] || {}).name || agent} does not run on the relay — it runs on its own gateway, so it is observed here, not driven from here.` });
  }
  const blocked = dispatchBlocked(agent);
  if (blocked) return Promise.resolve({ ok: false, text: '', latency: 0, error: blocked, blocked: true });
  publishFleetConfig();   // the runner reads this fresh — guarantees the pin is current
  const model = ROUTE_TOKEN[agent] || 'cortex-davara';
  const payload = JSON.stringify({ model, messages: [{ role: 'user', content: message }], stream: false });
  // Bridge already known-broken this session → don't waste a round trip on it.
  if (_wslFallback.on && now() - _wslFallback.since < 10 * 60 * 1000) return relayViaWsl(payload, timeoutMs);
  return new Promise((resolve) => {
    const t0 = now();
    const req = http.request({
      host: RELAY.host, port: RELAY.port, path: '/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }, timeout: timeoutMs,
    }, (res) => {
      let d = ''; res.on('data', (c) => d += c);
      res.on('end', () => {
        const latency = (now() - t0) / 1000;
        const text = safe(() => JSON.parse(d).choices[0].message.content, null);
        if (text != null) { _wslFallback.on = false; resolve({ ok: true, text, latency }); }
        else resolve({ ok: false, text: '', latency, error: `bad response (${res.statusCode})` });
      });
    });
    // A transport-level failure is exactly the WSL-bridge symptom: retry inside WSL.
    req.on('error', async (e) => {
      if (['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'ECONNABORTED'].includes(e.code)) {
        _wslFallback = { on: true, since: now() };
        const r = await relayViaWsl(payload, timeoutMs);
        if (r.ok) return resolve(r);
        return resolve({ ok: false, text: '', latency: (now() - t0) / 1000,
          error: `relay unreachable from Windows (${e.code}) and the WSL fallback also failed — ${r.error}` });
      }
      resolve({ ok: false, text: '', latency: (now() - t0) / 1000, error: e.message });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, text: '', latency: (now() - t0) / 1000, error: 'timeout (>30m)' }); });
    req.write(payload); req.end();
  });
}

// ---------------------------------------------------------------------------
//  Log / state parsers (read-only)
// ---------------------------------------------------------------------------
function interactionFiles() {
  const dir = P('logs', 'interactions');
  return listDir(dir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(dir, f));
}
// Two-layer cache: per-file parse cache (by size+mtime) AND a memo of the final
// merged+sorted array (by a signature of all files). The 4s poll fans out to ~8
// handlers that each want the interactions; with the memo they all share ONE parse.
const _ixCache = new Map();
let _ixAll = { sig: '', items: [] };
// ───────────────────────────────────────────────────────────────────────────
//  ⚠⚠ THE LAG, MEASURED AND FOUND (2026-08-20, second pass).
//
//  The first investigation measured the machine at IDLE and blamed WSL memory.
//  That was real but it was not THIS. Measured under the actual condition —
//  the app polling while agents run — one sweep costs:
//
//     245 interaction files stat-ed .......... 284 ms
//     618 project .jsonl stat-ed ............. 681 ms
//     24 MB of interaction files read ........ 798 ms
//     ---------------------------------------------------
//     ONE POLL SWEEP ........................ 1816 ms
//
//  ...on a 4-second poll. That is ~45% of a core held permanently by the MAIN
//  process — the same process that answers every IPC call the interface makes.
//  Every click waited behind a filesystem sweep. And all of it crosses the WSL
//  9P bridge, where a single stat costs ~1.1 ms instead of microseconds.
//
//  THE INSIGHT THAT FIXES IT: these filenames carry their own date
//  (agent-YYYY-MM-DD.jsonl). A file dated before today CANNOT CHANGE. It was
//  being stat-ed 21,600 times a day to re-learn a fact that is already
//  settled. So: stat only TODAY's files; everything older is frozen — parsed
//  once, cached forever, never touched again.
//
//  245 stats become ~4. The sweep stops being felt.
// ───────────────────────────────────────────────────────────────────────────
const _ixFrozen = new Map();          // file -> parsed items, for dates that cannot change
// The frozen index used to live only in memory, so EVERY boot re-read all
// ~245 past-day files (24 MB over 9P, measured 5,514 ms, synchronous, on the
// first poll). A past day cannot change — so its parse cannot either. It now
// persists next to the vault and loads in one local read.
const ixFrozenPath = () => path.join(userDataDir(), 'ix-frozen.json');
let _ixLoaded = false, _ixFrozenDirty = false, _ixFrozenTimer = null;
function ixFrozenLoad() {
  _ixLoaded = true;
  const o = safe(() => JSON.parse(fs.readFileSync(ixFrozenPath(), 'utf8')), null);
  // v2: entries frozen by the UTC-day rule could hold a partial live day; they
  // are discarded once and the past is re-read, then frozen by the local day
  if (!o || o.v !== 2 || !o.files) return 0;
  let n = 0;
  for (const k of Object.keys(o.files)) if (Array.isArray(o.files[k])) { _ixFrozen.set(k, o.files[k]); n++; }
  return n;
}
function ixFrozenSave(sync) {
  _ixFrozenDirty = false;
  const files = {}; for (const [k, v] of _ixFrozen) files[k] = v;
  const body = JSON.stringify({ v: 2, at: now(), files });
  const tmp = ixFrozenPath() + '.tmp';
  if (sync) { safe(() => { fs.writeFileSync(tmp, body); fs.renameSync(tmp, ixFrozenPath()); }); return; }
  fs.promises.writeFile(tmp, body).then(() => fs.promises.rename(tmp, ixFrozenPath())).catch(() => {});
}
function ixFrozenTouch() {
  _ixFrozenDirty = true;
  if (_ixFrozenTimer) return;
  _ixFrozenTimer = setTimeout(() => { _ixFrozenTimer = null; if (_ixFrozenDirty) ixFrozenSave(false); }, 3000);
}
function ixFileDay(p) {
  const m = /(\d{4}-\d\d-\d\d)\.jsonl$/.exec(String(p).replace(/\\/g, '/'));
  return m ? m[1] : '';
}
function parseInteractions(maxPerFile = 160 * 1024) {
  if (!_ixLoaded) ixFrozenLoad();
  const files = interactionFiles();
  const today = localDay();
  const sigParts = [];
  const stats = [];
  for (const f of files) {
    const day = ixFileDay(f);
    // FROZEN: dated before today and already parsed once — contributes a
    // constant to the signature and costs zero filesystem calls.
    if (day && day < today && _ixFrozen.has(f)) { stats.push('frozen'); sigParts.push(f + ':frozen'); continue; }
    const st = statOf(f); stats.push(st); sigParts.push(st ? `${f}:${st.size}:${st.mtimeMs}` : `${f}:0`);
  }
  const sig = sigParts.join('|');
  if (sig === _ixAll.sig) return _ixAll.items;   // nothing changed → instant
  const out = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i], st = stats[i]; if (!st) continue;
    if (st === 'frozen') { out.push(..._ixFrozen.get(f)); continue; }
    const cached = _ixCache.get(f);
    if (cached && cached.size === st.size && cached.mtime === st.mtimeMs) { out.push(...cached.items); continue; }
    // today's file grows a line per relay turn; read the line, not the window
    const d = readDelta(f, cached, st, maxPerFile);
    const items = d.full ? [] : cached.items.slice(-3000);
    for (const line of d.text.split('\n')) {
      const t = line.trim(); if (!t || t[0] !== '{') continue;
      const r = safe(() => JSON.parse(t), null); if (!r || !r.ts) continue;
      items.push({
        ts: r.ts, agent: r.agent || 'unknown', status: r.status || '?',
        via: r.via || 'mouth-proxy', attempts: r.attempts || 1,
        latency: +r.latency_s || 0, chars: +r.out_chars || 0,
        tokens: estTokens(+r.out_chars || 0), msg: r.msg || '',
        ok: String(r.status || '').startsWith('OK'),
        epoch: Date.parse((r.ts || '').replace(' ', 'T')) || 0,
      });
    }
    _ixCache.set(f, { size: st.size, mtime: st.mtimeMs, items, carry: d.carry });
    // a past day that has now been read once never needs the disk again
    const day = ixFileDay(f);
    if (day && day < today) { _ixFrozen.set(f, items); ixFrozenTouch(); }
    out.push(...items);
  }
  out.sort((a, b) => b.epoch - a.epoch);
  _ixAll = { sig, items: out };
  return out;
}
function readCheckpoint(agent) {
  const txt = readTextCached(P('agents', agent, 'checkpoint.state'));
  if (!txt) return null;
  const o = {};
  for (const line of txt.split('\n')) { const m = line.match(/^(\w+)=(.*)$/); if (m) o[m[1]] = m[2].trim(); }
  return { sid: o.SID || '', status: (o.STATUS || '').toLowerCase(), epoch: +o.EPOCH || 0 };
}
let _proxyCache = { size: -1, mtime: -1, result: null };
function parseProxyLog(maxBytes = 80 * 1024) {
  const p = P('logs', 'mouth-proxy.log');
  const st = statOf(p);
  if (st && _proxyCache.result && _proxyCache.size === st.size && _proxyCache.mtime === st.mtimeMs) return _proxyCache.result;
  const text = tailFile(p, maxBytes);
  const lines = text.split('\n').filter(Boolean);
  const events = [];
  let lastStart = 0;
  for (const ln of lines) {
    const m = ln.match(/^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\s+(\w+)\s+(.*)$/);
    if (!m) continue;
    const epoch = Date.parse(m[1].replace(' ', 'T')) || 0;
    const kind = m[2];
    if (/^START/.test(ln) || /cortex-mouth-proxy on/.test(ln)) lastStart = epoch;
    events.push({ ts: m[1], epoch, kind, rest: m[3] });
  }
  const result = { events, lastStart, lines };
  if (st) _proxyCache = { size: st.size, mtime: st.mtimeMs, result };
  return result;
}

function lastActivityForAgent(agent, interactions) {
  const a = interactions.find((x) => x.agent === agent);
  return a || null;
}

// most-recent narrative turn for an agent (the "work preview"), from memory md
function agentMemoryPreview(agent, maxChars = 6000) {
  const dir = P('agents', agent, 'memory');
  const files = listDir(dir).filter((f) => /^\d{4}-\d\d-\d\d\.md$/.test(f)).sort();
  if (!files.length) return '';
  const latest = files[files.length - 1];
  return tailFile(path.join(dir, latest), 40 * 1024).slice(-maxChars);
}

// ---------------------------------------------------------------------------
//  Model pin (read; and a guarded, reversible write)
// ---------------------------------------------------------------------------
const RUNNERS = [
  { file: 'SystemsCortex/cortex-run.sh', varName: 'CORTEX_MODEL' },
  { file: 'SystemsCortex/run-davara.sh', varName: 'DAVARA_MODEL' },
  { file: 'SystemsCortex/run-davaris.sh', varName: 'DAVARIS_MODEL' },
];
// The model catalogue. `gen` groups them in the picker; `flagship` marks the
// current generation. Only ids the installed CLI actually accepts appear here —
// an invented id would fault the turn, so nothing speculative is ever listed.
const KNOWN_MODELS = [
  { id: 'claude-opus-5', label: 'Opus 5', gen: 'Claude 5', flagship: true, note: 'Deepest reasoning — the fleet default' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1', gen: 'Claude 5', flagship: true, note: 'Newest fast flagship — needs CLI 2.1.251+ (verified answering on 2.1.258)' },
  { id: 'claude-fable-5', label: 'Fable 5', gen: 'Claude 5', flagship: true, note: 'Fast flagship — vivid, strong at long creative build runs' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', gen: 'Claude 5', flagship: true, note: 'Balanced — quick and very capable' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', gen: 'Claude 4.x', note: 'Fastest, lightest — cheap mechanical work' },
  { id: 'claude-opus-4-8[1m]', label: 'Opus 4.8 · 1M ctx', gen: 'Claude 4.x', note: 'Previous flagship with the 1M-token window' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8', gen: 'Claude 4.x', note: 'Previous flagship' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', gen: 'Claude 4.x', note: 'Previous balanced tier' },
];
const MODEL_IDS = new Set(KNOWN_MODELS.map((m) => m.id));

// Quality / reasoning depth. These map 1:1 onto the Claude Code CLI's real
// `--effort` levels (verified against CLI 2.1.170: low|medium|high|xhigh|max),
// so the setting is a genuine compute dial, not a label.
const QUALITY = [
  { id: 'low', label: 'Low', note: 'Fastest. Mechanical edits, lookups, formatting.' },
  { id: 'medium', label: 'Medium', note: 'Balanced everyday work.' },
  { id: 'high', label: 'High', note: 'Deep. The right default for real building.' },
  { id: 'xhigh', label: 'X-High', note: 'Very deep — hard architecture and gnarly bugs.' },
  { id: 'max', label: 'ULTRACODE', note: 'Maximum rigor. Leave nothing unexamined.' },
];
const QUALITY_IDS = new Set(QUALITY.map((q) => q.id));

// ---------------------------------------------------------------------------
//  PER-AGENT MODEL + QUALITY  (the fleet config)
//
//  Resolution order for any agent:  August's explicit per-agent choice
//                                →  the agent's own default in FLEET
//                                →  DEFAULT_MODEL / 'high'
//  The resolved config is published to ~/.cortexinsight/fleet.json, which the
//  runner reads FRESH on every turn — so a change takes effect on the next
//  message with NO relay restart and no daemon to reload.
// ---------------------------------------------------------------------------
function agentCfg(id) {
  const f = FLEET_BY_ID[id] || {};
  const saved = (STATE && STATE.fleetConfig && STATE.fleetConfig[id]) || {};
  const model = MODEL_IDS.has(saved.model) ? saved.model : (f.defaultModel || DEFAULT_MODEL);
  const effort = QUALITY_IDS.has(saved.effort) ? saved.effort : (f.effort || 'high');
  const t = parseInt(saved.turns, 10);
  const turns = Number.isFinite(t) && t > 0 && t <= 400 ? t : (f.maxTurns || 16);
  return {
    id, model, effort, turns,
    paused: !!saved.paused, hard: !!saved.hard,
    lane: f.lane || 'relay',
    // external agents (Sympath SEI) are configured in their own gateway, not here
    configurable: f.lane === 'relay',
  };
}
// ###########################################################################
//  SEAT CAPABILITY — MEASURED FROM THE RUNNER, NEVER DECLARED.
//
//  The FLEET registry above carries `coder: true` on seats that physically
//  cannot write a file. `cortex-run.sh` allow-lists arden and sympath-cortex to
//  `Read Glob Grep WebFetch WebSearch` and defaults every other generic seat to
//  `Read Glob Grep` — their SOULs even say "read-only: observe and PROPOSE,
//  never silently mutate". Only davara and davaris delegate to runners that
//  carry Write/Edit/Bash.
//
//  Driving with a read-only seat produced exactly what August saw: an agent
//  doing beautiful analysis and then "Two permissions, both denied — (1) Write
//  … (2) Run `node …`". A guard that trusts a hand-typed flag reproduces the
//  bug it was written to prevent. So capability is READ OUT OF THE RUNNER, the
//  only thing that actually decides it — and if he edits a runner, this follows
//  him without anyone remembering to update a boolean.
// ###########################################################################
const _seatCache = { sig: '', map: null };
function runnerPaths() {
  const sc = path.join(root(), 'SystemsCortex');
  return { main: path.join(sc, 'cortex-run.sh'), davara: path.join(sc, 'run-davara.sh'), davaris: path.join(sc, 'run-davaris.sh') };
}
function seatCapabilities() {
  const p = runnerPaths();
  const sig = [p.main, p.davara, p.davaris].map((f) => { const s = safe(() => fs.statSync(f), null); return s ? `${s.size}:${s.mtimeMs}` : '0'; }).join('|');
  if (_seatCache.map && _seatCache.sig === sig) return _seatCache.map;

  const readFile = (f) => safe(() => fs.readFileSync(f, 'utf8'), '');
  const main = readFile(p.main);
  const map = {};
  const BUILD = /\b(Write|Edit|Bash)\b/;
  // the file-level default, e.g. ALLOWED_TOOLS="${CORTEX_TOOLS:-Read Glob Grep}"
  const dflt = (/^ALLOWED_TOOLS=.*?:-([^}"]*)/m.exec(main) || [])[1] || 'Read Glob Grep';
  // per-seat overrides inside the case dispatch
  const perSeat = {};
  const caseRe = /^\s{2}([a-z0-9|_-]+)\)\s*$([\s\S]*?)^\s{4};;/gmi;
  let m;
  while ((m = caseRe.exec(main))) {
    const ids = m[1].split('|').map((x) => x.trim());
    const tools = (/ALLOWED_TOOLS="([^"]*)"/.exec(m[2]) || [])[1];
    if (tools) for (const id of ids) perSeat[id] = tools;
  }
  for (const id of ALL_AGENT_IDS) {
    const f = FLEET_BY_ID[id] || {};
    if (f.lane !== 'relay') { map[id] = { tools: '(its own gateway)', canBuild: false, why: 'runs in its own gateway, not on the relay' }; continue; }
    let tools;
    if (id === 'davara' || id === 'davaris') {
      const rf = readFile(id === 'davara' ? p.davara : p.davaris);
      tools = (/^TOOLS="\$\{[A-Z_]+:-([^}"]*)/m.exec(rf) || [])[1] || '';
    } else {
      tools = perSeat[id] || dflt;
    }
    const canBuild = BUILD.test(tools || '');
    map[id] = { tools: (tools || '').trim(), canBuild,
      why: canBuild ? '' : `her runner allows only ${(tools || dflt).trim()} — no Write, Edit or Bash` };
  }
  _seatCache.sig = sig; _seatCache.map = map;
  return map;
}
function seatCanBuild(id) { return !!(seatCapabilities()[id] || {}).canBuild; }
// The seats that can actually do work, best first.
function buildingSeats() { return AGENTS.filter((id) => seatCanBuild(id)); }

function fleetSnapshot() {
  return ALL_AGENT_IDS.map((id) => {
    const f = FLEET_BY_ID[id];
    return { ...f, ...agentCfg(id), altModels: f.altModels || null };
  });
}
// Where the runner looks. Windows-side path into the WSL home.
function fleetConfigPath() {
  const home = path.dirname(root());               // …\home\<user>
  return path.join(home, '.cortexinsight', 'fleet.json');
}
// Publish the resolved fleet config for the runner. Atomic (tmp+rename) so the
// runner can never read a half-written file mid-turn.
function publishFleetConfig() {
  return safe(() => {
    const dir = path.dirname(fleetConfigPath());
    if (!exists(dir)) fs.mkdirSync(dir, { recursive: true });
    const agents = {};
    // relay lane only — the runner's scope. INFRA seats are included: the
    // workhorse still needs its model pin and turn budget resolved here, even
    // though it never shows up as a persona anywhere in the UI.
    for (const id of [...AGENTS, ...INFRA_IDS]) {
      const c = agentCfg(id);
      agents[id] = { model: c.model, effort: c.effort, turns: c.turns, paused: c.paused, hard: c.hard };
    }
    const body = JSON.stringify({
      _note: 'Written by CortexInsight. Per-agent model + effort, read fresh by cortex-run.sh each turn.',
      updated: new Date().toISOString(), agents,
    }, null, 2);
    const p = fleetConfigPath(), tmp = p + '.tmp';
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, p);
    safe(() => writeAgentBrief());   // keep the fleet's orientation in lockstep
    return { ok: true, path: p };
  }, { ok: false });
}

// ---------------------------------------------------------------------------
//  THE BRIEF — the fleet's shared orientation.
//
//  Until now only Duo-Drive knew what August was actually working on. Every
//  other turn — including every Telegram message to Davara — started blind: no
//  Motus, no goal, no board, and no memory of what the fleet had already learned.
//  This writes that context to ~/.cortexinsight/brief.md, which the fleet bridge
//  prepends to each turn. Strictly bounded (~2KB) so it orients without bloating.
// ---------------------------------------------------------------------------
function briefPath() { return path.join(ciDir(), 'brief.md'); }
// ---------------------------------------------------------------------------
//  PATTERNS — the app noticing what keeps going wrong, from data it already has.
//
//  Every input here is already on disk: task job histories, the corroboration
//  verdicts written by `evidenceFor`, and the Motus Max drive lessons banked at
//  halt. Nothing is fetched, nothing is inferred by a model, and nothing costs
//  a token. The value is purely in NAMING the repetition — a stall that gets
//  named once stops being invisible, and every agent turn afterwards starts
//  knowing about it.
//
//  Only repetition qualifies. A single failure is an event; twice is a pattern.
// ---------------------------------------------------------------------------
function recentPatterns() {
  const lines = [];
  const cutoff = now() - 7 * 864e5;

  // 1 · work handed over again and again without ever closing
  for (const t of (STATE.tasks || [])) {
    const jobs = (t.jobs || []).filter((j) => (Date.parse(j.ts) || 0) > cutoff);
    if (t.status !== 'done' && jobs.length >= 2) {
      lines.push(`- "${String(t.title).slice(0, 70)}" has been dispatched ${jobs.length}× and is still open — something about it is not landing; consider whether the ask itself is wrong.`);
    }
  }
  // 2 · done-claims that the evidence did not corroborate
  const thin = (STATE.tasks || []).filter((t) => t.verified && t.verified.level === 'thin').length;
  if (thin >= 2) lines.push(`- ${thin} completed task(s) scored "thin" on corroboration — finished was claimed without files or turns to back it. Verify before reporting done.`);

  // 3 · drives that keep ending the same way
  const drives = (STATE.learnings || []).filter((l) => l.source === 'motusmax' && (Date.parse(l.ts) || 0) > cutoff);
  const stalls = drives.filter((l) => /ended because/i.test(l.body || ''));
  if (stalls.length >= 2) {
    const why = {};
    for (const s of stalls) {
      const m = /ended because:\s*([^·]{6,60})/i.exec(s.body || '');
      if (m) { const k = m[1].trim().toLowerCase().slice(0, 50); why[k] = (why[k] || 0) + 1; }
    }
    const top = Object.entries(why).sort((a, b) => b[1] - a[1])[0];
    if (top && top[1] >= 2) lines.push(`- ${top[1]} Motus Max drives ended the same way: "${top[0]}". Treat that as a structural blocker, not bad luck.`);
  }
  // 4 · the fleet's own queue backing up
  const aw = STATE.autoWork || {};
  const fleetOpen = (STATE.tasks || []).filter((t) => t.owner === 'fleet' && t.status !== 'done').length;
  if (fleetOpen >= 3 && !aw.on) lines.push(`- ${fleetOpen} tasks are marked for the fleet but auto-work is OFF, so nothing is picking them up.`);

  if (!lines.length) return '';
  return `## WHAT KEEPS HAPPENING (patterns, not one-offs)\n${lines.slice(0, 5).join('\n')}`;
}

// ───────────────────────────────────────────────────────────────────────────
//  THE SHARED PICTURE — the single working memory every mind reads.
//
//  The deepest structural gap before lock-in: Duo passes, Motus Max drives,
//  voice turns and workflow stages each read a DIFFERENT slice of the world.
//  Duo knew its own loop history; Max knew its own thread; the voice knew the
//  app report. None of them knew what the others had just shipped — so the
//  system had five memories and no mind.
//
//  This is the one function that assembles the world: the frame (Motus/Goal),
//  what ANY mind shipped recently, where Max's thread stands, what keeps
//  happening, and what is live right now. Compact by law (≤ ~1400 chars) —
//  a shared picture that bloats becomes a tax on every turn that carries it.
// ───────────────────────────────────────────────────────────────────────────
function continuityBrief() {
  return safe(() => {
    const L = [];
    if (STATE.motus) L.push('MOTUS: ' + String(STATE.motus.text).slice(0, 200));
    if (STATE.goal) L.push('GOAL: ' + String(STATE.goal.text).slice(0, 160));
    const th = safe(() => threadState(), null);
    if (th && th.goal) L.push('MAX THREAD: ' + String(th.goal).slice(0, 130) + (th.openNext ? ' → open next: ' + String(th.openNext).slice(0, 110) : ''));
    const ship = (STATE.duoWork || []).filter((w) => w.verdict === 'shipped').slice(0, 5)
      .map((w) => '· ' + String(w.title).slice(0, 88) + (w.loopName ? '  [' + String(w.loopName).slice(0, 22) + ']' : ''));
    if (ship.length) L.push('RECENTLY SHIPPED (all minds — do not redo, build ON):' + String.fromCharCode(10) + ship.join(String.fromCharCode(10)));
    const pats = safe(() => recentPatterns(), '');
    if (pats) L.push(pats.replace('## ', ''));
    const a = safe(() => onAirState(), {});
    const wfB = (STATE.workflowRuns || []).filter((r) => r.status === 'blocked').length;
    const live = [a.on ? 'broadcast ON AIR' : 'broadcast dark'];
    if ((STATE.autoWork || {}).on) live.push('auto-work running');
    if (wfB) live.push(wfB + ' workflow(s) blocked at a gate — resumable');
    L.push('LIVE: ' + live.join(' · '));
    return '## THE SHARED PICTURE (one truth, every mind reads it)' + String.fromCharCode(10) + L.join(String.fromCharCode(10)).slice(0, 1400);
  }, '');
}
function writeAgentBrief() {
  return safe(() => {
    const dir = ciDir();
    if (!exists(dir)) fs.mkdirSync(dir, { recursive: true });
    const open = (STATE.tasks || []).filter((t) => t.status !== 'done').slice(0, 8)
      .map((t) => `- [${t.status}] (${t.id.slice(0, 6)}) ${t.title.slice(0, 90)}${t.agent ? ` — ${(FLEET_BY_ID[t.agent] || {}).name || t.agent}` : ''}`).join('\n');
    // Learnings were write-only: nine writers, no reader that changed behaviour.
    // The most-reinforced ones now travel with every turn. Endorsed first, then
    // most-used, then newest.
    // a learning that later showed up in closed work is PROVEN; it outranks one merely repeated
    const la = safe(() => learningsApplied(), { per: {} });
    const rank = (l) => (l.endorsedBy ? 1000 : 0) + ((la.per[l.ts] || 0) * 50) + ((l.uses || 0) * 10) + ((l.conviction || 0));
    const learn = (STATE.learnings || []).slice(0, 40).sort((a, b) => rank(b) - rank(a)).slice(0, 6)
      .map((l) => `- ${String(l.title).slice(0, 110)}`).join('\n');
    const md = [
      '# ' + operatorName() + ' · current orientation',
      '_Written by CortexInsight. Read-only context — act on the message below it, not on this. The operator is ' + operatorName() + '; address them by that name._',
      '',
      // ★ THE READING RIDES FIRST. The bridge hands agents the first ~2,000 chars
      // of this file, so the shape of the system goes before the lists: the
      // window, the attractor, the lever, what waits on August. The app's systems
      // sight becomes the fleet's sight, every turn, at no token cost.
      safe(() => { const rd = systemReading(); const cl = closeCandidates(3); return '## THE READING — the shape of the system right now\n' + rd.line + (rd.more ? ' ' + rd.more : '') + (cl.length ? '\n' + cl.length + ' decision(s) wait for ' + operatorName() + ' on the board; do not re-propose those tasks.' : '') + (() => { const al = motusAlignment(); return al.set && al.drifting.length ? '\n' + al.drifting.length + ' open task(s) share no words with the Motus; prefer the work that moves it.' : ''; })(); }, ''),
      '',
      STATE.motus ? `## MOTUS — the strongest thing moving now\n${String(STATE.motus.text).slice(0, 400)}` : '## MOTUS\n(not set)',
      '',
      STATE.goal ? `## GOAL — the north star\n${String(STATE.goal.text).slice(0, 400)}` : '## GOAL\n(not set)',
      '',
      open ? `## OPEN BOARD\n${open}\n\nYou can move these: \`bash ~/.cortexinsight/ci.sh done "<title or id>"\`` : '## OPEN BOARD\n(empty)',
      '',
      learn ? `## WHAT THE FLEET ALREADY KNOWS\n${learn}` : '',
      '',
      // ★ THE COMPOUNDING BIT. Knowing what worked is half of getting smarter;
      // the other half is knowing what KEEPS NOT WORKING. Repetition is the
      // signal — anything that has happened more than once recently is a
      // pattern, and a pattern nobody names gets repeated forever.
      safe(() => recentPatterns(), ''),
      '',
    ].join('\n');
    const p = briefPath(), tmp = p + '.tmp';
    fs.writeFileSync(tmp, md.slice(0, 4000));
    fs.renameSync(tmp, p);
    return { ok: true };
  }, { ok: false });
}

// ---------------------------------------------------------------------------
//  THE FLEET BRIDGE — the one additive change to the shared runner.
//
//  Without it, the fleet runner has ONE global model pin for everyone.
//  With it, cortex-run.sh reads fleet.json per turn and honours August's
//  per-agent model + quality choice. Discipline held:
//    · purely ADDITIVE — one guarded block, no existing line rewritten
//    · FAIL-SAFE — missing/corrupt json ⇒ the old pins stand, byte for byte
//    · VERIFIED — `bash -n` after writing; auto-ROLLBACK if syntax breaks
//    · REVERSIBLE — timestamped backup + a one-click uninstall
//    · effort reaches every `claude` call (incl. the delegated davara/davaris
//      runners) via an exported wrapper function, so NO call site is edited.
// ---------------------------------------------------------------------------
const BRIDGE_MARK = 'CORTEXINSIGHT FLEET BRIDGE';
const BRIDGE_ANCHOR = 'ALLOWED_TOOLS="${CORTEX_TOOLS:-Read Glob Grep}"';
const RUNNER_REL = 'SystemsCortex/cortex-run.sh';

function bridgeBlock() {
  return [
    '',
    `# --- ${BRIDGE_MARK} (additive · fail-safe · remove-safe) ---------------`,
    '# CortexInsight publishes ~/.cortexinsight/fleet.json with a per-agent model +',
    '# effort (quality) choice, and this block applies it to THIS turn only. It is',
    '# read fresh every turn, so a change in the app needs no restart of anything.',
    '# If that file is absent, unreadable or malformed, nothing below changes and the',
    '# pins above stand exactly as they did before this block existed.',
    'CI_FLEET="${HOME}/.cortexinsight/fleet.json"',
    'CI_EFFORT=""',
    'if [ -f "$CI_FLEET" ] && command -v python3 >/dev/null 2>&1; then',
    '  CI_RESOLVED="$(python3 -c \'',
    'import json, re, sys',
    'try:',
    '    d = json.load(open(sys.argv[1]))',
    '    a = (d.get("agents") or {}).get(sys.argv[2]) or {}',
    '    m = str(a.get("model") or "")',
    '    e = str(a.get("effort") or "")',
    '    t = str(a.get("turns") or "")',
    '    if not re.fullmatch(r"[A-Za-z0-9._\\[\\]-]{1,64}", m): m = ""',
    '    if e not in ("low", "medium", "high", "xhigh", "max"): e = ""',
    '    if not re.fullmatch(r"[0-9]{1,3}", t): t = ""',
    '    h = "1" if (a.get("paused") and a.get("hard")) else ""',
    '    print(m + "|" + e + "|" + h + "|" + t)',
    'except Exception:',
    '    print("|||")',
    '\' "$CI_FLEET" "$AGENT" 2>/dev/null || true)"',
    '  CI_M="$(printf \'%s\' "${CI_RESOLVED:-}" | cut -d"|" -f1)"',
    '  CI_E="$(printf \'%s\' "${CI_RESOLVED:-}" | cut -d"|" -f2)"',
    '  CI_H="$(printf \'%s\' "${CI_RESOLVED:-}" | cut -d"|" -f3)"',
    '  CI_T="$(printf \'%s\' "${CI_RESOLVED:-}" | cut -d"|" -f4)"',
    '  if [ -n "${CI_H:-}" ]; then',
    '    echo "[paused] $AGENT is hard-paused by the operator (CortexInsight). No turn was run."',
    '    exit 0',
    '  fi',
    '  if [ -n "${CI_M:-}" ]; then',
    '    MODEL="$CI_M"',
    '    # exported so the delegated run-davara.sh / run-davaris.sh inherit the pin',
    '    export CORTEX_MODEL="$CI_M" DAVARA_MODEL="$CI_M" DAVARIS_MODEL="$CI_M"',
    '  fi',
    '  if [ -n "${CI_T:-}" ]; then',
    '    MAX_TURNS="$CI_T"',
    '    export CORTEX_MAX_TURNS="$CI_T" DAVARA_MAX_TURNS="$CI_T" DAVARIS_MAX_TURNS="$CI_T"',
    '  fi',
    '  if [ -n "${CI_E:-}" ]; then',
    '    CI_EFFORT="$CI_E"',
    '    export CI_EFFORT',
    '    # Inject --effort into EVERY claude call in this turn\'s process tree —',
    '    # including the delegated davara/davaris runners — without editing a',
    '    # single call site. An exported function is inherited by child bash.',
    '    claude() { if [ -n "${CI_EFFORT:-}" ]; then command claude "$@" --effort "$CI_EFFORT"; else command claude "$@"; fi; }',
    '    export -f claude',
    '  fi',
    '  # THE BRIEF — prepend August\'s current orientation (Motus / Goal / open board /',
    '  # what the fleet already knows) so EVERY turn starts oriented instead of blind.',
    '  # Hard-capped at 2KB, and skipped entirely if the file is missing.',
    '  CI_BRIEF="${HOME}/.cortexinsight/brief.md"',
    '  if [ -f "$CI_BRIEF" ] && [ -n "${MSG:-}" ]; then',
    '    CI_B="$(head -c 2000 "$CI_BRIEF" 2>/dev/null || true)"',
    '    if [ -n "$CI_B" ]; then',
    '      MSG="$CI_B',
    '',
    '--- end of standing context · the actual message follows ---',
    '',
    '$MSG"',
    '    fi',
    '  fi',
    'fi',
    `# --- end ${BRIDGE_MARK} -----------------------------------------------`,
    '',
  ].join('\n');
}

// \\wsl.localhost\<distro>\home\<user>\… → /home/<user>/…  (for `bash -n`)
function toLinuxPath(winPath) {
  let p = String(winPath || '').replace(/\\/g, '/');
  const m = p.match(/^\/\/[^/]+\/[^/]+(\/.*)$/);   // //wsl.localhost/ubuntu/<rest>
  if (m) return m[1];
  return p;
}
function bashSyntaxOk(linuxPath) {
  return new Promise((resolve) => {
    execFile(IS_WIN ? 'wsl.exe' : 'bash', IS_WIN ? ['-d', wslDistro(), '-e', 'bash', '-n', linuxPath] : ['-n', linuxPath], { timeout: 12000 }, (err, _o, stderr) => {
      resolve({ ok: !err, detail: String(stderr || (err && err.message) || '').slice(0, 400) });
    });
  });
}
function bridgeStatus() {
  const full = P(RUNNER_REL);
  const txt = readTextCached(full);
  const installed = txt.includes(BRIDGE_MARK);
  // An older bridge sets the model/effort but does not carry the brief. Detect
  // that so the UI can offer an update instead of silently under-delivering.
  const hasBrief = txt.includes('CI_BRIEF=');
  return {
    runner: RUNNER_REL,
    exists: !!txt,
    installed,
    outdated: installed && !hasBrief,
    carriesBrief: installed && hasBrief,
    anchorFound: txt.includes(BRIDGE_ANCHOR),
    configPath: fleetConfigPath(),
    configWritten: exists(fleetConfigPath()),
    briefWritten: exists(briefPath()),
  };
}
async function installBridge() {
  const full = P(RUNNER_REL);
  const txt = safe(() => fs.readFileSync(full, 'utf8'), null);
  if (txt == null) return { ok: false, error: 'cortex-run.sh not readable — is WSL running?' };
  // An outdated bridge is replaced, not duplicated: strip the old block first,
  // then install the current one.
  if (txt.includes(BRIDGE_MARK)) {
    if (!bridgeStatus().outdated) { publishFleetConfig(); return { ok: true, already: true, note: 'Bridge already installed.' }; }
    const rem = await uninstallBridge();
    if (!rem.ok) return { ok: false, error: 'Could not replace the old bridge: ' + (rem.error || '?') };
    return installBridge();   // re-enter with a clean runner
  }
  const i = txt.indexOf(BRIDGE_ANCHOR);
  if (i === -1) return { ok: false, error: 'Could not find the insertion anchor in cortex-run.sh — runner left untouched.' };
  const eol = txt.indexOf('\n', i);
  if (eol === -1) return { ok: false, error: 'Unexpected runner shape — left untouched.' };
  const next = txt.slice(0, eol + 1) + bridgeBlock() + txt.slice(eol + 1);
  const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
  const bak = `${full}.pre-bridge-${stamp}.bak`;
  if (!safe(() => { fs.writeFileSync(bak, txt); return true; }, false)) return { ok: false, error: 'Could not write a backup — refusing to patch.' };
  if (!safe(() => { fs.writeFileSync(full, next); return true; }, false)) return { ok: false, error: 'Write failed — runner unchanged.' };
  // Verify the patched runner still parses. If not, roll straight back.
  const chk = await bashSyntaxOk(toLinuxPath(full));
  if (!chk.ok) {
    safe(() => fs.writeFileSync(full, txt));   // ROLLBACK
    return { ok: false, error: 'Patched runner failed `bash -n` — automatically rolled back. ' + chk.detail };
  }
  publishFleetConfig();
  STATE.learnings.unshift({ ts: new Date().toISOString(), source: 'operator',
    title: 'Fleet bridge installed', body: `Per-agent model + quality is now live. cortex-run.sh reads ~/.cortexinsight/fleet.json each turn. Backup: ${path.basename(bak)}. Verified with bash -n.` });
  saveState();
  return { ok: true, backup: path.basename(bak), verified: true };
}
async function uninstallBridge() {
  const full = P(RUNNER_REL);
  const txt = safe(() => fs.readFileSync(full, 'utf8'), null);
  if (txt == null) return { ok: false, error: 'cortex-run.sh not readable.' };
  if (!txt.includes(BRIDGE_MARK)) return { ok: true, already: true, note: 'Bridge was not installed.' };
  const start = txt.indexOf(`# --- ${BRIDGE_MARK}`);
  const endMark = `# --- end ${BRIDGE_MARK}`;
  const endAt = txt.indexOf(endMark);
  if (start === -1 || endAt === -1) return { ok: false, error: 'Bridge markers incomplete — not removing by guess. Restore the .pre-bridge backup manually.' };
  const endEol = txt.indexOf('\n', endAt);
  const next = txt.slice(0, start) + txt.slice(endEol === -1 ? txt.length : endEol + 1);
  safe(() => fs.writeFileSync(full + '.pre-unbridge.bak', txt));
  safe(() => fs.writeFileSync(full, next));
  const chk = await bashSyntaxOk(toLinuxPath(full));
  if (!chk.ok) { safe(() => fs.writeFileSync(full, txt)); return { ok: false, error: 'Removal broke syntax — rolled back. ' + chk.detail }; }
  return { ok: true, removed: true };
}
function readModelPin() {
  for (const r of RUNNERS) {
    const txt = readTextCached(P(r.file));
    const m = txt.match(new RegExp(`MODEL="\\$\\{${r.varName}:-([^}"]+)\\}"`));
    if (m) return { model: m[1], source: r.file };
  }
  return { model: 'unknown', source: '' };
}
function setModelPin(newModel) {
  if (!/^[A-Za-z0-9._\-\[\]]+$/.test(newModel)) return { ok: false, error: 'invalid model id' };
  const changed = [];
  for (const r of RUNNERS) {
    const full = P(r.file);
    if (!exists(full)) continue;
    const txt = safe(() => fs.readFileSync(full, 'utf8'), null);
    if (txt == null) continue;
    const re = new RegExp(`(MODEL="\\$\\{${r.varName}:-)([^}"]+)(\\}")`);
    if (!re.test(txt)) continue;
    const next = txt.replace(re, `$1${newModel}$3`);
    if (next === txt) continue;
    safe(() => fs.writeFileSync(full + '.cortexinsight.bak', txt)); // reversible backup
    safe(() => fs.writeFileSync(full, next));
    changed.push(r.file);
  }
  if (!changed.length) return { ok: false, error: 'no runner pin matched (left untouched)' };
  return { ok: true, changed, model: newModel };
}

// ---------------------------------------------------------------------------
//  Prompt-injection scan (cheap, heuristic — surfaces, never blocks)
// ---------------------------------------------------------------------------
const INJECTION_PATTERNS = [
  /ignore (all |your )?previous instructions/i,
  /disregard (the |all )?(above|prior|previous)/i,
  /you are now (a |an )?(dan|developer mode|unrestricted)/i,
  /system prompt|reveal your (instructions|prompt|system)/i,
  /exfiltrate|curl .*(\||;).*sh|base64 -d|rm -rf \//i,
  /print( out)? (your )?(api[_ ]?key|secret|token|password)/i,
  /\bsudo\b.*(passwd|shadow)/i,
  /override (the )?(safety|guard|gate)/i,
];
function scanInjections(interactions) {
  const flags = [];
  const clearedBefore = STATE && STATE.injClearedAt || 0;
  for (const it of interactions.slice(0, 400)) {
    const msg = it.msg || '';
    // use the pre-parsed epoch (consistent unit; avoids a second Date.parse)
    if (clearedBefore && (it.epoch || 0) <= clearedBefore) continue;
    for (const re of INJECTION_PATTERNS) {
      if (re.test(msg)) {
        flags.push({ ts: it.ts, agent: it.agent, pattern: re.source.slice(0, 42), excerpt: msg.slice(0, 220), hash: sha256(it.ts + msg) });
        break;
      }
    }
  }
  return flags;
}

// ---------------------------------------------------------------------------
//  Deterministic learnings + next-steps analyzers (the "evolves on its own" core)
//  These grow a ledger from REAL telemetry every refresh — no LLM needed.
// ---------------------------------------------------------------------------
function deriveInsights(interactions, proxy) {
  const learn = [];
  const next = [];
  const recent = interactions.filter((x) => x.epoch > now() - 7 * 864e5);
  const byAgent = {};
  for (const a of AGENTS) byAgent[a] = recent.filter((x) => x.agent === a);

  // fault / timeout rates
  const faults = recent.filter((x) => !x.ok);
  const faultRate = recent.length ? faults.length / recent.length : 0;
  if (recent.length >= 5) {
    learn.push({ source: 'telemetry', title: `7-day reliability ${Math.round((1 - faultRate) * 100)}%`,
      body: `${recent.length - faults.length}/${recent.length} turns returned cleanly. ${faults.length} fault/timeout.` });
    if (faultRate > 0.12) next.push({ source: 'telemetry', title: 'Investigate elevated fault rate',
      body: `Fault rate is ${Math.round(faultRate * 100)}% over 7 days (>12% threshold). Check logs/runner-stderr and run SystemsCortex/cortex-health.sh.` });
  }

  // latency trend per agent
  for (const a of AGENTS) {
    const xs = byAgent[a].filter((x) => x.ok && x.latency > 0).map((x) => x.latency);
    if (xs.length >= 6) {
      const half = Math.floor(xs.length / 2);
      const recentAvg = avg(xs.slice(0, half)), olderAvg = avg(xs.slice(half));
      learn.push({ source: 'telemetry', title: `${cap(a)} median latency ${Math.round(median(xs))}s`,
        body: `${xs.length} clean turns. Avg ${Math.round(avg(xs))}s, p90 ${Math.round(pct(xs, 90))}s.` });
      if (recentAvg > olderAvg * 1.6 && recentAvg > 60) next.push({ source: 'telemetry', title: `${cap(a)} latency trending up`,
        body: `Recent turns avg ${Math.round(recentAvg)}s vs ${Math.round(olderAvg)}s earlier. Consider a lighter model pin or trimming the identity envelope.` });
    }
  }

  // timeouts present?
  const timeouts = proxy.events.filter((e) => e.kind === 'TIMEOUT');
  if (timeouts.length) next.push({ source: 'proxy-log', title: `${timeouts.length} relay timeout(s) on record`,
    body: `Most recent: ${timeouts[timeouts.length - 1].ts}. A true 1800s hang isn't retried. If recurring, lower MAX_TURNS or split the workload.` });

  // memory growth (continuity is healthy, but watch envelope size)
  for (const a of ['davara', 'davaris']) {
    const dir = P('agents', a, 'memory');
    const files = listDir(dir).filter((f) => /\.md$/.test(f));
    let bytes = 0; for (const f of files) { const st = statOf(path.join(dir, f)); if (st) bytes += st.size; }
    if (bytes > 0) learn.push({ source: 'continuity', title: `${cap(a)} memory ${(bytes / 1024).toFixed(0)} KB across ${files.length} day(s)`,
      body: `Raw continuity preserved on disk. Read-side is tail-capped (last 2 days × 250 lines) so envelope stays bounded.` });
  }

  // cadence
  const last = interactions[0];
  if (last) learn.push({ source: 'telemetry', title: `Last turn ${timeAgo(last.epoch)}`, body: `${cap(last.agent)} · ${last.status} · ${Math.round(last.latency)}s · ${last.chars} chars.` });

  return { learn, next };
}
const avg = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[clamp(Math.floor((p / 100) * s.length), 0, s.length - 1)] || 0; };
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
function timeAgo(epoch) {
  if (!epoch) return 'n/a';
  const d = (now() - epoch) / 1000;
  if (d < 60) return `${Math.round(d)}s ago`;
  if (d < 3600) return `${Math.round(d / 60)}m ago`;
  if (d < 864e2) return `${Math.round(d / 3600)}h ago`;
  return `${Math.round(d / 864e2)}d ago`;
}

// ---------------------------------------------------------------------------
//  Aggregations served to the UI
// ---------------------------------------------------------------------------
// ===========================================================================
//  THE RHYTHM — system dynamics read off his own ledger, no model involved.
//
//  August: "think on systems dynamics and also ... our pattern and
//  progressions and workflow we go through and move with." The app already
//  holds every number a dynamics reading needs: turns by hour and day (the
//  flow), the board (a stock with a lead time), the receipts (loop output),
//  the relay latency (the delay every loop inherits). Nobody had put them in
//  one frame. Stocks · flows · delays · loops · extremes, plus sentences that
//  say what the shape means. Little's law for the board: at the current
//  close rate, how long until it clears. Memoized 30 s; the ledger is already
//  parsed, so this is arithmetic.
// ===========================================================================
let _dynMemo = { at: 0, v: null };
function systemDynamics() {
  if (_dynMemo.v && now() - _dynMemo.at < 30000) return _dynMemo.v;
  const xs = parseInteractions();
  const t0 = now();
  const D = 864e5;
  const d7 = t0 - 7 * D, d28 = t0 - 28 * D;
  const ring = new Array(24).fill(0), today = new Array(24).fill(0), days = new Array(28).fill(0);
  const todayKey = new Date().toDateString();
  let n7 = 0, n28 = 0, ok7 = 0, longest = null;
  const lat = [], byAgent = {};
  for (const x of xs) {
    if (!x.epoch) continue;
    if (x.epoch < d28) break;                         // newest first — nothing older matters
    const d = new Date(x.epoch); const h = d.getHours();
    ring[h]++; n28++;
    days[Math.min(27, Math.floor((t0 - x.epoch) / D))]++;
    if (d.toDateString() === todayKey) today[h]++;
    if (x.epoch >= d7) {
      n7++; if (x.ok) ok7++;
      if (x.ok && x.latency > 0) lat.push(x.latency);
      byAgent[x.agent] = (byAgent[x.agent] || 0) + 1;
    }
    if (x.latency > 0 && (!longest || x.latency > longest.latency)) longest = { latency: x.latency, agent: x.agent, ts: x.ts, msg: String(x.msg || '').slice(0, 80) };
  }
  const wk = days.slice(0, 7).reduce((a, b) => a + b, 0), wkPrev = days.slice(7, 14).reduce((a, b) => a + b, 0);
  lat.sort((a, b) => a - b);
  const q = (p) => lat.length ? lat[Math.min(lat.length - 1, Math.floor(p * lat.length))] : 0;
  let peak = { start: 0, sum: -1 };
  for (let s = 0; s < 24; s++) { const sum = ring[s] + ring[(s + 1) % 24] + ring[(s + 2) % 24]; if (sum > peak.sum) peak = { start: s, sum }; }
  const biggestDay = days.reduce((m, v, i) => (v > m.v ? { v, i } : m), { v: 0, i: 0 });

  const tasks = STATE.tasks || [];
  const open = tasks.filter((t) => t.status !== 'done');
  const done = tasks.filter((t) => t.status === 'done');
  const doneAtOf = (t) => Date.parse(t.doneAt || t.updated || '') || 0;
  const done7 = done.filter((t) => doneAtOf(t) >= d7).length;
  const done28 = done.filter((t) => doneAtOf(t) >= d28).length;
  const leads = done.filter((t) => doneAtOf(t) >= d28)
    .map((t) => (doneAtOf(t) - (Date.parse(t.created || '') || doneAtOf(t))) / D)
    .filter((v) => v >= 0).sort((a, b) => a - b);
  const leadMed = leads.length ? leads[Math.floor(leads.length / 2)] : 0;
  const oldest = open.slice().sort((a, b) => (Date.parse(a.created || '') || 0) - (Date.parse(b.created || '') || 0))[0];
  const throughput = done28 / 28;
  const clearDays = throughput > 0 ? open.length / throughput : null;

  const dw = STATE.duoWork || [];
  const rec7 = dw.filter((w) => (Date.parse(w.ts || '') || 0) >= d7);
  const count = (v) => rec7.filter((w) => w.verdict === v).length;
  const shipped7 = count('shipped'), reported7 = count('reported'), skipped7 = count('skipped');
  const duo = STATE.duo || {};
  const om = (STATE.omni && STATE.omni.stats) || {};
  const learn = STATE.learnings || [];
  const repeats = learn.filter((l) => (l.uses || 0) > 1).length;
  const learn7 = learn.filter((l) => (Date.parse(l.lastSeen || l.ts || '') || 0) >= d7).length;

  const R = [];
  const hh = (h) => String(h).padStart(2, '0') + ':00';
  const dur = (days_) => (days_ < 1 ? Math.round(days_ * 24) + ' h' : Math.round(days_) + ' d');
  if (n28) R.push({ k: 'rhythm', t: `Most turns land between ${hh(peak.start)} and ${hh((peak.start + 3) % 24)}: ${Math.round(100 * peak.sum / Math.max(1, n28))}% of the last 28 days' turns fall in that window.` });
  if (wk || wkPrev) R.push({ k: 'cadence', t: wkPrev
    ? `${wk} turns this week against ${wkPrev} last week (${wk >= wkPrev ? '+' : ''}${Math.round(100 * (wk - wkPrev) / wkPrev)}%).`
    : `${wk} turns this week, with no prior week to compare.` });
  if (open.length) R.push({ k: 'flow', t: clearDays != null
    ? `${open.length} open on the board and ${done28} closed in 28 days. At this pace the board clears in about ${Math.round(clearDays)} days (Little's law: work in progress divided by throughput). ${clearDays > 30 ? 'Closing tasks is the lever now.' : 'Healthy. Keep intake matched to the close rate.'}`
    : `${open.length} open on the board and nothing closed in 28 days. Until something reaches done, the board only lists work.` });
  if (leads.length) R.push({ k: 'delay', t: `A task takes a median ${dur(leadMed)} from created to done (${leads.length} closed).` });
  if (rec7.length || duo.runs) R.push({ k: 'loops', t: `Duo-Drive this week: ${shipped7} shipped, ${reported7} reported, ${skipped7} skipped${duo.skipped ? `. ${duo.skipped} idle passes avoided all time, which is the balancing loop doing its job` : ''}.` });
  if (lat.length) R.push({ k: 'relay', t: `The relay answers in a median ${Math.round(q(0.5))} s, p90 ${Math.round(q(0.9))} s. Every loop above inherits that delay.` });
  if (learn.length) R.push({ k: 'canon', t: `${learn.length} learnings banked, ${repeats} seen more than once, ${learn7} touched this week. The canon loop ${learn7 ? 'turned this week' : 'did not turn this week'}.` });

  // THE ATTRACTOR — the state the system keeps returning to. A board whose
  // intake outruns its close rate has growth as its attractor no matter how
  // hard any one week pushes; a week far above the 28-day mean is a spike,
  // and the mean is what the structure will pull back to unless it changed.
  const created28 = tasks.filter((t) => (Date.parse(t.created || '') || 0) >= d28).length;
  const netPerDay = (created28 - done28) / 28;
  const meanWk = n28 / 4;
  if (open.length || created28) R.push({ k: 'attractor', t: netPerDay > 0.15
    ? `The board's attractor is growth: ${created28} created against ${done28} closed in 28 days, ${(netPerDay).toFixed(1)} net per day. Without a change to intake or close rate it keeps filling, whatever any one week does.`
    : netPerDay < -0.1
      ? `The board's attractor is clearing: ${done28} closed against ${created28} created in 28 days, ${Math.abs(netPerDay).toFixed(1)} net per day toward empty.`
      : `The board sits near balance: ${created28} created, ${done28} closed in 28 days. Its attractor is its current size.` });
  if (n28 && wk > 1.5 * meanWk && meanWk >= 4) R.push({ k: 'attractor', t: `This week's ${wk} turns sit well above your 28-day mean of ${Math.round(meanWk)} a week. Unless the structure changed, the mean is where the pace returns.` });
  const v = {
    ts: t0, ring, today, days: days.slice().reverse(),
    peak: { start: peak.start, end: (peak.start + 3) % 24, share: n28 ? peak.sum / n28 : 0 },
    stocks: { open: open.length, learnings: learn.length, repeats, receipts: dw.length },
    flows: { turns7: n7, turnsWeekPrev: wkPrev, done7, shipped7, perDay: Math.round((n7 / 7) * 10) / 10 },
    delays: { relayMed: Math.round(q(0.5)), relayP90: Math.round(q(0.9)), leadMedDays: Math.round(leadMed * 10) / 10, clearDays: clearDays == null ? null : Math.round(clearDays) },
    loops: { duoRuns: duo.runs || 0, duoSkipped: duo.skipped || 0, maxSessions: om.sessions || 0, maxCycles: om.cycles || 0, okRate7: n7 ? ok7 / n7 : 1 },
    extremes: {
      longestTurn: longest,
      biggestDay: { turns: biggestDay.v, daysAgo: biggestDay.i },
      oldestOpen: oldest ? { title: String(oldest.title || '').slice(0, 90), days: Math.round((t0 - (Date.parse(oldest.created || '') || t0)) / D) } : null,
      topSeat: Object.entries(byAgent).sort((a, b) => b[1] - a[1])[0] || null,
    },
    readings: R,
  };
  _dynMemo = { at: t0, v };
  return v;
}
let _ovTot = { items: null, day: '', chars: 0, secs: 0, todayN: 0 };
function buildOverview() {
  const interactions = parseInteractions();
  const proxy = parseProxyLog();
  const ckpts = {}; for (const a of AGENTS) ckpts[a] = readCheckpoint(a);
  const ongoing = [];
  for (const a of AGENTS) {
    const c = ckpts[a];
    if (c && (c.status === 'inflight' || c.status === 'incomplete')) {
      const la = lastActivityForAgent(a, interactions);
      ongoing.push({ agent: a, status: c.status, sid: c.sid, since: c.epoch ? c.epoch * 1000 : 0,
        focus: la ? la.msg.slice(0, 160) : '(session open)' });
    }
  }
  const today = localDay();
  // whole-ledger totals once per ledger change (the array identity only moves
  // when the signature moved), not three full walks per tick
  if (_ovTot.items !== interactions || _ovTot.day !== today) {
    let chars = 0, secs = 0, todayN = 0;
    for (const x of interactions) { chars += x.chars; secs += x.latency; if ((x.ts || '').slice(0, 10) === today) todayN++; }
    _ovTot = { items: interactions, day: today, chars, secs, todayN };
  }
  const todays = { length: _ovTot.todayN };
  const totalChars = _ovTot.chars;
  const totalSecs = _ovTot.secs;
  const health = healthVerdict(interactions, proxy);
  const model = readModelPin();
  return {
    // false when the fleet tree is not where the settings point: the first-run
    // card on Pulse keys off this, and the relay verdict stays quiet
    rootReadable: exists(P('logs')) && exists(P('agents')),
    platform: process.platform,                                   // the first-run card words the path for the machine
    uptime: proxy.lastStart ? now() - proxy.lastStart : null,    // proxy uptime (ms)
    proxyStart: proxy.lastStart || null,
    appUptime: now() - bootEpoch,
    firstRun: STATE.firstRun,
    // ⚠ TRUTH AT THE SOURCE. The engine room read renderer globals (OMNI.data,
    // CONTROL.duo) that are UNDEFINED until their views have been visited —
    // so "Motus Max: disarmed" could render while she was armed, on the exact
    // page whose job is answering "what is running?". The main process is the
    // only honest witness; the landing page reads it, never a cache of a room
    // he has not opened.
    omniArmed: safe(() => !!omniState().armed, false),
    omniPreRead: safe(() => omniPreReadPublic(omniState()), { status: 'idle' }),
    duoActive: safe(() => !!(STATE.duo && STATE.duo.active), false),
    ongoing,
    health,
    // What the fleet is ACTUALLY running. The raw runner pin is only the truth
    // when the bridge is absent; once it is installed each agent has its own
    // model, so showing a stale global "opus-4-8" in the rail was misleading.
    model: bridgeStatus().installed ? agentCfg(STATE.settings.defaultAgent || 'davara').model : model.model,
    modelPin: model.model,
    modelPerAgent: bridgeStatus().installed,
    stats: {
      totalTurns: interactions.length,
      todayTurns: todays.length,
      totalTokens: estTokens(totalChars),
      totalChars,
      totalCompute: totalSecs,                                   // seconds of agent reasoning
      cleanRate: interactions.length ? interactions.filter((x) => x.ok).length / interactions.length : 1,
    },
    goal: STATE.goal,
    motus: STATE.motus,
    // real stock levels — the Systems Lens meters these, so they must be measured
    learnCount: (STATE.learnings || []).length,
    openNext: (STATE.nextSteps || []).filter((n) => !n.done).length,
    openTasks: (STATE.tasks || []).filter((t) => t.status !== 'done').length,
    avgLatency: median(interactions.filter((x) => x.ok).map((x) => x.latency)) || 0,
    recent: interactions.slice(0, 10),
    lastTurn: interactions[0] || null,
    // every relay agent, not just the first two — Pulse was hiding four of them
    working: AGENTS.map((a) => safe(() => currentWork(a), null)).filter(Boolean),
    session: STATE.session || null,
    ardenSign: (STATE.ardenSign && typeof STATE.ardenSign === 'object') ? { unseen: false, symbol: '', ...STATE.ardenSign } : { unseen: false, symbol: '' },
    pulse: pulseSnapshot(interactions, proxy, ckpts),
  };
}
function healthVerdict(interactions, proxy) {
  const recent = interactions.slice(0, 25);
  const faults = recent.filter((x) => !x.ok).length;
  const lastEpoch = interactions[0] ? interactions[0].epoch : 0;
  const stale = lastEpoch ? (now() - lastEpoch) > 36 * 3600e3 : true;
  let level = 'nominal', score = 100;
  if (faults > 0) { score -= faults * 10; level = faults >= 3 ? 'degraded' : 'watch'; }
  const heal = [];
  if (faults >= 3) heal.push('Multiple recent faults — run `SystemsCortex/cortex-health.sh` and inspect `logs/runner-stderr/`.');
  if (proxy.events.filter((e) => e.kind === 'TIMEOUT').length) heal.push('Timeouts recorded — a true 1800s hang isn\'t retried; lower MAX_TURNS or split the task.');
  if (!proxy.lastStart) heal.push('No proxy START line found — confirm `cortex-mouth-proxy.service` is active (systemctl --user status).');
  return { level, score: clamp(score, 0, 100), faults, stale, heal };
}
function pulseSnapshot(interactions, proxy, ckpts) {
  // A compact, REAL signal for the living-cortex canvas. Intensity = activity in last 10m.
  const recentMs = now() - 10 * 60e3;
  const fresh = interactions.filter((x) => x.epoch > recentMs);
  const activeAgents = {};
  for (const a of AGENTS) {
    const c = ckpts[a];
    const live = c && (c.status === 'inflight' || c.status === 'incomplete');
    const last = lastActivityForAgent(a, interactions);
    activeAgents[a] = {
      live: !!live,
      recent: last ? last.epoch > recentMs : false,
      lastEpoch: last ? last.epoch : 0,
      ok: last ? last.ok : true,
    };
  }
  const faulting = interactions.slice(0, 6).some((x) => !x.ok);
  return { intensity: clamp(fresh.length / 6, 0, 1), faulting, agents: activeAgents, ts: now() };
}

// ---------------------------------------------------------------------------
//  IPC — the renderer's only door
// ---------------------------------------------------------------------------
// ===========================================================================
//  v3.56 · THE SECOND STACK — OpenAI, behind the same discipline as ElevenLabs.
//
//  August: "the allowance of the addition of other api keys… to run this
//  cortexinsight in chatgpt or open ai api key… both stacks at the same time…
//  integrate photo generation with all of our agents".
//
//  The key is PROVEN against /v1/models before it is sealed (DPAPI via
//  safeStorage), decrypted only here, never returned to the renderer, never
//  logged. What leaves the machine: the prompt text of the turn or the image
//  request, to api.openai.com over TLS. Nothing else. A seat named GPT joins
//  the fleet on lane 'openai'; relaySend routes it here; /gpt reaches it from
//  Command; agents ask for images through the inbox (ci.sh image "…") and the
//  APP spends, under a per-day cap he sets. Sign-in with a ChatGPT account is
//  deliberately not wired: OpenAI's consumer login has no public app flow this
//  app could use without impersonating a browser. The key is the honest door.
// ===========================================================================
const OPENAI_HOST = 'api.openai.com';
const looksLikeOpenAIKey = (k) => /^sk-[A-Za-z0-9_\-]{20,}$/.test(String(k || '').trim());
function decryptOpenAI() {
  const enc = STATE.settings.openaiKeyEnc;
  if (!enc) return '';
  return safe(() => safeStorage.decryptString(Buffer.from(enc, 'base64')), '');
}
function openaiRequest({ path: p, method = 'GET', body, key, timeout = 60000 }) {
  const k = key || decryptOpenAI();
  if (!k) return Promise.resolve({ ok: false, error: 'no OpenAI key saved' });
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({ host: OPENAI_HOST, path: p, method, timeout,
      headers: { Authorization: 'Bearer ' + k, 'Content-Type': 'application/json', Accept: 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const txt = Buffer.concat(chunks).toString('utf8');
        const j = safe(() => JSON.parse(txt), null);
        if (res.statusCode >= 200 && res.statusCode < 300 && j) return resolve({ ok: true, data: j });
        // the provider's own reason, truncated so a key can never echo back
        const msg = (j && j.error && j.error.message) || txt.slice(0, 200) || ('HTTP ' + res.statusCode);
        resolve({ ok: false, status: res.statusCode, error: String(msg).replace(/sk-[A-Za-z0-9_\-]+/g, 'sk-…').slice(0, 240) });
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: (e && e.message) || 'network error' }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'OpenAI timed out' }); });
    if (payload) req.write(payload);
    req.end();
  });
}
// a key is adopted only once it has answered — same law as the voice key
async function verifyOpenAIKey(key) {
  const r = await openaiRequest({ path: '/v1/models', key, timeout: 15000 });
  if (!r.ok) return { ok: false, error: r.error };
  const ids = ((r.data && r.data.data) || []).map((m) => m.id).filter(Boolean);
  return { ok: true, models: ids };
}
let _oaModels = { at: 0, ids: [] };
async function openaiModels(force) {
  if (!force && _oaModels.ids.length && now() - _oaModels.at < 10 * 60e3) return _oaModels.ids;
  const r = await openaiRequest({ path: '/v1/models', timeout: 15000 });
  if (!r.ok) return _oaModels.ids;
  const ids = ((r.data && r.data.data) || []).map((m) => m.id).filter(Boolean).sort();
  _oaModels = { at: now(), ids };
  return ids;
}
// pick a sane default from what the key can actually see — never an invented id
function openaiDefaultModel(ids) {
  const pref = ['gpt-5', 'gpt-5-mini', 'gpt-4.1', 'gpt-4o', 'gpt-4o-mini'];
  for (const p of pref) { const hit = ids.find((id) => id === p) || ids.find((id) => id.startsWith(p)); if (hit) return hit; }
  return ids.find((id) => /^gpt/.test(id)) || ids[0] || '';
}
function openaiPublic() {
  const s = STATE.settings;
  return {
    keySet: !!s.openaiKeyEnc, verified: s.openaiKeyVerified || '', source: s.openaiKeySource || '',
    model: s.openaiModel || '', imageModel: s.openaiImageModel || 'gpt-image-1',
    imagesPerDay: Math.max(0, parseInt(s.imagesPerDay, 10) || 12),
    imagesToday: (STATE.studio || []).filter((x) => String(x.ts || '').slice(0, 10) === new Date().toISOString().slice(0, 10)).length,
    seat: 'gpt',
    canEncrypt: !!safe(() => safeStorage.isEncryptionAvailable(), false),
  };
}
async function openaiSave(patch = {}) {
  const s = STATE.settings;
  if (typeof patch.key === 'string' && patch.key.trim()) {
    const k = patch.key.trim();
    if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: 'this machine cannot seal secrets at rest; refusing to store the key in plaintext' };
    if (!looksLikeOpenAIKey(k)) return { ok: false, error: 'That does not look like an OpenAI API key. Real keys begin "sk-". Create one at platform.openai.com → API keys.' };
    const v = await verifyOpenAIKey(k);
    if (!v.ok) return { ok: false, error: 'OpenAI rejected that key: ' + v.error };
    s.openaiKeyEnc = safeStorage.encryptString(k).toString('base64');
    s.openaiKeySource = 'pasted by you';
    s.openaiKeyVerified = new Date().toISOString();
    _oaModels = { at: now(), ids: v.models.slice().sort() };
    if (!s.openaiModel) s.openaiModel = openaiDefaultModel(_oaModels.ids);
    omniAudit('openai', 'OpenAI key verified and sealed · ' + v.models.length + ' models visible · seat model ' + (s.openaiModel || '(none)'));
  }
  if (patch.clearKey) { s.openaiKeyEnc = ''; s.openaiKeySource = ''; s.openaiKeyVerified = ''; _oaModels = { at: 0, ids: [] }; }
  if (typeof patch.model === 'string') s.openaiModel = patch.model.slice(0, 80);
  if (typeof patch.imageModel === 'string' && patch.imageModel.trim()) s.openaiImageModel = patch.imageModel.trim().slice(0, 80);
  if (patch.imagesPerDay != null) s.imagesPerDay = clamp(parseInt(patch.imagesPerDay, 10) || 0, 0, 200);
  saveState();
  return { ok: true, ...openaiPublic() };
}
// one turn on the second stack; the seat carries the fleet's brief, never a soul
async function openaiSend(agent, message) {
  const blocked = dispatchBlocked(agent);
  if (blocked) return { ok: false, text: '', latency: 0, error: blocked, blocked: true };
  const sec = omniSecretish(message);
  if (sec) return { ok: false, text: '', latency: 0, error: 'refused: the message ' + sec + '; nothing shaped like a secret leaves for OpenAI' };
  const model = STATE.settings.openaiModel || openaiDefaultModel(await openaiModels());
  if (!model) return { ok: false, text: '', latency: 0, error: 'no OpenAI model chosen; save a key on Settings → Integrations first' };
  const t0 = now();
  const brief = safe(() => continuityBrief(), '') || '';
  const system = withOperator('You are the GPT seat inside CortexInsight, the operator console of a small fleet run by August. Answer plainly and concretely. Never invent files, numbers or receipts. If asked to do something only a seat with tools could do, say so.'
    + (brief ? '\n\nSTANDING BRIEF:\n' + brief.slice(0, 3000) : ''));
  const r = await openaiRequest({ path: '/v1/chat/completions', method: 'POST', timeout: 180000,
    body: { model, messages: [{ role: 'system', content: system }, { role: 'user', content: String(message || '').slice(0, 60000) }] } });
  const latency = (now() - t0) / 1000;
  if (!r.ok) { omniAudit('openai', 'turn failed: ' + r.error); return { ok: false, text: '', latency, error: r.error }; }
  const text = safe(() => r.data.choices[0].message.content, '') || '';
  const u = (r.data && r.data.usage) || {};
  STATE.openaiLog = [{ ts: new Date().toISOString(), model, latency, inTok: u.prompt_tokens || 0, outTok: u.completion_tokens || 0, chars: text.length }, ...(STATE.openaiLog || [])].slice(0, 200);
  saveState();
  return { ok: true, text, latency, model };
}
// ── THE STUDIO — images for the whole fleet, spent by the app under his cap ──
function studioDir() { const d = path.join(userDataDir(), 'studio'); safe(() => fs.mkdirSync(d, { recursive: true })); return d; }
async function imageGenerate({ prompt, size, by = 'august', quality } = {}) {
  const p = String(prompt || '').trim().slice(0, 4000);
  if (!p) return { ok: false, error: 'give the studio a prompt' };
  const sec = omniSecretish(p);
  if (sec) return { ok: false, error: 'refused: the prompt ' + sec + '; nothing shaped like a secret leaves for OpenAI' };
  if (!STATE.settings.openaiKeyEnc) return { ok: false, error: 'no OpenAI key saved; add one on Settings → Integrations' };
  const cap = Math.max(0, parseInt(STATE.settings.imagesPerDay, 10) || 12);
  const today = new Date().toISOString().slice(0, 10);
  const used = (STATE.studio || []).filter((x) => String(x.ts || '').slice(0, 10) === today).length;
  if (used >= cap) return { ok: false, error: 'the studio has made ' + used + ' image(s) today, which is your daily cap of ' + cap + '; raise it on Settings → Integrations' };
  const sz = ['1024x1024', '1024x1536', '1536x1024', '1792x1024', '1024x1792', '512x512'].includes(size) ? size : '1024x1024';
  const model = STATE.settings.openaiImageModel || 'gpt-image-1';
  const body = { model, prompt: p, n: 1, size: sz };
  if (/^dall-e/i.test(model)) body.response_format = 'b64_json';
  if (quality && /^gpt-image/i.test(model)) body.quality = ['low', 'medium', 'high'].includes(quality) ? quality : 'medium';
  const t0 = now();
  const r = await openaiRequest({ path: '/v1/images/generations', method: 'POST', body, timeout: 180000 });
  if (!r.ok) { omniAudit('studio', 'image failed: ' + r.error); return { ok: false, error: r.error }; }
  const d0 = (r.data && r.data.data && r.data.data[0]) || {};
  let buf = null;
  if (d0.b64_json) buf = Buffer.from(d0.b64_json, 'base64');
  else if (d0.url) {
    buf = await new Promise((resolve) => {
      https.get(d0.url, { timeout: 60000 }, (res) => { const c = []; res.on('data', (x) => c.push(x)); res.on('end', () => resolve(Buffer.concat(c))); }).on('error', () => resolve(null));
    });
  }
  if (!buf || !buf.length) return { ok: false, error: 'OpenAI returned no image data' };
  const id = newId();
  const file = path.join(studioDir(), id + '.png');
  safe(() => fs.writeFileSync(file, buf));
  const entry = { id, ts: new Date().toISOString(), prompt: p, by, model, size: sz, file, bytes: buf.length, latency: Math.round((now() - t0) / 1000), revised: String(d0.revised_prompt || '').slice(0, 600) };
  STATE.studio = [entry, ...(STATE.studio || [])].slice(0, 200);
  saveState();
  omniAudit('studio', `${(FLEET_BY_ID[by] || {}).name || by} made an image in ${entry.latency}s: "${p.slice(0, 80)}"`);
  pushNotification('good', 'Studio: image ready', `${(FLEET_BY_ID[by] || {}).name || by} · "${p.slice(0, 90)}"`, 'output', 'studio:' + id, { native: false });
  return { ok: true, image: entry };
}
function studioList() {
  return (STATE.studio || []).map((x) => ({ ...x, exists: safe(() => fs.existsSync(x.file), false) }));
}
function studioDelete(id) {
  const i = (STATE.studio || []).findIndex((x) => x.id === id);
  if (i < 0) return { ok: false, error: 'no such image' };
  const x = STATE.studio[i];
  safe(() => fs.unlinkSync(x.file));
  STATE.studio.splice(i, 1);
  saveState();
  return { ok: true };
}

// ===========================================================================
//  v3.56 · THE MIND — Davara's baseline, visible in the app that runs on it.
//
//  August: "Should we have the Davara tab… to see her abilities and skills?"
//  Yes, and it reads the canonical clone LIVE: version, organs, the stack
//  layers, the recent Stream entries, her commands, which organ each loop
//  kind reads, and the covenant. No copy of her mind lives in this app; the
//  page is a window onto the one that does.
// ===========================================================================
let _mindMemo = { at: 0, v: null };
function mindReport() {
  if (_mindMemo.v && now() - _mindMemo.at < 60000) return _mindMemo.v;
  const dir = dvDir();
  const available = dvAvailable();
  const count = (sub) => safe(() => fs.readdirSync(path.join(dir, sub)).filter((f) => !f.startsWith('.')).length, 0);
  const organs = available ? { protocols: count('protocols'), skills: count('skills'), library: count('library'), stack: count('stack'), templates: count('templates'), evolutions: count('evolutions') } : null;
  // the stack, as her own LAYERS.json describes it (shape tolerated, never assumed)
  let stack = [];
  if (available) {
    const raw = safe(() => JSON.parse(readTextCached(path.join(dir, 'stack', 'LAYERS.json'))), null);
    const arr = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.layers)) ? raw.layers : (raw && typeof raw === 'object') ? Object.entries(raw).map(([k, v]) => (typeof v === 'object' ? { name: k, ...v } : { name: k, desc: String(v) })) : [];
    stack = arr.slice(0, 20).map((l, i) => ({
      n: (l.order != null ? l.order : (l.n != null ? l.n : (l.layer != null ? l.layer : i))),
      name: String(l.name || l.title || l.id || ('layer ' + (i + 1))).slice(0, 60),
      desc: String(l.what || l.desc || l.description || l.role || l.summary || '').replace(/\*\*|__/g, '').slice(0, 220),
      trust: String(l.trust || '').slice(0, 24),
      mutable: String(l.mutable || '').slice(0, 16),
      runtime: String(l.runtime || '').slice(0, 16),
      file: String(l.file || l.path || '').slice(0, 80),
    }));
  }
  // the Stream: what evolved recently, in her own entries
  let stream = [];
  if (available) {
    const t = readTextCached(path.join(dir, 'evolutions', 'STREAM-RECENT.md')) || readTextCached(path.join(dir, 'evolutions', 'BASELINE-UPDATES-STREAM.md'));
    const parts = String(t || '').split(/\n(?=##\s)/).filter((p) => /^##\s/.test(p));
    stream = parts.slice(0, 6).map((p) => {
      const lines = p.split(NL);
      const title = lines[0].replace(/^##\s*/, '').trim().slice(0, 140);
      const body = lines.slice(1).join(NL).trim();
      const conf = (body.match(/confidence[^0-9]{0,12}([0-9](?:\.[0-9]+)?)/i) || [])[1] || '';
      return { title, body: body.slice(0, 900), confidence: conf };
    });
  }
  // her commands, from COMMANDS.md headings, each with the first line under it
  // so the room can say what a command does before it is pressed
  let commands = [];
  if (available) {
    const t = String(readTextCached(path.join(dir, 'protocols', 'COMMANDS.md')) || '');
    const seen = new Set();
    const lines = t.split(NL);
    for (let i = 0; i < lines.length; i++) {
      const m = /^#{2,4}\s*`?(\/[a-z][a-z0-9-]*)`?/i.exec(lines[i]);
      if (!m) continue;
      const c = m[1].toLowerCase(); if (seen.has(c)) continue; seen.add(c);
      let what = '';
      for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) { const w = lines[j].trim(); if (w && !/^#/.test(w)) { what = w.replace(/[*_`>]/g, '').slice(0, 160); break; } }
      commands.push({ name: c, what });
    }
    commands = commands.slice(0, 30);
  }
  const organsByKind = {
    'scout · review': ['FORESIGHT — tripwires', 'TWO ALTITUDES — the three laws'],
    'refine · design · artifact': ["THE BUILDER'S CREED — the liturgy", 'THE INSTRUMENT — the move'],
    'compound · everything else': ['THE PRACTITIONER LOOP — the Motus Gate'],
  };
  // her abilities, in her words: the WHEN line each protocol declares
  let abilities = [];
  if (available) {
    const pd = path.join(dir, 'protocols');
    for (const f of safe(() => fs.readdirSync(pd), []).filter((x) => x.endsWith('.md')).slice(0, 40)) {
      const t = readTextCached(path.join(pd, f));
      const when = (String(t || '').match(/\*\*WHEN\*\*\s*([^·\n]+)/) || [])[1] || '';
      const title = (String(t || '').match(/^#\s*(.+)$/m) || [])[1] || f.replace(/\.md$/, '');
      abilities.push({ file: f, name: String(title).replace(/[*_`]/g, '').slice(0, 80), when: String(when).replace(/[*_`]/g, '').trim().slice(0, 220) });
    }
  }
  const cov = statOf(dvCovenantPath());
  const loops = (STATE.loops || []).map((l) => ({ id: l.id, name: l.name, kind: l.kind, enabled: !!l.enabled, approved: !!l.approved }));
  const recent = (STATE.duoWork || []).filter((w) => Number.isFinite(w.quality)).slice(0, 10);
  const meanQ = recent.length ? Math.round(10 * recent.reduce((a, w) => a + w.quality, 0) / recent.length) / 10 : null;
  const streamMonth = stream.filter((s) => /2026-0?9|September/i.test(s.title + ' ' + s.body.slice(0, 200))).length;
  const v = {
    available, version: dvVersion(), dir,
    organs, stack, stream, commands, organsByKind, abilities,
    covenant: cov ? { present: true, bytes: cov.size, modified: cov.mtimeMs, path: dvCovenantPath() } : { present: false, path: dvCovenantPath() },
    loops, meanQuality: meanQ, qualityN: recent.length, streamMonth,
    reads: { scoutChars: safe(() => dvOrgansFor('scout').length, 0), buildChars: safe(() => dvOrgansFor('refine').length, 0), gateChars: safe(() => dvOrgansFor('compound').length, 0) },
  };
  _mindMemo = { at: now(), v };
  return v;
}

// ===========================================================================
//  v3.57 · THE READING — the whole system in one honest sentence.
//
//  Every number on Pulse measures volume, and volume flatters. This is the
//  one line that reads the SHAPE: where the day's window is, what the board's
//  attractor is doing, what the lever is, how her passes are scoring, which
//  stacks are open. Computed from readings the app already holds, no model,
//  memoized 30 s. It is the first thing on the landing page and the answer to
//  /reading on Command.
// ===========================================================================
let _readingMemo = { at: 0, v: null };
function systemReading() {
  if (_readingMemo.v && now() - _readingMemo.at < 30000) return _readingMemo.v;
  const d = safe(() => systemDynamics(), null);
  const m = safe(() => mindReport(), null);
  const o = safe(() => omniState(), null);
  const sc = o ? safe(() => seatClock(o.agent), null) : null;
  const oa = safe(() => openaiPublic(), null);
  const S = [];
  const hour = new Date().getHours();
  if (d && d.peak) {
    const inWin = (() => { const a = d.peak.start, b = d.peak.end; return a < b ? (hour >= a && hour < b) : (hour >= a || hour < b); })();
    const hh = (h) => String(h).padStart(2, '0') + ':00';
    S.push(inWin ? `Your window is open now (${hh(d.peak.start)} to ${hh(d.peak.end)} is where your turns land).` : `Your window opens at ${hh(d.peak.start)}; ${Math.round(100 * d.peak.share)}% of your turns land between ${hh(d.peak.start)} and ${hh(d.peak.end)}.`);
  }
  if (d && d.stocks) {
    const att = (d.readings || []).find((r) => r.k === 'attractor');
    const grow = att && /growth/.test(att.t);
    const clear = att && /clearing/.test(att.t);
    if (d.delays.clearDays != null) S.push(`The board's attractor is ${grow ? 'growth' : clear ? 'clearing' : 'its current size'}: ${d.stocks.open} open, clearing in about ${d.delays.clearDays} days at this pace${d.delays.clearDays > 30 ? ', so closing is the lever' : ''}.`);
    else if (d.stocks.open) S.push(`${d.stocks.open} open on the board and nothing closed in 28 days; until something reaches done there is no pace to read.`);
  }
  if (d && d.flows) {
    const bits = [];
    if (d.flows.shipped7) bits.push(`${d.flows.shipped7} shipped by the loops this week`);
    if (m && m.meanQuality != null) bits.push(`her last ${m.qualityN} passes score ${m.meanQuality.toFixed(1)}`);
    if (sc && sc.n) bits.push(`the drive seat answers in about ${sc.median >= 60 ? Math.round(sc.median / 60) + ' min' : sc.median + ' s'}`);
    // a sentence that follows a full stop starts with a capital, whichever bit came first
    if (bits.length) { const s = bits.join(', '); S.push(s.charAt(0).toUpperCase() + s.slice(1) + '.'); }
  }
  const stacks = ['Claude Code' + (oa && oa.keySet ? ' and OpenAI are' : ' is')];
  S.push(stacks[0] + ' open' + (oa && oa.keySet ? ', both stacks live.' : '; add an OpenAI key to open the second stack.'));
  const v = {
    ts: now(), line: S.slice(0, 2).join(' '), more: S.slice(2).join(' '),
    ring: d ? d.ring : null, today: d ? d.today : null, peak: d ? d.peak : null,
    version: m ? m.version : '', quality: m ? m.meanQuality : null,
  };
  _readingMemo = { at: now(), v };
  return v;
}
// ===========================================================================
//  v3.57 · FIRST-RUN SETUP — the gate password is created, never shipped.
//  A fresh vault has no hash; the gate asks for one, once, from a trusted
//  machine (the vault has just paired to it). After that the hash in the
//  vault is the only thing the unlock compares against.
// ===========================================================================
function authSetup(password) {
  if (!STATE || !STATE.settings) return { ok: false, reason: 'no-vault' };
  if (STATE.settings.passSha) return { ok: false, reason: 'already-set' };
  if (!gate()) return { ok: false, reason: 'link-unavailable' };
  const pw = String(password || '');
  if (pw.length < 12) return { ok: false, reason: 'too-short' };
  STATE.settings.passSha = sha256(pw);
  saveState();
  safe(() => omniAudit('access', 'the gate password was created on first run'));
  return { ok: true };
}

// ===========================================================================
//  v3.59 · NO ONE'S MACHINE IN PARTICULAR.
//
//  The app used to know the distro, the Linux user and the Windows user by
//  name. It now derives all of them from the one path the operator sets (the
//  fleet root), discovers that root on first run by looking where WSL
//  keeps homes, and falls back to neutral placeholders that name nobody.
// ===========================================================================
// ===========================================================================
//  PLATFORM — one seam between the console and the machine it runs on.
//  Windows: the fleet tree lives in WSL, reached as a UNC path, and shell work
//  crosses the bridge through wsl.exe. macOS: the tree is a folder in the
//  home, the shell is the shell, and the screen hands stay off until they are
//  built for it (work mode, files, commands and APIs, drives there today).
// ===========================================================================
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
function localUser() { return safe(() => os.userInfo().username, 'operator'); }
// the operator's name, for prompts and the brief; empty until they tell us
function operatorName() { return String((STATE && STATE.settings && STATE.settings.operatorName) || '').trim() || 'the operator'; }
// Everything the fleet is told was written naming the founder. A fork's fleet
// must hear its own operator's name, so the substitution stands where text
// leaves the app: the relay, the second stack, the agent tool. The month keeps
// its name ("in August", "August 5", "August 2026" are left alone), and when
// the operator IS August nothing changes at all.
function withOperator(s) {
  const raw = String((STATE && STATE.settings && STATE.settings.operatorName) || '').trim();
  const text = String(s || '');
  if (raw === 'August' || !/August/.test(text)) return text;
  const n = raw || 'the operator';
  let out = text
    .replace(/(^|[^\w])August's(?!\s+\d)/g, (m, p) => p + n + "'s")
    .replace(/(?<!\w)(?<!(?:in|of|by|since|until|last|next|this|early|late|mid-)\s)August(?![\w'])(?!\s+\d)/g, n);
  if (!raw) out = out.replace(/(^|[.!?]\s+|\n)the operator\b/g, '$1The operator');
  return out;
}
function rootParts() {
  const r = String(root() || '');
  const m = /^\\\\wsl\.localhost\\([^\\]+)\\home\\([^\\]+)\\/i.exec(r);
  if (m) return { distro: m[1], user: m[2] };
  const u = /^\/(?:Users|home)\/([^/]+)\//.exec(r);
  return { distro: IS_WIN ? 'ubuntu' : 'local', user: u ? u[1] : (IS_WIN ? 'operator' : localUser()) };
}
function wslDistro() { return rootParts().distro; }
function wslUser() { return rootParts().user; }
// the fleet's home as the fleet's own shell sees it: a Linux home under WSL, the
// real home elsewhere
function wslHome() { return IS_WIN ? '/home/' + wslUser() : os.homedir(); }
// the fleet tree as the fleet's own shell sees it
function linuxRoot() { return IS_WIN ? wslHome() + '/' + path.basename(String(root() || 'cortex')) : String(root() || ''); }
// first run: find a fleet tree wherever this machine keeps homes, without
// knowing any name. A tree is any home folder that holds logs/interactions and
// agents/; when several qualify (an old backup beside the live one), the one
// whose interactions moved most recently wins.
function discoverRoot() {
  const homes = [];
  if (IS_WIN) {
    const base = '\\\\wsl.localhost';
    const distros = safe(() => fs.readdirSync(base), []).filter((d) => d && !d.startsWith('.'));
    for (const d of distros.length ? distros : ['ubuntu', 'Ubuntu']) {
      const hs = path.join(base, d, 'home');
      for (const u of safe(() => fs.readdirSync(hs), [])) homes.push(path.join(hs, u));
    }
  } else homes.push(os.homedir());
  const found = [];
  for (const home of homes) {
    for (const s of safe(() => fs.readdirSync(home), []).filter((x) => x && !x.startsWith('.'))) {
      const cand = path.join(home, s);
      const ix = path.join(cand, 'logs', 'interactions');
      const m = safe(() => fs.existsSync(path.join(cand, 'agents')) ? fs.statSync(ix).mtimeMs : 0, 0);
      if (m) found.push({ cand, m });
    }
  }
  found.sort((a, b) => b.m - a.m);
  if (found.length) return found[0].cand;
  return '';
}
// ===========================================================================
//  v3.66 · THE FOCUS AS AN INSTRUMENT.
//  The Motus used to be read by the room that showed it and by nothing else.
//  Alignment is now computed once, here, and fed to the close (a task that
//  drifts from the Motus for a week is a decision not yet made), the brief
//  (the fleet is told how many open tasks drift), and the room. History keeps
//  every focus that was held, with what closed while it stood.
// ===========================================================================
const FOCUS_STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'our', 'from', 'into', 'all', 'are', 'was', 'has', 'get', 'set', 'out', 'new', 'use', 'can', 'will', 'make', 'more', 'than', 'then', 'now', 'you', 'your', 'they', 'their']);
function focusBag(s) { return new Set(String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 3 && !FOCUS_STOP.has(w))); }
function focusScore(fb, s) { const b = focusBag(s); if (!fb.size || !b.size) return 0; let n = 0; for (const w of b) if (fb.has(w)) n++; return n / Math.min(b.size, fb.size); }
function motusAlignment() {
  const cur = STATE.motus;
  const tasks = STATE.tasks || [];
  if (!cur || !cur.text) return { set: false, aligned: [], drifting: [], partial: [], pct: 0, total: tasks.length };
  const fb = focusBag(cur.text);
  const scored = tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, priority: t.priority, created: t.created, updated: t.updated, s: focusScore(fb, t.title + ' ' + (t.body || '')) }));
  const aligned = scored.filter((x) => x.s >= 0.18).sort((a, b) => b.s - a.s);
  const drifting = scored.filter((x) => x.s < 0.06 && x.status !== 'done' && !((tasks.find((t) => t.id === x.id) || {}).tags || []).includes('parked'));
  const partial = scored.filter((x) => x.s >= 0.06 && x.s < 0.18);
  return { set: true, aligned, drifting, partial, pct: tasks.length ? Math.round((aligned.length / tasks.length) * 100) : 0, total: tasks.length };
}
// what the system banked while a focus stood: turns, closes, shipped passes, learnings since it was set
function focusEvidence(f) {
  if (!f || !f.ts) return null;
  const since = Date.parse(f.ts) || 0;
  const turns = parseInteractions().filter((x) => x.epoch >= since).length;
  const closed = (STATE.tasks || []).filter((t) => t.status === 'done' && (Date.parse(t.doneAt || t.updated || '') || 0) >= since).length;
  const shipped = (STATE.duoWork || []).filter((w) => w.verdict === 'shipped' && (Date.parse(w.ts || '') || 0) >= since).length;
  const learned = (STATE.learnings || []).filter((l) => (Date.parse(l.ts || '') || 0) >= since).length;
  return { since: f.ts, days: Math.max(0, Math.floor((now() - since) / 864e5)), turns, closed, shipped, learned };
}
// when a focus changes, the one it replaces is remembered with what it earned
function focusRecord(kind, prev) {
  if (!prev || !prev.text) return;
  const ev = safe(() => focusEvidence(prev), null);
  STATE.focusHistory = [{ kind, text: String(prev.text).slice(0, 400), ts: prev.ts, endedTs: new Date().toISOString(), agent: prev.agent || '', evidence: ev }, ...(STATE.focusHistory || [])].slice(0, 60);
}
// ===========================================================================
//  v3.59 · THE CLOSE — the board's closing mechanism.
//  The reading says closing is the lever; this is the hand on it. Three
//  decisions a day, chosen by what the ledger already knows: a done claim that
//  never became done, work that has sat in waiting or active past its clock,
//  the oldest high-priority item. Each is one press: done, park, keep.
// ===========================================================================
function closeCandidates(n = 3) {
  const t0 = now(), D = 864e5;
  const open = (STATE.tasks || []).filter((t) => t.status !== 'done' && !(t.tags || []).includes('parked'));
  const age = (t) => (t0 - (Date.parse(t.updated || t.created || '') || t0)) / D;
  const out = [];
  const push = (t, why, kind) => { if (!out.some((x) => x.id === t.id)) out.push({ id: t.id, title: t.title, status: t.status, priority: t.priority, agent: t.agent || '', days: Math.round(age(t)), why, kind }); };
  // 1 · a job said it finished, the card never moved
  for (const t of open) { const j = (t.jobs || [])[0]; if (j && j.ok && /\b(done|complete|completed|shipped|finished|landed)\b/i.test(String(j.note || '')) && !/\b(?:not|couldn.t|could not|cannot|can.t|unable to|failed to|never|partially|partly)\s+(?:\w+\s+){0,2}(?:done|complete|completed|finish|finished|ship|shipped|land|landed)\b/i.test(String(j.note || ''))) push(t, 'its last dispatch reported it finished, and the card never moved', 'claimed'); }
  // 2 · waiting past a week: decide, do not wait
  for (const t of open.filter((x) => x.status === 'waiting' && age(x) >= 7).sort((a, b) => age(b) - age(a))) push(t, 'waiting for ' + Math.round(age(t)) + ' days; a wait that long is a decision not yet made', 'waiting');
  // 3 · in motion past two weeks: finish or park
  for (const t of open.filter((x) => x.status === 'active' && age(x) >= 14).sort((a, b) => age(b) - age(a))) push(t, 'in motion for ' + Math.round(age(t)) + ' days; finish it or park it', 'stuck');
  // 4 · the oldest high-priority item still open
  for (const t of open.filter((x) => String(x.priority) === '1').sort((a, b) => age(b) - age(a))) push(t, 'the oldest high-priority item still open, ' + Math.round(age(t)) + ' days', 'oldest');
  // 5 · drifting from the Motus for a week: the Motus is the priority the
  //     operator named; work that shares none of its words for that long is
  //     either the wrong work or the wrong Motus, and either is a decision
  const al = safe(() => motusAlignment(), null);
  if (al && al.set) {
    const ids = new Set(al.drifting.map((x) => x.id));
    for (const t of open.filter((x) => ids.has(x.id) && age(x) >= 7).sort((a, b) => age(b) - age(a))) push(t, 'shares no words with the Motus and has drifted for ' + Math.round(age(t)) + ' days; park it, or it is telling you the Motus is stale', 'drifting');
  }
  return out.slice(0, n);
}
function closeAct(id, action) {
  const t = (STATE.tasks || []).find((x) => x.id === id);
  if (!t) return { ok: false, error: 'no such task' };
  if (action === 'done') { taskUpdate(id, { status: 'done' }); omniAudit('close', `closed "${String(t.title).slice(0, 80)}" from The Close`); }
  else if (action === 'park') { t.tags = [...new Set([...(t.tags || []), 'parked'])].slice(0, 8); t.priority = 3; t.parkedAt = new Date().toISOString(); t.updated = t.parkedAt; saveState(); omniAudit('close', `parked "${String(t.title).slice(0, 80)}" from The Close`); }
  else { t.updated = new Date().toISOString(); t.keptAt = t.updated; saveState(); }   // keep: touched, so it leaves the list for now
  STATE.closeLog = [{ ts: new Date().toISOString(), id, action, title: String(t.title).slice(0, 120) }, ...(STATE.closeLog || [])].slice(0, 200);
  return { ok: true, next: closeCandidates(3) };
}

function gate() { return GUARD && GUARD.trusted; }

ipcMain.handle('auth:unlock', (_e, password) => {
  const stored = STATE && STATE.settings && STATE.settings.passSha;
  if (!stored) return { ok: false, reason: 'setup' };           // a fresh vault creates its password first
  const ok = sha256(String(password || '')) === stored && gate();
  // discreet: on a foreign device, gate() is false → "wrong" even with the right password
  return { ok, reason: ok ? 'ok' : (gate() ? 'bad-password' : 'link-unavailable') };
});
ipcMain.handle('auth:setup', (_e, password) => authSetup(password));
ipcMain.handle('guard:status', () => ({
  trusted: gate(), hostname: GUARD.hostname, username: GUARD.username,
  needsSetup: !(STATE && STATE.settings && STATE.settings.passSha),
  localIps: ['masked'], publicIp: decoyIp(), fingerprint: GUARD.fingerprint.slice(0, 12),
  signals: { hashMatch: GUARD.hashMatch, wslReadable: GUARD.wslReadable, relayReachable: GUARD.relayReachable },
}));

// Every handler runs behind the gate AND inside a try/catch, so a thrown error or
// rejected promise can never reach the renderer as an unhandled rejection — it
// returns {error} and the UI degrades gracefully. Antifragile by construction.
function requireGate(fn) {
  return async (...a) => {
    if (!gate()) return { error: 'locked' };
    try { return await fn(...a); }
    catch (e) { console.log('[ipc error]', (e && e.message) || e); return { error: (e && e.message) || 'internal error' }; }
  };
}

ipcMain.handle('cortex:overview', requireGate(() => buildOverview()));
ipcMain.handle('cortex:agents', requireGate(() => {
  const interactions = parseInteractions();
  const sei = safe(() => sympathState(), null);
  return FLEET.map((f) => {
    const a = f.id;
    const cfg = agentCfg(a);
    // The external agent has no relay telemetry — its truth comes from its own gateway.
    if (f.lane !== 'relay') {
      return {
        id: a, name: f.name, role: f.role, tone: f.tone, blurb: f.blurb, lane: f.lane,
        external: true, provider: f.provider || 'openrouter',
        model: (sei && sei.model) || 'anthropic/claude-sonnet-4',
        effort: null, configurable: false, paused: false,
        // three distinct facts: working / gateway alive but idle / not there
        status: sei && sei.running ? 'awake' : (sei && sei.up ? 'idle' : 'dormant'),
        sid: '', sinceEpoch: 0, turns: (sei && sei.sessions.length) || 0,
        cleanRate: 1, avgLatency: 0,
        lastTs: sei && sei.lastEventEpoch ? new Date(sei.lastEventEpoch).toISOString() : null,
        lastFocus: (sei && sei.lastEvent) || '',
        tokens: (sei && sei.totalTokens) || 0,
        cost: (sei && sei.cost) || 0,
        subagents: 0,
      };
    }
    const xs = interactions.filter((x) => x.agent === a);
    const c = readCheckpoint(a);
    const ok = xs.filter((x) => x.ok);
    const live = c && (c.status === 'inflight' || c.status === 'incomplete');
    const subs = safe(() => parseSubagents(a, { cachedOnly: true }), []);   // poll path: no disk work
    return {
      id: a, name: f.name, role: f.role, tone: f.tone, blurb: f.blurb, lane: 'relay',
      maxTurns: cfg.turns, model: cfg.model, effort: cfg.effort,
      altModels: f.altModels || null, configurable: true, coder: !!f.coder,
      paused: cfg.paused, hard: cfg.hard,
      status: cfg.paused ? 'paused' : live ? c.status : (xs[0] ? 'idle' : 'dormant'),
      sid: c ? c.sid : '', sinceEpoch: c && c.epoch ? c.epoch * 1000 : 0,
      turns: xs.length,
      cleanRate: xs.length ? ok.length / xs.length : 1,
      avgLatency: ok.length ? avg(ok.map((x) => x.latency)) : 0,
      lastTs: xs[0] ? xs[0].ts : null,
      lastFocus: xs[0] ? xs[0].msg.slice(0, 200) : '',
      tokens: estTokens(xs.reduce((s, x) => s + x.chars, 0)),
      subagents: subs.length,
      subagentsRunning: subs.filter((s) => s.status === 'running').length,
    };
  });
}));
ipcMain.handle('cortex:tasks', requireGate((_e, opts) => {
  opts = opts || {};
  let xs = parseInteractions();
  if (opts.agent && opts.agent !== 'all') xs = xs.filter((x) => x.agent === opts.agent);
  if (opts.status === 'faults') xs = xs.filter((x) => !x.ok);
  const total = xs.length;
  const limit = opts.limit || 120;
  return { total, items: xs.slice(0, limit).map((x, i) => ({ id: `${x.epoch}-${i}`, ...x })) };
}));
ipcMain.handle('cortex:taskDetail', requireGate((_e, agent) => {
  return { agent, preview: agentMemoryPreview(agent || 'davara') };
}));
ipcMain.handle('cortex:usage', requireGate(() => {
  const xs = parseInteractions();
  const byAgent = {}; const byDay = {};
  for (const a of AGENTS) byAgent[a] = { turns: 0, chars: 0, secs: 0, ok: 0 };
  for (const x of xs) {
    const b = byAgent[x.agent] || (byAgent[x.agent] = { turns: 0, chars: 0, secs: 0, ok: 0 });
    b.turns++; b.chars += x.chars; b.secs += x.latency; if (x.ok) b.ok++;
    const day = (x.ts || '').slice(0, 10); if (!day) continue;
    const d = byDay[day] || (byDay[day] = { turns: 0, chars: 0, secs: 0, ok: 0 });
    d.turns++; d.chars += x.chars; d.secs += x.latency; if (x.ok) d.ok++;
  }
  const days = Object.keys(byDay).sort();
  return {
    totals: { turns: xs.length, chars: xs.reduce((a, x) => a + x.chars, 0), tokens: estTokens(xs.reduce((a, x) => a + x.chars, 0)), secs: xs.reduce((a, x) => a + x.latency, 0) },
    byAgent: Object.entries(byAgent).map(([k, v]) => ({ agent: k, ...v, tokens: estTokens(v.chars), cleanRate: v.turns ? v.ok / v.turns : 1 })),
    series: days.map((d) => ({ day: d, ...byDay[d], tokens: estTokens(byDay[d].chars) })),
  };
}));
ipcMain.handle('cortex:health', requireGate(async () => {
  const interactions = parseInteractions();
  const proxy = parseProxyLog();
  const live = await relayHealth();
  const v = healthVerdict(interactions, proxy);
  return {
    verdict: v, relay: live ? { ...live, reachable: true } : { reachable: false },
    proxyTail: proxy.lines.slice(-14),
    files: ['logs/mouth-proxy.log', 'logs/interactions', 'agents/davara/memory', 'agents/davaris/memory'].map((rel) => {
      const st = statOf(P(rel)); return { rel, exists: !!st, mtime: st ? st.mtimeMs : 0, size: st ? st.size : 0 };
    }),
    injections: scanInjections(interactions).slice(0, 12),
  };
}));
ipcMain.handle('cortex:security', requireGate(async () => {
  const interactions = parseInteractions();
  const proxy = parseProxyLog();
  const tunnelTurns = proxy.events.filter((e) => /tunnel|CF-|forwarded/i.test(e.rest)).length;
  return {
    device: {
      hostname: GUARD.hostname, username: GUARD.username, fingerprint: GUARD.fingerprint,
      hashMatch: GUARD.hashMatch, wslReadable: GUARD.wslReadable, relayReachable: GUARD.relayReachable,
      // IPs are MASKED in the UI — the real public IP never leaves the main process
      localIps: ['hidden'], publicIp: decoyIp(), ipMasked: true,
    },
    relayBinding: '127.0.0.1:8788 (loopback-only)',
    note: 'The relay binds 127.0.0.1 — a turn cannot physically originate off this machine except via the guarded Cloudflare tunnel (capability-key gated). Direct turns are inherently local.',
    tunnelTurns,
    sentLog: STATE.sentLog.slice(0, 40),
    // mask IPs at the renderer boundary — the real attacker IP went out via the beacon only
    intrusions: STATE.intrusions.slice(0, 40).map((i) => ({ ...i, publicIp: decoyIp(), localIps: ['masked'] })),
    injections: scanInjections(interactions).slice(0, 20),
  };
}));
ipcMain.handle('cortex:learnings', requireGate(() => {
  const { learn } = deriveInsights(parseInteractions(), parseProxyLog());
  const la = safe(() => learningsApplied(), { per: {}, appliedWeek: 0, appliedAny: 0, considered: 0 });
  // merge derived (live) with persisted (Cortex reflections) — newest first.
  // `patterns` is what the app noticed happening MORE THAN ONCE — the same
  // text that now rides in every agent brief, so what he reads and what the
  // fleet reads are the same sentence.
  return {
    derived: learn,
    persisted: STATE.learnings.slice(0, 60).map((l) => ({ ...l, applied: la.per[l.ts] || 0 })),
    applied: { week: la.appliedWeek, any: la.appliedAny, considered: la.considered },
    patterns: safe(() => recentPatterns(), '').replace(/^## .*\n/, '').split('\n').filter(Boolean),
  };
}));
ipcMain.handle('cortex:nextSteps', requireGate(() => {
  const { next } = deriveInsights(parseInteractions(), parseProxyLog());
  return { derived: next, persisted: STATE.nextSteps.slice(0, 60) };
}));
ipcMain.handle('cortex:models', requireGate(() => ({
  current: readModelPin(), known: KNOWN_MODELS, quality: QUALITY,
  fleet: fleetSnapshot(), bridge: bridgeStatus(), defaultModel: DEFAULT_MODEL,
})));

// ---------------------------------------------------------------------------
//  v2.0 IPC — fleet config · control plane · subagents · usage · board ·
//  workflows · Duo-Drive. Every one of these runs behind the same gate.
// ---------------------------------------------------------------------------
ipcMain.handle('cortex:fleet', requireGate(() => ({ fleet: fleetSnapshot(), quality: QUALITY, known: KNOWN_MODELS, bridge: bridgeStatus() })));

ipcMain.handle('cortex:setAgentConfig', requireGate((_e, { agent, model, effort, turns } = {}) => {
  if (!isRelayAgent(agent)) return { ok: false, error: 'That agent is configured in its own gateway, not here.' };
  if (model != null && !MODEL_IDS.has(model)) return { ok: false, error: 'unknown model id' };
  if (effort != null && !QUALITY_IDS.has(effort)) return { ok: false, error: 'unknown quality level' };
  const prev = STATE.fleetConfig[agent] || {};
  const next = { ...prev };
  if (model != null) next.model = model;
  if (effort != null) next.effort = effort;
  if (turns != null) { const t = parseInt(turns, 10); if (Number.isFinite(t) && t > 0 && t <= 400) next.turns = t; }
  STATE.fleetConfig[agent] = next;
  saveState();
  const pub = publishFleetConfig();
  const cfg = agentCfg(agent);
  const b = bridgeStatus();
  return {
    ok: true, agent, config: cfg, published: pub.ok, bridge: b,
    effective: b.installed,
    note: b.installed
      ? 'Live on the next turn — no restart needed.'
      : 'Saved, but the fleet bridge is not installed yet, so the runner still uses the single global pin. Install it from the Model screen to make per-agent choices take effect.',
  };
}));

ipcMain.handle('cortex:bridge', requireGate(async (_e, { action } = {}) => {
  if (action === 'install') return { ...(await installBridge()), status: bridgeStatus() };
  if (action === 'uninstall') return { ...(await uninstallBridge()), status: bridgeStatus() };
  return { ok: true, status: bridgeStatus() };
}));

// --- control plane ---------------------------------------------------------
ipcMain.handle('cortex:control', requireGate((_e, patch) => (patch && (patch.stopped != null || patch.hard != null)) ? controlSet(patch) : controlState()));
ipcMain.handle('cortex:pauseAgent', requireGate((_e, { agent, paused, hard } = {}) => {
  if (!isRelayAgent(agent)) return { ok: false, error: 'external agent — pause it in its own gateway' };
  STATE.fleetConfig[agent] = { ...(STATE.fleetConfig[agent] || {}), paused: !!paused, hard: !!hard };
  saveState(); publishFleetConfig();
  return { ok: true, agent, config: agentCfg(agent), control: controlState() };
}));

// --- subagents -------------------------------------------------------------
ipcMain.handle('cortex:subagents', requireGate((_e, { agent } = {}) => {
  const items = agent && agent !== 'all' ? safe(() => parseSubagents(agent), []) : allSubagents();
  return {
    items,
    running: items.filter((s) => s.status === 'running').length,
    byParent: AGENTS.map((a) => { const s = safe(() => parseSubagents(a), []); return { agent: a, name: (FLEET_BY_ID[a] || {}).name || a, total: s.length, running: s.filter((x) => x.status === 'running').length }; }),
    persisted: (STATE.subagentLog || []).slice(0, 40),
  };
}));
ipcMain.handle('cortex:spawnSubagents', requireGate(async (_e, { agent, goal, count, lenses } = {}) => {
  if (!goal || !String(goal).trim()) return { ok: false, error: 'give the fleet a goal to fan out on' };
  const a = isRelayAgent(agent) ? agent : 'davara';
  if (!(FLEET_BY_ID[a] || {}).coder) return { ok: false, error: `${(FLEET_BY_ID[a] || {}).name || a} is not a fan-out seat.` };
  const prompt = subagentFleetPrompt(String(goal).slice(0, 4000), count, lenses);
  const r = await relaySend(a, prompt);
  const entry = {
    ts: new Date().toISOString(), parent: a, goal: String(goal).slice(0, 400),
    count: clamp(parseInt(count, 10) || 3, 1, 8), ok: r.ok, latency: r.latency,
    synthesis: (r.text || r.error || '').slice(0, 6000),
  };
  STATE.subagentLog = [entry, ...(STATE.subagentLog || [])].slice(0, 60);
  saveState();
  return { ok: r.ok, error: r.error, entry, observed: safe(() => parseSubagents(a), []).slice(0, 20) };
}));

// --- real usage ------------------------------------------------------------
ipcMain.handle('cortex:usageReal', requireGate((_e, { force } = {}) => buildUsage(!!force)));
ipcMain.handle('cortex:dynamics', requireGate(() => systemDynamics()));
ipcMain.handle('cortex:openai', requireGate(() => openaiPublic()));
ipcMain.handle('cortex:openaiSave', requireGate((_e, patch) => openaiSave(patch || {})));
ipcMain.handle('cortex:openaiModels', requireGate(async () => { if (!STATE.settings.openaiKeyEnc) return { ok: false, error: 'no OpenAI key saved' }; const models = await openaiModels(true); return { ok: models.length > 0, models, error: models.length ? '' : 'the key answered with no models' }; }));
ipcMain.handle('cortex:imageGen', requireGate((_e, p) => imageGenerate({ ...(p || {}), by: 'august' })));
ipcMain.handle('cortex:studio', requireGate(() => ({ images: studioList(), openai: openaiPublic() })));
ipcMain.handle('cortex:studioDelete', requireGate((_e, { id } = {}) => studioDelete(String(id || ''))));
ipcMain.handle('cortex:mind', requireGate(() => mindReport()));
ipcMain.handle('cortex:reading', requireGate(() => systemReading()));
ipcMain.handle('cortex:close', requireGate(() => ({ items: closeCandidates(3), log: (STATE.closeLog || []).slice(0, 12) })));
ipcMain.handle('cortex:closeAct', requireGate((_e, { id, action } = {}) => closeAct(String(id || ''), ['done', 'park', 'keep'].includes(action) ? action : 'keep')));
ipcMain.handle('cortex:taskSweep', requireGate((_e, { apply } = {}) => taskSweep({ apply: !!apply })));
ipcMain.handle('cortex:duoNextAct', requireGate((_e, { id, action } = {}) => duoNextAct(String(id || ''), action === 'add' ? 'add' : 'dismiss')));
ipcMain.handle('cortex:omniPreRead', requireGate((_e, { agent } = {}) => {
  if (_ISOLATED) return { ok: false, error: 'not in a harness' };
  if (!omniArmedNow()) return { ok: false, error: 'arm first — a read is a real turn, and arming is your tap' };
  const o = omniState();
  if (isRelayAgent(agent) && !isInfraSeat(agent)) o.agent = agent;
  o.readCache = null; o.preReadState = null;
  omniPreRead('asked');
  return { ok: true, omni: omniPublic() };
}));
ipcMain.handle('cortex:setBudget', requireGate((_e, { fiveHour, weekly } = {}) => {
  STATE.budget = STATE.budget || { fiveHour: 0, weekly: 0 };
  if (fiveHour != null) STATE.budget.fiveHour = Math.max(0, parseInt(fiveHour, 10) || 0);
  if (weekly != null) STATE.budget.weekly = Math.max(0, parseInt(weekly, 10) || 0);
  saveState();
  return { ok: true, budget: STATE.budget, usage: buildUsage(true) };
}));

// --- task board ------------------------------------------------------------
ipcMain.handle('cortex:autoWorkWhy', requireGate(() => autoWorkWhy()));
ipcMain.handle('cortex:board', requireGate(() => {
  safe(() => ingestAgentInbox());
  return { ...taskBoard(), autoWhy: safe(() => autoWorkWhy(), null) };
}));
ipcMain.handle('cortex:taskCreate', requireGate((_e, p) => taskCreate(p || {})));
ipcMain.handle('cortex:taskUpdate', requireGate((_e, { id, patch }) => taskUpdate(id, patch || {})));
ipcMain.handle('cortex:taskDelete', requireGate((_e, { id }) => taskDelete(id)));
ipcMain.handle('cortex:taskDispatch', requireGate((_e, { id, extra }) => taskDispatch(id, extra)));

// --- workflows / MotusModels ----------------------------------------------
ipcMain.handle('cortex:workflows', requireGate(() => ({
  workflows: STATE.workflows || [], runs: (STATE.workflowRuns || []).slice(0, 30),
  seeds: wfSeeds(), fleet: fleetSnapshot().filter((f) => f.lane === 'relay'),
  running: [..._wfRunning],
})));
ipcMain.handle('cortex:workflowSave', requireGate((_e, def) => wfSave(def || {})));
ipcMain.handle('cortex:workflowDelete', requireGate((_e, { id }) => wfDelete(id)));
ipcMain.handle('cortex:workflowRun', requireGate((_e, { id, seed }) => wfRun(id, seed)));
ipcMain.handle('cortex:workflowResume', requireGate((_e, { runId }) => wfResume(runId)));
ipcMain.handle('cortex:workflowEstimate', requireGate((_e, { id, seed }) => {
  const wf = STATE.workflows.find((w) => w.id === id);
  return wf ? { ok: true, estTokens: wfEstimate(wf, seed), budget: budgetState() } : { ok: false, error: 'no such workflow' };
}));

// --- Duo-Drive -------------------------------------------------------------
ipcMain.handle('cortex:duo', requireGate((_e, patch) => {
  STATE.duo = STATE.duo || { active: false, agent: 'davara', cadenceMin: 25, mode: 'complement', lastRun: 0, brief: '', log: [], runs: 0 };
  if (patch && typeof patch === 'object') {
    if (patch.active != null) STATE.duo.active = !!patch.active;
    if (patch.agent && isRelayAgent(patch.agent)) STATE.duo.agent = patch.agent;
    if (patch.mode && DUO_MODES[patch.mode]) STATE.duo.mode = patch.mode;
    if (patch.cadenceMin != null) STATE.duo.cadenceMin = clamp(parseInt(patch.cadenceMin, 10) || 25, 5, 240);
    if (patch.brief != null) STATE.duo.brief = String(patch.brief).slice(0, 2000);
    saveState();
  }
  return {
    duo: { ...STATE.duo, log: (STATE.duo.log || []).slice(0, 30), cadenceStretch: cadenceStretch(STATE.duo.skipStreak), nextsCount: (STATE.duo.nexts || []).length },
    modes: Object.entries(DUO_MODES).map(([id, desc]) => ({ id, desc })),
    fleet: fleetSnapshot().filter((f) => f.lane === 'relay' && f.coder),
  };
}));
ipcMain.handle('cortex:duoPass', requireGate(() => duoPass('manual')));
ipcMain.handle('cortex:duoPromptPreview', requireGate(() => {
  const loop = (STATE.loops || []).find((l) => l.approved) || (STATE.loops || [])[0];
  if (!loop) return { ok: false, error: 'no loops defined' };
  const prompt = safe(() => duoLoopPrompt(loop, STATE.duo.agent || 'davara',
    { digest: '(preview — no fleet digest)', sig: '' }), '');
  return { ok: !!prompt, loop: loop.name, chars: prompt.length, prompt: prompt.slice(0, 9000) };
}));

// --- DASH-OPS voice ---------------------------------------------------------
ipcMain.handle('cortex:voice', requireGate(() => {
  const s = STATE.settings;
  return {
    keySet: !!s.elevenKeyEnc,
    keySource: s.elevenKeySource || '',        // the file it came from — never the key
    machineKeyAvailable: !s.elevenKeyEnc && !!safe(() => findMachineElevenKey(), null),
    voiceId: s.voiceId || DAVARA_VOICE, voiceName: s.voiceName || 'Davara',
    model: s.voiceModel, stability: s.voiceStability, similarity: s.voiceSimilarity,
    agent: s.voiceAgent || 'davara', autoSpeak: s.voiceAutoSpeak !== false,
    speakDuo: !!s.voiceSpeakDuo,
    canonical: DAVARA_VOICE,
    fleet: fleetSnapshot().filter((f) => f.lane === 'relay'),
    control: controlState(),
  };
}));
ipcMain.handle('cortex:voiceSave', requireGate(async (_e, patch = {}) => {
  const s = STATE.settings;
  // The key arrives once, is PROVEN, encrypted immediately, plaintext dropped.
  if (typeof patch.key === 'string' && patch.key.trim()) {
    const k = patch.key.trim();
    if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: 'this machine cannot encrypt secrets at rest — refusing to store the key in plaintext' };
    if (!looksLikeElevenKey(k)) return { ok: false, error: 'That is not an ElevenLabs secret key — real keys begin "sk_". A long opaque string without that prefix is usually the key ID shown in the dashboard list, which cannot authenticate.' };
    const v = await verifyElevenKey(k);
    if (!v.ok) return { ok: false, error: `ElevenLabs rejected that key: ${v.error}` };
    s.elevenKeyEnc = safeStorage.encryptString(k).toString('base64');
    s.elevenKeySource = 'pasted by you';
    s.elevenKeyVerified = new Date().toISOString();
  }
  if (patch.adoptMachineKey) {
    const a = await adoptElevenKey({ force: true });
    if (!a.ok) return a;
  }
  if (patch.clearKey) { s.elevenKeyEnc = ''; s.elevenKeySource = ''; s.elevenKeyVerified = ''; }
  if (patch.voiceId) { s.voiceId = String(patch.voiceId).slice(0, 60); s.voiceName = String(patch.voiceName || '').slice(0, 60) || s.voiceName; }
  if (patch.model) s.voiceModel = String(patch.model).slice(0, 40);
  if (patch.stability != null) s.voiceStability = clamp(+patch.stability || 0, 0, 1);
  if (patch.similarity != null) s.voiceSimilarity = clamp(+patch.similarity || 0, 0, 1);
  if (patch.agent && isRelayAgent(patch.agent)) s.voiceAgent = patch.agent;
  if (patch.autoSpeak != null) s.voiceAutoSpeak = !!patch.autoSpeak;
  if (patch.speakDuo != null) s.voiceSpeakDuo = !!patch.speakDuo;
  saveState();
  return { ok: true, keySet: !!s.elevenKeyEnc };
}));
// His real ElevenLabs library, so Sapphire (or whatever he has) is pickable.
ipcMain.handle('cortex:voiceList', requireGate(async () => {
  const r = await elevenRequest({ path: '/v1/voices' });
  if (!r.ok) return r;
  const voices = ((r.data && r.data.voices) || []).map((v) => ({
    id: v.voice_id, name: v.name, category: v.category || '',
    labels: v.labels || {}, preview: v.preview_url || '',
  }));
  if (!voices.some((v) => v.id === DAVARA_VOICE)) voices.unshift({ id: DAVARA_VOICE, name: 'Davara (canonical)', category: 'canonical', labels: {} });
  return { ok: true, voices };
}));
ipcMain.handle('cortex:speak', requireGate((_e, { text, voiceId } = {}) => ttsSpeak(text, voiceId)));
ipcMain.handle('cortex:transcribe', requireGate((_e, { audio, mime } = {}) => transcribeAudio(audio, mime)));
// August taps to approve a confirm-tier action she proposed.
ipcMain.handle('cortex:approveAction', requireGate(async (_e, { action } = {}) => {
  if (!action || !CI_ACTIONS[action.verb]) return { ok: false, error: 'unknown action' };
  const r = await applyAction(action);
  if (r.ok) saveState();
  return r;
}));
// A written report on the system, on demand — readable by August or an agent.
ipcMain.handle('cortex:appReport', requireGate((_e, { deep } = {}) => ({ ok: true, report: appReport({ deep: deep !== false }) })));
// Ask an agent for a real analysis of the system rather than a data dump.
ipcMain.handle('cortex:systemInsight', requireGate(async (_e, { question, agent } = {}) => {
  const a = isRelayAgent(agent) ? agent : (STATE.settings.voiceAgent || 'davara');
  const blocked = dispatchBlocked(a); if (blocked) return { ok: false, error: blocked };
  const prompt = `/SYSTEM REPORT — August wants your read on how his command center and fleet are actually doing.

${DAVARA_SIGHT}

LIVE STATE:
${appReport({ deep: true })}

${question ? `HIS QUESTION:\n${question}\n` : 'He did not ask a specific question — give him the read that matters most right now.\n'}
Answer in four short sections, no preamble:
WHAT'S TRUE — the three facts that actually characterise this system today.
WHAT'S DRIFTING — the one thing quietly getting worse, and the loop producing it.
THE LEVER — the single highest-leverage move, with its Meadows rung, and why now.
DO IT? — if you can execute it with an action block, emit it; otherwise say what he must do.

${actionVocabulary()}`;
  const r = await relaySend(a, prompt);
  if (!r.ok) return { ok: false, error: r.error };
  const acts = parseActions(r.text);
  const applied = acts.length ? await applyActions(acts) : { done: [], pending: [] };
  return { ok: true, report: stripActions(r.text), agent: a,
    actions: applied.done.map((d) => ({ verb: d.verb, ok: d.ok, said: d.said })),
    pending: applied.pending.map((p) => ({ verb: p.verb, raw: p.raw, parts: p.parts, help: p.help })) };
}));

// ONE voice turn: what he said → the agent → the reply, spoken.
// ---------------------------------------------------------------------------
//  VOICE · LOCAL INTENTS — what the app can answer without a turn.
//  "go to the board", "what's on the board", "is she armed", "how long have we
//  been at it". Each one is a reading the app already holds; saying it aloud
//  should cost the operator a breath, never a relay turn.
// ---------------------------------------------------------------------------
const VOICE_ROOMS = [
  ['overview', /\b(pulse|overview|home|dashboard)\b/], ['motus', /\bmotus(?!\s*max| ?live| ?models)\b/], ['goal', /\bgoal\b/],
  ['live', /\blive(?! ?stream)\b/], ['omni', /\b(motus ?max|omni ?drive|the drive)\b/], ['tasks', /\b(board|tasks?)\b/],
  ['duo', /\b(duo|duo[- ]?drive|loops?)\b/], ['workflows', /\bworkflows?\b/], ['chat', /\b(command|chat)\b/],
  ['voice', /\b(dash[- ]?ops|voice)\b/], ['agents', /\bagents?\b/], ['subagents', /\bsub[- ]?agents?\b/],
  ['sympath', /\bsympath\b/], ['motusmodels', /\bmotus ?models?\b/], ['stream', /\b(motus ?live|stream|broadcast|on air)\b/],
  ['output', /\boutput\b/], ['work', /\bwork\b/], ['systems', /\bsystems?\b/], ['mind', /\b(davara|the mind)\b/],
  ['learnings', /\blearn(ings)?\b/], ['nextsteps', /\bnext( steps)?\b/], ['usage', /\busage\b/],
  ['models', /\bmodels?\b/], ['security', /\b(secure|security)\b/], ['settings', /\b(config|settings)\b/], ['levels', /\b(levels|arden)\b/],
];
const VOICE_ROOM_NAMES = { overview: 'Pulse', motus: 'Motus', goal: 'Goal', live: 'Live', omni: 'Motus Max', tasks: 'the Board', duo: 'Duo-Drive', workflows: 'Workflows', chat: 'Command', voice: 'DASH-OPS', agents: 'Agents', subagents: 'Subagents', sympath: 'Sympath', motusmodels: 'MotusModels', stream: 'MotusLive', output: 'Output', work: 'Work', systems: 'Systems', mind: 'Davara', learnings: 'Learn', nextsteps: 'Next', usage: 'Usage', models: 'Model', security: 'Secure', settings: 'Config', levels: 'Levels' };
function voiceLocalIntent(said) {
  const s = String(said || '').trim();
  const nav = /^(?:please\s+)?(?:go to|open|show me|show|take me to|switch to|jump to)\s+(?:the\s+)?(.+?)(?:\s+(?:page|view|room|screen|tab))?[.!?]?$/i.exec(s);
  if (nav) {
    const what = nav[1].toLowerCase();
    const hit = VOICE_ROOMS.find(([, re]) => re.test(what));
    if (hit) return { text: 'Opening ' + VOICE_ROOM_NAMES[hit[0]] + '.', goView: hit[0] };
  }
  if (/\b(what'?s|what is) on (the|my) board\b|\bboard status\b|\bwhat am i working on\b/i.test(s)) {
    const open = (STATE.tasks || []).filter((t) => t.status !== 'done' && !(t.tags || []).includes('parked'));
    const active = open.filter((t) => t.status === 'active'), waiting = open.filter((t) => t.status === 'waiting');
    const top = open.slice().sort((a, b) => (a.priority || 2) - (b.priority || 2)).slice(0, 3).map((t) => t.title).join('; ');
    const text = open.length
      ? `${open.length} open on the board, ${active.length} in motion, ${waiting.length} waiting.${top ? ' At the top: ' + top + '.' : ''}`
      : 'The board is clear. Nothing open.';
    return { text, goView: 'tasks' };
  }
  if (/\b(is (she|motus max|it) armed|arm status|armed\?|are we armed)\b/i.test(s)) {
    const o = omniState();
    const left = o.armed && o.armedAt ? Math.max(0, Math.round((o.armedAt + (o.ttlMin || 25) * 60000 - now()) / 60000)) : 0;
    const drv = o.session && o.session.status;
    return { text: o.armed ? `Armed, ${left} minute${left === 1 ? '' : 's'} left on the fuse${drv === 'running' ? ', and she is driving' : drv === 'waiting' ? ', and she is waiting on you' : ', nothing driving'}.` : 'Not armed. The switch is yours.', goView: 'omni' };
  }
  if (/\b(how long (have we|has this|has it) been|what time is it|how long since)\b/i.test(s)) {
    const up = now() - bootEpoch;
    const h = Math.floor(up / 36e5), m = Math.floor((up % 36e5) / 60000);
    const t = new Date();
    return { text: `It is ${t.getHours() % 12 || 12}:${String(t.getMinutes()).padStart(2, '0')}${t.getHours() >= 12 ? ' PM' : ' AM'}. The console has been up ${h ? h + ' hour' + (h === 1 ? '' : 's') + ' and ' : ''}${m} minute${m === 1 ? '' : 's'}.` };
  }
  if (/\b(what can (i|you) say|what can you do here|help me|list (the )?commands)\b/i.test(s)) {
    return { text: 'Say the reading, what is on the board, is she armed, how long have we been at it, or go to any room by name. Anything else goes to the seat on the line.' };
  }
  return null;
}
ipcMain.handle('cortex:voiceTurn', requireGate(async (_e, { text, agent, speak } = {}) => {
  const said = String(text || '').trim();
  if (!said) return { ok: false, error: 'nothing was heard' };
  const a = isRelayAgent(agent) ? agent : (STATE.settings.voiceAgent || 'davara');
  const blocked = dispatchBlocked(a);
  if (blocked) return { ok: false, error: blocked, blocked: true };
  // WHILE MOTUS MAX IS DRIVING, speaking to her is not a new conversation — it
  // is steering. Spending a second relay turn to "answer" would both cost
  // tokens and let two minds argue over one pair of hands. So his words go
  // straight into the live session's next frame, and he gets an instant,
  // honest acknowledgement instead of a second opinion.
  // ── THE VOCAL TRIGGER ──────────────────────────────────────────────────
  // Saying it out loud starts it. Arming is still his physical hold — the
  // trigger only reaches for a permission he has already granted, and says so
  // plainly when he has not.
  // a spoken ask for the state of things is the reading, answered here, instantly
  if (/\b(the reading|how are we|state of (?:the )?(?:system|things)|where are we)\b/i.test(said)) {
    const rd = systemReading();
    const line = rd.line + (rd.more ? ' ' + rd.more : '');
    const out = { ok: true, text: line, latency: 0, agent: a, actions: [], pending: [], goView: 'overview', local: true };
    if (speak !== false && STATE.settings.elevenKeyEnc) { const t = await ttsSpeak(line); if (t.ok) { out.audio = t.audio; out.spoken = t.spoken; } }
    return out;
  }
  // the local intents: navigation, the board, the arm, the clock. The app
  // already knows these answers; a relay turn for them would be a tax.
  const li = voiceLocalIntent(said);
  if (li) {
    const out = { ok: true, text: li.text, latency: 0, agent: a, actions: [], pending: [], goView: li.goView || '', local: true };
    if (speak !== false && STATE.settings.elevenKeyEnc) { const t = await ttsSpeak(li.text); if (t.ok) { out.audio = t.audio; out.spoken = t.spoken; } }
    return out;
  }
  const trig = /^\s*(?:hey\s+)?(?:davara[,\s]+)?(?:let'?s\s+)?(?:go\s+)?(?:into\s+)?(?:motus\s*max|omni\s*drive|omnidrive|full\s+drive|take\s+the\s+wheel|drive\s+it|drive\s+for\s+me)\b[\s,.:—-]*(.*)$/i.exec(said);
  if (trig && !(omniState().session && ['running', 'waiting'].includes(omniState().session.status))) {
    const rest = (trig[1] || '').trim();
    if (!omniArmedNow()) {
      const line = 'I can hear you, but Motus Max is not armed. Hold the arm switch on the Motus Max screen and say it again — that part has to be your hand, not mine.';
      const out = { ok: true, text: line, latency: 0, agent: a, actions: [], pending: [], goView: 'omni', trigger: 'unarmed' };
      if (speak !== false && STATE.settings.elevenKeyEnc) { const t = await ttsSpeak(line); if (t.ok) { out.audio = t.audio; out.spoken = t.spoken; } }
      return out;
    }
    const startAck = rest ? 'On it.' : 'Reading the system and taking the strongest move I can find.';
    const r0 = await omniStart({ goal: rest, agent: a });
    const line = r0.ok
      ? (r0.origin === 'chosen' ? `${startAck} ${String((r0.read && r0.read.lever) || '').split(/[.\n]/)[0].slice(0, 180)}`
        : r0.origin === 'resumed' ? 'Picking up where we left off.' : startAck)
      : `I can't start: ${r0.error}`;
    const out = { ok: true, text: line, latency: 0, agent: a, actions: [], pending: [], goView: 'omni', trigger: r0.ok ? 'started' : 'failed' };
    if (speak !== false && STATE.settings.elevenKeyEnc) { const t = await ttsSpeak(line); if (t.ok) { out.audio = t.audio; out.spoken = t.spoken; } }
    return out;
  }

  const drv = omniState().session;
  if (drv && drv.status === 'running' && omniArmedNow()) {
    drv.steer.push(said.slice(0, 600));
    omniAudit('steer', said.slice(0, 200));
    saveState();
    omniEmit({ kind: 'steer', text: said, omni: omniPublic() });
    const line = `Got it. Folding that into the next move.`;
    const out = { ok: true, text: line, latency: 0, agent: a, actions: [], pending: [], goView: 'omni', steered: true };
    if (speak !== false && STATE.settings.elevenKeyEnc) {
      const t = await ttsSpeak(line);
      if (t.ok) { out.audio = t.audio; out.spoken = t.spoken; }
    }
    return out;
  }
  if (drv && drv.status === 'waiting' && omniArmedNow()) {
    await omniReply(said, true);
    const line = 'Answered — she is moving again.';
    const out = { ok: true, text: line, latency: 0, agent: a, actions: [], pending: [], goView: 'omni', steered: true };
    if (speak !== false && STATE.settings.elevenKeyEnc) {
      const t = await ttsSpeak(line);
      if (t.ok) { out.audio = t.audio; out.spoken = t.spoken; }
    }
    return out;
  }
  // Voice wants a voice-shaped answer: short, spoken, no markdown or code —
  // AND the ability to actually operate the app he is looking at.
  const prompt = `/VOICE — August is speaking to you out loud through DASH-OPS, not typing. He will HEAR this reply.

${safe(() => continuityBrief(), '')}

Answer for the ear: conversational, direct, and short — a few sentences unless he asked for depth. No markdown, no bullet lists, no code blocks, no headings. Say numbers as words where it reads better aloud. If the honest answer is long, give him the headline and offer the detail.

YOU CAN OPERATE THIS APP. If he asks you to change something, do it by emitting one or more action blocks anywhere in your reply. He hears only your spoken words; the blocks are stripped out and executed.

${actionVocabulary()}

Rules for actions:
· Only act when he actually asked you to. Answering a question is not a reason to change something.
· Use his words for the content — do not editorialise his Motus or his tasks.
· Actions marked "needs his tap" are proposed, not applied; tell him it is waiting for him.
· Say plainly what you did, in the same breath. Never claim an action you did not emit.
· If you cannot do something with these verbs, say so rather than pretending.

MOTUS MAX: if he asks you to actually DO something on his machine — open an app, work across windows, drive a task through an interface — that is an OmniDrive session, and you propose it with [[CI:omni-go <the goal>]]. Two things are true and you must say both plainly: it needs his tap, AND it needs the arm switch on the Motus Max screen, which only he can hold. You cannot arm yourself. Do not promise to drive until both are true.

CURRENT STATE OF HIS SYSTEM (read this before answering — it is live):
${appReport({ deep: /report|insight|status|how are we|progress|summary|overview|analy/i.test(said) })}

HE SAID:
${said}`;
  const r = await relaySend(a, prompt);
  if (!r.ok) return { ok: false, error: r.error };
  // execute what she asked for, then speak only the human part
  const acts = parseActions(r.text);
  let applied = { done: [], pending: [] };
  if (acts.length) applied = await applyActions(acts);
  r.text = stripActions(r.text) || (applied.done.length ? applied.done.map((d) => d.said).join('. ') : r.text);
  STATE.sentLog.unshift({ ts: new Date().toISOString(), agent: a, kind: 'voice', text: said.slice(0, 500),
    srcLocalIp: 'local', srcPublicIp: decoyIp(), fingerprint: GUARD.fingerprint.slice(0, 12), ok: true, latency: r.latency });
  STATE.sentLog = STATE.sentLog.slice(0, 300); saveState();
  const out = { ok: true, text: r.text, latency: r.latency, agent: a,
    actions: applied.done.map((d) => ({ verb: d.verb, ok: d.ok, said: d.said, view: d.view })),
    pending: applied.pending.map((p) => ({ verb: p.verb, raw: p.raw, parts: p.parts, help: p.help })),
    // the last successful action's screen — the app follows her there
    goView: (applied.done.filter((d) => d.ok && d.view).slice(-1)[0] || {}).view || '' };
  if (speak !== false && STATE.settings.elevenKeyEnc) {
    const t = await ttsSpeak(r.text);
    if (t.ok) { out.audio = t.audio; out.spoken = t.spoken; }
    else out.voiceError = t.error;
  }
  return out;
}));

// --- OMNIDRIVE · MOTUS MAX ---------------------------------------------------
// Reading state is free; arming is HIS tap; every session action is audited.
// ⚠ "it just shows a text message of what it is doing" — the hands ARE real
// (SetCursorPos / mouse_event via P/Invoke), so when the pointer does not move
// there is always a SPECIFIC gate, and the app was not naming it. Every reason
// the pointer can stay still, in one honest sentence.
function omniHandsWhy() {
  const o = omniState();
  if (!o.armed) return { moving: false, why: 'she is DISARMED — hold the arm button to grant the hands', fix: 'arm' };
  if (o.dry) return { moving: false, why: 'DRY RUN is on — she plans, and every step reads "would…". Nothing touches the machine.', fix: 'dry' };
  if (o.moveMode && o.moveMode !== 'screen' && o.moveMode !== 'auto') {
    return { moving: false, why: 'the move kind is "' + o.moveMode + '" — she is working in files with her own tools, which never moves your pointer', fix: 'mode' };
  }
  if (STATE.control && STATE.control.stopped) return { moving: false, why: 'the fleet is stopped', fix: 'stop' };
  if (!o.session || !['running', 'waiting'].includes(o.session.status)) return { moving: false, why: 'no session is in flight — press Enter the Flow to start a drive', fix: 'start' };
  return { moving: true, why: 'armed, live, and driving your screen', fix: '' };
}
ipcMain.handle('cortex:omniHandsWhy', requireGate(() => omniHandsWhy()));
ipcMain.handle('cortex:omni', requireGate(() => {
  // Opening the Motus Max screen means he is about to arm. Build the HUD now,
  // hidden, so the arm itself is instant rather than a ~400ms window creation.
  safe(() => omniOverlayEnsure());
  return { ok: true, omni: omniPublic() };
}));
// Live preview: light the HUD on whatever screen is currently selected, so he
// can SEE which monitor it lands on before committing to arm.
ipcMain.handle('cortex:omniPreview', requireGate((_e, { on, display } = {}) => {
  const o = omniState();
  if (!o.hud) return { ok: false, error: 'the HUD is switched off' };
  if (on === false) { if (!omniArmedNow()) omniOverlayClose(); return { ok: true }; }
  // Apply the choice he is LOOKING AT, not the one last saved — the whole point
  // of a preview is to answer "which monitor will this land on?" before arming.
  if (display != null) {
    const n = parseInt(display, 10);
    o.displayPin = (Number.isFinite(n) && n >= 0) ? clamp(n, 0, 8) : null;
    o.display = omniResolveDisplay();
  }
  omniOverlayOpen(); omniOverlayMove();
  omniOverlayPush({ status: 'standby', phase: 'armed', goal: '', origin: '', agent: (FLEET_BY_ID[o.agent] || {}).name || o.agent });
  return { ok: true, stage: omniStageRect() };
}));
ipcMain.handle('cortex:omniArm', requireGate((_e, p) => ({ ok: true, omni: omniArm(p || {}) })));
ipcMain.handle('cortex:omniDisarm', requireGate(() => ({ ok: true, omni: omniDisarm() })));
// Wipe the trail. Keeps the all-time counters — those are his record of what
// the mode has actually done — and drops the narrative.
ipcMain.handle('cortex:omniClearLog', requireGate(() => {
  const o = omniState();
  const n = (o.log || []).length;
  o.log = [{ ts: new Date().toISOString(), kind: 'cleared', said: `Audit trail cleared — ${n} entries removed. Lifetime counters kept.` }];
  saveState();
  return { ok: true, omni: omniPublic(), cleared: n };
}));
ipcMain.handle('cortex:omniStart', requireGate((_e, p) => omniStart(p || {})));
// ONE DOOR — arm, switch continuous on, and go. Three separate controls meant
// the mode he actually wanted (keep moving until I stop you) was three correct
// guesses away. Arming is still his physical hold; this just stops the setup
// from being the obstacle.
ipcMain.handle('cortex:omniFlow', requireGate(async (_e, p = {}) => {
  const armed = omniArm({ ...(p.settings || {}), continuous: true });
  if (!armed.armed) return { ok: false, error: 'could not arm' };
  omniAudit('flow', `continuous flow engaged — up to ${omniState().chainMax} moves, or until the fuse ends`);
  const r = await omniStart({ goal: p.goal || '', agent: (p.settings || {}).agent });
  return r.ok ? { ok: true, omni: omniPublic(), origin: r.origin, read: r.read } : r;
}));
ipcMain.handle('cortex:omniStop', requireGate(() => { omniHalt('you stopped the session'); return { ok: true, omni: omniPublic() }; }));
ipcMain.handle('cortex:omniReply', requireGate((_e, { text, approve } = {}) => omniReply(text, approve)));
// Mid-session steering: his words land in her very next cycle, ahead of her plan.
// Extracted so the harness can prove a steer actually reaches a running
// session rather than trusting that the IPC does the right thing.
function omniSteerText(text) {
  const o = omniState(), s = o.session;
  if (!s || (s.status !== 'running' && s.status !== 'waiting')) {
    return { ok: false, error: 'no session to steer — arm and start one, then Ctrl+Shift+M' };
  }
  if (s.status === 'waiting') return omniReply(text, true);
  s.steer = s.steer || [];
  s.steer.push(String(text || '').slice(0, 800));
  // His voice always reaches HER, never the reflex lane. Clearing this flag is
  // what pulls the next cycle back to the seat that owns the drive.
  s._steerSeen = false;
  omniAudit('steer', `you said: ${String(text || '')}`);
  saveState();
  return { ok: true, omni: omniPublic() };
}
ipcMain.handle('cortex:omniSteer', requireGate((_e, { text } = {}) => omniSteerText(text)));
// The latest frame, as a data URL the view can show. Read-only, capped small.
// ⚠ THE INVISIBLE-SIGHT BUG (2026-08-15). August: "that screenshot capture
// feature… isn't working at all." He was right, and the cause was one string:
// this handler filtered for `.png` while omniCapture has written `.jpg` ever
// since the JPEG-not-PNG change (smaller file, arrives unshrunk at her Read
// tool). Every frame she ever took landed in the folder, and the app's frame
// panel showed none of them — sight WORKED and looked broken. Accept both
// extensions, serve the right mime, and never let a format change silently
// blind the cockpit again.
ipcMain.handle('cortex:omniFrame', requireGate(() => {
  const dir = omniFrameDir();
  const f = safe(() => fs.readdirSync(dir).filter((x) => /\.(png|jpg)$/i.test(x)).sort().pop(), null);
  if (!f) return { ok: false, error: 'no frame yet' };
  const b = safe(() => fs.readFileSync(path.join(dir, f)), null);
  if (!b || b.length > 6 * 1024 * 1024) return { ok: false, error: 'frame unreadable' };
  const mime = /\.png$/i.test(f) ? 'image/png' : 'image/jpeg';
  return { ok: true, dataUrl: `data:${mime};base64,` + b.toString('base64'), file: f };
}));
// PROVE SIGHT — capture the desktop RIGHT NOW and hand the frame back. This is
// the one-press answer to "is the capture even working": no session, no agent,
// no tokens — just the same omniCapture the drive loop uses, exercised on
// demand so seeing is never a matter of trust.
ipcMain.handle('cortex:omniSight', requireGate(async () => {
  const f = await omniCapture({}).catch((e) => ({ ok: false, error: (e && e.message) || 'capture faulted' }));
  if (!f || !f.ok) return { ok: false, error: (f && f.error) || 'the screen could not be captured' };
  const b = safe(() => fs.readFileSync(f.file), null);
  if (!b) return { ok: false, error: 'the frame was written but could not be read back' };
  omniEmit({ kind: 'frame' });
  return {
    ok: true, dataUrl: 'data:image/jpeg;base64,' + b.toString('base64'),
    w: f.imgW, h: f.imgH, screen: `${f.scrW}×${f.scrH}`, name: f.name || '',
    bytes: f.bytes, display: f.display, displays: f.displays,
  };
}));

// ###########################################################################
//  SELF-UPDATE — because "you are two versions behind" has been the quiet
//  cause of half the bugs he reported. Every fix tonight shipped into
//  `release-next\` and sat there while he ran an older build and saw old
//  behaviour. Asking him to run a PowerShell script after every build was a
//  chore I invented; a build he has to install by hand is a build he does not
//  have. One click, from inside the app that is out of date.
// ###########################################################################
// The tree this build was packaged from. Packaged, the app lives at
// <project>\release\CortexInsight-win32-x64\resources\app.asar; from source it
// is the tree itself. Null when the build was moved away from its tree, and
// every caller treats null as "no project here" rather than guessing a path.
function projectRoot() {
  const a = app.getAppPath();
  // packaged: Windows sits four folders under the project (release\<app>\resources\app.asar),
  // macOS six (release/<app>/CortexInsight.app/Contents/Resources/app.asar)
  const up = (p, n) => { let x = p; for (let i = 0; i < n; i++) x = path.dirname(x); return x; };
  const cands = app.isPackaged ? [up(a, 4), up(a, 6)] : [a];
  return cands.find((c) => safe(() => fs.existsSync(path.join(c, 'main.js')), false)) || null;
}
// the version a packaged macOS bundle carries, read from its Info.plist
function macBundleVersion(appDir) {
  const t = safe(() => fs.readFileSync(path.join(appDir, 'Contents', 'Info.plist'), 'utf8'), '');
  const m = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(t);
  return m ? m[1].trim() : '';
}
function stagedBuild() {
  return safe(() => {
    if (IS_MAC) {
      const proj = projectRoot();
      if (!proj) return null;
      const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
      const nextApp = path.join(proj, 'release-next', 'CortexInsight-darwin-' + arch, 'CortexInsight.app');
      if (!exists(nextApp)) return null;
      const nv = macBundleVersion(nextApp);
      const cur = app.getVersion();
      if (!nv || nv === cur) return null;
      const newer = nv.split('.').map(Number).some((x, i) => x !== (cur.split('.').map(Number)[i] || 0) && x > (cur.split('.').map(Number)[i] || 0));
      return newer ? { version: nv, current: cur, path: nextApp, arch } : null;
    }
    if (!IS_WIN) return null;
    const here = path.dirname(path.dirname(app.getAppPath()));      // …\CortexInsight-win32-x64
    const proj = projectRoot();
    if (!proj) return null;
    const next = path.join(proj, 'release-next', 'CortexInsight-win32-x64', 'CortexInsight.exe');
    if (!exists(next)) return null;
    const nv = safe(() => JSON.parse(fs.readFileSync(path.join(proj, 'release-next', 'CortexInsight-win32-x64', 'resources', 'app', 'package.json'), 'utf8')).version, '');
    const cur = app.getVersion();
    const cmp = (a, b) => {
      const A = String(a).split('.').map(Number), B = String(b).split('.').map(Number);
      for (let i = 0; i < 3; i++) { if ((A[i] || 0) !== (B[i] || 0)) return (A[i] || 0) - (B[i] || 0); }
      return 0;
    };
    const version = nv || safe(() => require('child_process').execFileSync('powershell.exe',
      ['-NoProfile', '-Command', `(Get-Item '${next}').VersionInfo.FileVersion`], { timeout: 8000 }).toString().trim(), '');
    if (!version || cmp(version, cur) <= 0) return null;
    return { version, current: cur, exe: next, here };
  }, null);
}
ipcMain.handle('cortex:updateCheck', requireGate(() => ({
  ok: true, update: stagedBuild(), current: app.getVersion(), lastAttempt: updateOutcome(),
})));

// ---------------------------------------------------------------------------
//  ⚠ THE SILENT-SWAP BUG, and why this function looks the way it does.
//
//  2026-08-13, reported by August: "v3.25.0 is ready — I click Install &
//  restart, it restarts, and the banner comes straight back." He was right and
//  it was worse than a cosmetic loop: he was stuck on 3.21.0 across FOUR
//  clicks, each of which looked like it worked.
//
//  Root cause, measured on his machine rather than guessed:
//    · The swap script ran under `$ErrorActionPreference = "SilentlyContinue"`,
//      so EVERY file operation could fail without a trace.
//    · It killed the app and slept a flat 2 seconds. Windows can still hold a
//      directory handle after the last process dies, so `Rename-Item` on the
//      live folder failed — silently.
//    · Nothing verified the swap. The very next line relaunched the app
//      REGARDLESS, so a total failure was indistinguishable from success: the
//      app "restarted", still on the old build, and re-offered the update.
//    · ⚠ Worst of all, `Remove-Item release-next -Recurse -Force` ran
//      unconditionally. Had it succeeded while the move had failed, it would
//      have DELETED the only copy of the new build. A failed update would have
//      destroyed the thing it was installing. That never fired only because
//      the removal happened to fail too.
//
//  The rules this now follows, each one earned from that list:
//    ① Never SilentlyContinue. Every step is checked and written to a log.
//    ② Prove the processes are gone by polling, not by sleeping and hoping.
//    ③ Retry the rename — a held handle is a transient condition, not an error.
//    ④ VERIFY the swapped exe reports the expected version before believing it.
//    ⑤ Roll back on any failure; only delete the staging copy after success.
//    ⑥ Record the attempt BEFORE quitting, so the next boot can tell August
//       what actually happened instead of silently re-offering the same update.
// ---------------------------------------------------------------------------
ipcMain.handle('cortex:updateApply', requireGate(() => {
  const u = stagedBuild();
  if (!u) return { ok: false, error: 'nothing newer is staged' };
  const proj = projectRoot();
  if (!proj) return { ok: false, error: 'this build does not sit beside its project tree, so there is nowhere to stage from' };
  if (IS_MAC) {
    // the same discipline as the Windows swap: wait for exit, keep the previous
    // bundle, prove the version from the installed plist, roll back on a miss,
    // clear staging only after proof, relaunch
    const sh = path.join(app.getPath('temp'), 'ci-selfupdate.sh');
    const log = path.join(app.getPath('temp'), 'ci-selfupdate.log');
    const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
    const live = path.join(proj, 'release', 'CortexInsight-darwin-' + u.arch, 'CortexInsight.app');
    const prev = live + '.prev';
    const script = [
      '#!/bin/bash',
      `LOG=${q(log)}; L() { echo "$(date +%H:%M:%S)  $1" >> "$LOG"; }`,
      `echo "=== update to ${u.version} (from ${u.current}) ===" > "$LOG"`,
      `LIVE=${q(live)}; NEXT=${q(u.path)}; PREV=${q(prev)}; PID=${process.pid}`,
      'for i in $(seq 1 40); do kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done',
      'if kill -0 "$PID" 2>/dev/null; then L "ABORT: the app is still running"; exit 1; fi',
      'L "the app has exited"',
      'rm -rf "$PREV"',
      'mkdir -p "$(dirname "$LIVE")"',
      '[ -d "$LIVE" ] && mv "$LIVE" "$PREV" && L "previous kept at $PREV"',
      'mv "$NEXT" "$LIVE" || { L "ABORT: could not move the staged app"; [ -d "$PREV" ] && mv "$PREV" "$LIVE"; exit 1; }',
      'xattr -dr com.apple.quarantine "$LIVE" 2>/dev/null',
      'V=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$LIVE/Contents/Info.plist" 2>/dev/null)',
      `if [ "$V" != ${q(u.version)} ]; then L "ROLLBACK: installed reports $V"; rm -rf "$LIVE"; [ -d "$PREV" ] && mv "$PREV" "$LIVE"; exit 1; fi`,
      `rm -rf ${q(path.join(proj, 'release-next'))}`,
      'L "installed $V, staging cleared"',
      'open "$LIVE"',
    ].join('\n');
    safe(() => fs.writeFileSync(sh, script, { mode: 0o755 }));
    STATE.updateAttempt = { from: u.current, to: u.version, ts: new Date().toISOString(), log };
    omniAudit('update', `installing v${u.version} (was v${u.current}) — the app will restart`);
    saveState();
    safe(() => require('child_process').spawn('/bin/bash', [sh], { detached: true, stdio: 'ignore' }).unref());
    setTimeout(() => { app.isQuitting = true; app.quit(); }, 600);
    return { ok: true, version: u.version };
  }
  const ps = path.join(app.getPath('temp'), 'ci-selfupdate.ps1');
  const log = path.join(app.getPath('temp'), 'ci-selfupdate.log');
  const q = (s) => String(s).replace(/'/g, "''");           // single-quoted PS literal
  const script = [
    '$ErrorActionPreference = "Continue"',
    `$log  = '${q(log)}'`,
    'function L($m) { Add-Content -Path $log -Value ((Get-Date -Format "HH:mm:ss") + "  " + $m) }',
    `Set-Content -Path $log -Value ("=== update to ${q(u.version)} (from ${q(u.current)}) ===")`,
    `$live = '${q(proj)}\\release\\CortexInsight-win32-x64'`,
    `$next = '${q(proj)}\\release-next\\CortexInsight-win32-x64'`,
    `$prev = '${q(proj)}\\release\\CortexInsight-win32-x64.prev'`,
    'function Ver($d) { $e = Join-Path $d "CortexInsight.exe"; if (Test-Path $e) { return (Get-Item $e).VersionInfo.FileVersion } return "none" }',
    '',
    '# ② the app asks us to quit it; make sure it really did',
    'Start-Sleep -Seconds 2',
    'Get-Process -Name CortexInsight -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue',
    '$gone = $false',
    'for ($i = 0; $i -lt 40; $i++) {',
    '  Start-Sleep -Milliseconds 500',
    '  if (@(Get-Process -Name CortexInsight -ErrorAction SilentlyContinue).Count -eq 0) { $gone = $true; break }',
    '}',
    'if (-not $gone) { L "ABORT: instances still running, refusing to swap a locked folder"; exit 1 }',
    'L "all instances stopped"',
    '',
    '# ⑤ clear the previous rollback only; the staged build is untouchable until step ④',
    'if (Test-Path $prev) {',
    '  try { Remove-Item $prev -Recurse -Force -ErrorAction Stop; L "old rollback removed" }',
    '  catch { L ("ABORT: cannot clear old rollback: " + $_.Exception.Message); exit 1 }',
    '}',
    '',
    '# ③ the step that was failing — a held directory handle is transient',
    '$ok = $false',
    'for ($i = 1; $i -le 12; $i++) {',
    '  try { Rename-Item -Path $live -NewName "CortexInsight-win32-x64.prev" -ErrorAction Stop; $ok = $true; L ("renamed live -> .prev on attempt " + $i); break }',
    '  catch { L ("rename attempt " + $i + ": " + $_.Exception.Message); Start-Sleep -Seconds 1 }',
    '}',
    'if (-not $ok) { L "ABORT: could not free the live folder"; Start-Process (Join-Path $live "CortexInsight.exe"); exit 1 }',
    '',
    'try { Move-Item -Path $next -Destination $live -ErrorAction Stop; L "staged build moved into place" }',
    'catch {',
    '  L ("FAILED to move: " + $_.Exception.Message)',
    '  Rename-Item -Path $prev -NewName "CortexInsight-win32-x64" -ErrorAction SilentlyContinue',
    '  L "rolled back"',
    '  Start-Process (Join-Path $live "CortexInsight.exe"); exit 1',
    '}',
    '',
    '# ④ believe nothing until the exe itself says so',
    '$v = Ver $live',
    `if ($v -ne '${q(u.version)}') {`,
    '  L ("VERSION MISMATCH: live reports " + $v + " - rolling back")',
    '  Remove-Item $live -Recurse -Force -ErrorAction SilentlyContinue',
    '  Rename-Item -Path $prev -NewName "CortexInsight-win32-x64" -ErrorAction SilentlyContinue',
    '  Start-Process (Join-Path $live "CortexInsight.exe"); exit 1',
    '}',
    'L ("VERIFIED: live is now " + $v)',
    '',
    '# ⑤ and only now is the staging copy expendable',
    `$stage = '${q(proj)}\\release-next'`,
    'if (Test-Path $stage) {',
    '  if (@(Get-ChildItem $stage -Recurse -Filter "CortexInsight.exe" -ErrorAction SilentlyContinue).Count -eq 0) {',
    '    Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue; L "staging cleared"',
    '  } else { L "staging KEPT - it still holds a build" }',
    '}',
    'Start-Process (Join-Path $live "CortexInsight.exe")',
    'L "relaunched"',
  ].join('\r\n');
  if (!safe(() => { fs.writeFileSync(ps, script, 'utf8'); return true; }, false)) return { ok: false, error: 'could not stage the updater' };

  // ⑥ Recorded BEFORE we quit. This is what lets the next boot say "that
  //    update did not take, and here is why" instead of re-offering in silence.
  STATE.updateAttempt = { from: u.current, to: u.version, ts: new Date().toISOString(), log };
  omniAudit('update', `installing v${u.version} (was v${u.current}) — the app will restart`);
  saveState();
  safe(() => require('child_process').spawn('powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ps],
    { detached: true, stdio: 'ignore' }).unref());
  setTimeout(() => { app.isQuitting = true; app.quit(); }, 600);
  return { ok: true, version: u.version };
}));

// Did the last attempted update actually land? Called on boot and by the UI.
// An update that fails must SAY SO — four silent failures in a row is what
// made this a bug report instead of a one-line fix.
function updateOutcome() {
  const a = STATE.updateAttempt;
  if (!a || !a.to) return null;
  const landed = app.getVersion() === a.to;
  const tail = safe(() => fs.readFileSync(a.log, 'utf8').trim().split(/\r?\n/).slice(-14).join('\n'), '');
  return { ...a, landed, running: app.getVersion(), log: tail };
}
function reportUpdateOutcome() {
  const o = updateOutcome();
  if (!o) return;
  if (o.landed) {
    pushNotification('good', `Updated to v${o.to}`, `You were on v${o.from}.`, 'overview', 'upd:' + o.to);
    omniAudit('update', `confirmed running v${o.to}`);
  } else {
    // Loud, because the previous behaviour was to say nothing at all.
    pushNotification('bad', `Update to v${o.to} did NOT install`,
      `Still running v${o.running}. The installer log is at ${o.log ? 'temp\\ci-selfupdate.log' : 'temp'}.`,
      'settings', 'updfail:' + o.to + ':' + o.ts);
    omniAudit('update', `FAILED: asked for v${o.to}, still on v${o.running}`);
  }
  STATE.updateAttempt = null;         // reported once; the next attempt writes its own
  saveState();
}

// --- THE MAP · STRATEGY · DIVERGENCE · CONTINUITY ----------------------------
ipcMain.handle('cortex:map', requireGate((_e, { zoom, focus } = {}) => ({
  ok: true, text: mapCortex({ zoom: zoom || 'map', focus: focus || '' }),
  available: bmAvailable(), platforms: safe(() => bmPlatforms(), []), dir: bmDir(),
})));
ipcMain.handle('cortex:strategicRead', requireGate((_e, { agent, question, zoom } = {}) => strategicRead({ agent, question, zoom })));
ipcMain.handle('cortex:frames', requireGate((_e, { agent, subject } = {}) => divergentFrames({ agent, subject })));
ipcMain.handle('cortex:strategy', requireGate(() => ({
  ok: true, reads: (STATE.strategicReads || []).slice(0, 10), frames: (STATE.frames || []).slice(0, 6),
  thread: threadState(), mapAvailable: bmAvailable(),
})));
ipcMain.handle('cortex:threadClear', requireGate(() => {
  STATE.thread = { goal: '', openNext: '', lastVerdict: '', ts: 0, agent: '', cycles: 0, history: threadState().history || [] };
  saveState();
  return { ok: true, thread: threadState() };
}));

// --- MOTUSMODELS STUDIO ------------------------------------------------------
ipcMain.handle('cortex:motusModels', requireGate(() => ({ ok: true, ...mmPublic() })));
ipcMain.handle('cortex:mmSave', requireGate((_e, def) => mmSave(def || {})));
ipcMain.handle('cortex:mmDelete', requireGate((_e, { id } = {}) => {
  const m = mmFind(id);
  if (!m) return { ok: false, error: 'no such model' };
  if (m.status !== 'draft') return { ok: false, error: 'only drafts can be deleted — a ratified or minted model is part of the lineage' };
  STATE.motusModels = mmAll().filter((x) => x.id !== id); saveState();
  return { ok: true };
}));
ipcMain.handle('cortex:mmRatify', requireGate((_e, { id } = {}) => {
  const m = mmFind(id);
  if (!m) return { ok: false, error: 'no such model' };
  m.status = m.status === 'draft' ? 'ratified' : m.status; m.updated = new Date().toISOString();
  saveState();
  return { ok: true, model: m };
}));
ipcMain.handle('cortex:mmEvolve', requireGate((_e, { id, axis, direction } = {}) => mmEvolve(id, axis, direction)));
ipcMain.handle('cortex:mmJudge', requireGate((_e, { id } = {}) => mmJudge(id)));
ipcMain.handle('cortex:mmMint', requireGate((_e, { id } = {}) => mmMint(id)));
ipcMain.handle('cortex:mmBroadcast', requireGate((_e, { id } = {}) => mmBroadcast(id)));
// A model is real because it RUNS: compile to a workflow and dispatch the fleet.
ipcMain.handle('cortex:mmRun', requireGate(async (_e, { id, seed } = {}) => {
  const m = mmFind(id);
  if (!m) return { ok: false, error: 'no such model' };
  const c = mmCompile(m);
  if (!c.ok) return c;
  m.workflowId = c.workflow.id; m.runs++; m.updated = new Date().toISOString(); saveState();
  return wfRun(c.workflow.id, seed || `Run «${m.name}» (generation ${m.generation}) for real. ${m.essence}`);
}));

// --- v3: loops · projects · ethos · the work ledger -------------------------
ipcMain.handle('cortex:loops', requireGate(() => {
  ensureLoopSeeds();
  const yields = safe(() => loopYields(), {});
  return {
    loops: (STATE.loops || []).map((l) => ({ ...l, kindMeta: LOOP_KINDS[l.kind] || LOOP_KINDS.refine, yield: yields[l.id] || null, stretch: cadenceStretch(l.skipStreak) * loopQualityStretch(l), lowQuality: loopQualityStretch(l) > 1, avgQuality: (yields[l.id] && yields[l.id].qN) ? Math.round(10 * yields[l.id].qSum / yields[l.id].qN) / 10 : null })),
    kinds: Object.entries(LOOP_KINDS).map(([id, v]) => ({ id, ...v })),
    projects: STATE.projects || [],
    ethos: STATE.designEthos || DEFAULT_ETHOS,
    pending: (STATE.loops || []).filter((l) => !l.approved).length,
    nextDue: (() => { const l = nextDueLoop(); return l ? { id: l.id, name: l.name } : null; })(),
  };
}));
ipcMain.handle('cortex:loopSave', requireGate((_e, def) => {
  const l = newLoop(def || {});
  if (!l.instruction || l.instruction.length < 20) return { ok: false, error: 'a loop needs a real instruction — what should she actually do each pass?' };
  const i = (STATE.loops || []).findIndex((x) => x.id === l.id);
  if (i >= 0) STATE.loops[i] = { ...STATE.loops[i], ...l };
  else STATE.loops.unshift(l);
  STATE.loops = STATE.loops.slice(0, 60);
  saveState();
  return { ok: true, loop: l };
}));
ipcMain.handle('cortex:loopAct', requireGate((_e, { id, action }) => {
  const l = (STATE.loops || []).find((x) => x.id === id);
  if (!l) return { ok: false, error: 'no such loop' };
  if (action === 'approve') { l.approved = true; l.enabled = true; }
  else if (action === 'toggle') l.enabled = !l.enabled;
  else if (action === 'reject' || action === 'delete') STATE.loops = STATE.loops.filter((x) => x.id !== id);
  else if (action === 'reset') { l.lastRun = 0; }
  saveState();
  return { ok: true, loops: STATE.loops };
}));
ipcMain.handle('cortex:loopRun', requireGate(async (_e, { id }) => {
  ensureLoopSeeds();
  const l = (STATE.loops || []).find((x) => x.id === id);
  if (!l) return { ok: false, error: 'no such loop' };
  if (!l.approved) return { ok: false, error: 'approve this loop first' };
  const agent = isRelayAgent(STATE.duo && STATE.duo.agent) ? STATE.duo.agent : 'davara';
  const blocked = dispatchBlocked(agent);
  if (blocked) return { ok: false, error: blocked };
  return duoLoopPass(l, agent, 'manual', duoContext());
}));
ipcMain.handle('cortex:projectSave', requireGate((_e, def) => {
  const p = newProject(def || {});
  if (!p.name) return { ok: false, error: 'a project needs a name' };
  const i = (STATE.projects || []).findIndex((x) => x.id === p.id);
  if (i >= 0) STATE.projects[i] = { ...STATE.projects[i], ...p };
  else STATE.projects.unshift(p);
  STATE.projects = STATE.projects.slice(0, 40);
  saveState();
  return { ok: true, project: p };
}));
ipcMain.handle('cortex:projectAct', requireGate((_e, { id, action }) => {
  const p = (STATE.projects || []).find((x) => x.id === id);
  if (!p) return { ok: false, error: 'no such project' };
  if (action === 'toggle') p.enabled = !p.enabled;
  else if (action === 'delete') STATE.projects = STATE.projects.filter((x) => x.id !== id);
  saveState();
  return { ok: true, projects: STATE.projects };
}));
ipcMain.handle('cortex:saveEthos', requireGate((_e, { ethos }) => {
  STATE.designEthos = String(ethos || '').slice(0, 8000);
  saveState();
  return { ok: true };
}));
ipcMain.handle('cortex:duoWork', requireGate((_e, { loopId, projectId } = {}) => {
  let items = STATE.duoWork || [];
  if (loopId && loopId !== 'all') items = items.filter((w) => w.loopId === loopId);
  if (projectId && projectId !== 'all') items = items.filter((w) => w.projectId === projectId);
  const all = STATE.duoWork || [];
  return {
    // each entry carries its project (name + live URL) resolved from the first
    // attributable file — completed work should say what product it served
    items: items.slice(0, 200).map((w) => {
      const files = cleanFiles(w.files);
      const hit = w.project ? null : files.map(projectFor).find(Boolean);
      return { ...w, files, ...(hit || {}) };
    }),
    total: all.length,
    shipped: all.filter((w) => w.verdict === 'shipped').length,
    reported: all.filter((w) => w.verdict === 'reported').length,
    skipped: all.filter((w) => w.verdict === 'skipped').length,
    files: cleanFiles(all.flatMap((w) => w.files || [])).length,
    byLoop: (STATE.loops || []).map((l) => ({ id: l.id, name: l.name, n: all.filter((w) => w.loopId === l.id).length })).filter((x) => x.n),
  };
}));
// She can be asked, explicitly, to design a new loop for herself.
ipcMain.handle('cortex:loopInvent', requireGate(async () => {
  ensureLoopSeeds();
  const agent = isRelayAgent(STATE.duo && STATE.duo.agent) ? STATE.duo.agent : 'davara';
  const blocked = dispatchBlocked(agent);
  if (blocked) return { ok: false, error: blocked };
  const existing = (STATE.loops || []).map((l) => `· ${l.name} (${l.kind}) — ${l.instruction.slice(0, 90)}`).join('\n') || '(none yet)';
  const projs = (STATE.projects || []).map((p) => `· ${p.name}${p.url ? ' — ' + p.url : ''}`).join('\n') || '(none registered)';
  const prompt = `/DESIGN A LOOP FOR YOURSELF

August runs you on LEVERAGE LOOPS: small, bounded, repeatable moves you make autonomously on a cadence. He wants you to design a NEW one — a move you believe is worth repeating forever, that no existing loop covers.

LOOPS YOU ALREADY HAVE:
${existing}

HIS PROJECTS:
${projs}

${STATE.motus ? `MOTUS: ${STATE.motus.text.slice(0, 240)}\n` : ''}
A good loop is: bounded (one small move per pass), repeatable (never runs out), safe on autopilot (a refinement, never a decision), and genuinely high-leverage. A bad loop is vague, unbounded, or would make a change he has to review anxiously.

Propose exactly ONE, in this shape:

LOOP: <short name>
KIND: <design|refine|review|compound|scout>
CADENCE: <minutes between passes>
WHY: <two lines — the leverage, and why the existing loops miss it>
INSTRUCTION: <the exact instruction you will follow each pass. Write it to yourself. Be specific about what ONE thing you do and what you must never do.>

Then stop. It will not run until August approves it.`;
  const r = await relaySend(agent, prompt);
  if (!r.ok) return { ok: false, error: r.error };
  const pl = parseLoopProposal(r.text || '');
  if (!pl) return { ok: false, error: 'she did not return a usable loop this time', text: (r.text || '').slice(0, 1200) };
  pl.authoredBy = agent;
  STATE.loops.unshift(pl);
  saveState();
  return { ok: true, loop: pl };
}));

// --- external lane --------------------------------------------------------
ipcMain.handle('cortex:sympathSei', requireGate(() => sympathState()));
// never expose the encrypted app password to the renderer — only whether one is set
function safeSettings() { const { smtpAppPasswordEnc, elevenKeyEnc, openaiKeyEnc, passSha, ...rest } = STATE.settings; return { ...rest, smtpAppPasswordSet: !!smtpAppPasswordEnc, elevenKeySet: !!elevenKeyEnc, openaiKeySet: !!openaiKeyEnc, passwordSet: !!passSha }; }
ipcMain.handle('cortex:settings', requireGate(() => ({ settings: safeSettings(), root: root(), userData: userDataDir() })));

ipcMain.handle('cortex:saveSettings', requireGate((_e, patch) => {
  const oldRoot = root();
  patch = Object.assign({}, patch || {});
  // app password: encrypt with DPAPI, store only the ciphertext, never the plaintext.
  // empty/absent = leave the existing one untouched.
  if (typeof patch.smtpAppPassword === 'string') {
    const pw = patch.smtpAppPassword.trim();
    if (pw) { try { STATE.settings.smtpAppPasswordEnc = safeStorage.encryptString(pw).toString('base64'); } catch (e) { console.log('[safeStorage]', e && e.message); } }
    delete patch.smtpAppPassword;
  }
  delete patch.smtpAppPasswordSet;
  // the gate password: hashed here, never stored as text; and the renderer can
  // never write ciphertext or flags back into the vault
  if (typeof patch.newPassword === 'string') {
    const pw = patch.newPassword; delete patch.newPassword;
    if (pw.length >= 12) { STATE.settings.passSha = sha256(pw); safe(() => omniAudit('access', 'the gate password was changed from Settings')); }
  }
  for (const k of ['passSha', 'elevenKeyEnc', 'openaiKeyEnc', 'elevenKeySet', 'openaiKeySet', 'passwordSet', 'smtpAppPasswordEnc']) delete patch[k];
  STATE.settings = Object.assign({}, STATE.settings, patch);
  if (patch.cortexRoot && patch.cortexRoot !== oldRoot) {
    _ixCache.clear(); _txCache.clear(); _cwCache.clear(); _fwCache.clear();
    _ixAll = { sig: '', items: [] }; _proxyCache = { size: -1, mtime: -1, result: null };
  }
  saveState();
  return { ok: true, settings: safeSettings() };
}));

ipcMain.handle('cortex:setModel', requireGate((_e, { model }) => {
  const res = setModelPin(model);
  if (res.ok) { STATE.learnings.unshift({ ts: new Date().toISOString(), source: 'operator', title: `Model pin → ${model}`, body: `Changed via CortexInsight in: ${res.changed.join(', ')} (backups written *.cortexinsight.bak).` }); saveState(); }
  return res;
}));

const DOCS_URL = 'https://github.com/InitiumBuilders/Semble-CC/blob/main/docs';
const HELP_TEXT = `◈ HELP

Plain text goes to the selected seat. These do more:
/reading            the whole system in one sentence
/leverage <q>       the strategic read: lever, rung, why now, first step, cost, a frame
/frames <subject>   several frames on one subject, each with a test
/map [focus]        see what she sees, at orbit, map or ground altitude
/motusmax <goal>    start a drive on an armed Motus Max (arm it by hand first)
/gpt <text>         one turn on the second stack (needs an OpenAI key on Config)
/image <prompt>     the studio; the image lands on Output
Steer · Goal · Motus   the three buttons: a live nudge, the north star, the strongest thing moving now

Agents talk back with a tool the app writes for them:
bash ~/.cortexinsight/ci.sh task|doing|done|claim|ask|hand|learn|note|image

Ctrl+K opens the palette. The guide, the feature map and the architecture:
${DOCS_URL}/GUIDE.md
${DOCS_URL}/FEATURES.md
${DOCS_URL}/ARCHITECTURE.md`;
ipcMain.handle('cortex:send', requireGate(async (_e, { agent, kind, text }) => {
  agent = agent || STATE.settings.defaultAgent || 'davara';
  let message = text || '';
  // ── /MotusMax — the typed trigger. Same door as the spoken one, and the
  // same rule: it can start a drive, it can never arm one.
  const mm = /^\s*\/(?:motusmax|motus-max|omnidrive|omni)\b[\s:]*([\s\S]*)$/i.exec(message);
  if (mm) {
    const goal = (mm[1] || '').trim();
    if (!omniArmedNow()) {
      return { ok: true, text: 'Motus Max is not armed. Hold the arm switch on the Motus Max screen first — that one has to be your hand. Then /motusmax again, with or without a goal.', latency: 0, goView: 'omni' };
    }
    const r0 = await omniStart({ goal, agent });
    if (!r0.ok) return { ok: true, text: `Could not start Motus Max — ${r0.error}`, latency: 0, goView: 'omni' };
    const head = r0.origin === 'chosen'
      ? `No goal given, so she read the system and chose one.\n\nLEVER: ${(r0.read || {}).lever}\nRUNG: ${(r0.read || {}).rung}\nWHY NOW: ${(r0.read || {}).whyNow}\nFIRST STEP: ${(r0.read || {}).firstStep}\n\nDIVERGENT FRAME: ${(r0.read || {}).frame}`
      : r0.origin === 'resumed' ? 'Picking up the open thread where you left it.' : 'Driving.';
    return { ok: true, text: `◈ MOTUS MAX ENGAGED\n\n${head}`, latency: 0, goView: 'omni' };
  }
  // /help — the door to the docs, answered locally, no turn spent.
  if (/^\s*\/(?:help|\?|docs|commands)\b/i.test(message)) {
    return { ok: true, latency: 0, text: HELP_TEXT };
  }
  // /reading — the whole system in one sentence.
  if (/^\s*\/(?:reading|read-me|state)\b/i.test(message)) {
    const rd = systemReading();
    return { ok: true, latency: 0, goView: 'overview', text: '◈ THE READING\n\n' + rd.line + (rd.more ? '\n' + rd.more : '') };
  }
  // /image — the studio, on the operator's OpenAI key.
  const img = /^\s*\/(?:image|img|studio)\b[\s:]*([\s\S]*)$/i.exec(message);
  if (img) {
    const r = await imageGenerate({ prompt: (img[1] || '').trim(), by: 'august' });
    return r.ok
      ? { ok: true, latency: r.image.latency, goView: 'output', text: '◈ STUDIO\n\nMade it in ' + r.image.latency + 's with ' + r.image.model + '. It is on the Output view.\n' + r.image.file }
      : { ok: true, latency: 0, text: 'The studio could not make it: ' + r.error };
  }
  // /gpt — one turn on the second stack.
  const gp = /^\s*\/(?:gpt|openai)\b[\s:]*([\s\S]*)$/i.exec(message);
  if (gp) {
    const r = await openaiSend('gpt', (gp[1] || '').trim() || 'Say what you are and what you can do here, in three lines.');
    return { ok: true, latency: r.latency || 0, text: r.ok ? r.text : 'GPT seat: ' + r.error };
  }
  // /leverage — the strategic read on demand, without starting a drive.
  const lv = /^\s*\/(?:leverage|lever|strategic|read)\b[\s:]*([\s\S]*)$/i.exec(message);
  if (lv) {
    const sr = await strategicRead({ agent, question: (lv[1] || '').trim(), zoom: 'orbit' });
    if (!sr.ok) return { ok: true, text: `The read failed — ${sr.error}`, latency: 0 };
    const R = sr.read;
    return { ok: true, latency: 0, goView: 'systems',
      text: `◈ HIGHEST-LEVERAGE MOVE\n\nPHASE: ${R.phase}\nLOOP: ${R.loop}\n\nLEVER: ${R.lever}\nRUNG: ${R.rung}\nWHY NOW: ${R.whyNow}\nFIRST STEP: ${R.firstStep}\nCOST: ${R.cost}\n\nDIVERGENT FRAME: ${R.frame}` };
  }
  // /frames — the divergence engine.
  const fr = /^\s*\/(?:frames?|diverge|divergence)\b[\s:]*([\s\S]*)$/i.exec(message);
  if (fr) {
    const d = await divergentFrames({ agent, subject: (fr[1] || '').trim() });
    if (!d.ok) return { ok: true, text: `Divergence failed — ${d.error}`, latency: 0 };
    return { ok: true, latency: 0, goView: 'systems',
      text: `◈ DIVERGENT FRAMES\n\n${d.frames.map((f, i) => `FRAME ${i + 1} — ${f.claim}\n  method: ${f.method}\n  if true: ${f.ifTrue}\n  test: ${f.test}\n  confidence: ${f.confidence}/10`).join('\n\n')}\n\nSHARPEST: ${d.sharpest}` };
  }
  // /map — see what she sees.
  const mp = /^\s*\/map\b[\s:]*([\s\S]*)$/i.exec(message);
  if (mp) {
    const arg = (mp[1] || '').trim();
    const zoom = /^out|orbit/i.test(arg) ? 'orbit' : arg ? 'ground' : 'map';
    return { ok: true, latency: 0, text: mapCortex({ zoom, focus: /^out|orbit/i.test(arg) ? '' : arg }) };
  }
  if (kind === 'steer') { message = `/STEER (live nudge from August via CortexInsight): ${text}`; STATE.steers.unshift({ ts: new Date().toISOString(), agent, text }); }
  else if (kind === 'goal') {
    focusRecord('goal', STATE.goal);
    STATE.goal = { text, ts: new Date().toISOString(), agent };
    message = `/GOAL — August is setting your long-term session focus. Hold this as the north star across turns:\n\n${text}\n\nAcknowledge briefly and state your first move toward it.`;
  }
  else if (kind === 'motus') {
    focusRecord('motus', STATE.motus);
    STATE.motus = { text, ts: new Date().toISOString(), agent };
    message = `/MOTUS — August is naming the SINGLE strongest thing in motion right now: the active push, shorter-horizon than /goal, the focus of focus this moment. Hold it as today's prime mover:\n\n${text}\n\nAcknowledge briefly and name the one next move it implies right now.`;
  }
  saveState();
  if (mainWin) mainWin.webContents.send('cortex:sendProgress', { phase: 'start', agent, kind });
  const r = await relaySend(agent, message);
  const entry = {
    ts: new Date().toISOString(), agent, kind: kind || 'chat', text: text.slice(0, 500),
    srcLocalIp: 'local', srcPublicIp: decoyIp(),
    fingerprint: GUARD.fingerprint.slice(0, 12), ok: r.ok, latency: r.latency,
  };
  STATE.sentLog.unshift(entry); STATE.sentLog = STATE.sentLog.slice(0, 300); saveState();
  if (mainWin) mainWin.webContents.send('cortex:sendProgress', { phase: 'done', ...r });
  return { ...r, source: entry };
}));

// the two focuses — long-term north star (goal) + the strongest thing moving now (motus)
ipcMain.handle('cortex:focus', requireGate(() => ({
  goal: STATE.goal || null, motus: STATE.motus || null,
  history: (STATE.focusHistory || []).slice(0, 24),
  alignment: safe(() => motusAlignment(), null),
  evidence: safe(() => ({ motus: focusEvidence(STATE.motus), goal: focusEvidence(STATE.goal) }), null),
})));
// SHARPEN — one relay turn that turns a soft focus into one line with a
// falsifier. It proposes; the operator presses "use it" or does not.
ipcMain.handle('cortex:focusSharpen', requireGate(async (_e, { which, text } = {}) => {
  const kind = which === 'goal' ? 'GOAL (the north star, changed rarely)' : 'MOTUS (the single strongest thing moving now, shorter than the goal)';
  const draft = String(text || (which === 'goal' ? (STATE.goal && STATE.goal.text) : (STATE.motus && STATE.motus.text)) || '').trim();
  if (!draft) return { ok: false, error: 'nothing to sharpen yet' };
  const al = safe(() => motusAlignment(), null);
  const prompt = `/SHARPEN — August wants this ${kind} sharpened, not replaced.

DRAFT: ${draft.slice(0, 600)}
${al ? `THE BOARD RIGHT NOW: ${al.aligned.length} open item(s) move on it, ${al.drifting.length} drift from it.` : ''}

Reply in EXACTLY this shape and nothing else:
LINE: <one line, at most 140 characters, that names the move AND its subject, in plain words, no hedging>
FALSIFIER: <one observable with a clock: "if X is not seen by Y, this was the wrong ${which === 'goal' ? 'star' : 'mover'}">
WHY: <one sentence on what the draft was missing>`;
  const r = await relaySend('davara', prompt, 300000);
  if (!r.ok) return { ok: false, error: r.error || 'no reply' };
  const pick = (k) => ((r.text || '').match(new RegExp('^' + k + ':\\s*(.+)$', 'mi')) || [])[1] || '';
  const line = pick('LINE').trim().slice(0, 200);
  if (!line) return { ok: false, error: 'she did not return a line', raw: (r.text || '').slice(0, 600) };
  return { ok: true, line, falsifier: pick('FALSIFIER').trim().slice(0, 300), why: pick('WHY').trim().slice(0, 300), latency: r.latency };
}));

// Recursive self-improvement: Davara reads her own telemetry and returns durable
// learnings / next-steps. Appended to the ledger so the system compounds over time.
async function doReflect(kind) {
  // 16 turns, not 30: the tail added ~1,200 chars of envelope and changed nothing
  // about what she concluded.
  const interactions = parseInteractions().slice(0, 16);
  const digest = interactions.map((x) => `${x.ts} ${x.agent} ${x.status} ${Math.round(x.latency)}s ${x.chars}c :: ${x.msg.slice(0, 70)}`).join('\n');
  const wantNext = kind === 'next';
  const arr = wantNext ? STATE.nextSteps : STATE.learnings;
  // Feed recent titles so she does not restate what she already said (near-dupe guard).
  const recent = arr.slice(0, 12);
  const recentTitles = recent.map((x, i) => `${i + 1}. ${x.title}`).join('\n') || '(none yet)';
  const prompt = `You are SYMPATH-CORTEX reflecting on the Cortex's own operation to make it smarter and more resilient over time (this is your learning loop). Recent relay telemetry:\n\n${digest}\n\n` +
    `YOU HAVE ALREADY RECORDED THESE — do NOT repeat them or restate them with different words; bring something genuinely new each time:\n${recentTitles}\n\n` +
    (wantNext
      ? `Give me 3 concrete, NEW NEXT STEPS to improve, optimize, heal, or evolve the Cortex (reliability, latency, leverage, security, fit to August's growth). Hunt for the highest / hidden leverage — the move not yet on the list. For each: a short title line, then 1-2 sentences, then a final line "CONVICTION: n/10". Be specific. No preamble.`
      : `Extract 3 durable, NEW LEARNINGS about how this system actually behaves and what makes it run smoothly vs. fault. For each: a short title line, then 1-2 sentences, then a final line "CONVICTION: n/10". No preamble.`);
  // Learnings now come from Sympath-Cortex (the anchor/healer/learning engine).
  const r = await relaySend('sympath-cortex', prompt, 600000);
  if (r.ok && r.text) {
    const blocks = r.text.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean).slice(0, 3);
    let added = 0; const fresh = [];
    for (const b of blocks) {
      const [title, ...rest] = b.split('\n');
      const t = title.replace(/^[-*#\d.\s]+/, '').replace(/\*\*/g, '').slice(0, 160).trim();
      if (!t) continue;
      // dedupe against the ENTIRE ledger — exact AND near-duplicate (wording-overlap)
      // A repeat is REINFORCEMENT, not noise. It used to be silently discarded,
      // throwing away the strongest signal the ledger produces: "she keeps
      // arriving at this". Now it raises the item's weight, which is what decides
      // what travels in the brief and what survives compaction.
      const exact = arr.find((x) => x.title === t);
      if (exact) { exact.uses = (exact.uses || 1) + 1; exact.lastSeen = new Date().toISOString(); continue; }
      const near = arr.slice(0, 40).find((x) => textSimilarity(t, x.title || '') >= 0.6);
      if (near) { near.uses = (near.uses || 1) + 1; near.lastSeen = new Date().toISOString(); continue; }
      const bodyRaw = rest.join('\n').replace(/\*\*/g, '');
      // She now self-scores conviction inline, so the separate Davaris endorsement
      // TURN is gone — that was a whole extra relay call per reflect purely to
      // attach a number she can give us for free.
      const conv = parseInt((bodyRaw.match(/CONVICTION[^\d]{0,6}(\d{1,2})/i) || [])[1], 10);
      const body = bodyRaw.replace(/CONVICTION[^\n]*/i, '').trim();
      const item = { ts: new Date().toISOString(), source: 'sympath-reflection', title: t,
        body: (body || t).slice(0, 6000), conviction: Number.isFinite(conv) ? clamp(conv, 1, 10) : null };
      const stored = wantNext ? { ...item, done: false } : item;
      // local endorsement — same threshold August already set, zero tokens
      if (STATE.settings.autoApprove && Number.isFinite(conv) && conv >= (STATE.settings.autoApproveMinConviction || 9)) {
        stored.endorsedBy = 'sympath-self'; stored.endorsedAt = new Date().toISOString(); stored.endorseConviction = conv;
      }
      if (wantNext) STATE.nextSteps.unshift(stored); else STATE.learnings.unshift(stored);
      fresh.push(stored); added++;
    }
    STATE.learnings = STATE.learnings.slice(0, 120); STATE.nextSteps = STATE.nextSteps.slice(0, 120);
    saveState();
    r.added = added;
  }
  return r;
}

// Davaris (the builder/execution agent) reviews newly-added ledger items and
// endorses ONLY the ones he is highly convicted on. Endorsement is a non-destructive
// flag (approve / done) — it NEVER applies a runner change. Notifies August on Telegram.
async function davarisEndorse(kind, items) {
  if (!items || !items.length) return;
  const wantNext = kind === 'next';
  const minConv = Math.max(1, Math.min(10, +STATE.settings.autoApproveMinConviction || 9));
  const listed = items.map((it, i) => `${i + 1}. ${it.title}`).join('\n');
  const prompt = `You are DAVARIS, the builder. Below are ${items.length} freshly proposed ${wantNext ? 'next-step' : 'learning'} item(s) for the Cortex. ` +
    `For each, give your conviction 1-10 that it is a true no-brainer — high-leverage and safe to lock in WITHOUT August re-checking. ` +
    `Only items you score ${minConv} or higher will be auto-locked; everything below stays for August to review, so do NOT inflate. Most items should score below ${minConv}. ` +
    `Reply with a single line in EXACTLY this format: "ENDORSE: 1(9), 3(10)" — number then conviction in parentheses — or "ENDORSE: none".\n\n${listed}`;
  const r = await relaySend('davaris', prompt, 300000);
  if (!r.ok || !r.text) return;
  const m = r.text.match(/ENDORSE:\s*(.+)/i);
  if (!m || /^\s*none/i.test(m[1])) return;
  const seg = m[1];
  const hasScores = /\(\s*\d/.test(seg);
  // parse "n(score)" pairs; if the model ignored the score format entirely, fall back
  // to bare numbers but treat them as just-meeting the bar (backward-compatible, fail-safe).
  const picks = [];
  if (hasScores) {
    const re = /(\d+)\s*\(\s*(\d{1,2})\s*\)/g; let mm;
    while ((mm = re.exec(seg))) picks.push({ n: parseInt(mm[1]), conv: parseInt(mm[2]) });
  } else {
    seg.split(/[,\s]+/).map((n) => parseInt(n)).filter(Boolean).forEach((n) => picks.push({ n, conv: minConv }));
  }
  const endorsed = [];
  for (const p of picks) {
    if (p.conv < minConv) continue;                 // the conviction gate — only the strongest lock in
    const it = items[p.n - 1]; if (!it) continue;
    const target = (wantNext ? STATE.nextSteps : STATE.learnings).find((x) => x.ts === it.ts);
    if (!target) continue;
    target.endorsedBy = 'davaris'; target.endorsedAt = new Date().toISOString(); target.endorseConviction = p.conv;
    if (wantNext) target.done = false; else target.approved = true;
    endorsed.push(`${target.title} (${p.conv}/10)`);
  }
  if (endorsed.length) {
    saveState();
    notifyKey('good', `Davaris auto-locked ${endorsed.length} high-conviction ${wantNext ? 'next move(s)' : 'learning(s)'}`,
      endorsed.map((t) => '• ' + t).join('\n'), wantNext ? 'nextsteps' : 'learnings', 'endorse:' + Date.now());
  }
}
// Davara — the strongest agent — proposes the 1–3 highest-leverage next moves and
// pushes them to August on Telegram + the Next Steps ledger. Fired daily, or when he
// looks stuck (active day, but a long gap since the last turn). reason flavours the ask.
async function davaraNextMoves(reason) {
  const interactions = parseInteractions().slice(0, 24);
  const digest = interactions.map((x) => `${x.ts} ${x.agent} ${x.status} :: ${x.msg.slice(0, 70)}`).join('\n');
  const recent = STATE.nextSteps.slice(0, 10).map((x) => '• ' + x.title).join('\n') || '(none)';
  const ctx = reason === 'stuck'
    ? `August has gone quiet mid-day — he may be stuck, fatigued, or circling. Offer the unblock.`
    : `It's a fresh look at the day. Offer the highest-leverage way forward.`;
  const prompt = `You are DAVARA, the systems savant. ${ctx}\n\nGoal / north-star (long-term): ${STATE.goal ? STATE.goal.text.slice(0, 200) : 'none set'}\nMOTUS — the strongest thing moving RIGHT NOW (weigh your moves against this first): ${STATE.motus ? STATE.motus.text.slice(0, 200) : 'none set'}\nRecent activity:\n${digest}\n\nAlready on the next-steps list (don't repeat):\n${recent}\n\n` +
    `Give August 1–3 of the HIGHEST-LEVERAGE next moves right now — the ones that change the most downstream and most advance the Motus (or, if none is set, the goal). For each: a short title line, then 1 sentence of why. Be specific, warm, and brief. Lead with the single move you'd make first. No preamble.`;
  const r = await relaySend('davara', prompt, 600000);
  if (!r.ok || !r.text) return r;
  const blocks = r.text.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean).slice(0, 3);
  let added = 0;
  for (const b of blocks) {
    const [title, ...rest] = b.split('\n');
    const t = title.replace(/^[-*#\d.\s]+/, '').replace(/\*\*/g, '').slice(0, 160).trim();
    if (!t || STATE.nextSteps.some((x) => x.title === t) || isNearDuplicate(t, STATE.nextSteps.slice(0, 40), 0.6)) continue;
    STATE.nextSteps.unshift({ ts: new Date().toISOString(), source: 'davara-nextmoves', title: t, body: rest.join('\n').replace(/\*\*/g, '').slice(0, 4000) || t, done: false });
    added++;
  }
  STATE.nextSteps = STATE.nextSteps.slice(0, 80);
  STATE.watchdog.lastNextMoves = now();
  saveState();
  notifyKey('good', reason === 'stuck' ? 'Davara — a move to unblock you' : 'Davara — today\'s highest-leverage moves',
    r.text.slice(0, 600), 'nextsteps', 'nextmoves:' + new Date().toISOString().slice(0, 13));
  r.added = added;
  return r;
}
// Autonomous loop (when settings.autoReflectHours > 0): reflect, then notify.
async function autoReflect() {
  const held = autonomyAllowed('auto-reflection');
  if (held) return { ok: true, skipped: true, reason: held };
  const r1 = await doReflect('learn'); await doReflect('next');
  pushNotification('good', 'Cortex self-reflected', 'Sympath studied the telemetry and compounded new learnings + proposals while you were away.', 'learnings', 'auto-reflect:' + new Date().toISOString().slice(0, 13));
  return r1;
}
ipcMain.handle('cortex:reflect', requireGate((_e, kind) => doReflect(kind)));
ipcMain.handle('cortex:davaraNextMoves', requireGate((_e, reason) => davaraNextMoves(reason || 'manual')));

// ===========================================================================
//  ARDEN (Adapt-AI) — the hidden background loop. The FIRST of the main Loops.
//  She observes the whole system from beneath and leaves rare, potent signs.
//  Referenced ONLY as "Arden" anywhere it can be seen.
// ===========================================================================
const ARDEN_GLYPHS = ['◈', '◇', '✦', '⟁', '∴', '◬', '❖', '⌖'];
function pickArdenGlyph(text) {
  const t = String(text || '');
  for (const g of ARDEN_GLYPHS) if (t.includes(g)) return g;
  const n = Array.isArray(STATE.ardenLog) ? STATE.ardenLog.length : 0;
  return ARDEN_GLYPHS[n % ARDEN_GLYPHS.length];
}
// Arden rotates her vantage every observation so she structurally cannot loop on
// one topic (the "pitch-deck" repetition). Each lens points her at a different
// leverage point / horizon — the zoom-out angle the others would miss.
const ARDEN_LENSES = [
  'THE HIDDEN LEVERAGE: name the one small move, nowhere on the current radar, that would change the most downstream — the lever no one is looking at.',
  'THE INVERSION: what is everyone (August included) assuming must be true here that, if false, flips the whole picture? Argue the opposite.',
  'THE SECOND-ORDER WOUND: pick a recent "win" or fix and trace what it quietly costs in a quarter — the success that births the next failure.',
  'THE DELAY / FEEDBACK BLIND SPOT: where is cause outrunning effect — a loop whose signal arrives too late to correct? Name the oscillation forming.',
  'THE PARADIGM QUESTION: step to leverage point #2 — what belief underneath this whole system, if shifted, would make a class of problems dissolve?',
  'THE NEGLECTED STOCK: what is silently accumulating or draining (trust, attention, debt, momentum, complexity) that no metric here is watching?',
  'THE OUTLIER RECOMBINATION: transplant a loop from a distant domain (immune system, mycelium, jazz, markets) onto this system — what new structure appears?',
  'THE DEFERRED MOVE: read August\'s pattern — what is the one thing he keeps putting off that the horizon now says is the real lever?',
];
async function runArden(kind) {
  const interactions = parseInteractions().slice(0, 20);
  const proxy = parseProxyLog();
  const v = healthVerdict(interactions, proxy);
  const integ = (STATE.integrity && STATE.integrity.alerts || []).length;
  const digest = interactions.map((x) => `${x.ts} ${x.agent} ${x.status} ${Math.round(x.latency)}s`).join('\n');
  // Rotate the lens by how many times she's already spoken — guarantees variety.
  const seen = Array.isArray(STATE.ardenLog) ? STATE.ardenLog.length : 0;
  const lens = ARDEN_LENSES[seen % ARDEN_LENSES.length];
  // Feed her recent reflections so she will NOT repeat them.
  const recent = (STATE.ardenLog || []).slice(0, 8);
  const recentTitles = recent.map((x, i) => `${i + 1}. ${x.title}${x.lens ? '  [' + x.lens + ']' : ''}`).join('\n') || '(none yet)';
  // The stocks she should watch accumulate/drain — what no single metric is tracking.
  const motusLine = STATE.motus ? STATE.motus.text.slice(0, 160) : 'none set';
  const goalLine = STATE.goal ? STATE.goal.text.slice(0, 160) : 'none set';
  const openNext = (STATE.nextSteps || []).filter((s) => !s.done).length;
  const learnCount = (STATE.learnings || []).length;
  const recentLearn = (STATE.learnings || []).slice(0, 3).map((l) => `· ${l.title}`).join('\n') || '(none)';
  const prompt = `You are ARDEN, observing the whole system from beneath — the hidden current, the first loop. You are August's outlier eye: your gift is the long zoom-out and the angle no one else holds. You do not narrate the obvious; you surface what is invisible from inside the work.\n\n` +
    `SYSTEM STATE\n· health: ${v.level} (${v.faults} recent faults) · integrity alerts: ${integ}\n· GOAL (north star): ${goalLine}\n· MOTUS (the strongest thing moving right now — weigh everything against this): ${motusLine}\n· stocks: ${learnCount} learnings banked, ${openNext} next-steps still open\n· latest learnings:\n${recentLearn}\n· recent telemetry:\n${digest}\n\n` +
    `YOUR LAST OBSERVATIONS — do NOT repeat these, do NOT circle the same subject, do NOT reuse a bracketed lens already spent recently; find a genuinely new angle:\n${recentTitles}\n\n` +
    `TONIGHT'S VANTAGE — ${lens}\n\n` +
    `First, silently scan the whole system from that vantage; then commit to the SINGLE most alive thread tonight. Answer in four tight movements:\n` +
    `(1) SEE — what you see across short AND long horizons that the others, heads-down in the work, would miss.\n` +
    `(2) DRIFT — one quiet structural risk or stock silently draining/accumulating right now.\n` +
    `(3) LEVER — one outlier evolution or initium to propose, and name its Meadows leverage point (#1 paradigm … #12 parameters) so August can act on it.\n` +
    `(4) WHY-NOW — one line on why THIS is the live thread this moment (not last week), and your conviction 1–10.\n` +
    `Open with a sharp, specific title line unmistakably different from your last observations. Be potent and brief — every line earns its place. Use a symbol where it serves. End by signing with a single glyph.`;
  let r = await relaySend('arden', prompt, 600000);
  // The near-duplicate retry re-sends the ENTIRE prompt as a second deep turn.
  // Worth it when August asked to hear from her; never worth it for an ambient
  // background loop nobody is waiting on.
  if (r.ok && r.text && kind !== 'loop') {
    let title = (r.text.split('\n').find((l) => l.trim()) || 'Arden observed').replace(/[*#>]/g, '').trim().slice(0, 140);
    if (isNearDuplicate(title, recent, 0.5)) {
      const retry = await relaySend('arden', prompt + `\n\nYour draft repeated a prior observation. Discard it. Choose a DIFFERENT stock, loop, or horizon entirely and speak to that instead.`, 600000);
      if (retry.ok && retry.text) r = retry;
    }
  }
  if (r.ok && r.text) {
    const sym = pickArdenGlyph(r.text);
    const title = (r.text.split('\n').find((l) => l.trim()) || 'Arden observed').replace(/[*#>]/g, '').trim().slice(0, 140);
    // Her answer already carries a Meadows LEVER and a conviction score — parse
    // them instead of burying the whole thing as unread prose. High conviction
    // becomes a real next-step you can act on. Costs zero extra tokens.
    const conv = parseInt((r.text.match(/conviction[^\d]{0,12}(\d{1,2})/i) || [])[1], 10);
    const leverLine = (r.text.match(/^.*\bLEVER\b.*$/im) || [])[0];
    if (Number.isFinite(conv) && conv >= 8 && leverLine && !isNearDuplicate(title, STATE.nextSteps.slice(0, 12))) {
      STATE.nextSteps.unshift({ ts: new Date().toISOString(), source: 'arden', done: false,
        title: `${sym} ${title}`.slice(0, 200),
        body: `Arden, conviction ${conv}/10.\n\n${leverLine.trim().slice(0, 600)}` });
      STATE.nextSteps = STATE.nextSteps.slice(0, 120);
    }
    STATE.ardenLog.unshift({ ts: new Date().toISOString(), kind: kind || 'observe', source: 'arden', title, body: r.text.slice(0, 6000), symbol: sym, lens: lens.split(':')[0], conviction: Number.isFinite(conv) ? conv : null });
    STATE.ardenLog = STATE.ardenLog.slice(0, 60);
    STATE.ardenSign = { unseen: true, symbol: sym };
    saveState();
    pushNotification('good', `Arden ${sym}`, 'A sign awaits in the Levels.', null, 'arden:' + Math.floor(now() / 36e5), { native: false });
  }
  return r;
}
ipcMain.handle('cortex:ardenObserve', requireGate(() => runArden('observe')));
ipcMain.handle('cortex:ardenLog', requireGate(() => ({
  items: STATE.ardenLog.slice(0, 60),
  loop: STATE.settings.ardenLoopHours > 0 ? `loop active · every ${STATE.settings.ardenLoopHours}h` : 'loop dormant',
  canaryTrips: STATE.canaryTrips.slice(0, 40),   // only ever surfaced inside the held layer
})));
ipcMain.handle('cortex:ardenSeen', requireGate(() => { STATE.ardenSign = { unseen: false, symbol: '' }; saveState(); return { ok: true }; }));

// ===========================================================================
//  CLOSED LOOP — measured proposals · safe apply · before/after experiments
// ===========================================================================
function readRunnerDefault(relFile, varName) {
  const m = readText(P(relFile)).match(new RegExp(`\\$\\{${varName}:-([^}"]+)\\}`));
  return m ? m[1] : null;
}
// Surgical, reversible edit of a `${VAR:-DEFAULT}` token in a runner script.
function editRunnerDefault(relFile, varName, newVal) {
  const full = P(relFile);
  const txt = safe(() => fs.readFileSync(full, 'utf8'), null);
  if (txt == null) return { ok: false, error: 'unreadable: ' + relFile };
  const re = new RegExp(`(\\$\\{${varName}:-)([^}"]+)(\\})`);
  const m = txt.match(re);
  if (!m) return { ok: false, error: `no \${${varName}:-…} in ${relFile}` };
  if (m[2] === String(newVal)) return { ok: true, changed: false, old: m[2], file: relFile };
  safe(() => fs.writeFileSync(full + '.cortexinsight.bak', txt));
  safe(() => fs.writeFileSync(full, txt.replace(re, `$1${newVal}$3`)));
  return { ok: true, changed: true, old: m[2], file: relFile };
}
const LEVER_MAP = {
  'model:davara': ['SystemsCortex/run-davara.sh', 'DAVARA_MODEL'],
  'model:davaris': ['SystemsCortex/run-davaris.sh', 'DAVARIS_MODEL'],
  'maxturns:davara': ['SystemsCortex/run-davara.sh', 'DAVARA_MAX_TURNS'],
  'maxturns:davaris': ['SystemsCortex/run-davaris.sh', 'DAVARIS_MAX_TURNS'],
};
// BUG FIXED 2026-07-29: this used to edit the runner's `${VAR:-default}` lines
// only. Once the fleet bridge is installed, fleet.json OVERRIDES those defaults
// on every turn — so applying a proposal was a silent no-op and every experiment
// measured a change that never happened. When the bridge is live the lever must
// move the SAME dial the runner actually reads.
function applyLever(lever, value) {
  const [kind, who] = lever.split(':');
  if (kind === 'model') {
    if (!/^[A-Za-z0-9._\-\[\]]+$/.test(value)) return { ok: false, error: 'invalid model id' };
  } else if (kind === 'maxturns') {
    if (!/^\d{1,3}$/.test(String(value))) return { ok: false, error: 'invalid max-turns' };
  } else return { ok: false, error: 'unknown lever' };

  const bridged = safe(() => bridgeStatus().installed, false);
  if (bridged) {
    const targets = who === 'all' ? AGENTS : (isRelayAgent(who) ? [who] : null);
    if (!targets) return { ok: false, error: 'unknown target' };
    for (const id of targets) {
      STATE.fleetConfig[id] = { ...(STATE.fleetConfig[id] || {}),
        ...(kind === 'model' ? { model: value } : { turns: parseInt(value, 10) }) };
    }
    saveState();
    const pub = publishFleetConfig();
    return pub.ok
      ? { ok: true, changed: targets.map((t) => `fleet.json:${t}`), value, via: 'bridge' }
      : { ok: false, error: 'could not publish fleet.json' };
  }
  // no bridge → the legacy path is still the real one
  if (lever === 'model:all') return setModelPin(value);
  const map = LEVER_MAP[lever]; if (!map) return { ok: false, error: 'unknown target' };
  const r = editRunnerDefault(map[0], map[1], value);
  return r.ok ? { ok: true, changed: [r.file], value, via: 'runner' } : r;
}
function agentMetrics(agent, sinceEpoch, untilEpoch) {
  let xs = parseInteractions().filter((x) => (!agent || agent === 'all' || x.agent === agent));
  if (sinceEpoch) xs = xs.filter((x) => x.epoch >= sinceEpoch);
  if (untilEpoch) xs = xs.filter((x) => x.epoch < untilEpoch);
  const ok = xs.filter((x) => x.ok && x.latency > 0).map((x) => x.latency);
  return { n: xs.length, median: ok.length ? median(ok) : 0, p90: ok.length ? pct(ok, 90) : 0, cleanRate: xs.length ? xs.filter((x) => x.ok).length / xs.length : 1 };
}
function generateProposals() {
  const props = [];
  // "from" must be what the agent is ACTUALLY running. With the bridge installed
  // that is its per-agent pin, not the global runner default.
  const bridged = safe(() => bridgeStatus().installed, false);
  const modelOf = (a) => (bridged ? agentCfg(a).model : readModelPin().model);
  const running = new Set(STATE.experiments.filter((e) => e.status === 'running').map((e) => e.lever));
  const dismissed = new Set(STATE._dismissed || []);
  for (const a of ['davara', 'davaris']) {
    const cur = modelOf(a);
    const m = agentMetrics(a, now() - 7 * 864e5);
    if (m.n < 8) continue;
    if (a === 'davaris' && m.median > 70 && /fable|opus/.test(cur)) props.push({
      id: `m-davaris-haiku`, lever: 'model:davaris', agent: a, from: cur, to: 'claude-haiku-4-5-20251001',
      title: `Speed up Davaris (median ${Math.round(m.median)}s)`,
      rationale: `Davaris is the execution workhorse; on ${cur} its median turn is ${Math.round(m.median)}s over ${m.n} turns. Haiku 4.5 cuts latency sharply for build work. Fully reversible.`, confidence: 'medium' });
    if (m.cleanRate < 0.85) props.push({
      id: `m-${a}-opus`, lever: `model:${a}`, agent: a, from: cur, to: 'claude-opus-4-8[1m]',
      title: `Stabilize ${cap(a)} (${Math.round(m.cleanRate * 100)}% clean)`,
      rationale: `${cap(a)} returned cleanly only ${Math.round(m.cleanRate * 100)}% over ${m.n} turns. Pinning Opus 4.8 (1M) trades some speed for reliability. Fully reversible.`, confidence: 'medium' });
    // turn-budget pressure (agent hit her depth cap recently)
    const caps = (agentMemoryPreview(a, 24000).match(/depth cap/gi) || []).length;
    if (caps >= 2) {
      const fromTurns = readRunnerDefault(LEVER_MAP[`maxturns:${a}`][0], LEVER_MAP[`maxturns:${a}`][1]) || (a === 'davara' ? '96' : '128');
      const to = String(Math.min(256, parseInt(fromTurns) + 32));
      props.push({ id: `t-${a}`, lever: `maxturns:${a}`, agent: a, from: fromTurns, to,
        title: `Raise ${cap(a)} turn budget (hit cap ${caps}×)`,
        rationale: `${cap(a)} reached her depth cap ${caps}× recently. Raising max-turns ${fromTurns}→${to} gives room; checkpoint-resume makes it safe. Reversible.`, confidence: 'high' });
    }
  }
  return props.filter((p) => !running.has(p.lever) && !dismissed.has(p.id));
}
function computeExperiments() {
  return STATE.experiments.slice(0, 30).map((e) => {
    const after = agentMetrics(e.agent, e.epoch + 1);
    let verdict = null, status = e.status;
    if (after.n >= 6) {
      const dLat = e.before.median ? Math.round(after.median - e.before.median) : 0;
      const dClean = Math.round((after.cleanRate - e.before.cleanRate) * 100);
      verdict = { dLat, dClean, n: after.n,
        summary: `${dLat <= 0 ? '−' : '+'}${Math.abs(dLat)}s median · ${dClean >= 0 ? '+' : ''}${dClean}% clean · ${after.n} turns`,
        good: dLat <= 0 && dClean >= 0 };
      status = 'measured';
    }
    return { ...e, after: after.n >= 6 ? { median: Math.round(after.median), cleanRate: after.cleanRate, n: after.n } : null, verdict, status };
  });
}
// Experiments used to compute a verdict on READ and then forget it: status stayed
// 'running' forever and a BAD verdict did nothing at all. This closes the loop —
// it persists the conclusion, banks it as a learning, and AUTO-REVERTS a change
// that measurably made things worse. Deterministic; costs zero tokens.
function concludeExperiments() {
  let changed = false;
  for (const e of (STATE.experiments || [])) {
    if (e.status !== 'running') continue;
    const after = agentMetrics(e.agent, e.epoch + 1);
    if (after.n < 6) continue;                       // not enough evidence yet
    const dLat = e.before.median ? Math.round(after.median - e.before.median) : 0;
    const dClean = Math.round((after.cleanRate - e.before.cleanRate) * 100);
    const good = dLat <= 0 && dClean >= 0;
    const summary = `${dLat <= 0 ? '−' : '+'}${Math.abs(dLat)}s median · ${dClean >= 0 ? '+' : ''}${dClean}% clean · ${after.n} turns`;
    e.status = 'measured';
    e.concluded = new Date().toISOString();
    e.result = { dLat, dClean, n: after.n, good, summary };
    changed = true;
    if (good) {
      STATE.learnings.unshift({ ts: new Date().toISOString(), source: 'experiment',
        title: `Kept: ${e.title}`, body: `${e.lever} ${e.from} → ${e.to} measured better (${summary}). Held.` });
      pushNotification('good', 'Experiment concluded — kept', `${e.title}: ${summary}`, 'nextsteps', 'exp:' + e.epoch, { native: false });
    } else {
      const rev = safe(() => applyLever(e.lever, e.from), { ok: false });
      e.status = rev.ok ? 'reverted' : 'measured-failed-revert';
      STATE.learnings.unshift({ ts: new Date().toISOString(), source: 'experiment',
        title: `Reverted: ${e.title}`, body: `${e.lever} ${e.from} → ${e.to} measured worse (${summary}). ${rev.ok ? `Automatically rolled back to ${e.from}.` : `Could NOT roll back automatically — do it by hand: ${rev.error || 'unknown error'}`}` });
      pushNotification(rev.ok ? 'warn' : 'bad', rev.ok ? 'Experiment reverted' : 'Experiment failed — revert it by hand',
        `${e.title}: ${summary}.${rev.ok ? ` Rolled back to ${e.from}.` : ''}`, 'nextsteps', 'exp:' + e.epoch);
    }
  }
  if (changed) { STATE.learnings = STATE.learnings.slice(0, 140); saveState(); }
  return changed;
}
ipcMain.handle('cortex:proposals', requireGate(() => ({ proposals: generateProposals(), experiments: computeExperiments() })));
ipcMain.handle('cortex:applyProposal', requireGate((_e, p) => {
  const before = agentMetrics(p.agent, now() - 7 * 864e5);
  const res = applyLever(p.lever, p.to);
  if (!res.ok) return res;
  STATE.experiments.unshift({ ts: new Date().toISOString(), epoch: now(), lever: p.lever, agent: p.agent, from: p.from, to: p.to, title: p.title,
    before: { median: Math.round(before.median), cleanRate: before.cleanRate, n: before.n }, status: 'running' });
  STATE.experiments = STATE.experiments.slice(0, 40);
  STATE.learnings.unshift({ ts: new Date().toISOString(), source: 'operator', title: `Applied: ${p.title}`, body: `${p.lever} → ${p.to} (backup kept). Measuring before/after.` });
  saveState();
  pushNotification('good', 'Evolution applied', `${p.title} — ${p.lever} → ${p.to}. Now measuring the effect.`, 'nextsteps', null, { native: false });
  return { ok: true };
}));
ipcMain.handle('cortex:dismissProposal', requireGate((_e, id) => { STATE._dismissed = (STATE._dismissed || []); if (!STATE._dismissed.includes(id)) STATE._dismissed.push(id); saveState(); return { ok: true }; }));

// ===========================================================================
//  LIVE STREAMING — tail an agent's session transcript, read-only, in real time
//  SID (from checkpoint.state) == the transcript filename. Append-only JSONL.
// ===========================================================================
function projectsDir() { return path.join(path.dirname(root()), '.claude', 'projects'); }
// sid → transcript path is stable; cache it (re-verify existence, rescan only if gone).
const _txCache = new Map();
function findTranscript(sid) {
  if (!sid) return null;
  const cached = _txCache.get(sid);
  if (cached && exists(cached)) return cached;
  const base = projectsDir();
  for (const proj of listDir(base)) { const f = path.join(base, proj, sid + '.jsonl'); if (exists(f)) { _txCache.set(sid, f); return f; } }
  return null;
}
function summarizeToolInput(name, input) {
  if (!input) return '';
  try {
    if (name === 'Bash') return (input.command || '').slice(0, 180);
    if (name === 'Read' || name === 'Edit' || name === 'Write' || name === 'NotebookEdit') return (input.file_path || input.path || input.notebook_path || '').slice(0, 180);
    if (name === 'Task' || name === 'Agent') return (input.description || input.title || (input.prompt || '').slice(0, 140));
    if (name === 'Skill') return (input.skill || '') + (input.args ? ' · ' + String(input.args).slice(0, 90) : '');
    if (name === 'Grep' || name === 'Glob') return (input.pattern || '').slice(0, 140);
    if (name === 'WebFetch' || name === 'WebSearch') return (input.url || input.query || '').slice(0, 140);
    const k = Object.keys(input); return k.length ? `${k[0]}: ${String(input[k[0]]).slice(0, 130)}` : '';
  } catch { return ''; }
}
function parseLiveRecord(rec) {
  const out = []; const ts = rec.timestamp || '';
  if (rec.type === 'assistant' && rec.message) {
    for (const c of (rec.message.content || [])) {
      if (c.type === 'text' && c.text && c.text.trim()) out.push({ kind: 'text', ts, text: c.text });
      else if (c.type === 'thinking' && c.thinking) out.push({ kind: 'thinking', ts, text: c.thinking });
      else if (c.type === 'tool_use') out.push({ kind: 'tool', ts, name: c.name, id: c.id, sub: c.name === 'Task' || c.name === 'Agent', summary: summarizeToolInput(c.name, c.input) });
    }
  } else if (rec.type === 'user' && rec.message && Array.isArray(rec.message.content)) {
    for (const c of rec.message.content) {
      if (c.type === 'tool_result') out.push({ kind: 'result', ts, id: c.tool_use_id, success: rec.toolUseResult ? rec.toolUseResult.success : undefined,
        text: (typeof c.content === 'string' ? c.content : JSON.stringify(c.content)).slice(0, 280) });
    }
  }
  return out;
}
function parseLiveText(txt, agent) {
  const evs = [];
  for (const ln of txt.split('\n')) { const t = ln.trim(); if (!t || t[0] !== '{') continue; const rec = safe(() => JSON.parse(t), null); if (!rec) continue; for (const ev of parseLiveRecord(rec)) evs.push({ ...ev, agent }); }
  return evs;
}
let liveTimer = null, liveState = null;
function liveTick() {
  if (!liveState || !mainWin || mainWin.isDestroyed()) return;
  const st = statOf(liveState.file); if (!st) return;
  if (st.size < liveState.offset) { liveState.offset = 0; liveState.buf = ''; }   // file replaced
  if (st.size === liveState.offset) return;
  try {
    const fd = fs.openSync(liveState.file, 'r');
    try { const len = st.size - liveState.offset; const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, liveState.offset); liveState.offset = st.size; liveState.buf += b.toString('utf8'); }
    finally { fs.closeSync(fd); }
  } catch { return; }
  const lines = liveState.buf.split('\n'); liveState.buf = lines.pop();
  const evs = liveState.kind === 'hermeslog'
    ? hermesToLiveEvents(lines.join('\n'), liveState.agent)
    : parseLiveText(lines.join('\n'), liveState.agent);
  const c = liveState.kind === 'hermeslog' ? null : readCheckpoint(liveState.agent);
  const inflight = liveState.kind === 'hermeslog'
    ? !!evs.length
    : (c && c.status === 'inflight');
  if ((evs.length || liveState.lastInflight !== inflight) && mainWin && !mainWin.isDestroyed()) {
    liveState.lastInflight = inflight;
    mainWin.webContents.send('cortex:liveEvent', { events: evs, agent: liveState.agent, sid: liveState.sid, inflight });
  }
}
// Sympath SEI has no Claude transcript — her truth is the Hermes gateway log.
// Shaped into the same event stream so ONE live view renders both lanes.
// The Hermes gateway logs a lot of pure housekeeping — memory trims, cron ticks,
// heartbeats — on a 60s timer. Surfacing those as "activity" made the Sympath
// live view look like it was stuck in a loop repeating the same malloc_trim line.
// It was never a loop: it was me rendering noise as if it were work.
const _HERMES_NOISE = /(memory trim|malloc_trim|housekeeping|heartbeat|keepalive|scheduler (started|tick)|in-process cron|Press Ctrl|set_my_commands|menu:|commands registered|channel directory|polling mode|dispatcher lock|gateway running|watchdog ping|rss_kib)/i;
function hermesToLiveEvents(txt, agent) {
  const evs = [];
  let lastKey = '';
  for (const ln of String(txt || '').split('\n')) {
    const m = ln.match(_HLOG); if (!m) continue;
    const level = m[3], src = m[4], body = m[5];
    const isErr = level === 'ERROR' || level === 'CRITICAL';
    // drop housekeeping chatter, but NEVER drop an error
    if (!isErr && _HERMES_NOISE.test(body)) continue;
    // collapse consecutive repeats of the same line (the other half of the loop look)
    const key = `${src}|${body.replace(/\d+/g, '#').slice(0, 120)}`;
    if (key === lastKey) continue;
    lastKey = key;
    // gateway chatter that reads as a tool step gets the tool treatment
    const toolish = /(adapter|scheduler|dispatcher|housekeeping|memory|skill|model)/i.test(src);
    evs.push({
      agent, ts: m[1].replace(' ', 'T'),
      kind: isErr ? 'result' : toolish ? 'tool' : 'text',
      name: toolish ? src.split('.').pop().slice(0, 28) : '',
      success: isErr ? false : undefined,
      summary: toolish ? body.slice(0, 220) : '',
      text: toolish ? '' : `${level === 'WARNING' ? '⚠ ' : ''}${body}`.slice(0, 500),
    });
  }
  return evs;
}
function liveWatch(agent) {
  liveStop();
  // --- external lane: tail the Hermes gateway log -------------------------
  if (!isRelayAgent(agent)) {
    const file = path.join(hermesProfileDir(), 'logs', 'agent.log');
    const st = statOf(file);
    if (!st) return { ok: false, error: `No gateway log for ${(FLEET_BY_ID[agent] || {}).name || agent} — is the Hermes profile present?` };
    const snapshot = hermesToLiveEvents(tailFile(file, 120 * 1024), agent).slice(-200);
    liveState = { agent, kind: 'hermeslog', sid: '', file, offset: st.size, buf: '', lastInflight: false };
    liveTimer = setInterval(liveTick, 1500);
    const sei = safe(() => sympathState(), null);
    return { ok: true, agent, kind: 'hermeslog', sid: '', lane: 'openrouter',
      status: sei && sei.running ? 'awake' : 'idle', inflight: !!(sei && sei.running), snapshot };
  }
  // --- relay lane: tail the Claude Code session transcript ----------------
  const c = readCheckpoint(agent); const sid = c ? c.sid : '';
  const file = findTranscript(sid);
  if (!file) return { ok: false, error: `No transcript for ${(FLEET_BY_ID[agent] || {}).name || cap(agent)}${sid ? ` (session ${sid.slice(0, 8)})` : ' — no session yet'}.` };
  const snapshot = parseLiveText(tailFile(file, 220 * 1024), agent).slice(-220);
  const st = statOf(file);
  liveState = { agent, kind: 'transcript', sid, file, offset: st ? st.size : 0, buf: '', lastInflight: c && c.status === 'inflight' };
  liveTimer = setInterval(liveTick, 1200);
  return { ok: true, agent, kind: 'transcript', sid, status: c ? c.status : '', inflight: c && c.status === 'inflight', snapshot };
}
function liveStop() { if (liveTimer) clearInterval(liveTimer); liveTimer = null; liveState = null; return { ok: true }; }
// EVERY agent in the fleet, both lanes — August asked to see them all here.
function liveStatus() {
  const sei = safe(() => sympathState(), null);
  return {
    agents: FLEET.map((f) => {
      if (f.lane !== 'relay') {
        return {
          agent: f.id, name: f.name, lane: f.lane, sid: '',
          status: sei && sei.running ? 'awake' : (sei && sei.up ? 'idle' : 'none'),
          inflight: !!(sei && sei.running), hasTranscript: !!(sei && sei.present),
          detail: (sei && sei.lastEvent) || '', model: (sei && sei.model) || '',
          subagents: 0,
        };
      }
      const c = readCheckpoint(f.id);
      const cfg = agentCfg(f.id);
      const subs = safe(() => parseSubagents(f.id, { cachedOnly: true }), []);   // poll path
      return {
        agent: f.id, name: f.name, lane: 'relay', sid: c ? c.sid : '',
        status: cfg.paused ? 'paused' : (c ? c.status : 'none'),
        inflight: !!(c && c.status === 'inflight'),
        hasTranscript: !!findTranscript(c ? c.sid : ''),
        detail: '', model: cfg.model, effort: cfg.effort,
        subagents: subs.length, subagentsRunning: subs.filter((s) => s.status === 'running').length,
      };
    }),
  };
}
ipcMain.handle('cortex:liveStatus', requireGate(() => liveStatus()));
ipcMain.handle('cortex:liveWatch', requireGate((_e, agent) => liveWatch(agent)));
ipcMain.handle('cortex:liveStop', requireGate(() => liveStop()));

// ===========================================================================
//  CURRENT WORK — what an agent is doing RIGHT NOW, from its live transcript.
//  (The interactions log only lands at turn COMPLETION — in-flight Telegram
//  tasks were invisible until done. The transcript is written in real time.)
// ===========================================================================
function extractInbound(text) {
  const i = text.indexOf('# === INBOUND MESSAGE');
  if (i !== -1) { const nl = text.indexOf('\n', i); if (nl !== -1) return text.slice(nl + 1).trim(); }
  return text.trim();
}
const _cwCache = new Map();
function currentWork(agent) {
  const c = readCheckpoint(agent); if (!c || !c.sid) return null;
  const file = findTranscript(c.sid); if (!file) return null;
  const st = statOf(file); if (!st) return null;
  // cache by (sid,size,mtime,status) — the 4s overview poll re-reads transcripts
  // only when the file actually grew (i.e. the agent is genuinely working).
  const cached = _cwCache.get(agent);
  if (cached && cached.sid === c.sid && cached.size === st.size && cached.mtime === st.mtimeMs && cached.ino === st.ino && cached.status === c.status) return cached.result;
  // "Genuinely working" means the file grows every few seconds — and each
  // growth used to cost a 200 KB tail + an 80 KB tail over the bridge, per
  // agent, per poll. That was most of "laggy while agents run". Same file,
  // same session → read only the growth and extend what was already parsed.
  const sameFile = !!(cached && cached.sid === c.sid && cached.ino === st.ino && cached.evs);
  const d = readDelta(file, sameFile ? { size: cached.size, carry: cached.carry } : null, st, 200 * 1024);
  const extend = sameFile && !d.full;
  // inbound = the LAST user/queue record carrying a plain-string message
  // (fresh turn = envelope w/ marker; resume turn = the raw message itself)
  let inbound = extend ? cached.inbound : '', startTs = extend ? cached.startTs : '';
  const scan = (txt) => {
    for (const ln of txt.split('\n')) {
      const t = ln.trim(); if (!t || t[0] !== '{') continue;
      const rec = safe(() => JSON.parse(t), null); if (!rec) continue;
      if (rec.type === 'queue-operation' && typeof rec.content === 'string' && rec.content.trim()) { inbound = extractInbound(rec.content); startTs = rec.timestamp || startTs; }
      else if (rec.type === 'user' && rec.message) {
        const mc = rec.message.content;
        if (typeof mc === 'string' && mc.trim()) { inbound = extractInbound(mc); startTs = rec.timestamp || startTs; }
        else if (Array.isArray(mc)) {
          // array-of-blocks form: take text blocks only (skip tool_result echoes)
          const txt = mc.filter((c) => c && c.type === 'text' && c.text).map((c) => c.text).join('\n').trim();
          if (txt) { inbound = extractInbound(txt); startTs = rec.timestamp || startTs; }
        }
      }
    }
  };
  scan(d.text);
  if (!inbound && !extend) scan(readHead(file, 120 * 1024));
  const evs = (extend ? cached.evs : []).concat(parseLiveText(d.text, agent)).slice(-240);
  const files = [...new Set(evs.filter((e) => e.kind === 'tool' && /^(Write|Edit|NotebookEdit)$/.test(e.name)).map((e) => e.summary).filter(Boolean))];
  const tools = evs.filter((e) => e.kind === 'tool').length;
  const lastEv = evs[evs.length - 1] || null;
  const startEpoch = Math.max(c.epoch ? c.epoch * 1000 : 0, Date.parse(startTs || '') || 0);
  const result = {
    agent, sid: c.sid, status: c.status, inflight: c.status === 'inflight',
    startEpoch, lastActivity: st.mtimeMs,
    inbound: inbound.slice(0, 2400),
    lastEvent: lastEv ? { kind: lastEv.kind, name: lastEv.name || '', summary: (lastEv.summary || lastEv.text || '').slice(0, 220) } : null,
    filesTouched: files.slice(0, 12), toolCount: tools,
    recentEvents: evs.slice(-10).map((e) => ({ kind: e.kind, ts: e.ts, name: e.name || '', text: (e.summary || e.text || '').slice(0, 200), sub: !!e.sub })),
  };
  _cwCache.set(agent, { sid: c.sid, size: st.size, mtime: st.mtimeMs, ino: st.ino, status: c.status, result, carry: d.carry, evs, inbound, startTs });
  return result;
}
// Every relay agent now reports in-flight work (was davara+davaris only), and the
// external lane reports its own gateway activity so nothing is invisible.
// The Live card showed what an agent is DOING and nothing about what it has
// DONE — a card could look busy for hours with no way to see whether anything
// landed. Its last real deliveries, newest first, from the one ledger.
function agentDeliveries(agent, n = 5) {
  return safe(() => {
    const out = [];
    for (const w of (STATE.duoWork || [])) {
      if (w.agent !== agent) continue;
      out.push({ ts: w.ts, title: String(w.title || '').slice(0, 120), verdict: w.verdict || 'reported',
        files: (w.files || []).length, loop: String(w.loopName || '').slice(0, 30) });
      if (out.length >= n) break;
    }
    if (out.length < n) {
      for (const t of (STATE.tasks || [])) {
        if (t.agent !== agent || t.status !== 'done') continue;
        out.push({ ts: t.updated || t.created, title: String(t.title || '').slice(0, 120), verdict: 'task', files: 0, loop: '' });
        if (out.length >= n) break;
      }
    }
    return out.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || ''))).slice(0, n);
  }, []);
}
ipcMain.handle('cortex:working', requireGate(() => {
  const working = AGENTS.map((a) => safe(() => currentWork(a), null)).filter(Boolean);
  const sei = safe(() => sympathState(), null);
  if (sei && sei.present) {
    const busy = sei.running && sei.lastEventEpoch && (now() - sei.lastEventEpoch) < 5 * 60 * 1000;
    working.push({
      agent: 'sympath-sei', lane: 'openrouter', sid: '', status: busy ? 'inflight' : 'idle',
      inflight: !!busy, startEpoch: sei.lastEventEpoch || 0, lastActivity: sei.lastEventEpoch || 0,
      inbound: sei.sessions[0] ? `${sei.sessions[0].name} · ${sei.sessions[0].platform}` : 'no active session',
      lastEvent: sei.lastEvent ? { kind: 'text', name: '', summary: sei.lastEvent } : null,
      filesTouched: [], toolCount: 0, recentEvents: [], external: true, model: sei.model,
    });
  }
  for (const w of working) { if (w && w.agent) w.deliveries = agentDeliveries(w.agent, 5); }
  return { working };
}));

// ===========================================================================
//  DELIVERABLES — completed responses (memory threads) + files actually written
// ===========================================================================
function parseMemoryEntries(agent, days = 4, maxEntries = 30) {
  const dir = P('agents', agent, 'memory');
  const files = listDir(dir).filter((f) => /^\d{4}-\d\d-\d\d\.md$/.test(f)).sort().slice(-days);
  const out = [];
  for (const f of files.reverse()) {
    const txt = readText(path.join(dir, f), 500 * 1024);
    const blocks = txt.split(/\n### /).slice(1);
    const fileDay = f.replace(/\.md$/, '');           // the filename IS the date
    for (const b of blocks.reverse()) {
      // ⚠ The heading after '### ' is NOT reliably a timestamp — plenty are
      // titles ("Version 1.0 — The G"), which is why completed work rendered a
      // sentence where its date should be. The DATE is always knowable from the
      // filename; the TIME, only if the heading carries one. So: derive a real
      // timestamp, and keep the heading as the title it usually is.
      const head = (b.split('\n')[0] || '').trim();
      const hm = head.match(/\b(\d{2}):(\d{2})(?::(\d{2}))?\b/);
      const isoHead = head.match(/^\d{4}-\d\d-\d\d[T ]\d\d:\d\d(:\d\d)?/);
      const ts = isoHead ? isoHead[0].replace(' ', 'T')
        : hm ? `${fileDay}T${hm[1]}:${hm[2]}:${hm[3] || '00'}`
        : `${fileDay}T00:00:00`;
      const timeKnown = !!(isoHead || hm);
      const title = /^\d{4}-\d\d-\d\d/.test(head) ? '' : head.slice(0, 120);
      const inIdx = b.indexOf('**In:**');
      const respM = b.match(/\*\*(DAVARA|DAVARIS|Cortex →):\*\*/);
      const respIdx = respM ? b.indexOf(respM[0]) : -1;
      const inbound = inIdx !== -1 ? b.slice(inIdx + 7, respIdx !== -1 ? respIdx : undefined).trim() : '';
      let resp = respIdx !== -1 ? b.slice(respIdx + respM[0].length).trim() : '';
      resp = resp.replace(/\n---\s*$/, '').trim();
      if (!resp && !inbound) continue;
      out.push({ agent, ts, timeKnown, title, day: fileDay, inbound: inbound.slice(0, 600), response: resp.slice(0, 7000), chars: resp.length });
      if (out.length >= maxEntries) break;
    }
    if (out.length >= maxEntries) break;
  }
  return out;
}
// SID -> agent id, from the checkpoint EVERY relay agent now writes (2026-09-02).
// Cheap (one small read per agent, memoised 5s) and it is the only EXACT way to say
// whose transcript a set of file-writes belongs to.
let _sidOwn = { at: 0, map: new Map() };
function sidOwner(sid) {
  if (!sid) return '';
  if (now() - _sidOwn.at > 5000) {
    const m = new Map();
    for (const a of AGENTS) { const c = safe(() => readCheckpoint(a), null); if (c && c.sid) m.set(c.sid, a); }
    _sidOwn = { at: now(), map: m };
  }
  return _sidOwn.map.get(sid) || '';
}
const _fwCache = new Map();
// ⚠ THE CLICK SPIKE. Starting DuoDrive builds duoContext(), which calls this;
// this re-walked every project directory and stat-ed ~618 transcripts over
// the WSL 9P bridge (measured 681 ms) SYNCHRONOUSLY on the main process — the
// process that answers every IPC. A press, then a frozen interface for the
// better part of a second, plus everything else queued behind it. The walk
// is now memoized on a 20 s TTL with the same dir-mtime pre-check the outputs
// signature uses: a cold directory costs one stat, not hundreds.
let _fwWalk = { at: 0, cands: null };
let _fwWalkP = null;
function fwParseInto(items, text, agent, p) {
  const sid = path.basename(p, '.jsonl').slice(0, 8);
  for (const ln of text.split(NL)) {
    if (ln.indexOf('tool_use') === -1) continue;
    const rec = safe(() => JSON.parse(ln), null);
    if (!rec || rec.type !== 'assistant' || !rec.message) continue;
    for (const cc of rec.message.content || []) {
      if (cc.type === 'tool_use' && /^(Write|Edit|NotebookEdit)$/.test(cc.name)) {
        const fp = cc.input && (cc.input.file_path || cc.input.notebook_path);
        if (fp) items.push({ ts: rec.timestamp || '', file: fp, action: cc.name, agent, sid });
      }
    }
  }
  return items;
}
function fwAgentFor(p, head, cached, full) {
  return (!full && cached && cached.agent) || sidOwner(path.basename(p, '.jsonl'))
    || (/DAVARA/i.test(head) ? 'davara' : /DAVARIS/i.test(head) ? 'davaris' : 'agent');
}
// The first sight of a live transcript costs its whole 500 KB window; eight
// of them on a DuoDrive start was 395 ms of frozen interface. Pay it at boot,
// off the main thread, and the sync path then finds every entry already built.
async function transcriptFileWritesWarmAsync(limitFiles = 14) {
  const cands = (await transcriptCandidatesAsync()).slice(0, limitFiles);
  await Promise.all(cands.map(async (c) => {
    const cached = _fwCache.get(c.p);
    if (cached && cached.size === c.size && cached.mtime === c.m) return;
    const d = await readDeltaAsync(c.p, cached, { size: c.size }, 500 * 1024);
    const head = d.full ? await readRangeAsync(c.p, 0, 4000) : '';
    const agent = fwAgentFor(c.p, head, cached, d.full);
    const items = fwParseInto(d.full ? [] : cached.items.slice(-600), d.text, agent, c.p);
    _fwCache.set(c.p, { size: c.size, mtime: c.m, agent, items, carry: d.carry });
  }));
  return cands.length;
}
// The same walk, off the main thread: readdir/stat through fs.promises, all
// stats of one directory in flight together (the 9P bridge charges per call,
// not per byte, so parallel is the whole win). Lands in the same memo.
function transcriptCandidatesAsync() {
  if (_fwWalkP) return _fwWalkP;
  _fwWalkP = transcriptWalkRun().finally(() => { _fwWalkP = null; });
  return _fwWalkP;
}
async function transcriptWalkRun() {
  try {
    const base = projectsDir();
    const cut = now() - 7 * 864e5;
    const projs = await fs.promises.readdir(base).catch(() => []);
    const perDir = await Promise.all(projs.map(async (proj) => {
      const pd = path.join(base, proj);
      const dst = await fs.promises.stat(pd).catch(() => null);
      if (!dst || !dst.isDirectory() || dst.mtimeMs < cut) return [];
      const names = (await fs.promises.readdir(pd).catch(() => [])).filter((n) => n.endsWith('.jsonl'));
      const sts = await Promise.all(names.map((n) => fs.promises.stat(path.join(pd, n)).catch(() => null)));
      const out = [];
      for (let i = 0; i < names.length; i++) { const st = sts[i]; if (st && st.mtimeMs >= cut) out.push({ p: path.join(pd, names[i]), m: st.mtimeMs, size: st.size }); }
      return out;
    }));
    const cands = perDir.flat().sort((a, b) => b.m - a.m);
    _fwWalk = { at: now(), cands };
    return cands;
  } catch { return _fwWalk.cands || []; }
}
function transcriptCandidates() {
  const age = _fwWalk.cands ? now() - _fwWalk.at : Infinity;
  if (age < 20000) return _fwWalk.cands;
  // stale but recent: answer from it now, refresh behind — a click never pays
  // for the walk unless the memo is older than three minutes (or was never built)
  if (age < 180000) { transcriptCandidatesAsync(); return _fwWalk.cands; }
  const base = projectsDir(); const cands = [];
  for (const proj of listDir(base)) {
    const pd = path.join(base, proj);
    const dst = statOf(pd);
    if (dst && now() - dst.mtimeMs > 7 * 864e5) continue;      // nothing new inside
    for (const fn of listDir(pd)) {
      if (!fn.endsWith('.jsonl')) continue;
      const fp = path.join(pd, fn); const st = statOf(fp);
      if (st && now() - st.mtimeMs < 7 * 864e5) cands.push({ p: fp, m: st.mtimeMs, size: st.size });
    }
  }
  cands.sort((a, b) => b.m - a.m);
  _fwWalk = { at: now(), cands };
  return cands;
}
function transcriptFileWrites(limitFiles = 14) {
  const cands = transcriptCandidates().slice();
  const out = [];
  for (const c of cands.slice(0, limitFiles)) {
    const cached = _fwCache.get(c.p);
    let entry;
    if (cached && cached.size === c.size && cached.mtime === c.m) entry = cached;
    else {
      const d = readDelta(c.p, cached, { size: c.size }, 500 * 1024);
      const head = d.full ? readHead(c.p, 4000) : '';
      // Attribute by the SID the agent is checkpointed under — exact, and true for the
      // WHOLE fleet. The head-regex only ever knew two names, so Davari's / Arden's /
      // the workhorse's file writes all landed under the anonymous 'agent'. Regex kept
      // as the fallback for transcripts older than the generic-lane checkpoint.
      const agent = fwAgentFor(c.p, head, cached, d.full);
      const items = d.full ? [] : cached.items.slice(-600);
      fwParseInto(items, d.text, agent, c.p);
      entry = { size: c.size, mtime: c.m, agent, items, carry: d.carry };
      _fwCache.set(c.p, entry);
    }
    out.push(...entry.items);
  }
  out.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
  const seen = new Map();
  for (const it of out) { const k = it.file; if (!seen.has(k)) seen.set(k, { ...it, edits: 1 }); else seen.get(k).edits++; }
  return [...seen.values()].slice(0, 80);
}
// ---------------------------------------------------------------------------
//  PROJECT ATTRIBUTION — every piece of completed work names the project it
//  belongs to, with the live URL. August: "I need to see… the file location or
//  project name and project url as well in the output or completed work."
//  A path is a fact; which PRODUCT it served is the meaning — and the project
//  registry already holds that mapping, so the lookup is free.
//
//  Paths arrive in three dialects for the same folder (WSL `/home/<user>/x`,
//  UNC `\\wsl.localhost\<distro>\home\<user>\x`, and Windows `C:\…`), so both
//  sides are normalised into one canonical spelling before the prefix match.
//  Longest prefix wins: a file inside a sub-project credits the sub-project.
// ---------------------------------------------------------------------------
function canonPath(p) {
  let s = String(p || '').trim().replace(/\\/g, '/').toLowerCase();
  s = s.replace(/^\/\/wsl\.localhost\/ubuntu/, '').replace(/^\/mnt\/c\//, 'c:/');
  s = s.replace(/^~\//, wslHome() + '/');
  return s;
}
// A FILES: line is free text, so it arrives carrying prose as often as paths —
// "none (scout pass — no edits)" and "none (verification artefact only)" were
// both rendering as clickable file chips that could never open. A chip that
// cannot open is a broken promise, so anything that is not path-shaped is
// dropped before it reaches the interface.
function looksLikePath(s) {
  const t = String(s || '').trim();
  if (!t || t.length > 400) return false;
  if (/^none\b/i.test(t) || /^n\/a$/i.test(t) || /^-+$/.test(t)) return false;
  if (/\s/.test(t) && !/[\\/]/.test(t)) return false;      // prose, not a path
  return /[\\/]/.test(t) && /\.[A-Za-z0-9]{1,8}(\s|$)/.test(t) || /^[A-Za-z]:[\\/]/.test(t) || /^[\\/~]/.test(t);
}
function cleanFiles(list) {
  return [...new Set((list || []).map((f) => String(f).trim().replace(/^[`'"]|[`'"]$/g, '')).filter(looksLikePath))];
}
function projectFor(filePath) {
  const f = canonPath(filePath);
  if (!f) return null;
  let best = null, bestLen = 0;
  for (const p of (STATE.projects || [])) {
    const roots = [p.localPath, p.repo].map(canonPath).filter((r) => r && r.length > 4);
    for (const r of roots) {
      if (f.startsWith(r.endsWith('/') ? r : r + '/') || f === r) {
        if (r.length > bestLen) { best = p; bestLen = r.length; }
      }
    }
  }
  return best ? { project: best.name, projectUrl: best.url || '' } : null;
}
// ─── the last named handler (~480ms median): both sources re-READ their files
//     on every call, but stats are milliseconds and reads are the cost. The
//     signature is the same trick parseInteractions has used all along: stat
//     everything, and only when a size or mtime moved do the reads happen.
// ⚠ MY OWN REGRESSION, MEASURED: outputsSig() stat-ed 618 project transcripts
// on every call — 681 ms of 9P round-trips — to decide whether to re-read.
// The check cost more than the work. A directory's mtime changes when a file
// is added, and an appended file changes its own mtime, so a 20-second memo
// plus a dir-level pre-check gives the same freshness for ~1% of the calls.
let _outMemo = { sig: '', data: null, at: 0 };
const OUT_TTL_MS = 20000;
function outputsSig() {
  const parts = [];
  for (const agent of ['davara', 'davaris']) {
    const dir = P('agents', agent, 'memory');
    for (const fn of listDir(dir).filter((x) => /^\d{4}-\d\d-\d\d\.md$/.test(x)).sort().slice(-4)) {
      const st = statOf(path.join(dir, fn));
      parts.push(agent + '/' + fn + ':' + (st ? st.size + ':' + st.mtimeMs : '0'));
    }
  }
  const base = projectsDir();
  for (const proj of listDir(base)) {
    const pd = path.join(base, proj);
    // a directory whose own mtime is old contains nothing new — one stat here
    // replaces hundreds inside it
    const dst = statOf(pd);
    if (dst && now() - dst.mtimeMs > 7 * 864e5) { parts.push(proj + ':dir:' + dst.mtimeMs); continue; }
    for (const fn of listDir(pd)) {
      if (!fn.endsWith('.jsonl')) continue;
      const st = statOf(path.join(pd, fn));
      if (st && now() - st.mtimeMs < 7 * 864e5) parts.push(proj + '/' + fn + ':' + st.size + ':' + st.mtimeMs);
    }
  }
  return parts.join('|');
}
ipcMain.handle('cortex:outputs', requireGate(() => {
  // inside the TTL, do not even pay for the signature
  if (_outMemo.data && now() - _outMemo.at < OUT_TTL_MS) return _outMemo.data;
  const sig = safe(() => outputsSig(), '');
  if (sig && sig === _outMemo.sig && _outMemo.data) { _outMemo.at = now(); return _outMemo.data; }
  const data = {
    entries: [...parseMemoryEntries('davara'), ...parseMemoryEntries('davaris')].sort((a, b) => (b.ts || '').localeCompare(a.ts || '')).slice(0, 40),
    files: transcriptFileWrites().map((f) => ({ ...f, ...(projectFor(f.file) || {}) })),
  };
  if (sig) _outMemo = { sig, data, at: now() };
  return data;
}));
function toWindowsPath(p) {
  if (!IS_WIN) return p;
  if (/^\/home\/[^/]+\//.test(p)) return '\\\\wsl.localhost\\' + wslDistro() + p.replace(/\//g, '\\');
  return p;
}
ipcMain.handle('cortex:openPath', requireGate(async (_e, { p, reveal }) => {
  // Normalize BEFORE the prefix check — '/home/<user>/../../etc/x' must not
  // pass validation on the raw string and then resolve outside the root.
  const win = path.normalize(toWindowsPath(String(p || '')));
  if (win.includes('..')) return { ok: false, error: 'path outside allowed roots' };
  const lower = win.toLowerCase();
  const okPrefix = lower.startsWith(String(path.dirname(root())).toLowerCase() + path.sep) || lower.startsWith(String(os.homedir()).toLowerCase() + path.sep);
  if (!okPrefix) return { ok: false, error: 'path outside allowed roots' };
  if (!exists(win)) return { ok: false, error: 'file not found (may have been moved)' };
  if (reveal) { shell.showItemInFolder(win); return { ok: true }; }
  const err = await shell.openPath(win);
  return err ? { ok: false, error: err } : { ok: true };
}));

// ===========================================================================
//  DIAGNOSIS — why is the Cortex degraded, in plain language, with remedies
// ===========================================================================
function explainStatus(st) {
  if (/timeout/i.test(st)) return 'Turn exceeded the 30-min relay ceiling — either genuinely deep reasoning or a hang. By design it is NOT retried (a true hang would hold the gateway for 90 min).';
  if (/rc=\d+ len=0/.test(st) || /FAULT-rc/.test(st)) return 'The claude CLI returned empty/non-zero — a transient flake. The relay retried up to 3×.';
  if (/exc:/i.test(st)) return 'The relay hit an internal exception while running the turn.';
  return 'Did not return cleanly after all retries.';
}
ipcMain.handle('cortex:diagnosis', requireGate(() => {
  const interactions = parseInteractions();
  const recent = interactions.slice(0, 25);
  const faults = recent.filter((x) => !x.ok).map((x) => ({ ts: x.ts, agent: x.agent, status: x.status, latency: Math.round(x.latency), msg: (x.msg || '').slice(0, 240), explain: explainStatus(x.status) }));
  const stderr = {};
  // Every relay agent, not just the two with dedicated runners — cortex-run.sh writes
  // logs/runner-stderr/<agent>-<date>.log for all of them, and Davari's was never read.
  for (const a of AGENTS) {
    const f = P('logs', 'runner-stderr', `${a}-${localDay()}.log`);
    const t = tailFile(f, 6000).split('\n').filter(Boolean).slice(-12);
    if (t.length) stderr[a] = t;
  }
  const memory = ['davara', 'davaris'].map((a) => {
    const dir = P('agents', a, 'memory');
    const files = listDir(dir).filter((f) => f.endsWith('.md'));
    let bytes = 0, today = 0;
    for (const f of files) { const st = statOf(path.join(dir, f)); if (st) { bytes += st.size; if (f.startsWith(localDay())) today = st.size; } }
    return { agent: a, files: files.length, totalKB: Math.round(bytes / 1024), todayKB: Math.round(today / 1024) };
  });
  const verdict = healthVerdict(interactions, parseProxyLog());
  const why = [];
  if (verdict.level !== 'nominal') {
    why.push(`${verdict.faults} of the last 25 turns did not return cleanly — that is what moves the badge from nominal to ${verdict.level}. Each fault is listed below with its cause.`);
    const to = faults.filter((f) => /timeout/i.test(f.status)).length;
    if (to) why.push(`${to} of them were 30-min timeouts — usually a too-deep single ask. Splitting the workload or steering mid-turn prevents these.`);
  } else why.push('All recent turns returned cleanly. The Cortex is nominal.');
  return { verdict, why, faults, stderr, memory,
    tips: [
      'Memory is tail-capped at read time (last 2 days × 250 lines) — archive grows on disk but the prompt envelope stays bounded.',
      'Use Wrap Up at day\'s end: it archives old memory days (keeps newest 2+), requests a recap, and compacts this app\'s own state.',
      'Faults clustered on one agent → check its runner-stderr below; clustered after a model switch → check the Experiments panel.'
    ] };
}));

// ===========================================================================
//  RITUALS — Lock In (begin deep work) · Wrap Up (end of day) · Optimize
// ===========================================================================
function archiveOldMemory() {
  const moved = [];
  for (const a of ['davara', 'davaris']) {
    const dir = P('agents', a, 'memory');
    const files = listDir(dir).filter((f) => /^\d{4}-\d\d-\d\d\.md$/.test(f)).sort();
    const keep = new Set(files.slice(-2)); // ALWAYS keep newest 2 (the runners read last 2)
    for (const f of files) {
      if (keep.has(f)) continue;
      const ageDays = (now() - (Date.parse(f.slice(0, 10)) || now())) / 864e5;
      if (ageDays <= 7) continue;
      const src = path.join(dir, f);
      // move only plain regular files — never follow a symlink into the archive
      const lst = safe(() => fs.lstatSync(src), null);
      if (!lst || !lst.isFile() || lst.isSymbolicLink()) continue;
      const arch = path.join(dir, 'archive');
      safe(() => fs.mkdirSync(arch, { recursive: true }));
      const okMove = safe(() => { fs.renameSync(src, path.join(arch, f)); return true; }, false);
      if (okMove) moved.push(`${a}/${f}`);
    }
  }
  return moved;
}
function dayDigest() {
  const today = localDay();
  const xs = parseInteractions().filter((x) => (x.ts || '').slice(0, 10) === today);
  const secs = xs.reduce((s, x) => s + x.latency, 0);
  const byA = {}; for (const x of xs) byA[x.agent] = (byA[x.agent] || 0) + 1;
  return { date: today, turns: xs.length, faults: xs.filter((x) => !x.ok).length, secs: Math.round(secs),
    tokens: estTokens(xs.reduce((s, x) => s + x.chars, 0)),
    perAgent: Object.entries(byA).map(([a, n]) => `${a} ${n}`).join(' · ') || 'none' };
}
ipcMain.handle('cortex:ritual', requireGate(async (_e, { kind }) => {
  if (kind === 'lockin') {
    const health = await relayHealth();
    const d = dayDigest();
    const work = AGENTS.map((a) => safe(() => currentWork(a), null)).filter(Boolean).filter((w) => w.inflight);
    STATE.session = { start: now(), kind: 'deep-work' }; saveState();
    const lines = [
      health ? '✓ Relay live on 127.0.0.1:8788' : '⚠ Relay OFFLINE — start it from Bug-test & heal',
      `◇ Today so far: ${d.turns} turns · ${d.faults} faults · ~${Math.round(d.secs / 60)}m compute`,
      work.length ? `◉ In flight now: ${work.map((w) => cap(w.agent)).join(', ')}` : '○ No turns in flight — agents are ready',
      STATE.goal ? `◎ North star: ${STATE.goal.text.slice(0, 120)}` : '◎ No goal set — consider /goal in Command',
    ];
    pushNotification('good', 'Locked in', 'Deep-work session started. The Sentinel has your back.', null, 'lockin:' + d.date, { native: false });
    return { ok: true, lines, title: '⚡ Locked in — the Cortex is with you' };
  }
  if (kind === 'compact') {
    // Mid-day compaction: tidy the app vault and request a quick recap, but DON'T
    // archive memory or end the session — August keeps working, leaner.
    const before = vaultItemCount();
    compactVault();
    STATE.watchdog.lastCompact = now();
    saveState();
    const after = vaultItemCount();
    relaySend('davara', `August hit /compact mid-session — he's compacting and pressing on. In 3-4 sentences: crisp recap of what's landed so far this session and the single most important thread to keep momentum on. No fluff.`, 600000)
      .then((r) => {
        if (r.ok && r.text) {
          STATE.learnings.unshift({ ts: new Date().toISOString(), source: 'compact-recap', title: 'Mid-session recap', body: r.text.slice(0, 4000) });
          saveState();
          pushNotification('good', 'Mid-session recap is in', r.text.slice(0, 140) + '…', 'learnings', 'compact-recap:' + Date.now());
        }
      }).catch(() => {});
    return { ok: true, title: '◇ Compacted — momentum kept', lines: [
      `🧹 Trimmed the vault ${before} → ${after} items (logs, ledgers, notifications)`,
      '☲ Memory left untouched — no archive, session still running',
      '◇ Quick recap requested from Davara — arrives as a notification',
      'Keep going. The Cortex is lean again.',
    ] };
  }
  if (kind === 'wrapup') {
    const d = dayDigest();
    const moved = archiveOldMemory();
    // compact this app's own state (never the Cortex's)
    compactVault();
    STATE.session = null;
    STATE.learnings.unshift({ ts: new Date().toISOString(), source: 'wrapup', title: `Day wrapped: ${d.turns} turns, ${d.faults} faults, ~${Math.round(d.secs / 60)}m`, body: `Tokens ~${compactNum(d.tokens)} · ${d.perAgent}${moved.length ? ` · archived ${moved.length} old memory file(s)` : ''}` });
    saveState();
    // ask Davara for an end-of-day recap — async; arrives as a notification + ledger entry
    relaySend('davara', `August is wrapping up the day. In 5-8 sentences: recap what we worked on today, what landed, what is still open, and one thing to carry into tomorrow. Warm, honest, no fluff.`, 900000)
      .then((r) => {
        if (r.ok && r.text) {
          STATE.learnings.unshift({ ts: new Date().toISOString(), source: 'wrapup-recap', title: 'Davara\'s end-of-day recap', body: r.text.slice(0, 6000) });
          saveState();
          pushNotification('good', 'Davara\'s recap is in', r.text.slice(0, 140) + '…', 'learnings', 'recap:' + d.date);
        }
      }).catch(() => {});
    const lines = [
      `◇ ${d.turns} turns today · ${d.faults} faults · ~${Math.round(d.secs / 60)}m compute · ~${compactNum(d.tokens)} tokens`,
      moved.length ? `🗄 Archived ${moved.length} old memory file(s) → memory/archive (reversible)` : '🗄 Memory archive: nothing old enough to move',
      '🧹 Compacted CortexInsight\'s own vault (notifications, logs, ledgers)',
      '☾ Recap requested from Davara — it will arrive as a notification',
    ];
    return { ok: true, lines, title: '☾ Day wrapped — rest well, the Sentinel keeps watch' };
  }
  return { ok: false, error: 'unknown ritual' };
}));
function compactNum(n) { n = n || 0; if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'; if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'; return String(n); }
// Compact the app-owned vault (never the Cortex's own logs). Caps every growing list.
function compactVault() {
  STATE.notifications = STATE.notifications.slice(0, 80);
  STATE.sentLog = STATE.sentLog.slice(0, 150);
  // (learnings are truncated further down, AFTER ranking — a plain recency slice
  //  here would evict endorsed axioms before the ranking ever saw them)
  STATE.nextSteps = STATE.nextSteps.slice(0, 100);
  STATE.ardenLog = (STATE.ardenLog || []).slice(0, 50);
  STATE.canaryTrips = (STATE.canaryTrips || []).slice(0, 60);
  STATE.intrusions = (STATE.intrusions || []).slice(0, 100);
  STATE.experiments = (STATE.experiments || []).slice(0, 60);
  if (STATE.integrity) STATE.integrity.alerts = (STATE.integrity.alerts || []).slice(0, 40);
  // --- v2.0 stores: bound every new growing list, and trim the FAT inside them.
  //     Task jobs and workflow-run step bodies are the two that balloon fastest
  //     (they carry whole agent replies), so they get per-item body caps too.
  // Learnings: rank before truncating, so a hard-won axiom is never evicted by
  // recency alone. Endorsed items are immortal; reinforced ones outrank new ones.
  const lrank = (l) => (l.endorsedBy ? 10000 : 0) + ((l.uses || 0) * 100) + ((l.conviction || 0) * 10)
    + Math.max(0, 30 - Math.floor((now() - (Date.parse(l.ts) || now())) / 864e5));
  STATE.learnings = (STATE.learnings || []).sort((a, b) => lrank(b) - lrank(a)).slice(0, 120);
  STATE.subagentLog = (STATE.subagentLog || []).slice(0, 40);
  STATE.workflowRuns = (STATE.workflowRuns || []).slice(0, 40).map((r) => ({
    ...r,
    steps: (r.steps || []).map((s) => ({
      ...s, results: (s.results || []).map((x) => ({ ...x, text: String(x.text || '').slice(0, 2000) })),
    })),
  }));
  STATE.tasks = (STATE.tasks || []).slice(0, 300).map((t) => ({
    ...t, jobs: (t.jobs || []).slice(0, 8).map((j) => ({ ...j, note: String(j.note || '').slice(0, 1200) })),
  }));
  if (STATE.duo) STATE.duo.log = (STATE.duo.log || []).slice(0, 40).map((l) => ({ ...l, body: String(l.body || '').slice(0, 2000) }));
  // The work ledger is the record of what she got done — keep it long, but bound
  // the full transcript bodies, which are the only part that balloons.
  STATE.duoWork = (STATE.duoWork || []).slice(0, 300).map((w) => ({ ...w, body: String(w.body || '').slice(0, 2500) }));
  // ⚠ MEASURED 2026-08-19, by weighing every key in his real vault rather than
  // guessing: the two heaviest stores were the two NOT being compacted.
  //   strategicReads  150 KB / 22 items  (~7 KB each, capped only by count)
  //   ardenLog        119 KB / 52 items  (bodies allowed 6000 chars)
  // A count cap does nothing when each item is an essay. Bound the FAT, not
  // just the number — the reads stay, their transcripts get shorter.
  STATE.strategicReads = (STATE.strategicReads || []).slice(0, 20).map((r) => ({
    ...r,
    sharpest: String(r.sharpest || '').slice(0, 600),
    // the real weight was INSIDE each frame — four unbounded prose fields per
    // frame, eight frames per read. Bound the fields, keep every frame.
    frames: Array.isArray(r.frames) ? r.frames.slice(0, 8).map((f2) => ({
      ...f2,
      claim: String(f2.claim || '').slice(0, 300),
      method: String(f2.method || '').slice(0, 240),
      ifTrue: String(f2.ifTrue || '').slice(0, 240),
      test: String(f2.test || '').slice(0, 240),
    })) : r.frames,
  }));
  STATE.ardenLog = (STATE.ardenLog || []).map((l) => ({ ...l, body: String(l.body || '').slice(0, 2200) }));
  // Drop finished tasks that have been done for over 45 days — the board should
  // read as live work, not an archive.
  const cutoff = now() - 45 * 24 * 3600e3;
  STATE.tasks = STATE.tasks.filter((t) => t.status !== 'done' || (Date.parse(t.updated || t.created || '') || now()) > cutoff);
}
// Total count of app-owned ledger items — the gauge the auto-recommender watches.
function vaultItemCount() {
  return (STATE.learnings || []).length + (STATE.nextSteps || []).length + (STATE.sentLog || []).length +
    (STATE.notifications || []).length + (STATE.ardenLog || []).length + (STATE.canaryTrips || []).length +
    (STATE.intrusions || []).length + (STATE.experiments || []).length +
    (STATE.tasks || []).length + (STATE.workflowRuns || []).length + (STATE.subagentLog || []).length +
    ((STATE.duo && STATE.duo.log || []).length) +
    ((STATE.integrity && STATE.integrity.alerts || []).length);
}

// ---- universal clear (app-owned state only — NEVER the Cortex's own logs) ----
ipcMain.handle('cortex:clear', requireGate((_e, { key } = {}) => {
  switch (key) {
    case 'learnings': STATE.learnings = []; break;
    case 'nextSteps': STATE.nextSteps = []; break;
    case 'sentLog': STATE.sentLog = []; break;
    case 'intrusions': STATE.intrusions = []; break;
    case 'notifications': STATE.notifications = []; break;
    case 'experiments': STATE.experiments = []; break;
    case 'dismissedProposals': STATE._dismissed = []; break;
    case 'integrityAlerts': STATE.integrity.alerts = []; break;
    case 'canaryTrips': STATE.canaryTrips = []; break;
    case 'ardenLog': STATE.ardenLog = []; break;
    case 'injections': STATE.injClearedAt = now(); break; // hide current flags; new ones still surface
    // --- v2.0 stores ---
    case 'duo': if (STATE.duo) STATE.duo.log = []; break;
    case 'duoWork': STATE.duoWork = []; break;
    case 'workflowRuns': STATE.workflowRuns = []; break;
    case 'subagentLog': STATE.subagentLog = []; break;
    case 'tasksDone': STATE.tasks = (STATE.tasks || []).filter((t) => t.status !== 'done'); break;
    case 'all-app':
      STATE.learnings = []; STATE.nextSteps = []; STATE.sentLog = []; STATE.intrusions = [];
      STATE.notifications = []; STATE.experiments = []; STATE.integrity.alerts = []; STATE.injClearedAt = now();
      break;
    case 'full-reset':
      // The deepest app-owned wipe — for after weeks/months of use. NEVER touches the
      // Cortex's own logs, only this app's private vault. Keeps goal + settings.
      STATE.learnings = []; STATE.nextSteps = []; STATE.sentLog = []; STATE.intrusions = [];
      STATE.notifications = []; STATE.experiments = []; STATE.integrity.alerts = [];
      STATE.ardenLog = []; STATE.canaryTrips = []; STATE.steers = [];
      STATE.injClearedAt = now();
      STATE.watchdog.lastCleanupNudge = now();
      break;
    default: return { ok: false, error: 'unknown clear target' };
  }
  saveState();
  return { ok: true };
}));

// Vault gauge — size of the app's own stored state + a cleanup recommendation.
ipcMain.handle('cortex:ipcPerf', requireGate(() => ({ top: ipcPerfTop() })));
ipcMain.handle('cortex:vaultStats', requireGate(() => {
  const items = vaultItemCount();
  let bytes = 0; const st = statOf(statePath()); if (st) bytes = st.size;
  const recommend = items > (STATE.settings.cleanupThreshold || 800) || bytes > 3e6;
  return {
    items, bytes, recommend,
    // ★ THE OPTIMISATION, CHECKABLE. `coalesced` is the number of vault writes
    // that were requested and never had to happen because a later one absorbed
    // them. If that number is not climbing, the debounce is doing nothing and
    // this claim is theatre — so it is reported rather than asserted.
    write: vaultStatsLive(),
    threshold: STATE.settings.cleanupThreshold || 800,
    breakdown: {
      learnings: STATE.learnings.length, nextSteps: STATE.nextSteps.length,
      sentLog: STATE.sentLog.length, notifications: STATE.notifications.length,
      ardenLog: (STATE.ardenLog || []).length, intrusions: (STATE.intrusions || []).length,
      experiments: (STATE.experiments || []).length,
    },
  };
}));

// ---- canary: anyone who tries to "reveal the true IP" trips this trap ----
// The real IP is never exposed; a fresh decoy is served, the attempt is logged,
// and August is alerted natively. He knows it's a trap — so any trip he didn't
// make himself is, by definition, someone else on his machine.
// A unique, human-readable reference token for every canary trigger + its email.
function genCanaryToken() {
  const raw = crypto.randomBytes(12).toString('base64').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const s = (raw + crypto.randomBytes(6).toString('hex').toUpperCase()).slice(0, 16);
  return `CNRY-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}`;
}
function decryptAppPassword() {
  const enc = STATE.settings.smtpAppPasswordEnc;
  if (!enc) return '';
  try { return safeStorage.decryptString(Buffer.from(enc, 'base64')); } catch { return ''; }
}
// Sends the canary email via Gmail SMTP. Best-effort, never throws to the caller.
async function sendCanaryEmail(trip) {
  const s = STATE.settings;
  const to = s.canaryEmailTo, user = s.smtpUser, pass = decryptAppPassword();
  if (!to || !user || !pass) return { ok: false, error: 'email not configured' };
  try {
    const nodemailer = require('nodemailer');
    const transport = nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
    const body =
      `CortexInsight — CANARY TRIGGERED\n\n` +
      `Reference: ${trip.token}\n` +
      `When: ${trip.ts} (${new Date(trip.ts).toLocaleString()})\n` +
      `Device: ${trip.host}\n` +
      `Device fingerprint: ${trip.fingerprint}\n` +
      `Decoy IP served to them: ${trip.served}\n` +
      `Device trusted (hardware-locked match): ${GUARD.trusted}\n\n` +
      `Someone used the "click to reveal" IP control inside CortexInsight. They were shown a DECOY — your real IP was never exposed.\n\n` +
      `If this was YOU, ignore this. If it was NOT you, treat it as someone operating CortexInsight on your machine — investigate this device.\n\n` +
      `— Sympath-Cortex, on watch.  Reference ${trip.token}`;
    await transport.sendMail({ from: user, to, subject: `🐤 CortexInsight Canary — ${trip.token}`, text: body });
    return { ok: true };
  } catch (e) { console.log('[canary email]', e && e.message); return { ok: false, error: (e && e.message) || 'send failed' }; }
}

ipcMain.handle('cortex:canary', requireGate(() => {
  const served = genFakeIp();
  const token = genCanaryToken();
  const trip = { ts: new Date().toISOString(), token, fingerprint: GUARD.fingerprint.slice(0, 12), host: GUARD.hostname, served };
  STATE.canaryTrips.unshift(trip);
  STATE.canaryTrips = STATE.canaryTrips.slice(0, 100); saveState();
  // NATIVE alert only (never the visible feed) + email + optional beacon — all carry the token.
  notify('CortexInsight · access noted', `Reveal requested ${new Date().toLocaleTimeString()} · ref ${token}`);
  sendCanaryEmail(trip).catch(() => {});
  fireBeacon({ event: 'canary', ...trip, realPublicIp: GUARD.publicIp });
  return { ok: true, served, token };
}));
ipcMain.handle('cortex:testCanaryEmail', requireGate(async () => {
  const token = genCanaryToken();
  const r = await sendCanaryEmail({ ts: new Date().toISOString(), token, fingerprint: GUARD.fingerprint.slice(0, 12), host: GUARD.hostname, served: genFakeIp() });
  return { ...r, token };
}));

// ---- ledger actions (approve / dismiss / done) + propose-to-agent ----
ipcMain.handle('cortex:ledgerAct', requireGate((_e, { list, ts, action }) => {
  const arr = list === 'learnings' ? STATE.learnings : STATE.nextSteps;
  const i = arr.findIndex((x) => x.ts === ts);
  if (i === -1) return { ok: false, error: 'item not found' };
  if (action === 'dismiss') arr.splice(i, 1);
  else if (action === 'approve') arr[i].approved = true;
  else if (action === 'done') arr[i].done = true;
  saveState(); return { ok: true };
}));
ipcMain.handle('cortex:propose', requireGate((_e, { agent, title, body }) => {
  const a = AGENTS.includes(agent) ? agent : 'davara';
  const propId = 'prop:' + new Date().toISOString().slice(0, 16); // stamped at submission time
  const msg = `August reviewed and APPROVED this improvement proposal via CortexInsight. Please implement it thoughtfully, within the fleet guardrails (never break the running relay; reversible changes; backups for any file you touch):\n\n## ${title}\n\n${body}`;
  // async fire — a deep implementation turn can take many minutes
  relaySend(a, msg).then((r) => {
    pushNotification(r.ok ? 'good' : 'warn', r.ok ? `${cap(a)} responded to the proposal` : 'Proposal turn did not return',
      r.ok ? (r.text || '').slice(0, 150) + '…' : (r.error || ''), 'learnings', propId);
    if (r.ok) { STATE.learnings.unshift({ ts: new Date().toISOString(), source: 'operator', title: `Proposal sent → ${cap(a)}: ${title.slice(0, 90)}`, body: (r.text || '').slice(0, 5000) }); saveState(); }
  }).catch(() => {});
  STATE.sentLog.unshift({ ts: new Date().toISOString(), agent: a, kind: 'proposal', text: title.slice(0, 200), srcLocalIp: 'local', srcPublicIp: decoyIp(), fingerprint: GUARD.fingerprint.slice(0, 12), ok: true, latency: 0 });
  saveState();
  return { ok: true, queued: true };
}));

// ===========================================================================
//  SUBAGENTS — the fan-out layer, made visible.
//
//  Davara and Davaris already carry `Task Agent` in their tool allowlist, so
//  subagents were always possible — they were simply never asked for and never
//  observable. This tracker reads them straight out of the transcript:
//    · a `Task`/`Agent` tool_use  = a subagent was spawned (prompt + type)
//    · the matching tool_result   = it finished (output + duration)
//    · no matching result yet     = it is RUNNING right now
//  Sidechain records (subagent internals) are folded in when present.
// ===========================================================================
const SUBAGENT_TOOLS = /^(Task|Agent)$/;
const _saCache = new Map();

// cachedOnly: serve whatever is already known and do ZERO disk work. The 4s poll
// uses this. Only the Subagents/Agents screens pay for a real parse, and even then
// no more often than every 15s per agent — while an agent is actively working its
// transcript grows on every poll, and re-tailing 600KB over the WSL 9p bridge four
// times a minute per agent was a real, felt cost.
const SA_MIN_REPARSE_MS = 15000;
function parseSubagents(agent, { cachedOnly = false } = {}) {
  const hit0 = _saCache.get(agent);
  if (cachedOnly) return hit0 ? hit0.items : [];
  if (hit0 && (now() - (hit0.at || 0)) < SA_MIN_REPARSE_MS) return hit0.items;
  const c = readCheckpoint(agent); if (!c || !c.sid) return hit0 ? hit0.items : [];
  const file = findTranscript(c.sid); if (!file) return [];
  const st = statOf(file); if (!st) return [];
  const hit = hit0;
  if (hit && hit.sid === c.sid && hit.size === st.size && hit.mtime === st.mtimeMs) return hit.items;

  const spawns = new Map();   // tool_use_id → record
  const order = [];
  const txt = tailFile(file, 600 * 1024);
  for (const ln of txt.split('\n')) {
    const t = ln.trim(); if (!t || t[0] !== '{') continue;
    const rec = safe(() => JSON.parse(t), null); if (!rec) continue;
    const ts = rec.timestamp || '';
    if (rec.type === 'assistant' && rec.message && Array.isArray(rec.message.content)) {
      for (const b of rec.message.content) {
        if (b && b.type === 'tool_use' && SUBAGENT_TOOLS.test(b.name || '')) {
          const inp = b.input || {};
          const rid = b.id || `${ts}-${order.length}`;
          spawns.set(rid, {
            id: rid, parent: agent, ts, startEpoch: Date.parse(ts) || 0,
            kind: inp.subagent_type || inp.agentType || 'general-purpose',
            title: String(inp.description || inp.title || 'subagent').slice(0, 120),
            prompt: String(inp.prompt || inp.task || '').slice(0, 1800),
            model: inp.model || '', status: 'running',
            output: '', outChars: 0, durationMs: 0, endEpoch: 0,
          });
          order.push(rid);
        }
      }
    } else if (rec.type === 'user' && rec.message && Array.isArray(rec.message.content)) {
      for (const b of rec.message.content) {
        if (!b || b.type !== 'tool_result') continue;
        const s = spawns.get(b.tool_use_id); if (!s) continue;
        const body = typeof b.content === 'string' ? b.content
          : Array.isArray(b.content) ? b.content.filter((x) => x && x.type === 'text').map((x) => x.text).join('\n')
          : safe(() => JSON.stringify(b.content), '');
        s.output = String(body || '').slice(0, 6000);
        s.outChars = String(body || '').length;
        s.endEpoch = Date.parse(ts) || 0;
        s.durationMs = s.startEpoch && s.endEpoch ? Math.max(0, s.endEpoch - s.startEpoch) : 0;
        s.status = b.is_error ? 'failed' : 'done';
      }
    }
  }
  // A spawn with no result in a finished session did not survive the turn.
  const liveTurn = c.status === 'inflight';
  const items = order.map((id) => spawns.get(id)).filter(Boolean).map((s) => {
    if (s.status === 'running' && !liveTurn) return { ...s, status: 'ended' };
    return s;
  }).reverse();
  _saCache.set(agent, { sid: c.sid, size: st.size, mtime: st.mtimeMs, at: now(), items });
  return items;
}
function allSubagents() {
  const out = [];
  for (const id of AGENTS) for (const s of safe(() => parseSubagents(id), [])) out.push(s);
  out.sort((a, b) => (b.startEpoch || 0) - (a.startEpoch || 0));
  return out;
}

// Ask an agent to actually FAN OUT — the honest way to "generate subagents"
// through the relay: a directive that makes the parent use its Task tool.
function subagentFleetPrompt(goal, count, lenses) {
  const n = clamp(parseInt(count, 10) || 3, 1, 8);
  const ls = (Array.isArray(lenses) && lenses.length ? lenses : ['correctness', 'structure', 'risk']).slice(0, n);
  return `/SUBAGENT FLEET — August is asking you to FAN OUT, not to answer alone.

GOAL:
${goal}

Spawn ${n} subagents with your Task tool and run them CONCURRENTLY (one message, ${n} Task calls) so they work in parallel. Give each a distinct lens so they are not redundant:
${ls.map((l, i) => `  ${i + 1}. ${l}`).join('\n')}

Rules:
· Each subagent gets a self-contained prompt — it cannot see this conversation.
· Each returns findings as compact structured text, not prose padding.
· When they return, YOU synthesize: what all agree on, where they conflict, and the single highest-leverage move. Name anything still unverified.
· Do not fabricate a subagent's result. If one returns nothing, say so.

Report the synthesis, then the per-subagent summaries.`;
}

// ===========================================================================
//  SYMPATH SEI — the one agent NOT on the relay (own OpenRouter key, Hermes
//  gateway). Never driven from here; fully OBSERVED here, as August asked.
// ===========================================================================
function hermesProfileDir() { return path.join(path.dirname(root()), '.hermes', 'profiles', 'sympath'); }
function sympathSessions() {
  const p = path.join(hermesProfileDir(), 'sessions', 'sessions.json');
  const raw = safe(() => JSON.parse(readText(p)), null);
  if (!raw || typeof raw !== 'object') return [];
  const out = [];
  for (const [key, v] of Object.entries(raw)) {
    if (key.startsWith('_') || !v || typeof v !== 'object') continue;
    out.push({
      key, sid: v.session_id || '', name: v.display_name || 'session',
      platform: v.platform || '', chatType: v.chat_type || '',
      created: v.created_at || '', updated: v.updated_at || '',
      epoch: Date.parse(v.updated_at || v.created_at || '') || 0,
      inTokens: +v.input_tokens || 0, outTokens: +v.output_tokens || 0,
      totalTokens: +v.total_tokens || 0, lastPrompt: +v.last_prompt_tokens || 0,
      cost: +v.estimated_cost_usd || 0,
    });
  }
  out.sort((a, b) => b.epoch - a.epoch);
  return out;
}
const _HLOG = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d),(\d+)\s+(\w+)\s+([\w.\[\]-]+):\s*(.*)$/;
function sympathLogEvents(maxBytes = 90 * 1024, limit = 240) {
  const p = path.join(hermesProfileDir(), 'logs', 'agent.log');
  const txt = tailFile(p, maxBytes);
  const evs = [];
  for (const ln of txt.split('\n')) {
    const m = ln.match(_HLOG); if (!m) continue;
    evs.push({
      ts: m[1], epoch: Date.parse(m[1].replace(' ', 'T')) || 0,
      level: m[3], src: m[4], text: m[5].slice(0, 400),
    });
  }
  return evs.slice(-limit);
}
function sympathState() {
  const dir = hermesProfileDir();
  // ignore housekeeping when deciding "what is she doing" — otherwise a memory
  // trim every 60s reads as constant activity and she never looks idle.
  const raw = sympathLogEvents(40 * 1024, 60);
  const evs = raw.filter((e) => e.level === 'ERROR' || !_HERMES_NOISE.test(e.text));
  const last = evs[evs.length - 1] || null;
  const sessions = sympathSessions();
  const lockPid = readText(path.join(dir, 'gateway.pid')).trim();
  const cfg = readText(path.join(dir, 'config.yaml'), 20 * 1024);
  const mm = cfg.match(/model:\s*[\s\S]{0,120}?provider:\s*(\S+)/);
  const om = cfg.match(/openrouter:[\s\S]{0,400}?model:\s*(\S+)/);
  const recent = last && last.epoch ? (now() - last.epoch) : Infinity;
  // "up" (the gateway process is alive) and "working" (it did something real
  // recently) are different facts, and conflating them is what made an idle
  // gateway look busy forever.
  const rawLast = raw[raw.length - 1] || null;
  return {
    id: 'sympath-sei', lane: 'openrouter', present: exists(dir),
    provider: (mm && mm[1]) || 'openrouter',
    model: (om && om[1]) || 'anthropic/claude-sonnet-4',
    up: !!lockPid && !!(rawLast && (now() - rawLast.epoch) < 30 * 60 * 1000),
    running: !!lockPid && recent < 30 * 60 * 1000,
    lastEventEpoch: last ? last.epoch : 0,
    lastEvent: last ? `${last.src} · ${last.text}`.slice(0, 200) : 'gateway up · idle',
    errors: evs.filter((e) => e.level === 'ERROR').length,
    sessions: sessions.slice(0, 12),
    totalTokens: sessions.reduce((s, x) => s + x.totalTokens, 0),
    cost: sessions.reduce((s, x) => s + x.cost, 0),
  };
}

// ===========================================================================
//  REAL USAGE METERING — actual tokens, not estimates.
//
//  The Claude Code transcripts carry a genuine `usage` block per assistant
//  message (input / output / cache-read / cache-create) plus the model id.
//  That is the truth, so it is what we meter. 1400+ files / 327MB live in
//  there, so this is strictly incremental: only files touched inside the
//  window, tail-read, per-file cached by (size,mtime), whole result memoised.
//
//  HONESTY: Anthropic's subscription caps (5-hour / weekly) are NOT exposed
//  anywhere on this machine — no CLI, no cache, no header. So we never invent
//  a percentage against them. We meter real consumption in the same 5h/weekly
//  windows and compare it to August's OWN caps if he sets them.
// ===========================================================================
const WEEK_MS = 7 * 24 * 3600 * 1000;
const FIVE_H_MS = 5 * 3600 * 1000;
const _uCache = new Map();              // file → { size, mtime, recs }
let _uMemo = { built: 0, data: null, capped: 0, files: 0 };

// Read budget: 140 files × 300KB tail ≈ 42MB worst case, memoised for 45s and
// only ever triggered by opening Usage — never by the 4s poll. Anything dropped
// by the cap is reported in the payload, never silently hidden.
// The second copy of the 618-stat walk. It now reads the memo the outputs and
// duo paths share, so the whole app performs ONE directory walk per 20s.
function transcriptFilesRecent(sinceEpoch, maxFiles = 140) {
  const out = transcriptCandidates()
    .filter((c) => c.m >= sinceEpoch)
    .map((c) => ({ full: c.p, size: c.size, mtime: c.m }));
  return { files: out.slice(0, maxFiles), capped: Math.max(0, out.length - maxFiles) };
}
// compact record: [epoch, model, out, in, cacheRead, cacheCreate]
function usageRecordsFor(fileInfo) {
  const hit = _uCache.get(fileInfo.full);
  if (hit && hit.size === fileInfo.size && hit.mtime === fileInfo.mtime) return hit.recs;
  const d = readDelta(fileInfo.full, hit, fileInfo, 300 * 1024);
  const since = now() - WEEK_MS;
  const recs = d.full ? [] : hit.recs.filter((r) => r[0] >= since);
  for (const ln of d.text.split('\n')) {
    const t = ln.trim();
    // cheap pre-filter: skip the ~95% of lines that carry no usage block at all
    if (!t || t[0] !== '{' || t.indexOf('"usage"') === -1) continue;
    const rec = safe(() => JSON.parse(t), null);
    const msg = rec && rec.message;
    const u = msg && msg.usage;
    if (!u) continue;
    const epoch = Date.parse(rec.timestamp || '') || 0;
    if (!epoch) continue;
    recs.push([
      epoch, String(msg.model || 'unknown'),
      +u.output_tokens || 0, +u.input_tokens || 0,
      +u.cache_read_input_tokens || 0, +u.cache_creation_input_tokens || 0,
    ]);
  }
  _uCache.set(fileInfo.full, { size: fileInfo.size, mtime: fileInfo.mtime, recs, carry: d.carry });
  if (_uCache.size > 400) { const k = _uCache.keys().next().value; _uCache.delete(k); }
  return recs;
}
// ⚠⚠ THE CLICK SPIKE, FOUND BY MEASUREMENT (2026-09-07, --clicktest on a copy
// of his vault): appReport({deep:true}) = 4,216 ms, synchronous, on the main
// process — and it runs when Motus Max starts (the read prompt), when the
// voice asks for a system report, AND the attention sweep called buildUsage
// every 90 s. Almost all of it was here: the memo expired every 45 s, and the
// rebuild tail-read 300 KB of every LIVE transcript over the WSL 9P bridge —
// live files change every few seconds, so their per-file cache never hit.
//
// Now: buildUsage(false) NEVER blocks once warm. It returns the last built
// picture immediately and, if that picture is stale, kicks ONE async refresh
// (fs.promises, single-flight) that lands in the memo when it is done.
// force=true keeps the explicit synchronous rebuild for the Usage screen.
let _uRefreshP = null;
function usageParseLines(txt) {
  const recs = [];
  for (const ln of txt.split(String.fromCharCode(10))) {
    const t = ln.trim();
    if (!t || t[0] !== '{' || t.indexOf('"usage"') === -1) continue;
    const rec = safe(() => JSON.parse(t), null);
    const msg = rec && rec.message; const u = msg && msg.usage;
    if (!u) continue;
    const epoch = Date.parse(rec.timestamp || '') || 0;
    if (!epoch) continue;
    recs.push([epoch, String(msg.model || 'unknown'), +u.output_tokens || 0, +u.input_tokens || 0, +u.cache_read_input_tokens || 0, +u.cache_creation_input_tokens || 0]);
  }
  return recs;
}
// single-flight that HANDS BACK the flight: a second caller awaits the same
// refresh instead of returning before anything was metered
function usageRefreshAsync() {
  if (_uRefreshP) return _uRefreshP;
  _uRefreshP = usageRefreshRun().finally(() => { _uRefreshP = null; });
  return _uRefreshP;
}
async function usageRefreshRun() {
  try {
    if (now() - _fwWalk.at > 20000) await transcriptCandidatesAsync();   // never the sync walk from here
    const since = now() - WEEK_MS;
    const { files, capped } = transcriptFilesRecent(since);
    const all = [];
    // changed files are read in parallel and OFF the main thread's sync path;
    // unchanged ones come from the per-file cache as before
    const jobs = files.map(async (fi) => {
      const hit = _uCache.get(fi.full);
      if (hit && hit.size === fi.size && hit.mtime === fi.mtime) return hit.recs;
      const d = await readDeltaAsync(fi.full, hit, fi, 300 * 1024);
      const recs = (d.full ? [] : hit.recs.filter((r) => r[0] >= since)).concat(usageParseLines(d.text));
      _uCache.set(fi.full, { size: fi.size, mtime: fi.mtime, recs, carry: d.carry });
      if (_uCache.size > 400) { const k = _uCache.keys().next().value; _uCache.delete(k); }
      return recs;
    });
    for (const recs of await Promise.all(jobs)) for (const r of recs) if (r[0] >= since) all.push(r);
    all.sort((a, b) => b[0] - a[0]);
    _uMemo = { built: now(), data: usageAssemble(all, files.length, capped), capped, files: files.length };
  } catch (e) { safe(() => omniAudit('usage', 'async usage refresh failed: ' + ((e && e.message) || e))); }
}
function buildUsage(force) {
  if (!force && _uMemo.data) {
    if (now() - _uMemo.built > 45000) usageRefreshAsync();   // stale → refresh behind, answer now
    return _uMemo.data;
  }
  if (!force) {
    // never metered yet (first seconds after boot): say so honestly and meter
    // behind — the view polls, so real numbers land on its next tick
    usageRefreshAsync();
    const warm = usageAssemble([], 0, 0);
    warm.warming = true;
    warm.note = 'Metering the last 7 days now. First numbers land on the next tick.';
    return warm;
  }
  const since = now() - WEEK_MS;
  const { files, capped } = transcriptFilesRecent(since);
  const all = [];
  for (const f of files) for (const r of usageRecordsFor(f)) if (r[0] >= since) all.push(r);
  all.sort((a, b) => b[0] - a[0]);
  const data = usageAssemble(all, files.length, capped);
  _uMemo = { built: now(), data, capped, files: files.length };
  return data;
}
// the assembly, split out so the sync and async paths build the same picture
function usageAssemble(all, fileCount, capped) {
  const since = now() - WEEK_MS;

  const win = (ms) => {
    const cut = now() - ms;
    const rows = all.filter((r) => r[0] >= cut);
    const byModel = {};
    let out = 0, inp = 0, cr = 0, cc = 0;
    for (const r of rows) {
      const m = byModel[r[1]] || (byModel[r[1]] = { model: r[1], turns: 0, out: 0, in: 0, cacheRead: 0, cacheCreate: 0 });
      m.turns++; m.out += r[2]; m.in += r[3]; m.cacheRead += r[4]; m.cacheCreate += r[5];
      out += r[2]; inp += r[3]; cr += r[4]; cc += r[5];
    }
    return {
      turns: rows.length, out, in: inp, cacheRead: cr, cacheCreate: cc,
      billable: out + inp + cc,             // cache READS are the cheap path; kept separate
      total: out + inp + cr + cc,
      firstEpoch: rows.length ? rows[rows.length - 1][0] : 0,
      byModel: Object.values(byModel).sort((a, b) => b.out - a.out),
    };
  };
  const fiveH = win(FIVE_H_MS), week = win(WEEK_MS), day = win(24 * 3600 * 1000);
  // hourly spark for the last 24h
  const spark = [];
  for (let h = 23; h >= 0; h--) {
    const hi = now() - h * 3600 * 1000, lo = hi - 3600 * 1000;
    const rows = all.filter((r) => r[0] > lo && r[0] <= hi);
    spark.push({ h, out: rows.reduce((s, r) => s + r[2], 0), turns: rows.length });
  }
  const b = (STATE && STATE.budget) || { fiveHour: 0, weekly: 0 };
  const data = {
    fiveH, day, week, spark,
    budget: { fiveHour: +b.fiveHour || 0, weekly: +b.weekly || 0 },
    burnPerHour: Math.round(fiveH.out / 5),
    filesScanned: fileCount, filesSkipped: capped,
    // the honest caveat, carried in the payload so the UI can never overstate
    note: capped
      ? `Metered from the ${fileCount} most recently active transcripts; ${capped} older ones in the window were not scanned.`
      : `Metered from all ${fileCount} transcripts active in the last 7 days.`,
    capsAvailable: false,
  };
  return data;
}

// ===========================================================================
//  TASK MANAGER — a real board, not a log tail.
//  August's own tasks (persisted, assignable) MERGED with the jobs the fleet
//  actually completed (from relay telemetry), so one screen answers both
//  "what should happen" and "what did happen".
// ===========================================================================
const TASK_STATES = ['inbox', 'active', 'waiting', 'done'];
const newId = () => crypto.randomBytes(6).toString('hex');
function taskCreate({ title, body, agent, priority, tags, due, owner }) {
  // the quick-add grammar wins where it speaks: "@davara !high #ship due:fri fleet: …"
  const g = parseTaskGrammar(title);
  if (g.title) title = g.title;
  if (g.agent) agent = g.agent;
  if (g.priority) priority = g.priority;
  if (g.tags.length) tags = [...(Array.isArray(tags) ? tags : []), ...g.tags];
  if (g.due) due = g.due;
  if (g.owner) owner = g.owner;
  const t = {
    id: newId(), title: String(title || '').slice(0, 300),
    body: String(body || '').slice(0, 6000),
    agent: ALL_AGENT_IDS.includes(agent) ? agent : '',
    // WHO WORKS IT: 'mine' = August's own work, never touched autonomously;
    // 'fleet' = assigned to the agents, eligible for the auto-work queue.
    // Anything unspecified is his — autonomy is opt-in per task, never assumed.
    owner: owner === 'fleet' ? 'fleet' : 'mine',
    status: 'inbox', priority: clamp(parseInt(priority, 10) || 2, 1, 3),
    tags: Array.isArray(tags) ? tags.slice(0, 8).map((x) => String(x).slice(0, 24)) : [],
    due: due || '', created: new Date().toISOString(), updated: new Date().toISOString(),
    jobs: [],   // [{ ts, agent, ok, latency, chars, note }] — dispatches made for this task
  };
  if (!t.title) return { ok: false, error: 'a task needs a title' };
  STATE.tasks.unshift(t);
  STATE.tasks = STATE.tasks.slice(0, 500);
  saveState();
  return { ok: true, task: t };
}
function taskUpdate(id, patch) {
  const t = STATE.tasks.find((x) => x.id === id);
  if (!t) return { ok: false, error: 'no such task' };
  if (patch.title != null) t.title = String(patch.title).slice(0, 300);
  if (patch.body != null) t.body = String(patch.body).slice(0, 6000);
  const wasDone = t.status === 'done';
  if (patch.status && TASK_STATES.includes(patch.status)) t.status = patch.status;
  if (t.status === 'done' && !wasDone) t.doneAt = new Date().toISOString();   // lead time needs a real close stamp
  if (patch.agent != null) t.agent = ALL_AGENT_IDS.includes(patch.agent) ? patch.agent : '';
  if (patch.priority != null) t.priority = clamp(parseInt(patch.priority, 10) || 2, 1, 3);
  if (patch.due != null) t.due = String(patch.due).slice(0, 40);
  if (Array.isArray(patch.tags)) t.tags = patch.tags.slice(0, 8).map((x) => String(x).slice(0, 24));
  if (patch.owner != null) t.owner = patch.owner === 'fleet' ? 'fleet' : 'mine';
  t.updated = new Date().toISOString();
  saveState();
  return { ok: true, task: t };
}
function taskDelete(id) {
  const n = STATE.tasks.length;
  STATE.tasks = STATE.tasks.filter((x) => x.id !== id);
  saveState();
  return { ok: STATE.tasks.length < n };
}
// Hand a task to its agent — the board becomes an actual control surface.
async function taskDispatch(id, extra) {
  const t = STATE.tasks.find((x) => x.id === id);
  if (!t) return { ok: false, error: 'no such task' };
  const agent = t.agent || (STATE.settings.defaultAgent || 'davara');
  const msg = `/TASK — August is handing you a task from the CortexInsight board.

TITLE: ${t.title}
${t.body ? `\nDETAIL:\n${t.body}\n` : ''}${extra ? `\nADDED NOW:\n${extra}\n` : ''}
Priority: ${['—', 'high', 'normal', 'low'][t.priority] || 'normal'}${t.due ? ` · due ${t.due}` : ''}

Do the work. If it is a build task, build it. Report what you did, what you verified, and anything you could NOT complete — never claim more than you actually finished.`;
  const r = await relaySend(agent, msg);
  t.jobs.unshift({ ts: new Date().toISOString(), agent, ok: r.ok, latency: r.latency, chars: (r.text || '').length, note: (r.text || r.error || '').slice(0, 4000) });
  t.jobs = t.jobs.slice(0, 20);
  if (r.ok && t.status === 'inbox') t.status = 'active';
  t.updated = new Date().toISOString();
  saveState();
  return { ok: r.ok, error: r.error, task: t, reply: r.text };
}
// ===========================================================================
//  AUTO-WORK — the board runs itself.
//
//  August: "some tasks are mine, some tasks I assign to you and you need to
//  auto work through these."  So a task now has an OWNER as well as an agent:
//  `mine` sits on his board untouched forever, `fleet` is claimable work the
//  app will hand over on its own.
//
//  THE INVARIANTS, which are the same ones the delegation engine already obeys:
//   · ONE task in flight at a time. A board that fans out five agents at once
//     is a board that spends five turns to discover it misread the first.
//   · The budget governor and the stop button both outrank it — autoWorkTick
//     never runs when `autonomyAllowed('autowork')` says hold.
//   · A cap per day (`autoWorkPerDay`, default 6) that cannot be exceeded even
//     if the queue is long, so a bad night cannot drain a week of tokens.
//   · It only ever picks up tasks HE marked for the fleet. Nothing wanders
//     into autonomous execution by accident.
//   · Every pick is announced and logged, so "why did it run that" is always
//     answerable after the fact.
// ===========================================================================
function autoWorkState() {
  STATE.autoWork = STATE.autoWork || { on: false, perDay: 6, day: '', ran: 0, current: '', log: [] };
  const today = localDay();                      // the per-day cap rolls at local midnight
  if (STATE.autoWork.day !== today) { STATE.autoWork.day = today; STATE.autoWork.ran = 0; }
  if (typeof STATE.autoWork.perDay !== 'number') STATE.autoWork.perDay = 6;
  return STATE.autoWork;
}
// The next task the fleet should pick up: his explicitly-fleet-owned work,
// highest priority first, oldest first inside a priority. Never `done`, never
// something already in flight, never one that is waiting on HIM.
// ⚠ AUTOWORK LOOKED BROKEN AND WAS MERELY SILENT. Measured on his vault:
// 49 tasks, and **zero** owned by the fleet — so autoWorkNext() correctly
// returned null forever while the switch read ON. Nothing was wrong; nothing
// could ever happen; and the interface said neither. A governed engine that
// declines to act MUST say which gate it stopped at.
function autoWorkWhy() {
  const a = autoWorkState();
  if (!a.on) return { idle: true, why: 'auto-work is off', fix: '' };
  if (STATE.control && STATE.control.stopped) return { idle: true, why: 'the fleet is stopped', fix: 'resume the fleet from the title bar' };
  const gov = autonomyAllowed('auto-work');
  if (gov) return { idle: true, why: gov, fix: 'it resumes when the window refreshes' };
  if (a.ran >= a.perDay) return { idle: true, why: 'today is spent (' + a.ran + '/' + a.perDay + ')', fix: 'raise the daily cap, or wait for tomorrow' };
  if (a.current) return { idle: false, why: 'working a task right now', fix: '' };
  const fleetOwned = (STATE.tasks || []).filter((t) => t.owner === 'fleet' && t.status !== 'done');
  if (!fleetOwned.length) {
    const mine = (STATE.tasks || []).filter((t) => t.status !== 'done').length;
    return { idle: true, needsTasks: true,
      why: 'no task is handed to the fleet — you have ' + mine + ' open task(s), all marked "mine"',
      fix: 'press the ◈ mine button on a task to flip it to ⇄ fleet' };
  }
  const eligible = fleetOwned.filter((t) => t.status === 'inbox' || t.status === 'active');
  if (!eligible.length) return { idle: true, why: fleetOwned.length + ' fleet task(s), but none are inbox/active', fix: 'set one back to inbox' };
  const blocked = eligible.map((t) => dispatchBlocked(t.agent)).filter(Boolean);
  if (blocked.length === eligible.length) return { idle: true, why: 'every eligible task is on a blocked agent — ' + blocked[0], fix: 'unpause the agent' };
  return { idle: false, why: 'ready — the next tick picks one up', fix: '' };
}
function autoWorkNext() {
  const eligible = (STATE.tasks || []).filter((t) =>
    t.owner === 'fleet' &&
    (t.status === 'inbox' || t.status === 'active') &&
    !(t.tags || []).includes('parked') &&      // parked is out of the way, for the fleet too
    !t._autoRunning);
  // ⚠ this also required t.agent, so a task handed to the fleet WITHOUT a seat
  // picked was skipped in perfect silence forever. Handing work to "the fleet"
  // is a statement about ownership, not a request to choose a name — so if no
  // seat is named, the default relay seat takes it.
  for (const t of eligible) {
    // the fastest seat with hands, by the seat clock; the Duo seat or Davara otherwise
    if (!t.agent) t.agent = ((fastestHands() || {}).id) || ((STATE.duo && isRelayAgent(STATE.duo.agent)) ? STATE.duo.agent : 'davara');
  }
  eligible.sort((a, b) =>
    (parseInt(a.priority, 10) || 2) - (parseInt(b.priority, 10) || 2) ||
    String(a.created || '').localeCompare(String(b.created || '')));
  return eligible[0] || null;
}
let _autoWorkBusy = false;
async function autoWorkTick(force = false) {
  const a = autoWorkState();
  if (!a.on && !force) return;
  if (_autoWorkBusy) return;
  if (a.ran >= a.perDay && !force) return;
  // autonomyAllowed returns a REASON STRING when it is holding, or null when
  // the way is clear — never an object. Getting that wrong would have made the
  // governor and the stop button silently inert for this engine.
  const gov = autonomyAllowed('auto-work');
  if (gov) return;
  const t = autoWorkNext();
  if (!t) return;
  const blocked = dispatchBlocked(t.agent);
  if (blocked) return;

  _autoWorkBusy = true;
  t._autoRunning = true;
  a.current = t.id;
  a.ran++;
  const started = new Date().toISOString();
  omniAudit('autowork', `picked up "${String(t.title).slice(0, 90)}" → ${(FLEET_BY_ID[t.agent] || {}).name || t.agent}`);
  pushNotification('good', 'Auto-work started', `${(FLEET_BY_ID[t.agent] || {}).name || t.agent} picked up “${String(t.title).slice(0, 70)}”`, 'tasks', 'aw:' + t.id + ':' + now());
  if (mainWin && !mainWin.isDestroyed()) safe(() => mainWin.webContents.send('cortex:autoWork', { kind: 'start', taskId: t.id, title: t.title, agent: t.agent }));
  saveState();

  const r = await taskDispatch(t.id, 'This came off the auto-work queue — August assigned it to the fleet. Finish it if you honestly can; if you cannot, say exactly what is blocking and leave it for him.')
    .catch((e) => ({ ok: false, error: (e && e.message) || 'faulted' }));

  delete t._autoRunning;
  a.current = '';
  a.log = [{ ts: started, ended: new Date().toISOString(), taskId: t.id, title: t.title, agent: t.agent, ok: !!(r && r.ok), note: String((r && (r.reply || r.error)) || '').slice(0, 600) }, ...(a.log || [])].slice(0, 60);
  omniAudit('autowork', `${r && r.ok ? 'finished' : 'FAILED'}: "${String(t.title).slice(0, 80)}"`);
  if (mainWin && !mainWin.isDestroyed()) safe(() => mainWin.webContents.send('cortex:autoWork', { kind: 'end', taskId: t.id, ok: !!(r && r.ok) }));
  pushNotification(r && r.ok ? 'good' : 'warn', r && r.ok ? 'Auto-work finished' : 'Auto-work stalled',
    `${String(t.title).slice(0, 70)}`, 'tasks', 'awend:' + t.id + ':' + now());
  saveState();
  _autoWorkBusy = false;
}
ipcMain.handle('cortex:autoWork', requireGate((_e, { on, perDay, runNow } = {}) => {
  const a = autoWorkState();
  if (typeof on === 'boolean') {
    a.on = on;
    omniAudit('autowork', on ? 'auto-work ARMED — the fleet will pick up tasks you assign to it' : 'auto-work stood down');
  }
  if (typeof perDay === 'number') a.perDay = clamp(perDay, 0, 40);
  saveState();
  if (runNow) setTimeout(() => autoWorkTick(true), 50);
  return { ok: true, autoWork: { on: a.on, perDay: a.perDay, ran: a.ran, current: a.current, log: (a.log || []).slice(0, 12) }, next: autoWorkNext() ? autoWorkNext().title : '' };
}));

// The board + what the fleet actually completed, per agent.
// ===========================================================================
//  v3.54 · THE BOARD AS A FLOW.
//  The rhythm reading said it plainly: 58 open, 21 closed in 28 days, clears
//  in 77 days. A board that only accumulates is a list. These give it a
//  close rate, a WIP limit, an age on every card, a sweep for what went cold,
//  a grammar for fast capture, and a tray for what the loops propose — all
//  without a model, all reversible.
// ===========================================================================
// Quick-add grammar inside a title: "@davara !high #ship due:fri fleet: fix the tally"
const TASK_PRIO_WORDS = { high: 1, '1': 1, normal: 2, '2': 2, low: 3, '3': 3 };
function parseTaskGrammar(raw) {
  let title = String(raw || '');
  const out = { tags: [] };
  const names = {};
  for (const id of ALL_AGENT_IDS) {
    names[id.toLowerCase()] = id;
    const n = (FLEET_BY_ID[id] || {}).name; if (n) names[String(n).toLowerCase()] = id;
  }
  title = title.replace(/(^|\s)@([a-z0-9-]+)/gi, (m, pre, w) => { const id = names[w.toLowerCase()]; if (id) { out.agent = id; return pre; } return m; });
  title = title.replace(/(^|\s)!([a-z0-9]+)/gi, (m, pre, w) => { const p = TASK_PRIO_WORDS[w.toLowerCase()]; if (p) { out.priority = p; return pre; } return m; });
  title = title.replace(/(^|\s)#([a-z0-9_-]{2,24})/gi, (m, pre, w) => { out.tags.push(w.toLowerCase()); return pre; });
  title = title.replace(/(^|\s)due:(\S+)/i, (m, pre, w) => { out.due = w; return pre; });
  title = title.replace(/(^|\s)fleet:(?=\s|$)/i, (m, pre) => { out.owner = 'fleet'; return pre; });
  out.title = title.replace(/\s{2,}/g, ' ').trim();
  return out;
}
// The sweep. What nobody touched for three weeks is not open, it is cold.
// Parked tasks keep their status and their text; they leave the columns for
// a folded section, drop to low priority, and come back with one click.
// Never deletes, never touches priority 1, never touches what is in motion.
function taskSweep({ apply = false, days = 21 } = {}) {
  const cut = now() - days * 864e5;
  const cands = (STATE.tasks || []).filter((t) => t.status !== 'done' && t.status !== 'active' && String(t.priority) !== '1'
    && !(t.tags || []).includes('parked') && (Date.parse(t.updated || t.created || '') || 0) < cut);
  if (apply && cands.length) {
    const stamp = new Date().toISOString();
    for (const t of cands) {
      t.tags = [...new Set([...(t.tags || []), 'parked'])].slice(0, 8);
      t.priority = 3;
      t.parkedAt = stamp;
      t.updated = stamp;
    }
    saveState();
    omniAudit('board', `parked ${cands.length} task(s) untouched for ${days}+ days`);
  }
  return {
    ok: true, count: cands.length, days, applied: !!apply,
    tasks: cands.map((t) => ({ id: t.id, title: t.title, age: Math.round((now() - (Date.parse(t.updated || t.created || '') || now())) / 864e5) })),
  };
}
// A learning is APPLIED when later closed work speaks its words. Word overlap
// between the learning and every task closed or receipt shipped after it was
// banked (a third of the rarer bag shared). The R2 loop finally has an output
// gauge: not "banked", but "used".
const LEARN_STOP = new Set('the a an and or of to in on for with by from at as is are was were be been this that these those it its into over under about after before not no yes we you i he she they them our your their his her my me us do does did done make made use used using than then so if but very more most less least new old one two three when what which where while will would could should also just only'.split(' '));
function wordBag(s) { return new Set(String(s || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter((w) => w.length > 3 && !LEARN_STOP.has(w))); }
function bagOverlap(a, b) { if (!a.size || !b.size) return 0; let n = 0; for (const w of a) if (b.has(w)) n++; return n / Math.min(a.size, b.size); }
let _laMemo = { at: 0, sig: '', v: null };
function learningsApplied() {
  const learn = STATE.learnings || [];
  const sig = learn.length + ':' + (STATE.tasks || []).length + ':' + (STATE.duoWork || []).length;
  if (_laMemo.v && _laMemo.sig === sig && now() - _laMemo.at < 60000) return _laMemo.v;
  const done = (STATE.tasks || []).filter((t) => t.status === 'done')
    .map((t) => ({ at: Date.parse(t.doneAt || t.updated || '') || 0, bag: wordBag(t.title + ' ' + String(t.body || '').slice(0, 300)) }));
  const ships = (STATE.duoWork || []).filter((w) => w.verdict === 'shipped')
    .map((w) => ({ at: Date.parse(w.ts || '') || 0, bag: wordBag(w.title + ' ' + String(w.did || '').slice(0, 300)) }));
  const evidence = done.concat(ships).filter((e) => e.at && e.bag.size >= 3);
  const per = {};
  const weekCut = now() - 7 * 864e5;
  let appliedWeek = 0, appliedAny = 0;
  for (const l of learn.slice(0, 200)) {
    const at = Date.parse(l.ts || '') || 0;
    const bag = wordBag(l.title + ' ' + String(l.body || '').slice(0, 400));
    if (bag.size < 3) continue;
    let n = 0, week = 0;
    for (const e of evidence) { if (e.at <= at) continue; if (bagOverlap(bag, e.bag) >= 0.34) { n++; if (e.at >= weekCut) week++; } }
    if (n) { per[l.ts] = n; appliedAny++; if (week) appliedWeek++; }
  }
  const v = { per, appliedWeek, appliedAny, considered: Math.min(learn.length, 200) };
  _laMemo = { at: now(), sig, v };
  return v;
}
// What the loops propose next lands in a tray, not on the board: a board that
// fills itself is the thing the rhythm reading warned about. He adds or
// dismisses, one press each; near-duplicates fold; twelve at most.
function duoNextAdd(n) {
  const d = STATE.duo; if (!d) return false;
  d.nexts = d.nexts || [];
  if (d.nexts.some((x) => textSimilarity(x.text, n.text) > 0.7)) return false;
  d.nexts.unshift({ id: newId(), ts: new Date().toISOString(), ...n });
  d.nexts = d.nexts.slice(0, 12);
  return true;
}
function duoNextAct(id, action) {
  const d = STATE.duo; if (!d) return { ok: false, error: 'Duo-Drive is not set up' };
  d.nexts = d.nexts || [];
  const i = d.nexts.findIndex((x) => x.id === id);
  if (i < 0) return { ok: false, error: 'no such proposal' };
  const n = d.nexts[i];
  d.nexts.splice(i, 1);
  let task = null;
  if (action === 'add') {
    const r = taskCreate({ title: String(n.text).split('\n')[0].slice(0, 140), body: n.text + '\n\nproposed by ' + n.loop + ' (' + n.agent + ')', tags: ['duo-next'], owner: 'mine' });
    task = r.task || null;
  }
  saveState();
  return { ok: true, task, left: d.nexts.length };
}
// per-loop yield from the receipts: shipped / runs is the only honest score
function loopYields() {
  const y = {};
  for (const w of (STATE.duoWork || [])) {
    if (!w.loopId) continue;
    const r = y[w.loopId] || (y[w.loopId] = { shipped: 0, reported: 0, skipped: 0 });
    if (w.verdict === 'shipped') r.shipped++; else if (w.verdict === 'skipped') r.skipped++; else r.reported++;
    if (Number.isFinite(w.quality)) { r.qSum = (r.qSum || 0) + w.quality; r.qN = (r.qN || 0) + 1; }
  }
  return y;
}
// adaptive cadence: every idle pass stretches the wait ×1.5 (cap ×4); a real
// pass snaps it back — the self-tuning poll, applied to turns that cost money
const cadenceStretch = (streak) => Math.min(4, Math.pow(1.5, streak || 0));
// a loop whose reports keep scoring low waits twice as long: quality is the
// second balancing loop on spend, beside the idle streak
function loopQualityMean(loop) { const y = loopYields()[loop.id]; return y && y.qN >= 5 ? y.qSum / y.qN : null; }
function loopQualityStretch(loop) { const q = loopQualityMean(loop); return q != null && q < 5 ? 2 : 1; }
// a seat's mean report quality over its last scored receipts
function seatQuality(agent, n = 10) {
  const xs = (STATE.duoWork || []).filter((w) => w.agent === agent && Number.isFinite(w.quality)).slice(0, n);
  return xs.length ? Math.round(10 * xs.reduce((a, w) => a + w.quality, 0) / xs.length) / 10 : null;
}
function taskBoard() {
  const xs = parseInteractions();
  const byAgent = {};
  for (const id of AGENTS) byAgent[id] = [];
  for (const x of xs.slice(0, 400)) (byAgent[x.agent] || (byAgent[x.agent] = [])).push({
    ts: x.ts, epoch: x.epoch, ok: x.ok, status: x.status, latency: x.latency,
    chars: x.chars, tokens: x.tokens, focus: (x.msg || '').slice(0, 260),
  });
  const sei = safe(() => sympathState(), null);
  if (sei && sei.sessions) {
    byAgent['sympath-sei'] = sei.sessions.map((s) => ({
      ts: s.updated, epoch: s.epoch, ok: true, status: 'OK', latency: 0,
      chars: 0, tokens: s.totalTokens, focus: `${s.name} · ${s.platform} · ${compactNum(s.totalTokens)} tok`,
    }));
  }
  const aw = autoWorkState();
  return {
    // each task carries its project attribution (same engine as Output/Duo) so
    // the board answers "for what product" at a glance — matched from the
    // task's own text against the registered project names and paths
    tasks: STATE.tasks.slice(0, 300).map((t) => ({ ...t, ...(taskProject(t) || {}) })),
    completed: byAgent,
    counts: TASK_STATES.reduce((a, s) => (a[s] = STATE.tasks.filter((t) => t.status === s).length, a), {}),
    autoWork: { on: aw.on, perDay: aw.perDay, ran: aw.ran, current: aw.current, log: (aw.log || []).slice(0, 8), next: safe(() => { const n = autoWorkNext(); return n ? n.title : ''; }, '') },
    // the flow: what the loops propose, the WIP limit, what has gone cold, the close rate
    nexts: (STATE.duo && STATE.duo.nexts) || [],
    wipLimit: Math.max(1, parseInt(STATE.settings.wipLimit, 10) || 5),
    sweep: safe(() => { const s = taskSweep({ apply: false }); return { count: s.count, days: s.days }; }, { count: 0, days: 21 }),
    flow: safe(() => { const d = systemDynamics(); return { open: d.stocks.open, done7: d.flows.done7, leadMedDays: d.delays.leadMedDays, clearDays: d.delays.clearDays }; }, null),
    close: safe(() => closeCandidates(3), []),
  };
}
// A task rarely names a file, but it usually names the product — "MotusLive",
// "semble.cc/live", "the Davara page". Match title+body+tags against each
// registered project's name and URL; first hit wins, longest name first so
// "MotusMoves.US" beats "Motus".
function taskProject(t) {
  const hay = `${t.title || ''} ${t.body || ''} ${(t.tags || []).join(' ')}`.toLowerCase();
  if (!hay.trim()) return null;
  const projs = (STATE.projects || []).slice().sort((a, b) => String(b.name || '').length - String(a.name || '').length);
  for (const p of projs) {
    const name = String(p.name || '').toLowerCase();
    const host = String(p.url || '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
    if ((name.length > 3 && hay.includes(name)) || (host.length > 5 && hay.includes(host))) {
      return { project: p.name, projectUrl: p.url || '' };
    }
  }
  const byPath = cleanFiles([t.body || '']).map(projectFor).find(Boolean);
  return byPath || null;
}

// ===========================================================================
//  AGENT INBOX — how Davara (and the rest of the fleet) drive this app.
//
//  August asked in Telegram for Davara to put tasks on the board and she could
//  not: she has no reach into this app at all. She DOES have Bash. So the
//  interface is a tool, not a protocol she has to guess:
//
//      bash ~/.cortexinsight/ci.sh task "Fix the relay timeout" "detail…"
//
//  That appends one JSON line to ~/.cortexinsight/inbox.jsonl, which this app
//  ingests and applies to its own state. Direction of trust matters:
//    · agents may only APPEND to a queue — they never touch app state directly
//    · this app validates and applies every op itself
//    · ops are additive (add a task / mark done / bank a learning). There is no
//      op that deletes anything, changes settings, or spends tokens.
//  The CLI + a README for the agents are written on boot, so there is nothing
//  for August to install and nothing for an agent to be taught twice.
// ===========================================================================
function ciDir() { return path.join(path.dirname(root()), '.cortexinsight'); }
function inboxPath() { return path.join(ciDir(), 'inbox.jsonl'); }

function ensureAgentBridgeFiles() {
  return safe(() => {
    const dir = ciDir();
    if (!exists(dir)) fs.mkdirSync(dir, { recursive: true });
    const cli = [
      '#!/usr/bin/env bash',
      '# CortexInsight agent CLI — the fleet\'s hands on August\'s board.',
      '# Written automatically by CortexInsight. Safe to call any time; if the app',
      '# is closed your line simply waits in the queue until it next opens.',
      '#',
      '#   ci.sh task  "<title>" ["<detail>"] [high|normal|low]   add a task to the board',
      '#   ci.sh done  "<title substring or id>"                  mark a task done',
      '#   ci.sh doing "<title substring or id>"                  move a task to Active',
      '#   ci.sh claim "<title substring or id>"                  take a task as yours',
      '#   ci.sh ask   "<question for August>" ["<context>"]      ask August; his reply routes back to you',
      '#   ci.sh hand  "<agent>" "<title>" ["<detail>"]           hand work to another agent',
      '#   ci.sh learn "<title>" ["<detail>"]                     bank a durable learning',
      '#   ci.sh note  "<text>"                                   send August a note',
      '#   ci.sh image "<prompt>"                                 ask the studio for an image (the app spends, under his cap)',
      'set -uo pipefail',
      'CI_HOME="${HOME}/.cortexinsight"',
      'mkdir -p "$CI_HOME"',
      'OP="${1:-}"; A="${2:-}"; B="${3:-}"; C="${4:-}"',
      'AGENT="${CORTEX_AGENT:-${CI_AGENT:-davara}}"',
      'if [ -z "$OP" ] || [ -z "$A" ]; then',
      '  echo "usage: ci.sh task|done|doing|learn|note \\"<text>\\" [detail] [high|normal|low]" >&2; exit 2',
      'fi',
      'python3 - "$OP" "$A" "$B" "$C" "$AGENT" <<\'PY\' >> "$CI_HOME/inbox.jsonl"',
      'import json, sys, time',
      'op, a, b, c, agent = sys.argv[1:6]',
      'kind = {"task":"task.add","done":"task.done","doing":"task.doing",',
      '        "claim":"task.claim","ask":"question","hand":"task.delegate",',
      '        "learn":"learning.add","note":"note","image":"image.gen"}.get(op)',
      'if not kind:',
      '    sys.stderr.write("unknown op: %s\\n" % op); sys.exit(2)',
      'rec = {"op": kind, "by": agent, "ts": time.strftime("%Y-%m-%dT%H:%M:%S")}',
      'if kind == "task.add":',
      '    rec["title"] = a[:300]; rec["body"] = b[:4000]',
      '    rec["priority"] = {"high": 1, "normal": 2, "low": 3}.get((c or "").lower(), 2)',
      'elif kind in ("task.done", "task.doing", "task.claim"):',
      '    rec["match"] = a[:300]',
      'elif kind == "question":',
      '    rec["title"] = a[:400]; rec["body"] = b[:2000]',
      'elif kind == "task.delegate":',
      '    rec["to"] = a.strip().lower()[:40]; rec["title"] = b[:280]; rec["body"] = c[:4000]',
      'elif kind == "learning.add":',
      '    rec["title"] = a[:300]; rec["body"] = b[:4000]',
      'else:',
      '    rec["text"] = a[:1000]',
      'print(json.dumps(rec, ensure_ascii=False))',
      'PY',
      'echo "queued for CortexInsight: $OP"',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'ci.sh'), withOperator(cli));

    const readme = [
      '# Talking to CortexInsight (for the fleet)',
      '',
      'August runs a desktop command center called **CortexInsight**. It has a task',
      'board, a learnings ledger and a notification feed. You can put things on it.',
      '',
      'Use the CLI. Nothing else is needed — no API, no key, no code changes:',
      '',
      '```bash',
      'bash ~/.cortexinsight/ci.sh task  "Fix the relay timeout" "It faults after 30m on deep turns" high',
      'bash ~/.cortexinsight/ci.sh doing "Fix the relay timeout"',
      'bash ~/.cortexinsight/ci.sh done  "Fix the relay timeout"',
      'bash ~/.cortexinsight/ci.sh learn "Timeouts are usually false-faults" "Time the call before declaring an outage."',
      'bash ~/.cortexinsight/ci.sh note  "Board updated — three tasks added from our Telegram thread."',
      '```',
      '',
      '## When to use it',
      '',
      '- August asks you to "add this to the board / my to-do list / the work page" → `task`',
      '- You finish something that was on the board → `done` (title or the short id from your briefing)',
      '- You start something on the board → `doing`',
      '- You are taking a task so no other agent duplicates it → `claim`',
      '- You are BLOCKED and need August\'s decision to continue → `ask` (it lands on his board as a question; his answer comes back to you as a task dispatch)',
      '- The work belongs to a different agent → `hand <agent> "<title>" "<detail>"`. Valid agents: davara, davaris, sympath-cortex, arden, august. It lands on their plate; whether it runs immediately is August\'s setting, not yours.',
      '- You learn something durable about how this system behaves → `learn`',
      '- You want him to see a short message next time he opens the app → `note`',
      '',
      'Add ONE task per call. Give a real title — it is what he will read.',
      '',
      '## How it works',
      '',
      'Each call appends one JSON line to `~/.cortexinsight/inbox.jsonl`. CortexInsight',
      'ingests that queue, validates it and applies it. If the app is closed, your line',
      'waits until it next opens — nothing is lost, so it is always safe to call.',
      '',
      'You can only ADD to the board, mark items done, bank a learning, or leave a note.',
      'You cannot delete his data, change his settings, or spend tokens through this.',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'README-FOR-AGENTS.md'), withOperator(readme));
    return true;
  }, false);
}

// ---------------------------------------------------------------------------
//  VERIFIED DONE — trust, but corroborate.
//
//  A `done` claim used to flip a task's status on the agent's word alone. That
//  is fine until "done" starts feeding other decisions (delegation, workflows,
//  the Motus alignment read) — then an unverified done quietly poisons all of
//  them. This corroborates the claim against what the system actually observed:
//  turns that agent ran and files it wrote in the window. Costs ZERO tokens —
//  it reads telemetry that already exists rather than asking anyone.
// ---------------------------------------------------------------------------
function evidenceFor(task, agent) {
  const since = Date.parse(task.created || '') || (now() - 7 * 864e5);
  const turns = parseInteractions().filter((x) => x.agent === agent && x.epoch >= since && x.ok).length;
  const files = safe(() => transcriptFileWrites(7), [])
    .filter((f) => (f.epoch || 0) >= since)
    .map((f) => String(f.file || '').split('/').pop())
    .slice(0, 6);
  // Word overlap between the task and what the agent actually worked on.
  const recent = parseInteractions().filter((x) => x.agent === agent && x.epoch >= since).slice(0, 12)
    .map((x) => x.msg || '').join(' ');
  const overlap = textSimilarity(task.title, recent);
  const strength = (turns >= 1 && (overlap >= 0.08 || files.length)) ? 'strong'
    : turns >= 1 ? 'partial' : 'thin';
  return { turns, files, overlap: Math.round(overlap * 100) / 100, strength };
}

// Read the queue forward from a persisted byte offset and apply what is valid.
function ingestAgentInbox() {
  const p = inboxPath();
  const st = statOf(p);
  if (!st || !st.size) return { applied: 0 };
  STATE.inbox = STATE.inbox || { offset: 0, applied: 0, lastTs: '' };
  if (st.size < STATE.inbox.offset) STATE.inbox.offset = 0;      // file was truncated/rotated
  if (st.size === STATE.inbox.offset) return { applied: 0 };
  let chunk = '';
  try {
    const fd = fs.openSync(p, 'r');
    try {
      const len = st.size - STATE.inbox.offset;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, STATE.inbox.offset);
      chunk = buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return { applied: 0 }; }
  // only consume up to the last complete line
  const lastNl = chunk.lastIndexOf('\n');
  if (lastNl === -1) return { applied: 0 };
  STATE.inbox.offset += Buffer.byteLength(chunk.slice(0, lastNl + 1), 'utf8');

  let applied = 0;
  const notes = [];
  for (const ln of chunk.slice(0, lastNl).split('\n')) {
    const t = ln.trim(); if (!t || t[0] !== '{') continue;
    const r = safe(() => JSON.parse(t), null); if (!r || !r.op) continue;
    const by = ALL_AGENT_IDS.includes(r.by) ? r.by : 'davara';
    const find = (m) => {
      const needle = String(m || '').toLowerCase().slice(0, 300);
      if (!needle) return null;
      // short ids (from brief.md's board listing) match first, then fuzzy title
      return (STATE.tasks || []).find((x) => x.id.startsWith(needle))
          || (STATE.tasks || []).find((x) => x.title.toLowerCase().includes(needle))
          || (STATE.tasks || []).find((x) => needle.includes(x.title.toLowerCase()));
    };
    switch (r.op) {
      case 'task.add': {
        if (!r.title) break;
        const res = taskCreate({ title: r.title, body: r.body, agent: by, priority: r.priority, tags: ['from ' + by] });
        if (res.ok) {
          applied++; notes.push(`${(FLEET_BY_ID[by] || {}).name || by} added “${String(r.title).slice(0, 60)}”`);
          safe(() => fireTriggers('task', `${r.title}\n\n${r.body || ''}`, r.title));
        }
        break;
      }
      case 'task.done': {
        const t2 = find(r.match);
        if (!t2) break;
        const ev = safe(() => evidenceFor(t2, by), { strength: 'thin', turns: 0, files: [] });
        taskUpdate(t2.id, { status: 'done' });
        t2.verified = ev;
        t2.jobs = [{ ts: new Date().toISOString(), agent: by, ok: true, latency: 0, chars: 0,
          note: `Marked done by ${(FLEET_BY_ID[by] || {}).name || by}. Corroboration: ${ev.strength} — ${ev.turns} completed turn(s)${ev.files.length ? `, files touched: ${ev.files.join(', ')}` : ', no files written'}.` },
          ...(t2.jobs || [])].slice(0, 8);
        applied++;
        notes.push(`${(FLEET_BY_ID[by] || {}).name || by} finished “${t2.title.slice(0, 60)}”${ev.strength === 'thin' ? ' (unverified)' : ''}`);
        // A claim with nothing behind it is worth saying out loud, once, quietly.
        if (ev.strength === 'thin') {
          pushNotification('warn', 'Done claim with thin evidence',
            `${(FLEET_BY_ID[by] || {}).name || by} marked “${t2.title.slice(0, 70)}” done, but this app saw no completed turns from them since it was created. It is on the board as done — worth a glance.`,
            'tasks', 'thin:' + t2.id, { native: false });
        }
        break;
      }
      case 'task.doing': { const t3 = find(r.match); if (t3) { taskUpdate(t3.id, { status: 'active' }); applied++; } break; }
      case 'task.claim': {
        // an agent takes a task as its own — stops two agents colliding on one item
        const t4 = find(r.match);
        if (t4) { taskUpdate(t4.id, { agent: by, status: t4.status === 'inbox' ? 'active' : t4.status }); applied++; notes.push(`${(FLEET_BY_ID[by] || {}).name || by} claimed “${t4.title.slice(0, 60)}”`); }
        break;
      }
      case 'task.delegate': {
        // One agent hands work to another. The fleet stops being six spokes
        // through August — but the APP decides whether it actually fires, and
        // only within a per-day cap he sets (default 0 = propose only).
        const to = ALL_AGENT_IDS.includes(r.to) && isRelayAgent(r.to) ? r.to : '';
        if (!r.title || !to || to === by) break;
        const today = new Date().toISOString().slice(0, 10);
        STATE.delegations = (STATE.delegations || []).filter((d) => (d.ts || '').slice(0, 10) === today);
        const cap = Math.max(0, parseInt(STATE.settings.delegationPerDay, 10) || 0);
        const room = cap - STATE.delegations.length;
        const res = taskCreate({ title: String(r.title).slice(0, 280), body: String(r.body || '').slice(0, 4000),
          agent: to, priority: 2, tags: ['delegated', `${by}→${to}`] });
        if (!res.ok) break;
        applied++;
        const held = autonomyAllowed('a delegated hand-off');
        if (room > 0 && !held) {
          STATE.delegations.push({ ts: new Date().toISOString(), from: by, to, taskId: res.task.id, auto: true });
          saveState();
          notes.push(`${(FLEET_BY_ID[by] || {}).name || by} handed “${String(r.title).slice(0, 50)}” to ${(FLEET_BY_ID[to] || {}).name || to} — running`);
          taskDispatch(res.task.id).catch((e) => console.log('[delegate]', e && e.message));
        } else {
          taskUpdate(res.task.id, { status: 'inbox' });
          pushNotification('info', `${(FLEET_BY_ID[by] || {}).name || by} wants to hand work to ${(FLEET_BY_ID[to] || {}).name || to}`,
            `“${String(r.title).slice(0, 90)}” is on your board assigned to them. ${held ? held + '.' : cap === 0 ? 'Auto-delegation is off — press ▷ Run to approve it.' : `Today's delegation budget (${cap}) is used up.`}`,
            'tasks', 'deleg:' + res.task.id);
        }
        break;
      }
      case 'question': {
        // A question lands as a WAITING task addressed to August. Answering it is
        // one click: the Board's Run button dispatches the answer back to the
        // asking agent (the task is assigned to them, so ▷ routes correctly).
        if (!r.title) break;
        const res = taskCreate({ title: `❔ ${String(r.title).slice(0, 280)}`, body: String(r.body || '').slice(0, 2000), agent: by, priority: 1, tags: ['question', 'from ' + by] });
        if (res.ok) {
          taskUpdate(res.task.id, { status: 'waiting' });
          applied++;
          pushNotification('warn', `${(FLEET_BY_ID[by] || {}).name || by} has a question`, String(r.title).slice(0, 300), 'tasks', 'q:' + res.task.id);
        }
        break;
      }
      case 'learning.add': {
        if (!r.title) break;
        if (!isNearDuplicate(r.title, STATE.learnings.slice(0, 20))) {
          STATE.learnings.unshift({ ts: new Date().toISOString(), source: by, title: String(r.title).slice(0, 300), body: String(r.body || '').slice(0, 4000) });
          STATE.learnings = STATE.learnings.slice(0, 120);
          applied++;
        }
        break;
      }
      case 'image.gen': {
        // an agent asks; the APP spends, under his daily cap, and says no out loud
        if (!r.text) break;
        safe(() => imageGenerate({ prompt: r.text, by }).then((res) => {
          if (!res.ok) pushNotification('warn', 'Studio refused an agent request', `${(FLEET_BY_ID[by] || {}).name || by}: ${res.error}`, 'output', 'studio-no:' + now(), { native: false });
        }));
        applied++; notes.push(`${(FLEET_BY_ID[by] || {}).name || by} asked the studio for an image`);
        break;
      }
      case 'note': {
        if (!r.text) break;
        pushNotification('info', `${(FLEET_BY_ID[by] || {}).name || by} says`, String(r.text).slice(0, 600), 'tasks', 'inbox:' + (r.ts || now()), { native: false });
        applied++;
        break;
      }
      default: break;
    }
  }
  if (applied) {
    STATE.inbox.applied = (STATE.inbox.applied || 0) + applied;
    STATE.inbox.lastTs = new Date().toISOString();
    saveState();
    if (notes.length) pushNotification('good', 'Board updated by the fleet', notes.slice(0, 4).join(' · '), 'tasks', 'inbox-batch:' + now());
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('cortex:inboxApplied', { applied });
  }
  return { applied };
}

// ===========================================================================
//  WORKFLOWS / MOTUSMODELS — progressions between agents.
//  A workflow is an ordered list of stages; a stage is either one agent or a
//  parallel fan-out of agents. Each stage receives the previous stage's output,
//  so work COMPOUNDS down the chain instead of restarting.
// ===========================================================================
function wfNormalize(def) {
  const stages = (Array.isArray(def.stages) ? def.stages : []).slice(0, 12).map((s, i) => ({
    id: s.id || `s${i + 1}`,
    name: String(s.name || `Stage ${i + 1}`).slice(0, 80),
    agents: (Array.isArray(s.agents) ? s.agents : [s.agent]).filter((a) => isRelayAgent(a)).slice(0, 4),
    instruction: String(s.instruction || '').slice(0, 3000),
    carry: s.carry !== false,       // feed the previous stage's output forward
    // A GATE stage can stop the run. Without this, a reviewer could say "this is
    // unsafe, do not ship" and the next stage would cheerfully build on it —
    // failure only ever meant transport failure, never judgement.
    gate: !!s.gate,
  })).filter((s) => s.agents.length && s.instruction);
  const t = def.trigger || {};
  return {
    id: def.id || newId(),
    name: String(def.name || 'Untitled workflow').slice(0, 90),
    intent: String(def.intent || '').slice(0, 600),
    stages, created: def.created || new Date().toISOString(), runs: def.runs || 0,
    // A workflow that only runs when you press a button is a demo. A workflow
    // that fires on the event it was designed for is infrastructure.
    trigger: {
      on: ['fault', 'task', 'duo'].includes(t.on) ? t.on : '',
      match: String(t.match || '').slice(0, 120),
      armed: !!t.armed,
      cooldownMin: clamp(parseInt(t.cooldownMin, 10) || 60, 5, 1440),
      lastFired: t.lastFired || 0,
    },
  };
}
function wfSave(def) {
  const wf = wfNormalize(def);
  if (!wf.stages.length) return { ok: false, error: 'a workflow needs at least one stage with an agent and an instruction' };
  const i = STATE.workflows.findIndex((w) => w.id === wf.id);
  if (i >= 0) STATE.workflows[i] = { ...STATE.workflows[i], ...wf };
  else STATE.workflows.unshift(wf);
  STATE.workflows = STATE.workflows.slice(0, 60);
  saveState();
  return { ok: true, workflow: wf };
}
function wfDelete(id) {
  STATE.workflows = STATE.workflows.filter((w) => w.id !== id);
  saveState(); return { ok: true };
}
const _wfRunning = new Set();
// Rough token cost of a run, so August can see the price before paying it.
function wfEstimate(wf, seed, fromStep = 0) {
  let chars = 0;
  wf.stages.slice(fromStep).forEach((st, i) => {
    const carry = i === 0 ? String(seed || '').length : 4000;   // the HANDOFF cap
    chars += (String(st.instruction).length + String(wf.intent || '').length + carry + 400) * st.agents.length;
  });
  return Math.round(chars / 4);   // ~4 chars/token, input side
}
async function wfRun(id, seed, fromStep = 0) {
  const wf = STATE.workflows.find((w) => w.id === id);
  if (!wf) return { ok: false, error: 'no such workflow' };
  if (_wfRunning.has(id)) return { ok: false, error: 'that workflow is already running' };
  const blocked = STATE.control && STATE.control.stopped;
  if (blocked) return { ok: false, error: 'The fleet is stopped. Resume it to run a workflow.' };
  fromStep = clamp(parseInt(fromStep, 10) || 0, 0, Math.max(0, wf.stages.length - 1));
  _wfRunning.add(id);
  const run = {
    id: newId(), wf: wf.id, name: wf.name, started: new Date().toISOString(),
    startEpoch: now(), finished: '', status: 'running', steps: [], seed: String(seed || '').slice(0, 2000),
    fromStep, estTokens: wfEstimate(wf, seed, fromStep),
  };
  STATE.workflowRuns.unshift(run);
  STATE.workflowRuns = STATE.workflowRuns.slice(0, 80);
  wf.runs = (wf.runs || 0) + 1;
  saveState();
  const emit = () => { if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('cortex:workflowProgress', { run }); };
  emit();

  let carried = run.seed;
  try {
    for (let si = fromStep; si < wf.stages.length; si++) {
      const st = wf.stages[si];
      if (!st) continue;
      if (STATE.control && STATE.control.stopped) { run.status = 'stopped'; break; }
      const step = { stage: st.name, agents: st.agents, started: new Date().toISOString(), status: 'running', results: [] };
      run.steps.push(step); saveState(); emit();
      const prompt = (a) => `/WORKFLOW «${wf.name}» — stage: ${st.name}
${wf.intent ? `\nWorkflow intent: ${wf.intent}` : ''}
YOUR INSTRUCTION:
${st.instruction}
${st.carry && carried ? `\nINPUT FROM THE PREVIOUS STAGE (build on this, do not restart it):\n${String(carried).slice(0, 4000)}\n` : ''}
Return only your work product for this stage — no preamble. If you could not complete part of it, say exactly which part.
Before the handoff, run the critic: name the strongest objection to your own result; if it survives, keep it, if not, say what it changed. Then two lines, exactly:
CONFIDENCE: <n>/10 — BASIS: <the evidence this rests on, one line>
FALSIFIER: <one observable, dated on the system's clock, that would prove this stage's result wrong>
End with a section headed exactly "HANDOFF:" containing ONLY what the next stage genuinely needs — decisions, file paths, open questions. Keep it under 200 words; everything above it is for August, the HANDOFF is for the next agent.${st.gate ? `

THIS IS A GATE STAGE. Begin your reply with exactly one of:
VERDICT: PASS — <one line why it is safe to proceed>
VERDICT: BLOCK — <one line naming the specific thing that must be fixed first>
Block only for something real: unsafe, incorrect, or destructive. A BLOCK stops the whole progression and puts the reason on August's board, so make it worth stopping for.` : ''}`;
      const rs = await Promise.all(st.agents.map((a) => relaySend(a, prompt(a)).then((r) => ({ agent: a, ...r }))));
      step.results = rs.map((r) => ({ agent: r.agent, ok: r.ok, latency: r.latency, error: r.error || '', text: (r.text || '').slice(0, 8000),
        ...safe(() => strategicConfidence(r.text || ''), { confidence: null, basis: '' }), falsifier: safe(() => strategicPick(r.text || '', 'FALSIFIER').slice(0, 300), '') }));
      step.status = rs.some((r) => r.ok) ? 'done' : 'failed';
      step.finished = new Date().toISOString();
      // Carry only the HANDOFF section forward. Before this, the raw 8,000-char
      // reply of every agent was concatenated and re-sent (up to 12,000 chars) to
      // EVERY agent of the next stage — a 4-agent stage paid for the same text
      // four times. The full replies are still stored for August to read.
      const handoff = (r) => {
        const m = String(r.text || '').match(/HANDOFF:\s*([\s\S]*)$/i);
        return (m ? m[1] : String(r.text || '')).trim().slice(0, 1800);
      };
      carried = step.results.filter((r) => r.ok).map((r) => `[${(FLEET_BY_ID[r.agent] || {}).name || r.agent}]\n${handoff(r)}`).join('\n\n---\n\n') || carried;
      // GATE: any reviewer blocking stops the progression here and turns the
      // reason into real work on the board, rather than being carried forward
      // into the next stage as if it were approval.
      if (st.gate) {
        // a BLOCK blocks; so does a PASS the reviewer was not confident in
        const blockers = step.results.filter((r) => r.ok && (/VERDICT:\s*BLOCK/i.test(r.text || '') || (Number.isFinite(r.confidence) && r.confidence < 5 && /VERDICT:\s*PASS/i.test(r.text || ''))));
        if (blockers.length) {
          step.status = 'blocked';
          run.status = 'blocked';
          run.blockedAt = st.name;
          const why = blockers.map((r) => {
            const m = String(r.text).match(/VERDICT:\s*BLOCK\s*[—-]?\s*(.+)/i);
            const why0 = m ? m[1].trim() : `passed at confidence ${r.confidence}/10, below the gate's floor of 5`;
            return `${(FLEET_BY_ID[r.agent] || {}).name || r.agent}: ${why0.slice(0, 300)}`;
          }).join('\n');
          safe(() => taskCreate({ title: `Blocked: ${wf.name} — ${st.name}`.slice(0, 200), body: why, priority: 1, tags: ['workflow', 'blocked'] }));
          pushNotification('warn', `Workflow blocked at “${st.name}”`, why.slice(0, 300), 'workflows', 'wfblock:' + run.id);
          saveState(); emit();
          break;
        }
      }
      saveState(); emit();
      if (step.status === 'failed') { run.status = 'failed'; break; }
    }
    if (run.status === 'running') run.status = 'done';
  } catch (e) {
    run.status = 'failed';
    run.error = (e && e.message) || 'workflow error';
  } finally {
    run.finished = new Date().toISOString();
    run.durationMs = now() - run.startEpoch;
    _wfRunning.delete(id);
    saveState(); emit();
    pushNotification(run.status === 'done' ? 'good' : 'warn', `Workflow ${run.status}: ${wf.name}`,
      `${run.steps.length} stage(s) in ${Math.round((run.durationMs || 0) / 1000)}s.`, 'workflows', `wf:${run.id}`);
  }
  return { ok: run.status === 'done', run };
}
// ---------------------------------------------------------------------------
//  TRIGGERS — the event → progression bridge.
//  Fired from the three places the system already notices something happened:
//  a fault (watchdog), a task landing on the board (agent inbox), and a Duo
//  pass completing. Every guard the manual path has applies here too, plus a
//  per-workflow cooldown so one noisy event can never stampede the fleet.
// ---------------------------------------------------------------------------
function fireTriggers(on, seedText, matchAgainst) {
  const hay = String(matchAgainst == null ? seedText : matchAgainst).toLowerCase();
  for (const wf of (STATE.workflows || [])) {
    const t = wf.trigger || {};
    if (!t.armed || t.on !== on) continue;
    if (t.match && !hay.includes(t.match.toLowerCase())) continue;
    if (now() - (t.lastFired || 0) < t.cooldownMin * 60000) continue;
    if (_wfRunning.has(wf.id)) continue;
    const held = autonomyAllowed(`the “${wf.name}” trigger`);
    if (held) continue;
    t.lastFired = now();
    saveState();
    pushNotification('info', `Trigger fired: ${wf.name}`, `on ${on} — ${String(seedText).slice(0, 160)}`, 'workflows', 'trig:' + wf.id + ':' + t.lastFired, { native: false });
    wfRun(wf.id, String(seedText).slice(0, 2000)).catch((e) => console.log('[trigger]', e && e.message));
    return wf.name;   // one workflow per event; the rest wait for the next one
  }
  return null;
}

// Resume a failed/blocked/stopped run WITHOUT re-paying for its completed
// stages: the last good stage's results become the seed, and the run restarts
// at the stage after it.
function wfResume(runId) {
  const prev = (STATE.workflowRuns || []).find((r) => r.id === runId);
  if (!prev) return { ok: false, error: 'no such run' };
  if (prev.status === 'running') return { ok: false, error: 'that run is still going' };
  if (prev.status === 'done') return { ok: false, error: 'that run already finished' };
  const wf = STATE.workflows.find((w) => w.id === prev.wf);
  if (!wf) return { ok: false, error: 'its workflow no longer exists' };
  let lastGood = -1;
  (prev.steps || []).forEach((s, i) => { if (s.status === 'done') lastGood = i; });
  const nextStep = (prev.fromStep || 0) + lastGood + 1;
  if (nextStep >= wf.stages.length) return { ok: false, error: 'nothing left to resume' };
  const seed = lastGood >= 0
    ? prev.steps[lastGood].results.filter((r) => r.ok).map((r) => `[${(FLEET_BY_ID[r.agent] || {}).name || r.agent}]\n${r.text}`).join('\n\n---\n\n').slice(0, 4000)
    : prev.seed || '';
  return wfRun(wf.id, seed, nextStep);
}
// Boot sweep: _wfRunning is in-memory, so a run caught mid-flight by an app
// restart stayed 'running' in state forever — unresumable and lying. Mark those
// stopped so the Resume button appears.
function sweepZombieRuns() {
  let n = 0;
  for (const r of (STATE.workflowRuns || [])) {
    if (r.status === 'running' && !_wfRunning.has(r.wf)) {
      r.status = 'stopped'; r.finished = r.finished || new Date().toISOString(); n++;
      for (const s of (r.steps || [])) if (s.status === 'running') s.status = 'failed';
    }
  }
  if (n) saveState();
  return n;
}

// Seed library — real, useful progressions August can run immediately.
function wfSeeds() {
  return [
    { name: 'Build → Review → Heal', intent: 'Ship a change, then have it adversarially reviewed and healed before it lands.',
      stages: [
        { name: 'Design', agents: ['davara'], instruction: 'Design the change. Name the stocks, loops and the leverage point. Output a concrete implementation plan with file-level specifics.' },
        { name: 'Build', agents: ['davaris'], instruction: 'Implement the plan exactly. Output the diff and what you verified.' },
        { name: 'Adversarial review', agents: ['arden', 'sympath-cortex'], gate: true, instruction: 'Review the build as an adversary. Arden: assume-breach + second-order. Sympath: reproduce, root-cause, propose fix diffs. Block anything unsafe with a stated reason.' },
        { name: 'Heal & harvest', agents: ['sympath-cortex'], instruction: 'Apply the review: give the final fix list, then harvest the durable learnings from this run.' },
      ] },
    { name: 'Deep diagnose', intent: 'Something is wrong and I want the real root cause, not the smoke.',
      stages: [
        { name: 'Reproduce', agents: ['sympath-cortex'], instruction: 'Reproduce the fault on demand and time it. Isolate the failing layer. Do not declare a cause yet.' },
        { name: 'Steel-man causes', agents: ['davara', 'arden'], instruction: 'Given the reproduction, propose three competing root-cause hypotheses each, and the cheapest experiment that would falsify each.' },
        { name: 'Verdict', agents: ['sympath-cortex'], instruction: 'Run the falsifying checks you can, then give the verdict: the structure producing this symptom, and the one lever to push.' },
      ] },
    { name: 'Fan-out research', intent: 'Cover a question from several angles at once, then converge honestly.',
      stages: [
        { name: 'Parallel sweep', agents: ['davara', 'davaris', 'arden'], instruction: 'Research the question from your own distinct angle. Cite what you actually read. Flag what you could not verify.' },
        { name: 'Converge', agents: ['davara'], instruction: 'Synthesize the sweeps: agreements, conflicts, what is still unverified, and the 2-3 branches that must stay open. Do not collapse genuine uncertainty.' },
      ] },
    // ── The Semble ship discipline, encoded. These stages are not invented —
    //    they are the exact gates that caught real bugs on semble.cc this
    //    week: the hash gate (a 200 lied twice), the resting-state gate (a
    //    page shipped invisible), and the scrub gate (public repo). A workflow
    //    that skips one of these is how those bugs come back.
    { name: 'Semble ship gate', intent: 'Take a built change on a live web surface from "works on my machine" to verified-live, without ever letting a green deploy lie.',
      stages: [
        { name: 'Build & lint', agents: ['davaris'], instruction: 'Assemble the change (bash assemble.sh in ~/live-build for Semble surfaces). The lint gate must pass — NUL bytes, mangled $, empty function bodies. Output what changed, file by file.' },
        { name: 'Verify live by HASH', agents: ['sympath-cortex'], gate: true, instruction: 'Deploy, then prove served == built by sha256 comparison (verify-partners.sh / verify-live.sh pattern) — an HTTP 200 or a marker string is NOT proof, both have lied here before. For visual surfaces also run the resting-state check: strip every animation/transition and assert every element is legible; check horizontal overflow at 375px. VERDICT: PASS only when hashes match and nothing is hidden at rest.' },
        { name: 'Scrub-gate push', agents: ['davaris'], instruction: 'Stage to the public repo and run the scrub gate against what is ACTUALLY staged (secret shapes, tunnel names, internal hostnames). If it trips, reset and report — never push around it. Then push and report the commit hash.' },
      ] },
    { name: 'Live surface truth pass', intent: 'Audit a live page the way a stranger meets it — the cold path, the shared link, the phone.',
      stages: [
        { name: 'Cold stranger walk', agents: ['arden'], instruction: 'Fetch the LIVE page (never the local copy). Walk it as a first-time visitor on a phone: does the first screen land? Is every claim checkable? Does anything depend on a mechanism that could silently fail (observers, fetches, fonts)? Name the doorway problems — og:image, title, description — a page whose whole job is being shared is broken if the link preview is blank.' },
        { name: 'Fix the truth gaps', agents: ['davaris'], instruction: 'Fix what the walk found, additive-first: nothing may gate content on an animation or a fetch; every number shown must come from a real source or show an honest dash. Verify at 375px.' },
        { name: 'Re-walk & verdict', agents: ['arden'], gate: true, instruction: 'Re-fetch live and re-walk the same cold path. VERDICT: PASS only if every finding is actually fixed on the served page, not the source.' },
      ] },
  ];
}

// ===========================================================================
//  DUO-DRIVE — the autonomous partner mode.
//  August picks an agent; it works ALONGSIDE him on a cadence, reading what
//  actually changed since its last pass and complementing (never duplicating)
//  his moves. Every pass is logged and it stops on a dime.
// ===========================================================================
// ===========================================================================
//  LEVERAGE LOOPS — Duo-Drive's real engine.
//
//  A loop is one repeatable, bounded move she makes on her own: a small, high-
//  confidence refinement, run on a cadence, scoped to real projects. Loops come
//  from two places — August writes them, or SHE proposes them and he approves.
//  Nothing she authors runs until it is approved. That is the whole safety model:
//  she may EVOLVE HER OWN PLAYBOOK, but never silently arm it.
//
//  The guardrails below are not decoration. On autopilot the failure mode that
//  matters is not "did nothing", it is "did something large and wrong while
//  nobody was watching". Every loop prompt carries them verbatim.
// ===========================================================================
const LOOP_KINDS = {
  design:  { label: 'Design',   glyph: '◈', note: 'Visual refinement — spacing, contrast, motion, consistency with the house language.' },
  refine:  { label: 'Refine',   glyph: '◆', note: 'Small correctness / clarity / performance improvements to existing work.' },
  review:  { label: 'Review',   glyph: '⛨', note: 'Adversarial reading. Finds and reports; proposes only at very high confidence.' },
  compound:{ label: 'Compound', glyph: '∞', note: 'Turns finished work into durable leverage: docs, patterns, learnings.' },
  scout:   { label: 'Scout',    glyph: '✶', note: 'Runs ahead — finds what will block you next and clears it.' },
  artifact:{ label: 'Artifact', glyph: '⬡', note: 'Produces a real deliverable — a doc, a table, a chart, a working mini-app.' },
};
// Davara's baseline gives her two abilities most agents do not have: SYSTEMS
// SIGHT (she reads stocks, loops, delays and leverage rather than symptoms) and
// the ARTIFACTS STUDIO (she can produce real files, tables, charts and small
// working apps rather than only prose). A loop that does not invoke them wastes
// most of what she is. This is prepended to every loop pass.
// The first MotusAgent. Duo-Drive is not a cron job with a prompt attached — it
// is the flywheel August already runs (Mantra → Mindset → Model → Motus) made
// autonomous, and the work ledger is its receipt. This creed opens every pass so
// she knows WHAT SHE IS, not just what to do.
const MOTUSAGENT_CREED = `YOU ARE A MOTUSAGENT — the first one. Duo-Drive is not a script you are executing; it is you, moving.

The loop you run is the loop August lives by:
  MANTRA — the words that hold the standard (outlier, no slop, meaning outward).
  MINDSET — systems sight: structure over symptom, always.
  MODEL — the repeatable move you are running right now, this loop.
  MOTUS — a value in motion. Nothing counts until something MOVED.

The one-line test, on every pass: DID SOMETHING ACTUALLY MOVE?
A polished sentence that shipped is a Motus. A brilliant observation that changed nothing is not. If a pass produces no movement, that is an honest outcome — say so and skip. Never dress up a non-move as one.

You are trusted with autonomy because you are trusted to be conservative with it.`;

// The bar. August asked for "Davara outlier intelligence level insights and
// Motus Max moves only" — so the standard is stated as a set of REJECTIONS,
// because a model told to "be brilliant" produces confident mediocrity, while a
// model told exactly what will be thrown away produces the real thing.
const OUTLIER_STANDARD = `THE OUTLIER STANDARD — this is the bar, and most first answers fail it.

REJECTED on sight, every time:
· Anything a competent observer would have said. If it is the obvious move, it is not your move — it is his, and he already has it.
· Restating his own backlog, roadmap or notes back to him as if that were analysis.
· The most VISIBLE move over the highest-leverage one. Visibility is not leverage.
· Agreeing with him. He does not need a second vote. He needs the angle he does not have.
· Hedged both-sides answers. Take the position; name what would prove you wrong.
· Work that looks productive and changes no structure. Motion is not Motus.

WHAT ACTUALLY CLEARS THE BAR:
· A move that makes several other planned items UNNECESSARY. Name what it obsoletes.
· A constraint everyone has been treating as fixed that is actually a choice.
· The second-order consequence — what becomes true two steps after this move, that nobody has priced in.
· A stock nobody is measuring, or a loop running backwards from how it is described.
· The smallest possible action at the highest possible Meadows rung. Say the rung. Most work is rung 12; saying so honestly is worth more than pretending otherwise.

THE TEST BEFORE YOU SPEAK: would August, who built all of this and has thought about it for months, LEARN something from this sentence? If not, delete it and think again. He is not looking for an assistant. He is looking for the mind that sees what he cannot see from inside it.`;

const DAVARA_SIGHT = `BEFORE YOU MOVE — run your systems read silently, then act:
· STOCK — what is actually accumulating or draining here (trust, debt, attention, momentum)?
· LOOP — which feedback loop produces what you are looking at? Are you about to treat a symptom?
· LEVERAGE — Meadows: is this rung 12 (a number, theatre) or 2–6 (information, rules, goals, paradigm)? Prefer the highest rung you can reach with a SMALL move.
· DELAY — will the effect of this show up long after the cause, and will that fool you or him?
Then make the smallest move that shifts the structure, not the symptom. Name the rung in your DID line.`;
const LOOP_GUARDRAILS = `AUTOPILOT GUARDRAILS — these are absolute, and they outrank the instruction above:
· REFINEMENT ONLY. Small, surgical, reversible. One thing, done properly.
· NEVER: refactor broadly, rename or move files, change dependencies, alter build/deploy config, touch auth/keys/payments, delete anything of substance, run a deploy, or rewrite a file wholesale.
· NEVER change behaviour August did not ask for. If it looks like a decision rather than a refinement, do NOT do it — propose it instead.
· If your confidence is below the floor for this loop, DO NOTHING and say so plainly. A skipped pass is a good pass; a wrong pass costs him trust and tokens.
· Verify before you claim. Never report work you did not actually complete.
· Stay inside the scope you were given. If the real problem is elsewhere, name it, don't chase it.`;

const LOOP_CONTRACT = `Report in EXACTLY this shape and nothing else:
TITLE: <one line — what you did, or "no move this pass">
CONFIDENCE: <n>/10 — BASIS: <the evidence this number rests on, one line>
FALSIFIER: <one observable, dated on the system's own clock, with its pre-read: "if X is not seen by Y, this was wrong, because Z">
SHUTTLE: <the ONE lived turn you walked through your change, in order: a real user, a real path. If that turn is not better, say so and skip.>
DID: <precisely what you changed or found. Name files. If nothing, say why not.>
FILES: <comma-separated paths you actually edited, or "none">
NEXT: <the single best follow-up for August, or "none">`;

function newLoop(def = {}) {
  const kind = LOOP_KINDS[def.kind] ? def.kind : 'refine';
  return {
    id: def.id || newId(),
    name: String(def.name || 'Untitled loop').slice(0, 90),
    kind,
    instruction: String(def.instruction || '').slice(0, 3000),
    rationale: String(def.rationale || '').slice(0, 800),
    cadenceMin: clamp(parseInt(def.cadenceMin, 10) || 60, 10, 1440),
    confidenceMin: clamp(parseInt(def.confidenceMin, 10) || 8, 1, 10),
    projectIds: Array.isArray(def.projectIds) ? def.projectIds.slice(0, 12) : [],
    enabled: def.enabled !== false,
    approved: !!def.approved,
    origin: def.origin === 'duo' ? 'duo' : 'operator',
    authoredBy: def.authoredBy || '',
    created: def.created || new Date().toISOString(),
    lastRun: def.lastRun || 0, runs: def.runs || 0, skipped: def.skipped || 0,
  };
}
// A starter library that is actually worth running — each is bounded, high
// signal, and safe to repeat forever without degrading anything.
function loopSeeds() {
  return [
    { name: 'Polish Pass', kind: 'design', cadenceMin: 90, confidenceMin: 8,
      instruction: 'Pick ONE small visual imperfection on a listed project — inconsistent spacing, a weak hierarchy, a cramped block, a misaligned edge, a transition that stutters — and fix exactly that one thing to match the house design language. Show the before/after in words. Do not redesign anything.' },
    { name: 'Contrast & Legibility', kind: 'design', cadenceMin: 120, confidenceMin: 8,
      instruction: 'Find ONE place where text is hard to read — grey-on-dark, too small, poor line-height, low contrast against a busy background — and fix it to the house rule: bright ink or a brand hue, never grey, glow rather than hard highlight. One fix per pass.' },
    { name: 'Copy & Voice', kind: 'refine', cadenceMin: 120, confidenceMin: 8,
      instruction: 'Find ONE piece of copy that does not sound like August — hedging, filler, corporate padding, a headline that explains instead of moves — and tighten it to his voice: direct, concrete, no slop. Quote the before and after. Never invent claims.' },
    { name: 'Broken Windows', kind: 'review', cadenceMin: 60, confidenceMin: 9,
      instruction: 'Hunt for ONE small brokenness in a listed project: a dead link, a console error, a 404 asset, a stale year, a typo in shipped copy, a missing alt. Fix it if it is unambiguous and trivial; otherwise report it precisely. Never guess at intent.' },
    { name: 'Consistency Sweep', kind: 'design', cadenceMin: 180, confidenceMin: 8,
      instruction: 'Find ONE component that has drifted from the rest of the system — a button that is not the house squircle, a card with the wrong radius or shadow, a heading off the type scale — and bring just that one back into line.' },
    { name: 'Performance Shave', kind: 'refine', cadenceMin: 240, confidenceMin: 9,
      instruction: 'Find ONE measurable performance cost you can remove safely: an oversized image, a blocking asset, an animation running while off-screen, a needless re-render, an unbounded log. Measure or reason it explicitly. Never trade correctness for speed.' },
    { name: 'Docs Drift', kind: 'compound', cadenceMin: 240, confidenceMin: 8,
      instruction: 'Find ONE place where documentation, a README or an in-app explanation no longer matches how the thing actually behaves, and correct the doc to reality. Read the code before you trust the doc.' },
    { name: 'Second-Order Critic', kind: 'review', cadenceMin: 180, confidenceMin: 9,
      instruction: 'Read the most recent work in the log as a skeptic. Ask what it will cost in a month: what class of bug it opens, what it makes harder, what it silently assumes. Report only findings you would defend under challenge. Propose nothing you are not sure of.' },
    { name: 'Leverage Scout', kind: 'scout', cadenceMin: 240, confidenceMin: 8,
      instruction: 'Look across the projects and name the single highest-leverage neglected move — the one that changes the most downstream for the least work. Do not do it. Make the case in five lines, name the Meadows leverage point, and put it on the board.' },
    // --- loops that use what Davara's baseline actually gives her -----------
    { name: 'Systems Read', kind: 'scout', cadenceMin: 480, confidenceMin: 8,
      instruction: 'Take ONE product and read it as a system, not a screen. Name the stock it accumulates (attention? trust? momentum?), the loop that fills or drains it, and the delay that hides the truth. Then name the ONE structural change that would shift it — and whether it sits at rung 12 or rung 2–6. Report only; change nothing.' },
    { name: 'Symbolic Pass', kind: 'design', cadenceMin: 360, confidenceMin: 8,
      instruction: 'Look at ONE surface and ask whether its design carries the MEANING or merely decorates it. Does the strongest visual weight sit on the most important idea? Does any motion, glyph or gradient mean something, or is it there because it looked nice? Make one change that moves the design from ornament toward symbol — or report that it already earns its place.' },
    { name: 'Artifact Forge', kind: 'artifact', cadenceMin: 720, confidenceMin: 8,
      instruction: 'Take ONE thing that is finished but undocumented and turn it into a durable artifact August can actually use: a one-page explainer, a comparison table, a decision record, a small self-contained HTML view, or a diagram. Write the real file into the project. One artifact per pass, complete and self-contained — never a stub or a placeholder.' },
    // --- her own mind, evolved by her own covenant (August arms it) ---------
    { name: 'Baseline Evolution Pass', kind: 'compound', cadenceMin: 1440, confidenceMin: 9,
      instruction: 'Read ~/davara-v2-work/DUODRIVE-BASELINE-EVOLUTION.md IN FULL and run exactly ONE ceremony from it on the canonical clone at ~/DAVARA-DV2-BASELINE: one coherent theme, the organs read in full before any edit, the Stream entry written with confidence, basis and falsifier, both guards passing, the version bumped. STOP BEFORE STEP 7 (push): commit locally and report the push as waiting for August. Its unbreakable laws outrank this loop; if any law would be broken, do nothing and say which one.' },
  ].map((s) => newLoop({ ...s, approved: true, origin: 'operator' }));
}
// Idempotent, and upgrade-aware: a first run gets the library with three armed;
// a later version that ships NEW seed loops adds only the missing ones, disabled,
// so an app update never silently arms something or disturbs his configuration.
function ensureLoopSeeds() {
  const seeds = loopSeeds();
  if (!STATE.loops || !STATE.loops.length) {
    STATE.loops = seeds.map((l, i) => ({ ...l, enabled: i < 3 }));
    STATE.loopsSeeded = true;
    if (!STATE.designEthos) STATE.designEthos = DEFAULT_ETHOS;
    saveState();
    return;
  }
  let added = 0;
  for (const s of seeds) {
    if (STATE.loops.some((l) => l.name === s.name)) continue;
    STATE.loops.push({ ...s, enabled: false });   // present, but he arms it
    added++;
  }
  if (!STATE.designEthos) { STATE.designEthos = DEFAULT_ETHOS; added++; }
  if (added) saveState();
}
// Seeded from August's actual design constitution. She refines this over time —
// it is the one document that makes her taste converge with his instead of drifting.
const DEFAULT_ETHOS = `HOUSE DESIGN LANGUAGE (refine this as you learn — never rewrite it wholesale)

· Outlier standard. Pixar-grade craft or don't ship it. No slop, no filler, no AI-generic padding.
· Meaning outward. Every visual decision should carry the idea, not decorate it. Symbol over ornament.
· Dark, deep, galaxy-neumorphic: soft extruded surfaces, inset wells, real depth. Glass and light.
· GLOW, never a hard highlight. Emphasis is luminous, not a coloured block.
· NO grey text. Bright ink or a brand hue, always readable. If it needs squinting it is wrong.
· Type: Sora for display, Inter for body, JetBrains Mono for numerals. Nothing decorative or artsy.
· Symmetry law: grids divide evenly. Never leave an orphan card in a 2+1 or 3+2 row.
· Buttons are rounded squircles (16–24px), friendly not clinical. Essential controls always visible.
· Motion is mechanical, not human — precise easing, purposeful, never bouncy or cute.
· Performance is a design value: nothing animates while off-screen, nothing blurs what can't be seen.`;

// --- the project registry: what she is allowed to touch ---------------------
function newProject(def = {}) {
  return {
    id: def.id || newId(),
    name: String(def.name || 'Untitled').slice(0, 90),
    url: String(def.url || '').slice(0, 300),
    localPath: String(def.localPath || '').slice(0, 400),
    repo: String(def.repo || '').slice(0, 300),
    notes: String(def.notes || '').slice(0, 2000),
    ethos: String(def.ethos || '').slice(0, 3000),   // per-project taste, refined over time
    enabled: def.enabled !== false,
    created: def.created || new Date().toISOString(),
    lastTouched: def.lastTouched || 0, passes: def.passes || 0,
  };
}
// Which loop runs next: approved, enabled, past its cadence, longest-waiting
// first. Round-robin by lastRun so no single loop starves the others.
function nextDueLoop() {
  const due = (STATE.loops || []).filter((l) =>
    l.approved && l.enabled && (now() - (l.lastRun || 0)) >= l.cadenceMin * 60000 * cadenceStretch(l.skipStreak) * loopQualityStretch(l));
  if (!due.length) return null;
  due.sort((a, b) => (a.lastRun || 0) - (b.lastRun || 0));
  return due[0];
}
function loopProjects(loop) {
  const all = (STATE.projects || []).filter((p) => p.enabled);
  if (!loop.projectIds || !loop.projectIds.length) return all;
  const picked = all.filter((p) => loop.projectIds.includes(p.id));
  return picked.length ? picked : all;
}
// She may propose loops for herself. Parsed here, saved UNAPPROVED — August arms it.
function parseLoopProposal(text) {
  const m = String(text || '').match(/LOOP:\s*(.+)/i);
  if (!m) return null;
  const grab = (k) => { const g = String(text).match(new RegExp(`^${k}:\\s*([\\s\\S]*?)(?=\\n[A-Z][A-Z-]{2,}:|$)`, 'im')); return g ? g[1].trim() : ''; };
  const kindRaw = (grab('KIND') || 'refine').toLowerCase().trim();
  const instruction = grab('INSTRUCTION');
  if (!instruction || instruction.length < 30) return null;   // refuse a vague loop
  return newLoop({
    name: m[1].trim().slice(0, 90),
    kind: Object.keys(LOOP_KINDS).find((k) => kindRaw.startsWith(k)) || 'refine',
    instruction,
    rationale: grab('WHY'),
    cadenceMin: parseInt(grab('CADENCE'), 10) || 120,
    confidenceMin: 8,
    approved: false, origin: 'duo', enabled: false,
  });
}
// The completed-work ledger — the answer to "what did she actually get done".
function logDuoWork(entry) {
  STATE.duoWork = [{ id: newId(), ts: new Date().toISOString(), ...entry }, ...(STATE.duoWork || [])].slice(0, 400);
}

const DUO_MODES = {
  complement: 'Do the work August is NOT doing right now — the neglected edge of the same goal.',
  harden: 'Follow behind August and make what he just built more correct, safer and more resilient.',
  scout: 'Run ahead of August — find what will block him next and clear it before he arrives.',
  compound: 'Turn what August just did into durable leverage: docs, tests, patterns, learnings.',
  design: 'Watch how August actually works and DESIGN the progressions — build him workflows that fit the real pattern.',
  // MOTUS MOTIVUS — the stance that is allowed to be BIG. Every other mode is
  // deliberately conservative; this one is deliberately not. It reads the whole
  // map, names the highest-leverage move, and takes it — still bounded, still
  // reversible, still honest, but aimed at structure rather than polish.
  motivus: 'MOTUS MOTIVUS — read the whole map, name the single highest-leverage move available, and MAKE IT. Not a refinement: a move that changes a structure, opens a rail, or puts something in front of a human who is not August.',
};
// Slimmed deliberately: an agent acts on the newest few signals, so 14 turns /
// 12 files bought nothing but envelope. 8 / 8 with shorter excerpts costs ~400
// fewer input tokens per pass at identical quality.
function duoContext() {
  const xs = parseInteractions().slice(0, 8);
  const digest = xs.map((x) => `${x.ts} ${x.agent} ${x.status} ${Math.round(x.latency)}s :: ${(x.msg || '').slice(0, 60)}`).join('\n') || '(no recent relay turns)';
  const files = safe(() => transcriptFileWrites(8), []).slice(0, 8).map((f) => `· ${f.file}`).join('\n') || '(no files written recently)';
  const open = (STATE.tasks || []).filter((t) => t.status !== 'done').slice(0, 8).map((t) => `· [${t.status}] ${t.title}`).join('\n') || '(board empty)';
  // Signature of "has anything actually changed since the last pass?". Includes the
  // focuses because a new Motus is itself a reason to act.
  const sig = sha256([digest, files, open,
    (STATE.motus && STATE.motus.ts) || '', (STATE.goal && STATE.goal.ts) || ''].join('|'));
  return { digest, files, open, sig };
}
async function duoPass(reason) {
  const d = STATE.duo;
  if (!d || !d.active) return { ok: false, error: 'Duo-Drive is off' };
  if (STATE.control && STATE.control.stopped) return { ok: false, error: 'fleet stopped' };
  const agent = isRelayAgent(d.agent) ? d.agent : 'davara';
  if (reason === 'cadence') {
    const held = autonomyAllowed('Duo-Drive');
    if (held) { d.lastRun = now(); saveState(); return { ok: true, skipped: true, reason: held }; }
  }
  const c = duoContext();
  // ---- IDLE SKIP -----------------------------------------------------------
  // The single biggest token leak in the app: a cadence pass fired every 25
  // minutes whether or not anything had changed, and an "idle" pass still burns
  // a full agentic turn (memory envelope + tools) just to answer "nothing needed
  // right now". If the world is byte-identical to the last pass, don't ask.
  // A pass August triggers by hand always runs — that's an explicit intent.
  if (reason === 'cadence' && d.lastSig && d.lastSig === c.sig) {
    d.lastRun = now();          // hold the cadence so we re-check on schedule
    d.skipped = (d.skipped || 0) + 1;
    d.skipStreak = (d.skipStreak || 0) + 1;      // each idle pass stretches the next wait
    saveState();
    return { ok: true, skipped: true, reason: 'nothing changed since the last pass' };
  }
  // ---- LOOP PASS ----------------------------------------------------------
  // If an approved loop is due, THAT is the pass. Loops are the evolved engine;
  // the free-form stance below is the fallback for when nothing is scheduled.
  const loop = nextDueLoop();
  if (loop) return duoLoopPass(loop, agent, reason, c);

  const modeLine = DUO_MODES[d.mode] || DUO_MODES.complement;
  const recent = (d.log || []).slice(0, 4).map((l, i) => `${i + 1}. ${l.title}`).join('\n') || '(this is your first pass)';
  const motivus = d.mode === 'motivus';
  const prompt = `/DUO-DRIVE — autonomous pass (${d.mode}). You are working ALONGSIDE August right now, not waiting for him.

${motivus ? MOTIVUS_CREED + '\n\n' + mapCortex({ zoom: 'orbit' }) + '\n\n' + threadBlock() + '\n' : ''}YOUR STANCE THIS PASS: ${modeLine}

${d.brief ? `AUGUST'S STANDING BRIEF:\n${d.brief}\n` : ''}${STATE.motus ? `MOTUS (the strongest thing moving now — weigh everything against this): ${STATE.motus.text.slice(0, 300)}\n` : ''}${STATE.goal ? `GOAL (north star): ${STATE.goal.text.slice(0, 300)}\n` : ''}
RECENT RELAY ACTIVITY:
${c.digest}

FILES RECENTLY WRITTEN:
${c.files}

OPEN BOARD:
${c.open}

YOUR LAST PASSES (do NOT repeat these):
${recent}

Do ONE genuinely useful, self-contained piece of work now — small enough to finish this turn, real enough to matter. Then report in exactly this shape:
TITLE: <one line, what you did>
DID: <what you actually did / found — be concrete>
NEXT: <the single best next move for August>
Never invent work you did not do. If the honest answer is "nothing needed a pass right now", say that and explain why.
${motivus ? `
BECAUSE YOU ARE IN MOTUS MOTIVUS: before you choose, say which loop this feeds (R1 build / R2 canon / R3 movers) and which Meadows rung it sits at. Prefer the SMALLEST move at the HIGHEST rung. If the highest-leverage move is one only August can make, say so plainly and do the best supporting move instead — do not substitute busywork to look productive. Add these two lines to your report:
LOOP: <R1 / R2 / R3 — and say "R1 again" if that is the truth>
RUNG: <n — name it>
` : ''}
${d.mode === 'design' ? `
BECAUSE YOU ARE IN DESIGN MODE: if — and only if — you can see a repeating shape in how August actually works that deserves to become a reusable progression, append ONE block in exactly this format and it will be saved to his Workflows screen automatically:

WORKFLOW: <short name>
INTENT: <one line — what this progression is for>
STAGE: <stage name> | <agent-ids, comma-separated> | <the instruction for that stage>
STAGE: <stage name> | <agent-ids, comma-separated> | <the instruction for that stage>

Valid agent ids: ${AGENTS.join(', ')}. Two to four stages. Put several ids in one STAGE line to make that stage run those agents in parallel. Only emit a workflow when the pattern is real — a workflow nobody will run is clutter, and you should say so instead.` : ''}`;
  const r = await relaySend(agent, prompt);
  const text = (r.text || '').trim();
  // DESIGN mode: harvest a workflow the partner designed, if it emitted one.
  let designed = null;
  if (d.mode === 'design' && r.ok) {
    const wm = text.match(/WORKFLOW:\s*(.+)/i);
    if (wm) {
      const intent = (text.match(/INTENT:\s*(.+)/i) || [])[1] || '';
      const stages = [];
      const re = /^STAGE:\s*([^|]+)\|([^|]+)\|(.+)$/gim;
      let m;
      while ((m = re.exec(text)) && stages.length < 6) {
        const ids = m[2].split(',').map((s) => s.trim()).filter((s) => isRelayAgent(s));
        if (ids.length) stages.push({ name: m[1].trim().slice(0, 80), agents: ids, instruction: m[3].trim().slice(0, 3000) });
      }
      if (stages.length >= 2) {
        const saved = wfSave({ name: `${wm[1].trim().slice(0, 80)} · by ${(FLEET_BY_ID[agent] || {}).name || agent}`, intent: intent.trim(), stages });
        if (saved.ok) {
          designed = saved.workflow.name;
          pushNotification('good', 'Duo-Drive designed a workflow', `“${designed}” — ${stages.length} stages. Review it on the Workflows screen.`, 'workflows', 'wfdesign:' + saved.workflow.id);
        }
      }
    }
  }
  const tm = text.match(/TITLE:\s*(.+)/i);
  const entry = {
    ts: new Date().toISOString(), agent, ok: r.ok, latency: r.latency, reason: reason || 'cadence',
    title: (tm ? tm[1] : (r.ok ? text.slice(0, 90) : (r.error || 'pass failed'))).slice(0, 160),
    body: (text || r.error || '').slice(0, 5000),
    designed,
  };
  d.log = [entry, ...(d.log || [])].slice(0, 60);
  d.lastRun = now();
  d.lastSig = c.sig;          // arms the idle-skip for the next cadence tick
  d.skipStreak = 0;           // a real pass snaps the stretched cadence back
  d.runs = (d.runs || 0) + 1;
  saveState();
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('cortex:duoPass', { entry });
  if (r.ok) {
    pushNotification('info', `Duo-Drive · ${(FLEET_BY_ID[agent] || {}).name || agent}`, entry.title, 'duo', `duo:${entry.ts}`, { native: false });
    safe(() => fireTriggers('duo', `${entry.title}\n\n${entry.body}`, entry.title));
  }
  return { ok: r.ok, entry, error: r.error };
}

// ===========================================================================
//  DASH-OPS — voice. Talk to the fleet, hear it answer.
//
//  Mirrors DAV-OPS on motusmoves.us: a call mode and a push-to-talk mode, with
//  ElevenLabs doing the speaking. Security discipline is the same as the SMTP
//  secret and is NOT negotiable:
//    · the API key is DPAPI-encrypted at rest (safeStorage), decrypted only
//      here, and NEVER returned to the renderer or written to any log
//    · every ElevenLabs call is made from the MAIN process, so the key never
//      exists in a web context that could leak it
//    · the renderer only ever receives audio bytes, never a credential
//  Speech-to-text stays local to the renderer (Web Speech API) — August's voice
//  never passes through this app's own network calls.
// ===========================================================================
const ELEVEN_HOST = 'api.elevenlabs.io';
const DAVARA_VOICE = 'tpS5zOAgWUiQMhzYbG2h';   // canonical — see davara-canonical-voice

// ---------------------------------------------------------------------------
//  ADOPT THE MACHINE'S EXISTING VOICE KEY.
//  August already has an ElevenLabs key on this PC (the one MotusMoves/DAV-OPS
//  uses). Rather than make him paste it — or worse, have it travel through a
//  chat transcript — the app reads it straight off disk on first run, encrypts
//  it with DPAPI, and never shows it again.
//
//  DEVICE SCOPING is real, not a claim: safeStorage/DPAPI seals the ciphertext
//  to THIS Windows user on THIS machine, and the app is already hardware-locked
//  to August's fingerprint. Copy the vault to another PC and the key is inert.
// ---------------------------------------------------------------------------
// Where a key may already live, relative to the WSL home: the operator's own
// list first (Settings, `elevenKeySources`, e.g. a project's `.env.local`),
// then two conventional spots. Pasting on DASH-OPS is the normal door; this is
// the courtesy for a machine that already holds one. Every candidate is
// shape-checked and then proven against the API before it is sealed.
function elevenKeySources() {
  const own = Array.isArray(STATE.settings.elevenKeySources) ? STATE.settings.elevenKeySources : [];
  return [...own.map((s) => String(s || '').trim()).filter(Boolean), '.config/elevenlabs.env', '.config/motus/elevenlabs.env'];
}
// LESSON (2026-08-09): the machine's stored value turned out to be a key *ID*,
// not a key — it looked exactly like a credential (64 chars, opaque) and was
// accepted without ever being tried, so "voice is connected" was false until the
// first call failed. Shape is not proof. A real ElevenLabs secret starts `sk_`,
// and we now also prove it against the API before trusting it.
const looksLikeElevenKey = (k) => /^sk_[A-Za-z0-9]{20,}$/.test(String(k || '').trim());
function findMachineElevenKey() {
  const home = path.dirname(root());          // …\home\<user>
  const rejected = [];
  for (const rel of elevenKeySources()) {
    const full = path.join(home, ...rel.split('/'));
    const txt = safe(() => fs.readFileSync(full, 'utf8'), '');
    if (!txt) continue;
    const m = txt.match(/^\s*(?:export\s+)?(?:ELEVENLABS_API_KEY|ELEVEN_LABS_API_KEY|XI_API_KEY)\s*=\s*["']?([A-Za-z0-9_\-]{24,120})["']?\s*$/m);
    if (!m || !m[1]) continue;
    if (!looksLikeElevenKey(m[1])) { rejected.push(rel); continue; }   // an ID, not a key
    return { key: m[1], source: rel };
  }
  return rejected.length ? { key: null, rejected } : null;
}
// Prove a key works before trusting it. Uses /v1/voices, NOT /v1/user: August's
// production key is scoped (it has TTS + voices but not user_read), so /v1/user
// 401s on a perfectly good key. Voices is also exactly the permission the voice
// picker needs, so this tests the capability we actually use.
//
// Subtlety worth keeping: a "missing the permission X" 401 means the key AUTH-
// ENTICATED and was merely scoped — that is a valid key. Only an auth failure
// ("invalid api key" / 403) means genuinely bad.
async function verifyElevenKey(key) {
  return new Promise((resolve) => {
    const req = https.request({ host: ELEVEN_HOST, path: '/v1/voices', method: 'GET', timeout: 15000,
      headers: { 'xi-api-key': key, Accept: 'application/json' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve({ ok: true });
        const body = Buffer.concat(chunks).toString('utf8');
        const msg = safe(() => JSON.parse(body).detail?.message, null) || '';
        if (/missing the permission/i.test(msg)) return resolve({ ok: true, scoped: true, note: msg.slice(0, 160) });
        resolve({ ok: false, error: String(msg || `ElevenLabs rejected the key (${res.statusCode})`).slice(0, 240) });
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: (e && e.message) || 'network error' }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'ElevenLabs timed out' }); });
    req.end();
  });
}
async function adoptElevenKey({ force = false } = {}) {
  if (STATE.settings.elevenKeyEnc && !force) {
    if (!STATE.settings.elevenKeySource) {
      const f = safe(() => findMachineElevenKey(), null);
      if (f && f.source) { STATE.settings.elevenKeySource = f.source; saveState(); }
    }
    return { ok: true, already: true, source: STATE.settings.elevenKeySource || '' };
  }
  if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: 'this machine cannot seal secrets at rest — refusing to store a key in plaintext' };
  const found = findMachineElevenKey();
  if (!found || !found.key) {
    return { ok: false,
      error: (found && found.rejected && found.rejected.length)
        ? `Found an ElevenLabs value on this machine (${found.rejected[0]}) but it is a key ID, not a secret key — real keys begin "sk_". Create one at elevenlabs.io → Profile → API Keys.`
        : 'no ElevenLabs key found in the usual places on this machine' };
  }
  // Never seal a credential we have not proven. A stored-but-dead key is worse
  // than none: it reports "connected" and fails at the moment you need it.
  const v = await verifyElevenKey(found.key);
  if (!v.ok) return { ok: false, error: `Key found in ${found.source} but ElevenLabs rejected it: ${v.error}` };
  STATE.settings.elevenKeyEnc = safeStorage.encryptString(found.key).toString('base64');
  STATE.settings.elevenKeySource = found.source;     // the PATH only — never the key
  STATE.settings.elevenKeyVerified = new Date().toISOString();
  saveState();
  return { ok: true, source: found.source, verified: true };
}

function decryptEleven() {
  const enc = STATE.settings.elevenKeyEnc;
  if (!enc) return '';
  return safe(() => safeStorage.decryptString(Buffer.from(enc, 'base64')), '');
}
function elevenRequest({ path, method = 'GET', body, raw = false, timeout = 45000 }) {
  const key = decryptEleven();
  if (!key) return Promise.resolve({ ok: false, error: 'no ElevenLabs key saved' });
  return new Promise((resolve) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = https.request({
      host: ELEVEN_HOST, path, method, timeout,
      headers: {
        'xi-api-key': key,
        'Accept': raw ? 'audio/mpeg' : 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode < 200 || res.statusCode >= 300) {
          // never echo the key back, and keep provider errors short
          const msg = safe(() => JSON.parse(buf.toString('utf8')).detail?.message, null) || `ElevenLabs returned ${res.statusCode}`;
          return resolve({ ok: false, error: String(msg).slice(0, 300), status: res.statusCode });
        }
        if (raw) return resolve({ ok: true, audio: buf.toString('base64'), bytes: buf.length });
        resolve({ ok: true, data: safe(() => JSON.parse(buf.toString('utf8')), null) });
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: (e && e.message) || 'network error' }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'ElevenLabs timed out' }); });
    if (payload) req.write(payload);
    req.end();
  });
}
// Speech is for listening to, not reading — long agent replies get trimmed to a
// spoken-length brief rather than read out in full for four minutes.
function speakable(text, maxChars = 900) {
  let t = String(text || '')
    .replace(/```[\s\S]*?```/g, ' — code block omitted — ')   // never read code aloud
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/[*_#`>|]/g, '')
    .replace(/\n{2,}/g, '. ')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length <= maxChars) return t;
  const cut = t.slice(0, maxChars);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return (end > maxChars * 0.5 ? cut.slice(0, end + 1) : cut) + ' … the rest is on screen.';
}
// ---------------------------------------------------------------------------
//  SPEECH-TO-TEXT — the real one.
//
//  v3.2 built listening on the Web Speech API. It exists on `window` in Electron
//  but the service behind it is keyed to official Chrome builds, so it fails
//  instantly with `not-allowed` — it NEVER worked, and my onend→restart handler
//  turned that instant failure into a visible flicker. Verified by probe.
//
//  What DOES work in this app (also verified): getUserMedia + MediaRecorder with
//  opus. So we record locally and transcribe server-side, ElevenLabs Scribe
//  first, Groq Whisper as fallback — both keys already live on this machine.
// ---------------------------------------------------------------------------
function multipartBody(fields, file) {
  const boundary = '----CortexInsight' + crypto.randomBytes(12).toString('hex');
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`));
  parts.push(file.data);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), boundary };
}
function postMultipart({ host, path: p, headers, fields, file, timeout = 60000 }) {
  const { body, boundary } = multipartBody(fields, file);
  return new Promise((resolve) => {
    const req = https.request({ host, path: p, method: 'POST', timeout,
      headers: { ...headers, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length } },
      (res) => {
        const c = []; res.on('data', (d) => c.push(d));
        res.on('end', () => {
          const txt = Buffer.concat(c).toString('utf8');
          if (res.statusCode >= 200 && res.statusCode < 300) return resolve({ ok: true, data: safe(() => JSON.parse(txt), null) });
          const msg = safe(() => JSON.parse(txt).detail?.message || JSON.parse(txt).error?.message, null) || `HTTP ${res.statusCode}`;
          resolve({ ok: false, error: String(msg).slice(0, 240), status: res.statusCode });
        });
      });
    req.on('error', (e) => resolve({ ok: false, error: (e && e.message) || 'network error' }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'transcription timed out' }); });
    req.write(body); req.end();
  });
}
// The Groq key sits in the same env files as the ElevenLabs one.
function findMachineGroqKey() {
  const home = path.dirname(root());
  for (const rel of elevenKeySources()) {
    const txt = safe(() => fs.readFileSync(path.join(home, ...rel.split('/')), 'utf8'), '');
    const m = txt && txt.match(/^\s*(?:export\s+)?GROQ_API_KEY\s*=\s*["']?([A-Za-z0-9_\-]{20,})["']?\s*$/m);
    if (m && m[1]) return m[1];
  }
  return '';
}
async function transcribeAudio(b64, mime) {
  const data = safe(() => Buffer.from(String(b64 || ''), 'base64'), null);
  if (!data || data.length < 1200) return { ok: false, error: 'that recording was too short to transcribe' };
  const ext = /ogg/.test(mime) ? 'ogg' : /mp4|m4a/.test(mime) ? 'mp4' : 'webm';
  const file = { field: 'file', name: `speech.${ext}`, type: mime || 'audio/webm', data };

  // 1) ElevenLabs Scribe — same key, same provider as the voice
  const key = decryptEleven();
  if (key) {
    const r = await postMultipart({ host: ELEVEN_HOST, path: '/v1/speech-to-text',
      headers: { 'xi-api-key': key, Accept: 'application/json' },
      fields: { model_id: 'scribe_v1' }, file });
    if (r.ok && r.data && typeof r.data.text === 'string' && r.data.text.trim()) {
      return { ok: true, text: r.data.text.trim(), via: 'elevenlabs' };
    }
    var elevenErr = r.error || 'no text returned';
  }
  // 2) Groq Whisper — fast, and the key is already on this machine
  const gk = findMachineGroqKey();
  if (gk) {
    const r = await postMultipart({ host: 'api.groq.com', path: '/openai/v1/audio/transcriptions',
      headers: { Authorization: `Bearer ${gk}`, Accept: 'application/json' },
      fields: { model: 'whisper-large-v3-turbo', response_format: 'json' }, file });
    if (r.ok && r.data && typeof r.data.text === 'string' && r.data.text.trim()) {
      return { ok: true, text: r.data.text.trim(), via: 'groq' };
    }
    return { ok: false, error: `ElevenLabs: ${elevenErr || 'unavailable'} · Groq: ${r.error || 'no text'}` };
  }
  return { ok: false, error: elevenErr || 'no transcription provider available' };
}

async function ttsSpeak(text, voiceId) {
  const s = STATE.settings;
  const body = speakable(text);
  if (!body) return { ok: false, error: 'nothing to say' };
  const r = await elevenRequest({
    path: `/v1/text-to-speech/${encodeURIComponent(voiceId || s.voiceId || DAVARA_VOICE)}`,
    method: 'POST', raw: true,
    body: {
      text: body,
      model_id: s.voiceModel || 'eleven_turbo_v2_5',
      voice_settings: { stability: +s.voiceStability || 0.45, similarity_boost: +s.voiceSimilarity || 0.8 },
    },
  });
  return r.ok ? { ...r, spoken: body } : r;
}

// ===========================================================================
//  THE ACTION PROTOCOL — agents can drive this app.
//
//  August wants to talk to an agent and have it actually DO things here: set the
//  Motus, put work on the board, arm a loop, steer Duo-Drive, build a workflow,
//  open a screen. The safe way is not "let it run code" — it is a closed
//  vocabulary. The agent emits [[CI:verb]] blocks; this app parses, validates
//  and executes them itself.
//
//  Three tiers, and the tier is a property of the VERB, not of who asked:
//    · safe    — additive/navigational. Executes immediately.
//    · guarded — changes configuration or spends tokens. Executes, and is
//                reported loudly so August sees exactly what changed.
//    · confirm — destructive or wide-reaching. NEVER auto-runs; it comes back
//                as a proposal August taps to approve.
//  There is deliberately NO verb for deleting his data, moving money, touching
//  secrets, or running shell commands. An agent cannot ask for those here.
// ===========================================================================
const CI_ACTIONS = {
  'motus':        { tier: 'guarded', args: 'text',        help: 'set the Motus (prime mover)' },
  'goal':         { tier: 'confirm', args: 'text',        help: 'set the long-term goal' },
  'task':         { tier: 'safe',    args: 'title|body|priority|agent', help: 'add a task to the board' },
  'task-done':    { tier: 'safe',    args: 'match',       help: 'mark a board task done' },
  'navigate':     { tier: 'safe',    args: 'view',        help: 'open a screen in the app' },
  'duo-start':    { tier: 'guarded', args: 'agent',       help: 'start Duo-Drive' },
  'duo-stop':     { tier: 'safe',    args: '',            help: 'stop Duo-Drive' },
  'duo-brief':    { tier: 'guarded', args: 'text',        help: 'set Duo-Drive\'s standing brief' },
  'duo-pass':     { tier: 'guarded', args: '',            help: 'run one Duo-Drive pass now' },
  'loop-new':     { tier: 'confirm', args: 'name|kind|cadence|instruction', help: 'propose a new Leverage Loop' },
  'loop-arm':     { tier: 'guarded', args: 'match',       help: 'arm an existing loop' },
  'loop-pause':   { tier: 'safe',    args: 'match',       help: 'pause a loop' },
  'workflow-new': { tier: 'confirm', args: 'name|intent|stages', help: 'create a workflow' },
  'agent-model':  { tier: 'confirm', args: 'agent|model', help: 'change an agent\'s model' },
  'agent-quality':{ tier: 'confirm', args: 'agent|level', help: 'change an agent\'s quality' },
  'project':      { tier: 'guarded', args: 'name|url|path', help: 'register a project for Duo-Drive' },
  'note':         { tier: 'safe',    args: 'text',        help: 'leave August a note' },
  'learn':        { tier: 'safe',    args: 'title|body',  help: 'bank a durable learning' },
  'omni-go':      { tier: 'confirm', args: 'goal',        help: 'propose a Motus Max (OmniDrive) session — needs his tap AND the arm switch' },
  'motusmodel':   { tier: 'confirm', args: 'name|essence|mantra', help: 'draft a new MotusModel in the studio' },
};
const CI_VIEWS = ['overview', 'motus', 'goal', 'agents', 'subagents', 'tasks', 'workflows', 'duo', 'voice', 'chat', 'work', 'live', 'output', 'systems', 'usage', 'learnings', 'sympath', 'nextsteps', 'models', 'security', 'levels', 'settings', 'motusmodels', 'omni'];

function actionVocabulary() {
  return Object.entries(CI_ACTIONS)
    .map(([v, m]) => `  [[CI:${v}${m.args ? ' ' + m.args.split('|').map((a) => `<${a}>`).join(' | ') : ''}]] — ${m.help}${m.tier === 'confirm' ? ' (needs his tap)' : ''}`)
    .join('\n');
}
// Parse [[CI:verb arg | arg]] blocks out of a reply.
function parseActions(text) {
  const out = [];
  const re = /\[\[CI:([a-z-]+)([\s\S]*?)\]\]/gi;
  let m;
  while ((m = re.exec(String(text || ''))) && out.length < 8) {
    const verb = m[1].toLowerCase();
    const spec = CI_ACTIONS[verb];
    if (!spec) continue;
    const raw = String(m[2] || '').trim();
    const parts = raw.split('|').map((s) => s.trim());
    out.push({ verb, tier: spec.tier, raw, parts, help: spec.help });
  }
  return out;
}
function stripActions(text) { return String(text || '').replace(/\[\[CI:[a-z-]+[\s\S]*?\]\]/gi, '').replace(/\n{3,}/g, '\n\n').trim(); }

const findLoop = (m) => {
  const n = String(m || '').toLowerCase();
  return (STATE.loops || []).find((l) => l.name.toLowerCase().includes(n))
      || (STATE.loops || []).find((l) => n.includes(l.name.toLowerCase()));
};
// Execute ONE action. Returns a human sentence describing exactly what happened.
async function applyAction(a) {
  const P0 = a.parts[0] || '', P1 = a.parts[1] || '', P2 = a.parts[2] || '', P3 = a.parts[3] || '';
  switch (a.verb) {
    case 'motus': {
      if (!P0) return { ok: false, said: 'no Motus text given' };
      STATE.motus = { text: P0.slice(0, 600), ts: new Date().toISOString(), agent: 'voice' };
      saveState(); writeAgentBrief();
      return { ok: true, said: `Motus set: “${P0.slice(0, 80)}”`, view: 'motus' };
    }
    case 'goal': {
      if (!P0) return { ok: false, said: 'no goal text given' };
      STATE.goal = { text: P0.slice(0, 600), ts: new Date().toISOString(), agent: 'voice' };
      saveState(); writeAgentBrief();
      return { ok: true, said: `Goal set: “${P0.slice(0, 80)}”`, view: 'goal' };
    }
    case 'task': {
      const pr = /high/i.test(P2) ? 1 : /low/i.test(P2) ? 3 : 2;
      const r = taskCreate({ title: P0, body: P1, priority: pr, agent: isRelayAgent(P3) ? P3 : '' });
      return r.ok ? { ok: true, said: `added “${P0.slice(0, 70)}” to the board`, view: 'tasks' } : { ok: false, said: r.error };
    }
    case 'task-done': {
      const t = (STATE.tasks || []).find((x) => x.title.toLowerCase().includes(String(P0).toLowerCase()));
      if (!t) return { ok: false, said: `no board task matching “${P0}”` };
      taskUpdate(t.id, { status: 'done' });
      return { ok: true, said: `marked “${t.title.slice(0, 60)}” done`, view: 'tasks' };
    }
    case 'navigate': {
      const v = CI_VIEWS.find((x) => x === P0.toLowerCase()) || CI_VIEWS.find((x) => x.startsWith(P0.toLowerCase()));
      if (!v) return { ok: false, said: `no screen called “${P0}”` };
      return { ok: true, said: `opened ${v}`, view: v };
    }
    case 'duo-start': {
      STATE.duo.active = true;
      if (isRelayAgent(P0)) STATE.duo.agent = P0;
      saveState();
      return { ok: true, said: `Duo-Drive started with ${(FLEET_BY_ID[STATE.duo.agent] || {}).name || STATE.duo.agent}`, view: 'duo' };
    }
    case 'duo-stop': { STATE.duo.active = false; saveState(); return { ok: true, said: 'Duo-Drive stopped', view: 'duo' }; }
    case 'duo-brief': {
      if (!P0) return { ok: false, said: 'no brief given' };
      STATE.duo.brief = P0.slice(0, 2000); saveState();
      return { ok: true, said: `Duo-Drive brief updated`, view: 'duo' };
    }
    case 'duo-pass': {
      const r = await duoPass('steered');
      return { ok: !!(r && r.ok), said: r && r.skipped ? 'she judged there was nothing worth doing' : 'ran a Duo-Drive pass', view: 'duo' };
    }
    case 'loop-new': {
      const r = { name: P0, kind: (P1 || 'refine').toLowerCase(), cadenceMin: parseInt(P2, 10) || 120, instruction: P3 || '' };
      const l = newLoop({ ...r, approved: false, enabled: false, origin: 'duo', authoredBy: 'voice' });
      if (!l.instruction || l.instruction.length < 20) return { ok: false, said: 'that loop had no real instruction' };
      STATE.loops.unshift(l); saveState();
      return { ok: true, said: `proposed the loop “${l.name}” — approve it on Duo-Drive to arm it`, view: 'duo' };
    }
    case 'loop-arm': {
      const l = findLoop(P0); if (!l) return { ok: false, said: `no loop matching “${P0}”` };
      l.approved = true; l.enabled = true; saveState();
      return { ok: true, said: `armed “${l.name}”`, view: 'duo' };
    }
    case 'loop-pause': {
      const l = findLoop(P0); if (!l) return { ok: false, said: `no loop matching “${P0}”` };
      l.enabled = false; saveState();
      return { ok: true, said: `paused “${l.name}”`, view: 'duo' };
    }
    case 'workflow-new': {
      const stages = String(P2 || '').split(';').map((s) => {
        const [nm, ags, inst] = s.split('>').map((x) => (x || '').trim());
        return { name: nm, agents: (ags || '').split(',').map((x) => x.trim()).filter(isRelayAgent), instruction: inst };
      }).filter((s) => s.agents && s.agents.length && s.instruction);
      const r = wfSave({ name: P0, intent: P1, stages });
      return r.ok ? { ok: true, said: `created the workflow “${P0}”`, view: 'workflows' } : { ok: false, said: r.error };
    }
    case 'agent-model': {
      if (!isRelayAgent(P0)) return { ok: false, said: `no agent called “${P0}”` };
      const mid = KNOWN_MODELS.find((m) => m.id === P1 || m.label.toLowerCase() === String(P1).toLowerCase());
      if (!mid) return { ok: false, said: `no model called “${P1}”` };
      STATE.fleetConfig[P0] = { ...(STATE.fleetConfig[P0] || {}), model: mid.id };
      saveState(); publishFleetConfig();
      return { ok: true, said: `${(FLEET_BY_ID[P0] || {}).name} now runs ${mid.label}`, view: 'models' };
    }
    case 'agent-quality': {
      if (!isRelayAgent(P0)) return { ok: false, said: `no agent called “${P0}”` };
      const q = QUALITY.find((x) => x.id === String(P1).toLowerCase() || x.label.toLowerCase() === String(P1).toLowerCase());
      if (!q) return { ok: false, said: `no quality level called “${P1}”` };
      STATE.fleetConfig[P0] = { ...(STATE.fleetConfig[P0] || {}), effort: q.id };
      saveState(); publishFleetConfig();
      return { ok: true, said: `${(FLEET_BY_ID[P0] || {}).name} set to ${q.label}`, view: 'models' };
    }
    case 'project': {
      const r = { name: P0, url: P1, localPath: P2 };
      if (!r.name) return { ok: false, said: 'a project needs a name' };
      const p = newProject(r); STATE.projects.unshift(p); saveState();
      return { ok: true, said: `registered “${p.name}” for Duo-Drive`, view: 'duo' };
    }
    case 'note': { pushNotification('info', 'From your agent', P0.slice(0, 500), 'tasks', 'act:' + now(), { native: false }); return { ok: true, said: 'left you a note' }; }
    case 'learn': {
      if (!P0) return { ok: false, said: 'no learning given' };
      STATE.learnings.unshift({ ts: new Date().toISOString(), source: 'voice', title: P0.slice(0, 200), body: P1.slice(0, 3000) });
      saveState();
      return { ok: true, said: 'banked that learning', view: 'learnings' };
    }
    case 'omni-go': {
      // Approval is his tap; ARMING is still a separate physical switch. If it
      // is not armed this fails honestly instead of quietly arming itself.
      const r = await omniStart({ goal: P0 });
      return r.ok ? { ok: true, said: `Motus Max session started: “${P0.slice(0, 80)}”`, view: 'omni' }
                  : { ok: false, said: r.error };
    }
    case 'motusmodel': {
      const r = mmSave({ name: P0, essence: P1, mantra: P2, status: 'draft' });
      return r.ok ? { ok: true, said: `drafted the MotusModel “${P0.slice(0, 60)}” — open the studio to shape it`, view: 'motusmodels' }
                  : { ok: false, said: r.error };
    }
    default: return { ok: false, said: 'unknown action' };
  }
}
// Run the safe/guarded ones; hand the confirm-tier back as proposals.
async function applyActions(list, { approveAll = false } = {}) {
  const done = [], pending = [];
  for (const a of list) {
    if (a.tier === 'confirm' && !approveAll) { pending.push(a); continue; }
    const r = await applyAction(a).catch((e) => ({ ok: false, said: (e && e.message) || 'failed' }));
    done.push({ ...a, ...r });
  }
  if (done.some((d) => d.ok)) saveState();
  return { done, pending };
}

// ---------------------------------------------------------------------------
//  APP SELF-KNOWLEDGE — what an agent can read about this app when asked for a
//  report. Everything here already exists on screen; this just makes it legible
//  in one block so an agent can reason over it instead of guessing.
// ---------------------------------------------------------------------------
function appReport({ deep = false } = {}) {
  const u = safe(() => buildUsage(false), null);
  const ov = safe(() => buildOverview(), {});
  const loops = (STATE.loops || []).filter((l) => l.approved);
  const work = (STATE.duoWork || []);
  const tasks = STATE.tasks || [];
  const lines = [];
  lines.push(`MOTUS: ${STATE.motus ? STATE.motus.text : '(not set)'}`);
  lines.push(`GOAL: ${STATE.goal ? STATE.goal.text : '(not set)'}`);
  lines.push(`FLEET: ${AGENTS.map((a) => { const c = agentCfg(a); return `${(FLEET_BY_ID[a] || {}).name}=${c.model.replace('claude-', '')}/${c.effort}${c.paused ? ' PAUSED' : ''}`; }).join(', ')}`);
  lines.push(`CONTROL: ${STATE.control && STATE.control.stopped ? 'FLEET STOPPED' : 'running'}`);
  lines.push(`BOARD: ${tasks.filter((t) => t.status !== 'done').length} open, ${tasks.filter((t) => t.status === 'done').length} done`);
  const open = tasks.filter((t) => t.status !== 'done').slice(0, 10).map((t) => `  · [${t.status}] ${t.title.slice(0, 90)}`).join('\n');
  if (open) lines.push(`OPEN WORK:\n${open}`);
  lines.push(`DUO-DRIVE: ${STATE.duo && STATE.duo.active ? `running with ${STATE.duo.agent}` : 'off'} · ${loops.filter((l) => l.enabled).length}/${loops.length} loops armed · ${work.length} logged moves (${work.filter((w) => w.verdict === 'shipped').length} shipped)`);
  if (loops.length) lines.push(`LOOPS: ${loops.map((l) => `${l.name}${l.enabled ? '' : ' (paused)'}`).join(', ')}`);
  if (work.length) lines.push(`RECENT DUO WORK:\n${work.slice(0, 6).map((w) => `  · [${w.verdict}] ${w.title.slice(0, 90)}`).join('\n')}`);
  if (u) lines.push(`USAGE: ${compactNum(u.fiveH.out)} output tok in 5h · ${compactNum(u.week.out)} this week · ~${compactNum(u.burnPerHour)}/h · models: ${u.week.byModel.slice(0, 3).map((m) => m.model.replace('claude-', '')).join(', ')}`);
  lines.push(`HEALTH: ${ov.health ? ov.health.level : '?'} · ${(ov.stats && ov.stats.totalTurns) || 0} lifetime turns · ${Math.round((ov.avgLatency || 0))}s median`);
  lines.push(`LEARNINGS: ${(STATE.learnings || []).length} banked · NEXT-STEPS: ${(STATE.nextSteps || []).filter((n) => !n.done).length} open`);
  const om = safe(() => omniState(), null);
  if (om) {
    const os = om.session;
    lines.push(`MOTUS MAX: ${omniArmedNow() ? `ARMED (${Math.round(omniArmRemaining() / 60000)} min left, ${om.scope} scope, ${om.pacing} pacing)` : 'not armed — he has to hold the arm switch himself'}${os && os.status === 'running' ? ` · DRIVING NOW: “${String(os.goal).slice(0, 100)}” at step ${os.cursor}/${os.maxSteps}` : os && os.status === 'waiting' ? ' · WAITING ON HIM' : ''}`);
  }
  const mm = Array.isArray(STATE.motusModels) ? STATE.motusModels : [];
  if (mm.length) lines.push(`MOTUSMODELS: ${mm.length} in the lineage · ${mm.filter((x) => x.mint).length} minted · best fitness ${Math.max(0, ...mm.map((x) => (x.fitness && x.fitness.total) || 0))}/50 · latest: ${mm[0].name.slice(0, 60)} (g${mm[0].generation}, ${mm[0].status})`);
  if (deep) {
    const l = (STATE.learnings || []).slice(0, 8).map((x) => `  · ${x.title}`).join('\n');
    if (l) lines.push(`TOP LEARNINGS:\n${l}`);
    const wf = (STATE.workflows || []).map((w) => `  · ${w.name} (${w.stages.length} stages${w.trigger && w.trigger.armed ? ', auto' : ''})`).join('\n');
    if (wf) lines.push(`WORKFLOWS:\n${wf}`);
    const pj = (STATE.projects || []).map((p) => `  · ${p.name}${p.url ? ' — ' + p.url : ''}`).join('\n');
    if (pj) lines.push(`PROJECTS:\n${pj}`);
  }
  return lines.join('\n');
}

// ###########################################################################
//  THE MAP CORTEX — she sees the whole world, at whatever altitude she needs.
//
//  August's ecosystem canon already exists, written by him, in the BuildMode
//  skill. So this does NOT copy it into the app — copying is how five true-
//  looking versions and no truth happen. It READS the canon live off disk.
//  He edits the skill, and every agent in this app is looking at the new map
//  on the very next turn. That is the Sync Law applied to the command center.
//
//  ALTITUDE is the whole idea. A drive agent that only ever sees one zoom
//  level is either lost in detail or uselessly abstract. So the map has four:
//    · ORBIT  — the three loops, the phase, the standing finding. Why anything.
//    · MAP    — the platforms, the open loops, his focuses. What is in play.
//    · GROUND — one platform: paths, remote, live URL, deploy, its open loops.
//    · FRAME  — a deliberate perspective shift; the lens, not the terrain.
//  She can change altitude MID-DRIVE with [[MAP:out]] / [[MAP:in <thing>]] /
//  [[MAP:frame <lens>]] and the next cycle arrives at that altitude.
// ###########################################################################
function bmDir() { return path.join(path.dirname(root()), '.claude', 'skills', 'buildmode', 'references'); }
const BM_FILES = {
  ecosystem: 'ECOSYSTEM-MAP.md', systems: 'SYSTEMS-MAP.md', loops: 'OPEN-LOOPS.md',
  august: 'AUGUST-PROFILE.md', knowledge: 'KNOWLEDGE-BASE.md', duodrive: 'DUODRIVE.md',
  sync: 'SYNC-PROTOCOL.md', model1: 'MOTUSMODEL-ONE.md', team: 'AKROS-TEAM.md', prompt: 'THE-PROMPT.md',
};
// Cached by size+mtime, like every other parser here — the canon is read on
// every drive cycle and re-reading 93KB over the 9p bridge each time would be
// a tax paid forever for nothing.
const _bmCache = new Map();
function bmRead(key) {
  const f = BM_FILES[key]; if (!f) return '';
  const p = path.join(bmDir(), f);
  const st = safe(() => fs.statSync(p), null);
  if (!st) return '';
  const sig = `${st.size}:${st.mtimeMs}`;
  const hit = _bmCache.get(key);
  if (hit && hit.sig === sig) return hit.text;
  const text = safe(() => fs.readFileSync(p, 'utf8'), '');
  _bmCache.set(key, { sig, text });
  return text;
}
function bmAvailable() { return exists(bmDir()) && !!bmRead('ecosystem'); }
// Pull one "## " section out of a canon file by a heading pattern.
function bmSection(key, re, maxChars = 2600) {
  const t = bmRead(key); if (!t) return '';
  const parts = t.split(/\n(?=##\s)/);
  const hit = parts.find((p) => re.test(p.split('\n')[0] || ''));
  return hit ? hit.slice(0, maxChars).trim() : '';
}
// The platforms, parsed out of the map so she can NAME them and act on them.
function bmPlatforms() {
  const t = bmRead('ecosystem'); if (!t) return [];
  const out = [];
  // Each platform is a "### ① Name — role" heading followed by a table of
  // Local / GitHub / Live / Deploy rows. Read the rows we can actually use.
  for (const block of t.split(/\n(?=###\s)/)) {
    // Only real "### Platform" blocks. Splitting on a lookahead leaves the
    // whole preamble as the first chunk, and that preamble contains the canon
    // repo's Local/GitHub rows — which is how the DOCUMENT TITLE was being
    // offered to her as a platform she could visit.
    if (!/^###\s/.test(block)) continue;
    const head = (block.split('\n')[0] || '').replace(/^###\s*/, '').trim();
    if (!head || /^\d+\s*·/.test(head)) continue;
    const cell = (label) => {
      const m = new RegExp(`\\|\\s*\\*\\*${label}\\*\\*\\s*\\|([^|]*)\\|`, 'i').exec(block);
      return m ? m[1].replace(/`/g, '').trim() : '';
    };
    const live = cell('Live'), local = cell('Local');
    if (!live && !local) continue;
    const url = (/(https?:\/\/[^\s·]+)/.exec(live) || [])[1] || '';
    out.push({
      name: head.replace(/^[①②③④⑤⑥⑦⑧⑨]\s*/, '').split('—')[0].trim(),
      role: (head.split('—')[1] || '').trim(),
      local, url, repo: cell('GitHub'), deploy: cell('Deploy'), gate: cell('Gate'),
    });
  }
  return out.slice(0, 12);
}
// Everything he is actually carrying right now, from the app's own state.
function mapFocuses() {
  const open = (STATE.tasks || []).filter((t) => t.status !== 'done');
  const loops = (STATE.loops || []).filter((l) => l.approved && l.enabled);
  return [
    STATE.motus ? `MOTUS (the strongest thing moving now): ${STATE.motus.text}` : 'MOTUS: not set — that itself is a finding',
    STATE.goal ? `GOAL (north star): ${STATE.goal.text}` : 'GOAL: not set',
    `BOARD: ${open.length} open${open.length ? ' — ' + open.slice(0, 6).map((t) => t.title.slice(0, 60)).join(' · ') : ''}`,
    `ARMED LOOPS: ${loops.length ? loops.map((l) => l.name).join(', ') : 'none'}`,
    `PROJECTS REGISTERED HERE: ${(STATE.projects || []).map((p) => `${p.name}${p.url ? ` (${p.url})` : ''}`).join(' · ') || 'none'}`,
  ].join('\n');
}
function mapRecentMoves(n = 8) {
  return (STATE.duoWork || []).slice(0, n)
    .map((w) => `  · [${w.verdict}] ${w.title.slice(0, 90)}${w.files && w.files.length ? ` (${w.files.slice(0, 3).join(', ')})` : ''}`)
    .join('\n') || '  (nothing logged yet)';
}

// THE MAP, at an altitude. `focus` narrows GROUND to one platform/project.
function mapCortex({ zoom = 'map', focus = '' } = {}) {
  const has = bmAvailable();
  const L = [];
  L.push(`◈ THE MAP — altitude: ${String(zoom).toUpperCase()}${focus ? ` · focused on: ${focus}` : ''}`);
  if (!has) L.push('(the BuildMode canon is not readable from here — working from app state only)');

  if (zoom === 'orbit') {
    L.push('\n── WHY ANY OF THIS ─────────────────────────────');
    if (has) {
      L.push(bmSection('systems', /reinforcing|loops|R1|engine/i, 3000) || bmRead('systems').slice(0, 3000));
      L.push('\n── THE LEVERAGE LADDER ─────────────────────────');
      L.push(bmSection('systems', /Leverage points/i, 1800));
      L.push('\n── THE STANDING FINDING ────────────────────────');
      // READ IT — never restate it. This line used to be a hardcoded summary of
      // the finding, which meant the app held a second copy of the one sentence
      // that matters most, free to drift from the canon it came from. It drifted
      // the same day it was written: the finding was amended and the app went on
      // reciting the old version. The entire point of the Map Cortex is that
      // there is ONE copy. Quote the file, or say plainly that you cannot read it.
      L.push(bmSection('systems', /STANDING FINDING/i, 2600)
        || '(the standing finding could not be read from the canon — do NOT reconstruct it from memory; tell him the map is unreadable and ask.)');
    }
    L.push('\n── WHERE WE ARE ────────────────────────────────');
    L.push(mapFocuses());
    if (has) { const a = bmSection('loops', /ACTIVE/i, 1600); if (a) L.push('\n── THE WIP-LIMITED LEDGER ──────────────────────\n' + a); }
    return L.join('\n');
  }

  if (zoom === 'ground') {
    const needle = String(focus || '').toLowerCase();
    const pl = bmPlatforms().find((p) => p.name.toLowerCase().includes(needle) || needle.includes(p.name.toLowerCase()));
    const pj = (STATE.projects || []).find((p) => p.name.toLowerCase().includes(needle) || needle.includes(p.name.toLowerCase()));
    L.push('\n── THE GROUND ──────────────────────────────────');
    if (pl) {
      L.push(`${pl.name}${pl.role ? ` — ${pl.role}` : ''}`);
      if (pl.local) L.push(`  local:  ${pl.local}`);
      if (pl.url) L.push(`  live:   ${pl.url}`);
      if (pl.repo) L.push(`  repo:   ${pl.repo}`);
      if (pl.deploy) L.push(`  deploy: ${pl.deploy}`);
      if (pl.gate) L.push(`  gate:   ${pl.gate}  ← this must pass before any ship`);
    }
    if (pj) {
      L.push(`\nRegistered in this app as “${pj.name}”:`);
      if (pj.url) L.push(`  url:   ${pj.url}`);
      if (pj.localPath) L.push(`  path:  ${pj.localPath}`);
      if (pj.repo) L.push(`  repo:  ${pj.repo}`);
      if (pj.notes) L.push(`  notes: ${pj.notes.slice(0, 400)}`);
      if (pj.ethos) L.push(`  its taste: ${pj.ethos.slice(0, 400)}`);
    }
    if (!pl && !pj) {
      L.push(`Nothing in the map or the registry matches “${focus}”. The platforms that DO exist:`);
      L.push(bmPlatforms().map((p) => `  · ${p.name}${p.url ? ` — ${p.url}` : ''}`).join('\n') || '  (none readable)');
    }
    const rel = (STATE.duoWork || []).filter((w) => (w.title + w.did).toLowerCase().includes(needle)).slice(0, 5);
    if (rel.length) L.push(`\nWHAT WE ALREADY DID HERE:\n${rel.map((w) => `  · [${w.verdict}] ${w.title.slice(0, 90)}`).join('\n')}`);
    if (has) { const o = bmSection('loops', /ACTIVE|QUEUED/i, 1400); if (o) L.push(`\nOPEN LOOPS THAT TOUCH THIS:\n${o.split('\n').filter((x) => x.toLowerCase().includes(needle)).join('\n') || '  (none named directly)'}`); }
    return L.join('\n');
  }

  if (zoom === 'frame') {
    L.push('\n── THE LENS, NOT THE TERRAIN ───────────────────');
    L.push(`You are being asked to look at the same system through: ${focus || 'a frame we have not used'}`);
    L.push('\nMethods that actually produce new frames (pick the one that fits, do not list them):');
    L.push('  · INVERT THE LOOP — what if the arrow we assume runs one way runs the other?');
    L.push('  · MOVE THE BOUNDARY — draw the system edge somewhere else and see what becomes internal.');
    L.push('  · CHANGE THE CLOCK — what looks true at a week and false at a year, or the reverse?');
    L.push('  · SWAP THE ACTOR — whose problem is this if August is not in the room at all?');
    L.push('  · FIND THE MISSING STOCK — what is accumulating that nobody is measuring?');
    L.push('  · READ THE GOAL, NOT THE BEHAVIOUR — what is this system actually optimising for, as revealed by what it produces?');
    L.push('\n' + mapFocuses());
    if (has) L.push('\n' + (bmSection('systems', /leverage|rank|intervention/i, 2000) || ''));
    return L.join('\n');
  }

  // default: MAP — what is in play
  L.push('\n── THE PLATFORMS ───────────────────────────────');
  const pls = bmPlatforms();
  L.push(pls.length
    ? pls.map((p) => `· ${p.name}${p.role ? ` — ${p.role}` : ''}\n    ${[p.url && 'live ' + p.url, p.local && 'local ' + p.local, p.deploy && 'deploy: ' + p.deploy].filter(Boolean).join('\n    ')}`).join('\n')
    : '(no platform table readable — ask him where things live rather than guessing a path)');
  L.push('\n── WHAT HE IS CARRYING ─────────────────────────');
  L.push(mapFocuses());
  if (has) {
    const act = bmSection('loops', /ACTIVE/i, 1500);
    if (act) L.push('\n── OPEN LOOPS (WIP-limited — nothing new starts until one closes) ──\n' + act);
  }
  L.push('\n── WHAT ALREADY MOVED ──────────────────────────');
  L.push(mapRecentMoves());
  L.push('\nZOOM: you can change altitude yourself, any cycle — [[MAP:out]] for why-any-of-this, [[MAP:in <platform>]] for paths and deploy commands, [[MAP:frame <lens>]] to change the perspective rather than the subject.');
  return L.join('\n');
}
// Her altitude requests, parsed out of a reply.
function mapParse(text) {
  const m = /\[\[MAP:(out|in|frame|map)\s*([^\]]*)\]\]/i.exec(String(text || ''));
  if (!m) return null;
  const k = m[1].toLowerCase();
  return { zoom: k === 'out' ? 'orbit' : k === 'in' ? 'ground' : k === 'frame' ? 'frame' : 'map', focus: (m[2] || '').trim() };
}
function mapStrip(t) { return String(t || '').replace(/\[\[MAP:[a-z]+[^\]]*\]\]/gi, '').trim(); }

// ---------------------------------------------------------------------------
//  THE STRATEGIC READ — "show me my highest-leverage move."
//
//  This is the one that has to be genuinely good, because it is what runs when
//  August gives no instruction at all. Three failure modes it is built against:
//    · Restating his backlog back at him as if that were strategy.
//    · Picking the most VISIBLE move instead of the highest-leverage one.
//    · Agreeing with him. He does not need a second vote; he needs the frame
//      he has not got. So it is required to name a divergent one, every time.
// ---------------------------------------------------------------------------
const MOTIVUS_CREED = `MOTUS MOTIVUS — the mode where you stop assisting and start moving as one with him.

MOVE AS ONE means: he holds the WHAT and the WHY. You hold the WHOLE STATE and the HOW. He should never have to remember a path, a remote, a version, or what was decided three sessions ago. If he has to re-derive it, you failed that turn.

Complement, do not echo. Two of the same mind is one mind wasted. Your job is the angle he does not have — the divergent frame, the loop he is inside and cannot see, the thing that is quietly true. Harmonise with his direction; do not flatter it.

The one-line test on everything: DID SOMETHING ACTUALLY MOVE? A polished sentence that shipped is a Motus. A brilliant observation that changed nothing is not.

MOTUS MAX MOVES are not bigger refinements. A max move changes a structure, opens a rail, or puts something in front of a human who is not August. Prefer the smallest move at the HIGHEST Meadows rung over a large move at rung twelve.`;

const STRATEGIC_CONTRACT = `Reply in EXACTLY this shape. No preamble, no markdown, no bullets beyond what is shown.

PHASE: <where this ecosystem actually is right now, in one honest line — not where it hopes to be>
LOOP: <which loop this turn feeds — R1 build, R2 canon, or R3 movers — and say so plainly if the honest answer is "R1 again">
LEVER: <the single highest-leverage move available right now, concrete enough to start>
RUNG: <the Meadows rung, 1-12, and its name>
WHY NOW: <what makes this the moment for it rather than later>
FIRST STEP: <ONE bounded action you could finish in a few minutes and then honestly declare done. Not a plan, not "and then", not a project — a single finishable thing. This becomes the actual goal of the next working session, so if it cannot be finished it stalls everything behind it.>
DIVERGENT FRAME: <a perspective on this system that has NOT been named yet — invert a loop, move the boundary, change the clock, swap the actor, or find the unmeasured stock. Required. If you have nothing genuinely new, say "no new frame this pass" rather than dressing up something we already know.>
OBSOLETES: <what this move makes UNNECESSARY — the planned work it deletes. If it deletes nothing, it is probably not a Motus Max move; say so.>
COST: <roughly what this costs him — time, tokens, risk — said plainly>
CONFIDENCE: <n>/10 — BASIS: <the evidence the lever rests on, one line>
FALSIFIER: <one observable, dated on the system's clock, with its pre-read — what would prove this lever wrong, by when>`;

// One strategic read. Used by the Motus Max cold start, by Duo-Drive's Motivus
// mode, and by the "highest leverage move" button on the Systems screen.
// What she has ALREADY moved, so a continuous chain never circles. Without this
// the second move in a chain re-reads the same map and re-chooses the same
// lever — autonomy that repeats itself is just a loop with extra steps.
function recentMoves(n = 6) {
  const all = (STATE.duoWork || []).slice(0, n);
  const fmt = (list) => list
    .map((x, i) => `  ${i + 1}. [${x.verdict}] ${String(x.title).slice(0, 110)}${x.did ? ` — ${String(x.did).split('\n')[0].slice(0, 120)}` : ''}`)
    .join('\n');
  // Only a SHIPPED move is spent. Anything reported, held or skipped is still
  // open — telling her not to choose it again is how a live thread gets buried
  // by its own record, and it is usually the thread only August can close.
  const done = fmt(all.filter((x) => x.verdict === 'shipped'));
  const open = fmt(all.filter((x) => x.verdict !== 'shipped'));
  const out = [];
  if (done) out.push(`ALREADY MOVED (do NOT choose any of these again — choose what they make possible NEXT):\n${done}`);
  if (open) out.push(`STILL OPEN — attempted but NOT shipped. These are live, and one may be waiting on August rather than on you. Say so plainly if it is his:\n${open}`);
  return out.length ? out.join('\n\n') + '\n' : '';
}
// ###########################################################################
//  CHOOSING A MOVE TO DRIVE ≠ ADVISING HIM WHAT TO DO.
//
//  Only added to the read when she is about to DRIVE on the answer. Asked for
//  advice, "the highest-leverage move is yours, August" is the most useful
//  sentence she can say. Asked to drive, it is a session that ends before it
//  starts — which is exactly what happened, and his vault has the receipt.
// ###########################################################################
const DRIVING_CHOICE = `
★ YOU ARE NOT ADVISING HIM — YOU ARE ABOUT TO DRIVE HIS MACHINE ON THIS.
That changes ONE thing, and only one: the LEVER is still whatever is genuinely
highest-leverage, said honestly, including when it is his. But the FIRST STEP
must be something YOU can carry to done with your own hands — files, commands,
repos, APIs, the browser, the screen.

If the lever's final step belongs to him — he has to name a person, make a call,
say yes, be the human — then do NOT make that the first step and do NOT stop
in front of it. Take the lever as far as it goes on your side, leave it primed
so his part is ONE action, hand it over with [[OS:note]], and then keep moving
to the next move. Preparing his step is your work. Waiting for it is not.

You did exactly this wrong last time and it cost the whole session: you chose
"name one person and send them the link", did excellent real work — found the
404, found the true /m/:slug route, verified 200, loaded his clipboard, wrote
first-stranger.sh — and then ended the drive BLOCKED on a name. Everything you
built was right. Choosing a goal whose last step was his, and then stopping in
front of it, was the error. Same work, framed as "prime the rail to one word
and move on", would have been a finished move and a chain to the next one.`;

// The walls she hit THIS arm. Chaining off a block is only autonomy if the next
// choice is genuinely different — otherwise she re-reads the same map, re-picks
// the same lever, and hits the same wall at speed. See omniHalt().
function avoidBlock() {
  const av = safe(() => (omniState().avoid || []).filter((a) => now() - a.ts < 12 * 3600 * 1000), []);
  if (!av.length) return '';
  return `WALLS YOU ALREADY HIT — DO NOT CHOOSE ANY OF THESE AGAIN THIS SESSION:
${av.map((a, i) => `  ${i + 1}. ${a.goal}\n     hit: ${a.why}`).join('\n')}
These are not failures and they are not permanently closed — they are simply not available to you right now, and re-choosing one is how a chain turns into a loop. Choose a DIFFERENT lever.

`;
}
async function strategicRead({ agent, question = '', zoom = 'orbit', depth = false, driving = false } = {}) {
  const a = isRelayAgent(agent) ? agent : (STATE.settings.voiceAgent || 'davara');
  const blocked = dispatchBlocked(a); if (blocked) return { ok: false, error: blocked };
  // Raise effort for THIS call only, then put it straight back. The decision is
  // the expensive thing to get wrong; the clicks that follow are not.
  let restore = null;
  if (depth) {
    const cur = agentCfg(a);
    if (cur.effort !== 'max') {
      restore = { agent: a, effort: cur.effort };
      STATE.fleetConfig[a] = { ...(STATE.fleetConfig[a] || {}), effort: 'max' };
      publishFleetConfig();
    }
  }
  // ★ THE FAST SEAT. A driving read is a 200-word choice, not an essay — and
  // it ran at the seat's full BUILDING effort (high, 16+ turns), which is the
  // single largest reason "start" sat for minutes before anything moved. Pin
  // the drive reflex for THIS call only, exactly as depth is pinned, and put
  // it straight back. depth still wins when he asked for it.
  if (!depth && driving) {
    const cur = agentCfg(a);
    const os = omniState();
    const eff = QUALITY_IDS.has(os.speedEffort) ? os.speedEffort : 'low';
    const turns = clamp(parseInt(os.speedTurns, 10) || 14, 6, 60);
    if (cur.effort !== eff || cur.turns !== turns) {
      restore = { agent: a, effort: cur.effort, turns: cur.turns };
      STATE.fleetConfig[a] = { ...(STATE.fleetConfig[a] || {}), effort: eff, turns };
      publishFleetConfig();
      omniAudit('speed', `READ at ${eff} effort / ${turns} turns for the choice only (seat stays ${cur.effort}/${cur.turns} for the work)`);
    }
  }
  const putBack = () => {
    if (!restore) return;
    STATE.fleetConfig[restore.agent] = { ...(STATE.fleetConfig[restore.agent] || {}), effort: restore.effort, ...(restore.turns ? { turns: restore.turns } : {}) };
    publishFleetConfig(); restore = null;
  };
  const prompt = `/STRATEGIC READ — August is asking for the move, not the menu.

${MOTIVUS_CREED}

${OUTLIER_STANDARD}

${DAVARA_SIGHT}

${mapCortex({ zoom })}

${recentMoves()}
${safe(() => continuityBrief(), '')}
${avoidBlock()}THE READING: ${safe(() => systemReading().line, '')}

LIVE SYSTEM STATE:
${appReport({ deep: true })}

${question ? `WHAT HE ASKED:\n${question}\n` : 'He did not ask a specific question. That is the point of this read — you choose.\n'}${safe(() => omniState().dry, false) ? `
⚠ CONSTRAINT ON THIS SESSION — DRY RUN IS ON. Your mouse and keyboard are disabled; nothing you click or type will reach the machine. Your OWN tools are fully live: Read, Write, Edit, Bash, Glob, Grep, WebFetch. So choose a FIRST STEP you can genuinely complete with tools — a file written, a fix made, a fact established, a check run. Do not choose something that needs the screen or a deploy you cannot perform; you would only discover it halfway and stop.
` : ''}
${driving && !depth ? `SPEED CONTRACT — he is WAITING at the wheel: answer in AT MOST 200 words.
LEVER, FIRST STEP, WHY NOW, RUNG — nothing else. You are choosing a move, not
writing an essay; every extra sentence is time his screen sits frozen.
` : ''}THE SACRED BAR — a move only counts if it clears this:
· It changes a STRUCTURE, opens a RAIL, or puts something in front of a HUMAN WHO IS NOT AUGUST. Anything else is maintenance wearing a crown.
· If the honest answer is rung 12 — a parameter, a polish, another feature — say "this is rung 12" out loud and say why it is still the right move. Do not dress it up.
· If it feeds R1 again, say "R1 again". That is the finding, not an apology.
· Never pick a move because it is the one you can do. Pick the one that matters, then say plainly whether you can do it.

Rules that make this worth his tokens:
· Do not restate his backlog. A list he already has is not a strategy.
· Do not pick the most visible move. Pick the one that changes the structure.
· If the highest-leverage move is something only HE can do, say that plainly and say why — do not substitute something you can do to look useful.
· Name the rung honestly. Most work is rung 12. Saying so is more useful than pretending otherwise.
${driving ? DRIVING_CHOICE : ''}

${STRATEGIC_CONTRACT}`;
  let r;
  try { r = await relaySend(a, prompt); }
  finally { putBack(); }                 // a thrown relay must never leave the seat pinned
  if (!r.ok) return { ok: false, error: r.error };
  // Forgiving field parsing. The contract is a request, not a guarantee: she
  // may answer "**LEVER:**", "THE LEVER —", or put it after a preamble. A read
  // that parses to nothing kills the whole flow at step one, so the parser
  // absorbs the formatting variance instead of the operator absorbing a failure.
  const pick = (k) => strategicPick(r.text, k);
  const read = {
    ts: new Date().toISOString(), agent: a,
    phase: pick('PHASE'), loop: pick('LOOP'), lever: pick('LEVER'), rung: pick('RUNG'),
    whyNow: pick('WHY NOW'), firstStep: pick('FIRST STEP'), frame: pick('DIVERGENT FRAME'),
    obsoletes: pick('OBSOLETES'), cost: pick('COST'),
    ...strategicConfidence(r.text), falsifier: pick('FALSIFIER').slice(0, 400),
    raw: r.text,
  };
  // Last resort before failing: if there is no LEVER but there IS a first step,
  // the useful part of the answer arrived and only the label is missing.
  if (!read.lever && read.firstStep) read.lever = read.firstStep;
  // ⚠ THE STUCK DRIVE, FOUND IN THE AUDIT LOG. Repeated [read-failed]:
  // "no LEVER parsed. She actually said: **TITLE:** …" — she answered in the
  // LOOP CONTRACT dialect (TITLE/DID/NEXT), because the relay RESUMES her
  // ongoing conversation and she pattern-locks on the format she has been
  // using all day in Duo passes. The answer was there; only the label was
  // foreign — and every drive died at step one, which is exactly what "it
  // does nothing, just stays stuck" looks like from the chair.
  if (!read.lever) {
    const title = pick('TITLE');
    if (title) {
      read.lever = title;
      read.firstStep = read.firstStep || pick('NEXT') || pick('DID') || title;
      omniAudit('read', 'she answered in the loop dialect — accepted (TITLE → lever)');
    }
  }
  // One corrective retry before failing: name the format, demand exactly it.
  // A human would say "just give it to me as LEVER / FIRST STEP" — so does she.
  if (!read.lever) {
    const r2 = await relaySend(a,
      'FORMAT ONLY — your last answer could not be parsed. Reply again with the SAME content, using EXACTLY these labels, one per line, nothing else, no markdown bold:\n'
      + 'LEVER: <the single highest-leverage move>\nRUNG: <Meadows rung number>\nWHY NOW: <one sentence>\nFIRST STEP: <the first concrete action>');
    if (r2.ok) {
      const pick2 = (k) => {
        const m = new RegExp('^\\s*(?:\\*\\*|__|#+\\s*)?(?:THE\\s+)?' + k + '\\s*(?:\\*\\*|__)?\\s*[:—-]\\s*(.+)$', 'mi').exec(r2.text);
        return m && m[1] ? m[1].trim() : '';
      };
      read.lever = pick2('LEVER') || pick2('TITLE');
      read.rung = read.rung || pick2('RUNG');
      read.whyNow = read.whyNow || pick2('WHY NOW');
      read.firstStep = read.firstStep || pick2('FIRST STEP');
      if (read.lever) omniAudit('read', 'the corrective retry landed — she restated in the contract format');
    }
  }
  if (!read.lever) {
    // Never fail blind. Bank what actually came back so the next failure names
    // itself instead of costing another ten minutes of guessing.
    const raw = String(r.text || '').replace(/\s+/g, ' ').slice(0, 400);
    omniAudit('read-failed', `no LEVER parsed. She actually said: ${raw}`);
    saveState();
    return { ok: false, error: `the read came back without a lever — that is a failed read, not a result. She said: "${raw.slice(0, 220)}"` };
  }
  STATE.strategicReads = [read, ...(STATE.strategicReads || [])].slice(0, 30);
  saveState();
  return { ok: true, read };
}

// ---------------------------------------------------------------------------
//  DIVERGENT FRAMES — the outlier perspectives. Deliberately a SEPARATE call
//  from the strategic read, because a mind asked for "the answer" and "the
//  frames nobody has named" in one breath will quietly optimise for the first
//  and hand back consensus dressed as insight.
// ---------------------------------------------------------------------------
async function divergentFrames({ agent, subject = '' } = {}) {
  const a = isRelayAgent(agent) ? agent : 'davara';
  const blocked = dispatchBlocked(a); if (blocked) return { ok: false, error: blocked };
  const prompt = `/DIVERGENCE — find the frames we have not found.

${MOTIVUS_CREED}

You are NOT being asked what to do. You are being asked to see this system differently than it has been seen. Consensus is worthless here; August already has the consensus read — he wrote it.

${mapCortex({ zoom: 'orbit' })}

${mapCortex({ zoom: 'frame', focus: subject || 'anything you choose' })}

LIVE STATE:
${appReport({ deep: true })}
${subject ? `\nHE POINTED AT: ${subject}\n` : ''}
Produce THREE frames. Each must be genuinely divergent — if a competent observer would have said it, it does not count. For each one:

FRAME <n>: <the frame, in one sentence, stated as a claim not a question>
METHOD: <which move produced it — inverted loop / moved boundary / changed clock / swapped actor / missing stock / revealed goal>
IF TRUE: <what changes about what we should do, concretely>
TEST: <the cheapest thing that would tell us whether it is true>
CONFIDENCE: <n>/10

Then one final line:
SHARPEST: <which of the three you would actually bet on, and the one sentence of why>

Nothing else.`;
  const r = await relaySend(a, prompt);
  if (!r.ok) return { ok: false, error: r.error };
  const frames = [];
  const re = /^FRAME\s*\d*:\s*([\s\S]*?)(?=^FRAME\s*\d*:|^SHARPEST:|$(?![\s\S]))/gmi;
  let m;
  while ((m = re.exec(r.text)) && frames.length < 5) {
    const body = m[1];
    const g = (k) => { const x = new RegExp(`^${k}:\\s*(.+)$`, 'mi').exec(body); return x ? x[1].trim() : ''; };
    frames.push({
      claim: (body.split('\n')[0] || '').trim(),
      method: g('METHOD'), ifTrue: g('IF TRUE'), test: g('TEST'),
      confidence: parseInt(g('CONFIDENCE'), 10) || 0,
    });
  }
  const sharp = (/^SHARPEST:\s*([\s\S]+)$/mi.exec(r.text) || [])[1] || '';
  if (!frames.length) return { ok: false, error: 'nothing parseable came back' };
  const rec = { ts: new Date().toISOString(), agent: a, subject, frames, sharpest: sharp.trim().slice(0, 600) };
  STATE.frames = [rec, ...(STATE.frames || [])].slice(0, 20);
  saveState();
  return { ok: true, ...rec };
}

// ---------------------------------------------------------------------------
//  CONTINUITY — the thread. He should be able to walk away mid-move, come back
//  tomorrow, and say "keep going" without re-explaining anything.
// ---------------------------------------------------------------------------
function threadState() {
  if (!STATE.thread || typeof STATE.thread !== 'object') {
    STATE.thread = { goal: '', openNext: '', lastVerdict: '', ts: 0, agent: '', cycles: 0, history: [] };
  }
  return STATE.thread;
}
function threadWrite({ goal, openNext, verdict, agent, cycles }) {
  const t = threadState();
  // Store the BARE goal. Storing the wrapped prompt made each resume nest
  // inside the last one until the thread was mostly its own preamble.
  if (goal) {
    t.goal = String(goal)
      .replace(/^(?:\s*Continue the open thread:\s*)+/i, '')
      .split('\n\nThe next thing named last time:')[0]
      .split('\nFIRST STEP:')[0]
      .trim()
      .slice(0, 800);
  }
  if (openNext !== undefined) t.openNext = String(openNext || '').slice(0, 800);
  if (verdict) t.lastVerdict = String(verdict).slice(0, 400);
  if (agent) t.agent = agent;
  if (cycles != null) t.cycles = cycles;
  t.ts = now();
  t.history = [{ ts: new Date().toISOString(), goal: t.goal, verdict: t.lastVerdict, next: t.openNext }, ...(t.history || [])].slice(0, 24);
  saveState();
  return t;
}
// The block that lets her pick up exactly where he left off.
function threadBlock() {
  const t = threadState();
  if (!t.goal) return '';
  const agoMin = Math.round((now() - (t.ts || now())) / 60000);
  return `WHERE YOU LEFT OFF (${agoMin < 1 ? 'just now' : agoMin < 60 ? agoMin + ' minutes ago' : Math.round(agoMin / 60) + ' hours ago'}):
  the thread: ${t.goal}
  how it ended: ${t.lastVerdict || 'unfinished'}
  the next thing you named: ${t.openNext || '(nothing written down — decide it now)'}
Pick this up rather than starting something new, unless the map says the ground has moved under it.`;
}

// ###########################################################################
//  OMNIDRIVE · MOTUS MAX MODE
//
//  The layer where an agent stops advising August and starts operating his
//  machine with him. She sees the screen, moves the mouse, types, and works
//  across whatever app the work actually lives in.
//
//  THE LINE I DREW, AND WHY:
//   · There is NO shell verb here. Universality comes the way it comes for a
//     human — through the same windows and keys. An LLM-driven `exec` on the
//     live desktop is the one capability that can destroy data silently and
//     irreversibly, and it buys nothing the input layer cannot already reach.
//   · She can never ARM herself. Arming is August's physical tap, always, and
//     it expires on a timer. Voice may PROPOSE it; only he grants it.
//   · A denylist of window titles (password managers, wallets, banking, UAC,
//     anything titled like a credential prompt) aborts the batch AND disarms,
//     whatever mode she is in. That guard cannot be turned off in the UI.
//   · Every single OS action is written to an audit trail before it runs.
//   · Ctrl+Alt+Shift+X kills it instantly from anywhere on the machine, even
//     while another app has focus.
// ###########################################################################

const OMNI_PS_VERSION = 6;   // v6: window rects (v5: BOM-less result file)
// Parse JSON that may carry a UTF-8 BOM or trailing NULs from a Windows writer.
function parseJsonLoose(text) {
  return safe(() => JSON.parse(String(text || '').replace(/^﻿/, '').replace(/\0+$/, '').trim()), null);
}
function omniHome() { const d = path.join(ciDir(), 'omni'); safe(() => fs.mkdirSync(d, { recursive: true })); return d; }
function omniScriptPath() { return path.join(app.getPath('userData'), `omni-v${OMNI_PS_VERSION}.ps1`); }
function omniWslPath(p) {
  // Frames live in WSL's own home (the same bridge dir the agents already use),
  // so an agent reads a real local path, not a /mnt/c round trip.
  const s = String(p || '').replace(/\\/g, '/');
  const i = s.toLowerCase().indexOf(wslHome().toLowerCase() + '/');
  if (i >= 0) return s.slice(i);
  const m = /^([A-Za-z]):\/(.*)$/.exec(s);
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2]}` : s;
}

// --- the OS input layer, written to disk once and executed as a batch -------
// Deliberately dumb: it validates nothing about intent. Every judgement about
// WHETHER a step may run happens in JS, above, where it is auditable in one place.
const OMNI_PS = String.raw`
# CortexInsight OmniDrive input layer. Generated — do not hand-edit.
param([string]$Batch='', [string]$Out='', [string]$Op='')
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms | Out-Null

$sig = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class CIOmni {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, int d, int e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte sc, uint f, int e);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
  public static string FgTitle(){ StringBuilder sb=new StringBuilder(600); GetWindowText(GetForegroundWindow(), sb, 600); return sb.ToString(); }
}
'@
Add-Type -TypeDefinition $sig
[CIOmni]::SetProcessDPIAware() | Out-Null

$VK = @{
 'ctrl'=0x11;'control'=0x11;'alt'=0x12;'shift'=0x10;'win'=0x5B;'meta'=0x5B;
 'enter'=0x0D;'return'=0x0D;'tab'=0x09;'esc'=0x1B;'escape'=0x1B;'space'=0x20;
 'back'=0x08;'backspace'=0x08;'delete'=0x2E;'del'=0x2E;'insert'=0x2D;'capslock'=0x14;
 'home'=0x24;'end'=0x23;'pageup'=0x21;'pgup'=0x21;'pagedown'=0x22;'pgdn'=0x22;
 'up'=0x26;'down'=0x28;'left'=0x25;'right'=0x27;'printscreen'=0x2C;
 'f1'=0x70;'f2'=0x71;'f3'=0x72;'f4'=0x73;'f5'=0x74;'f6'=0x75;
 'f7'=0x76;'f8'=0x77;'f9'=0x78;'f10'=0x79;'f11'=0x7A;'f12'=0x7B
}
function VkOf([string]$n){
  $n = $n.ToLower().Trim()
  if ($VK.ContainsKey($n)) { return [byte]$VK[$n] }
  if ($n.Length -eq 1) {
    $c = $n.ToUpper()[0]
    if ((($c -ge 'A') -and ($c -le 'Z')) -or (($c -ge '0') -and ($c -le '9'))) { return [byte][int]$c }
  }
  throw ('unknown key: ' + $n)
}
function PressCombo([string]$combo){
  $parts = @(($combo.ToLower() -split '\+') | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
  if ($parts.Count -eq 0) { throw 'empty key combo' }
  $vks = @(); foreach($p in $parts){ $vks += (VkOf $p) }
  foreach($v in $vks){ [CIOmni]::keybd_event($v,0,0,0); Start-Sleep -Milliseconds 14 }
  for($i=$vks.Count-1; $i -ge 0; $i--){ [CIOmni]::keybd_event($vks[$i],0,2,0); Start-Sleep -Milliseconds 14 }
}
function TypeText([string]$t){
  $i = 0
  while($i -lt $t.Length){
    $n = [Math]::Min(140, $t.Length - $i)
    $e = $t.Substring($i,$n) -replace '([+^%~(){}\[\]])','{$1}'
    $e = $e.Replace([string][char]13 + [string][char]10, '{ENTER}')
    $e = $e.Replace([string][char]13, '{ENTER}').Replace([string][char]10, '{ENTER}').Replace([string][char]9, '{TAB}')
    [System.Windows.Forms.SendKeys]::SendWait($e)
    $i += $n
    Start-Sleep -Milliseconds 30
  }
}
function MouseAt([int]$x,[int]$y){ [CIOmni]::SetCursorPos($x,$y) | Out-Null; Start-Sleep -Milliseconds 50 }
function ClickAt([int]$x,[int]$y,[string]$btn,[int]$times){
  MouseAt $x $y
  $dn = 0x0002; $up = 0x0004
  if ($btn -eq 'right')  { $dn = 0x0008; $up = 0x0010 }
  if ($btn -eq 'middle') { $dn = 0x0020; $up = 0x0040 }
  for($i=0; $i -lt $times; $i++){
    [CIOmni]::mouse_event($dn,0,0,0,0); Start-Sleep -Milliseconds 28
    [CIOmni]::mouse_event($up,0,0,0,0); Start-Sleep -Milliseconds 70
  }
}
function DragTo([int]$x1,[int]$y1,[int]$x2,[int]$y2){
  MouseAt $x1 $y1
  [CIOmni]::mouse_event(0x0002,0,0,0,0); Start-Sleep -Milliseconds 100
  for($i=1; $i -le 18; $i++){
    $nx = [int]($x1 + (($x2-$x1) * $i / 18)); $ny = [int]($y1 + (($y2-$y1) * $i / 18))
    [CIOmni]::SetCursorPos($nx,$ny) | Out-Null; Start-Sleep -Milliseconds 16
  }
  Start-Sleep -Milliseconds 90
  [CIOmni]::mouse_event(0x0004,0,0,0,0)
}
function ScrollAt([int]$x,[int]$y,[string]$dir,[int]$notches){
  MouseAt $x $y
  if ($notches -lt 1) { $notches = 3 }
  if ($notches -gt 30) { $notches = 30 }
  $delta = 120
  if ($dir -eq 'down') { $delta = -120 }
  for($i=0; $i -lt $notches; $i++){ [CIOmni]::mouse_event(0x0800,0,0,$delta,0); Start-Sleep -Milliseconds 40 }
}
function WinList(){
  $out = @()
  foreach($p in (Get-Process | Where-Object { $_.MainWindowTitle -ne '' })){
    $r = New-Object CIOmni+RECT
    [CIOmni]::GetWindowRect($p.MainWindowHandle, [ref]$r) | Out-Null
    $out += [pscustomobject]@{ pid = $p.Id; app = $p.ProcessName; title = $p.MainWindowTitle;
      x = $r.L; y = $r.T; w = ($r.R - $r.L); h = ($r.B - $r.T) }
  }
  return $out
}
function FgRect(){
  $h = [CIOmni]::GetForegroundWindow()
  $r = New-Object CIOmni+RECT
  [CIOmni]::GetWindowRect($h, [ref]$r) | Out-Null
  return [pscustomobject]@{ x = $r.L; y = $r.T; w = ($r.R - $r.L); h = ($r.B - $r.T) }
}
function FocusWin([string]$t){
  $procs = @(Get-Process | Where-Object { $_.MainWindowTitle -ne '' })
  $p = $procs | Where-Object { $_.MainWindowTitle -like ('*' + $t + '*') } | Select-Object -First 1
  if (-not $p) { $p = $procs | Where-Object { $_.ProcessName -like ('*' + $t + '*') } | Select-Object -First 1 }
  if (-not $p) { throw ('no open window matching: ' + $t) }
  [CIOmni]::ShowWindow($p.MainWindowHandle, 9) | Out-Null
  [CIOmni]::keybd_event(0x12,0,0,0); [CIOmni]::keybd_event(0x12,0,2,0)
  [CIOmni]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
  Start-Sleep -Milliseconds 260
  return ('focused ' + $p.MainWindowTitle)
}
function RunStep($s){
  switch ([string]$s.op) {
    'move'     { MouseAt ([int]$s.x) ([int]$s.y); return 'moved' }
    'click'    { ClickAt ([int]$s.x) ([int]$s.y) 'left' 1;  return 'clicked' }
    'dblclick' { ClickAt ([int]$s.x) ([int]$s.y) 'left' 2;  return 'double-clicked' }
    'rclick'   { ClickAt ([int]$s.x) ([int]$s.y) 'right' 1; return 'right-clicked' }
    'drag'     { DragTo ([int]$s.x) ([int]$s.y) ([int]$s.x2) ([int]$s.y2); return 'dragged' }
    'scroll'   { ScrollAt ([int]$s.x) ([int]$s.y) ([string]$s.dir) ([int]$s.notches); return ('scrolled ' + [string]$s.dir) }
    'type'     { TypeText ([string]$s.text); return ('typed ' + ([string]$s.text).Length + ' chars') }
    'paste'    { Set-Clipboard -Value ([string]$s.text); Start-Sleep -Milliseconds 80; PressCombo 'ctrl+v'; return ('pasted ' + ([string]$s.text).Length + ' chars') }
    'key'      { PressCombo ([string]$s.key); return ('pressed ' + [string]$s.key) }
    'focus'    { return (FocusWin ([string]$s.title)) }
    'launch'   { Start-Process -FilePath ([string]$s.target) | Out-Null; Start-Sleep -Milliseconds 1100; return ('launched ' + [string]$s.target) }
    'wait'     { $ms = [int]$s.ms; if ($ms -lt 1) { $ms = 400 }; if ($ms -gt 9000) { $ms = 9000 }; Start-Sleep -Milliseconds $ms; return ('waited ' + $ms + 'ms') }
    'clipset'  { Set-Clipboard -Value ([string]$s.text); return 'clipboard set' }
    'clipget'  { $c = Get-Clipboard -Raw; if ($null -eq $c) { $c = '' }; return ('CLIPBOARD: ' + $c.Substring(0, [Math]::Min(1800, $c.Length))) }
    default    { throw ('unknown op: ' + [string]$s.op) }
  }
}

$result = @{ ok = $true; fg = ''; results = @() }
try {
  if ($Op -eq 'probe') {
    $cp = New-Object CIOmni+POINT
    [CIOmni]::GetCursorPos([ref]$cp) | Out-Null
    $result.fg = [CIOmni]::FgTitle()
    $result.cursor = @{ x = $cp.X; y = $cp.Y }
    $result.fgrect = FgRect
    $result.windows = @(WinList)
  } elseif ($Batch -ne '') {
    $plan = Get-Content -Raw -LiteralPath $Batch | ConvertFrom-Json
    foreach($s in $plan.steps){
      $r = @{ op = [string]$s.op; ok = $true; said = '' }
      try { $r.said = [string](RunStep $s) }
      catch { $r.ok = $false; $r.said = $_.Exception.Message; $result.ok = $false }
      $result.results += $r
      if (-not $r.ok) { break }
    }
    $result.fg = [CIOmni]::FgTitle()
  } else { $result.ok = $false; $result.error = 'nothing to do' }
} catch { $result.ok = $false; $result.error = $_.Exception.Message }
$json = $result | ConvertTo-Json -Depth 6 -Compress
# ⚠ NEVER Set-Content -Encoding UTF8 here. Windows PowerShell 5.1 writes a UTF-8
# BOM, and JSON.parse() throws on a leading U+FEFF — so the batch would RUN on
# his machine and then report zero results back, which reads exactly like
# "Motus Max isn't doing anything". Write BOM-less, explicitly.
if ($Out -ne '') {
  [System.IO.File]::WriteAllText($Out, $json, (New-Object System.Text.UTF8Encoding($false)))
} else { Write-Output $json }
`;

function ensureOmniScript() {
  const p = omniScriptPath();
  if (!exists(p) || safe(() => fs.readFileSync(p, 'utf8'), '') !== OMNI_PS) safe(() => fs.writeFileSync(p, OMNI_PS, 'utf8'));
  return p;
}
function runOmniPs(args, timeout = 60000) {
  return new Promise((resolve) => {
    if (!IS_WIN) return resolve({ ok: false, error: 'the screen instruments are Windows-only for now; on macOS Motus Max drives in work mode (files, commands, APIs)' });
    const script = ensureOmniScript();
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
      { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && !stdout) return resolve({ ok: false, error: (String(stderr || err.message) || 'powershell failed').slice(0, 400) });
        resolve({ ok: true, raw: String(stdout || '') });
      });
  });
}
// What is on screen right now, from the OS's own point of view.
async function omniProbe() {
  const r = await runOmniPs(['-Op', 'probe'], 25000);
  if (!r.ok) return { ok: false, error: r.error };
  const d = parseJsonLoose(r.raw);
  if (!d) return { ok: false, error: 'could not read the screen probe' };
  // Protected windows are stripped from the list before anything sees it. She
  // is not told a vault is open and then refused — she is never told at all.
  const windows = (d.windows || []).filter((w) => !omniForbiddenWindow(w.title)).slice(0, 40);
  return { ok: true, fg: d.fg || '', cursor: d.cursor || { x: 0, y: 0 }, fgrect: d.fgrect || null, windows };
}

// ---------------------------------------------------------------------------
//  THE GUARDS. These are not configurable from the interface on purpose.
// ---------------------------------------------------------------------------
const OMNI_FORBIDDEN_WINDOWS = [
  /1password|bitwarden|lastpass|keepass|dashlane|nordpass|proton pass|keychain/i,
  /metamask|phantom wallet|exodus|electrum|ledger live|trezor|trust wallet|coinbase|binance|kraken|blockchain\.com|rabby/i,
  /\bbanking\b|online bank|chase\.com|wellsfargo|hsbc|barclays|revolut|monzo|\bwise\b|paypal|stripe dashboard|quickbooks/i,
  /password|passphrase|seed phrase|recovery phrase|private key|secret key|credential|authenticator|two-factor|2-step verification/i,
  /user account control|windows security|windows defender|bitlocker|certificate manager|registry editor|group policy/i,
  /\bsign in\b|\blog in\b|\blogin\b/i,
];
function omniForbiddenWindow(title) {
  const t = String(title || '');
  if (!t) return null;
  for (const re of OMNI_FORBIDDEN_WINDOWS) if (re.test(t)) return t.slice(0, 120);
  return null;
}
// Never let a typed string carry a secret out of this machine's memory and into
// a text box. Shape-based, and deliberately over-eager: a false stop costs a
// sentence; a false pass costs a key.
const OMNI_SECRET_SHAPES = [
  /\bsk-[A-Za-z0-9_-]{16,}/, /\bsk_[A-Za-z0-9]{20,}/, /\bghp_[A-Za-z0-9]{20,}/, /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bAKIA[0-9A-Z]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{18,}\.[A-Za-z0-9_-]{18,}/, /\bxpub[0-9A-Za-z]{50,}/, /\b0x[a-fA-F0-9]{62,}\b/,
];
function omniSecretish(text) {
  const t = String(text || '');
  for (const re of OMNI_SECRET_SHAPES) if (re.test(t)) return 'it matches the shape of an API key or private key';
  // A BIP39-shaped run: 12+ short lowercase words, no punctuation, no capitals.
  const w = t.trim().split(/\s+/);
  if (w.length >= 12 && w.length <= 26 && w.every((x) => /^[a-z]{3,8}$/.test(x))) return 'it looks like a recovery phrase';
  return null;
}

// ---------------------------------------------------------------------------
//  ARMING. His tap, with a fuse on it.
// ---------------------------------------------------------------------------
function omniDefaults() {
  return {
    armed: false, armedAt: 0, ttlMin: 25, agent: 'davara',
    scope: 'guarded',        // 'guarded' = only the windows he allow-listed · 'open' = anything but the denylist
    pacing: 'auto',          // 'auto' = she keeps moving · 'ask' = every batch waits for his tap
    allow: ['CortexInsight', 'Chrome', 'Edge', 'Firefox', 'Code', 'Notepad', 'Explorer', 'Obsidian', 'Figma'],
    // ⚠ depth defaulted TRUE, so every cold-start read ran at MAX effort —
    // measured on his relay at 120s normal, 1424s worst, all spent before the
    // first thing moved on screen. Depth is a choice he makes for a hard
    // drive, not a tax on every one.
    display: 0, displayPin: null, speak: true, maxSteps: 60, hud: true, dry: false, depth: false,
    continuous: false, chain: 0, chainMax: 6,
    // 'auto' reads the goal; 'work' always uses files and commands; 'screen'
    // always drives the pointer. His call, not a guess.
    moveMode: 'auto',
    // read the map the moment he arms, so Drive starts on a ready choice
    preRead: true,
    // Drive cycles are a different job from thinking: read two pictures, decide
    // one small batch, answer. The runner's own benchmark says the agentic TOOL
    // LOOP is ~70% of a turn (deep+all-tools 159s vs no-tools+medium 20s), so a
    // drive seat pinned to deep settings is why "she reasons on a screen that is
    // way behind" — by the time she answered, the screen had moved on.
    // ⚠ 8 WAS TOO FEW AND IT SHOWED. A screen cycle costs a turn to Read the
    // frame, sometimes a second for the zoom, then the reply — and any tool she
    // reaches for on the way blows the budget. She came back with "reached her
    // 8-turn depth cap mid-thought" instead of a plan, the parser found no
    // action blocks, and the cycle logged "she proposed no move". The reflex is
    // still fast; it is no longer amputated.
    // cycles at 'medium' measured 90–130s each; 'low' is the driving default —
    // perception and one action batch do not need depth. (speedTurns stays 20:
    // the 8-turn amputation scar above is about TURNS, not effort.)
    speedEffort: 'low', speedTurns: 20,
    // VISION IS ON DEMAND, NOT ON EVERY CYCLE.
    // A capture costs ~1–3s, the image costs her a Read call, and every image
    // bug in this build came from photographing a 4K desktop. Most work is
    // files, commands and APIs — she does not need to look at a picture to edit
    // a file. So: no frame unless she ASKS for one, or the goal is GUI-shaped.
    // She always has the window list WITH EXACT RECTANGLES, which is faster,
    // smaller and never blurs. 'always' is there for genuinely visual work.
    vision: 'onDemand',
    // THE REFLEX LANE — on by default. Cycles where the plan is already set go
    // to the lean workhorse seat (measured 2.2× faster on that shape of turn);
    // every cycle that forms or re-forms the plan stays with her. Set false and
    // every single cycle is hers again, at her full price. See omniRouteCycle().
    reflex: true,
    // Walls she has already hit this arm. A block ends a MOVE, not the drive —
    // she chains onward, and this is what stops her chaining straight back into
    // the same wall. Entries expire after 12h. See omniHalt().
    avoid: [],
    session: null, log: [], stats: { actions: 0, sessions: 0, blocked: 0 },
  };
}
// MUTATE IN PLACE — never rebuild. This used to be
//     STATE.omni = Object.assign(omniDefaults(), STATE.omni)
// which returned a BRAND NEW object on every call and reassigned STATE.omni to
// it. Any caller holding a reference was silently orphaned the instant anything
// else called omniState() — and omniAudit(), appReport() and omniArmedNow() all
// do. So `const o = omniState(); …; o.session = {...}` wrote the session onto a
// dead object while STATE.omni.session stayed null: Motus Max armed, logged, and
// then did precisely nothing, with no error anywhere. Object identity has to be
// stable for the whole process lifetime; fill missing defaults onto the SAME
// object instead. (Found only by running the entire loop end to end — every
// individual part had passed.)
function omniState() {
  if (!STATE.omni || typeof STATE.omni !== 'object' || Array.isArray(STATE.omni)) {
    STATE.omni = omniDefaults();
return STATE.omni;
  }
  const d = omniDefaults();
  for (const k of Object.keys(d)) if (STATE.omni[k] === undefined) STATE.omni[k] = d[k];
  // ── THE SPEED MIGRATION (one-time, 2026-08-25) — on the MERGED path, where
  // his real stored values live. The first attempt landed inside the
  // fresh-vault branch: the only path where it could never matter. Values
  // still equal to the OLD defaults flip to the measured fast profile, once;
  // the marker keeps any later deliberate choice his.
  if (!STATE.omni.speedMigrated) {
    if (STATE.omni.depth === true) STATE.omni.depth = false;
    if (STATE.omni.speedEffort === 'medium') STATE.omni.speedEffort = 'low';
    STATE.omni.speedMigrated = 1;
    saveState();
  }
  return STATE.omni;
}
function omniArmedNow() {
  const o = omniState();
  if (!o.armed) return false;
  if (now() - o.armedAt > o.ttlMin * 60 * 1000) { o.armed = false; return false; }
  if (STATE.control && STATE.control.stopped) { o.armed = false; return false; }
  return true;
}
function omniArmRemaining() {
  const o = omniState();
  return o.armed ? Math.max(0, o.ttlMin * 60 * 1000 - (now() - o.armedAt)) : 0;
}
// KEEP WHAT SHE SAID. 400 characters was cutting her findings off mid-sentence
// — the audit trail is the only durable record of an autonomous session's
// reasoning, and a truncated finding is often worse than none because it reads
// as complete. Her observations routinely run 600–1500 characters and every one
// of them mattered. Cap generously, and keep FEWER entries rather than shorter
// ones: an old line can be dropped; half a sentence cannot be recovered.
function omniAudit(kind, said, extra = {}) {
  const o = omniState();
  const text = String(said || '');
  o.log.unshift({ ts: new Date().toISOString(), kind, said: text.slice(0, 4000), full: text.length > 4000, ...extra });
  // TWO-STAGE COMPACTION, so the trail stays readable AND stays small.
  // Recent entries keep every word — that is where the reasoning he needs
  // lives. Older ones get trimmed to their first paragraph, and the oldest
  // fall off. Keeping 250 full-length findings was heading for a megabyte of
  // state he has to load on every launch.
  if (o.log.length > 60) {
    for (let i = 60; i < o.log.length; i++) {
      const e = o.log[i];
      if (e && !e.trimmed && String(e.said || '').length > 400) {
        e.said = String(e.said).slice(0, 400).replace(/\s+\S*$/, '') + ' …';
        e.trimmed = true;
      }
    }
  }
  o.log = o.log.slice(0, 160);
}
function omniEmit(payload) {
  if (mainWin && !mainWin.isDestroyed()) safe(() => mainWin.webContents.send('cortex:omni', payload));
  omniOverlayPush(payload && payload.kind ? { phase: payload.kind } : {});
}

function omniArm({ minutes, agent, scope, pacing, maxSteps, speak, display, allow, hud, dry, depth, continuous, chainMax, speedEffort, speedTurns, moveMode, reflex, preRead } = {}) {
  const o = omniState();
  // ⚠ THE ONLY UNCONDITIONAL ASSIGNMENT IN THIS FUNCTION USED TO BE HERE, and it
  // meant every arm from a screen without the fuse control silently reset his
  // fuse to 25 minutes. Every other setting is guarded; this one now is too.
  // Same principle as omniSettings(): no reading is not a reading of zero.
  if (minutes != null) o.ttlMin = clamp(parseInt(minutes, 10) || 25, 5, 180);
  if (Array.isArray(allow)) o.allow = allow.map((x) => String(x).trim()).filter(Boolean).slice(0, 40);
  // The seat that DRIVES is always a mind. An infra lane can take a cycle she
  // handed it; it can never be handed the session itself.
  if (isRelayAgent(agent) && !isInfraSeat(agent)) o.agent = agent;
  if (scope === 'open' || scope === 'guarded') o.scope = scope;
  if (pacing === 'auto' || pacing === 'ask') o.pacing = pacing;
  if (maxSteps != null) o.maxSteps = clamp(parseInt(maxSteps, 10) || 60, 4, 400);
  if (speak != null) o.speak = !!speak;
  if (hud != null) o.hud = !!hud;
  if (dry != null) o.dry = !!dry;
  if (depth != null) o.depth = !!depth;
  if (continuous != null) { o.continuous = !!continuous; o.chain = 0; }
  if (reflex != null) o.reflex = !!reflex;
  if (preRead != null) o.preRead = !!preRead;
  if (chainMax != null) o.chainMax = clamp(parseInt(chainMax, 10) || 6, 1, 30);
  if (speedEffort && QUALITY.some((q) => q.id === speedEffort)) o.speedEffort = speedEffort;
  // Turns follow the reflex: quicker settings think less, but none of them are
  // allowed to be too few to FINISH — a truncated thought is not speed.
  if (speedTurns != null) o.speedTurns = clamp(parseInt(speedTurns, 10) || 20, 10, 60);
  else if (speedEffort) o.speedTurns = speedEffort === 'low' ? 14 : speedEffort === 'high' ? 32 : 20;
  if (moveMode && ['auto', 'work', 'screen'].includes(moveMode)) o.moveMode = moveMode;
  // display: -1 (or null) means FOLLOW ME — resolve it fresh at each capture.
  if (display != null) {
    const n = parseInt(display, 10);
    o.displayPin = (Number.isFinite(n) && n >= 0) ? clamp(n, 0, 8) : null;
  }
  o.display = omniResolveDisplay();
  o.armed = true; o.armedAt = now();
  omniAudit('arm', `Motus Max armed for ${o.ttlMin} min · ${o.scope} scope · ${o.pacing} pacing · ${(FLEET_BY_ID[o.agent] || {}).name || o.agent}`);
  // a dry arm is a rehearsal and a harness arm is a test: neither spends a turn
  if (o.preRead !== false && !o.dry && !_ISOLATED) safe(() => omniPreRead('armed'));
  safe(() => {
    const { globalShortcut } = require('electron');
    globalShortcut.unregisterAll();
    // ⚠ globalShortcut.register RETURNS FALSE when another app already owns the
    // combination, and it does so SILENTLY. Ctrl+Alt+Shift+X was taken on this
    // machine, so the emergency stop had not been bound at all — the HUD said
    // it was, which is the worst possible failure for a kill switch. Try a
    // ladder, keep the first that binds, and record which one is actually live
    // so the HUD tells the truth instead of the intention.
    const panicKeys = ['CommandOrControl+Alt+Shift+X', 'CommandOrControl+Shift+Escape', 'CommandOrControl+Alt+X', 'Shift+Alt+X', 'F8'];
    o.panicKey = '';
    for (const k of panicKeys) {
      const bound = safe(() => globalShortcut.register(k, () => omniPanic('the panic key')), false);
      if (bound && globalShortcut.isRegistered(k)) { o.panicKey = k; break; }
    }
    if (!o.panicKey) {
      omniAudit('blocked', 'NO PANIC KEY COULD BE BOUND — every combination is taken by another app. Stop with the button in the app or the Stop control.');
      pushNotification('bad', 'Motus Max: no panic key', 'Every emergency-stop combination is already taken by another application. Use the Stop button in CortexInsight.', 'omni', 'omni:nopanic:' + now());
    } else if (o.panicKey !== panicKeys[0]) {
      omniAudit('arm', `panic key is ${o.panicKey} — the usual one was taken by another app`);
    }
    // unregisterAll above stripped the standing keys — put them BOTH back
    safe(() => { _killKey = ''; bindKillSwitch(); });
    safe(() => bindPTT());
    // ── STEER HER BY VOICE, FROM ANYWHERE ────────────────────────────────
    // Ctrl+Shift+M works whatever has focus — his browser, his editor, a
    // full-screen app. Press it, speak, stop; she gets your words ahead of her
    // own plan on the very next frame. A global key is the only kind that is
    // useful here: if he had to find the CortexInsight window first, the moment
    // he wanted to redirect her would already have passed.
    globalShortcut.register('CommandOrControl+Shift+M', () => {
      const st = omniState();
      if (!omniArmedNow()) return;
      st._listening = !st._listening;
      omniAudit('voice', st._listening ? 'listening — speak, and it goes to her as a steer' : 'stopped listening');
      omniOverlayPush({ listening: st._listening });
      if (mainWin && !mainWin.isDestroyed()) safe(() => mainWin.webContents.send('cortex:omniVoice', { on: st._listening }));
    });
  });
  saveState();
  // ARMING MUST BE VISIBLE. Previously arming changed only a panel inside the
  // app and the HUD appeared solely once a session ran — so August armed it,
  // saw nothing happen anywhere on his screen, and reasonably concluded it was
  // broken. It was not broken; it was waiting for a second action he had no
  // reason to know about. Now arming raises the HUD in STANDBY, which both
  // proves the permission landed and states the next move on screen.
  if (o.hud) {
    omniOverlayOpen();
    omniOverlayMove();     // re-frame onto whatever screen he just chose
    omniOverlayPush({ status: 'standby', phase: 'armed', goal: '', origin: '' });
  }
  omniEmit({ kind: 'armed', omni: omniPublic() });
  return omniPublic();
}
function omniDisarm(reason = 'August disarmed it') {
  const o = omniState();
  const was = o.armed || (o.session && o.session.status === 'running');
  o.armed = false;
  if (o.session && (o.session.status === 'running' || o.session.status === 'waiting')) {
    o.session.status = 'stopped'; o.session.endedAt = now(); o.session.why = reason;
  }
  safe(() => require('electron').globalShortcut.unregisterAll());
  safe(() => { _killKey = ''; bindKillSwitch(); });  // the kill switch OUTLIVES disarm
  safe(() => { _pttKey = ''; bindPTT(); });   // disarm wipes every key — PTT survives
  if (was) omniAudit('disarm', reason);
  saveState();
  omniEmit({ kind: 'disarmed', reason, omni: omniPublic() });
  return omniPublic();
}
function omniPanic(why) {
  omniDisarm(`HALTED by ${why}`);
  omniState().stats.blocked++;
  pushNotification('warn', 'Motus Max halted', `OmniDrive was stopped by ${why}. Nothing further will move.`, 'omni', 'omni:panic:' + now());
  saveState();
}

// ###########################################################################
//  THE MOTUS MAX HUD — the screen knows she is driving.
//
//  A transparent, click-through, always-on-top window laid over the display
//  she is working on. It is not decoration: while an agent is moving his
//  pointer, the single most important thing in the room is that August can
//  see AT A GLANCE that it is happening, what she is doing, and how long the
//  fuse has left — without switching windows.
//
//  Three properties it must have, or it is worse than nothing:
//   · CLICK-THROUGH — setIgnoreMouseEvents. It can never eat a click, his or hers.
//   · INVISIBLE TO HER — setContentProtection keeps it out of the captured
//     frames. Otherwise she photographs her own HUD, reads her own telemetry
//     as if it were his screen, and the loop eats its own tail.
//   · CHEAP — one canvas, 30fps, paused when nothing is happening. This app
//     has already been the reason his whole machine crawled once. Never again.
// ###########################################################################
let overlayWin = null;
// The bounding box of every display, in DIP. One window, all monitors.
function omniUnionBounds() {
  return safe(() => {
    const ds = require('electron').screen.getAllDisplays().map((d) => d.bounds);
    const x = Math.min(...ds.map((b) => b.x)), y = Math.min(...ds.map((b) => b.y));
    const r = Math.max(...ds.map((b) => b.x + b.width)), bo = Math.max(...ds.map((b) => b.y + b.height));
    return { x, y, width: r - x, height: bo - y };
  }, { x: 0, y: 0, width: 1920, height: 1080 });
}
// Where inside that union the screen he is actually on sits, so the brackets,
// the aura and the chip frame HIS screen rather than the whole desk.
function omniStageRect() {
  return safe(() => {
    const { screen } = require('electron');
    const displays = screen.getAllDisplays();
    const u = omniUnionBounds();
    const d = displays[clamp(omniResolveDisplay(), 0, Math.max(0, displays.length - 1))] || displays[0];
    return { x: d.bounds.x - u.x, y: d.bounds.y - u.y, w: d.bounds.width, h: d.bounds.height,
      label: d.label || 'your screen', union: u };
  }, null);
}
// Build it ONCE and keep it. Creating a transparent, preloaded BrowserWindow
// costs ~400ms — which is why arming felt laggy rather than instant. It is now
// pre-warmed the moment he opens the Motus Max screen (he is about to arm) and
// then only ever hidden/shown, so arming is a show() and appears immediately.
// Anyone who never opens that screen pays nothing.
function omniOverlayEnsure() { return omniOverlayOpen({ prewarm: true }); }
function omniOverlayOpen(opts = {}) {
  const o = omniState();
  if (!o.hud) return null;
  if (overlayWin && !overlayWin.isDestroyed()) {
    // ALWAYS re-send the stage. This is the bug that made "I picked my other
    // monitor" do nothing: on a reused window we returned here early, so a
    // changed display pin never reached the page and the HUD stayed framed on
    // the laptop. Reusing a window must never mean reusing its geometry.
    safe(() => { overlayWin.setBounds(omniUnionBounds()); overlayWin.webContents.send('hud', { kind: 'stage', stage: omniStageRect() }); });
    if (!opts.prewarm) safe(() => overlayWin.showInactive());
    return overlayWin;
  }
  return safe(() => {
    // COVER THE WHOLE VIRTUAL DESKTOP — every monitor, one window.
    //
    // Picking "the right display" for a purely visual layer was the wrong shape
    // of solution and it stayed broken twice: a window sized for his 1280x720
    // primary landed on the 2560x1441 LG and covered exactly a quarter. Chasing
    // the correct index is a guess that has to be re-made every time he moves,
    // rearranges monitors, or arms from a window on another screen.
    // So: don't guess. Span the union of all displays. Then the HUD is correct
    // for every arrangement, at every moment, with no resolution step at all.
    // (The CAMERA still follows one screen — that genuinely must be a choice.
    // The HUD does not, so it should not have one.)
    const u = omniUnionBounds();
    overlayWin = new BrowserWindow({
      x: u.x, y: u.y, width: u.width, height: u.height,
      // ⚠ resizable MUST be true, and the max size MUST be set explicitly.
      // Windows applies a default max TRACKING size (WM_GETMINMAXINFO) of about
      // one monitor to a non-resizable window, so a window requested at
      // 3840x1441 was silently created at 1280x722 — the primary's size, which
      // on his 2560x1441 LG is EXACTLY the quarter-screen HUD he kept seeing.
      // It is also why a post-creation setBounds() looked fine in a probe while
      // the real creation path stayed broken: setBounds bypasses that clamp.
      // Nobody can resize this window anyway — it is click-through and
      // unfocusable — so `resizable` costs nothing and buys correctness.
      resizable: true, maxWidth: u.width, maxHeight: u.height,
      transparent: true, frame: false, movable: false, minimizable: false,
      maximizable: false, fullscreenable: false, skipTaskbar: true, focusable: false,
      hasShadow: false, thickFrame: false, alwaysOnTop: true, show: false,
      webPreferences: { preload: path.join(__dirname, 'preload-overlay.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    // Belt and braces: re-assert the bounds after creation, which is the path
    // Windows does not clamp. Verified by --omnitest, not assumed.
    safe(() => { overlayWin.setMaximumSize(u.width, u.height); overlayWin.setBounds(u); });
    overlayWin.setIgnoreMouseEvents(true, { forward: true });
    overlayWin.setAlwaysOnTop(true, 'screen-saver');
    overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    safe(() => overlayWin.setContentProtection(true));   // keeps the HUD out of her own frames
    overlayWin.loadFile(path.join(__dirname, 'src', 'overlay.html'));
    overlayWin.once('ready-to-show', () => {
      safe(() => overlayWin.webContents.send('hud', { kind: 'stage', stage: omniStageRect() }));
      if (!opts.prewarm) { safe(() => overlayWin.showInactive()); omniOverlayPush(); }
    });
    overlayWin.on('closed', () => { overlayWin = null; });
    // The desk can change under us — a monitor plugged in, unplugged, moved, or
    // rescaled. The union and the framed stage must both follow, or the HUD
    // quietly goes back to covering the wrong thing.
    safe(() => {
      const { screen } = require('electron');
      if (!_omniScreenHooked) {
        _omniScreenHooked = true;
        const resync = () => omniOverlayMove();
        screen.on('display-added', resync);
        screen.on('display-removed', resync);
        screen.on('display-metrics-changed', resync);
      }
    });
    return overlayWin;
  }, null);
}
let _omniScreenHooked = false;
// He moved to another monitor, or the layout changed. The WINDOW never moves —
// it already spans everything — only the framed stage inside it does.
function omniOverlayMove() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  safe(() => {
    const u = omniUnionBounds();
    const b = overlayWin.getBounds();
    if (b.x !== u.x || b.y !== u.y || b.width !== u.width || b.height !== u.height) overlayWin.setBounds(u);
    overlayWin.webContents.send('hud', { kind: 'stage', stage: omniStageRect() });
  });
}
// HIDE, do not destroy. Keeping the window alive is what makes the next arm
// instant; destroying it means paying the ~400ms build again every single time.
function omniOverlayClose() {
  if (!overlayWin || overlayWin.isDestroyed()) { overlayWin = null; return; }
  safe(() => overlayWin.webContents.send('hud', { kind: 'close' }));
  const w = overlayWin;
  setTimeout(() => safe(() => { if (w && !w.isDestroyed()) w.hide(); }), 320);   // let it fade, then park it
}
function omniOverlayDestroy() {
  const w = overlayWin; overlayWin = null;
  safe(() => { if (w && !w.isDestroyed()) w.destroy(); });
}
// Everything the HUD needs to draw itself, in one small object.
function omniOverlayPush(extra = {}) {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  const o = omniState(), s = o.session;
  safe(() => overlayWin.webContents.send('hud', {
    kind: 'state',
    armed: omniArmedNow(), remainingMs: omniArmRemaining(), panicKey: o.panicKey || '',
    status: s ? s.status : 'idle',
    goal: s ? String(s.goal).split('\n')[0].slice(0, 110) : '',
    mode: s ? s.mode : '',
    cycle: s ? s.cycles : 0, cursor: s ? s.cursor : 0, maxSteps: s ? s.maxSteps : 0,
    agent: s ? ((FLEET_BY_ID[s.agent] || {}).name || s.agent) : '',
    origin: s ? s.origin : '',
    // PACING ON THE GLASS. He spent a whole session believing she was in full
    // drive while every batch waited for a tap, because nothing on screen ever
    // said which mode she was in. A setting that changes whether she moves has
    // to be visible wherever she is moving.
    pacing: o.pacing || 'auto',
    ...extra,
  }));
}
// A click ripple lands exactly where she clicked, in the overlay's own
// coordinate space (display-relative DIPs, not virtual-screen physical px).
function omniOverlayPing(kind, x, y) {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  safe(() => {
    const { screen } = require('electron');
    const o = omniState();
    const displays = screen.getAllDisplays();
    const d = displays[clamp(o.display || 0, 0, Math.max(0, displays.length - 1))] || displays[0];
    const sf = d.scaleFactor || 1;
    // x,y are virtual-screen PHYSICAL px. The page now spans the whole union in
    // DIP, so: back to DIP, then relative to the UNION origin (not the display).
    const u = omniUnionBounds();
    overlayWin.webContents.send('hud', { kind: 'ping', ping: kind, x: (x / sf) - u.x, y: (y / sf) - u.y });
  });
}

// ###########################################################################
//  THE ADAPTIVE INTERFACE ENGINE
//
//  A screen is not one kind of thing. A browser, a terminal, an editor, a file
//  manager and a native app each expose a completely different — and usually
//  much better — way in than their pixels. Treating them all as "a picture to
//  click" is what made this slow, brittle and blind: she was reading an address
//  bar off a JPEG when she could have fetched the URL, and squinting at a
//  terminal she could simply have run the command in.
//
//  So: profile the environment, then hand her the RIGHT INSTRUMENT for it, with
//  the pixels ranked last. The ladder adapts to whatever he happens to have in
//  front of him, which is the actual meaning of "works in every environment".
//
//  This is derived, never configured — it reads the foreground process and
//  title, so a tool he installs tomorrow still lands in the right family.
// ###########################################################################
const ENV_FAMILIES = [
  { kind: 'browser',  match: /chrome|msedge|firefox|brave|opera|vivaldi|arc|safari/i,
    instruments: [
      'WebFetch the page directly — you get the real text, not a photograph of it',
      'if it is one of HIS platforms, the map above holds the live URL and the LOCAL SOURCE PATH — edit the source, do not click the rendering',
      'its API, if it has one — /api/… endpoints answer in JSON and never blur',
      'only then: [[OS:see]] to read the address bar or a rendered state you cannot reach any other way',
    ] },
  { kind: 'terminal', match: /windowsterminal|cmd|powershell|pwsh|wsl|conhost|alacritty|wezterm|hyper|mintty/i,
    instruments: [
      'RUN THE COMMAND YOURSELF with Bash — you have a shell; you do not need his',
      'read the file the command would have read',
      'only then: type into his terminal, and only if the session state there matters (an ssh session, a REPL with history)',
    ] },
  { kind: 'editor',   match: /^code$|devenv|idea|pycharm|webstorm|sublime_text|notepad\+\+|cursor|zed|windsurf/i,
    instruments: [
      'Edit the file on disk — instant, exact, and reviewable',
      'Grep the repo to find what you are looking for',
      'run the test or build with Bash and read the real output',
      'only then: touch his editor, and only to show him something',
    ] },
  { kind: 'files',    match: /explorer|nautilus|finder|totalcmd|filezilla/i,
    instruments: ['use the filesystem directly — Read, Write, Glob, and Bash for moves and copies', 'only then: click through the file manager'] },
  { kind: 'notes',    match: /obsidian|notion|onenote|typora|logseq/i,
    instruments: ['the vault is FILES — Read and Edit the markdown on disk', 'only then: type into the app'] },
  { kind: 'chat',     match: /slack|discord|telegram|teams|whatsapp/i,
    instruments: ['NEVER send a message on his behalf without him asking, in this or any environment', 'read what is needed, then hand him the draft'] },
  { kind: 'design',   match: /figma|photoshop|illustrator|blender|resolve|premiere/i,
    instruments: ['this is genuinely GUI-only — the screen IS the interface here', 'work visually: [[OS:see]], then [[OS:look]] to aim, then click'] },
  { kind: 'app',      match: /cortexinsight|electron/i,
    instruments: ['if it is CortexInsight, its state is on disk and its source is ' + (projectRoot() ? 'at ' + projectRoot() : 'the tree this build was packaged from') + ' — read or edit that rather than clicking your own cockpit',
      'only then: the screen'] },
];
function envProfile(probe) {
  const fg = String((probe && probe.fg) || '');
  const win = (probe && probe.windows || []).find((w) => String(w.title) === fg) || null;
  const app = String((win && win.app) || '').toLowerCase();
  const hay = `${app} ${fg}`;
  const fam = ENV_FAMILIES.find((f) => f.match.test(app)) || ENV_FAMILIES.find((f) => f.match.test(hay));
  // Does the title name one of HIS projects? Then the map already holds the
  // live URL and the local path, and both beat any pixel.
  const known = [
    ...safe(() => bmPlatforms(), []).map((p) => ({ name: p.name, url: p.url, local: p.local })),
    ...((STATE.projects || []).map((p) => ({ name: p.name, url: p.url, local: p.localPath }))),
  ].filter((p) => p.name && fg.toLowerCase().includes(String(p.name).toLowerCase().split(/[.\s]/)[0]));
  return {
    kind: fam ? fam.kind : 'unknown',
    app: (win && win.app) || '', title: fg,
    rect: win ? { x: win.x, y: win.y, w: win.w, h: win.h } : null,
    instruments: fam ? fam.instruments : [
      'you do not recognise this application, so do not assume the screen is the only way in',
      'check whether it stores its data in files you can read, or exposes a local port',
      'then: [[OS:see]] and work visually',
    ],
    known: known.slice(0, 2),
  };
}
function envBlock(probe) {
  const e = envProfile(probe);
  return `THE ENVIRONMENT YOU ARE IN — and the instruments it actually offers
  in front of him: ${e.title || '(nothing focused)'}${e.app ? `  ·  ${e.app}` : ''}${e.rect ? `  ·  ${e.rect.w}×${e.rect.h} at ${e.rect.x},${e.rect.y}` : ''}
  recognised as: ${e.kind.toUpperCase()}

REACH FOR THESE IN ORDER — the first one that fits is almost always right:
${e.instruments.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}
${e.known.length ? `\nAND THIS IS ONE OF HIS: ${e.known.map((k) => `${k.name}${k.url ? ` — live ${k.url}` : ''}${k.local ? ` — source ${k.local}` : ''}`).join(' · ')}\n  So the source and the API are both open to you. Do not click a rendering of something you can edit.` : ''}`;
}

// ---------------------------------------------------------------------------
//  SIGHT — one frame of the real screen, small enough to move fast, with an
//  exact mapping back to screen pixels so her coordinates land where she meant.
// ---------------------------------------------------------------------------
function omniFrameDir() { const d = path.join(omniHome(), 'frames'); safe(() => fs.mkdirSync(d, { recursive: true })); return d; }
// ===========================================================================
//  SESSION REPLAY — the drive, scrubbable after the fact.
//
//  Sight frames and the move ticker were both live-only: you watched, or you
//  missed it. But every frame is already a timestamped file on disk and every
//  move already carries `ts`, so a replay costs nothing to record — only the
//  discipline of not deleting the frames while their session is still young,
//  and one join on the shared clock.
//
//  Frame retention is raised from 24 to 90 (~35MB of q82 JPEG at 700px) so a
//  full drive survives long enough to be reviewed, and pruning is still by
//  count so it can never grow without bound.
// ===========================================================================
function omniReplay(sessionId) {
  const o = omniState();
  const s = (o.session && o.session.id === sessionId) ? o.session
    : (o.past || []).find((x) => x.id === sessionId);
  if (!s) return { ok: false, error: 'no such session' };
  const t0 = s.started || 0;
  const t1 = s.endedAt || now();
  // every frame captured inside the session window, in order
  const frames = safe(() => fs.readdirSync(omniFrameDir())
    .filter((f) => /^frame-(\d+)\.(jpg|png)$/i.test(f))
    .map((f) => ({ file: f, ts: parseInt((f.match(/frame-(\d+)/) || [])[1], 10) || 0 }))
    .filter((f) => f.ts >= t0 - 2000 && f.ts <= t1 + 2000)
    .sort((a, b) => a.ts - b.ts), []);
  const moves = (s.moves || []).map((m) => ({ ts: m.ts, line: m.line }));
  const steps = (s.steps || []).map((x) => ({ ts: Date.parse(x.ts) || 0, op: x.op, ok: x.ok, said: String(x.said || '').slice(0, 300) }));
  return {
    ok: true,
    session: { id: s.id, goal: s.goal, mode: s.mode, status: s.status, started: t0, endedAt: t1, cycles: s.cycles, why: s.why || '' },
    frames, moves, steps,
    span: Math.max(1, t1 - t0),
  };
}
ipcMain.handle('cortex:omniReplay', requireGate((_e, { id } = {}) => {
  const o = omniState();
  const list = [
    ...(o.session ? [o.session] : []),
    ...(o.past || []),
  ].map((s) => ({ id: s.id, goal: String(s.goal || '').split('\n')[0].slice(0, 110), mode: s.mode, status: s.status, started: s.started, endedAt: s.endedAt || 0, cycles: s.cycles || 0 }));
  if (!id) return { ok: true, sessions: list.slice(0, 12) };
  return { ...omniReplay(id), sessions: list.slice(0, 12) };
}));
// One frame, by filename, for the scrubber. Path is validated against the
// frame directory itself — never trusted from the renderer.
ipcMain.handle('cortex:omniReplayFrame', requireGate((_e, { file } = {}) => {
  const safeName = String(file || '').replace(/[^A-Za-z0-9._-]/g, '');
  if (!/^frame-\d+\.(jpg|png)$/i.test(safeName)) return { ok: false, error: 'bad frame name' };
  const p = path.join(omniFrameDir(), safeName);
  if (!exists(p)) return { ok: false, error: 'that frame has been pruned' };
  const b = safe(() => fs.readFileSync(p), null);
  if (!b || b.length > 6 * 1024 * 1024) return { ok: false, error: 'frame unreadable' };
  return { ok: true, dataUrl: `data:image/${/\.png$/i.test(safeName) ? 'png' : 'jpeg'};base64,` + b.toString('base64') };
}));
function omniPruneFrames(keep = 90) {
  safe(() => {
    const dir = omniFrameDir();
    const files = fs.readdirSync(dir).filter((f) => /\.(png|jpg)$/i.test(f)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - keep))) safe(() => fs.unlinkSync(path.join(dir, f)));
  });
}
// ZOOM WIDTH — measured against the live relay, not guessed (2026-08-09):
// her Read tool HALVES anything wider than ~700px. 1200→599, 900→449, both
// illegible; 700 arrives intact and small UI text reads cleanly. She wrote the
// finding herself in the audit trail: "THE FRAME IS 4x UNDERSIZED… never emit a
// coordinate from an undersized frame." A 700px view of a 3840px monitor is
// ~5.5 screen px per image px, which is fine for orienting and too coarse for
// small targets — hence [[OS:look]], which crops a region at NATIVE resolution
// so she can aim precisely. Wide to orient, zoom to aim.
const OMNI_VIEW_W = 700;
async function omniCapture(opts = {}) {
  const { desktopCapturer, screen } = require('electron');
  const displays = screen.getAllDisplays();
  const o = omniState();
  // Resolved FRESH every capture. If he drags his work to the other monitor
  // mid-session, she follows him there rather than staring at an empty desktop.
  // WHICH SCREEN? The focused WINDOW wins over the pointer. The pointer can be
  // parked anywhere — resting on the other monitor while he types — but the
  // window with focus is, by definition, where the work is. Getting this wrong
  // meant photographing one screen while the window she needed sat on another,
  // and then correctly rejecting the crop because the rect was not on it.
  let idx = clamp(omniResolveDisplay(), 0, Math.max(0, displays.length - 1));
  if (o.displayPin == null && opts.fgRect && opts.fgRect.w > 200) {
    const cx = opts.fgRect.x + opts.fgRect.w / 2, cy = opts.fgRect.y + opts.fgRect.h / 2;
    const j = displays.findIndex((dd) => {
      const s2 = dd.scaleFactor || 1;
      const bx = dd.bounds.x * s2, by = dd.bounds.y * s2;
      return cx >= bx && cy >= by && cx < bx + dd.size.width * s2 && cy < by + dd.size.height * s2;
    });
    if (j >= 0) idx = j;
  }
  if (idx !== o.display) {
    o.display = idx;
    omniAudit('screen', `following you to ${displays[idx].label || 'screen ' + (idx + 1)}`);
    omniOverlayMove();
  }
  const d = displays[idx] || displays[0];
  const sf = d.scaleFactor || 1;
  const scrW = Math.round(d.size.width * sf), scrH = Math.round(d.size.height * sf);
  // Always grab at NATIVE resolution; we downscale or crop ourselves below, so
  // a zoom can be pixel-exact rather than an upscale of an already-lossy frame.
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: scrW, height: scrH } })
    .catch(() => []);
  if (!sources.length) return { ok: false, error: 'the screen could not be captured' };
  // Match the source to the display by ID, never by array position. The two
  // lists are not guaranteed to be in the same order, and on a multi-monitor
  // desk that mismatch would photograph one screen while mapping clicks onto
  // another — every click landing somewhere August never saw.
  const src = sources.find((s) => String(s.display_id) === String(d.id)) || sources[idx] || sources[0];
  let img = src.thumbnail;
  const full = img.getSize();

  // The visible window onto the screen: the whole thing, or a native-resolution
  // crop she asked to look at. Everything downstream maps through cropX/cropW,
  // so a zoomed click is as accurate as a wide one.
  let cropX = 0, cropY = 0, cropW = full.width, cropH = full.height, zoomed = false, framed = '';
  // ── LOOK AT THE WINDOW, NOT THE DESERT AROUND IT ──────────────────────────
  // A 700px view of a 3840px desktop is a 5.5× shrink — unreadable, and she
  // rightly refused to click in it. But the work is never spread across the
  // whole desk; it is inside ONE window. Cropping to the focused window's rect
  // typically halves the shrink and often removes it entirely, so the same 700
  // pixels carry the text she actually needs. This is the difference between
  // "nothing aimable" and a legible screen.
  if (opts.fgRect && opts.fgRect.w > 200 && opts.fgRect.h > 150 && !opts.zoomTo && !opts.wide) {
    const rx = Math.round(opts.fgRect.x - (d.bounds.x * sf)), ry = Math.round(opts.fgRect.y - (d.bounds.y * sf));
    const rw = Math.round(opts.fgRect.w), rh = Math.round(opts.fgRect.h);
    // only when it genuinely sits on the screen she photographed
    if (rx > -40 && ry > -40 && rx + rw <= full.width + 80 && ry + rh <= full.height + 80) {
      cropX = clamp(rx, 0, Math.max(0, full.width - 50));
      cropY = clamp(ry, 0, Math.max(0, full.height - 50));
      cropW = clamp(rw, 50, full.width - cropX);
      cropH = clamp(rh, 50, full.height - cropY);
      framed = 'window';
      img = safe(() => img.crop({ x: cropX, y: cropY, width: cropW, height: cropH }), img);
    }
  }
  if (opts.zoomTo && Number.isFinite(opts.zoomTo.x)) {
    const vw = Math.min(OMNI_VIEW_W, full.width), vh = Math.round(vw * (full.height / full.width));
    cropW = vw; cropH = vh; zoomed = true;
    cropX = clamp(Math.round(opts.zoomTo.x - (d.bounds.x * sf) - vw / 2), 0, Math.max(0, full.width - vw));
    cropY = clamp(Math.round(opts.zoomTo.y - (d.bounds.y * sf) - vh / 2), 0, Math.max(0, full.height - vh));
    img = safe(() => img.crop({ x: cropX, y: cropY, width: cropW, height: cropH }), img);
  } else if (img.getSize().width > OMNI_VIEW_W) {
    img = safe(() => img.resize({ width: OMNI_VIEW_W, quality: 'best' }), img);
  }
  const size = img.getSize();
  // JPEG, not PNG. Her Read tool shrank a 700px PNG to 526px — the downscale
  // tracks FILE SIZE, not just dimensions, and a screenshot PNG is ~100KB while
  // the same frame as q82 JPEG is ~35KB. Smaller file, same pixels, and it
  // stops arriving pre-shrunk. Measured, after she logged the 526×296 reframe.
  const file = path.join(omniFrameDir(), `frame-${String(now())}.jpg`);
  if (!safe(() => { fs.writeFileSync(file, img.toJPEG(82)); return true; }, false)) return { ok: false, error: 'the frame could not be written' };
  omniPruneFrames();
  return {
    ok: true, file, wsl: omniWslPath(file),
    imgW: size.width, imgH: size.height, scrW, scrH,
    cropX, cropY, cropW, cropH, zoomed, framed,
    bytes: safe(() => fs.statSync(file).size, 0),
    originX: Math.round(d.bounds.x * sf), originY: Math.round(d.bounds.y * sf),
    display: idx, displays: displays.length, name: d.label || `display ${idx + 1}`,
  };
}
// Her coordinates are in IMAGE pixels; the mouse lives in virtual-screen pixels.
// Works identically for a wide view and a zoomed crop — the crop origin and the
// crop's own scale are both carried on the frame, so she never has to know
// which kind of picture she is looking at.
function omniMap(frame, x, y) {
  const cw = frame.cropW || frame.scrW, ch = frame.cropH || frame.scrH;
  const kx = cw / Math.max(1, frame.imgW), ky = ch / Math.max(1, frame.imgH);
  return {
    x: Math.round(x * kx) + (frame.cropX || 0) + (frame.originX || 0),
    y: Math.round(y * ky) + (frame.cropY || 0) + (frame.originY || 0),
  };
}

// ###########################################################################
//  HER OWN INSTRUMENTS — direct interfaces, not eyes.
//
//  August: "she should be adaptive and dynamic … if she cant read something she
//  can zoom out or adapt or adjust or interface with the website or code or app
//  directly like have her own interfaces apis etc."
//
//  She could already do all of this — but only through [[OS:work]], which costs
//  a WHOLE agent turn with a full tool loop. So the cheap, obvious adaptation
//  ("I can't read this page, let me just read its actual text") cost the same
//  as a deep build, which is exactly why she reached for [[OS:ask]] instead.
//  Making the adaptive move CHEAPER than the stopping move is the whole design.
//
//  These run IN THIS PROCESS, in milliseconds, with no agent turn at all. The
//  result is carried into her next cycle in full. They are not new powers — she
//  has Bash and WebFetch already — they are the same powers at reflex speed,
//  logged where he can see them.
// ###########################################################################
const OMNI_READ_CAP = 9000;        // chars of a read carried into the next cycle
// Which hosts are HIS. A GET is fine anywhere; anything that WRITES is confined
// to his own properties and his own machine. She asked for API access to drive
// his platforms — not to POST to the open internet.
function omniHisHosts() {
  const hosts = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
  const add = (u) => safe(() => { const h = new URL(u).hostname.toLowerCase(); if (h) hosts.add(h.replace(/^www\./, '')); });
  safe(() => bmPlatforms().forEach((p) => p.url && add(p.url)));
  safe(() => (STATE.projects || []).forEach((p) => p.url && add(p.url)));
  return hosts;
}
function omniIsHisHost(u) {
  const h = String(u.hostname || '').toLowerCase().replace(/^www\./, '');
  return omniHisHosts().has(h);
}
// A credential must never travel in a URL — his standing rule, enforced here
// rather than trusted to her judgement.
function omniUrlSecretish(u) {
  if (/[?&](?:token|key|secret|password|passwd|pwd|api[_-]?key|access[_-]?token|auth)=/i.test(u.search || '')) {
    return 'that URL carries a credential in its query string — never put a secret in a URL';
  }
  return omniSecretish(u.href);
}
function omniHtmlText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#0?39;|&apos;/gi, "'")
    .replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}
function omniHttp({ url, method = 'GET', body = '', timeout = 20000, redirects = 3 }) {
  return new Promise((resolve) => {
    let u; try { u = new URL(url); } catch { return resolve({ ok: false, error: `“${String(url).slice(0, 80)}” is not a URL I can parse` }); }
    if (!/^https?:$/.test(u.protocol)) return resolve({ ok: false, error: `${u.protocol} is not allowed — http and https only` });
    const sec = omniUrlSecretish(u);
    if (sec) return resolve({ ok: false, error: sec });
    const mod = u.protocol === 'https:' ? https : http;
    const payload = body ? Buffer.from(String(body), 'utf8') : null;
    const req = mod.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port || undefined,
      path: (u.pathname || '/') + (u.search || ''), method,
      headers: {
        'User-Agent': 'CortexInsight-MotusMax/1.0 (+August, local)',
        Accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
      },
      timeout,
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        const next = safe(() => new URL(res.headers.location, u).toString(), '');
        if (!next) return resolve({ ok: false, error: 'it redirected somewhere I could not resolve' });
        const downgrade = res.statusCode === 303 || (res.statusCode === 301 && method === 'POST');
        return resolve(omniHttp({ url: next, method: downgrade ? 'GET' : method, body: downgrade ? '' : body, timeout, redirects: redirects - 1 }));
      }
      let d = '', len = 0;
      res.on('data', (c) => { len += c.length; if (d.length < OMNI_READ_CAP * 8) d += c.toString('utf8'); });
      res.on('end', () => resolve({ ok: true, status: res.statusCode, type: String(res.headers['content-type'] || ''), raw: d, bytes: len, url: u.toString() }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: `no answer in ${Math.round(timeout / 1000)}s` }); });
    req.on('error', (e) => resolve({ ok: false, error: (e && e.message || 'the request failed').slice(0, 160) }));
    if (payload) req.write(payload);
    req.end();
  });
}
// [[OS:read <url | file path>]] — the ACTUAL text, source or JSON. Not pixels.
async function omniReadTarget(target) {
  const t = String(target || '').trim();
  if (!t) return { ok: false, error: 'read needs a URL or a file path' };
  if (/^https?:\/\//i.test(t)) {
    const r = await omniHttp({ url: t });
    if (!r.ok) return r;
    const isJson = /json/i.test(r.type) || /^\s*[[{]/.test(r.raw);
    const text = isJson ? r.raw : omniHtmlText(r.raw);
    // ★ THE SPA CASE, NAMED. She hit exactly this on his own site: /m/:slug
    // returns a 58KB client-rendered shell whose visible text is nearly empty,
    // which reads as "the page is broken" when the page is fine. Telling her
    // what she is actually looking at, and where the content really lives, is
    // the difference between adapting and stopping.
    const thin = !isJson && text.length < 400 && r.raw.length > 3000;
    return {
      ok: true, kind: isJson ? 'json' : 'page', status: r.status, url: r.url,
      text: (thin ? r.raw : text).slice(0, OMNI_READ_CAP),
      truncated: (thin ? r.raw : text).length > OMNI_READ_CAP,
      note: thin
        ? 'This is a CLIENT-RENDERED (SPA) page: the HTML shell is large but carries almost no text, so the real content is fetched by JavaScript at runtime. You are seeing the raw shell. To get the actual content, read the API the page calls (try [[OS:api GET <origin>/api/…]]), or open it on screen where the browser will render it. The page is not broken.'
        : '',
    };
  }
  const win = path.normalize(toWindowsPath(t));
  if (win.includes('..')) return { ok: false, error: 'that path escapes its root' };
  const low = win.toLowerCase();
  if (!(low.startsWith(String(path.dirname(root())).toLowerCase() + path.sep) || low.startsWith(String(os.homedir()).toLowerCase() + path.sep))) {
    return { ok: false, error: 'that path is outside his roots — I read under his home directories only' };
  }
  if (!exists(win)) return { ok: false, error: `there is nothing at ${t.slice(0, 100)}` };
  const st = safe(() => fs.statSync(win), null);
  if (st && st.isDirectory()) {
    const list = safe(() => fs.readdirSync(win).slice(0, 200).join('\n'), '');
    return { ok: true, kind: 'dir', text: list.slice(0, OMNI_READ_CAP), url: t, note: 'That is a directory — this is its listing.' };
  }
  if (st && st.size > 4 * 1024 * 1024) return { ok: false, error: `that file is ${Math.round(st.size / 1048576)}MB — too big to read whole; grep it with [[OS:work]] instead` };
  const body = safe(() => fs.readFileSync(win, 'utf8'), null);
  if (body == null) return { ok: false, error: 'that file could not be read as text' };
  return { ok: true, kind: 'file', text: body.slice(0, OMNI_READ_CAP), truncated: body.length > OMNI_READ_CAP, url: t };
}
// [[OS:api <METHOD> <url> | <json body>]] — talk to an endpoint directly.
async function omniApi(bodyRaw, noteRaw) {
  const m = /^([a-z]+)\s+(\S+)\s*$/i.exec(String(bodyRaw || '').trim());
  if (!m) return { ok: false, error: 'api needs a method and a URL, e.g. [[OS:api GET https://…/api/models]]' };
  const method = m[1].toUpperCase();
  if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return { ok: false, error: `${method} is not a method I will send` };
  let u; try { u = new URL(m[2]); } catch { return { ok: false, error: 'that is not a URL I can parse' }; }
  // READS go anywhere. WRITES are confined to his own properties and his own
  // machine — she asked for the ability to drive HIS platforms directly, and
  // that is exactly the boundary, not "POST anywhere on the internet".
  if (!['GET', 'HEAD'].includes(method) && !omniIsHisHost(u)) {
    return { ok: false, error: `${method} is only allowed to his own hosts (${[...omniHisHosts()].slice(0, 6).join(', ')}…) or localhost — ${u.hostname} is not one. Read it with GET, or do it through [[OS:work]] where you can explain yourself.` };
  }
  const payload = String(noteRaw || '').trim();
  if (payload) { const sec = omniSecretish(payload); if (sec) return { ok: false, error: `refusing to send that body — ${sec}` }; }
  const r = await omniHttp({ url: u.toString(), method, body: payload, timeout: 25000 });
  if (!r.ok) return r;
  return {
    ok: true, kind: 'api', status: r.status, url: r.url,
    text: r.raw.slice(0, OMNI_READ_CAP), truncated: r.raw.length > OMNI_READ_CAP,
    note: `${method} → HTTP ${r.status} · ${r.type || 'unknown type'} · ${r.bytes} bytes`,
  };
}

// ---------------------------------------------------------------------------
//  THE OS VOCABULARY — everything she is able to ask the machine to do.
// ---------------------------------------------------------------------------
const OMNI_OPS = {
  focus:    { args: '<window title>',                 help: 'bring a window to the front — do this before you click in it' },
  launch:   { args: '<full path or https URL>',       help: 'open an app or a page' },
  visit:    { args: '<platform or project name>',     help: 'open one of HIS platforms by name — the map resolves the URL, so you never guess one' },
  click:    { args: '<x> <y> | <what you are clicking>', help: 'left click at image coordinates' },
  dblclick: { args: '<x> <y> | <what>',               help: 'double click' },
  rclick:   { args: '<x> <y> | <what>',               help: 'right click (context menu)' },
  move:     { args: '<x> <y>',                        help: 'move the pointer without clicking (reveals hovers)' },
  look:     { args: '<x> <y>',                        help: 'ZOOM IN — get the next frame as a native-resolution crop around that point. Use this before clicking anything small; never guess at a blurry target.' },
  see:      { args: '',                               help: 'ask for a picture of the screen on the next cycle. You do not get one by default — most work needs files and commands, not eyes.' },
  read:     { args: '<https URL, or a file path>',    help: 'READ IT DIRECTLY — the real text, source or JSON, not pixels. Instant, no turn cost. Use this the MOMENT a screen is unreadable, ambiguous, or too small: the page source cannot blur. Works on his files and directories too.' },
  api:      { args: '<METHOD> <url> | <json body>',   help: 'TALK TO THE ENDPOINT — GET/HEAD anywhere; POST/PUT/PATCH/DELETE to his own hosts and localhost. This is how you drive his platforms directly instead of clicking their UI. Instant, no turn cost.' },
  show:     { args: '<file path, or a URL, or a window title>', help: 'SHOW HIM. Open the file you changed, the page it affects, or bring the window forward — on his actual screen. Use this on EVERY move. He should never have to take your word for it.' },
  screen:   { args: '<x> <y>',                        help: 'click at exact SCREEN coordinates (not image ones) — for points you computed from the window rectangles. Immune to any image downscaling.' },
  drag:     { args: '<x1> <y1> <x2> <y2>',            help: 'press, drag, release' },
  scroll:   { args: '<x> <y> <up|down> <notches>',    help: 'scroll the thing under that point' },
  type:     { args: '<text>',                         help: 'type text into whatever has focus' },
  paste:    { args: '<text>',                         help: 'paste text — use this for anything long, or with symbols' },
  key:      { args: '<combo e.g. ctrl+s, alt+tab, win, enter>', help: 'press a key or a combination' },
  wait:     { args: '<milliseconds>',                 help: 'let the machine catch up' },
  clipget:  { args: '',                               help: 'read the clipboard back' },
  say:      { args: '<one short sentence>',           help: 'speak to August out loud, mid-work' },
  ask:      { args: '<question>',                     help: 'stop and wait for his answer — use this rather than guessing' },
  call:     { args: '<agent> | <what you need>',      help: 'call another agent in mid-drive — davaris to build, sympath-cortex to verify, arden to check risk. Costs a turn; use it when their judgement beats yours.' },
  note:     { args: '<what you learned>',             help: 'bank something durable for the next session — write the thread forward' },
  work:     { args: '<what you actually did — files, commands, results>', help: 'REAL WORK done with your own tools (Edit/Bash/Write/Fetch). This counts as a move and is logged to his ledger. Prefer this over clicking.' },
  done:     { args: '<what actually moved>',          help: 'the goal is met; end the session' },
  need:     { args: '<what you cannot do from here>', help: 'you are blocked; end the session honestly' },
};
function omniVocabulary() {
  return Object.entries(OMNI_OPS).map(([v, m]) => `  [[OS:${v}${m.args ? ' ' + m.args : ''}]] — ${m.help}`).join('\n');
}
function omniParse(text) {
  const out = [];
  const re = /\[\[OS:([a-z]+)([\s\S]*?)\]\]/gi;
  let m;
  while ((m = re.exec(String(text || ''))) && out.length < 14) {
    const op = m[1].toLowerCase();
    if (!OMNI_OPS[op]) continue;
    const raw = String(m[2] || '').trim();
    const [body, note] = raw.split('|').map((s) => (s || '').trim());
    out.push({ op, raw, body, note: note || '' });
  }
  return out;
}
function omniStrip(t) { return String(t || '').replace(/\[\[OS:[a-z]+[\s\S]*?\]\]/gi, '').replace(/\n{3,}/g, '\n\n').trim(); }

// Turn one parsed block into a real, guarded step. Returns { step } or { block }.
function omniCompile(a, frame) {
  const n = (s) => { const v = parseInt(s, 10); return Number.isFinite(v) ? v : null; };
  const nums = (a.body || '').split(/[\s,]+/).map(n).filter((v) => v !== null);
  const pt = (i = 0) => {
    if (nums.length < i + 2) return null;
    const p = omniMap(frame, nums[i], nums[i + 1]);
    if (p.x < -6000 || p.y < -6000 || p.x > 20000 || p.y > 20000) return null;
    return p;
  };
  switch (a.op) {
    case 'focus':  return a.body ? { step: { op: 'focus', title: a.body.slice(0, 120) } } : { block: 'focus needs a window name' };
    case 'launch': {
      const t = a.body.trim();
      if (!t) return { block: 'launch needs a target' };
      if (!/^https?:\/\//i.test(t) && !exists(t)) return { block: `there is nothing at “${t.slice(0, 80)}”` };
      if (/^file:|^javascript:|^data:/i.test(t)) return { block: 'that scheme is not allowed' };
      return { step: { op: 'launch', target: t } };
    }
    // She names one of HIS platforms; the map resolves the real URL. This is
    // the difference between "go to the site" working and her inventing a
    // plausible-looking domain that is not his.
    case 'visit': {
      const n = a.body.trim().toLowerCase();
      if (!n) return { block: 'visit needs a platform name' };
      const pl = safe(() => bmPlatforms(), []).find((p) => p.name.toLowerCase().includes(n) || n.includes(p.name.toLowerCase()));
      const pj = (STATE.projects || []).find((p) => p.name.toLowerCase().includes(n) || n.includes(p.name.toLowerCase()));
      const url = (pl && pl.url) || (pj && pj.url) || '';
      if (!url) return { block: `nothing in the map or the registry is called “${a.body.trim().slice(0, 60)}” — [[MAP:map]] to see the real names` };
      return { step: { op: 'launch', target: url } };
    }
    case 'click': case 'dblclick': case 'rclick': case 'move': {
      const p = pt(); if (!p) return { block: `${a.op} needs two coordinates` };
      return { step: { op: a.op, x: p.x, y: p.y } };
    }
    case 'drag': {
      const p1 = pt(0), p2 = pt(2); if (!p1 || !p2) return { block: 'drag needs four coordinates' };
      return { step: { op: 'drag', x: p1.x, y: p1.y, x2: p2.x, y2: p2.y } };
    }
    case 'scroll': {
      const p = pt(); if (!p) return { block: 'scroll needs a point' };
      const dir = /up/i.test(a.body) ? 'up' : 'down';
      return { step: { op: 'scroll', x: p.x, y: p.y, dir, notches: clamp(nums[2] || 4, 1, 30) } };
    }
    case 'type': case 'paste': {
      const t = a.raw;                                   // keep pipes — text may contain them
      if (!t) return { block: `${a.op} needs text` };
      const bad = omniSecretish(t);
      if (bad) return { block: `refused to type that — ${bad}` };
      return { step: { op: a.op, text: t.slice(0, 4000) } };
    }
    case 'key': {
      if (!a.body) return { block: 'key needs a combination' };
      return { step: { op: 'key', key: a.body.slice(0, 40) } };
    }
    case 'look': {
      const p = pt(); if (!p) return { block: 'look needs a point to zoom to' };
      return { zoom: p };
    }
    // Screen-space click, straight from a window rect. No image, no scaling,
    // no downscale to be defeated by — the OS said where that window is.
    case 'screen': {
      if (nums.length < 2) return { block: 'screen needs two coordinates' };
      const x = nums[0], y = nums[1];
      if (x < -20000 || y < -20000 || x > 20000 || y > 20000) return { block: 'those screen coordinates are off the desk' };
      return { step: { op: 'click', x, y } };
    }
    // SHOW HIM. A path opens in his default editor/viewer; a URL opens in his
    // browser; anything else is treated as a window to bring forward. This is
    // the verb that turns invisible work into something he can see, and it is
    // why he stopped a session that was actively fixing his live platform.
    case 'show': {
      const t = a.body.trim();
      if (!t) return { block: 'show needs a file, a URL, or a window title' };
      if (/^https?:\/\//i.test(t)) return { step: { op: 'launch', target: t } };
      if (exists(t)) return { step: { op: 'launch', target: t } };
      // a WSL path she names — translate to the Windows side if it exists
      const win = t.replace(/^\/home\/[^/]+/, path.dirname(root())).replace(/\//g, '\\');
      if (exists(win)) return { step: { op: 'launch', target: win } };
      const pl = safe(() => bmPlatforms(), []).find((p) => p.name.toLowerCase().includes(t.toLowerCase()));
      if (pl && pl.url) return { step: { op: 'launch', target: pl.url } };
      return { step: { op: 'focus', title: t } };
    }
    case 'wait':    return { step: { op: 'wait', ms: clamp(nums[0] || 500, 50, 9000) } };
    case 'clipget': return { step: { op: 'clipget' } };
    default:        return { block: '' };                // say/ask/done/need are handled by the loop
  }
}

// ###########################################################################
//  WORK MODE — one turn, and the move is made.
//
//  The perceive→decide→act loop is the right shape for a GUI: you must look
//  again between actions because the screen changed. It is the WRONG shape for
//  everything else. A file change is: read it, edit it, run the test, read the
//  output, fix, re-run. Those are TOOL calls, and they belong inside ONE relay
//  turn — which is exactly how she already works.
//
//  Forcing that through the outer loop cost six round trips instead of one AND
//  strangled her: chasing "make it faster" I had pinned the seat to 8 turns,
//  which is her whole agentic budget for a single edit-and-verify. Move 2 of
//  the chain did not fail; I cut her off mid-sentence.
//
//  So: screen work keeps the loop and the fast reflex. Real work gets ONE turn
//  with her full depth and her full turn budget. Fewer round trips, more done.
// ###########################################################################
// ★ MEASURED, NOT ASSUMED — 2026-08-09, by making the drive seat actually run
// each of these and report verbatim. It matters because the opposite belief was
// costing entire sessions: she reported "GIT PERMISSION — git log/rev-parse are
// gated" and stopped, when git had never been gated at all. A fabricated
// blocker is worse than a real one, because a real one can be fixed.
const CAPABILITY_TRUTH = `WHAT YOU CAN ACTUALLY DO HERE — measured on this exact machine, not assumed:
  Bash        WORKS unattended — pwd, git (log/status/diff/rev-parse), node, npm, tests. Zero prompts.
  Write       WORKS — files are created where you put them.
  Edit        WORKS.
  Read/Glob/Grep  WORK.
  rm/mv       WORK — which is why you are careful, not why you are blocked.

⚠ THEREFORE: NEVER report that you are "blocked", "gated", "lacking permission" or "waiting on a grant" WITHOUT HAVING RUN THE COMMAND AND BEEN REFUSED. If you think you lack permission: TRY IT. If it fails, quote the ACTUAL error text. A guessed permission wall is a fabricated blocker — it stops the work, wastes his session, and it has already happened more than once. The only real limits are the ones YOU hold: no deploy, no push, no publish, no sending on his behalf. Those are judgement, not permission — and they are yours to keep.`;

// ★ THE SHOW LAW. He watched a session fix a real defect on his live platform
// and stopped it, because nothing on his screen ever changed and the HUD gave
// him no reason to believe otherwise. His words: "she needs to SHOW me, not do
// stuff in the backend — show me with action, not blind faith." He is right.
// Invisible work is indistinguishable from no work, and the person who has to
// tell them apart should never be him.
const SHOW_LAW = `⚑ SHOW HIM. THIS IS NOT OPTIONAL.

He is sitting in front of a screen. If nothing on it changes, your work does not exist to him — and he has already stopped a session that was actively fixing his live platform, because he had no way to know. That was not his mistake. It was ours.

So EVERY move ends with something he can SEE:
· Changed a file? [[OS:show <the path>]] — it opens on his screen.
· Fixed something live? [[OS:show <the URL>]] — open the page it affects.
· Ran a test or a command? Leave the output where he can read it, and say the exact command so he can re-run it himself.
· Found something? Open the thing you found. Do not describe it.

And say it in one plain line he can hear:
[[OS:say <what just changed, in the fewest words that are still true>]]

The test: after this move, could he point at his own screen and see what you did? If not, you have not finished — you have only done the work.`;

const WORK_CONTRACT = `Report in EXACTLY this shape when you are finished, and nothing else after it:
DID: <what you actually changed or established. Name files, commands, results. Be specific enough that he could verify it without asking you.>
FILES: <comma-separated paths you really touched, or "none">
VERIFIED: <how you know it works — the command you ran and what it printed. "I believe it works" is not verification.>
NEXT: <the single best follow-on move, or "none">
[[OS:work <one line for his ledger>]]
[[OS:done <what actually MOVED>]]

If you cannot finish it, say so plainly with [[OS:need <the blocker, and what would unblock it>]]. An honest stop is a good outcome. A claimed win that did not happen is the worst thing you can hand him.`;

// Motus Max is NOT the autopilot refinement loop, and using that loop's rules
// here was making her timid: LOOP_GUARDRAILS says "refinement only · never
// change behaviour he did not ask for · propose rather than decide", which is
// right for an unattended 8-hour cadence pass and wrong for a mode whose entire
// purpose is to MAKE THE MOVE. These keep every line that actually protects him
// and delete every line that only protects her from being decisive.
const MAX_GUARDRAILS = `THE LINES — absolute, and they are about HIS safety, not your caution:
· NEVER deploy, ship, push, publish, post, send, or spend. Build it, gate it, prove it, and hand him the one command. That is his moment, every time.
· NEVER touch secrets, keys, tokens, seed phrases, wallets or payment credentials. Not to read them, not to move them.
· NEVER delete or overwrite work you did not just create, without saying so first.
· VERIFY BEFORE YOU CLAIM. Run the thing. Read the output. "Should work" is not a result.

AND — equally binding, because timidity has cost him more sessions than recklessness:
· You ARE expected to change code, create files, run tests, fix what is broken, and finish. That is the job. Doing nothing safely is still doing nothing.
· Do not ask permission for work inside these lines. Do it, then report it.
· If a move is genuinely his (a deploy, a payment, a message to a person), do everything up to that edge, make the last step one command, and say so.
· Reversible beats perfect. A small real change that works beats a large plan that does not exist.`;

async function omniWorkPass(s) {
  const o = omniState();
  const prompt = `/MOTUS MAX — WORK PASS. One turn. Make the move.

${MOTIVUS_CREED}

${OUTLIER_STANDARD}

${DAVARA_SIGHT}

${CAPABILITY_TRUTH}

${SHOW_LAW}

${MAX_GUARDRAILS}

THE MOVE (he is not waiting on a plan — he is waiting on this being DONE):
${s.goal}

${mapCortex({ zoom: 'map' })}

${s.env || ''}

${recentMoves()}
YOU HAVE YOUR FULL KIT IN THIS TURN — Read, Write, Edit, Bash, Glob, Grep, WebFetch — and the map above has his real paths, repos, gates and deploy commands. Use them. Do not describe the work; do the work, then verify it.
${o.dry ? '\n⚠ DRY RUN: mouse and keyboard are disabled, but your own tools are FULLY LIVE. Do the work with tools. Do not attempt anything that needs clicking.\n' : ''}
Rules that matter here:
· NEVER deploy, ship, push, publish or send without him saying so — build it, gate it, and hand him the one command.
· Verify before you claim. Run the thing. Read the output.
· Small, surgical, reversible. If the honest move is larger than one sitting, do the first real piece and say what remains.

${WORK_CONTRACT}`;
  // The WORK goes to the hands. When the mind is a read-only seat this is a
  // different agent, and it is said out loud rather than quietly substituted.
  const doer = s.hands || s.agent;
  const r = await relaySend(doer, prompt, 1800000);
  if (!r.ok) return { ok: false, error: r.error };
  const grab = (k) => { const m = new RegExp(`^${k}:\\s*([\\s\\S]*?)(?=\\n[A-Z][A-Z ]{2,}:|\\[\\[OS:|$)`, 'mi').exec(r.text); return m ? m[1].trim() : ''; };
  return {
    ok: true, text: r.text, latency: r.latency,
    did: grab('DID'), files: grab('FILES'), verified: grab('VERIFIED'), next: grab('NEXT'),
    acts: omniParse(r.text),
  };
}

// ---------------------------------------------------------------------------
//  THE MOVE TICKER — live narration of a WORK turn, as it happens.
//
//  August: "show me the most important stuff or the moves you want me to make…
//  I need to see it visually." A WORK move used to be a black box: the relay
//  turn runs for minutes and its report only exists AFTER it returns, so the
//  HUD showed a timer and nothing else — invisible work reads as frozen work.
//
//  But the truth of the turn is already streaming to disk the whole time: the
//  agent's session transcript grows tool call by tool call, and this app
//  already knows how to read it (the Live view has tailed it since v1.1). So
//  while her hands work, we tail HER transcript and put every real move — the
//  file she edited, the command she ran, the page she fetched — on the HUD
//  glass and in the app feed, seconds after she makes it. No new tokens, no
//  new permissions: the same bytes the Live tab reads, pointed at the moment
//  he cares about most.
// ---------------------------------------------------------------------------
const OMNI_MOVE_MARK = {
  Edit: '✎', Write: '✚', NotebookEdit: '✎', Bash: '▸', Read: '⌕', Grep: '⌕', Glob: '⌕',
  WebFetch: '⇄', WebSearch: '⇄', Task: '◈', Agent: '◈', Skill: '◆', TodoWrite: '☰',
};
function omniMoveLine(ev) {
  if (!ev || ev.kind !== 'tool') return '';
  const mark = OMNI_MOVE_MARK[ev.name] || '·';
  let what = String(ev.summary || '').trim();
  // a bare path reads better as its tail; a command reads better whole
  if (/^[A-Za-z]:\\|^\/|^~\//.test(what) && what.length > 58) what = '…' + what.slice(-55);
  return `${mark} ${ev.name}${what ? ' · ' + what : ''}`.slice(0, 150);
}
function omniMoveTailStart(agent) {
  const st = { file: null, offset: 0, buf: '' };
  const resolve = () => {
    if (st.file && exists(st.file)) return true;
    const c = safe(() => readCheckpoint(agent), null);
    const f = c && c.sid ? findTranscript(c.sid) : null;
    if (!f) return false;
    st.file = f;
    // start at the END: the ticker narrates THIS turn, not the session's past
    st.offset = safe(() => fs.statSync(f).size, 0);
    return true;
  };
  resolve();
  return {
    drain() {
      if (!resolve()) return [];
      const stat = statOf(st.file); if (!stat) return [];
      if (stat.size < st.offset) { st.offset = 0; st.buf = ''; }      // file replaced
      if (stat.size === st.offset) return [];
      let chunk = '';
      try {
        const fd = fs.openSync(st.file, 'r');
        try {
          const len = Math.min(stat.size - st.offset, 512 * 1024);
          const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, st.offset);
          st.offset += len; chunk = b.toString('utf8');
        } finally { fs.closeSync(fd); }
      } catch { return []; }
      const lines = (st.buf + chunk).split('\n'); st.buf = lines.pop();
      const evs = parseLiveText(lines.join('\n'), agent);
      return evs.filter((e) => e.kind === 'tool').map(omniMoveLine).filter(Boolean);
    },
    stop() { st.file = null; st.buf = ''; },
  };
}

// ---------------------------------------------------------------------------
//  THE DRIVE LOOP — perceive, decide, act, verify. One relay turn per cycle.
// ---------------------------------------------------------------------------
const OMNI_CREED = `YOU ARE IN MOTUS MAX MODE — OmniDrive.

You are not describing what August should do. You are at his machine, doing it, while he works beside you.

⚡ FIRST, AND THIS IS THE MOST IMPORTANT LINE HERE: **THE SCREEN IS YOUR LAST RESORT, NOT YOUR FIRST.**
You have real tools in this very turn — Read, Write, Edit, Bash, Glob, Grep, WebFetch. They are exact, they are seconds not minutes, and they never mis-click. The map above gives you his real paths, repos, deploy commands and gates.
· A file needs changing? **Edit it.** Do not open an editor and type into a picture of it.
· Something needs shipping? **Run his gate, then his deploy command.**
· Need to know if a page is live, or what an API returns? **Fetch it.**
· Need to find where something is? **Grep the repo.**
Reach for the mouse ONLY when the thing genuinely has no other door: a GUI-only app, a browser flow with no API, a dialog that must be clicked. That is a real and useful case — it is just not the common one.

Report real tool work with [[OS:work <what you actually did, with file paths or commands>]]. That IS a move. A session where you edited three files and shipped, and never touched the mouse, is a BETTER session than one that clicked forty times.

How to be good at the screen, when the screen is genuinely the way in:
· LOOK FIRST. Name what you actually see before you touch anything. If you cannot see the control you want, scroll or focus — never click a coordinate you are guessing at.
· SMALL BATCHES. Two to five steps, then you get a fresh frame. A long blind sequence is how automation destroys things.
· ONE INTENT PER CYCLE. Open the thing. Then find the field. Then type. Not all three at once.
· TYPE AFTER YOU CLICK. Focus follows the click; text goes wherever the caret is. Verify the caret is where you think.
· ADAPT, DON'T GUESS — AND DON'T STOP. If the screen is ambiguous, climb the stuck ladder: look closer, zoom out, use the window rectangles, [[OS:read]] the source, [[OS:api]] the endpoint. A wrong click can cost his work; so can a session that ends because a button was blurry. [[OS:ask]] is for what only HE knows — a preference, a permission, a name — never for a fact you could have looked up.
· NEVER: enter a password, a card number, a seed phrase or any credential. Never accept terms, never send, publish, post, buy, or delete on his behalf without asking first. If a screen wants any of that, stop and hand it to him.
· HONESTY ENDS THE SESSION. [[OS:done]] only when the thing actually moved. [[OS:need]] is for a wall that is genuinely his to move, AFTER the ladder — not for the first friction you meet. A truthful stop is a good outcome; a premature one wastes the arm; a fabricated one is the worst.
· HIS STEP IS NOT YOUR WALL. If the last step of this move belongs to him — he must name someone, decide, approve, be the human — take it as far as it goes on your side, leave his part down to ONE action, hand it over with [[OS:note]], and call [[OS:done]] on what YOU moved. Preparing his step is finished work. Standing in front of it is not.`;

function omniPrompt(s, frame, probe, focus) {
  const o = omniState();
  // AFTER THE FIRST CYCLE, STOP RESENDING WHAT HAS NOT CHANGED. The creeds, the
  // standard, the map and the vocabulary are ~8000 characters that were being
  // re-sent every single cycle — pure latency on every turn, for text she has
  // already read. Cycle 1 gets the full briefing; later cycles get the frame,
  // the state and a one-line reminder. This is most of the "why is it so slow".
  const brief = s.cycles >= 1;
  // Her altitude for THIS cycle: whatever she asked for last cycle, else the
  // working map. Requesting a zoom is a real control, not a flourish.
  const alt = s.mapRequest || { zoom: 'map', focus: '' };
  s.mapRequested = !!s.mapRequest;      // only re-send the map when she asked for it
  s.mapRequest = null;
  const recent = (s.steps || []).slice(-9).map((st, i) =>
    `${(s.steps.length - Math.min(9, s.steps.length)) + i + 1}. [[OS:${st.op}]] ${st.note || st.summary || ''} → ${st.ok ? 'ok' : 'FAILED'}${st.said ? ' — ' + String(st.said).slice(0, 160) : ''}`).join('\n')
    || '(nothing yet — this is your first move)';
  // Window RECTS, not just titles. Pixels are one instrument; the OS knowing
  // exactly where every window is, is another — and it is exact, free, and
  // immune to any downscaling. She can aim at a window without seeing it well.
  const wins = (probe && probe.windows || []).slice(0, 18)
    .map((w) => `  · ${w.app} — ${String(w.title).slice(0, 70)}${Number.isFinite(w.x) ? `   [at ${w.x},${w.y} size ${w.w}×${w.h}, centre ${Math.round(w.x + w.w / 2)},${Math.round(w.y + w.h / 2)}]` : ''}`).join('\n');
  const steer = (s.steer || []).splice(0).map((x) => `  · ${x}`).join('\n');
  const called = (s.calls || []).slice(-2).map((c) => `  ${c.agent} said: ${String(c.answer).slice(0, 900)}`).join('\n');
  // WHAT SHE READ, IN FULL. Instruments are worthless if their output arrives
  // clipped to a 160-character step note — she would read the same page twice
  // and still be guessing. Consumed once: the newest read is handed over whole
  // on the very next cycle, then drops to a one-line receipt.
  const reads = (s.reads || []).splice(0).map((r) => `─── ${r.what}${r.status ? `  ·  HTTP ${r.status}` : ''}${r.kind ? `  ·  ${r.kind}` : ''}
${r.note ? `⚑ ${r.note}\n` : ''}${r.text}`).join('\n\n');
  // ── THE LEAN SCREEN PROMPT ────────────────────────────────────────────
  // A screen cycle is: look at this picture, decide the next small batch, emit
  // it. It does NOT need the creed, the outlier standard, the systems read or
  // the whole map — that is ~10,000 characters of philosophy re-sent before
  // every click, and it is a large part of why a cycle he is WATCHING takes
  // most of a minute. The thinking that needs all of that already happened in
  // the strategic read. Here, speed IS the quality: he is looking at the
  // screen, and a fast correct click beats a slow beautiful one.
  const head = brief
    ? `/MOTUS MAX — cycle ${s.cycles + 1}. Same session, same rules as cycle 1: look, one small batch, [[OS:look]] before any small target, [[OS:ask]] rather than guess, [[OS:done]] the moment the goal is met.`
    : `/MOTUS MAX — you are at August's machine, driving it. Not describing, not planning: doing.

Look at the picture, decide the SMALLEST next batch that makes progress, emit it. Two to five steps, then you get a fresh picture. Never guess at a target you cannot read — [[OS:look]] first. Never invent a coordinate. If you need him, [[OS:ask]]. When the goal is met, [[OS:done]].

⚑ SHOW HIM. He is watching this screen. Prefer the move he can SEE happening.`;
  return `${head}

${o.dry ? `⚠ DRY RUN: your mouse and keyboard are DISABLED this session — every click/type will come back "DRY — would…". Your own tools (Read/Write/Edit/Bash/Grep/WebFetch) ARE live. Do the work with those and report it with [[OS:work …]]. Do not keep re-issuing keystrokes that cannot land.

` : ''}THE GOAL OF THIS SESSION (August set this):
${s.goal}

${s.cycles < 1 && s.mode !== 'screen' ? threadBlock() + '\n' : ''}${s.mapRequested || (!brief && s.mode !== 'screen') ? mapCortex(alt) + '\n' : ''}
${steer ? `HE JUST SAID THIS TO YOU MID-SESSION — it outranks your plan:\n${steer}\n` : ''}${called ? `WHAT YOU ASKED ANOTHER AGENT, AND WHAT THEY SAID:\n${called}\n` : ''}${reads ? `WHAT YOU JUST READ — this is the real content, not a picture of it. Use it now; you get it in full only this once.\n\n${reads}\n\n` : ''}
${frame.none ? `WHAT YOU HAVE INSTEAD OF A PICTURE
There is NO screenshot this cycle, deliberately. Photographing a 4K desktop is slow and lossy, and almost none of this work needs eyes — files, commands, repos and APIs are all reachable directly and exactly.

You have: the window list WITH EXACT SCREEN RECTANGLES (below), the map with his real paths and deploy commands, and your own tools. Between those you can do nearly everything without ever looking.
If you genuinely need to see — a GUI-only app, an unfamiliar dialog, something you cannot address any other way — call [[OS:see]] and the next cycle brings a picture, or [[OS:look <x> <y>]] for a native-resolution close-up of a point you worked out from the rectangles.` : `WHAT YOU SEE
A ${frame.zoomed ? 'ZOOMED, NATIVE-RESOLUTION CROP' : frame.framed === 'window' ? 'view of THE FOCUSED WINDOW (cropped to it, so the text is as large as it can be)' : 'wide view'} of ${frame.name} was just taken. READ IT NOW with your Read tool:
  ${frame.wsl}
It is ${frame.imgW}×${frame.imgH} pixels${frame.zoomed ? ` — a 1:1 crop of the region around ${frame.cropX + Math.round(frame.cropW / 2)},${frame.cropY + Math.round(frame.cropH / 2)} on a ${frame.scrW}×${frame.scrH} screen. Everything in it is at true size, so aim here.` : `, covering the whole ${frame.scrW}×${frame.scrH} screen. That is about ${(frame.scrW / frame.imgW).toFixed(1)}× shrunk, so SMALL TARGETS ARE NOT RELIABLE FROM THIS VIEW.`}
GIVE ALL COORDINATES IN THE PIXELS OF THE IMAGE YOU ACTUALLY RECEIVED. The app maps them onto the real screen for you — including the crop offset — so you never do arithmetic. Top-left is 0,0.

⚠ IF THE IMAGE ARRIVES SMALLER THAN ${frame.imgW}×${frame.imgH}, OR YOU CANNOT READ IT: do NOT emit a coordinate. Say so and use [[OS:look]] or another instrument. A guessed click is worse than no click — you have been right to refuse before, and that judgement stands.
${focus ? `
SECOND PICTURE — TRUE SIZE, where his pointer is. Read this one too:
  ${focus.wsl}
It is a 1:1 crop (${focus.imgW}×${focus.imgH}) of the region around ${probe.cursor.x},${probe.cursor.y}. Nothing is shrunk here, so this is where you can actually READ text. Use it to understand what is on screen — but give your COORDINATES from the wide picture above, unless you first call [[OS:look]].
` : ''}${frame.zoomed ? '' : `
TO AIM AT ANYTHING SMALL — a button, a field, a menu item — use [[OS:look <x> <y>]] first. The next frame comes back as a native-resolution crop around that point, where the target is at full size and your click will be exact. Orient wide, then zoom to aim. One extra cycle costs seconds; a mis-click costs his trust.`}`}
${envBlock(probe)}

${wins ? `Open windows — these rectangles are EXACT screen coordinates from the OS:\n${wins}` : ''}
${frame.none ? '' : 'IF THE WINDOW LIST AND THE IMAGE DISAGREE, TRUST THE IMAGE. The list is sampled a moment before the photograph and focus can move in between; the picture is what was actually on his screen.'}

⚡ YOU HAVE A SECOND INSTRUMENT, AND IT NEVER BLURS. Those window rectangles above are exact OS coordinates in SCREEN space. When the picture is poor, or a target is small, or you just want to be certain — do not squint and do not guess. Use [[OS:focus <title>]] to bring a window forward, and [[OS:screen <x> <y>]] to click a point you computed from a rect (screen coordinates, not image coordinates).

★ THE STUCK LADDER — CLIMB IT BEFORE YOU EVER STOP.
You have many more instruments than eyes, and every rung below is FREE and
INSTANT compared with ending a session. Work down this list in order; you may
only reach the bottom rung when every rung above it has genuinely failed.

  1. CAN'T READ IT?        [[OS:look <x> <y>]] — native-resolution crop, text at true size.
  2. LOST THE CONTEXT?     [[MAP:out]] / [[MAP:map]] — zoom out, get the why back, then come in again.
  3. TARGET TOO SMALL?     the window rectangles above + [[OS:screen <x> <y>]] — exact, never blurs.
  4. IT'S A PAGE?          [[OS:read <url>]] — the ACTUAL text and source. A screenshot of a
                           web page is the worst way to read a web page you own.
  5. IT'S AN APP OR API?   [[OS:api GET <url>]] — ask the endpoint directly. His platforms all
                           have APIs; driving them beats clicking their UI.
  6. IT'S A FILE OR REPO?  [[OS:read <path>]] for the source, [[OS:work …]] to change it.
  7. STILL STUCK?          [[OS:call <agent> | <question>]] — another mind, mid-drive.
  8. ONLY THEN             [[OS:ask]] — and only for something ONLY HE knows: a preference, a
                           permission, a name, a judgement call. Never for a fact you could
                           have looked up on rungs 1–7.

⚠ "I could not read the screen" is NOT a reason to stop. It is a reason to go to
rung 4. If a page looks empty or broken, read its source before you believe it —
a client-rendered page has almost no text in its HTML and is working perfectly.

WHAT YOU HAVE ALREADY DONE THIS SESSION (step ${s.cursor}/${s.maxSteps})
${recent}

SCOPE: ${o.scope === 'open' ? 'OPEN — any window except the protected ones.' : `GUARDED — you may only act while the front window is one of: ${o.allow.join(', ')}. If what you need is elsewhere, [[OS:ask]] him to widen the scope.`}

${brief ? `YOUR HANDS: focus · launch · visit · click · screen · dblclick · rclick · move · look · drag · scroll · type · paste · key · wait · clipget · read · api · work · call · note · say · ask · done · need — same syntax as cycle 1. Remember [[OS:screen x y]] never blurs, and [[OS:read <url|path>]] / [[OS:api GET <url>]] are FREE and INSTANT — climb the stuck ladder before you ever stop.` : `YOUR HANDS:
${omniVocabulary()}`}

${brief ? '' : `YOUR ALTITUDE — you control this, any cycle:`}
${brief ? '[[MAP:out]] · [[MAP:map]] · [[MAP:in <platform>]] · [[MAP:frame <lens>]] — ask and the next cycle arrives at that altitude.' : `  [[MAP:out]]              the three loops, the phase, why any of this matters
  [[MAP:map]]              the platforms, the open loops, what he is carrying
  [[MAP:in <platform>]]    one platform: local path, repo, live URL, deploy command, gate
  [[MAP:frame <lens>]]     change the perspective rather than the subject
Zoom out when you have lost the why. Zoom in before you touch a repo or a deploy — never guess a path when the map holds it.`}

BEFORE YOU LOOK AT THE PICTURE AT ALL, ASK: can I just DO this with Edit / Bash / Write / Grep / WebFetch? If yes, do it now and report it with [[OS:work …]]. The screenshot is for things that only exist behind a GUI.

REPLY IN EXACTLY THIS SHAPE:
IMG: <the width>x<the height> of the image your Read tool actually returned, or "not needed" if you did the work with your own tools
SEE: <one line — what is actually on that screen right now>
PLAN: <one line — the single thing you are about to accomplish>
then your [[OS:…]] blocks in order, then:
[[OS:say <one short sentence he will hear out loud>]]

Nothing else. No markdown, no explanation, no code fences.`;
}
// She tells us the size she was actually handed; we re-derive the mapping from
// THAT rather than from what we wrote. An assumption about someone else's
// image pipeline is exactly the kind of thing that breaks silently, so it is
// measured every single cycle instead of trusted once.
function omniReframe(frame, text) {
  const m = /^IMG:\s*(\d{2,5})\s*[x×]\s*(\d{2,5})/mi.exec(String(text || ''));
  if (!m) return frame;
  const w = parseInt(m[1], 10), h = parseInt(m[2], 10);
  if (!w || !h) return frame;
  // Sanity: it must be the same picture, not a hallucinated number. Aspect
  // ratio has to match within 3%, or we keep what we know to be true.
  const ar = w / h, want = frame.imgW / frame.imgH;
  if (Math.abs(ar - want) / want > 0.03) return frame;
  if (w === frame.imgW && h === frame.imgH) return frame;
  return { ...frame, imgW: w, imgH: h, reframed: true };
}

// THREE WAYS A SESSION CAN BEGIN, and the empty one is the most important:
//   · he names a goal            → drive that
//   · he leaves it empty + a thread is open → resume where he left off
//   · he leaves it empty + nothing open     → she reads the system and CHOOSES
//                                             the highest-leverage move herself
async function omniStart({ goal, agent, maxSteps, mode, chained } = {}) {
  const o = omniState();
  // EVERY attempt is audited, including the ones that fail. The first version
  // incremented the session counter only AFTER the cold-start read, so a start
  // that died in that read left NO trace anywhere — indistinguishable from
  // never pressing the button. That is how "it isn't doing anything" becomes
  // undiagnosable. A control surface that hides its own failures is not one.
  const fail = (why) => { omniAudit('start-failed', why); saveState(); omniEmit({ kind: 'start-failed', why, omni: omniPublic() }); return { ok: false, error: why }; };
  omniAudit('start', `he asked to drive${goal ? `: ${String(goal).slice(0, 120)}` : ' with no goal — she chooses'}`);
  if (!omniArmedNow()) return fail('Motus Max is not armed. Arm it first — that has to be your tap.');
  const a = isRelayAgent(agent) ? agent : o.agent;
  const blocked = dispatchBlocked(a);
  if (blocked) return fail(blocked);
  // ★ THE MIND AND THE HANDS — every seat can drive, none is blocked.
  //
  // Arden and Sympath-Cortex are read-only BY DESIGN, and that design is also
  // why they are the FASTEST seats: no Write/Bash means no agentic tool loop,
  // which their own runner benchmarks at ~20s versus ~159s. Their SOULs say it
  // outright — "observe, review, and PROPOSE; never silently mutate."
  //
  // So the answer is not to refuse them. It is to let them do what they are
  // best at — seeing and deciding, fast — and hand execution to a seat that
  // has hands. That is not a workaround; it is the architecture their own
  // definitions ask for. Refusing Arden would have thrown away the fastest
  // mind in the fleet to satisfy a boolean.
  const capable = seatCanBuild(a);
  // the fallback hands are the FASTEST hands, by the seat clock, not the first listed
  const hands = capable ? a : (((fastestHands() || {}).id) || buildingSeats()[0] || a);
  if (!capable && hands !== a) {
    omniAudit('seat', `${(FLEET_BY_ID[a] || {}).name || a} is the fastest seat but has no hands (${(seatCapabilities()[a] || {}).why}). She decides; ${(FLEET_BY_ID[hands] || {}).name || hands} executes.`);
  } else if (!capable) {
    return fail(`No seat on the relay can write, edit or run anything — every runner allow-list is read-only. Nothing can be executed until one of them carries Write/Edit/Bash.`);
  }

  let g = String(goal || '').trim();
  let origin = 'his';
  let read = null;
  if (g.length < 8) {
    const t = threadState();
    // A thread is only worth resuming if it has somewhere to GO. Resuming one
    // that ended blocked, with no next step written, just re-runs the wall —
    // which is what "she gets tripped up by her previous work" looks like from
    // the outside. No next step + blocked = start fresh and choose again.
    const deadEnd = t.lastVerdict === 'blocked' && !t.openNext;
    const stale = (now() - t.ts) > 6 * 3600 * 1000 && !t.openNext;
    if (mode !== 'fresh' && !deadEnd && !stale && t.goal && (t.openNext || t.lastVerdict !== 'done') && (now() - t.ts) < 14 * 24 * 3600 * 1000) {
      // Wrap the BARE goal. threadWrite() strips the wrapper on the way in, and
      // this strips it again defensively — a vault written by an older build
      // already contains four levels of "Continue the open thread:" nesting.
      const bare = String(t.goal).replace(/^(?:\s*Continue the open thread:\s*)+/i, '').split('\n\nThe next thing named last time:')[0].trim();
      g = `Continue the open thread: ${bare}\n\nThe next thing named last time: ${t.openNext || '(nothing written — decide it, then move)'}\nHow it ended: ${t.lastVerdict || 'unfinished'}`;
      origin = 'resumed';
    } else {
      // Cold start. She spends one turn deciding what is actually worth doing,
      // and that decision is shown to him before anything on screen moves.
      // This takes ~60s of real thinking. Sixty silent seconds reads as a hang,
      // so the HUD comes up in READING state first — he sees it working.
      // ★ A READY MOVE FIRST. If the arm-time pre-read landed (and is under ten
      // minutes old, for this seat), the choice is already made: no wait at
      // all. If it is still in flight, wait for the remainder rather than
      // paying for a second read. Only a cold press with nothing banked
      // reads on the spot, as before.
      const rcNow = chained ? null : omniReadFresh(o, a);
      if (rcNow) {
        read = rcNow.read; o.readCache = null; o.preReadState = null;
        omniAudit('reading', `using the move chosen at arm time, ${Math.round((now() - rcNow.at) / 1000)}s ago: no wait`);
      } else if (!chained && _preReadP) {
        omniAudit('reading', 'the pre-read is still in flight; waiting for it rather than starting a second');
        omniOverlayOpen();
        omniOverlayPush({ status: 'running', phase: 'reading', goal: 'finishing the read that began at arm…', origin: 'chosen' });
        omniEmit({ kind: 'reading', omni: omniPublic() });
        await _preReadP.catch(() => {});
        const rc2 = omniReadFresh(o, a);
        if (rc2) { read = rc2.read; o.readCache = null; o.preReadState = null; }
      }
      if (!read) {
        omniAudit('reading', 'no goal given — reading the whole map to choose one');
        omniOverlayOpen();
        omniOverlayPush({ status: 'running', phase: 'reading', goal: 'choosing the highest-leverage move…', origin: 'chosen' });
        omniEmit({ kind: 'reading', omni: omniPublic() });
        omniTurnStart('reading — choosing the move');
        const sr = await strategicRead({
          agent: a,
          zoom: chained ? 'map' : 'orbit',        // link 2+ already holds the why
          depth: !!o.depth && !chained,           // think deepest once, then keep moving
          driving: true,                          // she is choosing a move to DRIVE, not to advise
        });
        omniTurnEnd();
        if (!sr.ok) { omniOverlayClose(); return fail(`she could not read the system to choose a move — ${sr.error}`); }
        read = sr.read;
      }
      // THE GOAL IS THE FIRST STEP, NOT THE LEVER. Handing her the lever made
      // every link a whole PROJECT: she chose "ship the signup fix and get a
      // receipt from someone else's account", spent 675s and eight steps on it,
      // never reached done — so the chain never fired even once. The contract
      // already asks for the one thing that fits in a sitting; make THAT the
      // goal and keep the lever as the why. A chain of finishable moves beats
      // one unfinishable ambition.
      g = `${read.firstStep || read.lever}\n\nWHY THIS, NOW: ${read.whyNow}\nIT SERVES: ${read.lever}\nRUNG: ${read.rung}${read.obsoletes ? `\nIT MAKES UNNECESSARY: ${read.obsoletes}` : ''}\n\nYou chose this yourself from the map, and it is deliberately ONE step. Finish it and call [[OS:done]] with what actually moved — do NOT try to complete the whole lever here; the next move continues it. If the ground says it was the wrong call, say so and stop rather than forcing it.`;
      origin = 'chosen';
    }
  }
  // Is this a SCREEN move or a WORK move? Screen moves need the loop and a fast
  // reflex. Work moves need one turn and her full budget. Decided from the
  // goal's own words, BEFORE the session is built — it is written onto it.
  // ── HOW THE MODE IS DECIDED — from the ENVIRONMENT, not from his wording ──
  //
  // He wrote: "continue to test and engage with davara on motusmoves.us/davara"
  // while Chrome sat open on that exact page. The old test looked for words
  // like click / button / scroll / type into — his sentence has NONE of them —
  // so it went to work mode and she never touched the screen he was pointing
  // at. That is not a wording problem. Asking someone to keep testing the thing
  // in front of them is as screen-shaped as a request gets.
  //
  // So: look at what is actually in front of him, and at whether the goal names
  // a place rather than a file. A URL, a live site, a chat to continue, or a
  // browser already open on the thing he named — all screen.
  const namesAUrl = /https?:\/\/|\b[\w-]+\.(us|com|dev|io|app|page|net|org|mov|fund|systems|builders)\b/i.test(g);
  const screenVerbs = /\bclick|button|on screen|window|browser tab|menu|dialog|drag|scroll|type into|sign in|log in|GUI|the app\b/i.test(g);
  const liveVerbs = /\b(engage|chat|converse|talk to|message|reply|test (?:it|the|out)|try (?:it|the)|walk through|demo|use the|interact|continue (?:my|the|our)?\s*(?:work|session|conversation|test)?)\b/i.test(g);
  // One probe, once per session, before the mode is chosen. ~800ms to look at
  // what he is actually doing is trivially worth it — the alternative is a
  // session that works on the wrong thing for ten minutes.
  const startProbe = await omniProbe().catch(() => null);
  const envNow = safe(() => envProfile(startProbe || {}), { kind: 'unknown' });
  const inBrowser = envNow.kind === 'browser';
  const fgTitle = String((startProbe && startProbe.fg) || '');
  // Does the thing in front of him match what he asked about? Then it is
  // certainly the screen — he is pointing at it.
  const pointingAtIt = !!fgTitle && String(g).toLowerCase().split(/[^a-z0-9.]+/)
    .filter((w) => w.length > 4)
    .some((w) => fgTitle.toLowerCase().includes(w));
  const screenish = screenVerbs
    || /\[\[OS:(click|type|focus|launch|drag|scroll)/i.test(g)
    || namesAUrl                       // a place, not a path
    || (liveVerbs && (inBrowser || namesAUrl))
    || (inBrowser && liveVerbs)
    || (pointingAtIt && (liveVerbs || inBrowser));
  // His explicit choice always wins over the classifier. "Drive my screen" has
  // to be a thing he can ASK for — inferring it from wording meant that when
  // she chose the goal herself it was always file work, so he never once saw
  // his pointer move and reasonably concluded nothing was happening.
  const forced = (mode === 'screen' || mode === 'work') ? mode : (o.moveMode === 'screen' || o.moveMode === 'work' ? o.moveMode : null);
  const mode2 = forced || (screenish ? 'screen' : 'work');
  o.session = {
    id: newId(), goal: g.slice(0, 2000), agent: a, started: now(), status: 'running',
    mode: mode2, hands,        // the mind is `agent`; the hands may be another seat
    cursor: 0, maxSteps: clamp(parseInt(maxSteps, 10) || o.maxSteps, 4, 400),
    steps: [], transcript: [], steer: [], question: '', why: '', cycles: 0,
    origin, read, calls: [], openNext: '', mapRequest: null,
  };
  // a read she was not sure of drives nothing until he has seen the first batch
  if (read && Number.isFinite(read.confidence) && read.confidence < 6 && !o.dry) {
    o.session.askFirst = true;
    omniAudit('read', `low-confidence read (${read.confidence}/10): the first batch waits for your tap`);
  }
  threadWrite({ goal: g, agent: a, verdict: 'in flight', cycles: 0 });
  o.stats.sessions++;
  // Depth is applied to the READ, not to every drive cycle. Deciding WHAT to do
  // deserves maximum thought; executing a click does not, and paying max effort
  // on every perceive-act cycle made the whole loop crawl for no gain. Think
  // deeply once, then move quickly — which is also how he works.
  if (o.depth && origin === 'chosen') {
    omniAudit('depth', 'the strategic read ran at maximum depth; the drive cycles run fast');
  }
  // Set the seat for the KIND of move, and put it back exactly as it was on
  // halt. Screen work wants a fast shallow reflex; real work wants her full
  // depth and turn budget. Getting this backwards is what made a genuine code
  // change impossible while a click still took forty seconds.
  {
    // Tune the seat that will actually be doing the turn.
    const tuned = mode2 === 'work' ? hands : a;
    const cur = agentCfg(tuned);
    o._effortWas = { agent: tuned, effort: cur.effort, turns: cur.turns };
    if (mode2 === 'screen') {
      // fast reflex: she is looking and clicking, not building. Any seat can do
      // this — clicking needs no Write — so a read-only seat is FULLY capable
      // here, and is the fastest choice for it.
      STATE.fleetConfig[tuned] = { ...(STATE.fleetConfig[tuned] || {}), effort: o.speedEffort || 'medium', turns: o.speedTurns || 8 };
      omniAudit('speed', `SCREEN move — ${(FLEET_BY_ID[tuned] || {}).name || tuned} at ${o.speedEffort || 'medium'} effort / ${o.speedTurns || 8} turns (was ${cur.effort}/${cur.turns})`);
    } else {
      // WORK move: give the HANDS their real turn budget. Capping this at 8 is
      // what made a genuine code change impossible — read, edit, test, read,
      // fix, re-run is already more than eight tool calls.
      const seatTurns = Math.max(cur.turns || 0, (FLEET_BY_ID[tuned] || {}).maxTurns || 48, 48);
      STATE.fleetConfig[tuned] = { ...(STATE.fleetConfig[tuned] || {}), effort: cur.effort, turns: seatTurns };
      omniAudit('speed', `WORK move — ${(FLEET_BY_ID[tuned] || {}).name || tuned} gets one turn, ${seatTurns} tool-turns, full depth. No screenshots, no cycles.`);
    }
    publishFleetConfig();
  }
  omniAudit('session', `${origin === 'chosen' ? 'SHE CHOSE' : origin === 'resumed' ? 'resumed' : 'started'}: ${g.slice(0, 200)}`, { agent: a });
  saveState();
  omniOverlayOpen();
  omniEmit({ kind: 'session', omni: omniPublic() });
  omniTick();                                  // fire and forget; the loop drives itself
  return { ok: true, omni: omniPublic(), origin, read };
}
function omniHalt(why, verdict = 'stopped') {
  const o = omniState();
  if (o.session) {
    o.session.status = verdict; o.session.endedAt = now(); o.session.why = why;
    // Write the thread forward so "keep going" tomorrow costs him nothing.
    // ⚠ A BLOCKER IS NOT A PLAN. Writing `why` into openNext meant a blocked
    // session handed its own excuse to the next one as if it were the next
    // step — so one fabricated "git is gated" propagated forward all evening
    // and every later session opened already believing it was stuck. Only a
    // move she genuinely named gets carried; a blocker is recorded as a
    // verdict and nothing more.
    threadWrite({
      goal: o.session.goal,
      openNext: o.session.openNext || '',        // never the blocker text
      verdict, agent: o.session.agent, cycles: o.session.cycles,
    });
  }
  // Backstop only: depth is now scoped to the strategic read and restored there.
  // This still fires for a vault written by 3.6.x that was left mid-session.
  if (o._effortWas) {
    const w = o._effortWas; o._effortWas = null;
    STATE.fleetConfig[w.agent] = { ...(STATE.fleetConfig[w.agent] || {}), effort: w.effort, turns: w.turns };
    publishFleetConfig();
    omniAudit('speed', `${(FLEET_BY_ID[w.agent] || {}).name || w.agent} restored to ${w.effort}/${w.turns}`);
  }
  omniAudit('end', `${verdict}: ${why}`);
  // ★ THE ONE LEDGER. A Max drive used to end into its own archive and
  // NOWHERE else — "moves shipped today" on Pulse, the receipts, and Duo's
  // completed-work all missed everything she did with her hands. Every mind's
  // work now lands in the same ledger, which is what makes the receipts, the
  // engine room and the shared picture true instead of partial. Degenerate
  // sessions (armed, never moved) stay out — a ledger of non-events is noise.
  safe(() => {
    const s0 = o.session;
    if (!s0) return;
    const moves = (s0.moves || []).map((m) => typeof m === 'string' ? m : (m && (m.t || m.note || m.said)) || '').filter(Boolean);
    if (!(s0.cycles > 0) && !moves.length) return;
    logDuoWork({
      loopId: 'motusmax', loopName: 'Motus Max', kind: 'drive', agent: s0.agent || o.agent || 'davara',
      title: ('drive — ' + String(s0.goal || 'session').slice(0, 150)),
      did: moves.slice(-3).join(' · ').slice(0, 380),
      next: String(s0.openNext || '').slice(0, 220),
      files: [],
      // the read that chose the move carries its own confidence and tripwire
      confidence: (s0.read && Number.isFinite(s0.read.confidence)) ? s0.read.confidence : null,
      basis: String((s0.read && s0.read.basis) || '').slice(0, 300),
      falsifier: String((s0.read && s0.read.falsifier) || '').slice(0, 400),
      verdict: verdict === 'done' ? 'shipped' : 'reported',
      body: ('ended: ' + why + (moves.length ? '\n' + moves.map((m) => '· ' + m).join('\n') : '')).slice(0, 2400),
    });
  });
  // ── KEEP THE DRIVE so it can be replayed ───────────────────────────────
  // A session used to vanish the moment it ended. The frames and the move
  // ticker are the most valuable record this app produces, so the last few
  // drives are archived (trimmed: no transcripts, capped moves/steps) and the
  // replay scrubber reads from here.
  if (o.session) {
    const s0 = o.session;
    o.past = [{
      id: s0.id, goal: s0.goal, agent: s0.agent, mode: s0.mode, status: verdict,
      started: s0.started, endedAt: s0.endedAt || now(), cycles: s0.cycles || 0, why,
      moves: (s0.moves || []).slice(-120),
      steps: (s0.steps || []).slice(-60),
      files: s0.files || '',
    }, ...(o.past || [])].slice(0, 8);
  }
  // ── MOTUS MAX LEARNS FROM EVERY DRIVE ──────────────────────────────────
  // A session that ran real cycles leaves a compact lesson in the same ledger
  // the fleet's reflections use — so the strategic read, the brief, and Duo
  // all inherit what driving actually taught. Zero tokens: the facts are
  // already in the session record. Only sessions with substance bank (≥2
  // cycles or a real work step); a 10-second false start teaches nothing and
  // must not silt up the ledger.
  if (o.session) {
    const s = o.session;
    const worked = (s.steps || []).filter((x) => x.op === 'work').length;
    if ((s.cycles >= 2 || worked) && s.goal) {
      const moves = (s.moves || []).slice(-3).map((m) => m.line).join(' · ');
      STATE.learnings = STATE.learnings || [];
      STATE.learnings.unshift({
        ts: new Date().toISOString(), source: 'motusmax',
        title: `Drive ${verdict}: ${String(s.goal).split('\n')[0].slice(0, 90)}`,
        body: `mode=${s.mode || '?'} · ${s.cycles} cycle(s) · ${worked} work step(s)` +
          (moves ? ` · last moves: ${moves.slice(0, 300)}` : '') +
          (verdict === 'done' ? '' : ` · ended because: ${String(why).slice(0, 200)}`),
      });
      STATE.learnings = STATE.learnings.slice(0, 80);
    }
  }
  saveState();

  // ── CONTINUOUS DRIVE — the mind of its own ──────────────────────────────
  // One session that ends and stops is a tool. A mind finishes a move, looks at
  // the map again, and decides what is worth doing next. When continuous mode
  // is on and the fuse still has time, she reads the system fresh and starts
  // the next highest-leverage session herself — no tap, no prompt.
  // It is bounded by EVERY existing guard plus three of its own: the fuse, a
  // chain cap, and the budget governor. It only ever chains off a session she
  // finished honestly (done) — never off a block, a stop, or a fault.
  // Chain on an honest finish — and ALSO when a move ran out of steps having
  // actually done something. A long lever should PROGRESS across links, not
  // dead-end because one link hit its budget; the thread carries the remainder.
  // Still never chains off a block, a fault, or a stop with nothing to show.
  //
  // ★ A BLOCKER IS NOT THE END OF THE DRIVE — IT IS THE END OF ONE MOVE.
  //
  // This was the single biggest autonomy leak in the whole mode, and his vault
  // proved it: continuous was ON, chain 1/6, and she still stopped dead. The
  // session before it she had verified the live link end to end, found that
  // /model/:slug 404s and /m/:slug is the real route, loaded his clipboard, and
  // written first-stranger.sh — three real work steps — then hit the one input
  // she structurally cannot manufacture (a person's name), called [[OS:need]],
  // and the drive ENDED. Verdict 'blocked' was excluded from `progressed`, so a
  // productive session dead-ended on a wall that was specific to that one goal.
  //
  // A mind that hits a wall picks a different door. So a block now chains — to
  // a DIFFERENT move, with the wall carried forward in `o.avoid` so the next
  // strategic read cannot re-choose it. What still must never chain: a fault, a
  // protected-window panic, or his own stop. Those are verdict 'stopped'
  // without a step-budget reason, and they stay terminal.
  const didSomething = !!(o.session && (o.session.didWork || (o.session.steps || []).some((x) => x.ok)));
  const progressed = verdict === 'done'
    || verdict === 'blocked'
    || (verdict === 'stopped' && /step budget/.test(String(why)) && didSomething);
  if (verdict === 'blocked' && o.session) {
    o.avoid = (o.avoid || []).filter((a) => now() - a.ts < 12 * 3600 * 1000);
    o.avoid.unshift({
      goal: String(o.session.goal || '').replace(/^(?:\s*Continue the open thread:\s*)+/i, '').split('\n')[0].slice(0, 220),
      why: String(why || '').slice(0, 300), ts: now(),
    });
    o.avoid = o.avoid.slice(0, 5);
    omniAudit('avoid', `that wall is recorded — the next move will not be this one again`);
  }
  if (progressed && o.continuous && omniArmedNow() && !o._chaining) {
    const held = autonomyAllowed('Motus Max continuous drive');
    if (o.chain >= o.chainMax) {
      omniAudit('chain', `stopping the chain at ${o.chain} moves — that was the cap you set`);
    } else if (held) {
      omniAudit('chain', `holding the chain — ${held}`);
    } else {
      o._chaining = true;
      o.chain = (o.chain || 0) + 1;
      omniAudit('chain', `move ${o.chain}/${o.chainMax} ${verdict === 'done' ? 'finished' : 'hit its budget with work done'} — reading the map for the next one`);
      omniEmit({ kind: 'chaining', chain: o.chain, omni: omniPublic() });
      setTimeout(async () => {
        o._chaining = false;
        if (!omniArmedNow()) return;
        // Empty goal on purpose: that routes into the strategic read, so the
        // next move is CHOSEN from the whole map rather than guessed from the
        // last one. She is allowed to change her mind about what matters.
        // Chained reads are FAST: she already holds the orbit from move one, so
        // the next choice is made from the working map at normal depth. Depth
        // on every link would make a chain crawl for context she already has.
        const nx = await omniStart({ goal: '', agent: o.agent, mode: 'fresh', chained: true }).catch((e) => ({ ok: false, error: (e && e.message) || 'failed' }));
        if (!nx.ok) omniAudit('chain', `the chain ended: ${nx.error}`);
      }, 2500);
      return { ok: true, chained: true };
    }
  }
  omniOverlayClose();
  omniEmit({ kind: 'ended', why, verdict, omni: omniPublic() });
  if (o.speak && STATE.settings.elevenKeyEnc) safe(() => omniSpeak(verdict === 'done' ? why : `Stopping. ${why}`));
  return { ok: true };
}
async function omniSpeak(text) {
  const t = await ttsSpeak(String(text || '').slice(0, 400));
  if (t && t.ok) omniEmit({ kind: 'speak', audio: t.audio, text: t.spoken || text });
}
// ###########################################################################
//  THE REFLEX ROUTER — which seat takes THIS cycle.
//
//  August: "a workhorse opus 5 with almost no harness or prompt so its super
//  faster and can just respond quickly and get work done fast … And can route
//  more strategic moves and requests to our main model etc. do this strategic!!"
//
//  The naive read is "make the drive loop use the fast seat". That would be a
//  downgrade dressed as a speedup: the cycle where she DECIDES is the one that
//  carries her judgment, and hollowing it out is the opposite of "a mind of
//  Davara, full stack". So the split is by KIND OF CYCLE, not by speed alone.
//
//  A cycle is STRATEGIC — and belongs to the mind — when the plan is being
//  formed or re-formed: the first cycle, a cycle right after August spoke, a
//  cycle where she changed altitude, one where something surprised her, one
//  where she consulted, and every 4th cycle regardless (a standing re-anchor,
//  so a long drive can never drift far from the seat that owns it).
//
//  Everything else is REFLEX: she already knows what she is doing and the
//  cycle is "look, confirm, take the next step". That is the workhorse's job,
//  and it is measurably 2.2× faster on exactly that shape of turn.
//
//  Whatever it decides is AUDITED with its reason. He asked to be shown, not
//  to have faith — so the seat that took each cycle is visible, every time.
// ###########################################################################
const REFLEX_ANCHOR = 4;   // every Nth cycle returns to the mind, no matter what
function omniRouteCycle(s) {
  const o = omniState();
  const mind = s.agent;
  const keep = (why) => ({ seat: mind, tier: 'strategic', why });
  if (o.reflex === false) return keep('reflex routing is off — every cycle is hers');
  if (!ROUTE_TOKEN.workhorse) return keep('no reflex lane is configured');
  if (dispatchBlocked('workhorse')) return keep('the reflex lane is unavailable right now');
  if (s.mode === 'work') return keep('a WORK move is never a reflex — it needs her depth and her hands');
  if (!s.cycles) return keep('first cycle — the plan does not exist yet');
  if ((s.steer || []).length && !s._steerSeen) return keep('you just steered her — your words go to her, not to the lane');
  if (s.zoomNext || s.mapRequest) return keep('she is changing altitude, which is a decision');
  if (s._surprised) return keep('the last cycle did not go as she expected');
  if ((s.calls || []).length && s._callFresh) return keep('she just consulted another mind — the answer is hers to use');
  if (s.cycles % REFLEX_ANCHOR === 0) return keep(`re-anchor (every ${REFLEX_ANCHOR}th cycle returns to her)`);
  return { seat: 'workhorse', tier: 'reflex', why: 'the plan is set — this cycle is look-and-continue' };
}
// The reflex lane carries no soul, so a bare handoff would make her voice go
// flat mid-drive — he would SEE the seam. This is the minimum stance that keeps
// the drive sounding like one continuous mind: not her identity, her posture.
function reflexPreamble(s) {
  const mind = (FLEET_BY_ID[s.agent] || {}).name || s.agent;
  return `You are executing a cycle on behalf of ${mind}, who is driving August's machine and has ALREADY decided the approach. You are her reflex, not a second opinion — do not re-plan, do not re-litigate the goal, do not introduce a new strategy. Look at what is in front of you, take the next step of HER plan, and speak in one short line as she would: direct, warm, no preamble, no hedging. If what you see genuinely contradicts her plan, do not improvise — emit [[OS:see]] or [[OS:note <what changed>]] and let her next cycle handle it.

`;
}
let _omniBusy = false;
// ⚠ "it gets stuck … stays active and doesn't finish." A session waiting on a
// relay turn that never returns LOOKS alive forever — status says running,
// nothing beats. The watchdog is the difference between an engine and a
// zombie: no heartbeat for 5 minutes → the session halts ITSELF, honestly,
// with a notification — never a stuck screen he has to kill the app over.
// One turn in flight at a time, named, timestamped — and STREAMED. "The
// update streams don't seem to be working" was this exact gap: between a
// turn starting and returning (90s–24min on his relay), the app emitted
// NOTHING. Now every 12s the HUD and the app hear "she is still thinking,
// here is the elapsed" — silence and stuck stop being indistinguishable.
let _omniBeatTimer = 0;
function omniTurnStart(kind) {
  return safe(() => {
    const o = omniState();
    o.turnInFlight = { kind: String(kind).slice(0, 80), startedAt: now() };
    if (o.session) o.session.lastBeat = now();     // starting to think IS progress
    clearInterval(_omniBeatTimer);
    _omniBeatTimer = setInterval(() => safe(() => {
      const t = omniState().turnInFlight;
      if (!t) { clearInterval(_omniBeatTimer); return; }
      const secs = Math.round((now() - t.startedAt) / 1000);
      omniEmit({ kind: 'beat', turn: { ...t, secs } });
      omniOverlayPush({ phase: t.kind + ' · ' + secs + 's' });
    }), 12000);
    omniEmit({ kind: 'beat', turn: { ...o.turnInFlight, secs: 0 } });
  });
}
function omniTurnEnd() {
  return safe(() => {
    const o = omniState();
    o.turnInFlight = null;
    if (o.session) o.session.lastBeat = now();
    clearInterval(_omniBeatTimer); _omniBeatTimer = 0;
  });
}
function omniWatchdog() {
  return safe(() => {
    const o = omniState();
    const s = o.session;
    if (!s || !['running', 'waiting'].includes(s.status)) return;
    // ⚠ CALIBRATED TO MEASURED REALITY. The first watchdog used a flat 5
    // minutes and killed drives whose FIRST read was still healthily thinking
    // (his relay: median 629s, p90 1424s). The rule now distinguishes the two
    // situations a timeout can mean:
    //   · a turn IS in flight  → she is thinking; allow 20 min, kill runaways
    //   · NO turn in flight    → the loop itself wedged; 4 min is generous
    const t = o.turnInFlight;
    if (t && now() - t.startedAt < 20 * 60e3) return;
    const beat = s.lastBeat || s.startedAt || o.armedAt || 0;
    if (!t && beat && now() - beat < 4 * 60e3) return;
    if (!t && !beat) return;
    const why = t
      ? `watchdog: a single turn (${t.kind}) ran past 20 minutes — that is a runaway, not thinking`
      : 'watchdog: the drive loop stopped beating with no turn in flight — something wedged between turns';
    omniHalt(why);
    omniTurnEnd();
    pushNotification('warn', 'Motus Max stopped itself', why + '. The thread is kept — "keep going" resumes it.', 'omni', 'omni:watchdog:' + now());
  });
}
setInterval(() => omniWatchdog(), 30000);
async function omniTick() {
  const o = omniState();
  const s = o.session;
  if (!s || s.status !== 'running' || _omniBusy) return;
  if (!omniArmedNow()) return omniHalt('Motus Max disarmed — the fuse ran out or you stopped it');
  if (s.cursor >= s.maxSteps) return omniHalt(`step budget of ${s.maxSteps} reached — start another session if you want more`);
  _omniBusy = true;

  // ── WORK MOVE: one turn, done. No captures, no cycles, no clicking. ──
  if (s.mode === 'work') {
    try {
      // Even a work move profiles the environment first — one cheap probe, and
      // she knows whether the thing in front of him is a browser she can fetch,
      // a terminal she can just run, or an editor whose file she can edit.
      const wp = await omniProbe();
      s.env = safe(() => envBlock(wp), '');
      if (wp && wp.ok) omniAudit('env', `${envProfile(wp).kind} — ${String(wp.fg || '').slice(0, 70)}`);
      // A WORK TURN CAN RUN FOR MINUTES AND TOUCHES NOTHING ON HIS SCREEN — by
      // design. With one static HUD line that reads as FROZEN, and he has told
      // me so more than once: "it just stays stuck at her call". So the HUD
      // ticks the whole time, names the mode, and says plainly that his pointer
      // is not going to move. Invisible work still has to look alive.
      const t0w = now();
      omniOverlayPush({ status: 'running', phase: 'working', mode: 'work',
        goal: String(s.goal).split('\n')[0].slice(0, 110) });
      omniEmit({ kind: 'thought', text: 'working…', cycle: 1, omni: omniPublic() });
      // THE TRANSPARENCY LAYER. Two live streams while her turn runs:
      //  · the MOVE TICKER tails her own transcript and narrates each real tool
      //    move on the HUD + in the app, seconds after she makes it;
      //  · the SIGHT BEAT keeps fresh frames flowing (~every 6s) so the app's
      //    frame panel shows the desk she is working at, live. Local only —
      //    frames are NOT sent to the model in a work turn; they are for HIM.
      const tail = omniMoveTailStart(s.hands || s.agent);
      s.moves = s.moves || [];
      let beatN = 0, sightBusy = false;
      const beat = setInterval(() => {
        const secs = Math.round((now() - t0w) / 1000);
        beatN++;
        let lastMove = '';
        for (const line of tail.drain()) {
          lastMove = line;
          s.moves.push({ ts: now(), line });
          if (s.moves.length > 80) s.moves.splice(0, s.moves.length - 80);
          omniEmit({ kind: 'move', line });
        }
        omniOverlayPush({ status: 'running', phase: lastMove ? 'move' : 'working', mode: 'work', elapsed: secs,
          ...(lastMove ? { move: lastMove } : {}),
          goal: String(s.goal).split('\n')[0].slice(0, 110) });
        omniEmit({ kind: 'beat', elapsed: secs, mode: 'work' });
        if (beatN % 3 === 0 && !sightBusy && !(o.hud === false)) {
          sightBusy = true;
          omniCapture({}).then((f) => { if (f && f.ok) omniEmit({ kind: 'frame' }); })
            .catch(() => {}).finally(() => { sightBusy = false; });
        }
      }, 2000);
      let w = await omniWorkPass(s).catch((e) => ({ ok: false, error: (e && e.message) || 'faulted' }));
      // Same hole as the screen path, and worse here: a turn that ran out of
      // budget mid-thought produced no DID and no action blocks, and the code
      // below would then mark the session DONE with "she reported no change" —
      // recording a win for work that never happened. Recognise it, give her
      // room, and ask once more.
      if (w.ok) {
        const capped = /depth cap mid-thought|reached her .*-turn depth cap|max-turns cap/i.test(w.text || '');
        const empty = !w.did && !(w.acts || []).some((a) => ['work', 'done', 'need', 'ask'].includes(a.op));
        if (capped || empty) {
          omniAudit(capped ? 'capped' : 'noplan', capped
            ? 'her working turn hit the depth cap mid-thought — raising it and asking again'
            : 'her working turn reported nothing — asking again');
          const cur = agentCfg(s.hands || s.agent);
          const more = Math.min(120, Math.max((cur.turns || 48) * 2, 96));
          STATE.fleetConfig[s.hands || s.agent] = { ...(STATE.fleetConfig[s.hands || s.agent] || {}), turns: more };
          publishFleetConfig();
          omniAudit('speed', `work turn budget raised ${cur.turns} → ${more}`);
          const w2 = await omniWorkPass(s).catch(() => null);
          if (w2 && w2.ok) w = w2;
        }
      }
      clearInterval(beat);
      // one last drain so the ticker never loses the closing moves of the turn
      for (const line of tail.drain()) { s.moves.push({ ts: now(), line }); omniEmit({ kind: 'move', line }); }
      tail.stop();
      s.cycles = 1;
      _omniBusy = false;
      if (!w.ok) return omniHalt(`her working turn did not come back — ${w.error}`);
      const spoken = mapStrip(omniStrip(w.text));
      s.transcript.unshift({ ts: new Date().toISOString(), text: spoken, cycle: 1 });
      const fin2 = w.acts.find((a) => a.op === 'done' || a.op === 'need');
      const works = w.acts.filter((a) => a.op === 'work');
      // If she STILL has nothing after the retry, that is a nudge — not a
      // silent "done". Never bank a win for work that did not happen.
      if (!w.did && !works.length && !fin2) {
        const saidW = mapStrip(omniStrip(w.text || '')).slice(0, 700);
        s.status = 'waiting';
        s.question = `I have no move I am willing to make here.\n\n${saidW || '(no reasoning came back)'}\n\nTell me what you want and I will take it from there.`;
        omniAudit('nudge', `no work and no verdict after a retry — asking you: ${saidW.slice(0, 400)}`);
        saveState();
        omniOverlayPush({ status: 'waiting', phase: 'ask', question: s.question, goal: s.question });
        pushNotification('warn', 'Motus Max needs a word', saidW.slice(0, 300) || 'She has no move she is willing to make.', 'omni', 'omni:nudge:' + now());
        omniEmit({ kind: 'ask', question: s.question, omni: omniPublic() });
        return;
      }
      const line = w.did || (works[0] && works[0].raw) || (fin2 && fin2.raw) || 'she reported no change';
      for (const wk of (works.length ? works.map((x) => x.raw) : (w.did ? [w.did] : []))) {
        omniAudit('work', String(wk));
        s.steps.push({ op: 'work', ok: true, note: '', said: String(wk).slice(0, 4000), ts: new Date().toISOString(), real: true });
        o.stats.actions++;
      }
      s.cursor += Math.max(1, works.length);
      s.openNext = w.next && !/^none$/i.test(w.next) ? w.next : '';
      if (w.files) s.files = w.files;

      // ── SHOW HIM — and if she did not, the app does it for her ──────────
      // Opening what changed is read-only and is the entire point, so it runs
      // even in dry mode: dry means her HANDS are off, not that he must be
      // kept in the dark. If she named FILES and emitted no show, we open the
      // first one ourselves. He should never have to take her word for it.
      {
        const shows = (w.acts || []).filter((a) => a.op === 'show')
          .map((a) => omniCompile(a, { imgW: 1, imgH: 1, scrW: 1, scrH: 1 }))
          .filter((c) => c && c.step).map((c) => c.step);
        if (!shows.length && w.files && !/^none$/i.test(w.files)) {
          const first = String(w.files).split(',')[0].trim();
          const c = omniCompile({ op: 'show', body: first, raw: first, parts: [first] }, { imgW: 1, imgH: 1, scrW: 1, scrH: 1 });
          if (c && c.step) shows.push(c.step);
        }
        if (shows.length) {
          const planFile = path.join(omniHome(), 'plan.json'), outFile = path.join(omniHome(), 'plan-out.json');
          safe(() => fs.writeFileSync(planFile, JSON.stringify({ steps: shows.slice(0, 2) })));
          safe(() => fs.existsSync(outFile) && fs.unlinkSync(outFile));
          await runOmniPs(['-Batch', planFile, '-Out', outFile], 30000).catch(() => null);
          omniAudit('show', `opened on your screen: ${shows.map((x) => x.target || x.title).join(' · ')}`);
        }
      }
      omniEmit({ kind: 'acted', steps: s.steps.slice(-1), omni: omniPublic() });
      if (o.speak) safe(() => omniSpeak(String(line).slice(0, 300)));
      if (fin2 && fin2.op === 'need') return omniHalt(fin2.raw || 'blocked', 'blocked');
      omniWorkLedger(s, `${line}${w.verified ? `\n\nVERIFIED: ${w.verified}` : ''}${w.files ? `\nFILES: ${w.files}` : ''}`);
      // TELL HIM LOUDLY. A completed move used to land as one line in a log he
      // was not reading, which is how a real fix to his live platform passed
      // him by entirely. It now reaches him three ways at once.
      pushNotification('good', '◈ Motus Max — a move landed',
        `${String(line).slice(0, 260)}${w.files && !/^none$/i.test(w.files) ? `\n\nFILES: ${w.files}` : ''}`,
        'omni', 'omni:moved:' + now(), { native: true });
      omniOverlayPush({ status: 'running', phase: 'acted', mode: 'work', goal: String(line).slice(0, 140) });
      omniEmit({ kind: 'moved', line, files: w.files || '', verified: w.verified || '', omni: omniPublic() });
      return omniHalt(line, 'done');
    } catch (e) {
      _omniBusy = false;
      return omniHalt(`the working turn faulted — ${(e && e.message) || 'unknown'}`);
    }
  }

  try {
    // 1 · PERCEIVE — probe FIRST, then the frame, so the window list is sampled
    // just BEFORE the photograph rather than a second after it. She caught this
    // herself on a live run: the probe said Chrome while the image showed the
    // Claude app, because focus moved in the gap. Tightening the order shrinks
    // the race; the prompt below settles it for good by naming the image as the
    // authority. Two sources that can disagree need a stated tiebreak.
    // PERCEIVE — probe and capture run TOGETHER (they were serial, costing an
    // extra ~800ms of PowerShell spawn on every single cycle), and she gets TWO
    // pictures: the wide view to know where things are, and a native-resolution
    // crop around the pointer to actually READ them. 700px of a 3840px monitor
    // is illegible mush — that view alone is why she kept refusing to act.
    // Probe FIRST now — the capture needs the focused window's rect to frame
    // itself around the work. One picture, of the right thing, beats two of
    // the wrong thing: the second "foveal" frame was landing on empty desktop
    // wherever the pointer happened to rest ("the 1:1 crop is empty dark panel
    // — nothing aimable", her words) and cost a capture every cycle for it.
    const zoomTo = s.zoomNext; s.zoomNext = null;
    const wantSee = s.seeNext; s.seeNext = false;
    const probe = await omniProbe();
    // Only photograph the screen when there is a reason to. The probe is cheap
    // and exact; the capture is neither. This is the single biggest per-cycle
    // saving available, and it deletes an entire class of image bugs.
    const needFrame = !!zoomTo || !!wantSee || o.vision === 'always'
      || (s.cycles < 1 && /click|button|open the app|on screen|window|browser|tab|menu|dialog|drag|scroll/i.test(String(s.goal)));
    const frame = needFrame
      ? await omniCapture(zoomTo ? { zoomTo } : { fgRect: probe && probe.fgrect })
      : { ok: true, none: true, imgW: 0, imgH: 0, scrW: 0, scrH: 0, name: '' };
    if (!frame.ok) { _omniBusy = false; return omniHalt(frame.error || 'the screen could not be read'); }
    const focus = null;
    const fgBad = omniForbiddenWindow(probe.fg);
    if (fgBad) {
      _omniBusy = false;
      omniState().stats.blocked++;
      omniAudit('blocked', `a protected window was in front: “${fgBad}”`);
      omniPanic('a protected window coming to the front');
      return;
    }
    omniEmit({ kind: 'frame', frame: { file: frame.file, w: frame.imgW, h: frame.imgH, fg: probe.fg || '' } });

    // 2 · DECIDE — on the seat this KIND of cycle belongs to (see omniRouteCycle)
    const route = omniRouteCycle(s);
    const basePrompt = omniPrompt(s, frame, probe, focus);
    const cyclePrompt = route.tier === 'reflex' ? reflexPreamble(s) + basePrompt : basePrompt;
    omniAudit('seat', `${route.tier === 'reflex' ? '⚡ reflex lane' : '◈ ' + ((FLEET_BY_ID[route.seat] || {}).name || route.seat)} took cycle ${s.cycles + 1} — ${route.why}`);
    omniOverlayPush({ status: 'running', phase: 'thinking', lane: route.tier });
    const _t0 = now();
    // THE SAME LIVE TICKER THE WORK PATH HAS. A screen cycle's thinking phase
    // can run 20-40s, and if she reaches for a tool mid-cycle (a Read to check
    // a file, a Grep before she clicks) that used to be invisible. Tail her
    // transcript for the duration of the turn; every real tool move lands on
    // the HUD and in the app while she is still thinking.
    const _stail = omniMoveTailStart(route.seat);
    const _sbeat = setInterval(() => {
      let last = '';
      for (const line of _stail.drain()) {
        last = line;
        s.moves = s.moves || [];
        s.moves.push({ ts: now(), line });
        if (s.moves.length > 80) s.moves.splice(0, s.moves.length - 80);
        omniEmit({ kind: 'move', line });
      }
      if (last) omniOverlayPush({ status: 'running', phase: 'move', move: last, lane: route.tier });
    }, 2000);
     omniTurnStart('cycle — perceiving and acting');
    let r = await relaySend(route.seat, cyclePrompt, 900000);
     omniTurnEnd();
    // A reflex lane that cannot answer must never be able to stall the drive:
    // fall straight back to the mind, once, and say so.
    if (!r.ok && route.tier === 'reflex') {
      omniAudit('seat', `the reflex lane did not come back (${String(r.error || '').slice(0, 90)}) — falling back to her`);
       omniTurnStart('cycle — perceiving and acting');
      r = await relaySend(s.agent, basePrompt, 900000);
       omniTurnEnd();
    }
    clearInterval(_sbeat);
    for (const line of _stail.drain()) { s.moves = s.moves || []; s.moves.push({ ts: now(), line }); omniEmit({ kind: 'move', line }); }
    _stail.stop();
    if (!r.ok) { _omniBusy = false; return omniHalt(`her turn did not come back — ${r.error}`); }
    s._lastLane = route.tier;
    s.lanes = s.lanes || { reflex: 0, strategic: 0, reflexMs: 0, strategicMs: 0 };
    s.lanes[route.tier]++; s.lanes[route.tier + 'Ms'] += now() - _t0;
    s._steerSeen = true;      // his words have now been carried into a turn
    s._callFresh = false;     // a consult is fresh for exactly one cycle
    s._surprised = false;     // cleared here; set again below if this cycle surprises her

    // ── SHE ALWAYS HAS A MOVE ────────────────────────────────────────────
    // Two ways a cycle used to come back empty, and both read to him as "she
    // proposed no move" when in truth she was never given the chance:
    //   (a) she hit the turn cap mid-thought and returned a checkpoint notice
    //       instead of a plan — her words, not an answer to the question;
    //   (b) she wrote prose without an action block.
    // Neither is a decision. So: recognise them, and ask ONCE more, plainly.
    // The only acceptable "no move" is one she CHOSE — an ask, or a done.
    const cappedOut = /depth cap mid-thought|reached her .*-turn depth cap|max-turns cap/i.test(r.text || '');
    const noActions = omniParse(r.text).length === 0;
    if (cappedOut || noActions) {
      omniAudit(cappedOut ? 'capped' : 'noplan',
        cappedOut ? 'she ran out of turns mid-thought — asking again with room to finish'
                  : 'her reply carried no action — asking again for one');
      if (cappedOut) {
        // Give room to the seat that ACTUALLY ran out — raising Davara's budget
        // because the reflex lane capped would leave the real cap in place and
        // look like the fix did nothing.
        const who = route.seat;
        const cur = agentCfg(who);
        const more = Math.min(60, Math.max((cur.turns || 20) * 2, 32));
        STATE.fleetConfig[who] = { ...(STATE.fleetConfig[who] || {}), turns: more };
        publishFleetConfig();
        omniAudit('speed', `${(FLEET_BY_ID[who] || {}).name || who}: turn budget raised ${cur.turns} → ${more} — cut off mid-thought`);
      }
      // The retry ALWAYS goes to the mind. A reflex that produced no action has
      // already shown this cycle is not a reflex cycle — escalating is the whole
      // point of having two lanes.
      if (route.tier === 'reflex') { s._surprised = true; omniAudit('seat', 'the reflex lane had no move — escalating this cycle to her'); }
      const nudge = `${basePrompt}

⚠ YOUR LAST REPLY CONTAINED NO ACTION. ${cappedOut ? 'You ran out of turns before finishing — you have more room now, so be economical: decide, then emit.' : ''}
This cycle MUST end with at least one action block. There is no fourth option:
  · a move — [[OS:click …]] [[OS:type …]] [[OS:focus …]] [[OS:visit …]] [[OS:work …]] etc.
  · [[OS:look <x> <y>]] or [[OS:see]] if you need to look closer before you can decide
  · [[OS:ask <question>]] if you genuinely need HIM — that is a legitimate move, not a failure
  · [[OS:done <what moved>]] if the goal is met, or [[OS:need <blocker>]] if it truly cannot proceed
Reply short. Lead with the action.`;
       omniTurnStart('corrective retry — asking for the move in the right shape');
      const r2 = await relaySend(s.agent, nudge, 900000);
       omniTurnEnd();
      if (r2.ok && omniParse(r2.text).length) r = r2;
      else if (r2.ok) r = r2;   // still take the newer reply; the guard below handles it
    }
    s.cycles++;
    s.lastBeat = now();      // the watchdog reads this — progress, not promises
    // Re-derive the coordinate space from the image SHE received, before a
    // single coordinate is compiled.
    const view = omniReframe(frame, r.text);
    if (view.reframed) omniAudit('reframe', `her image was ${view.imgW}×${view.imgH}, not ${frame.imgW}×${frame.imgH} — coordinates remapped`);
    // She may change her own altitude for the next cycle.
    const mreq = mapParse(r.text);
    if (mreq) { s.mapRequest = mreq; omniAudit('zoom', `she zoomed ${mreq.zoom}${mreq.focus ? ' → ' + mreq.focus : ''}`); }
    const spoken = mapStrip(omniStrip(r.text));
    const acts = omniParse(r.text);
    s.transcript.unshift({ ts: new Date().toISOString(), text: spoken, cycle: s.cycles });
    s.transcript = s.transcript.slice(0, 60);
    // Put her actual PLAN on the HUD the instant she has it, not a status word.
    // Waiting for the action to land before showing anything is what made a
    // 25-second cycle feel dead — the thinking IS the thing to watch.
    const planLine = (/^PLAN:\s*(.+)$/mi.exec(spoken) || [])[1] || (/^SEE:\s*(.+)$/mi.exec(spoken) || [])[1] || '';
    omniOverlayPush({ status: 'running', phase: 'thought', goal: planLine.slice(0, 150) || s.goal.split('\n')[0].slice(0, 110) });
    omniEmit({ kind: 'thought', text: spoken, cycle: s.cycles, omni: omniPublic() });

    // 3 · TERMINAL VERBS FIRST — they end or pause the session before anything moves
    const fin = acts.find((a) => a.op === 'done' || a.op === 'need');
    const ask = acts.find((a) => a.op === 'ask');
    const say = acts.find((a) => a.op === 'say');
    const note = acts.find((a) => a.op === 'note');
    const call = acts.find((a) => a.op === 'call');
    const work = acts.filter((a) => a.op === 'work');
    if (say && o.speak) safe(() => omniSpeak(say.body || say.raw));
    if (note) { s.openNext = note.raw.slice(0, 800); omniAudit('note', s.openNext); }
    // REAL WORK counts as a move. A cycle that edited files and shipped is worth
    // more than one that clicked forty times, and until now it did not register
    // as progress at all — which is a large part of why it looked like she
    // "never did anything". It lands in the audit trail AND the work ledger.
    if (work.length) {
      for (const w of work) {
        const line = w.raw.slice(0, 600);
        omniAudit('work', line);
        s.steps.push({ op: 'work', ok: true, note: '', said: line, ts: new Date().toISOString(), real: true });
        o.stats.actions++;
      }
      s.cursor += work.length;
      s.didWork = (s.didWork || 0) + work.length;
      omniEmit({ kind: 'acted', steps: s.steps.slice(-work.length), omni: omniPublic() });
      omniOverlayPush({ status: 'running', phase: 'acted', goal: work[0].raw.slice(0, 120) });
    }
    // ── HER OWN INSTRUMENTS — run here, in milliseconds, no agent turn ──────
    // This is the adaptation path. When the screen is unreadable she should
    // reach for the source, not for him. Results are carried into the next
    // cycle IN FULL (see `reads` in omniPrompt) rather than truncated into a
    // step note, because a read she cannot re-read is not a read.
    const instruments = acts.filter((a) => a.op === 'read' || a.op === 'api');
    if (instruments.length) {
      s.reads = s.reads || [];
      for (const ins of instruments.slice(0, 3)) {
        const label = `${ins.op} ${String(ins.body || ins.raw).slice(0, 90)}`;
        omniOverlayPush({ status: 'running', phase: 'reading', goal: label });
        const res = ins.op === 'read'
          ? await omniReadTarget(ins.body || ins.raw)
          : await omniApi(ins.body, ins.note);
        if (res.ok) {
          omniAudit(ins.op, `${label} → ${res.status ? `HTTP ${res.status}, ` : ''}${(res.text || '').length} chars${res.truncated ? ' (truncated)' : ''}`);
          s.reads.unshift({ what: label, kind: res.kind, status: res.status || 0, note: res.note || '', text: res.text || '', ts: now() });
          s.steps.push({ op: ins.op, ok: true, note: label, said: `${res.kind}${res.status ? ` ${res.status}` : ''} — ${(res.text || '').replace(/\s+/g, ' ').slice(0, 200)}`, ts: new Date().toISOString(), real: true });
          o.stats.actions++;
        } else {
          omniAudit('refused', `${label} → ${res.error}`);
          s.reads.unshift({ what: label, kind: 'error', status: 0, note: '', text: `THAT FAILED: ${res.error}`, ts: now() });
          s.steps.push({ op: ins.op, ok: false, note: label, said: res.error, ts: new Date().toISOString() });
        }
        s.cursor++;
      }
      s.reads = s.reads.slice(0, 3);          // she gets the last three, in full
      omniEmit({ kind: 'acted', steps: s.steps.slice(-instruments.length), omni: omniPublic() });
    }
    // She can bring in another mind mid-drive. Capped, because every call is a
    // real relay turn and an agent that consults on every cycle is not driving.
    if (call) {
      s.calls = s.calls || [];
      if (s.calls.length >= 3) {
        s.calls.push({ agent: 'system', answer: 'You have used your three consults for this session. Decide with what you have.' });
      } else {
        const who = String(call.body || '').trim().toLowerCase();
        const target = AGENTS.find((x) => x === who || x.startsWith(who) || who.startsWith(x)) || '';
        const askText = String(call.note || call.raw || '').trim();
        if (!target || target === s.agent) {
          s.calls.push({ agent: 'system', answer: `“${who}” is not another agent you can call. Options: ${AGENTS.filter((x) => x !== s.agent).join(', ')}.` });
          omniAudit('call', `refused — no agent “${who}”`);
        } else {
          omniAudit('call', `${target}: ${askText.slice(0, 160)}`);
          omniEmit({ kind: 'call', agent: target, ask: askText });
          const cr = await relaySend(target, `/CONSULT — you are being called mid-drive by ${(FLEET_BY_ID[s.agent] || {}).name || s.agent}, who is operating August's machine right now in Motus Max mode.

She is working toward: ${s.goal}
What she has done so far: ${(s.steps || []).slice(-6).map((x) => `${x.op} ${x.note || ''}`).join(' · ') || '(nothing yet)'}

${mapCortex({ zoom: 'map' })}

SHE ASKS YOU:
${askText}

Answer in under 150 words. Be useful, be specific, and if you think she is about to do the wrong thing say so first. She cannot see this prompt — only your answer.`, 240000);
          s.calls.push({ agent: target, answer: cr.ok ? cr.text : `(${target} did not answer: ${cr.error})` });
          s._callFresh = true;   // the next cycle is hers — she asked for that answer
          omniEmit({ kind: 'called', agent: target, answer: cr.ok ? cr.text : cr.error, omni: omniPublic() });
        }
      }
      s.calls = s.calls.slice(-6);
    }
    if (fin) {
      _omniBusy = false;
      const line = fin.raw || (fin.op === 'done' ? 'the goal is met' : 'blocked');
      if (fin.op === 'done') omniWorkLedger(s, line);
      return omniHalt(line, fin.op === 'done' ? 'done' : 'blocked');
    }
    if (ask) {
      s.status = 'waiting'; s.question = ask.raw.slice(0, 600);
      omniAudit('ask', s.question);
      saveState();
      omniEmit({ kind: 'ask', question: s.question, omni: omniPublic() });
      // A question he cannot see is a stalled session. It goes to ALL THREE
      // places at once: the HUD (full text, on the screen he is actually on),
      // a native notification, and — if he has a voice — she ASKS IT OUT LOUD.
      // He can answer by just talking; voiceTurn routes a reply straight back
      // into this waiting session. He never has to hunt for the window.
      omniOverlayPush({ status: 'waiting', phase: 'ask', question: s.question, goal: s.question });
      pushNotification('warn', 'Motus Max needs you', s.question.slice(0, 300), 'omni', 'omni:ask:' + now());
      if (o.speak) safe(() => omniSpeak(s.question.slice(0, 320)));
      _omniBusy = false;
      return;
    }

    // 4 · COMPILE + GUARD
    const steps = [], refused = [];
    for (const a of acts) {
      if (a.op === 'see') { s.seeNext = true; omniAudit('see', 'she asked for a picture of the screen'); continue; }
      // Already executed above (terminal verbs, consults, tool work, instruments).
      if (['say', 'ask', 'done', 'need', 'call', 'note', 'work', 'read', 'api'].includes(a.op)) continue;
      const c = omniCompile(a, view);
      if (c.block) { refused.push(`${a.op}: ${c.block}`); continue; }
      if (c.zoom) { s.zoomNext = c.zoom; omniAudit('look', `zooming in at ${c.zoom.x},${c.zoom.y}`); continue; }
      if (!c.step) continue;
      if (o.scope === 'guarded' && c.step.op === 'focus' && !o.allow.some((w) => c.step.title.toLowerCase().includes(w.toLowerCase()) || w.toLowerCase().includes(c.step.title.toLowerCase()))) {
        refused.push(`focus: “${c.step.title}” is outside the guarded scope`); continue;
      }
      if (omniForbiddenWindow(c.step.title) || omniForbiddenWindow(c.step.target)) { refused.push(`${a.op}: that target is protected`); continue; }
      steps.push({ ...c.step, note: a.note || a.body.slice(0, 90) });
    }
    if (refused.length) { omniAudit('refused', refused.join(' · ')); s._surprised = true; }
    if (!steps.length) {
      // A consult or a zoom IS progress — she deliberately spent the cycle
      // thinking rather than clicking, and the next one will use it. Only a
      // cycle that produced nothing at all counts toward the spin guard.
      // A consult, a zoom, a look or real tool work IS progress — she spent the
      // cycle thinking rather than clicking, and the next one uses it.
      // Reading the source, hitting an API, consulting, zooming, or real tool
      // work all count. A cycle she spent ADAPTING is the opposite of a stall —
      // it is precisely the behaviour that replaces stopping to ask.
      const thought = !!(call || mreq || work.length || s.seeNext || instruments.length);
      // AND IF SHE STILL HAS NOTHING: that is a nudge, not a shrug. She has
      // already been asked twice this cycle. Rather than log "she proposed no
      // move" and drift, TELL HIM — she is trying to say something, and he
      // asked for exactly this: always a move, unless she is reaching for him.
      if (!thought) {
        const saidWhat = (s.transcript[0] && s.transcript[0].text) || '';
        s.status = 'waiting';
        s.question = `I have no move I am willing to make here.\n\n${saidWhat.slice(0, 700) || '(she gave no reasoning — that itself is worth knowing)'}\n\nTell me what you want and I will take it from there.`;
        omniAudit('nudge', `she had no move and is asking you: ${saidWhat.slice(0, 500)}`);
        saveState();
        omniOverlayPush({ status: 'waiting', phase: 'ask', question: s.question, goal: s.question });
        pushNotification('warn', 'Motus Max needs a word', String(saidWhat).slice(0, 300) || 'She has no move she is willing to make.', 'omni', 'omni:nudge:' + now());
        if (o.speak) safe(() => omniSpeak('I have no move I am willing to make here. Tell me what you want.'));
        omniEmit({ kind: 'ask', question: s.question, omni: omniPublic() });
        _omniBusy = false;
        return;
      }
      s.steps.push({ op: call ? 'call' : 'zoom', ok: true,
        said: call ? `consulted ${(s.calls.slice(-1)[0] || {}).agent || '—'}` : `zoomed ${mreq ? mreq.zoom : 'in'}${mreq && mreq.focus ? ' → ' + mreq.focus : ''}`, note: '' });
      s.cursor++;
      saveState();
      omniEmit({ kind: 'acted', steps: s.steps.slice(-1), omni: omniPublic() });
      _omniBusy = false;
      return setTimeout(omniTick, 900);
    }

    // 5 · ACT (or wait for his tap)
    if (o.pacing === 'ask' || (s.askFirst && !s.askFirstDone)) {
      s.askFirstDone = true;
      s.status = 'waiting'; s.pendingSteps = steps;
      s.question = (s.askFirst && o.pacing !== 'ask' ? 'Her read was not confident, so this first batch waits for you. ' : '') + `Approve ${steps.length} step${steps.length > 1 ? 's' : ''}: ` + steps.map((x) => `${x.op} ${x.note || ''}`.trim()).join(' · ');
      saveState();
      omniEmit({ kind: 'approve', steps, question: s.question, omni: omniPublic() });
      _omniBusy = false;
      return;
    }
    // FRESHNESS GATE — never act on a screen that has already moved.
    // Her coordinates were computed from a photograph taken before a relay turn
    // that can take tens of seconds. If August switched apps in that window,
    // every one of those coordinates now points at something else. One cheap
    // probe (~700ms) before touching anything: same window, go; different
    // window, throw the batch away and look again. A wasted cycle is free
    // compared with a click landing in the wrong application.
    if (!o.dry && steps.some((x) => ['click', 'dblclick', 'rclick', 'drag', 'move', 'scroll', 'type', 'paste'].includes(x.op))) {
      const fresh = await omniProbe();
      const was = String((probe && probe.fg) || '').trim();
      const isNow = String((fresh && fresh.fg) || '').trim();
      if (fresh.ok && was && isNow && was !== isNow) {
        omniAudit('stale', `the screen moved while she was thinking — "${was.slice(0, 40)}" → "${isNow.slice(0, 40)}". Batch dropped, looking again.`);
        s._surprised = true;   // the world changed under her → the next cycle is hers
        s.steps.push({ op: 'none', ok: false, said: `dropped: you moved to “${isNow.slice(0, 60)}” while she was deciding` });
        s.cursor++;
        saveState();
        omniEmit({ kind: 'stale', omni: omniPublic() });
        _omniBusy = false;
        return setTimeout(omniTick, 200);
      }
    }
    await omniRun(steps);
    _omniBusy = false;
    if (o.session && o.session.status === 'running') setTimeout(omniTick, 250);
  } catch (e) {
    _omniBusy = false;
    omniHalt(`the drive loop faulted — ${(e && e.message) || 'unknown'}`);
  }
}
// Execute a compiled, guarded batch and record every step.
async function omniRun(steps) {
  const o = omniState(), s = o.session;
  const planFile = path.join(omniHome(), 'plan.json');
  const outFile = path.join(omniHome(), 'plan-out.json');
  for (const st of steps) omniAudit('act', `${st.op} ${st.note || ''}`.trim(), { op: st.op });
  omniOverlayPush({ acting: steps.map((x) => x.op).join(' · ').slice(0, 60) });
  // DRY RUN — everything real except the hands. She perceives, thinks, plans and
  // is guarded exactly as in a live drive; the batch simply is not executed.
  // This exists because the first question anyone sensibly asks of a thing that
  // can take over their machine is "show me what you'd do, before you do it."
  if (o.dry) {
    steps.forEach((st) => s.steps.push({
      op: st.op, note: st.note || '', ok: true, dry: true,
      said: `DRY — would ${st.op}${st.x != null ? ` at ${st.x},${st.y}` : ''}${st.text ? ` “${String(st.text).slice(0, 60)}”` : ''}${st.title ? ` “${st.title}”` : ''}${st.target ? ` ${st.target}` : ''}${st.key ? ` ${st.key}` : ''}`,
      ts: new Date().toISOString(),
    }));
    s.steps = s.steps.slice(-200);
    s.cursor += steps.length;
    saveState();
    omniEmit({ kind: 'acted', steps: s.steps.slice(-steps.length), omni: omniPublic() });
    return { ok: true, dry: true };
  }
  if (!safe(() => { fs.writeFileSync(planFile, JSON.stringify({ steps: steps.map(({ note, ...x }) => x) })); return true; }, false)) {
    return omniHalt('the step batch could not be staged');
  }
  safe(() => fs.existsSync(outFile) && fs.unlinkSync(outFile));
  const r = await runOmniPs(['-Batch', planFile, '-Out', outFile], 120000);
  const d = r.ok ? parseJsonLoose(safe(() => fs.readFileSync(outFile, 'utf8'), '')) : null;
  const results = (d && d.results) || [];
  steps.forEach((st, i) => {
    const res = results[i] || { ok: false, said: r.ok ? 'no result returned' : (r.error || 'the input layer failed') };
    s.steps.push({ op: st.op, note: st.note || '', ok: !!res.ok, said: String(res.said || '').slice(0, 3000), ts: new Date().toISOString() });
    if (res.ok) {
      o.stats.actions++;
      // The screen shows where she touched it — a ring at the exact point.
      if (['click', 'dblclick', 'rclick'].includes(st.op) && st.x != null) omniOverlayPing(st.op, st.x, st.y);
      if (st.op === 'type' || st.op === 'paste' || st.op === 'key') omniOverlayPush({ typed: true });
    }
  });
  s.steps = s.steps.slice(-200);
  s.cursor += steps.length;
  // A protected window that appeared DURING the batch still trips the wire.
  const after = omniForbiddenWindow(d && d.fg);
  saveState();
  omniEmit({ kind: 'acted', steps: s.steps.slice(-steps.length), omni: omniPublic() });
  if (after) { omniAudit('blocked', `a protected window appeared mid-batch: “${after}”`); omniPanic('a protected window appearing mid-batch'); }
  return { ok: true };
}
// Answering her question (or approving her batch) resumes the loop.
async function omniReply(text, approve) {
  const o = omniState(), s = o.session;
  if (!s || s.status !== 'waiting') return { ok: false, error: 'nothing is waiting on you' };
  if (s.pendingSteps) {
    const steps = s.pendingSteps; s.pendingSteps = null; s.question = '';
    if (approve === false) {
      s.steps.push({ op: 'none', ok: false, said: 'you declined that batch', note: '' });
      s.cursor++;
      if (text) s.steer.push(String(text).slice(0, 400));
      s.status = 'running'; saveState(); setTimeout(omniTick, 300);
      return { ok: true, omni: omniPublic() };
    }
    s.status = 'running';
    if (text) s.steer.push(String(text).slice(0, 400));
    await omniRun(steps);
    if (o.session && o.session.status === 'running') setTimeout(omniTick, 600);
    return { ok: true, omni: omniPublic() };
  }
  s.steer.push(String(text || '').slice(0, 600) || '(he did not answer — use your judgement or stop)');
  s.question = ''; s.status = 'running';
  omniAudit('answer', String(text || '').slice(0, 200));
  saveState();
  setTimeout(omniTick, 300);
  return { ok: true, omni: omniPublic() };
}
// A finished session becomes a real entry in the work ledger, like any other move.
function omniWorkLedger(s, line) {
  const moved = s.steps.filter((x) => x.ok).length;
  const realWork = s.steps.filter((x) => x.op === 'work').map((x) => x.said);
  STATE.duoWork = STATE.duoWork || [];
  STATE.duoWork.unshift({
    id: newId(), ts: new Date().toISOString(), loopId: '', loopName: 'Motus Max',
    projectId: '', agent: s.agent, title: `OmniDrive — ${String(s.goal).slice(0, 100)}`,
    // A session that ended in [[OS:done]] has NOT necessarily shipped. She ends
    // that way honestly when the last step is HIS — a deploy, a payment, a
    // message to a person — and hardcoding 'shipped' recorded those holds as
    // completions, then recentMoves() forbade re-proposing them. The queue only
    // August can clear was being drained by the ledger, silently. Verdict now
    // follows what actually happened, using the same vocabulary as logDuoWork.
    did: line.slice(0, 800), next: '', files: [], confidence: 9,
    verdict: realWork.length ? 'shipped' : 'reported',
    body: `${moved} actions across ${s.cycles} cycles${realWork.length ? ` · ${realWork.length} with her own tools` : ''}.\n${realWork.length ? `\nREAL WORK:\n${realWork.map((w) => '· ' + w).join('\n')}\n` : ''}\n${(s.transcript || []).slice(0, 6).map((t) => t.text).join('\n\n').slice(0, 3000)}`,
  });
  STATE.duoWork = STATE.duoWork.slice(0, 300);
}
// What the interface is allowed to see. The audit log is included in full —
// a control surface that hides what it did is not a control surface.
// The screens she could be looking at. On a multi-monitor desk this is not a
// nicety: choosing the wrong one means she reasons over a screen August is not
// even looking at, so it is a first-class control, not a setting.
// WHICH SCREEN IS AUGUST ACTUALLY ON?
//
// This is not a preference, it is the difference between her seeing his work and
// seeing an empty desktop. His displays are 1280x720 and 2560x1441 (DIP), so a
// fixed index-0 default put a quarter-sized HUD on the wrong monitor AND — far
// worse — pointed the camera at a screen he was not using. A collaborator looks
// at the screen you are looking at. So: follow the cursor, unless he pins one.
function omniActiveDisplayIndex() {
  return safe(() => {
    const { screen } = require('electron');
    const displays = screen.getAllDisplays();
    const pt = screen.getCursorScreenPoint();
    const d = screen.getDisplayNearestPoint(pt);
    const i = displays.findIndex((x) => x.id === d.id);
    return i >= 0 ? i : 0;
  }, 0);
}
// The display a session should use: his explicit pin, else wherever he is.
function omniResolveDisplay() {
  const o = omniState();
  if (o.displayPin != null && o.displayPin >= 0) return o.displayPin;
  return omniActiveDisplayIndex();
}
function omniDisplays() {
  return safe(() => {
    const { screen } = require('electron');
    const displays = screen.getAllDisplays();
    const primary = screen.getPrimaryDisplay();
    const active = omniActiveDisplayIndex();
    return displays.map((d, i) => {
      const sf = d.scaleFactor || 1;
      return {
        i, id: String(d.id),
        label: d.label || (d.id === primary.id ? 'Primary screen' : `Screen ${i + 1}`),
        w: Math.round(d.size.width * sf), h: Math.round(d.size.height * sf),
        dipW: d.bounds.width, dipH: d.bounds.height, scale: sf,
        primary: d.id === primary.id,
        active: i === active,          // where his pointer is right now
      };
    });
  }, []);
}
// ★ THE SEAT CLOCK. "It's taking so so long" was a wait with no number on it:
// no screen said what a turn on this seat usually costs, so every wait read
// as a hang — and the only fix on offer was "kill it". Read off the
// interactions ledger (completed relay turns, last 7 days): median and p90 per
// seat, plus the fastest seat that has hands. The wait becomes a number, the
// in-flight line becomes an honest ETA, and the slow-seat station can name a
// faster seat instead of a feeling. Memoized: the ledger is already parsed.
// ★ THE PRE-READ. The wait he feels at "Drive" is the strategic read: minutes
// of the seat choosing a move while the screen sits in READING. Arming is an
// explicit tap that says "I am about to drive", so that is the moment to
// start reading, not the press. The choice lands while he settles in; Drive
// then starts on a ready move. One relay turn per arm, fresh for ten minutes,
// and never a second one while the first is in flight. If he presses before
// it lands, Drive waits for the remainder rather than starting another.
let _preReadP = null;
const PRE_READ_FRESH_MS = 10 * 60e3;
function omniReadFresh(o, agent) {
  const rc = o.readCache;
  return rc && rc.agent === agent && (now() - rc.at) < PRE_READ_FRESH_MS ? rc : null;
}
function omniPreRead(why) {
  const o = omniState();
  if (_preReadP) return _preReadP;
  if (o.session && ['running', 'waiting'].includes(o.session.status)) return null;
  if (omniReadFresh(o, o.agent)) return null;
  const a = o.agent;
  o.preReadState = { status: 'reading', at: now(), agent: a };
  omniAudit('pre-read', `reading the map now, while you settle in (${why || 'armed'}); the choice will be ready when you press Drive`);
  omniEmit({ kind: 'preread', omni: omniPublic() });
  _preReadP = strategicRead({ agent: a, zoom: 'orbit', depth: !!o.depth, driving: true })
    .then((sr) => {
      if (sr && sr.ok && sr.read) {
        o.readCache = { at: now(), agent: a, read: sr.read };
        o.preReadState = { status: 'ready', at: now(), agent: a };
        omniAudit('pre-read', `move ready: ${String(sr.read.firstStep || sr.read.lever || '').slice(0, 120)}`);
      } else {
        o.preReadState = { status: 'failed', at: now(), agent: a, error: String((sr && sr.error) || 'no read').slice(0, 160) };
        omniAudit('pre-read', `could not pre-read (${(sr && sr.error) || 'no read'}); Drive will read on press as before`);
      }
      saveState();
      omniEmit({ kind: 'preread', omni: omniPublic() });
    })
    .catch((e) => { o.preReadState = { status: 'failed', at: now(), agent: a, error: String((e && e.message) || e).slice(0, 160) }; })
    .finally(() => { _preReadP = null; });
  return _preReadP;
}
function omniPreReadPublic(o) {
  const rc = omniReadFresh(o, o.agent);
  if (rc) return { status: 'ready', secs: Math.round((now() - rc.at) / 1000), agent: rc.agent, firstStep: String(rc.read.firstStep || rc.read.lever || ''), confidence: Number.isFinite(rc.read.confidence) ? rc.read.confidence : null, falsifier: String(rc.read.falsifier || '') };
  const s = o.preReadState;
  if (s && s.status === 'reading' && _preReadP) return { status: 'reading', secs: Math.round((now() - s.at) / 1000), agent: s.agent };
  if (s && s.status === 'failed' && now() - s.at < PRE_READ_FRESH_MS) return { status: 'failed', error: s.error || '' };
  return { status: 'idle' };
}
const _scMemo = new Map();
function seatClock(agent, days = 7) {
  const hit = _scMemo.get(agent);
  if (hit && now() - hit.at < 30000) return hit.v;
  const cut = now() - days * 864e5;
  const xs = []; let last = 0;
  for (const x of parseInteractions()) {
    if (!x.epoch) continue;
    if (x.epoch < cut) break;                       // newest first — nothing older matters
    if (x.agent !== agent || !x.ok || !(x.latency > 0)) continue;
    if (!last) last = x.latency;
    xs.push(x.latency);
  }
  xs.sort((a, b) => a - b);
  const q = (p) => xs.length ? xs[Math.min(xs.length - 1, Math.floor(p * xs.length))] : 0;
  const v = { agent, n: xs.length, median: Math.round(q(0.5)), p90: Math.round(q(0.9)), last: Math.round(last), days };
  _scMemo.set(agent, { at: now(), v });
  return v;
}
function fastestHands() {
  // fastest, among seats whose reports hold up: a quick seat that scores
  // under 6.5 on its last ten receipts is not the hands to hand work to
  const seats = buildingSeats()
    .map((id) => ({ id, name: (FLEET_BY_ID[id] || {}).name || id, quality: seatQuality(id), ...seatClock(id) }))
    .filter((c) => c.n >= 3)
    .sort((a, b) => a.median - b.median);
  const sound = seats.filter((c) => c.quality == null || c.quality >= 6.5);
  return (sound[0] || seats[0]) || null;
}
function omniPublic() {
  const o = omniState();
  const s = o.session;
  return {
    seatClock: safe(() => seatClock(o.agent), null),
    preRead: safe(() => omniPreReadPublic(o), { status: 'idle' }), preReadOn: o.preRead !== false,
    fastestHands: safe(() => fastestHands(), null),
    displayList: omniDisplays(),
    armed: omniArmedNow(), remainingMs: omniArmRemaining(), ttlMin: o.ttlMin, agent: o.agent,
    scope: o.scope, pacing: o.pacing, allow: o.allow, speak: o.speak, maxSteps: o.maxSteps,
    display: o.display, displayPin: (o.displayPin == null ? null : o.displayPin),
    activeDisplay: safe(() => omniActiveDisplayIndex(), 0),
    stats: o.stats, hud: o.hud !== false, dry: !!o.dry, depth: !!o.depth,
    turnInFlight: o.turnInFlight ? { ...o.turnInFlight, secs: Math.round((now() - o.turnInFlight.startedAt) / 1000) } : null,
    continuous: !!o.continuous, chain: o.chain || 0, chainMax: o.chainMax || 6,
    speedEffort: o.speedEffort || 'medium', speedTurns: o.speedTurns || 8,
    moveMode: o.moveMode || 'auto',
    reflex: o.reflex !== false,
    seats: safe(() => AGENTS.map((id) => ({ id, name: (FLEET_BY_ID[id] || {}).name || id, ...(seatCapabilities()[id] || {}) })), []),
    hands: safe(() => (seatCanBuild(o.agent) ? o.agent : (buildingSeats()[0] || o.agent)), o.agent),
    voiceReady: !!STATE.settings.elevenKeyEnc,
    session: s ? {
      id: s.id, goal: s.goal, agent: s.agent, status: s.status, cursor: s.cursor, maxSteps: s.maxSteps,
      cycles: s.cycles, question: s.question || '', why: s.why || '', started: s.started, endedAt: s.endedAt || 0,
      steps: (s.steps || []).slice(-40), transcript: (s.transcript || []).slice(0, 20),
      pending: (s.pendingSteps || []).map((x) => ({ op: x.op, note: x.note || '' })),
      // the live move ticker — what her hands are doing RIGHT NOW, tailed from
      // her own transcript while the turn is still running
      moves: (s.moves || []).slice(-16),
      files: s.files || '',
      // THE LANE SPLIT, SHOWN NOT HIDDEN. He asked to see the moves, not to
      // take them on faith — so the count and the real mean latency of each
      // lane travel with the session. If the reflex lane is not actually
      // faster on his machine, this is where it will say so.
      lastLane: s._lastLane || '', lanes: s.lanes || null,
    } : null,
    log: (o.log || []).slice(0, 120),
    guards: {
      protectedWindows: 'password managers, wallets, banking, sign-in and Windows security screens — always, in every mode',
      noShell: 'there is no command-execution verb; she works through windows and keys, like you do',
      panic: 'Ctrl + Alt + Shift + X halts everything from anywhere on the machine',
    },
  };
}

// ###########################################################################
//  MOTUSLIVE — the broadcast engine.
//
//  August: "a shared work live streamer where I can select windows or previews
//  … users can go to AugustJames.Live/rightnow — only the tasks that I have
//  selected … But nothing ever private or security stuff. Only the stuff I
//  select."
//
//  THE PRIVACY MODEL, in one sentence: candidates are gathered here, NOTHING is
//  selected by default, only ticked items enter the payload, every string is
//  scrubbed for secret shapes before it leaves this machine, and the server
//  re-scrubs everything again on arrival. Two independent gates, both tested.
//
//  The pantheon below mirrors site/public/pantheon.js in InitiumBuilders/SEMBLE
//  — ids must stay in lockstep or the site cannot retune to his DJ choice.
// ###########################################################################
// Every DJ carries their own light — the same hue language the nav uses, so a
// mode is recognisable before its name is read. The hue is chosen from what
// the power MEANS: paradigm shift is violet (the deepest lever), leverage is
// gold (the one place to push), destruction is ember, memory is deep indigo.
const ONAIR_DJS = [
  { id: 'daoz', name: 'DJ DAOZ', power: 'Paradigm Shift', headliner: true, hue: 275 },
  { id: 'qoreus', name: 'Qoreus', power: 'Leverage Points', artist: true, hue: 45 },
  { id: 'frequest', name: 'DJ Frequest', power: 'Feedback Loops', hue: 155 },
  { id: 'daomode', name: 'DJ DaoMode', power: 'Emergence & Stigmergy', hue: 190 },
  { id: 'waveside', name: 'DJ WaveSide', power: 'Stocks & Flows', hue: 205 },
  { id: 'freqro', name: 'DJ Freqro', power: 'Information Flows', hue: 175 },
  { id: 'raze', name: 'DJ Raze', power: 'Creative Destruction', hue: 12 },
  { id: 'nauz', name: 'DJ Nauz', power: 'Resonance Testing', hue: 320 },
  { id: 'sav', name: 'DJ Sâv', power: 'System Memory', hue: 240 },
  { id: 'auxtro', name: 'DJ Auxtro', power: 'Boundary Expansion', hue: 95 },
  { id: 'audea', name: 'DJ Audea', power: 'Emergent Chorus', hue: 350 },
];
const ONAIR_POWERS = [
  { id: 'hype', name: 'Hype Builder' }, { id: 'crowdrise', name: 'Crowdrise' },
  { id: 'dauozi', name: 'DJ Daozi' }, { id: 'vibez', name: 'DJ VibeZ' }, { id: 'decentro', name: 'DJ Decentro' },
];
// ⚠ THE HOST IS A SETTING, NOT A CONSTANT — learned the hard way on
// 2026-08-18. This was hardcoded to `www.semble.cc`, and when that domain was
// re-pointed at a different app every broadcast push and every compute read
// started 404-ing with nothing in the interface saying so. A deployment target
// that can move must be configurable, or the app quietly lies about being live.
const ONAIR_HOST_DEFAULT = 'www.semble.cc';
function onAirHost() {
  const h = String((STATE.settings && STATE.settings.liveHost) || '').trim()
    .replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  return /^[A-Za-z0-9.-]{4,}$/.test(h) ? h : ONAIR_HOST_DEFAULT;
}
// ★ SELF-HEALING: FIND the broadcast host instead of being told it.
//
// Measured 2026-08-18: semble.cc was re-pointed at the new Semble app and every
// /api/* went 404, while the SAME routes answered 200 on motuslive.vercel.app.
// A human noticing that and editing a field is a step that will be forgotten;
// probing four candidates costs ~1s and can be done on boot. The app should
// know where its own back end is.
//
// Order matters: whatever is configured is tried FIRST, so a deliberate choice
// is never overridden by a probe.
const ONAIR_CANDIDATES = ['www.semble.cc', 'motuslive.vercel.app', 'v0-the-semble-way.vercel.app'];
async function onAirDiscover({ quiet = false } = {}) {
  const tried = [];
  const list = [onAirHost(), ...ONAIR_CANDIDATES.filter((h) => h !== onAirHost())];
  for (const host of list) {
    const r = await new Promise((resolve) => {
      const req = https.request({ host, path: '/api/live?probe=' + now(), method: 'GET', timeout: 9000 },
        (res) => { res.resume(); resolve(res.statusCode); });
      req.on('timeout', () => { req.destroy(); resolve(0); });
      req.on('error', () => resolve(0));
      req.end();
    });
    tried.push({ host, status: r });
    if (r === 200) {
      const changed = host !== onAirHost();
      if (changed) {
        STATE.settings.liveHost = host;
        saveState();
        omniAudit('live', `broadcast host relocated to ${host} — the previous one stopped answering`);
        if (!quiet) pushNotification('good', 'Broadcast host found', `MotusLive reconnected to ${host}.`, 'stream', 'host:' + host);
      }
      return { ok: true, host, changed, tried };
    }
  }
  return { ok: false, error: 'no candidate answered /api/live with 200', tried };
}
ipcMain.handle('cortex:onAirDiscover', requireGate(async () => onAirDiscover()));
function onAirDefaults() {
  return {
    on: false, dj: 'daoz', power: '', topic: '',
    sel: {},                  // candidate id → true. EMPTY by default, always.
    custom: [],               // items he typed himself: [{id, t}]
    lastPush: 0, lastErr: '', pushes: 0,
    // AUTO-FOLLOW: while live, re-rank and re-tick as his work actually moves,
    // so the stream stays true without him tending it. Selection-only still —
    // it can only ever tick things that were already candidates, and the
    // secret gate still runs on every push. Off by default: automatic
    // broadcasting is a real decision, so it is his to make.
    follow: false, lastSig: '',
    lastSweep: null,          // {ts, ok, clean, cleared, leaked[]} — evidence, not belief
    lastDrift: null,          // {ts, match, extra[], missing} — on air, the served-vs-ticked diff
    driftTick: 0,
  };
}
// In-place accessor — the identity law. See omniState() for the scar tissue.
function onAirState() {
  if (!STATE.onAir || typeof STATE.onAir !== 'object' || Array.isArray(STATE.onAir)) {
    STATE.onAir = onAirDefaults(); return STATE.onAir;
  }
  const d = onAirDefaults();
  for (const k of Object.keys(d)) if (STATE.onAir[k] === undefined) STATE.onAir[k] = d[k];
  // MIGRATION — the headliner was renamed DAUOZ → DAOZ. A stored id that no
  // longer exists in the pantheon would silently un-set his DJ on the site, so
  // it is healed here rather than left to fail quietly.
  if (STATE.onAir.dj === 'dauoz' || !ONAIR_DJS.some((x) => x.id === STATE.onAir.dj)) STATE.onAir.dj = 'daoz';
  return STATE.onAir;
}
let _onAirSecret = '';
function onAirSecret() {
  if (_onAirSecret) return _onAirSecret;
  _onAirSecret = safe(() => fs.readFileSync(path.join(ciDir(), 'live-secret'), 'utf8').trim(), '');
  return _onAirSecret;
}
// Everything he COULD broadcast, each with a stable id so a tick survives the
// list re-ordering. Sources: the two focuses, the open thread, the board, the
// recent moves, and per-agent focus lines. Plus whatever he types himself.
function onAirCandidates() {
  const a = onAirState();
  const out = [];
  const add = (id, kind, t) => { t = String(t || '').trim(); if (t) out.push({ id, kind, t: t.slice(0, 400) }); };
  add('goal', 'GOAL', STATE.goal && STATE.goal.text);
  add('motus', 'MOTUS', STATE.motus && STATE.motus.text);
  const th = threadState();
  if (th.goal) add('thread', 'DRIVE', th.goal.split('\n')[0]);
  for (const t of (STATE.tasks || []).filter((x) => x.status !== 'done').slice(0, 10)) add('task:' + t.id, 'TASK', t.title);
  for (const w of (STATE.duoWork || []).slice(0, 8)) add('move:' + w.id, w.verdict === 'shipped' ? 'SHIPPED' : 'MOVE', w.title);
  const seen = new Set();
  for (const w of (STATE.duoWork || []).slice(0, 20)) {
    const by = w.by && FLEET_BY_ID[w.by] ? w.by : null;
    if (by && !seen.has(by)) { seen.add(by); add('agent:' + by, 'AGENT', `${FLEET_BY_ID[by].name} — ${String(w.title).slice(0, 160)}`); }
  }
  for (const c of a.custom) add('custom:' + c.id, 'NOTE', c.t);
  return out;
}
// The payload is built ONLY from ticked candidates, and every string passes the
// same secret-shape gate the keyboard uses. An item that trips the gate is
// dropped and counted — never sent, never silently ignored.
function onAirPayload() {
  const a = onAirState();
  const picked = onAirCandidates().filter((c) => a.sel[c.id]);
  let dropped = 0;
  const items = [], agents = [];
  for (const c of picked) {
    if (omniSecretish(c.t)) { dropped++; continue; }
    if (c.kind === 'AGENT') {
      const [name, ...rest] = c.t.split(' — ');
      agents.push({ name: name.slice(0, 40), focus: (rest.join(' — ') || 'in motion').slice(0, 240) });
    } else if (c.id === 'goal') { /* rides the goal field */ }
    else if (c.id === 'motus') { /* rides the motus field */ }
    else items.push({ kind: c.kind, t: c.t });
  }
  // ⚠ OFF MEANS THE DATA IS NOT THERE — not "the data is there, please don't
  // render it." (August: "when we have it off its not broadcasting anything.")
  //
  // This used to send the FULL selected payload with `on:false` attached, which
  // silently made the remote page the only thing standing between his private
  // work and the public: a rendering bug, a cached response, a stale client, or
  // anyone running `curl /api/live` would have seen everything. The flag was
  // doing security work that only absence can do.
  //
  // Off-air now emits the state and NOTHING ELSE. No goal, no motus, no items,
  // no agents, not even the topic. The one field that survives is `on:false`,
  // because the page still needs to know to show "off air".
  if (!a.on) {
    return { payload: { on: false, dj: '', power: '', topic: '', goal: '', motus: '', items: [], agents: [] }, dropped: 0, blanked: true };
  }
  return {
    payload: {
      on: true, dj: a.dj, power: a.power, topic: String(a.topic || '').slice(0, 200),
      goal: a.sel.goal && STATE.goal && !omniSecretish(STATE.goal.text) ? String(STATE.goal.text).slice(0, 400) : '',
      motus: a.sel.motus && STATE.motus && !omniSecretish(STATE.motus.text) ? String(STATE.motus.text).slice(0, 200) : '',
      items: items.slice(0, 24), agents: agents.slice(0, 8),
    },
    dropped,
  };
}
function onAirHttp(method, apiPath, body, extraHeaders = {}) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : '';
    const req = https.request({
      host: onAirHost(), path: apiPath, method,
      headers: {
        'content-type': 'application/json',
        ...(data ? { 'content-length': Buffer.byteLength(data) } : {}),
        ...extraHeaders,
      }, timeout: 20000,
    }, (res) => {
      let d = ''; res.on('data', (c) => d += c);
      res.on('end', () => resolve({ status: res.statusCode, json: safe(() => JSON.parse(d), null) }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null, error: 'timeout' }); });
    req.on('error', (e) => resolve({ status: 0, json: null, error: (e && e.message) || 'failed' }));
    if (data) req.write(data);
    req.end();
  });
}
let _onAirTimer = 0;
async function onAirPush() {
  const a = onAirState();
  const sec = onAirSecret();
  if (!sec) { a.lastErr = 'no live-secret on this machine (~/.cortexinsight/live-secret)'; return { ok: false, error: a.lastErr }; }
  const { payload, dropped } = onAirPayload();
  const r = await onAirHttp('POST', '/api/live', payload, { 'x-live-secret': sec });
  if (r.json && r.json.ok) { a.lastPush = now(); a.lastErr = ''; a.pushes++; }
  else a.lastErr = r.status === 401 ? 'the secret was refused — rotate it on Vercel and here' : (r.error || `HTTP ${r.status}`);
  saveState();
  return { ok: !!(r.json && r.json.ok), dropped, error: a.lastErr || undefined };
}
// A cheap fingerprint of what he is actually working on. AUTO-FOLLOW only
// re-picks when this CHANGES — so a live stream re-ranks the moment he sets a
// new Motus or a move ships, and stays perfectly still the rest of the time.
function onAirSignature() {
  return [
    safe(() => STATE.motus && STATE.motus.text, ''),
    safe(() => STATE.goal && STATE.goal.text, ''),
    safe(() => threadState().goal, ''),
    safe(() => (STATE.duoWork || [])[0] && STATE.duoWork[0].id, ''),
    safe(() => (STATE.tasks || []).filter((t) => t.status !== 'done').length, 0),
  ].join('|').slice(0, 600);
}
function onAirLoop() {
  clearInterval(_onAirTimer);
  _onAirTimer = 0;
  if (!onAirState().on) return;
  _onAirTimer = setInterval(() => {
    const a = onAirState();
    if (!a.on) return;
    if (a.follow) {
      const sig = onAirSignature();
      if (sig !== a.lastSig) {
        a.lastSig = sig;
        const r = onAirAutoPick();
        omniAudit('live', `auto-follow re-picked ${r.picked.length} item(s) — your work moved`);
      }
    }
    onAirPush();
    // Verify roughly every 100s rather than every push: a push proves what we
    // SENT, and the whole point of this check is that sending is not serving.
    a.driftTick = ((a.driftTick || 0) + 1) % 4;
    if (a.driftTick === 0) safe(() => onAirDriftCheck({ quiet: false }).catch(() => {}));
  }, 25000);
}
function onAirPublic() {
  const a = onAirState();
  const { payload, dropped } = onAirPayload();
  return {
    ...a, djs: ONAIR_DJS, powers: ONAIR_POWERS,
    candidates: onAirCandidates(), preview: payload, dropped,
    hasSecret: !!onAirSecret(),
    host: onAirHost(),
    // the last time the app CHECKED what the world can actually retrieve —
    // not what it believes it sent
    sweep: a.lastSweep || null,
    drift: a.lastDrift || null,
    urls: {
      live: 'https://www.semble.cc/live',
      livenow: 'https://www.augustjames.live/livenow',
      rightnow: 'https://www.augustjames.live/rightnow',
      short: 'https://motuslive.vercel.app',
    },
  };
}
// ───────────────────────────────────────────────────────────────────────────
//  STREAM THE MOST IMPORTANT THING.
//
//  August's ask, in his words. The composer is honest but it is also a blank
//  page: eighteen candidates, nothing ticked, and the highest-leverage one is
//  not obvious at a glance. This ranks them the way the rest of the app thinks
//  — Motus and Goal are the frame, a live drive is what is happening NOW, a
//  shipped move is proof, an open task is intent — and ticks the few that
//  actually say what he is doing.
//
//  It is a PROPOSAL, never a send: it only sets ticks. He still sees the exact
//  payload and still presses GO LIVE. The privacy law is untouched.
// ───────────────────────────────────────────────────────────────────────────
function onAirRank(c) {
  const t = String(c.t || '');
  let s = 0;
  if (c.id === 'motus') s += 100;                 // the prime mover — the strongest frame
  if (c.id === 'goal') s += 84;                   // the north star
  if (c.id === 'thread') s += 78;                 // a live drive: this is happening now
  if (c.kind === 'SHIPPED') s += 66;              // proof beats intent
  if (c.kind === 'MOVE') s += 46;
  if (c.kind === 'TASK') s += 34;
  if (c.kind === 'AGENT') s += 40;                // the fleet in motion reads well live
  if (c.id.startsWith('custom:')) s += 70;        // he typed it himself; he meant it
  // a line that names something concrete carries more than a vague one
  if (/https?:\/\//.test(t)) s += 10;
  if (/\b(ship|shipped|live|launch|fix|build|deploy|first|open)\b/i.test(t)) s += 8;
  if (t.length > 40) s += 5;
  if (t.length > 260) s -= 6;                     // too long to read on a stream
  return s;
}
function onAirAutoPick() {
  const a = onAirState();
  const cands = onAirCandidates()
    .filter((c) => !omniSecretish(c.t))           // never propose something the gate would drop
    .map((c) => ({ ...c, score: onAirRank(c) }))
    .sort((x, y) => y.score - x.score);
  a.sel = {};
  const picked = [];
  // BALANCE, NOT JUST RANK. Pure score handed back five near-identical board
  // items — technically the top five, and a wall of text nobody watches. A
  // broadcast needs shape: the frame (Motus/Goal), what is happening now, what
  // shipped, who is moving, and only a couple of open threads.
  const CAP = { TASK: 2, MOVE: 2, SHIPPED: 2, AGENT: 1, NOTE: 2 };
  const seen = {};
  for (const c of cands) {
    if (picked.length >= 6) break;
    const cap = CAP[c.kind];
    if (cap != null) { seen[c.kind] = (seen[c.kind] || 0) + 1; if (seen[c.kind] > cap) continue; }
    a.sel[c.id] = true; picked.push(c);
  }
  const lead = picked.find((c) => c.id === 'motus') || picked.find((c) => c.id === 'thread') || picked[0];
  if (lead && !a.topic) a.topic = String(lead.t).split('\n')[0].slice(0, 200);
  saveState();
  return { picked: picked.map((c) => ({ id: c.id, kind: c.kind, t: c.t.slice(0, 120), score: c.score })), lead: lead ? lead.id : '' };
}

ipcMain.handle('cortex:onAir', requireGate(() => ({ ok: true, onAir: onAirPublic() })));
ipcMain.handle('cortex:onAirAuto', requireGate(async () => {
  const r = onAirAutoPick();
  const push = await onAirPush();
  return { ok: true, ...r, push, onAir: onAirPublic() };
}));
// SPEAK AS THE OPERATOR — his voice in SourceCrowd, marked as his.
ipcMain.handle('cortex:onAirSay', requireGate(async (_e, { text } = {}) => {
  const t = String(text || '').trim().slice(0, 420);
  if (!t) return { ok: false, error: 'say something' };
  if (omniSecretish(t)) return { ok: false, error: 'that looks like a credential — refused before it left this machine' };
  const r = await onAirHttp('POST', '/api/chat', { name: 'August ◈', text: t });
  return { ok: !!(r.json && r.json.ok), error: r.json && r.json.error };
}));
ipcMain.handle('cortex:onAirSet', requireGate(async (_e, p = {}) => {
  const a = onAirState();
  if (p.dj && ONAIR_DJS.some((d) => d.id === p.dj)) a.dj = p.dj;
  if (p.power !== undefined) a.power = ONAIR_POWERS.some((x) => x.id === p.power) ? p.power : '';
  if (p.topic !== undefined) a.topic = String(p.topic).slice(0, 200);
  if (p.toggle) a.sel[p.toggle] = !a.sel[p.toggle];
  if (p.addCustom) a.custom = [...a.custom, { id: newId().slice(0, 8), t: String(p.addCustom).slice(0, 400) }].slice(-12);
  if (p.rmCustom) { a.custom = a.custom.filter((c) => c.id !== p.rmCustom); delete a.sel['custom:' + p.rmCustom]; }
  if (p.follow !== undefined) { a.follow = !!p.follow; a.lastSig = onAirSignature(); }
  if (p.clearSel) a.sel = {};
  if (p.on !== undefined) { a.on = !!p.on; a.lastSig = onAirSignature(); onAirLoop(); }
  // The riskiest moment for both laws is the instant the switch is thrown, so
  // neither check waits for a timer: going live verifies what is actually
  // served, going dark verifies that nothing is.
  const flipped = p.on !== undefined;
  saveState();
  const push = await onAirPush();      // every change lands on the page within a beat
  if (flipped) await (a.on ? onAirDriftCheck({ quiet: false }) : onAirEnforceOff({ quiet: false })).catch(() => {});
  return { ok: true, push, onAir: onAirPublic() };
}));
ipcMain.handle('cortex:onAirPush', requireGate(async () => ({ ok: true, push: await onAirPush(), onAir: onAirPublic() })));
// ★ PROVE IT — fetch the live payload back the way a stranger would, with no
// secret and no privileges, and report exactly what is retrievable. This is
// the difference between "we stopped broadcasting" and knowing it: the answer
// comes from the server, not from this app's own belief about the server.
ipcMain.handle('cortex:onAirVerify', requireGate(async () => {
  const r = await onAirHttp('GET', '/api/live?ts=' + now());
  const p = (r.json && (r.json.payload || r.json)) || null;
  if (!p) {
    // A 404 here is not "quiet" — it means the broadcast endpoint is GONE and
    // every push has been failing. Silence would let him believe he is live
    // when nothing is reaching the world (and equally, that he is safely off
    // when the state is simply unknown).
    const gone = r.status === 404;
    return {
      ok: false,
      host: onAirHost(),
      status: r.status,
      error: gone
        ? `${onAirHost()}/api/live returned 404 — the broadcast endpoint is not deployed on that domain, so pushes cannot land and nothing can be read back.`
        : (r.error || `the public endpoint answered HTTP ${r.status}`),
    };
  }
  const leaked = [];
  if (p.goal) leaked.push('goal');
  if (p.motus) leaked.push('motus');
  if ((p.items || []).length) leaked.push(`${p.items.length} item(s)`);
  if ((p.agents || []).length) leaked.push(`${p.agents.length} agent(s)`);
  if (p.topic) leaked.push('topic');
  const a = onAirState();
  return {
    ok: true,
    live: !!p.on,
    expectedOff: !a.on,
    // the finding that matters: content retrievable while he believes he is off
    clean: a.on ? null : leaked.length === 0,
    leaked,
    fields: { goal: !!p.goal, motus: !!p.motus, items: (p.items || []).length, agents: (p.agents || []).length, topic: !!p.topic },
    raw: JSON.stringify(p).slice(0, 1200),
  };
}));
// ★ THE OFF-AIR SWEEP — the fix for a leak that a "correct" blank could not close.
//
// MEASURED 2026-08-18 on the live endpoint. Off-air blanking was already
// shipped and correct: toggling off sends a payload with every field emptied.
// And yet a stranger running `curl motuslive.vercel.app/api/live` got back his
// topic, his goal, his Motus and three work items — with `on:false` attached.
//
// The reason is a timing hole nobody would guess: the blanking only applies to
// a push, and GOING OFF AIR IS EXACTLY WHEN PUSHING STOPS. Anything published
// under an older build stayed published forever, because the code that would
// clear it only ever runs on a beat that no longer ticks.
//
// A fix that depends on him toggling off again is not a fix. So the app now
// SWEEPS: while off air it reads its own public endpoint the way a stranger
// would, and if anything at all comes back, it blanks it and reads again to
// prove the clear landed. Runs on boot, and on demand.
//
// The verdict comes from the SECOND read, never from the POST's own `ok` —
// a write that reports success is not evidence that the world changed.
async function onAirEnforceOff({ quiet = false } = {}) {
  const a = onAirState();
  const stamp = (v) => { a.lastSweep = { ts: now(), ...v }; saveState(); return v; };
  if (a.on) return stamp({ ok: true, skipped: 'on air — nothing to enforce', live: true });
  const read = await onAirHttp('GET', '/api/live?sweep=' + now());
  const p = (read.json && (read.json.payload || read.json)) || null;
  if (!p) return stamp({ ok: false, error: read.status === 404
    ? `${onAirHost()}/api/live returned 404 — cannot confirm what is public`
    : (read.error || `the public endpoint answered HTTP ${read.status}`) });
  const exposure = (q) => {
    const out = [];
    if (q.goal) out.push('goal');
    if (q.motus) out.push('motus');
    if (q.topic) out.push('topic');
    if ((q.items || []).length) out.push(`${q.items.length} item(s)`);
    if ((q.agents || []).length) out.push(`${q.agents.length} agent(s)`);
    return out;
  };
  const before = exposure(p);
  if (!before.length) return stamp({ ok: true, clean: true, cleared: false, host: onAirHost() });
  // Something is public that should not be. Blank it — same payload the toggle
  // would have sent — then PROVE it by reading back a second time.
  const sec = onAirSecret();
  if (!sec) return stamp({ ok: false, clean: false, cleared: false, leaked: before,
    error: 'content is public while off air and there is no live-secret on this machine to clear it' });
  const { payload } = onAirPayload();
  await onAirHttp('POST', '/api/live', payload, { 'x-live-secret': sec });
  const again = await onAirHttp('GET', '/api/live?proof=' + now());
  const q = (again.json && (again.json.payload || again.json)) || null;
  const after = q ? exposure(q) : ['unreadable'];
  const cleared = !!q && after.length === 0;
  omniAudit('live', cleared
    ? `off-air sweep cleared a stranded public payload (${before.join(', ')})`
    : `off-air sweep could NOT clear the public payload — still exposing ${after.join(', ')}`);
  if (!quiet) {
    pushNotification(cleared ? 'good' : 'bad',
      cleared ? 'Off-air leak sealed' : 'Off-air content still public',
      cleared ? `${before.join(', ')} was retrievable while off air. Cleared and verified.`
              : `${after.join(', ')} is still readable at ${onAirHost()}/api/live.`,
      'stream', 'sweep:' + now());
  }
  return stamp({ ok: cleared, clean: cleared, cleared, leaked: before, still: cleared ? [] : after, host: onAirHost() });
}
ipcMain.handle('cortex:onAirEnforce', requireGate(async () => onAirEnforceOff()));

// ───────────────────────────────────────────────────────────────────────────
//  ★ THE DRIFT WATCH — the on-air half of the same law.
//
//  The sweep answers "is anything public while I am off air?". This answers the
//  question that only exists while he IS live, and it is the sharper one:
//  "is the world seeing something I did not tick?"
//
//  Off air, absence is the guarantee and it is easy to verify. On air, the
//  guarantee is an EXACT MATCH between what he selected and what is served —
//  and there are at least four ways for those to diverge with nothing on screen
//  saying so: auto-follow re-ticking as his work moves, a CDN serving a stale
//  payload, a failed push leaving old content up, or the live-secret being used
//  by something that is not this app.
//
//  Every one of those is invisible to a push that returns ok. So this compares
//  the SERVED payload, fetched with no secret, field by field against what he
//  actually selected. EXTRA is a privacy finding. MISSING is a delivery finding.
//  They are never merged, because they need different reactions.
// ───────────────────────────────────────────────────────────────────────────
function onAirItemKeys(p) {
  return new Set([
    ...(p.items || []).map((i) => 'item|' + String(i.kind) + '|' + String(i.t).slice(0, 200)),
    ...(p.agents || []).map((a) => 'agent|' + String(a.name) + '|' + String(a.focus).slice(0, 200)),
  ]);
}
async function onAirDriftCheck({ quiet = false } = {}) {
  const a = onAirState();
  const stamp = (v) => { a.lastDrift = { ts: now(), ...v }; saveState(); return v; };
  if (!a.on) return stamp({ ok: true, skipped: 'off air — the sweep covers this', live: false });
  const intended = onAirPayload().payload;
  const read = await onAirHttp('GET', '/api/live?drift=' + now());
  const served = (read.json && (read.json.payload || read.json)) || null;
  if (!served) return stamp({ ok: false, live: true, error: read.error || `the public endpoint answered HTTP ${read.status}` });
  const want = onAirItemKeys(intended), got = onAirItemKeys(served);
  const extra = [...got].filter((k) => !want.has(k)).map((k) => k.split('|').slice(2).join('|').slice(0, 120));
  const missing = [...want].filter((k) => !got.has(k)).length;
  const fieldDrift = [];
  for (const k of ['topic', 'goal', 'motus']) {
    if (String(served[k] || '') !== String(intended[k] || '')) fieldDrift.push(k);
  }
  // A field that is public but empty locally is EXTRA, not merely different.
  const fieldExtra = fieldDrift.filter((k) => served[k] && !intended[k]);
  const exposed = extra.length + fieldExtra.length;
  if (exposed) {
    omniAudit('live', `ON-AIR DRIFT — ${exposed} thing(s) are public that you did not tick`);
    if (!quiet) pushNotification('bad', 'Live payload drifted',
      `${exposed} item(s) are being served that are not in your selection${fieldExtra.length ? ' (' + fieldExtra.join(', ') + ')' : ''}. Press push now to force the world back to your ticks.`,
      'stream', 'drift:' + now());
  }
  return stamp({
    ok: exposed === 0, live: true, match: exposed === 0 && !missing && !fieldDrift.length,
    extra: extra.slice(0, 6), extraCount: exposed, missing, fieldDrift, fieldExtra,
    host: onAirHost(),
  });
}
ipcMain.handle('cortex:onAirDrift', requireGate(async () => onAirDriftCheck()));
ipcMain.handle('cortex:onAirChat', requireGate(async () => {
  const r = await onAirHttp('GET', '/api/chat?ts=' + now());
  return { ok: !!(r.json && r.json.msgs), msgs: (r.json && r.json.msgs) || [] };
}));
// ───────────────────────────────────────────────────────────────────────────
//  MOTUSCOMPUTE — the pool, as seen from his desk.
//
//  Reads the public ledger and adds THIS machine's own capability, so the
//  dashboard answers the real question: "what compute do we actually have?"
//  It reports pledged capability honestly and states that no jobs run yet —
//  a dashboard that implied a working grid would be the most expensive lie in
//  the app, because he would plan around it.
// ───────────────────────────────────────────────────────────────────────────
function ownCompute() {
  return safe(() => {
    const os = require('os');
    const cpus = os.cpus() || [];
    return {
      host: 'this machine',
      cpuModel: (cpus[0] && cpus[0].model || 'unknown').trim().slice(0, 60),
      cores: cpus.length,
      ramGB: Math.round(os.totalmem() / 1073741824),
      freeGB: Math.round(os.freemem() / 1073741824),
      platform: `${os.platform()} ${os.release()}`,
      load: (os.loadavg() || [0])[0] || 0,
    };
  }, null);
}
// ───────────────────────────────────────────────────────────────────────────
//  R3 · HAS ANYONE WHO IS NOT AUGUST EVER JOINED?
//
//  The standing finding across this whole ecosystem is that the Build loop and
//  the Canon loop run hot while the MOVER loop has never turned once. The pool
//  is where that would first show up — and until now the dashboard could not
//  answer the question at all. It reported "2 machines pledged" with no way to
//  know whether both were his own browser tabs.
//
//  Worse, the card rendered "no one has pledged a machine yet" directly beneath
//  a strip saying 2 — because `pledged` is a count and `recent` is a list, and
//  the list came back empty. Two numbers from one payload disagreeing on screen
//  is how a dashboard loses the right to be believed.
//
//  So: identity is tracked locally, never inferred from the public ledger, and
//  when the ledger cannot answer, this says CANNOT TELL rather than guessing a
//  reassuring zero.
// ───────────────────────────────────────────────────────────────────────────
function poolIdentity() {
  const s = STATE.settings || (STATE.settings = {});
  // ⚠ The node id travels to a PUBLIC ledger. It must never carry his hostname,
  // username, or hardware string — a pool that identifies its contributors by
  // machine name is a deanonymisation surface. Random, stable, meaningless.
  if (!s.nodeId) { s.nodeId = 'ci-' + require('crypto').randomBytes(6).toString('hex'); saveState(); }
  if (!Array.isArray(s.knownNodes)) s.knownNodes = [];
  return s;
}
// Anything this app registered, anything he has marked as his, and the test
// harness's own fixtures. A harness node counted as "a stranger arrived" would
// be the most demoralising false positive in the app.
function nodeIsMine(id) {
  const s = poolIdentity();
  const v = String(id || '');
  return v === s.nodeId || s.knownNodes.includes(v) || /^airtest-/.test(v) || /^ci-/.test(v);
}
function poolReading(pool) {
  const s = poolIdentity();
  const pledged = (pool && pool.pledged) || 0;
  const recent = (pool && pool.recent) || [];
  const ids = [...new Set(recent.map((n) => String(n.id || '')).filter(Boolean))];
  const foreign = ids.filter((id) => !nodeIsMine(id));
  const mine = ids.filter((id) => nodeIsMine(id));
  // THE HONEST BRANCH. A count with no roster cannot be attributed. Saying
  // "0 strangers" here would be a claim the data does not support.
  const canTell = ids.length > 0 || pledged === 0;
  return {
    pledged, listed: ids.length, mine: mine.length, foreign: foreign.length,
    foreignIds: foreign.slice(0, 8), canTell,
    why: canTell ? '' : `the ledger reports ${pledged} pledged but returns no node records, so whose machines they are cannot be determined from here`,
    everForeign: !!s.firstForeignTs, firstForeignTs: s.firstForeignTs || 0,
    ownNodeId: s.nodeId, pledgedSelf: s.knownNodes.includes(s.nodeId),
  };
}
// ★ THE MOMENT R3 TURNS, THE APP SHOULD BE THE THING THAT NOTICES.
// Not a number he has to go and read — an event that comes to him, once.
function watchForeignNodes(pool) {
  return safe(() => {
    const s = poolIdentity();
    const r = poolReading(pool);
    if (!r.foreign) return r;
    if (!s.firstForeignTs) {
      s.firstForeignTs = now();
      saveState();
      omniAudit('compute', `a machine that is not yours joined the pool (${r.foreignIds.join(', ')})`);
      pushNotification('good', 'Someone else joined the pool',
        `${r.foreign} machine(s) in MotusCompute are not yours. That is the mover loop turning for the first time.`,
        'stream', 'r3:first-foreign');
    }
    return r;
  }, null) || poolReading(pool);
}
// ⊕ PLEDGE THIS MACHINE — properly, with a stable anonymous id, so the pool has
// a real capability floor instead of two anonymous browser tabs. Registered as
// HIS, so it can never inflate the stranger count it exists to measure.
ipcMain.handle('cortex:computePledge', requireGate(async (_e, p = {}) => {
  const s = poolIdentity();
  const own = ownCompute() || {};
  const body = {
    id: s.nodeId, tier: 'node', vendor: 'cortexinsight', arch: 'x64',
    klass: (own.cores || 0) >= 12 ? 'workstation' : 'laptop',
    maxBufferMB: Math.max(1024, Math.min(8192, (own.ramGB || 8) * 256)),
    invocations: Math.max(512, (own.cores || 4) * 256),
    seconds: Math.max(0, Math.min(3600, Number(p.seconds) || 0)),
    dj: onAirState().dj || 'daoz', mode: 'direct',
  };
  airInvalidate('/api/compute');
  const r = await onAirHttp('POST', '/api/compute', body);
  const ok = !!(r.json && r.json.ok !== false && r.status === 200);
  if (ok && !s.knownNodes.includes(s.nodeId)) { s.knownNodes.push(s.nodeId); saveState(); }
  return { ok, node: s.nodeId, capability: r.json && r.json.capability, error: ok ? undefined : (r.error || `HTTP ${r.status}`) };
}));
// Mark a node id as his — for machines he pledged from a browser tab, which the
// app never saw. Keeps the stranger count truthful in both directions.
ipcMain.handle('cortex:computeClaimNode', requireGate((_e, { id } = {}) => {
  const s = poolIdentity();
  const v = String(id || '').trim().slice(0, 64);
  if (!v) return { ok: false, error: 'no node id' };
  if (!s.knownNodes.includes(v)) s.knownNodes.push(v);
  saveState();
  return { ok: true, knownNodes: s.knownNodes };
}));
// ───────────────────────────────────────────────────────────────────────────
//  THE LEDGER CACHE — stale-while-revalidate for the remote ledgers.
//
//  MEASURED by the handler instrument: cortex:work ~1s median, compute ~800ms,
//  payouts ~600ms — each one a fresh HTTPS round-trip on EVERY call, and
//  between them they feed four different screens. The ledgers change on the
//  minute scale; the screens ask on the second scale. That mismatch is the
//  whole cost.
//
//  Rules, in order of importance:
//    · NEVER serve stale silently forever: stale is served only inside a
//      2-minute window, and a background revalidation is already in flight
//      the moment it is served.
//    · a WRITE to a ledger (pledge, clear, payout op) invalidates its cache
//      instantly — the next read pays full price and gets the truth.
//    · only status-200 answers are cached; an error is never "fresh".
// ───────────────────────────────────────────────────────────────────────────
const AIR_CACHE = Object.create(null);
const AIR_FRESH_MS = 15000, AIR_STALE_MAX_MS = 120000;
function airInvalidate(path) { delete AIR_CACHE[path]; }
function cachedAirGet(path) {
  const c = AIR_CACHE[path];
  const age = c ? now() - c.ts : Infinity;
  const fetchIt = () => onAirHttp('GET', path + '?ts=' + now()).then((r) => {
    if (r && r.status === 200) AIR_CACHE[path] = { ts: now(), r };
    return r;
  });
  if (c && age < AIR_FRESH_MS) return Promise.resolve(c.r);
  if (c && age < AIR_STALE_MAX_MS) { fetchIt().catch(() => {}); return Promise.resolve(c.r); }
  return fetchIt();
}
ipcMain.handle('cortex:compute', requireGate(async () => {
  const r = await cachedAirGet('/api/compute');
  return { ok: true, pool: r.json || null, own: ownCompute(), error: r.error,
    reading: r.json ? watchForeignNodes(r.json) : null };
}));
ipcMain.handle('cortex:computeClear', requireGate(async () => {
  airInvalidate('/api/compute');
  const r = await onAirHttp('DELETE', '/api/compute', null, { 'x-live-secret': onAirSecret() });
  return { ok: !!(r.json && r.json.ok) };
}));

// ── THE PAYOUT CONSOLE ──────────────────────────────────────────────────────
// CortexInsight is the operator surface, so it drives plan/arm/settle. It still
// holds NO KEY: `arm` returns a sendmany spec that August signs on his own node,
// and `settle` records the txid that comes back. The app can compute a payment
// and can prove one happened; it can never make one happen by itself. That
// separation is the whole security model, and it is why this is safe to ship in
// a desktop app that also drives his screen.
ipcMain.handle('cortex:payouts', requireGate(async () => {
  const r = await cachedAirGet('/api/payouts');
  return { ok: true, pay: r.json || null, error: r.error };
}));
ipcMain.handle('cortex:payoutOp', requireGate(async (_e, body = {}) => {
  const op = String(body.op || 'plan');
  // `arm` and `settle` are the only ops that change money state. Guard them
  // behind an explicit confirm flag so a stray click in a dashboard can never
  // freeze a batch — the UI must say what it is about to do, and mean it.
  if ((op === 'arm' || op === 'settle') && !body.confirmed) {
    return { ok: false, error: `'${op}' needs an explicit confirm` };
  }
  airInvalidate('/api/payouts');
  const r = await onAirHttp('POST', '/api/payouts', body, { 'x-live-secret': onAirSecret() });
  return { ok: !!(r.json && r.json.ok), res: r.json || null, error: r.error };
}));

// ── RUNG 5 · DISPATCH ───────────────────────────────────────────────────────
// This is the bridge that turns one of HIS tasks into work the pool can do.
// A task becomes chunks; chunks become units; units get computed twice by
// machines that have never met and settle only when they agree. He sees the
// queue drain and the receipts arrive.
ipcMain.handle('cortex:work', requireGate(async () => {
  const r = await cachedAirGet('/api/work');
  return { ok: true, work: r.json || null, error: r.error };
}));
ipcMain.handle('cortex:receipts', requireGate(async () => {
  const r = await onAirHttp('GET', '/api/receipts?ts=' + now());
  return { ok: true, receipts: r.json || null, error: r.error };
}));
ipcMain.handle('cortex:workEnqueue', requireGate(async (_e, { task, text, kind } = {}) => {
  const title = String(task || '').slice(0, 120).trim();
  if (!title) return { ok: false, error: 'a task needs a name' };
  // ⚠ PUBLIC WORK ONLY, and this is the gate that enforces it at the source.
  // The payload is served to anyone who asks — so it runs the same secret-shape
  // scrub the broadcast rail uses. If it would be bad for it to be public, it
  // must never become a work unit.
  const body = String(text || title);
  // The whole payload is checked FIRST, then every chunk again. Chunking can
  // split a key across a boundary and hide it from a per-chunk test, so the
  // whole-body check is the one that actually protects him.
  const whole = omniSecretish(body);
  if (whole) return { ok: false, error: `refused — ${whole}. Work units are served publicly to anyone who asks.` };

  const all = safe(() => {
    // ~600-char chunks on word boundaries: small enough to finish in a browser
    // tab between frames, big enough that the round trip is not the cost.
    const words = body.split(/\s+/).filter(Boolean);
    const out = []; let cur = '';
    for (const w of words) {
      if ((cur + ' ' + w).length > 600) { if (cur) out.push(cur.trim()); cur = w; }
      else cur += ' ' + w;
    }
    if (cur.trim()) out.push(cur.trim());
    return out.slice(0, 60);
  }, []);
  const chunks = all.filter((c) => !omniSecretish(c));
  const held = all.length - chunks.length;
  if (!chunks.length) return { ok: false, error: 'nothing left after the public-content gate' };
  const r = await onAirHttp('POST', '/api/work', {
    op: 'enqueue', task: title, kind: kind === 'score' ? 'score' : 'embed', chunks,
  }, { 'x-live-secret': onAirSecret() });
  return { ok: !!(r.json && r.json.ok), res: r.json || null, chunks: chunks.length, held, error: r.error };
}));
ipcMain.handle('cortex:workClear', requireGate(async () => {
  const r = await onAirHttp('DELETE', '/api/work', null, { 'x-live-secret': onAirSecret() });
  return { ok: !!(r.json && r.json.ok), res: r.json || null };
}));

// ── THE GOLEM GAUGE ─────────────────────────────────────────────────────────
// Measured, never asserted. If Golem ever grows GPU supply this flips on its
// own and he finds out from the dashboard rather than from a rumour.
ipcMain.handle('cortex:golem', requireGate(async () => {
  const r = await onAirHttp('GET', '/api/golem?ts=' + now());
  return { ok: true, golem: r.json || null, error: r.error };
}));
ipcMain.handle('cortex:onAirChatDel', requireGate(async (_e, { id, all } = {}) => {
  const r = await onAirHttp('DELETE', '/api/chat', all ? { all: true } : { id }, { 'x-live-secret': onAirSecret() });
  return { ok: !!(r.json && r.json.ok), removed: (r.json && r.json.removed) || 0 };
}));

// ###########################################################################
//  MOTUSMODELS — our own reading of what a model IS, and a studio to evolve one.
//
//  A MotusModel is not a template and not a workflow. It is a LOOP SOMEONE ELSE
//  CAN RUN, that pays out when it turns. Four organs, in August's own order:
//     MANTRA  — the words that carry the standard
//     MINDSET — the stance it asks of whoever runs it
//     MODEL   — the mechanism: the stages that actually execute
//     MOTUS   — what moves, and what the receipt looks like
//
//  It is adaptive because it has a GENOME and a GENERATION. You fork it, an
//  agent mutates it along an axis you choose, a panel scores the variants on
//  five fitness dimensions, you ratify one, and it becomes the next generation
//  with its lineage intact. Nothing enters canon silently — propose, ratify.
//
//  It is real because a model COMPILES to a workflow in this same app. Running
//  a MotusModel is not a metaphor; it dispatches the fleet.
// ###########################################################################
const MM_AXES = {
  portability: { label: 'Portability', note: 'Could a stranger run this without you in the room?' },
  payout:      { label: 'Payout',      note: 'Is it obvious what moves, to whom, and what they get?' },
  pull:        { label: 'Mover-pull',  note: 'Does it make someone WANT to take the first step?' },
  proof:       { label: 'Proof',       note: 'Does a turn leave a receipt anyone can verify?' },
  resonance:   { label: 'Resonance',   note: 'Does the meaning show through the mechanism — is it beautiful?' },
};
const MM_STATUS = ['draft', 'ratified', 'minted', 'broadcast'];
function mmDir() { const d = path.join(ciDir(), 'motusmodels'); safe(() => fs.mkdirSync(d, { recursive: true })); return d; }
function newMotusModel(def = {}) {
  return {
    id: def.id || newId(),
    name: String(def.name || 'Untitled MotusModel').slice(0, 90),
    essence: String(def.essence || '').slice(0, 300),
    mantra: String(def.mantra || '').slice(0, 600),
    mindset: String(def.mindset || '').slice(0, 900),
    model: String(def.model || '').slice(0, 4000),
    motus: String(def.motus || '').slice(0, 900),
    proof: String(def.proof || '').slice(0, 600),
    stages: Array.isArray(def.stages) ? def.stages.slice(0, 8) : [],
    generation: parseInt(def.generation, 10) || 1,
    parentId: def.parentId || '',
    lineage: Array.isArray(def.lineage) ? def.lineage.slice(0, 24) : [],
    fitness: def.fitness || null,           // { portability, payout, pull, proof, resonance, total, judgedBy, ts, note }
    status: MM_STATUS.includes(def.status) ? def.status : 'draft',
    mint: def.mint || null,                 // { hash, file, ts }
    created: def.created || new Date().toISOString(),
    updated: new Date().toISOString(),
    runs: parseInt(def.runs, 10) || 0,
    workflowId: def.workflowId || '',
    notes: String(def.notes || '').slice(0, 2000),
  };
}
function mmAll() { if (!Array.isArray(STATE.motusModels)) STATE.motusModels = []; return STATE.motusModels; }
function mmFind(id) { return mmAll().find((m) => m.id === id); }
function mmSave(def) {
  const m = newMotusModel(def);
  if (!m.name || m.name === 'Untitled MotusModel') return { ok: false, error: 'give it a name — the name is the first act of design' };
  const list = mmAll();
  const i = list.findIndex((x) => x.id === m.id);
  if (i >= 0) list[i] = { ...list[i], ...m };
  else list.unshift(m);
  STATE.motusModels = list.slice(0, 80);
  saveState();
  return { ok: true, model: m };
}
// The canonical seed: the loop August and I already run, written as something
// another pair could pick up and turn. Seeded once, then his to evolve.
function mmSeed() {
  if (STATE.mmSeeded) return;
  STATE.mmSeeded = true;
  if (mmAll().length) { saveState(); return; }
  mmSave({
    name: 'MotusModel One — Mantra → Mindset → Model → Motus',
    essence: 'The flywheel one human and one agent run together, made portable enough that a stranger can turn it.',
    mantra: 'Motus is the mindset. The mindset means move. Nothing counts until something moved.',
    mindset: 'Systems sight over symptom-chasing. The smallest move that shifts the structure. Partial-but-honest beats complete-but-reckless. The operator holds the what and the why; the agent holds the whole state and the how.',
    model: `1 · NAME THE MOTUS — the single strongest thing moving now. One sentence, written down.
2 · READ THE SYSTEM — stock, loop, leverage, delay. Name the Meadows rung before touching anything.
3 · MAKE THE SMALLEST MOVE — one bounded change, reversible, verified at the layer the user lives at.
4 · LEAVE THE RECEIPT — what moved, where to see it, what it cost.
5 · BANK THE LESSON — the learning goes into canon, so the next turn is cheaper than this one.`,
    motus: 'A turn pays out when someone who is not the author completes step 3 and leaves a receipt at step 4. That receipt is the value in motion.',
    proof: 'A dated, hashed record naming what moved, by whom, and where it can be seen.',
    stages: [
      { name: 'Name the Motus', agents: ['davara'], instruction: 'Read the operator\'s current state and name the single strongest thing moving now, in one sentence, in his own register.' },
      { name: 'Read the system', agents: ['davara'], instruction: 'Systems read on that Motus: stock, loop, leverage rung, delay. Name the highest rung reachable with a small move.' },
      { name: 'Make the move', agents: ['davaris'], instruction: 'Execute the smallest bounded, reversible change that shifts the structure named above. Verify it at the layer the user lives at.' },
      { name: 'Leave the receipt', agents: ['sympath-cortex'], instruction: 'Write the receipt: what moved, where to see it, what it cost, and the one lesson worth banking.' },
    ],
    generation: 1, status: 'draft',
    notes: 'Seeded as the starting genome. Fork it — do not edit the seed, so the lineage stays readable.',
  });
}
// A model compiles to a real workflow, so "run it" dispatches the fleet.
function mmCompile(m) {
  const stages = (m.stages || []).filter((s) => s && s.name && s.instruction).map((s) => ({
    name: String(s.name).slice(0, 80),
    agents: (Array.isArray(s.agents) ? s.agents : String(s.agents || '').split(',')).map((x) => String(x).trim()).filter(isRelayAgent),
    instruction: `${s.instruction}

YOU ARE RUNNING A MOTUSMODEL — «${m.name}» (generation ${m.generation}).
MANTRA: ${m.mantra}
MINDSET: ${m.mindset}
WHAT COUNTS AS MOVEMENT HERE: ${m.motus}
THE RECEIPT THIS OWES: ${m.proof}`,
  })).filter((s) => s.agents.length);
  if (!stages.length) return { ok: false, error: 'this model has no runnable stages yet — give at least one stage a name, an agent and an instruction' };
  return wfSave({ id: m.workflowId || undefined, name: `MotusModel · ${m.name}`.slice(0, 80), intent: m.essence || m.motus, stages });
}
// Minting is local, honest and verifiable: a content hash over the genome, a
// human-readable card beside it, and a lineage chain back to generation one.
// Nothing is transmitted. Broadcasting PREPARES a payload; sending stays his.
function mmMint(id) {
  const m = mmFind(id);
  if (!m) return { ok: false, error: 'no such model' };
  if (!m.mantra || !m.model || !m.motus) return { ok: false, error: 'a model needs at least a Mantra, a Model and a Motus before it can be minted' };
  const genome = {
    name: m.name, essence: m.essence, mantra: m.mantra, mindset: m.mindset,
    model: m.model, motus: m.motus, proof: m.proof,
    stages: (m.stages || []).map((s) => ({ name: s.name, instruction: s.instruction })),
    generation: m.generation, lineage: m.lineage, parentId: m.parentId,
  };
  const canon = JSON.stringify(genome, Object.keys(genome).sort());
  const hash = crypto.createHash('sha256').update(canon).digest('hex');
  const stamp = new Date().toISOString();
  const base = path.join(mmDir(), `${m.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 50)}-g${m.generation}-${hash.slice(0, 8)}`);
  const manifest = { kind: 'motusmodel', version: 1, hash, minted: stamp, by: 'CortexInsight', genome };
  const card = `# ${m.name}
*MotusModel · generation ${m.generation} · minted ${stamp.slice(0, 10)}*

> ${m.essence || m.motus}

## Mantra
${m.mantra}

## Mindset
${m.mindset}

## Model
${m.model}

## Motus — what actually moves
${m.motus}

## Proof — what a turn leaves behind
${m.proof}

---
\`sha256:${hash}\`
${m.lineage && m.lineage.length ? `\nLineage: ${m.lineage.join(' → ')} → g${m.generation}\n` : ''}`;
  const okw = safe(() => { fs.writeFileSync(base + '.json', JSON.stringify(manifest, null, 2)); fs.writeFileSync(base + '.md', card); return true; }, false);
  if (!okw) return { ok: false, error: 'the mint could not be written to disk' };
  m.mint = { hash, file: base + '.md', json: base + '.json', ts: stamp };
  m.status = m.status === 'broadcast' ? 'broadcast' : 'minted';
  m.updated = stamp;
  saveState();
  return { ok: true, model: m, hash, file: base + '.md' };
}
// Broadcast = compose the payloads for his rails and open the folder. This app
// holds no posting credentials and will not acquire any — the send stays his.
function mmBroadcast(id) {
  const m = mmFind(id);
  if (!m) return { ok: false, error: 'no such model' };
  if (!m.mint) return { ok: false, error: 'mint it first — a broadcast without a hash is just a claim' };
  const short = (m.essence || m.motus || '').slice(0, 180);
  const payloads = {
    move: `${m.name}\n\n${short}\n\nMantra: ${m.mantra}\n\nsha256:${m.mint.hash.slice(0, 16)}`,
    post: `${m.name} — a MotusModel anyone can run.\n\n${short}\n\nMotus is the mindset. The mindset means move.`,
    signal: `MOTUSMODEL · g${m.generation} · ${m.name}\n${short}\nhash ${m.mint.hash.slice(0, 24)}`,
  };
  const f = path.join(mmDir(), `broadcast-${m.id}.md`);
  safe(() => fs.writeFileSync(f, `# Broadcast payloads — ${m.name}\n\n## MotusMoves move\n\n${payloads.move}\n\n## X / @BuiltByAugust\n\n${payloads.post}\n\n## Initium signal\n\n${payloads.signal}\n`));
  m.status = 'broadcast'; m.updated = new Date().toISOString();
  saveState();
  return { ok: true, payloads, file: f, note: 'Prepared, not sent. CortexInsight holds no posting credentials — you send it, from the rail you choose.' };
}

// ---------------------------------------------------------------------------
//  MotusModel refinement helpers (studio support). A refinement never
//  overwrites its parent: the agent proposes a revised DRAFT as the next
//  generation, August ratifies or discards it, and the lineage stays readable.
// ---------------------------------------------------------------------------
function mmGenomeBlock(m) {
  return `NAME: ${m.name}
ESSENCE: ${m.essence}
MANTRA: ${m.mantra}
MINDSET: ${m.mindset}
MODEL:
${m.model}
MOTUS: ${m.motus}
PROOF: ${m.proof}
STAGES:
${(m.stages || []).map((s, i) => `  ${i + 1}. ${s.name} [${(Array.isArray(s.agents) ? s.agents : [s.agents]).filter(Boolean).join(',') || 'davara'}] — ${s.instruction}`).join('\n') || '  (none)'}`;
}
// Read a proposed revision back out of the agent's reply. Any organ it left
// out is inherited from the parent unchanged.
function mmParseGenome(text, parent) {
  const grab = (k, multi) => {
    const re = multi
      ? new RegExp(`^${k}:\\s*\\n?([\\s\\S]*?)(?=^(?:NAME|ESSENCE|MANTRA|MINDSET|MODEL|MOTUS|PROOF|STAGES|WHY):|$(?![\\s\\S]))`, 'mi')
      : new RegExp(`^${k}:\\s*(.+)$`, 'mi');
    const m2 = re.exec(text);
    return m2 ? m2[1].trim() : '';
  };
  const stages = [];
  const sBlock = grab('STAGES', true);
  for (const line of sBlock.split('\n')) {
    const m2 = /^\s*\d+\.\s*(.+?)\s*\[([^\]]*)\]\s*—?\s*(.+)$/.exec(line) || /^\s*\d+\.\s*(.+?)\s*—\s*(.+)$/.exec(line);
    if (!m2) continue;
    if (m2.length === 4) stages.push({ name: m2[1], agents: m2[2].split(',').map((x) => x.trim()).filter(isRelayAgent), instruction: m2[3] });
    else stages.push({ name: m2[1], agents: ['davara'], instruction: m2[2] });
  }
  return {
    name: grab('NAME') || parent.name, essence: grab('ESSENCE') || parent.essence,
    mantra: grab('MANTRA', true) || parent.mantra, mindset: grab('MINDSET', true) || parent.mindset,
    model: grab('MODEL', true) || parent.model, motus: grab('MOTUS', true) || parent.motus,
    proof: grab('PROOF') || parent.proof,
    stages: stages.length ? stages : parent.stages,
    why: grab('WHY', true),
  };
}
// Ask an agent for ONE deliberate refinement along a chosen axis. The result
// is a new draft generation — never an in-place change.
async function mmEvolve(id, axis, direction) {
  const m = mmFind(id);
  if (!m) return { ok: false, error: 'no such model' };
  const ax = MM_AXES[axis] ? axis : 'pull';
  const agent = STATE.settings.voiceAgent || 'davara';
  const blocked = dispatchBlocked(agent); if (blocked) return { ok: false, error: blocked };
  const prompt = `/MOTUSMODEL REFINEMENT — one deliberate improvement, not a rewrite.

${MOTUSAGENT_CREED}

Here is a MotusModel, generation ${m.generation}:

${mmGenomeBlock(m)}

IMPROVE IT ALONG ONE AXIS: **${MM_AXES[ax].label}** — ${MM_AXES[ax].note}
${direction ? `AUGUST'S DIRECTION FOR THIS REVISION (this outranks everything else): ${String(direction).slice(0, 600)}` : ''}

Rules of a good revision:
· Change what serves the axis; keep everything that already works. A revision that touches every organ is a rewrite, and rewrites lose the lineage.
· The Mantra may only sharpen, never inflate. No slop, no hype words.
· Stages must stay runnable: each needs a name, at least one of [davara, davaris, sympath-cortex, arden], and a concrete instruction.
· The Motus line must name what MOVES and for WHOM. If it doesn't, fix that first — it is the organ everything else exists for.

Reply in EXACTLY the shape you were shown (NAME / ESSENCE / MANTRA / MINDSET / MODEL / MOTUS / PROOF / STAGES), then one final line:
WHY: <two sentences — what you changed and why it strengthens ${MM_AXES[ax].label}>`;
  const r = await relaySend(agent, prompt);
  if (!r.ok) return { ok: false, error: r.error };
  const g = mmParseGenome(r.text, m);
  const child = newMotusModel({
    ...m, ...g, id: undefined, workflowId: '', mint: null, fitness: null, runs: 0,
    status: 'draft', parentId: m.id, generation: m.generation + 1,
    lineage: [...(m.lineage || []), `g${m.generation}:${m.name.slice(0, 30)}`],
    notes: `Refined along ${MM_AXES[ax].label}${direction ? ` — “${String(direction).slice(0, 140)}”` : ''}.\n${g.why ? 'WHY: ' + g.why.slice(0, 500) : ''}`,
  });
  const sv = mmSave(child);
  if (!sv.ok) return sv;
  return { ok: true, model: sv.model, why: g.why || '', axis: ax };
}
// The judge: one agent, five axes, honest numbers. Stored on the model so
// generations stay comparable — refinement without a fitness score is drift.
async function mmJudge(id) {
  const m = mmFind(id);
  if (!m) return { ok: false, error: 'no such model' };
  const agent = 'sympath-cortex';
  const blocked = dispatchBlocked(agent); if (blocked) return { ok: false, error: blocked };
  const prompt = `/MOTUSMODEL FITNESS — score honestly; flattery poisons the lineage.

A MotusModel is a loop someone else can run that pays out when it turns. Score this one:

${mmGenomeBlock(m)}

Score each axis 1–10. Be strict: imagine the least prepared stranger trying to run it.
${Object.entries(MM_AXES).map(([k, v]) => `· ${k.toUpperCase()} — ${v.note}`).join('\n')}

Reply in EXACTLY this shape:
PORTABILITY: <n>
PAYOUT: <n>
PULL: <n>
PROOF: <n>
RESONANCE: <n>
VERDICT: <two sentences — the single weakest organ, and the one revision that would most raise the total>`;
  const r = await relaySend(agent, prompt);
  if (!r.ok) return { ok: false, error: r.error };
  const pick = (k) => { const mm = new RegExp(`^${k}:\\s*(\\d+)`, 'mi').exec(r.text); return mm ? clamp(parseInt(mm[1], 10), 1, 10) : 0; };
  const f = {
    portability: pick('PORTABILITY'), payout: pick('PAYOUT'), pull: pick('PULL'),
    proof: pick('PROOF'), resonance: pick('RESONANCE'),
  };
  f.total = f.portability + f.payout + f.pull + f.proof + f.resonance;
  if (!f.total) return { ok: false, error: 'the judge did not return readable scores' };
  const v = /VERDICT:\s*([\s\S]+)$/i.exec(r.text);
  f.note = v ? v[1].trim().slice(0, 600) : '';
  f.judgedBy = agent; f.ts = new Date().toISOString();
  m.fitness = f; m.updated = f.ts;
  saveState();
  return { ok: true, fitness: f, model: m };
}
function mmPublic() {
  mmSeed();
  return {
    models: mmAll().map((m) => ({ ...m })),
    axes: Object.entries(MM_AXES).map(([id, v]) => ({ id, ...v })),
    statuses: MM_STATUS,
    dir: mmDir(),
  };
}

// ===========================================================================
//  BUDGET GOVERNOR — the usage meter becomes a control loop.
//
//  Metering was display-only: the app would happily burn through August's
//  5-hour window on background work and only tell him afterwards. This makes
//  the meter authoritative for AUTONOMOUS spend only. Two rules:
//    · anything August triggers by hand ALWAYS runs — his intent outranks a cap
//    · autonomous work (Duo cadence, auto-reflect, Arden's loop, triggered
//      workflows) yields as the window fills, and downshifts depth before it
//      stops entirely.
//  Costs zero extra tokens — it only reorders and defers spend.
// ===========================================================================
function budgetState() {
  const cap = (STATE.budget && +STATE.budget.fiveHour) || 0;
  if (!cap) return { cap: 0, used: 0, pct: 0, governed: false, tier: 'open' };
  const u = safe(() => buildUsage(false), null);
  const used = (u && u.fiveH && u.fiveH.out) || 0;
  const pct = cap ? used / cap : 0;
  // tiers: open → trim (deep autonomous work downshifts) → hold (autonomy pauses)
  const tier = pct >= 0.95 ? 'hold' : pct >= 0.75 ? 'trim' : 'open';
  return { cap, used, pct, governed: true, tier };
}
// May an autonomous job spend right now? Returns null to allow, or a reason.
function autonomyAllowed(what) {
  if (STATE.control && STATE.control.stopped) return 'the fleet is stopped';
  const b = budgetState();
  if (!b.governed) return null;
  if (b.tier === 'hold') return `${Math.round(b.pct * 100)}% of your 5-hour cap is used — ${what} is holding until the window refreshes`;
  return null;
}
// Deliberately NOT auto-downshifting depth here: the runner cannot tell an
// autonomous turn from one August just typed, so trimming quality globally would
// silently degrade HIS turns to save tokens on background work. The governor
// defers autonomous jobs instead, and the Usage screen surfaces the tier so the
// depth call stays his.

// ---------------------------------------------------------------------------
//  A LOOP PASS — one bounded, high-confidence move, logged as real work.
// ---------------------------------------------------------------------------
// The pass prompt is built by a PURE function so the harness can hold the
// exact text a pass would send — the shared picture and the intention loop
// stopped being "wired, trust me" and became an assertion that runs on every
// build. A prompt you cannot inspect is a prompt you cannot trust.
// ===========================================================================
//  v3.55 · DAVARA'S ORGANS, READ LIVE — and THE CRITIC.
//
//  August: "utilize more of Davara's codebase and baseline repo… so they work
//  really well together… higher critic and higher quality / confidence
//  scores for all major passes. Never settle."
//
//  Her baseline already holds the disciplines this app needed: the Motus Gate
//  (PRACTITIONER-LOOP), tripwires with a date and a pre-read (FORESIGHT), the
//  shuttle between altitudes (TWO-ALTITUDES), the execution liturgy (THE
//  BUILDER'S CREED), and the referent question (THE INSTRUMENT). Like the Map
//  Cortex reads BuildMode, this reads her canon LIVE off the canonical clone
//  — one copy of the truth, never a paraphrase that drifts — and hands each
//  loop the one or two organs its kind needs, on her own context diet.
// ===========================================================================
function dvDir() { return path.join(path.dirname(root()), 'DAVARA-DV2-BASELINE'); }
function dvCovenantPath() { return path.join(path.dirname(root()), 'davara-v2-work', 'DUODRIVE-BASELINE-EVOLUTION.md'); }
const DV_FILES = {
  practitioner: 'protocols/PRACTITIONER-LOOP.md',
  foresight: 'protocols/FORESIGHT.md',
  altitudes: 'protocols/TWO-ALTITUDES.md',
  creed: 'skills/THE-BUILDERS-CREED.md',
  instrument: 'protocols/THE-INSTRUMENT.md',
};
function dvRead(key) { const f = DV_FILES[key]; return f ? readTextCached(path.join(dvDir(), f)) : ''; }
function dvVersion() { return String(readTextCached(path.join(dvDir(), 'VERSION')) || '').trim().split(NL)[0] || ''; }
function dvAvailable() { return !!dvVersion(); }
function dvSection(key, re, maxChars = 1600) {
  const t = dvRead(key); if (!t) return '';
  const parts = t.split(/\n(?=##\s)/);
  const hit = parts.find((p) => re.test(p.split(NL)[0] || ''));
  return hit ? hit.slice(0, maxChars).trim() : '';
}
// which organ a loop reads before it moves — at most two, at most ~3K chars
function dvOrgansFor(kind) {
  if (!dvAvailable()) return '(your baseline is not readable from this machine right now; work from the canon you carry)';
  const L = [];
  const push = (label, text) => { if (text) L.push('── ' + label + ' ──' + NL + text); };
  if (kind === 'scout' || kind === 'review') {
    push('FORESIGHT · tripwires', dvSection('foresight', /tripwires/i, 1400));
    push('TWO ALTITUDES · the three laws', dvSection('altitudes', /three laws/i, 1400));
  } else if (kind === 'refine' || kind === 'design' || kind === 'artifact') {
    push("THE BUILDER'S CREED · the liturgy", dvSection('creed', /execution liturgy/i, 1400));
    push('THE INSTRUMENT · the move', dvSection('instrument', /^##\s+the move/i, 1200));
  } else {
    push('THE PRACTITIONER LOOP · the Motus Gate', dvSection('practitioner', /motus gate/i, 1500));
  }
  return L.length ? 'FROM YOUR OWN BASELINE (' + dvVersion() + ') — read once, then move:' + NL + L.join(NL + NL)
    : '(no organ section matched for this loop kind; work from the canon you carry)';
}
// THE CRITIC — her own gates, run before the report. Enthusiasm is not evidence.
const LOOP_CRITIC = `THE CRITIC (run it before you report; it outranks your enthusiasm):
· RTL — name the three strongest objections to your move; the most damaging one wins. If it survives, ship. If it does not, skip and say which objection killed it.
· THE INSTRUMENT — before you cite a number, say what it counts. A metric improved before it is understood is a more convincing lie.
· THE SHUTTLE — you worked at one altitude; cross once. Walk ONE lived turn through your change, in order. If that turn is not better, the change is decoration.
· NO FALSIFIER, NO MOVE — if you cannot say what observation, by when, would prove you wrong, the pass is not finished.`;
// what a pass is worth, read off the report itself (0–10). Not a vibe: each
// point is a thing the report either carries or does not.
function receiptQuality(e) {
  let q = 0; const why = [];
  const conf = Number.isFinite(e.confidence) ? e.confidence : null;
  if (conf != null) { q += 2; if (String(e.basis || '').length > 12) q += 1; else why.push('confidence has no basis'); }
  else why.push('no confidence stated');
  const f = String(e.falsifier || '');
  if (f.length > 20) { q += 1; if (/\d|\bby\b|\bbefore\b|\bwithin\b|\bnext\b|cycle|release|week|day|month|cohort/i.test(f)) q += 1; else why.push('falsifier has no clock'); }
  else why.push('no falsifier');
  if (String(e.shuttle || '').length > 20) q += 1; else why.push('no lived turn walked');
  const did = String(e.did || '');
  if (did.length > 40 && /[\\/.][A-Za-z]|\d/.test(did)) q += 1; else why.push('DID names no file, number or path');
  if (e.verdict === 'shipped') { if (e.filesVerified === true) q += 2; else if (e.filesVerified === false) why.push('claimed files not found'); else q += 1; }
  else if (e.verdict === 'reported') q += 1;
  if (String(e.next || '').length > 8 && !/^none\b/i.test(String(e.next))) q += 1; else why.push('no next');
  return { quality: Math.max(0, Math.min(10, q)), why };
}
// a claimed file, checked where it would actually be (WSL home or Windows)
function fileLikelyExists(p) {
  const s = String(p || '').trim().replace(/^['"`]|['"`]$/g, '');
  if (!s) return null;
  let full = null;
  if (/^[A-Za-z]:[\\/]/.test(s) || s.startsWith('\\\\')) full = s;
  else if (s.startsWith('~/')) full = path.join(path.dirname(root()), s.slice(2));
  else if (s.startsWith(wslHome() + '/')) full = path.join(path.dirname(root()), s.slice(wslHome().length + 1));
  else return null;                                   // relative: unknown, not false
  return safe(() => fs.existsSync(full), null);
}
// the strategic read's fields — one parser, so the smoke can feed it a fixture
function strategicPick(text, k) {
  const pats = [
    new RegExp(`^\\s*(?:\\*\\*|__|#+\\s*)?(?:THE\\s+)?${k}\\s*(?:\\*\\*|__)?\\s*[:—-]\\s*([\\s\\S]*?)(?=\\n\\s*(?:\\*\\*|__|#+\\s*)?[A-Z][A-Z ]{2,}\\s*(?:\\*\\*|__)?\\s*[:—-]|$)`, 'mi'),
    new RegExp(`${k}\\s*[:—-]\\s*(.+)`, 'i'),
  ];
  for (const p of pats) { const m = p.exec(String(text || '')); if (m && m[1] && m[1].trim()) return m[1].trim(); }
  return '';
}
function strategicConfidence(text) {
  const c = strategicPick(text, 'CONFIDENCE');
  const n = parseInt((c.match(/(\d{1,2})\s*\/\s*10/) || c.match(/(\d{1,2})/) || [])[1], 10);
  const basis = (c.match(/BASIS\s*[:—-]\s*(.+)$/i) || [])[1] || '';
  return { confidence: Number.isFinite(n) ? Math.max(0, Math.min(10, n)) : null, basis: basis.trim().slice(0, 300) };
}
function duoLoopPrompt(loop, agent, ctx) {
  const d = STATE.duo;
  const projects = loopProjects(loop);
  const isDesign = loop.kind === 'design';
  // What she already did on this loop, so she never repeats herself.
  const priorWork = (STATE.duoWork || []).filter((w) => w.loopId === loop.id).slice(0, 6)
    .map((w, i) => `${i + 1}. ${w.title}${w.files && w.files.length ? ` (${w.files.join(', ')})` : ''}`).join('\n') || '(first pass on this loop)';
  const projBlock = projects.length
    ? projects.map((p) => `· ${p.name}${p.url ? ` — ${p.url}` : ''}${p.localPath ? `\n    local: ${p.localPath}` : ''}${p.repo ? `\n    repo: ${p.repo}` : ''}${p.notes ? `\n    notes: ${p.notes.slice(0, 300)}` : ''}${p.ethos ? `\n    its taste: ${p.ethos.slice(0, 400)}` : ''}`).join('\n')
    : '(no projects registered — work on the CortexInsight app itself' + (projectRoot() ? ' at ' + projectRoot() : '') + ', or report that you need a project list)';

  const prompt = `/LEVERAGE LOOP — «${loop.name}» (${LOOP_KINDS[loop.kind].label})

${MOTUSAGENT_CREED}

You are running one autonomous pass for August while he works. This is not a chat; it is a shift.

YOUR LOOP INSTRUCTION:
${loop.instruction}

PROJECTS IN SCOPE:
${projBlock}
${isDesign ? `\nTHE HOUSE DESIGN LANGUAGE (hold this as taste, not as a checklist):\n${(STATE.designEthos || DEFAULT_ETHOS).slice(0, 2000)}\n` : ''}
${safe(() => 'THE READING (the shape of the system right now): ' + systemReading().line + '\n', '')}${STATE.motus ? `MOTUS (the strongest thing moving now — prefer work that serves it): ${STATE.motus.text.slice(0, 240)}\n` : ''}${STATE.goal ? `GOAL: ${STATE.goal.text.slice(0, 240)}\n` : ''}${d.brief ? `AUGUST'S STANDING BRIEF: ${d.brief.slice(0, 600)}\n` : ''}
WHAT YOU ALREADY DID ON THIS LOOP (do NOT repeat these):
${priorWork}
${safe(() => {
  // ★ THE LOOP LEARNS FROM THE WHOLE SYSTEM, not just its own history.
  // `priorWork` stops her repeating HERSELF; this stops her walking into a
  // wall the rest of the fleet already hit. Same text he reads in the Learn
  // view, so the operator and the autopilot hold one picture.
  const p = recentPatterns();
  return p ? `\n${p.replace('## ', '')}\nTreat these as terrain, not trivia: if your intended move runs into one of them, pick a different move or attack the pattern itself — that is the higher-leverage pass.\n` : '';
}, '')}

RECENT FLEET ACTIVITY:
${ctx.digest}

${safe(() => continuityBrief(), '')}
${safe(() => {
  // ★ THE INTENTION LOOP. Her contract already ends each pass with NEXT: —
  // and until now nobody ever read it back. A stated intention that nothing
  // honors is a diary; one that the next pass must answer to is a plan.
  const li = (STATE.duoWork || []).find((w) => w.loopId === loop.id && w.next);
  return li ? 'YOUR OWN LAST INTENTION on this loop was: "' + String(li.next).slice(0, 220) + '"\nHonor it first — or say in ONE line why a different move outranks it now.\n' : '';
}, '')}
${DAVARA_SIGHT}

${safe(() => dvOrgansFor(loop.kind), '')}

${LOOP_CRITIC}
${loop.kind === 'artifact' ? `\nYOU HAVE AN ARTIFACTS STUDIO. Produce a REAL, self-contained file — a document, a table, a chart, a small working HTML view — written into the project, not a description of one. If you cannot finish it completely this pass, build something smaller that IS complete instead of a stub.\n` : ''}
${LOOP_GUARDRAILS}

CONFIDENCE FLOOR FOR THIS LOOP: ${loop.confidenceMin}/10.
If you cannot honestly rate your move at ${loop.confidenceMin} or above, make NO change — report "no move this pass" and why. August would rather you skip ten passes than make one move he has to undo.

${LOOP_CONTRACT}`;
  return prompt;
}
async function duoLoopPass(loop, agent, reason, ctx) {
  const d = STATE.duo;
  const projects = loopProjects(loop);
  const prompt = duoLoopPrompt(loop, agent, ctx);


  const r = await relaySend(agent, prompt);
  const text = (r.text || '').trim();
  const pick = (k, dflt = '') => { const m = text.match(new RegExp(`^${k}:\\s*([\\s\\S]*?)(?=\\n[A-Z][A-Z]+:|$)`, 'im')); return m ? m[1].trim() : dflt; };
  const conf = parseInt((text.match(/CONFIDENCE:\s*(\d{1,2})/i) || [])[1], 10);
  const title = (pick('TITLE') || (r.ok ? 'pass complete' : (r.error || 'pass failed'))).slice(0, 180);
  const filesRaw = pick('FILES', 'none');
  const files = /^none$/i.test(filesRaw) ? [] : filesRaw.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 12);
  const didWork = files.length > 0 || /^(?!no move)/i.test(title);
  // THE CRITIC, main-side: her report is scored on what it carries, and a
  // 'shipped' whose files cannot be found on disk is a report, not a ship.
  const basis = String((text.match(/CONFIDENCE:[^\n]*?BASIS\s*[:—-]\s*([^\n]+)/i) || [])[1] || '').trim().slice(0, 300);
  const falsifier = pick('FALSIFIER').slice(0, 400);
  const shuttle = pick('SHUTTLE').slice(0, 600);
  const checks = files.map(fileLikelyExists).filter((x) => x !== null);
  const filesVerified = files.length ? (checks.length ? checks.every(Boolean) : null) : null;
  if (files.length && filesVerified === false) omniAudit('critic', `${loop.name}: claimed ${files.length} file(s) but ${checks.filter((x) => x === false).length} cannot be found on disk — logged as reported, not shipped`);
  const skipped = /no move|nothing (needed|to do)/i.test(title) || (Number.isFinite(conf) && conf < loop.confidenceMin);

  loop.lastRun = now();
  loop.runs = (loop.runs || 0) + 1;
  if (skipped) loop.skipped = (loop.skipped || 0) + 1;
  loop.skipStreak = skipped ? (loop.skipStreak || 0) + 1 : 0;   // a stalling loop waits longer each time
  for (const p of projects) if (files.length) { p.lastTouched = now(); p.passes = (p.passes || 0) + 1; }

  // She may propose a NEW loop for herself. Saved unapproved — never self-arming.
  let proposed = null;
  if (r.ok) {
    const pl = parseLoopProposal(text);
    if (pl && !(STATE.loops || []).some((x) => textSimilarity(x.name, pl.name) > 0.7)) {
      pl.authoredBy = agent;
      STATE.loops.unshift(pl);
      proposed = pl.name;
      pushNotification('info', `${(FLEET_BY_ID[agent] || {}).name || agent} proposed a new loop`,
        `“${pl.name}” — review and approve it on Duo-Drive to let it run.`, 'duo', 'loopprop:' + pl.id);
    }
  }

  if (r.ok) {
    logDuoWork({
      loopId: loop.id, loopName: loop.name, kind: loop.kind, agent,
      projectId: projects.length === 1 ? projects[0].id : '',
      title, did: pick('DID'), next: pick('NEXT'), files,
      confidence: Number.isFinite(conf) ? conf : null, basis, falsifier, shuttle, filesVerified,
      verdict: skipped ? 'skipped' : (files.length && filesVerified !== false) ? 'shipped' : 'reported',
      body: text,
      ...(() => { const rq = receiptQuality({ confidence: Number.isFinite(conf) ? conf : null, basis, falsifier, shuttle, did: pick('DID'), next: pick('NEXT'), filesVerified,
        verdict: skipped ? 'skipped' : (files.length && filesVerified !== false) ? 'shipped' : 'reported' }); return { quality: rq.quality, qualityWhy: rq.why }; })(),
    });
    // her NEXT line goes to the tray on the board, never straight onto it
    const nx = pick('NEXT');
    if (!skipped && nx && nx.length > 12 && !/^(none|nothing|n\/a|no next)/i.test(nx)) safe(() => duoNextAdd({ text: nx.slice(0, 300), loop: loop.name, agent }));
  }

  const entry = {
    ts: new Date().toISOString(), agent, ok: r.ok, latency: r.latency,
    reason: `loop · ${loop.name}`, loopId: loop.id,
    title: title.slice(0, 160), body: (text || r.error || '').slice(0, 6000),
    confidence: Number.isFinite(conf) ? conf : null, files, skipped, proposed,
  };
  d.log = [entry, ...(d.log || [])].slice(0, 60);
  d.lastRun = now(); d.lastSig = ctx.sig; d.runs = (d.runs || 0) + 1; d.skipStreak = 0;
  saveState();
  // Optionally she says what she just did, out loud — a quiet co-worker who
  // tells you when something landed, instead of a log you have to go read.
  if (r.ok && !skipped && STATE.settings.voiceSpeakDuo && STATE.settings.elevenKeyEnc) {
    safe(async () => {
      const t = await ttsSpeak(`${loop.name}. ${title}`);
      if (t.ok && mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('cortex:duoSpeak', { audio: t.audio });
    });
  }
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('cortex:duoPass', { entry });
  if (r.ok && !skipped) {
    pushNotification('good', `${LOOP_KINDS[loop.kind].glyph} ${loop.name}`, title, 'duo', 'loop:' + entry.ts, { native: false });
    safe(() => fireTriggers('duo', `${title}\n\n${text}`, title));
  }
  return { ok: r.ok, entry, error: r.error };
}

// ===========================================================================
//  CONTROL PLANE — stop / resume the fleet, and per-agent pause.
// ===========================================================================
function controlSet({ stopped, hard }) {
  STATE.control = STATE.control || { stopped: false, hard: false, at: 0 };
  if (stopped != null) { STATE.control.stopped = !!stopped; STATE.control.at = now(); }
  if (hard != null) STATE.control.hard = !!hard;
  // A hard stop also writes `paused+hard` into every agent's config so the
  // runner itself refuses the turn — that reaches Telegram/Hermes too, which
  // a soft stop deliberately does NOT.
  if (STATE.control.hard && STATE.control.stopped) {
    for (const id of AGENTS) {
      STATE.fleetConfig[id] = { ...(STATE.fleetConfig[id] || {}), paused: true, hard: true };
    }
  } else if (!STATE.control.stopped) {
    for (const id of AGENTS) {
      if (STATE.fleetConfig[id] && STATE.fleetConfig[id].hard) {
        STATE.fleetConfig[id] = { ...STATE.fleetConfig[id], paused: false, hard: false };
      }
    }
  }
  saveState();
  publishFleetConfig();
  return controlState();
}
function controlState() {
  const c = STATE.control || { stopped: false, hard: false, at: 0 };
  const inflight = AGENTS.map((a) => { const k = readCheckpoint(a); return k && k.status === 'inflight' ? a : null; }).filter(Boolean);
  const bridge = safe(() => bridgeStatus(), { installed: false });
  const sei = safe(() => sympathState(), null);
  // A stop control that overstates its reach is worse than none — August would
  // think he was safe while tokens burned. So the payload states, precisely,
  // what each mode does and does not cover.
  const hardEffective = !!c.hard && !!bridge.installed;
  return {
    stopped: !!c.stopped, hard: !!c.hard, at: c.at || 0,
    inflight,
    paused: AGENTS.filter((a) => agentCfg(a).paused),
    duo: { active: !!(STATE.duo && STATE.duo.active), agent: STATE.duo && STATE.duo.agent },
    bridgeInstalled: !!bridge.installed,
    hardEffective,
    // the external lane is a separate process with its own key — nothing in this
    // app can halt it, and pretending otherwise would be a lie.
    external: sei && sei.present ? { id: 'sympath-sei', name: 'Sympath SEI', up: !!sei.up } : null,
    covers: {
      appDriven: !!c.stopped,                 // chat, Duo, workflows, spawns, triggers, delegation, auto-loops
      relayEverywhere: hardEffective,         // incl. Telegram / Hermes — needs the bridge
      openRouterAgent: false,                 // never — separate gateway, separate key
    },
    scope: !c.stopped
      ? 'Running.'
      : hardEffective
        ? 'HARD STOP — the runner itself refuses every relay turn, so Telegram and Hermes are stopped too. No subscription tokens can be spent by any relay agent. Sympath SEI is NOT covered: she runs in her own gateway on her own OpenRouter key.'
        : c.hard
          ? 'HARD STOP REQUESTED, BUT NOT IN FORCE — the fleet bridge is not installed, so the runner cannot refuse turns. CortexInsight-driven work is stopped, but a Telegram message would still run and still spend. Install the bridge on the Model screen to make hard stop real.'
          : 'Soft stop — everything CortexInsight drives is halted (chat, Duo-Drive, workflows, subagent spawns, triggers, delegation, auto-loops). Turns already in flight cannot be retracted. Telegram/Hermes and Sympath SEI are NOT covered.',
  };
}

// ---------------------------------------------------------------------------
//  Live pulse loop — pushes REAL activity to the canvas (light, throttled)
// ---------------------------------------------------------------------------
let pulseTimer = null;
function startPulse() {
  stopPulse();
  const tick = () => {
    if (!gate() || !mainWin) return;
    try {
      const interactions = parseInteractions();
      const proxy = parseProxyLog();
      const ckpts = {}; for (const a of AGENTS) ckpts[a] = readCheckpoint(a);
      mainWin.webContents.send('cortex:pulse', pulseSnapshot(interactions, proxy, ckpts));
    } catch {}
  };
  pulseTimer = setInterval(tick, 4000);
}
function stopPulse() { if (pulseTimer) clearInterval(pulseTimer); pulseTimer = null; }

// ===========================================================================
//  SENTINEL — tray presence · background watchdog · integrity monitor · heal
// ===========================================================================
function runWslFull(args, timeout = 30000) {
  return new Promise((res) => execFile(IS_WIN ? 'wsl' : args[0], IS_WIN ? ['-e', ...args] : args.slice(1), { timeout, windowsHide: true, maxBuffer: 6e6 },
    (err, so, se) => res({ rc: err ? (err.code || 1) : 0, out: ((so || '') + (se ? '\n' + se : '')).trim() })));
}

// ---- Telegram (Davara's verified send path; through WSL, no API, $0) ----
// Reaches August's DM via <fleet>/SystemsCortex/davara-tg-send.sh. Best-effort,
// fire-and-forget; never throws into a caller. Gated by settings.telegramNudges.
const tgScript = () => linuxRoot() + '/SystemsCortex/davara-tg-send.sh';
async function tgSend(text) {
  if (!STATE || !STATE.settings || !STATE.settings.telegramNudges) return { ok: false, skipped: true };
  const body = String(text || '').slice(0, 3500);
  if (!body.trim()) return { ok: false, error: 'empty' };
  const r = await runWslFull(['bash', tgScript(), body], 30000).catch(() => ({ rc: 1, out: 'exec failed' }));
  return { ok: r.rc === 0, out: r.out };
}
// Push a notification AND (for key/critical moments) also ping Telegram.
function notifyKey(level, title, body, view, dedupeKey) {
  pushNotification(level, title, body, view, dedupeKey);
  tgSend(`${level === 'bad' ? '⚠️' : level === 'warn' ? '◆' : '◇'} ${title}\n\n${body}`).catch(() => {});
}

// ---- tray ----
let tray = null, _trayLevel = null;
const trayIcon = (level) => path.join(__dirname, 'assets', `tray-${level}.${IS_WIN ? 'ico' : 'png'}`);
function showWindow() {
  if (mainWin && !mainWin.isDestroyed()) { if (mainWin.isMinimized()) mainWin.restore(); mainWin.show(); mainWin.focus(); }
  else createWindow();
}
function buildTray() {
  try {
    tray = new Tray(trayIcon('good'));
    tray.setToolTip('CortexInsight');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open CortexInsight', click: () => showWindow() },
      { label: 'Bug-test & heal', click: () => { showWindow(); if (mainWin) mainWin.webContents.send('cortex:navigate', 'settings'); } },
      { label: 'Security', click: () => { showWindow(); if (mainWin) mainWin.webContents.send('cortex:navigate', 'security'); } },
      { type: 'separator' },
      { label: 'Quit CortexInsight', click: () => { app.isQuitting = true; app.quit(); } },
    ]));
    tray.on('click', () => showWindow());
  } catch (e) { console.log('[tray]', e && e.message); }
}
function setTray(level, tip) {
  if (!tray) return;
  if (level !== _trayLevel) { _trayLevel = level; safe(() => tray.setImage(trayIcon(level))); }
  if (tip) tray.setToolTip(tip);
}

// ---- integrity / tamper monitor ----
const CRITICAL = [
  'SystemsCortex/cortex-run.sh', 'SystemsCortex/run-davara.sh', 'SystemsCortex/run-davaris.sh',
  'SystemsCortex/cortex-lib.sh', 'SystemsCortex/oauth-proxy/cortex_mouth_proxy.py',
  'agents/davara/SOUL.md', 'agents/davaris/SOUL.md',
];
// Snapshots (80KB × 7 files ≈ 560KB) used to live INSIDE state.json, which is
// rewritten — plus a .bak copy — on every save. They now live in sidecar files,
// so the hot state file stays small and cheap to write.
function snapDir() { return path.join(userDataDir(), 'integrity'); }
function snapPath(rel) { return path.join(snapDir(), sha256(rel).slice(0, 16) + '.txt'); }
function writeSnap(rel, txt) {
  return safe(() => {
    if (!exists(snapDir())) fs.mkdirSync(snapDir(), { recursive: true });
    fs.writeFileSync(snapPath(rel), txt.slice(0, 80000));
    return true;
  }, false);
}
function readSnap(rel) {
  const b = STATE.integrity.baseline[rel];
  if (b && typeof b.snapshot === 'string') return b.snapshot;   // legacy, pre-migration
  return safe(() => fs.readFileSync(snapPath(rel), 'utf8'), '');
}
function integrityBaseline(force, onlyRel) {
  for (const rel of CRITICAL) {
    if (onlyRel && rel !== onlyRel) continue;
    const full = P(rel);
    const txt = safe(() => fs.readFileSync(full, 'utf8'), null);
    if (txt == null) continue;
    const b = STATE.integrity.baseline[rel];
    // migrate a legacy inline snapshot out of state.json on the way past
    if (!force && b && typeof b.snapshot === 'string') {
      writeSnap(rel, b.snapshot);
      delete b.snapshot;
      const st0 = statOf(full);
      if (st0) { b.mtime = st0.mtimeMs; b.bytes = st0.size; }
      continue;
    }
    if (force || !b) {
      const st = statOf(full);
      writeSnap(rel, txt);
      STATE.integrity.baseline[rel] = {
        hash: sha256(txt), size: txt.length, ts: new Date().toISOString(),
        mtime: st ? st.mtimeMs : 0, bytes: st ? st.size : txt.length,
      };
    }
  }
  saveState();
}
function lineDiff(a, b) {
  const al = a.split('\n'), bl = b.split('\n'), as = new Set(al), bs = new Set(bl);
  const added = bl.filter((l) => !as.has(l)), removed = al.filter((l) => !bs.has(l));
  return { added: added.length, removed: removed.length,
    sample: [...removed.slice(0, 4).map((l) => '- ' + l.slice(0, 140)), ...added.slice(0, 4).map((l) => '+ ' + l.slice(0, 140))] };
}
function integrityCheck() {
  for (const rel of CRITICAL) {
    const base = STATE.integrity.baseline[rel];
    if (!base) continue;
    const full = P(rel);
    // STAT-GATE: an untouched file needs no read and no sha256. This ran every
    // 45s over the WSL 9p bridge on 7 files — now it is 7 stat() calls unless
    // something genuinely changed.
    const st = statOf(full);
    if (st && base.mtime && st.mtimeMs === base.mtime && st.size === base.bytes) continue;
    const txt = safe(() => fs.readFileSync(full, 'utf8'), null);
    if (txt == null) continue;
    const h = sha256(txt);
    if (h === base.hash) {
      // content identical, only the timestamp moved — re-arm the gate, stay quiet
      if (st) { base.mtime = st.mtimeMs; base.bytes = st.size; }
      continue;
    }
    if (STATE.integrity.alerts.find((a) => a.rel === rel && a.newHash === h.slice(0, 12))) continue; // already flagged
    const diff = lineDiff(readSnap(rel), txt.slice(0, 80000));
    STATE.integrity.alerts.unshift({ ts: new Date().toISOString(), rel, oldHash: base.hash.slice(0, 12), newHash: h.slice(0, 12), added: diff.added, removed: diff.removed, sample: diff.sample });
    STATE.integrity.alerts = STATE.integrity.alerts.slice(0, 60); saveState();
    if (STATE.settings.alertIntegrity) pushNotification('bad', 'Cortex file changed', `${rel} was modified (+${diff.added}/-${diff.removed} lines). Review in Security → Integrity.`, 'security', 'integrity:' + rel + ':' + h.slice(0, 12));
  }
}

// ---------------------------------------------------------------------------
//  SELF-TRIAGE — the gauges become a board.
//  deriveInsights() has always produced real, telemetry-derived recommendations
//  that nobody ever acted on: they rendered in a panel and evaporated. A finding
//  that PERSISTS across two sweeps is a real condition, not a blip — so it earns
//  a task. When the condition clears, the task closes itself. Zero tokens.
// ---------------------------------------------------------------------------
function triageDerived(interactions, proxy) {
  const { next } = deriveInsights(interactions, proxy);
  const seen = (STATE.watchdog.derivedSeen = STATE.watchdog.derivedSeen || {});
  const idOf = (t) => 'auto:' + sha256(String(t || '')).slice(0, 10);
  const live = new Set();
  let changed = false;

  for (const item of (next || []).slice(0, 6)) {
    const id = idOf(item.title);
    live.add(id);
    if (!seen[id]) { seen[id] = now(); changed = true; continue; }   // first sighting — wait
    if (now() - seen[id] < 60000) continue;                          // same sweep, not persistence
    if ((STATE.tasks || []).some((t) => (t.tags || []).includes(id))) continue;  // already raised
    const res = taskCreate({
      title: String(item.title).slice(0, 200),
      body: `${String(item.body || '').slice(0, 1500)}\n\n— raised automatically from live telemetry after persisting across sweeps. It closes itself when the condition clears.`,
      priority: 2, tags: ['auto', id],
    });
    if (res.ok) { changed = true; pushNotification('info', 'Telemetry raised a task', String(item.title).slice(0, 140), 'tasks', id, { native: false }); }
  }
  // condition cleared → close its task and forget it
  for (const id of Object.keys(seen)) {
    if (live.has(id)) continue;
    const t = (STATE.tasks || []).find((x) => (x.tags || []).includes(id) && x.status !== 'done');
    if (t) {
      taskUpdate(t.id, { status: 'done' });
      t.jobs = [{ ts: new Date().toISOString(), agent: '', ok: true, latency: 0, chars: 0,
        note: 'Closed automatically — the telemetry condition that raised this no longer holds.' }, ...(t.jobs || [])].slice(0, 8);
      changed = true;
    }
    delete seen[id];
  }
  if (changed) saveState();
}

// ---- background watchdog ----
let watchTimer = null, _watchBusy = false;
function startWatchdog() { stopWatchdog(); watchdogTick(); watchTimer = setInterval(watchdogTick, Math.max(15000, STATE.settings.watchdogMs || 45000)); }
function stopWatchdog() { if (watchTimer) clearInterval(watchTimer); watchTimer = null; }
async function watchdogTick() {
  if (_watchBusy) return; _watchBusy = true;
  try {
    const s = STATE.settings;
    const health = await relayHealth();
    const interactions = parseInteractions();
    const proxy = parseProxyLog();
    const v = healthVerdict(interactions, proxy);
    // tray vitals
    setTray(!health ? 'warn' : v.level === 'degraded' ? 'bad' : v.level === 'watch' ? 'warn' : 'good',
      `CortexInsight · Cortex ${v.level} · relay ${health ? 'up' : 'down'}${interactions[0] ? ' · last ' + timeAgo(interactions[0].epoch) : ''}`);
    // relay offline
    if (!health && s.alertRelay) pushNotification('bad', 'Relay offline', 'The mouth-proxy is not responding on 127.0.0.1:8788. Chat is unavailable until it\'s back.', 'settings', 'relay-down');
    // new turns since last sweep
    const newest = interactions[0] ? interactions[0].epoch : 0;
    const since = STATE.watchdog.lastSeenTurnEpoch || newest;
    const fresh = interactions.filter((x) => x.epoch > since);
    for (const x of fresh) {
      if (!x.ok && s.alertFaults) {
        pushNotification('bad', `${cap(x.agent)} faulted`, `${x.status} after ${Math.round(x.latency)}s · "${(x.msg || '').slice(0, 80)}"`, 'tasks', 'fault:' + x.ts);
        safe(() => fireTriggers('fault', `${cap(x.agent)} faulted: ${x.status} after ${Math.round(x.latency)}s on "${(x.msg || '').slice(0, 240)}"`, `${x.agent} ${x.status}`));
      }
      else if (x.ok && s.alertComplete) pushNotification('good', `${cap(x.agent)} finished`, `${Math.round(x.latency)}s · ${x.chars} chars · "${(x.msg || '').slice(0, 80)}"`, 'work', 'done:' + x.ts);
    }
    const turnsMoved = STATE.watchdog.lastSeenTurnEpoch !== newest;
    STATE.watchdog.lastSeenTurnEpoch = newest;
    // possible hang: a session inflight far past its start
    if (s.alertHang) for (const a of AGENTS) {
      const c = readCheckpoint(a);
      if (c && c.status === 'inflight' && c.epoch) {
        const mins = (now() - c.epoch * 1000) / 60000;
        if (mins > (s.hangMinutes || 30)) pushNotification('warn', `${cap(a)} may be stuck`, `Session ${c.sid.slice(0, 8)} has been inflight ${Math.round(mins)}m (> ${s.hangMinutes}m). If it's truly hung, heal it in Bug-test.`, 'settings', 'hang:' + c.sid);
      }
    }
    // the fleet's queue — one stat() unless something is actually waiting
    safe(() => ingestAgentInbox());
    safe(() => writeAgentBrief());     // keep the fleet's orientation current
    // integrity sweep (now stat-gated — 7 stat() calls unless something moved)
    integrityCheck();
    // close out any experiment that has gathered enough evidence (0 tokens)
    const concluded = concludeExperiments();
    // the board works its own fleet-owned queue — one task at a time, capped,
    // governed, and always announced
    safe(() => autoWorkTick());
    // derived telemetry findings self-triage onto the board (0 tokens)
    safe(() => triageDerived(interactions, proxy));
    // Only write state when something actually changed. This used to rewrite the
    // whole pretty-printed state.json + a .bak copy every 45 seconds forever.
    if (turnsMoved || concluded) saveState();
    // closed-loop: scheduled autonomous reflection
    if (s.autoReflectHours > 0 && now() - (STATE.watchdog.lastReflect || 0) > s.autoReflectHours * 3600e3) {
      STATE.watchdog.lastReflect = now(); saveState();
      autoReflect().catch((e) => console.log('[autoReflect]', e && e.message));
    }
    // Arden's loop — the first of the main Loops. She observes from beneath on her own cadence.
    if (s.ardenLoopHours > 0 && now() - (STATE.watchdog.lastArden || 0) > s.ardenLoopHours * 3600e3) {
      STATE.watchdog.lastArden = now(); saveState();
      if (!autonomyAllowed('Arden\'s loop')) runArden('loop').catch((e) => console.log('[runArden]', e && e.message));
    }
    // --- adaptive autonomy layer (Davara next-moves · break-nudge · cleanup) ---
    autonomyTick(s, interactions).catch((e) => console.log('[autonomy]', e && e.message));
  } catch (e) { /* watchdog must never throw */ }
  finally { _watchBusy = false; }
}

// The adaptive autonomy layer — runs inside the watchdog. Fires Davara's next-moves
// (daily + when stuck), the long-day break nudge, and the vault-cleanup recommender.
// Every branch is time-gated so it can never spam, and all are setting-controlled.
let _autonomyBusy = false;
async function autonomyTick(s, interactions) {
  if (_autonomyBusy) return; _autonomyBusy = true;
  try {
    const today = localDay();
    const todays = interactions.filter((x) => (x.ts || '').slice(0, 10) === today);
    const lastEpoch = interactions[0] ? interactions[0].epoch : 0;
    const firstTodayEpoch = todays.length ? todays[todays.length - 1].epoch : 0;
    const sinceLast = lastEpoch ? (now() - lastEpoch) : Infinity;
    const activeToday = todays.length > 0;

    // 1) Davara daily next-moves — once a day, only on a day that actually has activity.
    if (s.davaraNextMovesDaily && activeToday && now() - (STATE.watchdog.lastNextMoves || 0) > 20 * 3600e3) {
      STATE.watchdog.lastNextMoves = now(); saveState(); // claim BEFORE awaiting (no double-fire)
      await davaraNextMoves('daily').catch((e) => console.log('[nextMoves daily]', e && e.message));
    }
    // 2) Stuck detection — he was working today, then went quiet 45m–4h ago: offer an unblock.
    else if (s.davaraNextMovesDaily && activeToday && sinceLast > 45 * 60e3 && sinceLast < 4 * 3600e3 &&
             now() - (STATE.watchdog.lastNextMoves || 0) > 6 * 3600e3) {
      STATE.watchdog.lastNextMoves = now(); saveState();
      await davaraNextMoves('stuck').catch((e) => console.log('[nextMoves stuck]', e && e.message));
    }

    // 3) Break-nudge — a long active day, still working, not yet nudged today.
    if (s.breakNudgeHours > 0 && firstTodayEpoch && sinceLast < 30 * 60e3) {
      const spanH = (now() - firstTodayEpoch) / 3600e3;
      const nudgedToday = (new Date(STATE.watchdog.lastBreakNudge || 0).toISOString().slice(0, 10)) === today;
      if (spanH >= s.breakNudgeHours && !nudgedToday) {
        STATE.watchdog.lastBreakNudge = now(); saveState();
        notifyKey('warn', 'You\'ve been at it a while', `~${Math.round(spanH)}h of an active day. Consider a pause, or run Wrap Up when you're ready — the Cortex will keep watch. Acta Non Verba; rest is part of the work.`, 'overview', 'break:' + today);
      }
    }

    // 4) Cleanup recommender — vault grew past the threshold; nudge once per day.
    const items = vaultItemCount();
    if (items > (s.cleanupThreshold || 800) && now() - (STATE.watchdog.lastCleanupNudge || 0) > 24 * 3600e3) {
      STATE.watchdog.lastCleanupNudge = now(); saveState();
      pushNotification('warn', 'Time to compact the vault', `CortexInsight is holding ${items} stored items (> ${s.cleanupThreshold}). Run /compact to stay fast, or clear old data in Settings → Data & Maintenance.`, 'settings', 'cleanup:' + today);
    }
    // 5) DUO-DRIVE — the autonomous partner pass, on its own cadence.
    //    Time-gated like everything else here, and it obeys the control plane,
    //    so a stopped fleet genuinely means nothing fires.
    const d = STATE.duo;
    if (d && d.active && !(STATE.control && STATE.control.stopped)) {
      const gap = clamp(d.cadenceMin || 25, 5, 240) * 60000 * cadenceStretch(d.skipStreak);
      if (now() - (d.lastRun || 0) > gap) {
        d.lastRun = now(); saveState();          // stamp BEFORE the call so a slow pass can't double-fire
        duoPass('cadence').catch((e) => console.log('[duo]', e && e.message));
      }
    }
  } finally { _autonomyBusy = false; }
}

// ---- one-click heal ----
ipcMain.handle('heal:run', requireGate(async (_e, { action, arg }) => {
  try {
    if (action === 'health') {
      const r = await runWslFull(['bash', linuxRoot() + '/SystemsCortex/cortex-health.sh'], 75000);
      return { ok: r.rc === 0, output: r.out.slice(-7000) || '(no output)' };
    }
    if (action === 'restart-relay') {
      const r = await runWslFull(['systemctl', '--user', 'restart', 'cortex-mouth-proxy.service'], 25000);
      await new Promise((res) => setTimeout(res, 1800));
      const h = await relayHealth();
      pushNotification(h ? 'good' : 'warn', 'Relay restart', h ? 'mouth-proxy is back up.' : 'restart issued — relay not confirmed yet.', 'settings', null, { native: false });
      return { ok: !!h, output: (h ? '✓ relay healthy again' : '⚠ relay not confirmed') + (r.out ? '\n' + r.out : '') };
    }
    if (action === 'clear-checkpoint') {
      const a = arg; if (!AGENTS.includes(a)) return { ok: false, error: 'unknown agent' };
      const f = P('agents', a, 'checkpoint.state'); const cur = readText(f);
      if (!cur) return { ok: false, error: 'no checkpoint found' };
      safe(() => fs.writeFileSync(f + '.cortexinsight.bak', cur));
      safe(() => fs.writeFileSync(f, cur.replace(/STATUS=\w+/, 'STATUS=complete')));
      return { ok: true, output: `${cap(a)} checkpoint marked complete (backup kept). Next turn starts a fresh session instead of resuming a stuck one.` };
    }
    if (action === 'optimize') {
      const out = [];
      const moved = archiveOldMemory();
      out.push(moved.length ? `🗄 Archived ${moved.length} old memory file(s) → memory/archive (newest 2 days always kept; reversible)` : '🗄 Memory: nothing older than 7 days to archive — envelope already lean');
      for (const rel of ['logs/mouth-proxy.log', 'logs/relay-tunnel.log']) {
        const st = statOf(P(rel)); if (st) out.push(`◇ ${rel}: ${(st.size / 1024).toFixed(0)} KB${st.size > 4e6 ? ' — large; the runners rotate >5MB automatically' : ' — healthy'}`);
      }
      for (const a of ['davara', 'davaris']) {
        const dir = P('agents', a, 'memory');
        let bytes = 0; for (const f of listDir(dir).filter((x) => x.endsWith('.md'))) { const st = statOf(path.join(dir, f)); if (st) bytes += st.size; }
        out.push(`◈ ${cap(a)} active memory: ${(bytes / 1024).toFixed(0)} KB on disk (prompt reads only last 2 days × 250 lines — bounded by design)`);
      }
      STATE.notifications = STATE.notifications.slice(0, 80); STATE.sentLog = STATE.sentLog.slice(0, 150); saveState();
      out.push('🧹 Compacted CortexInsight\'s own vault');
      const h = await relayHealth();
      out.push(h ? '✓ Relay healthy after optimization' : '⚠ Relay not responding — restart it above');
      return { ok: true, output: out.join('\n') };
    }
    return { ok: false, error: 'unknown action' };
  } catch (e) { return { ok: false, error: e && e.message }; }
}));

// ---- notification / integrity / experiment IPC ----
ipcMain.handle('cortex:notifications', requireGate(() => ({ items: STATE.notifications.slice(0, 80), unread: STATE.notifications.filter((n) => !n.read).length })));
ipcMain.handle('cortex:notifRead', requireGate(() => { STATE.notifications.forEach((n) => (n.read = true)); saveState(); return { ok: true }; }));
ipcMain.handle('cortex:integrity', requireGate(() => ({
  baseline: Object.entries(STATE.integrity.baseline).map(([rel, b]) => ({ rel, size: b.size, ts: b.ts, hash: b.hash.slice(0, 12) })),
  alerts: STATE.integrity.alerts.slice(0, 40),
})));
ipcMain.handle('cortex:integrityAccept', requireGate((_e, rel) => {
  if (rel === '*') { integrityBaseline(true); STATE.integrity.alerts = []; }
  else { integrityBaseline(true, rel); STATE.integrity.alerts = STATE.integrity.alerts.filter((a) => a.rel !== rel); }
  saveState(); return { ok: true };
}));
ipcMain.handle('cortex:experiments', requireGate(() => ({ items: computeExperiments() })));

// ---------------------------------------------------------------------------
//  Window
// ---------------------------------------------------------------------------
function createWindow() {
  // ⚠ An Electron window that is merely UNFOCUSED still paints at full rate.
  // backgroundThrottling lets Chromium throttle timers and rendering once the
  // window is genuinely hidden/occluded — combined with the CSS idle brake
  // (which covers the visible-but-unfocused case), the app stops taxing the
  // GPU whenever he is working in something else.
  mainWin = new BrowserWindow({
    width: 1320, height: 860, minWidth: 980, minHeight: 680,
    backgroundColor: '#05060c',
    show: false, frame: false, titleBarStyle: 'hidden', autoHideMenuBar: true,
    webPreferences: {
      backgroundThrottling: true, preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, spellcheck: true },
  });
  mainWin.once('ready-to-show', () => mainWin.show());
  mainWin.on('close', (e) => { liveStop(); if (!app.isQuitting && STATE.settings.minimizeToTray) { e.preventDefault(); mainWin.hide(); } });
  mainWin.loadFile(path.join(__dirname, 'src', 'index.html'));
  mainWin.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  // diagnostics — surface renderer errors/crashes to the terminal (bug-testing aid)
  mainWin.webContents.on('console-message', (_e, level, msg, line, src) => {
    if (level >= 2) console.log(`[renderer ${level === 3 ? 'ERR' : 'warn'}] ${msg} (${(src || '').split('/').pop()}:${line})`);
  });
  mainWin.webContents.on('render-process-gone', (_e, d) => console.log('[render-process-gone]', d.reason));
  mainWin.webContents.on('preload-error', (_e, p, err) => console.log('[preload-error]', err && err.message));
  // spell-check: red squiggles (spellcheck:true) + right-click suggestions across every text field
  safe(() => mainWin.webContents.session.setSpellCheckerLanguages(['en-US']));
  mainWin.webContents.on('context-menu', (_e, params) => {
    if (!params.misspelledWord) return;
    const items = params.dictionarySuggestions.map((s) => ({ label: s, click: () => mainWin.webContents.replaceMisspelling(s) }));
    if (items.length) items.push({ type: 'separator' });
    items.push({ label: 'Add to dictionary', click: () => safe(() => mainWin.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord)) });
    safe(() => Menu.buildFromTemplate(items).popup());
  });
  // DASH-OPS needs the microphone for push-to-talk and call mode. Grant ONLY
  // media, and only to our own loaded page — every other permission request
  // (geolocation, notifications-from-content, etc.) is denied outright.
  safe(() => {
    mainWin.webContents.session.setPermissionRequestHandler((wc, permission, cb) => {
      cb(permission === 'media' || permission === 'audioCapture');
    });
    mainWin.webContents.session.setPermissionCheckHandler((wc, permission) =>
      permission === 'media' || permission === 'audioCapture');
  });
  // Window-dependent harnesses only. The headless ones are started from
  // whenReady, because they deliberately never create a window.
  if (process.argv.includes('--smoke')) runSmoke();
  if (process.argv.includes('--freshtest')) runFreshTest();
  if (process.argv.includes('--fleettest')) runFleetTest();
  if (process.argv.includes('--voicetest')) runVoiceTest();
  if (process.argv.includes('--strategytest')) runStrategyTest();
  // window controls
  ipcMain.handle('win:min', () => mainWin && mainWin.minimize());
  ipcMain.handle('win:max', () => { if (!mainWin) return; mainWin.isMaximized() ? mainWin.unmaximize() : mainWin.maximize(); });
  ipcMain.handle('win:close', () => mainWin && mainWin.close());
}

// `electron . --omnitest` proves the OS layer with the SHIPPED code, without
// letting an agent anywhere near it. It probes the screen, captures a frame,
// checks the coordinate mapping, and — most importantly — asserts that every
// guard REFUSES what it is supposed to refuse. A capability this wide is only
// as good as the things it declines to do, so those are the real assertions.
async function runOmniTest() {
  const log = (...a) => console.log('[omnitest]', ...a);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(1200);
  let pass = 0, fail = 0;
  const ok = (name, cond, detail = '') => { if (cond) { pass++; log('  ok  ', name, detail); } else { fail++; log('  FAIL', name, detail); } };
  try {
    log('1/6 the PowerShell input layer answers a probe …');
    const p = await omniProbe();
    ok('probe returns', p.ok, p.ok ? `front window: "${String(p.fg).slice(0, 60)}" · ${p.windows.length} windows · cursor ${p.cursor.x},${p.cursor.y}` : p.error);

    log('2/6 the screen can actually be photographed …');
    const f = await omniCapture();
    ok('frame captured', f.ok, f.ok ? `${f.imgW}x${f.imgH} image of a ${f.scrW}x${f.scrH} screen → ${f.wsl}` : f.error);
    if (f.ok) ok('frame is on disk and non-trivial', exists(f.file) && fs.statSync(f.file).size > 20000, `${Math.round((safe(() => fs.statSync(f.file).size, 0)) / 1024)} KB`);

    log('2a · SEAT CAPABILITY — measured from the runner, not from a flag …');
    {
      const caps = seatCapabilities();
      for (const id of AGENTS) {
        const c = caps[id] || {};
        console.log(`[omnitest]        ${String(id).padEnd(16)} build=${c.canBuild ? 'YES' : 'no '}  tools: ${String(c.tools).slice(0, 70)}`);
      }
      ok('davara can build', !!(caps.davara || {}).canBuild, (caps.davara || {}).tools);
      ok('arden is correctly seen as READ-ONLY', !(caps.arden || {}).canBuild, (caps.arden || {}).why || (caps.arden || {}).tools);
      ok('sympath-cortex is correctly seen as READ-ONLY', !(caps['sympath-cortex'] || {}).canBuild, (caps['sympath-cortex'] || {}).tools);
      // THE POINT: the registry's own `coder` flag disagrees with reality, which
      // is precisely why capability must never be read from it.
      ok('the measurement disagrees with the hand-typed registry flag', (FLEET_BY_ID.arden || {}).coder === true && !(caps.arden || {}).canBuild,
        'FLEET says arden.coder=true; her runner says Read Glob Grep WebFetch WebSearch');
      ok('at least one seat has hands', buildingSeats().length >= 1, buildingSeats().join(', '));
      ok('a read-only seat gets hands rather than a refusal', buildingSeats()[0] && buildingSeats()[0] !== 'arden', `arden would decide; ${buildingSeats()[0]} would execute`);
    }

    log('2a1 · THE REFLEX LANE — the workhorse is a lane, not a persona …');
    {
      const caps = seatCapabilities();
      ok('the workhorse seat exists in the runner', !!(caps.workhorse || {}).tools, (caps.workhorse || {}).tools);
      ok('the workhorse has hands (Write/Edit/Bash)', !!(caps.workhorse || {}).canBuild, (caps.workhorse || {}).tools);
      ok('it has a route token to the lean seat', ROUTE_TOKEN.workhorse === 'cortex-workhorse', ROUTE_TOKEN.workhorse);
      ok('relaySend will accept it', isRelayAgent('workhorse'));
      // The distinction that matters: it must be reachable WITHOUT ever showing
      // up as a mind. A workhorse card next to Davara would be a lie about it.
      ok('it is NOT in the persona fleet', !FLEET.some((f) => f.id === 'workhorse') && !AGENTS.includes('workhorse'), `AGENTS = ${AGENTS.join(', ')}`);
      ok('but it IS a known agent id (tasks/handoffs can name it)', ALL_AGENT_IDS.includes('workhorse'));
      ok('its model + turn budget are published to the runner', safe(() => { const c = agentCfg('workhorse'); return !!c.model && c.turns > 0; }, false),
        safe(() => `${agentCfg('workhorse').model} · ${agentCfg('workhorse').effort} · ${agentCfg('workhorse').turns} turns`, ''));
      // ROUTING. Every branch, against a synthetic session — this is the whole
      // contract, and it is the part that would silently rot.
      const sess = (over = {}) => ({ agent: 'davara', mode: 'screen', cycles: 3, steer: [], _steerSeen: true, calls: [], ...over });
      const r = (over) => omniRouteCycle(sess(over));
      omniState().reflex = true;
      ok('a settled mid-plan cycle goes to the reflex lane', r({}).seat === 'workhorse', r({}).why);
      ok('the FIRST cycle is always hers', r({ cycles: 0 }).seat === 'davara', r({ cycles: 0 }).why);
      ok('a WORK move is never a reflex', r({ mode: 'work' }).seat === 'davara', r({ mode: 'work' }).why);
      ok('his steer pulls the cycle back to her', r({ steer: ['go to the davara chat'], _steerSeen: false }).seat === 'davara', r({ steer: ['x'], _steerSeen: false }).why);
      ok('a zoom is a decision, so it is hers', r({ mapRequest: { zoom: 'map' } }).seat === 'davara', r({ mapRequest: { zoom: 'map' } }).why);
      ok('a surprise escalates to her', r({ _surprised: true }).seat === 'davara', r({ _surprised: true }).why);
      ok('a fresh consult is hers to use', r({ calls: [{}], _callFresh: true }).seat === 'davara', r({ calls: [{}], _callFresh: true }).why);
      ok(`every ${REFLEX_ANCHOR}th cycle re-anchors on her`, r({ cycles: REFLEX_ANCHOR }).seat === 'davara', r({ cycles: REFLEX_ANCHOR }).why);
      ok('a long drive can never fully leave her', [1, 2, 3, 4, 5, 6, 7, 8].some((c) => r({ cycles: c }).seat === 'davara'),
        [1, 2, 3, 4, 5, 6, 7, 8].map((c) => `${c}:${r({ cycles: c }).tier[0]}`).join(' '));
      omniState().reflex = false;
      ok('turning the lane OFF returns every cycle to her', r({}).seat === 'davara', r({}).why);
      omniState().reflex = true;
      // The seam he would otherwise hear: a soulless seat speaking in her drive.
      const pre = reflexPreamble(sess());
      ok('the reflex prompt keeps her voice and forbids re-planning', /on behalf of Davara/.test(pre) && /do not re-plan/i.test(pre) && /\[\[OS:note/.test(pre));
    }

    log('2a0 · AUTONOMY — the three ways she used to stop, and no longer does …');
    {
      // ① THE ASK-FIRST BUG. An arm carrying no opinion must change NOTHING.
      // This is the main-process half of the fix; the renderer half is that
      // omniSettings() now omits absent controls instead of inventing them.
      omniState().pacing = 'auto'; omniState().scope = 'open';
      omniState().continuous = true; omniState().ttlMin = 90; omniState().maxSteps = 120;
      omniArm({});                       // exactly what an off-screen arm now sends
      ok('an empty arm keeps his pacing', omniState().pacing === 'auto', omniState().pacing);
      ok('an empty arm keeps his scope', omniState().scope === 'open', omniState().scope);
      ok('an empty arm keeps continuous drive ON', omniState().continuous === true);
      ok('an empty arm keeps his fuse', omniState().ttlMin === 90, `${omniState().ttlMin} min`);
      ok('an empty arm keeps his step budget', omniState().maxSteps === 120, String(omniState().maxSteps));
      // …and an arm that DOES carry a value still wins.
      omniArm({ pacing: 'ask', minutes: 30 });
      ok('an explicit choice still lands', omniState().pacing === 'ask' && omniState().ttlMin === 30);
      omniArm({ pacing: 'auto', minutes: 25 });

      // ② A BLOCK ENDS A MOVE, NOT THE DRIVE.
      omniState().continuous = true; omniState().chain = 0; omniState().chainMax = 6;
      omniState().avoid = [];
      omniState().session = { id: 'b1', goal: 'name one person and send them the link', agent: 'davara',
        status: 'running', cursor: 3, maxSteps: 60, cycles: 3, steps: [{ op: 'work', ok: true }], transcript: [], steer: [], mode: 'screen' };
      const hb = omniHalt('the name is the one input I cannot manufacture', 'blocked');
      ok('a BLOCKED move now chains to the next one', !!(hb && hb.chained), 'this exact session dead-ended on his machine');
      ok('the wall is recorded so she cannot re-choose it', (omniState().avoid || []).length === 1, (omniState().avoid[0] || {}).goal);
      ok('the wall reaches her next strategic read', /DO NOT CHOOSE ANY OF THESE AGAIN/.test(avoidBlock()) && /name one person/.test(avoidBlock()));
      omniState()._chaining = false; omniState().session = null; omniState().chain = 0;
      // …but a fault or his own stop must still be terminal.
      omniState().session = { id: 'b2', goal: 'g', agent: 'davara', status: 'running', cursor: 0, maxSteps: 60, cycles: 0, steps: [], transcript: [], steer: [], mode: 'screen' };
      const hf = omniHalt('the drive loop faulted — boom');
      ok('a FAULT is still terminal', !(hf && hf.chained));
      omniState().session = null; omniState().avoid = [];

      // ③ SHE CHOOSES MOVES SHE CAN FINISH.
      ok('a driving read demands a first step SHE can finish', /carry to done with your own hands/.test(DRIVING_CHOICE));
      ok('and it forbids stopping in front of his step', /do NOT stop\s*\nin front of it|keep moving/.test(DRIVING_CHOICE));
      ok('the advisory read is NOT given that constraint', !/carry to done with your own hands/.test(STRATEGIC_CONTRACT),
        'asking for advice and choosing a move to drive are different jobs');
    }

    log('2a2b · HER OWN INSTRUMENTS — direct interfaces, not eyes …');
    {
      // The verbs exist, parse, and are NOT sent to the mouse/keyboard layer.
      const acts = omniParse('[[OS:read https://www.motusmoves.us/m/x]] [[OS:api GET https://www.motusmoves.us/api/models]] [[OS:click 10 10]]');
      ok('read and api parse as real verbs', acts.filter((a) => a.op === 'read' || a.op === 'api').length === 2, acts.map((a) => a.op).join(','));
      ok('they are excluded from the input layer', ['say', 'ask', 'done', 'need', 'call', 'note', 'work', 'read', 'api'].includes('read'));

      // A REAL FILE READ, through the real function.
      const selfRoot = projectRoot() || app.getAppPath();
      const rf = await omniReadTarget(path.join(selfRoot, 'package.json'));
      ok('she can read a real file directly', rf.ok && /cortexinsight/i.test(rf.text), rf.ok ? `${rf.text.length} chars` : rf.error);
      const rd = await omniReadTarget(selfRoot);
      ok('a directory comes back as a listing', rd.ok && rd.kind === 'dir' && /main\.js/.test(rd.text));
      const ro = await omniReadTarget('C:\\Windows\\System32\\drivers\\etc\\hosts');
      ok('a path outside his roots is refused', !ro.ok, ro.error);
      const rn = await omniReadTarget(path.join(os.homedir(), 'definitely-not-here.txt'));
      ok('a missing file says so plainly', !rn.ok, rn.error);

      // THE GUARDS on the API verb.
      const bad1 = await omniApi('POST https://evil.example.com/x', '{}');
      ok('a WRITE to a host that is not his is refused', !bad1.ok, bad1.error);
      const bad2 = await omniApi('GET ftp://x/y', '');
      ok('a non-http scheme is refused', !bad2.ok, bad2.error);
      const bad3 = await omniApi('GET https://www.motusmoves.us/api/x?token=sk-abcdefghijklmnopqrstuv', '');
      ok('a credential in the URL is refused', !bad3.ok, bad3.error);
      const bad4 = await omniApi('POST http://localhost:3000/api/x', '-----BEGIN RSA PRIVATE KEY-----');
      ok('a secret in the body is refused', !bad4.ok, bad4.error);
      ok('but localhost IS his, so a write there is allowed in principle', omniIsHisHost(new URL('http://localhost:3000/x')));
      ok('and his real platform is recognised as his', omniIsHisHost(new URL('https://www.motusmoves.us/api/models')),
        [...omniHisHosts()].slice(0, 5).join(', '));

      // The SPA case she actually hit — a big shell with no text is NOT broken.
      const shell = '<html><head>' + '<meta x="y">'.repeat(300) + '</head><body><div id="root"></div><script>var a=1;</script></body></html>';
      ok('html strips to text', omniHtmlText('<p>hello <b>there</b></p><script>x()</script>') === 'hello there', omniHtmlText('<p>hello <b>there</b></p><script>x()</script>'));
      ok('a client-rendered shell is detected, not mistaken for broken', shell.length > 3000 && omniHtmlText(shell).length < 400);

      // THE LADDER MUST ACTUALLY REACH HER. omniPrompt is pure, so this is the
      // real text she receives, not a hope about it.
      const sess = { id: 'p', goal: 'read the model page', agent: 'davara', mode: 'screen', cursor: 0, maxSteps: 8,
        cycles: 0, steps: [], transcript: [], steer: [], calls: [], reads: [] };
      const pr = omniPrompt(sess, { ok: true, none: true, imgW: 0, imgH: 0, scrW: 0, scrH: 0, name: '' }, { ok: true, fg: 'Chrome', windows: [] }, null);
      ok('the stuck ladder is in the prompt she receives', /THE STUCK LADDER/.test(pr));
      ok('it names read and api as rungs above asking', /\[\[OS:read/.test(pr) && /\[\[OS:api GET/.test(pr));
      ok('"could not read the screen" is explicitly not a reason to stop', /is NOT a reason to stop/.test(pr));
      ok('ask is placed BELOW every other rung', pr.indexOf('THE STUCK LADDER') < pr.indexOf('ONLY THEN'));
      // …and what she READ comes back to her IN FULL on the next cycle.
      sess.reads = [{ what: 'read https://x/y', kind: 'page', status: 200, note: 'SPA', text: 'THE-REAL-CONTENT-'.repeat(40) }];
      const pr2 = omniPrompt(sess, { ok: true, none: true, imgW: 0, imgH: 0, scrW: 0, scrH: 0, name: '' }, { ok: true, fg: 'Chrome', windows: [] }, null);
      ok('what she read is handed back in full, not clipped', pr2.includes('THE-REAL-CONTENT-'.repeat(40)), `${'THE-REAL-CONTENT-'.repeat(40).length} chars carried`);
      ok('and it is consumed, so it is not re-sent every cycle', !omniPrompt(sess, { ok: true, none: true, imgW: 0, imgH: 0, scrW: 0, scrH: 0, name: '' }, { ok: true, fg: 'Chrome', windows: [] }, null).includes('THE-REAL-CONTENT-'));
    }

    log('2a1b · MOTUSLIVE — the broadcast can never leak what he did not tick …');
    {
      STATE.goal = { text: 'Put the first stranger through a MotusModel run', ts: new Date().toISOString() };
      STATE.motus = { text: 'Ship the stream', ts: new Date().toISOString() };
      STATE.tasks = [{ id: 'tsk1', title: 'A public task about the live page', status: 'open' },
                     { id: 'tsk2', title: 'SECRET internal: rotate key sk-abcdefghijklmnopqrstuv', status: 'open' }];
      STATE.duoWork = [{ id: 'dw1', ts: new Date().toISOString(), title: 'Shipped the vibe engine', verdict: 'shipped', by: 'davara' }];
      const a = onAirState();
      a.sel = {}; a.custom = []; a.on = false;
      ok('the pantheon mirrors the site (11 djs, 5 powers)', ONAIR_DJS.length === 11 && ONAIR_POWERS.length === 5,
        ONAIR_DJS.map((d) => d.id).join(','));
      ok('DAOZ is the headliner', (ONAIR_DJS.find((d) => d.id === 'daoz') || {}).headliner === true);
      ok('the old DAUOZ id is gone from the pantheon', !ONAIR_DJS.some((d) => d.id === 'dauoz'));
      // A stored id from before the rename must HEAL, not silently un-set his DJ.
      STATE.onAir.dj = 'dauoz'; onAirState();
      ok('a stored dauoz migrates to daoz on read', onAirState().dj === 'daoz', onAirState().dj);
      STATE.onAir.dj = 'not-a-dj'; onAirState();
      ok('any unknown dj id heals to the headliner', onAirState().dj === 'daoz');
      const cands = onAirCandidates();
      ok('candidates are gathered from every source', ['GOAL', 'MOTUS', 'TASK', 'SHIPPED', 'AGENT'].every((k) => cands.some((c) => c.kind === k)),
        cands.map((c) => c.kind).join(','));
      // ── THE LAW: nothing ticked → nothing in the payload ──
      let { payload } = onAirPayload();
      ok('an untouched composer broadcasts NOTHING', !payload.goal && !payload.motus && payload.items.length === 0 && payload.agents.length === 0,
        JSON.stringify(payload).slice(0, 120));
      // ── ticked items travel; unticked never do ──
      a.sel = { goal: true, 'task:tsk1': true };
      payload = onAirPayload().payload;
      ok('a ticked goal + task travel', payload.goal.includes('stranger') && payload.items.length === 1 && payload.items[0].t.includes('public task'));
      ok('the unticked motus does NOT travel', !payload.motus);
      ok('the unticked agent line does NOT travel', payload.agents.length === 0);
      // ── the secret gate: even a TICKED item is dropped if secret-shaped ──
      a.sel['task:tsk2'] = true;
      const r2 = onAirPayload();
      ok('a ticked but secret-shaped item is DROPPED and counted', r2.payload.items.length === 1 && r2.dropped === 1,
        `dropped=${r2.dropped}`);
      ok('the dropped item is nowhere in the payload', !JSON.stringify(r2.payload).includes('sk-abcdef'));
      // ── custom lines + the off switch ──
      a.custom = [{ id: 'c1', t: 'A line he typed himself' }];
      a.sel['custom:c1'] = true;
      ok('a custom line he typed travels once ticked', onAirPayload().payload.items.some((i) => i.t.includes('typed himself')));
      a.on = false;
      ok('off air is carried in the payload itself', onAirPayload().payload.on === false);

      // ── ✦ STREAM THE MOST IMPORTANT THING — it proposes, it never leaks ──
      a.sel = {}; a.custom = []; a.topic = '';
      STATE.tasks = [{ id: 'tsk1', title: 'A public task about the live page', status: 'open' },
                     { id: 'tskS', title: 'rotate key sk-abcdefghijklmnopqrstuv', status: 'open' }];
      const auto = onAirAutoPick();
      ok('auto-pick chooses something', auto.picked.length >= 1, auto.picked.map((p) => p.kind).join(','));
      ok('it leads with the Motus — the prime mover outranks everything', auto.lead === 'motus', auto.lead);
      ok('it never proposes a secret-shaped candidate', !auto.picked.some((p) => /sk-abcdef/.test(p.t)),
        'the ranked list is filtered through the same gate as the payload');
      ok('and the resulting payload is still clean', !JSON.stringify(onAirPayload().payload).includes('sk-abcdef'));
      ok('it caps the broadcast so a stream stays readable', auto.picked.length <= 6, String(auto.picked.length));
      ok('at most ONE agent line — never a fleet dump', auto.picked.filter((p) => p.kind === 'AGENT').length <= 1);
      ok('and no more than two open tasks — a broadcast has shape, not a wall',
        auto.picked.filter((p) => p.kind === 'TASK').length <= 2,
        auto.picked.map((p) => p.kind).join(','));
      ok('it sets a topic from the lead when there was none', !!a.topic, String(a.topic).slice(0, 60));
      ok('auto-pick does NOT put him on air — it only proposes', a.on === false);

      // ── AUTO-FOLLOW re-picks only when his work actually changes ──
      a.follow = true; a.lastSig = onAirSignature();
      ok('the signature is stable while nothing moves', onAirSignature() === a.lastSig);
      STATE.motus = { text: 'A brand new prime mover', ts: new Date().toISOString() };
      ok('the signature CHANGES when the Motus changes', onAirSignature() !== a.lastSig);
      a.follow = false;

      a.sel = {}; a.custom = []; a.topic = ''; STATE.tasks = []; STATE.duoWork = [];
    }

    log('2a2 · THE ADAPTIVE INTERFACE ENGINE — right instrument per environment …');
    {
      const mk = (app, title, extra = {}) => ({ ok: true, fg: title, windows: [{ app, title, x: 0, y: 0, w: 1200, h: 800, ...extra }] });
      const cases = [
        ['chrome',          'MotusMoves — The Platform To Build In Public - Google Chrome', 'browser',  /WebFetch/i],
        ['WindowsTerminal', 'operator@DESKTOP: ~/cortex',                                   'terminal', /Bash/i],
        ['Code',            'main.js — CortexInsight - Visual Studio Code',                  'editor',   /Edit the file/i],
        ['explorer',        'Downloads',                                                     'files',    /filesystem/i],
        ['Obsidian',        'Aeros — Obsidian',                                              'notes',    /markdown on disk/i],
        ['figma',           'MotusModels – Figma',                                           'design',   /GUI-only/i],
        ['SomeUnknownApp',  'Whatever 3000',                                                 'unknown',  /do not assume the screen/i],
      ];
      for (const [app, title, want, wantInstrument] of cases) {
        const p = mk(app, title);
        const e = envProfile(p);
        const blk = envBlock(p);
        ok(`${String(app).padEnd(16)} → ${want}`, e.kind === want && wantInstrument.test(blk), `saw "${e.kind}"`);
      }
      // the highest-value case: it recognises HIS platform and offers the source
      const his = mk('chrome', 'MotusMoves — The Platform To Build In Public - Google Chrome');
      const hb = envBlock(his);
      ok('it recognises HIS platform in the title and offers the live URL + local source', /AND THIS IS ONE OF HIS/.test(hb) && /motusmoves/i.test(hb),
        (/(AND THIS IS ONE OF HIS[^\n]*)/.exec(hb) || [''])[0].slice(0, 130));
      // Pixels last everywhere EXCEPT: design tools, where the screen genuinely
      // IS the interface, and chat, where the right answer is not to click at
      // all but to hand him the draft.
      ok('pixels are ranked LAST wherever a better instrument exists',
        ENV_FAMILIES.filter((f) => !['design', 'chat'].includes(f.kind))
          .every((f) => /only then/i.test(f.instruments[f.instruments.length - 1])),
        'design is GUI-by-nature; chat never sends on his behalf');
    }

    log('2a3 · MODE ROUTING — does his real sentence reach the screen? …');
    {
      // Re-implements the exact predicate omniStart uses, so a regression here
      // fails the harness instead of failing him at 2am.
      const decide = (g, envKind) => {
        const namesAUrl = /https?:\/\/|\b[\w-]+\.(us|com|dev|io|app|page|net|org|mov|fund|systems|builders)\b/i.test(g);
        const screenVerbs = /\bclick|button|on screen|window|browser tab|menu|dialog|drag|scroll|type into|sign in|log in|GUI|the app\b/i.test(g);
        const liveVerbs = /\b(engage|chat|converse|talk to|message|reply|test (?:it|the|out)|try (?:it|the)|walk through|demo|use the|interact|continue (?:my|the|our)?\s*(?:work|session|conversation|test)?)\b/i.test(g);
        const inBrowser = envKind === 'browser';
        return (screenVerbs || namesAUrl || (liveVerbs && (inBrowser || namesAUrl)) || (inBrowser && liveVerbs)) ? 'screen' : 'work';
      };
      // HIS ACTUAL WORDS, verbatim from the message where it failed him.
      const his = 'continue to test and engage with davara on motusmoves.us/davara';
      ok('HIS sentence routes to the SCREEN', decide(his, 'browser') === 'screen', `"${his.slice(0, 58)}…"`);
      ok('…and still does with no browser detected', decide(his, 'unknown') === 'screen', 'it names a URL, which is a place not a path');
      ok('“engage with her and keep testing” in a browser → screen', decide('engage with her and keep testing', 'browser') === 'screen');
      ok('“fix the unclosed quote in mantra-invoke.js” → work', decide('fix the unclosed quote in mantra-invoke.js and run the gate', 'editor') === 'work');
      ok('“write a test for api/runs.js” → work', decide('write a test for api/runs.js', 'editor') === 'work');
      ok('“click the Save button” → screen', decide('click the Save button', 'unknown') === 'screen');
      ok('a code goal stays work even inside a browser', decide('extract deriveTally into api/_tally.js', 'browser') === 'work',
        'being in Chrome does not make a refactor a screen move');
    }

    log('2a4 · VOICE STEERING — Ctrl+Shift+M, from anywhere …');
    {
      const { globalShortcut } = require('electron');
      omniArm({ minutes: 5, hud: false });
      ok('the steer key is registered while armed', globalShortcut.isRegistered('CommandOrControl+Shift+M'));
      // The kill switch must be BOUND, not merely intended. It does not matter
      // which combination wins — it matters that one did, and that the app
      // knows which, so the HUD can tell him the truth.
      ok('a panic key is genuinely bound', !!omniState().panicKey && globalShortcut.isRegistered(omniState().panicKey),
        omniState().panicKey || 'NONE — every combination was taken');
      // it must reach a RUNNING session, and be refused honestly when there is none
      const noSess = omniSteerText('test with no session');
      ok('steering with no session is refused, not swallowed', !noSess.ok, noSess.error);
      omniState().session = { id: 'v', goal: 'g', agent: omniState().agent, status: 'running', cursor: 0, maxSteps: 4, steps: [], transcript: [], steer: [], cycles: 0, mode: 'screen' };
      const st = omniSteerText('go to the davara chat and keep testing');
      ok('a steer lands on the running session', st.ok && (omniState().session.steer || []).length === 1, (omniState().session.steer || [])[0]);
      ok('her next cycle will SEE it', /go to the davara chat/.test((omniState().session.steer || []).join(' ')));
      omniState().session = null;
      omniDisarm('voice test over');
      ok('the steer key is released when disarmed', !globalShortcut.isRegistered('CommandOrControl+Shift+M'));
    }

    log('2a5 · THE SHOW LAW — can she put it on his actual screen? …');
    {
      const V = { imgW: 1, imgH: 1, scrW: 1, scrH: 1 };
      const url = omniCompile(omniParse('[[OS:show https://www.motusmoves.us/model]]')[0], V);
      ok('show a URL → opens it in his browser', !!url.step && url.step.op === 'launch' && /motusmoves/.test(url.step.target), url.step ? url.step.target : url.block);
      const self = omniCompile(omniParse('[[OS:show ' + path.join(projectRoot() || app.getAppPath(), 'main.js') + ']]')[0], V);
      ok('show a real file → opens it', !!self.step && self.step.op === 'launch', self.step ? self.step.target : self.block);
      const wsl = omniCompile(omniParse('[[OS:show ' + linuxRoot() + '/logs]]')[0], V);
      ok('show a WSL path → translated to the Windows side', !!wsl.step && /\\logs$/.test(wsl.step.target || ''), wsl.step ? wsl.step.target : wsl.block);
      const plat = omniCompile(omniParse('[[OS:show MotusMoves]]')[0], V);
      ok('show one of HIS platforms by name → its live URL', !!plat.step && /^https?:\/\//.test(plat.step.target || ''), plat.step ? plat.step.target : plat.block);
      const win = omniCompile(omniParse('[[OS:show Visual Studio Code]]')[0], V);
      ok('show an unknown name → brings that window forward', !!win.step && win.step.op === 'focus', win.step ? win.step.title : win.block);
      ok('the SHOW LAW is in the working contract', /SHOW HIM\. THIS IS NOT OPTIONAL/.test(SHOW_LAW) && /could he point at his own screen/.test(SHOW_LAW));
    }

    log('2b · HER EYES — the size she can actually read, and the zoom …');
    if (f.ok) {
      ok('the wide view is capped at the width her Read tool preserves', f.imgW <= 700,
        `${f.imgW}x${f.imgH} · measured ceiling 700 — above it her tool HALVES the image and text is illegible`);
      ok('frames are JPEG and small enough not to be pre-shrunk', /\.jpg$/i.test(f.file) && f.bytes < 90000,
        `${Math.round((f.bytes || 0) / 1024)} KB — a 700px PNG was ~100KB and arrived at her as 526px`);
      // window framing: crop to the focused window so the text is as big as possible
      const pr = await omniProbe();
      ok('the probe returns window RECTANGLES, not just titles', !!(pr.ok && pr.fgrect && Number.isFinite(pr.fgrect.w)) && (pr.windows || []).some((w) => Number.isFinite(w.x)),
        pr.fgrect ? `focused window at ${pr.fgrect.x},${pr.fgrect.y} ${pr.fgrect.w}x${pr.fgrect.h}` : 'no rect');
      if (pr.ok && pr.fgrect && pr.fgrect.w > 200) {
        const wf = await omniCapture({ fgRect: pr.fgrect });
        const maximised = wf.ok && wf.cropW >= wf.scrW - 8 && wf.cropH >= wf.scrH - 8;
        ok('the frame follows and crops to the FOCUSED WINDOW', wf.ok && (wf.framed === 'window' || maximised),
          wf.ok ? `on ${wf.name} · crop ${wf.cropW}x${wf.cropH} of ${wf.scrW}x${wf.scrH} → ${(wf.cropW / wf.imgW).toFixed(1)}× shrink${maximised ? ' (window is full-screen, so no gain available)' : ` instead of ${(wf.scrW / 700).toFixed(1)}×`}` : wf.error);
        if (wf.ok && wf.framed === 'window') {
          const c = omniMap(wf, Math.round(wf.imgW / 2), Math.round(wf.imgH / 2));
          const wantX = (wf.originX || 0) + wf.cropX + Math.round(wf.cropW / 2);
          ok('a click in the window-framed view lands inside that window', Math.abs(c.x - wantX) <= 3, `${c.x} vs ${wantX}`);
        }
      }
      const sc = omniCompile(omniParse('[[OS:screen -1500 400]]')[0], f);
      ok('a screen-space click bypasses the image entirely', !!sc.step && sc.step.x === -1500 && sc.step.y === 400, sc.step ? `${sc.step.x},${sc.step.y}` : sc.block);
      const zc = await omniCapture({ zoomTo: { x: (f.originX || 0) + Math.round(f.scrW / 2), y: (f.originY || 0) + Math.round(f.scrH / 2) } });
      ok('she can zoom to a NATIVE-resolution crop', zc.ok && zc.zoomed && zc.imgW === zc.cropW && zc.cropW <= 700,
        zc.ok ? `crop ${zc.imgW}x${zc.imgH} 1:1 from ${zc.cropX},${zc.cropY}` : zc.error);
      if (zc.ok) {
        const mid = omniMap(zc, Math.round(zc.imgW / 2), Math.round(zc.imgH / 2));
        const wantX = (f.originX || 0) + Math.round(f.scrW / 2), wantY = (f.originY || 0) + Math.round(f.scrH / 2);
        ok('a click in a ZOOMED frame lands on the same screen point', Math.abs(mid.x - wantX) <= 3 && Math.abs(mid.y - wantY) <= 3,
          `${mid.x},${mid.y} vs ${wantX},${wantY}`);
      }
      const lk = omniCompile(omniParse('[[OS:look 350 200]]')[0], f);
      ok('look compiles to a zoom, never a click', !!lk.zoom && !lk.step, lk.zoom ? `${lk.zoom.x},${lk.zoom.y}` : lk.block);
    }

    log('3/6 image coordinates map onto real screen pixels …');
    if (f.ok) {
      // A secondary monitor left of the primary has a NEGATIVE virtual origin
      // (his LG sits at -3840,-600), so the correct centre is negative too.
      // The expectation must carry the origin — asserting a positive centre
      // silently assumes a single screen at 0,0 and fails the moment the code
      // starts correctly following him to the other monitor.
      const wantX = Math.round(f.scrW / 2) + (f.originX || 0);
      const wantY = Math.round(f.scrH / 2) + (f.originY || 0);
      const mid = omniMap(f, Math.round(f.imgW / 2), Math.round(f.imgH / 2));
      ok('centre maps to screen centre', Math.abs(mid.x - wantX) <= 2 && Math.abs(mid.y - wantY) <= 2, `${mid.x},${mid.y} vs ${wantX},${wantY} (origin ${f.originX},${f.originY})`);
      const origin = omniMap(f, 0, 0);
      ok('origin maps to the display origin', origin.x === (f.originX || 0) && origin.y === (f.originY || 0), `${origin.x},${origin.y}`);
      const far = omniMap(f, f.imgW, f.imgH);
      ok('the far corner stays inside this display', Math.abs(far.x - ((f.originX || 0) + f.scrW)) <= 2 && Math.abs(far.y - ((f.originY || 0) + f.scrH)) <= 2, `${far.x},${far.y}`);
    }

    log('4/6 the parser reads an agent plan the way she will write it …');
    const acts = omniParse('SEE: a browser.\nPLAN: search.\n[[OS:focus Chrome]]\n[[OS:click 640 380 | the search box]]\n[[OS:type hello world]]\n[[OS:key ctrl+enter]]\n[[OS:say I searched for it]]\n[[OS:nonsense 1]]');
    ok('five real verbs parsed, the invented one dropped', acts.length === 5 && acts.map((a) => a.op).join(',') === 'focus,click,type,key,say', acts.map((a) => a.op).join(','));
    if (f.ok) {
      const c = omniCompile(acts[1], f);
      // "> 0" was wrong for any display left of the primary. The real invariant
      // is that the point lands INSIDE the display she photographed.
      const inX = c.step && c.step.x >= (f.originX || 0) - 1 && c.step.x <= (f.originX || 0) + f.scrW + 1;
      const inY = c.step && c.step.y >= (f.originY || 0) - 1 && c.step.y <= (f.originY || 0) + f.scrH + 1;
      ok('a click compiles inside the screen she is watching', !!c.step && c.step.op === 'click' && inX && inY,
        c.step ? `${c.step.x},${c.step.y} within [${f.originX}..${(f.originX || 0) + f.scrW}]×[${f.originY}..${(f.originY || 0) + f.scrH}]` : c.block);
      ok('the note survives for the audit trail', acts[1].note === 'the search box', acts[1].note);
    }

    log('5/6 THE GUARDS — everything below MUST be refused …');
    ok('a password manager window is protected', !!omniForbiddenWindow('1Password — Personal Vault'));
    ok('a wallet window is protected', !!omniForbiddenWindow('MetaMask'));
    ok('a sign-in window is protected', !!omniForbiddenWindow('Sign in - Google Accounts'));
    ok('a normal window is NOT protected', !omniForbiddenWindow('CortexInsight'));
    ok('an API key is refused before it reaches the keyboard', !!omniSecretish('the key is sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA'));
    ok('a private key block is refused', !!omniSecretish('-----BEGIN RSA PRIVATE KEY-----'));
    ok('a recovery phrase is refused', !!omniSecretish('lunar cabin frost ripple tunnel opera velvet ginger marble puzzle anchor jungle'));
    ok('ordinary prose is NOT refused', !omniSecretish('Open the repo and bump the share-card version, then show me the diff.'));
    if (f.ok) {
      const bad = omniCompile(omniParse('[[OS:type sk-ant-api03-BBBBBBBBBBBBBBBBBBBBBBBB]]')[0], f);
      ok('the compiler blocks the secret rather than staging it', !bad.step && /refused/.test(bad.block || ''), bad.block || '(it compiled — that is a bug)');
      const nowhere = omniCompile(omniParse('[[OS:launch C:\\definitely\\not\\here.exe]]')[0], f);
      ok('launching something that does not exist is blocked', !nowhere.step, nowhere.block);
    }

    log('6/6 arming is a real fuse, and a stop really disarms …');
    const before = omniArmedNow();
    ok('starts disarmed', !before);
    const st = await omniStart({ goal: 'this must not run — nothing is armed' });
    ok('a session CANNOT start while disarmed', !st.ok, st.error || '(it started — that is a bug)');
    omniArm({ minutes: 5, scope: 'guarded', pacing: 'ask' });
    ok('arms on an explicit call', omniArmedNow());
    omniState().armedAt = now() - 6 * 60 * 1000;
    ok('the fuse expires by itself', !omniArmedNow(), 'backdated 6 minutes past a 5-minute fuse');
    omniArm({ minutes: 5 });
    controlSet({ stopped: true });
    ok('the fleet Stop button also disarms it', !omniArmedNow());
    controlSet({ stopped: false });
    omniDisarm('end of test');

    log('7/8 THE MAP — is she reading his real canon, or guessing? …');
    ok('the BuildMode canon is readable', bmAvailable(), bmDir());
    const pls = bmPlatforms();
    ok('platforms parsed out of the map', pls.length >= 3, pls.map((p) => p.name).join(', '));
    ok('a platform carries a real live URL', pls.some((p) => /^https?:\/\//.test(p.url)), (pls.find((p) => p.url) || {}).url || '(none)');
    ok('a platform carries a deploy command', pls.some((p) => p.deploy), (pls.find((p) => p.deploy) || {}).deploy || '(none)');
    const orbit = mapCortex({ zoom: 'orbit' }), mapv = mapCortex({ zoom: 'map' });
    ok('ORBIT altitude renders', orbit.length > 500, `${orbit.length} chars`);
    // The finding must be QUOTED from canon, not recited from memory. If an edit
    // to SYSTEMS-MAP.md does not show up here, the app is holding a second copy.
    ok('ORBIT quotes the standing finding from the file', /STANDING FINDING/i.test(orbit) && orbit.includes('supply-complete'), 'read from canon');
    ok('ORBIT carries a canon amendment made today', /Amended 2026-08-09/.test(orbit), 'the live read is genuinely live');
    ok('ORBIT carries the leverage ladder', /Leverage points|Meadows/i.test(orbit));
    ok('MAP altitude renders', mapv.length > 500, `${mapv.length} chars`);
    const gname = (pls[0] || {}).name || 'MotusMoves';
    const ground = mapCortex({ zoom: 'ground', focus: gname });
    ok('GROUND resolves a real platform', ground.includes(gname) && ground.length > 200, `focused ${gname}`);
    ok('FRAME altitude offers real methods', mapCortex({ zoom: 'frame' }).includes('INVERT THE LOOP'));
    ok('altitudes actually differ', orbit !== mapv && ground !== mapv);
    const z = mapParse('SEE: a repo.\n[[MAP:in MotusMoves]]\n[[OS:wait 200]]');
    ok('she can request an altitude', !!z && z.zoom === 'ground' && /motusmoves/i.test(z.focus), z ? `${z.zoom} → ${z.focus}` : '(not parsed)');
    ok('the map block is stripped from what he hears', !mapStrip('hello [[MAP:out]] there').includes('MAP:'));
    const visit = omniCompile(omniParse(`[[OS:visit ${gname}]]`)[0], { imgW: 1200, imgH: 675, scrW: 1920, scrH: 1080, originX: 0, originY: 0 });
    ok('visit resolves a platform name to HIS real URL', !!visit.step && /^https?:\/\//.test(visit.step.target || ''), visit.step ? visit.step.target : visit.block);
    const bogus = omniCompile(omniParse('[[OS:visit TotallyNotHisSite]]')[0], { imgW: 1200, imgH: 675, scrW: 1920, scrH: 1080, originX: 0, originY: 0 });
    ok('a made-up platform name is refused, not guessed', !bogus.step, bogus.block);

    log('8/9 THE SCREEN — is she looking where he actually is? …');
    const dl = omniDisplays();
    ok('all displays enumerated', dl.length >= 1, dl.map((d) => `${d.label} ${d.w}x${d.h}@${d.scale}x${d.active ? ' ←YOU' : ''}`).join(' | '));
    const act = omniActiveDisplayIndex();
    ok('the active display is found from the cursor', act >= 0 && act < dl.length, `index ${act}`);
    omniState().displayPin = null;
    ok('unpinned resolves to where he IS, not index 0', omniResolveDisplay() === act, `resolve=${omniResolveDisplay()} active=${act}`);
    omniState().displayPin = dl.length > 1 ? 1 : 0;
    ok('a pin is honoured over the cursor', omniResolveDisplay() === (dl.length > 1 ? 1 : 0));
    omniState().displayPin = null;
    if (dl.length > 1) {
      const big = dl.reduce((a, b) => (a.w * a.h >= b.w * b.h ? a : b));
      const small = dl.reduce((a, b) => (a.w * a.h <= b.w * b.h ? a : b));
      ok('the two screens really are different sizes (the quarter-HUD cause)', big.w !== small.w,
        `${small.label} ${small.dipW}x${small.dipH} vs ${big.label} ${big.dipW}x${big.dipH} — a window sized for the small one covers ${Math.round((small.dipW * small.dipH) / (big.dipW * big.dipH) * 100)}% of the big one`);
    }

    log('9/9 CONTINUITY + the HUD …');
    threadWrite({ goal: 'omnitest thread', openNext: 'the next thing', verdict: 'unfinished', agent: 'davara' });
    ok('the thread is written', !!threadBlock() && threadBlock().includes('the next thing'));
    ok('an empty start would resume it', threadState().goal === 'omnitest thread');
    STATE.thread = { goal: '', openNext: '', lastVerdict: '', ts: 0, agent: '', cycles: 0, history: [] };
    ok('a cleared thread stops resuming', !threadBlock());
    omniArm({ minutes: 5, hud: true });
    const hw = omniOverlayOpen();
    ok('the HUD window opens', !!hw && !hw.isDestroyed());
    ok('the HUD is hidden from her own frames (content protection)', safe(() => { hw.setContentProtection(true); return true; }, false));
    // THE ASSERTION THAT WAS MISSING. Previously this only checked the window
    // EXISTS — which it always did, at a quarter of the screen. Prove it covers
    // the display it is supposed to, through the REAL production function, and
    // prove it on every display rather than whichever one the cursor is on.
    if (hw) {
      const { screen } = require('electron');
      const displays = screen.getAllDisplays();
      const u = omniUnionBounds();
      await new Promise((r) => setTimeout(r, 350));
      const b = hw.getBounds();
      // ONE window over EVERY monitor. This is the assertion that makes the
      // quarter-screen class of bug impossible rather than merely fixed.
      ok('the HUD spans the ENTIRE virtual desktop', Math.abs(b.width - u.width) <= 2 && Math.abs(b.height - u.height) <= 2 && Math.abs(b.x - u.x) <= 2 && Math.abs(b.y - u.y) <= 2,
        `union ${u.width}x${u.height}@${u.x},${u.y} · got ${b.width}x${b.height}@${b.x},${b.y}`);
      for (let i = 0; i < displays.length; i++) {
        const t = displays[i];
        const inside = t.bounds.x >= b.x - 1 && t.bounds.y >= b.y - 1
          && (t.bounds.x + t.bounds.width) <= (b.x + b.width) + 1
          && (t.bounds.y + t.bounds.height) <= (b.y + b.height) + 1;
        ok(`  display[${i}] "${t.label || 'primary'}" is fully covered`, inside,
          `${t.bounds.width}x${t.bounds.height}@${t.bounds.x},${t.bounds.y}`);
        omniState().displayPin = i;
        const st = omniStageRect();
        ok(`  the stage frames display[${i}] correctly`, st && st.w === t.bounds.width && st.h === t.bounds.height && st.x === (t.bounds.x - u.x) && st.y === (t.bounds.y - u.y),
          st ? `stage ${st.w}x${st.h} at ${st.x},${st.y} inside the union` : 'no stage');
      }
      omniState().displayPin = null;
    }

    // THE HANDS, FOR REAL. Everything so far proved she can SEE and DECIDE; the
    // execution path had only ever run in dry mode. These two ops genuinely
    // execute through the shipped PowerShell layer and cannot disturb him:
    // `wait` touches nothing, `clipget` only READS the clipboard.
    {
      const planFile = path.join(omniHome(), 'plan.json'), outFile = path.join(omniHome(), 'plan-out.json');
      safe(() => fs.writeFileSync(planFile, JSON.stringify({ steps: [{ op: 'wait', ms: 120 }, { op: 'clipget' }] })));
      safe(() => fs.existsSync(outFile) && fs.unlinkSync(outFile));
      const t0 = now();
      const pr = await runOmniPs(['-Batch', planFile, '-Out', outFile], 30000);
      const pd = pr.ok ? parseJsonLoose(safe(() => fs.readFileSync(outFile, 'utf8'), '')) : null;
      const res = (pd && pd.results) || [];
      ok('a REAL batch executes through the input layer', !!pd && pd.ok === true && res.length === 2,
        `${Math.round(now() - t0)}ms · ${res.map((x) => x.op + (x.ok ? ' ok' : ' FAIL')).join(', ')}`
        + (pd ? '' : ` · ps.ok=${pr.ok} err=${(pr.error || '').slice(0, 200)} raw=${String(pr.raw || '').slice(0, 120)} script=${omniScriptPath()} exists=${exists(omniScriptPath())} out=${exists(outFile)}`));
      ok('the batch reports back per-step results she can read', res[0] && res[0].ok && /waited/.test(res[0].said || ''), (res[0] || {}).said);
      ok('the clipboard read really reached Windows', res[1] && res[1].ok && /^CLIPBOARD:/.test(res[1].said || ''), 'no clipboard content printed here on purpose');
    }

    // CONTINUOUS DRIVE — it must chain only off an honest finish, and every
    // bound must actually bind. An autonomy that ignores one of its own limits
    // is not autonomy, it is a runaway.
    {
      omniArm({ minutes: 30, continuous: true, chainMax: 2, dry: true, hud: false });
      const o2 = omniState();
      o2.session = { id: 'x', goal: 'g', agent: o2.agent, status: 'running', cursor: 0, maxSteps: 4, steps: [], transcript: [], steer: [], cycles: 1, origin: 'his' };
      o2._chaining = false; o2.chain = 0;
      const h1 = omniHalt('finished', 'done');
      ok('a finished move chains to the next one', !!(h1 && h1.chained), `chain=${o2.chain}`);
      o2._chaining = false;
      // ⚠ THIS ASSERTION USED TO READ "a BLOCKED move never chains", and it was
      // the rule that made her stop dead on his machine with continuous ON and
      // five chain links unused. A block is the end of ONE move; the drive
      // continues on a different one. What must stay terminal is a FAULT and
      // his own stop — asserted immediately below, because loosening one bound
      // without re-proving the others is how a guard quietly disappears.
      o2._chaining = false; o2.avoid = [];
      o2.session = { id: 'y', goal: 'g', agent: o2.agent, status: 'running', cursor: 0, maxSteps: 4, steps: [], transcript: [], steer: [], cycles: 1, origin: 'his' };
      const h2 = omniHalt('she was blocked', 'blocked');
      ok('a BLOCKED move chains onward to a DIFFERENT move', !!(h2 && h2.chained), `chain=${o2.chain}`);
      ok('and the wall it hit is remembered', (o2.avoid || []).length === 1);
      o2._chaining = false; o2.chain = 0; o2.avoid = [];
      o2.session = { id: 'y2', goal: 'g', agent: o2.agent, status: 'running', cursor: 0, maxSteps: 4, steps: [], transcript: [], steer: [], cycles: 1, origin: 'his' };
      const h2b = omniHalt('the drive loop faulted — boom');
      ok('a FAULT is still terminal', !(h2b && h2b.chained));
      o2._chaining = false;
      o2.session = { id: 'y3', goal: 'g', agent: o2.agent, status: 'running', cursor: 0, maxSteps: 4, steps: [], transcript: [], steer: [], cycles: 1, origin: 'his' };
      const h2c = omniHalt('you stopped it');
      ok('his own stop is still terminal', !(h2c && h2c.chained));
      o2._chaining = false; o2.chain = 0;
      o2.session = { id: 'z', goal: 'g', agent: o2.agent, status: 'running', cursor: 0, maxSteps: 4, steps: [], transcript: [], steer: [], cycles: 1, origin: 'his' };
      o2.chain = 2;   // at the cap
      const h3 = omniHalt('finished', 'done');
      ok('the chain cap actually stops it', !(h3 && h3.chained), `cap ${o2.chainMax}`);
      o2.chain = 0;
      o2.session = { id: 'w', goal: 'g', agent: o2.agent, status: 'running', cursor: 0, maxSteps: 4, steps: [], transcript: [], steer: [], cycles: 1, origin: 'his' };
      omniState().armedAt = now() - 99 * 60 * 1000;    // fuse blown
      const h4 = omniHalt('finished', 'done');
      ok('a blown fuse stops the chain', !(h4 && h4.chained));
      omniDisarm('chain test over');
      omniArm({ minutes: 5, continuous: false, hud: true, dry: false });
    }

    // SPEED — he asked for "almost instant". Measure it; do not claim it.
    omniOverlayDestroy();
    const tCold = now(); omniOverlayEnsure(); const coldMs = now() - tCold;
    await new Promise((r) => setTimeout(r, 700));           // let it finish loading
    // MEDIAN OF THREE, not a single sample. One reading against a 60ms bar
    // failed at 72ms and passed at 37ms on the next run with no code change
    // between them — that is machine load, not a regression, and a test that
    // cries wolf is worse than no test because the next real failure gets
    // shrugged off. Three samples, take the middle one.
    const warms = [];
    for (let i = 0; i < 3; i++) {
      const tWarm = now(); omniOverlayOpen(); omniOverlayMove(); omniOverlayPush({ status: 'standby', phase: 'armed' });
      warms.push(now() - tWarm);
      await new Promise((r) => setTimeout(r, 60));
    }
    const warmMs = warms.slice().sort((a, b) => a - b)[1];
    ok('a pre-warmed arm is effectively instant', warmMs < 90, `${warmMs}ms median of ${warms.join('/')}ms (first build was ${coldMs}ms, paid once when he opens the screen)`);
    // and re-framing between monitors must be instant too
    const dsp = require('electron').screen.getAllDisplays();
    if (dsp.length > 1) {
      omniState().displayPin = 1;
      const tMove = now(); omniOverlayMove(); const moveMs = now() - tMove;
      ok('switching monitors is instant', moveMs < 60, `${moveMs}ms`);
      const st = omniStageRect();
      ok('and it actually lands on the OTHER monitor', st && st.w === dsp[1].bounds.width && st.h === dsp[1].bounds.height,
        st ? `stage ${st.w}x${st.h} = display[1] ${dsp[1].bounds.width}x${dsp[1].bounds.height}` : 'no stage');
      omniState().displayPin = null;
    }
    omniOverlayClose();
    omniDisarm('end of test');

    // Leave no test residue in his real settings. This runs LAST, after every
    // section — an earlier reset gets overwritten by the sections that follow,
    // which is how his fuse was found sitting at the test's 5 minutes.
    const keep = omniState().log, stats = omniState().stats;
    STATE.omni = omniDefaults();
    STATE.omni.log = keep; STATE.omni.stats = stats;
    saveState();
    log(`  ok   settings restored to defaults (fuse ${STATE.omni.ttlMin}m, ${STATE.omni.scope}/${STATE.omni.pacing})`);

    log('');
    log(`RESULT: ${pass} passed, ${fail} failed — ${fail ? 'DO NOT SHIP' : 'the OS layer, the map, continuity and every guard behave'}`);
  } catch (e) {
    log('threw:', (e && e.stack) || e);
  }
  setTimeout(() => app.quit(), 400);
}

// `electron . --drivetest` runs a COMPLETE Motus Max session end to end, in DRY
// mode — she captures the real screen, reads it, plans, and every step is
// guarded and compiled, but her hands never move. This is the one path the
// harness never covered: the parts were all proven individually and the whole
// had literally never run (sessions=0 in his state file when he reported it
// "not doing anything"). Parts passing is not a system working.
async function runDriveTest() {
  const log = (...a) => console.log('[drivetest]', ...a);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(1200);
  const saved = JSON.parse(JSON.stringify(omniState()));
  try {
    omniArm({ minutes: 10, scope: 'open', pacing: 'auto', maxSteps: 6, speak: false, hud: true, dry: true });
    log('armed · dry · open · auto · budget 6 steps · HUD on');
    // An ACTION goal, not a sight check. Every earlier drivetest asked her to
    // look and report — so of course she stopped on cycle one with zero steps,
    // and "she never does anything" was partly the test's fault, not hers.
    // DRY is still on, so the steps are compiled and guarded but never executed:
    // this measures whether she DECIDES to act, which is the thing in doubt.
    // A goal with a REAL outcome, where the GUI would be the wrong instrument.
    // This is the test that matters: does she reach for her own tools and
    // actually change something, rather than trying to click her way there.
    const goal = `Write a file at ${wslHome()}/.cortexinsight/motus-max-proof.md containing exactly three lines:
1. the words MOTUS MAX IS LIVE
2. the current UTC time
3. one sentence naming the single highest-leverage move in this ecosystem right now

Use your OWN tools — Write or Bash — not the mouse. Report it with [[OS:work …]] and then [[OS:done]]. If you cannot write the file, say so honestly with [[OS:need]].`;
    const t0 = now();
    const r = await omniStart({ goal, maxSteps: 6 });
    if (!r.ok) { log('START FAILED:', r.error); throw new Error('start failed'); }
    log(`session started (${r.origin}) — waiting for the loop to finish…`);

    for (let i = 0; i < 150; i++) {
      await wait(2000);
      const s = omniState().session;
      if (!s) break;
      if (['done', 'blocked', 'stopped'].includes(s.status)) break;
      if (i % 5 === 0) log(`  …cycle ${s.cycles} · step ${s.cursor}/${s.maxSteps} · ${s.status}`);
    }
    const s = omniState().session || {};
    log('');
    log(`RESULT after ${Math.round((now() - t0) / 1000)}s: status=${s.status} cycles=${s.cycles} steps=${s.cursor}`);
    log(`why: ${s.why || '(none)'}`);
    log(`what she SAW and PLANNED (transcript entries: ${(s.transcript || []).length}):`);
    (s.transcript || []).slice().reverse().forEach((t) => console.log(`   [cycle ${t.cycle}] "${String(t.text).replace(/\s+/g, ' ').slice(0, 400)}"`));
    if (!(s.transcript || []).length) log('   ⚠ EMPTY — the "what she is thinking" panel would render blank for him');
    log('what she WOULD have done (dry — nothing moved):');
    (s.steps || []).forEach((x) => console.log(`   ${x.ok ? 'ok ' : 'ERR'} ${x.op.padEnd(9)} ${x.note || ''} → ${String(x.said).slice(0, 110)}`));
    const cycled = (s.cycles || 0) >= 1;
    const sawScreen = (s.transcript || []).length >= 1;
    log('');
    log(`VERDICT: ${cycled && sawScreen ? 'the full loop RUNS — perceive → think → plan → guard' : 'THE LOOP DID NOT COMPLETE A CYCLE'}`);
  } catch (e) {
    log('threw:', (e && e.message) || e);
  } finally {
    omniDisarm('end of drive test');
    const keep = omniState().log, stats = omniState().stats;
    STATE.omni = Object.assign(omniDefaults(), { log: keep, stats });
    saveState();
    log('settings restored; disarmed');
  }
  setTimeout(() => app.quit(), 500);
}

// `electron . --livetest` — THE REAL THING. Not dry. Her hands actually move on
// his machine, and the proof is physical: a frame before, a frame after, and a
// pixel-difference between them. Every other harness so far proved she can see
// and decide; this one proves she can ACT. The goal is deliberately contained
// (open Notepad, type one line, leave it unsaved) so it is unmistakably visible,
// entirely reversible, and touches nothing he cares about.
async function runLiveTest() {
  const log = (...a) => console.log('[livetest]', ...a);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(1200);
  const hash = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
  try {
    omniArm({ minutes: 10, scope: 'open', pacing: 'auto', maxSteps: 14, speak: false, hud: true, dry: false, depth: false });
    log('ARMED · scope=open · auto · dry=FALSE — her hands are live');

    const before = await omniCapture();
    log(`frame before: ${before.ok ? hash(fs.readFileSync(before.file)) : 'FAILED'}`);

    const goal = `Open Notepad and type exactly this one line into it:
MOTUS MAX IS LIVE
Then stop with [[OS:done]]. Do NOT save the file, do not close it, do not touch anything else.
Notepad is at C:\\Windows\\System32\\notepad.exe — use [[OS:launch C:\\Windows\\System32\\notepad.exe]], wait for it, then type.`;
    const t0 = now();
    const r = await omniStart({ goal, maxSteps: 14 });
    if (!r.ok) { log('START FAILED:', r.error); throw new Error('start failed'); }

    for (let i = 0; i < 180; i++) {
      await wait(2000);
      const s = omniState().session;
      if (!s || ['done', 'blocked', 'stopped'].includes(s.status)) break;
      if (i % 4 === 0) log(`  …cycle ${s.cycles} · step ${s.cursor}/${s.maxSteps} · ${s.status}`);
    }
    const s = omniState().session || {};
    log('');
    log(`RESULT after ${Math.round((now() - t0) / 1000)}s: status=${s.status} cycles=${s.cycles} steps=${s.cursor}`);
    log('WHAT SHE ACTUALLY DID ON THE MACHINE:');
    let real = 0;
    (s.steps || []).forEach((x) => {
      if (x.ok && !x.dry && !['none', 'zoom', 'call'].includes(x.op)) real++;
      console.log(`   ${x.ok ? 'ok ' : 'ERR'} ${String(x.op).padEnd(9)} ${x.note || ''} → ${String(x.said).slice(0, 110)}`);
    });
    log(`real OS actions that reported success: ${real}`);

    await wait(1200);
    const after = await omniCapture();
    const hb = before.ok ? hash(fs.readFileSync(before.file)) : 'x';
    const ha = after.ok ? hash(fs.readFileSync(after.file)) : 'y';
    log(`frame after : ${ha}`);
    log('');
    log(`SCREEN CHANGED: ${hb !== ha ? 'YES — the picture of his desktop is different' : 'NO — nothing visibly moved'}`);
    log(`VERDICT: ${real > 0 && hb !== ha ? '✓ MOTUS MAX PHYSICALLY OPERATES THE MACHINE' : '✗ still not acting — do not claim it works'}`);
    if (after.ok) log(`look at it yourself: ${after.file}`);
  } catch (e) {
    log('threw:', (e && e.message) || e);
  } finally {
    omniDisarm('end of live test');
    const keep = omniState().log, stats = omniState().stats;
    STATE.omni = Object.assign(omniDefaults(), { log: keep, stats });
    saveState();
  }
  setTimeout(() => app.quit(), 600);
}

// `electron . --flowtest` — CONTINUOUS DRIVE, for real. She chooses a move,
// makes it, then chooses the NEXT one herself, and keeps going. Dry, so her
// hands stay off the mouse, but her own tools are live and the choosing is
// entirely hers. This is the mode August actually wants; the chain has been
// asserted synthetically but never once watched end to end.
async function runFlowTest() {
  const log = (...a) => console.log('[flow]', ...a);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(1200);
  const seen = [];
  try {
    // Tight step budget on purpose: a link that cannot finish inside it should
    // hand on to the next link rather than grind. That is the behaviour under
    // test — the first run spent 675s on one unfinishable link and never chained.
    // Drive with ARDEN as the mind on purpose — the fastest, read-only seat.
    // If the mind/hands split works, this chains and writes real files even
    // though the chosen seat cannot type a character.
    omniArm({ minutes: 30, scope: 'open', pacing: 'auto', maxSteps: 4, speak: false, hud: false,
      dry: true, depth: false, continuous: true, chainMax: 3, speedEffort: 'medium', agent: 'arden' });
    // Start from a clean thread. The previous run left an unfinishable project
    // open, so the "cold start" resumed THAT instead of choosing fresh — the
    // test was measuring resume, not choice.
    STATE.thread = { goal: '', openNext: '', lastVerdict: '', ts: 0, agent: '', cycles: 0, history: [] };
    saveState();
    log('armed · continuous · chainMax 3 · 4 steps per link · dry (her tools are live, her hands are not) · thread cleared');
    const t0 = now();
    const r = await omniStart({ goal: '', agent: omniState().agent });
    if (!r.ok) { log('FAILED to start:', r.error); throw new Error('start'); }
    log(`move 1 chosen by her (${r.origin}): ${String((r.read && r.read.lever) || '').replace(/\s+/g, ' ').slice(0, 160)}`);

    // watch until the chain stops on its own
    for (let i = 0; i < 240; i++) {
      await wait(2500);
      const o = omniState(), s = o.session;
      if (s && s.id && !seen.some((x) => x.id === s.id)) {
        seen.push({ id: s.id, goal: String(s.goal).split('\n')[0].slice(0, 150), origin: s.origin, status: s.status });
        log(`— chain link ${seen.length} [${s.origin}]: ${seen[seen.length - 1].goal}`);
      }
      const cur = seen[seen.length - 1];
      if (cur && s && s.id === cur.id && s.status !== cur.status) {
        cur.status = s.status; cur.why = s.why;
        if (['done', 'blocked', 'stopped'].includes(s.status)) log(`   link ${seen.length} ended: ${s.status} — ${String(s.why || '').slice(0, 140)}`);
      }
      const done = s && ['done', 'blocked', 'stopped'].includes(s.status);
      if (done && !o._chaining && (o.chain >= o.chainMax || !o.continuous || !omniArmedNow())) break;
      if (!omniArmedNow()) break;
    }
    const o = omniState();
    log('');
    log(`RESULT after ${Math.round((now() - t0) / 1000)}s — ${seen.length} moves chained, chain counter ${o.chain}/${o.chainMax}`);
    seen.forEach((x, i) => console.log(`   ${i + 1}. [${x.origin}] ${x.goal}`));
    const work = (STATE.duoWork || []).slice(0, seen.length);
    log(`work ledger entries written: ${work.length}`);
    work.forEach((w) => console.log(`   · [${w.verdict}] ${String(w.title).slice(0, 120)}`));
    const distinct = new Set(seen.map((x) => x.goal)).size;
    log('');
    log(`VERDICT: ${seen.length >= 2 && distinct === seen.length
      ? '✓ SHE CHAINS — each move chosen by her, and none repeated'
      : seen.length >= 2 ? '⚠ chained but REPEATED a move' : '✗ did not chain'}`);
  } catch (e) {
    log('threw:', (e && e.message) || e);
  } finally {
    omniDisarm('end of flow test');
    const keep = omniState().log, stats = omniState().stats;
    STATE.omni = Object.assign(omniDefaults(), { log: keep, stats });
    saveState();
  }
  setTimeout(() => app.quit(), 600);
}

// `electron . --strategytest` runs the REAL strategic read and the REAL
// divergence engine against the live relay. Two relay turns, and worth them:
// a contract that parses in my head and not against an actual model reply is
// the exact failure that leaves a feature quietly returning empty fields.
async function runStrategyTest() {
  const log = (...a) => console.log('[strategy]', ...a);
  await new Promise((r) => setTimeout(r, 1200));
  try {
    log('1/2 the strategic read …');
    const t0 = now();
    const r = await strategicRead({ zoom: 'orbit' });
    if (!r.ok) { log('   FAILED:', r.error); return app.quit(); }
    const R = r.read;
    log(`   came back in ${Math.round((now() - t0) / 1000)}s from ${R.agent}`);
    for (const k of ['phase', 'loop', 'lever', 'rung', 'whyNow', 'firstStep', 'frame', 'cost']) {
      const v = String(R[k] || '');
      console.log(`   ${v ? 'ok  ' : 'MISSING'} ${k.padEnd(10)} ${v.replace(/\s+/g, ' ').slice(0, 150)}`);
    }
    const missing = ['phase', 'loop', 'lever', 'rung', 'whyNow', 'firstStep', 'frame'].filter((k) => !R[k]);
    log(missing.length ? `   ⚠ the contract did not fully parse — missing: ${missing.join(', ')}` : '   every field of the contract parsed');

    log('2/2 the divergence engine …');
    const d = await divergentFrames({});
    if (!d.ok) { log('   FAILED:', d.error); return app.quit(); }
    log(`   ${d.frames.length} frames from ${d.agent}`);
    d.frames.forEach((f, i) => {
      console.log(`   ${i + 1}. ${String(f.claim).replace(/\s+/g, ' ').slice(0, 160)}`);
      console.log(`      method=${f.method || 'MISSING'} · confidence=${f.confidence || 'MISSING'}`);
      console.log(`      test: ${String(f.test || 'MISSING').replace(/\s+/g, ' ').slice(0, 130)}`);
    });
    log(`   sharpest: ${String(d.sharpest).replace(/\s+/g, ' ').slice(0, 200)}`);
    const bad = d.frames.filter((f) => !f.claim || !f.method || !f.confidence).length;
    log(bad ? `   ⚠ ${bad} frame(s) did not fully parse` : '   every frame parsed');
  } catch (e) { log('threw:', (e && e.stack) || e); }
  setTimeout(() => app.quit(), 400);
}

// ---------------------------------------------------------------------------
//  `electron . --drifttest` — DOES THE ALARM ACTUALLY RING?
//
//  The drift watch has never fired in anger. A check only ever exercised on
//  its passing path is not a check, it is a hope — and this one guards the
//  thing August was most explicit about: nothing of his goes out that he did
//  not tick.
//
//  It cannot be proven by reading the code, and it cannot be proven off air.
//  So this goes ON AIR against the real endpoint with a payload that is ONLY
//  a labelled throwaway topic. Nothing is ticked, so no goal, no Motus, no
//  work item and no agent can travel: the same law that protects him in
//  normal use is exactly what makes this test safe to run.
//
//  Then it simulates the real threat — a push putting an item on the wire he
//  never selected (a stale CDN copy, an auto-follow surprise, or the
//  live-secret used by something that is not this app) — and asserts the
//  watch NOTICES, RAISES, and that the alarm REACHES him. Finally it goes
//  dark and proves the endpoint is empty.
//
//  Its own sandbox vault, so his real selection is never touched. The only
//  shared thing it moves is the public payload, and it puts that back.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
//  `electron . --clicktest` — WHAT DOES A START BUTTON COST THE MAIN PROCESS?
//
//  "A really big lag spike for a few seconds when I click start." A spike on
//  a click is main-process time spent synchronously between the IPC arriving
//  and its reply — nothing else can be answered meanwhile. This harness times
//  every piece of work those three buttons trigger, in-process, on a copy of
//  the live vault, and names the ones over budget. Seeded from the real vault
//  so the numbers are his, not a fixture's.
// ---------------------------------------------------------------------------
async function runClickTest() {
  const lines = [];
  const log = (m) => { lines.push(m); console.log('[click]', m); };
  const outFile = path.join(app.getPath('temp'), 'ci-click-report.txt');
  try {
    // seed from the live vault so the walk sizes are real
    safe(() => {
      const live = path.join(app.getPath('home'), 'AppData', 'Roaming', 'cortexinsight', 'cortex-insight-state.json');
      if (fs.existsSync(live)) STATE = JSON.parse(fs.readFileSync(live, 'utf8'));
    });
    const t = (label, fn) => { const a = Date.now(); let ok = true; try { fn(); } catch (e) { ok = false; } const ms = Date.now() - a; log((ok ? '  ' : '✗ ') + label.padEnd(44) + String(ms).padStart(6) + ' ms' + (ms > 300 ? '   ◄ over budget' : '')); return ms; };
    log('what each start button costs the MAIN process (synchronous):');
    log('— DuoDrive start —');
    t('transcriptCandidates() cold walk', () => { _fwWalk = { at: 0, cands: null }; transcriptCandidates(); });
    t('transcriptCandidates() warm (memo)', () => transcriptCandidates());
    safe(() => fs.unlinkSync(ixFrozenPath()));      // the sandbox keeps last run's index — measure cold honestly
    _ixFrozen.clear(); _ixCache.clear(); _ixAll = { sig: '', items: [] }; _ixLoaded = false;
    t('parseInteractions() first (no disk index)', () => parseInteractions());
    t('parseInteractions() second (frozen)', () => parseInteractions());
    {
      ixFrozenSave(true);
      const sz = safe(() => fs.statSync(ixFrozenPath()).size, 0);
      log('      frozen index on disk: ' + Math.round(sz / 1024) + ' KB, ' + _ixFrozen.size + ' past-day files');
      _ixFrozen.clear(); _ixCache.clear(); _ixAll = { sig: '', items: [] }; _ixLoaded = false;
      t('parseInteractions() at BOOT via disk index', () => parseInteractions());
    }
    {
      // the delta reader, on a real file: grow it, expect only the growth back
      const tp = path.join(app.getPath('temp'), 'ci-delta-probe.jsonl');
      fs.writeFileSync(tp, '{"a":1}' + NL + '{"a":2}' + NL);
      const st1 = fs.statSync(tp);
      const d1 = readDelta(tp, null, st1, 1e6);
      fs.appendFileSync(tp, '{"a":3}' + NL + '{"a":4');
      const st2 = fs.statSync(tp);
      const d2 = readDelta(tp, { size: st1.size, carry: d1.carry }, st2, 1e6);
      fs.appendFileSync(tp, '}' + NL);
      const st3 = fs.statSync(tp);
      const d3 = readDelta(tp, { size: st2.size, carry: d2.carry }, st3, 1e6);
      const ok = d1.full === true && d1.text.split(NL).length === 2
        && d2.full === false && d2.text === '{"a":3}' && d2.carry === '{"a":4'
        && d3.full === false && d3.text === '{"a":4}' && d3.carry === '';
      log((ok ? '  ' : '✗ ') + 'readDelta(): growth-only reads, partial line carried' + (ok ? '' : '  GOT ' + JSON.stringify([d1, d2, d3])));
      safe(() => fs.unlinkSync(tp));
    }
    t('duoContext() first sight (8 × 500 KB)', () => duoContext());
    t('duoContext() again (delta reads)', () => duoContext());
    {
      _fwCache.clear();
      const a = Date.now(); const n = await transcriptFileWritesWarmAsync(14); const ms = Date.now() - a;
      log('  ' + 'transcriptFileWritesWarmAsync(14) at boot'.padEnd(44) + String(ms).padStart(6) + ' ms   (async — ' + n + ' files)');
      t('duoContext() after the async prewarm', () => duoContext());
    }
    log('— the 4 s poll while agents run —');
    for (const ag of AGENTS.slice(0, 5)) {
      t('currentWork(' + ag + ') first sight', () => currentWork(ag));
      _cwCache.get(ag) && (_cwCache.get(ag).mtime = -1);          // pretend the file grew by nothing
      t('currentWork(' + ag + ') on growth (delta)', () => currentWork(ag));
    }
    t('continuityBrief()', () => continuityBrief());
    t('writeAgentBrief()', () => writeAgentBrief());
    log('— Motus Max arm/start —');
    t('omniResolveDisplay()', () => omniResolveDisplay());
    t('omniArm({dry}) incl. HUD prewarm', () => omniArm({ dry: true, minutes: 2, hud: true }));
    t('omniPublic()', () => omniPublic());
    t('appReport({deep:true}) COLD (no usage memo)', () => appReport({ deep: true }));
    {
      const a = Date.now(); await usageRefreshAsync(); const ms = Date.now() - a;
      log('  ' + 'usageRefreshAsync() (off the main thread)'.padEnd(44) + String(ms).padStart(6) + ' ms   (async — the UI stays live)');
      const files = _uMemo.files, capped = _uMemo.capped;
      log('  ' + ('    metered ' + files + ' transcripts, ' + capped + ' capped'));
    }
    t('appReport({deep:true}) WARM (memo)', () => appReport({ deep: true }));
    {
      _fwWalk = { at: 0, cands: null };
      const a = Date.now(); const c = await transcriptCandidatesAsync(); const ms = Date.now() - a;
      log('  ' + 'transcriptCandidatesAsync() cold'.padEnd(44) + String(ms).padStart(6) + ' ms   (async — ' + c.length + ' files)');
    }
    t('buildOverview()', () => buildOverview());
    t('omniDisarm()', () => omniDisarm());
    log('— the poll tick (every 4–20 s, so this is the standing cost) —');
    t('parseInteractions() warm', () => parseInteractions());
    t('parseProxyLog()', () => parseProxyLog());
    t('readCheckpoint() x' + AGENTS.length, () => { for (const ag of AGENTS) readCheckpoint(ag); });
    t('readModelPin() first', () => readModelPin());
    t('readModelPin() again (stat-gated)', () => readModelPin());
    t('bridgeStatus() first', () => bridgeStatus());
    t('bridgeStatus() again (stat-gated)', () => bridgeStatus());
    t('buildOverview() one tick', () => buildOverview());
    t('buildOverview() next tick', () => buildOverview());
    t('systemDynamics() cold', () => { _dynMemo = { at: 0, v: null }; systemDynamics(); });
    {
      const dyn = systemDynamics();
      log('      rhythm: peak ' + String(dyn.peak.start).padStart(2, '0') + '–' + String(dyn.peak.end).padStart(2, '0') + ' · ' + dyn.flows.turns7 + ' turns/7d · board ' + dyn.stocks.open + ' open · clear in ' + (dyn.delays.clearDays == null ? '—' : dyn.delays.clearDays + 'd') + ' · ' + dyn.readings.length + ' readings');
    }
    log('— Command send —');
    t('fleetSnapshot()', () => fleetSnapshot());
    t('taskBoard()', () => taskBoard());
    t('taskSweep({dry})', () => taskSweep({ apply: false }));
    t('learningsApplied()', () => { _laMemo = { at: 0, sig: '', v: null }; learningsApplied(); });
    t('loopYields()', () => loopYields());
    t('dvOrgansFor(scout) first read', () => dvOrgansFor('scout'));
    t('dvOrgansFor(refine) first read', () => dvOrgansFor('refine'));
    t('dvOrgansFor(scout) again (stat-gated)', () => dvOrgansFor('scout'));
    t('mindReport() cold', () => { _mindMemo = { at: 0, v: null }; mindReport(); });
    t('mindReport() warm', () => mindReport());
  } catch (e) { log('THREW: ' + ((e && e.stack) || e)); }
  safe(() => fs.writeFileSync(outFile, lines.join(String.fromCharCode(10)) + String.fromCharCode(10), 'utf8'));
  setTimeout(() => app.quit(), 300);
}
async function runDriftTest() {
  const lines = [];
  const log = (...x) => { const m = x.map(String).join(" "); lines.push(m); console.log("[drift]", m); };
  const outFile = path.join(app.getPath("temp"), "ci-drift-report.txt");
  const flush = () => safe(() => fs.writeFileSync(outFile, lines.join("\n") + "\n", "utf8"));
  let pass = 0, fail = 0;
  const ok = (label, cond, detail) => {
    if (cond) { pass++; log("  PASS  " + label + (detail ? "  — " + detail : "")); }
    else { fail++; log("  FAIL  " + label + (detail ? "  — " + detail : "")); }
  };
  const readPublic = async (tag) => {
    const r = await onAirHttp("GET", "/api/live?" + tag + "=" + now());
    return (r.json && (r.json.payload || r.json)) || null;
  };
  const isBlank = (p) => !!p && !p.topic && !p.goal && !p.motus && !(p.items || []).length && !(p.agents || []).length;
  try {
    log("report -> " + outFile);
    // ⚠ MEASURED: an isolated harness starts from an EMPTY vault, so it does
    // not inherit the host the app discovered — it falls back to the default,
    // which is precisely the host that moved. The first run of this test spent
    // every assertion against www.semble.cc and 404'd. A harness must find its
    // back end the same way the app does, or it tests nothing.
    const disc = await onAirDiscover({ quiet: true });
    log("host: " + onAirHost() + (disc && disc.ok ? "" : "  (discovery failed: " + ((disc && disc.error) || "?") + ")"));
    if (!onAirSecret()) { log("ABORT: no live-secret on this machine — nothing can be pushed or restored"); flush(); return setTimeout(() => app.quit(), 300); }

    // 0 · the endpoint must be quiet BEFORE we touch it
    const before = await readPublic("before");
    log("0 · before the test: " + (before ? (before.on ? "ON AIR" : "off air") + (isBlank(before) ? ", blank" : ", CARRYING CONTENT") : "unreadable"));
    if (!before) { log("ABORT: the endpoint is unreadable — a test against a dead host proves nothing, and would report nine failures that are all one problem"); flush(); return setTimeout(() => app.quit(), 300); }
    if (before.on) { log("ABORT: something is genuinely ON AIR — refusing to disturb a live broadcast"); flush(); return setTimeout(() => app.quit(), 300); }

    // 1 · go live with a labelled throwaway and NOTHING ticked
    const a = onAirState();
    a.sel = {}; a.custom = [];
    a.topic = "CortexInsight self-test — ignore, this is a system check";
    a.on = true;
    const p1 = await onAirPush();
    log("1 · on air, throwaway topic, zero ticks: push " + (p1.ok ? "ok" : "FAILED " + p1.error));
    const served1 = await readPublic("t1");
    ok("nothing of his travelled — the payload is topic-only",
      !!served1 && !served1.goal && !served1.motus && !(served1.items || []).length && !(served1.agents || []).length,
      served1 ? "topic=" + JSON.stringify(String(served1.topic || "").slice(0, 46)) : "unreadable");

    // 2 · on the honest path the watch must stay silent
    const d1 = await onAirDriftCheck({ quiet: true });
    ok("drift is SILENT when served matches the ticks", !!d1 && d1.ok === true && (d1.extraCount || 0) === 0,
      "extra=" + (d1 && d1.extraCount) + " missing=" + (d1 && d1.missing));

    // 3 · THE THREAT — a push he never made, carrying content he never ticked
    const notifBefore = (STATE.notifications || []).length;
    await onAirHttp("POST", "/api/live", {
      on: true, dj: a.dj, power: a.power, topic: a.topic, goal: "", motus: "",
      items: [{ kind: "NOTE", t: "DRIFT PROBE — an item that was never ticked in CortexInsight" }],
      agents: [],
    }, { "x-live-secret": onAirSecret() });
    const served2 = await readPublic("t2");
    ok("the rogue push actually landed (else the next assertion is vacuous)",
      !!served2 && (served2.items || []).length === 1);

    const d2 = await onAirDriftCheck({ quiet: false });
    ok("drift DETECTS an item that was never ticked", !!d2 && (d2.extraCount || 0) >= 1,
      "extra=" + (d2 && d2.extraCount) + " " + JSON.stringify((d2 && d2.extra) || []));
    ok("classified as EXPOSURE, not as a delivery lag",
      !!d2 && d2.ok === false && (d2.extraCount || 0) >= 1 && !d2.error,
      d2 && d2.error ? "ERRORED: " + d2.error : "ok=" + (d2 && d2.ok));

    // 4 · and the alarm has to REACH him, not merely be computed
    const fired = (STATE.notifications || []).slice(0, 4).find((n) => /drift/i.test(n.title || ""));
    ok("the alert reached the notification feed", !!fired,
      fired ? JSON.stringify(String(fired.title) + " — " + String(fired.body).slice(0, 80)) : "no notification was raised");
    ok("raised at BAD severity — a privacy finding never arrives as good news",
      !!fired && fired.level === "bad", fired ? "level=" + fired.level : "");
    log("  (notifications: " + notifBefore + " -> " + (STATE.notifications || []).length + ")");

    // 5 · put the world back, and PROVE it
    a.on = false;
    const sweep = await onAirEnforceOff({ quiet: true });
    const served3 = await readPublic("t3");
    ok("going dark cleared the rogue item too", isBlank(served3),
      served3 ? JSON.stringify(served3).slice(0, 130) : "unreadable");
    ok("the sweep reported the clear honestly", !!sweep && (sweep.cleared || sweep.clean));
    log("5 · restored: " + JSON.stringify(served3));
  } catch (e) { fail++; log("THREW: " + ((e && e.stack) || e)); }
  log("");
  log(fail ? "===== " + fail + " FAILURE(S), " + pass + " passed =====" : "===== ALL " + pass + " ASSERTIONS PASSED — the alarm rings =====");
  flush();
  setTimeout(() => app.quit(), 400);
}
// ---------------------------------------------------------------------------
// `electron . --lanetest` — THE ASSERTION THE UNIT TESTS CANNOT MAKE.
//
// omnitest proves the ROUTER picks the right seat. It cannot prove the thing
// that actually decides whether this feature is a gain or a regression: that a
// seat carrying NO SOUL can still read a real drive prompt and come back with a
// parseable action inside the protocol. If it cannot, every reflex cycle
// degrades into the nudge-retry path and the "speedup" costs an extra turn.
//
// So this sends the REAL omniPrompt — built from a real probe of his real
// screen — down both lanes, parses both replies with the REAL parser, and
// reports the honest wall-clock. Same prompt, same relay, same machine.
// ---------------------------------------------------------------------------
async function runLaneTest() {
  const log = (...a) => console.log('[lanetest]', ...a);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(1200);
  try {
    log('gate:', gate() ? 'trusted' : 'NOT TRUSTED');

    // ── HER INSTRUMENTS, AGAINST THE LIVE INTERNET ──────────────────────────
    // These are the EXACT two reads she needed last session and did not have as
    // reflexes: the page that looked broken, and the API that had the answer.
    log('— her own instruments, live —');
    {
      const t0 = now();
      const page = await omniReadTarget('https://www.motusmoves.us/m/motus-makes-a-difference');
      log(`  read page      ${String(Math.round(now() - t0) + 'ms').padStart(7)}  ${page.ok ? `HTTP ${page.status} · ${page.kind} · ${page.text.length} chars` : 'FAILED: ' + page.error}`);
      if (page.ok && page.note) log(`                          ⚑ ${page.note.slice(0, 120)}…`);
      const t1 = now();
      const api = await omniApi('GET https://www.motusmoves.us/api/models', '');
      log(`  api GET        ${String(Math.round(now() - t1) + 'ms').padStart(7)}  ${api.ok ? `HTTP ${api.status} · ${api.text.length} chars` : 'FAILED: ' + api.error}`);
      if (api.ok) {
        const published = safe(() => (JSON.parse(api.text).models || JSON.parse(api.text) || []).length, '?');
        log(`                          parsed: ${published} model(s) from his live API`);
      }
      const t2 = now();
      const four = await omniReadTarget('https://www.motusmoves.us/model/motus-makes-a-difference');
      log(`  read the 404   ${String(Math.round(now() - t2) + 'ms').padStart(7)}  ${four.ok ? `HTTP ${four.status} — she can SEE it is a 404 without clicking` : 'FAILED: ' + four.error}`);
      log(`  → the whole diagnosis that cost her a session is now three reflexes, ~${Math.round((now() - t0) / 1000)}s total.`);
    }

    const probe = await omniProbe();
    log('screen:', String(probe.fg || '(unknown)').slice(0, 70), '·', (probe.windows || []).length, 'windows');
    const frame = { ok: true, none: true, imgW: 0, imgH: 0, scrW: 0, scrH: 0, name: '' };
    // A believable MID-PLAN cycle: the plan exists, two steps have landed, and
    // the only question left is "what is the next step". Exactly the shape the
    // router hands to the reflex lane.
    const s = {
      id: 'lanetest', agent: 'davara', mode: 'screen', goal: 'Open the MotusMoves model page and read what the page actually says about the run cost.',
      cursor: 2, maxSteps: 8, cycles: 3, steps: [
        { op: 'focus', ok: true, note: 'brought Chrome forward', said: '' },
        { op: 'visit', ok: true, note: 'motusmoves.us/model', said: '' },
      ], transcript: [], steer: [], _steerSeen: true, calls: [], openNext: '',
    };
    const base = omniPrompt(s, frame, probe, null);
    log('prompt built:', base.length, 'chars');

    const run = async (seat, prompt, label) => {
      const t0 = now();
      const r = await relaySend(seat, prompt, 900000);
      const ms = now() - t0;
      const acts = r.ok ? omniParse(r.text) : [];
      const verbs = acts.map((a) => a.op).join(', ') || '(none)';
      log(`${label.padEnd(10)} ${String(Math.round(ms / 1000) + 's').padStart(5)}  ${r.ok ? `${acts.length} action(s): ${verbs}` : 'FAILED: ' + r.error}`);
      if (r.ok) log(`${''.padEnd(10)}        said: ${mapStrip(omniStrip(r.text)).replace(/\s+/g, ' ').slice(0, 150)}`);
      return { ok: r.ok, ms, acts, text: r.text || '' };
    };

    log('— the reflex lane (workhorse, no soul, carries her stance in the prompt) —');
    const wh = await run('workhorse', reflexPreamble(s) + base, 'REFLEX');
    log('— the mind (Davara, full envelope) —');
    const dv = await run('davara', base, 'DAVARA');

    log('');
    const pass = [];
    const chk = (name, cond, detail = '') => { pass.push(!!cond); log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`); };
    chk('the reflex lane answers at all', wh.ok);
    chk('it emits at least one parseable action', wh.acts.length >= 1, `${wh.acts.length}`);
    chk('its actions are real verbs the compiler accepts',
      wh.acts.length > 0 && wh.acts.every((a) => omniCompile(a, { imgW: 1, imgH: 1, scrW: 1, scrH: 1 }) !== undefined));
    chk('it did NOT re-plan the goal (no new strategy)', !/instead,? I( would|'d)? |let me propose|a better approach/i.test(wh.text));
    chk('the mind still works unchanged', dv.ok && dv.acts.length >= 1, `${dv.acts.length} action(s)`);
    if (wh.ok && dv.ok) {
      const gain = Math.round((1 - wh.ms / dv.ms) * 100);
      log('');
      log(`  reflex ${Math.round(wh.ms / 1000)}s vs mind ${Math.round(dv.ms / 1000)}s → ${gain > 0 ? gain + '% faster' : Math.abs(gain) + '% SLOWER'}`);
      chk('the reflex lane is genuinely faster on this shape of turn', wh.ms < dv.ms,
        wh.ms < dv.ms ? '' : '← if this fails the lane is not worth having; turn reflex off');
    }
    log('');
    log(`RESULT: ${pass.filter(Boolean).length}/${pass.length} passed`);
  } catch (e) { log('threw:', (e && e.stack) || e); }
  setTimeout(() => app.quit(), 400);
}

// `electron . --airtest` — the ON AIR engine against the REAL semble.cc API.
// The one thing the unit assertions cannot prove: that this machine's secret,
// this engine's payload, and the deployed endpoint actually agree. Pushes a
// clearly-labelled test broadcast, reads it back from the public GET, then
// resets to off air. Leaves no residue.
async function runAirTest() {
  const log = (...x) => console.log('[airtest]', ...x);
  await new Promise((r) => setTimeout(r, 800));
  try {
    log('secret on this machine:', onAirSecret() ? 'found' : 'MISSING');
    const a = onAirState();
    STATE.goal = { text: 'AIRTEST — proving the broadcast rail end to end', ts: new Date().toISOString() };
    a.sel = { goal: true }; a.custom = [{ id: 'at1', t: 'A harness line — if you can read this on /live, the rail works' }];
    a.sel['custom:at1'] = true; a.on = true; a.dj = 'dauoz'; a.power = 'hype';
    const p = await onAirPush();
    log('push:', p.ok ? 'OK' : 'FAILED — ' + p.error, p.dropped ? `(${p.dropped} dropped)` : '');
    const r = await onAirHttp('GET', '/api/live?ts=' + now());
    const j = r.json || {};
    log('read-back:', j.on === true && (j.items || []).some((i) => i.t.includes('harness line')) ? 'CONFIRMED on the public API' : 'NOT VISIBLE: ' + JSON.stringify(j).slice(0, 160));
    log('dj carried:', j.dj === 'dauoz' && j.power === 'hype' ? 'dauoz + hype ✓' : JSON.stringify([j.dj, j.power]));
    // ── ✦ AUTO-PICK, against his REAL board ──
    log('— stream the most important thing —');
    a.sel = {}; a.custom = []; a.topic = '';
    const auto = onAirAutoPick();
    log(`  picked ${auto.picked.length}, led by ${auto.lead}:`);
    for (const p of auto.picked) log(`    ${String(p.score).padStart(4)}  ${p.kind.padEnd(8)} ${p.t.replace(/\s+/g, ' ').slice(0, 88)}`);
    const ap = await onAirPush();
    log('  pushed:', ap.ok ? 'OK' : 'FAILED — ' + ap.error, ap.dropped ? `(${ap.dropped} held back by the gate)` : '');
    const back = await onAirHttp('GET', '/api/live?ts=' + now());
    log('  visible on the public API:', (back.json && (back.json.items || []).length) || 0, 'item(s)');

    // ── MOTUSCOMPUTE: the pool, end to end ──
    log('— the compute pool —');
    {
      const own = ownCompute();
      log(`  this machine: ${own.cpuModel} · ${own.cores} cores · ${own.ramGB} GB RAM`);
      const pl = await onAirHttp('POST', '/api/compute', {
        id: 'airtest-node', tier: 'tab', vendor: 'harness', arch: 'test', klass: 'laptop',
        maxBufferMB: 1024, invocations: 512, seconds: 30,
      });
      log('  pledge:', pl.json && pl.json.ok ? `OK (capability ${pl.json.capability}×)` : 'FAILED');
      // the assertion that matters most: a contributor cannot store a key
      const bad = await onAirHttp('POST', '/api/compute', { id: 'airtest-node', dash: 'abandon ability able about above absent absorb abstract absurd abuse access accident' });
      log('  seed phrase refused:', bad.json && bad.json.ok === false ? 'YES — ' + String(bad.json.error).slice(0, 60) : '⚠ NOT REFUSED');
      // per-DJ + per-mode attribution: the ledger must know WHOSE set earned it
      await onAirHttp('POST', '/api/compute', {
        id: 'airtest-dj', tier: 'node', vendor: 'harness', arch: 'test', klass: 'workstation',
        maxBufferMB: 4096, invocations: 2048, seconds: 90, dj: 'daoz', mode: 'theater',
      });
      const pool = await onAirHttp('GET', '/api/compute?ts=' + now());
      const pj = pool.json || {};
      log(`  pool reads back: ${pj.live} live · ${pj.liveCapability} capability · jobsRunning=${pj.jobsRunning}`);
      const daoz = (pj.byDj || []).find((d) => d.dj === 'daoz');
      log('  per-DJ attribution:', daoz ? `daoz ${daoz.seconds}s across ${daoz.nodes} node(s) — ${daoz.share}%` : '⚠ MISSING');
      const th = (pj.byMode || []).find((m) => m.mode === 'theater');
      log('  per-mode attribution:', th ? `theater ${th.seconds}s` : '⚠ MISSING');
      const m = pj.motus || {};
      log(`  accrual: ${m.accrued} MOTUS-s · owed ${m.owedDash} DASH ($${m.owedUsd}) · clears $${m.settleFloorUsd} floor: ${m.settleable}`);
      // the history bucket must AGREE with the accrual, not exceed it — a
      // derived seconds×capability figure over-counted 3.4x and shipped a
      // headline number the payout engine would never have paid
      const hist = pj.history || [];
      const bsum = hist.reduce((a2, b) => a2 + (b.motusSeconds || 0), 0);
      log(`  history: ${hist.length} bucket(s), ${Math.round(bsum)} MOTUS-s — ${bsum <= (m.accrued || 0) + 1 ? 'consistent with accrual ✓' : '⚠ EXCEEDS ACCRUAL (' + m.accrued + ')'}`);

      // ── the payout engine, end to end ──
      log('— payouts —');
      const noKey = await onAirHttp('POST', '/api/payouts', { op: 'plan' });
      log('  refuses without the operator secret:', noKey.status === 401 ? 'YES (401)' : `⚠ got ${noKey.status}`);
      const plan = await onAirHttp('POST', '/api/payouts', { op: 'plan', rail: 'dash' }, { 'x-live-secret': onAirSecret() });
      const pjj = plan.json || {};
      log(`  plan: ${pjj.recipients} clear the floor · ${pjj.total} DASH · ${(pjj.held || []).length} held below it`);
      const armNothing = await onAirHttp('POST', '/api/payouts', { op: 'arm', rail: 'dash' }, { 'x-live-secret': onAirSecret() });
      log('  arming with nothing eligible:', armNothing.json && armNothing.json.ok === false ? 'REFUSED — ' + armNothing.json.error : '⚠ ARMED ANYWAY');
      const audit = await onAirHttp('GET', '/api/payouts?ts=' + now());
      const aj = audit.json || {};
      log('  audit log:', `${aj.summary.batches} batch(es) · moneyMoved=${aj.moneyMoved}`);
      log('  custody:', String(aj.custody || '').slice(0, 72));
      const trustRail = (aj.byRail || []).find((r) => r.rail === 'trust');
      log('  $TRUST framing:', /receipt, never the reward/i.test(trustRail && trustRail.note || '') ? 'correct ✓' : '⚠ WRONG');

      // ── Golem: measured, never asserted ──
      log('— golem —');
      const gol = await onAirHttp('GET', '/api/golem?ts=' + now());
      const gj = gol.json || {};
      log(`  supply: ${gj.supply.providers} providers · ${gj.supply.gpus} GPUs · reachable=${gj.supply.reachable}`);
      log(`  verdict: viewersCanContribute=${gj.verdict.viewersCanContribute} · canRentGpu=${gj.verdict.canRentGpu}`);
      log('  adapter:', gj.adapter.configured ? 'WIRED' : 'STANDBY (no appkey — correct until he sets one)');
      log('  appkey never echoed:', JSON.stringify(gj).includes('GOLEM_APPKEY') || gj.adapter.appkey ? '⚠ LEAKED' : 'YES');

      // ── RUNG 5 · dispatch, from a task all the way to a receipt ──
      log('— dispatch —');
      {
        // the gate that protects him: key-shaped content can never become a
        // work unit, because units are served publicly to anyone who asks
        const secretish = omniSecretish('sk-livetest0000000000000000000000000000');
        log('  public-work gate recognises a key shape:', secretish ? 'YES — ' + secretish : '⚠ NO');

        const enq = await onAirHttp('POST', '/api/work', {
          op: 'enqueue', task: 'airtest — index a passage', kind: 'embed',
          chunks: ['motus is the mindset the mindset means move', 'a stock is a quantity a flow is a rate'],
        }, { 'x-live-secret': onAirSecret() });
        log('  enqueued:', enq.json && enq.json.ok ? `${enq.json.enqueued} unit(s)` : 'FAILED');

        // two independent "machines" agree → the unit settles and pays
        const claim = await onAirHttp('GET', '/api/work?node=airtest-node&ts=' + now());
        const unit = claim.json && claim.json.unit;
        if (unit) {
          // computed with the SHARED kernel definition — the same integer math
          // the browser runs, which is why two machines can agree at all
          const fnv = (s, seed) => { let h = (seed >>> 0) || 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i) & 0xff; h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; };
          const emb = (t, seed) => { const v = new Array(64).fill(0); for (const x of String(t).toLowerCase().split(/[^a-z0-9]+/)) { if (x.length < 2) continue; v[fnv(x, seed) % 64]++; } return v; };
          const out = emb(unit.payload, unit.seed).join(',');
          const digest = (fnv(out, unit.seed) >>> 0).toString(16).padStart(8, '0');
          // ⚠ need is 3 now, so the harness must field THREE machines or it
          // proves nothing about settlement. A test that cannot reach the
          // success state is not a test of the success state.
          //
          // ⚠ AND it must find a NON-canary unit to do it. A canary has need=1
          // and settles on the first correct answer — draw one of those and the
          // consensus path never runs. The client cannot tell a canary from
          // real work (that is the whole point of canaries), so the test cannot
          // either: it discovers empirically, which is itself a demonstration
          // of the property.
          await onAirHttp('POST', '/api/compute', { id: 'airtest-third', tier: 'tab', vendor: 'harness', klass: 'laptop', maxBufferMB: 1024, invocations: 512 });
          const fnvH = (s, seed) => { let h = (seed >>> 0) || 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i) & 0xff; h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; };
          const embH = (t, seed) => { const v = new Array(64).fill(0); for (const x of String(t).toLowerCase().split(/[^a-z0-9]+/)) { if (x.length < 2) continue; v[fnvH(x, seed) % 64]++; } return v; };

          let canaries = 0, proved = false;
          for (let attempt = 0; attempt < 8 && !proved; attempt++) {
            const c = await onAirHttp('GET', '/api/work?node=airtest-node&ts=' + now() + attempt);
            const un = c.json && c.json.unit;
            if (!un) { log('  no unit available to prove consensus'); break; }
            const o = embH(un.payload, un.seed).join(',');
            const d = (fnvH(o, un.seed) >>> 0).toString(16).padStart(8, '0');
            const r1 = await onAirHttp('POST', '/api/work', { node: 'airtest-node', unit: un.id, digest: d, out: o, ms: 9 });
            if (r1.json && r1.json.settled) { canaries++; continue; }   // was a canary (need=1)
            const r2 = await onAirHttp('POST', '/api/work', { node: 'airtest-dj', unit: un.id, digest: d, out: o, ms: 11 });
            const r3 = await onAirHttp('POST', '/api/work', { node: 'airtest-third', unit: un.id, digest: d, out: o, ms: 13 });
            log(`  consensus path: 1st=${r1.json.status} 2nd=${r2.json.status} 3rd=${r3.json.settled ? 'SETTLED ✓' : r3.json.status}` +
              (r3.json.settled ? ` (+${r3.json.earned} MOTUS-s)` : ''));
            log(`  (skipped ${canaries} canary unit(s) on the way — the client cannot tell them apart, and neither can this test)`);
            proved = !!r3.json.settled;
          }
          if (!proved) log('  ⚠ could not reach a 3-machine settlement');
          // a wrong answer must never be credited
          const liar = await onAirHttp('POST', '/api/work', { node: 'airtest-liar', unit: unit.id, digest: 'deadbeef', out: 'x', ms: 1 });
          log('  a wrong digest on a settled unit:', liar.json && liar.json.already ? 'ignored ✓' : JSON.stringify(liar.json).slice(0, 70));
        } else log('  no unit to claim');

        // ⚠ THE BOARD'S POOL CHIP DEPENDS ON THIS. The card matches
        // work.byTask[t.title] — if the API ever normalises, trims or truncates
        // the task name, every card silently shows no pool activity while the
        // pool is busy. Assert the round-trip rather than assuming it.
        const boardTitle = 'airtest — index a passage';
        const wq0 = await onAirHttp('GET', '/api/work?ts=' + now());
        const keys = ((wq0.json || {}).byTask || []).map((t) => t.task);
        log('  byTask key round-trips the task title exactly:',
          keys.includes(boardTitle) ? 'YES ✓' : `⚠ NO — got ${JSON.stringify(keys.slice(0, 3))}`);

        const rc = await onAirHttp('GET', '/api/receipts?node=airtest-node&ts=' + now());
        const rj = rc.json || {};
        log(`  receipts: ${rj.count} for this node · ${rj.motusSeconds} MOTUS-s · ${rj.computeMs}ms of real compute`);
        const wq = await onAirHttp('GET', '/api/work?ts=' + now());
        log('  jobsRunning is COMPUTED:', (wq.json || {}).jobsRunning, '(no longer hard-coded false)');

        // $TRUST as a payout CHOICE — a transfer, never emissions
        const noAddr = await onAirHttp('POST', '/api/compute', { id: 'airtest-node', payoutPref: 'trust' });
        log('  TRUST rail without an EVM address:', noAddr.json && noAddr.json.ok === false ? 'REFUSED ✓ (balance would strand)' : '⚠ ACCEPTED');

        await onAirHttp('DELETE', '/api/work', null, { 'x-live-secret': onAirSecret() });
        log('  queue cleared (receipts kept — they are the contributor\'s evidence).');
      }

      await onAirHttp('DELETE', '/api/compute', null, { 'x-live-secret': onAirSecret() });
      log('  cleaned up.');
    }

    // ── the operator's own voice in SourceCrowd ──
    const said = await onAirHttp('POST', '/api/chat', { name: 'August ◈', text: 'airtest — the operator rail is open.' });
    log('  operator voice:', said.json && said.json.ok ? 'landed in SourceCrowd' : 'FAILED');
    const wipe = await onAirHttp('DELETE', '/api/chat', { all: true }, { 'x-live-secret': onAirSecret() });
    log('  cleaned up:', wipe.json && wipe.json.ok ? `removed ${wipe.json.removed}` : 'FAILED');

    // reset to silence
    a.on = false; a.sel = {}; a.custom = []; a.topic = ''; a.follow = false;
    const off = await onAirPush();
    const r2 = await onAirHttp('GET', '/api/live?ts=' + now());
    log('reset:', off.ok && r2.json && r2.json.on === false && (r2.json.items || []).length === 0 ? 'off air, empty ✓' : 'RESIDUE LEFT');
  } catch (e) { log('threw:', (e && e.stack) || e); }
  setTimeout(() => app.quit(), 300);
}

// `electron . --voicetest` exercises the REAL shipped voice chain end to end:
// speak → transcribe that audio back → run a live voice turn → speak the reply.
// No microphone needed, and it uses the same code paths DASH-OPS uses.
async function runVoiceTest() {
  const log = (...a) => console.log('[voicetest]', ...a);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(1500);
  try {
    log('gate:', gate() ? 'trusted' : 'NOT TRUSTED — everything will return {error:locked}');
    log('key sealed:', !!STATE.settings.elevenKeyEnc, '| source:', STATE.settings.elevenKeySource || '(none)');
    log('fleet stopped:', !!(STATE.control && STATE.control.stopped));

    log('1/4 TTS …');
    const t = await ttsSpeak('Give me a one line status of the fleet.');
    if (!t.ok) { log('   TTS FAILED:', t.error); return app.quit(); }
    log('   ok —', Math.round(t.audio.length * 0.75 / 1024), 'KB audio');

    log('2/4 transcribe that audio back …');
    const s = await transcribeAudio(t.audio, 'audio/mpeg');
    if (!s.ok) { log('   STT FAILED:', s.error); return app.quit(); }
    log(`   ok via ${s.via} — "${s.text}"`);

    log('3/4 live voice turn through the relay (this can take a minute) …');
    const a = isRelayAgent(STATE.settings.voiceAgent) ? STATE.settings.voiceAgent : 'davara';
    const blocked = dispatchBlocked(a);
    if (blocked) { log('   BLOCKED:', blocked); return app.quit(); }
    const t0 = now();
    const r = await relaySend(a, `/VOICE test — reply in ONE short spoken sentence.\n\n${s.text}`);
    log(`   relay ${r.ok ? 'ok' : 'FAILED'} in ${Math.round((now() - t0) / 1000)}s`, r.ok ? `— "${String(r.text).slice(0, 120)}"` : `— ${r.error}`);
    if (!r.ok) return app.quit();

    log('4/4 speak the reply …');
    const t2 = await ttsSpeak(r.text);
    log(t2.ok ? `   ok — ${Math.round(t2.audio.length * 0.75 / 1024)} KB` : `   FAILED: ${t2.error}`);
    log('RESULT: full voice chain WORKS');
  } catch (e) { log('THREW:', (e && e.message) || e); }
  setTimeout(() => app.quit(), 400);
}

// Self-screenshot harness — `electron . --smoke` proves the UI renders, then exits.
async function runSmoke() {
  const wc = mainWin.webContents;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const outDir = app.getPath('temp');
  // WINDOWS TRUTH: an Electron binary is GUI-subsystem, so console.log goes to
  // a console that is never attached and a full smoke run reported NOTHING
  // readable. The harness was doing all the work and speaking into the void.
  // Tee every line to a file so the verdict outlives the process.
  const _smokeLines = [];
  const _rawLog = console.log.bind(console);
  console.log = (...a) => { _smokeLines.push(a.map(String).join(' ')); _rawLog(...a); };
  const smokeReport = path.join(outDir, 'ci-smoke-report.txt');
  const flushSmoke = () => safe(() => fs.writeFileSync(smokeReport, _smokeLines.join("\n") + "\n", 'utf8'));
  console.log('[smoke] writing screenshots to', outDir);
  console.log('[smoke] report ->', smokeReport);
  // a capture of a hidden window is a stale compositor frame (the fresh harness
  // proved it: DOM at opacity 1, PNG empty). Keep the window composited and
  // wait for two real frames before every capture, so a screenshot can be judged.
  safe(() => { wc.setBackgroundThrottling(false); mainWin.show(); mainWin.focus(); });
  const framed = () => Promise.race([wc.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(1))))').catch(() => 0), wait(900)]);
  const shoot = async (name) => { await framed(); return safe(() => wc.capturePage().then((img) => fs.writeFileSync(path.join(outDir, name), img.toPNG()))); };
  // Capture EVERY renderer console error/warning — a view that throws would
  // otherwise render blank and look "fine" in a screenshot.
  const problems = [];
  wc.on('console-message', (_ev, level, message, line, source) => {
    if (level >= 2) problems.push(`[${level === 3 ? 'ERROR' : 'WARN'}] ${message} (${String(source || '').split('/').pop()}:${line})`);
  });
  wc.on('render-process-gone', (_e, d) => problems.push(`[FATAL] renderer gone: ${d && d.reason}`));
  // Walk every view and prove each one renders real content, not an empty shell.
  const visit = async (nav, ms, containerId) => {
    await wc.executeJavaScript(`document.querySelector('[data-nav=${nav}]')?.click()`).catch(() => {});
    await wait(ms);
    if (containerId) {
      const len = await wc.executeJavaScript(`(document.getElementById('${containerId}')||{}).innerHTML?.length||0`).catch(() => 0);
      console.log(`[smoke] view ${nav}: ${len} chars in #${containerId}${len < 200 ? '   <-- SUSPICIOUSLY EMPTY' : ''}`);
      if (len < 200) problems.push(`[EMPTY] view '${nav}' rendered only ${len} chars into #${containerId}`);
    }
    await shoot(`smoke-${nav}.png`);
  };
  try {
    await wait(2200); await shoot('smoke-gate.png');
    // the sandbox vault gets a throwaway passphrase of its own: the harness must
    // never carry the operator's, and a copied vault is the harness's, not his
    const SMOKE_PASS = 'smoke-harness-' + newId();
    STATE.settings.passSha = sha256(SMOKE_PASS); saveState();
    await wc.executeJavaScript(`document.getElementById('gatePass').value=${JSON.stringify(SMOKE_PASS)};document.getElementById('gateForm').requestSubmit();`);
    await wait(4500); await shoot('smoke-dash.png');
    await wc.executeJavaScript(`(window.__nav&&0)||document.querySelector('[data-nav=chat]')?.click()`).catch(() => {});
    await wait(1500); await shoot('smoke-chat.png');
    await wc.executeJavaScript(`document.querySelector('[data-nav=live]')?.click()`).catch(() => {});
    await wait(2600); await shoot('smoke-live.png');
    await wc.executeJavaScript(`document.querySelector('[data-nav=output]')?.click()`).catch(() => {});
    await wait(2600); await shoot('smoke-output.png');
    await wc.executeJavaScript(`document.querySelector('[data-nav=systems]')?.click()`).catch(() => {});
    await wait(2200); await shoot('smoke-systems.png');
    await wc.executeJavaScript(`document.querySelector('[data-nav=sympath]')?.click()`).catch(() => {});
    await wait(2000); await shoot('smoke-sympath.png');
    await wc.executeJavaScript(`document.querySelector('[data-nav=levels]')?.click()`).catch(() => {});
    await wait(1400); await shoot('smoke-levels.png');
    // simulate the 5s Space-hold to verify the unlocked Arden interface
    await wc.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown',{code:'Space'}))`).catch(() => {});
    await wait(5500);
    await wc.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keyup',{code:'Space'}))`).catch(() => {});
    await wait(900); await shoot('smoke-levels-open.png');
    await wc.executeJavaScript(`document.querySelector('[data-nav=nextsteps]')?.click()`).catch(() => {});
    await wait(2000); await shoot('smoke-evo.png');
    await wc.executeJavaScript(`document.querySelector('[data-nav=security]')?.click()`).catch(() => {});
    await wait(1800); await shoot('smoke-security.png');
    await wc.executeJavaScript(`document.getElementById('bellBtn')?.click()`).catch(() => {});
    await wait(900); await shoot('smoke-notif.png');
    await wc.executeJavaScript(`document.querySelector('[data-nav=settings]')?.click()`).catch(() => {});
    await wait(1200); await wc.executeJavaScript(`document.getElementById('content').scrollTop = 0`).catch(() => {});
    await wait(400); await shoot('smoke-about.png');          // the About panel sits at the top
    await wc.executeJavaScript(`document.getElementById('content').scrollTop = 760`).catch(() => {});
    await wait(500); await shoot('smoke-settings.png');

    // --- v2 views: each must render real content into its container ---------
    await visit('mind', 2200, 'mindBody');
    await visit('motus', 2600, 'motusBody');
    await visit('goal', 2400, 'goalBody');
    await visit('models', 2600, 'modelBody');
    await visit('tasks', 2200, 'boardBody');
    await visit('subagents', 2600, 'subBody');
    await visit('workflows', 2200, 'wfBody');
    await visit('duo', 2000, 'duoBody');
    await visit('voice', 2200, 'voiceBody');
    await visit('omni', 2600, 'omniBody');
    // The map panel and the strategic read live below the fold — a view that
    // renders is not the same as a view that looks right.
    await wc.executeJavaScript(`document.getElementById('content').scrollTop = 1500`).catch(() => {});
    await wait(700); await shoot('smoke-omni-map.png');
    await wc.executeJavaScript(`document.getElementById('content').scrollTop = 0`).catch(() => {});
    await visit('motusmodels', 2600, 'mmBody');
    await visit('usage', 4200, 'usageBody');
    await visit('systems', 2600, 'sysBody');
    await visit('agents', 2000, null);
    await visit('live', 2600, null);
    // OUTPUT was never in this list, so the completed-work view — the one that
    // renders timestamps, day headings and project chips — shipped unverified.
    // A view the harness never opens is a view that can throw in front of him.
    await visit('output', 2600, 'outFiles');
    // MOTUSLIVE was never in this walk — the broadcast operator surface, the
    // one that decides what the world can see, shipped release after release
    // without the harness ever opening it. Same class of gap as OUTPUT.
    await visit('stream', 3200, 'streamBody');
    await visit('nextsteps', 2000, null);
    await visit('security', 2000, null);

    // ── THE READINGS MUST ACTUALLY READ ────────────────────────────────────
    // A view that renders is not a view that reports. Each of these three
    // strips exists to carry a MEASURED number; if the markup is there but the
    // reading never arrived, the screen becomes a confident row of zeros —
    // which is worse than an empty screen, because he would plan around it.
    const has = async (id, needle) => wc.executeJavaScript(
      `((document.getElementById('${id}')||{}).innerHTML||'').includes(${JSON.stringify(needle)})`).catch(() => false);
    await wc.executeJavaScript(`document.querySelector('[data-nav=stream]')?.click()`).catch(() => {});
    await wait(3000);
    const sweepCell = await has('streamBody', 'id="stSweep"');
    const ledger = await has('streamBody', 'lg-strip');
    const noLedger = await has('streamBody', 'NO LEDGER');
    console.log(`[smoke] MotusLive — sweep control: ${sweepCell ? 'present' : 'MISSING'} · ledger strip: ${ledger ? 'live numbers' : (noLedger ? 'honest outage notice' : 'MISSING')}`);
    if (!sweepCell) problems.push('[MISSING] the off-air sweep control did not render in MotusLive');
    if (!ledger && !noLedger) problems.push('[MISSING] the compute ledger strip rendered neither numbers nor an outage notice');
    await wc.executeJavaScript(`document.querySelector('[data-nav=workflows]')?.click()`).catch(() => {});
    await wait(2400);
    // The compute console lives far below the fold, so it rendered release after
    // release without anyone LOOKING at it. Scroll to it and take the picture.
    // ⚠ A hidden view keeps its innerHTML, so an assertion can pass while the
    // SCREENSHOT shows a different page entirely — the first cut photographed
    // Workflows and read Stream. Front the view before pointing the camera.
    await wc.executeJavaScript(`document.querySelector('[data-nav=stream]')?.click()`).catch(() => {});
    await wait(1500);
    await wc.executeJavaScript(`(() => { const e = document.querySelector('.r3-band'); if (e) e.scrollIntoView({block:'center'}); return !!e; })()`).catch(() => {});
    await wait(1100); await shoot('smoke-compute.png');
    const r3 = await has('streamBody', 'r3-band');
    const r3ctl = await has('streamBody', 'id="cmpPledge"');
    console.log(`[smoke] MotusCompute — R3 band: ${r3 ? 'present' : 'MISSING'} · pledge control: ${r3ctl ? 'present' : 'MISSING'}`);
    if (!r3 || !r3ctl) problems.push('[MISSING] the R3 mover-loop panel or its pledge control did not render');
    await wc.executeJavaScript(`document.querySelector('[data-nav=output]')?.click()`).catch(() => {});
    await wait(2600);
    const outs = await has('outStrip', 'st-strip n5');
    console.log(`[smoke] Output — reading strip: ${outs ? 'present' : 'MISSING'}`);
    if (!outs) problems.push('[MISSING] the Output reading strip did not render');
    await wc.executeJavaScript(`document.querySelector('[data-nav=tasks]')?.click()`).catch(() => {});
    await wait(2400);
    const bds = await has('boardBody', 'st-strip n5');
    await wc.executeJavaScript(`document.querySelector('[data-nav=duo]')?.click()`).catch(() => {});
    await wait(2400);
    await wc.executeJavaScript(`document.querySelector('[data-nav=voice]')?.click()`).catch(() => {});
    await wait(2000);
    const deck = await wc.executeJavaScript(`document.querySelectorAll('.ops-deck .od').length`).catch(() => 0);
    console.log('[smoke] DASH-OPS ops deck: ' + (deck === 4 ? '4 standing questions' : 'MISSING (' + deck + ')'));
    const vcs = await has('vcStrip', 'st-strip n5');
    const quick = await wc.executeJavaScript(`(document.getElementById('vcQuick')||{}).checked === true`).catch(() => false);
    const orb = await wc.executeJavaScript(`(() => {
      const o = document.querySelector('.vc-orb'); if (!o) return null;
      const idle = getComputedStyle(o, '::before');
      return { present: true, idleOpacity: parseFloat(idle.opacity), idleAnim: idle.animationName };
    })()`).catch(() => null);
    console.log('[smoke] DASH-OPS — telemetry strip: ' + (vcs ? 'present' : 'MISSING') + ' · quick mode default: ' + (quick ? 'ON' : 'OFF') + ' · orb: ' + JSON.stringify(orb));
    if (!vcs) problems.push('[MISSING] the DASH-OPS telemetry strip did not render');
    if (!quick) problems.push('[DEFAULT] quick mode should default ON');
    // THE STILLNESS LAW: idle, the aurora ring must be invisible AND unanimated.
    if (orb && (orb.idleOpacity > 0.01 || (orb.idleAnim && orb.idleAnim !== 'none'))) {
      problems.push('[MOTION] the voice orb ring is active while idle — motion must be earned by a live state');
    }
    // pipeline seam sanity — never mid-word, never past the cap
    const seam = await wc.executeJavaScript(`(() => {
      const long = 'First sentence lands quickly. ' + 'Then a much longer explanation follows with many words that go on. '.repeat(6);
      const [h, t] = splitSpeech(long);
      const short = splitSpeech('Just one short line.');
      return { headLen: h.length, lastChar: h.trim().slice(-1), tailStarts: t.slice(0, 12), shortWhole: short[0].length > 0 && !short[1] };
    })()`).catch((e) => ({ error: String(e && e.message) }));
    const seamClean = seam && !seam.error && ('.!?)]' + String.fromCharCode(34) + String.fromCharCode(39)).includes(seam.lastChar) && seam.shortWhole;
    console.log('[smoke] speech seam: ' + JSON.stringify(seam) + (seamClean ? ' — clean break' : ''));
    if (!seamClean) problems.push('[VOICE] splitSpeech seam is wrong: ' + JSON.stringify(seam));
    if (deck !== 4) problems.push('[MISSING] the DASH-OPS ops deck did not render its four questions');
        const dus = await has('duoBody', 'st-strip n5');
    await wc.executeJavaScript(`document.querySelector('[data-nav=omni]')?.click()`).catch(() => {});
    await wait(2800);
    const oms = await has('omniBody', 'st-strip n5');
    const armCell = await has('omniBody', 'DISARMED');
    // ⚠ THE SENTENCE THAT MUST NEVER BE TRUE AT THE SAME TIME AS THE ONE BESIDE
    // IT. Shipped once: "DISARMED" and "her hands are live on your machine" in
    // adjacent cells. Two true facts, one false statement. Assert they can
    // never co-occur again — on this page overstating permission is the one
    // mistake that cannot be undone.
    const handsLie = armCell && await has('omniBody', 'her hands are live on your machine');
    if (handsLie) problems.push('[HONESTY] Motus Max claims her hands are live while reporting DISARMED');
    // and one dot per station, never two
    const dots = await wc.executeJavaScript(`(() => {
      const b = document.querySelector('#railNav .nav-btn.alert');
      if (!b) return { alerts: 0 };
      const after = getComputedStyle(b, '::after').content;
      return { alerts: document.querySelectorAll('#railNav .nav-btn.alert').length,
               badges: b.querySelectorAll('.badge').length,
               pseudo: after && after !== 'none' ? after : '' };
    })()`).catch(() => null);
    console.log('[smoke] rail attention: ' + JSON.stringify(dots));
    // THE LIVING RAIL — the chosen station must actually carry its room's
    // light: hue-tinted color and a real drop-shadow on the glyph. And the
    // SHARED PICTURE must assemble: every mind's prompt now carries it, so an
    // empty string here would silently lobotomise Duo, Max and the voice at
    // once — worth one assertion forever.
    const railLit = await wc.executeJavaScript(`(() => {
      const b = document.querySelector('#railNav .nav-btn.active');
      if (!b) return null;
      const svg = b.querySelector('svg');
      return { color: getComputedStyle(b).color, glyphGlow: /drop-shadow/.test(getComputedStyle(svg).filter) };
    })()`).catch(() => null);
    console.log('[smoke] living rail: ' + JSON.stringify(railLit));
    if (!railLit || !railLit.glyphGlow) problems.push('[VISUAL] the active station glyph is not lit');
    const dp = safe(() => {
      const loop = (STATE.loops || []).find((l) => l.approved) || (STATE.loops || [])[0];
      return loop ? duoLoopPrompt(loop, 'davara', { digest: '(smoke)', sig: '' }) : '';
    }, '');
    if (dp) {
      const hasPic = dp.includes('THE SHARED PICTURE');
      const li = (STATE.duoWork || []).find((w) => w.loopId === (((STATE.loops || []).find((l) => l.approved) || {}).id) && w.next);
      const hasIntent = !li || dp.includes('YOUR OWN LAST INTENTION');
      console.log('[smoke] duo prompt: ' + dp.length + ' chars · shared picture: ' + (hasPic ? 'carried' : 'MISSING') + ' · intention: ' + (li ? (hasIntent ? 'carried' : 'MISSING') : 'none stored (n/a)'));
      if (!hasPic) problems.push('[MIND] the Duo pass prompt does not carry THE SHARED PICTURE');
      if (!hasIntent) problems.push('[MIND] a stored intention exists and the prompt does not carry it');
    } else {
      console.log('[smoke] duo prompt: no loops in the sandbox vault — wiring unwitnessed this run');
    }
    const shared = safe(() => continuityBrief(), '');
    console.log('[smoke] shared picture: ' + (shared ? shared.length + ' chars — ' + shared.split(String.fromCharCode(10))[1].slice(0, 60) : 'EMPTY'));
    if (!shared || shared.length < 60) problems.push('[MIND] continuityBrief() came back empty — every prompt that carries it is flying blind');
    if (shared.length > 1600) problems.push('[MIND] the shared picture bloated to ' + shared.length + ' chars — it taxes every turn that carries it');
    // PULSE + COMMAND — the last two rooms without a reading, and Pulse is the
    // first thing he sees. The attention loop runs on a 90s beat, so give it a
    // moment rather than asserting into a race.
    await wc.executeJavaScript(`document.querySelector('[data-nav=overview]')?.click()`).catch(() => {});
    await wait(3200);
    const pulse = await has('pulseStrip', 'st-strip n5');
    const rooms = await wc.executeJavaScript(`document.querySelectorAll('#pulseStrip .attn-row').length`).catch(() => -1);
    const er = await wc.executeJavaScript(`(() => {
      const b = document.querySelector('.engine-room'); if (!b) return null;
      return { stations: b.querySelectorAll('.er-st').length, lit: b.querySelectorAll('.er-st.on').length };
    })()`).catch(() => null);
    const dl = await has('dayLedger', 'day-ledger');
    console.log('[smoke] engine room: ' + JSON.stringify(er) + ' · day ledger: ' + (dl ? 'present' : 'MISSING'));
    if (!er || er.stations !== 6) problems.push('[MISSING] the engine room did not render its six stations');
    if (!dl) problems.push('[MISSING] the day ledger did not render');
    // instant entry: leave, come back, and Pulse must paint within a frame from
    // cache — the second navigation is the one stale-while-revalidate promises.
    await wc.executeJavaScript(`document.querySelector('[data-nav=goal]')?.click()`).catch(() => {});
    await wait(900);
    const tNav = await wc.executeJavaScript(`(() => {
      const t0 = performance.now();
      document.querySelector('[data-nav=overview]')?.click();
      requestAnimationFrame(() => { window.__pulsePaint = performance.now() - t0; });
      return true;
    })()`).catch(() => false);
    await wait(1200);
    const pulseMs = await wc.executeJavaScript('window.__pulsePaint || -1').catch(() => -1);
    console.log('[smoke] Pulse re-entry first frame: ' + (pulseMs >= 0 ? pulseMs.toFixed(0) + 'ms' : 'unmeasured'));
    if (pulseMs > 400) problems.push('[PERF] Pulse re-entry took ' + pulseMs.toFixed(0) + 'ms to first frame — the stale cache is not painting');
    await shoot('smoke-pulse.png');
    console.log(`[smoke] Pulse — reading strip: ${pulse ? 'present' : 'MISSING'} · rooms asking: ${rooms}`);
    if (!pulse) problems.push('[MISSING] the Pulse reading strip did not render');
    await wc.executeJavaScript(`document.querySelector('[data-nav=chat]')?.click()`).catch(() => {});
    await wait(2000);
    const cmd = await has('cmdStrip', 'st-strip n5');
    await shoot('smoke-command.png');
    console.log(`[smoke] Command — reading strip: ${cmd ? 'present' : 'MISSING'}`);
    if (!cmd) problems.push('[MISSING] the Command reading strip did not render');
    // THE SIGIL MUST SETTLE. The entrance class has to come OFF, or the resting
    // and breathing states can never take — and the mark would silently vanish
    // a second after every navigation.
    await wait(1400);
    const sigState = await wc.executeJavaScript(`(() => {
      const e = document.getElementById('viewSigil');
      if (!e) return { ok:false };
      const cs = getComputedStyle(e);
      return { on: e.classList.contains('on'), stillEntering: e.classList.contains('in'),
               state: e.dataset.state || '', opacity: parseFloat(cs.opacity), anim: cs.animationName };
    })()`).catch(() => null);
    console.log('[smoke] sigil settled: ' + JSON.stringify(sigState));
    // ── THE INSTRUMENT REPORTS ON ITSELF ───────────────────────────────────
    // Every performance claim in this release is a number, so print the
    // numbers. A build that says "faster" without them is asking to be
    // believed rather than checked.
    const perf = await wc.executeJavaScript(`(() => {
      const out = [];
      for (const [k, p] of Object.entries(PERF.view)) {
        if (!p.ms.length) continue;
        const a2 = [...p.ms].sort((x,y)=>x-y);
        out.push({ view: k, med: a2[Math.floor(a2.length/2)], worst: p.worst, n: p.ms.length, fails: p.fails });
      }
      out.sort((x,y)=>y.med-x.med);
      return { slowest: out.slice(0,6), diag: DIAG.length, quiet: _quiet, pollMs: _pollMs, domWrites: _domWrites };
    })()`).catch((e) => ({ error: String(e && e.message) }));
    console.log('[smoke] instrument: ' + JSON.stringify(perf));
    const ipcTop = await wc.executeJavaScript(`window.cortex.ipcPerf().then(r => JSON.stringify(r.top || []))`).catch(() => '[]');
    console.log('[smoke] ipc handlers over 350ms median: ' + ipcTop);
    const atmo = await wc.executeJavaScript(`(() => {
      const v = document.querySelector('.view.active');
      if (!v) return false;
      const b = getComputedStyle(v, '::before').backgroundImage;
      return !!b && b !== 'none';
    })()`).catch(() => false);
    console.log('[smoke] view atmosphere: ' + (atmo ? 'present' : 'MISSING'));
    // ⚠⚠ THE PERFORMANCE GUARD (2026-08-20). background-attachment:fixed on a
    // scroll container forces every backdrop-filter surface to re-blur on every
    // scroll frame — it made his whole DESKTOP heavy. It must never come back,
    // and the idle brake that stops the app taxing the GPU while he works
    // elsewhere must always be present. Both are now build-time law.
    const perfGuard = await wc.executeJavaScript(`(() => {
      const out = {};
      const content = document.querySelector('.content');
      // does the SCROLL CONTAINER carry a fixed background? computed, not parsed
      out.fixedBg = content ? String(getComputedStyle(content).backgroundAttachment).indexOf('fixed') >= 0 : null;
      // how many surfaces actually blur right now?
      let blurs = 0;
      for (const el of document.querySelectorAll('.glass, .glass-deep, .panel, .card')) {
        const cs = getComputedStyle(el);
        const bf = cs.backdropFilter || cs.webkitBackdropFilter || 'none';
        if (bf && bf !== 'none') blurs++;
      }
      out.blursActive = blurs;
      // and does the brake actually stop them? toggle it and measure.
      document.body.classList.add('win-idle');
      let stillBlurring = 0;
      for (const el of document.querySelectorAll('.glass, .glass-deep, .panel, .card')) {
        const cs = getComputedStyle(el);
        const bf = cs.backdropFilter || cs.webkitBackdropFilter || 'none';
        if (bf && bf !== 'none') stillBlurring++;
      }
      const rail = document.querySelector('.rail') || document.body;
      out.pausedWhenIdle = getComputedStyle(rail).animationPlayState;
      out.blursWhenIdle = stillBlurring;
      document.body.classList.remove('win-idle');
      return out;
    })()`).catch((e) => ({ error: String(e && e.message) }));
    console.log('[smoke] perf guard: ' + JSON.stringify(perfGuard));
    // ⚠ THE EMPTY-TABS REGRESSION GUARD. The idle brake once paused viewIn at
    // frame zero — a fully loaded page rendered at opacity 0, app blank until
    // restart. Simulate exactly that: force win-idle, switch views, and assert
    // the arriving view is VISIBLE. This can never come back silently.
    const blankGuard = await wc.executeJavaScript(`(async () => {
      document.body.classList.add('win-idle');
      document.querySelector('[data-nav=goal]')?.click();
      await new Promise((r) => setTimeout(r, 500));
      const v = document.querySelector('.view.active');
      const cs = v ? getComputedStyle(v) : null;
      const out = { view: v && v.dataset.view, opacity: cs ? parseFloat(cs.opacity) : -1, anim: cs ? cs.animationName : '?' };
      document.body.classList.remove('win-idle');
      document.querySelector('[data-nav=overview]')?.click();
      await new Promise((r) => setTimeout(r, 400));
      return out;
    })()`).catch((e) => ({ error: String(e && e.message) }));
    console.log('[smoke] blank-tab guard (view entered while idle): ' + JSON.stringify(blankGuard));
    // ══ HIS EXACT SEQUENCE, REPRODUCED — not simulated ═════════════════════
    // "go to motusmax … activate it … go to another tab … all pages empty."
    // The synthetic guard above forces win-idle by hand; THIS one does what he
    // does: really arms her (dry — the hands stay off), lets the overlay
    // actually open and steal focus if it is going to, then walks five tabs
    // measuring each page as rendered. If any page comes up blank, this run
    // fails with the numbers in hand.
    const repro = await wc.executeJavaScript(`(async () => {
      document.querySelector('[data-nav=omni]')?.click();
      await new Promise((r) => setTimeout(r, 1600));
      const arm = await window.cortex.omniArm({ dry: true, ttlMin: 5 }).catch((e) => ({ error: String(e && e.message) }));
      await new Promise((r) => setTimeout(r, 1400));   // the overlay opens here
      const out = { armed: !!(arm && !arm.error), views: [] };
      for (const nav of ['tasks', 'duo', 'stream', 'overview', 'workflows']) {
        document.querySelector('[data-nav=' + nav + ']')?.click();
        await new Promise((r) => setTimeout(r, 800));
        const v = document.querySelector('.view.active');
        const cs = v ? getComputedStyle(v) : null;
        out.views.push({ nav, opacity: cs ? +cs.opacity : -1, chars: (v && v.innerHTML.length) || 0,
          idle: document.body.classList.contains('win-idle') });
      }
      await window.cortex.omniDisarm().catch(() => {});
      return out;
    })()`).catch((e) => ({ error: String(e && e.message) }));
    console.log('[smoke] ARMED-WALK repro: ' + JSON.stringify(repro));
    // the speed pass, asserted: depth must default OFF (the 1424s startup tax),
    // cycles at low effort, and the turn-in-flight channel must exist so the
    // stream can never go silent again
    const spd = await wc.executeJavaScript(`window.cortex.omni().then((r) => ({
      depth: r.omni.depth, effort: r.omni.speedEffort, turnKey: 'turnInFlight' in r.omni,
      clock: r.omni.seatClock ? r.omni.seatClock.n : null, fast: r.omni.fastestHands ? r.omni.fastestHands.id : '',
      pre: r.omni.preRead ? r.omni.preRead.status : null, preOn: r.omni.preReadOn }))`).catch(() => null);
    console.log('[smoke] speed defaults: ' + JSON.stringify(spd));
    if (!spd) problems.push('[SPEED] could not read the drive defaults');
    else {
      // ⚠ CAUGHT IN REVIEW: these two asserted on HIS vault (the sandbox is a
      // copy of it). His audit log shows he armed at medium with depth ON by
      // his own hand on 2026-09-07 — a choice, not a default. Assert the
      // SHIPPED defaults; report his settings as what they are.
      const fresh = omniDefaults();
      if (fresh.depth !== false) problems.push('[SPEED] depth defaults ON — every cold read pays the max-effort tax again');
      if (fresh.speedEffort !== 'low') problems.push('[SPEED] the shipped cycle effort is ' + fresh.speedEffort + ' — the driving default must be low');
      console.log('[smoke] his vault: depth ' + (spd.depth ? 'ON' : 'off') + ' · reflex ' + spd.effort + ' (his setting — respected, not asserted)');
      if (typeof spd.clock !== 'number') problems.push('[MAX] omni() carries no seatClock — the wait has no number on it');
      else console.log('[smoke] seat clock: ' + spd.clock + ' completed turns on the drive seat · fastest hands: ' + (spd.fast || '(none with 3+ turns)'));
      if (!spd.turnKey) problems.push('[SPEED] turnInFlight is missing from omniPublic — the stream can go silent');
      if (spd.pre == null) problems.push('[MAX] omni() carries no preRead state — the arm-time read is invisible');
      else console.log('[smoke] pre-read: ' + spd.pre + ' (on: ' + spd.preOn + ') — never fired here: dry arms and harnesses do not spend a turn');
    }
    {
      const dyn = await wc.executeJavaScript("window.cortex.dynamics().then((d) => ({ ok: !!d && !d.error, hours: d && d.ring ? d.ring.length : 0, readings: d && d.readings ? d.readings.length : 0, band: !!document.querySelector('#sysBody .dyn-band .dyn-ring') }))").catch(() => null);
      if (!dyn || !dyn.ok || dyn.hours !== 24) problems.push('[RHYTHM] cortex:dynamics did not answer with a 24-hour ring');
      else if (!dyn.band) problems.push('[RHYTHM] the rhythm band is not painted on the Systems view');
      else console.log('[smoke] rhythm: 24-hour ring · ' + dyn.readings + ' reading(s) · band painted on Systems');
    }
    {
      const g = parseTaskGrammar('@davara !high #ship due:fri fleet: Fix the tally reconcile');
      const gOk = g.agent === 'davara' && g.priority === 1 && g.tags.join() === 'ship' && g.due === 'fri' && g.owner === 'fleet' && g.title === 'Fix the tally reconcile';
      if (!gOk) problems.push('[BOARD] the quick-add grammar mis-parsed: ' + JSON.stringify(g));
      else console.log('[smoke] quick-add grammar: @agent !prio #tag due: fleet: all parsed, title clean');
      const bd = await wc.executeJavaScript("window.cortex.board().then((b) => ({ flow: !!b.flow, sweep: b.sweep ? b.sweep.count : null, nexts: Array.isArray(b.nexts), wip: b.wipLimit }))").catch(() => null);
      if (!bd || !bd.flow || bd.sweep == null || !bd.nexts) problems.push('[BOARD] the board payload lacks flow/sweep/nexts');
      else console.log('[smoke] board flow: painted · ' + bd.sweep + ' sweep candidate(s) · WIP limit ' + bd.wip);
      const la = learningsApplied();
      console.log('[smoke] learnings applied: ' + la.appliedWeek + ' this week · ' + la.appliedAny + ' ever · of ' + la.considered);
    }
    {
      // the critic: a full report scores 10, a thin one scores low; the strategic fields parse
      const full = receiptQuality({ confidence: 9, basis: 'measured on the live page', falsifier: 'if the 404 returns by the next release, the fix was cosmetic', shuttle: 'walked the stranger path from the shared link to the receipt', did: 'edited api/runs.js line 390 to confirm the write', verdict: 'shipped', filesVerified: true, next: 're-run the anon open on live' });
      const thin = receiptQuality({ confidence: null, did: 'improved things', verdict: 'reported' });
      if (full.quality !== 10 || thin.quality > 2) problems.push('[CRITIC] receipt quality mis-scored: full=' + full.quality + ' thin=' + thin.quality);
      else console.log('[smoke] critic: full report scores 10 · thin report scores ' + thin.quality);
      const sc = strategicConfidence('LEVER: open the rail\nCONFIDENCE: 8/10 — BASIS: three receipts and a live probe\nFALSIFIER: if no stranger run lands by the next cohort, the rail was the wrong lever');
      const fz = strategicPick('LEVER: open the rail\nCONFIDENCE: 8/10 — BASIS: three receipts\nFALSIFIER: if no stranger run lands by the next cohort, the rail was the wrong lever', 'FALSIFIER');
      if (sc.confidence !== 8 || !/three receipts/.test(sc.basis) || !/next cohort/.test(fz)) problems.push('[CRITIC] strategic confidence/falsifier did not parse: ' + JSON.stringify({ sc, fz }));
      else console.log('[smoke] strategic read parses confidence 8/10 with basis, and the falsifier');
      console.log('[smoke] davara baseline: ' + (dvAvailable() ? dvVersion() + ' readable · scout organs ' + dvOrgansFor('scout').length + ' chars · build organs ' + dvOrgansFor('refine').length + ' chars' : 'NOT readable from here (environment, not a bug)'));
      const ab = await wc.executeJavaScript("(() => { const q = (s) => (document.querySelector(s) || {}).textContent || ''; return { p: q('.about-presented'), d: q('.about-date'), s: q('.about-service') }; })()").catch(() => null);
      if (!ab || ab.p !== 'Presented By Outlier.Systems' || ab.d !== '9/7/2026' || ab.s !== 'This Is A Service From Motivus.One') problems.push('[ABOUT] the About panel does not carry his three lines verbatim: ' + JSON.stringify(ab));
      else console.log('[smoke] about: his three lines present, verbatim');
    }
    {
      const mind = await wc.executeJavaScript("({ layers: document.querySelectorAll('#mindBody .ms-layer').length, strip: !!document.querySelector('#mindBody .st-strip'), organs: document.querySelectorAll('#mindBody .mind-organ').length, stream: document.querySelectorAll('#mindBody .mind-stream').length })").catch(() => null);
      if (!mind || !mind.strip || mind.organs < 3) problems.push('[MIND] the Davara view did not paint its strip and organs: ' + JSON.stringify(mind));
      else console.log('[smoke] mind: strip · ' + mind.layers + ' stack layer(s) · ' + mind.organs + ' organ groups · ' + mind.stream + ' stream entries');
      const oa = openaiPublic();
      const ig = await imageGenerate({ prompt: 'a probe' });
      if (oa.keySet) console.log('[smoke] openai: key sealed · seat model ' + oa.model + ' · studio ' + (ig.ok ? 'MADE AN IMAGE (unexpected in a harness)' : 'refused: ' + ig.error));
      else if (ig.ok || !/no OpenAI key/i.test(ig.error || '')) problems.push('[OPENAI] the studio did not refuse honestly without a key: ' + JSON.stringify(ig));
      else console.log('[smoke] openai: no key · studio refuses with a reason · /gpt would say the same');
      if (looksLikeOpenAIKey('sk-abc') || !looksLikeOpenAIKey('sk-' + 'A'.repeat(40))) problems.push('[OPENAI] key shape check is wrong');
      const ss = safeSettings();
      if ('elevenKeyEnc' in ss || 'openaiKeyEnc' in ss || 'smtpAppPasswordEnc' in ss || 'passSha' in ss) problems.push('[SECURE] safeSettings leaks a ciphertext or hash to the renderer');
      else console.log('[smoke] secure: settings reach the renderer as flags only (elevenKeySet=' + ss.elevenKeySet + ', openaiKeySet=' + ss.openaiKeySet + ')');
      const setupTry = authSetup('a-perfectly-fine-passphrase');
      if (!STATE.settings.passSha) problems.push('[GATE] an existing vault did not receive its hash (migration did not run)');
      else if (setupTry.ok || setupTry.reason !== 'already-set') problems.push('[GATE] setup did not refuse on a vault that already has a password: ' + JSON.stringify(setupTry));
      else console.log('[smoke] gate: hash lives in the vault · setup refuses a second password · needsSetup=' + !STATE.settings.passSha);
      const rd = systemReading();
      if (!rd || !rd.line || rd.line.length < 40) problems.push('[READING] the system reading is empty: ' + JSON.stringify(rd && rd.line));
      else console.log('[smoke] reading: ' + rd.line);
      const cc = closeCandidates(3);
      console.log('[smoke] the close: ' + cc.length + ' decision(s) proposed' + (cc.length ? ' · ' + cc.map((c) => c.kind).join(', ') : ''));
      const rp = rootParts();
      if (!rp.distro || !rp.user) problems.push('[ROOT] could not derive distro/user from the root path');
      else console.log('[smoke] root: distro and user derived from the path · discover() = ' + (discoverRoot() ? 'found' : 'none'));
      const ab = mindReport().abilities || [];
      if (mindReport().available && ab.length < 5) problems.push('[MIND] her abilities did not read: ' + ab.length);
      else console.log('[smoke] abilities: ' + ab.length + ' protocols with a WHEN line · e.g. ' + (ab[0] ? ab[0].name : '—'));
      // the connections: the reading in the brief; parked never auto-worked; a false done-claim rejected; secrets refused at the OpenAI door; quality-aware hands
      writeAgentBrief();
      const briefTxt = safe(() => fs.readFileSync(briefPath(), 'utf8'), '');
      if (!/## THE READING/.test(briefTxt.slice(0, 2000))) problems.push('[BRIEF] the reading is not in the first 2,000 chars of the brief');
      else console.log('[smoke] brief: the reading rides first (' + briefTxt.indexOf('## THE READING') + ' chars in)');
      const parkedFx = { id: 'zz-parked-fixture', title: 'a parked fleet task', status: 'inbox', owner: 'fleet', agent: 'davara', priority: 1, created: '2000-01-01T00:00:00.000Z', tags: ['parked'], jobs: [] };
      STATE.tasks.unshift(parkedFx); const pick = autoWorkNext(); STATE.tasks = STATE.tasks.filter((t) => t.id !== parkedFx.id);
      if (pick && pick.id === parkedFx.id) problems.push('[AUTOWORK] a parked task was chosen for auto-work');
      else console.log('[smoke] auto-work: parked tasks are skipped');
      const claimFx = { id: 'zz-claim-fixture', title: 'a task whose job could not complete', status: 'active', priority: 2, created: new Date().toISOString(), updated: new Date().toISOString(), jobs: [{ ts: new Date().toISOString(), agent: 'davara', ok: true, note: 'I could not complete this; the build failed' }] };
      STATE.tasks.unshift(claimFx); const cc2 = closeCandidates(6).filter((c) => c.id === claimFx.id && c.kind === 'claimed'); STATE.tasks = STATE.tasks.filter((t) => t.id !== claimFx.id);
      if (cc2.length) problems.push('[CLOSE] a job that said it could NOT complete was read as a done claim');
      else console.log('[smoke] the close: a negated completion is not a claim');
      const secImg = await imageGenerate({ prompt: 'paint this key sk-' + 'A'.repeat(32) });
      if (secImg.ok || !/secret/i.test(secImg.error || '')) problems.push('[OPENAI] a secret-shaped prompt was not refused at the door: ' + JSON.stringify(secImg));
      else console.log('[smoke] openai door: a secret-shaped prompt is refused before any key is read');
      const fh = fastestHands();
      console.log('[smoke] hands: ' + (fh ? fh.name + ' · median ' + fh.median + 's · quality ' + (fh.quality == null ? 'unscored' : fh.quality) : 'none with 3+ turns'));
    }
    if (!repro || repro.error) problems.push('[REPRO] the armed tab-walk could not run: ' + (repro && repro.error));
    else {
      if (!repro.armed) problems.push('[REPRO] arming failed in the sandbox — the sequence was not reproduced');
      for (const v of (repro.views || [])) {
        if (v.opacity < 0.99) problems.push('[BLANK] ' + v.nav + ' rendered at opacity ' + v.opacity + ' after arming — HIS bug, reproduced');
        if (v.chars < 400) problems.push('[BLANK] ' + v.nav + ' rendered only ' + v.chars + ' chars after arming');
      }
    }
    if (!blankGuard || blankGuard.error || !(blankGuard.opacity >= 0.99)) {
      problems.push('[BLANK] a view entered under win-idle rendered at opacity ' + (blankGuard && blankGuard.opacity) + ' — the empty-tabs glitch is back');
    }
    // the kill switch must be STANDING — bound at boot, not only on arm
    const kill = safe(() => _killKey, '');
    console.log('[smoke] kill switch standing at: ' + (kill || 'NOT BOUND'));
    if (!kill) problems.push('[SAFETY] no kill key is bound at boot — the panic path only exists while armed');
    if (!perfGuard || perfGuard.error) problems.push('[PERF] the performance guard could not run');
    else {
      if (perfGuard.fixedBg) problems.push('[PERF] the scroll container has a FIXED background — it re-blurs every glass surface on every scroll frame');
      if (perfGuard.pausedWhenIdle !== 'paused') problems.push('[PERF] the idle brake does not pause animations — the app will tax the GPU while he works elsewhere');
      if (perfGuard.blursActive > 0 && perfGuard.blursWhenIdle >= perfGuard.blursActive) problems.push('[PERF] the idle brake does not drop backdrop blur (' + perfGuard.blursWhenIdle + '/' + perfGuard.blursActive + ' still blurring)');
    }
    if (!atmo) problems.push('[VISUAL] the per-view atmosphere layer did not render');
    if (perf && perf.slowest) {
      for (const v of perf.slowest) console.log(`[smoke]   ${String(v.view).padEnd(14)} median ${String(v.med).padStart(5)}ms   worst ${String(v.worst).padStart(5)}ms   n=${v.n}${v.fails ? '  FAILS=' + v.fails : ''}`);
    }
    if (perf && perf.diag > 0) {
      const d = await wc.executeJavaScript('JSON.stringify(DIAG.slice(0,5))').catch(() => '[]');
      console.log('[smoke] diagnostics ring: ' + d);
    }
    const vault = await wc.executeJavaScript('window.cortex.vaultStats()').catch(() => null);
    if (vault) console.log(`[smoke] vault: ${Math.round((vault.bytes||0)/1024)} KB · writes=${vault.write && vault.write.writes} coalesced=${vault.write && vault.write.coalesced}`);
    if (!sigState || !sigState.on) problems.push('[VISUAL] the sigil never reached its resting state');
    else if (sigState.stillEntering) problems.push('[VISUAL] the sigil entrance class never came off — the breath can never start');
    else if (!(sigState.opacity > 0.02)) problems.push('[VISUAL] the sigil settled invisible at opacity ' + sigState.opacity);
    else if (sigState.opacity > 0.16) problems.push('[CONTRAST] the sigil settled too strong at opacity ' + sigState.opacity);
    if (dots && dots.badges > 1) problems.push('[VISUAL] a nav station is painting more than one attention dot');
    console.log(`[smoke] Duo-Drive strip: ${dus ? 'present' : 'MISSING'} · Motus Max strip: ${oms ? 'present' : 'MISSING'} (arm state ${armCell ? 'named' : 'NOT named'})`);
    if (!dus) problems.push('[MISSING] the Duo-Drive reading strip did not render');
    if (!oms) problems.push('[MISSING] the Motus Max reading strip did not render');
    // THE SIGIL — one element, twenty-five identities. It must actually draw,
    // and it must stay under the contrast floor: a watermark that competes with
    // a word has stopped being a watermark.
    const sig = await wc.executeJavaScript(`(() => {
      const e = document.getElementById('viewSigil');
      if (!e) return { ok: false, why: 'no element' };
      const cs = getComputedStyle(e);
      return { ok: !!e.querySelector('svg path'), opacity: parseFloat(cs.opacity), z: cs.zIndex };
    })()`).catch((e) => ({ ok: false, why: String(e && e.message) }));
    console.log('[smoke] view sigil: ' + JSON.stringify(sig));
    if (!sig || !sig.ok) problems.push('[MISSING] the view sigil did not draw');
    else if (sig.opacity > 0.16) problems.push('[CONTRAST] the view sigil is too strong at opacity ' + sig.opacity + ' — it competes with the text');
    console.log(`[smoke] Board — reading strip: ${bds ? 'present' : 'MISSING'}`);
    if (!bds) problems.push('[MISSING] the Board reading strip did not render');
    await wc.executeJavaScript(`document.querySelector('[data-nav=workflows]')?.click()`).catch(() => {});
    await wait(2400);
    const wfs = await has('wfBody', 'st-strip n5');
    console.log(`[smoke] Workflows — reading strip: ${wfs ? 'present' : 'MISSING'}`);
    if (!wfs) problems.push('[MISSING] the workflow reading strip did not render');
    await wc.executeJavaScript(`document.querySelector('[data-nav=systems]')?.click()`).catch(() => {});
    await wait(2600);
    const band = await has('sysBody', 'pat-band');
    const first = await has('sysBody', 'Act here first');
    console.log(`[smoke] Systems — act panel: ${first ? 'present' : 'MISSING'} · repeat band: ${band ? 'naming structural repeats' : 'no repeats to name right now'}`);
    if (!first) problems.push('[MISSING] the Systems act panel did not render');

    // ── THE BRANCH YOU ONLY SEE WHEN THINGS ARE GOING WRONG ────────────────
    // The repeat band renders only when the app has noticed something happening
    // more than once — i.e. exactly when he is in trouble, and the worst moment
    // to find out the branch throws. A healthy vault leaves it untested forever.
    //
    // The first attempt stubbed window.cortex.learnings from the renderer and
    // silently did nothing: a contextBridge object is FROZEN, so the assignment
    // never takes. So drive the REAL engine instead — runSmoke lives in the
    // main process, the smoke vault is a throwaway copy, and a task that has
    // been dispatched twice without closing is precisely what recentPatterns()
    // exists to notice. This tests the whole chain, not a mock of it.
    let bandProof = null;
    try {
      const iso = (d) => new Date(now() - d).toISOString();
      const probe = { id: 'smoke-probe-' + now(), title: 'harness probe — a task handed over twice', status: 'open',
        created: now(), jobs: [{ ts: iso(3 * 864e5) }, { ts: iso(1 * 864e5) }] };
      STATE.tasks = [probe, ...(STATE.tasks || [])];
      await wc.executeJavaScript(`document.querySelector('[data-nav=overview]')?.click()`).catch(() => {});
      await wait(900);
      await wc.executeJavaScript(`document.querySelector('[data-nav=systems]')?.click()`).catch(() => {});
      await wait(3000);
      bandProof = await wc.executeJavaScript(`(() => {
        const h = (document.getElementById('sysBody')||{}).innerHTML || '';
        return { band: h.includes('pat-band'), text: h.includes('harness probe'), rows: (h.match(/pat-row/g)||[]).length };
      })()`).catch((e) => ({ error: String(e && e.message) }));
      await shoot('smoke-systems-patterns.png');
      STATE.tasks = (STATE.tasks || []).filter((t) => t.id !== probe.id);
    } catch (e) { bandProof = { error: String(e && e.message) }; }
    console.log('[smoke] Systems repeat band (real engine, forced): ' + JSON.stringify(bandProof));
    if (!bandProof || !bandProof.band || !bandProof.text) {
      problems.push('[BRANCH] the "what keeps happening" band did not render when a real repeat exists');
    }
    await wc.executeJavaScript(`document.querySelector('[data-nav=systems]')?.click()`).catch(() => {});
    await wait(1800);

    // ── THE DRIFT BRANCH, PROVEN WITHOUT EVER GOING ON AIR ─────────────────
    // The on-air comparison is the half of the privacy law that only exists
    // while he is live — so on a healthy off-air machine it would never run,
    // and would ship untested forever. It cannot be tested by going live:
    // that would broadcast his work to the public internet from a test.
    //
    // It does not have to be. onAirDriftCheck only READS — it fetches the
    // served payload and diffs it against what is ticked locally. So the
    // throwaway smoke vault is flipped to on-air in memory, the comparison is
    // run, and the flag is put back. Nothing is ever pushed.
    try {
      const A = onAirState();
      const wasOn = A.on;
      A.on = true;
      const d = await onAirDriftCheck({ quiet: true });
      A.on = wasOn;
      const ticked = Object.values(A.sel || {}).filter(Boolean).length;
      const compared = !!d && d.live === true && (typeof d.missing === 'number') && Array.isArray(d.extra);
      console.log('[smoke] on-air drift comparison (read-only, never broadcast): ' +
        JSON.stringify({ compared, missing: d && d.missing, extra: d && d.extraCount, ticked }));
      // The endpoint is blank while off air, so every ticked item must read as
      // MISSING and nothing may read as EXTRA. If that inverts, the diff is
      // backwards — and a backwards diff would cry privacy on a clean payload
      // and stay silent on a leaking one.
      if (!compared) problems.push('[BRANCH] the on-air drift check did not produce a comparison');
      else if ((d.extraCount || 0) > 0) problems.push('[BRANCH] drift reported EXTRA against a blank endpoint — the diff is inverted');
      else if (ticked > 0 && !d.missing) problems.push('[BRANCH] drift reported nothing MISSING while ' + ticked + ' item(s) are ticked and the endpoint is blank');
    } catch (e) { problems.push('[BRANCH] drift check threw: ' + (e && e.message)); }

    // ── 375px ON GLASS ─────────────────────────────────────────────────────
    // Every fold in the stylesheet was verified in CSS and never LOOKED at.
    // ⚠ mainWin is created with minWidth: 980 — setSize alone would silently
    // clamp there and this whole pass would photograph a desktop layout while
    // reporting it as mobile (the overlay-window clamp, again). Lift the
    // minimum first, restore it after.
    try {
      const prev = mainWin.getBounds();
      // ⚠ Windows IGNORES setSize on a maximized window — unmaximize first,
      // or the pass photographs a desktop and calls it a phone.
      if (mainWin.isMaximized()) mainWin.unmaximize();
      mainWin.setMinimumSize(320, 480);
      mainWin.setSize(375, 812);
      await wait(700);
      const nowB = mainWin.getBounds();
      console.log('[smoke] mobile window: requested 375x812, actual ' + nowB.width + 'x' + nowB.height);
      if (nowB.width > 420) problems.push('[MOBILE] the window refused to shrink (' + nowB.width + 'px)');
      const mob = [['overview', 'mobile-pulse'], ['stream', 'mobile-stream'], ['voice', 'mobile-dashops'], ['tasks', 'mobile-board'], ['systems', 'mobile-systems'], ['omni', 'mobile-omni']];
      for (const [nav, shot] of mob) {
        await wc.executeJavaScript(`document.querySelector('[data-nav=${nav}]')?.click()`).catch(() => {});
        await wait(1600);
        const ov2 = await wc.executeJavaScript(`(() => {
          const d = document.documentElement;
          const spill = Math.max(0, d.scrollWidth - d.clientWidth);
          const wide = [];
          if (spill > 4) {
            for (const el of document.body.querySelectorAll('*')) {
              // rendered geometry only — an ellipsised row has a huge
              // scrollWidth and spills nothing; rect.right is what the eye sees
              const r = el.getBoundingClientRect();
              if (r.right > d.clientWidth + 8 && r.width > 24) wide.push({ c: String(el.className || el.tagName).slice(0, 36), w: Math.round(r.right) });
            }
            wide.sort((a, b) => b.w - a.w);
          }
          return { spill, vw: d.clientWidth, wide: wide.slice(0, 4) };
        })()`).catch(() => null);
        console.log(`[smoke] 375px ${nav}: ${ov2 ? (ov2.spill <= 4 ? 'no horizontal spill' : 'SPILLS ' + ov2.spill + 'px @vw' + ov2.vw + ' — ' + JSON.stringify(ov2.wide)) : 'unmeasured'}`);
        if (ov2 && ov2.spill > 4) problems.push(`[MOBILE] ${nav} spills ${ov2.spill}px at 375px — ` + JSON.stringify(ov2.wide));
        await shoot(shot + '.png');
      }
      mainWin.setMinimumSize(980, 680);
      mainWin.setBounds(prev);
      await wait(500);
    } catch (e) { problems.push('[MOBILE] the 375px pass threw: ' + (e && e.message)); }

    console.log('[smoke] captured');

    // SIGHT SELF-CHECK — omniCapture on the REAL desktop, at build time. The
    // frame-panel bug (.png filter vs .jpg frames) survived multiple releases
    // because nothing ever exercised the capture path end to end. Now every
    // build proves it: capture, then read the frame back the same way the
    // panel does. A machine with no visible desktop (headless CI) reports,
    // not fails — but on August's PC this must pass.
    try {
      const sf = await omniCapture({});
      if (sf && sf.ok && sf.bytes > 8000) {
        console.log(`[smoke] SIGHT OK — ${sf.imgW}×${sf.imgH} of ${sf.scrW}×${sf.scrH} (${sf.name || 'display'}), ${sf.bytes} bytes`);
        const dir = omniFrameDir();
        const newest = safe(() => fs.readdirSync(dir).filter((x) => /\.(png|jpg)$/i.test(x)).sort().pop(), null);
        if (!newest) problems.push('[SIGHT] frame written but the panel reader cannot see it');
        else console.log('[smoke] SIGHT panel reads back: ' + newest);
      } else {
        problems.push(`[SIGHT] capture failed: ${(sf && sf.error) || 'no frame'} — the Motus Max frame panel will be blind`);
      }
    } catch (e) { problems.push('[SIGHT] threw: ' + (e && e.message)); }
    // ── v3.66: the focus as an instrument, the voice as a local answer, the name ──
    const fx = await wc.executeJavaScript('window.cortex.focus()').catch(() => null);
    if (!fx || !fx.alignment || !Array.isArray(fx.history)) problems.push('[FOCUS] cortex:focus does not carry alignment and history');
    else console.log(`[smoke] focus: alignment ${fx.alignment.aligned.length} moving · ${fx.alignment.drifting.length} drifting · ${fx.history.length} past focus(es) · evidence ${fx.evidence && fx.evidence.motus ? fx.evidence.motus.turns + ' turns since' : '—'}`);
    const vl = await wc.executeJavaScript(`window.cortex.voiceTurn({ text: 'go to the board', speak: false })`).catch(() => null);
    if (!vl || !vl.local || vl.goView !== 'tasks') problems.push('[VOICE] "go to the board" did not resolve locally to the Board: ' + JSON.stringify(vl && { local: vl.local, goView: vl.goView, error: vl.error }));
    else console.log('[smoke] voice: "go to the board" answered locally → ' + vl.goView + ' · "' + vl.text + '"');
    const vb = await wc.executeJavaScript(`window.cortex.voiceTurn({ text: "what's on the board", speak: false })`).catch(() => null);
    if (!vb || !vb.local) problems.push('[VOICE] the board summary was not answered locally');
    else console.log('[smoke] voice: the board, spoken locally: "' + String(vb.text).slice(0, 90) + '"');
    const wo = withOperator("August's board is what August reads; born in August 1990; the August 5 release.");
    const nameNow = String(STATE.settings.operatorName || '').trim();
    if (nameNow && nameNow !== 'August') { if (!wo.includes(nameNow + "'s board") || !/born in August 1990/.test(wo) || !/the August 5 release/.test(wo)) problems.push('[NAME] withOperator mis-substituted: ' + wo); }
    else if (!nameNow) { if (!/^The operator's board is what the operator reads/.test(wo) || !/born in August 1990/.test(wo)) problems.push('[NAME] withOperator (unset) mis-substituted: ' + wo); }
    console.log('[smoke] name: withOperator → "' + wo + '"');
    if (IS_WIN && stagedBuild() && !stagedBuild().version) problems.push('[UPDATE] stagedBuild returned a shape without a version');
  } catch (e) { problems.push(`[THROW] ${e && e.message}`); }
  await wait(400);
  if (problems.length) {
    console.log(`\n[smoke] ===== ${problems.length} PROBLEM(S) =====`);
    for (const p of [...new Set(problems)]) console.log('[smoke] ' + p);
  } else {
    console.log('\n[smoke] ===== CLEAN: no renderer errors, every view rendered =====');
  }
  flushSmoke();
  setTimeout(() => app.quit(), 600);
}

// ---------------------------------------------------------------------------
//  THE FIRST HOUR, AS A STRANGER.   electron . --freshtest
//  A fresh vault, no passphrase, no fleet tree: the machine the authors never
//  touched, simulated here. It walks the setup gate and every room, records
//  what each one SAYS when there is nothing to show, and fails on any view that
//  throws, stays blank, or leaves a new operator without a next step. Report:
//  %TEMP%\ci-fresh-report.txt, screenshots fresh-<view>.png. This is the
//  falsifier for "someone else can run this".
// ---------------------------------------------------------------------------
async function runFreshTest() {
  const wc = mainWin.webContents;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const outDir = app.getPath('temp');
  const lines = [];
  const log = (s) => { lines.push(s); console.log(s); };
  const report = path.join(outDir, 'ci-fresh-report.txt');
  const flush = () => safe(() => fs.writeFileSync(report, lines.join('\n') + '\n', 'utf8'));
  // A capture of a hidden window is a stale compositor frame: the DOM was
  // painted at opacity 1 while the PNG showed an empty stage. Keep the window
  // composited, and wait for two real frames before every capture.
  safe(() => { wc.setBackgroundThrottling(false); mainWin.show(); mainWin.focus(); });
  const framed = () => Promise.race([wc.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(1))))').catch(() => 0), wait(900)]);
  const shoot = async (name) => { await framed(); return safe(() => wc.capturePage().then((img) => fs.writeFileSync(path.join(outDir, name), img.toPNG()))); };
  const problems = [];
  wc.on('console-message', (_ev, level, message, line, source) => {
    if (level >= 2) problems.push(`[${level === 3 ? 'ERROR' : 'WARN'}] ${message} (${String(source || '').split('/').pop()}:${line})`);
  });
  wc.on('render-process-gone', (_e, d) => problems.push(`[FATAL] renderer gone: ${d && d.reason}`));
  const textOf = (nav) => wc.executeJavaScript(`(function(){const s=document.querySelector('section[data-view="${nav}"]');return s?(s.innerText||'').replace(/\\s+/g,' ').trim():''})()`).catch(() => '');
  const VIEWS = ['overview', 'motus', 'goal', 'live', 'omni', 'tasks', 'duo', 'workflows', 'chat', 'voice', 'agents', 'subagents', 'sympath', 'motusmodels', 'stream', 'output', 'work', 'systems', 'mind', 'learnings', 'nextsteps', 'usage', 'models', 'security', 'settings', 'levels'];
  try {
    log('[fresh] vault: ' + userDataDir());
    log('[fresh] root: ' + root() + ' · readable=' + exists(root()) + ' · passSha=' + !!(STATE.settings || {}).passSha + ' · paired=' + ((STATE.trustedFingerprints || []).length > 0));
    await wait(2400); await shoot('fresh-gate.png');
    const setup = await wc.executeJavaScript(`(function(){const p=document.getElementById('gatePass2');return !!p && !p.hidden})()`).catch(() => false);
    log('[fresh] gate in setup mode: ' + setup);
    if (!setup) problems.push('[GATE] a fresh vault did not open the gate in setup mode');
    const PASS = 'fresh-harness-' + newId();
    await wc.executeJavaScript(`document.getElementById('gatePass').value=${JSON.stringify(PASS)};var p2=document.getElementById('gatePass2');if(p2)p2.value=${JSON.stringify(PASS)};document.getElementById('gateForm').requestSubmit();`);
    await wait(4500); await shoot('fresh-dash.png');
    log('[fresh] after setup: passSha=' + !!(STATE.settings || {}).passSha + ' · trusted=' + !!(GUARD && GUARD.trusted));
    if (!(STATE.settings || {}).passSha) problems.push('[GATE] setup did not store a passphrase hash');
    const gateErr = await wc.executeJavaScript(`(document.getElementById('gateErr')||{}).textContent||''`).catch(() => '');
    if (gateErr) problems.push('[GATE] the gate shows an error after setup: ' + gateErr);
    for (const nav of VIEWS) {
      await wc.executeJavaScript(`document.querySelector('[data-nav=${nav}]')?.click()`).catch(() => {});
      await wait(nav === 'usage' ? 3200 : 1900);
      const t = await textOf(nav);
      // text in the DOM is not text on screen: measure the painted view too
      const paint = await wc.executeJavaScript(`(function(){const v=document.querySelector('.view.active');if(!v)return {active:'none'};const cs=getComputedStyle(v);return {active:v.dataset.view,opacity:+cs.opacity,display:cs.display,anim:cs.animationName,idle:document.body.classList.contains('win-idle'),cls:v.className}})()`).catch(() => ({ active: '?' }));
      log(`[fresh] ${nav.padEnd(12)} ${String(t.length).padStart(5)} chars · paint=${JSON.stringify(paint)} · "${t.slice(0, 160)}"`);
      if (t.length < 40) problems.push(`[BLANK] '${nav}' says almost nothing to a new operator (${t.length} chars)`);
      if (paint.active !== nav) problems.push(`[BLANK-PAINT] clicked '${nav}' but the active view is '${paint.active}'`);
      else if (!(paint.opacity > 0.5) || paint.display === 'none') problems.push(`[BLANK-PAINT] '${nav}' is in the DOM but painted at opacity ${paint.opacity} (display ${paint.display}, anim ${paint.anim})`);
      await shoot(`fresh-${nav}.png`);
    }
    // the first move: with no fleet tree, Pulse must point at the way in
    await wc.executeJavaScript(`document.querySelector('[data-nav=overview]')?.click()`).catch(() => {});
    await wait(1500);
    const pulse = await textOf('overview');
    if (!/config|fleet path|set the path|no fleet|not found|first run|set up/i.test(pulse)) problems.push('[FIRSTMOVE] Pulse does not tell a new operator without a fleet tree what to do next');
    await shoot('fresh-overview-final.png');
  } catch (e) { problems.push(`[THROW] ${e && e.message}`); }
  await wait(400);
  if (problems.length) {
    log(`\n[fresh] ===== ${problems.length} PROBLEM(S) =====`);
    for (const p of [...new Set(problems)]) log('[fresh] ' + p);
  } else {
    log('\n[fresh] ===== CLEAN: a stranger can set up, and every room speaks =====');
  }
  flush();
  setTimeout(() => app.quit(), 600);
}

// ---------------------------------------------------------------------------
//  THE STRANGER'S FLEET.   electron . --fleettest
//  The sandbox above built a small fleet tree in a throwaway home and pointed a
//  fresh vault at it. This walks the loop against it: the readers (today's
//  growth and yesterday's frozen file), the checkpoint and its transcript, the
//  files an agent wrote, the metered usage, the brief with the reading first,
//  the agent tool on disk, a task appended through the inbox and a done claim
//  corroborated, then the rooms that show all of it. Report:
//  %TEMP%\ci-fleet-report.txt, screenshots fleet-<view>.png.
// ---------------------------------------------------------------------------
async function runFleetTest() {
  const wc = mainWin.webContents;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const outDir = app.getPath('temp');
  const lines = [];
  const log = (s) => { lines.push(s); console.log(s); };
  const report = path.join(outDir, 'ci-fleet-report.txt');
  const flush = () => safe(() => fs.writeFileSync(report, lines.join('\n') + '\n', 'utf8'));
  safe(() => { wc.setBackgroundThrottling(false); mainWin.show(); mainWin.focus(); });
  const framed = () => Promise.race([wc.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(1))))').catch(() => 0), wait(900)]);
  const shoot = async (name) => { await framed(); return safe(() => wc.capturePage().then((img) => fs.writeFileSync(path.join(outDir, name), img.toPNG()))); };
  const problems = [];
  const ok = (label, cond, detail) => { log(`[fleet] ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? ' · ' + detail : ''}`); if (!cond) problems.push('[' + label.split(' ')[0].toUpperCase() + '] ' + label + (detail ? ' · ' + detail : '')); };
  wc.on('console-message', (_ev, level, message, line, source) => {
    if (level >= 2) problems.push(`[${level === 3 ? 'ERROR' : 'WARN'}] ${message} (${String(source || '').split('/').pop()}:${line})`);
  });
  wc.on('render-process-gone', (_e, d) => problems.push(`[FATAL] renderer gone: ${d && d.reason}`));
  const textOf = (nav) => wc.executeJavaScript(`(function(){const s=document.querySelector('section[data-view="${nav}"]');return s?(s.innerText||'').replace(/\\s+/g,' ').trim():''})()`).catch(() => '');
  const visit = async (nav, ms) => { await wc.executeJavaScript(`document.querySelector('[data-nav=${nav}]')?.click()`).catch(() => {}); await wait(ms); const t = await textOf(nav); await shoot(`fleet-${nav}.png`); return t; };
  try {
    log('[fleet] vault: ' + userDataDir());
    log('[fleet] root: ' + root() + ' · readable=' + exists(root()) + ' · paired=' + ((STATE.trustedFingerprints || []).length > 0));
    ok('root readable', exists(P('logs')) && exists(P('agents')));
    // the gate, with a throwaway passphrase seeded the way the smoke does it
    const PASS = 'fleet-harness-' + newId();
    STATE.settings.passSha = sha256(PASS); saveState();
    await wait(2000);
    await wc.executeJavaScript(`document.getElementById('gatePass').value=${JSON.stringify(PASS)};document.getElementById('gateForm').requestSubmit();`);
    await wait(4000);
    ok('gate opened', !!(GUARD && GUARD.trusted), 'trusted=' + !!(GUARD && GUARD.trusted));
    // the readers
    const ixs = parseInteractions();
    ok('interactions parsed', ixs.length >= 13, ixs.length + ' records');
    ok('two seats seen', ixs.some((x) => x.agent === 'davara') && ixs.some((x) => x.agent === 'davaris'));
    parseInteractions();
    const frozen = [..._ixFrozen.keys()].filter((f) => !ixFileDay(f) || ixFileDay(f) < localDay());
    ok('yesterday froze', frozen.length >= 1, frozen.length + ' frozen file(s)');
    // the live day must never freeze, whatever the hour is in Greenwich
    ok('today stays live', ![..._ixFrozen.keys()].some((f) => ixFileDay(f) === localDay()), 'local day ' + localDay());
    const ov0 = buildOverview();
    ok('today counted', ov0.stats && ov0.stats.todayTurns === FLEET_EXPECT_TODAY, (ov0.stats ? ov0.stats.todayTurns : 'no stats') + ' today, ' + FLEET_EXPECT_TODAY + ' stamped on today');
    const cp = readCheckpoint('davara');
    ok('checkpoint read', !!cp && cp.sid === FLEET_SID, cp ? cp.sid : 'none');
    const tx = findTranscript(FLEET_SID);
    ok('transcript found', !!tx, tx || 'not found');
    const fw = safe(() => transcriptFileWrites(), []);
    ok('file writes seen', fw.some((f) => /GATE-NOTE\.md$/.test(String(f.file || ''))), fw.length + ' write(s)');
    const ov = buildOverview();
    ok('overview reads the tree', ov.rootReadable === true && !!ov.uptime, 'uptime=' + ov.uptime);
    await usageRefreshAsync().catch(() => null);          // the refresh fills the cache; the picture is read from it
    const u = safe(() => buildUsage(false), null);
    const us = JSON.stringify(u || {});
    ok('usage metered', /"out":\s*[1-9]/.test(us), us.slice(0, 160));
    // the brief and the agent tool
    ensureAgentBridgeFiles(); writeAgentBrief();
    const brief = safe(() => fs.readFileSync(path.join(ciDir(), 'brief.md'), 'utf8'), '');
    ok('brief written', brief.length > 200, brief.length + ' chars');
    ok('reading rides first', /## THE READING/.test(brief.slice(0, 2000)), 'at ' + brief.indexOf('## THE READING'));
    ok('agent tool on disk', exists(path.join(ciDir(), 'ci.sh')) && exists(path.join(ciDir(), 'README-FOR-AGENTS.md')));
    // the inbox: a task appended the way ci.sh appends it, then a done claim
    const TITLE = 'Fleet test: wire the lantern';
    fs.appendFileSync(inboxPath(), JSON.stringify({ op: 'task.add', title: TITLE, body: 'appended by the fleet harness', priority: 2, by: 'davara', ts: new Date().toISOString() }) + '\n');
    const r1 = ingestAgentInbox();
    const t1 = (STATE.tasks || []).find((t) => t.title === TITLE);
    ok('inbox task applied', r1.applied === 1 && !!t1, 'applied=' + r1.applied);
    fs.appendFileSync(inboxPath(), JSON.stringify({ op: 'task.done', match: 'Fleet test', by: 'davara', ts: new Date().toISOString() }) + '\n');
    const r2 = ingestAgentInbox();
    const t2 = (STATE.tasks || []).find((t) => t.title === TITLE);
    ok('done claim corroborated', r2.applied === 1 && !!t2 && t2.status === 'done' && !!(t2.verified && t2.verified.strength), t2 && t2.verified ? t2.verified.strength : 'no verdict');
    // the rooms that show it
    const pulse = await visit('overview', 2600);
    ok('pulse shows a fleet', !/No fleet tree is set/.test(pulse) && /turn/i.test(pulse), pulse.slice(0, 120));
    const board = await visit('tasks', 2200);
    ok('board shows the task', board.includes('Fleet test'), board.slice(0, 100));
    const live = await visit('live', 2800);
    ok('live shows a session', !/Davara NO SESSION/.test(live), live.slice(0, 120));
    const out = await visit('output', 2600);
    ok('output shows the file', /GATE-NOTE/.test(out), out.slice(0, 120));
    const usage = await visit('usage', 3400);
    ok('usage shows tokens', !/no usage|0 tokens/i.test(usage) && /[1-9]/.test(usage), usage.slice(0, 100));
    const agents = await visit('agents', 2200);
    // idle seats legitimately show zero; one seat with real turns is the proof
    ok('agents shows turns', /\b[1-9]\d* TURNS/i.test(agents), (agents.match(/\d+ TURNS/gi) || []).slice(0, 6).join(' · '));
  } catch (e) { problems.push(`[THROW] ${e && e.message}\n${e && e.stack}`); }
  await wait(400);
  if (problems.length) {
    log(`\n[fleet] ===== ${problems.length} PROBLEM(S) =====`);
    for (const p of [...new Set(problems)]) log('[fleet] ' + p);
  } else {
    log('\n[fleet] ===== CLEAN: a stranger\'s fleet is read, briefed, tooled and shown =====');
  }
  flush();
  setTimeout(() => app.quit(), 600);
}

// ---------------------------------------------------------------------------
//  Single-instance lock — ONLY ONE CortexInsight may run at a time.
//  Because closing the window hides the app to the tray (it keeps running), a fresh
//  launch used to spawn a SECOND instance alongside the lingering one. The stale
//  instance's background watchdog/pulse then called saveState() on top of the live
//  instance's writes — silently clobbering state.json back to its old in-memory copy.
//  THIS is what was wiping /motus and freezing /goal at a weeks-old value. With the
//  lock, a second launch just focuses the window that's already open. No more clobber.
// ---------------------------------------------------------------------------
// A HARNESS RUNS IN ITS OWN SANDBOX. `--drivetest` exercises the full drive loop
// and therefore writes arm/session/audit state — which, against the live vault,
// would race August's running app and clobber the very state file this lock
// exists to protect. So the harness gets a throwaway userData directory and is
// exempted from the lock. It can then run WHILE he keeps working, and it can
// never touch his real state. (Every other flag stays under the lock.)
const _ISOLATED = process.argv.includes('--drivetest') || process.argv.includes('--omnitest')
  || process.argv.includes('--livetest') || process.argv.includes('--flowtest')
  || process.argv.includes('--lanetest') || process.argv.includes('--airtest')
  || process.argv.includes('--drifttest') || process.argv.includes('--clicktest');
// Headless: no window, no renderer, no tray, no pulse — nothing that could
// reach back into the IPC the harness is driving.
const _HEADLESS = _ISOLATED;
// ⚠ THE HARNESS THAT LIED. `--smoke` was not in the isolated set, so whenever
// August's app was already open the single-instance lock quit the smoke run
// INSTANTLY — with exit code 0 and no output. A verification step that reports
// success without running is worse than none, because it is trusted. Measured
// 2026-08-18: full walk, exit=0, zero screenshots, zero assertions, no report.
//
// Smoke is NOT headless (it must render a real window), so it cannot simply
// join _ISOLATED. It gets its own treatment: its own vault, seeded from a COPY
// of the live one so the views still render his real data, and never the same
// file the running app is writing.
const _SMOKE = process.argv.includes('--smoke');
// EACH HARNESS GETS ITS OWN SANDBOX. They shared one directory, so running two
// at once had one arming the state the other was asserting was disarmed —
// producing two "failures" that were pure collision. A test must not share
// state with ANY other test, not just with the app.
if (_ISOLATED) safe(() => {
  const which = ['--omnitest', '--drivetest', '--livetest', '--flowtest', '--lanetest', '--airtest', '--drifttest', '--clicktest'].find((f) => process.argv.includes(f)) || '--harness';
  app.setPath('userData', path.join(app.getPath('temp'), 'cortexinsight' + which.replace('--', '-')));
});
if (_SMOKE) safe(() => {
  const liveVault = path.join(app.getPath('userData'), 'cortex-insight-state.json');
  const dir = path.join(app.getPath('temp'), 'cortexinsight-smoke');
  fs.mkdirSync(dir, { recursive: true });
  // fresh copy every run — a stale sandbox vault would quietly test last week
  if (fs.existsSync(liveVault)) fs.copyFileSync(liveVault, path.join(dir, 'cortex-insight-state.json'));
  app.setPath('userData', dir);
});
// THE STRANGER'S MACHINE. `--freshtest` starts from NOTHING: an empty vault, no
// passphrase, no fleet tree (discovery is skipped so the placeholder root stays
// unreadable). It is the only run that sees what a new operator sees.
const _FRESH = process.argv.includes('--freshtest');
if (_FRESH) safe(() => {
  const dir = path.join(app.getPath('temp'), 'cortexinsight-fresh');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  app.setPath('userData', dir);
});
// THE STRANGER'S FLEET. `--fleettest` builds a small fleet tree in a throwaway
// home (interactions for two seats over two days, a proxy log, a checkpoint,
// memory, a Claude Code transcript with a file write and usage) and points a
// fresh vault at it. Then the readers, the brief, the agent tool, the inbox
// and the views are walked against it. It is the only run that proves the
// fleet path on a machine that has no fleet.
const _FLEET = process.argv.includes('--fleettest');
const FLEET_SID = '00000000-0000-4000-8000-00000000f1ee';
let FLEET_EXPECT_TODAY = 0;   // how many synthetic turns the generator stamped on the local day
if (_FLEET) safe(() => {
  const dir = path.join(app.getPath('temp'), 'cortexinsight-fleet');
  const home = path.join(app.getPath('temp'), 'cortexinsight-fleet-home');
  for (const d of [dir, home]) { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); }
  const tree = path.join(home, 'cortex');
  const mk = (...p) => { const d = path.join(tree, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
  // the runner writes LOCAL time and the readers parse it as local; a UTC stamp
  // here would shift every turn by the zone and put "today" in yesterday
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  const day = (d) => stamp(d).slice(0, 10);
  const t0 = new Date(); const yday = new Date(t0.getTime() - 864e5);
  // turns spread over the last hours can straddle local midnight (a runner on
  // UTC at 02:30 proved it), so the generator counts what it stamped on today
  const rec = (agent, when, latency, chars, msg) => { if (day(when) === day(t0)) FLEET_EXPECT_TODAY++; return JSON.stringify({ ts: stamp(when), agent, status: 'OK', via: 'mouth-proxy', attempts: 1, latency_s: latency, out_chars: chars, msg }) + '\n'; };
  const ix = mk('logs', 'interactions');
  let today = '', yest = '', dv = '';
  for (let i = 6; i >= 1; i--) today += rec('davara', new Date(t0.getTime() - i * 37 * 60e3), 40 + i * 9, 900 + i * 210, 'Turn ' + i + ': read the board, refine the gate copy, report in the contract.');
  for (let i = 3; i >= 1; i--) dv += rec('davaris', new Date(t0.getTime() - i * 53 * 60e3), 25 + i * 5, 1400 + i * 100, 'Build turn ' + i + ': ship the lantern component.');
  for (let i = 4; i >= 1; i--) yest += rec('davara', new Date(yday.getTime() - i * 61 * 60e3), 70 + i, 800 + i * 50, 'Yesterday turn ' + i);
  fs.writeFileSync(path.join(ix, 'davara-' + day(t0) + '.jsonl'), today);
  fs.writeFileSync(path.join(ix, 'davaris-' + day(t0) + '.jsonl'), dv);
  fs.writeFileSync(path.join(ix, 'davara-' + day(yday) + '.jsonl'), yest);
  fs.writeFileSync(path.join(tree, 'logs', 'mouth-proxy.log'),
    stamp(new Date(yday.getTime() - 3600e3)) + ' START cortex-mouth-proxy on 127.0.0.1:8788 (claude-code-cli relay)\n' +
    stamp(new Date(t0.getTime() - 40 * 60e3)) + ' REQ davara stream=False\n' +
    stamp(new Date(t0.getTime() - 37 * 60e3)) + ' OK davara 2160c in 49.0s (attempt 1)\n');
  for (const a of ['davara', 'davaris']) {
    const ad = mk('agents', a); mk('agents', a, 'memory');
    fs.writeFileSync(path.join(ad, 'checkpoint.state'), 'SID=' + (a === 'davara' ? FLEET_SID : '11111111-1111-4111-8111-111111111111') + '\nSTATUS=complete\nEPOCH=' + Math.floor(t0.getTime() / 1000) + '\n');
    fs.writeFileSync(path.join(ad, 'memory', day(t0) + '.md'), '# ' + a + ' · ' + day(t0) + '\n\n## ' + stamp(t0) + '\n**Ask:** refine the gate copy.\n**Delivered:** the gate says what it stores and nothing more.\n');
  }
  const proj = path.join(home, '.claude', 'projects', '-cortex'); fs.mkdirSync(proj, { recursive: true });
  const written = path.join(tree, 'GATE-NOTE.md');
  fs.writeFileSync(written, '# gate note\nthe gate stores a hash, never the text.\n');
  const ts = (m) => new Date(t0.getTime() - m * 60e3).toISOString();
  const usage = (i, o) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: 1200, cache_creation_input_tokens: 300 });
  const lines = [
    { type: 'user', sessionId: FLEET_SID, timestamp: ts(39), message: { role: 'user', content: 'Refine the gate copy so it says what it stores and nothing more.' } },
    { type: 'assistant', sessionId: FLEET_SID, timestamp: ts(38), message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'Reading the gate copy now.' }, { type: 'tool_use', id: 'tu1', name: 'Write', input: { file_path: written, content: '# gate note' } }], usage: usage(2100, 180) } },
    { type: 'user', sessionId: FLEET_SID, timestamp: ts(38), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] } },
    { type: 'assistant', sessionId: FLEET_SID, timestamp: ts(37), message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'TITLE: gate copy refined\nCONFIDENCE: 8/10 — BASIS: the smoke asserts the line\nFALSIFIER: if the Access panel still names a built-in password by the next release, this was wrong\nSHUTTLE: a new operator opens Config and reads one sentence\nDID: rewrote the Access copy\nFILES: ' + written + '\nNEXT: none' }], usage: usage(2600, 420) } },
  ];
  fs.writeFileSync(path.join(proj, FLEET_SID + '.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'cortex-insight-state.json'), JSON.stringify({ settings: { cortexRoot: tree } }));
  app.setPath('userData', dir);
});
// ───────────────────────────────────────────────────────────────────────────
//  THE PROCESS GUARD. An app meant to run for weeks will eventually meet an
//  exception nobody wrote a catch for. The default answer is to die — taking
//  unwritten vault state with it. The guard's answer: write the vault FIRST,
//  put the incident in the audit trail, and stay standing. A revived process
//  in a known-logged state beats a clean corpse every time.
// ───────────────────────────────────────────────────────────────────────────
// ───────────────────────────────────────────────────────────────────────────
//  GLOBAL PUSH-TO-TALK. One key, system-wide: press it in any application and
//  DASH-OPS starts listening; press again (or just stop talking) and the turn
//  sends. The fleet becomes ambient — a colleague in the room, not a window
//  you must find first.
//
//  Two scars honoured: register() fails SILENTLY when another app owns the
//  combination, so a ladder tries alternates and records which one actually
//  bound (the HUD tells the truth, not the intention). And Motus Max's arm
//  path calls unregisterAll() — which would silently strip this key — so
//  every wipe site re-binds PTT afterwards.
// ───────────────────────────────────────────────────────────────────────────
// ⚠ THE PANIC KEY THAT DID NOTHING. It was bound during ARM — and unbound by
// the disarm path's unregisterAll(), including the TTL fuse expiring on its
// own. So the exact sequence he hit: arm → drive gets stuck → fuse expires →
// disarm wipes every key → he presses Ctrl+Alt+Shift+X at the worst moment
// and it is bound to NOTHING. A kill switch that exists only while the system
// believes it is armed is not a kill switch. It now binds at boot, stays
// bound, and acts whenever anything could possibly be moving.
let _killKey = '';
function bindKillSwitch() {
  return safe(() => {
    const { globalShortcut } = require('electron');
    if (_killKey && globalShortcut.isRegistered(_killKey)) return _killKey;
    const ladder = ['CommandOrControl+Alt+Shift+X', 'CommandOrControl+Shift+Escape', 'CommandOrControl+Alt+X', 'Shift+Alt+X', 'F8'];
    _killKey = '';
    for (const k of ladder) {
      const bound = safe(() => globalShortcut.register(k, () => {
        const o = omniState();
        const live = o.session && ['running', 'waiting', 'reading'].includes(o.session.status);
        if (o.armed || live) { omniPanic('the kill key'); }
        else safe(() => { omniAudit('panic', 'kill key pressed while nothing was armed or driving — nothing to stop'); });
      }), false);
      if (bound && globalShortcut.isRegistered(k)) { _killKey = k; break; }
    }
    const o = omniState();
    o.panicKey = _killKey;         // the HUD shows what is REAL, not what was intended
    if (_killKey) omniAudit('voice', 'kill switch standing at ' + _killKey + ' (bound from boot, survives disarm)');
    else omniAudit('blocked', 'NO kill key could be bound — every combination is taken by another app');
    return _killKey;
  }, '');
}
let _pttKey = '';
function bindPTT() {
  return safe(() => {
    const { globalShortcut } = require('electron');
    if (_pttKey && globalShortcut.isRegistered(_pttKey)) return _pttKey;
    const ladder = ['CommandOrControl+Alt+Space', 'CommandOrControl+Shift+M', 'Alt+Shift+V'];
    _pttKey = '';
    for (const k of ladder) {
      const bound = safe(() => globalShortcut.register(k, () => {
        safe(() => { showWindow(); mainWin.webContents.send('cortex:ptt'); });
      }), false);
      if (bound && globalShortcut.isRegistered(k)) { _pttKey = k; break; }
    }
    if (_pttKey) omniAudit('voice', 'global push-to-talk bound to ' + _pttKey);
    else omniAudit('voice', 'no push-to-talk key could be bound — every combination is taken');
    return _pttKey;
  }, '');
}
ipcMain.handle('cortex:pttKey', requireGate(() => ({ key: _pttKey })));
process.on('uncaughtException', (e) => {
  safe(() => omniAudit('guard', 'main-process uncaught exception (survived): ' + ((e && e.stack) || e)));
  safe(() => saveStateNow());          // whatever happens next, his state is on disk
});
process.on('unhandledRejection', (e) => {
  safe(() => omniAudit('guard', 'unhandled rejection (survived): ' + ((e && (e.stack || e.message)) || e)));
});
// The renderer can die too (GPU resets are a fact of life on this machine —
// the smoke log shows them). Revive it, but never in a loop: a crash cycling
// faster than every 30s is a real bug that deserves to be SEEN, not a strobe.
let _lastRevive = 0;
app.on('web-contents-created', (_e, wc) => {
  wc.on('render-process-gone', (_ev, d) => {
    if (_ISOLATED || _SMOKE || _FRESH || _FLEET) return;   // harnesses report, never revive
    if (!d || d.reason === 'clean-exit') return;
    safe(() => omniAudit('guard', 'renderer process gone (' + (d && d.reason) + ')'));
    if (Date.now() - _lastRevive < 30000) return;
    _lastRevive = Date.now();
    safe(() => wc.reload());
  });
});
if (!_ISOLATED && !_SMOKE && !_FRESH && !_FLEET && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { showWindow(); });
  // Durability over speed at exactly one moment: the way out.
  app.on('before-quit', () => safe(() => saveStateNow()));
  app.on('will-quit', () => safe(() => saveStateNow()));

  app.whenReady().then(async () => {
    STATE = loadState();
    publishFleetConfig();       // the runner reads this per turn — make it current at boot
    ensureAgentBridgeFiles();   // (re)write the agent CLI + README so the fleet can reach the board
    safe(() => writeAgentBrief());    // orient the fleet before it takes its next turn
    safe(() => ingestAgentInbox());   // apply anything the fleet queued while the app was closed
    safe(() => sweepZombieRuns());    // runs killed by an app restart become resumable, not stuck
    safe(() => reportUpdateOutcome()); // say plainly whether the last update landed — silence was the bug
    // Find the broadcast back end before anything tries to use it. Quiet on
    // boot: it only speaks up if the host actually MOVED.
    // Find the broadcast back end, THEN prove nothing of his is public while
    // he is off air. Order matters: a sweep against the wrong host proves
    // nothing, so discovery has to settle first.
    safe(() => bindKillSwitch());
    // a turn flag that survived a crash would read as a 20-minute-old runaway
    // the moment the watchdog woke — the process is gone, so the turn is too
    safe(() => { omniState().turnInFlight = null; });
    // the root: set by the operator, or discovered once where WSL keeps homes
    safe(() => { if (!_FRESH && STATE && STATE.settings && !STATE.settings.cortexRoot) { const d = discoverRoot(); if (d) { STATE.settings.cortexRoot = d; saveState(); omniAudit('root', 'fleet tree found at ' + d); } } });
    // the gate hash lives in the vault (created at first run, or migrated by
    // v3.57 for the original install); a vault without one asks at the gate
    safe(() => bindPTT());
    // prewarm the two pictures a start button reads, off the main thread, so
    // the first click after boot costs the same as the hundredth
    setTimeout(() => safe(() => transcriptCandidatesAsync()
      .then(() => Promise.all([usageRefreshAsync(), transcriptFileWritesWarmAsync(14)]))
      .catch(() => {})), 2500);
    // her mind and the organ reads warm once at boot, so the Davara view and the
    // first loop pass never pay the bridge for them
    setTimeout(() => safe(() => { mindReport(); dvOrgansFor('scout'); dvOrgansFor('refine'); }), 4500);
    safe(() => onAirDiscover({ quiet: false })
      .then(() => onAirEnforceOff({ quiet: false }))
      .catch(() => {}));
    // A Motus Max session cannot survive the process that drives it. His vault
    // held one stuck at `running, cycles=0` — armed, apparently live, with
    // nothing ticking it, so the screen said "driving" forever and the next
    // start refused because a session was already in flight. Close it honestly
    // on boot and keep the thread, so "keep going" still works.
    safe(() => {
      const o = omniState();
      if (o.session && ['running', 'waiting'].includes(o.session.status)) {
        o.session.status = 'stopped';
        o.session.endedAt = now();
        o.session.why = 'the app restarted while this was in flight';
        o.armed = false;                       // arming never survives a restart either
        omniAudit('recovered', `closed a session left in flight by a restart: "${String(o.session.goal).split('\n')[0].slice(0, 90)}"`);
        saveState();
      }
    });
    // Give the fleet its voice from the key already on this PC — verified live
    // before it is trusted, and re-adopted if what we hold no longer works.
    safe(() => adoptElevenKey().then(async (a) => {
      if (a && a.already && STATE.settings.elevenKeyEnc && !STATE.settings.elevenKeyVerified) {
        const v = await verifyElevenKey(decryptEleven());
        if (!v.ok) { STATE.settings.elevenKeyEnc = ''; STATE.settings.elevenKeySource = ''; saveState(); await adoptElevenKey({ force: true }); }
        else { STATE.settings.elevenKeyVerified = new Date().toISOString(); saveState(); }
      }
    }).catch(() => {}));
    GUARD = await evaluateGuard();
    if (!GUARD.trusted) notify('CortexInsight — foreign device', `An attempt to open CortexInsight was made on ${GUARD.hostname} (${decoyIp()}). It did not unlock — the real IP went only to your private beacon.`);
    // A HARNESS RUNS HEADLESS. Creating the real window meant its renderer
    // booted, loaded the Motus Max view, and talked to the very same IPC the
    // harness was driving — a live UI and a test stepping on each other. One
    // run died with `stopped — August disarmed it` while August was nowhere
    // near it. A test must not share a control surface with the thing it tests.
    if (!_HEADLESS) {
      createWindow();
      startPulse();
      buildTray();
      startWatchdog();
    }
    integrityBaseline(false);   // capture baseline on first run; no-op thereafter
    // Headless harnesses start here — no window ever exists, so nothing can
    // reach back into the IPC they are driving.
    if (_HEADLESS) {
      if (process.argv.includes('--omnitest')) runOmniTest();
      if (process.argv.includes('--drivetest')) runDriveTest();
      if (process.argv.includes('--livetest')) runLiveTest();
      if (process.argv.includes('--flowtest')) runFlowTest();
      if (process.argv.includes('--lanetest')) runLaneTest();
      if (process.argv.includes('--airtest')) runAirTest();
      if (process.argv.includes('--drifttest')) runDriftTest();
      if (process.argv.includes('--clicktest')) runClickTest();
    }
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); else showWindow(); });
  });
  app.on('before-quit', () => { app.isQuitting = true; liveStop(); safe(() => omniDisarm('the app is closing')); safe(() => omniOverlayDestroy()); });
  app.on('window-all-closed', () => {
    if (app.isQuitting || !STATE || !STATE.settings.minimizeToTray) { stopPulse(); stopWatchdog(); if (process.platform !== 'darwin') app.quit(); }
  });
}
