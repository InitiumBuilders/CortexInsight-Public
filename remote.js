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

  // ⚠ WHY THIS IS NOT JUST "cortex rpc".
  //
  //  `ssh host <command>` runs a NON-INTERACTIVE, NON-LOGIN shell. On Ubuntu
  //  that shell reads neither file that puts ~/.local/bin on the PATH: .profile
  //  is for login shells only, and .bashrc returns on its second line when the
  //  shell is not interactive. So the installer can put cortex on your PATH
  //  perfectly, you can run it all day in your own terminal, and it is still
  //  not found over SSH.
  //
  //  The symptom was worse than "not found": the channel closed, this end wrote
  //  its handshake into a dead pipe, and the operator was told "read ECONNRESET"
  //  while looking at a passphrase box. So: ask a LOGIN shell (which does read
  //  .profile), and if that still cannot find it, go straight to where the
  //  installer puts it.
  const REMOTE_CMD = 'sh -lc \'command -v cortex >/dev/null 2>&1 && exec cortex rpc; exec "$HOME/.local/bin/cortex" rpc\'';

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

  function sendLine(msg, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      if (!stream) return reject(new Error('not connected'));
      const id = ++seq;
      const timer = setTimeout(() => {
        if (waiting.has(id)) { waiting.delete(id); reject(new Error('the far end did not answer in time')); }
      }, timeoutMs);
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
        conn.exec(REMOTE_CMD, (err, st) => (err ? reject(new Error('could not start the console there: ' + err.message)) : resolve(st)));
      });

      // The bridge announces itself the moment it starts. Waiting for that line
      // is what turns "the pipe died while I was talking into it" into a
      // sentence about what actually went wrong.
      let exitCode = null;
      let stderrSaid = '';
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('the console there did not answer within 20 seconds')), 20000);
        const done = (e) => { clearTimeout(t); e ? reject(e) : resolve(); };
        const first = (d) => {
          if (String(d).includes('"ready"')) { stream.removeListener('data', first); done(); }
        };
        stream.on('data', first);
        stream.once('exit', (code) => { exitCode = code; });
        stream.once('close', () => {
          if (exitCode === 127 || /not found/i.test(stderrSaid)) {
            return done(new Error('cortex is installed but not on the PATH for a non-interactive login on that machine. '
              + 'Check with:  ssh ' + r.user + '@' + r.host + " 'command -v cortex'"));
          }
          done(new Error('the console there closed the connection'
            + (stderrSaid ? ': ' + stderrSaid.slice(0, 160) : '. Is it running? Try "cortex status" on that machine.')));
        });
        stream.stderr.on('data', (d) => { stderrSaid += String(d); });
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
    // ⚠ sshd answers the same way whether the secret was wrong or the ACCOUNT
    // does not exist, so "refused" sent him hunting through keys and passwords
    // while the real answer was a username that had never existed on the box.
    // The user is the one part of this the operator types from memory, so name
    // it, and name the file the key has to be in for that user.
    if (/All configured authentication methods failed/i.test(m)) {
      const r = S();
      return 'that machine refused the sign-in. Check the User first: it is set to "' + (r.user || '') + '", '
        + 'and the key has to be in /home/' + (r.user || '<user>') + '/.ssh/authorized_keys on that machine '
        + '(or /root/.ssh/authorized_keys if the account is root). sshd answers the same way for a wrong key '
        + 'and for an account that does not exist.';
    }
    if (/ECONNREFUSED/.test(m)) return 'nothing is listening for SSH on that host and port';
    if (/ENOTFOUND|EAI_AGAIN/.test(m)) return 'that hostname does not resolve';
    if (/ETIMEDOUT|timed out/i.test(m)) return 'the host did not answer before the timeout';
    // A bare errno on the one screen whose job is explaining is a failure of
    // that screen. ECONNRESET here almost always means the far end started and
    // then died, and the usual reason is cortex not being found.
    if (/ECONNRESET/.test(m)) return 'that machine accepted the connection and then dropped it. Usually the console there is not running, or cortex is not on the PATH for a non-interactive login';
    if (/EPIPE/.test(m)) return 'the console there stopped reading before this end finished speaking';
    if (/EHOSTUNREACH|ENETUNREACH/.test(m)) return 'there is no route to that host from here';
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

  // A real turn over there can run as long as the relay lets it (30 minutes).
  // Everything else is a read or a switch and should answer in seconds; waiting
  // two minutes on those is how a dead link looks alive.
  const LONG = new Set(['cortex:send', 'cortex:taskDispatch', 'cortex:duoPass', 'cortex:voiceTurn', 'cortex:critique']);
  ipcMain.handle('cortex:remoteInvoke', requireGate(async (_e, { channel, args } = {}) => {
    if (!ready) return { error: 'not connected to a remote console' };
    if (!channel || !/^[a-z]+:[A-Za-z]+$/.test(channel)) return { error: 'that is not a channel name' };
    try { return await sendLine({ op: 'invoke', channel, args: args || [] }, LONG.has(channel) ? 32 * 60000 : 120000); }
    catch (e) { return { error: e.message }; }
  }));

  ipcMain.handle('cortex:remoteWatch', requireGate(async () => {
    if (!ready) return { error: 'not connected' };
    try { return await sendLine({ op: 'subscribe', replay: 0 }); }
    catch (e) { return { error: e.message }; }
  }));

  return { isConnected: () => ready, disconnect: () => reset('shutting down') };
};
