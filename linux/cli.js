#!/usr/bin/env node
// ============================================================================
//  cortex — the console, in a terminal.
//
//  Same engine room as the window: every command here is one of the channels
//  main.js already answers, so nothing in this file knows how the fleet works.
//  It asks, and it renders.
//
//  Two ways to use it:
//    cortex                    open the console and talk
//    cortex <something>        ask one thing and leave
//
//  Typing a sentence with no command in front of it sends it to the fleet, so
//  the shortest useful thing you can do is:  cortex "what moved today?"
// ============================================================================
'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execFile, spawn } = require('child_process');
const { open, defaultSocket } = require('./client');

// ---------------------------------------------------------------------------
//  Paint
// ---------------------------------------------------------------------------
const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (n) => (s) => (COLOR ? `[${n}m${s}[0m` : String(s));
const dim = c(2), bold = c(1);
const violet = c('38;5;141'), cyan = c('38;5;80'), gold = c('38;5;179');
const rose = c('38;5;204'), green = c('38;5;114'), grey = c('38;5;246');

const OUT = (s = '') => process.stdout.write(s + '\n');
// ⚠ This used to begin by replacing every run of whitespace with one space,
// which flattened the whole reply into a single paragraph. Lists lost their
// bullets, numbered steps ran together, and a fenced code block came out as
// prose with backticks floating in it. An agent that answers in structure and
// is rendered without it has been paraphrased by its own terminal.
//
// So: line breaks are the author's and are kept. Blank lines are kept, because
// they are what separates a thought. Each line keeps its own leading space, so
// a bullet stays under its bullet and an indented block stays indented. Only a
// line too long for the window is wrapped, and only that line.
const wrap = (s, w = Math.min((process.stdout.columns || 80) - 2, 96), indent = '') => {
  const out = [];
  for (const raw of String(s == null ? '' : s).replace(/\r/g, '').split('\n')) {
    const lead = (raw.match(/^[ \t]*/) || [''])[0].replace(/\t/g, '  ').slice(0, 10);
    const body = raw.trim();
    if (!body) { out.push(''); continue; }
    const room = Math.max(24, w - indent.length - lead.length);
    let line = '';
    for (const word of body.split(/\s+/)) {
      if (line && (line + ' ' + word).length > room) { out.push(indent + lead + line); line = word; }
      else line = line ? line + ' ' + word : word;
    }
    if (line) out.push(indent + lead + line);
  }
  // a reply that ends in blank lines should not push the prompt down the screen
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.join('\n');
};
const rule = () => OUT(dim('─'.repeat(Math.min((process.stdout.columns || 80) - 2, 72))));
const head = (t, sub) => { OUT(); OUT(bold(violet(t)) + (sub ? '  ' + dim(sub) : '')); rule(); };
const kv = (k, v) => OUT('  ' + grey(String(k).padEnd(16)) + ' ' + v);
const ago = (ms) => {
  if (!ms || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 90) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 90) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 48) return h + 'h ' + (m % 60) + 'm';
  return Math.floor(h / 24) + 'd';
};

// ---------------------------------------------------------------------------
//  Service control — systemd if it is there, a plain process if it is not.
// ---------------------------------------------------------------------------
const UNIT = 'cortexinsight.service';
// The exact thing the desktop app asks this machine to run over SSH. Kept here
// so the check below tests the real command and not a description of it.
const BRIDGE_CMD = 'command -v cortex >/dev/null 2>&1 && exec cortex rpc; exec "$HOME/.local/bin/cortex" rpc';
const APP_ROOT = path.resolve(__dirname, '..');

function sh(file, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: opts.timeout || 20000, maxBuffer: 8e6 }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || (err && err.message) || '') }));
  });
}
async function hasUnit() {
  const r = await sh('systemctl', ['--user', 'list-unit-files', UNIT, '--no-legend']);
  return r.ok && /cortexinsight/.test(r.out);
}

async function startService() {
  if (await hasUnit()) {
    const r = await sh('systemctl', ['--user', 'start', UNIT]);
    if (!r.ok) { OUT(rose('could not start the service: ') + r.err.trim()); return false; }
    OUT(green('started') + dim(' (systemd will bring it back after a reboot)'));
  } else {
    const logDir = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'cortexinsight');
    fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
    const logFile = path.join(logDir, 'cortexinsight.log');
    const fd = fs.openSync(logFile, 'a', 0o600);
    spawn(process.execPath, [path.join(__dirname, 'host.js')], { detached: true, stdio: ['ignore', fd, fd], cwd: APP_ROOT }).unref();
    OUT(green('started') + dim(' in the background — log: ' + logFile));
  }
  for (let i = 0; i < 60; i++) {
    try { const cl = await open(); cl.close(); return true; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  OUT(rose('it did not come up in 30s. Look at:  cortex logs'));
  return false;
}

async function stopService() {
  if (await hasUnit()) { await sh('systemctl', ['--user', 'stop', UNIT]); OUT(green('stopped')); return; }
  try { const cl = await open(); await cl.send({ op: 'shutdown' }); cl.close(); OUT(green('stopped')); }
  catch { OUT(dim('it was not running')); }
}

async function showLogs(follow) {
  if (await hasUnit()) {
    const args = ['--user', '-u', UNIT, '-n', '80', '--no-pager'];
    if (follow) args.push('-f');
    const p = spawn('journalctl', args, { stdio: 'inherit' });
    await new Promise((r) => p.on('close', r));
    return;
  }
  const f = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'cortexinsight', 'cortexinsight.log');
  if (!fs.existsSync(f)) return OUT(dim('no log yet at ' + f));
  const p = spawn('tail', [follow ? '-f' : '-n', follow ? '-n' : '80', ...(follow ? ['80', f] : [f])].filter(Boolean), { stdio: 'inherit' });
  await new Promise((r) => p.on('close', r));
}

