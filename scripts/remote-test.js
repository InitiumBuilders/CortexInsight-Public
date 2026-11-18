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

let Server, utils;
try { ({ Server, utils } = require('ssh2')); }
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

// ⚠ THE FIXTURE HAS TO BE AS AWKWARD AS REALITY.
//
//  The first version of this spawned the bridge directly, which meant it proved
//  the protocol and nothing about whether the far end can FIND the bridge. On a
//  real server it could not: `ssh host <command>` gets a non-interactive,
//  non-login shell, and on Ubuntu that shell reads neither file that puts
//  ~/.local/bin on the PATH. The operator saw "read ECONNRESET" while looking
//  at a passphrase box, and this test had said everything was fine.
//
//  So the fixture now does what sshd does: it hands the command to a shell, in
//  a home directory laid out the way the installer lays one out, with a PATH
//  that does NOT already contain the install directory.
const FAKE_HOME = path.join(os.tmpdir(), 'ci-remote-test-home');
const FAKE_BIN = path.join(FAKE_HOME, '.local', 'bin');
fs.mkdirSync(FAKE_BIN, { recursive: true });
fs.writeFileSync(path.join(FAKE_BIN, 'cortex'),
  '#!/usr/bin/env bash\nexec ' + JSON.stringify(process.execPath) + ' ' + JSON.stringify(path.join(APP, 'linux', 'cli.js')) + ' "$@"\n',
  { mode: 0o755 });

// Ubuntu's own .profile, which is what a LOGIN shell reads and a plain
// `ssh host command` does not.
const PROFILE = path.join(FAKE_HOME, '.profile');
const writeProfile = () => fs.writeFileSync(PROFILE,
  'if [ -d "$HOME/.local/bin" ] ; then\n    PATH="$HOME/.local/bin:$PATH"\nfi\n');
writeProfile();

// a PATH with no trace of the install directory, so the only ways to succeed
// are the two the real command is written to try
const BARE_PATH = (process.env.PATH || '')
  .split(':')
  .filter((p) => p && !p.includes('.local/bin'))
  .join(':');

// A key, because plenty of servers refuse passwords outright and a key is then
// the only way in. Proving one path and recommending the other is not proof.
const USERKEY = path.join(os.tmpdir(), 'ci-remote-test-userkey');
for (const f of [USERKEY, USERKEY + '.pub']) { try { fs.unlinkSync(f); } catch { /* not there */ } }
execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', USERKEY]);
const ALLOWED = utils.parseKey(fs.readFileSync(USERKEY + '.pub'));
const ALLOWED_PUB = ALLOWED.getPublicSSH();

const server = new Server({ hostKeys: [fs.readFileSync(KEYFILE)] }, (client) => {
  client.on('authentication', (ctx) => {
    if (ctx.method === 'password' && ctx.username === USER && ctx.password === SSH_PASS) return ctx.accept();
    if (ctx.method === 'publickey' && ctx.username === USER) {
      const given = ctx.key.data;
      if (given.length !== ALLOWED_PUB.length || !crypto.timingSafeEqual(given, ALLOWED_PUB)) return ctx.reject();
      if (ctx.signature && !ALLOWED.verify(ctx.blob, ctx.signature, ctx.hashAlgo)) return ctx.reject();
      return ctx.accept();
    }
    if (ctx.method === 'none') return ctx.reject(['password', 'publickey']);
    return ctx.reject();
  });
  client.on('ready', () => {
    client.on('session', (accept) => {
      accept().on('exec', (acceptExec, rejectExec, info) => {
        if (!/cortex rpc/.test(info.command)) return rejectExec();
        const stream = acceptExec();
        // exactly what sshd does with the command it is given
        const p = spawn('sh', ['-c', info.command], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, HOME: FAKE_HOME, PATH: BARE_PATH },
        });
        stream.pipe(p.stdin);
        p.stdout.pipe(stream);
        p.stderr.on('data', (d) => { try { stream.stderr.write(d); } catch { /* gone */ } });
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

  // 3.68: the Remote screen paints the far fleet from one digest, and drives it
  // through the same channels the far console's own screens use.
  const dg = await call('cortex:remoteInvoke', { channel: 'cortex:fleetDigest' });
  check('the far fleet arrives in one digest',
    !!dg && !dg.error && Array.isArray(dg.agents) && !!dg.board && !!dg.duo && !!dg.gear, dg && dg.error ? dg.error : (dg ? dg.primary + ' first · ' + dg.agents.length + ' seat(s)' : ''));
  check('a server talks to the August seat first', !!dg && dg.primary === 'august', dg && dg.primary);
  const gear = await call('cortex:remoteInvoke', { channel: 'cortex:gearSet', args: [{ mode: 'motivus', ttlMin: 5 }] });
  check('the gear turns over there', !!gear && gear.ok === true && gear.gear.fleet.deep === true, gear && gear.error);
  await call('cortex:remoteInvoke', { channel: 'cortex:gearSet', args: [{ mode: 'cruise' }] });
  const tk = await call('cortex:remoteInvoke', { channel: 'cortex:taskCreate', args: [{ title: 'remote test: assigned from the desktop', agent: 'august', priority: 2 }] });
  check('a task can be assigned to a seat over there', !!tk && tk.ok === true && tk.task.agent === 'august', tk && tk.error);
  if (tk && tk.ok) await call('cortex:remoteInvoke', { channel: 'cortex:taskDelete', args: [{ id: tk.task.id }] });
  const duo = await call('cortex:remoteInvoke', { channel: 'cortex:duo', args: [{ wrapUp: true }] });
  check('Duo-Drive answers over there, wrap-up included', !!duo && !!duo.duo && typeof duo.said === 'string', duo && (duo.error || duo.said));

  const off = await call('cortex:remoteInvoke', { channel: 'cortex:control', args: [{ stopped: true, hard: false }] });
  check('the off switch reaches across', !!off && off.stopped === true);
  await call('cortex:remoteInvoke', { channel: 'cortex:control', args: [{ stopped: false, hard: false }] });

  const bad = await call('cortex:remoteInvoke', { channel: 'rm -rf /' });
  check('a string that is not a channel name never leaves this machine', !!bad.error, bad.error);

  // ⚠ The one this test used to miss entirely. With .profile in place a login
  // shell finds cortex on the PATH; with it gone, nothing does, and the command
  // has to reach for where the installer put it. Both have to work, because a
  // server may have either.
  await call('cortex:remoteDisconnect');
  fs.unlinkSync(PROFILE);
  const noProfile = await call('cortex:remoteConnect', {});
  check('it still finds cortex when nothing puts it on the PATH',
    noProfile.ok === true, noProfile.ok ? 'reached it anyway' : noProfile.error);
  writeProfile();

  // ⚠ The path a locked-down server forces you onto. `PermitRootLogin no` and
  // `PasswordAuthentication no` are ordinary hardening, and on a box with
  // either of them a password will never work however healthy the console is.
  await call('cortex:remoteDisconnect');
  await call('cortex:remoteSave', { auth: 'key', keyPath: USERKEY, password: null });
  const byKey = await call('cortex:remoteConnect', {});
  check('it connects with a key, not only a password',
    byKey.ok === true, byKey.ok ? 'v' + byKey.version : byKey.error);
  await call('cortex:remoteDisconnect');
  await call('cortex:remoteSave', { auth: 'password', password: SSH_PASS });

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
