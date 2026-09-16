// ============================================================================
//  remote.js — driving a CortexInsight that runs somewhere else.
//
//  The console on a server has no window. This is how the console on a desktop
//  reaches it: an SSH connection, `cortex rpc` at the far end, and JSON on the
//  pipe between them. The remote machine never opens a port for this. Nothing
//  new is exposed to the internet; we borrow the door that is already there.
//
//  WHAT HAS TO BE TRUE BEFORE ANYTHING MOVES:
//
//  ① The machine is who it says it is.
//     The first connection records the server's host key and shows you its
//     fingerprint. Every connection after that checks it. If it ever changes,
//     this refuses to continue and says so plainly, because a host key that
//     changed without you changing it is the one symptom of someone standing
//     in the middle.
//
//  ② You are who you say you are — twice.
//     SSH proves you have an account on that box. The vault passphrase proves
//     you are the operator of the console running on it. They are different
//     claims: an account can be shared, a key can be borrowed, an agent can be
//     left forwarding. Both are required.
//
//  ③ Nothing readable is kept.
//     The SSH password and the remote passphrase are sealed with the OS
//     keystore, exactly like every other secret here, and the renderer is never
//     given them back. What it gets is a boolean saying one is stored.
// ============================================================================
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

let Client = null;
try { ({ Client } = require('ssh2')); } catch { /* reported at connect time */ }