// ---------------------------------------------------------------------------
//  Renderers
// ---------------------------------------------------------------------------
const seatColor = (tone) => (tone === 'violet' ? violet : tone === 'cyan' ? cyan : tone === 'gold' ? gold : grey);

async function renderStatus(cl) {
  const [g, ov, ctl] = await Promise.all([cl.invoke('guard:status'), cl.invoke('cortex:overview'), cl.invoke('cortex:control')]);
  head('CortexInsight', (await cl.hello()).version);
  kv('this machine', g.hostname + dim(' · ' + g.username) + (g.trusted ? '  ' + green('paired') : '  ' + rose('not paired')));
  if (g.needsSetup) kv('gate', gold('no passphrase yet — run:  cortex setup'));
  kv('fleet tree', ov.rootReadable ? green('readable') : rose('not readable — run:  cortex tree'));
  kv('relay', ov.proxyStart ? green('up') + dim(' · ' + ago(Date.now() - ov.proxyStart)) : rose('down') + dim('  start it:  cortex relay start'));
  kv('health', (ov.health.level === 'nominal' ? green : ov.health.level === 'watch' ? gold : rose)(ov.health.level) + dim(' · ' + ov.health.score + '/100' + (ov.health.faults ? ' · ' + ov.health.faults + ' fault(s)' : '')));
  kv('turns', bold(String(ov.stats.totalTurns)) + dim(' total · ') + bold(String(ov.stats.todayTurns)) + dim(' today'));
  kv('model', ov.model + (ov.modelPerAgent ? dim(' · per seat') : ''));
  kv('agents', ctl.stopped ? (ctl.hard ? rose('OFF — hard stop, the runner refuses every turn') : gold('OFF — this console drives nothing')) : green('on'));
  if (ov.working && ov.working.length) kv('working now', ov.working.map((w) => w.name || w.agent).join(', '));
  OUT();
}

async function renderPulse(cl) {
  const [r, ov] = await Promise.all([cl.invoke('cortex:reading'), cl.invoke('cortex:overview')]);
  head('Pulse', 'the reading');
  OUT(wrap(bold(r.line), undefined, '  '));
  if (r.more) OUT(wrap(dim(r.more), undefined, '  '));
  OUT();
  const ring = r.ring || [];
  if (ring.length === 24) {
    const max = Math.max(1, ...ring);
    const blocks = '▁▂▃▄▅▆▇█';
    OUT('  ' + ring.map((v) => {
      const ch = blocks[Math.min(blocks.length - 1, Math.floor((v / max) * (blocks.length - 1)))];
      return v === max ? gold(ch) : violet(ch);
    }).join(''));
    OUT('  ' + dim('00              06              12              18            23'));
    if (r.peak) OUT('  ' + dim(`peak ${String(r.peak.start).padStart(2, '0')}:00–${String(r.peak.end).padStart(2, '0')}:00 · ${Math.round(r.peak.share * 100)}% of turns`));
  }
  OUT();
  kv('open tasks', String(ov.openTasks));
  kv('learnings', String(ov.learnCount));
  kv('clean rate', Math.round((ov.stats.cleanRate || 0) * 100) + '%');
  kv('answers in', ov.avgLatency ? Math.round(ov.avgLatency) + 's' : '—');
  if (ov.lastTurn) kv('last turn', ov.lastTurn.agent + dim(' · ' + ov.lastTurn.ts + ' · ' + ov.lastTurn.status));
  OUT();
}

async function renderBoard(cl, lane) {
  const b = await cl.invoke('cortex:board');
  head('The board', `${b.counts.inbox} inbox · ${b.counts.active} active · ${b.counts.waiting} waiting · ${b.counts.done} done`);
  const lanes = lane ? [lane] : ['active', 'waiting', 'inbox'];
  for (const L of lanes) {
    const xs = (b.tasks || []).filter((t) => t.status === L);
    if (!xs.length) continue;
    OUT('  ' + bold(L.toUpperCase()) + dim(`  (${xs.length})`));
    for (const t of xs.slice(0, 12)) {
      const pri = t.priority === 1 ? rose('!') : t.priority === 2 ? gold('·') : ' ';
      OUT('   ' + pri + ' ' + dim(String(t.id).slice(0, 6)) + '  ' + wrap(t.title, 70, '').split('\n')[0]
        + (t.agent ? dim('  → ' + t.agent) : ''));
    }
    if (xs.length > 12) OUT(dim(`     …and ${xs.length - 12} more`));
    OUT();
  }
  if (!(b.tasks || []).length) OUT(dim('  nothing on the board yet. Add one:  cortex task "the thing to do"') + '\n');
  if (b.counts.active > b.wipLimit) OUT('  ' + gold(`over the limit: ${b.counts.active} active, the limit is ${b.wipLimit}`) + '\n');
  if ((b.close || []).length) {
    OUT('  ' + bold('THE CLOSE') + dim('  decisions waiting on you'));
    for (const x of b.close.slice(0, 5)) OUT('   · ' + wrap(x.title, 66, '').split('\n')[0] + dim('  — ' + (x.why || '')));
    OUT();
  }
}

