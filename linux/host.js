// ============================================================================
//  host.js — the console as a service.
//
//  Boots main.js with the Electron shim standing in for the parts of a desktop
//  a server does not have, then puts every IPC channel main.js registered onto
//  a Unix socket so the terminal (and, over SSH, the desktop app) can reach it.
//
//  THE SOCKET IS THE WHOLE ATTACK SURFACE, so it is deliberately small:
//    · a Unix domain socket, never a TCP port. Nothing is listening on the
//      network, so nothing on the network can knock. Remote access rides SSH,
//      which already has an opinion about who you are.
//    · mode 0600 in a 0700 directory. On a Unix box those permissions ARE the
//      authentication for a local caller, and a caller who can read the socket
//      could read the vault anyway.
//    · a request is JSON on one line, and one line can only ask for a channel
//      that main.js itself registered. There is no "run this" op, no path
//      argument, no eval.
//    · the remote bridge (cortex rpc) adds the vault passphrase on top, because
//      an SSH account and the operator are not the same claim.
// ============================================================================
'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const Module = require('module');

// ---------------------------------------------------------------------------
//  1. Stand the shim in front of Electron, before main.js can ask for it.
// ---------------------------------------------------------------------------
process.env.CORTEX_HEADLESS = '1';
const shim = require('./electron-shim');
const host = shim.__host;

const _load = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return shim;
  return _load.apply(this, arguments);
};

// ---------------------------------------------------------------------------
//  2. Where the socket lives.
// ---------------------------------------------------------------------------
function socketDir() {
  const rt = process.env.XDG_RUNTIME_DIR;
  if (rt) { try { fs.accessSync(rt, fs.constants.W_OK); return path.join(rt, 'cortexinsight'); } catch { /* fall through */ } }
  return path.join(host.userData, 'run');
}
const SOCK = process.env.CORTEX_SOCKET || path.join(socketDir(), 'control.sock');

function log(...a) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(ts, ...a);
}

// ---------------------------------------------------------------------------
//  3. Boot the engine room.
// ---------------------------------------------------------------------------
log('CortexInsight ' + host.version + ' — starting headless');
log('vault   ' + host.userData);
log('socket  ' + SOCK);

require(path.join(host.appRoot, 'main.js'));
host.markReady();

// ---------------------------------------------------------------------------
//  4. Serve.
// ---------------------------------------------------------------------------
const subscribers = new Set();
const recent = [];                       // a small replay buffer for a late listener
host.bus.on('push', (evt) => {
  recent.push({ ts: Date.now(), ...evt });
  if (recent.length > 300) recent.shift();
  for (const s of subscribers) { try { s(evt); } catch { /* a dead socket */ } }
});

// A caller can only ever reach a channel main.js registered. Anything else is
// answered with the list, not with a guess.
async function invoke(channel, args) {
  const fn = host.handlers.get(channel);
  if (!fn) {
    const e = new Error('no such channel: ' + channel);
    e.channels = [...host.handlers.keys()].sort();
    throw e;
  }
  const win = host.windows.find((w) => !w._destroyed) || null;
  const event = { sender: win ? win.webContents : null, frameId: 0, processId: process.pid };
  return await fn(event, ...(Array.isArray(args) ? args : []));
}

function serve(conn) {
  conn.setEncoding('utf8');
  let buf = '';
  const write = (o) => { try { conn.write(JSON.stringify(o) + '\n'); } catch { /* gone */ } };
  const onPush = (evt) => write({ push: evt });

  conn.on('data', async (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); }
      catch { write({ ok: false, error: 'that was not JSON' }); continue; }
      const id = msg.id;
      try {
        switch (msg.op) {
          case 'hello':
            write({ id, ok: true, result: { version: host.version, pid: process.pid, vault: host.userData, channels: host.handlers.size } });
            break;
          case 'channels':
            write({ id, ok: true, result: [...host.handlers.keys()].sort() });
            break;
          case 'invoke':
            write({ id, ok: true, result: await invoke(msg.channel, msg.args) });
            break;
          case 'subscribe':
            subscribers.add(onPush);
            if (msg.replay) for (const r of recent.slice(-Number(msg.replay))) write({ push: r });
            write({ id, ok: true, result: { subscribed: true } });
            break;
          case 'unsubscribe':
            subscribers.delete(onPush);
            write({ id, ok: true, result: { subscribed: false } });
            break;
          case 'notifications':
            write({ id, ok: true, result: host.notifications.slice(-Number(msg.limit || 20)) });
            break;
          case 'shutdown':
            write({ id, ok: true, result: { stopping: true } });
            setTimeout(() => stop(0), 120);
            break;
          default:
            write({ id, ok: false, error: 'unknown op: ' + msg.op });
        }
      } catch (e) {
        write({ id, ok: false, error: (e && e.message) || String(e), channels: e && e.channels });
      }
    }
  });

  const bye = () => subscribers.delete(onPush);
  conn.on('close', bye);
  conn.on('error', bye);
}

function listen() {
  const dir = path.dirname(SOCK);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* not ours to change */ }
  // A socket left behind by a killed daemon would block the bind. It is only
  // safe to clear once the single-instance lock has already said we are alone.
  try { if (fs.statSync(SOCK)) fs.unlinkSync(SOCK); } catch { /* nothing there */ }

  const server = net.createServer(serve);
  server.on('error', (e) => { log('socket error:', e.message); process.exit(1); });
  server.listen(SOCK, () => {
    try { fs.chmodSync(SOCK, 0o600); } catch { /* best effort */ }
    log('ready — ' + host.handlers.size + ' channels on the socket');
    log('talk to it with:  cortex');
    if (process.send) process.send('ready');
  });
  return server;
}

let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  log('stopping — saving the vault');
  try { shim.app.isQuitting = true; shim.app.emit('before-quit'); shim.app.emit('will-quit'); } catch { /* already down */ }
  try { fs.unlinkSync(SOCK); } catch { /* already gone */ }
  setTimeout(() => process.exit(code || 0), 250);
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
process.on('uncaughtException', (e) => log('uncaught:', (e && e.stack) || e));
process.on('unhandledRejection', (e) => log('unhandled:', (e && e.message) || e));

// Do not open the socket until the engine room has actually finished booting.
// main.js registers the window-control channels as the last thing it does, so
// their arrival is the honest signal that the first read of the tree, the device
// check and the vault load are all behind us. A caller that connects earlier
// would get answers from a half-built state, which is worse than waiting.
const BOOT_DEADLINE = Date.now() + 30000;
(function waitForBoot() {
  if (host.handlers.has("win:close") || Date.now() > BOOT_DEADLINE) {
    if (!host.handlers.has("win:close")) log("warning: the engine room did not finish booting in 30s; serving anyway");
    return listen();
  }
  setTimeout(waitForBoot, 40);
})();
