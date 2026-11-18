// ============================================================================
//  rpc.js — the door the desktop app comes through.
//
//  `cortex rpc` is not meant to be typed. The Windows or macOS build runs it
//  over SSH and speaks JSON down the pipe, which is how one console drives
//  another across the internet without this machine ever opening a port.
//
//  TWO LOCKS, and they are different claims:
//    · SSH says you have an account on this box.
//    · the vault passphrase says you are the operator.
//  Holding an account is not the same as being the operator — a box can have
//  other users, a key can be borrowed, an agent can be left forwarding. So
//  nothing but `hello` moves until the passphrase lands, wrong tries slow down,
//  and enough of them end the session rather than politely waiting for more.
// ============================================================================
'use strict';

const { open } = require('./client');

const MAX_TRIES = 6;

function bridge() {
  let authed = false;
  let tries = 0;
  let client = null;
  let buf = '';

  const write = (o) => { try { process.stdout.write(JSON.stringify(o) + '\n'); } catch { /* the pipe closed */ } };

  const connect = async () => {
    if (client) return client;
    client = await open();
    client.onPush = (evt) => { if (authed) write({ push: evt }); };
    return client;
  };

  const handle = async (msg) => {
    const id = msg.id;

    if (msg.op === 'hello') {
      // Says what this is and whether a passphrase even exists yet, and nothing
      // about the fleet. Safe to answer before anyone has proved anything.
      try {
        const c = await connect();
        const h = await c.hello();
        const g = await c.invoke('guard:status');
        return write({ id, ok: true, result: { version: h.version, host: g.hostname, needsSetup: g.needsSetup, paired: g.trusted, authed } });
      } catch (e) {
        return write({ id, ok: false, error: e.message });
      }
    }

    if (msg.op === 'auth') {
      if (tries >= MAX_TRIES) { write({ id, ok: false, error: 'too many attempts' }); return process.exit(1); }
      try {
        const c = await connect();
        const r = await c.invoke('auth:unlock', String(msg.passphrase || ''));
        if (r && r.ok) { authed = true; tries = 0; return write({ id, ok: true, result: { authed: true } }); }
        tries++;
        // A wrong passphrase and a machine that is not paired look identical
        // from out here, on purpose: a stranger learns nothing from the answer.
        await new Promise((res) => setTimeout(res, 400 * tries));
        write({ id, ok: false, error: 'that did not open it', result: { authed: false, left: MAX_TRIES - tries } });
        if (tries >= MAX_TRIES) { write({ closing: 'too many attempts' }); process.exit(1); }
        return;
      } catch (e) {
        return write({ id, ok: false, error: e.message });
      }
    }

    if (!authed) return write({ id, ok: false, error: 'locked — send the vault passphrase first' });

    try {
      const c = await connect();
      if (msg.op === 'invoke') return write({ id, ok: true, result: await c.invoke(msg.channel, ...(msg.args || [])) });
      if (msg.op === 'channels') return write({ id, ok: true, result: await c.channels() });
      if (msg.op === 'subscribe') return write({ id, ok: true, result: await c.subscribe(msg.replay || 0) });
      return write({ id, ok: false, error: 'unknown op: ' + msg.op });
    } catch (e) {
      return write({ id, ok: false, error: e.message });
    }
  };

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { write({ ok: false, error: 'that was not JSON' }); continue; }
      handle(msg);
    }
  });
  process.stdin.on('end', () => process.exit(0));

  // Announce so the caller knows the pipe is alive before it sends anything.
  write({ ready: true, rpc: 1 });
}

module.exports = { bridge };