async function renderFocus(cl) {
  const f = await cl.invoke('cortex:focus');
  head('The focus', 'what everything is weighed against');
  OUT('  ' + gold('◎ GOAL  ') + (f.goal ? wrap(f.goal.text, 66, '').replace(/\n/g, '\n          ') : dim('not set — cortex goal "…"')));
  OUT();
  OUT('  ' + violet('◆ MOTUS ') + (f.motus ? wrap(f.motus.text, 66, '').replace(/\n/g, '\n          ') : dim('not set — cortex motus "…"')));
  OUT();
  const a = f.alignment;
  if (a && a.set) {
    OUT('  ' + bold(`${Math.round(a.pct * 100)}%`) + dim(` of the board orbits the Motus  ·  `)
      + violet(a.aligned.length + ' moving') + dim(' · ') + grey(a.partial.length + ' near') + dim(' · ') + rose(a.drifting.length + ' drifting'));
    if (a.drifting.length) {
      OUT();
      OUT('  ' + dim('drifting for a week or more:'));
      for (const t of a.drifting.slice(0, 5)) OUT('   ' + rose('◇') + ' ' + wrap(t.title, 66, '').split('\n')[0]);
    }
  }
  const ev = f.evidence && (f.evidence.motus || f.evidence.goal);
  if (ev) { OUT(); kv('since it was named', `${ev.turns || 0} turns · ${ev.closed || 0} closed · ${ev.learned || 0} learned`); }
  OUT();
}

async function renderAgents(cl) {
  const xs = await cl.invoke('cortex:agents');
  head('The fleet', xs.length + ' seats');
  for (const a of xs) {
    const paint = seatColor(a.tone);
    const state = a.hard ? rose('hard-paused') : a.paused ? gold('paused') : a.status === 'working' ? green('working') : dim(a.status);
    OUT('  ' + paint(bold(a.name.padEnd(16))) + dim((a.model || '').padEnd(18)) + dim((a.effort || '').padEnd(7)) + state);
    if (a.lastFocus) OUT('    ' + dim(wrap(a.lastFocus, 70, '').split('\n')[0]));
  }
  OUT();
  OUT(dim('  pause one:  cortex pause davaris     ·  all off:  cortex off'));
  OUT();
}

async function renderMind(cl, what) {
  const m = await cl.invoke('cortex:mind');
  if (!m.available) { OUT(dim('  her baseline is not on this machine, so there is nothing to read.')); return; }
  if (what === 'commands') {
    head('Her commands', m.commands.length + ' on disk');
    for (const x of m.commands) {
      OUT('  ' + cyan(x.name));
      if (x.what) OUT(wrap(dim(String(x.what).replace(/^[-\s]+/, '')), undefined, '      '));
    }
    OUT();
    OUT(dim('  run one:  cortex "' + (m.commands[0] || {}).name + '"'));
    OUT();
    return;
  }
  if (what === 'protocols' || what === 'abilities') {
    head('Her protocols', m.abilities.length + ' she can invoke');
    for (const x of m.abilities) {
      OUT('  ' + violet(x.name));
      if (x.when) OUT(wrap(dim('when: ' + x.when), undefined, '      '));
    }
    OUT();
    OUT(dim('  ask through one:  cortex ask "<subject>" --through "' + (m.abilities[0] || {}).name + '"'));
    OUT();
    return;
  }
  head('Davara', m.version);
  kv('baseline', m.dir);
  kv('organs', `${m.organs.protocols} protocols · ${m.organs.skills} skills · ${m.organs.library} library · ${m.organs.stack} layers`);
  kv('commands', String(m.commands.length));
  kv('covenant', m.covenant && m.covenant.present ? green('present') : dim('absent'));
  if (m.meanQuality) kv('recent quality', m.meanQuality + '/10' + dim(' over ' + m.qualityN + ' passes'));
  OUT();
  OUT(dim('  cortex commands    her command library'));
  OUT(dim('  cortex protocols   what she can invoke'));
  OUT(dim('  cortex ask "…"     ask her through one protocol'));
  OUT();
}

async function renderLoops(cl) {
  const r = await cl.invoke('cortex:loops');
  const loops = r.loops || [];
  head('Loops', `${loops.filter((l) => l.enabled && l.approved).length} armed of ${loops.length}`);
  for (const l of loops) {
    const state = !l.approved ? gold('waiting for you') : l.enabled ? green('armed') : dim('off');
    OUT('  ' + bold(String(l.name).padEnd(24)) + dim(String(l.kind).padEnd(10)) + dim(`every ${l.cadenceMin}m`.padEnd(12)) + state);
  }
  OUT();
}