module.exports = function attachRemote(ctx) {
  const { ipcMain, requireGate, getState, saveState, safeStorage, notify, push } = ctx;

  // --- state ---------------------------------------------------------------
  const S = () => {
    const st = getState();
    if (!st.remote) {
      st.remote = {
        host: '', port: 22, user: '',
        auth: 'password',          // 'password' | 'key'
        keyPath: '',
        passEnc: '',               // sealed SSH password
        phraseEnc: '',             // sealed vault passphrase of the REMOTE console
        hostKey: '',               // sha256 fingerprint we have agreed to
        lastConnected: '',
        lastError: '',
      };
    }
    return st.remote;
  };

  const seal = (s) => {
    if (!s) return '';
    if (!safeStorage.isEncryptionAvailable()) throw new Error('this machine cannot seal secrets at rest, so it will not store one in plain text');
    return safeStorage.encryptString(String(s)).toString('base64');
  };
  const unseal = (enc) => {
    if (!enc) return '';
    try { return safeStorage.decryptString(Buffer.from(enc, 'base64')); } catch { return ''; }
  };

  const fingerprintOf = (key) => 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');

  // --- the live connection -------------------------------------------------
  let conn = null;
  let stream = null;
  let ready = false;
  let seq = 0;
  const waiting = new Map();
  let buf = '';
  let connecting = null;
  // ⚠ Every connection carries a number, and its handlers check that number
  // before touching anything shared. Without it, a 'close' arriving late from a
  // connection that was already replaced would run the teardown against the
  // LIVE one: connect, disconnect, connect again, and the second connection
  // dies a second later for no visible reason. The events are asynchronous and
  // arrive whenever the socket feels like it, so identity has to be explicit.
  let generation = 0;

  function reset(why) {
    ready = false;
    for (const [, w] of waiting) w({ ok: false, error: why || 'the connection closed' });
    waiting.clear();
    try { if (stream) stream.end(); } catch { /* already gone */ }
    try { if (conn) conn.end(); } catch { /* already gone */ }
    stream = null; conn = null; buf = '';
  }

  function sendLine(msg) {
    return new Promise((resolve, reject) => {
      if (!stream) return reject(new Error('not connected'));
      const id = ++seq;
      const timer = setTimeout(() => {
        if (waiting.has(id)) { waiting.delete(id); reject(new Error('the far end did not answer in time')); }
      }, 120000);
      waiting.set(id, (m) => { clearTimeout(timer); m.ok ? resolve(m.result) : reject(new Error(m.error || 'refused')); });
      stream.write(JSON.stringify({ id, ...msg }) + '\n');
    });
  }

  function onData(chunk) {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (m.push) { push('cortex:remoteEvent', m.push); continue; }
      if (m.closing) { reset(m.closing); continue; }
      const w = waiting.get(m.id);
      if (w) { waiting.delete(m.id); w(m); }
    }
  }

  // Connect, prove the host, start the bridge, unlock the far vault.
  function connect({ acceptHostKey } = {}) {
    if (connecting) return connecting;
    const r = S();
    const gen = ++generation;
    const mine = () => gen === generation;
    connecting = (async () => {
      if (!Client) throw new Error('the SSH client is not installed in this build');
      if (!r.host || !r.user) throw new Error('give it a host and a user first');
      reset();

      const password = unseal(r.passEnc);
      const phrase = unseal(r.phraseEnc);
      if (r.auth === 'password' && !password) throw new Error('no SSH password is stored for this host');
      if (!phrase) throw new Error('no passphrase is stored for the console on that machine');

      // ⚠ Decide WHY at the verifier, not afterwards. The first cut inferred the
      // reason in the catch by comparing fingerprints, which meant it depended on
      // whether ssh2 emitted 'error' or 'close' first and on the verifier having
      // run at all. A rejected host key then surfaced as "the connection closed
      // before it opened" — correct behaviour, useless explanation, on the one
      // screen whose entire job is to explain. The verifier knows the answer at
      // the moment it refuses, so it records it there.
      let offered = '';
      let verdict = '';         // '' | 'unknown' | 'mismatch'
      await new Promise((resolve, reject) => {
        const c = new Client();
        conn = c;
        c.on('ready', resolve);
        c.on('error', (e) => { if (mine()) reject(new Error(friendly(e))); });
        c.on('close', () => {
          if (!mine()) return;                   // a ghost of a replaced connection
          if (!ready) reject(new Error('the connection closed before it opened'));
          else reset('the connection closed');
        });
        const cfg = {
          host: r.host,
          port: Number(r.port) || 22,
          username: r.user,
          readyTimeout: 20000,
          keepaliveInterval: 20000,
          // ① the machine is who it says it is
          hostVerifier: (key) => {
            offered = fingerprintOf(key);
            if (!r.hostKey) {                            // first time: only with the operator's yes
              if (acceptHostKey) return true;
              verdict = 'unknown';
              return false;
            }
            if (offered === r.hostKey) return true;
            verdict = 'mismatch';
            return false;
          },
        };
        if (r.auth === 'key') {
          const kp = r.keyPath || path.join(os.homedir(), '.ssh', 'id_ed25519');
          try { cfg.privateKey = fs.readFileSync(kp); }
          catch { return reject(new Error('could not read the key at ' + kp)); }
          if (password) cfg.passphrase = password;        // the key's own passphrase
        } else {
          cfg.password = password;
          // Some servers offer keyboard-interactive instead of plain password.
          cfg.tryKeyboard = true;
          c.on('keyboard-interactive', (n, i, il, prompts, cb) => cb(prompts.map(() => password)));
        }
        c.connect(cfg);
      }).catch((e) => {
        reset();
        if (verdict === 'unknown') {
          const err = new Error('unknown-host');
          err.fingerprint = offered;
          throw err;
        }
        if (verdict === 'mismatch') {
          const err = new Error('THE HOST KEY CHANGED. This machine is not presenting the key it presented before. '
            + 'Do not enter your passphrase until you know why. If you rebuilt the server, clear the stored key and connect again.');
          err.fingerprint = offered;
          err.mismatch = true;
          throw err;
        }
        throw e;
      });

      if (!r.hostKey && offered) { r.hostKey = offered; saveState(); }

      // ② start the bridge at the far end
      stream = await new Promise((resolve, reject) => {
        conn.exec('cortex rpc', (err, st) => (err ? reject(new Error('could not start the console there: ' + err.message)) : resolve(st)));
      });
      if (!mine()) { reset(); throw new Error('a newer connection replaced this one'); }
      stream.on('data', (d) => { if (mine()) onData(d); });
      stream.stderr.on('data', (d) => {
        const s = String(d).trim();
        // A shell that cannot find cortex is the most common first failure, and
        // it looks like nothing at all without this.
        if (mine() && /command not found|not found/i.test(s)) reset('cortex is not on the PATH for that account there');
      });
      stream.on('close', () => { if (mine()) reset('the console there closed the connection'); });

      const hello = await sendLine({ op: 'hello' });
      if (hello.needsSetup) throw new Error('the console on that machine has no passphrase yet. Run "cortex setup" there first.');

      // ③ prove you are the operator of that console
      await sendLine({ op: 'auth', passphrase: phrase });

      ready = true;
      r.lastConnected = new Date().toISOString();
      r.lastError = '';
      saveState();
      notify('info', 'Remote console connected', `${r.user}@${r.host} · ${hello.host || ''} · v${hello.version || '?'}`, 'remote');
      return { ok: true, host: hello.host, version: hello.version, fingerprint: r.hostKey };
    })().catch((e) => {
      const r2 = S();
      r2.lastError = e.message === 'unknown-host' ? '' : e.message;
      saveState();
      reset();
      throw e;
    }).finally(() => { connecting = null; });
    return connecting;
  }

  function friendly(e) {
    const m = String((e && e.message) || e);
    if (/All configured authentication methods failed/i.test(m)) return 'the password or key was refused by that machine';
    if (/ECONNREFUSED/.test(m)) return 'nothing is listening for SSH on that host and port';
    if (/ENOTFOUND|EAI_AGAIN/.test(m)) return 'that hostname does not resolve';
    if (/ETIMEDOUT|timed out/i.test(m)) return 'the host did not answer before the timeout';
    return m;
  }

  // --- the channels --------------------------------------------------------
  ipcMain.handle('cortex:remote', requireGate(() => {
    const r = S();
    return {
      host: r.host, port: r.port, user: r.user, auth: r.auth, keyPath: r.keyPath,
      hasPassword: !!r.passEnc, hasPhrase: !!r.phraseEnc,
      hostKey: r.hostKey, lastConnected: r.lastConnected, lastError: r.lastError,
      connected: ready, available: !!Client,
    };
  }));

  ipcMain.handle('cortex:remoteSave', requireGate((_e, p = {}) => {
    const r = S();
    if (p.host !== undefined) r.host = String(p.host).trim();
    if (p.port !== undefined) r.port = Number(p.port) || 22;
    if (p.user !== undefined) r.user = String(p.user).trim();
    if (p.auth !== undefined) r.auth = p.auth === 'key' ? 'key' : 'password';
    if (p.keyPath !== undefined) r.keyPath = String(p.keyPath).trim();
    // A blank means "leave what is stored"; an explicit null means "forget it".
    if (p.password) r.passEnc = seal(p.password);
    if (p.password === null) r.passEnc = '';
    if (p.phrase) r.phraseEnc = seal(p.phrase);
    if (p.phrase === null) r.phraseEnc = '';
    if (p.forgetHostKey) r.hostKey = '';
    saveState();
    return { ok: true };
  }));

  ipcMain.handle('cortex:remoteConnect', requireGate(async (_e, p = {}) => {
    try {
      return await connect({ acceptHostKey: !!p.acceptHostKey });
    } catch (e) {
      if (e.message === 'unknown-host') return { ok: false, unknownHost: true, fingerprint: e.fingerprint };
      if (e.mismatch) return { ok: false, mismatch: true, fingerprint: e.fingerprint, error: e.message };
      return { ok: false, error: e.message };
    }
  }));

  ipcMain.handle('cortex:remoteDisconnect', requireGate(() => { reset('disconnected'); return { ok: true }; }));

  ipcMain.handle('cortex:remoteInvoke', requireGate(async (_e, { channel, args } = {}) => {
    if (!ready) return { error: 'not connected to a remote console' };
    if (!channel || !/^[a-z]+:[A-Za-z]+$/.test(channel)) return { error: 'that is not a channel name' };
    try { return await sendLine({ op: 'invoke', channel, args: args || [] }); }
    catch (e) { return { error: e.message }; }
  }));

  ipcMain.handle('cortex:remoteWatch', requireGate(async () => {
    if (!ready) return { error: 'not connected' };
    try { return await sendLine({ op: 'subscribe', replay: 0 }); }
    catch (e) { return { error: e.message }; }
  }));

  return { isConnected: () => ready, disconnect: () => reset('shutting down') };
};
