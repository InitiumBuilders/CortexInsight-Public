// ============================================================================
//  seal.js — sealing secrets at rest on a machine with no keyring.
//
//  On Windows the app seals with DPAPI and on macOS with the Keychain, both of
//  which Electron reaches through safeStorage. A server has neither: libsecret
//  and kwallet want a desktop session, and there is nobody logged in to unlock
//  one. So this stands in its place, and it holds the same property that makes
//  DPAPI worth having:
//
//    A sealed vault carried to another machine is inert.
//
//  The key is derived from three facts, and all three have to agree:
//    · a 32-byte secret in a file only this user can read (0600, in a 0700 dir)
//    · the machine id this box wrote once at first boot
//    · the numeric id of the user the daemon runs as
//
//  Copy the vault alone and there is no key. Copy the vault AND the key file
//  and the machine id no longer matches, so it still will not open. That is
//  strictly more than DPAPI gives, which travels with the user profile.
//
//  AES-256-GCM, so a tampered ciphertext fails loudly instead of decrypting to
//  rubbish. The format carries its own version tag: if the derivation ever has
//  to change, an old blob is still recognisable rather than silently wrong.
// ============================================================================
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const MAGIC = Buffer.from('CIS1');      // CortexInsight Seal, version 1
const IV_LEN = 12;
const TAG_LEN = 16;

let _key = null;

// The machine's own name for itself. systemd writes /etc/machine-id once at
// first boot and never changes it; dbus keeps the same value as a fallback for
// boxes that predate it. A machine that has neither is not one we can bind to,
// and we say so rather than pretending.
function machineId() {
  for (const f of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try {
      const v = fs.readFileSync(f, 'utf8').trim();
      if (v) return v;
    } catch { /* next */ }
  }
  return '';
}

function keyFile(userDataDir) {
  return path.join(userDataDir, 'seal.key');
}

// Read the key file, or mint one. Written with 0600 inside a 0700 directory,
// and the permissions are re-checked on every read: a key file that became
// group- or world-readable is a key file that has to be treated as burnt.
function keyMaterial(userDataDir) {
  const f = keyFile(userDataDir);
  try {
    fs.mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
  } catch { /* already there */ }
  try {
    const st = fs.statSync(f);
    if (st.mode & 0o077) {
      throw new Error(`${f} is readable by other users (mode ${(st.mode & 0o777).toString(8)}). `
        + 'Run: chmod 600 ' + f);
    }
    const b = fs.readFileSync(f);
    if (b.length >= 32) return b;
  } catch (e) {
    if (e && /readable by other users/.test(e.message)) throw e;
  }
  const b = crypto.randomBytes(32);
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, b, { mode: 0o600 });
  fs.renameSync(tmp, f);
  return b;
}

function derive(userDataDir) {
  if (_key) return _key;
  const mid = machineId();
  if (!mid) throw new Error('this machine has no machine id, so a secret cannot be bound to it');
  const uid = typeof process.getuid === 'function' ? String(process.getuid()) : 'nouid';
  _key = Buffer.from(crypto.hkdfSync(
    'sha256',
    keyMaterial(userDataDir),
    Buffer.from(mid, 'utf8'),                       // salt: the machine
    Buffer.from('cortexinsight-seal-v1:' + uid),    // info: the user
    32,
  ));
  return _key;
}

// The three calls main.js actually makes, with Electron's own shapes:
// a Buffer out of encryptString, a Buffer into decryptString.
function makeSafeStorage(userDataDir) {
  return {
    isEncryptionAvailable() {
      try { derive(userDataDir); return true; } catch { return false; }
    },
    encryptString(plain) {
      const key = derive(userDataDir);
      const iv = crypto.randomBytes(IV_LEN);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
      return Buffer.concat([MAGIC, iv, c.getAuthTag(), ct]);
    },
    decryptString(buf) {
      const key = derive(userDataDir);
      const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
      if (b.length < MAGIC.length + IV_LEN + TAG_LEN || !b.subarray(0, MAGIC.length).equals(MAGIC)) {
        throw new Error('this secret was not sealed by this host');
      }
      const iv = b.subarray(MAGIC.length, MAGIC.length + IV_LEN);
      const tag = b.subarray(MAGIC.length + IV_LEN, MAGIC.length + IV_LEN + TAG_LEN);
      const ct = b.subarray(MAGIC.length + IV_LEN + TAG_LEN);
      const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
      d.setAuthTag(tag);
      return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
    },
  };
}

module.exports = { makeSafeStorage, machineId, keyFile };