// ---------------------------------------------------------------------------
//  Talking to the fleet
// ---------------------------------------------------------------------------
async function sendTo(cl, agent, text, { quiet } = {}) {
  if (!String(text || '').trim()) return;
  const t0 = Date.now();
  let spin = null;
  if (!quiet && process.stdout.isTTY) {
    const frames = ['◜', '◠', '◝', '◞', '◡', '◟'];
    let i = 0;
    spin = setInterval(() => {
      process.stdout.write('\r' + violet(frames[i++ % frames.length]) + dim(` ${agent} is thinking… ${Math.round((Date.now() - t0) / 1000)}s`) + '   ');
    }, 120);
  }
  let r;
  try { r = await cl.invoke('cortex:send', { agent, text }); }
  finally { if (spin) { clearInterval(spin); process.stdout.write('\r' + ' '.repeat(60) + '\r'); } }
  if (r && r.error) { OUT(rose('  ' + r.error)); return r; }
  const body = (r && r.text) || '';
  OUT();
  OUT(seatColor('violet')(bold(agent)) + dim(`  ${Math.round((r.latency || (Date.now() - t0) / 1000))}s`));
  OUT(wrap(body, undefined, '  '));
  OUT();
  return r;
}

// ---------------------------------------------------------------------------
//  The live feed
// ---------------------------------------------------------------------------
async function live(cl) {
  OUT(dim('live — every event the console would have drawn. Ctrl-C to leave.'));
  rule();
  cl.onPush = (evt) => {
    const t = new Date().toTimeString().slice(0, 8);
    const ch = String(evt.channel || '').replace(/^cortex:/, '');
    const p = evt.payload || {};
    let line = '';
    if (ch === 'notify') line = gold(p.title || '') + ' ' + dim(p.body || '');
    else if (ch === 'sendProgress') line = dim(`${p.phase} · ${p.agent || ''}`);
    else if (ch === 'liveEvent') line = dim(`${p.agent || ''} · ${(p.events || []).length} event(s)${p.inflight ? ' · working' : ''}`);
    else if (ch === 'duoPass') line = violet('duo pass ') + dim(((p.entry || {}).title) || '');
    else if (ch === 'inboxApplied') line = cyan(`agent queue · ${p.applied} applied`);
    else if (ch === 'pulse') return;                       // every beat; too noisy to print
    else line = dim(ch + ' ' + JSON.stringify(p).slice(0, 120));
    OUT(grey(t) + ' ' + line);
  };
  await cl.subscribe(0);
  await new Promise(() => {});
}

// ---------------------------------------------------------------------------
//  The REPL
// ---------------------------------------------------------------------------
const HELP = `
  ${bold('Talking')}
    just type a sentence           send it to the seat you are on
    @davaris <text>                send it to another seat, once
    /reading  /leverage  /help     the console's own commands, as in the app
    ${dim('(anything starting with / is handled by the fleet, not by this terminal)')}

  ${bold('Looking')}
    status      board      pulse       focus
    agents      loops      mind        commands     protocols
    live                               ${dim('stream what the console sees')}

  ${bold('Moving')}
    task <title>                   put something on the board
    done <id>                      close it
    motus <text>  ·  goal <text>   name what everything is weighed against
    ask <subject>                  ask her through one protocol

  ${bold('Control')}
    off  ·  on                     stop / resume every agent (spends nothing when off)
    seat <name>                    change the seat you are talking to
    quit
`;

