#!/usr/bin/env node
// ============================================================================
//  remote-test.js — the Remote room, proved against a real SSH connection.
//
//      npm run remotetest        (needs a headless console already running)
//
//  WHY THIS EXISTS. Remote holds two sealed secrets, pins a host key, and is
//  the one surface that reaches across a network. "The library is mature" is
//  not a test of any of that. So this stands up a throwaway SSH server on
//  loopback, has it run the real `cortex rpc` bridge, and drives the REAL
//  remote.js through its own IPC handlers. Nothing is mocked except Electron.
//
//  It proves, in order:
//    · the secrets are sealed and never handed back
//    · an unknown host is REFUSED, and hands back a fingerprint to compare
//    · agreeing once connects, unlocks the far vault, and pins the key
//    · real channels answer from the far machine
//    · the off switch reaches across
//    · a string that is not a channel name never leaves this machine
//    · a host key that CHANGED refuses to continue, and says so
//
//  The server here is a fixture, not a product: it accepts one password and
//  runs one command. It never listens outside 127.0.0.1 and its host key is
//  generated fresh each run and thrown away.
// ============================================================================
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const APP = path.resolve(__dirname, '..');
const PORT = Number(process.env.CORTEX_TEST_SSH_PORT || 2222);
const USER = 'test-operator';
const SSH_PASS = 'fixture-ssh-password';
const VAULT_PASS = 'fixture-passphrase-12345';

let Server;
try { ({ Server } = require('ssh2')); }
catch { console.error('ssh2 is not installed; run npm install first'); process.exit(1); }

// --- a host key, made fresh and thrown away ---------------------------------
const KEYFILE = path.join(os.tmpdir(), 'ci-remote-test-hostkey');
for (const f of [KEYFILE, KEYFILE + '.pub']) { try { fs.unlinkSync(f); } catch { /* not there */ } }
try {
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', KEYFILE]);
} catch {
  console.error('ssh-keygen is not available, so this test cannot make a host key');
  process.exit(1);
}

const server = new Server({ hostKeys: [fs.readFileSync(KEYFILE)] }, (client) => {
  client.on('authentication', (ctx) => {
    if (ctx.method === 'password' && ctx.username === USER && ctx.password === SSH_PASS) return ctx.accept();
    if (ctx.method === 'none') return ctx.reject(['password']);
    return ctx.reject();
  });
  client.on('ready', () => {
    client.on('session', (accept) => {
      accept().on('exec', (acceptExec, rejectExec, info) => {
        if (!/cortex rpc/.test(info.command)) return rejectExec();
        const stream = acceptExec();
        const p = spawn(process.execPath, [path.join(APP, 'linux', 'cli.js'), 'rpc'], { stdio: ['pipe', 'pipe', 'ignore'] });
        stream.pipe(p.stdin);
        p.stdout.pipe(stream);
        p.on('close', (code) => { try { stream.exit(code || 0); stream.end(); } catch { /* gone */ } });
      });
    });
  });
  client.on('error', () => { /* a fixture never crashes the run */ });
});

// --- Electron, made of nothing ----------------------------------------------
const handlers = new Map();
const KEY = crypto.randomBytes(32);
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
    return Buffer.concat([iv, c.update(String(s), 'utf8'), c.final(), c.getAuthTag()]);
  },
  decryptString: (b) => {
    const iv = b.subarray(0, 12), tag = b.subarray(b.length - 16), ct = b.subarray(12, b.length - 16);
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  },
};
const STATE = {};
require(path.join(APP, 'remote.js'))({
  ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
  requireGate: (fn) => fn,          // the device lock is not what this proves
  getState: () => STATE,
  saveState: () => {},
  safeStorage,
  notify: () => {},
  push: () => {},
});
const call = (ch, arg) => handlers.get(ch)({}, arg);

let failed = 0;
const check = (name, ok, extra) => {
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${extra ? '  · ' + extra : ''}`);
};

(async () => {
  // the far console needs a passphrase before anything can unlock it
  const { open } = require(path.join(APP, 'linux', 'client.js'));
  let local;
  try { local = await open(); }
  catch (e) {
    console.error('\nthere is no console running to reach: ' + e.message.split('\n')[0]);
    console.error('start one first:  node linux/host.js &\n');
    process.exit(1);
  }
  const g = await local.invoke('guard:status');
  let phrase = process.env.CORTEX_TEST_PASSPHRASE || VAULT_PASS;
  if (g.needsSetup) {
    await local.invoke('auth:setup', VAULT_PASS);
    phrase = VAULT_PASS;
  } else if (!process.env.CORTEX_TEST_PASSPHRASE) {
    // Guessing the passphrase of a console that already has one would fail on
    // the third check and look like a broken feature. Say what is actually
    // needed instead.
    console.error('\nThe console this is pointed at already has a passphrase, and this test does not know it.');
    console.error('Either point it at a fresh vault, or tell it:');
    console.error('  CORTEX_TEST_PASSPHRASE=… npm run remotetest\n');
    local.close();
    process.exit(2);
  }
  local.close();

  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  console.log(`\nremote-test · a throwaway ssh server on 127.0.0.1:${PORT}\n`);

  await call('cortex:remoteSave', {
    host: '127.0.0.1', port: PORT, user: USER, auth: 'password',
    password: SSH_PASS, phrase,
  });

  const cfg = await call('cortex:remote');
  check('the secrets are sealed, and never handed back',
    cfg.hasPassword && cfg.hasPhrase && !('passEnc' in cfg) && !('password' in cfg));

  const first = await call('cortex:remoteConnect', {});
  check('an unknown host is refused until the operator agrees',
    first.unknownHost === true && /^SHA256:/.test(first.fingerprint || ''), first.fingerprint);

  const second = await call('cortex:remoteConnect', { acceptHostKey: true });
  check('agreeing connects over SSH and unlocks the far console',
    second.ok === true, second.ok ? 'v' + second.version + ' on ' + second.host : second.error);

  const pinned = await call('cortex:remote');
  check('the host key is pinned to what was agreed', pinned.hostKey === first.fingerprint);
  check('it reports itself connected', pinned.connected === true);

  const ov = await call('cortex:remoteInvoke', { channel: 'cortex:overview' });
  check('a real channel answers from the far machine',
    !!ov && !ov.error && ov.stats !== undefined, ov && ov.stats ? ov.stats.totalTurns + ' turns' : (ov && ov.error));

  const off = await call('cortex:remoteInvoke', { channel: 'cortex:control', args: [{ stopped: true, hard: false }] });
  check('the off switch reaches across', !!off && off.stopped === true);
  await call('cortex:remoteInvoke', { channel: 'cortex:control', args: [{ stopped: false, hard: false }] });

  const bad = await call('cortex:remoteInvoke', { channel: 'rm -rf /' });
  check('a string that is not a channel name never leaves this machine', !!bad.error, bad.error);

  // and the one that matters most: the key changed
  await call('cortex:remoteDisconnect');
  STATE.remote.hostKey = 'SHA256:' + 'A'.repeat(43);
  const mism = await call('cortex:remoteConnect', {});
  check('a host key that changed refuses to continue, and says why',
    mism.mismatch === true && !mism.ok, (mism.error || '').slice(0, 48) + '…');

  console.log('\n' + (failed ? `===== ${failed} PROBLEM(S) =====` : '===== CLEAN: the far console is reachable, and only on the terms it set ====='));
  server.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('\nremote-test threw:', (e && e.stack) || e);
  process.exit(1);
});