async function repl(cl) {
  const hello = await cl.hello();
  const [g, ctl] = await Promise.all([cl.invoke('guard:status'), cl.invoke('cortex:control')]);
  const s = await cl.invoke('cortex:settings');
  let seat = (s.settings && s.settings.defaultAgent) || 'davara';

  OUT();
  OUT('  ' + bold(violet('CortexInsight')) + dim('  ' + hello.version + ' · ' + g.hostname));
  OUT('  ' + dim('type ') + bold('help') + dim(' for what this can do, or just say something.'));
  if (g.needsSetup) OUT('  ' + gold('this vault has no passphrase yet — run: cortex setup'));
  if (ctl.stopped) OUT('  ' + gold('the agents are OFF. Turn them back on with: on'));
  OUT();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, historySize: 200 });
  const prompt = () => rl.setPrompt(violet('◆ ') + dim(seat) + grey(' › '));
  prompt(); rl.prompt();

  // Commands are handled one at a time. Readline hands lines over as fast as
  // they arrive, which is invisible when a person is typing and very visible
  // when the input is a pipe or a file: half the answers used to be cut off by
  // the exit. Each line now waits for the one before it, and closing waits for
  // whatever is still in flight.
  let chain = Promise.resolve();
  const runLine = (raw) => { chain = chain.then(() => handleLine(raw)).catch(() => {}); return chain; };

  rl.on('line', (raw) => { rl.pause(); runLine(raw).then(() => { rl.resume(); rl.prompt(); }); });

  async function handleLine(raw) {
    // ⚠ Inside the console you are already in cortex, but typing "cortex help"
    // is the most natural thing in the world and it used to be SENT to an agent
    // as a question. She read the source and explained the help text back, which
    // took forty-two seconds and one real turn to tell him something this
    // process already knew. Anything addressed to cortex is meant for cortex.
    const line = raw.trim().replace(/^cortex\s+/i, '');
    if (!line) { rl.prompt(); return; }
    const [cmd, ...rest] = line.split(' ');
    const arg = rest.join(' ').trim();
    try {
      switch (cmd.toLowerCase()) {
        case 'help': case '?': OUT(HELP); break;
        case 'quit': case 'exit': rl.close(); return;
        case 'clear': console.clear(); break;
        case 'status': await renderStatus(cl); break;
        case 'pulse': await renderPulse(cl); break;
        case 'board': await renderBoard(cl, arg || null); break;
        case 'focus': await renderFocus(cl); break;
        case 'agents': case 'fleet': await renderAgents(cl); break;
        case 'loops': await renderLoops(cl); break;
        case 'mind': case 'davara': await renderMind(cl); break;
        case 'commands': await renderMind(cl, 'commands'); break;
        case 'protocols': case 'abilities': await renderMind(cl, 'protocols'); break;
        case 'seat':
          if (!arg) OUT(dim('  on: ' + seat));
          else { seat = arg; prompt(); OUT(dim('  now talking to ' + seat)); }
          break;
        case 'off': await agentsOff(cl, rest.includes('--hard')); break;
        case 'on': await agentsOn(cl); break;
        case 'task': {
          const r = await cl.invoke('cortex:taskCreate', { title: arg });
          OUT(r && r.ok === false ? rose('  ' + r.error) : green('  on the board'));
          break;
        }
        case 'done': {
          const r = await cl.invoke('cortex:taskUpdate', { id: arg, patch: { status: 'done' } });
          OUT(r && r.ok === false ? rose('  ' + r.error) : green('  closed'));
          break;
        }
        case 'motus': case 'goal': {
          if (!arg) { await renderFocus(cl); break; }
          const r = await cl.invoke('cortex:send', { agent: seat, kind: cmd.toLowerCase(), text: arg });
          OUT(r && r.error ? rose('  ' + r.error) : green('  set'));
          break;
        }
        case 'ask': {
          const r = await cl.invoke('cortex:send', { agent: 'davara', text: arg });
          OUT(wrap((r && r.text) || '', undefined, '  '));
          break;
        }
        case 'live': {
          OUT(dim('  live feed — press Ctrl-C to come back'));
          await live(cl);
          break;
        }
        default:
          if (cmd.startsWith('@')) await sendTo(cl, cmd.slice(1), arg);
          else await sendTo(cl, seat, line);
      }
    } catch (e) {
      OUT(rose('  ' + (e && e.message)));
    }
  }

  rl.on('close', async () => {
    await chain.catch(() => {});
    OUT(dim('\n  keep moving.\n'));
    process.exit(0);
  });
}

async function agentsOff(cl, hard) {
  const r = await cl.invoke('cortex:control', { stopped: true, hard: !!hard });
  OUT();
  OUT('  ' + gold(bold('AGENTS OFF')));
  OUT(wrap(dim(hard
    ? 'Hard stop: the runner itself refuses every turn, so nothing reaches your Claude Code subscription — not this console, not Telegram, not a cron. This is the setting that guarantees zero spend.'
    : 'This console now drives nothing: no chat, no loops, no workflows, no auto-work. A message sent to an agent from somewhere else still runs. For zero spend everywhere, use: cortex off --hard'), undefined, '  '));
  if (hard && r && r.hardEffective === false) {
    OUT();
    OUT(wrap(rose('The hard stop is not in force: it needs the fleet bridge in the runner. Install it with: cortex bridge install'), undefined, '  '));
  }
  OUT();
}
async function agentsOn(cl) {
  await cl.invoke('cortex:control', { stopped: false, hard: false });
  OUT('  ' + green(bold('AGENTS ON')) + dim(' — the fleet answers again.'));
}

// ---------------------------------------------------------------------------
//  One-shot commands
// ---------------------------------------------------------------------------
const USAGE = `
  ${bold(violet('cortex'))} — the console, in a terminal

  ${bold('cortex')}                         open it and talk
  ${bold('cortex "what moved today?"')}     ask the fleet one thing
  ${bold('cortex @davaris "…"')}            ask one seat

  ${grey('looking')}   status  pulse  board  focus  agents  loops  mind  commands  protocols  live
  ${grey('moving')}    task "<title>"   done <id>   motus "<text>"   goal "<text>"   ask "<subject>"
  ${grey('control')}   off [--hard]   on   pause <seat>   resume <seat>
  ${grey('service')}   start  stop  restart  logs [-f]  doctor [--live]  setup  tree [<path>]  update
  ${grey('relay')}     relay status|start|stop|logs
  ${grey('raw')}       channels          every channel the console answers
              raw <channel> [json]   ask one directly

  ${dim('Everything here is also in the window build. Same engine, no screen.')}
`;

async function main() {
  const argv = process.argv.slice(2);
  const cmd = (argv[0] || '').toLowerCase();

  // things that do not need a running console
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') return OUT(USAGE);
  if (cmd === 'version' || cmd === '--version') {
    return OUT(JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version);
  }
  if (cmd === 'start') { await startService(); return; }
  if (cmd === 'stop') { await stopService(); return; }
  if (cmd === 'restart') { await stopService(); await new Promise((r) => setTimeout(r, 700)); await startService(); return; }
  if (cmd === 'logs') { await showLogs(argv.includes('-f') || argv.includes('--follow')); return; }
  if (cmd === 'rpc') { return require('./rpc').bridge(); }
  if (cmd === 'update') { await update(); return; }

  let cl;
  try { cl = await open(); }
  catch (e) {
    OUT();
    OUT(rose('  ' + e.message.split('\n')[0]));
    for (const l of e.message.split('\n').slice(1)) OUT(dim('  ' + l));
    OUT();
    process.exit(1);
  }

  const rest = argv.slice(1).join(' ').trim();
  try {
    switch (cmd) {
      case '': await repl(cl); return;                    // REPL keeps the process alive
      case 'status': await renderStatus(cl); break;
      case 'pulse': case 'reading': await renderPulse(cl); break;
      case 'board': await renderBoard(cl, rest || null); break;
      case 'focus': await renderFocus(cl); break;
      case 'agents': case 'fleet': await renderAgents(cl); break;
      case 'loops': await renderLoops(cl); break;
      case 'mind': case 'davara': await renderMind(cl); break;
      case 'commands': await renderMind(cl, 'commands'); break;
      case 'protocols': case 'abilities': await renderMind(cl, 'protocols'); break;
      case 'live': await live(cl); return;
      case 'off': await agentsOff(cl, argv.includes('--hard')); break;
      case 'on': await agentsOn(cl); break;
      case 'pause': { const r = await cl.invoke('cortex:pauseAgent', { agent: rest, paused: true }); OUT(r.ok ? green('  ' + rest + ' paused') : rose('  ' + r.error)); break; }
      case 'resume': { const r = await cl.invoke('cortex:pauseAgent', { agent: rest, paused: false }); OUT(r.ok ? green('  ' + rest + ' resumed') : rose('  ' + r.error)); break; }
      case 'task': { const r = await cl.invoke('cortex:taskCreate', { title: rest }); OUT(r && r.ok === false ? rose('  ' + r.error) : green('  on the board')); break; }
      case 'done': { await cl.invoke('cortex:taskUpdate', { id: rest, patch: { status: 'done' } }); OUT(green('  closed')); break; }
      case 'motus': case 'goal': {
        if (!rest) { await renderFocus(cl); break; }
        await cl.invoke('cortex:send', { agent: 'davara', kind: cmd, text: rest });
        OUT(green('  set'));
        break;
      }
      case 'ask': await sendTo(cl, 'davara', rest); break;
      case 'setup': await setup(cl); break;
      case 'tree': await tree(cl, rest); break;
      case 'doctor': await doctor(cl, argv.includes('--live')); break;
      case 'channels': (await cl.channels()).forEach((x) => OUT('  ' + x)); break;
      case 'raw': {
        const ch = argv[1];
        const args = argv[2] ? JSON.parse(argv.slice(2).join(' ')) : undefined;
        const r = await cl.invoke(ch, ...(args === undefined ? [] : [args]));
        OUT(JSON.stringify(r, null, 2));
        break;
      }
      case 'relay': await relay(argv[1] || 'status'); break;
      default:
        if (cmd.startsWith('@')) await sendTo(cl, cmd.slice(1), rest);
        else await sendTo(cl, 'davara', argv.join(' '));
    }
  } catch (e) {
    OUT(rose('  ' + (e && e.message)));
    if (e && e.channels) OUT(dim('  try: cortex channels'));
    process.exitCode = 1;
  }
  cl.close();
}

// --- setup: the passphrase, walked through ---------------------------------
function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const onData = (ch) => {
      if (['\n', '\r', ''].includes(String(ch))) { process.stdin.removeListener('data', onData); return; }
      readline.moveCursor(process.stdout, -100, 0);
      readline.clearLine(process.stdout, 1);
      process.stdout.write(question);
    };
    process.stdin.on('data', onData);
    rl.question(question, (a) => { rl.close(); process.stdout.write('\n'); resolve(a); });
  });
}

async function setup(cl) {
  const g = await cl.invoke('guard:status');
  if (!g.needsSetup) { OUT(green('  this vault already has a passphrase.')); return; }
  OUT();
  OUT(wrap('This machine is now the one this vault belongs to. Choose a passphrase of twelve characters or more; it is stored as a hash, never as text, and it is what the desktop app will ask for when it connects to this server.', undefined, '  '));
  OUT();
  const a = await askHidden('  passphrase: ');
  if (String(a).length < 12) { OUT(rose('  that is shorter than twelve characters. Nothing was saved.')); return; }
  const b = await askHidden('  again:      ');
  if (a !== b) { OUT(rose('  those did not match. Nothing was saved.')); return; }
  const r = await cl.invoke('auth:setup', a);
  OUT(r && r.ok ? green('\n  set. This vault is paired to ' + g.hostname + '.\n') : rose('\n  ' + ((r && r.reason) || 'it did not take') + '\n'));
}

async function tree(cl, p) {
  if (!p) {
    const s = await cl.invoke('cortex:settings');
    const ov = await cl.invoke('cortex:overview');
    kv('fleet tree', s.root + (ov.rootReadable ? '  ' + green('readable') : '  ' + rose('not readable')));
    OUT(dim('  point it somewhere else:  cortex tree /home/you/your-fleet'));
    return;
  }
  const r = await cl.invoke('cortex:saveSettings', { cortexRoot: p });
  OUT(r && r.error ? rose('  ' + r.error) : green('  fleet tree set to ' + p));
}

async function doctor(cl, live) {
  const [g, ov, ctl] = await Promise.all([cl.invoke('guard:status'), cl.invoke('cortex:overview'), cl.invoke('cortex:control')]);
  head('Doctor', 'what is true right now');
  const line = (ok, label, fix) => {
    OUT('  ' + (ok ? green('✓') : rose('✗')) + ' ' + label + (ok || !fix ? '' : dim('  → ' + fix)));
  };
  line(g.trusted, 'this machine is paired to the vault', 'delete the vault to re-pair');
  line(!g.needsSetup, 'a gate passphrase is set', 'cortex setup');
  line(ov.rootReadable, 'the fleet tree is readable', 'cortex tree <path>');
  line(!!ov.proxyStart, 'the relay is up on 127.0.0.1:8788', 'cortex relay start');
  line(ctl.bridgeInstalled, 'the fleet bridge is in the runner', 'cortex bridge install');
  line(!ctl.stopped, 'the agents are on', 'cortex on');
  // ⚠ THE CHECK THAT ANSWERS "why won't Remote connect". The desktop app reaches
  // this machine by running one command over SSH, and that command lands in a
  // non-interactive, non-login shell which reads neither file that puts
  // ~/.local/bin on the PATH. So ask the exact question the app asks, in the
  // exact kind of shell it asks in, and report what comes back. node matters
  // too: the cortex on the PATH is a two-line wrapper that runs node, so a node
  // installed by nvm is just as invisible as an unfindable cortex.
  const reach = await sh('sh', ['-lc',
    'command -v cortex >/dev/null 2>&1 && echo path || { [ -x "$HOME/.local/bin/cortex" ] && echo fallback || echo no; }']);
  const how = (reach.out || '').trim();
  line(how === 'path' || how === 'fallback', 'a remote login can find cortex',
    'sudo ln -s ~/.local/bin/cortex /usr/local/bin/cortex');
  if (how === 'fallback') OUT(dim('      (not on the PATH, but the app knows where to look)'));
  const nodeReach = await sh('sh', ['-lc', 'command -v node >/dev/null 2>&1 && echo yes || echo no']);
  line(/yes/.test(nodeReach.out || ''), 'a remote login can find node',
    'sudo ln -s "$(command -v node)" /usr/local/bin/node');

  // ⚠ THE WHOLE OF REMOTE, IN ONE LINE. The two checks above ask whether the
  // pieces can be found. This runs the real command in the real kind of shell
  // and waits for the bridge to announce itself, which is exactly what the
  // desktop app does. If this is green and the app still cannot connect, the
  // problem is between the two machines rather than on this one, and that is
  // worth knowing without another round trip.
  const bridge = await new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    const p = spawn('sh', ['-lc', BRIDGE_CMD], { stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { try { p.kill(); } catch {} finish({ ok: false, why: 'it did not answer in 15 seconds' }); }, 15000);
    p.stdout.on('data', (d) => {
      out += String(d);
      if (out.includes('"ready"')) { clearTimeout(timer); try { p.kill(); } catch {} finish({ ok: true }); }
    });
    let err = '';
    p.stderr.on('data', (d) => { err += String(d); });
    p.on('error', (e) => { clearTimeout(timer); finish({ ok: false, why: e.message }); });
    p.on('close', (code) => {
      clearTimeout(timer);
      finish({ ok: false, why: (err.trim().split('\n')[0] || ('it exited with code ' + code)) });
    });
    setTimeout(() => { try { p.stdin.write('{"id":1,"op":"hello"}\n'); } catch {} }, 250);
  });
  line(bridge.ok, 'the bridge the desktop app runs starts and answers', bridge.ok ? '' : 'cortex logs');
  if (!bridge.ok) OUT(wrap(dim(bridge.why || ''), undefined, '      '));

  // ⚠ The check nobody thinks of until the first reboot. Without lingering,
  // every user service stops the moment you log out, which on a server is most
  // of the time, and comes back for nobody.
  const linger = await sh('loginctl', ['show-user', String(process.env.USER || ''), '-p', 'Linger']);
  if (linger.ok) {
    line(/Linger=yes/.test(linger.out), 'it will come back after a reboot',
      'sudo loginctl enable-linger ' + (process.env.USER || '$USER'));
  }
  line(ov.stats.totalTurns > 0, 'turns have been read from the tree', 'check the tree path');

  // ⚠ SHAPE IS NOT FUNCTION. Everything above can be green on a machine that is
  // quietly signed out: the token file exists, the relay is listening, the
  // runner is in place, and every turn still dies with an auth error. The only
  // way to know is to run one. It is a few words to the leanest seat.
  if (live) {
    OUT('  ' + dim('· asking the fleet one short question…'));
    let said = '';
    try {
      const r = await cl.invoke('cortex:send', { agent: 'workhorse', text: 'Reply with exactly: READY' });
      said = String((r && r.text) || (r && r.error) || '');
    } catch (e) { said = String((e && e.message) || ''); }
    const signedOut = /signed out of claude code|failed to authenticate|oauth session expired/i.test(said);
    const answered = /ready/i.test(said);
    line(answered && !signedOut, 'a real turn came back from the fleet',
      signedOut ? 'claude setup-token, save it to ~/.claude/cortex-oauth-token, then: cortex relay restart' : 'cortex relay logs');
    if (!answered && said) OUT(wrap(dim(said.slice(0, 300)), undefined, '      '));
  } else {
    OUT('  ' + dim('  (add --live to spend one short turn proving the fleet actually answers)'));
  }
  OUT();
}

// A server updates by pulling, not by swapping a packaged build under a service
// manager that is trying to restart it. Every step is checked, and a pull that
// would throw away local edits stops rather than discarding them.
async function update() {
  OUT();
  const git = await sh('git', ['-C', APP_ROOT, 'rev-parse', '--abbrev-ref', 'HEAD']);
  if (!git.ok) { OUT(rose('  this copy is not a git clone, so there is nothing to pull')); return; }
  const branch = git.out.trim();
  const dirty = await sh('git', ['-C', APP_ROOT, 'status', '--porcelain']);
  if (dirty.out.trim()) {
    OUT(gold('  there are local changes here, so nothing was pulled:'));
    for (const l of dirty.out.trim().split('\n').slice(0, 10)) OUT(dim('    ' + l));
    OUT(dim('  commit or stash them, then run this again'));
    return;
  }
  const before = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version;
  OUT(dim('  pulling ' + branch + '…'));
  const pull = await sh('git', ['-C', APP_ROOT, 'pull', '--ff-only'], { timeout: 120000 });
  if (!pull.ok) { OUT(rose('  ' + (pull.err || 'the pull failed').trim())); return; }
  OUT(dim('  ' + pull.out.trim().split('\n').slice(-1)[0]));

  OUT(dim('  installing what changed…'));
  const npm = await sh('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--prefix', APP_ROOT], { timeout: 300000 });
  if (!npm.ok) { OUT(rose('  npm install failed; the old build is still running')); return; }

  // Never restart onto a build that does not parse. A server with nobody at it
  // would come back down and stay down.
  const check = await sh(process.execPath, ['--check', path.join(APP_ROOT, 'main.js')]);
  if (!check.ok) { OUT(rose('  the new main.js does not parse, so nothing was restarted')); return; }

  const after = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version;
  OUT(dim('  restarting…'));
  await stopService();
  await new Promise((r) => setTimeout(r, 700));
  await startService();
  OUT();
  OUT('  ' + green(before === after ? 'up to date on ' + after : before + ' → ' + after));
  OUT();
}

// ⚠ Which unit? This used to be hard-coded to the name the ORIGINAL machine
// happened to use, which is not the name the installer writes. The command then
// answered "Unit cortex-mouth-proxy.service not found" on a machine where the
// relay was installed and working, which is the least helpful thing it could
// have said. Ask systemd what is actually there, newest name first, and fall
// back to the older one so a machine set up before this still answers.
const RELAY_UNITS = ['cortex-relay.service', 'cortex-mouth-proxy.service'];
async function relayUnit() {
  for (const u of RELAY_UNITS) {
    const r = await sh('systemctl', ['--user', 'list-unit-files', u, '--no-legend']);
    if (r.ok && r.out.trim()) return u;
  }
  return null;
}

async function relay(action) {
  const unit = await relayUnit();

  if (action === 'status') {
    const h = await sh('curl', ['-s', '-m', '3', 'http://127.0.0.1:8788/health']);
    const answering = h.ok && /"status"/.test(h.out || '');
    if (unit) {
      const r = await sh('systemctl', ['--user', 'is-active', unit]);
      OUT('  unit:    ' + dim(unit));
      OUT('  service: ' + (r.out.trim() === 'active' ? green('active') : rose(r.out.trim() || 'unknown')));
    } else {
      OUT('  unit:    ' + gold('none installed'));
    }
    OUT('  health:  ' + (answering ? green(h.out.trim()) : rose('no answer on 127.0.0.1:8788')));
    // A relay can be up without a unit, and a unit can be active while the
    // relay is wedged. Say which of those is true rather than implying either.
    if (!unit && answering) OUT(dim('  something is serving the relay on this machine, but not as a service of yours'));
    if (!unit && !answering) OUT(dim('  install one by running the installer again:  bash linux/install.sh'));
    return;
  }

  if (!unit) {
    OUT(rose('  there is no relay service installed for this account.'));
    OUT(dim('  the installer writes one. Run it again and it will skip everything already done:'));
    OUT(dim('    bash linux/install.sh'));
    OUT(dim('  or start the relay by hand, in the foreground, to see what it says:'));
    OUT(dim('    CORTEX_ROOT=<your fleet tree> python3 <your fleet tree>/SystemsCortex/cortex-mouth.py'));
    process.exitCode = 1;
    return;
  }

  if (action === 'logs') {
    const p = spawn('journalctl', ['--user', '-u', unit, '-n', '60', '--no-pager'], { stdio: 'inherit' });
    await new Promise((r) => p.on('close', r));
    return;
  }

  const r = await sh('systemctl', ['--user', action, unit]);
  OUT(r.ok ? green('  relay ' + action + 'ed') + dim('  (' + unit + ')') : rose('  ' + r.err.trim()));
}

main().catch((e) => { OUT(rose(String((e && e.stack) || e))); process.exit(1); });
